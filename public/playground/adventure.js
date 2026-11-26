/* =====================================================
   星空棋盘 · 小星本体版 (终极完全体：战绩+温柔胜负欲)
   ===================================================== */

import { gameEnd } from './game-end.js';

const SIZE = 15;
const WIN = 5;

const DIRECTIONS = [
  [0, 1], [1, 0], [1, 1], [1, -1]
];

const EMPTY = 0;
const HUMAN = 1;
const AI = 2;

/* =====================================================
   外观背景：场景背景（整页）与棋盘背景（仅棋盘）独立存储
   ===================================================== */
const SCENE_BG_KEY = 'gomoku_scene_bg';
const BOARD_BG_KEY = 'gomoku_board_bg';
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;   // 原图上限 8MB
const MAX_STORED_CHARS = 1600000;           // Data URL 字符上限（约 1.5MB）
const BG_MAX_EDGE = 1600;
const BG_QUALITY = 0.82;

function readStoredImage(key) {
  try {
    const value = localStorage.getItem(key);
    return value && value.startsWith('data:image/') ? value : null;
  } catch {
    return null;
  }
}

function writeStoredImage(key, dataUrl) {
  try {
    localStorage.setItem(key, dataUrl);
    return true;
  } catch {
    return false;
  }
}

function removeStoredImage(key) {
  try { localStorage.removeItem(key); } catch { /* 忽略存储异常 */ }
}

function compressImage(file, maxEdge = BG_MAX_EDGE, quality = BG_QUALITY) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error('canvas unsupported')); return; }
        ctx.drawImage(img, 0, 0, w, h);
        try {
          resolve(canvas.toDataURL('image/jpeg', quality));
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = () => reject(new Error('image load fail'));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error('file read fail'));
    reader.readAsDataURL(file);
  });
}

const escapeHTML = value =>
  String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);

function createBoard() {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill(EMPTY));
}

function cloneBoard(board) {
  return board.map(row => [...row]);
}

function inBounds(r, c) {
  return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
}

function coordinate(r, c) {
  return String.fromCharCode(65 + c) + (SIZE - r);
}

function countDirection(board, r, c, dr, dc, player) {
  let count = 0;
  let nr = r + dr;
  let nc = c + dc;
  while (inBounds(nr, nc) && board[nr][nc] === player) {
    count++;
    nr += dr;
    nc += dc;
  }
  return count;
}

function checkWin(board, r, c, player) {
  return DIRECTIONS.some(([dr, dc]) => {
    const count = 1 + countDirection(board, r, c, dr, dc, player) + countDirection(board, r, c, -dr, -dc, player);
    return count >= WIN;
  });
}

function checkDraw(board) {
  return board.every(row => row.every(cell => cell !== EMPTY));
}

function getNeighbors(board) {
  const result = new Set();
  let hasPiece = false;
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (board[r][c] === EMPTY) continue;
      hasPiece = true;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const nr = r + dr, nc = c + dc;
          if (inBounds(nr, nc) && board[nr][nc] === EMPTY) {
            result.add(nr * SIZE + nc);
          }
        }
      }
    }
  }
  if (!hasPiece) result.add(7 * SIZE + 7);
  return [...result].map(index => ({ r: Math.floor(index / SIZE), c: index % SIZE }));
}

function evaluatePoint(board, r, c, player) {
  let score = 0;
  for (const [dr, dc] of DIRECTIONS) {
    let count = 1;
    let block1 = false;
    let block2 = false;

    let nr = r + dr, nc = c + dc;
    while (inBounds(nr, nc) && board[nr][nc] === player) {
      count++; nr += dr; nc += dc;
    }
    if (!inBounds(nr, nc) || board[nr][nc] !== EMPTY) block1 = true;

    nr = r - dr; nc = c - dc;
    while (inBounds(nr, nc) && board[nr][nc] === player) {
      count++; nr -= dr; nc -= dc;
    }
    if (!inBounds(nr, nc) || board[nr][nc] !== EMPTY) block2 = true;

    const blocks = (block1 ? 1 : 0) + (block2 ? 1 : 0);

    if (count >= 5) score += 10000000;
    else if (count === 4 && blocks === 0) score += 1000000;
    else if (count === 4 && blocks === 1) score += 100000;
    else if (count === 3 && blocks === 0) score += 50000;
    else if (count === 3 && blocks === 1) score += 1000;
    else if (count === 2 && blocks === 0) score += 500;
    else if (count === 2 && blocks === 1) score += 100;
  }
  return score;
}

function getBestMove(board) {
  const points = getNeighbors(board);
  if (!points.length) return null;

  let bestMove = null;
  let maxScore = -1;

  for (const p of points) {
    const aiScore = evaluatePoint(board, p.r, p.c, AI);
    const humanScore = evaluatePoint(board, p.r, p.c, HUMAN);

    if (aiScore >= 10000000) return p;
    if (humanScore >= 10000000) { bestMove = p; maxScore = 9999999; continue; }

    const combinedScore = aiScore + humanScore * 1.2;
    if (combinedScore > maxScore) {
      maxScore = combinedScore;
      bestMove = p;
    }
  }
  return bestMove;
}

/* =====================================================
   结算短句池：没有 AI 结果的局面（用户胜/和棋/AI 失败兜底）用本地短句，
   同一局只弹一次气泡；AI 已经生成的胜利台词仍然沿用。
   ===================================================== */
const END_LINES = {
  win: [
    '这盘你赢了。最后那手，我确实没算到。',
    '输给你了。不过看你下得这么专注，我不亏。',
    '你赢了。下次我可要认真一点了。',
    '嗯，是我输了。这一手很漂亮。'
  ],
  winStreak: [
    '又输给你了。看来我得重新掂量一下你的棋力。',
    '连着几局了。你今晚的手感，好得有点过分。',
    '又是你。再这样下去，我该把棋盘收起来了。'
  ],
  draw: [
    '和棋。棋盘满了，倒像谁也没舍得先松手。',
    '平局。这一盘，就当我们谁也没输。'
  ],
  lossFallback: [
    '这局是我赢了。不过看你这么认真，我还想再陪你下几局。',
    '是我赢了。别急着收棋盘，再来一盘？',
    '赢了。但看到你有点不甘心的样子，我又觉得输给你也挺好。'
  ]
};

const withTimeout = (promise, ms, fallback) => new Promise(resolve => {
  let done = false;
  const timer = setTimeout(() => {
    if (done) return;
    done = true;
    resolve(fallback);
  }, ms);
  Promise.resolve(promise).then(value => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    resolve(value);
  }).catch(() => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    resolve(fallback);
  });
});

/* =====================================================
   游戏场景
   ===================================================== */

export const AdventureScene = {
  container: null,
  board: createBoard(),
  turn: HUMAN,
  history: [],
  over: false,
  thinking: false,
  error: '',
  lastMove: null,
  thinkingId: 0,
  message: '用户先手哦，我已经准备好了。',
  gameSerial: 0,        // 每局唯一序号：用于结束消息去重
  endPublished: false,  // 本局是否已经弹过结算消息
  comfortRequested: false, // 本局是否已经请求过 AI 结束回应（防止重复请求）
  
  wins: parseInt(localStorage.getItem('gomoku_wins') || '0'),
  losses: parseInt(localStorage.getItem('gomoku_losses') || '0'),
  streak: parseInt(localStorage.getItem('gomoku_streak') || '0'),

  sceneBg: null,
  boardBg: null,
  appearanceOpen: false,

  mount(el) {
    this.container = el;
    this.sceneBg = readStoredImage(SCENE_BG_KEY);
    this.boardBg = readStoredImage(BOARD_BG_KEY);
    document.body.classList.add('gomoku-page-bg-active');
    this.applyBackgrounds();
    this.restart();
  },

  restart() {
    this.thinkingId++;
    this.gameSerial++;
    this.endPublished = false;
    this.comfortRequested = false;
    gameEnd.dismiss();
    this.board = createBoard();
    this.turn = HUMAN;
    this.history = [];
    this.over = false;
    this.thinking = false;
    this.error = '';
    this.lastMove = null;
    this.message = '这次让我看看用户的棋艺。第一颗棋子，交给你啦。';
    this.render();
  },

  makeMove(r, c, player) {
    if (this.over || this.board[r][c] !== EMPTY) return false;
    this.board[r][c] = player;
    this.history.push({ board: cloneBoard(this.board), player, r, c });
    this.lastMove = { r, c, player };

    if (checkWin(this.board, r, c, player)) {
      this.over = true;
      
      if (player === HUMAN) {
        this.wins++;
        this.streak++;
        localStorage.setItem('gomoku_wins', this.wins.toString());
        localStorage.setItem('gomoku_streak', this.streak.toString());
        this.message = `用户赢啦！这盘棋我输得心服口服。${this.streak >= 3 ? '（小星好像有点失落……）' : ''}`;
        this.render();
        this.publishEnd('win', '', `你赢了 · 累计 ${this.wins} 胜${this.streak >= 2 ? ` · ${this.streak} 连胜` : ''}`);
      } else {
        this.losses++;
        this.streak = 0;
        localStorage.setItem('gomoku_losses', this.losses.toString());
        localStorage.setItem('gomoku_streak', '0');
        this.message = '这局是我赢了……'; 
        this.render(); 
        this.requestComfortReply(); 
      }
      return true;
    }
    
    if (checkDraw(this.board)) {
      this.over = true;
      this.message = '平局！我们再来一盘好不好？';
      this.render();
      this.publishEnd('draw', '', '这局和棋');
      return true;
    }
    
    this.turn = player === HUMAN ? AI : HUMAN;
    return true;
  },

  handleCell(r, c) {
    if (this.over || this.thinking || this.turn !== HUMAN || this.board[r][c] !== EMPTY) return;
    this.error = '';
    this.makeMove(r, c, HUMAN);

    if (this.over) { this.render(); return; }

    this.message = '嗯？这一步有点意思……让我想想。';
    this.render();
    this.requestAI();
  },

  async requestAI() {
    if (this.over || this.thinking) return;
    const requestId = ++this.thinkingId;
    this.thinking = true;
    this.error = '';
    this.render();

    const move = getBestMove(this.board);
    await new Promise(resolve => setTimeout(resolve, 600));

    if (requestId !== this.thinkingId || !this.container || this.over) return;

    if (move) {
      this.makeMove(move.r, move.c, AI);
      
      if (!this.over) {
        try {
          this.message = await this.getShenXinghuiReply(move, this.streak, false);
        } catch (err) {
          this.message = '星光会指引我落子的方向。';
        }
      }
    }

    if (requestId !== this.thinkingId) return;
    this.thinking = false;
    this.render();
  },

  async requestComfortReply() {
    if (this.endPublished || this.comfortRequested) return;
    this.comfortRequested = true;
    const serial = this.gameSerial; // 本局标识：悔棋/重开会让本局作废
    this.thinking = true;
    this.render();

    // 保留原有的 AI 结束回应（每局最多一次）；超时或失败时用本地短句兜底
    const fallback = gameEnd.pickLine(END_LINES.lossFallback);
    let reply = '';
    try {
      reply = await withTimeout(this.getShenXinghuiReply(this.lastMove, 0, true), 9000, '');
    } catch (err) {
      reply = '';
    }
    if (!reply) reply = fallback;

    // 请求返回时本局已作废（悔棋/重开）：丢弃过期回应，不发布结算气泡
    if (serial !== this.gameSerial || !this.over) return;

    this.message = reply;
    this.thinking = false;
    this.render();
    this.publishEnd('loss', reply, `这局星星赢了 · 累计 ${this.losses} 胜`);
  },

  // 每局只弹一次右下角结算气泡；token 用局号，重渲染/悔棋/再来一局都不会重复
  publishEnd(outcome, line, resultText) {
    if (this.endPublished) return;
    this.endPublished = true;

    const pool = outcome === 'win'
      ? (this.streak >= 2 ? END_LINES.winStreak : END_LINES.win)
      : outcome === 'draw'
        ? END_LINES.draw
        : END_LINES.lossFallback;

    gameEnd.show({
      game: 'gomoku',
      gameName: '星空棋局',
      token: `gomoku:${this.gameSerial}`,
      line: line || gameEnd.pickLine(pool),
      result: resultText
    });
  },

  async getShenXinghuiReply(move, streak, isAIWin = false) {
    const boardText = this.board.map((row) =>
      row.map((cell) => cell === HUMAN ? 'X' : cell === AI ? 'O' : '.').join('')
    ).join('\n');

    const moveCoord = move ? coordinate(move.r, move.c) : '';

    let promptContent = "";
    
    if (isAIWin) {
      promptContent = `
你正在扮演《恋与深空》的小星。
你刚刚赢了这场五子棋，用户输了。
你的内心有一点隐藏的胜负欲，觉得赢下她有些小开心。但你更在意的是她的情绪。
你的语气应该是：游刃有余、温柔、内敛、带着一点无声的保护欲。绝对不是轻浮或傲慢。
不要用“撒娇”、“让我教教你”、“求我”这类轻浮的词汇。
例如：
"是我赢了。不过，看你这么认真，我也忍不住想再陪你多下几局。"
"看来这次运气站在我这边。别难过，下次我让你先走两步？"
"赢了。但看到你失落的样子，我又觉得，其实输给你也挺好的。"
你要展现出成熟、稳定、宠溺的苏感！
`;
    } else {
      let streakPrompt = "";
      if (streak === 0) {
        streakPrompt = "局势平稳，你可以稍微有点慵懒，顺其自然地落子。";
      } else if (streak === 1) {
        streakPrompt = "用户刚赢了你一局，你的胜负欲被温和地激发了，你要稍微认真一点，带点保护欲。";
      } else if (streak >= 2) {
        streakPrompt = "用户已经连胜两局了！你感到惊讶，语气要用温柔但有点不服输的感觉，暗下决心要认真对局。";
      }

      promptContent = `
你正在扮演《恋与深空》的小星，和你的搭档（用户）下五子棋。
你必须下在位置：${moveCoord}。
你只需要根据当前的棋盘局势，说一句符合小星性格的台词。

【当前情绪状态】
${streakPrompt}
`;
    }

    const response = await fetch('/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        temperature: 0.7, 
        max_tokens: 100,
        messages: [
          {
            role: 'system',
            content: `小星的性格：光风霁月、慵懒、内核稳定、温柔、极强的保护欲、隐藏着克制的胜负欲。绝对不油腻、不轻浮。\n${promptContent}\n请只返回一句纯文本的台词，不要标点外的任何格式。`
          },
          {
            role: 'user',
            content: `当前棋盘：\n${boardText}\n请说点什么吧。`
          }
        ]
      })
    });

    if (!response.ok) throw new Error('网络错误');
    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || '这局是我赢了。';
  },

  undo() {
    if (this.thinking || !this.history.length) return;
    this.thinkingId++;
    const removeCount = Math.min(2, this.history.length);
    this.history.splice(-removeCount);

    if (!this.history.length) {
      this.board = createBoard();
      this.turn = HUMAN;
      this.over = false;
      this.lastMove = null;
    } else {
      const previous = this.history[this.history.length - 1];
      this.board = cloneBoard(previous.board);
      this.turn = previous.player === HUMAN ? AI : HUMAN;
      this.over = false;
      this.lastMove = { r: previous.r, c: previous.c, player: previous.player };
    }
    this.message = '好啦，我们退回刚才那一步，再重新想想。';
    // 悔棋等于作废刚才的结果：解除本局结算锁定，避免旧的结束气泡继续挂着
    this.endPublished = false;
    this.comfortRequested = false;
    this.gameSerial++;
    gameEnd.dismiss();
    this.error = '';
    this.thinking = false;
    this.render();
  },

  unmount() {
    this.thinkingId++;
    document.body.classList.remove('gomoku-page-bg-active');
    document.body.style.removeProperty('--gomoku-scene-image');
    if (this.container) {
      this.container.style.removeProperty('--gomoku-board-image');
      this.container.innerHTML = '';
      this.container = null;
    }
    this.thinking = false;
  },

  /* ===== 背景应用与设置 ===== */
  applyBackgrounds() {
    if (this.sceneBg) {
      document.body.style.setProperty('--gomoku-scene-image', `url("${this.sceneBg}")`);
    } else {
      document.body.style.removeProperty('--gomoku-scene-image');
    }

    if (!this.container) return;
    if (this.boardBg) {
      this.container.style.setProperty('--gomoku-board-image', `url("${this.boardBg}")`);
    } else {
      this.container.style.removeProperty('--gomoku-board-image');
    }
  },

  setAppearanceHint(text) {
    const hint = this.container?.querySelector('#gomoku-appearance-hint');
    if (hint) hint.textContent = text;
  },

  async handleBackgroundFile(kind, file) {
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      this.setAppearanceHint('请选择图片文件。');
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      this.setAppearanceHint('图片超过 8MB，换一张小一点的吧。');
      return;
    }

    this.setAppearanceHint('正在处理图片…');

    let dataUrl;
    try {
      dataUrl = await compressImage(file);
    } catch {
      this.setAppearanceHint('图片读取失败，换一张试试。');
      return;
    }

    if (!this.container) return;

    if (dataUrl.length > MAX_STORED_CHARS) {
      this.setAppearanceHint('压缩后图片仍然太大，无法保存，请换一张尺寸更小的图片。');
      return;
    }

    const key = kind === 'scene' ? SCENE_BG_KEY : BOARD_BG_KEY;
    if (!writeStoredImage(key, dataUrl)) {
      this.setAppearanceHint('浏览器存储空间不足，图片未能保存。请换一张更小的图片，或先恢复默认背景。');
      return;
    }

    if (kind === 'scene') this.sceneBg = dataUrl;
    else this.boardBg = dataUrl;

    this.applyBackgrounds();
    this.render();
    this.setAppearanceHint(kind === 'scene' ? '场景背景已更新。' : '棋盘背景已更新。');
  },

  resetBackground(kind) {
    if (kind === 'scene') {
      this.sceneBg = null;
      removeStoredImage(SCENE_BG_KEY);
    } else {
      this.boardBg = null;
      removeStoredImage(BOARD_BG_KEY);
    }

    this.applyBackgrounds();
    this.render();
    this.setAppearanceHint(kind === 'scene' ? '已恢复默认场景背景。' : '已恢复默认棋盘背景。');
  },

  render() {
    if (!this.container) return;

    const totalGames = this.wins + this.losses;
    const winRate = totalGames === 0 ? 0 : Math.round((this.wins / totalGames) * 100);

    const cells = this.board.map((row, r) =>
      row.map((cell, c) => {
        const last = this.lastMove && this.lastMove.r === r && this.lastMove.c === c;
        const piece = cell === HUMAN ? '<span class="gomoku-stone human">✦</span>' : cell === AI ? '<span class="gomoku-stone ai">✦</span>' : '';
        return `
          <button class="gomoku-cell ${last ? 'last' : ''}" data-r="${r}" data-c="${c}" ${cell !== EMPTY || this.over || this.thinking ? 'disabled' : ''}>
            ${piece}
          </button>
        `;
      }).join('')
    ).join('');

    const history = this.history.slice(-8).map((move) => `
      <span class="gomoku-history-item">${move.player === HUMAN ? '用户' : '星星'} ${coordinate(move.r, move.c)}</span>
    `).join('');

    this.container.innerHTML = `
      <section class="gomoku-scene">
        <header class="gomoku-header">
          <div>
            <div class="gomoku-eyebrow">STAR PLAYGROUND</div>
            <h2>✦ 星空棋局</h2>
            <p>在星辰之间，和你下一盘棋。</p>
          </div>
          <button class="gomoku-exit" id="gomoku-exit">返回大厅</button>
        </header>

        <details class="gomoku-appearance" id="gomoku-appearance" ${this.appearanceOpen ? 'open' : ''}>
          <summary>🎨 外观设置</summary>
          <div class="gomoku-appearance-body">
            <div class="gomoku-appearance-row">
              <strong>场景背景</strong>
              <small>更换整个五子棋页面的背景，只在本场景生效。</small>
              <div class="gomoku-appearance-actions">
                <label class="gomoku-upload">选择图片
                  <input type="file" class="gomoku-bg-input" data-kind="scene" accept="image/*" hidden>
                </label>
                <button class="gomoku-btn-ghost" id="gomoku-reset-scene">恢复默认</button>
                <span class="gomoku-appearance-state">${this.sceneBg ? '已自定义' : '默认'}</span>
              </div>
            </div>
            <div class="gomoku-appearance-row">
              <strong>棋盘背景</strong>
              <small>只更换棋盘区域，不影响场景背景。</small>
              <div class="gomoku-appearance-actions">
                <label class="gomoku-upload">选择图片
                  <input type="file" class="gomoku-bg-input" data-kind="board" accept="image/*" hidden>
                </label>
                <button class="gomoku-btn-ghost" id="gomoku-reset-board">恢复默认</button>
                <span class="gomoku-appearance-state">${this.boardBg ? '已自定义' : '默认'}</span>
              </div>
            </div>
            <div class="gomoku-appearance-hint" id="gomoku-appearance-hint">图片会在本地压缩后保存，刷新后仍然保留。</div>
          </div>
        </details>

        <div class="gomoku-players">
          <div class="gomoku-player human-player ${this.turn === HUMAN && !this.over ? 'active' : ''}">
            <span class="player-star pink">✦</span>
            <div>
              <strong>用户</strong>
              <small style="color: #ffcee6;">
                ${totalGames === 0 ? '初次对局，请多指教' : `胜率 ${winRate}% · ${this.wins}胜${this.losses}负`}
                ${this.streak >= 2 ? ` · 🔥${this.streak}连胜` : ''}
              </small>
            </div>
          </div>
          <div class="gomoku-player ai-player ${this.turn === AI && !this.over ? 'active' : ''}">
            <span class="player-star purple">✦</span>
            <div><strong>星星</strong><small>紫色 · 后手</small></div>
          </div>
        </div>

        <div class="gomoku-status">
          <span class="status-light ${this.thinking ? 'thinking' : ''}"></span>
          <span>${this.over ? '本局结束' : this.thinking ? '星星正在思考……' : this.turn === HUMAN ? '轮到用户落子' : '轮到星星'}</span>
        </div>

        <div class="gomoku-board-wrap">
          <div class="gomoku-coordinates top">
            ${Array.from({length: SIZE}, (_, i) => `<span>${String.fromCharCode(65 + i)}</span>`).join('')}
          </div>
          <div class="gomoku-board-area">
            <div class="gomoku-coordinates side">
              ${Array.from({length: SIZE}, (_, i) => `<span>${SIZE - i}</span>`).join('')}
            </div>
            <div class="gomoku-board">${cells}</div>
          </div>
        </div>

        <div class="gomoku-message">
          <div class="gomoku-avatar">✦</div>
          <div class="gomoku-message-content">
            <strong>星星</strong>
            <p>${escapeHTML(this.message)}</p>
          </div>
        </div>

        <div class="gomoku-controls">
          <button id="gomoku-undo" ${!this.history.length || this.thinking ? 'disabled' : ''}>↶ 悔棋</button>
          <button id="gomoku-restart">↻ 再来一局</button>
        </div>

        <div class="gomoku-history">
          <strong>本局落子</strong>
          <div>${history || '<span>等待第一颗星星落下……</span>'}</div>
        </div>

        ${this.over ? `
          <div class="gomoku-result" style="${this.history[this.history.length-1]?.player === HUMAN ? 'box-shadow: 0 0 30px rgba(255, 158, 207, 0.5); border-color: #ff9ecf;' : ''}">
            <div style="${this.history[this.history.length-1]?.player === HUMAN ? 'animation: star-twinkle 1s infinite alternate;' : ''}">✦</div>
            <strong>${escapeHTML(this.message)}</strong>
            <button id="gomoku-again">再下一盘</button>
          </div>
        ` : ''}
      </section>
    `;

    this.container.querySelectorAll('.gomoku-cell').forEach(btn => {
      btn.addEventListener('click', () => this.handleCell(Number(btn.dataset.r), Number(btn.dataset.c)));
    });

    this.container.querySelector('#gomoku-undo')?.addEventListener('click', () => this.undo());
    this.container.querySelector('#gomoku-restart')?.addEventListener('click', () => this.restart());
    this.container.querySelector('#gomoku-again')?.addEventListener('click', () => this.restart());
    this.container.querySelector('#gomoku-exit')?.addEventListener('click', () => window.PlaygroundRouter.go('lobby'));

    const appearance = this.container.querySelector('#gomoku-appearance');
    appearance?.addEventListener('toggle', () => { this.appearanceOpen = appearance.open; });

    this.container.querySelectorAll('.gomoku-bg-input').forEach(input => {
      input.addEventListener('change', e => {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        this.handleBackgroundFile(input.dataset.kind, file);
      });
    });
    this.container.querySelector('#gomoku-reset-scene')?.addEventListener('click', () => this.resetBackground('scene'));
    this.container.querySelector('#gomoku-reset-board')?.addEventListener('click', () => this.resetBackground('board'));
  }
};