// public/cleanup.js
// 数据整理（临时工具）· 逐条检查并删除测试记录
//
// 边界：
//  - 只删除用户点选的那一条记录（单 key、单事务），不批量、不清空、不做级联删除。
//  - 不复用 app.js 的运行态（那会启动定时器与线程），只复用同一套库表与「按键删除」语义：
//      star_fifi_room.messages      ← 对应 app.js deleteMsg()
//      star_butler_v1.tasks         ← 对应 repository.removeTask()
//      star_butler_v1.transactions  ← 对应 repository.removeTransaction()
//      ylxh_radio_voice.clips       ← 对应 radioVoice.remove()
//    珍藏 / 星星日记 / 未来信 原本没有任何删除入口，这里只补最小删除能力。
//  - 不写 localStorage、不改设置、不碰备份与迁移日志、不联网。
(function () {
  'use strict';

  var ROOM = 'star_fifi_room';
  var BUTLER = 'star_butler_v1';
  var RADIO = 'ylxh_radio_voice';
  var LIFE_LOG_KEY = 'ylxh.life.log.v1';
  var PAGE_SIZE = 80;

  var suffix = '';

  var CATS = [
    { key: 'messages', label: '聊天记录', db: ROOM, store: 'messages', keyPath: 'id' },
    { key: 'keeps', label: '珍藏', db: ROOM, store: 'keeps', keyPath: 'id' },
    { key: 'starDiaries', label: '星星日记', db: ROOM, store: 'starDiaries', keyPath: 'id' },
    { key: 'futureLetters', label: '未来信', db: ROOM, store: 'futureLetters', keyPath: 'id' },
    { key: 'tasks', label: '待办与日程', db: BUTLER, store: 'tasks', keyPath: 'id' },
    { key: 'transactions', label: '账单', db: BUTLER, store: 'transactions', keyPath: 'id' },
    { key: 'clips', label: '电台声音', db: RADIO, store: 'clips', keyPath: 'id' },
  ];

  function cat(key) {
    for (var i = 0; i < CATS.length; i++) if (CATS[i].key === key) return CATS[i];
    return null;
  }

  function dbName(base) { return base + suffix; }

  // ---------- 只读打开：绝不创建新库 ----------
  // 不传版本号 = 只打开已存在的库。若库不存在会触发 upgradeneeded，
  // 此时立刻 abort，版本变更事务回滚，数据库不会被创建出来。
  function openExisting(name) {
    return new Promise(function (resolve, reject) {
      var req;
      try { req = indexedDB.open(name); } catch (e) { reject(new Error('无法访问本地数据库：' + e.message)); return; }
      var willCreate = false;
      req.onupgradeneeded = function (e) {
        willCreate = true;
        try { e.target.transaction.abort(); } catch (err) { }
      };
      req.onsuccess = function () {
        var dbh = req.result;
        if (willCreate) { try { dbh.close(); } catch (e) { } reject(new Error('本地还没有这个库：' + name)); return; }
        resolve(dbh);
      };
      req.onerror = function () {
        reject(new Error(willCreate ? ('本地还没有这个库：' + name)
          : ('打开 ' + name + ' 失败：' + ((req.error && req.error.message) || '未知错误'))));
      };
      req.onblocked = function () { reject(new Error('数据库被其它页面占用，请关闭其它标签页或稍后重试')); };
    });
  }

  function readAll(name, store) {
    return openExisting(name).then(function (dbh) {
      return new Promise(function (resolve, reject) {
        var out = [];
        var tx;
        try { tx = dbh.transaction(store, 'readonly'); } catch (e) { dbh.close(); reject(new Error('读取 ' + store + ' 失败：' + e.message)); return; }
        var req = tx.objectStore(store).openCursor();
        req.onsuccess = function () {
          var cur = req.result;
          if (cur) { out.push(cur.value); cur.continue(); }
        };
        tx.oncomplete = function () { dbh.close(); resolve(out); };
        tx.onerror = function () { dbh.close(); reject(tx.error || new Error('读取失败')); };
        tx.onabort = function () { dbh.close(); reject(tx.error || new Error('读取被中止')); };
      });
    });
  }

  function getOne(name, store, key) {
    return openExisting(name).then(function (dbh) {
      return new Promise(function (resolve, reject) {
        var tx = dbh.transaction(store, 'readonly');
        var req = tx.objectStore(store).get(key);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error || new Error('读取失败')); };
        tx.oncomplete = function () { dbh.close(); };
      });
    });
  }

  function countAll(name, store) {
    return readAll(name, store).then(function (list) { return list.length; });
  }

  // ---------- 单条删除 ----------
  function delOne(name, store, key) {
    return openExisting(name).then(function (dbh) {
      return new Promise(function (resolve, reject) {
        var tx = dbh.transaction(store, 'readwrite');
        tx.oncomplete = function () { dbh.close(); resolve(); };
        tx.onerror = function () { dbh.close(); reject(tx.error || new Error('删除失败')); };
        tx.onabort = function () { dbh.close(); reject(tx.error || new Error('删除被中止，记录已保留')); };
        try { tx.objectStore(store).delete(key); }
        catch (e) { try { tx.abort(); } catch (err) { } reject(new Error('删除请求无效：' + e.message)); }
      });
    });
  }

  // 删除后回读校验：还在 = 没删掉，必须报错而不是假装成功
  function deleteRecord(cfgKey, key) {
    var c = cat(cfgKey);
    if (!c) return Promise.reject(new Error('未知的分类：' + cfgKey));
    if (key === undefined || key === null || key === '') return Promise.reject(new Error('缺少记录标识'));
    var name = dbName(c.db);
    // 先确认它真的在：否则「删掉一个不存在的 key」会静默成功，看着像删了
    return getOne(name, c.store, key).then(function (before) {
      if (!before) throw new Error('这条记录已经不存在了（可能刚被删除），请刷新列表');
      return delOne(name, c.store, key);
    }).then(function () {
      return getOne(name, c.store, key);
    }).then(function (still) {
      if (still) throw new Error('删除后仍能读到这条记录，操作未生效（记录已保留）');
      return { ok: true, key: key };
    });
  }

  // ---------- 关联检查（只报告，绝不连带删除） ----------
  function lifeLogEntries() {
    try {
      var raw = localStorage.getItem(LIFE_LOG_KEY);
      if (!raw) return [];
      var v = JSON.parse(raw);
      return Array.isArray(v) ? v : (Array.isArray(v && v.events) ? v.events : []);
    } catch (e) { return []; }
  }

  function findRelations(msgId) {
    var rel = [];
    return readAll(dbName(ROOM), 'keeps').catch(function () { return []; }).then(function (keeps) {
      var n = keeps.filter(function (k) { return k && k.sourceMessageId === msgId; }).length;
      if (n) rel.push({ label: '珍藏', n: n, hint: '来自这条消息的珍藏仍会保留，可在「珍藏」里单独删除' });
      return readAll(dbName(ROOM), 'futureLetters').catch(function () { return []; });
    }).then(function (letters) {
      var n = letters.filter(function (l) { return l && l.replyMessageId === msgId; }).length;
      if (n) rel.push({ label: '未来信', n: n, hint: '这封信的回复引用了这条消息，信本身保留' });
      return readAll(dbName(ROOM), 'messages').catch(function () { return []; });
    }).then(function (msgs) {
      var n = msgs.filter(function (m) { return m && m.sourceId === msgId && m.id !== msgId; }).length;
      if (n) rel.push({ label: '聊天消息', n: n, hint: '有 ' + n + ' 条消息是从这条消息生成的回信' });
      var g = lifeLogEntries().filter(function (e) { return e && e.id === 'game:shared:' + msgId; }).length;
      if (g) rel.push({ label: '生活记录', n: g, hint: '「小屋的动静」里有 1 条相关经历，不会自动删除' });
      return rel;
    });
  }

  // ---------- 展示 ----------
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function clip(s, n) {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n) + '…' : s;
  }
  function sizeText(b) {
    if (!b && b !== 0) return '';
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1024 / 1024).toFixed(1) + ' MB';
  }

  function describe(cfgKey, r) {
    var meta = '', text = '', tags = [], key = r.id;
    if (cfgKey === 'messages') {
      var who = r.role === 'user' ? '我' : (r.role === 'assistant' ? '小星' : (r.role || '系统'));
      meta = '#' + r.id + ' · ' + who + ' · ' + fmtTime(r.time);
      text = clip(r.content, 220);
      if (r.image) tags.push({ cls: 'img', t: '图片' });
      if (r.audioData) tags.push({ cls: 'aud', t: '语音' });
      if (r.silent) tags.push({ cls: 'sil', t: '沉默消息' });
      if (r.source) tags.push({ cls: '', t: '来源：' + r.source });
    } else if (cfgKey === 'keeps') {
      meta = '#' + r.id + ' · ' + (r.by || '—') + ' · ' + fmtTime(r.createdAt) + (r.status ? ' · ' + r.status : '');
      text = (r.title ? r.title + '\n' : '') + clip(r.content, 220);
      if (r.photo) tags.push({ cls: 'img', t: '照片' });
      if (r.sourceMessageId != null) tags.push({ cls: '', t: '关联消息 #' + r.sourceMessageId });
    } else if (cfgKey === 'starDiaries') {
      meta = '#' + r.id + ' · ' + (r.date || '') + ' · ' + fmtTime(r.createdAt);
      text = (r.title ? r.title + '\n' : '') + clip(r.content, 220);
    } else if (cfgKey === 'futureLetters') {
      meta = '#' + r.id + ' · 开封 ' + (r.openDate || '—') + ' · ' + (r.status || '');
      text = (r.title ? r.title + '\n' : '') + clip(r.content, 220);
      if (r.photo) tags.push({ cls: 'img', t: '照片' });
      if (r.replyMessageId != null) tags.push({ cls: '', t: '关联消息 #' + r.replyMessageId });
    } else if (cfgKey === 'tasks') {
      meta = (r.type === 'event' ? '日程' : '待办') + ' · ' + (r.date || '') + (r.time ? ' ' + r.time : '') + ' · ' + (r.status || '');
      text = r.title || '';
      if (r.note) text += '\n' + clip(r.note, 160);
    } else if (cfgKey === 'transactions') {
      var arrow = r.type === 'income' ? '收入' : '支出';
      meta = (r.date || '') + ' · ' + arrow + ' ¥' + r.amount + ' · ' + (r.category || '');
      text = r.note ? clip(r.note, 200) : '(没有备注)';
    } else if (cfgKey === 'clips') {
      meta = fmtTime(r.createdAt) + ' · ' + sizeText(r.size) + (r.use ? ' · ' + r.use : '');
      text = r.name || '(未命名素材)';
      if (r.blob) tags.push({ cls: 'aud', t: '音频 ' + sizeText(r.size) });
    }
    return { key: key, meta: meta, text: text, tags: tags };
  }

  // 删除前的附加提醒：附件是否随记录一起消失
  function attachWarning(cfgKey, r) {
    if (cfgKey === 'messages') {
      var parts = [];
      if (r.image) parts.push('1 张图片');
      if (r.audioData) parts.push('1 段语音');
      if (parts.length) return '这条消息里的 ' + parts.join(' + ') + ' 只属于它自己，会随消息一起删除，之后无法找回。';
      return '';
    }
    if ((cfgKey === 'keeps' || cfgKey === 'futureLetters') && r.photo) {
      return '这条记录里的照片只属于它自己，会随记录一起删除，之后无法找回。';
    }
    if (cfgKey === 'clips') {
      return '这会删除本地保存的音频文件本身（' + sizeText(r.size) + '），删除后无法恢复。';
    }
    return '';
  }

  // ---------- 列表渲染 ----------
  var state = { cat: 'messages', cache: {}, shown: PAGE_SIZE, filter: '' };

  var el = {};
  function $(id) { return document.getElementById(id); }

  function logLine(kind, text) {
    var box = el.log;
    if (!box) return;
    if (!box.__used) { box.innerHTML = ''; box.__used = true; }
    var d = document.createElement('div');
    d.className = kind;
    d.textContent = '[' + new Date().toLocaleTimeString('zh-CN') + '] ' + text;
    box.insertBefore(d, box.firstChild);
  }

  function loadCat(key, force) {
    var c = cat(key);
    if (!force && state.cache[key]) return Promise.resolve(state.cache[key]);
    return readAll(dbName(c.db), c.store).then(function (list) {
      list.sort(function (a, b) {
        var ta = a.time || a.createdAt || 0, tb = b.time || b.createdAt || 0;
        return tb - ta;
      });
      state.cache[key] = list;
      return list;
    });
  }

  function renderCounts() {
    var box = el.dbStat;
    box.innerHTML = '<span class="pill">正在读取…</span>';
    var jobs = CATS.map(function (c) {
      return countAll(dbName(c.db), c.store).then(function (n) { return { c: c, n: n, ok: true }; })
        .catch(function (e) { return { c: c, n: 0, ok: false, err: e.message }; });
    });
    Promise.all(jobs).then(function (rows) {
      box.innerHTML = '';
      var totals = {};
      rows.forEach(function (r) {
        var pill = document.createElement('span');
        pill.className = 'pill' + (r.ok ? '' : ' bad');
        pill.innerHTML = r.c.label + ' <b>' + (r.ok ? r.n : '—') + '</b>';
        if (!r.ok) pill.title = r.err;
        box.appendChild(pill);
        if (r.ok) totals[r.c.key] = r.n;
      });
      var tabsEl = el.tabs;
      tabsEl.innerHTML = '';
      CATS.forEach(function (c) {
        var b = document.createElement('button');
        b.className = 'tab' + (c.key === state.cat ? ' on' : '');
        b.innerHTML = c.label + '<span class="n">' + (totals[c.key] == null ? '—' : totals[c.key]) + '</span>';
        b.onclick = function () { switchCat(c.key); };
        tabsEl.appendChild(b);
      });
    });
  }

  function matches(cfgKey, r, q) {
    if (!q) return true;
    var d = describe(cfgKey, r);
    var s = (d.meta + ' ' + d.text + ' ' + (r.title || '') + ' ' + (r.content || '') + ' ' + (r.name || '') + ' ' + (r.note || '')).toLowerCase();
    return s.indexOf(q) >= 0;
  }

  function renderList() {
    var cfgKey = state.cat;
    var box = el.list;
    var list = state.cache[cfgKey] || [];
    var q = state.filter.trim().toLowerCase();
    var rows = list.filter(function (r) { return matches(cfgKey, r, q); });

    if (!rows.length) {
      box.innerHTML = '<div class="empty">' + (list.length ? '没有匹配的记录。' : '这个分类里没有记录。') + '</div>';
      return;
    }
    box.innerHTML = '';
    var head = document.createElement('div');
    head.className = 'empty';
    head.style.padding = '0 2px 8px';
    head.textContent = '共 ' + rows.length + ' 条' + (q ? '（已按关键词筛选）' : '') + '，删除前会再次确认。';
    box.appendChild(head);

    rows.slice(0, state.shown).forEach(function (r) {
      var d = describe(cfgKey, r);
      var row = document.createElement('div');
      row.className = 'row';

      var body = document.createElement('div');
      body.className = 'body';
      var meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = d.meta;
      var txt = document.createElement('div');
      txt.className = 'txt';
      txt.textContent = d.text || '(无正文)';
      body.appendChild(meta);
      body.appendChild(txt);

      if (d.tags.length) {
        var tags = document.createElement('div');
        tags.className = 'tags';
        d.tags.forEach(function (t) {
          var sp = document.createElement('span');
          sp.className = 'tag ' + t.cls;
          sp.textContent = t.t;
          tags.appendChild(sp);
        });
        body.appendChild(tags);
      }

      var btn = document.createElement('button');
      btn.className = 'del';
      btn.type = 'button';
      btn.textContent = '删除';
      btn.onclick = function () { askDelete(cfgKey, r); };

      row.appendChild(body);
      row.appendChild(btn);
      box.appendChild(row);
    });

    if (rows.length > state.shown) {
      var more = document.createElement('button');
      more.className = 'more';
      more.textContent = '显示更多（还有 ' + (rows.length - state.shown) + ' 条）';
      more.onclick = function () { state.shown += PAGE_SIZE; renderList(); };
      box.appendChild(more);
    }
  }

  function switchCat(key) {
    state.cat = key;
    state.shown = PAGE_SIZE;
    state.filter = el.q.value || '';
    var tabsEl = el.tabs;
    Array.prototype.forEach.call(tabsEl.children, function (b, i) {
      b.classList.toggle('on', CATS[i].key === key);
    });
    el.list.innerHTML = '<div class="empty">正在读取…</div>';
    loadCat(key, true).then(renderList).catch(function (e) {
      el.list.innerHTML = '';
      var d = document.createElement('div');
      d.className = 'empty err';
      d.textContent = '读取失败：' + e.message;
      el.list.appendChild(d);
    });
  }

  // ---------- 二次确认 + 删除 ----------
  var pending = null;

  function askDelete(cfgKey, rec) {
    var d = describe(cfgKey, rec);
    pending = { cfgKey: cfgKey, rec: rec, key: d.key };
    el.dlgQuote.textContent = (d.text || '(无正文)');
    el.dlgMeta.textContent = d.meta;
    el.dlgErr.hidden = true;
    el.dlgErr.textContent = '';
    el.dlgOk.disabled = false;
    el.dlgOk.textContent = '确认删除';

    var warn = attachWarning(cfgKey, rec);
    el.dlgWarn.hidden = !warn;
    el.dlgWarn.textContent = warn;

    el.dlgRel.hidden = true;
    el.dlgRel.textContent = '';
    el.dlgTitle.textContent = '确认删除这条「' + cat(cfgKey).label + '」记录？';
    el.mask.classList.add('on');

    if (cfgKey === 'messages') {
      el.dlgRel.hidden = false;
      el.dlgRel.textContent = '正在检查关联记录…';
      findRelations(rec.id).then(function (rel) {
        if (!pending || pending.key !== rec.id) return;
        if (!rel.length) {
          el.dlgRel.textContent = '没有找到与这条消息关联的珍藏、未来信、回信或生活记录。';
          return;
        }
        el.dlgRel.textContent = '关联记录：' + rel.map(function (x) { return x.label + ' ' + x.n + ' 条'; }).join('、') +
          '。这些记录不会被删除（' + rel.map(function (x) { return x.hint; }).join('；') + '）。';
      }).catch(function (e) {
        el.dlgRel.textContent = '关联检查失败（不影响删除）：' + e.message;
      });
    }
  }

  function closeDlg() {
    el.mask.classList.remove('on');
    pending = null;
  }

  function doDelete() {
    if (!pending) return;
    var cfgKey = pending.cfgKey, key = pending.key;
    el.dlgOk.disabled = true;
    el.dlgOk.textContent = '正在删除…';
    el.dlgErr.hidden = true;

    deleteRecord(cfgKey, key).then(function () {
      // 本地缓存同步移除，避免刷新前还能看到已删记录
      var list = state.cache[cfgKey] || [];
      state.cache[cfgKey] = list.filter(function (r) { return r.id !== key; });
      closeDlg();
      renderList();
      logLine('ok', '已删除 ' + cat(cfgKey).label + ' #' + key);
      var n = (state.cache[cfgKey] || []).length;
      Array.prototype.forEach.call(el.tabs.children, function (b, i) {
        if (CATS[i].key === cfgKey) {
          var sp = b.querySelector('.n');
          if (sp) sp.textContent = n;
        }
      });
      renderCountsSoon();
    }).catch(function (err) {
      el.dlgOk.disabled = false;
      el.dlgOk.textContent = '确认删除';
      el.dlgErr.hidden = false;
      el.dlgErr.textContent = '删除失败，记录已保留：' + (err && err.message ? err.message : String(err));
      logLine('err', '删除失败（记录已保留）：' + cat(cfgKey).label + ' #' + key + ' — ' + (err && err.message));
    });
  }

  var countsTimer = null;
  function renderCountsSoon() {
    if (countsTimer) return;
    countsTimer = setTimeout(function () { countsTimer = null; renderCounts(); }, 600);
  }

  // ---------- 启动 ----------
  function boot() {
    // 测试专用：允许用 ?suffix=_t 指向隔离库。只接受 _ 开头的小写后缀，正常访问不受影响。
    try {
      var sp = new URLSearchParams(location.search).get('suffix');
      if (sp && /^_[a-z0-9]{1,12}$/.test(sp)) suffix = sp;
    } catch (e) { }
    el = {
      dbStat: $('dbStat'), tabs: $('tabs'), list: $('list'), q: $('q'),
      reload: $('reload'), log: $('log'), mask: $('mask'), dlgTitle: $('dlgTitle'),
      dlgQuote: $('dlgQuote'), dlgMeta: $('dlgMeta'), dlgRel: $('dlgRel'),
      dlgWarn: $('dlgWarn'), dlgErr: $('dlgErr'), dlgOk: $('dlgOk'), dlgCancel: $('dlgCancel'),
    };
    el.dlgCancel.onclick = closeDlg;
    el.dlgOk.onclick = doDelete;

    // 非本地地址：删除会作用在这个站点的数据上，先提醒清楚
    try {
      var host = location.hostname;
      if (host !== '127.0.0.1' && host !== 'localhost' && host !== '') {
        var bar = document.createElement('div');
        bar.className = 'banner';
        bar.style.borderLeftColor = 'var(--danger)';
        bar.style.background = 'rgba(226,104,95,.12)';
        bar.style.color = '#f2c9c5';
        bar.textContent = '当前不是本地地址（' + location.host + '）。删除会直接作用在这个站点的浏览器数据上，请确认这就是你要整理的那一份。';
        document.querySelector('.wrap').insertBefore(bar, document.querySelector('.banner'));
      }
    } catch (e) { }
    el.mask.onclick = function (e) { if (e.target === el.mask) closeDlg(); };
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && pending) closeDlg(); });
    el.reload.onclick = function () {
      state.cache = {};
      renderCounts();
      switchCat(state.cat);
    };
    var qt = null;
    el.q.oninput = function () {
      clearTimeout(qt);
      qt = setTimeout(function () { state.filter = el.q.value; state.shown = PAGE_SIZE; renderList(); }, 180);
    };

    renderCounts();
    switchCat(state.cat);
  }

  // 测试专用：切库名后缀（例如 _t），正常页面永不使用
  function setSuffix(s) {
    suffix = String(s || '');
    state.cache = {};
  }

  window.CleanupTool = {
    setSuffix: setSuffix,
    cats: function () { return CATS.map(function (c) { return c.key; }); },
    list: function (key) { return loadCat(key, true); },
    describe: describe,
    findRelations: findRelations,
    deleteRecord: deleteRecord,
    attachWarning: attachWarning,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
