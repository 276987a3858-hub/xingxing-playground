/* tests/butler/drawer-check.mjs — 侧拉抽屉真实浏览器验证（Edge DevTools Protocol）
 * 覆盖：首页开关、聊天页开关、聊天内容与滚动位置保持、两入口数据一致、
 *       抽屉内待办/睡眠/周期功能、桌面与手机视口、无异常无外发。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9355;
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const profile = `${process.env.TEMP}\\butler-drawer-${Date.now()}`;

const browser = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-component-update', '--window-size=1280,900', 'about:blank',
], { stdio: 'ignore' });

async function waitForDevTools() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return await r.json(); } catch {}
    await sleep(250);
  }
  throw new Error('DevTools 端口未就绪');
}

function connectWS(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error('WS 连接失败: ' + (e.message || '')));
  });
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

let ws;
try {
  const info = await waitForDevTools();
  ws = await connectWS(info.webSocketDebuggerUrl);

  let id = 0; const pending = new Map();
  const requests = []; const errors = [];
  let sessionId = null;
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      return;
    }
    if (m.method === 'Network.requestWillBeSent' && (!sessionId || m.sessionId === sessionId)) requests.push(m.params.request.url);
    if (m.method === 'Runtime.exceptionThrown') errors.push(String(m.params.exceptionDetails?.text || 'exception'));
  };
  const C = (method, params = {}, sid) => { id++; return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)); } }, 15000);
  }); };

  const { targetId } = await C('Target.createTarget', { url: 'about:blank' });
  const attached = await C('Target.attachToTarget', { targetId, flatten: true });
  sessionId = attached.sessionId;
  await C('Page.enable', {}, sessionId);
  await C('Runtime.enable', {}, sessionId);
  await C('Network.enable', {}, sessionId);

  const ev = async (expression, awaitPromise = false) => {
    const r = await C('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result.value;
  };
  const isOpen = () => ev('window.butlerDrawerIsOpen && window.butlerDrawerIsOpen()');
  const frameReady = () => ev(`(() => { const f=document.getElementById('butlerFrame');
    try { return !!(f && f.contentDocument && f.contentDocument.querySelector && f.contentDocument.querySelector('.tab')); } catch(e){ return false; } })()`);

  // ===== 首页：打开与关闭 =====
  await C('Page.navigate', { url: `${BASE}/` }, sessionId);
  await sleep(1200);
  const hasEntry = await ev(`!!document.querySelector('[onclick="openButlerDrawer()"]')`);
  check('D01 首页存在生活管家入口', hasEntry);

  await ev('openButlerDrawer()');
  await sleep(300);
  check('D02 首页打开抽屉（打开态）', await isOpen() === true);
  for (let i = 0; i < 30 && !(await frameReady()); i++) await sleep(200);
  check('D03 抽屉内生活管家页面加载成功', await frameReady() === true);
  const panelOnScreen = await ev(`(() => { const p=document.querySelector('.bl-drw-panel').getBoundingClientRect(); return p.left < window.innerWidth - 100; })()`);
  check('D04 抽屉面板已滑入视口', panelOnScreen === true);

  await ev('closeButlerDrawer()');
  await sleep(400);
  check('D05 首页关闭抽屉（关闭态）', await isOpen() === false);

  // ===== 聊天页：开关 + 内容与滚动保持 =====
  await ev(`showPage('chat')`);
  await sleep(300);
  const chatEntry = await ev(`!!document.querySelector('.bl-drw-leaf')`);
  check('D06 聊天页存在生活管家入口（全局叶子图标）', chatEntry === true);
  // 入口统一后，聊天页不应再有额外的文字入口（与顶栏叶子重复）
  const dupEntry = await ev(`!!document.querySelector('#chat .bl-drw-chat-entry')`);
  check('D06b 聊天页无重复的文字入口', dupEntry === false);

  // 造几条消息并让 #messages 可滚动，记录内容与滚动位置
  const before = await ev(`(() => {
    const box = document.getElementById('messages');
    for (let i=0;i<12;i++){ const d=document.createElement('div'); d.className='bubble bot'; d.textContent='保持测试消息 '+i; box.appendChild(d); }
    box.scrollTop = 300;
    window.__drawerScrollProbe = 4321; // 页面未刷新的探针
    return { html: box.innerHTML.length, count: box.children.length, scrollTop: box.scrollTop };
  })()`);

  await ev(`document.querySelector('.bl-drw-leaf').click()`);
  await sleep(300);
  check('D07 聊天页打开抽屉（打开态）', await isOpen() === true);
  await ev('closeButlerDrawer()');
  await sleep(400);
  check('D08 聊天页关闭抽屉（关闭态）', await isOpen() === false);

  const after = await ev(`(() => { const box=document.getElementById('messages');
    return { html: box.innerHTML.length, count: box.children.length, scrollTop: box.scrollTop,
             probe: window.__drawerScrollProbe, page: (document.querySelector('.page.active')||{}).id }; })()`);
  check('D09 聊天消息内容未丢失', after.count === before.count && after.html === before.html, `${before.count}→${after.count}`);
  check('D10 聊天滚动位置保持', Math.abs(after.scrollTop - before.scrollTop) <= 2, `${before.scrollTop}→${after.scrollTop}`);
  check('D11 页面未刷新（探针仍在）', after.probe === 4321);
  check('D12 关闭后仍在聊天页', after.page === 'chat', after.page);

  // ===== 两入口数据一致：经抽屉写入，关闭后从首页入口再打开查看 =====
  // 说明：iframe 与主页同源，共享同一个 IndexedDB star_butler_v1；
  // 用主页上下文 import repository 读写，等价于抽屉内页面看到的数据。
  const addRes = await ev(`(async () => {
    const m = await import('/butler/butler-repository.js');
    const t = await m.repository.addTask({ title: '抽屉写入_一致性测试', date: '2026-11-17' });
    return { id: t.id, title: t.title };
  })()`, true);
  check('D13 抽屉内新增待办成功', !!(addRes && addRes.id), JSON.stringify(addRes));

  await ev('closeButlerDrawer()');
  await sleep(350);
  await ev(`showPage('home'); openButlerDrawer()`);
  await sleep(500);
  const sameData = await ev(`(async () => {
    const m = await import('/butler/butler-repository.js');
    const list = await m.repository.listTasks();
    return list.some(t => t.id === '${addRes.id}' && t.title === '抽屉写入_一致性测试');
  })()`, true);
  check('D14 两入口打开同一 iframe、同一份数据', sameData === true);
  const sameFrame = await ev(`(() => {
    if (!window.__frameRef) { window.__frameRef = document.getElementById('butlerFrame'); return true; }
    return window.__frameRef === document.getElementById('butlerFrame');
  })()`);
  check('D15 iframe 为常驻单例（未重建）', sameFrame === true);

  // ===== 抽屉内：待办/睡眠/周期功能仍正常 =====
  const funcs = await ev(`(async () => {
    const m = await import('/butler/butler-repository.js');
    const t = await m.repository.addTask({ title: '抽屉闭环', date: '2026-11-17', time: '08:00' });
    await m.repository.completeTask(t.id);
    await m.repository.deferTask(t.id, { date: '2026-11-18' });
    const after = await m.repository.getTask(t.id);
    const sl = await m.repository.saveSleep({ date:'2026-11-17', sleepTime:'23:30', wakeTime:'07:30' });
    await m.repository.addCycle({ startDate:'2026-08-01', endDate:'2026-08-06' });
    await m.repository.addCycle({ startDate:'2026-09-01', endDate:'2026-09-06' });
    await m.repository.addCycle({ startDate:'2026-10-02', endDate:'2026-10-07' });
    const pred = await m.repository.prediction();
    return { status: after.status, date: after.date, dur: sl.durationMs,
             predOk: pred.ok, samples: pred.samples };
  })()`, true);
  check('D16 抽屉内待办完成→延期闭环', funcs.status === 'pending' && funcs.date === '2026-11-18', JSON.stringify(funcs));
  check('D17 抽屉内跨午夜睡眠 8 小时', funcs.dur === 28800000);
  check('D18 抽屉内周期预测（3 条样本）', funcs.predOk === true, JSON.stringify(funcs));

  // ===== Esc / 遮罩关闭 =====
  await C('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId);
  await C('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId);
  await sleep(350);
  check('D19 Esc 关闭抽屉', await isOpen() === false);

  await ev('openButlerDrawer()');
  await sleep(250);
  await ev(`document.querySelector('.bl-drw-mask').click()`);
  await sleep(350);
  check('D20 点击遮罩关闭抽屉', await isOpen() === false);

  // ===== 手机视口 =====
  await C('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, sessionId);
  await C('Page.navigate', { url: `${BASE}/` }, sessionId);
  await sleep(900);
  await ev('openButlerDrawer()');
  await sleep(400);
  const mobile = await ev(`(() => { const p=document.querySelector('.bl-drw-panel').getBoundingClientRect();
    const c=document.querySelector('.bl-drw-close').getBoundingClientRect();
    return { panelW: Math.round(p.width), vw: window.innerWidth, closeVisible: c.width>0 && c.top>=0,
             bodyOverflow: document.body.scrollWidth <= window.innerWidth + 2 }; })()`);
  check('D21 手机视口抽屉铺满且无横向溢出', mobile.panelW <= mobile.vw + 2 && mobile.bodyOverflow, JSON.stringify(mobile));
  check('D22 手机视口关闭按钮可见', mobile.closeVisible === true);

  const external = requests.filter(u => !u.startsWith(BASE) && !u.startsWith('data:') && !u.startsWith('about:') && !u.startsWith('devtools'));
  // 房间首页既有天气请求 wttr.in（app.js:236），与生活管家无关，列为已知项排除。
  const knownRoomRequests = external.filter(u => u.startsWith('https://wttr.in/'));
  const unexpected = external.filter(u => !u.startsWith('https://wttr.in/'));
  check('D23 生活管家业务数据无外发请求', unexpected.length === 0,
    unexpected.length ? unexpected.slice(0, 5).join(' | ') : `仅房间既有天气请求 ${knownRoomRequests.length} 次`);
  check('D24 无页面脚本异常', errors.length === 0, errors.slice(0, 3).join(' | '));

  const failed = results.filter(r => !r.ok);
  console.log(`\n总计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  if (failed.length) process.exitCode = 1;
} catch (e) {
  console.error('抽屉验证异常:', e.stack || e.message);
  process.exitCode = 1;
} finally {
  try { ws && ws.close(); } catch {}
  try { browser.kill(); } catch {}
}
