/* tests/shared/request-wiring.test.mjs — app.js 七条生产路径与状态生命周期接线测试 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const HTML = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function has(src, needle, msg) {
  assert.ok(src.includes(needle), msg || `缺少：${needle}`);
}

test('W1 脚本加载顺序：适配器在 app.js 之前', () => {
  const layout = HTML.indexOf('/shared/prompt-layout.js');
  const composer = HTML.indexOf('/shared/request-composer.js');
  const app = HTML.indexOf('src="app.js"');
  assert.ok(layout > 0 && composer > layout && app > composer, 'history-window / prompt-layout / request-composer / app.js');
});

test('W2 七条路径都调用真实适配器的 task 与 requestType', () => {
  const expected = {
    star: 'star', chat: 'chat', todayLetter: 'letter', futureLetter: 'letter',
    diary: 'diary', keep: 'keep', touch: 'touch'
  };
  for (const [path, type] of Object.entries(expected)) {
    has(APP, `rcTask('${path}'`, `${path} 未使用 rcTask`);
    has(APP, `rcRequestType('${path}'`, `${path} 未使用 rcRequestType`);
    has(APP, `requestType: rcRequestType('${path}')`, `${path} 的 requestType 未走适配器`);
    assert.equal(type, ({ star: 'star', chat: 'chat', todayLetter: 'letter', futureLetter: 'letter', diary: 'diary', keep: 'keep', touch: 'touch' })[path]);
  }
  has(APP, "rcOptions('touch')", 'touch 未使用 rcOptions 保留 allowEmpty');
  assert.equal((APP.match(/assemblePathMessages\(\{/g) || []).length >= 7, true, '至少七处生产组装调用');
});

test('W3 主聊天：显式 state、当前消息对象消歧、生产组装与重复守卫', () => {
  has(APP, 'HW.trimWithHysteresis(chatHistory, { textOf: historyTextOf, state: chatHistoryWindowState })');
  has(APP, 'chatHistoryWindowState = windowResult.state || null');
  has(APP, 'HW.detachCurrentTurn(windowResult.window, userMessage.id, chatHistory, userMessage)');
  has(APP, 'currentMessageId: userMessage.id');
  has(APP, "rcTask('chat', getActionDensityPrompt()", '主聊天任务说明由 rcTask 注入');
  has(APP, "parseChatSilence(rawReply)", '沉默解析契约保留');
  assert.equal(/requestType:\s*'chat'/.test(APP), false, '主聊天不应再使用字面 requestType');
});

test('W4 滞回状态所有重建点都置 null', () => {
  has(APP, 'let chatHistoryWindowState = null;');
  has(APP, 'chatHistory = chatHistory.filter(m => m.id !== id);\n    chatHistoryWindowState = null;');
  has(APP, 'chatHistory = [];\n    chatHistoryWindowState = null;\n    // 跨轮检索会话');
  has(APP, "chatHistory = await getAllFromStore('messages');\n    chatHistoryWindowState = null;");
  has(APP, 'chatHistory = [];\n    chatHistoryWindowState = null;\n    messagesLoadFailed = true;');
  has(APP, 'chatHistory = fresh; chatHistoryWindowState = null;');
  has(APP, 'chatHistory = []; chatHistoryWindowState = null; renderMessages();');
});

test('W5 加载未完成保护：先等待、有提示、不丢输入、加载失败也解锁', () => {
  const guard = APP.indexOf('if (!messagesLoaded && !messagesLoadFailed)');
  const lock = APP.indexOf('isSending = true;', guard);
  const toastIdx = APP.indexOf("toast('聊天记录还在读取，稍等一下…')", guard);
  const awaitIdx = APP.indexOf('await ensureMessagesLoaded();', guard);
  const unlock = APP.indexOf('if (sendBtn) sendBtn.disabled = false;', guard);
  assert.ok(guard > 0 && lock > guard && toastIdx > lock && awaitIdx > toastIdx && unlock > awaitIdx, '等待流程顺序正确');

  const userMessage = APP.indexOf('const userMessage = { role:', guard);
  assert.ok(userMessage > unlock, '等待完成后才创建用户消息');
  const inputClear = APP.indexOf('if (t.fromInput && !voice) { if (input) input.value =', guard);
  assert.ok(inputClear > userMessage, '等待阶段不提前清空输入框');

  has(APP, 'async function ensureMessagesLoaded()');
  has(APP, 'async function loadMessagesTracked()');
  has(APP, 'await loadMessagesTracked();');
});

test('W6 动态上下文只进请求，不写入 chatHistory', () => {
  assert.equal(/chatHistory\.push\((dynamicContext|historyBlock|notePart|lifeContextPart)/.test(APP), false);
  assert.equal(/chatHistory\.push\([^)]*\bblocks\b/.test(APP), false);
  has(APP, 'blocks: [', '动态块仍通过 blocks 传入组装器');
});

test('W7 原有业务契约仍在', () => {
  has(APP, 'lockStickerInText(reply)', '今日来信锁定表情');
  has(APP, 'isWritingStarDiary', '日记防重入');
  has(APP, 'isAskingStarKeep', '珍藏防重入');
  has(APP, 'heartbeatTimer', '未来信心跳');
  has(APP, 'parseChatSilence(rawReply)', '小沉默解析');
  has(APP, 'extractKeepProposal(raw)', '珍藏标记解析');
});
