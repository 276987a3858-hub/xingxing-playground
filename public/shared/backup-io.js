/* public/shared/backup-io.js — 跨设备迁移 v2：有副作用的那一半
 * 职责：从真实 IndexedDB / localStorage 采集 → 组装 v2 文件 → 下载 → 回读校验；
 *       导入时先给目标机做快照，再按阶段提交，带恢复日志与可重入恢复。
 * 边界：不碰 API Key，不清理电脑数据，不合并二进制，不做任何自动删库。
 * 依赖：backup-format.js（纯函数层，必须与本文件同目录加载在前）。
 *
 * 挂载：window.BackupIO
 */
(function (root) {
  'use strict';

  function BF() {
    var b = root.BackupFormat;
    if (!b) throw new Error('backup-format.js 未加载，无法进行备份/导入');
    return b;
  }

  // 四个库的真实结构（与 app.js / butler-db.js / radio-voice.js / voice-store.js 保持一致）
  var DEFAULT_DBS = {
    room: { name: 'star_fifi_room', version: 3, store: 'kv' },
    butler: { name: 'star_butler_v1', version: 2, store: 'meta' },
    radio: { name: 'ylxh_radio_voice', version: 1, store: 'clips' },
    chat: { name: 'ylxh_chat_voice', version: 1, store: 'clips' },
  };
  var DBS = JSON.parse(JSON.stringify(DEFAULT_DBS));

  var JOURNAL_KEY = 'ylxh.migrate.journal.v1';
  var COMMIT_KEY = 'backup:commit';
  // 声音素材库没有 kv 表，标记只能作为一条记录存在；没有 blob 的记录会被素材库自己的
  // normalize() 过滤掉，不会出现在用户的素材列表里，采集时也会剔除。
  var RADIO_MARKER_ID = '__backup_commit__';
  var STORAGE_TAG = 'ylxhStorage'; // 备份文件里 audioData 等仍按 dataURL 原样存，不做二次包装

  /* ---------------- 库连接 ---------------- */

  function roomUpgrade(db) {
    if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    if (!db.objectStoreNames.contains('messages')) db.createObjectStore('messages', { keyPath: 'id', autoIncrement: true });
    if (!db.objectStoreNames.contains('diaries')) db.createObjectStore('diaries', { keyPath: 'id', autoIncrement: true });
    if (!db.objectStoreNames.contains('starDiaries')) db.createObjectStore('starDiaries', { keyPath: 'id', autoIncrement: true });
    if (!db.objectStoreNames.contains('keeps')) db.createObjectStore('keeps', { keyPath: 'id', autoIncrement: true });
    if (!db.objectStoreNames.contains('futureLetters')) db.createObjectStore('futureLetters', { keyPath: 'id', autoIncrement: true });
  }

  function butlerUpgrade(db) {
    if (!db.objectStoreNames.contains('tasks')) {
      var t = db.createObjectStore('tasks', { keyPath: 'id' });
      t.createIndex('by_date', 'date');
      t.createIndex('by_status', 'status');
    }
    if (!db.objectStoreNames.contains('sleepLogs')) {
      db.createObjectStore('sleepLogs', { keyPath: 'id' }).createIndex('by_date', 'date');
    }
    if (!db.objectStoreNames.contains('cycles')) {
      db.createObjectStore('cycles', { keyPath: 'id' }).createIndex('by_start', 'startDate');
    }
    if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    if (!db.objectStoreNames.contains('transactions')) {
      db.createObjectStore('transactions', { keyPath: 'id' }).createIndex('by_date', 'date');
    }
  }

  function radioUpgrade(db) {
    if (!db.objectStoreNames.contains('clips')) db.createObjectStore('clips', { keyPath: 'id' });
  }

  function openDB(which) {
    var cfg = DBS[which];
    var upgrade = which === 'room' ? roomUpgrade : which === 'butler' ? butlerUpgrade : radioUpgrade;
    return new Promise(function (res, rej) {
      var req;
      try {
        req = indexedDB.open(cfg.name, cfg.version);
      } catch (e) {
        return rej(e);
      }
      req.onupgradeneeded = function () {
        try { upgrade(req.result); } catch (e) { console.error('建表失败', cfg.name, e); }
      };
      req.onsuccess = function () {
        var db = req.result;
        db.onversionchange = function () { try { db.close(); } catch (e) { } };
        res(db);
      };
      req.onerror = function () { rej(req.error || new Error('打开数据库失败：' + cfg.name)); };
      req.onblocked = function () { rej(new Error('数据库被其他标签页占用，请关闭其他标签页后重试：' + cfg.name)); };
    });
  }

  function readAll(db, store) {
    return new Promise(function (res, rej) {
      var t = db.transaction(store, 'readonly');
      var r = t.objectStore(store).getAll();
      r.onsuccess = function () { res(r.result || []); };
      r.onerror = function () { rej(r.error || new Error('读取失败：' + store)); };
    });
  }

  function readKey(db, store, key) {
    return new Promise(function (res, rej) {
      var t = db.transaction(store, 'readonly');
      var r = t.objectStore(store).get(key);
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error || new Error('读取失败：' + store + '/' + key)); };
    });
  }

  function countStore(db, store) {
    return new Promise(function (res, rej) {
      var t = db.transaction(store, 'readonly');
      var r = t.objectStore(store).count();
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error || new Error('计数失败：' + store)); };
    });
  }

  function closeQuiet(db) { try { if (db) db.close(); } catch (e) { } }

  /* ---------------- 采集 ---------------- */

  function blobToBytes(blob) {
    if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer().then(function (b) { return new Uint8Array(b); });
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(new Uint8Array(fr.result)); };
      fr.onerror = function () { rej(fr.error || new Error('读取 Blob 失败')); };
      fr.readAsArrayBuffer(blob);
    });
  }

  /**
   * 读一个「素材/录音」库并把 Blob 打包成可入 JSON 的形式。
   * 声音素材库与聊天语音库结构一致（都是 clips），只是分区不同，这里共用一份逻辑。
   */
  async function collectClips(which, target, detail, problems, packVoice) {
    var F = BF();
    var db = await openDB(which);
    try {
      var rows = await readAll(db, DBS[which].store);
      rows = rows.filter(function (c) { return !c || (c.id !== RADIO_MARKER_ID && c.kind !== 'migration-marker'); });
      for (var k = 0; k < rows.length; k++) {
        var c = rows[k];
        if (!c || !c.id) continue;
        var rec = {};
        Object.keys(c).forEach(function (key) { if (key !== 'blob') rec[key] = c[key]; });
        if (!(typeof Blob !== 'undefined' && c.blob instanceof Blob)) {
          problems.push('音频「' + (c.name || c.id) + '」没有可读的音频数据');
          detail.push({ id: c.id, name: c.name, size: 0, broken: true });
          continue;
        }
        if (packVoice) {
          var bytes = await blobToBytes(c.blob);
          rec.blob = await F.encodeBinary(bytes, c.blob.type || c.mime || 'application/octet-stream');
          // 记录里的 size 必须与真实字节一致，不一致说明历史数据已不一致，如实上报
          if (typeof rec.size === 'number' && rec.size !== bytes.length) {
            problems.push('音频「' + (c.name || c.id) + '」声明 ' + rec.size + ' 字节，实际 ' + bytes.length + ' 字节');
          }
          rec.size = bytes.length;
        } else {
          rec.blob = c.blob;
        }
        detail.push({ id: c.id, name: c.name, size: c.blob.size, mime: c.blob.type || c.mime || '' });
        target.push(rec);
      }
    } finally {
      closeQuiet(db);
    }
  }

  /**
   * 读出本机全部可迁移数据。
   * opts.packVoice=false 时保留原始 Blob（给导入计划做目标侧读取用）。
   * 返回 { sections, counts, clipsDetail, problems }；problems 非空必须阻断导出。
   */
  async function collect(opts) {
    var options = opts || {};
    var packVoice = options.packVoice !== false;
    var F = BF();
    var sections = {
      room: { kv: {}, messages: [], keeps: [], diaries: [], starDiaries: [], futureLetters: [] },
      butler: { tasks: [], transactions: [], cycles: [], sleepLogs: [], meta: [] },
      localStorage: {},
      radioVoice: { clips: [] },
      chatVoice: { clips: [] },
    };
    var problems = [];
    var warnings = [];
    var clipsDetail = [];
    var chatClipsDetail = [];

    var roomDb = await openDB('room');
    try {
      var roomStores = F.ROOM_STORES;
      for (var i = 0; i < roomStores.length; i++) {
        sections.room[roomStores[i]] = await readAll(roomDb, roomStores[i]);
      }
      var st = await readKey(roomDb, DBS.room.store, 'settings');
      if (st && typeof st === 'object') sections.room.kv.settings = st;
      var mem = await readKey(roomDb, DBS.room.store, 'longTermMemory');
      if (typeof mem === 'string') sections.room.kv.longTermMemory = mem;
      // 长期记忆 v2：baseline / entries / source / history 全量导出；旧键仍单独保留。
      var mem2 = await readKey(roomDb, DBS.room.store, F.LTM_V2_KEY);
      if (F.isLtmV2(mem2)) sections.room.kv[F.LTM_V2_KEY] = mem2;
      else if (mem2 != null) warnings.push('长期记忆 v2 结构不合法，本次未写入备份；旧记忆原文仍完整导出');
      // 机自述：独立键，records / history / source / status 一起导出，不合法就不进备份。
      var sn = await readKey(roomDb, DBS.room.store, F.SELF_NARRATIVE_KEY);
      if (F.isSelfNarrative(sn)) sections.room.kv[F.SELF_NARRATIVE_KEY] = sn;
      else if (sn != null) warnings.push('机自述结构不合法，本次未写入备份；现有记录未被改动');
    } finally {
      closeQuiet(roomDb);
    }

    var butlerDb = await openDB('butler');
    try {
      for (var j = 0; j < F.BUTLER_STORES.length; j++) {
        var rows = await readAll(butlerDb, F.BUTLER_STORES[j]);
        // 导入提交标记存在 meta 里，它不是业务数据，不能跟着备份走
        if (F.BUTLER_STORES[j] === 'meta') {
          rows = rows.filter(function (r) { return !r || r.key !== COMMIT_KEY; });
        }
        sections.butler[F.BUTLER_STORES[j]] = rows;
      }
    } finally {
      closeQuiet(butlerDb);
    }

    var radioDb = await openDB('radio');
    try {
      var clips = await readAll(radioDb, DBS.radio.store);
      clips = clips.filter(function (c) { return !c || (c.id !== RADIO_MARKER_ID && c.kind !== 'migration-marker'); });
      for (var k = 0; k < clips.length; k++) {
        var c = clips[k];
        var rec = {};
        Object.keys(c).forEach(function (key) { if (key !== 'blob') rec[key] = c[key]; });
        if (!(typeof Blob !== 'undefined' && c.blob instanceof Blob)) {
          problems.push('声音素材「' + (c.name || c.id) + '」没有可读的音频数据');
          clipsDetail.push({ id: c.id, name: c.name, size: 0, broken: true });
          continue;
        }
        if (packVoice) {
          var bytes = await blobToBytes(c.blob);
          rec.blob = await F.encodeBinary(bytes, c.blob.type || c.mime || 'application/octet-stream');
          // 记录里的 size 必须与真实字节一致，不一致说明历史数据已不一致，如实上报
          if (typeof rec.size === 'number' && rec.size !== bytes.length) {
            problems.push('声音素材「' + (c.name || c.id) + '」声明 ' + rec.size + ' 字节，实际 ' + bytes.length + ' 字节');
          }
          rec.size = bytes.length;
        } else {
          rec.blob = c.blob;
        }
        clipsDetail.push({ id: c.id, name: c.name, size: c.blob.size, mime: c.blob.type || c.mime || '' });
        sections.radioVoice.clips.push(rec);
      }
    } finally {
      closeQuiet(radioDb);
    }

    // 聊天语音：消息里只有 audioClipId，原始录音必须一起走，否则导入后就是「有记录没声音」
    await collectClips('chat', sections.chatVoice.clips, chatClipsDetail, problems, packVoice);

    // localStorage 只取白名单
    var ls = {};
    var excluded = [];
    try {
      for (var n = 0; n < F.LS_ALLOW.length; n++) {
        var key = F.LS_ALLOW[n];
        var val = root.localStorage.getItem(key);
        if (val !== null) ls[key] = val;
      }
      Object.keys(F.LS_EXCLUDED).forEach(function (key) {
        if (root.localStorage.getItem(key) !== null) excluded.push(key);
      });
    } catch (e) {
      problems.push('读取本地状态失败：' + e.message);
    }
    sections.localStorage = ls;

    return {
      sections: sections,
      counts: F.countsOf(sections),
      clipsDetail: clipsDetail,
      chatClipsDetail: chatClipsDetail,
      excluded: excluded,
      problems: problems,
      warnings: warnings,
    };
  }

  /* ---------------- 组装文件 ---------------- */

  async function buildFile(sections, meta) {
    var F = BF();
    var m = meta || {};
    var file = {
      format: F.FORMAT,
      version: F.VERSION,
      minApp: F.MIN_APP,
      exportedAt: Date.now(),
      origin: (root.location && root.location.origin) || '',
      device: m.device || '',
      profile: { label: m.label || '', packVoice: true, storageTag: STORAGE_TAG },
      counts: F.countsOf(sections),
      star_fifi_room: {
        kv: sections.room.kv,
        messages: sections.room.messages,
        keeps: sections.room.keeps,
        diaries: sections.room.diaries,
        starDiaries: sections.room.starDiaries,
        futureLetters: sections.room.futureLetters,
      },
      star_butler_v1: {
        tasks: sections.butler.tasks,
        transactions: sections.butler.transactions,
        cycles: sections.butler.cycles,
        sleepLogs: sections.butler.sleepLogs,
        meta: sections.butler.meta,
      },
      radio_voice: { clips: sections.radioVoice.clips },
      chat_voice: { clips: sections.chatVoice.clips },
      localStorage: sections.localStorage,
    };
    file.integrity = await F.buildIntegrity(file);
    return file;
  }

  function toBlob(file) {
    return new Blob([JSON.stringify(file)], { type: 'application/json' });
  }

  function fileName(prefix, label) {
    var d = new Date();
    var p = function (n) { return ('0' + n).slice(-2); };
    var stamp = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
    return prefix + (label ? '-' + label : '') + '-' + stamp + '.json';
  }

  function download(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    return name;
  }

  /**
   * 完整导出：采集 → 组装 → 下载 → 回读同一份字节再校验。
   * 任何附件缺失/异常、超出硬上限都在这里中止，不会产出「少了几个附件」的备份。
   */
  async function exportAll(opts) {
    var options = opts || {};
    var F = BF();
    var prog = options.onProgress || function () { };
    prog({ stage: 'collect', message: '读取本机数据…' });
    var col = await collect({ packVoice: true });
    if (col.problems.length) {
      return { ok: false, reason: 'collect-problems', problems: col.problems, counts: col.counts };
    }
    prog({ stage: 'report', message: '核对附件…' });
    var report = F.attachmentReport(col.sections);
    var budget = F.checkAttachmentBudget(report);
    if (!budget.ok) {
      return { ok: false, reason: budget.reason, detail: budget.detail, report: report };
    }
    prog({ stage: 'build', message: '生成备份文件…' });
    var file = await buildFile(col.sections, { device: options.device, label: options.label });
    var blob = toBlob(file);
    prog({ stage: 'verify', message: '回读校验…' });
    var text = await blob.text();
    var check = await verifyText(text);
    if (!check.ok) return { ok: false, reason: 'self-check-failed', detail: check };
    var name = fileName('ylxh-backup', options.label);
    if (options.download !== false) download(blob, name);
    return {
      ok: true,
      file: file,
      blob: blob,
      text: text,
      name: name,
      size: blob.size,
      sha256: check.sha256,
      counts: file.counts,
      report: report,
      warn: budget.warn,
      notes: col.warnings || [],
      clipsDetail: col.clipsDetail,
      excluded: col.excluded,
    };
  }

  /** 回读校验：解析 + integrity + 附件解码/哈希 + 数量/字节一致。任何一项失败都返回 ok:false。 */
  async function verifyText(text) {
    var F = BF();
    var file;
    try {
      file = JSON.parse(text);
    } catch (e) {
      return { ok: false, reason: 'json-parse-failed', message: e.message };
    }
    var v = await F.verifyIntegrity(file);
    if (!v.ok) return { ok: false, reason: v.reason, detail: v.detail };
    var norm = F.normalizeBackup(file);
    var att = F.attachmentReport(norm.sections);
    if (att.invalid.length) return { ok: false, reason: 'attachment-invalid', detail: { at: att.invalid } };
    if (att.missing.length) return { ok: false, reason: 'attachment-missing', detail: { at: att.missing } };
    if (att.unpacked.length) return { ok: false, reason: 'attachment-not-packed', detail: { at: att.unpacked } };
    if (att.totalCount !== v.integrity.attachmentCount) {
      return { ok: false, reason: 'attachment-count-mismatch', detail: { expect: v.integrity.attachmentCount, actual: att.totalCount } };
    }
    if (att.totalBytes !== v.integrity.attachmentBytes) {
      return { ok: false, reason: 'attachment-bytes-mismatch', detail: { expect: v.integrity.attachmentBytes, actual: att.totalBytes } };
    }
    var sha = await F.sha256Hex(text);
    return {
      ok: true,
      file: file,
      normalized: norm,
      integrity: v.integrity,
      report: att,
      sha256: sha,
      size: typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(text).length : text.length,
    };
  }

  /* ---------------- 目标侧统计与计划 ---------------- */

  async function targetSections() {
    var col = await collect({ packVoice: false });
    return col;
  }

  async function planFor(file, mode, opts) {
    var F = BF();
    var options = opts || {};
    var norm = options.normalized || F.normalizeBackup(file);
    var target = options.target || (await targetSections());
    var hasLocal = {};
    try {
      Object.keys(norm.sections.localStorage).forEach(function (k) {
        hasLocal[k] = root.localStorage.getItem(k) !== null;
      });
    } catch (e) { }
    var plan = F.buildPlan({ mode: mode, target: target.sections, backup: norm.sections, targetLocalHas: hasLocal });
    var hash = await F.planHashOf(plan);
    return {
      plan: plan,
      planHash: hash,
      summary: F.summarize(plan),
      targetCounts: target.counts,
      targetProblems: target.problems,
      backupCounts: file.counts || F.countsOf(norm.sections),
      gaps: F.describeGaps(norm),
      warnings: norm.warnings || [],
      mode: mode,
    };
  }

  /**
   * 写入前最后一次硬校验：
   * 1) 附件逐个解码 + 字节哈希；2) 计划哈希未变；3) 备份数量与文件内声明一致。
   * 任何不符立即 throw，调用方必须中止，不允许「跳过坏的继续写」。
   */
  async function preflight(file, planInfo, opts) {
    var F = BF();
    var options = opts || {};
    var prog = options.onProgress || function () { };
    var norm = F.normalizeBackup(file);
    var att = F.attachmentReport(norm.sections);
    if (att.invalid.length) throw new Error('附件格式异常，已中止：' + att.invalid.join('、'));
    if (att.missing.length) throw new Error('附件缺失，已中止：' + att.missing.join('、'));
    if (att.unpacked.length) throw new Error('附件未打包，已中止：' + att.unpacked.join('、'));

    // 声音素材：逐条真正解码 + 比哈希
    var clips = norm.sections.radioVoice.clips.concat(norm.sections.chatVoice.clips);
    for (var i = 0; i < clips.length; i++) {
      var c = clips[i];
      if (!c.blob) throw new Error('音频缺少数据：' + (c.name || c.id));
      var r = await F.verifyAttachment(c.blob);
      if (!r.ok) throw new Error('音频校验失败（' + (c.name || c.id) + '）：' + r.reason);
      prog({ stage: 'preflight', done: i + 1, total: clips.length, message: '校验音频' });
    }

    // 聊天图片 / 语音 / 各类照片：真解码，比长度
    var items = att.items.filter(function (it) { return it.kind !== 'voice-clip'; });
    for (var j = 0; j < items.length; j++) {
      var it = items[j];
      var raw = valueAt(norm.sections, it.at);
      var info = F.dataUrlInfo(raw);
      if (!info || info.external || info.invalid) throw new Error('附件无法解码，已中止：' + it.at);
      if (info.base64 !== false) {
        try {
          var bytes = F.base64ToBytes(String(raw).slice(String(raw).indexOf(',') + 1));
          if (bytes.length !== it.bytes) throw new Error('长度不符');
        } catch (e) {
          throw new Error('附件解码失败，已中止：' + it.at + '（' + e.message + '）');
        }
      }
      if ((j + 1) % 25 === 0) prog({ stage: 'preflight', done: j + 1, total: items.length, message: '校验图片/语音' });
    }

    // 计划哈希必须还是预览时那一份
    var fresh = await planFor(file, planInfo.mode, { normalized: norm, target: options.target || (await targetSections()) });
    if (fresh.planHash !== planInfo.planHash) {
      throw new Error('本机数据在预览后发生变化，计划已失效，请重新预览再导入');
    }
    return { normalized: norm, report: att, plan: fresh.plan, planHash: fresh.planHash };
  }

  // 'messages/12/audio' → 值；只用于校验，不做写入
  function valueAt(sections, at) {
    var p = String(at).split('/');
    if (p[0] === 'messages') {
      var m = (sections.room.messages || []).find(function (x) { return String(x.id) === p[1]; });
      if (!m) return null;
      return p[2] === 'image' ? m.image : m.audioData;
    }
    if (p[0] === 'kv') return sections.room.kv.settings && sections.room.kv.settings.wallpaper;
    if (p[0] === 'radio_voice') return null;
    var list = sections.room[p[0]] || [];
    var rec = list.find(function (x) { return String(x.id) === p[1]; });
    return rec ? rec.photo : null;
  }

  /* ---------------- 恢复日志 ---------------- */

  function readJournal() {
    try {
      var raw = root.localStorage.getItem(JOURNAL_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function writeJournal(j) {
    try { root.localStorage.setItem(JOURNAL_KEY, JSON.stringify(j)); } catch (e) { console.error('写恢复日志失败', e); }
    return j;
  }

  function clearJournal() {
    try { root.localStorage.removeItem(JOURNAL_KEY); } catch (e) { }
  }

  function newJournal(file, planHash, mode) {
    return {
      v: 1,
      id: 'mig-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
      startedAt: Date.now(),
      updatedAt: Date.now(),
      mode: mode,
      planHash: planHash,
      backupHash: (file.integrity && file.integrity.payloadHash) || '',
      backupExportedAt: file.exportedAt || 0,
      stages: {},
      written: {},
      done: false,
    };
  }

  /** 库内提交标记才是权威：journal 没来得及写也能判断这一阶段到底提交没有。 */
  async function readMarker(which) {
    var db = await openDB(which);
    try {
      var store = DBS[which].store;
      if (which === 'radio' || which === 'chat') {
        var row = await readKey(db, store, RADIO_MARKER_ID);
        return row && row.kind === 'migration-marker' ? row : null;
      }
      var rec = await readKey(db, store, COMMIT_KEY);
      if (which === 'butler') return rec ? rec.value : null;
      return rec || null;
    } catch (e) {
      return null;
    } finally {
      closeQuiet(db);
    }
  }

  async function writeMarker(which, marker) {
    var db = await openDB(which);
    try {
      var store = DBS[which].store;
      var payload = Object.assign({ kind: 'migration-marker' }, marker);
      await new Promise(function (res, rej) {
        var t = db.transaction(store, 'readwrite');
        if (which === 'radio' || which === 'chat') t.objectStore(store).put(Object.assign({ id: RADIO_MARKER_ID }, payload));
        else if (which === 'butler') t.objectStore(store).put({ key: COMMIT_KEY, value: marker, updatedAt: Date.now() });
        else t.objectStore(store).put(marker, COMMIT_KEY);
        t.oncomplete = function () { res(); };
        t.onerror = function () { rej(t.error || new Error('写入提交标记失败')); };
        t.onabort = function () { rej(t.error || new Error('写入提交标记被中止')); };
      });
    } finally {
      closeQuiet(db);
    }
  }

  async function clearMarker(which) {
    var db = await openDB(which);
    try {
      var store = DBS[which].store;
      await new Promise(function (res, rej) {
        var t = db.transaction(store, 'readwrite');
        if (which === 'radio' || which === 'chat') t.objectStore(store).delete(RADIO_MARKER_ID);
        else t.objectStore(store).delete(COMMIT_KEY);
        t.oncomplete = function () { res(); };
        t.onerror = function () { rej(t.error || new Error('清除提交标记失败')); };
      });
    } catch (e) { } finally { closeQuiet(db); }
  }

  /* ---------------- 阶段写入 ---------------- */

  function txRun(db, stores, fn) {
    return new Promise(function (res, rej) {
      var t;
      try { t = db.transaction(stores, 'readwrite'); } catch (e) { return rej(e); }
      var out;
      try { out = fn(t); } catch (e) { try { t.abort(); } catch (_) { } return rej(e); }
      t.oncomplete = function () { res(out); };
      t.onerror = function () { rej(t.error || new Error('事务失败')); };
      t.onabort = function () { rej(t.error || new Error('事务被中止')); };
    });
  }

  function applyRoomPlan(db, plan, marker) {
    var stores = BF().ROOM_STORES.concat([DBS.room.store]);
    return txRun(db, stores, function (t) {
      var written = {};
      stores.forEach(function (s) {
        if (s === DBS.room.store) return;
        var p = plan.room[s] || {};
        var os = t.objectStore(s);
        if (p.clear) os.clear();
        var ids = [];
        (p.inserts || []).forEach(function (r) { os.put(r); ids.push(r.id); });
        (p.upserts || []).forEach(function (r) { os.put(r); ids.push(r.id); });
        written[s] = ids;
      });
      var kv = t.objectStore(DBS.room.store);
      if (plan.kvSet && plan.kvSet.settings) kv.put(plan.kvSet.settings, 'settings');
      if (typeof plan.kvSet.longTermMemory === 'string') kv.put(plan.kvSet.longTermMemory, 'longTermMemory');
      // v2 与旧键同事务写入：两者要么一起生效，要么一起回滚，不会出现"只有新记忆"的中间态。
      if (BF().isLtmV2(plan.kvSet[BF().LTM_V2_KEY])) {
        kv.put(plan.kvSet[BF().LTM_V2_KEY], BF().LTM_V2_KEY);
      }
      // 机自述与上面两个键同事务：结构不合法就一个字节都不写。
      if (BF().isSelfNarrative(plan.kvSet[BF().SELF_NARRATIVE_KEY])) {
        kv.put(plan.kvSet[BF().SELF_NARRATIVE_KEY], BF().SELF_NARRATIVE_KEY);
      }
      kv.put(marker, COMMIT_KEY);
      return written;
    });
  }

  function applyButlerPlan(db, plan, marker) {
    var stores = BF().BUTLER_STORES;
    return txRun(db, stores, function (t) {
      var written = {};
      stores.forEach(function (s) {
        var p = plan.butler[s] || {};
        var os = t.objectStore(s);
        if (p.clear) os.clear();
        var ids = [];
        (p.inserts || []).forEach(function (r) { os.put(r); ids.push(r.id == null ? r.key : r.id); });
        (p.upserts || []).forEach(function (r) { os.put(r); ids.push(r.id == null ? r.key : r.id); });
        written[s] = ids;
      });
      t.objectStore(DBS.butler.store).put({ key: COMMIT_KEY, value: marker, updatedAt: Date.now() });
      return written;
    });
  }

  /**
   * 写入一个 clips 库（声音素材 / 聊天语音共用）。
   * part 是 plan.radioVoice 或 plan.chatVoice，结构与合并规则完全一致。
   */
  async function applyClipsPlan(db, part, which, marker, onProgress, onWritten, progressLabel) {
    var F = BF();
    var storeName = DBS[which].store;
    var written = [];
    var inserts = (part && part.inserts) || [];
    var upserts = (part && part.upserts) || [];
    var all = inserts.concat(upserts);
    if (part && part.clear) {
      await txRun(db, [storeName], function (t) { t.objectStore(storeName).clear(); });
    }
    for (var i = 0; i < all.length; i++) {
      var rec = all[i];
      if (!rec.blob) throw new Error('音频缺少数据：' + (rec.name || rec.id));
      // 一条一个事务：单条录音可能几 MB，避免长事务把整批卡死
      var dec = F.decodeBinary(rec.blob);
      if (rec.blob.sha256) {
        var h = await F.sha256Bytes(dec.bytes);
        if (h !== rec.blob.sha256) throw new Error('音频哈希不符，已中止：' + (rec.name || rec.id));
      }
      var out = Object.assign({}, rec, { blob: new Blob([dec.bytes], { type: dec.mime }), size: dec.bytes.length });
      await txRun(db, [storeName], function (t) { t.objectStore(storeName).put(out); });
      written.push(rec.id);
      // 每写入一条就登记，中断后撤销/续传都知道写到哪了
      if (onWritten) onWritten(written.slice());
      if (onProgress) onProgress({ stage: which, done: i + 1, total: all.length, message: progressLabel || '写入音频' });
    }
    await txRun(db, [storeName], function (t) {
      t.objectStore(storeName).put(Object.assign({ id: RADIO_MARKER_ID, kind: 'migration-marker' }, marker));
    });
    return { clips: written };
  }

  function applyLocalPlan(plan) {
    var set = (plan.localStorage && plan.localStorage.set) || {};
    var wrote = [], failed = [];
    Object.keys(set).forEach(function (k) {
      try {
        root.localStorage.setItem(k, String(set[k]));
        wrote.push(k);
      } catch (e) {
        failed.push({ key: k, message: e.message });
      }
    });
    if (failed.length) {
      var err = new Error('本地状态写入失败（可能是存储空间不足）：' + failed.map(function (f) { return f.key; }).join('、'));
      err.failed = failed;
      throw err;
    }
    return { keys: wrote };
  }

  /* ---------------- 导入主流程 ---------------- */

  // 顺序有讲究：语音录音先落库，再写消息。反过来一旦录音阶段失败，
  // 消息里就会留下指向不存在音频的引用（有记录、点开没声音）。
  function stageList() { return ['chat', 'room', 'radio', 'butler', 'local']; }

  /**
   * 分阶段提交：room → radio → butler → localStorage。
   * 每阶段：写数据 + 写库内提交标记（同事务）→ 校验数量 → 更新 journal。
   * 任一阶段失败即停，journal 保留，可用 resume() 从失败阶段继续。
   */
  async function applyPlan(input) {
    var F = BF();
    var file = input.file;
    var planInfo = input.planInfo;
    var mode = input.mode || planInfo.mode || 'merge';
    var onProgress = input.onProgress || function () { };
    var journal = input.journal || newJournal(file, planInfo.planHash, mode);
    var marker = {
      v: 2,
      app: 'ylxh-backup',
      stage: '',
      planHash: planInfo.planHash,
      backupHash: journal.backupHash,
      at: 0,
    };
    var order = stageList();
    var result = { stages: [], written: {}, errors: [], resumed: !!input.journal };
    var targetBefore = input.targetBefore || (await targetSections());

    // 日志必须在任何写入之前落盘：否则第一阶段提交后崩溃就没有可续传的记录
    journal.status = 'running';
    journal.updatedAt = Date.now();
    // 记下哪些本地状态键在导入前就存在：撤销时不能删掉本来就在的东西
    journal.localExisted = journal.localExisted || {};
    Object.keys((planInfo.plan.localStorage && planInfo.plan.localStorage.set) || {}).forEach(function (k) {
      if (!Object.prototype.hasOwnProperty.call(journal.localExisted, k)) {
        journal.localExisted[k] = root.localStorage.getItem(k) !== null;
      }
    });
    // 记录 kv 写入前的原值，撤销时可精确恢复（含 longTermMemory / longTermMemory.v2 / selfNarrative.v1）。
    journal.kvBefore = journal.kvBefore || {};
    var kvTargetBefore = (targetBefore.sections.room && targetBefore.sections.room.kv) || {};
    Object.keys(planInfo.plan.kvSet || {}).forEach(function (k) {
      if (!Object.prototype.hasOwnProperty.call(journal.kvBefore, k)) {
        journal.kvBefore[k] = Object.prototype.hasOwnProperty.call(kvTargetBefore, k)
          ? { present: true, value: kvTargetBefore[k] }
          : { present: false };
      }
    });
    writeJournal(journal);

    for (var i = 0; i < order.length; i++) {
      var stage = order[i];
      onProgress({ stage: stage, phase: 'start', message: '准备阶段：' + stage });

      // 跳过条件（两条都要是「确实已提交」而不是「大概写过」）：
      // 1) 本次运行的日志说这一阶段完成了；2) 库内标记与当前计划哈希完全一致。
      // 计划变了（例如手机在上次导入后又多了冲突记录）就必须重跑，否则会假装导入成功却什么都没写。
      var fastDone = journal.stages[stage] && journal.stages[stage].status === 'done';
      var byMarker = false;
      if (stage !== 'local') {
        var which = stage === 'room' ? 'room' : (stage === 'radio' || stage === 'chat') ? stage : 'butler';
        var mk = await readMarker(which);
        byMarker = !!(mk && mk.stage === stage && mk.planHash && mk.planHash === planInfo.planHash);
      }
      if (fastDone || byMarker) {
        journal.stages[stage] = { status: 'done', at: Date.now(), viaMarker: byMarker };
        journal.updatedAt = Date.now();
        writeJournal(journal);
        result.stages.push({ stage: stage, status: 'skipped-committed' });
        onProgress({ stage: stage, phase: 'done', message: '该阶段此前已提交，跳过' });
        continue;
      }

      marker.stage = stage;
      marker.at = Date.now();
      marker.planHash = planInfo.planHash;

      try {
        var written = null;
        if (stage === 'room') {
          var roomDb = await openDB('room');
          try {
            written = await applyRoomPlan(roomDb, planInfo.plan, marker);
            await verifyCounts(roomDb, 'room', planInfo.plan.room, targetBefore.sections.room, written);
          } finally { closeQuiet(roomDb); }
        } else if (stage === 'radio' || stage === 'chat') {
          var clipsDb = await openDB(stage);
          try {
            var part = stage === 'radio' ? planInfo.plan.radioVoice : planInfo.plan.chatVoice;
            var beforeClips = stage === 'radio' ? targetBefore.sections.radioVoice.clips : targetBefore.sections.chatVoice.clips;
            written = await applyClipsPlan(clipsDb, part, stage, marker, onProgress, function (ids) {
              journal.written[stage] = { clips: ids };
              journal.updatedAt = Date.now();
              writeJournal(journal);
            }, stage === 'radio' ? '写入声音素材' : '写入语音录音');
            await verifyCounts(clipsDb, stage, { clips: part }, { clips: beforeClips }, { clips: written.clips });
          } finally { closeQuiet(clipsDb); }
        } else if (stage === 'butler') {
          var butlerDb = await openDB('butler');
          try {
            written = await applyButlerPlan(butlerDb, planInfo.plan, marker);
            await verifyCounts(butlerDb, 'butler', planInfo.plan.butler, targetBefore.sections.butler, written);
          } finally { closeQuiet(butlerDb); }
        } else {
          written = applyLocalPlan(planInfo.plan);
        }

        journal.stages[stage] = { status: 'done', at: Date.now() };
        journal.written[stage] = mergeWritten(journal.written[stage], written);
        journal.updatedAt = Date.now();
        writeJournal(journal);
        result.stages.push({ stage: stage, status: 'done', written: summarizeWritten(written) });
        onProgress({ stage: stage, phase: 'done', message: '阶段完成：' + stage });

        // 演练/测试用：在「数据与提交标记已落库、日志还没写」的窗口停下，
        // 用来验证重入恢复不会重复插入。正常导入不会传这个参数。
        if (input.pauseAfterStage === stage) {
          result.ok = false;
          result.paused = true;
          result.pausedAt = stage;
          result.journal = journal;
          return result;
        }
      } catch (e) {
        journal.stages[stage] = { status: 'failed', at: Date.now(), error: e && e.message ? e.message : String(e) };
        journal.updatedAt = Date.now();
        writeJournal(journal);
        result.errors.push({ stage: stage, message: e && e.message ? e.message : String(e) });
        result.stages.push({ stage: stage, status: 'failed', message: e && e.message });
        onProgress({ stage: stage, phase: 'failed', message: '阶段失败：' + (e && e.message) });
        result.ok = false;
        result.journal = journal;
        return result;
      }
    }

    journal.done = true;
    journal.updatedAt = Date.now();
    writeJournal(journal);
    result.ok = true;
    result.journal = journal;
    return result;
  }

  function summarizeWritten(w) {
    if (!w) return null;
    if (w.keys) return { keys: w.keys.length };
    if (w.clips) return { clips: w.clips.length };
    var n = 0;
    Object.keys(w).forEach(function (k) { n += (w[k] || []).length; });
    return { records: n };
  }

  /**
   * 中断恢复会让同一阶段重跑（哪怕这次一条都没写），日志里的 id 必须累加而不是覆盖，
   * 否则「撤销本次导入」会漏删第一次写进去的记录。
   */
  function mergeWritten(prev, next) {
    if (!prev) return next;
    if (!next) return prev;
    if (next.clips || prev.clips) {
      var a = (prev.clips || []).concat(next.clips || []);
      return { clips: a.filter(function (v, i) { return a.indexOf(v) === i; }) };
    }
    if (next.keys || prev.keys) {
      var k = (prev.keys || []).concat(next.keys || []);
      return { keys: k.filter(function (v, i) { return k.indexOf(v) === i; }) };
    }
    var out = {};
    var stores = Object.keys(prev).concat(Object.keys(next));
    stores.forEach(function (s) {
      var merged = (prev[s] || []).concat(next[s] || []);
      out[s] = merged.filter(function (v, i) { return merged.indexOf(v) === i; });
    });
    return out;
  }

  /**
   * 写入后按 store 计数核对：期望值 = 原数量 - 清空 + 写入。
   * 只核数量，不核内容（内容已由计划哈希与事务保证）。
   */
  async function verifyCounts(db, which, planStores, targetSectionsPart, written) {
    var F = BF();
    var stores = which === 'room' ? F.ROOM_STORES : which === 'butler' ? F.BUTLER_STORES : ['clips'];
    for (var i = 0; i < stores.length; i++) {
      var s = stores[i];
      var p = planStores[s] || {};
      var isClips = (which === 'radio' || which === 'chat');
      var before = isClips
        ? (targetSectionsPart.clips || []).length
        : (targetSectionsPart[s] || []).length;
      var wrote = written && written[s] ? written[s].length : 0;
      var expect = p.clear ? wrote : before + wrote;
      // 管家的提交标记也写进 meta，声音素材库 / 聊天语音库的标记写成一条记录：都不是业务数据，数的时候补回来
      if (which === 'butler' && s === 'meta') expect += 1;
      if (isClips) expect += 1;
      var actual = await countStore(db, s);
      if (actual !== expect) {
        throw new Error('数量核对失败：' + (which + '.' + s) + ' 期望 ' + expect + '，实际 ' + actual);
      }
    }
  }

  /** 生成目标机快照：必须自己回读并校验通过才算数。 */
  async function snapshot(label) {
    var out = await exportAll({ label: label || '手机现状', download: true });
    return out;
  }

  /**
   * 中断恢复：用同一份备份文件继续。
   * 只认「同一份备份」（payloadHash 相同）与库内提交标记，不要求计划哈希一致，
   * 因为上一轮已经写进去的记录会让重新生成的计划变成 skip，这是正常的。
   */
  async function resume(file, opts) {
    var options = opts || {};
    var journal = readJournal();
    if (!journal) return { ok: false, reason: 'no-journal' };
    if (journal.done) return { ok: false, reason: 'already-done' };
    var backupHash = (file.integrity && file.integrity.payloadHash) || '';
    if (journal.backupHash && backupHash && journal.backupHash !== backupHash) {
      return { ok: false, reason: 'backup-mismatch', message: '当前选择的备份文件与中断时不是同一份，无法续传' };
    }
    var target = await targetSections();
    var planInfo = await planFor(file, journal.mode || 'merge', { target: target });
    var res = await applyPlan({
      file: file,
      planInfo: planInfo,
      mode: journal.mode || 'merge',
      journal: journal,
      targetBefore: target,
      onProgress: options.onProgress,
    });
    return res;
  }

  /** 撤销本次导入写入的记录（只删本日志登记过、且不是原有数据的记录）。 */
  async function undo(journal) {
    var j = journal || readJournal();
    if (!j || !j.written) return { ok: false, reason: 'no-journal' };
    var F = BF();
    var removed = 0;
    var skipped = 0;
    var restoredKv = 0;

    async function dropRecords(which, storeName, ids) {
      if (!ids || !ids.length) return;
      var db = await openDB(which);
      try {
        await txRun(db, [storeName], function (t) {
          var s = t.objectStore(storeName);
          ids.forEach(function (id) { s.delete(id); });
        });
        removed += ids.length;
      } finally { closeQuiet(db); }
    }

    if (j.written.room) {
      for (var s in j.written.room) {
        if (!Object.prototype.hasOwnProperty.call(j.written.room, s)) continue;
        await dropRecords('room', s, j.written.room[s]);
      }
    }
    if (j.written.butler) {
      for (var b in j.written.butler) {
        if (!Object.prototype.hasOwnProperty.call(j.written.butler, b)) continue;
        if (b === 'meta') continue; // meta 的 schemaVersion 等是原有数据，不能按导入 id 删
        await dropRecords('butler', b, j.written.butler[b]);
      }
    }
    if (j.written.radio && j.written.radio.clips) {
      await dropRecords('radio', 'clips', j.written.radio.clips);
    }
    if (j.written.chat && j.written.chat.clips) {
      await dropRecords('chat', 'clips', j.written.chat.clips);
    }
    if (j.written.local && j.written.local.keys) {
      j.written.local.keys.forEach(function (k) {
        // 本来就在的键不动，只删本次导入新写的
        if (j.localExisted && j.localExisted[k]) { skipped += 1; return; }
        try { root.localStorage.removeItem(k); skipped += 1; } catch (e) { }
      });
    }
    // 单例 kv（settings / longTermMemory / longTermMemory.v2 / selfNarrative.v1）按导入前快照恢复，
    // 原本不存在的键删除，不把备份内容留在用户机器上。
    if (j.kvBefore && Object.keys(j.kvBefore).length) {
      var roomDb = await openDB('room');
      try {
        await txRun(roomDb, ['kv'], function (t) {
          var os = t.objectStore('kv');
          Object.keys(j.kvBefore).forEach(function (k) {
            var prev = j.kvBefore[k];
            if (prev && prev.present) os.put(prev.value, k);
            else os.delete(k);
          });
        });
        restoredKv = Object.keys(j.kvBefore).length;
      } finally { closeQuiet(roomDb); }
    }
    await clearMarker('room');
    await clearMarker('butler');
    await clearMarker('radio');
    await clearMarker('chat');
    clearJournal();
    return { ok: true, removed: removed, localStorageKeys: skipped, restoredKv: restoredKv };
  }

  function setDbSuffix(suffix) {
    DBS = JSON.parse(JSON.stringify(DEFAULT_DBS));
    if (suffix) {
      DBS.room.name += suffix;
      DBS.butler.name += suffix;
      DBS.radio.name += suffix;
      DBS.chat.name += suffix;
    }
    return DBS;
  }

  var API = {
    JOURNAL_KEY: JOURNAL_KEY,
    COMMIT_KEY: COMMIT_KEY,
    DBS: function () { return JSON.parse(JSON.stringify(DBS)); },
    setDbSuffix: setDbSuffix,
    collect: collect,
    buildFile: buildFile,
    toBlob: toBlob,
    exportAll: exportAll,
    verifyText: verifyText,
    targetSections: targetSections,
    planFor: planFor,
    preflight: preflight,
    applyPlan: applyPlan,
    snapshot: snapshot,
    resume: resume,
    undo: undo,
    readJournal: readJournal,
    clearJournal: clearJournal,
    readMarker: readMarker,
    fileName: fileName,
    download: download,
  };

  root.BackupIO = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
