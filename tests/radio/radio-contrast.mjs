/* tests/radio/radio-contrast.mjs — 浅色化后逐个视图做可读性体检（低对比文字排查） */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9397;
const BASE = process.argv[2] || 'http://127.0.0.1:8795';

const browser = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.env.TEMP}\\radio-contrast-${Date.now()}`,
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--window-size=500,1400',
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
  const ev = (expression, awaitPromise = false) => C('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, sid).then(r => { if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; });

  await C('Page.navigate', { url: `${BASE}/playground/?c=1#/radio` }, sid);
  await sleep(1500);

  const AUDIT = `(() => {
    const parse = c => { const m = String(c).match(/[\\d.]+/g); if (!m) return null; const [r,g,b,a] = m.map(Number); return { r, g, b, a: a === undefined ? 1 : a }; };
    const lum = c => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }; return .2126*f(c.r) + .7152*f(c.g) + .0722*f(c.b); };
    const blend = (top, bot) => ({ r: top.r*top.a + bot.r*(1-top.a), g: top.g*top.a + bot.g*(1-top.a), b: top.b*top.a + bot.b*(1-top.a), a: 1 });
    // 渐变按钮的实际底色靠 background-image，backgroundColor 是透明的；按渐变色取均值，避免误报
    const gradBg = el => {
      const bi = getComputedStyle(el).backgroundImage;
      if (!bi || bi.indexOf('gradient') < 0) return null;
      const cols = [];
      (bi.match(/#[0-9a-fA-F]{3,8}/g) || []).forEach(h => {
        let s = h.slice(1);
        if (s.length === 3) s = s.split('').map(c => c + c).join('');
        cols.push({ r: parseInt(s.slice(0,2),16), g: parseInt(s.slice(2,4),16), b: parseInt(s.slice(4,6),16), a: 1 });
      });
      (bi.match(/rgba?\([^)]+\)/g) || []).forEach(s => { const p = parse(s); if (p) cols.push(p); });
      const solid = cols.filter(c => c.a > .5);
      if (!solid.length) return null;
      const n = solid.length;
      return { r: solid.reduce((a,c)=>a+c.r,0)/n, g: solid.reduce((a,c)=>a+c.g,0)/n, b: solid.reduce((a,c)=>a+c.b,0)/n, a: 1 };
    };
    const bgOf = el => {
      let cur = el, acc = null;
      while (cur && cur !== document.documentElement) {
        const g = gradBg(cur);
        if (g && acc) acc = blend(acc, g); else if (g) acc = g;
        else { const c = parse(getComputedStyle(cur).backgroundColor); if (c && c.a > 0) acc = acc ? blend(acc, c) : c; }
        if (acc && acc.a >= .999) break;
        cur = cur.parentElement;
      }
      return acc ? blend(acc, { r: 238, g: 240, b: 249, a: 1 }) : { r: 238, g: 240, b: 249, a: 1 };
    };
    const out = [];
    document.querySelectorAll('.radio-scene *').forEach(el => {
      const own = Array.from(el.childNodes).some(n => n.nodeType === 3 && n.textContent.trim().length > 1);
      if (!own) return;
      const st = getComputedStyle(el);
      if (st.opacity === '0' || st.display === 'none' || st.visibility === 'hidden') return;
      if (parseFloat(st.fontSize) < 9) return;
      const fg = parse(st.color); if (!fg) return;
      const bg = bgOf(el);
      const l1 = lum(fg), l2 = lum(bg);
      const ratio = (Math.max(l1, l2) + .05) / (Math.min(l1, l2) + .05);
      if (ratio < 2.4) out.push({ sel: el.className || el.tagName, txt: el.textContent.trim().slice(0, 26), ratio: Math.round(ratio * 100) / 100, color: st.color, bg: 'rgb(' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b) + ')' });
    });
    return out;
  })()`;

  const views = [
    ['首页', `document.querySelector('#radio-exit') && window.PlaygroundRouter.go('radio')`],
    ['英文广播', `document.querySelector('.radio-ch-card[data-channel="english"]').click()`],
    ['音乐频道', `document.querySelector('[data-channel="music"]').click()`],
    ['声音收藏馆', `document.querySelector('#voice-entry').click()`],
    ['阅读书架', `document.querySelector('#reading-entry').click()`],
    ['晚安哄睡', `document.querySelector('[data-channel="goodnight"]').click()`],
  ];

  for (const [name, act] of views) {
    await ev(`(async () => { const m = await import('/playground/radio.js'); m.RadioScene.view = 'list'; m.RadioScene.render(); return true; })()`, true);
    await sleep(300);
    try { await ev(act); } catch (e) { console.log(`  (${name} 打开失败: ${e.message.slice(0, 60)})`); }
    await sleep(500);
    const bad = await ev(AUDIT);
    if (!bad.length) console.log(`OK   ${name}: 无低对比文字`);
    else {
      console.log(`WARN ${name}: ${bad.length} 处对比度偏低`);
      bad.slice(0, 6).forEach(b => console.log(`     ${b.ratio} · ${b.txt} · ${b.color} on ${b.bg} · .${b.sel}`));
    }
  }
} finally {
  try { ws && ws.close(); } catch { /* ignore */ }
  browser.kill();
}
