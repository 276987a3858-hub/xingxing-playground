(function () {
  const DEFAULT = 'lobby';
  function current() {
    const raw = location.hash.replace(/^#\/?/, '');
    return raw.split('?')[0] || DEFAULT;
  }
  function go(scene, query) {
    if (!scene) return;
    let hash = '#/' + scene;
    if (query) {
      const qs = new URLSearchParams(query).toString();
      if (qs) hash += '?' + qs;
    }
    if (location.hash === hash) {
      window.dispatchEvent(new Event('hashchange'));
    } else {
      location.hash = hash;
    }
  }
  window.PlaygroundRouter = { go, current };
  window.addEventListener('hashchange', () => {
    window.dispatchEvent(new CustomEvent('scene:change', { detail: { scene: current() } }));
  });
  window.addEventListener('DOMContentLoaded', () => {
    window.dispatchEvent(new CustomEvent('scene:change', { detail: { scene: current() } }));
  });
})();