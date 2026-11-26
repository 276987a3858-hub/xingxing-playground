/* public/shared/history-window.js — 请求层历史窗口（纯函数，不读库、不写库、不调 AI）
 *
 * 职责：
 *  1. 同 role 合并时保留 sourceIds / parts，避免连续 user 消息被整体误删。
 *  2. 主聊天 24000/20000 字滞回：state.leftKey 钉住左边界，超过 hard 才从尾部裁到 soft。
 *  3. 从窗口里剔除当前 user 消息并原样返回，供请求末尾重新挂载。
 *
 * ID 策略（只作用于请求层临时副本，不写回 IndexedDB）：
 *  - 比较统一走 String(id)，但 sourceIds 保留原始 ID 的值与类型（正常数字 ID 行为不变）。
 *  - 缺失 ID 用 'hw:idx:<index>' 作为请求层身份，parts[].source 仍指向原对象。
 *  - 真正重复的 ID 全部隔离为 '<id>#dup<n>'，并在 parts[] 里保留 originalId/source；
 *    不静默丢消息，也不让陈旧主键参与重复守卫。
 *  - 合并组/拆分组不继承某一条原始消息的主键，使用 tempId 作请求层身份。
 */
(function (root) {
  'use strict';

  var HARD_LIMIT = 24000;
  var SOFT_LIMIT = 20000;
  var SYNTHETIC_PREFIX = 'hw:idx:';
  var GROUP_PREFIX = 'hw:group:';

  function defaultTextOf(m) {
    return String((m && m.content != null) ? m.content : '');
  }

  /** 统一比较策略：null/undefined 不参与匹配，其余一律按字符串比较。 */
  function idKey(id) {
    return id == null ? null : String(id);
  }

  /**
   * 请求层身份。正常 ID 原样返回；重复 ID 返回可追溯别名；缺失 ID 返回索引身份。
   * occurrence > 1 表示该 key 在本次输入中重复出现。
   */
  function identityOf(m, index, occurrence, duplicate) {
    if (m && m.id != null) {
      var key = String(m.id);
      return duplicate ? key + '#dup' + occurrence : m.id;
    }
    return SYNTHETIC_PREFIX + index;
  }

  function copyOf(o) {
    var c = {};
    if (!o || typeof o !== 'object') return c;
    for (var k in o) {
      if (Object.prototype.hasOwnProperty.call(o, k)) c[k] = o[k];
    }
    return c;
  }

  function tempIdOf(index) {
    return GROUP_PREFIX + index;
  }

  function imageOf(parts) {
    var image = null;
    var imageSourceId = null;
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].image) { image = parts[i].image; imageSourceId = parts[i].id; }
    }
    return { image: image, imageSourceId: imageSourceId };
  }

  /** 由 parts 重建一个临时消息组，绝不继承被剥离消息的原始主键。 */
  function groupFromParts(parts, role, template, index) {
    var g = copyOf(template);
    g.role = role;
    g.parts = parts.slice();
    g.sourceIds = parts.map(function (p) { return p.id; });
    g.originalIds = parts.map(function (p) { return p.originalId; });
    g.content = parts.map(function (p) { return p.text; }).join('\n');
    var img = imageOf(parts);
    g.image = img.image;
    g.imageSourceId = img.imageSourceId;
    g.tempId = tempIdOf(index);
    // 单条组可以保留原主键/别名；多条合并组不能假装自己还是某一条原始消息。
    g.id = parts.length === 1 ? parts[0].id : null;
    return g;
  }

  /** 同 role 合并；每个合并组带 sourceIds / originalIds / parts，parts 保留逐条原文与图片引用 */
  function mergeWithSourceIds(history, opts) {
    var o = opts || {};
    var textOf = typeof o.textOf === 'function' ? o.textOf : defaultTextOf;
    var list = Array.isArray(history) ? history : [];
    var counts = Object.create(null);
    var seen = Object.create(null);
    var i, key;

    for (i = 0; i < list.length; i++) {
      key = idKey(list[i] && list[i].id);
      if (key != null) counts[key] = (counts[key] || 0) + 1;
    }

    var out = [];
    for (i = 0; i < list.length; i++) {
      var m = list[i] || {};
      var originalId = (m.id != null) ? m.id : null;
      key = idKey(originalId);
      var occurrence = 1;
      if (key != null) {
        seen[key] = (seen[key] || 0) + 1;
        occurrence = seen[key];
      }
      var duplicate = (key != null && counts[key] > 1);
      var id = identityOf(m, i, occurrence, duplicate);
      var part = {
        id: id,
        key: idKey(id),
        originalId: originalId,
        duplicate: duplicate,
        text: textOf(m),
        image: m.image || null,
        source: m
      };

      if (out.length && out[out.length - 1].role === m.role) {
        var last = out[out.length - 1];
        last.parts.push(part);
        last.sourceIds.push(id);
        last.originalIds.push(originalId);
        last.content = last.parts.map(function (p) { return p.text; }).join('\n');
        var img = imageOf(last.parts);
        last.image = img.image;
        last.imageSourceId = img.imageSourceId;
        last.id = null; // 合并组不再冒充任何一条原始消息
      } else {
        out.push(groupFromParts([part], m.role, m, i));
      }
    }
    return out;
  }

  function charsOf(window) {
    return (window || []).reduce(function (s, m) {
      return s + String(m && m.content != null ? m.content : '').length;
    }, 0);
  }

  function sizeOf(entry, opts) {
    var o = opts || {};
    var cost = typeof o.imageCharCost === 'number' ? o.imageCharCost : 0;
    return String(entry && entry.content != null ? entry.content : '').length + (entry && entry.image ? cost : 0);
  }

  function sourceIdsOf(window) {
    var ids = [];
    (window || []).forEach(function (m) {
      (m && Array.isArray(m.sourceIds) ? m.sourceIds : (m && m.id != null ? [m.id] : [])).forEach(function (id) {
        ids.push(id);
      });
    });
    return ids;
  }

  function keyOfGroup(g) {
    return (g && g.sourceIds && g.sourceIds.length) ? String(g.sourceIds[0]) : null;
  }

  /**
   * 24000/20000 滞回窗口。
   * state 只在内存里，不写库；chatHistory 被整体重建/清空时必须置 null。
   * 不传 state 时退化为一次性静态裁剪，供其他路径与测试使用。
   */
  function trimWithHysteresis(history, opts) {
    var o = opts || {};
    var hard = typeof o.hard === 'number' ? o.hard : HARD_LIMIT;
    var soft = typeof o.soft === 'number' ? o.soft : SOFT_LIMIT;
    if (soft > hard) soft = hard;
    var merged = mergeWithSourceIds(history, o);
    var allChars = charsOf(merged);

    var start = 0;
    if (o.state && o.state.leftKey != null) {
      var key = String(o.state.leftKey);
      for (var s = 0; s < merged.length; s++) {
        if (keyOfGroup(merged[s]) === key) { start = s; break; }
      }
    }
    var scoped = start ? merged.slice(start) : merged;
    var total = charsOf(scoped);
    var stats = {
      totalChars: total,
      allChars: allChars,
      hard: hard,
      soft: soft,
      trimmed: false,
      keptChars: total,
      leftSourceId: scoped.length ? scoped[0].sourceIds[0] : null,
      rightSourceId: scoped.length ? scoped[scoped.length - 1].sourceIds.slice(-1)[0] : null
    };
    var nextState = { leftKey: keyOfGroup(scoped[0]) };
    if (!scoped.length || total <= hard) return { window: scoped, state: nextState, stats: stats };

    var out = [];
    var kept = 0;
    for (var i = scoped.length - 1; i >= 0; i--) {
      var size = sizeOf(scoped[i], o);
      if (kept + size > soft && out.length) break;
      out.unshift(scoped[i]);
      kept += size;
    }
    if (!out.length) out = [scoped[scoped.length - 1]];
    stats.trimmed = true;
    stats.keptChars = charsOf(out);
    stats.leftSourceId = out[0].sourceIds[0];
    stats.rightSourceId = out[out.length - 1].sourceIds.slice(-1)[0];
    return { window: out, state: { leftKey: keyOfGroup(out[0]) }, stats: stats };
  }

  /** 兼容旧调用：固定预算裁剪（hard = soft = charBudget），不引入滞回 */
  function trimFixed(history, charBudget, opts) {
    var o = copyOf(opts);
    o.hard = charBudget;
    o.soft = charBudget;
    return trimWithHysteresis(history, o);
  }

  function findOriginal(fullHistory, id, currentMessage) {
    var list = Array.isArray(fullHistory) ? fullHistory : [];
    if (currentMessage && list.indexOf(currentMessage) >= 0) return currentMessage;
    var target = idKey(id);
    if (target == null) return null;
    for (var i = list.length - 1; i >= 0; i--) {
      if (idKey(list[i] && list[i].id) === target) return list[i];
    }
    return null;
  }

  function partMatches(part, id, currentMessage) {
    if (currentMessage && part.source === currentMessage) return true;
    var target = idKey(id);
    if (target == null) return false;
    return idKey(part.originalId) === target || idKey(part.id) === target;
  }

  /**
   * 从窗口剔除当前消息，返回原样消息对象。
   * currentMessage 是可选的对象身份，用来消歧重复 ID；生产主聊天必须传入。
   * 连续同 role 合并组按 parts 精确拆分；只删当前这一条，不删同组更早的消息。
   */
  function detachCurrentTurn(window, currentMessageId, fullHistory, currentMessage) {
    var list = Array.isArray(window) ? window : [];
    if (currentMessageId == null && !currentMessage) {
      return { window: list, current: null, found: false };
    }

    var gi = -1;
    var pi = -1;
    var exact = false;
    if (currentMessage) {
      for (var a = list.length - 1; a >= 0 && !exact; a--) {
        var pa = list[a] && Array.isArray(list[a].parts) ? list[a].parts : [];
        for (var b = pa.length - 1; b >= 0; b--) {
          if (pa[b].source === currentMessage) { gi = a; pi = b; exact = true; break; }
        }
      }
    }
    if (!exact) {
      for (var i = list.length - 1; i >= 0 && gi < 0; i--) {
        var parts = list[i] && Array.isArray(list[i].parts) ? list[i].parts : [];
        for (var j = parts.length - 1; j >= 0; j--) {
          if (partMatches(parts[j], currentMessageId, currentMessage)) { gi = i; pi = j; break; }
        }
      }
    }
    if (gi < 0 || pi < 0) return { window: list, current: null, found: false };

    var group = list[gi];
    var part = group.parts[pi];
    var original = findOriginal(fullHistory, currentMessageId, currentMessage);
    var current = original || {
      id: part.originalId != null ? part.originalId : part.id,
      role: group.role,
      content: part.text,
      image: part.image || null
    };

    var next = list.slice();
    if (group.parts.length === 1) {
      next.splice(gi, 1);
    } else {
      var before = group.parts.slice(0, pi).concat(group.parts.slice(pi + 1));
      next[gi] = groupFromParts(before, group.role, group, gi);
    }
    return {
      window: next,
      current: current,
      found: true,
      groupIndex: gi,
      partIndex: pi,
      ambiguous: !exact && part.duplicate === true,
      isolatedId: part.id
    };
  }

  var api = {
    HARD_LIMIT: HARD_LIMIT,
    SOFT_LIMIT: SOFT_LIMIT,
    mergeWithSourceIds: mergeWithSourceIds,
    trimWithHysteresis: trimWithHysteresis,
    trimFixed: trimFixed,
    detachCurrentTurn: detachCurrentTurn,
    charsOf: charsOf,
    sourceIdsOf: sourceIdsOf,
    _internal: { sizeOf: sizeOf, identityOf: identityOf, idKey: idKey, groupFromParts: groupFromParts }
  };

  root.HistoryWindow = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
