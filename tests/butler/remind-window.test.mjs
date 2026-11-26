/* tests/butler/remind-window.test.mjs — 提醒触发时刻与文案必须同一基准（纯虚构时间，不连真实库） */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRepository } from '../../public/butler/butler-repository.js';
import { createMemoryAdapter } from './memory-adapter.mjs';
import '../../public/butler/butler-intent.js';

const BI = globalThis.ButlerIntent;

// localStorage 桩：提醒去重表
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

// 虚构日期：2026-11-17，所有用例显式传 nowMs，不依赖运行时的真实钟点
const D = '2026-11-17';
const at = (h, m, day = 17) => new Date(2026, 10, day, h, m, 0, 0).getTime();

async function fresh() {
  const repo = createRepository(createMemoryAdapter({}));
  BI._setRepository(repo);
  BI.clearPending();
  mem.clear();
  return repo;
}

async function addWash(repo, { time = '19:30', date = D, remindAt = null } = {}) {
  return repo.addTask({ title: '洗头', date, time, type: 'todo', remindAt });
}

test('X01 19:30 的事项在 18:45 不提醒（发消息不就等于到点）', async () => {
  const repo = await fresh();
  await addWash(repo);
  assert.equal(await BI.remindContext(at(18, 45)), '', '提前 45 分钟不得注入提醒');
});

test('X02 19:30 的事项在 19:20 提醒，剩余时间 = 距事项开始 10 分钟', async () => {
  const repo = await fresh();
  await addWash(repo);
  const out = await BI.remindContext(at(19, 20));
  assert.ok(out.includes('提醒她一次'), '进入提醒窗口');
  assert.match(out, /距离 19:30 开始还有 10 分钟/, '剩余时间按事项时间算');
  assert.match(out, /提醒时刻 19:20 已到/, '提醒时刻与事项时间分开写');
  assert.ok(!/19:30 到点，就是现在/.test(out), '未到点不得给出到点文案');
});

test('X03 19:30 的事项在 19:30 进入到点状态', async () => {
  const repo = await fresh();
  await addWash(repo);
  const out = await BI.remindContext(at(19, 30));
  assert.match(out, /19:30 到点，就是现在/);
});

test('X04 用 remindAt 时按 remindAt 触发，剩余时间仍是距事项开始，且 15 分钟外不催', async () => {
  const repo = await fresh();
  await addWash(repo, { remindAt: at(19, 0) });
  assert.equal(await BI.remindContext(at(19, 0)), '', '离事项还有 30 分钟：不注入催促式提醒');
  const out = await BI.remindContext(at(19, 16));
  assert.match(out, /距离 19:30 开始还有 14 分钟/, '剩余时间正确（不是 305 分钟那种错值）');
  assert.match(out, /是她自己定的/, '标明这是她设的提醒时刻');
  assert.ok(!/\b30\d 分钟/.test(out), '不得出现按错基准算出的巨大剩余分钟');
});

test('X05 已提醒过的事项在后续普通轮次不再注入', async () => {
  const repo = await fresh();
  await addWash(repo);
  const first = await BI.remindContext(at(19, 20));
  assert.ok(first.length > 0);
  assert.equal(await BI.remindContext(at(19, 21)), '', '1 分钟后不重复');
  assert.equal(await BI.remindContext(at(19, 30)), '', '到点后也不重复');
});

test('X06 deferTask 改时间会清空旧 remindAt', async () => {
  const repo = await fresh();
  const t = await addWash(repo, { remindAt: at(18, 45) });
  const next = await repo.deferTask(t.id, { date: D, time: '20:30' });
  assert.equal(next.remindAt, null, '旧提醒时刻必须作废');
  assert.equal(next.time, '20:30');
});

test('X07 延期后旧提醒不再生效，新时间仍能提前 10 分钟提醒', async () => {
  const repo = await fresh();
  const t = await addWash(repo, { remindAt: at(18, 45) });
  await repo.deferTask(t.id, { date: D, time: '20:30' });
  assert.equal(await BI.remindContext(at(18, 45)), '', '旧提醒时刻不触发');
  assert.equal(await BI.remindContext(at(19, 20)), '', '原事项时刻也不触发（已改到 20:30）');
  const out = await BI.remindContext(at(20, 20));
  assert.match(out, /距离 20:30 开始还有 10 分钟/, '按新时间提前 10 分钟提醒');
});

test('X08 已完成 / 已取消的事项不触发旧提醒', async () => {
  const repo = await fresh();
  const done = await addWash(repo);
  await repo.completeTask(done.id);
  assert.equal(await BI.remindContext(at(19, 20)), '', '已完成不提醒');

  const repo2 = await fresh();
  const cancelled = await addWash(repo2);
  await repo2.cancelTask(cancelled.id);
  assert.equal(await BI.remindContext(at(19, 20)), '', '已取消不提醒');
});

test('X09 没有时间的待办不生成提醒；超过 6 小时的过期提醒不补', async () => {
  const repo = await fresh();
  await repo.addTask({ title: '整理桌面', date: D, type: 'todo' });
  assert.equal(await BI.remindContext(at(19, 20)), '', '无时间不提醒');

  const repo2 = await fresh();
  await repo2.addTask({ title: '吃早饭', date: D, time: '08:00', type: 'todo' });
  assert.equal(await BI.remindContext(at(15, 0)), '', '提醒时刻已过 7 小时：不翻旧账');
});

test('X10 updateTask 只改文案不动时间时保留 remindAt，改时间则清空', async () => {
  const repo = await fresh();
  const t = await addWash(repo, { remindAt: at(19, 0) });

  const kept = await repo.updateTask(t.id, { note: '用新买的洗发水' });
  assert.equal(kept.remindAt, at(19, 0), '没改时间：提醒保留');

  const cleared = await repo.updateTask(t.id, { time: '21:00' });
  assert.equal(cleared.remindAt, null, '改了时间：旧提醒作废');

  const explicit = await repo.updateTask(t.id, { time: '21:30', remindAt: at(21, 25) });
  assert.equal(explicit.remindAt, at(21, 25), '这次明确给了新的提醒时刻：尊重用户设置');
});

test('X11 提醒块自带"不是当前时间"的护栏，且声明只说一次', async () => {
  const repo = await fresh();
  await addWash(repo);
  const out = await BI.remindContext(at(19, 20));
  assert.match(out, /都不是当前时间/, '不允许把事项时间当作当前时间');
  assert.match(out, /只说这一次/, '一次即收，不反复催');
  assert.match(out, /现在是 19:20/, '当前时间只给真实当前时间');
});

/* ---------------- P5.2：提醒真正投递到聊天（0 次 AI、一次性、失败可重试） ---------------- */

async function addSleep(repo, { date = D } = {}) {
  return repo.addTask({ title: '睡觉', date, time: '23:00', type: 'todo', remindAt: null });
}

test('X10 23:00 睡觉待办在 22:50 到期，且返回可投递的聊天文案', async () => {
  const repo = await fresh();
  await addSleep(repo);
  const due = await BI.remindTick(at(22, 50), { commit: false });
  assert.equal(due.length, 1);
  assert.match(due[0].text, /23:00 还有 10 分钟/);
  assert.match(due[0].text, /睡觉/);
  assert.match(due[0].text, /别熬/, '睡觉类事项给出休息提示');
  assert.equal(due[0].title, '睡觉');
});

test('X11 commit:false 不消费提醒（落库失败可重试），成功后只发一次', async () => {
  const repo = await fresh();
  await addSleep(repo);
  const a = await BI.remindTick(at(22, 50), { commit: false });
  const b = await BI.remindTick(at(22, 51), { commit: false });
  assert.equal(a.length, 1);
  assert.equal(b.length, 1, '未提交前仍可再次取到（模拟写库失败重试）');

  BI.markRemindDelivered(b[0].key, at(22, 51));
  const c = await BI.remindTick(at(22, 52), { commit: false });
  assert.equal(c.length, 0, '成功投递后同一条不再返回');
  assert.equal(await BI.remindContext(at(22, 53)), '', '之后普通聊天也不重复播报');
});

test('X12 只当天到期，不会变成每天重复提醒', async () => {
  const repo = await fresh();
  await addSleep(repo);
  assert.equal((await BI.remindTick(new Date(2026, 10, 18, 22, 50).getTime(), { commit: false })).length, 0, '次日不再提醒');
  assert.equal((await BI.remindTick(new Date(2026, 10, 16, 22, 50).getTime(), { commit: false })).length, 0, '前一天不提醒');
});

test('X13 已完成/已取消的待办不再投递', async () => {
  const repo = await fresh();
  const t = await addSleep(repo);
  await repo.completeTask(t.id);
  assert.equal((await BI.remindTick(at(22, 50), { commit: false })).length, 0);
});
