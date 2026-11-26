/* public/playground/game-activity.js — 游戏活动采集层（第一版）
 * 数据层在 shared/life-events.js → LifeEvents.activities，聊天页与未来 Agent 共用同一份本地记录。
 * 本文件只负责识别「真实有效游玩」：scene:change 开始/结束会话，包装 gameEnd.show 记录结算。
 * 不开 AI、不上报、不碰玩法、不碰存档。
 */
import { gameEnd } from './game-end.js';

const A = (typeof window !== 'undefined' && window.LifeEvents && window.LifeEvents.activities) || null;
const LIVE_KEY = 'ylxh.game.live.v1';
const BEAT_MS = 15000;
const MIN_MS = 45000;

/* 场景 id → 游戏事实。仅用于「未结算就离开」的恢复；正常结算以 gameEnd.show 的真实参数为准。
   collection（珍藏展示）、radio（收听）不是游戏，不记录。 */
const SCENE_GAME = {
  planets: { game: 'vocab', name: '一起背单词' },
  adventure: { game: 'gomoku', name: '星空棋局' },
  puzzle: { game: 'puzzle', name: '星光拼图' },
  date: { game: 'blackjack', name: '星夜21点' },
  kitchen: { game: 'kitchen', name: '厨房大危机' },
};

let scene = '';
let session = null;
let beatTimer = null;
let paused = false;

function readLive() {
  try { const raw = window.localStorage.getItem(LIVE_KEY); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}
function writeLive(v) {
  try { window.localStorage.setItem(LIVE_KEY, JSON.stringify(v)); } catch (e) {}
}
function dropLive() { try { window.localStorage.removeItem(LIVE_KEY); } catch (e) {} }
function persistLive() {
  if (!session || !session.engaged) { dropLive(); return; }
  writeLive({ v: 1, game: session.game, name: session.name, startAt: session.startAt,
    activeMs: Math.min(session.activeMs, 2 * 3600000), seenAt: Date.now() });
}
function beat(now, save) {
  if (!session || !session.engaged || !A) return;
  if (paused) { session.lastBeat = now; return; }
  if (session.lastBeat) session.activeMs += Math.min(Math.max(0, now - session.lastBeat), BEAT_MS * 2);
  session.lastBeat = now;
  if (save) persistLive();
}
function flushBeat() {
  if (!session || !session.engaged) return;
  const now = Date.now();
  if (session.lastBeat) session.activeMs += Math.min(Math.max(0, now - session.lastBeat), BEAT_MS * 2);
  session.lastBeat = now;
  persistLive();
}
function stopSession() {
  if (beatTimer) { clearInterval(beatTimer); beatTimer = null; }
  if (A && session && session.engaged && !session.settled) {
    beat(Date.now(), false);
    if (session.activeMs >= MIN_MS) {
      A.record({ id: `game:act:rec:${session.game}:${session.startAt}`, game: session.game, name: session.name,
        result: '', startAt: session.startAt, endAt: Date.now(), durMs: session.activeMs });
    }
  }
  session = null; dropLive();
}
function engage(e) {
  if (!session || session.engaged) return;
  if (e && e.type === 'keydown') {
    const k = e.key;
    if (!k || k === 'Tab' || k === 'Shift' || k === 'Control' || k === 'Alt' || k === 'Meta'
      || k.indexOf('Arrow') === 0 || k === ' ') return;
  }
  const t = Date.now();
  session.engaged = true; session.startAt = t; session.lastBeat = t; session.activeMs = 0;
  persistLive();
  if (!beatTimer) beatTimer = setInterval(() => beat(Date.now(), true), BEAT_MS);
  if (beatTimer && typeof beatTimer.unref === 'function') beatTimer.unref();
}
function onScene(e) {
  const next = (e && e.detail && e.detail.scene) || 'lobby';
  if (next === scene) return;
  stopSession();
  scene = next;
  const meta = SCENE_GAME[scene];
  if (meta) session = { game: meta.game, name: meta.name, engaged: false, settled: false, activeMs: 0, lastBeat: 0, startAt: 0 };
}

/* 接入统一结算：只改导出对象的属性，不改 game-end.js 与任何游戏文件 */
try {
  const orig = gameEnd.show;
  if (typeof orig === 'function' && A) {
    gameEnd.show = function (opts) {
      const ok = orig.apply(this, arguments);
      try {
        if (ok && session && session.engaged && !session.settled) {
          beat(Date.now(), false);
          const o = opts || {};
          if (session.activeMs >= MIN_MS) {
            A.record({ id: `game:act:${o.token || (session.game + ':' + session.startAt)}`,
              game: o.game || session.game, name: o.gameName || session.name, result: o.result || '',
              startAt: session.startAt, endAt: Date.now(), durMs: session.activeMs });
          }
          session.settled = true; dropLive();
        }
      } catch (err) { /* 记录失败绝不影响结算 */ }
      return ok;
    };
  }
} catch (e) { /* 包装失败：只是不记录，游戏照常 */ }

try {
  window.addEventListener('scene:change', onScene, true);
  window.addEventListener('pointerdown', engage, true);
  window.addEventListener('keydown', engage, true);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (session) flushBeat(); paused = true; }
    else { paused = false; if (session) { session.lastBeat = Date.now(); persistLive(); } }
  }, true);
  window.addEventListener('pagehide', flushBeat);
} catch (e) { /* 无 DOM 环境：数据层仍可用 */ }

/* 启动恢复：心跳停止超过 30 秒视为浏览器已关闭，关闭期间不累计时长 */
try {
  const live = readLive();
  if (A && live && live.v === 1 && SCENE_GAME[live.game]) {
    const t = Number(live.seenAt) || 0;
    const closed = Date.now() - t > BEAT_MS * 2;
    const dur = Math.min(Math.max(0, closed ? Number(live.activeMs) || 0
      : (Number(live.activeMs) || 0) + Math.min(Math.max(0, Date.now() - t), BEAT_MS)), 2 * 3600000);
    if (dur >= MIN_MS) {
      A.record({ id: `game:act:rec:${live.game}:${live.startAt}`, game: live.game, name: live.name,
        result: '', startAt: live.startAt, endAt: closed ? t : Date.now(), durMs: dur });
    }
    dropLive();
  }
} catch (e) {}

const api = {
  _state() { return { scene, paused, session: session && { game: session.game, engaged: session.engaged,
    activeMs: session.activeMs, settled: session.settled }, live: readLive() }; },
  _bump(ms) { if (session && session.engaged) session.activeMs += Math.max(0, Number(ms) || 0); },
};
window.GameActivityCollector = api;
export default api;
