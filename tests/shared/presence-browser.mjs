/* tests/shared/presence-browser.mjs — P0-b 真实浏览器链路验证
 * 隔离 profile，仅访问本地 8787 的 room / playground；不读真实用户数据、不调 AI。
 * 用法：node tests/shared/presence-browser.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 9371;
const BASE = 'http://127.0.0.1:8787';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = process.env.TEMP + '\\p0b-presence-' + Date.now();

const proc = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });

let ws, mid = 0;
const pending = new Map();
const errors = [];
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
  if (m.id && pending.has(m.id)) { const t = pending.get(m.id); pending.delete(m.id); m.error ? t.rej(new Error(m.error.message)) : t.res(m.result); }
};
await send('Runtime.enable');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' → ' + JSON.stringify(extra) : '')); }
}
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
const state = () => ev(`(()=>{try{return JSON.parse(localStorage.getItem('ylxh.life.v1')||'null')}catch(e){return null}})()`);
const nav = async (url) => { await send('Page.navigate', { url }); await sleep(1800); };

await send('Page.navigate', { url: BASE + '/' });
await sleep(2200);
const room1 = await state();
ok('房间首次进入：visitKind=fresh 且有 lastVisitAt', room1 && room1.visitKind === 'fresh' && !!room1.lastVisitAt, room1);
ok('房间 page 内 lastActiveAt 为空（boot 不写活跃）', room1 && room1.lastActiveAt === null);
ok('visitScope=room', room1 && room1.visitScope === 'room');
const visitBefore = room1.lastVisitAt;

// —— 房间 → 游乐场 ——
await nav(BASE + '/playground/');
const pg1 = await state();
ok('进入游乐场不更新 lastVisitAt', pg1.lastVisitAt === visitBefore, { before: visitBefore, after: pg1.lastVisitAt });
ok('进入游乐场不改 visitKind', pg1.visitKind === 'fresh', pg1.visitKind);
ok('游乐场 boot 使用 visit:false 作用域', pg1.visitScope === 'playground', pg1.visitScope);
ok('游乐场 boot 不写 lastActiveAt', pg1.lastActiveAt === null, pg1.lastActiveAt);
ok('幂等守卫已置位', (await ev('window.__yxPresenceBound === true')));

// —— 大厅空白点击：必须完全无变化 ——
const beforeBlank = JSON.stringify(await state());
await ev(`document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);
await sleep(200);
const afterBlank = JSON.stringify(await state());
ok('大厅空白点击不更新任何时间字段', beforeBlank === afterBlank);

// —— 进入游戏场景（hash 切换） ——
const revBeforeHash = (await state()).rev;
await ev(`location.hash = '#/quiz'`);
await sleep(700);
const afterHash = await state();
ok('hash 切换不更新 lastVisitAt', afterHash.lastVisitAt === visitBefore, afterHash.lastVisitAt);
ok('hash 切换不产生新访问（visitKind 不变）', afterHash.visitKind === 'fresh');

// —— 游戏内真实操作 ——
const tBefore = (await state()).lastActiveAt;
await ev(`document.getElementById('game-scene').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);
await sleep(300);
const afterGame = await state();
ok('游戏内 pointerdown 写入 lastActiveAt', typeof afterGame.lastActiveAt === 'number' && afterGame.lastActiveAt !== tBefore, { before: tBefore, after: afterGame.lastActiveAt });
ok('source=playground:game', afterGame.activeSource === 'playground:game', afterGame.activeSource);
ok('lastInteractionAt 未被游乐场写入', afterGame.lastInteractionAt === null, afterGame.lastInteractionAt);

// —— 大厅卡片点击（60s 节流内，不应重复写） ——
const beforeCard = JSON.stringify(await state());
await ev(`document.querySelector('[data-scene="radio"]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);
await sleep(200);
const afterCard = await state();
ok('节流窗口内的二次操作不重复写库', beforeCard === JSON.stringify(afterCard));

// —— 游乐场 → 房间 ——
const leaveCandidateAt = Date.now();
await ev(`document.getElementById('backToRoom').click()`);
for (let i = 0; i < 30; i++) {
  await sleep(300);
  const p = await ev('location.pathname');
  if (p === '/') break;
}
await sleep(1500);
const room2 = await state();
ok('返回房间更新 lastVisitAt', room2.lastVisitAt > visitBefore, { before: visitBefore, after: room2.lastVisitAt });
ok('返回房间 visitKind=returned', room2.visitKind === 'returned', room2.visitKind);
ok('返回房间用游乐场候选定案 lastLeaveAt', typeof room2.lastLeaveAt === 'number' && Math.abs(room2.lastLeaveAt - leaveCandidateAt) < 15000, { leaveAt: room2.lastLeaveAt, around: leaveCandidateAt });
ok('定案来源=playground', room2.lastLeaveFrom === 'playground', room2.lastLeaveFrom);
ok('leaveCertain=true', room2.leaveCertain === true);
ok('全程 lastInteractionAt 仍为空（未发消息）', room2.lastInteractionAt === null, room2.lastInteractionAt);

const realErrors = errors.filter((e) => !/favicon|manifest|TTS|\/api|three\.min/i.test(e));
ok('页面零 JS 异常', realErrors.length === 0, realErrors.slice(0, 3));

console.log(`\n${pass} passed, ${fail} failed`);
ws.close();
proc.kill();
process.exit(fail ? 1 : 0);
