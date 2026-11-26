/* public/shared/life-state.js — P3 生活状态层
 * 职责：表示「现在正在发生什么 / 计划着什么 / 已经结束什么」，与 LifeEvents（发生过什么）互补。
 * 边界：
 *   - 只读既有数据（localStorage 存档 + 注入的任务/信件读取器），绝不写回源数据；
 *   - 不访问 IndexedDB（任务与未来信由外部 provider 注入，模块本身零 DB 代码）；
 *   - 不发请求、不调用 AI、不写事件（事件归 LifeEvents）；
 *   - 不读取账单金额、睡眠、生理期、日记与信件正文。
 * 存储：localStorage['ylxh.life.state.v1'] = { v, at, items, counts }（只读缓存，供 LifeContext 同步取用）
 */
(function (root) {
  'use strict';

  var KEY = 'ylxh.life.state.v1';
  var MAX_ITEMS = 40;
  var RECENT_MS = 3 * 86400000;   // 「最近完成」只看 3 天内，避免旧账当新闻
  var MAX_FUTURE_MS = 30 * 86400000;

  var STATE = {
    OCCURRED: 'occurred',
    ONGOING: 'ongoing',
    PLANNED: 'planned',
    COMPLETED: 'completed',
    CANCELLED: 'cancelled',
    EXPIRED: 'expired',
    UNKNOWN: 'unknown',
  };

  var providers = { tasks: null, letters: null, storage: null };

  function local() {
    if (providers.storage) return providers.storage;
    try { return root.localStorage; } catch (e) { return null; }
  }
  function getKey(k) {
    var s = local();
    if (!s) return null;
    try { return s.getItem(k); } catch (e) { return null; }
  }
  function json(raw) {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }
  function nowMs(v) { return typeof v === 'number' && isFinite(v) ? v : Date.now(); }
  function dayOf(ms) {
    var C = root.LifeClock;
    if (C) return C.formatDay(ms);
    var d = new Date(ms);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function dayOfStamp(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; }
  // 'YYYY-MM-DD' + 'HH:MM' → ms（本地）；用于给待办排序，不用于判定完成
  function planMs(dateStr, timeStr) {
    var d = dayOfStamp(dateStr);
    if (!d) return null;
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(timeStr || ''));
    var parts = d.split('-');
    var h = m ? Number(m[1]) : 23;
    var mi = m ? Number(m[2]) : 59;
    var dt = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), h, mi, 0, 0);
    return dt.getTime();
  }

  function item(id, source, type, state, at, meta) {
    return {
      id: String(id),
      source: source,
      type: type,
      state: state,
      at: typeof at === 'number' && isFinite(at) ? at : null,
      title: '',
      meta: meta && typeof meta === 'object' ? meta : {},
    };
  }

  /* ---------------- 各来源：只读构建 ---------------- */

  // 生活管家待办：延期只表现为日期被改写，因此这里只认当前 date，不保留旧计划
  function fromTasks(tasks, now) {
    if (!Array.isArray(tasks)) return null;      // 读不到 ≠ 没有：返回 null 表示未知
    var out = [];
    var today = dayOf(now);
    tasks.forEach(function (t) {
      if (!t || !t.id) return;
      var plan = planMs(t.date, t.time);
      if (t.status === 'done') {
        // 没有真实完成时刻就不算「最近完成」，退化为 unknown，不拿当前时间冒充
        var doneAt = typeof t.completedAt === 'number' && isFinite(t.completedAt) ? t.completedAt : null;
        if (doneAt && now - doneAt <= RECENT_MS) out.push(item('butler:task:' + t.id, 'butler', 'task', STATE.COMPLETED, doneAt, {}));
        return;
      }
      if (t.status === 'cancelled') return;      // 取消不进入聊天素材
      if (t.status !== 'pending') return;
      if (!plan) return;
      if (plan > now + MAX_FUTURE_MS) return;
      var d = dayOfStamp(t.date);
      if (d && d < today) out.push(item('butler:task:' + t.id, 'butler', 'task', STATE.EXPIRED, plan, {}));
      else out.push(item('butler:task:' + t.id, 'butler', 'task', STATE.PLANNED, plan, {}));
    });
    return out;
  }

  // 背词：只有 history 里程序记录的完成才算；没有可靠的「进行中轮次」字段 → ongoing 记为未知
  function fromVocab(now) {
    var v = json(getKey('ylxh.vocab.v1'));
    if (!v || !Array.isArray(v.history)) return null;
    var out = [];
    v.history.forEach(function (r) {
      var at = r && typeof r.at === 'number' ? r.at : null;
      if (at === null || at > now) return;
      if (now - at > RECENT_MS) return;
      out.push(item('vocab:round:' + at, 'vocab', 'vocab.round', STATE.COMPLETED, at, {}));
    });
    return out;
  }

  // 读书：nowReading / status=reading 为在读；nextBookId / preparing 为计划；history 为完成
  function fromReading(now) {
    var r = json(getKey('ylxh.radio.reading'));
    if (!r || !Array.isArray(r.books)) return null;
    var out = [];
    var ongoing = r.nowReading || null;
    r.books.forEach(function (b) {
      if (!b || !b.id) return;
      if (b.status === 'reading' || (ongoing && b.id === ongoing)) {
        out.push(item('reading:book:' + b.id, 'reading', 'reading.book', STATE.ONGOING, now, {}));
      } else if (b.status === 'preparing' || (r.nextBookId && b.id === r.nextBookId)) {
        out.push(item('reading:book:' + b.id, 'reading', 'reading.book', STATE.PLANNED, now, {}));
      }
    });
    (Array.isArray(r.history) ? r.history : []).forEach(function (h) {
      var at = h && typeof h.finishedAt === 'number' ? h.finishedAt : null;
      if (at === null || at > now) return;
      if (now - at > RECENT_MS) return;
      out.push(item('reading:finish:' + h.bookId + ':' + at, 'reading', 'reading.finish', STATE.COMPLETED, at, {}));
    });
    return out;
  }

  // 电台：position>0 且未 completed → 有进度的在听；completed → 完成。暂停不冒充完成
  function fromRadio(now) {
    var p = json(getKey('ylxh.radio.progress'));
    if (!p || typeof p !== 'object') return null;
    var out = [];
    Object.keys(p).forEach(function (id) {
      var rec = p[id];
      if (!rec || typeof rec !== 'object') return;
      var at = typeof rec.updatedAt === 'number' ? rec.updatedAt : now;
      if (rec.completed === true) {
        if (now - at <= RECENT_MS) out.push(item('radio:episode:' + id, 'radio', 'radio.episode', STATE.COMPLETED, at, {}));
        return;
      }
      if (typeof rec.position === 'number' && rec.position > 0) {
        out.push(item('radio:episode:' + id, 'radio', 'radio.episode', STATE.ONGOING, at, {}));
      }
    });
    return out;
  }

  // 游戏：只有既有完成存档才算；覆盖写，只承认最后一次
  function fromGames(now) {
    var g = json(getKey('ylxh.playground.v1'));
    if (!g || !g.finished || typeof g.finished !== 'object') return null;
    var out = [];
    Object.keys(g.finished).forEach(function (id) {
      var rec = g.finished[id];
      var at = rec && typeof rec.at === 'number' ? rec.at : null;
      if (at === null || at > now) return;
      if (now - at > RECENT_MS) return;
      out.push(item('game:finish:' + id + ':' + at, 'playground', 'game.finish', STATE.COMPLETED, at, { game: id }));
    });
    return out;
  }

  // 未来信：未到期 planned；到期未处理 ongoing；已回信 completed；失败不算完成
  function fromLetters(letters, now) {
    if (!Array.isArray(letters)) return null;
    var out = [];
    letters.forEach(function (rec) {
      if (!rec || rec.id === undefined) return;
      var openAt = typeof rec.openAt === 'number' ? rec.openAt : null;
      var id = 'room:letter:' + rec.id;
      if (rec.status === 'sealed') {
        if (openAt !== null && openAt <= now) out.push(item(id, 'room', 'letter', STATE.ONGOING, openAt, {}));
        else out.push(item(id, 'room', 'letter', STATE.PLANNED, openAt, {}));
        return;
      }
      if (rec.status !== 'opened') return;
      if (rec.replyStatus === 'done') out.push(item(id, 'room', 'letter', STATE.COMPLETED, typeof rec.openedAt === 'number' ? rec.openedAt : now, {}));
      else out.push(item(id, 'room', 'letter', STATE.ONGOING, typeof rec.openedAt === 'number' ? rec.openedAt : now, {}));
    });
    return out;
  }

  /* ---------------- 汇总与缓存 ---------------- */

  function countBy(items) {
    var c = {};
    Object.keys(STATE).forEach(function (k) { c[STATE[k]] = 0; });
    items.forEach(function (it) { if (c[it.state] === undefined) c[it.state] = 0; c[it.state] += 1; });
    return c;
  }

  // 只保留会进聊天的类别优先级：ongoing > planned > completed > expired
  var RANK = { ongoing: 0, planned: 1, completed: 2, expired: 3, cancelled: 4, occurred: 5, unknown: 6 };
  function trim(items) {
    var sorted = items.slice().sort(function (a, b) {
      var r = (RANK[a.state] || 9) - (RANK[b.state] || 9);
      if (r !== 0) return r;
      return (b.at || 0) - (a.at || 0);
    });
    return sorted.slice(0, MAX_ITEMS);
  }

  /**
   * 重新汇总并写入缓存。异步仅因为任务/信件由 provider 读取（可能是 IndexedDB）。
   * 返回 { items, counts, sources }；某个来源读不到时 sources[x]='unknown'，不猜。
   */
  async function refresh(opts) {
    opts = opts || {};
    var now = nowMs(opts.now);
    var sources = {};
    var items = [];

    function merge(name, list) {
      if (list === null || list === undefined) { sources[name] = 'unknown'; return; }
      sources[name] = list.length;
      items = items.concat(list);
    }

    var tasks = null;
    if (typeof providers.tasks === 'function') {
      try { tasks = await providers.tasks(); } catch (e) { tasks = null; }
    }
    merge('butler', fromTasks(tasks, now));

    var letters = null;
    if (typeof providers.letters === 'function') {
      try { letters = await providers.letters(); } catch (e) { letters = null; }
    }
    merge('letter', fromLetters(letters, now));

    merge('vocab', fromVocab(now));
    merge('reading', fromReading(now));
    merge('radio', fromRadio(now));
    merge('playground', fromGames(now));

    var kept = trim(items);
    var data = { v: 1, at: now, items: kept, counts: countBy(kept), sources: sources };
    writeCache(data);
    return data;
  }

  function writeCache(data) {
    var s = local();
    if (!s) return data;
    try { s.setItem(KEY, JSON.stringify(data)); } catch (e) { /* 配额/隐私模式：静默降级为仅内存 */ }
    return data;
  }

  function normalize(raw) {
    var o = typeof raw === 'string' ? json(raw) : raw;
    if (!o || typeof o !== 'object' || !Array.isArray(o.items)) return null;
    return o;
  }

  // 只读缓存（同步）：LifeContext 用它，避免在聊天链路上 await
  function cached() { return normalize(getKey(KEY)); }

  function snapshot(opts) { return refresh(opts); }

  function clearCache() {
    var s = local();
    try { if (s) s.removeItem(KEY); } catch (e) {}
  }

  /* ---------------- 测试钩子 ---------------- */
  function _setProviders(p) {
    p = p || {};
    providers.tasks = typeof p.tasks === 'function' ? p.tasks : null;
    providers.letters = typeof p.letters === 'function' ? p.letters : null;
    providers.storage = p.storage || null;
    return api;
  }
  function _reset() {
    providers = { tasks: null, letters: null, storage: null };
    return api;
  }

  var api = {
    STATE: STATE,
    refresh: refresh,
    snapshot: snapshot,
    cached: cached,
    clearCache: clearCache,
    fromTasks: fromTasks,
    fromLetters: fromLetters,
    fromVocab: fromVocab,
    fromReading: fromReading,
    fromRadio: fromRadio,
    fromGames: fromGames,
    _setProviders: _setProviders,
    _reset: _reset,
    _keys: { KEY: KEY, MAX_ITEMS: MAX_ITEMS, RECENT_MS: RECENT_MS },
  };
  root.LifeState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
