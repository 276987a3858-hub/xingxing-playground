/* tests/butler/cycles-open.test.mjs
 * 经期「进行中 / 未补录结束 / 已完成」三态：开始结束分开记、不自动填结束、
 * 日期上下限、撤销结束的历史、预测不落库、旧记录兼容、备份 round-trip。
 * 全部为本地纯逻辑 + 内存 adapter，不发任何网络请求。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRepository } from '../../public/butler/butler-repository.js';
import * as core from '../../public/butler/butler-core.js';
import { createMemoryAdapter } from './memory-adapter.mjs';
import '../../public/shared/backup-format.js';

const BF = globalThis.BackupFormat;
const TODAY = core.todayStr();

function makeRepo() {
  const backing = {};
  return { repo: createRepository(createMemoryAdapter(backing)), backing };
}

const emptySections = () => ({
  room: { kv: {}, messages: [], keeps: [], diaries: [], starDiaries: [], futureLetters: [] },
  butler: { tasks: [], transactions: [], cycles: [], sleepLogs: [], meta: [] },
  localStorage: {},
  radioVoice: { clips: [] },
});

test('O01 只填开始日期：endDate 保持 null，并识别为进行中', async () => {
  const { repo, backing } = makeRepo();
  const start = core.addDays(TODAY, -2);
  const c = await repo.addCycle({ startDate: start });
  assert.equal(c.endDate, null, '不能自动填结束日期');
  assert.equal(backing.cycles.get(c.id).endDate, null, '落库的也必须是 null');

  const phase = core.cyclePhase(await repo.listCycles());
  assert.equal(phase.ongoing.id, c.id);
  assert.equal(phase.missingEnd.length, 0);
  assert.equal(phase.closed.length, 0);
  assert.equal(core.periodDayNo(phase.ongoing), 3, '开始当天算第 1 天');
});

test('O02 补录实际结束日期后转为已完成，并保留历史变更', async () => {
  const { repo } = makeRepo();
  const start = core.addDays(TODAY, -9);
  const end = core.addDays(TODAY, -5);
  const c = await repo.addCycle({ startDate: start });
  const up = await repo.updateCycle(c.id, { endDate: end });

  assert.equal(up.endDate, end);
  assert.match(up.history.at(-1).detail, /补充结束日期/);

  const rows = await repo.listCycles();
  const phase = core.cyclePhase(rows);
  assert.equal(phase.ongoing, null, '有结束日期就不算进行中');
  assert.equal(phase.closed.length, 1);
  assert.equal(phase.closed[0].periodLengthDays, 5);

  const hist = await repo.history();
  assert.ok(hist.some(h => h.group === '周期' && /补充结束日期/.test(h.detail)));
});

test('O03 撤销结束日期后恢复进行中，history 写明撤销', async () => {
  const { repo } = makeRepo();
  const c = await repo.addCycle({ startDate: core.addDays(TODAY, -8), endDate: core.addDays(TODAY, -6) });
  const back = await repo.updateCycle(c.id, { endDate: null });

  assert.equal(back.endDate, null);
  assert.equal(back.history.at(-1).action, 'updated');
  assert.match(back.history.at(-1).detail, /撤销结束日期/);
  assert.match(back.history.at(-1).detail, /恢复为进行中/);

  const phase = core.cyclePhase(await repo.listCycles());
  assert.equal(phase.ongoing.id, c.id);
  assert.equal(phase.closed.length, 0);
});

test('O04 多条未结束：只有最新一条是进行中，其余为未补录结束，且都不自动补日期', async () => {
  const { repo, backing } = makeRepo();
  const closed = await repo.addCycle({ startDate: core.addDays(TODAY, -90), endDate: core.addDays(TODAY, -85) });
  const openEarly = await repo.addCycle({ startDate: core.addDays(TODAY, -40) });
  const openLatest = await repo.addCycle({ startDate: core.addDays(TODAY, -10) });

  let phase = core.cyclePhase(await repo.listCycles());
  assert.equal(phase.ongoing.id, openLatest.id);
  assert.deepEqual(phase.missingEnd.map(r => r.id), [openEarly.id]);
  assert.deepEqual(phase.closed.map(r => r.id), [closed.id]);
  assert.equal(backing.cycles.get(openEarly.id).endDate, null, '旧的未结束记录不能被自动补日期');
  assert.equal(backing.cycles.get(openLatest.id).endDate, null);

  // 最新一条结束后，就没有「进行中」了；更早那条仍是未补录结束
  await repo.updateCycle(openLatest.id, { endDate: core.addDays(TODAY, -6) });
  phase = core.cyclePhase(await repo.listCycles());
  assert.equal(phase.ongoing, null);
  assert.deepEqual(phase.missingEnd.map(r => r.id), [openEarly.id]);
});

test('O05 经期天数：开始当天为第 1 天，未来开始日期不编造天数', () => {
  assert.equal(core.periodDayNo({ startDate: TODAY }, TODAY), 1);
  assert.equal(core.periodDayNo({ startDate: core.addDays(TODAY, -1) }, TODAY), 2);
  assert.equal(core.periodDayNo({ startDate: core.addDays(TODAY, 1) }, TODAY), null);
  assert.equal(core.periodDayNo({ startDate: '2023-02-29' }, TODAY), null);
});

test('O06 实际日期不能晚于今天（新增与编辑都限制），预测不受限制', async () => {
  const { repo } = makeRepo();
  const tomorrow = core.addDays(TODAY, 1);

  await assert.rejects(() => repo.addCycle({ startDate: tomorrow }), /开始日期不能晚于今天/);
  await assert.rejects(() => repo.addCycle({ startDate: TODAY, endDate: tomorrow }), /结束日期不能晚于今天/);

  const c = await repo.addCycle({ startDate: core.addDays(TODAY, -6) });
  await assert.rejects(() => repo.updateCycle(c.id, { startDate: tomorrow }), /开始日期不能晚于今天/);
  await assert.rejects(() => repo.updateCycle(c.id, { endDate: tomorrow }), /结束日期不能晚于今天/);

  // 预测是纯计算，可以落在未来，而且不会写入记录
  const cycles = [
    { startDate: core.addDays(TODAY, -62) },
    { startDate: core.addDays(TODAY, -31) },
    { startDate: TODAY },
  ];
  const p = core.predictCycle(cycles, TODAY);
  assert.equal(p.ok, true);
  assert.ok(core.compareDay(p.nextStart.center, TODAY) > 0, '预测日期可以晚于今天');
  assert.equal((await repo.listCycles()).length, 1, '预测没有新增记录');
});

test('O07 结束日期早于开始日期时拒绝', async () => {
  const { repo } = makeRepo();
  await assert.rejects(
    () => repo.addCycle({ startDate: core.addDays(TODAY, -5), endDate: core.addDays(TODAY, -6) }),
    /结束日期不能早于开始日期/,
  );
  const c = await repo.addCycle({ startDate: core.addDays(TODAY, -5) });
  await assert.rejects(
    () => repo.updateCycle(c.id, { endDate: core.addDays(TODAY, -7) }),
    /结束日期不能早于开始日期/,
  );
});

test('O08 旧记录（没有新增字段）读取、补录都正常', async () => {
  const { repo, backing } = makeRepo();
  // 模拟旧版本写入的最小记录：没有 v / history / symptoms / state / note
  backing.cycles.set('old_closed', { id: 'old_closed', startDate: '2026-08-01', endDate: '2026-08-05', createdAt: 1 });
  backing.cycles.set('old_open', { id: 'old_open', startDate: '2026-09-01', endDate: null, createdAt: 2 });

  const rows = await repo.listCycles();
  assert.equal(rows.length, 2);
  assert.equal(rows.find(r => r.id === 'old_closed').periodLengthDays, 5);
  assert.equal(rows.find(r => r.id === 'old_open').periodLengthDays, null);

  const phase = core.cyclePhase(rows);
  assert.equal(phase.ongoing.id, 'old_open');
  assert.equal(phase.closed.length, 1);

  const up = await repo.updateCycle('old_open', { endDate: '2026-09-06' });
  assert.equal(up.endDate, '2026-09-06');
  assert.equal(up.history.length, 1, '旧记录没有 history 时能补出第一条');
});

test('O09 预测前后 cycles store 完全一致（证明预测不写库）', async () => {
  const { repo, backing } = makeRepo();
  await repo.addCycle({ startDate: core.addDays(TODAY, -62), endDate: core.addDays(TODAY, -57) });
  await repo.addCycle({ startDate: core.addDays(TODAY, -31), endDate: core.addDays(TODAY, -26) });
  const last = await repo.addCycle({ startDate: TODAY });

  const snapshot = () => JSON.stringify([...backing.cycles.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  const before = snapshot();
  const p = await repo.prediction();
  await repo.listCycles();
  const after = snapshot();

  assert.equal(p.ok, true);
  assert.equal(before, after, '预测与列表读取都不能修改 cycles store');
  assert.equal(backing.cycles.get(last.id).endDate, null);
});

test('O10 备份 round-trip 后实际开始/结束日期完整保留', async () => {
  const closed = { id: 'c_closed', startDate: '2026-08-01', endDate: '2026-08-05', createdAt: 1, history: [], v: 1 };
  const open = { id: 'c_open', startDate: '2026-09-01', endDate: null, createdAt: 2, history: [], v: 1 };
  const file = {
    format: 'ylxh-backup', version: 2, minApp: '2.1', exportedAt: 1, origin: 'test', device: 'desktop',
    profile: { includeAudio: false },
    star_fifi_room: { kv: { settings: {}, longTermMemory: '' }, messages: [], keeps: [], diaries: [], starDiaries: [], futureLetters: [] },
    star_butler_v1: { tasks: [], transactions: [], cycles: [closed, open], sleepLogs: [], meta: [] },
    radio_voice: { clips: [] },
    localStorage: {},
  };

  const norm = BF.normalizeBackup(file);
  assert.deepEqual(norm.sections.butler.cycles, [closed, open], '规范化不能丢日期或把 null 改成日期');

  const plan = BF.buildPlan({ mode: 'replace', target: emptySections(), backup: norm.sections });
  assert.equal(plan.butler.cycles.clear, true);
  assert.deepEqual(
    plan.butler.cycles.inserts.map(r => [r.id, r.startDate, r.endDate]),
    [['c_closed', '2026-08-01', '2026-08-05'], ['c_open', '2026-09-01', null]],
  );

  // 按导入计划写回后，仍是同样的实际日期
  const A = createMemoryAdapter({});
  for (const r of plan.butler.cycles.inserts) await A.put('cycles', r);
  const back = await A.getAll('cycles');
  const restoredOpen = back.find(r => r.id === 'c_open');
  assert.equal(restoredOpen.endDate, null, '未结束的不能在恢复时被补成日期');
  assert.equal(back.find(r => r.id === 'c_closed').endDate, '2026-08-05');
  assert.equal(core.cyclePhase(back).ongoing.id, 'c_open');
});
