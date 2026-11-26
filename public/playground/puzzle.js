
// playground/puzzle.js
import { store } from './store.js';
import { gameEnd } from './game-end.js';
import { puzzleImage } from './puzzle-image.js';

/* 完成短句池：按实际步数分档，本地挑选，不调用 API —— 其他 Agent 新增逻辑，逐行保留 */
const END_LINES = {
  quick: [
    '这么快就拼好了。你比我想的还稳。',
    '这么快。散开的星星，还没来得及为难你。',
    '很快就拼完了。看来这点乱，难不住你。'
  ],
  normal: [
    '拼好了。散开的星光，还是回到你手里了。',
    '拼完了。中间那几步，我一直在看着。',
    '嗯，都归位了。这片夜空，认了你。'
  ],
  slow: [
    '总算拼完了。中间绕的那些路，也算数。',
    '慢是慢了点，不过你没有放手。',
    '拼好了。最后那几步，比开头稳多了。'
  ],
  again: [
    '又拼好一次。这片星空好像认得你了。',
    '第二次了。你好像越来越熟这片星光。',
    '又归位了。要不要试试更快一点？'
  ]
};

const DEFAULT_N = 3;
const DIFFICULTIES = [3, 4, 5];
const SHUFFLE_STEPS = { 3: 100, 4: 300, 5: 600 };

// 0 代表空格；完成态按难度动态生成
function makeSolved(n) {
  return Array.from({ length: n * n }, (_, i) => (i === n * n - 1 ? 0 : i + 1));
}

// 图片彻底加载失败时的兜底：本地生成深色渐变方图（0 网络请求）
function fallbackImage() {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 512, 512);
    g.addColorStop(0, '#3a2a63');
    g.addColorStop(1, '#151030');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 512, 512);
    return c.toDataURL('image/jpeg', 0.8);
  } catch (e) { return ''; }
}

export const PuzzleScene = {
  container: null,
  tiles: [],
  completed: false,
  moves: 0,            // 本局移动步数（只用于结算文案，不改变玩法）—— 保留
  serial: 0,           // 每局序号：结算消息去重 —— 保留
  endPublished: false,
  solvedBefore: false, // 之前是否已经拼完过（区分首次/重复完成）—— 保留

  n: DEFAULT_N,
  solved: makeSolved(DEFAULT_N),
  imageSrc: '',
  imageReady: false,
  previewEl: null,
  uploadHint: '',

  mount(el) {
    this.container = el;
    this.completed = false;
    this.serial += 1;
    this.endPublished = false;
    this.solvedBefore = !!(store.data.finished && store.data.finished.puzzle && store.data.finished.puzzle.completed);
    this.moves = 0;
    this.n = DEFAULT_N;
    this.solved = makeSolved(this.n);
    this.uploadHint = '';
    const saved = puzzleImage.getRecent();
    this.imageSrc = saved || puzzleImage.getDefault();
    this.prepareImage(() => {
      this.shuffle();
      this.render();
      this.showPreview(true);   // 开始前先展示完整原图
    });
  },

  // 预检图片可用性：失败回退默认图，再失败回退本地兜底图
  prepareImage(done) {
    const tryLoad = (src, onFail) => {
      puzzleImage.load(src).then(() => {
        this.imageSrc = src;
        this.imageReady = true;
        done();
      }).catch(onFail);
    };
    tryLoad(this.imageSrc, () => {
      tryLoad(puzzleImage.getDefault(), () => {
        this.imageSrc = fallbackImage();
        this.uploadHint = '图片加载失败，已使用备用图。';
        this.imageReady = true;
        done();
      });
    });
  },

  // 从完成状态开始，通过合法移动打乱，保证一定有解（对所有难度成立）
  shuffle() {
    this.tiles = [...this.solved];
    this.moves = 0;
    let previousEmpty = -1;
    const steps = SHUFFLE_STEPS[this.n] || 100;
    for (let i = 0; i < steps; i++) {
      const empty = this.tiles.indexOf(0);
      const neighbors = this.getNeighbors(empty).filter(index => index !== previousEmpty);
      const next = neighbors[Math.floor(Math.random() * neighbors.length)];
      this.swap(empty, next);
      previousEmpty = empty;
    }
    // 极少数情况下如果刚好恢复原样，再合法移动一步
    if (this.isSolved()) {
      const empty = this.tiles.indexOf(0);
      const neighbors = this.getNeighbors(empty);
      const next = neighbors[Math.floor(Math.random() * neighbors.length)];
      this.swap(empty, next);
    }
  },

  // 获取空格上下左右相邻的位置（按当前难度 n）
  getNeighbors(index) {
    const n = this.n;
    const row = Math.floor(index / n);
    const col = index % n;
    const result = [];
    if (row > 0) result.push(index - n);
    if (row < n - 1) result.push(index + n);
    if (col > 0) result.push(index - 1);
    if (col < n - 1) result.push(index + 1);
    return result;
  },

  swap(a, b) {
    [this.tiles[a], this.tiles[b]] = [this.tiles[b], this.tiles[a]];
  },

  isSolved() {
    return this.tiles.every((value, index) => value === this.solved[index]);
  },

  move(index) {
    if (this.completed) return;
    const empty = this.tiles.indexOf(0);
    if (!this.getNeighbors(empty).includes(index)) return;
    this.swap(index, empty);
    this.moves += 1;
    if (this.isSolved()) {
      this.completed = true;
      store.finish('puzzle', { completed: true, grid: this.n });
      this.renderResult();
      this.publishEnd();
      return;
    }
    this.render();
  },

  // 完成结算：只弹一次气泡，本地短句 0 次 API —— 其他 Agent 逻辑，逐行保留
  publishEnd() {
    if (this.endPublished) return;
    this.endPublished = true;
    const pool = this.solvedBefore
      ? END_LINES.again
      : this.moves <= 25
        ? END_LINES.quick
        : this.moves <= 45
          ? END_LINES.normal
          : END_LINES.slow;
    const line = gameEnd.pickLine(pool);
    this.solvedBefore = true;
    gameEnd.show({
      game: 'puzzle',
      gameName: '星光拼图',
      token: `puzzle:${this.serial}`,
      line,
      result: `用了 ${this.moves} 步拼完`,
      english: ''
    });
  },

  // 图片块背景定位：块 value 对应原图中第 (value-1) 格，行列按难度 n
  tileStyle(value) {
    if (value === 0) {
      return 'background:rgba(10,10,30,.4);border:1px solid rgba(200,160,255,.08);box-shadow:none;cursor:default;';
    }
    const n = this.n;
    const idx = value - 1;
    const row = Math.floor(idx / n);
    const col = idx % n;
    const px = n > 1 ? (col / (n - 1)) * 100 : 0;
    const py = n > 1 ? (row / (n - 1)) * 100 : 0;
    // 用单引号包裹 url：外层 style 属性是双引号，若这里也用双引号会提前闭合属性导致背景失效
    return `background-image:url('${this.imageSrc}');` +
      `background-size:${n * 100}% ${n * 100}%;` +
      `background-position:${px}% ${py}%;` +
      'background-repeat:no-repeat;border:1px solid rgba(200,160,255,.35);' +
      'box-shadow:inset 0 0 8px rgba(0,0,0,.25),0 2px 10px rgba(0,0,0,.25);cursor:pointer;';
  },

  difficultyBar() {
    return '<div style="display:flex;gap:8px;justify-content:center;margin:0 0 16px;">' +
      DIFFICULTIES.map(d =>
        `<button data-diff="${d}" style="padding:8px 16px;border-radius:20px;` +
        `background:${d === this.n ? 'rgba(200,160,255,.32)' : 'rgba(200,160,255,.08)'};` +
        `border:1px solid rgba(200,160,255,${d === this.n ? '.65' : '.25'});` +
        `color:#e8d5ff;cursor:pointer;font-size:13px;">${d}×${d}</button>`
      ).join('') + '</div>';
  },

  render() {
    if (!this.container || !this.imageReady) return;
    const n = this.n;
    this.container.innerHTML = `
      <div style="max-width:560px;margin:35px auto;padding:24px;
                  background:rgba(30,25,55,.85);border:1px solid rgba(200,160,255,.25);
                  border-radius:20px;box-shadow:0 8px 32px rgba(0,0,0,.3);text-align:center;">
        <div style="font-size:36px;margin-bottom:10px;">✧</div>
        <h2 style="color:#e8d5ff;letter-spacing:2px;margin-bottom:10px;">星光拼图</h2>
        <p style="color:#b8a5db;font-size:13px;line-height:1.8;margin-bottom:16px;">
          星星把这张图打散了。<br/>把散落的画面重新拼在一起吧。
        </p>
        ${this.difficultyBar()}
        <div style="display:grid;grid-template-columns:repeat(${n},1fr);gap:6px;width:100%;
                    max-width:360px;margin:0 auto 18px;touch-action:manipulation;">
          ${this.tiles.map((value, index) => `
            <button class="puzzle-tile" data-index="${index}" ${value === 0 ? 'disabled' : ''}
              style="aspect-ratio:1;border-radius:10px;padding:0;${this.tileStyle(value)}"></button>
          `).join('')}
        </div>
        <p style="color:#a994c9;font-size:12px;margin-bottom:8px;">
          点击空格旁边的图块即可移动 · 已走 ${this.moves} 步
        </p>
        ${this.uploadHint ? `<p style="color:#e7a9a9;font-size:12px;margin-bottom:8px;">${this.uploadHint}</p>` : ''}
        <div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:6px;">
          <button id="puzzle-preview" style="padding:9px 18px;border-radius:22px;background:rgba(200,160,255,.12);
                  border:1px solid rgba(200,160,255,.35);color:#e8d5ff;cursor:pointer;font-size:13px;">查看原图</button>
          <button id="puzzle-upload" style="padding:9px 18px;border-radius:22px;background:rgba(200,160,255,.12);
                  border:1px solid rgba(200,160,255,.35);color:#e8d5ff;cursor:pointer;font-size:13px;">上传图片</button>
          <button id="puzzle-shuffle" style="padding:9px 18px;border-radius:22px;background:rgba(200,160,255,.15);
                  border:1px solid rgba(200,160,255,.4);color:#e8d5ff;cursor:pointer;font-size:13px;">重新打乱</button>
          <button id="puzzle-back" style="padding:9px 18px;border-radius:22px;background:transparent;
                  border:1px solid rgba(200,160,255,.25);color:#b8a5db;cursor:pointer;font-size:13px;">返回大厅</button>
        </div>
      </div>`;

    this.container.querySelectorAll('.puzzle-tile').forEach(btn => {
      if (btn.disabled) return;
      btn.addEventListener('click', () => this.move(Number(btn.dataset.index)));
    });
    this.container.querySelectorAll('[data-diff]').forEach(btn => {
      btn.addEventListener('click', () => this.setDifficulty(Number(btn.dataset.diff)));
    });
    this.container.querySelector('#puzzle-preview').addEventListener('click', () => this.showPreview(false));
    this.container.querySelector('#puzzle-upload').addEventListener('click', () => this.startUpload());
    this.container.querySelector('#puzzle-shuffle').addEventListener('click', () => this.reShuffle());
    this.container.querySelector('#puzzle-back').addEventListener('click', () => window.PlaygroundRouter.go('lobby'));
  },

  // 切换难度：保留当前图片，只重建棋盘并重新打乱
  setDifficulty(n) {
    if (DIFFICULTIES.indexOf(n) === -1 || n === this.n) return;
    this.n = n;
    this.solved = makeSolved(n);
    this.completed = false;
    this.serial += 1;
    this.endPublished = false;
    gameEnd.dismiss();
    this.shuffle();
    this.render();
  },

  reShuffle() {
    this.completed = false;
    this.serial += 1;
    this.endPublished = false;
    gameEnd.dismiss();
    this.shuffle();
    this.render();
  },

  // 上传：本地裁切确认后应用；保存失败仍可用于本会话
  startUpload() {
    puzzleImage.openUpload(
      (dataUrl) => {
        this.imageSrc = dataUrl;
        puzzleImage.saveRecent(dataUrl);
        this.uploadHint = '';
        this.completed = false;
        this.serial += 1;
        this.endPublished = false;
        gameEnd.dismiss();
        this.shuffle();
        this.render();
        this.showPreview(true);
      },
      (msg) => {
        this.uploadHint = msg || '图片处理失败，已保留原图。';
        this.render();
      }
    );
  },

  // 原图预览：纯 UI 遮罩，不触碰 tiles / moves / completed / 难度
  showPreview(isStart) {
    this.closePreview();
    const overlay = document.createElement('div');
    overlay.setAttribute('data-puzzle-overlay', 'preview');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9997;background:rgba(8,6,22,.88);' +
      'display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;';
    overlay.innerHTML = `
      <div style="max-width:520px;width:100%;background:rgba(30,25,55,.96);border:1px solid rgba(200,160,255,.35);
                  border-radius:20px;padding:22px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.45);">
        <h3 style="color:#e8d5ff;letter-spacing:2px;margin:0 0 6px;">完整的星空</h3>
        <p style="color:#b8a5db;font-size:12px;margin:0 0 14px;">这是要拼成的原图。看清楚，再动手。</p>
        <img src="${this.imageSrc}" alt="原图" style="width:min(78vw,360px);height:min(78vw,360px);
             object-fit:cover;border-radius:14px;border:1px solid rgba(200,160,255,.4);display:block;margin:0 auto 16px;" />
        <button data-act="close" style="padding:10px 30px;border-radius:24px;background:rgba(200,160,255,.2);
                border:1px solid rgba(200,160,255,.5);color:#e8d5ff;cursor:pointer;">${isStart ? '开始拼图' : '收起原图'}</button>
      </div>`;
    overlay.querySelector('[data-act="close"]').addEventListener('click', () => this.closePreview());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) this.closePreview(); });
    document.body.appendChild(overlay);
    this.previewEl = overlay;
  },

  closePreview() {
    try { if (this.previewEl && this.previewEl.parentNode) this.previewEl.parentNode.removeChild(this.previewEl); } catch (e) {}
    this.previewEl = null;
  },

  renderResult() {
    if (!this.container) return;
    this.closePreview();
    this.container.innerHTML = `
      <div style="max-width:560px;margin:45px auto;padding:45px 22px;
                  background:rgba(30,25,55,.88);border:1px solid rgba(200,160,255,.35);
                  border-radius:20px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.3);">
        <div style="font-size:58px;margin-bottom:18px;filter:drop-shadow(0 0 15px rgba(200,160,255,.7));">🌌</div>
        <h2 style="color:#e8d5ff;margin-bottom:14px;letter-spacing:2px;">星光重新汇聚了</h2>
        <p style="color:#cbb8e8;font-size:14px;line-height:1.9;margin-bottom:22px;">
          你把散落的画面重新拼在了一起。<br/>
          原来无论散落在哪里，<br/>
          最后都会因为你，再次相遇。
        </p>
        <button id="puzzle-result-back" style="padding:12px 35px;border-radius:25px;background:rgba(200,160,255,.2);
                border:1px solid rgba(200,160,255,.5);color:#e8d5ff;cursor:pointer;">返回大厅</button>
      </div>`;
    this.container.querySelector('#puzzle-result-back').addEventListener('click', () => window.PlaygroundRouter.go('lobby'));
  },

  unmount() {
    this.closePreview();
    if (this.container) {
      this.container.innerHTML = '';
      this.container = null;
    }
    this.tiles = [];
    this.completed = false;
  }
};
