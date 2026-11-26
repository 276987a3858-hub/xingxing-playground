/* tests/butler/pending-smoke.mjs — 轻量浏览器冒烟：页面不报错、意图层挂载、补充链路在真实库里跑通 */
import { spawn } from 'node:child_process';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9391;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proc = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.env.TEMP}\\bl-pending-${Date.now()}`, '--no-first-run',
  '--disable-background-networking', 'about:blank'], { stdio: 'ignore' });

let ws; let pass = 0; let fail = 0;
const check = (ok, name, extra = '') => { ok ? pass++ : fail++; console.log(ok ? 'PASS' : 'FAIL', name, extra); };

try {
  let info;
  for (let i = 0; i < 40; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { info = await r.json(); break; } } catch {} await sleep(250); }
  ws = await new Promise((res, rej) => { const w = new WebSocket(info.webSocketDebuggerUrl); w.onopen = () => res(w); w.onerror = rej; });
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
  const C = (method, params = {}, sid) => { id++; return new Promise((res, rej) => { pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) })); setTimeout(() => { if (pend.has(id)) { pend.delete(id); rej(new Error('timeout ' + method)); } }, 15000); }); };

  const { targetId } = await C('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await C('Target.attachToTarget', { targetId, flatten: true });
  const errors = [];
  await C('Runtime.enable', {}, sessionId);
  await C('Log.enable', {}, sessionId);
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text || 'exception');
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(String(m.params.args?.[0]?.value || 'console.error'));
  });
  const ev = async (expr, awaitP = false) => {
    const r = await C('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: awaitP }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };

  await C('Page.navigate', { url: BASE + '/' }, sessionId);
  await sleep(1600);

  check(await ev(`typeof ButlerIntent === 'object' && typeof ButlerIntent.tryPending === 'function'`), 'S1 意图层已挂载（含 tryPending）');
  check(await ev(`ButlerIntent.gate('今天花费真高') === false && ButlerIntent.gate('我不想洗衣服') === false`), 'S2 闲聊不唤醒');
  check(await ev(`ButlerIntent.hasPending() === false`), 'S3 初始无待处理上下文');

  // 走真实 app.js 链路里被调用的两个方法，用真实 IndexedDB
  const r = await ev(`(async () => {
    const out = await ButlerIntent.handleAIResponse('<bl>{"op":"task_add","title":"洗衣服","date":"today","need":["time"]}</bl>\\n下午几点提醒你？', '下午提醒我洗衣服');
    const had = ButlerIntent.hasPending();
    const filled = await ButlerIntent.tryPending('三点');
    const m = await import('/butler/butler-repository.js');
    const list = await m.repository.listTasks();
    const hit = list.filter(t => t.title === '洗衣服').pop();
    return { out, had, filled, count: list.filter(t => t.title === '洗衣服').length, time: hit && hit.time, after: ButlerIntent.hasPending() };
  })()`, true);
  check(r.had === true && r.filled.handled === true && r.filled.saved === true, 'S4 缺时间→待处理→「三点」补全并保存', JSON.stringify(r.filled));
  check(r.count === 1 && r.time === '15:00', 'S5 真实库里只有一条待办且时间为 15:00', `count=${r.count} time=${r.time}`);
  check(r.after === false, 'S6 保存后上下文已清除');
  check(errors.length === 0, 'S7 页面无脚本异常', errors.slice(0, 2).join(' | '));

  const nowCtx = await ev(`(typeof getNowContext === 'function') ? getNowContext() : ''`);
  check(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(nowCtx), 'S8 提示词含绝对当前时间', nowCtx);
  const sp = await ev(`getSystemPrompt().includes('相处分寸') && getSystemPrompt().includes('当前时间')`);
  check(sp === true, 'S9 人设提示词已含时间与相处分寸');
} catch (e) {
  fail++; console.log('FAIL 脚本异常', e.message);
} finally {
  try { ws && ws.close(); } catch {}
  try { proc.kill(); } catch {}
}
console.log(`\n总计 ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
