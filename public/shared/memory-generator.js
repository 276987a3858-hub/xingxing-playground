/* public/shared/memory-generator.js — 长期记忆第二阶段：结构化操作生成 + 程序验证执行
 * 核心原则：AI 只提出 add / revise / retract 逐条操作；程序负责验证、执行、持久化。
 *   - AI 无权编造来源 ID / 时间 / 确认状态 / 元数据：这些全部由程序按真实来源记录补齐。
 *   - 每条操作独立执行，单条失败不影响其他有效操作。
 *   - 证据不足 / 模糊冲突 → 保留原记忆；用户明确纠正优先。
 *   - 不写旧 longTermMemory；不新增常驻/后台调用；只读注入的资料。
 * 依赖第一阶段 window.LongTermMemoryV2（保留其 ID / 来源 / history 机制）。
 * 暴露 window.MemoryGenerator / globalThis.MemoryGenerator。
 */
(function (root) {
  'use strict';

  var ALLOWED_OP = { add: true, revise: true, retract: true };
  var ALLOWED_CATEGORY = {
    preference: true, fact: true, agreement: true, event: true,
    relation: true, habit: true, other: true
  };
  var CONFIDENCE = { high: true, medium: true, low: true };

  function V2() { return root.LongTermMemoryV2 || null; }
  function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function textOf(x) { return String(x == null ? '' : x); }

  /* ---------------- 解析 AI 输出（容错） ---------------- */
  function parseReply(reply) {
    var s = String(reply == null ? '' : reply).trim();
    if (!s) return { ok: false, reason: 'empty-reply' };
    var json = s;
    var fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) {
      json = fence[1].trim();
    } else {
      var a = s.indexOf('{'), b = s.lastIndexOf('}');
      var aa = s.indexOf('['), bb = s.lastIndexOf(']');
      if (a >= 0 && b > a) json = s.slice(a, b + 1);
      else if (aa >= 0 && bb > aa) json = s.slice(aa, bb + 1);
    }
    var obj;
    try { obj = JSON.parse(json); } catch (e) { return { ok: false, reason: 'parse-failed' }; }
    var raw = Array.isArray(obj) ? obj : (obj && Array.isArray(obj.ops) ? obj.ops : null);
    if (!raw) return { ok: false, reason: 'wrong-shape' };
    var ops = [];
    for (var i = 0; i < raw.length; i++) {
      var x = raw[i];
      if (!x || typeof x !== 'object' || Array.isArray(x)) continue;
      ops.push({
        op: String(x.op || x.type || '').toLowerCase(),
        id: x.id != null ? String(x.id) : undefined,
        text: x.text != null ? String(x.text) : undefined,
        category: x.category != null ? String(x.category) : undefined,
        sourceType: x.sourceType != null ? String(x.sourceType) : undefined,
        sourceId: x.sourceId != null ? String(x.sourceId) : undefined,
        evidence: x.evidence != null ? String(x.evidence) : undefined,
        confidence: x.confidence != null ? String(x.confidence).toLowerCase() : undefined,
        reason: x.reason != null ? String(x.reason) : undefined
      });
    }
    return { ok: true, ops: ops };
  }

  /* ---------------- 来源索引（只认真实记录，杜绝编造 ID / 时间） ---------------- */
  function indexSources(sources) {
    sources = sources || {};
    var map = new Map();
    var rawIds = new Map();
    function add(prefix, arr) {
      (Array.isArray(arr) ? arr : []).forEach(function (r) {
        if (!r || r.id == null) return;
        var id = String(r.id);
        var rec = {
          kind: prefix,
          id: id,
          at: (typeof r.time === 'number' ? r.time : (typeof r.createdAt === 'number' ? r.createdAt : (typeof r.at === 'number' ? r.at : null)))
        };
        var full = prefix + ':' + id;
        if (!map.has(full)) map.set(full, rec);
        var count = (rawIds.get(id) || 0) + 1;
        rawIds.set(id, count);
        if (count === 1 && !map.has(id)) map.set(id, rec);
        else if (count > 1) map.delete(id);   // 裸 ID 有歧义 → 只接受带前缀形式
      });
    }
    add('msg', sources.messages);
    add('diary', sources.diaries);
    add('keep', sources.keeps);
    return map;
  }

  function lastUserText(sources) {
    var msgs = sources && Array.isArray(sources.messages) ? sources.messages : [];
    for (var i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i] && msgs[i].role === 'user') return textOf(msgs[i].content);
    }
    return '';
  }
  // 本地检测用户明确纠正（0 请求）：命中时放宽 revise/retract 的证据门槛，但目标 ID 仍须真实存在。
  function detectUserCorrection(text) {
    var s = String(text || '');
    return /(不是.{0,12}而是|我说错|你记错|记错了|其实不是|不对[，,。 ]|我改主意|我不再|不再是|取消刚才|别记这条|算我说错)/.test(s);
  }

  /* ---------------- 逐条验证 + 执行 ---------------- */
  function hasLongTermValue(text) {
    var t = norm(text);
    if (t.length < 4) return false;
    if (/^[\s\p{P}\p{S}]+$/u.test(t)) return false;
    if (/(用户|AI|助手|语言模型)/.test(t)) return false;
    return true;
  }

  function validateOp(op, ctx, state) {
    if (!op || !ALLOWED_OP[op.op]) return { ok: false, reason: 'unknown-op' };

    if (op.op === 'add') {
      if (!hasLongTermValue(op.text)) return { ok: false, reason: 'no-long-term-value' };
      if (!ALLOWED_CATEGORY[op.category]) return { ok: false, reason: 'invalid-category' };
      if (!norm(op.evidence)) return { ok: false, reason: 'no-evidence' };
      if (op.confidence === 'low') return { ok: false, reason: 'insufficient-evidence' };

      var src = { kind: op.sourceType || 'manual', confirm: 'unverified', evidence: norm(op.evidence) };
      var found = null;
      if (norm(op.sourceId)) {
        found = ctx.sourceIndex.get(norm(op.sourceId)) || null;
        if (!found) return { ok: false, reason: 'unknown-source-id' };  // AI 编造来源 → 拒绝
        src.kind = op.sourceType || found.kind;
        src.sourceType = found.kind;
        src.sourceId = found.id;
        src.sourceAt = found.at;   // 时间取自真实记录，不用 AI 给的
        src.idKind = 'source';
      } else {
        src.idKind = 'content';
      }
      var spec = { text: op.text, category: op.category, source: src, status: 'active', now: ctx.now };
      var V = V2();
      var probe = V.makeEntry(Object.assign({}, spec, { now: ctx.now }));
      // 同一来源 + 同一正文（规范化后）不重复；不同来源的相似内容一律保留。
      for (var i = 0; i < state.entries.length; i++) {
        var e = state.entries[i];
        var sameText = norm(e.text) === norm(probe.text);
        var sameId = e.id === probe.id;
        var sameSrc = !!(e.source && probe.source && e.source.sourceId && e.source.sourceId === probe.source.sourceId);
        if (sameId || (sameText && sameSrc)) return { ok: false, reason: 'duplicate' };
      }
      return { ok: true, type: 'add', spec: spec };
    }

    // revise / retract：目标真实存在 + 证据 + 理由；模糊冲突保留原记忆
    if (!op.id) return { ok: false, reason: 'missing-id' };
    var target = null;
    for (var j = 0; j < state.entries.length; j++) {
      if (state.entries[j].id === op.id) { target = state.entries[j]; break; }
    }
    if (!target) return { ok: false, reason: 'invalid-id' };
    if (target.status !== 'active') return { ok: false, reason: 'protected-entry' };
    // 用户手动录入/编辑的条目优先于 AI 自动整理：AI 不得改写或撤回，
    // 除非本轮用户在聊天里又一次明确纠正（userCorrection）。
    if (target.source && target.source.manual === true &&
        ctx.fromAI !== false && !ctx.userCorrection) {
      return { ok: false, reason: 'manual-protected' };
    }
    if (!norm(op.evidence)) return { ok: false, reason: 'no-evidence' };
    if (op.confidence === 'low') return { ok: false, reason: 'insufficient-evidence' };
    if (op.confidence === 'medium' && !ctx.userCorrection) {
      return { ok: false, reason: 'vague-conflict-preserved' };
    }

    if (op.op === 'retract') {
      if (!norm(op.reason)) return { ok: false, reason: 'no-reason' };
      return { ok: true, type: 'retract', id: op.id };
    }

    // revise
    if (!hasLongTermValue(op.text)) return { ok: false, reason: 'no-long-term-value' };
    var patch = { text: op.text, now: ctx.now };
    if (ALLOWED_CATEGORY[op.category]) patch.category = op.category;
    patch.source = {
      kind: (target.source && target.source.kind) || 'correction',
      confirm: 'unverified',
      evidence: norm(op.evidence),
      reason: norm(op.reason) || undefined,
      correctedByUser: ctx.userCorrection ? true : undefined
    };
    return { ok: true, type: 'revise', id: op.id, patch: patch };
  }

  function applyBatch(state, ops, ctx) {
    var V = V2();
    var cur = state;
    var applied = [], rejected = [];
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      var v;
      try { v = validateOp(op, ctx, cur); }
      catch (e) { rejected.push({ index: i, op: op.op, reason: 'validate-error' }); continue; }
      if (!v.ok) { rejected.push({ index: i, op: op.op, reason: v.reason }); continue; }

      var next = null;
      try {
        if (v.type === 'add') next = V.reserved.addEntry(cur, v.spec);
        else if (v.type === 'revise') next = V.reserved.reviseEntry(cur, v.id, v.patch);
        else if (v.type === 'retract') next = V.reserved.retractEntry(cur, v.id, ctx.now);
      } catch (e) { next = null; }
      if (!next || !V.isValidState(next)) {
        rejected.push({ index: i, op: op.op, reason: 'execute-failed' });
        continue;
      }
      cur = next;
      applied.push({
        index: i,
        op: v.type,
        id: v.type === 'add' ? cur.entries[cur.entries.length - 1].id : v.id
      });
    }
    return { state: cur, applied: applied, rejected: rejected };
  }

  /* ---------------- 提示词 ---------------- */
  function buildPrompt(ctx) {
    var state = ctx.state;
    var lines = [];
    lines.push('你现在是《恋与深空》的小星。请从下面提供的【真实资料】中，为长期记忆提出逐条操作。');
    lines.push('【铁律】');
    lines.push('1. 你只能输出操作，不能输出整段记忆，也不能重写或覆盖记忆库。');
    lines.push('2. 只记录已经发生过的事、稳定偏好和双方约定；用第一人称（我）写正文，称呼她用“她 / 你 / 搭档”，禁止“用户 / AI / 助手”。');
    lines.push('3. 禁止编造来源 ID、时间、确认状态或其他元数据。sourceId 只能填【可用来源】里出现的完整编号；没有就留空字符串。');
    lines.push('4. 每条操作必须给出 evidence（支撑该条的原文出处）与 confidence（high / medium / low）。证据不足或对旧记忆的模糊修改一律不要提交。');
    lines.push('5. 用户明确纠正时允许 revise / retract，必须在 reason 写明纠正依据。标注「手动」的条目是用户在设置页亲自编辑的，除非用户本轮又明确纠正，否则不要 revise / retract。已撤回或归档的条目不要操作。');
    lines.push('6. 不同来源提供的相似内容请分别保留，不要简单合并；无法判断是否重复时宁可保留。');
    lines.push('');
    lines.push('【输出格式】只输出一个 JSON 对象，不要解释文字、不要 markdown 以外的内容：');
    lines.push('{"ops":[{"op":"add","text":"...","category":"preference|fact|agreement|event|relation|habit|other","sourceType":"chat|diary|keep","sourceId":"msg:12 或留空","evidence":"原文出处","confidence":"high|medium|low","reason":""}]}');
    lines.push('revise / retract 需额外给 "id":"<现有记忆ID>" 与 "reason":"..."（retract 必填）。');
    lines.push('');
    lines.push('【可用来源】');
    var s = ctx.sources || {};
    (['messages', 'diaries', 'keeps']).forEach(function (k) {
      var arr = Array.isArray(s[k]) ? s[k] : [];
      if (!arr.length) return;
      var prefix = k === 'messages' ? 'msg' : (k === 'diary' ? 'diary' : 'keep');
      if (k === 'diaries') prefix = 'diary';
      if (k === 'keeps') prefix = 'keep';
      lines.push('· ' + k + ':');
      arr.slice(-40).forEach(function (r) {
        var id = r && r.id != null ? String(r.id) : '?';
        var body = norm(r && (r.content != null ? r.content : r.text) || r && r.title || '');
        if (body.length > 160) body = body.slice(0, 160) + '…';
        lines.push('  - ' + prefix + ':' + id + ' | ' + body);
      });
    });
    lines.push('');
    lines.push('【现有记忆（只能引用其中的 id，不能改造）】');
    if (!state.entries.length) {
      lines.push('（暂无条目）');
    } else {
      state.entries.forEach(function (e) {
        var manualMark = (e.source && e.source.manual) ? '/手动' : '';
        lines.push('  - ' + e.id + ' [' + e.status + '/' + e.category + manualMark + '] ' + norm(e.text).slice(0, 120));
      });
    }
    if (ctx.userCorrection) lines.push('【本轮信号】用户明确纠正了此前的说法，请据此提出 revise / retract。');
    return lines.join('\n');
  }

  /* ---------------- 主编排 ---------------- */
  async function run(params) {
    params = params || {};
    var V = V2();
    var out = {
      ok: false, reason: '', proposed: [], applied: [], rejected: [],
      state: null, wrote: false, initialized: false, error: null
    };
    if (!V || !params.store || typeof params.store.get !== 'function' ||
        typeof params.store.set !== 'function' || typeof params.ai !== 'function') {
      out.reason = 'bad-params';
      return out;
    }
    var now = params.now;
    var store = params.store;

    // 1) 读取 / 确保 v2 状态（幂等；初始化只写新键，不动旧记忆）
    var state;
    try {
      var existing = await store.get(V.V2_KEY);
      if (V.isValidState(existing)) {
        state = existing;
      } else {
        var init = await V.initialize(store, { now: now });
        out.initialized = !!(init && init.initialized);
        if (out.initialized && V.isValidState(init.state && init.state.entries ? init.state : null)) {
          state = init.state;
        } else {
          var legacyRaw = await store.get(V.LEGACY_KEY);
          state = V.parseLegacy(legacyRaw, { now: now });   // 写失败也不影响本轮推理
        }
        if (!V.isValidState(state)) { out.reason = 'state-invalid'; return out; }
      }
    } catch (e) {
      out.reason = 'state-read-failed';
      out.error = String((e && e.message) || e);
      return out;
    }

    // 2) 调 AI（超时 / 异常由注入方控制，这里一律吞掉，不动任何数据）
    var reply;
    try {
      reply = await params.ai([
        { role: 'system', content: buildPrompt({
          state: state, sources: params.sources, now: now,
          userCorrection: !!(params.signals && params.signals.userCorrection)
        }) },
        { role: 'user', content: '只输出 JSON 操作对象，不要解释。' }
      ]);
    } catch (e) {
      out.reason = 'ai-error';
      out.error = String((e && e.message) || e);
      out.state = state;
      return out;
    }

    // 3) 解析
    var parsed = parseReply(reply);
    if (!parsed.ok) {
      out.reason = parsed.reason;
      out.state = state;
      return out;
    }
    out.proposed = parsed.ops.slice();
    if (!parsed.ops.length) {
      out.ok = true;
      out.reason = 'no-ops';
      out.state = state;
      return out;
    }

    // 4) 逐条验证 + 独立执行
    var ctx = {
      now: now,
      fromAI: true,   // 本模块是 AI 整理入口；手动条目默认受保护
      sourceIndex: indexSources(params.sources),
      userCorrection: !!(params.signals && params.signals.userCorrection) ||
        detectUserCorrection(lastUserText(params.sources))
    };
    var batch = applyBatch(state, parsed.ops, ctx);
    out.state = batch.state;
    out.applied = batch.applied;
    out.rejected = batch.rejected;

    // 5) 有成功操作才写 v2 新键；绝不写旧 longTermMemory
    if (batch.applied.length) {
      try {
        await store.set(V.V2_KEY, batch.state);
        out.wrote = true;
        out.ok = true;
        out.reason = 'applied';
      } catch (e) {
        out.reason = 'write-failed';
        out.error = String((e && e.message) || e);
      }
    } else {
      out.ok = true;
      out.reason = 'all-rejected';
    }
    return out;
  }

  // 设置页只读展示：把 active 条目拼成可读文本，不改动原始数据。
  function viewText(state) {
    if (!state || !Array.isArray(state.entries)) return '';
    return state.entries.filter(function (e) {
      return e && e.status === 'active' && !(e.source && e.source.mirrorOfBaseline);
    }).map(function (e) { return '· ' + norm(e.text); }).join('\n');
  }

  var api = {
    parseReply: parseReply,
    indexSources: indexSources,
    detectUserCorrection: detectUserCorrection,
    hasLongTermValue: hasLongTermValue,
    validateOp: validateOp,
    applyBatch: applyBatch,
    buildPrompt: buildPrompt,
    run: run,
    viewText: viewText
  };
  root.MemoryGenerator = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
