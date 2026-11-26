// playground/radio-store.js
// 午夜电台独立存档模块
// 使用独立 localStorage key，不修改 store.js 的数据结构

const EPISODES_KEY = 'ylxh.radio.episodes';
const PROGRESS_KEY = 'ylxh.radio.progress';
const MUSIC_KEY = 'ylxh.radio.music.meta';
const SLEEP_KEY = 'ylxh.radio.sleep';

// ---------- 数据校验 ----------

function isValidEpisode(ep) {
  if (!ep || typeof ep !== 'object') return false;
  if (typeof ep.id !== 'string' || !ep.id) return false;
  if (typeof ep.title !== 'string') return false;
  if (typeof ep.channel !== 'string') return false;
  if (typeof ep.content !== 'string') return false;
  return true;
}

function sanitizeEpisode(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const ep = {
    id: typeof raw.id === 'string' ? raw.id : '',
    title: typeof raw.title === 'string' ? raw.title : '',
    channel: typeof raw.channel === 'string' ? raw.channel : '',
    content: typeof raw.content === 'string' ? raw.content : '',
    type: raw.type === 'special' ? 'special' : 'basic',
    // 语言：仅显式标记为英文的节目才启用 ElevenLabs TTS；老节目无该字段时默认中文
    lang: raw.lang === 'en' ? 'en' : 'zh',
    status: ['pending', 'listening', 'completed'].includes(raw.status) ? raw.status : 'pending',
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    duration: typeof raw.duration === 'number' ? raw.duration : 0,
    playbackPosition: typeof raw.playbackPosition === 'number' ? raw.playbackPosition : 0,
    completedAt: typeof raw.completedAt === 'number' ? raw.completedAt : null,
    // ---- 本次新增字段：老节目缺省一律给安全默认值，不改动原有字段 ----
    // 英文广播来源：'conversation'=来自过去的聊天语音 / 'original'=星星原创
    source: (raw.source === 'conversation' || raw.source === 'original') ? raw.source : '',
    favorite: raw.favorite === true,                       // 特别喜欢（电台内部收藏）
    voiceStatus: ['ready', 'missing', 'failed'].includes(raw.voiceStatus) ? raw.voiceStatus : '',
    heardAt: typeof raw.heardAt === 'number' ? raw.heardAt : null,   // 语音实际听完的时间
    audioKey: typeof raw.audioKey === 'string' ? raw.audioKey : '',  // 语音缓存键
    externalId: typeof raw.externalId === 'string' ? raw.externalId : '', // 来源消息 id，用于去重
    // ---- 英文多段节目：节目 = 3~5 段原始聊天语音组成的时间线 ----
    program: raw.program === true,
    summary: typeof raw.summary === 'string' ? raw.summary.slice(0, 400) : '',
    cover: typeof raw.cover === 'string' ? raw.cover.slice(0, 8) : '',
    segments: Array.isArray(raw.segments)
      ? raw.segments
        .filter(s => s && typeof s === 'object' && s.messageId != null && String(s.en || '').trim())
        .slice(0, 8)
        .map(s => ({
          messageId: String(s.messageId),
          en: String(s.en || '').slice(0, 1200),
          zh: typeof s.zh === 'string' ? s.zh.slice(0, 400) : '',
          at: typeof s.at === 'number' ? s.at : 0,
        }))
      : [],
  };
  if (!ep.id) return null;
  return ep;
}

function sanitizeProgress(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const result = {};
  for (const key of Object.keys(raw)) {
    const p = raw[key];
    if (p && typeof p === 'object') {
      result[key] = {
        position: typeof p.position === 'number' ? p.position : 0,
        duration: typeof p.duration === 'number' ? p.duration : 0,
        completed: !!p.completed,
        updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : Date.now(),
      };
    }
  }
  return result;
}

function sanitizeMusicMeta(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(m => m && typeof m === 'object' && typeof m.id === 'string' && m.id)
    .map(m => ({
      id: m.id,
      favorite: !!m.favorite,
      lastPosition: typeof m.lastPosition === 'number' && m.lastPosition >= 0 ? m.lastPosition : 0,
      duration: typeof m.duration === 'number' && m.duration >= 0 ? m.duration : 0,
      updatedAt: typeof m.updatedAt === 'number' ? m.updatedAt : Date.now(),
    }));
}

// ---------- 安全读写 ----------

function safeGetJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch (e) {
    console.warn(`[radio-store] 读取 ${key} 失败，使用默认值`, e);
    return fallback;
  }
}

function safeSetJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.warn(`[radio-store] 保存 ${key} 失败`, e);
    return false;
  }
}

// ---------- 节目列表 CRUD ----------

function loadEpisodes() {
  const raw = safeGetJSON(EPISODES_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw
    .map(sanitizeEpisode)
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt);
}

function saveEpisodes(episodes) {
  if (!Array.isArray(episodes)) return false;
  const clean = episodes.filter(isValidEpisode).map(sanitizeEpisode).filter(Boolean);
  // 限制最大保存数量，避免 localStorage 溢出
  const MAX_EPISODES = 80;
  const trimmed = clean.slice(0, MAX_EPISODES);
  return safeSetJSON(EPISODES_KEY, trimmed);
}

function loadProgress() {
  return sanitizeProgress(safeGetJSON(PROGRESS_KEY, {}));
}

function saveProgress(progress) {
  if (!progress || typeof progress !== 'object') return false;
  return safeSetJSON(PROGRESS_KEY, sanitizeProgress(progress));
}

// ---------- 对外接口 ----------

export const radioStore = {
  _episodes: null,
  _progress: null,

  init() {
    if (this._episodes === null) this._episodes = loadEpisodes();
    if (this._progress === null) this._progress = loadProgress();
  },

  getAllEpisodes() {
    this.init();
    return [...this._episodes];
  },

  getEpisode(id) {
    this.init();
    return this._episodes.find(ep => ep.id === id) || null;
  },

  getPendingEpisodes() {
    this.init();
    return this._episodes.filter(ep => ep.status === 'pending');
  },

  getEpisodeByChannel(channel) {
    this.init();
    return this._episodes.filter(ep => ep.channel === channel);
  },

  addEpisode(ep) {
    this.init();
    const clean = sanitizeEpisode(ep);
    if (!clean) return false;
    // 去重：相同 id 不重复添加
    if (this._episodes.some(e => e.id === clean.id)) return false;
    this._episodes.unshift(clean);
    return saveEpisodes(this._episodes);
  },

  updateEpisode(id, patch) {
    this.init();
    const idx = this._episodes.findIndex(ep => ep.id === id);
    if (idx === -1) return false;
    this._episodes[idx] = sanitizeEpisode({ ...this._episodes[idx], ...patch });
    return saveEpisodes(this._episodes);
  },

  deleteEpisode(id) {
    this.init();
    this._episodes = this._episodes.filter(ep => ep.id !== id);
    // 同时清理进度
    if (this._progress[id]) {
      delete this._progress[id];
      saveProgress(this._progress);
    }
    return saveEpisodes(this._episodes);
  },

  setEpisodeStatus(id, status) {
    this.init();
    const valid = ['pending', 'listening', 'completed'];
    if (!valid.includes(status)) return false;
    const patch = { status };
    if (status === 'completed') {
      patch.completedAt = Date.now();
    }
    return this.updateEpisode(id, patch);
  },

  // ---------- 英文广播：语音状态与收听状态（与文字阅读状态分开记） ----------

  setVoiceStatus(id, voiceStatus, audioKey) {
    const patch = { voiceStatus };
    if (typeof audioKey === 'string') patch.audioKey = audioKey;
    return this.updateEpisode(id, patch);
  },

  // 只有真的把语音听完才写 heardAt；单纯读完文字不算
  markHeard(id) {
    return this.updateEpisode(id, { heardAt: Date.now() });
  },

  getEpisodeByExternalId(externalId) {
    this.init();
    if (!externalId) return null;
    return this._episodes.find(ep => ep.externalId === externalId) || null;
  },

  // ---------- 特别喜欢（不改变阅读/收听状态） ----------

  toggleFavorite(id) {
    this.init();
    const idx = this._episodes.findIndex(ep => ep.id === id);
    if (idx === -1) return false;
    const next = !this._episodes[idx].favorite;
    this._episodes[idx] = sanitizeEpisode({ ...this._episodes[idx], favorite: next });
    saveEpisodes(this._episodes);
    return next;
  },

  getFavorites() {
    this.init();
    return this._episodes.filter(ep => ep.favorite);
  },

  getPendingEpisodesByChannel(channel) {
    this.init();
    return this._episodes.filter(ep => ep.status !== 'completed' && (!channel || ep.channel === channel));
  },

  getCompletedEpisodes(channel) {
    this.init();
    return this._episodes.filter(ep => ep.status === 'completed' && (!channel || ep.channel === channel));
  },

  // ---------- 播放进度（预留接口，本轮不实现音频播放） ----------

  getProgress(id) {
    this.init();
    return this._progress[id] || null;
  },

  savePlaybackPosition(id, position, duration) {
    this.init();
    this._progress[id] = {
      position: typeof position === 'number' ? position : 0,
      duration: typeof duration === 'number' ? duration : 0,
      completed: position >= duration && duration > 0,
      updatedAt: Date.now(),
    };
    return saveProgress(this._progress);
  },

  clearProgress(id) {
    this.init();
    if (this._progress[id]) {
      delete this._progress[id];
      return saveProgress(this._progress);
    }
    return true;
  },

  // ---------- 音乐库元数据（收藏 + 播放进度） ----------

  getMusicMeta() {
    return sanitizeMusicMeta(safeGetJSON(MUSIC_KEY, []));
  },

  saveMusicMeta(meta) {
    if (!Array.isArray(meta)) return false;
    return safeSetJSON(MUSIC_KEY, sanitizeMusicMeta(meta));
  },

  // ---------- 全局睡眠定时（只存绝对到期时间，跨视图/跨刷新保持） ----------

  getSleepTimer() {
    const raw = safeGetJSON(SLEEP_KEY, null);
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.endAt !== 'number' || raw.endAt <= 0) return null;
    return {
      endAt: raw.endAt,
      minutes: [15, 30, 45, 60].includes(raw.minutes) ? raw.minutes : 15,
      setAt: typeof raw.setAt === 'number' ? raw.setAt : Date.now(),
    };
  },

  // minutes 传 15/30/45/60；endAt 为绝对毫秒时间戳
  setSleepTimer(minutes, endAt) {
    if (![15, 30, 45, 60].includes(minutes)) return false;
    if (typeof endAt !== 'number' || endAt <= 0) return false;
    return safeSetJSON(SLEEP_KEY, { minutes, endAt, setAt: Date.now() });
  },

  clearSleepTimer() {
    try {
      localStorage.removeItem(SLEEP_KEY);
      return true;
    } catch (e) {
      console.warn('[radio-store] 清除睡眠定时失败', e);
      return false;
    }
  },

  // ---------- 工具 ----------

  generateId() {
    return 'ep_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  },

  getStats() {
    this.init();
    const total = this._episodes.length;
    const pending = this._episodes.filter(e => e.status === 'pending').length;
    const completed = this._episodes.filter(e => e.status === 'completed').length;
    const listening = this._episodes.filter(e => e.status === 'listening').length;
    return { total, pending, completed, listening };
  },
};
