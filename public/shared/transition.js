
// public/shared/transition.js

(() => {
  const KEY = 'ylxh.transition';
  let transitioning = false;

  // 创建转场光幕
  function createOverlay() {
    let overlay = document.getElementById('doorTransition');

    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'doorTransition';

      Object.assign(overlay.style, {
        position: 'fixed',
        inset: '0',
        zIndex: '99999',
        pointerEvents: 'none',
        opacity: '0',
        background: `
          radial-gradient(
            circle at 50% 50%,
            rgba(245, 235, 255, .98) 0%,
            rgba(205, 175, 255, .88) 12%,
            rgba(135, 105, 210, .72) 30%,
            rgba(55, 43, 110, .94) 62%,
            #070b1a 100%
          )
        `,
        transition: 'opacity .65s ease'
      });

      document.documentElement.appendChild(overlay);
    }

    return overlay;
  }

  // 延迟工具
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  // 播放转场
  async function playDoorTransition(direction = 'forward') {
    const overlay = createOverlay();

    if (direction === 'backward') {
      overlay.style.transition = 'none';
      overlay.style.opacity = '1';

      document.documentElement.classList.remove('door-pending');

      requestAnimationFrame(() => {
        overlay.style.transition = 'opacity .8s ease';
        overlay.style.opacity = '0';
      });

      await wait(850);
      overlay.remove();

      return;
    }

    overlay.style.transition = 'none';
    overlay.style.opacity = '0';

    requestAnimationFrame(() => {
      overlay.style.transition = 'opacity .65s ease';
      overlay.style.opacity = '1';
    });

    await wait(700);
  }

  // 暴露给其他页面使用
  window.playDoorTransition = playDoorTransition;

  // 初始化页面转场事件
  function initializeTransitions() {
    // 检查是否从另一个页面经过转场进入
    const incoming = sessionStorage.getItem(KEY);

    if (incoming) {
      sessionStorage.removeItem(KEY);
      playDoorTransition('backward');
    }

    // 主站进入游乐场
    const enter = document.getElementById('enterPlayground');

    if (enter) {
      enter.addEventListener('click', async e => {
        e.preventDefault();

        if (transitioning) return;

        transitioning = true;
        sessionStorage.setItem(KEY, 'to-playground');

        await playDoorTransition('forward');

        location.href = '/playground/';
      });
    }

    // 游乐场返回主站
    const back = document.getElementById('backToRoom');

    if (back) {
      back.addEventListener('click', async () => {
        if (transitioning) return;

        transitioning = true;
        sessionStorage.setItem(KEY, 'to-home');

        await playDoorTransition('forward');

        location.href = '/';
      });
    }
  }

  // 兼容不同的脚本加载时机
  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      initializeTransitions,
      { once: true }
    );
  } else {
    initializeTransitions();
  }
})();