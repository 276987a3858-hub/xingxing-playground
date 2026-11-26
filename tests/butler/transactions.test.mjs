/* tests/butler/transactions.test.mjs — 记账仓储层测试 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRepository } from '../../public/butler/butler-repository.js';
import { createMemoryAdapter } from './memory-adapter.mjs';

async function fresh() {
  return createRepository(createMemoryAdapter({}));
}

test('T01 新增支出并读取', async () => {
  const repo = await fresh();
  const t = await repo.addTransaction({ type: 'expense', amount: 12.5, category: '餐饮', date: '2026-11-17', note: '午饭' });
  assert.ok(t.id && t.id.startsWith('tx_'));
  const rows = await repo.listTransactions();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, 12.5);
  assert.equal(rows[0].category, '餐饮');
});

test('T02 金额与日期校验', async () => {
  const repo = await fresh();
  await assert.rejects(() => repo.addTransaction({ type: 'expense', amount: 0, date: '2026-11-17' }), /金额/);
  await assert.rejects(() => repo.addTransaction({ type: 'expense', amount: -5, date: '2026-11-17' }), /金额/);
  await assert.rejects(() => repo.addTransaction({ type: 'expense', amount: 'abc', date: '2026-11-17' }), /金额/);
  await assert.rejects(() => repo.addTransaction({ type: 'expense', amount: 5, date: '2026-13-01' }), /日期/);
  await assert.rejects(() => repo.addTransaction({ type: 'expense', amount: 5, date: '2026-02-30' }), /日期/);
});

test('T03 非法分类回落为「其他」，非法类型回落为支出', async () => {
  const repo = await fresh();
  const t = await repo.addTransaction({ type: 'whatever', amount: 9, category: '超纲分类', date: '2026-11-17' });
  assert.equal(t.type, 'expense');
  assert.equal(t.category, '其他');
});

test('T04 收入分类池独立', async () => {
  const repo = await fresh();
  const t = await repo.addTransaction({ type: 'income', amount: 5000, category: '工资', date: '2026-11-01' });
  assert.equal(t.category, '工资');
  const t2 = await repo.addTransaction({ type: 'income', amount: 100, category: '餐饮', date: '2026-11-02' });
  assert.equal(t2.category, '其他'); // 餐饮不属于收入分类
});

test('T05 修改记录并保留历史', async () => {
  const repo = await fresh();
  const t = await repo.addTransaction({ type: 'expense', amount: 7, category: '餐饮', date: '2026-11-17', note: '午饭' });
  const next = await repo.updateTransaction(t.id, { amount: 8 });
  assert.equal(next.amount, 8);
  assert.ok(next.history.length >= 2);
  const hist = await repo.history(50);
  const txRows = hist.filter(h => h.group === '记账');
  assert.ok(txRows.length >= 2, '历史里应包含记账分组');
});

test('T06 删除记录', async () => {
  const repo = await fresh();
  const t = await repo.addTransaction({ type: 'expense', amount: 7, date: '2026-11-17' });
  await repo.removeTransaction(t.id);
  assert.equal((await repo.listTransactions()).length, 0);
});

test('T07 每日统计：只算区间内', async () => {
  const repo = await fresh();
  await repo.addTransaction({ type: 'expense', amount: 7, category: '餐饮', date: '2026-11-16' });
  await repo.addTransaction({ type: 'expense', amount: 20, category: '购物', date: '2026-11-17' });
  await repo.addTransaction({ type: 'expense', amount: 13.5, category: '交通', date: '2026-11-17' });
  await repo.addTransaction({ type: 'income', amount: 5000, category: '工资', date: '2026-11-17' });
  const s = await repo.txStats({ from: '2026-11-17', to: '2026-11-17' });
  assert.equal(s.expense, 33.5);
  assert.equal(s.income, 5000);
  assert.equal(s.byCategory['购物'], 20);
  assert.equal(s.byCategory['餐饮'], undefined);
});

test('T08 月度统计与跨月隔离', async () => {
  const repo = await fresh();
  await repo.addTransaction({ type: 'expense', amount: 100, category: '餐饮', date: '2026-10-31' });
  await repo.addTransaction({ type: 'expense', amount: 200, category: '餐饮', date: '2026-11-01' });
  await repo.addTransaction({ type: 'expense', amount: 50, category: '娱乐', date: '2026-11-30' });
  await repo.addTransaction({ type: 'expense', amount: 30, category: '日用', date: '2026-12-01' });
  const s = await repo.txStats({ from: '2026-11-01', to: '2026-11-31' });
  assert.equal(s.expense, 250);
  assert.deepEqual(s.byCategory, { '餐饮': 200, '娱乐': 50 });
});

test('T09 金额四舍五入到分', async () => {
  const repo = await fresh();
  await repo.addTransaction({ type: 'expense', amount: 0.1 + 0.2, category: '日用', date: '2026-11-17' });
  const s = await repo.txStats({ from: '2026-11-01', to: '2026-11-30' });
  assert.equal(s.expense, 0.3);
});

test('T10 同日多笔互不覆盖', async () => {
  const repo = await fresh();
  await repo.addTransaction({ type: 'expense', amount: 7, category: '餐饮', date: '2026-11-17', note: '早饭' });
  await repo.addTransaction({ type: 'expense', amount: 20, category: '餐饮', date: '2026-11-17', note: '午饭' });
  const rows = await repo.listTransactions();
  assert.equal(rows.length, 2);
});
