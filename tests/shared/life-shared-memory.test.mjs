/* P5.2 第一阶段：共同记忆最小接入（结构化游戏经历 + 珍藏低权重候选），纯内存存储、不调 AI */
import test from 'node:test';
import assert from 'node:assert/strict';

import '../../public/shared/life-clock.js';
import '../../public/shared/life-events.js';

const LE = globalThis.LifeEvents;
const NOW = new Date(2026, 10, 17, 21, 0).getTime();
const DAY = 86400000;

function mem(seed) {
  const m = new Map(Object.entries(seed || {}));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _m: m,
  };
}
function fresh() {
  const st = mem();
  globalThis.localStorage = st;
  LE._reset(); LE._setStorage({ local: st });
  return st;
}

// 与 app.js 落库后的写法保持一致：id 用消息 id → 天然去重
function recordSharedGame(msgId, name, at, gameId) {
  return LE.record({
    id: 'game:shared:' + msgId,
    at: at,
    source: 'playground',
    type: 'game.shared',
    title: name || '',
    meta: { game: gameId || '' },
  });
}

test('S01 游戏消息落库后记录一次 game.shared，可被回忆选材识别为「一起玩过」', () => {
  fresh();
  const at = NOW - 2 * DAY;
  const r = recordSharedGame(101, '德语小游戏', at, 'german');
  assert.equal(r.ok, true);
  assert.equal(r.added, true);
  const c = LE.pickRecall({ now: NOW });
  assert.ok(c, '应选出候选');
  assert.equal(c.kind, 'game');
  assert.equal(c.origin, 'event');
  assert.equal(c.label, '德语小游戏');
  assert.match(c.text, /你们一起玩过「德语小游戏」/);
});

test('S02 同一条消息重复消费不会重复记录', () => {
  fresh();
  const at = NOW - 2 * DAY;
  recordSharedGame(202, '星光拼图', at, 'puzzle');
  const again = recordSharedGame(202, '星光拼图', at, 'puzzle');
  assert.equal(again.added, false);
  assert.equal(again.reason, 'duplicate');
  assert.equal(LE.list().filter((x) => x.type === 'game.shared').length, 1);
});

test('S03 没有游戏名/没有 game 元数据时不产生可提起的回忆', () => {
  fresh();
  const at = NOW - 2 * DAY;
  recordSharedGame(303, '', at, '');
  const c = LE.pickRecall({ now: NOW });
  assert.equal(c, null, '空标题不得编造出「一起玩过」');
});

test('S04 今天才发生的游戏不算「回忆」（至少 1 天前）', () => {
  fresh();
  recordSharedGame(404, '月下约会', NOW - 60000, 'date');
  assert.equal(LE.pickRecall({ now: NOW }), null);
});

test('S05 珍藏只取标题与时间作最低权重候选，且措辞不是共同经历', () => {
  fresh();
  const keeps = [{ id: 'k1', title: '那天的海', at: NOW - 5 * DAY }];
  const c = LE.pickRecall({ now: NOW, keeps });
  assert.ok(c, '只有珍藏时也能作为候选');
  assert.equal(c.origin, 'keep');
  assert.equal(c.kind, 'keep');
  assert.match(c.text, /她把「那天的海」收进了珍藏/);
  assert.doesNotMatch(c.text, /你们一起|一起玩过|一起做过/);
});

test('S06 珍藏正文不会被选材读到（候选只由传入的 title/at 组成）', () => {
  fresh();
  const keeps = [{ id: 'k2', title: '一把伞', at: NOW - 4 * DAY, content: '这是私人正文，不该出现在任何提示里', status: 'saved' }];
  const c = LE.pickRecall({ now: NOW, keeps });
  assert.ok(c);
  assert.doesNotMatch(c.text, /私人正文/);
  assert.equal(JSON.stringify(c).includes('私人正文'), false);
});

test('S07 没有标题或没有时间的珍藏直接跳过（不猜、不编）', () => {
  fresh();
  assert.equal(LE.pickRecall({ now: NOW, keeps: [{ id: 'k3', title: '' , at: NOW - 3 * DAY }] }), null);
  assert.equal(LE.pickRecall({ now: NOW, keeps: [{ id: 'k4', title: '有标题没时间' }] }), null);
});

test('S08 同时有真实事件时优先事件，珍藏不会被当成共同经历优先提起', () => {
  fresh();
  recordSharedGame(505, '厨房大危机', NOW - 3 * DAY, 'kitchen');
  const keeps = [{ id: 'k5', title: '一张票根', at: NOW - 2 * DAY }];
  const c = LE.pickRecall({ now: NOW, keeps });
  assert.equal(c.origin, 'event');
  assert.equal(c.kind, 'game');
  assert.match(c.text, /你们一起玩过/);
});

test('S09 珍藏候选被提起后进入去重记录，不会反复念同一件', () => {
  fresh();
  const keeps = [{ id: 'k6', title: '旧车票', at: NOW - 6 * DAY }];
  const first = LE.pickRecall({ now: NOW, keeps });
  assert.ok(first);
  LE.markRecalled(first.id, first.type, NOW);
  assert.equal(LE.pickRecall({ now: NOW, keeps }), null);
});

test('S10 前端不会把传奇珍藏写成 game 类型（来源可区分）', () => {
  fresh();
  const c = LE.pickRecall({ now: NOW, keeps: [{ id: 'k7', title: '一起看过的电影票', at: NOW - 7 * DAY }] });
  assert.ok(c);
  assert.equal(c.type, 'keep.saved');
  assert.equal(c.origin, 'keep');
});
