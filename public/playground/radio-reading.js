// playground/radio-reading.js
// 午夜电台 · 小星个人书架与持续阅读记忆（独立数据层）
// 职责：录入完整书单，持久化"当前在读 / 下一本计划 / 阅读感想 / 完成记录 / 共读书架"，
//       并在生成读书节目时按需提供精简上下文。
// 边界：纯本地 localStorage；不调用 API、不生成节目、不修改节目存档（radio-store）。
//       分类(category)是书单给定的静态归属，永不随阅读改变；状态(status)是动态进度，
//       只由用户/小星的明确操作驱动，不随机、不自动轮替。
//       初始已读 12 本属于"初始积累"，不写入 history；程序记录的完成才写 history。

const READING_KEY = 'ylxh.radio.reading';

// 静态分类（书单归属，永不改变）
const CATEGORY = {
  INITIAL: 'initial-read', // 初始已读 12 本
  PLANNED: 'planned',      // 计划开始后读完 6 本（保留译本/出版社）
  UNREAD: 'unread',        // 尚未阅读 24 本
};

// 动态状态（进度，由操作驱动）
const STATUS = {
  UNREAD: 'unread',        // 未读
  PREPARING: 'preparing',  // 准备开始（已列为下一本）
  READING: 'reading',      // 正在读
  FINISHED: 'finished',    // 已读完
};

// ---------- 完整书单（唯一数据源，书名逐字不改） ----------

const INITIAL_BOOKS = [
  '飞鸟集', '人间词话', '麦琪的礼物', '1984', '小王子', '月亮与六便士',
  '局外人', '浮生六记', '红与黑', '刀锋', '瓦尔登湖', '项链',
];

const PLANNED_BOOKS = [
  { title: '悉达多', translator: '姜乙', publisher: '天津出版社' },
  { title: '德米安', translator: '姜乙' },
  { title: '荒原狼', translator: '姜乙' },
  { title: '克林索尔的最后夏天', translator: '易海舟' },
  { title: '叶芝诗选', translator: '袁可嘉' },
  { title: '二十首情诗和一首绝望的歌', translator: '李宗荣' },
];

const UNREAD_BOOKS = [
  '不存在的骑士', '分成两半的子爵', '树上的男爵', '夜航船', '尤利西斯', '漫长的告别',
  '自深深处', '长物志', '先知纪伯伦', '萨拉戈萨手稿', '活山', '未知大学',
  '我的孤独是一座花园', '幸福之路', '夜莺与玫瑰', '理智与情感', '人类群星闪耀时',
  '坐在你身边看云', '昨天的世界', '云朵观察手册', '西西弗神话', '不要温和地走入那个良夜',
  '双城记', '忒修斯之船',
];

// 共同阅读候选：均取自"尚未阅读"，仅作为附加标记，不改变其 category / status
const CO_READ_TITLES = [
  '夜莺与玫瑰', '理智与情感', '坐在你身边看云', '云朵观察手册', '树上的男爵',
];

// ---------- 种子状态 ----------

function buildSeed() {
  const books = [];
  let n = 0;
  const add = (title, category, extra = {}) => {
    n += 1;
    books.push({
      id: 'bk_' + String(n).padStart(3, '0'),
      title,
      category,
      author: typeof extra.author === 'string' ? extra.author : '',
      translator: typeof extra.translator === 'string' ? extra.translator : '',
      publisher: typeof extra.publisher === 'string' ? extra.publisher : '',
      status: category === CATEGORY.INITIAL ? STATUS.FINISHED : STATUS.UNREAD,
      coRead: CO_READ_TITLES.includes(title),
    });
  };

  INITIAL_BOOKS.forEach(t => add(t, CATEGORY.INITIAL));
  PLANNED_BOOKS.forEach(b => add(b.title, CATEGORY.PLANNED, b));
  UNREAD_BOOKS.forEach(t => add(t, CATEGORY.UNREAD));

  return {
    version: 1,
    books,
    nowReading: null,   // 初始不自动设置任何"正在读"
    nextBookId: null,   // 初始没有下一本计划，由小星自主挑选后才落库
    thoughts: [],
    history: [],
    lastSurpriseAt: null,
    updatedAt: Date.now(),
  };
}

// ---------- 校验 / 容错 ----------

function sanitizeBook(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) return null;
  if (typeof raw.title !== 'string' || !raw.title) return null;
  const category = [CATEGORY.INITIAL, CATEGORY.PLANNED, CATEGORY.UNREAD].includes(raw.category)
    ? raw.category : CATEGORY.UNREAD;
  const validStatus = [STATUS.UNREAD, STATUS.PREPARING, STATUS.READING, STATUS.FINISHED];
  // 非法状态回退到由分类推导的默认值
  const status = validStatus.includes(raw.status)
    ? raw.status
    : (category === CATEGORY.INITIAL ? STATUS.FINISHED : STATUS.UNREAD);
  return {
    id: raw.id,
    title: raw.title,
    category,
    author: typeof raw.author === 'string' ? raw.author : '',
    translator: typeof raw.translator === 'string' ? raw.translator : '',
    publisher: typeof raw.publisher === 'string' ? raw.publisher : '',
    status,
    coRead: !!raw.coRead,
  };
}

function sanitizeState(raw) {
  const seed = buildSeed();
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.books)) return seed;

  // 以种子书单为准逐本对齐：保证 42 本齐全、分类/译本不被破坏，
  // 仅保留合法的动态字段（status / coRead）。
  const byId = new Map();
  raw.books.forEach(b => {
    const clean = sanitizeBook(b);
    if (clean) byId.set(clean.id, clean);
  });
  const books = seed.books.map(base => {
    const found = byId.get(base.id);
    if (!found || found.title !== base.title || found.category !== base.category) return base;
    return {
      ...base,
      status: found.status,
      coRead: found.coRead,
    };
  });

  const hasBook = id => books.some(b => b.id === id);
  const nowReading = raw.nowReading && typeof raw.nowReading === 'object'
    && hasBook(raw.nowReading.bookId)
    ? { bookId: raw.nowReading.bookId, since: typeof raw.nowReading.since === 'number' ? raw.nowReading.since : Date.now() }
    : null;
  const nextBookId = typeof raw.nextBookId === 'string' && hasBook(raw.nextBookId) ? raw.nextBookId : null;

  const thoughts = Array.isArray(raw.thoughts)
    ? raw.thoughts.filter(t => t && typeof t === 'object' && typeof t.text === 'string' && hasBook(t.bookId))
      .map(t => ({
        id: typeof t.id === 'string' ? t.id : 'th_' + String(t.createdAt || Date.now()),
        bookId: t.bookId,
        text: t.text,
        createdAt: typeof t.createdAt === 'number' ? t.createdAt : Date.now(),
      }))
    : [];

  const history = Array.isArray(raw.history)
    ? raw.history.filter(h => h && typeof h === 'object' && hasBook(h.bookId))
      .map(h => ({
        bookId: h.bookId,
        thought: typeof h.thought === 'string' ? h.thought : '',
        finishedAt: typeof h.finishedAt === 'number' ? h.finishedAt : Date.now(),
      }))
    : [];

  return {
    version: 1,
    books,
    nowReading,
    nextBookId,
    thoughts,
    history,
    lastSurpriseAt: typeof raw.lastSurpriseAt === 'number' ? raw.lastSurpriseAt : null,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
  };
}

// ---------- 安全读写 ----------

function safeGetJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch (e) {
    console.warn('[radio-reading] 读取失败，使用默认值', e);
    return fallback;
  }
}

function safeSetJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.warn('[radio-reading] 保存失败', e);
    return false;
  }
}

let _state = null;

// ---------- 对外接口 ----------

export const radioReading = {
  init() {
    if (_state !== null) return;
    const raw = safeGetJSON(READING_KEY, null);
    if (raw === null) {
      // 首次访问：写入完整种子并落盘
      _state = buildSeed();
      safeSetJSON(READING_KEY, _state);
    } else {
      _state = sanitizeState(raw);
    }
  },

  _save() {
    if (!_state) return false;
    _state.updatedAt = Date.now();
    return safeSetJSON(READING_KEY, _state);
  },

  // 仅用于测试：恢复到初始书单状态
  reset() {
    _state = buildSeed();
    safeSetJSON(READING_KEY, _state);
    return true;
  },

  // ---------- 书架查询 ----------

  getAll() {
    this.init();
    return _state.books.map(b => ({ ...b }));
  },

  getByCategory(category) {
    this.init();
    return _state.books.filter(b => b.category === category).map(b => ({ ...b }));
  },

  getBook(id) {
    this.init();
    const b = _state.books.find(x => x.id === id);
    return b ? { ...b } : null;
  },

  getCoRead() {
    this.init();
    return _state.books.filter(b => b.coRead).map(b => ({ ...b }));
  },

  // 切换共读标记：绝不改变 category / status（未读仍是未读）
  toggleCoRead(id) {
    this.init();
    const b = _state.books.find(x => x.id === id);
    if (!b) return false;
    b.coRead = !b.coRead;
    return this._save();
  },

  // ---------- 当前在读 / 下一本计划 ----------

  getNowReading() {
    this.init();
    if (!_state.nowReading) return null;
    const book = _state.books.find(b => b.id === _state.nowReading.bookId);
    if (!book) return null;
    return { book: { ...book }, since: _state.nowReading.since };
  },

  getNextBook() {
    this.init();
    if (!_state.nextBookId) return null;
    const book = _state.books.find(b => b.id === _state.nextBookId);
    return book ? { ...book } : null;
  },

  // 设为下一本（"准备开始"）：状态落库，不自动变成在读，不随机更换
  setNextBook(id) {
    this.init();
    const target = _state.books.find(b => b.id === id);
    if (!target) return false;
    if (_state.nowReading && _state.nowReading.bookId === id) return false; // 正在读的不能回退为准备开始
    // 旧计划若仍停在 preparing，回退为 unread
    if (_state.nextBookId && _state.nextBookId !== id) {
      const prev = _state.books.find(b => b.id === _state.nextBookId);
      if (prev && prev.status === STATUS.PREPARING) prev.status = STATUS.UNREAD;
    }
    _state.nextBookId = id;
    if (target.status === STATUS.UNREAD) target.status = STATUS.PREPARING;
    return this._save();
  },

  clearNextBook() {
    this.init();
    if (!_state.nextBookId) return true;
    const prev = _state.books.find(b => b.id === _state.nextBookId);
    if (prev && prev.status === STATUS.PREPARING) prev.status = STATUS.UNREAD;
    _state.nextBookId = null;
    return this._save();
  },

  // 设为在读：状态确定后持久化；若它是下一本计划则同时清掉计划
  setNowReading(id) {
    this.init();
    const target = _state.books.find(b => b.id === id);
    if (!target) return false;
    if (target.status === STATUS.FINISHED) return false; // 读完的书不能重新设为在读
    // 上一本在读若未读完，回退为未读（避免多本同时 reading）
    if (_state.nowReading && _state.nowReading.bookId !== id) {
      const prev = _state.books.find(b => b.id === _state.nowReading.bookId);
      if (prev && prev.status === STATUS.READING) prev.status = STATUS.UNREAD;
    }
    if (_state.nextBookId === id) _state.nextBookId = null;
    target.status = STATUS.READING;
    _state.nowReading = { bookId: id, since: Date.now() };
    return this._save();
  },

  clearNowReading() {
    this.init();
    if (!_state.nowReading) return true;
    const prev = _state.books.find(b => b.id === _state.nowReading.bookId);
    if (prev && prev.status === STATUS.READING) prev.status = STATUS.UNREAD;
    _state.nowReading = null;
    return this._save();
  },

  // ---------- 阅读感想 / 完成记录 ----------

  addThought(bookId, text) {
    this.init();
    if (typeof text !== 'string' || !text.trim()) return false;
    if (!_state.books.some(b => b.id === bookId)) return false;
    _state.thoughts.unshift({
      id: 'th_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
      bookId,
      text: text.trim(),
      createdAt: Date.now(),
    });
    if (_state.thoughts.length > 60) _state.thoughts.length = 60;
    return this._save();
  },

  getRecentThoughts(limit = 5) {
    this.init();
    const n = Math.max(1, Math.min(20, Number(limit) || 5));
    return _state.thoughts.slice(0, n).map(t => ({ ...t }));
  },

  getHistory() {
    this.init();
    return _state.history.map(h => ({ ...h }));
  },

  // 标记读完：写 history（与初始已读区分），清掉在读/计划
  markFinished(bookId, thought = '') {
    this.init();
    const target = _state.books.find(b => b.id === bookId);
    if (!target) return false;
    if (target.status === STATUS.FINISHED) return false;
    target.status = STATUS.FINISHED;
    if (_state.nowReading && _state.nowReading.bookId === bookId) _state.nowReading = null;
    if (_state.nextBookId === bookId) _state.nextBookId = null;
    _state.history.unshift({
      bookId,
      thought: typeof thought === 'string' ? thought.trim() : '',
      finishedAt: Date.now(),
    });
    if (_state.history.length > 60) _state.history.length = 60;
    return this._save();
  },

  // ---------- 阅读惊喜（纯本地读取，不触发任何 API / 生成） ----------

  getSurprise() {
    this.init();
    const since = _state.lastSurpriseAt || 0;
    const freshThoughts = _state.thoughts.filter(t => t.createdAt > since).slice(0, 2);
    const freshRecords = _state.history.filter(h => h.finishedAt > since).slice(0, 2);
    const decorate = (item, timeKey) => {
      const book = _state.books.find(b => b.id === item.bookId);
      return { ...item, title: book ? book.title : '一本书', at: item[timeKey] };
    };
    return {
      thoughts: freshThoughts.map(t => decorate(t, 'createdAt')),
      records: freshRecords.map(h => decorate(h, 'finishedAt')),
    };
  },

  // 查看后置为已读，避免同一条惊喜反复出现
  markSeen() {
    this.init();
    _state.lastSurpriseAt = Date.now();
    return this._save();
  },

  // ---------- 生成节目用的按需上下文 ----------

  // 只带当前在读 / 下一本 / 共读候选 / 最近两条感想，绝不把 42 本全单塞进 prompt
  buildApiContext(maxLength = 400) {
    this.init();
    const parts = [];

    const now = this.getNowReading();
    if (now) {
      const b = now.book;
      const meta = [b.author && `作者${b.author}`, b.translator && `${b.translator}译`, b.publisher]
        .filter(Boolean).join('，');
      parts.push(`小星目前正在读《${b.title}》${meta ? '（' + meta + '）' : ''}。`);
    }

    const next = this.getNextBook();
    if (next) parts.push(`他接下来准备开始读《${next.title}》。`);

    const co = this.getCoRead();
    if (co.length) {
      parts.push(`他邀请你一起读的书里有：${co.slice(0, 3).map(b => `《${b.title}》`).join('、')}。`);
    }

    const thoughts = this.getRecentThoughts(2);
    if (thoughts.length) {
      parts.push('他最近写下的阅读感想：');
      thoughts.forEach(t => {
        const b = this.getBook(t.bookId);
        parts.push(`· 关于《${b ? b.title : '一本书'}》：${t.text.slice(0, 80)}`);
      });
    }

    let context = parts.join('\n');
    const cap = Math.max(80, Number(maxLength) || 400);
    if (context.length > cap) context = context.slice(0, cap) + '…';
    return context;
  },
};
