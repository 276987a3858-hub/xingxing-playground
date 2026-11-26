/* tests/butler/remind-smoke.mjs — 真实浏览器冒烟：页面可加载、提前提醒只触发一次（隔离的临时 profile，不碰真实数据） */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9334;
const BASE = process.argv[2] || 'http://127.0.0.1:8787';

const proc = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${process.env.TEMP || '.'}\\bl-remind-prof`,
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
const errors = [];
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const mid = ++id;
    waiters.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}

try {
  await devtools();
  let target = null;
  for (let i = 0; i < 20 && !target; i++) {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === 'page');
    if (!target) await sleep(200);
  }
  if (!target) throw new Error('没有可用的页面 target');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && waiters.has(msg.id)) {
      const w = waiters.get(msg.id); waiters.delete(msg.id);
      msg.error ? w.reject(new Error(msg.error.message)) : w.resolve(msg.result);
    }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text || 'exception');
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(2500);

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result.value;
  };

  const out = await evalJs(`(async () => {
    const res = { has: typeof window.ButlerIntent?.remindContext, clock: [ButlerIntent.needsClockContext('在吗'), ButlerIntent.needsClockContext('几点了')] };
    const m = await import('/butler/butler-repository.js');
    const pad = (n) => String(n).padStart(2, '0');
    const now = new Date();
    const soon = new Date(Date.now() + 5 * 60000);
    const date = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
    if (date !== soon.getFullYear() + '-' + pad(soon.getMonth() + 1) + '-' + pad(soon.getDate())) return { ...res, skip: true };
    await m.repository.addTask({ title: '冒烟洗衣', date, time: pad(soon.getHours()) + ':' + pad(soon.getMinutes()) });
    const first = await ButlerIntent.remindContext();
    const second = await ButlerIntent.remindContext();
    return { ...res, first, second };
  })()`);

  const ok = out.has === 'function' && out.clock[0] === false && out.clock[1] === true && !errors.length &&
    (out.skip || (String(out.first).includes('冒烟洗衣') && out.second === ''));
  console.log('S01 页面加载无报错：', errors.length === 0 ? 'ok' : 'FAIL ' + errors.join(' | '));
  console.log('S02 remindContext 可用：', out.has === 'function' ? 'ok' : 'FAIL');
  console.log('S03 闲聊/问时间判断：', out.clock[0] === false && out.clock[1] === true ? 'ok' : 'FAIL ' + JSON.stringify(out.clock));
  console.log('S04 提前提醒一次：', out.skip ? 'skip(近午夜)' : (String(out.first).includes('冒烟洗衣') && out.second === '' ? 'ok' : 'FAIL ' + JSON.stringify(out.first) + '/' + JSON.stringify(out.second)));
  console.log('S05 提醒文案：', out.skip ? 'skip' : (String(out.first).includes('只说这一次') ? 'ok' : 'FAIL'));
  console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
  process.exitCode = ok ? 0 : 1;
} catch (e) {
  console.error('SMOKE ERROR', e.message);
  process.exitCode = 1;
} finally {
  try { ws && ws.close(); } catch {}
  proc.kill();
}
