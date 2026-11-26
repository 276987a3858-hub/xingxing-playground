/* tests/butler/sleep.test.mjs
 * 作息模块：跨午夜、补录/修改、历史、持久化、异常与重复日期
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRepository } from '../../public/butler/butler-repository.js';
import { buildSleepRecord, formatDuration } from '../../public/butler/butler-core.js';
import { createMemoryAdapter } from './memory-adapter.mjs';

function makeRepo() {
  const backing = {};
  return {
    repo: createRepository(createMemoryAdapter(backing)),
    newConnection: () => createRepository(createMemoryAdapter(backing)),
  };
}

test('S01 跨午夜：23:30 入睡，次日 07:30 起床 = 8 小时', async () => {
  const rec = buildSleepRecord({ date: '2026-11-17', sleepTime: '23:30', wakeTime: '07:30' });
  assert.equal(rec.sleepDate, '2026-11-16');
  assert.equal(rec.date, '2026-11-17');
  assert.equal(rec.durationMs, 8 * 3600000);
  assert.equal(formatDuration(rec.durationMs), '8小时');
});

test('S02 同日小睡：01:00 入睡 02:30 起床 = 1小时30分', async () => {
  const rec = buildSleepRecord({ date: '2026-11-17', sleepTime: '01:00', wakeTime: '02:30' });
  assert.equal(rec.sleepDate, '2026-11-17');
  assert.equal(rec.durationMs, 90 * 60000);
  assert.equal(formatDuration(rec.durationMs), '1小时30分');
});

test('S03 跨年跨闰日：2024-12-31 23:00 → 2025-01-01 07:00', async () => {
  const rec = buildSleepRecord({ date: '2025-01-01', sleepTime: '23:00', wakeTime: '07:00' });
  assert.equal(rec.sleepDate, '2024-12-31');
  assert.equal(rec.durationMs, 8 * 3600000);
});

test('S04 保存并读取，含起床日期索引排序', async () => {
  const { repo } = makeRepo();
  await repo.saveSleep({ date: '2026-11-16', sleepTime: '23:00', wakeTime: '07:00', note: '第一天' });
  await repo.saveSleep({ date: '2026-11-17', sleepTime: '00:30', wakeTime: '08:00' });
  const list = await repo.listSleep();
  assert.equal(list.length, 2);
  assert.equal(list[0].date, '2026-11-17', '应按起床日期倒序');
  assert.equal(list[1].note, '第一天');
});

test('S05 补录/修改：同一天重复保存只更新原记录', async () => {
  const { repo } = makeRepo();
  const a = await repo.saveSleep({ date: '2026-11-17', sleepTime: '23:30', wakeTime: '07:30' });
  const b = await repo.saveSleep({ date: '2026-11-17', sleepTime: '22:30', wakeTime: '06:30', note: '改正' });
  assert.equal(b.id, a.id, '同一天应视为修改');
  assert.equal((await repo.listSleep()).length, 1);
  assert.equal(b.note, '改正');
  assert.equal(b.durationMs, 8 * 3600000);
  assert.equal(b.history.at(-1).action, 'updated');
});

test('S06 刷新后持久化', async () => {
  const { repo, newConnection } = makeRepo();
  await repo.saveSleep({ date: '2026-11-17', sleepTime: '23:30', wakeTime: '07:30' });
  const list = await newConnection().listSleep();
  assert.equal(list.length, 1);
  assert.equal(list[0].durationMs, 8 * 3600000);
});

test('S07 删除作息记录', async () => {
  const { repo } = makeRepo();
  const a = await repo.saveSleep({ date: '2026-11-17', sleepTime: '23:00', wakeTime: '07:00' });
  await repo.removeSleep(a.id);
  assert.equal((await repo.listSleep()).length, 0);
});

test('S08 异常数据：非法日期/缺时间/时长超过 24 小时', async () => {
  const { repo } = makeRepo();
  await assert.rejects(() => repo.saveSleep({ date: '2023-02-29', sleepTime: '23:00', wakeTime: '07:00' }), /有效/);
  await assert.rejects(() => repo.saveSleep({ date: '2026-11-17', sleepTime: '', wakeTime: '07:00' }), /填写/);
  // 入睡与起床同一时刻 → 回退一天得 24h，应判为无效
  await assert.rejects(() => repo.saveSleep({ date: '2026-11-17', sleepTime: '07:00', wakeTime: '07:00' }), /不合理/);
  assert.equal((await repo.listSleep()).length, 0);
});

test('S09 作息也进入统一历史流', async () => {
  const { repo } = makeRepo();
  await repo.saveSleep({ date: '2026-11-17', sleepTime: '23:00', wakeTime: '07:00' });
  const h = await repo.history();
  assert.ok(h.some(x => x.group === '作息'));
});
