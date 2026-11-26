/* public/shared/self-narrative.js — 机自述数据层（P1：只建数据层）
 * ------------------------------------------------------------------
 * 机自述 = 小星眼中的用户：他的观察、印象、理解、猜测、好奇，以及还没弄清的问题。
 * 明确不是：
 *   - 星星日记（他自己经历了什么、心情如何）；
 *   - 共同珍藏（双方共同经历、值得纪念的事）；
 *   - 长期记忆（已确认、适合长期保留的稳定事实与关系认知）；
 *   - 隐藏思维链（不记录、也不暴露模型的内部推理过程）。
 * 因此允许保留不确定性：文本里可以写「我还不确定」「我想再了解一点」。
 *
 * 阶段边界（P1）：
 *   - 只做数据层。不生成、不自动触发、不自主修订、不主动分享、不进聊天上下文、不做 UI、不接 MCP。
 *   - 本文件不读也不写日记 / 共同珍藏 / 长期记忆，也不会把 inferred、question 升级成长期记忆。
 *
 * 存储：独立键 selfNarrative.v1（与 longTermMemory / longTermMemory.v2 / diaries / keeps 互不相干）。
 *      后端由调用方注入 { get(key), set(key, value) }，对应 app.js 的 kvGet / kvSet。
 *
 * 硬约束：
 *   1. 每次操作只影响指定记录；写入前重新读最新状态，写前校验其余记录逐字节未变（防止整库被覆盖）。
 *   2. 修订不覆盖：修改前完整快照进 history；撤回只改状态，不物理删除，正文 / 来源 / 历史全部保留。
 *   3. 键已存在但结构不合法时拒绝写入并说明原因，绝不擅自覆盖用户数据。
 *   4. 所有失败都返回明确 reason，不抛异常、不静默吞掉。
 *
 * 暴露 window.SelfNarrative / globalThis.SelfNarrative。
 */
(function (root) {
  'use strict';

  var KEY = 'selfNarrative.v1';
  var SCHEMA = 1;

  // 记录性质：四种。observed / inferred / question 是四个自由文本字段，不替代 kind。
  var KINDS = ['observation', 'impression', 'inference', 'question'];
  var KIND_SET = { observation: true, impression: true, inference: true, question: true };
  var KIND_LABELS = {
    observation: '看到的样子',
    impression: '留下的印象',
    inference: '我的理解',
    question: '还想弄明白的'
  };

  var CONFIDENCES = ['low', 'medium', 'high'];
  var CONF_SET = { low: true, medium: true, high: true };
  var DEFAULT_CONFIDENCE = 'medium';

  // active=有效（默认）；retracted=已撤回（保留正文与历史）；superseded=已被新版修订取代。
  var STATUSES = ['active', 'retracted', 'superseded'];
  var STATUS_SET = { active: true, retracted: true, superseded: true };
  var STATUS_LABELS = { active: '有效', retracted: '已撤回', superseded: '已被修订' };

  // 重复识别：同文（去空白/标点后完全相同）直接用；相似文用字符二元组 Jaccard 阈值。
  // 0.6 只用于「提示可能重复」，绝不据此合并或删除——短句改写本来就会落在这一档。
  var DUP_SIMILARITY = 0.6;
  // basis 表示「这条认识的依据类型」，与 confidence（小星自己的确信程度）是两件事：
  //   stated   用户原话里出现过（只证明来源，不代表她确认了这个判断）；
  //   observed 看到的行为、可复述的表现；
  //   inferred 他自己基于上下文的推测。
  var BASES = ['stated', 'observed', 'inferred'];
  var BASIS_SET = { stated: true, observed: true, inferred: true };
  var BASIS_LABELS = { stated: '她说过', observed: '看到的表现', inferred: '他的推测' };

  var TEXT_FIELDS = ['observed', 'inferred', 'confirmed', 'question', 'topic'];
  var PATCH_FIELDS = {
    text: true, kind: true, observed: true, inferred: true, confirmed: true,
    question: true, confidence: true, topic: true, source: true, revisedFrom: true,
    basis: true, evidence: true
  };
  // 来源里可用于定位的键（支持关联聊天消息或其他合法来源）
  var SOURCE_KEYS = ['messageId', 'sourceId', 'id', 'ref', 'conversationId', 'key'];

  var MUTEX = (typeof WeakMap === 'function') ? new WeakMap() : null;

  /* ---------------- 基础工具 ---------------- */

  function isObject(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
  function isFiniteNum(n) { return typeof n === 'number' && isFinite(n); }
  function nowOf(t) { return isFiniteNum(t) ? t : Date.now(); }
  function str(v) { return String(v == null ? '' : v).trim(); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function errText(e) { return String((e && e.message) || e); }

  // 双哈希 64 位确定性指纹：同输入同输出，用于生成稳定的记录 ID。
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

  // 键序无关的规范化串：用于「其余记录是否被改动」的逐字节比较。
  function canon(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    var keys = Object.keys(v).sort();
    return '{' + keys.map(function (k) { return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
  }

  /* ---------------- 结构与校验 ---------------- */

  function emptyState(now) {
    var t = nowOf(now);
    return { schema: SCHEMA, key: KEY, createdAt: t, updatedAt: t, records: [] };
  }

  // 来源规范化：支持字符串引用、{kind,...} 对象；缺省为人工录入。
  function normalizeSource(spec) {
    if (spec == null || spec === '') return { kind: 'manual' };
    if (typeof spec === 'string') return { kind: 'other', ref: spec };
    if (!isObject(spec)) return null;
    var out = {};
    Object.keys(spec).forEach(function (k) { out[k] = clone(spec[k]); });
    if (typeof out.kind !== 'string' || !out.kind.trim()) return null;
    out.kind = out.kind.trim();
    return out;
  }
  function isValidSource(s) { return isObject(s) && typeof s.kind === 'string' && s.kind.length > 0; }

  function isValidEvidenceList(list) {
    if (!Array.isArray(list)) return false;
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (!isObject(e)) return false;
      if (typeof e.messageId === 'number') {
        if (!isFiniteNum(e.messageId) || Math.floor(e.messageId) !== e.messageId) return false;
      } else if (typeof e.messageId === 'string') {
        if (!e.messageId.trim()) return false;
      } else {
        return false;
      }
      if (typeof e.quote !== 'string') return false;
    }
    return true;
  }

  // evidence：主证据之外的支撑引用，每项都要有可核对的 messageId 与原文片段 quote。
  // 返回 { ok, value } / { ok:false, reason:'invalid-evidence', detail }。
  function parseEvidence(spec) {
    if (spec == null) return { ok: true, value: [] };
    if (!Array.isArray(spec)) return { ok: false, reason: 'invalid-evidence', detail: 'not-an-array' };
    var out = [];
    for (var i = 0; i < spec.length; i++) {
      var e = spec[i];
      if (!isObject(e)) return { ok: false, reason: 'invalid-evidence', detail: 'item-' + i };
      var raw = e.messageId;
      if (typeof raw !== 'number' && typeof raw !== 'string') {
        return { ok: false, reason: 'invalid-evidence', detail: 'messageId-' + i };
      }
      if (typeof raw === 'number' && (!isFiniteNum(raw) || Math.floor(raw) !== raw)) {
        return { ok: false, reason: 'invalid-evidence', detail: 'messageId-' + i };
      }
      var mid = typeof raw === 'string' ? raw.trim() : raw;
      if (mid === '') return { ok: false, reason: 'invalid-evidence', detail: 'messageId-' + i };
      var quote = str(e.quote);
      if (!quote) return { ok: false, reason: 'invalid-evidence', detail: 'quote-' + i };
      out.push({ messageId: mid, quote: quote });
    }
    return { ok: true, value: out };
  }

  // 语义不变量：basis 与 confirmed / confidence 的组合约束。
  // confirmed 从不被自动推导 —— basis='stated' 只说明「她说过」，不等于「她确认了这个判断」。
  function checkSemantics(rec) {
    if (!isObject(rec)) return null;
    if (rec.basis == null) return null;                  // 旧记录没有 basis：不校验、不回填
    if (!BASIS_SET[rec.basis]) return 'invalid-basis';
    if (rec.basis === 'inferred') {
      if (str(rec.confirmed)) return 'confirmed-not-allowed';
      if (rec.confidence === 'high') return 'confidence-too-high';
    }
    // 主证据与第一条 evidence 必须同源，避免 source 与 evidence 各说各话。
    if (rec.source && rec.source.messageId != null &&
        Array.isArray(rec.evidence) && rec.evidence.length) {
      if (String(rec.source.messageId) !== String(rec.evidence[0].messageId)) {
        return 'evidence-source-mismatch';
      }
    }
    return null;
  }

  function isValidVersion(v) {
    if (!isObject(v)) return false;
    if (!isFiniteNum(v.at)) return false;
    if (typeof v.text !== 'string' || !v.text.trim().length) return false;
    if (!KIND_SET[v.kind]) return false;
    if (!CONF_SET[v.confidence]) return false;
    if (!STATUS_SET[v.status]) return false;
    if (!isValidSource(v.source)) return false;
    for (var i = 0; i < TEXT_FIELDS.length; i++) {
      if (typeof v[TEXT_FIELDS[i]] !== 'string') return false;
    }
    // basis / evidence 是后加字段：缺省视为合法（旧记录、旧备份照常通过），存在则必须形状正确。
    if (!(v.basis == null || BASIS_SET[v.basis])) return false;
    if (!(v.evidence == null || isValidEvidenceList(v.evidence))) return false;
    return true;
  }

  function isValidRecord(r) {
    if (!isObject(r)) return false;
    if (typeof r.id !== 'string' || !r.id) return false;
    if (typeof r.text !== 'string' || !r.text.trim().length) return false;
    if (!KIND_SET[r.kind]) return false;
    if (!CONF_SET[r.confidence]) return false;
    if (!STATUS_SET[r.status]) return false;
    for (var i = 0; i < TEXT_FIELDS.length; i++) {
      if (typeof r[TEXT_FIELDS[i]] !== 'string') return false;
    }
    if (!isValidSource(r.source)) return false;
    if (!isFiniteNum(r.createdAt) || !isFiniteNum(r.updatedAt)) return false;
    // 同 isValidVersion：缺省合法，存在即校验形状。绝不因为缺字段判旧记录非法。
    if (!(r.basis == null || BASIS_SET[r.basis])) return false;
    if (!(r.evidence == null || isValidEvidenceList(r.evidence))) return false;
    if (!(r.revisedFrom == null || typeof r.revisedFrom === 'string')) return false;
    if (!(r.supersededBy == null || typeof r.supersededBy === 'string')) return false;
    if (!Array.isArray(r.history) || !r.history.every(isValidVersion)) return false;
    return true;
  }

  function isValidState(s) {
    if (!isObject(s)) return false;
    if (s.schema !== SCHEMA || s.key !== KEY) return false;
    if (!isFiniteNum(s.createdAt) || !isFiniteNum(s.updatedAt)) return false;
    if (!Array.isArray(s.records)) return false;
    var seen = {};
    for (var i = 0; i < s.records.length; i++) {
      var r = s.records[i];
      if (!isValidRecord(r)) return false;
      if (seen[r.id]) return false;              // 同 ID 出现两次 → 结构不合法
      seen[r.id] = true;
    }
    return true;
  }

  function byId(state, id) {
    if (!state || !Array.isArray(state.records)) return null;
    for (var i = 0; i < state.records.length; i++) {
      if (state.records[i].id === id) return state.records[i];
    }
    return null;
  }

  function nextId(state, seed) {
    var base = 'sn-' + fingerprint(seed);
    if (!byId(state, base)) return base;
    var n = 1, id = base;
    while (byId(state, id)) { n += 1; id = base + '-' + n; }
    return id;
  }

  /* ---------------- 记录构造 ---------------- */

  function makeRecord(spec) {
    spec = isObject(spec) ? spec : {};
    var now = nowOf(spec.now);
    var src = normalizeSource(spec.source) || { kind: 'manual' };
    var rec = {
      id: spec.id || 'sn-' + fingerprint(str(spec.text) + '|' + now),
      text: str(spec.text),
      kind: KIND_SET[spec.kind] ? spec.kind : 'observation',
      observed: str(spec.observed),
      inferred: str(spec.inferred),
      confirmed: str(spec.confirmed),
      question: str(spec.question),
      confidence: CONF_SET[spec.confidence] ? spec.confidence : DEFAULT_CONFIDENCE,
      topic: str(spec.topic),
      // basis 缺省为 null（不猜）。evidence 缺省为空数组，保持结构稳定。
      basis: BASIS_SET[spec.basis] ? spec.basis : null,
      evidence: Array.isArray(spec.evidence) ? clone(spec.evidence) : [],
      source: src,
      status: STATUS_SET[spec.status] ? spec.status : 'active',
      revisedFrom: typeof spec.revisedFrom === 'string' && spec.revisedFrom ? spec.revisedFrom : null,
      supersededBy: typeof spec.supersededBy === 'string' && spec.supersededBy ? spec.supersededBy : null,
      createdAt: now,
      updatedAt: now,
      history: []
    };
    return rec;
  }

  // 修订前快照：正文 + 必要元数据，保证旧版本可完整回看。
  function snapshotOf(rec, at) {
    return {
      at: isFiniteNum(at) ? at : rec.updatedAt,
      text: rec.text,
      kind: rec.kind,
      observed: rec.observed,
      inferred: rec.inferred,
      confirmed: rec.confirmed,
      question: rec.question,
      confidence: rec.confidence,
      topic: rec.topic,
      // 快照必须带上依据与证据，否则修订后旧版的证据链直接消失。
      basis: rec.basis == null ? null : rec.basis,
      evidence: Array.isArray(rec.evidence) ? clone(rec.evidence) : [],
      source: clone(rec.source),
      status: rec.status,
      revisedFrom: rec.revisedFrom,
      historyLength: Array.isArray(rec.history) ? rec.history.length : 0
    };
  }

  /* ---------------- 写入参数校验 ---------------- */

  // 校验新增参数 → { ok, reason, value }。不做任何默认猜测：kind 必填且必须合法。
  function validateCreate(spec) {
    if (!isObject(spec)) return { ok: false, reason: 'bad-params' };
    var text = str(spec.text);
    if (!text) return { ok: false, reason: 'empty-text' };
    if (!KIND_SET[spec.kind]) return { ok: false, reason: 'invalid-kind' };
    if (spec.confidence != null && !CONF_SET[spec.confidence]) return { ok: false, reason: 'invalid-confidence' };
    if (spec.status != null && spec.status !== 'active') return { ok: false, reason: 'invalid-status' };
    var src = normalizeSource(spec.source);
    if (!src) return { ok: false, reason: 'invalid-source' };
    if (spec.basis != null && !BASIS_SET[spec.basis]) return { ok: false, reason: 'invalid-basis' };
    var ev = parseEvidence(spec.evidence);
    if (!ev.ok) return ev;
    if (spec.revisedFrom != null && (typeof spec.revisedFrom !== 'string' || !spec.revisedFrom)) {
      return { ok: false, reason: 'invalid-revised-from' };
    }
    if (spec.id != null && (typeof spec.id !== 'string' || !spec.id.trim())) {
      return { ok: false, reason: 'invalid-id' };
    }
    if (spec.now != null && !isFiniteNum(spec.now)) return { ok: false, reason: 'bad-params' };
    var unknown = Object.keys(spec).filter(function (k) {
      return !PATCH_FIELDS[k] && k !== 'now' && k !== 'id';
    });
    if (unknown.length) return { ok: false, reason: 'invalid-field', detail: unknown[0] };
    var value = {
      id: spec.id ? spec.id.trim() : null,
      text: text,
      kind: spec.kind,
      observed: str(spec.observed),
      inferred: str(spec.inferred),
      confirmed: str(spec.confirmed),
      question: str(spec.question),
      confidence: spec.confidence || DEFAULT_CONFIDENCE,
      topic: str(spec.topic),
      basis: spec.basis == null ? null : spec.basis,
      evidence: ev.value,
      source: src,
      revisedFrom: spec.revisedFrom || null
    };
    var bad = checkSemantics(value);
    if (bad) return { ok: false, reason: bad };
    return { ok: true, value: value };
  }

  // 校验修改参数 → { ok, reason, fields }；fields 为经过校验、可直接落库的变更集合。
  function validatePatch(patch) {
    if (!isObject(patch)) return { ok: false, reason: 'bad-params' };
    var keys = Object.keys(patch);
    if (!keys.length) return { ok: false, reason: 'empty-patch' };
    var unknown = keys.filter(function (k) { return !PATCH_FIELDS[k]; });
    if (unknown.length) return { ok: false, reason: 'invalid-field', detail: unknown[0] };
    var fields = {};
    if ('text' in patch) {
      var text = str(patch.text);
      if (!text) return { ok: false, reason: 'empty-text' };
      fields.text = text;
    }
    if ('kind' in patch) {
      if (!KIND_SET[patch.kind]) return { ok: false, reason: 'invalid-kind' };
      fields.kind = patch.kind;
    }
    if ('confidence' in patch) {
      if (!CONF_SET[patch.confidence]) return { ok: false, reason: 'invalid-confidence' };
      fields.confidence = patch.confidence;
    }
    for (var i = 0; i < TEXT_FIELDS.length; i++) {
      var f = TEXT_FIELDS[i];
      if (f in patch) fields[f] = str(patch[f]);
    }
    if ('source' in patch) {
      var src = normalizeSource(patch.source);
      if (!src) return { ok: false, reason: 'invalid-source' };
      fields.source = src;
    }
    if ('basis' in patch) {
      if (patch.basis != null && !BASIS_SET[patch.basis]) return { ok: false, reason: 'invalid-basis' };
      fields.basis = patch.basis == null ? null : patch.basis;
    }
    if ('evidence' in patch) {
      var ev = parseEvidence(patch.evidence);
      if (!ev.ok) return ev;
      fields.evidence = ev.value;
    }
    if ('revisedFrom' in patch) {
      if (patch.revisedFrom != null && (typeof patch.revisedFrom !== 'string' || !patch.revisedFrom)) {
        return { ok: false, reason: 'invalid-revised-from' };
      }
      fields.revisedFrom = patch.revisedFrom || null;
    }
    return { ok: true, fields: fields };
  }

  /* ---------------- 写入主流程（读最新 → 应用 → 校验 → 落库） ---------------- */

  function guardUntouched(before, after, allowed) {
    var allow = {};
    (allowed || []).forEach(function (id) { allow[id] = true; });
    var afterById = {};
    after.records.forEach(function (r) { afterById[r.id] = r; });
    for (var i = 0; i < before.records.length; i++) {
      var b = before.records[i];
      var a = afterById[b.id];
      if (!a) return { ok: false, detail: 'record-dropped:' + b.id };
      if (!allow[b.id] && canon(a) !== canon(b)) return { ok: false, detail: 'record-changed:' + b.id };
    }
    return { ok: true };
  }

  async function doMutate(store, fn, opts) {
    var raw;
    try { raw = await store.get(KEY); }
    catch (e) { return { ok: false, reason: 'read-failed', error: errText(e) }; }
    // 键存在但不合法：拒绝写入，原值原样保留，绝不「顺手修好」覆盖用户数据。
    if (raw != null && !isValidState(raw)) {
      return {
        ok: false, reason: 'state-invalid-kept',
        error: KEY + ' 已存在但结构不合法，已原样保留，本次操作未写入'
      };
    }
    var state = isValidState(raw) ? raw : emptyState(opts && opts.now);
    var out;
    try { out = fn(state); }
    catch (e) { return { ok: false, reason: 'apply-failed', error: errText(e) }; }
    if (!out || !out.ok) return out || { ok: false, reason: 'apply-failed' };
    if (!isValidState(out.state)) return { ok: false, reason: 'invalid-result' };
    var guard = guardUntouched(state, out.state, out.changed || []);
    if (!guard.ok) {
      return { ok: false, reason: 'unexpected-bulk-change', error: guard.detail };
    }
    try { await store.set(KEY, out.state); }
    catch (e) { return { ok: false, reason: 'write-failed', error: errText(e) }; }
    return out;
  }

  // 同一 store 上的写操作串行：避免并发读改写相互覆盖（只影响本次目标记录的内容）。
  function mutate(store, fn, opts) {
    if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') {
      return Promise.resolve({ ok: false, reason: 'bad-store', error: '需要注入 { get, set }' });
    }
    if (!MUTEX) return doMutate(store, fn, opts);
    var prior = MUTEX.get(store);
    var run = (prior ? prior.catch(function () { }) : Promise.resolve()).then(function () {
      return doMutate(store, fn, opts);
    });
    MUTEX.set(store, run.catch(function () { }));
    return run;
  }

  async function loadState(store) {
    if (!store || typeof store.get !== 'function') {
      return { ok: false, reason: 'bad-store', state: null, error: '需要注入 { get }' };
    }
    var raw;
    try { raw = await store.get(KEY); }
    catch (e) { return { ok: false, reason: 'read-failed', state: null, error: errText(e) }; }
    if (raw == null) return { ok: true, reason: 'empty', state: emptyState(), absent: true };
    if (!isValidState(raw)) {
      return {
        ok: false, reason: 'state-invalid-kept', state: null,
        error: KEY + ' 已存在但结构不合法，已原样保留'
      };
    }
    return { ok: true, reason: 'ok', state: raw, absent: false };
  }

  /* ---------------- 1. 新增 ---------------- */

  async function create(store, spec, opts) {
    var o = opts || {};
    return mutate(store, function (state) {
      var v = validateCreate(spec);
      if (!v.ok) return v;
      var now = nowOf(o.now != null ? o.now : (isObject(spec) ? spec.now : null));
      var prev = null;
      if (v.value.revisedFrom) {
        prev = byId(state, v.value.revisedFrom);
        if (!prev) return { ok: false, reason: 'invalid-revised-from', detail: v.value.revisedFrom };
      }
      var id = v.value.id || nextId(state, v.value.text + '|' + v.value.kind + '|' + now);
      if (byId(state, id)) return { ok: false, reason: 'duplicate-id', detail: id };
      var rec = makeRecord(Object.assign({}, v.value, { id: id, now: now }));
      var next = clone(state);
      next.records.push(rec);
      next.updatedAt = now;
      var changed = [id];
      // 明确标注「这条修订自旧记录」时：旧记录保留原样，只标记被取代，并留下修订前快照。
      if (prev) {
        var old = byId(next, prev.id);
        old.history.push(snapshotOf(old, old.updatedAt));
        old.supersededBy = id;
        if (old.status === 'active') old.status = 'superseded';
        old.updatedAt = now;
        changed.push(old.id);
      }
      return {
        ok: true, reason: 'created', state: next, id: id,
        record: clone(rec), revisedFrom: v.value.revisedFrom || null, changed: changed
      };
    }, o);
  }

  /* ---------------- 2. 读取 ---------------- */

  async function get(store, id) {
    if (typeof id !== 'string' || !id) return { ok: false, reason: 'invalid-id' };
    var s = await loadState(store);
    if (!s.ok) return { ok: false, reason: s.reason, error: s.error };
    var rec = byId(s.state, id);
    if (!rec) return { ok: false, reason: 'not-found', id: id };
    return { ok: true, reason: s.reason, id: id, record: clone(rec) };
  }

  function matchTopic(rec, topic) {
    if (!topic) return true;
    return rec.topic === topic;
  }

  async function list(store, filter) {
    var f = isObject(filter) ? filter : {};
    var status = f.status == null ? 'active' : f.status;
    if (status !== 'all' && !STATUS_SET[status]) return { ok: false, reason: 'invalid-status' };
    if (f.kind != null && !KIND_SET[f.kind]) return { ok: false, reason: 'invalid-kind' };
    if (f.confidence != null && !CONF_SET[f.confidence]) return { ok: false, reason: 'invalid-confidence' };
    if (f.since != null && !isFiniteNum(f.since)) return { ok: false, reason: 'bad-params' };
    if (f.until != null && !isFiniteNum(f.until)) return { ok: false, reason: 'bad-params' };
    if (f.limit != null && !(isFiniteNum(f.limit) && f.limit > 0)) return { ok: false, reason: 'bad-params' };

    var s = await loadState(store);
    if (!s.ok) return { ok: false, reason: s.reason, error: s.error };

    var topic = str(f.topic);
    var from = f.since, to = f.until;
    var rows = s.state.records.filter(function (r) {
      if (status !== 'all' && r.status !== status) return false;
      if (f.kind != null && r.kind !== f.kind) return false;
      if (f.confidence != null && r.confidence !== f.confidence) return false;
      if (!matchTopic(r, topic)) return false;
      if (from != null && r.createdAt < from) return false;
      if (to != null && r.createdAt > to) return false;
      return true;
    });
    rows.sort(function (a, b) {
      if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
      return b.createdAt - a.createdAt;
    });
    if (f.limit != null) rows = rows.slice(0, f.limit);
    return {
      ok: true, reason: s.reason, filter: f, total: rows.length,
      records: rows.map(clone)
    };
  }

  /* ---------------- 3. 修改（就地修订 + 历史快照） ---------------- */

  async function update(store, id, patch, opts) {
    var o = opts || {};
    if (typeof id !== 'string' || !id) return { ok: false, reason: 'invalid-id' };
    return mutate(store, function (state) {
      var rec = byId(state, id);
      if (!rec) return { ok: false, reason: 'not-found', id: id };
      if (rec.status === 'retracted') return { ok: false, reason: 'retracted-record', id: id };

      var v = validatePatch(patch);
      if (!v.ok) return v;
      var f = v.fields;
      if ('revisedFrom' in f && f.revisedFrom) {
        if (f.revisedFrom === id) return { ok: false, reason: 'invalid-revised-from', detail: 'self' };
        if (!byId(state, f.revisedFrom)) return { ok: false, reason: 'invalid-revised-from', detail: f.revisedFrom };
      }

      var changed = Object.keys(f).some(function (k) { return canon(f[k]) !== canon(rec[k]); });
      if (!changed) return { ok: false, reason: 'no-change', id: id };

      // 语义不变量要按「合并后的完整记录」检查：只改 confidence 也可能撞上既有 basis。
      var merged = Object.assign({}, rec, f);
      var bad = checkSemantics(merged);
      if (bad) return { ok: false, reason: bad, id: id };

      var now = nowOf(o.now);
      var next = clone(state);
      var target = byId(next, id);
      // 先按「这一版最后成立的时间」快照，再改内容：历史里保留的是修订前原文。
      target.history.push(snapshotOf(target, target.updatedAt));
      Object.keys(f).forEach(function (k) { target[k] = f[k]; });
      target.updatedAt = now;
      next.updatedAt = now;
      return {
        ok: true, reason: 'updated', state: next, id: id,
        record: clone(target), historyLength: target.history.length, changed: [id]
      };
    }, o);
  }

  /* ---------------- 4. 撤回（只改状态，不删除） ---------------- */

  async function retract(store, id, opts) {
    var o = opts || {};
    if (typeof id !== 'string' || !id) return { ok: false, reason: 'invalid-id' };
    return mutate(store, function (state) {
      var rec = byId(state, id);
      if (!rec) return { ok: false, reason: 'not-found', id: id };
      if (rec.status === 'retracted') return { ok: false, reason: 'already-retracted', id: id };
      var now = nowOf(o.now);
      var next = clone(state);
      var target = byId(next, id);
      target.history.push(snapshotOf(target, target.updatedAt));
      target.status = 'retracted';
      target.retractedAt = now;
      target.updatedAt = now;
      next.updatedAt = now;
      return {
        ok: true, reason: 'retracted', state: next, id: id,
        record: clone(target), changed: [id]
      };
    }, o);
  }

  /* ---------------- 5. 历史版本 ---------------- */

  function lineageIds(state, rec) {
    var ids = [], guard = {}, cur = rec;
    while (cur && !guard[cur.id]) {
      guard[cur.id] = true;
      ids.unshift(cur.id);
      cur = cur.revisedFrom ? byId(state, cur.revisedFrom) : null;
    }
    return ids;
  }

  function versionView(rec, snap) {
    if (!snap) {
      return {
        at: rec.updatedAt, text: rec.text, kind: rec.kind,
        observed: rec.observed, inferred: rec.inferred, confirmed: rec.confirmed,
        question: rec.question, confidence: rec.confidence, topic: rec.topic,
        // 与 makeRecord 的缺省一致：旧记录没有这两个字段时给 null / []，不推断、不回填。
        basis: rec.basis == null ? null : rec.basis,
        evidence: Array.isArray(rec.evidence) ? clone(rec.evidence) : [],
        source: clone(rec.source), status: rec.status, revisedFrom: rec.revisedFrom,
        recordId: rec.id, current: true
      };
    }
    return {
      at: snap.at, text: snap.text, kind: snap.kind,
      observed: snap.observed, inferred: snap.inferred, confirmed: snap.confirmed,
      question: snap.question, confidence: snap.confidence, topic: snap.topic,
      // 快照里存了 basis / evidence，这里必须带出来，否则修订前的证据链读不到。
      basis: snap.basis == null ? null : snap.basis,
      evidence: Array.isArray(snap.evidence) ? clone(snap.evidence) : [],
      source: clone(snap.source), status: snap.status, revisedFrom: snap.revisedFrom || null,
      recordId: rec.id, current: false
    };
  }

  // 该记录的全部版本（含 revisedFrom 链路），按时间从旧到新，最后一项是当前内容。
  async function historyOf(store, id) {
    if (typeof id !== 'string' || !id) return { ok: false, reason: 'invalid-id' };
    var s = await loadState(store);
    if (!s.ok) return { ok: false, reason: s.reason, error: s.error };
    var rec = byId(s.state, id);
    if (!rec) return { ok: false, reason: 'not-found', id: id };
    var chain = lineageIds(s.state, rec);
    var versions = [];
    chain.forEach(function (rid) {
      var r = byId(s.state, rid);
      (r.history || []).forEach(function (snap) { versions.push(versionView(r, snap)); });
      versions.push(versionView(r, null));
    });
    return {
      ok: true, reason: 'ok', id: id, lineage: chain,
      revisions: versions.length - 1, versions: versions,
      versionsOfRecord: (rec.history || []).length,
      current: clone(rec)
    };
  }

  /* ---------------- 6. 按来源定位 ---------------- */

  function matchSource(src, query) {
    if (!isValidSource(src) || query == null) return false;
    // 聊天消息 ID 在房间里是数字，这里统一按字符串比对，数字/字符串都能定位。
    if (typeof query === 'string' || typeof query === 'number') {
      var q = String(query);
      if (!q) return false;
      return SOURCE_KEYS.some(function (k) {
        return src[k] != null && String(src[k]) === q;
      });
    }
    if (!isObject(query)) return false;
    if (query.kind != null && src.kind !== query.kind) return false;
    var compared = false;
    var keys = Object.keys(query).filter(function (k) { return SOURCE_KEYS.indexOf(k) !== -1; });
    if (!keys.length) return query.kind != null;
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (query[k] == null || query[k] === '') continue;
      compared = true;
      if (src[k] == null || String(src[k]) !== String(query[k])) return false;
    }
    return compared;
  }

  async function bySource(store, query, opts) {
    var o = isObject(opts) ? opts : {};
    if (query == null || query === '') return { ok: false, reason: 'bad-params' };
    if (o.status != null && o.status !== 'all' && !STATUS_SET[o.status]) {
      return { ok: false, reason: 'invalid-status' };
    }
    var s = await loadState(store);
    if (!s.ok) return { ok: false, reason: s.reason, error: s.error };
    var rows = s.state.records.filter(function (r) {
      if (o.status && o.status !== 'all' && r.status !== o.status) return false;
      return matchSource(r.source, query);
    });
    rows.sort(function (a, b) { return b.updatedAt - a.updatedAt; });
    return { ok: true, reason: s.reason, query: query, total: rows.length, records: rows.map(clone) };
  }

  /* ---------------- 7. 重复识别 ---------------- */

  function normalizeText(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/[\s\u3000]+/g, '')
      .replace(/[，。！？、；：""''（）《》〈〉【】…—～·,\.!\?;:'"()\[\]<>\/\\|`~@#$%^&*+=_\-]/g, '');
  }

  function bigrams(s) {
    var out = [];
    for (var i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
    if (!out.length && s.length) out.push(s);
    return out;
  }

  // 字符二元组 Jaccard：0~1，确定性，无外部依赖。
  function similarity(a, b) {
    if (a === b) return 1;
    if (!a || !b) return 0;
    var A = bigrams(a), B = bigrams(b);
    var setA = {}, setB = {}, i;
    for (i = 0; i < A.length; i++) setA[A[i]] = true;
    for (i = 0; i < B.length; i++) setB[B[i]] = true;
    var inter = 0, union = 0, k;
    for (k in setA) { union += 1; if (setB[k]) inter += 1; }
    for (k in setB) { if (!setA[k]) union += 1; }
    return union ? inter / union : 0;
  }

  function sameLineage(a, b) {
    if (!a || !b) return false;
    return a.id === b.id || a.revisedFrom === b.id || b.revisedFrom === a.id || a.supersededBy === b.id || b.supersededBy === a.id;
  }

  /**
   * 重复识别：同文（去空白/标点后完全相同）→ same-text；
   * 同一 kind 且相似度 ≥ 阈值 → similar-text。只报告，不合并、不删除。
   * opts: { status:'active'|'all', threshold }
   */
  async function duplicates(store, opts) {
    var o = isObject(opts) ? opts : {};
    var status = o.status == null ? 'active' : o.status;
    if (status !== 'all' && !STATUS_SET[status]) return { ok: false, reason: 'invalid-status' };
    var threshold = isFiniteNum(o.threshold) ? o.threshold : DUP_SIMILARITY;
    if (!(threshold > 0 && threshold <= 1)) return { ok: false, reason: 'bad-params' };

    var s = await loadState(store);
    if (!s.ok) return { ok: false, reason: s.reason, error: s.error };
    var rows = s.state.records.filter(function (r) { return status === 'all' || r.status === status; });

    var groups = [];
    var grouped = {};
    rows.forEach(function (r) {
      var key = normalizeText(r.text);
      if (!key) return;
      if (!grouped[key]) { grouped[key] = { key: key, reason: 'same-text', ids: [], text: r.text }; groups.push(grouped[key]); }
      grouped[key].ids.push(r.id);
    });
    var out = groups.filter(function (g) { return g.ids.length > 1; });

    // 相似但不完全相同：按 kind 分组比较，跳过已在同文组里的和同一修订链上的
    var byKind = {};
    rows.forEach(function (r) {
      byKind[r.kind] = byKind[r.kind] || [];
      byKind[r.kind].push(r);
    });
    Object.keys(byKind).forEach(function (kind) {
      var arr = byKind[kind];
      for (var i = 0; i < arr.length; i++) {
        for (var j = i + 1; j < arr.length; j++) {
          var a = arr[i], b = arr[j];
          if (sameLineage(a, b)) continue;
          if (normalizeText(a.text) === normalizeText(b.text)) continue;
          var score = similarity(normalizeText(a.text), normalizeText(b.text));
          if (score >= threshold) {
            out.push({
              key: 'similar:' + a.id + '|' + b.id, reason: 'similar-text',
              ids: [a.id, b.id], score: Math.round(score * 1000) / 1000, text: a.text
            });
          }
        }
      }
    });
    return { ok: true, reason: s.reason, threshold: threshold, count: out.length, groups: out };
  }

  // 单条记录的重复查询：返回与它重复或相近的其它记录。
  async function duplicatesOf(store, id, opts) {
    if (typeof id !== 'string' || !id) return { ok: false, reason: 'invalid-id' };
    var o = isObject(opts) ? opts : {};
    var all = await duplicates(store, { status: o.status == null ? 'all' : o.status, threshold: o.threshold });
    if (!all.ok) return all;
    var s = await loadState(store);
    if (!s.ok) return { ok: false, reason: s.reason, error: s.error };
    var rec = byId(s.state, id);
    if (!rec) return { ok: false, reason: 'not-found', id: id };
    var matches = [];
    all.groups.forEach(function (g) {
      if (g.ids.indexOf(id) === -1) return;
      g.ids.forEach(function (other) {
        if (other === id) return;
        matches.push({ id: other, reason: g.reason, score: g.score == null ? 1 : g.score });
      });
    });
    return { ok: true, reason: 'ok', id: id, matches: matches };
  }

  /* ---------------- 8. 聊天上下文按需注入（P0-3，纯函数） ----------------
   * 只从调用方传入的「active 正式记录」里，按当前消息做话题相关筛选，
   * 返回少量片段供 app.js 的 buildDynamicOnDemand 拼进系统提示词。
   * 硬约束：
   *   - 这里不读任何库、不写任何数据；记录由调用方（app.js 经 list({status:'active'})）传入；
   *   - 再筛一次 status==='active'，retracted / superseded 一律不注入；
   *   - 原样保留 kind / basis / 第一人称主观视角，不把感受改写成用户的客观属性；
   *   - question 明确标注为「尚未弄清的疑问，别当成事实」；
   *   - 命中少量（默认最多 3 条）、单条截断，绝不把全部机自述塞进上下文；
   *   - 会话去重由调用方传入 isSent(key) 判定（复用 PersonaMemory 的 markSent）；
   *     明确追问（opts.allowResent === true）时忽略 isSent，允许再次注入，避免用户追问时
   *     因同一会话已成功注入过而「明明相关却什么都没带进来」；
   *     opts.suppressIds（id 数组）用于纠正语境临时抑制：被用户指出可能记错的旧认识不当成
   *     确定事实继续召回；这只是会话级临时过滤，不写任何正式数据。
   */
  var CONTEXT_MAX_ITEMS = 3;
  var CONTEXT_CLIP = 180;

  function contextClip(s) {
    var v = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return v.length > CONTEXT_CLIP ? v.slice(0, CONTEXT_CLIP) + '…' : v;
  }

  // 话题相关（收紧版）：避免「是不是 / 之前 / 觉得」这类宽泛共同字词把弱相关记录带进上下文。
  //   1) query 的 4 字连续片段命中正文语义字段（text/observed/inferred/question）才算相关；
  //   2) topic 是作者自己写的主题词，信号更强：query 含完整 topic（≥2 字）或命中其 3 字片段即可；
  //   3) 取消原来的「2 字滑窗命中≥2 处」——那是弱相关的主要来源，已移除。
  // 空 query / 空字段一律不命中。
  function contextRelated(query, rec) {
    var q = normalizeText(query);
    if (!q || !isObject(rec)) return false;
    var body = ['text', 'observed', 'inferred', 'question'].map(function (f) {
      return rec[f] == null ? '' : normalizeText(rec[f]);
    }).join('');
    var i;
    if (body) {
      for (i = 0; i + 4 <= q.length; i++) {
        if (body.indexOf(q.slice(i, i + 4)) !== -1) return true;
      }
    }
    var topic = rec.topic == null ? '' : normalizeText(rec.topic);
    if (topic.length >= 2) {
      if (q.indexOf(topic) !== -1) return true;
      for (i = 0; i + 3 <= q.length; i++) {
        if (topic.indexOf(q.slice(i, i + 3)) !== -1) return true;
      }
    }
    return false;
  }

  /**
   * contextPart(text, records, opts) → { text, keys, count, reason }
   * opts: { limit, isSent(key)->bool, maxChars }
   */
  function contextPart(text, records, opts) {
    var o = isObject(opts) ? opts : {};
    var limit = isFiniteNum(o.limit) ? Math.max(1, Math.floor(o.limit)) : CONTEXT_MAX_ITEMS;
    var maxChars = isFiniteNum(o.maxChars) && o.maxChars > 0 ? o.maxChars : 1200;
    var isSent = typeof o.isSent === 'function' ? o.isSent : function () { return false; };
    var allowResent = o.allowResent === true;   // 明确追问：忽略会话去重，允许再次注入
    var suppress = {};
    (Array.isArray(o.suppressIds) ? o.suppressIds : []).forEach(function (id) {
      if (id != null) suppress[String(id)] = true;
    });
    var list = (Array.isArray(records) ? records : []).filter(function (r) {
      return isObject(r) && r.status === 'active' && !suppress[String(r.id)];
    });
    if (!list.length) return { text: '', keys: [], count: 0, reason: 'no-active' };

    var picked = [];
    var used = 0;
    for (var i = 0; i < list.length && picked.length < limit; i++) {
      var r = list[i];
      var key = 'selfNarrative:' + r.id;
      if (!allowResent && isSent(key)) continue;
      if (!contextRelated(text, r)) continue;
      var label = KIND_LABELS[r.kind] || r.kind;
      var basis = BASIS_LABELS[r.basis] || (r.basis == null ? '' : r.basis);
      var pieces = [];
      if (r.observed) pieces.push('看到：' + contextClip(r.observed));
      if (r.inferred) pieces.push('推测：' + contextClip(r.inferred));
      if (r.question) pieces.push('疑问：' + contextClip(r.question));
      var head = '· [' + label + (basis ? ' / ' + basis : '') + '] ' + contextClip(r.text);
      if (pieces.length) head += '（' + pieces.join('；') + '）';
      if (r.kind === 'question') head += '（这是他还没弄清的疑问，别当成事实。）';
      var line = head + '\n';
      if (used + line.length > maxChars && picked.length) break;
      used += line.length;
      picked.push({ key: key, line: line });
    }
    if (!picked.length) return { text: '', keys: [], count: 0, reason: 'no-match' };
    return {
      text: '\n【机自述 · 小星眼中的用户（他的主观观察与感受，不是用户的客观属性；按此刻话题取少量，未命中不要编造）】\n' +
        picked.map(function (p) { return p.line; }).join(''),
      keys: picked.map(function (p) { return p.key; }),
      count: picked.length, reason: 'ok'
    };
  }

  var api = {
    KEY: KEY,
    SCHEMA: SCHEMA,
    KINDS: KINDS.slice(),
    KIND_LABELS: Object.assign({}, KIND_LABELS),
    CONFIDENCES: CONFIDENCES.slice(),
    BASES: BASES.slice(),
    STATUSES: STATUSES.slice(),
    STATUS_LABELS: Object.assign({}, STATUS_LABELS),
    DEFAULT_CONFIDENCE: DEFAULT_CONFIDENCE,
    DUP_SIMILARITY: DUP_SIMILARITY,

    // 纯函数（供测试与其他层复用）
    emptyState: emptyState,
    makeRecord: makeRecord,
    isValidRecord: isValidRecord,
    isValidState: isValidState,
    isValidSource: isValidSource,
    isValidEvidenceList: isValidEvidenceList,
    parseEvidence: parseEvidence,
    checkSemantics: checkSemantics,
    normalizeSource: normalizeSource,
    normalizeText: normalizeText,
    similarity: similarity,
    fingerprint: fingerprint,
    matchSource: matchSource,
    lineageIds: lineageIds,

    // 数据操作
    create: create,
    get: get,
    list: list,
    update: update,
    retract: retract,
    historyOf: historyOf,
    bySource: bySource,
    duplicates: duplicates,
    duplicatesOf: duplicatesOf,
    contextPart: contextPart,
    contextRelated: contextRelated
  };

  root.SelfNarrative = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
