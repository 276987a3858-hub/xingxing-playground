/* public/shared/life-topics.js — P5-a 话题回避记忆（本地规则，0 请求）
 * 只做三件事：
 *   1) 识别「她明确要求以后不要再提某类话题」→ 写入长期回避规则（上限 8 条）；
 *   2) 识别「现在不想聊」→ 只在本次会话内尊重，不落盘、不变永久禁忌；
 *   3) 识别「可以再聊了」→ 解除对应规则。
 * 边界：
 *   - 只看她这一句，不扫描历史消息、不读日记/账单/睡眠/生理期；
 *   - 不判断普通闲聊，不像问句/不带长期标记就不记录（宁可漏，不可滥）；
 *   - 不发请求、不访问 IndexedDB，写入失败静默降级。
 */
(function (root) {
  'use strict';

  var KEY = 'ylxh.topic.avoid.v1';
  var MAX_ITEMS = 8;
  var QUIET_MS = 40 * 60 * 1000;    // 「累了/不想说话」后暂停自主互动 40 分钟

  // 话题粒度只到类别，不做知识图谱
  var KINDS = [
    { k: 'vocab', re: /(单词|背词|词汇|背单词|英语词)/ },
    { k: 'radio', re: /(电台|节目|播客|收听|广播)/ },
    { k: 'reading', re: /(读书|看书|阅读|小说|书单|那本|这本书)/ },
    { k: 'task', re: /(待办|事项|日程|任务|提醒|作业)/ },
    { k: 'game', re: /(游戏|游乐场|小游戏|闯关)/ },
  ];
  var LABEL = { vocab: '背词', radio: '电台', reading: '读书', task: '待办', game: '游戏' };

  // 长期回避：必须同时出现「长期标记」+「别再提」
  var LONG_MARK = /(以后|今后|从此|往后|永远|再也)/;
  var STOP = /(别|不要|不用|不许|不准|甭)(再)?(跟我)?(提|说|聊|问|讲)/;
  // 暂时回避：时间限定 + 不想聊
  var SHORT_MARK = /(现在|今天|今晚|这会儿|暂时|先|此刻|等会)/;
  var REFUSE = /(不想|别|不要|不用)(再)?(聊|说|提|讲|问)/;
  // 解除
  var RELEASE = /((可以|能|允许|不妨)[^。！？]{0,8}(聊|说|提|问))|(不用|不需要|没必要)(再)?(回避|避着|躲着)|((没关系|不介意|无所谓)了)/;
  // 拒绝/疲惫：只影响自主互动，不写任何规则
  var DECLINE = /(累了|好累|太累|困了|想睡|不想说话|不想聊|别说了|让我静静|想安静|心情不好|好烦|真烦|烦死|心烦|烦躁|别烦我)/;

  var session = [];                 // 本次会话内暂时回避（不落盘）
  var quietUntil = 0;

  function store() {
    try { return root.localStorage || null; } catch (e) { return null; }
  }
  function readAll() {
    var s = store();
    if (!s) return { v: 1, items: [] };
    var raw = null;
    try { raw = s.getItem(KEY); } catch (e) { return { v: 1, items: [] }; }
    if (!raw) return { v: 1, items: [] };
    var o;
    try { o = JSON.parse(raw); } catch (e) { return { v: 1, items: [] }; }
    var items = (o && Array.isArray(o.items)) ? o.items.filter(function (it) {
      return it && typeof it.k === 'string' && LABEL[it.k];
    }).map(function (it) {
      return { k: it.k, at: typeof it.at === 'number' ? it.at : 0 };
    }) : [];
    return { v: 1, items: items.slice(-MAX_ITEMS) };
  }
  function writeAll(data) {
    var s = store();
    if (!s) return false;
    try { s.setItem(KEY, JSON.stringify({ v: 1, items: data.items.slice(-MAX_ITEMS) })); return true; } catch (e) { return false; }
  }

  function kindsOf(text) {
    var t = String(text || '');
    var out = [];
    KINDS.forEach(function (x) { if (x.re.test(t)) out.push(x.k); });
    return out;
  }

  /** 只看这一句，判断她表达的是哪种意愿。不写存储。 */
  function classify(text) {
    var t = String(text || '').trim();
    if (!t) return { kind: null, topics: [] };
    var topics = kindsOf(t);
    if (!topics.length) return { kind: null, topics: [] };   // 认不出话题 → 不记录

    if (RELEASE.test(t)) return { kind: 'release', topics: topics };
    // 长期：必须同时有「以后/永远」这类标记与「别再提」
    if (LONG_MARK.test(t) && STOP.test(t)) return { kind: 'long', topics: topics };
    // 暂时：有时间限定词 + 不想聊
    if (SHORT_MARK.test(t) && REFUSE.test(t)) return { kind: 'short', topics: topics };
    return { kind: null, topics: topics };
  }

  /** 应用规则（写 / 删 / 只记会话）。返回 { kind, topics }。 */
  function note(text) {
    var c = classify(text);
    if (!c.kind) return c;
    if (c.kind === 'long') {
      var d = readAll();
      c.topics.forEach(function (k) {
        d.items = d.items.filter(function (it) { return it.k !== k; });
        d.items.push({ k: k, at: Date.now() });
        session = session.filter(function (x) { return x !== k; });
      });
      d.items = d.items.slice(-MAX_ITEMS);
      writeAll(d);
      return c;
    }
    if (c.kind === 'short') {
      c.topics.forEach(function (k) { if (session.indexOf(k) === -1) session.push(k); });
      return c;
    }
    // release：解除长期 + 会话内的暂时回避
    var d2 = readAll();
    d2.items = d2.items.filter(function (it) { return c.topics.indexOf(it.k) === -1; });
    writeAll(d2);
    session = session.filter(function (k) { return c.topics.indexOf(k) === -1; });
    return c;
  }

  /** 该话题当前是否不该被带起（长期规则 或 本次会话的暂时回避）。 */
  function isBlocked(kind) {
    if (!kind) return false;
    if (session.indexOf(kind) !== -1) return true;
    var d = readAll();
    return d.items.some(function (it) { return it.k === kind; });
  }
  function blocked() {
    var out = readAll().items.map(function (it) { return it.k; });
    session.forEach(function (k) { if (out.indexOf(k) === -1) out.push(k); });
    return out;
  }
  function hasAny() { return blocked().length > 0; }

  /** 给提示词的一句短约束（没有规则时为空串）。 */
  function promptNote() {
    var ks = blocked();
    if (!ks.length) return '';
    var names = ks.map(function (k) { return LABEL[k] || k; }).join('、');
    return '（她说过不想再提' + names + '，不要主动带起，也别追问；她先开口才接。）';
  }

  /** 她这句是否在表达疲惫/拒绝（只用于暂停自主互动，不写规则）。 */
  function declined(text) {
    return DECLINE.test(String(text || ''));
  }
  function quiet(now) {
    var t = typeof now === 'number' ? now : Date.now();
    return t < quietUntil;
  }
  function hush(now, ms) {
    var t = typeof now === 'number' ? now : Date.now();
    quietUntil = Math.max(quietUntil, t + (typeof ms === 'number' ? ms : QUIET_MS));
    return quietUntil;
  }

  var api = {
    classify: classify,
    note: note,
    isBlocked: isBlocked,
    blocked: blocked,
    hasAny: hasAny,
    promptNote: promptNote,
    declined: declined,
    quiet: quiet,
    hush: hush,
    labels: LABEL,
    _reset: function () { session = []; quietUntil = 0; return api; },
    _clear: function () { try { var s = store(); if (s) s.removeItem(KEY); } catch (e) {} session = []; return api; },
    _keys: { KEY: KEY, MAX_ITEMS: MAX_ITEMS, QUIET_MS: QUIET_MS },
  };
  root.LifeTopics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
