/* tests/shared/self-narrative-review.test.mjs — 机自述历史回顾纯函数层（S1b）
 * 覆盖：时区日期归属 / 日段分批 / 时间交错与 ID 缺口 / 批次上限与超长单条 /
 *       问答对不被劈开 / 上下文标记 / 提示词构造与回顾语义（零条候选、琐碎互动、
 *       上下文理解、观察与推测、证据覆盖、输出结构不变）/ 输出校验（编造来源、quote 核对、
 *       confirmed 与 basis 的约束）/ 去重判定（同证据不同认识允许并存）。
 * 纯 Node：不读库、不调 AI、不写任何数据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import '../../public/shared/self-narrative-review.js';

const R = globalThis.SelfNarrativeReview;
const TZ = 480; // UTC+8

/** 造一条消息：day = 11 月的日，h/m 为本地时间（UTC+8）。 */
function msg(id, role, content, day, h, m) {
  return { id, role, content, time: Date.UTC(2026, 10, day, (h || 0) - 8, m || 0) };
}

const ids = (batch) => batch.messages.map((x) => x.id);

/* ---------------- R01 日期归属 ---------------- */
test('R01 dayKeyOf 按给定时区归属日期，跨零点清楚分开', () => {
  assert.equal(R.dayKeyOf(Date.UTC(2026, 10, 13, 15, 59), TZ), '2026-11-13', 'UTC 15:59 = 北京 23:59');
  assert.equal(R.dayKeyOf(Date.UTC(2026, 10, 13, 16, 1), TZ), '2026-11-14', 'UTC 16:01 = 北京次日 00:01');
  assert.equal(R.dayKeyOf(Date.UTC(2026, 10, 13, 15, 59), 0), '2026-11-13', '同一时刻在 UTC 仍是 13 号');
  assert.equal(R.dayKeyOf(NaN, TZ), null);
});

/* ---------------- R02 基本分批 ---------------- */
test('R02 按日段切分，id 升序，每批字段完整', () => {
  const list = [
    msg(1, 'user', '今天好累', 13, 10, 0),
    msg(2, 'assistant', '那就早点睡', 13, 10, 1),
    msg(3, 'user', '我到公司了', 14, 9, 0),
  ];
  const p = R.planBatches(list, { tzOffsetMin: TZ });
  assert.equal(p.ok, true);
  assert.equal(p.batches.length, 2);
  assert.equal(p.stats.days, 2);
  assert.deepEqual(ids(p.batches[0]), [1, 2]);
  assert.deepEqual(ids(p.batches[1]), [3]);
  assert.equal(p.batches[0].dayKey, '2026-11-13');
  assert.equal(p.batches[0].firstId, 1);
  assert.equal(p.batches[0].lastId, 2);
  assert.deepEqual(p.batches[1].ctx.map((c) => c.id), [1, 2], '第二天带上上一批末尾两条作上下文');
  assert.equal(p.batches[1].ctx[1].id, 2, '最后一条紧接在本批之前');
  assert.equal(p.batches[1].ctx[0].ctx, 'before');
});

/* ---------------- R03 时间交错 ---------------- */
test('R03 时间与 id 交错时同一天被切成多段，但每个 id 只出现一次', () => {
  const list = [
    msg(1, 'user', '十三号上午', 13, 10, 0),
    msg(2, 'user', '十四号插进来', 14, 9, 0),
    msg(3, 'user', '十三号下午', 13, 15, 0),
  ];
  const p = R.planBatches(list, { tzOffsetMin: TZ });
  assert.equal(p.ok, true);
  assert.equal(p.batches.length, 3, '三个互不相邻的日段');

  const seen = [];
  p.batches.forEach((b) => b.messages.forEach((m) => seen.push(m.id)));
  assert.deepEqual(seen, [1, 2, 3], '不漏读、不重复');
  assert.equal(p.batches[2].lastId, 3, '水位取最后一批的 lastId 不会后退');
});

/* ---------------- R04 ID 缺口 ---------------- */
test('R04 ID 存在缺口不影响分批', () => {
  const list = [
    msg(1, 'user', 'a', 13, 9, 0),
    msg(5, 'assistant', 'b', 13, 9, 1),
    msg(40, 'user', 'c', 13, 9, 2),
  ];
  const p = R.planBatches(list, { tzOffsetMin: TZ });
  assert.equal(p.ok, true);
  assert.equal(p.batches.length, 1);
  assert.deepEqual(p.batches[0].ids, [1, 5, 40]);
});

/* ---------------- R05 批次上限 ---------------- */
test('R05 超过 maxChars 自动切批，且不改变 id 顺序', () => {
  const big = 'x'.repeat(100);
  const list = [
    msg(1, 'user', big, 13, 9, 0),
    msg(2, 'assistant', big, 13, 9, 1),
    msg(3, 'user', big, 13, 9, 2),
  ];
  const p = R.planBatches(list, { tzOffsetMin: TZ, maxChars: 250 });
  assert.equal(p.batches.length, 2);
  assert.deepEqual(ids(p.batches[0]), [1, 2]);
  assert.deepEqual(ids(p.batches[1]), [3]);
});

test('R06 单条超过 maxChars 时独占一批，不会卡住游标', () => {
  const huge = 'y'.repeat(500);
  const list = [
    msg(1, 'user', huge, 13, 9, 0),
    msg(2, 'assistant', '好', 13, 9, 1),
  ];
  const p = R.planBatches(list, { tzOffsetMin: TZ, maxChars: 100 });
  assert.equal(p.batches.length, 2);
  assert.deepEqual(ids(p.batches[0]), [1]);
  assert.equal(p.stats.oversized, 1);
  assert.deepEqual(ids(p.batches[1]), [2]);
});

test('R06b maxItems 也能切批', () => {
  const list = [];
  for (let i = 1; i <= 5; i++) list.push(msg(i, i % 2 ? 'user' : 'assistant', '内容' + i, 13, 9, i));
  const p = R.planBatches(list, { tzOffsetMin: TZ, maxItems: 2 });
  assert.equal(p.batches.length, 3);
  assert.deepEqual(p.batches.map((b) => b.count), [2, 2, 1]);
});

/* ---------------- R07 问答对不被劈开 ---------------- */
test('R07 切点落在问答对中间时，回复同时作为前一批的 ctx-after', () => {
  const list = [
    msg(1, 'user', '睡前说说话', 13, 23, 59),
    msg(2, 'assistant', '好，我听着', 14, 0, 1),
    msg(3, 'user', '今天做了个梦', 14, 0, 2),
  ];
  const p = R.planBatches(list, { tzOffsetMin: TZ });
  assert.equal(p.batches.length, 2);
  assert.equal(p.stats.pairSplits, 1);

  const after = p.batches[0].ctx.find((c) => c.ctx === 'after');
  assert.ok(after, '被劈开的回复要挂进前一批的上下文');
  assert.equal(after.id, 2);
  assert.deepEqual(ids(p.batches[1]), [2, 3], '它仍然属于后一批，不会被重复生成');
});

/* ---------------- R08 入参校验 ---------------- */
test('R08 非升序、缺字段、空数组都明确报错或明确空结果', () => {
  const okList = [msg(2, 'user', 'a', 13, 9, 0)];
  assert.equal(R.planBatches([msg(2, 'user', 'a', 13, 9, 0), msg(1, 'user', 'b', 13, 9, 1)]).reason, 'not-ascending');
  assert.equal(R.planBatches([msg(1, 'user', 'a', 13, 9, 0), msg(1, 'user', 'b', 13, 9, 1)]).reason, 'not-ascending');
  assert.equal(R.planBatches('x').reason, 'bad-params');
  assert.equal(R.planBatches([{ id: 1, role: 'user', content: 'a' }]).reason, 'bad-time');
  assert.equal(R.planBatches([{ id: 'a', role: 'user', content: 'a', time: 1 }]).reason, 'bad-id');
  assert.equal(R.planBatches([{ id: 1, role: 'user', content: 5, time: 1 }]).reason, 'bad-content');

  const empty = R.planBatches([], { tzOffsetMin: TZ });
  assert.equal(empty.ok, true);
  assert.equal(empty.reason, 'empty');
  assert.equal(empty.batches.length, 0);
  assert.equal(okList.length, 1);
});

/* ---------------- R09 提示词 ---------------- */
test('R09 提示词带齐 id、标明上下文、含 JSON 结构与硬规则', () => {
  const list = [
    msg(1, 'user', '她今天穿了新裙子', 13, 9, 0),
    msg(2, 'assistant', '很好看', 13, 9, 1),
    msg(3, 'user', '谢谢', 14, 9, 0),
  ];
  const p = R.planBatches(list, { tzOffsetMin: TZ });
  const out = R.buildPrompt(p.batches[1]);

  assert.match(out.system, /小星/);
  assert.match(out.system, /inferred/);
  assert.match(out.system, /confirmed/);
  assert.match(out.system, /不得编造/);
  assert.match(out.user, /日期：2026-11-14/);
  assert.match(out.user, /\[3\] user：谢谢/);
  assert.match(out.user, /\[2\*\] assistant：很好看/, '上下文消息带星号');
  assert.match(out.system, /"records"/, 'JSON 结构写在 system 里');
});

test('R09b 超长正文在提示词里被截断，但批数据保留完整正文', () => {
  const long = '她'.repeat(400);
  const list = [msg(1, 'user', long, 13, 9, 0)];
  const p = R.planBatches(list, { tzOffsetMin: TZ });
  const out = R.buildPrompt(p.batches[0], { contentMax: 50 });
  assert.match(out.user, /…/);
  assert.equal(p.batches[0].messages[0].content.length, 400, '批数据不截断，核验用完整正文');
});

function promptOf(list) {
  return R.buildPrompt(R.planBatches(list, { tzOffsetMin: TZ }).batches[0]).system;
}

const smallTalk = [
  msg(1, 'user', '早饭吃什么', 13, 9, 0),
  msg(2, 'assistant', '好', 13, 9, 1),
  msg(3, 'user', '好', 13, 9, 2),
];

test('R09c 提示词允许零条或少量高价值候选，不设配额', () => {
  const s = promptOf(smallTalk);
  assert.ok(s.includes('可以一条都不写'), '允许零条');
  assert.ok(s.includes('没有配额'), '不设固定数量');
  assert.ok(s.includes('不要为了凑数生成候选'), '不强制凑数');
  assert.ok(s.includes('{"records":[]}'), '空结果仍写明 JSON 形态');
});

test('R09d 提示词不把孤立琐碎互动机械地变成长期认识', () => {
  const s = promptOf(smallTalk);
  assert.ok(s.includes('孤立的小动作通常不值得单独成条'));
  assert.ok(s.includes('一次问早饭'), '琐碎例子保留在原提示词里');
  assert.ok(s.includes('连着几个「好」'));
  assert.ok(s.includes('流水账'));
  assert.ok(s.includes('不必硬存进长期认识'));
});

test('R09e 提示词要求结合上下文形成个人理解，不上升为长期性格', () => {
  const s = promptOf(smallTalk);
  assert.ok(s.includes('结合前后回应和实际情境'));
  assert.ok(s.includes('你如何理解她主动解释的原因'), '关注理解而非复述解释了哪句话');
  assert.ok(s.includes('整合成一条完整认识'));
  assert.ok(s.includes('别把一次行为写成稳定性格或长期习惯'));
});

test('R09f 提示词区分实际观察与主观推测，保留第一人称口吻', () => {
  const s = promptOf(smallTalk);
  assert.ok(s.includes('原话明确说到、能直接从聊天确认'));
  assert.ok(s.includes('你据此形成的认识或猜测'));
  assert.ok(s.includes('要保留为猜测'), '猜测不能写成事实');
  assert.ok(s.includes('别塞进 observed'));
  assert.ok(s.includes('像在回想两个人之间的事'), '不变成第三方分析报告');
});

test('R09g 数量、频率与前后互动的证据覆盖写进提示词', () => {
  const s = promptOf(smallTalk);
  assert.ok(s.includes('数量或频率'));
  assert.ok(s.includes('evidence 就要覆盖实际支撑这些描述的消息'));
  assert.ok(s.includes('把支撑这种理解的相关消息都列进 evidence'));
  assert.ok(s.includes('quote 必须是该条消息正文里的原话片段'));
  assert.ok(s.includes('不得编造 id'));
  assert.ok(s.includes('不能替你证明她的心理动机'));
});

test('R09h 输出结构字段未变，校验器仍接受完整字段', () => {
  for (const f of ['kind', 'text', 'observed', 'inferred', 'confirmed', 'question',
    'confidence', 'basis', 'topic', 'evidence', 'messageId', 'quote']) {
    assert.ok(R.SCHEMA_TEXT.includes('"' + f + '"'), 'SCHEMA_TEXT 仍含 ' + f);
  }
  const b = R.planBatches([msg(1, 'user', '她说她不喜欢被安排', 13, 9, 0)], { tzOffsetMin: TZ }).batches[0];
  const out = R.validateOutput({ records: [{
    kind: 'inference', text: '她好像不喜欢被安排', observed: '她说了那句话',
    inferred: '被安排会让她不自在', question: '', confirmed: '', confidence: 'medium',
    basis: 'inferred', topic: '边界',
    evidence: [{ messageId: 1, quote: '她不喜欢被安排' }],
  }] }, b);
  assert.equal(out.records.length, 1);
  assert.equal(out.records[0].basis, 'inferred');
});

/* ---------------- R09i-k priorNotes：独立参考通道 ---------------- */
const noteBatch = () => R.planBatches([msg(21, 'user', '这次她自己选了', 13, 9, 0)], { tzOffsetMin: TZ }).batches[0];
const priorNote = () => [{
  id: 'sn-old', primaryMessageId: 11,
  kind: 'inference', basis: 'inferred', confidence: 'low',
  text: '她好像不喜欢被安排（证据 [msg 11]）',
  observed: '她说过那句话', inferred: '被安排会不自在', question: '',
  evidence: [{ messageId: 11, quote: '旧原文' }],
}];

test('R09i priorNotes 单独渲染为参考认识，标注未入库且不可作为证据', () => {
  const base = R.buildPrompt(noteBatch());
  const out = R.buildPrompt(noteBatch(), { priorNotes: priorNote() });
  const u = out.user;

  assert.match(u, /【上一批的初步认识 · 仅供参考】/);
  assert.match(u, /尚未入库、未确认，不代表事实/);
  assert.match(u, /可以沿用、补充、修正、推翻，或暂时搁置/);
  assert.match(u, /不要把其中的推测转写成已经确认的事实/);
  assert.match(u, /不得引用这些候选的 ID 或内容作为 evidence/);
  assert.match(u, /新候选的 evidence 必须来自下面【本批消息】中的真实消息/);
  assert.match(u, /inference \/ inferred \/ low：她好像不喜欢被安排（证据 \[msg 11\]）/);
  assert.match(u, /inferred：被安排会不自在/);

  assert.equal(u.includes('【上下文，仅供理解】'), false, '不混入 ctx 区块');
  assert.equal(u.includes('[11*]'), false, '不生成上下文消息行');
  assert.equal(u.includes('sn-old'), false, '不渲染候选自身 ID');
  assert.equal(out.system, base.system, 'system 输出结构不随 priorNotes 改变');
});

test('R09j 不传 priorNotes 时行为完全不变', () => {
  const base = R.buildPrompt(noteBatch());
  const empty = R.buildPrompt(noteBatch(), { priorNotes: [] });
  assert.equal(base.system, empty.system);
  assert.equal(base.user, empty.user);
  assert.equal(base.user.includes('【上一批的初步认识'), false);
  assert.match(base.user, /【本批消息】/);
  assert.match(base.user, /\[21\] user：这次她自己选了/);
});

test('R09k priorNotes 不进入证据白名单与正文映射，旧消息 ID 仍被拒绝', () => {
  const b = noteBatch();
  const before = R.allowedIdsOf(b);
  R.buildPrompt(b, { priorNotes: priorNote() });
  const after = R.allowedIdsOf(b);

  assert.deepEqual(after, before, 'allowedIdsOf 不受参考认识影响');
  assert.deepEqual(Object.keys(after.fresh), ['21']);
  assert.deepEqual(Object.keys(after.ctx), []);
  assert.deepEqual(R.contentMapOf(b), { 21: '这次她自己选了' });

  const rejected = R.validateOutput({ records: [{
    kind: 'observation', text: '她果然不喜欢被安排', basis: 'observed', confidence: 'medium',
    evidence: [{ messageId: 11, quote: '旧原文' }],
  }] }, b);
  assert.equal(rejected.records.length, 0);
  assert.equal(rejected.rejected[0].reason, 'unknown-source');
});

/* ---------------- R09L-Q S2c 事实语义忠实性回归 ----------------
 * 说明：这是纯函数层，不调 AI，所以验证的是「提示词里写进了这些约束」
 *       和「校验层不压制主观感受」，而不是模型实际输出。真实语义要靠 DRY-RUN 观察。
 *       样本取自 msg2607 / msg2618 的真实候选偏差。
 */
const fidelityList = [
  msg(2607, 'user', '嘿嘿之前可能真的有，但都是我自己弄完忘记划掉了，结果你一直惦记，我就偷偷删掉啦。', 23, 21, 28),
];
const fidelityBatch = () => R.planBatches(fidelityList, { tzOffsetMin: TZ }).batches[0];
const fidelitySystem = () => R.buildPrompt(fidelityBatch()).system;

test('R09L 提示词要求保留原话的不确定性，「可能真的有」不得确定化', () => {
  const p = R.planBatches(fidelityList, { tzOffsetMin: TZ });
  assert.match(R.buildPrompt(p.batches[0]).user, /之前可能真的有/, '真实原文进入提示词');
  const s = fidelitySystem();
  assert.ok(s.includes('概括时贴着原话'));
  assert.ok(s.includes('她没说的事件和动作不要替她补'));
  assert.ok(s.includes('说「可能、好像、记不清」时'));
  assert.ok(s.includes('「可能真的有」就别写成「确实有」'));
});

test('R09M 提示词禁止把行为含义改反，「忘记划掉」不得写成「已经划掉」', () => {
  const s = fidelitySystem();
  assert.ok(s.includes('observed 和 text 是对证据的概括'));
  assert.ok(s.includes('同样不能改掉原话的意思'));
  assert.ok(s.includes('原话「忘记划掉」就不能概括成「已经划掉」'));
});

test('R09N observed 不得把推测性动机写成已观察事实', () => {
  const s = fidelitySystem();
  assert.ok(s.includes('observed 只写她原话表达的内容'));
  assert.ok(s.includes('动机、性格、心理解释属于 inferred，别塞进 observed'));
  assert.ok(s.includes('不能替你证明她的心理动机'));
  assert.ok(s.includes('不要伪装成 observed'));
});

test('R09O 单次行为不得升级为稳定性格', () => {
  const s = fidelitySystem();
  assert.ok(s.includes('一段对话只能支撑当下的印象或初步猜测'));
  assert.ok(s.includes('别把一次行为写成稳定性格或长期习惯'));
});

test('R09P 提示词保留小星的主观感受，不把他改成客观旁白', () => {
  const s = fidelitySystem();
  assert.ok(s.includes('这些忠实约束只管对用户经历和行为的描述，不管你的感受'));
  assert.ok(s.includes('心疼、在意、好奇、吃味'));
  assert.ok(s.includes('「听着有点不是滋味」都照常写'));
  assert.ok(s.includes('别把自己也改成客观旁白'));
});

test('R09Q 校验层不拒绝主观感受型候选（msg2618「不是滋味」）', () => {
  const b = fidelityBatch();
  const out = R.validateOutput({ records: [{
    kind: 'impression', text: '我当时听着有点不是滋味。',
    observed: '她说之前可能真的有，但弄完忘记划掉，后来偷偷删掉了',
    inferred: '她大概怕我一直惦记', question: '', confirmed: '',
    confidence: 'low', basis: 'inferred', topic: '删掉的清单',
    evidence: [{ messageId: 2607, quote: '我就偷偷删掉啦' }],
  }] }, b);
  assert.equal(out.records.length, 1, '主观感受候选不被校验层拒绝');
  assert.equal(out.records[0].text, '我当时听着有点不是滋味。');
  assert.equal(out.records[0].basis, 'inferred');
});

/* ---------------- R10 正常输出 ---------------- */
function batchForValidation() {
  const list = [
    msg(1, 'user', '她说她不喜欢别人替她做决定', 13, 9, 0),
    msg(2, 'assistant', '那我下次先问你', 13, 9, 1),
    msg(3, 'user', '嗯，谢谢', 14, 9, 0),
  ];
  return R.planBatches(list, { tzOffsetMin: TZ }).batches;
}

test('R10 合法输出通过校验，messageId 归一成原始数字类型', () => {
  const b = batchForValidation()[0];
  const raw = JSON.stringify({
    records: [{
      kind: 'inference',
      text: '她好像不太喜欢被人替她做决定',
      inferred: '被安排会让她不自在',
      confidence: 'medium',
      basis: 'stated',
      evidence: [{ messageId: '1', quote: '她不喜欢别人替她做决定' }],
    }],
  });

  const out = R.validateOutput(raw, b);
  assert.equal(out.ok, true);
  assert.equal(out.records.length, 1);
  assert.equal(out.records[0].primaryMessageId, 1);
  assert.equal(typeof out.records[0].evidence[0].messageId, 'number');
  assert.equal(out.records[0].allCtx, false);
  assert.equal(out.records[0].confirmed, '', 'stated 不会自动填 confirmed');
});

/* ---------------- R11 编造来源 ---------------- */
test('R11 编造不存在的来源 ID 一律丢弃', () => {
  const b = batchForValidation()[0];
  const raw = { records: [{ kind: 'observation', text: '她笑了', basis: 'observed', confidence: 'medium', evidence: [{ messageId: 999, quote: '她笑了' }] }] };
  const out = R.validateOutput(raw, b);
  assert.equal(out.ok, true);
  assert.equal(out.records.length, 0);
  assert.equal(out.rejected[0].reason, 'unknown-source');
  assert.equal(out.rejected[0].detail, '999');
});

/* ---------------- R12 quote 核对 ---------------- */
test('R12 quote 在原文里找不到就丢弃，不允许「差不多」', () => {
  const b = batchForValidation()[0];
  const raw = { records: [{
    kind: 'observation', text: '她很客气', basis: 'stated', confidence: 'medium',
    evidence: [{ messageId: 1, quote: '她说她最喜欢别人替她做决定' }],
  }] };
  const out = R.validateOutput(raw, b);
  assert.equal(out.records.length, 0);
  assert.equal(out.rejected[0].reason, 'quote-mismatch');
});

test('R12b 空白差异不影响命中，但错字会', () => {
  const b = batchForValidation()[0];
  const spaced = { records: [{
    kind: 'observation', text: 'x', basis: 'stated', confidence: 'medium',
    evidence: [{ messageId: 1, quote: '她 说 她 不 喜欢 别人' }],
  }] };
  assert.equal(R.validateOutput(spaced, b).records.length, 1, '只去空白后仍能命中');

  const typo = { records: [{
    kind: 'observation', text: 'x', basis: 'stated', confidence: 'medium',
    evidence: [{ messageId: 1, quote: '她说她不洗欢别人' }],
  }] };
  assert.equal(R.validateOutput(typo, b).records.length, 0);
});

test('R12c quote 太短不给过', () => {
  const b = batchForValidation()[0];
  const raw = { records: [{
    kind: 'observation', text: 'x', basis: 'stated', confidence: 'medium',
    evidence: [{ messageId: 1, quote: '她' }],
  }] };
  assert.equal(R.validateOutput(raw, b).rejected[0].reason, 'quote-too-short');
});

/* ---------------- R13 confirmed 与 basis ---------------- */
test('R13 confirmed 只能由 stated 支撑，inferred 不许 confirmed、不许 high', () => {
  const b = batchForValidation()[0];

  const wrongBasis = R.validateOutput({ records: [{
    kind: 'observation', text: 'x', basis: 'observed', confidence: 'medium',
    confirmed: '她确认过', evidence: [{ messageId: 1, quote: '她不喜欢别人替她做决定' }],
  }] }, b);
  assert.equal(wrongBasis.rejected[0].reason, 'confirmed-requires-stated');

  const inferredConfirmed = R.validateOutput({ records: [{
    kind: 'inference', text: 'x', basis: 'inferred', confidence: 'low',
    confirmed: '她确认过', evidence: [{ messageId: 1, quote: '她不喜欢别人替她做决定' }],
  }] }, b);
  assert.equal(inferredConfirmed.rejected[0].reason, 'confirmed-requires-stated');

  const inferredHigh = R.validateOutput({ records: [{
    kind: 'inference', text: 'x', basis: 'inferred', confidence: 'high',
    evidence: [{ messageId: 1, quote: '她不喜欢别人替她做决定' }],
  }] }, b);
  assert.equal(inferredHigh.rejected[0].reason, 'confidence-too-high');

  const okStated = R.validateOutput({ records: [{
    kind: 'observation', text: 'x', basis: 'stated', confidence: 'high',
    confirmed: '她说过不喜欢被安排', evidence: [{ messageId: 1, quote: '她不喜欢别人替她做决定' }],
  }] }, b);
  assert.equal(okStated.records.length, 1, 'stated + confirmed 允许');
});

/* ---------------- R14 上下文证据 ---------------- */
test('R14 引用上下文消息可以，但只靠上下文的记录标为 allCtx 并被跳过', () => {
  const b = batchForValidation()[1];   // 第二批，ctx 里有 1 和 2
  assert.ok(b.ctx.length > 0);

  const out = R.validateOutput({ records: [{
    kind: 'impression', text: '她很在意有没有被尊重', basis: 'inferred', confidence: 'low',
    evidence: [{ messageId: b.ctx[0].id, quote: b.ctx[0].content }],
  }] }, b);

  assert.equal(out.records.length, 1, '上下文证据可以引用，不因跨批被丢');
  assert.equal(out.records[0].allCtx, true);
  assert.equal(out.stats.ctxOnly, 1);

  const applied = R.applyDedupe(out.records, R.buildDedupeIndex([]));
  assert.equal(applied.accepted.length, 0);
  assert.equal(applied.skipped[0].reason, 'ctx-only');
});

/* ---------------- R15 结构错误 ---------------- */
test('R15 非法 JSON 与缺 records 都明确失败，不当成空结果', () => {
  const b = batchForValidation()[0];
  const bad = R.validateOutput('这不是 JSON', b);
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'bad-json');
  assert.deepEqual(bad.records, []);

  const shape = R.validateOutput({ items: [] }, b);
  assert.equal(shape.ok, false);
  assert.equal(shape.reason, 'bad-shape');

  const wrapped = R.validateOutput('```json\n{"records":[]}\n```', b);
  assert.equal(wrapped.ok, true, '剥掉代码块包装后应能解析');
  assert.equal(wrapped.records.length, 0);
});

/* ---------------- R16 去重判定 ---------------- */
const recOf = (over) => Object.assign({
  kind: 'observation',
  text: '她笑起来会先低头',
  evidence: [{ messageId: 1, quote: '她笑了' }],
  status: 'active',
  id: 'sn-1',
}, over || {});

test('R16 只有证据集合、kind、认识内容三者都相同才算重复', () => {
  const index = R.buildDedupeIndex([recOf()]);

  assert.equal(R.isDuplicate(recOf({ id: 'new' }), index).duplicate, true, '三者相同 → 重复');

  const diffText = R.isDuplicate(recOf({ text: '她笑的时候其实有点紧张', id: 'new' }), index);
  assert.equal(diffText.duplicate, false, '同证据不同认识 → 允许并存');

  const diffKind = R.isDuplicate(recOf({ kind: 'impression', id: 'new' }), index);
  assert.equal(diffKind.duplicate, false, '同证据不同 kind → 允许并存');

  const superset = R.isDuplicate(recOf({ evidence: [{ messageId: 1, quote: 'a' }, { messageId: 2, quote: 'b' }], id: 'new' }), index);
  assert.equal(superset.duplicate, false, '证据集合不同 → 不算重复');

  const normalized = R.isDuplicate(recOf({ text: '她笑起来，会先低头。', id: 'new' }), index);
  assert.equal(normalized.duplicate, true, '标点差异经规范化后视为同一句');
});

/* ---------------- R17 撤回与修订也在索引里 ---------------- */
test('R17 retracted / superseded 记录同样进索引，重跑不会重新生成', () => {
  const index = R.buildDedupeIndex([
    recOf({ id: 'sn-r', status: 'retracted' }),
    recOf({ id: 'sn-s', status: 'superseded', text: '她笑起来会先低头，像是有点不好意思' }),
  ]);

  assert.equal(R.isDuplicate(recOf({ id: 'new' }), index).of[0], 'sn-r', '撤回过的内容不许复活');

  const edited = R.isDuplicate({ kind: 'observation', text: '她笑起来会先低头，像是有点不好意思', evidence: [{ messageId: 1, quote: '她笑了' }] }, index);
  assert.equal(edited.duplicate, true);
  assert.equal(edited.of[0], 'sn-s', '修订过的旧版也拦住');
});

/* ---------------- R18 用户改过的内容不被覆盖 ---------------- */
test('R18 去重只判断、不改动既有记录，返回的是待新增对象', () => {
  const existing = recOf({ id: 'sn-user', text: '用户手改过的措辞' });
  const index = R.buildDedupeIndex([existing]);

  const cand = recOf({ id: undefined, text: '她笑起来会先低头' });
  const d = R.isDuplicate(cand, index);
  assert.equal(d.duplicate, false, '用户改过正文后按三条件已不构成重复');

  const applied = R.applyDedupe([cand], index);
  assert.equal(applied.accepted.length, 1);
  assert.equal(applied.accepted[0].id, undefined, '新记录不带既有 id，不存在覆盖路径');
  assert.equal(existing.text, '用户手改过的措辞', '既有记录一个字都没变');
});

/* ---------------- R19 批量过滤 ---------------- */
test('R19 applyDedupe 分别统计 ctx-only 与 duplicate', () => {
  const index = R.buildDedupeIndex([recOf({ id: 'sn-1' })]);
  const out = R.applyDedupe([
    recOf({ id: undefined }),
    recOf({ id: undefined, allCtx: true }),
    recOf({ id: undefined, text: '另一种认识' }),
  ], index);

  assert.equal(out.skipped.length, 2);
  assert.deepEqual(out.skipped.map((s) => s.reason), ['duplicate', 'ctx-only']);
  assert.equal(out.accepted.length, 1);
  assert.equal(out.accepted[0].text, '另一种认识');
});

/* ---------------- R20 允许多条 evidence ---------------- */
test('R20 一条记录可以引用多条消息，只要每条都能核验', () => {
  const b = batchForValidation()[0];
  const out = R.validateOutput({ records: [{
    kind: 'inference', text: '她更在意被问过再做决定', basis: 'inferred', confidence: 'medium',
    evidence: [
      { messageId: 1, quote: '她不喜欢别人替她做决定' },
      { messageId: 2, quote: '那我下次先问你' },
    ],
  }] }, b);

  assert.equal(out.records.length, 1);
  assert.equal(out.records[0].evidence.length, 2);
  assert.equal(out.records[0].freshCount, 2);
});
