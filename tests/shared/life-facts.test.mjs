/* P4：按需事实读取隔离测试（内存 localStorage，不接触真实数据） */
import test from 'node:test';
import assert from 'node:assert/strict';
import '../../public/shared/life-clock.js';
import '../../public/shared/life-facts.js';

const LF = globalThis.LifeFacts;
const C = globalThis.LifeClock;

const NOW = new Date(2026, 11, 3, 21, 0).getTime();  // 2026-12-03 21:00
const TODAY = '2026-12-03';
const YESTERDAY = '2026-12-02';

function useStorage(data) {
  const m = new Map();
  Object.keys(data || {}).forEach((k) => m.set(k, JSON.stringify(data[k])));
  globalThis.localStorage = {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
  return m;
}
function noStorage() { delete globalThis.localStorage; }

test('普通闲聊不触发任何读取', async () => {
  useStorage({ 'ylxh.vocab.v1': { history: [{ at: NOW - 86400000, size: 8, words: [{ w: 'abandon' }] }] } });
  for (const t of ['星星我回来啦', '今天好累陪我聊天吧', '我昨天背了好多单词好累', '抱抱我']) {
    const r = await LF.lookup(t, { now: NOW });
    assert.equal(r.kind, null, t);
    assert.equal(r.text, '', t);
  }
  noStorage();
});

test('问「昨天背了什么」→ 读到真实单词与数量', async () => {
  useStorage({
    'ylxh.vocab.v1': {
      history: [
        { at: NOW - 86400000 + 3600000, size: 6, words: [{ w: 'abandon', cn: '放弃' }, { w: 'brittle', cn: '易碎的' }, { w: 'candidate' }, { w: 'drift' }, { w: 'echo' }] },
        { at: NOW - 3 * 86400000, size: 5, words: [{ w: 'oldword' }] },
      ],
    },
  });
  const r = await LF.lookup('我昨天背了什么？', { now: NOW });
  assert.equal(r.kind, 'vocab');
  assert.ok(r.text.indexOf('昨天') !== -1, r.text);
  assert.ok(r.text.indexOf('abandon') !== -1, r.text);
  assert.ok(r.text.indexOf('oldword') === -1, '不得串到更早的记录');
  assert.ok(r.text.length <= 120, r.text);
  noStorage();
});

test('昨天没有记录时不编造', async () => {
  useStorage({ 'ylxh.vocab.v1': { history: [{ at: NOW - 5 * 86400000, size: 5, words: [{ w: 'x' }] }] } });
  const r = await LF.lookup('昨天背了什么', { now: NOW });
  assert.equal(r.none, true);
  assert.ok(r.text.indexOf('没有找到') !== -1, r.text);
  assert.ok(r.text.indexOf(':x') === -1 && r.text.indexOf('、x') === -1, r.text);
  noStorage();
});

test('完全没有背词存档时明确说没找到', async () => {
  useStorage({});
  const r = await LF.lookup('最近背了哪些单词', { now: NOW });
  assert.equal(r.none, true);
  assert.ok(r.text.indexOf('没有找到') !== -1, r.text);
  noStorage();
});

test('电台：只认 completed 且有完成时刻的节目', async () => {
  useStorage({
    'ylxh.radio.episodes': [
      { id: 'e1', title: '深夜电台·第一夜', status: 'completed', completedAt: NOW - 3600000 },
      { id: 'e2', title: '还没听完的', status: 'listening', completedAt: null },
    ],
  });
  const r = await LF.lookup('我上次听完的节目是什么', { now: NOW });
  assert.equal(r.kind, 'radio');
  assert.ok(r.text.indexOf('深夜电台·第一夜') !== -1, r.text);
  assert.ok(r.text.indexOf('还没听完的') === -1, r.text);
  noStorage();
});

test('电台：只有未完成的节目 → 不声称听完', async () => {
  useStorage({ 'ylxh.radio.episodes': [{ id: 'e2', title: '听了一半', status: 'listening' }] });
  const r = await LF.lookup('我听过哪些节目', { now: NOW });
  assert.equal(r.none, true);
  assert.ok(r.text.indexOf('没有找到') !== -1, r.text);
  noStorage();
});

test('读书：有完成记录给书名，只有在读给在读', async () => {
  useStorage({
    'ylxh.radio.reading': {
      books: [{ id: 'bk_001', title: '瓦尔登湖', status: 'finished' }, { id: 'bk_013', title: '悉达多', status: 'reading' }],
      history: [{ bookId: 'bk_001', finishedAt: NOW - 2 * 3600000 }],
    },
  });
  const done = await LF.lookup('我最近读完哪本书了', { now: NOW });
  assert.equal(done.kind, 'reading');
  assert.ok(done.text.indexOf('瓦尔登湖') !== -1, done.text);
  useStorage({
    'ylxh.radio.reading': { books: [{ id: 'bk_013', title: '悉达多', status: 'reading' }], history: [] },
  });
  const reading = await LF.lookup('我在读什么书', { now: NOW });
  assert.ok(reading.text.indexOf('悉达多') !== -1, reading.text);
  assert.ok(reading.text.indexOf('还没读完') !== -1, reading.text);
  noStorage();
});

test('待办：用注入读取器取真实完成记录；读取失败不编造', async () => {
  useStorage({});
  const ok = await LF.lookup('我最近完成了哪些事', {
    now: NOW,
    tasks: async () => [
      { id: 't1', title: '交体检报告', status: 'done', completedAt: NOW - 7200000 },
      { id: 't2', title: '还没做的', status: 'pending', date: TODAY },
    ],
  });
  assert.equal(ok.kind, 'task');
  assert.ok(ok.text.indexOf('交体检报告') !== -1, ok.text);
  assert.ok(ok.text.indexOf('还没做的') === -1, '未完成不得说成完成');

  const bad = await LF.lookup('我最近完成了哪些事', { now: NOW, tasks: async () => { throw new Error('blocked'); } });
  assert.equal(bad.none, true);
  assert.ok(bad.text.indexOf('不要编造') !== -1, bad.text);
  noStorage();
});

test('待办：没有 provider 时明确说读不到', async () => {
  useStorage({});
  const r = await LF.lookup('我做完什么了', { now: NOW });
  assert.equal(r.none, true);
  assert.ok(r.text.indexOf('读不到') !== -1, r.text);
  noStorage();
});

test('聊天时间：用 lastInteractionAt，不用 lastActiveAt', async () => {
  useStorage({});
  const real = globalThis.LifePresence;
  globalThis.LifePresence = {
    snapshot: () => ({ lastInteractionAt: NOW - 26 * 3600000, lastActiveAt: NOW - 5 * 60000 }),
  };
  const r = await LF.lookup('我们上次聊天是什么时候', { now: NOW });
  assert.equal(r.kind, 'chat');
  assert.ok(r.text.indexOf('昨天') !== -1, r.text);
  globalThis.LifePresence = { snapshot: () => ({ lastInteractionAt: null, lastActiveAt: NOW }) };
  const none = await LF.lookup('我们上次聊天是什么时候', { now: NOW });
  assert.equal(none.none, true);
  if (real) globalThis.LifePresence = real; else delete globalThis.LifePresence;
  noStorage();
});

test('只读：查询不修改任何存档', async () => {
  const data = {
    'ylxh.vocab.v1': { history: [{ at: NOW - 86400000, size: 3, words: [{ w: 'a' }] }] },
    'ylxh.radio.episodes': [{ id: 'e1', title: 'x', status: 'completed', completedAt: NOW }],
  };
  const m = useStorage(data);
  const before = JSON.stringify([...m.entries()]);
  await LF.lookup('昨天背了什么', { now: NOW });
  await LF.lookup('上次听完的节目', { now: NOW });
  assert.equal(JSON.stringify([...m.entries()]), before);
  noStorage();
});

test('结果长度不超过 120 字，且不含隐私类别', async () => {
  useStorage({
    'ylxh.vocab.v1': { history: [{ at: NOW - 86400000, size: 20, words: Array.from({ length: 20 }, (_, i) => ({ w: 'word' + i })) }] },
  });
  const r = await LF.lookup('昨天背了什么', { now: NOW });
  assert.ok(r.text.length <= 120, r.text.length + ' → ' + r.text);
  assert.ok(!/元|¥|睡眠|生理期|日记/.test(r.text), r.text);
  noStorage();
});

test('LifeClock 缺日界线时不串天（今天问今天）', async () => {
  useStorage({ 'ylxh.vocab.v1': { history: [{ at: NOW - 3600000, size: 4, words: [{ w: 'today1' }] }] } });
  const r = await LF.lookup('今天我背了什么', { now: NOW });
  assert.ok(r.text.indexOf('today1') !== -1, r.text);
  assert.equal(C.formatDay(NOW), TODAY);
  noStorage();
});
