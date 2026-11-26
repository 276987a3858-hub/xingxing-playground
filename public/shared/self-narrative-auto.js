/* public/shared/self-narrative-auto.js — 机自述「增量自动整理 + 安全纠正」纯逻辑层
 * ------------------------------------------------------------------
 * 目标：让小星能从 watermark 之后的新聊天里，按现有 review 流程整理出新认识，
 *       经过严格门槛后自动写入正式 selfNarrative.v1；并提供「用户纠正」的待确认修订候选。
 *
 * 设计原则（硬约束）：
 *   1. 复用现有能力，不另造数据结构：
 *      - 读取 / 校验 / 去重 / 证据真实性：SelfNarrativeDryRun.run() 已经做完；
 *      - 候选 → 正式记录：SelfNarrativeDryRun.candidateToCreateSpec + adoptReviewed；
 *      - 水位：loadWatermark / saveWatermark（独立键 selfNarrative.watermark）；
 *      - 修订 / 撤回 / 版本：SelfNarrative.update / retract / create({revisedFrom}) / historyOf。
 *   2. 本模块只编排 + 加一道「自动入库门槛」纯函数；不重新实现 AI 请求、提示词或证据核对。
 *   3. 自动入库是保守的：只有满足门槛且全部写入成功才推进水位；任何失败都保持原水位，
 *      下一轮从同一起点重试（确定性 ID 保证不会重复写入已成功的记录）。
 *   4. 纠正只生成「待确认候选」，绝不自动改 / 删正式记录；AI 也无权自行修订。
 *      只有调用方显式确认（confirmCorrection）才走正式数据层的 update/retract/版本修订。
 *   5. 不建常驻服务、不自动重试、不每轮聊天都触发；由调用方（面板按钮或宿主钩子）显式驱动一次批次。
 *
 * 暴露 globalThis.SelfNarrativeAuto。
 */
(function (root) {
  'use strict';

  var WATERMARK_KEY = 'selfNarrative.watermark';
  // 自动入库门槛：一次批次最多自动写入条数（保守，避免一次塞太多）。
  var DEFAULT_MAX_ADOPT = 3;
  // 自动入库只接受 medium / high；low 一律不自动写入（「不确定的内容不自动入库」）。
  var AUTO_CONF_SET = { medium: true, high: true };

  // 两种入口必须显式区分，绝不混用：
  //   watermark —— 普通增量，afterId 交给 DryRun.run() 从独立水位读取；
  //   from-id   —— 指定起点，afterId 必须由调用方显式给出；缺失 / 非法一律拒绝，
  //                绝不回退到 watermark（防止「指定起点」意外从 80 开始）。
  var MODE_WATERMARK = 'watermark';
  var MODE_FROM_ID = 'from-id';
  // 面板默认值：2026-11-23 以来的起点。仅作 UI 默认，不参与任何隐式回退。
  var DEFAULT_FROM_ID = 2428;

  function isObj(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
  function str(v) { return String(v == null ? '' : v); }
  function num(v, dflt, min, max) {
    var n = Number(v);
    if (!isFinite(n)) return dflt;
    n = Math.floor(n);
    if (min != null && n < min) n = min;
    if (max != null && n > max) n = max;
    return n;
  }
  function errText(e) { return String((e && e.message) || e); }

  function parseMode(v) {
    var s = str(v).trim().toLowerCase();
    if (!s || s === MODE_WATERMARK) return MODE_WATERMARK;
    if (s === MODE_FROM_ID) return MODE_FROM_ID;
    return 'invalid';   // 未识别的 mode 一律拒绝，绝不静默退化成 watermark 增量
  }

  // 指定起点只接受正整数（>=1）。0 / 空 / 小数 / 非数字一律无效：
  // 这样即使输入框被清空，也不会退化成「从 0 全量扫描」或回退到 watermark。
  function parseExplicitAfterId(v) {
    if (v == null) return null;
    var s = str(v).trim();
    if (!/^\d+$/.test(s)) return null;
    var n = Number(s);
    if (!isFinite(n) || n < 1 || Math.floor(n) !== n || n > 2147483647) return null;
    return n;
  }

  function collectDeps(override) {
    var injected = isObj(override) ? override : {};
    var page = isObj(root.SelfNarrativeDryRunDeps) ? root.SelfNarrativeDryRunDeps : {};
    return {
      dryRun: injected.dryRun || root.SelfNarrativeDryRun || null,
      review: injected.review || root.SelfNarrativeReview || null,
      selfNarrative: injected.selfNarrative || root.SelfNarrative || null,
      reader: injected.reader || root.RoomChatReader || null,
      callAI: injected.callAI || page.callAI || root.callAI || null,
      kvGet: injected.kvGet || page.kvGet || root.kvGet || null,
      kvSet: injected.kvSet || page.kvSet || root.kvSet || null,
      location: injected.location || (typeof location !== 'undefined' ? location : null),
      now: injected.now || Date.now
    };
  }

  /**
   * 自动入库门槛（纯函数）：在 dry-run 已完成的证据真实性 + 去重之上，再筛一道。
   * 返回 { ok, reason }。ok=true 才允许自动写入正式记录。
   *
   * 拒绝条件（对应需求「证据不足 / 推断过强 / 重复 / 不确定 / 孤立琐事」）：
   *   - 不是 active 来源（候选本身没有 status=new 语义时按内容判断，不强制）；
   *   - allCtx：整条只靠上下文，没有本批新消息支撑；
   *   - confidence=low：不确定；
   *   - basis=inferred 且 confidence=high：推断过强（validateOutput 已拦，这里双保险）；
   *   - 有 confirmed 非空：自动整理没有用户确认信号；
   *   - 正文过短（< 8 字）：孤立琐事 / 流水账；
   *   - 证据不完整：无 evidence 或 primaryMessageId 缺失。
   */
  function autoQualify(candidate) {
    if (!isObj(candidate)) return { ok: false, reason: 'bad-candidate' };
    if (candidate.allCtx) return { ok: false, reason: 'ctx-only' };
    if (!AUTO_CONF_SET[candidate.confidence]) return { ok: false, reason: 'low-confidence' };
    if (candidate.basis === 'inferred' && candidate.confidence === 'high') {
      return { ok: false, reason: 'inference-too-strong' };
    }
    if (str(candidate.confirmed).trim()) return { ok: false, reason: 'auto-confirm-blocked' };
    var text = str(candidate.text).replace(/\s+/g, '');
    if (text.length < 8) return { ok: false, reason: 'too-short' };
    var ev = Array.isArray(candidate.evidence) ? candidate.evidence : [];
    if (!ev.length) return { ok: false, reason: 'no-evidence' };
    if (candidate.primaryMessageId == null && ev[0] && ev[0].messageId == null) {
      return { ok: false, reason: 'no-primary-evidence' };
    }
    return { ok: true };
  }

  /**
   * 跑一次增量自动整理批次（不做常驻、不自动重试）。
   *   opts: { mode?, afterId?, limit?, maxChars?, maxAdopt? }
   *     mode='watermark'（默认）：普通增量，不传 afterId，由 DryRun.run() 读独立水位。
   *     mode='from-id'：指定起点，afterId 必传且为正整数；缺失即拒绝，绝不回退到 watermark。
   *   deps: 可注入（Node 测试用），缺省取 window 上的真实模块。
   *
   * 流程：
   *   1. 复用 dryRun.run()：读一批真实消息 → 提示词 → 一次 AI →
   *      完整校验（evidence 真实性）→ 对照正式记录去重；产出已核验候选。
   *   2. 对候选再过 autoQualify 门槛，取前 maxAdopt 条。
   *   3. 用 candidateToCreateSpec + adoptReviewed 逐条写入正式数据层（确定性 ID 幂等）。
   *   4. 只有「没有待写失败」时才推进 watermark 到本批 nextAfterId；失败保持原水位。
   *      指定起点批次若整批核验完成但零条达标，也推进水位到批末，避免卡在同一批；
   *      这是显式选择的一次性跳转，不影响普通增量入口的保守语义。
   *   5. 批次幂等：同一批（afterId 相同）重复执行时，watermark 已推进则从新位置读取；
   *      若写入中途失败、水位未推进，重跑时确定性 ID 让已成功条目命中 duplicate-id 幂等。
   *   6. 水位守卫：只在「当前水位 <= 批末」时推进，且只写到批末，永不回退。
   *
   * 返回结构化结果，绝不抛异常给调用方。
   */
  async function runAutoBatch(opts, depsOverride) {
    var o = isObj(opts) ? opts : {};
    var mode = parseMode(o.mode);
    var explicitAfter = mode === MODE_FROM_ID ? parseExplicitAfterId(o.afterId) : null;
    var deps = collectDeps(depsOverride);
    // 注意：mode 校验必须早于任何依赖收集之外的副作用；这里只构造结果，不读库、不请求 AI。
    var started = deps.now();
    var out = {
      ok: false, reason: '', startedAt: started, wallClockMs: 0,
      mode: mode,
      requested: {
        afterId: mode === MODE_FROM_ID ? explicitAfter : null,
        limit: o.limit == null ? null : num(o.limit, 80, 1, 500),
        maxAdopt: o.maxAdopt == null ? null : num(o.maxAdopt, DEFAULT_MAX_ADOPT, 1, 20),
        maxChars: o.maxChars == null ? null : num(o.maxChars, 12000, 1, 200000)
      },
      batch: null, auto: { total: 0, qualified: 0, rejected: [], capped: 0 },
      adopt: { attempted: 0, succeeded: 0, idempotent: 0, failed: [], results: [] },
      watermark: { touched: false, before: null, after: null, reason: '' },
      apiCalls: 0, warnings: [], error: null
    };

    function finish() { out.wallClockMs = deps.now() - started; return out; }

    // 未知入口一律拒绝，不静默退化成普通 watermark 增量。
    if (mode === 'invalid') {
      out.reason = 'invalid-mode';
      out.error = 'mode 只支持 watermark 或 from-id；不会静默按 watermark 执行。';
      out.watermark.reason = 'invalid-mode';
      out.warnings.push(out.error);
      return finish();
    }

    // 指定入口的前置硬校验：缺 afterId 立即拒绝，绝不调用 dry-run / AI，也不读水位后回退。
    if (mode === MODE_FROM_ID && explicitAfter == null) {
      out.reason = 'missing-after-id';
      out.error = '指定起点整理必须显式填写正整数 afterId（例如 2428）；不会回退到 watermark。';
      out.watermark.reason = 'from-id-needs-explicit-after-id';
      out.warnings.push(out.error);
      return finish();
    }

    var missing = [];
    if (!deps.dryRun || typeof deps.dryRun.run !== 'function') missing.push('SelfNarrativeDryRun.run');
    if (!deps.selfNarrative || typeof deps.selfNarrative.create !== 'function') missing.push('SelfNarrative');
    if (!deps.kvGet || typeof deps.kvGet !== 'function') missing.push('kvGet');
    if (!deps.kvSet || typeof deps.kvSet !== 'function') missing.push('kvSet');
    if (!deps.callAI) missing.push('callAI');
    if (missing.length) {
      out.reason = 'missing-deps'; out.error = '缺少依赖：' + missing.join('、');
      return finish();
    }

    // 1. 记录批次前水位（只读取，不修改）。
    var wmBefore;
    try { wmBefore = await deps.dryRun.loadWatermark(deps.kvGet); }
    catch (e) { wmBefore = { ok: false, reason: 'wm-threw', value: 0 }; }
    out.watermark.before = wmBefore && wmBefore.ok ? wmBefore.value : null;
    if (mode === MODE_FROM_ID && wmBefore && wmBefore.ok && wmBefore.value > explicitAfter) {
      out.warnings.push('指定起点 ' + explicitAfter + ' 早于当前水位 ' + wmBefore.value +
        '；水位只会前进或保持不变，不会回退。');
    }

    // 2. 复用 dry-run run()：一次 AI + 证据校验 + 去重，严格只读。
    // 指定起点传已校验的正整数；普通增量保持原语义（不传 afterId → DryRun 读 watermark）。
    var result;
    try {
      result = await deps.dryRun.run({
        afterId: mode === MODE_FROM_ID ? explicitAfter : o.afterId,
        limit: o.limit,
        maxChars: o.maxChars,
        tzOffsetMin: o.tzOffsetMin
      }, depsOverride);
    } catch (e) {
      out.reason = 'run-threw'; out.error = errText(e);
      return finish();
    }
    if (!result || !result.ok) {
      out.reason = result ? str(result.read && result.read.reason || result.ai && result.ai.reason || 'dry-run-failed') : 'no-result';
      out.apiCalls = result && result.ai && result.ai.attempted ? 1 : 0;
      out.warnings.push('整理批次未产出可用候选：' + out.reason + '；水位保持不变。');
      out.watermark.reason = 'run-not-ok';
      return finish();
    }
    out.apiCalls = result.ai && result.ai.attempted ? 1 : 0;
    var readIds = result.read && Array.isArray(result.read.ids) ? result.read.ids.slice() : [];
    out.batch = {
      afterId: result.read && result.read.afterId,
      nextAfterId: result.read && result.read.nextAfterId,
      ids: readIds,
      firstId: readIds.length ? readIds[0] : null,
      lastId: readIds.length ? readIds[readIds.length - 1] : null,
      count: readIds.length,
      aiOk: !!(result.ai && result.ai.ok),
      dedupe: result.dedupe || null
    };

    // 水位推进统一出口：两种入口共用同一套守卫。任何读失败 / 批末非法 / 水位已在前方 /
    // 写失败都不会推进，更不会回退。返回 { ok, advanced }：ok=false 表示阻塞错误。
    async function persistWatermark() {
      var wmRead;
      try { wmRead = await deps.dryRun.loadWatermark(deps.kvGet); }
      catch (e) { wmRead = { ok: false, reason: 'wm-threw' }; }
      if (!wmRead.ok) {
        out.ok = false; out.reason = 'watermark-read-failed';
        out.watermark.reason = wmRead.reason || 'read-failed';
        out.warnings.push('读取水位失败，未推进水位（下一轮靠确定性 ID 幂等，不会重复写入）。');
        return { ok: false, advanced: false };
      }
      var currentWm = wmRead.value || 0;
      var batchStart = num(out.batch.afterId, 0, 0, null);
      var nextAfter = num(out.batch.nextAfterId, NaN, 0, null);
      if (!isFinite(nextAfter)) {
        out.ok = false; out.reason = 'bad-next-after-id';
        out.watermark.reason = 'bad-next-after-id';
        return { ok: false, advanced: false };
      }
      if (currentWm >= nextAfter) {
        out.ok = true;
        out.watermark.touched = false;
        out.watermark.after = currentWm;
        out.watermark.reason = 'watermark-ahead-skip';
        out.warnings.push('当前水位 ' + currentWm + ' 已在本批末尾或之后，本批不推进也不回退水位。');
        return { ok: true, advanced: false };
      }
      if (currentWm > batchStart) {
        out.warnings.push('当前水位 ' + currentWm + ' 位于本批起点 ' + batchStart + ' 与批末 ' + nextAfter +
          ' 之间；水位只向前推进到批末，不回退。');
      }
      var saved;
      try {
        saved = await deps.dryRun.saveWatermark(deps.kvSet, {
          nextAfterId: nextAfter,
          savedAt: deps.now(),
          afterId: batchStart,
          firstId: out.batch.firstId,
          lastId: out.batch.lastId,
          adopted: out.adopt.succeeded,
          skipped: out.auto.rejected.length + out.auto.capped
        });
      } catch (e) {
        out.ok = false; out.reason = 'watermark-write-threw'; out.error = errText(e);
        out.watermark.reason = 'write-threw';
        return { ok: false, advanced: false };
      }
      if (!saved.ok) {
        out.ok = false; out.reason = 'watermark-write-failed';
        out.watermark.reason = saved.reason || 'write-failed';
        out.warnings.push('水位写入失败：' + str(saved.reason) + '；下一轮靠确定性 ID 幂等。');
        return { ok: false, advanced: false };
      }
      out.watermark.touched = true;
      out.watermark.after = saved.value && saved.value.lastAfterId;
      out.watermark.reason = 'advanced';
      return { ok: true, advanced: true };
    }

    // 3. 自动入库门槛：只从已核验、已去重的候选里挑。
    var candidates = Array.isArray(result.candidates) ? result.candidates : [];
    var maxAdopt = num(o.maxAdopt, DEFAULT_MAX_ADOPT, 1, 20);
    var qualified = [];
    candidates.forEach(function (c, idx) {
      var q = autoQualify(c);
      out.auto.total += 1;
      if (q.ok) {
        if (qualified.length < maxAdopt) qualified.push(c);
        else out.auto.capped += 1;
      } else {
        out.auto.rejected.push({ index: idx, reason: q.reason, text: str(c && c.text).slice(0, 40) });
      }
    });
    out.auto.qualified = qualified.length;
    if (!qualified.length) {
      if (mode === MODE_FROM_ID) {
        // 指定起点是一次性跳转：整批已完整核验（读取/AI/校验/去重均成功），
        // 即使零条达标也推进到批末，否则用户会被卡在同一批、无法继续整理近期聊天。
        // 仍受同一套失败保护与水位倒退守卫约束；不写入任何正式记录。
        var pNoQ = await persistWatermark();
        if (!pNoQ.ok) return finish();
        out.ok = true;
        out.reason = pNoQ.advanced ? 'done-from-id-no-qualified' : 'done-from-id-no-qualified-ahead';
        out.warnings.push('本批没有满足自动入库门槛的候选；指定起点批次已核验完成，水位推进到批末（未写入任何记录）。');
        return finish();
      }
      // 普通增量保持原保守语义：没有可写候选就不推进，让这批下一轮仍可被整理。
      out.ok = true;
      out.reason = 'no-qualified';
      out.watermark.reason = 'no-qualified-keep-watermark';
      out.warnings.push('本批没有满足自动入库门槛的候选；未写入，水位保持不变。');
      return finish();
    }

    // 4. 写入正式数据层（复用 adoptReviewed，逐条、确定性 ID 幂等）。
    var reviewState = deps.dryRun.initReview(qualified).map(function (x) {
      return { key: x.key, idx: x.idx, status: 'adopt', candidate: x.candidate };
    });
    var writeStore = {
      get: function (k) { return deps.kvGet(k); },
      set: function (k, v) { return deps.kvSet(k, v); }
    };
    var results;
    try {
      results = await deps.dryRun.adoptReviewed(writeStore, reviewState, {
        selfNarrative: deps.selfNarrative, now: deps.now
      });
    } catch (e) {
      out.reason = 'adopt-threw'; out.error = errText(e);
      out.watermark.reason = 'adopt-threw-keep-watermark';
      return finish();
    }
    out.adopt.results = results;
    out.adopt.attempted = qualified.length;
    out.adopt.succeeded = results.filter(function (r) { return r.ok && !r.idempotent; }).length;
    out.adopt.idempotent = results.filter(function (r) { return r.ok && r.idempotent; }).length;
    out.adopt.failed = results.filter(function (r) { return !r.ok; }).map(function (r) {
      return { idx: r.idx, reason: r.reason, error: r.error || null };
    });

    // 5. 水位推进：只有整批写入零失败才推进；失败或读取失败都保持原水位，下一轮重试。
    if (out.adopt.failed.length) {
      out.ok = false;
      out.reason = 'adopt-failed';
      out.watermark.reason = 'failures-keep-watermark';
      out.warnings.push('有 ' + out.adopt.failed.length + ' 条写入失败，水位保持原值，未推进。');
      return finish();
    }
    var p = await persistWatermark();
    if (!p.ok) return finish();
    out.ok = true;
    out.reason = p.advanced ? 'done' : 'done-watermark-ahead';
    return finish();
  }

  /* ---------------- 纠正机制：只生成待确认候选，绝不自动改正式记录 ---------------- */

  // 本地纠正语境检测：复用 MemoryGenerator.detectUserCorrection 的保守思路。
  // 单靠一个「不是」不算；命中明确纠正句式才算「可能的纠正语境」（仍只生成候选）。
  var CORRECTION_RE = /(不是.{0,12}而是|我说错|你记错|记错了|其实不是|我改主意|我不再|不再是|别记这条|算我说错|以前不算|现在不算)/;
  function detectCorrection(text) {
    return CORRECTION_RE.test(str(text));
  }

  /**
   * 从正式 active 记录里找与纠正文本可能相关的旧认识（纯只读）。
   * 用数据层 contextRelated（收紧后的相关性），只取 active；不做任何修改。
   */
  function findRelatedRecords(text, records, opts) {
    var o = isObj(opts) ? opts : {};
    var lim = num(o.limit, 3, 1, 10);
    var SN = root.SelfNarrative;
    if (!SN || typeof SN.contextRelated !== 'function') return [];
    var active = (Array.isArray(records) ? records : []).filter(function (r) {
      return isObj(r) && r.status === 'active';
    });
    var scored = [];
    active.forEach(function (r) {
      if (SN.contextRelated(text, r)) scored.push(r);
    });
    return scored.slice(0, lim).map(function (r) { return r.id; });
  }

  /**
   * 生成待确认的修订候选（不写库、不调用 AI）。
   * 返回 { ok, needsConfirm:true, isCorrection, relatedIds, candidates:[...] }。
   * 每条候选只描述「建议动作」，供面板展示；必须有用户显式确认才执行。
   */
  function prepareCorrection(text, records, opts) {
    var o = isObj(opts) ? opts : {};
    var isCorrection = detectCorrection(text);
    var related = findRelatedRecords(text, records, { limit: num(o.limit, 3, 1, 10) });
    var byId = {};
    (Array.isArray(records) ? records : []).forEach(function (r) { if (r && r.id) byId[r.id] = r; });
    var candidates = related.map(function (id) {
      var r = byId[id];
      return {
        targetId: id,
        action: 'revise',                 // 默认建议修订；用户可选择 retract 或放弃
        topic: str(r && r.topic),
        oldText: str(r && r.text),
        oldEvidence: Array.isArray(r && r.evidence) ? r.evidence.map(function (e) {
          return { messageId: e && e.messageId, quote: str(e && e.quote) };
        }) : [],
        note: '用户表达可能与这条旧认识冲突；仅为待确认候选，未修改正式记录。',
        needsConfirm: true
      };
    });
    return {
      ok: true,
      needsConfirm: true,
      isCorrection: isCorrection,
      relatedIds: related,
      candidates: candidates,
      warnings: isCorrection
        ? []
        : ['未检测到明确纠正语境；仅按话题相关性给出可能相关的旧认识，不建议据此修改。']
    };
  }

  /**
   * 显式确认后才执行：调用现有正式数据层做 update / retract / 版本修订。
   * 只允许三种动作：revise（就地修订+历史快照）、retract（撤回）、revise-as-new（create revisedFrom 新版本）。
   * 绝不覆盖 history；保留旧 evidence（除非调用方显式给出新的、已核验的 evidence）。
   * deps.confirmed 必须为 true，否则一律拒绝（防止 AI 或误触自动修改）。
   */
  async function confirmCorrection(decision, depsOverride) {
    var deps = collectDeps(depsOverride);
    var d = isObj(decision) ? decision : {};
    var out = { ok: false, reason: '', action: null, id: null, error: null };
    if (deps.confirmed !== true && d.confirmed !== true) {
      out.reason = 'not-confirmed';
      return out;
    }
    var SN = deps.selfNarrative;
    if (!SN || typeof SN.update !== 'function' || typeof SN.retract !== 'function' || typeof SN.create !== 'function') {
      out.reason = 'missing-data-layer';
      return out;
    }
    if (!deps.kvSet || typeof deps.kvSet !== 'function') { out.reason = 'no-write-deps'; return out; }
    var store = {
      get: function (k) { return deps.kvGet(k); },
      set: function (k, v) { return deps.kvSet(k, v); }
    };
    var action = str(d.action);
    var id = str(d.targetId);
    if (!id) { out.reason = 'missing-target'; return out; }
    out.action = action; out.id = id;
    var opts = { now: deps.now() };
    var res = null;
    try {
      if (action === 'retract') {
        res = await SN.retract(store, id, opts);
      } else if (action === 'revise') {
        var patch = isObj(d.patch) ? d.patch : {};
        var allowed = { text: 1, observed: 1, inferred: 1, question: 1, confidence: 1, topic: 1, basis: 1 };
        var clean = {};
        Object.keys(patch).forEach(function (k) { if (allowed[k]) clean[k] = patch[k]; });
        res = await SN.update(store, id, clean, opts);
      } else if (action === 'revise-as-new') {
        var spec = isObj(d.spec) ? Object.assign({}, d.spec) : {};
        spec.revisedFrom = id;
        res = await SN.create(store, spec, opts);
      } else {
        out.reason = 'invalid-action';
        return out;
      }
    } catch (e) {
      out.reason = 'execute-threw'; out.error = errText(e);
      return out;
    }
    if (!res || !res.ok) {
      out.reason = res ? str(res.reason) : 'no-result';
      out.error = res && res.error ? str(res.error) : null;
      return out;
    }
    out.ok = true;
    out.reason = 'applied';
    out.resultId = res.id || id;
    return out;
  }

  var api = {
    WATERMARK_KEY: WATERMARK_KEY,
    DEFAULT_MAX_ADOPT: DEFAULT_MAX_ADOPT,
    MODE_WATERMARK: MODE_WATERMARK,
    MODE_FROM_ID: MODE_FROM_ID,
    DEFAULT_FROM_ID: DEFAULT_FROM_ID,
    parseExplicitAfterId: parseExplicitAfterId,
    AUTO_CONF_SET: Object.assign({}, AUTO_CONF_SET),
    autoQualify: autoQualify,
    runAutoBatch: runAutoBatch,
    detectCorrection: detectCorrection,
    findRelatedRecords: findRelatedRecords,
    prepareCorrection: prepareCorrection,
    confirmCorrection: confirmCorrection
  };
  root.SelfNarrativeAuto = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
