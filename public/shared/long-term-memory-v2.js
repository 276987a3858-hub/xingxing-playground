/* public/shared/long-term-memory-v2.js — 长期记忆条目化：第一阶段（条目存储 + 旧数据兼容）
 * 职责边界（第一阶段）：只建立新数据结构、幂等初始化与兼容读取接口。
 *   - 不改 generateMemory() 的 AI 提示词/写入；不改 persona-memory.js 的检索；
 *   - 不改设置页 UI；不改备份导入导出；不删改任何原始记录。
 * 硬约束：
 *   1. 新键 longTermMemory.v2 独立存储，原 longTermMemory 永不删除/覆盖/迁移后清空。
 *   2. 每条至少含 id / text / category / source / createdAt / updatedAt / status。
 *   3. 旧字符串解析不确定时，整段原样保留为一条 baseline 镜像条目，绝不擅自拆分/改写/丢弃。
 *   4. 完整旧原文镜像保存在 root.baseline，并明确 baselineRole='fallback-only'、
 *      source.mirrorOfBaseline=true：baseline 仅供回退/校对，不是第二份独立记忆，不参与逐条检索。
 *   5. 初始化幂等 + 并发串行：重复/并发调用不产生重复条目、不相互覆盖；写入失败不影响旧数据。
 *   6. 未确认内容不得标为已确认事实：迁移条目标注 confirm:'unverified'。
 *   7. source 记录来源类型 kind/sourceType、原始记录 ID sourceId、原始时间 sourceAt（未知则 null，绝不编造）。
 *   8. 预留 add/revise/retract/restore/archive 接口（纯函数、带校验、带 history），第一阶段不启用。
 * 存储后端由调用方注入 { get(key), set(key, value) }（对应 app.js 的 kvGet/kvSet）。
 * 暴露 window.LongTermMemoryV2 / globalThis.LongTermMemoryV2。
 */
(function (root) {
  'use strict';

  var LEGACY_KEY = 'longTermMemory';
  var V2_KEY = 'longTermMemory.v2';
  var SCHEMA = 1;                       // v2 数据结构自身的版本号（与存储键的 v2 区分）
  var VALID_STATUS = ['active', 'retracted', 'archived'];
  var VALID_STATUS_SET = { active: true, retracted: true, archived: true };
  var LEGACY_SOURCE_ID = 'legacy:longTermMemory';
  // 并发初始化串行锁（按 store 实例区分；浏览器/Node 中模块均为单例）
  var INIT_LOCKS = (typeof WeakMap === 'function') ? new WeakMap() : null;

  // 双哈希 64 位确定性指纹：同输入→同输出，抗碰撞优于单哈希。
  function fingerprint(text) {
    var s = String(text == null ? '' : text);
    var h1 = 0x811c9dc5, h2 = 0x01000193;
    for (var i = 0; i < s.length; i++) {
      h1 ^= s.charCodeAt(i);
      h1 = Math.imul(h1, 16777619) >>> 0;
      h2 = (Math.imul(h2 ^ s.charCodeAt(s.length - 1 - i), 2246822519) >>> 0) + i;
      h2 = h2 >>> 0;
    }
    var hex = function (n) { return ('00000000' + (n >>> 0).toString(16)).slice(-8); };
    return hex(h1) + hex(h2);
  }
  function makeId(seed) { return 'ltm-' + fingerprint(seed); }
  // ID 以「来源」为准而非内容：同一来源稳定同 id；不同来源相似内容不同 id。
  function idForSource(sourceId) { return makeId('source:' + String(sourceId)); }

  function isObject(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
  function isFiniteNum(n) { return typeof n === 'number' && isFinite(n); }
  function nowOf(t) { return isFiniteNum(t) ? t : Date.now(); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function isValidSource(s) {
    return isObject(s) && typeof s.kind === 'string' && s.kind.length > 0;
  }
  // 校验一条条目是否结构合法（供写入前自检 / 读取时判定，不修改入参）
  function isValidEntry(e) {
    if (!isObject(e)) return false;
    if (typeof e.id !== 'string' || !e.id) return false;
    if (typeof e.text !== 'string' || !e.text.length) return false;
    if (typeof e.category !== 'string' || !e.category) return false;
    if (!isValidSource(e.source)) return false;
    if (!isFiniteNum(e.createdAt) || !isFiniteNum(e.updatedAt)) return false;
    if (!VALID_STATUS_SET[e.status]) return false;
    return true;
  }
  function isValidState(s) {
    return isObject(s) && s.schema === SCHEMA && Array.isArray(s.entries) &&
      typeof s.baseline === 'string' && s.entries.every(isValidEntry);
  }

  // 构造一条条目。缺 source 时补默认（保证产出一定通过 isValidEntry）；
  // 缺 sourceId 时以内容溯源 idKind='content'，有则 idKind='source'。
  function makeEntry(spec) {
    spec = isObject(spec) ? spec : {};
    var now = nowOf(spec.now);
    var text = String(spec.text == null ? '' : spec.text);
    var src = isObject(spec.source) ? clone(spec.source) : {};
    if (!src.kind) src.kind = spec.sourceType || 'manual';
    if (src.sourceId == null || src.sourceId === '') {
      src.sourceId = 'content:' + fingerprint(text + '|' + (spec.category || ''));
      src.idKind = 'content';
    } else {
      src.idKind = src.idKind || 'source';
    }
    if (!('sourceAt' in src)) src.sourceAt = null;      // 原始时间未知 → null，不编造
    if (!('confirm' in src)) src.confirm = 'unverified';
    return {
      id: spec.id || idForSource(src.sourceId),
      text: text,
      category: spec.category || 'note',
      source: src,
      createdAt: now,
      updatedAt: now,
      status: VALID_STATUS_SET[spec.status] ? spec.status : 'active',
      history: []
    };
  }

  /* ---------------- 旧字符串 → v2 条目（保守解析） ---------------- */
  // 整段原文做成一条 baseline 镜像条目；不拆分/改写/丢弃；不冒充已确认事实。
  function parseLegacy(legacyRaw, opts) {
    opts = isObject(opts) ? opts : {};
    var raw = String(legacyRaw == null ? '' : legacyRaw);
    var now = nowOf(opts.now);
    var state = {
      schema: SCHEMA,
      key: V2_KEY,
      legacyKey: LEGACY_KEY,
      createdAt: now,
      updatedAt: now,
      baseline: raw,                      // 完整旧原文镜像，永远保留
      baselineRole: 'fallback-only',      // 明确：仅回退/校对，不是第二份独立记忆
      source: { kind: 'legacy-baseline', key: LEGACY_KEY, confirm: 'unverified' },
      entries: []
    };
    if (!raw.length) return state;        // 空旧记忆：条目为空，baseline 仍完整保留（空串）

    var entry = makeEntry({
      id: opts.id || idForSource(LEGACY_SOURCE_ID),
      text: raw,
      category: 'legacy-baseline',
      source: {
        kind: 'legacy-baseline',
        sourceType: 'legacy-long-term-memory',
        sourceId: LEGACY_SOURCE_ID,       // 稳定来源 ID：同一旧记忆永远是同一来源
        idKind: 'source',
        sourceAt: null,                   // 旧字符串无可靠原始时间 → null，不编造
        key: LEGACY_KEY,
        confirm: 'unverified',
        mirrorOfBaseline: true,           // 关键：标记这是 baseline 的镜像，避免被当成第二份独立记忆
        originalLength: raw.length,
        note: '旧 longTermMemory 整段原文，未拆分/未改写；待后续阶段逐条确认'
      },
      status: 'active',
      now: now
    });
    state.entries.push(entry);
    return state;
  }

  /* ---------------- 兼容读取：v2 未就绪时回退旧数据 ---------------- */
  // 返回 { ready, version, baseline, baselineRole, baselineIsMemory, entries, text, source }。
  // 第一阶段注入方式不变：text 仍取 baseline 整段；baselineIsMemory=false 明确其非独立记忆。
  function readState(v2State, legacyRaw) {
    if (isValidState(v2State)) {
      return {
        ready: true,
        version: 'v2',
        baseline: v2State.baseline,
        baselineRole: v2State.baselineRole || 'fallback-only',
        baselineIsMemory: false,          // baseline 是回退镜像，检索时只遍历 entries
        entries: v2State.entries.slice(),
        text: v2State.baseline,
        source: v2State.source
      };
    }
    var raw = String(legacyRaw == null ? '' : legacyRaw);
    return {
      ready: false,
      version: 'v1',
      baseline: raw,
      baselineRole: 'fallback-only',
      baselineIsMemory: false,
      entries: [],
      text: raw,
      source: { kind: 'legacy-fallback', key: LEGACY_KEY, confirm: 'unverified' }
    };
  }

  /* ---------------- 初始化主体（供并发锁串行调用） ---------------- */
  // 返回 { initialized, reason, state, error }；任何失败都吞掉并返回结果，绝不抛给调用方影响旧流程。
  async function doInitialize(store, opts) {
    opts = opts || {};
    var result = { initialized: false, reason: '', state: null, error: null };
    var existing, legacyRaw;
    try {
      existing = await store.get(V2_KEY);
      legacyRaw = await store.get(LEGACY_KEY);
    } catch (e) {
      result.reason = 'read-failed';
      result.error = String((e && e.message) || e);
      return result;
    }
    // 已初始化且结构合法 → 直接返回既有状态，不重复写入、不重建条目。
    if (isValidState(existing)) {
      result.reason = 'already-initialized';
      result.state = existing;
      return result;
    }
    // v2 键存在但不合法：不擅自覆盖任何已有数据，回退旧数据并记录原因。
    if (existing != null && !isValidState(existing)) {
      result.reason = 'v2-invalid-kept';
      result.error = 'longTermMemory.v2 已存在但结构不合法；保留原值不动，回退旧记忆';
      result.state = readState(null, legacyRaw);
      return result;
    }
    var state;
    try {
      state = parseLegacy(legacyRaw, opts);
    } catch (e) {
      result.reason = 'parse-failed';
      result.error = String((e && e.message) || e);
      return result;
    }
    try {
      await store.set(V2_KEY, state);   // 只写新键，绝不触碰 LEGACY_KEY
    } catch (e) {
      result.reason = 'write-failed';
      result.error = String((e && e.message) || e);
      result.state = readState(null, legacyRaw);
      return result;
    }
    result.initialized = true;
    result.reason = 'initialized';
    result.state = readState(state, legacyRaw);
    return result;
  }

  // initialize：并发调用按 store 串行，避免同时读到「未初始化」而相互覆盖。
  function initialize(store, opts) {
    if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') {
      return Promise.resolve({
        initialized: false, reason: 'no-store', state: null,
        error: 'initialize 需要注入 { get, set }'
      });
    }
    if (!INIT_LOCKS) return doInitialize(store, opts);
    var prior = INIT_LOCKS.get(store);
    var run = (prior ? prior.catch(function () {}) : Promise.resolve()).then(function () {
      return doInitialize(store, opts);
    });
    INIT_LOCKS.set(store, run.catch(function () {}));
    return run;
  }

  // 读取兼容视图（不写入）。调用方注入 get；失败一律回退旧数据。
  async function read(store) {
    if (!store || typeof store.get !== 'function') return readState(null, '');
    var v2State = null, legacyRaw = '';
    try { v2State = await store.get(V2_KEY); } catch (e) { v2State = null; }
    try { legacyRaw = await store.get(LEGACY_KEY); } catch (e) { legacyRaw = ''; }
    return readState(v2State, legacyRaw);
  }

  /* ---------------- 预留接口：第一阶段不启用（纯函数，带校验/去重/状态保护/history） ---------------- */
  function appendHistory(entry, at, field, from, to) {
    entry.history = Array.isArray(entry.history) ? entry.history : [];
    entry.history.push({ at: at, field: field, from: from, to: to });
  }
  function findEntry(entries, id) {
    for (var i = 0; i < entries.length; i++) if (entries[i].id === id) return entries[i];
    return null;
  }
  function sameSource(a, b) {
    if (a && b && a.sourceId && b.sourceId) return a.sourceId === b.sourceId;
    return !!(a && b && a.id && a.id === b.id);
  }

  var reserved = {
    // 新增：空文本/非法 spec 拒绝；同来源重复添加不产生新条目（返回原 state 副本）。
    addEntry: function (state, spec) {
      if (!isValidState(state) || !isObject(spec)) return null;
      if (typeof spec.text !== 'string' || !spec.text.length) return null;
      var now = nowOf(spec.now);
      var e = makeEntry(Object.assign({}, spec, { now: now }));
      for (var i = 0; i < state.entries.length; i++) {
        if (sameSource(state.entries[i].source, e.source) || state.entries[i].id === e.id) {
          return clone(state);   // 同来源已存在 → 不重复添加
        }
      }
      var next = clone(state);
      next.entries.push(e);
      next.updatedAt = now;
      return next;
    },
    // 修正：撤回/归档条目默认拒绝普通修正（避免意外恢复/篡改）；空文本/空类别拒绝；写 history。
    reviseEntry: function (state, id, patch) {
      if (!isValidState(state) || typeof id !== 'string' || !id || !isObject(patch)) return null;
      if (patch.text != null && (typeof patch.text !== 'string' || !patch.text.length)) return null;
      if (patch.category != null && (typeof patch.category !== 'string' || !patch.category)) return null;
      var next = clone(state);
      var en = findEntry(next.entries, id);
      if (!en) return null;
      if (en.status !== 'active' && patch.force !== true) return null;  // 已撤回/归档受保护
      var now = nowOf(patch.now);
      if (patch.text != null && patch.text !== en.text) { appendHistory(en, now, 'text', en.text, patch.text); en.text = patch.text; }
      if (patch.category != null && patch.category !== en.category) { appendHistory(en, now, 'category', en.category, patch.category); en.category = patch.category; }
      if (isObject(patch.source)) { appendHistory(en, now, 'source', en.source, clone(patch.source)); en.source = clone(patch.source); }
      en.updatedAt = now;
      next.updatedAt = now;
      return next;
    },
    // 状态变更：撤回 / 恢复 / 归档；写入 history，供追溯。
    setStatus: function (state, id, status, now) {
      if (!isValidState(state) || typeof id !== 'string' || !id || !VALID_STATUS_SET[status]) return null;
      var next = clone(state);
      var en = findEntry(next.entries, id);
      if (!en) return null;
      var t = nowOf(now);
      if (en.status !== status) { appendHistory(en, t, 'status', en.status, status); en.status = status; }
      en.updatedAt = t;
      next.updatedAt = t;
      return next;
    },
    retractEntry: function (state, id, now) { return reserved.setStatus(state, id, 'retracted', now); },
    restoreEntry: function (state, id, now) { return reserved.setStatus(state, id, 'active', now); },
    archiveEntry: function (state, id, now) { return reserved.setStatus(state, id, 'archived', now); }
  };

  var api = {
    LEGACY_KEY: LEGACY_KEY,
    V2_KEY: V2_KEY,
    SCHEMA: SCHEMA,
    VALID_STATUS: VALID_STATUS.slice(),
    LEGACY_SOURCE_ID: LEGACY_SOURCE_ID,
    makeId: makeId,
    idForSource: idForSource,
    fingerprint: fingerprint,
    makeEntry: makeEntry,
    isValidEntry: isValidEntry,
    isValidState: isValidState,
    parseLegacy: parseLegacy,
    readState: readState,
    initialize: initialize,
    read: read,
    reserved: reserved
  };
  root.LongTermMemoryV2 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
