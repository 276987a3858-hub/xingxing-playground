/* tests/butler/silent-chat-browser.mjs
 * 星星的小沉默（普通聊天）只读 stub 验证：
 * 正常回复不误判 / 标记才建沉默消息 / 点击前后隐藏 / 刷新保留 / 导出导入 / 手机触摸。
 * 零真实 AI 请求。
 */
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = path.resolve('public');
const PORT = 9471, CDP = 9472;
const reqs = [];
let stubMode = 'normal';

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
      reqs.push({ at: Date.now(), translator, sys, userText, all: msgs });
      if (translator) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'stub english' } }] }));
        return;
      }
      if (stubMode === 'error') { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('stub failure'); return; }
      const table = {
        normal: '主回复已生成。',
        bilingual: '我在。 ||| I am here.',
        silent: '[[SILENT: {"reason":"……你自己想想我为什么不说话。"}]]',
        silentPadded: '\n  [[SILENT: {"reason":"有点委屈，先不说了。"}]]  \n',
        silentBadJson: '[[SILENT: {oops}]]',
        silentNoReason: '[[SILENT: {"reason":"   "}]]',
        silentWithText: '我有点累，先不说了。\n[[SILENT: {"reason":"不该出现的理由"}]]',
        bareSilent: '[[SILENT]]',
        actionSilent: '（没再说别的，只是留在她旁边）\n\n[[SILENT]]',
        badJsonWithText: '我有点累，先不说了。\n[[SILENT: {oops}]]',
        normalWithBare: '我在，怎么了？ [[SILENT]]',
        empty: ''
      };
      const content = table[stubMode] != null ? table[stubMode] : '主回复已生成。';
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

let pass = 0, fail = 0;
const ok = (n, cond, d = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.join(tmpdir(), 'bl-silent-chat-' + Date.now());
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
      if (!url.startsWith('http://127.0.0.1') && !url.startsWith('blob:') && !url.startsWith('data:') && url.indexOf('cdnjs.cloudflare.com') === -1) external.push(url);
    }
    if (m.method === 'Runtime.exceptionThrown' && m.sessionId === sid) {
      const t = String(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '');
      if (!/notification/i.test(t)) errors.push(t);
    }
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    id++; pending.set(id, { resolve, reject });
    const p = { id, method, params };
    if (sid) p.sessionId = sid;
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
  await call('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const of = window.fetch.bind(window);
      window.fetch = (url, opts) => {
        if (typeof url === 'string' && url.includes('wttr.in')) {
          return Promise.resolve(new Response(JSON.stringify({current_condition:[{weatherDesc:[{value:'晴朗'}]}]}), {headers:{'content-type':'application/json'}}));
        }
        return of(url, opts);
      };
    })();`
  });
  const boot = async () => {
    await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    for (let i = 0; i < 60; i++) { if (await ev(`document.readyState==='complete' && typeof sendMessage==='function'`).catch(() => false)) break; await sleep(200); }
    await sleep(400);
    await ev(`apiKey='stub'; settings.showEnglish=false; settings.voiceEnabled=false; settings.showTime=true;
      window.__speech=[];
      requestAndPlaySpeech = function(text,id2){ window.__speech.push({text:String(text).slice(0,40), id:id2}); return Promise.resolve(''); };
      if (window.LifeScheduler && window.LifeScheduler.stop) window.LifeScheduler.stop();
      showPage('chat'); ''`);
  };
  await boot();

  const send = (text) => ev(`(function(){
    const el=document.getElementById('chatInput'); el.value=${JSON.stringify(text)};
    el.dispatchEvent(new Event('input',{bubbles:true})); return sendMessage(); })()`);
  const lastAssistant = () => ev(`(function(){
    const m=[...chatHistory].reverse().find(x=>x.role==='assistant');
    const nodes=[...document.querySelectorAll('#messages .assistant-message')];
    const n=nodes[nodes.length-1];
    return {content:m&&m.content, silent:!!(m&&m.silent), reason:m&&m.silentReason, revealed:m&&m.silentRevealedAt,
      en:m&&m.englishContent, id:m&&m.id, dom:n?n.innerText.trim():'', cls:n?n.querySelector('.bubble').className:''};
  })()`);

  console.log('\n[1] 普通回复 / 双语');
  reqs.length = 0;
  await send('今天怎么样');
  let r = await lastAssistant();
  ok('S01 普通回复正常显示且不带沉默字段', r.silent === false && r.content === '主回复已生成。' && r.dom.includes('主回复已生成。'), JSON.stringify(r).slice(0, 120));

  stubMode = 'bilingual';
  await send('在吗');
  r = await lastAssistant();
  ok('S02 双语回复仍按 ||| 拆分', r.content === '我在。' && r.en === 'I am here.', JSON.stringify(r).slice(0, 120));
  ok('S02b 双语回复照旧发起翻译前的正常路径（无额外主请求）', reqs.filter((x) => !x.translator).length === 2, `main=${reqs.filter((x) => !x.translator).length}`);

  console.log('\n[2] 沉默标记 → 特殊消息');
  stubMode = 'silent';
  reqs.length = 0;
  await ev(`window.__speech=[]; ''`);
  const beforeLen = await ev(`chatHistory.length`);
  await send('你今天怎么有点不一样');
  r = await lastAssistant();
  ok('S03 建立一条沉默消息（正文为空）', r.silent === true && r.content === '' && r.dom.length > 0, JSON.stringify(r).slice(0, 140));
  ok('S04 用户消息与沉默消息各一条', (await ev(`chatHistory.length`)) === beforeLen + 2, '');
  const domState = await ev(`(function(){
    const n=[...document.querySelectorAll('#messages .assistant-message')].pop();
    const b=n.querySelector('.bubble');
    return {text:b.innerText.trim(), hasBtn:b.getAttribute('role'), tabIndex:b.getAttribute('tabindex'),
      cursor:getComputedStyle(b).cursor, reason:b.innerText.indexOf('你自己想想')!==-1,
      marker:b.innerText.indexOf('SILENT')!==-1};
  })()`);
  ok('S05 点击前只见「已读，暂时没有回复」', domState.text.indexOf('已读，暂时没有回复') === 0, domState.text.slice(0, 60));
  ok('S06 点击前隐藏原因不可见、内部标记不外露', domState.reason === false && domState.marker === false, JSON.stringify(domState).slice(0, 120));
  ok('S07 占位气泡可点（role/tabindex/cursor）', domState.hasBtn === 'button' && domState.tabIndex === '0' && domState.cursor === 'pointer', JSON.stringify(domState).slice(0, 140));
  ok('S08 沉默不触发语音、不额外发翻译请求', (await ev(`window.__speech.length`)) === 0 && reqs.filter((x) => x.translator).length === 0,
    `req=${reqs.length} tr=${reqs.filter((x) => x.translator).length}`);

  console.log('\n[3] 点击揭晓（0 请求）+ 落库');
  const reqBeforeClick = reqs.length;
  await ev(`(function(){
    const n=[...document.querySelectorAll('#messages .assistant-message')].pop();
    n.querySelector('.bubble').click();
  })()`);
  await sleep(350);
  const revealed = await ev(`(function(){
    const n=[...document.querySelectorAll('#messages .assistant-message')].pop();
    const b=n.querySelector('.bubble');
    const m=chatHistory[chatHistory.length-1];
    return {text:b.innerText.trim(), reason:m.silentReason, revealed:m.silentRevealedAt, cls:b.className};
  })()`);
  ok('S09 点击后展示隐藏的小心思', revealed.text.indexOf(revealed.reason) === 0, JSON.stringify(revealed).slice(0, 140));
  ok('S10 揭晓不请求 AI', reqs.length === reqBeforeClick, `reqs=${reqs.length - reqBeforeClick}`);
  const persisted = await ev(`(async function(){
    const db=await new Promise((res,rej)=>{const q=indexedDB.open('star_fifi_room');q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error);});
    const rows=await new Promise((res,rej)=>{const q=db.transaction('messages').objectStore('messages').getAll();q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error);});
    db.close();
    const row=rows.filter(x=>x.silent).pop();
    return {silentAt:row&&row.silentAt, revealedAt:row&&row.silentRevealedAt, reason:row&&row.silentReason, role:row&&row.role, content:row&&row.content};
  })()`);
  ok('S11 揭晓时间与原因写进 IndexedDB', persisted.revealedAt > 0 && persisted.silentAt > 0 && !!persisted.reason, JSON.stringify(persisted).slice(0, 140));

  console.log('\n[4] 刷新后状态保留');
  await call('Page.reload', {});
  for (let i = 0; i < 60; i++) { if (await ev(`document.readyState==='complete' && typeof renderMessages==='function'`).catch(() => false)) break; await sleep(200); }
  await ev(`showPage('chat'); ''`);
  await sleep(300);
  const afterReload = await ev(`(function(){
    const m=chatHistory.filter(x=>x.silent).pop();
    const nodes=[...document.querySelectorAll('#messages .silent-bubble')];
    const b=nodes[nodes.length-1];
    return {revealed:!!(m&&m.silentRevealedAt), reason:m&&m.silentReason, text:b?b.innerText.trim():'', n:nodes.length};
  })()`);
  ok('S12 刷新后仍是展开状态并显示原因', afterReload.revealed === true && afterReload.text.indexOf(afterReload.reason) === 0 && afterReload.n >= 1,
    JSON.stringify(afterReload).slice(0, 140));
  await ev(`apiKey='stub'; settings.voiceEnabled=false; settings.showEnglish=false;
    window.__speech=[]; requestAndPlaySpeech = function(text,id2){ window.__speech.push({text:String(text).slice(0,40), id:id2}); return Promise.resolve(''); };
    if (window.LifeScheduler && window.LifeScheduler.stop) window.LifeScheduler.stop(); ''`);
  const beforeSilentCount = await ev(`chatHistory.filter(x=>x.silent).length`);

  console.log('\n[5] 异常输入不误判为沉默');
  stubMode = 'empty';
  const lenBeforeEmpty = await ev(`chatHistory.length`);
  await send('空回复测试');
  const emptyState = await ev(`(function(){
    const m=chatHistory[chatHistory.length-1];
    return {len:chatHistory.length, role:m&&m.role, silent:!!(m&&m.silent),
      silentCount:chatHistory.filter(x=>x.silent).length};
  })()`);
  ok('S13 空回复不建沉默消息', emptyState.len === lenBeforeEmpty + 1 && emptyState.role === 'user' && emptyState.silentCount === beforeSilentCount,
    JSON.stringify(emptyState));

  stubMode = 'error';
  const lenBeforeErr = await ev(`chatHistory.length`);
  await send('接口异常测试');
  const errState = await ev(`(function(){
    const m=chatHistory[chatHistory.length-1];
    return {len:chatHistory.length, role:m&&m.role, silentCount:chatHistory.filter(x=>x.silent).length};
  })()`);
  ok('S13b 接口异常不建沉默消息', errState.len === lenBeforeErr + 1 && errState.role === 'user' && errState.silentCount === beforeSilentCount,
    JSON.stringify(errState));

  stubMode = 'silentBadJson';
  const lenBeforeBad = await ev(`chatHistory.length`);
  await send('坏 JSON 测试');
  const badState = await ev(`(function(){
    const n=[...document.querySelectorAll('#messages .assistant-message')].pop();
    return {len:chatHistory.length, silent:!!chatHistory[chatHistory.length-1].silent, text:n?n.innerText.trim():''};
  })()`);
  ok('S14 JSON 坏掉不算沉默、也不把标记显示出来', badState.silent === false && badState.text.indexOf('SILENT') === -1 && badState.len === lenBeforeBad + 1,
    JSON.stringify(badState).slice(0, 140));

  stubMode = 'silentNoReason';
  await send('空理由测试');
  const noReason = await ev(`(function(){const n=[...document.querySelectorAll('#messages .assistant-message')].pop();
    return {silent:!!chatHistory[chatHistory.length-1].silent, text:n?n.innerText.trim():''};})()`);
  ok('S15 reason 为空的标记不算沉默', noReason.silent === false && noReason.text.indexOf('SILENT') === -1, JSON.stringify(noReason).slice(0, 120));

  stubMode = 'silentWithText';
  await send('正文加标记测试');
  const withText = await ev(`(function(){const n=[...document.querySelectorAll('#messages .assistant-message')].pop();
    const m=chatHistory[chatHistory.length-1];
    return {silent:!!m.silent, content:m.content, text:n?n.innerText.trim():''};})()`);
  ok('S16 有正文时按普通回复，只剥掉标记', withText.silent === false && withText.content === '我有点累，先不说了。' && withText.text.indexOf('SILENT') === -1,
    JSON.stringify(withText).slice(0, 140));

  stubMode = 'silent';
  const silentBeforeGate = await ev(`chatHistory.filter(x=>x.silent).length`);
  await send('明天下午三点提醒我交房租');
  const gateState = await ev(`(function(){
    const m=chatHistory[chatHistory.length-1];
    return {silentCount:chatHistory.filter(x=>x.silent).length, hasSilent:!!m.silent, role:m.role};
  })()`);
  ok('S16b 待办/记账类指令不会被沉默吞掉', gateState.silentCount === silentBeforeGate && gateState.hasSilent === false, JSON.stringify(gateState));

  console.log('\n[5b] 标记识别与清理（新增回归）');
  stubMode = 'bareSilent';
  await send('纯裸标记测试');
  const bareState = await ev(`(function(){const m=chatHistory[chatHistory.length-1];
    return {silent:!!m.silent, content:m.content, reason:m.silentReason,
      dom:[...document.querySelectorAll('#messages .assistant-message')].pop().querySelector('.bubble').innerText};})()`);
  ok('N01 纯裸标记识别为沉默且不外露标记', bareState.silent === true && bareState.content === '' && bareState.dom.indexOf('SILENT') === -1,
    JSON.stringify(bareState).slice(0, 140));

  stubMode = 'actionSilent';
  await send('动作描写加裸标记测试');
  const actionState = await ev(`(function(){const m=chatHistory[chatHistory.length-1];
    return {silent:!!m.silent, content:m.content, reason:m.silentReason,
      dom:[...document.querySelectorAll('#messages .assistant-message')].pop().querySelector('.bubble').innerText};})()`);
  ok('N02 动作描写+裸标记识别为沉默', actionState.silent === true && actionState.content === '', JSON.stringify(actionState).slice(0, 160));
  ok('N03 动作描写保留为可展开心情且标记不外露', actionState.reason.indexOf('没再说别的') !== -1 && actionState.dom.indexOf('SILENT') === -1 && actionState.dom.indexOf('已读') === 0,
    JSON.stringify(actionState).slice(0, 160));
  await ev(`(function(){
    const n=[...document.querySelectorAll('#messages .assistant-message')].pop();
    n.querySelector('.bubble').click(); return ''; })()`);
  await sleep(300);
  const actionOpen = await ev(`(function(){
    const n=[...document.querySelectorAll('#messages .assistant-message')].pop();
    return {text:n.querySelector('.bubble').innerText, reason:chatHistory[chatHistory.length-1].silentReason};})()`);
  ok('N04 动作描写沉默点击可展开', actionOpen.text.indexOf(actionOpen.reason) === 0, JSON.stringify(actionOpen).slice(0, 140));

  stubMode = 'normalWithBare';
  await send('正常正文夹带裸标记测试');
  const mixedState = await ev(`(function(){const m=chatHistory[chatHistory.length-1];
    return {silent:!!m.silent, content:m.content,
      dom:[...document.querySelectorAll('#messages .assistant-message')].pop().querySelector('.bubble').innerText};})()`);
  ok('N05 正常正文夹带裸标记不判沉默、标记被清理', mixedState.silent === false && mixedState.content === '我在，怎么了？' && mixedState.dom.indexOf('SILENT') === -1,
    JSON.stringify(mixedState).slice(0, 140));

  stubMode = 'badJsonWithText';
  await send('非法JSON带正文测试');
  const badJsonTextState = await ev(`(function(){const m=chatHistory[chatHistory.length-1];
    return {silent:!!m.silent, content:m.content,
      dom:[...document.querySelectorAll('#messages .assistant-message')].pop().querySelector('.bubble').innerText};})()`);
  ok('N06 非法JSON不吞正文、标记被清理', badJsonTextState.silent === false && badJsonTextState.content === '我有点累，先不说了。' && badJsonTextState.dom.indexOf('SILENT') === -1,
    JSON.stringify(badJsonTextState).slice(0, 140));

  stubMode = 'normal';
  ok('N07 不含标记的正常回复走纯函数仍为普通正文', await ev(`(function(){
    const a=analyzeSilentReply('今天有点累，早点睡吧。');
    const b=analyzeSilentReply('随便聊聊');
    return a.silent===false && a.text==='今天有点累，早点睡吧。' && a.hasMarker===false && b.silent===false;
  })()`), '');
  ok('N08 纯函数四种格式分类正确', await ev(`(function(){
    const reasoned=analyzeSilentReply('[[SILENT: {"reason":"想安静陪她一会儿"}]]');
    const bare=analyzeSilentReply('[[SILENT]]');
    const mixed=analyzeSilentReply('正文内容 [[SILENT]]');
    const bad=analyzeSilentReply('[[SILENT: 非法JSON]]');
    return reasoned.silent===true && reasoned.reason==='想安静陪她一会儿'
      && bare.silent===true && bare.text==='' && bare.hasMarker===true
      && mixed.silent===false && mixed.text==='正文内容' && mixed.hasMarker===true
      && bad.silent===false && bad.text==='' && bad.hasMarker===true && bad.malformed===true;
  })()`), '');

  console.log('\n[6] 与主动关心隔离');
  stubMode = 'normal';
  const isolation = await ev(`(function(){
    const b=window.LifeScheduler.budget(Date.now());
    const k=window.LifeScheduler._keys || {};
    return {limit:b.limit, cooldown:k.AMBIENT_COOLDOWN, daily:k.AMBIENT_DAILY, ids:window.LifeScheduler.list().map(t=>t.id)};
  })()`);
  ok('S17 主动关心预算/冷却/任务数未变', isolation.limit === 15 && isolation.daily === 15 && isolation.cooldown === 900000 && isolation.ids.length === 4, JSON.stringify(isolation));
  stubMode = 'empty';
  const idleSilent = await ev(`(async function(){
    const out = await callSpecialAI('测试用提示', { idle:true, allowEmpty:true, onOutcome:function(r){ window.__outcome=r; } });
    return {out:out, outcome:window.__outcome};
  })()`);
  ok('S18 主动关心静默链路仍独立可用（空回复=沉默、不落库）', idleSilent.out === '' && idleSilent.outcome === 'silent', JSON.stringify(idleSilent));

  stubMode = 'actionSilent';
  const beforeIdleLen = await ev(`chatHistory.length`);
  const idleAction = await ev(`(async function(){
    const out = await callSpecialAI('测试用提示', { idle:true, allowEmpty:true, onOutcome:function(r){ window.__out2=r; } });
    return {out:out, outcome:window.__out2, len:chatHistory.length};
  })()`);
  ok('N09 主动关心动作描写+裸标记识别为沉默、不落库', idleAction.out === '' && idleAction.outcome === 'silent' && idleAction.len === beforeIdleLen,
    JSON.stringify(idleAction));

  stubMode = 'normalWithBare';
  const beforeIdleLen2 = await ev(`chatHistory.length`);
  const idleMixed = await ev(`(async function(){
    const out = await callSpecialAI('测试用提示', { idle:true, allowEmpty:true, onOutcome:function(r){ window.__out3=r; } });
    return {out:out, outcome:window.__out3, len:chatHistory.length, marker:out.indexOf('SILENT')!==-1};
  })()`);
  ok('N10 主动关心正常正文夹带标记清理后落库、不误判沉默', idleMixed.outcome === 'spoken' && idleMixed.out === '我在，怎么了？' && idleMixed.marker === false && idleMixed.len === beforeIdleLen2 + 1,
    JSON.stringify(idleMixed));
  stubMode = 'normal';
  const chatSys = (reqs.filter((x) => !x.translator && x.userText.indexOf('正文加标记测试') !== -1).pop() || {}).sys || '';
  const specialSys = (reqs.filter((x) => !x.translator && x.userText === '测试用提示').pop() || {}).sys || '';
  ok('S19 沉默说明只出现在普通聊天提示词里', chatSys.includes('【偶尔可以不说话】') && chatSys.includes('[[SILENT:'), `len=${chatSys.length}`);
  ok('S19b 主动关心提示词里没有这段说明', specialSys.length > 0 && !specialSys.includes('【偶尔可以不说话】'), `len=${specialSys.length}`);
  // 复核：沉默必须有可追溯前因，不得随机/凭空触发
  ok('S19c 要求从真实上下文里找到具体前因', chatSys.includes('找到了具体的前因') && chatSys.includes('小情绪'), '');
  ok('S19d 明令禁止凭空编造失约/吃醋由头', chatSys.includes('凭空编') && chatSys.includes('制造效果'), '');
  ok('S19e 求助、难过、身体不舒服、要紧事必须正常回复', chatSys.includes('认真求助') && chatSys.includes('身体不舒服') && chatSys.includes('必须正常回复'), '');
  ok('S19f 已解释/已补约后不得再拿旧事闹脾气', chatSys.includes('把约定补上了') && chatSys.includes('不许用不说话逼她'), '');
  ok('S19g 隐藏心思必须对应真实前因、不许空泛', chatSys.includes('必须对应你刚才找到的那个真实前因') && chatSys.includes('通用、空泛'), '');
  ok('S19h 无标记或标记不完整仍不判沉默', await ev(`(function(){
    const a = parseChatSilence('今天有点累，早点睡吧。 ||| You should rest early.');
    const b = parseChatSilence('随便聊聊');
    const c = parseChatSilence('');
    return !a.silent && !b.silent && !c.silent;
  })()`), '');

  console.log('\n[7] 导出 / 导入');
  stubMode = 'silent';
  await send('再沉默一次，这次先不点开');
  const exportInfo = await ev(`(async function(){
    window.__exportText = null;
    const oc = URL.createObjectURL, orv = URL.revokeObjectURL;
    const ock = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = function(b){ window.__blob = b; return 'blob:stub'; };
    URL.revokeObjectURL = function(){};
    HTMLAnchorElement.prototype.click = function(){};
    await exportData();
    HTMLAnchorElement.prototype.click = ock; URL.createObjectURL = oc; URL.revokeObjectURL = orv;
    window.__exportText = await window.__blob.text();
    const json = JSON.parse(window.__exportText);
    const s = (json.messages || []).filter(m => m.silent);
    const n = (json.messages || []).find(m => !m.silent && m.role === 'assistant');
    return {count:s.length, reason:!!(s[0] && s[0].silentReason), revealed:s.map(x=>!!x.silentRevealedAt),
      normalKeys:n?Object.keys(n):[], normalHasSilent: n ? Object.prototype.hasOwnProperty.call(n,'silent') : null};
  })()`);
  ok('S20 导出包含沉默消息与隐藏原因', exportInfo.count >= 2 && exportInfo.reason === true, JSON.stringify(exportInfo).slice(0, 140));
  ok('S21 导出保留揭晓状态（一条已揭晓、一条未揭晓）', exportInfo.revealed.includes(true) && exportInfo.revealed.includes(false), JSON.stringify(exportInfo.revealed));
  ok('S22 普通消息导出结构不受影响', exportInfo.normalHasSilent === false, JSON.stringify(exportInfo.normalKeys));

  const imported = await ev(`(async function(){
    await clearStore('messages'); chatHistory = []; renderMessages();
    window.confirm = () => true;
    const file = new File([window.__exportText], 'backup.json', {type:'application/json'});
    await importData({ files:[file], value:'' });
    const silents = chatHistory.filter(m => m.silent);
    const nodes = [...document.querySelectorAll('#messages .silent-bubble')];
    return {n:silents.length, revealed:silents.map(x=>!!x.silentRevealedAt),
      texts:nodes.map(n=>n.innerText.trim().slice(0,12))};
  })()`);
  ok('S23 导入后沉默消息与状态都还原', imported.n >= 2 && imported.revealed.includes(true) && imported.revealed.includes(false)
    && imported.texts.some(t => t.indexOf('已读，暂时没有回复') === 0), JSON.stringify(imported).slice(0, 160));

  const clickAfterImport = await ev(`(async function(){
    const nodes = [...document.querySelectorAll('#messages .silent-bubble')];
    const collapsed = nodes.find(n => n.innerText.indexOf('已读，暂时没有回复') === 0);
    if (!collapsed) return {found:false};
    collapsed.click();
    await new Promise(r=>setTimeout(r,200));
    const m = [...chatHistory].reverse().find(x => x.silent && x.silentRevealedAt);
    const again = [...document.querySelectorAll('#messages .silent-bubble')].find(n => n.innerText.indexOf(m.silentReason) === 0);
    return {found:true, revealed:!!again, reason:m.silentReason};
  })()`);
  ok('S24 导入后仍能点击揭晓', clickAfterImport.found === true && clickAfterImport.revealed === true, JSON.stringify(clickAfterImport).slice(0, 140));

  console.log('\n[8] 手机端触摸');
  await call('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const geom = await ev(`(async function(){
    await clearStore('messages'); chatHistory=[]; renderMessages();
    const msg = {role:'assistant', content:'', englishContent:'', time:Date.now(), silent:true,
      silentReason:'我只是想安静地陪你一会儿。', silentAt:Date.now(), silentRevealedAt:0, source:'chat-silent'};
    msg.id = await addToStore('messages', msg);
    chatHistory.push(msg); renderMessages();
    const b = document.querySelector('#messages .silent-bubble');
    b.scrollIntoView({block:'center'});
    await new Promise(r=>setTimeout(r,120));
    const rect = b.getBoundingClientRect();
    return {w:Math.round(rect.width), h:Math.round(rect.height), x:Math.round(rect.x+rect.width/2), y:Math.round(rect.y+rect.height/2),
      pe:getComputedStyle(b).pointerEvents, vw:innerWidth, text:b.innerText.trim().slice(0,12)};
  })()`);
  ok('S25 移动视口下占位气泡可见可点', geom.w > 60 && geom.h > 20 && geom.pe !== 'none' && geom.vw === 375, JSON.stringify(geom));
  await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: geom.x, y: geom.y }] });
  await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  let mobileReveal = false, viaFallback = false;
  for (let i = 0; i < 10; i++) {
    mobileReveal = await ev(`(function(){
      const b=document.querySelector('#messages .silent-bubble');
      return !!(b && b.className.indexOf('revealed')!==-1);
    })()`);
    if (mobileReveal) break;
    await sleep(120);
  }
  if (!mobileReveal) {
    viaFallback = true;
    await ev(`document.querySelector('#messages .silent-bubble').click()`);
    await sleep(250);
    mobileReveal = await ev(`!!document.querySelector('#messages .silent-bubble.revealed')`);
  }
  ok('S26 触摸点击应能揭晓（触摸事件或合成 click）', mobileReveal === true, viaFallback ? '触摸未合成 click，回退 click 成功' : '原生触摸即生效');

  const normalTap = await ev(`(async function(){
    const msg = {role:'assistant', content:'这是普通回复。', englishContent:'', time:Date.now()};
    msg.id = await addToStore('messages', msg);
    chatHistory.push(msg); renderMessages();
    const b = [...document.querySelectorAll('#messages .bubble')].pop();
    const before = b.className;
    b.click();
    await new Promise(r=>setTimeout(r,80));
    return {before:before, after:b.className, text:b.innerText.trim()};
  })()`);
  ok('S27 普通消息点击不受影响', normalTap.after.indexOf('silent-bubble') === -1 && normalTap.text.indexOf('这是普通回复。') === 0, JSON.stringify(normalTap).slice(0, 120));

  console.log('\n[9] 历史与提示词');
  stubMode = 'normal';
  reqs.length = 0;
  await ev(`(async function(){
    await clearStore('messages'); chatHistory=[];
    const u={role:'user', content:'你怎么不理我', time:Date.now()-4000};
    u.id = await addToStore('messages', u); chatHistory.push(u);
    const s={role:'assistant', content:'', englishContent:'', time:Date.now()-3000, silent:true, silentReason:'有点吃醋。', silentAt:Date.now()-3000, silentRevealedAt:Date.now()-2000};
    s.id = await addToStore('messages', s); chatHistory.push(s);
    renderMessages();
  })()`);
  await send('你在吗');
  const lastAll = (reqs.filter((x) => !x.translator).pop() || {}).all || [];
  const histSent = lastAll.filter((m) => m.role !== 'system');
  const histText = JSON.stringify(histSent);
  ok('S28 历史里不出现占位文案与内部标记', histText.indexOf('已读，暂时没有回复') === -1 && histText.indexOf('SILENT') === -1, histText.slice(0, 160));
  ok('S29 历史里用一句中性说明代表沉默', histText.indexOf('这一轮我没有出声') !== -1, histText.slice(0, 160));

  ok('S30 全程无外部请求', external.length === 0, external.slice(0, 2).join(','));
  ok('S31 全程无页面异常', errors.length === 0, errors.slice(0, 2).join(' | '));

  console.log(`\n沉默消息测试：${pass}/${pass + fail} 通过`);
  process.exitCode = fail ? 1 : 0;
} catch (e) {
  console.log('FAIL  运行异常 — ' + String(e && e.stack || e));
  process.exitCode = 1;
} finally {
  try { ws && ws.close(); } catch {}
  browser.kill(); server.close();
}
