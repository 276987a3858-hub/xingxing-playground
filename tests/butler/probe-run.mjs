/* tests/butler/probe-run.mjs — 在真实 Chromium 里执行 v2 探针，抓第一条真实异常，并验证包装与写入链路（隔离 profile，不调 AI） */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9338;
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const PROBE = readFileSync(new URL('./probe-v2.js', import.meta.url), 'utf8');

const proc = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${process.env.TEMP || '.'}\\bl-probe-prof2`,
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
const pageErrors = [];
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
  if (!target) throw new Error('没有可用页面');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && waiters.has(msg.id)) {
      const w = waiters.get(msg.id); waiters.delete(msg.id);
      msg.error ? w.reject(new Error(msg.error.message)) : w.resolve(msg.result);
    }
    if (msg.method === 'Runtime.exceptionThrown') pageErrors.push(msg.params.exceptionDetails.text || 'exception');
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(2500);

  /* 用 rawEval：不抛异常，把真实 exceptionDetails 原样带回来 */
  const rawEval = async (expr, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) {
      const ex = r.exceptionDetails.exception || {};
      return { ok: false, text: r.exceptionDetails.text, desc: ex.description || ex.value || '', line: r.exceptionDetails.lineNumber };
    }
    return { ok: true, value: r.result.value, type: r.result.type };
  };

  console.log('--- P1 注入探针（原样 v2 源码） ---');
  const p1 = await rawEval(PROBE, false);
  console.log(p1.ok ? 'P1 返回: ' + JSON.stringify(p1.value) : 'P1 异常: ' + p1.text + ' | ' + p1.desc);

  console.log('--- P2 window.__S 是否存在 ---');
  const p2 = await rawEval(`({ hasS: typeof window.__S, status: window.__S && window.__S.status, hasFix: window.__S && window.__S.ver && window.__S.ver.hasFix })`);
  console.log('P2:', JSON.stringify(p2.value || p2.desc));

  console.log('--- P3 等 __S.ready，检查 repo 包装 ---');
  const p3 = await rawEval(`(async () => { if (!window.__S) return 'no-S'; if (window.__S.ready) { try { await window.__S.ready; } catch (e) { return 'ready-reject: ' + e.message; } } return { status: window.__S.status, repoReady: window.__S.repoReady, importError: window.__S.importError }; })()`);
  console.log('P3:', JSON.stringify(p3.value || p3.desc));

  console.log('--- P4 包装是否生效：gate + addTask 是否被记录 ---');
  const p4 = await rawEval(`(async () => {
    const BI = window.ButlerIntent, S = window.__S;
    const g = BI.gate('提醒我十五分钟后喝水');
    const before = (await (await import('/butler/butler-repository.js')).repository.listTasks()).length;
    return { gate: g, msgsAfterGate: S.msgs.length, addLen: S.add.length, before, wrapGate: typeof BI.gate, wrapHandle: BI.handleAIResponse.length };
  })()`);
  console.log('P4:', JSON.stringify(p4.value || p4.desc));

  console.log('--- P5 有标记路径（假模型响应，不发 AI 请求） ---');
  const p5 = await rawEval(`(async () => {
    const BI = window.ButlerIntent, S = window.__S;
    const base = Date.now();
    const raw = '<bl>{"op":"task_add","title":"喝水","date":"today","time":"15:30"}</bl>好，记下了。 ||| ok';
    const out = await BI.handleAIResponse(raw, '提醒我十五分钟后喝水', base);
    const rec = S.msgs.filter(m => m.step === 'handle').pop();
    return { out: String(out).slice(0, 120), marker: rec && rec.hasMarker, title: rec && rec.title, add: S.add.length, lastAdd: S.add[S.add.length-1] && { ok: S.add[S.add.length-1].ok, title: S.add[S.add.length-1].input.title, time: S.add[S.add.length-1].input.time, after: S.add[S.add.length-1].countAfter } };
  })()`);
  console.log('P5:', JSON.stringify(p5.value || p5.desc));

  console.log('--- P6 无标记兜底路径（假模型响应，不发 AI 请求） ---');
  const p6 = await rawEval(`(async () => {
    const BI = window.ButlerIntent, S = window.__S;
    const base = Date.now();
    const out = await BI.handleAIResponse('好，十五分钟后叫你喝水。 ||| ok', '提醒我十五分钟后喝水', base);
    const rec = S.msgs.filter(m => m.step === 'handle').pop();
    const repo = (await import('/butler/butler-repository.js')).repository;
    const rows = await repo.listTasks();
    return { out: String(out).slice(0, 140), marker: rec && rec.hasMarker, title: rec && rec.title, rel: rec && rec.rel, total: rows.length, titles: rows.map(r => r.title + '@' + r.date + ' ' + r.time) };
  })()`);
  console.log('P6:', JSON.stringify(p6.value || p6.desc));

  console.log('--- P8 标记缺 time / 写成相对时间（假响应） ---');
  const p8 = await rawEval(`(async () => {
    const BI = window.ButlerIntent, S = window.__S, base = Date.now();
    const a = await BI.handleAIResponse('<bl>{"op":"task_add","title":"喝水A","date":"today"}</bl>好 ||| ok', '提醒我十五分钟后喝水', base);
    const b = await BI.handleAIResponse('<bl>{"op":"task_add","title":"喝水B","date":"today","time":"15分钟后"}</bl>好 ||| ok', '提醒我十五分钟后喝水', base);
    const repo = (await import('/butler/butler-repository.js')).repository;
    const rows = await repo.listTasks();
    return { a: String(a).slice(0, 80), b: String(b).slice(0, 80), total: rows.length, titles: rows.map(r => r.title + '@' + r.time), adds: S.add.length };
  })()`);
  console.log('P8:', JSON.stringify(p8.value || p8.desc));

  console.log('--- P9 真实浏览器验证：幂等 + 解析失败出声 ---');
  const p9 = await rawEval(`(async () => {
    const BI = window.ButlerIntent;
    const repo = (await import('/butler/butler-repository.js')).repository;
    BI._resetHandled();
    const before = (await repo.listTasks()).length;
    const base = Date.now();
    const a = await BI.handleAIResponse('好，叫你。 ||| ok', '提醒我十五分钟后喝水', base);
    const b = await BI.handleAIResponse('好，叫你。 ||| ok', '提醒我十五分钟后喝水', base);
    const mid = (await repo.listTasks()).length;
    BI._resetHandled();
    const c = await BI.handleAIResponse('行，记着了。 ||| ok', '提醒我十五分钟后', base + 1000);
    const after = (await repo.listTasks()).length;
    BI._resetHandled();
    const d = await BI.handleAIResponse('好，记着了。 ||| ok', '再提醒我五点钟去吃饭', base + 2000);
    const after2 = (await repo.listTasks()).length;
    return { before, mid, after, add: mid - before,
      aHasOk: /记好了/.test(a), bDup: b, cOut: String(c), cHasFail: /没记下来/.test(String(c)),
      dOut: String(d), dAsk: /上午还是下午/.test(String(d)), after2, dNoWrite: after2 === after };
  })()`);
  console.log('P9:', JSON.stringify(p9.value || p9.desc));

  console.log('--- P7 页面自身报错 ---');
  console.log('P7:', pageErrors.length ? pageErrors.join(' | ') : '无');
} catch (e) {
  console.error('RUN ERROR', e.message);
  process.exitCode = 1;
} finally {
  try { ws && ws.close(); } catch {}
  proc.kill();
}
