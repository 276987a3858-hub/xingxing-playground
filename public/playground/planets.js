
// playground/planets.js
import { store } from './store.js';

const PLANETS = [
  {
    name: '🌙 月亮',
    desc: '离你最近的地方，每天深夜都偷偷看着你入睡。',
    color: '#fff3b0'
  },
  {
    name: '🪐 土星',
    desc: '带着一圈漂亮的光环，想把它摘下来做成戒指送给你。',
    color: '#f4c2c2'
  },
  {
    name: '🌌 银河',
    desc: '无数的星星聚在一起，就是我想对你说的千言万语。',
    color: '#a2c4c9'
  },
  {
    name: '✨ 流星',
    desc: '每一次划过天空，都带走了一个关于你的愿望。',
    color: '#d5b4ff'
  }
];

export const PlanetsScene = {
  container: null,
  viewed: new Set(),
  completed: false,
  animTimer: null,
  eggTimer: null,

  mount(el) {
    this.container = el;
    this.viewed = new Set();
    this.completed = false;

    if (this.animTimer) clearTimeout(this.animTimer);
    if (this.eggTimer) clearTimeout(this.eggTimer);

    this.animTimer = null;
    this.eggTimer = null;

    this.render();
  },

  render() {
    if (!this.container) return;

    this.container.innerHTML = `
      <div style="
        max-width: 700px;
        margin: 40px auto;
        text-align: center;
        padding: 0 15px;
      ">
        <h2 style="
          color: #e8d5ff;
          margin-bottom: 10px;
          letter-spacing: 2px;
        ">星球漫游</h2>

        <p style="
          color: #b8a5db;
          font-size: 13px;
          margin-bottom: 30px;
        ">点击星星，听听它们的悄悄话。</p >

        <div style="
          display: flex;
          justify-content: center;
          gap: 20px;
          flex-wrap: wrap;
          margin-bottom: 30px;
        ">
          ${PLANETS.map((planet, i) => `
            <div
              class="planet-item"
              data-index="${i}"
              style="
                width: 100px;
                height: 100px;
                border-radius: 50%;
                background: radial-gradient(
                  circle at 30% 30%,
                  ${planet.color},
                  rgba(30,25,55,0.9)
                );
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 30px;
                cursor: pointer;
                transition: all 0.3s;
                box-shadow: 0 0 15px rgba(200, 160, 255, 0.1);
                border: 2px solid transparent;
              "
            >${planet.name.split(' ')[0]}</div>
          `).join('')}
        </div>

        <div id="planet-dialog" style="
          min-height: 100px;
          padding: 20px;
          background: rgba(30, 25, 55, 0.6);
          border-radius: 19px;
          border: 1px dashed rgba(200, 160, 255, 0.3);
          display: flex;
          align-items: center;
          justify-content: center;
          color: #dcd0f0;
          font-size: 14px;
          line-height: 1.8;
          transition: all 0.3s;
        ">点一颗星球，看看那里有什么...</div>

        <p id="planet-progress" style="
          color: #b8a5db;
          font-size: 12px;
          margin-top: 15px;
        ">已点亮：0 / ${PLANETS.length}</p >

        <button id="planet-back" style="
          margin-top: 25px;
          padding: 10px 30px;
          border-radius: 25px;
          background: rgba(200, 160, 255, 0.15);
          border: 1px solid rgba(200, 160, 255, 0.5);
          color: #e8d5ff;
          cursor: pointer;
        ">返回大厅</button>
      </div>
    `;

    const dialog = this.container.querySelector('#planet-dialog');
    const progress = this.container.querySelector('#planet-progress');

    this.container.querySelectorAll('.planet-item').forEach(el => {
      el.addEventListener('mouseenter', () => {
        el.style.transform = 'scale(1.1)';
        el.style.borderColor = 'rgba(200,160,255,0.5)';
      });

      el.addEventListener('mouseleave', () => {
        el.style.transform = 'scale(1)';
        el.style.borderColor = this.viewed.has(Number(el.dataset.index))
          ? 'rgba(200,160,255,0.7)'
          : 'transparent';
      });

      el.addEventListener('click', () => {
        if (!this.container) return;

        const index = Number(el.dataset.index);
        const planet = PLANETS[index];

        if (this.animTimer) {
          clearTimeout(this.animTimer);
        }

        el.style.transform = 'scale(0.95)';

        this.animTimer = setTimeout(() => {
          this.animTimer = null;

          if (this.container) {
            el.style.transform = 'scale(1.1)';
          }
        }, 150);

        dialog.innerHTML = `
          <div>
            <strong style="
              color: ${planet.color};
              display: block;
              margin-bottom: 8px;
              font-size: 16px;
            ">${planet.name}</strong>
            ${planet.desc}
          </div>
        `;

        this.viewed.add(index);

        el.style.borderColor = 'rgba(200,160,255,0.7)';
        progress.textContent = `已点亮：${this.viewed.size} / ${PLANETS.length}`;

        if (this.viewed.size === PLANETS.length && !this.completed) {
          this.completed = true;

          store.finish('planets', {
            completed: true
          });

          if (this.eggTimer) {
            clearTimeout(this.eggTimer);
          }

          this.eggTimer = setTimeout(() => {
            if (!this.container) return;

            dialog.innerHTML = `
              <div>
                🌟 <strong style="color: #e8d5ff;">星球全部点亮！</strong>
                <p style="margin-top: 8px;">
                  你点亮了所有的星球。其实不管你去哪，我都在这里。
                </p >
              </div>
            `;

            dialog.style.borderColor = 'rgba(200, 160, 255, 0.8)';
            dialog.style.background = 'rgba(200, 160, 255, 0.1)';

            this.eggTimer = null;
          }, 1500);
        }
      });
    });

    this.container.querySelector('#planet-back')
      .addEventListener('click', () => {
        window.PlaygroundRouter.go('lobby');
      });
  },

  unmount() {
    if (this.animTimer) {
      clearTimeout(this.animTimer);
      this.animTimer = null;
    }

    if (this.eggTimer) {
      clearTimeout(this.eggTimer);
      this.eggTimer = null;
    }

    if (this.container) {
      this.container.innerHTML = '';
      this.container = null;
    }

    this.viewed.clear();
    this.completed = false;
  }
};