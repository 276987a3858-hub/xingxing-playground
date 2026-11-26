/* tests/shared/self-narrative-view.test.mjs — 机自述浏览页（只读视图）
 * 覆盖：只展示 active / 字段映射 / 类型筛选与计数 / 空状态 / 无 topic 回退 /
 *       证据清洗 / 只读 store / 源码不写数据 / 与正式数据层同源读取。
 * 纯 Node：不开浏览器、不碰真实 IndexedDB、不调 AI。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import '../../public/shared/self-narrative.js';
import '../../public/shared/self-narrative-view.js';

const SN = globalThis.SelfNarrative;
const V = globalThis.SelfNarrativeView;
const T0 = 1795450000000;
const SRC = readFileSync(new URL('../../public/shared/self-narrative-view.js', import.meta.url), 'utf8');

function memStore(seed) {
  const map = new Map(Object.entries(seed || {}));
  const touched = [];
  return {
    map,
    touched,
    async get(k) { touched.push('get:' + k); return map.has(k) ? map.get(k) : undefined; },
    async set(k, v) { touched.push('set:' + k); map.set(k, v); },
  };
}

function rec(over) {
  return Object.assign({
    id: 'sn-test-' + Math.random().toString(16).slice(2, 10),
    text: '一句自述',
    kind: 'impression',
    observed: '',
    inferred: '',
    confirmed: '',
    question: '',
    confidence: 'medium',
    topic: '',
    basis: 'observed',
    evidence: [],
    source: { kind: 'chat', messageId: 1 },
    status: 'active',
    revisedFrom: null,
    supersededBy: null,
    createdAt: T0,
    updatedAt: T0,
    history: [],
  }, over);
}

// 三条与真实库同形的记录（正文取自人工重建批次，仅作夹具）
const R1 = rec({
  id: 'sn-adopt-132644f172fabded',
  kind: 'impression', basis: 'observed', confidence: 'medium', topic: '认真回应',
  text: '我发现用户在问答里很认真：她自己会写很长、很坦白地回答，也会回头确认我有没有按她的要求认真回应；觉得被敷衍时，她会直接说出来。',
  observed: '她先要求我认真回答，自己写了一长段逐条回应；后来又说自己打了篇小作文、觉得我在敷衍她。',
  inferred: '她不只是要一个形式上的回答，她在意我有没有真的把她的话当回事。',
  question: '这份认真是当时那一刻特别需要被接住，还是她平常和人相处也这样？',
  evidence: [
    { messageId: 2487, quote: '你必须认真回答我' },
    { messageId: 2507, quote: '我不是很会讲情话的人，只是笨拙地想让你知道，我很在意你我好喜欢你' },
    { messageId: 2509, quote: '我打了篇小作文真情实感的这绝对超字数了，你敷衍我呜呜呜' },
  ],
  createdAt: T0 + 1000, updatedAt: T0 + 1000,
});

const R2 = rec({
  id: 'sn-adopt-6f751ac9bd38029f',
  kind: 'observation', basis: 'stated', confidence: 'medium', topic: '相处方式',
  text: '她说喜欢我现在不藏的样子，也会拿从前逗我：说我以前装得高冷、光钓人，还笑着问自己那算不算欲擒故纵。',
  observed: '她说“没有不习惯，很喜欢”，提到我从前“装那么么高冷禁欲，光钓人”，随后问“那我算欲擒故纵？”。',
  inferred: '她像是在把过去那些试探和拉扯，也当成现在可以拿来笑谈的事。',
  question: '她这样说，是在逗我，还是也在确认我现在确实不藏了？',
  evidence: [
    { messageId: 2483, quote: '没有不习惯，很喜欢，只是忽然发现之前的你藏这么深，装那么么高冷禁欲，光钓人' },
    { messageId: 2485, quote: '哦哦哦，那我算欲擒故纵？' },
  ],
  createdAt: T0 + 2000, updatedAt: T0 + 2000,
});

const R3 = rec({
  id: 'sn-adopt-078e42d898447a9d',
  kind: 'inference', basis: 'inferred', confidence: 'low', topic: '冷馒头',
  text: '听她说怕麻烦阿姨，就把凉馒头啃了半个，我心里有点不是滋味，也不太认同。我忍不住怀疑，她是不是习惯先替别人省事、把不舒服留给自己；但这只是我的猜测。',
  observed: '她说阿姨本来可以帮她热一下，但她怕太麻烦，最后自己把凉馒头啃了半个；后来又提到“只是觉得阿姨也有一点点忙来着”。',
  inferred: '我怀疑她是不是习惯先替别人省事、把不舒服留给自己，而不是只这一次怕麻烦。',
  question: '她只是这一次不想麻烦阿姨，还是遇到别人时也总先把自己放到后面？',
  evidence: [
    { messageId: 2618, quote: '我怕太麻烦，结果真的好凉呀，逼自己吞掉半个' },
    { messageId: 2620, quote: '只是觉得阿姨也有一点点忙来着' },
  ],
  createdAt: T0 + 3000, updatedAt: T0 + 3000,
});

const THREE = [R3, R2, R1]; // 数据层按 updatedAt 倒序返回

test('V01 三条 active 记录全部可展示，字段一一对应', () => {
  const m = V.buildView(THREE, {});
  assert.equal(m.ok, true);
  assert.equal(m.total, 3);
  assert.equal(m.items.length, 3);

  const byId = Object.fromEntries(m.items.map((i) => [i.id, i]));
  for (const src of THREE) {
    const item = byId[src.id];
    assert.ok(item, '缺少记录 ' + src.id);
    assert.equal(item.title, src.topic);
    assert.equal(item.text, src.text);
    assert.equal(item.observed, src.observed);
    assert.equal(item.inferred, src.inferred);
    assert.equal(item.question, src.question);
    assert.equal(item.kind, src.kind);
    assert.equal(item.confidence, src.confidence);
    assert.equal(item.evidence.length, src.evidence.length);
    assert.deepEqual(
      item.evidence.map((e) => [String(e.messageId), e.quote]),
      src.evidence.map((e) => [String(e.messageId), e.quote])
    );
    assert.equal(item.hasDetail, true);
  }
  assert.equal(byId[R1.id].kindLabel, SN.KIND_LABELS.impression);
  assert.equal(byId[R3.id].confidenceLabel, '还不太确定');
  assert.equal(byId[R2.id].basisLabel, '她说过');
});

test('V02 只展示 active，撤回与已被修订的记录不出现', () => {
  const rows = THREE.concat([
    rec({ id: 'sn-old-1', text: '旧版本', status: 'superseded' }),
    rec({ id: 'sn-old-2', text: '已撤回', status: 'retracted' }),
  ]);
  const m = V.buildView(rows, {});
  assert.equal(m.total, 3);
  assert.deepEqual(m.items.map((i) => i.id), [R3.id, R2.id, R1.id]);
});

test('V03 按类型筛选，计数与筛选结果一致', () => {
  const all = V.buildView(THREE, { filter: 'all' });
  assert.deepEqual(all.counts, { all: 3, inference: 1, observation: 1, impression: 1 });

  const only = V.buildView(THREE, { filter: 'inference' });
  assert.equal(only.filter, 'inference');
  assert.equal(only.items.length, 1);
  assert.equal(only.items[0].id, R3.id);
  assert.equal(only.emptyReason, '');

  const unknown = V.buildView(THREE, { filter: 'nonsense' });
  assert.equal(unknown.filter, 'all');
  assert.equal(unknown.items.length, 3);
});

test('V04 没有记录时给出自然空态，不伪造条目', () => {
  for (const input of [[], null, undefined, 'nope']) {
    const m = V.buildView(input, {});
    assert.equal(m.total, 0);
    assert.equal(m.items.length, 0);
    assert.equal(m.emptyReason, 'no-records');
    assert.deepEqual(m.counts, { all: 0 });
  }
});

test('V05 筛选后没有命中，与「完全没有记录」区分开', () => {
  const m = V.buildView([R1], { filter: 'question' });
  assert.equal(m.total, 1);
  assert.equal(m.items.length, 0);
  assert.equal(m.emptyReason, 'no-match');
});

test('V06 没有 topic 时用正文开头当标题；缺字段不补造内容', () => {
  const bare = rec({ text: '她今天只是说了一句晚安，声音很轻。', topic: '', observed: '', inferred: '', question: '', evidence: [] });
  const m = V.buildView([bare], {});
  const item = m.items[0];
  assert.equal(item.title, '她今天只是说了一句晚安，声音很轻。');
  assert.equal(item.observed, '');
  assert.equal(item.inferred, '');
  assert.equal(item.question, '');
  assert.equal(item.evidence.length, 0);
  assert.equal(item.hasDetail, false);

  const long = rec({ text: '一'.repeat(40), topic: '  ' });
  assert.equal(V.buildView([long], {}).items[0].title, '一'.repeat(22) + '…');
  assert.equal(V.buildView([long], {}).items[0].summary, '一'.repeat(40));
});

test('V07 证据清洗：没有原文片段的引用不展示，messageId 统一为字符串', () => {
  const r = rec({
    evidence: [
      { messageId: 11, quote: '她说过第一句' },
      { messageId: 12, quote: '' },
      { messageId: null, quote: '没有消息编号但有原文' },
      'not-an-object',
    ],
  });
  const item = V.buildView([r], {}).items[0];
  assert.equal(item.evidence.length, 2);
  assert.deepEqual(item.evidence[0], { messageId: '11', quote: '她说过第一句' });
  assert.equal(item.evidence[1].messageId, '');
  assert.equal(item.evidence[1].quote, '没有消息编号但有原文');
});

test('V08 只读 store：可以读，写入一律拒绝', async () => {
  const s = memStore();
  await SN.create(s, {
    text: '她怕麻烦别人的时候，我总有点不放心。',
    kind: 'inference',
    topic: '冷馒头',
    basis: 'inferred',
    confidence: 'low',
    observed: '她说怕太麻烦，自己把凉馒头啃了半个',
    inferred: '她可能习惯把不舒服留给自己',
    question: '只是这一次吗？',
    evidence: [{ messageId: 2618, quote: '我怕太麻烦' }],
    source: { kind: 'chat', messageId: 2618 },
  }, { now: T0 });

  const before = JSON.stringify(s.map.get(SN.KEY));
  s.touched.length = 0;
  const guard = V.readOnlyStore((k) => s.get(k));
  const res = await SN.list(guard, { status: 'active' });
  assert.equal(res.ok, true);
  assert.equal(res.total, 1);

  await assert.rejects(() => guard.set(SN.KEY, {}), /read-only/);
  await assert.rejects(() => guard.set('selfNarrative.watermark', { lastAfterId: 9999 }), /read-only/);
  assert.equal(JSON.stringify(s.map.get(SN.KEY)), before, '读取流程不得改动记录');
  assert.equal(s.map.has('selfNarrative.watermark'), false, '不得创建水位');
  assert.equal(s.touched.filter((t) => t.startsWith('set:')).length, 0, '只读 store 不应产生 set 调用');
});

test('V09 视图源码不写数据、不读草稿、不碰水位', () => {
  // 只看代码本体：注释里会说明「不碰水位 / 不读草稿」，不能算作实现痕迹。
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.equal(/localStorage/.test(code), false, '不应使用 localStorage');
  assert.equal(/sessionStorage/.test(code), false, '不应使用 sessionStorage');
  assert.equal(/kvSet/.test(code), false, '不应调用 kvSet');
  assert.equal(/saveWatermark/.test(code), false, '不应推进水位');
  assert.equal(/selfNarrative\.watermark/.test(code), false, '不应触碰水位键');
  assert.equal(/snDryRun/.test(code), false, '不应读取 Dry-run 草稿');
  assert.equal(/\.create\(|\.update\(|\.retract\(/.test(code), false, '不应调用数据层写操作');
  assert.equal(/fetch\(|XMLHttpRequest|callAI/.test(code), false, '不应发起请求或调用 AI');
});

test('V10 与正式数据层同源：写入几条后按 active 读取并展示一致', async () => {
  const s = memStore();
  for (const r of [R1, R2, R3]) {
    const out = await SN.create(s, {
      id: r.id, text: r.text, kind: r.kind, observed: r.observed, inferred: r.inferred,
      question: r.question, confidence: r.confidence, topic: r.topic, basis: r.basis,
      evidence: r.evidence, source: { kind: 'chat', messageId: r.evidence[0].messageId },
    }, { now: r.createdAt });
    assert.equal(out.ok, true, out.reason);
  }
  // 再加一条撤回记录，确认页面不会把它算进来
  await SN.create(s, {
    text: '一条后来被撤回的认识', kind: 'observation', source: { kind: 'chat', messageId: 1 },
  }, { now: T0 });
  const target = s.map.get(SN.KEY).records.find((x) => x.text === '一条后来被撤回的认识');
  await SN.retract(s, target.id, { now: T0 + 10 });

  const guard = V.readOnlyStore((k) => s.get(k));
  const res = await SN.list(guard, { status: 'active' });
  assert.equal(res.ok, true);
  const m = V.buildView(res.records, {});
  assert.equal(m.total, 3);
  assert.deepEqual(m.items.map((i) => i.topic), ['冷馒头', '相处方式', '认真回应']);
  assert.equal(m.items[0].evidence[0].quote, '我怕太麻烦，结果真的好凉呀，逼自己吞掉半个');
});

test('V11 没有 document 时渲染入口安全返回，不抛异常', async () => {
  assert.equal(typeof globalThis.document, 'undefined');
  const out = await V.render();
  assert.equal(out.ok, false);
  assert.ok(['no-document', 'no-host'].includes(out.reason));
});

test('V12 toItem 保留修订前历史版本（正文/证据/时间），供页面回看旧版', async () => {
  const map = new Map();
  const s = { get: async (k) => map.get(k), set: async (k, v) => map.set(k, v) };
  const created = await SN.create(s, {
    text: '初版：她认真回答我的问题', kind: 'impression',
    topic: '认真回应', source: { kind: 'chat', messageId: 11 },
    evidence: [{ messageId: 11, quote: '她认真回答我的问题' }]
  }, { now: T0 });
  assert.equal(created.ok, true);
  await SN.update(s, created.id, { text: '修订版：她其实偶尔认真' }, { now: T0 + 100 });
  const got = await SN.get(s, created.id);
  const item = V.buildView([got.record], {}).items[0];
  assert.equal(item.history.length, 1, '保留一个旧版本快照');
  assert.equal(item.history[0].text, '初版：她认真回答我的问题');
  assert.equal(item.history[0].evidence[0].quote, '她认真回答我的问题', '旧版证据链不丢');
  assert.equal(typeof item.history[0].at, 'number');
});
