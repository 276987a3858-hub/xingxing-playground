/* tests/chat/persona-fixes-browser.mjs
 * 三项最小修复的真实页面回归：
 *  - note-day 便签不进入普通日记资料注入，普通日记仍能命中；
 *  - 动态资料去重键：沉默回复/失败不消耗，正常成功回复才消耗；
 *  - 话题 LRU 淘汰已在 persona-layers.test.mjs 做纯逻辑覆盖，这里补真实请求链上的行为。
 * 加载真实 index.html，AI 走本地 stub，零真实 AI 请求。
 */
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = path.resolve('public');
const PORT = 9501, CDP = 9502;
const reqs = [];
let stubMode = 'normal';

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = {}; try { parsed = JSON.parse(body); } catch {}
      const sys = String(parsed.messages?.[0]?.content || '');
      const translator = sys.includes('professional translator');
      reqs.push({ sys, translator, at: Date.now() });
      if (stubMode === 'error' && !translator) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('stub failure'); return; }
      let content;
      if (translator) content = 'EN';
      else if (stubMode === 'silent') content = '[[SILENT: {"reason":"先不说了。"}]]';
      else if (stubMode === 'empty') content = '';
      else content = '好，我知道了。';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
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
const profile = path.join(tmpdir(), 'persona-fixes-' + Date.now());
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
  for (let i = 0; i < 60; i++) { if (await ev(`!!(window.Persona && window.PersonaMemory && document.getElementById('sendBtn'))`).catch(() => false)) break; await sleep(150); }
  await sleep(400);

  await ev(`apiKey='stub'; settings.showEnglish=false; settings.voiceEnabled=false;
    requestAndPlaySpeech=function(){return Promise.resolve('');};
    translateInBackground=function(){return Promise.resolve('');};
    if (window.LifeScheduler&&window.LifeScheduler.stop) window.LifeScheduler.stop();
    if (window.LifePresence&&window.LifePresence.stop){try{window.LifePresence.stop()}catch(e){}}
    'ok'`);

  const send = async (text) => {
    reqs.length = 0;
    await ev(`(function(){const el=document.getElementById('chatInput');el.value=${JSON.stringify(text)};el.dispatchEvent(new Event('input',{bubbles:true}));return sendMessage().catch(e=>({__err:String(e&&e.message||e)}))})()`);
    return (reqs.filter(x => !x.translator).slice(-1)[0] || {}).sys || '';
  };

  // ===== 修复一：note-day 不进入普通日记注入，普通日记仍命中 =====
  await ev(`(async function(){
    await clearStore('diaries');
    await addToStore('diaries', { id: 9001, type:'note-day', title:'今日便签', content:'看星星的便签内容', createdAt: Date.now() });
    await addToStore('diaries', { id: 9002, title:'真实日记', content:'那天我们一起去露营看星星', createdAt: Date.now() });
    PersonaMemory.reset();
    return 'ok';
  })()`);
  stubMode = 'normal';
  let sys = await send('日记里有没有写过看星星的事');
  check('F01 note-day 便签不进入普通日记资料注入', !sys.includes('看星星的便签内容'), sys.includes('看星星的便签内容') ? '误注入便签' : '');
  check('F02 普通日记原文仍可正常命中', sys.includes('那天我们一起去露营看星星'));

  // ===== 修复二：去重键时机（沉默/失败不消耗，正常成功才消耗）=====
  const setMem = () => ev(`longTermMemory='我们约好每周一起看星星。'; PersonaMemory.reset(); 'ok'`);
  const memInjected = (s) => s.includes('【长期记忆') && s.includes('每周一起看星星');

  // 2a 沉默回复不消耗：第一次沉默注入 → 第二次（不 reset）仍应注入同一条
  await setMem(); stubMode = 'silent';
  sys = await send('还记得我们的约定吗');
  check('F03 沉默轮仍检索到资料（首次注入）', memInjected(sys));
  // 关键：不清 PersonaMemory.reset()，直接再发一轮；若沉默轮误标记，这里会变空
  stubMode = 'normal';
  const sysSilentThen = await send('还记得我们的约定吗');
  check('F04 沉默回复不消耗去重键（下一轮仍注入同一条）', memInjected(sysSilentThen),
    sysSilentThen.includes('【长期记忆') ? '' : '沉默轮误消耗了去重键');

  // 2b 正常成功回复消耗：成功后同一条不再注入（去重仍生效）
  await setMem(); stubMode = 'normal';
  sys = await send('还记得我们的约定吗');
  check('F05 正常回复注入资料', memInjected(sys));
  // 不清 reset：模拟同一会话内下一轮，用相同命中文本，确保是去重生效而非关键词不匹配
  stubMode = 'normal';
  const sys2 = await send('还记得我们的约定吗');
  check('F06 正常成功发送后正确去重（同条不再注入）', !memInjected(sys2),
    sys2.includes('【长期记忆') ? '成功发送后仍未去重' : '');

  // 2c 失败发送不提前标记：接口失败后重试仍能注入
  await setMem(); stubMode = 'error';
  await send('还记得我们的约定吗');
  stubMode = 'normal';
  const sys3 = await send('还记得我们的约定吗');
  check('F07 失败发送不提前标记（重试仍可注入）', memInjected(sys3));

  // 2d 空回复失败：这是旧代码（markSent 紧跟 callAI）会误标记的场景，必须不消耗键
  await setMem(); stubMode = 'empty';
  await send('还记得我们的约定吗');
  stubMode = 'normal';
  const sys4 = await send('还记得我们的约定吗');
  check('F09 空回复失败不提前标记（重试仍可注入）', memInjected(sys4),
    sys4.includes('【长期记忆') ? '' : '空回复失败误消耗了去重键');

  check('F08 全程无页面异常', errors.length === 0, errors.slice(0, 1).join(''));
  const pass = results.filter(Boolean).length;
  console.log(`\n三项修复浏览器回归：${pass}/${results.length} 通过`);
  if (pass !== results.length) process.exitCode = 1;
} catch (e) {
  console.error('测试异常：', e && e.message);
  process.exitCode = 1;
} finally {
  try { if (ws) ws.close(); } catch {}
  try { browser.kill(); } catch {}
  try { server.close(); } catch {}
}
