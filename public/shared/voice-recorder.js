/* public/shared/voice-recorder.js — 聊天语音消息的录制面板（控制器）
 * 只负责「录 / 停 / 试听 / 重录 / 取消 / 交给发送」，不碰消息结构、不碰 AI、不碰备份。
 *
 * 与听写的关系：录音开始后并行启动浏览器听写（VoiceService.asr）。
 * 两者同时工作在不同浏览器上并不稳定（有的机型听写会抢占麦克风），所以：
 *   - 先启动录音，确认拿到音频流，再启动听写；
 *   - 听写任何异常只降级为「手动补文字」，绝不打断录音；
 *   - 听写在静音后会自动结束，录音期间自动续接，次数有上限。
 *
 * 挂载：window.VoiceRecorder
 */
(function (root) {
  'use strict';

  function cfg() { return root.VoiceConfig || {}; }
  function recCfg() { return cfg().recorder || {}; }
  function txt() { return cfg().text || {}; }

  var el = {};
  var state = {
    open: false,
    phase: 'idle',        // idle | starting | recording | stopping | ready | saving
    stream: null,
    recorder: null,
    chunks: [],
    mime: '',
    startedAt: 0,
    stoppedAt: 0,
    timer: null,
    durationMs: 0,
    blob: null,
    previewUrl: '',
    previewAudio: null,
    previewing: false,
    asr: null,
    asrSupported: false,
    asrFailed: false,
    asrRestarts: 0,
    asrFinal: '',
    asrInterim: '',
    autoStopTimer: null
  };

  /* ---------------- DOM ---------------- */

  function $(id) { return document.getElementById(id); }

  function cacheEl() {
    el.panel = $('voicePanel');
    el.recBtn = $('vpRecBtn');
    el.time = $('vpTime');
    el.hint = $('vpHint');
    el.playBtn = $('vpPlayBtn');
    el.transcript = $('vpTranscript');
    el.asrState = $('vpAsrState');
    el.sendBtn = $('vpSendBtn');
    el.redoBtn = $('vpRedoBtn');
    el.dictBtn = $('vpDictBtn');
    el.meter = $('vpMeter');
    return !!el.panel;
  }

  function fmt(ms) {
    var total = Math.max(0, Math.round((ms || 0) / 1000));
    var m = Math.floor(total / 60);
    var s = total % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  function hint(text, kind) {
    if (!el.hint) return;
    el.hint.textContent = text || '';
    el.hint.dataset.kind = kind || '';
  }

  function setAsrState(text, kind) {
    if (!el.asrState) return;
    el.asrState.textContent = text || '';
    el.asrState.dataset.kind = kind || '';
  }

  function render() {
    if (!el.panel) return;
    var phase = state.phase;
    el.panel.dataset.phase = phase;
    if (el.recBtn) {
      el.recBtn.disabled = (phase === 'starting' || phase === 'stopping' || phase === 'saving');
      el.recBtn.textContent = phase === 'recording' ? '■ 结束' : (phase === 'ready' ? '● 重录' : '● 录音');
      el.recBtn.classList.toggle('is-recording', phase === 'recording');
    }
    if (el.playBtn) {
      el.playBtn.hidden = phase !== 'ready' || !state.blob;
      el.playBtn.textContent = state.previewing ? '⏸ 暂停' : '▶ 试听';
    }
    if (el.sendBtn) el.sendBtn.disabled = (phase !== 'ready' || !state.blob);
    if (el.redoBtn) el.redoBtn.disabled = (phase === 'saving' || !state.blob && phase !== 'ready');
    if (el.dictBtn) el.dictBtn.disabled = (phase === 'saving');
    if (el.time) el.time.textContent = fmt(state.durationMs || (state.phase === 'recording' ? Date.now() - state.startedAt : 0));
    if (el.meter) el.meter.style.display = phase === 'recording' ? 'block' : 'none';
  }

  /* ---------------- 录音 ---------------- */

  function pickMime() {
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
    var list = recCfg().mimeCandidates || [];
    for (var i = 0; i < list.length; i++) {
      try { if (MediaRecorder.isTypeSupported(list[i])) return list[i]; } catch (e) {}
    }
    return '';
  }

  function releaseStream() {
    if (state.stream) {
      try { state.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
      state.stream = null;
    }
  }

  function stopTimer() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
  }

  function clearPreview() {
    if (state.previewAudio) {
      try { state.previewAudio.pause(); } catch (e) {}
      state.previewAudio.onended = null;
      state.previewAudio = null;
    }
    state.previewing = false;
    if (state.previewUrl) {
      try { URL.revokeObjectURL(state.previewUrl); } catch (e) {}
      state.previewUrl = '';
    }
  }

  function resetClip() {
    clearPreview();
    state.blob = null;
    state.durationMs = 0;
    state.stoppedAt = 0;
    state.chunks = [];
    if (el.transcript) el.transcript.value = '';
    state.asrFinal = '';
    state.asrInterim = '';
  }

  function tick() {
    if (el.time) el.time.textContent = fmt(Date.now() - state.startedAt);
  }

  async function startRecording() {
    if (state.phase === 'starting' || state.phase === 'recording') return;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      hint('当前环境不能录音（需要 https 或 localhost）。可以点下面的「听写」，或直接打字。', 'warn');
      return;
    }
    if (typeof MediaRecorder === 'undefined') {
      hint('当前浏览器不支持录音，可以点「听写」把话说成文字。', 'warn');
      return;
    }

    clearPreview();
    state.blob = null;
    state.durationMs = 0;
    state.chunks = [];
    state.asrFailed = false;
    state.asrRestarts = 0;
    state.asrFinal = '';
    state.phase = 'starting';
    hint('正在打开麦克风…');
    render();

    var stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
    } catch (e) {
      state.phase = state.blob ? 'ready' : 'idle';
      hint(micErrorText(e), 'warn');
      render();
      return;
    }
    state.stream = stream;

    var mime = pickMime();
    var recorder;
    try {
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch (e) {
      try { recorder = new MediaRecorder(stream); mime = ''; }
      catch (e2) {
        releaseStream();
        state.phase = 'idle';
        hint('录音启动失败：' + (e2 && e2.message ? e2.message : '未知原因'), 'warn');
        render();
        return;
      }
    }

    state.recorder = recorder;
    state.mime = recorder.mimeType || mime || '';
    state.chunks = [];

    recorder.ondataavailable = function (ev) {
      if (ev && ev.data && ev.data.size) state.chunks.push(ev.data);
    };
    recorder.onerror = function (ev) {
      hint('录音出错：' + ((ev && ev.error && ev.error.name) || '未知原因'), 'warn');
    };
    recorder.onstop = function () { finalize(); };

    try {
      recorder.start(recCfg().timesliceMs || 1000);
    } catch (e) {
      releaseStream();
      state.phase = 'idle';
      hint('录音没能开始：' + (e && e.message ? e.message : '未知原因'), 'warn');
      render();
      return;
    }

    state.startedAt = Date.now();
    state.phase = 'recording';
    hint('正在录音，说完点「结束」。');
    render();
    stopTimer();
    state.timer = setInterval(tick, 200);

    var maxMs = recCfg().maxMs || 120000;
    if (state.autoStopTimer) clearTimeout(state.autoStopTimer);
    state.autoStopTimer = setTimeout(function () {
      if (state.phase === 'recording') {
        hint('到了单条上限（' + fmt(maxMs) + '），已自动停下。');
        stopRecording();
      }
    }, maxMs);

    // 录音已经在跑，再开听写：听写失败只降级，不影响录音
    setTimeout(function () {
      if (state.phase === 'recording') startAsr();
    }, 260);
  }

  function micErrorText(e) {
    var name = e && e.name ? e.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') return '麦克风权限被拒绝，允许后可以再试；也可以直接打字。';
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return '没有找到麦克风设备。';
    if (name === 'NotReadableError' || name === 'TrackStartError') return '麦克风被其他程序占用，关掉占用它的程序再试。';
    return '没能打开麦克风：' + (e && e.message ? e.message : '未知原因');
  }

  async function stopRecording() {
    if (state.phase !== 'recording') return;
    state.phase = 'stopping';
    state.stoppedAt = Date.now();
    stopTimer();
    if (state.autoStopTimer) { clearTimeout(state.autoStopTimer); state.autoStopTimer = null; }
    // 先停听写：避免它继续占用麦克风影响录音的最后一帧
    stopAsr();
    render();
    try { state.recorder.stop(); } catch (e) { finalize(); }
  }

  function finalize() {
    stopTimer();
    releaseStream();
    state.recorder = null;

    var blob = new Blob(state.chunks, { type: state.mime || 'audio/webm' });
    state.chunks = [];

    if (!blob.size) {
      state.phase = 'idle';
      hint('这段没录到声音，再试一次？', 'warn');
      render();
      return;
    }
    if (blob.size > (recCfg().maxBytes || 8 * 1024 * 1024)) {
      state.phase = 'idle';
      hint('这段音频太大了，录短一点再发。', 'warn');
      render();
      return;
    }

    state.blob = blob;
    state.durationMs = Math.max(0, state.stoppedAt ? state.stoppedAt - state.startedAt : 0);
    state.phase = 'ready';
    hint('可以试听，或直接发送。');
    render();

    // 用真实音频时长校正（部分浏览器 MediaRecorder 首帧有延迟）
    probeDuration(blob).then(function (d) {
      if (!d || !state.blob) return;
      state.durationMs = Math.round(d * 1000);
      render();
    }).catch(function () {});

    // 录音结束：把听写里还没落定的临时结果并入正文
    flushInterim();
  }

  function probeDuration(blob) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(blob);
      var audio = new Audio();
      var done = false;
      var finish = function (v) {
        if (done) return;
        done = true;
        audio.onloadedmetadata = null;
        audio.onerror = null;
        URL.revokeObjectURL(url);
        resolve(v);
      };
      audio.onloadedmetadata = function () { finish(isFinite(audio.duration) ? audio.duration : 0); };
      audio.onerror = function () { finish(0); };
      audio.preload = 'metadata';
      audio.src = url;
      setTimeout(function () { finish(0); }, 3000);
    });
  }

  /* ---------------- 听写 ---------------- */

  function flushInterim() {
    if (state.asrInterim && el.transcript) {
      appendTranscript(state.asrInterim);
      state.asrInterim = '';
    }
  }

  function appendTranscript(text) {
    if (!el.transcript || !text) return;
    var cur = el.transcript.value;
    var joiner = cur && !/[\s。，、！？]$/.test(cur) ? ' ' : '';
    el.transcript.value = (cur + joiner + text).replace(/^\s+/, '');
  }

  function startAsr() {
    var svc = root.VoiceService;
    if (!svc || !svc.asr) { setAsrState('听写模块没加载，可以手动补文字', 'warn'); return; }
    state.asrSupported = svc.asr.supported();
    if (!state.asrSupported) {
      state.asrFailed = true;
      setAsrState(txt().noAsr || '这个浏览器不支持听写', 'warn');
      return;
    }
    stopAsr();
    setAsrState('正在同时听写…', 'live');
    var session = svc.asr.create({
      onInterim: function (t) {
        state.asrInterim = t || '';
        if (el.asrState && t) el.asrState.textContent = '正在听写：' + t;
      },
      onFinal: function (t) {
        state.asrInterim = '';
        state.asrFinal += t;
        appendTranscript(t);
        setAsrState('听写中…', 'live');
      },
      onError: function (code) {
        state.asrFailed = true;
        setAsrState(svc.asr.errorText(code), 'warn');
        if (code === 'not-allowed' || code === 'service-not-allowed' || code === 'audio-capture') {
          state.asrBlocked = true;
        }
      },
      onEnd: function () {
        if (state.phase !== 'recording') { setAsrState(el.transcript && el.transcript.value ? '听写结束，可以修改文字' : '听写结束', ''); return; }
        if (state.asrBlocked) return;
        var max = (cfg().asr && cfg().asr.maxRestarts) || 24;
        if (state.asrRestarts >= max) { setAsrState('听写已停止，录音继续', 'warn'); return; }
        state.asrRestarts += 1;
        setTimeout(function () {
          if (state.phase !== 'recording' || !state.asr) return;
          if (state.asr.active) return;
          state.asr.start();
        }, 220);
      }
    });
    if (!session) {
      state.asrFailed = true;
      setAsrState(txt().noAsr || '这个浏览器不支持听写', 'warn');
      return;
    }
    state.asr = session;
    if (!session.start()) {
      state.asrFailed = true;
      setAsrState('听写没能启动，录音继续', 'warn');
    }
  }

  function stopAsr() {
    if (state.asr) {
      try { state.asr.stop(); } catch (e) {}
      state.asr = null;
    }
  }

  /* ---------------- 试听 ---------------- */

  function togglePreview() {
    if (!state.blob) return;
    if (state.previewing && state.previewAudio) {
      try { state.previewAudio.pause(); } catch (e) {}
      state.previewing = false;
      render();
      return;
    }
    clearPreview();
    state.previewUrl = URL.createObjectURL(state.blob);
    var audio = new Audio(state.previewUrl);
    state.previewAudio = audio;
    audio.onended = function () { state.previewing = false; render(); };
    audio.onerror = function () {
      state.previewing = false;
      hint('试听失败，可以直接发送或重录。', 'warn');
      render();
    };
    state.previewing = true;
    render();
    audio.play().catch(function () {
      state.previewing = false;
      hint('浏览器拦住了自动播放，点一下「试听」再试。', 'warn');
      render();
    });
  }

  /* ---------------- 面板开关 ---------------- */

  function open() {
    if (!el.panel && !cacheEl()) { if (typeof toast === 'function') toast('语音面板没加载，请刷新页面。'); return; }
    if (state.open && state.phase === 'recording') return;   // 已在录音，重复点击不打断
    state.open = true;
    el.panel.hidden = false;
    el.panel.classList.add('is-open');
    if (state.phase === 'idle' || !state.blob) {
      resetClip();
      state.phase = 'idle';
      state.asrFailed = false;
      state.asrBlocked = false;
      setAsrState('录音时会在本机同时听写；不支持时也可以手动补文字', '');
      hint('点「录音」开始，最长 ' + fmt(recCfg().maxMs || 120000) + '。');
    }
    render();
    if (typeof stopCurrentSpeech === 'function') { try { stopCurrentSpeech(); } catch (e) {} }
  }

  function close() {
    state.open = false;
    stopAsr();
    if (state.phase === 'recording' || state.phase === 'starting') {
      state.phase = 'stopping';
      try { if (state.recorder) state.recorder.stop(); } catch (e) {}
    }
    stopTimer();
    if (state.autoStopTimer) { clearTimeout(state.autoStopTimer); state.autoStopTimer = null; }
    releaseStream();
    clearPreview();
    state.recorder = null;
    state.blob = null;
    state.chunks = [];
    state.phase = 'idle';
    state.durationMs = 0;
    state.asr = null;
    state.asrFinal = '';
    state.asrInterim = '';
    if (el.panel) {
      el.panel.classList.remove('is-open');
      el.panel.hidden = true;
    }
    if (el.transcript) el.transcript.value = '';
  }

  /* ---------------- 发送 ---------------- */

  function currentStatus(text) {
    if (!state.asrSupported) return 'unsupported';
    if (text) return 'ok';
    if (state.asrFailed) return 'error';
    return 'empty';
  }

  async function send() {
    if (state.phase === 'saving') return;
    if (state.phase === 'recording') { hint('先点「结束」，再发送。'); return; }
    if (!state.blob) { hint('还没有录到音频，先录一段。', 'warn'); return; }
    if (typeof root.sendVoiceMessage !== 'function') { hint('发送通道没准备好，请刷新页面。', 'warn'); return; }

    flushInterim();
    var text = el.transcript ? el.transcript.value.trim() : '';
    var payload = {
      blob: state.blob,
      mime: state.blob.type || state.mime || 'audio/webm',
      durationMs: Math.max(0, Math.round(state.durationMs || 0)),
      transcript: text,
      asrStatus: currentStatus(text)
    };

    state.phase = 'saving';
    render();
    hint('正在保存语音…');
    try {
      var ok = await root.sendVoiceMessage(payload);
      if (ok === false) {
        state.phase = 'ready';
        hint('这条没能发出去，录音还在，可以再试一次。', 'warn');
        render();
        return;
      }
      close();
    } catch (e) {
      state.phase = 'ready';
      hint('发送失败：' + (e && e.message ? e.message : '未知原因'), 'warn');
      render();
    }
  }

  function redo() {
    if (state.phase === 'saving') return;
    stopAsr();
    clearPreview();
    state.blob = null;
    state.durationMs = 0;
    state.phase = 'idle';
    state.asrFailed = false;
    state.asrBlocked = false;
    state.asrRestarts = 0;
    state.asrFinal = '';
    state.asrInterim = '';
    if (el.transcript) el.transcript.value = '';
    setAsrState('录音时会在本机同时听写；不支持时也可以手动补文字', '');
    hint('点「录音」重新开始。');
    render();
  }

  function cancel() { close(); }

  /** 次要入口：只用听写（不录音），结果写进转写框，避免占用原有文字输入框。 */
  function dictate() {
    if (state.phase === 'recording') { hint('正在录音，听写已经在跑了。'); return; }
    var svc = root.VoiceService;
    if (!svc || !svc.asr) { setAsrState('听写模块没加载', 'warn'); return; }
    if (!svc.asr.supported()) { state.asrSupported = false; setAsrState(txt().noAsr || '这个浏览器不支持听写', 'warn'); return; }
    state.asrSupported = true;
    stopAsr();
    setAsrState('听写中，说完可以再点一次结束…', 'live');
    var session = svc.asr.create({
      onInterim: function (t) { if (t) setAsrState('正在听写：' + t, 'live'); },
      onFinal: function (t) { appendTranscript(t); setAsrState('听写中…', 'live'); },
      onError: function (code) { setAsrState(svc.asr.errorText(code), 'warn'); },
      onEnd: function () { setAsrState(el.transcript && el.transcript.value ? '听写结束，可以修改文字' : '听写结束', ''); }
    });
    if (!session || !session.start()) { setAsrState('听写没能启动', 'warn'); return; }
    state.asr = session;
  }

  function toggle() {
    if (state.phase === 'recording') return stopRecording();
    return startRecording();
  }

  var API = {
    open: open,
    close: close,
    start: startRecording,
    stop: stopRecording,
    toggle: toggle,
    preview: togglePreview,
    redo: redo,
    cancel: cancel,
    send: send,
    dictate: dictate,
    get phase() { return state.phase; },
    hasClip: function () { return !!state.blob; }
  };

  root.VoiceRecorder = API;
  root.openVoiceRecorder = function () {
    if (!el.panel && !cacheEl()) return;
    open();
  };
  root.closeVoiceRecorder = close;

  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('DOMContentLoaded', function () {
      if (cacheEl()) {
        el.panel.hidden = true;
        render();
      }
    });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
