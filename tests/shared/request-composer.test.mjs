/* tests/shared/request-composer.test.mjs — 七条生产请求路径的真实组装适配器测试 */
import test from 'node:test';
import assert from 'node:assert/strict';

import '../../public/shared/prompt-layout.js';
import '../../public/shared/history-window.js';
import '../../public/shared/request-composer.js';

const PL = globalThis.PromptLayout;
const HW = globalThis.HistoryWindow;
const RC = globalThis.RequestComposer;

const CORE = '【核心人设】你是小星。\n【表情标签】保留格式。\n【珍藏提议】保留格式。';
const ENV = '\n\n【当前现实环境】\n时间提示：晚上';
const NOW = '【当前时间】2026-11-26 14:30 周四（本地时间）。只按这一行说。';
const CHAT_TASK = '\n\n【表达方式】自然对白。\n请结合上下文自然回应。不要重复用户的话。';

function blocksFor(name, extra) {
  const ids = RC.blockIdsFor(name);
  const out = ids.map(id => ({ id, text: `\n【${id}】${id}内容` }));
  if (extra) out.push(...extra);
  return out;
}

function assemble(name, opts = {}) {
  const current = opts.current || { role: 'user', content: opts.currentText || '当前问题' };
  const history = opts.history || [];
  const before = JSON.stringify(history);
  const messages = RC.assemblePathMessages({
    core: CORE,
    envBlock: ENV,
    nowBlock: NOW,
    taskInstruction: RC.taskFor(name, opts.chatTask || CHAT_TASK),
    blocks: opts.blocks || blocksFor(name),
    history,
    currentTurn: current,
    currentMessageId: opts.currentMessageId,
    PL,
    mapHistory: m => ({ role: m.role, content: m.content })
  });
  assert.equal(JSON.stringify(history), before, '组装不得改写 history');
  return { messages, current, history };
}

function roleSeq(messages) {
  return messages.map(m => m.role);
}

function textOf(message) {
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
}

test('RC1 七条路径元数据：task、requestType、options、动态块顺序', () => {
  assert.deepEqual(RC.pathNames(), ['star', 'chat', 'todayLetter', 'futureLetter', 'diary', 'keep', 'touch']);
  assert.equal(RC.taskFor('star'), '');
  assert.equal(RC.taskFor('chat', CHAT_TASK), CHAT_TASK);
  assert.ok(RC.taskFor('todayLetter').includes('今日来信'));
  assert.ok(RC.taskFor('futureLetter').includes('未来信'));
  assert.ok(RC.taskFor('diary').includes('第一人称'));
  assert.ok(RC.taskFor('keep').includes('KEEP_PROPOSAL'));
  assert.equal(RC.taskFor('touch'), '');

  const expectedTypes = {
    star: 'star', chat: 'chat', todayLetter: 'letter', futureLetter: 'letter',
    diary: 'diary', keep: 'keep', touch: 'touch'
  };
  for (const name of RC.pathNames()) assert.equal(RC.requestTypeFor(name), expectedTypes[name]);
  assert.deepEqual(RC.optionsFor('touch'), { allowEmpty: true });
  for (const name of RC.pathNames().filter(n => n !== 'touch')) assert.deepEqual(RC.optionsFor(name), {});
  assert.deepEqual(RC.blockIdsFor('chat').slice(0, 2), ['schedule', 'closeTalk']);
  assert.deepEqual(RC.blockIdsFor('chat').slice(-2), ['butler', 'history']);
});

const PATH_CASES = [
  ['star', '主动关心 / callStar'],
  ['chat', '主聊天'],
  ['todayLetter', '今日来信'],
  ['futureLetter', '未来信'],
  ['diary', '日记'],
  ['keep', '珍藏'],
  ['touch', '触摸']
];

for (const [name, label] of PATH_CASES) {
  test(`RC2-${name} ${label}：稳定 system → 历史 → 动态 system → 当前 user`, () => {
    const history = [
      { role: 'user', content: '历史用户' },
      { role: 'assistant', content: '历史回复' }
    ];
    const currentText = `当前-${name}`;
    const { messages, current } = assemble(name, { history, currentText });
    const roles = roleSeq(messages);

    assert.equal(roles[0], 'system');
    assert.deepEqual(roles.slice(1, 3), ['user', 'assistant']);
    assert.equal(roles[roles.length - 2], 'system');
    assert.equal(roles[roles.length - 1], 'user');
    assert.ok(textOf(messages[0]).includes(RC.taskFor(name, CHAT_TASK)) || RC.taskFor(name, CHAT_TASK) === '');
    assert.strictEqual(messages[messages.length - 1].content, current.content);
    assert.equal(messages.filter(m => textOf(m).includes(currentText)).length, 1, '当前 user 只出现一次');
    assert.ok(textOf(messages[roles.length - 2]).includes(PL.DYNAMIC_HEADER));
    assert.ok(!messages.slice(1, 3).some(m => textOf(m).includes(PL.DYNAMIC_HEADER)), '动态上下文不进入历史');
  });
}

test('RC3 今日来信 / 未来信：多模态数组按引用完整保留', () => {
  for (const name of ['todayLetter', 'futureLetter']) {
    const parts = [
      { type: 'text', text: '请读这封信' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,LETTER' } }
    ];
    const { messages, current } = assemble(name, { current: { role: 'user', content: parts } });
    const last = messages[messages.length - 1];
    assert.strictEqual(last.content, parts);
    assert.strictEqual(current.content[1].image_url.url, 'data:image/jpeg;base64,LETTER');
  }
});

test('RC4 主聊天：当前消息 id 仍在历史时由生产组装守卫拒绝', () => {
  const history = [{ id: 9, role: 'user', content: '历史' }, { id: 10, role: 'user', content: '当前' }];
  assert.throws(
    () => assemble('chat', {
      history,
      current: { role: 'user', content: '当前' },
      currentMessageId: 10
    }),
    /CURRENT_MESSAGE_DUPLICATE/
  );
});

test('RC5 不同路径的滞回状态互不污染；非主聊天不使用 state', () => {
  const list = [];
  for (let i = 1; i <= 250; i++) list.push({ id: i, role: i % 2 ? 'user' : 'assistant', content: '字'.repeat(100) });
  const stateA = { leftKey: 1 };
  const stateB = { leftKey: 99 };
  const a = HW.trimWithHysteresis(list, { state: stateA });
  const b = HW.trimWithHysteresis(list, { state: stateB });
  assert.notEqual(a.stats.leftSourceId, b.stats.leftSourceId);
  assert.deepEqual(stateA, { leftKey: 1 }, '传入的 state 不应被就地改写');
  assert.deepEqual(stateB, { leftKey: 99 }, '不同路径状态互不影响');

  for (const name of RC.pathNames().filter(n => n !== 'chat')) {
    assert.deepEqual(RC.blockIdsFor(name).includes('history'), name === 'chat');
  }
});
