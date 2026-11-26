/* tests/shared/keeps-status-filter.test.mjs — 共同珍藏状态过滤（P0 最小修复）
 * 覆盖：
 *   1) saved 能进入聊天上下文注入；
 *   2) saved 能作为长期记忆生成的可信来源；
 *   3) waiting_star / waiting_user / rejected / rejected_by_user 均不进入上述两条链路；
 *   4) 被过滤的记录仍完整保留在原始数组中（不删、不改、不覆盖）；
 *   5) 旧记录（没有 status）保持兼容；未知状态按未确认处理；
 *   6) 珍藏状态机与珍藏管理页展示逻辑未被改动。
 * 纯 Node：不调 AI、不开浏览器、不碰真实数据库。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import '../../public/shared/persona-memory.js';
import '../../public/shared/long-term-memory-v2.js';
import '../../public/shared/memory-generator.js';

const PM = globalThis.PersonaMemory;
const V2 = globalThis.LongTermMemoryV2;
const G = globalThis.MemoryGenerator;

const APP = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8');
const PM_SRC = readFileSync(new URL('../../public/shared/persona-memory.js', import.meta.url), 'utf8');

const NOW = 1795000000000;
// 命中 KEEP_RE（"珍藏"）；recordPart 命中后才会进入筛选与匹配。
const ASK = '你还记得我们珍藏的那件事吗';
const PENDING = ['waiting_star', 'waiting_user', 'rejected', 'rejected_by_user'];

function keep(id, status, title, content) {
  const row = { id, title, content, by: '用户', createdAt: NOW - id * 1000 };
  if (status !== undefined) row.status = status;
  return row;
}

function snapshot(rows) {
  return JSON.parse(JSON.stringify(rows));
}

function adapter(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map, calls: [],
    async get(k) { return map.has(k) ? map.get(k) : undefined; },
    async set(k, v) { this.calls.push(k); map.set(k, v); },
  };
}

/* ---------- 1. 已确认：saved 正常进入聊天上下文 ---------- */
test('K01 saved 珍藏进入聊天上下文注入，并标注来源与「已收下」语义', () => {
  PM.reset();
  const rows = [keep(1, 'saved', '雨夜', '那天我们一起在窗边听雨')];
  const r = PM.recordPart(ASK, rows, 'keep');
  assert.ok(r.text.includes('共同珍藏'), '给出『共同珍藏』来源标题');
  assert.ok(r.text.includes('雨夜'), '标题进入片段');
  assert.ok(r.text.includes('那天我们一起在窗边听雨'), '正文进入片段');
  assert.ok(r.text.includes('她当时收下的一件特别的事'), '保留原有语气标注');
  assert.equal(r.keys.length, 1, '返回成功去重键');
});

/* ---------- 2. 未确认 / 已拒绝：四种状态全部排除 ---------- */
for (const status of PENDING) {
  test(`K02 ${status} 珍藏不进入聊天上下文注入`, () => {
    PM.reset();
    const rows = [keep(7, status, '还没定下来', '这件事双方都还没确认')];
    const r = PM.recordPart(ASK, rows, 'keep');
    assert.equal(r.keys.length, 0, '不返回去重键');
    assert.ok(!r.text.includes('还没定下来'), '标题未注入');
    assert.ok(!r.text.includes('这件事双方都还没确认'), '正文未注入');
    assert.ok(r.text.includes('没有找到'), '按「没有已确认记录」如实回答，不编造');
  });
}

/* ---------- 3. 混合数据：只放行 saved，其余原样留在数组里 ---------- */
test('K03 混合数组只注入 saved；其余状态既不注入也不被删除/改写', () => {
  PM.reset();
  const rows = [
    keep(1, 'saved', '已收录的事', '我们一起做过并且都同意留下的那件事'),
    keep(2, 'waiting_star', '等星星回应', '星星还没回应这段回忆'),
    keep(3, 'waiting_user', '等用户确认', '星星提议了但用户还没点头'),
    keep(4, 'rejected', '星星拒绝', '星星明确不想收录这段'),
    keep(5, 'rejected_by_user', '用户拒绝', '用户明确不想收录这段'),
  ];
  const before = snapshot(rows);
  const r = PM.recordPart(ASK, rows, 'keep');
  assert.ok(r.text.includes('已收录的事'), 'saved 正常注入');
  for (const body of ['星星还没回应这段回忆', '星星提议了但用户还没点头', '星星明确不想收录这段', '用户明确不想收录这段']) {
    assert.ok(!r.text.includes(body), '未确认/已拒绝的正文未注入：' + body);
  }
  assert.equal(r.keys.length, 1, '只返回 saved 的去重键');
  assert.deepEqual(rows, before, '原始珍藏数组完全未被修改');
  assert.equal(rows.length, 5, '被过滤的记录仍完整保留在原始数据中');
});

/* ---------- 4. 兼容：旧记录没有 status，仍按已收录对待 ---------- */
test('K04 旧记录（无 status）仍按已收录注入，避免历史珍藏突然消失', () => {
  PM.reset();
  const r = PM.recordPart(ASK, [keep(9, undefined, '旧珍藏', '很早以前留下的一段回忆')], 'keep');
  assert.ok(r.text.includes('旧珍藏'), '旧记录标题可注入');
  assert.ok(r.text.includes('很早以前留下的一段回忆'), '旧记录正文可注入');
  assert.equal(r.keys.length, 1);
  assert.equal(PM.keepIsConfirmed({ id: 9 }), true, '缺省 status 视为已收录');
  assert.equal(PM.keepIsConfirmed({ id: 9, status: '' }), true, '空字符串 status 同样兼容');
});

/* ---------- 5. 未知状态：安全侧，按未确认处理 ---------- */
test('K05 未知状态按未确认处理（宁可读不到，也不当成事实）', () => {
  PM.reset();
  assert.equal(PM.keepIsConfirmed({ id: 1, status: 'pending' }), false, '未知状态不算已确认');
  assert.equal(PM.keepIsConfirmed({ id: 1, status: 'archived' }), false, '未知状态不算已确认');
  const r = PM.recordPart(ASK, [keep(1, 'pending', '未定义状态', '我们还没确认的状态')], 'keep');
  assert.equal(r.keys.length, 0);
  assert.ok(!r.text.includes('我们还没确认的状态'));
});

/* ---------- 6. 筛选函数本身：返回新数组、不筛掉原始数据 ---------- */
test('K06 confirmedKeeps 返回新数组，不改动入参与原数组长度', () => {
  const rows = [
    keep(1, 'saved', 'A', 'a-content'),
    keep(2, 'waiting_user', 'B', 'b-content'),
    keep(3, undefined, 'C', 'c-content'),
  ];
  const before = snapshot(rows);
  const out = PM.confirmedKeeps(rows);
  assert.equal(out.length, 2, 'saved + 旧记录保留');
  assert.deepEqual(out.map(r => r.id), [1, 3]);
  assert.notEqual(out, rows, '返回新数组，不与原数组共享引用');
  assert.deepEqual(rows, before, '原数组未被修改');
  assert.deepEqual(PM.confirmedKeeps(null), [], '非数组入参安全返回空数组');
  assert.equal(PM.keepIsConfirmed(null), false, '空记录不算已确认');
});

/* ---------- 7. 长期记忆来源：saved 可用，其余不可用 ---------- */
test('K07 长期记忆提示词只列出已确认珍藏作为可用来源', () => {
  const rows = [
    keep(1, 'saved', '雨夜', '一起在窗边听雨'),
    keep(2, 'waiting_user', '待确认的事', '她还没点头的那件事'),
    keep(3, 'rejected_by_user', '被拒的事', '她拒绝收录的那件事'),
  ];
  const sources = {
    messages: [], diaries: [],
    keeps: PM.confirmedKeeps(rows).map(r => ({ id: r.id, content: r.content, title: r.title })),
  };
  const state = V2.parseLegacy('旧记忆原文。', { now: NOW });
  const prompt = G.buildPrompt({ state, sources, now: NOW });
  assert.ok(prompt.includes('keep:1'), 'saved 珍藏出现在【可用来源】');
  assert.ok(prompt.includes('一起在窗边听雨'), 'saved 正文可被引用');
  assert.ok(!prompt.includes('keep:2'), 'waiting_user 不在可用来源');
  assert.ok(!prompt.includes('keep:3'), 'rejected_by_user 不在可用来源');
  assert.ok(!prompt.includes('她还没点头的那件事'), '未确认正文未进入提示词');
  assert.ok(!prompt.includes('她拒绝收录的那件事'), '已拒绝正文未进入提示词');
});

/* ---------- 8. 生成器侧：未确认珍藏 ID 即使被 AI 编造也拒绝 ---------- */
test('K08 引用未确认珍藏 ID 被拒（unknown-source-id），saved 珍藏 ID 可正常采用', async () => {
  const rows = [
    keep(1, 'saved', '雨夜', '一起在窗边听雨'),
    keep(2, 'waiting_user', '待确认', '她还没确认这件事'),
  ];
  const keeps = PM.confirmedKeeps(rows).map(r => ({ id: r.id, content: r.content, title: r.title }));
  const sources = { messages: [], diaries: [], keeps };
  const opFor = (sid) => ({
    op: 'add', text: '她喜欢在雨夜听雨声。', category: 'event',
    sourceType: 'keep', sourceId: sid, evidence: '一起在窗边听雨', confidence: 'high', reason: ''
  });

  const bad = adapter({ [V2.LEGACY_KEY]: '旧记忆原文。' });
  const r1 = await G.run({ store: bad, ai: async () => JSON.stringify({ ops: [opFor('keep:2')] }), sources, now: NOW });
  assert.equal(r1.applied.length, 0, '未确认珍藏不能作为来源');
  assert.equal(r1.rejected[0].reason, 'unknown-source-id');
  const badState = bad.map.get(V2.V2_KEY);
  const badHasIt = !!badState && badState.entries.some(e => e.text === '她喜欢在雨夜听雨声。');
  assert.equal(badHasIt, false, '没有落库任何新条目');
  assert.equal(bad.map.get(V2.LEGACY_KEY), '旧记忆原文。', '旧记忆原文未被改动');

  const good = adapter({ [V2.LEGACY_KEY]: '旧记忆原文。' });
  const r2 = await G.run({ store: good, ai: async () => JSON.stringify({ ops: [opFor('keep:1')] }), sources, now: NOW });
  assert.equal(r2.applied.length, 1, 'saved 珍藏可正常作为来源');
  const added = good.map.get(V2.V2_KEY).entries.find(e => e.text === '她喜欢在雨夜听雨声。');
  assert.ok(added, '条目已落库');
  assert.equal(added.source.sourceId, '1', '来源指向真实的已确认珍藏');
  assert.equal(added.source.kind, 'keep');
});

/* ---------- 9. 接线检查：两个消费入口都传入过滤后的数据 ---------- */
test('K09 app.js 聊天注入与记忆来源两处都使用已确认过滤', () => {
  assert.ok(APP.includes("pm.recordPart(text, confirmedKeeps, 'keep')"),
    '聊天注入只传已确认的珍藏');
  assert.ok(/const confirmedKeeps = pm\.confirmedKeeps \? pm\.confirmedKeeps\(keeps\)/.test(APP),
    '注入点显式调用 confirmedKeeps');
  assert.ok(/const confirmed = PM && PM\.confirmedKeeps \? PM\.confirmedKeeps\(k\)/.test(APP),
    '长期记忆来源点同样调用 confirmedKeeps');
  assert.ok(APP.includes('sources.keeps = confirmed.map'),
    '来源数组由过滤结果构造');
  assert.ok(!/sources\.keeps = \(k \|\| \[\]\)\.map/.test(APP),
    '旧的未过滤写法已不存在');
});

/* ---------- 10. 管理界面与状态机：展示全部记录、写入逻辑未改 ---------- */
test('K10 珍藏管理页仍展示全部状态，状态机写入逻辑未被改动', () => {
  assert.ok(/records\.forEach\(record =>/.test(APP), '管理页遍历全部记录');
  assert.ok(/const savedKeeps = records\.filter\(k => k\.status === 'saved'\)/.test(APP),
    'saved 过滤只用于摘要缓存，不影响列表');
  assert.ok(/labels = \{ saved: '✨ 已收录', waiting_star: '等待星星回应', waiting_user: '等待用户确认', rejected: '星星暂不收录', rejected_by_user: '用户暂不收录' \}/.test(APP),
    '五种状态文案原样保留');
  assert.ok(/confirmKeep/.test(APP) && /status: 'saved', confirmedAt/.test(APP), '确认流程保留');
  assert.ok(/status: 'rejected_by_user', rejectedAt/.test(APP), '拒绝流程保留');
  assert.ok(/status: nextStatus/.test(APP), '星星回应后的状态流转保留');
  assert.equal(/indexedDB|updateStore|addToStore/.test(PM_SRC), false,
    'persona-memory.js 只做判断，不写任何数据库');
});
