/* public/shared/life-scheduler.js — P2-a 统一轻量调度器
 * 单一时间源（LifeClock.now）、单 tick（可见时 60s）、单锁（多标签互斥）、单预算（ambient）。
 * 边界：
 *   - 不调用 AI、不写聊天消息；任务无事可做时直接返回；
 *   - 不改动/不替换任何既有定时器（未来信、空闲互动、电台、游戏计时全部保持原样）；
 *   - 不实现 Service Worker / Web Push / Cron / Agent，只预留 notify 出口。
 */
(function (root) {
  'use strict';

  var STATE_KEY = 'ylxh.sched.v1';
  var LOCK_KEY = 'ylxh.sched.lock.v1';
  var LOCK_TTL = 70 * 1000;          // > tick 间隔，避免同一轮被第二个标签抢走
  var TICK_MS = 60 * 1000;
  var AMBIENT_DAILY = 15;            // 每日自主互动上限（只计真正成功开口的消息；上限不是目标）
  var AMBIENT_COOLDOWN = 15 * 60 * 1000; // 两次自主互动之间的最短间隔
  var QUIET_START = 23 * 60 + 30;    // 23:30
  var QUIET_END = 7 * 60 + 30;       // 07:30
  var CATCHUP_MIN_GAP = 30 * 1000;   // 补检最短间隔，避免 pageshow + visible 连击

  var tasks = [];
  var timer = null;
  var running = false;
  var sid = null;
  var store = null;
  var nowFn = function () { return root.LifeClock ? root.LifeClock.now() : Date.now(); };
  var visibleFn = function () {
    if (typeof document === 'undefined') return true;
    return !document.hidden;
  };
  var onNotify = null;

  function wrap(getter) {
    return {
      get: function (k) { try { return getter().getItem(k); } catch (e) { return null; } },
      set: function (k, v) { try { getter().setItem(k, v); return true; } catch (e) { return false; } },
      del: function (k) { try { getter().removeItem(k); return true; } catch (e) { return false; } },
    };
  }
  function local() {
    if (!store) store = wrap(function () { return localStorage; });
    return store;
  }

  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }

  // 轻量调试日志（只输出判定原因与计数，不含任何聊天内容或私人数据）
  function dbg() {
    try { if (typeof console !== 'undefined' && console.debug) console.debug.apply(console, arguments); } catch (e) {}
  }

  function dayOf(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function emptyState() {
    return { v: 1, day: null, ambient: { count: 0, lastAt: 0 }, runs: {}, notified: [] };
  }

  function readState() {
    var raw = local().get(STATE_KEY);
    var d = emptyState();
    if (!raw) return d;
    var o;
    try { o = JSON.parse(raw); } catch (e) { return d; }
    if (!o || typeof o !== 'object') return d;
    d.day = typeof o.day === 'string' ? o.day : null;
    if (o.ambient && typeof o.ambient === 'object') {
      d.ambient.count = num(o.ambient.count) || 0;
      d.ambient.lastAt = num(o.ambient.lastAt) || 0;
    }
    if (o.runs && typeof o.runs === 'object') {
      Object.keys(o.runs).forEach(function (k) { var v = num(o.runs[k]); if (v !== null) d.runs[k] = v; });
    }
    if (Array.isArray(o.notified)) d.notified = o.notified.slice(-20);
    return d;
  }

  // 写前重新读取并合并，避免多标签互相覆盖（同键取较大值）
  function writeState(next) {
    var disk = readState();
    Object.keys(disk.runs).forEach(function (k) {
      if (!next.runs[k] || disk.runs[k] > next.runs[k]) next.runs[k] = disk.runs[k];
    });
    if (disk.day && next.day && disk.day === next.day) {
      if (disk.ambient.count > next.ambient.count) next.ambient.count = disk.ambient.count;
      if (disk.ambient.lastAt > next.ambient.lastAt) next.ambient.lastAt = disk.ambient.lastAt;
    }
    local().set(STATE_KEY, JSON.stringify(next));
    return next;
  }

  /* ---------- 锁 ---------- */
  function readLock() {
    var raw = local().get(LOCK_KEY);
    if (!raw) return null;
    var o;
    try { o = JSON.parse(raw); } catch (e) { return null; }
    if (!o || typeof o.sid !== 'string') return null;
    var at = num(o.at);
    if (at === null) return null;
    return { sid: o.sid, at: at };
  }

  function acquireLock(now, mySid) {
    var lock = readLock();
    if (lock && lock.sid !== mySid && now - lock.at < LOCK_TTL) return false; // 别人持锁且未过期
    local().set(LOCK_KEY, JSON.stringify({ sid: mySid, at: now }));
    return true;
  }

  function releaseLock(mySid) {
    var lock = readLock();
    if (lock && lock.sid === mySid) local().del(LOCK_KEY);
  }

  /* ---------- 预算 ---------- */
  function inQuietHours(now) {
    var d = new Date(now);
    var mins = d.getHours() * 60 + d.getMinutes();
    if (QUIET_START > QUIET_END) return mins >= QUIET_START || mins < QUIET_END;
    return mins >= QUIET_START && mins < QUIET_END;
  }

  function budget(now) {
    var s = readState();
    var today = dayOf(now);
    var count = s.day === today ? s.ambient.count : 0;
    var lastAt = s.day === today ? s.ambient.lastAt : 0;
    return {
      count: count,
      limit: AMBIENT_DAILY,
      cooldownLeftMs: lastAt ? Math.max(0, AMBIENT_COOLDOWN - (now - lastAt)) : 0,
      quiet: inQuietHours(now),
      canUse: count < AMBIENT_DAILY && (!lastAt || now - lastAt >= AMBIENT_COOLDOWN) && !inQuietHours(now),
    };
  }

  // 只有真正产出了行为才调用
  function consumeAmbient(now) {
    var s = readState();
    var today = dayOf(now);
    if (s.day !== today) { s.day = today; s.ambient = { count: 0, lastAt: 0 }; }
    s.ambient.count += 1;
    s.ambient.lastAt = now;
    writeState(s);
    return s.ambient.count;
  }

  function markRun(taskId, now) {
    var s = readState();
    if (!s.day) s.day = dayOf(now);
    s.runs[taskId] = now;
    writeState(s);
  }

  function notify(ev) {
    var s = readState();
    s.notified.push({ id: ev && ev.id, at: nowFn(), type: ev && ev.type });
    if (s.notified.length > 20) s.notified = s.notified.slice(-20);
    writeState(s);
    if (typeof onNotify === 'function') {
      try { onNotify(ev); } catch (e) { /* 通知失败不影响调度 */ }
    }
    return true;
  }

  /* ---------- 注册与执行 ---------- */
  function register(task) {
    if (!task || typeof task.id !== 'string' || typeof task.run !== 'function') return false;
    var everyMs = num(task.everyMs) || TICK_MS;
    var priority = task.priority === 'user' ? 'user' : 'ambient';
    var exists = tasks.filter(function (t) { return t.id === task.id; });
    if (exists.length) {
      exists[0].run = task.run;
      exists[0].everyMs = everyMs;
      exists[0].priority = priority;
      return true;
    }
    tasks.push({ id: task.id, run: task.run, everyMs: everyMs, priority: priority });
    return true;
  }

  function list() { return tasks.map(function (t) { return { id: t.id, everyMs: t.everyMs, priority: t.priority }; }); }

  async function tick(opts) {
    opts = opts || {};
    var now = nowFn();
    var isVisible = opts.forceVisible === true || visibleFn();
    var report = { ran: [], skipped: [], produced: 0, visible: isVisible };
    if (!isVisible) return report;                    // 页面隐藏：不做常规 tick
    if (!sid) sid = 'sch' + now.toString(36) + Math.random().toString(36).slice(2, 6);
    if (!acquireLock(now, sid)) { report.locked = true; return report; }

    var state = readState();
    var today = dayOf(now);
    if (state.day && state.day !== today) {           // 跨天：清 ambient 配额
      state.day = today;
      state.ambient = { count: 0, lastAt: 0 };
      writeState(state);
    }

    try {
      for (var i = 0; i < tasks.length; i++) {
        var t = tasks[i];
        var last = num(readState().runs[t.id]) || 0;
        // 启动补检：用户级任务（待办提醒等）不受上一次 tick 的间隔门槛限制，
        // 否则刷新页面后要等满一分钟才会补投已经到期的提醒。ambient 仍按原间隔走。
        var bootBypass = opts.boot === true && t.priority === 'user';
        if (!bootBypass && last && now - last < t.everyMs) { report.skipped.push(t.id + ':interval'); continue; }
        if (t.priority === 'ambient') {
          var b = budget(now);
          if (!b.canUse) {
            report.skipped.push(t.id + ':budget');
            dbg('[sched]', t.id, 'skip=budget', 'count=' + b.count + '/' + b.limit,
              'cooldownLeftMin=' + Math.round(b.cooldownLeftMs / 60000), 'quiet=' + b.quiet);
            continue;
          }
        }
        var out = null;
        try {
          out = await t.run({ now: now, isVisible: isVisible, catchUp: opts.catchUp === true, budget: budget(now) });
        } catch (e) {
          report.skipped.push(t.id + ':error');
          continue;
        }
        markRun(t.id, now);
        if (out) {
          report.ran.push(t.id);
          report.produced += 1;
          if (t.priority === 'ambient') consumeAmbient(now);
        }
      }
    } finally {
      releaseLock(sid);
    }
    return report;
  }

  function start(opts) {
    opts = opts || {};
    if (opts.sid) sid = opts.sid;
    if (running) return api;
    running = true;
    timer = setInterval(function () {
      if (typeof document !== 'undefined' && document.hidden) return;   // 隐藏时跳过
      tick().catch(function () {});
    }, TICK_MS);
    return api;
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    running = false;
    return api;
  }

  // visible / pageshow 补检：限频，避免连击
  var lastCatchUpAt = 0;
  function catchUp() {
    var now = nowFn();
    if (now - lastCatchUpAt < CATCHUP_MIN_GAP) return Promise.resolve({ skipped: ['catchup:rate'] });
    lastCatchUpAt = now;
    return tick({ catchUp: true, forceVisible: true });
  }

  /* ---------- 测试钩子 ---------- */
  function _setStorage(opts) {
    opts = opts || {};
    store = opts.local ? wrap(function () { return opts.local; }) : null;
    return api;
  }
  function _now(fn) { nowFn = typeof fn === 'function' ? fn : function () { return Date.now(); }; return api; }
  function _visible(fn) { visibleFn = typeof fn === 'function' ? fn : function () { return true; }; return api; }
  function _reset() {
    tasks = []; running = false; sid = null; lastCatchUpAt = 0;
    if (timer) { clearInterval(timer); timer = null; }
    store = null; nowFn = function () { return Date.now(); };
    visibleFn = function () { if (typeof document === 'undefined') return true; return !document.hidden; };
    return api;
  }

  var api = {
    register: register,
    list: list,
    tick: tick,
    start: start,
    stop: stop,
    catchUp: catchUp,
    notify: notify,
    budget: budget,
    consumeAmbient: consumeAmbient,
    setNotifier: function (fn) { onNotify = typeof fn === 'function' ? fn : null; return api; },
    _acquireLock: acquireLock,
    _releaseLock: releaseLock,
    _readLock: readLock,
    _setStorage: _setStorage,
    _now: _now,
    _visible: _visible,
    _reset: _reset,
    _state: readState,
    _keys: {
      STATE_KEY: STATE_KEY, LOCK_KEY: LOCK_KEY, LOCK_TTL: LOCK_TTL, TICK_MS: TICK_MS,
      AMBIENT_DAILY: AMBIENT_DAILY, AMBIENT_COOLDOWN: AMBIENT_COOLDOWN,
      QUIET_START: QUIET_START, QUIET_END: QUIET_END,
    },
  };
  root.LifeScheduler = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
