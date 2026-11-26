/* public/shared/life-presence.js — 轻量生活时间状态（P0/S2）
 * 只做「记录时间」，不做任何行为判断、不发请求、不进提示词、不碰 IndexedDB。
 *
 * 存储：
 *   localStorage['ylxh.life.v1']  跨会话状态（单键 JSON）
 *   sessionStorage['ylxh.life.sid'] 当前标签页访问 id（刷新保留、新标签为空）
 *   sessionStorage['ylxh.life.sidAt'] 该 sid 创建时刻
 *
 * 字段语义（严格遵守）：
 *   lastVisitAt       最近一次「进入或重新返回」房间；刷新不更新
 *   lastActiveAt      最近一次真实用户操作。允许为空：boot 与 visible 都不写它，
 *                     未来消费方需要「最近一次见到她」时，应结合 lastHiddenAt / lastVisitAt
 *                     做语义明确的兜底，不能假定它一定存在。
 *   lastInteractionAt 最近一次用户消息成功写入
 *   lastHiddenAt      最近一次页面进入 hidden（切后台不等于离开）
 *   lastLeaveAt       有证据确认的离开时间；宁可缺失也不推测
 */
(function (root) {
  'use strict';

  var KEY = 'ylxh.life.v1';
  var SID_KEY = 'ylxh.life.sid';
  var SID_AT_KEY = 'ylxh.life.sidAt';
  var TRANSITION_KEY = 'ylxh.transition';

  var TAB_TTL = 10 * 60 * 1000;   // 标签登记过期阈值：只用于判断登记是否有效，不是离开时间
  var ACTIVE_THROTTLE = 60 * 1000; // lastActiveAt 写入节流
  var LEAVE_CANDIDATE_TTL = 6 * 60 * 60 * 1000; // 离开候选的有效期
  var SID_STALE = 30 * 60 * 1000; // 同一 sid 存活超过该时长后，navigate 视为标签恢复/重新进入

  var mem = null;          // 内存快照（存储不可用时的唯一事实源）
  var booted = false;
  var mySid = null;
  var sidCreatedAt = 0;
  var lastActiveWriteAt = 0;

  var nowFn = function () { return Date.now(); };
  var navTypeFn = defaultNavType;
  var transitionFn = defaultTransition;
  var storeL = null;
  var storeS = null;

  function defaultNavType() {
    try {
      var e = performance.getEntriesByType && performance.getEntriesByType('navigation');
      if (e && e[0] && e[0].type) return e[0].type;
    } catch (err) {}
    return 'unknown';
  }

  // 解析期抢读：transition.js 在 DOMContentLoaded 里读完就删，
  // 而房间的 boot() 在 init() 末尾（异步），此刻标记可能已被清掉。
  // 所以这里在模块加载时同步读一次并缓存，boot 使用缓存值。
  var transitionAtParse = '';
  try { transitionAtParse = sessionStorage.getItem(TRANSITION_KEY) || ''; } catch (e) {}

  function defaultTransition() {
    return transitionAtParse;
  }

  function wrapStore(getter) {
    return {
      get: function (k) { try { return getter().getItem(k); } catch (e) { return null; } },
      set: function (k, v) { try { getter().setItem(k, v); return true; } catch (e) { return false; } },
      del: function (k) { try { getter().removeItem(k); return true; } catch (e) { return false; } },
    };
  }

  function local() {
    if (!storeL) storeL = wrapStore(function () { return localStorage; });
    return storeL;
  }

  function session() {
    if (!storeS) storeS = wrapStore(function () { return sessionStorage; });
    return storeS;
  }

  function emptyState() {
    return {
      v: 1,
      rev: 0,
      updatedAt: 0,
      lastVisitAt: null,
      visitKind: null,
      lastReturnFrom: null,
      navType: 'unknown',
      visitSid: null,
      visitScope: null,
      lastActiveAt: null,
      activeSource: null,
      lastInteractionAt: null,
      lastHiddenAt: null,
      lastLeaveAt: null,
      lastLeaveEvidence: null,
      lastLeaveBy: null,
      lastLeaveFrom: null,
      leaveCertain: false,
      leaveUnresolved: null,
      lastResolution: null,
      pendingLeave: null,
      tabs: {},
    };
  }

  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }

  function normalize(o) {
    var d = emptyState();
    if (!o || typeof o !== 'object') return d;
    d.rev = num(o.rev) || 0;
    d.updatedAt = num(o.updatedAt) || 0;
    d.lastVisitAt = num(o.lastVisitAt);
    d.lastActiveAt = num(o.lastActiveAt);
    d.lastInteractionAt = num(o.lastInteractionAt);
    d.lastHiddenAt = num(o.lastHiddenAt);
    d.lastLeaveAt = num(o.lastLeaveAt);
    d.visitKind = typeof o.visitKind === 'string' ? o.visitKind : null;
    d.lastReturnFrom = typeof o.lastReturnFrom === 'string' ? o.lastReturnFrom : null;
    d.navType = typeof o.navType === 'string' ? o.navType : 'unknown';
    d.visitSid = typeof o.visitSid === 'string' ? o.visitSid : null;
    d.visitScope = typeof o.visitScope === 'string' ? o.visitScope : null;
    d.activeSource = typeof o.activeSource === 'string' ? o.activeSource : null;
    d.lastLeaveEvidence = typeof o.lastLeaveEvidence === 'string' ? o.lastLeaveEvidence : null;
    d.lastLeaveBy = typeof o.lastLeaveBy === 'string' ? o.lastLeaveBy : null;
    d.lastLeaveFrom = typeof o.lastLeaveFrom === 'string' ? o.lastLeaveFrom : null;
    d.leaveCertain = o.leaveCertain === true;
    d.lastResolution = typeof o.lastResolution === 'string' ? o.lastResolution : null;
    d.leaveUnresolved = (o.leaveUnresolved && typeof o.leaveUnresolved === 'object'
      && num(o.leaveUnresolved.at) !== null) ? { at: o.leaveUnresolved.at, reason: String(o.leaveUnresolved.reason || 'unknown') } : null;
    var p = o.pendingLeave;
    if (p && typeof p === 'object' && num(p.at) !== null) {
      d.pendingLeave = {
        at: p.at,
        evidence: typeof p.evidence === 'string' ? p.evidence : 'hidden',
        persisted: p.persisted === true,
        by: typeof p.by === 'string' ? p.by : null,
      };
    }
    if (o.tabs && typeof o.tabs === 'object') {
      Object.keys(o.tabs).forEach(function (sid) {
        var t = o.tabs[sid];
        if (t && num(t.lastSeenAt) !== null) d.tabs[sid] = { lastSeenAt: t.lastSeenAt };
      });
    }
    return d;
  }

  function read() {
    if (mem) return mem; // 已初始化
    var raw = local().get(KEY);
    if (!raw) { mem = emptyState(); return mem; }
    try {
      mem = normalize(JSON.parse(raw));
    } catch (e) {
      mem = emptyState(); // JSON 损坏：回落默认值，不阻塞调用方
    }
    return mem;
  }

  // 写前重新读取，避免用旧内存快照覆盖别的新记录
  function readFresh() {
    var raw = local().get(KEY);
    if (!raw) return read();
    try {
      var disk = normalize(JSON.parse(raw));
      // 合并磁盘与内存：时间字段取较大值，rev 取较大值（单调不减）
      var m = read();
      m.lastVisitAt = maxOf(m.lastVisitAt, disk.lastVisitAt);
      m.lastActiveAt = maxOf(m.lastActiveAt, disk.lastActiveAt);
      m.lastInteractionAt = maxOf(m.lastInteractionAt, disk.lastInteractionAt);
      m.lastHiddenAt = maxOf(m.lastHiddenAt, disk.lastHiddenAt);
      if (disk.rev > m.rev) m.rev = disk.rev;
      // 磁盘上的离开证据比内存新，采用磁盘
      if (num(disk.lastLeaveAt) !== null && (num(m.lastLeaveAt) === null || disk.lastLeaveAt > m.lastLeaveAt)) {
        m.lastLeaveAt = disk.lastLeaveAt;
        m.lastLeaveEvidence = disk.lastLeaveEvidence;
        m.lastLeaveBy = disk.lastLeaveBy;
        m.lastLeaveFrom = disk.lastLeaveFrom;
        m.leaveCertain = disk.leaveCertain;
      }
      if (disk.tabs) {
        Object.keys(disk.tabs).forEach(function (sid) {
          var cur = m.tabs[sid];
          if (!cur || disk.tabs[sid].lastSeenAt > cur.lastSeenAt) m.tabs[sid] = disk.tabs[sid];
        });
      }
      // 别人的候选不覆盖自己的
      if (disk.pendingLeave && (!m.pendingLeave || disk.pendingLeave.at > m.pendingLeave.at)) {
        m.pendingLeave = disk.pendingLeave;
      }
      return m;
    } catch (e) {
      return read();
    }
  }

  function maxOf(a, b) {
    var x = num(a), y = num(b);
    if (x === null) return y;
    if (y === null) return x;
    return x > y ? x : y;
  }

  function write(state) {
    state.rev = (num(state.rev) || 0) + 1;
    state.updatedAt = nowFn();
    mem = state;
    try { local().set(KEY, JSON.stringify(state)); } catch (e) { /* 配额/隐私模式：内存继续服务 */ }
    return state;
  }

  function uuidish() {
    return 's' + nowFn().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /* ---------- 判定链（纯函数，可单独测） ---------- */
  function decideVisit(input) {
    var o = {
      visitKind: 'fresh',
      lastVisitAt: input.bootAt,
      lastReturnFrom: null,
      lastLeaveAt: null,          // null = 不改动
      lastLeaveEvidence: null,
      lastLeaveFrom: null,
      leaveCertain: false,
      leaveUnresolved: null,
      lastResolution: 'unknown',
      clearPending: false,
      setPending: null,
    };
    var p = input.pendingLeave;

    if (input.navType === 'reload') {
      o.visitKind = 'refresh';
      o.lastVisitAt = null;       // 刷新不更新访问时间
      o.clearPending = true;
      o.lastResolution = 'refresh';
      return o;
    }
    if (input.navType === 'back_forward') {
      o.visitKind = 'returned';
      o.clearPending = true;
      o.lastResolution = 'back_forward';
      return o;
    }
    if (/to-home/.test(input.transition || '')) {
      o.visitKind = 'returned';
      o.lastReturnFrom = 'playground';
      if (p && (p.evidence === 'pagehide' || p.evidence === 'hidden') && (input.bootAt - p.at) < LEAVE_CANDIDATE_TTL) {
        o.lastLeaveAt = p.at;
        o.lastLeaveEvidence = 'pagehide';
        o.lastLeaveFrom = 'playground';
        o.leaveCertain = true;
        o.lastResolution = 'resolved';
        o.clearPending = true;
      } else {
        o.lastLeaveEvidence = 'unknown';
        o.lastResolution = 'unknown';
        o.clearPending = true;
      }
      return o;
    }
    if (input.hadSid) {
      o.visitKind = 'returned';
      if (p && p.by === input.mySid && (input.bootAt - p.at) < LEAVE_CANDIDATE_TTL) {
        o.lastLeaveAt = p.at;
        o.lastLeaveEvidence = 'pagehide';
        o.lastLeaveFrom = 'room';
        o.leaveCertain = true;
        o.lastResolution = 'resolved';
        o.clearPending = true;
      } else {
        o.lastResolution = 'unknown';
      }
      return o;
    }
    // 无 sid：可能是新标签页、正常关闭后重开，或异常退出
    var others = input.activeTabs.filter(function (sid) { return sid !== input.mySid; });
    if (others.length) {
      o.visitKind = 'fresh';
      o.lastResolution = 'tab-alive';
      o.setPending = p;           // 别人的候选原样保留，不清
      return o;
    }
    if (p && p.by && p.by !== input.mySid && (input.bootAt - p.at) < LEAVE_CANDIDATE_TTL) {
      o.visitKind = 'fresh';
      o.lastLeaveAt = p.at;       // 定案：用候选时间，不用 bootAt
      o.lastLeaveEvidence = 'pagehide';
      o.lastLeaveFrom = 'room';
      o.leaveCertain = true;
      o.lastResolution = 'resolved';
      o.clearPending = true;
      return o;
    }
    // 无任何证据：不推测，只记「未解决」
    o.visitKind = 'fresh';
    o.leaveUnresolved = { at: input.bootAt, reason: p ? 'stale-evidence' : 'no-evidence' };
    o.lastResolution = 'unresolved';
    o.clearPending = true;
    return o;
  }

  /* ---------- 公开接口 ---------- */
  // boot({ visit: true }) 默认：房间访问判定（现状行为，完全兼容）
  // boot({ visit: false })      ：非房间页（游乐场）只挂载，不参与访问判定
  function boot(opts) {
    if (booted) return snapshot();
    booted = true;
    var visit = !(opts && opts.visit === false);

    var bootAt = nowFn();
    var navType = navTypeFn() || 'unknown';
    var transition = transitionFn() || '';

    var existingSid = session().get(SID_KEY);
    var hadSid = !!existingSid;
    if (hadSid) {
      mySid = existingSid;
      sidCreatedAt = num(parseInt(session().get(SID_AT_KEY), 10)) || 0;
    } else {
      mySid = uuidish();
      sidCreatedAt = bootAt;
      session().set(SID_KEY, mySid);
      session().set(SID_AT_KEY, String(bootAt));
    }

    var s = readFresh();

    if (!visit) {
      // 非房间页只做三件事：维护 sid、清理过期登记、登记自己。
      // 不执行访问判定链，不碰 lastVisitAt / visitKind / lastReturnFrom / pendingLeave / lastLeaveAt。
      Object.keys(s.tabs).forEach(function (sid) {
        if (bootAt - s.tabs[sid].lastSeenAt > TAB_TTL) delete s.tabs[sid];
      });
      s.tabs[mySid] = { lastSeenAt: bootAt };
      s.visitSid = mySid;
      s.visitScope = 'playground';
      write(s);
      return snapshot();
    }

    // 清理过期标签登记（仅登记有效性，不代表离开时间）
    var activeTabs = [];
    Object.keys(s.tabs).forEach(function (sid) {
      if (bootAt - s.tabs[sid].lastSeenAt > TAB_TTL) delete s.tabs[sid];
      else activeTabs.push(sid);
    });

    var decision = decideVisit({
      hadSid: hadSid,
      navType: navType,
      transition: transition,
      pendingLeave: s.pendingLeave,
      activeTabs: activeTabs,
      mySid: mySid,
      bootAt: bootAt,
    });

    if (decision.setPending !== undefined && decision.setPending !== null) {
      s.pendingLeave = decision.setPending;
    }
    if (decision.clearPending) s.pendingLeave = null;
    if (decision.lastLeaveAt !== null) {
      s.lastLeaveAt = decision.lastLeaveAt;
      s.lastLeaveEvidence = decision.lastLeaveEvidence;
      s.lastLeaveFrom = decision.lastLeaveFrom;
      s.lastLeaveBy = mySid;
      s.leaveCertain = decision.leaveCertain;
    }
    if (decision.leaveUnresolved) s.leaveUnresolved = decision.leaveUnresolved;
    s.lastResolution = decision.lastResolution;
    s.visitKind = decision.visitKind;
    s.navType = navType;
    s.visitSid = mySid;
    s.visitScope = 'room';
    s.lastReturnFrom = decision.lastReturnFrom;
    if (decision.lastVisitAt !== null) s.lastVisitAt = maxOf(s.lastVisitAt, decision.lastVisitAt);
    s.tabs[mySid] = { lastSeenAt: bootAt };

    // boot 不写 lastActiveAt / lastInteractionAt
    write(s);
    return snapshot();
  }

  function active(kind) {
    if (!booted) return;
    var t = nowFn();
    if (lastActiveWriteAt && t - lastActiveWriteAt < ACTIVE_THROTTLE) return; // 节流
    lastActiveWriteAt = t;
    var s = readFresh();
    s.lastActiveAt = maxOf(s.lastActiveAt, t);
    s.activeSource = typeof kind === 'string' ? kind : 'input';
    s.tabs[mySid] = { lastSeenAt: t };
    write(s);
  }

  // 唯一写 lastInteractionAt 的入口：调用方必须确保用户消息已成功落库
  function interaction() {
    if (!booted) return;
    var t = nowFn();
    var s = readFresh();
    s.lastInteractionAt = maxOf(s.lastInteractionAt, t);
    s.lastActiveAt = maxOf(s.lastActiveAt, t);
    s.activeSource = 'message';
    s.tabs[mySid] = { lastSeenAt: t };
    lastActiveWriteAt = t;
    write(s);
  }

  function hidden() {
    if (!booted) return;
    var t = nowFn();
    var s = readFresh();
    s.lastHiddenAt = maxOf(s.lastHiddenAt, t);
    s.pendingLeave = { at: t, evidence: 'hidden', persisted: false, by: mySid };
    s.tabs[mySid] = { lastSeenAt: t };
    write(s);
  }

  // 重新可见：只清隐藏状态与自己的候选，不更新 lastActiveAt（可见不等于操作）
  function visible() {
    if (!booted) return;
    var s = readFresh();
    if (s.pendingLeave && s.pendingLeave.by === mySid) s.pendingLeave = null;
    s.tabs[mySid] = { lastSeenAt: nowFn() };
    write(s);
  }

  // evidence: 'pagehide' | 'bfcache' | 'navigate'
  // 只记录候选，绝不在这里确认离开
  function leaving(evidence) {
    if (!booted) return;
    var t = nowFn();
    var s = readFresh();
    if (evidence === 'bfcache') {
      if (s.pendingLeave && s.pendingLeave.by === mySid) s.pendingLeave = null;
      s.activeSource = s.activeSource;
      write(s);
      return;
    }
    s.pendingLeave = { at: t, evidence: evidence === 'navigate' ? 'pagehide' : (evidence || 'pagehide'), persisted: false, by: mySid };
    s.tabs[mySid] = { lastSeenAt: t };
    write(s);
  }

  function snapshot() {
    var s = read();
    return JSON.parse(JSON.stringify(s));
  }

  // 测试注入
  function _setStorage(opts) {
    opts = opts || {};
    storeL = opts.local ? wrapStore(function () { return opts.local; }) : null;
    storeS = opts.session ? wrapStore(function () { return opts.session; }) : null;
    return api;
  }
  function _now(fn) { nowFn = typeof fn === 'function' ? fn : function () { return Date.now(); }; return api; }
  function _setNavType(fn) { navTypeFn = typeof fn === 'function' ? fn : defaultNavType; return api; }
  function _setTransition(fn) { transitionFn = typeof fn === 'function' ? fn : defaultTransition; return api; }
  function _reset() {
    mem = null; booted = false; mySid = null; sidCreatedAt = 0; lastActiveWriteAt = 0;
    storeL = null; storeS = null;
    nowFn = function () { return Date.now(); };
    navTypeFn = defaultNavType;
    transitionFn = defaultTransition;
    return api;
  }
  function _state() { return read(); }

  var api = {
    boot: boot,
    active: active,
    interaction: interaction,
    hidden: hidden,
    visible: visible,
    leaving: leaving,
    snapshot: snapshot,
    _setStorage: _setStorage,
    _now: _now,
    _setNavType: _setNavType,
    _setTransition: _setTransition,
    _reset: _reset,
    _state: _state,
    _decideVisit: decideVisit,
    _keys: { KEY: KEY, SID_KEY: SID_KEY, SID_AT_KEY: SID_AT_KEY, TAB_TTL: TAB_TTL, ACTIVE_THROTTLE: ACTIVE_THROTTLE },
  };

  // storage 事件：只刷新内存快照，不回写（避免 ping-pong）
  try {
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('storage', function (e) {
        if (!e || e.key !== KEY) return;
        try {
          mem = e.newValue ? normalize(JSON.parse(e.newValue)) : emptyState();
        } catch (err) { /* 忽略损坏广播 */ }
      });
    }
  } catch (err) {}

  root.LifePresence = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
