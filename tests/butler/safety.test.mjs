/* tests/butler/safety.test.mjs — 失败必须出声 + 同一条消息的幂等保护（零 AI 请求） */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryAdapter } from './memory-adapter.mjs';
import { createRepository } from '../../public/butler/butler-repository.js';
import '../../public/butler/butler-intent.js';

const BI = globalThis.ButlerIntent;

async function fresh(opts = {}) {
  const adapter = createMemoryAdapter({});
  if (opts.failPut) {
    const origin = adapter.put.bind(adapter);
    adapter.put = async (store, value) => {
      if (store === 'tasks') throw new Error('磁盘写入失败');
      return origin(store, value);
    };
  }
  const repo = createRepository(adapter);
  BI._setRepository(repo);
  BI._resetHandled();
  BI.clearPending();
  return repo;
}

const BASE = 1794900000000;

test('S01 解析失败（有时间、标题取不到）→ 说没记下来，不假装成功', async () => {
  const repo = await fresh();
  const out = await BI.handleAIResponse('行，我记着了。 ||| ok', '提醒我十五分钟后', BASE);
  assert.equal((await repo.listTasks()).length, 0, '不应写库');
  assert.ok(!/记好了|记着了/.test(out.replace(/^行，我记着了。/, '')), '不追加成功话术');
  assert.ok(out.includes('没记下来'), '明确告知没记下来: ' + out);
});

test('S02 写入失败 → 告知失败，绝无「记好了」', async () => {
  const repo = await fresh({ failPut: true });
  const out = await BI.handleAIResponse('好，十五分钟后叫你。 ||| ok', '提醒我十五分钟后喝水', BASE);
  assert.ok(out.includes('没记上'), '应提示没记上: ' + out);
  assert.ok(!out.includes('记好了'), '不得出现成功话术');
  assert.equal((await repo.listTasks()).length, 0);
});

test('S03 写入成功 → 才补「记好了」', async () => {
  const repo = await fresh();
  const out = await BI.handleAIResponse('好，十五分钟后叫你。 ||| ok', '提醒我十五分钟后喝水', BASE);
  assert.ok(!/（记好了/.test(out), '成功路径不贴括号文案: ' + out);
  const rows = await repo.listTasks();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, '喝水');
});

test('S04 同一条消息重复处理 → 只写一条', async () => {
  const repo = await fresh();
  const a = await BI.handleAIResponse('好，叫你。 ||| ok', '提醒我十五分钟后喝水', BASE);
  const b = await BI.handleAIResponse('好，叫你。 ||| ok', '提醒我十五分钟后喝水', BASE);   // 同 baseMs + 同原文
  assert.ok(!/（记好了/.test(a));
  assert.equal((await repo.listTasks()).length, 1, '重复处理不得建第二条');
  assert.equal(b, '好，叫你。 ||| ok', '重复处理不再追认一次');
});

test('S05 用户真的又说了一遍（不同时间戳）→ 两条都建，不误拦', async () => {
  const repo = await fresh();
  await BI.handleAIResponse('好 ||| ok', '提醒我十五分钟后喝水', BASE);
  await BI.handleAIResponse('好 ||| ok', '提醒我十五分钟后喝水', BASE + 60000);
  assert.equal((await repo.listTasks()).length, 2);
});

test('S06 表单直接建同名同时刻待办 → 不受影响（repository 未改）', async () => {
  const repo = await fresh();
  await repo.addTask({ title: '喝水', date: '2026-11-17', time: '08:00' });
  await repo.addTask({ title: '喝水', date: '2026-11-17', time: '08:00' });
  assert.equal((await repo.listTasks()).length, 2, '表单主动创建同名事项必须允许');
});

test('S07 有标记路径重复处理 → 只写一条', async () => {
  const repo = await fresh();
  const raw = '<bl>{"op":"task_add","title":"喝水","date":"today","time":"08:00"}</bl>好 ||| ok';
  await BI.handleAIResponse(raw, '提醒我八点喝水', BASE);
  await BI.handleAIResponse(raw, '提醒我八点喝水', BASE);
  const rows = await repo.listTasks();
  assert.equal(rows.length, 1);
});

test('S08 闲聊里的「提醒我」没有时间 → 一个字都不加', async () => {
  const repo = await fresh();
  const out = await BI.handleAIResponse('嗯，我一直记着你。 ||| ok', '你提醒我一下我有多喜欢你', BASE);
  assert.equal(out, '嗯，我一直记着你。 ||| ok');
  assert.equal((await repo.listTasks()).length, 0);
});

test('S09 失败后可重试成功（失败不记账）', async () => {
  const repo = await fresh({ failPut: true });
  const bad = await BI.handleAIResponse('好 ||| ok', '提醒我十五分钟后喝水', BASE);
  assert.ok(bad.includes('没记上'));
  const okRepo = createRepository(createMemoryAdapter({}));
  BI._setRepository(okRepo);
  const good = await BI.handleAIResponse('好 ||| ok', '提醒我十五分钟后喝水', BASE);   // 同一条消息再处理一次
  assert.ok(!/（记好了/.test(good), '失败不应占用幂等额度: ' + good);
  assert.equal((await okRepo.listTasks()).length, 1);
  assert.equal((await repo.listTasks()).length, 0);
});
