/* =====================================================
   厨房大危机 · 场景层
   负责：界面外壳、菜谱本、交互、AI 调度、清理
   公共引擎在 kitchen-rules.js，具体菜谱在 recipes/
   ===================================================== */

import {
  createCookingState,
  pushLine,
  applyAction,
  validateAction,
  buildMessages,
  parseModelOutput,
  aiBudget,
  getModelAdapter,
  isPassiveAction
} from './kitchen-rules.js';
import { listRecipes, getRecipe } from './recipes/index.js';
import { gameEnd } from './game-end.js';

const STYLE_ID = 'kitchen-styles';
const AI_TIMEOUT = 9000;

const KITCHEN_STYLES = `
  .kitchen-scene {
    max-width: 760px;
    margin: 18px auto;
    padding: 18px 18px 22px;
    color: #4a4036;
    border-radius: 22px;
    border: 1px solid rgba(210, 180, 140, .35);
    background:
      radial-gradient(ellipse at 92% 0%, rgba(255, 190, 120, .14), transparent 55%),
      radial-gradient(ellipse at 4% 100%, rgba(180, 160, 130, .10), transparent 60%),
      linear-gradient(155deg, rgba(252, 248, 242, .96), rgba(248, 244, 236, .98));
    box-shadow: 0 16px 50px rgba(180, 160, 130, .18), 0 1px 0 rgba(255, 255, 255, .5) inset;
    box-sizing: border-box;
  }
  .kitchen-scene *, .kitchen-scene *::before, .kitchen-scene *::after { box-sizing: border-box; }

  .kitchen-top {
    display: flex;
    align-items: center;
    gap: 10px;
    justify-content: space-between;
    flex-wrap: wrap;
  }
  .kitchen-back {
    padding: 7px 14px;
    font-size: 12px;
    color: #8a7a68;
    cursor: pointer;
    border-radius: 999px;
    border: 1px solid rgba(200, 175, 140, .4);
    background: rgba(245, 238, 228, .7);
    transition: border-color .2s, color .2s;
  }
  .kitchen-back:hover { border-color: #d99560; color: #b56a30; }
  .kitchen-heading { flex: 1; text-align: center; min-width: 140px; }
  .kitchen-heading h2 {
    margin: 0;
    font-size: 19px;
    letter-spacing: 2px;
    color: #5a4a3a;
  }
  .kitchen-heading small {
    display: block;
    margin-top: 2px;
    font-size: 10px;
    letter-spacing: 2px;
    color: #c8884c;
    opacity: .85;
  }
  .kitchen-nudge {
    padding: 7px 12px;
    font-size: 12px;
    color: #a85e20;
    cursor: pointer;
    border-radius: 999px;
    border: 1px solid rgba(217, 149, 96, .4);
    background: rgba(255, 180, 110, .14);
    transition: background .2s, opacity .2s;
  }
  .kitchen-nudge:hover { background: rgba(255, 180, 110, .24); }
  .kitchen-nudge[disabled] { opacity: .4; cursor: default; }

  .kitchen-stepper {
    display: flex;
    gap: 6px;
    justify-content: center;
    flex-wrap: wrap;
    margin: 14px 0 12px;
    padding: 0;
    list-style: none;
  }
  .kitchen-step {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 4px 9px;
    font-size: 11px;
    color: #a09080;
    border-radius: 999px;
    border: 1px solid rgba(200, 180, 150, .25);
    background: rgba(248, 242, 232, .7);
  }
  .kitchen-step.is-done { color: #5a9a6a; border-color: rgba(120, 180, 130, .35); }
  .kitchen-step.is-now {
    color: #4a2e16;
    font-weight: 600;
    border-color: #ffc48c;
    background: linear-gradient(140deg, #ffd9ad, #ffb877);
  }

  .kitchen-stage {
    display: grid;
    grid-template-columns: 1.15fr 1fr;
    gap: 12px;
    margin-bottom: 12px;
  }
  @media (max-width: 640px) { .kitchen-stage { grid-template-columns: 1fr; } }

  .kitchen-counter {
    position: relative;
    min-height: 132px;
    padding: 12px 14px;
    border-radius: 16px;
    border: 1px solid rgba(220, 200, 170, .35);
    background:
      linear-gradient(180deg, rgba(255, 250, 244, .92), rgba(248, 242, 232, .92));
    overflow: hidden;
  }
  .kitchen-counter::after {
    content: '';
    position: absolute;
    left: 0; right: 0; bottom: 0;
    height: 26px;
    background: linear-gradient(180deg, rgba(255, 180, 110, .08), transparent);
    pointer-events: none;
  }
  .kitchen-counter-title {
    font-size: 10px;
    letter-spacing: 2px;
    color: #c8884c;
    opacity: .85;
  }
  .kitchen-pan {
    margin-top: 8px;
    display: flex;
    align-items: flex-end;
    gap: 12px;
  }
  .kitchen-pan-icon {
    font-size: 40px;
    line-height: 1;
    filter: drop-shadow(0 0 14px rgba(255, 190, 120, .3));
  }
  .kitchen-pan-body { flex: 1; min-width: 0; }
  .kitchen-pan-line { font-size: 13px; line-height: 1.6; color: #5a4a3a; }
  .kitchen-pan-line b { color: #b56a30; font-weight: 600; }
  .kitchen-heat {
    margin-top: 6px;
    font-size: 11px;
    letter-spacing: 1px;
    color: #d4853c;
  }
  .kitchen-heat span { opacity: .28; }
  .kitchen-heat span.on { opacity: 1; text-shadow: 0 0 8px rgba(255, 150, 60, .5); }
  .kitchen-meter {
    margin-top: 8px;
    height: 6px;
    border-radius: 999px;
    background: rgba(200, 185, 160, .2);
    overflow: hidden;
  }
  .kitchen-meter i {
    display: block;
    height: 100%;
    border-radius: 999px;
    background: linear-gradient(90deg, #8fd3a8, #ffd9ad);
    transition: width .35s ease;
  }
  .kitchen-meter-label {
    display: flex;
    justify-content: space-between;
    margin-top: 4px;
    font-size: 10px;
    color: #9a8a78;
  }
  .kitchen-event {
    margin-top: 8px;
    padding: 7px 10px;
    font-size: 11.5px;
    line-height: 1.6;
    color: #b8542c;
    border-radius: 10px;
    border-left: 2px solid #e89a5a;
    background: rgba(255, 120, 80, .08);
  }

  .kitchen-side { display: flex; flex-direction: column; gap: 8px; }
  .kitchen-card {
    padding: 10px 12px;
    border-radius: 14px;
    border: 1px solid rgba(220, 200, 170, .3);
    background: rgba(252, 247, 240, .75);
  }
  .kitchen-card-title {
    font-size: 10px;
    letter-spacing: 2px;
    color: #a08868;
    margin-bottom: 6px;
  }
  .kitchen-team-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 12px;
    color: #6a5a4a;
    padding: 3px 0;
  }
  .kitchen-team-row em { font-style: normal; color: #9a8a78; font-size: 11px; }
  .kitchen-team-badge {
    padding: 2px 9px;
    font-size: 11px;
    border-radius: 999px;
    border: 1px solid rgba(217, 149, 96, .35);
    background: rgba(255, 196, 140, .12);
    color: #b56a30;
  }
  .kitchen-team-badge[data-who="star"] { border-color: rgba(130, 160, 210, .35); background: rgba(120, 150, 200, .1); color: #5a7090; }
  .kitchen-swap {
    width: 100%;
    margin-top: 6px;
    padding: 5px 8px;
    font-size: 11px;
    color: #8a7a68;
    cursor: pointer;
    border-radius: 8px;
    border: 1px dashed rgba(190, 165, 130, .35);
    background: transparent;
  }
  .kitchen-swap:hover { color: #b56a30; border-color: rgba(217, 149, 96, .5); }
  .kitchen-tags { display: flex; flex-wrap: wrap; gap: 4px; }
  .kitchen-tag {
    padding: 2px 8px;
    font-size: 10.5px;
    border-radius: 999px;
    color: #7a6a5a;
    background: rgba(180, 160, 130, .1);
    border: 1px solid rgba(180, 160, 130, .2);
  }

  .kitchen-controls {
    padding: 12px 14px 14px;
    border-radius: 16px;
    border: 1px solid rgba(220, 200, 170, .3);
    background: rgba(252, 247, 240, .75);
  }
  .kitchen-controls-title {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 8px;
  }
  .kitchen-controls-title strong { font-size: 13px; letter-spacing: 1px; color: #5a4a3a; }
  .kitchen-controls-title small { font-size: 11px; color: #9a8a78; }
  .kitchen-group { margin-top: 9px; }
  .kitchen-group-label { font-size: 10.5px; letter-spacing: 1px; color: #9a8a78; margin-bottom: 5px; }
  .kitchen-chips { display: flex; flex-wrap: wrap; gap: 6px; }

  .kitchen-chip {
    padding: 6px 11px;
    font-size: 12px;
    color: #6a5a4a;
    cursor: pointer;
    border-radius: 999px;
    border: 1px solid rgba(200, 180, 150, .3);
    background: rgba(250, 245, 238, .8);
    transition: border-color .18s, background .18s, color .18s, transform .18s;
  }
  .kitchen-chip:hover { border-color: rgba(255, 196, 140, .6); transform: translateY(-1px); }
  .kitchen-chip.is-active {
    color: #4a2e16;
    font-weight: 600;
    border-color: #ffc48c;
    background: linear-gradient(140deg, #ffd9ad, #ffbe7d);
  }
  .kitchen-chip.is-warm { border-color: rgba(217, 140, 100, .45); color: #c46a3a; }
  .kitchen-chip[disabled] { opacity: .38; cursor: default; transform: none; }

  .kitchen-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  .kitchen-button {
    padding: 8px 16px;
    font-size: 12.5px;
    color: #5a6a7a;
    cursor: pointer;
    border-radius: 10px;
    border: 1px solid rgba(160, 180, 210, .35);
    background: linear-gradient(145deg, rgba(235, 240, 248, .8), rgba(220, 230, 242, .85));
    transition: border-color .2s, box-shadow .2s, transform .2s;
  }
  .kitchen-button:hover { border-color: #d99560; box-shadow: 0 0 14px rgba(255, 196, 140, .2); transform: translateY(-1px); }
  .kitchen-button.is-primary {
    color: #4a2e16;
    font-weight: 600;
    border-color: #ffc48c;
    background: linear-gradient(140deg, #ffd9ad, #ffb877);
  }
  .kitchen-button.is-danger { border-color: rgba(210, 120, 100, .5); color: #c04a30; background: rgba(255, 110, 90, .1); }
  .kitchen-button[disabled] { opacity: .38; cursor: default; transform: none; box-shadow: none; }
  .kitchen-hint { margin-top: 9px; font-size: 11px; line-height: 1.7; color: #8a7a68; }
  .kitchen-notice {
    margin-top: 8px;
    font-size: 11.5px;
    color: #c46a30;
    min-height: 0;
  }

  .kitchen-proposal {
    margin-top: 10px;
    padding: 10px 12px;
    border-radius: 12px;
    border: 1px solid rgba(217, 149, 96, .35);
    background: rgba(255, 180, 110, .08);
    font-size: 12px;
    line-height: 1.7;
    color: #9a5e20;
  }
  .kitchen-proposal .kitchen-actions { margin-top: 8px; }

  .kitchen-book-list { display: grid; gap: 10px; margin-top: 8px; }
  .kitchen-book-card {
    display: flex;
    flex-direction: column;
    gap: 3px;
    width: 100%;
    padding: 14px 16px;
    text-align: left;
    color: #4a4036;
    cursor: pointer;
    border-radius: 14px;
    border: 1px solid rgba(220, 195, 160, .3);
    background: linear-gradient(150deg, rgba(255, 250, 244, .92), rgba(248, 240, 228, .94));
    transition: border-color .2s, transform .2s, box-shadow .2s;
  }
  .kitchen-book-card:hover {
    border-color: #d99560;
    transform: translateY(-1px);
    box-shadow: 0 8px 24px rgba(200, 170, 130, .15);
  }
  .kitchen-book-card .icon { font-size: 26px; line-height: 1.1; }
  .kitchen-book-card strong { font-size: 15px; letter-spacing: 1px; color: #5a4a3a; }
  .kitchen-book-card small { font-size: 10.5px; letter-spacing: 1.5px; color: #c8884c; }
  .kitchen-book-card p { margin: 2px 0 0; font-size: 12px; line-height: 1.6; color: #8a7a68; }

  .kitchen-dialogue {
    margin-top: 12px;
    border-radius: 16px;
    border: 1px solid rgba(210, 190, 160, .25);
    background: rgba(252, 247, 240, .7);
    overflow: hidden;
  }
  .kitchen-dialogue-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 7px 12px;
    font-size: 10px;
    letter-spacing: 2px;
    color: #9a8a78;
    border-bottom: 1px solid rgba(210, 190, 160, .2);
  }
  .kitchen-dialogue-head button {
    font-size: 10px;
    color: #a09080;
    cursor: pointer;
    border: 0;
    background: transparent;
    padding: 2px 4px;
  }
  .kitchen-dialogue-head button:hover { color: #b56a30; }
  .kitchen-lines {
    max-height: 176px;
    overflow-y: auto;
    padding: 8px 12px 10px;
    display: flex;
    flex-direction: column;
    gap: 7px;
  }
  .kitchen-line { display: flex; gap: 7px; align-items: flex-start; font-size: 12px; line-height: 1.65; }
  .kitchen-line-who {
    flex: 0 0 auto;
    padding: 1px 7px;
    font-size: 10px;
    border-radius: 999px;
    border: 1px solid rgba(180, 160, 130, .3);
    color: #8a7a68;
    background: rgba(230, 220, 205, .4);
  }
  .kitchen-line[data-who="star"] .kitchen-line-who { color: #5a7090; border-color: rgba(130, 160, 210, .4); background: rgba(180, 200, 230, .3); }
  .kitchen-line[data-who="user"] .kitchen-line-who { color: #a85e20; border-color: rgba(217, 149, 96, .4); background: rgba(255, 220, 190, .3); }
  .kitchen-line[data-who="system"] .kitchen-line-who { color: #9a8a78; border-color: rgba(180, 160, 130, .2); background: transparent; }
  .kitchen-line-text { color: #5a4a3a; white-space: pre-wrap; word-break: break-word; }
  .kitchen-line[data-who="system"] .kitchen-line-text { color: #8a7a68; font-size: 11.5px; }

  .kitchen-log { margin-top: 8px; font-size: 11px; color: #8a7a68; }
  .kitchen-log summary { cursor: pointer; letter-spacing: 1px; }
  .kitchen-log ul { margin: 7px 0 0; padding-left: 16px; line-height: 1.8; max-height: 130px; overflow-y: auto; }
  .kitchen-log li::marker { color: #c8884c; }

  .kitchen-result { margin-top: 12px; padding: 16px 16px 18px; border-radius: 18px; border: 1px solid rgba(220, 195, 160, .35); background: linear-gradient(160deg, rgba(255, 250, 244, .94), rgba(248, 240, 228, .96)); }
  .kitchen-result-top { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .kitchen-grade {
    width: 62px; height: 62px;
    flex: 0 0 auto;
    display: flex; align-items: center; justify-content: center;
    font-size: 30px; font-weight: 700;
    border-radius: 50%;
    color: #4a2e16;
    background: linear-gradient(140deg, #ffe3bd, #ffb877);
    box-shadow: 0 0 24px rgba(255, 180, 110, .3);
  }
  .kitchen-result-name { flex: 1; min-width: 160px; }
  .kitchen-result-name strong { display: block; font-size: 17px; letter-spacing: 1px; color: #5a4a3a; }
  .kitchen-result-name small { font-size: 11.5px; color: #c8884c; }
  .kitchen-parts { display: grid; grid-template-columns: repeat(auto-fit, minmax(112px, 1fr)); gap: 8px; margin-top: 12px; }
  .kitchen-part { font-size: 10.5px; color: #9a8a78; }
  .kitchen-part b { display: block; margin-top: 3px; font-size: 12px; color: #5a4a3a; }
  .kitchen-part .kitchen-meter { margin-top: 4px; height: 5px; }
  .kitchen-highlights { margin: 12px 0 0; padding-left: 16px; font-size: 12px; line-height: 1.9; color: #6a5a4a; }
  .kitchen-highlights li::marker { color: #c8884c; }
  .kitchen-result-summary { margin-top: 10px; font-size: 12px; line-height: 1.8; color: #8a7a68; }

  .kitchen-loading { font-size: 11px; color: #9a8a78; }
  .kitchen-loading::after { content: '…'; animation: kitchen-dots 1.2s steps(4, end) infinite; }
  @keyframes kitchen-dots { 0% { opacity: .2; } 50% { opacity: 1; } 100% { opacity: .2; } }

  @media (max-width: 480px) {
    .kitchen-scene { margin: 10px auto; padding: 14px 12px 18px; border-radius: 18px; }
    .kitchen-heading h2 { font-size: 17px; }
    .kitchen-pan-icon { font-size: 34px; }
    .kitchen-lines { max-height: 150px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .kitchen-scene * { transition: none !important; animation: none !important; }
  }
`;

/* ============================ 界面小工具 ============================ */

const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[ch]));

const pct = (value, max) => Math.max(0, Math.min(100, Math.round((value / max) * 100)));

function attrs(map) {
  return Object.keys(map)
    .filter(key => map[key] !== undefined && map[key] !== null)
    .map(key => `data-${key}="${esc(map[key])}"`)
    .join(' ');
}

function chip(label, act, options = {}) {
  const cls = ['kitchen-chip'];
  if (options.active) cls.push('is-active');
  if (options.warm) cls.push('is-warm');
  const disabled = options.disabled ? ' disabled' : '';
  return `<button class="${cls.join(' ')}" ${attrs({ act, ...options.data })}${disabled}>${esc(label)}</button>`;
}

function button(label, act, options = {}) {
  const cls = ['kitchen-button'];
  if (options.primary) cls.push('is-primary');
  if (options.danger) cls.push('is-danger');
  const disabled = options.disabled ? ' disabled' : '';
  return `<button class="${cls.join(' ')}" ${attrs({ act, ...options.data })}${disabled}>${esc(label)}</button>`;
}

function heatDots(level) {
  return [1, 2, 3, 4].map(index => `<span class="${index <= level ? 'on' : ''}">🔥</span>`).join('');
}

const UI = { esc, pct, attrs, chip, button, heatDots };

/* ============================ 通用界面 ============================ */

function stepperHTML(state, recipe) {
  const current = recipe.phases.findIndex(step => step.id === state.phase);
  return `<ol class="kitchen-stepper">${recipe.phases.map((step, index) => {
    const cls = ['kitchen-step'];
    if (index < current) cls.push('is-done');
    if (index === current) cls.push('is-now');
    return `<li class="${cls.join(' ')}">${esc(step.label)}</li>`;
  }).join('')}</ol>`;
}

function resultHTML(state) {
  const result = state.result;
  if (!result) return '';
  const parts = result.parts || [];
  const starLine = [...state.dialogue].reverse().find(line => line.who === 'star');

  return `<div class="kitchen-result">
    <div class="kitchen-result-top">
      <div class="kitchen-grade">${esc(result.grade)}</div>
      <div class="kitchen-result-name">
        <strong>${esc(result.dishName)}</strong>
        <small>${esc(result.gradeText)} · ${result.score} 分</small>
      </div>
    </div>
    <div class="kitchen-parts">
      ${parts.map(part => `<div class="kitchen-part">
        ${esc(part.label)}<b>${part.value} / ${part.max}</b>
        <div class="kitchen-meter"><i style="width:${pct(part.value, part.max)}%"></i></div>
      </div>`).join('')}
    </div>
    <ul class="kitchen-highlights">${result.highlights.map(text => `<li>${esc(text)}</li>`).join('')}</ul>
    <div class="kitchen-result-summary">${esc(result.summary)}</div>
    ${starLine ? `<div class="kitchen-result-summary" style="color:#cfe0ff">星星：${esc(starLine.text)}</div>` : ''}
    <div class="kitchen-actions">
      ${button('再做一盘', 'restart', { primary: true })}
      ${button('换一道菜', 'recipe_book')}
      ${button('返回大厅', 'back')}
    </div>
  </div>`;
}

function dialogueHTML(state) {
  const lines = state.dialogue.slice(-12);
  return `<div class="kitchen-dialogue">
    <div class="kitchen-dialogue-head">
      <span>厨房里的对话</span>
      <button data-act="nudge"${state.ai.pending ? ' disabled' : ''}>让星星说点什么</button>
    </div>
    <div class="kitchen-lines" data-scroll="lines">
      ${lines.length ? lines.map(line => `<div class="kitchen-line" data-who="${line.who}">
        <span class="kitchen-line-who">${line.who === 'star' ? '星星' : line.who === 'user' ? '用户' : '厨房'}</span>
        <span class="kitchen-line-text">${esc(line.text)}</span>
      </div>`).join('') : '<div class="kitchen-line" data-who="system"><span class="kitchen-line-who">厨房</span><span class="kitchen-line-text">锅还是凉的，先和星星说句话吧。</span></div>'}
      ${state.ai.pending ? '<div class="kitchen-line" data-who="star"><span class="kitchen-line-who">星星</span><span class="kitchen-line-text kitchen-loading">正在想</span></div>' : ''}
    </div>
  </div>`;
}

function logHTML(state) {
  const items = state.log.slice(-14).reverse();
  return `<details class="kitchen-log">
    <summary>这一局发生过什么（${state.log.length}）</summary>
    <ul>${items.map(item => `<li>${esc(item.actor === 'star' ? '星星' : item.actor === 'user' ? '用户' : '厨房')}：${esc(item.label)}</li>`).join('')}</ul>
  </details>`;
}

function sceneHTML(state, recipe) {
  const busy = state.ai.pending;
  const body = state.phase === 'result'
    ? `${resultHTML(state)}${dialogueHTML(state)}`
    : `<div class="kitchen-stage">${recipe.render.counter(state, UI)}<div class="kitchen-side">${recipe.render.team(state, UI)}${recipe.render.status(state, UI)}</div></div>
       ${recipe.render.controls(state, UI)}
       ${dialogueHTML(state)}`;
  return `<section class="kitchen-scene">
    <div class="kitchen-top">
      <button class="kitchen-back" data-act="back">← 返回大厅</button>
      <div class="kitchen-heading">
        <h2>厨房大危机</h2>
        <small>${esc(recipe.subtitle || recipe.name)}</small>
      </div>
      <button class="kitchen-nudge" data-act="nudge"${busy ? ' disabled' : ''}>叫星星</button>
    </div>
    ${stepperHTML(state, recipe)}
    ${body}
    ${state.notice ? `<div class="kitchen-notice">${esc(state.notice)}</div>` : ''}
    ${logHTML(state)}
  </section>`;
}

function bookHTML(proposal) {
  const recipes = listRecipes();
  return `<section class="kitchen-scene">
    <div class="kitchen-top">
      <button class="kitchen-back" data-act="back">← 返回大厅</button>
      <div class="kitchen-heading">
        <h2>厨房大危机</h2>
        <small>RECIPE BOOK · 先挑一道菜</small>
      </div>
      <span></span>
    </div>
    <div class="kitchen-controls">
      <div class="kitchen-controls-title">
        <strong>菜谱本</strong>
        <small>今天想和星星做什么？</small>
      </div>
      <div class="kitchen-book-list">
        ${recipes.map(recipe => `<button class="kitchen-book-card" data-act="pick_recipe" data-id="${esc(recipe.id)}">
          <span class="icon" aria-hidden="true">${recipe.icon || '🍽️'}</span>
          <strong>${esc(recipe.name)}</strong>
          <small>${esc(recipe.subtitle || '')}</small>
          <p>${esc(recipe.description || '')}</p>
        </button>`).join('')}
      </div>
      ${proposal ? `<div class="kitchen-proposal">
        <div>星星探头看了一眼菜单：${esc(proposal.line)}</div>
        <div class="kitchen-actions">
          ${button('就听星星的', 'accept_recommend', { primary: true })}
          ${button('我自己挑', 'dismiss_recommend')}
        </div>
      </div>` : ''}
      <div class="kitchen-hint">现在只注册了一道菜，之后还会慢慢变多。</div>
    </div>
  </section>`;
}

/* ============================ 场景对象 ============================ */

export const KitchenScene = {
  container: null,
  root: null,
  recipe: null,
  state: null,
  bookMode: true,
  recipeProposal: null,
  onClick: null,
  timers: new Set(),
  runId: 0,
  endPublishedRun: -1,   // 已经弹过结算气泡的 runId（每道菜只弹一次）
  busy: false,
  abort: null,
  starTimer: null,
  localSteps: 0,

  mount(el) {
    this.container = el;
    this.runId += 1;
    this.busy = false;
    this.abort = null;
    this.starTimer = null;
    this.localSteps = 0;
    this.recipe = null;
    this.state = null;
    this.bookMode = true;
    this.recipeProposal = null;

    this.injectStyles();

    this.root = document.createElement('div');
    this.root.className = 'kitchen-root';
    this.onClick = event => this.handleClick(event);
    this.root.addEventListener('click', this.onClick);
    this.container.appendChild(this.root);

    this.render();

    // 预留星星推荐接口：只提案，等用户确认
    const recommended = this.recommendRecipe();
    if (recommended) this.proposeRecipe(recommended.id);
  },

  unmount() {
    this.runId += 1;
    this.busy = false;

    this.abortRequest();
    this.clearTimers();

    if (this.root && this.onClick) {
      this.root.removeEventListener('click', this.onClick);
    }
    this.onClick = null;

    if (this.container) this.container.innerHTML = '';

    this.container = null;
    this.root = null;
    this.recipe = null;
    this.state = null;
    this.bookMode = true;
    this.recipeProposal = null;
    this.starTimer = null;
    this.localSteps = 0;

    this.removeStyles();
  },

  injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = KITCHEN_STYLES;
    document.head.appendChild(style);
  },

  removeStyles() {
    const style = document.getElementById(STYLE_ID);
    if (style && style.parentNode) style.parentNode.removeChild(style);
  },

  clearTimers() {
    this.timers.forEach(id => clearTimeout(id));
    this.timers.clear();
    this.starTimer = null;
  },

  abortRequest() {
    if (!this.abort) return;
    try { this.abort.abort(); } catch (e) { /* ignore */ }
    this.abort = null;
  },

  later(fn, delay) {
    const id = setTimeout(() => {
      this.timers.delete(id);
      if (!this.state || !this.root) return;
      fn();
    }, delay);
    this.timers.add(id);
    return id;
  },

  /* ============================ 菜谱本 ============================ */

  recommendRecipe() {
    const recipes = listRecipes();
    return recipes.length ? recipes[0] : null;
  },

  proposeRecipe(id) {
    const recipe = getRecipe(id);
    if (!recipe) return false;
    this.recipeProposal = { recipeId: recipe.id, line: `今天要不要试试${recipe.name}？` };
    if (this.bookMode) this.render();
    return true;
  },

  startRecipe(id) {
    const recipe = getRecipe(id);
    if (!recipe) return;

    this.clearTimers();
    this.abortRequest();
    this.runId += 1;
    gameEnd.dismiss();

    this.recipe = recipe;
    this.bookMode = false;
    this.recipeProposal = null;

    this.newGame();
    this.render();
    this.scheduleStar(1200);
  },

  returnToBook() {
    this.clearTimers();
    this.abortRequest();
    this.runId += 1;
    gameEnd.dismiss();
    this.busy = false;

    this.recipe = null;
    this.state = null;
    this.bookMode = true;
    this.localSteps = 0;
    this.recipeProposal = null;

    this.render();

    const recommended = this.recommendRecipe();
    if (recommended) this.proposeRecipe(recommended.id);
  },

  restartRecipe() {
    if (!this.recipe) return;
    this.clearTimers();
    this.abortRequest();
    this.runId += 1;
    gameEnd.dismiss();
    this.newGame();
    this.render();
    this.scheduleStar(1000);
  },

  newGame() {
    const recipe = this.recipe;
    if (!recipe) return;
    this.state = createCookingState(recipe);
    this.busy = false;
    this.localSteps = 0;
    const opening = recipe.openingLines ? recipe.openingLines(this.state) : [];
    opening.forEach(line => pushLine(this.state, line.who, line.text));
  },

  /* ============================ 渲染 ============================ */

  render() {
    if (!this.root) return;

    if (this.bookMode) {
      this.root.innerHTML = bookHTML(this.recipeProposal);
      return;
    }

    if (!this.state || !this.recipe) return;
    this.root.innerHTML = sceneHTML(this.state, this.recipe);
    const lines = this.root.querySelector('[data-scroll="lines"]');
    if (lines) lines.scrollTop = lines.scrollHeight;
  },

  /* ============================ 交互 ============================ */

  handleClick(event) {
    const target = event.target.closest('[data-act]');
    if (!target || target.disabled) return;
    const act = target.dataset.act;

    if (act === 'back') {
      window.PlaygroundRouter.go('lobby');
      return;
    }

    if (this.bookMode) {
      if (act === 'pick_recipe') {
        this.startRecipe(target.dataset.id);
        return;
      }
      if (act === 'accept_recommend') {
        const proposal = this.recipeProposal;
        if (proposal) this.startRecipe(proposal.recipeId);
        return;
      }
      if (act === 'dismiss_recommend') {
        this.recipeProposal = null;
        this.render();
        return;
      }
      return;
    }

    const state = this.state;
    const recipe = this.recipe;
    if (!state || !recipe) return;

    if (act === 'restart') {
      this.restartRecipe();
      return;
    }

    if (act === 'recipe_book') {
      this.returnToBook();
      return;
    }

    if (act === 'nudge') {
      this.requestAI(state.result ? 'final' : 'phase', true);
      return;
    }

    if (act === 'accept_proposal') {
      const action = recipe.acceptProposalAction ? recipe.acceptProposalAction(state) : null;
      if (action) this.dispatch(action.type, action.args, 'user');
      return;
    }

    if (act === 'dismiss_proposal') {
      state.divisionProposal = null;
      pushLine(state, 'system', recipe.dismissProposal ? recipe.dismissProposal(state) : '你决定自己拿主意。');
      this.render();
      return;
    }

    if (act === 'division') {
      const action = recipe.divisionAction
        ? recipe.divisionAction(state, target.dataset.key, target.dataset.who)
        : null;
      if (action) this.dispatch(action.type, action.args, 'user');
      return;
    }

    if (act === 'accept_rescue') {
      this.acceptRescue();
      return;
    }

    if (act === 'swap_division') {
      const action = recipe.buildSwapAction ? recipe.buildSwapAction(state) : null;
      if (action) this.dispatch(action.type, action.args, 'user');
      return;
    }

    const args = {};
    if (target.dataset.id !== undefined) args.id = target.dataset.id;
    if (target.dataset.delta !== undefined) args.delta = Number(target.dataset.delta);
    if (target.dataset.level !== undefined) args.level = Number(target.dataset.level);
    this.dispatch(act, args, 'user');
  },

  dispatch(type, args, actor) {
    const state = this.state;
    const recipe = this.recipe;
    if (!state || !recipe) return false;
    const prevPhase = state.phase;
    const prevEvents = state.events.length;

    const result = applyAction(state, { type, args }, actor, recipe);
    if (!result.ok) {
      state.notice = result.reason;
      this.render();
      this.later(() => {
        if (!this.state) return;
        this.state.notice = '';
        this.render();
      }, 1800);
      return false;
    }

    state.notice = '';
    this.render();
    this.afterAction(prevPhase, prevEvents, actor);
    return true;
  },

  afterAction(prevPhase, prevEvents, actor) {
    const state = this.state;
    const recipe = this.recipe;
    if (!state || !recipe) return;

    if (state.events.length > prevEvents) {
      this.maybeComment(`event:${state.phase}`, 'event', 700);
    }

    if (state.phase !== prevPhase) {
      this.localSteps = 0;
      if (state.result) {
        this.maybeFinal();
        return;
      }
      if (recipe.starHasWork(state)) {
        this.scheduleStar(900);
      } else {
        this.maybeComment(`enter:${state.phase}`, 'phase', 800);
      }
      return;
    }

    if (actor === 'user' && recipe.starHasWork(state)) {
      this.scheduleStar(900);
    }
  },

  /* ============================ 星星自主行动 ============================ */

  scheduleStar(delay) {
    if (this.starTimer) clearTimeout(this.starTimer);
    this.starTimer = this.later(() => {
      this.starTimer = null;
      this.starLoop();
    }, delay);
  },

  starLoop() {
    const state = this.state;
    const recipe = this.recipe;
    if (!state || !recipe || this.busy) return;

    if (recipe.starAutoStart(state)) {
      this.requestAI('intro');
      return;
    }

    if (!recipe.starHasWork(state)) return;

    const budget = aiBudget(state);
    if (budget.totalLeft > 0 && budget.phaseLeft > 0) {
      this.requestAI(recipe.starOccasion(state));
      return;
    }
    this.localStep();
  },

  localStep() {
    const state = this.state;
    const recipe = this.recipe;
    if (!state || !recipe || this.busy) return;
    if (!recipe.starHasWork(state)) return;
    if (this.localSteps >= 9) return;

    const action = recipe.heuristicAction(state);
    const result = applyAction(state, action, 'star', recipe);
    if (!result.ok) {
      pushLine(state, 'star', recipe.stuckLine || '……我有点拿不准，还是你来吧。');
      if (recipe.onStarStuck) recipe.onStarStuck(state);
      this.render();
      return;
    }

    this.localSteps += 1;
    pushLine(state, 'star', recipe.heuristicLine(state, action));
    this.render();

    if (state.result) {
      this.maybeFinal();
      return;
    }

    if (recipe.starHasWork(state)) {
      this.later(() => this.localStep(), 720);
      return;
    }

    const tail = recipe.afterLocalStep ? recipe.afterLocalStep(state) : null;
    if (tail) {
      if (tail.line) pushLine(state, 'system', tail.line);
      if (tail.commentKey) this.maybeComment(tail.commentKey, tail.occasion || 'phase', tail.delay || 600);
      this.render();
    }
  },

  async requestAI(occasion, manual = false) {
    const state = this.state;
    const recipe = this.recipe;
    if (!state || !recipe || this.busy) return;

    const budget = aiBudget(state);
    const noBudget = budget.totalLeft <= 0 || (occasion !== 'final' && budget.phaseLeft <= 0);
    if (noBudget) {
      if (recipe.starHasWork(state)) {
        this.localStep();
      } else if (occasion === 'final') {
        this.finishWithLocalLine();
      } else if (manual) {
        pushLine(state, 'star', recipe.fallbackAdvice(state));
        this.render();
      }
      return;
    }

    if (!manual && budget.cooldown > 0) {
      this.later(() => this.requestAI(occasion), budget.cooldown + 80);
      return;
    }

    const runId = this.runId;
    const recipeId = recipe.id;
    const phaseAtStart = state.phase;
    state.ai.calls += 1;
    state.ai.phaseCalls += 1;
    state.ai.lastAt = Date.now();
    state.ai.pending = true;
    this.busy = true;
    this.render();

    const controller = new AbortController();
    this.abort = controller;
    const timeoutId = setTimeout(() => {
      try { controller.abort(); } catch (e) { /* ignore */ }
    }, AI_TIMEOUT);

    let parsed = null;
    try {
      const adapter = getModelAdapter();
      const text = await adapter.complete({
        messages: buildMessages(state, occasion, recipe),
        signal: controller.signal,
        maxTokens: occasion === 'final' ? 160 : 240,
        temperature: 0.85
      });
      parsed = parseModelOutput(text);
    } catch (error) {
      parsed = null;
    } finally {
      clearTimeout(timeoutId);
    }

    // 旧请求返回：校验 runId + 当前菜谱，过期结果直接丢弃
    if (
      runId !== this.runId ||
      !this.state ||
      !this.recipe ||
      this.recipe.id !== recipeId ||
      this.state.recipeId !== recipeId
    ) return;

    this.abort = null;
    state.ai.pending = false;
    this.busy = false;

    if (state.phase !== phaseAtStart) return;

    if (occasion === 'final') {
      const line = parsed && parsed.line ? parsed.line : recipe.finalLine(state);
      pushLine(state, 'star', line);
      this.render();
      this.publishEndLine(line);
      return;
    }

    let action = null;
    let line = '';
    if (parsed) {
      const check = validateAction(state, parsed.action, 'star', recipe);
      if (check.ok) {
        action = parsed.action;
        line = parsed.line || '';
      }
    }

    if (!action) {
      action = recipe.heuristicAction(state);
      line = line || recipe.heuristicLine(state, action);
      if (parsed) state.aiRejected = parsed.action.type;
    }

    const result = applyAction(state, action, 'star', recipe);
    if (!result.ok) {
      const fallback = recipe.heuristicAction(state);
      const retry = applyAction(state, fallback, 'star', recipe);
      action = retry.ok ? fallback : action;
      if (!retry.ok) line = recipe.fallbackAdvice(state);
    }

    pushLine(state, 'star', line || recipe.heuristicLine(state, action));
    this.render();

    const progressed = action && !isPassiveAction(action.type);

    if (occasion === 'intro') return;
    if (state.phase !== phaseAtStart) {
      this.afterAction(phaseAtStart, state.events.length, 'star');
      return;
    }
    if (recipe.starHasWork(state)) {
      if (progressed) this.scheduleStar(1100);
      else this.later(() => this.localStep(), 900);
      return;
    }
    if (recipe.isInteractivePhase(state)) {
      if (action.type !== 'offer_rescue') this.maybeComment(`phase:${state.phase}`, 'phase', 500);
    }
  },

  acceptRescue() {
    const state = this.state;
    const recipe = this.recipe;
    if (!state || !recipe || !state.rescueOffer) return;

    const phase = state.rescueOffer.phase;
    if (phase !== state.phase) {
      state.rescueOffer = null;
      this.render();
      return;
    }

    const plan = recipe.rescuePlan ? recipe.rescuePlan(state, phase) : null;
    if (!plan || !plan.action) {
      state.notice = (plan && plan.reason) || '现在没法补救。';
      this.render();
      return;
    }

    const previous = state.division[phase];
    state.division[phase] = 'star';
    const result = applyAction(state, plan.action, 'star', recipe);
    state.division[phase] = previous;

    if (!result.ok) {
      state.notice = result.reason;
      this.render();
      return;
    }

    state.rescueOffer = null;
    pushLine(state, 'star', recipe.heuristicLine(state, plan.action));
    this.render();
    this.later(() => this.pump(), 900);
  },

  pump() {
    const state = this.state;
    const recipe = this.recipe;
    if (!state || !recipe) return;
    if (recipe.starHasWork(state)) this.starLoop();
  },

  maybeComment(key, occasion, delay) {
    const state = this.state;
    if (!state || state.advised[key]) return;
    state.advised[key] = true;
    this.later(() => this.requestAI(occasion), delay);
  },

  maybeFinal() {
    const state = this.state;
    if (!state || state.advised.final) return;
    state.advised.final = true;
    const attempt = () => {
      if (!this.state) return;
      if (this.busy) {
        this.later(attempt, 500);
        return;
      }
      this.requestAI('final');
    };
    this.later(attempt, 300);
  },

  finishWithLocalLine() {
    const state = this.state;
    const recipe = this.recipe;
    if (!state || !recipe) return;
    const line = recipe.finalLine(state);
    pushLine(state, 'star', line);
    this.render();
    this.publishEndLine(line);
  },

  // 一道菜完成：沿用已有的 final 台词弹一次气泡，不额外请求 API
  publishEndLine(line) {
    const state = this.state;
    const recipe = this.recipe;
    if (!state || !recipe || !state.result) return;
    if (this.endPublishedRun === this.runId) return;
    this.endPublishedRun = this.runId;

    const result = state.result;
    const text = line || recipe.finalLine(state);
    const summary = [result.dishName, result.grade, `${result.score} 分`].filter(Boolean).join(' · ');

    gameEnd.show({
      game: 'kitchen',
      gameName: '厨房大危机',
      token: `kitchen:${this.runId}`,
      line: text,
      result: summary,
      english: ''
    });
  }
};
