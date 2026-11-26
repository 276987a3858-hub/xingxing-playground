/* tests/shared/life-presence.test.mjs — S2 轻量时间状态（内存存储 + 可控时钟，不碰真实数据） */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../../public/shared/life-presence.js';

const LP = globalThis.LifePresence;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const PRESENCE_SRC = fs.readFileSync(path.join(ROOT, 'public/shared/life-presence.js'), 'utf8');
const INTENT_SRC = fs.readFileSync(path.join(ROOT, 'public/butler/butler-intent.js'), 'utf8');

const T0 = new Date(2026, 10, 17, 20, 0, 0, 0).getTime();
const min = (n) => n * 60 * 1000;

function makeStore(init) {
  const m = new Map(Object.entries(init || {}));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _map: m,
  };
}

// 建立一个隔离环境；state 为已存在的 localStorage 状态
function env(opts = {}) {
  LP._reset();
  const local = makeStore(opts.local || {});
  const session = makeStore(opts.session || {});
  let now = opts.now === undefined ? T0 : opts.now;
  LP._setStorage({ local, session });
  LP._now(() => now);
  LP._setNavType(() => opts.navType || 'navigate');
  LP._setTransition(() => opts.transition || '');
  return {
    local, session,
    setNow: (t) => { now = t; },
    getNow: () => now,
    state: () => JSON.parse(local.getItem(LP._keys.KEY) || 'null') || LP.snapshot(),
  };
}

function seed(patch) {
  return { [LP._keys.KEY]: JSON.stringify(Object.assign({
    v: 1, rev: 1, updatedAt: T0, tabs: {},
  }, patch)) };
}

/* P01 */
test('P01 无 sid、navigate、无候选 → fresh，且 boot 不写 lastActiveAt', () => {
  const e = env({ now: T0 });
  const s = LP.boot();
  assert.equal(s.visitKind, 'fresh');
  assert.equal(s.lastVisitAt, T0);
  assert.equal(s.lastActiveAt, null, 'boot 不得写 lastActiveAt');
  assert.equal(s.lastInteractionAt, null);
  assert.equal(s.lastLeaveAt, null);
  assert.equal(s.lastResolution, 'unresolved');
  assert.ok(e.state().tabs[LP.snapshot().visitSid], '需登记本标签');
});

/* P02 */
test('P02 刷新（reload）→ refresh，丢弃候选，lastVisitAt 与 lastLeaveAt 不变', () => {
  const sid = 's_old';
  const e = env({
    now: T0 + min(30),
    navType: 'reload',
    session: { [LP._keys.SID_KEY]: sid, [LP._keys.SID_AT_KEY]: String(T0) },
    local: seed({
      lastVisitAt: T0,
      lastActiveAt: T0 + min(20),
      lastLeaveAt: T0 - min(600),
      pendingLeave: { at: T0 + min(29), evidence: 'pagehide', persisted: false, by: sid },
    }),
  });
  const s = LP.boot();
  assert.equal(s.visitKind, 'refresh');
  assert.equal(s.lastVisitAt, T0, '刷新不算新访问');
  assert.equal(s.lastLeaveAt, T0 - min(600), '刷新不得写离开时间');
  assert.equal(s.pendingLeave, null, '候选必须丢弃');
  assert.equal(s.lastActiveAt, T0 + min(20));
});

/* P03 */
test('P03 back_forward → returned，丢弃候选，不算离开', () => {
  const sid = 's_bf';
  env({
    now: T0,
    navType: 'back_forward',
    session: { [LP._keys.SID_KEY]: sid, [LP._keys.SID_AT_KEY]: String(T0 - min(5)) },
    local: seed({ lastVisitAt: T0 - min(10), pendingLeave: { at: T0 - min(1), evidence: 'pagehide', by: sid } }),
  });
  const s = LP.boot();
  assert.equal(s.visitKind, 'returned');
  assert.equal(s.lastVisitAt, T0, '返回房间要更新访问时间');
  assert.equal(s.lastLeaveAt, null);
  assert.equal(s.pendingLeave, null);
});

/* P04 */
test('P04 pagehide(persisted) → 不产生候选，也不确认离开', () => {
  env({ now: T0 });
  LP.boot();
  LP.leaving('bfcache');
  const s = LP.snapshot();
  assert.equal(s.pendingLeave, null);
  assert.equal(s.lastLeaveAt, null);
});

/* P05 */
test('P05 从游乐场返回 → 用候选时间定案', () => {
  const sid = 's_pl';
  const leaveAt = T0 - min(40);
  env({
    now: T0,
    navType: 'navigate',
    transition: 'to-home',
    session: { [LP._keys.SID_KEY]: sid, [LP._keys.SID_AT_KEY]: String(T0 - min(120)) },
    local: seed({ lastVisitAt: T0 - min(180), pendingLeave: { at: leaveAt, evidence: 'pagehide', persisted: false, by: sid } }),
  });
  const s = LP.boot();
  assert.equal(s.visitKind, 'returned');
  assert.equal(s.lastReturnFrom, 'playground');
  assert.equal(s.lastLeaveAt, leaveAt);
  assert.notEqual(s.lastLeaveAt, T0, '不能用 boot 时刻替代');
  assert.equal(s.leaveCertain, true);
  assert.equal(s.lastLeaveFrom, 'playground');
});

/* P06 */
test('P06 同标签关闭后重开 → 用自己的候选定案', () => {
  const sid = 's_same';
  const leaveAt = T0 - min(25);
  env({
    now: T0,
    navType: 'navigate',
    session: { [LP._keys.SID_KEY]: sid, [LP._keys.SID_AT_KEY]: String(T0 - min(60)) },
    local: seed({ lastVisitAt: T0 - min(90), pendingLeave: { at: leaveAt, evidence: 'pagehide', by: sid } }),
  });
  const s = LP.boot();
  assert.equal(s.visitKind, 'returned');
  assert.equal(s.lastLeaveAt, leaveAt);
  assert.equal(s.leaveCertain, true);
});

/* P07 */
test('P07 新标签页 + 旧标签仍活跃 → fresh，不误判旧标签关闭', () => {
  env({
    now: T0,
    navType: 'navigate',
    local: seed({
      lastVisitAt: T0 - min(120),
      lastLeaveAt: T0 - min(600),
      tabs: { s_other: { lastSeenAt: T0 - min(2) } },
      pendingLeave: { at: T0 - min(5), evidence: 'pagehide', by: 's_other' },
    }),
  });
  const s = LP.boot();
  assert.equal(s.visitKind, 'fresh');
  assert.equal(s.lastLeaveAt, T0 - min(600), '不得覆盖为旧标签的候选时间');
  assert.equal(s.lastResolution, 'tab-alive');
  assert.ok(s.pendingLeave, '他人的候选原样保留');
});

/* P08 */
test('P08 旧标签登记已过期 → 定案候选时间', () => {
  const leaveAt = T0 - min(20);
  env({
    now: T0,
    navType: 'navigate',
    local: seed({
      lastLeaveAt: null,
      tabs: { s_gone: { lastSeenAt: T0 - min(11) } },
      pendingLeave: { at: leaveAt, evidence: 'pagehide', by: 's_gone' },
    }),
  });
  const s = LP.boot();
  assert.equal(s.visitKind, 'fresh');
  assert.equal(s.lastLeaveAt, leaveAt);
  assert.equal(s.leaveCertain, true);
});

/* P09 */
test('P09 异常退出（无 sid、无候选、无活跃标签）→ 不推测离开时间', () => {
  env({
    now: T0,
    navType: 'navigate',
    local: seed({ lastVisitAt: T0 - min(900), lastLeaveAt: T0 - min(3000), lastActiveAt: T0 - min(1400) }),
  });
  const s = LP.boot();
  assert.equal(s.lastLeaveAt, T0 - min(3000), '保留上次真实值，不写 now');
  assert.equal(s.leaveUnresolved.reason, 'no-evidence');
  assert.equal(s.leaveUnresolved.at, T0);
  assert.equal(s.lastResolution, 'unresolved');
});

/* P10 */
test('P10 无 sid 但仍有活跃标签 + 他人候选 → 不清候选、不写离开', () => {
  env({
    now: T0,
    navType: 'navigate',
    local: seed({
      lastLeaveAt: null,
      tabs: { s_alive: { lastSeenAt: T0 - min(1) } },
      pendingLeave: { at: T0 - min(3), evidence: 'hidden', by: 's_alive' },
    }),
  });
  const s = LP.boot();
  assert.equal(s.lastLeaveAt, null);
  assert.equal(s.lastResolution, 'tab-alive');
  assert.equal(s.pendingLeave.at, T0 - min(3));
});

/* P11 */
test('P11 hidden 后 visible → 候选作废，lastHiddenAt 保留，lastActiveAt 不变', () => {
  env({ now: T0 });
  LP.boot();
  LP.active('input');
  const activeAt = LP.snapshot().lastActiveAt;
  assert.equal(activeAt, T0);

  LP.hidden();
  assert.equal(LP.snapshot().lastHiddenAt, T0);
  assert.ok(LP.snapshot().pendingLeave);

  // 20 秒后回到前台
  LP._now(() => T0 + 20000);
  LP.visible();
  const s = LP.snapshot();
  assert.equal(s.pendingLeave, null, '可见后候选作废');
  assert.equal(s.lastHiddenAt, T0, '隐藏时间保留');
  assert.equal(s.lastActiveAt, activeAt, 'visible 不得更新 lastActiveAt');
  assert.equal(s.lastLeaveAt, null);
});

/* P12 */
test('P12 hidden 只写隐藏时间与候选，不写离开时间', () => {
  env({ now: T0 });
  LP.boot();
  LP.hidden();
  const s = LP.snapshot();
  assert.equal(s.lastHiddenAt, T0);
  assert.equal(s.pendingLeave.evidence, 'hidden');
  assert.equal(s.pendingLeave.by, s.visitSid);
  assert.equal(s.lastLeaveAt, null);
});

/* P13 */
test('P13 interaction → 同时更新 lastInteractionAt 与 lastActiveAt', () => {
  env({ now: T0 });
  LP.boot();
  LP._now(() => T0 + min(3));
  LP.interaction({ messageId: 42 });
  const s = LP.snapshot();
  assert.equal(s.lastInteractionAt, T0 + min(3));
  assert.equal(s.lastActiveAt, T0 + min(3));
  assert.equal(s.activeSource, 'message');
});

/* P14 */
test('P14 发送失败路径不调用 interaction → lastInteractionAt 不变', () => {
  env({ now: T0 });
  LP.boot();
  LP.active('click'); // 点过发送按钮但失败
  assert.equal(LP.snapshot().lastInteractionAt, null);
  // 源码契约：interaction 只在用户消息成功落库之后
  const saveIdx = APP_SRC.indexOf("userMessage.id = await addToStore('messages', userMessage)");
  const callIdx = APP_SRC.indexOf('LifePresence.interaction(');
  assert.ok(saveIdx > 0 && callIdx > saveIdx, 'interaction() 必须位于 addToStore 成功之后');
  assert.equal((APP_SRC.match(/LifePresence\.interaction\(/g) || []).length, 1, '唯一入口');
});

/* P15 */
test('P15 多标签：旧快照不能覆盖较新的时间字段', () => {
  // 模拟 A 标签已把 lastActiveAt 写成 100（相对值），B 标签仍持旧内存快照
  env({ now: T0, local: seed({ lastActiveAt: T0 + min(100), rev: 5 }) });
  LP.boot();
  // B 用更早的时间写 active（节流窗口内）
  LP._now(() => T0 + min(4));
  LP.active('input');
  const s = LP.snapshot();
  assert.equal(s.lastActiveAt, T0 + min(100), '较新的时间必须保留');
  assert.ok(s.rev >= 6, 'rev 递增');
});

/* P16 */
test('P16 存储异常 / JSON 损坏 → 安全降级，不抛错', () => {
  LP._reset();
  const broken = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
    removeItem() { throw new Error('denied'); },
  };
  LP._setStorage({ local: broken, session: broken });
  LP._now(() => T0);
  LP._setNavType(() => 'navigate');
  LP._setTransition(() => '');
  const s = LP.boot();
  assert.equal(s.visitKind, 'fresh');
  assert.equal(s.lastVisitAt, T0, '内存副本继续服务');
  LP.active('input');
  LP.interaction();
  LP.hidden();
  LP.visible();
  LP.leaving('pagehide');
  assert.ok(LP.snapshot());

  // JSON 损坏
  const e = env({ now: T0, local: { [LP._keys.KEY]: '{not json' } });
  const s2 = LP.boot();
  assert.equal(s2.visitKind, 'fresh');
  assert.equal(s2.rev, 1, '损坏后重建，而不是继承脏 rev');
  assert.ok(e.state().lastVisitAt === T0);
});

/* P17 */
test('P17 标签登记超过 10 分钟视为消失，参与离开定案', () => {
  const leaveAt = T0 - min(13);
  env({
    now: T0,
    navType: 'navigate',
    local: seed({
      tabs: { s_stale: { lastSeenAt: T0 - min(10) - 1000 } },
      pendingLeave: { at: leaveAt, evidence: 'pagehide', by: 's_stale' },
    }),
  });
  const s = LP.boot();
  assert.equal(s.lastLeaveAt, leaveAt);
  assert.equal(s.tabs.s_stale, undefined, '过期登记应被清理');
});

/* P18 */
test('P18 boot 幂等：重复调用不再改 rev 与访问时间', () => {
  env({ now: T0 });
  const first = LP.boot();
  const rev1 = first.rev;
  LP._now(() => T0 + min(5));
  const second = LP.boot();
  assert.equal(second.rev, rev1);
  assert.equal(second.lastVisitAt, first.lastVisitAt);
  assert.equal(second.lastActiveAt, null);
});

/* P19 */
test('P19 导航点击计入 lastActiveAt；程序化 showPage 不计入', () => {
  // 源码契约：只用精确委托，不监听全局 click，也不在 showPage 内挂钩子
  assert.match(APP_SRC, /\[onclick\^="showPage"\]/, '需匹配导航按钮的精确选择器');
  assert.match(APP_SRC, /LifePresence\.active\('nav'\)/);
  const showPageBody = APP_SRC.slice(APP_SRC.indexOf('function showPage(id)'), APP_SRC.indexOf('function checkProxy'));
  assert.ok(showPageBody.length > 0);
  assert.ok(!/LifePresence/.test(showPageBody), 'showPage 内不得有 active 钩子（app.js:1041 是程序化调用）');
  assert.match(APP_SRC, /addEventListener\('click',[\s\S]{0,400}?\}, true\)/, '捕获阶段委托');

  // 行为契约：点击 → active('nav')；不点击 → 不变
  env({ now: T0 });
  LP.boot();
  assert.equal(LP.snapshot().lastActiveAt, null);
  LP.active('nav');
  assert.equal(LP.snapshot().lastActiveAt, T0);
  assert.equal(LP.snapshot().activeSource, 'nav');
});

/* P20 */
test('P20 宽限期：登记未过期时暂不定案，过期后才定案且用候选时间', () => {
  const leaveAt = T0 - min(6);
  const e = env({
    now: T0,
    navType: 'navigate',
    local: seed({
      tabs: { s_closing: { lastSeenAt: T0 - min(1) } },
      pendingLeave: { at: leaveAt, evidence: 'pagehide', by: 's_closing' },
    }),
  });
  const grace = LP.boot();
  assert.equal(grace.lastLeaveAt, null, '宽限期内不得定案');
  assert.equal(grace.lastResolution, 'tab-alive');
  assert.ok(grace.pendingLeave, '候选必须保留以待下次');

  // 宽限期后：同一份存储，登记已被推旧
  const raw = JSON.parse(e.local.getItem(LP._keys.KEY));
  raw.tabs.s_closing.lastSeenAt = T0 - min(11);
  raw.tabs = { s_closing: raw.tabs.s_closing };
  e.local.setItem(LP._keys.KEY, JSON.stringify(raw));

  LP._reset();
  LP._setStorage({ local: e.local, session: makeStore({}) });
  LP._now(() => T0 + min(1));
  LP._setNavType(() => 'navigate');
  LP._setTransition(() => '');
  const resolved = LP.boot();
  assert.equal(resolved.lastLeaveAt, leaveAt, '定案时间必须等于候选时间');
  assert.notEqual(resolved.lastLeaveAt, T0 + min(1), '不得用 boot 时刻替代');
  assert.equal(resolved.leaveCertain, true);
});

/* P21 */
test('P21 提醒链路不依赖 life-presence', () => {
  assert.ok(!/LifePresence|life-presence/.test(INTENT_SRC), 'butler-intent 不得引用 life-presence');
  const exp = Object.keys(LP).filter((k) => /remind|due/i.test(k));
  assert.deepEqual(exp, [], 'life-presence 不导出任何提醒相关接口');
  // 提醒只看任务自身字段
  assert.ok(/remindAt/.test(INTENT_SRC));
  assert.ok(!/lastLeaveAt|lastActiveAt/.test(INTENT_SRC));
  // 模块自身不读写 IndexedDB、不发请求
  assert.ok(!/indexedDB|fetch\(|XMLHttpRequest/.test(PRESENCE_SRC));
});

/* P22 */
test('P22 visit:false 不参与房间访问判定：不改 lastVisitAt / visitKind，不定案也不清候选', () => {
  const sid = 's_room';
  const leaveAt = T0 - min(3);
  env({
    now: T0,
    navType: 'navigate',
    transition: 'to-home',
    session: { [LP._keys.SID_KEY]: sid, [LP._keys.SID_AT_KEY]: String(T0 - min(10)) },
    local: seed({
      lastVisitAt: T0 - min(30),
      visitKind: 'returned',
      lastLeaveAt: T0 - min(500),
      pendingLeave: { at: leaveAt, evidence: 'pagehide', by: sid },
    }),
  });
  const s = LP.boot({ visit: false });
  assert.equal(s.visitScope, 'playground');
  assert.equal(s.lastVisitAt, T0 - min(30), '不得更新房间访问时间');
  assert.equal(s.visitKind, 'returned', '不得改写访问类型');
  assert.equal(s.lastLeaveAt, T0 - min(500), '不得定案离开时间');
  assert.equal(s.pendingLeave.at, leaveAt, '房间留下的候选必须原样保留');
  assert.equal(s.lastActiveAt, null, 'boot 仍不写 lastActiveAt');
});

/* P23 */
test('P23 visit:false 仍维护 sid 与标签登记；默认 boot() 行为完全不变', () => {
  const e = env({ now: T0, navType: 'navigate' });
  const s = LP.boot({ visit: false });
  assert.ok(s.visitSid, '必须确保 sid 可用');
  assert.ok(e.state().tabs[s.visitSid], '必须登记本标签');
  assert.equal(s.lastVisitAt, null, '非房间页不产生访问时间');
  assert.equal(s.visitKind, null);

  const e2 = env({ now: T0, navType: 'navigate' });
  const s2 = LP.boot();
  assert.equal(s2.visitKind, 'fresh');
  assert.equal(s2.visitScope, 'room');
  assert.equal(s2.lastVisitAt, T0, '默认参数仍走完整判定链');
  assert.ok(e2.state().tabs[s2.visitSid]);
});
