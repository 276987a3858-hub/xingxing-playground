/* public/shared/self-narrative-review.js — 机自述历史回顾的纯函数层（S1b）
 * ------------------------------------------------------------------
 * 本文件只做四件事，全部是纯函数：
 *   1. 分批：按 message id 升序切「日段」，给每批挂上上下文消息；
 *   2. 提问：把一批消息拼成提示词；
 *   3. 校验：把 AI 吐回来的结构逐条核对（来源必须真实、quote 必须能对上原文）；
 *   4. 判重：按「证据集合 + kind + 规范化后的认识内容」判断是否已经生成过。
 *
 * 不做的事（明确边界）：
 *   - 不读 IndexedDB / 不读文件 / 不调用 AI / 不写任何数据 / 不碰 DOM；
 *   - 不认识 selfNarrative 的存储，也不导入 app.js 的任何东西；
 *   - 不建立扫描水位、不加定时任务。
 *
 * 设计要点：
 *   - 分批只依赖 id 升序（唯一保证有序的维度）。同一天若因时间交错被切成多段，
 *     就是多个批次；每个 id 恰好属于一个批次，因此不会漏读也不会重复处理。
 *   - 上下文消息（ctx）可以出现在 evidence 里 —— 真实证据不因跨批而丢弃；
 *     但「整条记录只靠上下文」的记录会被判为重复候选，由调用方跳过。
 *   - 去重不因 evidence 有交集就判重：同一条消息可以支撑多条不同的认识。
 *
 * 暴露 window.SelfNarrativeReview / globalThis.SelfNarrativeReview。
 */
(function (root) {
  'use strict';

  var KINDS = ['observation', 'impression', 'inference', 'question'];
  var KIND_SET = { observation: true, impression: true, inference: true, question: true };
  var CONFIDENCES = ['low', 'medium', 'high'];
  var CONF_SET = { low: true, medium: true, high: true };
  var BASES = ['stated', 'observed', 'inferred'];
  var BASIS_SET = { stated: true, observed: true, inferred: true };

  var DEFAULTS = {
    ctxSize: 2,          // 每批带上的上下文条数（来自上一批末尾）
    maxChars: 12000,     // 单批正文总字数上限
    maxItems: 200,       // 单批消息条数上限
    contentMax: 300,     // 提示词里单条正文的截断长度
    quoteMin: 2          // quote 最少字符数（太短等于没核验）
  };

  /* ---------------- 基础工具 ---------------- */

  function isObj(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
  function isNum(n) { return typeof n === 'number' && isFinite(n); }
  function str(v) { return String(v == null ? '' : v).trim(); }

  // 只去空白：核验 quote 时不能连标点一起吃掉，否则「差不多」也会被当成命中。
  function normWs(s) { return String(s == null ? '' : s).replace(/\s+/g, ''); }

  // 判重用的规范化：去空白 + 去常见中英标点 + 转小写。只用于「认识内容是否同一句」。
  var PUNCT = /[\s\u3000，。、；：！？…—－·「」『』（）《》〈〉【】〔〕“”‘’"'`~!@#$%^&*()\-_=+\[\]{}\\|;:,.<>/?]/g;
  function normText(s) {
    return String(s == null ? '' : s).replace(PUNCT, '').toLowerCase();
  }

  function uniqStrings(arr) {
    var seen = {}, out = [];
    arr.forEach(function (v) {
      var k = String(v);
      if (seen[k]) return;
      seen[k] = true;
      out.push(k);
    });
    return out;
  }

  /* ---------------- 1. 日期归属 ---------------- */

  /**
   * 绝对毫秒 → 本地日期键（YYYY-MM-DD）。
   * tzOffsetMin 是「东为正」的时区偏移分钟数（UTC+8 = 480）。
   * 必须能显式传入：否则不同机器 / 不同浏览器默认时区会让分批结果不一致。
   */
  function dayKeyOf(timeMs, tzOffsetMin) {
    if (!isNum(timeMs)) return null;
    var off = isNum(tzOffsetMin) ? tzOffsetMin : -(new Date(timeMs).getTimezoneOffset());
    return new Date(timeMs + off * 60000).toISOString().slice(0, 10);
  }

  /** 取本批数据应使用的时区偏移：优先用调用方给的，否则按第一条消息的本地时区。 */
  function resolveTzOffset(messages, explicit) {
    if (isNum(explicit)) return explicit;
    if (Array.isArray(messages) && messages.length && isNum(messages[0].time)) {
      return -(new Date(messages[0].time).getTimezoneOffset());
    }
    return 0;
  }

  /* ---------------- 2. 分批 ---------------- */

  function pick(m, ctxWhere) {
    var out = {
      id: m.id,
      role: m.role,
      content: typeof m.content === 'string' ? m.content : '',
      time: m.time
    };
    if (m.source != null) out.source = m.source;
    if (m.sourceId != null) out.sourceId = m.sourceId;
    if (m.silent) out.silent = true;
    if (m.type != null) out.type = m.type;
    if (ctxWhere) out.ctx = ctxWhere;
    return out;
  }

  function idKey(v) { return String(v); }

  /**
   * 按 id 升序把消息切成批次。
   * 规则：
   *   - 同一批次内所有消息属于同一本地日期；日期一变就切段；
   *   - 超过 maxChars / maxItems 也切段（单条超长消息自己独占一批，保证游标必前进）；
   *   - 切点若正好把「user + 它的 assistant 回复」分开，把那条回复也挂到前一批的 ctx 里，
   *     但它仍然属于后一批（fresh），不会产生两条记录。
   *
   * 返回 { ok, reason, batches, stats }；入参不合法一律明确报错，不静默补默认值。
   */
  function planBatches(messages, opts) {
    var o = opts || {};
    var ctxSize = isNum(o.ctxSize) && o.ctxSize >= 0 ? Math.floor(o.ctxSize) : DEFAULTS.ctxSize;
    var maxChars = isNum(o.maxChars) && o.maxChars > 0 ? Math.floor(o.maxChars) : DEFAULTS.maxChars;
    var maxItems = isNum(o.maxItems) && o.maxItems > 0 ? Math.floor(o.maxItems) : DEFAULTS.maxItems;

    if (!Array.isArray(messages)) return { ok: false, reason: 'bad-params', batches: [], stats: null };

    var list = [];
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      if (!isObj(m)) return { ok: false, reason: 'bad-message', detail: i, batches: [], stats: null };
      if (!isNum(m.id)) return { ok: false, reason: 'bad-id', detail: i, batches: [], stats: null };
      if (!isNum(m.time)) return { ok: false, reason: 'bad-time', detail: m.id, batches: [], stats: null };
      if (typeof m.role !== 'string' || !m.role) {
        return { ok: false, reason: 'bad-role', detail: m.id, batches: [], stats: null };
      }
      if (typeof m.content !== 'string') {
        return { ok: false, reason: 'bad-content', detail: m.id, batches: [], stats: null };
      }
      if (list.length && m.id <= list[list.length - 1].id) {
        // 顺序是分批的唯一前提：不悄悄排序，直接报错，让调用方去修数据源。
        return { ok: false, reason: 'not-ascending', detail: m.id, batches: [], stats: null };
      }
      list.push(m);
    }

    var tzOffsetMin = resolveTzOffset(list, o.tzOffsetMin);
    if (!list.length) {
      return {
        ok: true, reason: 'empty', batches: [],
        stats: { messages: 0, batches: 0, days: 0, pairSplits: 0, oversized: 0, tzOffsetMin: tzOffsetMin }
      };
    }

    var segments = [];
    var cur = null;
    for (var j = 0; j < list.length; j++) {
      var msg = list[j];
      var day = dayKeyOf(msg.time, tzOffsetMin);
      var needNew = !cur || cur.dayKey !== day ||
        cur.chars + msg.content.length > maxChars ||
        cur.items.length >= maxItems;
      if (needNew && cur) { segments.push(cur); cur = null; }
      if (!cur) cur = { dayKey: day, items: [], chars: 0 };
      cur.items.push(msg);
      cur.chars += msg.content.length;
    }
    if (cur) segments.push(cur);

    // 切点把问答对劈开的位置：把被劈开的那条回复挂进前一批的 ctx-after。
    var pairAfter = {};
    for (var k = 0; k < segments.length - 1; k++) {
      var prevItems = segments[k].items;
      var lastPrev = prevItems[prevItems.length - 1];
      var firstNext = segments[k + 1].items[0];
      if (lastPrev.role === 'user' && firstNext.role === 'assistant') pairAfter[k] = firstNext;
    }

    var days = {}, oversized = 0;
    var batches = segments.map(function (seg, idx) {
      days[seg.dayKey] = true;
      if (seg.items.length === 1 && seg.chars > maxChars) oversized += 1;

      var ctx = [];
      if (ctxSize > 0 && idx > 0) {
        var prev = segments[idx - 1].items;
        prev.slice(Math.max(0, prev.length - ctxSize)).forEach(function (mm) {
          ctx.push(pick(mm, 'before'));
        });
      }
      if (ctxSize > 0 && pairAfter[idx]) ctx.push(pick(pairAfter[idx], 'after'));

      var items = seg.items;
      return {
        index: idx,
        dayKey: seg.dayKey,
        firstId: items[0].id,
        lastId: items[items.length - 1].id,
        ids: items.map(function (mm) { return mm.id; }),
        messages: items.map(function (mm) { return pick(mm, null); }),
        ctx: ctx,
        count: items.length,
        chars: seg.chars
      };
    });

    return {
      ok: true, reason: 'ok', batches: batches,
      stats: {
        messages: list.length,
        batches: batches.length,
        days: Object.keys(days).length,
        pairSplits: Object.keys(pairAfter).length,
        oversized: oversized,
        tzOffsetMin: tzOffsetMin
      }
    };
  }

  /** 批内可被引用的 id 集合：fresh（本批新消息）+ ctx（上下文）。 */
  function allowedIdsOf(batch) {
    var fresh = {}, ctx = {}, origin = {};
    ((batch && batch.messages) || []).forEach(function (m) {
      fresh[idKey(m.id)] = true;
      origin[idKey(m.id)] = m.id;
    });
    ((batch && batch.ctx) || []).forEach(function (m) {
      ctx[idKey(m.id)] = true;
      if (!(idKey(m.id) in origin)) origin[idKey(m.id)] = m.id;
    });
    return { fresh: fresh, ctx: ctx, origin: origin };
  }

  /** 取批内某条消息的完整正文（核验 quote 用完整正文，不用提示词里的截断版）。 */
  function contentMapOf(batch) {
    var out = {};
    ((batch && batch.messages) || []).forEach(function (m) { out[idKey(m.id)] = m.content; });
    ((batch && batch.ctx) || []).forEach(function (m) {
      if (!(idKey(m.id) in out)) out[idKey(m.id)] = m.content;
    });
    return out;
  }

  /* ---------------- 3. 提示词 ---------------- */

  var SCHEMA_TEXT = [
    '{"records":[{"kind":"observation|impression|inference|question",',
    '"text":"一句话，你自己的口吻",',
    '"observed":"看到的表现，可空","inferred":"你的理解，可空",',
    '"confirmed":"她明确确认过的内容，可空","question":"你还没弄清的问题，可空",',
    '"confidence":"low|medium|high",',
    '"basis":"stated|observed|inferred",',
    '"topic":"主题词，可空",',
    '"evidence":[{"messageId":123,"quote":"原文片段"}]}]}'
  ].join('');

  function renderLine(m, contentMax, isCtx) {
    var body = normWs(m.content).length ? m.content.replace(/\s+/g, ' ').trim() : '（无正文）';
    if (body.length > contentMax) body = body.slice(0, contentMax) + '…';
    return '[' + m.id + (isCtx ? '*' : '') + '] ' + m.role + '：' + body;
  }

  function clipText(s, contentMax) {
    var t = str(s);
    return t.length > contentMax ? t.slice(0, contentMax) + '…' : t;
  }

  // 上一批 dry-run 候选只渲染成「参考认识」文字：不带 id、不伪装成消息，
  // 也不进入 batch.ctx / allowedIdsOf / contentMapOf，因此永远不能成为 evidence 来源。
  // 候选正文里若本身含有旧消息 ID，这里原样保留，但那些 ID 不在当前批白名单里。
  function renderPriorNotes(notes, contentMax) {
    var lines = [];
    (Array.isArray(notes) ? notes : []).forEach(function (n) {
      if (!isObj(n)) return;
      var text = clipText(n.text, contentMax);
      if (!text) return;
      var tags = [];
      if (KIND_SET[n.kind]) tags.push(n.kind);
      if (BASIS_SET[n.basis]) tags.push(n.basis);
      if (CONF_SET[n.confidence]) tags.push(n.confidence);
      lines.push('  - ' + (tags.length ? tags.join(' / ') + '：' : '') + text);
      ['observed', 'inferred', 'question'].forEach(function (f) {
        var v = clipText(n[f], contentMax);
        if (v) lines.push('      ' + f + '：' + v);
      });
    });
    return lines;
  }

  /**
   * 构造一次回顾请求的 messages（system + user）。
   * 只输出纯文本，不掺任何业务判断；所有硬规则同时写进提示词与 validateOutput，双保险。
   */
  function buildPrompt(batch, opts) {
    var o = opts || {};
    var contentMax = isNum(o.contentMax) && o.contentMax > 0 ? Math.floor(o.contentMax) : DEFAULTS.contentMax;

    var system = [
      '你在扮演「小星」，回顾和用户的真实相处，写下你逐渐形成的对她的认识。',
      '这是「你眼中的用户」：可以有观察、印象、理解、猜测和疑问；不是客观用户档案，不是聊天摘要，也不是隐藏思维链。',
      '用第一人称，像在回想两个人之间的事。可以写「我当时以为……」「她那样说的时候，我觉得……」',
      '「后来想想，好像不完全是这样。」不必每条都套这些句式，也别写成旁白式的人物评价。',
      '',
      '什么值得记：',
      '  对你理解她有持续价值的东西——互动方式和相处习惯、某个印象以及形成它的那段经历、',
      '  某次互动留给你的感受或理解、还没弄明白的地方、前后经历合起来带来的新认识或认识变化。',
      '  孤立的小动作通常不值得单独成条：一次问早饭、连着几个「好」、一次小游戏里的猜测，',
      '  若没有连着更有意义的互动或持续模式，就不必写。一次性小趣味可以是当下印象，不必硬存进长期认识。',
      '  可以一条都不写，也可以只写一两条；没有配额，不要为了凑数生成候选，',
      '  也不要把普通聊天流水账包装成观察报告。',
      '',
      '四种记录（含义不要混用）：',
      '  observation 看到的样子：原话明确说到、能直接从聊天确认的行为和细节。',
      '  概括时贴着原话：她没说的事件和动作不要替她补；说「可能、好像、记不清」时，',
      '  「可能真的有」就别写成「确实有」。',
      '  impression  留下的印象：这段相处给你留下的感受。',
      '  inference    我的理解：你据此形成的认识或猜测。允许猜错，',
      '               但「我觉得她可能……」要保留为猜测，别写成「她就是……」。',
      '  question     还想弄明白的：暂时没有答案、想继续了解的事。',
      'observed 只写她原话表达的内容；动机、性格、心理解释属于 inferred，别塞进 observed。',
      '这些忠实约束只管对用户经历和行为的描述，不管你的感受：心疼、在意、好奇、吃味、',
      '「听着有点不是滋味」都照常写，别把自己也改成客观旁白。',
      '',
      '怎么读这段聊天：',
      '  结合前后回应和实际情境，理解这件事对你意味着什么，而不是只盯着单条消息。',
      '  用户主动解释一件事时，值得写的往往不是她解释了哪句话，而是你如何理解她主动解释的原因、',
      '  这种互动给你留下了什么印象。',
      '  同一段互动里彼此关联的行为，整合成一条完整认识，不要拆成几条琐碎记录。',
      '  一段对话只能支撑当下的印象或初步猜测，别把一次行为写成稳定性格或长期习惯。',
      '',
      '依据类型 basis 必须如实标注：',
      '  stated   她原话里出现过。',
      '  observed 你看到的、可复述的表现。',
      '  inferred 你基于上下文的推测或理解。',
      '',
      '证据要求：',
      '  具体事实要有对应证据；quote 必须是该条消息正文里的原话片段，不得改写、拼接或概括成看似原文的话。',
      '  observed 和 text 是对证据的概括，同样不能改掉原话的意思：',
      '  原话「忘记划掉」就不能概括成「已经划掉」。',
      '  messageId 只能取自下面列出的消息，不得编造 id 或引用不存在的内容。',
      '  写了「多次」「连续」「四遍」这类数量或频率，evidence 就要覆盖实际支撑这些描述的消息，不能只引其中一部分。',
      '  要靠前后互动才说得清的，把支撑这种理解的相关消息都列进 evidence。',
      '  证据只能支持它能证明的事：一句原话不能替你证明她的心理动机；',
      '  这类判断写成 inference 或 question，不要伪装成 observed。',
      '',
      '输出硬规则（违反会被丢弃）：',
      '1. 每条记录都要有 evidence；id 与 quote 按上面的证据要求填写。',
      '2. basis=stated 只说明「她说过」，不代表她确认了你的判断；',
      '   只有她明确确认或纠正过的内容才填写 confirmed，其余一律留空。',
      '3. basis=inferred 时 confirmed 必须为空，confidence 不得为 high。',
      '4. confidence 是你自己有多笃定，与「她有没有说过」无关。',
      '5. 一条消息可以支撑多条不同的认识；但同一认识不要拆成几条重复记录。',
      '6. 带 * 的上下文消息只用来理解前因后果；整条记录只靠上下文支撑的会被跳过。',
      '7. 没有值得记的就返回 {"records":[]}。',
      '',
      '只输出 JSON，不要解释、不要 Markdown 代码块：',
      SCHEMA_TEXT
    ].join('\n');

    var priorNotes = Array.isArray(o.priorNotes) ? o.priorNotes : [];
    var lines = [];
    lines.push('日期：' + (batch && batch.dayKey ? batch.dayKey : '未知'));
    if (priorNotes.length) {
      lines.push('');
      lines.push('【上一批的初步认识 · 仅供参考】');
      lines.push('这些是上一批 AI 生成的初步候选：尚未入库、未确认，不代表事实。');
      lines.push('它们只能帮助你理解回顾的脉络：可以沿用、补充、修正、推翻，或暂时搁置。');
      lines.push('不要把其中的推测转写成已经确认的事实。');
      lines.push('不得引用这些候选的 ID 或内容作为 evidence。');
      lines.push('新候选的 evidence 必须来自下面【本批消息】中的真实消息。');
      renderPriorNotes(priorNotes, contentMax).forEach(function (x) { lines.push(x); });
    }
    lines.push('');
    lines.push('【本批消息】');
    ((batch && batch.messages) || []).forEach(function (m) { lines.push(renderLine(m, contentMax, false)); });
    if (batch && batch.ctx && batch.ctx.length) {
      lines.push('');
      lines.push('【上下文，仅供理解】');
      batch.ctx.forEach(function (m) { lines.push(renderLine(m, contentMax, true)); });
    }
    lines.push('');
    lines.push('请按上面的 JSON 结构输出。');

    return { system: system, user: lines.join('\n') };
  }

  /* ---------------- 4. 输出校验 ---------------- */

  function parseJsonLoose(raw) {
    if (typeof raw === 'string') {
      var s = raw.trim();
      // 模型偶尔会套一层 ```json，剥掉再解析；不做任何「修复性」猜测。
      s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      try { return { ok: true, value: JSON.parse(s) }; }
      catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    }
    if (raw != null && typeof raw === 'object') return { ok: true, value: raw };
    return { ok: false, error: 'not-json' };
  }

  /**
   * 校验一次 AI 输出。
   * 只认「能落实的证据」：id 必须在本次批内（fresh 或 ctx），quote 必须能在这条消息的
   * 完整正文里逐字找到。任何一条不过就丢弃该条记录并在 rejected 里写明原因。
   */
  function validateOutput(raw, batch, opts) {
    var o = opts || {};
    var quoteMin = isNum(o.quoteMin) && o.quoteMin > 0 ? Math.floor(o.quoteMin) : DEFAULTS.quoteMin;

    if (!batch || !Array.isArray(batch.messages)) {
      return { ok: false, reason: 'bad-batch', records: [], rejected: [], stats: null };
    }

    var parsed = parseJsonLoose(raw);
    if (!parsed.ok) {
      return { ok: false, reason: 'bad-json', error: parsed.error, records: [], rejected: [], stats: null };
    }
    var payload = parsed.value;
    var items = Array.isArray(payload) ? payload : (isObj(payload) ? payload.records : null);
    if (!Array.isArray(items)) {
      return { ok: false, reason: 'bad-shape', error: '缺少 records 数组', records: [], rejected: [], stats: null };
    }

    var allow = allowedIdsOf(batch);
    var contents = contentMapOf(batch);

    var accepted = [];
    var rejected = [];
    var ctxOnly = 0;

    items.forEach(function (it, idx) {
      var bad = function (reason, detail) {
        rejected.push({ index: idx, reason: reason, detail: detail == null ? null : String(detail) });
      };

      if (!isObj(it)) return bad('bad-item');
      if (!KIND_SET[it.kind]) return bad('invalid-kind', it.kind);
      var text = str(it.text);
      if (!text) return bad('empty-text');
      if (!BASIS_SET[it.basis]) return bad('invalid-basis', it.basis);
      var confidence = it.confidence == null ? 'medium' : it.confidence;
      if (!CONF_SET[confidence]) return bad('invalid-confidence', confidence);

      if (!Array.isArray(it.evidence) || !it.evidence.length) return bad('no-evidence');

      var ev = [];
      var freshCount = 0;
      var verdict = null;
      for (var i = 0; i < it.evidence.length; i++) {
        var e = it.evidence[i];
        if (!isObj(e)) { verdict = ['bad-evidence', 'item-' + i]; break; }
        var rawId = e.messageId;
        if (typeof rawId !== 'number' && typeof rawId !== 'string') {
          verdict = ['bad-evidence', 'messageId-' + i]; break;
        }
        var key = idKey(rawId);
        if (!allow.fresh[key] && !allow.ctx[key]) {
          verdict = ['unknown-source', rawId]; break;   // 编造的 id：直接丢
        }
        var quote = str(e.quote);
        if (quote.length < quoteMin) { verdict = ['quote-too-short', rawId]; break; }
        var full = contents[key] == null ? '' : contents[key];
        if (normWs(full).indexOf(normWs(quote)) === -1) {
          verdict = ['quote-mismatch', rawId]; break;   // 原文里找不到：不采信
        }
        if (allow.fresh[key]) freshCount += 1;
        ev.push({ messageId: allow.origin[key], quote: quote });
      }
      if (verdict) return bad(verdict[0], verdict[1]);

      var confirmed = str(it.confirmed);
      if (confirmed && it.basis !== 'stated') return bad('confirmed-requires-stated', it.basis);
      if (it.basis === 'inferred' && confidence === 'high') return bad('confidence-too-high', 'inferred');

      var allCtx = freshCount === 0;
      if (allCtx) ctxOnly += 1;

      accepted.push({
        kind: it.kind,
        text: text,
        observed: str(it.observed),
        inferred: str(it.inferred),
        confirmed: confirmed,
        question: str(it.question),
        confidence: confidence,
        basis: it.basis,
        topic: str(it.topic),
        evidence: ev,
        primaryMessageId: ev[0].messageId,
        allCtx: allCtx,
        freshCount: freshCount
      });
    });

    return {
      ok: true, reason: 'ok',
      records: accepted,
      rejected: rejected,
      stats: { total: items.length, accepted: accepted.length, rejected: rejected.length, ctxOnly: ctxOnly }
    };
  }

  /* ---------------- 5. 判重 ---------------- */

  // 一条消息 ID：数字只认整数，字符串去掉首尾空白后不能为空。其余一律视为无效。
  function normMessageId(raw) {
    if (typeof raw === 'number') {
      if (!isNum(raw) || Math.floor(raw) !== raw) return null;
      return String(raw);
    }
    if (typeof raw === 'string') {
      var t = raw.trim();
      return t ? t : null;
    }
    return null;
  }

  /**
   * 证据集合（已去重、已排序）。
   *   1. evidence 有有效 messageId → 用完整集合；
   *   2. evidence 为空/缺失 → 回退用 source.messageId（旧记录只有这一处来源）；
   *   3. 两者都没有 → 返回空数组：不猜、不伪造。
   * 只读，不修改记录。
   */
  function evidenceIdsOf(rec) {
    var ids = [];
    if (rec && Array.isArray(rec.evidence)) {
      rec.evidence.forEach(function (e) {
        var id = e && e.messageId != null ? normMessageId(e.messageId) : null;
        if (id) ids.push(id);
      });
    }
    if (ids.length) return uniqStrings(ids).sort();
    var src = rec && isObj(rec.source) ? rec.source : null;
    var fallback = src && src.messageId != null ? normMessageId(src.messageId) : null;
    return fallback ? [fallback] : [];
  }

  // 认识内容 = 四个语义字段各自规范化后的结构化比较值。
  // 用数组序列化而不是直接拼接：字段边界不会互相吞掉（"ab"+"c" 与 "a"+"bc" 不同）。
  var CONTENT_FIELDS = ['text', 'observed', 'inferred', 'question'];
  function contentKey(rec) {
    return JSON.stringify(CONTENT_FIELDS.map(function (f) {
      return normText(rec && rec[f]);
    }));
  }

  /** 去重键 = kind + 证据集合（结构化序列化）。同一条消息支撑不同认识时键相同、内容不同。 */
  function dedupeKey(rec) {
    return JSON.stringify([str(rec && rec.kind), evidenceIdsOf(rec)]);
  }

  // 安全取键：只认 Map 或对象自有的键，绝不落到原型属性上（constructor / __proto__ 等）。
  function safeGet(store, key) {
    if (!store) return null;
    if (typeof Map === 'function' && store instanceof Map) {
      return store.has(key) ? store.get(key) : null;
    }
    if (isObj(store) && Object.prototype.hasOwnProperty.call(store, key)) return store[key];
    return null;
  }

  /**
   * 建索引用。必须把 active / retracted / superseded 全部喂进来：
   * 否则撤回或修订过的内容会在重跑时被重新生成。
   * 外层与内层都用 Map：任意字符串作键都不会触发原型属性冲突。
   */
  function buildDedupeIndex(records) {
    var byKey = new Map();
    var count = 0;
    var noEvidence = 0;
    (Array.isArray(records) ? records : []).forEach(function (r) {
      if (!isObj(r) || typeof r.kind !== 'string' || !r.kind.trim()) return;
      if (!evidenceIdsOf(r).length) { noEvidence += 1; return; }   // 无来源：不进索引，也不猜
      var k = dedupeKey(r);
      var ck = contentKey(r);
      var bucket = byKey.get(k);
      if (!bucket) { bucket = new Map(); byKey.set(k, bucket); }
      var list = bucket.get(ck);
      if (!list) { list = []; bucket.set(ck, list); }
      list.push(r.id == null ? null : r.id);
      count += 1;
    });
    return { byKey: byKey, count: count, noEvidence: noEvidence };
  }

  /**
   * 是否重复：kind 相同 + 完整证据集合相同 + text/observed/inferred/question
   * 四者规范化后完全相同，全部满足才算。
   * confidence / basis / confirmed / topic / source 不参与：它们会变，不该造成重复生成。
   * 仅 evidence 有交集、但认识不同 → 不算重复，允许并存。
   */
  function isDuplicate(cand, index) {
    if (!index || !isObj(cand)) return { duplicate: false, reason: 'no-index' };
    var bucket = safeGet(index.byKey, dedupeKey(cand));
    if (!bucket) return { duplicate: false, reason: 'no-same-evidence' };
    var of = safeGet(bucket, contentKey(cand));
    if (!Array.isArray(of) || !of.length) return { duplicate: false, reason: 'different-content' };
    return { duplicate: true, reason: 'same-evidence-kind-content', of: of.slice() };
  }

  /**
   * 过滤一批待落库记录：
   *   - 只靠上下文支撑的记录 → 跳过（reason: 'ctx-only'），它是重复候选而不是新认识；
   *   - 与索引里已有记录同证据同内容的 → 跳过（reason: 'duplicate'）。
   * 本函数不写库、不改已有记录，因此用户改过的内容不会被覆盖。
   */
  function applyDedupe(records, index) {
    var accepted = [];
    var skipped = [];
    (Array.isArray(records) ? records : []).forEach(function (r) {
      if (r && r.allCtx) { skipped.push({ record: r, reason: 'ctx-only', of: null }); return; }
      var d = isDuplicate(r, index);
      if (d.duplicate) { skipped.push({ record: r, reason: 'duplicate', of: d.of }); return; }
      accepted.push(r);
    });
    return { accepted: accepted, skipped: skipped };
  }

  /* ---------------- 导出 ---------------- */

  root.SelfNarrativeReview = {
    KINDS: KINDS.slice(),
    CONFIDENCES: CONFIDENCES.slice(),
    BASES: BASES.slice(),
    DEFAULTS: Object.assign({}, DEFAULTS),
    SCHEMA_TEXT: SCHEMA_TEXT,

    dayKeyOf: dayKeyOf,
    resolveTzOffset: resolveTzOffset,
    planBatches: planBatches,
    allowedIdsOf: allowedIdsOf,
    contentMapOf: contentMapOf,
    buildPrompt: buildPrompt,
    validateOutput: validateOutput,
    dedupeKey: dedupeKey,
    evidenceIdsOf: evidenceIdsOf,
    contentKey: contentKey,
    buildDedupeIndex: buildDedupeIndex,
    isDuplicate: isDuplicate,
    applyDedupe: applyDedupe,
    normalizeText: normText,
    normalizeWhitespace: normWs
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
