/* tests/shared/self-narrative.test.mjs — 机自述数据层（P1）
 * 覆盖：四种 kind 新增 / 查询筛选 / 修订保留历史 / 撤回保留正文 / revisedFrom 关联 /
 *       来源完整保存 / 重复识别 / 无效输入与错误数据 / 多条记录互不影响 / 只写自己的键。
 * 纯 Node：不调 AI、不开浏览器、不碰真实 IndexedDB（store 用内存适配器注入）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import '../../public/shared/self-narrative.js';

const SN = globalThis.SelfNarrative;
const T0 = 1795000000000;
const at = (n) => T0 + n * 60000;

function store(seed) {
  const map = new Map(Object.entries(seed || {}));
  const keys = { get: [], set: [] };
  return {
    map,
    keys,
    async get(k) { keys.get.push(k); return map.has(k) ? map.get(k) : undefined; },
    async set(k, v) { keys.set.push(k); map.set(k, v); },
  };
}

function stateOf(s) { return s.map.get(SN.KEY); }
function recs(s) { return stateOf(s).records; }
function texts(s) { return recs(s).map((r) => r.text); }

const base = (over) => Object.assign({
  text: '她今天说话的时候一直在笑',
  kind: 'observation',
  observed: '笑起来会先低头',
  source: { kind: 'chat', messageId: 12, at: at(0) },
}, over || {});

/* ---------- 01. 四种 kind 都能新增 ---------- */
test('S01 四种 kind 均可新增，字段原样落库', async () => {
  const s = store();
  const kinds = ['observation', 'impression', 'inference', 'question'];
  const ids = [];
  for (let i = 0; i < kinds.length; i++) {
    const r = await SN.create(s, base({
      kind: kinds[i],
      text: '第 ' + i + ' 条：' + kinds[i],
      observed: '看到了' + i,
      inferred: i === 2 ? '我猜她其实有点紧张' : '',
      confirmed: '',
      question: i === 3 ? '她是不是不喜欢被人盯着看' : '',
      confidence: ['low', 'medium', 'high', 'low'][i],
      topic: ['日常', '性格', '相处', '边界'][i],
    }), { now: at(i) });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.reason, 'created');
    ids.push(r.id);
  }
  assert.equal(new Set(ids).size, 4, '四条 ID 互不相同');
  assert.equal(recs(s).length, 4);
  assert.deepEqual(recs(s).map((r) => r.kind), kinds);
  const third = recs(s)[2];
  assert.equal(third.inferred, '我猜她其实有点紧张', 'inferred 落库');
  assert.equal(third.status, 'active');
  assert.equal(third.confidence, 'high');
  assert.equal(third.topic, '相处');
  assert.deepEqual(third.history, []);
  assert.equal(SN.KINDS.length, 4);
});

/* ---------- 02. 查询与筛选 ---------- */
test('S02 列表按状态 / 类型 / 主题筛选，默认只看有效记录', async () => {
  const s = store();
  const a = await SN.create(s, base({ kind: 'observation', text: '她会把杯子推到桌角', topic: '习惯' }), { now: at(1) });
  const b = await SN.create(s, base({ kind: 'question', text: '她为什么不喜欢被夸', topic: '性格' }), { now: at(2) });
  const c = await SN.create(s, base({ kind: 'observation', text: '她累了就会沉默', topic: '性格' }), { now: at(3) });

  const all = await SN.list(s);
  assert.equal(all.ok, true);
  assert.equal(all.total, 3, '默认返回全部有效记录');

  const obs = await SN.list(s, { kind: 'observation' });
  assert.deepEqual(obs.records.map((r) => r.id), [c.id, a.id], '按类型筛选并按更新时间倒序');

  const topic = await SN.list(s, { topic: '性格' });
  assert.deepEqual(topic.records.map((r) => r.id), [c.id, b.id], '按主题筛选');

  const combo = await SN.list(s, { kind: 'question', topic: '性格' });
  assert.equal(combo.total, 1);
  assert.equal(combo.records[0].id, b.id);

  await SN.retract(s, a.id, { now: at(4) });
  assert.equal((await SN.list(s)).total, 2, '撤回后不在有效列表里');
  assert.equal((await SN.list(s, { status: 'retracted' })).total, 1);
  assert.equal((await SN.list(s, { status: 'all' })).total, 3, 'status=all 不受状态限制');

  assert.equal((await SN.get(s, a.id)).ok, true, '按 id 仍能读到撤回记录');
  assert.equal((await SN.list(s, { kind: 'diary' })).reason, 'invalid-kind');
  assert.equal((await SN.list(s, { status: 'deleted' })).reason, 'invalid-status');
});

/* ---------- 03. 修改保留历史 ---------- */
test('S03 修改后历史版本完整保留：原文、来源、置信度都在快照里', async () => {
  const s = store();
  const made = await SN.create(s, base({
    text: '她好像不太喜欢人多的地方',
    kind: 'inference',
    confidence: 'low',
    source: { kind: 'chat', messageId: 41, at: at(0) },
  }), { now: at(1) });
  assert.equal(made.ok, true);

  const upd = await SN.update(s, made.id, {
    text: '她不喜欢人多的地方，但熟人多的场合没问题',
    confidence: 'medium',
    confirmed: '她自己说过一次',
  }, { now: at(2) });
  assert.equal(upd.ok, true, upd.reason);
  assert.equal(upd.reason, 'updated');
  assert.equal(upd.historyLength, 1);

  const cur = recs(s)[0];
  assert.equal(cur.id, made.id, '修改保持同一 ID');
  assert.equal(cur.text, '她不喜欢人多的地方，但熟人多的场合没问题');
  assert.equal(cur.confidence, 'medium');
  assert.equal(cur.createdAt, at(1), '创建时间不被改写');
  assert.equal(cur.updatedAt, at(2));

  assert.equal(cur.history.length, 1);
  const old = cur.history[0];
  assert.equal(old.text, '她好像不太喜欢人多的地方', '修订前正文完整保留');
  assert.equal(old.confidence, 'low');
  assert.equal(old.kind, 'inference');
  assert.equal(old.source.messageId, 41, '历史版本保留来源');
  assert.equal(old.status, 'active');
  assert.equal(old.at, at(1), '快照时间 = 这一版最后成立的时间');

  const h = await SN.historyOf(s, made.id);
  assert.equal(h.ok, true);
  assert.equal(h.versions.length, 2, '历史 + 当前');
  assert.equal(h.versions[0].text, '她好像不太喜欢人多的地方');
  assert.equal(h.versions[0].current, false);
  assert.equal(h.versions[1].text, cur.text);
  assert.equal(h.versions[1].current, true);

  const again = await SN.update(s, made.id, { text: cur.text }, { now: at(3) });
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'no-change', '无变化不写库');
  assert.equal(recs(s)[0].history.length, 1, '无变化不产生多余历史');
});

/* ---------- 04. 撤回保留记录 ---------- */
test('S04 撤回只改状态：记录、正文、来源、历史全部还在', async () => {
  const s = store();
  const made = await SN.create(s, base({
    text: '她生气的时候反而更安静',
    kind: 'impression',
    source: { kind: 'chat', messageId: 77, at: at(0) },
  }), { now: at(1) });
  await SN.update(s, made.id, { text: '她生气的时候会先安静一会儿' }, { now: at(2) });

  const r = await SN.retract(s, made.id, { now: at(3) });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.reason, 'retracted');

  const cur = recs(s)[0];
  assert.equal(cur.status, 'retracted');
  assert.equal(cur.text, '她生气的时候会先安静一会儿', '撤回不删正文');
  assert.equal(cur.source.messageId, 77, '撤回不删来源');
  assert.equal(cur.history.length, 2, '撤回本身也留一版快照');
  assert.equal(cur.history[1].status, 'active', '快照记录撤回前状态');
  assert.equal(cur.retractedAt, at(3));
  assert.equal(recs(s).length, 1, '记录仍在，没有物理删除');

  const twice = await SN.retract(s, made.id, { now: at(4) });
  assert.equal(twice.ok, false);
  assert.equal(twice.reason, 'already-retracted');

  const edit = await SN.update(s, made.id, { text: '改一条已撤回的记录' }, { now: at(5) });
  assert.equal(edit.ok, false);
  assert.equal(edit.reason, 'retracted-record', '已撤回的记录需要先恢复才可修改');
  assert.equal(recs(s)[0].text, '她生气的时候会先安静一会儿', '失败的修改没有落库');
});

/* ---------- 05. revisedFrom 关联 ---------- */
test('S05 revisedFrom 指向被修订的记录，旧记录标记已被修订但完整保留', async () => {
  const s = store();
  const a = await SN.create(s, base({ text: '她大概不喜欢甜的', kind: 'inference' }), { now: at(1) });
  const b = await SN.create(s, base({
    text: '她不喜欢太甜的，但喜欢水果的甜',
    kind: 'inference',
    revisedFrom: a.id,
    confirmed: '她说过一次',
  }), { now: at(2) });
  assert.equal(b.ok, true, b.reason);
  assert.equal(b.revisedFrom, a.id);

  const oldRec = (await SN.get(s, a.id)).record;
  const newRec = (await SN.get(s, b.id)).record;
  assert.equal(newRec.revisedFrom, a.id);
  assert.equal(oldRec.supersededBy, b.id);
  assert.equal(oldRec.status, 'superseded');
  assert.equal(oldRec.text, '她大概不喜欢甜的', '旧记录正文原样保留');
  assert.equal(oldRec.history.length, 1, '旧记录留了一版被取代前的快照');

  const h = await SN.historyOf(s, b.id);
  assert.deepEqual(h.lineage, [a.id, b.id], '链路按时间从旧到新');
  assert.equal(h.versions[0].text, '她大概不喜欢甜的');
  assert.equal(h.versions[h.versions.length - 1].text, '她不喜欢太甜的，但喜欢水果的甜');
  assert.equal(h.versions.length, 3, 'A 的快照 + A 当前 + B 当前');

  const missing = await SN.create(s, base({ text: '修订自一条不存在的记录', revisedFrom: 'sn-nope' }), { now: at(3) });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'invalid-revised-from');
  assert.equal(recs(s).length, 2, '失败的创建没有落库');
});

/* ---------- 06. 来源完整保存 + 按来源定位 ---------- */
test('S06 来源（含聊天消息 ID）完整保存，可按来源精确查找', async () => {
  const s = store();
  const a = await SN.create(s, base({
    text: '她说那句话的时候停顿了两秒',
    source: { kind: 'chat', messageId: 305, conversationId: 'room', at: at(1), note: '原话：我再想想' },
  }), { now: at(1) });
  const b = await SN.create(s, base({
    text: '她不太主动提要求',
    source: { kind: 'chat', messageId: 401, conversationId: 'room', at: at(2) },
  }), { now: at(2) });
  await SN.create(s, base({ text: '我自己想到的', source: { kind: 'manual' } }), { now: at(3) });

  const saved = (await SN.get(s, a.id)).record.source;
  assert.equal(saved.kind, 'chat');
  assert.equal(saved.messageId, 305);
  assert.equal(saved.conversationId, 'room');
  assert.equal(saved.note, '原话：我再想想');
  assert.equal(saved.at, at(1));

  const byMsg = await SN.bySource(s, 305);
  assert.equal(byMsg.total, 1);
  assert.equal(byMsg.records[0].id, a.id);

  const byObj = await SN.bySource(s, { kind: 'chat', messageId: '401' });
  assert.equal(byObj.total, 1, '数字/字符串 ID 都能匹配');
  assert.equal(byObj.records[0].id, b.id);

  const byKind = await SN.bySource(s, { kind: 'manual' });
  assert.equal(byKind.total, 1);

  const none = await SN.bySource(s, 999999);
  assert.equal(none.total, 0);
  assert.equal((await SN.bySource(s, '')).reason, 'bad-params');
});

/* ---------- 07. 重复识别 ---------- */
test('S07 重复识别：同文与高相似都能指出，且不合并、不删除', async () => {
  const s = store();
  const a = await SN.create(s, base({ text: '她不喜欢被安排', kind: 'inference' }), { now: at(1) });
  const b = await SN.create(s, base({ text: '她不喜欢被安排。', kind: 'impression' }), { now: at(2) });
  const c = await SN.create(s, base({ text: '她不太喜欢被安排', kind: 'inference' }), { now: at(3) });
  await SN.create(s, base({ text: '她今天穿了深蓝色的外套', kind: 'observation' }), { now: at(4) });

  const dup = await SN.duplicates(s);
  assert.equal(dup.ok, true);
  const same = dup.groups.find((g) => g.reason === 'same-text');
  assert.ok(same, '同文组存在');
  assert.deepEqual(same.ids.slice().sort(), [a.id, b.id].sort(), '标点差异不算不同');

  const loose = dup.groups.find((g) => g.reason === 'similar-text');
  assert.ok(loose, '高相似组存在');
  assert.ok(loose.ids.includes(a.id) && loose.ids.includes(c.id));
  assert.ok(loose.score >= SN.DUP_SIMILARITY);

  assert.equal(recs(s).length, 4, '重复识别不删除记录');

  const of = await SN.duplicatesOf(s, a.id);
  assert.equal(of.ok, true);
  assert.deepEqual(of.matches.map((m) => m.id).sort(), [b.id, c.id].sort());

  const strict = await SN.duplicates(s, { threshold: 0.99 });
  assert.equal(strict.groups.filter((g) => g.reason === 'similar-text').length, 0, '阈值可控');
});

/* ---------- 08. 无效输入与错误数据 ---------- */
test('S08 无效 ID / 非法类型 / 错误数据都明确失败，且不写坏数据', async () => {
  const s = store();
  const ok = await SN.create(s, base(), { now: at(1) });
  assert.equal(ok.ok, true);

  const cases = [
    [{ ...base(), text: '   ' }, 'empty-text'],
    [{ ...base(), kind: 'diary' }, 'invalid-kind'],
    [{ ...base(), kind: undefined }, 'invalid-kind'],
    [{ ...base(), confidence: 'sure' }, 'invalid-confidence'],
    [{ ...base(), source: 42 }, 'invalid-source'],
    [{ ...base(), source: { kind: '' } }, 'invalid-source'],
    [{ ...base(), status: 'retracted' }, 'invalid-status'],
    [{ ...base(), foo: 1 }, 'invalid-field'],
  ];
  for (const [spec, reason] of cases) {
    const r = await SN.create(s, spec, { now: at(2) });
    assert.equal(r.ok, false, '应拒绝：' + reason);
    assert.equal(r.reason, reason);
  }
  assert.equal(recs(s).length, 1, '所有失败都没有新增记录');

  assert.equal((await SN.get(s, '')).reason, 'invalid-id');
  assert.equal((await SN.get(s, 'sn-not-exist')).reason, 'not-found');
  assert.equal((await SN.update(s, 'sn-not-exist', { text: 'x' })).reason, 'not-found');
  assert.equal((await SN.update(s, ok.id, {})).reason, 'empty-patch');
  assert.equal((await SN.update(s, ok.id, { status: 'retracted' })).reason, 'invalid-field', '状态只能走撤回');
  assert.equal((await SN.update(s, ok.id, { text: '   ' })).reason, 'empty-text');
  assert.equal((await SN.retract(s, 'sn-not-exist')).reason, 'not-found');
  assert.equal((await SN.historyOf(s, 'sn-not-exist')).reason, 'not-found');
  assert.equal((await SN.duplicatesOf(s, 'sn-not-exist')).reason, 'not-found');

  assert.equal((await SN.create(null, base())).reason, 'bad-store');
  assert.equal((await SN.list({})).reason, 'bad-store');
});

test('S08b 键已存在但结构不合法：拒绝写入，原值原样保留', async () => {
  const broken = { schema: 999, records: 'nope' };
  const s = store({ [SN.KEY]: broken });
  const r = await SN.create(s, base(), { now: at(1) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'state-invalid-kept');
  assert.deepEqual(stateOf(s), broken, '坏数据没有被覆盖');

  const l = await SN.list(s);
  assert.equal(l.ok, false);
  assert.equal(l.reason, 'state-invalid-kept');
});

test('S08c 写入失败要说明原因，内存状态不被当成已保存', async () => {
  const map = new Map();
  const s = {
    async get(k) { return map.get(k); },
    async set() { throw new Error('quota exceeded'); },
  };
  const r = await SN.create(s, base(), { now: at(1) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'write-failed');
  assert.equal(r.error, 'quota exceeded');
  assert.equal(map.has(SN.KEY), false, '没有留下半截数据');

  const readFail = { async get() { throw new Error('io'); }, async set() {} };
  const r2 = await SN.create(readFail, base());
  assert.equal(r2.reason, 'read-failed');
});

/* ---------- 09. 多条记录独立操作 ---------- */
test('S09 修改 / 撤回一条，其它记录逐字节不变', async () => {
  const s = store();
  const a = await SN.create(s, base({ text: 'A 记录：她怕冷', kind: 'observation' }), { now: at(1) });
  const b = await SN.create(s, base({ text: 'B 记录：她嘴硬心软', kind: 'impression' }), { now: at(2) });
  const c = await SN.create(s, base({ text: 'C 记录：她喜欢猫', kind: 'observation' }), { now: at(3) });
  const before = JSON.stringify(recs(s));

  await SN.update(s, b.id, { text: 'B 记录：她嘴硬，心是软的' }, { now: at(4) });
  const midA = JSON.stringify(recs(s).find((r) => r.id === a.id));
  const midC = JSON.stringify(recs(s).find((r) => r.id === c.id));
  const beforeObj = JSON.parse(before);
  assert.equal(midA, JSON.stringify(beforeObj.find((r) => r.id === a.id)), 'A 完全没变');
  assert.equal(midC, JSON.stringify(beforeObj.find((r) => r.id === c.id)), 'C 完全没变');
  assert.equal(recs(s).length, 3);

  await SN.retract(s, c.id, { now: at(5) });
  assert.equal(JSON.stringify(recs(s).find((r) => r.id === a.id)), midA, '撤回 C 不影响 A');
  assert.equal(recs(s).find((r) => r.id === b.id).text, 'B 记录：她嘴硬，心是软的', '撤回 C 不影响 B 的修订');
  assert.equal((await SN.list(s, { status: 'all' })).total, 3);
});

test('S09b 并发新增不相互覆盖', async () => {
  const s = store();
  const out = await Promise.all([
    SN.create(s, base({ text: '并发 1' }), { now: at(1) }),
    SN.create(s, base({ text: '并发 2' }), { now: at(2) }),
    SN.create(s, base({ text: '并发 3' }), { now: at(3) }),
  ]);
  assert.deepEqual(out.map((r) => r.ok), [true, true, true]);
  assert.equal(recs(s).length, 3, '三条都在');
  assert.deepEqual(texts(s).slice().sort(), ['并发 1', '并发 2', '并发 3']);
  assert.equal(new Set(recs(s).map((r) => r.id)).size, 3);
});

/* ---------- 10. 只写自己的键 ---------- */
test('S10 只读写 selfNarrative.v1，绝不触碰长期记忆 / 日记 / 珍藏的键', async () => {
  const s = store({
    longTermMemory: '旧记忆原文',
    'longTermMemory.v2': { schema: 1, entries: [], baseline: '旧记忆原文' },
    settings: { fontSize: '14' },
  });
  await SN.create(s, base(), { now: at(1) });
  await SN.update(s, recs(s)[0].id, { text: '改一下' }, { now: at(2) });

  assert.deepEqual(s.keys.set, [SN.KEY, SN.KEY], '只写自己的键');
  assert.deepEqual(Array.from(new Set(s.keys.get)), [SN.KEY], '只读自己的键');
  assert.equal(s.map.get('longTermMemory'), '旧记忆原文');
  assert.deepEqual(s.map.get('longTermMemory.v2').entries, []);
  assert.deepEqual(s.map.get('settings'), { fontSize: '14' });
});

/* ---------- 11. 模块边界：不生成、不触网 ---------- */
test('S11 数据层不引用网络 / DOM / AI，也不把内容写进别的存储', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../public/shared/self-narrative.js', import.meta.url), 'utf8');
  // 注释里会写明「不与日记/珍藏混用」，所以只检查代码本体
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/fetch\(|XMLHttpRequest|WebSocket/.test(code), false, '不触网');
  assert.equal(/document\.|localStorage|indexedDB/i.test(code), false, '不直接操作 DOM / 存储');
  assert.equal(/diaries|keeps|starDiaries/.test(code), false, '不读日记 / 珍藏');
  assert.ok(src.includes('selfNarrative.v1'));
  assert.ok(src.includes('不记录、也不暴露模型的内部推理过程') || src.includes('隐藏思维链'), '文件里写明边界');
});

/* ---------- 12. P0-3：聊天上下文按需注入（contextPart 纯函数） ---------- */
const ctxRow = (id, over) => Object.assign({
  id: id, status: 'active', kind: 'observation', basis: 'observed',
  text: '她抱臂站在门口', observed: '抱臂站在门口', inferred: '', question: '', topic: '相处'
}, over || {});

test('S12 contextPart 只注入 active 正式记录，retracted / superseded 一律不进池', () => {
  const rows = [
    ctxRow('a'),
    ctxRow('b', { status: 'retracted', text: '她抱臂站在门口（已撤回）' }),
    ctxRow('c', { status: 'superseded', text: '她抱臂站在门口（已被修订）' }),
  ];
  const out = SN.contextPart('记得她抱臂站在门口', rows, {});
  assert.equal(out.reason, 'ok');
  assert.equal(out.count, 1);
  assert.deepEqual(out.keys, ['selfNarrative:a']);
  assert.match(out.text, /她抱臂站在门口/);
  assert.equal(/已撤回|已被修订/.test(out.text), false, '非 active 内容不得出现');
});

test('S13 contextPart 保留 kind / basis 与第一人称主观视角，question 仍标为未解疑问', () => {
  const rows = [
    ctxRow('q', { kind: 'question', basis: 'inferred', text: '她是不是不喜欢被盯着看', question: '她是不是不喜欢被盯着看' }),
    ctxRow('f', { kind: 'impression', basis: 'inferred', text: '我当时听着有点不是滋味', observed: '', inferred: '有点吃味' }),
  ];
  const out = SN.contextPart('我一直好奇她是不是不喜欢被盯着看，听着有点不是滋味', rows, {});
  assert.equal(out.reason, 'ok');
  assert.match(out.text, /还想弄明白的/, 'question 的 kind 标签保留');
  assert.match(out.text, /别当成事实/, 'question 明确不是事实');
  assert.match(out.text, /留下的印象/, 'impression 的 kind 标签保留');
  assert.match(out.text, /我当时听着有点不是滋味/, '主观感受原样保留，不改成客观属性');
  assert.match(out.text, /他的推测/, 'basis 标签保留');
  assert.equal(/不是用户的客观属性/.test(out.text), true, '上下文标注主观性质');
});

test('S14 contextPart 话题相关 + 数量上限 + 会话去重，无关消息返回 no-match', () => {
  const rows = [
    ctxRow('a'), ctxRow('b'), ctxRow('c'), ctxRow('d'),
  ];
  const out = SN.contextPart('记得她抱臂站在门口', rows, {
    limit: 2,
    isSent: (k) => k === 'selfNarrative:a',
  });
  assert.equal(out.reason, 'ok');
  assert.equal(out.count, 2, '最多 2 条');
  assert.deepEqual(out.keys, ['selfNarrative:b', 'selfNarrative:c'], '已发送的不重复注入');
  const none = SN.contextPart('今天天气不错适合出门散步买奶茶喝', rows, {});
  assert.equal(none.reason, 'no-match');
  assert.equal(none.count, 0);
  assert.equal(none.text, '');
});

test('S15 contextPart 不读库、不写数据，只是纯函数', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../public/shared/self-narrative.js', import.meta.url), 'utf8');
  const start = src.indexOf('function contextPart');
  const end = src.indexOf('var api = {');
  assert.ok(start > 0 && end > start);
  const fn = src.slice(start, end);
  assert.equal(/store\.|\.set\(|indexedDB|localStorage|fetch\(/.test(fn), false, 'contextPart 内无存储写入');
});

