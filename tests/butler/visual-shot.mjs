/* tests/butler/visual-shot.mjs — 视觉验收截图（真实 Edge）
 * 用法：node tests/butler/visual-shot.mjs <base> <outPrefix> <desktop|mobile>
 * 产出：<outPrefix>-today.png / <outPrefix>-cycle.png
 * 同时检测 iframe 内是否出现横向溢出。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9361;
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const OUT = process.argv[3] || 'screenshots/butler-visual';
const VIEW = process.argv[4] || 'desktop';
const TAB = process.argv[5] || 'today';

const browser = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.env.TEMP}\\butler-visual-${Date.now()}`,
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
  const C = (method, params = {}, sid) => { id++; return new Promise((res, rej) => { pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) })); setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 20000); }); };

  const { targetId } = await C('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await C('Target.attachToTarget', { targetId, flatten: true });
  await C('Page.enable', {}, sessionId);
  await C('Runtime.enable', {}, sessionId);
  if (VIEW === 'mobile') await C('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sessionId);
  else await C('Emulation.setDeviceMetricsOverride', { width: 1280, height: 880, deviceScaleFactor: 1, mobile: false }, sessionId);

  await C('Page.navigate', { url: `${BASE}/` }, sessionId);
  await sleep(1200);

  // 造数据：今日 2 条待办 + 1 条逾期 + 作息 + 3 条周期（验证预测卡与溢出）
  await C('Runtime.evaluate', { expression: `(async () => {
    const m = await import('/butler/butler-repository.js');
    const d = new Date(); const ds = (n) => { const x=new Date(d); x.setDate(x.getDate()+n);
      return x.getFullYear()+'-'+String(x.getMonth()+1).padStart(2,'0')+'-'+String(x.getDate()).padStart(2,'0'); };
    await m.repository.addTask({ title: '整理房间', date: ds(0), time: '09:30', type: 'todo' });
    await m.repository.addTask({ title: '和妈妈打电话', date: ds(0), time: '20:00', type: 'event' });
    await m.repository.addTask({ title: '交房租', date: ds(-2), type: 'todo', note: '记得问一下物业' });
    await m.repository.saveSleep({ date: ds(0), sleepTime: '23:30', wakeTime: '07:30' });
    await m.repository.addCycle({ startDate: ds(-62), endDate: ds(-57) });
    await m.repository.addCycle({ startDate: ds(-33), endDate: ds(-28) });
    await m.repository.addCycle({ startDate: ds(-4), endDate: ds(1) });
    await m.repository.addTransaction({ type: 'expense', amount: 12.5, category: '餐饮', date: ds(0), note: '午饭' });
    await m.repository.addTransaction({ type: 'expense', amount: 20, category: '购物', date: ds(0), note: '水果' });
    await m.repository.addTransaction({ type: 'expense', amount: 5, category: '交通', date: ds(-1), note: '公交' });
    await m.repository.addTransaction({ type: 'expense', amount: 68, category: '娱乐', date: ds(-3), note: '电影' });
  })()`, awaitPromise: true }, sessionId);
  await sleep(200);

  // 点房间顶栏的叶子入口（真实入口路径）
  await C('Runtime.evaluate', { expression: `document.querySelector('.bl-drw-leaf').click()` }, sessionId);
  await sleep(1900);
  if (TAB !== 'today') {
    await C('Runtime.evaluate', { expression: `(() => { const f=document.getElementById('butlerFrame');
      f.contentDocument.querySelector('.tab[data-tab="${TAB}"]').click(); })()` }, sessionId);
    await sleep(700);
  }

  const shotToday = await C('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
  writeFileSync(`${OUT}-today.png`, Buffer.from(shotToday.data, 'base64'));

  // 溢出检测 + 视觉关键点
  const probe = await C('Runtime.evaluate', { expression: `(() => {
    const f = document.getElementById('butlerFrame');
    const doc = f.contentDocument, w = f.contentWindow;
    const de = doc.documentElement;
    const statRow = doc.querySelector('.stat-row');
    const greet = doc.querySelector('.greet-line');
    const leaf = document.querySelector('.bl-drw-leaf').getBoundingClientRect();
    const topbarHidden = (() => { const t = doc.querySelector('.topbar'); return t ? getComputedStyle(t).display : 'missing'; })();
    return {
      overflowX: de.scrollWidth - de.clientWidth,
      innerWidth: w.innerWidth,
      statText: statRow ? statRow.textContent.replace(/\\s+/g,' ').trim() : '',
      greet: greet ? greet.textContent.trim() : '',
      topbarDisplay: topbarHidden,
      leafW: Math.round(leaf.width), leafH: Math.round(leaf.height),
      tileCount: document.querySelectorAll('#home .grid .tile').length,
    };
  })()`, returnByValue: true }, sessionId);
  console.log('探针:', JSON.stringify(probe.result.value));

  // 切到「周期」看预测卡
  await C('Runtime.evaluate', { expression: `(() => { const f=document.getElementById('butlerFrame');
    f.contentDocument.querySelector('.tab[data-tab="cycle"]').click(); })()` }, sessionId);
  await sleep(700);
  const shotCycle = await C('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
  writeFileSync(`${OUT}-cycle.png`, Buffer.from(shotCycle.data, 'base64'));

  const probe2 = await C('Runtime.evaluate', { expression: `(() => { const doc=document.getElementById('butlerFrame').contentDocument;
    const de=doc.documentElement; const p=doc.querySelector('.prediction-card');
    return { overflowX: de.scrollWidth-de.clientWidth, pred: p ? p.textContent.replace(/\\s+/g,' ').trim().slice(0,90) : '' }; })()`, returnByValue: true }, sessionId);
  console.log('周期页探针:', JSON.stringify(probe2.result.value));

  console.log('截图已保存:', `${OUT}-today.png`, `${OUT}-cycle.png`, `(${VIEW})`);
} catch (e) {
  console.error('截图失败:', e.stack || e.message);
  process.exitCode = 1;
} finally {
  try { ws && ws.close(); } catch {}
  try { browser.kill(); } catch {}
}
