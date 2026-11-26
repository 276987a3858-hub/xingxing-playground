/* tests/shared/life-feed-browser.mjs — 「小屋的动静」真实首页集成冒烟
 * 隔离 profile（随机临时目录），只访问本地 8787；全部数据写在临时 profile 内，不碰真实存档。
 * 不调用 AI：全程统计 /api 请求数，必须为 0。
 * 覆盖：真实首页挂载 / 真实 IndexedDB 读取（keeps）/ 今天↔近三天切换 / 零请求
 * 用法：node tests/shared/life-feed-browser.mjs   （需本地 8787 已启动）
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 9381;
const BASE = 'http://127.0.0.1:8787';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = mkdtempSync(join(tmpdir(), 'lf-feed-'));

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
  if (m.method === 'Network.requestWillBeSent' && String(m.params.request.url).includes('/api')) apiCalls.push(m.params.request.url);
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
const waitMount = async () => {
  for (let i = 0; i < 40; i++) {
    const m = await ev(`(document.getElementById('lifeFeed')||{}).getAttribute && document.getElementById('lifeFeed').getAttribute('data-mounted')`);
    if (m === '1') return true;
    await sleep(200);
  }
  return false;
};
const panelText = () => ev(`(document.getElementById('lifeFeed')||{}).innerText || ''`);

/* ---------- 1. 真实首页首次进入（空库） ---------- */
await send('Page.navigate', { url: BASE + '/' });
await sleep(2400);
ok('LifeFeed 模块已加载', await ev('!!window.LifeFeed'));
ok('首页 #lifeFeed 已真实挂载', (await waitMount()) === true);
const shell = await ev(`(()=>{const el=document.getElementById('lifeFeed');
  return {title:(el.querySelector('.lf-title')||{}).textContent||'',
    ranges:Array.from(el.querySelectorAll('.lf-range-btn')).map(b=>b.textContent.trim()),
    now:!!el.querySelector('#lfCurrent')}})()`);
ok('标题为「小屋的动静」', shell && shell.title === '小屋的动静', shell);
ok('今天/近三天两个切换入口', shell && shell.ranges.join('|') === '今天|近三天' && shell.now === true, shell);

const before = await ev(`(async()=>{const db=await new Promise((res,rej)=>{const r=indexedDB.open('star_fifi_room');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});
  const rows=await new Promise(res=>{try{const q=db.transaction('keeps').objectStore('keeps').getAll();q.onsuccess=()=>res(q.result||[]);q.onerror=()=>res([])}catch(e){res([])}});
  db.close();return rows.length})()`);
ok('隔离库初始没有珍藏记录', before === 0, before);
const emptyText = await panelText();
ok('空库时不出现珍藏文案（未读到任何珍藏）', !/你点头了|收下了|你答应了/.test(emptyText));

/* ---------- 2. 写入临时真实库（IndexedDB / keeps）+ 一条两天前事件 ---------- */
const seeded = await ev(`(async()=>{
  const rk = await import('/shared/room-keeps.js');
  const id = await rk.addKeep({title:'FEEDTEST-临时珍藏', content:'隔离 profile 集成测试数据', by:'星星',
    status:'saved', createdAt: Date.now(), confirmedAt: Date.now()});
  const twoDaysAgo = new Date(); twoDaysAgo.setDate(twoDaysAgo.getDate()-2); twoDaysAgo.setHours(20,0,0,0);
  const at = twoDaysAgo.getTime();
  const d = new Date(at);
  const day = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  const key = 'ylxh.life.log.v1';
  let cur = {v:1, items:[]};
  try { cur = JSON.parse(localStorage.getItem(key)||'null') || cur; } catch(e) {}
  cur.items.push({id:'game:finish:puzzle:'+at, at, day, source:'playground', type:'game.finish', status:'occurred', title:'puzzle', meta:{game:'puzzle'}});
  localStorage.setItem(key, JSON.stringify(cur));
  return {id, at};
})()`);
ok('已向隔离库写入 1 条珍藏 + 1 条历史事件', seeded && typeof seeded.id === 'number' && typeof seeded.at === 'number', seeded);

await send('Page.reload');
await sleep(2400);
await waitMount();
const after = await ev(`(async()=>{const db=await new Promise((res,rej)=>{const r=indexedDB.open('star_fifi_room');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});
  const rows=await new Promise(res=>{try{const q=db.transaction('keeps').objectStore('keeps').getAll();q.onsuccess=()=>res(q.result||[]);q.onerror=()=>res([])}catch(e){res([])}});
  db.close();return {count:rows.length, title:(rows[0]||{}).title, status:(rows[0]||{}).status}})()`);
ok('真实库仍只有这 1 条（未被改写/复制）', after && after.count === 1 && after.title === 'FEEDTEST-临时珍藏', after);

/* ---------- 3. 真实 IndexedDB 读取结果进入面板 ---------- */
const todayText = await panelText();
ok('面板读到真实 keeps：出现珍藏共同经历', /你点头了|收下了|你答应了/.test(todayText), todayText.slice(0, 200));
const fold = await ev(`(()=>{const b=document.getElementById('lfFold');return b?{text:b.innerText.replace(/\\s+/g,' ').trim()}:null})()`);
ok('存在「更早」入口（历史计数 > 0）', !!(fold && /更早/.test(fold.text)), fold);

/* ---------- 4. 今天 → 近三天 → 今天 ---------- */
await ev(`document.querySelector('[data-range="near"]').click()`);
await sleep(500);
const near = await ev(`(()=>{const el=document.getElementById('lifeFeed');
  const on=el.querySelector('[data-range="near"]');
  return {sel:on.getAttribute('aria-selected'), on:on.classList.contains('is-on'),
    groups:el.querySelectorAll('.lf-day--past').length, text:el.innerText}})()`);
ok('切到近三天：按钮状态正确', near && near.sel === 'true' && near.on === true, near && { sel: near.sel, on: near.on });
ok('切到近三天：出现历史日期分组', near && near.groups >= 1, near && near.groups);
ok('历史分组展示两天前的真实事件（玩了一局）', near && near.text.indexOf('玩了一局') !== -1, near && near.text.slice(0, 300));

await ev(`document.querySelector('[data-range="today"]').click()`);
await sleep(400);
const backToday = await ev(`(()=>{const el=document.getElementById('lifeFeed');
  return {sel:el.querySelector('[data-range="today"]').getAttribute('aria-selected'),
    groups:el.querySelectorAll('.lf-day--past').length, text:el.innerText}})()`);
ok('切回今天：按钮与内容恢复', backToday && backToday.sel === 'true' && backToday.groups === 0, backToday && { sel: backToday.sel, groups: backToday.groups });
ok('切回今天后仍保留共同经历', backToday && /你点头了|收下了|你答应了/.test(backToday.text));

/* ---------- 5. 同会话写入：life:feed 事件触发按帧刷新 ---------- */
const obs = await ev(`(()=>{const box=document.getElementById('lfBody');
  window.__lfMut=0;
  window.__lfObs=new MutationObserver(()=>{window.__lfMut++});
  window.__lfObs.observe(box,{childList:true,subtree:false});
  return true})()`);
ok('已挂载 #lfBody 监听（用于验证合并渲染）', obs === true);

// 5a. 新增珍藏（waiting_user）→ 不刷新页面也应出现「惊喜」文案
const waitKeep = await ev(`(async()=>{const rk=await import('/shared/room-keeps.js');
  const id=await rk.addKeep({title:'FEEDTEST-待确认',content:'隔离 profile 测试',by:'星星',status:'waiting_user',createdAt:Date.now()});
  return id})()`);
await sleep(600);
const waitText = await panelText();
ok('同会话新增珍藏后自动刷新（惊喜文案出现）', /没直接收进珍藏|留了一样东西|那儿放着一件/.test(waitText), waitText.slice(0, 240));

// 5b. 确认珍藏（updateKeep）→ 同会话也应刷新：待确认文案消失
const confirmed = await ev(`(async()=>{const rk=await import('/shared/room-keeps.js');
  return await rk.updateKeep(${Number(waitKeep)}, {status:'saved', confirmedAt:Date.now()})})()`);
await sleep(600);
const savedText = await panelText();
ok('同会话确认珍藏后自动刷新（待确认文案消失）', confirmed === true && !/没直接收进珍藏|留了一样东西|那儿放着一件/.test(savedText), savedText.slice(0, 240));

// 5c. LifeEvents.record → 历史计数增加
const foldBefore = await ev(`document.getElementById('lfFold').innerText.replace(/\\s+/g,' ')`);
const rec = await ev(`(()=>{const d=new Date();d.setDate(d.getDate()-3);d.setHours(19,0,0,0);
  const at=d.getTime();
  return window.LifeEvents.record({id:'game:finish:vocab:'+at, at:at, source:'playground', type:'game.finish', status:'occurred', title:'vocab', meta:{game:'vocab'}})})()`);
await sleep(600);
const foldAfter = await ev(`document.getElementById('lfFold').innerText.replace(/\\s+/g,' ')`);
ok('LifeEvents 写入后自动刷新（更早计数 +1）', rec && rec.added === true && /\d+/.test(foldAfter) && foldAfter !== foldBefore,
  { before: foldBefore, after: foldAfter });

// 5d. 同一帧多次通知只渲染一次
await ev(`window.__lfMut=0`);
await ev(`(()=>{window.dispatchEvent(new Event('life:feed'));window.dispatchEvent(new Event('life:feed'));window.dispatchEvent(new Event('life:feed'));return true})()`);
await sleep(500);
const mut = await ev(`window.__lfMut`);
ok('同一帧 3 次通知合并为 1 次渲染', mut === 1, mut);

// 5e. 不重复写存档
const counts = await ev(`(async()=>{const db=await new Promise((res,rej)=>{const r=indexedDB.open('star_fifi_room');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});
  const rows=await new Promise(res=>{const q=db.transaction('keeps').objectStore('keeps').getAll();q.onsuccess=()=>res(q.result||[]);q.onerror=()=>res([])});
  db.close();
  let log={items:[]};try{log=JSON.parse(localStorage.getItem('ylxh.life.log.v1')||'null')||log}catch(e){}
  return {keeps:rows.length, log:Array.isArray(log.items)?log.items.length:0}})()`);
ok('刷新只读不写：珍藏 2 条、事件 2 条，无重复', counts && counts.keeps === 2 && counts.log === 2, counts);

/* ---------- 6. 零 AI / 零异常 ---------- */
ok('全程 0 次 /api 请求', apiCalls.length === 0, apiCalls.slice(0, 3));
const realErrors = errors.filter((e) => !/favicon|manifest|TTS|three\.min|ERR_/i.test(e));
ok('页面零 JS 异常', realErrors.length === 0, realErrors.slice(0, 3));

console.log(`\n${pass} passed, ${fail} failed`);
ws.close();
proc.kill();
process.exit(fail ? 1 : 0);
