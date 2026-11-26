/* public/butler/butler-core.js
 * 生活管家 · 纯逻辑层
 * 不依赖 DOM、IndexedDB、网络。可在浏览器中直接 import，也可在 Node 中测试。
 * 所有日期字符串均为 'YYYY-MM-DD'，按 UTC 解析以避免时区/DST/跨年误差。
 */

export const SCHEMA_VERSION = 1;

export const TASK_STATUS = Object.freeze({
  PENDING: 'pending',
  DONE: 'done',
  CANCELLED: 'cancelled',
});

const DAY_MS = 86400000;

/* ---------------- 日期工具 ---------------- */

export function todayStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 严格解析 'YYYY-MM-DD'，返回 UTC 毫秒；非法日期（如 2023-02-29）返回 null
export function parseDay(str) {
  if (typeof str !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return ms;
}

export function isValidDay(str) {
  return parseDay(str) !== null;
}

export function formatDay(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function addDays(str, n) {
  const ms = parseDay(str);
  if (ms === null || !Number.isInteger(n)) return null;
  return formatDay(ms + n * DAY_MS);
}

// b - a，单位为天；任一非法返回 null
export function diffDays(a, b) {
  const ams = parseDay(a);
  const bms = parseDay(b);
  if (ams === null || bms === null) return null;
  return Math.round((bms - ams) / DAY_MS);
}

export function compareDay(a, b) {
  return String(a || '').localeCompare(String(b || ''));
}

/* ---------------- ID / 时间 ---------------- */

export function uid(prefix = 'id') {
  let rand;
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      rand = globalThis.crypto.randomUUID();
    }
  } catch {}
  if (!rand) rand = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${rand}`;
}

export function parseHHMM(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return { h, mi };
}

// 把本地日期 'YYYY-MM-DD' 与本地时刻 'HH:MM' 合成绝对毫秒
export function localDateTimeToMs(dateStr, hhmm) {
  const day = parseDay(dateStr);
  const t = parseHHMM(hhmm);
  if (day === null || !t) return null;
  const ud = new Date(day);
  // 用 UTC 解析出的年月日作为「本地墙钟日期」再构造本地时间，
  // 避免在负时区下 UTC 零点属于本地前一天导致日期错位。
  return new Date(ud.getUTCFullYear(), ud.getUTCMonth(), ud.getUTCDate(), t.h, t.mi, 0, 0).getTime();
}

export function formatClock(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/* ---------------- 历史 ---------------- */

export function pushHistory(record, action, detail, extra = {}) {
  if (!record || typeof record !== 'object') return record;
  if (!Array.isArray(record.history)) record.history = [];
  record.history.push({
    at: Date.now(),
    action,
    detail: String(detail || ''),
    ...extra,
  });
  record.updatedAt = Date.now();
  return record;
}

/* ---------------- 睡眠 ---------------- */

/**
 * 由「起床日期 + 入睡时刻 + 起床时刻」构造一条睡眠记录。
 * 若入睡时刻晚于起床时刻，视为跨午夜，入睡日期自动回退一天。
 * date 字段存「起床日期」，便于按天分组与补录。
 */
export function buildSleepRecord({ date, sleepTime, wakeTime, note = '', id = null }) {
  if (!isValidDay(date)) throw new Error('请选择有效的起床日期。');
  const wakeAt = localDateTimeToMs(date, wakeTime);
  if (wakeAt === null) throw new Error('起床时间格式不正确。');
  let sleepDate = date;
  let sleepAt = localDateTimeToMs(sleepDate, sleepTime);
  if (sleepAt === null) throw new Error('入睡时间格式不正确。');
  if (sleepAt >= wakeAt) {
    sleepDate = addDays(date, -1);
    sleepAt = localDateTimeToMs(sleepDate, sleepTime);
  }
  const durationMs = wakeAt - sleepAt;
  // 时长必须严格小于 24 小时；相同入睡/起床时刻会回退一天得到正好 24h，属无效输入
  if (!(durationMs > 0) || durationMs >= 24 * 3600000) {
    throw new Error('睡眠时长不合理，请检查时间。');
  }
  return {
    id: id || uid('sleep'),
    date,
    sleepDate,
    sleepTime,
    wakeTime,
    sleepAt,
    wakeAt,
    durationMs,
    note: String(note || ''),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    v: SCHEMA_VERSION,
    history: [],
  };
}

export function formatDuration(ms) {
  if (!(ms > 0)) return '—';
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}分钟`;
  if (m === 0) return `${h}小时`;
  return `${h}小时${m}分`;
}

/* ---------------- 周期 ---------------- */

/**
 * 校验一条周期记录。existing 为同库中其他记录（数组）。
 * 返回 null 表示通过，否则返回错误说明。
 * today 只用于限制「实际日期不能晚于今天」；预测日期不走这里，因此不受限制。
 */
export function validateCycle(input, existing = [], today = todayStr()) {
  if (!input || !isValidDay(input.startDate)) return '请选择有效的开始日期。';
  if (isValidDay(today) && compareDay(input.startDate, today) > 0) return '开始日期不能晚于今天。';
  if (input.endDate !== null && input.endDate !== undefined && input.endDate !== '') {
    if (!isValidDay(input.endDate)) return '结束日期格式不正确。';
    if (diffDays(input.startDate, input.endDate) < 0) return '结束日期不能早于开始日期。';
    if (isValidDay(today) && compareDay(input.endDate, today) > 0) return '结束日期不能晚于今天。';
  }
  const start = input.startDate;
  const end = input.endDate || start;
  for (const c of existing) {
    if (!c || c.id === input.id) continue;
    if (!isValidDay(c.startDate)) continue;
    const cEnd = c.endDate || c.startDate;
    if (start === c.startDate) return '该开始日期已存在记录，请修改原记录。';
    if (compareDay(start, cEnd) <= 0 && compareDay(c.startDate, end) <= 0) {
      return '该周期与已有记录重叠，请检查日期。';
    }
  }
  return null;
}

export function periodLengthDays(cycle) {
  if (!cycle || !cycle.endDate || !isValidDay(cycle.endDate)) return null;
  return diffDays(cycle.startDate, cycle.endDate) + 1;
}

/**
 * 经期第几天：开始当天记为第 1 天。
 * today 早于开始日期（历史误录）时返回 null，不编造天数。
 */
export function periodDayNo(cycle, today = todayStr()) {
  if (!cycle || !isValidDay(cycle.startDate) || !isValidDay(today)) return null;
  const n = diffDays(cycle.startDate, today);
  if (n === null || n < 0) return null;
  return n + 1;
}

/**
 * 派生经期状态（纯计算，不写库、不修改记录、不补任何日期）。
 * - ongoing：开始日期最新的一条，且没有结束日期
 * - missingEnd：其余没有结束日期的记录（历史漏补，保持原样等用户自己填）
 * - closed：已经有实际结束日期的记录
 * 多条未结束时，只有最新的一条算「进行中」，不能同时算作多条。
 */
export function cyclePhase(cycles) {
  const rows = [...(cycles || [])]
    .filter(c => c && isValidDay(c.startDate))
    .sort((a, b) => compareDay(a.startDate, b.startDate) || ((a.createdAt || 0) - (b.createdAt || 0)));
  const last = rows.length ? rows[rows.length - 1] : null;
  const ongoing = last && !last.endDate ? last : null;
  const missingEnd = rows.filter(r => !r.endDate && r !== ongoing);
  const closed = rows.filter(r => !!r.endDate);
  return { ongoing: ongoing || null, missingEnd, closed, rows };
}

// 为每条周期计算与上一次开始日期的间隔（天数）；最早一条为 null
export function cyclesWithLengths(cycles) {
  const sorted = [...(cycles || [])]
    .filter(c => c && isValidDay(c.startDate))
    .sort((a, b) => compareDay(a.startDate, b.startDate));
  let prev = null;
  return sorted.map(c => {
    const length = prev === null ? null : diffDays(prev, c.startDate);
    prev = c.startDate;
    return { ...c, cycleLengthDays: length, periodLengthDays: periodLengthDays(c) };
  });
}

/**
 * 基础预测：至少 3 次开始记录（产生 2 个间隔）才给出估算。
 * 取最近最多 6 个间隔的中位数，避免异常值影响；给出 ±2 天区间。
 */
export function predictCycle(cycles, today = todayStr()) {
  const withLen = cyclesWithLengths(cycles);
  const intervals = withLen.map(c => c.cycleLengthDays).filter(n => Number.isInteger(n) && n >= 15 && n <= 90);
  const last = withLen.length ? withLen[withLen.length - 1].startDate : null;

  if (withLen.length < 3 || intervals.length < 2 || !last) {
    const have = withLen.length;
    return {
      ok: false,
      reason: have === 0
        ? '还没有经期记录，先记录一次开始日期吧。'
        : `历史记录不足（已有 ${have} 次），至少需要 3 次开始记录才能估算下一次。`,
      samples: have,
    };
  }

  const recent = intervals.slice(-6);
  const sorted = [...recent].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);

  const periodLens = withLen.map(c => c.periodLengthDays).filter(n => Number.isInteger(n) && n >= 1 && n <= 14).slice(-6);
  let predictedEnd = null;
  let medianPeriod = null;   // 参考持续天数（只统计已填结束日期的记录），仅供展示
  if (periodLens.length) {
    const ps = [...periodLens].sort((a, b) => a - b);
    const pm = Math.floor(ps.length / 2);
    medianPeriod = ps.length % 2 ? ps[pm] : Math.round((ps[pm - 1] + ps[pm]) / 2);
    predictedEnd = { from: addDays(last, median + medianPeriod - 2), to: addDays(last, median + medianPeriod) };
  }

  return {
    ok: true,
    nextStart: { from: addDays(last, median - 2), to: addDays(last, median + 2), center: addDays(last, median) },
    predictedEnd,
    medianPeriod,
    median,
    samples: withLen.length,
    intervalSamples: recent.length,
    basedOn: last,
    daysFromToday: diffDays(today, addDays(last, median)),
    note: '这是基于历史记录的估算，不是确定日期；记录越多会越贴近你的实际周期。',
  };
}

/* ---------------- 任务状态机 ---------------- */

export function canTransition(from, to) {
  const allowed = {
    [TASK_STATUS.PENDING]: [TASK_STATUS.DONE, TASK_STATUS.CANCELLED],
    [TASK_STATUS.DONE]: [TASK_STATUS.PENDING],
    [TASK_STATUS.CANCELLED]: [TASK_STATUS.PENDING],
  };
  return (allowed[from] || []).includes(to);
}

export function describeTask(task) {
  if (!task) return '';
  const when = task.date ? `${task.date}${task.time ? ' ' + task.time : ''}` : '未设置时间';
  return `${task.title || '未命名事项'}（${when}）`;
}
