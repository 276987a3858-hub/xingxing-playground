/* tests/shared/self-narrative-auto.test.mjs — S3 增量自动整理 + 安全纠正 + 召回修复
 * 纯 Node：假 reader / 假 AI / 假 kv；不碰真实 IndexedDB、不发网络、不改真实数据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import '../../public/shared/self-narrative.js';
import '../../public/shared/self-narrative-review.js';
import '../../public/shared/self-narrative-dryrun.js';
import '../../public/shared/self-narrative-auto.js';

const SN = globalThis.SelfNarrative;
const R = globalThis.SelfNarrativeReview;
const DR = globalThis.SelfNarrativeDryRun;
const AUTO = globalThis.SelfNarrativeAuto;
const T = 1795000000000;

const SRC_AUTO = readFileSync(new URL('../../public/shared/self-narrative-auto.js', import.meta.url), 'utf8');
const SRC_SN = readFileSync(new URL('../../public/shared/self-narrative.js', import.meta.url), 'utf8');

function msgs() {
  return [
    { id: 11, role: 'user', content: '她不喜欢别人替她做决定', time: T, source: null, sourceId: null, silent: false, type: null },
    { id: 12, role: 'assistant', content: '那我下次先问你', time: T + 1000, source: null, sourceId: null, silent: false, type: null },
  ];
}

function reader(fake, over = {}) {
  const calls = [];
  return {
    calls,
    async readBatch(o) {
      calls.push({ afterId: o.afterId, limit: o.limit, maxChars: o.maxChars });
      if (over.fail) return { ok: false, reason: 'cursor-failed', messages: null, done: false };
      return { ok: true, reason: 'ok', messages: fake, nextAfterId: over.nextAfterId == null ? 12 : over.nextAfterId, done: true, count: fake.length, chars: 100 };
    },
    async getById() { return { ok: true, exists: false, message: null }; },
    async hasMessage() { return { ok: true, exists: false }; }
  };
}
function wm(afterId) { return { schema: 1, lastAfterId: afterId, updatedAt: T, dryRun: false }; }

// aiText：默认产出一条 medium/stated、证据真实的候选（可通过门槛）。
function deps(over = {}) {
  const map = new Map();
  if (over.watermark != null) map.set(DR.WATERMARK_KEY, over.watermark);
  if (over.seed) map.set(SN.KEY, over.seed);
  const aiCalls = [];
  const aiText = over.aiText != null ? over.aiText : JSON.stringify({ records: [{
    kind: 'impression', basis: 'stated', confidence: 'medium',
    text: '她很在意我有没有认真听她说话这件事',
    observed: '她要求我认真回答', inferred: '', question: '', confirmed: '',
    topic: '认真回应',
    evidence: [{ messageId: 11, quote: '她不喜欢别人替她做决定' }]
  }] });
  const callAI = async (messages, opts) => { aiCalls.push({ messages, opts }); return aiText; };
  return {
    aiCalls, map,
    d: {
      dryRun: DR, review: R, selfNarrative: SN,
      reader: reader(over.messages == null ? msgs() : over.messages, over),
      callAI: over.callAI || callAI,
      kvGet: async (k) => map.get(k),
      kvSet: async (k, v) => { map.set(k, v); },
      location: { hostname: '127.0.0.1', port: '8787', href: 'http://127.0.0.1:8787/' },
      now: () => T
    }
  };
}

/* ---------- autoQualify 门槛 ---------- */
const baseCandidate = () => ({
  kind: 'impression', basis: 'stated', confidence: 'medium',
  text: '她很在意我有没有认真听她说话这件事',
  observed: '她要求我认真回答', inferred: '', question: '', confirmed: '',
  topic: '认真回应', primaryMessageId: 11,
  evidence: [{ messageId: 11, quote: '她不喜欢别人替她做决定' }]
});

test('A01 合法候选通过自动入库门槛', () => {
  assert.equal(AUTO.autoQualify(baseCandidate()).ok, true);
});

test('A02 低置信度 / ctx-only / 短文本 / 空证据 / confirmed 被拒绝', () => {
  assert.equal(AUTO.autoQualify({ ...baseCandidate(), confidence: 'low' }).reason, 'low-confidence');
  assert.equal(AUTO.autoQualify({ ...baseCandidate(), allCtx: true }).reason, 'ctx-only');
  assert.equal(AUTO.autoQualify({ ...baseCandidate(), text: '好好' }).reason, 'too-short');
  assert.equal(AUTO.autoQualify({ ...baseCandidate(), evidence: [] }).reason, 'no-evidence');
  assert.equal(AUTO.autoQualify({ ...baseCandidate(), confirmed: '她确认了' }).reason, 'auto-confirm-blocked');
});

test('A03 inferred + high 推断过强被拒绝', () => {
  const r = AUTO.autoQualify({ ...baseCandidate(), basis: 'inferred', confidence: 'high' });
  assert.equal(r.reason, 'inference-too-strong');
});

/* ---------- runAutoBatch 端到端 ---------- */
test('A04 合法批次：一次 AI → 自动写入正式记录 → 推进水位', async () => {
  const d = deps();
  const r = await AUTO.runAutoBatch({}, d.d);
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'done');
  assert.equal(r.apiCalls, 1, '只请求一次 AI');
  assert.equal(r.adopt.succeeded, 1);
  assert.equal(r.watermark.touched, true);
  assert.equal(r.watermark.after, 12);
  const state = await SN.list({ get: async (k) => d.map.get(k) }, { status: 'all' });
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].source.kind, 'chat');
  assert.equal(d.map.get(DR.WATERMARK_KEY).lastAfterId, 12);
});

test('A05 证据不足 / 推断过强 / 低置信度的候选不写入，水位不动', async () => {
  const bad = JSON.stringify({ records: [{
    kind: 'inference', basis: 'inferred', confidence: 'low',
    text: '她好像不太喜欢被安排这件事', inferred: '被安排会让她不自在',
    confirmed: '', topic: '',
    evidence: [{ messageId: 11, quote: '她不喜欢别人替她做决定' }]
  }] });
  const d = deps({ aiText: bad });
  const r = await AUTO.runAutoBatch({}, d.d);
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'no-qualified');
  assert.equal(r.watermark.touched, false);
  assert.equal(d.map.has(DR.WATERMARK_KEY), false);
  const state = await SN.list({ get: async (k) => d.map.get(k) }, { status: 'all' });
  assert.equal(state.records.length, 0, '不应写入');
});

test('A06 水位之后增量：同一批重复执行不重复写入，确定性 ID 幂等', async () => {
  // 同一 store 连续两次采纳同一批候选（模拟水位未推进时的重试）→ 第二次命中 duplicate-id。
  const map = new Map();
  const store = { get: async (k) => map.get(k), set: async (k, v) => { map.set(k, v); } };
  const candidate = baseCandidate();
  const reviewState = DR.initReview([candidate]).map((x) => ({ ...x, status: 'adopt' }));
  const a = await DR.adoptReviewed(store, reviewState, { selfNarrative: SN, now: () => T });
  const b = await DR.adoptReviewed(store, reviewState, { selfNarrative: SN, now: () => T });
  assert.equal(a[0].ok, true);
  assert.equal(b[0].ok, true);
  assert.equal(b[0].idempotent, true, '第二次命中确定性 ID 幂等');
  const state = await SN.list(store, { status: 'all' });
  assert.equal(state.records.length, 1, '不得出现两条相同记录');
  // 端到端：从已推进水位继续，不会重复处理旧的 11/12。
  const first = deps();
  const r1 = await AUTO.runAutoBatch({}, first.d);
  assert.equal(r1.adopt.succeeded, 1);
  const second = deps({ watermark: first.map.get(DR.WATERMARK_KEY), messages: [] });
  const r2 = await AUTO.runAutoBatch({}, second.d);
  assert.equal(r2.apiCalls, 0, '水位之后为空批：不再调用 AI');
  assert.equal(r2.watermark.touched, false);
});

test('A07 写入失败：水位不推进，保留原值', async () => {
  const d = deps();
  d.d.kvSet = async (k, v) => {
    if (k === SN.KEY) throw new Error('模拟写入失败');
    d.map.set(k, v);
  };
  const r = await AUTO.runAutoBatch({}, d.d);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'adopt-failed');
  assert.equal(r.adopt.failed.length, 1);
  assert.equal(r.watermark.touched, false);
});

test('A08 批次上限 maxAdopt 生效', async () => {
  const three = JSON.stringify({ records: [0, 1, 2].map((i) => ({
    kind: 'impression', basis: 'stated', confidence: 'medium',
    text: '这是第' + i + '条足够长的认识内容用于通过门槛', observed: '她说了话',
    inferred: '', question: '', confirmed: '', topic: '',
    evidence: [{ messageId: 11, quote: '她不喜欢别人替她做决定' }]
  })) });
  const d = deps({ aiText: three, messages: msgs() });
  const r = await AUTO.runAutoBatch({ maxAdopt: 1 }, d.d);
  assert.equal(r.auto.qualified, 1);
  assert.equal(r.auto.capped, 2);
  assert.equal(r.adopt.succeeded, 1);
});

test('A09 空批次：不调用 AI，不写水位', async () => {
  const d = deps({ messages: [] });
  const r = await AUTO.runAutoBatch({}, d.d);
  assert.equal(r.ok, false);
  assert.equal(r.apiCalls, 0);
  assert.equal(r.watermark.touched, false);
});

/* ---------- 纠正机制 ---------- */
const recA = {
  id: 'sn-a', status: 'active', kind: 'impression', basis: 'observed', confidence: 'medium',
  text: '她认真回答我的问题', topic: '认真回应', observed: '她写了很长一段', inferred: '', question: '',
  evidence: [{ messageId: 11, quote: '她认真回答我的问题' }], history: []
};
const recB = {
  id: 'sn-b', status: 'active', kind: 'observation', basis: 'stated', confidence: 'medium',
  text: '她啃冷馒头', topic: '冷馒头', observed: '她啃了半个冷馒头', inferred: '', question: '',
  evidence: [], history: []
};

test('C01 纠正语境检测：明确纠正命中，普通闲聊不命中', () => {
  assert.equal(AUTO.detectCorrection('你记错了，其实我不是那样'), true);
  assert.equal(AUTO.detectCorrection('今天天气真好'), false);
  assert.equal(AUTO.detectCorrection('不是'), false, '单凭一个「不是」不算');
});

test('C02 prepareCorrection 只生成待确认候选，不写库', async () => {
  const res = AUTO.prepareCorrection('你记错了，其实我认真回答问题这件事不是那样', [recA, recB], {});
  assert.equal(res.ok, true);
  assert.equal(res.needsConfirm, true);
  assert.equal(res.isCorrection, true);
  assert.ok(res.candidates.length >= 1);
  assert.equal(res.candidates[0].needsConfirm, true);
  assert.equal(res.candidates[0].oldText, '她认真回答我的问题');
  assert.deepEqual(res.candidates[0].oldEvidence, [{ messageId: 11, quote: '她认真回答我的问题' }]);
});

test('C03 confirmCorrection 未确认一律拒绝', async () => {
  const map = new Map();
  const s = { get: async () => map.get(SN.KEY), set: async (k, v) => map.set(k, v) };
  const created = await SN.create(s, { text: '她认真回答我的问题', kind: 'impression', source: { kind: 'chat' } });
  assert.equal(created.ok, true);
  const r = await AUTO.confirmCorrection({ targetId: created.id, action: 'retract' }, {
    selfNarrative: SN, kvGet: s.get, kvSet: s.set
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-confirmed');
});

test('C04 confirmCorrection 确认后 retract：状态改 retracted，history 保留，正文不删', async () => {
  const map = new Map();
  const s = { get: async () => map.get(SN.KEY), set: async (k, v) => map.set(k, v) };
  const created = await SN.create(s, { text: '她认真回答我的问题', kind: 'impression', source: { kind: 'chat' } });
  const r = await AUTO.confirmCorrection({ targetId: created.id, action: 'retract', confirmed: true }, {
    selfNarrative: SN, kvGet: s.get, kvSet: s.set
  });
  assert.equal(r.ok, true);
  const got = await SN.get(s, created.id);
  assert.equal(got.record.status, 'retracted');
  assert.equal(got.record.text, '她认真回答我的问题');
  assert.equal(got.record.history.length, 1, '旧版本留下快照');
});

test('C05 confirmCorrection 确认后 revise-as-new：新版本 revisedFrom 旧 id，旧记录 superseded', async () => {
  const map = new Map();
  const s = { get: async () => map.get(SN.KEY), set: async (k, v) => map.set(k, v) };
  const created = await SN.create(s, { text: '她认真回答我的问题', kind: 'impression', source: { kind: 'chat' } });
  const r = await AUTO.confirmCorrection({
    targetId: created.id, action: 'revise-as-new', confirmed: true,
    spec: { text: '后来发现她只是偶尔认真', kind: 'impression', basis: 'inferred', confidence: 'low', topic: '认真回应', source: { kind: 'chat', messageId: 11 } }
  }, { selfNarrative: SN, kvGet: s.get, kvSet: s.set });
  assert.equal(r.ok, true);
  const old = await SN.get(s, created.id);
  assert.equal(old.record.status, 'superseded');
  assert.equal(old.record.supersededBy, r.resultId);
  assert.equal(old.record.history.length, 1, '旧版本与证据不被覆盖');
  const hist = await SN.historyOf(s, r.resultId);
  assert.ok(hist.ok);
  assert.ok(hist.versions.length >= 2, '可查看旧版本和修订后内容');
});

/* ---------- 召回修复 ---------- */
test('R01 明确追问允许再次注入已 sent 的记录', () => {
  const out = SN.contextPart('你记不记得之前你认真回应我的那次', [recA], {
    limit: 3, maxChars: 900, isSent: () => true, allowResent: true
  });
  assert.equal(out.count, 1);
  const blocked = SN.contextPart('你记不记得之前你认真回应我的那次', [recA], {
    limit: 3, maxChars: 900, isSent: () => true
  });
  assert.equal(blocked.count, 0, '默认仍去重');
});

test('R02 相关性收紧：宽泛共同字词不再命中弱相关记录', () => {
  const weak = { ...recA, text: '我心里不是滋味，不太认同这件事', topic: '冷馒头' };
  const out = SN.contextPart('你之前是不是觉得我太认真了', [weak], { limit: 3, maxChars: 900 });
  assert.equal(out.count, 0, '只有「是不是/之前/觉得」共同词，不应召回');
});

test('R03 suppressIds 临时抑制被纠正记录，不写任何数据', () => {
  const out = SN.contextPart('你记不记得之前你认真回应我的那次', [recA], {
    limit: 3, maxChars: 900, suppressIds: ['sn-a']
  });
  assert.equal(out.count, 0);
});

test('R04 源码守卫：自动整理模块不调用 AI、不建定时器、不直接改记录结构', () => {
  assert.equal(/setInterval|setTimeout/.test(SRC_AUTO), false, '不建常驻/定时器');
  assert.equal(/callAI\(/.test(SRC_AUTO), false, '本模块不直接发起 AI 请求');
  assert.equal(/SAVE|fetch\(/.test(SRC_AUTO), false);
});

/* ---------- 指定起点整理（from-id） ---------- */
test('D01 指定 afterId=2428 确实从 2428 之后读取，水位 80 跳到批末', async () => {
  const d = deps({ watermark: wm(80), nextAfterId: 2500 });
  const r = await AUTO.runAutoBatch({
    mode: 'from-id', afterId: 2428, limit: 80, maxAdopt: 3, maxChars: 12000
  }, d.d);
  assert.equal(r.mode, 'from-id');
  assert.deepEqual(r.requested, { afterId: 2428, limit: 80, maxAdopt: 3, maxChars: 12000 });
  assert.equal(d.d.reader.calls.length, 1);
  assert.equal(d.d.reader.calls[0].afterId, 2428, '读取起点必须是指定值，不是 watermark 80');
  assert.equal(d.d.reader.calls[0].limit, 80);
  assert.equal(d.d.reader.calls[0].maxChars, 12000);
  assert.equal(r.batch.afterId, 2428);
  assert.equal(r.batch.firstId, 11);
  assert.equal(r.batch.lastId, 12);
  assert.equal(r.batch.count, 2);
  assert.equal(r.ok, true);
  assert.equal(r.watermark.before, 80);
  assert.equal(r.watermark.after, 2500);
  assert.equal(r.watermark.touched, true);
  assert.equal(d.map.get(DR.WATERMARK_KEY).lastAfterId, 2500);
});

test('D02 指定起点缺 / 非法 afterId：直接拒绝，不读消息、不调 AI、不碰水位', async () => {
  for (const bad of [undefined, '', 'abc', 0, -1, 1.5, '2428x']) {
    const d = deps({ watermark: wm(80) });
    const r = await AUTO.runAutoBatch({ mode: 'from-id', afterId: bad }, d.d);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'missing-after-id');
    assert.equal(d.aiCalls.length, 0, '不能调用 AI');
    assert.equal(d.d.reader.calls.length, 0, '不能读取消息');
    assert.equal(d.map.get(DR.WATERMARK_KEY).lastAfterId, 80, '水位不动');
    assert.equal(d.map.has(SN.KEY), false, '不写正式记录');
  }
});

test('D03 普通增量按钮仍按原 watermark 工作', async () => {
  const d = deps({ watermark: wm(80), nextAfterId: 200 });
  const r = await AUTO.runAutoBatch({ limit: 80 }, d.d);
  assert.equal(r.mode, 'watermark');
  assert.equal(d.d.reader.calls[0].afterId, 80, '普通增量从水位继续');
  assert.equal(r.watermark.before, 80);
  assert.equal(r.watermark.after, 200);
});

test('D04 指定起点写入失败：水位保持 80，不推进', async () => {
  const d = deps({ watermark: wm(80), nextAfterId: 2500 });
  d.d.kvSet = async (k, v) => {
    if (k === SN.KEY) throw new Error('模拟写入失败');
    d.map.set(k, v);
  };
  const r = await AUTO.runAutoBatch({ mode: 'from-id', afterId: 2428 }, d.d);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'adopt-failed');
  assert.equal(r.adopt.failed.length, 1);
  assert.equal(r.watermark.touched, false);
  assert.equal(d.map.get(DR.WATERMARK_KEY).lastAfterId, 80);
});

test('D05 指定起点不覆盖已有机自述记录', async () => {
  const d = deps({ watermark: wm(80), nextAfterId: 2500 });
  const store = { get: async (k) => d.map.get(k), set: async (k, v) => { d.map.set(k, v); } };
  const keep = await SN.create(store, {
    id: 'sn-keep', text: '原有记录不能被覆盖', kind: 'impression', basis: 'stated',
    confidence: 'medium', source: { kind: 'chat', messageId: 1 }
  }, { now: T });
  assert.equal(keep.ok, true);
  const r = await AUTO.runAutoBatch({ mode: 'from-id', afterId: 2428 }, d.d);
  assert.equal(r.ok, true);
  const list = await SN.list(store, { status: 'all' });
  assert.equal(list.records.length, 2, '旧记录保留，新记录追加');
  const kept = list.records.find((x) => x.id === 'sn-keep');
  assert.equal(kept.text, '原有记录不能被覆盖');
  assert.equal(kept.history.length, 0, '旧记录未被改写');
});

test('D06 指定起点水位已在前方：不回退、不覆盖', async () => {
  const d = deps({ watermark: wm(2600), nextAfterId: 2500 });
  const r = await AUTO.runAutoBatch({ mode: 'from-id', afterId: 2428 }, d.d);
  assert.equal(r.ok, true);
  assert.equal(r.watermark.touched, false);
  assert.equal(r.watermark.after, 2600);
  assert.equal(d.map.get(DR.WATERMARK_KEY).lastAfterId, 2600);
  assert.ok(r.warnings.some((w) => w.indexOf('不会回退') >= 0 || w.indexOf('不回退') >= 0));
});

test('D07 指定起点水位落在批中：只前进到批末，不停滞也不回退', async () => {
  const d = deps({ watermark: wm(2450), nextAfterId: 2500 });
  const r = await AUTO.runAutoBatch({ mode: 'from-id', afterId: 2428 }, d.d);
  assert.equal(r.watermark.touched, true);
  assert.equal(r.watermark.after, 2500);
  assert.equal(d.map.get(DR.WATERMARK_KEY).lastAfterId, 2500);
});

test('D08 零条达标：指定起点推进水位，普通增量保持水位', async () => {
  const weak = JSON.stringify({ records: [{
    kind: 'inference', basis: 'inferred', confidence: 'low',
    text: '她好像不太喜欢被安排这件事', inferred: '被安排会让她不自在',
    confirmed: '', topic: '',
    evidence: [{ messageId: 11, quote: '她不喜欢别人替她做决定' }]
  }] });
  const a = deps({ watermark: wm(80), nextAfterId: 2500, aiText: weak });
  const ra = await AUTO.runAutoBatch({ mode: 'from-id', afterId: 2428 }, a.d);
  assert.equal(ra.ok, true);
  assert.equal(ra.reason, 'done-from-id-no-qualified');
  assert.equal(ra.adopt.succeeded, 0);
  assert.equal(ra.watermark.after, 2500);
  const b = deps({ watermark: wm(80), nextAfterId: 2500, aiText: weak });
  const rb = await AUTO.runAutoBatch({ limit: 80 }, b.d);
  assert.equal(rb.reason, 'no-qualified');
  assert.equal(rb.watermark.touched, false);
  assert.equal(b.map.get(DR.WATERMARK_KEY).lastAfterId, 80);
});

test('D10 未识别的 mode 直接拒绝，不静默退化成 watermark 增量', async () => {
  const d = deps({ watermark: wm(80) });
  const r = await AUTO.runAutoBatch({ mode: 'from_id', afterId: 2428 }, d.d);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid-mode');
  assert.equal(d.aiCalls.length, 0);
  assert.equal(d.d.reader.calls.length, 0);
  assert.equal(d.map.get(DR.WATERMARK_KEY).lastAfterId, 80);
});

test('D09 指定起点 maxAdopt 与 limit 独立：只限制写入，不限制读取', async () => {
  const three = JSON.stringify({ records: [0, 1, 2].map((i) => ({
    kind: 'impression', basis: 'stated', confidence: 'medium',
    text: '这是第' + i + '条足够长的认识内容用于通过门槛', observed: '她说了话',
    inferred: '', question: '', confirmed: '', topic: '',
    evidence: [{ messageId: 11, quote: '她不喜欢别人替她做决定' }]
  })) });
  const d = deps({ watermark: wm(80), nextAfterId: 2500, aiText: three });
  const r = await AUTO.runAutoBatch({ mode: 'from-id', afterId: 2428, limit: 80, maxAdopt: 1 }, d.d);
  assert.equal(d.d.reader.calls[0].limit, 80);
  assert.equal(r.auto.qualified, 1);
  assert.equal(r.auto.capped, 2);
  assert.equal(r.adopt.succeeded, 1);
  assert.equal(r.watermark.after, 2500);
});
