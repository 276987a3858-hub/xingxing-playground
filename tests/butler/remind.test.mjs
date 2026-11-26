/* tests/butler/remind.test.mjs — 提前提醒 / 一次确认 / 分寸与时间上下文（纯本地，不调 AI） */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRepository } from '../../public/butler/butler-repository.js';
import { createMemoryAdapter } from './memory-adapter.mjs';
import '../../public/butler/butler-intent.js';

const BI = globalThis.ButlerIntent;

// localStorage 桩：验证「同一事项只提醒一次」
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const pad = (n) => String(n).padStart(2, '0');
const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = day(new Date());
const tomorrow = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return day(d); })();

// 现在 + n 分钟的 HH:MM；跨天时返回 null（避免午夜跑测试时误判）
function hhmmAfter(min) {
  const d = new Date(Date.now() + min * 60000);
  if (day(d) !== today) return null;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function fresh() {
  const repo = createRepository(createMemoryAdapter({}));
  BI._setRepository(repo);
  BI.clearPending();
  mem.clear();
  return repo;
}

test('R01 创建待办只保存一次，确认只由回复说一次（不额外追加）', async () => {
  const repo = await fresh();
  const reply = '<bl>{"op":"task_add","title":"洗小衣服","date":"today","time":"16:30"}</bl>记好了，四点半提醒你洗小衣服。 ||| Noted.';
  const display = await BI.handleAIResponse(reply, '下午四点半提醒我洗小衣服');
  const list = await repo.listTasks();
  assert.equal(list.length, 1, '只应保存一条待办');
  assert.equal(list[0].title, '洗小衣服');
  assert.ok(display.includes('记好了'), '确认话术保留');
  assert.ok(!display.includes('已经记在待办里了'), '不应再追加第二句确认');
  assert.ok(display.includes('|||'), '中英分隔不被破坏');
  const sys = BI.systemPrompt();
  assert.ok(sys.includes('只自然确认一次'), '提示词要求只确认一次');
  assert.ok(sys.includes('到点前 10 分钟'), '提示词说明提前 10 分钟提醒');
});

test('R01b 模型没确认时本地只补一句确认，不重复', async () => {
  const repo = await fresh();
  const display = await BI.handleAIResponse('<bl>{"op":"task_add","title":"买牛奶","date":"today","time":"18:00"}</bl>知道啦。 ||| Got it.', '六点提醒我买牛奶');
  assert.equal((await repo.listTasks()).length, 1);
  assert.equal((display.match(/记好了/g) || []).length, 1, '只补一次确认');
  assert.ok(display.includes('买牛奶'));
  assert.ok(!/记好了[\s\S]*记好了/.test(display));
});

test('R02 提前 10 分钟提醒，只触发一次', async () => {
  const repo = await fresh();
  const t = hhmmAfter(8); // 提醒时刻 = 现在 - 2 分钟
  if (!t) return;
  await repo.addTask({ title: '洗小衣服', date: today, time: t });
  const first = await BI.remindContext();
  assert.ok(first.includes('提醒她一次'), '进入提醒窗口应给提示');
  assert.ok(first.includes('洗小衣服'));
  assert.match(first, /距离 \d{2}:\d{2} 开始还有 \d+ 分钟/, '应说明离事项开始还有多久');
  assert.ok(first.includes('只说这一次'));
  assert.equal(await BI.remindContext(), '', '同一事项只提醒一次');
});

test('R03 没到提醒时刻，一点都不提前说', async () => {
  const repo = await fresh();
  const t = hhmmAfter(40); // 提醒时刻 = 现在 + 30 分钟
  if (!t) return;
  await repo.addTask({ title: '交作业', date: today, time: t });
  assert.equal(await BI.remindContext(), '');
});

test('R04 提醒过一次后，连续多轮聊天都不再重复', async () => {
  const repo = await fresh();
  const t = hhmmAfter(5);
  if (!t) return;
  await repo.addTask({ title: '晾衣服', date: today, time: t });
  assert.ok((await BI.remindContext()).includes('晾衣服'));
  for (let i = 0; i < 3; i++) assert.equal(await BI.remindContext(), '');
});

test('R05 已完成 / 已取消 / 已延期，都不再用旧提醒', async () => {
  const repo = await fresh();
  const t = hhmmAfter(5);
  if (!t) return;

  const done = await repo.addTask({ title: '交作业', date: today, time: t });
  await repo.completeTask(done.id);

  const cancelled = await repo.addTask({ title: '买牛奶', date: today, time: t });
  await repo.cancelTask(cancelled.id);

  const deferred = await repo.addTask({ title: '整理房间', date: today, time: t });
  await repo.deferTask(deferred.id, { date: tomorrow });

  assert.equal(await BI.remindContext(), '', '三件事都不该再提醒');
});

test('R06 改了时间，旧提醒状态不阻止新时间提醒', async () => {
  const repo = await fresh();
  const t1 = hhmmAfter(5);
  const t2 = hhmmAfter(8);
  if (!t1 || !t2) return;
  const task = await repo.addTask({ title: '洗小衣服', date: today, time: t1 });
  assert.ok((await BI.remindContext()).includes('洗小衣服'));
  await repo.updateTask(task.id, { time: t2 });
  const again = await BI.remindContext();
  assert.ok(again.includes('洗小衣服'), '改时间后新提醒应能触发');
  assert.ok(again.includes(t2), '提醒按新时间算');
});

test('R07 没有明确时间不生成提醒；用户设了提醒时间则按用户的', async () => {
  const repo = await fresh();
  await repo.addTask({ title: '随便想想', date: today, time: '' });
  assert.equal(await BI.remindContext(), '', '无明确时间不编造提醒时刻');

  await repo.addTask({ title: '吃药', date: today, time: '', remindAt: Date.now() - 60000 });
  const ctx = await BI.remindContext();
  assert.ok(ctx.includes('吃药'), '用户另设的提醒时间应生效');

  await repo.addTask({ title: '开会', date: today, time: '', remindAt: Date.now() + 30 * 60000 });
  const after = await BI.remindContext();
  assert.ok(!after.includes('开会'), '用户设的未来提醒时间不应提前触发');
});

test('R08 分享花销不唤醒记账（保留收紧的关键词）', () => {
  assert.equal(BI.gate('我今天买装备花了很多钱'), false);
  assert.equal(BI.gate('今天花费真高'), false);
  assert.equal(BI.gate('午饭花了7元'), true);
  assert.equal(BI.gate('帮我记一笔，打车15块'), true);
});

test('R09 能管教、也要收住：提示词同时具备两边', () => {
  const sys = BI.systemPrompt();
  assert.ok(sys.includes('训诫'), '保留训诫语气');
  assert.ok(sys.includes('说完就收'), '提醒说完就收住');
  assert.ok(sys.includes('不要要她汇报') || sys.includes('不要她汇报'), '不要求汇报');
  assert.ok(sys.includes('顺着她走') && sys.includes('不逼她按原计划'), '她累了/换话题时顺着她');
  assert.equal(BI.gate('我要去午休了'), false, '午休不当作待办指令');
  assert.equal(BI.gate('不聊这个了，陪我待会'), false, '转话题不唤醒待办');

  // 五层接入：基础人设来自 Persona.baseText()（旧【相处分寸】段已由一层「情绪与相处」取代）；
  // 管教/收住基调同时保留在生活管家 systemPrompt 与一层人设中，不得丢失。
  const app = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8');
  assert.ok(app.includes('window.Persona.baseText()'), '常驻基础人格来自 Persona 一层/二层');
  assert.ok(!app.includes('【相处分寸：可以管教，但不下死命令】'), '旧分寸段已停止重复注入');
  assert.ok(sys.includes('带一点训诫') && sys.includes('说完就收'), '允许训诫且应了就收（管家机制）');
  assert.ok(sys.includes('不要要她汇报') || sys.includes('不要她汇报'), '不要求汇报（管家机制）');
  assert.ok(app.includes('getNowBlock()'), '对话请求每次现取精确时间');
  assert.ok(!app.includes("blTimeAware ? getNowBlock()"), '精确时间不再受关键词门控');
  assert.ok(!app.includes('当前时间：${getNowContext()}'), '常驻提示词不再携带绝对时间');
});

test('R10 普通闲聊不注入精确时间，涉及时间才注入', () => {
  assert.equal(BI.needsClockContext('我喜欢你'), false);
  assert.equal(BI.needsClockContext('你今天怎么这么可爱'), true, '含"今天"属于时间相关');
  assert.equal(BI.needsClockContext('几点了'), true);
  assert.equal(BI.needsClockContext('提醒我洗衣服'), true);
  assert.equal(BI.needsClockContext('陪我待一会儿'), true, '含"一会儿"算时间相关');
  assert.equal(BI.needsClockContext('在吗'), false);
});
