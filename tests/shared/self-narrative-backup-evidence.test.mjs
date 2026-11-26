/* tests/shared/self-narrative-backup-evidence.test.mjs — 备份链路上的 basis / evidence（S1a）
 * 覆盖：无重分配时证据原样 / 重分配时当前记录与 history 快照里的 evidence 一起跟随 /
 *       引用计数 / 映射表外的证据原样保留 / replace、adopt 整块搬运 /
 *       旧备份（无 evidence）仍兼容 / 证据结构不合法时整块跳过 / 目标机记录不被误改。
 * 纯 Node：buildPlan 是纯函数层，不碰 IndexedDB。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import '../../public/shared/backup-format.js';

const BF = globalThis.BackupFormat;
const KEY = 'selfNarrative.v1';
const T = 1795000000000;

/* ---------------- 夹具 ---------------- */

const chatMsg = (id, content) => ({ id, role: 'user', content, time: T + id * 1000 });

const source = (messageId) => ({ kind: 'chat', messageId, at: T, ref: 'msg:' + messageId });

const ev = (messageId, quote) => ({ messageId, quote: quote || ('原文' + messageId) });

function snRecord(id, opts) {
  const o = opts || {};
  return {
    id,
    text: o.text || ('她' + id),
    kind: o.kind || 'observation',
    observed: '',
    inferred: '',
    confirmed: '',
    question: '',
    topic: '',
    confidence: 'medium',
    basis: o.basis === undefined ? 'observed' : o.basis,
    evidence: o.evidence === undefined ? [] : o.evidence,
    source: o.source || source(11),
    status: o.status || 'active',
    revisedFrom: null,
    supersededBy: null,
    createdAt: T,
    updatedAt: o.updatedAt || (T + 1000),
    history: o.history || [],
  };
}

function version(messageId, opts) {
  const o = opts || {};
  return {
    at: T - 500,
    text: o.text || '旧版正文',
    kind: 'observation',
    observed: '',
    inferred: '',
    confirmed: '',
    question: '',
    topic: '',
    confidence: 'low',
    basis: o.basis === undefined ? 'observed' : o.basis,
    evidence: o.evidence === undefined ? [] : o.evidence,
    source: source(messageId),
    status: 'active',
    revisedFrom: null,
  };
}

function snState(records) {
  return { schema: 1, key: KEY, createdAt: T, updatedAt: T + 9000, records };
}

function sections(o) {
  o = o || {};
  return {
    room: {
      kv: Object.assign({}, o.sn ? { [KEY]: o.sn } : {}),
      messages: o.messages || [],
      keeps: [], diaries: [], starDiaries: [], futureLetters: [],
    },
    butler: { tasks: [], transactions: [], cycles: [], sleepLogs: [], meta: [] },
    localStorage: {},
    radioVoice: { clips: [] },
    chatVoice: { clips: [] },
  };
}

const recById = (state, id) => {
  const r = (state.records || []).find((x) => x.id === id);
  assert.ok(r, '找不到记录 ' + id);
  return r;
};

/* ---------------- B01 无重分配：证据原样 ---------------- */
test('B01 消息 ID 未变时，记录与历史版本里的 evidence 一字不动', () => {
  const list = [chatMsg(11, '同一句'), chatMsg(12, '另一句')];
  const target = sections({ messages: list, sn: snState([]) });
  const backup = sections({
    messages: list,
    sn: snState([snRecord('sn-1', {
      evidence: [ev(11), ev(12)],
      history: [version(11, { evidence: [ev(11)] })],
    })]),
  });

  const plan = BF.buildPlan({ mode: 'merge', target, backup });
  assert.deepEqual(plan.idMap.messages, {});
  const rec = recById(plan.kvSet[KEY], 'sn-1');
  assert.deepEqual(rec.evidence, [ev(11), ev(12)]);
  assert.deepEqual(rec.history[0].evidence, [ev(11)]);
  assert.equal(rec.basis, 'observed');
});

/* ---------------- B02 重分配：证据跟随 ---------------- */
test('B02 消息 ID 重分配时，evidence 与 history 快照里的 evidence 一起跟随', () => {
  const target = sections({ messages: [chatMsg(11, '目标机的第 11 条')], sn: snState([]) });
  const backup = sections({
    messages: [chatMsg(11, '备份机的第 11 条')],
    sn: snState([snRecord('sn-b', {
      source: source(11),
      evidence: [ev(11), ev(11, '另一段原文')],
      history: [version(11, { evidence: [ev(11)] })],
    })]),
  });

  const plan = BF.buildPlan({ mode: 'merge', target, backup });
  const newId = plan.idMap.messages[11];
  assert.ok(newId != null && newId !== 11, '应产生重分配');

  const rec = recById(plan.kvSet[KEY], 'sn-b');
  assert.equal(rec.evidence[0].messageId, newId, '第一条 evidence 跟随映射');
  assert.equal(rec.evidence[1].messageId, newId);
  assert.equal(rec.evidence[0].quote, '原文11', 'quote 不被改写');
  assert.equal(rec.history[0].evidence[0].messageId, newId, '历史快照里的 evidence 也要跟随');
  assert.equal(rec.history[0].source.messageId, newId);
});

/* ---------------- B03 计数按引用处数 ---------------- */
test('B03 同一条记录里 source 与 evidence 各算一处引用', () => {
  const target = sections({ messages: [chatMsg(11, '目标机')], sn: snState([]) });
  const backup = sections({
    messages: [chatMsg(11, '备份机')],
    sn: snState([snRecord('sn-1', {
      source: source(11),
      evidence: [ev(11)],
    })]),
  });

  const plan = BF.buildPlan({ mode: 'merge', target, backup });
  assert.equal(plan.selfNarrative.remapped, 2, 'source 一处 + evidence 一处');
  assert.equal(plan.selfNarrative.unresolved, 0);
});

/* ---------------- B04 映射表外 ---------------- */
test('B04 备份里不存在的证据 ID 原样保留，只计入 unresolved', () => {
  const target = sections({ messages: [chatMsg(11, '目标机')], sn: snState([]) });
  const backup = sections({
    messages: [chatMsg(11, '备份机')],
    sn: snState([snRecord('sn-1', {
      source: source(11),
      evidence: [ev(11), ev(999, '备份里没有这条消息')],
    })]),
  });

  const plan = BF.buildPlan({ mode: 'merge', target, backup });
  const rec = recById(plan.kvSet[KEY], 'sn-1');
  assert.equal(rec.evidence[1].messageId, 999, '不猜、不置空、不模糊匹配');
  assert.equal(rec.evidence[1].quote, '备份里没有这条消息');
  assert.equal(plan.selfNarrative.unresolved, 1);
});

/* ---------------- B05 replace 整块搬运 ---------------- */
test('B05 replace 模式整块替换，evidence 与 basis 完整保留', () => {
  const target = sections({
    messages: [chatMsg(11, '目标机')],
    sn: snState([snRecord('sn-old', { text: '目标机自己的记录' })]),
  });
  const backup = sections({
    messages: [chatMsg(11, '备份机')],
    sn: snState([snRecord('sn-new', {
      basis: 'stated',
      evidence: [ev(11), ev(12)],
      history: [version(11, { evidence: [ev(12)] })],
    })]),
  });

  const plan = BF.buildPlan({ mode: 'replace', target, backup });
  const state = plan.kvSet[KEY];
  assert.equal(state.records.length, 1, '整体替换，只剩备份侧记录');
  assert.equal(state.records[0].basis, 'stated');
  assert.equal(state.records[0].evidence.length, 2);
  assert.equal(state.records[0].history[0].evidence[0].messageId, 12);
});

/* ---------------- B06 adopt 整块接管 ---------------- */
test('B06 目标机没有该键时整块接管，证据不丢', () => {
  const target = sections({ messages: [chatMsg(11, '目标机')] });
  const backup = sections({
    messages: [chatMsg(11, '备份机')],
    sn: snState([snRecord('sn-1', { evidence: [ev(11)], basis: 'inferred' })]),
  });

  const plan = BF.buildPlan({ mode: 'merge', target, backup });
  assert.equal(plan.selfNarrative.action, 'adopt');
  const rec = recById(plan.kvSet[KEY], 'sn-1');
  assert.equal(rec.basis, 'inferred');
  assert.equal(rec.evidence.length, 1);
});

/* ---------------- B07 旧备份兼容 ---------------- */
test('B07 没有 basis / evidence 的旧备份仍然通过校验并正常合并', () => {
  const legacy = snRecord('sn-legacy');
  delete legacy.basis;
  delete legacy.evidence;

  assert.equal(BF.isSelfNarrative(snState([legacy])), true, '缺新字段不得让旧备份变非法');

  const target = sections({ messages: [chatMsg(11, '目标机')], sn: snState([]) });
  const backup = sections({ messages: [chatMsg(11, '目标机')], sn: snState([legacy]) });
  const plan = BF.buildPlan({ mode: 'merge', target, backup });

  const rec = recById(plan.kvSet[KEY], 'sn-legacy');
  assert.equal(rec.text, '她sn-legacy');
  assert.equal('basis' in rec, false, '不凭空补字段');
});

/* ---------------- B08 非法证据整块跳过 ---------------- */
test('B08 evidence 结构不合法时整块跳过，绝不用半截数据覆盖', () => {
  const broken = snState([snRecord('sn-1', { evidence: [{ messageId: 11 }] })]);  // 缺 quote
  assert.equal(BF.isSelfNarrative(broken), false);

  const target = sections({
    messages: [chatMsg(11, '目标机')],
    sn: snState([snRecord('sn-keep', { text: '目标机原有内容' })]),
  });
  const backup = sections({ messages: [chatMsg(11, '目标机')], sn: broken });
  const plan = BF.buildPlan({ mode: 'merge', target, backup });

  assert.equal(plan.selfNarrative.action, 'skip');
  // kvSet 是「要写什么」的映射：跳过时根本不含该键，目标机数据不会被碰。
  assert.equal(KEY in plan.kvSet, false, '非法备份不得产生任何写入');
  assert.equal(recById(target.room.kv[KEY], 'sn-keep').text, '目标机原有内容');
});

/* ---------------- B09 目标机证据不被误改 ---------------- */
test('B09 目标机自有记录的 evidence 不参与备份侧映射', () => {
  const target = sections({
    messages: [chatMsg(11, '目标机的第 11 条')],
    sn: snState([snRecord('sn-t', { source: source(11), evidence: [ev(11, '目标机原文')] })]),
  });
  const backup = sections({
    messages: [chatMsg(11, '备份机的第 11 条')],
    sn: snState([snRecord('sn-b', { source: source(11), evidence: [ev(11, '备份机原文')] })]),
  });

  const plan = BF.buildPlan({ mode: 'merge', target, backup });
  const rec = recById(plan.kvSet[KEY], 'sn-t');
  assert.equal(rec.evidence[0].messageId, 11, '目标机记录指向自己的消息，不该被改');
  assert.equal(rec.evidence[0].quote, '目标机原文');
});

/* ---------------- B10 summarize 暴露数字 ---------------- */
test('B10 summarize 里能看到 remapped 与 unresolved', () => {
  const target = sections({ messages: [chatMsg(11, '目标机')], sn: snState([]) });
  const backup = sections({
    messages: [chatMsg(11, '备份机')],
    sn: snState([snRecord('sn-1', { source: source(11), evidence: [ev(11), ev(888)] })]),
  });

  const plan = BF.buildPlan({ mode: 'merge', target, backup });
  const sum = BF.summarize(plan, {});
  assert.equal(sum.selfNarrative.remapped, 2);
  assert.equal(sum.selfNarrative.unresolved, 1);
});
