/* public/shared/life-clock.js — 项目统一时间基础层（P0/S1）
 * 纯函数，零副作用，零依赖，不读写任何存储、不发请求。
 * 语义：全部按浏览器本地时区；日期字符串统一 'YYYY-MM-DD'。
 * 挂载：window.LifeClock（经典脚本）；Node 测试用 import 触发副作用后取 globalThis.LifeClock。
 */
(function (root) {
  'use strict';

  var DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  var CLOCK_RE = /^(\d{1,2}):(\d{2})$/;

  function pad2(n) { return String(n).padStart(2, '0'); }

  // 'YYYY-MM-DD' → { y, m, d }；非法/归一化日期一律 null（不做自动进位）
  function dayParts(s) {
    if (typeof s !== 'string') return null;
    var m = DAY_RE.exec(s);
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    // 回读校验：2026-02-30 / 2026-11-31 这类会被 Date 归一化的必须拒绝
    var probe = new Date(y, mo - 1, d);
    if (probe.getFullYear() !== y || probe.getMonth() !== mo - 1 || probe.getDate() !== d) return null;
    return { y: y, m: mo, d: d };
  }

  function isFiniteMs(v) { return typeof v === 'number' && isFinite(v); }

  // 接受时间戳或 'YYYY-MM-DD'，统一成 Date；非法返回 null
  function toDate(v) {
    if (isFiniteMs(v)) return new Date(v);
    if (typeof v === 'string') {
      var p = dayParts(v);
      if (p) return new Date(p.y, p.m - 1, p.d);
      return null;
    }
    return null;
  }

  function now() { return Date.now(); }

  // 'YYYY-MM-DD'（本地）。与 app.js 现有 today() 输出逐字一致
  function formatDay(ms) {
    var d = ms === undefined ? new Date() : toDate(ms);
    if (!d || isNaN(d.getTime())) return null;
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  // 'HH:MM'，补零
  function formatClock(ms) {
    var d = ms === undefined ? new Date() : toDate(ms);
    if (!d || isNaN(d.getTime())) return null;
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  // 'YYYY-MM-DD HH:MM'
  function formatStamp(ms) {
    var day = formatDay(ms), clock = formatClock(ms);
    if (!day || !clock) return null;
    return day + ' ' + clock;
  }

  // 中文长日期（含星期）。中午 12:00 构造，避开夏令时/时区边界导致的日期偏移；
  // 与 app.js dateText() 完全一致。
  function formatDateLong(dayStr) {
    if (!dayParts(dayStr)) return null;
    return new Date(dayStr + 'T12:00:00').toLocaleDateString('zh-CN', {
      year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
    });
  }

  // 'YYYY-MM-DD' → 本地 00:00 时间戳；非法 null
  function parseDay(dayStr) {
    var p = dayParts(dayStr);
    if (!p) return null;
    return new Date(p.y, p.m - 1, p.d, 0, 0, 0, 0).getTime();
  }

  // 本地日历字段加减（跨月/跨年/夏令时安全，不碰毫秒）
  function addDays(dayStr, n) {
    var p = dayParts(dayStr);
    if (!p || !isFiniteMs(n)) return null;
    var d = new Date(p.y, p.m - 1, p.d + Math.trunc(n));
    if (isNaN(d.getTime())) return null;
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  // 按「本地日历日」差：a - b（天）。用 UTC 构造消除夏令时 23/25 小时误差
  function diffDays(a, b) {
    var da = toDate(a), db = toDate(b);
    if (!da || !db || isNaN(da.getTime()) || isNaN(db.getTime())) return null;
    var ua = Date.UTC(da.getFullYear(), da.getMonth(), da.getDate());
    var ub = Date.UTC(db.getFullYear(), db.getMonth(), db.getDate());
    return Math.round((ua - ub) / 86400000);
  }

  function startOfDay(ms) {
    var d = ms === undefined ? new Date() : toDate(ms);
    if (!d || isNaN(d.getTime())) return null;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
  }

  function endOfDay(ms) {
    var d = ms === undefined ? new Date() : toDate(ms);
    if (!d || isNaN(d.getTime())) return null;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
  }

  // dayStr + 'HH:MM' → 本地时间戳。用本地 Date 构造，禁用 Date.parse（按 UTC 解析会偏移）
  function fromParts(dayStr, hhmm) {
    var p = dayParts(dayStr);
    if (!p || typeof hhmm !== 'string') return null;
    var m = CLOCK_RE.exec(hhmm);
    if (!m) return null;
    var h = +m[1], mi = +m[2];
    if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
    return new Date(p.y, p.m - 1, p.d, h, mi, 0, 0).getTime();
  }

  // 0=周日 … 6=周六
  function weekday(v) {
    var d = v === undefined ? new Date() : toDate(v);
    if (!d || isNaN(d.getTime())) return null;
    return d.getDay();
  }

  // 时区偏移（分钟），东正西负：东八区 = +480。
  // 注意与原生 new Date().getTimezoneOffset() 符号相反（原生西正东负）。
  // 仅用于展示与兜底，不参与任何时长计算。
  function tzOffsetMin(ms) {
    var d = ms === undefined ? new Date() : toDate(ms);
    if (!d || isNaN(d.getTime())) return null;
    return -d.getTimezoneOffset();
  }

  /* ---------- P1-a 新增：中文星期 / 时段 / 自然相对时长 ---------- */
  // 时段只供生活上下文使用，不改动房间既有的 getTimeContext / getScheduleContext 边界
  var WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  function weekdayName(v) {
    var w = weekday(v);
    return w === null ? null : WEEKDAYS[w];
  }

  function weekdayShort(v) {
    var w = weekday(v);
    return w === null ? null : '周' + '日一二三四五六'.charAt(w);
  }

  // 粗粒度时段（1 小时精度），用于「现在是晚上」这类事实陈述
  function partOfDay(ms) {
    var d = ms === undefined ? new Date() : toDate(ms);
    if (!d || isNaN(d.getTime())) return null;
    var h = d.getHours();
    if (h < 5) return '深夜';
    if (h < 8) return '清晨';
    if (h < 11) return '上午';
    if (h < 13) return '中午';
    if (h < 17) return '下午';
    if (h < 19) return '傍晚';
    if (h < 23) return '晚上';
    return '深夜';
  }

  // 自然粒度相对时长：不输出精确分钟（用户主动问时间时才用 formatClock）
  // 返回 { ms, text, level }，level 供上层判断是否需要延续话题
  function relative(fromMs, toMs) {
    var a = isFiniteMs(fromMs) ? fromMs : null;
    var b = toMs === undefined ? Date.now() : (isFiniteMs(toMs) ? toMs : null);
    if (a === null || b === null) return null;
    var diff = b - a;
    if (diff < 0) diff = 0;
    var min = Math.floor(diff / 60000);
    var level = 'recent';
    var text;
    if (min < 2) { text = '刚刚'; level = 'now'; }
    else if (min < 15) { text = '几分钟前'; level = 'minutes'; }
    else if (min < 60) { text = '半小时前'; level = 'hour'; }
    else {
      var dayGap = diffDays(b, a);
      if (dayGap === 0) { text = '今天早些时候'; level = 'today'; }
      else if (dayGap === 1) { text = '昨天'; level = 'day'; }
      else if (dayGap <= 3) { text = '两三天前'; level = 'days'; }
      else if (dayGap <= 6) { text = '前几天'; level = 'days'; }
      else if (dayGap <= 13) { text = '上周'; level = 'week'; }
      else if (dayGap <= 29) { text = '半个月前'; level = 'weeks'; }
      else if (dayGap <= 59) { text = '一个月前'; level = 'month'; }
      else { text = '很久以前'; level = 'long'; }
    }
    return { ms: diff, text: text, level: level };
  }

  function isValidDay(s) { return dayParts(s) !== null; }

  function isSameDay(a, b) {
    var da = toDate(a), db = toDate(b);
    if (!da || !db || isNaN(da.getTime()) || isNaN(db.getTime())) return false;
    return da.getFullYear() === db.getFullYear()
      && da.getMonth() === db.getMonth()
      && da.getDate() === db.getDate();
  }

  root.LifeClock = {
    now: now,
    formatDay: formatDay,
    formatClock: formatClock,
    formatStamp: formatStamp,
    formatDateLong: formatDateLong,
    parseDay: parseDay,
    addDays: addDays,
    diffDays: diffDays,
    startOfDay: startOfDay,
    endOfDay: endOfDay,
    fromParts: fromParts,
    weekday: weekday,
    weekdayName: weekdayName,
    weekdayShort: weekdayShort,
    partOfDay: partOfDay,
    relative: relative,
    tzOffsetMin: tzOffsetMin,
    isValidDay: isValidDay,
    isSameDay: isSameDay,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
