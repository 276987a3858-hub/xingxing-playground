/* tests/butler/proactive-context-browser.mjs
 * 情境感知式主动关心第一阶段：真实页面 + stub AI（零真实请求、零费用）。
 * 覆盖：本地无理由静默、待办/提醒/未接话头/生活状态、模型沉默、翻译成本、
 *       疲惫静默、隐藏恢复门槛、现有调度约束与普通主聊不受影响。
 */
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = path.resolve('public');
const PORT = 9461, CDP = 9462;
const reqs = [];
let stubMode = 'plain';

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api') {
    let text = '';
    req.on('data', (c) => { text += c; });
    req.on('end', () => {
      let body = {}; try { body = JSON.parse(text); } catch {}
      const msgs = body.messages || [];
      const sys = String(msgs[0]?.content || '');
      reqs.push({
        at: Date.now(),
        translator: sys.includes('professional translator'),
        sys,
        userText: String([...msgs].reverse().find((m) => m.role === 'user')?.content || ''),
      });
      let content;
      if (sys.includes('professional translator')) content = 'Translated text.';
      else if (stubMode === 'error') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'stub failure' }));
        return;
      }
      else if (stubMode === 'silent') content = '';
      else if (stubMode === 'sentinel') content = '[[SILENT]]';
      else if (stubMode === 'bilingual') content = '今天那件事，还记着吗？ ||| Remember that thing?';
      else content = '今天那件事，还记着吗？';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
    return;
  }
  let p = decodeURIComponent(u.pathname); if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !existsSync(f)) { res.writeHead(404); res.end(); return; }
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' }[path.extname(f)] || 'application/octet-stream';
  res.writeHead(200, { 'content-type': mime }); res.end(readFileSync(f));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const checks = [];
const check = (n, ok, d = '') => { checks.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.join(tmpdir(), 'bl-proactive-' + Date.now());
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
    let hidden = false;
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get() { return hidden; } });
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get() { return hidden ? 'hidden' : 'visible'; } });
    window.__setHidden = v => { hidden = !!v; document.dispatchEvent(new Event('visibilitychange')); };
    const of = window.fetch.bind(window);
    window.fetch = (url, opts) => typeof url === 'string' && url.includes('wttr.in')
      ? Promise.resolve(new Response(JSON.stringify({ current_condition: [{ weatherDesc: [{ value: '晴朗' }] }] }), { headers: { 'content-type': 'application/json' } }))
      : of(url, opts);
  })();` });
  await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  for (let i = 0; i < 60; i++) { if (await ev(`document.readyState==='complete' && typeof runIdleCheck==='function'`).catch(() => false)) break; await sleep(200); }
  await ev(`apiKey='stub'; settings.showEnglish=false; settings.voiceEnabled=false;
    window.__speech=[]; window.__toasts=[];
    requestAndPlaySpeech=function(t,id){ window.__speech.push({text:String(t),id:id}); return Promise.resolve(''); };
    toast=function(s){ window.__toasts.push(String(s)); };
    if (window.LifeScheduler && window.LifeScheduler.stop) window.LifeScheduler.stop();
    'ok'`);

  const reset = async (iso) => ev(`(async function(){
    window.__setNow(${JSON.stringify(iso)});
    chatHistory.length = 0;
    window.__speech.length = 0; window.__toasts.length = 0;
    if (window.LifeTopics && window.LifeTopics._reset) window.LifeTopics._reset();
    try { localStorage.clear(); } catch(e) {}
    try { const m = await import('/butler/butler-repository.js'); const rows = await m.repository.listTasks();
      for (const t of rows) await m.repository.removeTask(t.id); } catch(e) {}
    lastUserActivityAt = Date.now() - 10*60000;
    lastIdleAttemptAt = 0;
    window.__yxIdleLast = null;
    return 'ok';
  })()`);
  const runIdle = async () => ev(`runIdleCheck().then(r => ({ r: r, last: window.__yxIdleLast, n: chatHistory.length }))`);
  const mainReqs = () => reqs.filter((r) => !r.translator);
  const trReqs = () => reqs.filter((r) => r.translator);

  // 1) 没有任何合适理由：本地静默，0 请求 0 消息
  await reset('2026-11-19T20:00:00'); reqs.length = 0; stubMode = 'plain';
  let out = await runIdle();
  check('A01 无理由时不调用 AI', reqs.length === 0 && out.r === null && out.last && out.last.reason === 'no-reason', JSON.stringify(out.last));
  check('A02 无理由时不产生消息/语音/提示', out.n === 0 && (await ev(`window.__speech.length`)) === 0 && (await ev(`window.__toasts.length`)) === 0, '');

  // 2) 当天未完成待办进入判断
  await reset('2026-11-19T20:00:00'); reqs.length = 0; stubMode = 'plain';
  await ev(`(async function(){ const m=await import('/butler/butler-repository.js');
    await m.repository.addTask({title:'把论文提纲写完',date:'2026-11-19',time:'21:30'}); return 'ok'; })()`);
  out = await runIdle();
  let prompt = out.r ? mainReqs()[0].userText : '';
  check('B01 未完成待办触发一次主请求', reqs.length === 1 && !!out.r, 'requests=' + reqs.length);
  check('B02 待办标题与时刻进入精简上下文', prompt.includes('把论文提纲写完') && prompt.includes('今天还没做完的事') && mainReqs()[0].sys.includes('【当前时间】'), '');
  check('B03 待办上下文带防伪造边界', prompt.includes('不要把页面活动信号描述成你亲眼观察到用户的现实行为'), '');

  // 3) 临近/已到点提醒进入判断（remindAt 明确，未投递）
  await reset('2026-11-19T21:00:00'); reqs.length = 0; stubMode = 'plain';
  await ev(`(async function(){ const m=await import('/butler/butler-repository.js');
    await m.repository.addTask({title:'吃药',date:'2026-11-19',time:'21:05',remindAt:new Date('2026-11-19T20:55:00').getTime()}); return 'ok'; })()`);
  out = await runIdle();
  prompt = out.r ? mainReqs()[0].userText : '';
  check('C01 已到点提醒触发请求', reqs.length === 1 && !!out.r, 'requests=' + reqs.length);
  check('C02 提醒上下文进入提示词且标注非当前时间', prompt.includes('刚到点的提醒') && prompt.includes('吃药') && prompt.includes('提醒时刻不等于当前时间'), '');

  // 4) 近期聊天里未自然接上的话头
  await reset('2026-11-19T20:00:00'); reqs.length = 0; stubMode = 'plain';
  await ev(`chatHistory.push({role:'user',content:'下次教我弹钢琴吧',time:Date.now()}); 'ok'`);
  out = await runIdle();
  prompt = out.r ? mainReqs()[0].userText : '';
  check('D01 未接上的话头触发请求', reqs.length === 1 && !!out.r, 'requests=' + reqs.length);
  check('D02 话头原文进入上下文且标明只是可能话题', prompt.includes('下次教我弹钢琴吧') && prompt.includes('别当成你答应过什么'), '');

  // 5) 有理由但模型选择沉默：空回复 / 标记
  for (const mode of ['silent', 'sentinel']) {
    await reset('2026-11-19T20:00:00'); reqs.length = 0; stubMode = mode;
    await ev(`chatHistory.push({role:'user',content:'下次一起去看星星',time:Date.now()}); 'ok'`);
    const nBefore = await ev(`chatHistory.length`);
    out = await runIdle();
    check('E01 ' + mode + ' 沉默不落库', reqs.length === 1 && out.r === null && out.n === nBefore && out.last && out.last.reason === 'silent', JSON.stringify(out.last));
    check('E02 ' + mode + ' 沉默不触发翻译/语音/提示', trReqs().length === 0 && (await ev(`window.__speech.length`)) === 0 && (await ev(`window.__toasts.length`)) === 0, '');
  }
  // 沉默不消耗预算
  const budgetAfterSilent = await ev(`window.LifeScheduler.budget(Date.now())`);
  check('E03 沉默不消耗 ambient 预算', budgetAfterSilent && budgetAfterSilent.count === 0, JSON.stringify(budgetAfterSilent));

  // 6) 主动关心只发一次主请求；模型自带英文直接用，不强制翻译
  await reset('2026-11-19T20:00:00'); reqs.length = 0; stubMode = 'plain';
  await ev(`chatHistory.push({role:'user',content:'下次教我弹钢琴吧',time:Date.now()}); 'ok'`);
  out = await runIdle();
  let msg = await ev(`(function(){const m=chatHistory.filter(x=>x&&x.source==='idle');return m.length?{n:m.length,c:m[m.length-1].content,e:m[m.length-1].englishContent}:{n:0};})()`);
  check('F01 主动关心只有一次主请求', reqs.length === 1 && trReqs().length === 0 && !!out.r, 'requests=' + reqs.length);
  check('F02 主动消息正常落库显示', msg.n === 1 && msg.c.includes('今天那件事') && msg.e === '', JSON.stringify(msg));
  check('F03 没有英文时不翻译、不语音', (await ev(`window.__speech.length`)) === 0, '');

  await reset('2026-11-19T20:00:00'); reqs.length = 0; stubMode = 'bilingual';
  await ev(`chatHistory.push({role:'user',content:'下次教我弹钢琴吧',time:Date.now()}); 'ok'`);
  out = await runIdle();
  msg = await ev(`(function(){const m=chatHistory.filter(x=>x&&x.source==='idle');return m.length?{c:m[m.length-1].content,e:m[m.length-1].englishContent}:{};})()`);
  check('F04 模型自带英文被采用且仍只有一次请求', reqs.length === 1 && msg.e === 'Remember that thing?' && (await ev(`window.__speech.length`)) === 1, JSON.stringify(msg));

  // 7) 疲惫 / 不想聊：尊重 LifeTopics 静默
  await reset('2026-11-19T20:00:00'); reqs.length = 0; stubMode = 'plain';
  await ev(`window.LifeTopics.hush(Date.now(), 40*60000); chatHistory.push({role:'user',content:'下次教我弹钢琴吧',time:Date.now()}); 'ok'`);
  const nQuiet = await ev(`chatHistory.length`);
  out = await runIdle();
  check('G01 明确疲惫时不主动', reqs.length === 0 && out.n === nQuiet && out.last && out.last.reason === 'topic-quiet', JSON.stringify(out.last));

  // 8) 页面隐藏时不调用 AI
  await reset('2026-11-19T20:00:00'); reqs.length = 0; stubMode = 'plain';
  await ev(`window.__setHidden(true); chatHistory.push({role:'user',content:'下次教我弹钢琴吧',time:Date.now()}); 'ok'`);
  const nHidden = await ev(`chatHistory.length`);
  out = await runIdle();
  check('H01 隐藏时不主动', reqs.length === 0 && out.n === nHidden && out.last && out.last.reason === 'hidden', JSON.stringify(out.last));
  await ev(`window.__setHidden(false); 'ok'`);

  // 9) 恢复后仍遵守 idle 门槛、冷却、每日预算、夜间静默；调度器任务未变
  await reset('2026-11-19T20:00:00'); reqs.length = 0;
  await ev(`lastUserActivityAt = Date.now(); 'ok'`);
  out = await runIdle();
  check('I01 刚恢复时 idle 门槛仍生效', reqs.length === 0 && out.last && out.last.reason === 'not-idle-enough', JSON.stringify(out.last));

  const sched = await ev(`(function(){var s=JSON.parse(localStorage.getItem('ylxh.sched.v1')||'{}');
    s.day='2026-11-19'; s.ambient={count:15,lastAt:Date.now()}; localStorage.setItem('ylxh.sched.v1',JSON.stringify(s));
    var b=window.LifeScheduler.budget(Date.now()); return {count:b.count,limit:b.limit,canUse:b.canUse,cooldown:b.cooldownLeftMs}; })()`);
  check('I02 每日预算与冷却仍限制主动互动（上限 15）', sched.count === 15 && sched.limit === 15 && sched.canUse === false && sched.cooldown > 0, JSON.stringify(sched));
  const quiet = await ev(`window.__setNow('2026-11-19T23:45:00'); window.LifeScheduler.budget(Date.now()).quiet`);
  check('I03 夜间静默仍生效', quiet === true, String(quiet));
  await ev(`localStorage.removeItem('ylxh.sched.v1'); 'ok'`);
  const ids = await ev(`window.LifeScheduler.list().map(x=>x.id)`);
  check('I04 仍是单一调度器的四个原任务', JSON.stringify(ids) === JSON.stringify(['butler.remind', 'room.futureLetter', 'room.idle', 'life.state']), JSON.stringify(ids));

  // 10) 普通主聊双语行为、提醒、珍藏/游戏入口不受影响
  await reset('2026-11-19T20:00:00'); reqs.length = 0; stubMode = 'plain';
  await ev(`settings.showEnglish=true; 'ok'`);
  await ev(`(function(){const el=document.getElementById('chatInput');el.value='今天怎么样';el.dispatchEvent(new Event('input',{bubbles:true}));return sendMessage();})()`);
  await sleep(600);
  check('J01 普通主聊仍保留双语翻译请求', mainReqs().length === 1 && trReqs().length === 1, 'main=' + mainReqs().length + ' tr=' + trReqs().length);
  await ev(`settings.showEnglish=false; 'ok'`);
  const api = await ev(`Object.keys(window.ButlerIntent).filter(k=>['dueReminders','remindTick','remindContext','tryLocal'].indexOf(k)>=0)`);
  check('J02 生活管家读取接口仍可用', api.length === 4, JSON.stringify(api));

  // 11) 主动请求尝试冷却：沉默/失败也算一次尝试，15 分钟内不再打 AI
  await reset('2026-11-19T20:00:00'); reqs.length = 0; stubMode = 'silent';
  await ev(`chatHistory.push({role:'user',content:'下次教我弹钢琴吧',time:Date.now()}); 'ok'`);
  out = await runIdle();
  check('L01 模型沉默确实发出 1 次请求', reqs.length === 1 && out.r === null && out.last.reason === 'silent', JSON.stringify(out.last));

  await ev(`window.__setNow('2026-11-19T20:05:00'); 'ok'`); reqs.length = 0;
  out = await runIdle();
  check('L02 沉默后 15 分钟内不再请求 AI', reqs.length === 0 && out.last.reason === 'attempt-cooldown', JSON.stringify(out.last));

  await ev(`window.__setNow('2026-11-19T20:15:05'); 'ok'`); reqs.length = 0; stubMode = 'silent';
  out = await runIdle();
  check('L03 满 15 分钟后可再次尝试', reqs.length === 1 && out.last.reason === 'silent', JSON.stringify(out.last));

  // 请求失败：原因码 ai-error，且同样进入尝试冷却、不落库、不消耗开口预算
  await reset('2026-11-19T20:00:00'); reqs.length = 0; stubMode = 'error';
  await ev(`chatHistory.push({role:'user',content:'下次教我弹钢琴吧',time:Date.now()}); 'ok'`);
  const nErr0 = await ev(`chatHistory.length`);
  out = await runIdle();
  check('L04 请求失败原因码为 ai-error 且不落库', reqs.length === 1 && out.r === null && out.n === nErr0 && out.last.reason === 'ai-error', JSON.stringify(out.last));

  await ev(`window.__setNow('2026-11-19T20:05:00'); 'ok'`); reqs.length = 0;
  out = await runIdle();
  check('L05 失败后 15 分钟内不再请求 AI', reqs.length === 0 && out.last.reason === 'attempt-cooldown', JSON.stringify(out.last));
  const budgetAfterErr = await ev(`window.LifeScheduler.budget(Date.now())`);
  check('L06 沉默/失败不消耗每日开口预算', budgetAfterErr.count === 0, JSON.stringify(budgetAfterErr));

  // 正常开口：每日预算 +1，原有 15 分钟成功冷却仍生效（预算由调度器 tick 消费，需走真实 tick）
  await reset('2026-11-19T20:00:00'); reqs.length = 0; stubMode = 'plain';
  await ev(`chatHistory.push({role:'user',content:'下次教我弹钢琴吧',time:Date.now()}); 'ok'`);
  const repL7 = await ev(`window.LifeScheduler.tick({forceVisible:true}).then(r=>({ran:r.ran,produced:r.produced}))`);
  const afterSpeak = await ev(`window.LifeScheduler.budget(Date.now())`);
  const msgL7 = await ev(`chatHistory.filter(m=>m&&m.source==='idle').length`);
  check('L07 开口后预算 +1 且进入成功冷却', msgL7 === 1 && afterSpeak.count === 1 && afterSpeak.canUse === false && repL7.produced === 1, JSON.stringify({afterSpeak, repL7, msgL7}));

  // 跨午夜：23:58 沉默 → 次日 00:05（7 分钟）仍冷却，00:13（15 分钟）可再试
  await reset('2026-11-19T23:58:00'); reqs.length = 0; stubMode = 'silent';
  await ev(`chatHistory.push({role:'user',content:'下次教我弹钢琴吧',time:Date.now()}); 'ok'`);
  await runIdle();
  await ev(`window.__setNow('2026-11-20T00:05:00'); 'ok'`); reqs.length = 0;
  const crossMid = await runIdle();
  const crossBlocked = reqs.length === 0 && crossMid.last.reason === 'attempt-cooldown';
  await ev(`window.__setNow('2026-11-20T00:13:05'); 'ok'`); reqs.length = 0;
  const crossOk = await runIdle();
  check('L08 跨午夜冷却按本地时间毫秒差计算', crossBlocked && reqs.length === 1 && crossOk.last.reason === 'silent', JSON.stringify({ blocked: crossBlocked, after: crossOk.last }));

  // 普通主聊不受主动请求尝试冷却影响
  await reset('2026-11-19T20:00:00'); reqs.length = 0; stubMode = 'plain';
  await ev(`lastIdleAttemptAt = Date.now(); settings.showEnglish=true; 'ok'`);
  await ev(`(function(){const el=document.getElementById('chatInput');el.value='今天怎么样';el.dispatchEvent(new Event('input',{bubbles:true}));return sendMessage();})()`);
  await sleep(600);
  check('L09 普通主聊不受尝试冷却影响', mainReqs().length === 1 && trReqs().length === 1, 'main=' + mainReqs().length + ' tr=' + trReqs().length);
  await ev(`settings.showEnglish=false; 'ok'`);

  check('K01 全程无外部请求', external.length === 0, external.slice(0, 2).join(','));
  check('K02 全程无页面异常', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) {
  check('运行异常', false, String(e && e.stack || e));
} finally {
  try { ws && ws.close(); } catch {}
  browser.kill(); server.close();
}
const pass = checks.filter(Boolean).length;
console.log(`\n情境主动关心测试：${pass}/${checks.length} 通过`);
process.exit(pass === checks.length ? 0 : 1);
