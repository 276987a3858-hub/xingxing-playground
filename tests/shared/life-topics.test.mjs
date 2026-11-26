/* P5-a：话题回避记忆 + 与 LifeContext / LifeFacts 的联动（内存存储，不接触真实数据） */
import test from 'node:test';
import assert from 'node:assert/strict';

import '../../public/shared/life-clock.js';
import '../../public/shared/life-topics.js';
import '../../public/shared/life-context.js';
import '../../public/shared/life-facts.js';

const LT = globalThis.LifeTopics;
const LC = globalThis.LifeContext;
const LF = globalThis.LifeFacts;
const C = globalThis.LifeClock;
const NOW = new Date(2026, 10, 17, 21, 10).getTime();

function memStore(seed) {
  const m = new Map(Object.entries(seed || {}));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _m: m,
  };
}
function fresh(seed) {
  globalThis.localStorage = memStore(seed);
  LT._reset();
  return globalThis.localStorage;
}
const stored = () => JSON.parse(globalThis.localStorage.getItem(LT._keys.KEY) || '{"v":1,"items":[]}');

/* ---------------- 识别 ---------------- */

test('普通闲聊/撒娇不记录任何规则', () => {
  fresh();
  ['星星我回来啦', '今天好累啊', '陪我聊会儿吧', '背单词好难', '这个游戏真好玩'].forEach((t) => {
    const r = LT.note(t);
    assert.equal(r.kind, null, t);
  });
  assert.equal(stored().items.length, 0);
});

test('「现在不想聊」只在本会话内生效，不落盘', () => {
  const st = fresh();
  const r = LT.note('我现在不想聊背单词的事');
  assert.equal(r.kind, 'short');
  assert.deepEqual(r.topics, ['vocab']);
  assert.equal(LT.isBlocked('vocab'), true, '本次对话内尊重');
  assert.equal(st.getItem(LT._keys.KEY), null, '不得写入长期规则');
  // 换会话（重新加载模块状态）后自然失效
  LT._reset();
  assert.equal(LT.isBlocked('vocab'), false);
});

test('明确「以后别再提…」写入长期规则', () => {
  const st = fresh();
  const r = LT.note('以后别再跟我提背单词的事了');
  assert.equal(r.kind, 'long');
  assert.deepEqual(r.topics, ['vocab']);
  assert.equal(stored().items.length, 1);
  assert.equal(stored().items[0].k, 'vocab');
  assert.ok(stored().items[0].at > 0);
  assert.equal(LT.isBlocked('vocab'), true);
  assert.equal(LT.isBlocked('reading'), false);
});

test('没有长期标记的「别再说了」不升级成永久禁忌', () => {
  const st = fresh();
  LT.note('别再说电台节目了');
  assert.equal(st.getItem(LT._keys.KEY), null);
  assert.equal(LT.isBlocked('radio'), false);
});

test('认不出话题就不记录（宁可漏不可滥）', () => {
  const st = fresh();
  const r = LT.note('以后再也别提这件事了');
  assert.equal(r.kind, null);
  assert.equal(st.getItem(LT._keys.KEY), null);
});

test('「可以再聊了」解除对应规则', () => {
  fresh();
  LT.note('以后别再提读书的事了');
  assert.equal(LT.isBlocked('reading'), true);
  const r = LT.note('读书的事可以再聊了');
  assert.equal(r.kind, 'release');
  assert.equal(LT.isBlocked('reading'), false);
  assert.equal(stored().items.length, 0);
});

test('规则数量上限 8，超出丢最旧', () => {
  fresh();
  LT.note('以后别再提背单词了');
  LT.note('以后别再提电台节目了');
  LT.note('以后别再提读书的事了');
  LT.note('以后别再提待办事项了');
  LT.note('以后别再提游戏了');
  assert.equal(stored().items.length, 5);
  assert.equal(stored().items.length <= LT._keys.MAX_ITEMS, true);
});

test('只写自己的键，不保存原文与聊天内容', () => {
  const st = fresh();
  LT.note('以后别再说背单词了，我真的烦了');
  const raw = st.getItem(LT._keys.KEY);
  assert.ok(raw.indexOf('烦') === -1, '不保存原句');
  assert.ok(raw.length < 120, '存储极小');
  assert.equal(st._m.size, 1);
});

test('promptNote 简短且带话题名', () => {
  fresh();
  assert.equal(LT.promptNote(), '');
  LT.note('以后别再提背单词了');
  const n = LT.promptNote();
  assert.ok(n.indexOf('背词') !== -1, n);
  assert.ok(n.length <= 60, n);
});

test('疲惫/拒绝只暂停自主互动，不写规则', () => {
  const st = fresh();
  assert.equal(LT.declined('今天好累，不想说话了'), true);
  LT.hush();
  assert.equal(LT.quiet(), true);
  assert.equal(LT.quiet(Date.now() + 41 * 60 * 1000), false);
  assert.equal(st.getItem(LT._keys.KEY), null);
});

/* ---------------- 与上下文/事实联动 ---------------- */

test('回避后事件不再进入 LifeContext 概括', () => {
  fresh();
  LT.note('以后别再提背单词了');
  const ev = [
    { type: 'vocab.round', at: NOW - 3600000, status: 'occurred' },
    { type: 'task.done', at: NOW - 7200000, status: 'occurred' },
  ];
  const s = LC.snapshot({ now: NOW, presence: { lastInteractionAt: NOW - 86400000, visitKind: 'returned' }, events: ev });
  assert.equal(s.events.counts['vocab.round'] || 0, 0, '被回避的话题不得出现');
  assert.equal(s.events.counts['task.done'], 1);
});

test('有回避规则时不给状态计数（聚合数字无法逐项剔除）', () => {
  fresh();
  const state = { at: NOW, counts: { planned: 2, ongoing: 1, completed: 3, expired: 0 } };
  const before = LC.snapshot({ now: NOW, presence: {}, events: [], state });
  assert.ok(before.hasState);
  LT.note('以后别再提游戏了');
  const after = LC.snapshot({ now: NOW, presence: {}, events: [], state });
  assert.equal(after.hasState, false);
});

test('事实查询：被回避的类别连存档都不读', async () => {
  fresh({ 'ylxh.vocab.v1': JSON.stringify({ history: [{ at: NOW - 86400000, size: 6, words: [{ w: 'abandon' }] }] }) });
  const ok = await LF.lookup('我昨天背了什么？', { now: NOW });
  assert.ok(ok.text.indexOf('abandon') !== -1, ok.text);
  LT.note('以后别再提背单词了');
  const blocked = await LF.lookup('我昨天背了什么？', { now: NOW });
  assert.equal(blocked.text, '');
  assert.equal(blocked.blocked, true);
});

test('解除回避后事实查询恢复', async () => {
  fresh({ 'ylxh.vocab.v1': JSON.stringify({ history: [{ at: NOW - 86400000, size: 6, words: [{ w: 'brittle' }] }] }) });
  LT.note('以后别再提背单词了');
  assert.equal((await LF.lookup('我昨天背了什么？', { now: NOW })).text, '');
  LT.note('背单词的事可以再聊了');
  assert.ok((await LF.lookup('我昨天背了什么？', { now: NOW })).text.indexOf('brittle') !== -1);
});

test('渲染仍不超过 120 字（有回避规则时）', () => {
  fresh();
  LT.note('以后别再提电台节目了');
  const s = LC.snapshot({
    now: NOW,
    presence: { visitKind: 'returned', lastReturnFrom: 'playground', lastInteractionAt: NOW - 40 * 3600000, lastVisitAt: NOW - 50 * 3600000 },
    events: [{ type: 'radio.episode', at: NOW - 3600000 }, { type: 'task.done', at: NOW - 7200000 }],
    state: { counts: { planned: 3, ongoing: 1, completed: 2, expired: 0 } },
  });
  const text = LC.render(s);
  assert.ok(text.length <= 120, text);
  assert.ok(text.indexOf('听完了') === -1, '被回避的话题不得出现在渲染里');
});

/* ---------------- P5.2：DECLINE 不再误伤日常客套 ---------------- */

test('日常「麻烦」不判为拒绝，明确烦躁才暂停', () => {
  ['麻烦你啦', '这件事好麻烦啊你帮我看看', '不麻烦的', '我自己来就行'].forEach((t) => {
    assert.equal(LT.declined(t), false, t + ' 不应判为拒绝/疲惫');
  });
  ['好烦', '烦死了', '心烦', '有点烦躁', '别烦我', '今天好累', '困了', '不想说话'].forEach((t) => {
    assert.equal(LT.declined(t), true, t + ' 应判为拒绝/疲惫');
  });
});

test('说过「麻烦你啦」后自主互动不被暂停', () => {
  fresh();
  if (LT.declined('麻烦你啦')) LT.hush();
  assert.equal(LT.quiet(), false);
});
