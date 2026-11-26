/* tests/shared/history-window.test.mjs — 请求层历史窗口纯函数测试（无 IO、无 AI） */
import test from 'node:test';
import assert from 'node:assert/strict';

import '../../public/shared/history-window.js';
import '../../public/shared/prompt-layout.js';

const HW = globalThis.HistoryWindow;
const PL = globalThis.PromptLayout;
const pad = (s, n) => String(s).repeat(n);
const m = (id, role, content, image) => ({ id, role, content, image: image || null, time: id });

test('H1 同 role 合并保留 sourceIds 与逐条 parts', () => {
  const list = [m(1, 'user', '甲'), m(2, 'user', '乙'), m(3, 'assistant', '丙')];
  const w = HW.mergeWithSourceIds(list);
  assert.equal(w.length, 2);
  assert.deepEqual(w[0].sourceIds, [1, 2]);
  assert.equal(w[0].content, '甲\n乙');
  assert.equal(w[0].parts.length, 2);
  assert.equal(w[0].parts[1].source.id, 2);
  assert.deepEqual(w[1].sourceIds, [3]);
});

test('H2 连续 user 中剔除当前条，不误删更早的 user', () => {
  const list = [m(1, 'user', '先说的'), m(2, 'user', '这句是当前', 'IMG2')];
  const w = HW.mergeWithSourceIds(list);
  const r = HW.detachCurrentTurn(w, 2, list);
  assert.equal(r.found, true);
  assert.equal(r.current.id, 2);
  assert.equal(r.current.image, 'IMG2');
  assert.equal(r.window.length, 1);
  assert.deepEqual(r.window[0].sourceIds, [1]);
  assert.equal(r.window[0].content, '先说的');
  assert.deepEqual(HW.sourceIdsOf(r.window), [1]);
});

test('H3 当前消息是合并组唯一成员时整组移除', () => {
  const list = [m(1, 'assistant', '回复'), m(2, 'user', '当前')];
  const r = HW.detachCurrentTurn(HW.mergeWithSourceIds(list), 2, list);
  assert.equal(r.found, true);
  assert.equal(r.current.id, 2);
  assert.deepEqual(HW.sourceIdsOf(r.window), [1]);
});

test('H4 当前消息不在窗口时不改动窗口（非主聊天路径）', () => {
  const list = [m(1, 'user', '甲')];
  const w = HW.mergeWithSourceIds(list);
  const r = HW.detachCurrentTurn(w, 999, list);
  assert.equal(r.found, false);
  assert.equal(r.current, null);
  assert.deepEqual(HW.sourceIdsOf(r.window), [1]);
});

test('H5 无状态滞回：低于 24000 全部保留、不裁剪', () => {
  const list = [];
  for (let i = 1; i <= 100; i++) list.push(m(i, i % 2 ? 'user' : 'assistant', pad('字', 100)));
  const r = HW.trimWithHysteresis(list);
  assert.equal(r.stats.trimmed, false);
  assert.equal(r.stats.totalChars, 10000);
  assert.equal(r.window.length, 100);
  assert.deepEqual(HW.sourceIdsOf(r.window), list.map(x => x.id));
});

test('H6 无状态滞回：超过 24000 才裁到约 20000，且保留尾部顺序', () => {
  const list = [];
  for (let i = 1; i <= 300; i++) list.push(m(i, i % 2 ? 'user' : 'assistant', pad('字', 100)));
  const r = HW.trimWithHysteresis(list);
  assert.equal(r.stats.trimmed, true);
  assert.equal(r.stats.totalChars, 30000);
  assert.ok(r.stats.keptChars <= 20000, `保留 ${r.stats.keptChars} 必须 ≤ 20000`);
  assert.ok(r.stats.keptChars >= 19900, `保留 ${r.stats.keptChars} 必须接近 20000`);
  assert.notEqual(r.stats.leftSourceId, 1);
  const ids = HW.sourceIdsOf(r.window);
  assert.equal(ids[ids.length - 1], 300);
  assert.deepEqual(ids, list.slice(ids.length * -1).map(x => x.id));
});

test('H7 图片默认不计入文字预算（本批不设图片硬闸）', () => {
  const list = [];
  for (let i = 1; i <= 100; i++) list.push(m(i, i % 2 ? 'user' : 'assistant', pad('字', 100), i === 1 ? 'IMG' : null));
  const r = HW.trimWithHysteresis(list, { hard: 12000, soft: 10000 });
  assert.equal(r.stats.trimmed, false);
  assert.equal(r.window.length, 100);
});

test('H8 固定预算兼容模式等价旧 trimHistoryForAI', () => {
  const list = [];
  for (let i = 1; i <= 5; i++) list.push(m(i, i % 2 ? 'user' : 'assistant', pad('字', 100)));
  const r = HW.trimFixed(list, 250);
  assert.deepEqual(HW.sourceIdsOf(r.window), [4, 5]);
  assert.equal(r.stats.keptChars, 200);
});

test('H9 超长单条不会被裁成空窗口', () => {
  const list = [m(1, 'user', pad('字', 30000))];
  const r = HW.trimWithHysteresis(list);
  assert.equal(r.window.length, 1);
  assert.equal(r.stats.trimmed, true);
});

test('H10 显式 state 钉住左边界：裁剪后不会把早期消息重新纳入', () => {
  const list = [];
  for (let i = 1; i <= 250; i++) list.push(m(i, i % 2 ? 'user' : 'assistant', pad('字', 100)));
  const first = HW.trimWithHysteresis(list);
  assert.equal(first.stats.trimmed, true);
  const left = first.stats.leftSourceId;
  assert.ok(left > 1);

  // 后续追加 10 条：无状态实现每轮都取完整历史的尾部 ~20000，左边界会继续右移；
  // 有 state 时左边界保持不动，直到 scoped 长度再次超过 24000。
  const extras = [];
  for (let i = 251; i <= 260; i++) extras.push(m(i, i % 2 ? 'user' : 'assistant', pad('字', 100)));
  const nextList = list.concat(extras);
  const stateless = HW.trimWithHysteresis(nextList);
  const withState = HW.trimWithHysteresis(nextList, { state: first.state });
  assert.notEqual(stateless.stats.leftSourceId, left);    // 无状态边界随尾部滑动
  assert.equal(withState.stats.leftSourceId, left);       // state 真正钉住边界
  assert.ok(!HW.sourceIdsOf(withState.window).includes(1));
  assert.deepEqual(HW.sourceIdsOf(withState.window).slice(-1), [260]);
});

test('H11 数字 ID 与字符串 ID 统一比较，但 sourceIds 保留原始类型', () => {
  const list = [{ id: 1, role: 'user', content: '甲' }, { id: '2', role: 'user', content: '乙' }];
  const w = HW.mergeWithSourceIds(list);
  assert.deepEqual(HW.sourceIdsOf(w), [1, '2']);
  const r = HW.detachCurrentTurn(w, '2', list);
  assert.equal(r.found, true);
  assert.equal(r.current.id, '2');
  assert.deepEqual(HW.sourceIdsOf(r.window), [1]);
  assert.deepEqual(list.map(x => x.id), [1, '2'], '原始消息 ID 未被改写');
});

test('H12 连续 user 合并后剥离中间一条，sourceIds 与正文准确', () => {
  const list = [
    { id: 'a', role: 'user', content: '一' },
    { id: 'b', role: 'user', content: '二' },
    { id: 'c', role: 'user', content: '三' }
  ];
  const w = HW.mergeWithSourceIds(list);
  assert.deepEqual(HW.sourceIdsOf(w), ['a', 'b', 'c']);
  const r = HW.detachCurrentTurn(w, 'b', list);
  assert.equal(r.found, true);
  assert.deepEqual(HW.sourceIdsOf(r.window), ['a', 'c']);
  assert.equal(r.window[0].content, '一\n三');
  assert.equal(r.window[0].id, null, '合并组不得继承某条原始主键');
  assert.equal(r.window[0].parts.length, 2);
});

test('H13 重复 ID 全部隔离，originalId 可追溯且消息不丢失', () => {
  const first = { id: 7, role: 'user', content: '先说的' };
  const second = { id: 7, role: 'user', content: '当前这句' };
  const list = [first, second];
  const w = HW.mergeWithSourceIds(list);
  assert.deepEqual(HW.sourceIdsOf(w), ['7#dup1', '7#dup2']);
  assert.equal(w[0].parts[0].originalId, 7);
  assert.equal(w[0].parts[1].originalId, 7);
  assert.equal(w[0].parts[1].duplicate, true);

  const r = HW.detachCurrentTurn(w, 7, list, second);
  assert.equal(r.found, true);
  assert.strictEqual(r.current, second, '对象身份消歧命中真正的当前消息');
  assert.deepEqual(HW.sourceIdsOf(r.window), ['7#dup1']);
  assert.equal(r.window[0].parts[0].originalId, 7);
  assert.deepEqual(list.map(x => x.id), [7, 7], '原始数据库 ID 未被改写');
});

test('H14 重复 ID 未传对象身份时取最新一条，并标记 ambiguous', () => {
  const list = [
    { id: 7, role: 'user', content: '先说的' },
    { id: 7, role: 'user', content: '当前这句' }
  ];
  const r = HW.detachCurrentTurn(HW.mergeWithSourceIds(list), 7, list);
  assert.equal(r.found, true);
  assert.equal(r.current.content, '当前这句');
  assert.equal(r.ambiguous, true);
  assert.deepEqual(HW.sourceIdsOf(r.window), ['7#dup1']);
});

test('H15 缺失 ID 用索引身份，剥离后仍可追溯原文', () => {
  const a = { role: 'user', content: '无 ID 一' };
  const b = { role: 'user', content: '无 ID 二' };
  const list = [a, b];
  const w = HW.mergeWithSourceIds(list);
  assert.deepEqual(HW.sourceIdsOf(w), ['hw:idx:0', 'hw:idx:1']);
  const r = HW.detachCurrentTurn(w, 'hw:idx:1', list);
  assert.equal(r.found, true);
  assert.equal(r.current.content, '无 ID 二');
  assert.deepEqual(HW.sourceIdsOf(r.window), ['hw:idx:0']);
  assert.equal(r.window[0].parts[0].source, a);
});

test('H16 拆分组拥有临时身份，不继承被剥离消息的原始主键', () => {
  const list = [
    { id: 1, role: 'user', content: '一' },
    { id: 2, role: 'user', content: '二' },
    { id: 3, role: 'user', content: '三' }
  ];
  const w = HW.mergeWithSourceIds(list);
  const r = HW.detachCurrentTurn(w, 2, list);
  assert.equal(r.found, true);
  assert.equal(r.window[0].id, null);
  assert.equal(r.window[0].tempId, 'hw:group:0');
  assert.deepEqual(r.window[0].sourceIds, [1, 3]);
  assert.deepEqual(r.window[0].originalIds, [1, 3]);
  assert.ok(!HW.sourceIdsOf(r.window).includes(2));
});

test('H17 重复 ID 隔离后不会被 prompt-layout 的重复守卫误伤', () => {
  const first = { id: 7, role: 'user', content: '先说的' };
  const second = { id: 7, role: 'user', content: '当前这句' };
  const list = [first, second];
  const w = HW.mergeWithSourceIds(list);
  const r = HW.detachCurrentTurn(w, 7, list, second);
  const messages = PL.assembleMessages({
    stableSystem: 'S',
    historyWindow: r.window,
    mapHistory: m => ({ role: m.role, content: m.content }),
    dynamicContext: '',
    currentTurn: { role: 'user', content: '当前这句' },
    currentMessageId: 7
  });
  assert.equal(messages.length, 3, '系统 + 隔离后的早先消息 + 当前消息');
  assert.equal(messages[1].content, '先说的');
  assert.equal(messages[2].content, '当前这句');
});
