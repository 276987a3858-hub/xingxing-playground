// shared/touch-bridge.js
// 触摸事件的前端接收层：把「设备/模拟事件」变成聊天页上的一条提示，
// 再决定要不要交给 app.js 的 StarTouch 去调用 AI。
// 边界：
// - 不碰 IndexedDB，不碰消息表，不碰聊天逻辑
// - 只负责：跨标签去重、提示条显示、可选的远端轮询
// - 轮询默认不启动，需要显式 startRemote() 或 localStorage 里配好 endpoint
(function (root) {
  'use strict';

  var SEEN_KEY = 'ylxh_touch_seen';       // 跨标签去重（同一个事件只处理一次）
  var ENDPOINT_KEY = 'ylxh_touch_endpoint';
  var TOKEN_KEY = 'ylxh_touch_token';     // 只读令牌：只能读事件，写不进事件
  var SEEN_MAX = 40;
  var POLL_INTERVAL = 1200;
  var POLL_MAX_BACKOFF = 8000;
  var HINT_MS = 6000;

  var ZONES = {
    head: '头顶', left_shoulder: '左肩', right_shoulder: '右肩',
    abs: '腹肌', back: '后背', hand: '手', waist: '腰'
  };

  var state = {
    mounted: false,
    endpoint: '',
    token: '',
    lastSeq: 0,
    fails: 0,
    timer: null,
    hideTimer: null,
    hintEl: null,
    lastEvent: null
  };

  function zoneText(z) {
    return ZONES[z] || '身上';
  }

  function readSeen() {
    try {
      var raw = localStorage.getItem(SEEN_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function rememberSeen(id) {
    try {
      var arr = readSeen();
      arr.push(id);
      if (arr.length > SEEN_MAX) arr = arr.slice(arr.length - SEEN_MAX);
      localStorage.setItem(SEEN_KEY, JSON.stringify(arr));
    } catch (e) { /* 隐私模式下写不了，退化成单标签去重 */ }
  }

  function alreadySeen(id) {
    return readSeen().indexOf(id) !== -1;
  }

  function ensureStyles() {
    if (document.getElementById('touchHintStyle')) return;
    var css = ''
      + '#touchHint{display:none;margin:0 16px 10px;padding:9px 14px;border-radius:12px;'
      + 'background:rgba(255,255,255,.72);border:1px solid rgba(185,190,225,.55);'
      + 'color:#5a6b8c;font-size:13px;line-height:1.5;transition:opacity .35s;}'
      + '#touchHint.on{display:block;}'
      + '#touchHint b{font-weight:600;color:#3a4a6a;}';
    var el = document.createElement('style');
    el.id = 'touchHintStyle';
    el.textContent = css;
    document.head.appendChild(el);
  }

  // 提示条插在输入框上方，不写库、不进聊天记录
  function ensureBar() {
    if (state.hintEl && document.body.contains(state.hintEl)) return state.hintEl;
    var composer = document.querySelector('#chat .composer');
    if (!composer || !composer.parentNode) return null;
    var el = document.getElementById('touchHint');
    if (!el) {
      el = document.createElement('div');
      el.id = 'touchHint';
      composer.parentNode.insertBefore(el, composer);
    }
    state.hintEl = el;
    return el;
  }

  // sticky=true：手指还按着，提示条常驻，等结束包再收尾
  function showHint(ev, sticky) {
    var el = ensureBar();
    if (!el) return;
    state.lastEvent = ev || null;
    var ms = Number(ev && ev.durMs) || 0;
    var sec = ms > 0 ? (Math.round(ms / 100) / 10) + 's' : '';
    el.innerHTML = '✦ ' + (ms > 0 ? '感觉到了 · ' : '正在感觉 · ') + '<b>' + zoneText(ev && ev.zone) + '</b>'
      + (sec ? ' <span style="opacity:.7">' + sec + '</span>' : '');
    el.classList.add('on');
    el.style.opacity = '1';
    if (state.hideTimer) { clearTimeout(state.hideTimer); state.hideTimer = null; }
    if (sticky) {
      // 持续触摸：不自动消失，但留 20 秒兜底，避免丢了结束包后一直挂着
      state.hideTimer = setTimeout(function () {
        el.style.opacity = '0';
        setTimeout(function () { if (el.style.opacity === '0') el.classList.remove('on'); }, 400);
      }, 20000);
      return;
    }
    state.hideTimer = setTimeout(function () {
      el.style.opacity = '0';
      setTimeout(function () { if (el.style.opacity === '0') el.classList.remove('on'); }, 400);
    }, HINT_MS);
  }

  // 没有 phase 字段时按协议推断：开始包 durMs=0，结束包 durMs>=1
  function eventPhase(ev) {
    var p = ev && ev.phase ? String(ev.phase) : '';
    if (p === 'start' || p === 'end') return p;
    return (Number(ev && ev.durMs) || 0) > 0 ? 'end' : 'start';
  }

  function updateStatus(text) {
    var el = document.getElementById('touchStatusText');
    if (el) el.textContent = text;
  }

  // 统一入口：一条事件只会走到这里一次。
  // 两阶段：start 只更新状态与提示条；end 才定稿并交给 app.js 决定是否请 AI。
  function onEvent(ev) {
    if (!ev) return;
    var id = String(ev.id || '');
    if (id && alreadySeen(id)) return;
    if (id) rememberSeen(id);

    var phase = eventPhase(ev);
    showHint(ev, phase === 'start');

    if (phase === 'start') {
      if (root.StarTouch && typeof root.StarTouch.begin === 'function') {
        try { root.StarTouch.begin(ev); } catch (e) { /* 状态显示失败不影响设备 */ }
      }
      return;   // 持续接触期间不触发 AI
    }

    if (root.StarTouch && typeof root.StarTouch.respond === 'function') {
      try {
        var p = root.StarTouch.respond(ev);
        if (p && typeof p.catch === 'function') p.catch(function () {});
      } catch (e) { /* 触摸失败不影响聊天 */ }
    }
  }

  function schedule(ms) {
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(poll, ms);
  }

  function poll() {
    if (!state.endpoint) return;
    if (document.visibilityState === 'hidden') { schedule(3000); return; }
    var sep = state.endpoint.indexOf('?') === -1 ? '?' : '&';
    var url = state.endpoint + sep + 'after=' + state.lastSeq;
    fetch(url, { cache: 'no-store', headers: { 'X-Read-Token': state.token } })
      .then(function (res) {
        if (res.status === 204) return null;
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        state.fails = 0;
        updateStatus('触摸设备：已连接');
        var list = [];
        if (data && Array.isArray(data.events)) list = data.events;
        else if (data && data.event) list = [data.event];
        list.sort(function (a, b) { return (Number(a.seq) || 0) - (Number(b.seq) || 0); });
        for (var i = 0; i < list.length; i++) {
          var ev = list[i];
          var seq = Number(ev && ev.seq) || 0;
          if (seq > state.lastSeq) state.lastSeq = seq;
          onEvent(ev);
        }
        schedule(POLL_INTERVAL);
      })
      .catch(function () {
        state.fails += 1;
        if (state.fails === 1) updateStatus('触摸设备：连接不上，稍后重试');
        schedule(Math.min(POLL_MAX_BACKOFF, POLL_INTERVAL * (state.fails + 1)));
      });
  }

  function startRemote(endpoint, token) {
    var url = String(endpoint || '').trim();
    if (!url) return false;
    state.endpoint = url;
    state.token = String(token == null ? state.token : token);
    if (!state.timer) schedule(POLL_INTERVAL);
    updateStatus('触摸设备：正在连接…');
    return true;
  }

  function stopRemote() {
    state.endpoint = '';
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    updateStatus('触摸设备：未连接');
  }

  // 设置页的两个输入框：地址 + 只读令牌，全部只存在本机 localStorage
  function fillLinkInputs() {
    var ep = document.getElementById('touchEndpoint');
    var tk = document.getElementById('touchToken');
    try {
      if (ep) ep.value = localStorage.getItem(ENDPOINT_KEY) || '';
      if (tk) tk.value = localStorage.getItem(TOKEN_KEY) || '';
    } catch (e) {}
  }

  function saveLink(disconnect) {
    var epEl = document.getElementById('touchEndpoint');
    var tkEl = document.getElementById('touchToken');
    var ep = epEl ? String(epEl.value || '').trim() : '';
    var tk = tkEl ? String(tkEl.value || '').trim() : '';
    try {
      if (disconnect) {
        localStorage.removeItem(ENDPOINT_KEY);
        stopRemote();
        return 'disconnected';
      }
      localStorage.setItem(ENDPOINT_KEY, ep);
      localStorage.setItem(TOKEN_KEY, tk);
    } catch (e) { return 'storage-error'; }
    if (!ep) { stopRemote(); return 'empty'; }
    if (!tk) { stopRemote(); return 'no-token'; }
    startRemote(ep, tk);
    return 'started';
  }

  function mount() {
    if (state.mounted) return;
    state.mounted = true;
    ensureStyles();
    // 聊天页可能还没渲染完，等 DOM 就绪再插提示条
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', ensureBar, { once: true });
    } else {
      ensureBar();
    }
    var saved = '';
    var savedToken = '';
    try {
      saved = localStorage.getItem(ENDPOINT_KEY) || '';
      savedToken = localStorage.getItem(TOKEN_KEY) || '';
    } catch (e) {}
    fillLinkInputs();
    if (saved && savedToken) startRemote(saved, savedToken);
    else updateStatus('触摸设备：未连接');
  }

  root.saveTouchLink = function (disconnect) {
    var r = saveLink(disconnect);
    var msg = {
      started: '已开始接收触摸事件。',
      disconnected: '已断开触摸设备。',
      empty: '还没填地址，已断开。',
      'no-token': '缺少读取令牌，已断开。',
      'storage-error': '浏览器不让保存，换一个窗口再试。'
    }[r];
    if (msg && typeof root.toast === 'function') { try { root.toast(msg); } catch (e) {} }
    return r;
  };

  root.TouchBridge = {
    mount: mount,
    showHint: showHint,
    onEvent: onEvent,
    startRemote: startRemote,
    stopRemote: stopRemote,
    fillLinkInputs: fillLinkInputs,
    state: state
  };

  mount();
})(typeof globalThis !== 'undefined' ? globalThis : this);
