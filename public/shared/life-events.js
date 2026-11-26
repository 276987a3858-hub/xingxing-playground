/* public/shared/life-events.js — P1-b 真实生活事件层
 * 只记录「真实发生 / 明确确认」的事件；计划(planned)、进行中(ongoing) 只登记不算发生。
 * 存储：localStorage['ylxh.life.log.v1'] = { v, items: [] }
 * 边界：不访问 IndexedDB、不发请求、不调用 AI；事件写入本身不触发任何网络行为。
 * 隐私：本地可存短标题（≤20 字）供去重展示；LifeContext 只输出计数，不输出标题。
 */
(function (root) {
  'use strict';

  var KEY = 'ylxh.life.log.v1';
  var MAX_ITEMS = 200;
  var KEEP_MS = 30 * 86400000;
  var MAX_TITLE = 20;

  /* ---------- P5.1：回忆选材（纯本地，0 请求） ---------- */
  var RECALL_KEY = 'ylxh.life.recall.v1';
  var RECALL_MAX = 5;
  var RECALL_MIN_AGE = 86400000;        // 至少 1 天前才算「回忆」
  var RECALL_MAX_AGE = 30 * 86400000;   // 与事件保留期一致，不额外扩期
  var TYPE_COOLDOWN = 3 * 86400000;     // 同类型 3 天冷却（软约束，只在有别的可选时才避开）

  // 只做「存档 id → 自然中文名」的展示映射，不改任何存档
  var GAME_LABEL = {
    quiz: '星星问答', planets: '一起背单词', adventure: '星空棋局',
    puzzle: '星光拼图', date: '星夜21点', kitchen: '厨房大危机',
    gomoku: '星空棋局', blackjack: '星夜21点', vocab: '一起背单词', radio: '午夜电台',
  };
  var KIND_OF = {
    'game.finish': 'game', 'game.shared': 'game', 'reading.finish': 'reading', 'radio.episode': 'radio',
    'vocab.round': 'vocab', 'task.done': 'task',
  };
  var WEIGHT = { game: 4, reading: 3, radio: 3, task: 2, vocab: 1 };

  var SOURCES = ['butler', 'playground', 'radio', 'vocab', 'reading', 'room'];
  var STATUS = { OCCURRED: 'occurred', ONGOING: 'ongoing', PLANNED: 'planned' };

  var store = null;
  var mem = null;

  function wrap(getter) {
    return {
      get: function (k) { try { return getter().getItem(k); } catch (e) { return null; } },
      set: function (k, v) { try { getter().setItem(k, v); return true; } catch (e) { return false; } },
    };
  }
  function local() {
    if (!store) store = wrap(function () { return localStorage; });
    return store;
  }

  function empty() { return { v: 1, items: [] }; }

  function normalize(raw) {
    var d = empty();
    var o = raw;
    if (typeof raw === 'string') {
      try { o = JSON.parse(raw); } catch (e) { return d; }
    }
    if (!o || typeof o !== 'object' || !Array.isArray(o.items)) return d;
    o.items.forEach(function (it) {
      if (!it || typeof it.id !== 'string' || !it.id) return;
      if (typeof it.at !== 'number' || !isFinite(it.at)) return;
      if (typeof it.type !== 'string' || !it.type) return;
      d.items.push({
        id: it.id,
        at: it.at,
        day: typeof it.day === 'string' ? it.day : null,
        source: SOURCES.indexOf(it.source) === -1 ? 'room' : it.source,
        type: it.type,
        status: it.status === STATUS.ONGOING || it.status === STATUS.PLANNED ? it.status : STATUS.OCCURRED,
        title: typeof it.title === 'string' ? it.title.slice(0, MAX_TITLE) : '',
        meta: (it.meta && typeof it.meta === 'object') ? it.meta : {},
      });
    });
    return d;
  }

  function read() {
    if (mem) return mem;
    mem = normalize(local().get(KEY));
    return mem;
  }

  function readFresh() {
    var disk = normalize(local().get(KEY));
    var m = read();
    // 写前合并：磁盘里没有的事件补进来（多标签/跨页面写入）
    if (disk.items.length) {
      var seen = {};
      m.items.forEach(function (it) { seen[it.id] = true; });
      disk.items.forEach(function (it) { if (!seen[it.id]) m.items.push(it); });
      m.items.sort(function (a, b) { return a.at - b.at; });
    }
    return m;
  }

  function persist(data) {
    // 裁剪：先按 30 天，再按 200 条
    var now = Date.now();
    var kept = data.items.filter(function (it) { return now - it.at <= KEEP_MS; });
    if (kept.length > MAX_ITEMS) kept = kept.slice(kept.length - MAX_ITEMS);
    data.items = kept;
    mem = data;
    local().set(KEY, JSON.stringify(data));
    return data;
  }

  function dayOf(ms) {
    var C = root.LifeClock;
    return C ? C.formatDay(ms) : null;
  }

  /**
   * 记录一条事件。返回 { ok, added, reason }
   * - 缺少 id/type/at 视为无效，不写；
   * - 同 id 幂等；
   * - 写入失败返回 ok:false，调用方不得据此认为事件已存在。
   */
  function notifyFeed() {
    try {
      if (root && typeof root.dispatchEvent === 'function' && typeof root.CustomEvent === 'function') {
        root.dispatchEvent(new root.CustomEvent('life:feed'));
      }
    } catch (e) { /* 通知失败不影响事件写入结果 */ }
  }

  function record(ev) {
    if (!ev || typeof ev !== 'object') return { ok: false, added: false, reason: 'invalid' };
    var at = typeof ev.at === 'number' && isFinite(ev.at) ? ev.at : null;
    if (!ev.id || !ev.type || at === null) return { ok: false, added: false, reason: 'invalid' };
    var status = ev.status === STATUS.ONGOING || ev.status === STATUS.PLANNED ? ev.status : STATUS.OCCURRED;
    var data = readFresh();
    for (var i = 0; i < data.items.length; i++) {
      if (data.items[i].id === ev.id) return { ok: true, added: false, reason: 'duplicate' };
    }
    var item = {
      id: String(ev.id),
      at: at,
      day: typeof ev.day === 'string' ? ev.day : dayOf(at),
      source: SOURCES.indexOf(ev.source) === -1 ? 'room' : ev.source,
      type: String(ev.type),
      status: status,
      title: typeof ev.title === 'string' ? ev.title.slice(0, MAX_TITLE) : '',
      meta: (ev.meta && typeof ev.meta === 'object') ? ev.meta : {},
    };
    data.items.push(item);
    data.items.sort(function (a, b) { return a.at - b.at; });
    persist(data);
    var raw = local().get(KEY);
    var ok = !!(raw && raw.indexOf(item.id) !== -1);
    if (!ok) {
      // 写入失败（配额/隐私模式）：回滚内存，避免「以为记下了」
      data.items = data.items.filter(function (it) { return it.id !== item.id; });
      mem = data;
      return { ok: false, added: false, reason: 'write-failed' };
    }
    notifyFeed();
    return { ok: true, added: true };
  }

  function list() { return read().items.slice(); }

  // 只汇总 occurred，且只返回类型与时间（无标题）
  function summarySince(fromMs, toMs) {
    var from = typeof fromMs === 'number' && isFinite(fromMs) ? fromMs : 0;
    var to = typeof toMs === 'number' && isFinite(toMs) ? toMs : Date.now();
    return read().items.filter(function (it) {
      return it.status === STATUS.OCCURRED && it.at >= from && it.at <= to;
    }).map(function (it) { return { type: it.type, at: it.at, source: it.source }; });
  }

  function countSince(fromMs, toMs) { return summarySince(fromMs, toMs).length; }

  /* ---------- P5.1：回忆去重记录（只存 id/时间/类型，不存任何原文） ---------- */
  function readRecall() {
    var raw = local().get(RECALL_KEY);
    var d = { v: 1, items: [] };
    if (!raw) return d;
    var o;
    try { o = JSON.parse(raw); } catch (e) { return d; }
    if (!o || !Array.isArray(o.items)) return d;
    o.items.forEach(function (r) {
      if (!r || typeof r.id !== 'string' || typeof r.at !== 'number') return;
      d.items.push({ id: r.id, at: r.at, type: typeof r.type === 'string' ? r.type : '' });
    });
    return d;
  }
  function writeRecall(data) {
    data.items = data.items.slice(-RECALL_MAX);
    local().set(RECALL_KEY, JSON.stringify({ v: 1, items: data.items }));
    return data;
  }
  /** 只有 idle 主动互动真的成功之后才调用：失败不占用候选。 */
  function markRecalled(id, type, nowMs) {
    if (!id) return false;
    var now = typeof nowMs === 'number' && isFinite(nowMs) ? nowMs : Date.now();
    var d = readRecall();
    if (d.items.some(function (r) { return r.id === id; })) return false;
    d.items.push({ id: String(id), at: now, type: String(type || '') });
    writeRecall(d);
    return true;
  }

  function gameName(id) { return GAME_LABEL[id] || null; }

  // 只读存档里的书名/节目名，用于把事件变成一句人话；读不到就不选
  function archiveCtx() {
    var books = null, eps = null;
    return {
      bookTitle: function (id) {
        if (books === null) {
          books = {};
          var d = safeJSON(local().get('ylxh.radio.reading'));
          ((d && d.books) || []).forEach(function (b) { if (b && b.id && b.title) books[b.id] = b.title; });
        }
        return books[id] ? String(books[id]).slice(0, 18) : null;
      },
      episodeTitle: function (id) {
        if (eps === null) {
          eps = {};
          var list = safeJSON(local().get('ylxh.radio.episodes'));
          (Array.isArray(list) ? list : []).forEach(function (e) { if (e && e.id && e.title) eps[e.id] = e.title; });
        }
        return eps[id] ? String(eps[id]).slice(0, 18) : null;
      },
    };
  }

  function describe(it, ctx) {
    var kind = KIND_OF[it.type];
    if (!kind) return null;
    if (kind === 'game') {
      // 聊天里双方真的玩完的那一局：标题本身就是游戏名，不需要大厅存档 id 映射
      if (it.type === 'game.shared') {
        var shared = String(it.title || '').trim().slice(0, 18);
        return shared ? { kind: kind, label: shared, text: '你们一起玩过「' + shared + '」' } : null;
      }
      var n = gameName(it.meta && it.meta.game);
      return n ? { kind: kind, label: n, text: '你们一起玩过「' + n + '」' } : null;
    }
    if (kind === 'task') {
      var t = String(it.title || '').trim();
      return t ? { kind: kind, label: t, text: '她完成了「' + t + '」' } : null;
    }
    if (kind === 'vocab') {
      var size = Number(it.meta && it.meta.size) || 0;
      return { kind: kind, label: '背词', text: size > 0 ? ('她背了一轮词（' + size + ' 个）') : '她背了一轮词' };
    }
    if (kind === 'reading') {
      var book = ctx.bookTitle(String(it.id).split(':')[2]);
      return book ? { kind: kind, label: book, text: '她读完了《' + book + '》' } : null;
    }
    if (kind === 'radio') {
      var eid = (it.meta && it.meta.episode) || String(it.id).split(':')[2];
      var ep = ctx.episodeTitle(eid);
      return ep ? { kind: kind, label: ep, text: '她听完了《' + ep + '》这一期' } : null;
    }
    return null;
  }

  /**
   * 从真实事件里挑一条可以自然提起的回忆（每次最多 1 条，纯本地）。
   * opts: { now, minAgeMs, maxAgeMs, exclude:[kind] }
   * 返回 { id, type, kind, label, at, daysAgo, text } 或 null。
   */
  function pickRecall(opts) {
    opts = opts || {};
    var now = typeof opts.now === 'number' && isFinite(opts.now) ? opts.now : Date.now();
    var minAge = typeof opts.minAgeMs === 'number' ? opts.minAgeMs : RECALL_MIN_AGE;
    var maxAge = typeof opts.maxAgeMs === 'number' ? opts.maxAgeMs : RECALL_MAX_AGE;
    var exclude = Array.isArray(opts.exclude) ? opts.exclude : [];

    var recalled = readRecall().items;
    var seen = {}, recentType = {};
    recalled.forEach(function (r) {
      seen[r.id] = true;
      if (r.type && now - r.at <= TYPE_COOLDOWN) recentType[r.type] = true;
    });

    var ctx = archiveCtx();
    var pool = [];
    read().items.forEach(function (it) {
      if (it.status !== STATUS.OCCURRED) return;              // planned/ongoing 不选
      var kind = KIND_OF[it.type];
      if (!kind) return;                                      // 来源不明/不支持的类型
      if (exclude.indexOf(kind) !== -1) return;               // 她屏蔽的话题
      var age = now - it.at;
      if (age < minAge || age > maxAge) return;
      if (seen[it.id]) return;                                // 已经用过
      var d = describe(it, ctx);
      if (!d) return;                                         // 没有可靠名称 → 不选
      pool.push({
        id: it.id, at: it.at, type: it.type, kind: kind, label: d.label, text: d.text,
        w: WEIGHT[kind] || 1, cool: recentType[it.type] ? 1 : 0, origin: 'event',
      });
    });

    // 珍藏：最低权重候选。只认调用方传进来的 { id, title, at }（标题+日期），
    // 绝不读正文，也不改写成「你们一起做过」——珍藏只是她收下的东西。
    (Array.isArray(opts.keeps) ? opts.keeps : []).forEach(function (k) {
      if (!k || !k.id) return;
      if (exclude.indexOf('keep') !== -1) return;
      var title = String(k.title || '').trim().slice(0, 18);
      if (!title) return;                                     // 没有标题 → 不选（不编造）
      var kat = typeof k.at === 'number' && isFinite(k.at) ? k.at : null;
      if (kat === null) return;
      var kage = now - kat;
      if (kage < minAge || kage > maxAge) return;
      var kid = 'keep:' + k.id;
      if (seen[kid]) return;
      pool.push({
        id: kid, at: kat, type: 'keep.saved', kind: 'keep', label: title,
        text: '她把「' + title + '」收进了珍藏', w: 0, cool: 0, origin: 'keep',
      });
    });
    if (!pool.length) return null;

    pool.sort(function (a, b) {
      if (a.cool !== b.cool) return a.cool - b.cool;           // 刚提过的类型排后（软约束）
      if (a.w !== b.w) return b.w - a.w;                       // 有具体对象的优先
      return b.at - a.at;                                      // 同等条件下更新的更值得记
    });
    var top = pool.filter(function (x) { return x.cool === pool[0].cool && x.w === pool[0].w; });
    var pick = top[Math.floor(now / 60000) % top.length];

    var C = root.LifeClock;
    var days = Math.max(1, Math.floor((now - pick.at) / 86400000));
    var rel = C ? C.relative(pick.at, now) : null;
    var when = (rel && rel.text) ? rel.text : (days + ' 天前');
    return {
      id: pick.id, type: pick.type, kind: pick.kind, label: pick.label,
      origin: pick.origin, at: pick.at, daysAgo: days, text: when + '，' + pick.text + '。',
    };
  }

  /* ---------- 从既有存档同步（只读既有数据，不做轮询、不推断时刻） ---------- */
  function safeJSON(raw) { try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }

  function syncArchives(nowMs) {
    var now = typeof nowMs === 'number' && isFinite(nowMs) ? nowMs : Date.now();
    var added = 0;
    function put(ev) { var r = record(ev); if (r.added) added += 1; }

    // 游戏：既有完成存档 finished[id].at 已是真实完成时刻
    var pf = safeJSON(local().get('ylxh.playground.v1'));
    if (pf && pf.finished && typeof pf.finished === 'object') {
      Object.keys(pf.finished).forEach(function (id) {
        var rec = pf.finished[id];
        var at = rec && typeof rec.at === 'number' ? rec.at : null;
        if (at === null || at > now) return;
        put({ id: 'game:finish:' + id + ':' + at, at: at, source: 'playground', type: 'game.finish', title: id, meta: { game: id } });
      });
    }

    // 游戏活动：统一活动记录；与 finished 存档按「游戏 + 时刻（±60s）」排重，避免同一局统计两次
    var ga = safeJSON(local().get('ylxh.game.activity.v1'));
    if (ga && Array.isArray(ga.items)) {
      var alias = { vocab: 'planets', blackjack: 'date', gomoku: 'adventure' };
      var fin = [];
      if (pf && pf.finished && typeof pf.finished === 'object') {
        Object.keys(pf.finished).forEach(function (id) {
          var fr = pf.finished[id];
          if (fr && typeof fr.at === 'number') fin.push({ id: id, at: fr.at });
        });
      }
      ga.items.forEach(function (it) {
        if (!it || typeof it.endAt !== 'number' || it.endAt > now) return;
        var g = String(it.game || '');
        if (fin.some(function (f) {
          return Math.abs(f.at - it.endAt) < 60000 && (f.id === g || f.id === (alias[g] || ''));
        })) return;
        put({
          id: 'game:activity:' + (it.id || (g + ':' + it.endAt)), at: it.endAt,
          source: 'playground', type: 'game.finish', title: g,
          meta: { game: g, name: String(it.name || ''), result: String(it.result || ''), durMs: Number(it.durMs) || 0 },
        });
      });
    }

    // 背词：history[].at 是每轮结束时刻（不是每答对一个词）
    var vb = safeJSON(local().get('ylxh.vocab.v1'));
    if (vb && Array.isArray(vb.history)) {
      vb.history.forEach(function (r) {
        var at = r && typeof r.at === 'number' ? r.at : null;
        if (at === null || at > now) return;
        put({ id: 'vocab:round:' + at, at: at, source: 'vocab', type: 'vocab.round', meta: { size: Number(r.size) || 0 } });
      });
    }

    // 电台：只有 completed 且时长为正的进度才算听完，暂停/仅打开不算
    var rp = safeJSON(local().get('ylxh.radio.progress'));
    if (rp && typeof rp === 'object') {
      Object.keys(rp).forEach(function (id) {
        var rec = rp[id];
        if (!rec || rec.completed !== true) return;
        var at = typeof rec.updatedAt === 'number' ? rec.updatedAt : null;
        if (at === null || at > now) return;
        put({ id: 'radio:episode:' + id + ':' + at, at: at, source: 'radio', type: 'radio.episode', meta: { episode: id } });
      });
    }

    // 读书：history[].finishedAt 是程序记录的读完时刻
    var rd = safeJSON(local().get('ylxh.radio.reading'));
    if (rd && Array.isArray(rd.history)) {
      rd.history.forEach(function (h) {
        var at = h && typeof h.finishedAt === 'number' ? h.finishedAt : null;
        if (at === null || at > now) return;
        put({ id: 'reading:finish:' + h.bookId + ':' + at, at: at, source: 'reading', type: 'reading.finish', meta: {} });
      });
    }

    return { added: added };
  }

  /* ---------- 测试钩子 ---------- */
  function _setStorage(opts) {
    opts = opts || {};
    store = opts.local ? wrap(function () { return opts.local; }) : null;
    return api;
  }
  function _reset() { store = null; mem = null; if (activities) activities._reset(); return api; }
  function _raw() { return mem; }

  /* ---------- 游戏活动长期记录：独立于聊天 UI，未来 Agent 只读复用 ---------- */
  var GA_KEY = 'ylxh.game.activity.v1';
  var GA_SEEN_KEY = 'ylxh.game.activity.seen.v1';
  var GA_MAX = 500, GA_KEEP = 180 * 86400000, GA_MIN = 45000, GA_MAX_DUR = 2 * 3600000, GA_SEEN_MAX = 500;
  var GA_NAME = { quiz: '星星问答', vocab: '一起背单词', planets: '一起背单词', gomoku: '星空棋局',
    adventure: '星空棋局', puzzle: '星光拼图', blackjack: '星夜21点', date: '星夜21点', kitchen: '厨房大危机' };
  var gaMem = null, gaSeen = null;

  function gaRaw(key) { return safeJSON(local().get(key)); }
  function gaList() {
    if (gaMem) return gaMem.items.slice();
    var d = gaRaw(GA_KEY);
    var rows = (d && Array.isArray(d.items) ? d.items : []).filter(function (it) {
      return it && typeof it.id === 'string' && typeof it.game === 'string'
        && typeof it.startAt === 'number' && typeof it.endAt === 'number';
    }).map(function (it) {
      return { id: it.id, game: it.game, name: String(it.name || ''), result: String(it.result || ''),
        startAt: it.startAt, endAt: it.endAt, durMs: gaDur(it.durMs),
        createdAt: typeof it.createdAt === 'number' ? it.createdAt : it.endAt };
    });
    gaMem = { v: 1, items: rows };
    return rows.slice();
  }
  function gaDur(n) { return Math.max(0, Math.min(Number(n) || 0, GA_MAX_DUR)); }
  function gaSave(d) {
    var now = Date.now();
    var kept = d.items.filter(function (it) { return now - it.endAt <= GA_KEEP; });
    kept.sort(function (a, b) { return a.createdAt - b.createdAt; });
    if (kept.length > GA_MAX) kept = kept.slice(kept.length - GA_MAX);
    kept.sort(function (a, b) { return b.endAt - a.endAt; });
    d.items = kept; gaMem = d;
    local().set(GA_KEY, JSON.stringify(d));
  }
  function gaRecord(ev) {
    if (!ev || typeof ev.id !== 'string' || !ev.id || typeof ev.game !== 'string') return { added: false, reason: 'invalid' };
    var d = { v: 1, items: gaList() }, at = Date.now();
    if (d.items.some(function (x) { return x.id === ev.id; })) return { added: false, reason: 'id' };
    if (d.items.some(function (x) { return x.game === ev.game && Math.abs(x.startAt - ev.startAt) < 60000; })) return { added: false, reason: 'session' };
    d.items.push({ id: ev.id, game: ev.game, name: String(ev.name || ''), result: String(ev.result || '').slice(0, 120),
      startAt: Number(ev.startAt) || at, endAt: Number(ev.endAt) || at, durMs: gaDur(ev.durMs), createdAt: at });
    gaSave(d);
    return { added: true, reason: 'ok' };
  }
  function gaSeenSet() {
    if (gaSeen) return gaSeen;
    var d = gaRaw(GA_SEEN_KEY);
    gaSeen = new Set(d && Array.isArray(d.items) ? d.items.filter(function (x) { return typeof x === 'string'; }) : []);
    return gaSeen;
  }
  function gaMarkSeen(ids) {
    var set = gaSeenSet();
    (Array.isArray(ids) ? ids : [ids]).forEach(function (id) { if (typeof id === 'string') set.add(id); });
    var all = Array.from(set).slice(-GA_SEEN_MAX);
    gaSeen = new Set(all);
    local().set(GA_SEEN_KEY, JSON.stringify({ v: 1, items: all }));
  }
  function gaRecent(now, o) {
    o = o || {};
    var t = typeof now === 'number' && isFinite(now) ? now : Date.now();
    var since = t - (Number(o.hours) || 24) * 3600000, seen = gaSeenSet();
    return gaList().filter(function (x) { return x.endAt >= since && x.endAt <= t && !seen.has(x.id); })
      .sort(function (a, b) { return b.endAt - a.endAt; })
      .slice(0, Math.max(1, Math.min(10, Number(o.limit) || 3)));
  }
  function gaSearch(o) {
    o = o || {};
    var t = typeof o.now === 'number' ? o.now : Date.now();
    var days = Math.max(1, Math.min(180, Number(o.days) || 7));
    var q = String(o.query || '').trim().toLowerCase();
    var rows = gaList().filter(function (x) {
      return x.endAt >= t - days * 86400000 && x.endAt <= t && (!o.game || x.game === o.game)
        && (!q || (x.name + ' ' + (GA_NAME[x.game] || '') + ' ' + x.game + ' ' + x.result).toLowerCase().indexOf(q) !== -1);
    }).map(function (x) {
      return { x: x, score: (q && (x.name + ' ' + (GA_NAME[x.game] || '')).toLowerCase().indexOf(q) !== -1) ? 2 : 1 };
    });
    rows.sort(function (a, b) { return b.score - a.score || b.x.endAt - a.x.endAt; });
    return rows.slice(0, Math.max(1, Math.min(10, Number(o.limit) || 5))).map(function (r) { return r.x; });
  }
  function gaDescribe(it, now) {
    if (!it) return '';
    var t = typeof now === 'number' ? now : Date.now(), age = t - it.endAt, h = new Date(it.endAt).getHours();
    var when = age < 3600000 ? '刚刚' : age < 86400000 ? (h < 11 ? '今天上午' : h < 18 ? '今天下午' : '今天晚上') : '之前';
    var mins = Math.round(it.durMs / 60000);
    return '她' + when + '在游乐场玩过「' + (it.name || GA_NAME[it.game] || '小游戏') + '」'
      + (mins >= 1 ? '，活动持续约 ' + mins + ' 分钟' : '')
      + (it.result ? '，结果是「' + String(it.result).slice(0, 40) + '」' : '') + '。';
  }
  // 对外只读门面：读取历史/近期不会顺带获得改写记录或珍藏的能力
  var publicActivities = { recent: gaRecent, search: gaSearch, describe: gaDescribe,
    list: gaList, markSeen: gaMarkSeen, _keys: { KEY: GA_KEY, MAX: GA_MAX, KEEP_MS: GA_KEEP } };
  var activities = { record: gaRecord, recent: gaRecent, search: gaSearch, describe: gaDescribe,
    markSeen: gaMarkSeen, list: gaList,
    _reset: function () { gaMem = null; gaSeen = null; },
    _keys: { KEY: GA_KEY, SEEN_KEY: GA_SEEN_KEY, MAX: GA_MAX, KEEP_MS: GA_KEEP, MIN_MS: GA_MIN } };
  if (!root.GameActivity) root.GameActivity = publicActivities;

  var api = {
    record: record,
    activities: activities,
    list: list,
    summarySince: summarySince,
    countSince: countSince,
    syncArchives: syncArchives,
    pickRecall: pickRecall,
    markRecalled: markRecalled,
    gameName: gameName,
    STATUS: STATUS,
    SOURCES: SOURCES,
    _setStorage: _setStorage,
    _reset: _reset,
    _raw: _raw,
    _keys: { KEY: KEY, MAX_ITEMS: MAX_ITEMS, KEEP_MS: KEEP_MS, MAX_TITLE: MAX_TITLE, RECALL_KEY: RECALL_KEY, RECALL_MAX: RECALL_MAX },
  };
  root.LifeEvents = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
