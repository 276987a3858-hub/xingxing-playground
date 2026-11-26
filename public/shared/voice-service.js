/* public/shared/voice-service.js — 语音服务适配层（TTS / ASR）
 * 作用：聊天页面只认识 VoiceService.tts.synthesize() 和 VoiceService.asr.create()，
 *      不认识 ElevenLabs、也不认识 webkitSpeechRecognition。
 * 因此换服务 = 改 speaker 函数或 config.adapter，消息、气泡、备份都不受影响。
 *
 * 附带两件必须集中处理的事：
 *  1) TTS 失败冷却：额度耗尽后不再每条回复都打一次必败请求（30 分钟，可配置）。
 *  2) TTS 超时：服务端卡住时也要能收尾，不能让「输入中」一直转。
 *
 * 挂载：window.VoiceService
 */
(function (root) {
  'use strict';

  function cfg() { return root.VoiceConfig || {}; }
  function ttsCfg() { return cfg().tts || {}; }
  function asrCfg() { return cfg().asr || {}; }
  function txt() { return cfg().text || {}; }

  /* ---------------- 冷却状态（localStorage，跨刷新有效） ---------------- */

  function cooldownKey() { return ttsCfg().cooldownKey || 'ylxh.chat.tts.cooldown.v1'; }

  function cooldownUntil() {
    try { return Number(root.localStorage.getItem(cooldownKey())) || 0; } catch (e) { return 0; }
  }

  function cooldownLeftMs() {
    return Math.max(0, cooldownUntil() - Date.now());
  }

  function startCooldown(ms) {
    var span = typeof ms === 'number' && ms > 0 ? ms : (ttsCfg().failCooldownMs || 30 * 60 * 1000);
    try { root.localStorage.setItem(cooldownKey(), String(Date.now() + span)); } catch (e) {}
    return span;
  }

  function clearCooldown() {
    try { root.localStorage.removeItem(cooldownKey()); } catch (e) {}
  }

  /* ---------------- 小工具 ---------------- */

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onloadend = function () { resolve(reader.result); };
      reader.onerror = function () { reject(reader.error || new Error('读取音频失败')); };
      reader.readAsDataURL(blob);
    });
  }

  /* ---------------- TTS ---------------- */

  /**
   * 合成语音。
   * 返回 { ok:true, blob, base64, mime } 或 { ok:false, reason, detail }
   * reason: 'cooldown' | 'aborted' | 'timeout' | 'http' | 'network' | 'empty'
   * 除 'aborted' 外，失败都会开启冷却，避免后续每条回复重复请求已不可用的服务。
   */
  async function synthesize(text, opts) {
    var o = opts || {};
    var raw = typeof text === 'string' ? text : '';
    var maxChars = ttsCfg().maxChars || 1200;
    var body = raw.length > maxChars ? raw.slice(0, maxChars) : raw;
    if (!body.trim()) return { ok: false, reason: 'empty' };

    var left = cooldownLeftMs();
    if (left > 0) return { ok: false, reason: 'cooldown', retryAfterMs: left };

    var controller = new AbortController();
    var timedOut = false;
    var timeoutMs = ttsCfg().timeoutMs || 25000;
    var timer = setTimeout(function () { timedOut = true; try { controller.abort(); } catch (e) {} }, timeoutMs);
    var caller = o.signal;
    var onCallerAbort = function () { try { controller.abort(); } catch (e) {} };
    if (caller) {
      if (caller.aborted) { clearTimeout(timer); return { ok: false, reason: 'aborted' }; }
      caller.addEventListener('abort', onCallerAbort);
    }

    try {
      var res = await fetch(ttsCfg().endpoint, {
        method: ttsCfg().method || 'POST',
        headers: ttsCfg().headers || { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: body }),
        signal: controller.signal
      });
      if (!res.ok) {
        startCooldown();
        return { ok: false, reason: 'http', detail: res.status };
      }
      var blob = await res.blob();
      if (!blob || !blob.size) {
        startCooldown();
        return { ok: false, reason: 'empty' };
      }
      var base64 = await blobToDataUrl(blob);
      clearCooldown();
      return { ok: true, blob: blob, base64: base64, mime: blob.type || 'audio/mpeg' };
    } catch (e) {
      if (caller && caller.aborted) return { ok: false, reason: 'aborted' };
      if (timedOut) {
        startCooldown();
        return { ok: false, reason: 'timeout' };
      }
      if (e && e.name === 'AbortError') return { ok: false, reason: 'aborted' };
      startCooldown();
      return { ok: false, reason: 'network', detail: e && e.message };
    } finally {
      clearTimeout(timer);
      if (caller) { try { caller.removeEventListener('abort', onCallerAbort); } catch (err) {} }
    }
  }

  /* ---------------- ASR（浏览器听写适配器） ---------------- */

  function asrCtor() {
    return root.SpeechRecognition || root.webkitSpeechRecognition || null;
  }

  function asrSupported() { return !!asrCtor(); }

  /**
   * 创建一个听写会话。
   * handlers: { onInterim(text), onFinal(text), onError(code), onEnd() }
   * 返回 { start(), stop(), abort(), active }
   */
  function createAsr(handlers) {
    var h = handlers || {};
    var Ctor = asrCtor();
    if (!Ctor) return null;
    var rec = new Ctor();
    var conf = asrCfg();
    rec.lang = conf.lang || 'zh-CN';
    rec.continuous = conf.continuous !== false;
    rec.interimResults = conf.interim !== false;
    var state = { active: false, stopped: false };

    rec.onresult = function (event) {
      var finalText = '';
      var interimText = '';
      for (var i = event.resultIndex; i < event.results.length; i++) {
        var r = event.results[i];
        if (!r) continue;
        var piece = r[0] && r[0].transcript ? r[0].transcript : '';
        if (r.isFinal) finalText += piece; else interimText += piece;
      }
      if (finalText && typeof h.onFinal === 'function') h.onFinal(finalText);
      if (typeof h.onInterim === 'function') h.onInterim(interimText);
    };
    rec.onerror = function (event) {
      state.active = false;
      var code = (event && event.error) || 'unknown';
      // 'aborted' 是我们主动停的，不当作失败
      if (code !== 'aborted' && typeof h.onError === 'function') h.onError(code);
    };
    rec.onend = function () {
      state.active = false;
      if (typeof h.onEnd === 'function') h.onEnd();
    };

    return {
      get active() { return state.active; },
      start: function () {
        if (state.active) return false;
        try { rec.start(); state.active = true; return true; }
        catch (e) { state.active = false; if (typeof h.onError === 'function') h.onError('start-failed'); return false; }
      },
      stop: function () {
        state.stopped = true;
        if (!state.active) return;
        try { rec.stop(); } catch (e) {}
        state.active = false;
      },
      abort: function () {
        state.stopped = true;
        try { rec.abort(); } catch (e) {}
        state.active = false;
      }
    };
  }

  function asrErrorText(code) {
    if (code === 'not-allowed' || code === 'service-not-allowed') return '麦克风权限被拒绝，录音不受影响，可以手动补文字。';
    if (code === 'audio-capture') return '麦克风被其他程序占用，听写没能启动，录音不受影响。';
    if (code === 'network') return '听写需要联网，这次没连上，录音已经保留。';
    if (code === 'no-speech') return '这次没听清，可以再说一遍，或手动补文字。';
    if (code === 'start-failed') return '听写启动失败，录音不受影响。';
    return '听写没能完成，录音已经保留，可以手动补文字。';
  }

  var API = {
    tts: {
      synthesize: synthesize,
      cooldownLeftMs: cooldownLeftMs,
      cooldownUntil: cooldownUntil,
      startCooldown: startCooldown,
      clearCooldown: clearCooldown,
      cooldownMessage: function () { return txt().ttsCooldown || '语音合成暂时不可用。'; }
    },
    asr: {
      supported: asrSupported,
      create: createAsr,
      errorText: asrErrorText
    },
    blobToDataUrl: blobToDataUrl
  };

  root.VoiceService = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
