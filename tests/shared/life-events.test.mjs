/* P1-b：生活事件层隔离测试（内存存储，不读取真实用户数据库） */
import test from 'node:test';
import assert from 'node:assert/strict';
import '../../public/shared/life-clock.js';
import '../../public/shared/life-events.js';

const LE = globalThis.LifeEvents;

function mem(seed) {
  const m = new Map(Object.entries(seed || {}));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _map: m,
  };
}

function fresh(seed) {
  LE._reset();
  const st = mem(seed);
  LE._setStorage({ local: st });
  return st;
}

const T0 = new Date(2026, 10, 17, 21, 0).getTime();

test('有效事件写入成功且幂等', () => {
  fresh();
  const r1 = LE.record({ id: 'butler:task:a:done:1', at: T0, source: 'butler', type: 'task.done', status: 'occurred', title: '洗头' });
  assert.deepEqual([r1.ok, r1.added], [true, true]);
  const r2 = LE.record({ id: 'butler:task:a:done:1', at: T0, source: 'butler', type: 'task.done' });
  assert.deepEqual([r2.ok, r2.added, r2.reason], [true, false, 'duplicate']);
  assert.equal(LE.list().length, 1);
});

test('缺少 id/type/at 不写入', () => {
  fresh();
  assert.equal(LE.record({ at: T0, type: 'task.done' }).ok, false);
  assert.equal(LE.record({ id: 'x', at: T0 }).ok, false);
  assert.equal(LE.record({ id: 'x', type: 'task.done' }).ok, false);
  assert.equal(LE.list().length, 0);
});

test('planned / ongoing 不算发生，但会被保存', () => {
  fresh();
  LE.record({ id: 'p1', at: T0, source: 'butler', type: 'task.add', status: 'planned' });
  LE.record({ id: 'o1', at: T0 + 1, source: 'radio', type: 'radio.episode', status: 'ongoing' });
  LE.record({ id: 'd1', at: T0 + 2, source: 'butler', type: 'task.done' });
  assert.equal(LE.list().length, 3);
  const sum = LE.summarySince(T0 - 1000, T0 + 10000);
  assert.equal(sum.length, 1);
  assert.equal(sum[0].type, 'task.done');
  assert.equal(sum[0].title, undefined, '摘要不得携带标题');
});

test('超过 200 条只保留最近 200 条', () => {
  fresh();
  for (let i = 0; i < 240; i++) {
    LE.record({ id: 'e' + i, at: T0 + i, source: 'vocab', type: 'vocab.round' });
  }
  const items = LE.list();
  assert.equal(items.length, 200);
  assert.equal(items[items.length - 1].id, 'e239');
});

test('超过 30 天的事件被裁剪', () => {
  fresh();
  LE.record({ id: 'old', at: T0 - 40 * 86400000, source: 'room', type: 'diary.write' });
  LE.record({ id: 'new', at: T0, source: 'room', type: 'diary.write' });
  const ids = LE.list().map((x) => x.id);
  assert.equal(ids.includes('new'), true);
  assert.equal(ids.includes('old'), false);
});

test('存储写入失败不返回成功', () => {
  LE._reset();
  const st = mem();
  st.setItem = () => { throw new Error('quota'); };
  LE._setStorage({ local: st });
  const r = LE.record({ id: 'fail', at: T0, type: 'task.done', source: 'butler' });
  assert.equal(r.ok, false);
  assert.equal(r.added, false);
  assert.equal(LE.list().length, 0);
});

test('从既有存档同步：只同步真实完成，不推断时刻', () => {
  const seed = {
    'ylxh.playground.v1': JSON.stringify({ finished: { quiz: { best: 10, at: T0 }, puzzle: { at: T0 + 5 } } }),
    'ylxh.vocab.v1': JSON.stringify({ history: [{ at: T0 + 10, size: 8 }, { at: null, size: 3 }] }),
    'ylxh.radio.progress': JSON.stringify({
      ep1: { position: 120, duration: 120, completed: true, updatedAt: T0 + 20 },
      ep2: { position: 30, duration: 120, completed: false, updatedAt: T0 + 30 },
    }),
    'ylxh.radio.reading': JSON.stringify({ history: [{ bookId: 'b1', finishedAt: T0 + 40 }] }),
  };
  fresh(seed);
  const r1 = LE.syncArchives(T0 + 100);
  assert.equal(r1.added, 5, 'quiz/puzzle/vocab/radio完成/读书，共 5 条');
  const types = LE.list().map((x) => x.type).sort();
  assert.deepEqual(types, ['game.finish', 'game.finish', 'radio.episode', 'reading.finish', 'vocab.round']);
  const r2 = LE.syncArchives(T0 + 200);
  assert.equal(r2.added, 0, '重复同步幂等');
});

test('进行中的播放不算完成', () => {
  fresh({
    'ylxh.radio.progress': JSON.stringify({ ep: { position: 60, duration: 100, completed: false, updatedAt: T0 } }),
  });
  const r = LE.syncArchives(T0 + 10);
  assert.equal(r.added, 0);
  assert.equal(LE.list().length, 0);
});

test('summarySince 按时间窗过滤', () => {
  fresh();
  LE.record({ id: 'a', at: T0 - 3600000, source: 'butler', type: 'task.done' });
  LE.record({ id: 'b', at: T0, source: 'butler', type: 'task.done' });
  assert.equal(LE.summarySince(T0 - 1000, T0 + 1000).length, 1);
  assert.equal(LE.summarySince(T0 - 7200000, T0 + 1000).length, 2);
});

test('life:feed 通知：只有真正新增事件才派发一次', () => {
  fresh();
  const seen = [];
  const prevDispatch = globalThis.dispatchEvent;
  const prevCustom = globalThis.CustomEvent;
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } };
  globalThis.dispatchEvent = (e) => { seen.push(e.type); return true; };
  try {
    LE.record({ id: 'feed:1', at: T0, source: 'butler', type: 'task.done' });
    LE.record({ id: 'feed:1', at: T0, source: 'butler', type: 'task.done' }); // 幂等重复
    LE.record({ at: T0, type: 'task.done' });                                  // 缺 id，无效
  } finally {
    globalThis.dispatchEvent = prevDispatch;
    if (prevCustom === undefined) delete globalThis.CustomEvent;
    else globalThis.CustomEvent = prevCustom;
  }
  assert.deepEqual(seen, ['life:feed']);
  assert.equal(LE.list().length, 1);
});
