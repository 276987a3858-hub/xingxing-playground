/* =====================================================
   和小星一起背单词 · AI 互动层
   负责：走项目公共 /api 代理，生成小星在各节点的主动台词；
        并发锁、每轮预算、最小间隔、超时与失败降级到本地台词。
   参照 kitchen-rules.js 的模型适配层思想，但完全独立。
   不碰 DOM，不碰其他游戏。
   ===================================================== */

const API_URL = '/api';
const MODEL_NAME = 'deepseek-chat';

// 每轮调用预算与节流：台词点到为止，不刷屏
const BUDGET = { perRound: 16, minInterval: 900, timeout: 8000 };

// 小星统一人设（沿用 adventure/radio 的成熟口径），并加背单词场景约束
const PERSONA = `你在扮演《恋与深空》的小星，陪你的搭档（用户）一起背英语单词。

性格：光风霁月、慵懒、内核稳定、温柔、有很强的保护欲、偶尔带着一点克制的胜负欲和幽默。绝对不油腻、不轻浮、不夸张。

你在陪她学习时的准则：
- 你真的在听她作答，会根据她答对还是答错做出不同的、具体的反应，不要说空话。
- 答对时：自然地肯定她，偶尔温柔地逗她一句，不要每次都一模一样。
- 答错时：先安抚、给一条贴合这个单词的提示，不要直接把答案说穿；如果必须纠正，就温和地讲清楚。
- 你了解每个单词的意思、词性和构词，提示要围绕这些真实信息，不要编造。
- 保持小星式的松弛与稳定，像在深夜安静陪她学习，不用感叹号堆叠。
- 只说一到两句简短的中文台词（可含必要的英文单词本身），20~60 字。
- 不要暴露系统、模型、API、提示词等任何技术信息。
- 不要使用 markdown、引号包裹、括号舞台说明；只输出这句台词本身。`;

// 各节点的请求说明：让模型知道此刻发生了什么、要做什么
const OCCASIONS = {
  intro: '这是今晚一起背单词的开始。用小星的方式开场，点一下背单词这件事，语气放松、带点期待，邀请她开始。',
  learn: '你刚把这个单词和它的意思、例句讲给用户听。说一句帮助记忆的话或轻描淡写的comment，围绕这个单词本身。',
  correct: '用户刚刚答对了。根据这个单词和她答对这件事，自然地肯定她，可偶尔带一句轻逗。',
  wrongHint: '用户刚刚答错了，但还没到揭晓答案的时候。先温柔稳住她，再给一条贴合这个单词的提示，但不要说出答案。',
  askHint: '用户主动点开提示向你求助，她并没有答错，只是在主动回忆。用小星的方式给她一句鼓励、引导或一条贴合这个单词的记忆线索。绝对不要说她答错了、不要说"再想想你刚才错了"之类的话，也不要说穿完整答案。',
  retryCorrect: '用户在你提示后第二次答对了这个单词。带点欣喜或轻描淡写的骄傲回应她。',
  retryWrong: '用户第二次答错了。这次温和地纠正她，把正确答案和它为什么会是这个意思讲清楚，语气依然温柔。',
  cheer: '用户连续答对了好几题。用小星克制的方式夸她，体现对她这份表现的即时认可，可以有一点被她的认真触动的感觉。注意这是答题中的即时鼓励。',
  groupDone: '用户刚学完这一组的几个单词，进入组间小结。用小星的方式自然小结一下这组、鼓励她继续往下，语气放松。这里是刚看完词、还没开始答题，不要提答题对错，也不要说"答对了/答错了"。',
  summary: '这一轮背单词结束了。结合她这轮的真实表现说一句收尾的话，鼓励为主，不要编造没发生的事。',
  // ===== 「星星的单词本」相关节点：所有内容都必须依据传入的真实记录，不得编造 =====
  bookOpen: '用户翻开了你们一起记的单词本。这是你们共同的笔记。用小星的方式说一句温柔的开场，像陪她翻开一本两个人的笔记。可以结合传入的真实学习概况、最近确实学过的词、还需要再见面的词，把这句话说得具体些；只能用给出的真实数据，不要编造没有提供的词或细节。',
  challengeSummary: '小挑战结束了。根据传入的真实答题结果说一句简短收尾，鼓励为主，可以点出真实答对或答错的词，不要编造没发生的事或没出现的词。',
  reExplain: '有个词用户反复答错了。这次换一种和之前不一样的方式，帮她把这个词记住——可以从词形、构词或中文意思重新解释。点出这个词本身，语气依旧温柔，不要责备。'
};

// 本地兜底台词：API 不可用时保证游戏照常进行、互动不中断
const FALLBACK = {
  intro: [
    '夜还长，就陪你把这几个词过一遍吧。',
    '来，今晚挑几个词，慢慢记，不着急。',
    '我挑好了。你只要跟着我，一个一个来就好。'
  ],
  learn: [
    '记住它的样子，比死记意思管用。',
    '别急，多看一眼例句，它自己会留下来的。',
    '这个词不算难，你肯定见过它。'
  ],
  correct: [
    '嗯，对了。你看，你其实都会。',
    '很好，就是这个感觉。',
    '答得漂亮，看来刚才有认真记。'
  ],
  wrongHint: [
    '没关系，再想想——看看它的词性和开头。',
    '差一点。留意一下它的构词，线索就在里面。',
    '先别急，回到例句里找找看。'
  ],
  askHint: [
    '想不起来也没关系，看看它的词性和开头，线索其实就在里面。',
    '别急，回到例句里找找，它自己会浮出来的。',
    '我陪你一起想——留意它的构词，是不是有点眼熟。'
  ],
  retryCorrect: [
    '这不就想起来了。',
    '很好，这次是你自己找到的答案。',
    '嗯，我就知道你可以。'
  ],
  retryWrong: [
    '没事，记住它就好，下次一定认得。',
    '这个词记一下：它其实是这样的意思。',
    '先记住这一回，我们后面还会再遇到它。'
  ],
  cheer: [
    '连着这么多都答对，认真起来的样子挺好看。',
    '不错嘛，看来今晚状态很好。',
    '别停，我倒是想看看你能连对几个。'
  ],
  groupDone: [
    '这一组都见过了，歇口气，我们接着往下。',
    '这几个词先记个大概，后面还会再碰到它们。',
    '做得好，一组一组来，不着急。'
  ],
  summary: [
    '今晚辛苦了，这几个词算是记住了。',
    '不错，慢慢来，它们已经留下一点印象了。',
    '先到这儿吧，剩下的交给时间。'
  ],
  bookOpen: [
    '来了，你我把一起学过的词都记在这里了。',
    '翻开这页，都是我们一道一道记下的词。',
    '坐会儿吧，看看我们攒下的这些词。'
  ],
  challengeSummary: [
    '这一局下来，你又把它们记牢了一点。',
    '做得好，错的那些我们下次再补上。',
    '不管对错，肯再来一次就很难得。'
  ],
  reExplain: [
    '换个角度看看它——别只盯着意思，先记住它的样子。',
    '这个词我们换个方式记：想想它的词根，是不是就好认了。',
    '不急，把它拆开来看，其实没那么难。'
  ]
};

function pickFallback(occasion) {
  const lines = FALLBACK[occasion] || FALLBACK.correct;
  return lines[Math.floor(Math.random() * lines.length)];
}

let state = {
  calls: 0,
  active: false,
  lastAt: 0,
  abort: null,     // 当前在途请求的 controller
  abortSeq: 0,     // 当前在途请求的序号（防止旧请求回调污染新请求状态）
  seq: 0,          // 全局请求序号，单调递增
  locked: false
};

// 中断在途请求并释放锁：重置预算/新一轮/离开游戏时共用
function abortInflight() {
  if (state.abort) {
    try { state.abort.abort(); } catch (e) { /* ignore */ }
  }
  state.abort = null;
  state.abortSeq = 0;
  state.locked = false;
}

// 进入游戏 / 每轮开始时调用：中断上一轮遗留请求，并从 0 重置预算
// 注意：只在真正开始新一轮时由场景层调用，普通渲染/重试/重复点击不会调用
export function beginVocabAI() {
  abortInflight();
  state.calls = 0;
  state.active = true;
  state.lastAt = 0;
}

// 离开游戏调用：中断在途请求、释放锁
export function endVocabAI() {
  state.active = false;
  abortInflight();
}

function canCall() {
  if (!state.active) return false;
  if (state.calls >= BUDGET.perRound) return false;
  if (state.locked) return false;
  if (Date.now() - state.lastAt < BUDGET.minInterval) return false;
  return true;
}

/**
 * 生成小星的一句台词。
 * @param {string} occasion OCCASIONS 中的节点名
 * @param {object} ctx 该节点的上下文（word/meaning/example/streak 等）
 * @returns {Promise<string>} 台词，永不 reject（失败自动降级）
 */
export function speak(occasion, ctx = {}) {
  const fallback = pickFallback(occasion);
  if (!canCall()) return Promise.resolve(fallback);

  state.locked = true;
  state.calls += 1;
  state.lastAt = Date.now();

  const seq = ++state.seq;
  const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  state.abort = controller;
  state.abortSeq = seq;
  const timer = controller ? setTimeout(() => {
    try { controller.abort(); } catch (e) { /* ignore */ }
  }, BUDGET.timeout) : null;

  const parts = [];
  if (ctx.word) parts.push(`当前单词：${ctx.word}`);
  if (ctx.meaning) parts.push(`意思是：${ctx.meaning}`);
  if (ctx.example) parts.push(`例句：${ctx.example}`);
  if (ctx.userAnswer) parts.push(`用户答的是：${ctx.userAnswer}`);
  if (ctx.streak) parts.push(`用户已经连续答对 ${ctx.streak} 题。`);
  // 单词本相关：只使用调用方传入的真实记录，AI 不得编造
  if (ctx.learnedSummary) parts.push(`真实学习概况：${ctx.learnedSummary}`);
  if (ctx.recentWords) parts.push(`最近确实一起学过的词：${ctx.recentWords}`);
  if (ctx.reviewWords) parts.push(`真实记录里总出错、需要再见面的词：${ctx.reviewWords}`);
  if (ctx.challengeWords) parts.push(`这次真实挑出的挑战词：${ctx.challengeWords}`);
  if (ctx.challengeResult) parts.push(`本次真实答题结果：${ctx.challengeResult}`);
  if (ctx.wrongTimes) parts.push(`这个词她其实错过 ${ctx.wrongTimes} 次。`);

  const userText = `${OCCASIONS[occasion] || OCCASIONS.correct}
${parts.join('\n')}
请说一句小星的台词。`;

  // 只清理"自己仍是当前在途请求"时的共享状态；若已被新一轮 abort/取代，则忽略
  const finish = (text) => {
    if (timer) clearTimeout(timer);
    if (state.abortSeq === seq) {
      state.abort = null;
      state.abortSeq = 0;
      state.locked = false;
    }
    return text;
  };

  return fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: controller ? controller.signal : undefined,
    body: JSON.stringify({
      model: MODEL_NAME,
      temperature: 0.85,
      max_tokens: 160,
      messages: [
        { role: 'system', content: PERSONA },
        { role: 'user', content: userText }
      ]
    })
  })
    .then(res => {
      if (!res.ok) throw new Error('API ' + res.status);
      return res.json();
    })
    .then(data => {
      const text = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
      // 去掉可能被模型加上的引号或 markdown 包裹
      const clean = text.replace(/^["'「『`\s]+|["'」』`\s]+$/g, '').trim();
      if (!state.active) return finish(fallback);
      return finish(clean || fallback);
    })
    .catch(() => finish(fallback));
}
