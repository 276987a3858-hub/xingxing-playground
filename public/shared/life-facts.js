/* public/shared/life-facts.js — P4 按需事实读取（本地只读，0 请求）
 * 只在用户的问题确实指向某类生活事实时，才去读对应存档，返回一小段可直接进提示词的事实。
 * 边界：
 *   - 只读 localStorage 存档与注入的任务读取器；不写任何存储、不改源数据；
 *   - 不访问 IndexedDB（任务由 provider 注入）、不调用 AI、不发请求；
 *   - 只碰：背词 / 电台 / 读书 / 待办 / 聊天时间；绝不读日记正文、账单金额、睡眠、生理期。
 *   - 找不到记录就明确说找不到，不做任何推测。
 */
(function (root) {
  'use strict';

  var MAX_TEXT = 120;          // 与 LifeContext 同量级，避免单轮提示词膨胀
  var MAX_WORDS = 4;
  var PREFIX = '【你记得的事实】';

  function localStr(k) {
    try { return root.localStorage ? root.localStorage.getItem(k) : null; } catch (e) { return null; }
  }
  function json(raw) { try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }
  function clock() { return root.LifeClock || null; }

  function dayOf(ms) {
    var C = clock();
    if (C) return C.formatDay(ms);
    var d = new Date(ms);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function dayBefore(now, n) {
    var C = clock();
    if (C) return C.formatDay(C.startOfDay(now) - n * 86400000);
    return dayOf(now - n * 86400000);
  }
  function relative(at, now) {
    var C = clock();
    if (C) { var r = C.relative(at, now); if (r) return r.text; }
    return '之前';
  }
  // 时间范围：问题里说了昨天/今天才按天过滤，否则取最近一次
  function scopeOf(text, now) {
    if (/昨天|昨日/.test(text)) return { kind: 'yesterday', day: dayBefore(now, 1), label: '昨天' };
    if (/前天/.test(text)) return { kind: 'day', day: dayBefore(now, 2), label: '前天' };
    if (/今天|今日/.test(text)) return { kind: 'today', day: dayOf(now), label: '今天' };
    return { kind: 'latest', day: null, label: '最近' };
  }

  function clip(s, max) {
    var str = String(s || '');
    if (str.length <= max) return str;
    return str.slice(0, Math.max(0, max - 1)) + '…';
  }
  function pack(body) {
    var text = PREFIX + body;
    if (text.length > MAX_TEXT) text = PREFIX + clip(body, MAX_TEXT - PREFIX.length);
    return text;
  }

  /* ---------------- 意图识别（宁可漏，不可滥） ---------------- */
  // 必须是「问句/指向某类事实」，否则不触发任何读取
  var ASK = /(什么|哪些|哪个|哪本|哪件|哪期|多少|几个|几件|最近|上次|上一次|以前|之前|有没有|记得|吗|么|呢)/;
  var RULES = [
    { kind: 'chat', re: /(说话|聊天|聊过|联系)/ },
    // 「背了什么」「学了哪些」不带「词」也算，但必须是真的在问背/学的内容
    { kind: 'vocab', re: /(背|学|记)(了|过)?(什么|哪些|哪几个|几个)|(背|学|记)[^，。？！]{0,4}(单词|词|词汇)|单词|词汇|背词/ },
    { kind: 'radio', re: /(节目|电台|播客|收听|听到|听完)/ },
    { kind: 'reading', re: /(读书|看书|读完|书单|哪本|这本书|那本书|阅读)|读[^，。？！]{0,4}书|看[^，。？！]{0,4}书/ },
    { kind: 'task', re: /(待办|事项|日程|做完|完成|提醒我)/ },
    { kind: 'game', re: /(游戏|游乐场|玩过|玩的|闯关|通关)/ },
  ];

  function detect(text) {
    var t = String(text || '').trim();
    if (!t) return null;
    if (!ASK.test(t)) return null;               // 不是提问/指向事实 → 不读
    for (var i = 0; i < RULES.length; i++) {
      if (RULES[i].re.test(t)) return RULES[i].kind;
    }
    return null;
  }

  /* ---------------- 各类事实 ---------------- */

  function pickByScope(list, scope, atOf) {
    if (!Array.isArray(list) || !list.length) return null;
    if (!scope.day) {
      var best = null;
      list.forEach(function (it) { var at = atOf(it); if (at && (!best || at > atOf(best))) best = it; });
      return best;
    }
    var hit = null;
    list.forEach(function (it) { var at = atOf(it); if (at && dayOf(at) === scope.day) { if (!hit || at > atOf(hit)) hit = it; } });
    return hit;
  }

  function vocabFacts(scope, now) {
    var d = json(localStr('ylxh.vocab.v1'));
    if (!d || !Array.isArray(d.history) || !d.history.length) {
      return { none: true, body: '没有找到她的背词记录。不要编造。' };
    }
    var at = function (it) { return it && typeof it.at === 'number' ? it.at : null; };
    var rec = pickByScope(d.history, scope, at);
    if (!rec) return { none: true, body: '没有找到' + scope.label + '的学习记录。不要编造。' };
    var words = Array.isArray(rec.words) ? rec.words.map(function (w) { return w && w.w; }).filter(Boolean) : [];
    var size = Number(rec.size) || words.length || 0;
    if (!words.length) {
      return { body: '她' + (scope.day ? scope.label : relative(rec.at, now)) + '学了一轮词，共 ' + size + ' 个（没留下具体单词）。' };
    }
    var shown = words.slice(0, MAX_WORDS).join('、');
    var more = words.length > MAX_WORDS ? ' 等' : '';
    return { body: '她' + (scope.day ? scope.label : relative(rec.at, now)) + '学的词：' + shown + more + '，共 ' + size + ' 个。' };
  }

  function radioFacts(scope, now) {
    var eps = json(localStr('ylxh.radio.episodes'));
    if (!Array.isArray(eps) || !eps.length) return { none: true, body: '没有找到她听节目的记录。不要编造。' };
    var done = eps.filter(function (e) { return e && e.status === 'completed' && typeof e.completedAt === 'number'; });
    if (!done.length) return { none: true, body: '没有找到她听完节目的记录。不要编造。' };
    var rec = pickByScope(done, scope, function (e) { return e.completedAt; });
    if (!rec) return { none: true, body: '没有找到' + scope.label + '听完的节目。不要编造。' };
    return { body: '她' + (scope.day ? scope.label : relative(rec.completedAt, now)) + '听完了《' + clip(rec.title, 16) + '》这一期。' };
  }

  function readingFacts(scope, now) {
    var d = json(localStr('ylxh.radio.reading'));
    if (!d) return { none: true, body: '没有找到她的读书记录。不要编造。' };
    var books = Array.isArray(d.books) ? d.books : [];
    var byId = {};
    books.forEach(function (b) { if (b && b.id) byId[b.id] = b; });
    var finished = Array.isArray(d.history) ? d.history.filter(function (h) { return h && typeof h.finishedAt === 'number'; }) : [];
    var rec = pickByScope(finished, scope, function (h) { return h.finishedAt; });
    if (rec) {
      var b = byId[rec.bookId];
      return { body: '她' + (scope.day ? scope.label : relative(rec.finishedAt, now)) + '读完了《' + clip(b && b.title, 18) + '》。' };
    }
    var reading = books.filter(function (x) { return x && x.status === 'reading'; })[0];
    if (reading) return { body: '她现在在读《' + clip(reading.title, 18) + '》，还没读完。' };
    return { none: true, body: '没有找到' + (scope.day ? scope.label : '最近') + '的读书记录。不要编造。' };
  }

  async function taskFacts(scope, now, provider) {
    var tasks = null;
    if (typeof provider === 'function') {
      try { tasks = await provider(); } catch (e) { tasks = null; }
    }
    if (!Array.isArray(tasks)) return { none: true, body: '现在读不到待办记录。不要编造。' };
    var done = tasks.filter(function (t) { return t && t.status === 'done' && typeof t.completedAt === 'number'; });
    if (!done.length) return { none: true, body: '没有找到她完成事项的记录。不要编造。' };
    var rec = pickByScope(done, scope, function (t) { return t.completedAt; });
    if (!rec) return { none: true, body: '没有找到' + scope.label + '完成的事项。不要编造。' };
    return { body: '她' + (scope.day ? scope.label : relative(rec.completedAt, now)) + '完成了「' + clip(rec.title, 16) + '」。' };
  }

  // P5.1：游戏事实（只读既有事件与完成存档，名称走 LifeEvents 的展示映射）
  function gameFacts(scope, now) {
    var LE = root.LifeEvents;
    var name = function (id) { try { return LE ? LE.gameName(id) : null; } catch (e) { return null; } };
    var at = function (it) { return it && typeof it.at === 'number' ? it.at : null; };

    var plays = [];
    try {
      plays = LE ? LE.list().filter(function (e) { return e && e.type === 'game.finish'; }) : [];
    } catch (e) { plays = []; }
    if (plays.length) {
      var rec = pickByScope(plays, scope, at);
      if (rec) {
        var label = name(rec.meta && rec.meta.game);
        if (label) return { body: '她' + (scope.day ? scope.label : relative(rec.at, now)) + '玩了「' + label + '」。' };
      }
    }
    // 事件层没有（例如早于事件层上线）：退回完成存档
    var pf = json(localStr('ylxh.playground.v1'));
    var fin = (pf && pf.finished && typeof pf.finished === 'object') ? pf.finished : null;
    if (fin) {
      var list = [];
      Object.keys(fin).forEach(function (id) {
        var r = fin[id];
        if (r && typeof r.at === 'number' && name(id)) list.push({ id: id, at: r.at });
      });
      var hit = pickByScope(list, scope, at);
      if (hit) return { body: '她' + (scope.day ? scope.label : relative(hit.at, now)) + '玩了「' + name(hit.id) + '」。' };
    }
    return { none: true, body: '没有找到她玩游戏的真实记录。不要编造。' };
  }

  function chatFacts(now) {
    var LP = root.LifePresence;
    var p = null;
    try { p = LP ? LP.snapshot() : null; } catch (e) { p = null; }
    var at = p && typeof p.lastInteractionAt === 'number' ? p.lastInteractionAt : null;
    if (!at) return { none: true, body: '这次之前你们还没聊过天。不要编造。' };
    return { body: '她上次和你说话是' + relative(at, now) + '。' };
  }

  /**
   * 按用户这句话查一次事实。命中不到意图时返回 { kind:null, text:'' }（零读取）。
   * opts: { now, tasks }  tasks 为异步读取器，缺省则无法回答待办类问题。
   */
  async function lookup(text, opts) {
    opts = opts || {};
    var now = typeof opts.now === 'number' && isFinite(opts.now) ? opts.now : (clock() ? clock().now() : Date.now());
    var kind = detect(text);
    if (!kind) return { kind: null, text: '', none: false };
    // P5-a：她说过不想再提的话题 → 连存档都不读，也不给"没找到"的暗示
    if (root.LifeTopics) {
      var blocked = false;
      try { blocked = root.LifeTopics.isBlocked(kind); } catch (e) { blocked = false; }
      if (blocked) return { kind: kind, text: '', none: false, blocked: true };
    }

    var scope = scopeOf(text, now);
    var out = null;
    if (kind === 'chat') out = chatFacts(now);
    else if (kind === 'vocab') out = vocabFacts(scope, now);
    else if (kind === 'radio') out = radioFacts(scope, now);
    else if (kind === 'reading') out = readingFacts(scope, now);
    else if (kind === 'task') out = await taskFacts(scope, now, opts.tasks);
    else if (kind === 'game') out = gameFacts(scope, now);

    if (!out || !out.body) return { kind: kind, text: '', none: true };
    return { kind: kind, text: pack(out.body), none: out.none === true };
  }

  var api = {
    detect: detect,
    lookup: lookup,
    scopeOf: scopeOf,
    _keys: { MAX_TEXT: MAX_TEXT, PREFIX: PREFIX, MAX_WORDS: MAX_WORDS },
  };
  root.LifeFacts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
