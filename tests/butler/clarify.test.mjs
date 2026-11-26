/* tests/butler/clarify.test.mjs — 明确时间才落库，歧义就追问（零 AI 请求） */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryAdapter } from './memory-adapter.mjs';
import { createRepository } from '../../public/butler/butler-repository.js';
import '../../public/butler/butler-intent.js';

const BI = globalThis.ButlerIntent;

const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const pad = (n) => String(n).padStart(2, '0');
const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

async function fresh() {
  mem.clear();
  const repo = createRepository(createMemoryAdapter({}));
  BI._setRepository(repo);
  BI._resetHandled();
  BI.clearPending();
  return repo;
}

const base = new Date(); base.setHours(15, 36, 0, 0);
const B = base.getTime();
const morning = new Date(); morning.setHours(8, 0, 0, 0);
const BM = morning.getTime();

test('C01 裸「五点钟」是歧义：不落库、追问上午还是下午', async () => {
  const repo = await fresh();
  const out = await BI.handleAIResponse('好，记着了。 ||| ok', '再提醒我五点钟去吃饭', B);
  assert.equal((await repo.listTasks()).length, 0, '不得擅自推断');
  assert.ok(/上午还是下午/.test(out), '应追问: ' + out);
  assert.ok(!/记好了/.test(out));
  assert.equal(BI.absoluteTarget('再提醒我五点钟去吃饭', B), null);
  assert.equal(BI.ambiguousHour('再提醒我五点钟去吃饭'), 5);
});

test('C02 带限定词「下午五点钟」→ 今天 17:00', async () => {
  const repo = await fresh();
  const out = await BI.handleAIResponse('好，记着了。 ||| ok', '再提醒我下午五点钟去吃饭', B);
  const rows = await repo.listTasks();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].time, '17:00');
  assert.equal(rows[0].date, day(base));
  assert.ok(!/（记好了/.test(out), '模型已确认，不再贴括号文案');
});

test('C03 24 小时制优先：17:00 / 十五点 直接采用', () => {
  assert.deepEqual(BI.absoluteTarget('提醒我17:00去吃饭', B), { date: day(base), time: '17:00' });
  assert.deepEqual(BI.absoluteTarget('提醒我十五点去吃饭', BM), { date: day(base), time: '15:00' });
  assert.equal(BI.ambiguousHour('提醒我17:00去吃饭'), 0);
  assert.equal(BI.ambiguousHour('提醒我十五点去吃饭'), 0);
});

test('C04 标题不再夹「钟」「17:00」', () => {
  assert.equal(BI.reminderTitleFrom('再提醒我五点钟去吃饭'), '吃饭');
  assert.equal(BI.reminderTitleFrom('提醒我17:00去吃饭'), '吃饭');
  assert.equal(BI.reminderTitleFrom('提醒我下午五点钟去吃饭'), '吃饭');
  assert.ok(!BI.reminderTitleFrom('再提醒我五点钟去吃饭').includes('钟'));
});

test('C05 模型已自然确认 → 原样返回，不追加任何括号文案', async () => {
  const repo = await fresh();
  const raw = '行，五点钟叫你，别磨蹭。 ||| ok';
  const out = await BI.handleAIResponse(raw, '再提醒我下午五点钟去吃饭', B);
  assert.equal(out, raw);
  assert.equal((await repo.listTasks()).length, 1, '确认归确认，库照样要写');
});

test('C06 模型没确认 → 补一句无括号的自然话', async () => {
  await fresh();
  const out = await BI.handleAIResponse('嗯。 ||| ok', '再提醒我下午五点钟去吃饭', B);
  assert.ok(/记好了/.test(out), out);
  assert.ok(!/（记好了/.test(out), '不要括号式内部文案: ' + out);
});

test('C07 歧义时模型已在追问 → 不叠第二句', async () => {
  await fresh();
  const raw = '五点是上午还是下午？ ||| Which five?';
  const out = await BI.handleAIResponse(raw, '再提醒我五点钟去吃饭', B);
  assert.equal(out, raw);
});

test('C08 手动录入的待办照常提前提醒（提醒机制未受影响）', async () => {
  const repo = await fresh();
  mem.clear();
  const soon = new Date(Date.now() + 5 * 60000);
  const d = day(soon);
  const t = `${pad(soon.getHours())}:${pad(soon.getMinutes())}`;
  await repo.addTask({ title: '手动录入', date: d, time: t });
  const first = await BI.remindContext();
  const second = await BI.remindContext();
  assert.ok(String(first).includes('手动录入'), '应提醒: ' + first);
  assert.equal(second, '', '只提醒一次');
});
