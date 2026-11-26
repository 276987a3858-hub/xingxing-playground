/* tests/butler/absolute.test.mjs — 绝对时间待办（口头答应但没写库的兜底）与时间基准（不调 AI） */
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
const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = day(new Date());
const tomorrow = day(new Date(Date.now() + 86400000));

async function fresh(adapterOverride) {
  const repo = createRepository(adapterOverride || createMemoryAdapter({}));
  BI._setRepository(repo);
  BI.clearPending();
  mem.clear();
  return repo;
}

/* ---------------- 1. 绝对时间解析本身 ---------------- */

test('A01 「两点十分」解析为 14:10（不是 02:00）', () => {
  assert.equal(BI.parseTimeToken('两点十分'), '02:10', '无时段时按 2:10，时段交给 applyPeriod');
  const base = new Date(); base.setHours(8, 0, 0, 0);
  assert.deepEqual(BI.absoluteTarget('下午两点十分提醒我洗衣服', base.getTime()), { date: today, time: '14:10' });
  assert.deepEqual(BI.absoluteTarget('提醒我两点十分去午休', base.getTime()), { date: today, time: '14:10' }, '午休 → 下午');
});

/* ---------------- 2. 模型漏 <bl> 时的绝对时间兜底 ---------------- */

const CASES = [
  ['提醒我两点十分去午休', '午休', '14:10', today],
  ['不玩啦，下午两点十分提醒我洗衣服', '洗衣服', '14:10', today],
  ['明天上午九点提醒我起床', '起床', '09:00', tomorrow],
];

for (const [text, title, time, date] of CASES) {
  test(`A02 漏标记兜底：${text} → ${title} ${time}`, async () => {
    const repo = await fresh();
    // 基准时间固定为今天 08:00，避免「已过点顺延到明天」影响断言
    const base = new Date(); base.setHours(8, 0, 0, 0);
    const display = await BI.handleAIResponse('行，我记着了。 ||| Okay.', text, base.getTime());
    const list = await repo.listTasks();
    assert.equal(list.length, 1, '没有标记也必须落库');
    assert.equal(list[0].title, title);
    assert.equal(list[0].time, time);
    assert.equal(list[0].date, date);
    assert.ok(!/（记好了/.test(display), '模型已自然确认过，不再贴括号式内部文案');
    assert.ok(!display.includes('<bl>'));
  });
}

test('A03 有标记时正常执行，不重复建两条', async () => {
  const repo = await fresh();
  const reply = '<bl>{"op":"task_add","title":"午休","date":"today","time":"14:10"}</bl>行，两点十分叫你。 ||| ok';
  await BI.handleAIResponse(reply, '提醒我两点十分去午休');
  const list = await repo.listTasks();
  assert.equal(list.length, 1, '标记路径不得再触发本地兜底');
  assert.equal(list[0].time, '14:10');
});

test('A04 写入失败时明确说没设置，不得假装已设', async () => {
  const repo = await fresh();
  BI._setRepository({ ...repo, addTask: async () => { throw new Error('磁盘写入失败'); } });
  const display = await BI.handleAIResponse('行，两点十分叫你。 ||| ok', '提醒我两点十分去午休');
  assert.ok(display.includes('没记上'));
  assert.ok(!display.includes('记好了'));
});

test('A05 没有具体钟点时不硬造待办、不追加假确认', async () => {
  const repo = await fresh();
  const display = await BI.handleAIResponse('好，我记着。 ||| ok', '提醒我下午洗衣服');
  assert.equal((await repo.listTasks()).length, 0);
  assert.ok(!display.includes('记好了'));
});

test('A05b 「一点小事」不是钟点，不生成 01:00 的假待办', async () => {
  const repo = await fresh();
  await BI.handleAIResponse('嗯，我听着。 ||| ok', '提醒我一点小事');
  assert.equal((await repo.listTasks()).length, 0);
  assert.equal(BI.absoluteTarget('提醒我一点小事'), null);
});

/* ---------------- 3. 相对时间以「收到消息」为基准 ---------------- */

test('A06 相对时间以收到消息的时间为基准，而不是 AI 回复完成时', async () => {
  const base = Date.now() - 30 * 60000;        // 消息是 30 分钟前发的
  const rt = BI.relativeTarget('十五分钟后提醒我喝水', base);
  const expect = new Date(base + 15 * 60000);
  assert.equal(rt.time, `${pad(expect.getHours())}:${pad(expect.getMinutes())}`);

  const repo = await fresh();
  await BI.handleAIResponse('好，十五分钟后叫你。 ||| ok', '十五分钟后提醒我喝水', base);
  const t = (await repo.listTasks())[0];
  assert.equal(t.time, rt.time, '落库时间按发消息那一刻算，不按回复完成时刻');
});

test('A07 兜底建好的事项仍走「提前 10 分钟、一次」提醒', async () => {
  const repo = await fresh();
  const soon = new Date(Date.now() + 20 * 60000);
  await BI.handleAIResponse('行，我叫你。 ||| ok', `提醒我${soon.getHours()}点${soon.getMinutes()}分去午休`);
  const t = (await repo.listTasks())[0];
  assert.ok(t, '必须落库');
  const ms = BI.reminderMs(t);
  const taskMs = new Date(`${t.date}T${t.time}:00`).getTime();
  assert.equal(taskMs - ms, 10 * 60000);
  assert.ok(repo);
});
