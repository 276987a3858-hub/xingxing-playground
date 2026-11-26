/* public/shared/self-narrative-view.js — 机自述浏览页（只读）
 * ------------------------------------------------------------------
 * 给用户自己看的「机自述」栏目：小星眼中的她。
 * 只做展示，不做管理：
 *   - 只读正式记录 selfNarrative.v1 里 status==='active' 的条目；
 *   - 不读 Dry-run 草稿（ylxh.snDryRun.v1），不读 localStorage，不读水位；
 *   - 不新增 / 修改 / 撤回 / 采纳任何记录，不创建或推进 selfNarrative.watermark；
 *   - 不调用 AI，不产生任何网络请求。
 *
 * 展示原则：
 *   - 保留第一人称与主观情绪原文，不改写成客观档案；
 *   - 把「看到的」和「他猜的」分开写，推断不冒充事实；
 *   - 没有记录就显示自然的空状态，不伪造内容。
 *
 * 暴露 window.SelfNarrativeView / globalThis.SelfNarrativeView。
 */
(function (root) {
  'use strict';

  var SN = root.SelfNarrative;
  var doc = root.document || null;

  var LIST_ID = 'snViewList';
  var FILTER_ID = 'snvFilters';
  var STYLE_ID = 'snv-style';

  var CONFIDENCE_LABELS = { low: '还不太确定', medium: '有点把握', high: '比较确定' };
  // SelfNarrative 未导出 BASIS_LABELS，这里按同一口径本地维护，避免依赖内部结构。
  var BASIS_LABELS = { stated: '她说过', observed: '看到的表现', inferred: '他的推测' };

  var FILTERS = [
    { key: 'all', label: '全部' },
    { key: 'observation', label: '看到的样子' },
    { key: 'impression', label: '留下的印象' },
    { key: 'inference', label: '他的理解' },
    { key: 'question', label: '还没弄明白' }
  ];

  var currentFilter = 'all';
  var lastRecords = [];
  var lastModel = null;

  /* ---------------- 纯函数：视图模型 ---------------- */

  function isObj(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
  function str(v) { return String(v == null ? '' : v).trim(); }

  function clip(s, n) {
    var v = str(s).replace(/\s+/g, ' ');
    if (!v) return '';
    return v.length > n ? v.slice(0, n) + '…' : v;
  }

  function kindLabel(kind) {
    if (SN && SN.KIND_LABELS && SN.KIND_LABELS[kind]) return SN.KIND_LABELS[kind];
    for (var i = 0; i < FILTERS.length; i++) if (FILTERS[i].key === kind) return FILTERS[i].label;
    return str(kind) || '记录';
  }

  function basisLabel(basis) {
    return BASIS_LABELS[basis] || str(basis);
  }

  function confidenceLabel(c) {
    return CONFIDENCE_LABELS[c] || '没说清';
  }

  // 标题只用记录自己的 topic；没有 topic 就退到正文开头，不额外编造名字。
  function titleOf(rec) {
    var t = str(rec && rec.topic);
    if (t) return t;
    var s = clip(rec && rec.text, 22);
    return s || '一条还没起名字的记录';
  }

  function summaryOf(rec) {
    return clip(rec && rec.text, 88);
  }

  function evidenceOf(rec) {
    var arr = rec && Array.isArray(rec.evidence) ? rec.evidence : [];
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      if (!isObj(arr[i])) continue;
      var quote = str(arr[i].quote);
      var mid = str(arr[i].messageId);
      if (!quote) continue;               // 没有原文片段的引用不展示，避免空壳证据
      out.push({ messageId: mid, quote: quote });
    }
    return out;
  }

  function toItem(rec) {
    var observed = str(rec.observed);
    var inferred = str(rec.inferred);
    var question = str(rec.question);
    var evidence = evidenceOf(rec);
    return {
      id: str(rec.id),
      title: titleOf(rec),
      topic: str(rec.topic),
      summary: summaryOf(rec),
      kind: str(rec.kind),
      kindLabel: kindLabel(rec.kind),
      basis: rec.basis == null ? null : str(rec.basis),
      basisLabel: basisLabel(rec.basis),
      confidence: str(rec.confidence),
      confidenceLabel: confidenceLabel(rec.confidence),
      text: str(rec.text),
      observed: observed,
      inferred: inferred,
      question: question,
      evidence: evidence,
      createdAt: typeof rec.createdAt === 'number' ? rec.createdAt : null,
      // 修订前快照（同步可得）：只取展示所需字段，保留旧版正文 / 证据 / 时间。
      history: (Array.isArray(rec.history) ? rec.history : []).map(function (h) {
        return {
          at: typeof h.at === 'number' ? h.at : null,
          text: str(h.text),
          observed: str(h.observed),
          inferred: str(h.inferred),
          question: str(h.question),
          basis: h.basis == null ? null : str(h.basis),
          evidence: Array.isArray(h.evidence) ? h.evidence.map(function (e) {
            return { messageId: e && e.messageId != null ? str(e.messageId) : '', quote: str(e && e.quote) };
          }) : []
        };
      }),
      revisedFrom: rec.revisedFrom == null ? null : str(rec.revisedFrom),
      status: str(rec.status),
      hasDetail: !!(observed || inferred || question || evidence.length)
    };
  }

  /**
   * buildView(records, { filter }) → 视图模型
   * 只接受 status==='active'；排序沿用数据层（updatedAt 倒序）。
   */
  function buildView(records, opts) {
    var o = isObj(opts) ? opts : {};
    var filter = str(o.filter) || 'all';
    var known = false;
    for (var i = 0; i < FILTERS.length; i++) if (FILTERS[i].key === filter) known = true;
    if (!known) filter = 'all';

    var rows = [];
    var src = Array.isArray(records) ? records : [];
    for (var j = 0; j < src.length; j++) {
      var r = src[j];
      if (isObj(r) && r.status === 'active') rows.push(r);
    }

    var counts = { all: rows.length };
    rows.forEach(function (r) {
      var k = str(r.kind);
      if (!k) return;
      counts[k] = (counts[k] || 0) + 1;
    });

    var shown = filter === 'all' ? rows : rows.filter(function (r) { return r.kind === filter; });
    return {
      ok: true,
      filter: filter,
      total: rows.length,
      shown: shown.length,
      counts: counts,
      items: shown.map(toItem),
      emptyReason: rows.length ? (shown.length ? '' : 'no-match') : 'no-records'
    };
  }

  /* ---------------- 只读 store ---------------- */

  // 只给数据层 get；set 直接拒绝，从结构上保证这个页面写不了任何东西。
  function readOnlyStore(getFn) {
    var get = typeof getFn === 'function' ? getFn : function (k) {
      if (typeof root.kvGet === 'function') return root.kvGet(k);
      return Promise.reject(new Error('kvGet 不可用'));
    };
    return {
      get: function (k) { return get(k); },
      set: function () { return Promise.reject(new Error('self-narrative-view is read-only')); }
    };
  }

  /* ---------------- 样式（只注入一次） ---------------- */

  var CSS = [
    '.snv-intro p{margin:0;font-size:12.5px;line-height:1.9;color:#5B3F6B}',
    '.snv-intro p+p{margin-top:6px;color:#7b6a87}',
    '.snv-filters{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 14px}',
    '.snv-filter{border:1px solid rgba(91,63,107,.15);background:rgba(255,255,255,.7);color:#5B3F6B;border-radius:99px;padding:6px 12px;font-size:12px;transition:background .2s,color .2s,opacity .2s}',
    '.snv-filter.active{background:linear-gradient(135deg,#b5a4c9,#9b8ba3);color:#fff;border-color:transparent}',
    '.snv-filter:disabled{opacity:.4;cursor:default}',
    '.snv-list{display:flex;flex-direction:column;gap:10px}',
    '.snv-card{border:1px solid rgba(91,63,107,.15);border-radius:16px;background:rgba(255,255,255,.62);overflow:hidden;transition:border-color .2s,box-shadow .2s,background .2s}',
    '.snv-card.open{border-color:rgba(155,139,163,.55);background:rgba(255,255,255,.82);box-shadow:0 8px 24px rgba(91,63,107,.08)}',
    '.snv-head{display:grid;grid-template-columns:1fr auto;align-items:start;gap:5px 10px;width:100%;padding:13px 14px;border:0;background:none;text-align:left;cursor:pointer;color:inherit}',
    '.snv-pills{grid-column:1 / -1;display:flex;flex-wrap:wrap;gap:6px;align-items:center}',
    '.snv-pill{font-size:10.5px;line-height:1.6;padding:2px 8px;border-radius:99px;border:1px solid rgba(91,63,107,.18);color:#6b5578;background:rgba(255,255,255,.7);white-space:nowrap}',
    '.snv-pill.kind{background:rgba(255,214,231,.5);border-color:rgba(214,160,190,.5);color:#7a4d68}',
    '.snv-pill.conf{background:rgba(199,222,255,.45);border-color:rgba(150,180,225,.5);color:#3f5b86}',
    '.snv-date{margin-left:auto;font-size:10.5px;color:#9b8ba3}',
    '.snv-title{grid-column:1;font-size:14px;font-weight:600;color:#4a3858;line-height:1.5}',
    '.snv-summary{grid-column:1;font-size:12px;color:#7b6a87;line-height:1.65;margin-top:1px}',
    '.snv-chev{grid-column:2;grid-row:2 / 4;align-self:center;color:#b0a2b8;font-size:15px;transition:transform .2s}',
    '.snv-card.open .snv-chev{transform:rotate(90deg)}',
    '.snv-card.open .snv-summary{display:none}',
    '.snv-hist-item{border-left:2px solid #c9b6d6;padding:4px 0 4px 9px;margin:6px 0}',
    '.snv-hist-item p{margin:2px 0;font-size:12px;color:#6b5779}',
    '.snv-detail{padding:0 14px 14px;border-top:1px dashed rgba(91,63,107,.15)}',
    '.snv-full{font-size:13.5px;line-height:1.9;color:#4a3858;white-space:pre-wrap;margin:12px 0 0}',
    '.snv-block{margin-top:10px;padding:9px 12px;border-radius:12px;background:rgba(255,255,255,.68);border:1px solid rgba(91,63,107,.12)}',
    '.snv-block b{display:block;font-size:11.5px;font-weight:600;letter-spacing:.4px;margin-bottom:4px}',
    '.snv-block p{margin:0;font-size:12.5px;line-height:1.8;color:#5B3F6B;white-space:pre-wrap}',
    '.snv-block.observed b{color:#3f5b86}',
    '.snv-block.inferred b{color:#7a4d68}',
    '.snv-block.question{border-style:dashed}',
    '.snv-block.question b{color:#8a6d2f}',
    '.snv-meta{margin-top:10px;font-size:11.5px;color:#7b6a87;line-height:1.8}',
    '.snv-ev{margin-top:12px}',
    '.snv-ev>b{display:block;font-size:11.5px;font-weight:600;color:#5B3F6B;margin-bottom:6px}',
    '.snv-ev-item{font-size:12px;color:#5B3F6B;background:rgba(255,255,255,.72);border-left:3px solid rgba(155,139,163,.5);border-radius:8px;padding:7px 9px;margin-top:6px;line-height:1.75;white-space:pre-wrap}',
    '.snv-ev-item .mid{display:block;color:#9b8ba3;font-size:10.5px;margin-bottom:2px}',
    '.snv-empty{text-align:center;color:#7b6a87;font-size:12.5px;line-height:1.9;padding:26px 10px}',
    '.snv-empty button{margin-top:14px}',
    '.snv-foot{margin:0 4px 26px;line-height:1.85}',
    '.tile-wide{grid-column:1 / -1;min-height:auto;display:flex;align-items:center;gap:13px;text-align:left}',
    '.tile-wide .ico{margin:0;font-size:23px}',
    '.tile-wide-text{display:block;min-width:0;flex:1 1 auto}',
    '.tile-wide-text b{display:block;font-size:15px;font-weight:500}',
    '.tile-wide-text small{display:block;margin-top:3px;color:var(--muted);font-size:11px;line-height:1.6}',
    '.tile-wide .snv-tile-arrow{margin-left:auto;color:#b9a8c6;font-size:17px;flex:none}'
  ].join('\n');

  function ensureStyle() {
    if (!doc || doc.getElementById(STYLE_ID)) return;
    var style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(style);
  }

  /* ---------------- DOM 渲染 ---------------- */

  function el(tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function fmtDate(t) {
    if (typeof t !== 'number' || !isFinite(t)) return '';
    var d = new Date(t);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function detailBlock(cls, label, text) {
    var box = el('div', 'snv-block ' + cls);
    box.appendChild(el('b', '', label));
    box.appendChild(el('p', '', text));
    return box;
  }

  function cardOf(item) {
    var card = el('article', 'snv-card');
    card.setAttribute('data-id', item.id);

    var head = el('button', 'snv-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', 'false');

    var pills = el('span', 'snv-pills');
    pills.appendChild(el('span', 'snv-pill kind', item.kindLabel));
    pills.appendChild(el('span', 'snv-pill conf', item.confidenceLabel));
    var date = fmtDate(item.createdAt);
    if (date) pills.appendChild(el('span', 'snv-date', date));
    head.appendChild(pills);

    head.appendChild(el('span', 'snv-title', item.title));
    head.appendChild(el('span', 'snv-summary', item.summary));
    head.appendChild(el('span', 'snv-chev', '›'));
    card.appendChild(head);

    var detail = el('div', 'snv-detail');
    detail.hidden = true;

    detail.appendChild(el('p', 'snv-full', item.text));

    if (item.observed) detail.appendChild(detailBlock('observed', '他看到的（能对上的事）', item.observed));
    if (item.inferred) detail.appendChild(detailBlock('inferred', '他猜的（只是他的理解，不等于事实）', item.inferred));
    if (item.question) detail.appendChild(detailBlock('question', '他还没弄明白的', item.question));

    var meta = [];
    if (item.basisLabel) meta.push('依据：' + item.basisLabel);
    meta.push('可信程度：' + item.confidenceLabel);
    if (meta.length) detail.appendChild(el('div', 'snv-meta', meta.join(' · ')));

    if (item.evidence.length) {
      var ev = el('div', 'snv-ev');
      ev.appendChild(el('b', '', '来自这些聊天原文'));
      item.evidence.forEach(function (e) {
        var box = el('div', 'snv-ev-item');
        box.appendChild(el('span', 'mid', e.messageId ? ('消息 #' + e.messageId) : '聊天原文'));
        box.appendChild(el('span', '', '「' + e.quote + '」'));
        ev.appendChild(box);
      });
      detail.appendChild(ev);
    }

    // 历史版本：修订前的旧内容完整回看（保留旧证据链），只展示存在快照的记录。
    if (item.history.length) {
      var hv = el('div', 'snv-ev');
      hv.appendChild(el('b', '', '修订前的版本（共 ' + item.history.length + ' 个旧版本）'));
      item.history.forEach(function (h, hi) {
        var old = el('div', 'snv-hist-item');
        var label = '旧版 ' + (hi + 1) + (h.at ? ' · ' + fmtDate(h.at) : '');
        old.appendChild(el('span', 'mid', label));
        old.appendChild(el('p', '', h.text));
        if (h.evidence.length) {
          old.appendChild(el('div', 'hmeta', '旧版证据：' + h.evidence.map(function (e) {
            return '#' + e.messageId + '「' + e.quote.slice(0, 20) + '」';
          }).join('；')));
        }
        hv.appendChild(old);
      });
      detail.appendChild(hv);
    }

    card.appendChild(detail);
    return card;
  }

  function emptyBox(text, retry) {
    var box = el('div', 'snv-empty');
    box.appendChild(el('p', '', text));
    if (retry) {
      var b = el('button', 'small-btn', '再试一次');
      b.type = 'button';
      b.setAttribute('data-snv-retry', '1');
      box.appendChild(b);
    }
    return box;
  }

  function fail(host, text) {
    host.textContent = '';
    host.appendChild(emptyBox(text, true));
  }

  function paint(model) {
    if (!doc) return;
    var host = doc.getElementById(LIST_ID);
    if (!host) return;
    host.textContent = '';
    if (!model || !model.total) {
      host.appendChild(emptyBox('这里还空着。等他慢慢认得你，会把一些话留在这里，写给你看。'));
      return;
    }
    if (!model.items.length) {
      host.appendChild(emptyBox('这一类还没有记录。换个类型看看？'));
      return;
    }
    model.items.forEach(function (item) { host.appendChild(cardOf(item)); });
  }

  function renderFilters(model) {
    if (!doc) return;
    var bar = doc.getElementById(FILTER_ID);
    if (!bar) return;
    bar.textContent = '';
    FILTERS.forEach(function (f) {
      var n = f.key === 'all' ? model.total : (model.counts[f.key] || 0);
      var b = el('button', 'snv-filter' + (model.filter === f.key ? ' active' : ''), f.label + (n ? ' ' + n : ''));
      b.type = 'button';
      b.setAttribute('data-filter', f.key);
      b.disabled = f.key !== 'all' && !n;
      bar.appendChild(b);
    });
  }

  var bound = false;
  function bind() {
    if (!doc || bound) return;
    bound = true;
    var host = doc.getElementById(LIST_ID);
    if (host) {
      host.addEventListener('click', function (ev) {
        var retry = ev.target && ev.target.closest ? ev.target.closest('[data-snv-retry]') : null;
        if (retry) { render(); return; }
        var head = ev.target && ev.target.closest ? ev.target.closest('.snv-head') : null;
        if (!head) return;
        var card = head.parentNode;
        var open = card.classList.toggle('open');
        head.setAttribute('aria-expanded', open ? 'true' : 'false');
        var detail = card.querySelector('.snv-detail');
        if (detail) detail.hidden = !open;
      });
    }
    var bar = doc.getElementById(FILTER_ID);
    if (bar) {
      bar.addEventListener('click', function (ev) {
        var b = ev.target && ev.target.closest ? ev.target.closest('.snv-filter') : null;
        if (!b || b.disabled) return;
        var key = b.getAttribute('data-filter');
        if (!key || key === currentFilter) return;
        currentFilter = key;
        lastModel = buildView(lastRecords, { filter: currentFilter });
        renderFilters(lastModel);
        paint(lastModel);
      });
    }
  }

  /* ---------------- 对外入口 ---------------- */

  function reasonText(res) {
    var r = res && res.reason;
    if (r === 'state-invalid-kept') return '本地的机自述结构不合法，已原样保留，没有做任何改动。';
    if (r === 'read-failed') return '读不到本地数据，可能是浏览器存储暂时不可用。';
    if (r === 'bad-store') return '读取依赖没有准备好，刷新页面再试试。';
    return '暂时读不出来' + (r ? '（' + r + '）' : '') + '。';
  }

  async function render(opts) {
    var o = isObj(opts) ? opts : {};
    if (o.filter) currentFilter = str(o.filter) || 'all';
    if (!doc) return { ok: false, reason: 'no-document' };
    var host = doc.getElementById(LIST_ID);
    if (!host) return { ok: false, reason: 'no-host' };
    ensureStyle();
    bind();

    if (!SN || typeof SN.list !== 'function') {
      fail(host, '机自述的数据层没有加载，刷新页面再试试。');
      return { ok: false, reason: 'no-data-layer' };
    }

    host.textContent = '';
    host.appendChild(el('div', 'snv-empty', '正在翻开他写下的东西……'));

    var res;
    try {
      res = await SN.list(readOnlyStore(o.get), { status: 'active' });
    } catch (e) {
      fail(host, '读取时出错了：' + ((e && e.message) || e));
      return { ok: false, reason: 'read-failed' };
    }
    if (!res || !res.ok) {
      fail(host, reasonText(res));
      return { ok: false, reason: (res && res.reason) || 'read-failed' };
    }

    lastRecords = Array.isArray(res.records) ? res.records : [];
    lastModel = buildView(lastRecords, { filter: currentFilter });
    renderFilters(lastModel);
    paint(lastModel);
    return { ok: true, total: lastModel.total, shown: lastModel.shown, filter: lastModel.filter };
  }

  function open() {
    if (typeof root.showPage === 'function') root.showPage('narrative');
    return render();
  }

  // 首页入口的宽卡片样式要在首屏就生效，不能等用户点进页面才注入。
  if (doc) ensureStyle();

  root.SelfNarrativeView = {
    LIST_ID: LIST_ID,
    FILTER_ID: FILTER_ID,
    FILTERS: FILTERS.slice(),
    CONFIDENCE_LABELS: Object.assign({}, CONFIDENCE_LABELS),
    // 纯函数（供测试复用）
    buildView: buildView,
    readOnlyStore: readOnlyStore,
    kindLabel: kindLabel,
    titleOf: titleOf,
    summaryOf: summaryOf,
    evidenceOf: evidenceOf,
    // 页面入口
    render: render,
    open: open
  };
  root.openSelfNarrative = open;
})(typeof globalThis !== 'undefined' ? globalThis : this);
