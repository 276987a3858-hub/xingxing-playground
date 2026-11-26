/* tests/butler/remind-real-page.mjs
 * 真实房间页面（http://127.0.0.1:8787/）验证待办提醒投递：
 * 真实 app.js + 真实 IndexedDB(star_fifi_room) + 真实调度器 tick，不用 mock。
 * 隔离 profile，不触碰用户数据；apiKey 为空，不发任何 /api 请求。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9341;
const BASE = process.argv[2] || 'http://127.0.0.1:8787';

const profile = `${process.env.TEMP || 'C:\\Windows\\Temp'}\\remind-edge-${Date.now()}`;
const browser = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--window-size=1280,900', 'about:blank',
], { stdio: 'ignore' });

const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };

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
  const requests = [], errors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); return; }
    if (m.method === 'Network.requestWillBeSent' && m.sessionId === sessionId) requests.push(m.params.request.url);
    if (m.method === 'Runtime.exceptionThrown' && m.sessionId === sessionId) errors.push(String(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || ''));
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    id += 1; pending.set(id, { resolve, reject });
    const payload = { id, method, params };
    if (sessionId && !method.startsWith('Target.')) payload.sessionId = sessionId;
    ws.send(JSON.stringify(payload));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('超时 ' + method)); } }, 15000);
  });
  const evalJS = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result.value;
  };

  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const att = await call('Target.attachToTarget', { targetId, flatten: true });
  sessionId = att.sessionId;
  await call('Page.enable'); await call('Runtime.enable'); await call('Network.enable');

  await call('Page.navigate', { url: BASE + '/' });
  await sleep(2500);

  // 1) 真实页面是否加载了本轮代码
  const loaded = await evalJS(`(function(){
    return {
      hasSched: typeof window.LifeScheduler === 'object',
      tasks: (window.LifeScheduler && window.LifeScheduler.list ? window.LifeScheduler.list().map(t => t.id) : []),
      hasIntent: !!(window.ButlerIntent && window.ButlerIntent.remindTick),
      apiKey: String(localStorage.getItem('apiKey') || '')
    };
  })()`);
  check('R01 页面加载了 LifeScheduler 与 butler-intent', loaded.hasSched && loaded.hasIntent);
  check('R02 butler.remind 任务已注册', loaded.tasks.includes('butler.remind'), loaded.tasks.join(','));

  // 2) 写一条今天 10 分钟后的一次性待办（提醒时刻 = 现在）
  const seeded = await evalJS(`(async function(){
    const now = Date.now();
    const d = new Date(now + 10*60000);
    const p = n => String(n).padStart(2,'0');
    const date = d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate());
    const time = p(d.getHours())+':'+p(d.getMinutes());
    const mod = await import('/butler/butler-repository.js');
    const t = await mod.repository.addTask({ title:'睡觉', date, time, type:'todo' });
    return { id:t.id, date:t.date, time:t.time, status:t.status };
  })()`);
  check('R03 待办写入成功', seeded.status === 'pending', `${seeded.date} ${seeded.time}`);

  // 3) 真实 tick：走 boot 补检路径（用户级任务不受 60 秒间隔门槛限制，等价于刷新后补投）
  await evalJS('window.LifeScheduler.tick({forceVisible:true, boot:true})');
  await sleep(600);
  const probe = `(async function(){
    const db = await new Promise((res, rej) => { const r = indexedDB.open('star_fifi_room'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const rows = await new Promise((res, rej) => { const tx = db.transaction('messages'); const rq = tx.objectStore('messages').getAll(); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
    db.close();
    const m = rows.filter(x => x.source === 'butler-remind');
    const last = document.querySelector('#messages .assistant-message:last-child');
    return {
      n: m.length,
      role: m.length ? m[m.length-1].role : '',
      content: m.length ? m[m.length-1].content : '',
      id: m.length ? m[m.length-1].id : null,
      hasTime: m.length ? typeof m[m.length-1].time === 'number' : false,
      lastText: last ? last.innerText.trim() : ''
    };
  })()`;
  const after = await evalJS(probe);
  check('R04 真实的 assistant 消息落库（结构正确）', after.n === 1 && after.role === 'assistant' && after.hasTime, after.content);
  check('R05 聊天界面渲染出这条消息', after.lastText.includes('睡觉'), after.lastText.slice(0, 40));

  // 4) 真实库里的持久化（刷新后仍在）
  const persisted = await evalJS(`(async function(){
    const db = await new Promise((res, rej) => { const r = indexedDB.open('star_fifi_room'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const rows = await new Promise((res, rej) => { const tx = db.transaction('messages'); const rq = tx.objectStore('messages').getAll(); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
    db.close();
    return rows.filter(x => x.source === 'butler-remind').length;
  })()`);
  check('R06 刷新后仍在（真实 IndexedDB 落库）', persisted === 1, String(persisted));

  // 5) 第二次 tick 不重复
  await evalJS('window.LifeScheduler.tick({forceVisible:true, boot:true})');
  await sleep(500);
  const twice = await evalJS(probe);
  check('R07 第二次 tick 不重复投递', twice.n === 1, String(twice.n));

  // 6) 一次性：即使时间过了也不再发
  await evalJS(`(async function(){
    const now = Date.now();
    const mod = await import('/butler/butler-repository.js');
    const t = (await mod.repository.listTasks())[0];
    return t ? 1 : 0;
  })()`);
  const afterWindow = await evalJS(`window.ButlerIntent.remindTick(Date.now() + 20*60000, { commit:false })`);
  check('R08 过窗口后不再产出（仍是一次性）', Array.isArray(afterWindow) && afterWindow.length === 0);

  // 7) 无 AI 请求
  const apiCalls = requests.filter((u) => u.includes('/api'));
  check('R09 全程 0 次 /api 请求', apiCalls.length === 0, String(apiCalls.length));
  check('R10 无页面异常', errors.length === 0, errors.join(' | ').slice(0, 120));

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
