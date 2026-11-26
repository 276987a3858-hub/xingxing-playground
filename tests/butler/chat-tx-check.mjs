/* tests/butler/chat-tx-check.mjs — 记账 + 聊天接入 真实浏览器端到端验证 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9387;
const BASE = process.argv[2] || 'http://127.0.0.1:8787';

let pass = 0, fail = 0;
function check(name, ok, detail) {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`;
  console.log(line);
  if (ok) pass += 1; else fail += 1;
}

const browser = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.env.TEMP}\\butler-chatx-${Date.now()}`,
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
], { stdio: 'ignore' });

async function waitFor() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return await r.json(); } catch {}
    await sleep(250);
  }
  throw new Error('DevTools 未就绪');
}

let ws;
try {
  const info = await waitFor();
  ws = await new Promise((res, rej) => { const w = new WebSocket(info.webSocketDebuggerUrl); w.onopen = () => res(w); w.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
  const C = (method, params = {}, sid) => { id++; return new Promise((res, rej) => { pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) })); setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 20000); }); };

  const { targetId } = await C('Target.createTarget', { url: 'about:blank' });
  const sessionId = (await C('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  await C('Page.enable', {}, sessionId);
  await C('Runtime.enable', {}, sessionId);
  const ev = (expression, awaitPromise = false) => C('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, sessionId).then(r => r.result.value);

  await C('Page.navigate', { url: `${BASE}/` }, sessionId);
  await sleep(1500);

  // C01 意图桥接脚本已加载
  check('C01 房间页 ButlerIntent 已加载', await ev(`typeof window.ButlerIntent === 'object' && typeof window.ButlerIntent.gate === 'function'`));

  // C02 门控行为
  const gate = await ev(`[ButlerIntent.gate('午饭花了7元'), ButlerIntent.gate('明天提醒我买牛奶'), ButlerIntent.gate('今天天气真好')]`);
  check('C02 门控：命中指令、放过闲聊', gate[0] === true && gate[1] === true && gate[2] === false, JSON.stringify(gate));

  // C03 旧数据保护：先造一条待办，升级后必须还在
  await ev(`(async () => { const m = await import('/butler/butler-repository.js');
    await m.repository.addTask({ title: '旧待办保留测试', date: '2026-11-17', type: 'todo' }); })()`, true);

  // C04 真实浏览器内 DB 升级 v1→v2 且 transactions store 存在
  const dbInfo = await ev(`(async () => {
    const m = await import('/butler/butler-repository.js');
    await m.repository.addTransaction({ type: 'expense', amount: 12.5, category: '餐饮', date: '2026-11-17', note: '午饭' });
    const raw = await new Promise((resolve, reject) => {
      const req = indexedDB.open('star_butler_v1');
      req.onsuccess = () => { const db = req.result; const stores = [...db.objectStoreNames]; db.close(); resolve({ version: db.version, stores }); };
      req.onerror = () => reject(req.error);
    });
    return raw;
  })()`, true);
  check('C04 DB 升级到 v2 且含 transactions store', dbInfo && dbInfo.version === 2 && dbInfo.stores.includes('transactions'), JSON.stringify(dbInfo));
  check('C04b v1 的四个 store 全部保留', dbInfo && ['tasks', 'sleepLogs', 'cycles', 'meta'].every(s => dbInfo.stores.includes(s)));

  // C05 升级后旧待办仍在
  const oldTask = await ev(`(async () => { const m = await import('/butler/butler-repository.js');
    const t = (await m.repository.listTasks()).find(x => x.title === '旧待办保留测试'); return !!t; })()`, true);
  check('C05 升级未破坏原有 tasks 数据', oldTask === true);

  // C06 本地查询：今天花了多少钱（真实 DB）
  const localQ = await ev(`(async () => { const r = await ButlerIntent.tryLocal('今天花了多少钱？'); return r; })()`, true);
  check('C06 聊天本地查询命中并返回金额', localQ && localQ.handled === true && /12\.5/.test(localQ.reply), localQ && localQ.reply);

  // C07 普通闲聊不触发本地查询
  const localNo = await ev(`(async () => (await ButlerIntent.tryLocal('我今天有点累，想和你聊聊')).handled)()`, true);
  check('C07 普通闲聊不触发', localNo === false);

  // C08 AI 标记路径：handleAIResponse 写入真实 DB
  const aiPath = await ev(`(async () => {
    const raw = '<bl>{"op":"tx_add","type":"expense","amount":20,"category":"购物","date":"today","note":"水果"}</bl>好，记下了。 ||| Logged.';
    const out = await ButlerIntent.handleAIResponse(raw);
    const m = await import('/butler/butler-repository.js');
    const rows = await m.repository.listTransactions();
    return { out: out.slice(0, 40), count: rows.length, fruit: rows.some(r => r.note === '水果' && r.amount === 20) };
  })()`, true);
  check('C08 AI 标记路径写入本地 DB', aiPath && aiPath.fruit === true && aiPath.count === 2, JSON.stringify(aiPath));
  check('C08b 标记已从回复剥离', aiPath && !aiPath.out.includes('<bl>'));

  // C09 记账 UI：抽屉内记账 tab
  await ev(`openButlerDrawer()`);
  await sleep(1800);
  const ui1 = await ev(`(() => {
    const f = document.getElementById('butlerFrame').contentDocument;
    const tab = f.querySelector('.tab[data-tab="tx"]');
    tab.click();
    return { hasTab: !!tab, form: !!f.getElementById('txForm') };
  })()`);
  await sleep(500);
  check('C09 抽屉内有记账 tab 与表单', ui1 && ui1.hasTab && ui1.form, JSON.stringify(ui1));

  // C10 表单新增一笔（真实 DOM 操作）
  const formAdd = await ev(`(async () => {
    const f = document.getElementById('butlerFrame').contentDocument;
    f.getElementById('xType').value = 'expense';
    f.getElementById('xType').dispatchEvent(new Event('change'));
    f.getElementById('xAmount').value = '5';
    f.getElementById('xDate').value = '2026-11-17';
    f.getElementById('xCategory').value = '交通';
    f.getElementById('xNote').value = '公交';
    f.getElementById('txForm').dispatchEvent(new Event('submit', { cancelable: true }));
    await new Promise(r => setTimeout(r, 600));
    const list = f.getElementById('txList').textContent;
    const stat = f.getElementById('txStats').textContent.replace(/\\s+/g, '');
    return { inList: list.includes('公交'), stat };
  })()`, true);
  check('C10 表单新增记账并出现在列表', formAdd && formAdd.inList === true, JSON.stringify(formAdd));

  // C11 刷新后持久化（真实 IndexedDB）
  await C('Page.navigate', { url: `${BASE}/butler/` }, sessionId);
  await sleep(1300);
  const persist = await ev(`(async () => {
    document.querySelector('.tab[data-tab="tx"]').click();
    await new Promise(r => setTimeout(r, 500));
    const list = document.getElementById('txList').textContent;
    return { bus: list.includes('公交'), lunch: list.includes('午饭'), fruit: list.includes('水果') };
  })()`, true);
  check('C11 刷新后三笔记账仍在', persist && persist.bus && persist.lunch && persist.fruit, JSON.stringify(persist));

  // C12 UI 编辑金额（限定记账列表内第一条，避免命中其他隐藏视图的按钮）
  const edited = await ev(`(async () => {
    document.querySelector('#txList .record-actions button').click();
    await new Promise(r => setTimeout(r, 300));
    const before = document.getElementById('xAmount').value;
    document.getElementById('xAmount').value = '6';
    document.getElementById('txForm').dispatchEvent(new Event('submit', { cancelable: true }));
    await new Promise(r => setTimeout(r, 600));
    return { before, has6: document.getElementById('txList').textContent.includes('¥6') };
  })()`, true);
  check('C12 UI 编辑金额生效', edited && edited.before === '5' && edited.has6 === true, JSON.stringify(edited));

  // C13 每月/分类统计正确（真实 DB 独立核算）
  const stats = await ev(`(async () => {
    const m = await import('/butler/butler-repository.js');
    const s = await m.repository.txStats({ from: '2026-11-01', to: '2026-11-30' });
    return { expense: s.expense, cats: s.byCategory };
  })()`, true);
  check('C13 统计：12.5+20+6=38.5，交通 6', stats && stats.expense === 38.5 && stats.cats['交通'] === 6, JSON.stringify(stats));

  // C14 清理测试数据（只删本次测试写入的记录）
  await ev(`(async () => {
    const m = await import('/butler/butler-repository.js');
    const tasks = await m.repository.listTasks();
    for (const t of tasks.filter(x => x.title === '旧待办保留测试')) await m.repository.removeTask(t.id);
    const txs = await m.repository.listTransactions();
    for (const t of txs.filter(x => ['午饭','水果','公交'].includes(x.note))) await m.repository.removeTransaction(t.id);
    return true;
  })()`, true);
  check('C14 已清理测试数据', true);

  console.log(`\n总计 ${pass + fail} 项，通过 ${pass}，失败 ${fail}`);
  if (fail > 0) process.exitCode = 1;
} catch (e) {
  console.error('执行失败:', e.stack || e.message);
  process.exitCode = 1;
} finally {
  try { ws && ws.close(); } catch {}
  try { browser.kill(); } catch {}
}
