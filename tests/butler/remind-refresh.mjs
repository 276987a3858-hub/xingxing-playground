/* tests/butler/remind-refresh.mjs
 * 真实房间页 + 真实 IndexedDB：待办 → 刷新 → 提醒补投 的端到端链路。
 * AI/网络全部 stub，不发任何真实请求。
 * 只诊断与验证，不改数据以外的任何东西。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9346;
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const profile = `${process.env.TEMP || 'C:\\Windows\\Temp'}\\remind-refresh-${Date.now()}`;

const browser = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--window-size=1280,1000', 'about:blank',
], { stdio: 'ignore' });

const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };
const note = (n, d) => console.log(`INFO  ${n}${d ? ' — ' + d : ''}`);

let ws;
try {
  let info = null;
  for (let i = 0; i < 40 && !info; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) info = await r.json(); } catch {}
    if (!info) await sleep(250);
  }
  if (!info) throw new Error('DevTools 未就绪');

  ws = await new Promise((res, rej) => { const s = new WebSocket(info.webSocketDebuggerUrl); s.onopen = () => res(s); s.onerror = () => rej(new Error('WS 失败')); });
  const pending = new Map();
  let id = 0, sessionId = null;
  const externalReqs = [], errors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); return; }
    if (m.method === 'Network.requestWillBeSent' && m.sessionId === sessionId) {
      const u = m.params.request.url;
      if (!u.startsWith('http://127.0.0.1')) externalReqs.push(u);
    }
    if (m.method === 'Runtime.exceptionThrown' && m.sessionId === sessionId) {
      errors.push(String(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || ''));
    }
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    id += 1; pending.set(id, { resolve, reject });
    const payload = { id, method, params };
    if (sessionId && !method.startsWith('Target.')) payload.sessionId = sessionId;
    ws.send(JSON.stringify(payload));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('超时 ' + method)); } }, 20000);
  });
  const evalJS = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result.value;
  };

  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  sessionId = (await call('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  await call('Page.enable'); await call('Runtime.enable'); await call('Network.enable');

  // 断网：任何真实 fetch 都被拦截记录
  await call('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      window.__netCalls = [];
      window.fetch = function (url) {
        window.__netCalls.push(String(url));
        return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { headers: { 'content-type': 'application/json' } }));
      };
    })();`,
  });

  await call('Page.navigate', { url: BASE + '/' });
  await sleep(2500);

  // 写入 mock apiKey（避免任何真实调用），并重载
  await evalJS(`(async function(){
    const db = await new Promise((res, rej) => { const r = indexedDB.open('star_fifi_room'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    await new Promise((res, rej) => { const tx = db.transaction('kv','readwrite'); tx.objectStore('kv').put('mock-key','apiKey'); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    db.close(); return 1;
  })()`);
  await call('Page.reload'); await sleep(2500);

  // ---- 1) 用真实 repository 建一条「今天、pending、带时间」的待办 ----
  const created = await evalJS(`(async function(){
    const mod = await import('/butler/butler-repository.js');
    const repo = mod.repository;
    const pad = (n) => String(n).padStart(2, '0');
    const day = (x) => x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate());
    const now = new Date();
    // 取一个「同一天、且提醒时刻已到或即将到」的事项时间：
    // 先试 5 分钟前；若跨了午夜（刚过 00:00）就改成 5 分钟后（仍在提前 15 分钟窗口内）
    let at = new Date(now.getTime() - 5 * 60000);
    if (day(at) !== day(now)) at = new Date(now.getTime() + 5 * 60000);
    const task = await repo.addTask({ type: 'todo', title: '睡觉', date: day(at), time: pad(at.getHours()) + ':' + pad(at.getMinutes()) });
    return { id: task.id, date: task.date, time: task.time, status: task.status };
  })()`);
  note('待办已建', `${created.date} ${created.time} status=${created.status}`);
  check('R1 真实 repository 建出今天 pending 待办', created.status === 'pending' && !!created.time);

  const rows = () => evalJS(`(async function(){
    const db = await new Promise((res, rej) => { const r = indexedDB.open('star_fifi_room'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const all = await new Promise((res, rej) => { const tx = db.transaction('messages'); const rq = tx.objectStore('messages').getAll(); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
    db.close();
    return all.filter(m => m && m.source === 'butler-remind').map(m => ({ id: m.id, content: m.content, role: m.role }));
  })()`);

  check('R2 刷新前不投递', (await rows()).length === 0);

  // ---- 2) 刷新页面：模拟真实用户重开页面 ----
  const t0 = Date.now();
  await call('Page.reload');
  await sleep(3000);
  const afterBoot = await rows();
  note('刷新后 3 秒内', `条数=${afterBoot.length}`);

  // 不做任何人工触发，等常规 tick（60s 间隔）
  let auto = afterBoot;
  for (let i = 0; i < 14 && auto.length === 0; i++) {
    await sleep(5000);
    auto = await rows();
  }
  const cost = Math.round((Date.now() - t0) / 1000);
  note('自动投递耗时', cost + 's');
  check('R3 刷新后无需人工操作即可补投', auto.length >= 1, `${cost}s / ${auto.length} 条`);
  check('R4 消息以 assistant 身份写入真实消息库', auto.length >= 1 && auto[0].role === 'assistant' && auto[0].id != null, auto.length ? String(auto[0].content) : '');
  check('R5 提醒文案包含事项名与时间', auto.length >= 1 && /睡觉/.test(String(auto[0].content)) && /\d{2}:\d{2}/.test(String(auto[0].content)), auto.length ? String(auto[0].content) : '');

  const dom = await evalJS(`(function(){
    const items = Array.from(document.querySelectorAll('#messages .assistant-message'));
    const hit = items.filter(x => x.innerText.includes('睡觉'));
    return { total: items.length, hit: hit.length, text: hit.length ? hit[hit.length-1].innerText.trim() : '' };
  })()`);
  check('R6 聊天界面渲染出这条提醒', dom.hit >= 1, dom.text.slice(0, 60));

  // ---- 3) 去重：再等两轮 tick 不重复 ----
  await evalJS(`(function(){ return window.LifeScheduler ? window.LifeScheduler.catchUp() : null; })()`);
  await sleep(1500);
  await evalJS(`(function(){ return window.LifeScheduler ? window.LifeScheduler.catchUp() : null; })()`);
  await sleep(1500);
  const twice = await rows();
  check('R7 多次 tick 不重复投递', twice.length === 1, String(twice.length));

  // ---- 4) 完成后不再投递 ----
  const doneStatus = await evalJS(`(async function(){
    const mod = await import('/butler/butler-repository.js');
    const t = await mod.repository.completeTask(${JSON.stringify(created.id)});
    return t && t.status;
  })()`);
  check('R8a 待办可正常标记完成', doneStatus === 'done', String(doneStatus));
  await evalJS(`(function(){ return window.LifeScheduler ? window.LifeScheduler.catchUp() : null; })()`);
  await sleep(1200);
  check('R8 已完成的待办不再补投', (await rows()).length === 1, String((await rows()).length));

  // ---- 5) 一次性：不是每日重复 ----
  const sched = await evalJS(`(function(){
    const s = window.LifeScheduler._state ? window.LifeScheduler._state() : null;
    return { tasks: window.LifeScheduler.list(), runs: s ? Object.keys(s.runs) : [] };
  })()`);
  note('调度器任务', JSON.stringify(sched.tasks.map(t => t.id)));
  check('R9 提醒任务按分钟 tick 注册，未改成每日重复', sched.tasks.some(t => t.id === 'butler.remind' && t.everyMs === 60000), JSON.stringify(sched.tasks.find(t => t.id === 'butler.remind') || null));

  // ---- 6) 聊天注入路径：模型没说到 → 不得消费，调度器立刻补一句 ----
  const setupMock = async (reply) => evalJS(`(function(){
    window.callAI = async function(){ return ${JSON.stringify(reply)}; };
    window.fetchEnglishTranslation = async function(){ return ''; };
    window.requestAndPlaySpeech = function(){};
    return 1;
  })()`);
  const send = async (reply, userText) => {
    await setupMock(reply);
    await evalJS(`(function(){ document.getElementById('chatInput').value = ${JSON.stringify(userText)}; return window.sendMessage(); })()`);
    await sleep(1500);
  };
  const addTask = (title, minutesAgo) => evalJS(`(async function(){
    const mod = await import('/butler/butler-repository.js');
    const pad = (n) => String(n).padStart(2, '0');
    const day = (x) => x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate());
    const now = new Date();
    let at = new Date(now.getTime() - ${minutesAgo} * 60000);
    if (day(at) !== day(now)) at = new Date(now.getTime() + 5 * 60000);
    const t = await mod.repository.addTask({ type: 'todo', title: ${JSON.stringify(title)}, date: day(at), time: pad(at.getHours()) + ':' + pad(at.getMinutes()) });
    return { id: t.id, time: t.time };
  })()`);

  const t2 = await addTask('喝水', 4);
  const before2 = (await rows()).length;
  await send('那就再坐一会儿吧。', '还不睡吗');            // 回复完全没提「喝水」
  check('R12 模型没提到时不会把提醒记成已投递', (await rows()).length === before2, String((await rows()).length));
  const pending2 = await evalJS(`(async function(){
    const hits = await window.ButlerIntent.dueReminders(Date.now());
    return hits.map(h => h.t.title);
  })()`);
  check('R13 该提醒仍处于待投递状态', pending2.includes('喝水'), JSON.stringify(pending2));
  // 不人工触发：等常规 tick 自己补出这条独立提醒
  let after2 = await rows();
  for (let i = 0; i < 15 && after2.length === before2; i++) { await sleep(5000); after2 = await rows(); }
  check('R14 调度器随即补出一条独立提醒', after2.length === before2 + 1 && after2.some(m => String(m.content).includes('喝水')), String(after2.length));

  // ---- 7) 聊天注入路径：模型说到了 → 不再重复补一条 ----
  const t3 = await addTask('写周报', 3);
  const before3 = (await rows()).length;
  await send('写周报，写完就睡。', '还不睡吗');            // 回复里明确提到事项名
  check('R15 模型已说到时记为已投递', (await evalJS(`(async function(){
    const hits = await window.ButlerIntent.dueReminders(Date.now());
    return hits.map(h => h.t.title);
  })()`)).includes('写周报') === false);
  await evalJS(`(function(){ return window.LifeScheduler.tick({ catchUp: true, forceVisible: true }); })()`);
  await sleep(1500);
  check('R16 已经说过的不再补发独立提醒', (await rows()).length === before3, String((await rows()).length - before3));

  check('R10 全程无外部网络请求', externalReqs.length === 0, externalReqs.slice(0, 3).join(','));
  check('R11 无页面异常', errors.length === 0, errors.join(' | ').slice(0, 120));

  const pass = results.filter(Boolean).length;
  console.log(`\n# ${pass}/${results.length} 通过`);
  if (pass !== results.length) process.exitCode = 1;
} catch (e) {
  console.log('FAIL  运行异常 — ' + e.message);
  process.exitCode = 1;
} finally {
  try { ws && ws.close(); } catch {}
  try { browser.kill(); } catch {}
}
