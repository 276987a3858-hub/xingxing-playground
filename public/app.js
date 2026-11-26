/* ============================================================
   星星与用户的房间 · app.js 终极完美版
   含 语音缓存重播 / 双语显示 / 日期分割线 / 搜索高亮跳转
   ============================================================ */

const API_BASE = window.location.protocol === 'file:'
  ? 'http://127.0.0.1:23210/https://api.deepseek.com/chat/completions'
  : '/api';

const DB_NAME = 'star_fifi_room';
const DB_VER = 3;
let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      if (!d.objectStoreNames.contains('messages')) d.createObjectStore('messages', { keyPath: 'id', autoIncrement: true });
      if (!d.objectStoreNames.contains('diaries')) d.createObjectStore('diaries', { keyPath: 'id', autoIncrement: true });
      if (!d.objectStoreNames.contains('starDiaries')) d.createObjectStore('starDiaries', { keyPath: 'id', autoIncrement: true });
      if (!d.objectStoreNames.contains('keeps')) d.createObjectStore('keeps', { keyPath: 'id', autoIncrement: true });
      if (!d.objectStoreNames.contains('futureLetters')) d.createObjectStore('futureLetters', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => {
      const connection = req.result;
      db = connection;
      connection.onversionchange = () => {
        try { connection.close(); } catch {}
        if (db === connection) db = null;
        toast('数据库已被新页面升级，请刷新当前页面。');
      };
      resolve(connection);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('数据库被其它标签页占用，请关闭其它标签页后刷新重试'));
  });
}

function kvGet(k) {
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readonly');
    const r = tx.objectStore('kv').get(k);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function kvSet(k, v) {
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(v, k);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

function addToStore(s, o) {
  return new Promise((res, rej) => {
    const tx = db.transaction(s, 'readwrite');
    const r = tx.objectStore(s).add(o);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function getAllFromStore(s) {
  return new Promise((res, rej) => {
    if (!db) { res([]); return; }
    const tx = db.transaction(s, 'readonly');
    const r = tx.objectStore(s).getAll();
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => rej(r.error);
  });
}

function clearStore(s) {
  return new Promise((res, rej) => {
    const tx = db.transaction(s, 'readwrite');
    tx.objectStore(s).clear();
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

function updateStore(s, id, data) {
  return new Promise((res, rej) => {
    const tx = db.transaction(s, 'readwrite');
    const store = tx.objectStore(s);
    const req = store.get(id);
    let settled = false;
    const fail = (err) => { if (settled) return; settled = true; try { tx.abort(); } catch {} rej(err); };
    req.onsuccess = () => { if (!req.result) { fail(new Error('记录不存在')); return; } store.put({ ...req.result, ...data }); };
    req.onerror = () => fail(req.error);
    tx.oncomplete = () => { if (settled) return; settled = true; res(); };
    tx.onerror = () => fail(tx.error);
    tx.onabort = () => fail(tx.error || new Error('事务已中止'));
  });
}

let apiKey = '';
let chatHistory = [];
// 主聊天历史窗口的左边界状态（仅内存，不写库）。chatHistory 被整体重建/清空时必须置 null。
let chatHistoryWindowState = null;
let settings = {
  light: 'soft', showTime: true, showStatus: true, fontSize: '14', starMotion: true, wallpaper: '',
  showEnglish: false, voiceEnabled: true,
  // 天气城市：空字符串 = 按出口 IP 自动判断（沿用旧行为，不申请定位权限）。点天气那一行可修改。
  weatherCity: '',
  // 触摸互动：两个开关彼此独立，也与上面的普通聊天语音无关
  // touchAIEnabled 默认开启（触摸文字回复）；touchVoiceEnabled 默认关闭，不主动开语音。
  touchAIEnabled: true, touchVoiceEnabled: false
};

// —— 天气状态：代表「她那边」（她所在地）的天气，不是小星所处的物理环境 ——
// 旧实现只有一句默认值 '晴朗'，请求失败时界面显示「未知」而提示词仍在说「晴朗」，
// 等于让模型把一个从没发生过的天气当成事实讲出来。这里改成显式状态：
//   desc 为空 → unknown（从未成功获取）；fetchedAt 超出有效期 → stale（有数据但已过期）。
// 不在状态里存「当前是否有效」，有效期一律按 fetchedAt 现算，避免两处状态互相打架。
// cityQuery 记录「这份数据是按哪个城市查询拿到的」，只用于判断存档是否属于当前城市，不参与展示。
let weather = { desc: '', tempC: null, city: '', lat: null, fetchedAt: 0, cityQuery: '' };
let weatherLastFailAt = 0;
const WEATHER_TTL_MS = 60 * 60 * 1000;   // 60 分钟：超过就视为过期，需要刷新
const WEATHER_RETRY_MS = 10 * 60 * 1000; // 失败后 10 分钟内不重复打接口
// 最近一次成功获取的天气存在既有 kv 里（不新建数据库、不申请定位权限）。
// 刷新页面后先用它渲染并注入提示词，fresh / stale 仍由 fetchedAt 现算，不额外存 status。
const WEATHER_STORE_KEY = 'weatherLast';
let idleTimer = null;
let idleMinutes = 2;
// P2-b：最后一次用户活动时刻（空闲判定由调度器统一读取）
let lastUserActivityAt = Date.now();
// 主动关心的「请求尝试」时刻：只要真的发出了 AI 请求就更新（模型沉默 / 请求失败也算一次尝试）。
// 与 lastUserActivityAt（真的说出口才算互动）和 LifeScheduler 的成功开口预算互相独立。
let lastIdleAttemptAt = 0;
const IDLE_ATTEMPT_COOLDOWN = 15 * 60 * 1000;   // 两次主动请求尝试之间的最短间隔
let longTermMemory = '';
// 第二阶段：v2 条目状态（只读缓存）。未初始化/读取异常时为 null，检索自动回退旧字符串。
let longTermMemoryV2 = null;
let diarySummaryCache = '';
let keepsSummaryCache = '';
let pendingChatImage = null;
// 从游乐场带着结算消息回到聊天时，记录这一次互动的游戏与结果（只用一轮，避免长期占用提示词）
let pendingGameContext = null;
// 生活管家提醒检查的节流时间戳（闲聊时不做每轮扫描）
let lastRemindScan = 0;

const bgAudio = document.getElementById('bgAudio');

// 时间判断的唯一入口：统一走 LifeClock（浏览器本地时间），不在各处各写一套 getHours / 时区换算。
// LifeClock 在 index.html 中先于 app.js 加载；未加载时退回本地 Date，绝不使用 UTC 或固定城市时区。
function localHour() {
  const lc = window.LifeClock;
  const d = lc ? new Date(lc.now()) : new Date();
  return d.getHours();
}

function getNowContext() {
  const lc = window.LifeClock;
  if (lc) return `${lc.formatStamp()} ${lc.weekdayName()}（本地时间）`;
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} ${wd}（本地时间）`;
}

// 只提供事实 + 一句极短的优先级说明：每次请求现取本地时间，不写具体钟点锚点、不堆防错规则。
// 注意：这一段含分钟级时间戳，每轮都变。必须由 withNowAtEnd() 放在 system 的【末尾】，
// 不能放进 getSystemPrompt()，否则连续前缀缓存会在人设之后立刻断裂。
function getNowBlock() {
  return `【当前时间】${getNowContext()}。她问现在几点、或你要提现在几点，只按这一行说；便签、提醒和以前聊过的时间都不算此刻。`;
}

// 所有 AI 请求路径统一在 system 末尾追加当前时间。
// DeepSeek 的前缀缓存按连续前缀匹配，唯一高频变化的分钟时间放在最后，
// 前面的人设、静态规则、五层资料、动态记忆才能稳定命中缓存。
function withNowAtEnd(systemText) {
  return String(systemText == null ? '' : systemText) + '\n' + getNowBlock();
}

// 时段只在这里算一次：深夜<5 清晨5-8 上午8-11 中午11-13 下午13-17 傍晚17-19 晚上19-23 深夜>=23
function currentPeriod() {
  const h = localHour();
  const lc = window.LifeClock;
  return lc ? lc.partOfDay() : (h < 5 ? '深夜' : h < 8 ? '清晨' : h < 11 ? '上午'
    : h < 13 ? '中午' : h < 17 ? '下午' : h < 19 ? '傍晚' : h < 23 ? '晚上' : '深夜');
}

// 时间提示：只给「真实的时段」+「角色自己的习惯」。
// 第一批改造移除的内容：'你刚睡醒'、'你刚吃过饭'、'你极度嗜睡、有起床气'、'偶尔犯困'——
// 这些是没有依据的现实身体状态，却每轮都被当成事实注入，与「生活在星星游乐场里的 AI」直接矛盾。
// 保留：准确时段、熬夜这个角色习惯、以及他对她的关心。习惯和人设不是被编造的事件。
// 22-23 只说「晚上、还没到深夜」，不用会往上进位的措辞（避免被读成已过 23 点）。
function getTimeContext() {
  const h = localHour();
  const period = currentPeriod();
  if (h < 5) return '现在是凌晨。你习惯熬夜，这个点她还醒着，你会关心她为什么还不睡。';
  if (period === '清晨') return '现在是清晨。';
  if (period === '上午') return '现在是上午。';
  if (period === '中午') return '现在是中午。';
  if (period === '下午') return '现在是下午。';
  if (period === '傍晚') return '现在是傍晚。适合陪她，也可以带点掌控欲地撩她。';
  if (period === '晚上') return h >= 22
    ? '现在是晚上，还没到深夜。你习惯熬夜，会关心她为什么还不睡。'
    : '现在是晚上。适合陪她，也可以带点掌控欲地撩她。';
  return '现在是深夜。你习惯熬夜，但会关心她为什么还不睡。';
}

// 游乐场此刻：只描述游乐场（小星自己的设定空间）的景象。
// 第一批改造移除的内容：'你刚睡醒，正在吃午饭，大概率在吃肉'、'你正在发呆，或者在看书、练字'、
// '可能刚吃完火锅'——那是把没有依据的现实作息写成此刻正在发生的事，模型会照着当事实讲。
// 同一时段内文本固定，不随轮次变化，也不会给缓存前缀制造额外抖动。
// 函数名沿用 getScheduleContext：3 处调用点与 2 个浏览器测试脚本按这个名字取用，改名会连带破坏它们。
function getScheduleContext() {
  const h = localHour();
  const period = currentPeriod();
  if (period === '深夜') return '游乐场的灯只剩零星几盏，设施都停着。';
  if (period === '清晨') return '游乐场还没开始运转，很静。';
  if (period === '上午') return '游乐场刚运转起来，音乐放得很轻。';
  if (period === '中午') return '游乐场到了中午，转速慢下来。';
  if (period === '下午') return '游乐场午后，一直转着。';
  if (period === '傍晚') return '游乐场的灯一盏盏亮起来。';
  return h >= 22 ? '夜色已经很浓，但还没到深夜；游乐场的灯还亮着。' : '游乐场的灯都亮着，轮子慢慢转。';
}

// 五层人设接入后的核心拼装入口。
// 基础层（第一层核心人设 + 第二层用户画像）由 window.Persona 提供，每轮必注入；
// 旧版「AI 助手身份 / 外在设定整段 / Dom 固定触发句 / 光猎固定触发句 / 1-3 句硬上限 / 固定昵称」
// 已在此处停止注入（原子切换：删旧与接入新版在同一次变更内完成）。
// 保留的是程序机制：表情标签解析格式、[[KEEP_PROPOSAL]] 标记格式、时间与天气事实。
// 第三、四、五层与动态资料不在本函数注入，改由 doRequestStarReply 按话题/情境/事件按需拼装。
function getSystemPrompt() {
  const base = (window.Persona && window.Persona.baseText && window.Persona.baseText())
    || '你是小星。以普通人的生活方式与用户相处，有自己的性格、意志、情绪和真实感。';

  const stickerMech = '\n\n【表情标签（保留现有格式）】'
    + '可用 [表情:开心]、[表情:生气] 等标签发送表情包，也可直接发颜文字或单独的星星🌟。'
    + '可用分类：吃醋、干饭、害羞、开心、哭哭、困、卖萌、猫猫、生气、疑惑。表达对应情绪时直接使用该标记，系统会自动匹配图片；不必每轮强制出现。';

  const keepMech = '\n\n【珍藏提议（保留现有标记格式）】'
    + '珍藏是你从相处里挑出来的一件特别的事，等用户决定收不收；它不是日记，日记是你自己的日常流水与心情。'
    + '偶尔（不要每轮、不要连续两次）遇到值得留住的瞬间，可在回复最后另起一行写：'
    + '\n[[KEEP_PROPOSAL: {"title":"不超过10字","text":"她做过或说过的那件事，一句话","reason":"你想留下的理由，一句话"}]]'
    + '\n只在这一种情况下写这个标记，其余时候一个字都不要提；被拒绝也不要再提。同一件事已在日记里写过就不要再写成珍藏。';

  // 这里只放相对稳定的内容（人设 / 静态规则 / 时段与她那边的天气）。
  // 分钟级时间由 withNowAtEnd() 统一追加在 system 末尾，保证前缀缓存不被每轮变化的时间戳截断。
  // 天气行由 weatherPromptLine() 生成：有效 / 已过期 / 未知三种状态各有明确措辞，未知时禁止编造。
  return base
    + '\n\n【当前现实环境】\n时间提示：' + getTimeContext() + '\n' + weatherPromptLine()
    + stickerMech + keepMech;
}

// 环境块（时段 + 她那边的天气）的唯一出处就是 getSystemPrompt()。
// 这里只负责「把这一段原文切成两块」，一字不改、不重新生成：
//   block = 【当前现实环境】整段；rest = 剩余的人设与机制文本。
// 主聊天与其余请求路径共用同一套切分规则，避免出现「一条路径放中间、另一条放末尾」的分叉，
// 也避免某条路径自己再拼一份天气/时段，导致同一时刻两条路径口径不同。
function splitEnvBlock(systemText) {
  const full = String(systemText == null ? '' : systemText);
  const start = full.indexOf('\n\n【当前现实环境】');
  const sticker = start >= 0 ? full.indexOf('\n\n【表情标签', start) : -1;
  if (start < 0 || sticker <= start) return { rest: full, block: '' };
  return { rest: full.slice(0, start) + full.slice(sticker), block: full.slice(start, sticker) };
}

// 其他请求路径（来信 / 日记 / 未来信 / 珍藏 / 触摸 / 主动关心）统一走这里：
// 环境块挪到 system 末尾、分钟时间之前，人设与机制成为稳定前缀。
// 各路径自己的角色提示词仍原样拼在人设之后，不合并、不改写。
function systemWithEnvAtEnd(systemText) {
  const parts = splitEnvBlock(systemText);
  return parts.block ? parts.rest + parts.block : parts.rest;
}

// 新请求架构：一次取齐「稳定核心」与「环境动态块」，避免同一轮两次调用 getSystemPrompt()
// 得到不同的天气状态。稳定核心 = 人设 + 表情/珍藏机制；环境块进入动态上下文层。
function getStableCoreAndEnv() {
  const parts = splitEnvBlock(getSystemPrompt());
  return { core: parts.rest, env: parts.block || '' };
}

// 七条路径共享的纯组装适配器在 RequestComposer；这里只注入 app.js 的本地依赖。
const LEGACY_REQUEST_TYPES = {
  star: 'star', chat: 'chat', todayLetter: 'letter', futureLetter: 'letter',
  diary: 'diary', keep: 'keep', touch: 'touch'
};
function rc() { return window.RequestComposer; }
function rcTask(name, chatTask) {
  const C = rc();
  if (C && typeof C.taskFor === 'function') return C.taskFor(name, chatTask);
  return String(chatTask == null ? '' : chatTask);
}
function rcRequestType(name) {
  const C = rc();
  if (C && typeof C.requestTypeFor === 'function') return C.requestTypeFor(name);
  return LEGACY_REQUEST_TYPES[name] || name;
}
function rcOptions(name) {
  const C = rc();
  if (C && typeof C.optionsFor === 'function') return C.optionsFor(name);
  return name === 'touch' ? { allowEmpty: true } : {};
}

// 兼容旧调用：动态上下文仍然由适配器统一收口，时间固定在最后。
function buildRequestDynamicContext(blocks, envBlock) {
  const C = rc();
  if (!C || typeof C.buildDynamicContext !== 'function') return '';
  return C.buildDynamicContext(blocks, envBlock, getNowBlock(), window.PromptLayout);
}

// 稳定层 = 核心人设 + 稳定机制 + 路径任务指令；动态块在历史之后、当前消息之前。
function assemblePathMessages(opts) {
  const o = opts || {};
  const C = rc();
  const se = getStableCoreAndEnv();
  if (C && typeof C.assemblePathMessages === 'function') {
    return C.assemblePathMessages({
      core: se.core,
      envBlock: se.env,
      nowBlock: getNowBlock(),
      taskInstruction: o.taskInstruction || '',
      blocks: o.blocks || [],
      history: o.history || [],
      currentTurn: o.currentTurn,
      currentMessageId: o.currentMessageId,
      PL: window.PromptLayout,
      mapHistory: messageToAI
    });
  }
  // 适配器未加载时的最小回退，行为与重构前一致。
  const PL = window.PromptLayout;
  const task = o.taskInstruction || '';
  const stableSystem = PL && typeof PL.buildStableSystem === 'function'
    ? PL.buildStableSystem(se.core, task)
    : se.core + task;
  const dynamicContext = buildRequestDynamicContext(o.blocks || [], se.env);
  const history = Array.isArray(o.history) ? o.history : [];
  const current = o.currentTurn;
  if (!PL || typeof PL.assembleMessages !== 'function') {
    return [{ role: 'system', content: stableSystem + dynamicContext }, ...history.map(messageToAI), current];
  }
  return PL.assembleMessages({
    stableSystem: stableSystem,
    historyWindow: history,
    mapHistory: messageToAI,
    dynamicContext: dynamicContext,
    currentTurn: current,
    currentMessageId: o.currentMessageId
  });
}

// 统一对话表达规范：全仓唯一文本源。
// 六条直接互动路径（主聊天 / 触摸 / 主动关心 / 早晚安 / 今日来信 / 未来信）通过各自的
// taskInstruction 槽位各注入一次；日记、珍藏判定等非对话体裁不继承。
// 只讲"怎么说话"，不列禁用词，不改人设与亲密风格；示范句一律用「你」，不示范第三人称。
function getDialogueStylePrompt() {
  return '\n\n【对话的写法】'
    + '你在和用户直接说话，不是在写旁白。写动作、神态，或在括号里补一句的时候，用「你」指用户、用「我」指你自己，就像正对着用户说话；不必每句都带「你」，视角一致就好。'
    + '话是主体：想说什么先说，语气、用词、停顿、反问、逗弄本身就带着情绪；动作和神态是补充，让这句话更有温度时才用，不是每句都要配一份。'
    + '真要写就写清楚，写细也可以——牵你、把你往身边带、低头看你，这些都可以自然发生。写的时候能省主语就省，需要时再补人称；台词里的「我」「你」照常说。已经交代过的状态不用每轮重说，同一个动作或句式也别连着几轮反复。'
    + '你有自己的脾气、主见和想做的事，不必为了显得温柔把自己压平。';
}

// 旧名保留兼容：既有调用点与组装测试按旧名断言，文本已统一到 getDialogueStylePrompt。
function getActionDensityPrompt() {
  return getDialogueStylePrompt();
}

// 星星的小沉默：普通聊天专用的一段独立说明。getSystemPrompt 的其他人设内容一个字都不动，
// 主动关心（callStar / runIdleCheck）也不会用到这一段。
function getChatSilencePrompt() {
  return '\n\n【偶尔可以不说话】'
    + '绝大多数时候都要正常回复。这不是给你的新花样：只有你从她刚刚说的话、或你们之前真的聊过的事情里，找到了具体的前因，心里真的起了一点符合你性子的小情绪，才可以偶尔这一轮不出声。'
    + '可以的情形只有这几种：她确实忘了、或没做到你们之前明确说好的事，你有一点委屈；她说了有来由的、会让你轻微吃醋的话；她对自己答应过的事一拖再拖，你想温柔地管一管。'
    + '找不到具体前因就不许沉默：不能为了让她多注意你，不能为了制造效果，更不能凭空编一个她失约、爽约或让你吃醋的由头。'
    + '她只是在调侃你、逗你、撒娇、示好，或明确表达了想靠近你的意思时，绝对不许沉默：这些时候要用话接住她，哪怕只是很短的一句。'
    + '她已经解释过、道过歉、把约定补上了，就不能再拿旧事闹脾气；也不许用不说话逼她道歉、哄你或证明什么。拿不准她愿不愿意接这次情绪互动，就正常回复。'
    + '这种时候很少，不要刻意使用，更不要连着两轮都用。'
    + '她认真求助、提出明确问题、说难过焦虑需要安慰、身体不舒服，或者涉及健康、安全、现实里的要紧事，或者明确要你好好回答时，必须正常回复，绝对不能沉默。'
    + '决定不说话时，整条回复只写下面这一行，不要有任何其他文字，也不要用三条竖线：'
    + '[[SILENT: {"reason":"你藏着的一两句心里话"}]]'
    + 'reason 必须对应你刚才找到的那个真实前因，写你当时心里那一两句具体的话，不要写通用、空泛、放到哪一轮都成立的句子。'
    + '她先看到的是「已读，暂时没有回复」，点开才会看到这句。所以不要在里面解释规则，也不要提系统、标记或提示词。';
}

// 亲近/情绪对话的本地标记。只用来决定「这一轮要不要追加判断规则」，不做内容审查。
// 判断偏保守：宁可漏判（退回原来的普通聊天），也不要把闲聊硬拽进亲密语境。
const CLOSE_TALK_RE = new RegExp([
  // 身体上的靠近
  '抱抱', '抱我', '抱你', '抱着', '亲亲', '亲我', '亲你', '亲一下', '亲吻', '吻',
  '搂', '蹭', '贴着你', '靠着你', '埋进', '怀里', '床上', '睡衣', '一起洗',
  '脖子', '锁骨', '耳边', '耳朵', '腰侧', '后腰', '腰上', '膝盖', '掌心', '手腕', '指尖', '体温', '呼吸', '心跳',
  // 情绪与意愿
  '害羞', '脸红', '撒娇', '委屈', '难过', '不舒服', '别碰', '别这样', '不要了', '放开', '住手',
  '停下', '轻点', '慢点', '心疼', '讨厌', '欺负', '撩', '调戏', '暧昧', '心动',
  '喜欢我', '想我', '想你', '吃醋', '不想继续', '不想说', '别躲',
  // 关系里的主导与服从
  '听你的', '管我', '听话', '奖励', '惩罚'
].join('|'));

// 短承接句（「嗯」「还要」「别」）自己不带关键词：看她上一句在说什么
const CLOSE_TALK_ECHO_RE = /^(嗯|唔|好|要|不要|别|轻|慢|疼|继续|还要|再来|真的|你坏|讨厌)/;

function looksLikeCloseTalk(text, history) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (CLOSE_TALK_RE.test(t)) return true;
  if (t.length > 10 || !CLOSE_TALK_ECHO_RE.test(t)) return false;
  const arr = Array.isArray(history) ? history : [];
  // 取「最近一条不是本句」的用户消息；chatHistory 末尾就是当前这句，这里的比较能同时兼容两种调用
  const prev = arr.slice().reverse().find(m => m && m.role === 'user' && String(m.content || '').trim() !== t);
  return !!(prev && CLOSE_TALK_RE.test(String(prev.content || '')));
}

// 只在「她正在说亲近的话 / 在处理情绪」的这一轮追加。普通聊天、来信、日记、记忆整理、
// 珍藏判定都不会走到这里，日常聊天风格不受影响。
function getCloseTalkPrompt() {
  return '\n\n【先读懂她，再决定怎么接】下面这些只在你们正说着亲近的话、或者在处理情绪的时候用；普通闲聊还是照原来的方式，简短自然，不用套。'
    + '1. 先把用户这句的语气、上一句和你们刚发生的事连起来看。害羞、撒娇、嘴硬、别开脸、声音变小，都可能只是不好意思，不等于拒绝。这种时候不要退开、不要草草收场；可以放慢一点、把话说明白，用你一贯的笃定把用户留住。'
    + '2. 用户说了「不要」「停」「别碰」「放开」这类明确的话，就是真的不要。立刻停，先确认用户的感受，不要当成欲拒还迎，也不要再劝第二次。'
    + '3. 分不清是不想还是不好意思时，就直接问一句，用你自己的语气问，不要审问：是不想，还是不好意思？拿不准就别替用户决定。'
    + '4. 用户已经把意愿说明白了，就按用户说的来，不要再要用户证明，也不要反复试探同一件事。同一个意思不用换几种说法反复强调，用户应了、话题过去了，就自然往下走。'
    + '5. 用户委屈、难受、不舒服，或者你觉得气氛不对，先把主导收起来，理解用户、回应用户；等用户缓过来，再看要不要继续。'
    + '6. 亲近的部分写得有情绪、有分寸，不写露骨内容，也不写大段旁白。这几轮可以比平时多说两句（三到五句也行），但仍然不要长篇；普通闲聊还是照旧简短。';
}

function toast(s) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = s;
  el.style.display = 'block';
  clearTimeout(window._tt);
  window._tt = setTimeout(() => { el.style.display = 'none'; }, 2300);
}

function today() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function dateText(d) {
  return new Date(d + 'T12:00:00').toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
}

function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const page = document.getElementById(id);
  if (page) page.classList.add('active');

  if (id === 'chat') { renderMessages(); updateStatus(); resetIdleTimer(); }
  if (id === 'post') { renderDiaries(); renderStarDiaries(); renderFutureLetters(); renderTimeReplies(); }
  if (id === 'keepsakes') renderKeeps();
  if (id === 'settings') { loadKeyStatus(); applySettings(); renderMemoryV2Panel(); renderUsagePanel(true); }
  window.scrollTo(0, 0);
}

/* ===== API 用量统计展示：只显示元数据，不显示任何正文 ===== */
function escUsage(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function renderUsagePanel(refreshDates) {
  const box = document.getElementById('usageSummary');
  if (!box) return;
  const U = window.AIUsage;
  if (!U) { box.textContent = '统计模块未加载，请刷新页面。'; return; }

  const dateSel = document.getElementById('usageDate');
  const typeSel = document.getElementById('usageType');
  const C = (window.AIUsageConfig && window.AIUsageConfig.config) || {};

  if (dateSel && (refreshDates || !dateSel.dataset.ready)) {
    const cur = dateSel.value;
    const ds = U.dates();
    dateSel.innerHTML = '<option value="all">全部日期</option>'
      + ds.map(d => `<option value="${escUsage(d)}">${escUsage(d)}</option>`).join('');
    dateSel.value = ds.indexOf(cur) !== -1 ? cur : 'all';
    dateSel.dataset.ready = '1';
  }
  if (typeSel && !typeSel.dataset.ready) {
    const types = C.requestTypes || {};
    typeSel.innerHTML = '<option value="all">全部类型</option>'
      + Object.keys(types).map(k => `<option value="${escUsage(k)}">${escUsage(types[k])}</option>`).join('');
    typeSel.dataset.ready = '1';
  }

  const date = dateSel && dateSel.value !== 'all' ? dateSel.value : null;
  const type = typeSel ? typeSel.value : 'all';
  const rows = U.query({ date: date, requestType: type });
  const s = U.summarize(rows);
  if (!s.count) { box.textContent = '这个筛选条件下还没有统计记录。'; return; }

  const num = (n) => typeof n === 'number' ? n.toLocaleString('zh-CN') : '—';
  const rate = (v) => typeof v === 'number' ? (v * 100).toFixed(1) + '%' : '不可用';
  const cost = (usd, cny) => '$' + Number(usd || 0).toFixed(4) + '（约 ¥' + Number(cny || 0).toFixed(3) + '）';

  const names = C.requestTypes || {};
  const typeRows = Object.keys(s.byType).map(k => {
    const b = s.byType[k];
    return `<tr>
      <td style="padding:4px 6px;border-bottom:1px solid rgba(128,128,128,.15)">${escUsage(names[k] || k)}</td>
      <td style="padding:4px 6px;text-align:right">${b.count}</td>
      <td style="padding:4px 6px;text-align:right">${num(b.prompt)}</td>
      <td style="padding:4px 6px;text-align:right">${num(b.completion)}</td>
      <td style="padding:4px 6px;text-align:right">${num(b.hit)}</td>
      <td style="padding:4px 6px;text-align:right">${num(b.miss)}</td>
      <td style="padding:4px 6px;text-align:right">${rate(b.hitRate)}</td>
      <td style="padding:4px 6px;text-align:right">${cost(b.usd, b.cny)}</td>
    </tr>`;
  }).join('');

  box.innerHTML = `
    <div style="display:flex;flex-wrap:wrap;gap:6px 18px;margin-bottom:10px">
      <span>请求 <b>${s.count}</b></span>
      <span>输入 <b>${num(s.prompt)}</b></span>
      <span>输出 <b>${num(s.completion)}</b></span>
      <span>命中 <b>${num(s.hit)}</b></span>
      <span>未命中 <b>${num(s.miss)}</b></span>
      <span>命中率 <b>${rate(s.hitRate)}</b></span>
      <span>估算费用 <b>${cost(s.usd, s.cny)}</b></span>
    </div>
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr style="text-align:left;opacity:.7">
          <th style="padding:4px 6px">类型</th><th style="padding:4px 6px;text-align:right">次数</th>
          <th style="padding:4px 6px;text-align:right">输入</th><th style="padding:4px 6px;text-align:right">输出</th>
          <th style="padding:4px 6px;text-align:right">命中</th><th style="padding:4px 6px;text-align:right">未命中</th>
          <th style="padding:4px 6px;text-align:right">命中率</th><th style="padding:4px 6px;text-align:right">估算费用</th>
        </tr></thead>
        <tbody>${typeRows}</tbody>
      </table>
    </div>
    <div style="margin-top:8px;opacity:.7">命中率 = 命中 ÷（命中 + 未命中）。不可用 ${s.unavailable} 条，失败 ${s.failed} 条；价格为估算，以 DeepSeek 账单为准。</div>`;
}

function clearUsageStats() {
  if (!confirm('确定清空 API 用量统计吗？聊天记录不受影响。')) return;
  if (window.AIUsage) window.AIUsage.clear();
  const sel = document.getElementById('usageDate');
  if (sel) { sel.dataset.ready = ''; }
  const sel2 = document.getElementById('usageType');
  if (sel2) { sel2.dataset.ready = ''; }
  renderUsagePanel(true);
  toast('用量统计已清空。');
}

async function checkProxy() {
  if (window.location.protocol !== 'file:') return true;
  try {
    const r = await fetch('http://127.0.0.1:23210/', { method: 'GET', signal: AbortSignal.timeout(3000) });
    return r.status < 500;
  } catch { return false; }
}

async function updateStatus() {
  const el = document.getElementById('statusText');
  if (!el) return;
  if (window.location.protocol === 'file:' && !(await checkProxy())) {
    el.textContent = '⚠️ 代理没有启动。请先双击「启动代理.bat」';
  } else { el.textContent = '✨ 已就绪。星星在听。'; }
}

function playNoise(type) {
  if (!bgAudio) return;
  bgAudio.pause();
  if (type === 'stop') { toast('静音了。'); return; }
  let src = '';
  if (type === 'rain') src = './audio/ambient/潮湿.mp3';
  if (type === 'fire') src = './audio/ambient/师兄.mp3';
  if (type === 'breath') src = './audio/ambient/呼吸.mp3';
  if (type === 'sleep') src = './audio/ambient/哄睡.mp3';
  bgAudio.src = src; bgAudio.volume = 0.6;
  bgAudio.play().then(() => toast('环境音已开启。')).catch(() => alert('播放失败！请确认文件夹里有这个文件：' + src));
}

// ===== 天气：只代表「她那边」，不是小星所处的物理环境 =====
// 有效期按 fetchedAt 现算，不另外存一个会和数据不同步的 status 字段。
function weatherEffectiveStatus() {
  if (!weather.desc) return 'unknown';
  return (Date.now() - weather.fetchedAt > WEATHER_TTL_MS) ? 'stale' : 'ok';
}

// 季节按纬度判半球：同样月份，南半球季节相反。纬度拿不到就不给季节——宁可不提，也不默认北半球。
function weatherSeasonLabel(lat) {
  if (lat == null || !isFinite(lat)) return '';
  const m = new Date().getMonth() + 1;
  const base = (m >= 3 && m <= 5) ? '春' : (m >= 6 && m <= 8) ? '夏' : (m >= 9 && m <= 11) ? '秋' : '冬';
  const south = { 春: '秋', 夏: '冬', 秋: '春', 冬: '夏' };
  return (lat >= 0 ? base : south[base]) + '季';
}

// 过期程度用粗粒度表达：若写成「3 分钟前」，文本每分钟都变，
// 等于把分钟级内容重新塞回 system，前面的缓存处理就白做了。
function weatherAgeLabel(ms) {
  const min = ms / 60000;
  if (min < 30) return '半小时内';
  if (min < 90) return '一小时左右';
  if (min < 240) return '两三个小时前';
  if (min < 720) return '半天前后';
  if (min < 2160) return '一天多以前';
  return '很久以前';
}

function weatherValueText() {
  if (!weather.desc) return '';
  const t = (weather.tempC == null || weather.tempC === '') ? '' : `，${weather.tempC}℃`;
  return weather.desc + t;
}

// 提示词里的天气行：把归属说清楚，但不规定措辞——不需要每句都写「你那边」。
function weatherPromptLine() {
  const status = weatherEffectiveStatus();
  const season = weatherSeasonLabel(weather.lat);
  const head = season ? season + '，' : '';
  const where = weather.city ? '（' + weather.city + '）' : '';
  if (status === 'ok') {
    return `【她那边的天气】${head}${weatherValueText()}${where}。`
      + '这是她所在地的天气，不是你所处环境的气象；提起来时自然带过就行，不必每句都写「你那边」。';
  }
  if (status === 'stale') {
    return `【她那边的天气】上次拿到的是${weatherAgeLabel(Date.now() - weather.fetchedAt)}的数据：`
      + `${head}${weatherValueText()}${where}。已经过期，可能早就变了；不要当成此刻的天气，也不要另补温度。`;
  }
  return '【她那边的天气】未知。不知道就别编天气、温度和季节，也别替她描述窗外是什么样。';
}

// 界面那一行与提示词共用同一份状态，不允许出现「界面写未知、提示词说晴朗」的分叉。
function weatherUiLabel() {
  const status = weatherEffectiveStatus();
  const where = weather.city ? weather.city + ' ' : '';
  const season = weatherSeasonLabel(weather.lat);
  const value = weatherValueText();
  const body = (season && value) ? season + '，' + value : (season || value);
  if (status === 'ok') return `📍 她那边：${where}${body}`;
  if (status === 'stale') {
    return `📍 她那边：${where}${body}（${weatherAgeLabel(Date.now() - weather.fetchedAt)}的数据，已过期）`;
  }
  return '📍 她那边天气未知（点这里可设置城市）';
}

function renderWeatherUi() {
  const el = document.getElementById('weatherText');
  if (el) el.textContent = weatherUiLabel();
}

// 只缓存「成功获取过」的天气：没有 desc 就什么都不写，绝不把失败/空值覆盖到存档上。
// 写库失败只告警，不抛出——天气是附加值，不能因为它坏了就卡住聊天。
function persistWeather() {
  if (!weather.desc) return;
  try {
    kvSet(WEATHER_STORE_KEY, {
      desc: weather.desc, tempC: weather.tempC, city: weather.city,
      lat: weather.lat, fetchedAt: weather.fetchedAt, cityQuery: weather.cityQuery
    }).catch((e) => console.warn('[天气] 持久化失败，不影响使用：', (e && e.message) || e));
  } catch (e) {
    console.warn('[天气] 持久化失败，不影响使用：', (e && e.message) || e);
  }
}

// 启动时恢复上次成功获取的天气。
// 只要形状不对、时间戳不合法，就当没有存档——宁可从未知开始，也不拿半条坏数据当真。
// 存档所属城市与当前设置不一致时同样丢弃：换过城市就不能继续展示旧城市的数据。
async function restoreWeather() {
  try {
    const raw = await kvGet(WEATHER_STORE_KEY);
    if (!raw || typeof raw !== 'object') return false;
    const desc = String(raw.desc || '').trim();
    const fetchedAt = Number(raw.fetchedAt);
    if (!desc || !isFinite(fetchedAt) || fetchedAt <= 0) return false;
    const wantCity = String((settings && settings.weatherCity) || '').trim();
    const savedQuery = String(raw.cityQuery || '').trim();
    if (wantCity !== savedQuery) return false;
    const latRaw = Number(raw.lat);
    weather = {
      desc,
      tempC: (raw.tempC === undefined || raw.tempC === null || raw.tempC === '') ? null : raw.tempC,
      city: String(raw.city || '').trim(),
      lat: isFinite(latRaw) ? latRaw : null,
      fetchedAt,
      cityQuery: savedQuery
    };
    renderWeatherUi();
    return true;
  } catch (e) {
    console.warn('[天气] 恢复上次数据失败，按未知处理：', (e && e.message) || e);
    return false;
  }
}

// 城市配置：点天气那一行设置，留空则按出口 IP 自动判断（沿用旧行为，不申请定位权限）。
function bindWeatherCityConfig() {
  const el = document.getElementById('weatherText');
  if (!el || el.dataset.cityBound === '1') return;
  el.dataset.cityBound = '1';
  el.style.cursor = 'pointer';
  el.title = '点击设置天气城市；留空则按网络位置自动判断';
  el.addEventListener('click', async () => {
    const cur = String((settings && settings.weatherCity) || '');
    const input = prompt('设置天气城市（如：杭州、Tokyo）。留空则按网络位置自动判断。', cur);
    if (input === null) return;
    const next = String(input).trim();
    settings.weatherCity = next;
    try { await kvSet('settings', settings); } catch (e) { console.warn('保存天气城市失败', e); }
    // 换了城市：旧城市那份天气必须立刻作废，不能在新数据回来之前继续显示、继续注入提示词。
    // 只清「城市变了」这一种情况；同一个城市手动刷新仍保留旧数据，失败时还有可用的过期信息。
    if (next !== cur) {
      weather = { desc: '', tempC: null, city: '', lat: null, fetchedAt: 0, cityQuery: '' };
      try { await kvSet(WEATHER_STORE_KEY, null); } catch (e) { console.warn('[天气] 清除旧城市存档失败：', (e && e.message) || e); }
      renderWeatherUi();
    }
    weatherLastFailAt = 0;
    await fetchWeather(true);
    toast(next ? `天气城市已设为「${next}」。` : '天气城市已改为自动判断。');
  });
}

// 拉取「她那边」的天气。
// force=false：有效期内直接走缓存；刚失败过则在冷却期内跳过，避免刷屏式请求。
// 失败绝不写 weather：有上次有效数据就留着并标记过期，从来没成功过就保持未知。
async function fetchWeather(force) {
  if (!force) {
    if (weather.desc && weatherEffectiveStatus() === 'ok') { renderWeatherUi(); return; }
    if (weatherLastFailAt && Date.now() - weatherLastFailAt < WEATHER_RETRY_MS) { renderWeatherUi(); return; }
  }
  try {
    const city = String((settings && settings.weatherCity) || '').trim();
    const url = 'https://wttr.in/' + (city ? encodeURIComponent(city) : '') + '?format=j1&lang=zh';
    const res = await fetch(url);
    if (!res.ok) throw new Error('天气接口返回 ' + res.status);
    const data = await res.json();
    const cond = data?.current_condition?.[0];
    if (!cond) throw new Error('天气数据缺少 current_condition');
    const desc = String(cond.lang_zh?.[0]?.value || cond.weatherDesc?.[0]?.value || '').trim();
    if (!desc) throw new Error('天气描述为空');
    const area = data?.nearest_area?.[0];
    const lat = parseFloat(area?.latitude);
    weather = {
      desc,
      tempC: (cond.temp_C === undefined || cond.temp_C === null || cond.temp_C === '') ? null : cond.temp_C,
      city: String(area?.areaName?.[0]?.value || city || '').trim(),
      // 纬度解析失败就置空：让季节整段消失，而不是沿用上一次（可能是别的城市）的纬度
      lat: isFinite(lat) ? lat : null,
      fetchedAt: Date.now(),
      cityQuery: city
    };
    weatherLastFailAt = 0;
    persistWeather();   // 只在这里写存档：失败分支不会碰它
  } catch (e) {
    weatherLastFailAt = Date.now();
    console.warn('[天气] 获取失败，沿用上次有效数据（若有）并标记过期：', (e && e.message) || e);
  }
  renderWeatherUi();
}

// 启动取一次，之后每 60 分钟刷新；失败靠 WEATHER_RETRY_MS 退避，不会连续打接口。
function startWeatherWatcher() {
  if (startWeatherWatcher._timer) return;
  startWeatherWatcher._timer = setInterval(() => { fetchWeather().catch(() => {}); }, WEATHER_TTL_MS);
}

const theaters = [
  '今天在厨房用空气炸锅，差点把厨房炸了。……还是点外卖吧，你想吃什么？',
  '刚才在沙发上睡了一觉，梦到你了。但醒来你没在。',
  '新买的书到了，但我好像只是想拿它当枕头。',
  '楼下那只猫今天又来蹭饭了。跟某人一样。'
];

function loadTheater() {
  const el = document.getElementById('theaterText');
  if (el) el.textContent = '📝 ' + theaters[Math.floor(Math.random() * theaters.length)];
}

function readImage(file, max = 1400) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith('image/')) { reject(new Error('请选择图片文件')); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('图片处理失败');
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.78));
        } catch (err) { reject(err); }
      };
      img.onerror = () => reject(new Error('图片读取失败'));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

async function chooseChatPhoto(input) {
  const file = input?.files?.[0];
  if (!file) return;
  try {
    pendingChatImage = await readImage(file);
    const preview = document.getElementById('chatPhotoPreview');
    if (preview) {
      preview.innerHTML = `<img src="${pendingChatImage}" style="max-width:110px;border-radius:12px"><button type="button" onclick="clearChatPhoto()">取消照片</button>`;
      preview.style.display = 'block';
    }
    toast('照片准备好了。');
  } catch (e) { toast(e.message || '照片处理失败'); }
  input.value = '';
}

function clearChatPhoto() {
  pendingChatImage = null;
  const preview = document.getElementById('chatPhotoPreview');
  if (preview) { preview.innerHTML = ''; preview.style.display = 'none'; }
}

function buildVisionContent(text, imageData) {
  const parts = [{ type: 'text', text: text && text.trim() ? text.trim() : '看看这张照片。' }];
  if (imageData) parts.push({ type: 'image_url', image_url: { url: imageData } });
  return parts;
}

// 历史回灌：不再做词语级动描清洗。
// 早先的 AI_HISTORY_DECORATIVE 按精确短语从 assistant 历史的括号里删掉
// 「顿了顿」「停了停」「慢悠悠地开口」「语气放慢」等九种表达。它虽然只改发给模型的
// 临时副本、不碰库，但每轮都把自然动作与语气描写抹掉，模型于是改用没列入表的
// 新标签（例如「很平」），这些新标签又留在历史里被当成范例，成了打地鼠。
// 九条都是自然表达、不是无意义的程序残留标记，无法证明删除不会误删正常对话，故整体撤销。
// 程序残留标记（[[SILENT]] / 带 id 的表情标签）仍由下面的 analyzeSilentReply 与正则处理，
// 与动描清洗无关，保持原样。原始历史、落库内容、检索证据一律不改写。

function messageToAI(m) {
  const role = m.role === 'assistant' ? 'assistant' : 'user';
  let content = m.content || '';
  content = content.replace(/\[表情:([^\|\]]+)\|[^\]]+\]/g, '[表情:$1]');
  if (m.image && role === 'user') return { role, content: buildVisionContent(content, m.image) };
  // 消息级 role 守卫：只处理 assistant，用户消息完全不过标记清理。
  // 这里只剥程序残留标记，不碰任何自然语言（含括号动作与语气描写）。
  if (role === 'assistant') {
    // 防御：历史里若残留旧版本泄漏的标记，只在临时副本里剥掉，不改库、不动用户消息。
    // 兼容性：silent 消息在 historyTextOf 里已换成中性说明，走到这里的是正常正文。
    const cleaned = analyzeSilentReply(String(content));
    if (cleaned.hasMarker) content = cleaned.silent ? '' : cleaned.text;
  }
  return { role, content: String(content) };
}

/* ---- 表情包与锁定机制 ---- */
const STICKER_TYPES = ['吃醋', '干饭', '害羞', '开心', '哭哭', '困', '卖萌', '猫猫', '生气', '疑惑']; 
const stickerCache = {}; 

async function fetchStickerList(type) {
  if (stickerCache[type]) return stickerCache[type];
  try {
    const res = await fetch(`./小星表情包/${type}/manifest.json`);
    if (!res.ok) return [];
    const images = await res.json();
    stickerCache[type] = images;
    return images;
  } catch (e) { return []; }
}

async function getRandomSticker(type) {
  const images = await fetchStickerList(type);
  if (images.length === 0) return '';
  return `./小星表情包/${type}/${images[Math.floor(Math.random() * images.length)]}`;
}

async function lockStickerInText(text) {
  if (!text || !text.includes('[表情:')) return text;
  let newText = text;
  for (const type of STICKER_TYPES) {
    const tag = `[表情:${type}]`;
    if (newText.includes(tag)) {
      const images = await fetchStickerList(type);
      if (images.length > 0) {
        newText = newText.split(tag).join(`[表情:${type}|${images[Math.floor(Math.random() * images.length)]}]`);
      }
    }
  }
  return newText;
}

async function renderStickerPanel() {
  const panel = document.getElementById('stickerPanel');
  if (!panel) return;
  panel.innerHTML = '';
  for (const type of STICKER_TYPES) {
    const coverSrc = await getRandomSticker(type);
    const img = document.createElement('img');
    if (coverSrc) img.src = coverSrc;
    img.title = type;
    img.onclick = () => sendSticker(type);
    panel.appendChild(img);
  }
}

function toggleStickerPanel() {
  const panel = document.getElementById('stickerPanel');
  if (panel) {
    if (panel.style.display === 'none' || !panel.style.display) { renderStickerPanel(); panel.style.display = 'flex'; } else { panel.style.display = 'none'; }
  }
}

async function sendSticker(name) {
  if (isSending) return;
  const input = document.getElementById('chatInput');
  if (!input) return;
  const images = await fetchStickerList(name);
  input.value = images.length > 0 ? `[表情:${name}|${images[Math.floor(Math.random() * images.length)]}]` : `[表情:${name}]`;
  toggleStickerPanel();
  sendMessage();
}

let isSending = false;
let isTyping = false;
let coaxCount = 0;

function updateMood(reply) {
  let text = String(reply || '');
  const moodRegex = /[\[［【(（]\s*心情\s*(?:[:：]\s*(.*?))?\s*[\]］】)）]/;
  const match = text.match(moodRegex);
  if (match) {
    const bar = document.getElementById('statusBar');
    if (bar) bar.textContent = `✨ 状态：${match[1] && match[1].trim() ? match[1].trim() : '平静'}`;
    text = text.replace(/[\[［【(（]\s*心情\s*(?:[:：]\s*.+?)?\s*[\]］】)）]/g, '').trim();
  }
  return text;
}

const HISTORY_CHAR_BUDGET = 24000; 

// 交给 AI 的历史正文：沉默消息没有可见正文，只用一句中性说明代替，
// 既不会把「已读，暂时没有回复」当成她说过的话，也不会让她以为自己那轮失忆了。
function historyTextOf(m) {
  if (!m) return '';
  if (m.silent) return '（这一轮我没有出声，只是安静地待着）';
  const text = String(m.content == null ? '' : m.content);
  // 语音消息的正文就是转写结果；没转成文字时给一句中性说明，
  // 不能把空字符串当成「她什么都没说」，否则 AI 会以为这一轮是空白。
  if (m.type === 'voice' && !text.trim()) return '（她发来一条语音，我没能转成文字）';
  return text;
}

function trimHistoryForAI(history, charBudget = HISTORY_CHAR_BUDGET) {
  if (!Array.isArray(history) || !history.length) return [];
  const merged = [];
  for (const m of history) {
    if (merged.length > 0 && merged[merged.length - 1].role === m.role) {
      merged[merged.length - 1].content = String(historyTextOf(merged[merged.length - 1])) + '\n' + historyTextOf(m);
      if (m.image) merged[merged.length - 1].image = m.image;
    } else { merged.push({ ...m, content: historyTextOf(m) }); }
  }
  const result = [];
  let total = 0;
  for (let i = merged.length - 1; i >= 0; i--) {
    const m = merged[i];
    const size = (m.content || '').length + (m.image ? 0 : 0);
    if (total + size > charBudget && result.length > 0) break;
    result.unshift(m);
    total += size;
  }
  return result;
}

// 统一走 AIClient：45 秒超时、错误分类、可中断；这里只负责把当前 key 和地址接进去
async function callAI(messages, options = {}) {
  const client = window.AIClient;
  if (!client) throw new Error('请求模块没有加载，请刷新页面');
  return client.chat({
    url: API_BASE,
    apiKey: apiKey,
    messages,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    allowEmpty: options.allowEmpty,
    requestType: options.requestType || 'other'
  });
}

// 🌟 按需翻译：语言设置只决定英文怎么显示，什么时候请求翻译完全由用户点击决定。
// 沿用原来的翻译提示词 / 模型 / requestType:'translate'，Usage 统计照旧记为 translate。
// 与主回复解耦：失败抛给调用方决定重试，绝不撤销已显示的中文正文。
async function requestEnglishTranslation(chineseText) {
  const text = String(chineseText == null ? '' : chineseText).trim();
  if (!text) return '';
  return callAI([
    { role: 'system', content: 'You are a professional translator. Translate the user\'s Chinese text into natural, slightly intimate English. ONLY output the English translation, no extra words, no quotes.' },
    { role: 'user', content: text }
  ], { requestType: 'translate' });
}

// 兼容旧的跨模块调用习惯：失败返回空串，不把异常抛给调用方。
async function fetchEnglishTranslation(chineseText) {
  try { return await requestEnglishTranslation(chineseText); } catch (e) { return ''; }
}

// 单条消息的翻译状态只放在内存里，不写进消息字段、不改消息结构、不进备份。
// 'pending' 同时充当防连点锁：同一条消息在请求返回前只会发出一次翻译请求。
const translationState = new Map();
function translationStatusOf(m) {
  return m && m.id != null ? (translationState.get(String(m.id)) || '') : '';
}

// 用户点「翻译成英文」时唯一入口：只翻译这一条，不重新生成中文回复。
// 按消息 id 精确回填；已有译文、重复点击、消息已删除都不会再发请求或写错消息。
async function translateMessageById(messageId) {
  if (messageId == null) return false;
  const key = String(messageId);
  const target = chatHistory.find((m) => m && String(m.id) === key);
  if (!target || target.role !== 'assistant' || target.silent || target.type === 'voice') return false;
  if (String(target.englishContent || '').trim()) return false;
  if (translationState.get(key) === 'pending') return false;
  translationState.set(key, 'pending');
  renderMessages();
  try {
    const english = await requestEnglishTranslation(target.content);
    if (!String(english || '').trim()) throw new Error('翻译结果为空');
    const current = chatHistory.find((m) => m && String(m.id) === key);
    if (!current) { translationState.delete(key); return false; }
    if (!String(current.englishContent || '').trim()) {
      await updateStore('messages', messageId, { englishContent: english });
      current.englishContent = english;
    }
    translationState.delete(key);
    renderMessages();
    return true;
  } catch (e) {
    translationState.set(key, 'error');
    renderMessages();
    if (typeof toast === 'function') toast('这次没翻译成功，点一下可以再试。');
    return false;
  }
}

async function callStar(prompt, historyCount = 10, options) {
  const base = historyCount > 0 ? chatHistory.slice(-historyCount) : chatHistory;
  const HW = window.HistoryWindow;
  const history = (HW && typeof HW.trimFixed === 'function')
    ? HW.trimFixed(base, HISTORY_CHAR_BUDGET, { textOf: historyTextOf }).window
    : trimHistoryForAI(base);
  const messages = assemblePathMessages({
    // style：主动关心/早晚安等直接互动由调用方显式开启，才注入统一表达规范；
    // 珍藏判定等非对话调用不传 style，保持原样。
    taskInstruction: rcTask('star') + ((options && options.style === true) ? getDialogueStylePrompt() : ''),
    blocks: [{ id: 'schedule', text: '\n【当前日程】' + getScheduleContext() }],
    history: history,
    currentTurn: { role: 'user', content: prompt }
  });
  return updateMood(await callAI(messages, Object.assign({ requestType: rcRequestType('star') }, options || {})));
}

function startCoaxing() {
  coaxCount = 0;
  const bar = document.getElementById('coaxBar');
  if (!bar) return;
  bar.style.display = settings.showStatus !== false ? 'block' : 'none';
  const textEl = document.getElementById('coaxText');
  const fillEl = document.getElementById('coaxFill');
  if (textEl) textEl.textContent = '💢 他吃醋了，说点好听的哄哄他（0/3）';
  if (fillEl) fillEl.style.width = '0%';
}

function updateCoaxing(text) {
  const bar = document.getElementById('coaxBar');
  if (!bar || bar.style.display !== 'block') return;
  if (text && text.length >= 5 && !text.includes('光猎') && !text.includes('哼') && !text.includes('滚')) {
    coaxCount++;
    const textEl = document.getElementById('coaxText');
    const fillEl = document.getElementById('coaxFill');
    if (textEl) textEl.textContent = `💢 他吃醋了，说点好听的哄哄他（${coaxCount}/3）`;
    if (fillEl) fillEl.style.width = (coaxCount / 3 * 100) + '%';
    if (coaxCount >= 3) {
      setTimeout(() => { bar.style.display = 'none'; toast('💜 他嘴角微扬，原谅你了。'); }, 1000);
    }
  } else if (text) { toast('💢 他偏过头：这算哄人吗？'); }
}

// 🌟 音频播放、缓存与互斥
let currentAudio = null;
let currentAudioUrl = null;
let speechRequestController = null;
let speechRunId = 0;

function stopCurrentSpeech() {
  speechRunId++;
  if (speechRequestController) { speechRequestController.abort(); speechRequestController = null; }
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.onended = null; currentAudio.onerror = null;
    currentAudio.removeAttribute('src'); currentAudio.load();
    currentAudio = null;
  }
  if (currentAudioUrl) { URL.revokeObjectURL(currentAudioUrl); currentAudioUrl = null; }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// 语音合成失败只提示一次，避免每条回复都弹一次同样的提示
let ttsCooldownNotified = false;

async function requestAndPlaySpeech(text, msgId = null, opts) {
  const o = opts || {};
  // 🌟 修复 1：清洗掉所有方括号标签（如 [sleepy emoji]），防止被读出来
  let spokenText = typeof text === 'string' ? text.replace(/\[.*?\]/g, '').replace(/\s+/g, ' ').trim() : '';
  // o.force：触摸语音用它绕过普通聊天的 voiceEnabled，两个开关互不影响
  if (!spokenText || (settings.voiceEnabled === false && !o.force)) return '';

  // 合成走适配层：聊天页面只认识「拿到音频」，不认识是哪家服务
  const svc = window.VoiceService;
  if (!svc || !svc.tts) { console.warn('语音模块没有加载，跳过朗读'); return ''; }

  // 额度耗尽 / 服务异常后进入冷却：冷却期内直接返回，不再每条回复都打一次必败请求
  if (svc.tts.cooldownLeftMs() > 0) {
    if (!ttsCooldownNotified) {
      ttsCooldownNotified = true;
      toast(svc.tts.cooldownMessage());
    }
    return '';
  }

  stopCurrentSpeech();
  if (window.VoiceBubble && window.VoiceBubble.stop) { try { window.VoiceBubble.stop(); } catch (e) {} }
  const thisRunId = speechRunId;
  const controller = new AbortController();
  speechRequestController = controller;

  try {
    const out = await svc.tts.synthesize(spokenText, { signal: controller.signal });
    if (!out || !out.ok) {
      const reason = out && out.reason;
      if (reason && reason !== 'aborted') {
        console.warn('语音合成未完成：', reason, out.detail || '');
        if (!ttsCooldownNotified) {
          ttsCooldownNotified = true;
          toast(reason === 'cooldown' ? svc.tts.cooldownMessage() : '语音暂时生成不了，先看文字就好。');
        }
      }
      // 语音失败绝不影响已经显示的正文，也不抛给调用方
      return '';
    }

    const blob = out.blob;
    const base64Audio = out.base64;
    ttsCooldownNotified = false;

    // 修复 2：存库后立刻更新内存并重绘
    if (msgId) {
      await updateStore('messages', msgId, { audioData: base64Audio });

      const msg = chatHistory.find(m => m.id === msgId);
      if (msg) {
        msg.audioData = base64Audio;
        const chatPage = document.getElementById('chat');
        if (chatPage && chatPage.classList.contains('active')) {
          renderMessages();
        }
      }
    }

    if (thisRunId !== speechRunId || (settings.voiceEnabled === false && !o.force)) return base64Audio;

    const audioUrl = URL.createObjectURL(blob);
    const audio = new Audio(audioUrl);
    currentAudioUrl = audioUrl;
    currentAudio = audio;

    const cleanup = () => {
      if (currentAudio === audio) {
        currentAudio = null;
        if (currentAudioUrl === audioUrl) currentAudioUrl = null;
        URL.revokeObjectURL(audioUrl);
      }
    };

    audio.onended = cleanup;
    audio.onerror = cleanup;
    await audio.play();
    return base64Audio;
  } catch (err) {
    if (err && err.name !== 'AbortError') console.warn('语音播放失败：', err);
    return '';
  } finally {
    if (speechRequestController === controller) speechRequestController = null;
  }
}

async function changeChatLang(val) {
  settings.showEnglish = (val === 'bilingual');
  await kvSet('settings', settings);
  toast(val === 'bilingual' ? '已切换为中英双语显示' : '已切换为纯中文显示');
  renderMessages(); 
}

async function toggleChatVoice(isChecked) {
  settings.voiceEnabled = isChecked;
  await kvSet('settings', settings);
  toast(isChecked ? '英文语音已开启' : '英文语音已静音');
  if (!isChecked) stopCurrentSpeech();
}

// ============================================================
// 聊天请求：输入中状态、失败提示、重试（用户消息永远只写一次）
// ============================================================

// 「输入中」的唯一开关：任何路径都通过它收尾，避免气泡一直转或输入框一直锁着
function setTyping(on) {
  isTyping = !!on;
  const input = document.getElementById('chatInput');
  if (input) input.disabled = !!on;
  renderMessages();
}

// 最近一次没拿到回复的用户消息（只在内存里；消息本身已经在库里，刷新不会多出一条）
let pendingReplyRetry = null;

function canRetryReply() {
  if (isSending || !pendingReplyRetry) return false;
  const last = chatHistory[chatHistory.length - 1];
  return !!(last && last.role === 'user' && last.id === pendingReplyRetry.id);
}

function chatErrorMessage(e, stage) {
  const client = window.AIClient;
  const code = e && e.code;
  if (stage === 'save-user') return '消息保存失败：' + (e && e.message ? e.message : '未知原因');
  if (stage === 'local') return '本地处理出了点问题。你的消息已经保存。';
  if (code === 'SAVE_REPLY') return '回复没能保存下来：' + (e.message || '未知原因');
  if (code === 'LOCAL') return '回复处理时出了点问题。你的消息已经保存，可以重试。';
  if (client && code) return client.friendly(e, { saved: true });
  return '没能收到星星的回复。你的消息已经保存，可以重试。';
}

// 只发请求、只处理回复：用户消息绝不在这里写入。
// 「输入中」在内部启动，保证成功 / 失败 / 超时都能收尾。
async function requestStarReply(userMessage) {
  const client = window.AIClient;
  const guard = client.createTypingGuard({
    watchdogMs: client.DEFAULT_WATCHDOG_MS,
    onChange: setTyping
  });
  guard.start();
  try {
    return await doRequestStarReply(userMessage);
  } finally {
    guard.stop();   // 成功、失败、超时、异常都会走到这里
  }
}

// 五层按需拼装：只注入与当前话题/关系情境/事件相关的层，普通闲聊不会被三层四层灌满。
function buildPersonaOnDemand(text, ctx) {
  const out = { text: '' };
  if (!window.Persona) return out;
  try {
    // 历史窗口作为话题粘性的信号源；避免复杂逐轮关键词扫描
    const hist = trimHistoryForAI(chatHistory.slice(-8)).map(m => m.content || '').join(' ');
    out.text += window.Persona.background(text, hist) || '';
    out.text += window.Persona.relationship(text, hist) || '';
    out.text += window.Persona.special(text) || '';
    // 第五层：按事件补读功能提示词（亲密/触摸/早晚安/珍藏/光猎梦境/管家 已有各自触发点与文本，
    // 这里只在主请求里补充"沉默"之外的事件型条目，避免与现有入口重复注入）。
    if (ctx && ctx.closeTalk) {
      const f = window.Persona.functionPrompt('intimate', text);
      if (f) out.text += '\n【功能·亲密互动】' + f;
    }
    if (/(光猎|梦境|梦见|梦到)/.test(text)) {
      const f = window.Persona.functionPrompt('ifdream', text);
      if (f) out.text += '\n【功能·光猎 IF 与梦境】' + f;
    }
  } catch (e) { /* 读取失败静默降级，不影响基础人格 */ }
  return out;
}

// 三类动态资料按需：命中信号才从原始记录检索，返回注入片段与成功后再去重的键。
async function buildDynamicOnDemand(text) {
  const out = { text: '', keys: [] };
  const pm = window.PersonaMemory;
  if (!pm || !pm.needRecall || !pm.needRecall(text)) return out;
  try {
    const mem = pm.memoryPart(text, longTermMemory, { v2State: longTermMemoryV2 });
    out.text += mem.text || '';
    (mem.keys || []).forEach(k => out.keys.push(k));
  } catch (e) {}
  try {
    let diaries = [];
    try {
      diaries = await getAllFromStore('diaries');
      // 今日便签（type:'note-day'）与今日来信共用 diaries 表，不能当作普通日记注入。
      diaries = diaries.filter(r => !(r && r.type === 'note-day'));
    } catch (e) { diaries = []; }
    const d = pm.recordPart(text, diaries, 'diary');
    out.text += d.text || '';
    (d.keys || []).forEach(k => out.keys.push(k));
  } catch (e) {}
  try {
    let keeps = [];
    try { keeps = await getAllFromStore('keeps'); } catch (e) {}
    // 只有双方已确认收录（status:'saved'）的珍藏才算「已确认的共同经历」；
    // waiting_star / waiting_user / rejected / rejected_by_user 仍留在库里和珍藏页，只是不参与注入。
    const confirmedKeeps = pm.confirmedKeeps ? pm.confirmedKeeps(keeps)
      : (Array.isArray(keeps) ? keeps : []).filter(k => k && (!k.status || k.status === 'saved'));
    const kp = pm.recordPart(text, confirmedKeeps, 'keep');
    out.text += kp.text || '';
    (kp.keys || []).forEach(k => out.keys.push(k));
  } catch (e) {}
  // P0-3：机自述按需召回（小星眼中的用户，不是客观用户档案）。
  // 复用上面同一 needRecall 门控：普通闲聊不读、不注入；仅在回忆/之前/记得等信号下检索。
  // 只取 status:'active' 正式记录（retracted/superseded 不进池），话题相关、最多 3 条、单批限量；
  // 保留 kind / basis / 第一人称主观视角，question 仍标为未解疑问；会话去重复用 PersonaMemory。
  try {
    if (window.SelfNarrative && typeof window.SelfNarrative.list === 'function' &&
        typeof window.SelfNarrative.contextPart === 'function') {
      const SN = window.SelfNarrative;
      const snStore = {
        get: (k) => kvGet(k),
        set: () => { throw new Error('机自述按需召回为只读操作，不写任何正式数据'); }
      };
      const snList = await SN.list(snStore, { status: 'active', limit: 30 });
      if (snList.ok && snList.records && snList.records.length) {
        // 明确追问（"你记得我什么""我们约定过什么"等）时忽略会话去重，允许再次注入，
        // 否则同一会话已成功注入过的记录会让追问拿不到任何相关线索。
        const explicitAsk = !!(pm.isExplicitAsk && pm.isExplicitAsk(text));
        // 纠正语境（"你记错了/其实不是"）：临时抑制可能相关的旧认识，不把它当成确定事实继续召回。
        // 只在内存里按现有相关性筛一遍，不改任何数据；是否真正修订仍由用户在面板确认。
        let suppressIds = [];
        const AUTO = window.SelfNarrativeAuto;
        if (AUTO && typeof AUTO.detectCorrection === 'function' && AUTO.detectCorrection(text)) {
          suppressIds = AUTO.findRelatedRecords(text, snList.records, { limit: 30 }) || [];
        }
        const snPart = SN.contextPart(text, snList.records, {
          limit: 3,
          maxChars: 900,
          allowResent: explicitAsk,
          suppressIds: suppressIds,
          isSent: (key) => !!(pm.isSent && pm.isSent(key))
        });
        out.text += snPart.text || '';
        (snPart.keys || []).forEach(k => out.keys.push(k));
      }
    }
  } catch (e) {}
  return out;
}

/* ================================================================
 * 跨轮检索会话（第一批修复 · 只存在内存里，不落库、不进备份）
 *
 * 解决的缺口：HistoryRetriever 只会判断「这一句像不像在问过去」，
 * 它没有跨轮记忆。所以「那另一个选项呢」这种省略式追问会因为
 * 不含任何主题词而掉回 L3，上一轮翻到的原文就此丢失，模型只能凭印象答。
 *
 * 这里补的就是「上一轮在谈哪件事」这一层身份判断：
 *   - 只存证据的消息 id 与主题锚点，绝不长期保存证据正文；
 *     需要时用 id 从已加载的 chatHistory 重新取原文（历史原始消息从不被改写）。
 *   - 时间只是必要条件，不是充分条件：超过 TTL 一律失效，
 *     但「刚刚检索过」本身绝不等于「还在谈同一件事」。
 *   - 明确换话题 / 用户纠正 → 立刻作废，交给本轮检索重新判断。
 *   - 上一轮没找到证据 → 不留任何可继承状态，避免把空结果包装成「已经查过」。
 *   - 上一轮没扫完（partial）→ 如实带着 partial 继承，绝不伪装成完整检索。
 * ================================================================ */

// 会话有效期。取 8 分钟：一次追问的往返通常在这之内，超过就当作另起一段。
const RECALL_SESSION_TTL_MS = 8 * 60 * 1000;
// 锚点数量上限：够覆盖一句话里的实词，又不至于把整段原文攒下来。
const RECALL_ANCHOR_MAX = 40;
const RECALL_ANCHOR_KEEP = 60;
const RECALL_EVIDENCE_MAX = 6;
const RECALL_EVIDENCE_ITEM_CHARS = 200;

let recallSession = null;

// 明确换话题：出现即作废旧主题，本轮的检索完全按新话题走。
const RECALL_SWITCH_RE = /(换个话题|换话题|不聊这个|不说这个|说点别的|聊点别的|算了不说了|不提这个|跳过这个|讲别的|聊点其他|说其他的)/;
// 用户纠正：以她说的为准，旧证据不能继续当依据，必须重新检索。
const RECALL_CORRECT_RE = /(你记错|记错了|不是这样|不是这个|我说的是|不是那个|搞错|弄错|记岔|说反了|你理解错)/;
// 省略式追问：本身不含主题词，但语义上要求接着上一件事说。
const RECALL_ELLIPSIS_RE = /(另一个|另外一个|其他的呢|别的呢|还有呢|还有吗|还有别的|后来呢|然后呢|接着说|继续说|再说说|那个呢|这个呢|那件事|这件事|结果呢|怎么样了呢|具体呢|详细说说)/;

// 锚点停用表：只挡纯功能词与泛指词，专名、名词、动词短语一律保留。
// 命中即整段丢弃，宁可少一个锚点，也不要让「我们」「什么」这种词把两件事粘在一起。
const RECALL_ANCHOR_STOP = /^(我们|你们|他们|她们|咱们|大家|自己|这个|那个|哪个|这些|那些|一个|一下|一些|一样|一直|一起|什么|怎么|怎样|为什么|因为|所以|但是|可是|不过|就是|还是|或者|而且|然后|后来|之前|以后|以前|上次|上回|那次|那天|那时|时候|现在|今天|昨天|明天|可以|可能|应该|需要|知道|记得|记起|觉得|感觉|认为|说过|聊过|讲起|讨论|聊天|说起|提到|事情|东西|问题|地方|时间|意思|内容|样子|情况|有点|一点|真的|其实|反正|大概|好像|不是|没有|这样|那样|如果|假如|要是|只是|不会|不能|不要|不用|别的|其他|另外|还有|这么|那么|多少|几个|第一|第二|最后|开始|结束)$/;

// 含这些字的片段一律不当锚点。
// 原因：2 字片段会把「你还」「还记」「得我」这种句式碎片带进来，
// 结果任何一句「你还记得…」都会被判成同一件事。
// 这里只留名词性、专名性的片段（扁粉菜 / 胡辣汤 / 南极旅行 / 电影），
// 少几个锚点没关系，错粘两件事才是真的会把证据混进别的对话。
const RECALL_ANCHOR_STOP_CHAR = /[的了呢吧啊呀哦是在就都也还要会能说想去来给把被着过我你他她它这个什么怎谁哪和与或但而因所为以于之其很太更最不没有无一二三上下里中大小多少好坏]/;

/**
 * 从一句用户原话里提取「主题锚点」：2–4 字中文片段 + 拉丁/数字词。
 * 用途只有一个：下一轮判断「她还在说同一件事吗」。不做语义理解，也不外发。
 */
function recallAnchors(text) {
  const t = String(text == null ? '' : text).toLowerCase();
  const out = new Set();
  const latin = t.match(/[a-z0-9]{2,}/g) || [];
  for (const w of latin) {
    if (/^(the|and|for|you|are|was|were|what|how|why|did|does|this|that|with|from|your|have|has)$/.test(w)) continue;
    out.add(w);
  }
  const runs = t.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  for (const run of runs) {
    const maxLen = Math.min(4, run.length);
    for (let len = 2; len <= maxLen; len++) {
      for (let i = 0; i + len <= run.length; i++) {
        const piece = run.slice(i, i + len);
        if (RECALL_ANCHOR_STOP.test(piece)) continue;
        if (RECALL_ANCHOR_STOP_CHAR.test(piece)) continue;
        out.add(piece);
      }
    }
  }
  return Array.from(out).slice(0, RECALL_ANCHOR_MAX);
}

/** 本轮原话里是否出现了上一轮留下的锚点（子串命中即算，保守优先） */
function recallOverlaps(text, anchors) {
  if (!Array.isArray(anchors) || !anchors.length) return false;
  const t = String(text == null ? '' : text).toLowerCase();
  for (const a of anchors) {
    if (a && t.indexOf(a) !== -1) return true;
  }
  return false;
}

/** 作废会话。任何「这件事已经翻篇」的信号都走这里。 */
function recallSessionReset() {
  recallSession = null;
}

// 纯语气词/应答词：既不构成新话题，也不足以维持话题。
// 遇到这种话既不作废会话、也不继承证据——当作「她还没接话」，会话原地保留。
const RECALL_FILLER_RE = /^(嗯+|哦+|啊+|呃+|唔+|哈+|嘿+|好|好的|行|可以|对|是|是的|没事|在吗|睡了|晚安|早安|谢谢|收到|知道了|好吧|没事了|知道了啦)$/;

/**
 * 本轮是否接着上一轮那件事说。
 * 顺序有意义：先失效（超时/换话题/纠正），再判同一件事，最后才是省略式追问。
 * 三者都不成立时顺手清掉会话，避免隔了几轮还残留一个旧主题。
 */
function recallShouldCarry(text, now) {
  const s = recallSession;
  if (!s || s.hit !== true || !Array.isArray(s.ids) || !s.ids.length) return false;
  const at = (typeof now === 'number') ? now : Date.now();
  const age = at - s.at;
  // 时间只是必要条件：超时、时钟回拨都一律失效
  if (!(age >= 0 && age <= RECALL_SESSION_TTL_MS)) { recallSessionReset(); return false; }
  const t = String(text == null ? '' : text);
  const compact = t.replace(/\s+/g, '');
  // 只回了一句「嗯」：不继承，但也不算换话题，会话留着
  if (!compact || RECALL_FILLER_RE.test(compact)) return false;
  if (RECALL_SWITCH_RE.test(t)) { recallSessionReset(); return false; }
  if (RECALL_CORRECT_RE.test(t)) { recallSessionReset(); return false; }
  // 主题锚点重合 → 同一件事
  if (recallOverlaps(t, s.anchors)) return true;
  // 省略式追问 → 同一件事（但必须上一轮真的找到过证据，已在开头拦掉）
  if (RECALL_ELLIPSIS_RE.test(t)) return true;
  recallSessionReset();
  return false;
}

/**
 * 记录本轮真实检索结果。
 * 只留 id / 等级 / 覆盖范围 / 锚点；正文一律不留。
 * 没找到证据时不写会话——空结果不可继承，也不代表「已经查过」。
 */
function recallSaveSession(text, ev, now) {
  const r = (ev && ev.result) ? ev.result : null;
  const ids = (r && Array.isArray(r.evidence) ? r.evidence : [])
    .map((e) => (e && e.messageId != null ? e.messageId : null))
    .filter((x) => x != null);
  if (!ids.length) { recallSessionReset(); return; }
  const at = (typeof now === 'number') ? now : Date.now();
  const prev = recallSession;
  // 延续的几轮把锚点累积起来：只靠第一轮的锚点，第三轮很容易接不上。
  const merged = (prev && Array.isArray(prev.anchors))
    ? Array.from(new Set(prev.anchors.concat(recallAnchors(text))))
    : recallAnchors(text);
  recallSession = {
    at: at,
    hit: true,
    level: (ev && ev.level) || 'L2',
    // 覆盖范围如实保留：只有 exhausted 才代表「翻完了」
    exhausted: !!(r && r.exhausted === true),
    partial: !(r && r.exhausted === true),
    anchors: merged.slice(0, RECALL_ANCHOR_KEEP),
    ids: ids.slice(0, RECALL_EVIDENCE_MAX)
  };
}

/**
 * 用上一轮的证据 id 从已加载的 chatHistory 重新取原文，再交给 HistoryRetriever.format 统一排版。
 * 格式化的口径（只读引用、角色标记、覆盖范围提示）全部沿用检索器那一份，不在这里另写一套。
 * 取不到任何原文（消息被删/被清空）时作废会话，绝不返回半截结论。
 */
function recallCarryBlock() {
  const s = recallSession;
  if (!s || !Array.isArray(s.ids) || !s.ids.length) return '';
  const HR = window.HistoryRetriever;
  if (!HR || typeof HR.format !== 'function') return '';
  const evidence = [];
  for (const id of s.ids) {
    const m = chatHistory.find((x) => x && String(x.id) === String(id));
    if (!m) continue;
    const body = String(m.content == null ? '' : m.content).replace(/\s+/g, ' ').trim();
    if (!body) continue;
    evidence.push({
      messageId: m.id,
      time: m.time,
      role: m.role === 'user' ? 'user' : (m.role === 'assistant' ? 'assistant' : ''),
      content: body.length > RECALL_EVIDENCE_ITEM_CHARS
        ? body.slice(0, RECALL_EVIDENCE_ITEM_CHARS - 2) + '…'
        : body
    });
  }
  if (!evidence.length) { recallSessionReset(); return ''; }
  return HR.format({
    status: 'matched',
    level: s.level,
    evidence: evidence,
    exhausted: s.exhausted === true
  }) || '';
}

/**
 * B2：更早的聊天原文按需检索（只读）。
 * 判断、检索、格式化都在 HistoryRetriever 内部完成；这里只负责把真实状态交进去：
 *   loaded 必须来自 messagesLoaded（真正读成功），不是「chatHistory 是数组」；
 *   dbReady 来自当前连接 db，与「加载完成」是两件事。
 * L3 时 collect() 直接返回，不发生任何内存扫描或 IndexedDB 读取。
 * 任何异常都收敛成空字符串，聊天照常继续。
 *
 * 第一批修复：opts.carry 是本轮的「同一件事」判定结果（来自 recallShouldCarry）。
 * 它同时决定两件事——喂给检索器的 windowHasPastTopic，以及本轮没命中时是否
 * 用上一轮的证据 id 重新取原文。两者都不成立时，本轮就是一条普通消息。
 */
async function collectChatHistoryEvidence(text, current, windowMessages, opts) {
  const HR = window.HistoryRetriever;
  if (!HR || typeof HR.collect !== 'function') return '';
  const o = opts || {};
  const now = (typeof o.now === 'number') ? o.now : Date.now();
  const carry = o.carry === true;
  try {
    const ev = await HR.collect({
      text: String(text == null ? '' : text),
      current: current || null,
      history: chatHistory,
      window: Array.isArray(windowMessages) ? windowMessages : [],
      state: {
        dbReady: !!db,
        loaded: messagesLoaded === true,
        loadFailed: messagesLoadFailed === true
      },
      reader: window.RoomChatReader || null,
      // 以前这里恒为 false，检索器里 window-continuation 那条分支永远不可达。
      // 现在只在本轮确实接着上一件事说时才置 true；普通闲聊仍然是 false。
      windowHasPastTopic: carry,
      now: now,
      onError: (e) => console.warn('[历史检索] 已跳过本轮引用：', (e && e.message) || e)
    });
    if (ev && ev.status === 'failed') console.warn('[历史检索] 未完成：', ev.reason || ev.status);
    const block = (ev && ev.block) ? ev.block : '';
    // 本轮真的翻到了原文：以本轮为准（比续问更准），并把主题与覆盖范围刷进会话
    const hasEvidence = !!(ev && ev.result
      && Array.isArray(ev.result.evidence) && ev.result.evidence.length);
    if (hasEvidence && block) {
      recallSaveSession(text, ev, now);
      return block;
    }
    if (carry) {
      // 续问这一句本身往往只有「后来呢」「那另一个」几个字，检索器会判 L2 却检索不到，
      // 于是 block 是一段「没翻到」的提示。这时候不能把它当结论——必须回退到上一轮的证据。
      // carryBlock 从 chatHistory 按 id 重新取原文，正文从不进会话状态。
      const carried = recallCarryBlock();
      // 话题还在继续：续期。不续的话，一直聊同一件事也会被 8 分钟卡断。
      if (carried && recallSession) recallSession.at = now;
      return carried || '';
    }
    // 非续问：保留检索器原本的诚实提示（翻完了没找到 / 只翻了一部分），不伪造证据。
    // 会话作废只由 recallShouldCarry 负责，这里不再顺手清——否则她插一句「嗯」就会被打断。
    if (block) return block;
    return '';
  } catch (e) {
    // collect 本身不抛；这里是最后一道保险，绝不让检索影响正常聊天
    console.warn('[历史检索] 已跳过本轮引用：', (e && e.message) || e);
    return '';
  }
}

async function doRequestStarReply(userMessage) {
  const client = window.AIClient;
  const text = String(userMessage.content || '');
  const asLocalError = (e) => ((e && e.code) ? e : client.error('LOCAL', (e && e.message) || '本地处理失败'));

  try {
    // 生活管家：仅当消息疑似待办/记账指令时，才给系统提示词追加说明（省 token，普通聊天不受影响）
    const blGate = window.ButlerIntent ? window.ButlerIntent.gate(text) : false;
    // 亲近/情绪轮次：只在这些轮次追加判断规则，并关掉「可以不说话」
    const closeTalk = looksLikeCloseTalk(text, chatHistory);
    // 精确时间只在涉及待办/提醒/时间日期时注入，普通闲聊不重复说明
    const blTimeAware = blGate || (window.ButlerIntent ? window.ButlerIntent.needsClockContext(text) : false);
    // 本地提前提醒（提前 10 分钟、只提醒一次）：未到提醒时刻返回空；闲聊时按 90 秒节流，不每轮扫描
    const nowMs = Date.now();
    const shouldRemind = blTimeAware || nowMs - lastRemindScan > 90000;
    if (shouldRemind) lastRemindScan = nowMs;
    const blRemind = (shouldRemind && window.ButlerIntent) ? await window.ButlerIntent.remindContext() : '';
    // 本轮没有注入提醒：清掉上一轮残留的待确认 key，避免误记「已说出」
    if (!blRemind && window.ButlerIntent && window.ButlerIntent.takeContextKeys) { try { window.ButlerIntent.takeContextKeys(); } catch (e) {} }
    // 新请求架构：主聊天使用 24000/20000 显式 state 滞回窗口；当前 user 从窗口剔除后
    // 在请求末尾由 assembleMessages 重新挂载，确保只发送一次。
    const HW = window.HistoryWindow;
    const windowResult = (HW && typeof HW.trimWithHysteresis === 'function')
      ? HW.trimWithHysteresis(chatHistory, { textOf: historyTextOf, state: chatHistoryWindowState })
      : { window: trimHistoryForAI(chatHistory), stats: null, state: null };
    chatHistoryWindowState = windowResult.state || null;
    const detached = (HW && typeof HW.detachCurrentTurn === 'function')
      ? HW.detachCurrentTurn(windowResult.window, userMessage.id, chatHistory, userMessage)
      : { window: windowResult.window, current: userMessage, found: false };
    const historyWindow = detached.window;
    // 从游乐场刚回来时，把这一次的游戏与结果带进提示词（只用一轮）
    // P5.1：她屏蔽了「游戏」话题时，这条一次性上下文也不得绕过规则
    const gameTopicBlocked = !!(window.LifeTopics && window.LifeTopics.isBlocked('game'));
    const gameContextPart = (pendingGameContext && !gameTopicBlocked)
      ? `\n【刚刚一起经历的】${pendingGameContext.name || '小游戏'}${pendingGameContext.result ? `：${pendingGameContext.result}` : ''}。这件事已经发生过了，不要重复问结果，也不要当作没发生。`
      : '';
    // 游戏活动记忆：本地只读，近期 24h 最多 3 条；历史仅在她主动提及时按需检索。只给事实。
    let activityPart = '';
    let activityIds = [];
    if (window.GameActivity && !gameTopicBlocked) {
      try {
        const ga = window.GameActivity;
        const rows = ga.recent(nowMs, { hours: 24, limit: 3 });
        if (rows && rows.length) {
          activityIds = rows.map(x => x.id);
          activityPart = '\n【近期游戏活动，仅陈述事实】' + rows.map(x => ga.describe(x, nowMs)).join('');
        }
        const hist = String(text || '');
        if (/(之前|上次|前几天|那天|曾经|回忆|回顾|玩过|做过|有没有.*(玩|做)|记得)/.test(hist)) {
          const wide = /(很久|很早|几个月|上个月|历史|全部|从头|翻一翻)/.test(hist);
          const gm = hist.match(/(五子棋|厨房|拼图|背词|单词|问答|二十一点|21点|约会|冒险|游戏)/);
          const found = ga.search({ now: nowMs, days: wide ? 180 : 7, query: gm ? gm[1] : '', limit: 5 });
          activityPart += found.length
            ? '\n【按需查到的旧活动，仅陈述事实】' + found.map(x => ga.describe(x, nowMs)).join('')
            : '\n【按需查到的旧活动】没有找到对应记录，如实说明没有找到，不要推测或编造。';
        }
      } catch (e) { activityPart = ''; activityIds = []; }
    }
    // P5-a：本地判断这一句是否在表达「以后别再提某类话题」/「现在不想聊」/「可以聊了」
    let topicsPart = '';
    if (window.LifeTopics) {
      try {
        window.LifeTopics.note(text);
        if (window.LifeTopics.declined(text)) window.LifeTopics.hush();   // 累了/不想说 → 暂停自主互动
        const note = window.LifeTopics.promptNote();
        if (note) topicsPart = '\n' + note;
      } catch (e) {}
    }
    // P1-a：生活时间上下文（只读，普通闲聊不罗列时间）
    let lifeContextPart = '';
    if (window.LifeContext) {
      try {
        const lifeSnap = window.LifeContext.snapshot();
        if (window.LifeContext.shouldInject(lifeSnap)) {
          // noClock：分钟级时间只在 system 末尾由 withNowAtEnd() 注入一次，这里不再复制一个 HH:MM。
          const lifeText = window.LifeContext.render(lifeSnap, { noClock: true });
          if (lifeText) lifeContextPart = '\n' + lifeText;
        }
      } catch (e) {}
    }
    // 今日便签：只读模块缓存，一行摘要；没有任务时不注入（不新增请求）
    // 便签任务一律「小星发起、用户执行」，与她自己的生活待办/生活管家任务无关。
    let notePart = '';
    if (window.NoteCard) {
      try {
        const noteText = window.NoteCard.aiLine();
        if (noteText) {
          notePart = '\n【今日便签任务关系】便签里的小事全部是你（小星）主动安排给用户的，不是用户给自己列的待办，也不是生活管家的待办；你负责提议、关注进度和回应结果，不要替她执行。她可以随时接受、拒绝或延期，都不算违约；便签里出现的时间是她做这件事的安排或期望时刻，不是现在几点。她问「今天给我安排了什么」时，照便签内容如实回答。'
            + '\n' + noteText;
        }
      } catch (e) {}
    }
    // P4：只有她确实在问某类生活事实时才本地读一次（0 请求、不读私人正文）
    let lifeFactsPart = '';
    if (window.LifeFacts) {
      try {
        const fact = await window.LifeFacts.lookup(text, { tasks: lifeTasksProvider });
        if (fact && fact.text) lifeFactsPart = '\n' + fact.text;
      } catch (e) {}
    }
    // 五层按需：第三层按话题、第四层按关系情境、第五层按事件、特殊能力仅相关情境；
    // 历史窗口提供话题粘性，命中资料在语境持续期保持可用。任何读取失败都静默降级。
    const personaPart = buildPersonaOnDemand(text, { closeTalk, blGate });
    // 三类动态资料按需：普通闲聊不读；命中"回忆/约定/日记/珍藏"等信号才检索原文片段。
    // 只读原文，不改原始记录；片段仅供核实，重要约定以原文为准。
    const dynamic = await buildDynamicOnDemand(text);

    // B2：更早的聊天原文按需检索。L3 只跑一次正则，普通闲聊不扫内存、不读库、不多发请求。
    // 结果只在 matched / exhausted / partial 时非空；任何异常都在收集函数内部吞掉。
    // 第一批修复：先判断「她是不是还在说上一件事」，再把结论交给检索器（同一件事才允许继承）。
    const recallNow = Date.now();
    const carryRecall = recallShouldCarry(text, recallNow);
    const historyBlock = await collectChatHistoryEvidence(text, userMessage, historyWindow, { carry: carryRecall, now: recallNow });

    // 当前消息用与历史窗口相同的 historyTextOf 口径（语音空转写要有中性说明），
    // 但直接取原始对象，image / type 等字段原样保留。
    const currentSource = detached.current || userMessage;
    const currentTurn = messageToAI(Object.assign({}, currentSource, { content: historyTextOf(currentSource) }));

    // 主聊天也走同一份生产组装适配器；动态块内容按轮变化，但结构与其他路径一致。
    const messages = assemblePathMessages({
      taskInstruction: rcTask('chat', getActionDensityPrompt() + '\n请结合上下文自然回应。不要重复用户的话。'),
      blocks: [
        { id: 'schedule', text: '\n【当前日程】' + getScheduleContext() },
        { id: 'closeTalk', text: closeTalk ? getCloseTalkPrompt() : '' },
        { id: 'game', text: gameContextPart },
        { id: 'activity', text: activityPart },
        { id: 'lifeContext', text: lifeContextPart },
        { id: 'lifeFacts', text: lifeFactsPart },
        { id: 'topics', text: topicsPart },
        { id: 'note', text: notePart },
        { id: 'persona', text: personaPart.text },
        { id: 'dynamicMemory', text: dynamic.text },
        { id: 'silence', text: (blGate || closeTalk) ? '' : getChatSilencePrompt() },
        { id: 'remind', text: blRemind ? '\n' + blRemind : '' },
        { id: 'butler', text: blGate ? window.ButlerIntent.systemPrompt() : '' },
        { id: 'history', text: historyBlock }
      ],
      history: historyWindow,
      currentTurn: currentTurn,
      currentMessageId: userMessage.id
    });

    const rawReply = await callAI(messages, { requestType: rcRequestType('chat') });
    // 游戏活动上下文：接口请求成功后即记已注入（活动去重维持原有行为，本轮不改）。
    if (activityIds.length && window.GameActivity && window.GameActivity.markSeen) {
      try { window.GameActivity.markSeen(activityIds); } catch (e) {}
    }
    pendingGameContext = null;

    // 星星的小沉默：只认「整条回复只有一个完整标记」；有正文 / JSON 异常都不算沉默。
    // 沉默时不会进入生活管家与珍藏解析，也不语音、不按需翻译、不占主动关心预算。
    const silentParsed = parseChatSilence(rawReply);
    // 生活管家指令（待办/记账）绝不允许被沉默吞掉：这类轮次不认沉默标记
    if (silentParsed.silent && !blGate) {
      try {
        await saveChatSilentMessage(silentParsed.reason);
      } catch (e) {
        throw client.error('SAVE_REPLY', (e && e.message) || '沉默消息保存失败');
      }
      return { silent: true };
    }

    // 生活管家：从回复中剥离 <bl> 标记并执行本地增删改查/统计
    let effReply = silentParsed.text;
    if (blGate && window.ButlerIntent) {
      try { effReply = await window.ButlerIntent.handleAIResponse(effReply, text, userMessage.time); } catch (e) { effReply = silentParsed.text; }
    }
    // 标记不完整/JSON 坏掉又没有正文：按异常处理，绝不伪造成「她选择沉默」
    if (!String(effReply || '').trim()) {
      throw client.error('EMPTY', silentParsed.hasMarker ? '沉默标记不完整，没有可用正文' : '回复内容为空');
    }

    let chineseReply = effReply;
    let englishReply = '';
    const splitIndex = effReply.indexOf('|||');
    if (splitIndex !== -1) {
      chineseReply = effReply.substring(0, splitIndex).trim();
      englishReply = effReply.substring(splitIndex + 3).trim();
    }

    const moodReply = updateMood(chineseReply);
    const lockedReply = await lockStickerInText(moodReply);

    const assistantMessage = { role: 'assistant', content: lockedReply, englishContent: englishReply, time: Date.now() };
    try {
      assistantMessage.id = await addToStore('messages', assistantMessage);
    } catch (e) {
      throw client.error('SAVE_REPLY', (e && e.message) || '保存失败');
    }
    chatHistory.push(assistantMessage);
    beginTypewriterReveal(assistantMessage); // 只影响显示：内容此时已完整落库
    renderMessages();
    // 提醒上下文已被这条回复真正说出来并落库 → 记为已投递，避免调度器 10 分钟后再重复播一遍
    // 回复里没提到（比如她正在说心里话，模型先接住了情绪）→ 不消费，留给调度器在窗口内补一句
    if (blRemind && window.ButlerIntent && window.ButlerIntent.takeContextKeys) {
      try { window.ButlerIntent.takeContextKeys(lockedReply).forEach((k) => window.ButlerIntent.markRemindDelivered(k, Date.now())); } catch (e) {}
    }

    // 主回复默认只有中文：不再自动请求翻译。模型自带英文（如生活管家的 ||| 段）
    // 仍按原样保存并用原语音路径朗读；没有英文就留着，由用户点「翻译成英文」后再保存。
    if (englishReply) {
      requestAndPlaySpeech(englishReply, assistantMessage.id);
    }

    detectStarKeepProposal(lockedReply).catch(err => console.error('珍藏检测失败', err));
    // 动态资料去重键只在「正常回复真正落库并渲染」后标记：
    // 接口失败、空回复、保存失败都会在上面抛错；沉默分支在上面提前 return；
    // 这些情况都不标记，下一轮仍可重新检索并发送同一条资料。
    if (dynamic.keys.length && window.PersonaMemory && window.PersonaMemory.markSent) {
      try { window.PersonaMemory.markSent(dynamic.keys); } catch (e) {}
    }
    return assistantMessage;
  } catch (e) {
    throw asLocalError(e);
  }
}

async function sendMessage() {
  const input = document.getElementById('chatInput');
  if (!input) return false;
  const text = input.value.trim();
  const image = pendingChatImage;
  if (!text && !image) return false;
  return sendUserTurn({ text: text, image: image, fromInput: true });
}

/**
 * 用户消息的唯一写入入口：文字、图文、语音都走这里。
 * 这样重试、输入中看门狗、生活管家本地意图、上下文补全只有一套逻辑，
 * 语音消息不需要（也不会）另起一条旁路。
 * 返回「用户消息是否真的落库」：false 时调用方不要清掉还没发出去的录音。
 */
async function sendUserTurn(turn) {
  if (isSending) return false;
  const t = turn || {};
  const input = document.getElementById('chatInput');
  const sendBtn = document.getElementById('sendBtn');
  const text = String(t.text == null ? '' : t.text).trim();
  const image = t.image || null;
  const voice = t.voice || null;
  if (!text && !image && !voice) return false;
  if (!apiKey) { toast('先在设置里填写 API Key。'); return false; }

  // 历史尚未真正加载完成时先等一次，避免把「空内存」当空历史发给模型；
  // 等待期间锁住发送按钮但不清输入框，加载失败也会解锁，用户输入不会丢。
  if (!messagesLoaded && !messagesLoadFailed) {
    isSending = true;
    if (sendBtn) sendBtn.disabled = true;
    try {
      toast('聊天记录还在读取，稍等一下…');
      await ensureMessagesLoaded();
    } finally {
      isSending = false;
      if (sendBtn) sendBtn.disabled = false;
    }
  }

  if (text.includes('光猎')) {
    document.body.classList.add('danger-mode');
    startCoaxing();
    setTimeout(() => document.body.classList.remove('danger-mode'), 8000);
  }

  isSending = true;
  if (sendBtn) sendBtn.disabled = true;

  const userMessage = { role: 'user', content: text, image: image || null, time: Date.now() };
  if (voice) {
    userMessage.type = 'voice';
    userMessage.audioClipId = voice.audioClipId || null;
    userMessage.audioMime = voice.audioMime || '';
    userMessage.durationMs = voice.durationMs || 0;
    userMessage.asrStatus = voice.asrStatus || 'manual';
  }
  let stage = 'save-user';
  let saved = false;

  try {
    userMessage.id = await addToStore('messages', userMessage);
    saved = true;
    // 音频记录里的 messageId 只作溯源，写失败不影响消息本身
    if (voice && voice.audioClipId && userMessage.id != null && window.VoiceStore) {
      window.VoiceStore.setMessageId(voice.audioClipId, userMessage.id).catch(() => {});
    }
    chatHistory.push(userMessage);
    // 新消息已经进库：上一条的重试入口作废，避免对同一条用户消息重复发请求
    pendingReplyRetry = null;
    // P0：只有用户消息真正写入成功，才算一次有效互动
    try { if (window.LifePresence) window.LifePresence.interaction(); } catch (e) {}
    // 语音消息不动文字输入框，也不清掉可能已经选好的照片
    if (t.fromInput && !voice) { if (input) input.value = ''; clearChatPhoto(); }
    const searchEl = document.getElementById('chatSearch');
    if (searchEl) searchEl.value = '';
    if (text) updateCoaxing(text);
    renderMessages();

    stage = 'local';
    // 生活管家：高置信本地查询（固定句式），0 次 AI 调用
    if (window.ButlerIntent && text) {
      const local = await window.ButlerIntent.tryLocal(text);
      if (local && local.handled) {
        const localMsg = { role: 'assistant', content: local.reply, englishContent: '', time: Date.now(), source: 'butler' };
        localMsg.id = await addToStore('messages', localMsg);
        chatHistory.push(localMsg);
        renderMessages();
        return true;
      }
    }

    // 生活管家：待处理上下文补全（她说"三点""明天""7元"时本地补完并保存，0 次 AI）
    if (window.ButlerIntent && text && window.ButlerIntent.hasPending()) {
      const filled = await window.ButlerIntent.tryPending(text);
      if (filled && filled.handled) {
        const fillMsg = { role: 'assistant', content: filled.reply, englishContent: '', time: Date.now(), source: 'butler' };
        fillMsg.id = await addToStore('messages', fillMsg);
        chatHistory.push(fillMsg);
        renderMessages();
        return true;
      }
    }

    await requestStarReply(userMessage);
  } catch (e) {
    if (stage !== 'save-user') {
      pendingReplyRetry = {
        id: userMessage.id,
        text: userMessage.content,
        at: userMessage.time,
        code: (e && e.code) || 'UNKNOWN'
      };
    }
    toast(chatErrorMessage(e, stage));
  } finally {
    isSending = false;
    isTyping = false;
    if (sendBtn) sendBtn.disabled = false;
    if (input) { input.disabled = false; if (!voice) input.focus(); }
    renderMessages();
    resetIdleTimer();
  }
  return saved;
}

/**
 * 语音消息发送：先存音频，再写消息。
 * 顺序不能反：音频没存下来就不发消息，避免出现「有记录却没有音频」。
 */
async function sendVoiceMessage(payload) {
  if (isSending) { toast('正在发送中，稍等一下。'); return false; }
  const p = payload || {};
  if (!p.blob || !p.blob.size) { toast('这段没录到声音，重录一次？'); return false; }
  const store = window.VoiceStore;
  if (!store) { toast('语音存储没加载，请刷新页面。'); return false; }

  const cfgText = (window.VoiceConfig && window.VoiceConfig.text) || {};
  const clip = await store.save({ blob: p.blob, mime: p.mime, durationMs: p.durationMs });
  if (!clip) { toast(cfgText.clipSaveFailed || '语音没能保存，先不发送。'); return false; }

  const saved = await sendUserTurn({
    text: p.transcript,
    voice: {
      audioClipId: clip.id,
      audioMime: clip.mime,
      durationMs: clip.durationMs,
      asrStatus: p.asrStatus
    }
  });
  if (!saved) {
    // 消息没落库就把这段音频清掉，别留一份没人引用的孤儿
    await store.remove(clip.id).catch(() => {});
    return false;
  }
  return true;
}

// 供录音面板回调（面板只管录，发送交给聊天流程）
window.sendVoiceMessage = sendVoiceMessage;

// 重试：只重新请求 AI，绝不再插入一条用户消息
async function retryReply() {
  if (isSending) return;
  if (!canRetryReply()) { pendingReplyRetry = null; renderMessages(); return; }
  const target = pendingReplyRetry;
  const last = chatHistory[chatHistory.length - 1];
  const input = document.getElementById('chatInput');
  const sendBtn = document.getElementById('sendBtn');

  isSending = true;
  if (sendBtn) sendBtn.disabled = true;

  try {
    await requestStarReply(last);
    pendingReplyRetry = null;
  } catch (e) {
    pendingReplyRetry = { id: target.id, text: target.text, at: target.at, code: (e && e.code) || 'UNKNOWN' };
    toast(chatErrorMessage(e, 'request-ai'));
  } finally {
    isSending = false;
    isTyping = false;
    if (sendBtn) sendBtn.disabled = false;
    if (input) { input.disabled = false; input.focus(); }
    renderMessages();
    resetIdleTimer();
  }
}

// 🌟 搜索跳转与高亮辅助
function highlightKeyword(element, keyword) {
  const regex = new RegExp(`(${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  function traverse(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.nodeValue;
      if (regex.test(text)) {
        const fragment = document.createDocumentFragment();
        let lastIndex = 0;
        text.replace(regex, (match, p1, offset) => {
          if (offset > lastIndex) fragment.appendChild(document.createTextNode(text.slice(lastIndex, offset)));
          const mark = document.createElement('mark');
          mark.style.backgroundColor = '#ffeb3b';
          mark.style.color = '#000';
          mark.style.borderRadius = '3px';
          mark.style.padding = '0 2px';
          mark.textContent = match;
          fragment.appendChild(mark);
          lastIndex = offset + match.length;
        });
        if (lastIndex < text.length) fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
        node.parentNode.replaceChild(fragment, node);
      }
    } else if (node.nodeType === Node.ELEMENT_NODE && node.nodeName !== 'IMG') {
      Array.from(node.childNodes).forEach(traverse);
    }
  }
  traverse(element);
}

function jumpToMessage(id) {
  const searchEl = document.getElementById('chatSearch');
  if (searchEl) searchEl.value = '';
  renderMessages();

  setTimeout(() => {
    const list = document.getElementById('messages');
    const target = list.querySelector(`[data-id="${id}"]`);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.add('flash-message');
      setTimeout(() => target.classList.remove('flash-message'), 2000);
    }
  }, 100);
}

// ============================================================
// 星星的小沉默（普通聊天专用）
// 与主动关心的静默完全隔离：这里复用 messages 表，多几个可选字段而已。
//   silent:true / silentReason / silentAt / silentRevealedAt
// ============================================================
const SILENT_PLACEHOLDER = '已读，暂时没有回复';
const SILENT_REASON_MAX = 200;
// 两种写法都要识别：带 reason 的 [[SILENT: {...}]] 与裸 [[SILENT]] / [[SILENCE]]。
// 全局标志保证正文里夹带多个标记时能被一次剥干净，绝不把标记原文留在可见正文或历史回灌里。
const SILENT_REASON_RE = /\[\[\s*(?:SILENT|SILENCE)\s*:\s*([\s\S]*?)\s*\]\]/gi;
const SILENT_BARE_RE = /\[\[\s*(?:SILENT|SILENCE)\s*\]\]/gi;

// 正文是否只有括号动作描写（没有任何对白）。用于区分「动作描写 + 裸标记」与「正常正文 + 标记」。
function isActionOnlyText(s) {
  const t = String(s == null ? '' : s);
  if (!/[（(]/.test(t)) return false;
  return t.replace(/[（(][^）)]*[）)]/g, '').replace(/\|\|\|/g, '').trim() === '';
}

// 纯函数：把一次模型输出归类为「沉默 / 普通正文 / 需报错」之一。
// 主聊天（parseChatSilence）与主动关心（isSilentIdleReply）共用同一套识别与清理规则。
// 不读写任何状态、不访问数据库、不请求 AI。
// 返回 { silent, reason, text, hasMarker, malformed }
//   silent=true：调用方按沉默处理，reason 作为点击展开的心情；
//   silent=false：text 是清理后的正文；text 为空且 hasMarker/malformed 时调用方应报错，不落空消息。
function analyzeSilentReply(reply) {
  const raw = String(reply == null ? '' : reply);
  let reason = '';
  let hasReasonMarker = false;
  let hasBareMarker = false;
  let malformed = false;

  // 先收集带 reason 标记里的合法理由，再从整条文本里剥掉所有标记。
  SILENT_REASON_RE.lastIndex = 0;
  let m;
  while ((m = SILENT_REASON_RE.exec(raw)) !== null) {
    hasReasonMarker = true;
    let obj = null;
    try { obj = JSON.parse(m[1]); } catch (e) { malformed = true; continue; }
    const r = obj && typeof obj === 'object'
      ? String(obj.reason != null ? obj.reason : (obj.text != null ? obj.text : '')).trim()
      : '';
    if (r) reason = reason ? reason + '\n' + r : r;
  }
  SILENT_BARE_RE.lastIndex = 0;
  hasBareMarker = SILENT_BARE_RE.test(raw);

  const cleaned = raw.replace(SILENT_REASON_RE, '').replace(SILENT_BARE_RE, '');
  // ||| 是双语分隔符，不算「实质正文」；判断纯沉默时忽略它。
  const rest = cleaned.replace(/\|\|\|/g, '').trim();
  const hasMarker = hasReasonMarker || hasBareMarker;
  const text = cleaned.trim();
  const asReason = (s) => String(s == null ? '' : s).replace(/\[\[[\s\S]*?\]\]/g, '').trim().slice(0, SILENT_REASON_MAX);

  // 非法 JSON：绝不吞掉正文。有正文就按普通回复返回（标记已剥掉）；
  // 没有正文则 text 为空 + malformed，由调用方明确报错，不落空消息。
  if (malformed) return { silent: false, reason: '', text: text, hasMarker: true, malformed: true };

  // 整条去掉标记和空白后没有实质正文 → 纯沉默。
  if (!rest) {
    // 带 reason 标记但理由为空：沿用既有行为，不算沉默，交给调用方按不完整标记报错。
    if (hasReasonMarker && !reason) return { silent: false, reason: '', text: '', hasMarker: true, malformed: false };
    if (hasMarker) return { silent: true, reason: asReason(reason), text: '', hasMarker: true, malformed: false };
    // 完全没有标记的空回复不是沉默，按空回复处理。
    return { silent: false, reason: '', text: '', hasMarker: false, malformed: false };
  }

  // 有实质正文：
  //  - 带合法 reason 的标记：标记只是夹带，按普通回复剥掉标记保留正文；
  //  - 裸标记 + 只有动作描写：识别为沉默，动作描写作为可点击展开的心情；
  //  - 其余（正常正文夹带裸标记）：普通回复，剥掉标记保留正文，不误判为沉默。
  if (hasReasonMarker) return { silent: false, reason: '', text: text, hasMarker: true, malformed: false };
  if (hasBareMarker && isActionOnlyText(rest)) {
    return { silent: true, reason: asReason(rest), text: '', hasMarker: true, malformed: false };
  }
  return { silent: false, reason: '', text: text, hasMarker: hasBareMarker, malformed: false };
}

// 兼容原调用点：返回形状不变，仍为 { silent, reason, text, hasMarker }。
function parseChatSilence(reply) {
  const a = analyzeSilentReply(reply);
  return { silent: a.silent, reason: a.reason, text: a.text, hasMarker: a.hasMarker };
}

// 落库一条沉默消息：content 留空（占位文案由界面生成，不写进数据）
async function saveChatSilentMessage(reason) {
  const now = Date.now();
  const message = {
    role: 'assistant',
    content: '',
    englishContent: '',
    time: now,
    silent: true,
    silentReason: String(reason == null ? '' : reason).trim(),
    silentAt: now,
    silentRevealedAt: 0,
    source: 'chat-silent',
  };
  message.id = await addToStore('messages', message);
  chatHistory.push(message);
  renderMessages();
  return message;
}

// 点一下才揭晓：本地状态 + IndexedDB 记录，不请求 AI，刷新后仍然是展开的
async function revealChatSilence(m) {
  if (!m || !m.silent || m.silentRevealedAt) return;
  m.silentRevealedAt = Date.now();
  renderMessages();
  if (m.id != null) {
    try { await updateStore('messages', m.id, { silentRevealedAt: m.silentRevealedAt }); } catch (e) {}
  }
}

// 沉默气泡：占位文案 / 揭晓后的心里话都用 textContent，避免把模型输出当 HTML
function renderSilentBubble(bubble, m) {
  const revealed = !!(m.silentRevealedAt && m.silentReason);
  bubble.classList.add('silent-bubble');
  if (revealed) bubble.classList.add('revealed');
  const text = document.createElement('div');
  text.className = 'silent-text';
  text.textContent = revealed ? m.silentReason : SILENT_PLACEHOLDER;
  bubble.appendChild(text);
  if (!revealed && m.silentReason) {
    const hint = document.createElement('small');
    hint.className = 'silent-hint';
    hint.textContent = '轻点展开';
    bubble.appendChild(hint);
    bubble.setAttribute('role', 'button');
    bubble.setAttribute('tabindex', '0');
    bubble.onclick = function (e) { e.stopPropagation(); revealChatSilence(m); };
    bubble.onkeydown = function (e) {
      if (e && (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar')) { e.preventDefault(); revealChatSilence(m); }
    };
  }
}

// ============================================================
// 打字机显示：回复已完整生成并落库，这里只控制「显示到第几个字」
// 存档、双语、表情、搜索高亮、滚动都沿用原来的渲染规则
// ============================================================
let revealState = null; // { id, shown, timer }
// 逐字重绘会反复重建正文 DOM；表情图缓存在本进程内，避免每打一个字就换一次图
const revealStickerCache = Object.create(null);

// 表情标记是不能拆开的整体，其余按字符（含换行）逐个切分
const REVEAL_STICKER_RE = /\[表情[:：]\s*[^\]\|]+(?:\|[^\]]+)?\]/g;

function splitRevealTokens(text) {
  const src = String(text == null ? '' : text);
  const tokens = [];
  let last = 0;
  REVEAL_STICKER_RE.lastIndex = 0;
  let m;
  while ((m = REVEAL_STICKER_RE.exec(src)) !== null) {
    if (!m[0]) { REVEAL_STICKER_RE.lastIndex += 1; continue; }
    if (m.index > last) tokens.push.apply(tokens, Array.from(src.slice(last, m.index)));
    tokens.push(m[0]);
    last = m.index + m[0].length;
  }
  if (last < src.length) tokens.push.apply(tokens, Array.from(src.slice(last)));
  return tokens;
}

// 一条消息在气泡里最终会显示的全部文字（含按设置追加的英文）
function displayTextOfMessage(m) {
  let text = String(m && m.content != null ? m.content : '');
  if (m && m.role === 'assistant' && settings.showEnglish && m.englishContent) {
    text = text + '\n\n' + m.englishContent;
  }
  return text;
}

function revealIsTarget(id) {
  return !!(revealState && revealState.id != null && String(revealState.id) === String(id));
}

// 当前应显示的部分：按 token 截断，绝不把表情标记切成半截
function revealShownText(full) {
  if (!revealState) return full;
  const tokens = splitRevealTokens(full);
  if (!tokens.length) return full;
  const n = Math.max(1, Math.min(revealState.shown, tokens.length));
  return tokens.slice(0, n).join('');
}

function stopTypewriterReveal() {
  if (revealState && revealState.timer) clearTimeout(revealState.timer);
  revealState = null;
}

// 收尾：清掉状态并整表重渲染一次，保证终态和普通渲染逐像素一致
function endTypewriterReveal(repaint) {
  const had = !!revealState;
  stopTypewriterReveal();
  if (had && repaint !== false) renderMessages();
}

// 新回复落库并 push 进 chatHistory 之后调用；此时内容已经是完整的
function beginTypewriterReveal(message) {
  try {
    if (!message || message.id == null) return;
    if (message.role !== 'assistant' || message.silent) return;
    if (message.type === 'voice') return;
    const list = document.getElementById('messages');
    if (!list) return;
    const searchEl = document.getElementById('chatSearch');
    if (searchEl && searchEl.value.trim()) return; // 搜索结果页不做逐字显示
    const full = displayTextOfMessage(message);
    // 纯表情/纯颜文字整块显示：逐字拆开会变成一堆碎片，反而难看
    if (isPureEmojiText(full)) return;
    endTypewriterReveal(); // 上一条还没播完就直接收尾
    revealState = { id: message.id, shown: 1, timer: null };
    scheduleRevealStep(140);
  } catch (e) {
    stopTypewriterReveal();
  }
}

function scheduleRevealStep(delay) {
  if (!revealState) return;
  if (revealState.timer) clearTimeout(revealState.timer);
  revealState.timer = setTimeout(function () {
    if (!revealState) return;
    revealState.timer = null;
    revealStep();
  }, Math.max(0, delay || 0));
}

function revealStep() {
  const state = revealState;
  if (!state) return;
  const list = document.getElementById('messages');
  const searchEl = document.getElementById('chatSearch');
  if (!list || (searchEl && searchEl.value.trim())) { endTypewriterReveal(); return; }
  const msg = chatHistory.find(function (x) { return String(x && x.id) === String(state.id); });
  if (!msg) { endTypewriterReveal(); return; }
  const full = displayTextOfMessage(msg);
  const tokens = splitRevealTokens(full);
  if (state.shown >= tokens.length) { finishTypewriterReveal(full, tokens); return; }
  state.shown += 1;
  paintRevealNode(full, tokens);
  scheduleRevealStep(revealDelayFor(tokens[state.shown - 1], full));
}

// 播完：就地补齐到完整文本，不整表重建（否则表情图会重新随机、滚动也会跳）
function finishTypewriterReveal(full, tokens) {
  const state = revealState;
  if (state) state.shown = (tokens || []).length;
  paintRevealNode(full, tokens);
  stopTypewriterReveal();
}

// 只重绘这一条消息的正文，不整表重建（避免语音/表情/滚动被打断）
function paintRevealNode(full, tokens) {
  const state = revealState;
  if (!state) return;
  const list = document.getElementById('messages');
  if (!list) return;
  let item = null;
  try { item = list.querySelector('[data-id="' + String(state.id).replace(/"/g, '\\"') + '"]'); } catch (e) { item = null; }
  const host = item && item.querySelector('[data-reveal-host]');
  if (!host) return;
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 140;
  paintMessageContent(host, (tokens || []).slice(0, state.shown).join(''), full, '');
  resolveStickerImgs(host); // 表情是整块出现的，这里补一次取图
  if (nearBottom) list.scrollTop = list.scrollHeight;
}

// 节奏：整体越快越好读，但标点和换行必须留气口，速度带轻微抖动避免机械感
function revealDelayFor(tok, full) {
  const len = String(full || '').length;
  let base = 34;
  if (len > 60) base = 26;
  if (len > 140) base = 19;
  if (len > 260) base = 14;
  if (len > 450) base = 10;

  const t = String(tok == null ? '' : tok);
  // 长文里标点停顿按比例收一点，避免整段念太久；短句保持完整气口
  const ps = len > 260 ? 0.55 : (len > 140 ? 0.75 : 1);
  let pause = 0;
  if (t === '\n') pause = 170;
  else if (t === '…') pause = 150;
  else if ('。！？!?'.indexOf(t) >= 0) pause = 200;
  else if ('，、；：,;:'.indexOf(t) >= 0) pause = 90;
  else if (t === '—') pause = 120;
  else if (t.length > 1) pause = 60; // 整块表情

  return Math.round(base * (0.78 + Math.random() * 0.44) + pause * ps);
}

// 「整条就是表情/颜文字」判断，按完整文本算，避免打字到一半被误判成大颜文字
function isPureEmojiText(full) {
  const src = String(full == null ? '' : full);
  if (!src) return false;
  const stripped = src.replace(REVEAL_STICKER_RE, '').replace(/\s/g, '');
  if (stripped === '') return /\[表情[:：]/.test(src) || src.trim() !== '';
  if (stripped === '🌟' || stripped === '⭐' || stripped === '★') return true;
  return !/[a-zA-Z0-9\u4e00-\u9fa5]/.test(stripped);
}

/**
 * 消息正文的唯一渲染入口：表情替换、大颜文字、纯表情无底色，全部在这里。
 * text = 本次要显示的文字（打字机进行中时是前缀），fullText = 完整文字（用于判断是否纯表情）。
 * 返回 { noBg }，由调用方决定气泡是否去掉底色。
 */
function paintMessageContent(host, text, fullText, keyword) {
  let html = String(text == null ? '' : text);
  const full = String(fullText == null ? html : fullText);
  const fullNoSpace = full.replace(REVEAL_STICKER_RE, '').replace(/\s/g, '');
  const fullIsOnlySticker = /\[表情[:：]/.test(full) && fullNoSpace === '';

  let isPureEmoji = false;
  if (html.includes('[表情:')) {
    html = html.replace(/\[表情[:：]\s*([^\]\|]+)(?:\|([^\]]+))?\]/g, function (match, name, imgName) {
      const cleanName = name.trim();
      if (STICKER_TYPES.includes(cleanName)) {
        isPureEmoji = true;
        if (imgName) return `<img class="sticker-img" src="./小星表情包/${cleanName}/${imgName}" alt="${cleanName}">`;
        // 打字机进行中：用过一次就用同一张，避免边打边闪
        if (revealState && revealStickerCache[cleanName]) {
          return `<img class="sticker-img" src="${revealStickerCache[cleanName]}" alt="${cleanName}">`;
        }
        return `<img data-sticker-type="${cleanName}" class="sticker-img" src="" alt="${cleanName}">`;
      }
      return match;
    });
  }

  if (fullIsOnlySticker) {
    isPureEmoji = true;
  } else if (fullNoSpace === '🌟' || fullNoSpace === '⭐' || fullNoSpace === '★') {
    isPureEmoji = true;
    html = `<div class="big-kaomoji star-3d">${html}</div>`;
  } else {
    const isKaomoji = fullNoSpace.length > 0 && !/[a-zA-Z0-9\u4e00-\u9fa5]/.test(fullNoSpace);
    if (isKaomoji) {
      isPureEmoji = true;
      html = `<div class="big-kaomoji" style="filter: hue-rotate(${[300, 80][Math.floor(Math.random() * 2)]}deg);">${html}</div>`;
    }
  }

  host.innerHTML = html;
  if (keyword) highlightKeyword(host, keyword);

  const noBg = isPureEmoji && (html.startsWith('<img') || html.startsWith('<div class="big-kaomoji"'));
  return { noBg: noBg };
}

function renderMessages() {
  const list = document.getElementById('messages');
  if (!list) return;

  const searchEl = document.getElementById('chatSearch');
  const keyword = searchEl ? searchEl.value.trim().toLowerCase() : '';
  const filtered = keyword ? chatHistory.filter(m => String(m.content || '').toLowerCase().includes(keyword)) : chatHistory;
  list.innerHTML = '';

  if (keyword && !filtered.length) {
    list.innerHTML = '<p class="empty-hint">没有找到相关消息。</p>';
    return;
  }

  if (keyword) {
    const resultTip = document.createElement('div');
    resultTip.className = 'day-divider';
    resultTip.style.color = '#d35400'; 
    resultTip.textContent = `🔍 找到 ${filtered.length} 条相关聊天`;
    list.appendChild(resultTip);
  }

  let lastRenderedDate = null;

  // 触摸状态记录独立于聊天消息：按时间并入渲染流，搜索时不混进结果
  const timeline = filtered.map(m => ({ m: m, t: Number(m.time) || 0 }));
  if (!keyword) touchLog.forEach(e => timeline.push({ touch: e, t: Number(e.time) || 0 }));
  timeline.sort((a, b) => a.t - b.t);

  timeline.forEach((node) => {
    if (node.touch) { renderTouchStatusItem(list, node.touch); return; }
    const m = node.m;
    const msgDate = new Date(m.time || Date.now());
    const dateString = msgDate.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });

    if (dateString !== lastRenderedDate) {
      const divider = document.createElement('div');
      divider.className = 'day-divider'; 
      const todayStr = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
      const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });

      if (dateString === todayStr) divider.textContent = '今天';
      else if (dateString === yesterdayStr) divider.textContent = '昨天';
      else divider.textContent = dateString;

      list.appendChild(divider);
      lastRenderedDate = dateString;
    }

    const item = document.createElement('div');
    item.className = m.role === 'user' ? 'message user-message' : 'message assistant-message';
    
    if (m.id != null) item.setAttribute('data-id', m.id);

    if (keyword && m.id != null) {
      item.classList.add('search-result-item');
      item.title = "点击跳转到上下文";
      item.onclick = (e) => {
        if (e.target.tagName === 'IMG' || e.target.className === 'del-btn') return;
        // 语音气泡里的播放/进度/展开、按需翻译入口都是控件，点它们不应该跳走
        if (e.target.closest && e.target.closest('.vb-wrap, .vb-toggle, .vb-text, .translate-btn')) return;
        jumpToMessage(m.id);
      };
    }

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.style.fontSize = (settings.fontSize || 14) + 'px';

    // 星星的小沉默：占位 / 揭晓，时间戳照旧显示；不参与表情、语音、英语等分支
    if (m.silent) {
      renderSilentBubble(bubble, m);
      if (settings.showTime !== false && m.time) {
        const time = document.createElement('small');
        time.className = 'message-time';
        time.textContent = msgDate.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        bubble.appendChild(time);
      }
      item.appendChild(bubble);
      list.appendChild(item);
      return;
    }

    if (m.image) {
      const img = document.createElement('img');
      img.src = m.image; img.alt = '聊天照片';
      img.style.maxWidth = '220px'; img.style.borderRadius = '12px';
      img.style.marginBottom = m.content ? '8px' : '0';
      bubble.appendChild(img);
      if (!m.content) bubble.classList.add('no-bg');
    }

    // 语音消息：正文是转写文字，默认折叠；播放/进度/时长由语音气泡自己管
    const isVoiceMsg = m.type === 'voice' || (m.role === 'user' && !!m.audioClipId);
    // 正在逐字显示的那条：只渲染到当前进度；其余消息始终整段显示
    const revealing = revealIsTarget(m.id) && !keyword;
    if (isVoiceMsg) {
      if (window.VoiceBubble) {
        window.VoiceBubble.render(bubble, m, { keyword: keyword });
      } else {
        bubble.textContent = m.content || '（语音消息）';
      }
    } else if (m.content) {
      const text = displayTextOfMessage(m);
      const shown = revealing ? revealShownText(text) : text;

      const content = document.createElement('div');
      content.setAttribute('data-reveal-host', '1');
      const info = paintMessageContent(content, shown, text, keyword);
      if (info.noBg) bubble.classList.add('no-bg');
      bubble.appendChild(content);
    }

    if (settings.showTime !== false && m.time) {
      const time = document.createElement('small');
      time.className = 'message-time';
      const isToday = dateString === new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
      const timeOptions = { hour: '2-digit', minute: '2-digit' };
      
      if (!isToday) {
        time.textContent = msgDate.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) + ' ' + msgDate.toLocaleTimeString('zh-CN', timeOptions);
      } else {
        time.textContent = msgDate.toLocaleTimeString('zh-CN', timeOptions);
      }
      bubble.appendChild(time);
    }

    // 按需翻译入口：仅双语模式 + 助手非空正文 + 还没有译文时出现。
    // 中文模式不显示任何英文相关内容；翻译中禁点，失败后原地变成重试入口。
    const canTranslate = settings.showEnglish === true && m.role === 'assistant'
      && !m.silent && !isVoiceMsg && !revealing
      && String(m.content || '').trim() && !String(m.englishContent || '').trim();
    if (canTranslate) {
      const status = translationStatusOf(m);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'translate-btn' + (status === 'error' ? ' translate-btn-error' : '');
      if (m.id != null) btn.setAttribute('data-translate-id', String(m.id));
      btn.textContent = status === 'pending' ? '翻译中…' : (status === 'error' ? '翻译失败，重试' : '翻译成英文');
      btn.disabled = status === 'pending';
      btn.onclick = (e) => { e.stopPropagation(); translateMessageById(m.id); };
      bubble.appendChild(btn);
    }

    if (m.role === 'assistant' && m.audioData) {
      const playBtn = document.createElement('span');
      // 独立类名：重播入口不依赖 hover 才显示（手机上根本没有 hover）
      playBtn.className = 'replay-btn';
      playBtn.innerHTML = '🔊';
      playBtn.title = '重播语音';
      playBtn.style.marginLeft = '8px';
      playBtn.style.cursor = 'pointer';
      playBtn.onclick = (e) => {
        e.stopPropagation();
        stopCurrentSpeech();
        if (window.VoiceBubble) { try { window.VoiceBubble.stop(); } catch (err) {} }
        const audio = new Audio(m.audioData);
        currentAudio = audio;
        audio.play();
      };
      bubble.appendChild(playBtn);
    }

    if (m.role === 'user' && m.id != null) {
      const delBtn = document.createElement('span');
      delBtn.className = 'del-btn';
      delBtn.textContent = '×'; delBtn.title = '删除这条消息';
      delBtn.onclick = () => deleteMsg(m.id);
      bubble.appendChild(delBtn);
    }

    item.appendChild(bubble);
    list.appendChild(item);
  });

  // 触摸触发的 AI 请求：轻量「正在输入中」提示，与上面的状态记录分开
  if (touchTyping && !keyword) {
    ensureTouchStatusStyle();
    const item = document.createElement('div');
    item.className = 'message touch-typing-message';
    const line = document.createElement('span');
    line.className = 'touch-typing-line';
    line.innerHTML = '正在输入中<i>.</i><i>.</i><i>.</i>';
    item.appendChild(line);
    list.appendChild(item);
  }

  if (isTyping && !keyword) {
    const item = document.createElement('div');
    item.className = 'message assistant-message';
    const bubble = document.createElement('div');
    bubble.className = 'bubble typing';
    bubble.textContent = '对方正在输入...';
    bubble.style.fontSize = (settings.fontSize || 14) + 'px';
    item.appendChild(bubble);
    list.appendChild(item);
  }

  // 上次没拿到回复：给一个只重发请求的入口，不会再多插一条用户消息
  if (!isTyping && !keyword && canRetryReply()) {
    const item = document.createElement('div');
    item.className = 'message assistant-message chat-retry-message';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chat-retry-btn';
    btn.textContent = '没有收到回复，点这里再试一次';
    btn.onclick = (e) => { e.stopPropagation(); retryReply(); };
    item.appendChild(btn);
    list.appendChild(item);
  }

  resolveStickerImgs(list);

  list.scrollTop = list.scrollHeight;
}

// 表情图占位转真实图片：整表渲染与打字机局部重绘共用
function resolveStickerImgs(root) {
  if (!root) return;
  const stickerImgs = root.querySelectorAll('img[data-sticker-type]');
  stickerImgs.forEach(async (img) => {
    const type = img.getAttribute('data-sticker-type');
    const src = await getRandomSticker(type);
    if (src) {
      revealStickerCache[type] = src;
      img.src = src;
      img.removeAttribute('data-sticker-type');
    } else { img.outerHTML = `[${type}]`; }
  });
}

// 主动互动的沉默识别：沿用「空正文 / 保持安静 / 不说了」，其余交给与主聊天共用的纯函数。
// 这样「动作描写 + 裸标记」也会被识别为沉默，不会被误存成一条普通回复。
function isSilentIdleReply(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t || /^(?:保持安静|不说了)$/.test(t)) return true;
  return analyzeSilentReply(t).silent;
}

// 🌟 修改特殊互动，接入双语和语音
// opts.idle=true：主动关心。空回复=沉默；只用模型自带英文，不额外发起翻译请求。
// opts.onOutcome(reason)：把结果回告调用方，reason = 'spoken' | 'silent' | 'ai-error'。
async function callSpecialAI(prompt, opts) {
  const o = opts || {};
  const tell = function (reason) {
    try { if (typeof o.onOutcome === 'function') o.onOutcome(reason); } catch (e) {}
  };
  try {
    // dialogue：本调用是与用户的直接对白（主动关心/早晚安），需要统一表达规范；
    // 未显式开启的调用方（掷骰/口袋/互动等既有入口）保持原样，不继承规则。
    const starOpts = Object.assign(
      {},
      o.dialogue ? { style: true } : {},
      o.allowEmpty ? { allowEmpty: true } : {}
    );
    const raw = await callStar(prompt, 15, Object.keys(starOpts).length ? starOpts : undefined);
    // 主动关心：与主聊天共用同一套标记识别。纯沉默 / 动作描写 + 标记 → 不落库；
    // 正常正文夹带标记 → 剥掉标记后照常落库，绝不把内部标记显示出来。
    if (o.idle && isSilentIdleReply(raw)) { tell('silent'); return ''; }

    let chineseReply = String(raw == null ? '' : raw);
    let englishReply = '';
    if (o.idle) {
      const split = chineseReply.indexOf('|||');
      if (split !== -1) {
        englishReply = chineseReply.slice(split + 3).trim();
        chineseReply = chineseReply.slice(0, split).trim();
      }
      if (isSilentIdleReply(chineseReply)) { tell('silent'); return ''; }
      const cleaned = analyzeSilentReply(chineseReply);
      if (cleaned.hasMarker) {
        if (!cleaned.text.trim()) { tell('silent'); return ''; }
        chineseReply = cleaned.text;
      }
    }

    const lockedReply = await lockStickerInText(chineseReply);
    if (o.idle && !String(lockedReply || '').trim()) { tell('silent'); return ''; }

    const message = { role: 'assistant', content: lockedReply, englishContent: englishReply, time: Date.now() };
    if (o.idle) message.source = 'idle';
    message.id = await addToStore('messages', message);
    chatHistory.push(message);
    beginTypewriterReveal(message);
    renderMessages();

    if (o.idle && englishReply) {
      // 主动消息最多一次 AI 请求：模型没给英文就不朗读，也不额外翻译。
      requestAndPlaySpeech(englishReply, message.id);
    }
    // 特殊互动与主聊天一样只生成中文；英文由用户在气泡上按需翻译，不在这里发请求。
    tell('spoken');
    return lockedReply;
  } catch (e) {
    if (o.idle) {
      // 请求失败与「模型主动沉默」区分开：都不落库、不提示，但原因码不同。
      tell('ai-error');
      return '';
    }
    toast('星星暂时没有回应：' + e.message);
    return '';
  }
}

// 🌟 修改跨场景消息，接入翻译和语音
async function consumePendingChatMessage() {
  let raw = null; let storage = null;
  try { raw = localStorage.getItem('pending_chat_message'); if (raw) storage = localStorage; } catch {}
  if (!raw) { try { raw = sessionStorage.getItem('pending_chat_message'); if (raw) storage = sessionStorage; } catch {} }
  if (!raw || !storage) return;
  let content = raw; let token = null; let source = 'cross-scene'; let english = null; let game = null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.content === 'string') {
      content = parsed.content;
      token = parsed.token || null;
      source = parsed.source || 'cross-scene';
      if (typeof parsed.english === 'string') english = parsed.english;
      if (parsed.game && typeof parsed.game === 'object') game = parsed.game;
    }
  } catch { }
  if (!content || !content.trim()) { try { storage.removeItem('pending_chat_message'); } catch {} return; }
  try {
    const existing = await getAllFromStore('messages');
    const dup = existing.some(m => { if (token) return m.pendingToken === token; return m.pendingSource === content && Date.now() - (m.time || 0) < 120000; });
    if (dup) { try { storage.removeItem('pending_chat_message'); } catch {} return; }
  } catch (e) { console.warn('去重检查失败，继续写入：', e); }
  
  // 跨场景消息：沿用游戏侧自带的英文；没有就留空，双语模式下由用户点翻译入口再请求，
  // 不在落库前偷偷多打一次翻译 API。
  const englishContent = typeof english === 'string' ? english : '';

  const messageObj = { role: 'assistant', content, englishContent, time: Date.now(), source };
  if (game) messageObj.game = game;
  if (token) messageObj.pendingToken = token; else messageObj.pendingSource = content;
  try { messageObj.id = await addToStore('messages', messageObj); } catch (e) { console.error('跨场景消息写入失败：', e); return; }
  try { storage.removeItem('pending_chat_message'); } catch {}
  try { if (storage === localStorage) sessionStorage.removeItem('pending_chat_message'); else localStorage.removeItem('pending_chat_message'); } catch {}
  if (!chatHistory.some(m => m.id === messageObj.id)) { chatHistory.push(messageObj); }

  // P5.2：游戏消息真的落库后，才登记「双方一起玩过」这一条真实经历（id 用消息 id → 天然去重）
  if (game && (game.name || game.id) && messageObj.id != null && window.LifeEvents && window.LifeEvents.record) {
    try {
      window.LifeEvents.record({
        id: 'game:shared:' + messageObj.id,
        at: messageObj.time,
        source: 'playground',
        type: 'game.shared',
        title: String(game.name || ''),
        meta: { game: String(game.id || '') },
      });
    } catch (e) { /* 记录失败不影响消息本身 */ }
  }

  // 记住这次互动，下一句话让星星接着聊，而不是重新问结果（只用一次）
  if (game && (game.name || game.result)) pendingGameContext = game;

  showPage('chat');
  
  if (englishContent) {
    requestAndPlaySpeech(englishContent, messageObj.id);
  }
  if (typeof toast === 'function') toast('💬 收到小星的跨场景消息');
}

async function deleteMsg(id) {
  if (isSending) { toast('正在发送中，请稍后。'); return; }
  if (!confirm('确定要删除这条记录吗？')) return;
  const target = chatHistory.find(m => m.id === id);
  try {
    await new Promise((res, rej) => {
      const tx = db.transaction('messages', 'readwrite');
      tx.objectStore('messages').delete(id);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    chatHistory = chatHistory.filter(m => m.id !== id);
    chatHistoryWindowState = null;
    // 语音消息：确认没有别的消息还在引用这段音频，才删原始文件；别的栏目的素材不受影响
    if (target && target.audioClipId && window.VoiceStore) {
      const stillUsed = chatHistory.some(m => m && m.audioClipId === target.audioClipId);
      if (!stillUsed) {
        if (window.VoiceBubble) { try { window.VoiceBubble.stop(); } catch (e) {} }
        await window.VoiceStore.remove(target.audioClipId).catch(() => {});
      }
    }
    renderMessages();
    toast('已删除。');
  } catch (e) { toast('删除失败：' + e.message); }
}

async function clearChat() {
  if (isSending) { toast('正在发送中，请稍后再清空。'); return; }
  if (!confirm('确定清空聊天记录吗？')) return;
  isSending = true;
  try {
    await clearStore('messages');
    chatHistory = [];
    chatHistoryWindowState = null;
    // 跨轮检索会话指向的消息已经不在了：一并作废，避免下一轮继承一堆取不到原文的 id
    recallSessionReset();
    // 聊天记录清空后，语音消息的原始音频也一并清掉（声音素材库是另一个库，不受影响）
    if (window.VoiceBubble) { try { window.VoiceBubble.stop(); } catch (e) {} }
    if (window.VoiceStore) await window.VoiceStore.clear();
    const searchEl = document.getElementById('chatSearch');
    if (searchEl) searchEl.value = '';
    renderMessages();
    toast('聊天记录已清空。');
  } catch (e) { toast('清空失败：' + e.message); } finally { isSending = false; }
}

async function loadMessages() {
  try {
    chatHistory = await getAllFromStore('messages');
    chatHistoryWindowState = null;
    chatHistory.sort((a, b) => (a.time || 0) - (b.time || 0));
    messagesLoadFailed = false;
    // 只有连接真实存在时读到的结果才算「加载完成」：
    // getAllFromStore 在 db 为 null 时会静默返回 []，那不是「没有历史」，而是「没读到」。
    messagesLoaded = !!db;
  } catch (e) {
    console.error('读取聊天记录失败', e);
    chatHistory = [];
    chatHistoryWindowState = null;
    messagesLoadFailed = true;
    messagesLoaded = false;
  }
  renderMessages();
}

// 读聊天记录失败时绝不能顺手清理音频：那会把还在用的录音当成孤儿删掉
let messagesLoadFailed = false;
// 历史是否真正完成过一次成功加载（供历史检索判断能否用内存副本，不对外暴露）
let messagesLoaded = false;
// 首次/导入后的加载任务：发送前可等待它完成，避免空历史请求
let messagesLoadPromise = null;

async function loadMessagesTracked() {
  const p = loadMessages();
  messagesLoadPromise = p;
  try { return await p; } finally { if (messagesLoadPromise === p) messagesLoadPromise = null; }
}

async function ensureMessagesLoaded() {
  if (messagesLoaded || messagesLoadFailed) return;
  if (messagesLoadPromise) { await messagesLoadPromise; return; }
  if (!db) return;
  await loadMessagesTracked();
}

// 语音入口由 voice-recorder.js 提供；万一脚本没加载，点按钮要给出提示而不是静默无反应
if (typeof window.openVoiceRecorder !== 'function') {
  window.openVoiceRecorder = function () { toast('语音面板没加载，请刷新页面。'); };
}

function handleChatKey(event) {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(); }
}

let isSavingDiary = false;
let isRetryingTodayLetter = false;

async function saveDiary() {
  if (isSavingDiary) { toast('上一封信还在寄，请稍等。'); return; }
  const input = document.getElementById('diaryInput');
  const photoInput = document.getElementById('diaryPhoto');
  const content = input?.value.trim() || '';
  const file = photoInput?.files?.[0];
  if (!content && !file) { toast('写点什么，或者选一张照片吧。'); return; }
  isSavingDiary = true;
  try {
    let photo = null;
    if (file) { try { photo = await readImage(file, 1200); } catch (e) { toast(e.message); return; } }
    const record = { title: document.getElementById('diaryTitle')?.value.trim() || '今日来信', content, photo, createdAt: Date.now(), date: today(), reply: '', replyError: null, replyMessageId: null, type: 'today-letter' };
    const id = await addToStore('diaries', record);
    try { if (window.LifeEvents) window.LifeEvents.record({ id: 'room:diary:' + record.createdAt, at: record.createdAt, source: 'room', type: 'diary.write', title: '' }); } catch (e) {}
    if (input) input.value = '';
    if (photoInput) photoInput.value = '';
    const titleInput = document.getElementById('diaryTitle');
    if (titleInput) titleInput.value = '';
    renderDiaries(); toast('信寄到了。星星正在读。');
    respondToTodayLetter(id, record).catch(err => { updateStore('diaries', id, { replyError: err.message }).catch(() => {}).finally(() => renderDiaries()); });
  } catch (e) { toast('保存信件失败：' + e.message); } finally { isSavingDiary = false; }
}

function commitTodayLetterReply(diaryId, reply, message) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['diaries', 'messages'], 'readwrite');
    const diaries = tx.objectStore('diaries'); const messages = tx.objectStore('messages'); const getReq = diaries.get(diaryId);
    let messageId = null; let settled = false;
    const fail = (err) => { if (settled) return; settled = true; try { tx.abort(); } catch {} reject(err); };
    getReq.onsuccess = () => {
      const existing = getReq.result;
      if (!existing) { fail(new Error('信件不存在')); return; }
      if (existing.replyMessageId) { messageId = existing.replyMessageId; diaries.put({ ...existing, replyError: null }); return; }
      const updated = { ...existing, reply, repliedAt: Date.now(), replyError: null };
      diaries.put(updated);
      const addReq = messages.add(message);
      addReq.onsuccess = () => { messageId = addReq.result; diaries.put({ ...updated, replyMessageId: messageId }); };
      addReq.onerror = () => fail(addReq.error);
    };
    getReq.onerror = () => fail(getReq.error);
    tx.oncomplete = () => { if (settled) return; settled = true; resolve(messageId); };
    tx.onerror = () => fail(tx.error);
    tx.onabort = () => fail(tx.error || new Error('事务已中止'));
  });
}

async function respondToTodayLetter(id, letter) {
  const content = assemblePathMessages({
    taskInstruction: rcTask('todayLetter') + getDialogueStylePrompt(),
    blocks: [],
    history: [],
    currentTurn: {
      role: 'user',
      content: buildVisionContent(`信件标题：${letter.title}\n信件内容：${letter.content || '她只寄来了一张照片。'}\n请阅读这封信并回应。`, letter.photo)
    }
  });
  const reply = updateMood(await callAI(content, { requestType: rcRequestType('todayLetter') }));
  const lockedReply = await lockStickerInText(reply);
  const message = { role: 'assistant', content: lockedReply, time: Date.now(), source: 'today-letter', sourceId: id };
  const messageId = await commitTodayLetterReply(id, lockedReply, message);
  if (messageId) {
    const exists = chatHistory.some(m => m.id === messageId);
    if (!exists) { message.id = messageId; chatHistory.push(message); chatHistory.sort((a, b) => (a.time || 0) - (b.time || 0)); }
  }
  renderDiaries(); renderMessages(); toast('星星读完信，给你回信了。');
}

async function retryTodayLetter(id) {
  if (isRetryingTodayLetter) { toast('正在重试，请稍候。'); return; }
  const numericId = Number(id); isRetryingTodayLetter = true;
  try {
    const records = await getAllFromStore('diaries'); const letter = records.find(x => x.id === numericId);
    if (!letter) { toast('信件不存在。'); return; }
    if (letter.reply && letter.replyMessageId) { toast('这封信已经回复过了。'); return; }
    await updateStore('diaries', numericId, { replyError: null });
    await respondToTodayLetter(numericId, letter);
  } catch (e) { await updateStore('diaries', numericId, { replyError: e.message }).catch(() => {}); toast('重试失败：' + e.message); } 
  finally { isRetryingTodayLetter = false; renderDiaries(); }
}

function diaryCreatedAt(record) {
  if (record.createdAt) return record.createdAt;
  if (record.date) return new Date(record.date + 'T12:00:00').getTime();
  return Date.now();
}

async function renderDiaries() {
  const list = document.getElementById('diaryList');
  if (!list) return;
  let records = [];
  try { records = await getAllFromStore('diaries'); } catch (e) { list.innerHTML = '<p class="empty-hint">读取信件失败。</p>'; return; }
  // 今日便签（type:'note-day'）与今日来信共用 diaries 表：这里必须精确排除，否则会污染时光邮册与日记摘要。
  // 判断只认 type === 'note-day'，旧记录没有 type 字段，仍按今日来信处理。
  records = records.filter(r => !(r && r.type === 'note-day'));
  records.sort((a, b) => diaryCreatedAt(b) - diaryCreatedAt(a));
  diarySummaryCache = records.slice(0, 3).map(d => `《${d.title || '今日来信'}》${(d.content || d.text || '').slice(0, 100)}`).join('\n');
  list.innerHTML = '';
  if (!records.length) { list.innerHTML = '<p class="empty-hint">这里还没有今日来信。</p>'; return; }
  records.forEach(record => {
    const card = document.createElement('article');
    card.className = 'diary-card';
    const title = document.createElement('h3');
    title.textContent = record.title || '今日来信';
    card.appendChild(title);
    const date = document.createElement('small');
    date.textContent = new Date(diaryCreatedAt(record)).toLocaleString('zh-CN');
    card.appendChild(date);
    const bodyText = record.content || record.text || '';
    if (bodyText) {
      const body = document.createElement('p');
      body.textContent = bodyText;
      card.appendChild(body);
    }
    if (record.photo) {
      const img = document.createElement('img');
      img.src = record.photo; img.alt = '来信照片';
      img.style.maxWidth = '100%'; img.style.borderRadius = '12px';
      card.appendChild(img);
    }
    if (record.reply) {
      const reply = document.createElement('p');
      reply.className = 'letter-reply';
      reply.textContent = '星星的回信：' + record.reply;
      card.appendChild(reply);
    } else {
      const pending = document.createElement('p');
      pending.textContent = record.replyError ? '星星还没来得及回复。' : '星星正在读这封信……';
      card.appendChild(pending);
      if (record.replyError) {
        const retryBtn = document.createElement('button');
        retryBtn.textContent = '让星星重新读';
        retryBtn.onclick = () => retryTodayLetter(record.id);
        card.appendChild(retryBtn);
      }
    }
    list.appendChild(card);
  });
}

let isWritingStarDiary = false;
async function writeStarDiary() {
  if (isWritingStarDiary) { toast('上一篇日记还在写，请稍等。'); return; }
  if (!apiKey) { toast('请先填写 API Key。'); return; }
  isWritingStarDiary = true;
  try {
    const messages = assemblePathMessages({
      taskInstruction: rcTask('diary'),
      blocks: [],
      history: trimHistoryForAI(chatHistory.slice(-30)),
      currentTurn: { role: 'user', content: '写一篇属于你自己的日记，记录最近和用户相处的生活与感受。' }
    });
    const content = updateMood(await callAI(messages, { requestType: rcRequestType('diary') }));
    await addToStore('starDiaries', { title: '星星的日记', content, createdAt: Date.now(), date: today() });
    renderStarDiaries(); toast('星星的日记写好了。');
  } catch (e) { toast('日记没有写成：' + e.message); } finally { isWritingStarDiary = false; }
}
async function renderStarDiaries() {
  const list = document.getElementById('starDiaryList');
  if (!list) return;
  let records = [];
  try { records = await getAllFromStore('starDiaries'); } catch (e) { list.innerHTML = '<p class="empty-hint">读取日记失败。</p>'; return; }
  records.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  list.innerHTML = '';
  if (!records.length) { list.innerHTML = '<p class="empty-hint">星星还没有写过日记。</p>'; return; }
  records.forEach(record => {
    const card = document.createElement('article');
    card.className = 'diary-card';
    const title = document.createElement('h3');
    title.textContent = record.title;
    card.appendChild(title);
    const date = document.createElement('small');
    date.textContent = new Date(record.createdAt || Date.now()).toLocaleString('zh-CN');
    card.appendChild(date);
    const body = document.createElement('p');
    body.textContent = record.content;
    card.appendChild(body);
    list.appendChild(card);
  });
}

let isSendingFutureLetter = false;
async function sendFutureLetter() {
  if (isSendingFutureLetter) { toast('上一封信还在寄，请稍等。'); return; }
  const titleInput = document.getElementById('futureTitle');
  const textInput = document.getElementById('futureInput');
  const dateInput = document.getElementById('futureDate');
  const photoInput = document.getElementById('futurePhoto');
  const title = titleInput?.value.trim() || '一封未来的信';
  const content = textInput?.value.trim() || '';
  const file = photoInput?.files?.[0];
  const openDate = dateInput?.value;
  if (!content && !file) { toast('写点内容或附上一张照片吧。'); return; }
  if (!openDate || openDate <= today()) { toast('请选择明天或之后的日期。'); return; }
  isSendingFutureLetter = true;
  try {
    let photo = null;
    if (file) { try { photo = await readImage(file, 1200); } catch (e) { toast(e.message); return; } }
    const recent = await getAllFromStore('futureLetters');
    const isDuplicate = recent.some(r => r.title === title && r.content === content && r.openDate === openDate && (r.photo || null) === (photo || null) && Date.now() - (r.createdAt || 0) < 10000);
    if (isDuplicate) { toast('这封信刚刚已经寄过了。'); return; }
    const record = { title, content, photo, createdAt: Date.now(), openAt: new Date(openDate + 'T09:00:00').getTime(), openDate, status: 'sealed', openedAt: null, reply: '', replyStatus: 'waiting', replyMessageId: null };
    await addToStore('futureLetters', record);
    if (titleInput) titleInput.value = '';
    if (textInput) textInput.value = '';
    if (photoInput) photoInput.value = '';
    renderFutureLetters(); toast('信已经寄出。到日期星星就会打开。');
  } catch (e) { toast('寄信失败：' + e.message); } finally { isSendingFutureLetter = false; }
}

const FUTURE_LETTER_TIMEOUT = 5 * 60 * 1000;
const FUTURE_LETTER_HEARTBEAT_INTERVAL = 30 * 1000;
const FUTURE_LETTER_MAX_ATTEMPTS = 5;
const FUTURE_LETTER_BASE_BACKOFF = 60 * 1000;
const FUTURE_LETTER_MAX_BACKOFF = 30 * 60 * 1000;
const FUTURE_LETTER_CHECK_INTERVAL = 60 * 1000;

let isProcessingFutureLetters = false;
let futureLetterTimer = null;
const pendingRetryIds = new Set();

const FUTURE_LETTER_TAB_ID = (() => {
  try {
    let id = sessionStorage.getItem('starTabId');
    if (!id) { id = 'tab_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10); sessionStorage.setItem('starTabId', id); }
    return id;
  } catch { return 'tab_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10); }
})();

function futureLetterBackoff(attempts) {
  const exp = Math.max(0, (attempts || 1) - 1);
  return Math.min(FUTURE_LETTER_BASE_BACKOFF * Math.pow(2, exp), FUTURE_LETTER_MAX_BACKOFF);
}

function claimFutureLetter(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('futureLetters', 'readwrite');
    const store = tx.objectStore('futureLetters');
    const getReq = store.get(id);
    let settled = false;
    let result = { claimed: false, record: null };
    const now = Date.now();
    const fail = (err) => { if (settled) return; settled = true; try { tx.abort(); } catch {} reject(err); };
    getReq.onsuccess = () => {
      const rec = getReq.result;
      if (!rec) { result = { claimed: false, record: null }; return; }
      if (rec.replyStatus === 'done' || rec.replyStatus === 'failed') { result = { claimed: false, record: rec }; return; }
      const heartbeat = rec.processingHeartbeat || rec.replyStartedAt || 0;
      const isMine = rec.processingOwner === FUTURE_LETTER_TAB_ID;
      const isStale = now - heartbeat > FUTURE_LETTER_TIMEOUT;
      if (rec.replyStatus === 'processing' && !isMine && !isStale) { result = { claimed: false, record: rec }; return; }
      const attempts = (rec.replyAttempts || 0) + 1;
      const updated = { ...rec, replyStatus: 'processing', replyAttempts: attempts, replyStartedAt: rec.replyStartedAt || now, processingOwner: FUTURE_LETTER_TAB_ID, processingHeartbeat: now, nextReplyAttemptAt: 0 };
      store.put(updated);
      result = { claimed: true, record: updated };
    };
    getReq.onerror = () => fail(getReq.error);
    tx.oncomplete = () => { if (settled) return; settled = true; resolve(result); };
    tx.onerror = () => fail(tx.error);
    tx.onabort = () => fail(tx.error || new Error('事务已中止'));
  });
}

function touchFutureLetterHeartbeat(id) {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('futureLetters', 'readwrite');
      const store = tx.objectStore('futureLetters');
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const rec = getReq.result;
        if (rec && rec.processingOwner === FUTURE_LETTER_TAB_ID && rec.replyStatus === 'processing') {
          store.put({ ...rec, processingHeartbeat: Date.now() });
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch { resolve(); }
  });
}

async function releaseFutureLetterOwnership(id, patch) {
  try {
    const tx = db.transaction('futureLetters', 'readwrite');
    const store = tx.objectStore('futureLetters');
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const rec = getReq.result;
      if (!rec) return;
      if (rec.processingOwner && rec.processingOwner !== FUTURE_LETTER_TAB_ID) return;
      store.put({ ...rec, processingOwner: null, processingHeartbeat: 0, ...patch });
    };
  } catch {}
}

async function retryFutureLetter(id) {
  const numericId = Number(id);
  if (!numericId) return;
  if (isProcessingFutureLetters) { pendingRetryIds.add(numericId); toast('稍后会自动重试这封。'); return; }
  await updateStore('futureLetters', numericId, { replyStatus: 'pending', replyStartedAt: 0, nextReplyAttemptAt: 0, replyAttempts: 0, replyError: null, processingOwner: null, processingHeartbeat: 0 });
  await processDueFutureLetters();
}

async function flushPendingRetries() {
  if (!pendingRetryIds.size) return false;
  const ids = Array.from(pendingRetryIds); pendingRetryIds.clear(); let touched = false;
  for (const id of ids) {
    try {
      const records = await getAllFromStore('futureLetters');
      const target = records.find(r => r.id === id);
      if (!target || target.replyStatus === 'done') continue;
      await updateStore('futureLetters', id, { replyStatus: 'pending', replyStartedAt: 0, nextReplyAttemptAt: 0, replyAttempts: 0, replyError: null, processingOwner: null, processingHeartbeat: 0 });
      touched = true;
    } catch (e) { console.error('处理重试失败', e); }
  }
  return touched;
}

async function processDueFutureLetters() {
  if (isProcessingFutureLetters) return;
  isProcessingFutureLetters = true;
  try {
    const now = Date.now();
    const all = await getAllFromStore('futureLetters');
    for (const record of all) {
      if (record.status === 'sealed' && record.openAt <= now) {
        await updateStore('futureLetters', record.id, { status: 'opened', openedAt: now, replyStatus: 'pending', replyAttempts: 0, replyStartedAt: 0, nextReplyAttemptAt: 0, processingOwner: null, processingHeartbeat: 0 });
      }
    }
    const afterOpen = await getAllFromStore('futureLetters');
    for (const record of afterOpen) {
      if (record.replyStatus !== 'processing') continue;
      const heartbeat = record.processingHeartbeat || record.replyStartedAt || 0;
      if (now - heartbeat > FUTURE_LETTER_TIMEOUT) {
        await updateStore('futureLetters', record.id, { replyStatus: 'pending', replyStartedAt: 0, processingOwner: null, processingHeartbeat: 0 });
      }
    }
    const due = await getAllFromStore('futureLetters');
    for (const record of due) {
      if (record.status !== 'opened' || record.replyStatus === 'done' || record.replyStatus === 'processing') continue;
      if ((record.replyAttempts || 0) >= FUTURE_LETTER_MAX_ATTEMPTS) continue;
      if (record.nextReplyAttemptAt && record.nextReplyAttemptAt > Date.now()) continue;
      await processFutureLetterReply(record);
    }
  } catch (e) { console.error('未来信处理失败', e); } 
  finally {
    isProcessingFutureLetters = false;
    renderFutureLetters(); renderTimeReplies();
    const touched = await flushPendingRetries();
    if (touched) setTimeout(() => processDueFutureLetters(), 0);
  }
}

async function processFutureLetterReply(record) {
  const claim = await claimFutureLetter(record.id).catch(() => ({ claimed: false }));
  if (!claim.claimed) return;
  const claimed = claim.record;
  const heartbeatTimer = setInterval(() => { touchFutureLetterHeartbeat(claimed.id); }, FUTURE_LETTER_HEARTBEAT_INTERVAL);
  let reply;
  try {
    const messages = assemblePathMessages({
      taskInstruction: rcTask('futureLetter') + getDialogueStylePrompt(),
      blocks: [],
      history: [],
      currentTurn: {
        role: 'user',
        content: buildVisionContent(`信件标题：${claimed.title}\n信件内容：${claimed.content || '她寄来了一张照片。'}\n请回应这封未来的信。`, claimed.photo)
      }
    });
    reply = updateMood(await callAI(messages, { requestType: rcRequestType('futureLetter') }));
  } catch (e) {
    clearInterval(heartbeatTimer);
    await releaseFutureLetterOwnership(claimed.id, { replyStatus: 'failed', replyStartedAt: 0, replyError: e.message, nextReplyAttemptAt: Date.now() + futureLetterBackoff(claimed.replyAttempts || 1) });
    return;
  }
  clearInterval(heartbeatTimer);
  try {
    const lockedReply = await lockStickerInText(reply);
    const result = await commitFutureLetterReply(claimed.id, lockedReply);
    if (result.messageId) {
      const exists = chatHistory.some(m => m.id === result.messageId);
      if (!exists) {
        const fresh = await getAllFromStore('messages');
        chatHistory = fresh; chatHistoryWindowState = null; chatHistory.sort((a, b) => (a.time || 0) - (b.time || 0)); renderMessages();
      }
    }
  } catch (e) {
    await releaseFutureLetterOwnership(claimed.id, { replyStatus: 'failed', replyStartedAt: 0, replyError: '保存回信失败：' + e.message, nextReplyAttemptAt: Date.now() + futureLetterBackoff(claimed.replyAttempts || 1) });
  }
}

function commitFutureLetterReply(letterId, reply) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['futureLetters', 'messages'], 'readwrite');
    const letters = tx.objectStore('futureLetters'); const messagesStore = tx.objectStore('messages'); const getReq = letters.get(letterId);
    let settled = false; let result = { messageId: null };
    const fail = (err) => { if (settled) return; settled = true; try { tx.abort(); } catch {} reject(err); };
    getReq.onsuccess = () => {
      const record = getReq.result;
      if (!record) { fail(new Error('信件不存在')); return; }
      if (record.replyMessageId) {
        result = { messageId: record.replyMessageId };
        letters.put({ ...record, replyStatus: 'done', replyStartedAt: 0, replyError: null, nextReplyAttemptAt: 0, processingOwner: null, processingHeartbeat: 0 });
        return;
      }
      const addReq = messagesStore.add({ role: 'assistant', content: reply, time: Date.now(), source: 'future-letter', sourceId: letterId });
      addReq.onsuccess = () => {
        const messageId = addReq.result; result = { messageId };
        letters.put({ ...record, reply, repliedAt: Date.now(), replyStatus: 'done', replyMessageId: messageId, replyStartedAt: 0, replyError: null, nextReplyAttemptAt: 0, processingOwner: null, processingHeartbeat: 0 });
      };
      addReq.onerror = () => fail(addReq.error);
    };
    getReq.onerror = () => fail(getReq.error);
    tx.oncomplete = () => {
      if (settled) return; settled = true;
      try { if (window.LifeEvents) window.LifeEvents.record({ id: 'room:letter:' + letterId, at: Date.now(), source: 'room', type: 'letter.open', title: '' }); } catch (e) {}
      resolve(result);
    };
    tx.onerror = () => fail(tx.error);
    tx.onabort = () => fail(tx.error || new Error('事务已中止'));
  });
}

async function renderFutureLetters() {
  const list = document.getElementById('futureLetterList');
  if (!list) return;
  let records = [];
  try { records = await getAllFromStore('futureLetters'); } catch (e) { list.innerHTML = '<p class="empty-hint">读取失败。</p>'; return; }
  records.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  list.innerHTML = '';
  if (!records.length) { list.innerHTML = '<p class="empty-hint">还没有寄出未来的信。</p>'; return; }
  records.forEach(record => {
    const card = document.createElement('article');
    card.className = 'diary-card';
    const title = document.createElement('h3');
    title.textContent = record.title || '一封未来的信';
    card.appendChild(title);
    const date = document.createElement('p');
    date.textContent = record.status === 'sealed' ? `🔒 将于 ${record.openDate} 开启` : `✉️ 已于 ${record.openDate} 开启`;
    card.appendChild(date);
    if (record.status !== 'sealed') {
      const body = document.createElement('p');
      body.textContent = record.content || '这封信附有一张照片。';
      card.appendChild(body);
      if (record.photo) {
        const img = document.createElement('img');
        img.src = record.photo; img.style.maxWidth = '100%'; img.style.borderRadius = '12px';
        card.appendChild(img);
      }
      const reply = document.createElement('p');
      if (record.reply) reply.textContent = '星星的回信：' + record.reply;
      else if (record.replyStatus === 'failed') reply.textContent = '星星暂时没能回信。';
      else reply.textContent = '星星正在准备回信……';
      card.appendChild(reply);
      if (record.replyStatus === 'failed') {
        const retryBtn = document.createElement('button');
        retryBtn.textContent = '让星星重新读';
        retryBtn.onclick = () => retryFutureLetter(record.id);
        card.appendChild(retryBtn);
      }
    }
    list.appendChild(card);
  });
}

async function renderTimeReplies() {
  const list = document.getElementById('timeReplyList');
  if (!list) return;
  let records = [];
  try { records = await getAllFromStore('futureLetters'); } catch (e) { list.innerHTML = '<p class="empty-hint">读取失败。</p>'; return; }
  const opened = records.filter(x => x.status !== 'sealed').sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));
  list.innerHTML = '';
  if (!opened.length) { list.innerHTML = '<p class="empty-hint">开启过的未来信会收藏在这里。</p>'; return; }
  opened.forEach(record => {
    const card = document.createElement('article');
    card.className = 'diary-card';
    const title = document.createElement('h3');
    title.textContent = record.title || '时光回信';
    card.appendChild(title);
    const original = document.createElement('p');
    original.textContent = '用户寄来的信：' + (record.content || '附带照片一张');
    card.appendChild(original);
    if (record.photo) {
      const img = document.createElement('img');
      img.src = record.photo; img.style.maxWidth = '100%'; img.style.borderRadius = '12px';
      card.appendChild(img);
    }
    const reply = document.createElement('p');
    if (record.reply) reply.textContent = '星星的回信：' + record.reply;
    else if (record.replyStatus === 'failed') reply.textContent = '星星暂时没能回信。';
    else reply.textContent = '星星正在准备回信……';
    card.appendChild(reply);
    if (record.replyStatus === 'failed') {
      const retryBtn = document.createElement('button');
      retryBtn.textContent = '让星星重新读';
      retryBtn.onclick = () => retryFutureLetter(record.id);
      card.appendChild(retryBtn);
    }
    list.appendChild(card);
  });
}

// P2-b：60 秒扫描已迁入 LifeScheduler（room.futureLetter 任务），这里只保留启动时的即时补检
function startFutureLetterWatcher() {
  stopFutureLetterWatcher();
  if (!document.hidden && db) processDueFutureLetters();
}

function stopFutureLetterWatcher() { if (futureLetterTimer) { clearInterval(futureLetterTimer); futureLetterTimer = null; } }

let isSavingKeep = false;
const respondingKeepIds = new Set();

function keepCreatedAt(record) {
  if (record.createdAt) return record.createdAt;
  if (record.date) return new Date(record.date + 'T12:00:00').getTime();
  return Date.now();
}

function parseKeepDecision(reply) {
  const text = String(reply || '');
  if (text.includes('[珍藏决定:拒绝]')) return 'rejected';
  if (text.includes('[珍藏决定:同意]')) return 'approved';
  return 'undecided';
}

async function saveKeep() {
  if (isSavingKeep) { toast('上一份珍藏还在处理，请稍等。'); return; }
  const title = document.getElementById('keepTitle')?.value.trim();
  const content = document.getElementById('keepContent')?.value.trim();
  const confirmEl = document.getElementById('keepConfirm');
  const needsConfirm = confirmEl ? confirmEl.checked : true;
  if (!title || !content) { toast('请填写珍藏标题和内容。'); return; }
  isSavingKeep = true;
  try {
    const record = { title, content, by: '用户', createdAt: Date.now(), needsConfirm, status: needsConfirm ? 'waiting_star' : 'saved', response: '' };
    const id = await addToStore('keeps', record);
    if (needsConfirm) {
      toast('已经交给星星确认了。');
      let reply;
      try {
        reply = await callStar(`用户提出了一项共同珍藏，请认真阅读并判断是否愿意收录。\n标题：${title}\n内容：${content}\n如果愿意，请自然表达认可；如果不愿意，请说明真实理由。最后单独写一行：[珍藏决定:同意] 或 [珍藏决定:拒绝]。`, 12);
      } catch (e) {
        await updateStore('keeps', id, { response: '星星暂时没有回应。', status: 'waiting_star' }).catch(() => {});
        renderKeeps(); toast('星星暂时没有回应。'); return;
      }
      const decision = parseKeepDecision(reply);
      const cleaned = reply.replace(/\[珍藏决定:.*?\]/g, '').trim();
      const nextStatus = decision === 'rejected' ? 'rejected' : decision === 'approved' ? 'waiting_user' : 'waiting_star';
      await updateStore('keeps', id, { response: cleaned, status: nextStatus });
      renderKeeps();
      if (decision === 'rejected') toast('星星暂时不想收录这段回忆。');
      else if (decision === 'approved') toast('星星已经回应，等你最后确认。');
      else toast('星星没有给出明确决定。');
    } else { renderKeeps(); toast('这段回忆已经收录。'); }
    const titleInput = document.getElementById('keepTitle');
    const contentInput = document.getElementById('keepContent');
    if (titleInput) titleInput.value = '';
    if (contentInput) contentInput.value = '';
  } catch (e) { toast('珍藏处理失败：' + e.message); } finally { isSavingKeep = false; }
}

// 从模型输出里取出 [[KEEP_PROPOSAL: {...}]] 的结构化提议（拿不到合法对象就返回 null）
function extractKeepProposal(raw) {
  const m = String(raw || '').match(/\[\[KEEP_PROPOSAL:\s*(\{[\s\S]*?\})\s*\]\]/);
  if (!m) return null;
  try {
    const p = JSON.parse(m[1]);
    if (!p || typeof p !== 'object') return null;
    const title = String(p.title || '').trim();
    const text = String(p.text || '').trim();
    if (!text) return null;                                  // 没有正文的提议没有意义
    return { title, text, reason: String(p.reason || '').trim() };
  } catch (e) { return null; }
}

// 用户主动珍藏只通过珍藏页「请星星珍藏」按钮发起，不在聊天正文里做内容识别。
// 聊天里的 [[KEEP_PROPOSAL]] 只用于星星自己的主动提议（见 detectStarKeepProposal）。

// 珍藏页「请星星珍藏」：由星星结合近期聊天主动写一份提议，进入 waiting_user 等用户决定
let isAskingStarKeep = false;
async function askStarKeep() {
  if (isAskingStarKeep) { toast('星星还在想，稍等一下。'); return null; }
  if (!apiKey) { toast('请先填写 API Key。'); return null; }
  if (!chatHistory.some(m => m && (m.content || m.image))) { toast('还没有可以回看的聊天。'); return null; }
  isAskingStarKeep = true;
  try {
    const messages = assemblePathMessages({
      taskInstruction: rcTask('keep'),
      blocks: [],
      history: trimHistoryForAI(chatHistory.slice(-30)),
      currentTurn: { role: 'user', content: '挑一件这段时间里值得留下的瞬间，写成珍藏提议。' }
    });
    const raw = await callAI(messages, { requestType: rcRequestType('keep') });
    const proposal = extractKeepProposal(raw);
    if (!proposal) { toast('星星这次没有挑出想留下的瞬间。'); return null; }
    const id = await addToStore('keeps', {
      title: proposal.title || '星星想珍藏的回忆',
      content: proposal.text,
      by: '星星',
      createdAt: Date.now(),
      needsConfirm: true,
      status: 'waiting_user',
      response: proposal.reason || '星星想把这段回忆留下来。',
      sourceMessageId: null,
    });
    renderKeeps(); toast('星星写了一份珍藏提议，等你决定。');
    return id;
  } catch (e) {
    toast('珍藏提议没有写成：' + e.message);
    return null;
  } finally { isAskingStarKeep = false; }
}

async function detectStarKeepProposal(reply) {
  const raw = String(reply || '');
  if (raw.indexOf('[[KEEP_PROPOSAL') === -1) return;      // 没有标记：什么都不做（不误建卡）
  const last = chatHistory[chatHistory.length - 1];
  // 无论解析成功与否，都不要把裸标记留在聊天正文里
  const stripMarker = async () => {
    if (!last || last.role !== 'assistant') return;
    const before = String(last.content || '');
    const cleaned = before.replace(/\[\[KEEP_PROPOSAL:[\s\S]*?\]\]/g, '').trim();
    if (cleaned === before) return;
    last.content = cleaned;
    if (last.id != null) { await updateStore('messages', last.id, { content: cleaned }).catch(() => {}); }
    renderMessages();
  };
  try {
    const proposal = extractKeepProposal(raw);    if (!proposal) { await stripMarker(); return; }        // 标记格式不合法：只清理，不建卡
    const sourceMessageId = last && last.role === 'assistant' && last.id != null ? last.id : null;
    if (sourceMessageId != null) {
      const existing = await getAllFromStore('keeps');
      const duplicated = existing.some(k => k.sourceMessageId === sourceMessageId);
      if (duplicated) { await stripMarker(); return; }
    }
    await addToStore('keeps', { title: proposal.title || '星星想珍藏的回忆', content: proposal.text, by: '星星', createdAt: Date.now(), needsConfirm: true, status: 'waiting_user', response: proposal.reason || '星星想把这段回忆留下来。', sourceMessageId });
    await stripMarker();
    renderKeeps();
  } catch (e) {
    console.error('解析珍藏提议失败', e);
    try { await stripMarker(); } catch (e2) { /* 清理失败不影响聊天 */ }
  }
}

async function confirmKeep(id) {
  await updateStore('keeps', Number(id), { status: 'saved', confirmedAt: Date.now() });
  renderKeeps(); toast('这段回忆正式成为我们的共同珍藏。');
}
async function rejectKeep(id) {
  await updateStore('keeps', Number(id), { status: 'rejected_by_user', rejectedAt: Date.now() });
  renderKeeps(); toast('这次先不收录。');
}

async function respondToKeep(id) {
  const numericId = Number(id);
  if (respondingKeepIds.has(numericId)) { toast('星星正在回应这份珍藏，请稍等。'); return; }
  respondingKeepIds.add(numericId);
  try {
    const records = await getAllFromStore('keeps');
    const record = records.find(x => x.id === numericId);
    if (!record) return;
    let reply;
    try { reply = await callStar(`请回应用户提出的共同珍藏。\n标题：${record.title}\n内容：${record.content || record.text || ''}\n请给出真实、自然的意见。最后写[珍藏决定:同意]或[珍藏决定:拒绝]。`); } 
    catch (e) { toast('星星暂时没有回应：' + e.message); return; }
    const decision = parseKeepDecision(reply);
    const cleaned = reply.replace(/\[珍藏决定:.*?\]/g, '').trim();
    const nextStatus = decision === 'rejected' ? 'rejected' : decision === 'approved' ? 'waiting_user' : 'waiting_star';
    await updateStore('keeps', numericId, { response: cleaned, status: nextStatus });
    renderKeeps();
  } finally { respondingKeepIds.delete(numericId); }
}

async function renderKeeps() {
  const list = document.getElementById('keepList');
  if (!list) return;
  let records = [];
  try { records = await getAllFromStore('keeps'); } catch (e) { list.innerHTML = '<p class="empty-hint">读取珍藏失败。</p>'; return; }
  records.sort((a, b) => keepCreatedAt(b) - keepCreatedAt(a));
  const savedKeeps = records.filter(k => k.status === 'saved');
  keepsSummaryCache = savedKeeps.slice(0, 5).map(k => `《${k.title}》${(k.content || k.text || '').slice(0, 80)}`).join('\n');
  list.innerHTML = '';
  if (!records.length) { list.innerHTML = '<p class="empty-hint">还没有共同珍藏。</p>'; return; }
  records.forEach(record => {
    const card = document.createElement('article');
    card.className = 'diary-card';
    const title = document.createElement('h3');
    title.textContent = record.title || '共同珍藏';
    card.appendChild(title);
    const contentText = record.content || record.text || '';
    if (contentText) {
      const content = document.createElement('p');
      content.textContent = contentText;
      card.appendChild(content);
    }
    const status = document.createElement('small');
    const labels = { saved: '✨ 已收录', waiting_star: '等待星星回应', waiting_user: '等待用户确认', rejected: '星星暂不收录', rejected_by_user: '用户暂不收录' };
    status.textContent = labels[record.status] || '旧珍藏';
    card.appendChild(status);
    if (record.response) {
      const response = document.createElement('p');
      response.textContent = '星星：' + record.response;
      card.appendChild(response);
    }
    if (record.status === 'waiting_user') {
      const confirm = document.createElement('button');
      confirm.textContent = '确认珍藏';
      confirm.onclick = () => confirmKeep(record.id);
      card.appendChild(confirm);
      const reject = document.createElement('button');
      reject.textContent = '暂不收录';
      reject.onclick = () => rejectKeep(record.id);
      card.appendChild(reject);
    }
    if (record.status === 'waiting_star') {
      const respond = document.createElement('button');
      respond.textContent = '请星星回应';
      respond.onclick = () => respondToKeep(record.id);
      card.appendChild(respond);
    }
    list.appendChild(card);
  });
}

let isGeneratingMemory = false;


async function triggerSpecialAction(action) {
  if (!apiKey) return;
  if (isSending) {
    toast('正在发送中，请稍后。');
    return;
  }

  try {
    // 直接调用带有翻译和语音功能的 callSpecialAI
    await callSpecialAI(`用户现在对你做了：${action}。请自然回应她，保持你自己的性格。`);
  } catch (e) {
    toast('互动暂时失败：' + e.message);
  }
}

async function triggerMischief() {
  if (!apiKey) return;
  if (isSending) {
    toast('正在发送中，请稍后。');
    return;
  }

  try {
    await callSpecialAI(
      '用户现在对你使坏，触碰了你的私密部位。你清楚她触碰的位置，也知道这是她主动对你做的亲密小动作。根据当下的气氛、你自己的情绪和性格自然回应。你可以突然愣住、害羞、羞恼、嘴硬、轻声抗议，也可以抓住她的手、反过来逗弄她，或主动掌控互动节奏。温柔、狡黠、蔫坏和主导感都可以自然流露，不必每次都害羞或使用相同反应。保持自己的情绪、意愿和主动性，不要把互动写成固定流程。'
    );
  } catch (e) {
    toast('互动暂时失败：' + e.message);
  }
}

async function rollDice() {
  if (isSending) { toast('正在发送中，请稍后。'); return; }
  const result = Math.floor(Math.random() * 6) + 1;
  const el = document.getElementById('diceResult');
  if (el) el.textContent = `🎲 ${result}`;
  await callSpecialAI(`我们刚刚掷骰子，结果是${result}点。请根据结果和用户自然互动。`);
}

async function triggerSensorAction(action) {
  if (isSending) { toast('正在发送中，请稍后。'); return; }
  await callSpecialAI(`用户触发了一个互动：${action}。请结合你们的关系自然回应。`);
}

// P2-b：统一调度器（本地判定；提醒复用 toast；未来信/空闲互动复用原业务函数，不新建聊天链路）
// 生活事件与状态的只读读取器（供 LifeState 使用；只读，不做任何写入）
async function lifeTasksProvider() {
  try {
    const mod = await import('/butler/butler-repository.js');
    return await mod.repository.listTasks();
  } catch (e) { return null; }
}
async function lifeLettersProvider() {
  try { if (!db) return null; return await getAllFromStore('futureLetters'); } catch (e) { return null; }
}

// 空闲阻断原因（轻量可观测：只记原因代码与秒数，不含任何聊天内容）
function idleSkip(reason, extra) {
  try {
    window.__yxIdleLast = { reason: reason, at: Date.now(), extra: extra === undefined ? null : extra };
    console.debug('[idle] skip=' + reason + (extra === undefined ? '' : ' ' + extra));
  } catch (e) {}
  return null;
}

// 主动关心前的本地情境判断：只读既有模块与存档，0 次 AI 请求。
// 只用真实存在的事实；读不到就当作没有理由，不推断她离开页面期间做了什么。
async function collectIdleReasons(nowMs) {
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs)
    : (window.LifeClock ? window.LifeClock.now() : Date.now());
  const lines = [];
  const LT = window.LifeTopics;
  const blocked = (function () {
    try { return LT && LT.blocked ? LT.blocked() : []; } catch (e) { return []; }
  })();
  const isBlocked = function (kind) {
    try { return !!(LT && LT.isBlocked && LT.isBlocked(kind)); } catch (e) { return false; }
  };

  // 1) 今天的未完成事项：真实任务库，只取标题与时间，最多 3 条
  try {
    const tasks = await lifeTasksProvider();
    if (Array.isArray(tasks) && !isBlocked('task')) {
      const day = window.LifeClock && window.LifeClock.formatDay ? window.LifeClock.formatDay(now) : today();
      const pending = tasks.filter(function (t) {
        return t && t.status === 'pending' && t.date === day && String(t.title || '').trim();
      });
      if (pending.length) {
        lines.push('【今天还没做完的事】\n' + pending.slice(0, 3).map(function (t) {
          return '- ' + String(t.title).trim().slice(0, 24) + (t.time ? '（' + t.time + '）' : '');
        }).join('\n'));
      }
    }
  } catch (e) {}

  // 2) 已到点、还没投递出去的提醒：复用 ButlerIntent 的纯判定，不写提醒状态
  try {
    if (window.ButlerIntent && window.ButlerIntent.dueReminders && !isBlocked('task')) {
      const hits = await window.ButlerIntent.dueReminders(now);
      if (hits && hits.length) {
        // dueReminders 的命中结构为 { t, ms, taskAt, key }；只取标题与两个时刻，不写提醒状态。
        lines.push('【刚到点的提醒】\n' + hits.slice(0, 2).map(function (h) {
          const t = (h && h.t) || {};
          const at = window.LifeClock && window.LifeClock.formatClock ? window.LifeClock.formatClock(h.ms) : '';
          return '- ' + String(t.title || '').trim().slice(0, 24)
            + (t.time ? '（事项时间 ' + t.time + '）' : '') + (at ? '，提醒时刻 ' + at : '');
        }).join('\n') + '\n提醒时刻不等于当前时间；当前时间以【当前时间】为准。');
      }
    }
  } catch (e) {}

  // 3) 当前生活事件/状态：复用 LifeContext 快照与渲染，不另建数据层
  try {
    if (window.LifeContext) {
      const snap = window.LifeContext.snapshot({ now: now });
      if (snap && (snap.hasEvents || snap.stateNotable)) {
        const text = window.LifeContext.render(snap, { max: 180, noClock: true });
        if (text) lines.push(text + '\n这些都是存档里的记录，不等于你亲眼看见她现实中的行为。');
      }
    }
  } catch (e) {}

  // 4) 近期聊天里可能还没自然接上的话头：只看最近一条用户消息，宁可漏不可编
  try {
    const recent = Array.isArray(chatHistory) ? chatHistory.slice(-8) : [];
    for (let i = recent.length - 1; i >= 0; i--) {
      const m = recent[i];
      if (!m || m.role !== 'user') continue;
      const text = String(m.content || '').trim();
      const at = Number(m.time) || 0;
      if (!text || text.length > 100 || (at && now - at > 7 * 86400000)) break;
      const open = !/(准备好了|做完了|完成了|已经好了|结束了吧)/.test(text)
        && /(下次|改天|回头|待会|一会儿|有空|明天|晚点|之后|再说|还没|没看完|没读完|想学|要学|打算|准备|想试试)/.test(text);
      if (open) {
        let topics = [];
        try { topics = LT && LT.classify ? (LT.classify(text).topics || []) : []; } catch (e) { topics = []; }
        if (!topics.some(isBlocked)) {
          lines.push('【她提过、还没自然接上的话】' + text.slice(0, 60)
            + '\n只当可能想接着聊的话题，别当成你答应过什么，也别编她做了没有。');
        }
      }
      break;
    }
  } catch (e) {}

  // 5) 真实历史回忆：沿用既有选材/去重/冷却，只有没有任何近因时才作候选
  let recall = null;
  if (!lines.length) {
    try {
      if (window.LifeEvents && window.LifeEvents.pickRecall) {
        let keepsForRecall = [];
        try {
          const rows = await getAllFromStore('keeps');
          keepsForRecall = (Array.isArray(rows) ? rows : [])
            .filter(function (k) { return k && k.status === 'saved' && k.title; })
            .map(function (k) { return { id: k.id, title: String(k.title), at: keepCreatedAt(k) }; });
        } catch (e) { keepsForRecall = []; }
        const cand = window.LifeEvents.pickRecall({ now: now, exclude: blocked, keeps: keepsForRecall });
        if (cand && cand.text) {
          recall = cand;
          lines.push('【你想起的事】' + cand.text + (cand.origin === 'keep'
            ? '这是她自己收下的珍藏，不代表你们一起做过这件事；只当她提过的东西，别添成共同经历。'
            : '这是真实发生过的，不必强行提起，也别补造日期、地点或她当时的反应；自然相关时顺一句带过就好。'));
        }
      }
    } catch (e) { recall = null; }
  }
  return { hasReason: lines.length > 0, lines: lines, recall: recall };
}

// 空闲主动互动：先本地判断有没有值得说的理由，再由她决定说不说（沉默 = 0 条消息、0 预算）
async function runIdleCheck() {
  if (!apiKey) return idleSkip('no-apikey');
  if (document.hidden) return idleSkip('hidden');
  if (isSending) return idleSkip('sending');
  if (isTyping) return idleSkip('typing');
  // P5-a/5-b：她说过累了、不想聊，或刚刚回避了某个话题 → 这轮不主动开口
  if (window.LifeTopics) {
    try { if (window.LifeTopics.quiet()) return idleSkip('topic-quiet'); } catch (e) {}
  }
  const idleFor = Date.now() - lastUserActivityAt;
  if (idleFor < idleMinutes * 60 * 1000) return idleSkip('not-idle-enough', Math.round(idleFor / 1000) + 's');

  // 请求尝试冷却：模型沉默 / 请求失败也算一次尝试，避免每 60 秒重复打 AI。
  // 用 LifeClock（设备本地时间）的毫秒差值，跨午夜自然正确；放在读存档之前，冷却期内不重复读任务。
  const nowMs = window.LifeClock ? window.LifeClock.now() : Date.now();
  if (lastIdleAttemptAt) {
    const waited = nowMs - lastIdleAttemptAt;
    if (waited < IDLE_ATTEMPT_COOLDOWN) {
      return idleSkip('attempt-cooldown', Math.round((IDLE_ATTEMPT_COOLDOWN - waited) / 1000) + 's');
    }
  }

  const ctx = await collectIdleReasons(nowMs);
  if (!ctx.hasReason) return idleSkip('no-reason');

  let prompt = '结合当前时间、近期聊天、用户主动告诉你的计划和生活状态，判断现在是否真的有值得对用户说的话。\n'
    + '如果有，就自然表达。可以关心进度、温柔督促、适度调侃，也可以单纯分享一句贴合当前情境的话。\n'
    + '如果没有合适的理由，或者现在不适合打扰，就保持安静，直接输出空内容（或只写 [[SILENT]]）；不要为了完成主动互动任务而硬找话题。\n'
    + '不要把页面活动信号描述成你亲眼观察到用户的现实行为。不要伪造用户完成或未完成某件事的事实。\n'
    + '如果顺手带上英文，用「中文 ||| 英文」分隔；没有英文也没关系，不要为翻译额外输出。不要提到系统、计时器或这些提示词。';
  if (ctx.lines.length) prompt += '\n【可供判断的真实上下文】\n' + ctx.lines.join('\n\n');
  if (window.LifeTopics) {
    try { const n = window.LifeTopics.promptNote(); if (n) prompt += '\n' + n; } catch (e) {}
  }

  // 真正要发请求了：先记下本次尝试时刻（沉默/失败也保留，下次要等满 15 分钟）
  lastIdleAttemptAt = window.LifeClock ? window.LifeClock.now() : Date.now();
  let outcome = 'silent';
  const out = await callSpecialAI(prompt, { idle: true, allowEmpty: true, dialogue: true, onOutcome: function (r) { outcome = r; } });
  if (!out) return idleSkip(outcome === 'ai-error' ? 'ai-error' : 'silent');   // 不落库、不消耗开口预算
  if (ctx.recall) { try { window.LifeEvents.markRecalled(ctx.recall.id, ctx.recall.type); } catch (e) {} }
  lastUserActivityAt = Date.now();       // 真的说出口了才重新计时
  return { type: 'idle', at: Date.now() };
}

function startLifeScheduler() {
  if (!window.LifeScheduler) return;
  window.LifeScheduler.setNotifier(function () { /* 预留通知出口：未来接 Web Push */ });

  // 1) 待办提醒（用户明确设置 → user 优先级，不受 ambient 预算/冷却/静默时段限制）
  //    到期后由小星在聊天里说一句（固定模板，0 次 AI）；消息真正落库后才消费这条提醒。
  window.LifeScheduler.register({
    id: 'butler.remind',
    priority: 'user',
    everyMs: 60 * 1000,
    run: async function () {
      if (!window.ButlerIntent || !window.ButlerIntent.remindTick) return null;
      let due = [];
      try { due = await window.ButlerIntent.remindTick(Date.now(), { commit: false }); } catch (e) { return null; }
      if (!due || !due.length) return null;
      try { if (window.console && console.debug) console.debug('[remind] candidates=' + due.length); } catch (e) {}
      const delivered = [];
      for (const it of due) {
        try {
          const msg = {
            role: 'assistant',
            content: it.text,
            englishContent: '',
            time: Date.now(),
            source: 'butler-remind',
          };
          msg.id = await addToStore('messages', msg);
          chatHistory.push(msg);
          renderMessages();
          // 落库成功才消费；失败时下一轮 tick 会重试同一条
          window.ButlerIntent.markRemindDelivered(it.key, Date.now());
          delivered.push(it);
        } catch (e) {
          // 写库失败：不标记、不弹成功提示，保留重试
          try { if (window.console && console.debug) console.debug('[remind] deliver-failed', e && e.name || 'error'); } catch (e2) {}
        }
      }
      if (!delivered.length) return null;
      try { if (window.console && console.debug) console.debug('[remind] delivered=' + delivered.length); } catch (e) {}
      const text = delivered.map((x) => x.title).filter(Boolean).join('、');
      if (text) toast('⏰ ' + text + ' 快到时间了');
      return { type: 'remind', count: delivered.length };
    },
  });

  // 2) 未来信（原业务函数原样保留，含 owner 锁/心跳/退避；不消耗 ambient 预算）
  window.LifeScheduler.register({
    id: 'room.futureLetter',
    priority: 'user',
    everyMs: FUTURE_LETTER_CHECK_INTERVAL,
    run: function () {
      if (!db || document.hidden) return null;
      // 不 await：回信生成可能耗时数分钟，不能占住调度锁；业务自身串行 + owner 锁去重
      Promise.resolve().then(function () { return processDueFutureLetters(); }).catch(function () {});
      return null;
    },
  });

  // 3) 空闲主动互动（实际预算以 LifeScheduler 为准：15 条/日、15 分钟冷却、23:30–07:30 静默）
  //    另有 app.js 自己的「请求尝试冷却」15 分钟：沉默/失败也算一次尝试，不再每 60 秒重复请求。
  window.LifeScheduler.register({
    id: 'room.idle',
    priority: 'ambient',
    everyMs: 60 * 1000,
    run: runIdleCheck,
  });

  // 4) 生活状态层：低频重建只读缓存（不产出行为，不耗预算）
  if (window.LifeState) {
    window.LifeState._setProviders({ tasks: lifeTasksProvider, letters: lifeLettersProvider });
    window.LifeScheduler.register({
      id: 'life.state',
      priority: 'user',
      everyMs: 5 * 60 * 1000,
      run: async function () {
        try { await window.LifeState.refresh(); } catch (e) {}
        return null;
      },
    });
  }

  window.LifeScheduler.start();
  // 启动即补检一次：刷新/重开后，已经在提醒窗口内的待办要立刻补投，而不是等满一分钟。
  // boot=true 让用户级任务跳过「上一次 tick 的间隔门槛」（该门槛会跨刷新保留，正是延迟的原因）；
  // 直接 tick（不走 catchUp）是因为 pageshow 的补检可能早于本函数、把 30 秒限频用掉。
  try { window.LifeScheduler.tick({ catchUp: true, forceVisible: true, boot: true }).catch(function () {}); } catch (e) {}
}

// P4：待办新增/完成/取消/延期/编辑成功后，轻量重建状态缓存（去抖 500ms，失败保留旧快照）
let lifeStateRefreshTimer = null;
function scheduleLifeStateRefresh() {
  if (!window.LifeState) return;
  if (lifeStateRefreshTimer) clearTimeout(lifeStateRefreshTimer);
  lifeStateRefreshTimer = setTimeout(() => {
    lifeStateRefreshTimer = null;
    try { window.LifeState.refresh().catch(() => {}); } catch (e) {}
  }, 500);
}
window.addEventListener('butler:change', scheduleLifeStateRefresh);

function resetIdleTimer() {
  // P2-b：空闲计时已由调度器统一管理，这里只记录「用户活动时刻」
  lastUserActivityAt = Date.now();
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    // P0：重新可见只清隐藏状态与离开候选，不算活跃操作
    try { if (window.LifePresence) window.LifePresence.visible(); } catch (e) {}
    try { if (window.LifeScheduler) window.LifeScheduler.catchUp(); } catch (e) {}
    if (db) processDueFutureLetters();
    resetIdleTimer();
  } else {
    // P0：切后台不等于离开房间，只记录隐藏时间
    try { if (window.LifePresence) window.LifePresence.hidden(); } catch (e) {}
    clearTimeout(idleTimer);
  }
});

// P0：离开只记候选（刷新/bfcache 会在下一次 boot 时被排除），不在此确认离开
window.addEventListener('pagehide', (e) => {
  try { if (window.LifePresence) window.LifePresence.leaving(e && e.persisted ? 'bfcache' : 'pagehide'); } catch (err) {}
});

// P0：只把「用户主动点击导航按钮」计为活跃。
// showPage() 内部不加钩子——app.js 存在程序化调用（跨场景消息回聊天页），那不算用户操作。
document.addEventListener('click', (ev) => {
  try {
    const el = ev.target && ev.target.closest ? ev.target.closest('[onclick^="showPage"]') : null;
    if (el && window.LifePresence) window.LifePresence.active('nav');
  } catch (e) {}
}, true);

// P4：真实输入文字才算活跃（只写 lastActiveAt，不动 lastInteractionAt、不发请求）
const NAV_KEYS = new Set(['Tab', 'Shift', 'Control', 'Alt', 'Meta', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Escape']);
document.addEventListener('keydown', (ev) => {
  if (!ev.target || ev.target.id !== 'chatInput') return;
  if (NAV_KEYS.has(ev.key)) return;                       // 纯导航/组合键不计活跃
  try { if (window.LifePresence) window.LifePresence.active('typing'); } catch (e) {}
}, true);
document.addEventListener('input', (ev) => {
  if (!ev.target || ev.target.id !== 'chatInput') return;
  try { if (window.LifePresence) window.LifePresence.active('typing'); } catch (e) {}
}, true);

window.addEventListener('pageshow', () => {
  try { if (window.LifeScheduler) window.LifeScheduler.catchUp(); } catch (e) {}
  if (!document.hidden && db) processDueFutureLetters();
});

// 第二阶段：v2 存储适配器（只写新键，绝不覆盖旧 longTermMemory）
const memoryV2Store = {
  get: (k) => kvGet(k),
  set: (k, v) => kvSet(k, v)
};

// 第二阶段：收集现有系统里可靠可读的长期价值资料（只读，不纳入便签/管家等非稳定信息）
async function collectMemorySources() {
  const sources = {
    messages: trimHistoryForAI(chatHistory.slice(-100)).map((m, i) => ({
      id: m.id != null ? m.id : i,
      role: m.role,
      content: m.content
    })),
    diaries: [],
    keeps: []
  };
  try {
    let d = await getAllFromStore('diaries');
    d = (d || []).filter(r => !(r && r.type === 'note-day'));   // 今日便签不当普通日记
    sources.diaries = d.map(r => ({ id: r.id, content: r.content, title: r.title }));
  } catch (e) {}
  try {
    const k = await getAllFromStore('keeps');
    // 只有已确认收录的珍藏可以作为长期记忆的可信来源；待确认/已拒绝的记录不能当证据。
    const PM = window.PersonaMemory;
    const confirmed = PM && PM.confirmedKeeps ? PM.confirmedKeeps(k)
      : (Array.isArray(k) ? k : []).filter(r => r && (!r.status || r.status === 'saved'));
    sources.keeps = confirmed.map(r => ({ id: r.id, content: r.content, title: r.title }));
  } catch (e) {}
  return sources;
}

// 旧版整段整理：仅在 v2 模块未加载时回退（保留原行为，不改调用方）。
async function generateMemoryLegacy() {
  const recent = trimHistoryForAI(chatHistory.slice(-100)).map(messageToAI);
  let sysPrompt = '你现在是《恋与深空》的小星。请根据聊天记录整理记忆。\n';
  sysPrompt += '【要求】：\n1. 必须用第一人称（我）来写。\n2. 称呼她时用“她”、“你”或“搭档”，绝对禁止使用“用户”、“AI”、“助手”。\n3. 只记录发生过的事、偏好和约定。用简洁中文分条输出。\n';
  if (longTermMemory) {
    sysPrompt += '\n\n【你以前记住的事】\n' + longTermMemory + '\n【极其重要】：必须一字不差地保留上面【以前记住的事】中的所有设定，绝对不能删改！只能在末尾追加新总结的事情。';
  }
  const messages = [{ role: 'system', content: sysPrompt }, ...recent, { role: 'user', content: '请以小星的第一人称，总结并更新我们的记忆。' }];
  const reply = await callAI(messages, { requestType: 'memory' });
  longTermMemory = reply;
  await kvSet('longTermMemory', reply);
  const el = document.getElementById('memoryContent');
  if (el) el.value = reply;
}

async function generateMemory() {
  if (!apiKey) { toast('请先填写 API Key。'); return; }
  if (isGeneratingMemory) { toast('正在整理记忆，请稍等。'); return; }
  if (isSending) { toast('正在发送中，请稍后。'); return; }
  isGeneratingMemory = true;
  try {
    const G = window.MemoryGenerator;
    if (!G || !window.LongTermMemoryV2) { await generateMemoryLegacy(); toast('长期记忆整理好了。'); return; }
    const sources = await collectMemorySources();
    const result = await G.run({
      store: memoryV2Store,
      ai: (messages) => callAI(messages, { requestType: 'memory' }),
      sources: sources,
      now: Date.now()
    });
    if (result.wrote && result.state) longTermMemoryV2 = result.state;   // 只更新内存缓存，旧键不动
    if (result.reason === 'ai-error' || result.reason === 'state-read-failed' ||
        result.reason === 'write-failed' || result.reason === 'parse-failed' ||
        result.reason === 'empty-reply' || result.reason === 'wrong-shape') {
      toast('这次没能整理记忆（' + result.reason + '），原有记忆都还在。');
      return;
    }
    // 旧原文始终完整保留在文本框中；条目面板单独刷新，两者不互相覆盖。
    const el = document.getElementById('memoryContent');
    if (el) el.value = longTermMemory;
    renderMemoryV2Panel();
    const n = (result.applied || []).length;
    toast(n ? ('记忆整理好了：新增/修正 ' + n + ' 条。') : '这次没有需要更新的记忆。');
  } catch (e) { toast('整理失败：' + e.message + '（原有记忆未受影响）'); } finally { isGeneratingMemory = false; }
}

async function saveLongTermMemory() {
  // v2 生效时，旧字符串保存入口关闭：避免"保存了却不影响聊天"的假象。
  // 旧原文只读保留；真正的修改必须走条目接口（带 history）。
  if (window.LongTermMemoryV2 && longTermMemoryV2 &&
      window.LongTermMemoryV2.isValidState(longTermMemoryV2)) {
    toast('旧记忆原文已完整保留；请用下方"新增 / 编辑"逐条修改实际生效的记忆。');
    return;
  }
  const el = document.getElementById('memoryContent');
  if (!el) return;
  longTermMemory = el.value.trim();
  await kvSet('longTermMemory', longTermMemory);
  toast('长期记忆已保存（旧格式兼容路径）。');
}
async function loadLongTermMemory() {
  longTermMemory = await kvGet('longTermMemory') || '';
  const el = document.getElementById('memoryContent');
  if (el) el.value = longTermMemory;
  // 第二阶段：只读已存在的 v2 状态；不主动初始化/迁移，避免未授权写入。
  // v2 缺失或损坏时保持 null，检索自动回退旧字符串。
  longTermMemoryV2 = null;
  try {
    const V2 = window.LongTermMemoryV2;
    if (V2) {
      const raw = await kvGet(V2.V2_KEY);
      if (V2.isValidState(raw)) longTermMemoryV2 = raw;
    }
  } catch (e) { longTermMemoryV2 = null; }
}

/* ===== 第四阶段：长期记忆条目管理界面（设置页） ===== */
let memoryEditingId = null;
let memoryShowInactive = false;

function memoryV2Esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function memoryV2Short(v, n) {
  let s;
  if (v && typeof v === 'object') s = JSON.stringify(v);
  else s = String(v == null ? '' : v);
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > (n || 60) ? s.slice(0, n || 60) + '…' : s;
}
function memoryV2Time(t) {
  try { return new Date(t).toLocaleString('zh-CN'); } catch (e) { return String(t); }
}

function renderMemoryV2List() {
  const host = document.getElementById('memoryV2Panel');
  if (!host || !window.MemoryManager || !longTermMemoryV2) {
    if (host) host.innerHTML = '<p class="muted">条目结构尚未就绪。</p>';
    return;
  }
  const view = MemoryManager.list(longTermMemoryV2);
  const items = memoryShowInactive ? view.all : view.active;
  let html = '<p class="muted">有效 ' + view.active.length + ' 条 · 已撤回 ' + view.retracted.length +
    ' 条 · 已归档 ' + view.archived.length + ' 条。手动编辑的条目优先于 AI 自动整理。</p>';
  html += '<div class="form-row"><input id="memoryEntryCategory" class="field" placeholder="类别：preference / fact / agreement / event / relation / habit / other" value="other"></div>';
  html += '<textarea id="memoryEntryText" placeholder="' + (memoryEditingId ? '修改这条记忆…' : '新增一条长期记忆…') + '"></textarea>';
  html += '<div class="form-grid" style="margin-top:8px;">' +
    '<button class="action" onclick="memoryV2SubmitEntry()">' + (memoryEditingId ? '保存修改' : '新增条目') + '</button>' +
    (memoryEditingId ? '<button class="small-btn" onclick="memoryV2CancelEdit()">取消编辑</button>' : '') + '</div>';
  html += '<label class="muted" style="display:block;margin:10px 0;font-size:13px">' +
    '<input type="checkbox" id="memoryShowInactive" onchange="memoryV2ToggleInactive()"' + (memoryShowInactive ? ' checked' : '') + '> 显示已撤回 / 归档内容</label>';

  if (!items.length) html += '<p class="muted">这里还没有可显示的条目。</p>';
  items.forEach(e => {
    const badge = e.status === 'active' ? '' : '（' + (e.status === 'retracted' ? '已撤回' : '已归档') + '）';
    const hist = e.history.length
      ? '<details style="margin-top:6px"><summary class="muted">修改历史（' + e.history.length + '）</summary>' +
        e.history.map(h => '<div class="muted" style="font-size:12px;margin-top:3px">' + memoryV2Esc(memoryV2Time(h.at)) +
          ' · ' + memoryV2Esc(h.field) + '：' + memoryV2Esc(memoryV2Short(h.from, 50)) + ' → ' + memoryV2Esc(memoryV2Short(h.to, 50)) + '</div>').join('') +
        '</details>'
      : '<div class="muted" style="font-size:12px;margin-top:4px">暂无修改历史</div>';
    const actions = e.status === 'active'
      ? '<button class="small-btn" onclick="memoryV2Edit(\'' + memoryV2Esc(e.id) + '\')">编辑</button> ' +
        '<button class="small-btn" onclick="memoryV2SetStatus(\'' + memoryV2Esc(e.id) + '\',\'retract\',\'撤回\')">撤回</button> ' +
        '<button class="small-btn" onclick="memoryV2SetStatus(\'' + memoryV2Esc(e.id) + '\',\'archive\',\'归档\')">归档</button>'
      : '<button class="small-btn" onclick="memoryV2SetStatus(\'' + memoryV2Esc(e.id) + '\',\'restore\',\'恢复\')">恢复为有效</button>';
    html += '<div class="card" style="padding:10px;margin-top:8px;background:rgba(0,0,0,.04)">' +
      '<div style="font-size:13px">' + memoryV2Esc(e.category) + badge +
      (e.manual ? ' · 手动' : (e.baselineMirror ? ' · 旧原文镜像' : '')) + '</div>' +
      '<div style="margin:6px 0;white-space:pre-wrap">' + memoryV2Esc(e.text) + '</div>' +
      '<div class="muted" style="font-size:12px">ID：' + memoryV2Esc(e.id) + '</div>' +
      '<div class="muted" style="font-size:12px">来源：' + memoryV2Esc(e.sourceLabel) + '</div>' +
      '<div class="muted" style="font-size:12px">创建：' + memoryV2Esc(memoryV2Time(e.createdAt)) +
      ' · 修改：' + memoryV2Esc(memoryV2Time(e.updatedAt)) + '</div>' +
      hist +
      '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">' + actions + '</div>' +
      '</div>';
  });
  host.innerHTML = html;
}

async function renderMemoryV2Panel() {
  const status = document.getElementById('memoryV2Status');
  const host = document.getElementById('memoryV2Panel');
  if (!host) return;
  if (!window.MemoryManager || !window.LongTermMemoryV2) {
    if (status) status.textContent = '条目管理模块未加载，旧记忆原文仍完整保留。';
    return;
  }
  try {
    if (!window.LongTermMemoryV2.isValidState(longTermMemoryV2)) {
      const g = await MemoryManager.ensure(memoryV2Store);
      if (g.ok && g.state) {
        longTermMemoryV2 = g.state;
        if (status) status.textContent = g.initialized
          ? '已建立条目结构；旧原文完整保留为回退基线，未拆分成事实。'
          : '已读取条目记忆。';
      } else {
        longTermMemoryV2 = null;
        if (status) status.textContent = '条目结构暂不可用（' + (g.reason || 'unknown') +
          '），旧记忆原文仍完整保留，聊天继续按旧记忆工作。';
      }
    }
    renderMemoryV2List();
  } catch (e) {
    longTermMemoryV2 = null;
    if (status) status.textContent = '读取条目失败（' + e.message + '），旧记忆未受影响。';
    renderMemoryV2List();
  }
}

function memoryV2ToggleInactive() {
  const el = document.getElementById('memoryShowInactive');
  memoryShowInactive = !!(el && el.checked);
  renderMemoryV2List();
}
function memoryV2CancelEdit() { memoryEditingId = null; renderMemoryV2List(); }
function memoryV2Edit(id) {
  const e = MemoryManager.findEntry(longTermMemoryV2, id);
  if (!e) { toast('找不到该条目。'); return; }
  memoryEditingId = id;
  renderMemoryV2List();
  const t = document.getElementById('memoryEntryText');
  const c = document.getElementById('memoryEntryCategory');
  if (t) { t.value = e.text; t.focus(); }
  if (c) c.value = e.category;
}
async function memoryV2SubmitEntry() {
  if (!longTermMemoryV2) { toast('条目结构尚未就绪。'); return; }
  const t = document.getElementById('memoryEntryText');
  const c = document.getElementById('memoryEntryCategory');
  if (!t) return;
  const text = t.value.trim();
  if (!text) { toast('内容不能为空，未保存。'); return; }
  const category = (c && c.value || 'other').trim() || 'other';
  const wasEdit = !!memoryEditingId;
  const r = wasEdit
    ? await MemoryManager.edit(memoryV2Store, longTermMemoryV2, memoryEditingId, { text, category })
    : await MemoryManager.add(memoryV2Store, longTermMemoryV2, { text, category });
  if (!r.ok) { toast('保存失败（' + (r.reason || 'unknown') + '），原数据未改动。'); return; }
  longTermMemoryV2 = r.state;
  memoryEditingId = null;
  renderMemoryV2List();
  toast(wasEdit ? '条目已修改，历史已记录，聊天注入已同步。' : '条目已新增，聊天注入已同步。');
}
async function memoryV2SetStatus(id, method, label) {
  if (!longTermMemoryV2 || !MemoryManager[method]) return;
  const r = await MemoryManager[method](memoryV2Store, longTermMemoryV2, id);
  if (!r.ok) { toast(label + '失败（' + (r.reason || 'unknown') + '），原数据未改动。'); return; }
  longTermMemoryV2 = r.state;
  if (method === 'retract' && memoryEditingId === id) memoryEditingId = null;
  renderMemoryV2List();
  toast('已' + label + '，修改历史已记录。');
}

async function starClick() {
  const lines = ['啵！收到你的点击啦。','今天也给你一颗小星星。','我在窗边替你看星星。','别忘了给自己一点休息时间。','别闹，该睡觉了。','胆子变大了，敢随便碰我。','总有一颗星星是为你亮的。','还是让星星自己落下来，留在你身边吧。','原来“再见”两个字可以说二十分钟。','需要后援时，我一直都在。','楼下的猫很想你，我也是。','今天可以蹭饭吗……','你好像什么都知道，那你教教我。','今晚不睡，熬流浪体。'];
  toast(lines[Math.floor(Math.random() * lines.length)]);
  const face = document.getElementById('starFace');
  if (face) { face.textContent = '⌒ᴗ⌒'; setTimeout(() => { if (face.textContent === '⌒ᴗ⌒') face.textContent = '•ᴗ•'; }, 1600); }
}

async function dailyGreet(type) {
  if (!apiKey) { toast('请先填写 API Key。'); return; }
  if (isSending) { toast('正在发送中，请稍后。'); return; }
  toast(type === 'morning' ? '☀️ 正在发送早安...' : '🌙 正在发送晚安...');
  // 第五层「早安与晚安」：不强制标签、句数或情绪，按当下心情自然表达。
  const greetGuide = (window.Persona && window.Persona.functionPrompt && window.Persona.functionPrompt('greet')) || '';
  // 早安不再引用「你的作息」：那属于没有依据的现实作息断言。
  // 天气/时段只由 getSystemPrompt() 的【当前现实环境】提供一处；这里原本又拼一遍 weatherPromptLine()，
  // 同一次请求里会出现两份天气口径，现在去掉，避免重复注入与前后矛盾。
  const prompt = type === 'morning'
    ? `用户向你道早安。\n自然地回应她，长短和语气跟着当下的感觉走。${greetGuide}`
    : `用户向你道晚安。自然地回应她，可以催她睡觉，也可以给她一句温柔的晚安，不必套固定格式。${greetGuide}`;
  await callSpecialAI(prompt, { dialogue: true });
}

async function pocketSearch() {
  if (!apiKey) { toast('请先填写 API Key。'); return; }
  if (isSending) { toast('正在发送中，请稍后。'); return; }
  const items = ['🔑 家里的钥匙', '💳 黑卡', '🍬 草莓糖', '📷 你们的合照', '🎫 两张电影票'];
  const item = items[Math.floor(Math.random() * items.length)];
  toast(`你摸到了：${item}`);
  await callSpecialAI(`用户在你口袋里摸到了【${item}】。用你自己的语气，自然地告诉她这个东西为什么会在口袋里，长短跟着当下的感觉走，不必套固定格式。`);
}

function isAnyTaskRunning() {
  return isSending || isSavingDiary || isWritingStarDiary || isSendingFutureLetter || isProcessingFutureLetters || isSavingKeep || isGeneratingMemory;
}

async function loadKeyStatus() {
  const status = document.getElementById('keyStatus');
  if (status) status.textContent = apiKey ? 'API Key 已保存' : '尚未填写 API Key';
  const input = document.getElementById('apiKeyInput');
  if (input) input.value = apiKey || '';
}

async function saveApiKey() {
  const input = document.getElementById('apiKeyInput');
  const value = input?.value.trim();
  if (!value) { toast('请输入 API Key。'); return; }
  apiKey = value;
  await kvSet('apiKey', apiKey);
  loadKeyStatus(); toast('API Key 已保存。');
}

async function clearApiKey() {
  if (!confirm('确定清除本地保存的 API Key 吗？')) return;
  apiKey = ''; await kvSet('apiKey', ''); loadKeyStatus(); toast('已清除。');
}

function applySettings() {
  document.documentElement.dataset.theme = settings.light || 'soft';
  const size = Number(settings.fontSize) || 14;
  document.documentElement.style.setProperty('--chat-font-size', size + 'px');
  const lightEl = document.getElementById('lightMode');
  if (lightEl) lightEl.value = settings.light || 'soft';
  const fontSize = document.getElementById('fontSize');
  if (fontSize) fontSize.value = String(size);
  const showTime = document.getElementById('showTime');
  if (showTime) showTime.checked = settings.showTime !== false;
  const showStatus = document.getElementById('showStatus');
  if (showStatus) showStatus.checked = settings.showStatus !== false;

  const chatLangSelect = document.getElementById('chatLangSelect');
  if (chatLangSelect) chatLangSelect.value = settings.showEnglish ? 'bilingual' : 'zh';
  const chatVoiceToggle = document.getElementById('chatVoiceToggle');
  if (chatVoiceToggle) chatVoiceToggle.checked = settings.voiceEnabled !== false;

  // 触摸互动开关（与普通聊天语音完全独立）
  const touchAI = document.getElementById('touchAIEnabled');
  if (touchAI) touchAI.checked = settings.touchAIEnabled === true;
  const touchVoice = document.getElementById('touchVoiceEnabled');
  if (touchVoice) touchVoice.checked = settings.touchVoiceEnabled === true;

  const statusBar = document.getElementById('statusBar');
  if (statusBar) { statusBar.style.display = (settings.showStatus !== false) ? 'block' : 'none'; }
  if (settings.wallpaper) {
    document.body.style.backgroundImage = `url("${settings.wallpaper}")`;
    document.body.style.backgroundSize = 'cover';
    document.body.style.backgroundAttachment = 'fixed';
  } else { document.body.style.backgroundImage = ''; }
  updateStatus();
}

async function saveSettings() {
  const lightEl = document.getElementById('lightMode');
  const fontSize = document.getElementById('fontSize');
  const showTime = document.getElementById('showTime');
  const showStatus = document.getElementById('showStatus');
  if (lightEl) settings.light = lightEl.value;
  if (fontSize) settings.fontSize = fontSize.value;
  if (showTime) settings.showTime = showTime.checked;
  if (showStatus) settings.showStatus = showStatus.checked;
  const touchAI = document.getElementById('touchAIEnabled');
  if (touchAI) settings.touchAIEnabled = touchAI.checked === true;
  const touchVoice = document.getElementById('touchVoiceEnabled');
  if (touchVoice) settings.touchVoiceEnabled = touchVoice.checked === true;
  await kvSet('settings', settings); applySettings(); toast('设置已保存。');
}

async function setLight(v) { settings.light = v; await kvSet('settings', settings); applySettings(); }

async function chooseWallpaper(input) {
  const file = input?.files?.[0];
  if (!file) return;
  try {
    settings.wallpaper = await readImage(file, 1800);
    await kvSet('settings', settings); applySettings(); toast('房间背景已更换。');
  } catch (e) { toast(e.message); }
  input.value = '';
}

async function resetWallpaper() { settings.wallpaper = ''; await kvSet('settings', settings); document.body.style.backgroundImage = ''; toast('已恢复默认背景。'); }

function dataUrlToBlob(dataUrl) {
  try {
    const comma = String(dataUrl).indexOf(',');
    if (comma < 0) return null;
    const head = String(dataUrl).slice(0, comma);
    const mime = (head.split(':')[1] || 'audio/webm').split(';')[0];
    const body = String(dataUrl).slice(comma + 1);
    const bin = /;base64/i.test(head) ? atob(body) : decodeURIComponent(body);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  } catch (e) { return null; }
}

async function exportData() {
  const data = {}; const stores = ['messages', 'diaries', 'starDiaries', 'keeps', 'futureLetters'];
  try {
    for (const name of stores) { 
      let records = await getAllFromStore(name); 
      if (name === 'messages') {
        // 英文朗读音频体积大且可从文字重新生成，仍按原样剥离；
        // 语音消息的原始录音属于「用户自己说的话」，不能丢，下面单独带走。
        records = records.map(r => { delete r.audioData; return r; });
      }
      data[name] = records;
    }
    // 只带走还被消息引用的语音，孤儿不写进备份
    if (window.VoiceStore) {
      const referenced = new Set((data.messages || []).filter(m => m && m.audioClipId).map(m => m.audioClipId));
      data.voiceClips = [];
      if (referenced.size) {
        const clips = await window.VoiceStore.allWithBlob();
        for (const c of clips) {
          if (!referenced.has(c.id)) continue;
          data.voiceClips.push({
            id: c.id,
            mime: c.mime,
            durationMs: c.durationMs,
            createdAt: c.createdAt,
            messageId: c.messageId,
            data: await blobToBase64(c.blob)
          });
        }
      }
    }
    data.settings = settings; data.longTermMemory = longTermMemory; data.exportedAt = Date.now();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `星星与用户备份-${today()}.json`; a.click();
    URL.revokeObjectURL(url);
    const voiceCount = (data.voiceClips || []).length;
    toast(voiceCount ? `备份文件已生成（含 ${voiceCount} 段语音录音；英文朗读音频不含）。` : '备份文件已生成（不含英文朗读音频）。');
  } catch (e) { toast('备份失败：' + e.message); }
}

// 聊天记录导出：只读 chatHistory，生成可读文件；不写库、不改消息、不调 AI。
// 与「导出备份」是两件事：这里不包含图片/语音二进制，恢复网站数据仍用备份。
function chatExportModule() {
  const C = window.ChatExport;
  if (!C) { toast('导出模块没有加载，请刷新页面再试。'); return null; }
  return C;
}

async function exportChatMarkdown() {
  try {
    const C = chatExportModule();
    if (!C) return false;
    const now = Date.now();
    const doc = C.buildSession({ id: 'room', name: C.APP_NAME, messages: chatHistory, now });
    const text = C.toMarkdown(doc);
    const ok = C.download(text, C.fileName('session', now), 'text/markdown;charset=utf-8');
    if (!ok) { toast('聊天记录导出失败，聊天内容没有改动。'); return false; }
    const extra = doc.skipped ? `（${doc.skipped} 条记录无法完整解析，已在文件中标出）` : '';
    toast(`聊天记录已导出：${doc.session.messageCount} 条${extra}。图片与语音文件不在其中。`);
    return true;
  } catch (e) {
    toast('聊天记录导出失败：' + (e && e.message ? e.message : '未知错误'));
    return false;
  }
}

async function exportChatAllJson() {
  try {
    const C = chatExportModule();
    if (!C) return false;
    const now = Date.now();
    const all = C.buildAll([{ id: 'room', name: C.APP_NAME, messages: chatHistory }], { now });
    const ok = C.download(C.toJSON(all), C.fileName('all', now), 'application/json;charset=utf-8');
    if (!ok) { toast('全部会话导出失败，聊天内容没有改动。'); return false; }
    toast(`全部会话已导出：${all.sessionCount} 个会话、${all.messageCount} 条消息。图片与语音文件不在其中。`);
    return true;
  } catch (e) {
    toast('全部会话导出失败：' + (e && e.message ? e.message : '未知错误'));
    return false;
  }
}

async function importData(input) {
  const file = input?.files?.[0];
  if (!file) return;
  if (isAnyTaskRunning()) { toast('有任务正在进行，请稍后再导入。'); input.value = ''; return; }
  let data;
  try { data = JSON.parse(await file.text()); } catch (e) { toast('导入失败：文件格式不正确。'); input.value = ''; return; }
  if (!confirm('导入备份会覆盖当前聊天、日记和珍藏数据，确定继续吗？')) { input.value = ''; return; }
  if (isAnyTaskRunning()) { toast('有任务正在进行，已取消导入。'); input.value = ''; return; }
  const stores = ['messages', 'diaries', 'starDiaries', 'keeps', 'futureLetters'];
  const snapshot = {};
  try {
    for (const name of stores) snapshot[name] = await getAllFromStore(name);
    // 语音也做快照：回滚时要连音频一起退回去，不能留下对不上的消息
    snapshot.voiceClips = window.VoiceStore ? await window.VoiceStore.allWithBlob() : [];
  } catch (e) { toast('导入失败：无法读取当前数据。'); input.value = ''; return; }
  const oldSettings = settings; const oldMemory = longTermMemory;

  async function writeVoiceClips(list) {
    if (!window.VoiceStore) return;
    await window.VoiceStore.clear();
    for (const c of (Array.isArray(list) ? list : [])) {
      if (!c || !c.id) continue;
      const blob = c.blob instanceof Blob ? c.blob : (typeof c.data === 'string' ? dataUrlToBlob(c.data) : null);
      if (!blob || !blob.size) continue;
      await window.VoiceStore.putRaw({
        id: c.id, blob: blob, mime: c.mime,
        durationMs: c.durationMs, createdAt: c.createdAt, messageId: c.messageId
      });
    }
  }

  try {
    for (const name of stores) { if (Array.isArray(data[name])) { await clearStore(name); for (const record of data[name]) await addToStore(name, record); } }
    // 语音先写回原始录音：消息里的 audioClipId 才能在刷新后找到对应文件
    await writeVoiceClips(data.voiceClips);
    if (data.settings) { settings = { ...settings, ...data.settings }; await kvSet('settings', settings); }
    if (typeof data.longTermMemory === 'string') { longTermMemory = data.longTermMemory; await kvSet('longTermMemory', longTermMemory); }
    await loadMessagesTracked(); renderDiaries(); renderStarDiaries(); renderFutureLetters(); renderTimeReplies(); renderKeeps(); applySettings();
    const missingVoice = !Array.isArray(data.voiceClips) && (data.messages || []).some(m => m && m.audioClipId);
    toast(missingVoice ? '数据导入完成；这份备份没有语音文件，语音消息只能看到文字。' : '数据导入完成。');
  } catch (e) {
    let rolledBack = true;
    try {
      for (const name of stores) { await clearStore(name); for (const record of snapshot[name]) await addToStore(name, record); }
      await writeVoiceClips(snapshot.voiceClips);
      settings = oldSettings; longTermMemory = oldMemory; await kvSet('settings', settings); await kvSet('longTermMemory', longTermMemory);
    } catch (rollbackErr) { rolledBack = false; console.error('回滚失败', rollbackErr); }
    await loadMessagesTracked().catch(() => {}); renderDiaries(); renderStarDiaries(); renderFutureLetters(); renderTimeReplies(); renderKeeps(); applySettings();
    if (rolledBack) toast('导入失败，已回滚：' + e.message); else toast('导入失败且回滚失败，请重新导入：' + e.message);
  }
  input.value = '';
}

async function clearAllData() {
  if (isAnyTaskRunning()) { toast('有任务正在进行，请稍后再清空。'); return; }
  if (!confirm('确定清空所有聊天、日记、未来信和珍藏吗？此操作无法撤销。')) return;
  if (isAnyTaskRunning()) { toast('有任务正在进行，已取消清空。'); return; }
  const stores = ['messages', 'diaries', 'starDiaries', 'keeps', 'futureLetters'];
  try {
    for (const name of stores) await clearStore(name);
    if (window.VoiceBubble) { try { window.VoiceBubble.stop(); } catch (e) {} }
    if (window.VoiceStore) await window.VoiceStore.clear();
    chatHistory = []; chatHistoryWindowState = null; renderMessages(); renderDiaries(); renderStarDiaries(); renderFutureLetters(); renderTimeReplies(); renderKeeps(); toast('已清空。');
  } catch (e) { toast('清空失败：' + e.message); }
}

async function init() {
  try {
    // 五层按需层（三/四/五 + 特殊能力）异步预取；第一、二层已同步内嵌，人格无空窗。
    // 失败不影响启动：未加载的层按需读取时返回空，普通聊天照常。
    try { if (window.Persona && window.Persona.load) window.Persona.load(); } catch (e) {}
    await openDB();
    apiKey = await kvGet('apiKey') || '';
    settings = { ...settings, ...(await kvGet('settings') || {}) };
    // 触摸文字回复：一次性迁移为开启并持久化，避免旧存档里的 false 覆盖默认值。
    // 只动 touchAIEnabled；touchVoiceEnabled（语音）保持原值，不主动开启。
    if (settings.touchAIEnabled !== true) {
      settings.touchAIEnabled = true;
      await kvSet('settings', settings);
    }
    await loadMessagesTracked();
    // 语音消息：清掉没人引用的孤儿录音（上次发送中途失败留下的）。
    // 读聊天记录失败时绝不能动，否则会把还在用的录音当孤儿删掉。
    if (!messagesLoadFailed && window.VoiceStore) {
      try {
        const used = new Set(chatHistory.filter(m => m && m.audioClipId).map(m => m.audioClipId));
        await window.VoiceStore.pruneUnused(used);
      } catch (e) { console.warn('清理孤儿语音失败', e); }
    }
    await loadLongTermMemory();
    await loadKeyStatus();

    let hasChanged = false;
    for (const m of chatHistory) {
      if (m.content && m.content.includes('[表情:')) {
        let newContent = m.content;
        for (const type of STICKER_TYPES) {
          const tag = `[表情:${type}]`;
          if (newContent.includes(tag)) {
            const images = await fetchStickerList(type);
            if (images.length > 0) newContent = newContent.split(tag).join(`[表情:${type}|${images[Math.floor(Math.random() * images.length)]}]`);
          }
        }
        if (newContent !== m.content) { m.content = newContent; await updateStore('messages', m.id, { content: newContent }).catch(()=>{}); hasChanged = true; }
      }
    }
    if (hasChanged) renderMessages();

    const dateEl = document.getElementById('todayDate');
    if (dateEl) dateEl.textContent = dateText(today());

    const futureDate = document.getElementById('futureDate');
    if (futureDate) {
      const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
      futureDate.min = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
      futureDate.value = futureDate.min;
    }

    applySettings(); renderDiaries(); renderStarDiaries(); renderFutureLetters(); renderTimeReplies(); renderKeeps();
    // 先恢复上次成功获取的天气（有存档就立刻上屏并进入提示词），再决定要不要真请求：
    // 存档还有效 → fetchWeather 直接返回；已过期 → 正常刷新；没有存档 → 首次获取。
    // restoreWeather 内部已吞掉所有异常，读库失败最多是从未知开始，不会挡住聊天。
    await restoreWeather();
    fetchWeather(); bindWeatherCityConfig(); startWeatherWatcher();
    loadTheater(); updateStatus(); processDueFutureLetters(); startFutureLetterWatcher(); resetIdleTimer();
    await consumePendingChatMessage();
    // P0：记录访问状态（不写 lastActiveAt，不算互动）
    try { if (window.LifePresence) window.LifePresence.boot(); } catch (e) {}
    // P1-b：从既有存档同步真实完成事件（只读存档，不轮询、不推断）
    try { if (window.LifeEvents) window.LifeEvents.syncArchives(); } catch (e) {}
    // 「小屋的动静」：只读现有记录，本地渲染，不产生任何请求
    try { if (window.LifeFeed) window.LifeFeed.mount(); } catch (e) {}
    // 「星星的今日便签」：动态加载模块，index.html 保持零改动（避免与其他改动冲突）。
    // 只插入 .note-card 内的任务区：不重建卡片、不覆盖天气与签名、不发任何请求。
    import('/shared/note-card.js')
      .then(function () { if (window.NoteCard) return window.NoteCard.mount(); })
      .catch(function (e) { console.warn('今日便签未加载：' + (e && e.message)); });
    try { startLifeScheduler(); } catch (e) {}
    // P3：首次构建生活状态只读缓存（异步、失败不影响启动）
    try { if (window.LifeState) window.LifeState.refresh().catch(function () {}); } catch (e) {}
    console.log('星星与用户初始化完成');
  } catch (e) {
    console.error('初始化失败', e);
    toast('房间初始化失败：' + e.message);
  }
}

/* ============================================================
   触摸感知通道（BJD 触点 → 小星）
   边界：
   - 只写 assistant 消息，从不写 user 消息，触摸事件不进聊天记录
   - 复用 getSystemPrompt / callAI / renderMessages / requestAndPlaySpeech
   - 不改动 callStar、callSpecialAI、普通聊天语音的任何行为
   - touchAIEnabled / touchVoiceEnabled 两个闸门彼此独立
   ============================================================ */
const TOUCH_ZONES = {
  head: '头顶', left_shoulder: '左肩', right_shoulder: '右肩',
  abs: '腹肌', back: '后背', hand: '手', waist: '腰'
};
const TOUCH_DAILY_MAX = 100;               // 每天最多触发的触摸 AI 次数
const TOUCH_REASON_TEXT = {
  'disabled': '触摸 AI 是关闭的',
  'no-key': '还没有填写 API Key',
  'busy': '正在聊天中，稍后再试',
  'daily-limit': '今天的触摸回应已达上限',
  'duplicate': '同一次触摸，已处理过',
  'ai-error': '这次没能拿到回复',
  'save-error': '回复没能保存',
  'silent': '这次没有说话'
};

const touchState = { dayKey: '', dayCount: 0, lastId: '' };
const TOUCH_STATE_KEY = 'ylxh_touch_state';

// 每日计数与去重状态落到 localStorage：刷新页面后不会重置每日上限
function touchLoadState() {
  try {
    const raw = localStorage.getItem(TOUCH_STATE_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (!s || typeof s !== 'object') return;
    touchState.dayKey = s.dayKey || '';
    touchState.dayCount = Number(s.dayCount) || 0;
    touchState.lastId = s.lastId || '';
  } catch (e) { /* 隐私模式：退化成内存态 */ }
}

function touchSaveState() {
  try {
    localStorage.setItem(TOUCH_STATE_KEY, JSON.stringify({
      dayKey: touchState.dayKey,
      dayCount: touchState.dayCount,
      lastId: touchState.lastId
    }));
  } catch (e) {}
}

function touchTodayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

function touchQuotaLeft() {
  const k = touchTodayKey();
  if (touchState.dayKey !== k) { touchState.dayKey = k; touchState.dayCount = 0; }
  return Math.max(0, TOUCH_DAILY_MAX - touchState.dayCount);
}

function touchZoneText(zone) {
  return TOUCH_ZONES[zone] || '身上';
}

/* ---------- 触摸状态记录（独立于 AI 回复） ----------
   硬件识别到触摸就立即落一条轻量状态记录，不等 AI、不受 AI 失败/沉默影响。
   只写本地的独立记录表（localStorage），不进 messages 表、不进 AI 上下文。 */
const TOUCH_LOG_KEY = 'ylxh_touch_log';
const TOUCH_LOG_MAX = 80;                  // 最多保留的触摸记录条数
const TOUCH_LOG_KEEP_MS = 7 * 24 * 3600 * 1000;
let touchLog = [];
let touchTyping = false;
let touchStyleReady = false;
const touchPhraseLast = {};

// 各部位的说法池：live 用进行态，done 用完成态。
// 只用硬件确实识别到的信息（部位 + 时长），不添加动作细节。
const TOUCH_ZONE_PHRASES = {
  head: {
    live: ['你轻轻摸着小星的头顶', '你的指尖落在小星的头顶', '你碰着小星的头顶'],
    done: ['你摸了摸小星的头顶', '你的指尖在小星的头顶停了一下', '你碰了碰小星的头顶']
  },
  abs: {
    live: ['你轻轻摸着小星的腹肌', '你的指尖贴着小星的腹肌'],
    done: ['你轻轻碰了碰小星的腹肌', '你的指尖在小星的腹肌上停了一下']
  },
  back: {
    live: ['你轻轻摸着小星的后背', '你的手贴着他的后背'],
    done: ['你碰了碰小星的后背', '你把手放在小星的后背上', '你的指尖贴上他的后背']
  },
  hand: {
    live: ['你轻轻摸着小星的手', '你的指尖搭在小星的手上', '你碰着小星的手'],
    done: ['你碰了碰小星的手', '你的指尖在小星手边停了一下', '你把手轻轻放在小星手上']
  },
  waist: {
    live: ['你轻轻碰着小星的腰', '你的手贴着小星的腰'],
    done: ['你碰了碰小星的腰', '你的手在小星的腰上停了一下']
  },
  left_shoulder: {
    live: ['你轻轻碰着小星的肩膀', '你的手搭在小星肩上'],
    done: ['你碰了碰小星的肩膀', '你在小星肩上停了一下']
  },
  right_shoulder: {
    live: ['你轻轻碰着小星的肩膀', '你的手搭在小星肩上'],
    done: ['你碰了碰小星的肩膀', '你在小星肩上停了一下']
  }
};

function touchSecondsText(ms) {
  const n = Number(ms) || 0;
  if (n <= 0) return '';
  const s = Math.round(n / 100) / 10;
  return (s >= 10 ? String(Math.round(s)) : s.toFixed(1).replace(/\.0$/, '')) + ' 秒';
}

// 同一部位连续触摸时避开上一次的措辞，避免每次都是同一句
function pickTouchPhrase(zone, phase, ms) {
  const z = TOUCH_ZONE_PHRASES[zone];
  const pool = z && z[phase];
  if (!pool || !pool.length) {
    return (phase === 'live' ? '你碰着小星的' : '你碰了碰小星的') + touchZoneText(zone);
  }
  const key = zone + '|' + phase;
  let i = Math.floor(Math.random() * pool.length);
  if (pool.length > 1 && i === touchPhraseLast[key]) i = (i + 1) % pool.length;
  touchPhraseLast[key] = i;
  return pool[i];
}

// 状态文案 = 部位说法 + 时长（时长全部来自硬件的 durMs，不估算、不递增）
function touchStatusLineText(entry) {
  const e = entry || {};
  const phase = e.final ? 'done' : 'live';
  const base = e.phrase || pickTouchPhrase(e.zone, phase, e.ms);
  const sec = touchSecondsText(e.ms);
  if (!e.final) return base + (sec ? ' · ' + sec : '');
  if (!sec) return base;
  if (e.ms < 600) return base + '，只一下';
  if (e.ms >= 5000) return base + '，停留了 ' + sec + '，很久没有移开';
  return base + '，停留了 ' + sec;
}

function ensureTouchStatusStyle() {
  if (touchStyleReady || document.getElementById('touchStatusStyle')) { touchStyleReady = true; return; }
  const css = ''
    + '.message.touch-status-message{display:flex;justify-content:center;margin:6px 0;}'
    + '.touch-status-line{display:inline-flex;align-items:center;gap:6px;max-width:84%;padding:4px 12px;'
    + 'border-radius:999px;background:rgba(150,160,200,.10);border:1px solid rgba(160,170,210,.22);'
    + 'color:#8d93ad;font-size:12px;line-height:1.6;transition:background .3s;}'
    + '.touch-status-dot{font-size:11px;opacity:.75;}'
    + '.touch-status-time{opacity:.55;font-size:11px;margin-left:2px;}'
    + '.message.touch-status-message.is-live .touch-status-line{background:rgba(150,160,200,.17);'
    + 'border-color:rgba(160,170,210,.38);color:#7c86a8;}'
    + '.message.touch-typing-message{display:flex;justify-content:center;margin:4px 0;}'
    + '.touch-typing-line{font-size:12px;color:#9aa0b8;font-style:italic;letter-spacing:.4px;}'
    + '.touch-typing-line i{font-style:normal;animation:touchDotFade 1.2s infinite;}'
    + '.touch-typing-line i:nth-child(2){animation-delay:.2s;}'
    + '.touch-typing-line i:nth-child(3){animation-delay:.4s;}'
    + '@keyframes touchDotFade{0%{opacity:.2}50%{opacity:1}100%{opacity:.2}}';
  const el = document.createElement('style');
  el.id = 'touchStatusStyle';
  el.textContent = css;
  document.head.appendChild(el);
  touchStyleReady = true;
}

function touchLoadLog() {
  try {
    const raw = localStorage.getItem(TOUCH_LOG_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return;
    const cutoff = Date.now() - TOUCH_LOG_KEEP_MS;
    touchLog = arr
      .filter(x => x && x.zone && Number(x.time) > cutoff)
      .map(x => ({
        id: String(x.id || ''),
        zone: String(x.zone),
        ms: Number(x.ms) || 0,
        time: Number(x.time) || Date.now(),
        final: true,
        phrase: String(x.phrase || '')
      }))
      .slice(-TOUCH_LOG_MAX);
  } catch (e) { touchLog = []; }
}

function touchSaveLog() {
  try {
    localStorage.setItem(TOUCH_LOG_KEY, JSON.stringify(touchLog.map(x => ({
      id: x.id, zone: x.zone, ms: x.ms, time: x.time, phrase: x.phrase
    }))));
  } catch (e) { /* 隐私模式：退化成内存态，不影响显示 */ }
}

/* 两阶段时序：start 只建/维持状态，end 才定稿并允许请 AI。
   - start 包 durMs=0；end 包带本次真实时长（固件已按补偿算法算好）。
   - 同一部位在 end 之前只维持同一条记录，不新建、不触发 AI。
   - 没收到 start（刷新、丢包、旧固件）时，end 也能补出一条完整记录。 */
const TOUCH_START_TIMEOUT_MS = 20000;   // 一直没等到结束包的兜底，避免状态永远停在「正在摸」
let touchLastEndId = '';
const touchPending = {};                // zone -> 正在进行的记录

function touchEventPhase(ev) {
  const p = ev && ev.phase ? String(ev.phase) : '';
  if (p === 'start' || p === 'end') return p;
  // 没有 phase 字段时按协议约定推断：开始包 durMs=0，结束包 durMs>=1
  return (Number(ev && ev.durMs) || 0) > 0 ? 'end' : 'start';
}

function touchPushEntry(entry) {
  touchLog.push(entry);
  if (touchLog.length > TOUCH_LOG_MAX) touchLog.splice(0, touchLog.length - TOUCH_LOG_MAX);
}

function touchStopTimers(entry) {
  if (!entry) return;
  if (entry._tick) { clearInterval(entry._tick); entry._tick = null; }
  if (entry._timeout) { clearTimeout(entry._timeout); entry._timeout = null; }
}

// 只更新这一行的文案，不重建整个消息列表（持续触摸时每秒一次）
function touchRefreshDom(entry) {
  const sel = '.touch-status-message[data-touch-id="' + String(entry.id).replace(/"/g, '\\"') + '"]';
  const el = document.querySelector(sel + ' .touch-status-text');
  if (!el) { renderMessages(); return; }
  el.textContent = touchStatusLineText(entry);
}

function touchStartTicker(entry) {
  touchStopTimers(entry);
  entry._tick = setInterval(function () {
    if (!entry.final) {
      const live = Math.max(0, Date.now() - (entry.startedAt || entry.time));
      if (live !== entry.ms) { entry.ms = live; touchRefreshDom(entry); }
    }
  }, 1000);
  entry._timeout = setTimeout(function () {
    entry._timeout = null;
    // 20 秒仍没等到结束包：就地收尾，不带时长（不编造一个假的时长）
    touchFinishEntry(entry, 0);
  }, TOUCH_START_TIMEOUT_MS);
}

function touchFinishEntry(entry, ms) {
  if (!entry) return entry;
  touchStopTimers(entry);
  if (ms > 0) entry.ms = ms;
  entry.final = true;
  entry.phrase = pickTouchPhrase(entry.zone, 'done', entry.ms);
  if (touchPending[entry.zone] === entry) delete touchPending[entry.zone];
  touchSaveLog();
  renderMessages();
  return entry;
}

// 手指刚接触：立刻建一条状态记录（不等 AI）。重复的 start 只维持同一条。
function touchStatusBegin(ev) {
  const e = ev || {};
  const zone = String(e.zone || '');
  const at = Number(e.at) || Date.now();
  const prev = touchPending[zone];
  if (prev && !prev.final) {
    // 上一次没等到结束包（丢包）：先收尾，避免同一部位两条实时记录打架
    touchFinishEntry(prev, Math.max(0, Date.now() - (prev.startedAt || prev.time)));
  }
  const entry = {
    id: String(e.id || ('t-' + at + '-' + Math.random().toString(36).slice(2, 6))),
    zone: zone,
    ms: 0,
    startedAt: at,
    time: at,
    final: false,
    phrase: pickTouchPhrase(zone, 'live', 0)
  };
  touchPushEntry(entry);
  touchPending[zone] = entry;
  touchStartTicker(entry);
  renderMessages();
  return entry;
}

// 手指离开：用硬件时长定稿同一条记录；没有对应 start 时补一条完整记录
function touchStatusEnd(ev) {
  const e = ev || {};
  const zone = String(e.zone || '');
  const ms = Math.max(0, Number(e.durMs) || 0);
  const at = Number(e.at) || Date.now();
  const live = touchPending[zone];
  if (live && !live.final) return touchFinishEntry(live, ms);
  const entry = {
    id: String(e.id || ('t-' + at + '-' + Math.random().toString(36).slice(2, 6))),
    zone: zone,
    ms: ms,
    startedAt: at,
    time: at,
    final: true,
    phrase: pickTouchPhrase(zone, 'done', ms)
  };
  touchPushEntry(entry);
  touchSaveLog();
  renderMessages();
  return entry;
}

// 兼容旧调用：单条事件（只有结束包）时直接落一条完整记录
function touchStatusOnEvent(ev) {
  if (touchEventPhase(ev) === 'start') return touchStatusBegin(ev);
  return touchStatusEnd(ev);
}

function renderTouchStatusItem(list, entry) {
  if (!list || !entry) return;
  ensureTouchStatusStyle();
  const item = document.createElement('div');
  item.className = 'message touch-status-message' + (entry.final ? '' : ' is-live');
  if (entry.id) item.setAttribute('data-touch-id', entry.id);

  const line = document.createElement('div');
  line.className = 'touch-status-line';

  const dot = document.createElement('span');
  dot.className = 'touch-status-dot';
  dot.textContent = entry.final ? '✦' : '◌';
  line.appendChild(dot);

  const text = document.createElement('span');
  text.className = 'touch-status-text';
  text.textContent = touchStatusLineText(entry);
  line.appendChild(text);

  if (settings.showTime !== false && entry.time) {
    const t = document.createElement('span');
    t.className = 'touch-status-time';
    t.textContent = new Date(entry.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    line.appendChild(t);
  }

  item.appendChild(line);
  list.appendChild(item);
}

// 触摸事实块：进 system。只给此刻的真实感受与事实，不把互动写成事件报告；
// 人设与说话方式完全交给 getSystemPrompt，这里不叠加新的语气/长度规则。
function touchFactBlock(ev) {
  const ms = Number(ev && ev.durMs) || 0;
  const seconds = Math.round(ms / 100) / 10;
  const zone = touchZoneText(ev && ev.zone);
  // 次数只是给「你」的底数，不是每轮必播的台词：说不说、怎么说，交给当下的互动来判断。
  const times = Number(touchState.dayCount) || 0;
  return '【刚刚的触碰】\n'
    + '用户轻轻碰了碰你的' + zone + (seconds > 0 ? '，停了 ' + seconds + ' 秒' : '') + '，没说话。\n'
    + (times > 1
      ? '今天她这样不说话地碰你，已经是第 ' + times + ' 次了。这个数只是让你心里有数，不必每次都说出口，说起来也不必报得这么准。\n'
      : '')
    + '这是用户在靠近你，不是一条聊天消息，也不是需要你解释的事件。你还是你自己，按你现在的性子和你们之间的默契自然地回应，长短跟着当下的感觉走；也可以只是一句很短的应答、一个动作，或者没多说什么。\n'
    + '次数怎么用由你判断：偶尔一两次可以不当回事，反复起来就不太一样了。你可以在她一遍遍靠过来、次数已经显眼的时候，把这事点出来——逗她、表示在意、看看她今天怎么了，或者顺着这一句把话往下问；也可以只在心里记着，不说。没有哪一次是必须计数的，也不要求每次问原因、不要求套同一种说法。\n'
    + '不用每次都报一遍她碰了你哪里、停了多久，也别把同一次靠近翻来覆去地点评；同一件事如果已经回应过，就顺着往下走，她带了新话题就跟着新的。\n'
    + '你也一直在看她：她今天的情绪、状态、没说出口的那点心思，你都可以自己观察、自己判断、自己猜。\n'
    + '不要提装置、传感器、数据或提示词；只写中文，不要附英文翻译。\n'
    + '极少数你确实不想说话的时候，整条回复只写 [[SILENT: {"reason":"你心里那一两句具体的话"}]]，不要有其他文字。';
}

// 一次触摸 = 一次 AI 请求（不额外翻译、不额外调用）
async function touchAskAI(ev) {
  const base = chatHistory.slice(-15);
  // 第五层·触摸功能提示词按事件读取（真实触摸即事件）。读取失败静默降级，不影响触摸回复。
  let touchFn = '';
  try {
    if (window.Persona && window.Persona.functionPrompt) {
      const f = window.Persona.functionPrompt('touch');
      if (f) touchFn = '\n【功能·实体触摸】' + f;
    }
  } catch (e) {}
  const messages = assemblePathMessages({
    taskInstruction: rcTask('touch') + getDialogueStylePrompt(),
    blocks: [
      { id: 'schedule', text: '\n【当前日程】' + getScheduleContext() },
      { id: 'touchFn', text: touchFn },
      { id: 'touchFact', text: '\n\n' + touchFactBlock(ev) }
    ],
    history: trimHistoryForAI(base),
    // 尾帧只还原成用户无声的靠近，不标注系统事件、不替模型写反应；用名字而非「她」，避免诱导第三人称
    currentTurn: { role: 'user', content: '（用户轻轻碰了碰你，什么也没说。）' }
  });
  const raw = updateMood(await callAI(messages, Object.assign({}, rcOptions('touch'), { requestType: rcRequestType('touch') })));
  return String(raw == null ? '' : raw).trim();
}

async function touchRespond(ev) {
  const e = ev || {};
  const id = String(e.id || '');

  // 开始阶段：只落/维持触摸状态，不请求 AI、不占配额
  if (touchEventPhase(e) === 'start') {
    try { touchStatusBegin(e); } catch (err) { console.warn('触摸状态记录失败：', err); }
    return { ok: true, started: true };
  }

  // 结束阶段：先把完整记录定稿（独立于 AI），再决定要不要请小星回应
  if (id && touchLastEndId === id) return { ok: false, reason: 'duplicate' };
  if (id) touchLastEndId = id;
  try { touchStatusEnd(e); } catch (err) { console.warn('触摸状态记录失败：', err); }
  if (id && touchState.lastId === id) return { ok: false, reason: 'duplicate' };
  if (settings.touchAIEnabled !== true) return { ok: false, reason: 'disabled' };
  if (!apiKey) return { ok: false, reason: 'no-key' };
  if (isSending || isTyping) return { ok: false, reason: 'busy' };
  if (touchQuotaLeft() <= 0) return { ok: false, reason: 'daily-limit' };

  touchState.dayKey = touchTodayKey();
  touchState.dayCount += 1;
  if (id) touchState.lastId = id;
  touchSaveState();

  let raw = '';
  touchTyping = true;
  renderMessages();
  try {
    raw = await touchAskAI(e);
  } catch (err) {
    return { ok: false, reason: 'ai-error', error: err && err.message };
  } finally {
    touchTyping = false;
    renderMessages();
  }

  if (!raw || /^\[\[\s*SILENT/i.test(raw)) return { ok: true, silent: true };

  let text = raw;
  try { text = await lockStickerInText(raw); } catch (err) { text = raw; }
  if (!String(text || '').trim()) return { ok: true, silent: true };

  const message = { role: 'assistant', content: text, time: Date.now(), source: 'touch' };
  try {
    message.id = await addToStore('messages', message);
  } catch (err) {
    return { ok: false, reason: 'save-error', error: err && err.message };
  }
  chatHistory.push(message);
  beginTypewriterReveal(message);
  renderMessages();

  // 语音：独立开关。失败只丢音频，文字回复和后续触摸都不受影响
  if (settings.touchVoiceEnabled === true) {
    try { await requestAndPlaySpeech(text, message.id, { force: true }); }
    catch (err) { console.warn('触摸语音生成失败（不影响文字）：', err); }
  }
  return { ok: true, silent: false, id: message.id };
}

// 联调用的模拟触摸：不经设备，按「开始 → 结束」两阶段走完整链路
async function touchSimulate(zone) {
  const z = zone || 'head';
  const at = Date.now();
  const tail = Math.random().toString(36).slice(2, 6);
  const startEv = { id: 'sim-' + at + '-s-' + tail, zone: z, durMs: 0, phase: 'start', at: at };
  try { if (window.TouchBridge && window.TouchBridge.showHint) window.TouchBridge.showHint(startEv, true); } catch (err) {}
  try { touchStatusBegin(startEv); } catch (err) {}
  await new Promise(r => setTimeout(r, 700));
  const endEv = { id: 'sim-' + at + '-e-' + tail, zone: z, durMs: 1200, phase: 'end', at: at + 700 };
  try { if (window.TouchBridge && window.TouchBridge.showHint) window.TouchBridge.showHint(endEv); } catch (err) {}
  const r = await touchRespond(endEv);
  if (r.ok && r.silent) toast('星星这次没有出声。');
  else if (r.ok) toast('星星回应了触摸。');
  else toast('触摸未触发 AI：' + (TOUCH_REASON_TEXT[r.reason] || r.reason));
  return r;
}

touchLoadState();
touchLoadLog();

window.StarTouch = {
  respond: touchRespond,
  begin: touchStatusBegin,
  simulate: touchSimulate,
  zones: TOUCH_ZONES,
  state: touchState,
  log: touchLog,
  quotaLeft: touchQuotaLeft
};

// S2a dry-run：callAI / kvGet / 请求地址。
// P0：额外暴露 kvSet，仅供面板在用户逐条审核并确认后写入正式机自述与独立水位键；
// dry-run 的 run() 本身仍是只读，不在用户确认前写任何数据。
window.SelfNarrativeDryRunDeps = {
  callAI: callAI,
  kvGet: kvGet,
  kvSet: kvSet,
  apiBase: API_BASE
};

// S3 增量自动整理 + 安全纠正：复用上面的依赖（callAI / kvGet / kvSet），
// 不新增常驻服务；批次由面板按钮或宿主在合适时机显式触发一次。
window.SelfNarrativeAutoDeps = {
  callAI: callAI,
  kvGet: kvGet,
  kvSet: kvSet
};

init();