/* tests/butler/reply-pipeline-browser.mjs
 * 只读 stub 验证：各 AI 对话路径的本地时间注入、历史摘要时间语义、
 * 主回复先显示 / 翻译后台按 id 回填。零真实 AI 请求。
 */
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = path.resolve('public');
const PORT = 9451, CDP = 9452;
const reqs = [];
let stubMode = 'default';

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api') {
    let bodyText = '';
    req.on('data', (c) => { bodyText += c; });
    req.on('end', async () => {
      let body = {}; try { body = JSON.parse(bodyText); } catch {}
      const msgs = body.messages || [];
      const sys = String(msgs[0]?.content || '');
      const userText = String([...msgs].reverse().find((m) => m.role === 'user')?.content || '');
      const translator = sys.includes('professional translator');
      reqs.push({ at: Date.now(), translator, sys, userText });
      let content;
      if (translator) {
        if (stubMode === 'fail') { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('stub failure'); return; }
        if (stubMode === 'reverse') {
          const en = userText.includes('第一条') ? 'EN-one' : userText.includes('第二条') ? 'EN-two' : 'EN';
          await sleep(userText.includes('第一条') ? 1200 : 100);
          content = en;
        } else {
          if (stubMode === 'delayed') await sleep(1500);
          content = 'Main reply ready.';
        }
      } else {
        content = stubMode === 'reverse' ? (userText.includes('第二条') ? '第二条' : '第一条') : '主回复已生成。';
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
    return;
  }
  let p = decodeURIComponent(u.pathname); if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !existsSync(f)) { res.writeHead(404); res.end(); return; }
  const ext = path.extname(f);
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' }[ext] || 'application/octet-stream';
  res.writeHead(200, { 'content-type': mime }); res.end(readFileSync(f));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const checks = [];
const check = (n, ok, d = '') => { checks.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.join(tmpdir(), 'bl-reply-pipeline-' + Date.now());
const browser = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP}`, '--user-data-dir=' + profile,
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
      if (!url.startsWith('http://127.0.0.1') && !url.startsWith('data:') && url.indexOf('cdnjs.cloudflare.com') === -1) external.push(url);
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
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const R = Date; let off = 0;
    window.__setNow = iso => { off = new R(iso).getTime() - R.now(); };
    function F(...a) { if (new.target) return a.length ? new R(...a) : new R(R.now() + off); return new R(R.now() + off).toString(); }
    F.prototype = R.prototype; F.now = () => R.now() + off; F.parse = R.parse; F.UTC = R.UTC; window.Date = F;
    const of = window.fetch.bind(window);
    window.fetch = (url, opts) => {
      if (typeof url === 'string' && url.includes('wttr.in')) {
        return Promise.resolve(new Response(JSON.stringify({current_condition:[{weatherDesc:[{value:'晴朗'}]}]}), {headers:{'content-type':'application/json'}}));
      }
      return of(url, opts);
    };
  })();` });
  await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  for (let i = 0; i < 50; i++) { if (await ev(`document.readyState==='complete' && typeof sendMessage==='function'`).catch(() => false)) break; await sleep(200); }
  await sleep(500);
  await ev(`apiKey='stub'; settings.showEnglish=false; settings.voiceEnabled=false;
    window.__speech=[];
    requestAndPlaySpeech = function(text,id){ window.__speech.push({text:String(text).slice(0,60), id:id}); return Promise.resolve(''); };
    if (window.LifeScheduler && window.LifeScheduler.stop) window.LifeScheduler.stop();
    'ok'`);
  const send = (iso, text) => ev(`window.__setNow(${JSON.stringify(iso)}); (function(){
    const el=document.getElementById('chatInput'); el.value=${JSON.stringify(text)};
    el.dispatchEvent(new Event('input',{bubbles:true})); return sendMessage(); })()`);
  const mainSystems = () => reqs.filter((r) => !r.translator).map((r) => r.sys);

  // ---- 时间注入 ----
  reqs.length = 0;
  await send('2026-11-18T19:38:00', '把东西先放这儿');
  let sys = mainSystems()[0] || '';
  check('A01 中性主聊也获得精确本地时间', /【当前时间】2026-11-18 19:38 周三（本地时间）/.test(sys), '');
  check('A02 保留时段描述、不再附带时间判断规则', sys.includes('时间提示：现在是晚上')
    && !sys.includes('不要说出或推算具体几点') && !/时间含义区分|历史时间边界|唯一的当前时间/.test(sys), '');
  check('A03 常驻提示词不含具体钟点锚点', !/十一点|23:00/.test(sys), '');

  reqs.length = 0;
  await send('2026-11-18T19:38:30', '我准备去睡了');
  sys = mainSystems()[0] || '';
  check('A04 含时间词主聊同样现取时间', /【当前时间】2026-11-18 19:38 周三/.test(sys), '');

  reqs.length = 0;
  await ev(`window.__setNow('2026-11-18T19:41:00'); lastUserActivityAt=Date.now()-10*60000; runIdleCheck()`);
  sys = mainSystems()[0] || '';
  check('A05 空闲主动回复获得精确时间', /【当前时间】2026-11-18 19:41 周三/.test(sys), '');

  reqs.length = 0;
  await ev(`window.__setNow('2026-11-18T20:15:00'); dailyGreet('night')`);
  sys = mainSystems()[0] || '';
  check('A06 特殊主动回复获得精确时间', /【当前时间】2026-11-18 20:15 周三/.test(sys), '');

  reqs.length = 0;
  await send('2026-11-19T00:10:00', '刚过零点');
  sys = mainSystems()[0] || '';
  check('A07 跨午夜日期与星期正确', /【当前时间】2026-11-19 00:10 周四（本地时间）/.test(sys), '');

  await ev(`longTermMemory='她习惯快十一点睡。'; diarySummaryCache='《日记》昨晚十一点才睡。'; keepsSummaryCache=''; 'ok'`);
  const hist = await ev(`getSystemPrompt()`);
  // A08 新版：三类动态资料改为按需（五层接入），getSystemPrompt 不再每轮拼接三段摘要；
  // 原始数据仍完整保存在变量/存储中，不会被本次注入清空。
  check('A08 基础提示词不再每轮注入三段动态摘要（原文仍保留在变量）',
    !hist.includes('她习惯快十一点睡。') && !hist.includes('昨晚十一点才睡。')
    && !hist.includes('【近期日记摘要】') && !hist.includes('【共同珍藏摘要】')
    && (await ev(`longTermMemory`)) === '她习惯快十一点睡。', '');
  reqs.length = 0;
  await send('2026-11-18T19:45:00', '今天怎么样');
  sys = mainSystems()[0] || '';
  check('A09 历史旧钟点不覆盖本次请求时间', /【当前时间】2026-11-18 19:45/.test(sys)
    && !/【当前时间】2026-11-18 23/.test(sys), '');
  // 结构：真实请求里当前时间只出现一次，且在【当前日程】之前，并带一句优先级说明
  check('A10 当前时间只注入一次且位于当前日程之前',
    (sys.match(/【当前时间】/g) || []).length === 1
    && sys.indexOf('【当前时间】') > -1 && sys.indexOf('【当前日程】') > sys.indexOf('【当前时间】')
    && /只按这一行说/.test(sys), '');

  // ---- 主回复先行 / 后台翻译 ----
  stubMode = 'delayed';
  await ev(`settings.showEnglish=false; settings.voiceEnabled=true; window.__speech=[]; 'ok'`);
  reqs.length = 0;
  const before = Date.now();
  await send('2026-11-18T19:46:00', '说点什么');
  const shownMs = Date.now() - before;
  const shown = await ev(`(function(){const n=document.querySelector('#messages .assistant-message:last-child');return n?n.innerText.trim():'';})()`);
  const midway = await ev(`(function(){const m=chatHistory[chatHistory.length-1];return {en:m.englishContent,id:m.id};})()`);
  check('B01 主回复在翻译完成前即显示', shownMs < 1200 && shown.includes('主回复已生成。'), `${shownMs}ms`);
  check('B02 显示时英文尚未回填', midway.en === '', JSON.stringify(midway));
  await sleep(1900);
  const afterDelay = await ev(`(async function(){
    const m=chatHistory[chatHistory.length-1];
    const db=await new Promise((res,rej)=>{const r=indexedDB.open('star_fifi_room');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});
    const rows=await new Promise((res,rej)=>{const q=db.transaction('messages').objectStore('messages').getAll();q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error);});
    db.close();
    const row=rows.find(x=>x.id===m.id);
    return {id:m.id,en:m.englishContent,dbEn:row&&row.englishContent,speech:window.__speech.slice()};
  })()`);
  check('B03 翻译完成后按 id 回填内存与 IndexedDB', afterDelay.en === 'Main reply ready.' && afterDelay.dbEn === 'Main reply ready.', JSON.stringify(afterDelay).slice(0, 180));
  check('B04 语音使用同一消息 id', afterDelay.speech.some((s) => s.id === afterDelay.id && s.text === 'Main reply ready.'), JSON.stringify(afterDelay.speech).slice(0, 140));

  stubMode = 'fail';
  await ev(`window.__speech=[]; 'ok'`);
  reqs.length = 0;
  await send('2026-11-18T19:47:00', '再试一句');
  await sleep(700);
  const failed = await ev(`(function(){const m=chatHistory[chatHistory.length-1];const n=document.querySelector('#messages .assistant-message:last-child');
    return {txt:n?n.innerText.trim():'',en:m.englishContent,speech:window.__speech.length};})()`);
  check('B05 翻译失败不撤销已显示主回复', failed.txt.includes('主回复已生成。') && failed.en === '' && failed.speech === 0, JSON.stringify(failed).slice(0, 160));

  stubMode = 'reverse';
  await ev(`window.__speech=[]; 'ok'`);
  reqs.length = 0;
  const lenBefore = await ev(`chatHistory.length`);
  await send('2026-11-18T19:48:00', '第一条消息');
  await send('2026-11-18T19:49:00', '第二条消息');
  await sleep(1800);
  const paired = await ev(`(function(){
    const find = t => chatHistory.find(m => m && m.content === t);
    const one = find('第一条'), two = find('第二条');
    return {one:one&&one.englishContent, two:two&&two.englishContent, oneId:one&&one.id, twoId:two&&two.id,
      roles:chatHistory.slice(-4).map(m=>m.role), len:chatHistory.length, speech:window.__speech.slice()};
  })()`);
  check('B06 乱序完成也回填到各自消息', paired.one === 'EN-one' && paired.two === 'EN-two', JSON.stringify(paired).slice(0, 200));
  check('B07 两条主回复各一次，翻译各一次', reqs.filter((r) => !r.translator).length === 2 && reqs.filter((r) => r.translator).length === 2,
    `main=${reqs.filter((r) => !r.translator).length} tr=${reqs.filter((r) => r.translator).length}`);
  check('B08 聊天历史顺序与增量正确', paired.len === lenBefore + 4 && paired.roles.join(',') === 'user,assistant,user,assistant', JSON.stringify(paired.roles));
  check('B09 语音回调用各自消息 id（按完成顺序）', paired.speech.length === 2
    && paired.speech.some((s) => s.text === 'EN-one' && s.id === paired.oneId)
    && paired.speech.some((s) => s.text === 'EN-two' && s.id === paired.twoId)
    && new Set(paired.speech.map((s) => s.id)).size === 2, JSON.stringify(paired.speech).slice(0, 180));

  check('C01 全程无外部请求', external.length === 0, external.slice(0, 2).join(','));
  check('C02 全程无页面异常', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) {
  check('运行异常', false, String(e && e.stack || e));
} finally {
  try { ws && ws.close(); } catch {}
  browser.kill(); server.close();
}
const pass = checks.filter(Boolean).length;
console.log(`\n回复链路测试：${pass}/${checks.length} 通过`);
process.exit(pass === checks.length ? 0 : 1);
