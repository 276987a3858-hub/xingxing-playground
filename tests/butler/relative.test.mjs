/* tests/butler/relative.test.mjs — 「提醒我去午休，十五分钟后吧」这条链路的精确测试（不调 AI） */
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

// 现在 + n 分钟 → { date, time }
function expectAfter(min) {
  const d = new Date(Date.now() + min * 60000);
  return { date: day(d), time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}

async function fresh(adapterOverride) {
  const repo = createRepository(adapterOverride || createMemoryAdapter({}));
  BI._setRepository(repo);
  BI.clearPending();
  mem.clear();
  return repo;
}

const USER = '不玩啦，提醒我去午休，十五分钟后吧。';

test('L01 这条消息命中待办门控（会带上待办提示块）', () => {
  assert.equal(BI.gate(USER), true);
});

test('L02 相对时间解析：十五分钟后 / 半小时后 / 两个小时后', () => {
  assert.equal(BI.parseRelativeOffset('十五分钟后吧'), 15);
  assert.equal(BI.parseRelativeOffset('半个小时之后'), 30);
  assert.equal(BI.parseRelativeOffset('2小时后'), 120);
  assert.equal(BI.parseRelativeOffset('再过二十分钟'), 20);
  assert.equal(BI.parseRelativeOffset('一会儿'), null, '模糊时间不硬猜');
  const rt = BI.relativeTarget(USER);
  assert.deepEqual({ date: rt.date, time: rt.time }, expectAfter(15));
});

test('L03 模型输出了 task_add 但没写 time → 按 15 分钟后落库', async () => {
  const repo = await fresh();
  const reply = '<bl>{"op":"task_add","title":"午休","date":"today"}</bl>行，十五分钟后我叫你。现在去躺好。 ||| Okay.';
  const display = await BI.handleAIResponse(reply, USER);
  const list = await repo.listTasks();
  assert.equal(list.length, 1, '必须真的写入一条待办');
  assert.equal(list[0].title, '午休');
  assert.equal(list[0].time, expectAfter(15).time);
  assert.equal(list[0].date, expectAfter(15).date);
  assert.ok(display.includes('行，十五分钟后我叫你'), '保留模型原话');
  assert.ok(!display.includes('<bl>'), '标记必须被剥离');
});

test('L04 模型把 time 写成 "15分钟后" → 归一化为具体时刻', async () => {
  const repo = await fresh();
  await BI.handleAIResponse('<bl>{"op":"task_add","title":"午休","time":"15分钟后"}</bl>去躺好。 ||| ok', USER);
  const list = await repo.listTasks();
  assert.equal(list.length, 1);
  assert.equal(list[0].time, expectAfter(15).time);
});

test('L05 模型完全没输出标记 → 本地兜底建待办，不能只口头答应', async () => {
  const repo = await fresh();
  const reply = '行，十五分钟后我叫你。现在去躺好。 ||| sleeping in fifteen.';
  const display = await BI.handleAIResponse(reply, USER);
  const list = await repo.listTasks();
  assert.equal(list.length, 1, '没有标记也必须落库');
  assert.equal(list[0].title, '午休', '事项名从「提醒我去午休」里取');
  assert.equal(list[0].time, expectAfter(15).time);
  assert.ok(!/（记好了/.test(display), '不再贴括号式内部文案（模型已自然确认）');
  assert.ok(display.includes('|||'), '中英结构不被破坏');
});

test('L06 写入失败时明确说没设置成功，不能假装已设', async () => {
  const adapter = createMemoryAdapter({});
  const repo = await fresh(adapter);
  // 让写入必定失败
  const badRepo = {
    ...repo,
    addTask: async () => { throw new Error('磁盘写入失败'); },
  };
  BI._setRepository(badRepo);
  const display = await BI.handleAIResponse('行，十五分钟后我叫你。 ||| ok', USER);
  assert.ok(display.includes('没记上'), '必须明确告知失败');
  assert.ok(display.includes('没有设置提醒'), '说明这件事没设置成');
  assert.ok(!display.includes('记好了'), '失败时不得出现成功话术');
});

test('L07 只有相对时间、没有事项名时不硬造待办', async () => {
  const repo = await fresh();
  const display = await BI.handleAIResponse('好，我记着。 ||| ok', '十五分钟后提醒我');
  assert.equal((await repo.listTasks()).length, 0, '事项名不明确时不写库');
  assert.ok(display.includes('我记着'), '原话保留，不追加假确认');
});

test('L08 建好的待办仍走「提前 10 分钟、一次」的提醒规则', async () => {
  const repo = await fresh();
  await BI.handleAIResponse('<bl>{"op":"task_add","title":"午休","time":"15分钟后"}</bl>去躺好。 ||| ok', USER);
  const list = await repo.listTasks();
  const t = list[0];
  const ms = BI.reminderMs(t);
  const taskMs = new Date(`${t.date}T${t.time}:00`).getTime();
  assert.equal(taskMs - ms, 10 * 60000, '提醒时刻 = 事项时间 - 10 分钟');
  const soon = ms - Date.now();
  assert.ok(soon > 0, '此刻还没到提醒时刻');
  assert.equal(await BI.remindContext(), '', '未到提醒时刻不注入提醒');
  assert.equal(today, t.date);
  assert.ok(repo);
});
