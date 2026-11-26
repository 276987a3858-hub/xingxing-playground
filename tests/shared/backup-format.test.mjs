/* tests/shared/backup-format.test.mjs — 迁移 v2 纯函数层（不碰 IndexedDB / localStorage / 网络） */
import test from 'node:test';
import assert from 'node:assert/strict';
import '../../public/shared/backup-format.js';

const BF = globalThis.BackupFormat;

const msg = (id, time, content, extra) => Object.assign({ id, role: 'assistant', content, time }, extra || {});
const sections = (over) => Object.assign({
  room: { kv: {}, messages: [], keeps: [], diaries: [], starDiaries: [], futureLetters: [] },
  butler: { tasks: [], transactions: [], cycles: [], sleepLogs: [], meta: [] },
  localStorage: {},
  radioVoice: { clips: [] },
}, over || {});

function v2file(over) {
  return Object.assign({
    format: 'ylxh-backup',
    version: 2,
    minApp: '2.1',
    exportedAt: 1795000000000,
    origin: 'http://127.0.0.1:8787',
    device: 'desktop',
    profile: { includeAudio: false },
    star_fifi_room: { kv: { settings: { fontSize: '14' }, longTermMemory: '' }, messages: [msg(1, 1000, '在的')], keeps: [], diaries: [], starDiaries: [], futureLetters: [] },
    star_butler_v1: { tasks: [], transactions: [], cycles: [], sleepLogs: [], meta: [] },
    localStorage: { 'ylxh.vocab.v1': '[]' },
    radio_voice: { clips: [] },
    chat_voice: { clips: [] },
  }, over || {});
}

test('F01 canonicalString 与 key 顺序无关', () => {
  const a = { b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } };
  const b = { a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 };
  assert.equal(BF.canonicalString(a), BF.canonicalString(b));
  assert.equal(BF.canonicalString({ a: 1 }), '{"a":1}');
});

test('F02 sha256Hex 命中标准向量', async () => {
  assert.equal(await BF.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal((await BF.sha256Hex('')).length, 64);
});

test('F03 detectVersion 区分 v2 / 旧版 / 垃圾文件', () => {
  assert.equal(BF.detectVersion(v2file()), 'v2');
  assert.equal(BF.detectVersion({ messages: [], settings: {} }), 'v1');
  assert.equal(BF.detectVersion({ foo: 1 }), 'unknown');
  assert.equal(BF.detectVersion(null), 'unknown');
});

test('F04 normalizeBackup v2 完整还原五个分区', () => {
  const n = BF.normalizeBackup(v2file());
  assert.equal(n.version, 'v2');
  assert.equal(n.sections.room.messages.length, 1);
  assert.equal(n.sections.room.kv.settings.fontSize, '14');
  assert.equal(n.sections.localStorage['ylxh.vocab.v1'], '[]');
  assert.deepEqual(n.sections.chatVoice.clips, []);
  assert.deepEqual(n.absent, []);
});

test('F05 normalizeBackup 旧版 v1：房间表在，其余分区标记缺失', () => {
  const n = BF.normalizeBackup({ messages: [msg(1, 1, 'hi')], keeps: [], settings: { showEnglish: true }, longTermMemory: 'x' });
  assert.equal(n.version, 'v1');
  assert.equal(n.sections.room.messages.length, 1);
  assert.equal(n.sections.room.kv.longTermMemory, 'x');
  assert.ok(n.absent.includes('star_butler_v1'));
  assert.ok(n.absent.includes('localStorage'));
  assert.ok(n.absent.includes('radio_voice'));
});

test('F06 localStorage 白名单：越界键丢弃并记警告', () => {
  const n = BF.normalizeBackup(v2file({ localStorage: { 'ylxh.vocab.v1': '[]', 'evil.key': 'x' } }));
  assert.deepEqual(Object.keys(n.sections.localStorage), ['ylxh.vocab.v1']);
  assert.ok(n.warnings.some((w) => w.includes('evil.key')));
});

test('F07 countsOf 统计各分区与附件数', () => {
  const s = sections();
  s.room.messages = [msg(1, 1, 'a', { image: 'data:image/png;base64,AA' }), msg(2, 2, 'b')];
  s.room.keeps = [{ id: 1, title: 't', content: 'c' }];
  s.butler.tasks = [{ id: 't1' }, { id: 't2' }];
  s.localStorage = { 'ylxh.vocab.v1': '[]', gomoku_wins: '3' };
  const c = BF.countsOf(s);
  assert.equal(c.room.messages, 2);
  assert.equal(c.room.keeps, 1);
  assert.equal(c.butler.tasks, 2);
  assert.equal(c.localStorage, 2);
  assert.equal(c.attachments, 1);
});

test('F08 buildIntegrity 不含 integrity 自身：加/改 integrity 不改变 payloadHash', async () => {
  const f = v2file();
  const a = await BF.buildIntegrity(f);
  const withInteg = v2file({ integrity: { payloadHash: 'deadbeef', counts: { x: 1 } } });
  const b = await BF.buildIntegrity(withInteg);
  assert.equal(a.payloadHash, b.payloadHash);
  assert.equal(a.algo, 'sha256');
  assert.ok(a.perStore['star_fifi_room']);
  assert.equal(a.counts.room.messages, 1);
});

test('F09 verifyIntegrity 正常文件通过，改动正文后拒绝', async () => {
  const f = v2file();
  f.integrity = await BF.buildIntegrity(f);
  assert.equal((await BF.verifyIntegrity(f)).ok, true);
  const bad = v2file();
  bad.integrity = f.integrity;
  bad.star_fifi_room.messages[0].content = '被改过';
  const r = await BF.verifyIntegrity(bad);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'payload-hash-mismatch');
});

test('F10 verifyIntegrity count 不一致会被拦下', async () => {
  const f = v2file();
  f.integrity = await BF.buildIntegrity(f);
  f.integrity.counts = Object.assign({}, f.integrity.counts, { radioVoice: 9 });
  const r = await BF.verifyIntegrity(f);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'counts-mismatch');
});

test('F11 二进制包装：往返一致、长度不符报错、哈希不符可检出', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 250]);
  const packed = await BF.encodeBinary(bytes, 'audio/webm');
  assert.equal(packed.__bytes, true);
  assert.equal(packed.bytes, 5);
  const back = BF.decodeBinary(packed);
  assert.deepEqual(Array.from(back.bytes), [1, 2, 3, 4, 250]);
  assert.equal(back.mime, 'audio/webm');

  const broken = Object.assign({}, packed, { bytes: 99 });
  assert.throws(() => BF.decodeBinary(broken), /长度不符/);

  const tampered = Object.assign({}, packed, { base64: BF.bytesToBase64(new Uint8Array([9, 9, 9, 9, 9])) });
  const r = await BF.verifyAttachment(tampered);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'hash-mismatch');
});

test('F12 附件哈希：blob 内部字节数与 base64 不符时整份文件校验失败', async () => {
  const packed = await BF.encodeBinary(new Uint8Array([7, 7, 7]), 'audio/mpeg');
  // 长度字段被写坏（例如传输中被截断的记录），payload 哈希仍自洽，必须靠附件级校验发现
  const f = v2file({ radio_voice: { clips: [{ id: 'c1', name: '雨声', size: 3, createdAt: 1, blob: Object.assign({}, packed, { bytes: 4 }) }] } });
  f.integrity = await BF.buildIntegrity(f);
  const r = await BF.verifyIntegrity(f);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'attachment-broken');
  assert.equal(r.detail.id, 'c1');
});

test('F12b 声音收藏的 blob 内容被篡改 → payload 哈希先一步拦下', async () => {
  const packed = await BF.encodeBinary(new Uint8Array([7, 7, 7]), 'audio/mpeg');
  const f = v2file({ radio_voice: { clips: [{ id: 'c1', name: '雨声', size: 3, createdAt: 1, blob: packed }] } });
  f.integrity = await BF.buildIntegrity(f);
  assert.equal((await BF.verifyIntegrity(f)).ok, true);
  f.radio_voice.clips[0].blob = Object.assign({}, packed, { base64: BF.bytesToBase64(new Uint8Array([1, 1, 1])) });
  assert.equal((await BF.verifyIntegrity(f)).reason, 'payload-hash-mismatch');
});

test('F13 合并：无冲突时保留原 id', () => {
  const plan = BF.buildPlan({
    mode: 'merge',
    target: sections(),
    backup: sections({ room: Object.assign(sections().room, { messages: [msg(5, 100, 'a'), msg(6, 200, 'b')] }) }),
  });
  assert.deepEqual(plan.room.messages.inserts.map((m) => m.id), [5, 6]);
  assert.deepEqual(plan.idMap.messages, {});
  assert.equal(plan.stats.conflict, 0);
});

test('F14 合并：同 id 同内容 → 跳过，不重复插入', () => {
  const t = sections({ room: Object.assign(sections().room, { messages: [msg(5, 100, 'a')] }) });
  const plan = BF.buildPlan({ mode: 'merge', target: t, backup: sections({ room: Object.assign(sections().room, { messages: [msg(5, 100, 'a')] }) }) });
  assert.equal(plan.room.messages.inserts.length, 0);
  assert.equal(plan.room.messages.skips.length, 1);
  assert.equal(plan.room.messages.skips[0].id, 5);
  assert.equal(plan.room.messages.skips[0].reason, 'identical');
  assert.equal(typeof plan.room.messages.skips[0].h, 'string');
});

test('F15 合并：同 id 不同内容 → 重新分配 id 并登记映射', () => {
  const t = sections({ room: Object.assign(sections().room, { messages: [msg(5, 100, '手机里的版本')] }) });
  const plan = BF.buildPlan({ mode: 'merge', target: t, backup: sections({ room: Object.assign(sections().room, { messages: [msg(5, 100, '电脑里的版本')] }) }) });
  assert.equal(plan.room.messages.inserts.length, 1);
  assert.equal(plan.room.messages.inserts[0].id, 6);
  assert.deepEqual(plan.idMap.messages, { 5: 6 });
  assert.deepEqual(plan.room.messages.conflicts, [{ id: 5, newId: 6 }]);
});

test('F16 合并：不同 id 但同文同秒 → 两条都保留（指纹不是身份）', () => {
  const t = sections({ room: Object.assign(sections().room, { messages: [msg(5, 100, '好。')] }) });
  const plan = BF.buildPlan({ mode: 'merge', target: t, backup: sections({ room: Object.assign(sections().room, { messages: [msg(6, 100, '好。')] }) }) });
  assert.equal(plan.room.messages.inserts.length, 1);
  assert.equal(plan.room.messages.inserts[0].id, 6);
  assert.equal(plan.room.messages.skips.length, 0);
});

test('F17 skip-existing 遇到同 id 异内容：保留手机版本', () => {
  const t = sections({ room: Object.assign(sections().room, { messages: [msg(5, 100, '手机')] }) });
  const plan = BF.buildPlan({ mode: 'skip-existing', target: t, backup: sections({ room: Object.assign(sections().room, { messages: [msg(5, 100, '电脑')] }) }) });
  assert.equal(plan.room.messages.inserts.length, 0);
  assert.equal(plan.room.messages.skips.length, 1);
  assert.equal(plan.room.messages.skips[0].id, 5);
  assert.equal(plan.room.messages.skips[0].reason, 'exists');
});

test('F18 replace 模式：全量写入 + 标记 clear', () => {
  const t = sections({ room: Object.assign(sections().room, { messages: [msg(1, 1, 'old')] }) });
  const plan = BF.buildPlan({ mode: 'replace', target: t, backup: sections({ room: Object.assign(sections().room, { messages: [msg(9, 9, 'new')] }) }) });
  assert.equal(plan.room.messages.clear, true);
  assert.deepEqual(plan.room.messages.inserts.map((m) => m.id), [9]);
  assert.equal(BF.summarize(plan).willClear, true);
});

test('F19 keeps.sourceMessageId 跟随 idMap 改写', () => {
  const t = sections({ room: Object.assign(sections().room, { messages: [msg(5, 100, '手机')] }) });
  const b = sections({ room: Object.assign(sections().room, {
    messages: [msg(5, 100, '电脑')],
    keeps: [{ id: 1, title: 't', content: 'c', createdAt: 9, sourceMessageId: 5 }],
  }) });
  const plan = BF.buildPlan({ mode: 'merge', target: t, backup: b });
  assert.equal(plan.room.keeps.inserts[0].sourceMessageId, 6);
  assert.equal(plan.stats.remap, 1);
});

test('F20 引用指向不存在的消息 → 置 null 并计入 orphan，绝不指向别人', () => {
  const b = sections({ room: Object.assign(sections().room, {
    messages: [],
    keeps: [{ id: 1, title: 't', content: 'c', createdAt: 9, sourceMessageId: 777 }],
  }) });
  const plan = BF.buildPlan({ mode: 'merge', target: sections(), backup: b });
  assert.equal(plan.room.keeps.inserts[0].sourceMessageId, null);
  assert.equal(plan.stats.orphan, 1);
});

test('F21 计划确定性：同输入两次得到同一 idMap 与同一 planHash', async () => {
  const t = sections({ room: Object.assign(sections().room, { messages: [msg(3, 1, 'a'), msg(5, 2, 'b')] }) });
  const b = sections({ room: Object.assign(sections().room, { messages: [msg(3, 1, 'x'), msg(5, 2, 'y'), msg(8, 3, 'z')] }) });
  const p1 = BF.buildPlan({ mode: 'merge', target: t, backup: b });
  const p2 = BF.buildPlan({ mode: 'merge', target: t, backup: b });
  assert.deepEqual(p1.idMap, p2.idMap);
  assert.equal(await BF.planHashOf(p1), await BF.planHashOf(p2));
  // id 按升序分配，与数组顺序无关
  assert.deepEqual(p1.idMap.messages, { 3: 6, 5: 7 });
});

test('F22 管家分区：同 id 冲突走同一套规则', () => {
  const t = sections({ butler: Object.assign(sections().butler, { tasks: [{ id: 'a', title: '手机' }] }) });
  const b = sections({ butler: Object.assign(sections().butler, { tasks: [{ id: 'a', title: '电脑' }, { id: 'b', title: '新增' }] }) });
  const plan = BF.buildPlan({ mode: 'merge', target: t, backup: b });
  assert.equal(plan.butler.tasks.inserts.length, 2);
  assert.equal(plan.butler.tasks.conflicts.length, 1);
});

test('F23 localStorage 计划：skip-existing 跳过已有键', () => {
  const t = { room: sections().room, butler: sections().butler, localStorage: { 'ylxh.vocab.v1': 'old' }, radioVoice: sections().radioVoice };
  const b = sections({ localStorage: { 'ylxh.vocab.v1': 'new', gomoku_wins: '5' } });
  const plan = BF.buildPlan({ mode: 'skip-existing', target: t, targetLocalHas: { 'ylxh.vocab.v1': true }, backup: b });
  assert.deepEqual(plan.localStorage.skip, ['ylxh.vocab.v1']);
  assert.deepEqual(Object.keys(plan.localStorage.set), ['gomoku_wins']);
});

test('F24 summarize 汇总给人看的数字', () => {
  const t = sections({ room: Object.assign(sections().room, { messages: [msg(1, 1, 'a')] }) });
  const b = sections({ room: Object.assign(sections().room, { messages: [msg(1, 1, 'a'), msg(2, 2, 'b')] }) });
  const s = BF.summarize(BF.buildPlan({ mode: 'merge', target: t, backup: b }));
  assert.deepEqual(
    { insert: s.insert, skip: s.skip, conflict: s.conflict, clear: s.willClear },
    { insert: 1, skip: 1, conflict: 0, clear: false }
  );
});

/* ---------------- A 组：验收修订项 ---------------- */

test('A01 pending_chat_message 不在白名单，且明确记为「未迁移」', () => {
  assert.equal(BF.LS_ALLOW.includes('pending_chat_message'), false);
  assert.ok(BF.LS_EXCLUDED.pending_chat_message);
  const n = BF.normalizeBackup(v2file({ localStorage: { 'ylxh.vocab.v1': '[]', pending_chat_message: '{"content":"草稿"}' } }));
  assert.equal('pending_chat_message' in n.sections.localStorage, false);
  assert.ok(n.warnings.some((w) => w.includes('pending_chat_message') && w.includes('未迁移')));
});

test('A02 dataURL 按原始字节计，不按字符串长度', () => {
  // 'AAEC' = 3 字节、'AAAA' = 3 字节、'AAA=' = 2 字节
  assert.equal(BF.dataUrlByteLength('data:audio/mpeg;base64,AAEC'), 3);
  assert.equal(BF.dataUrlByteLength('data:image/png;base64,AAAA'), 3);
  assert.equal(BF.dataUrlByteLength('data:image/png;base64,AAA='), 2);
  assert.equal(BF.dataUrlByteLength('https://example.com/a.png'), 0);
  assert.equal(BF.dataUrlByteLength(''), 0);
});

test('A03 附件总账：五类附件分别计数并汇总真实字节', () => {
  const b64 = BF.bytesToBase64(new Uint8Array(1000));
  const s = sections();
  s.room.messages = [
    msg(1, 1, 'a', { image: 'data:image/png;base64,' + b64 }),
    msg(2, 2, 'b', { audioData: 'data:audio/mpeg;base64,' + b64 }),
  ];
  s.room.futureLetters = [{ id: 1, title: 't', photo: 'data:image/jpeg;base64,' + b64 }];
  s.room.kv.settings = { wallpaper: 'data:image/png;base64,' + b64 };
  s.radioVoice.clips = [{ id: 'c1', blob: { __bytes: true, mime: 'audio/mpeg', bytes: 5000, sha256: 'x', base64: '' } }];
  const r = BF.attachmentReport(s);
  assert.equal(r.byKind['chat-image'].bytes, 1000);
  assert.equal(r.byKind['chat-audio'].bytes, 1000);
  assert.equal(r.byKind['photo'].bytes, 1000);
  assert.equal(r.byKind['wallpaper'].bytes, 1000);
  assert.equal(r.byKind['voice-clip'].bytes, 5000);
  assert.equal(r.totalBytes, 9000);
  assert.equal(r.totalCount, 5);
  assert.equal(r.level, 'ok');
  // 同一个 dataURL 的字符串长度明显大于真实字节，绝不能拿它当体积
  assert.ok(('data:image/png;base64,' + b64).length > 1000);
});

test('A04 超过 50 MiB 只提醒，不阻断；预算检查返回 warn', () => {
  const s = sections();
  s.radioVoice.clips = [{ id: 'c1', blob: { __bytes: true, bytes: 51 * 1024 * 1024, sha256: 'x', base64: '' } }];
  const r = BF.attachmentReport(s);
  assert.equal(r.overWarn, true);
  assert.equal(r.overHard, false);
  assert.equal(r.level, 'warn');
  const chk = BF.checkAttachmentBudget(r);
  assert.equal(chk.ok, true);
  assert.equal(chk.warn, true);
});

test('A05 超硬上限必须中止，不能生成缺附件的备份', () => {
  const s = sections();
  s.radioVoice.clips = [{ id: 'c1', blob: { __bytes: true, bytes: 100 * 1024 * 1024 + 1, sha256: 'x', base64: '' } }];
  const r = BF.attachmentReport(s);
  assert.equal(r.level, 'blocked');
  const chk = BF.checkAttachmentBudget(r);
  assert.equal(chk.ok, false);
  assert.equal(chk.reason, 'attachment-over-hard-limit');
  assert.equal(BF.ATTACH_LIMITS.warn, 50 * 1024 * 1024);
  assert.equal(BF.ATTACH_LIMITS.hard, 100 * 1024 * 1024);
});

test('A06 声音素材缺 blob → 阻断，不静默跳过', () => {
  const s = sections();
  s.radioVoice.clips = [{ id: 'c1', name: '呼吸' }];
  const r = BF.attachmentReport(s);
  assert.deepEqual(r.missing, ['radio_voice/c1']);
  assert.equal(r.level, 'blocked');
  assert.equal(BF.checkAttachmentBudget(r).reason, 'attachment-missing');
});

test('A07 外部链接图片单独列出（不算字节，也不假装已迁移）', () => {
  const s = sections();
  s.room.messages = [msg(1, 1, 'x', { image: 'https://cdn.example.com/a.png' })];
  const r = BF.attachmentReport(s);
  assert.deepEqual(r.external, ['messages/1/image']);
  assert.equal(r.totalBytes, 0);
});

test('A08 normalizeBackup 不丢附件字段：图片/语音/photo/blob 原样保留', async () => {
  const packed = await BF.encodeBinary(new Uint8Array([1, 2, 3]), 'audio/mpeg');
  const f = v2file();
  f.star_fifi_room.messages = [
    msg(1, 1, 'a', { image: 'data:image/png;base64,AAAA', audioData: 'data:audio/mpeg;base64,AAEC', silent: true, silentReason: '嗯。' }),
  ];
  f.star_fifi_room.futureLetters = [{ id: 3, photo: 'data:image/jpeg;base64,AAAA', replyMessageId: 1 }];
  f.radio_voice = { clips: [{ id: 'c1', name: '雨声', mime: 'audio/mpeg', size: 3, blob: packed }] };
  const n = BF.normalizeBackup(f);
  assert.equal(n.sections.room.messages[0].audioData, 'data:audio/mpeg;base64,AAEC');
  assert.equal(n.sections.room.messages[0].image, 'data:image/png;base64,AAAA');
  assert.equal(n.sections.room.messages[0].silent, true);
  assert.equal(n.sections.room.futureLetters[0].photo, 'data:image/jpeg;base64,AAAA');
  assert.equal(n.sections.radioVoice.clips[0].blob.base64, packed.base64);
  assert.equal(n.sections.radioVoice.clips[0].blob.mime, 'audio/mpeg');
  // v1 里若带语音也不丢
  const v1 = BF.normalizeBackup({ messages: [msg(1, 1, 'a', { audioData: 'data:audio/mpeg;base64,AAEC' })] });
  assert.equal(v1.sections.room.messages[0].audioData, 'data:audio/mpeg;base64,AAEC');
});

test('A09 radio_voice 是独立分区：计数、perStore 哈希、计划都单独算', async () => {
  const packed = await BF.encodeBinary(new Uint8Array([9, 9]), 'audio/mpeg');
  const f1 = v2file({ radio_voice: { clips: [{ id: 'c1', name: 'a', blob: packed }] } });
  const f2 = v2file({ radio_voice: { clips: [{ id: 'c2', name: 'b', blob: packed }] } });
  const i1 = await BF.buildIntegrity(f1);
  const i2 = await BF.buildIntegrity(f2);
  assert.equal(i1.counts.radioVoice, 1);
  assert.ok(i1.perStore['radio_voice']);
  assert.notEqual(i1.perStore['radio_voice'], i2.perStore['radio_voice']);
  assert.equal(i1.attachmentCount, 1);
  assert.equal(i1.attachmentBytes, 2);
  assert.equal(i1.attachments[0].kind, 'voice-clip');
  const plan = BF.buildPlan({ mode: 'merge', target: sections(), backup: BF.normalizeBackup(f1).sections });
  assert.equal(plan.radioVoice.inserts.length, 1);
  // 1 条消息 + 1 段声音素材，两个分区各自计数
  assert.equal(plan.stats.insert, 2);
});

test('A10 planHash 覆盖写入内容，不只是 id', async () => {
  const t = sections();
  const a = BF.buildPlan({ mode: 'merge', target: t, backup: sections({ room: Object.assign(sections().room, { messages: [msg(9, 9, '甲')] }) }) });
  const b = BF.buildPlan({ mode: 'merge', target: sections(), backup: sections({ room: Object.assign(sections().room, { messages: [msg(9, 9, '乙')] }) }) });
  assert.deepEqual(a.room.messages.inserts.map((m) => m.id), b.room.messages.inserts.map((m) => m.id));
  assert.notEqual(await BF.planHashOf(a), await BF.planHashOf(b));
  assert.equal(await BF.planHashOf(a), await BF.planHashOf(BF.buildPlan({ mode: 'merge', target: t, backup: sections({ room: Object.assign(sections().room, { messages: [msg(9, 9, '甲')] }) }) })));
});

test('A11 管家 meta 同 key 冲突 → 按键覆盖，不生成幽灵 id', () => {
  const t = sections({ butler: Object.assign(sections().butler, { meta: [{ key: 'k', value: '手机' }] }) });
  const b = sections({ butler: Object.assign(sections().butler, { meta: [{ key: 'k', value: '电脑' }] }) });
  const plan = BF.buildPlan({ mode: 'merge', target: t, backup: b });
  assert.equal(plan.butler.meta.inserts.length, 0);
  assert.equal(plan.butler.meta.upserts.length, 1);
  assert.deepEqual(plan.butler.meta.conflicts, [{ key: 'k', action: 'overwrite' }]);
  assert.equal(plan.stats.upsert, 1);
});

test('A12 引用字段全覆盖：diaries / futureLetters 的 replyMessageId 一样改写', () => {
  const t = sections({ room: Object.assign(sections().room, { messages: [msg(5, 100, '手机')] }) });
  const b = sections({ room: Object.assign(sections().room, {
    messages: [msg(5, 100, '电脑')],
    diaries: [{ id: 1, title: 'd', content: 'c', createdAt: 1, replyMessageId: 5 }],
    futureLetters: [{ id: 2, title: 'f', content: 'c', createdAt: 2, replyMessageId: 5 }],
  }) });
  const plan = BF.buildPlan({ mode: 'merge', target: t, backup: b });
  assert.equal(plan.room.diaries.inserts[0].replyMessageId, 6);
  assert.equal(plan.room.futureLetters.inserts[0].replyMessageId, 6);
  assert.equal(plan.stats.remap, 2);
  // 批量改写函数与 buildPlan 同源同结果
  const rewritten = BF.remapRefs('diaries', [{ id: 1, replyMessageId: 5 }], { 5: 6 }, new Set([6]));
  assert.equal(rewritten[0].replyMessageId, 6);
});

test('A13 integrity 的 attachmentBytes 用真实字节，且与字符串长度不同', async () => {
  const b64 = BF.bytesToBase64(new Uint8Array(1000));
  const f = v2file();
  f.star_fifi_room.messages = [msg(1, 1, 'a', { image: 'data:image/png;base64,' + b64 })];
  const it = await BF.buildIntegrity(f);
  assert.equal(it.attachmentBytes, 1000);
  assert.equal(it.counts.attachmentBytes, 1000);
  assert.ok(('data:image/png;base64,' + b64).length > 1300);
  f.integrity = it;
  assert.equal((await BF.verifyIntegrity(f)).ok, true);
  f.integrity = Object.assign({}, it, { attachmentBytes: 999 });
  assert.equal((await BF.verifyIntegrity(f)).reason, 'attachment-bytes-mismatch');
});

test('A14 encodeBinary 保留 MIME 与原始字节，sha256 按字节计算', async () => {
  const raw = new Uint8Array([0, 1, 2, 250, 255]);
  const packed = await BF.encodeBinary(raw, 'audio/mpeg');
  const { createHash } = await import('node:crypto');
  assert.equal(packed.sha256, createHash('sha256').update(Buffer.from(raw)).digest('hex'));
  const dec = BF.decodeBinary(packed);
  assert.equal(dec.mime, 'audio/mpeg');
  assert.deepEqual(Array.from(dec.bytes), Array.from(raw));
});

test('A15 未打包的 Blob 会被拦下，不会写成空对象', () => {
  const s = sections();
  s.radioVoice.clips = [{ id: 'c1', name: '呼吸', blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' }) }];
  const r = BF.attachmentReport(s);
  assert.deepEqual(r.unpacked, ['radio_voice/c1']);
  assert.equal(r.level, 'blocked');
  const chk = BF.checkAttachmentBudget(r);
  assert.equal(chk.ok, false);
  assert.equal(chk.reason, 'attachment-not-packed');
});

test('A16 base64 长度与声明字节数不符 → 判为异常并阻断', async () => {
  const packed = await BF.encodeBinary(new Uint8Array([1, 2, 3]), 'audio/mpeg');
  const s = sections();
  s.radioVoice.clips = [{ id: 'c1', blob: Object.assign({}, packed, { bytes: 9 }) }];
  const r = BF.attachmentReport(s);
  assert.deepEqual(r.invalid, ['radio_voice/c1']);
  assert.equal(BF.checkAttachmentBudget(r).reason, 'attachment-invalid');
});

test('A17 重复字节可被发现（同内容两段素材）', async () => {
  const packed = await BF.encodeBinary(new Uint8Array([5, 5, 5]), 'audio/mpeg');
  const s = sections();
  s.radioVoice.clips = [{ id: 'c1', blob: packed }, { id: 'c2', blob: packed }];
  const r = BF.attachmentReport(s);
  assert.equal(r.duplicates.length, 1);
  assert.equal(r.duplicates[0].count, 2);
  assert.equal(r.totalBytes, 6);
});

/* ---------------- B 组：只读核验项 ---------------- */

test('B01 v1 旧备份：语音被剥离必须说明，不能当成已迁移', () => {
  const n = BF.normalizeBackup({ messages: [msg(1, 1, 'a')], settings: {} });
  assert.equal(n.audio.legacyStripped, true);
  assert.equal(n.audio.withAudio, 0);
  assert.ok(n.warnings.some((w) => w.includes('旧版备份导出时会删除语音')));
  assert.ok(BF.describeGaps(n).some((g) => g.includes('语音')));
});

test('B02 v2 无语音：如实说「该备份没有语音」，不冒充旧版剥离', () => {
  const n = BF.normalizeBackup(v2file());
  assert.equal(n.audio.legacyStripped, false);
  assert.equal(n.audio.withAudio, 0);
  assert.ok(BF.describeGaps(n).some((g) => g.includes('没有语音数据')));
  const f = v2file();
  f.star_fifi_room.messages = [msg(1, 1, 'a', { audioData: 'data:audio/mpeg;base64,AAEC' })];
  const n2 = BF.normalizeBackup(f);
  assert.equal(n2.audio.withAudio, 1);
  assert.deepEqual(BF.describeGaps(n2), []);
});

test('B03 素材同元数据但字节不同 → 冲突换 id，绝不当重复跳过', async () => {
  const a = await BF.encodeBinary(new Uint8Array([1, 2, 3]), 'audio/mpeg');
  const b = await BF.encodeBinary(new Uint8Array([4, 5, 6]), 'audio/mpeg');
  const meta = { id: 'c1', name: '呼吸', size: 3, createdAt: 1 };
  const t = sections({ radioVoice: { clips: [Object.assign({}, meta, { blob: a })] } });
  const plan = BF.buildPlan({ mode: 'merge', target: t, backup: sections({ radioVoice: { clips: [Object.assign({}, meta, { blob: b })] } }) });
  assert.equal(plan.radioVoice.inserts.length, 1);
  assert.equal(plan.radioVoice.skips.length, 0);
  const plan2 = BF.buildPlan({ mode: 'merge', target: t, backup: sections({ radioVoice: { clips: [Object.assign({}, meta, { blob: a })] } }) });
  assert.equal(plan2.radioVoice.inserts.length, 0);
  assert.equal(plan2.radioVoice.skips[0].reason, 'identical');
});

test('B04 消息同 id 同文字但图片不同 → 冲突换 id，不丢图', () => {
  const t = sections({ room: Object.assign(sections().room, { messages: [msg(5, 100, '在的', { image: 'data:image/png;base64,AAAA' })] }) });
  const b = sections({ room: Object.assign(sections().room, { messages: [msg(5, 100, '在的', { image: 'data:image/png;base64,BBBB' })] }) });
  const plan = BF.buildPlan({ mode: 'merge', target: t, backup: b });
  assert.equal(plan.room.messages.inserts.length, 1);
  assert.equal(plan.room.messages.inserts[0].id, 6);
  assert.deepEqual(plan.idMap.messages, { 5: 6 });
});

test('B05 planHash 覆盖附件 sha256（base64 本体不参与，由 payloadHash 负责）', async () => {
  const a = await BF.encodeBinary(new Uint8Array([1, 2, 3]), 'audio/mpeg');
  const b = await BF.encodeBinary(new Uint8Array([3, 2, 1]), 'audio/mpeg');
  const mk = (blob) => BF.buildPlan({
    mode: 'merge', target: sections(),
    backup: sections({ radioVoice: { clips: [{ id: 'c1', name: 'x', size: 3, createdAt: 1, blob }] } }),
  });
  assert.notEqual(await BF.planHashOf(mk(a)), await BF.planHashOf(mk(b)));
  assert.equal(await BF.planHashOf(mk(a)), await BF.planHashOf(mk(a)));
  const tampered = Object.assign({}, a, { base64: 'AAAA' });
  assert.equal(await BF.planHashOf(mk(a)), await BF.planHashOf(mk(tampered)));
});

test('B06 反向引用：消息 source=today-letter 的 sourceId 跟随日记重分配', () => {
  const t = sections({ room: Object.assign(sections().room, { diaries: [{ id: 2, title: 'd', content: '手机', createdAt: 1 }] }) });
  const b = sections({ room: Object.assign(sections().room, {
    diaries: [{ id: 2, title: 'd', content: '电脑', createdAt: 1 }],
    messages: [{ id: 9, role: 'assistant', content: '信', time: 5, source: 'today-letter', sourceId: 2 }],
  }) });
  const plan = BF.buildPlan({ mode: 'merge', target: t, backup: b });
  assert.equal(plan.room.diaries.inserts[0].id, 3);
  assert.equal(plan.room.messages.inserts[0].sourceId, 3);
  assert.equal(plan.stats.remap, 1);
});

test('B07 反向引用孤儿：日记不存在 → sourceId 置空并上报', () => {
  const b = sections({ room: Object.assign(sections().room, {
    diaries: [],
    messages: [{ id: 9, role: 'assistant', content: '信', time: 5, source: 'today-letter', sourceId: 777 }],
  }) });
  const plan = BF.buildPlan({ mode: 'merge', target: sections(), backup: b });
  assert.equal(plan.room.messages.inserts[0].sourceId, null);
  assert.deepEqual(plan.orphans, [{ store: 'messages', id: 9, fields: ['sourceId'] }]);
  assert.equal(plan.stats.orphan, 1);
});

test('B08 设置与长期记忆是单例：合并按键保留、跳过模式不覆盖、替换模式整体覆盖', () => {
  const t = sections();
  t.room.kv = { settings: { fontSize: '14', starMotion: false }, longTermMemory: '手机的旧记忆' };
  const b = sections();
  b.room.kv = { settings: { fontSize: '16', wallpaper: 'data:image/jpeg;base64,/9j/4A==' }, longTermMemory: '电脑的新记忆' };

  const merge = BF.buildPlan({ mode: 'merge', target: t, backup: b });
  assert.equal(merge.kvSet.settings.fontSize, '16');
  assert.equal(merge.kvSet.settings.starMotion, false, '手机上独有的键要保留');
  assert.ok(merge.kvSet.settings.wallpaper);
  assert.equal(merge.kvSet.longTermMemory, '电脑的新记忆');

  const skip = BF.buildPlan({ mode: 'skip-existing', target: t, backup: b });
  assert.deepEqual(skip.kvSet, {}, '已有设置与记忆时一律不动');

  const replace = BF.buildPlan({ mode: 'replace', target: t, backup: b });
  assert.deepEqual(replace.kvSet.settings, b.room.kv.settings);
  assert.equal(replace.kvSet.settings.starMotion, undefined);

  // kvSet 必须进 planHash，否则「计划没变」的判断会漏掉设置
  const other = BF.buildPlan({ mode: 'merge', target: sections(), backup: b });
  assert.notDeepEqual(other.kvSet, merge.kvSet);
});

test('B09 同一份备份导入两次：上次换过 id 的冲突记录不能被再次插入', async () => {
  const packed = await BF.encodeBinary(new Uint8Array([1, 2, 3]), 'audio/mpeg');
  const backup = sections();
  backup.room.messages = [msg(2, 2000, '晚安，用户。', { image: 'data:image/png;base64,iVBORw0KGgo=' })];
  // 手机上的 id 2 是另一条，上次导入把电脑那条写成了 id 4
  const target = sections();
  target.room.messages = [
    msg(1, 1000, '晚安'),
    msg(2, 2000, '手机上原来就有的'),
    msg(4, 2000, '晚安，用户。', { image: 'data:image/png;base64,iVBORw0KGgo=' }),
  ];
  const plan = BF.buildPlan({ mode: 'merge', target: target, backup: backup });
  assert.equal(plan.room.messages.inserts.length, 0, '不应再插入一份');
  assert.equal(plan.room.messages.skips.length, 1);
  assert.equal(plan.room.messages.skips[0].reason, 'already-imported');
  assert.equal(plan.room.messages.skips[0].at, 4);
  assert.equal(plan.stats.conflict, 0);
  // 首次导入（目标里没有这条）仍然要正常换 id 插入
  const first = BF.buildPlan({ mode: 'merge', target: sections({ room: Object.assign(sections().room, { messages: [msg(2, 2000, '手机上的')] }) }), backup: backup });
  assert.equal(first.room.messages.inserts.length, 1);
  assert.equal(first.room.messages.inserts[0].id, 3);
  void packed;
});

test('B10 counts.attachments 与附件清单口径一致（含聊天语音）', () => {
  const s = sections();
  s.room.messages = [msg(1, 1, 'a', { image: 'data:image/png;base64,AAAA', audioData: 'data:audio/mpeg;base64,AAEC' })];
  s.room.keeps = [{ id: 1, title: 't', photo: 'data:image/jpeg;base64,AAAA' }];
  const c = BF.countsOf(s);
  assert.equal(c.attachments, 3);
  assert.equal(c.audio, 1);
  assert.equal(c.attachmentBytes, BF.attachmentBytesOf(s));
});

/* ---------------- C 组：聊天语音分区与旧文件兼容 ---------------- */

test('C01 旧版 v2 备份（没有 chat_voice 分区）仍能通过完整性校验', async () => {
  const f = v2file();
  delete f.chat_voice;
  f.star_fifi_room.messages = [msg(1, 1000, '在的', { audioData: 'data:audio/mpeg;base64,AAEC' })];
  const integrity = await BF.buildIntegrity(f);
  // 模拟旧代码写出的 integrity：没有 chat_voice 这一项
  delete integrity.perStore.chat_voice;
  f.integrity = integrity;
  const v = await BF.verifyIntegrity(f);
  assert.equal(v.ok, true, v.reason);
  const n = BF.normalizeBackup(f);
  assert.ok(n.absent.includes('chat_voice'));
  assert.deepEqual(n.sections.chatVoice.clips, []);
  assert.equal(n.audio.voiceMessages, 0);
  // 老文件没有语音消息引用，不能凭空报「聊天语音缺音频」
  assert.deepEqual(BF.describeGaps(n), []);
});

test('C02 消息引用了录音但文件里没有 → 明确报缺口，不假装完整', async () => {
  const f = v2file();
  f.star_fifi_room.messages = [msg(1, 1000, '晚安', { type: 'voice', audioClipId: 'vc_missing', durationMs: 1200 })];
  const n = BF.normalizeBackup(f);
  assert.equal(n.audio.voiceMessages, 1);
  assert.equal(n.audio.voiceWithClip, 0);
  assert.equal(n.audio.voiceMissing, 1);
  assert.ok(n.warnings.some((w) => w.includes('找不到对应录音')));
  assert.ok(BF.describeGaps(n).some((g) => g.includes('缺少原始录音')));
});

test('C03 语音录音随备份走：chat_voice 计入附件并参与合并计划', async () => {
  const packed = await BF.encodeBinary(new Uint8Array([7, 7, 7, 7]), 'audio/webm');
  const clip = { id: 'vc_1', mime: 'audio/webm', size: 4, durationMs: 900, createdAt: 1, blob: packed };
  const s = sections({ chatVoice: { clips: [clip] } });
  s.room.messages = [msg(1, 1000, '晚安', { type: 'voice', audioClipId: 'vc_1', durationMs: 900 })];

  const report = BF.attachmentReport(s);
  assert.equal(report.totalCount, 1);
  assert.equal(report.totalBytes, 4);
  assert.equal(report.items[0].at, 'chat_voice/vc_1');
  assert.equal(report.level, 'ok');

  const plan = BF.buildPlan({ mode: 'merge', target: sections(), backup: s });
  assert.equal(plan.chatVoice.inserts.length, 1);
  assert.equal(plan.stats.insert, 2);   // 一条消息 + 一段录音

  // 同样的字节再次导入 → 跳过，不重复占空间
  const again = BF.buildPlan({ mode: 'merge', target: s, backup: s });
  assert.equal(again.chatVoice.inserts.length, 0);
  assert.equal(again.chatVoice.skips[0].reason, 'identical');
});

test('C04 同 id 同文字但语音录音不同 → 视为不同消息，不能当重复跳过', () => {
  const a = { id: 5, role: 'user', content: '嗯', time: 100, type: 'voice', audioClipId: 'vc_a', durationMs: 800 };
  const b = { id: 5, role: 'user', content: '嗯', time: 100, type: 'voice', audioClipId: 'vc_b', durationMs: 800 };
  const plan = BF.buildPlan({ mode: 'merge', target: sections({ room: Object.assign(sections().room, { messages: [b] }) }), backup: sections({ room: Object.assign(sections().room, { messages: [a] }) }) });
  assert.equal(plan.room.messages.conflicts.length, 1);
  assert.equal(plan.room.messages.inserts.length, 1);
});
