/* =====================================================
   星空游乐场 · 统一结算消息层
   负责：
   1) 右下角「小星」结算气泡（全场景共用一套样式与交互）
   2) 同一结束事件只出现一次（token 去重，重渲染/返回游戏都不会重复）
   3) 近期台词去重（本地环形记录，优先避开刚说过的话）
   4) 点击气泡 → 写入 pending_chat_message → 回到房间聊天

   约定：
   - 本模块只做展示与交接，不发起任何 AI 请求。
     气泡文案由各游戏用自己的既有 AI 能力生成后传入；没有 AI 的模块传本地短句。
   - 不碰电台音频、不碰收藏数据、不碰大厅路由。
   ===================================================== */

import { addKeep, findKeepBySource } from '../shared/room-keeps.js';

const RECENT_KEY = 'ylxh.game.recentLines';
const SHOWN_KEY = 'ylxh.game.shownEvents';
const KEEP_STATE_KEY = 'ylxh.game.keepState';
const PENDING_KEY = 'pending_chat_message';
const BUBBLE_ID = 'pg-end-bubble';
const STYLE_ID = 'game-end-styles';

const RECENT_MAX = 24;
const SHOWN_MAX = 60;

// 每次页面加载生成一个批次号：同一标签页里反复进出游乐场时，
// 各游戏的局号会从 1 重来，靠它避免和上一次访问的事件撞 token。
const PAGE_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/* ---------------- 存储（失败时退回内存，不影响游戏） ---------------- */

function memStorage() {
  const map = new Map();
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: key => { map.delete(key); }
  };
}

const memory = { localStorage: memStorage(), sessionStorage: memStorage() };

function getStorage(name) {
  try {
    const store = window[name];
    const probe = '__ylxh_probe__';
    store.setItem(probe, '1');
    store.removeItem(probe);
    return store;
  } catch (e) {
    return memory[name];
  }
}

function readJSON(storage, key, fallback) {
  try {
    const raw = storage.getItem(key);
    if (!raw) return fallback;
    const value = JSON.parse(raw);
    return value == null ? fallback : value;
  } catch (e) {
    return fallback;
  }
}

function writeJSON(storage, key, value) {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch (e) { /* 忽略配额异常 */ }
}

/* ---------------- 近期台词去重 ---------------- */

function normalize(text) {
  return String(text == null ? '' : text)
    .replace(/\s+/g, '')
    .replace(/[，。！？、；：…~～,.!?;:"'“”‘’「」『』（）()\-—]/g, '')
    .toLowerCase();
}

export function getRecentLines() {
  const list = readJSON(getStorage('localStorage'), RECENT_KEY, []);
  return Array.isArray(list) ? list.filter(item => typeof item === 'string') : [];
}

function rememberLine(text) {
  const line = String(text == null ? '' : text).trim();
  if (!line) return;
  const list = getRecentLines().filter(item => normalize(item) !== normalize(line));
  list.push(line);
  while (list.length > RECENT_MAX) list.shift();
  writeJSON(getStorage('localStorage'), RECENT_KEY, list);
}

/**
 * 从短句池里挑一句，优先避开最近说过的。
 * 全部都在近期记录里时，挑「最久没出现」的那一句。
 */
export function pickLine(pool) {
  const list = (pool || []).filter(item => typeof item === 'string' && item.trim());
  if (!list.length) return '';

  const recent = getRecentLines();
  const recentSet = new Set(recent.map(normalize));
  const fresh = list.filter(item => !recentSet.has(normalize(item)));
  if (fresh.length) return fresh[Math.floor(Math.random() * fresh.length)];

  // 都在近期记录里：选最近最少出现的
  const used = new Map();
  list.forEach(item => {
    const key = normalize(item);
    const index = recent.map(normalize).lastIndexOf(key);
    used.set(item, index);
  });
  let best = list[0];
  let bestIndex = Infinity;
  list.forEach(item => {
    const index = used.get(item);
    if (index < bestIndex) { bestIndex = index; best = item; }
  });
  return best;
}

/* ---------------- 事件去重 ---------------- */

function readShown() {
  const list = readJSON(getStorage('sessionStorage'), SHOWN_KEY, []);
  return Array.isArray(list) ? list.filter(item => typeof item === 'string') : [];
}

function hasShown(token) {
  return readShown().includes(token);
}

function markShown(token) {
  const list = readShown();
  if (list.includes(token)) return;
  list.push(token);
  while (list.length > SHOWN_MAX) list.shift();
  writeJSON(getStorage('sessionStorage'), SHOWN_KEY, list);
}

/* ---------------- 珍藏提议（本地判断，0 次 AI） ----------------
   小星不会每局都提这件事：同一款游戏至少要一起玩过两次，
   上次提过之后要隔几天，输掉的那局不提。提议只写进「待确认」，
   她在珍藏页点头之后才变成已收录。 */

const KEEP_MIN_EVENTS = 2;              // 同一游戏至少结算过 2 次
const KEEP_COOLDOWN = 3 * 24 * 3600e3;  // 同一游戏提议间隔 3 天
const KEEP_NEGATIVE = /输掉|输了|爆牌|失败|没过/;

function readKeepState() {
  const raw = readJSON(getStorage('localStorage'), KEEP_STATE_KEY, {});
  const state = raw && typeof raw === 'object' ? raw : {};
  if (!state.counts || typeof state.counts !== 'object') state.counts = {};
  if (!state.lastOfferAt || typeof state.lastOfferAt !== 'object') state.lastOfferAt = {};
  return state;
}

function countGameEvent(game) {
  if (!game) return 0;
  const state = readKeepState();
  const next = (Number(state.counts[game]) || 0) + 1;
  state.counts[game] = next;
  writeJSON(getStorage('localStorage'), KEEP_STATE_KEY, state);
  return next;
}

function markKeepOffered(game) {
  if (!game) return;
  const state = readKeepState();
  state.lastOfferAt[game] = Date.now();
  writeJSON(getStorage('localStorage'), KEEP_STATE_KEY, state);
}

function keepEligible(game, result) {
  if (!game) return false;
  if (KEEP_NEGATIVE.test(String(result || ''))) return false;
  const state = readKeepState();
  if ((Number(state.counts[game]) || 0) < KEEP_MIN_EVENTS) return false;
  const last = Number(state.lastOfferAt[game]) || 0;
  if (last && Date.now() - last < KEEP_COOLDOWN) return false;
  return true;
}

/** 把这次结算写成一条「待确认」珍藏，写的是房间那一份 keeps */
async function offerKeep() {
  if (!active || !active.keep) return;
  const keep = active.keep;
  if (keep.done || keep.busy) return;
  keep.busy = true;

  const payload = active.payload;
  const game = payload.game || {};
  const sourceId = payload.token;         // 带页面批次，跨页也唯一
  try {
    const existed = await findKeepBySource(sourceId);
    if (!existed) {
      await addKeep({
        title: game.name || '游乐场的一段',
        content: payload.content,
        by: '星星',
        createdAt: Date.now(),
        needsConfirm: true,
        status: 'waiting_user',            // 只到待确认，绝不直接收录
        response: '',
        sourceId,
        source: payload.source,
        gameResult: game.result || ''
      });
    }
    keep.done = true;
    markKeepOffered(game.id);
    fillBubble();
  } catch (e) {
    keep.busy = false;
  }
}

/* ---------------- 样式 ---------------- */

const STYLES = `
  #${BUBBLE_ID} {
    position: fixed; right: 22px; bottom: 22px; z-index: 99998;
    width: min(320px, calc(100vw - 32px));
    padding: 13px 15px 12px;
    border-radius: 16px;
    border: 1px solid rgba(168, 156, 214, .45);
    background: linear-gradient(160deg, rgba(255, 252, 255, .97), rgba(243, 238, 255, .97));
    box-shadow: 0 12px 36px rgba(120, 108, 180, .28), inset 0 0 0 1px rgba(255, 255, 255, .8);
    color: #4a4a6a;
    font-family: inherit;
    cursor: pointer;
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    transition: transform .2s ease, box-shadow .2s ease;
    text-align: left;
  }
  #${BUBBLE_ID}:hover { transform: translateY(-2px); box-shadow: 0 16px 44px rgba(120, 108, 180, .36); }
  #${BUBBLE_ID}:focus-visible { outline: 2px solid rgba(150, 130, 210, .8); outline-offset: 2px; }
  #${BUBBLE_ID}.pg-end-enter { animation: pgEndPop .38s cubic-bezier(.34, 1.4, .64, 1); }
  @keyframes pgEndPop {
    from { transform: translateY(16px) scale(.94); opacity: 0; }
    to { transform: translateY(0) scale(1); opacity: 1; }
  }
  #${BUBBLE_ID} .pg-end-top {
    display: flex; align-items: center; gap: 8px;
    margin-bottom: 6px;
  }
  #${BUBBLE_ID} .pg-end-star {
    width: 22px; height: 22px; flex: 0 0 22px;
    display: flex; align-items: center; justify-content: center;
    border-radius: 50%;
    background: linear-gradient(160deg, #e8ddff, #d7c8ff);
    color: #7b62b8; font-size: 12px;
    box-shadow: 0 0 10px rgba(168, 148, 230, .45);
  }
  #${BUBBLE_ID} .pg-end-name {
    font-size: 12px; letter-spacing: 1px; color: #6a5a92;
  }
  #${BUBBLE_ID} .pg-end-tag {
    margin-left: auto;
    font-size: 10px; letter-spacing: .5px;
    padding: 2px 8px; border-radius: 999px;
    background: rgba(168, 156, 214, .16);
    border: 1px solid rgba(168, 156, 214, .3);
    color: #7a6aa0;
    white-space: nowrap;
  }
  #${BUBBLE_ID} .pg-end-text {
    font-size: 13px; line-height: 1.62; color: #443c60;
    display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
    overflow: hidden;
  }
  #${BUBBLE_ID} .pg-end-meta {
    margin-top: 5px; font-size: 10.5px; line-height: 1.5; color: #8b7fae;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  #${BUBBLE_ID} .pg-end-hint {
    margin-top: 7px; font-size: 10px; letter-spacing: .5px; color: #9d8fc4;
  }
  #${BUBBLE_ID} .pg-end-keep {
    margin-top: 8px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  }
  #${BUBBLE_ID} .pg-end-keep-btn {
    font: inherit; font-size: 11px; line-height: 1.4;
    padding: 4px 11px; border-radius: 999px; cursor: pointer;
    border: 1px solid rgba(168, 156, 214, .55);
    background: rgba(255, 255, 255, .8);
    color: #6a5a92; letter-spacing: .5px;
    transition: background .18s ease, transform .18s ease;
  }
  #${BUBBLE_ID} .pg-end-keep-btn:hover {
    background: rgba(240, 232, 255, .95); transform: translateY(-1px);
  }
  #${BUBBLE_ID} .pg-end-keep-note { font-size: 9.5px; color: #a496c6; letter-spacing: .3px; }
  #${BUBBLE_ID} .pg-end-keep-done {
    margin-top: 8px; font-size: 10.5px; line-height: 1.5; color: #8b7fae;
  }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLES;
  document.head.appendChild(style);
}

/* ---------------- 气泡 ---------------- */

let active = null;   // { token, payload, el, opened }

function escapeHTML(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function fillBubble() {
  if (!active || !active.el) return;
  const { payload } = active;
  const gameName = payload.game ? payload.game.name : '';
  const result = payload.game ? payload.game.result : '';
  const keep = active.keep;
  const showOffer = !!(keep && keep.eligible && !keep.done);
  const showDone = !!(keep && keep.done);
  active.el.innerHTML = `
    <div class="pg-end-top">
      <span class="pg-end-star">✦</span>
      <span class="pg-end-name">小星</span>
      ${gameName ? `<span class="pg-end-tag">${escapeHTML(gameName)}</span>` : ''}
    </div>
    <div class="pg-end-text">${escapeHTML(payload.content)}</div>
    ${result ? `<div class="pg-end-meta">${escapeHTML(result)}</div>` : ''}
    ${showOffer ? `<div class="pg-end-keep"><button type="button" class="pg-end-keep-btn">✦ 这次留下吧</button><span class="pg-end-keep-note">先放进待确认</span></div>` : ''}
    ${showDone ? '<div class="pg-end-keep-done">记进珍藏页了，你点头才算数。</div>' : ''}
    <div class="pg-end-hint">点击回到房间聊天 →</div>
  `;
}

function mountBubble(animate) {
  ensureStyle();
  let el = document.getElementById(BUBBLE_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = BUBBLE_ID;
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.addEventListener('click', event => {
      const target = event.target;
      const btn = target && typeof target.closest === 'function'
        ? target.closest('.pg-end-keep-btn') : null;
      if (btn) {                 // 气泡里的「留下」按钮：不跳转，只写待确认
        event.preventDefault();
        event.stopPropagation();
        offerKeep();
        return;
      }
      openChat();
    });
    el.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openChat();
      }
    });
    document.body.appendChild(el);
  }
  if (active) active.el = el;
  fillBubble();
  el.classList.remove('pg-end-enter');
  if (animate) {
    // 重排一次，保证动画能重新播放
    void el.offsetWidth;
    el.classList.add('pg-end-enter');
  }
  return el;
}

/**
 * 展示一条结算消息。同一 token 只生效一次。
 * @param {object} options
 * @param {string} options.game       游戏 id（用于来源标记）
 * @param {string} options.gameName   气泡上展示的游戏名
 * @param {string} options.token      结束事件唯一标识
 * @param {string} options.line       小星要说的一句话
 * @param {string} [options.result]   真实结算结果（展示在气泡里，也随消息进入聊天上下文）
 * @param {string} [options.english]  已有的英文（传了就跳过聊天页的翻译请求；空串表示不需要英文）
 * @returns {boolean} 是否真正展示
 */
export function showGameEnd(options = {}) {
  const line = String(options.line == null ? '' : options.line).trim();
  if (!line) return false;

  const game = options.game || 'playground';
  const eventKey = options.token || `${game}:${Date.now().toString(36)}`;
  const shownKey = `${PAGE_ID}|${eventKey}`;
  if (hasShown(shownKey)) return false;

  markShown(shownKey);
  rememberLine(line);

  // 这次结算要不要顺口问一句「留下吧」：本地规则，不发请求
  countGameEvent(game);
  const hasEnglish = typeof options.english === 'string';
  active = {
    eventKey,
    opened: false,
    dismissed: false,
    hidden: false,
    el: null,
    keep: { eligible: keepEligible(game, options.result), done: false, busy: false },
    payload: {
      token: shownKey,       // 交给聊天页去重：跨页面也唯一
      content: line,
      english: hasEnglish ? options.english : null,
      source: `game:${game}`,
      game: {
        id: game,
        name: options.gameName || '',
        result: options.result || ''
      },
      at: Date.now()
    }
  };

  mountBubble(true);
  return true;
}

/**
 * 用新的文案替换当前气泡（例如 21 点手动让星星总结后，把本地短句换成 AI 总结）。
 * 只更新当前事件，不放宽去重。
 */
export function updateGameEnd(options = {}) {
  if (!active || active.opened || active.dismissed) return false;
  const line = String(options.line == null ? '' : options.line).trim();
  if (!line) return false;
  if (options.token && options.token !== active.eventKey) return false;

  active.payload.content = line;
  if (typeof options.english === 'string') active.payload.english = options.english;
  if (options.result && active.payload.game) {
    active.payload.game.result = options.result;
  }
  rememberLine(line);
  mountBubble(false);
  return true;
}

/** 移除气泡（不解除事件去重：同一事件不会再弹一次） */
export function dismissGameEnd() {
  const el = document.getElementById(BUBBLE_ID);
  if (el && el.parentNode) el.parentNode.removeChild(el);
  if (active) {
    active.el = null;
    active.dismissed = true;
  }
}

/**
 * 只隐藏气泡，保留这次结束消息的交接资格。
 * 用于「切到别的游戏」这类被动收起：用户之后点顶栏「回到房间」仍能把它带进聊天。
 */
export function hideGameEnd() {
  const el = document.getElementById(BUBBLE_ID);
  if (el && el.parentNode) el.parentNode.removeChild(el);
  if (active) {
    active.el = null;
    active.hidden = true;
  }
}

/** 当前是否有气泡 */
export function hasGameEnd() {
  return !!active;
}

/** 把当前结算消息写进跨场景通道（不跳转）。返回是否写入成功。 */
export function flushToChat() {
  if (!active || active.opened || active.dismissed) return false;

  const src = active.payload;
  const payload = {
    token: src.token,
    content: src.content,
    source: src.source,
    game: src.game,
    at: src.at
  };
  // 只有调用方明确给了英文才带上，避免聊天页多打一次翻译请求
  if (typeof src.english === 'string') payload.english = src.english;

  try {
    // 清掉旧版实现可能残留的 localStorage 待消费消息，避免旧消息抢先消费
    getStorage('localStorage').removeItem(PENDING_KEY);
  } catch (e) { /* ignore */ }

  try {
    getStorage('sessionStorage').setItem(PENDING_KEY, JSON.stringify(payload));
  } catch (e) {
    return false;
  }

  active.opened = true;
  return true;
}

/** 点击气泡：写入跨场景消息并回到房间聊天 */
export function openChat() {
  if (!flushToChat()) return false;
  dismissGameEnd();
  goRoom();
  return true;
}

function goRoom() {
  try {
    getStorage('sessionStorage').setItem('ylxh.transition', 'to-home');
  } catch (e) { /* ignore */ }

  const canFade = typeof window.playDoorTransition === 'function';
  if (!canFade) {
    window.location.href = '/';
    return;
  }
  Promise.resolve()
    .then(() => window.playDoorTransition('forward'))
    .catch(() => { })
    .then(() => { window.location.href = '/'; });
}

/* 统一导出对象，调用方写法更短 */
export const gameEnd = {
  show: showGameEnd,
  update: updateGameEnd,
  dismiss: dismissGameEnd,
  hide: hideGameEnd,
  has: hasGameEnd,
  open: openChat,
  flush: flushToChat,
  pickLine
};

/* 顶栏「回到房间」：用户不点气泡直接走，也把这次结算带进聊天 */
try {
  document.addEventListener('click', event => {
    const target = event.target;
    if (target && typeof target.closest === 'function' && target.closest('#backToRoom')) {
      flushToChat();
    }
  }, true);
} catch (e) { /* 非浏览器环境忽略 */ }

/* 切换到另一个游戏时收起上一个游戏的结算气泡，避免挡住新界面；
   只是隐藏，不撤销交接资格——用户之后点顶栏「回到房间」仍会把它带进聊天。
   回到大厅（lobby）时保留气泡，用户仍然可以点它回聊天。 */
try {
  window.addEventListener('scene:change', event => {
    const scene = event && event.detail ? event.detail.scene : '';
    if (!scene || scene === 'lobby') return;
    hideGameEnd();
  });
} catch (e) { /* 非浏览器环境忽略 */ }
