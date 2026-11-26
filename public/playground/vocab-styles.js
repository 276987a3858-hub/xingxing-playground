/* =====================================================
   和小星一起背单词 · 场景样式
   全部选择器带 .vocab- 前缀，作用域隔离，不污染其他游戏
   浅色梦幻配色，与当前大厅/厨房/五子棋的明亮改造保持一致
   ===================================================== */

export const VOCAB_STYLES = `
  .vocab-scene {
    max-width: 720px;
    margin: 16px auto;
    padding: 24px 22px 36px;
    color: #3a4a6b;
    font-family: inherit;
    box-sizing: border-box;
  }
  .vocab-scene *, .vocab-scene *::before, .vocab-scene *::after { box-sizing: border-box; }

  .vocab-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 18px;
  }
  .vocab-title-area { display: flex; align-items: center; gap: 12px; }
  .vocab-icon {
    font-size: 28px;
    filter: drop-shadow(0 0 10px rgba(180,160,230,.35));
  }
  .vocab-header h2 {
    margin: 0;
    font-size: 20px;
    letter-spacing: 2px;
    color: #4a4a6a;
  }
  .vocab-header .vocab-sub {
    margin-top: 2px;
    font-size: 11px;
    letter-spacing: 2px;
    color: #9a8ab8;
  }
  .vocab-exit {
    padding: 7px 14px;
    font-size: 12px;
    color: #5a6b8c;
    cursor: pointer;
    border-radius: 999px;
    border: 1px solid rgba(140,155,200,.35);
    background: rgba(255,255,255,.6);
    transition: border-color .2s, background .2s;
  }
  .vocab-exit:hover { border-color: rgba(168,156,214,.7); background: rgba(255,255,255,.85); }

  .vocab-progress {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 4px 0 18px;
    font-size: 12px;
    color: #7a8aa8;
  }
  .vocab-progress-track {
    flex: 1;
    height: 6px;
    border-radius: 999px;
    background: rgba(150,160,200,.2);
    overflow: hidden;
  }
  .vocab-progress-fill {
    height: 100%;
    border-radius: 999px;
    background: linear-gradient(90deg, #b8a0d8, #8fb4e0);
    transition: width .35s ease;
  }

  .vocab-bubble {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    min-height: 54px;
    margin: 10px 0 20px;
    padding: 13px 16px;
    border-radius: 16px;
    background: rgba(255,255,255,.72);
    border: 1px solid rgba(168,156,214,.28);
    box-shadow: 0 6px 18px rgba(140,120,200,.1);
    backdrop-filter: blur(6px);
  }
  .vocab-bubble-avatar {
    flex: 0 0 auto;
    width: 34px; height: 34px;
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 17px;
    color: #fff;
    background: linear-gradient(145deg, #b8a0d8, #8fb4e0);
    box-shadow: 0 2px 8px rgba(140,120,200,.3);
  }
  .vocab-bubble-body { flex: 1; min-width: 0; }
  .vocab-bubble-name { font-size: 11px; letter-spacing: 1px; color: #9a8ab8; margin-bottom: 3px; }
  .vocab-bubble-text { font-size: 14px; line-height: 1.7; color: #4a4a6a; }
  .vocab-bubble-text.vocab-thinking { color: #9a8ab8; font-style: italic; }

  .vocab-card {
    margin: 0 0 18px;
    padding: 26px 24px;
    border-radius: 20px;
    background: rgba(255,255,255,.78);
    border: 1px solid rgba(168,156,214,.26);
    box-shadow: 0 10px 30px rgba(140,120,200,.12);
    backdrop-filter: blur(8px);
  }
  .vocab-card-label {
    font-size: 11px;
    letter-spacing: 2px;
    color: #9a8ab8;
    margin-bottom: 12px;
  }
  .vocab-word {
    font-size: 38px;
    font-weight: 600;
    letter-spacing: 1px;
    color: #4a3a6a;
    margin-bottom: 6px;
  }
  .vocab-phonetic { font-size: 14px; color: #8a9ab8; margin-bottom: 18px; }
  .vocab-meaning { font-size: 18px; color: #5a6b8c; margin-bottom: 16px; }
  .vocab-example {
    font-size: 13px;
    line-height: 1.8;
    color: #6a7a9a;
    padding: 12px 14px;
    border-radius: 12px;
    background: rgba(230,225,248,.5);
    border-left: 3px solid #c0aee0;
  }
  .vocab-example b { color: #6a4a9a; }

  .vocab-prompt {
    font-size: 26px;
    font-weight: 600;
    color: #4a3a6a;
    text-align: center;
    line-height: 1.5;
    margin: 6px 0 8px;
  }
  .vocab-prompt.vocab-prompt-en { font-size: 34px; letter-spacing: 1px; }
  .vocab-prompt-sub {
    text-align: center;
    font-size: 13px;
    color: #8a9ab8;
    margin-bottom: 22px;
  }

  .vocab-options {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .vocab-option {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 13px 16px;
    border-radius: 13px;
    border: 1px solid rgba(168,156,214,.3);
    background: rgba(255,255,255,.7);
    color: #5a5a7a;
    font-size: 15px;
    text-align: left;
    cursor: pointer;
    transition: border-color .2s, background .2s, transform .15s, box-shadow .2s;
  }
  .vocab-option:hover:not(:disabled) {
    border-color: rgba(168,156,214,.7);
    background: rgba(255,255,255,.95);
    transform: translateY(-1px);
    box-shadow: 0 4px 14px rgba(140,120,200,.14);
  }
  .vocab-option-key {
    flex: 0 0 auto;
    width: 26px; height: 26px;
    border-radius: 8px;
    display: flex; align-items: center; justify-content: center;
    font-size: 12px;
    color: #7a6a9a;
    background: rgba(230,225,248,.7);
  }
  .vocab-option.correct { border-color: #7fb89a; background: rgba(224,244,232,.85); color: #2f6b48; }
  .vocab-option.correct .vocab-option-key { background: rgba(127,184,154,.3); color: #2f6b48; }
  .vocab-option.wrong { border-color: #d99a9a; background: rgba(250,232,232,.85); color: #9a4040; }
  .vocab-option.wrong .vocab-option-key { background: rgba(217,154,154,.3); color: #9a4040; }
  .vocab-option:disabled { cursor: default; }

  .vocab-spell-input {
    width: 100%;
    padding: 14px 16px;
    font-size: 20px;
    letter-spacing: 2px;
    text-align: center;
    border-radius: 13px;
    border: 1px solid rgba(168,156,214,.4);
    background: rgba(255,255,255,.85);
    color: #4a3a6a;
    outline: none;
    transition: border-color .2s, box-shadow .2s;
  }
  .vocab-spell-input:focus { border-color: #a890d0; box-shadow: 0 0 0 3px rgba(168,144,208,.18); }
  .vocab-spell-input:disabled { background: rgba(240,238,248,.7); }

  .vocab-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 8px;
  }
  .vocab-btn {
    padding: 11px 22px;
    font-size: 14px;
    border-radius: 999px;
    cursor: pointer;
    border: 1px solid rgba(168,156,214,.4);
    background: rgba(255,255,255,.7);
    color: #5a6b8c;
    transition: border-color .2s, background .2s, transform .15s;
  }
  .vocab-btn:hover:not(:disabled) { border-color: #a890d0; background: rgba(255,255,255,.95); transform: translateY(-1px); }
  .vocab-btn:disabled { opacity: .45; cursor: default; }
  .vocab-btn.primary {
    color: #fff;
    border-color: transparent;
    background: linear-gradient(135deg, #b8a0d8, #8fb4e0);
    box-shadow: 0 6px 18px rgba(140,120,200,.28);
  }
  .vocab-btn.primary:hover:not(:disabled) { background: linear-gradient(135deg, #ac92d0, #7fa8dc); }
  .vocab-btn.ghost { background: transparent; }

  .vocab-levels {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
    margin-bottom: 18px;
  }
  .vocab-level {
    padding: 16px 12px;
    border-radius: 15px;
    border: 1px solid rgba(168,156,214,.3);
    background: rgba(255,255,255,.66);
    text-align: center;
    cursor: pointer;
    transition: border-color .2s, background .2s, transform .15s, box-shadow .2s;
  }
  .vocab-level:hover { transform: translateY(-2px); box-shadow: 0 6px 18px rgba(140,120,200,.14); }
  .vocab-level.selected { border-color: #a890d0; background: rgba(240,234,252,.9); box-shadow: 0 0 0 2px rgba(168,144,208,.2) inset; }
  .vocab-level strong { display: block; font-size: 16px; color: #5a4a7a; margin-bottom: 4px; }
  .vocab-level small { font-size: 11px; color: #9a8ab8; }

  .vocab-chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 6px 0 4px; }
  .vocab-chip {
    padding: 7px 13px;
    font-size: 12px;
    border-radius: 999px;
    border: 1px solid rgba(168,156,214,.35);
    background: rgba(255,255,255,.6);
    color: #6a7a9a;
    cursor: pointer;
    transition: border-color .2s, background .2s;
  }
  .vocab-chip.selected { border-color: #a890d0; background: rgba(235,228,250,.9); color: #5a4a7a; }

  .vocab-hint-box {
    margin: 12px 0 0;
    padding: 11px 14px;
    font-size: 13px;
    line-height: 1.7;
    color: #7a5a9a;
    border-radius: 12px;
    background: rgba(235,228,250,.6);
    border: 1px dashed rgba(168,144,208,.5);
  }

  .vocab-stats {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
    margin: 4px 0 18px;
  }
  .vocab-stat {
    padding: 14px 8px;
    border-radius: 14px;
    background: rgba(255,255,255,.7);
    border: 1px solid rgba(168,156,214,.24);
    text-align: center;
  }
  .vocab-stat b { display: block; font-size: 24px; color: #6a4a9a; }
  .vocab-stat small { font-size: 11px; color: #9a8ab8; }

  .vocab-wordlist { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0 4px; }
  .vocab-tag {
    padding: 6px 12px;
    font-size: 12px;
    border-radius: 999px;
    background: rgba(235,228,250,.7);
    color: #6a4a9a;
  }
  .vocab-tag small { color: #9a8ab8; margin-left: 4px; }
  .vocab-empty { font-size: 13px; color: #9a8ab8; padding: 8px 0; }

  .vocab-notice {
    margin-top: 14px;
    font-size: 12px;
    line-height: 1.7;
    color: #9a8ab8;
    text-align: center;
  }
  .vocab-error { color: #b8546a; }

  /* 学习记录（可展开） */
  .vocab-history {
    margin-top: 22px;
    padding: 18px 20px;
    border-radius: 18px;
    background: rgba(255,255,255,.62);
    border: 1px solid rgba(168,156,214,.24);
  }
  .vocab-history-title {
    font-size: 13px;
    letter-spacing: 2px;
    color: #6a5a8a;
    margin-bottom: 10px;
  }
  .vocab-history-title small { font-size: 11px; letter-spacing: 0; color: #a89ac2; margin-left: 6px; }
  .vocab-history-item {
    margin-bottom: 8px;
    border-radius: 12px;
    border: 1px solid rgba(168,156,214,.26);
    background: rgba(255,255,255,.7);
    overflow: hidden;
  }
  .vocab-history-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 11px 14px;
    cursor: pointer;
    user-select: none;
    transition: background .2s;
  }
  .vocab-history-head:hover { background: rgba(235,228,250,.55); }
  .vocab-history-idx { font-size: 13px; font-weight: 600; color: #6a4a9a; white-space: nowrap; }
  .vocab-history-meta { flex: 1; font-size: 11px; color: #9a8ab8; }
  .vocab-history-arrow { font-size: 13px; color: #a890d0; transition: transform .2s; }
  .vocab-history-item.open .vocab-history-arrow { transform: rotate(180deg); }
  .vocab-history-body { display: none; padding: 4px 14px 14px; }
  .vocab-history-item.open .vocab-history-body { display: block; }

  /* 单词明细表 */
  .vocab-hist-table {
    max-height: 320px;
    overflow-y: auto;
    border-radius: 10px;
    border: 1px solid rgba(168,156,214,.18);
  }
  .vocab-hist-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    font-size: 13px;
    border-bottom: 1px solid rgba(168,156,214,.14);
  }
  .vocab-hist-row:last-child { border-bottom: none; }
  .vocab-hist-row:nth-child(odd) { background: rgba(235,228,250,.28); }
  .vocab-hist-word { flex: 0 0 34%; font-weight: 600; color: #4a3a6a; }
  .vocab-hist-cn { flex: 1; color: #7a8aa8; }
  .vocab-hist-result { flex: 0 0 auto; font-size: 11px; padding: 3px 9px; border-radius: 999px; white-space: nowrap; }
  .vocab-hist-result.ok { color: #2f7a52; background: rgba(127,184,154,.18); }
  .vocab-hist-result.hint { color: #8a6a2a; background: rgba(224,196,120,.22); }
  .vocab-hist-result.bad { color: #b8546a; background: rgba(217,154,154,.18); }

  /* 「星星的单词本」：像两个人一起记的学习笔记 */
  .vocab-book { padding: 6px 4px 10px; }
  .vocab-book-note {
    font-size: 12px; line-height: 1.7; color: #9a8ab8; letter-spacing: 1px;
    text-align: center; margin-bottom: 12px; padding-bottom: 14px;
    border-bottom: 1px dashed rgba(168,156,214,.35);
  }
  .vocab-book-overview {
    display: flex; flex-wrap: wrap; justify-content: center; gap: 6px 18px;
    margin-bottom: 18px; font-size: 12px; color: #8a9ab8;
  }
  .vocab-book-overview b { color: #6a4a9a; font-size: 13px; margin-left: 3px; }
  .vocab-book-state {
    flex: 0 0 auto; font-size: 11px; padding: 3px 9px;
    border-radius: 999px; white-space: nowrap;
  }
  .vocab-book-state-learning { color: #8a6a2a; background: rgba(224,196,120,.22); }
  .vocab-book-state-mastered { color: #2f7a52; background: rgba(127,184,154,.2); }
  .vocab-book-mark {
    flex: 0 0 auto; align-self: center; padding: 4px 11px;
    font-size: 11px; border-radius: 999px;
  }
  .vocab-book-section {
    margin-bottom: 20px; padding: 18px 18px 16px; border-radius: 16px;
    background: rgba(255,255,255,.72); border: 1px solid rgba(168,156,214,.26);
    box-shadow: 0 6px 18px rgba(140,120,200,.09);
  }
  .vocab-book-h {
    font-size: 14px; font-weight: 600; letter-spacing: 1px; color: #6a4a9a;
    margin-bottom: 10px; padding-left: 10px; border-left: 3px solid #c0aee0;
  }
  .vocab-book-h small { font-size: 11px; font-weight: 400; color: #a89ac2; margin-left: 6px; letter-spacing: 0; }
  .vocab-book-desc { font-size: 12px; line-height: 1.7; color: #8a9ab8; margin: 0 0 14px; }
  .vocab-book-table { max-height: 260px; overflow-y: auto; border-radius: 10px; border: 1px solid rgba(168,156,214,.18); }
  .vocab-book-row {
    display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 12px;
    padding: 9px 12px; font-size: 13px; border-bottom: 1px solid rgba(168,156,214,.14);
  }
  .vocab-book-row:last-child { border-bottom: none; }
  .vocab-book-row:nth-child(odd) { background: rgba(235,228,250,.28); }
  .vocab-book-row-warn, .vocab-book-row-warn:nth-child(odd) { background: rgba(250,232,232,.42); }
  .vocab-book-word { flex: 0 0 auto; font-weight: 600; color: #4a3a6a; }
  .vocab-book-word small { font-size: 11px; font-weight: 400; color: #a89ac2; margin-left: 5px; }
  .vocab-book-cn { flex: 1 1 120px; color: #7a8aa8; }
  .vocab-book-meta { flex: 1 1 100%; font-size: 11px; color: #a89ac2; }
  .vocab-book-challenge { background: linear-gradient(135deg, rgba(240,234,252,.9), rgba(228,238,252,.85)); }

  @media (max-width: 520px) {
    .vocab-scene { padding: 18px 14px 30px; }
    .vocab-word { font-size: 32px; }
    .vocab-levels { grid-template-columns: 1fr; }
  }
`;
