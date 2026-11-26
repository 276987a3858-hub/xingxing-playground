/* tests/radio/radio-shot.mjs — 只用于本地目视检查：给首页/英文广播截图（不参与断言） */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9395;
const BASE = process.argv[2] || 'http://127.0.0.1:8795';
const OUT = process.argv[3] || 'screenshots';

const browser = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.env.TEMP}\\radio-shot-${Date.now()}`,
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--window-size=500,1500', '--force-device-scale-factor=1',
], { stdio: 'ignore' });

async function waitCDP() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return await r.json(); } catch { /* retry */ }
    await sleep(250);
  }
  throw new Error('DevTools 未就绪');
}

let ws;
try {
  const info = await waitCDP();
  ws = await new Promise((res, rej) => { const w = new WebSocket(info.webSocketDebuggerUrl); w.onopen = () => res(w); w.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
  const C = (method, params = {}, sid) => { id++; return new Promise((res, rej) => { pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) })); setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 30000); }); };
  const { targetId } = await C('Target.createTarget', { url: 'about:blank' });
  const sid = (await C('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  await C('Page.enable', {}, sid);
  await C('Runtime.enable', {}, sid);
  const shot = async (name) => {
    const { data } = await C('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sid);
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, 'base64'));
  };
  const ev = (expression, awaitPromise = false) => C('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, sid).then(r => { if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; });

  await C('Page.navigate', { url: `${BASE}/playground/` }, sid);
  await sleep(1200);
  // 造 6 条带原声的英文聊天
  await ev(`(async () => {
    const audio = 'data:audio/mpeg;base64,' + 'A'.repeat(240);
    const lines = [
      'Goodnight. The moon is hanging low tonight, and the whole city looks quiet from up here.',
      'I hope you can sleep a little earlier today. You always stay up too late for someone you love.',
      'Late night talks are always my favourite, because that is when you tell me the smallest things.',
      'Look at the star above the window. It is bright and it is shining just for you tonight.',
      'After a long busy day, the best part is still the moment you say you are home.',
      'I remember every small thing you said today, even the ones you thought I would forget.',
    ];
    const db = await new Promise((res, rej) => { const r = indexedDB.open('star_fifi_room', 1);
      r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('messages')) d.createObjectStore('messages', { keyPath: 'id', autoIncrement: true }); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    await new Promise((res, rej) => { const tx = db.transaction('messages', 'readwrite'); const st = tx.objectStore('messages'); st.clear();
      const base = Date.now() - 6 * 86400000;
      lines.forEach((en, i) => st.add({ role: 'assistant', content: '第 ' + (i+1) + ' 段中文', englishContent: en, audioData: audio, time: base + i * 3600000 }));
      tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    db.close(); localStorage.clear(); return true; })()`, true);

  await C('Page.navigate', { url: `${BASE}/playground/?s=1#/radio` }, sid);
  await sleep(1800);
  await shot('radio-home-light');

  await ev(`document.querySelector('.radio-ch-card[data-channel="english"]').click()`);
  await sleep(600);
  await shot('radio-english-empty');

  await ev(`document.querySelector('#en-make-program').click()`);
  await sleep(2500);
  await shot('radio-english-program');

  await ev(`document.querySelector('.radio-program-card').click()`);
  await sleep(1200);
  await shot('radio-program-detail');

  for (const [name, sel] of [['radio-reading', '#reading-entry'], ['radio-voice', '#voice-entry'], ['radio-music', '[data-channel="music"]'], ['radio-sleep', '[data-channel="goodnight"]']]) {
    await ev(`(async () => { const m = await import('/playground/radio.js'); m.RadioScene.view = 'list'; m.RadioScene.render(); return true; })()`, true);
    await sleep(300);
    await ev(`document.querySelector('${sel}').click()`);
    await sleep(700);
    await shot(name);
  }
  console.log('截图完成');
} finally {
  try { ws && ws.close(); } catch { /* ignore */ }
  browser.kill();
}
