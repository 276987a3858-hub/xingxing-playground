/* =====================================================
   和小星一起背单词 · 独立存档
   负责：学习进度的本地持久化（已掌握、错词、练习统计）
   刻意只记录"学习数据"，不含好感度/等级/经验/签到等系统
   独立 localStorage key，不读写 store.js 的主存档
   ===================================================== */

const KEY = 'ylxh.vocab.v1';

function createDefaults() {
  return {
    mastered: [],   // 已掌握单词
    wrong: [],      // 待巩固单词
    history: [],    // 每轮学习记录（含单词明细）；为「单词本/错题本/复习模式」预留扩展
    // 「星星的单词本」：共同学过的词档案，按单词去重。旧存档没有此字段时为空对象，
    // 只从现在开始记录，不从 history 反推伪造过去的学习历史。
    words: {},
    stats: {
      rounds: 0,        // 完成的轮次
      answers: 0,       // 累计作答次数
      correct: 0,       // 累计答对次数
      wordsLearned: 0   // 累计学过的不同单词数
    }
  };
}

function loadData() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return createDefaults();
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return createDefaults();

    const cleanList = value => Array.isArray(value)
      ? [...new Set(value.filter(x => typeof x === 'string'))]
      : [];

    const s = saved.stats && typeof saved.stats === 'object' ? saved.stats : {};
    const num = value => (typeof value === 'number' && isFinite(value) && value >= 0) ? Math.floor(value) : 0;

    // 向后兼容：旧存档没有 history 时为空数组，不伪造任何历史内容
    const cleanHistory = value => {
      if (!Array.isArray(value)) return [];
      return value.filter(r => r && typeof r === 'object').map(r => ({
        at: num(r.at) || (typeof r.at === 'string' ? r.at : ''),
        size: num(r.size),
        right: num(r.right),
        wrong: num(r.wrong),
        level: typeof r.level === 'string' ? r.level : '',
        words: Array.isArray(r.words)
          ? r.words.filter(w => w && typeof w.w === 'string').map(w => ({
              w: w.w,
              cn: typeof w.cn === 'string' ? w.cn : '',
              result: ['correct', 'wrong', 'hintCorrect'].includes(w.result) ? w.result : 'wrong'
            }))
          : []  // 旧轮次没有明细：words 为空，展示时标记"暂无明细"，不伪造
      }));
    };

    // 向后兼容：单词档案。旧存档没有 words 时为空对象，不伪造历史。
    // 掌握状态是后来新增的：旧档案缺字段时补默认值；若旧存档的 mastered 列表里
    // 已经有这个词，保留它原有的"已掌握"结果（标记为 legacy），不推翻用户历史。
    const cleanWords = value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
      const legacyMastered = cleanList(saved.mastered);
      const out = {};
      Object.keys(value).forEach(key => {
        const item = value[key];
        if (!item || typeof item !== 'object') return;
        const wasMastered = typeof item.mastered === 'boolean'
          ? item.mastered
          : legacyMastered.includes(key);
        out[key] = {
          w: typeof item.w === 'string' && item.w ? item.w : key,
          cn: typeof item.cn === 'string' ? item.cn : '',
          ph: typeof item.ph === 'string' ? item.ph : '',
          pos: typeof item.pos === 'string' ? item.pos : '',
          lv: typeof item.lv === 'string' ? item.lv : '',
          learnCount: num(item.learnCount),
          lastLearnedAt: num(item.lastLearnedAt),
          wrongCount: num(item.wrongCount),
          lastWrongAt: num(item.lastWrongAt),
          correctCount: num(item.correctCount),
          lastCorrectAt: num(item.lastCorrectAt),
          // 逐词掌握状态：旧档案缺字段时安全补默认值
          mastered: wasMastered,
          streak: num(item.streak),
          masteredAt: num(item.masteredAt),
          masterySource: typeof item.masterySource === 'string'
            ? item.masterySource
            : (wasMastered && typeof item.mastered !== 'boolean' ? 'legacy' : '')
        };
      });
      return out;
    };

    return {
      mastered: cleanList(saved.mastered),
      wrong: cleanList(saved.wrong),
      history: cleanHistory(saved.history),
      words: cleanWords(saved.words),
      stats: {
        rounds: num(s.rounds),
        answers: num(s.answers),
        correct: num(s.correct),
        wordsLearned: num(s.wordsLearned)
      }
    };
  } catch (e) {
    console.warn('[vocab] 存档读取失败，已恢复默认数据', e);
    return createDefaults();
  }
}

export const vocabStore = {
  data: loadData(),

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch (e) {
      console.warn('[vocab] 存档保存失败', e);
    }
  },

  // 记录一次作答的旧接口：只维护累计统计和错词列表。
  // 注意：掌握不再由这里决定——一次答对不等于掌握，掌握由 recordWordAttempt
  // 按"逐词连续独立答对 3 次"或手动标记单独判定。
  recordAnswer(word, correct) {
    if (typeof word !== 'string' || !word) return;
    this.data.stats.answers += 1;
    if (correct) {
      this.data.stats.correct += 1;
      this.data.wrong = this.data.wrong.filter(x => x !== word);
    } else {
      if (!this.data.wrong.includes(word)) this.data.wrong.push(word);
    }
    this.save();
  },

  // 完成一轮：更新累计统计，并保存本轮完整单词明细（detail 结构见下方注释）
  // detail = { size, right, wrong, level, words:[{w,cn,result}] }
  // 为兼容旧调用，learnedCount 可以是数字
  finishRound(learnedCount, detail) {
    this.data.stats.rounds += 1;
    if (typeof learnedCount === 'number' && learnedCount > 0) {
      this.data.stats.wordsLearned += learnedCount;
    }
    if (detail && typeof detail === 'object' && Array.isArray(detail.words)) {
      if (!Array.isArray(this.data.history)) this.data.history = [];
      this.data.history.push({
        at: Date.now(),
        size: detail.size || detail.words.length,
        right: detail.right || 0,
        wrong: detail.wrong || 0,
        level: detail.level || '',
        words: detail.words.map(w => ({
          w: String(w.w || ''),
          cn: String(w.cn || ''),
          result: ['correct', 'wrong', 'hintCorrect'].includes(w.result) ? w.result : 'wrong'
        }))
      });
      // 只保留最近 50 轮，避免本地存档无限膨胀
      if (this.data.history.length > 50) this.data.history = this.data.history.slice(-50);
    }
    this.save();
  },

  getHistory() {
    return (this.data.history || []).slice().reverse(); // 最近一轮在前
  },

  getWrongWords() {
    return this.data.wrong.slice();
  },

  getMastered() {
    return this.data.mastered.slice();
  },

  // ---------- 「星星的单词本」：共同学过的词档案 ----------
  // 内部：取得/新建一个词的档案（同一个词永远只有一条记录）
  _wordEntry(word, meta) {
    if (!this.data.words || typeof this.data.words !== 'object') this.data.words = {};
    let entry = this.data.words[word];
    if (!entry) {
      entry = {
        w: word, cn: '', ph: '', pos: '', lv: '',
        learnCount: 0, lastLearnedAt: 0,
        wrongCount: 0, lastWrongAt: 0,
        correctCount: 0, lastCorrectAt: 0,
        // 逐词独立统计：连续独立答对 3 次自动掌握；提示后答对不计入独立次数
        mastered: false, streak: 0, masteredAt: 0, masterySource: ''
      };
      this.data.words[word] = entry;
    }
    // 词条元数据只补全、不覆盖已有真实内容
    if (meta && typeof meta === 'object') {
      ['cn', 'ph', 'pos', 'lv'].forEach(k => {
        if (typeof meta[k] === 'string' && meta[k]) entry[k] = meta[k];
      });
    }
    return entry;
  },

  // 记录一个词真正进入过学习流程：重复学习只更新次数与时间，不新建记录
  recordLearn(word, meta) {
    if (typeof word !== 'string' || !word) return;
    const entry = this._wordEntry(word, meta);
    entry.learnCount += 1;
    entry.lastLearnedAt = Date.now();
    this.save();
  },

  // 内部：把词档案标记为已掌握（自动与手动共用），同步旧 mastered 列表，不删任何历史
  _markEntryMastered(entry, source) {
    entry.mastered = true;
    entry.masteredAt = Date.now();
    entry.masterySource = source;
    if (!Array.isArray(this.data.mastered)) this.data.mastered = [];
    if (!this.data.mastered.includes(entry.w)) this.data.mastered.push(entry.w);
  },

  // 记录一次作答结果：更新正确/错误次数与时间，保留历史（错误历史不会被抹掉）
  // meta.independent === false 表示这次答对用了提示（或答错后重试），
  // 不计入"最近连续独立答对"，并打断已有连续次数。
  recordWordAttempt(word, correct, meta) {
    if (typeof word !== 'string' || !word) return;
    const entry = this._wordEntry(word, meta);
    if (correct) {
      entry.correctCount += 1;
      entry.lastCorrectAt = Date.now();
      if (meta && meta.independent === false) {
        entry.streak = 0;
      } else {
        entry.streak = (entry.streak || 0) + 1;
      }
      // 逐词独立统计，达到 3 次自动掌握；不能用整轮总正确数代替
      if (!entry.mastered && entry.streak >= 3) {
        this._markEntryMastered(entry, 'auto');
      }
    } else {
      entry.wrongCount += 1;
      entry.lastWrongAt = Date.now();
      entry.streak = 0; // 答错清零连续独立正确次数
    }
    this.save();
  },

  // 手动标记已掌握：只作用于真实存在的词档案，不新建、不删除学习/答题历史
  markMastered(word) {
    if (typeof word !== 'string' || !word) return false;
    const words = this.data.words && typeof this.data.words === 'object' ? this.data.words : {};
    const entry = words[word];
    if (!entry || entry.mastered) return false;
    this._markEntryMastered(entry, 'manual');
    this.save();
    return true;
  },

  // 全部学过的词档案（按最近学习时间倒序），数据来自真实记录
  getAllWords() {
    const words = this.data.words && typeof this.data.words === 'object' ? this.data.words : {};
    return Object.keys(words).map(k => words[k]).sort((a, b) => b.lastLearnedAt - a.lastLearnedAt);
  },

  // 单个词的档案副本（不存在返回 null），供单词本判断状态
  getWordEntry(word) {
    const words = this.data.words && typeof this.data.words === 'object' ? this.data.words : {};
    return words[word] ? { ...words[word] } : null;
  },

  // 已学过（真正进入过学习流程）的词，供新词池排除
  getLearnedWords() {
    return this.getAllWords().filter(w => w.learnCount > 0).map(w => w.w);
  },

  // 已掌握的词，供新词池与常规复习池排除
  getMasteredWords() {
    return this.getAllWords().filter(w => w.mastered).map(w => w.w);
  },

  // 学过但还没掌握的旧词：最久没见的优先，其次错误多的优先。
  // 只在新词不足时补齐，且已掌握词一律不进。
  getUnmasteredLearnedWords() {
    return this.getAllWords()
      .filter(w => w.learnCount > 0 && !w.mastered)
      .sort((a, b) => (a.lastLearnedAt - b.lastLearnedAt) || (b.wrongCount - a.wrongCount))
      .map(w => ({ ...w }));
  },

  // 「还要再见面的词」：未掌握且出现过答错的词，按错误次数倒序（保留全部错误历史）
  // 已掌握的词退出常规复习池，但档案和历史仍完整保留在单词本里。
  getNeedsReview() {
    return this.getAllWords().filter(w => !w.mastered && w.wrongCount > 0)
      .sort((a, b) => b.wrongCount - a.wrongCount || b.lastWrongAt - a.lastWrongAt);
  },

  // 本地挑复习词（简单规则，无间隔重复算法）：
  // 0) 已掌握的词一律排除，不频繁打扰；历史和档案仍保留在单词本；
  // 1) 答错过的优先，错误次数多、最近又错的更靠前；
  // 2) 多次答对且近期没答错的词降权（越稳定越靠后）；
  // 3) 没有错词时，用最近学过且未掌握的词补齐；
  // 4) 只从真实档案里挑，绝不编造。
  pickReviewWords(limit) {
    const max = (typeof limit === 'number' && limit > 0) ? Math.floor(limit) : 5;
    const all = this.getAllWords().filter(w => !w.mastered);
    if (!all.length) return [];
    const now = Date.now();
    const score = w => {
      let s = w.wrongCount * 10;                       // 答错越多越需要复习
      if (w.lastWrongAt > w.lastCorrectAt) s += 6;     // 最近一次是错的
      s -= Math.min(w.correctCount, 5) * 1.5;          // 多次答对，降低优先级
      if (now - w.lastWrongAt < 3 * 86400000 && w.wrongCount > 0) s += 2; // 近期错词加权
      return s;
    };
    // 有错词：按复习分数排；再用最近学习时间做次级排序
    const needy = all.filter(w => w.wrongCount > 0)
      .sort((a, b) => score(b) - score(a) || b.lastWrongAt - a.lastWrongAt);
    if (needy.length >= max) return needy.slice(0, max).map(w => ({ ...w }));
    // 不足：用最近学过的、且未在 needy 里的词补齐
    const chosen = needy.map(w => w.w);
    const rest = all.filter(w => !chosen.includes(w.w));
    return needy.concat(rest).slice(0, max).map(w => ({ ...w }));
  },

  getStats() {
    return Object.assign({}, this.data.stats);
  },

  getAccuracy() {
    const s = this.data.stats;
    return s.answers > 0 ? Math.round((s.correct / s.answers) * 100) : 0;
  },

  reset() {
    this.data = createDefaults();
    this.save();
  }
};
