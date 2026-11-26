/* tests/shared/life-clock.test.mjs — S1 统一时间工具（纯函数，无存储、无网络） */
import test from 'node:test';
import assert from 'node:assert/strict';
import '../../public/shared/life-clock.js';

const LC = globalThis.LifeClock;
const pad = (n) => String(n).padStart(2, '0');

test('C01 formatDay 与房间 today() 输出逐字一致', () => {
  const d = new Date();
  const appStyle = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  assert.equal(LC.formatDay(), appStyle);
  assert.equal(LC.formatDay(d.getTime()), appStyle);
  // 与 app.js today() 同源实现，必须是 'YYYY-MM-DD'
  assert.match(LC.formatDay(), /^\d{4}-\d{2}-\d{2}$/);
});

test('C02 formatDateLong 与 dateText 语义一致（含年月日与星期）', () => {
  const out = LC.formatDateLong('2026-11-17');
  assert.match(out, /2026年11月17日/);
  assert.match(out, /星期二/);
  // 必须与 app.js 的写法等价：中午构造 + 同样的 locale 选项
  const appStyle = new Date('2026-11-17' + 'T12:00:00')
    .toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  assert.equal(out, appStyle);
});

test('C03 diffDays 按本地日历日计算（DST 临界日仍为 1）', () => {
  // 北美 2026 DST：3/8 开始、11/1 结束；无论运行在哪个时区都必须按日历日算
  assert.equal(LC.diffDays('2026-03-09', '2026-03-08'), 1);
  assert.equal(LC.diffDays('2026-11-02', '2026-11-01'), 1);
  // 跨夏令时区间的整段天数仍精确
  assert.equal(LC.diffDays('2026-11-01', '2026-03-08'), 238);
  // 同一时刻的时间戳与字符串混用
  assert.equal(LC.diffDays(LC.parseDay('2026-11-18'), '2026-11-17'), 1);
});

test('C04 diffDays 符号为 a-b', () => {
  assert.equal(LC.diffDays('2026-11-17', '2026-11-18'), -1);
  assert.equal(LC.diffDays('2026-11-17', '2026-11-17'), 0);
  assert.equal(LC.diffDays('2026-11-17', '2026-11-10'), 7);
});

test('C05 addDays 跨年', () => {
  assert.equal(LC.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(LC.addDays('2026-01-01', -1), '2025-12-31');
});

test('C06 addDays 跨月与闰年', () => {
  assert.equal(LC.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(LC.addDays('2028-03-01', -1), '2028-02-29');
  assert.equal(LC.addDays('2026-11-17', 30), '2026-12-17');
});

test('C07 fromParts 使用本地 Date 构造，与 new Date(y,m,d,h,mi) 严格相等', () => {
  assert.equal(LC.fromParts('2026-11-17', '19:30'), new Date(2026, 10, 17, 19, 30, 0, 0).getTime());
  assert.equal(LC.fromParts('2026-11-17', '9:05'), new Date(2026, 10, 17, 9, 5, 0, 0).getTime());
  assert.equal(LC.formatClock(LC.fromParts('2026-11-17', '19:30')), '19:30');
});

test('C08 fromParts 非法时间返回 null，不抛', () => {
  assert.equal(LC.fromParts('2026-11-17', '24:00'), null);
  assert.equal(LC.fromParts('2026-11-17', '19:60'), null);
  assert.equal(LC.fromParts('2026-11-17', 'abc'), null);
  assert.equal(LC.fromParts('2026-11-17', ''), null);
  assert.equal(LC.fromParts('2026-13-01', '19:30'), null);
  assert.equal(LC.fromParts('2026-02-30', '19:30'), null);
});

test('C09 parseDay 严格校验，拒绝非法与归一化日期', () => {
  assert.equal(LC.parseDay('2026-13-01'), null);
  assert.equal(LC.parseDay('2026-11-31'), null);
  assert.equal(LC.parseDay('2026-02-30'), null);
  assert.equal(LC.parseDay('2026-2-3'), null);
  assert.equal(LC.parseDay(undefined), null);
  assert.equal(LC.parseDay(null), null);
  assert.equal(LC.parseDay(12345), null);
  assert.equal(LC.parseDay('2026-02-28'), new Date(2026, 1, 28, 0, 0, 0, 0).getTime());
  // 必须是本地 00:00，不是 UTC
  assert.equal(new Date(LC.parseDay('2026-11-17')).getHours(), 0);
});

test('C10 startOfDay / endOfDay 为本地日界', () => {
  const t = new Date(2026, 10, 17, 15, 42, 7, 321).getTime();
  const start = LC.startOfDay(t);
  const end = LC.endOfDay(t);
  assert.equal(end - start, 86399999);
  assert.equal(new Date(start).getDate(), 17);
  assert.equal(new Date(start).getHours(), 0);
  assert.equal(new Date(end).getMinutes(), 59);
  assert.equal(LC.startOfDay('2026-12-31'), LC.parseDay('2026-12-31'));
});

test('C11 tzOffsetMin 东正西负（与原生符号相反）', () => {
  const nativeOffset = new Date().getTimezoneOffset();
  assert.equal(LC.tzOffsetMin(), -nativeOffset);
  // 东八区 = +480；这里不写死时区，只校验符号与量级
  assert.equal(typeof LC.tzOffsetMin(), 'number');
  assert.ok(Math.abs(LC.tzOffsetMin()) <= 14 * 60);
  if (nativeOffset < 0) assert.ok(LC.tzOffsetMin() > 0, '东半球必须为正');
  if (nativeOffset > 0) assert.ok(LC.tzOffsetMin() < 0, '西半球必须为负');
});

test('C12 weekday 支持日期字符串与时间戳', () => {
  assert.equal(LC.weekday('2026-11-17'), 2); // 周二
  assert.equal(LC.weekday('2026-11-15'), 0); // 周日
  assert.equal(LC.weekday(new Date(2026, 10, 17, 23, 59).getTime()), 2);
  assert.equal(LC.weekday('2026-13-01'), null);
});

test('C13 isSameDay / isValidDay', () => {
  const a = new Date(2026, 10, 17, 0, 1).getTime();
  const b = new Date(2026, 10, 17, 23, 59).getTime();
  const c = new Date(2026, 10, 18, 0, 0).getTime();
  assert.equal(LC.isSameDay(a, b), true);
  assert.equal(LC.isSameDay(a, c), false);
  assert.equal(LC.isSameDay('2026-11-17', b), true);
  assert.equal(LC.isSameDay(null, b), false);
  assert.equal(LC.isValidDay('2026-11-17'), true);
  assert.equal(LC.isValidDay('2026-11-31'), false);
  assert.equal(LC.isValidDay('2026-1-1'), false);
});

test('C14 formatStamp / formatClock 补零，非法输入统一返回 null', () => {
  const t = new Date(2026, 10, 17, 9, 5, 3).getTime();
  assert.equal(LC.formatClock(t), '09:05');
  assert.equal(LC.formatStamp(t), '2026-11-17 09:05');
  for (const bad of [null, NaN, '', {}, [], 'abc']) {
    assert.equal(LC.formatDay(bad), null, 'formatDay(' + String(bad) + ')');
    assert.equal(LC.formatClock(bad), null);
    assert.equal(LC.formatStamp(bad), null);
    assert.equal(LC.parseDay(bad), null);
    assert.equal(LC.addDays(bad, 1), null);
    assert.equal(LC.diffDays(bad, '2026-11-17'), null);
    assert.equal(LC.weekday(bad), null);
    assert.equal(LC.tzOffsetMin(bad), null);
    assert.equal(LC.startOfDay(bad), null);
    assert.equal(LC.endOfDay(bad), null);
    assert.equal(LC.formatDateLong(bad), null);
  }
  assert.equal(LC.addDays('2026-11-17', NaN), null);
});
