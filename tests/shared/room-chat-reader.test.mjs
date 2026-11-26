/* tests/shared/room-chat-reader.test.mjs — 历史聊天只读读取适配器（P1.5）
 * 覆盖：升序分批 / afterId 续读不重不漏 / limit 与 maxChars 边界 / 空库与末尾 done /
 *       单条超长不死循环 / 不返回媒体字段 / getById 与 hasMessage / 读取失败不伪装成空结果。
 * 纯 Node：用假 messages 仓库驱动真实模块代码，不打开任何真实 IndexedDB，不碰用户数据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import '../../public/shared/room-chat-reader.js';

const R = globalThis.RoomChatReader;
const T = 1795000000000;

/** 真实消息带的大媒体字段：读取结果里绝不能出现 */
function msg(id, content, extra) {
  return Object.assign({
    id,
    role: id % 2 === 1 ? 'user' : 'assistant',
    content,
    time: T + id * 1000,
    image: 'data:image/jpeg;base64,AAAABBBBCCCC',
    audioData: 'data:audio/mp3;base64,DDDDEEEEFFFF',
    englishContent: 'english text',
  }, extra || {});
}

/* ---------------- 假 IndexedDB：只实现本模块用到的三个入口 ---------------- */

function fakeStore(list, state) {
  return {
    openCursor(range, direction) {
      const req = { onsuccess: null, onerror: null, result: null };
      queueMicrotask(() => {
        if (state.failCursor) { if (req.onerror) req.onerror(); return; }
        // 假后端必须同时支持 lowerBound / upperBound 的开区间，以及 'prev' 方向。
        // 只实现升序会让倒序测试「通过」在错误的实现上，比不测更危险。
        const desc = direction === 'prev';
        let rows = list.slice().sort((a, b) => a.id - b.id);
        if (range) {
          if (range.lower !== undefined) rows = rows.filter((r) => (range.open ? r.id > range.lower : r.id >= range.lower));
          if (range.upper !== undefined) rows = rows.filter((r) => (range.open ? r.id < range.upper : r.id <= range.upper));
        }
        if (desc) rows.reverse();
        let i = 0;
        const step = () => {
          if (i >= rows.length) { req.result = null; if (req.onsuccess) req.onsuccess(); return; }
          const row = rows[i++];
          req.result = {
            primaryKey: row.id,
            value: row,
            continue: () => queueMicrotask(step),
          };
          if (req.onsuccess) req.onsuccess();
        };
        step();
      });
      return req;
    },
    get(id) {
      const req = { onsuccess: null, onerror: null, result: undefined };
      queueMicrotask(() => {
        if (state.failGet) { if (req.onerror) req.onerror(); return; }
        req.result = list.find((r) => r.id === id);
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
    count(id) {
      const req = { onsuccess: null, onerror: null, result: 0 };
      queueMicrotask(() => {
        if (state.failCount) { if (req.onerror) req.onerror(); return; }
        req.result = list.filter((r) => r.id === id).length;
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
  };
}

function fakeDb(list, state) {
  return {
    transaction() {
      return { objectStore: () => fakeStore(list, state) };
    },
  };
}

/** 造一个只连假库的 reader；state 可中途翻转以模拟读失败 */
function readerFor(list, opts) {
  const o = opts || {};
  const state = {
    failOpen: !!o.failOpen,
    failCursor: !!o.failCursor,
    failGet: !!o.failGet,
    failCount: !!o.failCount,
  };
  const reader = R._create({
    open: () => (state.failOpen
      ? Promise.reject(new Error('open boom'))
      : Promise.resolve(fakeDb(list, state))),
    keyRange: {
      lowerBound: (lower, open) => ({ lower, open: !!open }),
      upperBound: (upper, open) => ({ upper, open: !!open }),
    },
  });
  return { reader, state };
}

/** 一直读到 done，顺带断言每批都是成功结果 */
async function readAll(reader, opts) {
  const out = [];
  let afterId = (opts && opts.afterId) || 0;
  for (let i = 0; i < 100; i++) {
    const res = await reader.readBatch(Object.assign({}, opts, { afterId }));
    assert.equal(res.ok, true, '分批读取应当成功');
    assert.equal(res.messages !== null, true, '成功批次必须有 messages 数组');
    out.push(res);
    if (res.done) return out;
    assert.ok(res.nextAfterId > afterId || res.messages.length > 0, '游标必须前进');
    afterId = res.nextAfterId;
  }
  throw new Error('读取没有收敛，可能死循环');
}

/** 一直倒序读到 done；顺带断言每批都是成功结果、空批必须已经 done */
async function readAllBefore(reader, opts) {
  const out = [];
  let beforeId = (opts && opts.beforeId != null) ? opts.beforeId : null;
  for (let i = 0; i < 100; i++) {
    const res = await reader.readBatchBefore(Object.assign({}, opts, { beforeId }));
    assert.equal(res.ok, true, '倒序分批读取应当成功');
    assert.equal(res.messages !== null, true, '成功批次必须有 messages 数组');
    assert.equal(res.direction, 'prev', '倒序批次必须自报方向');
    assert.equal(res.nextAfterId, undefined, '倒序绝不能带 nextAfterId');
    out.push(res);
    if (res.done) return out;
    assert.ok(res.messages.length > 0, '未 done 却给空批，说明倒序游标没有前进');
    beforeId = res.nextBeforeId;
  }
  throw new Error('倒序读取没有收敛，可能死循环');
}

/* ---------------- R01 升序分批 ---------------- */
test('R01 按 id 升序分批，返回结构与默认值正确', async () => {
  const list = [3, 1, 5, 2, 4].map((id) => msg(id, '内容' + id));
  const { reader } = readerFor(list);
  const batches = await readAll(reader, { limit: 2 });

  const ids = batches.flatMap((b) => b.messages.map((m) => m.id));
  assert.deepEqual(ids, [1, 2, 3, 4, 5], '严格升序且不重复');
  assert.equal(batches[0].messages.length, 2);
  assert.equal(batches[0].nextAfterId, 2);
  assert.equal(batches[0].done, false);
  assert.equal(batches[batches.length - 1].done, true);

  assert.equal(reader.DEFAULTS.limit, 80);
  assert.equal(reader.DEFAULTS.maxChars, 12000);
  assert.equal(reader.DB_NAME, 'star_fifi_room');
  assert.equal(reader.STORE, 'messages');
});

/* ---------------- R02 afterId 续读 ---------------- */
test('R02 afterId 续读不重复、不遗漏（开区间）', async () => {
  const list = Array.from({ length: 7 }, (_, i) => msg(i + 1, '第' + (i + 1) + '条'));
  const { reader } = readerFor(list);

  const first = await reader.readBatch({ afterId: 0, limit: 3 });
  assert.deepEqual(first.messages.map((m) => m.id), [1, 2, 3]);
  assert.equal(first.nextAfterId, 3);

  const second = await reader.readBatch({ afterId: 3, limit: 3 });
  assert.deepEqual(second.messages.map((m) => m.id), [4, 5, 6], '不重复第一条之后的边界消息');

  const third = await reader.readBatch({ afterId: 6, limit: 3 });
  assert.deepEqual(third.messages.map((m) => m.id), [7]);
  assert.equal(third.done, true);

  // 数字字符串同样可用：机自述 source.messageId 可能存的是字符串
  const asString = await reader.readBatch({ afterId: '2', limit: 2 });
  assert.deepEqual(asString.messages.map((m) => m.id), [3, 4]);
});

/* ---------------- R03 limit 边界 ---------------- */
test('R03 limit 边界：1 条、非法值、超大值截断', async () => {
  const list = Array.from({ length: 4 }, (_, i) => msg(i + 1, 'x'));
  const { reader } = readerFor(list);

  const one = await reader.readBatch({ limit: 1 });
  assert.equal(one.messages.length, 1);

  for (const bad of [0, -1, 1.5, 'many', NaN]) {
    const res = await reader.readBatch({ limit: bad });
    assert.equal(res.ok, false, 'limit=' + bad + ' 必须拒绝');
    assert.equal(res.reason, 'bad-params');
    assert.equal(res.messages, null, '失败不能伪装成空批次');
    assert.equal(res.done, false, '失败不能伪装成扫描完成');
  }

  const huge = await reader.readBatch({ limit: 9999 });
  assert.equal(huge.ok, true);
  assert.equal(huge.limit, R.DEFAULTS.maxLimit, '超过硬上限按上限截断');

  const negAfter = await reader.readBatch({ afterId: -5 });
  assert.equal(negAfter.ok, false);
  assert.equal(negAfter.reason, 'bad-params');
});

/* ---------------- R04 maxChars 边界 ---------------- */
test('R04 maxChars 生效：每批字符不超预算，且不会因为预算为 0 卡死', async () => {
  const list = [1, 2, 3].map((id) => msg(id, '123456'));   // 每条 6 字符
  const { reader } = readerFor(list);

  const b1 = await reader.readBatch({ maxChars: 10 });
  assert.deepEqual(b1.messages.map((m) => m.id), [1], '6+6 超 10，只放第一条');
  assert.equal(b1.chars, 6);
  assert.equal(b1.done, false);

  const b2 = await reader.readBatch({ afterId: 1, maxChars: 10 });
  assert.deepEqual(b2.messages.map((m) => m.id), [2]);

  const bad = await reader.readBatch({ maxChars: 0 });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'bad-params');
  assert.equal(bad.messages, null);
});

/* ---------------- R05 空库与末尾 ---------------- */
test('R05 空库与末尾：空数组 + done=true，不是错误', async () => {
  const { reader } = readerFor([]);
  const res = await reader.readBatch({ afterId: 0 });
  assert.equal(res.ok, true);
  assert.deepEqual(res.messages, []);
  assert.equal(res.done, true);
  assert.equal(res.nextAfterId, 0);

  const list = [msg(1, 'a'), msg(2, 'b')];
  const r2 = readerFor(list).reader;
  const beyond = await r2.readBatch({ afterId: 999 });
  assert.equal(beyond.ok, true);
  assert.deepEqual(beyond.messages, []);
  assert.equal(beyond.done, true, 'afterId 超出末尾应直接判定扫完');
  assert.equal(beyond.nextAfterId, 999, 'nextAfterId 不能倒退');
});

/* ---------------- R06 单条超长 ---------------- */
test('R06 单条超过 maxChars 时仍然返回它并前进，不产生死循环', async () => {
  const long = 'A'.repeat(50000);
  const list = [msg(1, long), msg(2, '短句')];
  const { reader } = readerFor(list);

  const first = await reader.readBatch({ afterId: 0, maxChars: 100 });
  assert.equal(first.ok, true);
  assert.equal(first.messages.length, 1, '超预算的单条也必须带上，否则游标无法前进');
  assert.equal(first.messages[0].id, 1);
  assert.equal(first.oversized, true, '标记本批为超预算批次');
  assert.equal(first.done, false);
  assert.equal(first.nextAfterId, 1);

  const second = await reader.readBatch({ afterId: first.nextAfterId, maxChars: 100 });
  assert.deepEqual(second.messages.map((m) => m.id), [2]);
  assert.equal(second.done, true);

  const third = await reader.readBatch({ afterId: 2, maxChars: 100 });
  assert.equal(third.done, true);
  assert.deepEqual(third.messages, []);
});

/* ---------------- R07 不返回媒体字段 ---------------- */
test('R07 只投影 8 个字段，图片与音频 base64 一律不下发', async () => {
  const list = [msg(1, '带图带语音', { source: 'chat-silent', sourceId: 7, silent: true, type: 'voice' })];
  const { reader } = readerFor(list);
  const res = await reader.readBatch({ limit: 10 });
  const m = res.messages[0];

  assert.deepEqual(Object.keys(m).sort(),
    ['content', 'id', 'role', 'silent', 'source', 'sourceId', 'time', 'type']);
  assert.equal('image' in m, false);
  assert.equal('audioData' in m, false);
  assert.equal('englishContent' in m, false);
  assert.equal(m.source, 'chat-silent');
  assert.equal(m.sourceId, 7);
  assert.equal(m.silent, true);
  assert.equal(m.type, 'voice');

  // 投影函数本身也不带媒体字段
  const p = R._project(msg(9, 'x'));
  assert.equal('image' in p, false);
  assert.equal('audioData' in p, false);
});

/* ---------------- R08 getById ---------------- */
test('R08 getById：存在 / 数字字符串 / 不存在 / 非法 ID', async () => {
  const list = [msg(3, '她说不喜欢被安排')];
  const { reader } = readerFor(list);

  const hit = await reader.getById(3);
  assert.equal(hit.ok, true);
  assert.equal(hit.exists, true);
  assert.equal(hit.message.id, 3);
  assert.equal(hit.message.content, '她说不喜欢被安排');
  assert.equal('image' in hit.message, false);
  assert.equal('audioData' in hit.message, false);

  const byString = await reader.getById('3');
  assert.equal(byString.exists, true);
  assert.equal(byString.message.id, 3, '字符串 ID 必须能定位到同一条消息');

  const padded = await reader.getById('003');
  assert.equal(padded.exists, true, '前导零不应导致匹配失败');

  const miss = await reader.getById(999);
  assert.equal(miss.ok, true);
  assert.equal(miss.exists, false);
  assert.equal(miss.reason, 'not-found');
  assert.equal(miss.message, null);

  for (const bad of ['abc', '', null, undefined, 1.5, {}]) {
    const res = await reader.getById(bad);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'bad-params');
    assert.equal(res.exists, false);
  }
});

/* ---------------- R09 hasMessage ---------------- */
test('R09 hasMessage：只判存在性，不存在明确为 false', async () => {
  const { reader } = readerFor([msg(1, 'a'), msg(2, 'b')]);

  assert.equal((await reader.hasMessage(1)).exists, true);
  assert.equal((await reader.hasMessage('2')).exists, true);

  const gone = await reader.hasMessage(99);
  assert.equal(gone.ok, true);
  assert.equal(gone.exists, false);
  assert.equal(gone.reason, 'not-found');

  const bad = await reader.hasMessage('x');
  assert.equal(bad.ok, false);
  assert.equal(bad.exists, false);
});

/* ---------------- R10 读取失败不伪装 ---------------- */
test('R10 读取失败必须明确报错，不能变成空批次或 done', async () => {
  const openFail = readerFor([msg(1, 'a')], { failOpen: true }).reader;
  const a = await openFail.readBatch({});
  assert.equal(a.ok, false);
  assert.equal(a.reason, 'open-failed');
  assert.equal(a.messages, null);
  assert.equal(a.done, false);

  const cursorFail = readerFor([msg(1, 'a')], { failCursor: true }).reader;
  const b = await cursorFail.readBatch({});
  assert.equal(b.ok, false);
  assert.equal(b.reason, 'read-failed');
  assert.equal(b.messages, null, '读失败时 messages 必须是 null，不能是空数组');
  assert.equal(b.done, false);

  const getFail = readerFor([msg(1, 'a')], { failGet: true }).reader;
  const c = await getFail.getById(1);
  assert.equal(c.ok, false);
  assert.equal(c.exists, false, '读失败不能报告为「不存在」以外的任何结论');

  const countFail = readerFor([msg(1, 'a')], { failCount: true }).reader;
  const d = await countFail.hasMessage(1);
  assert.equal(d.ok, false);
  assert.equal(d.exists, false);

  // 同步抛错的连接（不是 rejected promise）也必须变成明确失败，而不是把异常抛给调用方
  const syncThrow = R._create({
    open: () => { throw new Error('sync boom'); },
    keyRange: {
      lowerBound: (lower, open) => ({ lower, open: !!open }),
      upperBound: (upper, open) => ({ upper, open: !!open }),
    },
  });
  const e = await syncThrow.readBatch({});
  assert.equal(e.ok, false);
  assert.equal(e.reason, 'open-failed');
  assert.equal(e.messages, null);
  assert.equal(e.done, false);
});

/* ---------------- R11 不看全量、不碰媒体、不依赖页面 ---------------- */
test('R11 源码级边界：不用 getAll、不依赖 chatHistory、不直接操作页面', () => {
  const src = readFileSync(new URL('../../public/shared/room-chat-reader.js', import.meta.url), 'utf8');
  // 先剥掉注释：边界说明里会提到「不调用 getAll()」，不能把注释算成调用
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  assert.equal(/\bgetAll\s*\(/.test(code), false, '不得使用 getAll()');
  assert.equal(/chatHistory/.test(code), false, '不得依赖 app.js 的内存数组');
  assert.equal(/document\./.test(code), false, '不得直接操作 DOM');
  assert.equal(/localStorage/.test(code), false, '不得读写 localStorage');
  assert.equal(/\.put\s*\(|\.add\s*\(|\.delete\s*\(|\.clear\s*\(/.test(code), false, '只读：不得有写操作');
  assert.ok(/lowerBound\(/.test(code), '必须用 lowerBound 做开区间续读');
});

/* ==================================================================
 * 阶段二 A：倒序读取（readBatchBefore）
 * 方向只能由公开接口内部固定，外部无法覆盖，因此不测 direction 入参。
 * ================================================================== */

/* ---------------- P01 倒序起点与顺序 ---------------- */
test('P01 倒序从最大 ID 开始，严格降序', async () => {
  const list = [3, 1, 5, 2, 4].map((id) => msg(id, '内容' + id));
  const { reader } = readerFor(list);
  const batches = await readAllBefore(reader, { limit: 2 });

  const ids = batches.flatMap((b) => b.messages.map((m) => m.id));
  assert.deepEqual(ids, [5, 4, 3, 2, 1], '严格降序且不重复');
  assert.deepEqual(batches[0].messages.map((m) => m.id), [5, 4], '首批必须从最大主键开始');
  assert.equal(batches[0].nextBeforeId, 4);
  assert.equal(batches[0].done, false);
  assert.equal(batches[batches.length - 1].done, true);
});

/* ---------------- P02 beforeId 连续分页 ---------------- */
test('P02 beforeId 连续分页不重复、不遗漏（开区间）', async () => {
  const list = Array.from({ length: 7 }, (_, i) => msg(i + 1, '第' + (i + 1) + '条'));
  const { reader } = readerFor(list);

  const first = await reader.readBatchBefore({ beforeId: null, limit: 3 });
  assert.deepEqual(first.messages.map((m) => m.id), [7, 6, 5]);
  assert.equal(first.nextBeforeId, 5);
  assert.equal(first.direction, 'prev');

  const second = await reader.readBatchBefore({ beforeId: 5, limit: 3 });
  assert.deepEqual(second.messages.map((m) => m.id), [4, 3, 2], '不含边界消息 5');

  const third = await reader.readBatchBefore({ beforeId: 2, limit: 3 });
  assert.deepEqual(third.messages.map((m) => m.id), [1]);
  assert.equal(third.done, true);

  // 全量收一遍，确认既不重复也不遗漏
  const all = (await readAllBefore(reader, { limit: 3 })).flatMap((b) => b.messages.map((m) => m.id));
  assert.deepEqual(all, [7, 6, 5, 4, 3, 2, 1]);

  // 数字字符串同样可用，与升序 afterId 的宽松度一致
  const asString = await reader.readBatchBefore({ beforeId: '5', limit: 2 });
  assert.deepEqual(asString.messages.map((m) => m.id), [4, 3]);
});

/* ---------------- P03 beforeId 非法值 ---------------- */
test('P03 beforeId 为 0、负数、非整数、非法字符串时返回 bad-params', async () => {
  const list = [msg(1, 'a'), msg(2, 'b'), msg(3, 'c')];
  const { reader } = readerFor(list);

  for (const bad of [0, -1, 1.5, 'abc', '', '  ', {}, NaN, []] ) {
    const res = await reader.readBatchBefore({ beforeId: bad });
    assert.equal(res.ok, false, 'beforeId=' + String(bad) + ' 必须拒绝');
    assert.equal(res.reason, 'bad-params');
    assert.equal(res.messages, null, '非法值绝不能静默变成「首批读取」');
    assert.equal(res.done, false, '非法值不能伪装成扫描完成');
  }

  // 对照组：不传 / null 才是「从最新开始」
  const fromNewest = await reader.readBatchBefore({});
  assert.equal(fromNewest.ok, true);
  assert.deepEqual(fromNewest.messages.map((m) => m.id), [3, 2, 1]);
});

/* ---------------- P04 空库 ---------------- */
test('P04 空库返回空数组并 done:true', async () => {
  const { reader } = readerFor([]);
  const res = await reader.readBatchBefore({});
  assert.equal(res.ok, true);
  assert.deepEqual(res.messages, []);
  assert.equal(res.done, true);
  assert.equal(res.nextBeforeId, null, '空库首批没有可续读的锚点');
  assert.equal(res.direction, 'prev');
});

/* ---------------- P05 单条记录 ---------------- */
test('P05 单条记录正常收敛，不产生死循环', async () => {
  const { reader } = readerFor([msg(1, '只有这一条')]);

  const first = await reader.readBatchBefore({ limit: 10 });
  assert.deepEqual(first.messages.map((m) => m.id), [1]);
  assert.equal(first.nextBeforeId, 1);
  assert.equal(first.done, true, '游标耗尽必须同批报告 done');

  const batches = await readAllBefore(reader, { limit: 10 });
  assert.equal(batches.length, 1, '单条记录一批就该收敛');
});

/* ---------------- P06 limit 与硬上限 ---------------- */
test('P06 倒序下 limit 与最大 500 条限制正确', async () => {
  const list = Array.from({ length: 4 }, (_, i) => msg(i + 1, 'x'));
  const { reader } = readerFor(list);

  const one = await reader.readBatchBefore({ limit: 1 });
  assert.equal(one.messages.length, 1);
  assert.equal(one.messages[0].id, 4);

  for (const bad of [0, -1, 1.5, 'many', NaN]) {
    const res = await reader.readBatchBefore({ limit: bad });
    assert.equal(res.ok, false, 'limit=' + bad + ' 必须拒绝');
    assert.equal(res.reason, 'bad-params');
    assert.equal(res.messages, null);
    assert.equal(res.done, false);
  }

  const huge = await reader.readBatchBefore({ limit: 9999 });
  assert.equal(huge.ok, true);
  assert.equal(huge.limit, R.DEFAULTS.maxLimit, '倒序同样按硬上限截断');
});

/* ---------------- P07 倒序 maxChars ---------------- */
test('P07 倒序下 maxChars 预算生效', async () => {
  const list = [1, 2, 3].map((id) => msg(id, '123456'));   // 每条 6 字符
  const { reader } = readerFor(list);

  const b1 = await reader.readBatchBefore({ maxChars: 10 });
  assert.deepEqual(b1.messages.map((m) => m.id), [3], '6+6 超 10，只放最新的那条');
  assert.equal(b1.chars, 6);
  assert.equal(b1.done, false);

  const b2 = await reader.readBatchBefore({ beforeId: 3, maxChars: 10 });
  assert.deepEqual(b2.messages.map((m) => m.id), [2]);

  const bad = await reader.readBatchBefore({ maxChars: 0 });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'bad-params');
  assert.equal(bad.messages, null);
});

/* ---------------- P08 倒序单条超预算 ---------------- */
test('P08 倒序下单条超预算仍能推进，不重复不死循环', async () => {
  const long = 'A'.repeat(50000);
  const list = [msg(1, '短句'), msg(2, long)];   // 倒序先读到超长的那条
  const { reader } = readerFor(list);

  const first = await reader.readBatchBefore({ maxChars: 100 });
  assert.equal(first.ok, true);
  assert.equal(first.messages.length, 1, '超预算的单条也必须带上，否则游标无法前进');
  assert.equal(first.messages[0].id, 2);
  assert.equal(first.oversized, true);
  assert.equal(first.done, false);
  assert.equal(first.nextBeforeId, 2);

  const second = await reader.readBatchBefore({ beforeId: first.nextBeforeId, maxChars: 100 });
  assert.deepEqual(second.messages.map((m) => m.id), [1]);
  assert.equal(second.done, true);

  const third = await reader.readBatchBefore({ beforeId: 1, maxChars: 100 });
  assert.equal(third.done, true);
  assert.deepEqual(third.messages, []);
});

/* ---------------- P09 倒序失败不伪装 ---------------- */
test('P09 倒序 failOpen / failCursor 返回统一 failure', async () => {
  const openFail = readerFor([msg(1, 'a')], { failOpen: true }).reader;
  const a = await openFail.readBatchBefore({});
  assert.equal(a.ok, false);
  assert.equal(a.reason, 'open-failed');
  assert.equal(a.messages, null);
  assert.equal(a.done, false);

  const cursorFail = readerFor([msg(1, 'a')], { failCursor: true }).reader;
  const b = await cursorFail.readBatchBefore({});
  assert.equal(b.ok, false);
  assert.equal(b.reason, 'read-failed');
  assert.equal(b.messages, null, '读失败时 messages 必须是 null，不能是空数组');
  assert.equal(b.done, false);

  // 失败形状必须与升序完全一致（同一套 failure），不额外长出新字段
  assert.deepEqual(Object.keys(b).sort(), Object.keys(a).sort());
});

/* ---------------- P10 倒序字段白名单 ---------------- */
test('P10 倒序结果不包含 image、audioData 等非白名单字段', async () => {
  const list = [msg(1, '带图带语音', { source: 'chat-silent', sourceId: 7, silent: true, type: 'voice' })];
  const { reader } = readerFor(list);
  const res = await reader.readBatchBefore({ limit: 10 });
  const m = res.messages[0];

  assert.deepEqual(Object.keys(m).sort(),
    ['content', 'id', 'role', 'silent', 'source', 'sourceId', 'time', 'type']);
  assert.equal('image' in m, false);
  assert.equal('audioData' in m, false);
  assert.equal('englishContent' in m, false);
  assert.equal(res.direction, 'prev');
});

/* ---------------- P11 升序兼容 ---------------- */
test('P11 原 readBatch 不传方向时升序行为与改动前一致', async () => {
  const list = [3, 1, 5, 2, 4].map((id) => msg(id, '内容' + id));
  const { reader } = readerFor(list);

  const res = await reader.readBatch({ limit: 2 });
  assert.deepEqual(res.messages.map((m) => m.id), [1, 2], '仍是升序');
  assert.equal(res.nextAfterId, 2, '仍是 nextAfterId');
  assert.equal('nextBeforeId' in res, false, '升序结果不能长出倒序字段');
  assert.equal(res.direction, 'next');
  assert.equal(res.done, false);

  const batches = await readAll(reader, { limit: 2 });
  assert.deepEqual(batches.flatMap((b) => b.messages.map((m) => m.id)), [1, 2, 3, 4, 5]);

  // 两个接口必须共存于同一实例，且互不影响
  assert.equal(typeof reader.readBatch, 'function');
  assert.equal(typeof reader.readBatchBefore, 'function');
});

/* ---------------- P13 批间新增更大 ID ---------------- */
test('P13 批间新增更大 ID，既有倒序分页不受影响', async () => {
  const list = Array.from({ length: 6 }, (_, i) => msg(i + 1, '第' + (i + 1) + '条'));
  const { reader } = readerFor(list);

  const first = await reader.readBatchBefore({ limit: 3 });
  assert.deepEqual(first.messages.map((m) => m.id), [6, 5, 4]);

  // 模拟分页过程中又来了新消息（id 更大）
  list.push(msg(7, '新来的'));

  const second = await reader.readBatchBefore({ beforeId: first.nextBeforeId, limit: 3 });
  assert.deepEqual(second.messages.map((m) => m.id), [3, 2, 1], '新消息不会闯进旧区间');
  assert.equal(second.nextBeforeId, 1);
  assert.equal(second.done, false, '恰好取满 limit 时还没确认游标耗尽，只能给 done:false');

  // 再往前一批：确认到底，返回空批 + done:true（契约允许这次空批）
  const third = await reader.readBatchBefore({ beforeId: second.nextBeforeId, limit: 3 });
  assert.deepEqual(third.messages, []);
  assert.equal(third.done, true, '旧记录到这里才算读到底');
});

/* ---------------- P14 倒序 cursor-stuck 守卫 ---------------- */
test('P14 cursor-stuck 守卫在倒序下仍生效', async () => {
  // 主键不可用的异常数据：每条都会被跳过，游标不会前进，必须由守卫中止
  const list = Array.from({ length: 1200 }, () => ({ id: null, role: 'user', content: 'x', time: T }));
  const { reader } = readerFor(list);

  const res = await reader.readBatchBefore({ limit: 1 });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'cursor-stuck');
  assert.equal(res.messages, null);
  assert.equal(res.done, false);
});
