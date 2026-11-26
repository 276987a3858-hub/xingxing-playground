/* public/shared/backup-format.js — 跨设备迁移 v2：格式、规范化、哈希、导入计划（P1）
 * 纯函数层：零副作用，不读写 IndexedDB / localStorage / 网络。
 * 只负责「数据长什么样、是否完整、要写哪些记录」，落盘由 backup-io.js 负责。
 *
 * 挂载：window.BackupFormat（经典脚本）；Node 测试 import 后取 globalThis.BackupFormat。
 */
(function (root) {
  'use strict';

  const FORMAT = 'ylxh-backup';
  const VERSION = 2;
  const MIN_APP = '2.1';
  const ALGO = 'sha256';

  // 业务分区：与数据库一一对应，哈希与计数都按这个顺序展开
  const ROOM_STORES = ['messages', 'keeps', 'diaries', 'starDiaries', 'futureLetters'];
  const BUTLER_STORES = ['tasks', 'transactions', 'cycles', 'sleepLogs', 'meta'];
  // 长期记忆 v2 与旧 longTermMemory 同库不同键：两者必须同时备份，互不覆盖。
  const LTM_V2_KEY = 'longTermMemory.v2';
  const LTM_V2_SCHEMA = 1;
  // 机自述：独立键、独立结构，随 room.kv 一起迁移；与长期记忆 / 日记 / 珍藏互不相干。
  const SELF_NARRATIVE_KEY = 'selfNarrative.v1';
  const SELF_NARRATIVE_SCHEMA = 1;
  // 机自述的状态集合（与 self-narrative.js 保持一致；备份层只做最小校验，不复制业务规则）
  const SELF_NARRATIVE_STATUS = ['active', 'retracted', 'superseded'];
  // basis 同理：只校验取值是否在集合内，不做语义推导（stated ≠ 用户确认）。
  const SELF_NARRATIVE_BASIS = ['stated', 'observed', 'inferred'];

  // localStorage 白名单：只迁移明确属于本应用的键，不做全量搬运
  const LS_ALLOW = [
    'ylxh.vocab.v1',
    'ylxh.radio.episodes',
    'ylxh.radio.progress',
    'ylxh.radio.sleep',
    'ylxh.radio.sleepPlaylist',
    'ylxh.radio.sleepPlayed',
    'ylxh.radio.music.meta',
    'ylxh.radio.reading',
    'ylxh.radio.en.voiceCooldown',
    'ylxh.game.live.v1',
    'ylxh.game.keepState',
    'ylxh.game.activity.v1',
    'ylxh.game.activity.seen.v1',
    'ylxh.game.recentLines',
    'ylxh.game.shownEvents',
    'ylxh.playground.v1',
    'ylxh.life.v1',
    'ylxh.life.log.v1',
    'ylxh.life.state.v1',
    'ylxh.life.recall.v1',
    'ylxh.topics.avoid.v1',
    'ylxh.puzzle.custom.v1',
    'ylxh.blackjack.chips',
    'ylxh.blackjack.round',
    'ylxh.blackjack.card',
    'ylxh.blackjack.bg',
    'ylxh.blackjack.chat',
    'gomoku_wins',
    'gomoku_losses',
    'gomoku_streak',
  ];

  // 明确排除：草稿属于「这台设备上还没发出去的东西」，默认不跨设备搬运。
  // 导出报告里要显式列出，不能假装它不存在。
  const LS_EXCLUDED = { pending_chat_message: '未发送草稿，默认不迁移' };

  // 附件体积门槛：50 MiB 提醒，100 MiB 硬上限。
  // 上限依据：JSON 里二进制要转 base64，体积约为原始的 1.34 倍；
  // 100 MiB 原始数据 ≈ 137 MB 文本，已接近手机浏览器一次性解析 + 写入的可靠边界。
  const ATTACH_LIMITS = { warn: 50 * 1024 * 1024, hard: 100 * 1024 * 1024 };
  const BASE64_RATIO = 4 / 3;

  // 二进制包装：JSON 无法直接存 Blob，统一走这两种标记对象
  const BLOB_TAG = '__blob';
  const BYTES_TAG = '__bytes';

  /* ---------------- 基础工具 ---------------- */

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }
  /** v2 结构最小校验：不合法就一律不导入，绝不用半截数据覆盖现有记忆。 */
  function isLtmV2(v) {
    if (!isPlainObject(v) || v.schema !== LTM_V2_SCHEMA || !Array.isArray(v.entries) ||
        typeof v.baseline !== 'string') return false;
    return v.entries.every(function (e) {
      return isPlainObject(e) && typeof e.id === 'string' && !!e.id &&
        typeof e.text === 'string' && !!e.text.length &&
        typeof e.category === 'string' && !!e.category &&
        isPlainObject(e.source) && typeof e.source.kind === 'string' && !!e.source.kind &&
        typeof e.createdAt === 'number' && typeof e.updatedAt === 'number' &&
        ['active', 'retracted', 'archived'].indexOf(e.status) !== -1;
    });
  }

  /**
   * 机自述单个历史版本的最小校验（正文 + 来源 + 状态都在，才能完整搬运）。
   */
  // evidence 最小校验：只保证「能安全搬运」。旧数据没有这个字段，必须允许缺省。
  function isEvidenceList(v) {
    if (!Array.isArray(v)) return false;
    return v.every(function (e) {
      if (!isPlainObject(e)) return false;
      const m = e.messageId;
      if (typeof m === 'number') { if (!isFinite(m) || Math.floor(m) !== m) return false; }
      else if (typeof m === 'string') { if (!m.trim()) return false; }
      else return false;
      return typeof e.quote === 'string';
    });
  }
  function isBasis(v) { return v == null || SELF_NARRATIVE_BASIS.indexOf(v) !== -1; }

  function isSelfVersion(v) {
    return isPlainObject(v) && typeof v.at === 'number' &&
      typeof v.text === 'string' && !!v.text.trim().length &&
      typeof v.kind === 'string' && !!v.kind &&
      typeof v.confidence === 'string' && !!v.confidence &&
      SELF_NARRATIVE_STATUS.indexOf(v.status) !== -1 &&
      isPlainObject(v.source) && typeof v.source.kind === 'string' && !!v.source.kind &&
      isBasis(v.basis) && (v.evidence == null || isEvidenceList(v.evidence));
  }

  /**
   * 机自述结构最小校验：不合法就整块跳过并留警告，绝不用半截数据覆盖目标机现有记录。
   * 只校验「能不能安全搬运」，不复制数据层的业务规则（kind 取值等由 self-narrative.js 负责）。
   */
  function isSelfNarrative(v) {
    if (!isPlainObject(v) || v.schema !== SELF_NARRATIVE_SCHEMA || v.key !== SELF_NARRATIVE_KEY) return false;
    if (!Array.isArray(v.records)) return false;
    if (typeof v.createdAt !== 'number' || typeof v.updatedAt !== 'number') return false;
    return v.records.every(function (r) {
      return isPlainObject(r) && typeof r.id === 'string' && !!r.id &&
        typeof r.text === 'string' && !!r.text.trim().length &&
        typeof r.kind === 'string' && !!r.kind &&
        typeof r.confidence === 'string' && !!r.confidence &&
        SELF_NARRATIVE_STATUS.indexOf(r.status) !== -1 &&
        isPlainObject(r.source) && typeof r.source.kind === 'string' && !!r.source.kind &&
        typeof r.createdAt === 'number' && typeof r.updatedAt === 'number' &&
        Array.isArray(r.history) && r.history.every(isSelfVersion) &&
        isBasis(r.basis) && (r.evidence == null || isEvidenceList(r.evidence)) &&
        (r.revisedFrom == null || typeof r.revisedFrom === 'string');
    });
  }

  /** 递归按 key 字典序重建对象，数组保持原序。哈希前必须过这一道。 */
  function sortedClone(v) {
    if (Array.isArray(v)) return v.map(sortedClone);
    if (isPlainObject(v)) {
      const out = {};
      Object.keys(v).sort().forEach(function (k) { out[k] = sortedClone(v[k]); });
      return out;
    }
    return v;
  }

  /** 规范化 JSON 文本：无缩进、键有序、UTF-8。 */
  function canonicalString(v) {
    return JSON.stringify(sortedClone(v));
  }

  function byteLen(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str).length;
    return unescape(encodeURIComponent(str)).length;
  }

  /* ---------------- 哈希 ---------------- */

  function toHex(buf) {
    const b = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
    return s;
  }

  function subtle() {
    const c = root.crypto || (typeof crypto !== 'undefined' ? crypto : null);
    return c && c.subtle ? c.subtle : null;
  }

  /** SHA-256(text) → 64 位小写十六进制。浏览器与 Node 22 都用 WebCrypto。 */
  async function sha256Hex(text) {
    const s = subtle();
    if (!s) throw new Error('当前环境不支持 SHA-256');
    const buf = await s.digest('SHA-256', new TextEncoder().encode(String(text)));
    return toHex(buf);
  }

  /** SHA-256(原始字节) → hex。附件校验一律按字节算，不按 base64 文本算。 */
  async function sha256Bytes(bytes) {
    const s = subtle();
    if (!s) throw new Error('当前环境不支持 SHA-256');
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const buf = await s.digest('SHA-256', b);
    return toHex(buf);
  }

  function bytesToBase64(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let s = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < b.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, b.subarray(i, i + CHUNK));
    }
    if (typeof btoa === 'function') return btoa(s);
    return Buffer.from(b).toString('base64');
  }

  function base64ToBytes(b64) {
    if (typeof atob === 'function') {
      const s = atob(String(b64));
      const out = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(String(b64), 'base64'));
  }

  /** 任意二进制 → 可入 JSON 的包装对象（带原始字节数与字节级哈希，供快照回读时校验）。 */
  async function encodeBinary(data, mime) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    return {
      [BYTES_TAG]: true,
      mime: mime || 'application/octet-stream',
      bytes: bytes.length,
      sha256: await sha256Bytes(bytes),
      base64: bytesToBase64(bytes),
    };
  }

  /** 包装对象 → { bytes, mime }；结构不对直接抛错，避免静默写坏数据。 */
  function decodeBinary(packed) {
    if (!isPlainObject(packed) || packed[BYTES_TAG] !== true) {
      throw new Error('不是合法的二进制包装');
    }
    const bytes = base64ToBytes(packed.base64);
    if (packed.bytes != null && bytes.length !== packed.bytes) {
      throw new Error('二进制长度不符：期望 ' + packed.bytes + ' 实际 ' + bytes.length);
    }
    return { bytes: bytes, mime: packed.mime || 'application/octet-stream' };
  }

  /** 逐个校验附件（长度 + 原始字节哈希），用于快照回读，不只比 JSON 文本。 */
  async function verifyAttachment(packed) {
    try {
      const dec = decodeBinary(packed);
      if (packed.sha256) {
        const h = await sha256Bytes(dec.bytes);
        if (h !== packed.sha256) return { ok: false, reason: 'hash-mismatch' };
      }
      return { ok: true, bytes: dec.bytes.length, mime: dec.mime };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  /* ---------------- 附件体积核算 ---------------- */

  /**
   * dataURL 的真实原始字节数（不是字符串长度）。
   * base64 每 4 字符还原 3 字节，末尾 '=' 各扣 1。
   */
  function dataUrlByteLength(str) {
    const info = dataUrlInfo(str);
    return info && !info.external && !info.invalid ? info.bytes : 0;
  }

  /** 解析 dataURL：→ { bytes, mime, base64 } / { external } / { invalid } / null */
  function dataUrlInfo(str) {
    if (typeof str !== 'string' || !str) return null;
    if (str.slice(0, 5) !== 'data:') return { external: true, bytes: 0, mime: '' };
    const comma = str.indexOf(',');
    if (comma < 0) return { invalid: true, bytes: 0, mime: '' };
    const head = str.slice(5, comma);
    const mime = (head.split(';')[0] || 'application/octet-stream').toLowerCase();
    const body = str.slice(comma + 1);
    if (!/;base64$/i.test(head)) {
      try {
        return { bytes: byteLen(decodeURIComponent(body)), mime: mime, base64: false };
      } catch (e) {
        return { invalid: true, bytes: 0, mime: mime };
      }
    }
    let pad = 0;
    if (body.slice(-2) === '==') pad = 2;
    else if (body.slice(-1) === '=') pad = 1;
    return { bytes: Math.max(0, Math.floor((body.length * 3) / 4) - pad), mime: mime, base64: true };
  }

  /**
   * 逐项列出所有附件：聊天图片、聊天语音、各类 photo、壁纸、声音素材。
   * 缺失（素材没有 blob）与格式异常都会被记下来，绝不静默跳过。
   */
  function attachmentItems(sections) {
    const items = [];
    const pushDataUrl = function (at, kind, raw) {
      const info = dataUrlInfo(raw);
      if (!info) return;
      if (info.external) { items.push({ at: at, kind: kind, bytes: 0, external: true }); return; }
      if (info.invalid) { items.push({ at: at, kind: kind, bytes: 0, invalid: true }); return; }
      items.push({ at: at, kind: kind, bytes: info.bytes, mime: info.mime });
    };
    const room = (sections && sections.room) || {};
    (room.messages || []).forEach(function (m) {
      pushDataUrl('messages/' + m.id + '/image', 'chat-image', m.image);
      pushDataUrl('messages/' + m.id + '/audio', 'chat-audio', m.audioData);
    });
    ['keeps', 'diaries', 'starDiaries', 'futureLetters'].forEach(function (s) {
      (room[s] || []).forEach(function (r) { pushDataUrl(s + '/' + r.id + '/photo', 'photo', r.photo); });
    });
    if (room.kv && isPlainObject(room.kv.settings)) {
      pushDataUrl('kv/settings/wallpaper', 'wallpaper', room.kv.settings.wallpaper);
    }
    const clips = (sections && sections.radioVoice && sections.radioVoice.clips) || [];
    clips.forEach(function (c) { pushClip('radio_voice', c); });
    // 聊天语音：结构相同，只是分区不同；缺音频/格式异常同样逐条上报
    const chatClips = (sections && sections.chatVoice && sections.chatVoice.clips) || [];
    chatClips.forEach(function (c) { pushClip('chat_voice', c); });

    function pushClip(prefix, c) {
      const at = prefix + '/' + c.id;
      // 没打包的 Blob / ArrayBuffer 直接入 JSON 会被序列化成 {}，必须当场拦下
      const isBlob = typeof Blob !== 'undefined' && c.blob instanceof Blob;
      const isBuf = typeof ArrayBuffer !== 'undefined' && (c.blob instanceof ArrayBuffer || (ArrayBuffer.isView && ArrayBuffer.isView(c.blob)));
      if (isBlob || isBuf) {
        items.push({ at: at, kind: 'voice-clip', bytes: (isBlob && c.blob.size) || (isBuf && c.blob.byteLength) || 0, unpacked: true });
        return;
      }
      if (!isPlainObject(c.blob)) {
        items.push({ at: at, kind: 'voice-clip', bytes: 0, missing: true });
        return;
      }
      // base64 长度与声明的字节数必须自洽（O(1) 校验，不额外解码）
      if (typeof c.blob.base64 === 'string' && c.blob.base64 && typeof c.blob.bytes === 'number') {
        const b64 = c.blob.base64;
        let pad = 0;
        if (b64.slice(-2) === '==') pad = 2;
        else if (b64.slice(-1) === '=') pad = 1;
        const calc = Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
        if (calc !== c.blob.bytes) {
          items.push({ at: at, kind: 'voice-clip', bytes: calc, invalid: true, mime: c.blob.mime || '' });
          return;
        }
      }
      items.push({
        at: at,
        kind: 'voice-clip',
        bytes: typeof c.blob.bytes === 'number' ? c.blob.bytes : 0,
        mime: c.blob.mime || '',
        sha256: c.blob.sha256 || '',
      });
    }
    return items;
  }

  /**
   * 附件总账：分类计数、真实字节、预估 JSON 体积、阈值状态、重复字节组。
   * level: ok / warn（> 50 MiB）/ blocked（超硬上限、缺失或格式异常）。
   */
  function attachmentReport(sections, opts) {
    const limits = Object.assign({ warn: ATTACH_LIMITS.warn, hard: ATTACH_LIMITS.hard }, opts || {});
    const items = attachmentItems(sections);
    const byKind = {};
    const invalid = [], external = [], missing = [], unpacked = [];
    const byHash = new Map();
    let totalBytes = 0;
    items.forEach(function (it) {
      totalBytes += it.bytes || 0;
      const k = byKind[it.kind] || (byKind[it.kind] = { count: 0, bytes: 0 });
      k.count += 1;
      k.bytes += it.bytes || 0;
      if (it.invalid) invalid.push(it.at);
      if (it.external) external.push(it.at);
      if (it.missing) missing.push(it.at);
      if (it.unpacked) unpacked.push(it.at);
      if (it.sha256) {
        const g = byHash.get(it.sha256) || [];
        g.push(it.at);
        byHash.set(it.sha256, g);
      }
    });
    const duplicates = [];
    byHash.forEach(function (at, sha) { if (at.length > 1) duplicates.push({ sha256: sha, count: at.length, at: at }); });
    const overHard = totalBytes > limits.hard;
    const overWarn = totalBytes > limits.warn;
    const level = (overHard || invalid.length || missing.length || unpacked.length) ? 'blocked' : (overWarn ? 'warn' : 'ok');
    return {
      items: items,
      byKind: byKind,
      totalCount: items.length,
      totalBytes: totalBytes,
      estimatedJsonBytes: Math.ceil(totalBytes * BASE64_RATIO) + 512 * 1024,
      warnAt: limits.warn,
      hardAt: limits.hard,
      overWarn: overWarn,
      overHard: overHard,
      level: level,
      duplicates: duplicates,
      invalid: invalid,
      external: external,
      missing: missing,
      unpacked: unpacked,
    };
  }

  /**
   * 导出前的硬门槛：返回 ok=false 时必须中止导出，并把这些原因原样报给用户。
   * 绝不「先导出、少几个附件算了」。
   */
  function checkAttachmentBudget(report) {
    if (report.unpacked && report.unpacked.length) {
      return { ok: false, reason: 'attachment-not-packed', detail: { at: report.unpacked } };
    }
    if (report.missing && report.missing.length) {
      return { ok: false, reason: 'attachment-missing', detail: { at: report.missing } };
    }
    if (report.invalid && report.invalid.length) {
      return { ok: false, reason: 'attachment-invalid', detail: { at: report.invalid } };
    }
    if (report.overHard) {
      return { ok: false, reason: 'attachment-over-hard-limit', detail: { totalBytes: report.totalBytes, hardAt: report.hardAt } };
    }
    return { ok: true, warn: !!report.overWarn, report: report };
  }

  /* ---------------- 版本识别与归一化 ---------------- */

  function detectVersion(obj) {
    if (!isPlainObject(obj)) return 'unknown';
    if (obj.format === FORMAT && Number(obj.version) >= 2) return 'v2';
    if (Array.isArray(obj.messages) || Array.isArray(obj.keeps) || obj.settings) return 'v1';
    return 'unknown';
  }

  function emptySections() {
    return {
      room: { kv: {}, messages: [], keeps: [], diaries: [], starDiaries: [], futureLetters: [] },
      butler: { tasks: [], transactions: [], cycles: [], sleepLogs: [], meta: [] },
      localStorage: {},
      radioVoice: { clips: [] },
      // 聊天语音消息的原始录音（独立库 ylxh_chat_voice）：与声音素材库分开，互不影响
      chatVoice: { clips: [] },
    };
  }

  function pickArray(v) { return Array.isArray(v) ? v.slice() : null; }

  /**
   * 任意版本备份 → 内部统一模型。
   * 返回 { version, sections, absent, warnings }；absent 列出该文件里完全没有的分区，
   * 导入时必须显式跳过并写进报告，绝不假装「有 0 条」。
   */
  function normalizeBackup(obj) {
    const version = detectVersion(obj);
    const sections = emptySections();
    const absent = [];
    const warnings = [];
    if (version === 'unknown') {
      return { version: version, sections: sections, absent: absent, warnings: ['无法识别的备份文件'] };
    }

    if (version === 'v2') {
      const src = isPlainObject(obj.star_fifi_room) ? obj.star_fifi_room : null;
      if (!src) { absent.push('star_fifi_room'); } else {
        ROOM_STORES.forEach(function (s) {
          const arr = pickArray(src[s]);
          if (arr) sections.room[s] = arr; else absent.push('star_fifi_room.' + s);
        });
        if (isPlainObject(src.kv)) {
          ['settings', 'longTermMemory', LTM_V2_KEY, SELF_NARRATIVE_KEY].forEach(function (k) {
            if (k in src.kv) sections.room.kv[k] = src.kv[k];
          });
          // 备份里的 v2 不合法时不当成空记忆：丢弃该分区并留警告，绝不覆盖目标机现有数据。
          if (LTM_V2_KEY in sections.room.kv && !isLtmV2(sections.room.kv[LTM_V2_KEY])) {
            delete sections.room.kv[LTM_V2_KEY];
            warnings.push('备份里的长期记忆 v2 结构不合法，已跳过；旧 longTermMemory 原文仍可导入');
          }
          // 机自述同理：结构不合法就整块跳过，目标机记录原样保留。
          if (SELF_NARRATIVE_KEY in sections.room.kv && !isSelfNarrative(sections.room.kv[SELF_NARRATIVE_KEY])) {
            delete sections.room.kv[SELF_NARRATIVE_KEY];
            warnings.push('备份里的机自述结构不合法，已跳过；目标机现有记录不受影响');
          }
        }
      }
      const b = isPlainObject(obj.star_butler_v1) ? obj.star_butler_v1 : null;
      if (!b) { absent.push('star_butler_v1'); } else {
        BUTLER_STORES.forEach(function (s) {
          const arr = pickArray(b[s]);
          if (arr) sections.butler[s] = arr; else absent.push('star_butler_v1.' + s);
        });
      }
      const rv = isPlainObject(obj.radio_voice) ? pickArray(obj.radio_voice.clips) : null;
      if (rv) sections.radioVoice.clips = rv; else absent.push('radio_voice');
      // 聊天语音：旧备份没有这一区，属于「这份文件里没有语音录音」，不是解析失败
      const cv = isPlainObject(obj.chat_voice) ? pickArray(obj.chat_voice.clips) : null;
      if (cv) sections.chatVoice.clips = cv; else absent.push('chat_voice');
      if (isPlainObject(obj.localStorage)) {
        Object.keys(obj.localStorage).forEach(function (k) {
          if (LS_ALLOW.indexOf(k) !== -1) sections.localStorage[k] = obj.localStorage[k];
          else if (LS_EXCLUDED[k]) warnings.push('未迁移（' + LS_EXCLUDED[k] + '）：' + k);
          else warnings.push('已忽略非白名单键：' + k);
        });
      } else absent.push('localStorage');
    } else {
      // v1：只有房间的 5 张表 + settings + longTermMemory，没有管家、没有本地状态
      const map = { messages: 'messages', keeps: 'keeps', diaries: 'diaries', starDiaries: 'starDiaries', futureLetters: 'futureLetters' };
      let seen = false;
      Object.keys(map).forEach(function (k) {
        const arr = pickArray(obj[k]);
        if (arr) { sections.room[map[k]] = arr; seen = true; }
      });
      if (isPlainObject(obj.settings)) sections.room.kv.settings = obj.settings;
      if (typeof obj.longTermMemory === 'string') sections.room.kv.longTermMemory = obj.longTermMemory;
      if (!seen) warnings.push('旧版备份里没有任何业务表');
      absent.push('star_butler_v1', 'radio_voice', 'localStorage');
    }
    // 语音覆盖说明：v1 导出器会 delete audioData，所以「0 条语音」不能当成「设备上没有语音」
    const msgCount = sections.room.messages.length;
    const withAudio = sections.room.messages.filter(function (m) {
      return typeof m.audioData === 'string' && m.audioData;
    }).length;
    // 语音消息：消息里只存引用，必须逐条核对「引用的录音是不是真在文件里」，
    // 否则导入后会出现一条有记录、点开却没声音的语音。
    const chatClipIds = {};
    sections.chatVoice.clips.forEach(function (c) { if (c && c.id) chatClipIds[c.id] = true; });
    const voiceMsgs = sections.room.messages.filter(function (m) { return m && m.audioClipId; });
    const voiceWithClip = voiceMsgs.filter(function (m) { return chatClipIds[m.audioClipId]; }).length;
    const voiceMissing = voiceMsgs.length - voiceWithClip;
    const audio = {
      messages: msgCount,
      withAudio: withAudio,
      legacyStripped: version === 'v1',
      voiceMessages: voiceMsgs.length,
      voiceWithClip: voiceWithClip,
      voiceMissing: voiceMissing,
    };
    if (version === 'v1') {
      warnings.push('旧版备份导出时会删除语音（audioData）：本次不含旧语音，也不代表原设备没有语音');
    } else if (withAudio === 0 && msgCount > 0) {
      warnings.push('这份备份里没有任何语音数据（导出时未包含，或原设备确实没有语音）');
    }
    if (voiceMissing > 0) {
      warnings.push('有 ' + voiceMissing + ' 条语音消息在备份里找不到对应录音，导入后只能看到转写文字');
    }
    return { version: version, sections: sections, absent: absent, warnings: warnings, audio: audio };
  }

  /** 把 absent 翻译成给人看的缺口说明，用于导入预览「本次不会迁移」一栏。 */
  function describeGaps(normalized) {
    const absent = (normalized && normalized.absent) || [];
    const out = [];
    if (absent.indexOf('star_butler_v1') !== -1) out.push('生活管家（待办 / 账单 / 周期 / 睡眠）未包含');
    if (absent.indexOf('radio_voice') !== -1) out.push('本地声音素材库未包含');
    if (absent.indexOf('localStorage') !== -1) out.push('单词本 / 电台进度 / 游戏进度等本地状态未包含');
    ROOM_STORES.forEach(function (s) {
      if (absent.indexOf('star_fifi_room.' + s) !== -1) out.push('star_fifi_room.' + s + ' 未包含');
    });
    const audio = normalized && normalized.audio;
    if (audio && audio.legacyStripped) out.push('语音（旧版备份导出时被剥离，不能视为已迁移）');
    else if (audio && audio.messages > 0 && audio.withAudio === 0) out.push('语音（该备份中没有语音数据）');
    // 只在「真的引用了录音但文件里没有」时才提示，避免老备份被无端报缺口
    if (audio && audio.voiceMissing > 0) {
      out.push('聊天语音（' + audio.voiceMissing + ' 条语音消息缺少原始录音，导入后只能看到文字）');
    }
    return out;
  }

  /* ---------------- 计数与完整性 ---------------- */

  function countsOf(sections) {
    const sec = sections || {};
    const room = sec.room || {};
    const butler = sec.butler || {};
    const out = {
      room: {},
      butler: {},
      localStorage: Object.keys(sec.localStorage || {}).length,
      radioVoice: (sec.radioVoice && sec.radioVoice.clips || []).length,
      attachments: 0,
      audio: 0,
      attachmentBytes: 0,
    };
    ROOM_STORES.forEach(function (s) { out.room[s] = (room[s] || []).length; });
    // 旧备份没有这个键，就不新增计数字段，避免破坏旧文件的完整性比对。
    if (room.kv && LTM_V2_KEY in room.kv) {
      const v2 = room.kv[LTM_V2_KEY];
      const arr = (v2 && Array.isArray(v2.entries)) ? v2.entries : [];
      out.room.longTermMemoryV2 = {
        entries: arr.length,
        active: arr.filter(function (e) { return e && e.status === 'active'; }).length,
        retracted: arr.filter(function (e) { return e && e.status === 'retracted'; }).length,
        archived: arr.filter(function (e) { return e && e.status === 'archived'; }).length,
        baselineChars: (v2 && typeof v2.baseline === 'string') ? v2.baseline.length : 0,
        valid: !!isLtmV2(v2)
      };
    }
    // 机自述：同样只在键存在时加计数，旧备份的 counts 结构不被改写。
    if (room.kv && SELF_NARRATIVE_KEY in room.kv) {
      const sn = room.kv[SELF_NARRATIVE_KEY];
      const arr = (sn && Array.isArray(sn.records)) ? sn.records : [];
      const historyCount = arr.reduce(function (n, r) {
        return n + ((r && Array.isArray(r.history)) ? r.history.length : 0);
      }, 0);
      out.room.selfNarrative = {
        records: arr.length,
        active: arr.filter(function (r) { return r && r.status === 'active'; }).length,
        retracted: arr.filter(function (r) { return r && r.status === 'retracted'; }).length,
        superseded: arr.filter(function (r) { return r && r.status === 'superseded'; }).length,
        // 历史版本条数：恢复后要能核对「修订历史是不是也在」
        historyVersions: historyCount,
        withSource: arr.filter(function (r) { return r && isPlainObject(r.source); }).length,
        valid: !!isSelfNarrative(sn)
      };
    }
    BUTLER_STORES.forEach(function (s) { out.butler[s] = (butler[s] || []).length; });
    (room.messages || []).forEach(function (m) {
      if (m.image) out.attachments += 1;
      if (m.audioData) out.audio += 1;
    });
    // 聊天语音只在真的有录音时才进 counts：老备份的 counts 里没有这个键，
    // 无条件加键会让「旧文件 + 新代码」在完整性比对时判定不一致。
    const chatClipCount = ((sec.chatVoice && sec.chatVoice.clips) || []).length;
    if (chatClipCount) out.chatVoice = chatClipCount;
    ['keeps', 'diaries', 'starDiaries', 'futureLetters'].forEach(function (s) {
      (room[s] || []).forEach(function (r) { if (r.photo) out.attachments += 1; });
    });
    out.attachments += out.radioVoice;
    // 与 attachmentItems 口径对齐：聊天语音也算附件，否则界面上的「附件数」会比校验结果少
    const items = attachmentItems(sec);
    out.attachments = items.length;
    out.attachmentBytes = items.reduce(function (n, it) { return n + (it.bytes || 0); }, 0);
    return out;
  }

  /** 附件真实原始字节数（dataURL 按 base64 还原后计，声音素材按 blob.bytes 计）。 */
  function attachmentBytesOf(sections) {
    return attachmentItems(sections).reduce(function (n, it) { return n + (it.bytes || 0); }, 0);
  }

  /**
   * 计算完整性：只覆盖「除 integrity 本身以外」的载荷，避免循环依赖。
   * 入参是完整文件对象也可以，内部会先剔除 integrity。
   */
  async function buildIntegrity(fileObj) {
    const payload = {};
    Object.keys(fileObj).forEach(function (k) { if (k !== 'integrity') payload[k] = fileObj[k]; });
    const payloadHash = await sha256Hex(canonicalString(payload));
    const norm = normalizeBackup(fileObj);
    const perStore = {};
    const subs = {
      'star_fifi_room': norm.sections.room,
      'star_butler_v1': norm.sections.butler,
      'localStorage': norm.sections.localStorage,
      'radio_voice': norm.sections.radioVoice,
      'chat_voice': norm.sections.chatVoice,
    };
    for (const name of Object.keys(subs)) {
      perStore[name] = await sha256Hex(canonicalString(subs[name]));
    }
    const att = attachmentReport(norm.sections);
    return {
      algo: ALGO,
      payloadHash: payloadHash,
      bytes: byteLen(canonicalString(payload)),
      counts: countsOf(norm.sections),
      attachmentBytes: att.totalBytes,
      attachmentCount: att.totalCount,
      attachmentByKind: att.byKind,
      perStore: perStore,
      // 附件清单：逐条列出，供回读后核对「是不是每一张图、每一段声音都在」
      attachments: att.items.map(function (it) {
        const o = { at: it.at, kind: it.kind, bytes: it.bytes };
        if (it.sha256) o.sha256 = it.sha256;
        if (it.missing) o.missing = true;
        if (it.external) o.external = true;
        return o;
      }),
    };
  }

  /** 校验文件自洽性。返回 { ok, reason, detail }，任何不一致都不得开始写入。 */
  async function verifyIntegrity(fileObj, opts) {
    const options = opts || {};
    if (detectVersion(fileObj) !== 'v2') return { ok: false, reason: 'unsupported-version' };
    const it = fileObj.integrity;
    if (!isPlainObject(it) || typeof it.payloadHash !== 'string') return { ok: false, reason: 'missing-integrity' };
    const recomputed = await buildIntegrity(fileObj);
    if (recomputed.payloadHash !== it.payloadHash) {
      return { ok: false, reason: 'payload-hash-mismatch', detail: { expect: it.payloadHash, actual: recomputed.payloadHash } };
    }
    if (isPlainObject(it.counts) && canonicalString(it.counts) !== canonicalString(recomputed.counts)) {
      return { ok: false, reason: 'counts-mismatch', detail: { expect: it.counts, actual: recomputed.counts } };
    }
    if (it.attachmentCount != null && it.attachmentCount !== recomputed.attachmentCount) {
      return { ok: false, reason: 'attachment-count-mismatch', detail: { expect: it.attachmentCount, actual: recomputed.attachmentCount } };
    }
    if (it.attachmentBytes != null && it.attachmentBytes !== recomputed.attachmentBytes) {
      return { ok: false, reason: 'attachment-bytes-mismatch', detail: { expect: it.attachmentBytes, actual: recomputed.attachmentBytes } };
    }
    for (const name of Object.keys(it.perStore || {})) {
      if (recomputed.perStore[name] !== it.perStore[name]) {
        return { ok: false, reason: 'store-hash-mismatch', detail: { store: name } };
      }
    }
    if (options.checkAttachments !== false) {
      for (const c of (fileObj.radio_voice && fileObj.radio_voice.clips) || []) {
        if (!isPlainObject(c.blob)) continue;
        const r = await verifyAttachment(c.blob);
        if (!r.ok) return { ok: false, reason: 'attachment-broken', detail: { id: c.id, why: r.reason } };
      }
      for (const c of (fileObj.chat_voice && fileObj.chat_voice.clips) || []) {
        if (!isPlainObject(c.blob)) continue;
        const r = await verifyAttachment(c.blob);
        if (!r.ok) return { ok: false, reason: 'attachment-broken', detail: { id: c.id, why: r.reason } };
      }
    }
    return { ok: true, integrity: recomputed };
  }

  /* ---------------- 合并计划 ---------------- */

  function sameValue(a, b) {
    if (a === b) return true;
    if (typeof a === 'number' && typeof b === 'number') return a === b;
    return canonicalString(a) === canonicalString(b);
  }

  function messageIdentity(a, b) {
    return sameValue(a.role, b.role) && sameValue(a.time, b.time)
      && sameValue(a.content, b.content) && sameValue(a.englishContent || '', b.englishContent || '')
      // 附件与沉默状态也是「内容」：同 id 同文字但图片/语音/沉默不同，不能算同一条
      && sameValue(a.image || null, b.image || null)
      && sameValue(a.audioData || null, b.audioData || null)
      && sameValue(a.audioClipId || null, b.audioClipId || null)
      && sameValue(a.durationMs || 0, b.durationMs || 0)
      && sameValue(a.type || null, b.type || null)
      && sameValue(!!a.silent, !!b.silent)
      && sameValue(a.silentReason || null, b.silentReason || null);
  }

  function recordIdentity(store, a, b) {
    if (store === 'messages') return messageIdentity(a, b);
    // meta 是 {key, value, updatedAt}：key 相同但 value 不同不算同一条
    if (store === 'meta') return sameValue(a.key, b.key) && sameValue(a.value, b.value);
    // 声音素材：字节哈希优先，没有再退回元数据（旧记录可能没有 sha256）
    if (store === 'clips') {
      const ha = a.blob && a.blob.sha256;
      const hb = b.blob && b.blob.sha256;
      if (ha && hb) return ha === hb;
      return sameValue(a.name, b.name) && sameValue(a.size, b.size) && sameValue(a.createdAt, b.createdAt);
    }
    return sameValue(a.title, b.title) && sameValue(a.content, b.content) && sameValue(a.createdAt, b.createdAt);
  }

  /** 同步内容指纹（FNV-1a 双通道 + 长度）：给跳过项留一个可进 planHash 的摘要。 */
  function syncDigest(str) {
    const s = String(str);
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = ((h1 ^ c) * 16777619) >>> 0;
      h2 = ((h2 + Math.imul(c, i + 1)) >>> 0) >>> 0;
    }
    return ('0000000' + h1.toString(16)).slice(-8) + ('0000000' + h2.toString(16)).slice(-8) + ':' + s.length;
  }

  /** 参与 planHash 的记录形态：去掉 base64 本体，保留字节数与 sha256（等价且不必哈希 80 MB 文本）。 */
  function hashableRecord(r) {
    const c = sortedClone(r);
    if (isPlainObject(c.blob)) delete c.blob.base64;
    return c;
  }

  function maxNumericId(list) {
    let max = 0;
    list.forEach(function (r) { if (typeof r.id === 'number' && r.id > max) max = r.id; });
    return max;
  }

  function sortById(list) {
    return list.slice().sort(function (a, b) {
      const x = a.id == null ? Infinity : a.id;
      const y = b.id == null ? Infinity : b.id;
      if (typeof x === 'number' && typeof y === 'number') return x - y;
      return String(x).localeCompare(String(y));
    });
  }

  /** 便宜的匹配键：只用来缩小「内容可能相同」的候选范围，最终仍由 recordIdentity 判定。 */
  function cheapKey(store, r) {
    if (store === 'messages') {
      return [r.role, r.time, r.content, r.englishContent || '', (r.image || '').length,
        (r.audioData || '').length, r.audioClipId || '', r.silent ? 1 : 0, r.silentReason || ''].join('\u0001');
    }
    if (store === 'clips') return [r.name, r.size, r.createdAt].join('\u0001');
    if (store === 'meta') return String(r.key);
    return [r.title, r.createdAt, (r.content || '').length, (r.photo || '').length].join('\u0001');
  }

  /**
   * 单个 store 的合并计划。
   * 身份规则：id 是身份；只有「同 id + 同内容」才算同一条。
   * 「不同 id + 同文同秒」视为两条独立消息，绝不合并。
   */
  function planStore(store, targetList, backupList, mode) {
    const res = { inserts: [], upserts: [], skips: [], conflicts: [], idMap: {}, nextId: maxNumericId(targetList) + 1 };
    const keyOf = store === 'meta' ? function (r) { return r.key; } : function (r) { return r.id; };
    const targetByKey = new Map();
    targetList.forEach(function (r) { const k = keyOf(r); if (k != null) targetByKey.set(k, r); });

    if (mode === 'replace') {
      res.inserts = backupList.map(function (r) { return Object.assign({}, r); });
      res.clear = true;
      return res;
    }

    // 「同 id 不同内容」时，还要判断是不是上次导入把这条换过 id 写进来的：
    // 是的话就跳过，否则同一份备份导入两次会把冲突记录复制成两份。
    const backupIds = new Set();
    backupList.forEach(function (r) { const k = keyOf(r); if (k != null) backupIds.add(k); });
    let loose = null;
    function looseIndex() {
      if (loose) return loose;
      loose = new Map();
      targetList.forEach(function (r) {
        const k = keyOf(r);
        if (k != null && backupIds.has(k)) return;
        const ck = cheapKey(store, r);
        const arr = loose.get(ck) || [];
        arr.push(r);
        loose.set(ck, arr);
      });
      return loose;
    }

    sortById(backupList).forEach(function (rec) {
      const key = keyOf(rec);
      if (key != null && targetByKey.has(key)) {
        const t = targetByKey.get(key);
        if (recordIdentity(store, t, rec)) {
          res.skips.push({ id: key, reason: 'identical', h: syncDigest(canonicalString(hashableRecord(rec))) });
          return;
        }
        if (mode === 'skip-existing') {
          res.skips.push({ id: key, reason: 'exists', h: syncDigest(canonicalString(hashableRecord(rec))) });
          return;
        }
        // meta 的 keyPath 就是 key，不能重分配 id；只能按键覆盖，并明确记一笔
        if (store === 'meta') {
          res.upserts.push(Object.assign({}, rec));
          res.conflicts.push({ key: key, action: 'overwrite' });
          return;
        }
        // 上次导入已经把这同一条写成了别的 id：算已导入，不重复插入
        const cands = looseIndex().get(cheapKey(store, rec)) || [];
        for (let i = 0; i < cands.length; i++) {
          if (recordIdentity(store, cands[i], rec)) {
            res.skips.push({ id: key, at: cands[i].id, reason: 'already-imported', h: syncDigest(canonicalString(hashableRecord(rec))) });
            return;
          }
        }
        // 同 id 不同内容：换新 id，并登记映射，供引用字段改写
        const newId = res.nextId++;
        res.idMap[key] = newId;
        res.inserts.push(Object.assign({}, rec, { id: newId }));
        res.conflicts.push({ id: key, newId: newId });
        return;
      }
      if (key == null) {
        res.inserts.push(Object.assign({}, rec, { id: res.nextId++ }));
        return;
      }
      res.inserts.push(Object.assign({}, rec));
    });
    return res;
  }

  // 所有可能指向 messages.id 的字段（与 app.js 实际写法一一对应）
  // keeps.sourceMessageId（珍藏来自哪条消息）、diaries.replyMessageId / futureLetters.replyMessageId（回信消息）
  const REF_FIELDS = {
    keeps: ['sourceMessageId'],
    diaries: ['replyMessageId'],
    futureLetters: ['replyMessageId'],
    starDiaries: [],
  };

  // 反向引用：消息本身也可能回指日记 / 未来的信（app.js 里 sourceId = 对方 id）
  const REVERSE_REF = { 'today-letter': 'diaries', 'future-letter': 'futureLetters' };

  /**
   * 单条记录的引用改写：
   * 1) 目标消息被换了 id → 跟着换；
   * 2) 目标消息确实存在 → 原样保留；
   * 3) 目标消息在导入后不存在 → 置 null 并上报，绝不让它继续指向别人。
   */
  function remapRecord(store, rec, idMap, validIds) {
    const fields = REF_FIELDS[store] || [];
    let copy = rec;
    let remaps = 0;
    const orphans = [];
    fields.forEach(function (f) {
      const v = rec[f];
      if (v == null) return;
      if (idMap && idMap[v] != null) {
        if (copy === rec) copy = Object.assign({}, rec);
        copy[f] = idMap[v];
        remaps += 1;
        return;
      }
      if (validIds && !validIds.has(v)) {
        if (copy === rec) copy = Object.assign({}, rec);
        copy[f] = null;
        orphans.push(f);
      }
    });
    return { rec: copy, remaps: remaps, orphans: orphans };
  }

  /** 批量改写某个 store 的引用字段。 */
  function remapRefs(store, records, idMap, validIds) {
    return (records || []).map(function (r) { return remapRecord(store, r, idMap, validIds).rec; });
  }

  /**
   * 长期记忆 v2 的导入策略（单例，不能走 planStore）。
   * 返回 { state, action, decisions, warnings }；state=null 表示本次不写 v2。
   * - replace：用备份整体替换 v2（旧 longTermMemory 键仍不碰）；
   * - merge：按 id 合并；同 id 取 updatedAt 较新者；时间相同保留目标；
   *          用户手动条目优先；同来源不同 id 视为重复来源，保留目标；
   *          baseline 目标非空则保留（不整体覆盖），目标为空才采纳备份；
   * - skip-existing：目标已有合法 v2 时跳过；
   * - 版本不兼容 / 结构不合法 / 目标损坏：跳过并写警告，绝不半截覆盖。
   * 整个过程无 Date.now()，保证 planHash 确定性。
   */
  function mergeLtmV2(targetV2, backupV2, mode) {
    var out = { state: null, action: 'skip', decisions: [], warnings: [] };
    if (!isLtmV2(backupV2)) {
      out.decisions.push({ action: 'skip', reason: 'backup-v2-invalid-or-absent' });
      return out;
    }
    var clone = function (v) { return JSON.parse(JSON.stringify(v)); };
    if (mode === 'replace') {
      out.state = clone(backupV2);
      out.action = 'replace';
      out.decisions.push({ action: 'replace', reason: 'explicit-replace-mode' });
      return out;
    }
    var targetValid = isLtmV2(targetV2);
    if (targetV2 != null && !targetValid) {
      out.action = 'skip';
      out.decisions.push({ action: 'skip', reason: 'target-v2-invalid-kept' });
      out.warnings.push('目标机长期记忆 v2 结构不合法，本次跳过 v2 导入；现有数据原样保留');
      return out;
    }
    if (mode === 'skip-existing' && targetValid) {
      out.decisions.push({ action: 'skip', reason: 'skip-existing' });
      return out;
    }
    if (!targetValid) {
      out.state = clone(backupV2);
      out.action = 'adopt';
      out.decisions.push({ action: 'adopt', reason: 'target-v2-absent' });
      return out;
    }

    var base = clone(targetV2);
    var byId = {}, bySource = {};
    base.entries.forEach(function (e, i) {
      byId[e.id] = i;
      if (e.source && e.source.sourceId) bySource[e.source.sourceId] = i;
    });
    backupV2.entries.forEach(function (be) {
      if (byId[be.id] != null) {
        var te = base.entries[byId[be.id]];
        if (te.source && te.source.manual === true && !(be.source && be.source.manual === true)) {
          out.decisions.push({ id: be.id, action: 'keep-target', reason: 'manual-priority' });
          return;
        }
        var tt = typeof te.updatedAt === 'number' ? te.updatedAt : 0;
        var bt = typeof be.updatedAt === 'number' ? be.updatedAt : 0;
        if (bt > tt) {
          base.entries[byId[be.id]] = clone(be);
          out.decisions.push({ id: be.id, action: 'take-backup', reason: 'newer' });
        } else {
          out.decisions.push({ id: be.id, action: 'keep-target', reason: bt === tt ? 'same-time' : 'target-newer' });
        }
        return;
      }
      var sid = be.source && be.source.sourceId;
      if (sid && bySource[sid] != null) {
        out.decisions.push({ id: be.id, action: 'skip', reason: 'duplicate-source', sourceId: sid });
        return;
      }
      base.entries.push(clone(be));
      byId[be.id] = base.entries.length - 1;
      if (sid) bySource[sid] = base.entries.length - 1;
      out.decisions.push({ id: be.id, action: 'insert', reason: 'new-id' });
    });
    if (!base.baseline && backupV2.baseline) {
      base.baseline = backupV2.baseline;
      out.decisions.push({ action: 'adopt-baseline', reason: 'target-baseline-empty' });
    } else if (base.baseline && backupV2.baseline && base.baseline !== backupV2.baseline) {
      out.decisions.push({ action: 'keep-target-baseline', reason: 'conflict' });
    }
    base.updatedAt = Math.max(
      typeof base.updatedAt === 'number' ? base.updatedAt : 0,
      typeof backupV2.updatedAt === 'number' ? backupV2.updatedAt : 0
    );
    out.state = base;
    out.action = 'merge';
    return out;
  }

  /** 历史版本合并：取并集去重后按时间排序，绝不因为「备份较新」就丢掉目标机上的旧版本。 */
  function mergeSelfHistory(a, b) {
    const seen = {};
    const all = [];
    (Array.isArray(a) ? a : []).concat(Array.isArray(b) ? b : []).forEach(function (v) {
      const key = canonicalString(v);
      if (seen[key]) return;
      seen[key] = true;
      all.push(v);
    });
    all.sort(function (x, y) { return (x.at || 0) - (y.at || 0); });
    return all;
  }

  /**
   * 机自述来源消息 ID 映射：导入时消息 id 若被重分配，来源必须跟着走。
   *
   * 只改 source.messageId，且只在 idMap 里真实存在这条映射时才改：
   *   - 数字 id 与字符串 id 统一按字符串键比对，避免 '12' 与 12 匹配失败；
   *     命中映射后写回数字（与 messages 主键类型一致）。
   *   - 映射表里没有的引用一律原样保留：不猜测、不置空、不模糊匹配。
   *   - history 里每个版本快照的 source 也一并改写，否则旧版本仍指向重分配前的 id。
   *   - evidence[] 里每条 messageId 同样改写（当前记录与 history 快照都改），
   *     否则恢复后证据链指向重分配前的旧 id。
   *   - 计数器按「引用处数」累计：同一条记录里 source 与 evidence 各算一处。
   *   - 正文、状态、revisedFrom / supersededBy、其他来源字段、历史顺序全部不动。
   *
   * 来源是否成立，证据只能来自「备份侧」，不能拿目标库的同 id 消息凑数：
   *   - remapped    备份里有这条消息，id 被重分配 → 已改写为新 id；
   *   - unchanged   备份里有这条消息，id 未变 → 原值就是目标值；
   *   - unconfirmed 备份里有这条消息，但落到导入后的哪个 id 无法确认
   *                 （skip-existing 留了目标机同 id 的另一条 / already-imported 早先换了 id 却没登记映射）；
   *   - unresolved  备份里根本没有这条消息 → 无从验证，目标机恰好有同 id 的另一条也不算数。
   * 后两种一律保留原始 messageId，只计数，绝不改值。
   *
   * evidence：{ backupIds, roomIds, skipped }
   *   backupIds 备份侧 messages 的 id 集合（字符串归一）；缺省时只做映射、不做来源判断。
   *   roomIds   导入后房间里存在的 messages id 集合，仅用于确认映射目标是否真的落地。
   *   skipped   备份消息 id → 跳过原因（identical / exists / already-imported）。
   * 返回 { state, remapped, unchanged, unconfirmed, unresolved }；state 无需改写时就是入参本身。
   */
  function remapSelfNarrativeSources(sn, idMap, evidence) {
    const out = { state: sn, remapped: 0, unchanged: 0, unconfirmed: 0, unresolved: 0 };
    if (!isSelfNarrative(sn)) return out;

    const ev = isPlainObject(evidence) ? evidence : {};
    const map = isPlainObject(idMap) ? idMap : {};
    const has = function (k) { return Object.prototype.hasOwnProperty.call(map, k); };
    const backupIds = ev.backupIds instanceof Set ? ev.backupIds : null;
    const roomIds = ev.roomIds instanceof Set ? ev.roomIds : null;
    const skipped = ev.skipped instanceof Map ? ev.skipped : null;
    // id 可能是数字或字符串：三个集合都按「原值 / 字符串 / 数字」三种写法探一次
    const inSet = function (set, v) {
      return !!set && (set.has(v) || set.has(String(v)) || set.has(Number(v)));
    };

    function remapSource(src) {
      if (!isPlainObject(src) || src.messageId == null) return src;
      const key = String(src.messageId);

      if (has(key)) {
        const target = map[key];
        // 映射目标必须真的落在导入后的房间里；落不了地就不改，免得把悬空换成另一个悬空
        if (roomIds && !inSet(roomIds, target)) {
          out.unconfirmed += 1;
          return src;
        }
        out.remapped += 1;
        const copy = Object.assign({}, src);
        copy.messageId = target;
        return copy;
      }

      // 没有备份侧证据时只做映射，不判断来源真伪（避免用目标库的 id 冒充证据）
      if (!backupIds) return src;

      if (!inSet(backupIds, src.messageId)) {
        out.unresolved += 1;
        return src;
      }

      const reason = skipped ? skipped.get(key) : null;
      if (reason === 'exists' || reason === 'already-imported') out.unconfirmed += 1;
      else out.unchanged += 1;
      return src;
    }

    // evidence 里每条 messageId 与 source.messageId 同等对待：同一套映射、同一套计数规则。
    function remapEvidence(list) {
      if (!Array.isArray(list) || !list.length) return list;
      let touched = false;
      const next = list.map(function (e) {
        if (!isPlainObject(e) || e.messageId == null) return e;
        const key = String(e.messageId);

        if (has(key)) {
          const target = map[key];
          if (roomIds && !inSet(roomIds, target)) { out.unconfirmed += 1; return e; }
          out.remapped += 1;
          touched = true;
          return Object.assign({}, e, { messageId: target });
        }

        if (!backupIds) return e;
        if (!inSet(backupIds, e.messageId)) { out.unresolved += 1; return e; }

        const reason = skipped ? skipped.get(key) : null;
        if (reason === 'exists' || reason === 'already-imported') out.unconfirmed += 1;
        else out.unchanged += 1;
        return e;
      });
      return touched ? next : list;
    }

    function remapOne(rec) {
      let next = rec;
      const src = remapSource(rec.source);
      if (src !== rec.source) next = Object.assign({}, rec, { source: src });

      const evs = remapEvidence(rec.evidence);
      if (evs !== rec.evidence) {
        if (next === rec) next = Object.assign({}, rec);
        next.evidence = evs;
      }

      if (Array.isArray(rec.history) && rec.history.length) {
        let touched = false;
        const hist = rec.history.map(function (v) {
          if (!isPlainObject(v)) return v;
          const s = remapSource(v.source);
          const ev = remapEvidence(v.evidence);
          if (s === v.source && ev === v.evidence) return v;
          touched = true;
          const nextV = Object.assign({}, v);
          if (s !== v.source) nextV.source = s;
          if (ev !== v.evidence) nextV.evidence = ev;
          return nextV;
        });
        if (touched) {
          if (next === rec) next = Object.assign({}, rec);
          next.history = hist;
        }
      }
      return next;
    }

    let changed = false;
    const records = sn.records.map(function (r) {
      const next = remapOne(r);
      if (next !== r) changed = true;
      return next;
    });
    if (changed) {
      out.state = Object.assign({}, sn, { records: records });
    }
    return out;
  }

  /**
   * 机自述合并计划：
   *   - merge 按记录 id 合并，同 id 取 updatedAt 较新的一份，但历史版本取并集；
   *   - 撤回状态、来源信息随记录原样搬运，不做任何「修复」；
   *   - 目标机键存在但不合法时整块跳过，绝不覆盖。
   */
  function mergeSelfNarrative(targetSn, backupSn, mode) {
    const out = { state: null, action: 'skip', decisions: [], warnings: [] };
    if (!isSelfNarrative(backupSn)) {
      out.decisions.push({ action: 'skip', reason: 'backup-self-narrative-invalid-or-absent' });
      return out;
    }
    const clone = function (v) { return JSON.parse(JSON.stringify(v)); };
    if (mode === 'replace') {
      out.state = clone(backupSn);
      out.action = 'replace';
      out.decisions.push({ action: 'replace', reason: 'explicit-replace-mode' });
      return out;
    }
    const targetValid = isSelfNarrative(targetSn);
    if (targetSn != null && !targetValid) {
      out.decisions.push({ action: 'skip', reason: 'target-self-narrative-invalid-kept' });
      out.warnings.push('目标机机自述结构不合法，本次跳过该分区；现有记录原样保留');
      return out;
    }
    if (mode === 'skip-existing' && targetValid) {
      out.decisions.push({ action: 'skip', reason: 'skip-existing' });
      return out;
    }
    if (!targetValid) {
      out.state = clone(backupSn);
      out.action = 'adopt';
      out.decisions.push({ action: 'adopt', reason: 'target-self-narrative-absent' });
      return out;
    }

    const base = clone(targetSn);
    const idx = {};
    base.records.forEach(function (r, i) { idx[r.id] = i; });
    backupSn.records.forEach(function (br) {
      if (idx[br.id] == null) {
        base.records.push(clone(br));
        idx[br.id] = base.records.length - 1;
        out.decisions.push({ id: br.id, action: 'insert', reason: 'new-id' });
        return;
      }
      const tr = base.records[idx[br.id]];
      const tt = typeof tr.updatedAt === 'number' ? tr.updatedAt : 0;
      const bt = typeof br.updatedAt === 'number' ? br.updatedAt : 0;
      const chosen = bt > tt ? clone(br) : clone(tr);
      // 历史版本取并集：两条链上的旧版本都留下，恢复后仍能追溯修订过程。
      chosen.history = mergeSelfHistory(tr.history, br.history);
      base.records[idx[br.id]] = chosen;
      out.decisions.push({
        id: br.id,
        action: bt > tt ? 'take-backup' : 'keep-target',
        reason: bt === tt ? 'same-time' : (bt > tt ? 'newer' : 'target-newer')
      });
    });
    base.updatedAt = Math.max(
      typeof base.updatedAt === 'number' ? base.updatedAt : 0,
      typeof backupSn.updatedAt === 'number' ? backupSn.updatedAt : 0
    );
    out.state = base;
    out.action = 'merge';
    return out;
  }

  /**
   * 生成完整导入计划（确定性：同样的输入必得同样的 idMap）。
   * target / backup 均为 normalizeBackup 的 sections 结构。
   */
  function buildPlan(input) {
    const mode = input.mode || 'merge';
    const target = input.target;
    const backup = input.backup;
    const plan = {
      mode: mode,
      room: {}, butler: {}, radioVoice: {}, chatVoice: {}, localStorage: { set: {}, skip: [] },
      stats: { insert: 0, upsert: 0, skip: 0, conflict: 0, remap: 0, orphan: 0 },
      idMap: {},
      orphans: [],
      warnings: [],
    };
    ROOM_STORES.forEach(function (s) {
      const p = planStore(s, target.room[s] || [], backup.room[s] || [], mode);
      plan.room[s] = p;
      plan.stats.insert += p.inserts.length;
      plan.stats.upsert += p.upserts.length;
      plan.stats.skip += p.skips.length;
      plan.stats.conflict += p.conflicts.length;
      plan.idMap[s] = p.idMap;
    });
    BUTLER_STORES.forEach(function (s) {
      const p = planStore(s, target.butler[s] || [], backup.butler[s] || [], mode);
      plan.butler[s] = p;
      plan.stats.insert += p.inserts.length;
      plan.stats.upsert += p.upserts.length;
      plan.stats.skip += p.skips.length;
      plan.stats.conflict += p.conflicts.length;
    });
    const rv = planStore('clips', target.radioVoice.clips || [], backup.radioVoice.clips || [], mode);
    plan.radioVoice = rv;
    plan.stats.insert += rv.inserts.length;
    plan.stats.skip += rv.skips.length;
    plan.stats.conflict += rv.conflicts.length;

    // 聊天语音：和声音素材同一套 clip 合并规则（字节哈希优先），但独立成区，不会串到素材库里
    const cv = planStore('clips',
      (target.chatVoice && target.chatVoice.clips) || [],
      (backup.chatVoice && backup.chatVoice.clips) || [],
      mode);
    plan.chatVoice = cv;
    plan.stats.insert += cv.inserts.length;
    plan.stats.skip += cv.skips.length;
    plan.stats.conflict += cv.conflicts.length;

    // 引用改写 + 孤儿检测
    const msgMap = plan.idMap.messages || {};
    const roomIds = new Set();
    if (mode === 'replace') {
      // 替换模式下旧消息会被清空，只有本次写入的消息才算「存在」
      (plan.room.messages.inserts || []).forEach(function (m) { roomIds.add(m.id); });
    } else {
      (target.room.messages || []).forEach(function (m) { roomIds.add(m.id); });
      (plan.room.messages.inserts || []).forEach(function (m) { roomIds.add(m.id); });
    }
    // 机自述来源的「证据集」：备份侧到底有没有这条消息，以及它是被怎么跳过的。
    // 只看备份侧——目标库恰好有同 id 的消息，不能证明来源真实存在。
    const backupMsgIds = new Set();
    (backup.room.messages || []).forEach(function (m) {
      if (m && m.id != null) backupMsgIds.add(String(m.id));
    });
    const msgSkipReasons = new Map();
    (plan.room.messages.skips || []).forEach(function (s) {
      if (s && s.id != null) msgSkipReasons.set(String(s.id), s.reason);
    });
    ['keeps', 'diaries', 'futureLetters'].forEach(function (s) {
      plan.room[s].inserts = plan.room[s].inserts.map(function (r) {
        const out = remapRecord(s, r, msgMap, roomIds);
        plan.stats.remap += out.remaps;
        if (out.orphans.length) {
          plan.stats.orphan += out.orphans.length;
          plan.orphans.push({ store: s, id: r.id, fields: out.orphans.slice() });
        }
        return out.rec;
      });
    });

    // 反向引用：messages.source = 'today-letter' / 'future-letter' 时，sourceId 指向对方表
    const reverseIds = {
      'today-letter': new Set(),
      'future-letter': new Set(),
    };
    ['today-letter', 'future-letter'].forEach(function (src) {
      const store = REVERSE_REF[src];
      if (mode !== 'replace') (target.room[store] || []).forEach(function (r) { reverseIds[src].add(r.id); });
      (plan.room[store].inserts || []).forEach(function (r) { reverseIds[src].add(r.id); });
    });
    plan.room.messages.inserts = plan.room.messages.inserts.map(function (m) {
      const src = m.source;
      if (!REVERSE_REF[src] || m.sourceId == null) return m;
      const map = plan.idMap[REVERSE_REF[src]] || {};
      if (map[m.sourceId] != null) {
        plan.stats.remap += 1;
        return Object.assign({}, m, { sourceId: map[m.sourceId] });
      }
      if (!reverseIds[src].has(m.sourceId)) {
        plan.stats.orphan += 1;
        plan.orphans.push({ store: 'messages', id: m.id, fields: ['sourceId'] });
        return Object.assign({}, m, { sourceId: null });
      }
      return m;
    });

    Object.keys(backup.localStorage || {}).forEach(function (k) {
      const exists = input.targetLocalHas && input.targetLocalHas[k];
      if (mode === 'skip-existing' && exists) plan.localStorage.skip.push(k);
      else plan.localStorage.set[k] = backup.localStorage[k];
    });

    plan.stats.localStorage = Object.keys(plan.localStorage.set).length;

    // 设置与长期记忆是单例，不能走 planStore：键名固定，只能整体覆盖或跳过。
    // merge：设置按键合并（备份优先，保留目标机独有的键）；长期记忆非空则采用备份的。
    const kvTarget = (target.room && target.room.kv) || {};
    const kvBackup = (backup.room && backup.room.kv) || {};
    const kvSet = {};
    if (isPlainObject(kvBackup.settings)) {
      if (mode === 'replace') kvSet.settings = kvBackup.settings;
      else if (mode === 'skip-existing') {
        if (!isPlainObject(kvTarget.settings)) kvSet.settings = kvBackup.settings;
      } else {
        kvSet.settings = Object.assign({}, isPlainObject(kvTarget.settings) ? kvTarget.settings : {}, kvBackup.settings);
      }
    }
    if (typeof kvBackup.longTermMemory === 'string' && kvBackup.longTermMemory) {
      if (mode === 'replace' || mode === 'merge') kvSet.longTermMemory = kvBackup.longTermMemory;
      else if (!kvTarget.longTermMemory) kvSet.longTermMemory = kvBackup.longTermMemory;
    }
    // 长期记忆 v2：独立 bucket，baseline / entries / source / history 整体随备份走；
    // merge 按条目合并，绝不是拿备份整体覆盖。
    var v2 = mergeLtmV2(kvTarget[LTM_V2_KEY], kvBackup[LTM_V2_KEY], mode);
    if (v2.state) kvSet[LTM_V2_KEY] = v2.state;
    plan.v2 = { action: v2.action, decisions: v2.decisions, warnings: v2.warnings };
    if (v2.warnings.length) plan.warnings = plan.warnings.concat(v2.warnings);
    // 机自述：独立 bucket，records / history / source / status 整体随备份走；merge 按记录合并。
    // 来源消息 id 先按本次真实生成的 messages 映射改写「备份侧」记录，再合并：
    //   目标机自有记录指向的是目标机自己的消息，绝不能被备份的映射改掉。
    var snBackup = remapSelfNarrativeSources(kvBackup[SELF_NARRATIVE_KEY], plan.idMap.messages, {
      backupIds: backupMsgIds,
      roomIds: roomIds,
      skipped: msgSkipReasons
    });
    var sn = mergeSelfNarrative(kvTarget[SELF_NARRATIVE_KEY], snBackup.state, mode);
    if (sn.state) kvSet[SELF_NARRATIVE_KEY] = sn.state;
    plan.selfNarrative = {
      action: sn.action,
      decisions: sn.decisions,
      warnings: sn.warnings,
      remapped: sn.state ? snBackup.remapped : 0,
      unchanged: sn.state ? snBackup.unchanged : 0,
      unconfirmed: sn.state ? snBackup.unconfirmed : 0,
      unresolved: sn.state ? snBackup.unresolved : 0
    };
    if (sn.warnings.length) plan.warnings = plan.warnings.concat(sn.warnings);
    plan.kvSet = kvSet;
    return plan;
  }

  /**
   * planHash 用于「恢复时确认拿的是同一份计划」。
   * 因此必须覆盖影响结果的全部信息：模式、每个 store 的写入内容（不只是 id）、
   * 跳过/冲突明细、引用映射、localStorage 的键与值。
   */
  function storeDoc(p) {
    // 记录用 hashableRecord：保留附件字节数与 sha256，去掉 base64 本体
    const canon = function (list) { return canonicalString((list || []).map(hashableRecord)); };
    return {
      clear: !!p.clear,
      inserts: canon(p.inserts),
      upserts: canon(p.upserts),
      skips: (p.skips || []).map(function (s) {
        return [String(s.id != null ? s.id : s.key), s.reason || '', s.h || ''];
      }).sort(),
      conflicts: (p.conflicts || []).map(function (c) {
        return [String(c.id != null ? c.id : c.key), c.newId == null ? null : c.newId, c.action || 'reassign'];
      }),
    };
  }

  async function planHashOf(plan) {
    const set = (plan.localStorage && plan.localStorage.set) || {};
    const doc = {
      mode: plan.mode,
      room: ROOM_STORES.reduce(function (o, s) { o[s] = storeDoc(plan.room[s] || {}); return o; }, {}),
      butler: BUTLER_STORES.reduce(function (o, s) { o[s] = storeDoc(plan.butler[s] || {}); return o; }, {}),
      radioVoice: storeDoc(plan.radioVoice || {}),
      chatVoice: storeDoc(plan.chatVoice || {}),
      localStorage: Object.keys(set).sort().map(function (k) { return [k, set[k]]; }),
      localStorageSkip: ((plan.localStorage && plan.localStorage.skip) || []).slice().sort(),
      kv: plan.kvSet || {},
      v2: plan.v2 || null,
      selfNarrative: plan.selfNarrative || null,
      idMap: plan.idMap,
    };
    return sha256Hex(canonicalString(doc));
  }

  function summarize(plan) {
    return {
      mode: plan.mode,
      insert: plan.stats.insert,
      upsert: plan.stats.upsert,
      skip: plan.stats.skip,
      conflict: plan.stats.conflict,
      remap: plan.stats.remap,
      orphan: plan.stats.orphan,
      localStorage: plan.stats.localStorage,
      kv: Object.keys(plan.kvSet || {}),
      longTermMemoryV2: plan.v2 ? {
        action: plan.v2.action,
        decisions: plan.v2.decisions.length,
        warnings: plan.v2.warnings.length
      } : null,
      selfNarrative: plan.selfNarrative ? {
        action: plan.selfNarrative.action,
        decisions: plan.selfNarrative.decisions.length,
        warnings: plan.selfNarrative.warnings.length,
        // 来源消息 id 跟随重分配的条数；id 未变的条数；
        // 备份里没有这条消息（无从验证）的条数；备份里有但落地 id 无法确认的条数
        remapped: plan.selfNarrative.remapped || 0,
        unchanged: plan.selfNarrative.unchanged || 0,
        unconfirmed: plan.selfNarrative.unconfirmed || 0,
        unresolved: plan.selfNarrative.unresolved || 0
      } : null,
      willClear: plan.mode === 'replace',
      conflicts: (plan.room.messages || {}).conflicts || [],
      orphans: plan.orphans || [],
    };
  }

  const API = {
    FORMAT: FORMAT,
    VERSION: VERSION,
    MIN_APP: MIN_APP,
    ROOM_STORES: ROOM_STORES,
    BUTLER_STORES: BUTLER_STORES,
    LTM_V2_KEY: LTM_V2_KEY,
    LTM_V2_SCHEMA: LTM_V2_SCHEMA,
    SELF_NARRATIVE_KEY: SELF_NARRATIVE_KEY,
    SELF_NARRATIVE_SCHEMA: SELF_NARRATIVE_SCHEMA,
    SELF_NARRATIVE_STATUS: SELF_NARRATIVE_STATUS.slice(),
    isLtmV2: isLtmV2,
    isSelfNarrative: isSelfNarrative,
    isSelfVersion: isSelfVersion,
    mergeLtmV2: mergeLtmV2,
    mergeSelfNarrative: mergeSelfNarrative,
    mergeSelfHistory: mergeSelfHistory,
    remapSelfNarrativeSources: remapSelfNarrativeSources,
    LS_ALLOW: LS_ALLOW,
    LS_EXCLUDED: LS_EXCLUDED,
    ATTACH_LIMITS: ATTACH_LIMITS,
    REF_FIELDS: REF_FIELDS,
    REVERSE_REF: REVERSE_REF,
    syncDigest: syncDigest,
    hashableRecord: hashableRecord,
    sortedClone: sortedClone,
    canonicalString: canonicalString,
    sha256Hex: sha256Hex,
    sha256Bytes: sha256Bytes,
    bytesToBase64: bytesToBase64,
    base64ToBytes: base64ToBytes,
    encodeBinary: encodeBinary,
    decodeBinary: decodeBinary,
    verifyAttachment: verifyAttachment,
    dataUrlInfo: dataUrlInfo,
    dataUrlByteLength: dataUrlByteLength,
    attachmentItems: attachmentItems,
    attachmentReport: attachmentReport,
    checkAttachmentBudget: checkAttachmentBudget,
    detectVersion: detectVersion,
    normalizeBackup: normalizeBackup,
    describeGaps: describeGaps,
    countsOf: countsOf,
    attachmentBytesOf: attachmentBytesOf,
    buildIntegrity: buildIntegrity,
    verifyIntegrity: verifyIntegrity,
    buildPlan: buildPlan,
    planHashOf: planHashOf,
    summarize: summarize,
    remapRecord: remapRecord,
    remapRefs: remapRefs,
  };

  root.BackupFormat = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
