/* public/migrate.js — 数据迁移页（电脑 → 手机）
 * 只做四件事：导出、校验预览、快照、分阶段导入。所有判断交给 BackupFormat / BackupIO。
 */
(function () {
  'use strict';

  var BF = window.BackupFormat;
  var IO = window.BackupIO;
  if (!BF || !IO) { document.body.innerHTML = '<p style="padding:20px">加载迁移模块失败，请刷新重试。</p>'; return; }

  var $ = function (id) { return document.getElementById(id); };
  var state = {
    exportInfo: null,
    file: null,
    verify: null,
    planInfo: null,
    snapshot: null,
    snapshotConfirmed: false,
    busy: false,
  };

  var STAGE_NAME = { room: '聊天与房间', radio: '声音素材', butler: '生活管家', local: '本地状态' };

  var REASON = {
    'json-parse-failed': '文件不是合法的 JSON',
    'unsupported-version': '不是 v2 备份文件（旧的 v1 请用主页的导入）',
    'missing-integrity': '备份文件缺少完整性信息，无法校验',
    'payload-hash-mismatch': '整体哈希不符，文件已损坏或被改动',
    'counts-mismatch': '数量与声明不一致',
    'attachment-count-mismatch': '附件数量与声明不一致',
    'attachment-bytes-mismatch': '附件字节数与声明不一致',
    'store-hash-mismatch': '某一分区的哈希不符，文件不完整',
    'attachment-broken': '附件损坏，无法解码',
    'attachment-not-packed': '附件未打包，导出不完整',
    'attachment-missing': '有记录声明了附件，但备份里没有附件数据',
    'attachment-invalid': '附件格式异常',
    'attachment-over-hard-limit': '附件总量超过硬上限',
    'collect-problems': '本机有附件读不出来，已中止导出',
    'self-check-failed': '导出后自检未通过，已中止',
    'backup-mismatch': '选的文件与中断时不是同一份',
    'no-journal': '没有可续传的记录',
    'already-done': '上次导入已经完成',
  };

  function reasonText(r) { return REASON[r] || r; }

  function fmtNum(n) { return (n == null ? 0 : n).toLocaleString('zh-CN'); }
  function fmtBytes(n) {
    n = n || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function rows(list) {
    return list.map(function (p) {
      return '<div class="row"><span class="k">' + esc(p[0]) + '</span><span class="v">' + p[1] + '</span></div>';
    }).join('');
  }
  function box(kind, html) {
    return '<div class="box ' + kind + '">' + html + '</div>';
  }
  function shortHash(h) { return h ? h.slice(0, 10) + '…' + h.slice(-6) : '—'; }
  function label() { return /^(127\.0\.0\.1|localhost)$/.test(location.hostname) ? '电脑' : '手机'; }

  function setBusy(on) {
    state.busy = on;
    ['btnExport', 'btnPlan', 'btnSnapshot', 'btnImport', 'btnResume', 'btnUndo'].forEach(function (id) {
      var el = $(id);
      if (el) el.disabled = on || el.dataset.off === '1';
    });
    if (!on) refreshButtons();
  }

  function refreshButtons() {
    $('btnPlan').disabled = state.busy || !state.verify;
    $('btnSnapshot').disabled = state.busy || !state.planInfo;
    $('snapOk').disabled = !state.snapshot;
    $('btnImport').disabled = state.busy || !state.planInfo || !state.snapshot || !state.snapshotConfirmed;
  }

  /* ---------- 1. 本机统计 ---------- */

  async function loadLocalStats() {
    try {
      var col = await IO.collect({ packVoice: false });
      var rep = BF.attachmentReport(col.sections);
      var c = col.counts;
      var html = rows([
        ['聊天消息', fmtNum(c.room.messages) + ' 条'],
        ['珍藏 / 日记 / 星星日记 / 未来信', fmtNum(c.room.keeps) + ' / ' + fmtNum(c.room.diaries) + ' / ' + fmtNum(c.room.starDiaries) + ' / ' + fmtNum(c.room.futureLetters)],
        ['生活管家', '待办 ' + fmtNum(c.butler.tasks) + '，账单 ' + fmtNum(c.butler.transactions) + '，周期 ' + fmtNum(c.butler.cycles) + '，睡眠 ' + fmtNum(c.butler.sleepLogs)],
        ['声音素材', fmtNum(c.radioVoice) + ' 段'],
        ['聊天语音', fmtNum(c.chatVoice) + ' 段（语音消息的原始录音）'],
        ['本地状态', fmtNum(c.localStorage) + ' 项'],
        ['附件', fmtNum(rep.totalCount) + ' 个，' + fmtBytes(rep.totalBytes)],
      ]);
      if (col.problems.length) {
        html += box('err', '<b>有附件读不出来，导出会被中止：</b><ul class="plain">' +
          col.problems.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul>');
      }
      $('exportStats').innerHTML = html;
    } catch (e) {
      $('exportStats').innerHTML = box('err', '读取本机数据失败：' + esc(e.message));
    }
  }

  /* ---------- 2. 导出 ---------- */

  $('btnExport').onclick = async function () {
    if (state.busy) return;
    setBusy(true);
    $('exportOut').innerHTML = box('warnbox', '正在读取并打包（声音素材较大时会慢一些）…<div id="expProg" class="mono"></div>');
    try {
      var r = await IO.exportAll({
        label: label(),
        onProgress: function (p) {
          var el = $('expProg');
          if (el) el.textContent = (p.message || '') + (p.total ? ' ' + p.done + '/' + p.total : '');
        },
      });
      if (!r.ok) {
        $('exportOut').innerHTML = box('err', '<b>导出已中止：' + esc(reasonText(r.reason)) + '</b>' +
          (r.problems ? '<ul class="plain">' + r.problems.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul>' : '') +
          (r.detail && r.detail.at ? '<div class="mono">' + esc(r.detail.at.join('、')) + '</div>' : '') +
          (r.detail && r.detail.totalBytes ? '<div class="mono">附件总计 ' + fmtBytes(r.detail.totalBytes) + '，超过上限 ' + fmtBytes(r.detail.hardAt) + '</div>' : ''));
        setBusy(false);
        return;
      }
      state.exportInfo = r;
      var byKind = Object.keys(r.report.byKind).map(function (k) {
        return '<li>' + esc(k) + '：' + fmtNum(r.report.byKind[k].count) + ' 个，' + fmtBytes(r.report.byKind[k].bytes) + '</li>';
      }).join('');
      var html = box('good', '<b>备份已生成并通过回读校验</b>') + rows([
        ['文件名', esc(r.name)],
        ['文件大小', fmtBytes(r.size)],
        ['记录数', '消息 ' + fmtNum(r.counts.room.messages) + '，珍藏 ' + fmtNum(r.counts.room.keeps) + '，日记 ' + fmtNum(r.counts.room.diaries) + '，未来信 ' + fmtNum(r.counts.room.futureLetters)],
        ['管家', '待办 ' + fmtNum(r.counts.butler.tasks) + '，账单 ' + fmtNum(r.counts.butler.transactions) + '，周期 ' + fmtNum(r.counts.butler.cycles) + '，睡眠 ' + fmtNum(r.counts.butler.sleepLogs)],
        ['附件', fmtNum(r.report.totalCount) + ' 个，' + fmtBytes(r.report.totalBytes)],
        ['本地状态', fmtNum(r.counts.localStorage) + ' 项'],
        ['文件 SHA-256', '<span class="mono">' + esc(r.sha256) + '</span>'],
      ]) + '<ul class="plain">' + byKind + '</ul>';
      if (r.warn) html += box('warnbox', '附件超过 50 MB 提醒线，文件较大，手机上导入可能较慢。');
      if (r.excluded && r.excluded.length) html += '<div class="hint">未迁移：' + esc(r.excluded.join('、')) + '（未发送的草稿，故意不搬）</div>';
      $('exportOut').innerHTML = html;
    } catch (e) {
      $('exportOut').innerHTML = box('err', '导出失败：' + esc(e.message));
    }
    setBusy(false);
  };

  /* ---------- 3. 选文件 + 预览 ---------- */

  $('fileIn').onchange = async function (ev) {
    var f = ev.target.files && ev.target.files[0];
    state.verify = null; state.planInfo = null; state.snapshot = null; state.snapshotConfirmed = false;
    $('snapOk').checked = false;
    $('planOut').innerHTML = ''; $('snapOut').innerHTML = ''; $('importOut').innerHTML = '';
    if (!f) { $('fileOut').innerHTML = ''; refreshButtons(); return; }
    $('fileOut').innerHTML = box('warnbox', '正在校验（' + fmtBytes(f.size) + '）…');
    try {
      var text = await f.text();
      var v = await IO.verifyText(text);
      if (!v.ok) {
        $('fileOut').innerHTML = box('err', '<b>这个文件不能用：' + esc(reasonText(v.reason)) + '</b>' +
          (v.detail ? '<div class="mono">' + esc(JSON.stringify(v.detail).slice(0, 300)) + '</div>' : ''));
        refreshButtons();
        return;
      }
      state.file = v.file;
      state.verify = v;
      var c = v.file.counts;
      var gaps = BF.describeGaps(v.normalized);
      var html = box('good', '<b>文件完整，校验通过</b>') + rows([
        ['导出时间', new Date(v.file.exportedAt).toLocaleString('zh-CN')],
        ['来源', esc(v.file.origin || '未知')],
        ['文件大小', fmtBytes(v.size)],
        ['聊天消息', fmtNum(c.room.messages) + ' 条（含语音 ' + fmtNum(c.audio) + ' 条）'],
        ['珍藏 / 日记 / 星星日记 / 未来信', fmtNum(c.room.keeps) + ' / ' + fmtNum(c.room.diaries) + ' / ' + fmtNum(c.room.starDiaries) + ' / ' + fmtNum(c.room.futureLetters)],
        ['生活管家', '待办 ' + fmtNum(c.butler.tasks) + '，账单 ' + fmtNum(c.butler.transactions) + '，周期 ' + fmtNum(c.butler.cycles) + '，睡眠 ' + fmtNum(c.butler.sleepLogs)],
        ['声音素材', fmtNum(c.radioVoice) + ' 段，' + fmtBytes(c.attachmentBytes)],
        ['聊天语音', fmtNum(c.chatVoice) + ' 段（缺失会导致语音消息只剩文字）'],
        ['本地状态', fmtNum(c.localStorage) + ' 项'],
        ['SHA-256', '<span class="mono">' + esc(v.sha256) + '</span>'],
      ]);
      if (gaps.length) html += box('warnbox', '<b>这份备份里没有：</b><ul class="plain">' + gaps.map(function (g) { return '<li>' + esc(g) + '</li>'; }).join('') + '</ul>');
      if (v.normalized.warnings && v.normalized.warnings.length) {
        html += '<div class="hint">' + v.normalized.warnings.map(esc).join('<br>') + '</div>';
      }
      $('fileOut').innerHTML = html;
    } catch (e) {
      $('fileOut').innerHTML = box('err', '读取文件失败：' + esc(e.message));
    }
    refreshButtons();
  };

  document.querySelectorAll('input[name=mode]').forEach(function (el) {
    el.onchange = function () {
      document.querySelectorAll('.mode').forEach(function (m) { m.classList.toggle('on', m.dataset.mode === el.value); });
      state.planInfo = null;
      $('planOut').innerHTML = '';
      $('btnImport').disabled = true;
      refreshButtons();
    };
  });

  function mode() {
    var el = document.querySelector('input[name=mode]:checked');
    return el ? el.value : 'merge';
  }

  $('btnPlan').onclick = async function () {
    if (state.busy || !state.verify) return;
    setBusy(true);
    $('planOut').innerHTML = box('warnbox', '正在比对手机现有数据…');
    try {
      var info = await IO.planFor(state.file, mode(), { normalized: state.verify.normalized });
      state.planInfo = info;
      var s = info.summary;
      var t = info.targetCounts, b = info.backupCounts;
      var html = rows([
        ['手机现有消息', fmtNum(t.room.messages) + ' 条'],
        ['备份消息', fmtNum(b.room.messages) + ' 条'],
        ['预计新增', fmtNum(s.insert) + ' 条/项'],
        ['内容完全相同、跳过', fmtNum(s.skip) + ' 条/项'],
        ['同 id 但内容不同（分配新 id）', fmtNum(s.conflict) + ' 条/项'],
        ['引用改写', fmtNum(s.remap) + ' 处'],
        ['引用失效（置空）', fmtNum(s.orphan) + ' 处'],
        ['本地状态写入', fmtNum(s.localStorage) + ' 项'],
      ]);
      html += rows([
        ['手机现有珍藏 / 日记 / 星星日记 / 未来信',
          fmtNum(t.room.keeps) + ' / ' + fmtNum(t.room.diaries) + ' / ' + fmtNum(t.room.starDiaries) + ' / ' + fmtNum(t.room.futureLetters)],
        ['手机现有管家 / 声音素材 / 聊天语音',
          '待办 ' + fmtNum(t.butler.tasks) + '，账单 ' + fmtNum(t.butler.transactions) + '，素材 ' + fmtNum(t.radioVoice) + '，语音 ' + fmtNum(t.chatVoice)],
        ['设置与长期记忆', s.kv.length ? s.kv.join('、') + ' 将按备份写入' : '不写入'],
      ]);
      if (s.willClear) html += box('err', '<b>替换模式：导入会先清空手机上的聊天 / 珍藏 / 日记 / 未来信 / 管家 / 声音素材 / 聊天语音。</b>清空前必须先生成手机快照。');
      if (info.targetProblems && info.targetProblems.length) {
        html += box('warnbox', '手机侧有读取异常（不影响导入，但请留意）：<ul class="plain">' +
          info.targetProblems.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul>');
      }
      html += '<div class="mono">计划哈希 ' + esc(shortHash(info.planHash)) + '</div>';
      $('planOut').innerHTML = html;
    } catch (e) {
      state.planInfo = null;
      $('planOut').innerHTML = box('err', '预览失败：' + esc(e.message));
    }
    setBusy(false);
  };

  /* ---------- 4. 手机快照 ---------- */

  $('btnSnapshot').onclick = async function () {
    if (state.busy) return;
    setBusy(true);
    $('snapOut').innerHTML = box('warnbox', '正在生成手机现有数据的快照并回读校验…');
    try {
      var r = await IO.snapshot(label() + '-导入前');
      if (!r.ok) {
        $('snapOut').innerHTML = box('err', '<b>快照生成失败，不能继续导入：' + esc(reasonText(r.reason)) + '</b>');
        setBusy(false);
        return;
      }
      state.snapshot = r;
      $('snapOut').innerHTML = box('good', '<b>手机快照已生成并通过回读校验</b>') + rows([
        ['文件名', esc(r.name)],
        ['大小', fmtBytes(r.size)],
        ['内容', '消息 ' + fmtNum(r.counts.room.messages) + '，珍藏 ' + fmtNum(r.counts.room.keeps) + '，管家待办 ' + fmtNum(r.counts.butler.tasks) + '，素材 ' + fmtNum(r.counts.radioVoice) + '，语音 ' + fmtNum(r.counts.chatVoice)],
        ['SHA-256', '<span class="mono">' + esc(r.sha256) + '</span>'],
      ]);
    } catch (e) {
      $('snapOut').innerHTML = box('err', '快照失败：' + esc(e.message));
    }
    setBusy(false);
  };

  $('snapOk').onchange = function (e) {
    state.snapshotConfirmed = !!e.target.checked;
    refreshButtons();
  };

  /* ---------- 5. 导入 ---------- */

  function stageLine(text, cls) {
    var el = $('progText');
    var div = document.createElement('div');
    div.className = cls || '';
    div.textContent = text;
    el.appendChild(div);
  }

  $('btnImport').onclick = async function () {
    if (state.busy || !state.planInfo || !state.snapshotConfirmed) return;
    setBusy(true);
    $('progWrap').style.display = 'block';
    $('progText').innerHTML = '';
    $('importOut').innerHTML = '';
    $('progBar').style.width = '4%';
    try {
      stageLine('写入前最后校验：附件逐个解码 + 计划哈希…');
      var pre = await IO.preflight(state.file, state.planInfo, {
        onProgress: function (p) { if (p.total) stageLine('校验附件 ' + p.done + '/' + p.total, 'mono'); },
      });
      $('progBar').style.width = '15%';
      stageLine('校验通过，开始分阶段写入');

      var done = 0, total = 4;
      var res = await IO.applyPlan({
        file: state.file,
        planInfo: Object.assign({}, state.planInfo, { plan: pre.plan }),
        mode: state.planInfo.mode,
        onProgress: function (p) {
          if (p.phase === 'start') stageLine(STAGE_NAME[p.stage] + '：开始');
          if (p.phase === 'done') {
            done += 1;
            stageLine(STAGE_NAME[p.stage] + '：完成', 'ok');
            $('progBar').style.width = Math.round(15 + (done / total) * 85) + '%';
          }
          if (p.phase === 'failed') stageLine(STAGE_NAME[p.stage] + '：失败', 'bad');
          if (p.message && p.total && p.stage === 'radio') stageLine('声音素材 ' + p.done + '/' + p.total, 'mono');
        },
      });

      var s = state.planInfo.summary;
      if (res.ok) {
        $('progBar').style.width = '100%';
        $('importOut').innerHTML = box('good', '<b>导入完成</b>') + rows([
          ['实际写入', fmtNum(s.insert) + ' 条/项'],
          ['跳过（已存在/内容相同）', fmtNum(s.skip) + ' 条/项'],
          ['冲突（分配新 id）', fmtNum(s.conflict) + ' 条'],
          ['引用改写 / 失效置空', fmtNum(s.remap) + ' / ' + fmtNum(s.orphan)],
          ['本地状态', fmtNum(s.localStorage) + ' 项'],
          ['异常', '0'],
        ]) + '<div class="hint">现在回到主页刷新，聊天、珍藏、日记、生活管家、电台素材应当都在。</div>';
      } else {
        var errs = res.errors.map(function (e) { return '<li>' + esc(STAGE_NAME[e.stage] || e.stage) + '：' + esc(e.message) + '</li>'; }).join('');
        $('importOut').innerHTML = box('err', '<b>导入中断，已停在失败的阶段，没有继续往后写。</b><ul class="plain">' + errs + '</ul>' +
          '<div class="hint">可以用同一份备份点「继续」，或先「撤销本次导入写入的记录」再用快照恢复。</div>');
        loadJournal();
      }
    } catch (e) {
      $('importOut').innerHTML = box('err', '<b>导入已中止：' + esc(e.message) + '</b><div class="hint">没有写入任何数据，或写入已由日志记录，可重试。</div>');
      loadJournal();
    }
    setBusy(false);
  };

  /* ---------- 6. 恢复日志 ---------- */

  function loadJournal() {
    var j = IO.readJournal();
    var card = $('journalCard');
    if (!j || j.done) { card.style.display = 'none'; return; }
    card.style.display = 'block';
    var lines = Object.keys(j.stages || {}).map(function (k) {
      var st = j.stages[k];
      var txt = (STAGE_NAME[k] || k) + '：' + (st.status === 'done' ? '已提交' : st.status === 'failed' ? '失败（' + esc(st.error || '') + '）' : st.status);
      return '<div>' + txt + '</div>';
    }).join('');
    $('journalOut').innerHTML = '<div class="hint">开始于 ' + new Date(j.startedAt).toLocaleString('zh-CN') +
      '，模式 ' + esc(j.mode) + '，计划 ' + esc(shortHash(j.planHash)) + '</div>' + lines;
  }

  $('btnResume').onclick = async function () {
    if (state.busy) return;
    if (!state.file) { alert('请先在第 2 步选择中断时使用的那份备份文件'); return; }
    setBusy(true);
    $('progWrap').style.display = 'block';
    $('progText').innerHTML = '';
    stageLine('重新计算剩余计划…');
    try {
      var res = await IO.resume(state.file, {
        onProgress: function (p) {
          if (p.phase === 'start') stageLine((STAGE_NAME[p.stage] || p.stage) + '：开始');
          if (p.phase === 'done') stageLine((STAGE_NAME[p.stage] || p.stage) + '：完成', 'ok');
          if (p.phase === 'failed') stageLine((STAGE_NAME[p.stage] || p.stage) + '：失败', 'bad');
        },
      });
      $('importOut').innerHTML = res.ok
        ? box('good', '<b>续传完成</b><div class="hint">回到主页刷新查看。</div>')
        : box('err', '<b>续传中断：' + esc(res.reason ? reasonText(res.reason) : (res.errors && res.errors[0] && res.errors[0].message || '未知')) + '</b>');
      loadJournal();
    } catch (e) {
      $('importOut').innerHTML = box('err', '续传失败：' + esc(e.message));
    }
    setBusy(false);
  };

  $('btnUndo').onclick = async function () {
    if (state.busy) return;
    if (!confirm('只删除本次导入登记过的记录，不恢复被清空的原有数据。继续？')) return;
    setBusy(true);
    try {
      var r = await IO.undo();
      $('journalOut').innerHTML = box(r.ok ? 'good' : 'err', r.ok
        ? '已删除本次写入的 ' + fmtNum(r.removed) + ' 条记录、' + fmtNum(r.localStorageKeys) + ' 项本地状态。'
        : '撤销失败：' + esc(reasonText(r.reason)));
      loadJournal();
    } catch (e) {
      $('journalOut').innerHTML = box('err', '撤销失败：' + esc(e.message));
    }
    setBusy(false);
  };

  /* ---------- 启动 ---------- */

  loadLocalStats();
  loadJournal();
  refreshButtons();
})();
