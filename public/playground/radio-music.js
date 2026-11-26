// playground/radio-music.js
// 午夜电台 · 音乐频道曲库
// 独立数据模块，只描述曲目元数据；音频播放交给 radio-audio.js，收藏/进度存 radio-store.js

const TRACKS = [
  {
    id: 'track-hush',
    title: '雨夜轻哄',
    artist: '星星的晚安曲',
    desc: '雨落在窗沿的声音，慢慢呼吸，就可以睡着了。',
    src: '/audio/ambient/哄睡.mp3',
    mood: '🌧️',
  },
  {
    id: 'track-elder',
    title: '师兄的旧唱片',
    artist: '深夜循环',
    desc: '像是很久以前听过的旋律，熟悉又安心。',
    src: '/audio/ambient/师兄.mp3',
    mood: '🎧',
  },
  {
    id: 'track-damp',
    title: '潮湿的夜色',
    artist: '无人的街道',
    desc: '空气有点湿，夜色有点软，适合发呆。',
    src: '/audio/ambient/潮湿.mp3',
    mood: '🌙',
  },
];

export const radioMusic = {
  // 返回全部曲目（副本），按曲库顺序
  getAll() {
    return TRACKS.map(t => ({ ...t }));
  },

  getById(id) {
    const t = TRACKS.find(x => x.id === id);
    return t ? { ...t } : null;
  },

  // 曲库是否已收藏（meta 项存在且 favorite 为真）
  isFavorite(metaList, id) {
    if (!Array.isArray(metaList)) return false;
    const item = metaList.find(m => m && m.id === id);
    return !!(item && item.favorite);
  },

  // 切换收藏，返回同结构的新数组
  toggleFavorite(metaList, id) {
    const list = Array.isArray(metaList) ? metaList.map(m => (m && typeof m === 'object' ? { ...m } : null)).filter(Boolean) : [];
    const idx = list.findIndex(m => m.id === id);
    if (idx === -1) {
      list.push({ id, favorite: true, lastPosition: 0, duration: 0, updatedAt: Date.now() });
    } else {
      list[idx].favorite = !list[idx].favorite;
      list[idx].updatedAt = Date.now();
    }
    return list;
  },

  // 记录某曲目的播放进度，返回同结构的新数组
  setProgress(metaList, id, lastPosition, duration) {
    const list = Array.isArray(metaList) ? metaList.map(m => (m && typeof m === 'object' ? { ...m } : null)).filter(Boolean) : [];
    let item = list.find(m => m.id === id);
    if (!item) {
      item = { id, favorite: false, lastPosition: 0, duration: 0, updatedAt: Date.now() };
      list.push(item);
    }
    item.lastPosition = typeof lastPosition === 'number' ? lastPosition : 0;
    item.duration = typeof duration === 'number' ? duration : 0;
    item.updatedAt = Date.now();
    return list;
  },

  getProgress(metaList, id) {
    if (!Array.isArray(metaList)) return null;
    const item = metaList.find(m => m && m.id === id);
    return item ? { lastPosition: item.lastPosition || 0, duration: item.duration || 0 } : null;
  },
};
