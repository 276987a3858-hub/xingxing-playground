/* tests/shared/life-feed.test.mjs — 「小屋的动静」规则与渲染
 * 全程本地：假存档 + 假 DOM，不读真实浏览器数据，不发任何请求。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import '../../public/shared/life-feed.js';

const LF = globalThis.LifeFeed;

/* ---------- 假存储 ---------- */
function fakeStore(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    _raw: m,
  };
}

function reset(now, data) {
  LF._reset();
  LF._setStorage(fakeStore());
  LF._setLoaders({
    vocab: () => data.vocab || null,
    activities: () => data.activities || [],
    episodes: () => data.episodes || [],
    events: () => data.events || [],
    keeps: () => Promise.resolve(data.keeps || []),
    diaries: () => Promise.resolve(data.diaries || []),
  });
  return LF;
}

const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const NOV18_2358 = at(2026, 11, 18, 23, 58);
const NOV19_0010 = at(2026, 11, 19, 0, 10);

const base = (extra = {}) => ({
  vocab: { history: [], words: {} },
  activities: [], episodes: [], events: [], keeps: [], diaries: [],
  ...extra,
});

/* ---------- 固定素材：目前没有可靠完成时间 ---------- */
test('三条固定小屋变化没有可靠完成时间，默认一条都不展示', () => {
  reset(NOV18_2358, base());
  const m = LF._build(NOV18_2358, 'today', base());
  assert.equal(LF._house.length, 0, '默认不挂任何固定小屋变化');
  assert.equal(m.today.length, 0);
  assert.equal(m.historyCount, 0, '没有真实历史时不算「还有 N 条」');
  assert.equal(m.hints.length, 0, '结算回聊提示同样没有可靠时间依据');
  assert.deepEqual(m.nearGroups, []);
});

test('近三天：只展开有真实事件的日期，空日期整组跳过', () => {
  const events = [
    { id: 'e16', type: 'vocab.round', status: 'occurred', at: at(2026, 11, 16, 21) },
  ];
  reset(NOV18_2358, base({ events }));
  const m = LF._build(NOV18_2358, 'near', base({ events }));
  assert.equal(m.nearGroups.length, 1);
  assert.equal(new Date(m.nearGroups[0].at).getDate(), 16);
  assert.equal(m.nearGroups[0].items.length, 1);
});

test('跨零点：事件按真实发生时间归到 11-18，今天为空', () => {
  const events = [
    { id: 'e18', type: 'vocab.round', status: 'occurred', at: at(2026, 11, 18, 23, 30) },
  ];
  reset(NOV19_0010, base({ events }));
  const m = LF._build(NOV19_0010, 'near', base({ events }));
  assert.equal(m.today.length, 0, '过了零点，今天没有任何真实事件');
  assert.deepEqual(m.nearGroups.map((g) => new Date(g.at).getDate()), [18]);
  assert.equal(m.current.kind, 'fallback');
});

/* ---------- 今天的选条：配额而不是纯排序 ---------- */
const autoVocab = (n = 3, t = at(2026, 11, 18, 21)) => ({
  history: [],
  words: Object.fromEntries(Array.from({ length: n }, (_, i) => [
    'w' + i, { mastered: true, masteredAt: t - i * 60000, masterySource: 'auto' },
  ])),
});
const houseAt = (h) => ({
  key: 'house:t:' + h, at: at(2026, 11, 18, h), variants: ['小屋变化 ' + h],
});

test('今天最多三条：共同经历 + 小屋变化 + 生活片段', () => {
  const data = base({ vocab: autoVocab(), diaries: [{ createdAt: at(2026, 11, 18, 22, 10) }] });
  reset(NOV18_2358, data);
  LF._setHouse([houseAt(20), houseAt(19)]);
  const m = LF._build(NOV18_2358, 'today', data);
  assert.equal(m.today.length, 3);
  assert.deepEqual(m.today.map((x) => x.kind), ['life', 'share', 'house'], '按发生时间倒序');
  assert.equal(m.dropped.filter((x) => x.kind === 'house').length, 1, '第二条小屋变化让位给生活片段');
});

test('生活片段优先于第二条小屋变化', () => {
  const data = base({ diaries: [{ createdAt: at(2026, 11, 18, 22, 10) }] });
  reset(NOV18_2358, data);
  LF._setHouse([houseAt(20), houseAt(19)]);
  const m = LF._build(NOV18_2358, 'today', data);
  assert.deepEqual(m.today.map((x) => x.kind), ['life', 'house']);
  assert.equal(m.today.length, 2, '素材不足就少放，不补位');
});

test('惊喜可以顶掉第二条小屋变化，但小屋变化仍留一席', () => {
  const data = base({
    vocab: autoVocab(),
    keeps: [{ id: 5, status: 'waiting_user', createdAt: at(2026, 11, 18, 20, 30) }],
  });
  reset(NOV18_2358, data);
  LF._setHouse([houseAt(20), houseAt(19)]);
  const kinds = LF._build(NOV18_2358, 'today', data).today.map((x) => x.kind).sort();
  assert.deepEqual(kinds, ['house', 'share', 'surprise']);
});

test('惊喜近三天出现过就让位，小屋变化不会被长期挤掉', () => {
  const data = base({
    vocab: autoVocab(),
    keeps: [{ id: 5, status: 'waiting_user', createdAt: at(2026, 11, 18, 20, 30) }],
  });
  reset(NOV18_2358, data);
  LF._setHouse([houseAt(20), houseAt(19)]);
  LF._setStorage(fakeStore({
    'ylxh.life.feed.v1': JSON.stringify({
      v: 1, items: { 'keep:wait:5': { at: NOV18_2358 - 86400000, v: 0 } },
    }),
  }));
  const m = LF._build(NOV18_2358, 'today', data);
  const kinds = m.today.map((x) => x.kind).sort();
  assert.deepEqual(kinds, ['house', 'house', 'share']);
  assert.ok(!m.today.some((x) => x.kind === 'surprise'));
});

test('共同经历再多也不超过两条，总数不超过三条', () => {
  const data = base({
    vocab: autoVocab(),
    activities: [{ id: 'g1', game: 'chess', endAt: at(2026, 11, 18, 21, 30), durMs: 50 * 60000 }],
    episodes: [{ id: 'e1', channel: 'english', heardAt: at(2026, 11, 18, 22, 30) }],
  });
  reset(NOV18_2358, data);
  const m = LF._build(NOV18_2358, 'today', data);
  assert.ok(m.today.length <= 3);
  assert.equal(m.today.length, 2);
  assert.ok(m.today.every((x) => x.kind === 'share'));
});

test('只有一条素材时就只显示一条', () => {
  const data = base({ diaries: [{ createdAt: at(2026, 11, 18, 22, 10) }] });
  reset(NOV18_2358, data);
  const m = LF._build(NOV18_2358, 'today', data);
  assert.equal(m.today.length, 1);
  assert.equal(m.today[0].kind, 'life');
});


/* ---------- 此刻 ---------- */
test('30 分钟窗口：29 分钟内算刚背完，31 分钟退回兜底', () => {
  const round = { at: NOV18_2358 - 29 * 60000, size: 10, words: [] };
  reset(NOV18_2358, base({ vocab: { history: [round], words: {} } }));
  let m = LF._build(NOV18_2358, 'today', base({ vocab: { history: [round], words: {} } }));
  assert.equal(m.current.kind, 'moment');
  assert.match(m.current.key, /^vocab:round:/);

  const older = { at: NOV18_2358 - 31 * 60000, size: 10, words: [] };
  LF._reset(); LF._setStorage(fakeStore());
  m = LF._build(NOV18_2358, 'today', base({ vocab: { history: [older], words: {} } }));
  assert.equal(m.current.kind, 'fallback');
});

test('A1 只说结束，不带掌握数量或判断', () => {
  const vocab = {
    history: [{ at: NOV18_2358 - 5 * 60000, size: 10, words: [] }],
    words: { apple: { mastered: true, masteredAt: NOV18_2358 - 5 * 60000, masterySource: 'auto' } },
  };
  reset(NOV18_2358, base({ vocab }));
  const m = LF._build(NOV18_2358, 'today', base({ vocab }));
  const text = m.current.variants.join(' ');
  assert.ok(!/记住|掌握|答对/.test(text), '此刻不能推断掌握情况');
});

/* ---------- 背词 ---------- */
test('B1a：今日自动掌握 3 个，且今日有轮次 → 说陪你背了一轮', () => {
  const vocab = {
    history: [{ at: NOV18_2358 - 3 * 3600000, size: 8, words: [] }],
    words: {
      a: { mastered: true, masteredAt: NOV18_2358 - 3 * 3600000, masterySource: 'auto' },
      b: { mastered: true, masteredAt: NOV18_2358 - 3 * 3600000, masterySource: 'auto' },
      c: { mastered: true, masteredAt: NOV18_2358 - 3 * 3600000, masterySource: 'auto' },
    },
  };
  reset(NOV18_2358, base({ vocab }));
  const m = LF._build(NOV18_2358, 'today', base({ vocab }));
  const item = m.today.find((x) => x.key.startsWith('vocab:mastery:'));
  assert.ok(item);
  assert.ok(item.variants.every((t) => t.includes('3')));
  assert.equal(item.at, NOV18_2358 - 3 * 3600000, '时间取真实掌握时刻，不用渲染时刻');
});

test('B1a：没有今日轮次时只说记住了 N 个', () => {
  const vocab = {
    history: [],
    words: { a: { mastered: true, masteredAt: NOV18_2358 - 3600000, masterySource: 'auto' } },
  };
  reset(NOV18_2358, base({ vocab }));
  const m = LF._build(NOV18_2358, 'today', base({ vocab }));
  const item = m.today.find((x) => x.key.startsWith('vocab:mastery:'));
  assert.ok(item.variants.every((t) => !t.includes('陪你背了一轮')));
});

test('B1b：只有手动标记时，说「自己标了记住的」', () => {
  const vocab = {
    history: [{ at: NOV18_2358 - 3600000, size: 5, words: [] }],
    words: { a: { mastered: true, masteredAt: NOV18_2358 - 60000, masterySource: 'manual' } },
  };
  reset(NOV18_2358, base({ vocab }));
  const m = LF._build(NOV18_2358, 'today', base({ vocab }));
  const item = m.today.find((x) => x.key.endsWith(':manual'));
  assert.ok(item);
  assert.ok(item.variants.every((t) => t.includes('自己')));
});

test('B1a/B1b 同屏最多一条：两种都有时只出自动', () => {
  const vocab = {
    history: [{ at: NOV18_2358 - 3600000, size: 5, words: [] }],
    words: {
      a: { mastered: true, masteredAt: NOV18_2358 - 60000, masterySource: 'auto' },
      b: { mastered: true, masteredAt: NOV18_2358 - 60000, masterySource: 'manual' },
      c: { mastered: true, masteredAt: NOV18_2358 - 60000, masterySource: 'manual' },
    },
  };
  reset(NOV18_2358, base({ vocab }));
  const m = LF._build(NOV18_2358, 'today', base({ vocab }));
  const items = m.today.filter((x) => x.key.startsWith('vocab:mastery:'));
  assert.equal(items.length, 1);
  assert.ok(items[0].key.endsWith(':auto'));
});

test('B1a 不把旧掌握算进今天', () => {
  const vocab = {
    history: [],
    words: { a: { mastered: true, masteredAt: at(2026, 11, 15, 12), masterySource: 'auto' } },
  };
  reset(NOV18_2358, base({ vocab }));
  const m = LF._build(NOV18_2358, 'today', base({ vocab }));
  assert.equal(m.today.filter((x) => x.key.startsWith('vocab:mastery:')).length, 0);
});

/* ---------- 游戏 / 电台 / 珍藏 ---------- */
test('B2：不足 45 分钟不计，跨过阈值才展示', () => {
  const short = [{ id: 'g1', game: 'gomoku', endAt: NOV18_2358 - 3600000, durMs: 40 * 60000 }];
  reset(NOV18_2358, base({ activities: short }));
  assert.equal(LF._build(NOV18_2358, 'today', base({ activities: short })).today
    .filter((x) => x.key === 'game:act:g1').length, 0);

  const long = [{ id: 'g2', game: 'gomoku', endAt: NOV18_2358 - 3600000, durMs: 46 * 60000 }];
  LF._reset(); LF._setStorage(fakeStore());
  const m = LF._build(NOV18_2358, 'today', base({ activities: long }));
  assert.equal(m.today.filter((x) => x.key === 'game:act:g2').length, 1);
});

test('B3：英文广播只认 heardAt，文字节目 completedAt 不算', () => {
  const eps = [
    { id: 'e1', channel: 'english', heardAt: NOV18_2358 - 1800000 },
    { id: 'e2', channel: 'reading', completedAt: NOV18_2358 - 1800000 },
  ];
  reset(NOV18_2358, base({ episodes: eps }));
  const m = LF._build(NOV18_2358, 'today', base({ episodes: eps }));
  assert.equal(m.today.filter((x) => x.key.startsWith('radio:heard:')).length, 1);
  assert.ok(m.today.some((x) => x.key === 'radio:heard:e1'));
});

test('B4：saved 但没有 confirmedAt 的老珍藏不触发', () => {
  const keeps = [
    { id: 1, status: 'saved', createdAt: at(2026, 10, 1, 10) },
    { id: 2, status: 'saved', confirmedAt: NOV18_2358 - 7200000 },
  ];
  reset(NOV18_2358, base({ keeps }));
  return Promise.resolve(LF._build(NOV18_2358, 'today', base({ keeps }))).then((m) => {
    const keys = m.today.map((x) => x.key);
    assert.ok(keys.includes('keep:saved:2'));
    assert.ok(!keys.includes('keep:saved:1'));
  });
});

test('C1：等待确认的珍藏 7 天内出现，超期不出现', () => {
  const fresh = [{ id: 9, status: 'waiting_user', createdAt: NOV18_2358 - 86400000 }];
  reset(NOV18_2358, base({ keeps: fresh }));
  assert.ok(LF._build(NOV18_2358, 'today', base({ keeps: fresh })).today
    .some((x) => x.key === 'keep:wait:9'));

  const stale = [{ id: 9, status: 'waiting_user', createdAt: NOV18_2358 - 8 * 86400000 }];
  LF._reset(); LF._setStorage(fakeStore());
  assert.equal(LF._build(NOV18_2358, 'today', base({ keeps: stale })).today
    .filter((x) => x.key === 'keep:wait:9').length, 0);
});

/* ---------- 历史 ---------- */
test('每天最多两条历史动态', () => {
  const events = [0, 1, 2, 3, 4].map((i) => ({
    id: 'ev' + i, type: 'vocab.round', status: 'occurred',
    at: at(2026, 11, 17, 9 + i), source: 'vocab',
  }));
  reset(NOV18_2358, base({ events }));
  const m = LF._build(NOV18_2358, 'near', base({ events }));
  const g = m.nearGroups.find((x) => new Date(x.at).getDate() === 17);
  assert.equal(g.items.length, 2, '同一天最多两条');
  assert.equal(m.historyCount, 2, '只有真实事件，不再有固定素材凑数');
  assert.equal(m.nearGroups.length, 1, '只有 11-17 一组');
});

test('planned 不展示；超过七天不展示', () => {
  const events = [
    { id: 'p1', type: 'vocab.round', status: 'planned', at: at(2026, 11, 17, 20) },
    { id: 'old', type: 'vocab.round', status: 'occurred', at: NOV18_2358 - 8 * 86400000 },
    { id: 'keep', type: 'vocab.round', status: 'occurred', at: NOV18_2358 - 6 * 86400000 },
  ];
  reset(NOV18_2358, base({ events }));
  const m = LF._build(NOV18_2358, 'today', base({ events }));
  const keys = m.groups.flatMap((g) => g.items.map((x) => x.key));
  assert.ok(keys.includes('ev:keep'));
  assert.ok(!keys.includes('ev:old'));
  assert.ok(!keys.includes('ev:p1'));
});

test('文案固定：同一事件换范围、重新构建都是同一句', () => {
  const keeps = [{ id: 7, status: 'saved', confirmedAt: at(2026, 11, 18, 21) }];
  const data = base({ keeps });
  reset(NOV18_2358, data);
  const one = LF._build(NOV18_2358, 'today', data).today[0];
  const two = LF._build(NOV18_2358, 'near', data).today[0];
  assert.equal(one.key, two.key);
  assert.equal(LF._text(one, NOV18_2358), LF._text(two, NOV18_2358));

  // 已经定下的那句要保留，不因为后来倒序/随机变化而换句
  LF._setStorage(fakeStore({
    'ylxh.life.feed.v1': JSON.stringify({ v: 1, items: { [one.key]: { at: NOV18_2358, v: 2 } } }),
  }));
  assert.equal(LF._text(one, NOV18_2358), one.variants[2]);
});

/* ---------- 空态 ---------- */
test('完全没有素材时：今天为空、没有历史计数', () => {
  const quiet = at(2026, 9, 1, 14);
  reset(quiet, base());
  const m = LF._build(quiet, 'today', base());
  assert.equal(m.today.length, 0);
  assert.equal(m.historyCount, 0);
  assert.equal(m.hints.length, 0);
  assert.equal(m.current.kind, 'fallback');
});

/* ---------- 渲染与切换 ---------- */
function fakeDom() {
  const calls = [];
  const makeChild = () => ({
    innerHTML: '', textContent: '', attrs: {},
    classList: { toggle() {}, add() {}, remove() {} },
    getAttribute(k) { return this.attrs[k] ?? null; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    addEventListener() {},
    querySelector() { return null; },
    getBoundingClientRect() { return { top: 300 }; },
  });
  const bodies = { '#lfBody': makeChild(), '#lfCurrent': makeChild(), '#lfHistory': makeChild(), '#lfFold': makeChild() };
  const btns = ['today', 'near'].map((r) => {
    const b = makeChild();
    b.attrs['data-range'] = r;
    return b;
  });
  const el = {
    innerHTML: '', attrs: {},
    classList: { toggle() {} },
    getAttribute(k) { return this.attrs[k] ?? null; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    querySelector(sel) { return bodies[sel] || null; },
    querySelectorAll(sel) { return sel === '.lf-range-btn' ? btns : []; },
    addEventListener() {},
  };
  globalThis.document = { hidden: false, addEventListener() {}, getElementById: () => el };
  globalThis.scrollY = 420;
  globalThis.scrollTo = (a, b) => { calls.push(typeof a === 'object' ? a.top : b); };
  return { el, bodies, calls };
}

test('切换范围：只更新今天以下，滚动位置保持；从折叠进入时定位到历史', async () => {
  const dom = fakeDom();
  const events = [
    { id: 'a', type: 'vocab.round', status: 'occurred', at: at(2026, 11, 17, 21) },
    { id: 'b', type: 'vocab.round', status: 'occurred', at: at(2026, 11, 16, 21) },
  ];
  reset(NOV18_2358, base({ events }));
  LF._setNow(NOV18_2358);
  LF.mount(dom.el);
  await new Promise((r) => setTimeout(r, 0));
  assert.match(dom.bodies['#lfBody'].innerHTML, /还有 2 条/);
  assert.match(dom.bodies['#lfBody'].innerHTML, /今天没什么大事/);
  assert.match(dom.bodies['#lfCurrent'].innerHTML, /此刻/);

  const currentBefore = dom.bodies['#lfCurrent'].innerHTML;
  await LF.setRange('near', { toHistory: true });
  assert.equal(dom.bodies['#lfCurrent'].innerHTML, currentBefore, '此刻不重新生成');
  assert.match(dom.bodies['#lfBody'].innerHTML, /11 月 17 日/);
  assert.match(dom.bodies['#lfBody'].innerHTML, /11 月 16 日/);
  assert.ok(dom.calls.includes(300 + 420 - 12), '定位到历史区域');

  await LF.setRange('today');
  assert.ok(dom.calls.includes(420), '切回今天恢复原滚动位置');
});
