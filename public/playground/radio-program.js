// playground/radio-program.js
// 午夜电台 · 英文节目编排（纯本地规则，不发任何网络请求）
// 职责：从「还留着原声、且尚未收进任何节目」的英文聊天片段里，按时间整理成 3~5 段一期，
//      并用本地关键词规则生成标题/简介/封面。所有函数无 DOM、无 IndexedDB 依赖，便于单测。
// 边界：不生成新语音、不调用 TTS/DeepSeek；读不到原声的片段由调用方先过滤。

export const PROGRAM_MIN = 3;
export const PROGRAM_MAX = 5;

function atOf(seg) {
  return seg && typeof seg.at === 'number' && seg.at > 0 ? seg.at : 0;
}

function pad2(n) { return String(n).padStart(2, '0'); }

function dayLabel(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  if (!isFinite(d.getTime())) return '';
  return `${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`;
}

// 选材：按聊天时间从早到晚排队，每次取最早的 3~5 段。
// 这样第一期是最早的一段回顾，后面几期自然接着往后走，不会反复挑同几段。
export function pickProgramSegments(fresh, max = PROGRAM_MAX) {
  const list = (Array.isArray(fresh) ? fresh : [])
    .filter(s => s && typeof s.messageId === 'string' && String(s.en || '').trim())
    .slice()
    .sort((a, b) => {
      const ta = atOf(a), tb = atOf(b);
      if (ta && tb && ta !== tb) return ta - tb;
      if (ta && !tb) return -1;
      if (!ta && tb) return 1;
      return 0;
    });
  return list.slice(0, Math.max(PROGRAM_MIN, Math.min(PROGRAM_MAX, max)));
}

// 已用素材：旧版单段节目看 externalId，新节目看 segments；同一段话不会进两期。
export function usedMessageIds(episodes) {
  const used = new Set();
  for (const ep of (Array.isArray(episodes) ? episodes : [])) {
    if (!ep || ep.channel !== 'english') continue;
    const ext = String(ep.externalId || '');
    if (ext.startsWith('msg:')) used.add(ext.slice(4));
    for (const seg of (Array.isArray(ep.segments) ? ep.segments : [])) {
      if (seg && seg.messageId != null) used.add(String(seg.messageId));
    }
  }
  return used;
}

const THEMES = [
  { cover: '🌙', label: 'Night Notes', words: ['night', 'late', 'sleep', 'dream', 'moon', 'evening', 'goodnight', 'insomnia'] },
  { cover: '✨', label: 'Starlight Letters', words: ['star', 'light', 'shine', 'sky', 'wish', 'bright', 'spark'] },
  { cover: '🌤️', label: 'After the Day', words: ['day', 'morning', 'work', 'tired', 'rest', 'tomorrow', 'afternoon', 'busy'] },
  { cover: '💌', label: 'Small Things', words: ['love', 'heart', 'miss', 'remember', 'together', 'home', 'warm'] },
];

// 标题/简介/封面全部由本地关键词和日期生成，不请求模型。
export function buildProgramMeta(segments) {
  const list = Array.isArray(segments) ? segments : [];
  const text = list.map(s => String(s.en || '')).join(' ').toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const t of THEMES) {
    let score = 0;
    for (const w of t.words) {
      const re = new RegExp(`\\b${w}\\b`, 'g');
      score += (text.match(re) || []).length;
    }
    if (score > bestScore) { best = t; bestScore = score; }
  }
  const theme = best || THEMES[0];

  const times = list.map(atOf).filter(Boolean).sort((a, b) => a - b);
  const start = dayLabel(times[0]);
  const end = dayLabel(times[times.length - 1]);
  const range = start && end && start !== end ? `${start}–${end}` : (start || '最近');
  const count = list.length;

  return {
    title: `${theme.label} · ${range}`,
    cover: theme.cover,
    summary: `这一期从我们过去的聊天里收了 ${count} 段还留着原声的英文，按时间顺序从 ${range} 排下来。没有再重新生成语音，都是当时说给你听的那几句。`,
  };
}
