/* tests/butler/title.test.mjs — 事项标题提取（时间在前 / 时间在后 / 绝对时间）与无标记兜底（离线，不调 AI） */
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

const pad = (n) => String(n).padStart(2, '0');

async function fresh() {
  const repo = createRepository(createMemoryAdapter({}));
  BI._setRepository(repo);
  BI.clearPending();
  mem.clear();
  return repo;
}

test('T01 五种语序的标题提取', () => {
  const cases = [
    ['提醒我十五分钟后午休', '午休'],
    ['提醒我十五分钟后去午休', '午休'],
    ['十五分钟后提醒我午休', '午休'],
    ['提醒我去午休，十五分钟后吧', '午休'],
    ['提醒我晚上八点给爸爸打电话', '给爸爸打电话'],
  ];
  for (const [text, want] of cases) assert.equal(BI.reminderTitleFrom(text), want, text);
});

test('T02 不误删事项；纯时间输入才返回空', () => {
  assert.equal(BI.reminderTitleFrom('提醒我半个小时后出门'), '出门');
  assert.equal(BI.reminderTitleFrom('提醒我2小时后吃药'), '吃药');
  assert.equal(BI.reminderTitleFrom('提醒我十五分钟后'), '', '只有时间、没有事项');
});

test('T03 无标记兜底：时间在前也能建待办', async () => {
  const repo = await fresh();
  const base = new Date(Date.now() + 60 * 60000);        // 基准：一小时后，避免跨天干扰
  const display = await BI.handleAIResponse('好，十五分钟后叫你。 ||| ok', '提醒我十五分钟后午休', base.getTime());
  const list = await repo.listTasks();
  assert.equal(list.length, 1, '必须真的写入');
  assert.equal(list[0].title, '午休');
  const expect = new Date(base.getTime() + 15 * 60000);
  assert.equal(list[0].time, `${pad(expect.getHours())}:${pad(expect.getMinutes())}`);
  assert.ok(!/（记好了/.test(display));
});

test('T04 有标记路径不受影响（绝对时间）', async () => {
  const repo = await fresh();
  await BI.handleAIResponse('<bl>{"op":"task_add","title":"给爸爸打电话","date":"today","time":"20:00"}</bl>好。 ||| ok', '提醒我晚上八点给爸爸打电话');
  const list = await repo.listTasks();
  assert.equal(list.length, 1);
  assert.equal(list[0].title, '给爸爸打电话');
  assert.equal(list[0].time, '20:00');
});
