/* tests/chat/touch-tone-browser.mjs
 * 触摸“减少重复 / 统一视角”的真实页面回归（零真实 AI 请求）。
 * 直接驱动 window.StarTouch.respond（真实触摸链路），截获发往 /api 的 system prompt，验证：
 *  - 次数只作为「心里有数」的底数注入，不再是每轮必报的播报指令；
 *  - 提示词允许在有互动意义时主动计数（逗弄/在意/观察/引出交流），但不强制、不固定句式；
 *  - 提示词不再用「她」指代用户（“她碰了碰你”），改用名字/第二人称；
 *  - 触摸链路已按事件注入第五层·实体触摸功能提示词（【功能·实体触摸】）；
 *  - 触摸提示词含“不必每次复述/别翻来覆去点评”与“稍长/转话题”的弹性，但不设固定句式。
 * 同时验证 getCloseTalkPrompt 视角规则（我/你）与“不反复强调同一要求”。
 */
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = path.resolve('public');
const PORT = 9531, CDP = 9532;
const reqs = [];

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = {}; try { parsed = JSON.parse(body); } catch {}
      // 取全部 system 消息：触摸事实块与统一规范分处 system#1 / system#2，只取首条会漏检
      const sys = (parsed.messages || []).filter(m => m.role === 'system').map(m => String(m.content || '')).join('\n');
      reqs.push({ sys, at: Date.now() });
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

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.join(tmpdir(), 'touch-tone-' + Date.now());
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
        return Promise.resolve(new Response(JSON.stringify({current_condition:[{weatherDesc:[{value:'晴朗'}]}]}), {headers:{'content-type':'application/json'}}));
      }
      return of(url, opts);
    };
  })();` });
  await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
  for (let i = 0; i < 60; i++) { const ready = await ev(`(() => !!(window.StarTouch && window.Persona && window.Persona.baseText && window.Persona.baseText().length))()`).catch(() => false); if (ready) break; await sleep(250); }

  // 打开触摸 AI 并注入假 key（仅内存，服务端为本地 stub，不发真实请求）
  await ev(`(() => {
    try { settings.touchAIEnabled = true; } catch(e) { window.settings.touchAIEnabled = true; }
    try { apiKey = 'stub-key'; } catch(e) {}
    try { window.Persona.reset(); } catch(e) {}
    return true;
  })()`);

  // 连续 3 次触摸
  for (let i = 0; i < 3; i++) {
    await ev(`window.StarTouch.respond({ id: 't${i}-' + Date.now(), zone: 'head', durMs: 1200 })`);
    await sleep(150);
  }
  const touchSys = reqs.map(r => r.sys).filter(s => s.includes('【刚刚的触碰】'));
  check('T01 三次触摸都真实走到模型请求', touchSys.length === 3, `实际 ${touchSys.length}`);

  const joined = touchSys.join('\n----\n');
  check('T02 不再是「今天她已经这样碰过你 N 次」式陈述型报数',
    !/今天她已经这样碰过你\s*\d+\s*次/.test(joined) && !/已经这样碰过你\s*\d+\s*次/.test(joined)
    && joined.includes('不必每次都说出口'));
  check('T03 不使用「她碰了碰你」第三人称指代用户',
    !touchSys.some(s => s.includes('她碰了碰你的')));
  check('T04 触摸事实块使用「用户…碰了碰你」的称呼', touchSys.every(s => s.includes('用户轻轻碰了碰你的')));
  check('T05 触摸链路已注入第五层·实体触摸功能提示词',
    touchSys.every(s => s.includes('【功能·实体触摸】')));
  check('T06 触摸提示含「不必每次复述/别翻来覆去点评」的降重复约束',
    touchSys.every(s => s.includes('不用每次都报一遍') && s.includes('翻来覆去')));
  check('T07 触摸提示允许简短/动作/转话题，且无固定句数硬要求',
    touchSys.every(s => s.includes('也只是一句很短的应答') || s.includes('一个动作')) &&
    !touchSys.some(s => /必须\s*\d+\s*句/.test(s)));
  check('T08 触摸提示含「我/你」视角规则',
    touchSys.every(s => s.includes('用「我」指你自己') && s.includes('用「你」指用户')));

  // 亲密提示词视角与降重复
  const close = await ev(`getCloseTalkPrompt()`);
  check('T09 亲密提示词不再重复视角规则（收口到统一规范）',
    !close.includes('第三人称') && !close.includes('用「我」指你自己'));
  check('T10 亲密提示词不再用「她说了」「把她留住」指代用户',
    !close.includes('她说了「不要」') && !close.includes('把她留住') && !close.includes('替她决定'));
  check('T11 亲密提示词含「同一意思不反复强调、应了就往下走」',
    close.includes('不用换几种说法反复强调') && close.includes('自然往下走'));

  // 四五层文本：不重复 + 视角
  const l4 = await ev(`window.Persona.relationship('我们接吻的时候','')`);
  const l5touch = await ev(`window.Persona.functionPrompt('touch')`);
  const l5int = await ev(`window.Persona.functionPrompt('intimate')`);
  check('T12 第四层含视角约定', l4.includes('以「我」指自己') && l4.includes('以「你」指用户'));
  check('T13 第四层含「不必换着说法反复强调」', l4.includes('不必换着说法反复强调'));
  check('T14 第五层触摸段保留降重复，视角句已移除',
    l5touch.includes('不必每次都复述或点评') && !l5touch.includes('第三人称'));
  check('T15 第五层亲密段含「不必换着说法反复强调」', l5int.includes('不必换着说法反复强调'));
  check('T16 四五层未新增固定句数硬要求', !/必须\s*\d+\s*句/.test(l4 + l5touch + l5int));

  check('T17 全程无页面异常', errors.length === 0, errors.slice(0, 1).join(''));

  // 计数规则：只给底数、不逐轮播报、允许主动计数
  check('T18 第一次触摸不报次数，第二次起才带次数底数',
    !touchSys[0].includes('已经是第') &&
    touchSys[1].includes('已经是第 2 次') && touchSys[2].includes('已经是第 3 次'));
  check('T19 明确允许在有互动意义时主动把次数点出来',
    touchSys.every(s => s.includes('次数怎么用由你判断') && s.includes('把这事点出来')));
  check('T20 不强制每轮计数、不要求追问原因、不固定句式',
    touchSys.every(s => s.includes('没有哪一次是必须计数的') && s.includes('不要求每次问原因')
      && s.includes('不要求套同一种说法')));
  check('T21 保留主动观察、判断、猜测用户心思的余地',
    touchSys.every(s => s.includes('自己观察、自己判断、自己猜')));
  check('T22 第五层触摸段同步允许自己计数，且不设必须追问/固定说法',
    l5touch.includes('但你可以自己计数') && l5touch.includes('不要求每次追问原因')
    && !l5touch.includes('也不用机械累计'));
  check('T23 触摸请求里统一规范恰好一次，事实块不再重复视角/省主语',
    touchSys.every(s => s.split('【对话的写法】').length - 1 === 1
      && s.includes('能省主语就省') && !s.includes('你说话时用「我」指自己')));
  check('T24 第五层触摸段已去掉重复的省主语/第三人称句，计数契约保留',
    !l5touch.includes('动作描写能省主语就省') && !l5touch.includes('不要把她写成第三人称')
    && l5touch.includes('但你可以自己计数'));
} finally {
  try { ws && ws.close(); } catch {}
  try { browser.kill(); } catch {}
  server.close();
}

const pass = results.filter(Boolean).length, total = results.length;
console.log(`\n总计 ${total} 项：通过 ${pass}，失败 ${total - pass}`);
process.exit(pass === total ? 0 : 1);
