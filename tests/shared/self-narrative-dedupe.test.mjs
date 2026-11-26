/* tests/shared/self-narrative-dedupe.test.mjs — S1 修正：判重与历史读取
 * 覆盖：原型键崩溃 / 旧记录按 source.messageId 回退 / 认识内容四字段比较 /
 *       无效 ID 不纳入证据集合 / historyOf 读取 basis + evidence 且不改动数据。
 * 纯 Node：不调 AI、不碰 IndexedDB（store 用内存适配器注入）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import '../../public/shared/self-narrative-review.js';
import '../../public/shared/self-narrative.js';

const R = globalThis.SelfNarrativeReview;
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

const rec = (over) => Object.assign({
  id: 'sn-1',
  kind: 'observation',
  text: '她笑起来会先低头',
  observed: '说话时会先低头',
  inferred: '',
  question: '',
  evidence: [{ messageId: 1, quote: '她笑了' }],
}, over || {});

/* ================= 一、原型键 ================= */

test('D01 constructor / __proto__ 等文本不会让索引与判重抛异常', () => {
  const weird = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'isPrototypeOf'];
  weird.forEach((txt) => {
    const index = R.buildDedupeIndex([rec({ id: 'sn-x', text: txt })]);
    assert.equal(index.count, 1, txt + ' 应正常入索引');
    assert.equal(R.isDuplicate(rec({ text: txt }), index).duplicate, true, txt + ' 同内容应判重');
    assert.equal(R.isDuplicate(rec({ text: txt + '呀' }), index).duplicate, false, txt + ' 不同内容不该判重');
  });
});

test('D02 判定结果可正常取出，of 里是被命中的记录 id', () => {
  const index = R.buildDedupeIndex([rec({ id: 'sn-hit', text: 'constructor' })]);
  const out = R.isDuplicate(rec({ text: 'constructor', id: undefined }), index);
  assert.equal(out.duplicate, true);
  assert.deepEqual(out.of, ['sn-hit']);
  assert.equal(out.reason, 'same-evidence-kind-content');
});

test('D03 无原型结构的旧式索引对象也不会命中原型属性', () => {
  // 手工构造：外层键不存在，但原型上有 constructor；内层同样空。
  const legacy = { byKey: {} };
  assert.equal(R.isDuplicate(rec({ text: 'constructor' }), legacy).duplicate, false);
  assert.equal(R.isDuplicate(rec({ text: 'constructor' }), legacy).reason, 'no-same-evidence');
});

/* ================= 二、旧记录回退到 source.messageId ================= */

test('D04 旧记录只有 source.messageId 时，与新记录 evidence 同源同文仍判重', () => {
  const old = {
    id: 'sn-old', kind: 'observation', text: '她不太喜欢被安排',
    observed: '', inferred: '', question: '',
    evidence: [], source: { kind: 'chat', messageId: 7 },
  };
  const index = R.buildDedupeIndex([old]);
  assert.equal(index.count, 1, '回退后应进索引');
  assert.equal(index.noEvidence, 0);

  const fresh = rec({ text: '她不太喜欢被安排', observed: '', inferred: '', question: '',
    evidence: [{ messageId: 7, quote: '别替我决定' }] });
  const d = R.isDuplicate(fresh, index);
  assert.equal(d.duplicate, true, 'S2 重跑不该再生成一条');
  assert.deepEqual(d.of, ['sn-old']);
});

test('D05 数字与字符串 ID 按同一规则归一，回退也能对上', () => {
  const old = { id: 'sn-old', kind: 'observation', text: '同一句话', evidence: [], source: { kind: 'chat', messageId: '7' } };
  const index = R.buildDedupeIndex([old]);
  assert.equal(R.isDuplicate(rec({ text: '同一句话', observed: '', inferred: '', question: '',
    evidence: [{ messageId: 7, quote: 'q' }] }), index).duplicate, true);

  const index2 = R.buildDedupeIndex([rec({ id: 'sn-n', text: '同一句话', observed: '', inferred: '', question: '', evidence: [{ messageId: 7, quote: 'q' }] })]);
  assert.equal(R.isDuplicate({ kind: 'observation', text: '同一句话', observed: '', inferred: '', question: '',
    evidence: [], source: { kind: 'chat', messageId: '7' } }, index2).duplicate, true);
});

test('D06 有 evidence 时不混入 source.messageId', () => {
  assert.deepEqual(R.evidenceIdsOf({ evidence: [{ messageId: 1 }], source: { messageId: 7 } }), ['1']);
});

test('D07 两者都没有（或 ID 无效）时不伪造证据，记录不进索引', () => {
  assert.deepEqual(R.evidenceIdsOf({ evidence: [], source: { kind: 'chat' } }), []);
  assert.deepEqual(R.evidenceIdsOf({ evidence: [{ messageId: 1.5 }, { messageId: '' }, { messageId: '  ' }, { messageId: {} }] }), []);
  assert.deepEqual(R.evidenceIdsOf({ evidence: [], source: { messageId: 2.5 } }), []);

  const index = R.buildDedupeIndex([
    { id: 'sn-a', kind: 'observation', text: '无从定位', evidence: [], source: { kind: 'manual' } },
    { id: 'sn-b', kind: 'observation', text: '无从定位', evidence: [], source: { kind: 'chat', messageId: 3.5 } },
  ]);
  assert.equal(index.count, 0);
  assert.equal(index.noEvidence, 2);
  assert.equal(R.isDuplicate(rec({ text: '无从定位', evidence: [{ messageId: 1 }] }), index).duplicate, false);
});

test('D08 字符串 ID 去空白后纳入证据集合', () => {
  assert.deepEqual(R.evidenceIdsOf({ evidence: [{ messageId: ' 12 ' }] }), ['12']);
  assert.deepEqual(R.evidenceIdsOf({ evidence: [{ messageId: 12 }, { messageId: '12' }] }), ['12'], '同一条消息不重复计');
});

/* ================= 三、认识内容四字段比较 ================= */

test('D09 text 相同但 observed / inferred / question 任一不同，都不算重复', () => {
  const index = R.buildDedupeIndex([rec({ id: 'sn-base' })]);
  const same = () => rec({ id: undefined });

  assert.equal(R.isDuplicate(Object.assign(same(), { observed: '她低头笑了一下' }), index).duplicate, false, 'observed 不同');
  assert.equal(R.isDuplicate(Object.assign(same(), { inferred: '她有点紧张' }), index).duplicate, false, 'inferred 不同');
  assert.equal(R.isDuplicate(Object.assign(same(), { question: '她是不是怕被看见' }), index).duplicate, false, 'question 不同');
  assert.equal(R.isDuplicate(Object.assign(same(), { text: '她笑的时候会先低头' }), index).duplicate, false, 'text 不同');
});

test('D10 四个认识字段规范化后都相同才算重复', () => {
  const index = R.buildDedupeIndex([rec({ id: 'sn-base' })]);
  const near = rec({
    id: undefined,
    text: '她笑起来会先低头。',
    observed: '说话时，会先低头',
    inferred: '',
    question: '',
  });
  assert.equal(R.isDuplicate(near, index).duplicate, true, '只差标点应判重');
});

test('D11 confidence / basis / confirmed / topic 不同不影响判重', () => {
  const index = R.buildDedupeIndex([rec({ id: 'sn-base', confidence: 'low', basis: 'observed', confirmed: '', topic: '' })]);
  const other = rec({
    id: undefined,
    confidence: 'high',
    basis: 'stated',
    confirmed: '她说过自己会这样',
    topic: '性格',
  });
  assert.equal(R.isDuplicate(other, index).duplicate, true, '这些字段会变，不该造成重复生成');
});

test('D12 evidence 仅部分交集不算重复；集合相同顺序不同算重复', () => {
  const index = R.buildDedupeIndex([rec({
    id: 'sn-two',
    evidence: [{ messageId: 1, quote: 'a' }, { messageId: 2, quote: 'b' }],
  })]);

  const partial = rec({ id: undefined, evidence: [{ messageId: 1, quote: 'a' }, { messageId: 3, quote: 'c' }] });
  assert.equal(R.isDuplicate(partial, index).duplicate, false, '部分交集 ≠ 集合相同');

  const reordered = rec({ id: undefined, evidence: [{ messageId: 2, quote: 'b' }, { messageId: 1, quote: 'a' }] });
  assert.equal(R.isDuplicate(reordered, index).duplicate, true, '顺序不影响集合');

  const superset = rec({ id: undefined, evidence: [{ messageId: 1, quote: 'a' }, { messageId: 2, quote: 'b' }, { messageId: 3, quote: 'c' }] });
  assert.equal(R.isDuplicate(superset, index).duplicate, false, '超集也不算同一集合');
});

test('D13 同一证据支撑不同认识时允许并存（不因 evidence 有交集判重）', () => {
  const index = R.buildDedupeIndex([rec({ id: 'sn-a', text: '她不喜欢被安排', evidence: [{ messageId: 1, quote: 'a' }] })]);
  const other = rec({ id: undefined, kind: 'inference', text: '她需要先被问过再做决定', evidence: [{ messageId: 1, quote: 'a' }] });
  assert.equal(R.isDuplicate(other, index).duplicate, false);

  const out = R.applyDedupe([other], index);
  assert.equal(out.accepted.length, 1);
  assert.equal(out.skipped.length, 0);
});

/* ================= 四、historyOf 读取 basis / evidence ================= */

test('D14 修订后历史快照能读到 basis 与 evidence，且与当前版分开', async () => {
  const s = store();
  const made = await SN.create(s, {
    text: '她不太喜欢被安排',
    kind: 'inference',
    inferred: '被替她决定会不自在',
    confidence: 'low',
    basis: 'inferred',
    evidence: [{ messageId: 7, quote: '别替我决定' }],
    source: { kind: 'chat', messageId: 7, at: at(0) },
  }, { now: at(0) });
  assert.equal(made.ok, true);

  const upd = await SN.update(s, made.id, {
    text: '她在意的是先被问一声',
    confidence: 'medium',
    evidence: [{ messageId: 7, quote: '别替我决定' }, { messageId: 8, quote: '先问我' }],
  }, { now: at(1) });
  assert.equal(upd.ok, true);

  const h = await SN.historyOf(s, made.id);
  assert.equal(h.ok, true);
  assert.equal(h.versions.length, 2, '快照 + 当前');

  const [old, cur] = h.versions;
  assert.equal(old.basis, 'inferred');
  assert.deepEqual(old.evidence, [{ messageId: 7, quote: '别替我决定' }], '旧版证据链完整');
  assert.equal(old.current, false);
  assert.equal(cur.basis, 'inferred');
  assert.deepEqual(cur.evidence.map((e) => e.messageId), [7, 8]);
  assert.equal(cur.current, true);
});

test('D15 旧记录没有 basis / evidence 时仍能读历史，缺省为 null / []', async () => {
  const state = {
    schema: 1, key: SN.KEY, createdAt: at(0), updatedAt: at(1),
    records: [{
      id: 'sn-legacy', text: '旧版正文', kind: 'observation',
      observed: '', inferred: '', confirmed: '', question: '', confidence: 'medium', topic: '',
      source: { kind: 'chat', messageId: 9 }, status: 'active', revisedFrom: null,
      createdAt: at(0), updatedAt: at(1),
      history: [{
        at: at(0), text: '更早的正文', kind: 'observation',
        observed: '', inferred: '', confirmed: '', question: '', confidence: 'medium', topic: '',
        source: { kind: 'chat', messageId: 9 }, status: 'active', revisedFrom: null, historyLength: 0,
      }],
    }],
  };
  const s = store({ [SN.KEY]: state });

  const h = await SN.historyOf(s, 'sn-legacy');
  assert.equal(h.ok, true, '旧记录不能被判成非法状态');
  assert.equal(h.versions.length, 2);
  h.versions.forEach((v) => {
    assert.equal('basis' in v, true, '字段存在');
    assert.equal(v.basis, null);
    assert.deepEqual(v.evidence, []);
  });
});

test('D16 读取历史不修改原记录与快照', async () => {
  const s = store();
  const made = await SN.create(s, {
    text: '她说话很快', kind: 'observation', basis: 'observed',
    evidence: [{ messageId: 3, quote: '她说得很快' }],
    source: { kind: 'chat', messageId: 3, at: at(0) },
  }, { now: at(0) });
  await SN.update(s, made.id, { text: '她说话快，但会停下来等我' }, { now: at(1) });

  const before = JSON.stringify(s.map.get(SN.KEY));
  const h1 = await SN.historyOf(s, made.id);
  const h2 = await SN.historyOf(s, made.id);
  const after = JSON.stringify(s.map.get(SN.KEY));

  assert.equal(after, before, '读两次都不能改动存储');
  assert.deepEqual(h1.versions, h2.versions, '两次读取结果一致');
  assert.notEqual(h1.versions[0].evidence, h1.current.evidence, '返回的是副本，不是同一引用');
});
