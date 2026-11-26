/* public/shared/life-feed.js — 「小屋的动静」展示层
 *
 * 职责：把已经真实存在的记录，整理成小屋首页的一段动态。
 * 边界：
 *   - 只读存档（localStorage + 房间 IndexedDB 的 keeps / starDiaries），不写任何源数据；
 *   - 不发请求、不调用 AI、不轮询、不新增定时任务；
 *   - 不读日记正文、不读珍藏正文；只取时间、状态、标题类元数据；
 *   - 不升级 star_fifi_room（open 不带版本号，缺表就直接返回空）。
 * 唯一的写入：localStorage['ylxh.life.feed.v1']，只存「某个事件第一次用第几句」，
 * 用来保证刷新/切换范围时文案不变；不复制任何事件正文。
 */
(function (root) {
  'use strict';

  var FEED_KEY = 'ylxh.life.feed.v1';
  var RETAIN_MS = 7 * 86400000;      // 历史保留 7 天
  var FRESH_MS = 30 * 60000;         // 「此刻」只认 30 分钟内
  var MAX_PER_DAY = 2;               // 历史每天最多两条
  var MAX_TODAY = 3;                 // 今天最多三条
  var SURPRISE_GAP = 3 * 86400000;   // 惊喜退让期：近三天出现过，就先让位给别的内容
  var MIN_GAME_MS = 45 * 60000;      // 游戏至少 45 分钟才算一段经历
  var HINT_TTL = 24 * 3600000;       // 结算回聊提示：创建后 24 小时

  /* ---------------- 时间工具（本地时区，不写死「今天」） ---------------- */
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function dayOf(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function startOfDay(ms) {
    var d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  function timeOf(ms) {
    var d = new Date(ms);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function dateLabel(ms) {
    var d = new Date(ms);
    return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
  }
  function weekdayOf(ms) {
    return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(ms).getDay()];
  }
  function sameDay(a, b) { return dayOf(a) === dayOf(b); }

  function hash(s) {
    var h = 5381, str = String(s || '');
    for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return h >>> 0;
  }

  /* ---------------- 小屋变化：暂时没有可展示的记录 ----------------
   * 这里的时间必须是「真的被记录下来的完成时刻」，不能拿文件修改时间凑，
   * 也不能拿设计稿里的日期倒推。核查结果（2026-11-19）：
   *   · 电台五栏排布：radio.js 只有工作区未提交改动，没有提交时间，只有 mtime；
   *   · 珍藏合一：room-keeps.js 是未提交的新文件、collection.js 是未提交改动，只有 mtime；
   *   · 厨房菜谱本：recipes/*.js 只有 mtime；最近一次提交（e102e90，11-17 02:31）
   *     是「提交」这个动作的时间，不是屋里发生变化的时间。
   * 三者都没有任何持久化的「何时变成这样」的记录，所以现在一条都不展示。
   * 原文案留在这里，等出现真实完成时间再启用：
   *   电台：'电台那边换了排布。读书、谈心、英文广播、哄睡、放歌，各有各的位置了。'
   *   珍藏：'珍藏只剩一份了。大厅和屋里看的是同一批，你收下的东西不会两边对不上。'
   *   厨房：'厨房的菜谱本动过。'
   * 启用方式：补一条 { key, at(真实完成时刻), variants }，其余逻辑不用改。
   */
  var HOUSE_EVENTS = [];
  var houseEvents = HOUSE_EVENTS;   // 可由 _setHouse 注入，仅用于验证选条规则

  // 结算回聊提示同样是固定素材，时间依据只有 game-end.js 的 mtime，
  // 同样不满足「真实完成时间」，暂时不展示。原文案：
  //   '结算那儿点一下就能接着说话，不用自己走回房间。'
  var HINTS = [];

  /* ---------------- 存储 ---------------- */
  var storeL = null;
  var mem = null;

  function ls() {
    if (storeL) return storeL;
    try { return root.localStorage; } catch (e) { return null; }
  }
  function readStore() {
    if (mem) return mem;
    var d = { v: 1, items: {} };
    try {
      var raw = ls() && ls().getItem(FEED_KEY);
      var o = raw ? JSON.parse(raw) : null;
      if (o && o.items && typeof o.items === 'object') {
        Object.keys(o.items).forEach(function (k) {
          var it = o.items[k];
          if (!it || typeof it.at !== 'number') return;
          d.items[k] = { at: it.at, v: typeof it.v === 'number' ? it.v : 0 };
        });
      }
    } catch (e) { /* 读不到就当作没有，不影响展示 */ }
    mem = d;
    return d;
  }
  function writeStore(d, now) {
    var items = {};
    Object.keys(d.items).forEach(function (k) {
      var it = d.items[k];
      if (now - it.at > RETAIN_MS) return;      // 只保留 7 天内的选择记录
      items[k] = it;
    });
    d.items = items;
    mem = d;
    try { ls() && ls().setItem(FEED_KEY, JSON.stringify(d)); } catch (e) {}
  }
  /** 取这个事件该用第几句：第一次决定后固定，刷新和切换范围都不换。 */
  function pickVariant(key, count, now) {
    if (count <= 1) return 0;
    var d = readStore();
    var it = d.items[key];
    if (it && typeof it.v === 'number' && it.v < count) return it.v;
    var idx = hash(key) % count;
    d.items[key] = { at: typeof it === 'object' && it && it.at ? it.at : now, v: idx };
    writeStore(d, now);
    return idx;
  }

  /* ---------------- 读取存档（全部只读） ---------------- */
  function readJSON(key) {
    try {
      var raw = ls() && ls().getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  var loaders = baseLoaders();

  /** 只读打开房间库：不带版本号，不建表、不升级；读不到就返回空数组 */
  function idbAll(name) {
    return new Promise(function (resolve) {
      var idb = root.indexedDB;
      if (!idb || !idb.open) { resolve([]); return; }
      var req;
      try { req = idb.open('star_fifi_room'); } catch (e) { resolve([]); return; }
      req.onupgradeneeded = function () { /* 库不存在时会被创建成空库，交给下面返回空 */ };
      req.onsuccess = function () {
        var db = req.result;
        try {
          if (!db.objectStoreNames.contains(name)) { db.close(); resolve([]); return; }
          var tx = db.transaction(name, 'readonly');
          var get = tx.objectStore(name).getAll();
          get.onsuccess = function () { db.close(); resolve(Array.isArray(get.result) ? get.result : []); };
          get.onerror = function () { db.close(); resolve([]); };
        } catch (e) { try { db.close(); } catch (e2) {} resolve([]); }
      };
      req.onerror = function () { resolve([]); };
      req.onblocked = function () { resolve([]); };
    });
  }

  /* ---------------- 文案 ---------------- */
  function plural(n) { return n + ' 个'; }

  function currentItem(now, data) {
    var v = data.vocab || {};
    var hist = Array.isArray(v.history) ? v.history : [];
    var latestRound = null;
    hist.forEach(function (r) {
      if (!r || typeof r.at !== 'number') return;
      if (r.at > now || !sameDay(r.at, now)) return;
      if (!latestRound || r.at > latestRound.at) latestRound = r;
    });
    var freshRound = latestRound && (now - latestRound.at <= FRESH_MS) ? latestRound : null;

    var acts = Array.isArray(data.activities) ? data.activities : [];
    var latestAct = null;
    acts.forEach(function (a) {
      if (!a || typeof a.endAt !== 'number') return;
      if (a.endAt > now || !sameDay(a.endAt, now)) return;
      if (!latestAct || a.endAt > latestAct.endAt) latestAct = a;
    });
    var freshAct = latestAct && (now - latestAct.endAt <= FRESH_MS) ? latestAct : null;

    var a1 = freshRound ? {
      key: 'vocab:round:' + freshRound.at,
      kind: 'moment',
      at: freshRound.at,
      variants: [
        '刚背了一轮。单词本还摊着。',
        '刚走完一轮词。先别急着关。',
        '刚背完。错的那些，我记着了。'
      ]
    } : null;

    var name = '一小局';
    if (freshAct) {
      var gname = '';
      try { gname = root.LifeEvents && root.LifeEvents.gameName ? root.LifeEvents.gameName(freshAct.game) : ''; } catch (e) { gname = ''; }
      name = gname || freshAct.name || '一小局';
      var a2 = {
        key: 'game:act:' + (freshAct.id || (freshAct.game + ':' + freshAct.endAt)),
        kind: 'moment',
        at: freshAct.endAt,
        variants: [
          '刚下完一局「' + name + '」。棋盘我先不收。',
          '玩完了。你刚才那步，我记住了。',
          '刚结束一局「' + name + '」。再来一局也行，我不困。'
        ]
      };
      if (!a1 || a2.at >= a1.at) return a2;
    }
    if (a1) return a1;
    return { key: 'moment:fallback:' + dayOf(now), kind: 'fallback', at: now, variants: fallbackLines(now) };
  }

  function fallbackLines(now) {
    var h = new Date(now).getHours();
    if (h < 5) return ['深夜了。我还醒着。', '夜里了，灯还亮着。你来了就说话。', '这个点我一般没睡。'];
    if (h < 8) return ['天刚亮。你起得比我早。', '早上了。我还没睡够。', '窗外的光刚进来。'];
    if (h < 11) return ['上午了。我在。', '上午。今天还没什么动静。', '这会儿安静。'];
    if (h < 13) return ['中午了。你吃饭了没有。', '中午。先吃点东西。', '这个点适合歇一会儿。'];
    if (h < 17) return ['下午了。困的话就眯一会儿。', '下午最容易困。我也是。', '下午。我在旁边。'];
    if (h < 19) return ['天黑了。你回来得正好。', '傍晚了。屋里刚开灯。', '这个时候最适合说说话。'];
    if (h < 23) return ['晚上了。今天还长。', '晚上了。想做什么都来得及。', '这个点，屋里最舒服。'];
    return ['快到深夜了。我还醒着。', '夜深了。你还不睡。', '这个点，我一般都很清醒。'];
  }

  /** 今日自动/手动掌握计数：只看词档案，不碰轮次；同时取各自最晚的掌握时刻 */
  function masteryCounts(vocab, now) {
    var words = vocab && vocab.words && typeof vocab.words === 'object' ? vocab.words : {};
    var auto = 0, manual = 0, autoAt = 0, manualAt = 0;
    Object.keys(words).forEach(function (k) {
      var e = words[k];
      if (!e || !e.mastered) return;
      if (typeof e.masteredAt !== 'number' || !sameDay(e.masteredAt, now) || e.masteredAt > now) return;
      if (e.masterySource === 'auto') { auto += 1; if (e.masteredAt > autoAt) autoAt = e.masteredAt; }
      else if (e.masterySource === 'manual') { manual += 1; if (e.masteredAt > manualAt) manualAt = e.masteredAt; }
    });
    return { auto: auto, manual: manual, autoAt: autoAt, manualAt: manualAt };
  }

  function shareItems(now, data, currentKey) {
    var out = [];
    var v = data.vocab || {};
    var hist = Array.isArray(v.history) ? v.history : [];
    var hasRoundToday = hist.some(function (r) { return r && typeof r.at === 'number' && sameDay(r.at, now) && r.at <= now; });
    var counts = masteryCounts(v, now);

    // A1 已经说过「刚背完一轮」时，掌握动态不再重复这句
    var roundAlreadySaid = String(currentKey || '').indexOf('vocab:round:') === 0;
    if (counts.auto > 0) {
      var n = counts.auto;
      out.push({
        key: 'vocab:mastery:' + dayOf(now) + ':auto',
        kind: 'share',
        at: counts.autoAt || now,
        variants: (hasRoundToday && !roundAlreadySaid)
          ? [
              '今天陪你背了一轮，记住了 ' + plural(n) + '。不是碰巧，连着答对三次。',
              '今天这轮下来，' + plural(n) + '词连着答对三次。'
            ]
          : [
              '今天记住了 ' + plural(n) + '词。连着答对三次才算的。',
              '今天有 ' + plural(n) + '词，连着答对三次。'
            ]
      });
    } else if (counts.manual > 0) {
      var m = counts.manual;
      out.push({
        key: 'vocab:mastery:' + dayOf(now) + ':manual',
        kind: 'share',
        at: counts.manualAt || now,
        variants: [
          '今天背了一轮。有 ' + plural(m) + '是你自己标了记住的。',
          '今天的 ' + plural(m) + '，你自己说了算。'
        ]
      });
    }

    // 游戏：至少 45 分钟，取最新一条；与 A2 同源时按 key 去掉
    var acts = Array.isArray(data.activities) ? data.activities : [];
    var best = null;
    acts.forEach(function (a) {
      if (!a || typeof a.endAt !== 'number' || a.endAt > now || !sameDay(a.endAt, now)) return;
      if ((Number(a.durMs) || 0) < MIN_GAME_MS) return;
      if (!best || a.endAt > best.endAt) best = a;
    });
    if (best) {
      var mins = Math.round((Number(best.durMs) || 0) / 60000);
      var gname = '';
      try { gname = root.LifeEvents && root.LifeEvents.gameName ? root.LifeEvents.gameName(best.game) : ''; } catch (e) { gname = ''; }
      gname = gname || best.name || '一小局';
      out.push({
        key: 'game:act:' + (best.id || (best.game + ':' + best.endAt)),
        kind: 'share',
        at: best.endAt,
        variants: [
          '今天一起玩了一局「' + gname + '」，' + mins + ' 分钟。',
          '今天那局「' + gname + '」玩了 ' + mins + ' 分钟。你没喊停。',
          '今天在「' + gname + '」里待了 ' + mins + ' 分钟。'
        ]
      });
    }

    // 英文广播：只认真的听到结尾（heardAt），文字节目不算
    var eps = Array.isArray(data.episodes) ? data.episodes : [];
    var heard = null;
    eps.forEach(function (ep) {
      if (!ep || ep.channel !== 'english') return;
      if (typeof ep.heardAt !== 'number' || ep.heardAt > now || !sameDay(ep.heardAt, now)) return;
      if (!heard || ep.heardAt > heard.heardAt) heard = ep;
    });
    if (heard) {
      out.push({
        key: 'radio:heard:' + (heard.id || heard.heardAt),
        kind: 'share',
        at: heard.heardAt,
        variants: [
          '今天那期英文广播，你听完了。',
          '今天从头听到尾，一期。',
          '今天听完一期。英文的，没跳结尾。'
        ]
      });
    }

    // 珍藏收下：status=saved 不够，必须有今天的 confirmedAt
    var keeps = Array.isArray(data.keeps) ? data.keeps : [];
    keeps.forEach(function (k) {
      if (!k || k.status !== 'saved') return;
      var at = Number(k.confirmedAt);
      if (!at || at > now || !sameDay(at, now)) return;
      out.push({
        key: 'keep:saved:' + k.id,
        kind: 'share',
        at: at,
        variants: [
          '你点头了。那件东西现在留在屋里了。',
          '收下了。以后翻珍藏能看见它。',
          '你答应了，我就把它放好了。'
        ]
      });
    });

    // 日记：只读时间
    var diaries = Array.isArray(data.diaries) ? data.diaries : [];
    var wrote = null;
    diaries.forEach(function (d) {
      if (!d || typeof d.createdAt !== 'number' || d.createdAt > now) return;
      if (!sameDay(d.createdAt, now)) return;
      if (!wrote || d.createdAt > wrote.createdAt) wrote = d;
    });
    if (wrote) {
      out.push({
        key: 'diary:' + wrote.createdAt,
        kind: 'life',          // 生活片段：不跟「共同经历」混成一类
        at: wrote.createdAt,
        variants: [
          '今天写了一页，收在抽屉里了。',
          '今天写了一页。什么时候给你看，再说。',
          '今天动笔写了。写得不多。'
        ]
      });
    }

    return out;
  }

  function surpriseItems(now, data) {
    var out = [];
    var keeps = Array.isArray(data.keeps) ? data.keeps : [];
    keeps.forEach(function (k) {
      if (!k) return;
      var at = Number(k.createdAt) || 0;
      if (!at || at > now) return;
      if (k.status === 'waiting_user') {
        if (now - at > 7 * 86400000) return;
        out.push({
          key: 'keep:wait:' + k.id, kind: 'surprise', at: at,
          variants: [
            '有件东西我没直接收进珍藏，先放在那儿了。你点头才算数。',
            '我留了一样东西，等你决定收不收。',
            '那儿放着一件，还没算数。等你。'
          ]
        });
      } else if (k.status === 'waiting_star') {
        if (now - at > 3 * 86400000) return;
        out.push({
          key: 'keep:waitstar:' + k.id, kind: 'surprise', at: at,
          variants: [
            '你放进来一件事，我看到了。等我想好怎么回。',
            '你留下的那件，我还没应。别急。',
            '收到了。这次我想写得认真一点。'
          ]
        });
      }
    });
    return out;
  }

  function houseToday(now) {
    return houseEvents.filter(function (h) {
      return sameDay(h.at, now) && h.at <= now;
    }).map(function (h) {
      return { key: h.key, kind: 'house', at: h.at, variants: h.variants };
    });
  }

  function hintItems(now) {
    return HINTS.filter(function (h) {
      return now >= h.at && now < h.expiresAt;
    }).map(function (h) {
      return { key: h.key, kind: 'hint', at: h.at, variants: h.variants };
    });
  }

  /* ---------------- 今天的选条：配额而不是纯排序 ----------------
   * 最多三条，结构上只允许：
   *   1 条共同经历 + 1~2 条小屋变化 +（生活片段 / 惊喜 / 极少数第二条共同经历）
   * 上限：共同经历 2、小屋变化 2、生活片段 1、惊喜 1。
   * 规则：
   *   - 共同经历先占一席（有的话）；
   *   - 小屋变化保底一席，惊喜再怎么也不许把它挤掉；
   *   - 第三席按「生活片段 > 惊喜 > 第二条小屋变化 > 第二条共同经历」；
   *   - 惊喜在近三天已经出现过时退让（有别的素材就顶上来），避免长期霸屏；
   *   - 素材不够就少放，不补位。
   */
  function surpriseSeenRecently(now) {
    var d = readStore();
    var hit = false;
    Object.keys(d.items).forEach(function (k) {
      if (k.indexOf('keep:wait:') !== 0 && k.indexOf('keep:waitstar:') !== 0) return;
      var at = d.items[k] && d.items[k].at;
      if (typeof at === 'number' && now - at <= SURPRISE_GAP) hit = true;
    });
    return hit;
  }

  function selectToday(now, pool) {
    var bucket = { share: [], life: [], house: [], surprise: [] };
    pool.slice().sort(function (a, b) { return b.at - a.at; }).forEach(function (it) {
      if (!bucket[it.kind]) bucket[it.kind] = [];
      bucket[it.kind].push(it);
    });

    var picked = [];
    function take(it) {
      if (it && picked.length < MAX_TODAY && picked.indexOf(it) < 0) picked.push(it);
    }

    take(bucket.share.shift());     // 一席共同经历
    take(bucket.house.shift());     // 小屋变化保底一席

    if (picked.length < MAX_TODAY) {
      var sp = bucket.surprise[0] || null;
      var others = bucket.life.length + bucket.house.length + bucket.share.length;
      // 惊喜在退让期，且还有别的内容能顶上来时才让位
      var spOK = sp && (!surpriseSeenRecently(now) || others === 0);

      var queue = [bucket.life[0], spOK ? sp : null, bucket.house[0], bucket.share[0]];
      for (var i = 0; i < queue.length; i++) {
        if (queue[i]) { take(queue[i]); break; }
      }
    }

    return picked.sort(function (a, b) { return b.at - a.at; });
  }

  /* ---------------- 历史：只收真实 occurred，按发生时间归日 ---------------- */
  var HISTORY_LABEL = {
    'game.finish': '玩了一局',
    'game.shared': '玩了一局',
    'vocab.round': '背了一轮词',
    'radio.episode': '听完了一期',
    'reading.finish': '读完了一本书'
  };

  function historyItems(now, data) {
    var todayStart = startOfDay(now);
    var from = now - RETAIN_MS;
    var out = [];

    // 小屋变化：过去几天的那几条
    houseEvents.forEach(function (h) {
      if (h.at >= todayStart || h.at < from) return;
      out.push({ key: h.key, kind: 'house', at: h.at, variants: h.variants });
    });

    var events = Array.isArray(data.events) ? data.events : [];
    var seen = {};
    events.forEach(function (e) {
      if (!e || e.status !== 'occurred') return;      // planned / ongoing 不展示
      if (typeof e.at !== 'number' || e.at >= todayStart || e.at < from) return;
      if (!HISTORY_LABEL[e.type]) return;
      var slot = e.type + ':' + timeOf(e.at) + ':' + dayOf(e.at);
      if (seen[slot]) return;                          // 同一时刻同类只算一次
      seen[slot] = true;
      var text = HISTORY_LABEL[e.type];
      if (e.type === 'game.finish' || e.type === 'game.shared') {
        var name = '';
        try { name = root.LifeEvents && root.LifeEvents.gameName ? root.LifeEvents.gameName(e.meta && e.meta.game) : ''; } catch (err) { name = ''; }
        if (name) text = '玩了一局「' + name + '」';
      }
      out.push({
        key: 'ev:' + e.id, kind: 'share', at: e.at,
        variants: ['那天' + text + '。']
      });
    });
    return out;
  }

  /** 按天分组、每天最多两条、日期新的在前 */
  function groupByDay(items) {
    var map = {};
    items.slice().sort(function (a, b) { return b.at - a.at; }).forEach(function (it) {
      var d = dayOf(it.at);
      if (!map[d]) map[d] = [];
      if (map[d].length >= MAX_PER_DAY) return;
      map[d].push(it);
    });
    return Object.keys(map).sort().reverse().map(function (d) {
      return { day: d, at: new Date(d + 'T00:00:00').getTime(), items: map[d] };
    });
  }

  /* ---------------- 组装 ---------------- */
  function buildModel(now, range, data) {
    var current = currentItem(now, data);
    var pool = surpriseItems(now, data)
      .concat(shareItems(now, data, current.key))
      .concat(houseToday(now));

    // 同屏去重：同一个事件只出现一次
    var seen = {};
    seen[current.key] = true;
    pool = pool.filter(function (it) {
      if (seen[it.key]) return false;
      seen[it.key] = true;
      return true;
    });

    var today = selectToday(now, pool);
    var dropped = pool.filter(function (it) { return today.indexOf(it) < 0; });

    var groups = groupByDay(historyItems(now, data).filter(function (it) {
      return !seen[it.key];
    }));
    var count = groups.reduce(function (n, g) { return n + g.items.length; }, 0);

    var near = range === 'near'
      ? groups.filter(function (g) { return g.at >= startOfDay(now) - 2 * 86400000; })
      : [];

    return {
      current: current, today: today, dropped: dropped,
      hints: hintItems(now), groups: groups, nearGroups: near,
      historyCount: count, range: range
    };
  }

  /* ---------------- 渲染 ---------------- */
  var TYPE_LABEL = { house: '小屋变化', share: '共同经历', life: '生活片段', surprise: '特别惊喜' };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function textOf(item, now) {
    var v = pickVariant(item.key, item.variants.length, now);
    return item.variants[v] || item.variants[0] || '';
  }

  function itemHTML(item, now, opts) {
    var isHouse = item.kind === 'house';
    var tag = TYPE_LABEL[item.kind];
    return '<div class="lf-item' + (isHouse ? ' lf-item--house' : '') + '">' +
      '<div class="lf-meta">' +
      '<time class="lf-time">' + esc(timeOf(item.at)) + '</time>' +
      (tag ? '<span class="lf-tag lf-tag--' + esc(item.kind) + '">' + esc(tag) + '</span>' : '') +
      '</div>' +
      '<p class="lf-text">' + esc(textOf(item, now)) + '</p>' +
      '</div>';
  }

  function dayHeadHTML(ms, isToday) {
    var name = isToday ? '今天' : dateLabel(ms);
    var sub = isToday ? (dateLabel(ms) + ' · ' + weekdayOf(ms)) : weekdayOf(ms);
    return '<div class="lf-day-head">' +
      '<span class="lf-day-name">' + esc(name) + '</span>' +
      '<span class="lf-day-date">' + esc(sub) + '</span>' +
      '</div>';
  }

  function bodyHTML(model, now) {
    var out = '';

    out += '<div class="lf-day">' + dayHeadHTML(now, true);
    if (!model.today.length) {
      out += '<p class="lf-empty">今天没什么大事。我在。</p>';
    } else {
      out += model.today.map(function (it) { return itemHTML(it, now); }).join('');
    }
    out += '</div>';

    if (model.hints.length) {
      out += '<div class="lf-hints">' + model.hints.map(function (h) {
        return '<div class="lf-hint">' +
          '<span class="lf-tag lf-tag--hint">今日提示</span>' +
          '<p class="lf-text">' + esc(textOf(h, now)) + '</p>' +
          '</div>';
      }).join('') + '</div>';
    }

    if (model.range === 'today') {
      if (model.historyCount > 0) {
        out += '<button type="button" class="lf-fold" id="lfFold">' +
          '<span>更早</span><span>还有 ' + model.historyCount + ' 条　›</span></button>';
      }
    } else if (model.nearGroups.length) {
      out += '<div class="lf-history" id="lfHistory">';
      out += model.nearGroups.map(function (g) {
        return '<div class="lf-day lf-day--past">' + dayHeadHTML(g.at, false) +
          g.items.map(function (it) { return itemHTML(it, now); }).join('') + '</div>';
      }).join('');
      out += '</div>';
    }

    return out;
  }

  /* ---------------- 挂载与交互 ---------------- */
  var state = { el: null, range: 'today', now: null };
  var feedBound = false;      // 事件只绑定一次
  var pendingFrame = 0;       // 同一帧内的多次通知合并成一次渲染

  /** 数据写入方（room-keeps / LifeEvents）成功后派发 life:feed，这里按帧合并刷新 */
  function bindFeedEvents() {
    if (feedBound || typeof root.addEventListener !== 'function') return;
    feedBound = true;
    root.addEventListener('life:feed', function () {
      if (pendingFrame) return;
      var raf = root.requestAnimationFrame;
      if (typeof raf !== 'function') { refresh(); return; }
      pendingFrame = raf(function () { pendingFrame = 0; refresh(); });
    });
  }

  function nowMs() {
    try { return root.LifeClock && root.LifeClock.now ? root.LifeClock.now() : Date.now(); } catch (e) { return Date.now(); }
  }

  function renderShell() {
    return '<div class="lf-head">' +
      '<h2 class="lf-title">小屋的动静</h2>' +
      '<div class="lf-range" role="tablist" aria-label="动态范围">' +
      '<button type="button" class="lf-range-btn is-on" data-range="today" role="tab" aria-selected="true">今天</button>' +
      '<button type="button" class="lf-range-btn" data-range="near" role="tab" aria-selected="false">近三天</button>' +
      '</div></div>' +
      '<div class="lf-current" id="lfCurrent"></div>' +
      '<div class="lf-body" id="lfBody"></div>';
  }

  /** 收集一次数据：localStorage 同步读，房间库异步读（失败即空数组） */
  function collectData() {
    return Promise.all([loaders.keeps(), loaders.diaries()]).then(function (res) {
      return {
        vocab: loaders.vocab(), activities: loaders.activities(),
        episodes: loaders.episodes(), events: loaders.events(),
        keeps: Array.isArray(res[0]) ? res[0] : [],
        diaries: Array.isArray(res[1]) ? res[1] : []
      };
    }, function () {
      return {
        vocab: loaders.vocab(), activities: loaders.activities(),
        episodes: loaders.episodes(), events: loaders.events(),
        keeps: [], diaries: []
      };
    });
  }

  function renderBody(opts) {
    if (!state.el) return Promise.resolve();
    var now = state.now || nowMs();
    return collectData().then(function (data) {
      var model = buildModel(now, state.range, data);
      state.model = model;
      var body = state.el.querySelector('#lfBody');
      var cur = state.el.querySelector('#lfCurrent');
      if (cur) {
        cur.innerHTML = '<div class="lf-now-label">此刻 · ' + esc(timeOf(now)) + '</div>' +
          '<div class="lf-now-text">' + esc(textOf(model.current, now)) + '</div>';
      }
      if (body) body.innerHTML = bodyHTML(model, now);
      bindBody();
      if (opts && opts.toHistory) scrollToHistory();
    });
  }

  function scrollToHistory() {
    if (!state.el || !root.scrollTo) return;
    var box = state.el.querySelector('#lfHistory');
    if (!box) return;
    var top = 0;
    try {
      var rect = box.getBoundingClientRect();
      top = rect.top + (root.scrollY || root.pageYOffset || 0) - 12;
    } catch (e) { return; }
    try { root.scrollTo({ top: top, behavior: 'smooth' }); } catch (e) { root.scrollTo(0, top); }
  }

  function bindBody() {
    var fold = state.el.querySelector('#lfFold');
    if (fold) fold.addEventListener('click', function () { setRange('near', { toHistory: true }); });
  }

  function setRange(range, opts) {
    if (range !== 'today' && range !== 'near') return;
    var y = 0;
    try { y = root.scrollY || root.pageYOffset || 0; } catch (e) { y = 0; }
    state.range = range;
    var el = state.el;
    if (el) {
      el.querySelectorAll('.lf-range-btn').forEach(function (b) {
        var on = b.getAttribute('data-range') === range;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    }
    return renderBody({ toHistory: !!(opts && opts.toHistory) }).then(function () {
      // 切换只动今天以下，此刻与标题不重绘；滚动位置原样恢复
      if (opts && opts.toHistory) return;
      try { root.scrollTo(0, y); } catch (e) {}
    });
  }

  function bindRange() {
    state.el.querySelectorAll('.lf-range-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        var r = b.getAttribute('data-range');
        if (r === state.range) return;
        setRange(r);
      });
    });
  }

  function mount(el) {
    var box = el || (root.document && root.document.getElementById('lifeFeed'));
    if (!box) return false;
    if (box.getAttribute('data-mounted') === '1') { bindFeedEvents(); refresh(); return true; }
    state.el = box;
    if (!state.now) state.now = nowMs();
    box.innerHTML = renderShell();
    bindRange();
    bindFeedEvents();
    renderBody();
    box.setAttribute('data-mounted', '1');
    if (root.document) {
      root.document.addEventListener('visibilitychange', function () {
        if (!root.document.hidden) refresh();
      });
    }
    return true;
  }

  function refresh() {
    if (!state.el) return;
    state.now = nowMs();
    renderBody();
  }

  function _reset() {
    state = { el: null, range: 'today', now: null, model: null };
    mem = null; storeL = null;
    houseEvents = HOUSE_EVENTS;
    loaders = baseLoaders();
  }

  function baseLoaders() {
    return {
      vocab: function () { return readJSON('ylxh.vocab.v1'); },
      activities: function () {
        var d = readJSON('ylxh.game.activity.v1');
        return d && Array.isArray(d.items) ? d.items : [];
      },
      episodes: function () {
        var d = readJSON('ylxh.radio.episodes');
        return Array.isArray(d) ? d : [];
      },
      events: function () {
        try { return (root.LifeEvents && root.LifeEvents.list) ? root.LifeEvents.list() : []; } catch (e) { return []; }
      },
      keeps: function () { return idbAll('keeps'); },
      diaries: function () { return idbAll('starDiaries'); }
    };
  }

  var api = {
    mount: mount,
    refresh: refresh,
    setRange: setRange,
    get range() { return state.range; },
    _build: buildModel,
    _text: function (item, now) { return item ? textOf(item, now) : ''; },
    _house: HOUSE_EVENTS,
    _setHouse: function (list) { houseEvents = Array.isArray(list) ? list : []; },
    _hints: HINTS,
    _setStorage: function (s) { storeL = s; mem = null; },
    _setLoaders: function (o) { loaders = Object.assign(baseLoaders(), o || {}); },
    _setNow: function (ms) { state.now = ms; },
    _reset: _reset,
    _keys: { FEED_KEY: FEED_KEY, RETAIN_MS: RETAIN_MS, FRESH_MS: FRESH_MS, MAX_PER_DAY: MAX_PER_DAY, MAX_TODAY: MAX_TODAY, MIN_GAME_MS: MIN_GAME_MS, HINT_TTL: HINT_TTL }
  };

  root.LifeFeed = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
