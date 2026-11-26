/* public/shared/life-context.js — P1-a 统一生活时间上下文
 * 只读：从 LifeClock + LifePresence（+ 可选的 LifeEvents 摘要）生成快照与提示词段落。
 * 边界：不写任何存储、不访问 IndexedDB、不发网络请求、不修改 LifePresence 原始数据。
 * 隐私：只输出「计数与类别概括」，绝不输出待办标题、金额、睡眠、生理期、日记/信件正文。
 */
(function (root) {
  'use strict';

  var DEFAULT_MAX = 120; // 严格上限：超出按优先级丢弃次要事实（不删关键时间信息）

  function fin(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  function safe(fn, fallback) { try { return fn(); } catch (e) { return fallback; } }

  function clock() { return root.LifeClock || null; }

  // 事件概括：只保留「类别 → 条数」，丢弃一切标题与金额
  var EVENT_LABEL = {
    'task.done': '完成了{ n }件事',
    'task.add': '记下了{ n }件要做的事',
    'task.cancel': '取消了{ n }件事',
    'task.defer': '把{ n }件事挪到了别的时间',
    'vocab.round': '背了{ n }轮词',
    'reading.finish': '读完了{ n }本书',
    'radio.episode': '听完了{ n }期电台',
    'game.finish': '一起玩了{ n }次游戏',
    'diary.write': '写了{ n }篇日记',
    'letter.open': '拆开了{ n }封未来信',
  };

  // P5-a：事件类型 → 话题类别；被回避的话题不得经事件概括绕过
  var EVENT_KIND = {
    'task.done': 'task', 'task.add': 'task', 'task.cancel': 'task', 'task.defer': 'task',
    'vocab.round': 'vocab', 'reading.finish': 'reading', 'radio.episode': 'radio', 'game.finish': 'game',
  };

  function topicBlocked(kind) {
    if (!kind) return false;
    var LT = root.LifeTopics;
    if (!LT) return false;
    return safe(function () { return LT.isBlocked(kind); }, false);
  }

  function summarizeEvents(list) {
    var counts = {};
    (list || []).forEach(function (e) {
      if (!e || !e.type) return;
      if (e.status && e.status !== 'occurred') return;   // 计划/进行中不算发生
      if (!Object.prototype.hasOwnProperty.call(EVENT_LABEL, e.type)) return;
      if (topicBlocked(EVENT_KIND[e.type])) return;       // 她不想提的话题：不出现在概括里
      counts[e.type] = (counts[e.type] || 0) + 1;
    });
    var parts = [];
    Object.keys(EVENT_LABEL).forEach(function (type) {
      var n = counts[type];
      if (n > 0) parts.push(EVENT_LABEL[type].replace('{ n }', String(n)));
    });
    return { counts: counts, parts: parts };
  }

  // P3：状态层只取「计数」，绝不输出标题/金额/正文
  function stateLine(st) {
    if (!st || !st.counts) return null;
    var c = st.counts;
    var bits = [];
    if (c.ongoing > 0) bits.push('手上还有' + c.ongoing + '件正在做的');
    if (c.completed > 0) bits.push('最近完成了' + c.completed + '件');
    if (c.planned > 0) bits.push('另有' + c.planned + '件排在计划里');
    if (c.expired > 0 && !bits.length) bits.push('有' + c.expired + '件已经过期没做');
    if (!bits.length) return null;
    return '她的近况：' + bits.join('，') + '。';
  }

  // planned / ongoing 不算「值得注目的近况」，避免把待办清单一路播报
  function stateNotable(st) {
    if (!st || !st.counts) return false;
    var c = st.counts;
    return (c.ongoing || 0) + (c.completed || 0) + (c.expired || 0) > 0;
  }

  /**
   * 只读快照。
   * opts: { now, presence, events, state }
   *   presence 缺省取 LifePresence.snapshot()；events 缺省取 LifeEvents.summarySince()
   */
  function snapshot(opts) {
    opts = opts || {};
    var C = clock();
    var now = fin(opts.now) !== null ? opts.now : (C ? C.now() : Date.now());

    var p = opts.presence;
    if (!p) {
      var LP = root.LifePresence;
      p = safe(function () { return LP ? LP.snapshot() : null; }, null) || {};
    }

    var lastInteractionAt = fin(p.lastInteractionAt);
    var lastActiveAt = fin(p.lastActiveAt);
    var lastVisitAt = fin(p.lastVisitAt);
    var lastLeaveAt = fin(p.lastLeaveAt);

    var sinceInteraction = (C && lastInteractionAt) ? C.relative(lastInteractionAt, now) : null;
    var sinceActive = (C && lastActiveAt) ? C.relative(lastActiveAt, now) : null;
    var sinceVisit = (C && lastVisitAt) ? C.relative(lastVisitAt, now) : null;
    var sinceLeave = (C && lastLeaveAt) ? C.relative(lastLeaveAt, now) : null;

    // 事件：默认只取「上次互动之后」发生的，避免把旧事当新闻
    var events = opts.events;
    if (!events) {
      var LE = root.LifeEvents;
      events = safe(function () {
        return LE ? LE.summarySince(lastInteractionAt || (now - 6 * 3600000), now) : [];
      }, []);
    }
    var ev = summarizeEvents(events);

    var visitKind = typeof p.visitKind === 'string' ? p.visitKind : null;
    var fromPlayground = p.lastReturnFrom === 'playground';
    // 从未互动过不算「久别」：没有可延续的间隔，不该硬造一句"很久没见"
    var longGap = !!sinceInteraction
      && ['day', 'days', 'week', 'weeks', 'month', 'long'].indexOf(sinceInteraction.level) !== -1;

    // P3：状态层缓存（只读；未刷新过则为 null，不猜）
    var st = opts.state;
    if (st === undefined) {
      var LS = root.LifeState;
      st = safe(function () { return LS ? LS.cached() : null; }, null);
    }
    // P5-a：有回避规则时，状态计数是跨话题聚合的，无法逐项剔除 → 整段不给，避免绕过规则
    var LT = root.LifeTopics;
    if (st && LT && safe(function () { return LT.hasAny(); }, false)) st = null;
    var stText = stateLine(st);
    var stNotable = stateNotable(st);

    return {
      now: now,
      day: C ? C.formatDay(now) : null,
      clock: C ? C.formatClock(now) : null,
      weekday: C ? C.weekdayName(now) : null,
      partOfDay: C ? C.partOfDay(now) : null,
      tzOffsetMin: C ? C.tzOffsetMin(now) : null,
      visitKind: visitKind,
      navType: typeof p.navType === 'string' ? p.navType : null,
      fromPlayground: fromPlayground,
      lastVisitAt: lastVisitAt,
      lastActiveAt: lastActiveAt,
      lastInteractionAt: lastInteractionAt,
      lastLeaveAt: lastLeaveAt,
      sinceVisit: sinceVisit,
      sinceActive: sinceActive,
      sinceInteraction: sinceInteraction,
      sinceLeave: sinceLeave,
      longGap: longGap,
      // 值得自然延续：刚回来且隔了一段时间，或有新事件
      worthContinuing: (visitKind === 'returned' && longGap) || ev.parts.length > 0,
      events: ev,
      hasEvents: ev.parts.length > 0,
      state: st ? { at: fin(st.at), counts: st.counts, sources: st.sources } : null,
      stateText: stText,
      hasState: !!stText,
      stateNotable: stNotable,
    };
  }

  // 是否值得注入完整段落（普通闲聊不重复罗列时间）
  function shouldInject(snap) {
    if (!snap) return false;
    if (snap.visitKind === 'returned') return true;
    if (snap.longGap) return true;
    if (snap.hasEvents) return true;
    // 有正在做/刚完成的事，且已隔了几小时以上才值得提；避免每次闲聊都塞现状
    if (snap.hasState && snap.stateNotable && snap.sinceInteraction
      && ['hour', 'today', 'day', 'days', 'week', 'weeks', 'month', 'long'].indexOf(snap.sinceInteraction.level) !== -1) return true;
    return false;
  }

  function visitText(snap) {
    if (snap.fromPlayground) return '她刚和你一起从游乐场回到房间';
    if (snap.visitKind === 'returned') return '她离开一会儿又回来了';
    if (snap.visitKind === 'refresh') return '她只是刷新了一下页面';
    if (snap.visitKind === 'fresh') return '她刚打开房间';
    return null;
  }

  /**
   * 渲染为提示词段落。事实陈述 + 明确「不必提起、不必报时」。
   * 超过 max 时按优先级丢弃：上次来访 → 访问性质 → 事件 → 近况。
   */
  function render(snap, opts) {
    if (!snap) return '';
    opts = opts || {};
    var max = Math.min(fin(opts.max) && opts.max > 0 ? opts.max : DEFAULT_MAX, DEFAULT_MAX);

    // noClock：调用方已在 system 末尾统一注入分钟级【当前时间】时，这里不再重复一个 HH:MM。
    // 只影响开头这一句的措辞，日期/时段/相对间隔全部保留；默认行为不变。
    var headParts = ['【此刻】现在是', snap.day, snap.weekday, snap.partOfDay];
    if (!opts.noClock) headParts.push(snap.clock);
    var head = headParts.filter(function (x) { return !!x; }).join(' ') + '。';

    var core = [];
    if (snap.sinceInteraction) {
      core.push('她上次和你说话是' + snap.sinceInteraction.text + '。');
    } else {
      core.push('你们最近没有聊过天。');
    }

    // 展示顺序固定；p 越小越先被丢弃
    var extras = [];
    var v = visitText(snap);
    if (v) extras.push({ key: 'visit', text: v + '。', p: 2 });
    if (snap.sinceVisit && snap.visitKind !== 'fresh') {
      extras.push({ key: 'sinceVisit', text: '她上次来房间是' + snap.sinceVisit.text + '。', p: 1 });
    }
    if (snap.hasEvents) {
      extras.push({ key: 'events', text: '这段时间她' + snap.events.parts.join('，') + '。', p: 3 });
    }
    if (snap.hasState) {
      extras.push({ key: 'state', text: snap.stateText, p: 4 });
    }
    // 展示顺序：访问 → 上次来访 → 事件 → 近况
    var order = ['visit', 'sinceVisit', 'events', 'state'];
    extras.sort(function (a, b) { return order.indexOf(a.key) - order.indexOf(b.key); });

    var tail = '这些只是你记得的背景，不必逐条提起，也不必报时；自然相关时再用。不要说你没经历过的事。';

    function join() {
      return head + core.join('') + extras.map(function (e) { return e.text; }).join('') + tail;
    }
    var text = join();
    while (extras.length && text.length > max) {
      var lowest = 0;
      for (var i = 1; i < extras.length; i++) if (extras[i].p < extras[lowest].p) lowest = i;
      extras.splice(lowest, 1);
      text = join();
    }
    return text;
  }

  var api = {
    snapshot: snapshot,
    render: render,
    shouldInject: shouldInject,
    summarizeEvents: summarizeEvents,
    _labels: EVENT_LABEL,
  };
  root.LifeContext = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
