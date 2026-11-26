/* public/butler/butler-app.js — 生活管家页面交互层 */
import * as core from './butler-core.js';
import { repository as repo } from './butler-repository.js';

const $ = (id) => document.getElementById(id);
const state = {
  taskFilter: 'all',
  editingTaskId: null,
  editingCycleId: null,
  editingCycleEnd: null,   // 编辑前的实际结束日期，用于「清空结束日期」二次确认
  editingTxId: null,
  symptoms: new Set(),
};
const TX_CATS = { expense: ['餐饮', '交通', '购物', '日用', '娱乐', '其他'], income: ['工资', '红包', '理财', '其他'] };
const SYMPTOMS = ['腹痛', '头痛', '胸胀', '腰酸', '情绪低落', '容易烦躁', '疲惫', '食欲变化', '失眠', '恶心'];

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.display = 'none'; }, 2600);
}

function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function recordNode({ title, badge, badgeClass, meta, note, actions = [], cls = '' }) {
  const box = el('article', `record ${cls}`);
  const head = el('div', 'record-head');
  head.appendChild(el('span', 'record-title', title));
  if (badge) head.appendChild(el('span', `badge ${badgeClass || ''}`, badge));
  box.appendChild(head);
  if (meta) box.appendChild(el('div', 'record-meta', meta));
  if (note) box.appendChild(el('div', 'record-note', note));
  if (actions.length) {
    const bar = el('div', 'record-actions');
    for (const a of actions) {
      const b = el('button', '', a.label);
      b.type = 'button';
      b.addEventListener('click', a.onClick);
      bar.appendChild(b);
    }
    box.appendChild(bar);
  }
  return box;
}

/* ---------------- 导航 ---------------- */
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => {
    const active = t.dataset.tab === name;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'today') renderToday();
  if (name === 'tasks') renderTasks();
  if (name === 'sleep') renderSleep();
  if (name === 'cycle') renderCycle();
  if (name === 'tx') renderTx();
  if (name === 'history') renderHistory();
}

/* ---------------- 今日安排 ---------------- */
async function renderToday() {
  const today = core.todayStr();
  $('todayLabel').textContent = `· ${today}`;
  let tasks = [];
  try { tasks = await repo.listTasks(); } catch (e) { toast('读取失败：' + e.message); return; }
  const todays = tasks.filter(t => t.date === today);
  const pending = todays.filter(t => t.status === core.TASK_STATUS.PENDING);
  const done = todays.filter(t => t.status === core.TASK_STATUS.DONE);
  const overdue = tasks.filter(t => t.date < today && t.status === core.TASK_STATUS.PENDING);

  $('todayStats').innerHTML = '';
  [['待处理', pending.length], ['已完成', done.length], ['已逾期', overdue.length]].forEach(([label, n]) => {
    const s = el('div', 'stat');
    s.appendChild(el('b', '', String(n)));
    s.appendChild(el('span', '', label));
    $('todayStats').appendChild(s);
  });

  const list = $('todayList');
  list.innerHTML = '';
  const show = [...overdue.map(t => ({ t, over: true })), ...pending.map(t => ({ t, over: false }))];
  if (!show.length) {
    list.appendChild(el('p', 'empty', todays.length ? '今天的安排都完成了，好好休息一下。' : '今天还没有安排，在上面写一件吧。'));
  } else {
    for (const { t, over } of show) {
      const box = recordNode({
        title: t.title,
        badge: over ? '逾期' : (t.type === 'event' ? '日程' : '待办'),
        badgeClass: over ? 'cancelled' : '',
        meta: `${t.date}${t.time ? ' ' + t.time : ''}${over ? ' · 来自更早的日期' : ''}`,
        note: t.note || '',
        actions: [
          { label: '完成', onClick: async () => { try { await repo.completeTask(t.id); toast('已标记完成'); renderToday(); } catch (e) { toast(e.message); } } },
          { label: '延期到明天', onClick: async () => { try { await repo.deferTask(t.id, { date: core.addDays(core.todayStr(), 1) }); toast('已延期到明天'); renderToday(); } catch (e) { toast(e.message); } } },
        ],
      });
      list.appendChild(box);
    }
  }

  try {
    const sleeps = await repo.listSleep();
    $('todaySleep').textContent = sleeps.length
      ? `${sleeps[0].sleepDate} ${sleeps[0].sleepTime} → ${sleeps[0].date} ${sleeps[0].wakeTime}，共 ${core.formatDuration(sleeps[0].durationMs)}`
      : '还没有睡眠记录。';
    const [p, cycleRows] = await Promise.all([repo.prediction(), repo.listCycles()]);
    const phase = core.cyclePhase(cycleRows);
    const dayNo = phase.ongoing ? core.periodDayNo(phase.ongoing) : null;
    const nowPart = phase.ongoing
      ? (dayNo
        ? `当前经期第 ${dayNo} 天（${phase.ongoing.startDate} 开始，结束日期还没填）`
        : `当前经期记录 ${phase.ongoing.startDate} 开始，结束日期还没填`)
      : '当前没有进行中的经期';
    const predPart = p.ok
      ? `估算下次开始：${p.nextStart.from} ~ ${p.nextStart.to}（基于 ${p.samples} 次记录，只是估算）`
      : p.reason;
    $('todayCycle').textContent = `${nowPart} · ${predPart}`;
  } catch (e) {
    $('todaySleep').textContent = '—';
    $('todayCycle').textContent = '—';
  }
}

/* ---------------- 待办与日程 ---------------- */
function resetTaskForm() {
  state.editingTaskId = null;
  $('taskForm').reset();
  $('tDate').value = core.todayStr();
  $('tSubmit').textContent = '添加事项';
  $('tRemindWrap').style.display = 'none';
}

async function renderTasks() {
  let tasks = [];
  try { tasks = await repo.listTasks(); } catch (e) { toast('读取失败：' + e.message); return; }
  const filtered = tasks.filter(t => state.taskFilter === 'all' ? true : t.status === state.taskFilter);
  const list = $('taskList');
  list.innerHTML = '';
  if (!filtered.length) {
    list.appendChild(el('p', 'empty', state.taskFilter === 'all' ? '还没有事项，用上面的表单添加第一条吧。' : '这个分类下暂时没有事项。'));
    return;
  }
  for (const t of filtered) {
    const statusText = t.status === 'done' ? '已完成' : t.status === 'cancelled' ? '已取消' : t.status === 'done' ? '完成' : '待处理';
    const badgeClass = t.status === 'done' ? 'done' : t.status === 'cancelled' ? 'cancelled' : '';
    const actions = [];
    if (t.status === core.TASK_STATUS.PENDING) {
      actions.push({ label: '完成', onClick: async () => { await repo.completeTask(t.id); renderTasks(); } });
      actions.push({ label: '延期', onClick: () => openDefer(t) });
      actions.push({ label: '取消', onClick: async () => { if (confirm('确定取消这件事吗？')) { await repo.cancelTask(t.id); renderTasks(); } } });
    } else {
      actions.push({ label: '重新打开', onClick: async () => { await repo.reopenTask(t.id); renderTasks(); } });
    }
    actions.push({ label: '编辑', onClick: () => fillTaskForm(t) });
    actions.push({ label: '删除', onClick: async () => { if (confirm('确定永久删除这条记录吗？其历史也会一并删除。')) { await repo.removeTask(t.id); renderTasks(); } } });

    const box = recordNode({
      title: t.title,
      badge: statusText,
      badgeClass,
      meta: `${t.type === 'event' ? '日程' : '待办'} · ${t.date}${t.time ? ' ' + t.time : ''}${t.completedAt ? ' · 完成于 ' + fmtTime(t.completedAt) : ''}`,
      note: t.note || '',
      actions,
      cls: `${t.status === 'done' ? 'done' : ''} ${t.status === 'cancelled' ? 'cancelled' : ''}`,
    });
    if (Array.isArray(t.history) && t.history.length) {
      const last = t.history[t.history.length - 1];
      box.appendChild(el('div', 'record-meta', `最近变更：${last.action} · ${fmtTime(last.at)}`));
    }
    list.appendChild(box);
  }
}

function fillTaskForm(t) {
  state.editingTaskId = t.id;
  $('tTitle').value = t.title;
  $('tType').value = t.type;
  $('tDate').value = t.date;
  $('tTime').value = t.time || '';
  $('tNote').value = t.note || '';
  $('tSubmit').textContent = '保存修改';
  $('tTitle').focus();
  $('view-tasks').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function openDefer(t) {
  const box = el('div', 'record');
  const label = el('div', 'record-meta', `延期「${t.title}」· 当前 ${t.date}${t.time ? ' ' + t.time : ''}`);
  const row = el('div', 'defer-box');
  const date = el('input', 'field');
  date.type = 'date'; date.value = core.addDays(core.todayStr(), 1);
  const time = el('input', 'field');
  time.type = 'time'; time.value = t.time || '';
  const save = el('button', 'small-btn', '保存延期');
  const cancel = el('button', 'small-btn', '取消');
  const wrap = recordNode({ title: '', actions: [] });
  wrap.appendChild(label);
  row.appendChild(date); row.appendChild(time); row.appendChild(save); row.appendChild(cancel);
  wrap.appendChild(row);
  const list = $('taskList');
  list.insertBefore(wrap, list.firstChild);
  save.addEventListener('click', async () => {
    try {
      await repo.deferTask(t.id, { date: date.value, time: time.value });
      toast('已延期（原事项已更新）');
      renderTasks();
    } catch (e) { toast(e.message); }
  });
  cancel.addEventListener('click', () => wrap.remove());
  date.focus();
}

/* ---------------- 作息 ---------------- */
async function renderSleep() {
  let rows = [];
  try { rows = await repo.listSleep(); } catch (e) { toast('读取失败：' + e.message); return; }
  const list = $('sleepList');
  list.innerHTML = '';
  if (!rows.length) { list.appendChild(el('p', 'empty', '还没有作息记录。填入日期与时间点保存即可。')); return; }
  for (const r of rows) {
    const over = r.sleepDate !== r.date ? `（跨午夜，入睡日为 ${r.sleepDate}）` : '';
    const box = recordNode({
      title: `${r.sleepTime} 入睡 → ${r.wakeTime} 起床`,
      badge: core.formatDuration(r.durationMs),
      badgeClass: 'done',
      meta: `起床日期 ${r.date} ${over}`,
      note: r.note || '',
      actions: [
        {
          label: '修改', onClick: () => {
            $('sDate').value = r.date; $('sSleep').value = r.sleepTime;
            $('sWake').value = r.wakeTime; $('sNote').value = r.note || '';
            $('sDate').focus();
          },
        },
        { label: '删除', onClick: async () => { if (confirm('删除这条作息记录？')) { await repo.removeSleep(r.id); renderSleep(); } } },
      ],
    });
    list.appendChild(box);
  }
}

/* ---------------- 周期 ---------------- */
function renderSymptomChips() {
  const box = $('symptomChips');
  box.innerHTML = '';
  for (const s of SYMPTOMS) {
    const b = el('button', state.symptoms.has(s) ? 'active' : '', s);
    b.type = 'button';
    b.addEventListener('click', () => {
      if (state.symptoms.has(s)) state.symptoms.delete(s); else state.symptoms.add(s);
      b.classList.toggle('active');
    });
    box.appendChild(b);
  }
}

function resetCycleForm() {
  state.editingCycleId = null;
  state.editingCycleEnd = null;
  $('cycleForm').reset();
  state.symptoms.clear();
  renderSymptomChips();
  // 默认填今天，只是省一次选择；仍必须由用户自己点「保存记录」才会写入
  $('cStart').value = core.todayStr();
  $('cEnd').value = '';
  $('cSubmit').textContent = '保存记录';
  syncCycleDateLimits();
}

// 实际日期不能晚于今天；结束日期不能早于开始日期。预测日期不走这个表单，因此不受限制。
function syncCycleDateLimits() {
  const today = core.todayStr();
  if ($('cStart')) $('cStart').max = today;
  if ($('cEnd')) {
    $('cEnd').max = today;
    $('cEnd').min = $('cStart').value || '';
  }
}

// 把一条记录装进表单：仅回填已保存的值，绝不预填今天或任何预测日期
function loadCycleIntoForm(r) {
  state.editingCycleId = r.id;
  state.editingCycleEnd = r.endDate || null;
  $('cStart').value = r.startDate;
  $('cEnd').value = r.endDate || '';
  $('cState').value = r.state || '';
  $('cNote').value = r.note || '';
  state.symptoms = new Set(r.symptoms || []);
  renderSymptomChips();
  $('cSubmit').textContent = '保存修改';
  syncCycleDateLimits();
}

/* 「当前经期」区域：只依据真实记录派生，没有进行中的记录就只给「开始经期」入口 */
function renderCurrentCycle(phase) {
  const box = $('cycleCurrent');
  if (!box) return;
  box.innerHTML = '';
  box.appendChild(el('h3', '', '🌷 当前经期'));
  if (phase.ongoing) {
    const dayNo = core.periodDayNo(phase.ongoing);
    box.appendChild(el('div', 'big', `${phase.ongoing.startDate} 开始${dayNo ? ` · 第 ${dayNo} 天` : ''}`));
    box.appendChild(el('p', '', '结束日期还没有填。经期结束后由你自己填实际日期，系统不会自动填，也不会自动判定结束。'));
    const bar = el('div', 'cycle-current-actions');
    const b = el('button', 'primary', '填写结束日期');
    b.type = 'button';
    b.addEventListener('click', () => {
      loadCycleIntoForm(phase.ongoing);     // 结束日期保持空白，不预填今天
      $('cEnd').focus();
      toast('填好实际结束日期后点「保存修改」');
    });
    bar.appendChild(b);
    box.appendChild(bar);
    return;
  }
  box.appendChild(el('p', '', '现在没有进行中的经期。'));
  const bar = el('div', 'cycle-current-actions');
  const b = el('button', 'primary', '开始经期');
  b.type = 'button';
  b.addEventListener('click', () => {
    resetCycleForm();                       // 开始日期预填今天，但不自动保存
    $('cStart').focus();
    toast('确认开始日期后点「保存记录」');
  });
  bar.appendChild(b);
  box.appendChild(bar);
}

async function renderPrediction() {
  const box = $('prediction');
  box.innerHTML = '';
  let p;
  try { p = await repo.prediction(); } catch (e) { box.appendChild(el('p', 'muted', '预测失败：' + e.message)); return; }
  box.appendChild(el('h3', '', '🔮 下次经期估算'));
  if (!p.ok) {
    box.appendChild(el('p', '', p.reason));
    box.appendChild(el('p', 'muted', '估算不会在没有足够历史数据时给出，以免误导你。'));
    return;
  }
  box.appendChild(el('div', 'big', `${p.nextStart.from} ~ ${p.nextStart.to}`));
  box.appendChild(el('p', '', `估算中心日期：${p.nextStart.center} · 参考周期：${p.median} 天 · 样本：${p.samples} 次记录`));
  if (Number.isInteger(p.medianPeriod)) {
    box.appendChild(el('p', '', `参考持续天数：约 ${p.medianPeriod} 天（只统计已填结束日期的记录）`));
  }
  if (Number.isInteger(p.daysFromToday)) {
    box.appendChild(el('p', '', p.daysFromToday >= 0
      ? `距今约 ${p.daysFromToday} 天。`
      : `估算日期已过去 ${Math.abs(p.daysFromToday)} 天，可以补充新记录。`));
  }
  box.appendChild(el('p', 'muted', p.note));
  box.appendChild(el('p', 'muted', '以上都是估算，不会写成实际记录，也不会自动填入结束日期。'));
}

async function renderCycle() {
  await renderPrediction();
  let rows = [];
  try { rows = await repo.listCycles(); } catch (e) { toast('读取失败：' + e.message); return; }
  const phase = core.cyclePhase(rows);
  renderCurrentCycle(phase);

  const list = $('cycleList');
  list.innerHTML = '';
  if (!rows.length) { list.appendChild(el('p', 'empty', '还没有周期记录。可以从最早一次开始日期记起。')); return; }
  for (const r of rows) {
    const isOngoing = !!(phase.ongoing && r.id === phase.ongoing.id);
    const isMissingEnd = !r.endDate && !isOngoing;
    let badge = '已完成';
    let badgeClass = 'pink';
    if (isOngoing) {
      const dayNo = core.periodDayNo(r);
      badge = dayNo ? `进行中 · 第 ${dayNo} 天` : '进行中';
    } else if (isMissingEnd) {
      badge = '未补录结束';
      badgeClass = '';
    } else if (r.periodLengthDays) {
      badge = `已完成 ${r.periodLengthDays} 天`;
    }

    const period = r.endDate
      ? `实际经期 ${r.startDate} ~ ${r.endDate}${r.periodLengthDays ? `，共 ${r.periodLengthDays} 天` : ''}`
      : `实际开始 ${r.startDate}，结束日期未填写（不会自动补）`;
    const meta = `${period} · ${r.cycleLengthDays ? `距上次 ${r.cycleLengthDays} 天` : '首次记录'}`;

    const actions = [
      {
        label: r.endDate ? '修改' : '填写结束日期',
        onClick: () => {
          loadCycleIntoForm(r);
          $('cEnd').focus();
        },
      },
      { label: '删除', onClick: async () => { if (confirm('删除这条周期记录？预测会重新计算。')) { await repo.removeCycle(r.id); renderCycle(); } } },
    ];
    const noteParts = [];
    if (r.symptoms && r.symptoms.length) noteParts.push('症状：' + r.symptoms.join('、'));
    if (r.state) noteParts.push('状态：' + r.state);
    if (r.note) noteParts.push(r.note);
    const box = recordNode({
      title: `${r.startDate} 开始${r.endDate ? ' · ' + r.endDate + ' 结束' : ''}`,
      badge,
      badgeClass,
      meta,
      note: noteParts.join(' · '),
      actions,
    });
    list.appendChild(box);
  }
}

/* ---------------- 记账 ---------------- */
function monthOf(dayStr) { return String(dayStr || '').slice(0, 7); }

function renderTxCategoryOptions() {
  const type = $('xType').value || 'expense';
  const cur = $('xCategory').value;
  $('xCategory').innerHTML = '';
  for (const c of TX_CATS[type]) {
    const o = el('option', '', c);
    o.value = c;
    $('xCategory').appendChild(o);
  }
  if (TX_CATS[type].includes(cur)) $('xCategory').value = cur;
}

function resetTxForm() {
  state.editingTxId = null;
  $('txForm').reset();
  $('xDate').value = core.todayStr();
  $('xSubmit').textContent = '记一笔';
  renderTxCategoryOptions();
}

function fillTxForm(t) {
  state.editingTxId = t.id;
  $('xType').value = t.type;
  renderTxCategoryOptions();
  $('xCategory').value = t.category;
  $('xAmount').value = t.amount;
  $('xDate').value = t.date;
  $('xNote').value = t.note || '';
  $('xSubmit').textContent = '保存修改';
  $('xNote').focus();
}

async function renderTx() {
  const today = core.todayStr();
  const month = monthOf(today);
  const [monthStat, todayStat, allStat, rows] = await Promise.all([
    repo.txStats({ from: month + '-01', to: month + '-31' }),
    repo.txStats({ from: today, to: today }),
    repo.txStats({}), // 全量：账单总额不受本月/今日筛选影响
    repo.listTransactions(),
  ]);

  // 顶部柔和小结条：先给累计总额/收入/支出，再给今日与本月
  $('txStats').innerHTML = '';
  const total = Math.round((allStat.expense + allStat.income) * 100) / 100;
  [['账单总额', total], ['累计支出', allStat.expense], ['累计收入', allStat.income],
    ['今日支出', todayStat.expense], ['本月支出', monthStat.expense], ['本月收入', monthStat.income]].forEach(([label, n]) => {
    const s = el('div', 'stat');
    if (label === '账单总额') s.title = '全部记账金额合计：累计收入 + 累计支出';
    s.appendChild(el('b', '', '¥' + n));
    s.appendChild(el('span', '', label));
    $('txStats').appendChild(s);
  });

  // 本月支出分类条
  const bars = $('txCategoryBars');
  bars.innerHTML = '';
  const entries = Object.entries(monthStat.byCategory).sort((a, b) => b[1] - a[1]);
  if (entries.length) {
    const max = Math.max(...entries.map(e => e[1]), 1);
    for (const [cat, val] of entries) {
      const row = el('div', 'cat-bar');
      row.appendChild(el('span', 'cat-bar-label', cat));
      const track = el('div', 'cat-bar-track');
      const fill = el('div', 'cat-bar-fill');
      fill.style.width = Math.max(8, Math.round((val / max) * 100)) + '%';
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(el('span', 'cat-bar-val', '¥' + val));
      bars.appendChild(row);
    }
  }

  // 记录列表
  const list = $('txList');
  list.innerHTML = '';
  if (!rows.length) {
    list.appendChild(el('p', 'empty', '还没有记账，记下第一笔吧。'));
    return;
  }
  for (const t of rows.slice(0, 60)) {
    const income = t.type === 'income';
    list.appendChild(recordNode({
      title: `${income ? '＋' : '－'} ¥${t.amount}${t.note ? ' · ' + t.note : ''}`,
      badge: income ? '收入' : t.category,
      badgeClass: income ? '' : 'pink',
      meta: `${t.date} · ${income ? t.category : '支出'}`,
      actions: [
        { label: '编辑', onClick: () => fillTxForm(t) },
        { label: '删除', onClick: async () => { if (confirm('确定删除这笔记录吗？')) { try { await repo.removeTransaction(t.id); toast('已删除'); renderTx(); } catch (e) { toast(e.message); } } } },
      ],
    }));
  }
}

/* ---------------- 历史 ---------------- */
async function renderHistory() {
  let rows = [];
  try { rows = await repo.history(200); } catch (e) { toast('读取失败：' + e.message); return; }
  const list = $('historyList');
  list.innerHTML = '';
  if (!rows.length) { list.appendChild(el('p', 'empty', '还没有变更记录。')); return; }
  for (const h of rows) {
    list.appendChild(recordNode({
      title: h.detail,
      badge: h.group,
      meta: fmtTime(h.at),
    }));
  }
}

/* ---------------- 事件 ---------------- */
function bind() {
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  $('quickAddBtn').addEventListener('click', async () => {
    const title = $('quickTitle').value.trim();
    if (!title) { toast('先写点什么吧。'); return; }
    try {
      await repo.addTask({ title, date: core.todayStr(), type: 'todo' });
      $('quickTitle').value = '';
      toast('已记下');
      switchTab('today');
    } catch (e) { toast(e.message); }
  });
  $('quickTitle').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('quickAddBtn').click(); } });

  $('tEnableRemind').addEventListener('change', (e) => {
    $('tRemindWrap').style.display = e.target.checked ? 'flex' : 'none';
  });
  $('tReset').addEventListener('click', () => { resetTaskForm(); toast('已取消编辑'); });
  $('taskForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = {
      title: $('tTitle').value,
      type: $('tType').value,
      date: $('tDate').value,
      time: $('tTime').value,
      note: $('tNote').value,
      remindAt: $('tEnableRemind').checked && $('tRemind').value
        ? new Date($('tRemind').value).getTime() : null,
    };
    try {
      const wasEditing = Boolean(state.editingTaskId);
      if (state.editingTaskId) await repo.updateTask(state.editingTaskId, input);
      else await repo.addTask(input);
      resetTaskForm();
      toast(wasEditing ? '已保存' : '已添加');
      renderTasks();
    } catch (err) { toast(err.message); }
  });
  document.querySelectorAll('[data-task-filter]').forEach(c => c.addEventListener('click', () => {
    state.taskFilter = c.dataset.taskFilter;
    document.querySelectorAll('[data-task-filter]').forEach(x => x.classList.toggle('active', x === c));
    renderTasks();
  }));

  $('sNow').addEventListener('click', () => {
    const d = new Date();
    $('sDate').value = core.todayStr(d);
    $('sWake').value = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  });
  $('sleepForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await repo.saveSleep({ date: $('sDate').value, sleepTime: $('sSleep').value, wakeTime: $('sWake').value, note: $('sNote').value });
      $('sNote').value = '';
      toast('作息已保存');
      renderSleep();
    } catch (err) { toast(err.message); }
  });

  $('cReset').addEventListener('click', () => { resetCycleForm(); toast('已取消编辑'); });
  $('cStart').addEventListener('input', syncCycleDateLimits);
  $('cStart').addEventListener('change', syncCycleDateLimits);
  $('cycleForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = {
      startDate: $('cStart').value,
      endDate: $('cEnd').value || null,
      symptoms: [...state.symptoms],
      state: $('cState').value,
      note: $('cNote').value,
    };
    try {
      if (state.editingCycleId) {
        // 把已记录的结束日期清空，等于把这条改回「进行中」，必须二次确认
        if (state.editingCycleEnd && !input.endDate) {
          if (!confirm(`清空结束日期会把这条记录恢复为「进行中」（原来填的是 ${state.editingCycleEnd}），确定吗？`)) return;
        }
        await repo.updateCycle(state.editingCycleId, input);
      } else {
        const phase = core.cyclePhase(await repo.listCycles());
        // 上一条还没填结束日期时，只提醒，不替用户补、不阻止新增
        if (phase.ongoing && core.compareDay(input.startDate, phase.ongoing.startDate) > 0) {
          if (!confirm(`上一条经期（${phase.ongoing.startDate} 开始）还没有填结束日期，仍然新增一条吗？`)) return;
        }
        await repo.addCycle(input);
      }
      resetCycleForm();
      toast('周期记录已保存');
      renderCycle();
    } catch (err) { toast(err.message); }
  });

  $('xType').addEventListener('change', renderTxCategoryOptions);
  $('xReset').addEventListener('click', () => { resetTxForm(); toast('已取消编辑'); });
  $('txForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = {
      type: $('xType').value,
      amount: $('xAmount').value,
      category: $('xCategory').value,
      date: $('xDate').value,
      note: $('xNote').value,
    };
    const wasEditing = Boolean(state.editingTxId);
    try {
      if (state.editingTxId) await repo.updateTransaction(state.editingTxId, input);
      else await repo.addTransaction(input);
      resetTxForm();
      toast(wasEditing ? '已保存' : '已记下');
      renderTx();
    } catch (err) { toast(err.message); }
  });

  window.addEventListener('butler:change', () => {
    // 跨标签页同步：只刷新当前可见视图，避免打断输入
    const active = document.querySelector('.view.active');
    if (!active) return;
    const map = { 'view-today': renderToday, 'view-tasks': renderTasks, 'view-sleep': renderSleep, 'view-cycle': renderCycle, 'view-tx': renderTx, 'view-history': renderHistory };
    const fn = map[active.id];
    if (fn) fn();
  });
}

async function init() {
  $('tDate').value = core.todayStr();
  $('sDate').value = core.todayStr();
  resetTxForm();
  renderSymptomChips();
  resetCycleForm();
  bind();
  switchTab('today');
  try { await repo.schemaVersion(); } catch (e) { toast('本地数据库初始化失败：' + e.message); }
}

init();
