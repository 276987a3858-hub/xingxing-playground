/* public/shared/voice-bubble.js — 聊天里的语音消息气泡
 * 只认消息里的 audioClipId（音频引用），不认识任何语音服务商；
 * 播放靠 VoiceStore 取回原始 Blob → objectURL，因此换 TTS/ASR 服务都不影响历史语音。
 *
 * 关键点（也是这类气泡最容易做坏的地方）：
 *  - renderMessages() 会整表重绘，气泡 DOM 每次都是新的，所以 objectURL 与 <audio> 必须缓存在模块里，
 *    重绘时只重新绑定元素，播放不中断、也不会每次都新建 URL 造成泄漏；
 *  - 同一时刻只播一条：播放语音会先停掉 AI 朗读，反之亦然。
 *
 * 挂载：window.VoiceBubble
 */
(function (root) {
  'use strict';

  var URL_CACHE_MAX = 30;
  var urlCache = new Map();     // clipId -> { url, durationMs }
  var loading = new Map();      // clipId -> Promise
  var current = null;           // { clipId, audio, els }
  // 转写是否展开：renderMessages 会整表重绘，展开状态必须记在模块里，否则一刷新就收起
  var expanded = new Set();

  function fmt(ms) {
    var total = Math.max(0, Math.round((ms || 0) / 1000));
    var m = Math.floor(total / 60);
    var s = total % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function evict() {
    while (urlCache.size > URL_CACHE_MAX) {
      var firstKey = urlCache.keys().next().value;
      if (current && current.clipId === firstKey) break;
      var entry = urlCache.get(firstKey);
      urlCache.delete(firstKey);
      if (entry && entry.url) { try { URL.revokeObjectURL(entry.url); } catch (e) {} }
    }
  }

  function ensureUrl(clipId) {
    if (urlCache.has(clipId)) return Promise.resolve(urlCache.get(clipId));
    if (loading.has(clipId)) return loading.get(clipId);
    var store = root.VoiceStore;
    if (!store || typeof store.getBlob !== 'function') return Promise.resolve(null);
    var p = store.getBlob(clipId).then(function (blob) {
      if (!blob) return null;
      var entry = { url: URL.createObjectURL(blob), durationMs: 0 };
      urlCache.set(clipId, entry);
      evict();
      return entry;
    }).catch(function () { return null; }).then(function (v) {
      loading.delete(clipId);
      return v;
    });
    loading.set(clipId, p);
    return p;
  }

  function syncUi() {
    if (!current || !current.els) return;
    var els = current.els;
    var audio = current.audio;
    var dur = isFinite(audio.duration) && audio.duration > 0 ? audio.duration * 1000 : (els.durationMs || 0);
    var pos = (audio.currentTime || 0) * 1000;
    if (els.time) els.time.textContent = pos > 300 ? fmt(pos) + ' / ' + fmt(dur) : fmt(dur);
    if (els.fill) els.fill.style.width = dur > 0 ? Math.min(100, (pos / dur) * 100) + '%' : '0%';
    if (els.btn) {
      var playing = !audio.paused && !audio.ended;
      els.btn.textContent = playing ? '⏸' : '▶';
      els.btn.setAttribute('aria-label', playing ? '暂停语音' : '播放语音');
      els.btn.classList.toggle('is-playing', playing);
    }
  }

  function stopCurrent() {
    if (!current) return;
    try { current.audio.pause(); } catch (e) {}
    try { current.audio.currentTime = 0; } catch (e) {}
    syncUi();
  }

  function playClip(clipId, els) {
    if (!clipId) return;
    if (current && current.clipId === clipId) {
      var audio0 = current.audio;
      if (audio0.paused || audio0.ended) {
        current.els = els;
        audio0.play().catch(function () { syncUi(); });
      } else {
        audio0.pause();
      }
      return;
    }
    stopCurrent();
    if (typeof root.stopCurrentSpeech === 'function') { try { root.stopCurrentSpeech(); } catch (e) {} }
    if (typeof root.stopTouchAudio === 'function') { try { root.stopTouchAudio(); } catch (e) {} }

    ensureUrl(clipId).then(function (entry) {
      if (!entry) { els.btn.disabled = true; els.time.textContent = '音频缺失'; return; }
      var audio = new Audio(entry.url);
      audio.preload = 'metadata';
      current = { clipId: clipId, audio: audio, els: els };
      audio.onloadedmetadata = function () {
        if (isFinite(audio.duration) && audio.duration > 0) {
          entry.durationMs = Math.round(audio.duration * 1000);
          els.durationMs = entry.durationMs;
        }
        syncUi();
      };
      audio.ontimeupdate = syncUi;
      audio.onplay = syncUi;
      audio.onpause = syncUi;
      audio.onended = function () { try { audio.currentTime = 0; } catch (e) {} syncUi(); };
      audio.onerror = function () {
        els.btn.disabled = true;
        els.time.textContent = '无法播放';
      };
      syncUi();
      audio.play().catch(function () {
        // 自动播放策略：保持在「▶」态，让用户再点一次
        syncUi();
      });
    });
  }

  function seekTo(els, ratio) {
    if (!current || !current.audio || current.clipId !== els.clipId) return;
    var audio = current.audio;
    if (!isFinite(audio.duration) || audio.duration <= 0) return;
    audio.currentTime = Math.min(audio.duration, Math.max(0, ratio * audio.duration));
    syncUi();
  }

  /**
   * 渲染一条语音消息到气泡里。
   * opts: { keyword } 用于搜索高亮
   */
  function render(bubble, m, opts) {
    var o = opts || {};
    var clipId = m && m.audioClipId;
    bubble.classList.add('voice-bubble');
    if (m && m.role === 'user') bubble.classList.add('voice-bubble--user');

    var wrap = el('div', 'vb-wrap');
    var btn = el('button', 'vb-play', '▶');
    btn.type = 'button';
    btn.setAttribute('aria-label', '播放语音');

    var track = el('div', 'vb-track');
    track.setAttribute('role', 'slider');
    track.setAttribute('aria-label', '播放进度');
    var fill = el('i', 'vb-fill');
    track.appendChild(fill);

    var durMs = typeof m.durationMs === 'number' ? m.durationMs : 0;
    var time = el('span', 'vb-time', fmt(durMs));

    wrap.appendChild(btn);
    wrap.appendChild(track);
    wrap.appendChild(time);

    var transcriptText = String(m && m.content != null ? m.content : '').trim();
    var toggle = el('button', 'vb-toggle', transcriptText ? '文字' : '文字');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');

    var text = el('div', 'vb-text');
    if (transcriptText) {
      text.textContent = transcriptText;
      if (o.keyword && typeof root.highlightKeyword === 'function') {
        try { root.highlightKeyword(text, o.keyword); } catch (e) {}
      }
    } else {
      text.className = 'vb-text vb-text--empty';
      text.textContent = m.asrStatus === 'unsupported'
        ? '（这个浏览器不支持听写，这条语音没有转成文字）'
        : '（这条语音还没转成文字）';
    }

    var els = { clipId: clipId, btn: btn, fill: fill, time: time, durationMs: durMs };

    btn.onclick = function (e) { e.stopPropagation(); playClip(clipId, els); };
    track.onclick = function (e) {
      e.stopPropagation();
      var rect = track.getBoundingClientRect();
      if (!rect.width) return;
      seekTo(els, (e.clientX - rect.left) / rect.width);
    };
    toggle.onclick = function (e) {
      e.stopPropagation();
      var open = bubble.classList.toggle('is-open');
      var key = clipId || ('msg:' + (m && m.id));
      if (open) expanded.add(key); else expanded.delete(key);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.textContent = open ? '收起' : '文字';
    };

    // 重绘前就展开过的，重绘后保持展开
    if (expanded.has(clipId || ('msg:' + (m && m.id)))) {
      bubble.classList.add('is-open');
      toggle.setAttribute('aria-expanded', 'true');
      toggle.textContent = '收起';
    }

    bubble.appendChild(wrap);
    bubble.appendChild(toggle);
    bubble.appendChild(text);

    if (!clipId) {
      btn.disabled = true;
      time.textContent = '音频缺失';
      bubble.classList.add('is-missing');
      return;
    }

    // 已知时长先用消息里的，取到 Blob 后再用真实时长校正
    ensureUrl(clipId).then(function (entry) {
      if (!entry) {
        btn.disabled = true;
        time.textContent = '音频缺失';
        bubble.classList.add('is-missing');
        return;
      }
      if (!durMs && entry.durationMs) { time.textContent = fmt(entry.durationMs); els.durationMs = entry.durationMs; }
      if (current && current.clipId === clipId) {
        current.els = els;
        syncUi();
      }
    });
  }

  root.VoiceBubble = {
    render: render,
    stop: stopCurrent,
    formatDuration: fmt,
    clearCache: function () {
      stopCurrent();
      urlCache.forEach(function (e) { if (e && e.url) { try { URL.revokeObjectURL(e.url); } catch (err) {} } });
      urlCache.clear();
      current = null;
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
