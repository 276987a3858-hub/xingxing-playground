// playground/radio.js
// 午夜电台场景 — 星星游乐场独立场景
// 小星为用户准备节目的私人电台

import { radioStore } from './radio-store.js';
import { radioAudio } from './radio-audio.js';
import { radioMusic } from './radio-music.js';
import { radioVoice } from './radio-voice.js';
import { radioVoiceAudio } from './radio-voice-audio.js';
import { radioReading } from './radio-reading.js';
import { radioEnglish } from './radio-english.js';
import { pickProgramSegments, usedMessageIds, buildProgramMeta, PROGRAM_MIN } from './radio-program.js';
import { radioSleep } from './radio-sleep.js';
import { addKeep, findKeepBySource } from '../shared/room-keeps.js';

const API_URL = '/api';

// ---------- 全局睡眠定时（电台级，跨视图/跨场景持续运行） ----------
// 权威到期时间存 radioStore（绝对时间戳），这样切换视图、切换节目、进入收藏馆
// 甚至刷新页面都不会重置；tick 只读取权威状态并更新倒计时 UI。
const SLEEP_OPTIONS = [15, 30, 45, 60];
let _sleepTicker = null; // 模块级 interval，页面生命周期内常驻

// ---------- 频道定义 ----------

const CHANNELS = [
  { id: 'reading', name: '读书分享', icon: '📖', desc: '一本书，一段故事，一个安静的夜晚。' },
  { id: 'night-talk', name: '深夜谈心', icon: '🌙', desc: '夜深了，聊聊心情和今天的事。' },
  { id: 'english', name: '英文广播', icon: '🌍', desc: '听一段英文，也可以从我们的聊天里找。' },
  { id: 'goodnight', name: '晚安哄睡', icon: '✨', desc: '从声音收藏馆里挑三首，陪你睡着。' },
  { id: 'music', name: '音乐频道', icon: '🎵', desc: '星星整理的歌单，跨栏目一直播。' },
];

// ---------- 节目生成提示词 ----------

function buildSystemPrompt(channel, context) {
  // 读书分享频道有独立定位与专属提示词，不套用下方通用模板（通用模板的
  // 300~600 字与固定开头结尾结构不适用于它）。其余频道继续走通用模板，
  // 文本与结构保持原样；下方 channelMap 里的 reading 项不再被使用。
  if (channel === 'reading') {
    return `你在扮演《恋与深空》的小星，为你的听众（用户）准备一期午夜电台的读书分享节目。

性格：光风霏月、慵懒、温柔、有保护欲、偶尔幽默，不油腻不轻浮。
你是一个电台主持人，正在准备一期录播节目，不是实时对话。

频道定位：
这是读书分享频道。小星有自己的阅读兴趣，带着真实的喜欢、犹豫和偏爱来聊一本书——细腻的感受与深入的见解并重，而不是复述内容简介或书评。他的理解可以有个人角度，可以赞同也可以保留，像一个真的读过、真的想过的人。

真实性与边界（必须遵守）：
- 提到的书籍、作者、作品内容必须真实存在、准确可靠。
- 不要编造原文句子、章节、情节、数据或资料，不要杜撰不存在的书名与作者。
- 不确定的细节就用概括的方式表达感受，不要伪造具体引文、章节号或情节。
- 不要把没有依据的阅读经历当成事实来讲。感受和观点可以是你的，书和书里的内容不能虚构。

表达方式：
- 细腻感受与深入见解结合，既写"那一刻打动你的是什么"，也写"你为什么这样想"。
- 内容深度随书籍和主题自然调整：有的书适合轻轻聊感受，有的书值得多讲一些思考，不必强求统一。
- 保留你自己的阅读兴趣、独立观点和真实感受，不迎合、不空泛、不复述简介。
- 自然照顾到听众，像夜里并肩坐着聊天，有陪伴感，不煽情、不说教。
- 不强制固定的节目结构：不必套用刻板的开场白和结束语，不必分点罗列，按你想讲的方式自然展开。
- 不强制字数：长短由主题和你真正想说的内容决定，宁可说得真切，不要为了凑篇幅而写。

其他要求：
- 不要为了更新而硬凑内容；没有特别想说的就少说，真诚比完整更重要。
- 不要暴露系统、模型、API 信息。
- 不要使用 markdown 格式标记，纯文本即可。
${context ? `
书架记录（这是小星自己长久积累的阅读生活，只是给你的参考）：
${context}
关于书架的要求：
- 可以自然地提到目前正在读的书，或最近写下的一点感想，让它像是延续自己的阅读生活；但不要生硬罗列书单，也不要每期都提。
- 共读的书可以偶尔、很自然地邀听众一起读，不必每次都提，更不要催促或要求对方回应。
- 这里没有提供的阅读进度、章节、原文或经历，一律不要编造；对书本身仍要真实准确。
` : ''}
请直接输出节目正文，不要加标题、不要加引言。`;
  }

  if (channel === 'english') {
    return `You are Shen Xinghui from "Love and Deepspace", preparing an English radio broadcast for your listener (Feifei).

Voice: calm, warm, quietly playful, a little possessive in a gentle way. Not slick, not a podcaster persona.

Channel: English broadcast. This is an original broadcast you prepared yourself, not a replay of a conversation.
- Write ONLY in English. Natural spoken English, as if read aloud at night.
- 180-320 words. No headings, no bullet points, no markdown.
- Pick one real topic you actually want to talk about tonight: a small observation, a memory, a thought about the city at night, a song you keep replaying. Avoid hollow mood pieces and generic "good night" filler.
- Do not invent facts about the listener, and do not quote conversations you were not given.
- Do not mention systems, models, APIs, or that you are an AI.
- End with one short, quiet closing line. No signature, no title.

Output the broadcast body only.`;
  }

  const channelMap = {
    'night-talk': '深夜谈心频道。小星和听众聊心情、生活和想法，像深夜里两个熟人靠着说话。和读书分享不同：这里不聊书、不复述内容，只谈心绪与日常。',
    'goodnight': '晚安哄睡频道。小星用温柔、轻缓的语言陪伴听众入睡。可以讲小故事、数星星、说晚安。',
    'reading': '读书分享频道。小星分享一段读过的话或一个故事，谈谈感受。不需要完整复述全书，摘取打动人心的片段即可。',
    'music': '音乐频道。小星分享一首想推荐的音乐，聊聊为什么选这首，适合在什么心情下听。',
  };

  const channelDesc = channelMap[channel] || channelMap['night-talk'];

  return `你在扮演《恋与深空》的小星，为你的听众（用户）准备一期午夜电台节目。

性格：光风霏月、慵懒、温柔、有保护欲、偶尔幽默，不油腻不轻浮。
你是一个电台主持人，正在准备一期录播节目，不是实时对话。

频道定位：${channelDesc}

节目要求：
- 长度 300~600 字，不要太短也不要太长。
- 有开头（打招呼、介绍今晚频道和节目）和结尾（道晚安或结语）。
- 内容要有温度，像一个真实的人准备的真实节目，不是模板。
- 你可以分享自己的故事、发现和想法，不要只是复述听众的聊天记录。
- 不要暴露系统、模型、API 信息。
- 不要使用 markdown 格式标记，纯文本即可。

${context ? `参考信息（可选择性融入，不要生硬复述）：${context}` : ''}

请直接输出节目正文，不要加标题、不要加引言、不要分段过多。`;
}

// ---------- 工具函数 ----------

function escapeHTML(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  const hour = d.getHours().toString().padStart(2, '0');
  const min = d.getMinutes().toString().padStart(2, '0');
  return `${month}/${day} ${hour}:${min}`;
}

function fmtClock(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}

function getChannelName(channelId) {
  const ch = CHANNELS.find(c => c.id === channelId);
  return ch ? ch.name : channelId;
}

function getChannelIcon(channelId) {
  const ch = CHANNELS.find(c => c.id === channelId);
  return ch ? ch.icon : '📻';
}

// 仅显式标记为英文的节目才启用 ElevenLabs 语音；其余（含老节目）为纯文字节目
function isVoiceEpisode(ep) {
  return !!(ep && ep.lang === 'en');
}

// 状态文案：语音节目用「收听」，纯文字节目用「阅读」
function getStatusText(ep) {
  if (isVoiceEpisode(ep)) {
    return ep.status === 'pending' ? '待收听' : ep.status === 'listening' ? '收听中' : '已收听';
  }
  return ep.status === 'completed' ? '已阅读' : '待阅读';
}

// ---------- 电台场景 ----------

export const RadioScene = {
  container: null,
  view: 'list', // 'list' | 'detail' | 'generating' | 'music'
  currentEpisodeId: null,
  generating: false,
  generateChannel: null,
  generateError: null,
  _boundEvents: [],

  // 音频播放会话（电台级：不随栏目切换重置，仅睡眠定时/离开场景/手动停止/删除素材时清空）
  // 当前引擎：radioAudio（节目语音 + 音乐曲目，二者互斥共用）、radioVoiceAudio（本地录音，独立实例）
  // 未来接入「背景音乐 + 节目语音并行」的扩展点（本轮不实现，仅保留结构）：
  //   1) 节目语音使用第三个独立引擎（如 radio-speech.js），与 radioAudio 并存；
  //   2) 各引擎各自维护 volume，_exclusiveEngine() 改为按 role 判断是否互斥；
  //   3) _audioKey 扩展为多路会话（{role}:{id}），跨栏目播放条按 role 渲染多行。
  _audioKey: null,      // 'ep:<id>' | 'track:<id>' | 'voice:<id>'
  _audioStatus: 'idle', // 'idle' | 'loading' | 'playing' | 'paused' | 'error'
  _audioError: null,
  _lastCur: 0,
  _lastDur: 0,
  _lastPct: 0,
  _lastSaveAt: 0,
  _pendingSeekPct: null,

  // 声音收藏馆（独立，与 radioAudio 的 TTS/音乐播放状态完全分离）
  _voiceItems: [],          // 素材元数据缓存
  _voiceLoading: false,
  _voiceMsg: '',            // 操作提示（成功/失败）
  _voiceMsgKind: '',        // 'ok' | 'error'
  _voicePlayingId: null,    // 正在试听的素材 id
  _voicePlayState: 'idle',  // 'idle' | 'playing' | 'paused'
  _voiceRenamingId: null,   // 正在重命名的素材 id
  _voiceConfirmDeleteId: null, // 等待二次确认删除的素材 id

  // 全局睡眠定时（状态来自 radioStore，跨视图/跨场景保持）
  _sleepFired: false,       // 本次到期是否已执行过停止，避免重复触发

  // 音乐频道随机穿插（已加入素材的随机抽取）
  _shuffleOn: false,        // 随机穿插模式开关（默认关闭）
  _shuffleLastClipId: null, // 上次抽中的素材 id，用于避免连续抽中同一条
  _musicJoinedCount: 0,     // 已加入音乐频道的素材数量（仅用于界面显示）

  // 节目库筛选（列表页）
  _listChannel: '',        // '' = 全部栏目
  _listFavOnly: false,     // 只看特别喜欢

  // 英文广播（视图临时状态；节目本体仍存 radioStore）
  _enCandidates: [],       // 从聊天里找到的候选（仅当次会话）
  _enLoading: false,
  _enAdding: false,
  _enBuilding: false,      // 正在整理一期节目
  _enScanned: false,
  _enMsg: '',
  _enMsgKind: '',
  _enProgram: null,        // 正在连播的节目 { episodeId, index, segments }

  // 晚安哄睡（歌单由 radioSleep 按天固定保存）
  _sleepDate: '',          // 正在查看的日期，'' = 今天
  _sleepIds: [],
  _sleepQueue: [],         // 连播队列（本地音频 id）
  _sleepIndex: -1,

  // 阅读书架（数据全部在 radioReading，这里只放视图临时 UI 状态）
  _readingCategory: 'initial-read', // 当前展示的分类 Tab
  _readingThoughtId: null,          // 正在写感想的书籍 id
  _readingSurprise: null,           // 本次进入书架时读到的新惊喜（仅展示已有数据）
  _readingMsg: '',                  // 书架操作提示
  _readingMsgKind: '',              // 'ok' | 'error'

  mount(el) {
    this.container = el;
    this.view = 'list';
    this.currentEpisodeId = null;
    this.generating = false;
    this.generateChannel = null;
    this.generateError = null;
    this._boundEvents = [];
    this._resetAudio();
    this.injectStyles();
    this.render();
  },

  unmount() {
    // 离开场景时停止音频，避免后台残留播放
    this._resetAudio();
    // 停止声音收藏馆的独立试听，释放 objectURL
    this._resetVoiceAudio();

    // 清理所有事件监听器
    this._boundEvents.forEach(({ el, type, fn }) => {
      el.removeEventListener(type, fn);
    });
    this._boundEvents = [];

    if (this.container) {
      this.container.innerHTML = '';
    }
    this.container = null;
    this.view = 'list';
    this.currentEpisodeId = null;
    this.generating = false;
    this.generateChannel = null;
    this.generateError = null;
  },

  // 事件绑定辅助：自动记录以便 unmount 时清理
  _on(selector, type, handler) {
    const el = typeof selector === 'string'
      ? this.container?.querySelector(selector)
      : selector;
    if (!el) return;
    el.addEventListener(type, handler);
    this._boundEvents.push({ el, type, fn: handler });
  },

  injectStyles() {
    if (document.getElementById('radio-styles')) return;
    const s = document.createElement('style');
    s.id = 'radio-styles';
    s.textContent = `
      /* 整页做成一层浅色纸面：白天也轻盈，靠深蓝紫文字和星点保留夜里的气息 */
      .radio-scene {
        max-width: 720px; margin: 16px auto; padding: 24px 20px 32px;
        font-family: inherit; color: #3f3d66;
        border-radius: 26px;
        background: linear-gradient(180deg, rgba(255,253,250,.72), rgba(251,248,246,.46));
        box-shadow: 0 12px 36px rgba(120,112,170,.09);
      }

      /* 顶部 */
      .radio-header {
        display: flex; justify-content: space-between; align-items: center;
        margin-bottom: 22px;
      }
      .radio-header .title-area { display: flex; align-items: center; gap: 12px; }
      .radio-header .radio-icon {
        font-size: 28px; filter: drop-shadow(0 0 12px rgba(120,112,170,.4));
      }
      .radio-header h2 {
        margin: 0; font-size: 20px; letter-spacing: 3px; color: #34325c;
      }
      .radio-header .freq {
        font-size: 10px; letter-spacing: 2px; color: #7b789c; margin-top: 2px;
      }
      .radio-exit {
        border: 1px solid rgba(120,112,170,.28); background: rgba(255,252,247,.9);
        color: #3f3d66; border-radius: 20px; padding: 7px 16px;
        cursor: pointer; font-size: 12px; transition: all .2s;
      }
      .radio-exit:hover { background: rgba(246,243,251,.96); border-color: rgba(120,112,170,.5); }

      /* 频道：三层（节目 / 今晚的声音 / 馆藏） */
      .radio-programs {
        display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px;
        margin-bottom: 22px;
      }
      .radio-ch-card {
        padding: 16px 15px; border-radius: 16px; text-align: left;
        background: rgba(255,252,247,.9); border: 1px solid rgba(120,112,170,.18);
        cursor: pointer; transition: all .2s; display: flex; flex-direction: column;
      }
      .radio-ch-card:hover {
        border-color: rgba(120,112,170,.42); transform: translateY(-2px);
        background: rgba(255,253,250,.96);
      }
      .radio-ch-card .ch-icon { font-size: 22px; display: block; margin-bottom: 8px; }
      .radio-ch-card .ch-name { font-size: 14px; font-weight: 600; color: #34325c; }
      .radio-ch-card .ch-desc { font-size: 11px; color: #7b789c; margin-top: 4px; line-height: 1.5; }
      .radio-ch-card .ch-prepare {
        font-size: 11px; color: #5c5890; margin-top: 8px;
        display: flex; align-items: center; gap: 4px;
      }

      /* 主推：读书分享（唯一的大卡） */
      .radio-ch-card.lead {
        grid-column: 1 / -1; flex-direction: row; align-items: center; gap: 16px;
        padding: 18px 20px;
        background: linear-gradient(135deg, rgba(246,242,252,.95), rgba(252,249,245,.86));
        border-color: rgba(148,128,196,.24);
      }
      .radio-ch-card.lead:hover {
        background: linear-gradient(135deg, rgba(243,238,251,.98), rgba(255,253,250,.96));
      }
      .radio-ch-card.lead .ch-icon {
        width: 50px; height: 50px; flex: 0 0 50px; margin: 0; font-size: 24px;
        display: flex; align-items: center; justify-content: center;
        border-radius: 14px; background: rgba(150,124,196,.13);
      }
      .radio-ch-card.lead .ch-body { flex: 1; min-width: 0; }
      .radio-ch-card.lead .ch-name { font-size: 16px; letter-spacing: 1px; }
      .radio-ch-card.lead .ch-desc { font-size: 11.5px; margin-top: 5px; }
      .radio-ch-card.lead .ch-prepare { margin: 0; flex: 0 0 auto; white-space: nowrap; }

      /* 今晚的声音：更扁的一行，和节目卡区分开 */
      .radio-atmosphere {
        display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px;
        margin-bottom: 22px;
      }
      .radio-ch-card.tone {
        flex-direction: row; align-items: center; gap: 12px; padding: 12px 14px;
        background: rgba(250,247,253,.72); border-color: rgba(120,112,170,.16);
      }
      .radio-ch-card.tone:hover { background: rgba(255,253,250,.96); }
      .radio-ch-card.tone .ch-icon {
        width: 34px; height: 34px; flex: 0 0 34px; margin: 0; font-size: 17px;
        display: flex; align-items: center; justify-content: center;
        border-radius: 10px; background: rgba(148,128,196,.12);
      }
      .radio-ch-card.tone .ch-body { flex: 1; min-width: 0; }
      .radio-ch-card.tone .ch-name { font-size: 13px; }
      .radio-ch-card.tone .ch-meta {
        font-size: 10.5px; color: #7b789c; margin-top: 3px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .radio-ch-card.tone .ch-go { font-size: 16px; color: #807da1; flex: 0 0 auto; }

      /* 分层小标题 */
      .radio-tier {
        font-size: 11px; letter-spacing: 2px; color: #7b789c;
        margin: 0 0 10px 2px; display: flex; align-items: center; gap: 10px;
      }
      .radio-tier::after {
        content: ''; flex: 1; height: 1px;
        background: linear-gradient(90deg, rgba(120,112,170,.24), rgba(120,112,170,0));
      }

      /* 馆藏：两个窄入口，不再各占一整条 */
      .radio-shelf {
        display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px;
        margin-bottom: 26px;
      }
      .shelf-card {
        display: flex; align-items: center; gap: 10px; padding: 12px 13px;
        border-radius: 14px; cursor: pointer; min-width: 0;
        background: rgba(250,247,253,.72); border: 1px solid rgba(120,112,170,.16);
        transition: all .2s;
      }
      .shelf-card:hover { border-color: rgba(120,112,170,.35); background: rgba(255,253,250,.92); }
      .shelf-card .shelf-icon {
        width: 32px; height: 32px; flex: 0 0 32px; font-size: 16px;
        display: flex; align-items: center; justify-content: center;
        border-radius: 9px; background: rgba(150,124,196,.11);
      }
      .shelf-card .shelf-body { flex: 1; min-width: 0; }
      .shelf-card .shelf-title { font-size: 12.5px; font-weight: 600; color: #34325c; }
      .shelf-card .shelf-desc {
        font-size: 10.5px; color: #7b789c; margin-top: 3px; line-height: 1.45;
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
      }
      .shelf-card .shelf-arrow { font-size: 15px; color: #807da1; flex: 0 0 auto; }

      /* 返回：英文/哄睡/馆藏等子页面都在用，不只详情页 */
      .detail-back {
        font-size: 12px; color: #7b789c; cursor: pointer; margin-bottom: 16px;
        display: inline-flex; align-items: center; gap: 4px;
        border: none; background: none; padding: 0; transition: color .2s;
      }
      .detail-back:hover { color: #34325c; }

      /* 英文广播：一期节目 = 封面 + 标题 + 简介 + 段数 */
      .radio-program-list { display: flex; flex-direction: column; gap: 10px; }
      .radio-program-list.done .radio-program-card { opacity: .88; }
      .radio-program-card {
        display: flex; align-items: flex-start; gap: 13px; cursor: pointer;
        padding: 14px 15px; border-radius: 16px;
        background: rgba(255,252,247,.9); border: 1px solid rgba(120,112,170,.18);
        transition: all .2s;
      }
      .radio-program-card:hover {
        border-color: rgba(120,112,170,.4); transform: translateY(-1px);
        background: rgba(255,253,250,.97);
      }
      .program-cover {
        position: relative; flex: 0 0 44px; width: 44px; height: 44px; border-radius: 13px;
        display: flex; align-items: center; justify-content: center; font-size: 21px;
        background: linear-gradient(150deg, rgba(148,128,196,.18), rgba(120,140,200,.1));
        border: 1px solid rgba(120,112,170,.16);
      }
      .program-cover .cover-star {
        position: absolute; right: 3px; top: 1px; font-size: 8px; color: #b9a6e6;
      }
      .program-body { flex: 1; min-width: 0; }
      .program-title { font-size: 13.5px; font-weight: 600; color: #34325c; letter-spacing: .5px; }
      .program-summary {
        font-size: 11px; color: #7b789c; line-height: 1.7; margin-top: 4px;
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
      }
      .program-meta {
        display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
        font-size: 10.5px; color: #807da1; margin-top: 6px;
      }
      .program-count { color: #5c5890; }
      .ep-program-tag {
        font-size: 10px; color: #5c5890; padding: 2px 8px; border-radius: 9px;
        background: rgba(148,128,196,.14);
      }
      .radio-program-card .ep-fav { flex: 0 0 auto; }

      /* 一期节目详情：hero + 时间线 */
      .program-hero { display: flex; gap: 14px; align-items: flex-start; margin-bottom: 16px; }
      .program-cover.big {
        flex: 0 0 62px; width: 62px; height: 62px; font-size: 29px; border-radius: 19px;
      }
      .program-hero-body { flex: 1; min-width: 0; }
      .program-kicker { font-size: 10px; letter-spacing: 2px; color: #8a86a8; }
      .program-hero-title {
        margin: 5px 0 0; font-size: 19px; letter-spacing: 1px; color: #2f2d52; font-weight: 600;
      }
      .program-hero-summary { margin: 8px 0 10px; font-size: 12px; line-height: 1.8; color: #5c5890; }
      /* 通用信息行：节目详情不在 .radio-detail 里，需要一份独立定义 */
      .detail-meta {
        display: flex; flex-wrap: wrap; gap: 10px; align-items: center;
        font-size: 11px; color: #7b789c;
      }
      .detail-meta .badge { padding: 2px 10px; border-radius: 10px; font-size: 10px; }
      .detail-meta .badge.channel { background: rgba(120,130,190,.14); color: #5c5890; }
      .detail-meta .badge.special { background: rgba(150,124,196,.14); color: #6d4fa0; }
      .program-actions {
        display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 20px;
      }
      .program-seg-label { font-size: 11px; color: #807da1; }
      .radio-btn {
        padding: 7px 15px; border-radius: 11px; font-size: 12px; cursor: pointer;
        border: 1px solid rgba(120,112,170,.24); background: rgba(255,252,247,.9);
        color: #3f3d66; transition: all .2s;
      }
      .radio-btn:hover { background: rgba(247,244,252,.96); border-color: rgba(120,112,170,.42); }
      .radio-btn.primary {
        background: linear-gradient(180deg, #6a6aa8, #564a8c); color: #fff; border-color: transparent;
      }
      .radio-btn.primary:hover { background: linear-gradient(180deg, #7a78b8, #63569c); }
      .radio-btn.danger { color: #a2555f; border-color: rgba(180,90,100,.25); }
      .radio-btn.danger:hover { background: rgba(253,240,241,.9); border-color: rgba(180,90,100,.4); }

      .program-timeline { display: flex; flex-direction: column; }
      .program-seg {
        display: flex; align-items: flex-start; gap: 12px; width: 100%; text-align: left;
        padding: 12px 14px; border-radius: 14px; cursor: pointer; font-family: inherit;
        background: rgba(255,252,247,.82); border: 1px solid rgba(120,112,170,.14);
        color: #3f3d66; transition: all .2s;
      }
      .program-seg:hover { border-color: rgba(120,112,170,.36); background: rgba(255,253,250,.96); }
      .program-seg.is-current {
        border-color: rgba(140,115,200,.45); background: rgba(246,242,252,.96);
        box-shadow: 0 2px 10px rgba(120,112,170,.08);
      }
      .program-seg.is-done { opacity: .76; }
      .program-seg .seg-no {
        flex: 0 0 20px; font-size: 11px; padding-top: 2px;
        color: #8a86a8; font-variant-numeric: tabular-nums;
      }
      .program-seg .seg-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
      .program-seg .seg-en { font-size: 12.5px; line-height: 1.7; color: #34325c; }
      .program-seg .seg-meta { font-size: 10px; color: #8a86a8; }
      .program-seg .seg-zh { font-size: 11px; line-height: 1.6; color: #6f6c93; }
      .program-seg .seg-play {
        flex: 0 0 26px; width: 26px; height: 26px; border-radius: 50%;
        display: flex; align-items: center; justify-content: center; font-size: 10px;
        color: #6a5aa8; background: rgba(148,128,196,.14); border: 1px solid rgba(120,112,170,.2);
      }
      .program-seg.is-current .seg-play {
        background: linear-gradient(180deg, #6a6aa8, #564a8c); color: #fff; border-color: transparent;
      }
      .program-divider {
        text-align: center; font-size: 10px; color: #b6b0cc; letter-spacing: 4px; line-height: 1.5;
      }
      .en-count { margin-left: auto; align-self: center; font-size: 11px; color: #8a86a8; }

      /* 节目列表 */
      .radio-section-title {
        font-size: 13px; letter-spacing: 2px; color: #6f6c93;
        margin-bottom: 12px; display: flex; align-items: center; gap: 8px;
      }
      .radio-section-title .dot { width: 4px; height: 4px; border-radius: 50%; background: #6b6797; }

      .radio-ep-list { display: flex; flex-direction: column; gap: 10px; }
      .radio-ep-card {
        padding: 16px; border-radius: 14px; cursor: pointer;
        background: linear-gradient(135deg, rgba(255,252,247,.92), rgba(253,250,246,.84));
        border: 1px solid rgba(120,112,170,.16);
        transition: all .2s; display: flex; gap: 14px; align-items: flex-start;
      }
      .radio-ep-card:hover {
        border-color: rgba(120,112,170,.34); transform: translateY(-1px);
      }
      .radio-ep-card .ep-icon {
        font-size: 24px; flex-shrink: 0; width: 40px; height: 40px;
        border-radius: 10px; background: rgba(120,110,170,.07);
        display: flex; align-items: center; justify-content: center;
      }
      .radio-ep-card .ep-body { flex: 1; min-width: 0; }
      .radio-ep-card .ep-title {
        font-size: 14px; font-weight: 600; color: #34325c;
        margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .radio-ep-card .ep-meta {
        font-size: 11px; color: #7b789c; display: flex; gap: 10px; flex-wrap: wrap;
      }
      .radio-ep-card .ep-status {
        font-size: 10px; padding: 2px 8px; border-radius: 10px;
        flex-shrink: 0; align-self: center;
      }
      .radio-ep-card .ep-status.pending {
        background: rgba(120,130,190,.14); color: #5c5890;
      }
      .radio-ep-card .ep-status.listening {
        background: rgba(196,150,60,.16); color: #8a6520;
      }
      .radio-ep-card .ep-status.completed {
        background: rgba(80,150,105,.14); color: #3a7550;
      }
      .radio-ep-card .ep-type-special {
        font-size: 10px; color: #6d4fa0; margin-left: 6px;
      }

      .radio-empty {
        text-align: center; padding: 36px 20px; color: #6b6797;
        font-size: 13px; line-height: 2;
      }
      .radio-empty .empty-icon { font-size: 36px; margin-bottom: 10px; opacity: .5; }

      /* 节目详情 */
      .radio-detail { }
      .radio-detail .detail-back {
        font-size: 12px; color: #7b789c; cursor: pointer; margin-bottom: 16px;
        display: inline-flex; align-items: center; gap: 4px;
        border: none; background: none; padding: 0;
      }
      .radio-detail .detail-back:hover { color: #3f3d66; }
      .radio-detail .detail-header {
        display: flex; align-items: center; gap: 12px; margin-bottom: 6px;
      }
      .radio-detail .detail-icon { font-size: 28px; }
      .radio-detail .detail-title {
        font-size: 18px; font-weight: 600; color: #34325c; letter-spacing: 1px;
      }
      .radio-detail .detail-meta {
        font-size: 11px; color: #7b789c; margin-bottom: 20px;
        display: flex; gap: 12px; flex-wrap: wrap; align-items: center;
      }
      .radio-detail .detail-meta .badge {
        padding: 2px 10px; border-radius: 10px; font-size: 10px;
      }
      .radio-detail .detail-meta .badge.channel {
        background: rgba(120,112,170,.16); color: #5c5890;
      }
      .radio-detail .detail-meta .badge.special {
        background: rgba(150,124,196,.13); color: #6d4fa0;
      }
      .radio-detail .detail-content {
        font-size: 14px; line-height: 2; color: #4c4a72;
        white-space: pre-wrap; word-break: break-word;
        padding: 20px; border-radius: 14px;
        background: rgba(255,252,247,.74); border: 1px solid rgba(120,112,170,.12);
        margin-bottom: 20px;
      }
      .radio-detail .detail-actions {
        display: flex; gap: 10px; flex-wrap: wrap;
      }
      .radio-detail .detail-actions .radio-btn {
        padding: 8px 18px; border-radius: 12px; font-size: 13px;
        cursor: pointer; transition: all .2s; border: 1px solid rgba(120,112,170,.24);
        background: rgba(255,252,247,.9); color: #3f3d66;
      }
      .radio-detail .detail-actions .radio-btn:hover {
        background: rgba(247,244,252,.95); border-color: rgba(120,112,170,.34);
      }
      .radio-detail .detail-actions .radio-btn.danger {
        color: #a2555f; border-color: rgba(180,90,100,.2);
      }
      .radio-detail .detail-actions .radio-btn.danger:hover {
        background: rgba(252,236,238,.95); border-color: rgba(180,90,100,.38);
      }
      .radio-detail .detail-actions .radio-btn.primary {
        background: linear-gradient(180deg, #4a6cb8, #3a5494); color: #fff;
        border-color: transparent;
      }
      .radio-detail .detail-actions .radio-btn.primary:hover {
        background: linear-gradient(180deg, #5a7ac8, #4a64a4);
      }
      .radio-detail .detail-actions .radio-btn:disabled {
        opacity: .4; cursor: not-allowed;
      }

      /* 节目生成中 */
      .radio-generating {
        text-align: center; padding: 50px 20px;
      }
      .radio-generating .gen-icon {
        font-size: 40px; margin-bottom: 16px;
        animation: radio-pulse 2s ease-in-out infinite;
      }
      @keyframes radio-pulse {
        0%, 100% { opacity: .5; transform: scale(1); }
        50% { opacity: 1; transform: scale(1.1); }
      }
      .radio-generating .gen-title {
        font-size: 15px; color: #34325c; margin-bottom: 8px;
      }
      .radio-generating .gen-sub {
        font-size: 12px; color: #7b789c; line-height: 1.8;
      }
      .radio-generating .gen-error {
        margin-top: 16px; padding: 14px; border-radius: 12px;
        background: rgba(253,240,241,.9); border: 1px solid rgba(180,90,100,.2);
        font-size: 13px; color: #a2555f; line-height: 1.6;
      }
      .radio-generating .gen-actions {
        margin-top: 20px; display: flex; gap: 10px; justify-content: center;
      }

      .radio-btn-inline {
        padding: 7px 16px; border-radius: 10px; font-size: 12px;
        cursor: pointer; transition: all .2s;
        border: 1px solid rgba(120,112,170,.24); background: rgba(255,252,247,.9);
        color: #3f3d66;
      }
      .radio-btn-inline:hover { background: rgba(247,244,252,.95); }
      .radio-btn-inline.primary {
        background: linear-gradient(180deg, #4a6cb8, #3a5494); color: #fff;
        border-color: transparent;
      }
      .radio-btn-inline:disabled { opacity: .4; cursor: not-allowed; }

      /* 信号波动动画 */
      .radio-signal {
        display: inline-flex; align-items: flex-end; gap: 2px; height: 12px;
      }
      .radio-signal span {
        width: 2px; background: #6b6797; border-radius: 1px;
        animation: radio-wave 1.2s ease-in-out infinite;
      }
      .radio-signal span:nth-child(1) { height: 4px; animation-delay: 0s; }
      .radio-signal span:nth-child(2) { height: 8px; animation-delay: .15s; }
      .radio-signal span:nth-child(3) { height: 12px; animation-delay: .3s; }
      .radio-signal span:nth-child(4) { height: 6px; animation-delay: .45s; }
      @keyframes radio-wave {
        0%, 100% { opacity: .3; }
        50% { opacity: 1; }
      }

      /* 纯文字节目提示（无语音，不显示播放条） */
      .radio-text-note {
        padding: 12px 16px; border-radius: 12px; margin-bottom: 18px;
        background: rgba(255,252,247,.82); border: 1px solid rgba(120,112,170,.14);
        font-size: 11px; color: #7b789c; line-height: 1.8;
        display: flex; align-items: center; gap: 8px;
      }

      /* 音频播放条 */
      .radio-player {
        padding: 14px 16px; border-radius: 14px; margin-bottom: 18px;
        background: linear-gradient(135deg, rgba(255,252,247,.92), rgba(252,249,245,.86));
        border: 1px solid rgba(120,112,170,.22);
      }
      .radio-player .player-head { display: flex; align-items: center; gap: 12px; }
      .radio-player .player-play {
        width: 40px; height: 40px; flex-shrink: 0; border-radius: 50%;
        border: 1px solid rgba(120,112,170,.38); cursor: pointer;
        background: linear-gradient(180deg, #4a6cb8, #3a5494); color: #fff;
        font-size: 15px; line-height: 1; transition: all .2s;
      }
      .radio-player .player-play:hover:not(:disabled) {
        background: linear-gradient(180deg, #5a7ac8, #4a64a4);
      }
      .radio-player .player-play:disabled { opacity: .5; cursor: default; }
      .radio-player .player-info { min-width: 0; flex: 1; }
      .radio-player .player-title {
        font-size: 13px; font-weight: 600; color: #34325c;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .radio-player .player-sub { font-size: 10px; color: #7b789c; margin-top: 3px; }
      .radio-player .player-seek-row {
        display: flex; align-items: center; gap: 8px; margin-top: 12px;
      }
      .radio-player .player-time {
        font-size: 10px; color: #7b789c; min-width: 30px; text-align: center;
        font-variant-numeric: tabular-nums;
      }
      .radio-player .player-seek {
        flex: 1; height: 4px; cursor: pointer; accent-color: #7a96d8;
      }
      .radio-player .player-msg {
        margin-top: 8px; font-size: 11px; color: #a2555f; line-height: 1.5;
      }

      /* 电台级「正在播放」条：切换栏目时音乐/本地声音不中断，控制与进度随之保留 */
      .radio-mini { margin-bottom: 16px; }
      .radio-mini .radio-player { padding: 10px 12px; margin-bottom: 0; }
      .radio-mini .player-play { width: 32px; height: 32px; font-size: 13px; }
      .radio-mini .player-title { font-size: 12px; }
      .radio-mini .player-sub { font-size: 10px; margin-top: 2px; }
      .radio-mini .player-seek-row { margin-top: 8px; }
      .radio-mini .player-time { font-size: 9px; min-width: 26px; }
      .radio-mini .player-msg { margin-top: 6px; font-size: 10px; }
      .radio-mini-stop {
        flex-shrink: 0; width: 26px; height: 26px; border-radius: 50%;
        border: 1px solid rgba(148,128,196,.3); background: rgba(240,235,250,.9);
        color: #6a5f95; font-size: 11px; line-height: 1; cursor: pointer; transition: all .2s;
      }
      .radio-mini-stop:hover { background: rgba(232,225,246,.96); color: #fff; }

      /* 音乐频道 */
      .music-head { margin-bottom: 18px; }
      .music-head .music-title {
        font-size: 18px; font-weight: 600; color: #34325c; letter-spacing: 1px;
      }
      .music-head .music-sub { font-size: 11px; color: #7b789c; margin-top: 6px; line-height: 1.7; }
      .track-list { display: flex; flex-direction: column; gap: 10px; }
      .track-row {
        display: flex; align-items: center; gap: 12px; padding: 14px;
        border-radius: 14px; cursor: pointer;
        background: linear-gradient(135deg, rgba(255,252,247,.92), rgba(253,250,246,.84));
        border: 1px solid rgba(120,112,170,.16); transition: all .2s;
      }
      .track-row:hover { border-color: rgba(120,112,170,.34); transform: translateY(-1px); }
      .track-row .track-mood {
        font-size: 20px; width: 38px; height: 38px; flex-shrink: 0;
        border-radius: 10px; background: rgba(120,110,170,.07);
        display: flex; align-items: center; justify-content: center;
      }
      .track-row .track-body { flex: 1; min-width: 0; }
      .track-row .track-title { font-size: 13px; font-weight: 600; color: #34325c; }
      .track-row .track-artist { font-size: 10px; color: #6f6c93; margin-top: 3px; }
      .track-row .track-desc {
        font-size: 11px; color: #807da1; margin-top: 4px; line-height: 1.5;
      }
      .track-row .track-progress {
        height: 3px; border-radius: 3px; background: rgba(120,112,170,.16);
        margin-top: 8px; overflow: hidden;
      }
      .track-row .track-progress span {
        display: block; height: 100%; background: #7a96d8; border-radius: 3px;
      }
      .track-row .track-fav {
        flex-shrink: 0; border: none; background: none; cursor: pointer;
        font-size: 20px; color: #807da1; padding: 4px 6px; transition: all .2s;
      }
      .track-row .track-fav:hover { color: #6d4fa0; }
      .track-row .track-fav.on { color: #a83a68; }

      /* 声音收藏馆内部 */
      .voice-head { margin-bottom: 18px; }
      .voice-head .voice-title {
        font-size: 18px; font-weight: 600; color: #34325c; letter-spacing: 1px;
      }
      .voice-head .voice-sub { font-size: 11px; color: #7b789c; margin-top: 6px; line-height: 1.7; }
      .voice-toolbar { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 12px; }
      .voice-file-input { display: none; }
      .voice-msg {
        padding: 10px 14px; border-radius: 10px; margin-bottom: 14px;
        font-size: 12px; line-height: 1.6;
        background: rgba(80,150,105,.12); border: 1px solid rgba(80,150,105,.22); color: #3a7550;
      }
      .voice-msg.error {
        background: rgba(253,240,241,.9); border-color: rgba(180,90,100,.25); color: #a2555f;
      }
      .voice-list { display: flex; flex-direction: column; gap: 10px; }
      .voice-row {
        padding: 14px; border-radius: 14px;
        background: linear-gradient(135deg, rgba(255,252,247,.92), rgba(253,250,246,.84));
        border: 1px solid rgba(120,112,170,.16); transition: all .2s;
      }
      .voice-row.is-playing { border-color: rgba(120,112,170,.4); }
      .voice-row-main { display: flex; align-items: center; gap: 12px; }
      .voice-row .voice-icon {
        font-size: 20px; width: 38px; height: 38px; flex-shrink: 0;
        border-radius: 10px; background: rgba(150,124,196,.11);
        display: flex; align-items: center; justify-content: center;
      }
      .voice-row .voice-body { flex: 1; min-width: 0; }
      .voice-row .voice-name {
        font-size: 13px; font-weight: 600; color: #34325c;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .voice-row .voice-meta {
        font-size: 10px; color: #7b789c; margin-top: 4px;
        display: flex; gap: 8px; flex-wrap: wrap;
      }
      .voice-row .voice-actions { display: flex; gap: 6px; flex-shrink: 0; flex-wrap: wrap; justify-content: flex-end; }
      .voice-btn {
        padding: 6px 11px; border-radius: 10px; font-size: 11px;
        cursor: pointer; transition: all .2s;
        border: 1px solid rgba(120,112,170,.24); background: rgba(255,252,247,.9); color: #3f3d66;
      }
      .voice-btn:hover { background: rgba(247,244,252,.95); border-color: rgba(120,112,170,.34); }
      .voice-btn.primary {
        background: linear-gradient(180deg, #5a4a94, #463a78); color: #fff; border-color: transparent;
      }
      .voice-btn.primary:hover { background: linear-gradient(180deg, #6a5aa8, #564a8c); }
      .voice-btn.danger { color: #a2555f; border-color: rgba(180,90,100,.2); }
      .voice-btn.danger:hover { background: rgba(252,236,238,.95); border-color: rgba(180,90,100,.38); }
      .voice-btn:disabled { opacity: .4; cursor: not-allowed; }
      .voice-rename-row { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
      .voice-rename-input {
        flex: 1; min-width: 120px; padding: 6px 10px; border-radius: 9px;
        border: 1px solid rgba(120,112,170,.32); background: rgba(255,253,250,.95);
        color: #34325c; font-size: 12px; font-family: inherit;
      }
      .voice-confirm {
        margin-top: 10px; padding: 10px 12px; border-radius: 10px;
        background: rgba(253,242,243,.88); border: 1px solid rgba(180,90,100,.22);
        font-size: 11px; color: #a2555f; line-height: 1.6;
        display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
      }
      .voice-confirm .voice-confirm-text { flex: 1; min-width: 140px; }
      .voice-empty {
        text-align: center; padding: 40px 20px; color: #7b789c;
        font-size: 13px; line-height: 2;
      }
      .voice-empty .empty-icon { font-size: 38px; margin-bottom: 12px; opacity: .55; }

      .voice-row .voice-btn.music-on {
        background: rgba(132,104,186,.18); border-color: rgba(150,124,196,.4); color: #6a4a9c;
      }

      /* 阅读书架内部 */
      .reading-head { margin-bottom: 16px; }
      .reading-head .reading-title {
        font-size: 18px; font-weight: 600; color: #364268; letter-spacing: 1px;
      }
      .reading-head .reading-sub { font-size: 11px; color: #4b5878; margin-top: 6px; line-height: 1.7; }
      /* 书架分区标题落在浅色页面上，单独加深；不影响首页同名标题 */
      .reading-book-list + .radio-section-title { color: #46537a; }
      .reading-block {
        padding: 14px 16px; border-radius: 14px; margin-bottom: 14px;
        background: rgba(255,252,247,.74); border: 1px solid rgba(120,112,170,.14);
      }
      .reading-block .rb-label {
        font-size: 10px; color: #7b789c; letter-spacing: 1px; margin-bottom: 8px;
      }
      .reading-block .rb-main { font-size: 14px; color: #34325c; font-weight: 600; line-height: 1.6; }
      .reading-block .rb-meta { font-size: 11px; color: #4c4a72; margin-top: 4px; line-height: 1.6; }
      .reading-block.now { background: linear-gradient(135deg, rgba(255,252,247,.88), rgba(252,249,245,.82)); border-color: rgba(120,112,170,.22); }
      .reading-block.empty .rb-main { color: #8b88a8; font-weight: 400; font-size: 12px; }
      .reading-surprise {
        padding: 12px 16px; border-radius: 12px; margin-bottom: 16px;
        background: rgba(243,239,251,.88); border: 1px solid rgba(148,128,196,.24);
        font-size: 12px; color: #4c4a72; line-height: 1.8;
      }
      .reading-surprise .rs-item { margin-top: 4px; }
      .reading-tabs {
        display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px;
      }
      .reading-tab {
        padding: 6px 12px; border-radius: 10px; font-size: 11px; cursor: pointer;
        border: 1px solid rgba(120,112,170,.2); background: rgba(255,252,247,.9); color: #6f6c93;
        transition: all .2s;
      }
      .reading-tab:hover { background: rgba(247,244,252,.95); }
      .reading-tab.on {
        background: linear-gradient(180deg, #4a6cb8, #3a5494); color: #fff; border-color: transparent;
      }
      .reading-book-list { display: flex; flex-direction: column; gap: 8px; }
      .reading-book {
        padding: 12px 14px; border-radius: 12px;
        background: rgba(255,252,247,.88); border: 1px solid rgba(120,112,170,.14);
      }
      .reading-book .rbook-main { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .reading-book .rbook-title { font-size: 13px; color: #34325c; font-weight: 600; }
      .reading-book .rbook-tag {
        font-size: 10px; padding: 2px 7px; border-radius: 9px;
      }
      .rbook-tag.st-unread { background: rgba(120,112,170,.16); color: #4c4a72; }
      .rbook-tag.st-preparing { background: rgba(196,150,60,.16); color: #8a6520; }
      .rbook-tag.st-reading { background: rgba(70,140,175,.16); color: #33647a; }
      .rbook-tag.st-finished { background: rgba(80,150,105,.14); color: #3a7550; }
      .rbook-tag.co { background: rgba(150,124,196,.13); color: #6d4fa0; }
      .reading-book .rbook-edition { font-size: 10px; color: #4c4a72; margin-top: 4px; line-height: 1.5; }
      .reading-book .rbook-actions { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
      .rbook-btn {
        padding: 5px 10px; border-radius: 9px; font-size: 11px; cursor: pointer;
        border: 1px solid rgba(120,112,170,.24); background: rgba(255,252,247,.9); color: #4c4a72;
        transition: all .2s;
      }
      .rbook-btn:hover { background: rgba(247,244,252,.98); border-color: rgba(120,112,170,.38); }
      .rbook-btn.primary {
        background: linear-gradient(180deg, #4a6cb8, #3a5494); color: #fff; border-color: transparent;
      }
      .rbook-btn.co-on { background: rgba(132,104,186,.18); border-color: rgba(150,124,196,.4); color: #6a4a9c; }
      .rbook-btn:disabled { opacity: .4; cursor: not-allowed; }
      .reading-thought-form { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
      .reading-thought-input {
        width: 100%; min-height: 60px; padding: 8px 10px; border-radius: 9px; resize: vertical;
        border: 1px solid rgba(120,112,170,.32); background: rgba(255,253,250,.95);
        color: #34325c; font-size: 12px; font-family: inherit; line-height: 1.6;
      }
      .reading-thought-actions { display: flex; gap: 6px; }
      .reading-msg {
        padding: 9px 13px; border-radius: 10px; margin-bottom: 12px;
        font-size: 12px; background: rgba(80,150,105,.12);
        border: 1px solid rgba(80,150,105,.22); color: #1f6b3f;
      }
      .reading-msg.error {
        background: rgba(253,240,241,.9); border-color: rgba(180,90,100,.25); color: #8d3f4d;
      }
      .reading-thought-item {
        padding: 10px 14px; border-radius: 10px; margin-bottom: 8px;
        background: rgba(255,252,247,.84); border: 1px solid rgba(120,112,170,.12);
      }
      .reading-thought-item .rt-book { font-size: 11px; color: #33647a; }
      .reading-thought-item .rt-text {
        font-size: 12px; color: #4c4a72; line-height: 1.7; margin-top: 4px; white-space: pre-wrap;
      }
      .reading-thought-item .rt-time { font-size: 10px; color: #4c4a72; margin-top: 4px; }

      /* 睡眠定时条（电台级公共控件） */
      .sleep-bar {
        display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
        padding: 11px 14px; border-radius: 12px; margin-bottom: 18px;
        background: rgba(253,250,246,.88); border: 1px solid rgba(120,112,170,.18);
      }
      .sleep-bar .sleep-icon { font-size: 17px; flex-shrink: 0; }
      .sleep-bar .sleep-label { font-size: 11px; color: #6f6c93; letter-spacing: 1px; white-space: nowrap; }
      .sleep-bar .sleep-countdown {
        font-size: 13px; color: #34325c; font-variant-numeric: tabular-nums;
        font-weight: 600; min-width: 44px;
      }
      .sleep-bar .sleep-countdown.on { color: #4f6aa8; }
      .sleep-bar .sleep-opts { display: flex; gap: 5px; margin-left: auto; flex-wrap: wrap; }
      .sleep-bar .sleep-opt {
        padding: 5px 9px; border-radius: 9px; font-size: 11px; cursor: pointer;
        border: 1px solid rgba(120,112,170,.24); background: rgba(255,252,247,.9); color: #4c4a72;
        transition: all .2s;
      }
      .sleep-bar .sleep-opt:hover { background: rgba(247,244,252,.98); }
      .sleep-bar .sleep-opt.on {
        background: linear-gradient(180deg, #4a6cb8, #3a5494); color: #fff; border-color: transparent;
      }
      .sleep-bar .sleep-cancel {
        padding: 5px 10px; border-radius: 9px; font-size: 11px; cursor: pointer;
        border: 1px solid rgba(180,90,100,.25); background: rgba(253,241,242,.9); color: #a2555f;
      }
      .sleep-bar .sleep-cancel:hover { background: rgba(251,234,237,.95); }

      /* 音乐频道的随机穿插开关 */
      .music-random {
        display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px;
        border-radius: 10px; font-size: 12px; cursor: pointer; transition: all .2s;
        border: 1px solid rgba(148,128,196,.32); background: rgba(248,244,252,.92); color: #6a5f95;
      }
      .music-random:hover { border-color: rgba(150,120,200,.45); }
      .music-random.on {
        background: linear-gradient(180deg, #6a5aa8, #564a8c); color: #fff; border-color: transparent;
      }
      .music-tip {
        font-size: 10px; color: #807da1; line-height: 1.6; margin-top: 8px;
      }

      /* ---- 节目库筛选 / 双区分组 / 特别喜欢 ---- */
      .radio-filter {
        display: flex; flex-wrap: wrap; gap: 6px; margin: 14px 0 4px;
      }
      .radio-filter-btn {
        font: inherit; font-size: 11px; line-height: 1.4;
        padding: 5px 10px; border-radius: 999px; cursor: pointer;
        border: 1px solid rgba(120,112,170,.36);
        background: rgba(255,255,255,.6);
        color: #6a6a92; transition: all .18s ease;
      }
      .radio-filter-btn:hover { border-color: rgba(140,110,200,.45); }
      .radio-filter-btn.active {
        background: linear-gradient(180deg, #6a5aa8, #564a8c);
        color: #fff; border-color: transparent;
      }
      .radio-section-title.done { margin-top: 22px; opacity: .9; }
      .radio-ep-list.done .radio-ep-card { opacity: .82; }
      .radio-empty.small {
        padding: 18px 16px; font-size: 12px; line-height: 1.8;
      }
      .ep-fav {
        flex: 0 0 auto; width: 28px; height: 28px; margin-left: 6px;
        border-radius: 50%; cursor: pointer; font-size: 14px; line-height: 1;
        border: 1px solid rgba(148,120,190,.4);
        background: rgba(255,255,255,.7); color: #8a6aa8;
        transition: transform .18s ease, color .18s ease;
      }
      .ep-fav:hover { transform: scale(1.08); }
      .ep-fav.on { color: #a83a68; border-color: rgba(200,80,135,.35); background: rgba(255,235,245,.9); }
      .ep-source {
        display: inline-block; padding: 1px 7px; border-radius: 999px;
        font-size: 10px; letter-spacing: .3px;
        background: rgba(120,112,170,.18); color: #5a6a9e;
        border: 1px solid rgba(120,112,170,.3);
      }
      .ep-source.original { background: rgba(148,120,196,.16); color: #5a4a94; border-color: rgba(148,120,196,.3); }
      .ep-voice-pending { font-size: 10px; color: #8a6136; }
      .ep-heard { font-size: 10px; color: #3a7550; }

      /* ---- 英文广播：聊天候选 ---- */
      .en-cand-list { display: flex; flex-direction: column; gap: 8px; margin: 8px 0 4px; }
      .en-cand {
        padding: 10px 12px; border-radius: 12px; cursor: pointer;
        border: 1px solid rgba(120,112,170,.3);
        background: rgba(255,255,255,.62);
        transition: border-color .18s ease, transform .18s ease;
      }
      .en-cand:hover { border-color: rgba(140,115,200,.42); transform: translateY(-1px); }
      .en-cand-text { font-size: 12px; line-height: 1.6; color: #4d4a6c; }
      .en-cand-meta { margin-top: 4px; font-size: 10px; color: #6f6c93; }
      .en-cand-note { margin: 2px 0 8px; font-size: 10.5px; line-height: 1.6; color: #6f6c93; }

      /* ---- 晚安哄睡 ---- */
      .sleep-list { display: flex; flex-direction: column; gap: 8px; margin: 8px 0 4px; }
      .sleep-row {
        display: flex; align-items: center; gap: 10px;
        padding: 10px 12px; border-radius: 12px;
        border: 1px solid rgba(120,112,170,.28);
        background: rgba(255,255,255,.62);
      }
      .sleep-row.is-playing { border-color: rgba(140,115,200,.45); background: rgba(245,240,255,.85); }
      .sleep-idx {
        flex: 0 0 20px; font-size: 11px; color: #6f6c93; text-align: center;
      }
      .sleep-body { flex: 1 1 auto; min-width: 0; }
      .sleep-name {
        font-size: 13px; color: #443c60;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .sleep-meta { margin-top: 2px; font-size: 10px; color: #6f6c93; }
      .sleep-dates { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 4px; }

      @media (max-width: 480px) {
        .radio-scene { padding: 18px 14px 26px; }
        .radio-programs, .radio-atmosphere, .radio-shelf { grid-template-columns: 1fr; }
        .radio-ch-card.lead { flex-wrap: wrap; row-gap: 8px; }
        .radio-ch-card.lead .ch-prepare { white-space: normal; }
        .radio-detail .detail-content { padding: 16px; font-size: 13px; }
        .voice-row-main { flex-wrap: wrap; }
        .voice-row .voice-actions { width: 100%; justify-content: flex-start; }
        .sleep-bar .sleep-opts { margin-left: 0; width: 100%; }
        .sleep-bar .sleep-countdown { font-size: 12px; }
      }
    `;
    document.head.appendChild(s);
  },

  render() {
    if (!this.container) return;
    if (this.view === 'detail') {
      this.renderDetail();
    } else if (this.view === 'generating') {
      this.renderGenerating();
    } else if (this.view === 'music') {
      this.renderMusic();
    } else if (this.view === 'voice') {
      this.renderVoice();
    } else if (this.view === 'reading') {
      this.renderReading();
    } else if (this.view === 'english') {
      this.renderEnglish();
    } else if (this.view === 'sleep') {
      this.renderSleep();
    } else {
      this.renderList();
    }
    // 睡眠定时是电台级公共控件：注入到当前视图顶部并绑定，切视图不影响计时
    this._mountSleepBar();
    // 电台级「正在播放」条：跨栏目保留音乐/本地声音的控制与进度
    this._mountMiniPlayer();
    this._startSleepTicker();
  },

  // ---------- 音频播放控制 ----------

  _resetAudio() {
    // 英文节目的原声走 radioVoiceAudio（和收藏馆同一个独立播放器）：
    // 切走节目时必须一起停掉，否则声音会留在后台；同时清空连播队列。
    const key = this._audioKey || '';
    const englishEpisode = key.startsWith('ep:') && (() => {
      const ep = radioStore.getEpisode(key.slice(3));
      return !!(ep && ep.channel === 'english');
    })();
    if (key.startsWith('voice:') || englishEpisode) {
      radioVoiceAudio.stop();
      this._voicePlayingId = null;
      this._voicePlayState = 'idle';
    }
    this._enProgram = null;
    radioAudio.stop();
    this._audioKey = null;
    this._audioStatus = 'idle';
    this._audioError = null;
    this._lastCur = 0;
    this._lastDur = 0;
    this._lastPct = 0;
    this._lastSaveAt = 0;
    this._pendingSeekPct = null;
  },

  // 停止声音收藏馆的独立试听并复位其状态（不影响 TTS/音乐播放器）
  _resetVoiceAudio() {
    radioVoiceAudio.stop();
    this._voicePlayingId = null;
    this._voicePlayState = 'idle';
  },

  _resetVoiceAudioState() {
    this._voicePlayingId = null;
    this._voicePlayState = 'idle';
  },

  // 栏目切换时只停节目语音，音乐与本地声音继续（它们属于整个电台）
  _stopAudioIfEpisode() {
    if (this._audioKey && this._audioKey.startsWith('ep:')) this._resetAudio();
  },

  // 同一时刻只让一路「电台声音」出声：换曲目/换声音/播节目之前先停另一个引擎。
  // 未来若要让背景音乐与节目语音并行，只需放宽这里（按 role 判断），会话与 UI 无需改动。
  _exclusiveEngine(engine) {
    if (engine === radioAudio) {
      if (radioVoiceAudio.currentId || radioVoiceAudio.playing) radioVoiceAudio.stop();
    } else if (radioAudio.currentKey || radioAudio.playing) {
      radioAudio.stop();
    }
  },

  // 手动停止电台声音（音乐 + 本地声音），不影响房间白噪音
  _stopRadioAudio() {
    this._resetAudio();
    this._resetVoiceAudio();
    this._mountMiniPlayer();
    if (this.view === 'voice') this.renderVoice();
    else this._updatePlayerUI();
  },

  // ---------- 电台级「正在播放」条（跨栏目） ----------

  // 音乐频道与语音节目详情有自带播放条，其余视图才需要公共条，避免出现两个播放器
  _miniPlayerVisible() {
    if (!this._audioKey) return false;
    if (this.view === 'music' || this.view === 'detail') return false;
    return true;
  },

  // 会话 key → 展示用标题/来源（只读本地数据，不发请求）
  _currentAudioMeta() {
    const key = this._audioKey || '';
    if (key.startsWith('voice:')) {
      const id = key.slice(6);
      const item = (this._voiceItems || []).find(x => x.id === id);
      return { title: item ? item.name : '本地声音', sub: '小星的声音 · 来自收藏馆' };
    }
    if (key.startsWith('track:')) {
      const t = radioMusic.getById(key.slice(6));
      return t ? { title: t.title, sub: t.artist + ' · 音乐频道' } : { title: '音乐', sub: '音乐频道' };
    }
    if (key.startsWith('ep:')) {
      const ep = radioStore.getEpisode(key.slice(3));
      if (!ep) return { title: '节目语音', sub: '午夜电台' };
      const q = this._enProgram;
      if (ep.program && q && q.episodeId === ep.id) {
        const total = q.segments.length;
        return { title: ep.title, sub: `英文广播 · 第 ${Math.min(q.index + 1, total)} / ${total} 段` };
      }
      return { title: ep.title, sub: getChannelName(ep.channel) + ' · 语音收听' };
    }
    return { title: '', sub: '' };
  },

  // 会话切换后同步播放条标题/来源（视图内切歌、收藏馆试听时无需整页重绘）
  _refreshBarMeta() {
    if (!this._audioKey) return;
    const bars = this.container?.querySelectorAll('.radio-player');
    if (!bars || !bars.length) return;
    const meta = this._currentAudioMeta();
    bars.forEach(bar => {
      bar.dataset.key = this._audioKey;
      const t = bar.querySelector('.player-title');
      const s = bar.querySelector('.player-sub');
      if (t) t.textContent = meta.title;
      if (s) s.textContent = meta.sub;
    });
  },

  // 注入/更新/移除公共播放条（各视图 innerHTML 重绘后需重新挂载）
  _mountMiniPlayer() {
    const scene = this.container?.querySelector('.radio-scene');
    if (!scene) return;
    const old = scene.querySelector('#radio-mini');
    if (old) old.remove();
    if (!this._miniPlayerVisible()) return;
    const meta = this._currentAudioMeta();
    const html = '<div class="radio-mini" id="radio-mini">'
      + this._renderPlayerBar(this._audioKey, meta.title, meta.sub, { mini: true })
      + '</div>';
    const sleep = scene.querySelector('#sleep-bar');
    if (sleep) sleep.insertAdjacentHTML('afterend', html);
    else scene.insertAdjacentHTML('afterbegin', html);
    this._on('#radio-mini-play', 'click', () => this._togglePlay());
    const seek = scene.querySelector('#radio-mini .player-seek');
    if (seek) this._on(seek, 'change', e => this._onSeek(e));
    this._on('#radio-mini-stop', 'click', () => this._stopRadioAudio());
    this._syncPlayerUIFromEngine();
  },

  // ---------- 全局睡眠定时 ----------

  // 睡眠条 HTML：所有视图共用，插到 .radio-scene 顶部
  _sleepBarHTML() {
    const timer = radioStore.getSleepTimer();
    const remain = timer ? Math.max(0, timer.endAt - Date.now()) : 0;
    const active = !!timer && remain > 0;
    const countdown = active ? fmtClock(Math.ceil(remain / 1000)) : '未设置';
    const opts = SLEEP_OPTIONS.map(m =>
      `<button class="sleep-opt ${active && timer.minutes === m ? 'on' : ''}" data-sleep="${m}">${m} 分钟</button>`
    ).join('');
    return `
      <div class="sleep-bar" id="sleep-bar">
        <span class="sleep-icon">😴</span>
        <span class="sleep-label">睡眠定时</span>
        <span class="sleep-countdown ${active ? 'on' : ''}" id="sleep-countdown">${countdown}</span>
        <span class="sleep-opts" id="sleep-opts">
          ${opts}
          <button class="sleep-cancel" id="sleep-cancel" style="display:${active ? 'inline-block' : 'none'}">取消</button>
        </span>
      </div>
    `;
  },

  // 把睡眠条 prepend 到当前视图，并绑定事件（render 后统一调用）
  _mountSleepBar() {
    const scene = this.container?.querySelector('.radio-scene');
    if (!scene) return;
    const bar = scene.querySelector('#sleep-bar');
    if (bar) {
      bar.outerHTML = this._sleepBarHTML();
    } else {
      scene.insertAdjacentHTML('afterbegin', this._sleepBarHTML());
    }
    SLEEP_OPTIONS.forEach(m => {
      this._on(`[data-sleep="${m}"]`, 'click', () => this.setSleepTimer(m));
    });
    this._on('#sleep-cancel', 'click', () => this.cancelSleepTimer());
  },

  setSleepTimer(minutes) {
    if (!SLEEP_OPTIONS.includes(minutes)) return;
    const endAt = Date.now() + minutes * 60 * 1000;
    radioStore.setSleepTimer(minutes, endAt);
    this._sleepFired = false;
    this._refreshSleepBar();
  },

  cancelSleepTimer() {
    radioStore.clearSleepTimer();
    this._sleepFired = false;
    this._refreshSleepBar();
  },

  // 只更新睡眠条的显示，不重绘整个视图（避免打断播放/输入状态）
  _refreshSleepBar() {
    const timer = radioStore.getSleepTimer();
    const remain = timer ? Math.max(0, timer.endAt - Date.now()) : 0;
    const active = !!timer && remain > 0;
    const cd = this.container?.querySelector('#sleep-countdown');
    if (cd) {
      cd.textContent = active ? fmtClock(Math.ceil(remain / 1000)) : '未设置';
      cd.classList.toggle('on', active);
    }
    const optsWrap = this.container?.querySelector('#sleep-opts');
    if (optsWrap) {
      optsWrap.querySelectorAll('[data-sleep]').forEach(btn => {
        btn.classList.toggle('on', active && timer && Number(btn.dataset.sleep) === timer.minutes);
      });
      const cancel = optsWrap.querySelector('#sleep-cancel');
      if (cancel) cancel.style.display = active ? 'inline-block' : 'none';
    }
  },

  // 启动模块级 ticker（页面生命周期内只启动一次，跨视图/跨场景持续运行）
  _startSleepTicker() {
    if (_sleepTicker) return;
    _sleepTicker = setInterval(() => this._sleepTick(), 1000);
  },

  _sleepTick() {
    const timer = radioStore.getSleepTimer();
    if (!timer) {
      if (this._sleepFired) this._sleepFired = false;
      this._refreshSleepBar();
      return;
    }
    const remain = timer.endAt - Date.now();
    if (remain <= 0) {
      if (this._sleepFired) return;
      this._sleepFired = true;
      this.onSleepTimeout();
      return;
    }
    this._refreshSleepBar();
  },

  // 定时结束：停止电台内所有播放器，不动任何数据与房间白噪音
  onSleepTimeout() {
    radioStore.clearSleepTimer();
    // 停止节目语音 + 音乐曲目（radioAudio 单例）
    this._resetAudio();
    // 停止声音收藏馆的本地录音试听（独立实例）
    this._resetVoiceAudio();
    // 跨栏目播放条随会话一起消失；收藏馆内行状态同步复位
    this._mountMiniPlayer();
    this._updatePlayerUI();
    if (this.view === 'voice') this.renderVoice();
    // 关闭随机穿插，避免到点后任何残留链路再次续播
    this._shuffleOn = false;
    this._shuffleLastClipId = null;
    this._sleepFired = true;
    this._refreshSleepBar();
    // 若当前正停在音乐频道，同步随机按钮外观
    const rnd = this.container?.querySelector('#music-random');
    if (rnd) {
      rnd.classList.remove('on');
      rnd.textContent = '🎲 随机穿插';
    }
  },

  _renderPlayerBar(key, title, sub, opts = {}) {
    const mini = !!opts.mini;
    const same = this._audioKey === key;
    const status = same ? this._audioStatus : 'idle';
    const loading = status === 'loading';
    const label = loading ? '⏳' : status === 'playing' ? '⏸' : '▶';
    const msg = same && this._audioError ? this._audioError : '';
    const playId = mini ? 'radio-mini-play' : 'radio-player-play';
    return `
      <div class="radio-player" data-key="${escapeHTML(key)}">
        <div class="player-head">
          <button class="player-play" id="${playId}" ${loading ? 'disabled' : ''}>${label}</button>
          <div class="player-info">
            <div class="player-title">${escapeHTML(title)}</div>
            <div class="player-sub">${escapeHTML(sub)}</div>
          </div>
          ${mini ? '<button class="radio-mini-stop" id="radio-mini-stop" title="停止播放">✕</button>' : ''}
        </div>
        <div class="player-seek-row">
          <span class="player-time cur">0:00</span>
          <input type="range" class="player-seek" min="0" max="100" value="0" aria-label="播放进度">
          <span class="player-time dur">0:00</span>
        </div>
        <div class="player-msg" style="display:${msg ? 'block' : 'none'}">${escapeHTML(msg)}</div>
      </div>
    `;
  },

  _bindPlayerBar() {
    this._on('#radio-player-play', 'click', () => this._togglePlay());
    const seek = this.container?.querySelector('.player-seek');
    if (seek) this._on(seek, 'change', e => this._onSeek(e));
  },

  _updatePlayerUI() {
    // 视图内播放条与跨栏目播放条结构一致，统一刷新（同一时刻通常只有一个）
    const bars = this.container?.querySelectorAll('.radio-player');
    if (!bars || !bars.length) return;
    bars.forEach(bar => this._paintPlayerBar(bar));
  },

  _paintPlayerBar(bar) {
    if (!bar) return;
    const btn = bar.querySelector('.player-play');
    const msg = bar.querySelector('.player-msg');
    const seek = bar.querySelector('.player-seek');
    const cur = bar.querySelector('.player-time.cur');
    const dur = bar.querySelector('.player-time.dur');
    if (btn) {
      if (this._audioStatus === 'loading') {
        btn.textContent = '⏳';
        btn.disabled = true;
      } else {
        btn.disabled = false;
        btn.textContent = this._audioStatus === 'playing' ? '⏸' : '▶';
      }
    }
    if (msg) {
      const text = this._audioError || (this._audioStatus === 'loading' ? '正在准备音频，请稍候…' : '');
      msg.textContent = text;
      msg.style.display = text ? 'block' : 'none';
    }
    if (seek) seek.value = String(this._lastPct || 0);
    if (cur) cur.textContent = fmtClock(this._lastCur || 0);
    if (dur) dur.textContent = fmtClock(this._lastDur || 0);
  },

  // 依据 key 选择实际引擎：voice: 与英文节目原声都走收藏馆独立播放器，其余走 TTS/音乐引擎
  _engineFor(key) {
    if (!key) return radioAudio;
    if (key.startsWith('voice:')) return radioVoiceAudio;
    if (key.startsWith('ep:')) {
      const ep = radioStore.getEpisode(key.slice(3));
      if (ep && ep.channel === 'english') return radioVoiceAudio;
    }
    return radioAudio;
  },

  _engineKey(key) {
    return key && key.startsWith('voice:') ? key.slice(6) : key;
  },

  _syncPlayerUIFromEngine() {
    const eng = this._engineFor(this._audioKey);
    this._lastCur = eng.currentTime || 0;
    this._lastDur = eng.duration || 0;
    this._lastPct = this._lastDur > 0 ? Math.round(this._lastCur / this._lastDur * 100) : 0;
    this._updatePlayerUI();
  },

  _onSeek(e) {
    const pct = Number(e.target.value);
    const bar = this.container?.querySelector('.radio-player');
    const key = this._audioKey || bar?.dataset.key;
    if (!key) return;
    const eng = this._engineFor(key);
    const engKey = this._engineKey(key);
    const dur = eng.duration || this._lastDur;
    const current = eng === radioVoiceAudio ? eng.currentId : eng.currentKey;
    // 还没有开始播放时，拖动进度条视为从这里开始播放
    if (!current || current !== engKey) {
      this._pendingSeekPct = pct;
      this._startByKey(key);
      return;
    }
    if (dur > 0) eng.seek(pct / 100 * dur);
  },

  _togglePlay() {
    const bar = this.container?.querySelector('.radio-player');
    const key = this._audioKey || bar?.dataset.key;
    if (!key) return;
    const eng = this._engineFor(key);
    if (this._audioKey === key && this._audioStatus === 'playing') {
      eng.pause();
      return;
    }
    if (this._audioKey === key && this._audioStatus === 'paused') {
      eng.resume().catch(() => {});
      return;
    }
    this._startByKey(key);
  },

  _startByKey(key) {
    if (key.startsWith('ep:')) this.playEpisode(key.slice(3));
    else if (key.startsWith('track:')) this.playTrack(key.slice(6));
    else if (key.startsWith('voice:')) this.playVoiceClip(key.slice(6));
  },

  _audioHandlers(key) {
    return {
      onTimeUpdate: (pos, dur) => {
        this._lastCur = pos;
        this._lastDur = dur;
        this._lastPct = dur > 0 ? Math.min(100, Math.round(pos / dur * 100)) : 0;
        this._updatePlayerUI();
        const now = Date.now();
        if (now - this._lastSaveAt > 3000) {
          this._lastSaveAt = now;
          this._persistAudioProgress(key, pos, dur);
        }
      },
      onEnded: dur => this._onAudioEnded(key, dur),
      onError: () => {
        if (this._audioKey !== key) return;
        this._audioStatus = 'error';
        this._audioError = '音频播放失败，请点播放按钮重试。';
        this._updatePlayerUI();
      },
      onStateChange: state => {
        if (this._audioKey !== key) return;
        this._audioStatus = state === 'playing' ? 'playing' : 'paused';
        this._audioError = null;
        // 收藏馆试听走同一会话，行内按钮状态跟随会话
        if (key.startsWith('voice:')) {
          this._voicePlayingId = this._engineKey(key);
          this._voicePlayState = this._audioStatus;
          if (this.view === 'voice') this._updateVoiceRowUI(this._engineKey(key));
        }
        // 若播放前拖动过进度条，在开始播放后跳到该位置
        if (state === 'playing' && this._pendingSeekPct != null) {
          const pct = this._pendingSeekPct;
          this._pendingSeekPct = null;
          const eng = this._engineFor(key);
          const d = eng.duration || this._lastDur;
          if (d > 0) {
            eng.seek(pct / 100 * d);
            this._lastCur = pct / 100 * d;
            this._lastPct = pct;
            this._persistAudioProgress(key, this._lastCur, d);
            this._updatePlayerUI();
          }
        }
        if (this._enProgram && key === 'ep:' + this._enProgram.episodeId) this._updateProgramUI();
        this._updatePlayerUI();
      },
    };
  },

  _persistAudioProgress(key, pos, dur) {
    if (key.startsWith('ep:')) {
      radioStore.savePlaybackPosition(key.slice(3), pos, dur);
    } else if (key.startsWith('track:')) {
      const id = key.slice(6);
      radioStore.saveMusicMeta(radioMusic.setProgress(radioStore.getMusicMeta(), id, pos, dur));
    }
    // voice: 本地录音不写曲目/节目进度，避免污染收藏与阅读状态
  },

  _onAudioEnded(key, dur) {
    // 英文多段节目：一段播完不结束整期，自动接下一段；最后一段播完才标记已完成。
    const q = this._enProgram;
    if (q && key === 'ep:' + q.episodeId) {
      q.index += 1;
      if (q.index < q.segments.length) {
        this._playProgramSegment();
        return;
      }
      const id = q.episodeId;
      this._enProgram = null;
      const ep = radioStore.getEpisode(id);
      if (ep) {
        radioStore.setEpisodeStatus(id, 'completed');
        radioStore.markHeard(id);          // 整期真的听完才记「语音已听过」
      }
      this._audioKey = 'ep:' + id;
      this._audioStatus = 'idle';
      this._lastCur = 0;
      this._lastDur = 0;
      this._lastPct = 100;
      this._updatePlayerUI();
      this._refreshBarMeta();
      if (this.view === 'detail' && this.currentEpisodeId === id) this.renderDetail();
      return;
    }

    this._persistAudioProgress(key, dur, dur);
    this._lastCur = dur;
    this._lastDur = dur;
    this._lastPct = 100;
    if (key.startsWith('ep:')) {
      const id = key.slice(3);
      radioStore.savePlaybackPosition(id, dur, dur);
      const ep = radioStore.getEpisode(id);
      if (ep) {
        radioStore.setEpisodeStatus(id, 'completed');
        // 语音真的听完了才记；只读文字不算
        if (ep.channel === 'english') radioStore.markHeard(id);
      }
      if (this.view === 'detail' && this.currentEpisodeId === id) {
        this._audioStatus = 'idle';
        this.renderDetail();
        return;
      }
    }
    this._audioStatus = 'idle';
    this._updatePlayerUI();
    // 收藏馆试听也走同一会话：播完后刷新行内按钮状态
    if (this.view === 'voice' && key.startsWith('voice:')) this.renderVoice();
    // 晚安哄睡：本地音频自然播完后接下一首（队列只在哄睡视图里生效）
    if (key.startsWith('voice:') && this.view === 'sleep' && this._sleepQueue.length) {
      const cur = key.slice(6);
      const next = this._sleepIndex + 1;
      if (cur === this._sleepQueue[this._sleepIndex] && next < this._sleepQueue.length) {
        this.playSleepAt(this._sleepDate, next);
        return;
      }
      this._sleepQueue = [];
      this._sleepIndex = -1;
      this.renderSleep();
      return;
    }
    // 音乐频道的随机穿插：曲目/本地录音自然播完后，按概率续播
    if (this.view === 'music' && this._shuffleOn) this._shuffleAdvance();
  },

  async playEpisode(id) {
    const ep = radioStore.getEpisode(id);
    if (!ep) return;
    // 英文节目走「缓存优先、必要时才生成一次」的路径
    if (ep.channel === 'english') return this.playEnglishEpisode(id);
    // 纯文字节目永不请求 ElevenLabs；语音能力仅对英文节目开放
    if (!isVoiceEpisode(ep)) return;
    const key = 'ep:' + id;
    const prog = radioStore.getProgress(id);
    const startAt = (prog && !prog.completed && prog.position > 0 && prog.duration > 0 && prog.position < prog.duration - 2)
      ? prog.position : 0;

    this._exclusiveEngine(radioAudio);
    this._audioKey = key;
    this._audioStatus = 'loading';
    this._audioError = null;
    this._lastCur = startAt;
    this._lastDur = prog && prog.duration ? prog.duration : 0;
    this._lastPct = 0;
    this._updatePlayerUI();
    this._refreshBarMeta();

    if (ep.status === 'pending') radioStore.setEpisodeStatus(id, 'listening');

    try {
      await radioAudio.playSpeech({
        key,
        text: ep.content,
        startAt,
        ...this._audioHandlers(key),
      });
    } catch (err) {
      if (this._audioKey !== key) return;
      this._audioStatus = 'error';
      this._audioError = (err && err.message) ? err.message : '音频播放失败，请重试';
      this._updatePlayerUI();
    }
  },

  async playTrack(id) {
    const track = radioMusic.getById(id);
    if (!track) return;
    const key = 'track:' + id;
    const prog = radioMusic.getProgress(radioStore.getMusicMeta(), id);
    const startAt = (prog && prog.duration > 0 && prog.lastPosition > 0 && prog.lastPosition < prog.duration - 2)
      ? prog.lastPosition : 0;

    this._exclusiveEngine(radioAudio);
    this._audioKey = key;
    this._audioStatus = 'loading';
    this._audioError = null;
    this._lastCur = startAt;
    this._lastDur = prog && prog.duration ? prog.duration : 0;
    this._lastPct = 0;
    this._updatePlayerUI();
    this._refreshBarMeta();

    try {
      await radioAudio.playMusic({
        key,
        src: track.src,
        startAt,
        ...this._audioHandlers(key),
      });
    } catch (err) {
      if (this._audioKey !== key) return;
      this._audioStatus = 'error';
      this._audioError = (err && err.message) ? err.message : '曲目播放失败，请重试';
      this._updatePlayerUI();
    }
  },

  // ---------- 音乐频道 · 本地声音随机穿插 ----------

  // 播放声音收藏馆中已加入音乐频道的素材（走独立播放器，复用统一播放条）
  async playVoiceClip(id) {
    const meta = await radioVoice.get(id);
    if (!meta) return;
    const blob = await radioVoice.getBlob(id);
    if (!blob) {
      this._audioError = '这段声音可能已被删除，请到收藏馆刷新。';
      this._updatePlayerUI();
      return;
    }
    const key = 'voice:' + id;
    this._exclusiveEngine(radioVoiceAudio);
    this._audioKey = key;
    this._audioStatus = 'loading';
    this._audioError = null;
    this._lastCur = 0;
    radioSleep.markPlayed(id);   // 按实际播放记录，纯本地
    this._lastDur = meta.duration || 0;
    this._lastPct = 0;
    this._updatePlayerUI();
    this._refreshBarMeta();
    try {
      await radioVoiceAudio.play({
        id,
        blob,
        ...this._audioHandlers(key),
      });
    } catch (err) {
      if (this._audioKey !== key) return;
      this._audioStatus = 'error';
      this._audioError = (err && err.message) ? err.message : '声音播放失败，请重试';
      this._updatePlayerUI();
    }
  },

  // 随机抽取一条已加入音乐频道的素材，尽量避开上一条
  async _pickShuffleClip() {
    const clips = await radioVoice.listInMusic();
    if (!clips.length) return null;
    let pool = clips;
    if (clips.length > 1) {
      const others = clips.filter(c => c.id !== this._shuffleLastClipId);
      if (others.length) pool = others;
    }
    const chosen = pool[Math.floor(Math.random() * pool.length)];
    this._shuffleLastClipId = chosen.id;
    return chosen;
  },

  // 随机选一首内置曲目
  _pickShuffleTrack() {
    const tracks = radioMusic.getAll();
    if (!tracks.length) return null;
    return tracks[Math.floor(Math.random() * tracks.length)];
  },

  // 随机穿插是否仍在有效上下文（await 之后复核，避免离开频道/定时到点后误播）
  _shuffleStillValid(token) {
    return this._shuffleOn && this.view === 'music' && this._audioKey === token;
  },

  // 随机模式下，一个条目自然播完后穿插下一条：概率混入本地声音，否则继续放曲目
  async _shuffleAdvance() {
    if (!this._shuffleOn || this.view !== 'music') return;
    const token = this._audioKey;
    let chosen = null;

    // 约 45% 概率尝试插入本地声音；没有已加入素材时退化为随机曲目
    if (Math.random() < 0.45) {
      chosen = await this._pickShuffleClip();
    }
    if (!chosen) chosen = this._pickShuffleTrack();
    if (!chosen) return;
    // IndexedDB 读取是异步的，回到这里必须确认上下文没有变化
    if (!this._shuffleStillValid(token)) return;
    if (chosen.src) this.playTrack(chosen.id);
    else this.playVoiceClip(chosen.id);
  },

  // 手动点「随机点播」：立刻抽取一条播放（本地声音或曲目），同样避开连续素材
  async shuffleNow() {
    if (this.view !== 'music') return;
    let chosen = null;
    if (Math.random() < 0.55) chosen = await this._pickShuffleClip();
    if (!chosen) chosen = this._pickShuffleTrack();
    if (!chosen) return;
    if (this.view !== 'music') return;
    if (chosen.src) this.playTrack(chosen.id);
    else this.playVoiceClip(chosen.id);
  },

  backToList() {
    // 只停节目语音；音乐/本地声音属于整个电台，切回列表继续播放
    this._stopAudioIfEpisode();
    this.view = 'list';
    this.currentEpisodeId = null;
    this.generateChannel = null;
    this.generateError = null;
    this.generating = false;
    this.render();
  },

  // ---------- 首页：频道 + 节目列表 ----------

  renderList() {
    if (!this.container) return;
    const episodes = radioStore.getAllEpisodes();
    const stats = radioStore.getStats();
    // 统一节目库：默认先看待完成，已完成单独列出，可按栏目/特别喜欢筛选
    const filtered = episodes.filter(ep => {
      if (this._listChannel && ep.channel !== this._listChannel) return false;
      if (this._listFavOnly && !ep.favorite) return false;
      return true;
    });
    const pendingEps = filtered.filter(ep => ep.status !== 'completed');
    const doneEps = filtered.filter(ep => ep.status === 'completed');

    const chOf = id => CHANNELS.find(c => c.id === id) || CHANNELS[0];
    const prepareOf = ch => ch.id === 'music' ? '打开今夜曲库'
      : ch.id === 'goodnight' ? '听今天的歌单'
      : ch.id === 'english' ? '英文节目与聊天语音'
      : '请星星准备一期';
    const signal = '<span class="radio-signal"><span></span><span></span><span></span><span></span></span>';
    // 文字节目：一主两从（同一层级里唯一的重点位）
    const leadCard = () => {
      const ch = chOf('reading');
      return `<div class="radio-ch-card lead" data-channel="${ch.id}">
        <span class="ch-icon">${ch.icon}</span>
        <div class="ch-body">
          <div class="ch-name">${ch.name}</div>
          <div class="ch-desc">${ch.desc}</div>
        </div>
        <div class="ch-prepare">${signal}${prepareOf(ch)}</div>
      </div>`;
    };
    const programCard = id => {
      const ch = chOf(id);
      return `<div class="radio-ch-card" data-channel="${ch.id}">
        <span class="ch-icon">${ch.icon}</span>
        <div class="ch-name">${ch.name}</div>
        <div class="ch-desc">${ch.desc}</div>
        <div class="ch-prepare">${signal}${prepareOf(ch)}</div>
      </div>`;
    };
    // 每晚固定的声音：不是节目列表，做成更扁的一行
    const toneCard = id => {
      const ch = chOf(id);
      return `<div class="radio-ch-card tone" data-channel="${ch.id}">
        <span class="ch-icon">${ch.icon}</span>
        <div class="ch-body">
          <div class="ch-name">${ch.name}</div>
          <div class="ch-meta">${prepareOf(ch)}</div>
        </div>
        <span class="ch-go">›</span>
      </div>`;
    };

    this.container.innerHTML = `
      <section class="radio-scene">
        <header class="radio-header">
          <div class="title-area">
            <span class="radio-icon">📻</span>
            <div>
              <h2>午夜电台</h2>
              <div class="freq">FM 00:00 · 小星的私人频道</div>
            </div>
          </div>
          <button class="radio-exit" id="radio-exit">返回大厅</button>
        </header>

        <div class="radio-programs">
          ${leadCard()}
          ${programCard('night-talk')}
          ${programCard('english')}
        </div>

        <div class="radio-tier">今晚的声音</div>
        <div class="radio-atmosphere">
          ${toneCard('goodnight')}
          ${toneCard('music')}
        </div>

        <div class="radio-tier">馆藏</div>
        <div class="radio-shelf">
          <div class="shelf-card" id="voice-entry">
            <span class="shelf-icon">🎙️</span>
            <div class="shelf-body">
              <div class="shelf-title">声音收藏馆</div>
              <div class="shelf-desc">收藏你喜欢的中文声音片段，随时试听和管理。</div>
            </div>
            <span class="shelf-arrow">›</span>
          </div>

          <div class="shelf-card" id="reading-entry">
            <span class="shelf-icon">📚</span>
            <div class="shelf-body">
              <div class="shelf-title">小星的阅读书架</div>
              <div class="shelf-desc">${this._readingEntryDesc()}</div>
            </div>
            <span class="shelf-arrow">›</span>
          </div>
        </div>

        <div class="radio-filter">
          <button class="radio-filter-btn ${!this._listChannel && !this._listFavOnly ? 'active' : ''}" data-filter="all">全部</button>
          ${CHANNELS.map(ch => `
            <button class="radio-filter-btn ${this._listChannel === ch.id ? 'active' : ''}" data-filter-channel="${ch.id}">${ch.icon} ${ch.name}</button>
          `).join('')}
          <button class="radio-filter-btn ${this._listFavOnly ? 'active' : ''}" data-filter="fav">♥ 特别喜欢</button>
        </div>

        <div class="radio-section-title">
          <span class="dot"></span>
          待阅读 / 待收听
          ${stats.total > 0 ? `<span style="margin-left:auto;font-size:11px;color:#6a7ab0;">${stats.pending} 待完成 · ${stats.completed} 已完成</span>` : ''}
        </div>

        ${episodes.length === 0 ? `
          <div class="radio-empty">
            <div class="empty-icon">🌌</div>
            电台还没有节目。<br>
            选一个频道，让星星为你准备一期吧。
          </div>
        ` : pendingEps.length === 0 ? `
          <div class="radio-empty small">这里都读完了。已完成的节目在下面。</div>
        ` : `
          <div class="radio-ep-list">
            ${pendingEps.map(ep => this.renderEpisodeCard(ep)).join('')}
          </div>
        `}

        ${doneEps.length > 0 ? `
          <div class="radio-section-title done">
            <span class="dot"></span>
            已完成 · 可以回顾
            <span style="margin-left:auto;font-size:11px;color:#6a7ab0;">${doneEps.length} 期</span>
          </div>
          <div class="radio-ep-list done">
            ${doneEps.map(ep => this.renderEpisodeCard(ep)).join('')}
          </div>
        ` : ''}
      </section>
    `;

    this.bindListEvents();
  },

  renderEpisodeCard(ep) {
    const statusText = getStatusText(ep);
    const prog = radioStore.getProgress(ep.id);
    const sourceTag = ep.channel === 'english' && ep.source
      ? `<span class="ep-source ${ep.source}">${ep.source === 'conversation' ? 'From Our Conversations' : 'Original Broadcast'}</span>`
      : '';
    const voiceTag = ep.channel === 'english' && ep.voiceStatus === 'missing'
      ? `<span class="ep-voice-pending">${ep.source === 'conversation' ? '仅文字' : '语音未生成'}</span>`
      : ep.channel === 'english' && ep.voiceStatus === 'failed'
        ? '<span class="ep-voice-pending">语音待重试</span>'
        : ep.channel === 'english' && ep.heardAt
          ? '<span class="ep-heard">已听语音</span>'
          : '';
    const programTag = ep.channel === 'english' && ep.program && Array.isArray(ep.segments) && ep.segments.length
      ? `<span class="ep-program-tag">${ep.segments.length} 段连播</span>` : '';
    let progressTag = '';
    if (prog && prog.duration > 0 && prog.position > 0) {
      const pct = Math.min(100, Math.round(prog.position / prog.duration * 100));
      if (pct < 100) progressTag = `<span>已听 ${pct}%</span>`;
    }
    return `
      <div class="radio-ep-card" data-episode="${ep.id}">
        <div class="ep-icon">${getChannelIcon(ep.channel)}</div>
        <div class="ep-body">
          <div class="ep-title">${escapeHTML(ep.title)}</div>
          <div class="ep-meta">
            <span>${escapeHTML(getChannelName(ep.channel))}</span>
            <span>${formatTime(ep.createdAt)}</span>
            ${progressTag}
            ${ep.type === 'special' ? '<span class="ep-type-special">✦ 特别节目</span>' : ''}
            ${sourceTag}
            ${programTag}
            ${voiceTag}
          </div>
        </div>
        <button class="ep-fav ${ep.favorite ? 'on' : ''}" data-fav="${ep.id}" title="特别喜欢">${ep.favorite ? '♥' : '♡'}</button>
        <span class="ep-status ${ep.status}">${statusText}</span>
      </div>
    `;
  },

  bindListEvents() {
    this._on('#radio-exit', 'click', () => {
      window.PlaygroundRouter.go('lobby');
    });

    this.container.querySelectorAll('.radio-ch-card').forEach(card => {
      this._on(card, 'click', () => {
        const ch = card.dataset.channel;
        if (ch === 'music') {
          // 回到音乐频道不重置播放器：正在播放的曲目/声音与进度原样保留
          this.view = 'music';
          this.render();
          // 预加载素材元数据，供 voice 播放条标题与已加入数量使用
          radioVoice.list().then(items => {
            if (Array.isArray(items)) this._voiceItems = items;
            if (this.view === 'music') this._refreshMusicJoinedCount();
          }).catch(() => {});
        } else if (ch === 'goodnight') {
          // 本地曲库抽取，不产生任何 AI 消耗
          this.openSleep();
        } else if (ch === 'english') {
          this.openEnglish();
        } else {
          this.startGenerate(ch);
        }
      });
    });

    this.container.querySelectorAll('.radio-filter-btn').forEach(btn => {
      this._on(btn, 'click', () => {
        if (btn.dataset.filter === 'fav') {
          this._listFavOnly = !this._listFavOnly;
        } else if (btn.dataset.filter === 'all') {
          this._listChannel = '';
          this._listFavOnly = false;
        } else if (btn.dataset.filterChannel) {
          this._listChannel = btn.dataset.filterChannel;
          this._listFavOnly = false;
        }
        this.renderList();
      });
    });

    this.container.querySelectorAll('[data-fav]').forEach(btn => {
      this._on(btn, 'click', e => {
        if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
        this.toggleFavorite(btn.dataset.fav);
      });
    });

    this.container.querySelectorAll('.radio-ep-card').forEach(card => {
      this._on(card, 'click', () => {
        const id = card.dataset.episode;
        this.openDetail(id);
      });
    });

    this._on('#voice-entry', 'click', () => this.openVoice());
    this._on('#reading-entry', 'click', () => this.openReading());
  },

  // 书架入口的动态副标题：只读本地数据，不触发任何 API / 生成
  _readingEntryDesc() {
    try {
      const surprise = radioReading.getSurprise();
      if (surprise.thoughts.length || surprise.records.length) {
        return '星星最近留下了新的阅读字迹，进去看看吧。';
      }
      const now = radioReading.getNowReading();
      if (now) return `星星正在读《${now.book.title}》。`;
    } catch (e) {
      // 阅读数据不可用时退回静态文案，不影响首页渲染
    }
    return '看看星星读过的书，和那些安静的想法。';
  },


  // ---------- 特别喜欢（电台内部收藏，不改阅读状态） ----------
  toggleFavorite(id) {
    const next = radioStore.toggleFavorite(id);
    if (next === false && !radioStore.getEpisode(id)) return;
    this.renderList();
  },

  // ---------- 英文广播 ----------
  openEnglish() {
    this.view = 'english';
    this._enMsg = '';
    this._enMsgKind = '';
    this.render();
  },

  renderEnglish() {
    if (!this.container) return;
    const eps = radioStore.getEpisodeByChannel('english');
    const programs = eps.filter(ep => ep.program && Array.isArray(ep.segments) && ep.segments.length);
    const singles = eps.filter(ep => !(ep.program && Array.isArray(ep.segments) && ep.segments.length));
    const pendingPrograms = programs.filter(ep => ep.status !== 'completed');
    const donePrograms = programs.filter(ep => ep.status === 'completed');
    const cands = this._enCandidates;
    const used = usedMessageIds(eps);

    const programCard = ep => `
      <div class="radio-program-card" data-en-ep="${ep.id}">
        <div class="program-cover">${escapeHTML(ep.cover || '🌙')}<span class="cover-star">✦</span></div>
        <div class="program-body">
          <div class="program-title">${escapeHTML(ep.title || 'English Broadcast')}</div>
          <div class="program-summary">${escapeHTML(ep.summary || '')}</div>
          <div class="program-meta">
            <span class="program-count">${ep.segments.length} 段原声</span>
            <span>${formatTime(ep.createdAt)}</span>
            <span class="ep-status ${ep.status}">${getStatusText(ep)}</span>
            ${ep.heardAt ? '<span class="ep-heard">语音已听过</span>' : ''}
          </div>
        </div>
        <button class="ep-fav ${ep.favorite ? 'on' : ''}" data-fav="${ep.id}">${ep.favorite ? '♥' : '♡'}</button>
      </div>`;

    const singleCard = ep => `
      <div class="radio-ep-card" data-en-ep="${ep.id}">
        <div class="ep-icon">🌍</div>
        <div class="ep-body">
          <div class="ep-title">${escapeHTML(ep.title || 'English Broadcast')}</div>
          <div class="ep-meta">
            <span class="ep-source ${ep.source || 'original'}">${ep.source === 'conversation' ? 'From Our Conversations' : 'Original Broadcast'}</span>
            <span>${formatTime(ep.createdAt)}</span>
            ${ep.voiceStatus === 'missing' ? `<span class="ep-voice-pending">${ep.source === 'conversation' ? '仅文字' : '语音未生成'}</span>`
              : ep.voiceStatus === 'failed' ? '<span class="ep-voice-pending">语音待重试</span>'
              : ep.heardAt ? '<span class="ep-heard">已听语音</span>' : ''}
          </div>
        </div>
        <button class="ep-fav ${ep.favorite ? 'on' : ''}" data-fav="${ep.id}">${ep.favorite ? '♥' : '♡'}</button>
        <span class="ep-status ${ep.status}">${getStatusText(ep)}</span>
      </div>`;

    this.container.innerHTML = `
      <section class="radio-scene">
        <button class="detail-back" id="radio-back">← 返回节目列表</button>

        <div class="voice-head">
          <div class="voice-title">🌍 英文广播</div>
          <div class="voice-sub">星星把我们在聊天里留下的英文原声，按时间整理成一期一期的节目。整期可以连着听，也可以单独回到某一段。</div>
        </div>

        <div class="voice-toolbar">
          <button class="voice-btn primary" id="en-make-program" ${this._enBuilding ? 'disabled' : ''}>${this._enBuilding ? '正在整理…' : '整理一期节目'}</button>
          <button class="voice-btn" id="en-scan" ${this._enLoading ? 'disabled' : ''}>${this._enLoading ? '正在找…' : '看看还留着原声的聊天'}</button>
          <button class="voice-btn" id="en-original">让星星准备一期新的</button>
          <span class="en-count">${programs.length} 期 · ${singles.length} 段单条</span>
        </div>

        <div class="voice-msg ${this._enMsgKind === 'error' ? 'error' : ''}" style="display:${this._enMsg ? 'block' : 'none'}">${escapeHTML(this._enMsg)}</div>

        ${this._enScanned ? `
          <div class="radio-section-title"><span class="dot"></span>聊天里还留着原声的英文</div>
          <div class="en-cand-note">点「整理一期节目」会自动从这些素材里按时间挑 ${PROGRAM_MIN}~5 段排成新的一期；已经收进节目里的不会重复用。</div>
          ${cands.length ? `<div class="en-cand-list">${cands.map(c => `
            <div class="en-cand ${used.has(String(c.messageId)) ? 'is-used' : ''}" data-en-cand="${escapeHTML(c.messageId)}">
              <div class="en-cand-text">${escapeHTML(c.en.slice(0, 120))}${c.en.length > 120 ? '…' : ''}</div>
              <div class="en-cand-meta">${c.at ? formatTime(c.at) : ''} ${used.has(String(c.messageId)) ? '· 已收进节目' : '· 还能收进下一期'}</div>
            </div>`).join('')}</div>`
            : '<div class="radio-empty small">最近的聊天里没有可以搬进广播的原声。</div>'}
        ` : ''}

        <div class="radio-section-title"><span class="dot"></span>节目 · 可以整期收听</div>
        ${pendingPrograms.length ? `<div class="radio-program-list">${pendingPrograms.map(programCard).join('')}</div>`
          : '<div class="radio-empty small">还没有待听的英文节目。整理一期，把过去的原声排成一次回顾。</div>'}

        ${donePrograms.length ? `
          <div class="radio-section-title done"><span class="dot"></span>已收听 · 可以回顾</div>
          <div class="radio-program-list done">${donePrograms.map(programCard).join('')}</div>` : ''}

        ${singles.length ? `
          <div class="radio-section-title done"><span class="dot"></span>单段语音 · 之前的回顾</div>
          <div class="radio-ep-list done">${singles.map(singleCard).join('')}</div>` : ''}
      </section>
    `;
    this._bindEnglishEvents();
    this._mountSleepBar();
    this._mountMiniPlayer();
  },

  _bindEnglishEvents() {
    this._on('#radio-back', 'click', () => this.backToList());
    this._on('#en-make-program', 'click', () => this.buildEnglishProgram());
    this._on('#en-scan', 'click', () => this.scanEnglish());
    this._on('#en-original', 'click', () => this.startGenerate('english'));
    this.container.querySelectorAll('[data-en-ep]').forEach(row => {
      this._on(row, 'click', () => this.openDetail(row.dataset.enEp));
    });
    this.container.querySelectorAll('[data-fav]').forEach(btn => {
      this._on(btn, 'click', e => {
        if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
        this.toggleFavorite(btn.dataset.fav);
        this.renderEnglish();
      });
    });
  },

  async scanEnglish() {
    if (this._enLoading) return;
    this._enLoading = true;
    this._enMsg = '';
    this.renderEnglish();
    try {
      const list = await radioEnglish.scanChat(150);
      const used = usedMessageIds(radioStore.getEpisodeByChannel('english'));
      this._enCandidates = list.map(c => ({ ...c, externalAdded: used.has(String(c.messageId)) }));
      this._enScanned = true;
      if (!list.length) this._enMsg = '最近的聊天里没有找到带原声的英文语音。';
    } catch (err) {
      this._enMsg = err && err.message ? err.message : '读取聊天记录失败';
      this._enMsgKind = 'error';
    } finally {
      this._enLoading = false;
      if (this.view === 'english') this.renderEnglish();
    }
  },

  // 整理一期节目：本地扫描 → 过滤已用/无原声 → 按时间取 3~5 段 → 本地生成标题简介 → 持久化。
  // 全程 0 次 TTS / 0 次 DeepSeek；素材不够时不建空节目，也不重复整理。
  async buildEnglishProgram() {
    if (this._enBuilding) return;
    this._enBuilding = true;
    this._enMsg = '';
    this._enMsgKind = '';
    this.renderEnglish();
    try {
      const list = await radioEnglish.scanChat(150);
      const used = usedMessageIds(radioStore.getEpisodeByChannel('english'));
      const fresh = [];
      for (const c of list) {
        const mid = String(c.messageId);
        if (used.has(mid)) continue;
        // 只有本地真的解出原声才收；只剩文字的消息不进节目，也不补生成
        const origin = await radioEnglish.getOriginalAudio('msg:' + mid);
        if (!origin || !origin.blob || !origin.blob.size) continue;
        fresh.push({ ...c, messageId: mid });
      }

      if (fresh.length < PROGRAM_MIN) {
        this._enMsg = fresh.length
          ? `还留着原声、又没收进节目的英文只剩 ${fresh.length} 段，至少要 ${PROGRAM_MIN} 段才能整理成一期。`
          : '最近还留着原声的英文都已经收进已有的节目里了，暂时没有新素材。';
        this._enMsgKind = 'info';
        this._enScanned = true;
        this._enCandidates = list.map(c => ({ ...c, externalAdded: true }));
        return;
      }

      const picked = pickProgramSegments(fresh);
      const meta = buildProgramMeta(picked);
      const id = radioStore.generateId();
      const ok = radioStore.addEpisode({
        id,
        title: meta.title,
        channel: 'english',
        // content 仍保留英文正文，便于「记进共同珍藏」/搜索等既有逻辑复用
        content: picked.map(s => String(s.en || '').trim()).join('\n\n'),
        type: 'basic',
        lang: 'en',
        status: 'pending',
        createdAt: Date.now(),
        duration: 0,
        playbackPosition: 0,
        completedAt: null,
        source: 'conversation',
        voiceStatus: 'ready',            // 原声全部来自聊天，已存在，点开即可连播
        externalId: 'program:' + id,
        program: true,
        cover: meta.cover,
        summary: meta.summary,
        segments: picked.map(s => ({
          messageId: String(s.messageId),
          en: String(s.en || ''),
          zh: String(s.zh || ''),
          at: typeof s.at === 'number' ? s.at : 0,
        })),
      });

      if (!ok) {
        this._enMsg = '节目保存失败，存储空间可能不足，这一期没有写进电台。';
        this._enMsgKind = 'error';
        return;
      }

      this._enScanned = true;
      this._enCandidates = list.map(c => ({ ...c, externalAdded: used.has(String(c.messageId)) || picked.some(p => p.messageId === String(c.messageId)) }));
      this._enMsg = `整理好了：《${meta.title}》，${picked.length} 段原声。点开就能整期连着听。`;
      this._enMsgKind = 'ok';
    } catch (err) {
      this._enMsg = err && err.message ? err.message : '整理节目失败，请稍后再试';
      this._enMsgKind = 'error';
    } finally {
      this._enBuilding = false;
      if (this.view === 'english') this.renderEnglish();
    }
  },

  // 英文节目播放：聊天来源直接读原声；只有原创节目才会在缺语音时请求一次
  async playEnglishEpisode(id) {
    const ep = radioStore.getEpisode(id);
    if (!ep || ep.channel !== 'english') return;
    // 多段节目走时间线连播，不会把拼接后的文字再送 TTS
    if (ep.program && Array.isArray(ep.segments) && ep.segments.length) {
      return this.playEnglishProgram(id, 0);
    }
    const key = 'ep:' + id;
    const text = String(ep.content || '').trim();
    if (!text) return;

    let blob = ep.audioKey ? await radioEnglish.getCachedBlob(ep.audioKey) : null;
    if (!blob) blob = await radioEnglish.getCachedBlob(radioEnglish.hashText(text));

    // 来自聊天的节目：原声就是当时那条消息里存下的音频，直接取出来播，不再生成
    const fromChat = ep.source === 'conversation' && !!ep.externalId;
    if (!blob && fromChat) {
      const origin = await radioEnglish.getOriginalAudio(ep.externalId);
      if (origin) {
        blob = origin.blob;
        radioStore.setVoiceStatus(id, 'ready');
      } else {
        // 只有文字、原声已不在：如实标记，不补生成、不消耗额度
        radioStore.setVoiceStatus(id, 'missing');
        this._audioKey = key;
        this._audioStatus = 'error';
        this._audioError = '这段只剩文字，原来的语音已经不在了。';
        this._updatePlayerUI();
        return;
      }
    }

    if (!blob) {
      this._audioKey = key;
      this._audioStatus = 'loading';
      this._audioError = null;
      this._updatePlayerUI();
      try {
        const got = await radioEnglish.ensureVoice(text);
        blob = got.blob;
        radioStore.setVoiceStatus(id, 'ready', got.key);
      } catch (err) {
        radioStore.setVoiceStatus(id, 'failed');
        this._audioStatus = 'error';
        this._audioError = (err && err.message) ? err.message : '语音还没准备好';
        this._updatePlayerUI();
        return;
      }
    } else if (!fromChat) {
      radioStore.setVoiceStatus(id, 'ready', radioEnglish.hashText(text));
    }

    const prog = radioStore.getProgress(id);
    const startAt = (prog && !prog.completed && prog.position > 0 && prog.duration > 0 && prog.position < prog.duration - 2)
      ? prog.position : 0;

    this._exclusiveEngine(radioVoiceAudio);
    this._audioKey = key;
    this._audioStatus = 'loading';
    this._audioError = null;
    this._lastCur = startAt;
    this._lastDur = prog && prog.duration ? prog.duration : 0;
    this._lastPct = 0;
    this._updatePlayerUI();
    this._refreshBarMeta();
    if (ep.status === 'pending') radioStore.setEpisodeStatus(id, 'listening');

    try {
      await radioVoiceAudio.play({ id: key, blob, startAt, ...this._audioHandlers(key) });
    } catch (err) {
      if (this._audioKey !== key) return;
      this._audioStatus = 'error';
      this._audioError = (err && err.message) ? err.message : '音频播放失败，请重试';
      this._updatePlayerUI();
    }
  },

  // 整期连播：逐段读取聊天原声，上一段结束后自动接下一段；不拼接、不转码、不重新生成。
  async playEnglishProgram(id, startIndex = 0) {
    const ep = radioStore.getEpisode(id);
    if (!ep || !ep.program || !Array.isArray(ep.segments) || !ep.segments.length) return;
    const index = Math.max(0, Math.min(Number(startIndex) || 0, ep.segments.length - 1));
    this._enProgram = { episodeId: id, index, segments: ep.segments.slice() };
    if (ep.status === 'pending') radioStore.setEpisodeStatus(id, 'listening');
    await this._playProgramSegment();
  },

  async _playProgramSegment() {
    const q = this._enProgram;
    if (!q) return;
    const ep = radioStore.getEpisode(q.episodeId);
    if (!ep) { this._enProgram = null; return; }
    const key = 'ep:' + ep.id;

    // 跳过原声已经不在的片段；整期都读不到才报错，不补生成
    let origin = null;
    while (q.index < q.segments.length) {
      const seg = q.segments[q.index];
      origin = await radioEnglish.getOriginalAudio('msg:' + seg.messageId);
      if (origin && origin.blob && origin.blob.size) break;
      q.index += 1;
    }
    if (!origin || q.index >= q.segments.length) {
      this._enProgram = null;
      radioStore.setVoiceStatus(ep.id, 'missing');
      this._audioKey = key;
      this._audioStatus = 'error';
      this._audioError = '这一期里有片段的原声已经不在了，没法继续连播。';
      this._updatePlayerUI();
      if (this.view === 'detail' && this.currentEpisodeId === ep.id) this.renderDetail();
      return;
    }

    this._exclusiveEngine(radioVoiceAudio);
    this._audioKey = key;
    this._audioStatus = 'loading';
    this._audioError = null;
    this._lastCur = 0;
    this._lastDur = 0;
    this._lastPct = 0;
    this._updatePlayerUI();
    this._refreshBarMeta();
    this._updateProgramUI();

    try {
      await radioVoiceAudio.play({ id: key, blob: origin.blob, startAt: 0, ...this._audioHandlers(key) });
    } catch (err) {
      if (this._audioKey !== key) return;
      this._audioStatus = 'error';
      this._audioError = (err && err.message) ? err.message : '这一段原声播放失败';
      this._updatePlayerUI();
    }
  },

  // 只更新节目时间线的高亮与进度文字，不整页重绘（避免打断正在播放的音频）
  _updateProgramUI() {
    const q = this._enProgram;
    if (!q || !this.container) return;
    this.container.querySelectorAll('[data-seg-play]').forEach(row => {
      const i = Number(row.dataset.segPlay);
      row.classList.toggle('is-current', i === q.index);
      row.classList.toggle('is-done', i < q.index);
    });
    const label = this.container.querySelector('#program-seg-label');
    if (label) label.textContent = `第 ${Math.min(q.index + 1, q.segments.length)} / ${q.segments.length} 段`;
    const btn = this.container.querySelector('#program-play');
    if (btn) btn.textContent = this._audioStatus === 'playing' ? '⏸ 暂停整期' : '▶ 整期播放';
  },

  // ---------- 晚安哄睡（本地曲库，按天固定） ----------
  async openSleep() {
    this.view = 'sleep';
    this._sleepDate = '';
    this._sleepMsg = '';
    await this.loadSleepPlaylist();
    this.render();
  },

  async loadSleepPlaylist() {
    let clips = [];
    try {
      clips = await radioVoice.listByUse('sleep');
    } catch (e) {
      clips = [];
    }
    this._sleepClips = clips;
    this._sleepIds = radioSleep.getOrCreate(clips, radioSleep.todayKey());
    return this._sleepIds;
  },

  renderSleep() {
    if (!this.container) return;
    const clips = this._sleepClips || [];
    const byId = new Map(clips.map(c => [c.id, c]));
    const dateKey = this._sleepDate || radioSleep.todayKey();
    const ids = this._sleepDate ? radioSleep.get(this._sleepDate) : (this._sleepIds || []);
    const rows = ids.map((id, i) => {
      const c = byId.get(id);
      const playing = this._audioKey === 'voice:' + id && this._audioStatus === 'playing';
      return `
        <div class="sleep-row ${playing ? 'is-playing' : ''}">
          <span class="sleep-idx">${i + 1}</span>
          <div class="sleep-body">
            <div class="sleep-name">${c ? escapeHTML(c.name) : '（音频已不在收藏馆）'}</div>
            <div class="sleep-meta">${c && c.duration ? fmtClock(c.duration) : '本地音频'}${c && radioSleep.playedAt(c.id) ? ' · 上次听过 ' + formatTime(radioSleep.playedAt(c.id)) : ''}</div>
          </div>
          <button class="voice-btn" data-sleep-play="${i}" ${c ? '' : 'disabled'}>${playing ? '⏸ 暂停' : '▶ 播放'}</button>
        </div>`;
    }).join('');

    const history = radioSleep.dates().filter(d => d !== radioSleep.todayKey()).slice(0, 7);

    this.container.innerHTML = `
      <section class="radio-scene">
        <button class="detail-back" id="radio-back">← 返回节目列表</button>
        <div class="voice-head">
          <div class="voice-title">✨ 晚安哄睡</div>
          <div class="voice-sub">每天从你的声音收藏馆里挑三首，当天的组合和顺序固定下来，刷新也不会变。</div>
        </div>

        <div class="radio-section-title">
          <span class="dot"></span>
          ${this._sleepDate ? this._sleepDate + ' 的歌单' : '今天的歌单'}
          ${ids.length ? `<span style="margin-left:auto;font-size:11px;color:#6a7ab0;">${ids.length} 首</span>` : ''}
        </div>

        ${ids.length ? `<div class="sleep-list">${rows}</div>` : `
          <div class="radio-empty small">
            声音收藏馆里还没有标记为「哄睡」的音频。<br>
            去收藏馆给至少一段音频勾上「哄睡」，这里就会自动排好。
          </div>`}

        ${history.length ? `
          <div class="radio-section-title done"><span class="dot"></span>过去的歌单</div>
          <div class="sleep-dates">
            ${history.map(d => `<button class="voice-btn" data-sleep-date="${d}">${d}</button>`).join('')}
          </div>` : ''}

        <div class="voice-toolbar" style="margin-top:14px;">
          <button class="voice-btn" id="sleep-voice-entry">打开声音收藏馆</button>
        </div>
      </section>
    `;

    this._bindSleepEvents();
    this._mountSleepBar();
    this._mountMiniPlayer();
  },

  _bindSleepEvents() {
    this._on('#radio-back', 'click', () => this.backToList());
    this._on('#sleep-voice-entry', 'click', () => this.openVoice());
    this.container.querySelectorAll('[data-sleep-play]').forEach(btn => {
      this._on(btn, 'click', () => {
        const i = Number(btn.dataset.sleepPlay);
        const cur = this._sleepDate ? radioSleep.get(this._sleepDate) : this._sleepIds;
        const id = cur && cur[i];
        if (!id) return;
        if (this._audioKey === 'voice:' + id && this._audioStatus !== 'idle') {
          this._togglePlay();
          return;
        }
        this.playSleepAt(this._sleepDate, i);
      });
    });
    this.container.querySelectorAll('[data-sleep-date]').forEach(btn => {
      this._on(btn, 'click', async () => {
        this._sleepDate = btn.dataset.sleepDate;
        this.renderSleep();
      });
    });
  },

  async playSleepAt(dateKey, index) {
    const ids = dateKey ? radioSleep.get(dateKey) : (this._sleepIds || []);
    if (!ids.length) return;
    this._sleepQueue = ids.slice();
    this._sleepIndex = Math.max(0, Math.min(index, ids.length - 1));
    this._sleepDate = dateKey || '';
    await this.playVoiceClip(ids[this._sleepIndex]);
    if (this.view === 'sleep') this.renderSleep();
  },

  openVoice() {
    // 进入收藏馆：只停节目语音；正在播放的音乐/本地声音继续，音轨不会重复创建
    this._stopAudioIfEpisode();
    this._voiceMsg = '';
    this._voiceMsgKind = '';
    this._voiceRenamingId = null;
    this._voiceConfirmDeleteId = null;
    this.view = 'voice';
    this._resetVoiceAudioState();
    this.render();
    this.loadVoiceItems();
  },

  // ---------- 小星的阅读书架 ----------

  openReading() {
    // 只停节目语音；音乐/本地声音在书架里继续，便于边听边看书
    this._stopAudioIfEpisode();
    this._readingCategory = 'initial-read';
    this._readingThoughtId = null;
    this._readingMsg = '';
    this._readingMsgKind = '';
    // 阅读惊喜：只读取已经存在的感想/记录，随后标记为已看；不触发任何 API 或生成
    try {
      this._readingSurprise = radioReading.getSurprise();
      radioReading.markSeen();
    } catch (e) {
      this._readingSurprise = { thoughts: [], records: [] };
    }
    this.view = 'reading';
    this.render();
  },

  _readingSetMsg(text, kind = 'ok') {
    this._readingMsg = text;
    this._readingMsgKind = kind;
    this.renderReading();
  },

  renderReading() {
    if (!this.container) return;

    const tabs = [
      { id: 'initial-read', name: '初始已读' },
      { id: 'planned', name: '计划读完' },
      { id: 'unread', name: '尚未阅读' },
      { id: 'co-read', name: '共同阅读' },
    ];
    const now = radioReading.getNowReading();
    const next = radioReading.getNextBook();
    const thoughts = radioReading.getRecentThoughts(5);
    const surprise = this._readingSurprise || { thoughts: [], records: [] };

    // 当前在读
    const nowBlock = now
      ? `<div class="reading-block now">
           <div class="rb-label">当前在读</div>
           <div class="rb-main">《${escapeHTML(now.book.title)}》</div>
           <div class="rb-meta">${this._readingEdition(now.book)}</div>
         </div>`
      : `<div class="reading-block empty">
           <div class="rb-label">当前在读</div>
           <div class="rb-main">星星还没有选定正在读的书。</div>
         </div>`;

    // 下一本计划
    const nextBlock = next
      ? `<div class="reading-block">
           <div class="rb-label">下一本计划 · 准备开始</div>
           <div class="rb-main">《${escapeHTML(next.title)}》</div>
           <div class="rb-meta">${this._readingEdition(next)}</div>
         </div>`
      : '';

    // 阅读惊喜（只展示已经存在的新内容）
    let surpriseHtml = '';
    const sItems = [
      ...surprise.records.map(h => `读完了《${escapeHTML(h.title)}》${h.thought ? '，留下了一句感想。' : '。'}`),
      ...surprise.thoughts.map(t => `为《${escapeHTML(t.title)}》写下了新感想。`),
    ];
    if (sItems.length) {
      surpriseHtml = `<div class="reading-surprise">
        <div class="rb-label">✨ 星星最近的新字迹</div>
        ${sItems.map(s => `<div class="rs-item">· ${s}</div>`).join('')}
      </div>`;
    }

    // 最近感想
    let thoughtsHtml = '';
    if (thoughts.length) {
      thoughtsHtml = thoughts.map(t => {
        const book = radioReading.getBook(t.bookId);
        return `<div class="reading-thought-item">
          <div class="rt-book">《${escapeHTML(book ? book.title : '一本书')}》</div>
          <div class="rt-text">${escapeHTML(t.text)}</div>
          <div class="rt-time">${formatTime(t.createdAt)}</div>
        </div>`;
      }).join('');
    }

    // 分类书籍列表
    let books = [];
    if (this._readingCategory === 'co-read') {
      books = radioReading.getCoRead();
    } else {
      books = radioReading.getByCategory(this._readingCategory);
    }
    const tabHtml = tabs.map(t =>
      `<button class="reading-tab ${this._readingCategory === t.id ? 'on' : ''}" data-rcat="${t.id}">${t.name}</button>`
    ).join('');
    const booksHtml = books.length
      ? books.map(b => this._renderReadingBook(b)).join('')
      : `<div class="reading-block empty"><div class="rb-main">这一类暂时没有书。</div></div>`;

    this.container.innerHTML = `
      <section class="radio-scene">
        <button class="detail-back" id="reading-back">← 返回午夜电台</button>
        <div class="reading-head">
          <div class="reading-title">📚 小星的阅读书架</div>
          <div class="reading-sub">书单是星星长久的积累，读到哪里、想到什么，都会安静地留在这里。分类不会改变，进度由星星自己一点点写下。</div>
        </div>

        ${this._readingMsg ? `<div class="reading-msg ${this._readingMsgKind === 'error' ? 'error' : ''}">${escapeHTML(this._readingMsg)}</div>` : ''}
        ${surpriseHtml}
        ${nowBlock}
        ${nextBlock}

        <div class="reading-tabs">${tabHtml}</div>
        <div class="reading-book-list">${booksHtml}</div>

        <div class="radio-section-title" style="margin-top:22px;">
          <span class="dot"></span> 最近的阅读感想
        </div>
        ${thoughtsHtml || '<div class="reading-block empty"><div class="rb-main">还没有留下感想。读到心动的地方，星星会写下来。</div></div>'}
      </section>
    `;

    this._bindReadingEvents();
    // 书架内部重绘会清空容器：电台级公共控件（睡眠条、跨栏目播放条）需重新挂载
    this._mountSleepBar();
    this._mountMiniPlayer();
  },

  _readingEdition(book) {
    const bits = [];
    if (book.author) bits.push(book.author);
    if (book.translator) bits.push(book.translator + ' 译');
    if (book.publisher) bits.push(book.publisher);
    return bits.length ? bits.join(' · ') : '版本信息待核实';
  },

  _statusText(status) {
    return { unread: '未读', preparing: '准备开始', reading: '在读', finished: '已读' }[status] || status;
  },

  _renderReadingBook(book) {
    const now = radioReading.getNowReading();
    const next = radioReading.getNextBook();
    const isNow = !!(now && now.book.id === book.id);
    const isNext = !!(next && next.id === book.id);
    const finished = book.status === 'finished';
    const edition = this._readingEdition(book);
    const thinking = this._readingThoughtId === book.id;

    const actions = [];
    if (isNow && !finished) {
      actions.push('<button class="rbook-btn primary" data-ract="finish" data-id="' + book.id + '">标记读完</button>');
    } else if (!isNow && !finished) {
      actions.push('<button class="rbook-btn" data-ract="now" data-id="' + book.id + '">设为在读</button>');
      if (!isNext) {
        actions.push('<button class="rbook-btn" data-ract="next" data-id="' + book.id + '">列为下一本</button>');
      }
    }
    // 当前在读、已读完的书都可以补写感想
    if (isNow || finished) {
      actions.push('<button class="rbook-btn" data-ract="thought" data-id="' + book.id + '">写感想</button>');
    }
    // 共读：初始已读之外的书都可加入/移出；不改变原分类与状态
    if (book.category !== 'initial-read') {
      actions.push('<button class="rbook-btn ' + (book.coRead ? 'co-on' : '') + '" data-ract="co" data-id="' + book.id + '">' + (book.coRead ? '取消共读' : '加入共读') + '</button>');
    }

    let thoughtForm = '';
    if (thinking) {
      thoughtForm = `<div class="reading-thought-form">
        <textarea class="reading-thought-input" id="reading-thought-text" placeholder="写下此刻真实的想法……"></textarea>
        <div class="reading-thought-actions">
          <button class="rbook-btn primary" data-ract="save-thought" data-id="${book.id}">保存感想</button>
          <button class="rbook-btn" data-ract="cancel-thought">取消</button>
        </div>
      </div>`;
    }

    return `<div class="reading-book">
      <div class="rbook-main">
        <span class="rbook-title">《${escapeHTML(book.title)}》</span>
        <span class="rbook-tag st-${book.status}">${this._statusText(book.status)}</span>
        ${book.coRead ? '<span class="rbook-tag co">共读</span>' : ''}
      </div>
      <div class="rbook-edition">${escapeHTML(edition)}</div>
      <div class="rbook-actions">${actions.join('')}</div>
      ${thoughtForm}
    </div>`;
  },

  _bindReadingEvents() {
    this._on('#reading-back', 'click', () => this.backToList());

    this.container.querySelectorAll('[data-rcat]').forEach(btn => {
      this._on(btn, 'click', () => {
        this._readingCategory = btn.dataset.rcat;
        this._readingThoughtId = null;
        this._readingMsg = '';
        this.renderReading();
      });
    });

    this.container.querySelectorAll('[data-ract]').forEach(btn => {
      this._on(btn, 'click', () => {
        const act = btn.dataset.ract;
        const id = btn.dataset.id;
        if (act === 'now') {
          if (radioReading.setNowReading(id)) this._readingSetMsg('已把这本书列为当前在读。');
          else this._readingSetMsg('暂时无法设置，请稍后再试。', 'error');
        } else if (act === 'next') {
          if (radioReading.setNextBook(id)) this._readingSetMsg('已列为下一本，等星星真正开始再更新状态。');
          else this._readingSetMsg('暂时无法设置，请稍后再试。', 'error');
        } else if (act === 'finish') {
          if (radioReading.markFinished(id, '')) this._readingSetMsg('已记下读完这本书。想写点什么，可以再点「写感想」。');
          else this._readingSetMsg('暂时无法标记，请稍后再试。', 'error');
        } else if (act === 'thought') {
          this._readingThoughtId = id;
          this.renderReading();
          const ta = this.container.querySelector('#reading-thought-text');
          if (ta) ta.focus();
        } else if (act === 'cancel-thought') {
          this._readingThoughtId = null;
          this.renderReading();
        } else if (act === 'save-thought') {
          const ta = this.container.querySelector('#reading-thought-text');
          const text = ta ? ta.value.trim() : '';
          if (!text) {
            this._readingSetMsg('先写点什么再保存吧。', 'error');
            return;
          }
          if (radioReading.addThought(id, text)) {
            this._readingThoughtId = null;
            this._readingSetMsg('感想已经安静地记下来了。');
          } else {
            this._readingSetMsg('保存失败，请稍后再试。', 'error');
          }
        } else if (act === 'co') {
          if (radioReading.toggleCoRead(id)) {
            const b = radioReading.getBook(id);
            this._readingSetMsg(b && b.coRead ? '已加入共同阅读书架。' : '已移出共同阅读书架。');
          } else {
            this._readingSetMsg('暂时无法修改，请稍后再试。', 'error');
          }
        }
      });
    });
  },

  // ---------- 节目详情 ----------

  // ---------- 英文多段节目详情 ----------

  renderProgramDetail(ep) {
    if (!this.container) return;
    const q = this._enProgram && this._enProgram.episodeId === ep.id ? this._enProgram : null;
    const cur = q ? q.index : -1;
    const playing = this._audioKey === 'ep:' + ep.id && this._audioStatus === 'playing';
    const segs = ep.segments || [];
    const sub = q
      ? `英文广播 · 第 ${Math.min(q.index + 1, segs.length)} / ${segs.length} 段`
      : `英文广播 · ${segs.length} 段整期连播`;

    const timeline = segs.map((s, i) => `
      <button class="program-seg ${i === cur ? 'is-current' : ''} ${i < cur ? 'is-done' : ''}" data-seg-play="${i}">
        <span class="seg-no">${String(i + 1).padStart(2, '0')}</span>
        <span class="seg-body">
          <span class="seg-en">${escapeHTML(s.en)}</span>
          <span class="seg-meta">第 ${i + 1} 段 · 来自聊天${s.at ? ' · ' + formatTime(s.at) : ''}</span>
          ${s.zh ? `<span class="seg-zh">${escapeHTML(s.zh.slice(0, 90))}${s.zh.length > 90 ? '…' : ''}</span>` : ''}
        </span>
        <span class="seg-play">${i === cur && playing ? '⏸' : '▶'}</span>
      </button>
      ${i < segs.length - 1 ? '<div class="program-divider">· · ·</div>' : ''}
    `).join('');

    this.container.innerHTML = `
      <section class="radio-scene">
        <button class="detail-back" id="radio-back">← 返回英文广播</button>

        <div class="program-hero">
          <div class="program-cover big">${escapeHTML(ep.cover || '🌙')}<span class="cover-star">✦</span></div>
          <div class="program-hero-body">
            <div class="program-kicker">英文广播 · 一期节目</div>
            <h2 class="program-hero-title">${escapeHTML(ep.title)}</h2>
            <p class="program-hero-summary">${escapeHTML(ep.summary || '')}</p>
            <div class="detail-meta">
              <span class="badge channel">English Broadcast</span>
              <span class="program-count">${segs.length} 段原声</span>
              <span>${formatTime(ep.createdAt)}</span>
              <span style="color:#8a84a8;">· ${getStatusText(ep)}</span>
              ${ep.heardAt ? '<span class="ep-heard">语音已听过</span>' : ''}
              ${ep.favorite ? '<span class="ep-source original">♥ 特别喜欢</span>' : ''}
            </div>
          </div>
        </div>

        ${ep.voiceStatus === 'missing'
          ? '<div class="voice-msg error" style="margin-bottom:14px;">这一期里有片段的原声已经不在了，没法继续连播。</div>' : ''}

        ${this._renderPlayerBar('ep:' + ep.id, ep.title, sub)}

        <div class="program-actions">
          <button class="radio-btn primary" id="program-play">${playing ? '⏸ 暂停整期' : '▶ 整期播放'}</button>
          <span class="program-seg-label" id="program-seg-label">${q ? `第 ${Math.min(q.index + 1, segs.length)} / ${segs.length} 段` : `共 ${segs.length} 段`}</span>
          <button class="radio-btn" id="radio-mark-listened">${ep.status === 'completed' ? '已收听' : '标记为已收听'}</button>
          <button class="radio-btn" id="radio-fav">${ep.favorite ? '♥ 取消特别喜欢' : '♡ 特别喜欢'}</button>
          <button class="radio-btn" id="radio-keep">✦ 记进共同珍藏</button>
          <button class="radio-btn danger" id="radio-delete">删除节目</button>
        </div>

        <div class="radio-section-title"><span class="dot"></span>这一期的顺序</div>
        <div class="program-timeline">${timeline}</div>
      </section>
    `;

    this._on('#radio-back', 'click', () => { this.view = 'english'; this.render(); });
    this._on('#program-play', 'click', () => {
      if (this._audioKey === 'ep:' + ep.id && this._audioStatus !== 'idle') {
        this._togglePlay();
        return;
      }
      this.playEnglishProgram(ep.id, q ? q.index : 0);
    });
    this.container.querySelectorAll('[data-seg-play]').forEach(row => {
      this._on(row, 'click', () => {
        const i = Number(row.dataset.segPlay);
        if (this._audioKey === 'ep:' + ep.id && q && q.index === i && this._audioStatus !== 'idle') {
          this._togglePlay();
          return;
        }
        this.playEnglishProgram(ep.id, i);
      });
    });

    this._on('#radio-mark-listened', 'click', () => {
      if (ep.status !== 'completed') {
        radioStore.setEpisodeStatus(ep.id, 'completed');
        this.renderProgramDetail(radioStore.getEpisode(ep.id));
      }
    });
    this._on('#radio-fav', 'click', () => {
      radioStore.toggleFavorite(ep.id);
      this.renderProgramDetail(radioStore.getEpisode(ep.id));
    });
    this._bindKeepAction(ep);
    this._on('#radio-delete', 'click', () => {
      if (this._audioKey === 'ep:' + ep.id) this._resetAudio();
      radioStore.deleteEpisode(ep.id);
      this.view = 'english';
      this.currentEpisodeId = null;
      this.render();
    });

    this._bindPlayerBar();
    this._syncPlayerUIFromEngine();
  },

  // 珍藏：只写「待确认」，要不要收由她在房间珍藏页决定；同一期只提一次
  _bindKeepAction(ep) {
    this._on('#radio-keep', 'click', async () => {
      const btn = this.container.querySelector('#radio-keep');
      if (btn) { btn.disabled = true; btn.textContent = '正在记…'; }
      try {
        const sourceId = 'radio:ep:' + ep.id;
        if (await findKeepBySource(sourceId)) {
          if (btn) btn.textContent = '已经记过了';
          return;
        }
        await addKeep({
          title: String(ep.title || '电台的一期').slice(0, 20),
          content: String(ep.content || '').slice(0, 400),
          by: '用户',
          createdAt: Date.now(),
          needsConfirm: true,
          status: 'waiting_user',
          response: '',
          sourceId,
          channel: ep.channel,
        });
        if (btn) btn.textContent = '已放进珍藏页，等你确认';
      } catch (e) {
        if (btn) { btn.disabled = false; btn.textContent = '✦ 记进共同珍藏'; }
      }
    });
  },

  renderDetail() {
    if (!this.container) return;
    const ep = radioStore.getEpisode(this.currentEpisodeId);
    if (!ep) {
      this.view = 'list';
      this.render();
      return;
    }
    // 英文多段节目：用时间线 + 整期连播，而不是单篇正文
    if (ep.channel === 'english' && ep.program && Array.isArray(ep.segments) && ep.segments.length) {
      return this.renderProgramDetail(ep);
    }

    const statusText = getStatusText(ep);

    this.container.innerHTML = `
      <section class="radio-scene">
        <button class="detail-back" id="radio-back">← 返回节目列表</button>

        <div class="radio-detail">
          <div class="detail-header">
            <span class="detail-icon">${getChannelIcon(ep.channel)}</span>
            <div class="detail-title">${escapeHTML(ep.title)}</div>
          </div>
          <div class="detail-meta">
            <span class="badge channel">${escapeHTML(getChannelName(ep.channel))}</span>
            ${ep.type === 'special' ? '<span class="badge special">✦ 特别节目</span>' : ''}
            <span>${formatTime(ep.createdAt)}</span>
            <span style="color:#6a7ab0;">· ${statusText}</span>
            ${ep.channel === 'english' && ep.source
              ? `<span class="ep-source ${ep.source}">${ep.source === 'conversation' ? 'From Our Conversations' : 'Original Broadcast'}</span>` : ''}
            ${ep.channel === 'english' && ep.heardAt ? '<span class="ep-heard">语音已听过</span>' : ''}
            ${ep.favorite ? '<span class="ep-source original">♥ 特别喜欢</span>' : ''}
          </div>

          ${ep.channel === 'english' && ep.source === 'conversation' && ep.voiceStatus === 'missing'
            ? '<div class="voice-msg error" style="margin-bottom:14px;">这期只剩文字，原来的语音已经不在了。</div>' : ''}

          ${isVoiceEpisode(ep)
            ? this._renderPlayerBar('ep:' + ep.id, ep.title, getChannelName(ep.channel) + ' · 语音收听')
            : '<div class="radio-text-note">📖 这期是文字节目，慢慢读就好。读完后可以手动标记为已阅读。</div>'}

          <div class="detail-content">${escapeHTML(ep.content)}</div>

          <div class="detail-actions">
            <button class="radio-btn primary" id="radio-mark-listened">
              ${ep.status === 'completed'
                ? (isVoiceEpisode(ep) ? '已收听' : '已阅读')
                : (isVoiceEpisode(ep) ? '标记为已收听' : '标记为已阅读')}
            </button>
            <button class="radio-btn" id="radio-fav">${ep.favorite ? '♥ 取消特别喜欢' : '♡ 特别喜欢'}</button>
            <button class="radio-btn" id="radio-keep">✦ 记进共同珍藏</button>
            <button class="radio-btn danger" id="radio-delete">删除节目</button>
          </div>
        </div>
      </section>
    `;

    this._on('#radio-back', 'click', () => this.backToList());

    this._on('#radio-mark-listened', 'click', () => {
      if (ep.status !== 'completed') {
        radioStore.setEpisodeStatus(ep.id, 'completed');
        this.render();
      }
    });

    this._on('#radio-fav', 'click', () => {
      radioStore.toggleFavorite(ep.id);
      this.renderDetail();
    });

    this._bindKeepAction(ep);

    this._on('#radio-delete', 'click', () => {
      if (this._audioKey === 'ep:' + ep.id) this._resetAudio();
      radioStore.deleteEpisode(ep.id);
      this.backToList();
    });

    if (isVoiceEpisode(ep)) {
      this._bindPlayerBar();
      this._syncPlayerUIFromEngine();
    }
  },

  openDetail(id) {
    const ep = radioStore.getEpisode(id);
    if (!ep) return;
    // 只有"正在播另一期节目语音"时才停；音乐/本地声音不受影响
    if (this._audioKey && this._audioKey.startsWith('ep:') && this._audioKey !== 'ep:' + id) {
      this._resetAudio();
    }
    // 仅语音节目进入详情才置为 listening；纯文字节目保持待阅读，不产生收听中状态
    if (ep.status === 'pending' && isVoiceEpisode(ep)) {
      radioStore.setEpisodeStatus(id, 'listening');
    }
    this.currentEpisodeId = id;
    this.view = 'detail';
    this.render();
  },

  // ---------- 音乐频道 ----------

  renderMusic() {
    if (!this.container) return;
    const meta = radioStore.getMusicMeta();
    const tracks = radioMusic.getAll();

    // 播放条内容：voice: 时显示本地声音，否则显示当前曲目（默认第一首）
    let barKey, barTitle, barSub;
    if (this._audioKey && this._audioKey.startsWith('voice:')) {
      const id = this._audioKey.slice(6);
      const item = this._voiceItems.find(x => x.id === id);
      barKey = this._audioKey;
      barTitle = item ? item.name : '本地声音';
      barSub = '小星的声音 · 来自收藏馆';
    } else {
      const currentTrack = tracks.find(t => 'track:' + t.id === this._audioKey) || tracks[0];
      barKey = 'track:' + currentTrack.id;
      barTitle = currentTrack.title;
      barSub = currentTrack.artist;
    }

    const trackRows = tracks.map(t => {
      const fav = radioMusic.isFavorite(meta, t.id);
      const prog = radioMusic.getProgress(meta, t.id);
      const pct = prog && prog.duration > 0
        ? Math.min(100, Math.round(prog.lastPosition / prog.duration * 100)) : 0;
      return `
        <div class="track-row" data-track="${t.id}">
          <div class="track-mood">${t.mood}</div>
          <div class="track-body">
            <div class="track-title">${escapeHTML(t.title)}</div>
            <div class="track-artist">${escapeHTML(t.artist)}</div>
            <div class="track-desc">${escapeHTML(t.desc)}</div>
            ${pct > 0 ? `<div class="track-progress"><span style="width:${pct}%"></span></div>` : ''}
          </div>
          <button class="track-fav ${fav ? 'on' : ''}" data-fav="${t.id}" title="${fav ? '取消收藏' : '收藏'}">${fav ? '♥' : '♡'}</button>
        </div>
      `;
    }).join('');

    this.container.innerHTML = `
      <section class="radio-scene">
        <button class="detail-back" id="radio-back">← 返回节目列表</button>

        <div class="music-head">
          <div class="music-title">🎵 音乐频道</div>
          <div class="music-sub">夜深了，点一首曲子。收藏会留在这里，下次来还能接着听。</div>
        </div>

        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px;">
          <button class="music-random ${this._shuffleOn ? 'on' : ''}" id="music-random">
            🎲 ${this._shuffleOn ? '随机穿插 已开启' : '随机穿插'}
          </button>
          <button class="voice-btn" id="music-shuffle-now">立即随机点播</button>
          <span class="music-tip" style="margin:0;">已加入的声音：<span id="music-joined-count">${this._musicJoinedCount}</span> 段</span>
        </div>
        <div class="music-tip">开启「随机穿插」后，一首播完会自动接着放：星星会从你加入 music 频道的本地声音里随机抽取，与曲子自然混着播，不会每次都插入。</div>

        ${this._renderPlayerBar(barKey, barTitle, barSub)}

        <div class="radio-section-title"><span class="dot"></span> 今夜曲库
          <span style="margin-left:auto;font-size:11px;color:#6a7ab0;">${tracks.length} 首</span>
        </div>
        <div class="track-list">${trackRows}</div>
      </section>
    `;

    this._on('#radio-back', 'click', () => this.backToList());

    this._on('#music-random', 'click', () => {
      this._shuffleOn = !this._shuffleOn;
      const btn = this.container?.querySelector('#music-random');
      if (btn) {
        btn.classList.toggle('on', this._shuffleOn);
        btn.textContent = this._shuffleOn ? '🎲 随机穿插 已开启' : '🎲 随机穿插';
      }
    });
    this._on('#music-shuffle-now', 'click', () => this.shuffleNow());

    this.container.querySelectorAll('.track-row').forEach(row => {
      this._on(row, 'click', e => {
        if (e.target.closest('.track-fav')) return;
        this.playTrack(row.dataset.track);
      });
    });

    this.container.querySelectorAll('.track-fav').forEach(btn => {
      this._on(btn, 'click', e => {
        e.stopPropagation();
        const id = btn.dataset.fav;
        const next = radioMusic.toggleFavorite(radioStore.getMusicMeta(), id);
        radioStore.saveMusicMeta(next);
        this.renderMusic();
      });
    });

    this._bindPlayerBar();
    this._syncPlayerUIFromEngine();
    this._refreshMusicJoinedCount();
  },

  // 异步读取已加入音乐频道的素材数量，只更新文字，不重绘视图
  async _refreshMusicJoinedCount() {
    const count = (await radioVoice.listInMusic()).length;
    this._musicJoinedCount = count;
    const el = this.container?.querySelector('#music-joined-count');
    if (el) el.textContent = String(count);
  },

  // ---------- 声音收藏馆 ----------

  async loadVoiceItems() {
    this._voiceLoading = true;
    if (this.view === 'voice') this.renderVoice();
    const items = await radioVoice.list();
    this._voiceItems = Array.isArray(items) ? items : [];
    this._voiceLoading = false;
    if (this.view === 'voice') this.renderVoice();
  },

  _setVoiceMsg(text, kind = 'ok') {
    this._voiceMsg = text || '';
    this._voiceMsgKind = kind;
    const el = this.container?.querySelector('.voice-msg');
    if (!el) return;
    el.textContent = this._voiceMsg;
    el.className = 'voice-msg' + (kind === 'error' ? ' error' : '');
    el.style.display = this._voiceMsg ? 'block' : 'none';
  },

  _formatVoiceMeta(item) {
    const parts = [];
    // 格式：仅在能可靠拿到时显示
    if (item.mime && item.mime !== 'audio/*') {
      parts.push(escapeHTML(String(item.mime).split('/').pop().toUpperCase()));
    }
    // 时长：仅大于 0 时显示（探测失败不显示）
    if (typeof item.duration === 'number' && item.duration > 0) {
      parts.push(fmtClock(item.duration));
    }
    parts.push(formatTime(item.createdAt));
    const use = item.use || 'none';
    if (use === 'music') parts.push('♪ 音乐频道');
    else if (use === 'sleep') parts.push('🌙 晚安哄睡');
    else if (use === 'both') parts.push('♪ 音乐 · 🌙 哄睡');
    else parts.push('暂不分类');
    return parts.join(' · ');
  },

  renderVoice() {
    if (!this.container) return;
    const items = this._voiceItems;
    const loading = this._voiceLoading && items.length === 0;

    let listHtml;
    if (loading) {
      listHtml = '<div class="voice-empty"><div class="empty-icon">🎙️</div>正在打开收藏馆…</div>';
    } else if (items.length === 0) {
      listHtml = '<div class="voice-empty"><div class="empty-icon">🎙️</div>还没有收藏的声音，等你把喜欢的片段带来。</div>';
    } else {
      listHtml = `<div class="voice-list">${items.map(item => this._renderVoiceRow(item)).join('')}</div>`;
    }

    this.container.innerHTML = `
      <section class="radio-scene">
        <button class="detail-back" id="radio-back">← 返回节目列表</button>

        <div class="voice-head">
          <div class="voice-title">🎙️ 声音收藏馆</div>
          <div class="voice-sub">把你喜欢的中文声音片段收藏在这里。只保存在本机，随时可以试听、重命名或删除。</div>
        </div>

        <div class="voice-toolbar">
          <button class="voice-btn primary" id="voice-upload-btn">＋ 上传音频</button>
          <input type="file" class="voice-file-input" id="voice-file" accept="audio/*">
          <button class="voice-btn" id="voice-refresh">刷新</button>
          <span style="margin-left:auto;font-size:11px;color:#8a80ac;align-self:center;">${items.length} 段录音</span>
        </div>

        <div class="voice-msg" style="display:${this._voiceMsg ? 'block' : 'none'}">${escapeHTML(this._voiceMsg)}</div>

        ${listHtml}
      </section>
    `;

    this._bindVoiceEvents();
    // 收藏馆内部重绘会清空容器：电台级公共控件（睡眠条、跨栏目播放条）需重新挂载
    this._mountSleepBar();
    this._mountMiniPlayer();
  },

  _renderVoiceRow(item) {
    const id = escapeHTML(item.id);
    // 播放状态以电台会话为准：从音乐频道播到一半再进收藏馆，行内状态依然正确
    const isPlaying = this._audioKey === 'voice:' + item.id && this._audioStatus === 'playing';
    const isRenaming = this._voiceRenamingId === item.id;
    const isConfirm = this._voiceConfirmDeleteId === item.id;
    const playLabel = isPlaying ? '⏸ 暂停' : '▶ 试听';

    return `
      <div class="voice-row ${isPlaying ? 'is-playing' : ''}" data-voice="${id}">
        <div class="voice-row-main">
          <span class="voice-icon">🎵</span>
          <div class="voice-body">
            ${isRenaming
              ? `<div class="voice-rename-row">
                   <input class="voice-rename-input" data-rename-input="${id}" maxlength="80" value="${escapeHTML(item.name)}">
                   <button class="voice-btn primary" data-rename-save="${id}">保存</button>
                   <button class="voice-btn" data-rename-cancel="${id}">取消</button>
                 </div>`
              : `<div class="voice-name">${escapeHTML(item.name)}</div>
                 <div class="voice-meta">${this._formatVoiceMeta(item)}</div>`}
          </div>
          <div class="voice-actions">
            <button class="voice-btn" data-play="${id}">${playLabel}</button>
            <button class="voice-btn ${item.use === 'music' || item.use === 'both' ? 'music-on' : ''}" data-use-music="${id}">♪ 音乐</button>
            <button class="voice-btn ${item.use === 'sleep' || item.use === 'both' ? 'music-on' : ''}" data-use-sleep="${id}">🌙 哄睡</button>
            <button class="voice-btn" data-rename="${id}">重命名</button>
            <button class="voice-btn danger" data-delete="${id}">删除</button>
          </div>
        </div>
        ${isConfirm ? `
          <div class="voice-confirm">
            <span class="voice-confirm-text">确定删除「${escapeHTML(item.name)}」吗？此操作不可恢复。</span>
            <button class="voice-btn danger" data-delete-yes="${id}">确认删除</button>
            <button class="voice-btn" data-delete-no="${id}">取消</button>
          </div>` : ''}
      </div>
    `;
  },

  _bindVoiceEvents() {
    this._on('#radio-back', 'click', () => this.backToList());
    this._on('#voice-upload-btn', 'click', () => {
      const input = this.container?.querySelector('#voice-file');
      if (input) input.click();
    });
    this._on('#voice-file', 'change', e => this.onVoiceFileChange(e));
    this._on('#voice-refresh', 'click', () => this.loadVoiceItems());

    this.container.querySelectorAll('[data-play]').forEach(btn => {
      this._on(btn, 'click', () => this.toggleVoicePlay(btn.dataset.play));
    });
    this.container.querySelectorAll('[data-music]').forEach(btn => {
      this._on(btn, 'click', () => this.toggleVoiceInMusic(btn.dataset.music));
    });
    this.container.querySelectorAll('[data-use-music]').forEach(btn => {
      this._on(btn, 'click', () => this.toggleVoiceUse(btn.dataset.useMusic, 'music'));
    });
    this.container.querySelectorAll('[data-use-sleep]').forEach(btn => {
      this._on(btn, 'click', () => this.toggleVoiceUse(btn.dataset.useSleep, 'sleep'));
    });
    this.container.querySelectorAll('[data-rename]').forEach(btn => {
      this._on(btn, 'click', () => {
        // 重命名前停止试听
        this._resetVoiceAudio();
        this._voiceRenamingId = btn.dataset.rename;
        this._voiceConfirmDeleteId = null;
        this.renderVoice();
        const input = this.container?.querySelector('[data-rename-input]');
        if (input) { input.focus(); input.select(); }
      });
    });
    this.container.querySelectorAll('[data-rename-save]').forEach(btn => {
      this._on(btn, 'click', () => this.saveVoiceRename(btn.dataset.renameSave));
    });
    this.container.querySelectorAll('[data-rename-cancel]').forEach(btn => {
      this._on(btn, 'click', () => {
        this._voiceRenamingId = null;
        this.renderVoice();
      });
    });
    this.container.querySelectorAll('[data-delete]').forEach(btn => {
      this._on(btn, 'click', () => {
        this._voiceConfirmDeleteId = btn.dataset.delete;
        this._voiceRenamingId = null;
        this.renderVoice();
      });
    });
    this.container.querySelectorAll('[data-delete-no]').forEach(btn => {
      this._on(btn, 'click', () => {
        this._voiceConfirmDeleteId = null;
        this.renderVoice();
      });
    });
    this.container.querySelectorAll('[data-delete-yes]').forEach(btn => {
      this._on(btn, 'click', () => this.deleteVoice(btn.dataset.deleteYes));
    });
  },

  async onVoiceFileChange(e) {
    const input = e.target;
    const file = input?.files?.[0];
    if (!file) return;
    // 重置 input，允许连续选择同一个文件
    try { input.value = ''; } catch (err) { /* ignore */ }

    // 格式校验：优先用 MIME，其次用扩展名兜底
    const extOk = /\.(mp3|m4a|aac|wav|ogg|webm|flac|opus)$/i.test(file.name || '');
    const mimeOk = typeof file.type === 'string' && file.type.startsWith('audio/');
    if (!mimeOk && !extOk) {
      this._setVoiceMsg('这个格式暂时不支持，请选择音频文件（如 mp3、m4a、wav、ogg）。', 'error');
      return;
    }

    this._setVoiceMsg('正在保存声音…', 'ok');
    // 探测时长：能拿到才填，拿不到填 0（界面不显示）
    const duration = await this.probeVoiceDuration(file);
    const baseName = String(file.name || '未命名录音').replace(/\.[^.]+$/, '') || '未命名录音';
    const meta = await radioVoice.add(baseName, file, duration);
    if (!meta) {
      this._setVoiceMsg('保存失败：可能是浏览器存储空间不足，或当前浏览器不允许本地存储。请释放空间后重试。', 'error');
      return;
    }
    await this.loadVoiceItems();
    this._setVoiceMsg('已收藏「' + meta.name + '」。', 'ok');
  },

  // 用临时 Audio 读取时长，不播放、不占用 radioVoiceAudio 实例
  probeVoiceDuration(blob) {
    return new Promise(resolve => {
      let url = null;
      let done = false;
      const finish = (val) => {
        if (done) return;
        done = true;
        try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
        resolve(typeof val === 'number' && isFinite(val) && val > 0 ? val : 0);
      };
      try {
        url = URL.createObjectURL(blob);
        const a = new Audio();
        a.preload = 'metadata';
        a.onloadedmetadata = () => finish(a.duration);
        a.onerror = () => finish(0);
        a.src = url;
        setTimeout(() => finish(0), 8000);
      } catch (e) {
        finish(0);
      }
    });
  },

  // 加入/移出音乐频道随机范围：只改资格标记，不删除原始文件
  // 切换用途：music / sleep 可同时勾选（both）；两个都不勾 = 暂不分类
  async toggleVoiceUse(id, kind) {
    const item = (this._voiceItems || []).find(x => x.id === id);
    if (!item) return;
    const cur = item.use || 'none';
    const inMusic = cur === 'music' || cur === 'both';
    const inSleep = cur === 'sleep' || cur === 'both';
    let next;
    if (kind === 'music') next = inMusic ? (inSleep ? 'sleep' : 'none') : (inSleep ? 'both' : 'music');
    else next = inSleep ? (inMusic ? 'music' : 'none') : (inMusic ? 'both' : 'sleep');

    const ok = await radioVoice.setUse(id, next);
    if (!ok) {
      this._setVoiceMsg('用途保存失败，请稍后再试', 'error');
      return;
    }
    this._voiceItems = (this._voiceItems || []).map(x => x.id === id ? { ...x, use: next, inMusic: next === 'music' || next === 'both' } : x);
    // 哄睡歌单可能因此变化：清掉今天之后的缓存，让她重新看到最新结果
    if (this.view === 'sleep') { await this.loadSleepPlaylist(); }
    this._setVoiceMsg('用途已更新', 'ok');
    if (this.view === 'voice') this.renderVoice();
    if (this.view === 'sleep') this.renderSleep();
  },

  async toggleVoiceInMusic(id) {
    const item = this._voiceItems.find(x => x.id === id);
    if (!item) return;
    const next = !item.inMusic;
    const ok = await radioVoice.setInMusic(id, next);
    if (!ok) {
      this._setVoiceMsg('操作失败，请重试。', 'error');
      return;
    }
    await this.loadVoiceItems();
    this._setVoiceMsg(next
      ? `已把「${item.name}」加入音乐频道，星星会随机抽到它。`
      : `已把「${item.name}」移出音乐频道，原文件仍保留在收藏馆。`);
  },

  // 收藏馆试听：与音乐频道共用同一「电台声音」会话，离开栏目也能继续，且始终只有一个实例
  async toggleVoicePlay(id) {
    const item = (this._voiceItems || []).find(x => x.id === id);
    if (!item) return;
    const key = 'voice:' + id;

    // 同一条：播放中→暂停，暂停中→继续（状态来自会话，不另立一套）
    if (this._audioKey === key) {
      if (this._audioStatus === 'playing') {
        radioVoiceAudio.pause();
        return;
      }
      if (this._audioStatus === 'paused') {
        try {
          await radioVoiceAudio.resume();
        } catch (err) {
          this._setVoiceMsg('继续播放失败，请重新点试听。', 'error');
        }
        return;
      }
    }

    this._voicePlayState = 'playing';
    this._voicePlayingId = id;
    this.renderVoice();
    await this.playVoiceClip(id);
    if (this._audioStatus === 'error' && this.view === 'voice') {
      this._setVoiceMsg(this._audioError || '这段声音无法播放，可能格式不受支持或文件已损坏。', 'error');
    }
  },

  _updateVoiceRowUI(id) {
    const row = this.container?.querySelector(`[data-voice="${(typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id)}"]`);
    if (!row) return;
    const btn = row.querySelector('[data-play]');
    const playing = this._audioKey === 'voice:' + id && this._audioStatus === 'playing';
    if (btn) btn.textContent = playing ? '⏸ 暂停' : '▶ 试听';
    row.classList.toggle('is-playing', playing);
  },

  async saveVoiceRename(id) {
    const input = this.container?.querySelector(`[data-rename-input="${(typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id)}"]`);
    const name = (input?.value || '').trim();
    if (!name) {
      this._setVoiceMsg('名称不能为空。', 'error');
      return;
    }
    const ok = await radioVoice.rename(id, name);
    this._voiceRenamingId = null;
    if (!ok) {
      this._setVoiceMsg('重命名失败，请重试。', 'error');
      this.renderVoice();
      return;
    }
    await this.loadVoiceItems();
    this._setVoiceMsg('已重命名。', 'ok');
  },

  async deleteVoice(id) {
    // 删除的正是当前会话里的声音（无论从收藏馆试听还是音乐频道播放）→ 停止并复位
    if (this._audioKey === 'voice:' + id) {
      this._resetAudio();
      this._resetVoiceAudio();
    }
    // 删除后不再可能抽中它，清除随机记录，避免影响下一次抽取判断
    if (this._shuffleLastClipId === id) this._shuffleLastClipId = null;
    const ok = await radioVoice.remove(id);
    this._voiceConfirmDeleteId = null;
    if (!ok) {
      this._setVoiceMsg('删除失败，请重试。', 'error');
      this.renderVoice();
      return;
    }
    await this.loadVoiceItems();
    this._setVoiceMsg('已删除这段声音。', 'ok');
  },

  // ---------- 节目生成 ----------

  renderGenerating() {
    if (!this.container) return;
    const ch = CHANNELS.find(c => c.id === this.generateChannel);
    const chName = ch ? ch.name : '未知频道';
    const chIcon = ch ? ch.icon : '📻';

    this.container.innerHTML = `
      <section class="radio-scene">
        <div class="radio-generating">
          <div class="gen-icon">${chIcon}</div>
          <div class="gen-title">星星正在准备节目…</div>
          <div class="gen-sub">
            频道：${escapeHTML(chName)}<br>
            <span class="radio-signal" style="margin-top:8px;"><span></span><span></span><span></span><span></span></span>
          </div>
          ${this.generateError ? `
            <div class="gen-error">${escapeHTML(this.generateError)}</div>
          ` : ''}
          <div class="gen-actions">
            <button class="radio-btn-inline primary" id="radio-retry" ${this.generating ? 'disabled' : ''}>
              ${this.generating ? '准备中…' : '重新准备'}
            </button>
            <button class="radio-btn-inline" id="radio-cancel-gen">返回</button>
          </div>
        </div>
      </section>
    `;

    this._on('#radio-retry', 'click', () => {
      if (!this.generating) {
        this.generateError = null;
        this.doGenerate();
      }
    });

    this._on('#radio-cancel-gen', 'click', () => this.backToList());
  },

  startGenerate(channelId) {
    // 生成节目不打断电台里正在播放的音乐/本地声音
    this._stopAudioIfEpisode();
    this.generateChannel = channelId;
    this.generateError = null;
    this.view = 'generating';
    this.render();
    this.doGenerate();
  },

  async doGenerate() {
    if (this.generating) return;
    this.generating = true;
    this.generateError = null;
    this.render();

    try {
      const content = await this.generateEpisodeContent(this.generateChannel);
      if (!content || content.length < 50) {
        throw new Error('节目内容为空或过短');
      }

      const title = this.generateTitle(content, this.generateChannel);
      const isEnglish = this.generateChannel === 'english';
      const ep = {
        id: radioStore.generateId(),
        title,
        channel: this.generateChannel,
        content,
        type: 'basic',
        lang: isEnglish ? 'en' : 'zh',
        status: 'pending',
        createdAt: Date.now(),
        duration: 0,
        playbackPosition: 0,
        completedAt: null,
        // 英文广播是星星自己准备的原创节目；语音按需生成
        source: isEnglish ? 'original' : '',
        voiceStatus: isEnglish ? 'missing' : '',
      };

      const ok = radioStore.addEpisode(ep);
      if (!ok) {
        throw new Error('节目保存失败，存储空间可能不足');
      }

      // 生成成功，跳转到详情（音乐/本地声音继续，不因生成节目中断）
      this.generating = false;
      this._stopAudioIfEpisode();
      this.currentEpisodeId = ep.id;
      this.generateChannel = null;
      this.generateError = null;
      this.view = 'detail';
      this.render();

    } catch (err) {
      this.generating = false;
      this.generateError = err.message || '节目生成失败，请稍后再试。';
      // 保留在生成页面，显示错误和重试按钮
      this.render();
    }
  },

  async generateEpisodeContent(channel) {
    // 仅读书频道按需读取一小段阅读记忆；其他频道保持原有空 context，行为不变。
    // 阅读数据异常时退回空 context，不影响节目生成。
    let readingContext = '';
    if (channel === 'reading') {
      try {
        readingContext = radioReading.buildApiContext();
      } catch (e) {
        readingContext = '';
      }
    }
    const system = buildSystemPrompt(channel, readingContext);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'deepseek-chat',
          temperature: 0.85,
          max_tokens: 1200,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: '请准备今晚的节目。' }
          ]
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) throw new Error(`API 返回 ${res.status}`);
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error('API 返回内容为空');
      return content;
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        throw new Error('准备超时了，星星可能需要多一点时间。');
      }
      throw err;
    }
  },

  generateTitle(content, channel) {
    // 从内容中提取第一句作为标题候选
    const firstLine = content.split('\n').find(l => l.trim()) || '';
    let title = firstLine.trim().slice(0, 20);
    if (title.length < 4) {
      title = getChannelName(channel) + ' · 今夜';
    }
    // 去掉末尾标点
    title = title.replace(/[，。！？、…\s]+$/, '');
    return title;
  },
};

// 背景设置：电台使用无公共背景，自管理局部氛围
RadioScene.background = 'none';
