/* tests/shared/voice-history.test.mjs — 语音消息进入 AI 历史时的文本口径（不调 AI、不碰 DOM）
 * 从 app.js 里取出真实实现来跑：app.js 依赖 DOM 不能 import，但这段是纯函数。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8');
const MATCH = SRC.match(/function historyTextOf\(m\) \{[\s\S]*?\n\}/);
assert.ok(MATCH, '没能从 app.js 取到 historyTextOf');
const historyTextOf = new Function(`${MATCH[0]}; return historyTextOf;`)();

test('H01 普通文字消息原样进入历史', () => {
  assert.equal(historyTextOf({ role: 'user', content: '在吗' }), '在吗');
});

test('H02 沉默消息用中性说明代替，不冒充正文', () => {
  assert.equal(historyTextOf({ role: 'assistant', silent: true, content: '已读，暂时没有回复' }), '（这一轮我没有出声，只是安静地待着）');
});

test('H03 语音消息的转写文字就是正文', () => {
  assert.equal(historyTextOf({ role: 'user', type: 'voice', content: '今天有点累' }), '今天有点累');
});

test('H04 没转成文字的语音给一句说明，绝不传空字符串', () => {
  const text = historyTextOf({ role: 'user', type: 'voice', content: '' });
  assert.ok(text.includes('语音'), text);
  assert.notEqual(text.trim(), '');
  // 空白字符也当作「没转成文字」
  assert.ok(historyTextOf({ role: 'user', type: 'voice', content: '   ' }).includes('语音'));
});

test('H05 普通空消息仍然返回空，不误判成语音', () => {
  assert.equal(historyTextOf({ role: 'user', content: '' }), '');
  assert.equal(historyTextOf(null), '');
});
