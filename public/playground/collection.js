// playground/collection.js
// 大厅「珍藏」入口：只做展示与确认，数据来自房间共同珍藏（同一份 IndexedDB）
import {
  listKeeps, updateKeep, keepText, keepStatus, createdAtOf,
  KEEP_STATUS_LABELS, formatKeepDate
} from '../shared/room-keeps.js';

function escapeHTML(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

export const CollectionScene = {
  container: null,
  records: [],
  loading: true,
  error: '',
  acting: false,

  mount(el) {
    this.container = el;
    this.records = [];
    this.loading = true;
    this.error = '';
    this.acting = false;
    this.render();
    this.load();
  },

  async load() {
    try {
      const rows = await listKeeps();
      if (!this.container) return;
      this.records = rows;
      this.error = '';
    } catch (e) {
      if (!this.container) return;
      this.records = [];
      this.error = '读取珍藏失败：' + (e && e.message ? e.message : '未知错误');
    }
    this.loading = false;
    this.render();
  },

  async confirmKeep(id) {
    if (this.acting) return;
    this.acting = true;
    try {
      await updateKeep(id, { status: 'saved', confirmedAt: Date.now() });
      await this.load();
      this.flash('这段回忆已经收进共同珍藏。');
    } catch (e) {
      this.flash('确认失败，请稍后再试。');
    } finally {
      this.acting = false;
    }
  },

  async rejectKeep(id) {
    if (this.acting) return;
    this.acting = true;
    try {
      await updateKeep(id, { status: 'rejected_by_user', rejectedAt: Date.now() });
      await this.load();
      this.flash('这次先不收录。');
    } catch (e) {
      this.flash('操作失败，请稍后再试。');
    } finally {
      this.acting = false;
    }
  },

  flash(text) {
    const el = this.container && this.container.querySelector('#keep-flash');
    if (!el) return;
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => el.classList.remove('show'), 2600);
  },

  card(record) {
    const status = keepStatus(record);
    const label = KEEP_STATUS_LABELS[status] || '旧珍藏';
    const badgeClass = KEEP_STATUS_LABELS[status] ? status : 'saved';
    const title = escapeHTML(record.title || '共同珍藏');
    const text = escapeHTML(keepText(record));
    const date = formatKeepDate(createdAtOf(record));
    const by = record.by ? escapeHTML(record.by) : '';
    const pending = status === 'waiting_user';
    const dim = status === 'rejected' || status === 'rejected_by_user';

    return `
      <article class="keep-card${dim ? ' dim' : ''}">
        <div class="keep-head">
          <h3>${title}</h3>
          <span class="keep-badge ${badgeClass}">${label}</span>
        </div>
        ${text ? `<p class="keep-text">${text}</p>` : ''}
        ${record.response ? `<p class="keep-reply">星星：${escapeHTML(record.response)}</p>` : ''}
        <div class="keep-foot">
          <span>${by ? by + ' · ' : ''}${date}</span>
          ${pending ? `
            <span class="keep-actions">
              <button class="keep-btn primary" data-keep-confirm="${record.id}">确认珍藏</button>
              <button class="keep-btn" data-keep-reject="${record.id}">暂不收录</button>
            </span>` : ''}
        </div>
      </article>
    `;
  },

  render() {
    if (!this.container) return;

    const savedCount = this.records.filter(r => {
      const s = keepStatus(r);
      return s === 'saved';
    }).length;
    const pendingCount = this.records.filter(r => keepStatus(r) === 'waiting_user').length;
    const body = this.loading
      ? '<div class="keep-empty">正在翻开珍藏…</div>'
      : this.error
        ? `<div class="keep-empty">${escapeHTML(this.error)}</div>`
        : this.records.length
          ? this.records.map(item => this.card(item)).join('')
          : `<div class="keep-empty">
               <div class="keep-empty-icon">🌠</div>
               这里还空空的。<br>
               回到房间，或者在游乐场里和星星一起留下点什么。
             </div>`;

    this.container.innerHTML = `
      <style>${STYLES}</style>
      <div class="keep-wrap">
        <div class="keep-icon">📖</div>
        <h2 class="keep-title">共同珍藏</h2>
        <p class="keep-sub">
          这里和房间里的「共同珍藏」是同一份记录。<br>
          你们收下的每一个瞬间，都会同时出现在两边。
        </p>
        <div class="keep-stats">✦ 已收录 ${savedCount} 件${pendingCount ? ` · 待确认 ${pendingCount} 件` : ''} ✦</div>
        <div class="keep-list">${body}</div>
        <p class="keep-quote">「有些瞬间不会消失，<br>它们只是变成了星星，留在了这里。」</p>
        <button id="collection-back" class="keep-back">返回大厅</button>
        <div id="keep-flash" class="keep-flash"></div>
      </div>
    `;

    const back = this.container.querySelector('#collection-back');
    if (back) back.addEventListener('click', () => window.PlaygroundRouter.go('lobby'));

    this.container.querySelectorAll('[data-keep-confirm]').forEach(btn => {
      btn.addEventListener('click', () => this.confirmKeep(btn.getAttribute('data-keep-confirm')));
    });
    this.container.querySelectorAll('[data-keep-reject]').forEach(btn => {
      btn.addEventListener('click', () => this.rejectKeep(btn.getAttribute('data-keep-reject')));
    });
  },

  unmount() {
    clearTimeout(this._flashTimer);
    if (this.container) {
      this.container.innerHTML = '';
      this.container = null;
    }
  }
};

const STYLES = `
  .keep-wrap {
    max-width: 700px; margin: 35px auto; padding: 0 16px 30px; text-align: center;
  }
  .keep-icon {
    font-size: 38px; margin-bottom: 10px;
    filter: drop-shadow(0 0 15px rgba(200,160,255,.5));
  }
  .keep-title { color: #4a3a6b; letter-spacing: 3px; margin: 0 0 10px; }
  .keep-sub {
    color: #6a5a8a; font-size: 13px; line-height: 1.8; margin: 0 0 22px;
  }
  .keep-stats {
    display: flex; justify-content: center; align-items: center; gap: 8px;
    margin-bottom: 22px; color: #7a5a9a; font-size: 13px;
  }
  .keep-list { display: flex; flex-direction: column; gap: 14px; text-align: left; }
  .keep-card {
    padding: 18px 20px; border-radius: 16px;
    background: linear-gradient(135deg, rgba(255,255,255,.92), rgba(246,240,255,.9));
    border: 1px solid rgba(168,156,214,.35);
    box-shadow: 0 6px 22px rgba(120,100,160,.12);
  }
  .keep-card.dim { opacity: .62; }
  .keep-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .keep-head h3 {
    flex: 1; margin: 0; color: #4a3a6b; font-size: 16px; letter-spacing: 1px;
  }
  .keep-badge {
    flex: none; font-size: 11px; padding: 3px 9px; border-radius: 20px;
    background: rgba(168,156,214,.16); color: #6f5a96;
  }
  .keep-badge.saved { background: rgba(146,196,255,.22); color: #3f6ea8; }
  .keep-badge.waiting_user { background: rgba(255,204,150,.3); color: #9a6a2f; }
  .keep-text { margin: 0 0 8px; color: #5a5470; font-size: 13px; line-height: 1.9; }
  .keep-reply { margin: 0 0 8px; color: #8a6ab0; font-size: 12px; line-height: 1.8; }
  .keep-foot {
    display: flex; align-items: center; justify-content: space-between;
    gap: 10px; color: #9a8ab8; font-size: 11px;
  }
  .keep-actions { display: flex; gap: 8px; }
  .keep-btn {
    padding: 6px 14px; border-radius: 18px; cursor: pointer; font-size: 12px;
    background: rgba(120,100,160,.1); border: 1px solid rgba(120,100,160,.35);
    color: #5a4a7a;
  }
  .keep-btn.primary {
    background: rgba(168,132,230,.22); border-color: rgba(168,132,230,.55);
    color: #4a2f7a; font-weight: 600;
  }
  .keep-empty {
    padding: 40px 20px; border-radius: 16px; text-align: center;
    border: 1px dashed rgba(120,100,160,.3); color: #7a6a9a; line-height: 2;
    background: rgba(255,255,255,.55);
  }
  .keep-empty-icon { font-size: 35px; margin-bottom: 12px; }
  .keep-quote {
    color: rgba(90,70,120,.7); font-size: 12px; line-height: 1.8; margin: 25px 0;
  }
  .keep-back {
    padding: 11px 32px; border-radius: 25px; cursor: pointer; font-size: 14px;
    background: rgba(120,100,160,.12); border: 1px solid rgba(120,100,160,.4);
    color: #5a4a7a;
  }
  .keep-flash {
    margin-top: 14px; font-size: 12px; color: #6f5a96; opacity: 0;
    transition: opacity .25s;
  }
  .keep-flash.show { opacity: 1; }
`;
