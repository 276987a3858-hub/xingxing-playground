/* public/shared/prompt-layout.js — 请求组装（纯函数，不读写库、不调 AI）
 *
 * 目标结构：
 *   [ {system: 稳定层 + 路径任务指令},
 *     ...历史消息,
 *     {system: 动态上下文},        // 可选；放在历史之后、当前消息之前
 *     {user: 当前消息} ]           // 原样挂载，content 可为数组
 *
 * 语义说明：动态上下文使用真实的 system role，不依赖文字标签伪装成 system。
 * DeepSeek 文档未规定 system 必须置顶，但也未明文保证后置 system 的指令优先级；
 * 该风险在交付报告中单列，不用文本标签替代角色语义。
 */
(function (root) {
  'use strict';

  var DYNAMIC_HEADER = '【系统提供的上下文（不是用户原话）】';

  /** 稳定层：核心人设 + 稳定机制 + 路径任务指令。pathInstruction 由调用方保留原有换行前缀。 */
  function buildStableSystem(core, pathInstruction) {
    return String(core == null ? '' : core) + (pathInstruction ? String(pathInstruction) : '');
  }

  /** 动态上下文块：按给定顺序拼接；不修改任何块原文，空块跳过。 */
  function buildDynamicContext(blocks) {
    var list = Array.isArray(blocks) ? blocks : [];
    var parts = [];
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      var text = String((b && b.text != null) ? b.text : '');
      if (text.trim()) parts.push(text);
    }
    return parts.length ? DYNAMIC_HEADER + '\n' + parts.join('\n') : '';
  }

  function containsId(entry, id) {
    if (!entry || id == null) return false;
    if (String(entry.id) === String(id)) return true;
    return Array.isArray(entry.sourceIds) && entry.sourceIds.some(function (x) { return String(x) === String(id); });
  }

  /**
   * 最终 messages 数组。
   * currentTurn 必须已经过 messageToAI 转换；content 可为字符串或对象数组，本函数不做类型转换。
   * currentMessageId 存在时强制检查历史里不能残留同一条，防止当前消息重复发送。
   */
  function assembleMessages(opts) {
    var o = opts || {};
    var stable = String(o.stableSystem == null ? '' : o.stableSystem);
    var history = Array.isArray(o.historyWindow) ? o.historyWindow : [];
    var mapHistory = typeof o.mapHistory === 'function'
      ? o.mapHistory
      : function (m) { return { role: m.role, content: m.content }; };
    var current = o.currentTurn;

    if (!current || typeof current !== 'object' || !current.role) {
      throw new Error('prompt-layout: currentTurn 缺失或不是合法消息对象');
    }
    if (o.currentMessageId != null) {
      for (var i = 0; i < history.length; i++) {
        if (containsId(history[i], o.currentMessageId)) {
          throw new Error('prompt-layout: CURRENT_MESSAGE_DUPLICATE');
        }
      }
    }

    var messages = [{ role: 'system', content: stable }];
    for (var j = 0; j < history.length; j++) {
      var mapped = mapHistory(history[j]);
      if (!mapped || !mapped.role) throw new Error('prompt-layout: 历史消息映射失败');
      messages.push(mapped);
    }
    var dynamic = String(o.dynamicContext == null ? '' : o.dynamicContext);
    if (dynamic) messages.push({ role: 'system', content: dynamic });
    messages.push(current);
    return messages;
  }

  function isMultimodal(content) {
    return Array.isArray(content);
  }

  var api = {
    DYNAMIC_HEADER: DYNAMIC_HEADER,
    buildStableSystem: buildStableSystem,
    buildDynamicContext: buildDynamicContext,
    assembleMessages: assembleMessages,
    isMultimodal: isMultimodal,
    _internal: { containsId: containsId }
  };

  root.PromptLayout = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
