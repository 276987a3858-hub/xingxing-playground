/* tests/shared/self-narrative-source-map.test.mjs — 机自述来源消息 ID 随导入映射（P1.5）
 * 覆盖：ID 未变化 / 同 ID 不同内容触发重分配 / 数字与字符串 ID 兼容 /
 *       映射表外的来源不被改写 / 其他来源字段与 history 保持不变 /
 *       目标机自有记录不被备份映射误改 / 合并与覆盖两种模式。
 * 纯 Node：buildPlan 是纯函数层，不碰 IndexedDB。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import '../../public/shared/backup-format.js';

const BF = globalThis.BackupFormat;
const KEY = 'selfNarrative.v1';
const T = 1795000000000;

/* ---------------- 夹具 ---------------- */

function chatMsg(id, content, time) {
  return { id, role: 'user', content, time: time || (T + id * 1000) };
}

function source(messageId, extra) {
  return Object.assign({ kind: 'chat', messageId, at: T, ref: 'msg:' + messageId }, extra || {});
}

function snRecord(id, opts) {
  const o = opts || {};
  return {
    id,
    text: o.text || ('她' + id),
    kind: o.kind || 'observation',
    observed: o.observed || '',
    inferred: o.inferred || '',
    confirmed: '',
    question: '',
    topic: o.topic || '',
    confidence: o.confidence || 'medium',
    source: o.source || source(12),
    status: o.status || 'active',
    revisedFrom: o.revisedFrom || null,
    supersededBy: o.supersededBy || null,
    createdAt: o.createdAt || T,
    updatedAt: o.updatedAt || (T + 1000),
    history: o.history || [],
  };
}

function historyVersion(messageId, text, at) {
  return {
    at: at || (T - 1000),
    text: text || '旧版正文',
    kind: 'observation',
    observed: '',
    inferred: '',
    confirmed: '',
    question: '',
    topic: '',
    confidence: 'low',
    source: source(messageId),
    status: 'active',
    revisedFrom: null,
  };
}

function snState(records) {
  return { schema: 1, key: KEY, createdAt: T, updatedAt: T + 9000, records };
}

function sections(opts) {
  const o = opts || {};
  return {
    room: {
      kv: Object.assign({}, o.sn ? { [KEY]: o.sn } : {}),
      messages: o.messages || [],
      keeps: o.keeps || [],
      diaries: [],
      starDiaries: [],
      futureLetters: [],
    },
    butler: { tasks: [], transactions: [], cycles: [], sleepLogs: [], meta: [] },
    localStorage: {},
    radioVoice: { clips: [] },
    chatVoice: { clips: [] },
  };
}

function recById(state, id) {
  const r = (state.records || []).find((x) => x.id === id);
  assert.ok(r, '找不到记录 ' + id);
  return r;
}

/* ---------------- M01 没有重分配 ---------------- */
test('M01 消息 ID 没有重分配时，机自述来源一字段不动', () => {
  const target = sections({
    messages: [chatMsg(11, '同一句'), chatMsg(12, '另一句')],
    sn: snState([snRecord('sn-1', { source: source(11) })]),
  });
  const backup = sections({
    messages: [chatMsg(11, '同一句'), chatMsg(12, '另一句')],
    sn: snState([snRecord('sn-2', { source: source(12), history: [historyVersion(11)] })]),
  });

  const plan = BF.buildPlan({ mode: 'merge', target, backup });
  assert.deepEqual(plan.idMap.messages, {}, '没有冲突就不该产生映射');

  const state = plan.kvSet[KEY];
  assert.equal(recById(state, 'sn-1').source.messageId, 11);
  assert.equal(recById(state, 'sn-2').source.messageId, 12);
  assert.equal(recById(state, 'sn-2').history[0].source.messageId, 11);
  assert.equal(plan.selfNarrative.remapped, 0);
  assert.equal(plan.selfNarrative.unresolved, 0);
});

/* ---------------- M02 同 ID 不同内容 → 重分配并跟随 ---------------- */
test('M02 同 ID 不同内容导致重分配：备份侧来源跟着新 ID 走', () => {
  const target = sections({
    messages: [chatMsg(11, '目标机的第 11 条')],
    sn: snState([snRecord('sn-t', { source: source(11) })]),
  });
  const backup = sections({
    messages: [chatMsg(11, '备份机的第 11 条')],
    sn: snState([snRecord('sn-b', { source: source(11) })]),
  });

  const plan = BF.buildPlan({ mode: 'merge', target, backup });
  const newId = plan.idMap.messages[11];
  assert.equal(typeof newId, 'number', '冲突消息必须被分配新 ID');
  assert.notEqual(newId, 11);

  const state = plan.kvSet[KEY];
  assert.equal(recById(state, 'sn-b').source.messageId, newId, '备份侧来源必须跟随映射');
  assert.equal(recById(state, 'sn-t').source.messageId, 11,
    '目标机自有记录指向目标机自己的消息，绝不能被备份的映射改写');
  assert.equal(plan.selfNarrative.remapped, 1);
});

/* ---------------- M03 数字 / 字符串 ID 兼容 ---------------- */
test('M03 字符串来源 ID 与数字 ID 命中同一条映射', () => {
  const target = sections({
    messages: [chatMsg(11, '目标机')],
    sn: snState([]),
  });
  const backup = sections({
    messages: [chatMsg(11, '备份机')],
    sn: snState([
      snRecord('sn-num', { source: source(11) }),
      snRecord('sn-str', { source: source('11') }),
      // 带空白属于异常写入：不猜测、不 trim、不模糊匹配，原样留着
      snRecord('sn-pad', { source: source(' 11 ') }),
    ]),
  });

  const plan = BF.buildPlan({ mode: 'merge', target, backup });
  const newId = plan.idMap.messages[11];
  const state = plan.kvSet[KEY];

  assert.equal(recById(state, 'sn-num').source.messageId, newId);
  assert.equal(recById(state, 'sn-str').source.messageId, newId, '字符串 "11" 必须命中同一条映射');
  assert.equal(recById(state, 'sn-pad').source.messageId, ' 11 ', '异常空白值不做模糊匹配');
  assert.equal(plan.selfNarrative.remapped, 2);
});

/* ---------------- M04 映射表外的来源 ---------------- */
test('M04 不在映射表里的来源原样保留：不猜测、不置空、不模糊匹配', () => {
  const target = sections({
    messages: [chatMsg(11, '目标机')],
    sn: snState([]),
  });
  const backup = sections({
    messages: [chatMsg(11, '备份机')],
    sn: snState([
      snRecord('sn-gone', { source: source(999) }),                     // 备份里也没有这条消息
      snRecord('sn-other', { source: { kind: 'diary', sourceId: 11, at: T } }),
      snRecord('sn-no-id', { source: { kind: 'chat', at: T } }),
    ]),
  });

  const plan = BF.buildPlan({ mode: 'merge', target, backup });
  const state = plan.kvSet[KEY];

  assert.equal(recById(state, 'sn-gone').source.messageId, 999, '指向不存在的消息必须原样保留');
  assert.equal(recById(state, 'sn-other').source.sourceId, 11, '只认 messageId，其他 id 字段不参与映射');
  assert.equal('messageId' in recById(state, 'sn-other').source, false);
  assert.equal('messageId' in recById(state, 'sn-no-id').source, false, '没有 messageId 就不该凭空加一个');
  assert.equal(plan.selfNarrative.remapped, 0);
  assert.equal(plan.selfNarrative.unresolved, 1, '只统计、不修改');
});

/* ---------------- M05 其他字段与历史保持不变 ---------------- */
test('M05 记录正文、状态、其他来源字段与历史顺序全部保持不变', () => {
  const hist = [historyVersion(11, '第一版', T - 3000), historyVersion(11, '第二版', T - 2000)];
  const target = sections({ messages: [chatMsg(11, '目标机')], sn: snState([]) });
  const backup = sections({
    messages: [chatMsg(11, '备份机')],
    sn: snState([
      snRecord('sn-r', {
        text: '她好像不太喜欢被安排',
        kind: 'question',
        status: 'retracted',
        topic: '边界',
        confidence: 'low',
        source: source(11, { conversationId: 'room', at: T + 5 }),
        revisedFrom: 'sn-old',
        history: hist,
      }),
    ]),
  });

  const plan = BF.buildPlan({ mode: 'merge', target, backup });
  const newId = plan.idMap.messages[11];
  const r = recById(plan.kvSet[KEY], 'sn-r');

  assert.equal(r.text, '她好像不太喜欢被安排');
  assert.equal(r.kind, 'question');
  assert.equal(r.status, 'retracted', '撤回状态必须保留');
  assert.equal(r.topic, '边界');
  assert.equal(r.confidence, 'low');
  assert.equal(r.revisedFrom, 'sn-old');
  assert.equal(r.source.conversationId, 'room', '其他来源字段不能被吃掉');
  assert.equal(r.source.at, T + 5);
  assert.equal(r.source.ref, 'msg:11', 'ref 是自由文本，不参与映射，也不该被改');
  assert.equal(r.source.messageId, newId);

  assert.equal(r.history.length, 2, '历史版本不能增减');
  assert.deepEqual(r.history.map((v) => v.text), ['第一版', '第二版'], '历史顺序保持按时间升序');
  assert.equal(r.history[0].source.messageId, newId, '历史快照里的来源也要跟着走');
  assert.equal(r.history[1].source.messageId, newId);
  assert.equal(plan.selfNarrative.remapped, 3, '当前版本 1 条 + 历史 2 条');
});

/* ---------------- M06 覆盖模式 ---------------- */
test('M06 replace 模式：消息 ID 不重分配，机自述整体替换且不改来源', () => {
  const target = sections({
    messages: [chatMsg(11, '目标机')],
    sn: snState([snRecord('sn-old', { source: source(11) })]),
  });
  const backup = sections({
    messages: [chatMsg(11, '备份机')],
    sn: snState([snRecord('sn-new', { source: source(11) })]),
  });

  const plan = BF.buildPlan({ mode: 'replace', target, backup });
  assert.deepEqual(plan.idMap.messages, {}, 'replace 用备份原 ID 写入，不存在重分配');

  const state = plan.kvSet[KEY];
  assert.equal(plan.selfNarrative.action, 'replace');
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].source.messageId, 11);
  assert.equal(plan.selfNarrative.remapped, 0);
});

/* ---------------- M07 skip-existing ---------------- */
test('M07 skip-existing：跳过机自述分区，不写入也不报告改写', () => {
  const target = sections({
    messages: [chatMsg(11, '目标机')],
    sn: snState([snRecord('sn-t', { source: source(11) })]),
  });
  const backup = sections({
    messages: [chatMsg(11, '备份机')],
    sn: snState([snRecord('sn-b', { source: source(11) })]),
  });

  const plan = BF.buildPlan({ mode: 'skip-existing', target, backup });
  assert.equal(plan.selfNarrative.action, 'skip');
  assert.equal(KEY in plan.kvSet, false, '跳过时不得写入该键');
  assert.equal(plan.selfNarrative.remapped, 0);
  assert.equal(plan.selfNarrative.unresolved, 0);
});

/* ---------------- M08 其他引用改写没被破坏 ---------------- */
test('M08 同一次导入里，珍藏的来源消息引用仍按原逻辑改写', () => {
  const target = sections({ messages: [chatMsg(11, '目标机')], sn: snState([]) });
  const backup = sections({
    messages: [chatMsg(11, '备份机')],
    keeps: [{
      id: 1, title: '那天', content: '一起看星星', createdAt: T,
      status: 'saved', sourceMessageId: 11,
    }],
    sn: snState([snRecord('sn-b', { source: source(11) })]),
  });

  const plan = BF.buildPlan({ mode: 'merge', target, backup });
  const newId = plan.idMap.messages[11];

  assert.equal(plan.room.keeps.inserts[0].sourceMessageId, newId, '珍藏来源改写行为保持不变');
  assert.equal(plan.stats.remap, 1);
  assert.equal(recById(plan.kvSet[KEY], 'sn-b').source.messageId, newId);
});

/* ---------------- M09 纯函数直测 ---------------- */
test('M09 remapSelfNarrativeSources：空映射返回原对象，非法结构原样返回', () => {
  const state = snState([snRecord('sn-1', { source: source(11) })]);

  const same = BF.remapSelfNarrativeSources(state, {}, null);
  assert.equal(same.state, state, '没有任何映射时不该产生拷贝');
  assert.equal(same.remapped, 0);

  assert.equal(BF.remapSelfNarrativeSources(null, { 11: 99 }, null).state, null);
  assert.equal(BF.remapSelfNarrativeSources({ bad: true }, { 11: 99 }, null).state.bad, true);

  const mapped = BF.remapSelfNarrativeSources(state, { 11: 99 }, null);
  assert.notEqual(mapped.state, state, '有映射时必须返回新对象，不就地改入参');
  assert.equal(state.records[0].source.messageId, 11, '原状态不能被就地修改');
  assert.equal(mapped.state.records[0].source.messageId, 99);
});

/* ---------------- N01 目标机碰巧有同 ID，但备份里没有 ---------------- */
test('N01 备份里没有原消息时，目标机同 ID 的另一条消息不能证明来源有效', () => {
  // 备份只含第 7 条；机自述引用 42 —— 而目标机恰好也有一条 id=42 的无关消息。
  const target = sections({ messages: [chatMsg(42, '目标机自己的第 42 条')], sn: snState([]) });
  const backup = sections({
    messages: [chatMsg(7, '备份的第 7 条')],
    sn: snState([snRecord('sn-gone', { source: source(42) })]),
  });

  const plan = BF.buildPlan({ mode: 'merge', target, backup });
  const sn = plan.selfNarrative;

  assert.equal(sn.unresolved, 1, '备份侧没有 42，必须记为无法验证来源');
  assert.equal(sn.unchanged, 0, '不能因为目标机有 42 就算作有效来源');
  assert.equal(sn.remapped, 0);
  assert.equal(sn.unconfirmed, 0);
  assert.equal(recById(plan.kvSet[KEY], 'sn-gone').source.messageId, 42, '无法验证也要保留原始引用');
});

/* ---------------- N02 历史版本同样按备份侧证据判定 ---------------- */
test('N02 历史快照里的悬空来源按同一规则计数，不被目标机同 ID 洗白', () => {
  const target = sections({ messages: [chatMsg(42, '目标机的第 42 条')], sn: snState([]) });
  const backup = sections({
    messages: [chatMsg(7, '备份的第 7 条')],
    sn: snState([
      snRecord('sn-h', {
        source: source(7),
        history: [historyVersion(42, '旧版一', T - 2000), historyVersion(7, '旧版二', T - 1000)],
      }),
    ]),
  });

  const plan = BF.buildPlan({ mode: 'merge', target, backup });
  const r = recById(plan.kvSet[KEY], 'sn-h');

  assert.equal(plan.selfNarrative.unresolved, 1, '只有历史里那条 42 无法验证');
  assert.equal(plan.selfNarrative.unchanged, 2, '当前版本与另一条历史都指向备份里真实存在的 7');
  assert.equal(r.history[0].source.messageId, 42, '历史里的原始引用同样保留');
  assert.equal(r.history[1].source.messageId, 7);
});

/* ---------------- N03 备份里存在且 ID 未变 ---------------- */
test('N03 备份里有这条消息、ID 未变时记为 unchanged，而不是 unresolved', () => {
  const target = sections({ messages: [chatMsg(11, '同一句')], sn: snState([]) });
  const backup = sections({
    messages: [chatMsg(11, '同一句')],
    sn: snState([
      snRecord('sn-num', { source: source(11) }),
      snRecord('sn-str', { source: source('11') }),
    ]),
  });

  const plan = BF.buildPlan({ mode: 'merge', target, backup });

  assert.deepEqual(plan.idMap.messages, {}, '内容相同不重分配');
  assert.equal(plan.selfNarrative.unchanged, 2, '数字与字符串写法都应被认定为有效');
  assert.equal(plan.selfNarrative.unresolved, 0);
  assert.equal(plan.selfNarrative.remapped, 0);
  assert.equal(recById(plan.kvSet[KEY], 'sn-str').source.messageId, '11', '未重分配就不改值');
});

/* ---------------- N04 备份里有，但落地 ID 无法确认 ---------------- */
test('N04 同 ID 内容不同、而这条内容早先已按别的 ID 导入过：记 unconfirmed 且不改值', () => {
  // 目标机 id=7 是另一条消息；备份的第 7 条内容已在目标机 id=8 上存在（上次导入换过 ID）。
  const target = sections({
    messages: [
      chatMsg(7, '目标机自己写的第 7 条'),
      chatMsg(8, '备份的第 7 条', T + 7000),
    ],
    sn: snState([]),
  });
  const backup = sections({
    messages: [chatMsg(7, '备份的第 7 条', T + 7000)],
    sn: snState([snRecord('sn-amb', { source: source(7) })]),
  });

  const plan = BF.buildPlan({ mode: 'merge', target, backup });
  const sn = plan.selfNarrative;

  assert.ok(plan.room.messages.skips.some((s) => s.reason === 'already-imported'), '夹具应命中已导入跳过');
  assert.deepEqual(plan.idMap.messages, {}, '已导入不产生新映射');
  assert.equal(sn.unconfirmed, 1, '备份里有这条消息，但落到哪个 ID 无法确认');
  assert.equal(sn.unresolved, 0, '不是「备份里没有」，不能混算成 unresolved');
  assert.equal(recById(plan.kvSet[KEY], 'sn-amb').source.messageId, 7, '不猜、不改写');
});

/* ---------------- N05 映射目标没落地 ---------------- */
test('N05 纯函数：映射目标不在导入后的房间里时，不改写并记为 unconfirmed', () => {
  const state = snState([snRecord('sn-1', { source: source(11) })]);
  const out = BF.remapSelfNarrativeSources(state, { 11: 99 }, {
    backupIds: new Set(['11']),
    roomIds: new Set([11]),      // 99 并没有真的写进房间
  });

  assert.equal(out.remapped, 0);
  assert.equal(out.unconfirmed, 1);
  assert.equal(out.state.records[0].source.messageId, 11, '宁可保留旧值，也不换成另一个悬空 ID');
});

/* ---------------- N06 没有证据时只映射、不判断 ---------------- */
test('N06 没有备份侧证据时不统计来源真伪，只做映射', () => {
  const state = snState([snRecord('sn-1', { source: source(11) })]);
  const out = BF.remapSelfNarrativeSources(state, { 11: 99 }, null);

  assert.equal(out.remapped, 1);
  assert.equal(out.state.records[0].source.messageId, 99);
  assert.equal(out.unchanged, 0);
  assert.equal(out.unconfirmed, 0);
  assert.equal(out.unresolved, 0, '无证据不等于来源缺失');
});

/* ---------------- N07 summarize 完整汇报四个数字 ---------------- */
test('N07 summarize 同时汇报 remapped / unchanged / unconfirmed / unresolved', () => {
  const target = sections({ messages: [chatMsg(11, '目标机')], sn: snState([]) });
  const backup = sections({
    messages: [chatMsg(11, '备份机'), chatMsg(12, '备份独有')],
    sn: snState([
      snRecord('sn-remap', { source: source(11) }),
      snRecord('sn-ok', { source: source(12) }),
      snRecord('sn-gone', { source: source(404) }),
    ]),
  });

  const s = BF.summarize(BF.buildPlan({ mode: 'merge', target, backup })).selfNarrative;

  assert.equal(s.remapped, 1);
  assert.equal(s.unchanged, 1);
  assert.equal(s.unconfirmed, 0);
  assert.equal(s.unresolved, 1);
});

/* ---------------- M10 summarize 汇报数字 ---------------- */
test('M10 summarize 汇报来源改写与未解析条数', () => {
  const target = sections({ messages: [chatMsg(11, '目标机')], sn: snState([]) });
  const backup = sections({
    messages: [chatMsg(11, '备份机')],
    sn: snState([
      snRecord('sn-a', { source: source(11) }),
      snRecord('sn-b', { source: source(404) }),
    ]),
  });

  const s = BF.summarize(BF.buildPlan({ mode: 'merge', target, backup }));
  assert.equal(s.selfNarrative.remapped, 1);
  assert.equal(s.selfNarrative.unresolved, 1);
});
