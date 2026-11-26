/* tests/butler/remind-delivery.test.mjs — 提醒「真的投递到聊天」的语义（纯虚构时间，不连真实库、不调 AI） */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRepository } from '../../public/butler/butler-repository.js';
import { createMemoryAdapter } from './memory-adapter.mjs';
import '../../public/butler/butler-intent.js';

const BI = globalThis.ButlerIntent;

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const D = '2026-11-17';
const at = (h, m, day = 17) => new Date(2026, 10, day, h, m, 0, 0).getTime();

async function fresh() {
  const repo = createRepository(createMemoryAdapter({}));
  BI._setRepository(repo);
  BI.clearPending();
  mem.clear();
  return repo;
}

test('Y01 「聊天里注入了提醒」不再永久吃掉这条提醒', async () => {
  const repo = await fresh();
  await repo.addTask({ title: '睡觉', date: D, time: '23:00', type: 'todo' });
  const ctx = await BI.remindContext(at(22, 50));
  assert.ok(ctx.includes('提醒她一次'), '进入窗口时应注入');
  // 请求失败 / 回复没提到 → 不确认 → 调度器仍能拿到这条候选
  const due = await BI.remindTick(at(23, 1), { commit: false });
  assert.equal(due.length, 1, '未被确认说出时必须仍可投递');
  assert.equal(due[0].title, '睡觉');
});

test('Y02 注入过的 key 可以取出来，用于「回复真的落库后」再标记已说出', async () => {
  const repo = await fresh();
  await repo.addTask({ title: '睡觉', date: D, time: '23:00', type: 'todo' });
  await BI.remindContext(at(22, 50));
  const keys = BI.takeContextKeys();
  assert.equal(keys.length, 1);
  assert.equal(BI.takeContextKeys().length, 0, '取过即清空，避免误记下一条');
  BI.markRemindDelivered(keys[0], at(22, 51));
  assert.equal((await BI.remindTick(at(22, 52), { commit: false })).length, 0, '确认说出后不再重复');
});

test('Y03 落库成功后标记投递：第二次 tick 不再产出', async () => {
  const repo = await fresh();
  await repo.addTask({ title: '睡觉', date: D, time: '23:00', type: 'todo' });
  const first = await BI.remindTick(at(22, 55), { commit: false });
  assert.equal(first.length, 1);
  BI.markRemindDelivered(first[0].key, at(22, 55));
  const second = await BI.remindTick(at(22, 56), { commit: false });
  assert.equal(second.length, 0);
});

test('Y04 未标记投递时（落库失败）下一轮仍能取到同一条', async () => {
  const repo = await fresh();
  await repo.addTask({ title: '睡觉', date: D, time: '23:00', type: 'todo' });
  const a = await BI.remindTick(at(22, 55), { commit: false });
  assert.equal(a.length, 1);
  // 模拟写库失败：不调用 markRemindDelivered
  const b = await BI.remindTick(at(22, 56), { commit: false });
  assert.equal(b.length, 1);
  assert.equal(b[0].key, a[0].key);
});

test('Y05 一次性待办只提醒一次：投递后即使跨过 23:00 也不再产出', async () => {
  const repo = await fresh();
  await repo.addTask({ title: '睡觉', date: D, time: '23:00', type: 'todo' });
  const first = await BI.remindTick(at(22, 50), { commit: false });
  BI.markRemindDelivered(first[0].key, at(22, 50));
  assert.equal((await BI.remindTick(at(23, 5), { commit: false })).length, 0);
  assert.equal((await BI.remindTick(at(23, 30), { commit: false })).length, 0);
});

test('Y06 完成 / 取消 / 延期的待办不投递', async () => {
  const repo = await fresh();
  const t = await repo.addTask({ title: '睡觉', date: D, time: '23:00', type: 'todo' });
  await repo.completeTask(t.id);
  assert.equal((await BI.remindTick(at(22, 55), { commit: false })).length, 0);

  const t2 = await repo.addTask({ title: '洗头', date: D, time: '23:00', type: 'todo' });
  await repo.cancelTask(t2.id);
  assert.equal((await BI.remindTick(at(22, 55), { commit: false })).length, 0);

  const t3 = await repo.addTask({ title: '读书', date: D, time: '23:00', type: 'todo' });
  await repo.deferTask(t3.id, { date: '2026-11-18', time: '23:00' });
  const out = await BI.remindTick(at(22, 55), { commit: false });
  assert.equal(out.length, 0, '延期到今天以外不再追');
});

test('Y07 过期超过 6 小时的提醒不会再补投（登记为不再打扰）', async () => {
  const repo = await fresh();
  await repo.addTask({ title: '睡觉', date: D, time: '23:00', type: 'todo' });
  assert.equal((await BI.remindTick(at(23, 59, 17), { commit: false })).length, 1, '当晚仍在窗口');
  const nextDay = new Date(2026, 10, 18, 6, 0, 0, 0).getTime();
  assert.equal((await BI.remindTick(nextDay, { commit: false })).length, 0, '跨天不追');
});

test('Y08 旧的 reminded 键不再作为硬门槛（历史遗留消费不再阻塞投递）', async () => {
  const repo = await fresh();
  const t = await repo.addTask({ title: '睡觉', date: D, time: '23:00', type: 'todo' });
  // 模拟旧版本 remindContext 写入的永久记录
  const ms = new Date(2026, 10, 17, 22, 50, 0, 0).getTime();
  mem.set('ylxh.butler.reminded', JSON.stringify([`${t.id}|${D}|${ms}`]));
  const due = await BI.remindTick(at(23, 2), { commit: false });
  assert.equal(due.length, 1, '旧键不得再吃掉提醒');
});
