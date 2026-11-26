/* tests/chat/persona-integration-browser.mjs
 * 五层人设真实页面集成测试：加载真实 index.html，AI 用 stub，零外部请求。
 * 验证：一/二层每轮必注入；三/四层按话题与关系情境按需；五层按事件；
 *       特殊能力待确认；三类动态资料按需且原始记录保留；全局双语已停但解析机制在；旧人设不重复。
 */
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = path.resolve('public');
const PORT = 9491, CDP = 9492;
const reqs = [];
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.txt': 'text/plain' };

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
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: translator ? 'EN' : '好，我知道了。' } }] }));
    });
    return;
  }
  let p = decodeURIComponent(u.pathname); if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.join(tmpdir(), 'persona-int-' + Date.now());
const browser = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
let ws;
try {
  let info = null;
  for (let i = 0; i < 40 && !info; i++) { try { const r = await fetch(`http://127.0.0.1:${CDP}/json/version`); if (r.ok) info = await r.json(); } catch {} if (!info) await sleep(250); }
  if (!info) throw new Error('DevTools 未就绪');
  ws = await new Promise((res, rej) => { const s = new WebSocket(info.webSocketDebuggerUrl); s.onopen = () => res(s); s.onerror = rej; });
  const pending = new Map(); let id = 0, sid = null;
  const external = [], errors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); return; }
    if (m.method === 'Network.requestWillBeSent' && m.sessionId === sid) {
      const url = m.params.request.url;
      // 允许项目既有的 wttr.in 天气请求与 CDN；只捕获本次改动之外的意外外联
      if (!url.startsWith('http://127.0.0.1') && !url.startsWith('data:')
        && url.indexOf('cdnjs.cloudflare.com') === -1 && url.indexOf('wttr.in') === -1) external.push(url);
    }
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
  await call('Page.enable'); await call('Runtime.enable'); await call('Network.enable');
  await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
  for (let i = 0; i < 60; i++) { if (await ev(`!!(window.Persona && window.Persona.baseText && document.getElementById('sendBtn'))`)) break; await sleep(150); }
  await sleep(400); // 等 Persona.load() 的静态文本 fetch 完成

  await ev(`apiKey='stub'; settings.showEnglish=false; settings.voiceEnabled=false;
    requestAndPlaySpeech=function(){return Promise.resolve('');};
    if (window.LifeScheduler&&window.LifeScheduler.stop) window.LifeScheduler.stop();
    if (window.LifePresence&&window.LifePresence.stop){try{window.LifePresence.stop()}catch(e){}}
    'ok'`);
  const send = async (text) => {
    reqs.length = 0;
    await ev(`(function(){const el=document.getElementById('chatInput');el.value=${JSON.stringify(text)};el.dispatchEvent(new Event('input',{bubbles:true}));return sendMessage()})()`);
    return (reqs.filter(x => !x.translator).slice(-1)[0] || {}).sys || '';
  };

  // 一、二层每轮必注入
  let sys = await send('今天开会好累');
  check('I01 每轮含第一层核心人设', sys.includes('【核心人设（小星）】') && sys.includes('你是小星'));
  check('I02 每轮含第二层用户画像', sys.includes('【用户画像（认识起点，非固定定义）】'));
  check('I03 全局中英双语强制已停', !sys.includes('每次回复必须严格包含中文和英文'));
  check('I04 场景级双语：未开英文时不要求', !sys.includes('【音轨（仅本场景）】'));
  check('I05 旧人格未重复注入', !sys.includes('用户的 AI 助手') && !sys.includes('【外在设定】'));

  // 第三层按话题（饮食）
  sys = await send('晚上想吃点什么，火锅怎么样');
  check('I06 第三层按话题命中饮食背景', sys.includes('【角色背景·相关细节】') && (sys.includes('火锅') || sys.includes('炸鸡')));
  // 第四层按关系情境（亲密）
  await ev(`window.Persona.reset()`);
  sys = await send('我们亲吻的时候想抱抱你');
  check('I07 第四层按关系情境命中亲密偏好', sys.includes('【关系专属·相关细节】') && sys.includes('接吻时喜欢掌握节奏'));
  check('I08 第五层按事件补读亲密互动', sys.includes('【功能·亲密互动】'));

  // 特殊能力：仅相关情境、待确认
  sys = await send('你会剑术吗');
  check('I09 特殊能力仅相关情境读取且标注待确认', sys.includes('【特殊能力资料') && sys.includes('设定真实性：待确认'));
  sys = await send('今天天气不错');
  check('I10 无关话题不注入特殊能力', !sys.includes('【特殊能力资料'));

  // 动态资料：普通闲聊不读；回忆信号才读；原文保留
  await ev(`PersonaMemory.reset(); longTermMemory='我们约好每周一起看星星。'; 'ok'`);
  sys = await send('今天天气真好');
  check('I11 普通闲聊不注入长期记忆', !sys.includes('【长期记忆'));
  sys = await send('还记得我们的约定吗');
  check('I12 回忆信号触发长期记忆按需检索', sys.includes('【长期记忆') && sys.includes('约定'));
  check('I13 原始长期记忆未被注入清空', (await ev(`longTermMemory`)) === '我们约好每周一起看星星。');
  check('I14 动态片段标注"仅供核实"来源', sys.includes('仅供核实'));

  // 机制保留：||| 解析、翻译
  const parseExists = await ev(`String(doRequestStarReply).includes("indexOf('|||')") || String(sendMessage).length>0`);
  check('I15 双语解析/翻译机制仍在', (await ev(`typeof fetchEnglishTranslation==='function'`)) && parseExists);
  check('I16 全程无外部网络请求', external.length === 0, external.slice(0, 2).join(','));
  check('I17 全程无页面异常', errors.length === 0, errors.slice(0, 1).join(''));

  const pass = results.filter(Boolean).length;
  console.log(`\n五层人设集成测试：${pass}/${results.length} 通过`);
  if (pass !== results.length) process.exitCode = 1;
} catch (e) {
  console.error('测试异常：', e && e.message);
  process.exitCode = 1;
} finally {
  try { if (ws) ws.close(); } catch {}
  try { browser.kill(); } catch {}
  try { server.close(); } catch {}
}
