/* tests/shared/self-narrative-dryrun.test.mjs — S2a 单批 dry-run 编排
 * 纯 Node：假 reader / 假 AI / 假用量；不碰真实 IndexedDB、不发网络请求、不写机自述。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import '../../public/shared/self-narrative.js';
import '../../public/shared/self-narrative-review.js';
import '../../public/shared/self-narrative-dryrun.js';

const SN = globalThis.SelfNarrative;
const R = globalThis.SelfNarrativeReview;
const DR = globalThis.SelfNarrativeDryRun;
const T = 1795000000000;

const msgs = () => [
  { id: 11, role: 'user', content: '她不喜欢别人替她做决定', time: T, source: null, sourceId: null, silent: false, type: null },
  { id: 12, role: 'assistant', content: '那我下次先问你', time: T + 1000, source: null, sourceId: null, silent: false, type: null },
];

// 模拟「第二批」的真实消息，以及第一批留下的未入库候选。
const secondMsgs = () => [
  { id: 21, role: 'user', content: '这次她自己选了', time: T + 2000, source: null, sourceId: null, silent: false, type: null },
  { id: 22, role: 'assistant', content: '那你选得很好', time: T + 3000, source: null, sourceId: null, silent: false, type: null },
];

const priorCandidates = () => [{
  id: 'sn-old', primaryMessageId: 11, status: 'new', of: null,
  kind: 'inference', basis: 'inferred', confidence: 'low',
  text: '她好像不喜欢被安排（证据 [msg 11]）',
  observed: '她说过那句话', inferred: '被安排会不自在', question: '',
  topic: '边界',
  evidence: [{ messageId: 11, quote: '旧原文' }],
}];

function reader(fakeMsgs, over = {}) {
  const calls = [];
  return {
    calls,
    async readBatch(o) {
      calls.push(o);
      if (over.fail) return { ok: false, reason: 'cursor-failed', error: '游标读取失败', messages: null, done: false };
      if (over.throw) throw new Error('读取抛错');
      return {
        ok: true, reason: 'ok', messages: fakeMsgs, nextAfterId: 12, done: true,
        count: fakeMsgs.length, chars: fakeMsgs.reduce((a, m) => a + String(m.content || '').length, 0)
      };
    },
    async getById() { return { ok: true, exists: false, message: null }; },
    async hasMessage() { return { ok: true, exists: false }; }
  };
}

function usageMod() {
  const rows = [];
  return {
    rows,
    push(entry) { rows.push(Object.assign({ ts: T, date: '2026-11-23', model: 'deepseek-flash', requestType: 'self-narrative-review', ok: true, errorCode: null, cost: { usd: 0.001, cny: 0.0071 }, usage: { prompt: 100, completion: 20, total: 120, hit: 8, available: true } }, entry)); },
    query(o) { return rows.filter((r) => !o || !o.requestType || r.requestType === o.requestType); },
    summarize(list) { return { count: list.length, prompt: list.reduce((a, r) => a + (r.usage.prompt || 0), 0), completion: 20, total: 120, hit: 8, usd: 0.001, cny: 0.0071 }; }
  };
}

async function depsWith(over = {}) {
  const map = new Map();
  if (over.seed) map.set(SN.KEY, over.seed);
  const usage = over.usage || usageMod();
  const aiCalls = [];
  const callAI = over.callAI
    ? async (messages, opts) => { aiCalls.push({ messages, opts }); return over.callAI(messages, opts); }
    : async (messages, opts) => {
      aiCalls.push({ messages, opts });
      usage.push({});
      return over.aiText != null ? over.aiText : JSON.stringify({ records: [{
        kind: 'inference', text: '她好像不太喜欢被安排', inferred: '被替她决定会让她不自在',
        confidence: 'low', basis: 'inferred', topic: '',
        evidence: [{ messageId: 11, quote: '她不喜欢别人替她做决定' }]
      }] });
    };
  return {
    aiCalls, usage, map,
    deps: {
      reader: over.reader || reader(over.messages == null ? msgs() : over.messages, over),
      review: R,
      selfNarrative: SN,
      callAI,
      kvGet: async (k) => map.get(k),
      usage,
      location: over.location || { hostname: '127.0.0.1', port: '8787', href: 'http://127.0.0.1:8787/' },
      now: () => T
    }
  };
}

/* ---------- 成功路径 ---------- */
test('Y01 单批 dry-run：真实读取 → 校验 → 新认识，保留原始 messageId / quote / 原文', async () => {
  const d = await depsWith();
  const r = await DR.run({ afterId: 3, limit: 80, maxChars: 12000 }, d.deps);

  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.deepEqual(r.read.ids, [11, 12]);
  assert.equal(d.aiCalls.length, 1, '只请求一次');
  assert.equal(d.deps.reader.calls.length, 1, '只读一批，不自动扫描下一批');
  assert.equal(d.aiCalls[0].opts.requestType, 'self-narrative-review');
  assert.equal(r.summary.valid, 1);
  assert.equal(r.summary.duplicates, 0);
  assert.equal(r.candidates.length, 1);

  const c = r.candidates[0];
  assert.equal(c.kind, 'inference');
  assert.equal(c.confirmed, '', '不能把用户自述自动标成 confirmed');
  assert.equal(c.primaryMessageId, 11);
  assert.deepEqual(c.evidence[0], {
    messageId: 11,
    quote: '她不喜欢别人替她做决定',
    original: { id: 11, role: 'user', content: '她不喜欢别人替她做决定', time: T, source: null }
  });
  assert.equal(r.ai.usage.promptTokens, 100);
  assert.equal(r.ai.usage.cacheHitTokens, 8);
  assert.equal(r.ai.usage.totalTokens, 120);
  assert.equal(r.ai.usage.costCny, 0.0071);
  assert.equal(d.map.size, 0, '不能写入机自述库');
});

test('Y02 提示词来自 S1b，含 messageId 与原文，不含下一批', async () => {
  const d = await depsWith();
  await DR.run({}, d.deps);
  const user = d.aiCalls[0].messages[1].content;
  assert.match(user, /\[11\] user：她不喜欢别人替她做决定/);
  assert.match(user, /\[12\] assistant：那我下次先问你/);
  assert.match(d.aiCalls[0].messages[0].content, /basis=stated 只说明/);
  assert.equal(d.aiCalls[0].messages[1].content.includes('[13]'), false);
});

/* ---------- 去重 ---------- */
test('Y03 既有同认识被识别为重复，仍展示证据与来源', async () => {
  const seedMap = new Map();
  const seedStore = { async get(k) { return seedMap.get(k); }, async set(k, v) { seedMap.set(k, v); } };
  const made = await SN.create(seedStore, {
    text: '她好像不太喜欢被安排', kind: 'inference', inferred: '被替她决定会让她不自在',
    confidence: 'low', basis: 'inferred',
    evidence: [{ messageId: 11, quote: '她不喜欢别人替她做决定' }],
    source: { kind: 'chat', messageId: 11, at: T }
  }, { now: T });

  const d = await depsWith({ seed: seedMap.get(SN.KEY) });
  const r = await DR.run({}, d.deps);
  assert.equal(r.ok, true);
  assert.equal(r.summary.duplicates, 1);
  assert.equal(r.candidates.length, 0);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].reason, 'duplicate');
  assert.deepEqual(r.skipped[0].of, [made.id]);
  assert.equal(r.skipped[0].record.evidence[0].messageId, 11, '重复项仍保留证据');
});

/* ---------- 校验拒绝 ---------- */
test('Y04 编造来源 ID 被 S1b 拒绝，不当作有效候选', async () => {
  const aiText = JSON.stringify({ records: [{
    kind: 'observation', text: '她今天穿了红衣服', basis: 'observed', confidence: 'medium',
    evidence: [{ messageId: 999, quote: '她不喜欢别人替她做决定' }]
  }] });
  const d = await depsWith({ aiText });
  const r = await DR.run({}, d.deps);
  assert.equal(r.validation.ok, true, '结构合法');
  assert.equal(r.summary.valid, 0);
  assert.equal(r.summary.rejected, 1);
  assert.equal(r.validation.rejected[0].reason, 'unknown-source');
  assert.equal(r.candidates.length, 0);
});

test('Y05 quote 与原文不符被拒绝', async () => {
  const aiText = JSON.stringify({ records: [{
    kind: 'observation', text: '她很果断', basis: 'observed', confidence: 'medium',
    evidence: [{ messageId: 11, quote: '她其实很犹豫' }]
  }] });
  const d = await depsWith({ aiText });
  const r = await DR.run({}, d.deps);
  assert.equal(r.summary.rejected, 1);
  assert.equal(r.validation.rejected[0].reason, 'quote-mismatch');
});

test('Y06 invalid basis / inferred+high / stated 自动 confirmed 都被拦', async () => {
  for (const bad of [
    { kind: 'observation', text: 'x', basis: 'guess', evidence: [{ messageId: 11, quote: '她不喜欢别人替她做决定' }] },
    { kind: 'inference', text: 'x', basis: 'inferred', confidence: 'high', inferred: 'y', evidence: [{ messageId: 11, quote: '她不喜欢别人替她做决定' }] },
    { kind: 'observation', text: 'x', basis: 'stated', confirmed: '她确认过', evidence: [{ messageId: 11, quote: '她不喜欢别人替她做决定' }] },
  ]) {
    const d = await depsWith({ aiText: JSON.stringify({ records: [bad] }) });
    const r = await DR.run({}, d.deps);
    assert.equal(r.summary.valid, 0);
    assert.equal(r.summary.rejected, 1);
  }
});

/* ---------- 失败不伪装成空结果 ---------- */
test('Y07 读取失败：明确报错、不调用 AI、不伪装成空批次', async () => {
  const d = await depsWith({ fail: true });
  const r = await DR.run({}, d.deps);
  assert.equal(r.ok, false);
  assert.equal(r.read.reason, 'cursor-failed');
  assert.equal(r.ai.attempted, false);
  assert.equal(d.aiCalls.length, 0);
  assert.match(r.warnings.join(' '), /读取失败/);
});

test('Y08 读取抛异常也被捕获', async () => {
  const d = await depsWith({ throw: true });
  const r = await DR.run({}, d.deps);
  assert.equal(r.ok, false);
  assert.equal(r.read.reason, 'read-threw');
  assert.equal(r.ai.attempted, false);
});

test('Y09 AI 请求失败：显示错误码、不重试、无校验结果', async () => {
  const boom = Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
  const d = await depsWith({ callAI: async () => { throw boom; } });
  const r = await DR.run({}, d.deps);
  assert.equal(r.ok, false);
  assert.equal(r.ai.errorCode, 'TIMEOUT');
  assert.equal(r.validation, null);
  assert.equal(d.aiCalls.length, 1, '不自动重试');
  assert.match(r.warnings.join(' '), /AI 请求失败/);
});

test('Y10 非法 JSON 明确失败，不是 0 个候选的成功', async () => {
  const d = await depsWith({ aiText: '这不是 JSON' });
  const r = await DR.run({}, d.deps);
  assert.equal(r.ok, false);
  assert.equal(r.validation.reason, 'bad-json');
  assert.match(r.warnings.join(' '), /不能当成空结果/);
});

test('Y11 空批次不调用 AI，也不自动往后扫', async () => {
  const d = await depsWith({ messages: [] });
  const r = await DR.run({}, d.deps);
  assert.equal(r.ok, false);
  assert.equal(d.aiCalls.length, 0);
  assert.equal(d.deps.reader.calls.length, 1);
  assert.match(r.warnings.join(' '), /没有消息/);
});

test('Y12 localhost:8787 被拒绝，避免误读另一份库', async () => {
  const d = await depsWith({ location: { hostname: 'localhost', port: '8787', href: 'http://localhost:8787/' } });
  const r = await DR.run({}, d.deps);
  assert.equal(r.ok, false);
  assert.equal(r.read.reason, 'wrong-origin');
  assert.equal(d.aiCalls.length, 0);
});

/* ---------- 结构边界 ---------- */
test('Y13 源码级边界：写入仅在审核确认后经 create + 独立水位键；不自动重试、不遍历全库；localStorage 只写测试专用键', () => {
  const src = readFileSync(new URL('../../public/shared/self-narrative-dryrun.js', import.meta.url), 'utf8');
  // P0 起允许写入，但形态受限：采纳只走注入的 SelfNarrative.create；水位只写 WATERMARK_KEY。
  assert.equal(/\.update\s*\(|\.retract\s*\(/.test(src), false, '本任务不使用 update / retract 写接口');
  assert.ok(/sn\.create\s*\(/.test(src), '采纳统一走 SelfNarrative.create');
  assert.ok(/\bkvSet\s*\(\s*WATERMARK_KEY\s*,/.test(src), '水位写独立键');
  assert.equal(/\bkvSet\s*\(\s*(SN\.KEY|['"]selfNarrative\.v1)/.test(src), false, '绝不写正式机自述键');
  assert.equal(/localStorage\[|localStorage\.[A-Za-z]+\s*=/.test(src), false, '不直接给 localStorage 赋值');
  // 允许且仅允许写测试历史专用键；调用形态必须是 st.setItem(STORAGE_KEY, ...)。
  const setItemCalls = src.match(/\.setItem\s*\([^)]*\)/g) || [];
  assert.ok(setItemCalls.length > 0, '存在测试历史写入');
  setItemCalls.forEach((call) => {
    assert.match(call, /\.setItem\s*\(\s*STORAGE_KEY\s*,/, 'setItem 只能写 STORAGE_KEY：' + call);
  });
  assert.equal(/var STORAGE_KEY\s*=\s*'ylxh\.snDryRun\.v1'/.test(src), true, '测试历史独立键');
  assert.equal(/getAll\s*\(/.test(src), false, '不读全库');
  assert.equal(/while\s*\(|for\s*\(\s*;/.test(src), false, '没有自动连续扫描循环');
  assert.equal(/retry|重试\s*3|attempt\s*\+/.test(src), false, '不自动重试');
  assert.ok(/readBatch\s*\(/.test(src));
  assert.ok(/validateOutput\s*\(/.test(src));
  assert.ok(/buildDedupeIndex\s*\(/.test(src));
});

/* ---------- S2b：跨批参考认识 ---------- */
test('Y14 priorCandidates 作为参考认识进入提示词，不进 ctx、不伪装成消息', async () => {
  const prior = priorCandidates();
  const d = await depsWith();
  const base = await DR.run({}, d.deps);

  const d2 = await depsWith();
  const r = await DR.run({ priorCandidates: prior }, d2.deps);
  const user = d2.aiCalls[0].messages[1].content;

  assert.equal(r.ok, true);
  assert.equal(base.ok, true, '不传时仍正常运行');
  assert.equal(r.batch.priorNoteCount, 1);
  assert.equal(r.batch.ctxCount, 0, 'ctx 仍然为空');
  assert.match(user, /【上一批的初步认识 · 仅供参考】/);
  assert.match(user, /尚未入库、未确认，不代表事实/);
  assert.match(user, /不得引用这些候选的 ID 或内容作为 evidence/);
  assert.match(user, /她好像不喜欢被安排（证据 \[msg 11\]）/);
  assert.equal(user.includes('【上下文，仅供理解】'), false);
  assert.equal(user.includes('[11*]'), false, '不生成带星号的上下文消息');
  assert.equal(user.includes('sn-old'), false, '不渲染候选自身 ID');
  assert.equal(user.includes('"evidence":[{"messageId":11'), false, '不渲染候选证据块');
  assert.equal(d2.aiCalls[0].messages[0].content, d.aiCalls[0].messages[0].content, 'system 不变');
  assert.equal(base.batch.priorNoteCount, 0, '不传时没有参考认识');
  assert.equal(d2.map.size, 0);
  assert.equal(d2.deps.reader.calls.length, 1, '不自动扫描下一批');
});

test('Y15 候选文本自带的旧消息 ID 不能作为当前批 evidence', async () => {
  const aiText = JSON.stringify({ records: [{
    kind: 'inference', text: '旧认识在新经历里被确认了', inferred: '她果然不喜欢被安排',
    confidence: 'low', basis: 'inferred',
    evidence: [{ messageId: 11, quote: '旧原文' }],
  }] });
  const d = await depsWith({ messages: secondMsgs(), reader: reader(secondMsgs()), aiText });
  const r = await DR.run({ afterId: 20, limit: 80, maxChars: 12000, priorCandidates: priorCandidates() }, d.deps);

  assert.deepEqual(r.read.ids, [21, 22], '当前批只有 21/22');
  assert.match(d.aiCalls[0].messages[1].content, /证据 \[msg 11\]/, '旧 ID 只出现在参考文字里');
  assert.equal(r.batch.priorNoteCount, 1);
  assert.equal(r.validation.ok, true);
  assert.equal(r.summary.valid, 0);
  assert.equal(r.validation.rejected[0].reason, 'unknown-source');
  assert.equal(r.candidates.length, 0);
  assert.equal(d.map.size, 0, '仍然禁写机自述');
});

test('Y16 有参考认识时，当前批真实消息的证据校验保持原样', async () => {
  const aiText = JSON.stringify({ records: [{
    kind: 'inference', text: '她这次自己做了选择', inferred: '她在试着自己决定',
    confidence: 'low', basis: 'inferred',
    evidence: [{ messageId: 21, quote: '这次她自己选了' }],
  }] });
  const d = await depsWith({ messages: secondMsgs(), reader: reader(secondMsgs()), aiText });
  const r = await DR.run({ afterId: 20, priorCandidates: priorCandidates() }, d.deps);

  assert.equal(r.ok, true);
  assert.equal(r.summary.valid, 1);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].primaryMessageId, 21);
  assert.equal(r.candidates[0].evidence[0].messageId, 21);
  assert.equal(r.candidates[0].evidence[0].original.content, '这次她自己选了');
  assert.equal(r.candidates[0].allCtx, false);
  assert.equal(d.map.size, 0);
  assert.equal(d.deps.reader.calls.length, 1);
});

test('Y17 有参考认识时，confirmed 拦截与水位边界不变', async () => {
  const aiText = JSON.stringify({ records: [{
    kind: 'observation', text: '她确认过这件事', basis: 'stated',
    confirmed: '她确认过', evidence: [{ messageId: 21, quote: '这次她自己选了' }],
  }] });
  const d = await depsWith({ messages: secondMsgs(), reader: reader(secondMsgs()), aiText });
  const r = await DR.run({ afterId: 20, priorCandidates: priorCandidates() }, d.deps);

  assert.equal(r.validation.stats.autoConfirmedBlocked, 1);
  assert.equal(r.summary.valid, 0);
  assert.match(r.warnings.join(' '), /已拦下 1 条带 confirmed/);
  assert.equal(d.map.size, 0, '禁写');
  assert.equal(d.deps.reader.calls.length, 1, '不自动扫描第三批');
  assert.equal(typeof r.read.nextAfterId, 'number', '水位只报告、不推进');
});

/* ================= 多轮测试面板：存储 / 跨轮参考 / 回放 / 管理 ================= */

function fakeStorage(initial) {
  const map = new Map(initial ? [[DR.STORAGE_KEY, initial]] : []);
  return {
    map,
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); }
  };
}

function storedHistory(storage) {
  const raw = storage.getItem(DR.STORAGE_KEY);
  return raw ? JSON.parse(raw) : null;
}

function sampleResult(over = {}) {
  return {
    ok: true, dryRun: true, startedAt: T, wallClockMs: 100,
    read: { ok: true, reason: 'ok', count: 2, ids: [11, 12], afterId: 10, nextAfterId: 12, done: true },
    batch: { dayKey: 'd', priorNoteCount: 0 },
    ai: { ok: true, reason: 'ok', usage: { promptTokens: 10, completionTokens: 5, costCny: 0.01 } },
    validation: { ok: true, reason: 'ok' },
    dedupe: { ok: true, newCount: 1, duplicateCount: 0, ctxOnlyCount: 0, indexCount: 0, existingTotal: 0 },
    summary: { candidates: 1, valid: 1, duplicates: 0, rejected: 0, ctxOnly: 0 },
    candidates: [{ kind: 'inference', text: '认识甲', basis: 'inferred', confidence: 'low', inferred: '甲', evidence: [{ messageId: 11, quote: 'q', original: { id: 11, content: '她不喜欢别人替她做决定' } }] }],
    skipped: [], warnings: [],
    ...over
  };
}

function saveN(store, n) {
  for (let i = 1; i <= n; i++) {
    const r = store.saveRound(DR.buildRound({ roundNo: i, savedAt: T + i, afterId: i * 10, limit: 80, maxChars: 12000 }, sampleResult(), null));
    assert.equal(r.ok, true, '第 ' + i + ' 轮应保存成功');
  }
}

test('Z01 不选择参考来源时独立执行；轮次保存为独立键且标记 dryRun', async () => {
  const storage = fakeStorage();
  const store = DR.createStore(storage);
  const d = await depsWith();
  const r = await DR.run({ afterId: 0, limit: 80, maxChars: 12000 }, d.deps);
  assert.equal(r.ok, true);

  const entry = DR.buildRound({ roundNo: 1, savedAt: T, afterId: 0, limit: 80, maxChars: 12000 }, r, null);
  const saved = store.saveRound(entry);
  assert.equal(saved.ok, true);
  const raw = storedHistory(storage);
  assert.equal(raw.schema, 1);
  assert.equal(raw.dryRun, true);
  assert.equal(raw.rounds.length, 1);
  assert.equal(raw.rounds[0].dryRun, true);
  assert.equal(raw.rounds[0].result.dryRun, true);
  assert.deepEqual([...storage.map.keys()], [DR.STORAGE_KEY], '只写测试专用键');
  assert.equal(DR.resolvePriorCandidates(store, '').candidates.length, 0, '不选择来源返回空');
});

test('Z02 选择上一轮后，下一轮收到其候选作为 priorCandidates；不传时为空', async () => {
  const storage = fakeStorage();
  const store = DR.createStore(storage);
  saveN(store, 1);

  const resolved = DR.resolvePriorCandidates(store, 1);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.sourceRound, 1);
  assert.equal(resolved.candidates.length, 1);
  assert.equal(resolved.candidates[0].text, '认识甲');
  assert.equal(DR.resolvePriorCandidates(store, null).candidates.length, 0, '独立执行无候选');

  const d = await depsWith();
  await DR.run({ priorCandidates: resolved.candidates }, d.deps);
  assert.equal(d.aiCalls[0].messages[1].content.includes('认识甲'), true, '候选取自历史并进入提示词');
});

test('Z03 跨轮参考候选仍不能作为当前批的真实 evidence ID', async () => {
  const storage = fakeStorage();
  const store = DR.createStore(storage);
  saveN(store, 1);
  const resolved = DR.resolvePriorCandidates(store, 1);

  const aiText = JSON.stringify({ records: [{
    kind: 'inference', text: '旧认识被当成证据', inferred: 'x', confidence: 'low', basis: 'inferred',
    evidence: [{ messageId: 11, quote: 'q' }]
  }] });
  // 当前批只有 21/22；候选文本自带 msg 11，引用必被拒。
  const d = await depsWith({ messages: secondMsgs(), reader: reader(secondMsgs()), aiText });
  const r = await DR.run({ afterId: 20, priorCandidates: resolved.candidates }, d.deps);
  assert.equal(r.validation.rejected[0].reason, 'unknown-source');
  assert.equal(r.summary.valid, 0);
  assert.equal(d.map.size, 0);
});

test('Z04 刷新页面后历史仍存在（同一 storage 重新 load）', () => {
  const storage = fakeStorage();
  const storeA = DR.createStore(storage);
  saveN(storeA, 2);
  // 模拟刷新：丢弃内存对象，重新创建 store，仍指向同一 storage。
  const storeB = DR.createStore(storage);
  const loaded = storeB.load();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.rounds.length, 2);
  assert.equal(loaded.rounds[1].roundNo, 2);
});

test('Z05 历史回放不触发 AI；只读取完整 result', () => {
  const storage = fakeStorage();
  const store = DR.createStore(storage);
  saveN(store, 2);
  let aiTriggered = false;
  // replayRound 只做存储读取，不接收也不调用 callAI。
  const rep = DR.replayRound(store, 2);
  assert.equal(aiTriggered, false);
  assert.equal(rep.ok, true);
  assert.equal(rep.roundNo, 2);
  assert.equal(rep.result.dryRun, true);
  assert.equal(rep.result.candidates[0].text, '认识甲');
  assert.equal(DR.replayRound(store, 999).reason, 'round-not-found');
});

test('Z06 清除历史只删测试键，不影响正式机自述', () => {
  const storage = fakeStorage();
  const store = DR.createStore(storage);
  const map = new Map([[SN.KEY, { schema: 1, records: [{ id: 'real', text: '正式记录' }] }]]);
  storage.setItem('other.app.key', 'keep-me');
  saveN(store, 1);
  const before = map.get(SN.KEY);
  const res = store.clear();
  assert.equal(res.ok, true);
  assert.equal(storage.getItem(DR.STORAGE_KEY), null, '测试历史已删除');
  assert.equal(storage.getItem('other.app.key'), 'keep-me', '其它 localStorage 数据不受影响');
  assert.equal(map.get(SN.KEY), before, '正式机自述对象未被触碰');
  assert.equal(store.load().rounds.length, 0);
});

test('Z07 达到 20 轮上限时不静默删除旧结果，明确提示', () => {
  const storage = fakeStorage();
  const store = DR.createStore(storage);
  saveN(store, DR.MAX_ROUNDS);
  const raw = storedHistory(storage);
  assert.equal(raw.rounds.length, DR.MAX_ROUNDS);
  assert.equal(raw.rounds[0].roundNo, 1, '最早一轮仍在');

  const overflow = store.saveRound(DR.buildRound({ roundNo: DR.MAX_ROUNDS + 1, savedAt: T }, sampleResult(), null));
  assert.equal(overflow.ok, false);
  assert.equal(overflow.reason, 'limit-reached');
  assert.equal(overflow.kept, DR.MAX_ROUNDS);
  assert.equal(storedHistory(storage).rounds.length, DR.MAX_ROUNDS, '未覆盖任何旧轮次');
  assert.equal(storedHistory(storage).rounds[0].roundNo, 1);
});

test('Z08 localStorage 写入失败时本轮结果仍完整可展示，saveRound 明确报错', async () => {
  const failing = {
    getItem() { return null; },
    setItem() { throw new DOMExceptionQuota(); },
    removeItem() {}
  };
  function DOMExceptionQuota() { this.name = 'QuotaExceededError'; this.message = 'quota'; }
  const store = DR.createStore(failing);
  const d = await depsWith();
  const r = await DR.run({}, d.deps);
  // 结果本身不依赖存储
  assert.equal(r.ok, true);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.dryRun, true);
  const saved = store.saveRound(DR.buildRound({ roundNo: 1, savedAt: T }, r, null));
  assert.equal(saved.ok, false);
  assert.equal(saved.reason, 'write-failed');
  assert.match(saved.error, /quota/);
});

test('Z09 历史结构损坏时明确报错，不清空、不伪装成空历史', () => {
  const storage = fakeStorage('{ this is not json');
  const bad = DR.createStore(storage);
  const loaded = bad.load();
  assert.equal(loaded.ok, false);
  assert.equal(loaded.reason, 'corrupted');
  assert.equal(loaded.rounds.length, 0);

  const storage2 = fakeStorage(JSON.stringify({ schema: 99, dryRun: true, rounds: [] }));
  const bad2 = DR.createStore(storage2);
  assert.equal(bad2.load().reason, 'bad-shape');
  assert.equal(storage2.getItem(DR.STORAGE_KEY) != null, true, '损坏数据未被清除');
});

test('Z10 轮次元数据结构完整：参数 / 消息范围 / 参考来源 / 完整结果', () => {
  const storage = fakeStorage();
  const store = DR.createStore(storage);
  saveN(store, 1);
  const r = store.load().rounds[0];
  assert.equal(r.dryRun, true);
  assert.equal(r.roundNo, 1);
  assert.ok(r.savedAt > 0);
  assert.deepEqual(r.params, { afterId: 10, limit: 80, maxChars: 12000, tzOffsetMin: null });
  assert.deepEqual(r.range, { firstId: 11, lastId: 12, afterId: 10, nextAfterId: 12, count: 2, done: true });
  assert.equal(r.priorSourceRound, null);
  assert.equal(r.result.dryRun, true);
  assert.equal(DR.nextRoundNo(store.load().rounds), 2);
});

/* ---------- S2d P0：正式采纳 + 安全水位 ---------- */
function memStore(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    map,
    async get(k) { return map.get(k); },
    async set(k, v) { map.set(k, v); },
  };
}
const adoptedCandidate = (over) => Object.assign({
  status: 'new', of: null,
  kind: 'impression', basis: 'observed', confidence: 'medium',
  text: '她催我先吃饭', observed: '她说先吃饭吧', inferred: '', confirmed: '', question: '',
  topic: '关心', primaryMessageId: 31, allCtx: false,
  evidence: [{ messageId: 31, quote: '先吃饭吧', original: { id: 31, role: 'user', content: '先吃饭吧等你吃完', time: T } }]
}, over || {});

test('AA01 候选到正式记录的白名单映射：source / evidence / basis / kind，confirmed 强制清空', () => {
  const mapped = DR.candidateToCreateSpec(adoptedCandidate(), SN);
  assert.equal(mapped.ok, true);
  assert.equal(mapped.spec.id.startsWith('sn-adopt-'), true, '确定性 id 做幂等');
  assert.equal(mapped.spec.kind, 'impression');
  assert.equal(mapped.spec.basis, 'observed');
  assert.equal(mapped.spec.confirmed, '', 'AI 候选不得自行确认');
  assert.deepEqual(mapped.spec.evidence, [{ messageId: 31, quote: '先吃饭吧' }], '剥掉 original');
  assert.deepEqual(mapped.spec.source, { kind: 'chat', messageId: 31 }, '主证据与 source 同源');
  assert.equal(mapped.spec.status, undefined, '候选 status 不得混进正式记录');
  assert.equal(mapped.spec.of, undefined);
  assert.equal(mapped.spec.primaryMessageId, undefined);
  assert.equal(DR.candidateToCreateSpec({ kind: 'observation', text: 'x', evidence: [] }, SN).reason, 'no-evidence');
});

test('AA02 单条采纳成功：走 SelfNarrative.create 落库，历史链可读', async () => {
  const s = memStore();
  let st = DR.initReview([adoptedCandidate()]);
  st = DR.setReviewDecision(st, 'c0', 'adopt');
  const out = await DR.adoptReviewed(s, st, { selfNarrative: SN, now: () => T });
  assert.equal(out.length, 1);
  assert.equal(out[0].ok, true, out[0].reason);
  assert.equal(out[0].idempotent, false);
  const listed = await SN.list(s, { status: 'active' });
  assert.equal(listed.total, 1);
  assert.equal(listed.records[0].text, '她催我先吃饭');
  assert.deepEqual(listed.records[0].evidence, [{ messageId: 31, quote: '先吃饭吧' }]);
  assert.equal((await SN.historyOf(s, out[0].id)).ok, true, '历史版本机制不受影响');
});

test('AA03 单条采纳失败不中断其余，也不误报成功', async () => {
  let n = 0;
  const flaky = {
    fingerprint: SN.fingerprint,
    create: async (store, spec) => {
      n += 1;
      if (spec.text.includes('失败项')) throw new Error('模拟写库失败');
      return { ok: true, id: 'sn-' + n, reason: 'created' };
    }
  };
  let st = DR.initReview([adoptedCandidate({ text: '通过项' }), adoptedCandidate({ text: '失败项' })]);
  st = DR.setReviewDecision(st, 'c0', 'adopt');
  st = DR.setReviewDecision(st, 'c1', 'adopt');
  const out = await DR.adoptReviewed(memStore(), st, { selfNarrative: flaky, now: () => T });
  assert.equal(out.length, 2);
  assert.equal(out[0].ok, true);
  assert.equal(out[1].ok, false);
  assert.equal(out[1].reason, 'create-threw');
  assert.equal(n, 2, '两条都尝试过，失败的不影响前一条');
});

test('AA04 重复点击采纳不生成重复记录（duplicate-id 按幂等成功处理）', async () => {
  const s = memStore();
  let st = DR.initReview([adoptedCandidate()]);
  st = DR.setReviewDecision(st, 'c0', 'adopt');
  const a = await DR.adoptReviewed(s, st, { selfNarrative: SN, now: () => T });
  const b = await DR.adoptReviewed(s, st, { selfNarrative: SN, now: () => T });
  assert.equal(a[0].ok, true);
  assert.equal(a[0].idempotent, false);
  assert.equal(b[0].ok, true);
  assert.equal(b[0].idempotent, true, '第二次命中已存在记录，不误报失败');
  assert.equal((await SN.list(s, { status: 'all' })).total, 1, '正式记录仍只有一条');
});

test('AA05 部分候选未审核时不得推进水位', () => {
  let st = DR.initReview([adoptedCandidate(), adoptedCandidate({ text: '二' }), adoptedCandidate({ text: '三' })]);
  st = DR.setReviewDecision(st, 'c0', 'adopt');
  const gate = DR.canAdvanceReview(st, [{ key: 'c0', idx: 0, ok: true }]);
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, 'pending');
  assert.equal(gate.pending, 2);
});

test('AA06 全部采纳或全部明确跳过后才允许推进（含空批次）', () => {
  let st = DR.initReview([adoptedCandidate(), adoptedCandidate({ text: '二' })]);
  st = DR.setReviewDecision(st, 'c0', 'adopt');
  st = DR.setReviewDecision(st, 'c1', 'skip');
  assert.equal(DR.canAdvanceReview(st, [{ key: 'c0', ok: true }]).ok, true, '采纳+明确跳过算完整');

  let allSkip = DR.initReview([adoptedCandidate(), adoptedCandidate({ text: '二' })]);
  allSkip = DR.setReviewDecision(allSkip, 'c0', 'skip');
  allSkip = DR.setReviewDecision(allSkip, 'c1', 'skip');
  assert.equal(DR.canAdvanceReview(allSkip, []).ok, true, '全跳过也算完整审核');
  assert.equal(DR.canAdvanceReview(DR.initReview([]), []).ok, true, '空批次可明确完成');
});

test('AA07 采纳写入失败时不得推进水位', () => {
  let st = DR.initReview([adoptedCandidate(), adoptedCandidate({ text: '二' })]);
  st = DR.setReviewDecision(st, 'c0', 'adopt');
  st = DR.setReviewDecision(st, 'c1', 'adopt');
  const gate = DR.canAdvanceReview(st, [
    { key: 'c0', idx: 0, ok: true },
    { key: 'c1', idx: 1, ok: false, reason: 'write-failed' },
  ]);
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, 'adopt-failed');
  assert.equal(gate.failed.length, 1);
});

test('AA08 水位只写独立键；写入失败明确返回 reason，不碰正式机自述键', async () => {
  const keys = [];
  const fail = await DR.saveWatermark(async (k) => { keys.push(k); throw new Error('quota'); }, { nextAfterId: 80 });
  assert.equal(fail.ok, false);
  assert.equal(fail.reason, 'write-failed');
  assert.deepEqual(keys, [DR.WATERMARK_KEY]);

  const map = new Map();
  const ok = await DR.saveWatermark(async (k, v) => { map.set(k, v); }, {
    nextAfterId: 80, afterId: 0, firstId: 1, lastId: 80, adopted: 2, skipped: 1, savedAt: T,
  });
  assert.equal(ok.ok, true);
  assert.deepEqual([...map.keys()], [DR.WATERMARK_KEY], '只写水位键');
  const wm = map.get(DR.WATERMARK_KEY);
  assert.equal(wm.lastAfterId, 80);
  assert.equal(wm.dryRun, false);
  assert.equal(wm.adopted, 2);
  assert.equal(wm.skipped, 1);
  assert.equal((await DR.saveWatermark(async () => {}, {})).reason, 'bad-next-after-id');
});

test('AA09 水位结构非法明确拒绝；run 未传 afterId 时从水位继续读取', async () => {
  assert.equal(DR.normalizeWatermark(null).value, 0);
  assert.equal(DR.normalizeWatermark({ schema: 99, lastAfterId: 40 }).reason, 'bad-shape');
  const d = await depsWith({});
  d.map.set(DR.WATERMARK_KEY, { schema: 1, lastAfterId: 40, updatedAt: T, fromAfterId: 0, dryRun: false });
  const r = await DR.run({ limit: 80, maxChars: 12000 }, d.deps);
  assert.equal(r.afterIdSource, 'watermark');
  assert.equal(r.read.afterId, 40, '开区间游标从水位继续');
});

test('AA10 采纳与水位均不写备份白名单键，也不写测试历史键', async () => {
  const s = memStore();
  let st = DR.initReview([adoptedCandidate()]);
  st = DR.setReviewDecision(st, 'c0', 'adopt');
  await DR.adoptReviewed(s, st, { selfNarrative: SN, now: () => T });
  await DR.saveWatermark(async (k, v) => s.set(k, v), { nextAfterId: 80, savedAt: T });
  assert.deepEqual([...s.map.keys()].sort(), [SN.KEY, DR.WATERMARK_KEY].sort());
  assert.equal(s.map.has('longTermMemory'), false);
  assert.equal(s.map.has('ylxh.snDryRun.v1'), false);
});

/* ---------- 人工重建候选入口：独立校验、复用现有审核/写入 ---------- */
function manualReader(messages) {
  const calls = [];
  return {
    calls,
    async getById(id) {
      calls.push(id);
      const m = messages.find((x) => String(x.id) === String(id));
      return {
        ok: true, reason: m ? 'ok' : 'not-found',
        id: m ? m.id : null, exists: !!m, message: m || null
      };
    }
  };
}
const manualMessages = () => [
  { id: 31, role: 'user', content: '先吃饭吧等你吃完', time: T, source: null, sourceId: null, silent: false, type: null },
];
const manualCandidate = (over) => Object.assign({
  kind: 'impression', basis: 'observed', confidence: 'medium',
  text: '她催我先吃饭', observed: '她说先吃饭吧', inferred: '', confirmed: '', question: '',
  topic: '关心',
  evidence: [{ messageId: 31, quote: '先吃饭吧' }]
}, over || {});
const manualPayload = (candidates, over) => JSON.stringify(Object.assign({
  origin: DR.MANUAL_ORIGIN, candidates
}, over || {}));
function manualDeps(over = {}) {
  const map = new Map();
  if (over.watermark) map.set(DR.WATERMARK_KEY, over.watermark);
  if (over.seed) map.set(SN.KEY, over.seed);
  const reader = over.reader || manualReader(over.messages || manualMessages());
  return {
    map,
    reader,
    deps: {
      reader,
      review: R,
      selfNarrative: SN,
      kvGet: async (k) => map.get(k),
      now: () => T,
      location: { hostname: '127.0.0.1', port: '8787', href: 'http://127.0.0.1:8787/' }
    }
  };
}

test('AB01 合法人工候选进入审核区：核验真实消息，保留人工标记，不调用 AI', async () => {
  const d = manualDeps();
  const res = await DR.verifyManualCandidates(manualPayload([manualCandidate()]), d.deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.manual, true);
  assert.equal(res.ai.attempted, false, '不得伪造 AI 请求');
  assert.equal(res.stats.accepted, 1);
  assert.deepEqual(d.reader.calls, [31], 'messageId 必须对真实聊天逐条查证');
  const c = res.accepted[0];
  assert.equal(c.manual, true);
  assert.equal(c.origin, DR.MANUAL_ORIGIN);
  assert.match(c.sourceLabel, /人工重建，非原始 AI 输出/);
  assert.deepEqual(c.evidenceVerification.checks, [{
    messageId: 31, quote: '先吃饭吧', result: 'matched', messageRole: 'user'
  }]);
  assert.deepEqual(c.evidence, [{ messageId: 31, quote: '先吃饭吧' }], '不得改写原始证据');
  const mapped = DR.candidateToCreateSpec(c, SN);
  assert.equal(mapped.ok, true);
  assert.equal(mapped.spec.source.kind, 'manual-reconstruction', '正式记录可保存人工来源，无需改 schema');
  assert.equal(mapped.spec.source.aiGenerated, false);
  assert.equal(mapped.spec.source.messageId, 31);
  assert.equal(mapped.spec.confirmed, '', '人工候选也不能自行确认');
  assert.equal(d.map.size, 0, '核验阶段不写任何库');
});

test('AB02 不存在的 messageId 被拒绝，不进入审核区', async () => {
  const d = manualDeps();
  const res = await DR.verifyManualCandidates(manualPayload([
    manualCandidate({ evidence: [{ messageId: 999, quote: '先吃饭吧' }] })
  ]), d.deps);
  assert.equal(res.ok, false);
  assert.equal(res.accepted.length, 0);
  assert.equal(res.rejected[0].reason, 'message-not-found');
  assert.equal(String(res.rejected[0].detail), '999');
});

test('AB03 quote 与原文不匹配被拒绝，不允许只检查非空', async () => {
  const d = manualDeps();
  const res = await DR.verifyManualCandidates(manualPayload([
    manualCandidate({ evidence: [{ messageId: 31, quote: '她其实很犹豫' }] })
  ]), d.deps);
  assert.equal(res.ok, false);
  assert.equal(res.accepted.length, 0);
  assert.equal(res.rejected[0].reason, 'quote-mismatch');
});

test('AB04 缺少人工标记的输入被拒绝，不能伪装成原始 AI JSON', async () => {
  const d = manualDeps();
  const raw = JSON.stringify({ candidates: [manualCandidate()] });
  const res = await DR.verifyManualCandidates(raw, d.deps);
  assert.equal(res.reason, 'not-manual-reconstruction');
  assert.equal(res.accepted.length, 0);
  assert.deepEqual(d.reader.calls, [], '标记不对时连真实消息都不读');
});

test('AB05 人工候选采纳仍经过正式数据层校验，非法字段不落库', async () => {
  const s = memStore();
  let st = DR.initReview([Object.assign({}, manualCandidate(), {
    manual: true, origin: DR.MANUAL_ORIGIN, kind: 'bogus'
  })]);
  st = DR.setReviewDecision(st, 'c0', 'adopt');
  const out = await DR.adoptReviewed(s, st, { selfNarrative: SN, now: () => T });
  assert.equal(out[0].ok, false);
  assert.equal(out[0].reason, 'invalid-kind');
  assert.equal((await SN.list(s, { status: 'all' })).total, 0);
});

test('AB06 人工核验与采纳都不创建或推进水位', async () => {
  const watermark = { schema: 1, lastAfterId: 40, updatedAt: T - 1, dryRun: false };
  const d = manualDeps({ watermark });
  const res = await DR.verifyManualCandidates(manualPayload([manualCandidate()]), d.deps);
  assert.equal(res.ok, true);
  assert.deepEqual(d.map.get(DR.WATERMARK_KEY), watermark, '核验阶段原样保留水位');

  const s = memStore({ [DR.WATERMARK_KEY]: watermark });
  let st = DR.initReview(res.accepted);
  st = DR.setReviewDecision(st, 'c0', 'adopt');
  const out = await DR.adoptReviewed(s, st, { selfNarrative: SN, now: () => T });
  assert.equal(out[0].ok, true);
  assert.deepEqual(s.map.get(DR.WATERMARK_KEY), watermark, '采纳阶段也不碰水位');
  const listed = await SN.list(s, { status: 'active' });
  assert.equal(listed.total, 1);
  assert.equal(listed.records[0].source.kind, 'manual-reconstruction');
});

test('AB07 原有 AI Dry-run 审核流程不回归', async () => {
  const d = await depsWith();
  const r = await DR.run({}, d.deps);
  assert.equal(r.ok, true);
  assert.equal(d.aiCalls.length, 1, 'AI 流程仍只请求一次');
  assert.equal(r.candidates.length, 1);
  const mapped = DR.candidateToCreateSpec(r.candidates[0], SN);
  assert.deepEqual(mapped.spec.source, { kind: 'chat', messageId: 11 }, 'AI 候选来源标记保持不变');

  let st = DR.initReview(r.candidates);
  st = DR.setReviewDecision(st, 'c0', 'adopt');
  const s = memStore();
  const out = await DR.adoptReviewed(s, st, { selfNarrative: SN, now: () => T });
  assert.equal(out[0].ok, true);
  assert.equal((await SN.list(s, { status: 'active' })).records[0].source.kind, 'chat');
});

/* ---------- 人工重建审核：独立完成通路（不读写水位） ---------- */
const manualReviewCandidate = (over) => Object.assign({
  manual: true, origin: DR.MANUAL_ORIGIN,
  kind: 'impression', basis: 'observed', confidence: 'medium',
  text: '她催我先吃饭', observed: '她说先吃饭吧', inferred: '', confirmed: '', question: '',
  topic: '关心',
  evidence: [{ messageId: 31, quote: '先吃饭吧' }],
  evidenceVerification: { verifiedAt: T, checks: [{ messageId: 31, quote: '先吃饭吧', result: 'matched' }] }
}, over || {});

test('AB08 人工审核全部采纳：写入采纳项，done 为真，水位不创建', async () => {
  const s = memStore();
  let st = DR.initReview([manualReviewCandidate(), manualReviewCandidate({ text: '她记得我不吃辣' })]);
  st = DR.setReviewDecision(st, 'c0', 'adopt');
  st = DR.setReviewDecision(st, 'c1', 'adopt');
  const res = await DR.completeManualReview(s, st, { selfNarrative: SN, now: () => T });
  assert.equal(res.ok, true);
  assert.equal(res.done, true);
  assert.equal(res.adopted, 2);
  assert.equal(res.adoptedOk, 2);
  assert.equal(res.skipped, 0);
  assert.deepEqual(res.failed, []);
  assert.equal(res.watermarkTouched, false);
  const listed = await SN.list(s, { status: 'active' });
  assert.equal(listed.total, 2);
  assert.equal(listed.records[0].source.kind, DR.MANUAL_ORIGIN, '人工来源标记不变');
  assert.equal(s.map.has(DR.WATERMARK_KEY), false, '人工完成不得创建水位');
});

test('AB09 人工审核部分采纳：只写采纳项，跳过项不入库', async () => {
  const s = memStore();
  let st = DR.initReview([manualReviewCandidate(), manualReviewCandidate({ text: '跳过项' })]);
  st = DR.setReviewDecision(st, 'c0', 'adopt');
  st = DR.setReviewDecision(st, 'c1', 'skip');
  const res = await DR.completeManualReview(s, st, { selfNarrative: SN, now: () => T });
  assert.equal(res.done, true);
  assert.equal(res.adopted, 1);
  assert.equal(res.adoptedOk, 1);
  assert.equal(res.skipped, 1);
  const listed = await SN.list(s, { status: 'all' });
  assert.equal(listed.total, 1, '跳过项不写入');
  assert.equal(listed.records[0].text, '她催我先吃饭');
  assert.equal(s.map.has(DR.WATERMARK_KEY), false);
});

test('AB10 人工审核全部跳过：允许正常完成，不写记录也不写水位', async () => {
  const s = memStore();
  let st = DR.initReview([manualReviewCandidate(), manualReviewCandidate({ text: '二' })]);
  st = DR.setReviewDecision(st, 'c0', 'skip');
  st = DR.setReviewDecision(st, 'c1', 'skip');
  const res = await DR.completeManualReview(s, st, { selfNarrative: SN, now: () => T });
  assert.equal(res.ok, true);
  assert.equal(res.done, true);
  assert.equal(res.adoptedOk, 0);
  assert.equal(res.skipped, 2);
  assert.deepEqual([...s.map.keys()], [], '全跳过不产生任何写入');
});

test('AB11 人工审核单条写入失败：done 为假，明确回传失败项，成功项保留', async () => {
  let n = 0;
  const flaky = {
    fingerprint: SN.fingerprint,
    create: async (store, spec) => {
      n += 1;
      if (spec.text.includes('失败项')) throw new Error('模拟写库失败');
      return { ok: true, id: 'sn-' + n, reason: 'created' };
    }
  };
  const s = memStore();
  let st = DR.initReview([manualReviewCandidate({ text: '通过项' }), manualReviewCandidate({ text: '失败项' })]);
  st = DR.setReviewDecision(st, 'c0', 'adopt');
  st = DR.setReviewDecision(st, 'c1', 'adopt');
  const res = await DR.completeManualReview(s, st, { selfNarrative: flaky, now: () => T });
  assert.equal(res.ok, false);
  assert.equal(res.done, false, '有失败时不得标记完成');
  assert.equal(res.reason, 'adopt-failed');
  assert.equal(res.adoptedOk, 1);
  assert.equal(res.failed.length, 1);
  assert.equal(res.failed[0].idx, 1, '失败项索引可用于面板定位');
  assert.equal(res.failed[0].reason, 'create-threw');
  assert.equal(s.map.has(DR.WATERMARK_KEY), false, '失败时也不碰水位');
});

test('AB12 人工审核重复完成：确定性 id 命中幂等，不产生重复记录', async () => {
  const s = memStore();
  let st = DR.initReview([manualReviewCandidate()]);
  st = DR.setReviewDecision(st, 'c0', 'adopt');
  const a = await DR.completeManualReview(s, st, { selfNarrative: SN, now: () => T });
  const b = await DR.completeManualReview(s, st, { selfNarrative: SN, now: () => T });
  assert.equal(a.done, true);
  assert.equal(b.done, true);
  assert.equal(a.results[0].idempotent, false);
  assert.equal(b.results[0].idempotent, true, '第二次命中同一条正式记录');
  assert.equal((await SN.list(s, { status: 'all' })).total, 1, '正式记录仍只有一条');
  assert.deepEqual([...s.map.keys()].sort(), [SN.KEY], '除正式记录外无其它写入');
});

test('AB13 人工审核仍有未审核项：拒绝完成，不写入任何记录', async () => {
  const s = memStore();
  let st = DR.initReview([manualReviewCandidate(), manualReviewCandidate({ text: '二' })]);
  st = DR.setReviewDecision(st, 'c0', 'adopt');
  const res = await DR.completeManualReview(s, st, { selfNarrative: SN, now: () => T });
  assert.equal(res.ok, false);
  assert.equal(res.done, false);
  assert.equal(res.reason, 'pending');
  assert.equal(res.pending, 1);
  assert.deepEqual([...s.map.keys()], [], '有待审项时不写入');
});

test('AB14 源码级：人工完成按钮独立、文案固定，人工通路不调用 saveWatermark', () => {
  const src = readFileSync(new URL('../../public/shared/self-narrative-dryrun.js', import.meta.url), 'utf8');
  assert.ok(/el\('button',\s*'finish',\s*'完成人工重建审核'\)/.test(src), '人工按钮文案必须是「完成人工重建审核」');
  assert.ok(/el\('button',\s*'finish',\s*'完成本批审核/.test(src), 'AI 按钮文案保持不变');

  const s0 = src.indexOf('async function completeManualReview');
  const s1 = src.indexOf('function isWatermarkId', s0);
  assert.ok(s0 > 0 && s1 > s0);
  const pure = src.slice(s0, s1);
  assert.equal(/saveWatermark|kvSet|WATERMARK_KEY/.test(pure), false, '人工完成纯逻辑不得触碰水位');

  const h0 = src.indexOf("manualFinishBtn.addEventListener");
  const h1 = src.indexOf('// 页面里 from 水位恢复 afterId', h0);
  assert.ok(h0 > 0 && h1 > h0);
  const handler = src.slice(h0, h1);
  assert.equal(/saveWatermark/.test(handler), false, '人工按钮处理器不得调用 saveWatermark');
  assert.equal(/completeManualReview\s*\(/.test(handler), true, '人工按钮必须走独立完成函数');
  assert.ok(/manualDone/.test(handler), '人工完成态需阻止重复写入');
});

