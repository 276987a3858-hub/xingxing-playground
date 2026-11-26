/* public/shared/persona-memory.js — 三类动态资料按需读取层
 * 职责：把长期记忆 / 日记 / 共同珍藏由"每轮全量注入"改为"按需检索注入"。
 * 原始记录保护（硬约束）：
 *   - 只读：不改、不删、不覆盖任何原始记录；摘要仅作检索索引；
 *   - 命中重要记忆优先回原文核实；不把推测/截断片段当事实；
 *   - 找不到如实说没找到；成功发出后才做去重标记，失败不占位。
 * 长期记忆三路（严格互斥，绝不两路同时注入）：
 *   - v2（entries）：只检索 active、非 baseline 镜像条目，语义/话题匹配 + 语境闸门；
 *   - v2 的 baseline 原文：仅当 v2 没有任何条目命中时，按 v1 片段规则回退，避免切换后旧记忆消失；
 *   - v1（longTermMemory 整段字符串）：供 v2 未初始化/读取异常时使用。
 * baseline 字段永远不会作为「第二份记忆」直接注入；镜像条目永远不进入条目池。
 * 数据源：longTermMemory(KV) / longTermMemory.v2(由 app.js 传入 state) / diaries / keeps。
 * 暴露 window.PersonaMemory / globalThis.PersonaMemory。
 */
(function (root) {
  'use strict';

  // 触发"需要读旧资料"的本地信号（0 请求）
  var RECALL_RE = /(之前|上次|前几天|那天|曾经|回忆|回顾|记得|说过|答应|约定|说好|有没有.*(说|做|提)|你记不记得|我们的|我们的.*(事|那天|那次)|日记|珍藏|纪念)/;
  // 明确询问某段经历/偏好：允许检索（并绕过会话去重，见 memoryPartV2）
  var EXPLICIT_ASK_RE = /(我喜欢什么|我讨厌什么|我最爱|我的喜好|我的偏好|我叫什么|我是谁|我生日|我的生日|我是什么性格|我平时.*(样|如何)|我们约过|我们约定|我们说好|你记得我什么|我有哪些|我做过什么|我去过哪)/;
  // 谨慎语境：否定 / 纠正 / 假设 / 引用——不能仅因出现关键词就认定相关
  var CAUTION_RE = /(不是|并不是|我不再|我说错|你记错|记错了|其实不|假如|如果.*(呢|的话)|假设|听说|他说|她说|别人说|我从来不|我没|我没有)/;
  var DIARY_RE = /(日记|写过|记录|那几天|生活|发生了什么)/;
  var KEEP_RE = /(珍藏|纪念册|收下|那件.*(事|瞬间)|共同经历)/;
  var HISTORY_RE = /(很久|很早|几个月|上个月|历史|全部|从头|翻一翻)/;

  var MAX_LEN = { memory: 400, diary: 160, keep: 160 };  // 仅限制单轮注入片段，不回溯原始数据
  var MAX_ITEMS = 3;
  var V2_MIN_SCORE = 4;      // v2 命中阈值：需要强证据，减少两字关键词误触发
  var V2_EXPLICIT_SCORE = 2; // 明确询问时放宽，但仍需话题/词命中

  // 话题词库：按记忆类别匹配明确话题（比两字滑窗更可靠）
  var TOPIC_WORDS = {
    preference: ['喜欢', '讨厌', '最爱', '偏好', '爱好', '口味', '不喜欢', '爱吃', '怕'],
    fact: ['名字', '叫什么', '生日', '星座', '年龄', '工作', '学校', '住在', '家住', '职业'],
    agreement: ['约定', '说好', '答应', '约好', '计划', '一起去'],
    event: ['上次', '那天', '发生', '去过', '买了', '做了', '一起玩'],
    relation: ['我们', '关系', '在一起', '认识', '相爱', '搭档'],
    habit: ['习惯', '作息', '每天', '常常', '总是', '睡觉', '熬夜'],
    other: []
  };

  function clip(s, n) {
    var str = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return str.length > n ? str.slice(0, n) + '…' : str;
  }
  function clean(s) { return String(s == null ? '' : s).replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, ''); }

  // 二元组（滑窗 2 字）重叠率：用于 history 文本与 baseline 分句/片段的边界匹配，
  // 不能只靠"完整字符串恰好相等"。片段只要在另一方的连续片段里，也会被识别为同一内容。
  function bigrams(s) {
    var out = [], i;
    for (i = 0; i + 2 <= s.length; i++) out.push(s.slice(i, i + 2));
    return out;
  }
  // frag 是否与 full 指向同一段内容：
  //  - 完全相等；
  //  - frag 是 full 的连续片段；
  //  - frag 的连续二元组有较高比例落在 full 中（应对 history 记录整段、baseline 被切成多句，
  //    或标点/连接词不同导致 clean 后仍不完全一致的边界情况）。
  // MIN_SHARED 防止把"她"这类极短片段误判为覆盖整句。
  function fragmentOf(frag, full) {
    if (!frag || !full) return false;
    if (frag === full) return true;
    // 连续包含：片段至少 3 字，避免"她""的"这类极短片段命中整句（误伤）。
    if (frag.length >= 3 && full.indexOf(frag) !== -1) return true;
    // 二元组重叠：应对 clean 后仍因连接词/个别字差异不完全一致的边界。
    // 要求命中 >=3 且覆盖率 >=0.7，短片段不进此分支，避免相似但不同的事实被误判。
    if (bigrams(frag).length < 4) return false;
    var fb = bigrams(frag), uniq = [], seen = {}, k, j;
    for (k = 0; k < fb.length; k++) {
      if (!seen[fb[k]]) { seen[fb[k]] = true; uniq.push(fb[k]); }
    }
    var hit = 0;
    for (j = 0; j < uniq.length; j++) if (full.indexOf(uniq[j]) !== -1) hit++;
    return hit >= 3 && hit / uniq.length >= 0.7;
  }

  // 收集"已被改写/撤回/归档"的正文，作为 baseline 回退的排除依据。来源三类：
  //  1) 所有 active 非镜像条目的当前正文（mirror 排除，否则 baseline 永不回退）；
  //  2) 所有 retracted / archived 条目的正文（含镜像：手动撤回镜像后不得经 baseline 复活）；
  //  3) 所有条目 history[].from / to 中记录的历史正文（含被 revise / 用户纠正掉旧值）。
  // 只取字符串正文；history 中的 source/category/status 字段 from/to 是对象或非正文，跳过。
  function supersededTexts(state) {
    var out = [];
    var entries = (state && Array.isArray(state.entries)) ? state.entries : [];
    entries.forEach(function (e) {
      if (!e) return;
      var st = e.status;
      var mirror = !!(e.source && e.source.mirrorOfBaseline);
      if (typeof e.text === 'string' && e.text &&
          ((st === 'active' && !mirror) || st === 'retracted' || st === 'archived')) {
        out.push(e.text);
      }
      var h = Array.isArray(e.history) ? e.history : [];
      h.forEach(function (rec) {
        if (!rec) return;
        if (typeof rec.from === 'string' && rec.from) out.push(rec.from);
        if (typeof rec.to === 'string' && rec.to) out.push(rec.to);
      });
    });
    return out.map(clean).filter(Boolean);
  }
  // 判断一个 baseline 分句是否已被任一"取代文本"覆盖（即旧内容不得再回退注入）。
  function isSuperseded(unitClean, excludedList) {
    if (!unitClean) return false;
    for (var i = 0; i < excludedList.length; i++) {
      var ex = excludedList[i];
      if (!ex) continue;
      // 双向片段匹配：既允许 excluded 记录整段旧原文（含本分句），
      // 也允许 excluded 只是本分句里被改掉的一个片段。
      if (fragmentOf(unitClean, ex) || fragmentOf(ex, unitClean)) return true;
    }
    return false;
  }

  function matches(text, obj) {
    if (!text) return false;
    var fields = [obj.title, obj.name, obj.content, obj.text, obj.reason].filter(Boolean).join(' ');
    // 逐词命中：中文按 2 字滑窗，避免长文本整体包含才命中
    var q = clean(text);
    if (!q) return false;
    for (var i = 0; i + 2 <= q.length; i++) {
      var tok = q.slice(i, i + 2);
      if (fields.indexOf(tok) !== -1) return true;
    }
    return false;
  }

  // v2 相关性打分：3-4 字连续片段（强） > 话题词命中（中） > 两字滑窗多次（弱）
  function v2Score(query, entry) {
    var q = clean(query);
    var t = clean(entry.text);
    if (!q || !t) return 0;
    var score = 0, n, i;
    // 强：3 字及以上连续片段
    for (n = 4; n >= 3 && !score; n--) {
      for (i = 0; i + n <= q.length; i++) {
        if (t.indexOf(q.slice(i, i + n)) !== -1) { score += 4; break; }
      }
    }
    // 中：话题词命中。category 本身已表明记忆话题，只要用户问题里出现该类别的话题词即可
    //（例如"记得我们的约定吗"→ agreement 条目"我们约好去看星星"，不必正文也含"约定"二字）。
    var words = (TOPIC_WORDS[entry.category] || []).concat(TOPIC_WORDS.other || []);
    for (i = 0; i < words.length; i++) {
      if (q.indexOf(words[i]) !== -1) { score += 4; break; }
    }
    // 弱：两字滑窗命中 >= 2 处
    var hits = 0;
    for (i = 0; i + 2 <= q.length; i++) {
      if (t.indexOf(q.slice(i, i + 2)) !== -1) hits++;
    }
    if (hits >= 2) score += 1;
    return score;
  }

  function blocked(topic) {
    try { return !!(root.LifeTopics && root.LifeTopics.isBlocked && root.LifeTopics.isBlocked(topic)); }
    catch (e) { return false; }
  }

  // 成功去重：仅内存会话态，app.js 在请求成功后调用 markSent(keys)。
  var sent = {};
  function markSent(keys) {
    (Array.isArray(keys) ? keys : [keys]).forEach(function (k) { if (k) sent[k] = true; });
  }
  function reset() { sent = {}; }
  function isSent(k) { return !!sent[k]; }

  /* ---------------- 长期记忆 v2：条目检索 ---------------- */
  // state 来自第一阶段 isValidState；text 为本轮用户消息。
  function memoryPartV2(text, state, opts) {
    opts = opts || {};
    var explicit = EXPLICIT_ASK_RE.test(String(text || ''));
    if (!RECALL_RE.test(String(text || '')) && !explicit && !HISTORY_RE.test(String(text || ''))) {
      return { text: '', keys: [], reason: 'no-recall' };   // 普通闲聊：不注入
    }
    if (blocked('task')) return { text: '', keys: [], reason: 'blocked' };

    // 只取有效条目：active + 非 baseline 镜像；baseline 字段永不作为记忆注入
    var pool = (state.entries || []).filter(function (e) {
      return e && e.status === 'active' && !(e.source && e.source.mirrorOfBaseline);
    });
    if (!pool.length) {
      // 典型场景：v2 已由旧记忆初始化，但只有一条 baseline 镜像（被排除）。
      // 这里不直接宣告「没找到」，由上层 memoryPart 回退到保留的完整原文。
      return { text: '【长期记忆】没有找到对应记录，如实说明没有找到，不要编造。', keys: [], reason: 'no-pool' };
    }

    var caution = CAUTION_RE.test(String(text || ''));
    var threshold = explicit ? V2_EXPLICIT_SCORE : V2_MIN_SCORE;
    var scored = [];
    pool.forEach(function (e) {
      var sc = v2Score(text, e);
      if (sc >= threshold) {
        // 谨慎语境：两字弱命中不足以支撑，提升门槛
        if (caution && sc < (explicit ? 3 : 5)) return;
        scored.push({ e: e, sc: sc });
      }
    });
    if (!scored.length) {
      return { text: '【长期记忆】没有找到对应记录，如实说明没有找到，不要编造。', keys: [], reason: 'no-match' };
    }
    scored.sort(function (a, b) { return b.sc - a.sc; });

    // 会话去重：明确询问时绕过（用户主动再问就再给）；否则已成功发出的条目不重复注入。
    // 同一话题持续交流时，markSent 只在请求成功后标记，未命中不占位 → 相关条目保持可用。
    var picked = [];
    for (var i = 0; i < scored.length && picked.length < MAX_ITEMS; i++) {
      var key = 'memory:' + scored[i].e.id;
      if (!explicit && isSent(key)) continue;
      picked.push({ key: key, e: scored[i].e });
    }
    if (!picked.length) {
      // 候选存在但本会话已成功注入过：静默。绝不回退 baseline，否则旧内容会换个键重复出现。
      return { text: '', keys: [], reason: 'all-sent', matched: scored.length };
    }

    // 控制注入长度：片段有上限；标注来源/仅片段，重要约定以原文为准。原始数据不动。
    var lines = [], keys = [], total = 0;
    picked.forEach(function (p) {
      var frag = clip(p.e.text, MAX_LEN.memory);
      if (total + frag.length > MAX_LEN.memory * MAX_ITEMS && lines.length) return;
      total += frag.length;
      lines.push('· [' + p.e.category + '] ' + frag + '（片段，完整内容见条目 ' + p.e.id + '）');
      keys.push(p.key);
    });
    var cautionNote = caution ? '\n（注意：这句话可能是否定、纠正、假设或引用语境，别把片段当成新的确定事实。）' : '';
    return {
      text: '\n【长期记忆·相关条目（仅供核实，重要约定请按原文理解）】\n' + lines.join('\n') + cautionNote,
      keys: keys, reason: 'ok', matched: scored.length
    };
  }

  /* ---------------- 长期记忆 v1（回退路径，逻辑不变） ---------------- */
  function memoryPartV1(text, longTermMemory, opts) {
    opts = opts || {};
    var s = String(text || '');
    var recall = RECALL_RE.test(s) ||
      !!(opts.allowExplicit && EXPLICIT_ASK_RE.test(s)) ||
      !!(opts.allowHistory && HISTORY_RE.test(s));
    if (!recall) return { text: '', keys: [], reason: 'no-recall' };
    if (blocked('task')) return { text: '', keys: [], reason: 'blocked' };
    var raw = String(longTermMemory || '').trim();
    if (!raw) return { text: '【长期记忆】没有找到对应记录，如实说明没有找到，不要编造。', keys: [], reason: 'empty' };
    var units = raw.split(/(?<=[。！？\n；;])/).map(function (x) { return x.trim(); }).filter(Boolean);
    // v2→baseline 回退时，跳过已被 v2 条目 revise / 纠正 / retract / archive 掉的片段：
    // 这些旧内容不得经 baseline 复活。excluded 由调用方汇总 active 正文 + 非 active 正文 + history。
    var excluded = (opts.excludeTexts || []).map(clean).filter(Boolean);
    var matched = units.filter(function (u) {
      var cu = clean(u);
      if (!cu) return false;
      if (isSuperseded(cu, excluded)) return false;
      return matches(text, { content: u });
    });
    if (!matched.length) return { text: '【长期记忆】没有找到对应记录，如实说明没有找到，不要编造。', keys: [], reason: 'no-match' };
    var picked = matched.filter(function (u) { return !isSent('memory:' + clip(u, 24)); });
    if (!picked.length) return { text: '', keys: [], reason: 'all-sent' };
    picked = picked.slice(0, MAX_ITEMS).map(function (u) { return clip(u, MAX_LEN.memory); });
    return {
      text: '\n【长期记忆·相关片段（仅供核实，重要约定请按原文理解）】\n' + picked.join('\n'),
      keys: picked.map(function (u) { return 'memory:' + clip(u, 24); }), reason: 'ok'
    };
  }

  // 统一入口：v2 合法 → v2 条目；v2 没有任何可用命中时，用 v2 中完整保留的旧原文回退。
  // 关键：baseline 不是第二条记忆，绝不直接注入；它只在「v2 没给任何条目」时经 v1 片段匹配出现。
  // 同一话题已成功注入过（all-sent）时不回退，避免旧内容换一套 key 重复出现。
  function memoryPart(text, longTermMemory, opts) {
    opts = opts || {};
    var LTM = root.LongTermMemoryV2;
    if (opts.v2State && LTM && typeof LTM.isValidState === 'function' && LTM.isValidState(opts.v2State)) {
      var v2 = memoryPartV2(text, opts.v2State, opts);
      if (v2.keys && v2.keys.length) return v2;
      if (v2.reason === 'no-pool' || v2.reason === 'no-match') {
        var baseline = opts.v2State.baseline;
        if (typeof baseline === 'string' && baseline.trim()) {
          // 排除依据 = active 正文 + retracted/archived 正文 + 全部 history 的 from/to。
          // 已被修正、撤回、归档、用户纠正的旧内容因此不会经 baseline 回退重新注入。
          var excluded = supersededTexts(opts.v2State);
          var fb = memoryPartV1(text, baseline, {
            allowExplicit: true, allowHistory: true, excludeTexts: excluded
          });
          if (fb.keys && fb.keys.length) {
            return {
              text: fb.text.replace('【长期记忆·相关片段', '【长期记忆·旧版原文回退（旧原文完整保留）·相关片段'),
              keys: fb.keys, reason: 'baseline-fallback', fallbackToBaseline: true
            };
          }
          if (fb.reason === 'all-sent') return { text: '', keys: [], reason: 'all-sent' };
        }
      }
      return v2;
    }
    return memoryPartV1(text, longTermMemory);
  }

  // 珍藏状态闸门：只有双方都已确认、正式收录（status:'saved'）的珍藏，才算「已确认的共同经历」。
  //   - 待星星回应 / 待用户确认 / 星星拒绝 / 用户拒绝 一律不算已确认，不得注入上下文、不得当记忆来源；
  //   - 旧记录没有 status：沿用 room-keeps.js keepStatus 的兼容口径按「已收录」对待（只读判断，不写回数据）；
  //   - 未知状态按「未确认」处理：宁可读不到，也不把不确定的内容说成事实。
  // 本函数只做判断/筛选，不修改、不删除任何原始记录。
  function keepIsConfirmed(record) {
    if (!record || typeof record !== 'object') return false;
    var st = record.status;
    if (st == null || st === '') return true;
    return st === 'saved';
  }
  function confirmedKeeps(records) {
    return (Array.isArray(records) ? records : []).filter(keepIsConfirmed);
  }

  // 日记 / 珍藏：从原始记录数组检索；命中后给原文片段并标注来源。
  function recordPart(text, records, type) {
    var trigger = type === 'diary' ? DIARY_RE.test(String(text || '')) : KEEP_RE.test(String(text || ''));
    var need = trigger || RECALL_RE.test(String(text || ''));
    if (!need) return { text: '', keys: [] };
    var topic = 'task';
    if (blocked(topic)) return { text: '', keys: [] };
    var list = Array.isArray(records) ? records : [];
    // 珍藏：未确认/已拒绝的记录仍在库和管理页，只是不进入「已确认」注入池。
    if (type === 'keep') list = confirmedKeeps(list);
    var label = type === 'diary' ? '日记' : '共同珍藏';
    if (!list.length) return { text: '【' + label + '】没有找到对应记录，如实说明没有找到，不要编造。', keys: [] };
    var picked = list.filter(function (r) {
      var key = type + ':' + (r && r.id != null ? r.id : JSON.stringify(r && r.title || ''));
      return matches(text, r) && !isSent(key);
    }).slice(0, MAX_ITEMS);
    if (!picked.length) return { text: '【' + label + '】没有找到对应记录，如实说明没有找到，不要编造。', keys: [] };
    var n = type === 'diary' ? MAX_LEN.diary : MAX_LEN.keep;
    var lines = picked.map(function (r) {
      var key = type + ':' + (r && r.id != null ? r.id : JSON.stringify(r && r.title || ''));
      var body = clip(r.content || r.text || '', n);
      var title = r.title ? '《' + clip(r.title, 20) + '》' : '';
      return { key: key, line: '· ' + title + body + (type === 'keep' ? '（她当时收下的一件特别的事）' : '') };
    });
    return {
      text: '\n【' + label + '·相关记录（原文片段，未命中不要编造）】\n' + lines.map(function (x) { return x.line; }).join('\n'),
      keys: lines.map(function (x) { return x.key; })
    };
  }

  var api = {
    needRecall: function (text) {
      return RECALL_RE.test(String(text || '')) || HISTORY_RE.test(String(text || '')) || EXPLICIT_ASK_RE.test(String(text || ''));
    },
    // 明确追问：用户主动要求复述/确认已说过的内容。此时机自述允许再次注入已 sent 的记录。
    isExplicitAsk: function (text) {
      return EXPLICIT_ASK_RE.test(String(text || ''));
    },
    memoryPart: memoryPart,
    memoryPartV2: memoryPartV2,
    v2Score: v2Score,
    recordPart: recordPart,
    keepIsConfirmed: keepIsConfirmed,
    confirmedKeeps: confirmedKeeps,
    markSent: markSent,
    isSent: isSent,
    reset: reset,
    _keys: { MAX_LEN: MAX_LEN, MAX_ITEMS: MAX_ITEMS, V2_MIN_SCORE: V2_MIN_SCORE, V2_EXPLICIT_SCORE: V2_EXPLICIT_SCORE }
  };
  root.PersonaMemory = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
