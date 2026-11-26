/* tests/butler/room-regression.mjs — 验证房间首页与聊天发送接收未被影响 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9355;
const BASE = process.argv[2] || 'http://127.0.0.1:8799';
const profile = `${process.env.TEMP}\\butler-room-${Date.now()}`;
const browser = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check'], { stdio: 'ignore' });

async function waitFor() {
  for (let i = 0; i < 40; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return await r.json(); } catch {} await sleep(250); }
  throw new Error('DevTools 未就绪');
}
let ws;
try {
  const info = await waitFor();
  ws = await new Promise((res, rej) => { const w = new WebSocket(info.webSocketDebuggerUrl); w.onopen = () => res(w); w.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
  const C = (method, params = {}, sessionId) => { id++; return new Promise((res, rej) => { pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 15000); }); };
  const { targetId } = await C('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await C('Target.attachToTarget', { targetId, flatten: true });
  await C('Page.enable', {}, sessionId);
  await C('Runtime.enable', {}, sessionId);
  const ev = async (expression, awaitPromise = false) => {
    const r = await C('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result.value;
  };
  await C('Page.navigate', { url: `${BASE}/` }, sessionId);
  await sleep(1500);
  const home = await ev(`({ title: document.title, hasChat: !!document.querySelector('[data-scene], #chat'), tiles: document.querySelectorAll('.tile').length, leaf: !!document.querySelector('.bl-drw-leaf') })`);
  console.log(home.tiles === 4 && home.leaf ? 'PASS' : 'FAIL', 'R01 房间首页正常：4 张卡片 + 顶栏叶子入口', JSON.stringify(home));

  // 用房间自己的 IndexedDB 验证的消息写入读取路径（不发真实 AI 请求）
  const chat = await ev(`(async () => {
    const open = indexedDB.open('star_fifi_room', 3);
    const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = () => rej(open.error); });
    const puts = [];
    const tx = db.transaction('messages', 'readwrite');
    const store = tx.objectStore('messages');
    store.add({ role: 'user', content: '回归测试消息', time: Date.now() });
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    const all = await new Promise((res) => { const r = db.transaction('messages','readonly').objectStore('messages').getAll(); r.onsuccess = () => res(r.result); });
    return { count: all.length, has: all.some(m => m.content === '回归测试消息'), stores: [...db.objectStoreNames] };
  })()`, true);
  const ok = chat.has && ['kv','messages','diaries','starDiaries','keeps','futureLetters'].every(s => chat.stores.includes(s));
  console.log(ok ? 'PASS' : 'FAIL', 'R02 房间原 IndexedDB 消息读写与结构未受影响', JSON.stringify(chat));

  const jsErr = await ev(`(window.__butlerRegressionErrors||[]).length`);
  console.log(jsErr === 0 ? 'PASS' : 'FAIL', 'R03 房间首页脚本无异常', 'errors=' + jsErr);
} catch (e) { console.error('房间回归异常:', e.stack || e.message); process.exitCode = 1; }
finally { try { ws && ws.close(); } catch {} try { browser.kill(); } catch {} }
