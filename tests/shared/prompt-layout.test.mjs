/* tests/shared/prompt-layout.test.mjs — 请求组装纯函数测试（无 IO、无 AI） */
import test from 'node:test';
import assert from 'node:assert/strict';

import '../../public/shared/prompt-layout.js';

const PL = globalThis.PromptLayout;

const core = '【核心人设】稳定的小星\n【机制】表情标签与珍藏标记';
const task = '\n用户刚刚给你寄来一封今日来信。请认真阅读，用自然亲密的口吻回应她。';

test('P1 稳定层 = 核心 + 路径任务指令，指令原文逐字保留', () => {
  const s = PL.buildStableSystem(core, task);
  assert.equal(s, core + task);
  assert.ok(s.indexOf(task) >= 0);
});

test('P2 动态上下文有明确头部、按块顺序拼接、空块跳过', () => {
  const block = PL.buildDynamicContext([
    { id: 'env', text: '【当前现实环境】时间提示：晚上' },
    { id: 'empty', text: '   ' },
    { id: 'recall', text: '【历史检索】#2596 扁粉菜' }
  ]);
  assert.ok(block.startsWith(PL.DYNAMIC_HEADER));
  assert.ok(block.indexOf('【当前现实环境】') < block.indexOf('【历史检索】'));
  assert.ok(!block.includes('empty'));
  assert.equal(PL.buildDynamicContext([]), '');
});

test('P3 messages 顺序：稳定 system → 历史 → 动态 system → 当前 user', () => {
  const history = [
    { role: 'user', content: '甲' },
    { role: 'assistant', content: '乙' }
  ];
  const current = { role: 'user', content: '现在这条' };
  const messages = PL.assembleMessages({
    stableSystem: PL.buildStableSystem(core, task),
    historyWindow: history,
    dynamicContext: PL.buildDynamicContext([{ text: '【当前现实环境】晚上' }]),
    currentTurn: current
  });
  assert.deepEqual(messages.map(m => m.role), ['system', 'user', 'assistant', 'system', 'user']);
  assert.equal(messages[0].content, core + task);
  assert.equal(messages[1].content, '甲');
  assert.equal(messages[2].content, '乙');
  assert.ok(messages[3].content.startsWith(PL.DYNAMIC_HEADER));
  assert.strictEqual(messages[4], current);
});

test('P4 当前消息 id 仍留在历史时直接报错，不静默去重', () => {
  const history = [{ role: 'user', content: '旧', sourceIds: [1, 2] }];
  assert.throws(
    () => PL.assembleMessages({
      stableSystem: core,
      historyWindow: history,
      currentTurn: { role: 'user', content: '当前' },
      currentMessageId: 2
    }),
    /CURRENT_MESSAGE_DUPLICATE/
  );
});

test('P5 多模态 content 数组按引用保留，不被 String 化', () => {
  const parts = [
    { type: 'text', text: '看看这张' },
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }
  ];
  const current = { role: 'user', content: parts };
  const messages = PL.assembleMessages({ stableSystem: core, historyWindow: [], currentTurn: current });
  assert.strictEqual(messages[1].content, parts);
  assert.equal(PL.isMultimodal(messages[1].content), true);
  assert.equal(messages[1].content[1].type, 'image_url');
  assert.equal(messages[1].content[1].image_url.url, 'data:image/jpeg;base64,AAAA');
});

test('P6 无动态上下文时不产生空的 system 消息', () => {
  const messages = PL.assembleMessages({
    stableSystem: core,
    historyWindow: [{ role: 'assistant', content: '早' }],
    dynamicContext: '',
    currentTurn: { role: 'user', content: '嗯' }
  });
  assert.deepEqual(messages.map(m => m.role), ['system', 'assistant', 'user']);
});

test('P7 缺失当前消息时报错，避免请求没有用户输入', () => {
  assert.throws(() => PL.assembleMessages({ stableSystem: core, historyWindow: [] }), /currentTurn/);
});

test('P8 mapHistory 回调可注入消息转换且不改变顺序', () => {
  const messages = PL.assembleMessages({
    stableSystem: core,
    historyWindow: [
      { role: 'user', content: '一', sourceIds: [1] },
      { role: 'user', content: '二', sourceIds: [2] }
    ],
    mapHistory: (m) => ({ role: m.role, content: '[' + m.content + ']' }),
    currentTurn: { role: 'user', content: '当前' }
  });
  assert.equal(messages[1].content, '[一]');
  assert.equal(messages[2].content, '[二]');
});
