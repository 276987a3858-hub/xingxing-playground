/* tests/butler/tx-overview-browser.mjs — 账单总览真实 IndexedDB 页面验证
 * 隔离：独立端口 + 独立 Edge profile；所有数据自带测试前缀，结束即删除。
 * 不发任何 AI/API 请求，只加载本地页面并直接调用本地仓储/表单。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9391;
const BASE = process.argv[2] || 'http://127.0.0.1:8793';
const PREFIX = '总览验证_';

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
}

const browser = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.env.TEMP}\\butler-txoverview-${Date.now()}`,
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
], { stdio: 'ignore' });

async function waitCDP() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return await r.json(); } catch {}
    await sleep(250);
  }
  throw new Error('DevTools 未就绪');
}

let ws;
try {
  const info = await waitCDP();
  ws = await new Promise((res, rej) => { const w = new WebSocket(info.webSocketDebuggerUrl); w.onopen = () => res(w); w.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
  const C = (method, params = {}, sid) => { id++; return new Promise((res, rej) => { pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) })); setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 20000); }); };

  const { targetId } = await C('Target.createTarget', { url: 'about:blank' });
  const sessionId = (await C('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  await C('Page.enable', {}, sessionId);
  await C('Runtime.enable', {}, sessionId);
  const ev = (expression, awaitPromise = false) => C('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, sessionId).then(r => {
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result.value;
  });

  // 先清掉隔离环境里可能残留的测试数据
  await C('Page.navigate', { url: `${BASE}/butler/` }, sessionId);
  await sleep(1400);
  await ev(`(async () => { const m = await import('/butler/butler-repository.js');
    for (const r of await m.repository.listTransactions()) if ((r.note||'').startsWith('${PREFIX}')) await m.repository.removeTransaction(r.id);
    return true; })()`, true);

  // 造已有交易：本月两笔支出 + 一笔收入，再加一笔上月支出（验证不按当月误筛）
  const seeded = await ev(`(async () => {
    const m = await import('/butler/butler-repository.js');
    const d = new Date(); const p = n => String(n).padStart(2,'0');
    const today = d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate());
    const month = today.slice(0,7);
    const prev = new Date(d.getFullYear(), d.getMonth()-1, 5);
    const prevDay = prev.getFullYear()+'-'+p(prev.getMonth()+1)+'-'+p(prev.getDate());
    const rows = [
      { type:'expense', amount:12.5, category:'餐饮', date:today, note:'${PREFIX}午饭' },
      { type:'expense', amount:7.5, category:'交通', date:today, note:'${PREFIX}公交' },
      { type:'income', amount:100, category:'工资', date:month+'-02', note:'${PREFIX}工资' },
      { type:'expense', amount:30, category:'日用', date:prevDay, note:'${PREFIX}上月账' },
    ];
    for (const r of rows) await m.repository.addTransaction(r);
    const s = await m.repository.txStats({});
    return { count:(await m.repository.listTransactions()).length, expense:s.expense, income:s.income };
  })()`, true);
  check('S01 隔离库已写入 4 笔测试交易', seeded && seeded.count === 4, JSON.stringify(seeded));
  check('S02 仓储全量统计正确（12.5+7.5+30=50，收入100）', seeded && seeded.expense === 50 && seeded.income === 100, JSON.stringify(seeded));

  // 切到记账 tab，读取页面真实渲染
  await ev(`document.querySelector('.tab[data-tab="tx"]').click()`);
  await sleep(700);
  const view = await ev(`(() => {
    const f = document;
    return {
      stats: f.getElementById('txStats').innerText,
      statsHTML: f.getElementById('txStats').innerHTML,
      list: f.getElementById('txList').innerText,
      visible: !!f.querySelector('#view-tx.active'),
    };
  })()`);
  console.log('  页面小结条:', JSON.stringify(view.stats));
  check('V01 记账页可见', view.visible === true);
  check('V02 已有交易出现在记录列表', /总览验证_午饭/.test(view.list) && /总览验证_上月账/.test(view.list), view.list.slice(0, 160));
  check('V03 页面显示累计总额/累计支出/累计收入', /账单总额/.test(view.stats) && /累计支出/.test(view.stats) && /累计收入/.test(view.stats), view.stats);
  check('V03b 累计金额与仓储一致（总额 ¥150 / 支出 ¥50 / 收入 ¥100）', /¥150/.test(view.stats) && /¥50/.test(view.stats) && /¥100/.test(view.stats), view.stats);

  // 通过页面表单新增一笔，验证总额与列表即时更新
  const added = await ev(`(async () => {
    const f = document;
    f.getElementById('xType').value = 'expense';
    f.getElementById('xType').dispatchEvent(new Event('change'));
    f.getElementById('xAmount').value = '8.5';
    f.getElementById('xDate').value = new Date().toLocaleDateString('sv-SE');
    f.getElementById('xCategory').value = '餐饮';
    f.getElementById('xNote').value = '${PREFIX}新增';
    f.getElementById('txForm').dispatchEvent(new Event('submit', { cancelable: true }));
    await new Promise(r => setTimeout(r, 700));
    return { stats: f.getElementById('txStats').innerText, list: f.getElementById('txList').innerText };
  })()`, true);
  console.log('  新增后小结条:', JSON.stringify(added.stats));
  check('V04 新增交易出现在列表', /总览验证_新增/.test(added.list));
  check('V05 新增后账单总额从 ¥150 更新为 ¥158.5', /¥158\.5/.test(added.stats), added.stats);
  check('V06 新增后累计收入仍为 ¥100', /¥100/.test(added.stats), added.stats);

  // 刷新页面验证持久化
  await C('Page.navigate', { url: `${BASE}/butler/` }, sessionId);
  await sleep(1200);
  await ev(`document.querySelector('.tab[data-tab="tx"]').click()`);
  await sleep(600);
  const persisted = await ev(`document.getElementById('txStats').innerText`);
  check('V07 刷新后总额仍为 ¥158.5', /¥158\.5/.test(persisted), persisted);

  // 清理：只删本次测试写入的记录
  const cleaned = await ev(`(async () => {
    const m = await import('/butler/butler-repository.js');
    const rows = await m.repository.listTransactions();
    for (const r of rows) if ((r.note||'').startsWith('${PREFIX}')) await m.repository.removeTransaction(r.id);
    return (await m.repository.listTransactions()).length;
  })()`, true);
  check('C01 测试数据已清理', cleaned === 0, '剩余 ' + cleaned);

  console.log(`\n总计 ${pass + fail} 项，通过 ${pass}，失败 ${fail}`);
  if (fail) process.exitCode = 1;
} catch (e) {
  console.error('执行失败:', e.stack || e.message);
  process.exitCode = 1;
} finally {
  try { ws && ws.close(); } catch {}
  try { browser.kill(); } catch {}
}
