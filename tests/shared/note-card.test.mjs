/* tests/shared/note-card.test.mjs — 新版「星星的今日便签」规则层
 * 全程本地：假存储 + 纯函数，不碰真实 IndexedDB，不发任何请求，不调用 AI。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import '../../public/shared/note-card.js';

const NC = globalThis.NoteCard;
const K = NC._keys;
const ST = K.ST;

const at = (y, mo, d, h = 9, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const DAY1 = at(2026, 11, 19, 9);
const DAY1_LATE = at(2026, 11, 19, 23, 30);
const DAY2 = at(2026, 11, 20, 9);

/* ---------- 假存储（返回副本，模拟真实读取语义） ---------- */
function fakeStore(rows = []) {
  let seq = 1000;
  const data = rows.map((r) => ({ ...r }));
  return {
    all: () => Promise.resolve(data.map((r) => ({ ...r }))),
    add: (row) => { const id = ++seq; row.id = id; data.push({ ...row }); return Promise.resolve(id); },
    put: (row) => {
      const i = data.findIndex((x) => x.id === row.id);
      if (i === -1) data.push({ ...row }); else data[i] = { ...row };
      return Promise.resolve(true);
    },
    _rows: data,
  };
}

function fresh(now, rows = []) {
  NC._reset();
  const s = fakeStore(rows);
  NC._setStore(s);
  NC._setNow(now);
  return s;
}

const noteOf = (s, date) => s._rows.find((r) => r && r.type === K.TYPE && r.date === date);

/* ---------- N01 每天幂等建一条 ---------- */
test('N01 当天无记录：自动建一条并只补一个星星侧任务，重复载入不重复', async () => {
  const s = fresh(DAY1);
  const r1 = await NC._load();
  assert.equal(r1.created, true);
  assert.equal(s._rows.length, 1);
  const note = s._rows[0];
  assert.equal(note.type, 'note-day');
  assert.equal(note.date, '2026-11-19');
  assert.equal(note.tasks.length, 1);
  assert.equal(note.tasks[0].from, 'star');
  assert.equal(note.tasks[0].status, ST.PENDING);
  assert.equal(note.message.source, 'static');
  assert.equal(note.message.text, K.DEFAULT_TEXT);

  await NC._load();
  await NC._load();
  assert.equal(s._rows.length, 1, '重复载入不得再建一条');
  assert.equal(s._rows[0].tasks.length, 1, '星星侧任务同一天不重复补');
});

test('N01b 并发载入（同时两次）也只建一条', async () => {
  const s = fresh(DAY1);
  await Promise.all([NC._load(), NC._load()]);
  assert.equal(s._rows.length, 1);
});

test('N01c 已有当天记录：不再新建，也不覆盖既有任务', async () => {
  const s = fresh(DAY1, [{
    id: 7, type: 'note-day', date: '2026-11-19', v: 1,
    message: { title: '今天也慢一点。', text: '别硬撑。', source: 'local', at: DAY1, base: { title: K.DEFAULT_TITLE, text: K.DEFAULT_TEXT } },
    tasks: [{ id: 'nt_a', from: 'star', text: '喝水', unit: '次', target: 3, progress: 1, status: ST.ACTIVE, day: '2026-11-19', createdAt: DAY1, updatedAt: DAY1, reply: '' }],
    aiAt: null, createdAt: DAY1, updatedAt: DAY1, archivedAt: null,
  }]);
  const r = await NC._load();
  assert.equal(r.created, false);
  assert.equal(s._rows.length, 1);
  assert.equal(s._rows[0].message.source, 'local');
  assert.equal(s._rows[0].tasks.length, 1);
  assert.equal(s._rows[0].tasks[0].progress, 1);
});

/* ---------- N02 状态机 ---------- */
test('N02 合法转换：接受 / 拒绝 / 延期 / 恢复 / 撤销', () => {
  const base = { id: 'nt_x', from: 'star', text: '喝水', target: 3, progress: 0, status: ST.PENDING, day: '2026-11-19' };

  const accepted = NC._apply(base, 'accept', { now: DAY1, day: '2026-11-19' });
  assert.equal(accepted.status, ST.ACTIVE);
  assert.equal(accepted.acceptedAt, DAY1);
  assert.ok(accepted.reply && accepted.reply.length > 0);

  const declined = NC._apply(accepted, 'decline', { now: DAY1, day: '2026-11-19' });
  assert.equal(declined.status, ST.DECLINED);
  assert.equal(declined.declinedAt, DAY1);

  const postponed = NC._apply(accepted, 'postpone', { now: DAY1, day: '2026-11-19' });
  assert.equal(postponed.status, ST.POSTPONED);

  const resumed = NC._apply(postponed, 'resume', { now: DAY1, day: '2026-11-19' });
  assert.equal(resumed.status, ST.ACTIVE);
  assert.equal(resumed.resumedAt, DAY1);

  const done = NC._apply({ ...accepted, progress: 2 }, 'bump', { now: DAY1, day: '2026-11-19' });
  assert.equal(done.status, ST.DONE);
  const undone = NC._apply(done, 'undo', { now: DAY1_LATE, day: '2026-11-19' });
  assert.equal(undone.status, ST.ACTIVE);
  assert.equal(undone.progress, 2);
  assert.equal(undone.doneAt, undefined);
});

test('N02b 非法转换一律返回 null（界面不动、不写库）', () => {
  const pending = { id: 'nt_y', from: 'star', text: 'x', target: 2, progress: 0, status: ST.PENDING, day: '2026-11-19' };
  const active = { ...pending, status: ST.ACTIVE };
  const done = { ...pending, status: ST.DONE, progress: 2, doneAt: DAY1 };
  const declined = { ...pending, status: ST.DECLINED };

  assert.equal(NC._apply(pending, 'bump'), null, '待接受不能直接计进度');
  assert.equal(NC._apply(pending, 'undo'), null);
  assert.equal(NC._apply(active, 'accept'), null, '进行中不能再接受');
  assert.equal(NC._apply(done, 'bump'), null, '已完成不能再加');
  assert.equal(NC._apply(declined, 'accept'), null, '已拒绝不能复活');
  assert.equal(NC._apply(declined, 'postpone'), null);
  assert.equal(NC._apply(pending, 'unknown'), null);
  assert.equal(NC._apply(null, 'accept'), null);
});

test('N02c 跨天不能恢复，也不能撤销', () => {
  const postponed = { id: 'nt_z', from: 'star', text: 'x', target: 1, progress: 0, status: ST.POSTPONED, day: '2026-11-19' };
  assert.equal(NC._apply(postponed, 'resume', { now: DAY2, day: '2026-11-20' }), null);

  const done = { id: 'nt_w', from: 'star', text: 'x', target: 1, progress: 1, status: ST.DONE, day: '2026-11-19', doneAt: DAY1 };
  assert.equal(NC._apply(done, 'undo', { now: DAY2, day: '2026-11-20' }), null);
});

/* ---------- N03 进度 ---------- */
test('N03 进度 2/3 → 3/3 自动完成，只写最终结果，不记每次完成时间', () => {
  const t = { id: 'nt_p', from: 'star', text: '喝水', unit: '次', target: 3, progress: 1, status: ST.ACTIVE, day: '2026-11-19' };
  const a = NC._apply(t, 'bump', { now: DAY1, day: '2026-11-19' });
  assert.equal(a.status, ST.ACTIVE);
  assert.equal(a.progress, 2);
  assert.equal(a.doneAt, undefined);

  const b = NC._apply(a, 'bump', { now: DAY1, day: '2026-11-19' });
  assert.equal(b.status, ST.DONE);
  assert.equal(b.progress, 3);
  assert.equal(typeof b.doneAt, 'number');

  // 只有一个时间戳，没有任何「每次完成」的时间序列
  const keys = Object.keys(b);
  assert.ok(!keys.some((k) => /times|history|stamps|log/i.test(k)));
  assert.equal(NC._apply(b, 'bump', { now: DAY1, day: '2026-11-19' }), null, '超额点击被拒');
});

test('N03b 目标次数被夹在 1..20', () => {
  assert.equal(NC._newTask({ from: 'star', text: 'a', target: 0 }, DAY1, '2026-11-19').target, 1);
  assert.equal(NC._newTask({ from: 'star', text: 'a', target: 99 }, DAY1, '2026-11-19').target, K.MAX_TARGET);
  assert.equal(NC._newTask({ from: 'star', text: 'a', target: 'abc' }, DAY1, '2026-11-19').target, 1);
});

/* ---------- N04 延期 ---------- */
test('N04 延期不改日期、不复制任务；当天可恢复', () => {
  const t = { id: 'nt_q', from: 'star', text: '早睡', target: 1, progress: 0, status: ST.ACTIVE, day: '2026-11-19' };
  const p = NC._apply(t, 'postpone', { now: DAY1, day: '2026-11-19' });
  assert.equal(p.status, ST.POSTPONED);
  assert.equal(p.day, '2026-11-19', '延期不改归属日');
  assert.equal(p.progress, 0);
  assert.equal(p.postponedAt, DAY1);
});

/* ---------- N05 跨天归档 ---------- */
test('N05 跨天：待接受/进行中 → expired；延期保留 postponed', () => {
  const notes = [{
    id: 1, type: 'note-day', date: '2026-11-18',
    tasks: [
      { id: 'a', from: 'star', text: '1', target: 1, progress: 0, status: ST.PENDING, day: '2026-11-18' },
      { id: 'b', from: 'star', text: '2', target: 3, progress: 1, status: ST.ACTIVE, day: '2026-11-18' },
      { id: 'c', from: 'star', text: '3', target: 1, progress: 0, status: ST.POSTPONED, day: '2026-11-18' },
      { id: 'd', from: 'her', text: '4', target: 1, progress: 1, status: ST.DONE, day: '2026-11-18', doneAt: DAY1 },
      { id: 'e', from: 'her', text: '5', target: 1, progress: 0, status: ST.DECLINED, day: '2026-11-18' },
    ],
  }, {
    id: 2, type: 'note-day', date: '2026-11-19',
    tasks: [{ id: 'f', from: 'star', text: '6', target: 1, progress: 0, status: ST.ACTIVE, day: '2026-11-19' }],
  }];

  const res = NC._rollover(notes, '2026-11-19', DAY2);
  const old = res.notes[0];
  assert.equal(old.tasks[0].status, ST.EXPIRED);
  assert.equal(old.tasks[1].status, ST.EXPIRED);
  assert.equal(old.tasks[2].status, ST.POSTPONED, '延期跨天保留原状态');
  assert.equal(old.tasks[3].status, ST.DONE);
  assert.equal(old.tasks[4].status, ST.DECLINED);
  assert.equal(typeof old.archivedAt, 'number');
  assert.equal(res.notes[1].tasks[0].status, ST.ACTIVE, '当天记录不受归档影响');
  assert.deepEqual(res.changed.map((n) => n.id), [1]);
});

test('N05b 归档后不复制任务到新一天', async () => {
  const s = fresh(DAY1);
  await NC._load();
  const day1TaskId = s._rows[0].tasks[0].id;

  NC._setNow(DAY2);
  await NC._load();
  assert.equal(s._rows.length, 2, '新一天独立建一条，不复制');
  const d1 = noteOf(s, '2026-11-19');
  const d2 = noteOf(s, '2026-11-20');
  assert.equal(d1.tasks[0].status, ST.EXPIRED, '昨天没接受 → 过期');
  assert.equal(d2.tasks.length, 1);
  assert.notEqual(d2.tasks[0].id, day1TaskId, '不是同一条任务被搬过来');
  assert.equal(d2.tasks[0].day, '2026-11-20');
});

test('N05c 昨天延期的任务，跨天后仍显示为延期而不是过期', async () => {
  const day1Note = {
    id: 11, type: 'note-day', date: '2026-11-19',
    message: { title: 't', text: 'x', source: 'static', at: DAY1, base: { title: 't', text: 'x' } },
    tasks: [{ id: 'nt_post', from: 'star', text: '早睡', unit: '', target: 1, progress: 0, status: ST.ACTIVE, day: '2026-11-19', createdAt: DAY1, updatedAt: DAY1, reply: '' }],
    aiAt: null, createdAt: DAY1, updatedAt: DAY1, archivedAt: null,
  };
  const s = fresh(DAY1, [day1Note]);
  await NC._load();
  await NC.doTask('nt_post', 'postpone');
  assert.equal(s._rows[0].tasks[0].status, ST.POSTPONED);

  NC._setNow(DAY2);
  await NC._load();
  assert.equal(noteOf(s, '2026-11-19').tasks[0].status, ST.POSTPONED);
});

/* ---------- N06 历史 ---------- */
test('N06 历史按日期倒序、不含今天、最多 14 天', () => {
  const rows = [];
  for (let i = 1; i <= 20; i++) {
    const d = new Date(2026, 10, 19 - i);
    const date = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    rows.push({ id: 100 + i, type: 'note-day', date, tasks: [] });
  }
  rows.push({ id: 999, type: 'note-day', date: '2026-11-19', tasks: [] });
  NC._reset();
  NC._setNow(DAY1);
  const list = NC._history(rows);
  assert.equal(list.length, K.HISTORY_DAYS);
  assert.equal(list[0].date, '2026-11-18');
  assert.ok(list.every((n) => n.date < '2026-11-19'), '历史不含今天');
  for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].date > list[i].date, '严格倒序');
  assert.equal(K.HISTORY_SHOW, 7);
});

/* ---------- N07 与邮局日记的隔离 ---------- */
test('N07 隔离只认 type === note-day，旧记录（无 type）保持今日来信行为', () => {
  assert.equal(NC._keys.TYPE, 'note-day');
  assert.equal(NC._apply.length > 0, true);
  // 仅供渲染层判定的语义：type 精确等于 note-day 才是便签
  const notes = [{ type: 'note-day' }, { type: 'today-letter' }, { }];
  assert.equal(notes.filter((n) => n && n.type === 'note-day').length, 1);
});

test('N07b app.js：renderDiaries 在算摘要之前排除 note-day，且用的是精确判断', () => {
  const APP = fs.readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8');
  const start = APP.indexOf('async function renderDiaries()');
  const end = APP.indexOf('let isWritingStarDiary');
  assert.ok(start > -1 && end > start, 'renderDiaries 结构变化，需同步本测试');
  const body = APP.slice(start, end);

  const filterAt = body.indexOf("r.type === 'note-day'");
  const cacheAt = body.indexOf('diarySummaryCache =');
  assert.ok(filterAt > -1, 'renderDiaries 必须过滤 note-day');
  assert.ok(cacheAt > -1, 'diarySummaryCache 必须仍在 renderDiaries 内');
  assert.ok(filterAt < cacheAt, '过滤必须在摘要之前，否则便签会污染日记摘要');
  assert.ok(!/type\s*!==\s*['"]note-day['"]/.test(body), '不得使用反选判断（旧记录没有 type）');
  assert.ok(!/type\s*!==\s*['"]today-letter['"]/.test(body), '不得用 today-letter 反选');
});

/* ---------- N08 AI 摘要 ---------- */
test('N08 aiLine：无任务返回空、只含今天与昨天、明确单向关系并带任务内容', () => {
  assert.equal(NC._aiLine(null, null), '');
  assert.equal(NC._aiLine({ tasks: [] }, null), '');

  const today = {
    date: '2026-11-19',
    tasks: [
      { from: 'star', text: '喝水', target: 3, progress: 2, status: ST.ACTIVE },
      { from: 'star', text: '早睡', target: 1, progress: 1, status: ST.DONE },
      { from: 'star', text: '走两步', target: 1, progress: 0, status: ST.PENDING },
      { from: 'her', text: '倒水', target: 1, progress: 0, status: ST.ACTIVE },
    ],
  };
  const prev = { date: '2026-11-18', tasks: [{ from: 'star', status: ST.DONE }, { from: 'star', status: ST.EXPIRED }] };
  const line = NC._aiLine(today, prev);
  assert.ok(line.length > 0 && line.length <= K.AI_LINE_MAX, '长度 ' + line.length);
  assert.match(line, /今天/);
  assert.match(line, /昨天/);
  // 她问「今天给我安排了什么」时，模型必须能看到真实任务内容
  assert.ok(line.includes('喝水') && line.includes('2/3'), line);
  assert.ok(line.includes('早睡') && line.includes('走两步'), line);
  assert.ok(!line.includes('倒水'), '历史遗留的她发起任务不进上下文');
  // 关系写死：星星发起、用户执行，不算违约
  assert.match(line, /你给用户安排/);
  assert.match(line, /不是她自己的待办/);
  assert.match(line, /不替她执行/);
  assert.match(line, /不算违约/);
});

test('N08b aiLine 超长时仍不超上限，且关系说明不被截掉', () => {
  const many = { date: '2026-11-19', tasks: new Array(20).fill({ from: 'star', text: '很长很长的小事', status: ST.ACTIVE, target: 3, progress: 1 }) };
  const line = NC._aiLine(many, { tasks: new Array(20).fill({ from: 'star', status: ST.DONE }) });
  assert.ok(line.length <= K.AI_LINE_MAX, '长度 ' + line.length);
  assert.match(line, /不是她自己的待办/);
  assert.match(line, /不算违约/);
});

/* ---------- N09 反馈文案 ---------- */
test('N09 只有星星侧 7 组反馈池，每个动作都能得到非空回应', () => {
  const actions = ['accept', 'bump', 'done', 'decline', 'postpone', 'resume', 'undo'];
  const pools = NC._pools;
  assert.deepEqual(Object.keys(pools).sort(), actions.map((a) => 'star:' + a).sort(), '不得保留她发起任务的专属回应');
  actions.forEach((a) => {
    const key = 'star:' + a;
    assert.ok(Array.isArray(pools[key]) && pools[key].length >= 3, key + ' 至少 3 条变体');
    pools[key].forEach((s) => assert.ok(typeof s === 'string' && s.trim().length > 0, key + ' 不得有空串'));
  });

  // 通过状态机触发，确认落到任务上的 reply 非空
  const t = { id: 'nt_r', from: 'star', text: '倒水', target: 2, progress: 0, status: ST.PENDING, day: '2026-11-19' };
  const a = NC._apply(t, 'accept', { now: DAY1, day: '2026-11-19' });
  assert.ok(a.reply.length > 0);
  const b = NC._apply(a, 'bump', { now: DAY1, day: '2026-11-19' });
  assert.ok(b.reply.length > 0);
  const c = NC._apply(b, 'bump', { now: DAY1, day: '2026-11-19' });
  assert.equal(c.status, ST.DONE);
  assert.ok(c.reply.length > 0);
});

/* ---------- 单向任务：只有小星发起 ---------- */
test('N10 单向模式：不再提供「给星星留一件事」入口，也不接收 her 发起方', async () => {
  const s = fresh(DAY1);
  await NC._load();
  assert.equal(typeof NC.addTask, 'undefined', '不得再暴露创建任务的 API');
  assert.equal(NC.note.tasks.length, 1);
  assert.equal(NC.note.tasks[0].from, 'star');

  const forced = NC._newTask({ from: 'her', text: '倒一杯水', target: 2 }, DAY1, '2026-11-19');
  assert.equal(forced.from, 'star', '即使外部传 her，也强制为星星发起');

  const SRC = fs.readFileSync(new URL('../../public/shared/note-card.js', import.meta.url), 'utf8');
  assert.ok(!/add-open|add-save|add-cancel|给星星留一件事|想让他做什么/.test(SRC), '用户布置任务的入口/交互必须彻底移除');
});

test('N10b 星星安排的任务：接受、进度、完成、拒绝、延期全程可用且不重复写入', async () => {
  const s = fresh(DAY1);
  await NC._load();
  const t = NC.note.tasks[0];
  const countBefore = s._rows[0].tasks.length;

  await NC.doTask(t.id, 'accept');
  assert.equal(s._rows[0].tasks[0].status, ST.ACTIVE);

  await NC.doTask(t.id, 'postpone');
  assert.equal(s._rows[0].tasks[0].status, ST.POSTPONED);
  await NC.doTask(t.id, 'resume');
  assert.equal(s._rows[0].tasks[0].status, ST.ACTIVE);

  for (let i = 0; i < t.target; i++) await NC.doTask(t.id, 'bump');
  const done = s._rows[0].tasks[0];
  assert.equal(done.status, ST.DONE);
  assert.ok(done.reply.length > 0);
  assert.equal(s._rows[0].tasks.length, countBefore, '不新增任务行');
});

test('N10e 历史遗留 her 行只保留只读展示，不进 AI 上下文', () => {
  const legacy = { from: 'her', text: '旧任务', target: 1, progress: 1, status: ST.DONE };
  const line = NC._aiLine({ tasks: [legacy] }, null);
  assert.equal(line, '', '只有历史遗留 her 任务时不注入便签上下文');
  const mixed = NC._aiLine({ tasks: [legacy, { from: 'star', text: '喝水', target: 1, status: ST.PENDING }] }, null);
  assert.ok(!mixed.includes('旧任务'));
  assert.ok(mixed.includes('喝水'));
});

test('N10c 完成任务会写一条 LifeEvents（复用现有事件层，不自己派发事件）', async () => {
  fresh(DAY1);
  await NC._load();
  const seen = [];
  const prevLE = globalThis.LifeEvents;
  globalThis.LifeEvents = { record: (ev) => { seen.push(ev); return { ok: true, added: true }; } };
  try {
    const t = NC.note.tasks[0];
    await NC.doTask(t.id, 'accept');
    for (let i = 0; i < t.target; i++) await NC.doTask(t.id, 'bump');
    assert.equal(seen.length, 1, '只在真正完成时记一条');
    assert.equal(seen[0].type, 'task.done');
    assert.equal(seen[0].source, 'room');
    assert.equal(seen[0].id, 'room:note-task:' + t.id);
  } finally {
    if (prevLE === undefined) delete globalThis.LifeEvents; else globalThis.LifeEvents = prevLE;
  }
});

test('N10d 拒绝单次动作只生效一次（非法转换不写库）', async () => {
  const s = fresh(DAY1);
  await NC._load();
  const t = s._rows[0].tasks[0];
  await NC.doTask(t.id, 'accept');
  const before = JSON.stringify(s._rows[0].tasks[0]);
  await NC.doTask(t.id, 'accept');   // 已 active，不能再接受
  assert.equal(JSON.stringify(s._rows[0].tasks[0]), before, '非法动作不得改数据');
});

/* ---------- 本地留言与 AI 入口 ---------- */
test('N11 本地留言非空，且「让星星说一句」失败时回落本地文案、每天只占一次', async () => {
  const s = fresh(DAY1);
  await NC._load();
  assert.ok(NC._localMessage(NC.note, DAY1).length > 0);

  let calls = 0;
  const prev = globalThis.callAI;
  globalThis.callAI = () => { calls++; return Promise.reject(new Error('offline')); };
  try {
    await NC._askStar();
    assert.equal(calls, 1);
    assert.equal(s._rows[0].aiAt, DAY1);
    assert.equal(s._rows[0].message.source, 'local', '失败回落本地');
    assert.ok(s._rows[0].message.text.length > 0);

    await NC._askStar();
    assert.equal(calls, 1, '一天最多一次，不得重试');
  } finally {
    if (prev === undefined) delete globalThis.callAI; else globalThis.callAI = prev;
  }
});

test('N11b AI 成功时写入 ai 来源的留言，并保留静态原文兜底', async () => {
  const s = fresh(DAY1);
  await NC._load();
  const prev = globalThis.callAI;
  globalThis.callAI = () => Promise.resolve('今天也慢一点。||| Take it slow today.');
  try {
    await NC._askStar();
  } finally {
    if (prev === undefined) delete globalThis.callAI; else globalThis.callAI = prev;
  }
  const msg = s._rows[0].message;
  assert.equal(msg.source, 'ai');
  assert.equal(msg.text, '今天也慢一点。', '剥掉双语分隔符');
  assert.equal(msg.base.text, K.DEFAULT_TEXT, '静态原文保留为兜底');
});

/* ---------- 默认不碰 AI / 不自己造事件 ---------- */
test('N12 日常操作全程不调用 AI，只有点入口才发一次', async () => {
  fresh(DAY1);
  let calls = 0;
  const prev = globalThis.callAI;
  globalThis.callAI = () => { calls++; return Promise.resolve('x ||| y'); };
  try {
    await NC._load();
    const star = NC.note.tasks.find((t) => t.from === 'star');
    await NC.doTask(star.id, 'accept');
    await NC.doTask(star.id, 'postpone');
    await NC.doTask(star.id, 'resume');
    await NC.doTask(star.id, 'decline');
    await NC._load();                            // 相当于刷新
    assert.equal(calls, 0, '载入/建条/改状态都不得调用 AI');
  } finally {
    if (prev === undefined) delete globalThis.callAI; else globalThis.callAI = prev;
  }
});

test('N12b 模块不自己发请求、不自己派发事件（复用 LifeEvents 内部通知）', () => {
  const SRC = fs.readFileSync(new URL('../../public/shared/note-card.js', import.meta.url), 'utf8');
  assert.ok(!/\bfetch\s*\(/.test(SRC), '不得发起 fetch 请求');
  assert.ok(!/XMLHttpRequest/.test(SRC), '不得使用 XHR');
  assert.ok(!/dispatchEvent/.test(SRC), '不得自己派发事件：完成通知交给 LifeEvents.record（其内部派发 life:feed）');
  assert.ok(!/setInterval|setTimeout/.test(SRC), '不得新增轮询/定时器');
  assert.ok(/LifeEvents/.test(SRC), '必须复用现有生活事件层');
  const callCount = (SRC.match(/root\.callAI/g) || []).length;
  assert.ok(callCount <= 2, 'AI 调用点只允许集中在 askStar 内');
});

/* ---------- 聊天 system 上下文：关系必须明确 ---------- */
test('N13 app.js 主聊上下文明确单向任务关系，不让模型执行便签任务', () => {
  const APP = fs.readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8');
  const a = APP.indexOf('// 今日便签：只读模块缓存');
  const b = APP.indexOf('// P4：只有她确实在问某类生活事实时才本地读一次');
  assert.ok(a > -1 && b > a, 'notePart 组装位置变了，需同步本测试');
  const block = APP.slice(a, b);
  assert.match(block, /便签里的小事全部是你（小星）主动安排给用户的/);
  assert.match(block, /不是用户给自己列的待办/);
  assert.match(block, /不要替她执行/);
  assert.match(block, /都不算违约/);
  assert.match(block, /今天给我安排了什么/);
  assert.match(block, /NoteCard\.aiLine\(\)/);
  assert.ok(!/给星星留一件事/.test(APP), '主聊不得引导用户给星星布置任务');
});
