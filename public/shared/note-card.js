/* public/shared/note-card.js — 新版「星星的今日便签」
 *
 * 职责：在首页既有 .note-card 内部插入「今天的小事」，负责由小星单方面
 *       安排给用户的小任务：渲染、进度、状态转换、每日归档与往日折叠浏览。
 *       发起者永远是小星，执行者永远是用户；用户可自由接受/拒绝/延期。
 *
 * 边界（硬约束）：
 *   - 只读写 star_fifi_room 的 diaries 表，且只认 type === 'note-day' 的行；
 *     精确匹配，不用反选（旧 record 没有 type，必须继续当 today-letter）。
 *   - 不写 messages / starDiaries / futureLetters；不新增表、不升 DB 版本。
 *   - 不重建 .note-card：只插一个容器，不动 #dailyTitle / #dailyText / #weatherText / 签名。
 *     唯一例外是用户主动点「让星星说一句」后改写留言正文（功能本身，且保留静态原文）。
 *   - 不自动调用 AI：只有点按钮才发一次，每天最多一次，失败回落本地文案。
 *   - 正文编辑只改 tasks[i].text 与任务/便签的 updatedAt：不改状态、不改 id、不改来源与进度，
 *     不新建记录，不触发完成事件，不调 AI；空白不保存，取消不写库。
 *   - 不发任何其他请求、不轮询、不定时器。
 *   - 完成时复用 LifeEvents.record()（其内部已派发 life:feed），不改小屋动静模块。
 */
(function (root) {
  'use strict';

  var TYPE = 'note-day';
  var DEFAULT_TITLE = '用户，欢迎回来。';
  var DEFAULT_TEXT = '愿今天也有一点温柔的光，落在你的肩上。';
  var HISTORY_DAYS = 14;        // 历史默认展示天数
  var HISTORY_SHOW = 7;         // 一次最多渲染天数
  var UNDO_MS = 24 * 3600000;   // 完成当天可撤销
  var AI_LINE_MAX = 120;        // 注入主聊的一行摘要上限
  var MAX_TASK_TEXT = 24;
  var MAX_TARGET = 20;

  /* ---------------- 时间工具（本地时区） ---------------- */
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function dayOf(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function nowMs() { return Date.now(); }

  /* ---------------- 状态 ---------------- */
  var ST = {
    PENDING: 'pending_accept',
    ACTIVE: 'active',
    DONE: 'done',
    DECLINED: 'declined',
    POSTPONED: 'postponed',
    EXPIRED: 'expired'
  };
  // 跨天归档：只有「待接受 / 进行中」算没做完；延期按历史结果保留
  var OPEN = [ST.PENDING, ST.ACTIVE];
  var STATUS_LABEL = {
    pending_accept: '待接受', active: '进行中', done: '完成',
    declined: '拒绝', postponed: '延期', expired: '没做完'
  };

  function isNote(row) { return !!row && typeof row === 'object' && row.type === TYPE; }
  function isOpen(status) { return OPEN.indexOf(status) !== -1; }
  function isDone(task) { return !!task && task.status === ST.DONE; }

  /* ---------------- 状态变化后的自然回应（本地句池，0 请求） ---------------- */
  // 单向任务：发起者永远是小星，执行者是用户；这里全是他针对她真实操作的回应
  var POOLS = {
    'star:accept': ['行，那就这么定。', '答应了就别赖。', '记下了，我看着你做完。'],
    'star:bump': ['一次，记着了。', '好，接着来。', '数着呢，继续。'],
    'star:done': ['一件没落。行，我记住了。', '做完了。过来，让我看看你。', '说了就能做到，我信你。'],
    'star:decline': ['不做就不做，别硬撑。', '那就算了，别为难自己。', '行，这件我撤了。'],
    'star:postpone': ['那就往后放，今天先歇。', '不急，明天再说。', '先放着吧，别硬撑。'],
    'star:resume': ['想接着做就接着做。', '行，那就继续。', '回来就好，接着来。'],
    'star:undo': ['反悔了？也行。', '刚说做完，又改主意。', '好，当没做完。']
  };

  function hash(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h < 0 ? -h : h;
  }
  function pickReply(task, action) {
    var pool = POOLS['star:' + action] || [];
    if (!pool.length) return '';
    var seed = String(task.id || '') + '|' + action + '|' + (task.progress || 0);
    return pool[hash(seed) % pool.length];
  }

  /* ---------------- 星星今天的任务模板（本地，0 请求） ---------------- */
  var TEMPLATES = [
    { text: '喝水', target: 3, unit: '次' },
    { text: '喊三声搭档', target: 3, unit: '声' },
    { text: '十一点前躺下', target: 1, unit: '' },
    { text: '起来走两步', target: 2, unit: '趟' },
    { text: '吃点东西，别空着', target: 1, unit: '' },
    { text: '抬头看会儿窗外', target: 1, unit: '' },
    { text: '早点离开屏幕', target: 1, unit: '' },
    { text: '午休二十分钟', target: 1, unit: '' },
    { text: '晒会儿太阳', target: 1, unit: '' },
    { text: '跟我做个小挑战', target: 1, unit: '' }
  ];

  /* ---------------- 数据装配（纯函数） ---------------- */
  function newTask(fields, now, day) {
    var target = Math.max(1, Math.min(MAX_TARGET, Math.round(Number(fields.target) || 1)));
    return {
      id: fields.id || ('nt_' + now.toString(36) + '_' + hash(String(fields.text || '') + now).toString(36).slice(0, 4)),
      from: 'star',   // 单向：发起者固定为小星，不接收外部指定的发起方
      text: String(fields.text || '').slice(0, MAX_TASK_TEXT),
      unit: String(fields.unit || ''),
      target: target,
      progress: 0,
      status: fields.status || ST.PENDING,
      day: day,
      createdAt: now,
      updatedAt: now,
      reply: ''
    };
  }

  function newNote(day, now, base) {
    var b = base || {};
    return {
      type: TYPE,
      v: 1,
      date: day,
      message: {
        title: b.title || DEFAULT_TITLE,
        text: b.text || DEFAULT_TEXT,
        source: 'static',
        at: now,
        base: { title: b.title || DEFAULT_TITLE, text: b.text || DEFAULT_TEXT }
      },
      tasks: [],
      aiAt: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null
    };
  }

  /** 取当天要用的星星侧任务：同日已有任意星星任务就不再补（拒绝/延期也不补） */
  function needsStarTask(note) {
    if (!note || !Array.isArray(note.tasks)) return false;
    for (var i = 0; i < note.tasks.length; i++) {
      if (note.tasks[i] && note.tasks[i].from === 'star') return false;
    }
    return true;
  }

  function pickTemplate(day, prevNote) {
    var idx = hash(day) % TEMPLATES.length;
    var prevText = '';
    if (prevNote && Array.isArray(prevNote.tasks)) {
      for (var i = 0; i < prevNote.tasks.length; i++) {
        var t = prevNote.tasks[i];
        if (t && t.from === 'star') { prevText = t.text; break; }
      }
    }
    if (prevText && TEMPLATES[idx].text === prevText) idx = (idx + 1) % TEMPLATES.length;
    return TEMPLATES[idx];
  }

  function findNote(notes, day) {
    var hit = null;
    (notes || []).forEach(function (n) {
      if (!isNote(n) || n.date !== day) return;
      if (!hit || (n.createdAt || 0) < (hit.createdAt || 0)) hit = n;
    });
    return hit;
  }

  function prevNoteOf(notes, day) {
    var best = null;
    (notes || []).forEach(function (n) {
      if (!isNote(n) || !n.date || n.date >= day) return;
      if (!best || n.date > best.date) best = n;
    });
    return best;
  }

  /** 每日归档：昨天的「待接受/进行中」→ expired；延期保留 postponed；不复制任务 */
  function rollover(notes, day, now) {
    var changed = [];
    (notes || []).forEach(function (n) {
      if (!isNote(n) || !n.date || n.date >= day) return;
      var touched = false;
      (n.tasks || []).forEach(function (t) {
        if (t && isOpen(t.status)) { t.status = ST.EXPIRED; t.expiredAt = now; t.updatedAt = now; touched = true; }
      });
      if (!n.archivedAt) { n.archivedAt = now; touched = true; }
      if (touched) changed.push(n);
    });
    return { notes: notes || [], changed: changed };
  }

  function summaryOf(tasks) {
    var done = 0, open = 0;
    (tasks || []).forEach(function (t) { if (!t) return; if (t.status === ST.DONE) done++; else if (isOpen(t.status)) open++; });
    return { total: (tasks || []).length, done: done, open: open };
  }
  function summary(note) { return summaryOf((note && note.tasks) || []); }

  /** 喂给 AI 的只算星星安排的（历史遗留 from:'her' 行不进上下文，也不要求星星执行） */
  function starTasks(note) {
    return ((note && note.tasks) || []).filter(function (t) { return !!t && t.from === 'star'; });
  }

  /* ---------------- 正文编辑（只改 text，不动状态与生命周期） ---------------- */
  /** 正文规范化：去首尾空白、压掉换行与连续空格、不超过原有 24 字上限 */
  function editText(raw) {
    return String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().slice(0, MAX_TASK_TEXT);
  }

  /** 纯函数：返回改过正文的新任务；空白或没有变化时返回 null（不写库） */
  function applyEdit(task, text, ctx) {
    if (!task || typeof task !== 'object') return null;
    var next = editText(text);
    if (!next || next === task.text) return null;
    var t = {};
    for (var k in task) if (Object.prototype.hasOwnProperty.call(task, k)) t[k] = task[k];
    t.text = next;
    t.updatedAt = (ctx && typeof ctx.now === 'number') ? ctx.now : nowMs();
    return t;
  }

  /* ---------------- 状态机（纯函数，非法转换返回 null） ---------------- */
  function applyAction(task, action, ctx) {
    if (!task || typeof task !== 'object') return null;
    ctx = ctx || {};
    var now = typeof ctx.now === 'number' ? ctx.now : nowMs();
    var day = ctx.day || dayOf(now);
    var cur = task.status;
    var t = {};
    for (var k in task) if (Object.prototype.hasOwnProperty.call(task, k)) t[k] = task[k];

    if (action === 'accept') {
      if (cur !== ST.PENDING) return null;
      t.status = ST.ACTIVE; t.acceptedAt = now;
    } else if (action === 'resume') {
      if (cur !== ST.POSTPONED) return null;
      if (t.day && t.day !== day) return null;          // 只有当天能捡回来
      t.status = ST.ACTIVE; t.resumedAt = now;
    } else if (action === 'bump') {
      if (cur !== ST.ACTIVE) return null;
      if ((t.progress || 0) >= t.target) return null;
      t.progress = Math.min(t.target, (t.progress || 0) + 1);
      if (t.progress >= t.target) { t.status = ST.DONE; t.doneAt = now; }
    } else if (action === 'decline') {
      if (cur !== ST.PENDING && cur !== ST.ACTIVE) return null;
      t.status = ST.DECLINED; t.declinedAt = now;
    } else if (action === 'postpone') {
      if (cur !== ST.PENDING && cur !== ST.ACTIVE) return null;
      t.status = ST.POSTPONED; t.postponedAt = now;
    } else if (action === 'undo') {
      if (cur !== ST.DONE) return null;
      if (t.day && t.day !== day) return null;
      if (typeof t.doneAt === 'number' && now - t.doneAt > UNDO_MS) return null;
      t.status = ST.ACTIVE;
      t.progress = Math.max(0, (t.progress || 1) - 1);
      delete t.doneAt;
    } else {
      return null;
    }
    t.reply = pickReply(t, action);
    t.updatedAt = now;
    return t;
  }

  /* ---------------- 按需 AI 摘要（≤120 字，只含今天 + 昨天一行） ---------------- */
  // 关系必须写死在提示词里：小星是发起者，用户是执行者；避免模型把任务当成用户自己的待办，
  // 或反过来以为小星要去执行。历史遗留的 from:'her' 行不进上下文。
  var AI_RELATION = '便签任务是你给用户安排的，不是她自己的待办；你只提议、关注进度并回应，不替她执行；她可以接受、拒绝或延期，都不算违约。';

  function aiLine(today, prev) {
    var mine = starTasks(today);
    if (!mine.length) return '';
    var s = summaryOf(mine);
    var names = mine.slice(0, 3).map(function (t) {
      return String(t.text || '').slice(0, 6)
        + (t.target > 1 ? ' ' + (t.progress || 0) + '/' + t.target : '')
        + '（' + (STATUS_LABEL[t.status] || '') + '）';
    }).join('、');
    var core = '【今日便签】今天你给用户安排了 ' + s.total + ' 件：' + names + (mine.length > 3 ? '等' : '') + '。';
    var old = starTasks(prev);
    if (old.length) {
      var ps = summaryOf(old);
      core += '昨天你安排的 ' + ps.total + ' 件完成 ' + ps.done + ' 件。';
    }
    var room = AI_LINE_MAX - AI_RELATION.length;
    if (core.length > room) core = core.slice(0, Math.max(0, room - 1)) + '…';
    return core + AI_RELATION;
  }

  /* ---------------- 本地留言（0 请求，仅在用户点 AI 且失败时兜底） ---------------- */
  var LOCAL_LINES = [
    '今天也慢一点，不着急。',
    '别把事都堆在今天。',
    '记得吃饭，别硬撑。',
    '困了就眯一会儿，我不催你。',
    '忙完过来，我在这儿。'
  ];
  function localMessage(note, now) {
    var seed = (note && note.date ? note.date : dayOf(now)) + '|msg';
    return LOCAL_LINES[hash(seed) % LOCAL_LINES.length];
  }

  /* ---------------- 存储（IndexedDB，只碰 diaries） ---------------- */
  var DB_NAME = 'star_fifi_room';
  var STORE = 'diaries';

  function idbOpen() {
    return new Promise(function (resolve) {
      var idb = root.indexedDB;
      if (!idb || !idb.open) { resolve(null); return; }
      var req;
      try { req = idb.open(DB_NAME); } catch (e) { resolve(null); return; }  // 不带版本：绝不触发升级
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { resolve(null); };
      req.onblocked = function () { resolve(null); };
    });
  }

  function hasStore(db) {
    if (!db || !db.objectStoreNames) return false;
    var names = db.objectStoreNames;
    if (typeof names.contains === 'function') return names.contains(STORE);
    return Array.prototype.indexOf.call(names, STORE) !== -1;
  }

  function withStore(mode, fn) {
    return idbOpen().then(function (db) {
      if (!hasStore(db)) { try { db && db.close(); } catch (e) {} return null; }
      return new Promise(function (resolve) {
        var result = null;
        try {
          var tx = db.transaction(STORE, mode);
          var req = fn(tx.objectStore(STORE));
          req.onsuccess = function () { result = req.result; };
          req.onerror = function () { result = null; };
          tx.oncomplete = function () { try { db.close(); } catch (e) {} resolve(result); };
          tx.onerror = function () { try { db.close(); } catch (e) {} resolve(null); };
          tx.onabort = function () { try { db.close(); } catch (e) {} resolve(null); };
        } catch (e) { try { db.close(); } catch (e2) {} resolve(null); }
      });
    });
  }

  var defaultStore = {
    all: function () {
      return withStore('readonly', function (os) { return os.getAll(); })
        .then(function (r) { return Array.isArray(r) ? r : []; });
    },
    add: function (row) {
      return withStore('readwrite', function (os) { return os.add(row); })
        .then(function (r) { return typeof r === 'number' ? r : null; });
    },
    put: function (row) {
      return withStore('readwrite', function (os) { return os.put(row); })
        .then(function (r) { return r !== null; });
    }
  };

  var store = defaultStore;

  /* ---------------- 运行时状态 ---------------- */
  var state = {
    now: null,
    el: null,
    notes: [],
    note: null,
    prev: null,
    historyOpen: false,
    busy: false,
    editing: null,
    loading: null
  };

  function clock() { return state.now === null ? nowMs() : state.now; }
  function todayStr() { return dayOf(clock()); }

  function persist() {
    if (!state.note) return Promise.resolve(false);
    if (typeof state.note.id === 'number') return Promise.resolve(store.put(state.note)).then(function (r) { return !!r; });
    return Promise.resolve(store.add(state.note)).then(function (id) {
      if (typeof id === 'number') { state.note.id = id; return true; }
      return false;
    });
  }

  function persistNote(note) {
    if (typeof note.id === 'number') return Promise.resolve(store.put(note));
    return Promise.resolve(store.add(note)).then(function (id) { if (typeof id === 'number') note.id = id; return id; });
  }

  /* ---------------- 载入 + 归档 + 幂等建当天 ---------------- */
  function load() {
    if (state.loading) return state.loading;
    state.loading = (function () {
      var day = todayStr(), now = clock();
      return Promise.resolve(store.all()).then(function (rows) {
        var notes = (rows || []).filter(isNote);
        var rolled = rollover(notes, day, now);
        var writes = rolled.changed.map(function (n) { return persistNote(n); });
        var note = findNote(notes, day);
        var created = false;
        var chain = Promise.resolve();
        if (!note) {
          note = newNote(day, now, baseMessage());
          created = true;
          chain = chain.then(function () { return persistNote(note); });
        }
        return chain.then(function () {
          state.notes = notes;
          state.note = note;
          state.prev = prevNoteOf(notes, day);
          var seeded = false;
          if (needsStarTask(note)) {
            var tpl = pickTemplate(day, state.prev);
            var task = newTask({ from: 'star', text: tpl.text, target: tpl.target, unit: tpl.unit, status: ST.PENDING }, now, day);
            note.tasks = (note.tasks || []).concat([task]);
            note.updatedAt = now;
            seeded = true;
          }
          if (seeded) return persist().then(function () { return Promise.all(writes); });
          return Promise.all(writes);
        }).then(function () {
          return { note: note, created: created };
        });
      });
    })().then(function (r) {
      state.loading = null;
      return r;
    }, function (e) {
      state.loading = null;
      throw e;
    });
    return state.loading;
  }

  /** 创建当天便签时，沿用页面上已有的静态文案作为底稿 */
  function baseMessage() {
    var title = '', text = '';
    var doc = root.document;
    if (doc) {
      var t = doc.getElementById('dailyTitle');
      var b = doc.getElementById('dailyText');
      if (t && t.textContent) title = t.textContent.trim();
      if (b && b.textContent) text = b.textContent.trim();
    }
    return { title: title || DEFAULT_TITLE, text: text || DEFAULT_TEXT };
  }

  /* ---------------- DOM ---------------- */
  function el(tag, cls, text) {
    var n = root.document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function mount() {
    var doc = root.document;
    if (!doc) return false;
    var card = doc.querySelector('.note-card');
    if (!card) return false;
    var host = doc.getElementById('noteTasks');
    if (!host) {
      host = el('div', 'note-tasks');
      host.id = 'noteTasks';
      var anchor = doc.getElementById('weatherText');
      if (anchor && anchor.parentNode === card) card.insertBefore(host, anchor.nextSibling);
      else card.appendChild(host);
    }
    state.el = host;
    host.setAttribute('data-mounted', '1');
    bindOnce(host);
    return load().then(function () {
      applyMessage();
      render();
      return true;
    }).catch(function () {
      host.textContent = '';
      host.appendChild(el('p', 'nt-empty', '便签暂时读不出来。'));
      return false;
    });
  }

  function bindOnce(host) {
    if (host.getAttribute('data-bound') === '1') return;
    host.setAttribute('data-bound', '1');
    host.addEventListener('click', onClick);
    host.addEventListener('input', onInput);
    host.addEventListener('keydown', onKeydown);
  }

  function refresh() {
    return load().then(function () { applyMessage(); render(); return true; }).catch(function () { return false; });
  }

  /* ---------------- 渲染 ---------------- */
  function render() {
    var doc = root.document;
    if (!doc || !state.el) return;
    var host = state.el;
    var note = state.note;
    host.textContent = '';
    if (!note) { host.appendChild(el('p', 'nt-empty', '今天还没有便签。')); return; }

    var s = summary(note);
    var head = el('div', 'nt-head');
    head.appendChild(el('span', 'nt-title', '今天的小事'));
    // 只有一条（或没有）任务时不显示总计数，单独一行的进度已足够说明
    if (s.total >= 2) head.appendChild(el('span', 'nt-count', s.done + '/' + s.total + ' 完成'));
    host.appendChild(head);

    var list = el('div', 'nt-list');
    (note.tasks || []).forEach(function (t) { list.appendChild(renderTask(t, note)); });
    if (!(note.tasks || []).length) list.appendChild(el('p', 'nt-empty', '今天没有安排，也挺好。'));
    host.appendChild(list);

    host.appendChild(renderFoot(note));
    if (state.historyOpen) {
      var past = pastNotes();
      if (past.length) host.appendChild(renderHistory(past));
    }
    focusEditInput();
  }

  /** 进入编辑后把光标放回输入框末尾（只在编辑态生效） */
  function focusEditInput() {
    if (!state.editing || !state.el || !state.el.querySelector) return;
    var input = state.el.querySelector('[data-role="edit-input"]');
    if (!input || !input.focus) return;
    try {
      input.focus();
      var n = input.value.length;
      input.setSelectionRange(n, n);
    } catch (e) {}
  }

  function pastNotes() {
    return (state.notes || [])
      .filter(function (n) { return isNote(n) && n.date && n.date < todayStr(); })
      .sort(function (a, b) { return a.date < b.date ? 1 : -1; })
      .slice(0, HISTORY_DAYS);
  }

  function markOf(task) {
    return task.status === ST.DONE ? '✓'
      : task.status === ST.DECLINED ? '×'
      : task.status === ST.POSTPONED ? '»'
      : task.status === ST.EXPIRED ? '·' : '○';
  }

  /** 编辑态：保留标记与进度，只把正文换成输入框；状态、日期等原样不动 */
  function renderEditRow(task, wrap) {
    var line = el('div', 'nt-line');
    line.appendChild(el('span', 'nt-mark', markOf(task)));
    var input = el('input', 'nt-input');
    input.type = 'text';
    input.value = state.editing.text;
    input.maxLength = MAX_TASK_TEXT;
    input.setAttribute('data-role', 'edit-input');
    input.setAttribute('aria-label', '便签正文');
    line.appendChild(input);
    wrap.appendChild(line);

    var acts = el('div', 'nt-acts');
    var save = btn('edit-save', '保存');
    save.className = 'nt-btn nt-btn--primary';
    acts.appendChild(save);
    acts.appendChild(btn('edit-cancel', '取消'));
    wrap.appendChild(acts);
    return wrap;
  }

  function renderTask(task, note) {
    var wrap = el('div', 'nt-task nt-task--' + task.status);
    wrap.setAttribute('data-id', task.id);
    wrap.setAttribute('data-status', task.status);
    if (state.editing && String(state.editing.id) === String(task.id)) return renderEditRow(task, wrap);

    var line = el('div', 'nt-line');
    line.appendChild(el('span', 'nt-mark', markOf(task)));
    line.appendChild(el('span', 'nt-text', task.text));
    if (task.target > 1 || task.progress > 0) {
      line.appendChild(el('span', 'nt-prog', (task.progress || 0) + '/' + task.target));
    }
    wrap.appendChild(line);

    if (task.target > 1) {
      var bar = el('div', 'nt-bar');
      var fill = el('i');
      fill.style.width = Math.round(((task.progress || 0) / task.target) * 100) + '%';
      bar.appendChild(fill);
      wrap.appendChild(bar);
    }

    var acts = el('div', 'nt-acts');
    var day = note.date;
    var sameDay = day === todayStr();
    if (task.status === ST.PENDING) {
      acts.appendChild(btn('accept', '接受'));
      acts.appendChild(btn('decline', '拒绝'));
      acts.appendChild(btn('postpone', '延期'));
    } else if (task.status === ST.ACTIVE) {
      acts.appendChild(btn('bump', task.target > 1 ? '＋1' : '完成了'));
      acts.appendChild(btn('postpone', '延期'));
      acts.appendChild(btn('decline', '拒绝'));
    } else if (task.status === ST.DONE && sameDay) {
      acts.appendChild(btn('undo', '撤销'));
    } else if (task.status === ST.POSTPONED && sameDay) {
      acts.appendChild(btn('resume', '继续'));
    }
    // 编辑只改正文：任何状态都能改，但不改状态、不重置进度、不新建记录
    if (sameDay) acts.appendChild(btn('edit', '编辑'));
    if (acts.childNodes.length) wrap.appendChild(acts);

    if (task.reply) wrap.appendChild(el('p', 'nt-reply', task.reply));
    else if (task.status === ST.POSTPONED && !sameDay) wrap.appendChild(el('p', 'nt-reply', '那天先放下了。'));
    else if (task.status === ST.EXPIRED) wrap.appendChild(el('p', 'nt-reply', '那天没做完。'));
    return wrap;
  }

  function btn(act, label) {
    var b = el('button', 'nt-btn', label);
    b.type = 'button';
    b.setAttribute('data-act', act);
    return b;
  }

  function renderFoot(note) {
    var wrap = el('div', 'nt-foot');

    if (!note.aiAt) {
      var ai = el('button', 'nt-foot-btn', '让星星说一句');
      ai.type = 'button';
      ai.setAttribute('data-act', 'ai');
      wrap.appendChild(ai);
    }

    var past = pastNotes();
    if (past.length) {
      var fold = el('button', 'nt-foot-btn', state.historyOpen ? '收起往日 ›' : '更早的便签 · 还有 ' + past.length + ' 天');
      fold.type = 'button';
      fold.setAttribute('data-act', 'history');
      wrap.appendChild(fold);
    } else {
      wrap.appendChild(el('span', 'nt-foot-btn', '还没有往日记录'));
    }
    return wrap;
  }

  function renderHistory(past) {
    var box = el('div', 'nt-history');
    past.slice(0, HISTORY_SHOW).forEach(function (n) {
      var day = el('div', 'nt-day');
      day.appendChild(el('div', 'nt-day-head', dateLabel(n.date)));
      var msg = n.message && n.message.text ? n.message.text : '';
      if (msg) day.appendChild(el('p', 'nt-day-msg', msg));
      (n.tasks || []).forEach(function (t) {
        var row = el('div', 'nt-hrow');
        row.appendChild(el('span', 'nt-htext', t.text));
        row.appendChild(el('span', 'nt-hstat', (t.target > 1 ? (t.progress || 0) + '/' + t.target + ' · ' : '') + (STATUS_LABEL[t.status] || '')));
        day.appendChild(row);
      });
      box.appendChild(day);
    });
    return box;
  }

  function dateLabel(date) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
    if (!m) return date || '';
    return Number(m[2]) + '月' + Number(m[3]) + '日';
  }

  /** 只有用户自己让星星写过，才改留言正文；静态兜底保持页面原样（天气与签名永不触碰） */
  function applyMessage() {
    var doc = root.document;
    if (!doc || !state.note || !state.note.message) return;
    var msg = state.note.message;
    if (msg.source === 'static') return;
    var t = doc.getElementById('dailyTitle');
    var b = doc.getElementById('dailyText');
    if (t && msg.title) t.textContent = msg.title;
    if (b && msg.text) b.textContent = msg.text;
  }

  /* ---------------- 交互 ---------------- */
  function currentTask(id) {
    var list = (state.note && state.note.tasks) || [];
    for (var i = 0; i < list.length; i++) if (list[i] && String(list[i].id) === String(id)) return i;
    return -1;
  }

  function onClick(e) {
    var target = e.target;
    var act = target && target.getAttribute ? target.getAttribute('data-act') : null;
    if (!act) return;
    var row = target.closest ? target.closest('.nt-task') : null;
    var id = row ? row.getAttribute('data-id') : null;
    e.preventDefault();

    if (act === 'history') { state.historyOpen = !state.historyOpen; render(); return; }
    if (act === 'ai') { askStar(); return; }
    if (act === 'edit-cancel') { cancelEdit(); return; }
    if (act === 'edit-save') { saveEdit(); return; }
    if (!id) return;
    if (act === 'edit') { beginEdit(id); return; }
    doTask(id, act);
  }

  /* ---------------- 编辑态：进入 / 取消 / 保存 ---------------- */
  function beginEdit(id) {
    if (state.busy) return;
    var idx = currentTask(id);
    if (idx === -1) return;
    var task = state.note.tasks[idx];
    state.editing = { id: String(task.id), text: String(task.text || '') };
    render();
  }

  /** 取消：丢弃草稿，不读也不写库，原正文保持不变 */
  function cancelEdit() {
    if (!state.editing) return;
    state.editing = null;
    render();
  }

  /** 保存：原地更新这条任务的正文；空白不保存，内容没变则直接退出编辑 */
  function doEdit(id, rawText) {
    if (state.busy) return Promise.resolve({ ok: false, reason: 'busy' });
    var idx = currentTask(id);
    if (idx === -1) return Promise.resolve({ ok: false, reason: 'missing' });
    var text = editText(rawText);
    if (!text) return Promise.resolve({ ok: false, reason: 'empty' });   // 保持编辑态，什么都不写
    var next = applyEdit(state.note.tasks[idx], text, { now: clock() });
    state.editing = null;
    if (!next) { render(); return Promise.resolve({ ok: true, reason: 'same' }); }
    state.busy = true;
    state.note.tasks[idx] = next;
    state.note.updatedAt = clock();
    return persist().then(function (r) {
      state.busy = false;
      render();
      return r === false ? { ok: false, reason: 'save-error' } : { ok: true, text: next.text };
    }, function () {
      state.busy = false;
      render();
      return { ok: false, reason: 'save-error' };
    });
  }

  function saveEdit() {
    if (!state.editing || state.busy) return Promise.resolve(false);
    var id = state.editing.id;
    var input = state.el && state.el.querySelector ? state.el.querySelector('[data-role="edit-input"]') : null;
    var raw = input && 'value' in input ? input.value : state.editing.text;
    return doEdit(id, raw).then(function (r) {
      if (r && r.reason === 'empty') toast('写点什么再保存。');
      return r;
    });
  }

  function onInput(e) {
    var t = e.target;
    if (!t || !t.getAttribute || t.getAttribute('data-role') !== 'edit-input') return;
    if (state.editing) state.editing.text = t.value;
  }

  function onKeydown(e) {
    var t = e.target;
    if (!t || !t.getAttribute || t.getAttribute('data-role') !== 'edit-input') return;
    if (e.key === 'Enter') { e.preventDefault(); saveEdit(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
  }

  function doTask(id, action) {
    if (state.busy) return Promise.resolve(false);
    var idx = currentTask(id);
    if (idx === -1) return Promise.resolve(false);
    var before = state.note.tasks[idx];
    var next = applyAction(before, action, { now: clock(), day: todayStr() });
    if (!next) return Promise.resolve(false);          // 非法转换：界面不动，不写库
    state.busy = true;
    state.note.tasks[idx] = next;
    state.note.updatedAt = clock();
    return persist().then(function () {
      state.busy = false;
      if (action === 'bump' && next.status === ST.DONE) notifyDone(next);
      render();
      return true;
    }, function () { state.busy = false; return false; });
  }

  /** 完成事件复用现有生活事件层；LifeEvents.record 内部会派发 life:feed */
  function notifyDone(task) {
    var le = root.LifeEvents;
    if (!le || typeof le.record !== 'function') return;
    try {
      le.record({
        id: 'room:note-task:' + task.id,
        type: 'task.done',
        source: 'room',
        at: clock(),
        title: task.text
      });
    } catch (e) {}
  }

  /* ---------------- 「让星星说一句」：只有点击才调用，每天一次 ---------------- */
  function aiPrompt(note) {
    var s = summary(note);
    var lines = (note.tasks || []).map(function (t) {
      return t.text + (t.target > 1 ? ' ' + (t.progress || 0) + '/' + t.target : '') + '（' + (STATUS_LABEL[t.status] || '') + '）';
    }).join('；');
    return {
      system: '你是「星星」，说话简短、克制、带一点不容置疑的掌控感，但底色是关心。只写一句今天贴在便签上的留言：12-24 字中文，口语，不要问句，不要引号，不要括号，不要英文，不要解释。',
      user: '今天的小事：' + (lines || '还没有安排') + '。已完成 ' + s.done + '/' + s.total + ' 件。只输出那一句留言。'
    };
  }

  function cleanLine(raw) {
    var s = String(raw || '').split('|||')[0];
    s = s.split('\n')[0].trim();
    s = s.replace(/^["'「『]/, '').replace(/["'」』]$/, '').trim();
    return s.slice(0, 40);
  }

  function askStar() {
    if (!state.note) return Promise.resolve(false);
    if (state.note.aiAt) { toast('今天已经让他说过一次了。'); return Promise.resolve(false); }
    var note = state.note;
    note.aiAt = clock();                 // 先占位：连点不会再发第二次
    note.updatedAt = note.aiAt;
    var failed = false;
    var call = typeof root.callAI === 'function' ? root.callAI : null;
    var run = call
      ? Promise.resolve().then(function () { return call([ { role: 'system', content: aiPrompt(note).system }, { role: 'user', content: aiPrompt(note).user } ]); })
      : Promise.reject(new Error('no-ai'));
    return run.then(function (raw) {
      var line = cleanLine(raw);
      if (!line) throw new Error('empty');
      note.message = {
        title: note.message && note.message.base ? note.message.base.title : DEFAULT_TITLE,
        text: line,
        source: 'ai',
        at: clock(),
        base: (note.message && note.message.base) || { title: DEFAULT_TITLE, text: DEFAULT_TEXT }
      };
    }).catch(function () {
      failed = true;
      note.message = {
        title: (note.message && note.message.base ? note.message.base.title : DEFAULT_TITLE),
        text: localMessage(note, clock()),
        source: 'local',
        at: clock(),
        base: (note.message && note.message.base) || { title: DEFAULT_TITLE, text: DEFAULT_TEXT }
      };
    }).then(function () {
      return persist().then(function () {
        applyMessage();
        render();
        if (failed) toast('星星这会儿没回话，先用了一句本地的。');
        return !failed;
      });
    });
  }

  function toast(s) {
    if (typeof root.toast === 'function') { try { root.toast(s); return; } catch (e) {} }
  }

  /* ---------------- 对外接口 ---------------- */
  var api = {
    mount: mount,
    refresh: refresh,
    doTask: doTask,
    doEdit: doEdit,
    aiLine: function () { return aiLine(state.note, state.prev); },
    summary: function () { return state.note ? summary(state.note) : { total: 0, done: 0, open: 0 }; },
    get note() { return state.note; },
    _apply: applyAction,
    _applyEdit: applyEdit,
    _editText: editText,
    _newNote: newNote,
    _newTask: newTask,
    _rollover: rollover,
    _summary: summary,
    _aiLine: aiLine,
    _history: function (notes) {
      return (notes || []).filter(function (n) { return isNote(n) && n.date && n.date < todayStr(); })
        .sort(function (a, b) { return a.date < b.date ? 1 : -1; }).slice(0, HISTORY_DAYS);
    },
    _localMessage: localMessage,
    _cleanLine: cleanLine,
    _setStore: function (s) { store = s || defaultStore; state.loading = null; },
    _setNow: function (ms) { state.now = ms; },
    _reset: function () {
      state.el = null; state.notes = []; state.note = null; state.prev = null;
      state.historyOpen = false; state.busy = false; state.editing = null;
      state.loading = null;
      store = defaultStore; state.now = null;
    },
    _render: render,
    _load: load,
    _askStar: askStar,
    _pools: POOLS,
    _keys: { TYPE: TYPE, DEFAULT_TITLE: DEFAULT_TITLE, DEFAULT_TEXT: DEFAULT_TEXT, HISTORY_DAYS: HISTORY_DAYS, HISTORY_SHOW: HISTORY_SHOW, UNDO_MS: UNDO_MS, AI_LINE_MAX: AI_LINE_MAX, MAX_TASK_TEXT: MAX_TASK_TEXT, MAX_TARGET: MAX_TARGET, ST: ST, TEMPLATES: TEMPLATES }
  };

  root.NoteCard = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
