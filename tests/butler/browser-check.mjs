/* tests/butler/browser-check.mjs
 * 使用本机 Edge/Chrome 的 DevTools Protocol 做真实浏览器验证。
 * 不引入项目依赖：Node 22 内置 WebSocket。
 * 验证：页面渲染、IndexedDB 真实读写、待办闭环、刷新持久化、无网络外发。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333;
const BASE = process.argv[2] || 'http://127.0.0.1:8799';

function findChrome(profile) {
  return spawn(EDGE, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--window-size=1280,900',
    'about:blank',
  ], { stdio: 'ignore' });
}

async function waitForDevTools() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(250);
  }
  throw new Error('DevTools 端口未就绪');
}

function connectWS(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error('WebSocket 连接失败: ' + (e.message || '')));
  });
}

function makeRPC(ws) {
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  };
  return function call(method, params = {}, sessionId) {
    id += 1;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify(payload));
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('RPC 超时: ' + method)); } }, 15000);
    });
  };
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const profile = `${process.env.TEMP}\\butler-edge-${Date.now()}`;
const browser = findChrome(profile);
let ws;
try {
  const info = await waitForDevTools();
  ws = await connectWS(info.webSocketDebuggerUrl);
  const call = makeRPC(ws);

  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  const C = (m, p = {}) => call(m, p, sessionId);

  await C('Page.enable');
  await C('Runtime.enable');
  await C('Network.enable');

  const requests = [];
  const consoleErrors = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Network.requestWillBeSent' && msg.sessionId === sessionId) {
      requests.push(msg.params.request.url);
    }
    if (msg.method === 'Runtime.exceptionThrown' && msg.sessionId === sessionId) {
      consoleErrors.push(String(msg.params.exceptionDetails?.text || 'exception'));
    }
    if (msg.id && msg._rpcPending) {}
  };
  // 重新绑定 RPC（上面的 onmessage 覆盖了），合并两者
  const rpcPending = new Map();
  let rpcId = 10000;
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && rpcPending.has(msg.id)) {
      const { resolve, reject } = rpcPending.get(msg.id);
      rpcPending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Network.requestWillBeSent' && msg.sessionId === sessionId) requests.push(msg.params.request.url);
    if (msg.method === 'Runtime.exceptionThrown' && msg.sessionId === sessionId) consoleErrors.push(String(msg.params.exceptionDetails?.text || 'exception'));
  };
  const C2 = (m, p = {}) => {
    rpcId += 1;
    return new Promise((resolve, reject) => {
      rpcPending.set(rpcId, { resolve, reject });
      ws.send(JSON.stringify({ id: rpcId, method: m, params: p, sessionId }));
      setTimeout(() => { if (rpcPending.has(rpcId)) { rpcPending.delete(rpcId); reject(new Error('RPC 超时: ' + m)); } }, 15000);
    });
  };

  async function evalJS(expression, awaitPromise = false) {
    const r = await C2('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result.value;
  }

  // 1) 打开生活管家页面
  await C2('Page.navigate', { url: `${BASE}/butler/` });
  await sleep(1500);
  const title = await evalJS('document.title');
  check('B01 页面标题正确', title.includes('生活管家'), title);

  const tabCount = await evalJS('document.querySelectorAll(".tab").length');
  check('B02 五个功能入口均渲染', tabCount === 5, `tab 数量=${tabCount}`);

  // 2) 真实 IndexedDB 写入（通过页面 module）
  const addResult = await evalJS(`(async () => {
    const m = await import('/butler/butler-repository.js');
    const t = await m.repository.addTask({ title: '浏览器端_买菜', date: '2026-11-17', time: '09:30' });
    return { id: t.id, status: t.status, hist: t.history.length };
  })()`, true);
  check('B03 真实 IndexedDB 新增待办', addResult && addResult.status === 'pending' && addResult.hist === 1, JSON.stringify(addResult));

  // 3) 完成 / 延期 / 历史
  const flow = await evalJS(`(async () => {
    const m = await import('/butler/butler-repository.js');
    const list = await m.repository.listTasks();
    const t = list[0];
    await m.repository.completeTask(t.id);
    await m.repository.deferTask(t.id, { date: '2026-11-18' });
    const after = await m.repository.getTask(t.id);
    const hist = await m.repository.history();
    return { count: list.length, status: after.status, date: after.date, actions: after.history.map(h => h.action), histTotal: hist.length };
  })()`, true);
  check('B04 完成→延期闭环且原记录不新增', flow.count === 1 && flow.status === 'pending' && flow.date === '2026-11-18', JSON.stringify(flow));
  check('B05 历史记录完整', flow.actions.includes('created') && flow.actions.includes('done') && flow.actions.includes('deferred'), JSON.stringify(flow.actions));

  // 4) 刷新后持久化
  await C2('Page.reload', {});
  await sleep(1200);
  const afterReload = await evalJS(`(async () => {
    const m = await import('/butler/butler-repository.js');
    const list = await m.repository.listTasks();
    return { count: list.length, title: list[0] && list[0].title };
  })()`, true);
  check('B06 刷新后数据持久化', afterReload.count === 1 && afterReload.title === '浏览器端_买菜', JSON.stringify(afterReload));

  // 5) UI 交互：通过真实表单添加
  await evalJS(`
    (() => {
      document.querySelector('[data-tab="tasks"]').click();
      document.getElementById('tTitle').value = '浏览器UI_交表';
      document.getElementById('tDate').value = '2026-11-17';
      document.getElementById('taskForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    })()
  `);
  await sleep(700);
  const uiAdded = await evalJS(`(async () => {
    const m = await import('/butler/butler-repository.js');
    const list = await m.repository.listTasks();
    return { count: list.length, has: list.some(t => t.title === '浏览器UI_交表') };
  })()`, true);
  check('B07 真实表单提交写入成功', uiAdded.count === 2 && uiAdded.has, JSON.stringify(uiAdded));

  // 6) 作息跨午夜（真实浏览器）
  const sleepRec = await evalJS(`(async () => {
    const m = await import('/butler/butler-repository.js');
    const r = await m.repository.saveSleep({ date: '2026-11-17', sleepTime: '23:30', wakeTime: '07:30' });
    return { durationMs: r.durationMs, sleepDate: r.sleepDate };
  })()`, true);
  check('B08 浏览器端跨午夜睡眠 8 小时', sleepRec.durationMs === 28800000 && sleepRec.sleepDate === '2026-11-16', JSON.stringify(sleepRec));

  // 7) 周期不足不预测
  const pred = await evalJS(`(async () => {
    const m = await import('/butler/butler-repository.js');
    return await m.repository.prediction();
  })()`, true);
  check('B09 数据不足时明确无法预测', pred.ok === false && !pred.nextStart, JSON.stringify(pred));

  // 8) 无本地数据外发：请求里不应出现业务数据
  const external = requests.filter(u => !u.startsWith(BASE) && !u.startsWith('data:') && !u.startsWith('about:') && !u.startsWith('devtools'));
  check('B10 无生活数据外发请求', external.length === 0, external.slice(0, 5).join(' | '));
  check('B11 无页面脚本异常', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  // 9) 房间首页入口
  await C2('Page.navigate', { url: `${BASE}/` });
  await sleep(1000);
  const entry = await evalJS(`(() => {
    const a = [...document.querySelectorAll('a.tile')].find(x => x.getAttribute('href') === '/butler/');
    return { found: !!a, text: a ? a.textContent.trim() : '' };
  })()`);
  check('B12 房间首页生活管家入口存在', entry.found, entry.text);

  // 10) 手机视口渲染
  await C2('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await C2('Page.navigate', { url: `${BASE}/butler/` });
  await sleep(1000);
  const mobile = await evalJS(`(() => {
    const tabs = document.querySelector('.tabs');
    return { bodyWidth: document.body.scrollWidth, viewport: window.innerWidth, tabs: tabs && tabs.getBoundingClientRect().width };
  })()`);
  check('B13 手机视口无横向溢出', mobile.bodyWidth <= mobile.viewport + 2, JSON.stringify(mobile));

  const failed = results.filter(r => !r.ok);
  console.log(`\n总计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  if (failed.length) process.exitCode = 1;
} catch (e) {
  console.error('浏览器验证异常:', e.stack || e.message);
  process.exitCode = 1;
} finally {
  try { ws && ws.close(); } catch {}
  try { browser.kill(); } catch {}
}
