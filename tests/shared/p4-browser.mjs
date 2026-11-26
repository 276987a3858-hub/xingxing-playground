/* tests/shared/p4-browser.mjs — P4 真实浏览器验收（隔离随机 profile，不碰真实数据）
 * 覆盖：120 字上限、butler:change→状态刷新、输入活跃、事实查询、闲聊不注入、提示词长度测量。
 * 不调用 AI：全程统计 /api 请求数，必须为 0。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 9377;
const BASE = 'http://127.0.0.1:8787';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = mkdtempSync(join(tmpdir(), 'p4-life-'));

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

console.log('\n[1] 模块与 120 字上限');
const mods = await ev(`({facts:!!window.LifeFacts, ctx:!!window.LifeContext, state:!!window.LifeState})`);
ok('LifeFacts 已挂载', mods && mods.facts === true, mods);
const worst = await ev(`(()=>{const s=window.LifeContext.snapshot({
  state:{counts:{planned:4,ongoing:2,completed:3,expired:1}},
  events:[{type:'task.done',at:Date.now()-3600000},{type:'vocab.round',at:Date.now()-600000},{type:'radio.episode',at:Date.now()-900000},{type:'reading.finish',at:Date.now()-1200000},{type:'game.finish',at:Date.now()-1800000}]});
  const t=window.LifeContext.render(s); const t2=window.LifeContext.render(s,{max:500});
  return {len:t.length, len2:t2.length, keep:t.indexOf('2026-') !== -1 && t.indexOf('不必报时') !== -1}})()`);
ok('最坏组合 ≤120', worst && worst.len <= 120 && worst.len2 <= 120, worst);
ok('压缩后仍保留日期与约束句', worst && worst.keep === true, worst);

console.log('\n[2] 输入活跃：只写 lastActiveAt');
const typing = await ev(`(async()=>{
  const P=window.LifePresence;
  const input=document.getElementById('chatInput');
  const before=P.snapshot();
  input.focus();
  input.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true}));
  input.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));
  const afterNav=P.snapshot();
  input.value='在'; input.dispatchEvent(new Event('input',{bubbles:true}));
  await new Promise(r=>setTimeout(r,60));
  const afterType=P.snapshot();
  input.value='';
  return {beforeActive:before.lastActiveAt, afterNavActive:afterNav.lastActiveAt,
    afterTypeActive:afterType.lastActiveAt,
    beforeInter:before.lastInteractionAt, afterInter:afterType.lastInteractionAt,
    src:afterType.activeSource}})()`);
ok('Tab/方向键不计活跃', typing && typing.afterNavActive === typing.beforeActive, typing);
ok('真实输入更新 lastActiveAt', typing && typing.afterTypeActive > (typing.beforeActive || 0), typing);
ok('输入不更新 lastInteractionAt', typing && typing.afterInter === typing.beforeInter, typing);
ok('活跃来源标记为 typing', typing && typing.src === 'typing', typing);

console.log('\n[3] butler:change → 状态缓存及时刷新');
const stateFlow = await ev(`(async()=>{
  const m=await import('/butler/butler-repository.js');
  const repo=m.createRepository(m.indexedDBAdapter);
  await window.LifeState.refresh();
  const before=window.LifeState.cached().counts.planned||0;
  const today=window.LifeClock.formatDay(Date.now());
  const t=await repo.addTask({title:'P4刷新校验', date:today, time:'21:00'});
  await new Promise(r=>setTimeout(r,900));
  const after=window.LifeState.cached().counts.planned||0;
  await repo.completeTask(t.id);
  await new Promise(r=>setTimeout(r,900));
  const done=window.LifeState.cached().counts;
  return {before, after, completed:done.completed||0, plannedAfterDone:done.planned||0,
    hasTitle:JSON.stringify(window.LifeState.cached().items).indexOf('P4刷新校验')!==-1}})()`);
ok('新增待办后缓存立即反映', stateFlow && stateFlow.after === stateFlow.before + 1, stateFlow);
ok('完成后转为 completed 且不再算 planned', stateFlow && stateFlow.completed >= 1 && stateFlow.plannedAfterDone === stateFlow.before, stateFlow);
ok('状态条目不含标题', stateFlow && stateFlow.hasTitle === false, stateFlow);

console.log('\n[4] P4 按需事实读取');
const facts = await ev(`(async()=>{
  const y=new Date(Date.now()-86400000);
  const day=window.LifeClock.formatDay(y.getTime());
  const at=window.LifeClock.fromParts ? window.LifeClock.fromParts(day,'20:00') : y.getTime();
  localStorage.setItem('ylxh.vocab.v1', JSON.stringify({history:[{at, size:5, words:[{w:'abandon',cn:'放弃'},{w:'brittle',cn:'易碎的'}], right:4, wrong:1}]}));
  const q1=await window.LifeFacts.lookup('我昨天背了什么？',{tasks:window.__tasks||null});
  const q2=await window.LifeFacts.lookup('星星我回来啦',{});
  const q3=await window.LifeFacts.lookup('我最近完成了哪些事',{tasks:async()=>[{id:'x',title:'交体检报告',status:'done',completedAt:Date.now()-3600000}]});
  const q4=await window.LifeFacts.lookup('我听过哪些节目',{});
  return {q1:q1.text, q1kind:q1.kind, q2:q2.text, q2kind:q2.kind, q3:q3.text, q4:q4.text}})()`);
ok('问昨天背了什么 → 读到真实单词', facts && /abandon/.test(facts.q1) && /昨天/.test(facts.q1), facts && facts.q1);
ok('撒娇闲聊不触发任何读取', facts && facts.q2kind === null && facts.q2 === '', facts && facts.q2);
ok('问完成了什么 → 读真实完成事项', facts && /交体检报告/.test(facts.q3), facts && facts.q3);
ok('没有电台记录时明确说没找到', facts && /没有找到/.test(facts.q4), facts && facts.q4);
ok('事实长度 ≤120', facts && [facts.q1, facts.q3, facts.q4].every((t) => t.length <= 120), facts);

console.log('\n[5] 普通闲聊不注入生活清单 / 提示词长度测量');
const measure = await ev(`(()=>{
  const base = getSystemPrompt().length + getScheduleContext().length;
  const s = window.LifeContext.snapshot();
  const life = window.LifeContext.shouldInject(s) ? window.LifeContext.render(s).length : 0;
  const hist = trimHistoryForAI(chatHistory).map(m=>String(m.content||'')).join('').length;
  return {system:getSystemPrompt().length, schedule:getScheduleContext().length, base, life,
    hist, msgs:chatHistory.length}})()`);
ok('时间/生活上下文总增量 < 200 字', measure && measure.life < 200, measure);
ok('历史裁剪生效（有上限）', measure && measure.hist <= 24000, measure);
console.log('    测量：system=' + (measure && measure.system) + ' schedule=' + (measure && measure.schedule)
  + ' lifeContext=' + (measure && measure.life) + ' 历史字符=' + (measure && measure.hist) + ' 消息数=' + (measure && measure.msgs));

console.log('\n[7] 发送前本地开销测量（不含网络）');
const timings = await ev(`(async()=>{
  const t=async(fn)=>{const a=performance.now();await fn();return Math.round((performance.now()-a)*10)/10};
  const t1=await t(()=>window.LifeFacts.lookup('星星我回来啦',{}));
  const t2=await t(()=>window.LifeFacts.lookup('我昨天背了什么？',{tasks:async()=>[]}));
  const t3=await t(()=>window.ButlerIntent.remindContext());
  const t4=await t(()=>window.LifeState.refresh());
  const t5=await t(async()=>{window.LifeContext.render(window.LifeContext.snapshot())});
  return {chatFactsMs:t1, factQueryMs:t2, remindMs:t3, stateRefreshMs:t4, ctxRenderMs:t5}})()`);
ok('闲聊时事实读取 < 5ms（几乎零成本）', timings && timings.chatFactsMs < 5, timings);
ok('上下文渲染 < 5ms', timings && timings.ctxRenderMs < 5, timings);
console.log('    耗时(ms)：闲聊事实=' + (timings && timings.chatFactsMs) + ' 命中查询=' + (timings && timings.factQueryMs)
  + ' 提醒扫描=' + (timings && timings.remindMs) + ' 状态刷新=' + (timings && timings.stateRefreshMs)
  + ' 上下文渲染=' + (timings && timings.ctxRenderMs));

console.log('\n[6] 原有链路');
ok('全程 0 次 /api 请求', apiCalls.length === 0, apiCalls.slice(0, 3));
ok('无 JS 异常', errors.length === 0, errors.slice(0, 3));

console.log(`\n${pass} passed, ${fail} failed`);
try { proc.kill(); } catch {}
process.exit(fail ? 1 : 0);
