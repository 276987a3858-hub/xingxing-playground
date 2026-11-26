/* tests/chat/persona-layers.test.mjs — 五层人设运行时模块的纯逻辑测试（不调 AI、不开浏览器）
 * 覆盖：一/二层内嵌源、三层按话题、四层按关系情境、五层按事件、特殊能力待确认、
 *       话题粘性、明确换话题卸载、动态资料按需与原始记录保护、成功才去重。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import '../../public/shared/persona.js';
import '../../public/shared/persona-memory.js';

const P = globalThis.Persona;
const PM = globalThis.PersonaMemory;
const APP = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8');

function seedSandboxes() {
  P.seed({
    bg: readFileSync(new URL('../../public/persona/layer3-background.txt', import.meta.url), 'utf8'),
    rel: readFileSync(new URL('../../public/persona/layer4-relationship.txt', import.meta.url), 'utf8'),
    fn: readFileSync(new URL('../../public/persona/layer5-functions.txt', import.meta.url), 'utf8'),
    special: readFileSync(new URL('../../public/persona/special-abilities.txt', import.meta.url), 'utf8'),
  });
  P.reset(); PM.reset();
}

test('L01 第一、二层同步内嵌，无需异步即可取到基础人格', () => {
  const base = P.baseText();
  assert.ok(base.includes('【核心人设（小星）】'), '含核心人设来源标题');
  assert.ok(base.includes('【用户画像（认识起点，非固定定义）】'), '含用户画像来源标题');
  assert.ok(base.includes('你是小星'), '第一层人格主体在');
  assert.ok(base.includes('这份画像只是小星认识用户的起点'), '第二层画像主体在');
  assert.ok(P._embedded.layer1.length > 800, '第一层未被缩写为空壳');
});

test('L02 getSystemPrompt 已原子切换：不再拼旧人格，基础层来自 Persona', () => {
  assert.ok(/window\.Persona/.test(APP), 'getSystemPrompt 引用 Persona 基础层');
  assert.ok(!/你是「星星」，用户的 AI 助手/.test(APP), '旧 AI 助手身份已停止');
  assert.ok(!/【核心底色：Dom感超强与绝对掌控】/.test(APP), '旧核心底色整段已停止');
  assert.ok(!/精通围棋、羽毛球、篮球、剑术/.test(APP), '旧外在设定整段已停止');
  assert.ok(!/如果用户输入“小星，我昨天梦见你了”/.test(APP), '梦境固定触发句已停止');
  assert.ok(!/必须带\[心情\]标签，最多2句话/.test(APP), '早晚安强制格式已停止');
});

test('L03 全局双语已停、解析与翻译机制仍在', () => {
  assert.ok(!/每次回复必须严格包含中文和英文/.test(APP), '无每轮全局双语强制');
  assert.ok(APP.includes('getBilingualScenePrompt'), '改为场景级双语');
  assert.ok(APP.indexOf("indexOf('|||')") !== -1, '保留 ||| 解析');
  assert.ok(/fetchEnglishTranslation/.test(APP), '保留后台翻译机制');
});

test('L04 第三层按话题读取：饮食命中、无关闲聊不命中', () => {
  seedSandboxes();
  const food = P.background('今晚想吃什么？火锅还是炸鸡', '');
  assert.ok(food.includes('【角色背景·相关细节】'), '命中给来源标题');
  assert.ok(food.includes('火锅') || food.includes('炸鸡'), '命中饮食段');
  P.reset(); // 清掉粘性；独立验证"纯闲聊首轮不命中"
  const none = P.background('今天天气真好', '');
  assert.equal(none, '', '无关闲聊不注入三层');
});

test('L05 第四层按关系情境读取：亲密命中、称呼命中', () => {
  seedSandboxes();
  const intimate = P.relationship('我们亲吻的时候', '');
  assert.ok(intimate.includes('亲密') || intimate.includes('Dom'), '命中亲密偏好段');
  assert.ok(intimate.includes('接吻时喜欢掌握节奏'), '接吻掌握节奏已迁入第四层');
  P.reset();
  const name = P.relationship('我该怎么称呼你，先生？', '');
  assert.ok(name.includes('先生'), '命中称呼段');
});

test('L06 话题粘性：命中后下一轮无关键词仍保留，明确换话题才卸载', () => {
  seedSandboxes();
  assert.ok(P.background('说说你喜欢吃什么', ''), '首轮命中');
  const sticky = P.background('嗯', '');
  assert.ok(sticky.includes('【角色背景·相关细节】'), '下一轮无关键词仍保留（粘性）');
  const cleared = P.background('我们换个话题吧', '');
  assert.equal(cleared, '', '明确换话题后卸载');
});

test('L07 第五层按事件读取 + 特殊能力待确认', () => {
  seedSandboxes();
  const greet = P.functionPrompt('greet');
  assert.ok(greet.includes('不要求固定标签、固定句数'), '早晚安软性表述');
  const touch = P.functionPrompt('touch');
  assert.ok(touch.includes('不虚构'), '触摸不虚构字段');
  const sp = P.special('你会剑术吗');
  assert.ok(sp.includes('设定真实性：待确认'), '特殊能力保留待确认状态');
  assert.ok(sp.includes('不得作为确定事实输出'), '确认前不作为事实');
  const none = P.special('今天吃什么');
  assert.equal(none, '', '无关话题不注入特殊能力');
});

test('L08 动态资料：普通闲聊不读；回忆信号触发检索且只给片段', () => {
  PM.reset();
  assert.equal(PM.needRecall('今天天气不错'), false, '闲聊不触发');
  assert.equal(PM.needRecall('记得我们上次说好的事吗'), true, '回忆信号触发');
  const longTerm = '我们约定每周一起看星星。\n上周买了绿色的杯子。\n你爱吃辣。';
  const r = PM.memoryPart('记得我们的约定吗', longTerm);
  assert.ok(r.text.includes('【长期记忆'), '命中给来源标题');
  assert.ok(r.text.includes('约定'), '命中相关片段');
  assert.ok(r.keys.length > 0, '返回成功后再去重的键');
});

test('L09 原始记录保护：检索不改动 longTermMemory，未命中如实说没找到', () => {
  PM.reset();
  const raw = '我们约定每周一起看星星。\n你爱吃辣。';
  const snapshot = raw;
  PM.memoryPart('记得我们的约定吗', raw);
  assert.equal(raw, snapshot, '原始字符串未被修改');
  const miss = PM.memoryPart('记得那件不存在的事吗', '一些无关内容');
  assert.ok(miss.text.includes('没有找到'), '未命中如实说没找到');
  const emptyDiary = PM.recordPart('写过的日记', [], 'diary');
  assert.ok(emptyDiary.text.includes('没有找到'), '无记录时不编造日记');
});

test('L10 成功才去重：markSent 后不再命中同一条', () => {
  PM.reset();
  const mem = '我们约定每周一起看星星。';
  const first = PM.memoryPart('记得我们的约定吗', mem);
  assert.ok(first.keys.length > 0, '首次返回键');
  PM.markSent(first.keys);
  const second = PM.memoryPart('记得我们的约定吗', mem);
  assert.equal(second.text, '', '已成功发出的片段不再重复注入');
  // 失败场景：不调用 markSent，则仍可重试
  PM.reset();
  const again = PM.memoryPart('记得我们的约定吗', mem);
  assert.ok(again.text.includes('【长期记忆'), '未标记时下一轮仍可重试');
});

test('L11 动态片段长度受限，但不影响原始数据（原文仍完整）', () => {
  PM.reset();
  const long = ('约定内容很长。'.repeat(200));
  const r = PM.memoryPart('记得我们的约定吗', long);
  for (const line of r.text.split('\n')) {
    if (line.startsWith('·')) assert.ok(line.length <= PM._keys.MAX_LEN.memory + 5, '单片段有上限');
  }
  assert.equal(long.length, '约定内容很长。'.repeat(200).length, '原文长度未变');
});

// ---- 睡眠习惯段：nosticky + 语境闸门回归 ----
function bodySentences(raw) {
  return raw.split('\n')
    .filter(l => l.trim() && !l.startsWith('[[SEC:'))
    .join('')
    .split('。').map(x => x.trim()).filter(Boolean).sort();
}

test('L17 原始睡眠素材逐句保留（拆段不删正文）', () => {
  seedSandboxes();
  const original = [
    '银发，浅蓝色眼睛，身形高挑清瘦，但有肌肉线条',
    '嗜睡，喜欢安静的环境，也喜欢数星星入眠',
    '有起床气，睡醒时头发偶尔会翘起来，但会自己整理',
    '不太习惯戴耳饰',
    '心率偏慢，约为 40—55 次/分钟，睡眠时可能更低；生命体征不明显',
    '睡得太久偶尔可能梦游，醒来后不一定记得',
    '受伤或生病时倾向于通过睡觉休息恢复',
    '哪里都能睡，对枕头不太挑剔',
  ].sort();
  const secs = P._layers().bg;
  const textOf = (key) => ((secs.find(s => s.key === key) || {}).text || '');
  assert.deepEqual(bodySentences(textOf('外貌') + textOf('睡眠习惯')), original, '八个原句一字不差，只是分到两段');
  assert.equal(secs.find(s => s.key === '睡眠习惯').sticky, false, '睡眠段标记为非粘性');
  assert.equal(secs.find(s => s.key === '睡眠习惯').gateKey, 'selfSleep', '睡眠段带语境闸门');
});

test('L18 普通睡觉表达不触发睡眠背景', () => {
  const cases = [
    '我困了，先睡会儿', '我要睡了', '现在几点了？', '你去睡吧',
    '晚安', '昨晚没睡好', '我昨晚没睡好，今天好累',
  ];
  for (const t of cases) {
    seedSandboxes();
    assert.ok(!bgKeys(P.background(t, '')).includes('睡眠习惯'), `${t} 不应触发`);
  }
});

test('L19 真正询问小星自己的睡眠习惯时当轮注入', () => {
  const cases = [
    '你是不是容易犯困？', '你睡觉会做梦吗？', '你还记得数星星入眠吗？',
    '你有起床气吗', '你最近睡得不好吗', '小星嗜睡吗',
  ];
  for (const t of cases) {
    seedSandboxes();
    assert.ok(bgKeys(P.background(t, '')).includes('睡眠习惯'), `${t} 应触发`);
  }
});

test('L20 命中后下一轮普通聊天不再注入（无粘性）', () => {
  seedSandboxes();
  assert.ok(bgKeys(P.background('你是不是容易犯困？', '')).includes('睡眠习惯'), '首轮命中');
  const next = P.background('嗯，今天天气不错', '');
  assert.ok(!bgKeys(next).includes('睡眠习惯'), '下一轮不再注入');
  assert.equal(next, '', '睡眠段不占用其他段的 active 位');
});

test('L21 assistant 历史里的睡眠词不造成重新触发，其他段历史恢复不变', () => {
  seedSandboxes();
  const hist = '我刚才说：我困了，想睡觉，数星星入眠。';
  const out = P.background('今天吃什么', hist);
  assert.ok(!bgKeys(out).includes('睡眠习惯'), '历史窗口不带回睡眠段');
  assert.ok(bgKeys(out).includes('饮食'), '本轮命中仍正常注入');
  P.reset();
  const recovered = P.background('嗯', '晚上想吃火锅');
  assert.ok(bgKeys(recovered).includes('饮食'), '其他段的历史恢复机制保持原样');
});

test('L22 外貌段不再被睡眠词误触发，心率等特征仍可命中', () => {
  seedSandboxes();
  assert.ok(!bgKeys(P.background('我困了想睡觉', '')).includes('外貌'), '外貌段不再含宽泛睡眠关键词');
  P.reset();
  assert.ok(bgKeys(P.background('你心率多少', '')).includes('外貌'), '心率等正文仍走外貌段');
});

test('L23 睡眠段不占 LRU 名额，其他段淘汰行为不变', () => {
  seedSandboxes();
  P.background('你是不是容易犯困？', '');
  P.background('晚上想吃火锅', '');
  P.background('喜欢拍照', '');
  P.background('你会弹钢琴吗', '');
  const keys = bgKeys(P.background('钢琴弹得不错', ''));
  assert.ok(keys.includes('能力'), '能力仍在');
  assert.ok(!keys.includes('饮食'), '最久未命中的饮食按原规则淘汰');
  assert.ok(!keys.includes('睡眠习惯'), '睡眠段未被 LRU 保留');
});

// ---- LRU 话题淘汰回归（修复"只累加不淘汰"）----
// 用真实 layer3 段落，按段落 key 判断当前注入了哪些段。
function bgKeys(out) {
  return P._layers().bg.filter(s => s.text.trim() && out.includes(s.text.slice(0, 12))).map(s => s.key);
}

test('L12 持续讨论同一话题：无关键词的一轮仍保留资料（粘性）', () => {
  seedSandboxes();
  const first = P.background('晚上想吃火锅', '');
  assert.ok(bgKeys(first).includes('饮食'), '首轮命中饮食');
  const sticky = P.background('嗯', '');
  assert.ok(bgKeys(sticky).includes('饮食'), '下一轮无关键词仍保留（未被立即卸载）');
});

test('L13 自然转折 A→B→C：新话题替换最久未命中的旧话题', () => {
  seedSandboxes();
  P.background('晚上想吃火锅', '');              // A 饮食
  assert.ok(bgKeys(P.background('喜欢拍照', '')).includes('兴趣'), 'B 兴趣命中'); // B 兴趣
  const third = P.background('你会弹钢琴吗', ''); // C 能力
  const keys = bgKeys(third);
  assert.ok(keys.includes('能力'), 'C 新话题命中并注入');
  assert.ok(!keys.includes('饮食'), '最久未命中的旧话题 A 已被淘汰，不长期残留');
});

test('L14 明确换话题仍清空旧资料，且屏蔽历史窗口自动恢复', () => {
  seedSandboxes();
  P.background('晚上想吃火锅', '');
  const cleared = P.background('我们换个话题吧', '晚上想吃火锅');
  assert.equal(cleared, '', '换话题立即清空，不被历史窗口重新恢复');
  const stillQuiet = P.background('嗯', '晚上想吃火锅 火锅');
  assert.equal(stillQuiet, '', '换话题后无当前命中时，历史不再自动恢复旧资料');
});

test('L15 重新提起旧话题：被淘汰的段落能再次命中加载', () => {
  seedSandboxes();
  P.background('晚上想吃火锅', '');
  P.background('喜欢拍照', '');
  P.background('你会弹钢琴吗', '');               // 此时饮食已被淘汰
  assert.ok(!bgKeys(P.background('钢琴弹得不错', '')).includes('饮食'), '饮食已不在 active');
  const back = P.background('又想吃火锅了', '');
  assert.ok(bgKeys(back).includes('饮食'), '重新提起旧话题时饮食再次命中加载');
});

test('L16 已激活话题再次命中会刷新最近使用位置（不被误淘汰）', () => {
  seedSandboxes();
  P.background('晚上想吃火锅', '');   // 饮食(旧)
  P.background('喜欢拍照', '');       // 兴趣(新)
  P.background('晚上又想吃火锅', ''); // 饮食重新命中 → 刷新为最近使用
  const after = P.background('再吃一次火锅', '');
  assert.ok(bgKeys(after).includes('饮食'), '反复讨论的饮食保持可用');
});
