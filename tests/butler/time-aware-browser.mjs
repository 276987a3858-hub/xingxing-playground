/* tests/butler/time-aware-browser.mjs
 * 时间感知根因回归：真实页面 + 可控本地时钟，验证三套提示词时间函数统一走 LifeClock（浏览器本地时间）。
 * 覆盖 18:38 傍晚 / 21:00 晚上 / 22:50 接近深夜 / 23:00 深夜 / 00:10 跨午夜；
 * 刷新与重进聊天后时间不残留；AI 常驻提示词禁止编造具体钟点。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9377, BASE = process.argv[2] || 'http://127.0.0.1:8787';
const profile = `${process.env.TEMP || 'C:\\Windows\\Temp'}\\ta-edge-${Date.now()}`;
const browser = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });

const checks = [];
const check = (n, ok, d = '') => { checks.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };

let ws;
try {
  let info = null;
  for (let i = 0; i < 40 && !info; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) info = await r.json(); } catch {}
    if (!info) await sleep(250);
  }
  if (!info) throw new Error('DevTools 未就绪');
  ws = await new Promise((res, rej) => { const s = new WebSocket(info.webSocketDebuggerUrl); s.onopen = () => res(s); s.onerror = () => rej(new Error('WS')); });
  const pending = new Map(); let id = 0, sid = null;
  const external = [], errors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); return; }
    if (m.method === 'Network.requestWillBeSent' && m.sessionId === sid) {
      const u = m.params.request.url;
      if (!u.startsWith('http://127.0.0.1') && u.indexOf('cdnjs.cloudflare.com') === -1 && u.indexOf('data:') !== 0) external.push(u);
    }
    if (m.method === 'Runtime.exceptionThrown' && m.sessionId === sid) errors.push(String(m.params.exceptionDetails?.exception?.description || ''));
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    id += 1; pending.set(id, { resolve, reject });
    const p = { id, method, params }; if (sid && !method.startsWith('Target.')) p.sessionId = sid;
    ws.send(JSON.stringify(p)); setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('超时 ' + method)); } }, 15000);
  });
  const ev = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  sid = (await call('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  await call('Page.enable'); await call('Runtime.enable'); await call('Network.enable');

  // 可控本地时钟：只整体平移 now，不改时区；所有 Date 读取（含 LifeClock）都走同一个时钟
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const Real = Date;
    let offset = 0;
    window.__setNow = (iso) => { offset = new Real(iso).getTime() - Real.now(); return window.__nowText(); };
    window.__nowText = () => { const d = new Real(Real.now() + offset); const p = n => String(n).padStart(2,'0');
      return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes()); };
    function Fake(...args) {
      if (new.target) return args.length ? new Real(...args) : new Real(Real.now() + offset);
      return new Real(Real.now() + offset).toString();
    }
    Fake.prototype = Real.prototype; Fake.now = () => Real.now() + offset;
    Fake.parse = Real.parse; Fake.UTC = Real.UTC;
    window.Date = Fake;
    window.fetch = () => Promise.resolve(new Response('{"choices":[{"message":{"content":""}}]}',{headers:{'content-type':'application/json'}}));
  })();` });

  await call('Page.navigate', { url: BASE + '/' });
  for (let i = 0; i < 50; i++) {
    const ready = await ev(`document.readyState === 'complete' && typeof getTimeContext === 'function' && !!window.LifeClock`).catch(() => false);
    if (ready) break;
    await sleep(200);
  }
  await sleep(500);

  const snap = (iso) => ev(`(function(){
    window.__setNow(${JSON.stringify(iso)});
    const sys = getSystemPrompt();
    return { local: window.__nowText(), nowCtx: getNowContext(), time: getTimeContext(),
      sched: getScheduleContext(), sys: sys.slice(0, 240), lcPart: window.LifeClock.partOfDay() };
  })()`);

  const t1838 = await snap('2026-11-18T18:38:00');
  check('T01 18:38 本地时钟正确', t1838.local.endsWith('18:38') && t1838.nowCtx.includes('18:38'), JSON.stringify(t1838.local));
  check('T02 18:38 属于傍晚，不出现深夜/催睡', t1838.time.includes('傍晚') && !/深夜|还不睡|去睡觉/.test(t1838.time) && !/夜猫子|还不睡/.test(t1838.sched),
    t1838.time + ' | ' + t1838.sched);
  check('T03 LifeClock 与提示词时段同源', t1838.lcPart === '傍晚' && t1838.time.includes('傍晚'), t1838.lcPart);
  check('T04 常驻提示词不再留「另有精确时间提示」的歧义口子', !t1838.sys.includes('除非另有精确时间提示'), '');
  check('T05 常驻提示词不带绝对时间', !/\d{1,2}:\d{2}/.test(t1838.sys.slice(t1838.sys.indexOf('时间提示'), t1838.sys.indexOf('时间提示') + 160)), '');

  const t2100 = await snap('2026-11-18T21:00:00');
  check('T06 21:00 进入晚间语境', t2100.time.includes('晚上') && !/快到深夜|还不睡/.test(t2100.time) && t2100.lcPart === '晚上', t2100.time);

  const t2250 = await snap('2026-11-18T22:50:00');
  check('T07 22:50 只说夜色浓、还没到深夜（不往回进位的措辞）',
    /还不睡/.test(t2250.time) && !/快到深夜|接近深夜/.test(t2250.time + t2250.sched) && /还没到深夜/.test(t2250.sched),
    t2250.time + ' | ' + t2250.sched);

  const t2300 = await snap('2026-11-18T23:00:00');
  check('T08 23:00 进入深夜语境', t2300.time.includes('现在是深夜') && t2300.time.includes('还不睡') && t2300.lcPart === '深夜', t2300.time);

  const t0010 = await snap('2026-11-19T00:10:00');
  check('T09 00:10 跨午夜仍正确', t0010.time.includes('凌晨') && t0010.nowCtx.includes('2026-11-19 00:10') && t0010.lcPart === '深夜',
    t0010.time + ' | ' + t0010.nowCtx);

  // 刷新 / 重进聊天：时间必须重新读取，不残留上一次的描述
  await ev(`window.__setNow('2026-11-18T18:38:00')`);
  await call('Page.reload'); await sleep(900);
  const afterReload = await ev(`(function(){ window.__setNow('2026-11-18T18:38:00');
    const p = getSystemPrompt(); return { t: getTimeContext(), sys: p.slice(0,200), local: window.__nowText() }; })()`);
  check('T10 刷新后仍是傍晚且无旧深夜话术', afterReload.t.includes('傍晚') && !/深夜|还不睡/.test(afterReload.t), afterReload.t);
  const reenter = await ev(`(function(){ showPage('chat'); window.__setNow('2026-11-18T23:00:00');
    return { t: getTimeContext(), sysNeed: getNowBlock().includes(getNowContext()) }; })()`);
  check('T11 重进聊天后时段随时钟更新', reenter.t.includes('现在是深夜'), reenter.t);
  check('T12 精确时间块每次现取，无缓存', reenter.sysNeed === true, '');
  check('T13 同一时刻重复读取结果稳定（不会抖动）', (await ev(`getTimeContext() === getTimeContext()`)) === true, '');

  check('T14 无外部网络请求', external.length === 0, external.join(','));
  check('T15 无页面异常', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) {
  check('运行异常', false, String(e && e.stack || e));
} finally {
  try { ws && ws.close(); } catch {}
  browser.kill();
}
const pass = checks.filter(Boolean).length;
console.log(`\n时间感知浏览器测试：${pass}/${checks.length} 通过`);
process.exit(pass === checks.length ? 0 : 1);
