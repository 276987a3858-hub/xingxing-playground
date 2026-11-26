/* tests/butler/tasks.test.mjs
 * 待办模块：增删改查 / 状态 / 历史 / 持久化 / 重复与异常 / 日期边界
 * 运行：node --test tests/butler/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRepository } from '../../public/butler/butler-repository.js';
import { createMemoryAdapter } from './memory-adapter.mjs';

function makeRepo() {
  const backing = {};
  return { repo: createRepository(createMemoryAdapter(backing)), backing, newConnection: () => createRepository(createMemoryAdapter(backing)) };
}

test('T01 新增待办并读取（默认值正确）', async () => {
  const { repo } = makeRepo();
  const t = await repo.addTask({ title: '买牛奶', date: '2026-11-17', time: '09:00', type: 'todo' });
  assert.equal(t.status, 'pending');
  assert.equal(t.completedAt, null);
  assert.equal(t.history.length, 1);
  assert.equal(t.history[0].action, 'created');
  const list = await repo.listTasks();
  assert.equal(list.length, 1);
  assert.equal(list[0].title, '买牛奶');
});

test('T02 修改标题/日期/时间且保留历史', async () => {
  const { repo } = makeRepo();
  const t = await repo.addTask({ title: '开会', date: '2026-11-17', time: '10:00' });
  const updated = await repo.updateTask(t.id, { title: '周会', date: '2026-11-18', time: '11:30' });
  assert.equal(updated.title, '周会');
  assert.equal(updated.date, '2026-11-18');
  assert.equal(updated.time, '11:30');
  assert.equal(updated.history.length, 2);
  assert.equal((await repo.getTask(t.id)).title, '周会');
});

test('T03 完成：写入实际完成时间与历史，重复完成幂等', async () => {
  const { repo } = makeRepo();
  const t = await repo.addTask({ title: '交报告', date: '2026-11-17' });
  const done = await repo.completeTask(t.id);
  assert.equal(done.status, 'done');
  assert.ok(done.completedAt > 0);
  assert.equal(done.history.at(-1).action, 'done');
  const again = await repo.completeTask(t.id);
  assert.equal(again.completedAt, done.completedAt);
  assert.equal(again.history.length, done.history.length);
});

test('T04 取消与重新打开', async () => {
  const { repo } = makeRepo();
  const t = await repo.addTask({ title: '取消的约会', date: '2026-11-17' });
  const c = await repo.cancelTask(t.id);
  assert.equal(c.status, 'cancelled');
  assert.equal(c.history.at(-1).action, 'cancelled');
  await assert.rejects(() => repo.completeTask(t.id), /取消/);
  const r = await repo.reopenTask(t.id);
  assert.equal(r.status, 'pending');
  assert.equal(r.history.at(-1).action, 'reopened');
});

test('T05 延期更新原事项不新建，历史完整', async () => {
  const { repo } = makeRepo();
  const t = await repo.addTask({ title: '看牙', date: '2026-11-17', time: '15:00' });
  const deferred = await repo.deferTask(t.id, { date: '2026-11-20', time: '16:00' });
  assert.equal(deferred.id, t.id);
  assert.equal((await repo.listTasks()).length, 1, '延期不应产生新记录');
  assert.equal(deferred.date, '2026-11-20');
  assert.equal(deferred.status, 'pending');
  assert.equal(deferred.history.at(-1).action, 'deferred');
  assert.match(deferred.history.at(-1).detail, /2026-11-17 15:00 → 2026-11-20 16:00/);
});

test('T06 历史记录聚合：跨事项按时间倒序', async () => {
  const { repo } = makeRepo();
  const a = await repo.addTask({ title: 'A', date: '2026-11-17' });
  await repo.completeTask(a.id);
  const b = await repo.addTask({ title: 'B', date: '2026-11-18' });
  await repo.deferTask(b.id, { date: '2026-11-19' });
  const h = await repo.history();
  assert.ok(h.length >= 4);
  for (let i = 1; i < h.length; i++) assert.ok(h[i - 1].at >= h[i].at);
  assert.equal(h[0].group, '任务');
});

test('T07 刷新后持久化（新连接共享同一 backing）', async () => {
  const { repo, newConnection } = makeRepo();
  await repo.addTask({ title: '持久化测试', date: '2026-12-01' });
  const reopened = newConnection();
  const list = await reopened.listTasks();
  assert.equal(list.length, 1);
  assert.equal(list[0].title, '持久化测试');
});

test('T08 删除事项', async () => {
  const { repo } = makeRepo();
  const t = await repo.addTask({ title: '删除我', date: '2026-11-17' });
  await repo.removeTask(t.id);
  assert.equal((await repo.listTasks()).length, 0);
  assert.equal(await repo.getTask(t.id), undefined);
});

test('T09 空数据与异常数据校验', async () => {
  const { repo } = makeRepo();
  await assert.rejects(() => repo.addTask({ title: '', date: '2026-11-17' }), /填写事项/);
  await assert.rejects(() => repo.addTask({ title: 'x', date: '2023-02-29' }), /有效日期/);
  await assert.rejects(() => repo.addTask({ title: 'x', date: '2026-11-17', time: '25:00' }), /时间格式/);
  assert.deepEqual(await repo.listTasks(), []);
});

test('T10 日期边界：跨月/跨年/闰年延期', async () => {
  const { repo } = makeRepo();
  const t = await repo.addTask({ title: '跨年任务', date: '2024-12-31', time: '23:30' });
  await repo.deferTask(t.id, { date: '2025-01-01', time: '00:30' });
  const d = await repo.getTask(t.id);
  assert.equal(d.date, '2025-01-01');
  const leap = await repo.addTask({ title: '闰日', date: '2024-02-29' });
  assert.equal(leap.date, '2024-02-29');
  await assert.rejects(() => repo.addTask({ title: '平年假闰日', date: '2023-02-29' }), /有效日期/);
});

test('T11 重复新增同标题是允许的独立事项（不误判为重复）', async () => {
  const { repo } = makeRepo();
  await repo.addTask({ title: '喝水', date: '2026-11-17' });
  await repo.addTask({ title: '喝水', date: '2026-11-17' });
  assert.equal((await repo.listTasks()).length, 2);
});
