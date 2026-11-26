/* =====================================================
   和小星一起背单词 · 场景层
   负责：界面渲染、四阶段状态机、答题与重试、朗读、AI 调度与清理
   数据 = vocab-data.js / 存档 = vocab-store.js / 台词 = vocab-ai.js
   样式 = vocab-styles.js（全部 .vocab- 前缀，作用域隔离）
   ===================================================== */

import { LEVELS, QUESTION_TYPES, buildQuestion, getWordsByLevel, getActiveWords, findWord, pickFreshWords } from './vocab-data.js';
import { vocabStore } from './vocab-store.js';
import { store } from './store.js';
import { VOCAB_STYLES } from './vocab-styles.js';
import { speak, beginVocabAI, endVocabAI } from './vocab-ai.js';
import { gameEnd } from './game-end.js';

const STYLE_ID = 'vocab-styles';

export const VocabScene = {
  container: null,
  active: false,
  epoch: 0,

  timers: new Set(),
  styleInjected: false,

  // 本轮配置与运行时状态
  level: 'cet6',          // 四级已下线，默认六级
  roundSize: 20,          // 默认每组 20 个（可选 10/20/30）
  groupSize: 5,           // 每 5 个一组分组学习
  enabledTypes: QUESTION_TYPES.map(t => t.id),

  phase: 'setup',      // setup | learn | quiz | summary
  queue: [],           // 本轮题目
  qIndex: 0,
  learnList: [],       // 学习阶段的词条
  learnIndex: 0,
  learnMarks: new Set(),

  // 对话气泡状态：跨页面重绘保留，避免永久停留在省略号
  bubbleText: '',
  bubbleThinking: false,
  bubbleSeq: 0,

  retries: 0,          // 当前题第几次作答
  locked: false,       // 防止同一题重复提交
  streak: 0,
  roundRight: 0,
  roundWrong: 0,
  roundMistakes: [],   // 本轮错过的单词
  roundLearned: [],    // 本轮学过的单词
  roundDetails: [],    // 本轮每个单词的答题明细 [{w,cn,result}] result: correct/wrong/hintCorrect

  // 本轮来源：'new' 未学过的新词 / 'review' 新词不足时补入的未掌握旧词
  wordSources: {},

  // 小挑战运行时状态（复用答题流程，但题来自单词本真实档案）
  challengeMode: false,
  challengeWords: [],  // 本轮挑战抽出的词（来自真实档案）
  challengeRight: 0,
  challengeWrong: 0,
  learnedThisPass: new Set(), // 本次进入已记入档案的词，避免同词重复计数

  // 这是一次「整次学习」的累计（跨多轮），只在用户主动结束时用于一句总结；
  // 每轮结束的 AI 总结仍然走原来的 say('summary')，不受影响。
  session: null,
  sessionSerial: 0,
  sessionEnded: false,

  // ---------- 生命周期 ----------
  mount(el) {
    this.container = el;
    this.active = true;
    this.epoch += 1;
    this.injectStyles();

    beginVocabAI();

    this.phase = 'setup';
    this.queue = [];
    this.qIndex = 0;
    this.learnList = [];
    this.learnIndex = 0;
    this.learnMarks = new Set();
    this.wordSources = {};
    this.bubbleText = '';
    this.bubbleThinking = false;
    this.retries = 0;
    this.locked = false;
    this.streak = 0;
    this.roundRight = 0;
    this.roundWrong = 0;
    this.roundMistakes = [];
    this.roundLearned = [];
    this.roundDetails = [];
    this.challengeMode = false;
    this.challengeWords = [];
    this.learnedThisPass = new Set();
    this.resetSession();

    this.renderSetup();
    this.say('intro', {});
  },

  unmount() {
    this.active = false;
    this.epoch += 1;
    endVocabAI();
    this.timers.forEach(id => clearTimeout(id));
    this.timers.clear();
    if (this.container) {
      this.container.innerHTML = '';
      this.container = null;
    }
  },

  // ---------- 整次学习的累计统计 ----------
  // 每轮结束只显示页面结果、不弹聊天消息；
  // 只有用户主动结束整次学习时，才用这里的真实累计发一句总结（本地生成，不新增 API）。
  resetSession() {
    this.sessionSerial += 1;
    this.sessionEnded = false;
    const mastered = vocabStore.getMasteredWords().length;
    this.session = {
      rounds: 0,
      words: 0,
      right: 0,
      wrong: 0,
      mistake: '',
      masteredBefore: mastered,
      masteredAfter: mastered
    };
  },

  endSession() {
    if (!this.active || !this.session) return false;
    if (this.session.rounds <= 0 || this.sessionEnded) return false;
    this.sessionEnded = true;

    const s = this.session;
    // 重新读取最新掌握状态：包含本轮结束后、在单词本里手动标记的词
    s.masteredAfter = vocabStore.getMasteredWords().length;
    const total = s.words;
    const acc = total > 0 ? Math.round((s.right / total) * 100) : 0;

    gameEnd.show({
      game: 'vocab',
      gameName: '一起背单词',
      token: `vocab:${this.sessionSerial}`,
      line: this.composeSessionLine(),
      result: `${s.rounds} 轮 · ${s.words} 个词 · 正确率 ${acc}%（按单词）`,
      english: ''
    });
    return true;
  },

  composeSessionLine() {
    const s = this.session;
    const acc = s.words > 0 ? Math.round((s.right / s.words) * 100) : 0;
    const gained = Math.max(0, s.masteredAfter - s.masteredBefore);
    const roundsLabel = s.rounds > 1 ? `${s.rounds} 轮` : '这一轮';

    const facts = [
      `今晚${roundsLabel}、${s.words} 个词，${s.right} 个答对。`,
      `${roundsLabel}过了 ${s.words} 个词，对了 ${s.right} 个。`,
      `今晚一共 ${s.words} 个词，答对 ${s.right} 个。`
    ];
    const verdicts = acc >= 90
      ? ['你今晚状态很好。', '几乎没怎么错。', '这个准确度，够了。']
      : acc >= 75
        ? ['剩下那几个，交给下一次。', '大部分都记住了。', '错得不多，已经不错。']
        : acc >= 60
          ? ['有几处卡住，不过你都自己找回来了。', '错的地方集中，反倒好办。']
          : ['今晚有点难，但你没有停下来。', '错的比对的多了些，可你还是做完了。'];

    const candidates = [];
    facts.forEach(fact => verdicts.forEach(verdict => candidates.push(fact + verdict)));
    if (gained > 0) {
      candidates.push(`今晚${roundsLabel}、${s.words} 个词，还新拿下 ${gained} 个。${verdicts[0]}`);
    }
    if (s.mistake) {
      candidates.push(`${s.mistake} 那个词今天还是没记住。${facts[0]}改天再见它一次。`);
    }
    return gameEnd.pickLine(candidates);
  },

  finishSession(btn) {
    const shown = this.endSession();
    if (btn) {
      btn.disabled = true;
      btn.textContent = shown
        ? '已结束 · 点右下角气泡回聊天'
        : (this.sessionEnded ? '今天的学习已经结束' : '今天还没有完成一轮');
    }
  },

  injectStyles() {
    if (this.styleInjected && document.getElementById(STYLE_ID)) return;    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = VOCAB_STYLES;
      document.head.appendChild(style);
    }
    this.styleInjected = true;
  },

  // 统一定时器：退出时全部清理
  later(fn, delay) {
    const epoch = this.epoch;
    const id = setTimeout(() => {
      this.timers.delete(id);
      if (!this.active || this.epoch !== epoch) return;
      fn();
    }, delay);
    this.timers.add(id);
    return id;
  },

  // ---------- AI 台词 ----------
  // 气泡状态机：bubbleSeq 递增后，只有最新序号的回调才能写入气泡，避免旧请求覆盖新内容
  say(occasion, ctx) {
    if (!this.active) return;
    const epoch = this.epoch;
    const seq = ++this.bubbleSeq;
    this.setBubble('……', true);
    // 兜底：无论成功/失败/中断/无 AbortController，到点都强制退出加载态
    // 用独立 epoch+seq 校验的定时器，不依赖 fetch 行为
    const guardId = setTimeout(() => {
      this.timers.delete(guardId);
      if (!this.active || this.epoch !== epoch || this.bubbleSeq !== seq) return;
      if (this.bubbleThinking) this.setBubble('这句我先想想，我们继续。', false);
    }, 9000);
    this.timers.add(guardId);
    speak(occasion, ctx).then(text => {
      clearTimeout(guardId);
      this.timers.delete(guardId);
      if (!this.active || this.epoch !== epoch || this.bubbleSeq !== seq) return;
      this.setBubble(text, false);
    });
  },

  // 阶段切换时：递增 seq 作废上一阶段的在途请求（防止其覆盖新题目），
  // 并立即写入静态过渡文字，确保气泡不会停留在省略号。
  settleBubble(staticText) {
    this.bubbleSeq += 1;
    this.setBubble(staticText, false);
  },

  setBubble(text, thinking) {
    this.bubbleText = text;
    this.bubbleThinking = !!thinking;
    if (!this.active || !this.container) return;
    const body = this.container.querySelector('#vocab-bubble-text');
    if (!body) return;
    body.textContent = text;
    body.className = 'vocab-bubble-text' + (thinking ? ' vocab-thinking' : '');
  },

  // ---------- DOM 辅助 ----------
  shell(innerHtml, progressHtml) {
    if (!this.active || !this.container) return;
    this.container.innerHTML = `
      <section class="vocab-scene">
        <header class="vocab-header">
          <div class="vocab-title-area">
            <span class="vocab-icon">✦</span>
            <div>
              <h2>和小星一起背单词</h2>
              <div class="vocab-sub">今晚也陪你记几个词</div>
            </div>
          </div>
          <button class="vocab-exit" id="vocab-exit">返回大厅</button>
        </header>
        ${progressHtml || ''}
        <div class="vocab-bubble">
          <div class="vocab-bubble-avatar">✧</div>
          <div class="vocab-bubble-body">
            <div class="vocab-bubble-name">小星</div>
            <div class="vocab-bubble-text${this.bubbleThinking ? ' vocab-thinking' : ''}" id="vocab-bubble-text">${this.bubbleText || '……'}</div>
          </div>
        </div>
        <div id="vocab-stage">${innerHtml}</div>
      </section>
    `;
    const exitBtn = this.container.querySelector('#vocab-exit');
    if (exitBtn) exitBtn.addEventListener('click', () => {
      // 主动离开 = 结束整次学习：已完成过至少一轮才发一句总结
      this.endSession();
      window.PlaygroundRouter.go('lobby');
    });
  },

  stage(html) {
    if (!this.active || !this.container) return null;
    const el = this.container.querySelector('#vocab-stage');
    if (!el) return null;
    el.innerHTML = html;
    return el;
  },

  progressHtml(current, total) {
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    return `
      <div class="vocab-progress">
        <span>进度 ${current} / ${total}</span>
        <div class="vocab-progress-track"><div class="vocab-progress-fill" style="width:${pct}%"></div></div>
        <span>答对 ${this.roundRight}</span>
      </div>
    `;
  },

  // ---------- 阶段一：设置 ----------
  renderSetup() {
    const stats = vocabStore.getStats();
    const acc = vocabStore.getAccuracy();
    const levels = LEVELS.map(lv => `
      <div class="vocab-level ${lv.id === this.level ? 'selected' : ''}" data-level="${lv.id}">
        <strong>${lv.name}</strong>
        <small>${lv.desc}</small>
      </div>
    `).join('');
    const chips = QUESTION_TYPES.map(t => `
      <div class="vocab-chip ${this.enabledTypes.includes(t.id) ? 'selected' : ''}" data-type="${t.id}">${t.name}</div>
    `).join('');

    this.shell(`
      <div class="vocab-card">
        <div class="vocab-card-label">选择难度</div>
        <div class="vocab-levels">${levels}</div>
        <div class="vocab-card-label" style="margin-top:8px">练习题型（至少选一种）</div>
        <div class="vocab-chips">${chips}</div>
        <div class="vocab-card-label" style="margin-top:8px">本轮词数（每 5 个一组）</div>
        <div class="vocab-chips" id="vocab-size-chips">
          ${[
            { n: 10, label: '10 个 · 轻量' },
            { n: 20, label: '20 个 · 标准' },
            { n: 30, label: '30 个 · 进阶' }
          ].map(o => `<div class="vocab-chip ${o.n === this.roundSize ? 'selected' : ''}" data-size="${o.n}">${o.label}</div>`).join('')}
        </div>
        <div class="vocab-actions" style="margin-top:18px">
          <button class="vocab-btn primary" id="vocab-start">开始今晚的单词</button>
          <button class="vocab-btn" id="vocab-open-book">📖 星星的单词本</button>
        </div>
      </div>
      <div class="vocab-stats">
        <div class="vocab-stat"><b>${stats.rounds}</b><small>完成轮次</small></div>
        <div class="vocab-stat"><b>${stats.wordsLearned}</b><small>学过单词</small></div>
        <div class="vocab-stat"><b>${acc}%</b><small>累计正确率</small></div>
      </div>
      <div class="vocab-notice">已掌握 ${vocabStore.getMastered().length} 个 · 待巩固 ${vocabStore.getWrongWords().length} 个</div>
      ${this.historyHtml()}
    `);

    this.container.querySelectorAll('.vocab-level').forEach(el => {
      el.addEventListener('click', () => {
        this.level = el.dataset.level;
        this.container.querySelectorAll('.vocab-level').forEach(x => x.classList.toggle('selected', x === el));
      });
    });
    this.container.querySelectorAll('#vocab-size-chips .vocab-chip').forEach(el => {
      el.addEventListener('click', () => {
        this.roundSize = Number(el.dataset.size);
        this.container.querySelectorAll('#vocab-size-chips .vocab-chip').forEach(x => x.classList.toggle('selected', x === el));
      });
    });
    this.container.querySelectorAll('.vocab-chips > .vocab-chip[data-type]').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.type;
        if (this.enabledTypes.includes(id)) {
          if (this.enabledTypes.length === 1) return;
          this.enabledTypes = this.enabledTypes.filter(x => x !== id);
        } else {
          this.enabledTypes.push(id);
        }
        el.classList.toggle('selected', this.enabledTypes.includes(id));
      });
    });
    const start = this.container.querySelector('#vocab-start');
    if (start) start.addEventListener('click', () => this.startRound());
    const openBook = this.container.querySelector('#vocab-open-book');
    if (openBook) openBook.addEventListener('click', () => this.enterBook());

    // 学习记录展开/折叠（事件委托，展开的详情项同样生效）
    this.container.querySelectorAll('.vocab-history-item').forEach(item => {
      const head = item.querySelector('.vocab-history-head');
      if (head) head.addEventListener('click', () => {
        const open = item.classList.toggle('open');
        head.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    });
  },

  // ---------- 学习记录列表（数据来自存档，刷新后仍在）----------
  historyHtml() {
    const history = vocabStore.getHistory();
    if (!history.length) {
      return `<div class="vocab-history"><div class="vocab-history-title">学习记录</div><div class="vocab-empty">还没有练习记录，完成一轮后这里会记下每个词。</div></div>`;
    }
    const items = history.map((r, idx) => {
      const total = r.words.length;
      const acc = (r.right + r.wrong) > 0 ? Math.round(r.right / (r.right + r.wrong) * 100) : 0;
      const date = r.at ? new Date(r.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
      const hasDetail = total > 0;
      let detailHtml;
      if (!hasDetail) {
        detailHtml = `<div class="vocab-empty">这一轮没有保存单词明细（旧记录）。</div>`;
      } else {
        const rows = r.words.map(w => {
          const mark = w.result === 'correct'
            ? { cls: 'ok', text: '答对' }
            : w.result === 'hintCorrect'
              ? { cls: 'hint', text: '提示后答对' }
              : { cls: 'bad', text: '答错' };
          return `<div class="vocab-hist-row"><span class="vocab-hist-word">${w.w}</span><span class="vocab-hist-cn">${w.cn || '—'}</span><span class="vocab-hist-result ${mark.cls}">${mark.text}</span></div>`;
        }).join('');
        detailHtml = `<div class="vocab-hist-table">${rows}</div>`;
      }
      return `
        <div class="vocab-history-item">
          <div class="vocab-history-head" role="button" tabindex="0" aria-expanded="false">
            <span class="vocab-history-idx">第 ${history.length - idx} 轮</span>
            <span class="vocab-history-meta">${date} · ${total ? total + ' 词' : '轮次记录'} · 答对 ${r.right} · 正确率 ${acc}%</span>
            <span class="vocab-history-arrow">▾</span>
          </div>
          <div class="vocab-history-body">${detailHtml}</div>
        </div>
      `;
    }).join('');
    return `<div class="vocab-history"><div class="vocab-history-title">学习记录 <small>点击查看每轮单词</small></div>${items}</div>`;
  },

  // ================= 「星星的单词本」 =================
  // 单词本数据全部来自真实档案，不编造任何词；只有一个入口，内部三个区域。
  enterBook() {
    if (!this.active) return;
    this.phase = 'book';
    this.challengeMode = false;
    this.renderBook();
    // 小星只在翻开单词本时说一次：真实概况、最近学过的词、需要再见面的词
    // 合并进同一次请求。原先分三次错开发送，后两句会作废旧句却照样消耗积分。
    const all = vocabStore.getAllWords();
    const needy = vocabStore.getNeedsReview();
    this.say('bookOpen', {
      learnedSummary: this.bookSummaryText(),
      recentWords: all.length ? all.slice(0, 6).map(w => w.w).join('、') : '',
      reviewWords: needy.length ? needy.slice(0, 6).map(w => w.w).join('、') : ''
    });
  },

  bookSummaryText() {
    const all = vocabStore.getAllWords();
    const needy = vocabStore.getNeedsReview();
    if (!all.length) return '单词本还是空的，还没有一起学过的词。';
    return `一起学过 ${all.length} 个词，其中 ${needy.length} 个还需要再见面。`;
  },

  fmtTime(ts) {
    if (!ts) return '—';
    try {
      return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return '—'; }
  },

  renderBook() {
    const all = vocabStore.getAllWords();      // 一起学过的词
    const needy = vocabStore.getNeedsReview(); // 还要再见面的词（已自动排除已掌握）
    const reviewPool = vocabStore.pickReviewWords(5);

    // 三态概览：未学习按活跃词库里还没进过档案的词算，历史 cet4 词不计入
    const activeWords = getActiveWords();
    const activeSet = new Set(activeWords.map(a => a.w));
    const unseenCount = Math.max(0, activeWords.length - all.filter(w => activeSet.has(w.w)).length);
    const masteredCount = all.filter(w => w.mastered).length;
    const learningCount = all.length - masteredCount;

    const learnedHtml = all.length
      ? `<div class="vocab-book-table">${all.map(w => {
          const stateHtml = w.mastered
            ? `<span class="vocab-book-state vocab-book-state-mastered">✓ 已掌握</span>`
            : `<span class="vocab-book-state vocab-book-state-learning">学习中</span>`;
          const markHtml = w.mastered
            ? ''
            : `<button class="vocab-btn vocab-book-mark" data-mark-mastered="${w.w}">标记已掌握</button>`;
          return `
          <div class="vocab-book-row">
            <span class="vocab-book-word">${w.w}<small>${w.ph || ''} ${w.pos || ''}</small></span>
            <span class="vocab-book-cn">${w.cn || '—'}</span>
            ${stateHtml}
            ${markHtml}
            <span class="vocab-book-meta">学过 ${w.learnCount} 次 · 连续独立答对 ${w.streak || 0} 次 · ${this.fmtTime(w.lastLearnedAt)}</span>
          </div>`;
        }).join('')}</div>`
      : `<div class="vocab-empty">还没有一起学过的词。先去背几个词，它们就会出现在这里。</div>`;

    const needyHtml = needy.length
      ? `<div class="vocab-book-table">${needy.map(w => {
          const stableNote = w.correctCount > 0
            ? ` · 已答对 ${w.correctCount} 次（错误仍留着）`
            : ' · 还没答对过';
          return `
          <div class="vocab-book-row vocab-book-row-warn">
            <span class="vocab-book-word">${w.w}</span>
            <span class="vocab-book-cn">${w.cn || '—'}</span>
            <span class="vocab-book-meta">答错 ${w.wrongCount} 次${stableNote} · 最近 ${this.fmtTime(w.lastWrongAt)}</span>
          </div>`;
        }).join('')}</div>`
      : `<div class="vocab-empty">目前没有需要特别再见面的词。继续保持就好。</div>`;

    const canChallenge = reviewPool.length > 0;
    const challengeBtn = canChallenge
      ? `<button class="vocab-btn primary" id="vocab-book-challenge">开始一轮小挑战 →</button>`
      : `<button class="vocab-btn" disabled>还没有可以挑战的词</button>`;

    this.shell(`
      <div class="vocab-book">
        <div class="vocab-book-note">✧ 这是小星和你，一页一页一起记下的词</div>
        <div class="vocab-book-overview">
          <span>还没学过 <b>${unseenCount}</b></span>
          <span>学习中 <b>${learningCount}</b></span>
          <span>已掌握 <b>${masteredCount}</b></span>
        </div>

        <div class="vocab-book-section">
          <div class="vocab-book-h">一起学过的词 <small>${all.length} 个</small></div>
          ${learnedHtml}
        </div>

        <div class="vocab-book-section">
          <div class="vocab-book-h">还要再见面的词 <small>${needy.length} 个</small></div>
          ${needyHtml}
        </div>

        <div class="vocab-book-section vocab-book-challenge">
          <div class="vocab-book-h">星星的小挑战 <small>从真实记录里挑 ${reviewPool.length} 个</small></div>
          <p class="vocab-book-desc">从你错过的、还不够熟的词里挑几个，再来一次就好。</p>
          <div class="vocab-actions">${challengeBtn}</div>
        </div>

        <div class="vocab-actions" style="justify-content:center;margin-top:22px">
          <button class="vocab-btn ghost" id="vocab-book-back">← 返回背词首页</button>
        </div>
      </div>
    `);

    const back = this.container.querySelector('#vocab-book-back');
    if (back) back.addEventListener('click', () => { this.phase = 'setup'; this.renderSetup(); });
    const chBtn = this.container.querySelector('#vocab-book-challenge');
    if (chBtn) chBtn.addEventListener('click', () => this.startChallenge());

    // 手动标记已掌握：只作用于真实档案里未掌握的词，不删学习次数与答题历史
    this.container.querySelectorAll('[data-mark-mastered]').forEach(btn => {
      btn.addEventListener('click', () => {
        const word = btn.getAttribute('data-mark-mastered');
        if (vocabStore.markMastered(word)) {
          this.setBubble('好，这个词我们算是记下了。', false);
          this.renderBook(); // 重绘后该行变为已掌握，按钮消失
        }
      });
    });
  },

  startChallenge() {
    if (!this.active) return;
    // 本地挑词，仅来自真实档案
    const picked = vocabStore.pickReviewWords(5);
    if (!picked.length) { this.setBubble('现在还没有可以挑战的词，先去记几个吧。', false); return; }

    this.epoch += 1;
    beginVocabAI(); // 小挑战作为独立一轮，预算从 0 开始，上限仍为 16

    this.challengeMode = true;
    this.challengeWords = picked;
    this.challengeRight = 0;
    this.challengeWrong = 0;
    this.roundMistakes = [];
    this.roundDetails = picked.map(w => ({ w: w.w, cn: w.cn, result: 'wrong' }));

    // 小挑战开场不调用 API：进入题目后气泡立刻切成静态陪伴文字，
    // 这里再发一句台词必然被覆盖，是白花的积分。互动留在挑战结束节点。
    this.beginChallengeQuiz();
  },

  beginChallengeQuiz() {
    if (!this.active || !this.challengeMode) return;
    const pool = getActiveWords();
    // 挑战词来自真实档案；转成完整词条以复用出题（档案缺 ex/tip 时用 findWord 补全）
    this.queue = this.challengeWords.map(entry => {
      const full = findWord(entry.w) || { w: entry.w, cn: entry.cn, ph: entry.ph, pos: entry.pos, lv: entry.lv };
      return buildQuestion(full, this.enabledTypes, pool);
    });
    this.qIndex = 0;
    this.retries = 0;
    this.locked = false;
    this.phase = 'quiz';
    this.renderQuestion();
  },

  finishChallenge() {
    if (!this.active || this.phase === 'challengeDone') return;
    this.phase = 'challengeDone';
    const total = this.challengeRight + this.challengeWrong;
    const acc = total > 0 ? Math.round((this.challengeRight / total) * 100) : 0;

    // 小挑战也作为一轮真实学习记录写入（含完整词表），刷新后仍在
    vocabStore.finishRound(this.challengeWords.length, {
      size: this.challengeWords.length,
      right: this.challengeRight,
      wrong: this.challengeWrong,
      level: 'challenge',
      words: this.roundDetails.slice()
    });

    const rows = this.roundDetails.map(d => {
      const mark = d.result === 'correct'
        ? { cls: 'ok', text: '答对' }
        : d.result === 'hintCorrect'
          ? { cls: 'hint', text: '提示后答对' }
          : { cls: 'bad', text: '答错' };
      return `<div class="vocab-hist-row"><span class="vocab-hist-word">${d.w}</span><span class="vocab-hist-cn">${d.cn || '—'}</span><span class="vocab-hist-result ${mark.cls}">${mark.text}</span></div>`;
    }).join('');

    const resultText = `挑了 ${total} 个词，答对 ${this.challengeRight} 个，答错 ${this.challengeWrong} 个。`;
    this.say('challengeSummary', { challengeResult: resultText });

    this.shell(`
      <div class="vocab-card" style="text-align:center">
        <div class="vocab-card-label">小挑战结束</div>
        <div style="font-size:44px;margin:6px 0">✧</div>
        <div class="vocab-stats">
          <div class="vocab-stat"><b>${this.challengeRight}</b><small>答对</small></div>
          <div class="vocab-stat"><b>${acc}%</b><small>正确率</small></div>
          <div class="vocab-stat"><b>${total}</b><small>挑战词</small></div>
        </div>
        <div class="vocab-card-label" style="text-align:left;margin-top:18px">这次的词</div>
        <div class="vocab-hist-table">${rows}</div>
        <div class="vocab-actions" style="justify-content:center;margin-top:20px">
          <button class="vocab-btn primary" id="vocab-chal-book">回到单词本</button>
          <button class="vocab-btn" id="vocab-chal-again">再来一轮挑战</button>
          <button class="vocab-btn ghost" id="vocab-chal-home">返回背词首页</button>
        </div>
      </div>
    `);
    const toBook = this.container.querySelector('#vocab-chal-book');
    if (toBook) toBook.addEventListener('click', () => this.enterBook());
    const again = this.container.querySelector('#vocab-chal-again');
    if (again) again.addEventListener('click', () => this.startChallenge());
    const home = this.container.querySelector('#vocab-chal-home');
    if (home) home.addEventListener('click', () => { this.phase = 'setup'; this.challengeMode = false; this.renderSetup(); });
  },

  // ---------- 阶段二：学习 ----------
  startRound() {
    // 真正开始新一轮：重置 AI 预算并中断上一轮遗留的在途请求
    // 仅此入口重置，普通渲染/答题重试/重复点击都不会经过这里
    this.epoch += 1;
    beginVocabAI();
    this.challengeMode = false;
    this.learnedThisPass = new Set();

    // 已经「结束过今天的学习」后再开一轮：算作新的一次学习
    if (this.sessionEnded || !this.session) {
      this.resetSession();
      gameEnd.dismiss();
    }

    // 新词优先：只从"从未学过、也未掌握"的活跃词里抽，当前难度优先。
    // 已学过但还没掌握的词属于复习池：只有新词不够本轮数量时才补入，
    // 且按最久没见优先，避免短时间内反复抽到同一批旧词。
    const learned = vocabStore.getLearnedWords();
    const mastered = vocabStore.getMasteredWords();
    const fresh = pickFreshWords({
      level: this.level,
      count: this.roundSize,
      learnedWords: learned,
      masteredWords: mastered
    });
    const need = Math.max(0, this.roundSize - fresh.length);
    const seen = new Set(fresh.map(w => w.w));
    const refill = need > 0
      ? vocabStore.getUnmasteredLearnedWords()
          .filter(entry => !seen.has(entry.w))
          .slice(0, need)
          .map(entry => findWord(entry.w))
          .filter(Boolean)
      : [];
    const words = fresh.concat(refill);

    // 明确区分来源：复习补入的词会在学习页标出来，不伪装成新词
    this.wordSources = {};
    fresh.forEach(w => { this.wordSources[w.w] = 'new'; });
    refill.forEach(w => { this.wordSources[w.w] = 'review'; });

    this.learnList = words;
    this.learnIndex = 0;
    this.learnMarks = new Set();
    this.bubbleText = '';
    this.bubbleThinking = false;
    this.roundLearned = words.map(w => w.w);
    this.roundMistakes = [];
    this.roundRight = 0;
    this.roundWrong = 0;
    this.streak = 0;
    this.roundDetails = words.map(w => ({ w: w.w, cn: w.cn, result: 'wrong' })); // 默认待判，答题时更新
    this.phase = 'learn';

    this.renderLearn();
  },

  renderLearn() {
    const word = this.learnList[this.learnIndex];
    if (!word) { this.beginQuiz(); return; }
    // 真正进入学习流程的词写入共同档案；同一轮同一词只记一次，重复学习会累加次数
    if (!this.learnedThisPass.has(word.w)) {
      vocabStore.recordLearn(word.w, { cn: word.cn, ph: word.ph, pos: word.pos, lv: word.lv });
      this.learnedThisPass.add(word.w);
    }
    const marked = this.learnMarks.has(word.w);

    this.shell(`
      <div class="vocab-card">
        <div class="vocab-card-label">${this.wordSources[word.w] === 'review' ? '复习词' : '新词'} · 先看一眼 · ${this.learnIndex + 1} / ${this.learnList.length}</div>
        <div class="vocab-word">${word.w}</div>
        <div class="vocab-phonetic">${word.ph} &nbsp; ${word.pos}</div>
        <div class="vocab-meaning">${word.cn}</div>
        <div class="vocab-example">${word.ex}<br><span style="color:#9a8ab8">${word.exCn}</span></div>
        <div class="vocab-actions" style="margin-top:18px">
          <button class="vocab-btn ${marked ? '' : 'primary'}" id="vocab-got">${marked ? '已记住 ✓' : '记住了'}</button>
          <button class="vocab-btn ghost" id="vocab-again">再看看</button>
          <button class="vocab-btn ghost" id="vocab-speak-word">听发音</button>
        </div>
        <div class="vocab-hint-box">记忆线索：${word.tip}</div>
      </div>
      <div class="vocab-actions">
        <button class="vocab-btn" id="vocab-next-learn">${this.learnIndex === this.learnList.length - 1 ? '开始练习 →' : ((this.learnIndex + 1) % this.groupSize === 0 ? '本组完成 · 歇一下 →' : '下一个 →')}</button>
      </div>
    `, this.progressHtml(this.learnIndex + 1, this.learnList.length));

    // 切到新词：作废上一阶段在途台词，写静态陪伴文字，避免省略号残留或旧台词覆盖
    this.settleBubble('先看一眼，不着急。记住它的样子就够了。');

    const got = this.container.querySelector('#vocab-got');
    if (got) {
      // 已标记过的词直接锁定，防止重复响应（切换单词时按钮会随重渲染恢复）
      if (marked) got.disabled = true;
      got.addEventListener('click', () => {
        if (this.learnMarks.has(word.w)) return; // 同词不再重复响应
        this.learnMarks.add(word.w);
        // 陪伴式学习：展示单词不再逐词调用 AI，只给静态陪伴文字（不消耗预算/Token）
        got.textContent = '已记住 ✓';
        got.className = 'vocab-btn';
        this.setBubble('嗯，这个见过就好。我们接着看下一个。', false);
      });
    }
    const again = this.container.querySelector('#vocab-again');
    if (again) again.addEventListener('click', () => {
      this.learnMarks.delete(word.w);
      this.speakWord(word.w);
      this.setBubble('再看一眼它的样子和例句，不着急。', false);
    });
    const speakBtn = this.container.querySelector('#vocab-speak-word');
    if (speakBtn) speakBtn.addEventListener('click', () => this.speakWord(word.w));
    const next = this.container.querySelector('#vocab-next-learn');
    if (next) next.addEventListener('click', () => {
      this.learnIndex += 1;
      if (this.learnIndex >= this.learnList.length) this.beginQuiz();
      else if (this.learnIndex % this.groupSize === 0) this.renderGroupBreak();
      else this.renderLearn();
    });
  },

  // 小组小结：每组 5 个词学完后短暂互动，不打断整体节奏
  renderGroupBreak() {
    if (!this.active) return;
    const groupNo = Math.floor(this.learnIndex / this.groupSize);
    const start = this.learnIndex - this.groupSize;
    const groupWords = this.learnList.slice(start, this.learnIndex);
    const totalGroups = Math.ceil(this.learnList.length / this.groupSize);
    const list = groupWords.map(w => `<span class="vocab-tag">${w.w}<small>${w.cn}</small></span>`).join('');

    this.shell(`
      <div class="vocab-card" style="text-align:center">
        <div class="vocab-card-label">第 ${groupNo} / ${totalGroups} 组 · 小结</div>
        <div style="font-size:40px;margin:4px 0">✧</div>
        <h3 style="color:#4a4a6a;margin:0 0 14px;letter-spacing:2px">这一组，已经见过啦</h3>
        <div class="vocab-wordlist" style="justify-content:center">${list}</div>
        <div class="vocab-actions" style="justify-content:center;margin-top:20px">
          <button class="vocab-btn primary" id="vocab-group-next">${groupNo >= totalGroups ? '开始练习 →' : '继续下一组 →'}</button>
        </div>
      </div>
    `, this.progressHtml(this.learnIndex, this.learnList.length));

    // 组间小结用独立语义；连续答对时的即时鼓励仍用 cheer（见 answer）
    this.say('groupDone', { word: groupWords.length ? groupWords[groupWords.length - 1].w : '' });
    const btn = this.container.querySelector('#vocab-group-next');
    if (btn) btn.addEventListener('click', () => {
      if (this.learnIndex >= this.learnList.length) this.beginQuiz();
      else this.renderLearn();
    });
  },

  // ---------- 阶段三：练习 ----------
  beginQuiz() {
    // 练习题目直接来自本轮学过的词，保证"学的就是练的"；干扰项也只用活跃词库
    const pool = getActiveWords();
    this.queue = this.learnList.map(word => buildQuestion(word, this.enabledTypes, pool));
    this.qIndex = 0;
    this.retries = 0;
    this.locked = false;
    this.phase = 'quiz';
    this.renderQuestion();
  },

  renderQuestion() {
    const q = this.queue[this.qIndex];
    if (!q) { if (this.challengeMode) this.finishChallenge(); else this.finishRound(); return; }
    const word = findWord(q.word);
    this.retries = 0;
    this.locked = false;

    let stageHtml = '';
    if (q.options) {
      const letters = ['A', 'B', 'C', 'D'];
      const opts = q.options.map((opt, i) => `
        <button class="vocab-option" data-value="${opt.value}">
          <span class="vocab-option-key">${letters[i]}</span>
          <span>${opt.label}</span>
        </button>
      `).join('');
      const isEn = q.type === 'word2cn';
      stageHtml = `
        <div class="vocab-card">
          <div class="vocab-card-label">${this.typeName(q.type)}</div>
          <div class="vocab-prompt ${isEn ? 'vocab-prompt-en' : ''}">${q.prompt}</div>
          <div class="vocab-prompt-sub">${q.sub || ''}</div>
          ${q.speak ? '<div class="vocab-actions" style="justify-content:center;margin-bottom:16px"><button class="vocab-btn" id="vocab-play">▶ 再听一遍</button></div>' : ''}
          <div class="vocab-options" id="vocab-options">${opts}</div>
        </div>
      `;
    } else {
      stageHtml = `
        <div class="vocab-card">
          <div class="vocab-card-label">${this.typeName(q.type)}</div>
          <div class="vocab-prompt">${q.prompt}</div>
          <div class="vocab-prompt-sub">${q.sub || ''}</div>
          <input class="vocab-spell-input" id="vocab-spell" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="输入完整单词" />
          <div class="vocab-actions" style="justify-content:center;margin-top:18px">
            <button class="vocab-btn primary" id="vocab-submit">提交答案</button>
          </div>
        </div>
      `;
    }
    stageHtml += `
      <div class="vocab-actions">
        <button class="vocab-btn ghost" id="vocab-hint">给我一点提示</button>
      </div>
      <div id="vocab-feedback"></div>
    `;

    this.shell(stageHtml, this.progressHtml(this.qIndex + 1, this.queue.length));

    // 切到新题：作废上一题在途台词，写静态过渡文字，避免省略号残留或旧台词覆盖
    this.settleBubble('这一题交给你，我在听。');

    const play = this.container.querySelector('#vocab-play');
    if (play && q.speak) play.addEventListener('click', () => this.speakWord(q.speak));

    if (q.options) {
      this.container.querySelectorAll('#vocab-options .vocab-option').forEach(btn => {
        btn.addEventListener('click', () => this.answer(btn.dataset.value, btn, q, word));
      });
    } else {
      const input = this.container.querySelector('#vocab-spell');
      const submit = this.container.querySelector('#vocab-submit');
      const doSubmit = () => {
        const val = (input.value || '').trim().toLowerCase();
        if (!val) return;
        this.answer(val, null, q, word);
      };
      if (submit) submit.addEventListener('click', doSubmit);
      if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') doSubmit(); });
      if (input) this.later(() => { if (input.isConnected) input.focus(); }, 60);
    }

    const hintBtn = this.container.querySelector('#vocab-hint');
    if (hintBtn) hintBtn.addEventListener('click', () => this.showHint(q, word));
  },

  typeName(type) {
    const t = QUESTION_TYPES.find(x => x.id === type);
    return t ? t.name : '选择正确答案';
  },

  showHint(q, word) {
    if (this.locked || !word) return;
    let box = this.container.querySelector('#vocab-hint-box-local');
    if (!box) {
      box = document.createElement('div');
      box.id = 'vocab-hint-box-local';
      box.className = 'vocab-hint-box';
      const feedback = this.container.querySelector('#vocab-feedback');
      if (feedback) feedback.parentNode.insertBefore(box, feedback);
    }
    // 玩家主动求助：用独立语义，不说"你答错了"；首次答错后的提示仍走 wrongHint（见 answer）
    box.innerHTML = `提示：<b>${word.w[0]}</b> 开头 · ${word.w.length} 个字母 · ${word.pos} · ${word.tip}`;
    this.say('askHint', { word: word.w, meaning: word.cn, example: word.ex });
  },

  answer(value, btn, q, word) {
    if (this.locked || !this.active) return;
    const correct = String(value).toLowerCase() === String(q.answer).toLowerCase();
    this.locked = true;
    this.retries += 1;

    // 视觉反馈
    if (btn) {
      if (correct) btn.classList.add('correct');
      else {
        btn.classList.add('wrong');
        this.container.querySelectorAll('#vocab-options .vocab-option').forEach(x => {
          if (x.dataset.value === q.answer) x.classList.add('correct');
        });
      }
      this.container.querySelectorAll('#vocab-options .vocab-option').forEach(x => { x.disabled = true; });
    }
    const input = this.container.querySelector('#vocab-spell');
    if (input) input.disabled = true;

    const feedback = this.container.querySelector('#vocab-feedback');
    if (feedback) {
      feedback.innerHTML = `<div class="vocab-hint-box ${correct ? '' : 'vocab-error'}">${correct ? '答对了。' : '正确答案是 ' + q.answer + '（' + (q.answerLabel || (word && word.cn) || '') + '）'}</div>`;
    }

    if (correct) {
      this.roundRight += 1;
      this.streak += 1;
      vocabStore.recordAnswer(q.word, true);
      // 写入共同单词本：只有一次答对才算独立答对；
      // 提示后/答错重试后的答对会打断逐词连续次数，不计入自动掌握。
      vocabStore.recordWordAttempt(q.word, true, {
        cn: (word && word.cn) || q.answerLabel || '',
        independent: this.retries === 1
      });
      // 明细：提示后答对 vs 直接答对
      const detail = this.roundDetails.find(d => d.w === q.word);
      if (detail) detail.result = this.retries > 1 ? 'hintCorrect' : 'correct';
      // 陪伴式学习：普通答对不调用 AI，只给静态肯定；仅连对≥3 这一关键节点触发鼓励
      if (this.streak >= 3) {
        this.say('cheer', { word: q.word, meaning: q.answerLabel || (word && word.cn), streak: this.streak });
      } else {
        this.setBubble('对了，就是这个感觉。继续。', false);
      }
      this.later(() => this.nextQuestion(), 900);
    } else {
      this.roundWrong += 1;
      this.streak = 0;
      if (!this.roundMistakes.includes(q.word)) this.roundMistakes.push(q.word);
      // 写入共同单词本：真实答错（含释义元数据），保留错误历史
      vocabStore.recordWordAttempt(q.word, false, { cn: (word && word.cn) || q.answerLabel || '' });
      // 明细：默认为 wrong；若之前被标记过 hintCorrect 则回退为 wrong（以最终作答为准）
      const detail = this.roundDetails.find(d => d.w === q.word);
      if (detail) detail.result = 'wrong';

      // 反复答错的判断：该词历史答错次数（本次已记入档案）
      const history = vocabStore.getAllWords().find(w => w.w === q.word);
      const wrongTimes = history ? history.wrongCount : 0;

      if (this.retries === 1) {
        // 第一次答错：不揭晓，给提示，重试同一题
        vocabStore.recordAnswer(q.word, false);
        if (feedback) feedback.innerHTML = `<div class="vocab-hint-box">差一点。先想想，再试一次。</div>`;
        this.say('wrongHint', { word: q.word, meaning: word && word.cn, userAnswer: value });
        this.later(() => this.retryQuestion(), 1400);
      } else {
        // 第二次答错：纠正并进入下一题；反复错则让小星换个方式解释
        if (feedback) feedback.innerHTML = `<div class="vocab-hint-box vocab-error">正确答案是 ${q.answer}（${q.answerLabel || (word && word.cn) || ''}）</div>`;
        if (wrongTimes >= 2) {
          this.say('reExplain', { word: q.word, meaning: q.answerLabel || (word && word.cn), wrongTimes });
        } else {
          this.say('retryWrong', { word: q.word, meaning: q.answerLabel || (word && word.cn), userAnswer: value });
        }
        this.later(() => this.nextQuestion(), 1800);
      }
    }
  },

  // 第一次答错后的重试：复用同一题，换一个输入框/选项状态
  retryQuestion() {
    if (!this.active || this.phase !== 'quiz') return;
    this.locked = false;
    const q = this.queue[this.qIndex];
    if (!q) { this.nextQuestion(); return; }
    const word = findWord(q.word);
    this.renderQuestion();
    // 保留"已第一次答错"的计数，避免重试被当成首次
    this.retries = 1;
    this.setBubble('再试一次，我在听。', false);
  },

  nextQuestion() {
    if (!this.active || this.phase !== 'quiz') return;
    this.qIndex += 1;
    if (this.qIndex >= this.queue.length) {
      if (this.challengeMode) {
        // 小挑战按真实结果累计正确/错误
        this.roundDetails.forEach(d => {
          if (d.result === 'correct' || d.result === 'hintCorrect') this.challengeRight += 1;
          else this.challengeWrong += 1;
        });
        this.finishChallenge();
      } else {
        this.finishRound();
      }
    } else this.renderQuestion();
  },

  // ---------- 阶段四：复习小结 ----------
  finishRound() {
    if (!this.active || this.phase === 'summary') return;
    this.phase = 'summary';
    // 完成一轮即沿用原「星球漫游」的完成标记，保留收藏馆联动（不要求全部答对）
    store.finish('planets', { completed: true });
    // 保存本轮明细：完整词表 + 每个词的英文/释义/答题结果
    vocabStore.finishRound(this.roundLearned.length, {
      size: this.learnList.length,
      right: this.roundRight,
      wrong: this.roundWrong,
      level: this.level,
      words: this.roundDetails.slice()
    });

    // 口径统一：本轮按「单词」统计——一个词不管答几次，只算一次
    // （result !== 'wrong' 含直接答对与提示后答对）
    const wordTotal = this.roundDetails.length;
    const wordRight = this.roundDetails.filter(d => d.result !== 'wrong').length;
    const wordWrong = wordTotal - wordRight;
    const acc = wordTotal > 0 ? Math.round((wordRight / wordTotal) * 100) : 0;
    const mistakes = this.roundMistakes.map(w => findWord(w)).filter(Boolean);

    // 累计到「整次学习」，供主动结束时的一句总结使用（不额外请求 API）
    if (this.session) {
      this.session.rounds += 1;
      this.session.words += wordTotal;
      this.session.right += wordRight;
      this.session.wrong += wordWrong;
      this.session.masteredAfter = vocabStore.getMasteredWords().length;
      if (!this.session.mistake && mistakes.length) this.session.mistake = mistakes[0].w;
    }
    const mistakeHtml = mistakes.length
      ? `<div class="vocab-wordlist">${mistakes.map(w => `<span class="vocab-tag">${w.w}<small>${w.cn}</small></span>`).join('')}</div>`
      : `<div class="vocab-empty">这一轮没有需要特别巩固的词，很好。</div>`;

    // 本轮完整单词明细（同样写入了存档，可在设置页「学习记录」回看）
    const detailRows = this.roundDetails.map(d => {
      const mark = d.result === 'correct'
        ? { cls: 'ok', text: '答对' }
        : d.result === 'hintCorrect'
          ? { cls: 'hint', text: '提示后答对' }
          : { cls: 'bad', text: '答错' };
      return `<div class="vocab-hist-row"><span class="vocab-hist-word">${d.w}</span><span class="vocab-hist-cn">${d.cn || '—'}</span><span class="vocab-hist-result ${mark.cls}">${mark.text}</span></div>`;
    }).join('');

    this.shell(`
      <div class="vocab-card" style="text-align:center">
        <div class="vocab-card-label">这一轮结束了</div>
        <div style="font-size:46px;margin:6px 0">✧</div>
        <h3 style="color:#4a4a6a;margin:0 0 18px;letter-spacing:2px">今晚的单词，记住了一些</h3>
        <div class="vocab-stats">
          <div class="vocab-stat"><b>${wordRight}</b><small>答对单词</small></div>
          <div class="vocab-stat"><b>${acc}%</b><small>正确率（按单词）</small></div>
          <div class="vocab-stat"><b>${this.roundLearned.length}</b><small>学过单词</small></div>
        </div>
        <div class="vocab-card-label" style="text-align:left">待巩固</div>
        ${mistakeHtml}
        <div class="vocab-card-label" style="text-align:left;margin-top:18px">本轮单词（${this.roundDetails.length}）</div>
        <div class="vocab-hist-table">${detailRows}</div>
        <div class="vocab-actions" style="justify-content:center;margin-top:20px">
          <button class="vocab-btn primary" id="vocab-again-round">再来一轮</button>
          <button class="vocab-btn" id="vocab-end-session">结束今天的学习</button>
          <button class="vocab-btn" id="vocab-back">返回大厅</button>
        </div>
      </div>
      <div class="vocab-notice">累计已掌握 ${vocabStore.getMastered().length} 个 · 待巩固 ${vocabStore.getWrongWords().length} 个</div>
    `);

    this.say('summary', { word: mistakes.length ? mistakes[0].w : '', meaning: mistakes.length ? mistakes[0].cn : '' });

    const again = this.container.querySelector('#vocab-again-round');
    if (again) again.addEventListener('click', () => this.startRound());
    const endBtn = this.container.querySelector('#vocab-end-session');
    if (endBtn) endBtn.addEventListener('click', () => this.finishSession(endBtn));
    const back = this.container.querySelector('#vocab-back');
    if (back) back.addEventListener('click', () => {
      this.endSession();
      window.PlaygroundRouter.go('lobby');
    });
  },

  // ---------- 朗读 ----------
  speakWord(word) {
    if (!word || typeof speechSynthesis === 'undefined') return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(word);
      u.lang = 'en-US';
      u.rate = 0.85;
      speechSynthesis.speak(u);
    } catch (e) { /* 浏览器不支持时静默忽略 */ }
  }
};
