/* tests/radio/radio-program.test.mjs — 英文节目编排纯逻辑回归
 * 覆盖：选材顺序、每期 3~5 段、素材去重、标题/简介/封面本地生成。
 * 全部为纯函数测试，不触碰网络、不触碰 IndexedDB。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROGRAM_MIN, PROGRAM_MAX,
  pickProgramSegments, usedMessageIds, buildProgramMeta,
} from '../../public/playground/radio-program.js';

const seg = (id, at, en) => ({ messageId: String(id), at, en: en || `English line number ${id} for the programme.`, zh: `第 ${id} 段` });

function makeList(n, startAt = 1_700_000_000_000) {
  return Array.from({ length: n }, (_, i) => seg(i + 1, startAt + i * 3_600_000));
}

test('P01 每期至少 3 段、至多 5 段', () => {
  assert.equal(pickProgramSegments(makeList(9)).length, PROGRAM_MAX);
  assert.equal(pickProgramSegments(makeList(4)).length, 4);
  // 只有 2 段时不硬凑：返回全部可用素材，由调用方判断够不够成期
  assert.equal(pickProgramSegments(makeList(2)).length, 2);
  assert.equal(PROGRAM_MIN, 3);
});

test('P02 按聊天时间从早到晚排列（像一期有顺序的回顾）', () => {
  const shuffled = [seg(3, 3000), seg(1, 1000), seg(2, 2000)];
  assert.deepEqual(pickProgramSegments(shuffled).map(s => s.messageId), ['1', '2', '3']);
});

test('P03 没有英文文本的片段不进节目（不能拿纯文字冒充语音）', () => {
  const list = [seg(1, 1000), { messageId: '2', at: 2000, en: '   ' }, { messageId: '3', at: 3000, en: '' }, seg(4, 4000)];
  const picked = pickProgramSegments(list);
  assert.deepEqual(picked.map(s => s.messageId), ['1', '4']);
});

test('P04 已用素材识别：旧版单段节目看 externalId，新版看 segments', () => {
  const eps = [
    { channel: 'english', externalId: 'msg:11', segments: [] },
    { channel: 'english', externalId: 'program:ep_x', segments: [{ messageId: '12' }, { messageId: 13 }] },
    { channel: 'reading', externalId: 'msg:99', segments: [{ messageId: '98' }] },
  ];
  const used = usedMessageIds(eps);
  assert.equal(used.has('11'), true);
  assert.equal(used.has('12'), true);
  assert.equal(used.has('13'), true);
  assert.equal(used.has('99'), false, '非英文频道不占用英文素材');
});

test('P05 标题、封面、简介全部由本地规则生成', () => {
  const segs = [
    seg(1, new Date('2026-03-02T22:10:00').getTime(), 'Goodnight, sleep well tonight. The moon is bright.'),
    seg(2, new Date('2026-03-04T23:40:00').getTime(), 'I hope you can sleep early tonight.'),
    seg(3, new Date('2026-03-06T21:05:00').getTime(), 'Late night talks are always my favourite.'),
  ];
  const meta = buildProgramMeta(segs);
  assert.match(meta.title, /^Night Notes · 03\.02–03\.06$/);
  assert.equal(meta.cover, '🌙');
  assert.match(meta.summary, /3 段/);
  assert.match(meta.summary, /没有再重新生成语音/);
});

test('P06 主题按关键词本地判别，不命中时回落夜景主题', () => {
  const stars = buildProgramMeta([seg(1, 1000, 'Look at the star in the sky, so bright and shining.')]);
  assert.equal(stars.cover, '✨');
  const plain = buildProgramMeta([seg(1, 1000, 'Hmm. Okay. Yes.')]);
  assert.equal(plain.cover, '🌙');
});

test('P07 同一天内的素材标题只出现一个日期，不重复写区间', () => {
  const base = new Date('2026-05-01T20:00:00').getTime();
  const meta = buildProgramMeta([seg(1, base), seg(2, base + 60000), seg(3, base + 120000)]);
  assert.match(meta.title, /05\.01/);
  assert.doesNotMatch(meta.title, /–/);
});

test('P08 第二期不会重复使用第一期已收的素材', () => {
  const all = makeList(8);
  const first = pickProgramSegments(all);
  const used = usedMessageIds([{ channel: 'english', externalId: 'program:x', segments: first }]);
  const rest = all.filter(s => !used.has(s.messageId));
  const second = pickProgramSegments(rest);
  assert.equal(second.length, 3, '剩下 3 段就整期收下，不重复吃第一期素材');
  const overlap = second.filter(s => used.has(s.messageId));
  assert.equal(overlap.length, 0);
  assert.equal(usedMessageIds([{ channel: 'english', segments: [...first, ...second] }]).size, 8);
});
