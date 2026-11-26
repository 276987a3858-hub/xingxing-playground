/* public/butler/drawer.js — 生活管家侧拉抽屉控制器
 * 普通脚本（非 module），挂在 window 上供房间/聊天页内联 onclick 调用。
 * 设计：
 *  - iframe 常驻单例，首次打开才加载 /butler/，之后只切 CSS，不销毁不重载；
 *  - 抽屉为 fixed 覆盖层，不参与房间 .page 切换，故不刷新、不丢聊天状态；
 *  - 打开时记录触发元素与页面滚动位置，关闭时恢复。
 */
(function () {
  'use strict';
  var overlay = null, frame = null, closeBtn = null;
  var loaded = false;
  var lastFocus = null;
  var lastScroll = 0;

  function init() {
    overlay = document.getElementById('butlerDrawer');
    if (!overlay) return false;
    frame = document.getElementById('butlerFrame');
    closeBtn = overlay.querySelector('.bl-drw-close');
    document.addEventListener('keydown', function (e) {
      if ((e.key === 'Escape' || e.key === 'Esc') && isOpen()) {
        e.preventDefault();
        closeButlerDrawer();
      }
    });
    return true;
  }

  function isOpen() {
    return !!(overlay && overlay.classList.contains('is-open'));
  }

  function onReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  function openButlerDrawer() {
    if (!overlay && !init()) return;
    var wasLoaded = loaded;   // 区分「首次加载」和「重新打开」，首次不额外派发
    // 首次打开加载业务页面；之后保留 iframe 实例，tab/表单/滚动状态不丢
    if (frame && !loaded) {
      // 抽屉内隐藏业务页自带的「回到房间」按钮：它只适用于独立页场景，
      // 在抽屉里点击会让 iframe 内部误导航。仅注入样式，不改动业务页任何文件。
      frame.addEventListener('load', function () {
        try {
          var doc = frame.contentDocument;
          if (!doc || doc.getElementById('bl-drw-embed-style')) return;
          var style = doc.createElement('style');
          style.id = 'bl-drw-embed-style';
          style.textContent = '.topbar{display:none!important}';
          (doc.head || doc.documentElement).appendChild(style);
        } catch (e) {}
      });
      frame.src = '/butler/';
      loaded = true;
    }
    lastFocus = document.activeElement;
    lastScroll = window.scrollY || window.pageYOffset || 0;
    overlay.classList.add('is-open');
    overlay.setAttribute('aria-hidden', 'false');
    // 重新打开已加载的抽屉：让内部复用现有 butler:change 监听重读数据（聊天侧写入在父窗口，事件传不进 iframe）
    if (wasLoaded && frame) {
      try {
        var win = frame.contentWindow;
        if (win) win.dispatchEvent(new win.CustomEvent('butler:change'));
      } catch (e) {}
    }
    document.body.style.overflow = 'hidden';
    if (closeBtn) setTimeout(function () { try { closeBtn.focus(); } catch (e) {} }, 60);
  }

  function closeButlerDrawer() {
    if (!overlay || !isOpen()) return;
    overlay.classList.remove('is-open');
    overlay.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    window.scrollTo(0, lastScroll);
    if (lastFocus && typeof lastFocus.focus === 'function') {
      try { lastFocus.focus(); } catch (e) {}
    }
  }

  window.openButlerDrawer = openButlerDrawer;
  window.closeButlerDrawer = closeButlerDrawer;
  window.butlerDrawerIsOpen = isOpen;

  onReady(init);
})();
