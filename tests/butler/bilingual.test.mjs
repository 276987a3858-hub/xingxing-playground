/* tests/butler/bilingual.test.mjs — 中英双语的拆分、翻译触发条件与本地回复（不调 AI） */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRepository } from '../../public/butler/butler-repository.js';
import { createMemoryAdapter } from './memory-adapter.mjs';
import '../../public/butler/butler-intent.js';

const BI = globalThis.ButlerIntent;
const APP_SRC = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8');

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

async function fresh() {
  const repo = createRepository(createMemoryAdapter({}));
  BI._setRepository(repo);
  BI.clearPending();
  mem.clear();
  BI._resetHandled();
  return repo;
}

// 从 app.js 里取出真实实现来跑（app.js 依赖 DOM，不能 import，但这段是纯函数）
function loadNeedEnglish() {
  const m = APP_SRC.match(/function needEnglishTranslation\(s\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'app.js 里应有 needEnglishTranslation()');
  return new Function(`return (${m[0]})`)();
}

test('L01 管家提示词里的每个示例都遵守 ||| 中英分隔', () => {
  const sys = BI.systemPrompt();
  const examples = sys.split('\n').filter((l) => l.includes('<bl>'));
  assert.ok(examples.length >= 3, '至少三条示例');
  for (const line of examples) {
    assert.ok(line.includes('|||'), `示例缺少中英分隔：${line.slice(0, 60)}`);
  }
  assert.ok(sys.includes('三条竖线 ||| 不能省略'), '明确要求分隔符不可省');
});

test('L02 本地补充的确认落在中国话那一段，不污染英文段', async () => {
  await fresh();
  const display = await BI.handleAIResponse(
    '<bl>{"op":"task_add","title":"洗头","date":"today","time":"19:30"}</bl>好。 ||| Okay.',
    '19:30洗头，到点我叫你'
  );
  const bar = display.indexOf('|||');
  const extra = display.indexOf('记好了');
  assert.ok(bar > 0 && extra > 0, '本地确认与分隔符都在');
  assert.ok(extra < bar, '本地中文必须插在 ||| 之前');
  assert.ok(display.trim().endsWith('||| Okay.') || display.trim().endsWith('Okay.'), '英文段保持模型原文');
  assert.equal(display.split('|||').length, 2, '不得产生第二个分隔符');
});

test('L03 模型没给 ||| 时，不擅自把整段当英文或强行拆分', async () => {
  await fresh();
  const raw = '<bl>{"op":"task_add","title":"洗头","date":"today","time":"19:30"}</bl>好。';
  const display = await BI.handleAIResponse(raw, '19:30洗头，到点我叫你');
  assert.ok(!display.includes('|||'), '不凭空造分隔符');
  assert.ok(display.includes('记好了'), '仍给出中文确认');
  assert.ok(!/[A-Za-z]{3,}/.test(display), '确认文案里不混入英文');
});

test('L04 翻译触发条件：中文且英文语音关闭时不翻译', () => {
  const need = loadNeedEnglish();
  assert.equal(need({ showEnglish: false, voiceEnabled: false }), false, '纯中文 + 静音：0 次翻译');
  assert.equal(need({ showEnglish: false, voiceEnabled: true }), true, '英文语音开启仍需英文');
  assert.equal(need({ showEnglish: true, voiceEnabled: false }), true, '双语显示需要英文');
  assert.equal(need(null), false, '设置未加载时不额外请求');
});

test('L05 翻译在主回复展示后后台执行，按消息 id 回填', () => {
  assert.ok(APP_SRC.includes('function translateInBackground(messageId, chineseReply, force)'), '后台翻译入口存在');
  assert.ok(APP_SRC.includes('.then(() => fetchEnglishTranslation(chineseReply))'), '翻译在后台 Promise 中执行');
  assert.equal((APP_SRC.match(/fetchEnglishTranslation\(chineseReply\)/g) || []).length, 1, '只保留一处');
  const pushIdx = APP_SRC.indexOf('chatHistory.push(assistantMessage);');
  const translateIdx = APP_SRC.indexOf('translateInBackground(assistantMessage.id, chineseReply)');
  assert.ok(pushIdx > 0 && translateIdx > pushIdx, '主回复先入历史，再启动后台翻译');
  assert.ok(APP_SRC.includes("updateStore('messages', messageId, { englishContent: englishReply })"), '按 id 回填英文');
  assert.ok(APP_SRC.includes("const splitIndex = effReply.indexOf('|||')"), '双语模式仍按 ||| 拆分');
});

test('L06 本地 source:butler 即时回复不额外翻译（不加请求）', () => {
  const hits = APP_SRC.split('\n').filter((l) => l.includes("source: 'butler'"));
  assert.equal(hits.length, 2, '本地查询与补全两条路径');
  for (const line of hits) {
    assert.ok(line.includes("englishContent: ''"), '本地回复英文留空，不为它多打一次翻译');
  }
  // 本地路径结束标记：两条 return 之后进入正常 AI 请求（原 'stage = request-ai' 已随 requestStarReply() 重构移除）
  const start = APP_SRC.indexOf('window.ButlerIntent.tryLocal');
  const end = APP_SRC.indexOf('await requestStarReply(userMessage);');
  assert.ok(start > 0 && end > start, '本地路径起止标记必须存在（代码结构变动时请同步更新本测试）');
  const localBlock = APP_SRC.slice(start, end);
  assert.ok(!/fetchEnglishTranslation|callAI\(/.test(localBlock), '本地回复路径不得出现任何 AI 调用');
});

test('L07 提醒块不参与双语：提醒是系统上下文，不会变成一条聊天消息', async () => {
  await fresh();
  const out = await BI.remindContext(new Date(2026, 10, 17, 19, 20).getTime());
  assert.equal(out, '', '没有待办时返回空字符串');
  assert.ok(!out.includes('|||'), '提醒上下文不带分隔符');
});
