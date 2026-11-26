/* tests/fixtures/migrate-scenarios.js — 迁移 IO 层浏览器场景（只在测试 profile 里跑）
 * 由 tests/shared/backup-io-browser.mjs 通过 /__test/ 注入。
 * 全部使用 *测* 后缀的库名，绝不碰真实 star_fifi_room / star_butler_v1 / ylxh_radio_voice。
 */
(function () {
  'use strict';
  var BF = window.BackupFormat;
  var IO = window.BackupIO;

  var PNG = 'data:image/png;base64,iVBORw0KGgo=';
  var JPG = 'data:image/jpeg;base64,/9j/4A==';
  var WEBM = 'data:audio/webm;base64,AAAAAA==';

  function raw(name) {
    return new Promise(function (res, rej) {
      var r = indexedDB.open(name);
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function putAll(db, store, recs) {
    return new Promise(function (res, rej) {
      var t = db.transaction(store, 'readwrite');
      var os = t.objectStore(store);
      recs.forEach(function (r) { os.put(r); });
      t.oncomplete = function () { res(); };
      t.onerror = function () { rej(t.error); };
    });
  }
  function putKey(db, store, key, val) {
    return new Promise(function (res, rej) {
      var t = db.transaction(store, 'readwrite');
      t.objectStore(store).put(val, key);
      t.oncomplete = function () { res(); };
      t.onerror = function () { rej(t.error); };
    });
  }
  function clearAll(db, store) {
    return new Promise(function (res, rej) {
      var t = db.transaction(store, 'readwrite');
      t.objectStore(store).clear();
      t.oncomplete = function () { res(); };
      t.onerror = function () { rej(t.error); };
    });
  }
  function countOf(db, store) {
    return new Promise(function (res, rej) {
      var t = db.transaction(store, 'readonly');
      var r = t.objectStore(store).count();
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function getAll(db, store) {
    return new Promise(function (res, rej) {
      var t = db.transaction(store, 'readonly');
      var r = t.objectStore(store).getAll();
      r.onsuccess = function () { res(r.result || []); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function getKey(db, store, key) {
    return new Promise(function (res, rej) {
      var t = db.transaction(store, 'readonly');
      var r = t.objectStore(store).get(key);
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function bytesOf(blob) {
    return blob.arrayBuffer().then(function (b) { return Array.from(new Uint8Array(b)); });
  }

  function sourceData() {
    return {
      room: {
        messages: [
          { id: 1, role: 'user', content: '晚安', time: 1000 },
          { id: 2, role: 'assistant', content: '晚安，用户。', englishContent: 'Good night.', time: 2000, image: PNG, audioData: WEBM },
          { id: 3, role: 'assistant', content: '', time: 3000, silent: true, silentReason: '有点累，但不想说。', silentAt: 3000, silentRevealedAt: null },
        ],
        keeps: [{ id: 1, title: '雨夜', content: '一起听雨', createdAt: 1500, photo: JPG, sourceMessageId: 2, status: 'saved' }],
        diaries: [{ id: 1, title: '今日来信', content: '今天很好', createdAt: 1600, date: '2026-11-18', reply: '我在。', replyMessageId: 2 }],
        starDiaries: [{ id: 1, title: '星星日记', content: '她睡着了', createdAt: 1700 }],
        futureLetters: [{ id: 1, title: '给未来的信', content: '明年见', createdAt: 1800, openAt: 1900000000000, openDate: '2030-01-01', status: 'sealed', replyMessageId: 2, photo: PNG }],
        settings: { light: 'soft', fontSize: '16', wallpaper: JPG, showTime: true },
        longTermMemory: '她喜欢雨声。',
      },
      butler: {
        tasks: [{ id: 1, title: '买菜', date: '2026-11-19', status: 'todo' }, { id: 2, title: '交房租', date: '2026-11-20', status: 'todo' }],
        transactions: [{ id: 1, name: '牛奶', amount: 12.5, date: '2026-11-18', status: 'pending' }],
        cycles: [{ id: 1, startDate: '2026-11-01' }],
        sleepLogs: [{ id: 1, date: '2026-11-18', hours: 7 }],
        meta: [{ key: 'schemaVersion', value: '1.0', updatedAt: 1000 }],
      },
      clips: [
        { id: 'c1', name: '雨声', mime: 'audio/mpeg', size: 3, createdAt: 1, use: 'sleep', blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' }) },
        { id: 'c2', name: '海浪', mime: 'audio/mpeg', size: 5, createdAt: 2, use: 'music', blob: new Blob([new Uint8Array([4, 5, 6, 7, 8])], { type: 'audio/mpeg' }) },
      ],
      ls: { 'ylxh.vocab.v1': '["rain"]', 'ylxh.radio.progress': '{"ep":3}' },
      lsForeign: { 'other.thing': 'x', pending_chat_message: '还没发出去的草稿' },
    };
  }

  // 灌数据：库由 IO.collect 首次打开时自动建表
  async function seed(suffix) {
    IO.setDbSuffix(suffix);
    await IO.collect(); // 触发建表
    var d = sourceData();
    var room = await raw('star_fifi_room' + suffix);
    await clearAll(room, 'messages'); await clearAll(room, 'keeps'); await clearAll(room, 'diaries');
    await clearAll(room, 'starDiaries'); await clearAll(room, 'futureLetters');
    await putAll(room, 'messages', d.room.messages);
    await putAll(room, 'keeps', d.room.keeps);
    await putAll(room, 'diaries', d.room.diaries);
    await putAll(room, 'starDiaries', d.room.starDiaries);
    await putAll(room, 'futureLetters', d.room.futureLetters);
    await putKey(room, 'kv', 'settings', d.room.settings);
    await putKey(room, 'kv', 'longTermMemory', d.room.longTermMemory);
    await putKey(room, 'kv', 'apiKey', 'TEST_API_KEY_PLACEHOLDER');
    room.close();

    var but = await raw('star_butler_v1' + suffix);
    await clearAll(but, 'tasks'); await clearAll(but, 'transactions'); await clearAll(but, 'cycles');
    await clearAll(but, 'sleepLogs'); await clearAll(but, 'meta');
    await putAll(but, 'tasks', d.butler.tasks);
    await putAll(but, 'transactions', d.butler.transactions);
    await putAll(but, 'cycles', d.butler.cycles);
    await putAll(but, 'sleepLogs', d.butler.sleepLogs);
    await putAll(but, 'meta', d.butler.meta);
    but.close();

    var rad = await raw('ylxh_radio_voice' + suffix);
    await clearAll(rad, 'clips');
    await putAll(rad, 'clips', d.clips);
    rad.close();

    Object.keys(d.ls).forEach(function (k) { localStorage.setItem(k, d.ls[k]); });
    Object.keys(d.lsForeign).forEach(function (k) { localStorage.setItem(k, d.lsForeign[k]); });
    localStorage.removeItem(IO.JOURNAL_KEY);
    return true;
  }

  async function dbCounts(suffix) {
    var out = { room: {}, butler: {}, clips: 0 };
    var room = await raw('star_fifi_room' + suffix);
    var names = ['messages', 'keeps', 'diaries', 'starDiaries', 'futureLetters'];
    for (var i = 0; i < names.length; i++) out.room[names[i]] = await countOf(room, names[i]);
    room.close();
    var but = await raw('star_butler_v1' + suffix);
    var bn = ['tasks', 'transactions', 'cycles', 'sleepLogs', 'meta'];
    for (var j = 0; j < bn.length; j++) {
      if (bn[j] === 'meta') {
        // 提交标记不算业务数据
        var rows = await getAll(but, 'meta');
        out.butler.meta = rows.filter(function (r) { return r.key !== IO.COMMIT_KEY; }).length;
        out.butler.marker = rows.length - out.butler.meta;
        continue;
      }
      out.butler[bn[j]] = await countOf(but, bn[j]);
    }
    but.close();
    var rad = await raw('ylxh_radio_voice' + suffix);
    var clipRows = await getAll(rad, 'clips');
    out.clips = clipRows.filter(function (r) { return r.kind !== 'migration-marker'; }).length;
    out.clipMarker = clipRows.length - out.clips;
    rad.close();
    return out;
  }

  var T = {};

  /* 1. 源数据 + 采集 */
  T.step1 = async function () {
    await seed('_t');
    var col = await IO.collect({ packVoice: false });
    return { counts: col.counts, problems: col.problems, excluded: col.excluded };
  };

  /* 2. 导出 + 回读校验 */
  T.step2 = async function () {
    var r = await IO.exportAll({ label: '电脑', download: false });
    if (!r.ok) return { ok: false, reason: r.reason, detail: r.detail, problems: r.problems };
    window.__file = r.file;
    window.__text = r.text;
    window.__sha = r.sha256;
    var again = await IO.verifyText(r.text);
    return {
      ok: true,
      size: r.size,
      sha256: r.sha256,
      counts: r.counts,
      attachments: r.report.totalCount,
      attachmentBytes: r.report.totalBytes,
      byKind: r.report.byKind,
      warn: r.warn,
      recheck: again.ok,
      hasApiKey: r.text.indexOf('TEST_API_KEY_PLACEHOLDER') !== -1,
      hasDraft: r.text.indexOf('还没发出去的草稿') !== -1,
      hasForeignKey: r.text.indexOf('other.thing') !== -1,
    };
  };

  /* 3. 篡改检测 */
  T.step3 = async function () {
    var out = {};
    var t1 = window.__text.replace('晚安，用户。', '早安，用户。');
    var v1 = await IO.verifyText(t1);
    out.contentTamper = { ok: v1.ok, reason: v1.reason };

    var obj = JSON.parse(window.__text);
    var b64 = obj.radio_voice.clips[0].blob.base64;
    obj.radio_voice.clips[0].blob.base64 = b64.replace(/^../, b64.slice(0, 2) === 'AQ' ? 'Ag' : 'AQ');
    var v2 = await IO.verifyText(JSON.stringify(obj));
    out.audioTamper = { ok: v2.ok, reason: v2.reason };

    var v3 = await IO.verifyText('{"format":"ylxh-backup","version":2}');
    out.brokenShape = { ok: v3.ok, reason: v3.reason };
    return out;
  };

  /* 4. 计划：合并 / 替换 / 跳过 */
  T.step4 = async function () {
    IO.setDbSuffix('_t2');
    await IO.collect(); // 空库建表
    var merge = await IO.planFor(window.__file, 'merge');
    var replace = await IO.planFor(window.__file, 'replace');
    var skip = await IO.planFor(window.__file, 'skip-existing');
    return {
      merge: merge.summary,
      replace: replace.summary,
      skip: skip.summary,
      target: merge.targetCounts,
      backup: merge.backupCounts,
      planHash: merge.planHash,
      planHashStable: (await IO.planFor(window.__file, 'merge')).planHash === merge.planHash,
      localStorageKeys: Object.keys(merge.plan.localStorage.set).sort(),
      hasDraftKey: Object.prototype.hasOwnProperty.call(merge.plan.localStorage.set, 'pending_chat_message'),
    };
  };

  /* 5. 导入空库 + 内容核对 */
  T.step5 = async function () {
    var info = await IO.planFor(window.__file, 'merge');
    var pre = await IO.preflight(window.__file, info);
    var res = await IO.applyPlan({ file: window.__file, planInfo: { mode: 'merge', plan: pre.plan, planHash: info.planHash } });
    var counts = await dbCounts('_t2');
    var room = await raw('star_fifi_room_t2');
    var msgs = await getAll(room, 'messages');
    var keeps = await getAll(room, 'keeps');
    var diaries = await getAll(room, 'diaries');
    var letters = await getAll(room, 'futureLetters');
    var settings = await getKey(room, 'kv', 'settings');
    var memory = await getKey(room, 'kv', 'longTermMemory');
    var marker = await getKey(room, 'kv', IO.COMMIT_KEY);
    room.close();
    var rad = await raw('ylxh_radio_voice_t2');
    var clips = await getAll(rad, 'clips');
    rad.close();
    var clipInfo = [];
    for (var i = 0; i < clips.length; i++) {
      clipInfo.push({
        id: clips[i].id,
        isBlob: clips[i].blob instanceof Blob,
        size: clips[i].blob && clips[i].blob.size,
        type: clips[i].blob && clips[i].blob.type,
        sha: clips[i].blob && clips[i].blob.sha256,
        bytes: clips[i].blob instanceof Blob ? await bytesOf(clips[i].blob) : null,
        use: clips[i].use,
        name: clips[i].name,
      });
    }
    var m2 = msgs.find(function (m) { return m.id === 2; });
    var m3 = msgs.find(function (m) { return m.id === 3; });
    return {
      ok: res.ok,
      stages: res.stages.map(function (s) { return s.stage + ':' + s.status; }),
      counts: counts,
      image: m2 && m2.image,
      audio: m2 && m2.audioData,
      english: m2 && m2.englishContent,
      silent: m3 && { silent: m3.silent, reason: m3.silentReason },
      keepRef: keeps[0] && keeps[0].sourceMessageId,
      keepPhoto: keeps[0] && keeps[0].photo,
      diaryRef: diaries[0] && diaries[0].replyMessageId,
      letterRef: letters[0] && letters[0].replyMessageId,
      letterPhoto: letters[0] && letters[0].photo,
      settings: settings,
      memory: memory,
      marker: marker && { stage: marker.stage, hasHash: !!marker.planHash },
      clips: clipInfo,
      ls: {
        vocab: localStorage.getItem('ylxh.vocab.v1'),
        progress: localStorage.getItem('ylxh.radio.progress'),
        foreign: localStorage.getItem('other.thing'),
        draft: localStorage.getItem('pending_chat_message'),
      },
      journalDone: (IO.readJournal() || {}).done,
    };
  };

  /* 6. 重复导入：必须全部跳过、数量不变 */
  T.step6 = async function () {
    var before = await dbCounts('_t2');
    var info = await IO.planFor(window.__file, 'merge');
    var pre = await IO.preflight(window.__file, info);
    var res = await IO.applyPlan({ file: window.__file, planInfo: { mode: 'merge', plan: pre.plan, planHash: info.planHash } });
    var after = await dbCounts('_t2');
    return { summary: info.summary, ok: res.ok, before: before, after: after };
  };

  /* 7. 冲突合并：同 id 不同内容 → 新 id + 引用改写 */
  T.step7 = async function () {
    var room = await raw('star_fifi_room_t2');
    await putAll(room, 'messages', [{ id: 2, role: 'assistant', content: '手机上原来就有的第二条', time: 2000 }]);
    await clearAll(room, 'keeps');
    room.close();
    var info = await IO.planFor(window.__file, 'merge');
    var pre = await IO.preflight(window.__file, info);
    var res = await IO.applyPlan({ file: window.__file, planInfo: { mode: 'merge', plan: pre.plan, planHash: info.planHash } });
    var r2 = await raw('star_fifi_room_t2');
    var msgs = await getAll(r2, 'messages');
    var keeps = await getAll(r2, 'keeps');
    r2.close();
    var old = msgs.find(function (m) { return m.id === 2; });
    var moved = msgs.filter(function (m) { return m.id !== 2 && m.content === '晚安，用户。'; })[0];
    return {
      ok: res.ok,
      errors: res.errors,
      stages: res.stages.map(function (s) { return s.stage + ':' + s.status; }),
      conflictCount: info.summary.conflict,
      remap: info.summary.remap,
      idMap: info.plan.idMap.messages,
      msgList: msgs.map(function (m) { return m.id + ':' + String(m.content || '').slice(0, 8); }),
      oldKept: old && old.content,
      movedId: moved && moved.id,
      movedImage: moved && moved.image,
      keepRef: keeps[0] && keeps[0].sourceMessageId,
      keepRefPointsToMoved: !!(keeps[0] && moved && keeps[0].sourceMessageId === moved.id),
      totalMessages: msgs.length,
    };
  };

  /* 8. 坏附件必须阻断，且不写任何数据 */
  T.step8 = async function () {
    var out = {};
    var before = await dbCounts('_t2');

    // (a) 声明字节数与 base64 不符
    var a = JSON.parse(window.__text);
    a.radio_voice.clips[0].blob.bytes = 999;
    a.integrity = await BF.buildIntegrity(a);
    var va = await IO.verifyText(JSON.stringify(a));
    out.bytesMismatch = { ok: va.ok, reason: va.reason };

    // (b) base64 换掉但声明字节数不变 → 声明哈希与实际字节不符
    var b = JSON.parse(window.__text);
    b.radio_voice.clips[0].blob.base64 = 'AgM=';
    b.radio_voice.clips[0].blob.bytes = 3;
    b.integrity = await BF.buildIntegrity(b);
    var vb = await IO.verifyText(JSON.stringify(b));
    out.hashMismatch = { ok: vb.ok, reason: vb.reason };

    // (c) 缺附件
    var c = JSON.parse(window.__text);
    delete c.radio_voice.clips[0].blob;
    c.integrity = await BF.buildIntegrity(c);
    var vc = await IO.verifyText(JSON.stringify(c));
    out.missing = { ok: vc.ok, reason: vc.reason };

    // 坏文件也不能进到计划/写入
    var planAttempt = null;
    try {
      var info = await IO.planFor(b, 'merge');
      await IO.preflight(b, info);
      planAttempt = 'not-blocked';
    } catch (e) {
      planAttempt = 'blocked: ' + e.message;
    }
    out.planAttempt = planAttempt;
    out.countsUnchanged = JSON.stringify(before) === JSON.stringify(await dbCounts('_t2'));
    return out;
  };

  /* 9. 中断 + 续传（模拟「数据已提交、日志来不及写」） */
  T.step9 = async function () {
    IO.setDbSuffix('_t3');
    await IO.collect();
    localStorage.removeItem(IO.JOURNAL_KEY);
    var info = await IO.planFor(window.__file, 'merge');
    var pre = await IO.preflight(window.__file, info);
    var first = await IO.applyPlan({
      file: window.__file,
      planInfo: { mode: 'merge', plan: pre.plan, planHash: info.planHash },
      pauseAfterStage: 'room',
    });
    var mid = await dbCounts('_t3');
    var markerMid = await IO.readMarker('room');
    // 模拟日志没落盘：把 room 阶段记录抹掉，只剩备份标识
    var j = IO.readJournal();
    if (j) { delete j.stages.room; localStorage.setItem(IO.JOURNAL_KEY, JSON.stringify(j)); }
    var other = JSON.parse(window.__text);
    other.exportedAt = (other.exportedAt || 0) + 1;
    other.integrity = await BF.buildIntegrity(other);
    var refused = await IO.resume(other, {});

    var resumed = await IO.resume(window.__file, {});
    var after = await dbCounts('_t3');
    var room = await raw('star_fifi_room_t3');
    var msgs = await getAll(room, 'messages');
    room.close();
    return {
      firstOk: first.ok,
      paused: first.paused,
      pausedAt: first.pausedAt,
      mid: mid,
      markerStage: markerMid && markerMid.stage,
      refused: { ok: refused.ok, reason: refused.reason },
      resumedOk: resumed.ok,
      resumedStages: (resumed.stages || []).map(function (s) { return s.stage + ':' + s.status; }),
      after: after,
      messageCount: msgs.length,
      uniqueIds: new Set(msgs.map(function (m) { return m.id; })).size,
      journalDone: (IO.readJournal() || {}).done,
    };
  };

  /* 10. 撤销本次导入 */
  T.step10 = async function () {
    var before = await dbCounts('_t3');
    var r = await IO.undo();
    var after = await dbCounts('_t3');
    return { ok: r.ok, removed: r.removed, before: before, after: after, journal: IO.readJournal() };
  };

  /* 11. 导入真实库名 + 主页渲染 */
  T.step11 = async function () {
    IO.setDbSuffix('');
    await IO.collect();
    localStorage.removeItem(IO.JOURNAL_KEY);
    var info = await IO.planFor(window.__file, 'merge');
    var pre = await IO.preflight(window.__file, info);
    var res = await IO.applyPlan({ file: window.__file, planInfo: { mode: 'merge', plan: pre.plan, planHash: info.planHash } });
    var counts = await dbCounts('');
    return { ok: res.ok, counts: counts, settings: await (async function () {
      var db = await raw('star_fifi_room');
      var s = await getKey(db, 'kv', 'settings');
      db.close();
      return s;
    })() };
  };

  window.T = T;
})();
