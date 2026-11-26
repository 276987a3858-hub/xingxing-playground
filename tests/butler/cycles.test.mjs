/* tests/butler/cycles.test.mjs
 * 月经周期模块：开始/结束/补录/修改/删除、长度、预测样本量、跨月跨年闰年、隐私本地性
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRepository } from '../../public/butler/butler-repository.js';
import { predictCycle, cyclesWithLengths, validateCycle, parseDay, diffDays, addDays } from '../../public/butler/butler-core.js';
import { createMemoryAdapter } from './memory-adapter.mjs';

function makeRepo() {
  const backing = {};
  return {
    repo: createRepository(createMemoryAdapter(backing)),
    backing,
    newConnection: () => createRepository(createMemoryAdapter(backing)),
  };
}

test('C01 日期工具：跨月/跨年/闰年', async () => {
  assert.equal(diffDays('2024-02-28', '2024-03-01'), 2, '闰年 2 月有 29 天');
  assert.equal(diffDays('2023-02-28', '2023-03-01'), 1);
  assert.equal(diffDays('2024-12-31', '2025-01-01'), 1);
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2023-02-28', 1), '2023-03-01');
  assert.equal(parseDay('2023-02-29'), null, '平年不存在 2/29');
});

test('C02 记录开始日期（不带结束日期）', async () => {
  const { repo } = makeRepo();
  const c = await repo.addCycle({ startDate: '2026-09-01', symptoms: ['腹痛'], state: '疲惫', note: '第一天' });
  assert.equal(c.endDate, null);
  assert.deepEqual(c.symptoms, ['腹痛']);
  assert.equal((await repo.listCycles()).length, 1);
});

test('C03 补录历史经期 + 之后补充结束日期', async () => {
  const { repo } = makeRepo();
  const a = await repo.addCycle({ startDate: '2026-08-01' });
  await repo.addCycle({ startDate: '2026-09-01' });
  const updated = await repo.updateCycle(a.id, { endDate: '2026-08-06' });
  assert.equal(updated.endDate, '2026-08-06');
  assert.equal(updated.history.at(-1).action, 'updated');
  assert.match(updated.history.at(-1).detail, /补充结束日期/);
});

test('C04 修改开始日期并重新计算周期长度', async () => {
  const { repo } = makeRepo();
  await repo.addCycle({ startDate: '2026-07-01' });
  const b = await repo.addCycle({ startDate: '2026-08-05' });
  await repo.addCycle({ startDate: '2026-09-01' });
  await repo.updateCycle(b.id, { startDate: '2026-08-01' });
  const list = await repo.listCycles();
  assert.equal(list[1].startDate, '2026-08-01');
  assert.equal(list[1].cycleLengthDays, 31);
  assert.equal(list[2].cycleLengthDays, 31);
});

test('C05 删除记录后周期长度与预测重新计算', async () => {
  const { repo } = makeRepo();
  const a = await repo.addCycle({ startDate: '2026-06-01' });
  const b = await repo.addCycle({ startDate: '2026-07-01' });
  const c = await repo.addCycle({ startDate: '2026-08-01' });
  assert.equal((await repo.listCycles()).find(x => x.id === c.id).cycleLengthDays, 31);
  await repo.removeCycle(a.id);
  const list = await repo.listCycles();
  assert.equal(list.length, 2);
  assert.equal(list[0].cycleLengthDays, null, '删除最早的之后新的最早一条无间隔');
});

test('C06 周期长度计算：相邻开始日期天数', async () => {
  const rows = [
    { id: '1', startDate: '2026-01-01', endDate: '2026-01-06' },
    { id: '2', startDate: '2026-01-30', endDate: '2026-02-04' },
    { id: '3', startDate: '2026-02-28', endDate: '2026-03-05' },
  ];
  const out = cyclesWithLengths(rows);
  assert.equal(out[0].cycleLengthDays, null);
  assert.equal(out[1].cycleLengthDays, 29);
  assert.equal(out[2].cycleLengthDays, 29);
  assert.equal(out[0].periodLengthDays, 6);
});

test('C07 数据不足时明确无法预测，不虚构结果', async () => {
  const { repo } = makeRepo();
  let p = await repo.prediction();
  assert.equal(p.ok, false);
  assert.match(p.reason, /还没有/);
  await repo.addCycle({ startDate: '2026-07-01' });
  p = await repo.prediction();
  assert.equal(p.ok, false);
  assert.match(p.reason, /至少需要 3 次/);
  await repo.addCycle({ startDate: '2026-08-01' });
  p = await repo.prediction();
  assert.equal(p.ok, false, '2 次开始记录仍不足');
  assert.equal(p.nextStart, undefined, '不应给出预测日期');
});

test('C08 3 次记录后可估算，给区间而非确定日期', async () => {
  const { repo } = makeRepo();
  await repo.addCycle({ startDate: '2026-06-01', endDate: '2026-06-06' });
  await repo.addCycle({ startDate: '2026-07-01', endDate: '2026-07-06' });
  await repo.addCycle({ startDate: '2026-08-01', endDate: '2026-08-06' });
  const p = await repo.prediction();
  assert.equal(p.ok, true);
  assert.equal(p.median, 31);
  assert.equal(p.nextStart.center, '2026-09-01');
  assert.equal(p.nextStart.from, '2026-08-30');
  assert.equal(p.nextStart.to, '2026-09-03');
  assert.ok(p.predictedEnd, '有经期长度时应给出结束区间');
  assert.match(p.note, /估算/);
});

test('C09 修改历史记录后预测立即更新', async () => {
  const { repo } = makeRepo();
  const a = await repo.addCycle({ startDate: '2026-06-01' });
  await repo.addCycle({ startDate: '2026-07-01' });
  const c = await repo.addCycle({ startDate: '2026-08-01' });
  assert.equal((await repo.prediction()).nextStart.center, '2026-09-01');
  await repo.updateCycle(c.id, { startDate: '2026-08-11' });
  const p = await repo.prediction();
  assert.equal(p.ok, true);
  assert.notEqual(p.nextStart.center, '2026-09-01', '历史变化应影响预测');
  await repo.removeCycle(a.id);
  const p2 = await repo.prediction();
  assert.equal(p2.ok, false, '删到只剩 2 次后应回到不可预测');
});

test('C10 预测使用异常间隔时过滤不合理值', async () => {
  const cycles = [
    { startDate: '2026-01-01' },
    { startDate: '2026-01-31' },
    { startDate: '2026-03-01' },
    { startDate: '2026-03-02' }, // 1 天异常，应被过滤
    { startDate: '2026-04-01' },
  ];
  const p = predictCycle(cycles, '2026-03-15');
  assert.equal(p.ok, true);
  assert.ok(p.median >= 28 && p.median <= 31);
});

test('C11 校验：重叠、重复开始、非法日期、结束早于开始', async () => {
  const { repo } = makeRepo();
  const a = await repo.addCycle({ startDate: '2026-09-01', endDate: '2026-09-06' });
  await assert.rejects(() => repo.addCycle({ startDate: '2026-09-03' }), /重叠/);
  await assert.rejects(() => repo.addCycle({ startDate: '2026-09-01' }), /已存在/);
  await assert.rejects(() => repo.addCycle({ startDate: '2023-02-29' }), /有效/);
  await assert.rejects(() => repo.updateCycle(a.id, { endDate: '2026-08-31' }), /早于/);
});

test('C12 持久化 + 健康数据仅存在于独立 backing', async () => {
  const { repo, backing, newConnection } = makeRepo();
  await repo.addCycle({ startDate: '2026-08-01', symptoms: ['头痛'], note: '私密备注' });
  const reopened = newConnection();
  const list = await reopened.listCycles();
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].symptoms, ['头痛']);
  assert.equal(list[0].note, '私密备注');
  assert.ok(backing.cycles instanceof Map, '周期数据应存独立 store');
  assert.equal(backing.meta instanceof Map, true);
});

test('C13 周期记录进入统一历史流', async () => {
  const { repo } = makeRepo();
  await repo.addCycle({ startDate: '2026-08-01' });
  const h = await repo.history();
  assert.ok(h.some(x => x.group === '周期' && x.action === 'created'));
});

test('C14 validateCycle 允许结束日期为空字符串（UI 常见输入）', async () => {
  const err = validateCycle({ startDate: '2026-08-01', endDate: '' }, []);
  assert.equal(err, null);
});
