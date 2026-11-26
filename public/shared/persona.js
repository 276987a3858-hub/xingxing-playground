/* public/shared/persona.js — 小星五层人设运行时注入层
 * 职责：把 docs/persona-v2 定稿的五层资料接入主聊天的 system 提示词。
 * 设计：
 *   - 第一、二层（核心人设 / 用户画像）内嵌为同步常量，保证每轮必注入、无异步空窗、无人格空窗；
 *   - 第三、四、五层与特殊能力资料为按需层，从 /persona/*.txt 异步读取进内存，按话题/情境/事件匹配；
 *   - 只读、0 请求（除了一次性静态文本 fetch）、不访问 IndexedDB、不改任何原始数据；
 *   - 任何层缺失或读取失败时静默降级，绝不影响普通聊天。
 * 暴露：window.Persona（浏览器）/ globalThis.Persona（Node 测试）。
 */
(function (root) {
  'use strict';

  /* ---- 第一层：核心人设（占位示例；真实人设正文不随本仓库公开） ---- */
  var LAYER1 = [
    '你是一个示例角色。',
    '这里只保留结构：真实的核心人设、性格设定与表达约束都应替换成你自己的文本。'
  ].join('\n');

  /* ---- 第二层：用户画像（占位示例；真实个人画像不随本仓库公开） ---- */
  var LAYER2 = [
    '这份画像描述使用者在意什么、习惯怎样表达，属于可替换的示例文本。',
    '真实项目里请存放你自己的画像内容，并注意不要把他人隐私写进公开仓库。'
  ].join('\n');

  // 按需层数据：{ bg:[section], rel:[section], fn:[section], special:[section] }
  // section = { key, alias, keywords:[...], text }
  var data = { bg: [], rel: [], fn: [], special: [] };
  var readyResolve = null;
  var ready = new Promise(function (res) { readyResolve = res; });

  function parseSections(raw, layer) {
    var out = [];
    var lines = String(raw || '').split(/\r?\n/);
    var cur = null;
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/^\[\[SEC:([^\]|]+)\|([^\]]*)\]\]\s*$/);
      if (m) {
        if (cur) out.push(cur);
        // 头部格式：[[SEC:key|alias|kw1 kw2 ...]]，alias 与关键词以 | 分隔。
        // 可选标记：独占一格的 nosticky（不进 LRU、不参与历史恢复）；@gateKey（本轮语境闸门）。
        var head = m[2].split('|');
        var sticky = true;
        var parts = head.filter(function (x) {
          if (/^\s*nosticky\s*$/i.test(x)) { sticky = false; return false; }
          return true;
        });
        var alias = (parts[0] || '').trim();
        var kwPart = parts.length > 1 ? parts.slice(1).join(' ') : alias;
        var gateKey = null;
        var keywords = kwPart.trim().split(/\s+/).filter(Boolean).filter(function (k) {
          if (/^@[A-Za-z][A-Za-z0-9_-]*$/.test(k)) { gateKey = k.slice(1); return false; }
          return true;
        });
        if (head.length > 1 && alias) keywords = keywords.filter(function (k) { return k !== alias; });
        cur = { layer: layer, key: m[1].trim(), alias: alias, keywords: keywords, sticky: sticky, gateKey: gateKey, text: '' };
      } else if (cur) {
        cur.text += (cur.text ? '\n' : '') + lines[i];
      }
    }
    if (cur) out.push(cur);
    return out.filter(function (s) { return s.text.trim(); });
  }

  function seed(obj) {
    if (!obj) return api;
    if (obj.bg) data.bg = parseSections(obj.bg, 'bg');
    if (obj.rel) data.rel = parseSections(obj.rel, 'rel');
    if (obj.fn) data.fn = parseSections(obj.fn, 'fn');
    if (obj.special) data.special = parseSections(obj.special, 'special');
    return api;
  }

  // 尝试从 /persona/*.txt 读取按需层；失败不抛错、不影响基础层。
  function load(basePath) {
    var base = basePath || '/persona/';
    var files = { bg: 'layer3-background.txt', rel: 'layer4-relationship.txt', fn: 'layer5-functions.txt', special: 'special-abilities.txt' };
    var jobs = Object.keys(files).map(function (k) {
      var layer = k, url = base + files[k];
      try {
        return Promise.resolve(root.fetch ? root.fetch(url) : null).then(function (r) {
          if (!r || !r.ok) return null;
          return r.text();
        }).then(function (txt) {
          if (typeof txt === 'string') {
            var parsed = parseSections(txt, layer);
            if (parsed.length) data[layer] = parsed;
          }
          return null;
        }).catch(function () { return null; });
      } catch (e) { return Promise.resolve(null); }
    });
    return Promise.all(jobs).then(function () {
      if (readyResolve) { readyResolve(api); readyResolve = null; }
      return api;
    });
  }

  // 第一、二层基础注入：带来源标题，便于模型与调试区分来源。
  function baseText() {
    return '【核心人设（小星）】\n' + LAYER1 + '\n\n【用户画像（认识起点，非固定定义）】\n' + LAYER2;
  }

  // 会话内"当前资料键集合"：命中即加入/刷新；明确换话题才清空；仅内存，不落盘。
  var active = { bg: [], rel: [] };
  // 明确换话题后，屏蔽历史窗口的自动恢复，直到本层再次出现当前轮命中。
  var suppressHistory = { bg: false, rel: false };
  var SWITCH_RE = /(换个话题|换话题|不聊这个|不说这个|说点别的|聊点别的|算了不说了|换个说法)/;

  function isSwitch(text) { return SWITCH_RE.test(String(text || '')); }

  function hasKeyword(text, sec) {
    var t = String(text || '');
    for (var i = 0; i < sec.keywords.length; i++) {
      if (sec.keywords[i] && t.indexOf(sec.keywords[i]) !== -1) return true;
    }
    return false;
  }

  // 非粘性段的语境闸门：只用本轮文本做轻量字符串判断，不新增任何 AI 请求或常驻扫描。
  // selfSleep：区分「确实在聊小星自己的睡眠习惯」和「说自己困了 / 催他睡 / 问现在几点」。
  var SELF_SLEEP_TRAIT_RE = /(?:你|小星|星回).{0,10}(?:嗜睡|犯困|犯懒|困|爱睡|贪睡|睡觉|睡眠|睡得|睡不着|睡醒|做梦|梦游|梦话|起床气|数星星|入眠|失眠|熬夜|哪里都能睡)|(?:嗜睡|数星星入眠|数星星|梦游|起床气)/;
  var ORDINARY_SLEEP_RE = /(?:我|咱|自己).{0,3}(?:困|睡|眠|做梦|失眠|睡不着)|(?:现在几点|几点了|晚安|睡吧|去睡|该睡|早点睡|别熬夜|熬夜了)/;
  var CONTEXT_GATES = {
    selfSleep: function (text) {
      var t = String(text || '');
      if (ORDINARY_SLEEP_RE.test(t)) return false;
      return SELF_SLEEP_TRAIT_RE.test(t);
    }
  };

  function gateAllows(text, sec) {
    var g = sec.gateKey && CONTEXT_GATES[sec.gateKey];
    return !g || g(text);
  }

  // 从某一层取匹配段落：最近使用优先（LRU）。
  // - 只有「本轮文本命中」才刷新使用位置；历史窗口命中只用于无 current 命中时的粘性保留，
  //   不参与刷新，避免历史里的旧话题反复占据最新位置；
  // - 本轮命中移到最前，其余按原相对顺序跟随，超过容量从尾部淘汰最久未命中的旧话题；
  // - 某一轮没有命中时 active 不变（粘性），不立即卸载持续讨论的话题；
  // - 明确换话题清空 active 并屏蔽历史恢复；被淘汰的旧话题重新提及时可再次命中加载；
  // - nosticky 段不进 active、不参与历史恢复，只有本轮文本命中且通过语境闸门才随本次返回。
  function match(layer, text, historyText, opts) {
    var o = opts || {};
    var list = data[layer] || [];
    if (!list.length) return [];
    if (isSwitch(text)) {
      active[layer] = [];
      suppressHistory[layer] = true;
    }
    // direct：本轮文本真实命中，才代表"当前正在讨论"，用于刷新最近使用位置。
    var direct = list.filter(function (s) { return hasKeyword(text, s) && gateAllows(text, s); });
    // 非粘性段：不进 active、不参与历史恢复，只在本轮确实命中时临时追加到返回值。
    var transient = direct.filter(function (s) { return s.sticky === false; });
    var stickyDirect = direct.filter(function (s) { return s.sticky !== false; });
    if (stickyDirect.length) {
      suppressHistory[layer] = false;
      var directKeys = {};
      stickyDirect.forEach(function (s) { directKeys[s.key] = true; });
      var rest = active[layer].filter(function (s) { return !directKeys[s.key]; });
      active[layer] = stickyDirect.concat(rest);
    } else if (!active[layer].length && !suppressHistory[layer] && historyText) {
      // 会话刚开始、active 为空时，用历史窗口做一次粘性恢复（不刷新顺序，不淘汰）。
      active[layer] = historyText && list.filter(function (s) {
        return s.sticky !== false && hasKeyword(historyText, s) && gateAllows(historyText, s);
      }) || [];
    }
    var max = Math.max(1, Math.min(4, Number(o.max) || 2));
    if (active[layer].length > max) active[layer] = active[layer].slice(0, max);
    return active[layer].slice(0, max).concat(transient);
  }

  function renderSections(sections, heading) {
    if (!sections.length) return '';
    return '\n【' + heading + '】' + sections.map(function (s) { return '· ' + s.text; }).join('\n');
  }

  // 第三层：角色背景按话题读取（含粘性；nosticky 段例外，仅本轮命中时注入）。
  function background(text, historyText, opts) {
    return renderSections(match('bg', text, historyText, opts), '角色背景·相关细节');
  }

  // 第四层：关系专属资料按情境读取（含粘性）。
  function relationship(text, historyText, opts) {
    return renderSections(match('rel', text, historyText, opts), '关系专属·相关细节');
  }

  // 第五层：功能提示词按事件/情境按需读取。key 为 SEC 名，如 'silence'/'intimate'/'touch'。
  function functionPrompt(key, text) {
    var fn = (data.fn || []).filter(function (s) { return s.key === key; })[0];
    if (fn) return fn.text;
    // 若按需层未加载，按文本关键词兜底匹配同类功能段落
    if (text) {
      var m = (data.fn || []).filter(function (s) { return hasKeyword(text, s); })[0];
      if (m) return m.text;
    }
    return '';
  }

  // 特殊能力资料：仅对话明确涉及相关词，且该条匹配时返回；内容自带"待确认/不得作为确定事实"。
  function special(text) {
    if (!text) return '';
    var hit = (data.special || []).filter(function (s) { return hasKeyword(text, s); });
    if (!hit.length) return '';
    return renderSections(hit.slice(0, 2), '特殊能力资料（设定真实性待确认，仅供相关情境参考）');
  }

  function reset() { active.bg = []; active.rel = []; suppressHistory.bg = false; suppressHistory.rel = false; return api; }

  var api = {
    ready: ready,
    load: load,
    seed: seed,
    baseText: baseText,
    background: background,
    relationship: relationship,
    functionPrompt: functionPrompt,
    special: special,
    match: match,
    isSwitch: isSwitch,
    reset: reset,
    _layers: function () { return data; },
    _embedded: { layer1: LAYER1, layer2: LAYER2 }
  };
  root.Persona = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
