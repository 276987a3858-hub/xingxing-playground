/* P5.1：主动回忆选材层（内存存储，不接触真实数据、不调 AI） */
import test from 'node:test';
import assert from 'node:assert/strict';

import '../../public/shared/life-clock.js';
import '../../public/shared/life-events.js';
import '../../public/shared/life-facts.js';
import '../../public/shared/life-topics.js';

const LE = globalThis.LifeEvents;
const LF = globalThis.LifeFacts;
const LT = globalThis.LifeTopics;
const NOW = new Date(2026, 10, 17, 21, 0).getTime();
const DAY = 86400000;

function mem(seed) {
  const m = new Map(Object.entries(seed || {}));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _m: m,
  };
}
function fresh(seed) {
  const st = mem(seed);
  globalThis.localStorage = st;
  LE._reset(); LE._setStorage({ local: st });
  LT._reset(); LT._clear();
  return st;
}
const recallRaw = () => JSON.parse(globalThis.localStorage.getItem(LE._keys.RECALL_KEY) || 'null');

test('3 天前的游戏完成可选，且 id 转成中文名', () => {
  fresh();
  LE.record({ id: 'game:finish:quiz:' + (NOW - 3 * DAY), at: NOW - 3 * DAY, source: 'playground', type: 'game.finish', title: 'quiz', meta: { game: 'quiz' } });
  const c = LE.pickRecall({ now: NOW });
  assert.ok(c, '应选出候选');
  assert.equal(c.kind, 'game');
  assert.equal(c.label, '星星问答');
  assert.ok(c.text.indexOf('星星问答') !== -1, c.text);
  assert.ok(c.text.indexOf('quiz') === -1, '不得出现原始 id');
  assert.equal(c.daysAgo, 3);
});

test('即时事件（<1 天）与未来事件都不选', () => {
  fresh();
  LE.record({ id: 'g1', at: NOW - 3600000, source: 'playground', type: 'game.finish', meta: { game: 'date' } });
  LE.record({ id: 'g2', at: NOW + DAY, source: 'playground', type: 'game.finish', meta: { game: 'puzzle' } });
  assert.equal(LE.pickRecall({ now: NOW }), null);
});

test('planned / ongoing / 来源不明的类型不选', () => {
  fresh();
  LE.record({ id: 'p1', at: NOW - 5 * DAY, source: 'playground', type: 'game.finish', status: 'planned', meta: { game: 'date' } });
  LE.record({ id: 'p2', at: NOW - 6 * DAY, source: 'vocab', type: 'vocab.round', status: 'ongoing', title: 'x' });
  LE.record({ id: 'p3', at: NOW - 7 * DAY, source: 'room', type: 'diary.write', title: '' });
  assert.equal(LE.pickRecall({ now: NOW }), null);
});

test('没有名称映射的游戏不进入上下文', () => {
  fresh();
  LE.record({ id: 'x1', at: NOW - 4 * DAY, source: 'playground', type: 'game.finish', meta: { game: 'unknown_game' } });
  assert.equal(LE.pickRecall({ now: NOW }), null);
});

test('同一个事件不会被重复选取', () => {
  fresh();
  LE.record({ id: 'g1', at: NOW - 3 * DAY, source: 'playground', type: 'game.finish', meta: { game: 'quiz' } });
  const first = LE.pickRecall({ now: NOW });
  assert.ok(first);
  LE.markRecalled(first.id, first.type, NOW);
  assert.equal(LE.pickRecall({ now: NOW }), null);
});

test('被屏蔽的话题不进入候选', () => {
  fresh();
  LE.record({ id: 'g1', at: NOW - 3 * DAY, source: 'playground', type: 'game.finish', meta: { game: 'quiz' } });
  LE.record({ id: 't1', at: NOW - 4 * DAY, source: 'butler', type: 'task.done', title: '交体检报告' });
  const c = LE.pickRecall({ now: NOW, exclude: ['game'] });
  assert.ok(c, c);
  assert.equal(c.kind, 'task');
  assert.ok(c.text.indexOf('交体检报告') !== -1, c.text);
  assert.equal(LE.pickRecall({ now: NOW, exclude: ['game', 'task'] }), null);
});

test('待办与背词也能形成自然话题', () => {
  fresh();
  LE.record({ id: 'v1', at: NOW - 2 * DAY, source: 'vocab', type: 'vocab.round', meta: { size: 12 } });
  const c = LE.pickRecall({ now: NOW });
  assert.ok(c);
  assert.equal(c.kind, 'vocab');
  assert.ok(c.text.indexOf('12') !== -1, c.text);
});

test('读书/电台要能从存档取到标题才选', () => {
  fresh({ 'ylxh.radio.reading': JSON.stringify({ books: [{ id: 'bk1', title: '瓦尔登湖' }] }) });
  LE.record({ id: 'reading:finish:bk1:' + (NOW - 5 * DAY), at: NOW - 5 * DAY, source: 'reading', type: 'reading.finish' });
  const c = LE.pickRecall({ now: NOW });
  assert.ok(c && c.text.indexOf('瓦尔登湖') !== -1, c && c.text);

  const st = fresh({ 'ylxh.radio.reading': JSON.stringify({ books: [] }) });
  LE._reset(); LE._setStorage({ local: st });
  LE.record({ id: 'reading:finish:bk9:' + (NOW - 5 * DAY), at: NOW - 5 * DAY, source: 'reading', type: 'reading.finish' });
  assert.equal(LE.pickRecall({ now: NOW }), null, '查不到书名就不选');
});

test('选材不立即写入回忆记录；标记后只存 id/at/type', () => {
  fresh();
  LE.record({ id: 'g1', at: NOW - 3 * DAY, source: 'playground', type: 'game.finish', meta: { game: 'quiz' } });
  LE.pickRecall({ now: NOW });
  assert.equal(recallRaw(), null, '仅有候选时不得记');
  LE.markRecalled('g1', 'game.finish', NOW);
  const r = recallRaw();
  assert.equal(r.items.length, 1);
  assert.deepEqual(Object.keys(r.items[0]).sort(), ['at', 'id', 'type']);
  assert.ok(JSON.stringify(r).length < 120);
});

test('回忆记录最多 5 条', () => {
  fresh();
  for (let i = 0; i < 8; i++) LE.markRecalled('g' + i, 'game.finish', NOW - i * 1000);
  assert.equal(recallRaw().items.length, 5);
});

test('game 事实查询：真实记录才回答，名称走映射', async () => {
  fresh();
  LE.record({ id: 'g1', at: NOW - DAY, source: 'playground', type: 'game.finish', meta: { game: 'date' } });
  const r = await LF.lookup('我们最近玩过什么游戏', { now: NOW });
  assert.equal(r.kind, 'game');
  assert.ok(r.text.indexOf('星夜21点') !== -1, r.text);
});

test('没有游戏记录时不编造', async () => {
  fresh();
  const r = await LF.lookup('我们最近玩过什么游戏', { now: NOW });
  assert.ok(r.text.indexOf('没有找到') !== -1, r.text);
});

test('被屏蔽的游戏话题：事实查询也不回答', async () => {
  fresh();
  LE.record({ id: 'g1', at: NOW - DAY, source: 'playground', type: 'game.finish', meta: { game: 'date' } });
  LT.note('以后别再提游戏了');
  const r = await LF.lookup('我们最近玩过什么游戏', { now: NOW });
  assert.equal(r.text, '');
});
