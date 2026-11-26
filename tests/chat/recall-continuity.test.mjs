/* tests/chat/recall-continuity.test.mjs — 历史检索的跨轮连续性（第一批修复）
 *
 * 覆盖：省略式追问继承 / 连续第三轮继承 / 换话题失效 / 超时失效 / 用户纠正失效 /
 *       空结果不可继承 / partial 不被伪装成完整 / 普通闲聊不误触发 / 不同事件不混淆 /
 *       证据只按 id 重新取原文 / 不把助手回复当成用户事实。
 *
 * 纯 Node：从 public/app.js 里抽出「跨轮检索会话」那一段真实源码执行，
 * 不打开 IndexedDB、不发请求、不调 AI。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import '../../public/shared/history-retriever.js';

const HR = globalThis.HistoryRetriever;
const SRC = fs.readFileSync(path.join(process.cwd(), 'public/app.js'), 'utf8');

/** 从 app.js 抽出跨轮会话整段（常量 + 状态 + 5 个函数），保持与生产代码同源 */
function extractRecallBlock(src) {
  const start = src.indexOf('const RECALL_SESSION_TTL_MS');
  assert.ok(start > 0, '没找到 RECALL_SESSION_TTL_MS，抽取锚点失效');
  const fnAt = src.indexOf('function recallCarryBlock()', start);
  assert.ok(fnAt > start, '没找到 recallCarryBlock，抽取锚点失效');
  // 从函数名后第一个 { 开始做括号配对，找到函数真正结束的位置
  let i = src.indexOf('{', fnAt);
  let depth = 0;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) { i += 1; break; }
    }
  }
  return src.slice(start, i);
}

const BODY = extractRecallBlock(SRC);

/** 用真实源码建一个运行时：window/chatHistory 由测试注入 */
function makeRuntime(history) {
  const factory = new Function('window', 'chatHistory', BODY + `
    return {
      getSession: function () { return recallSession; },
      setSession: function (v) { recallSession = v; },
      reset: recallSessionReset,
      anchors: recallAnchors,
      overlaps: recallOverlaps,
      shouldCarry: recallShouldCarry,
      save: recallSaveSession,
      carryBlock: recallCarryBlock
    };
  `);
  return factory({ HistoryRetriever: HR }, history || []);
}

const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);

function msg(id, time, role, content) {
  return { id, time, role, content };
}

// 一件真实可检索的旧事：扁粉菜 vs 另一个选项
const HISTORY = [
  msg(1, NOW - 20 * DAY, 'user', '今天去吃了扁粉菜，就是你说的那个早餐'),
  msg(2, NOW - 20 * DAY + 60000, 'assistant', '我记得，你说汤底是酸辣的'),
  msg(3, NOW - 19 * DAY, 'user', '那家店还有另一个选项是胡辣汤'),
  msg(4, NOW - 19 * DAY + 60000, 'assistant', '嗯，胡辣汤也不错，就是有点冲'),
  msg(5, NOW - 2 * DAY, 'user', '今天下雨了，不想出门'),
  msg(6, NOW - 2 * DAY + 60000, 'assistant', '那就别出门，我在家陪你')
];

/** 用真实检索器跑一轮，逐行对齐 app.js 里 collectChatHistoryEvidence 的分支顺序 */
async function runTurn(rt, text, opts) {
  const o = opts || {};
  const now = typeof o.now === 'number' ? o.now : NOW;
  const carry = rt.shouldCarry(text, now);
  const current = { id: o.currentId != null ? o.currentId : 900, time: now, role: 'user', content: text };
  const ev = await HR.collect({
    text: text,
    current: current,
    history: o.history || HISTORY,
    window: [],
    state: { dbReady: true, loaded: true, loadFailed: false },
    reader: null,
    windowHasPastTopic: carry,
    now: now
  });
  const block = (ev && ev.block) ? ev.block : '';
  const hasEvidence = !!(ev && ev.result && Array.isArray(ev.result.evidence) && ev.result.evidence.length);
  if (hasEvidence && block) {
    rt.save(text, ev, now);
    return { carry, ev, block, carried: false, saved: true };
  }
  if (carry) {
    // 续问：不采用「没翻到」的提示，回退到上一轮证据；话题继续就续期
    const carried = rt.carryBlock();
    if (carried) {
      const s = rt.getSession();
      if (s) s.at = now;
    }
    return { carry, ev, block: carried, carried: true, saved: false };
  }
  if (block) return { carry, ev, block, carried: false, saved: false };
  return { carry, ev, block: '', carried: false, saved: false };
}

/** 取一段「只是没翻到，不是找到了证据」的文本判定 */
function hasQuotedEvidence(block) {
  return String(block || '').includes('【引用资料：更早的聊天原文');
}

test('T01 第一轮明确回忆：检索命中，会话落地', async () => {
  const rt = makeRuntime(HISTORY.slice());
  const r = await runTurn(rt, '你还记得我们之前讨论扁粉菜吗？');
  assert.equal(r.carry, false, '还没有会话时不应判定为延续');
  assert.ok(r.block.includes('扁粉菜') || r.block.includes('胡辣汤'), '第一轮应翻到原文');
  const s = rt.getSession();
  assert.ok(s && s.hit === true, '命中后应写入会话');
  assert.ok(Array.isArray(s.ids) && s.ids.length >= 1, '会话只存证据 id');
  assert.ok(!('text' in s) && !('evidence' in s), '会话里不得保存证据正文');
});

test('T02 第二轮省略式追问「另一个」：继承上一轮同一事件的证据', async () => {
  const rt = makeRuntime(HISTORY.slice());
  await runTurn(rt, '你还记得我们之前讨论扁粉菜吗？');
  const r = await runTurn(rt, '那另一个选项是什么？', { now: NOW + 60 * 1000 });
  assert.equal(r.carry, true, '省略式追问应判定为同一件事');
  assert.ok(r.block, '应继续给出证据，而不是让模型凭印象答');
  assert.ok(r.block.includes('胡辣汤') || r.block.includes('扁粉菜'), '继承的必须是同一件事的原文');
  assert.ok(r.block.includes('只读引用'), '格式化口径沿用检索器那一份');
});

test('T03 第三轮继续追问：仍能接上同一主题', async () => {
  const rt = makeRuntime(HISTORY.slice());
  await runTurn(rt, '你还记得我们之前讨论扁粉菜吗？');
  await runTurn(rt, '那另一个选项是什么？', { now: NOW + 60 * 1000 });
  const r = await runTurn(rt, '后来呢？', { now: NOW + 2 * 60 * 1000 });
  assert.equal(r.carry, true);
  assert.ok(r.block, '第三轮仍应继承');
  const s = rt.getSession();
  assert.ok(s.anchors.some((a) => a === '扁粉' || a === '扁粉菜'), '锚点应跨轮累积，不因省略式追问而丢失主题');
});

test('T04 换话题：旧证据立即失效，不再注入', async () => {
  const rt = makeRuntime(HISTORY.slice());
  await runTurn(rt, '你还记得我们之前讨论扁粉菜吗？');
  const r = await runTurn(rt, '换个话题，今天下雨了你那边呢', { now: NOW + 60 * 1000 });
  assert.equal(r.carry, false);
  assert.equal(r.block, '');
  assert.equal(rt.getSession(), null, '换话题必须清空会话');
});

test('T05 无关新话题（非省略式、无重叠）：不继承', async () => {
  const rt = makeRuntime(HISTORY.slice());
  await runTurn(rt, '你还记得我们之前讨论扁粉菜吗？');
  const r = await runTurn(rt, '帮我看看明天的待办', { now: NOW + 60 * 1000 });
  assert.equal(r.carry, false, '不同话题不能被当成延续');
  assert.equal(r.block, '');
  assert.equal(rt.getSession(), null);
});

test('T06 超时：不再继承旧证据', async () => {
  const rt = makeRuntime(HISTORY.slice());
  await runTurn(rt, '你还记得我们之前讨论扁粉菜吗？');
  const r = await runTurn(rt, '那另一个选项是什么？', { now: NOW + 9 * 60 * 1000 });
  assert.equal(r.carry, false, '超过 8 分钟应失效');
  assert.equal(rt.getSession(), null);
});

test('T07 用户纠正：以纠正为准，旧证据作废并重新检索', async () => {
  const rt = makeRuntime(HISTORY.slice());
  await runTurn(rt, '你还记得我们之前讨论扁粉菜吗？');
  const r = await runTurn(rt, '你记错了，我说的是胡辣汤那家', { now: NOW + 60 * 1000 });
  assert.equal(r.carry, false, '纠正语境绝不能沿用旧证据');
  assert.ok(!r.carried, '不得走继承分支');
  // 纠正句本身带主题词，检索器应当重新翻到；新会话必须属于纠正后的主题
  const s = rt.getSession();
  if (s) {
    assert.ok(!s.anchors.includes('扁粉'), '纠正后不得再带着旧主题的锚点');
  }
  if (r.block) assert.ok(hasQuotedEvidence(r.block), '要么给出重新检索的证据，要么什么都不给');
});

test('T08 上一轮没有有效证据：不留可继承状态，也不声称查过', async () => {
  const rt = makeRuntime(HISTORY.slice());
  const r1 = await runTurn(rt, '你还记得我们之前说过的南极旅行吗？');
  assert.equal(r1.block.includes('引用资料'), false, '没有相关原文时不得伪造证据');
  assert.equal(rt.getSession(), null, '空结果不得写成可继承的会话');
  const r2 = await runTurn(rt, '那另一个呢？', { now: NOW + 60 * 1000 });
  assert.equal(r2.carry, false, '上一轮没找到，这轮不能继承空结果');
  assert.equal(r2.block, '', '不能凭空给出一段证据');
  assert.ok(!r2.ev || !(r2.ev.result && r2.ev.result.evidence && r2.ev.result.evidence.length),
    '本轮也不应翻到任何证据');
});

test('T09 部分扫描：继承时如实保留 partial，不伪装成完整检索', async () => {
  const rt = makeRuntime(HISTORY.slice());
  const now = NOW;
  const carry = false;
  // 直接注入一个「找到过证据但没扫完」的会话
  rt.setSession({
    at: now, hit: true, level: 'L2', exhausted: false, partial: true,
    anchors: rt.anchors('扁粉菜'), ids: [1, 3]
  });
  assert.equal(rt.shouldCarry('那另一个呢', now + 1000), true);
  const block = rt.carryBlock();
  assert.ok(block.includes('还没翻完'), 'partial 必须写进覆盖范围');
  assert.ok(!block.includes('已经全部翻完'), '不得把部分扫描说成翻完了');
});

test('T10 普通闲聊：没有会话时不会触发检索', async () => {
  const rt = makeRuntime(HISTORY.slice());
  assert.equal(rt.shouldCarry('今天中午吃什么好呢', NOW), false);
  const d = HR.detect('今天中午吃什么好呢', { windowHasPastTopic: false });
  assert.equal(d.level, 'L3', '普通闲聊应保持 L3，零检索开销');
});

test('T11 不同事件不混淆：旧会话不会粘到新事件上', async () => {
  const rt = makeRuntime(HISTORY.slice());
  await runTurn(rt, '你还记得我们之前讨论扁粉菜吗？');
  // 新事件：另一件事，不含旧主题锚点、也不是省略式追问
  const r = await runTurn(rt, '你还记得我说过想去看的那部电影吗', { now: NOW + 60 * 1000 });
  assert.equal(r.carry, false, '「你还记得…」这种句式不能被当成同一件事');
  assert.ok(!r.carried, '不得继承扁粉菜的会话');
  const s = rt.getSession();
  if (s) {
    assert.ok(!s.anchors.includes('扁粉'), '新主题不应带着旧主题的锚点');
  }
});

test('T12 证据只按 id 重新取原文：消息被删后不返回半截结论', async () => {
  const rt = makeRuntime(HISTORY.slice());
  await runTurn(rt, '你还记得我们之前讨论扁粉菜吗？');
  // 模拟历史被清空：会话指向的 id 已经取不到原文
  rt.setSession(Object.assign({}, rt.getSession(), { ids: [7777] }));
  assert.equal(rt.shouldCarry('那另一个呢', NOW + 1000), true);
  assert.equal(rt.carryBlock(), '', '取不到原文就不能硬凑一段');
  assert.equal(rt.getSession(), null, '取不到原文应作废会话');
});

test('T13 不把助手的回复当成用户事实：角色标注仍来自检索器', async () => {
  const rt = makeRuntime(HISTORY.slice());
  await runTurn(rt, '你还记得我们之前讨论扁粉菜吗？');
  const s = rt.getSession();
  s.ids = [1, 2];
  const block = rt.carryBlock();
  assert.ok(block.includes('用户说') || block.includes('你当时回'), '应按角色标注，不混为一谈');
  assert.ok(block.includes('不等于事实'), '助手的话必须标明不等于事实');
});

test('T14 windowHasPastTopic 确实改变了检索器行为（接线有效）', () => {
  // 「那天的事」：有事件指代、没有追问词，正好只由 windowHasPastTopic 决定
  const before = HR.detect('那天的事', { windowHasPastTopic: false });
  const after = HR.detect('那天的事', { windowHasPastTopic: true });
  assert.equal(before.level, 'L3', '没有延续信号时应保持 L3');
  assert.equal(after.level, 'L2', '有延续信号时 window-continuation 应生效');
  assert.equal(after.reason, 'window-continuation');
});

test('T15 会话状态里没有正文类字段（结构约束）', async () => {
  const rt = makeRuntime(HISTORY.slice());
  await runTurn(rt, '你还记得我们之前讨论扁粉菜吗？');
  const s = rt.getSession();
  const keys = Object.keys(s).sort();
  assert.deepEqual(keys, ['anchors', 'at', 'exhausted', 'hit', 'ids', 'level', 'partial']);
  assert.ok(JSON.stringify(s).length < 2000, '会话状态必须是轻量的');
});

test('T16 接线：主聊天确实先判延续，再把它交给检索器', () => {
  assert.ok(/const carryRecall = recallShouldCarry\(text, recallNow\)/.test(SRC),
    'doRequestStarReply 必须先算出 carryRecall');
  assert.ok(/collectChatHistoryEvidence\(text, userMessage, historyWindow, \{ carry: carryRecall, now: recallNow \}\)/.test(SRC),
    '必须把 carry 与同一个 now 传进收集函数');
  assert.ok(/windowHasPastTopic: carry/.test(SRC),
    'windowHasPastTopic 必须来自本轮判定，不能是硬编码 false');
  assert.ok(!/windowHasPastTopic: false/.test(SRC),
    '不允许再过留一个恒 false 的传参');
});

test('T17 接线：清空聊天记录时作废跨轮会话', () => {
  const clearAt = SRC.indexOf('async function clearChat()');
  assert.ok(clearAt > 0, '没找到 clearChat');
  const tail = SRC.slice(clearAt, clearAt + 900);
  assert.ok(/recallSessionReset\(\)/.test(tail), '清空聊天后必须作废会话，否则会继承取不到原文的 id');
});

test('T18 中间插一句「嗯」：不作废会话，但也不继承证据', async () => {
  const rt = makeRuntime(HISTORY.slice());
  await runTurn(rt, '你还记得我们之前讨论扁粉菜吗？');
  const r1 = await runTurn(rt, '嗯', { now: NOW + 20 * 1000 });
  assert.equal(r1.carry, false, '语气词不继承证据');
  assert.ok(rt.getSession(), '但会话不该被这句打断');
  const r2 = await runTurn(rt, '那另一个选项呢', { now: NOW + 40 * 1000 });
  assert.equal(r2.carry, true, '接回同一件事仍应继承');
  assert.ok(r2.block, '证据仍应给出来');
});

test('T19 长时间连续追问同一件事：话题仍在继续就续期，不被固定超时卡断', async () => {
  const rt = makeRuntime(HISTORY.slice());
  await runTurn(rt, '你还记得我们之前讨论扁粉菜吗？');
  // 每轮间隔 3 分钟，累计 9 分钟 > TTL(8 分钟)，但话题从未中断
  let last = null;
  for (let i = 1; i <= 3; i++) {
    last = await runTurn(rt, '那另一个呢', { now: NOW + i * 3 * 60 * 1000 });
    assert.equal(last.carry, true, `第 ${i} 轮续问仍应继承`);
    assert.ok(last.block, `第 ${i} 轮应给出证据`);
  }
  // 但真正走开 9 分钟之后，必须失效
  const away = await runTurn(rt, '那另一个呢', { now: NOW + 3 * 3 * 60 * 1000 + 9 * 60 * 1000 });
  assert.equal(away.carry, false, '走开超过 TTL 之后不再继承');
});
