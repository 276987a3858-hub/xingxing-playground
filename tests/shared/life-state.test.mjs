/* P3：生活状态层隔离测试（内存存储 + 注入读取器，不接触真实用户数据） */
import test from 'node:test';
import assert from 'node:assert/strict';
import '../../public/shared/life-clock.js';
import '../../public/shared/life-state.js';
import '../../public/shared/life-context.js';

const LS = globalThis.LifeState;
const LC = globalThis.LifeContext;

const NOW = new Date(2026, 10, 17, 21, 10).getTime(); // 2026-11-17 周二 21:10
const TODAY = '2026-11-17';
const YESTERDAY = '2026-11-16';

function mem() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _map: m,
  };
}

function setup(data, opts) {
  opts = opts || {};
  LS._reset();
  const st = mem();
  Object.keys(data || {}).forEach((k) => st.setItem(k, JSON.stringify(data[k])));
  LS._setProviders({
    storage: st,
    tasks: opts.tasks === undefined ? null : opts.tasks,
    letters: opts.letters === undefined ? null : opts.letters,
  });
  return st;
}

const T = (o) => Object.assign({ id: 't1', title: '洗头', date: TODAY, time: '19:30', status: 'pending' }, o);

/* ---------------- 待办 ---------------- */

test('待办：未完成=planned，已完成=completed，已取消不进入状态', async () => {
  setup({}, {
    tasks: async () => [
      T({ id: 'a', date: TODAY }),
      T({ id: 'b', status: 'done', completedAt: NOW - 3600000 }),
      T({ id: 'c', status: 'cancelled' }),
    ],
  });
  const s = await LS.refresh({ now: NOW });
  const byId = Object.fromEntries(s.items.map((i) => [i.id, i.state]));
  assert.equal(byId['butler:task:a'], 'planned');
  assert.equal(byId['butler:task:b'], 'completed');
  assert.equal(byId['butler:task:c'], undefined, '取消的不进入当前状态');
  assert.equal(s.counts.planned, 1);
  assert.equal(s.counts.completed, 1);
});

test('待办：延期后只认新日期，不残留旧计划', async () => {
  setup({}, {
    tasks: async () => [T({ id: 'a', date: '2026-11-20', time: '09:00' })],
  });
  const s = await LS.refresh({ now: NOW });
  const it = s.items.find((i) => i.id === 'butler:task:a');
  assert.equal(it.state, 'planned');
  assert.equal(new Date(it.at).getDate(), 20, '计划时间应为新日期');
});

test('待办：过了日期仍未完成 → expired，不当成当前计划', async () => {
  setup({}, { tasks: async () => [T({ id: 'a', date: YESTERDAY })] });
  const s = await LS.refresh({ now: NOW });
  assert.equal(s.items[0].state, 'expired');
  assert.equal(s.counts.planned, 0);
});

test('待办：读取失败不猜，标为 unknown', async () => {
  setup({}, { tasks: async () => { throw new Error('db blocked'); } });
  const s = await LS.refresh({ now: NOW });
  assert.equal(s.sources.butler, 'unknown');
  assert.equal(s.items.length, 0);
});

test('待办：没有真实完成时刻的 done 不算「最近完成」', async () => {
  setup({}, { tasks: async () => [T({ id: 'a', status: 'done' })] });
  const s = await LS.refresh({ now: NOW });
  assert.equal(s.items.length, 0);
});

/* ---------------- 背词 / 读书 / 电台 / 游戏 ---------------- */

test('背词：只认 history 记录的完成轮次，不推断进行中', async () => {
  setup({ 'ylxh.vocab.v1': { history: [{ at: NOW - 2 * 3600000, size: 10 }, { at: NOW - 10 * 86400000 }], stats: { rounds: 2 } } });
  const s = await LS.refresh({ now: NOW });
  assert.equal(s.items.filter((i) => i.source === 'vocab').length, 1, '只保留 3 天内的完成记录');
  assert.equal(s.items[0].state, 'completed');
  assert.equal(s.counts.ongoing, 0, '没有可靠进行中字段 → 不伪造 ongoing');
});

test('读书：在读=ongoing，计划=planned，完成=completed', async () => {
  setup({
    'ylxh.radio.reading': {
      nowReading: 'bk_013',
      nextBookId: 'bk_020',
      books: [{ id: 'bk_013', status: 'reading' }, { id: 'bk_020', status: 'preparing' }, { id: 'bk_001', status: 'finished' }],
      history: [{ bookId: 'bk_015', finishedAt: NOW - 86400000 }],
    },
  });
  const s = await LS.refresh({ now: NOW });
  const st = s.items.filter((i) => i.source === 'reading').map((i) => i.state).sort();
  assert.deepEqual(st, ['completed', 'ongoing', 'planned']);
});

test('电台：有进度未完成=ongoing，completed=completed，仅打开不产生状态', async () => {
  setup({
    'ylxh.radio.progress': {
      e1: { position: 120, completed: false, updatedAt: NOW - 600000 },
      e2: { position: 600, completed: true, updatedAt: NOW - 3600000 },
      e3: { position: 0, completed: false, updatedAt: NOW - 600000 },
    },
  });
  const s = await LS.refresh({ now: NOW });
  const byId = Object.fromEntries(s.items.map((i) => [i.id, i.state]));
  assert.equal(byId['radio:episode:e1'], 'ongoing');
  assert.equal(byId['radio:episode:e2'], 'completed');
  assert.equal(byId['radio:episode:e3'], undefined);
});

test('游戏：只用既有完成存档，不推断历史', async () => {
  setup({ 'ylxh.playground.v1': { finished: { quiz: { at: NOW - 7200000 }, old: { at: NOW - 30 * 86400000 } } } });
  const s = await LS.refresh({ now: NOW });
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].state, 'completed');
  assert.equal(s.items[0].meta.game, 'quiz');
});

/* ---------------- 未来信 ---------------- */

test('未来信：未到期 planned / 到期未处理 ongoing / 已回信 completed / 失败不算完成', async () => {
  setup({}, {
    letters: async () => [
      { id: 1, status: 'sealed', openAt: NOW + 86400000 },
      { id: 2, status: 'sealed', openAt: NOW - 3600000 },
      { id: 3, status: 'opened', openedAt: NOW - 7200000, replyStatus: 'done' },
      { id: 4, status: 'opened', openedAt: NOW - 7200000, replyStatus: 'failed' },
    ],
  });
  const s = await LS.refresh({ now: NOW });
  const byId = Object.fromEntries(s.items.map((i) => [i.id, i.state]));
  assert.equal(byId['room:letter:1'], 'planned');
  assert.equal(byId['room:letter:2'], 'ongoing');
  assert.equal(byId['room:letter:3'], 'completed');
  assert.notEqual(byId['room:letter:4'], 'completed');
});

/* ---------------- 缓存 / 幂等 / 只读 / 隐私 ---------------- */

test('重复 refresh 幂等，id 稳定且不重复', async () => {
  setup({ 'ylxh.vocab.v1': { history: [{ at: NOW - 3600000 }] } }, { tasks: async () => [T({ id: 'a' })] });
  const a = await LS.refresh({ now: NOW });
  const b = await LS.refresh({ now: NOW });
  assert.deepEqual(a.items.map((i) => i.id).sort(), b.items.map((i) => i.id).sort());
  assert.equal(new Set(b.items.map((i) => i.id)).size, b.items.length);
});

test('refresh 只读：源存档逐字未变', async () => {
  const raw = { history: [{ at: NOW - 3600000 }] };
  const st = setup({ 'ylxh.vocab.v1': raw }, { tasks: async () => [T({ id: 'a' })] });
  await LS.refresh({ now: NOW });
  assert.deepEqual(JSON.parse(st.getItem('ylxh.vocab.v1')), raw);
});

test('缓存可同步读取，且不含标题/金额字段', async () => {
  setup({}, { tasks: async () => [T({ id: 'a', title: '房租 3800 元' })] });
  await LS.refresh({ now: NOW });
  const c = LS.cached();
  assert.ok(c && Array.isArray(c.items));
  const text = JSON.stringify(c.items);
  assert.ok(text.indexOf('房租') === -1, '不得缓存待办标题');
  assert.ok(text.indexOf('3800') === -1, '不得缓存金额');
});

test('条目上限 40 条', async () => {
  const many = [];
  for (let i = 0; i < 80; i++) many.push(T({ id: 'x' + i }));
  setup({}, { tasks: async () => many });
  const s = await LS.refresh({ now: NOW });
  assert.equal(s.items.length, 40);
});

/* ---------------- 与 LifeContext 协作 ---------------- */

function presence(over) {
  return Object.assign({
    visitKind: 'returned', navType: 'navigate', lastReturnFrom: null,
    lastVisitAt: NOW - 40 * 3600000, lastActiveAt: NOW - 3600000,
    lastInteractionAt: NOW - 26 * 3600000, lastLeaveAt: null,
  }, over || {});
}

test('LifeContext：planned 不会被说成完成', async () => {
  const snap = LC.snapshot({ now: NOW, presence: presence(), events: [], state: { counts: { planned: 2, ongoing: 0, completed: 0, expired: 0 } } });
  const text = LC.render(snap);
  assert.ok(text.indexOf('排在计划里') !== -1, text);
  assert.ok(text.indexOf('最近完成了') === -1, text);
});

test('LifeContext：过期事项不作为当前计划', async () => {
  const snap = LC.snapshot({ now: NOW, presence: presence(), events: [], state: { counts: { planned: 0, ongoing: 0, completed: 0, expired: 1 } } });
  const text = LC.render(snap);
  assert.ok(text.indexOf('过期') !== -1, text);
  assert.ok(text.indexOf('排在计划里') === -1, text);
});

test('LifeContext：普通闲聊不塞生活清单', () => {
  const snap = LC.snapshot({
    now: NOW,
    presence: presence({ visitKind: 'same', lastInteractionAt: NOW - 5 * 60000 }),
    events: [],
    state: { counts: { planned: 3, ongoing: 1, completed: 2, expired: 0 } },
  });
  assert.equal(LC.shouldInject(snap), false, '刚聊过就不必注入');
});

test('LifeContext：渲染只出现计数，不出现标题与隐私数字', async () => {
  setup(
    { 'ylxh.vocab.v1': { history: [{ at: NOW - 3600000 }] } },
    { tasks: async () => [T({ id: 'a', title: '买药 128 元' }), T({ id: 'b', date: TODAY, time: '22:00' })] }
  );
  const st = await LS.refresh({ now: NOW });
  const snap = LC.snapshot({ now: NOW, presence: presence(), events: [], state: st });
  const text = LC.render(snap);
  assert.ok(text.indexOf('买药') === -1, text);
  assert.ok(text.indexOf('128') === -1, text);
  assert.ok(text.length <= 120, '长度上限 ' + text.length);
});
