/* tests/shared/life-browser.mjs — P1-a/P1-b/P2-a 真实浏览器冒烟
 * 隔离 profile（每次随机目录），只访问本地 8787；所有数据写在临时 profile 内，不碰真实用户数据。
 * 不调用 AI：全程统计 /api 请求数，必须为 0。
 * 用法：node tests/shared/life-browser.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 9373;
const BASE = 'http://127.0.0.1:8787';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = mkdtempSync(join(tmpdir(), 'p1p2-life-'));

const proc = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });

let ws, mid = 0;
const pending = new Map();
const errors = [];
const apiCalls = [];
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++mid;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});

for (let i = 0; i < 40; i++) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch {}
  await sleep(250);
}
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') errors.push('EX ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('CE ' + m.params.args.map((a) => a.value || a.description).join(' '));
  if (m.method === 'Network.requestWillBeSent') {
    const u = m.params.request.url;
    if (u.includes('/api')) apiCalls.push(u);
  }
  if (m.id && pending.has(m.id)) { const t = pending.get(m.id); pending.delete(m.id); m.error ? t.rej(new Error(m.error.message)) : t.res(m.result); }
};
await send('Runtime.enable');
await send('Network.enable');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return r.result.value;
};

await send('Page.navigate', { url: BASE + '/' });
await sleep(2600);

console.log('\n[1] 模块加载与初始化');
const mods = await ev(`({clock:!!window.LifeClock, presence:!!window.LifePresence, events:!!window.LifeEvents, ctx:!!window.LifeContext, sched:!!window.LifeScheduler, butler:!!window.ButlerIntent, state:!!window.LifeState})`);
ok('六个模块全部挂载', mods && mods.clock && mods.presence && mods.events && mods.ctx && mods.sched && mods.butler && mods.state, mods);
ok('页面无 JS 异常', errors.length === 0, errors.slice(0, 3));

console.log('\n[2] P1-a 生活上下文');
const ctxInfo = await ev(`(()=>{const s=window.LifeContext.snapshot();const t=window.LifeContext.render(s);return {visitKind:s.visitKind,text:t,len:t.length,inject:window.LifeContext.shouldInject(s)}})()`);
ok('快照可生成且访问性质正确', ctxInfo && ctxInfo.visitKind === 'fresh', ctxInfo);
ok('渲染长度 ≤120', ctxInfo && ctxInfo.len <= 120, ctxInfo && ctxInfo.len);
ok('渲染含约束句（不必报时）', ctxInfo && ctxInfo.text.indexOf('不必报时') !== -1, ctxInfo && ctxInfo.text);
ok('首次进入不强行注入', ctxInfo && ctxInfo.inject === false, ctxInfo && ctxInfo.inject);
const ctxPriv = await ev(`(()=>{const t=window.LifeContext.render(window.LifeContext.snapshot());
  return ['元','¥','睡眠','生理期'].filter(k=>t.indexOf(k)!==-1)})()`);
ok('上下文不含隐私标记', Array.isArray(ctxPriv) && ctxPriv.length === 0, ctxPriv);

console.log('\n[3] P1-b 事件层（真实写入路径）');
const today = await ev(`window.LifeClock.formatDay(Date.now())`);
const time = await ev(`(()=>{const d=new Date(Date.now()+10*60000);return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')})()`);
const addRes = await ev(`(async()=>{const m=await import('/butler/butler-repository.js');
  const repo=m.createRepository(m.indexedDBAdapter);
  const t=await repo.addTask({title:'浏览器校验事项', date:'${today}', time:'${time}'});
  const evs=window.LifeEvents.list().filter(e=>e.type==='task.add');
  return {id:t.id, added:evs.length, status:evs[evs.length-1]&&evs[evs.length-1].status}})()`);
ok('新建事项登记为 planned（不算发生）', addRes && addRes.added >= 1 && addRes.status === 'planned', addRes);
const sumPlanned = await ev(`window.LifeEvents.summarySince(Date.now()-86400000, Date.now()+60000).filter(e=>e.type==='task.add').length`);
ok('planned 不进 occurred 摘要', sumPlanned === 0, sumPlanned);

// boot:true 走启动补检路径：用户级任务不受 60 秒间隔门槛限制（否则紧跟启动 tick 的这一次会被跳过）
console.log('\n[4] P2-a 提醒：到期 → 页内可见 → 只呈现一次');
const tick1 = await ev(`(async()=>{const r=await window.LifeScheduler.tick({forceVisible:true, boot:true});
  return {ran:r.ran, skipped:r.skipped, toast:document.getElementById('toast').textContent,
    toastVisible:(document.getElementById('toast').style.display!=='none'),
    shown:JSON.parse(localStorage.getItem('ylxh.butler.remind.shown')||'[]').length}})()`);
ok('调度器执行了提醒任务', tick1 && Array.isArray(tick1.ran) && tick1.ran.indexOf('butler.remind') !== -1, tick1);
ok('提醒在页面上真实可见（复用 toast）', tick1 && tick1.toastVisible === true && /快到时间了/.test(tick1.toast), tick1 && tick1.toast);
ok('已记录呈现状态', tick1 && tick1.shown >= 1, tick1 && tick1.shown);
const tick2 = await ev(`(async()=>{const before=document.getElementById('toast').textContent;
  await window.LifeScheduler.tick({forceVisible:true, boot:true});
  return {same:document.getElementById('toast').textContent===before}})()`);
ok('同一提醒不重复呈现', tick2 && tick2.same === true, tick2);
const ctxSuppress = await ev(`window.ButlerIntent.remindContext()`);
ok('刚呈现过的提醒不在聊天里重复播报', ctxSuppress === '', ctxSuppress);

console.log('\n[5] 完成事项 → occurred 事件 + 上下文概括');
const doneReal = await ev(`(async()=>{const m=await import('/butler/butler-repository.js');
  const repo=m.createRepository(m.indexedDBAdapter);
  await repo.completeTask('${addRes ? addRes.id : ''}');
  const evs=window.LifeEvents.list().filter(e=>e.type==='task.done');
  const sum=window.LifeEvents.summarySince(Date.now()-86400000, Date.now()+60000).filter(e=>e.type==='task.done');
  const t=window.LifeContext.render(window.LifeContext.snapshot({events:sum}));
  return {evCount:evs.length, sumCount:sum.length, text:t}})()`);
ok('完成以数据库写入为准，生成 occurred 事件', doneReal && doneReal.evCount >= 1 && doneReal.sumCount >= 1, doneReal && { e: doneReal.evCount, s: doneReal.sumCount });
ok('上下文用「完成了几件事」概括，不含标题', doneReal && doneReal.text.indexOf('完成了1件事') !== -1 && doneReal.text.indexOf('浏览器校验事项') === -1, doneReal && doneReal.text);

console.log('\n[6] P2-b 定时器迁移与网络');
const timers = await ev(`({future:typeof futureLetterTimer==='undefined'?'na':(futureLetterTimer?1:0),
  idle:typeof idleTimer==='undefined'?'na':(idleTimer?1:0),
  ids:window.LifeScheduler.list().map(t=>t.id),
  sched:!!window.LifeScheduler.list().length})`);
ok('旧的未来信 60s interval 已移除（不留双扫）', timers && timers.future === 0, timers);
ok('旧的空闲 setTimeout 已移除', timers && timers.idle === 0, timers);
ok('调度器接管：提醒/未来信/空闲/状态四个任务', timers && ['butler.remind','room.futureLetter','room.idle','life.state'].every(id=>timers.ids.indexOf(id)!==-1), timers && timers.ids);
const futureTick = await ev(`(async()=>{const r=await window.LifeScheduler.tick({forceVisible:true, boot:true});
  return {ran:r.ran, err:r.skipped.filter(s=>/:error$/.test(s))}})()`);
ok('未来信任务由 tick 触发且不抛错', futureTick && futureTick.err.length === 0, futureTick);
ok('原有即时补检入口仍存在', await ev(`typeof processDueFutureLetters==='function'`) === true);

console.log('\n[7] P3 生活状态层');
const stateRes = await ev(`(async()=>{const s=await window.LifeState.refresh();
  const c=window.LifeState.cached();
  const ctx=window.LifeContext.snapshot();
  const t=window.LifeContext.render(ctx);
  return {items:s.items.length, hasCache:!!c, completed:(s.counts.completed||0), text:t,
    leak:['浏览器校验事项','元','¥','睡眠','生理期'].filter(k=>JSON.stringify(s.items).indexOf(k)!==-1)}})()`);
ok('状态快照可构建并缓存', stateRes && stateRes.hasCache === true, stateRes && stateRes.hasCache);
ok('完成事项进入 completed 状态', stateRes && stateRes.completed >= 1, stateRes && stateRes.completed);
ok('状态条目不含标题/金额/隐私字段', stateRes && stateRes.leak.length === 0, stateRes && stateRes.leak);
ok('上下文可读到状态但保持简短', stateRes && stateRes.text.length <= 120, stateRes && stateRes.text);

ok('全程 0 次 /api 请求', apiCalls.length === 0, apiCalls.slice(0, 3));
ok('整轮无 JS 异常', errors.length === 0, errors.slice(0, 3));

console.log(`\n${pass} passed, ${fail} failed`);
try { proc.kill(); } catch {}
process.exit(fail ? 1 : 0);
