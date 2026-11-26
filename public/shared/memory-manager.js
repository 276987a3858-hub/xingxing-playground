/* public/shared/memory-manager.js — 长期记忆第四阶段：设置页统一条目管理接口
 * 设计约束：
 *   1. 所有新增 / 编辑 / 撤回 / 恢复 / 归档都必须经第一阶段 LongTermMemoryV2.reserved 接口，
 *      因此必然写 history，不绕过、不另造结构。
 *   2. 用户手动录入 / 编辑的条目标注 source.manual=true、confirm='user-confirmed'，
 *      生成算法不得用 medium 证据或模糊冲突覆盖（由 memory-generator 保护）。
 *   3. ensure() 只在 v2 键「不存在」时初始化；v2 已存在但不合法时绝不覆盖，原样保留并报错。
 *   4. 写入失败时不改内存状态、不返回新 state；旧 longTermMemory 原文永不触碰。
 *   5. 纯逻辑 + 注入 store { get, set }，不依赖 DOM，便于 Node 测试。
 * 暴露 window.MemoryManager / globalThis.MemoryManager。
 */
(function (root) {
  'use strict';

  var ALLOWED_CATEGORY = {
    preference: true, fact: true, agreement: true, event: true,
    relation: true, habit: true, other: true, 'legacy-baseline': true, note: true
  };

  function V() { return root.LongTermMemoryV2 || null; }
  function nowOf(t) { return typeof t === 'number' && isFinite(t) ? t : Date.now(); }
  function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

  function findEntry(state, id) {
    if (!state || !Array.isArray(state.entries)) return null;
    for (var i = 0; i < state.entries.length; i++) {
      if (state.entries[i] && state.entries[i].id === id) return state.entries[i];
    }
    return null;
  }

  function isManual(entry) {
    return !!(entry && entry.source && entry.source.manual === true);
  }
  function isBaselineMirror(entry) {
    return !!(entry && entry.source && entry.source.mirrorOfBaseline === true);
  }

  function manualSource(entry, now, action) {
    var old = (entry && entry.source && typeof entry.source === 'object') ? entry.source : {};
    var src = {};
    Object.keys(old).forEach(function (k) { src[k] = old[k]; });
    src.kind = 'manual';
    src.sourceType = 'manual';
    src.confirm = 'user-confirmed';   // 明确手动编辑 = 用户确认，与 AI 的 unverified 区分
    src.manual = true;
    src.editedBy = 'user';
    src.userEditedAt = now;
    src.mirrorOfBaseline = false;     // 编辑旧镜像即视为用户确认，转为正式可检索条目
    src.note = action === 'add' ? '设置页手动新增' : '设置页手动编辑（旧原文完整保留在 baseline）';
    if (!src.idKind) src.idKind = 'content';
    if (!('sourceAt' in src)) src.sourceAt = now;
    return src;
  }

  async function persist(store, state, now) {
    var V2 = V();
    if (!store || typeof store.set !== 'function') return { ok: false, reason: 'bad-store' };
    try {
      await store.set(V2.V2_KEY, state);
    } catch (e) {
      return { ok: false, reason: 'write-failed', error: String((e && e.message) || e) };
    }
    return { ok: true };
  }

  /** 确保 v2 可用：只在键不存在时初始化，失败/不合法都不动旧数据。 */
  async function ensure(store, opts) {
    opts = opts || {};
    var V2 = V();
    if (!V2 || !store || typeof store.get !== 'function' || typeof store.set !== 'function') {
      return { ok: false, reason: 'bad-params', state: null };
    }
    var existing;
    try { existing = await store.get(V2.V2_KEY); }
    catch (e) { return { ok: false, reason: 'read-failed', state: null, error: String((e && e.message) || e) }; }
    if (V2.isValidState(existing)) return { ok: true, reason: 'already', state: existing, initialized: false };
    if (existing != null) {
      return {
        ok: false, reason: 'v2-invalid-kept', state: null,
        error: 'longTermMemory.v2 已存在但结构不合法，已原样保留；请检查数据后再操作'
      };
    }
    var init = await V2.initialize(store, { now: opts.now });
    if (!init || !init.initialized) {
      return { ok: false, reason: (init && init.reason) || 'init-failed', state: null, error: init && init.error };
    }
    // 以落库结果为准重新读取，避免用到 readState 的只读视图
    try {
      var stored = await store.get(V2.V2_KEY);
      if (!V2.isValidState(stored)) return { ok: false, reason: 'recheck-failed', state: null };
      return { ok: true, reason: 'initialized', state: stored, initialized: true };
    } catch (e) {
      return { ok: false, reason: 'recheck-failed', state: null, error: String((e && e.message) || e) };
    }
  }

  /** 新增手动条目。返回 { ok, state, id, reason }。 */
  async function add(store, state, spec) {
    var V2 = V();
    if (!V2 || !V2.isValidState(state) || !spec) return { ok: false, state: state, reason: 'bad-params' };
    var text = norm(spec.text);
    if (!text) return { ok: false, state: state, reason: 'empty-text' };
    var category = spec.category || 'note';
    if (!ALLOWED_CATEGORY[category]) return { ok: false, state: state, reason: 'invalid-category' };
    var now = nowOf(spec.now);
    var src = manualSource(null, now, 'add');
    if (spec.source && typeof spec.source === 'object') {
      Object.keys(spec.source).forEach(function (k) { src[k] = spec.source[k]; });
      src.manual = true;
      src.confirm = 'user-confirmed';
    }
    var next = V2.reserved.addEntry(state, {
      text: text, category: category, source: src, status: 'active', now: now
    });
    if (!next || !V2.isValidState(next)) return { ok: false, state: state, reason: 'invalid-result' };
    if (next.entries.length === state.entries.length) return { ok: false, state: state, reason: 'duplicate' };
    var w = await persist(store, next, now);
    if (!w.ok) return { ok: false, state: state, reason: w.reason, error: w.error };
    return { ok: true, state: next, id: next.entries[next.entries.length - 1].id, reason: 'added' };
  }

  /** 编辑条目：必走 reviseEntry，source 与 text/category 的变更全部写入 history。 */
  async function edit(store, state, id, spec) {
    var V2 = V();
    if (!V2 || !V2.isValidState(state) || typeof id !== 'string' || !id || !spec) {
      return { ok: false, state: state, reason: 'bad-params' };
    }
    var target = findEntry(state, id);
    if (!target) return { ok: false, state: state, reason: 'invalid-id' };
    if (target.status !== 'active') return { ok: false, state: state, reason: 'protected-entry' };
    var text = norm(spec.text);
    if (!text) return { ok: false, state: state, reason: 'empty-text' };
    var category = spec.category || target.category;
    if (!ALLOWED_CATEGORY[category]) return { ok: false, state: state, reason: 'invalid-category' };
    var now = nowOf(spec.now);
    var next = V2.reserved.reviseEntry(state, id, {
      text: text,
      category: category,
      source: manualSource(target, now, 'edit'),
      now: now
    });
    if (!next || !V2.isValidState(next)) return { ok: false, state: state, reason: 'invalid-result' };
    var w = await persist(store, next, now);
    if (!w.ok) return { ok: false, state: state, reason: w.reason, error: w.error };
    return { ok: true, state: next, id: id, reason: 'edited' };
  }

  function statusChanger(method, status) {
    return async function (store, state, id, now) {
      var V2 = V();
      if (!V2 || !V2.isValidState(state) || typeof id !== 'string' || !id) {
        return { ok: false, state: state, reason: 'bad-params' };
      }
      if (!findEntry(state, id)) return { ok: false, state: state, reason: 'invalid-id' };
      var next = V2.reserved[method](state, id, nowOf(now));
      if (!next || !V2.isValidState(next)) return { ok: false, state: state, reason: 'invalid-result' };
      var w = await persist(store, next, now);
      if (!w.ok) return { ok: false, state: state, reason: w.reason, error: w.error };
      return { ok: true, state: next, id: id, reason: status };
    };
  }

  function sourceLabel(e) {
    var s = (e && e.source) || {};
    var label = s.kind || 'unknown';
    if (s.sourceId) label += ' · ' + s.sourceId;
    if (isManual(e)) label += ' · 手动';
    else if (s.confirm === 'unverified') label += ' · 未核实';
    return label;
  }

  /** 展示视图：只是投影，不改原 state。 */
  function list(state) {
    if (!state || !Array.isArray(state.entries)) return { all: [], active: [], retracted: [], archived: [] };
    var views = state.entries.map(function (e) {
      return {
        id: e.id, text: e.text, category: e.category, status: e.status,
        createdAt: e.createdAt, updatedAt: e.updatedAt,
        source: e.source, sourceLabel: sourceLabel(e),
        history: Array.isArray(e.history) ? e.history.slice() : [],
        manual: isManual(e), baselineMirror: isBaselineMirror(e)
      };
    });
    return {
      all: views,
      active: views.filter(function (v) { return v.status === 'active'; }),
      retracted: views.filter(function (v) { return v.status === 'retracted'; }),
      archived: views.filter(function (v) { return v.status === 'archived'; })
    };
  }

  var api = {
    ALLOWED_CATEGORY: Object.assign({}, ALLOWED_CATEGORY),
    ensure: ensure,
    add: add,
    edit: edit,
    retract: statusChanger('retractEntry', 'retracted'),
    restore: statusChanger('restoreEntry', 'active'),
    archive: statusChanger('archiveEntry', 'archived'),
    isManual: isManual,
    isBaselineMirror: isBaselineMirror,
    sourceLabel: sourceLabel,
    list: list,
    findEntry: findEntry
  };
  root.MemoryManager = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
