// playground/radio-sleep.js
// 午夜电台 · 晚安哄睡歌单（纯本地抽取，不产生任何 API 消耗）
// 规则：每天从「用途=哄睡/两者都行」的本地音频里随机挑最多三首，当天组合与顺序固定保存；
//       刷新页面不重新抽，尽量避开最近三天的组合；不足三首就按实际数量，不重复凑数。

const KEY = 'ylxh.radio.sleepPlaylist';
const PICK_COUNT = 3;
const KEEP_DAYS = 30;
const AVOID_DAYS = 3;
const PLAYED_KEY = 'ylxh.radio.sleepPlayed';

function todayKey(d = new Date()) {
  const pad = v => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object' && parsed.days && typeof parsed.days === 'object') return parsed;
  } catch (e) { /* ignore */ }
  return { days: {} };
}

function save(data) {
  try {
    const keys = Object.keys(data.days).sort();
    while (keys.length > KEEP_DAYS) {
      delete data.days[keys.shift()];
    }
    localStorage.setItem(KEY, JSON.stringify(data));
    return true;
  } catch (e) {
    return false;
  }
}

function shuffle(list) {
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function signature(ids) {
  return ids.slice().sort().join('|');
}

export const radioSleep = {
  todayKey,

  /** 过去 N 天里已经用过的组合（用于避开近期重复） */
  recentSignatures(days = AVOID_DAYS) {
    const data = load();
    const out = new Set();
    const now = Date.now();
    Object.keys(data.days).forEach(date => {
      const ids = data.days[date];
      if (!Array.isArray(ids) || !ids.length) return;
      const t = new Date(date + 'T12:00:00').getTime();
      if (Number.isFinite(t) && now - t <= days * 86400000) out.add(signature(ids));
    });
    return out;
  },

  /**
   * 取某天的歌单（默认今天）。已保存则原样返回，不会重抽。
   * @param {Array<{id:string}>} clips 可用的本地音频
   * @param {string} [date]
   */
  getOrCreate(clips, date) {
    const dateKey = date || todayKey();
    const data = load();
    const saved = data.days[dateKey];
    const available = (clips || []).filter(c => c && typeof c.id === 'string');
    const byId = new Map(available.map(c => [c.id, c]));

    // 已保存：过滤掉后来被删除的音频，但不清空当天的记录
    if (Array.isArray(saved) && saved.length) {
      const kept = [];
      saved.forEach(id => { if (byId.has(id) && !kept.includes(id)) kept.push(id); });
      if (kept.length) return kept;
    }

    if (!available.length) return [];

    const avoid = this.recentSignatures();
    let picked = [];
    for (let attempt = 0; attempt < 8; attempt++) {
      picked = shuffle(available).slice(0, Math.min(PICK_COUNT, available.length)).map(c => c.id);
      if (!avoid.has(signature(picked))) break;
      picked = [];
    }
    if (!picked.length) {
      picked = shuffle(available).slice(0, Math.min(PICK_COUNT, available.length)).map(c => c.id);
    }

    data.days[dateKey] = picked;
    save(data);
    return picked;
  },

  /** 某天已保存的歌单（没有就返回空数组，不触发抽取） */
  get(date) {
    const data = load();
    const ids = data.days[date];
    return Array.isArray(ids) ? ids.slice() : [];
  },

  /** 有记录的日期，新的在前 */
  dates() {
    const data = load();
    return Object.keys(data.days)
      .filter(d => Array.isArray(data.days[d]) && data.days[d].length)
      .sort((a, b) => (a < b ? 1 : -1));
  },

  /** 记录某段音频真的播放过（只在播放器真正开始/播完时调用） */
  markPlayed(id) {
    if (typeof id !== 'string' || !id) return false;
    try {
      const raw = localStorage.getItem(PLAYED_KEY);
      const data = raw ? JSON.parse(raw) : {};
      const map = data && typeof data === 'object' ? data : {};
      map[id] = Date.now();
      localStorage.setItem(PLAYED_KEY, JSON.stringify(map));
      return true;
    } catch (e) {
      return false;
    }
  },

  playedAt(id) {
    try {
      const raw = localStorage.getItem(PLAYED_KEY);
      const map = raw ? JSON.parse(raw) : {};
      const n = Number(map && map[id]);
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch (e) {
      return 0;
    }
  },

  /** 仅供测试/重置：清掉某天记录 */
  clear(date) {
    const data = load();
    delete data.days[date || todayKey()];
    return save(data);
  },
};
