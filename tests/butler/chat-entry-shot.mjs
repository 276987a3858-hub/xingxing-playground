/* tests/butler/chat-entry-shot.mjs — 聊天页入口去重验证 + 开关截图 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9383;
const BASE = 'http://127.0.0.1:8787';

const browser = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.env.TEMP}\\chatshot-${Date.now()}`,
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--hide-scrollbars',
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
  const C = (method, params = {}, sid) => { id++; return new Promise((res, rej) => { pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) })); setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 15000); }); };
  const ev = (expression, awaitPromise = false) => C('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, sessionId).then(r => r.result.value);

  const { targetId } = await C('Target.createTarget', { url: 'about:blank' });
  const sessionId = (await C('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  await C('Emulation.setDeviceMetricsOverride', { width: 1280, height: 880, deviceScaleFactor: 1, mobile: false }, sessionId);
  await C('Page.navigate', { url: `${BASE}/` }, sessionId);
  await sleep(1400);

  await ev(`showPage('chat')`);
  await sleep(400);

  const probeClosed = await ev(`(() => {
    const sel = '[onclick="openButlerDrawer()"]';
    const entries = [...document.querySelectorAll(sel)];
    const visible = entries.filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight; });
    return {
      total: entries.length,
      visible: visible.length,
      classes: visible.map(e => e.className),
      chatHeadBtns: document.querySelectorAll('#chat .page-head ' + sel).length,
    };
  })()`);
  console.log('聊天页关闭态探针:', JSON.stringify(probeClosed));

  const shot1 = await C('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
  writeFileSync('screenshots/chat-entry-closed.png', Buffer.from(shot1.data, 'base64'));

  await ev(`document.querySelector('.bl-drw-leaf').click()`);
  await sleep(1800);
  const probeOpen = await ev(`(() => {
    const o = document.getElementById('butlerDrawer');
    const p = document.querySelector('.bl-drw-panel').getBoundingClientRect();
    return { open: o.classList.contains('is-open'), panelW: Math.round(p.width), right: Math.round(p.right) };
  })()`);
  console.log('聊天页打开态探针:', JSON.stringify(probeOpen));

  const shot2 = await C('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
  writeFileSync('screenshots/chat-entry-open.png', Buffer.from(shot2.data, 'base64'));

  await ev(`closeButlerDrawer()`);
  await sleep(500);
  console.log('关闭后抽屉已收起:', await ev(`!document.getElementById('butlerDrawer').classList.contains('is-open')`));

  console.log('截图已保存: screenshots/chat-entry-closed.png, screenshots/chat-entry-open.png');
} catch (e) {
  console.error('失败:', e.stack || e.message);
  process.exitCode = 1;
} finally {
  try { ws && ws.close(); } catch {}
  try { browser.kill(); } catch {}
}
