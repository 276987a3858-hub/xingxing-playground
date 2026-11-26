/* public/shared/request-composer.js — 七条请求路径的纯组装适配器
 *
 * 只做纯组装：不读库、不写库、不调 AI、不碰 DOM。
 * app.js 的七个入口通过 rcTask/rcRequestType/rcOptions/assemblePathMessages 使用本模块，
 * 测试可以直接调用同一份生产逻辑，不需要复制一份伪实现。
 */
(function (root) {
  'use strict';

  var PATHS = {
    star: {
      task: '',
      requestType: 'star',
      blocks: ['schedule'],
      options: {}
    },
    chat: {
      task: null, // 由调用方注入 getActionDensityPrompt() + 主聊天引导语
      requestType: 'chat',
      blocks: ['schedule', 'closeTalk', 'game', 'activity', 'lifeContext', 'lifeFacts',
        'topics', 'note', 'persona', 'dynamicMemory', 'silence', 'remind', 'butler', 'history'],
      options: {}
    },
    todayLetter: {
      task: '\n用户刚刚给你寄来一封今日来信。请认真阅读，用自然亲密的口吻回应她。',
      requestType: 'letter',
      blocks: [],
      options: {}
    },
    futureLetter: {
      task: '\n你刚刚打开了用户提前寄给你的未来信。请认真阅读，并以亲密自然的方式回应。',
      requestType: 'letter',
      blocks: [],
      options: {}
    },
    diary: {
      task: '\n请以小星自己的第一人称，回顾近期与用户的聊天，写一篇真实自然的生活日记。不要写成给用户的信，不要虚构没有发生的事情。',
      requestType: 'diary',
      blocks: [],
      options: {}
    },
    keep: {
      task: '\n请从最近的聊天里挑一件真正值得纪念的事，写成一份珍藏提议。' +
        '\n只输出一行标记，格式为 [[KEEP_PROPOSAL: {"title":"不超过10字","text":"她做过或说过的那件事","reason":"你想留下的理由"}]]，不要额外解释。',
      requestType: 'keep',
      blocks: [],
      options: {}
    },
    touch: {
      task: '',
      requestType: 'touch',
      blocks: ['schedule', 'touchFn', 'touchFact'],
      options: { allowEmpty: true }
    }
  };

  var PATH_NAMES = ['star', 'chat', 'todayLetter', 'futureLetter', 'diary', 'keep', 'touch'];

  function specOf(name) {
    return Object.prototype.hasOwnProperty.call(PATHS, name) ? PATHS[name] : null;
  }

  function pathNames() {
    return PATH_NAMES.slice();
  }

  /** chat 的任务说明会随人设机制文本变化，由调用方注入；其余路径返回原文。 */
  function taskFor(name, chatTask) {
    var p = specOf(name);
    if (!p) return '';
    return p.task === null ? String(chatTask == null ? '' : chatTask) : p.task;
  }

  function requestTypeFor(name) {
    var p = specOf(name);
    return p ? p.requestType : 'other';
  }

  function blockIdsFor(name) {
    var p = specOf(name);
    return p ? p.blocks.slice() : [];
  }

  function optionsFor(name) {
    var p = specOf(name);
    var src = p ? p.options : {};
    var out = {};
    for (var k in src) {
      if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
    }
    return out;
  }

  function defaultMap(m) {
    return { role: m && m.role === 'assistant' ? 'assistant' : 'user', content: (m && m.content) || '' };
  }

  /**
   * 动态上下文：调用方给的块在前，环境块随后，当前时间固定在最后。
   * nowBlock 由调用方现取并传入原始文本，本模块只负责加换行前缀。
   */
  function buildDynamicContext(blocks, envBlock, nowBlock, PL) {
    if (!PL || typeof PL.buildDynamicContext !== 'function') return '';
    var list = Array.isArray(blocks) ? blocks.slice() : [];
    if (envBlock) list.push({ id: 'env', text: envBlock });
    if (nowBlock) list.push({ id: 'now', text: '\n' + nowBlock });
    return PL.buildDynamicContext(list);
  }

  /**
   * 真正的生产组装入口：稳定 system → 历史 → 动态 system → 当前 user。
   * history / currentTurn 都只被读取，不写入，不修改原始对象。
   */
  function assemblePathMessages(opts) {
    var o = opts || {};
    var PL = o.PL || root.PromptLayout;
    var mapHistory = typeof o.mapHistory === 'function' ? o.mapHistory : defaultMap;
    var core = String(o.core == null ? '' : o.core);
    var task = String(o.taskInstruction == null ? '' : o.taskInstruction);
    var stableSystem = PL && typeof PL.buildStableSystem === 'function'
      ? PL.buildStableSystem(core, task)
      : core + task;
    var dynamicContext = buildDynamicContext(o.blocks, o.envBlock, o.nowBlock, PL);
    var history = Array.isArray(o.history) ? o.history : [];
    var current = o.currentTurn;

    if (!PL || typeof PL.assembleMessages !== 'function') {
      var fallback = [{ role: 'system', content: stableSystem + dynamicContext }];
      for (var i = 0; i < history.length; i++) fallback.push(mapHistory(history[i]));
      fallback.push(current);
      return fallback;
    }
    return PL.assembleMessages({
      stableSystem: stableSystem,
      historyWindow: history,
      mapHistory: mapHistory,
      dynamicContext: dynamicContext,
      currentTurn: current,
      currentMessageId: o.currentMessageId
    });
  }

  var api = {
    PATHS: PATHS,
    pathNames: pathNames,
    specOf: specOf,
    taskFor: taskFor,
    requestTypeFor: requestTypeFor,
    blockIdsFor: blockIdsFor,
    optionsFor: optionsFor,
    buildDynamicContext: buildDynamicContext,
    assemblePathMessages: assemblePathMessages
  };

  root.RequestComposer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
