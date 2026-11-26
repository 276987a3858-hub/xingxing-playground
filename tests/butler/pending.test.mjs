/* tests/butler/pending.test.mjs — 关键词分类门控 + 临时待处理上下文（本地，不调 AI） */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRepository } from '../../public/butler/butler-repository.js';
import { createMemoryAdapter } from './memory-adapter.mjs';
import '../../public/butler/butler-intent.js';

const BI = globalThis.ButlerIntent;

async function fresh() {
  const repo = createRepository(createMemoryAdapter({}));
  BI._setRepository(repo);
  BI.clearPending();
  return repo;
}

/* ---- 关键词分类：只唤醒，不代表执行 ---- */
test('P01 分类门控：闲聊/情绪不命中，明确交代才命中', () => {
  assert.equal(BI.gate('今天花费真高'), false);      // 有"花费"无动作、无金额
  assert.equal(BI.gate('我不想洗衣服'), false);      // 只有物品名
  assert.equal(BI.gate('我今天有点累，想和你聊聊'), false);
  assert.equal(BI.gate('下午提醒我洗衣服'), true);
  assert.equal(BI.gate('午饭花了7元'), true);
  const c = BI.classify('姨妈好像要来了');
  assert.equal(c.cycle, true);
  assert.equal(c.task, false);
  assert.equal(c.money, false);
});

/* ---- 核心场景：缺时间 → 追问 → 补"三点" → 存同一条待办 ---- */
test('P02 缺时间转待处理，回「三点」本地补全并保存', async () => {
  const repo = await fresh();
  const reply = '好呀，下午几点提醒你比较好？ ||| Sure, what time in the afternoon?';
  const display = await BI.handleAIResponse(
    '<bl>{"op":"task_add","title":"洗衣服","date":"today","need":["time"]}</bl>\n' + reply,
    '下午提醒我洗衣服'
  );
  assert.ok(!display.includes('<bl>'));
  assert.equal((await repo.listTasks()).length, 0, '缺信息时不能写库');
  assert.equal(BI.hasPending(), true);

  const filled = await BI.tryPending('三点');
  assert.equal(filled.handled, true);
  assert.equal(filled.saved, true);
  const tasks = await repo.listTasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, '洗衣服');
  assert.equal(tasks[0].time, '15:00');
  assert.equal(BI.hasPending(), false, '完成后清除上下文');
});

/* ---- AI 没标 need，但用户只给了时段没给钟点 → 本地也能识别 ---- */
test('P03 「下午提醒我洗衣服」未标 need 也按缺时间处理', async () => {
  const repo = await fresh();
  await BI.handleAIResponse('<bl>{"op":"task_add","title":"洗衣服","date":"today"}</bl>\n几点呢？', '下午提醒我洗衣服');
  assert.equal((await repo.listTasks()).length, 0);
  assert.equal(BI.hasPending(), true);
  assert.equal((await BI.tryPending('16:30')).saved, true);
  assert.equal((await repo.listTasks())[0].time, '16:30');
});

/* ---- 完整指令直接落库，不产生上下文 ---- */
test('P04 完整待办指令立即保存', async () => {
  const repo = await fresh();
  await BI.handleAIResponse('<bl>{"op":"task_add","title":"买牛奶","date":"tomorrow","time":"18:00"}</bl>\n好呀。', '明天提醒我买牛奶');
  const tasks = await repo.listTasks();
  assert.equal(tasks.length, 1);
  assert.equal(BI.hasPending(), false);
});

/* ---- 记账：缺金额 → 补「7元」 ---- */
test('P05 记账缺金额转待处理，补金额后保存', async () => {
  const repo = await fresh();
  await BI.handleAIResponse('<bl>{"op":"tx_add","type":"expense","category":"餐饮","note":"午饭","need":["amount"]}</bl>\n午饭花了多少呀？', '午饭花了');
  assert.equal((await repo.listTransactions()).length, 0);
  const filled = await BI.tryPending('7元');
  assert.equal(filled.saved, true);
  const rows = await repo.listTransactions();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, 7);
  assert.equal(rows[0].category, '餐饮');
});

/* ---- 换话题：不把普通聊天当补充，且清掉上下文 ---- */
test('P06 换话题不误当成补充信息', async () => {
  const repo = await fresh();
  await BI.handleAIResponse('<bl>{"op":"task_add","title":"洗衣服","need":["time"]}</bl>\n几点？', '下午提醒我洗衣服');
  const r = await BI.tryPending('我今天有点累，想和你说说话');
  assert.equal(r.handled, false);
  assert.equal((await repo.listTasks()).length, 0);
  assert.equal(BI.hasPending(), false, '换话题应清掉上下文');
});

/* ---- 原有记账查询与正常记账未受影响 ---- */
test('P07 本地统计查询与直接记账仍正常', async () => {
  const repo = await fresh();
  await BI.handleAIResponse('<bl>{"op":"tx_add","type":"expense","amount":20,"category":"购物","note":"水果"}</bl>\n记好了。', '今天买水果花了20元');
  assert.equal((await repo.listTransactions())[0].amount, 20);
  const q = await BI.tryLocal('今天花了多少钱');
  assert.equal(q.handled, true);
  assert.ok(q.reply.includes('20'));
});
