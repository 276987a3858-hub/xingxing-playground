/* tests/shared/p5-browser.mjs — P5 真实浏览器验收（隔离随机 profile，不碰真实数据、不调 AI）
 * 覆盖：话题回避的写入/生效/解除、事件与事实不绕过规则、普通闲聊不触发、0 次 /api。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 9381;
const BASE = 'http://127.0.0.1:8787';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = mkdtempSync(join(tmpdir(), 'p5-life-'));

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
  if (m.method === 'Network.requestWillBeSent' && m.params.request.url.includes('/api')) apiCalls.push(m.params.request.url);
  if (m.id && pending.has(m.id)) { const t = pending.get(m.id); pending.delete(m.id); m.error ? t.rej(new Error(m.error.message)) : t.res(m.result); }
};
await send('Runtime.enable');
await send('Network.enable');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
};
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return r.result.value;
};

await send('Page.navigate', { url: BASE + '/' });
await sleep(2600);

console.log('\n[1] 模块');
const mods = await ev(`({topics:!!window.LifeTopics, ctx:!!window.LifeContext, facts:!!window.LifeFacts, sched:!!window.LifeScheduler})`);
ok('LifeTopics 已挂载', mods && mods.topics === true, mods);
ok('未破坏既有模块', mods && mods.ctx && mods.facts && mods.sched, mods);

console.log('\n[2] 暂时回避不落盘');
const shortRes = await ev(`(async()=>{
  const LT=window.LifeTopics; LT._clear();
  const r=LT.note('我现在不想聊背单词的事');
  return {kind:r.kind, blocked:LT.isBlocked('vocab'), raw:localStorage.getItem('ylxh.topic.avoid.v1')}})()`);
ok('识别为暂时回避', shortRes && shortRes.kind === 'short', shortRes);
ok('本次会话内生效', shortRes && shortRes.blocked === true, shortRes);
ok('不写入长期规则', shortRes && shortRes.raw === null, shortRes);

console.log('\n[3] 长期回避生效，事件/事实都绕不过');
const longRes = await ev(`(async()=>{
  const LT=window.LifeTopics, LC=window.LifeContext, LF=window.LifeFacts; LT._clear();
  LT.note('以后别再跟我提背单词了');
  const raw=localStorage.getItem('ylxh.topic.avoid.v1');
  const s=LC.snapshot({presence:{visitKind:'returned',lastInteractionAt:Date.now()-86400000},
    events:[{type:'vocab.round',at:Date.now()-3600000},{type:'task.done',at:Date.now()-7200000}],
    state:{counts:{planned:2,ongoing:1,completed:3,expired:0}}});
  const text=LC.render(s);
  const y=new Date(); y.setDate(y.getDate()-1); y.setHours(20,0,0,0);
  localStorage.setItem('ylxh.vocab.v1', JSON.stringify({history:[{at:y.getTime(),size:6,words:[{w:'abandon'}]}]}));
  const f=await LF.lookup('我昨天背了什么？',{});
  return {raw:raw, len:raw?raw.length:0, vocabInEvents:(s.events.counts['vocab.round']||0),
    taskInEvents:(s.events.counts['task.done']||0), stateGone:s.hasState===false,
    text:text, factText:f.text, factBlocked:f.blocked, prompt:LT.promptNote()}})()`);
ok('写入长期规则且体积很小', longRes && longRes.raw && longRes.len < 120, longRes && longRes.len);
ok('被回避话题不进入事件概括', longRes && longRes.vocabInEvents === 0, longRes && longRes.vocabInEvents);
ok('其他事件不受影响', longRes && longRes.taskInEvents === 1, longRes && longRes.taskInEvents);
ok('状态计数一并停给', longRes && longRes.stateGone === true, longRes && longRes.stateGone);
ok('渲染里不出现该话题', longRes && longRes.text.indexOf('背了') === -1, longRes && longRes.text);
ok('事实查询直接空返回（连存档都不读）', longRes && longRes.factText === '' && longRes.factBlocked === true, longRes && longRes.factText);
ok('提示词带回避约束且简短', longRes && longRes.prompt.length > 0 && longRes.prompt.length <= 60, longRes && longRes.prompt);

console.log('\n[4] 解除回避');
const relRes = await ev(`(async()=>{
  const LT=window.LifeTopics, LF=window.LifeFacts;
  const r=LT.note('背单词的事可以再聊了');
  const f=await LF.lookup('我昨天背了什么？',{});
  return {kind:r.kind, blocked:LT.isBlocked('vocab'), fact:f.text}})()`);
ok('识别为解除', relRes && relRes.kind === 'release', relRes);
ok('解除后恢复可查', relRes && relRes.blocked === false && relRes.fact.indexOf('abandon') !== -1, relRes);

console.log('\n[5] 普通闲聊不记录、不读取');
const chatRes = await ev(`(async()=>{
  const LT=window.LifeTopics, LF=window.LifeFacts; LT._clear();
  const rs=['星星我回来啦','今天好累啊','陪我聊会儿吧'].map(t=>LT.note(t).kind);
  const t0=performance.now(); const f=await LF.lookup('星星我回来啦',{}); const ms=performance.now()-t0;
  return {kinds:rs, stored:localStorage.getItem('ylxh.topic.avoid.v1'), fact:f.text, ms:Math.round(ms*10)/10,
    declined:LT.declined('今天好累，不想说话')}})()`);
ok('闲聊不产生任何规则', chatRes && chatRes.kinds.every((k) => k === null) && chatRes.stored === null, chatRes);
ok('闲聊不触发事实读取', chatRes && chatRes.fact === '' && chatRes.ms < 5, chatRes && chatRes.ms);
ok('疲惫表达可识别（仅暂停自主互动）', chatRes && chatRes.declined === true, chatRes);

console.log('\n[6] 原有链路');
const legacy = await ev(`({ids:window.LifeScheduler.list().map(t=>t.id), budget:window.LifeScheduler.budget(Date.now()).limit})`);
ok('四个既有任务仍在', legacy && ['butler.remind','room.futureLetter','room.idle','life.state'].every((id) => legacy.ids.indexOf(id) !== -1), legacy && legacy.ids);
ok('ambient 上限为 15', legacy && legacy.budget === 15, legacy && legacy.budget);
ok('全程 0 次 /api 请求', apiCalls.length === 0, apiCalls.slice(0, 3));
ok('整轮无 JS 异常', errors.length === 0, errors.slice(0, 3));

console.log(`\n结果：${pass}/${pass + fail}`);
proc.kill();
process.exit(fail ? 1 : 0);
