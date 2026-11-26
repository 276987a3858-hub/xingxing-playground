/* tests/butler/screenshot.mjs — 用本机 Edge 截图生活管家页面 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9344;
const BASE = process.argv[2] || 'http://127.0.0.1:8799';
const OUT = process.argv[3] || 'butler-preview.png';
const VIEW = process.argv[4] || 'desktop';

const profile = `${process.env.TEMP}\\butler-shot-${Date.now()}-${VIEW}`;
const browser = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--hide-scrollbars',
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
  const C = (method, params = {}, sessionId) => { id++; return new Promise((res, rej) => { pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 15000); }); };

  const { targetId } = await C('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await C('Target.attachToTarget', { targetId, flatten: true });
  await C('Page.enable', {}, sessionId);
  if (VIEW === 'mobile') await C('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sessionId);
  else await C('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1400, deviceScaleFactor: 1, mobile: false }, sessionId);
  await C('Page.navigate', { url: `${BASE}/butler/` }, sessionId);
  await sleep(1800);

  // 造一点演示数据，让截图能看到真实功能（仅在该临时浏览器 profile 内）
  await C('Runtime.evaluate', {
    expression: `(async () => {
      const m = await import('/butler/butler-repository.js');
      const today = new Date();
      const ds = (n) => { const d = new Date(today); d.setDate(d.getDate()+n);
        return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };
      await m.repository.addTask({ title: '整理房间', date: ds(0), time: '09:30' });
      const t = await m.repository.addTask({ title: '给妈妈打电话', date: ds(0), time: '20:00' });
      await m.repository.addTask({ title: '整理账单', date: ds(-1), time: '18:00' });
      await m.repository.saveSleep({ date: ds(0), sleepTime: '23:30', wakeTime: '07:30', note: '睡得不错' });
      await m.repository.addCycle({ startDate: '2026-08-01', endDate: '2026-08-06', state: '疲惫', symptoms: ['腹痛'] });
      await m.repository.addCycle({ startDate: '2026-09-01', endDate: '2026-09-06' });
      await m.repository.addCycle({ startDate: '2026-10-02', endDate: '2026-10-07', symptoms: ['头痛'] });
      document.querySelector('[data-tab="today"]')?.click();
    })()`, awaitPromise: true,
  }, sessionId);
  await sleep(600);

  const shot = await C('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
  writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('截图已保存:', OUT);
} catch (e) {
  console.error('截图失败:', e.stack || e.message);
  process.exitCode = 1;
} finally {
  try { ws && ws.close(); } catch {}
  try { browser.kill(); } catch {}
}
