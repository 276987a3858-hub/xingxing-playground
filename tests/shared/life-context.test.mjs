/* P1-a：生活时间上下文隔离测试（内存数据，不接触真实用户存储） */
import test from 'node:test';
import assert from 'node:assert/strict';
import '../../public/shared/life-clock.js';
import '../../public/shared/life-context.js';

const C = globalThis.LifeClock;
const LC = globalThis.LifeContext;

function presence(over) {
  return Object.assign({
    visitKind: 'fresh', navType: 'navigate', lastReturnFrom: null,
    lastVisitAt: null, lastActiveAt: null, lastInteractionAt: null, lastLeaveAt: null,
  }, over || {});
}

const NOW = new Date(2026, 10, 17, 21, 10).getTime(); // 2026-11-17 周二 21:10 本地

test('fresh 且没有互动 → 不注入，只给最简事实', () => {
  const s = LC.snapshot({ now: NOW, presence: presence(), events: [] });
  assert.equal(s.visitKind, 'fresh');
  assert.equal(LC.shouldInject(s), false);
  const text = LC.render(s);
  assert.ok(text.indexOf('没有聊过天') !== -1);
  assert.ok(text.indexOf('不必报时') !== -1);
});

test('returned + 昨天聊过 → 注入，且用自然粒度', () => {
  const s = LC.snapshot({
    now: NOW,
    presence: presence({ visitKind: 'returned', lastInteractionAt: NOW - 26 * 3600000, lastVisitAt: NOW - 40 * 3600000 }),
    events: [],
  });
  const text = LC.render(s);
  assert.equal(LC.shouldInject(s), true);
  assert.ok(text.indexOf('昨天') !== -1, text);
  assert.ok(!/\d+\s*分钟前/.test(text), '不得输出精确分钟');
});

test('从游乐场返回 → 明确指出来源', () => {
  const s = LC.snapshot({ now: NOW, presence: presence({ visitKind: 'returned', lastReturnFrom: 'playground' }), events: [] });
  assert.equal(s.fromPlayground, true);
  assert.ok(LC.render(s).indexOf('游乐场') !== -1);
});

test('刷新不当作重新进入', () => {
  const s = LC.snapshot({ now: NOW, presence: presence({ visitKind: 'refresh' }), events: [] });
  assert.ok(LC.render(s).indexOf('刷新') !== -1);
});

test('上次聊天与上次活跃严格区分', () => {
  const p = presence({ lastInteractionAt: NOW - 3 * 3600000, lastActiveAt: NOW - 60000 });
  const s = LC.snapshot({ now: NOW, presence: p, events: [] });
  assert.equal(s.lastInteractionAt, NOW - 3 * 3600000);
  assert.equal(s.lastActiveAt, NOW - 60000);
  const text = LC.render(s, { max: 400 });
  assert.ok(text.indexOf('和你说话是今天早些时候') !== -1, text);
  assert.ok(text.indexOf('刚刚') === -1, '不得把活跃时间说成聊天时间');
});

test('相对时长跨日/跨月/跨年', () => {
  assert.equal(C.relative(NOW - 30 * 1000, NOW).text, '刚刚');
  assert.equal(C.relative(NOW - 5 * 60000, NOW).text, '几分钟前');
  assert.equal(C.relative(NOW - 40 * 60000, NOW).text, '半小时前');
  assert.equal(C.relative(new Date(2026, 10, 17, 9, 0).getTime(), NOW).text, '今天早些时候');
  assert.equal(C.relative(new Date(2026, 10, 16, 21, 0).getTime(), NOW).text, '昨天');
  assert.equal(C.relative(new Date(2026, 10, 14, 21, 0).getTime(), NOW).text, '两三天前');
  assert.equal(C.relative(new Date(2026, 10, 9, 21, 0).getTime(), NOW).text, '上周');
  assert.equal(C.relative(new Date(2026, 9, 1, 21, 0).getTime(), NOW).text, '一个月前');
  assert.equal(C.relative(new Date(2025, 10, 17, 21, 0).getTime(), NOW).text, '很久以前');
});

test('中文星期与时段', () => {
  assert.equal(C.weekdayName(NOW), '周二');
  assert.equal(C.partOfDay(NOW), '晚上');
  assert.equal(C.partOfDay(new Date(2026, 10, 17, 3, 0).getTime()), '深夜');
});

test('没有事件时不生成事件清单', () => {
  const s = LC.snapshot({ now: NOW, presence: presence({ visitKind: 'returned', lastInteractionAt: NOW - 3 * 86400000 }), events: [] });
  assert.equal(s.hasEvents, false);
  assert.ok(LC.render(s).indexOf('这段时间') === -1);
});

test('有计划事件也不算发生', () => {
  const s = LC.snapshot({
    now: NOW,
    presence: presence({ visitKind: 'returned' }),
    events: [{ type: 'task.done', status: 'planned', at: NOW - 1000 }, { type: 'task.done', status: 'occurred', at: NOW - 2000 }],
  });
  assert.equal(s.events.counts['task.done'], 1);
  assert.ok(LC.render(s).indexOf('完成了1件事') !== -1);
});

test('隐私字段不会进入渲染结果', () => {
  const s = LC.snapshot({
    now: NOW,
    presence: presence({
      visitKind: 'returned',
      lastInteractionAt: NOW - 7200000,
      note: '痛经第二天', amount: 328.5, category: '餐饮', title: '洗头',
      sleepAt: NOW - 36000000, wakeAt: NOW - 20000000, cycle: 'day3', diary: '今天很难过',
    }),
    events: [{ type: 'tx.add', at: NOW - 1000, title: '炸鸡 328.5', amount: 328.5 }],
  });
  const text = LC.render(s, { max: 600 });
  for (const bad of ['痛经', '328', '洗头', '睡眠', '生理期', '难过', '炸鸡']) {
    assert.ok(text.indexOf(bad) === -1, `不得出现隐私内容：${bad}`);
  }
});

test('渲染长度受上限约束', () => {
  const s = LC.snapshot({
    now: NOW,
    presence: presence({ visitKind: 'returned', lastReturnFrom: 'playground', lastInteractionAt: NOW - 5 * 86400000, lastVisitAt: NOW - 6 * 86400000 }),
    events: [{ type: 'task.done', at: NOW - 1000 }, { type: 'vocab.round', at: NOW - 2000 }, { type: 'game.finish', at: NOW - 3000 }],
  });
  const text = LC.render(s);
  assert.ok(text.length <= 120, `超长：${text.length} → ${text}`);
  assert.ok(text.indexOf('不必报时') !== -1, '降级后仍须保留约束句');
});

/* ---------------- P4：严格 120 字上限 ---------------- */

test('最坏组合（访问+上次来访+事件+近况）仍不超过 120 字', () => {
  const s = LC.snapshot({
    now: NOW,
    presence: presence({
      visitKind: 'returned', lastReturnFrom: 'playground',
      lastVisitAt: NOW - 40 * 3600000, lastInteractionAt: NOW - 50 * 3600000,
    }),
    events: [
      { type: 'task.done', at: NOW - 3600000, source: 'butler' },
      { type: 'task.done', at: NOW - 7200000, source: 'butler' },
      { type: 'vocab.round', at: NOW - 600000, source: 'vocab' },
      { type: 'radio.episode', at: NOW - 900000, source: 'radio' },
      { type: 'reading.finish', at: NOW - 1200000, source: 'reading' },
      { type: 'game.finish', at: NOW - 1800000, source: 'playground' },
    ],
    state: { counts: { planned: 4, ongoing: 2, completed: 3, expired: 1 } },
  });
  const text = LC.render(s);
  assert.ok(text.length <= 120, `超长：${text.length} → ${text}`);
  assert.ok(text.indexOf('不必报时') !== -1, '压缩后仍保留约束句');
  assert.ok(text.indexOf('2026-11-17') !== -1, '压缩不得丢掉当前日期');
});

test('调用方给更大的 max 也不能突破 120', () => {
  const s = LC.snapshot({
    now: NOW,
    presence: presence({ visitKind: 'returned', lastInteractionAt: NOW - 26 * 3600000, lastVisitAt: NOW - 40 * 3600000 }),
    events: [{ type: 'task.done', at: NOW - 3600000, source: 'butler' }],
    state: { counts: { planned: 2, ongoing: 1, completed: 0, expired: 0 } },
  });
  assert.ok(LC.render(s, { max: 500 }).length <= 120);
});
