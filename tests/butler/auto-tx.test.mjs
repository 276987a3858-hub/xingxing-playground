/* tests/butler/auto-tx.test.mjs — 自动记账链路回归测试（mock AI 回复 + 内存仓储，零 API 请求） */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRepository } from '../../public/butler/butler-repository.js';
import { createMemoryAdapter } from './memory-adapter.mjs';
import '../../public/butler/butler-intent.js';

const BI = globalThis.ButlerIntent;
const USER = '今天午饭吃的杨掌柜消费13元，晚饭月亮馍加煎蛋，消费5.5元';
const TODAY = BI.resolveDate('today');
const BASE = Date.now();

function fresh(overrides = {}) {
  const repo = createRepository(createMemoryAdapter({}));
  const wrapped = { ...repo, ...overrides };
  BI._setRepository(wrapped);
  BI._resetHandled();
  BI.clearPending();
  return { repo, wrapped };
}

function lunch() {
  return { op: 'tx_add', type: 'expense', amount: 13, category: '餐饮', date: 'today', note: '午饭杨掌柜' };
}
function dinner() {
  return { op: 'tx_add', type: 'expense', amount: 5.5, category: '餐饮', date: 'today', note: '晚饭月亮馍加煎蛋' };
}
const bl = (obj) => `<bl>${JSON.stringify(obj)}</bl>`;

test('A01 一条消息两个 <bl> 标记：两笔都写入，金额/日期/备注正确，JSON 不外泄', async () => {
  const { repo } = fresh();
  const raw = `${bl(lunch())}${bl(dinner())}两顿都记上了。 ||| Both logged.`;
  const out = await BI.handleAIResponse(raw, USER, BASE);
  const rows = await repo.listTransactions();
  assert.equal(rows.length, 2, '应写入两笔，不能只处理其中一笔');
  assert.ok(rows.some(r => r.amount === 13 && r.date === TODAY && r.note === '午饭杨掌柜' && r.type === 'expense'));
  assert.ok(rows.some(r => r.amount === 5.5 && r.date === TODAY && r.note === '晚饭月亮馍加煎蛋' && r.type === 'expense'));
  assert.ok(!out.includes('<bl>'), '回复不能带 <bl> 标记');
  assert.ok(!out.includes('"op"'), '回复不能暴露内部 JSON 操作指令');
});

test('A02 单个 <bl> 内 ops 数组：两笔都写入', async () => {
  const { repo } = fresh();
  const raw = `${bl({ ops: [lunch(), dinner()] })}两顿都记上了。 ||| Both logged.`;
  const out = await BI.handleAIResponse(raw, USER, BASE);
  const rows = await repo.listTransactions();
  assert.equal(rows.length, 2);
  assert.ok(rows.some(r => r.amount === 13));
  assert.ok(rows.some(r => r.amount === 5.5));
  assert.ok(!out.includes('"op"'));
});

test('A03 未闭合标记里的 tx_add：也能落库且内部 JSON 不外泄', async () => {
  const { repo } = fresh();
  const raw = `<bl>${JSON.stringify(dinner())}\n两顿都记上了。 ||| Both logged.`;
  const out = await BI.handleAIResponse(raw, USER, BASE);
  const rows = await repo.listTransactions();
  assert.equal(rows.length, 1, '晚饭应真实写入');
  assert.equal(rows[0].amount, 5.5);
  assert.ok(!out.includes('<bl>') && !out.includes('"op"'), '未闭合标记里的 JSON 也不能显示');
});

test('A04 数据库写入失败：不虚报成功，明确告知未写入', async () => {
  const { repo } = fresh({
    async addTransaction() { throw new Error('模拟写库失败'); },
  });
  const raw = `${bl(lunch())}${bl(dinner())}两顿都记上了。 ||| Both logged.`;
  const out = await BI.handleAIResponse(raw, USER, BASE);
  assert.equal((await repo.listTransactions()).length, 0);
  assert.ok(!/都记上了|Both logged/i.test(out), `失败时不能保留成功话术：${out}`);
  assert.match(out, /(失败|没记上|没有保存成功)/);
});

test('A05 部分写入失败：成功的照实确认，失败的明确报错，不出现两顿都记上', async () => {
  const base = createRepository(createMemoryAdapter({}));
  let n = 0;
  BI._setRepository({ ...base, async addTransaction(input) {
    if (++n === 2) throw new Error('模拟第二笔失败');
    return base.addTransaction(input);
  } });
  BI._resetHandled();
  BI.clearPending();
  const raw = `${bl(lunch())}${bl(dinner())}两顿都记上了。 ||| Both logged.`;
  const out = await BI.handleAIResponse(raw, USER, BASE);
  const zh = out.split('|||')[0];
  assert.ok(!/两顿都记上了/.test(zh), `不能虚报两顿都记上：${zh}`);
  assert.match(zh, /(午饭杨掌柜|¥13)/);
  assert.match(zh, /(失败|没记上|没有保存成功)/);
  assert.equal((await base.listTransactions()).length, 1);
});

test('A06 单笔消费回归：只记一笔', async () => {
  const { repo } = fresh();
  const raw = `${bl(lunch())}午饭 13 元记下了。 ||| Lunch logged.`;
  const out = await BI.handleAIResponse(raw, '今天午饭吃的杨掌柜消费13元', BASE);
  const rows = await repo.listTransactions();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, 13);
  assert.ok(!out.includes('<bl>'));
});

test('A07 普通聊天不误触发：零写入、回复原样', async () => {
  const { repo } = fresh();
  const raw = '今天天气真好，想出去走走。 ||| Nice day for a walk.';
  assert.equal(await BI.handleAIResponse(raw, '今天天气真好，想出去走走', BASE), raw);
  assert.equal((await repo.listTransactions()).length, 0);
});

test('A08 门控：用户案例命中，普通聊天放过', () => {
  assert.equal(BI.gate(USER), true);
  assert.equal(BI.gate('我觉得你像星星一样'), false);
});

test('A09 两笔中一笔缺金额：只写确定的那笔，不虚报两顿都记上', async () => {
  const { repo } = fresh();
  const noAmount = { op: 'tx_add', type: 'expense', category: '餐饮', date: 'today', note: '晚饭月亮馍加煎蛋' };
  const raw = `${bl(lunch())}${bl(noAmount)}两顿都记上了。 ||| Both logged.`;
  const out = await BI.handleAIResponse(raw, USER, BASE);
  const zh = out.split('|||')[0];
  assert.equal((await repo.listTransactions()).length, 1);
  assert.ok(!/两顿都记上了/.test(zh), `不能虚报：${zh}`);
  assert.match(zh, /(还差金额|没记上)/);
  assert.equal(BI.hasPending(), true);
  BI.clearPending();
});

test('A10 裸 JSON 指令不显示在聊天正文', async () => {
  const { repo } = fresh();
  const raw = '{"op":"tx_add","amount":7} 嗯。 ||| Hmm.';
  const out = await BI.handleAIResponse(raw, USER, BASE);
  assert.ok(!out.includes('"op"') && !out.includes('tx_add'), out);
  assert.equal((await repo.listTransactions()).length, 0);
});
