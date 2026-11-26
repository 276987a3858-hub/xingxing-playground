/* tests/butler/intent.test.mjs — 聊天意图桥接层测试（注入内存仓储，不依赖浏览器/AI） */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRepository } from '../../public/butler/butler-repository.js';
import { createMemoryAdapter } from './memory-adapter.mjs';
import '../../public/butler/butler-intent.js';

const BI = globalThis.ButlerIntent;

async function fresh() {
  const repo = createRepository(createMemoryAdapter({}));
  BI._setRepository(repo);
  return repo;
}

/* ---- 门控 ---- */
test('I01 门控：记账/待办关键词命中，普通闲聊不命中', () => {
  assert.equal(BI.gate('午饭花了7元'), true);
  assert.equal(BI.gate('明天提醒我买牛奶'), true);
  assert.equal(BI.gate('今天花了多少钱'), true);
  assert.equal(BI.gate('买牛奶改到周五'), true);
  assert.equal(BI.gate('这个月餐饮花了多少'), true);
  assert.equal(BI.gate('今天天气真好，想出去走走'), false);
  assert.equal(BI.gate('我觉得你像星星一样'), false);
  assert.equal(BI.gate('昨晚的梦好奇怪'), false);
});

/* ---- 日期解析 ---- */
test('I02 相对日期解析', () => {
  const today = BI.resolveDate('today');
  assert.equal(BI.resolveDate('今天'), today);
  assert.equal(BI.resolveDate('明天'), BI.resolveDate('tomorrow'));
  assert.equal(BI.resolveDate('昨天'), BI.resolveDate('yesterday'));
  assert.equal(BI.resolveDate('2026-11-17'), '2026-11-17');
  assert.equal(BI.resolveDate('2026-11-7'), '2026-11-07');
  assert.equal(BI.resolveDate('11-17'), '2026-11-17');
  assert.equal(BI.resolveDate('随便说'), null);
});

test('I03 周X/下周X 解析落在合理范围', () => {
  const d = BI.resolveDate('周三');
  assert.ok(d, '周X 应能解析');
  const next = BI.resolveDate('下周三');
  assert.ok(next);
  const diffDays = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);
  const off = diffDays(BI.resolveDate('today'), d);
  assert.ok(off >= 0 && off <= 6, `本周偏移应在 0-6 天，实际 ${off}`);
  const offNext = diffDays(BI.resolveDate('today'), next);
  assert.ok(offNext >= 1 && offNext <= 13, `下周偏移应在 1-13 天，实际 ${offNext}`);
});

/* ---- 本地高置信查询 ---- */
test('I04 本地查询：今天花了多少钱（0 AI）', async () => {
  const repo = await fresh();
  await repo.addTransaction({ type: 'expense', amount: 7, category: '餐饮', date: BI.resolveDate('today'), note: '午饭' });
  const r = await BI.tryLocal('今天花了多少钱？');
  assert.equal(r.handled, true);
  assert.match(r.reply, /¥7/);
});

test('I05 本地查询：这个月餐饮一共花了多少', async () => {
  const repo = await fresh();
  const today = BI.resolveDate('today');
  await repo.addTransaction({ type: 'expense', amount: 20, category: '餐饮', date: today, note: '水果' });
  await repo.addTransaction({ type: 'expense', amount: 5, category: '交通', date: today });
  const r = await BI.tryLocal('这个月餐饮一共花了多少？');
  assert.equal(r.handled, true);
  assert.match(r.reply, /餐饮一共花了 ¥20/);
});

test('I06 本地查询：明天有什么安排', async () => {
  const repo = await fresh();
  const tm = BI.resolveDate('tomorrow');
  await repo.addTask({ title: '交作业', date: tm, type: 'todo' });
  const r = await BI.tryLocal('明天有什么安排');
  assert.equal(r.handled, true);
  assert.match(r.reply, /交作业/);
});

test('I07 非固定句式不触发本地查询', async () => {
  await fresh();
  const r = await BI.tryLocal('我今天心情不太好，想花钱买点开心的');
  assert.equal(r.handled, false);
  const r2 = await BI.tryLocal('花了7元');
  assert.equal(r2.handled, false);
});

/* ---- AI 标记处理：记账 ---- */
test('I08 tx_add 标记：执行并剥离标记', async () => {
  const repo = await fresh();
  const raw = '<bl>{"op":"tx_add","type":"expense","amount":7,"category":"餐饮","date":"today","note":"午饭"}</bl>好，午饭 7 块记下了。 ||| Okay, lunch logged, 7 yuan.';
  const out = await BI.handleAIResponse(raw);
  assert.ok(!out.includes('<bl>'), '标记应被剥离');
  assert.match(out, /午饭 7 块记下了/);
  assert.match(out, /\|\|\|/);
  const rows = await repo.listTransactions();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, 7);
  assert.equal(rows[0].category, '餐饮');
  assert.equal(rows[0].note, '午饭');
});

test('I09 tx_add 金额缺失：不写库并提示（转为临时上下文，等补充）', async () => {
  const repo = await fresh();
  const raw = '<bl>{"op":"tx_add","type":"expense","category":"餐饮","note":"午饭"}</bl>嗯。 ||| Hmm.';
  const out = await BI.handleAIResponse(raw);
  assert.match(out, /多少钱/);
  assert.equal((await repo.listTransactions()).length, 0);
  assert.equal(BI.hasPending(), true, '缺金额应存为待处理上下文');
  BI.clearPending();
});

test('I10 tx_query 标记：本地统计结果拼进中文段', async () => {
  const repo = await fresh();
  const today = BI.resolveDate('today');
  await repo.addTransaction({ type: 'expense', amount: 7, category: '餐饮', date: today, note: '午饭' });
  await repo.addTransaction({ type: 'expense', amount: 16, category: '餐饮', date: today, note: '晚饭' });
  const raw = '<bl>{"op":"tx_query","period":"today"}</bl>我帮你看看。 ||| Let me check.';
  const out = await BI.handleAIResponse(raw);
  const zh = out.split('|||')[0];
  assert.match(zh, /今天支出 ¥23/);
  assert.match(zh, /我帮你看看/);
});

test('I11 tx_update 标记：今天仅一笔时自动定位', async () => {
  const repo = await fresh();
  const today = BI.resolveDate('today');
  await repo.addTransaction({ type: 'expense', amount: 7, category: '餐饮', date: today, note: '午饭' });
  const raw = '<bl>{"op":"tx_update","match":"刚才那笔","amount":8}</bl>好，改成 8 块。 ||| Done.';
  const out = await BI.handleAIResponse(raw);
  const rows = await repo.listTransactions();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, 8);
  assert.ok(!out.includes('哪一笔'), '单笔时不应追问');
});

test('I12 tx_update 今天多笔：不擅自改，追问', async () => {
  const repo = await fresh();
  const today = BI.resolveDate('today');
  await repo.addTransaction({ type: 'expense', amount: 7, category: '餐饮', date: today, note: '午饭' });
  await repo.addTransaction({ type: 'expense', amount: 20, category: '购物', date: today, note: '水果' });
  const raw = '<bl>{"op":"tx_update","match":"最近","amount":8}</bl>嗯。 ||| Hmm.';
  const out = await BI.handleAIResponse(raw);
  assert.match(out, /哪一笔/);
  const rows = await repo.listTransactions();
  assert.deepEqual(rows.map((r) => r.amount).sort((a, b) => a - b), [7, 20], '两笔都不应被改动');
});

/* ---- AI 标记处理：待办 ---- */
test('I13 task_add 标记：相对日期解析入库', async () => {
  const repo = await fresh();
  const raw = '<bl>{"op":"task_add","title":"买牛奶","date":"tomorrow"}</bl>记下了。 ||| Noted.';
  await BI.handleAIResponse(raw);
  const tasks = await repo.listTasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, '买牛奶');
  assert.equal(tasks[0].date, BI.resolveDate('tomorrow'));
});

test('I14 task_done 标记：唯一匹配则完成', async () => {
  const repo = await fresh();
  const t = await repo.addTask({ title: '买牛奶', date: BI.resolveDate('today'), type: 'todo' });
  const raw = '<bl>{"op":"task_done","match":"买牛奶"}</bl>真棒。 ||| Great.';
  await BI.handleAIResponse(raw);
  const done = await repo.getTask(t.id);
  assert.equal(done.status, 'done');
  assert.ok(done.completedAt);
});

test('I15 task_done 多个匹配：不改，追问', async () => {
  const repo = await fresh();
  await repo.addTask({ title: '买牛奶', date: BI.resolveDate('today'), type: 'todo' });
  await repo.addTask({ title: '买牛奶给妈妈', date: BI.resolveDate('today'), type: 'todo' });
  const raw = '<bl>{"op":"task_done","match":"买牛奶"}</bl>好。 ||| Okay.';
  const out = await BI.handleAIResponse(raw);
  assert.match(out, /哪件/);
  const tasks = await repo.listTasks();
  assert.ok(tasks.every(t => t.status === 'pending'));
});

test('I16 task_update_date 标记', async () => {
  const repo = await fresh();
  await repo.addTask({ title: '交作业', date: BI.resolveDate('today'), type: 'todo' });
  const raw = '<bl>{"op":"task_update_date","match":"交作业","date":"下周五"}</bl>好，改到下周五。 ||| Moved.';
  await BI.handleAIResponse(raw);
  const tasks = await repo.listTasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].date, BI.resolveDate('下周五'));
});

test('I17 task_query 标记：本地列表', async () => {
  const repo = await fresh();
  await repo.addTask({ title: '交作业', date: BI.resolveDate('today'), type: 'todo' });
  const raw = '<bl>{"op":"task_query","range":"today"}</bl>我看看。 ||| Checking.';
  const out = await BI.handleAIResponse(raw);
  assert.match(out.split('|||')[0], /交作业/);
});

/* ---- 安全性 ---- */
test('I18 无标记的普通回复原样返回', async () => {
  await fresh();
  const raw = '今天也要好好照顾自己。 ||| Take care today.';
  assert.equal(await BI.handleAIResponse(raw), raw);
});

test('I19 畸形 JSON 标记：只剥离不执行', async () => {
  const repo = await fresh();
  const raw = '<bl>{oops}</bl>嗯。 ||| Hmm.';
  const out = await BI.handleAIResponse(raw);
  assert.ok(!out.includes('<bl>'));
  assert.equal((await repo.listTransactions()).length, 0);
  assert.equal((await repo.listTasks()).length, 0);
});

test('I20 ask 类消息由 AI 自然追问，无标记则零操作', async () => {
  const repo = await fresh();
  const raw = '哪一件事呢？ ||| Which one?';
  await BI.handleAIResponse(raw);
  assert.equal((await repo.listTasks()).length, 0);
});
