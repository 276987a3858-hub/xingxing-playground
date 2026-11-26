/* P2-a：统一调度器隔离测试（内存存储 + 模拟时钟） */
import test from 'node:test';
import assert from 'node:assert/strict';
import '../../public/shared/life-scheduler.js';

const S = globalThis.LifeScheduler;

function mem() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _map: m,
  };
}

const DAY = new Date(2026, 10, 17, 21, 0).getTime(); // 晚间，非静默
const MORNING = new Date(2026, 10, 17, 9, 0).getTime(); // 上午，留足同日内推进空间

function setup(now) {
  S._reset();
  const st = mem();
  S._setStorage({ local: st });
  let t = now;
  S._now(() => t);
  S._visible(() => true);
  return { st, setNow: (v) => { t = v; }, advance: (ms) => { t += ms; }, now: () => t };
}

test('可见时执行，页面隐藏时不执行', async () => {
  const env = setup(DAY);
  let calls = 0;
  S.register({ id: 't1', everyMs: 1, priority: 'user', run: async () => { calls++; return null; } });
  await S.tick();
  assert.equal(calls, 1);
  S._visible(() => false);
  env.advance(1000);
  const r = await S.tick();
  assert.equal(calls, 1, '隐藏时不得执行');
  assert.equal(r.visible, false);
});

test('按任务间隔跳过，不重复执行', async () => {
  const env = setup(DAY);
  let calls = 0;
  S.register({ id: 't2', everyMs: 60000, priority: 'user', run: async () => { calls++; return null; } });
  await S.tick();
  env.advance(1000);
  const r = await S.tick();
  assert.equal(calls, 1);
  assert.deepEqual(r.skipped, ['t2:interval']);
  env.advance(60000);
  await S.tick();
  assert.equal(calls, 2);
});

test('多标签锁：他人持锁未过期则跳过，过期后可抢', async () => {
  const env = setup(DAY);
  let calls = 0;
  S.register({ id: 't3', everyMs: 1, priority: 'user', run: async () => { calls++; return null; } });
  env.st.setItem(S._keys.LOCK_KEY, JSON.stringify({ sid: 'other', at: env.now() - 1000 }));
  const r = await S.tick();
  assert.equal(r.locked, true);
  assert.equal(calls, 0);

  // 锁过期：超过 TTL 后可以接管（异常关闭不会永久锁死）
  env.st.setItem(S._keys.LOCK_KEY, JSON.stringify({ sid: 'other', at: env.now() - S._keys.LOCK_TTL - 1 }));
  env.advance(10);
  await S.tick();
  assert.equal(calls, 1);
  assert.equal(S._readLock(), null, '执行完必须释放锁');
});

test('锁只能由持有者释放', () => {
  const env = setup(DAY);
  assert.equal(S._acquireLock(env.now(), 'a'), true);
  assert.equal(S._acquireLock(env.now() + 1, 'b'), false);
  S._releaseLock('b');
  assert.equal(S._readLock().sid, 'a');
  S._releaseLock('a');
  assert.equal(S._readLock(), null);
});

test('ambient：每日 15 条上限 + 15 分钟冷却', async () => {
  const env = setup(MORNING);
  let produced = 0;
  S.register({ id: 'a1', everyMs: 1, priority: 'ambient', run: async () => { produced++; return { ok: true }; } });

  await S.tick();
  assert.equal(produced, 1);
  assert.equal(S.budget(env.now()).count, 1);

  // 冷却中（未满 15 分钟）：即使间隔已到也跳过
  env.advance(10 * 60000);
  let r = await S.tick();
  assert.equal(produced, 1);
  assert.deepEqual(r.skipped, ['a1:budget']);

  // 冷却结束（15 分钟）
  env.advance(10 * 60000);
  await S.tick();
  assert.equal(produced, 2);

  // 一路到每日上限 15
  for (let i = 0; i < 13; i++) { env.advance(15 * 60000); await S.tick(); }
  assert.equal(produced, 15);
  assert.equal(S.budget(env.now()).count, 15);

  // 达到上限后不再产出
  env.advance(15 * 60000);
  r = await S.tick();
  assert.equal(produced, 15);
  assert.deepEqual(r.skipped, ['a1:budget']);
});

test('无产出不消耗预算', async () => {
  const env = setup(MORNING);
  S.register({ id: 'a2', everyMs: 1, priority: 'ambient', run: async () => null });
  for (let i = 0; i < 3; i++) { await S.tick(); env.advance(1000); }
  const b = S.budget(env.now());
  assert.equal(b.count, 0);
  assert.equal(b.canUse, true);
});

test('静默时段禁止 ambient，但不影响用户级提醒', async () => {
  const quiet = new Date(2026, 10, 17, 23, 45).getTime();
  const env = setup(quiet);
  let ambient = 0, user = 0;
  S.register({ id: 'q-ambient', everyMs: 1, priority: 'ambient', run: async () => { ambient++; return { ok: 1 }; } });
  S.register({ id: 'q-user', everyMs: 1, priority: 'user', run: async () => { user++; return { ok: 1 }; } });
  const r = await S.tick();
  assert.equal(ambient, 0);
  assert.equal(user, 1, '用户明确设置的提醒不受静默时段限制');
  assert.ok(r.skipped.indexOf('q-ambient:budget') !== -1);
});

test('静默时段边界：23:29 允许，23:30 禁止，07:29 禁止，07:30 允许', () => {
  const at = (h, m) => new Date(2026, 10, 17, h, m).getTime();
  assert.equal(S.budget(at(23, 29)).quiet, false);
  assert.equal(S.budget(at(23, 30)).quiet, true);
  assert.equal(S.budget(new Date(2026, 10, 18, 7, 29).getTime()).quiet, true);
  assert.equal(S.budget(new Date(2026, 10, 18, 7, 30).getTime()).quiet, false);
});

test('跨天后重新获得每日额度', async () => {
  const env = setup(DAY);
  let n = 0;
  S.register({ id: 'a3', everyMs: 1, priority: 'ambient', run: async () => { n++; return { ok: 1 }; } });
  await S.tick();
  assert.equal(S.budget(env.now()).count, 1);
  env.setNow(new Date(2026, 10, 18, 12, 0).getTime());
  await S.tick();
  assert.equal(n, 2, '跨天应重置配额');
  assert.equal(S.budget(env.now()).count, 1);
});

test('补检限频，避免 visible 与 pageshow 连击', async () => {
  const env = setup(DAY);
  let calls = 0;
  S.register({ id: 'c1', everyMs: 1, priority: 'user', run: async () => { calls++; return null; } });
  const r1 = await S.catchUp();
  assert.ok(Array.isArray(r1.ran));
  env.advance(1000);
  const r2 = await S.catchUp();
  assert.deepEqual(r2.skipped, ['catchup:rate']);
  assert.equal(calls, 1);
});

test('任务抛错不影响其它任务，且不写坏状态', async () => {
  const env = setup(DAY);
  let ok = 0;
  S.register({ id: 'bad', everyMs: 1, priority: 'user', run: async () => { throw new Error('boom'); } });
  S.register({ id: 'good', everyMs: 1, priority: 'user', run: async () => { ok++; return null; } });
  const r = await S.tick();
  assert.equal(ok, 1);
  assert.ok(r.skipped.indexOf('bad:error') !== -1);
  assert.equal(S._readLock(), null);
});

test('通知出口只记录，不发请求', async () => {
  const env = setup(DAY);
  const got = [];
  S.setNotifier((ev) => got.push(ev));
  S.notify({ id: 'n1', type: 'remind' });
  assert.equal(got.length, 1);
  assert.equal(S._state().notified.length, 1);
});

/* ---------------- P2-b：迁移后的调度语义 ---------------- */

test('user 级任务（未来信）不消耗 ambient 预算，静默时段也照常执行', async () => {
  const NIGHT = new Date(2026, 10, 17, 2, 0).getTime(); // 02:00 静默时段
  const env = setup(NIGHT);
  let letter = 0, idle = 0;
  S.register({ id: 'room.futureLetter', everyMs: 1, priority: 'user', run: async () => { letter++; return null; } });
  S.register({ id: 'room.idle', everyMs: 1, priority: 'ambient', run: async () => { idle++; return { type: 'idle' }; } });
  await S.tick();
  assert.equal(letter, 1, '静默时段不得延迟未来信');
  assert.equal(idle, 0, '静默时段不产生自主互动');
  assert.equal(S._state().ambient.count, 0, '未来信不消耗 ambient 额度');
});

test('空闲互动只在真正产出后消耗额度，失败不计数', async () => {
  const env = setup(MORNING);
  let mode = 'fail';
  S.register({
    id: 'room.idle', everyMs: 1, priority: 'ambient',
    run: async () => (mode === 'ok' ? { type: 'idle' } : null),
  });
  await S.tick();
  assert.equal(S.budget(env.now()).count, 0, '失败/无产出不消耗');
  mode = 'ok';
  env.advance(60000);
  await S.tick();
  assert.equal(S.budget(env.now()).count, 1);
  env.advance(60000);
  await S.tick();
  assert.equal(S.budget(env.now()).count, 1, '冷却期内不再产出');
});

test('长耗时 ambient 任务执行期间持锁，其他标签无法同时进入', async () => {
  const env = setup(MORNING);
  let release;
  const gate = new Promise((r) => { release = r; });
  S.register({ id: 'room.idle', everyMs: 1, priority: 'ambient', run: async () => { await gate; return { type: 'idle' }; } });
  const p = S.tick();
  await Promise.resolve();
  const lock = S._readLock();
  assert.ok(lock && typeof lock.sid === 'string', '执行期间必须持锁');
  const other = S._acquireLock(env.now(), 'other-tab');
  assert.equal(other, false, '他人持锁未过期时不得同时执行');
  release();
  await p;
  assert.equal(S._readLock(), null, '结束后释放');
});
