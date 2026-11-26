/* tests/shared/self-narrative-fields.test.mjs — 机自述 basis / evidence 字段（S1a）
 * 覆盖：新字段创建、读取、修改、history 往返 / 旧记录无新字段仍合法 /
 *       basis 语义不变量（stated 不自动确认、inferred 不许 confirmed 与 high）/
 *       主证据与第一条 evidence 一致性 / 未知字段仍被拒绝 / 撤回后证据保留。
 * 纯 Node：不开浏览器、不碰真实 IndexedDB。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import '../../public/shared/self-narrative.js';

const SN = globalThis.SelfNarrative;
const T0 = 1795000000000;
const at = (n) => T0 + n * 60000;

function store(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    map,
    async get(k) { return map.has(k) ? map.get(k) : undefined; },
    async set(k, v) { map.set(k, v); },
  };
}

function stateOf(s) { return s.map.get(SN.KEY); }
function recs(s) { return stateOf(s).records; }
function one(s) { return recs(s)[0]; }

function storeWith(records) {
  const st = SN.emptyState(T0);
  st.records = records;
  return store({ [SN.KEY]: st });
}

const base = (over) => Object.assign({
  text: '她今天说话的时候一直在笑',
  kind: 'observation',
  observed: '笑起来会先低头',
  source: { kind: 'chat', messageId: 12, at: at(0) },
  evidence: [{ messageId: 12, quote: '她今天说话的时候一直在笑' }],
  basis: 'observed',
}, over || {});

/* ---------------- F01 新字段落库 ---------------- */
test('F01 create 落库 basis 与多条 evidence，source.messageId 即主证据', async () => {
  const s = store();
  const r = await SN.create(s, base({
    evidence: [
      { messageId: 12, quote: '她今天说话的时候一直在笑' },
      { messageId: 13, quote: '笑起来会先低头' },
      { messageId: 14, quote: '她说自己不擅长表达' },
    ],
  }), { now: at(1) });

  assert.equal(r.ok, true, r.reason);
  const rec = one(s);
  assert.equal(rec.basis, 'observed');
  assert.equal(rec.evidence.length, 3);
  assert.deepEqual(rec.evidence[0], { messageId: 12, quote: '她今天说话的时候一直在笑' });
  assert.equal(rec.evidence[1].messageId, 13);
  assert.equal(rec.source.messageId, 12, 'source.messageId 保留为主证据');
});

/* ---------------- F02 非法 basis ---------------- */
test('F02 非法 basis 明确报错，不猜默认值', async () => {
  const s = store();
  const r = await SN.create(s, base({ basis: 'guessed' }), { now: at(1) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid-basis');
  assert.equal(stateOf(s), undefined, '失败不落库');
});

/* ---------------- F03 非法 evidence ---------------- */
test('F03 evidence 形状不合法时逐项报错', async () => {
  const cases = [
    ['x', 'not-an-array'],
    [[{ messageId: 12 }], 'quote-0'],
    [[{ quote: '她笑了' }], 'messageId-0'],
    [[{ messageId: 1.5, quote: '她笑了' }], 'messageId-0'],
    [[{ messageId: '', quote: '她笑了' }], 'messageId-0'],
    [[null], 'item-0'],
  ];
  for (const [ev, detail] of cases) {
    const s = store();
    const r = await SN.create(s, base({ evidence: ev }), { now: at(1) });
    assert.equal(r.ok, false, '应拒绝：' + JSON.stringify(ev));
    assert.equal(r.reason, 'invalid-evidence');
    assert.equal(r.detail, detail, 'detail 应指向 ' + detail);
  }
});

/* ---------------- F04 主证据一致性 ---------------- */
test('F04 source.messageId 与第一条 evidence 不一致 → 拒绝', async () => {
  const s = store();
  const r = await SN.create(s, base({
    source: { kind: 'chat', messageId: 12, at: at(0) },
    evidence: [{ messageId: 99, quote: '她今天说话的时候一直在笑' }],
  }), { now: at(1) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'evidence-source-mismatch');
});

test('F04b 字符串与数字写法视为同一条主证据', async () => {
  const s = store();
  const r = await SN.create(s, base({
    source: { kind: 'chat', messageId: 12, at: at(0) },
    evidence: [{ messageId: '12', quote: '她今天说话的时候一直在笑' }],
  }), { now: at(1) });
  assert.equal(r.ok, true, r.reason);
});

/* ---------------- F05 stated 不自动确认 ---------------- */
test('F05 basis=stated 不会自动填 confirmed', async () => {
  const s = store();
  const r = await SN.create(s, base({
    kind: 'inference',
    basis: 'stated',
    inferred: '她好像不太喜欢被人替她做决定',
    evidence: [{ messageId: 12, quote: '她说她不喜欢别人替她安排' }],
  }), { now: at(1) });
  assert.equal(r.ok, true, r.reason);
  assert.equal(one(s).confirmed, '', '她说过 ≠ 她确认了这个判断');
  assert.equal(one(s).basis, 'stated');
});

/* ---------------- F06 inferred 的硬约束 ---------------- */
test('F06 basis=inferred 时 confirmed 必须为空、confidence 不得为 high', async () => {
  const withConfirmed = await SN.create(store(), base({
    kind: 'inference', basis: 'inferred', confirmed: '她确认过',
  }), { now: at(1) });
  assert.equal(withConfirmed.ok, false);
  assert.equal(withConfirmed.reason, 'confirmed-not-allowed');

  const tooSure = await SN.create(store(), base({
    kind: 'inference', basis: 'inferred', confidence: 'high',
  }), { now: at(1) });
  assert.equal(tooSure.ok, false);
  assert.equal(tooSure.reason, 'confidence-too-high');

  const ok = await SN.create(store(), base({
    kind: 'inference', basis: 'inferred', confidence: 'medium',
  }), { now: at(1) });
  assert.equal(ok.ok, true, ok.reason);
});

/* ---------------- F07 修改后 history 保留 basis / evidence ---------------- */
test('F07 update 修订时，history 完整保留旧的 basis 与 evidence', async () => {
  const s = store();
  await SN.create(s, base({ basis: 'observed' }), { now: at(1) });
  const id = one(s).id;

  const up = await SN.update(s, id, {
    text: '她笑的时候会先低头，好像有点不好意思',
    basis: 'inferred',
    confidence: 'medium',
    evidence: [
      { messageId: 12, quote: '她今天说话的时候一直在笑' },
      { messageId: 15, quote: '低头' },
    ],
  }, { now: at(5) });
  assert.equal(up.ok, true, up.reason);

  const rec = one(s);
  assert.equal(rec.basis, 'inferred');
  assert.equal(rec.evidence.length, 2);
  assert.equal(rec.evidence[1].messageId, 15);
  assert.equal(rec.history.length, 1);

  const old = rec.history[0];
  assert.equal(old.basis, 'observed', '旧版 basis 必须留在快照里');
  assert.equal(old.evidence.length, 1, '旧版 evidence 必须留在快照里');
  assert.equal(old.evidence[0].messageId, 12);
  assert.equal(old.text, '她今天说话的时候一直在笑');
});

/* ---------------- F08 旧记录仍合法 ---------------- */
test('F08 没有 basis / evidence 的旧记录依然合法，且能被正常读写', async () => {
  const legacy = SN.makeRecord({
    text: '她好像喜欢下雨天', kind: 'impression',
    source: { kind: 'chat', messageId: 20, at: at(0) }, now: at(0),
  });
  delete legacy.basis;
  delete legacy.evidence;

  const s = storeWith([legacy]);
  assert.equal(SN.isValidState(stateOf(s)), true, '缺新字段不得让旧数据变非法');

  const got = await SN.get(s, legacy.id);
  assert.equal(got.ok, true, got.reason);
  assert.equal(got.record.text, '她好像喜欢下雨天');

  const up = await SN.update(s, legacy.id, { text: '她好像更喜欢下雨天' }, { now: at(9) });
  assert.equal(up.ok, true, up.reason);
  assert.equal(one(s).text, '她好像更喜欢下雨天');
  assert.equal(SN.isValidState(stateOf(s)), true);
});

/* ---------------- F09 缺省值 ---------------- */
test('F09 未给 basis 时落库为 null、evidence 为空数组（不猜）', async () => {
  const rec = SN.makeRecord({
    text: '她今天很安静', kind: 'observation',
    source: { kind: 'manual' }, now: at(0),
  });
  assert.equal(rec.basis, null);
  assert.deepEqual(rec.evidence, []);
});

/* ---------------- F10 未知字段仍被拒 ---------------- */
test('F10 扩白名单没有放宽成「什么都收」：未知字段照旧拒绝', async () => {
  const r = await SN.create(store(), base({ mood: '开心' }), { now: at(1) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid-field');
  assert.equal(r.detail, 'mood');
});

/* ---------------- F11 读取与筛选 ---------------- */
test('F11 get / list 都能读到 basis 与 evidence', async () => {
  const s = store();
  await SN.create(s, base({ kind: 'observation' }), { now: at(1) });
  await SN.create(s, base({
    kind: 'inference', basis: 'inferred', confidence: 'low',
    text: '我猜她其实有点怕生',
    evidence: [{ messageId: 30, quote: '我猜她其实有点怕生' }],
    source: { kind: 'chat', messageId: 30, at: at(0) },
  }), { now: at(2) });

  const all = await SN.list(s, { status: 'all' });
  assert.equal(all.ok, true);
  assert.equal(all.total, 2);
  all.records.forEach((r) => {
    assert.equal(Array.isArray(r.evidence), true);
    assert.ok(r.basis === 'observed' || r.basis === 'inferred');
  });

  const inferredOnly = await SN.list(s, { status: 'all', kind: 'inference' });
  assert.equal(inferredOnly.total, 1);
  assert.equal(inferredOnly.records[0].basis, 'inferred');
  assert.equal(inferredOnly.records[0].evidence[0].messageId, 30);
});

/* ---------------- F12 撤回保留证据 ---------------- */
test('F12 撤回只改状态，证据与依据原样保留', async () => {
  const s = store();
  await SN.create(s, base({ basis: 'stated' }), { now: at(1) });
  const id = one(s).id;

  const r = await SN.retract(s, id, { now: at(6) });
  assert.equal(r.ok, true, r.reason);

  const rec = one(s);
  assert.equal(rec.status, 'retracted');
  assert.equal(rec.basis, 'stated');
  assert.equal(rec.evidence[0].messageId, 12);
  assert.equal(rec.history.length, 1, '撤回也留一版快照');
  assert.equal(rec.history[0].evidence[0].messageId, 12);
});

/* ---------------- F13 只改 confidence 也走合并后校验 ---------------- */
test('F13 已存在 inferred 记录时，单改 confidence=high 被拒', async () => {
  const s = store();
  await SN.create(s, base({ kind: 'inference', basis: 'inferred', confidence: 'medium' }), { now: at(1) });
  const id = one(s).id;

  const r = await SN.update(s, id, { confidence: 'high' }, { now: at(4) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'confidence-too-high');
  assert.equal(one(s).confidence, 'medium', '失败不改动原记录');
  assert.equal(one(s).history.length, 0, '失败不产生历史版本');
});

/* ---------------- F14 校验工具导出 ---------------- */
test('F14 纯函数导出可用于外部预检', () => {
  assert.deepEqual(SN.BASES, ['stated', 'observed', 'inferred']);
  assert.equal(SN.checkSemantics({ basis: 'inferred', confirmed: 'x', confidence: 'low' }), 'confirmed-not-allowed');
  assert.equal(SN.checkSemantics({ basis: 'inferred', confirmed: '', confidence: 'high' }), 'confidence-too-high');
  assert.equal(SN.checkSemantics({ basis: 'stated', confirmed: '她确认过', confidence: 'high' }), null);
  assert.equal(SN.checkSemantics({}), null, '没有 basis 的旧记录不校验');

  const bad = SN.parseEvidence([{ messageId: 1, quote: '  ' }]);
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'invalid-evidence');
  assert.deepEqual(SN.parseEvidence(null), { ok: true, value: [] });
});
