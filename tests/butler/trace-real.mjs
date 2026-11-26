/* tests/butler/trace-real.mjs — 真实链路追踪：页面输入 → sendMessage → handleAIResponse → IndexedDB
 * 只做观测：注入的包装函数仅记录入参与返回值，不改业务逻辑；隔离临时 profile，不碰真实数据。 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9336;
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const USER_TEXT = process.argv[3] || '不玩啦，提醒我去午休，十五分钟后吧。';

const PROF = `${process.env.TEMP || '.'}\\bl-trace-prof-${Date.now()}`;
const proc = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROF}`,
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--window-size=1280,900', 'about:blank',
], { stdio: 'ignore' });

async function devtools() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return r.json(); } catch {}
    await sleep(250);
  }
  throw new Error('DevTools 未就绪');
}

let ws, id = 0;
const waiters = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const mid = ++id;
    waiters.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}

let evalJs;
const log = (t, v) => console.log(`[${t}]`, typeof v === 'string' ? v : JSON.stringify(v));

try {
  await devtools();
  let target = null;
  for (let i = 0; i < 20 && !target; i++) {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === 'page');
    if (!target) await sleep(200);
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && waiters.has(msg.id)) {
      const w = waiters.get(msg.id); waiters.delete(msg.id);
      msg.error ? w.reject(new Error(msg.error.message)) : w.resolve(msg.result);
    }
  };
  await send('Runtime.enable'); await send('Page.enable');

  evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result.value;
  };

  // 1. 首次加载，让 app.js 建好库
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(3000);

  // 2. 写入一个 apiKey（Worker 用 env 里的真 key，这里只要非空即可），再刷新
  log('setApiKey', await evalJs(`(async () => new Promise((res) => {
    const r = indexedDB.open('star_fifi_room');
    r.onsuccess = () => { const db = r.result;
      try { const tx = db.transaction('kv','readwrite'); tx.objectStore('kv').put('trace-key','apiKey');
        tx.oncomplete = () => res('ok'); tx.onerror = () => res('tx-error'); } catch (e) { res('throw:'+e.message); } };
    r.onerror = () => res('open-error');
  }))()`));

  await send('Page.navigate', { url: BASE + '/' });
  await sleep(3000);

  // 3. 确认脚本版本 + 装载追踪
  log('scriptHasAbsoluteTarget', await evalJs(`fetch('/butler/butler-intent.js').then(r=>r.text()).then(t=>t.includes('absoluteTarget'))`));
  log('butlerLoaded', await evalJs(`typeof window.ButlerIntent`));
  log('handleAILength', await evalJs(`window.ButlerIntent && window.ButlerIntent.handleAIResponse.length`));
  log('dbsBefore', await evalJs(`indexedDB.databases().then(l=>l.map(d=>({name:d.name,ver:d.version})))`));

  log('hook', await evalJs(`(() => {
    const BI = window.ButlerIntent;
    if (!BI) return 'no-butler';
    const orig = BI.handleAIResponse;
    window.__T = [];
    BI.handleAIResponse = async function (raw, text, baseMs) {
      const rec = { rawReply: String(raw||'').slice(0,400), text, baseMs, baseType: typeof baseMs,
        hasMarker: /<bl>/.test(String(raw||'')), gate: BI.gate(text),
        rel: null, abs: null, title: '', out: null, err: null };
      try { rec.rel = BI.relativeTarget(text, baseMs); } catch (e) { rec.rel = 'ERR:'+e.message; }
      try { rec.abs = BI.absoluteTarget(text, baseMs); } catch (e) { rec.abs = 'ERR:'+e.message; }
      try { rec.title = BI.reminderTitleFrom(text); } catch (e) { rec.title = 'ERR:'+e.message; }
      window.__T.push(rec);
      try { rec.out = await orig.call(BI, raw, text, baseMs); } catch (e) { rec.err = String(e); return raw; }
      return rec.out;
    };
    return 'hooked';
  })()`));

  // 4. 真实发消息
  log('send', await evalJs(`(() => {
    const el = document.getElementById('chatInput');
    if (!el) return 'no-input';
    el.value = ${JSON.stringify(USER_TEXT)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    window.sendMessage();
    return 'sent';
  })()`));

  // 5. 等 handleAIResponse 被调用
  let trace = null;
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    trace = await evalJs(`window.__T && window.__T.length`);
    if (trace) break;
  }
  log('traceHandlerCalled', trace);

  const rec = await evalJs(`window.__T && window.__T[0] ? window.__T[0] : null`);
  log('traceRecord', rec);

  await sleep(1500);
  log('dbsAfter', await evalJs(`indexedDB.databases().then(l=>l.map(d=>({name:d.name,ver:d.version})))`));
  log('afterTasks', await evalJs(`(async () => {
    const list = await indexedDB.databases();
    const hit = list.find(d => d.name === 'star_butler_v1');
    if (!hit) return 'no-db';
    return await new Promise((res) => {
      const r = indexedDB.open('star_butler_v1', hit.version);
      r.onsuccess = () => { const db = r.result;
        if (!db.objectStoreNames.contains('tasks')) { db.close(); return res('no-tasks-store:' + [...db.objectStoreNames]); }
        const q = db.transaction('tasks','readonly').objectStore('tasks').getAll();
        q.onsuccess = () => { const rows = q.result.map(t=>({title:t.title,date:t.date,time:t.time,status:t.status})); db.close(); res(rows); };
        q.onerror = () => { db.close(); res('q-err'); };
      };
      r.onerror = () => res('open-err'); r.onblocked = () => res('blocked');
    });
  })()`));
  log('lastAssistant', await evalJs(`(() => {
    const nodes = [...document.querySelectorAll('#chatMessages > *, .messages > *')];
    const texts = nodes.map(n => (n.textContent || '').trim()).filter(Boolean);
    return texts.slice(-2).map(t => t.slice(0, 220));
  })()`));
} catch (e) {
  console.error('TRACE FAILED:', e.message);
  process.exitCode = 1;
} finally {
  try { ws && ws.close(); } catch {}
  proc.kill();
}
