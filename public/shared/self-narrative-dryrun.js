/* public/shared/self-narrative-dryrun.js — S2a 单批 dry-run + 多轮测试面板
 * ------------------------------------------------------------------
 * 只读试跑：RoomChatReader 读一批 → S1b 提示词 → AIClient → S1b 校验
 *           → 既有 SelfNarrative 记录做去重 → 展示结果。
 *
 * run() 本身仍严格只读：不写机自述、不写水位、不自动重试、不自动扫描下一批、不改聊天记录。
 * P0 新增的写入只在用户于面板逐条审核并点「完成本批审核」确认后才发生：
 *   - 采纳：调用 SelfNarrative.create（确定性 id 幂等，confirmed 强制清空）；
 *   - 水位：独立 kv 键 selfNarrative.watermark，整批有明确结果且全部采纳成功后才推进；
 *   - 两者都不进备份白名单，测试历史仍只存 localStorage 独立键 ylxh.snDryRun.v1。
 *
 * 暴露 window.SelfNarrativeDryRun = { run, mount, renderResult, REQUEST_TYPE,
 *   STORAGE_KEY, WATERMARK_KEY, MAX_ROUNDS, createStore, buildRound,
 *   resolvePriorCandidates, replayRound, candidatesFromRound, nextRoundNo,
 *   candidateToCreateSpec, initReview, setReviewDecision, reviewPending,
 *   adoptReviewed, completeManualReview, canAdvanceReview, normalizeWatermark,
 *   loadWatermark, saveWatermark, MANUAL_ORIGIN, MANUAL_LABEL,
 *   parseManualPayload, verifyManualCandidates }。
 *
 * 人工重建入口：只做证据核验 + 复用现有审核/采纳通路；不调用 AI、不保存批次、
 * 不创建或推进水位。人工来源写入 source.kind='manual-reconstruction'，schema 不变。
 * 人工审核有独立完成按钮与完成态；它与 AI Dry-run 的 saveWatermark 完全隔离。
 */
(function (root) {
  'use strict';

  var REQUEST_TYPE = 'self-narrative-review';
  var MODEL_NOTE = 'deepseek-flash（AIClient.chat 默认值）';
  // Dry-run 测试历史的唯一存储键。不是备份白名单键，也不会被导入流程写回。
  var STORAGE_KEY = 'ylxh.snDryRun.v1';
  var STORE_SCHEMA = 1;
  var MAX_ROUNDS = 20;
  // P0-2：独立水位键（IndexedDB kv），与正式机自述键 selfNarrative.v1 分离，
  // 不在备份白名单内。只有整批审核完成且全部采纳成功后才推进。
  var WATERMARK_KEY = 'selfNarrative.watermark';
  var WATERMARK_SCHEMA = 1;
  // 「指定起点整理」的面板默认值（2026-11-23 以来的起点）。
  // 只是输入框初始值：不传 afterId 时本模块绝不隐式使用它，也绝不回退到 watermark。
  var FROM_ID_DEFAULT = 2428;
  // 人工重建的显式标记。不是 AI 输出，也不伪装成一轮 dry-run。
  var MANUAL_ORIGIN = 'manual-reconstruction';
  var MANUAL_LABEL = '人工重建，非原始 AI 输出';

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

  /* ---------------- Dry-run 测试历史（与正式机自述隔离） ----------------
   * 只存 localStorage 独立键 ylxh.snDryRun.v1，不进 IndexedDB / 备份白名单。
   * storage 可注入（Node 测试用假对象）；页面里默认取 root.localStorage。
   * 任何写入失败都返回明确 reason，绝不影响本轮 Dry-run 结果的展示。
   */

  function defaultStorage() {
    try {
      if (root.localStorage) return root.localStorage;
    } catch (e) {}
    return null;
  }

  function emptyHistory() { return { schema: STORE_SCHEMA, dryRun: true, rounds: [] }; }

  /** 校验历史结构：只接受本文件写出的形状，损坏数据明确报错而不是清空。 */
  function normalizeHistory(raw) {
    if (!isObj(raw)) return null;
    if (raw.schema !== STORE_SCHEMA || raw.dryRun !== true || !Array.isArray(raw.rounds)) return null;
    var clean = [];
    for (var i = 0; i < raw.rounds.length; i++) {
      var r = raw.rounds[i];
      if (!isObj(r)) return null;
      if (r.dryRun !== true || !isObj(r.result)) return null;
      clean.push(r);
    }
    return { schema: STORE_SCHEMA, dryRun: true, rounds: clean };
  }

  /** 创建测试历史存储。返回 { available, load, saveRound, clear }。 */
  function createStore(storage) {
    var st;
    if (storage) st = storage;
    else st = defaultStorage();
    var available = !!(st && typeof st.getItem === 'function' && typeof st.setItem === 'function' && typeof st.removeItem === 'function');

    function load() {
      if (!available) return { ok: false, reason: 'storage-unavailable', rounds: [] };
      var raw;
      try { raw = st.getItem(STORAGE_KEY); }
      catch (e) { return { ok: false, reason: 'read-failed', error: errText(e), rounds: [] }; }
      if (raw == null || raw === '') return { ok: true, rounds: [], empty: true };
      var parsed;
      try { parsed = JSON.parse(raw); }
      catch (e) { return { ok: false, reason: 'corrupted', error: errText(e), rounds: [] }; }
      var norm = normalizeHistory(parsed);
      if (!norm) return { ok: false, reason: 'bad-shape', rounds: [] };
      return { ok: true, rounds: norm.rounds };
    }

    function saveRound(entry) {
      if (!isObj(entry) || entry.dryRun !== true) return { ok: false, reason: 'not-dry-run', rounds: [] };
      var loaded = load();
      if (!loaded.ok) return { ok: false, reason: 'load-failed:' + loaded.reason, rounds: [] };
      var rounds = loaded.rounds.slice();
      if (rounds.length >= MAX_ROUNDS) {
        return { ok: false, reason: 'limit-reached', rounds: rounds, kept: rounds.length };
      }
      var next;
      try { next = JSON.parse(JSON.stringify(entry)); }
      catch (e) { return { ok: false, reason: 'clone-failed', error: errText(e), rounds: rounds }; }
      if (!isObj(next) || next.dryRun !== true) return { ok: false, reason: 'clone-failed', rounds: rounds };
      rounds.push(next);
      var payload;
      try { payload = JSON.stringify({ schema: STORE_SCHEMA, dryRun: true, rounds: rounds }); }
      catch (e) { return { ok: false, reason: 'serialize-failed', error: errText(e), rounds: rounds }; }
      try { st.setItem(STORAGE_KEY, payload); }
      catch (e) { return { ok: false, reason: 'write-failed', error: errText(e), rounds: loaded.rounds }; }
      var verify = load();
      if (!verify.ok || verify.rounds.length !== rounds.length) {
        return { ok: false, reason: 'write-not-persisted', rounds: loaded.rounds };
      }
      return { ok: true, rounds: rounds, roundNo: next.roundNo };
    }

    function clear() {
      if (!available) return { ok: false, reason: 'storage-unavailable' };
      try { st.removeItem(STORAGE_KEY); }
      catch (e) { return { ok: false, reason: 'clear-failed', error: errText(e) }; }
      return { ok: true };
    }

    return { available: available, load: load, saveRound: saveRound, clear: clear };
  }

  /** 下一轮编号：取已存最大轮号 + 1；历史为空时从 1 开始。 */
  function nextRoundNo(rounds) {
    var max = 0;
    if (!Array.isArray(rounds)) return 1;
    rounds.forEach(function (r) {
      var n = num(r && r.roundNo, 0, 0, null);
      if (n > max) max = n;
    });
    return max + 1;
  }

  /** 组装一轮存档：params / 消息范围 / priorSourceRound / 完整 result。 */
  function buildRound(opts, result, priorSourceRound) {
    var o = isObj(opts) ? opts : {};
    var res = isObj(result) ? result : {};
    var read = isObj(res.read) ? res.read : {};
    var ids = Array.isArray(read.ids) ? read.ids : [];
    return {
      dryRun: true,
      roundNo: num(o.roundNo, 1, 1, null),
      savedAt: num(o.savedAt, Date.now(), 0, null),
      params: {
        afterId: o.afterId == null ? null : o.afterId,
        limit: o.limit == null ? null : o.limit,
        maxChars: o.maxChars == null ? null : o.maxChars,
        tzOffsetMin: o.tzOffsetMin == null ? null : o.tzOffsetMin
      },
      priorSourceRound: priorSourceRound == null ? null : num(priorSourceRound, 0, 1, null),
      range: {
        firstId: ids.length ? ids[0] : null,
        lastId: ids.length ? ids[ids.length - 1] : null,
        afterId: read.afterId == null ? null : read.afterId,
        nextAfterId: read.nextAfterId == null ? null : read.nextAfterId,
        count: read.count == null ? null : read.count,
        done: read.done == null ? null : read.done
      },
      result: res
    };
  }

  function findRound(rounds, roundNo) {
    if (!Array.isArray(rounds)) return null;
    var target = num(roundNo, -1, 1, null);
    var found = null;
    rounds.forEach(function (r) { if (num(r && r.roundNo, -1, 1, null) === target) found = r; });
    return found;
  }

  /** 从某轮取出候选：只返回 candidates 数组副本，不重建消息、不带 ID 伪装。 */
  function candidatesFromRound(round) {
    if (!isObj(round) || round.dryRun !== true || !isObj(round.result)) return [];
    var list = round.result.candidates;
    return Array.isArray(list) ? list.slice() : [];
  }

  /** 把参考轮次的候选解析为 priorCandidates。不传 roundNo 即独立执行。 */
  function resolvePriorCandidates(store, roundNo) {
    if (roundNo == null || roundNo === '') return { ok: true, candidates: [], sourceRound: null };
    var loaded = store && typeof store.load === 'function' ? store.load() : { ok: false, reason: 'no-store', rounds: [] };
    if (!loaded.ok) return { ok: false, reason: loaded.reason, candidates: [], sourceRound: null };
    var round = findRound(loaded.rounds, roundNo);
    if (!round) return { ok: false, reason: 'round-not-found', candidates: [], sourceRound: null };
    return { ok: true, candidates: candidatesFromRound(round), sourceRound: num(round.roundNo, 0, 1, null) };
  }

  /** 回放：只从历史读取完整 result，绝不调用 AI / run。 */
  function replayRound(store, roundNo) {
    var loaded = store && typeof store.load === 'function' ? store.load() : { ok: false, reason: 'no-store', rounds: [] };
    if (!loaded.ok) return { ok: false, reason: loaded.reason, result: null };
    var round = findRound(loaded.rounds, roundNo);
    if (!round) return { ok: false, reason: 'round-not-found', result: null };
    return { ok: true, result: round.result, roundNo: round.roundNo };
  }

  /**
   * 上一批候选的安全投影：只保留「认识内容 + 语义标签」用于展示成参考文字。
   * 刻意丢掉 id / primaryMessageId / evidence / status / of，不生成合成消息 ID，
   * 也不伪装成聊天消息；因此这些候选既不会进入 evidence 白名单，也不会进入 contentMapOf。
   * 候选正文里自带的旧消息 ID 会随 text 原样进入提示词，但不属于当前批 ID，引用必被拒。
   */
  function projectPriorCandidates(list) {
    if (!Array.isArray(list)) return [];
    var out = [];
    list.forEach(function (c) {
      if (!isObj(c)) return;
      var note = {
        kind: str(c.kind),
        basis: str(c.basis),
        confidence: str(c.confidence),
        text: str(c.text),
        observed: str(c.observed),
        inferred: str(c.inferred),
        question: str(c.question)
      };
      if (!note.text && !note.observed && !note.inferred && !note.question) return;
      out.push(note);
    });
    return out;
  }

  /* ---------------- P0-1 / P0-2 正式采纳 + 安全水位（纯逻辑，可 Node 测试） ----------------
   * 审核状态只存在于面板内存，刷新即丢（不会自动采纳历史候选）。
   * 采纳一律走 SelfNarrative.create；用确定性 id 保证重复点击幂等，不另造写入逻辑。
   */

  function candidateSeed(c) {
    var c2 = isObj(c) ? c : {};
    var ids = (Array.isArray(c2.evidence) ? c2.evidence : []).map(function (e) {
      return e && e.messageId != null ? String(e.messageId) : '';
    }).filter(Boolean).sort();
    return [str(c2.kind), ids.join(','), str(c2.text), str(c2.observed),
      str(c2.inferred), str(c2.question)].join('|');
  }

  // 候选 → SelfNarrative.create 的白名单参数：字段严格对齐 validateCreate 的 PATCH_FIELDS。
  // 关键映射：evidence 剥掉 original，只留 {messageId, quote}；source={kind:'chat',messageId:evidence[0]}
  // 保证 checkSemantics 的「主证据与第一条 evidence 同源」；confirmed 强制清空。
  function candidateToCreateSpec(c, snApi) {
    if (!isObj(c)) return { ok: false, reason: 'bad-candidate' };
    var ev = [];
    (Array.isArray(c.evidence) ? c.evidence : []).forEach(function (e) {
      if (!isObj(e) || e.messageId == null) return;
      var q = str(e.quote).trim();
      if (!q) return;
      ev.push({ messageId: e.messageId, quote: q });
    });
    if (!ev.length) return { ok: false, reason: 'no-evidence' };
    var fp = snApi && typeof snApi.fingerprint === 'function'
      ? snApi.fingerprint(candidateSeed(c))
      : 'fallback-' + candidateSeed(c).length + '-' + str(candidateSeed(c)).slice(0, 24);
    // 人工重建候选沿用同一张白名单写入表，只在 source 上留下可辨认的来源标记。
    // source 本就是开放对象，因此不需要改 selfNarrative.v1 的 schema。
    var manual = c.manual === true || c.origin === MANUAL_ORIGIN;
    var source = manual
      ? { kind: MANUAL_ORIGIN, messageId: ev[0].messageId, origin: MANUAL_ORIGIN, aiGenerated: false }
      : { kind: 'chat', messageId: ev[0].messageId };
    if (manual && isObj(c.evidenceVerification) && c.evidenceVerification.verifiedAt != null) {
      source.evidenceVerifiedAt = c.evidenceVerification.verifiedAt;
    }
    return {
      ok: true,
      spec: {
        id: 'sn-adopt-' + fp,
        text: str(c.text),
        kind: c.kind,
        observed: str(c.observed),
        inferred: str(c.inferred),
        confirmed: '',   // 延续 confirmed 拦截：任何候选都不能自行确认
        question: str(c.question),
        confidence: c.confidence,
        topic: str(c.topic),
        basis: c.basis,
        evidence: ev,
        source: source
      }
    };
  }

  function initReview(candidates) {
    return (Array.isArray(candidates) ? candidates : []).map(function (c, i) {
      return { key: 'c' + i, idx: i, status: 'pending', candidate: c };
    });
  }

  function setReviewDecision(state, key, decision) {
    if (decision !== 'adopt' && decision !== 'skip') return state;
    return (Array.isArray(state) ? state : []).map(function (x) {
      return x.key === key ? { key: x.key, idx: x.idx, status: decision, candidate: x.candidate } : x;
    });
  }

  function reviewPending(state) {
    return (Array.isArray(state) ? state : []).filter(function (x) { return x.status === 'pending'; });
  }

  // 逐条采纳：单条失败不中断其余；确定性 id 让重复点击命中 duplicate-id，按幂等成功处理。
  async function adoptReviewed(store, state, deps) {
    var out = [];
    var list = Array.isArray(state) ? state : [];
    var sn = deps && deps.selfNarrative;
    var nowFn = deps && typeof deps.now === 'function' ? deps.now : Date.now;
    if (!sn || typeof sn.create !== 'function' || !store || typeof store.get !== 'function') {
      return list.filter(function (x) { return x && x.status === 'adopt'; }).map(function (x) {
        return { key: x.key, idx: x.idx, ok: false, reason: 'no-write-deps' };
      });
    }
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (!item || item.status !== 'adopt') continue;
      var mapped = candidateToCreateSpec(item.candidate, sn);
      if (!mapped.ok) {
        out.push({ key: item.key, idx: item.idx, ok: false, reason: mapped.reason });
        continue;
      }
      try {
        var created = await sn.create(store, mapped.spec, { now: nowFn() });
        if (created && created.ok) {
          out.push({ key: item.key, idx: item.idx, ok: true, id: created.id, idempotent: false });
        } else if (created && created.reason === 'duplicate-id') {
          out.push({ key: item.key, idx: item.idx, ok: true, id: created.detail, idempotent: true });
        } else {
          out.push({ key: item.key, idx: item.idx, ok: false,
            reason: created ? created.reason : 'no-result', error: created && created.error });
        }
      } catch (e) {
        out.push({ key: item.key, idx: item.idx, ok: false, reason: 'create-threw', error: errText(e) });
      }
    }
    return out;
  }

  // 水位推进条件：没有未审核候选，且每条采纳结果成功（含幂等命中）。全跳过也算完整审核。
  function canAdvanceReview(state, adoptResults) {
    var pending = reviewPending(state);
    if (pending.length) return { ok: false, reason: 'pending', pending: pending.length };
    var failed = (Array.isArray(adoptResults) ? adoptResults : []).filter(function (r) { return !r.ok; });
    if (failed.length) return { ok: false, reason: 'adopt-failed', failed: failed };
    return { ok: true };
  }

  /* 人工重建审核的独立完成通路：只写入采纳项，绝不读/写水位。
   * 与 AI dry-run 的 finish 完全分离：不调用 saveWatermark，也不依赖 currentResult.read。
   * 返回 done 只在「没有待审、没有失败」时为 true；失败项原样回传给面板显示。
   */
  async function completeManualReview(store, state, deps) {
    var list = Array.isArray(state) ? state : [];
    var pending = reviewPending(list);
    var adoptCount = list.filter(function (x) { return x && x.status === 'adopt'; }).length;
    var skipCount = list.filter(function (x) { return x && x.status === 'skip'; }).length;
    if (pending.length) {
      return {
        ok: false, done: false, reason: 'pending', pending: pending.length,
        adopted: 0, adoptedOk: 0, skipped: skipCount, failed: [], results: [],
        watermarkTouched: false
      };
    }
    var results = await adoptReviewed(store, list, deps);
    var failed = results.filter(function (r) { return !r.ok; });
    var adoptedOk = results.filter(function (r) { return r.ok; }).length;
    return {
      ok: failed.length === 0,
      done: failed.length === 0,
      reason: failed.length ? 'adopt-failed' : null,
      pending: 0,
      adopted: adoptCount,
      adoptedOk: adoptedOk,
      skipped: skipCount,
      failed: failed,
      results: results,
      watermarkTouched: false
    };
  }

  function isWatermarkId(n) { return typeof n === 'number' && isFinite(n) && n >= 0 && Math.floor(n) === n; }

  function normalizeWatermark(raw) {
    if (raw == null) return { ok: true, value: 0, empty: true };
    if (!isObj(raw) || raw.schema !== WATERMARK_SCHEMA || !isWatermarkId(raw.lastAfterId)) {
      return { ok: false, reason: 'bad-shape' };
    }
    return { ok: true, value: raw.lastAfterId, raw: raw };
  }

  async function loadWatermark(kvGet) {
    if (typeof kvGet !== 'function') return { ok: false, reason: 'no-kv', value: 0 };
    var raw;
    try { raw = await kvGet(WATERMARK_KEY); }
    catch (e) { return { ok: false, reason: 'read-failed', error: errText(e), value: 0 }; }
    return normalizeWatermark(raw);
  }

  async function saveWatermark(kvSet, info) {
    if (typeof kvSet !== 'function') return { ok: false, reason: 'no-kv' };
    var i = isObj(info) ? info : {};
    if (!isWatermarkId(i.nextAfterId)) return { ok: false, reason: 'bad-next-after-id' };
    var payload = {
      schema: WATERMARK_SCHEMA,
      lastAfterId: i.nextAfterId,
      updatedAt: isWatermarkId(i.savedAt) ? i.savedAt : Date.now(),
      fromAfterId: isWatermarkId(i.afterId) ? i.afterId : null,
      firstId: i.firstId == null ? null : i.firstId,
      lastId: i.lastId == null ? null : i.lastId,
      adopted: num(i.adopted, 0, 0, null),
      skipped: num(i.skipped, 0, 0, null),
      dryRun: false
    };
    try { await kvSet(WATERMARK_KEY, payload); }
    catch (e) { return { ok: false, reason: 'write-failed', error: errText(e) }; }
    return { ok: true, value: payload };
  }

  function collectDeps(override) {
    var injected = isObj(override) ? override : {};
    var page = isObj(root.SelfNarrativeDryRunDeps) ? root.SelfNarrativeDryRunDeps : {};
    return {
      reader: injected.reader || root.RoomChatReader || null,
      review: injected.review || root.SelfNarrativeReview || null,
      selfNarrative: injected.selfNarrative || root.SelfNarrative || null,
      callAI: injected.callAI || page.callAI || root.callAI || null,
      kvGet: injected.kvGet || page.kvGet || root.kvGet || null,
      kvSet: injected.kvSet || page.kvSet || root.kvSet || null,
      usage: injected.usage || root.AIUsage || null,
      location: injected.location || (typeof location !== 'undefined' ? location : null),
      now: injected.now || Date.now
    };
  }

  /** 127.0.0.1:8787 与 localhost:8787 是两个不同的 IndexedDB origin。 */
  function originProblem(loc) {
    if (!loc) return null;
    var host = str(loc.hostname).toLowerCase();
    var port = str(loc.port);
    if (host === 'localhost' && port === '8787') {
      return '当前页面是 localhost:8787，它的 IndexedDB 与 127.0.0.1:8787 是两份。请用 http://127.0.0.1:8787/ 打开后再试跑。';
    }
    return null;
  }

  /**
   * 跑一次单批 dry-run。opts 可传 afterId / limit / maxChars / priorCandidates。
   * priorCandidates 只是上一批的初步认识，投影后作为不含 ID 的参考文字进入提示词，
   * 不进 ctx、不进 evidence 白名单、不进 contentMapOf、不写任何数据。
   * 第二个参数仅用于测试注入依赖；页面里不用。
   */
  async function run(opts, depsOverride) {
    var o = isObj(opts) ? opts : {};
    var deps = collectDeps(depsOverride);
    var started = deps.now();
    var result = {
      ok: false,
      dryRun: true,
      requestType: REQUEST_TYPE,
      model: MODEL_NOTE,
      startedAt: started,
      wallClockMs: 0,
      origin: deps.location ? str(deps.location.href) : null,
      afterIdSource: 'params',
      read: null,
      batch: null,
      ai: { attempted: false, ok: false, reason: 'not-started', errorCode: null, errorMessage: null, raw: null, usage: null },
      validation: null,
      dedupe: null,
      summary: { candidates: 0, valid: 0, duplicates: 0, rejected: 0, ctxOnly: 0 },
      warnings: []
    };

    function finish() {
      result.wallClockMs = deps.now() - started;
      return result;
    }

    var problem = originProblem(deps.location);
    if (problem) {
      result.read = { ok: false, reason: 'wrong-origin', error: problem };
      result.warnings.push(problem);
      return finish();
    }

    var missing = [];
    if (!deps.reader || typeof deps.reader.readBatch !== 'function') missing.push('RoomChatReader');
    if (!deps.review || typeof deps.review.buildPrompt !== 'function') missing.push('SelfNarrativeReview');
    if (!deps.callAI) missing.push('callAI');
    if (!deps.kvGet) missing.push('kvGet');
    if (missing.length) {
      result.read = { ok: false, reason: 'missing-deps', error: '缺少依赖：' + missing.join('、') };
      result.warnings.push(result.read.error);
      return finish();
    }

    var afterId = num(o.afterId, 0, 0, null);
    // P0-2：未显式传 afterId 时，默认从独立水位键继续读取（开区间游标语义不变）。
    if (o.afterId == null) {
      var wm = await loadWatermark(deps.kvGet);
      if (wm.ok && !wm.empty && wm.value > 0) {
        afterId = wm.value;
        result.afterIdSource = 'watermark';
      } else if (!wm.ok) {
        result.warnings.push('读取水位失败（' + str(wm.reason) + '），本批从 afterId=0 开始；不会推进任何水位。');
      }
    }
    var limit = num(o.limit, 80, 1, 500);       // 与 reader 的默认/硬上限一致
    var maxChars = num(o.maxChars, 12000, 1, 200000);

    /* 1. 只读一批真实聊天 */
    var read;
    try {
      read = await deps.reader.readBatch({ afterId: afterId, limit: limit, maxChars: maxChars });
    } catch (e) {
      result.read = { ok: false, reason: 'read-threw', error: errText(e), afterId: afterId, limit: limit, maxChars: maxChars };
      result.warnings.push('读取阶段抛出异常，未调用 AI：' + errText(e));
      return finish();
    }
    result.read = {
      ok: !!read && read.ok !== false,
      reason: read && read.reason,
      error: read && read.error ? read.error : null,
      afterId: afterId, limit: limit, maxChars: maxChars,
      count: read && Array.isArray(read.messages) ? read.messages.length : 0,
      chars: read && isObj(read) ? read.chars : null,
      nextAfterId: read ? read.nextAfterId : null,
      done: read ? read.done : null,
      ids: read && Array.isArray(read.messages) ? read.messages.map(function (m) { return m && m.id; }) : []
    };
    if (!result.read.ok || !Array.isArray(read.messages)) {
      result.warnings.push('读取失败（' + str(result.read.reason) + '），未调用 AI；这不是空结果。');
      return finish();
    }
    if (!read.messages.length) {
      result.warnings.push('这一批没有消息（afterId=' + afterId + '，done=' + str(read.done) + '）。未调用 AI；dry-run 到此结束，不会自动扫描下一批。');
      return finish();
    }

    /* 2. S1b 提示词：本批即一个回顾单元，不加载全库、不合并相邻同角色消息 */
    var tz = deps.review.resolveTzOffset(read.messages, o.tzOffsetMin);
    var priorNotes = projectPriorCandidates(o.priorCandidates);
    var promptBatch = {
      messages: read.messages,
      ctx: [],                                  // 跨批候选不是聊天上下文，永远保持空
      dayKey: deps.review.dayKeyOf(read.messages[0].time, tz)
    };
    var prompt = deps.review.buildPrompt(promptBatch, { priorNotes: priorNotes });
    result.batch = {
      dayKey: promptBatch.dayKey,
      tzOffsetMin: tz,
      ids: result.read.ids.slice(),
      ctxCount: 0,
      priorNoteCount: priorNotes.length,
      promptChars: str(prompt.system).length + str(prompt.user).length
    };

    /* 3. 一次 AI 请求：不重试、不连续扫描 */
    var usageBefore = getUsageCount(deps);
    var t0 = deps.now();
    result.ai.attempted = true;
    var raw;
    try {
      raw = await deps.callAI([
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user }
      ], { requestType: REQUEST_TYPE, timeoutMs: 45000 });
    } catch (e) {
      result.ai.ok = false;
      result.ai.reason = 'ai-failed';
      result.ai.errorCode = (e && e.code) || 'ERROR';
      result.ai.errorMessage = errText(e);
      result.ai.elapsedMs = deps.now() - t0;
      result.ai.usage = readUsage(deps, usageBefore);
      result.warnings.push('AI 请求失败（' + result.ai.errorCode + '），没有经过校验的候选；未重试。');
      return finish();
    }
    result.ai.ok = true;
    result.ai.reason = 'ok';
    result.ai.raw = str(raw);
    result.ai.elapsedMs = deps.now() - t0;
    result.ai.usage = readUsage(deps, usageBefore);

    /* 4. S1b 完整校验：来源 id 必须在批内、quote 必须在完整正文里 */
    var validated;
    try {
      validated = deps.review.validateOutput(raw, promptBatch, {});
    } catch (e) {
      result.validation = { ok: false, reason: 'validate-threw', error: errText(e), records: [], rejected: [], stats: null };
      result.warnings.push('校验阶段异常：' + errText(e));
      return finish();
    }
    // S1b 允许 basis='stated' 时带 confirmed；但单批历史回顾里没有「用户后来明确确认」
    // 这个信号，模型写出来的 confirmed 只是自述。dry-run 一律拦下，绝不自动标成已确认。
    if (validated && validated.ok && Array.isArray(validated.records)) {
      var autoConfirmed = validated.records.filter(function (r) { return !!str(r.confirmed).trim(); });
      if (autoConfirmed.length) {
        validated.records = validated.records.filter(function (r) { return !str(r.confirmed).trim(); });
        if (!Array.isArray(validated.rejected)) validated.rejected = [];
        autoConfirmed.forEach(function (r, i) {
          validated.rejected.push({ index: 'confirmed-' + i, reason: 'auto-confirmed-blocked', detail: str(r.confirmed) });
        });
        if (validated.stats) {
          validated.stats.accepted = validated.records.length;
          validated.stats.rejected = validated.rejected.length;
          validated.stats.autoConfirmedBlocked = autoConfirmed.length;
        }
      }
    }
    result.validation = {
      ok: !!validated.ok,
      reason: validated && validated.reason,
      error: validated && validated.error ? validated.error : null,
      records: validated && Array.isArray(validated.records) ? validated.records : [],
      rejected: validated && Array.isArray(validated.rejected) ? validated.rejected : [],
      stats: validated && validated.stats ? validated.stats : null
    };
    if (result.validation.stats && result.validation.stats.autoConfirmedBlocked) {
      result.warnings.push('已拦下 ' + result.validation.stats.autoConfirmedBlocked + ' 条带 confirmed 的候选：单批回顾没有用户确认信号，不能把用户自述自动标成已确认。');
    }
    result.summary.candidates = result.validation.stats ? result.validation.stats.total : result.validation.records.length + result.validation.rejected.length;
    result.summary.valid = result.validation.records.length;
    result.summary.rejected = result.validation.rejected.length;
    if (!result.validation.ok) {
      result.warnings.push('AI 输出结构不合法（' + str(result.validation.reason) + '），没有可用候选；不能当成空结果。');
      return finish();
    }

    /* 5. 用既有记录去重：只读，不写；任何状态都进索引 */
    var byId = {};
    read.messages.forEach(function (m) { if (m && m.id != null) byId[String(m.id)] = m; });
    var originalOf = function (ev) {
      var m = byId[String(ev && ev.messageId)];
      return m ? { id: m.id, role: m.role, content: m.content, time: m.time, source: m.source || null } : null;
    };

    var existing;
    try {
      var guardStore = {
        get: function (k) { return deps.kvGet(k); },
        // 只给读接口：dry-run 里任何写机自述的尝试都必须立刻失败并暴露
        set: function () { throw new Error('dry-run 禁止写入机自述'); }
      };
      existing = await deps.selfNarrative.list(guardStore, { status: 'all' });
    } catch (e) {
      result.dedupe = { ok: false, reason: 'dedupe-threw', error: errText(e) };
      result.warnings.push('读取既有机自述失败（' + errText(e) + '），本次不做重复判断；候选仍可人工查看。');
      return finish();
    }
    if (!existing || !existing.ok) {
      result.dedupe = { ok: false, reason: existing ? existing.reason : 'no-result', error: existing && existing.error ? existing.error : null };
      result.warnings.push('读取既有机自述失败（' + str(result.dedupe.reason) + '），本次不做重复判断；候选仍可人工查看。');
      return finish();
    }

    var index = deps.review.buildDedupeIndex(existing.records || []);
    var filtered = deps.review.applyDedupe(result.validation.records, index);
    result.dedupe = {
      ok: true,
      indexCount: index.count,
      noEvidence: index.noEvidence || 0,
      existingTotal: existing.total,
      newCount: filtered.accepted.length,
      duplicateCount: filtered.skipped.filter(function (s) { return s.reason === 'duplicate'; }).length,
      ctxOnlyCount: filtered.skipped.filter(function (s) { return s.reason === 'ctx-only'; }).length
    };
    result.summary.duplicates = result.dedupe.duplicateCount;
    result.summary.ctxOnly = result.dedupe.ctxOnlyCount;

    var skipOf = {};
    filtered.skipped.forEach(function (s) {
      var key = String(s.record && s.record.kind) + '|' + JSON.stringify(deps.review.evidenceIdsOf(s.record)) + '|' + deps.review.contentKey(s.record);
      skipOf[key] = s;
    });
    result.candidates = filtered.accepted.map(function (r) {
      return attachOriginal(r, 'new', null, originalOf);
    });
    result.skipped = filtered.skipped.map(function (s) {
      return {
        reason: s.reason,
        of: s.of || null,
        record: attachOriginal(s.record, s.reason, s.of, originalOf)
      };
    });
    result.ok = true;
    return finish();
  }

  function attachOriginal(rec, status, of, originalOf) {
    var out = {
      status: status,
      of: of || null,
      kind: rec.kind,
      text: rec.text,
      basis: rec.basis,
      confidence: rec.confidence,
      observed: rec.observed,
      inferred: rec.inferred,
      confirmed: rec.confirmed,
      question: rec.question,
      topic: rec.topic,
      primaryMessageId: rec.primaryMessageId,
      allCtx: !!rec.allCtx,
      evidence: (rec.evidence || []).map(function (e) {
        return { messageId: e.messageId, quote: e.quote, original: originalOf(e) };
      })
    };
    return out;
  }

  function getUsageCount(deps) {
    if (!deps.usage || typeof deps.usage.query !== 'function') return null;
    try { return deps.usage.query({ requestType: REQUEST_TYPE }).length; }
    catch (e) { return null; }
  }

  function readUsage(deps, beforeCount) {
    if (!deps.usage || typeof deps.usage.query !== 'function') {
      return { available: false, reason: 'usage-module-missing' };
    }
    try {
      var list = deps.usage.query({ requestType: REQUEST_TYPE });
      if (beforeCount == null || list.length <= beforeCount) return { available: false, reason: 'no-new-entry' };
      var entry = list[list.length - 1];
      var summary = typeof deps.usage.summarize === 'function' ? deps.usage.summarize([entry]) : null;
      return {
        available: !!entry.usage && entry.usage.available !== false,
        entry: entry,
        summary: summary,
        // AIClient/AIUsage 的字段名是 prompt / completion / hit / total
        promptTokens: entry.usage ? entry.usage.prompt : null,
        completionTokens: entry.usage ? entry.usage.completion : null,
        cacheHitTokens: entry.usage ? entry.usage.hit : null,
        totalTokens: entry.usage ? entry.usage.total : null,
        costUsd: entry.cost ? entry.cost.usd : null,
        costCny: entry.cost ? entry.cost.cny : null,
        errorCode: entry.errorCode || null
      };
    } catch (e) {
      return { available: false, reason: 'usage-read-failed', error: errText(e) };
    }
  }

  /* ---------------- 人工重建候选（独立入口，不调用 AI） ----------------
   * 输入必须是显式标记的 JSON：{ origin:'manual-reconstruction', candidates:[...] }。
   * 每条 evidence 的 messageId 先经 RoomChatReader.getById 对真实聊天逐条查证；
   * quote 再由既有 SelfNarrativeReview.validateOutput 对原消息完整正文核对。
   * 核对失败的候选不进入审核区；原始 messageId / quote 绝不改写或替换。
   */

  function parseManualPayload(raw) {
    var text = str(raw).trim();
    if (!text) return { ok: false, reason: 'empty-input' };
    var payload;
    try { payload = JSON.parse(text); }
    catch (e) { return { ok: false, reason: 'bad-json', error: errText(e) }; }
    if (!isObj(payload) || payload.origin !== MANUAL_ORIGIN) {
      return { ok: false, reason: 'not-manual-reconstruction' };
    }
    if (!Array.isArray(payload.candidates) || !payload.candidates.length) {
      return { ok: false, reason: 'no-candidates' };
    }
    return { ok: true, candidates: payload.candidates, note: str(payload.note) };
  }

  function manualReject(out, index, reason, detail) {
    out.rejected.push({ index: index, reason: reason, detail: detail == null ? null : str(detail) });
  }

  /**
   * verifyManualCandidates(raw, deps) → { ok, manual:true, accepted, rejected, warnings, stats }
   * 不写任何库、不调用 AI、不保存批次、不碰水位。
   */
  async function verifyManualCandidates(raw, depsOverride) {
    var deps = collectDeps(depsOverride);
    var out = {
      ok: false, manual: true, dryRun: false, origin: MANUAL_ORIGIN, label: MANUAL_LABEL,
      accepted: [], rejected: [], warnings: [], note: '',
      stats: { total: 0, accepted: 0, rejected: 0, evidenceChecked: 0 },
      ai: { attempted: false, ok: false, reason: 'not-applicable' }
    };
    var parsed = parseManualPayload(raw);
    if (!parsed.ok) { out.reason = parsed.reason; out.error = parsed.error || null; return out; }
    out.note = parsed.note;
    out.stats.total = parsed.candidates.length;
    if (!deps.reader || typeof deps.reader.getById !== 'function') {
      out.reason = 'missing-reader';
      out.warnings.push('缺少 RoomChatReader.getById，无法核验真实聊天证据。');
      return out;
    }
    if (!deps.review || typeof deps.review.validateOutput !== 'function') {
      out.reason = 'missing-review';
      out.warnings.push('缺少 SelfNarrativeReview.validateOutput，无法核验证据结构与原文。');
      return out;
    }

    /* 1. 先按 messageId 对真实聊天逐条取证；只缓存投影，不改候选。 */
    var cache = {};
    var order = [];
    parsed.candidates.forEach(function (c) {
      if (!isObj(c) || !Array.isArray(c.evidence)) return;
      c.evidence.forEach(function (e) {
        if (!isObj(e) || e.messageId == null) return;
        var key = 'id:' + str(e.messageId);
        if (cache[key]) return;
        cache[key] = { raw: e.messageId, state: 'pending' };
        order.push(key);
      });
    });
    for (var i = 0; i < order.length; i++) {
      var item = cache[order[i]];
      var got;
      try { got = await deps.reader.getById(item.raw); }
      catch (e) { got = { ok: false, reason: 'get-threw', error: errText(e), exists: false }; }
      if (got && got.ok && got.exists && got.message) {
        item.state = 'found';
        item.message = got.message;
      } else {
        item.state = (got && got.reason === 'bad-params') ? 'bad-id' : 'not-found';
        item.error = got && (got.error || got.reason);
      }
    }
    out.stats.evidenceChecked = order.length;

    /* 2. 缺失消息 ID 的候选直接拒绝，不把猜测带进审核区。 */
    var eligible = [];
    var originalIndex = [];
    parsed.candidates.forEach(function (c, idx) {
      if (!isObj(c)) { manualReject(out, idx, 'bad-item'); return; }
      var missing = null;
      (Array.isArray(c.evidence) ? c.evidence : []).forEach(function (e) {
        if (missing || !isObj(e) || e.messageId == null) return;
        var hit = cache['id:' + str(e.messageId)];
        if (!hit || hit.state !== 'found') {
          missing = { messageId: e.messageId, reason: hit && hit.state === 'bad-id' ? 'bad-message-id' : 'message-not-found' };
        }
      });
      if (missing) {
        manualReject(out, idx, missing.reason, missing.messageId);
        return;
      }
      eligible.push(c);
      originalIndex.push(idx);
    });

    /* 3. 复用 S1b 校验：quote 必须与真实消息完整正文逐字相符，结构也一并校验。 */
    if (eligible.length) {
      var messages = [];
      var seenMsg = {};
      order.forEach(function (key) {
        var hit = cache[key];
        if (!hit || hit.state !== 'found' || seenMsg[String(hit.message.id)]) return;
        seenMsg[String(hit.message.id)] = true;
        messages.push(hit.message);
      });
      var batch = { messages: messages, ctx: [], dayKey: '' };
      var validated;
      try {
        validated = deps.review.validateOutput(JSON.stringify({ records: eligible }), batch, {});
      } catch (e) {
        validated = { ok: false, reason: 'validate-threw', error: errText(e), records: [], rejected: [] };
      }
      if (!validated || !validated.ok) {
        var why = validated ? str(validated.reason) : 'no-result';
        eligible.forEach(function (_, j) { manualReject(out, originalIndex[j], why, validated && validated.error); });
      } else {
        (validated.rejected || []).forEach(function (r) {
          manualReject(out, originalIndex[num(r.index, 0, 0, null)], str(r.reason), r.detail);
        });
        var verifiedAt = deps.now();
        var accepted = (validated.records || []).map(function (r) {
          return Object.assign({}, r, {
            status: 'new',
            of: null,
            manual: true,
            origin: MANUAL_ORIGIN,
            sourceLabel: MANUAL_LABEL,
            allCtx: false,
            primaryMessageId: (r.evidence[0] || {}).messageId,
            evidenceVerification: {
              ok: true,
              verifiedAt: verifiedAt,
              checks: (r.evidence || []).map(function (e) {
                var hit = cache['id:' + str(e.messageId)];
                return {
                  messageId: e.messageId,
                  quote: str(e.quote),
                  result: 'matched',
                  messageRole: hit && hit.message ? str(hit.message.role) : ''
                };
              })
            }
          });
        });

        /* 4. 与 AI 候选一样对照正式记录去重（只读）。去重失败只提示，不伪造结论。 */
        if (accepted.length && deps.selfNarrative && deps.kvGet &&
            typeof deps.selfNarrative.list === 'function' &&
            deps.review.buildDedupeIndex && deps.review.applyDedupe) {
          var guardStore = { get: function (k) { return deps.kvGet(k); }, set: function () { throw new Error('人工核验禁止写入'); } };
          var existing;
          try { existing = await deps.selfNarrative.list(guardStore, { status: 'all' }); }
          catch (e) { existing = { ok: false, reason: 'dedupe-threw', error: errText(e) }; }
          if (!existing || !existing.ok) {
            out.warnings.push('读取既有机自述失败（' + str(existing && existing.reason) + '），本次未做重复判断。');
          } else {
            var index = deps.review.buildDedupeIndex(existing.records || []);
            var kept = [];
            (validated.records || []).forEach(function (_, j) {
              if (accepted[j]) kept.push(accepted[j]);
            });
            var flt = deps.review.applyDedupe(kept, index);
            var keptSet = {};
            (flt.accepted || []).forEach(function (r) { keptSet[r] = true; });
            accepted = accepted.filter(function (r) { return !!keptSet[r]; });
            (flt.skipped || []).forEach(function (s) {
              var pos = kept.indexOf(s.record);
              if (pos >= 0) manualReject(out, originalIndex[pos], str(s.reason), str(s.of));
            });
          }
        }
        out.accepted = accepted;
      }
    }
    out.stats.accepted = out.accepted.length;
    out.stats.rejected = out.rejected.length;
    out.ok = out.accepted.length > 0;
    if (!out.ok && !out.rejected.length) out.reason = out.reason || 'no-valid-candidates';
    return out;
  }

  /* ---------------- 最小面板 ---------------- */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = 'sn-dry-' + cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  function line(label, value) {
    var row = el('div', 'kv');
    row.appendChild(el('span', 'k', label));
    row.appendChild(el('span', 'v', value == null ? '—' : String(value)));
    return row;
  }
  function section(title) { return el('div', 'sec', title); }

  function renderResult(host, r, meta) {
    r = isObj(r) ? r : {};
    host.textContent = '';
    var m = isObj(meta) ? meta : {};
    var head = el('div', 'verdict', r.ok ? 'DRY-RUN 完成：未写入任何机自述' : '本次未产生可用候选（未写入任何机自述）');
    host.appendChild(head);
    // 安全横幅：回放与当前结果 alike，明确这是测试历史、不写正式数据。
    host.appendChild(el('div', 'note',
      'DRY-RUN · 不写入正式机自述 · 不推进正式水位' +
      (m.roundNo ? ' · 第 ' + m.roundNo + ' 轮' : '') +
      (m.priorSourceRound ? ' · 参考第 ' + m.priorSourceRound + ' 轮候选（仅供参考，非证据）' : '') +
      (m.replay ? ' · 历史回放（未重新请求 AI）' : '')
    ));

    var s = section('读取范围');
    s.appendChild(line('origin', r.origin));
    s.appendChild(line('afterId / 限制', r.read ? (r.read.afterId + ' / ' + r.read.limit + ' 条 · ' + r.read.maxChars + ' 字') : '—'));
    s.appendChild(line('结果', r.read ? (r.read.reason + (r.read.error ? '：' + r.read.error : '')) : '—'));
    s.appendChild(line('消息数', r.read ? r.read.count : '—'));
    s.appendChild(line('消息 ID', r.read && r.read.ids.length ? (r.read.ids[0] + ' … ' + r.read.ids[r.read.ids.length - 1]) : '—'));
    s.appendChild(line('nextAfterId / done', r.read ? (r.read.nextAfterId + ' / ' + r.read.done) : '—'));
    host.appendChild(s);

    var b = section('请求');
    b.appendChild(line('模型', r.model));
    b.appendChild(line('requestType', r.requestType));
    b.appendChild(line('提示词字符', r.batch ? r.batch.promptChars : '—'));
    b.appendChild(line('批日期 / 时区', r.batch ? (r.batch.dayKey + ' / UTC' + (r.batch.tzOffsetMin / 60)) : '—'));
    b.appendChild(line('AI 耗时', r.ai.elapsedMs != null ? r.ai.elapsedMs + ' ms' : '—'));
    b.appendChild(line('AI 状态', r.ai.errorMessage ? (r.ai.errorCode + '：' + r.ai.errorMessage) : r.ai.reason));
    host.appendChild(b);

    var u = section('本次 AI 用量');
    var usage = r.ai.usage || {};
    u.appendChild(line('可用', usage.available == null ? '—' : (usage.available ? '是' : '否' + (usage.reason ? '（' + usage.reason + '）' : ''))));
    u.appendChild(line('输入 Token', usage.promptTokens));
    u.appendChild(line('输出 Token', usage.completionTokens));
    u.appendChild(line('缓存 Token', usage.cacheHitTokens));
    u.appendChild(line('合计 Token', usage.totalTokens));
    u.appendChild(line('费用', usage.costCny != null ? ('¥' + usage.costCny + ' / $' + usage.costUsd) : '—'));
    host.appendChild(u);

    var v = section('校验结果');
    v.appendChild(line('候选 / 有效 / 重复 / 拒绝', [r.summary.candidates, r.summary.valid, r.summary.duplicates, r.summary.rejected].join(' / ')));
    if (r.validation) {
      v.appendChild(line('校验状态', r.validation.reason + (r.validation.error ? '：' + r.validation.error : '')));
      (r.validation.rejected || []).forEach(function (x) {
        v.appendChild(el('div', 'bad', '#' + x.index + ' 拒绝：' + x.reason + (x.detail != null ? '（' + x.detail + '）' : '')));
      });
    } else {
      v.appendChild(el('div', 'bad', '校验未执行：AI 请求或读取未成功，不能当作空结果。'));
    }
    host.appendChild(v);

    // 独立的去重结果展示：与正式库对照，但只读、不写。
    var dg = section('去重结果（对照正式机自述，只读）');
    var dd = isObj(r.dedupe) ? r.dedupe : {};
    if (r.dedupe) {
      dg.appendChild(line('去重状态', dd.ok ? 'ok' : ('未执行 / 失败：' + str(dd.reason))));
      dg.appendChild(line('索引记录数 / 正式总数', dd.indexCount + ' / ' + dd.existingTotal));
      dg.appendChild(line('本批新认识 / 重复 / 仅上下文', dd.newCount + ' / ' + dd.duplicateCount + ' / ' + dd.ctxOnlyCount));
      dg.appendChild(line('无证据索引项', dd.noEvidence));
      if (!dd.ok && dd.error) dg.appendChild(line('错误', dd.error));
    } else {
      dg.appendChild(el('div', 'bad', '去重未执行：读取/校验阶段未成功，不能当作无重复。'));
    }
    host.appendChild(dg);

    (r.candidates || []).forEach(function (c, i) {
      var card = el('div', 'card');
      card.appendChild(el('div', 'cardhead', '#' + (i + 1) + ' · ' + c.kind + ' · ' + c.basis + ' · ' + c.confidence + ' · ' + c.status));
      card.appendChild(el('div', 'body', c.text));
      if (c.observed) card.appendChild(line('observed', c.observed));
      if (c.inferred) card.appendChild(line('inferred', c.inferred));
      if (c.confirmed) card.appendChild(line('confirmed', c.confirmed));
      if (c.question) card.appendChild(line('question', c.question));
      (c.evidence || []).forEach(function (e) {
        var ev = el('div', 'ev');
        ev.appendChild(el('div', 'evhead', '证据 [msg ' + e.messageId + '] · ' + (e.original ? (e.original.role + ' · ' + new Date(e.original.time).toLocaleString()) : '原文未取到')));
        ev.appendChild(el('div', 'quote', 'quote：' + e.quote));
        ev.appendChild(el('div', 'orig', '原消息：' + (e.original ? e.original.content : '—')));
        card.appendChild(ev);
      });
      host.appendChild(card);
    });

    (r.skipped || []).forEach(function (x, i) {
      var card = el('div', 'card muted');
      card.appendChild(el('div', 'cardhead', '跳过 #' + (i + 1) + ' · ' + x.reason + (x.of ? ' · of=' + JSON.stringify(x.of) : '')));
      card.appendChild(el('div', 'body', x.record && x.record.text));
      host.appendChild(card);
    });

    (r.warnings || []).forEach(function (w) { host.appendChild(el('div', 'bad', '提示：' + w)); });

    if (r.ai.raw != null) {
      var d = el('details', 'raw');
      d.appendChild(el('summary', '', '原始 AI 输出（未加工）'));
      d.appendChild(el('pre', '', r.ai.raw));
      host.appendChild(d);
    }
  }

  function mount() {
    if (typeof document === 'undefined' || document.getElementById('sn-dryrun-root')) return;
    var style = document.createElement('style');
    style.textContent = [
      '.sn-dry-fab{position:fixed;right:16px;bottom:16px;z-index:9998;padding:9px 14px;border:0;border-radius:20px;background:#4f7cff;color:#fff;font-size:13px;cursor:pointer;box-shadow:0 4px 16px #0003}',
      '.sn-dry-panel{position:fixed;right:16px;bottom:60px;z-index:9999;width:min(560px,calc(100vw - 32px));max-height:78vh;overflow:auto;background:#fff;color:#222;border:1px solid #d8dce6;border-radius:12px;box-shadow:0 12px 40px #0003;padding:14px;font:13px/1.6 system-ui,sans-serif}',
      '.sn-dry-title{font-weight:700;font-size:15px;margin-bottom:8px}',
      '.sn-dry-note{color:#666;font-size:12px;margin-bottom:10px}',
      '.sn-dry-row{display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap}',
      '.sn-dry-row label{font-size:12px;color:#555}',
      '.sn-dry-row input{width:88px;padding:5px 7px;border:1px solid #ccd2de;border-radius:6px}',
      '.sn-dry-go{padding:6px 12px;border:0;border-radius:6px;background:#2e9f6e;color:#fff;cursor:pointer}',
      '.sn-dry-go:disabled{background:#9aa7b5;cursor:wait}',
      '.sn-dry-verdict{padding:7px 9px;border-radius:6px;background:#eef7f1;color:#21633f;margin-bottom:10px}',
      '.sn-dry-sec{font-weight:700;border-bottom:1px solid #e6e9f0;margin:12px 0 5px;padding-bottom:3px}',
      '.sn-dry-kv{display:flex;gap:8px;font-size:12px}',
      '.sn-dry-kv .sn-dry-k{min-width:118px;color:#777;flex:none}',
      '.sn-dry-kv .sn-dry-v{word-break:break-all}',
      '.sn-dry-bad{color:#b42318;background:#fff1f0;padding:5px 7px;border-radius:5px;margin:4px 0}',
      '.sn-dry-card{border:1px solid #dde2ec;border-radius:8px;padding:9px;margin:8px 0;background:#fbfcfe}',
      '.sn-dry-card.sn-dry-muted{opacity:.75}',
      '.sn-dry-cardhead{font-weight:700;color:#345;font-size:12px}',
      '.sn-dry-body{margin:5px 0 7px;font-size:13px}',
      '.sn-dry-ev{border-left:3px solid #9fb6ff;padding:4px 8px;margin:6px 0;background:#fff}',
      '.sn-dry-evhead{font-size:11px;color:#667}',
      '.sn-dry-quote{color:#234}',
      '.sn-dry-orig{font-size:11px;color:#777;word-break:break-all}',
      '.sn-dry-raw{margin-top:10px;font-size:12px}',
      '.sn-dry-raw pre{max-height:220px;overflow:auto;background:#f4f6fa;padding:8px;white-space:pre-wrap;word-break:break-all}',
      '.sn-dry-sel{font:12px system-ui,sans-serif;padding:4px 6px;border:1px solid #ccd2de;border-radius:6px;max-width:250px}',
      '.sn-dry-status{font-size:12px;margin:6px 0;color:#21633f;background:#eef7f1;padding:5px 7px;border-radius:5px}',
      '.sn-dry-status.sn-dry-warn{color:#8a5a00;background:#fff8e6}',
      '.sn-dry-hist{margin:6px 0 4px;max-height:120px;overflow:auto;border:1px solid #e6e9f0;border-radius:6px;padding:4px}',
      '.sn-dry-hitem{display:block;width:100%;text-align:left;border:0;background:#f7f9fc;color:#234;padding:5px 7px;margin:3px 0;border-radius:5px;cursor:pointer;font:12px/1.5 system-ui,sans-serif}',
      '.sn-dry-hitem:hover{background:#eaf0ff}',
      '.sn-dry-hitem.sn-dry-active{background:#dce8ff;font-weight:700}',
      '.sn-dry-hmeta{color:#777;font-size:11px}',
      '.sn-dry-clear{padding:5px 10px;border:1px solid #e0a3a3;background:#fff;color:#b42318;border-radius:6px;cursor:pointer;font-size:12px}',
      '.sn-dry-review{max-height:300px;overflow:auto}',
      '.sn-dry-review-item{border:1px solid #dde2ec;border-radius:8px;padding:8px;margin:7px 0;background:#fff}',
      '.sn-dry-review-ctl{display:flex;gap:10px;align-items:center;margin-top:6px;font-size:12px;color:#444}',
      '.sn-dry-review-ctl label{cursor:pointer;user-select:none}',
      '.sn-dry-skip{padding:3px 8px;border:1px solid #d8dce6;background:#f7f9fc;color:#555;border-radius:5px;cursor:pointer;font-size:11px}',
      '.sn-dry-skip:disabled{opacity:.5;cursor:default}',
      '.sn-dry-finish{padding:7px 12px;border:0;border-radius:6px;background:#2f6fbf;color:#fff;cursor:pointer;font-size:12px;margin-top:4px}',
      '.sn-dry-finish:disabled{background:#9aa7b5;cursor:not-allowed}',
      '.sn-dry-finish-manual{background:#1f7a4d}',
      '.sn-dry-finish-manual:disabled{background:#9aa7b5;cursor:not-allowed}',
      '.sn-dry-done{font-size:12px;color:#1f7a4d;background:#eaf6ef;border:1px solid #bfe0cd;padding:6px 8px;border-radius:6px;margin-top:6px}',
      '.sn-dry-hidden{display:none}',
      '.sn-dry-manual-input{width:100%;min-height:88px;box-sizing:border-box;font:11px/1.5 ui-monospace,monospace;padding:7px;border:1px solid #ccd2de;border-radius:6px;resize:vertical}',
      '.sn-dry-manual-tag{display:inline-block;padding:1px 6px;border-radius:4px;background:#fff3d6;color:#8a5a00;font-size:11px;font-weight:700;margin-left:6px}',
      '.sn-dry-verify{font-size:11px;color:#21633f;background:#eef7f1;padding:4px 6px;border-radius:5px;margin-top:5px}',
      '.sn-dry-warnbox{font-size:12px;color:#8a5a00;background:#fff8e6;border:1px solid #f0d9a0;padding:7px 9px;border-radius:6px;margin:6px 0;white-space:pre-line;line-height:1.6}',
      '.sn-dry-result{font-size:12px;color:#234;background:#f7f9fc;border:1px solid #dde2ec;padding:7px 9px;border-radius:6px;margin:6px 0;white-space:pre-line;line-height:1.6}'
    ].join('\n');
    document.head.appendChild(style);

    var fab = el('button', 'fab', '机自述 · Dry-run 面板');
    fab.setAttribute('id', 'sn-dryrun-root');
    document.body.appendChild(fab);

    var panel = el('div', 'panel');
    panel.style.display = 'none';
    document.body.appendChild(panel);
    panel.appendChild(el('div', 'title', '机自述历史回顾 · 多轮 DRY-RUN'));
    panel.appendChild(el('div', 'note', 'DRY-RUN 测试：不写入正式机自述、不推进正式水位、不自动重试、不扫描下一批。每轮仅一次真实 AI 请求及其用量记录；测试历史只存本机独立键。'));

    var store = createStore();

    /* 1. 执行参数：输入框状态独立于历史选择与回放，绝不互相覆盖 */
    var row = el('div', 'row');
    var inAfter = document.createElement('input'); inAfter.value = '0'; inAfter.title = 'afterId';
    var inLimit = document.createElement('input'); inLimit.value = '80'; inLimit.title = 'limit';
    var inChars = document.createElement('input'); inChars.value = '12000'; inChars.title = 'maxChars';
    row.appendChild(el('label', '', 'afterId')); row.appendChild(inAfter);
    row.appendChild(el('label', '', 'limit')); row.appendChild(inLimit);
    row.appendChild(el('label', '', 'maxChars')); row.appendChild(inChars);
    panel.appendChild(row);

    /* 2. 参考来源：选择已存轮次的候选作为 priorCandidates，可留空独立执行 */
    var refRow = el('div', 'row');
    var refSel = document.createElement('select');
    refSel.className = 'sn-dry-sel';
    refSel.title = '参考来源轮次（其候选仅作参考认识，不进入证据白名单）';
    function fillRefSelect(keepValue) {
      var loaded = store.load();
      var prev = keepValue == null ? str(refSel.value) : str(keepValue);
      refSel.textContent = '';
      var none = document.createElement('option');
      none.value = ''; none.textContent = '不选择（独立执行）';
      refSel.appendChild(none);
      if (loaded.ok) {
        loaded.rounds.forEach(function (r) {
          var opt = document.createElement('option');
          opt.value = String(r.roundNo);
          var rg = isObj(r.range) ? r.range : {};
          opt.textContent = '第 ' + r.roundNo + ' 轮 · msg ' + rg.firstId + '–' + rg.lastId + ' · ' + (isObj(r.result) && isObj(r.result.summary) ? r.result.summary.valid : '?') + ' 候选';
          refSel.appendChild(opt);
        });
      }
      refSel.value = prev;
      if (refSel.value !== prev) refSel.value = '';
    }
    refRow.appendChild(el('label', '', '参考来源'));
    refRow.appendChild(refSel);
    refRow.appendChild(el('span', 'hmeta', '仅参考认识，不作证据'));
    panel.appendChild(refRow);

    var go = el('button', 'go', '开始 Dry-run');
    panel.appendChild(go);

    var status = el('div', 'status');
    panel.appendChild(status);
    function setStatus(text, warn) {
      status.textContent = text;
      if (warn) status.className = 'sn-dry-status sn-dry-warn';
      else status.className = 'sn-dry-status';
    }
    if (!store.available) setStatus('本机 localStorage 不可用：本轮结果仍可正常查看，但不会保存历史。', true);
    else setStatus('测试历史保存在本机独立键 ' + STORAGE_KEY + '（最多 ' + MAX_ROUNDS + ' 轮）。');

    /* 3. 历史轮次列表：点击查看回放（不调用 AI） */
    panel.appendChild(section('历史轮次（点击回放，不重新请求 AI）'));
    var hist = el('div', 'hist');
    panel.appendChild(hist);
    var clearBtn = el('button', 'clear', '清除全部测试历史');
    panel.appendChild(clearBtn);

    var out = el('div', 'out');
    panel.appendChild(out);

    /* 4. 人工重建候选：独立入口，只做证据核验；不调用 AI、不进测试历史、不碰水位 */
    panel.appendChild(section('人工重建候选导入（独立入口 · 不调用 AI）'));
    panel.appendChild(el('div', 'note',
      '仅接受显式标记的人工 JSON：{"origin":"manual-reconstruction","candidates":[...]}。' +
      '每条 evidence 的 messageId 与 quote 都会对真实聊天逐条核验；失败候选不进入审核区。'));
    var manualInput = document.createElement('textarea');
    manualInput.className = 'sn-dry-manual-input';
    manualInput.placeholder = '在此粘贴人工重建候选 JSON（不会保存为 Dry-run 轮次）';
    panel.appendChild(manualInput);
    var manualBtn = el('button', 'go', '校验并导入人工候选');
    panel.appendChild(manualBtn);
    var manualOut = el('div', 'status');
    manualOut.textContent = '人工候选不会自动采纳；刷新后需重新粘贴并核验。';
    manualOut.className = 'sn-dry-status';
    panel.appendChild(manualOut);

    /* 5. 正式采纳审核区：AI dry-run 与人工重建共用卡片，来源清楚区分；刷新即丢 */
    panel.appendChild(section('审核区（AI Dry-run / 人工重建共用；逐条决定，刷新即丢）'));
    var reviewBox = el('div', 'review');
    panel.appendChild(reviewBox);
    var aiFinishBtn = el('button', 'finish', '完成本批审核 · 写入采纳项并推进水位');
    aiFinishBtn.disabled = true;
    panel.appendChild(aiFinishBtn);
    // 人工重建审核使用独立按钮：只写采纳项，绝不创建或推进水位。
    var manualFinishBtn = el('button', 'finish', '完成人工重建审核');
    manualFinishBtn.className += ' sn-dry-finish-manual';
    manualFinishBtn.disabled = true;
    manualFinishBtn.style.display = 'none';
    panel.appendChild(manualFinishBtn);
    var doneNote = el('div', 'done');
    doneNote.style.display = 'none';
    panel.appendChild(doneNote);
    var reviewStatus = el('div', 'status');
    reviewStatus.textContent = '运行一轮 Dry-run 后可在此逐条审核。';
    reviewStatus.className = 'sn-dry-status';
    panel.appendChild(reviewStatus);

    /* 6. S3 增量自动整理：watermark 之后的新消息 → 门槛筛选 → 自动写入正式机自述。
     * 独立按钮显式触发一次，不常驻、不自动重试；失败保持水位，下轮重试。 */
    panel.appendChild(section('增量自动整理（新消息 → 正式机自述）'));
    panel.appendChild(el('div', 'note',
      '从独立水位 selfNarrative.watermark 之后读取新消息，经同一 review 模型整理、严格核验与去重，' +
      '再按保守门槛自动写入正式记录；证据不足 / 推断过强 / 不确定 / 孤立琐事不写入。' +
      '只有整批写入零失败才推进水位。此按钮由你主动触发，不会常驻后台或每轮聊天自动执行。'));
    var autoStatus = el('div', 'status');
    autoStatus.className = 'sn-dry-status';
    autoStatus.textContent = '尚未运行增量整理。';
    panel.appendChild(autoStatus);
    var autoBtn = el('button', 'go', '运行一次增量自动整理');
    panel.appendChild(autoBtn);

    /* 6b. 指定起点整理：与普通 watermark 增量完全独立的入口。
     * 只在用户显式填写 afterId 后才可能执行；预览常驻显示，执行前再次人工确认。 */
    panel.appendChild(section('指定起点整理（从指定消息 ID 之后开始 · 一次性跳转）'));
    panel.appendChild(el('div', 'note',
      '与上面的普通增量不同：这里由你指定 afterId，只读取 id > afterId 的消息；' +
      '不会从水位 80 开始，也不会删除旧消息。每批一次 AI、limit 80、最多自动采纳 3 条，' +
      '证据核验 / 去重 / 失败保护与普通增量完全相同。'));
    panel.appendChild(el('div', 'warnbox',
      '⚠ 重要：指定起点整理会把后续普通增量整理的起点改成这批的末尾。' +
      '更早的消息不会被删除，但以后不会再自动补录。水位只会前进或保持不变，不会倒退。'));
    var fromRow = el('div', 'row');
    var fiAfter = document.createElement('input');
    fiAfter.value = String(FROM_ID_DEFAULT); fiAfter.title = 'afterId（必填，正整数）';
    var fiLimit = document.createElement('input');
    fiLimit.value = '80'; fiLimit.title = 'limit';
    var fiAdopt = document.createElement('input');
    fiAdopt.value = '3'; fiAdopt.title = 'maxAdopt';
    var fiChars = document.createElement('input');
    fiChars.value = '12000'; fiChars.title = 'maxChars';
    fromRow.appendChild(el('label', '', 'afterId')); fromRow.appendChild(fiAfter);
    fromRow.appendChild(el('label', '', 'limit')); fromRow.appendChild(fiLimit);
    fromRow.appendChild(el('label', '', 'maxAdopt')); fromRow.appendChild(fiAdopt);
    fromRow.appendChild(el('label', '', 'maxChars')); fromRow.appendChild(fiChars);
    panel.appendChild(fromRow);
    var fromPreview = el('div', 'warnbox', '正在读取当前水位…');
    panel.appendChild(fromPreview);
    var fromRefreshBtn = el('button', 'skip', '刷新水位与预览');
    panel.appendChild(fromRefreshBtn);
    var fromBtn = el('button', 'go', '执行指定起点整理（需手动确认）');
    fromBtn.disabled = true;
    panel.appendChild(fromBtn);
    var fromOut = el('div', 'result', '尚未执行指定起点整理。');
    panel.appendChild(fromOut);

    /* 7. S3 纠正候选：只生成待确认候选；确认后才调用现有 update/retract/版本修订。 */
    panel.appendChild(section('纠正候选（生成后需逐条确认，绝不自动改记录）'));
    panel.appendChild(el('div', 'note',
      '输入你说的纠正（例如「你记错了，其实……」）。系统只找可能相关的旧认识并生成待确认候选，' +
      '不会修改正式记录，也不调用 AI。只有你明确点「确认」才会调用现有撤回 / 修订机制，且保留历史版本。'));
    var corrInput = document.createElement('textarea');
    corrInput.className = 'sn-dry-manual-input';
    corrInput.placeholder = '在此输入你的纠正，例如：你记错了，其实我不是那样……';
    panel.appendChild(corrInput);
    var corrBtn = el('button', 'go', '生成纠正候选');
    panel.appendChild(corrBtn);
    var corrOut = el('div', 'status');
    corrOut.className = 'sn-dry-status';
    corrOut.textContent = '尚未生成纠正候选。';
    panel.appendChild(corrOut);

    var pageDeps = root.SelfNarrativeDryRunDeps || {};
    var wmKvGet = pageDeps.kvGet || root.kvGet || null;
    var wmKvSet = pageDeps.kvSet || root.kvSet || null;
    // dry-run 脚本先于 app.js 加载：依赖以「用时现取」为准，避免早期缓存到 null。
    function liveKv() {
      var p = root.SelfNarrativeDryRunDeps || {};
      return {
        get: p.kvGet || wmKvGet || root.kvGet || null,
        set: p.kvSet || wmKvSet || root.kvSet || null
      };
    }
    var snApi = root.SelfNarrative || null;
    var reviewApi = root.SelfNarrativeReview || null;
    var currentReview = null;
    var currentResult = null;
    var currentMode = 'ai';   // 'ai' | 'manual'
    var manualDone = false;   // 本次人工审核是否已完成（完成后禁止重复写入）
    var manualBusy = false;   // 防并发重复点击

    function reviewWarn(text) { reviewStatus.textContent = text; reviewStatus.className = 'sn-dry-status sn-dry-warn'; }
    function reviewOk(text) { reviewStatus.textContent = text; reviewStatus.className = 'sn-dry-status'; }
    function clearReview() {
      reviewBox.textContent = '';
      currentReview = null;
      currentResult = null;
      currentMode = 'ai';
      manualDone = false;
      aiFinishBtn.textContent = '完成本批审核 · 写入采纳项并推进水位';
      aiFinishBtn.disabled = true;
      aiFinishBtn.style.display = '';
      manualFinishBtn.textContent = '完成人工重建审核';
      manualFinishBtn.disabled = true;
      manualFinishBtn.style.display = 'none';
      doneNote.style.display = 'none';
      doneNote.textContent = '';
    }

    function renderReview(r, mode) {
      reviewBox.textContent = '';
      currentResult = r;
      currentMode = mode === 'manual' ? 'manual' : 'ai';
      var manual = currentMode === 'manual';
      manualDone = false;
      manualBusy = false;
      aiFinishBtn.style.display = manual ? 'none' : '';
      manualFinishBtn.style.display = manual ? '' : 'none';
      manualFinishBtn.textContent = '完成人工重建审核';
      doneNote.style.display = 'none';
      doneNote.textContent = '';
      currentReview = initReview(r && r.candidates);
      var kv = liveKv();
      var canWrite = !!(kv.set && snApi);
      aiFinishBtn.disabled = !canWrite;
      manualFinishBtn.disabled = !canWrite;
      if (!currentReview.length) {
        reviewBox.appendChild(el('div', 'hmeta', manual
          ? '没有通过证据核验的人工候选，不能采纳。'
          : '本批没有可审核的有效候选。若确认本批已结束，仍可点下方按钮明确完成审核并推进水位（空批次允许）。'));
      }
      currentReview.forEach(function (item0) {
        var c = item0.candidate || {};
        var card = el('div', 'review-item');
        var head = el('div', 'cardhead',
          '#' + (item0.idx + 1) + ' · ' + str(c.kind) + ' · ' + str(c.basis) + ' · ' + str(c.confidence));
        if (manual) head.appendChild(el('span', 'manual-tag', MANUAL_LABEL));
        card.appendChild(head);
        card.appendChild(el('div', 'body', str(c.text)));
        if (c.observed) card.appendChild(line('observed', c.observed));
        if (c.inferred) card.appendChild(line('inferred', c.inferred));
        if (c.question) card.appendChild(line('question', c.question));
        var evParts = (Array.isArray(c.evidence) ? c.evidence : []).map(function (e) {
          return 'msg ' + e.messageId + '「' + str(e.quote).slice(0, 30) + '」';
        });
        card.appendChild(el('div', 'hmeta', '证据：' + (evParts.length ? evParts.join('；') : '无')));
        if (manual) {
          var checks = (c.evidenceVerification && c.evidenceVerification.checks) || [];
          card.appendChild(el('div', 'verify',
            '证据核验：通过 ' + checks.length + ' 条（messageId 存在，quote 与真实原文逐字核对）' +
            ' · ' + MANUAL_LABEL));
        }

        var ctl = el('div', 'review-ctl');
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.title = '勾选表示采纳为正式机自述';
        var cbLabel = el('label', '', '');
        cbLabel.appendChild(cb);
        cbLabel.appendChild(document.createTextNode(' 采纳'));
        var skip = el('button', 'skip', '明确跳过');
        var stateLbl = el('span', 'hmeta', '待审核');
        ctl.appendChild(cbLabel);
        ctl.appendChild(skip);
        ctl.appendChild(stateLbl);
        card.appendChild(ctl);
        var item = item0;
        function paint() {
          stateLbl.textContent = item.status === 'adopt' ? '已采纳' : (item.status === 'skip' ? '已跳过' : '待审核');
          cb.checked = item.status === 'adopt';
          skip.disabled = item.status === 'skip';
        }
        cb.addEventListener('change', function () {
          currentReview = setReviewDecision(currentReview, item.key, cb.checked ? 'adopt' : 'pending');
          item = currentReview.filter(function (x) { return x.key === item0.key; })[0] || item;
          paint();
        });
        skip.addEventListener('click', function () {
          currentReview = setReviewDecision(currentReview, item.key, 'skip');
          item = currentReview.filter(function (x) { return x.key === item0.key; })[0] || item;
          paint();
        });
        paint();
        reviewBox.appendChild(card);
      });
      if (!kv.set) reviewWarn('未检测到 kvSet（正式数据层写入依赖）：无法采纳入库。请确认页面由 app.js 正常加载。');
      else if (!snApi) reviewWarn('未检测到 SelfNarrative 数据层：无法采纳入库。');
      else reviewOk(manual
        ? '人工重建候选：逐条勾选「采纳」或点「明确跳过」。采纳会写正式机自述，但绝不创建或推进水位。'
        : '逐条勾选「采纳」或点「明确跳过」。全部决定后再点下方按钮；仍有未审核候选时水位不会推进。');
    }

    // 完成后锁定卡片控件，避免在已完成状态下继续改动审核选择。
    function lockReviewControls() {
      var nodes = reviewBox.querySelectorAll ? reviewBox.querySelectorAll('input,button') : [];
      for (var i = 0; i < nodes.length; i++) nodes[i].disabled = true;
    }

    /* AI Dry-run 完成本批审核：行为保持不变（含水位推进）。 */
    aiFinishBtn.addEventListener('click', async function () {
      if (currentMode !== 'ai' || !currentResult) { reviewWarn('没有当前批次的审核结果，不能推进水位。'); return; }
      var kv = liveKv();
      if (!kv.set || !snApi || !kv.get) { reviewWarn('写入依赖不可用，不能采纳或推进水位。'); return; }
      var pending = reviewPending(currentReview);
      var adoptCount = currentReview.filter(function (x) { return x.status === 'adopt'; }).length;
      var skipCount = currentReview.filter(function (x) { return x.status === 'skip'; }).length;
      var msg = '确认完成本批审核？\n采纳 ' + adoptCount + ' 条，明确跳过 ' + skipCount + ' 条' +
        (pending.length ? ('，还有 ' + pending.length + ' 条未审核（将阻止水位推进）') : '') + '。\n' +
        '采纳会调用 SelfNarrative.create 写入正式机自述；只有整批审核完成且全部采纳成功后，才会推进独立水位键 ' + WATERMARK_KEY + '。';
      var ok = (typeof window !== 'undefined' && typeof window.confirm === 'function') ? window.confirm(msg) : true;
      if (!ok) return;
      aiFinishBtn.disabled = true;
      reviewOk('正在逐条写入采纳记录…');
      try {
        var writeStore = {
          get: function (k) { return kv.get(k); },
          set: function (k, v) { return kv.set(k, v); }
        };
        var results = await adoptReviewed(writeStore, currentReview, { selfNarrative: snApi, now: Date.now() });
        var gate = canAdvanceReview(currentReview, results);
        var failCount = results.filter(function (r) { return !r.ok; }).length;
        var summary = '采纳结果：成功 ' + (results.length - failCount) + ' / 失败 ' + failCount + '；明确跳过 ' + skipCount + '。';
        if (!gate.ok) {
          reviewWarn(summary + (gate.reason === 'pending'
            ? ('还有 ' + gate.pending + ' 条未审核，水位保持原值，未推进。')
            : ('有采纳写入失败，水位保持原值，未推进。')));
        } else {
          var read = currentResult.read || {};
          var ids = Array.isArray(read.ids) ? read.ids : [];
          var saved = await saveWatermark(kv.set, {
            nextAfterId: read.nextAfterId,
            savedAt: Date.now(),
            afterId: read.afterId,
            firstId: ids.length ? ids[0] : null,
            lastId: ids.length ? ids[ids.length - 1] : null,
            adopted: results.length - failCount,
            skipped: skipCount
          });
          if (!saved.ok) {
            reviewWarn(summary + '水位写入失败（' + str(saved.reason) + '）：本批不能标记为已完成，下次仍从原水位读取。');
          } else {
            reviewOk(summary + '已推进水位到 nextAfterId=' + saved.value.lastAfterId + '。');
          }
        }
        // 写入后刷新去重对照：重新读正式记录（只读），不改当前结果正文。
        try {
          if (reviewApi && typeof reviewApi.buildDedupeIndex === 'function') {
            var guard = {
              get: function (k) { return kv.get(k); },
              set: function () { throw new Error('审核刷新为只读操作'); }
            };
            var existing = await snApi.list(guard, { status: 'all' });
            if (existing.ok) {
              var idx = reviewApi.buildDedupeIndex(existing.records || []);
              var flt = reviewApi.applyDedupe(currentResult.candidates || [], idx);
              var dup = flt.skipped.filter(function (s) { return s.reason === 'duplicate'; }).length;
              reviewStatus.textContent += ' 刷新后正式记录 ' + existing.total + ' 条，本批对照重复 ' + dup + ' 条。';
            }
          }
        } catch (e) {}
      } catch (e) {
        reviewWarn('审核执行异常：' + errText(e));
      } finally {
        aiFinishBtn.disabled = false;
      }
    });

    /* 人工重建审核独立完成：只写采纳项，绝不读写水位；完成后禁止重复写入。 */
    manualFinishBtn.addEventListener('click', async function () {
      if (currentMode !== 'manual' || !currentReview) { reviewWarn('没有可完成的人工重建审核结果。'); return; }
      if (manualDone) { reviewWarn('本次人工重建审核已完成，不会重复写入。'); return; }
      if (manualBusy) return;
      var kv = liveKv();
      if (!kv.set || !snApi) { reviewWarn('写入依赖不可用，不能采纳入库。'); return; }
      var pending = reviewPending(currentReview);
      var adoptCount = currentReview.filter(function (x) { return x.status === 'adopt'; }).length;
      var skipCount = currentReview.filter(function (x) { return x.status === 'skip'; }).length;
      if (pending.length) {
        reviewWarn('还有 ' + pending.length + ' 条未审核：请逐条勾选「采纳」或点「明确跳过」后再完成。本次未写入任何记录，水位未变动。');
        return;
      }
      var msg = '确认完成人工重建审核？\n采纳 ' + adoptCount + ' 条，明确跳过 ' + skipCount + ' 条。\n' +
        '采纳会调用 SelfNarrative.create 写入正式机自述；人工补录不会创建或推进水位键 ' + WATERMARK_KEY + '。';
      var ok = (typeof window !== 'undefined' && typeof window.confirm === 'function') ? window.confirm(msg) : true;
      if (!ok) return;
      manualBusy = true;
      manualFinishBtn.disabled = true;
      reviewOk('正在逐条写入采纳记录…');
      try {
        var writeStore = {
          get: function (k) { return kv.get(k); },
          set: function (k, v) { return kv.set(k, v); }
        };
        var res = await completeManualReview(writeStore, currentReview, { selfNarrative: snApi, now: Date.now() });
        if (!res.done) {
          var detail = (res.failed || []).map(function (f) {
            return '#' + (num(f.idx, 0, 0, 0) + 1) + ' ' + str(f.reason);
          }).join('；');
          reviewWarn('采纳结果：成功 ' + res.adoptedOk + ' / 失败 ' + res.failed.length +
            '；明确跳过 ' + res.skipped + '。' +
            (detail ? (' 失败项：' + detail + '。') : '') +
            ' 本次未标记完成；已写入的记录保留，可重试（同一候选不会重复写入）。水位未变动。');
          return;
        }
        manualDone = true;
        manualFinishBtn.textContent = '人工重建审核已完成';
        lockReviewControls();
        doneNote.textContent = '本次人工重建审核已完成：采纳 ' + res.adoptedOk + ' 条，明确跳过 ' + res.skipped +
          ' 条。未创建或推进 ' + WATERMARK_KEY + '，历史消息处理进度保持不变。';
        doneNote.style.display = '';
        reviewOk('人工重建审核已完成：采纳 ' + res.adoptedOk + ' 条，明确跳过 ' + res.skipped +
          ' 条；未创建或推进水位。');
      } catch (e) {
        reviewWarn('人工审核执行异常：' + errText(e));
      } finally {
        manualBusy = false;
        if (!manualDone) manualFinishBtn.disabled = false;
      }
    });

    // 页面里 from 水位恢复 afterId：db 可能还没就绪，故在每次展开面板时再读一次；
    // 用户一旦手动改过 afterId 就不再覆盖。
    var afterTouched = false;
    inAfter.addEventListener('input', function () { afterTouched = true; });
    async function refreshAfterFromWatermark() {
      if (afterTouched) return;
      try {
        var wm = await loadWatermark(liveKv().get);
        if (wm.ok && !wm.empty && wm.value > 0) inAfter.value = String(wm.value);
      } catch (e) {}
    }
    refreshAfterFromWatermark();

    var activeRound = null;
    function renderHistory() {
      hist.textContent = '';
      var loaded = store.load();
      if (!loaded.ok) {
        hist.appendChild(el('div', 'bad', '历史读取失败（' + str(loaded.reason) + '），本轮结果不受影响。'));
        return;
      }
      if (!loaded.rounds.length) {
        hist.appendChild(el('div', 'hmeta', '暂无历史轮次。'));
        return;
      }
      loaded.rounds.slice().reverse().forEach(function (r) {
        var rg = isObj(r.range) ? r.range : {};
        var smy = isObj(r.result) && isObj(r.result.summary) ? r.result.summary : {};
        var btn = el('button', 'hitem' + (activeRound === r.roundNo ? ' active' : ''),
          '第 ' + r.roundNo + ' 轮 · msg ' + rg.firstId + '–' + rg.lastId + ' · 参考' + (r.priorSourceRound ? '第' + r.priorSourceRound + '轮' : '无') + ' · 有效' + (smy.valid == null ? '?' : smy.valid) + ' / 拒绝' + (smy.rejected == null ? '?' : smy.rejected));
        btn.addEventListener('click', function () {
          var rep = replayRound(store, r.roundNo);
          if (!rep.ok) { setStatus('回放失败（' + str(rep.reason) + '）。', true); return; }
          activeRound = rep.roundNo;
          renderResult(out, rep.result, { roundNo: rep.roundNo, priorSourceRound: r.priorSourceRound, replay: true });
          clearReview();   // 历史回放不提供采纳操作，避免对旧结果误触发写入
          renderHistory();
          // 回放不修改任何执行参数输入框
        });
        hist.appendChild(btn);
      });
    }
    fillRefSelect();
    renderHistory();

    fab.addEventListener('click', function () {
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
      if (panel.style.display === 'block') refreshAfterFromWatermark();
    });

    go.addEventListener('click', async function () {
      var params = {
        afterId: inAfter.value,
        limit: inLimit.value,
        maxChars: inChars.value
      };
      var sourceRound = str(refSel.value) === '' ? null : refSel.value;
      var resolved = resolvePriorCandidates(store, sourceRound);
      if (!resolved.ok) {
        setStatus('读取参考来源失败（' + str(resolved.reason) + '），请先选择其它轮次。', true);
        return;
      }
      go.disabled = true;
      go.textContent = '运行中…';
      out.textContent = '正在读取并请求 AI…';
      activeRound = null;
      try {
        var r = await run({
          afterId: params.afterId,
          limit: params.limit,
          maxChars: params.maxChars,
          priorCandidates: resolved.candidates
        });
        // 先展示本轮结果：保存失败也不能影响展示。
        renderResult(out, r, { priorSourceRound: resolved.sourceRound });
        if (r.ok) renderReview(r);   // 只有成功产出候选的批次才进入正式采纳审核
        else clearReview();
        console.log('[SelfNarrativeDryRun]', r);

        // 再保存测试历史（失败只提示，不吞掉本轮结果）。
        var loaded = store.load();
        var roundNo = nextRoundNo(loaded.ok ? loaded.rounds : []);
        var entry = buildRound({
          roundNo: roundNo,
          savedAt: Date.now(),
          afterId: params.afterId,
          limit: params.limit,
          maxChars: params.maxChars
        }, r, resolved.sourceRound);
        var saved = store.saveRound(entry);
        if (saved.ok) {
          activeRound = roundNo;
          setStatus('本轮已保存为第 ' + roundNo + ' 轮（测试历史）。');
          fillRefSelect(str(refSel.value));
          renderHistory();
        } else if (saved.reason === 'limit-reached') {
          setStatus('测试历史已达 ' + MAX_ROUNDS + ' 轮上限：本轮结果已显示，但旧的 ' + saved.kept + ' 轮全部保留，未删除任何一轮。请手动清除后再保存。', true);
        } else {
          setStatus('测试历史保存失败（' + str(saved.reason) + '）：本轮结果已正常显示，不影响查看。', true);
        }
      } catch (e) {
        out.textContent = '';
        out.appendChild(el('div', 'bad', 'dry-run 自身异常：' + errText(e)));
        setStatus('本轮执行异常：' + errText(e), true);
      } finally {
        go.disabled = false;
        go.textContent = '开始 Dry-run';
      }
    });

    function renderManualReport(host, res) {
      host.textContent = '';
      var r = isObj(res) ? res : {};
      host.appendChild(el('div', r.ok ? 'status' : 'bad',
        r.ok
          ? '人工候选核验通过 ' + r.stats.accepted + ' 条；已放入下方审核区，等待逐条采纳或跳过。'
          : '没有候选通过核验（' + str(r.reason || 'see-details') + '）；审核区未载入人工候选。'));
      if (r.accepted && r.accepted.length) {
        host.appendChild(el('div', 'verify',
          MANUAL_LABEL + ' · 未调用 AI · 未生成 prompt / 耗时 / 费用 · 不保存为 Dry-run 轮次。'));
      }
      (r.rejected || []).forEach(function (x) {
        host.appendChild(el('div', 'bad',
          '候选 #' + (num(x.index, 0, 0, null) + 1) + ' 拒绝：' + str(x.reason) +
          (x.detail != null ? '（' + str(x.detail) + '）' : '')));
      });
      (r.warnings || []).forEach(function (w) { host.appendChild(el('div', 'bad', '提示：' + w)); });
    }

    manualBtn.addEventListener('click', async function () {
      manualBtn.disabled = true;
      manualOut.textContent = '正在对真实聊天记录核验 messageId 与 quote…';
      manualOut.className = 'sn-dry-status';
      try {
        var res = await verifyManualCandidates(manualInput.value, {
          reader: root.RoomChatReader,
          review: reviewApi,
          selfNarrative: snApi,
          kvGet: liveKv().get,
          location: root.location || null
        });
        renderManualReport(manualOut, res);
        if (res.ok && res.accepted.length) {
          renderReview({ candidates: res.accepted }, 'manual');
          reviewOk('人工候选已载入：逐条采纳或跳过；完成后不会推进水位。');
        } else {
          clearReview();
        }
      } catch (e) {
        manualOut.textContent = '人工核验异常：' + errText(e);
        manualOut.className = 'sn-dry-status sn-dry-warn';
        clearReview();
      } finally {
        manualBtn.disabled = false;
      }
    });

    clearBtn.addEventListener('click', function () {
      var ok = (typeof window !== 'undefined' && typeof window.confirm === 'function')
        ? window.confirm('确定清除全部 Dry-run 测试历史？\n只删除 localStorage 键 ' + STORAGE_KEY + '，不影响正式机自述、聊天记录、用量统计或其它任何数据。')
        : true;
      if (!ok) return;
      var res = store.clear();
      if (res.ok) {
        activeRound = null;
        clearReview();
        fillRefSelect('');
        renderHistory();
        setStatus('已清除全部 Dry-run 测试历史（仅 ' + STORAGE_KEY + '）。');
      } else {
        setStatus('清除失败（' + str(res.reason) + '）。', true);
      }
    });

    /* 6. 增量自动整理事件：显式触发一次，带防重复点击；失败保持水位。 */
    var autoBusy = false;
    autoBtn.addEventListener('click', async function () {
      if (autoBusy) { autoStatus.textContent = '正在整理中，请稍候（不会重复触发）。'; return; }
      var AUTO = root.SelfNarrativeAuto;
      if (!AUTO || typeof AUTO.runAutoBatch !== 'function') {
        autoStatus.textContent = '增量整理模块未加载，请刷新页面。'; return;
      }
      autoBusy = true;
      autoBtn.disabled = true;
      autoStatus.textContent = '正在读取新消息并整理（一次 AI 请求）…';
      try {
        var kv = liveKv();
        var p = root.SelfNarrativeDryRunDeps || {};
        var res = await AUTO.runAutoBatch({ limit: 80 }, {
          callAI: p.callAI || root.callAI || null,
          kvGet: kv.get, kvSet: kv.set
        });
        if (res.ok && res.reason === 'done') {
          autoStatus.textContent = '增量整理完成：采纳 ' + res.adopt.succeeded +
            ' 条（幂等 ' + res.adopt.idempotent + ' 条），拒绝 ' + res.auto.rejected.length +
            ' 条；水位推进到 ' + res.watermark.after + '。';
        } else {
          autoStatus.textContent = '增量整理未写入（' + str(res.reason) + '）：写入 ' +
            res.adopt.succeeded + ' 条，失败 ' + res.adopt.failed.length + ' 条；水位保持' +
            (res.watermark.touched ? '' : '（未推进）') + '。';
        }
      } catch (e) {
        autoStatus.textContent = '增量整理异常：' + errText(e);
      } finally {
        autoBusy = false;
        autoBtn.disabled = false;
      }
    });

    /* 6b. 指定起点整理事件：预览常驻；执行前再次人工确认；完成后显示完整结果。 */
    var fromBusy = false;
    var fromWmSnapshot = null;
    function parseFromAfter(v) {
      var A = root.SelfNarrativeAuto;
      if (A && typeof A.parseExplicitAfterId === 'function') return A.parseExplicitAfterId(v);
      var s = str(v).trim();
      if (!/^\d+$/.test(s)) return null;
      var n = Number(s);
      return (isFinite(n) && n >= 1 && Math.floor(n) === n) ? n : null;
    }
    function renderFromPreview() {
      var after = parseFromAfter(fiAfter.value);
      var lim = num(fiLimit.value, 80, 1, 500);
      var ad = num(fiAdopt.value, 3, 1, 20);
      var mc = num(fiChars.value, 12000, 1, 200000);
      var wmText = fromWmSnapshot && fromWmSnapshot.ok
        ? String(fromWmSnapshot.value)
        : (fromWmSnapshot ? '读取失败（' + str(fromWmSnapshot.reason) + '）' : '未读取');
      if (after == null) {
        fromPreview.className = 'sn-dry-status sn-dry-warn';
        fromPreview.textContent = '⚠ 起点无效：afterId 必须是正整数（例如 2428）。当前水位：' + wmText +
          '。未填写时不会执行，也绝不会回退到 watermark。';
        fromBtn.disabled = true;
        return;
      }
      fromPreview.className = 'sn-dry-warnbox';
      fromPreview.textContent = '本次读取起点：id > ' + after +
        ' · limit=' + lim + ' · maxAdopt=' + ad + ' · maxChars=' + mc +
        ' · 当前水位=' + wmText + '\n' +
        '⚠ 执行后普通增量按钮会从本批末尾继续；旧消息不会被删除，但以后不再自动补录。' +
        '水位只会前进或保持不变，不会倒退。';
      fromBtn.disabled = false;
    }
    async function refreshFromPreview() {
      var kv = liveKv();
      var DR = root.SelfNarrativeDryRun;
      if (!kv.get || !DR || typeof DR.loadWatermark !== 'function') {
        fromWmSnapshot = { ok: false, reason: 'kv-unavailable' };
      } else {
        try { fromWmSnapshot = await DR.loadWatermark(kv.get); }
        catch (e) { fromWmSnapshot = { ok: false, reason: errText(e) }; }
      }
      renderFromPreview();
    }
    [fiAfter, fiLimit, fiAdopt, fiChars].forEach(function (input) {
      input.addEventListener('input', renderFromPreview);
    });
    fromRefreshBtn.addEventListener('click', function () { refreshFromPreview(); });
    fromBtn.addEventListener('click', async function () {
      if (fromBusy) { fromOut.textContent = '正在执行中，不会重复触发。'; return; }
      var A = root.SelfNarrativeAuto;
      if (!A || typeof A.runAutoBatch !== 'function') {
        fromOut.textContent = '指定起点整理模块未加载，请刷新页面。'; return;
      }
      var after = parseFromAfter(fiAfter.value);
      if (after == null) { renderFromPreview(); fromOut.textContent = '起点无效，未执行。'; return; }
      var lim = num(fiLimit.value, 80, 1, 500);
      var ad = num(fiAdopt.value, 3, 1, 20);
      var mc = num(fiChars.value, 12000, 1, 200000);
      var wmText = fromWmSnapshot && fromWmSnapshot.ok ? String(fromWmSnapshot.value) : '未知';
      var yes = (typeof window !== 'undefined' && typeof window.confirm === 'function')
        ? window.confirm('确认执行指定起点整理？\n读取 id > ' + after + ' · limit=' + lim + ' · maxAdopt=' + ad +
            ' · maxChars=' + mc + '\n当前水位=' + wmText +
            '；执行后普通增量将从本批末尾继续，旧消息以后不再自动补录（不会删除）。\n水位只前进不回退。')
        : true;
      if (!yes) { fromOut.textContent = '已取消，未执行任何整理。'; return; }
      fromBusy = true;
      fromBtn.disabled = true;
      fromOut.textContent = '正在执行指定起点整理（一次 AI 请求）…';
      try {
        var kv = liveKv();
        var p = root.SelfNarrativeDryRunDeps || {};
        var res = await A.runAutoBatch({
          mode: A.MODE_FROM_ID || 'from-id',
          afterId: after, limit: lim, maxAdopt: ad, maxChars: mc
        }, {
          callAI: p.callAI || root.callAI || null,
          kvGet: kv.get, kvSet: kv.set
        });
        var wmChange = String(res.watermark.before == null ? '未知' : res.watermark.before) +
          ' → ' + String(res.watermark.after == null ? '未变' : res.watermark.after) +
          (res.watermark.touched ? '（已推进）' : '（未推进）');
        var range = (res.batch && res.batch.firstId != null)
          ? ('读取 msg ' + res.batch.firstId + '–' + res.batch.lastId + '（' + res.batch.count + ' 条，起点 id > ' + res.batch.afterId + '）')
          : ('未读取任何消息（起点 id > ' + after + '）');
        fromOut.textContent = '指定起点整理' + (res.ok ? '完成' : '未写入') + '（' + str(res.reason) + '）：\n' +
          range + '\n' +
          '采纳 ' + res.adopt.succeeded + ' 条；幂等 ' + res.adopt.idempotent + ' 条；' +
          '拒绝 ' + res.auto.rejected.length + ' 条（门槛截断 ' + res.auto.capped + ' 条）；' +
          '写入失败 ' + res.adopt.failed.length + ' 条。\n' +
          '水位 ' + wmChange + '。' +
          (res.warnings && res.warnings.length ? '\n提示：' + res.warnings.join(' / ') : '');
        if (res.watermark.touched || res.watermark.after != null) refreshFromPreview();
      } catch (e) {
        fromOut.textContent = '指定起点整理异常：' + errText(e) + '（水位不会因此推进）';
      } finally {
        fromBusy = false;
        fromBtn.disabled = false;
      }
    });
    refreshFromPreview();

    /* 7. 纠正候选事件：生成只读候选，逐条确认后才走正式数据层。 */
    var corrState = null;
    corrBtn.addEventListener('click', async function () {
      var AUTO = root.SelfNarrativeAuto;
      if (!AUTO || typeof AUTO.prepareCorrection !== 'function') {
        corrOut.textContent = '纠正模块未加载，请刷新页面。'; return;
      }
      var text = corrInput.value.trim();
      if (!text) { corrOut.textContent = '请先输入你的纠正内容。'; return; }
      var kv = liveKv();
      var SNsnap;
      try {
        SNsnap = await (root.SelfNarrative && root.SelfNarrative.list
          ? root.SelfNarrative.list({ get: kv.get, set: function () { throw new Error('只读'); } }, { status: 'active' })
          : { ok: false });
      } catch (e) { SNsnap = { ok: false }; }
      if (!SNsnap.ok) { corrOut.textContent = '读取正式记录失败，无法生成纠正候选。'; return; }
      corrState = AUTO.prepareCorrection(text, SNsnap.records || {}, {});
      corrOut.textContent = '';
      corrOut.appendChild(el('div', '', corrState.isCorrection
        ? '检测到纠正语境，已找到 ' + corrState.candidates.length + ' 条可能相关的旧认识（以下均为待确认候选，尚未修改任何记录）。'
        : '未检测到明确纠正语境；仅列出话题相关的旧认识供参考，不建议据此修改。'));
      corrState.candidates.forEach(function (cand, ci) {
        var box = el('div', 'review-item');
        box.appendChild(el('div', 'cardhead', '#' + (ci + 1) + ' · ' + str(cand.topic) + ' · ' + str(cand.targetId)));
        box.appendChild(el('div', 'body', '旧内容：' + cand.oldText));
        box.appendChild(el('div', 'hmeta', '原始证据：' + (cand.oldEvidence.length
          ? cand.oldEvidence.map(function (e) { return 'msg ' + e.messageId + '「' + str(e.quote).slice(0, 24) + '」'; }).join('；')
          : '无')));
        var ctl = el('div', 'review-ctl');
        var drop = el('button', 'skip', '放弃');
        var retract = el('button', 'skip', '撤回这条');
        var revise = el('button', 'skip', '确认修订（需再确认）');
        var statusEl = el('span', 'hmeta', '');
        function act(action) {
          return async function () {
            var yes = (typeof window !== 'undefined' && typeof window.confirm === 'function')
              ? window.confirm('确认对 ' + cand.targetId + ' 执行「' + action + '」？\n这会修改正式机自述并保留历史版本，不可直接撤销。')
              : true;
            if (!yes) return;
            drop.disabled = retract.disabled = revise.disabled = true;
            statusEl.textContent = '正在执行…';
            try {
              var r = await AUTO.confirmCorrection({
                targetId: cand.targetId, action: action, patch: {},
                patchText: cand.oldText, confirmed: true
              }, { kvGet: kv.get, kvSet: kv.set });
              statusEl.textContent = r.ok ? ('已完成：' + r.reason) : ('未执行：' + str(r.reason));
            } catch (e) { statusEl.textContent = '异常：' + errText(e); }
          };
        }
        drop.addEventListener('click', function () { statusEl.textContent = '已放弃该候选。'; });
        retract.addEventListener('click', act('retract'));
        revise.addEventListener('click', act('revise'));
        ctl.appendChild(drop); ctl.appendChild(retract); ctl.appendChild(revise); ctl.appendChild(statusEl);
        box.appendChild(ctl);
        corrOut.appendChild(box);
      });
      if (!corrState.candidates.length) {
        corrOut.appendChild(el('div', 'hmeta', '没有找到相关旧认识，未生成任何候选。'));
      }
    });
  }

  root.SelfNarrativeDryRun = {
    REQUEST_TYPE: REQUEST_TYPE,
    STORAGE_KEY: STORAGE_KEY,
    MAX_ROUNDS: MAX_ROUNDS,
    FROM_ID_DEFAULT: FROM_ID_DEFAULT,
    run: run,
    mount: mount,
    renderResult: renderResult,
    createStore: createStore,
    buildRound: buildRound,
    resolvePriorCandidates: resolvePriorCandidates,
    replayRound: replayRound,
    candidatesFromRound: candidatesFromRound,
    nextRoundNo: nextRoundNo,
    WATERMARK_KEY: WATERMARK_KEY,
    candidateToCreateSpec: candidateToCreateSpec,
    initReview: initReview,
    setReviewDecision: setReviewDecision,
    reviewPending: reviewPending,
    adoptReviewed: adoptReviewed,
    completeManualReview: completeManualReview,
    canAdvanceReview: canAdvanceReview,
    normalizeWatermark: normalizeWatermark,
    loadWatermark: loadWatermark,
    saveWatermark: saveWatermark,
    MANUAL_ORIGIN: MANUAL_ORIGIN,
    MANUAL_LABEL: MANUAL_LABEL,
    parseManualPayload: parseManualPayload,
    verifyManualCandidates: verifyManualCandidates
  };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
