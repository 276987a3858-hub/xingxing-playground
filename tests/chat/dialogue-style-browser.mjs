/* tests/chat/dialogue-style-browser.mjs
 * 统一对话表达规范的真实页面回归（零真实 AI 请求）。
 * 用页面真实的 dailyGreet / callSpecialAI / callStar 发请求，截获 /api 的 messages，
 * 验证：规范每条请求恰好一次；业务提示保留；未开启 dialogue 的调用方不继承规则。
 */
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = path.resolve('public');
const PORT = 9561, CDP = 9562;
const reqs = [];

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = {}; try { parsed = JSON.parse(body); } catch {}
      const msgs = parsed.messages || [];
      reqs.push({
        roleSeq: msgs.map((m) => m.role).join(','),
        sys1: String(msgs[0]?.content || ''),
        sysAll: msgs.filter((m) => m.role === 'system').map((m) => String(m.content || '')).join('\n'),
        last: msgs[msgs.length - 1]
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '嗯。' } }] }));
    });
    return;
  }
  let p = decodeURIComponent(u.pathname); if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !existsSync(f)) { res.writeHead(404); res.end(); return; }
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.txt': 'text/plain' }[path.extname(f)] || 'application/octet-stream';
  res.writeHead(200, { 'content-type': mime }); res.end(readFileSync(f));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };
const count = (s, sub) => String(s).split(sub).length - 1;
const TAG = '【对话的写法】';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.join(tmpdir(), 'dialogue-style-' + Date.now());
const browser = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });

let ws;
try {
  let info = null;
  for (let i = 0; i < 40 && !info; i++) { try { const r = await fetch(`http://127.0.0.1:${CDP}/json/version`); if (r.ok) info = await r.json(); } catch {} if (!info) await sleep(250); }
  if (!info) throw new Error('DevTools 未就绪');
  ws = await new Promise((res, rej) => { const s = new WebSocket(info.webSocketDebuggerUrl); s.onopen = () => res(s); s.onerror = rej; });
  const pending = new Map(); let id = 0, sid = null;
  const errors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); return; }
    if (m.method === 'Runtime.exceptionThrown' && m.sessionId === sid) errors.push(String(m.params.exceptionDetails?.exception?.description || ''));
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    id++; pending.set(id, { resolve, reject });
    const p = { id, method, params }; if (sid && !method.startsWith('Target.')) p.sessionId = sid;
    ws.send(JSON.stringify(p)); setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('超时 ' + method)); } }, 20000);
  });
  const ev = async (expr) => {
    const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  sid = (await call('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  await call('Page.enable'); await call('Runtime.enable');
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const of = window.fetch.bind(window);
    window.fetch = (url, opts) => {
      if (typeof url === 'string' && url.includes('wttr.in')) {
        return Promise.resolve(new Response(JSON.stringify({ current_condition: [{ weatherDesc: [{ value: '晴朗' }] }] }), { headers: { 'content-type': 'application/json' } }));
      }
      return of(url, opts);
    };
  })();` });
  await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
  for (let i = 0; i < 60; i++) { const ready = await ev(`(() => typeof dailyGreet === 'function' && typeof callSpecialAI === 'function' && typeof window.Persona?.baseText === 'function')()`).catch(() => false); if (ready) break; await sleep(250); }

  await ev(`(() => {
    apiKey = 'stub-key';
    settings.showEnglish = false; settings.voiceEnabled = false;
    requestAndPlaySpeech = function(){ return Promise.resolve(''); };
    if (window.LifeScheduler && window.LifeScheduler.stop) window.LifeScheduler.stop();
    if (window.LifePresence && window.LifePresence.stop) { try { window.LifePresence.stop(); } catch(e){} }
    return true;
  })()`);

  // 1) 早晚安
  reqs.length = 0;
  const gres = await ev(`dailyGreet('morning').then(() => 'ok').catch(e => 'ERR:' + (e && e.message))`);
  await sleep(400);
  const gstate = await ev(`JSON.stringify({apiKey: typeof apiKey === 'string' ? apiKey : 'undefined', isSending: typeof isSending, sending: !!isSending})`);
  const greet = reqs.filter((r) => String(r.last && r.last.content || '').includes('用户向你道早安'));
  check('G1 早晚安真实走到 /api', greet.length === 1, `捕获 ${greet.length}`);
  if (greet.length) {
    const g = greet[0];
    check('G2 早晚安请求里规范恰好一次', count(g.sysAll, TAG) === 1, count(g.sysAll, TAG));
    check('G3 早晚安业务提示保留', g.last && String(g.last.content).includes('用户向你道早安'));
    check('G4 早晚安仍有 2 条 system 且结构不变', count(g.roleSeq, 'system') === 2, g.roleSeq);
  }

  // 2) callSpecialAI 显式开启 / 未开启
  reqs.length = 0;
  await ev(`callSpecialAI('探针：对话口径', { dialogue: true })`);
  await sleep(150);
  const on = reqs[reqs.length - 1];
  check('G5 开启 dialogue 的 callSpecialAI 注入规范一次', on && count(on.sysAll, TAG) === 1, on ? count(on.sysAll, TAG) : 'no-req');

  reqs.length = 0;
  await ev(`callSpecialAI('探针：普通互动', {})`);
  await sleep(150);
  const off = reqs[reqs.length - 1];
  check('G6 未开启 dialogue 的调用方不继承规范', off && count(off.sysAll, TAG) === 0, off ? count(off.sysAll, TAG) : 'no-req');

  // 3) callStar 默认不带规范（珍藏判定的入口）
  reqs.length = 0;
  await ev(`callStar('探针：珍藏判定', 5)`);
  await sleep(150);
  const star = reqs[reqs.length - 1];
  check('G7 callStar 默认路径不继承规范', star && count(star.sysAll, TAG) === 0, star ? count(star.sysAll, TAG) : 'no-req');

  // 4) 主聊天页面级（与 close-talk 测试口径一致，这里只确认控制组）
  check('G8 页面无运行时异常', errors.length === 0, errors.slice(0, 1).join(''));
} finally {
  try { ws && ws.close(); } catch {}
  try { browser.kill(); } catch {}
  server.close();
}

const pass = results.filter(Boolean).length, total = results.length;
console.log(`\n总计 ${total} 项：通过 ${pass}，失败 ${total - pass}`);
process.exit(pass === total ? 0 : 1);
