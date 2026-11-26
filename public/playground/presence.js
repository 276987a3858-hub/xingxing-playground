/* public/playground/presence.js — 游乐场侧的活跃记录转发（P0-b）
 *
 * 职责只有三件事，不含任何业务逻辑：
 *   1. 以 visit:false 挂载共享的 LifePresence（不参与房间访问判定）
 *   2. 把「真实用户操作」转发成 LifePresence.active('playground:lobby' | 'playground:game')
 *   3. 把 visibilitychange / pagehide 转发给 LifePresence
 *
 * 不做的事：不读写游戏状态、不调 AI、不新增时间记录机制、不监听全局无条件 click。
 * 各游戏文件无需任何修改：所有场景都挂在 #game-scene 容器内。
 */
(function () {
  'use strict';

  if (window.__yxPresenceBound) return; // 幂等：重复引入不会重复注册监听
  window.__yxPresenceBound = true;

  var LP = window.LifePresence;
  if (!LP) return; // 共享模块缺失时静默退出，不影响游乐场本身

  try { LP.boot({ visit: false }); } catch (e) {}

  // 纯导航类按键不算游戏操作
  var NAV_KEYS = {
    Tab: 1, Shift: 1, Control: 1, Alt: 1, Meta: 1, Escape: 1,
    ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1,
    PageUp: 1, PageDown: 1, Home: 1, End: 1,
  };

  function inGame(el) { return !!(el && el.closest && el.closest('#game-scene')); }
  function inLobby(el) { return !!(el && el.closest && el.closest('#lobby-scene')); }

  // 真实指针操作：只认大厅的游戏卡片，或游戏容器内部。
  // 大厅空白处、文字、滚动条不会命中；hover / 滚动 / 自动播放 / 动画都不产生 pointerdown。
  document.addEventListener('pointerdown', function (ev) {
    try {
      var t = ev.target;
      if (t && t.closest && t.closest('#lobby-scene .scene-card')) {
        LP.active('playground:lobby');
        return;
      }
      if (inGame(t)) LP.active('playground:game');
    } catch (e) {}
  }, true);

  // 键盘用户的真实操作（回车/空格/字母），排除纯导航按键
  document.addEventListener('keydown', function (ev) {
    try {
      if (!ev || NAV_KEYS[ev.key]) return;
      var t = ev.target;
      if (inGame(t)) { LP.active('playground:game'); return; }
      if (inLobby(t)) LP.active('playground:lobby');
    } catch (e) {}
  }, true);

  document.addEventListener('visibilitychange', function () {
    try { if (document.hidden) LP.hidden(); else LP.visible(); } catch (e) {}
  });

  // 返回房间时写入离开候选；房间页 boot 才会用它定案 lastLeaveAt
  window.addEventListener('pagehide', function (ev) {
    try { LP.leaving(ev && ev.persisted ? 'bfcache' : 'pagehide'); } catch (e) {}
  });
})();
