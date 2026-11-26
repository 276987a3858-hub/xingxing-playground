
const KEY = 'ylxh.playground.v1';

const defaults = {
  unlocked: ['lobby', 'planets', 'adventure'],
  finished: {},
};

function createDefaults() {
  return {
    unlocked: [...defaults.unlocked],
    finished: {},
  };
}

function loadData() {
  try {
    const raw = localStorage.getItem(KEY);

    if (!raw) return createDefaults();

    const saved = JSON.parse(raw);

    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
      return createDefaults();
    }

    return {
      unlocked: Array.isArray(saved.unlocked)
        ? [...new Set([
            'lobby',
            'adventure',
            ...saved.unlocked.filter(x => typeof x === 'string')
          ])]
        : createDefaults().unlocked,

      finished: saved.finished &&
        typeof saved.finished === 'object' &&
        !Array.isArray(saved.finished)
          ? saved.finished
          : {},
    };

  } catch (e) {
    console.warn('游乐场存档读取失败，已恢复默认数据', e);
    return createDefaults();
  }
}

export const store = {
  data: loadData(),

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch (e) {
      console.warn('游乐场存档保存失败', e);
    }
  },

  isUnlocked(id) {
    return this.data.unlocked.includes(id);
  },

  unlock(id) {
    if (!this.isUnlocked(id)) {
      this.data.unlocked.push(id);
      this.save();

      window.dispatchEvent(
        new CustomEvent('store:unlock', {
          detail: { id }
        })
      );
    }
  },

  finish(id, result = {}) {
    const previous = this.data.finished[id];

    this.data.finished[id] = {
      ...(previous && typeof previous === 'object' ? previous : {}),
      ...result,
      at: Date.now(),
    };

    this.save();
  },
};