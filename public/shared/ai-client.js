// shared/ai-client.js
// 聊天请求的公共底座：统一的 45 秒超时、错误分类、「输入中」看门狗。
// 只负责「发一次请求 / 判断一次失败」，不碰提示词、不碰消息落库、不碰星星的小沉默规则。
// 用法：AIClient.chat({ url, apiKey, messages, timeoutMs, signal, allowEmpty })
(function (root) {
  'use strict';

  var DEFAULT_TIMEOUT_MS = 45000;
  var DEFAULT_WATCHDOG_MS = 60000;
  // 唯一可调项：默认 45 秒；只有测试或调试会改它，页面正常使用不会动
  var config = { timeoutMs: DEFAULT_TIMEOUT_MS };

  function aiError(code, message, extra) {
    var err = new Error(message || code || '请求失败');
    err.name = 'AIError';
    err.code = code || 'UNKNOWN';
    if (extra && typeof extra === 'object') {
      Object.keys(extra).forEach(function (k) { err[k] = extra[k]; });
    }
    return err;
  }

  // 外部 signal 与内部超时合成一个 signal；返回 cancel 用于解绑，避免定时器/监听泄漏
  function linkSignal(external) {
    var ctrl = new AbortController();
    var onAbort = function () { try { ctrl.abort(); } catch (e) {} };
    if (!external) {
      return { signal: ctrl.signal, abort: onAbort, cancel: function () {} };
    }
    if (external.aborted) onAbort();
    else external.addEventListener('abort', onAbort);
    return {
      signal: ctrl.signal,
      abort: onAbort,
      cancel: function () {
        try { external.removeEventListener('abort', onAbort); } catch (e) {}
      }
    };
  }

  function resolveTimeout(ms) {
    var n = Number(ms);
    if (n > 0) return n;
    var c = Number(config.timeoutMs);
    return c > 0 ? c : DEFAULT_TIMEOUT_MS;
  }

  /**
   * 发一次 JSON 请求。失败一律抛带 code 的 AIError：
   * TIMEOUT / NETWORK / HTTP / BAD_RESPONSE / ABORTED / NO_KEY
   */
  async function postJSON(url, init, opts) {
    opts = opts || {};
    var timeoutMs = resolveTimeout(opts.timeoutMs);
    var doFetch = opts.fetchImpl || (typeof root.fetch === 'function' ? root.fetch.bind(root) : null);
    if (!doFetch) throw aiError('NETWORK', '当前环境不支持网络请求');

    var link = linkSignal(opts.signal);
    var timedOut = false;
    var timer = setTimeout(function () {
      timedOut = true;
      link.abort();
    }, timeoutMs);

    try {
      var res;
      try {
        res = await doFetch(url, Object.assign({}, init || {}, { signal: link.signal }));
      } catch (e) {
        if (timedOut) throw aiError('TIMEOUT', '等了好一会儿，暂时没能收到回复', { timeoutMs: timeoutMs, cause: e });
        if (opts.signal && opts.signal.aborted) throw aiError('ABORTED', '请求已取消', { cause: e });
        throw aiError('NETWORK', (e && e.message) || '网络连接失败', { cause: e });
      }

      if (!res || typeof res.ok !== 'boolean') throw aiError('BAD_RESPONSE', '没有拿到有效响应');
      if (!res.ok) {
        var detail = '';
        try { detail = await res.text(); } catch (e) {}
        throw aiError('HTTP', '服务返回 ' + res.status, {
          status: res.status,
          detail: String(detail || '').slice(0, 300)
        });
      }

      try {
        return await res.json();
      } catch (e) {
        if (timedOut) throw aiError('TIMEOUT', '等了好一会儿，暂时没能收到回复', { timeoutMs: timeoutMs, cause: e });
        throw aiError('BAD_RESPONSE', '返回的内容不完整', { cause: e });
      }
    } finally {
      clearTimeout(timer);
      link.cancel();
    }
  }

  /**
   * 解析 DeepSeek 返回的 usage。只保留数字与布尔，不碰正文。
   * usage 缺失时返回 available:false，所有 token 字段为 null——绝不伪造为 0，
   * 否则命中率与费用会被算成假的「0」。
   */
  function readUsage(data) {
    function n(v) {
      if (typeof v === 'number' && isFinite(v) && v >= 0) return v;
      if (typeof v === 'string' && v.trim() && isFinite(Number(v)) && Number(v) >= 0) return Number(v);
      return null;
    }
    var raw = data && typeof data === 'object' ? data.usage : null;
    var empty = {
      available: false, reason: 'unavailable',
      prompt: null, completion: null, total: null, hit: null, miss: null,
      identityOk: null, derived: { hit: false, miss: false }
    };
    if (!raw || typeof raw !== 'object') return empty;

    var prompt = n(raw.prompt_tokens);
    var completion = n(raw.completion_tokens);
    var total = n(raw.total_tokens);
    var hit = n(raw.prompt_cache_hit_tokens);
    var miss = n(raw.prompt_cache_miss_tokens);
    var derivedHit = false;
    var derivedMiss = false;

    // 兼容把缓存命中放在 prompt_tokens_details.cached_tokens 的返回格式
    if (hit == null && raw.prompt_tokens_details && typeof raw.prompt_tokens_details === 'object') {
      hit = n(raw.prompt_tokens_details.cached_tokens);
      derivedHit = hit != null;
    }
    // miss 未单列时，用 prompt - hit 推导；这是计算，不是伪造
    if (miss == null && prompt != null && hit != null) {
      miss = Math.max(0, prompt - hit);
      derivedMiss = true;
    }

    var any = prompt != null || completion != null || total != null || hit != null || miss != null;
    if (!any) return empty;
    return {
      available: true,
      reason: null,
      prompt: prompt,
      completion: completion,
      total: total,
      hit: hit,
      miss: miss,
      identityOk: (prompt != null && hit != null && miss != null) ? (prompt === hit + miss) : null,
      derived: { hit: derivedHit, miss: derivedMiss }
    };
  }

  /** 记录一次真实请求。统计模块缺失或异常时静默跳过，绝不影响聊天本身 */
  function recordUsage(entry) {
    try {
      var U = root.AIUsage;
      if (U && typeof U.record === 'function') U.record(entry);
    } catch (e) {}
  }

  /** 调一次聊天补全：超时 / 网络 / HTTP / 空回复 全部转成带 code 的错误 */
  async function chat(opts) {
    opts = opts || {};
    var key = String(opts.apiKey == null ? '' : opts.apiKey).trim();
    if (!key) throw aiError('NO_KEY', '请先在房间设置填写 API Key');

    var model = opts.model || 'deepseek-flash';
    var requestType = opts.requestType || 'other';
    var data;
    try {
      data = await postJSON(opts.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + key
        },
        body: JSON.stringify({
          model: model,
          messages: opts.messages || [],
          stream: false
        })
      }, opts);
    } catch (e) {
      // 请求根本没拿到响应：记为 unavailable，不伪造 token 数
      recordUsage({
        ts: Date.now(), model: model, requestType: requestType,
        ok: false, errorCode: (e && e.code) || 'ERROR',
        usage: { available: false, reason: 'no-response' }
      });
      throw e;
    }

    // 一次 chat() 调用只记一条；本项目没有内部自动重试，调用方手动重试会产生新的真实请求，另行记账
    recordUsage({
      ts: Date.now(), model: model, requestType: requestType,
      ok: true, errorCode: null, usage: readUsage(data)
    });

    var content;
    if (data && data.choices && data.choices[0] && data.choices[0].message) {
      content = data.choices[0].message.content;
    }
    if (typeof content !== 'string') throw aiError('BAD_RESPONSE', '响应格式异常');
    var trimmed = content.trim();
    if (!trimmed) {
      // 主动互动允许模型选择沉默；普通对话仍视为失败
      if (opts.allowEmpty) return '';
      throw aiError('EMPTY', '星星没有返回内容');
    }
    return trimmed;
  }

  /** 把错误翻译成给人看的一句话；saved=true 时补上「消息已经保存，可以重试」 */
  function friendly(err, opts) {
    var code = err && err.code;
    var saved = (opts && opts.saved) ? '你的消息已经保存，可以重试。' : '';
    switch (code) {
      case 'TIMEOUT':
        return '等了好一会儿，暂时没能收到星星的回复。' + saved;
      case 'NETWORK':
        return '网络好像断开了，没能收到星星的回复。' + saved;
      case 'HTTP':
        return '服务那边出了点问题（' + (err && err.status != null ? err.status : '未知') + '）。' + saved;
      case 'BAD_RESPONSE':
        return '这次收到的回复不完整。' + saved;
      case 'EMPTY':
        return '星星这次没有说出话来。' + saved;
      case 'LOCAL':
        return '回复处理时出了点问题。' + saved;
      case 'SAVE_REPLY':
        return '回复没能保存下来：' + ((err && err.message) || '未知原因');
      case 'NO_KEY':
        return '先在设置里填写 API Key。';
      case 'ABORTED':
        return '这次请求被取消了。' + saved;
      default:
        return '没能收到星星的回复。' + saved + (err && err.message ? '（' + err.message + '）' : '');
    }
  }

  /**
   * 「输入中」看门狗：start 后必定有一个结局（stop 或到点自动收尾）。
   * 超时兜底比请求超时更晚一点，保证即使请求层出意外，气泡也不会一直转。
   */
  function createTypingGuard(opts) {
    opts = opts || {};
    var watchdogMs = Number(opts.watchdogMs) > 0 ? Number(opts.watchdogMs) : DEFAULT_WATCHDOG_MS;
    var notify = typeof opts.onChange === 'function' ? opts.onChange : null;
    var timer = null;
    var active = false;

    function emit(v) {
      if (active === v) return;
      active = v;
      if (notify) { try { notify(v); } catch (e) {} }
    }

    return {
      start: function () {
        if (timer) { clearTimeout(timer); timer = null; }
        emit(true);
        timer = setTimeout(function () {
          timer = null;
          emit(false);
        }, watchdogMs);
      },
      stop: function () {
        if (timer) { clearTimeout(timer); timer = null; }
        emit(false);
      },
      isActive: function () { return active; }
    };
  }

  root.AIClient = {
    config: config,
    DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
    DEFAULT_WATCHDOG_MS: DEFAULT_WATCHDOG_MS,
    error: aiError,
    postJSON: postJSON,
    readUsage: readUsage,
    chat: chat,
    friendly: friendly,
    createTypingGuard: createTypingGuard
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
