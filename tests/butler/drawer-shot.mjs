/* tests/butler/drawer-shot.mjs — 侧拉抽屉打开状态截图（真实 Edge） */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9356;
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const OUT = process.argv[3] || 'screenshots/drawer-desktop.png';
const VIEW = process.argv[4] || 'desktop'; // desktop | mobile | chat

const browser = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.env.TEMP}\\butler-drwshot-${Date.now()}`,
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

  const { targetId } = await C('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await C('Target.attachToTarget', { targetId, flatten: true });
  await C('Page.enable', {}, sessionId);
  await C('Runtime.enable', {}, sessionId);
  if (VIEW === 'mobile') await C('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sessionId);
  else await C('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false }, sessionId);

  await C('Page.navigate', { url: `${BASE}/` }, sessionId);
  await sleep(1200);

  // 造一些待办，让抽屉内容更真实（临时 profile）
  await C('Runtime.evaluate', { expression: `(async () => {
    const m = await import('/butler/butler-repository.js');
    const d = new Date(); const ds = (n) => { const x=new Date(d); x.setDate(x.getDate()+n);
      return x.getFullYear()+'-'+String(x.getMonth()+1).padStart(2,'0')+'-'+String(x.getDate()).padStart(2,'0'); };
    await m.repository.addTask({ title: '整理房间', date: ds(0), time: '09:30' });
    await m.repository.addTask({ title: '给妈妈打电话', date: ds(0), time: '20:00' });
    await m.repository.saveSleep({ date: ds(0), sleepTime: '23:30', wakeTime: '07:30' });
  })()`, awaitPromise: true }, sessionId);

  if (VIEW === 'chat') {
    await C('Runtime.evaluate', { expression: `showPage('chat')` }, sessionId);
    await sleep(300);
  }
  const entrySel = VIEW === 'chat' ? '.bl-drw-leaf' : '[onclick="openButlerDrawer()"]';
  await C('Runtime.evaluate', { expression: `document.querySelector('${entrySel}').click()` }, sessionId);
  await sleep(1800);

  const shot = await C('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
  writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('截图已保存:', OUT, `(${VIEW})`);
} catch (e) {
  console.error('截图失败:', e.stack || e.message);
  process.exitCode = 1;
} finally {
  try { ws && ws.close(); } catch {}
  try { browser.kill(); } catch {}
}
