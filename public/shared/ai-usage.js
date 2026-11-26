// shared/ai-usage.js
// 用量统计的落盘与汇总层。只存统计元数据：时间、模型、请求类型、token 数、估算费用。
// 绝不保存聊天正文、消息 ID 对应的内容、API Key 或任何提示词文本。
(function (root) {
  'use strict';

  var memoryBuffer = [];
  var usingMemory = false;

  function cfg() {
    return (root.AIUsageConfig && root.AIUsageConfig.config) || {
      storageKey: 'ylxh.ai.usage.v1',
      maxRecords: 2000,
      usdToCny: 7.1,
      peakMultiplier: 2,
      prices: {},
      requestTypes: {}
    };
  }

  function storage() {
    try {
      var s = root.localStorage;
      if (!s) return null;
      var probe = '__ylxh_usage_probe__';
      s.setItem(probe, '1');
      s.removeItem(probe);
      return s;
    } catch (e) { return null; }
  }

  function load() {
    var s = storage();
    if (!s) return memoryBuffer.slice();
    try {
      var raw = s.getItem(cfg().storageKey);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function save(list) {
    var max = Number(cfg().maxRecords) > 0 ? Number(cfg().maxRecords) : 2000;
    var trimmed = list.slice(-max);
    var s = storage();
    if (!s) { memoryBuffer = trimmed; usingMemory = true; return; }
    try { s.setItem(cfg().storageKey, JSON.stringify(trimmed)); }
    catch (e) { memoryBuffer = trimmed; usingMemory = true; }
  }

  function localDate(ts) {
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function estimate(entry) {
    var C = cfg();
    var pricing = (root.AIUsageConfig && root.AIUsageConfig.priceOf)
      ? root.AIUsageConfig.priceOf(entry.model)
      : (C.prices[entry.model] || C.prices['deepseek-flash'] || { hit: 0, miss: 0, output: 0 });
    var peak = !!(root.AIUsageConfig && root.AIUsageConfig.isPeak
      ? root.AIUsageConfig.isPeak(entry.ts)
      : false);
    var mult = peak ? (Number(C.peakMultiplier) || 2) : 1;
    // 传入的是已经摊平的 record 行：token 字段就在 entry 顶层，不在 entry.usage 里
    var u = entry;
    var usd = 0;
    if (typeof u.hit === 'number') usd += (u.hit / 1e6) * (pricing.hit || 0) * mult;
    if (typeof u.miss === 'number') usd += (u.miss / 1e6) * (pricing.miss || 0) * mult;
    if (typeof u.completion === 'number') usd += (u.completion / 1e6) * (pricing.output || 0) * mult;
    return {
      usd: Math.round(usd * 1e6) / 1e6,
      cny: Math.round(usd * (Number(C.usdToCny) || 7.1) * 1e4) / 1e4,
      peak: peak,
      priceKnown: !!pricing && (pricing.hit != null || pricing.miss != null)
    };
  }

  /** 由 ai-client.js 在每次真实请求返回后调用一次；重复调用同一条目不会二次去重（调用方保证一次请求一次记录） */
  function record(entry) {
    entry = entry || {};
    var ts = Number(entry.ts) > 0 ? Number(entry.ts) : Date.now();
    var u = entry.usage || {};
    var row = {
      ts: ts,
      date: localDate(ts),
      model: String(entry.model || 'unknown'),
      requestType: String(entry.requestType || 'other'),
      ok: entry.ok !== false,
      errorCode: entry.ok === false ? String(entry.errorCode || 'ERROR') : null,
      available: u.available === true,
      unavailableReason: u.available === true ? null : String(u.reason || 'unavailable'),
      prompt: typeof u.prompt === 'number' ? u.prompt : null,
      completion: typeof u.completion === 'number' ? u.completion : null,
      total: typeof u.total === 'number' ? u.total : null,
      hit: typeof u.hit === 'number' ? u.hit : null,
      miss: typeof u.miss === 'number' ? u.miss : null,
      identityOk: typeof u.identityOk === 'boolean' ? u.identityOk : null,
      cost: null
    };
    row.cost = estimate(row);
    var list = load();
    list.push(row);
    save(list);
    return row;
  }

  /** 按日期 / 请求类型筛选；days 表示最近 N 天（含今天） */
  function query(opts) {
    opts = opts || {};
    var list = load();
    if (opts.date) {
      list = list.filter(function (r) { return r.date === opts.date; });
    } else if (Number(opts.days) > 0) {
      var cutoff = localDate(Date.now() - (Number(opts.days) - 1) * 86400000);
      list = list.filter(function (r) { return r.date >= cutoff; });
    }
    if (opts.requestType && opts.requestType !== 'all') {
      list = list.filter(function (r) { return r.requestType === opts.requestType; });
    }
    return list;
  }

  /** 汇总：命中率 = hit / (hit + miss)；缺失数据不按 0 计，命中率为 null */
  function summarize(records) {
    var list = Array.isArray(records) ? records : [];
    var out = {
      count: list.length, available: 0, unavailable: 0, failed: 0,
      prompt: 0, completion: 0, total: 0, hit: 0, miss: 0,
      usd: 0, cny: 0, hitRate: null, byType: {}
    };
    var hitSeen = false, missSeen = false;
    list.forEach(function (r) {
      if (!r) return;
      if (r.ok === false) out.failed += 1;
      if (r.available === true) out.available += 1; else out.unavailable += 1;
      ['prompt', 'completion', 'total', 'hit', 'miss'].forEach(function (k) {
        if (typeof r[k] === 'number') out[k] += r[k];
      });
      if (typeof r.hit === 'number') hitSeen = true;
      if (typeof r.miss === 'number') missSeen = true;
      if (r.cost && typeof r.cost.usd === 'number') { out.usd += r.cost.usd; out.cny += r.cost.cny || 0; }

      var t = r.requestType || 'other';
      if (!out.byType[t]) {
        out.byType[t] = { count: 0, prompt: 0, completion: 0, hit: 0, miss: 0, usd: 0, cny: 0, hitRate: null, _hit: false, _miss: false };
      }
      var b = out.byType[t];
      b.count += 1;
      ['prompt', 'completion', 'hit', 'miss'].forEach(function (k) {
        if (typeof r[k] === 'number') b[k] += r[k];
      });
      if (typeof r.hit === 'number') b._hit = true;
      if (typeof r.miss === 'number') b._miss = true;
      if (r.cost && typeof r.cost.usd === 'number') { b.usd += r.cost.usd; b.cny += r.cost.cny || 0; }
    });
    if (hitSeen || missSeen) {
      var denom = out.hit + out.miss;
      out.hitRate = denom > 0 ? out.hit / denom : null;
    }
    Object.keys(out.byType).forEach(function (k) {
      var b = out.byType[k];
      if (b._hit || b._miss) {
        var d = b.hit + b.miss;
        b.hitRate = d > 0 ? b.hit / d : null;
      }
      delete b._hit;
      delete b._miss;
    });
    out.usd = Math.round(out.usd * 1e6) / 1e6;
    out.cny = Math.round(out.cny * 1e4) / 1e4;
    return out;
  }

  function dates() {
    var set = {};
    load().forEach(function (r) { if (r && r.date) set[r.date] = true; });
    return Object.keys(set).sort().reverse();
  }

  function clear() {
    memoryBuffer = [];
    usingMemory = false;
    var s = storage();
    if (s) { try { s.removeItem(cfg().storageKey); } catch (e) {} }
  }

  function status() {
    return { usingMemory: usingMemory, storageKey: cfg().storageKey, maxRecords: cfg().maxRecords };
  }

  root.AIUsage = {
    record: record,
    query: query,
    summarize: summarize,
    dates: dates,
    clear: clear,
    status: status
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
