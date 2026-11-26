/* tests/shared/self-narrative-backup.test.mjs — 机自述随备份迁移（P1）
 * 覆盖：导出包含完整机自述 / 计数 / 完整性校验 / 合并保留历史与撤回 / 非法结构不覆盖 /
 *       不影响长期记忆、日记、共同珍藏 / 接线点确实读写 selfNarrative.v1。
 * 纯 Node：不碰 IndexedDB（buildFile 与 buildPlan 都是纯函数层）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import '../../public/shared/backup-format.js';
import '../../public/shared/backup-io.js';
import '../../public/shared/self-narrative.js';

const BF = globalThis.BackupFormat;
const BIO = globalThis.BackupIO;
const SN = globalThis.SelfNarrative;

const KEY = 'selfNarrative.v1';
const T = 1795000000000;

function memStore() {
  const map = new Map();
  return {
    map,
    async get(k) { return map.has(k) ? map.get(k) : undefined; },
    async set(k, v) { map.set(k, v); },
  };
}

/** 用数据层真实产出一份机自述状态：含修订历史、撤回记录、来源。 */
async function realState() {
  const s = memStore();
  const a = await SN.create(s, {
    text: '她不喜欢太甜的', kind: 'inference', confidence: 'low', topic: '口味',
    inferred: '我猜她是怕腻', source: { kind: 'chat', messageId: 11, at: T },
  }, { now: T + 1000 });
  await SN.update(s, a.id, { text: '她不喜欢太甜的，但喜欢水果', confidence: 'medium' }, { now: T + 2000 });
  const b = await SN.create(s, {
    text: '她说那句话时停顿了两秒', kind: 'observation', topic: '相处',
    observed: '停顿两秒', source: { kind: 'chat', messageId: 12, at: T },
  }, { now: T + 3000 });
  const c = await SN.create(s, {
    text: '她可能不太喜欢被安排', kind: 'question', topic: '边界',
    question: '她是真的不喜欢，还是只是那天累', source: { kind: 'chat', messageId: 13, at: T },
  }, { now: T + 4000 });
  await SN.retract(s, c.id, { now: T + 5000 });
  return { state: s.map.get(KEY), ids: { a: a.id, b: b.id, c: c.id } };
}

function sections(over) {
  const base = {
    room: { kv: {}, messages: [], keeps: [], diaries: [], starDiaries: [], futureLetters: [] },
    butler: { tasks: [], transactions: [], cycles: [], sleepLogs: [], meta: [] },
    localStorage: {},
    radioVoice: { clips: [] },
    chatVoice: { clips: [] },
  };
  const out = JSON.parse(JSON.stringify(base));
  Object.keys(over || {}).forEach((k) => {
    if (k === 'sn') out.room.kv[KEY] = over.sn;
    else if (k === 'ltm') out.room.kv.longTermMemory = over.ltm;
    else if (k === 'ltm2') out.room.kv['longTermMemory.v2'] = over.ltm2;
    else if (k === 'diaries') out.room.diaries = over.diaries;
    else if (k === 'keeps') out.room.keeps = over.keeps;
    else out[k] = over[k];
  });
  return out;
}

function ver(text, at, status) {
  return {
    at, text, kind: 'observation', confidence: 'medium',
    observed: '', inferred: '', confirmed: '', question: '', topic: '',
    source: { kind: 'chat', messageId: 1, at }, status: status || 'active',
    revisedFrom: null, historyLength: 0,
  };
}

function rec(id, text, updatedAt, opts) {
  const o = opts || {};
  return {
    id, text, kind: o.kind || 'observation',
    observed: '', inferred: '', confirmed: '', question: '', topic: o.topic || '',
    confidence: o.confidence || 'medium',
    source: o.source || { kind: 'chat', messageId: 9, at: updatedAt },
    status: o.status || 'active',
    revisedFrom: o.revisedFrom || null, supersededBy: o.supersededBy || null,
    createdAt: o.createdAt || updatedAt - 1000, updatedAt,
    history: o.history || [],
  };
}

function snState(records, over) {
  return Object.assign({
    schema: 1, key: KEY, createdAt: T, updatedAt: T + 9000, records,
  }, over || {});
}

function v2file(sn, extraKv) {
  return {
    format: 'ylxh-backup', version: 2, minApp: '2.1', exportedAt: T,
    origin: 'http://127.0.0.1:8787', device: 'desktop', profile: { label: '' },
    star_fifi_room: {
      kv: Object.assign({ settings: {}, longTermMemory: '' }, sn ? { [KEY]: sn } : {}, extraKv || {}),
      messages: [], keeps: [], diaries: [], starDiaries: [], futureLetters: [],
    },
    star_butler_v1: { tasks: [], transactions: [], cycles: [], sleepLogs: [], meta: [] },
    radio_voice: { clips: [] },
    chat_voice: { clips: [] },
    localStorage: {},
  };
}

/* ---------- B01 导出：文件里带着完整机自述 ---------- */
test('B01 buildFile 导出完整机自述：record / history / source / retracted 都在', async () => {
  const { state } = await realState();
  const file = await BIO.buildFile(sections({ sn: state }), { device: 'test' });
  const got = file.star_fifi_room.kv[KEY];
  assert.deepEqual(got, state, '逐字段完整导出，没有裁剪');

  const recA = got.records.find((r) => r.kind === 'inference');
  assert.equal(recA.history.length, 1, '修订历史随备份走');
  assert.equal(recA.history[0].text, '她不喜欢太甜的', '修订前正文在备份里');
  assert.equal(recA.history[0].source.messageId, 11, '历史版本里的来源也在');

  const recC = got.records.find((r) => r.status === 'retracted');
  assert.ok(recC, '撤回记录没有被导出时过滤掉');
  assert.equal(recC.text, '她可能不太喜欢被安排');
  assert.equal(recC.source.messageId, 13);
});

/* ---------- B02 计数 ---------- */
test('B02 countsOf 统计记录数 / 状态 / 历史版本数', async () => {
  const { state } = await realState();
  const n = BF.normalizeBackup(v2file(state));
  assert.equal(n.warnings.length, 0, '合规数据不产生警告');
  const c = n.sections && BF.countsOf(n.sections);
  const sn = c.room.selfNarrative;
  assert.ok(sn, '计数字段存在');
  assert.equal(sn.records, 3);
  assert.equal(sn.active, 2);
  assert.equal(sn.retracted, 1);
  assert.equal(sn.superseded, 0);
  assert.equal(sn.historyVersions, 2, 'A 修订 1 次 + C 撤回 1 次');
  assert.equal(sn.withSource, 3);
  assert.equal(sn.valid, true);
});

/* ---------- B03 旧备份不受影响 ---------- */
test('B03 没有机自述的旧备份：不出新计数字段，完整性校验照旧通过', async () => {
  const old = v2file(null);
  old.integrity = await BF.buildIntegrity(old);
  const n = BF.normalizeBackup(old);
  assert.equal(KEY in n.sections.room.kv, false);
  const c = BF.countsOf(n.sections);
  assert.equal('selfNarrative' in c.room, false, '旧文件不会被塞进新字段');
  const v = await BF.verifyIntegrity(old);
  assert.equal(v.ok, true, '旧备份仍判定完整');
});

/* ---------- B04 完整性校验往返 ---------- */
test('B04 含机自述的备份：buildIntegrity → verifyIntegrity 往返一致', async () => {
  const { state } = await realState();
  const file = await BIO.buildFile(sections({ sn: state }), { device: 'test' });
  assert.ok(file.integrity.counts.room.selfNarrative, '完整性记录里有机自述计数');
  const v = await BF.verifyIntegrity(file);
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.integrity.counts.room.selfNarrative.records, 3);
});

/* ---------- B05 篡改内容被拦下 ---------- */
test('B05 备份里的机自述正文被改动 → 完整性校验拒绝', async () => {
  const { state } = await realState();
  const file = await BIO.buildFile(sections({ sn: state }), { device: 'test' });
  file.star_fifi_room.kv[KEY].records[0].text = '被改过的正文';
  const v = await BF.verifyIntegrity(file);
  assert.equal(v.ok, false);
  assert.ok(['payload-hash-mismatch', 'store-hash-mismatch'].includes(v.reason), v.reason);
});

/* ---------- B06 恢复：新机整体采用 ---------- */
test('B06 目标机没有机自述 → adopt，恢复后与备份完全一致', async () => {
  const { state } = await realState();
  const n = BF.normalizeBackup(v2file(state));
  const plan = BF.buildPlan({ mode: 'merge', target: sections(), backup: n.sections });
  assert.equal(plan.selfNarrative.action, 'adopt');
  const got = plan.kvSet[KEY];
  assert.deepEqual(got, state, '完整恢复：正文 / 历史 / 来源 / 撤回状态');
  assert.equal(got.records.filter((r) => r.status === 'retracted').length, 1);
  assert.equal(got.records.find((r) => r.kind === 'inference').history[0].text, '她不喜欢太甜的');
});

/* ---------- B07 合并：同 id 取较新，历史取并集 ---------- */
test('B07 merge：同 id 取较新版本，历史版本取并集不丢失', async () => {
  const target = snState([rec('sn-1', '本机较新的说法', T + 8000, {
    history: [ver('本机中间版本', T + 5000)],
  })]);
  const backup = snState([rec('sn-1', '备份里较旧的说法', T + 2000, {
    history: [ver('备份里的旧版本', T + 1000)],
  })]);
  const plan = BF.buildPlan({
    mode: 'merge',
    target: sections({ sn: target }),
    backup: sections({ sn: backup }),
  });
  const got = plan.kvSet[KEY].records[0];
  assert.equal(got.text, '本机较新的说法', '同 id 保留较新的正文');
  const texts = got.history.map((h) => h.text);
  assert.ok(texts.includes('本机中间版本'), '本机历史保留');
  assert.ok(texts.includes('备份里的旧版本'), '备份历史也并进来');
  assert.deepEqual(got.history.map((h) => h.at), [T + 1000, T + 5000], '历史按时间排序');
  assert.equal(plan.selfNarrative.action, 'merge');
  assert.ok(plan.selfNarrative.decisions.some((d) => d.id === 'sn-1' && d.action === 'keep-target'));
});

test('B07b merge：备份更新时采用备份正文，同时保留本机独有记录', async () => {
  const target = snState([rec('sn-1', '本机旧说法', T + 1000), rec('sn-2', '只有本机有', T + 1500)]);
  const backup = snState([rec('sn-1', '备份新说法', T + 6000), rec('sn-3', '只有备份有', T + 7000)]);
  const plan = BF.buildPlan({
    mode: 'merge',
    target: sections({ sn: target }),
    backup: sections({ sn: backup }),
  });
  const byId = {};
  plan.kvSet[KEY].records.forEach((r) => { byId[r.id] = r; });
  assert.equal(byId['sn-1'].text, '备份新说法');
  assert.ok(byId['sn-2'], '本机独有记录不被删');
  assert.ok(byId['sn-3'], '备份独有记录被插入');
  assert.ok(plan.selfNarrative.decisions.some((d) => d.id === 'sn-1' && d.action === 'take-backup'));
});

/* ---------- B08 撤回状态与来源完整 ---------- */
test('B08 恢复后撤回状态、来源与撤回前历史都完整', async () => {
  const target = snState([]);
  const backup = snState([rec('sn-9', '一条已撤回的观察', T + 4000, {
    status: 'retracted',
    source: { kind: 'chat', messageId: 88, conversationId: 'room', at: T + 3000, note: '原话' },
    history: [ver('一条已撤回的观察', T + 3500, 'active')],
  })]);
  const plan = BF.buildPlan({
    mode: 'merge',
    target: sections({ sn: target }),
    backup: sections({ sn: backup }),
  });
  const got = plan.kvSet[KEY].records[0];
  assert.equal(got.status, 'retracted');
  assert.equal(got.source.messageId, 88);
  assert.equal(got.source.note, '原话');
  assert.equal(got.history.length, 1);
  assert.equal(got.history[0].status, 'active', '撤回前的状态留在历史里');
});

/* ---------- B09 skip-existing ---------- */
test('B09 skip-existing：目标机已有记录时整块跳过，不覆盖', async () => {
  const target = snState([rec('sn-1', '本机内容', T + 1000)]);
  const backup = snState([rec('sn-1', '备份内容', T + 5000)]);
  const plan = BF.buildPlan({
    mode: 'skip-existing',
    target: sections({ sn: target }),
    backup: sections({ sn: backup }),
  });
  assert.equal(plan.selfNarrative.action, 'skip');
  assert.equal(KEY in plan.kvSet, false, '不会写这个键');
});

/* ---------- B10 replace ---------- */
test('B10 replace：按用户明确选择整体替换', async () => {
  const target = snState([rec('sn-1', '本机内容', T + 1000)]);
  const backup = snState([rec('sn-2', '备份内容', T + 5000)]);
  const plan = BF.buildPlan({
    mode: 'replace',
    target: sections({ sn: target }),
    backup: sections({ sn: backup }),
  });
  assert.equal(plan.selfNarrative.action, 'replace');
  assert.deepEqual(plan.kvSet[KEY], backup);
});

/* ---------- B11 备份里的结构不合法 ---------- */
test('B11 备份里的机自述结构不合法 → 丢弃该分区 + 警告，不产生写入', async () => {
  const broken = { schema: 1, key: KEY, createdAt: T, updatedAt: T, records: [{ id: 'x' }] };
  const n = BF.normalizeBackup(v2file(broken));
  assert.equal(KEY in n.sections.room.kv, false, '不合法分区被丢弃');
  assert.ok(n.warnings.some((w) => w.includes('机自述')), '给出明确警告');

  const plan = BF.buildPlan({
    mode: 'merge',
    target: sections({ sn: snState([rec('sn-1', '本机内容', T + 1000)]) }),
    backup: n.sections,
  });
  assert.equal(plan.selfNarrative.action, 'skip');
  assert.equal(KEY in plan.kvSet, false, '目标机现有记录不被覆盖');
});

/* ---------- B12 目标机结构不合法 ---------- */
test('B12 目标机的机自述结构不合法 → 跳过并提示原样保留', async () => {
  const broken = { schema: 1, key: KEY, records: 'not-an-array' };
  const plan = BF.buildPlan({
    mode: 'merge',
    target: sections({ sn: broken }),
    backup: sections({ sn: snState([rec('sn-2', '备份内容', T + 5000)]) }),
  });
  assert.equal(plan.selfNarrative.action, 'skip');
  assert.equal(KEY in plan.kvSet, false);
  assert.ok(plan.selfNarrative.warnings.some((w) => w.includes('原样保留')));
});

/* ---------- B13 不影响其它分区 ---------- */
test('B13 迁移机自述不改动长期记忆 / 日记 / 共同珍藏', async () => {
  const ltm2 = { schema: 1, entries: [], baseline: '旧记忆原文', createdAt: T, updatedAt: T };
  const diary = { id: 1, title: '日记', content: '我的一天', createdAt: T };
  const keep = { id: 2, title: '珍藏', content: '一起看雨', status: 'saved', createdAt: T };
  const backup = sections({
    sn: snState([rec('sn-1', '一条观察', T + 1000)]),
    ltm: '旧记忆原文',
    ltm2,
    diaries: [diary],
    keeps: [keep],
  });
  const target = sections({ ltm: '本机旧记忆', diaries: [{ id: 9, title: '本机日记', content: 'x', createdAt: T }] });
  const plan = BF.buildPlan({ mode: 'merge', target, backup });

  assert.deepEqual(plan.kvSet[KEY], backup.room.kv[KEY]);
  assert.deepEqual(plan.kvSet['longTermMemory.v2'], ltm2, '长期记忆 v2 仍按自己的规则合并');
  assert.equal(plan.kvSet.longTermMemory, '旧记忆原文');
  assert.deepEqual(plan.room.diaries.inserts.map((d) => d.id), [1], '日记分区照旧插入');
  assert.deepEqual(plan.room.keeps.inserts.map((k) => k.id), [2], '珍藏分区照旧插入');
  assert.equal(backup.room.diaries.length, 1, '备份对象未被修改');
});

/* ---------- B14 计划哈希对机自述内容敏感 ---------- */
test('B14 planHash 覆盖机自述内容：正文不同 → 哈希不同', async () => {
  const mk = (text) => BF.buildPlan({
    mode: 'merge',
    target: sections(),
    backup: sections({ sn: snState([rec('sn-1', text, T + 1000)]) }),
  });
  const h1 = await BF.planHashOf(mk('说法甲'));
  const h2 = await BF.planHashOf(mk('说法乙'));
  assert.notEqual(h1, h2, '不同内容得到不同计划哈希');
  const h3 = await BF.planHashOf(mk('说法甲'));
  assert.equal(h1, h3, '同样输入哈希稳定');
});

/* ---------- B15 接线点 ---------- */
test('B15 backup-io 确实采集与写回 selfNarrative.v1', () => {
  const src = readFileSync(new URL('../../public/shared/backup-io.js', import.meta.url), 'utf8');
  assert.ok(/var sn = await readKey\(roomDb, DBS\.room\.store, F\.SELF_NARRATIVE_KEY\)/.test(src),
    '导出时读取机自述键');
  assert.ok(/if \(F\.isSelfNarrative\(sn\)\) sections\.room\.kv\[F\.SELF_NARRATIVE_KEY\] = sn/.test(src),
    '结构合法才写入备份');
  assert.ok(/isSelfNarrative\(plan\.kvSet\[BF\(\)\.SELF_NARRATIVE_KEY\]\)/.test(src),
    '导入时再次校验');
  assert.ok(/kv\.put\(plan\.kvSet\[BF\(\)\.SELF_NARRATIVE_KEY\], BF\(\)\.SELF_NARRATIVE_KEY\)/.test(src),
    '在 room kv 事务里写回');
  assert.ok(src.includes('机自述结构不合法'), '不合法时给出警告文案');
});
