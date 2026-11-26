// playground/date.js
// 第五个游戏：星夜21点（手动结算 + 星星双语总结 + 统一结算气泡返回聊天）
import { store } from './store.js';
import { gameEnd } from './game-end.js';

const API_URL = '/api';
const CHAT_KEY = 'ylxh.blackjack.chat';
const CHIPS_KEY = 'ylxh.blackjack.chips';
const ROUND_KEY = 'ylxh.blackjack.round';
const BG_KEY = 'ylxh.blackjack.bg';
const CARD_KEY = 'ylxh.blackjack.card';

/* 结算短句池：按真实输赢/爆牌区分，避免每次都是同一句 */
const END_LINES = {
  blackjack: [
    '黑杰克。今晚星星确实站在你这边。',
    '黑杰克。这一手，运气和胆量都够了。'
  ],
  win: [
    '这局你赢了。手气不错，收着点，别都压上去。',
    '赢了。看你松一口气的样子，比我赢还有意思。',
    '这局归你。要不要趁手热再来一把？'
  ],
  dealerBust: [
    '庄家爆了。这次是我先沉不住气。',
    '我爆牌了，筹码归你。别笑得太早。'
  ],
  lose: [
    '这局是我赢了。别急着翻本，先歇一下。',
    '我赢了。下一局慢一点，我给你留着位置。'
  ],
  bust: [
    '爆牌了，是我发快了？下一局我们慢一点。',
    '先停下。输一局不算什么，别把筹码都推出去。'
  ],
  dealerBlackjack: [
    '庄家黑杰克。这局不怪你，牌就是这样。',
    '黑杰克在我这边。收一收，别跟牌较劲。'
  ],
  push: [
    '平局，筹码退回来了。就当这局我们一起偷了个懒。',
    '和局。谁也没赢，倒也不错。'
  ]
};

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

const safeGet = (k, fb) => { try { const v = localStorage.getItem(k); return v == null ? fb : v; } catch { return fb; } };
const safeSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const safeDel = (k) => { try { localStorage.removeItem(k); } catch {} };

function buildDeck(n = 4) {
  const d = [];
  for (let i = 0; i < n; i++) for (const s of SUITS) for (const r of RANKS) d.push({ suit: s, rank: r });
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function handValue(hand) {
  let total = 0, aces = 0;
  for (const c of hand) {
    if (c.rank === 'A') { aces++; total += 11; }
    else if (['J', 'Q', 'K'].includes(c.rank)) total += 10;
    else total += parseInt(c.rank, 10);
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

const isBust = h => handValue(h) > 21;
const isBJ = h => h.length === 2 && handValue(h) === 21;
const suitClass = s => s === '♥' ? 'heart' : s === '♦' ? 'diamond' : s === '♠' ? 'spade' : 'club';
const escapeHTML = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function compressImage(file, maxSize = 800) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        try { resolve(canvas.toDataURL('image/jpeg', 0.85)); } catch (e) { reject(e); }
      };
      img.onerror = () => reject(new Error('load fail'));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error('read fail'));
    reader.readAsDataURL(file);
  });
}

export const DateScene = {
  container: null,
  deck: [],
  playerHand: [],
  dealerHand: [],
  dealerHoleRevealed: false,
  chips: 1000,
  bet: 0,
  round: 1,
  phase: 'betting', // betting | playerTurn | pendingSettle | dealerTurn | settle
  busy: false,
  message: '',
  chatHistory: [],
  thinkingId: 0,
  chatBooted: false,
  sending: false,
  summarizing: false,
  memorialized: false,
  bgImage: null,
  cardImage: null,
  lastResult: '',
  gameSerial: 0,      // 每局唯一序号：结算消息去重
  endPublished: false,// 本局是否已经弹过结算气泡
  summaryDone: false, // 本局是否已经让星星总结过（避免重复请求）
  bubbleToken: '',

  mount(el) {
    this.container = el;
    this.chips = parseInt(safeGet(CHIPS_KEY, '1000'), 10) || 1000;
    this.round = parseInt(safeGet(ROUND_KEY, '1'), 10) || 1;
    try { this.chatHistory = JSON.parse(safeGet(CHAT_KEY, '[]')) || []; } catch { this.chatHistory = []; }
    this.bgImage = safeGet(BG_KEY, null);
    this.cardImage = safeGet(CARD_KEY, null);

    this.deck = [];
    this.playerHand = [];
    this.dealerHand = [];
    this.dealerHoleRevealed = false;
    this.bet = 0;
    this.phase = 'betting';
    this.busy = false;
    this.thinkingId = 0;
    this.chatBooted = false;
    this.sending = false;
    this.summarizing = false;
    this.memorialized = false;
    this.lastResult = '';
    this.gameSerial += 1;
    this.endPublished = false;
    this.summaryDone = false;
    this.bubbleToken = '';
    this.message = '下注，然后我们开始吧。';

    this.injectStyles();
    this.render();
    this.applyImages();
    setTimeout(() => this.bootChat(), 200);
  },

  unmount() {
    this.thinkingId++;
    if (this.container) {
      this.container.innerHTML = '';
      this.container = null;
    }
  },

  applyImages() {
    try {
      const root = document.documentElement;
      if (this.bgImage) root.style.setProperty('--bj-bg', `url("${this.bgImage}")`);
      else root.style.removeProperty('--bj-bg');
      if (this.cardImage) root.style.setProperty('--bj-card-img', `url("${this.cardImage}")`);
      else root.style.removeProperty('--bj-card-img');
    } catch {}
  },

  injectStyles() {
    if (document.getElementById('bj-styles')) return;
    const s = document.createElement('style');
    s.id = 'bj-styles';
    s.textContent = `
      .bj-scene { max-width: 680px; margin: 20px auto; padding: 22px 18px 26px; border-radius: 24px;
        background: linear-gradient(160deg, #faf5ff 0%, #f3e8ff 40%, #ede4ff 70%, #e8ecff 100%);
        color: #3b0764; border: 1px solid rgba(168,85,247,.25);
        box-shadow: 0 12px 40px rgba(139,92,246,.18);
        position: relative; overflow: hidden; font-family: inherit; }
      .bj-scene.has-bg { background-image: var(--bj-bg); background-size: cover; background-position: center; }
      .bj-scene.has-bg::before { content: ''; position: absolute; inset: 0;
        background: linear-gradient(180deg, rgba(255,255,255,.72), rgba(243,232,255,.85)); pointer-events: none; }
      .bj-scene > * { position: relative; z-index: 1; }

      .bj-header { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 12px; }
      .bj-header h2 { margin: 4px 0; font-size: 22px; color: #6d28d9; }
      .bj-eyebrow { font-size: 10px; letter-spacing: 3px; color: #9333ea; opacity: .7; }
      .bj-exit { border: 1px solid rgba(168,85,247,.3); background: rgba(255,255,255,.6); color: #6d28d9;
        border-radius: 20px; padding: 7px 14px; cursor: pointer; font-size: 12px; transition: all .2s; }
      .bj-exit:hover { background: rgba(255,255,255,.9); }

      .bj-settings { margin-bottom: 14px; background: rgba(255,255,255,.55);
        border: 1px solid rgba(168,85,247,.2); border-radius: 12px; padding: 8px 12px; }
      .bj-settings summary { cursor: pointer; font-size: 12px; color: #6d28d9; font-weight: 600; user-select: none; }
      .bj-settings-body { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
      .bj-upload { display: inline-block; padding: 6px 12px; border-radius: 8px;
        background: linear-gradient(180deg, #a855f7, #9333ea); color: #fff;
        font-size: 12px; font-weight: 700; cursor: pointer;
        box-shadow: 0 3px 10px rgba(147,51,234,.3); }
      .bj-btn-small { padding: 6px 12px; border-radius: 8px;
        background: rgba(255,255,255,.7); border: 1px solid rgba(168,85,247,.25);
        color: #6d28d9; font-size: 12px; cursor: pointer; }
      .bj-hint { font-size: 11px; color: #7e6ba8; }

      .bj-table { margin-bottom: 16px; }
      .bj-stats { display: flex; justify-content: space-between; padding: 8px 12px;
        border-radius: 10px; background: rgba(255,255,255,.55);
        border: 1px solid rgba(168,85,247,.15); margin-bottom: 12px;
        font-size: 12px; color: #6b21a8; }
      .bj-stats b { color: #a855f7; }

      .bj-side { margin-bottom: 10px; }
      .bj-side-head { display: flex; justify-content: space-between; margin-bottom: 6px;
        font-size: 12px; color: #6b21a8; font-weight: 600; }
      .bj-pts { color: #a855f7; }
      .bj-hand { display: flex; gap: 6px; min-height: 76px; flex-wrap: wrap; }

      .bj-card { width: 54px; height: 76px; border-radius: 10px;
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        font-weight: 800; font-size: 16px; border: 1px solid rgba(168,85,247,.3);
        box-shadow: 0 3px 10px rgba(109,40,217,.15), inset 0 0 0 1px rgba(255,255,255,.7);
        animation: bj-deal .2s ease-out; user-select: none; overflow: hidden; position: relative; }
      @keyframes bj-deal { from { transform: translateY(-10px); opacity: 0; } }
      .bj-card .suit { font-size: 20px; line-height: 1; }
      .bj-card.spade   { background: linear-gradient(160deg, #f3e8ff, #ddd0ff); color: #6d28d9; }
      .bj-card.heart   { background: linear-gradient(160deg, #ffe4f1, #ffc9e0); color: #db2777; }
      .bj-card.diamond { background: linear-gradient(160deg, #fff0e0, #ffd9b8); color: #ea580c; }
      .bj-card.club    { background: linear-gradient(160deg, #e6ecff, #cdd8ff); color: #4338ca; }
      .bj-card.has-img { background-image: var(--bj-card-img); background-size: cover;
        background-position: center; color: #fff; }
      .bj-card.has-img::before { content: ''; position: absolute; inset: 0;
        background: linear-gradient(180deg, rgba(0,0,0,.12), rgba(0,0,0,.35)); pointer-events: none; }
      .bj-card.has-img > * { position: relative;
        text-shadow: 0 1px 3px rgba(0,0,0,.9), 0 0 8px rgba(0,0,0,.7); }
      .bj-card.back { background: repeating-linear-gradient(45deg, #d8b4fe 0 6px, #a855f7 6px 12px);
        color: transparent; border-color: rgba(168,85,247,.5); }
      .bj-card.back::after { content: '✦'; color: #fff; font-size: 20px;
        text-shadow: 0 0 8px #d8b4fe; position: absolute; inset: 0;
        display: flex; align-items: center; justify-content: center; }

      .bj-message { text-align: center; padding: 10px; font-size: 13px; color: #6d28d9;
        min-height: 22px; font-weight: 500; }

      .bj-chips { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; margin: 8px 0; }
      .bj-chip { width: 50px; height: 50px; border-radius: 50%;
        border: 2px dashed rgba(255,255,255,.85); color: #fff; font-weight: 800;
        font-size: 13px; cursor: pointer; padding: 0; transition: transform .1s; }
      .bj-chip:hover { transform: translateY(-2px) scale(1.05); }
      .bj-chip[data-bet="10"]  { background: radial-gradient(circle at 30% 30%, #f9a8d4, #ec4899 70%); box-shadow: 0 4px 12px rgba(236,72,153,.35); }
      .bj-chip[data-bet="25"]  { background: radial-gradient(circle at 30% 30%, #d8b4fe, #a855f7 70%); box-shadow: 0 4px 12px rgba(168,85,247,.35); }
      .bj-chip[data-bet="50"]  { background: radial-gradient(circle at 30% 30%, #a5b4fc, #6366f1 70%); box-shadow: 0 4px 12px rgba(99,102,241,.35); }
      .bj-chip[data-bet="100"] { background: radial-gradient(circle at 30% 30%, #fdba74, #f97316 70%); box-shadow: 0 4px 12px rgba(249,115,22,.35); }
      .bj-chip[data-bet="500"] { background: radial-gradient(circle at 30% 30%, #fde68a, #fbbf24 70%); box-shadow: 0 4px 12px rgba(251,191,36,.35); }

      .bj-actions { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; margin-top: 8px; }
      .bj-btn { padding: 9px 20px; border-radius: 12px;
        border: 1px solid rgba(168,85,247,.3); background: rgba(255,255,255,.7);
        color: #6d28d9; cursor: pointer; font-size: 13px; font-weight: 700; transition: all .2s; }
      .bj-btn:hover:not(:disabled) { background: #fff; transform: translateY(-1px); }
      .bj-btn:disabled { opacity: .45; cursor: not-allowed; }
      .bj-btn.primary { background: linear-gradient(180deg, #a855f7, #9333ea); color: #fff;
        border-color: transparent; box-shadow: 0 4px 12px rgba(147,51,234,.3); }
      .bj-btn.primary:hover:not(:disabled) { box-shadow: 0 6px 16px rgba(147,51,234,.45); }

      .bj-chat { margin-top: 16px; border-top: 1px solid rgba(168,85,247,.2); padding-top: 14px;
        transition: box-shadow .3s; }
      .bj-chat.highlight { animation: bj-flash 1.2s ease; }
      @keyframes bj-flash {
        0%, 100% { box-shadow: none; }
        30% { box-shadow: 0 0 0 4px rgba(168,85,247,.35), 0 0 30px rgba(168,85,247,.4); }
      }
      .bj-chat-head { display: flex; justify-content: space-between; align-items: center;
        margin-bottom: 8px; font-size: 13px; color: #6b21a8; font-weight: 600; }
      .bj-chat-log { max-height: 220px; overflow-y: auto; padding: 10px;
        background: rgba(255,255,255,.6); border-radius: 12px;
        border: 1px solid rgba(168,85,247,.15);
        display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px; min-height: 80px; }
      .bj-bubble { max-width: 85%; padding: 8px 12px; border-radius: 12px; font-size: 13px;
        line-height: 1.5; word-break: break-word; white-space: pre-wrap; }
      .bj-bubble.ai { align-self: flex-start; background: linear-gradient(180deg, #f3e8ff, #e9d5ff);
        color: #3b0764; border-bottom-left-radius: 4px; }
      .bj-bubble.me { align-self: flex-end; background: linear-gradient(180deg, #a855f7, #9333ea);
        color: #fff; border-bottom-right-radius: 4px; }
      .bj-bubble .who { display: block; font-size: 10px; opacity: .65; margin-bottom: 3px; }
      .bj-bubble .en { display: block; margin-top: 4px; opacity: .7; font-size: 11px; font-style: italic; }
      .bj-chat-form { display: flex; gap: 8px; }
      .bj-chat-input { flex: 1; padding: 9px 14px; border-radius: 12px;
        border: 1px solid rgba(168,85,247,.3); background: rgba(255,255,255,.85);
        color: #3b0764; font-size: 13px; outline: none; }
      .bj-chat-input:focus { border-color: #a855f7; box-shadow: 0 0 0 3px rgba(168,85,247,.15); }
      .bj-send { padding: 0 18px; border-radius: 12px; border: 0;
        background: linear-gradient(180deg, #a855f7, #9333ea); color: #fff;
        font-weight: 700; font-size: 13px; cursor: pointer; }
      .bj-send:disabled { opacity: .5; cursor: not-allowed; }
    `;
    document.head.appendChild(s);
  },

  render() {
    if (!this.container) return;
    this.container.innerHTML = `
      <section class="bj-scene ${this.bgImage ? 'has-bg' : ''}" id="bj-scene-root">
        <header class="bj-header">
          <div>
            <div class="bj-eyebrow">STAR CASINO</div>
            <h2>✦ 星夜21点</h2>
          </div>
          <button class="bj-exit" id="bj-exit">返回大厅</button>
        </header>

        <details class="bj-settings">
          <summary>🎨 外观设置（背景和牌面都可以自己上传）</summary>
          <div class="bj-settings-body">
            <label class="bj-upload">上传背景<input type="file" id="bj-bg-input" accept="image/*" hidden></label>
            <label class="bj-upload">上传牌面<input type="file" id="bj-card-input" accept="image/*" hidden></label>
            <button class="bj-btn-small" id="bj-reset-bg">默认背景</button>
            <button class="bj-btn-small" id="bj-reset-card">默认牌面</button>
            <span class="bj-hint" id="bj-hint"></span>
          </div>
        </details>

        <div class="bj-table">
          <div class="bj-stats">
            <span>筹码 <b>${this.chips}</b></span>
            <span>下注 <b>${this.bet}</b></span>
            <span>局数 <b>${this.round}</b></span>
          </div>

          <div class="bj-side">
            <div class="bj-side-head"><span>庄家 · 星星</span><span class="bj-pts">${this.dealerPts()}</span></div>
            <div class="bj-hand">${this.dealerCardsHTML()}</div>
          </div>

          <div class="bj-side">
            <div class="bj-side-head"><span>闲家 · 用户</span><span class="bj-pts">${this.playerPts()}</span></div>
            <div class="bj-hand">${this.playerCardsHTML()}</div>
          </div>

          <div class="bj-message">${escapeHTML(this.message)}</div>
          <div class="bj-controls">${this.controlsHTML()}</div>
        </div>

        <div class="bj-chat" id="bj-chat-area">
          <div class="bj-chat-head">
            <span>💬 和星星说话</span>
          </div>
          <div class="bj-chat-log" id="bj-chat-log"></div>
          <form class="bj-chat-form" id="bj-chat-form">
            <input class="bj-chat-input" id="bj-chat-input" placeholder="说点什么…" autocomplete="off">
            <button class="bj-send" type="submit" id="bj-send">发送</button>
          </form>
        </div>
      </section>
    `;

    this.bindEvents();
    this.renderChatLog();
  },

  dealerPts() {
    if (!this.dealerHand.length) return '?';
    if (!this.dealerHoleRevealed && this.dealerHand.length >= 2) return handValue([this.dealerHand[0]]) + '+';
    return handValue(this.dealerHand);
  },
  playerPts() { return this.playerHand.length ? handValue(this.playerHand) : '0'; },

  dealerCardsHTML() {
    return this.dealerHand.map((c, i) => {
      if (i === 1 && !this.dealerHoleRevealed) return '<div class="bj-card back"></div>';
      return this.cardHTML(c);
    }).join('');
  },
  playerCardsHTML() { return this.playerHand.map(c => this.cardHTML(c)).join(''); },
  cardHTML(c) {
    const cls = 'bj-card ' + suitClass(c.suit) + (this.cardImage ? ' has-img' : '');
    return `<div class="${cls}"><div>${c.rank}</div><div class="suit">${c.suit}</div></div>`;
  },

  controlsHTML() {
    if (this.phase === 'betting') {
      if (this.chips < 10) {
        return `<div class="bj-actions"><button class="bj-btn primary" id="bj-deal">补充筹码</button></div>`;
      }
      return `
        <div class="bj-chips">
          <button class="bj-chip" data-bet="10">10</button>
          <button class="bj-chip" data-bet="25">25</button>
          <button class="bj-chip" data-bet="50">50</button>
          <button class="bj-chip" data-bet="100">100</button>
          <button class="bj-chip" data-bet="500">500</button>
        </div>
        <div class="bj-actions">
          <button class="bj-btn" id="bj-clear">清空</button>
          <button class="bj-btn primary" id="bj-deal" ${this.bet <= 0 ? 'disabled' : ''}>发牌</button>
        </div>
      `;
    }
    if (this.phase === 'playerTurn') {
      const canDouble = this.playerHand.length === 2 && this.bet <= this.chips;
      return `
        <div class="bj-actions">
          <button class="bj-btn primary" id="bj-hit">要牌</button>
          <button class="bj-btn" id="bj-stand">停牌</button>
          <button class="bj-btn primary" id="bj-double" ${canDouble ? '' : 'disabled'}>双倍</button>
        </div>
      `;
    }
    if (this.phase === 'pendingSettle') {
      return `
        <div class="bj-actions">
          <button class="bj-btn primary" id="bj-settle">结算本局</button>
        </div>
      `;
    }
    if (this.phase === 'settle') {
      const ask = this.summaryDone
        ? ''
        : `<button class="bj-btn primary" id="bj-ask-star" ${this.summarizing ? 'disabled' : ''}>
            ${this.summarizing ? '星星正在想…' : '让星星总结本局'}
          </button>`;
      return `
        <div class="bj-actions">
          ${ask}
          <button class="bj-btn" id="bj-next">下一局</button>
        </div>
      `;
    }
    return '';
  },

  bindEvents() {
    if (!this.container) return;

    this.container.querySelector('#bj-exit')?.addEventListener('click', () => window.PlaygroundRouter.go('lobby'));
    this.container.querySelector('#bj-bg-input')?.addEventListener('change', e => this.handleUpload(e, 'bg'));
    this.container.querySelector('#bj-card-input')?.addEventListener('change', e => this.handleUpload(e, 'card'));
    this.container.querySelector('#bj-reset-bg')?.addEventListener('click', () => this.resetImage('bg'));
    this.container.querySelector('#bj-reset-card')?.addEventListener('click', () => this.resetImage('card'));

    this.container.querySelectorAll('.bj-chip').forEach(btn => {
      btn.addEventListener('click', () => this.addBet(parseInt(btn.dataset.bet, 10)));
    });
    this.container.querySelector('#bj-clear')?.addEventListener('click', () => this.clearBet());
    this.container.querySelector('#bj-deal')?.addEventListener('click', () => this.deal());
    this.container.querySelector('#bj-hit')?.addEventListener('click', () => this.hit());
    this.container.querySelector('#bj-stand')?.addEventListener('click', () => this.stand());
    this.container.querySelector('#bj-double')?.addEventListener('click', () => this.double());
    this.container.querySelector('#bj-settle')?.addEventListener('click', () => this.startSettle());
    this.container.querySelector('#bj-ask-star')?.addEventListener('click', () => this.askStarSummary());
    this.container.querySelector('#bj-next')?.addEventListener('click', () => this.nextRound());

    this.container.querySelector('#bj-chat-form')?.addEventListener('submit', e => {
      e.preventDefault();
      const input = this.container.querySelector('#bj-chat-input');
      const text = input?.value?.trim();
      if (!text) return;
      input.value = '';
      this.sendChat(text);
    });
  },

  // ===== 图片上传 =====
  async handleUpload(e, kind) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) { this.showHint('请选择图片文件'); return; }
    try {
      this.showHint('处理中…');
      const dataUrl = await compressImage(file, 800);
      if (kind === 'bg') {
        this.bgImage = dataUrl;
        safeSet(BG_KEY, dataUrl);
        this.container.querySelector('#bj-scene-root')?.classList.add('has-bg');
      } else {
        this.cardImage = dataUrl;
        safeSet(CARD_KEY, dataUrl);
      }
      this.applyImages();
      if (kind === 'card') this.render();
      this.showHint(kind === 'bg' ? '背景已更新' : '牌面已更新');
    } catch {
      this.showHint('图片读取失败，换一张试试');
    }
  },
  resetImage(kind) {
    if (kind === 'bg') {
      this.bgImage = null;
      safeDel(BG_KEY);
      this.container.querySelector('#bj-scene-root')?.classList.remove('has-bg');
    } else {
      this.cardImage = null;
      safeDel(CARD_KEY);
    }
    this.applyImages();
    this.render();
    this.showHint(kind === 'bg' ? '已恢复默认背景' : '已恢复默认牌面');
  },
  showHint(text) {
    const hint = this.container?.querySelector('#bj-hint');
    if (hint) hint.textContent = text;
  },

  // ===== 牌局 =====
  addBet(n) {
    if (this.phase !== 'betting') return;
    if (n > this.chips - this.bet) { this.message = '筹码不够加这个注。'; this.render(); return; }
    this.bet += n;
    this.message = `本局下注 ${this.bet}，点击发牌开始。`;
    this.render();
  },
  clearBet() {
    if (this.phase !== 'betting') return;
    this.bet = 0;
    this.message = '下注已清空。';
    this.render();
  },
  draw() {
    if (this.deck.length < 20) this.deck = buildDeck();
    return this.deck.pop();
  },
  deal() {
    if (this.phase !== 'betting') return;
    if (this.chips < 10) {
      this.chips = 1000;
      safeSet(CHIPS_KEY, '1000');
      this.message = '筹码已补充到 1000，请重新下注。';
      this.render();
      return;
    }
    if (this.bet <= 0) { this.message = '先下注。'; this.render(); return; }
    if (this.bet > this.chips) { this.message = '下注超过筹码。'; this.render(); return; }

    this.chips -= this.bet;
    safeSet(CHIPS_KEY, this.chips.toString());

    this.playerHand = [this.draw(), this.draw()];
    this.dealerHand = [this.draw(), this.draw()];
    this.dealerHoleRevealed = false;
    this.phase = 'playerTurn';
    this.message = '你的回合：要牌、停牌，还是双倍？';
    this.render();

    if (isBJ(this.playerHand)) {
      this.message = '黑杰克！点“结算本局”看结果。';
      this.phase = 'pendingSettle';
      this.render();
    }
  },
  hit() {
    if (this.phase !== 'playerTurn' || this.busy) return;
    this.playerHand.push(this.draw());
    if (isBust(this.playerHand)) {
      this.message = `你爆牌了（${handValue(this.playerHand)} 点）。可以聊聊，再点“结算本局”。`;
      this.phase = 'pendingSettle';
      this.render();
      return;
    }
    if (handValue(this.playerHand) === 21) {
      this.message = '你到 21 点，可以点“结算本局”看结果。';
      this.phase = 'pendingSettle';
      this.render();
      return;
    }
    this.message = `你当前 ${handValue(this.playerHand)} 点，继续？`;
    this.render();
  },
  stand() {
    if (this.phase !== 'playerTurn' || this.busy) return;
    this.message = '你已停牌，可以聊聊，再点“结算本局”。';
    this.phase = 'pendingSettle';
    this.render();
  },
  double() {
    if (this.phase !== 'playerTurn' || this.busy) return;
    if (this.playerHand.length !== 2) return;
    if (this.bet > this.chips) { this.message = '筹码不够双倍。'; this.render(); return; }
    this.chips -= this.bet;
    this.bet *= 2;
    safeSet(CHIPS_KEY, this.chips.toString());
    this.playerHand.push(this.draw());
    if (isBust(this.playerHand)) this.message = `双倍后爆牌（${handValue(this.playerHand)} 点）。可以聊聊，再点“结算本局”。`;
    else this.message = `双倍下注 ${this.bet}，可以点“结算本局”看结果。`;
    this.phase = 'pendingSettle';
    this.render();
  },

  // 手动触发结算：庄家行动 + settle
  startSettle() {
    if (this.phase !== 'pendingSettle') return;
    this.phase = 'dealerTurn';
    this.render();
    setTimeout(() => this.dealerPlay(), 300);
  },

  async dealerPlay() {
    this.phase = 'dealerTurn';
    this.busy = true;
    this.render();
    await new Promise(r => setTimeout(r, 500));
    this.dealerHoleRevealed = true;
    this.render();
    await new Promise(r => setTimeout(r, 500));

    if (isBust(this.playerHand) || isBJ(this.playerHand)) { this.settle(); return; }

    while (handValue(this.dealerHand) < 17) {
      this.dealerHand.push(this.draw());
      this.message = `庄家要牌，当前 ${handValue(this.dealerHand)} 点。`;
      this.render();
      await new Promise(r => setTimeout(r, 700));
    }
    this.settle();
  },

  settle() {
    this.phase = 'settle';
    this.busy = false;
    this.dealerHoleRevealed = true;

    const pv = handValue(this.playerHand);
    const dv = handValue(this.dealerHand);
    const pBJ = isBJ(this.playerHand);
    const dBJ = isBJ(this.dealerHand);

    let text = '', payout = 0, outcome = 'lose';

    if (pv > 21) { text = `你爆牌（${pv}），输掉 ${this.bet}。`; outcome = 'bust'; }
    else if (pBJ && !dBJ) { payout = Math.floor(this.bet * 2.5); text = `黑杰克！赔 3:2，你赢得 ${payout - this.bet} 筹码。`; outcome = 'blackjack'; }
    else if (dBJ && !pBJ) { text = `庄家黑杰克，你输掉 ${this.bet}。`; outcome = 'dealerBlackjack'; }
    else if (pBJ && dBJ) { payout = this.bet; text = '双方都是黑杰克，平局退回下注。'; outcome = 'push'; }
    else if (dv > 21) { payout = this.bet * 2; text = `庄家爆牌（${dv}），你赢得 ${this.bet} 筹码。`; outcome = 'dealerBust'; }
    else if (pv > dv) { payout = this.bet * 2; text = `你 ${pv} : ${dv} 庄家，你赢得 ${this.bet} 筹码。`; outcome = 'win'; }
    else if (pv < dv) { text = `你 ${pv} : ${dv} 庄家，你输掉 ${this.bet}。`; outcome = 'lose'; }
    else { payout = this.bet; text = `双方都是 ${pv} 点，平局退回下注。`; outcome = 'push'; }

    this.chips += payout;
    safeSet(CHIPS_KEY, this.chips.toString());
    this.lastResult = text;
    this.bet = 0;
    this.message = text + ' 想让星星总结这局吗？';
    this.render();

    // 结算节点：只弹一次本地气泡（0 次 API）；用户想要更细的总结再点按钮
    this.publishEnd(outcome);

    this.memorialize();
    if (this.chips < 10) {
      this.message = text + ' 筹码不足，下一局自动补充到 1000。';
      this.render();
    }
  },

  nextRound() {
    if (this.phase !== 'settle') return;
    this.round++;
    this.gameSerial++;
    this.endPublished = false;
    this.summaryDone = false;
    this.bubbleToken = '';
    gameEnd.dismiss();
    safeSet(ROUND_KEY, this.round.toString());
    this.phase = 'betting';
    if (this.chips < 10) {
      this.chips = 1000;
      safeSet(CHIPS_KEY, '1000');
      this.message = '筹码已补充到 1000，请下注。';
    } else {
      this.message = '请下注。';
    }
    this.render();
  },
  memorialize() {
    if (this.memorialized) return;
    this.memorialized = true;
    try {
      store.finish('date', { completed: true, place: 'casino', activity: 'blackjack', at: new Date().toISOString() });
      store.save?.();
    } catch (e) { console.warn('[blackjack] store 集成失败：', e); }
  },

  // ===== 结算气泡：每局只弹一次，0 次 API =====
  publishEnd(outcome) {
    if (this.endPublished) return;
    this.endPublished = true;
    this.bubbleToken = `blackjack:${this.gameSerial}`;
    gameEnd.show({
      game: 'blackjack',
      gameName: '星夜21点',
      token: this.bubbleToken,
      line: gameEnd.pickLine(END_LINES[outcome] || END_LINES.lose),
      result: this.lastResult
    });
  },

  // ===== 星星双语总结：保留原有 AI 能力，每局最多请求一次 =====
  async askStarSummary() {
    if (this.summarizing || this.summaryDone) return;
    this.summarizing = true;
    this.render();

    let cn = '';
    let en = '';
    try {
      const summary = await this.generateSummary();
      if (!summary) throw new Error('empty');
      const lines = summary.split('\n').map(s => s.trim()).filter(Boolean);
      cn = lines[0] || summary;
      en = lines[1] || '';
    } catch {
      cn = '这局结束了。不过和你一起玩的每一局，我都记得。';
      en = 'This round is over, but I remember every game we play.';
    }

    this.summarizing = false;
    this.summaryDone = true;

    // 存进牌桌内的聊天记录（原有行为，不动）
    this.chatHistory.push({ role: 'assistant', content: cn + (en ? '\n' + en : '') });
    this.persistChat();
    this.renderChatLog();

    // 用 AI 总结替换气泡文案；英文一起带上，回到房间聊天时不再额外翻译
    const updated = gameEnd.update({
      token: this.bubbleToken,
      line: cn,
      english: en,
      result: this.lastResult
    });
    if (!updated) {
      gameEnd.show({
        game: 'blackjack',
        gameName: '星夜21点',
        token: this.bubbleToken,
        line: cn,
        english: en,
        result: this.lastResult
      });
    }
    this.render();
  },

  async generateSummary() {
    const context = this.gameContext();
    const result = this.lastResult;
    const system = `你在扮演《恋与深空》的小星，在星夜赌场当荷官，和用户玩21点。
性格：光风霁月、慵懒、温柔、保护欲强、隐藏的克制胜负欲，不油腻不轻浮。
当前牌桌状态：${JSON.stringify(context)}
本局结果：${result}

请用一句话总结这局牌局，必须返回中英双语，格式严格如下（两行，不要编号、不要引号、不要额外说明）：
中文一句话
English sentence in one line

要求：中文温柔自然，英文地道流畅，两句意思一致。`;

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        temperature: 0.8,
        max_tokens: 160,
        messages: [{ role: 'system', content: system }, { role: 'user', content: '请总结这一局。' }]
      })
    });
    if (!res.ok) throw new Error('API ' + res.status);
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || '';
  },

  // ===== 聊天 =====
  renderChatLog() {
    const log = this.container?.querySelector('#bj-chat-log');
    if (!log) return;
    log.innerHTML = this.chatHistory.length
      ? this.chatHistory.map(m => {
          if (m.role === 'user') return `<div class="bj-bubble me">${escapeHTML(m.content)}</div>`;
          const parts = m.content.split('\n');
          const cn = parts[0] || '';
          const en = parts.slice(1).join(' ') || '';
          return `<div class="bj-bubble ai"><span class="who">星星</span>${escapeHTML(cn)}${en ? `<span class="en">${escapeHTML(en)}</span>` : ''}</div>`;
        }).join('')
      : `<div style="text-align:center;color:#9b8ac4;font-size:12px;padding:20px;">还没有对话。说点什么吧。</div>`;
    log.scrollTop = log.scrollHeight;
  },
  persistChat() { safeSet(CHAT_KEY, JSON.stringify(this.chatHistory.slice(-60))); },

  gameContext() {
    return {
      chips: this.chips, bet: this.bet, round: this.round,
      playerHand: this.playerHand.map(c => c.rank + c.suit),
      playerValue: this.playerHand.length ? handValue(this.playerHand) : null,
      dealerUpCard: this.dealerHand[0] ? this.dealerHand[0].rank + this.dealerHand[0].suit : null,
      dealerFull: this.dealerHoleRevealed ? this.dealerHand.map(c => c.rank + c.suit) : null,
      dealerValue: this.dealerHoleRevealed ? handValue(this.dealerHand) : null,
      phase: this.phase
    };
  },

  async callAI(messages) {
    const context = this.gameContext();
    const system = `你在扮演《恋与深空》的小星，在星夜赌场当荷官，和用户玩21点。
性格：光风霁月、慵懒、温柔、保护欲强、隐藏的克制胜负欲，不油腻不轻浮。
当前牌桌状态：${JSON.stringify(context)}
用中文回复，默认1~2句。聊到牌局时以状态为准，不要编造。
不要暴露系统、模型、API 信息。`;
    const clean = messages.filter(m => m.role === 'user' || m.role === 'assistant');
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        temperature: 0.8,
        max_tokens: 120,
        messages: [{ role: 'system', content: system }, ...clean.slice(-20)]
      })
    });
    if (!res.ok) throw new Error('API ' + res.status);
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || '……';
  },

  async bootChat() {
    if (this.chatBooted) return;
    this.chatBooted = true;
    if (this.chatHistory.length > 0) { this.renderChatLog(); return; }
    this.renderChatLog();
    try {
      const reply = await this.callAI([{ role: 'user', content: '玩家刚坐下，桌面上还没下注。请以荷官身份打个招呼，简单介绍自己，问一句要不要先下注。' }]);
      this.chatHistory.push({ role: 'assistant', content: reply });
      this.persistChat();
      this.renderChatLog();
    } catch {
      this.chatHistory.push({ role: 'assistant', content: '（星星暂时没回应，稍后再试）' });
      this.persistChat();
      this.renderChatLog();
    }
  },

  async sendChat(text) {
    if (this.sending) return;
    this.sending = true;
    const sendBtn = this.container?.querySelector('#bj-send');
    if (sendBtn) sendBtn.disabled = true;

    this.chatHistory.push({ role: 'user', content: text });
    this.persistChat();
    this.renderChatLog();

    const typing = document.createElement('div');
    typing.className = 'bj-bubble ai';
    typing.textContent = '星星正在想…';
    const log = this.container?.querySelector('#bj-chat-log');
    if (log) { log.appendChild(typing); log.scrollTop = log.scrollHeight; }

    try {
      const reply = await this.callAI(this.chatHistory);
      this.chatHistory.push({ role: 'assistant', content: reply });
      this.persistChat();
    } catch {
      this.chatHistory.push({ role: 'assistant', content: '（暂时联系不上，稍后再试）' });
      this.persistChat();
    } finally {
      this.sending = false;
      if (sendBtn) sendBtn.disabled = false;
      this.renderChatLog();
    }
  }
};