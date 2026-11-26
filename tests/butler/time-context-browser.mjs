/* tests/butler/time-context-browser.mjs
 * 时间上下文回归（轻量）：只验证「每次请求都能拿到正确的本地当前时间」，
 * 以及提示词里不再出现具体钟点锚点与防错规则。
 * 不验证模型能否理解自然语言时间——那是模型能力，不靠规则堆。
 * 只做提示词组装校验，不调用真实 AI。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9388, BASE = process.argv[2] || 'http://127.0.0.1:8787';
const profile = `${process.env.TEMP || 'C:\\Windows\\Temp'}\\tctx-edge-${Date.now()}`;
const browser = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });

const checks = [];
const check = (n, ok, d = '') => { checks.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };

let ws;
try {
  let info = null;
  for (let i = 0; i < 40 && !info; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) info = await r.json(); } catch { }
    if (!info) await sleep(250);
  }
  if (!info) throw new Error('DevTools 未就绪');
  ws = await new Promise((res, rej) => { const s = new WebSocket(info.webSocketDebuggerUrl); s.onopen = () => res(s); s.onerror = () => rej(new Error('WS')); });
  const pending = new Map(); let id = 0, sid = null;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
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
  await call('Page.enable'); await call('Runtime.enable');

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
    const ready = await ev(`document.readyState === 'complete' && typeof getNowBlock === 'function' && !!window.LifeClock`).catch(() => false);
    if (ready) break;
    await sleep(200);
  }
  await sleep(400);

  // 按真实拼接顺序组装：当前时间已在 getSystemPrompt 的【当前现实环境】里，
  // 各请求路径不再在末尾重复拼一次（便签段只带任务本身，不带任何时间解释）
  const build = (iso, noteText) => ev(`(function(){
    window.__setNow(${JSON.stringify(iso)});
    var note = ${JSON.stringify(noteText || '')};
    var base = getSystemPrompt();
    var sys = base + (note ? '\\n【今日便签任务关系】便签里的小事全部是你安排的。\\n' + note : '');
    return { now: window.__nowText(), block: getNowBlock(), base: base, sys: sys, time: getTimeContext() };
  })()`);

  const NOTE = '【今日便签】今天你给用户安排了 1 件：喝水 0/3（进行中）。';

  const s1559 = await build('2026-11-19T15:59:00', NOTE);
  check('A1 15:59 当前时间精确注入', s1559.block.includes('【当前时间】2026-11-19 15:59 周四（本地时间）'), s1559.now);
  // 当前时间块 = 一句事实 + 一句极短优先级说明；不恢复旧版长规则
  check('A2 当前时间块只有一句事实 + 一句优先级说明', s1559.block.trim().split('\n').length === 1
    && /只按这一行说/.test(s1559.block) && /便签、提醒和以前聊过的时间都不算此刻/.test(s1559.block)
    && s1559.block.length <= 110 && !/唯一|不得继承|如实回答/.test(s1559.block), s1559.block);
  check('A3 当前时间块位于现实环境内、且在时间提示之前',
    s1559.base.indexOf('【当前现实环境】') < s1559.base.indexOf('【当前时间】')
    && s1559.base.indexOf('【当前时间】') < s1559.base.indexOf('时间提示：'), '');
  check('A4 整段 system 里当前时间只出现一次（不重复注入）',
    (s1559.sys.match(/【当前时间】/g) || []).length === 1, String((s1559.sys.match(/【当前时间】/g) || []).length));

  const s2158 = await build('2026-11-19T21:58:00', NOTE);
  check('B1 21:58 当前时间精确', s2158.block.includes('2026-11-19 21:58'), s2158.now);
  check('B2 21:58 时段为晚上', s2158.time.includes('晚上'), s2158.time);
  // 22:xx 用「还没到深夜」，不再用「快到深夜」这类会被往上进位的措辞
  const s2249 = await build('2026-11-19T22:49:00', NOTE);
  check('B3 22:49 明确尚未到深夜、不使用进位措辞',
    s2249.time.includes('还没到深夜') && !/快到深夜|接近深夜/.test(s2249.time + s2249.base)
    && /还没到深夜/.test(s2249.base) && !/快到深夜|接近深夜/.test(s2249.base), s2249.time);

  const s2305 = await build('2026-11-19T23:05:00', '');
  check('C1 23:05 当前时间精确且进入深夜', s2305.block.includes('23:05') && s2305.time.includes('深夜'), s2305.time);

  const cross = await build('2026-11-20T00:10:00', '');
  check('D1 跨日后日期与时段正确', cross.block.includes('2026-11-20 00:10') && /凌晨/.test(cross.time), cross.now);

  // 提示词卫生：常驻提示词里不再有具体钟点锚点与旧版长防错规则；
  // 只允许 getNowBlock 那一句极短优先级说明存在
  const hygiene = await ev(`(function(){
    var base = getSystemPrompt();
    return {
      noAnchor: !/十一点|23:00|22:58/.test(base),
      noLongRule: !/唯一|不得继承|如实回答|时间含义区分|历史时间边界|不是当前时间|任务时间/.test(base),
      onePriority: (base.match(/【当前时间】/g) || []).length === 1 && /只按这一行说/.test(base),
      noOldBan: !/除非另有精确时间提示/.test(base) && !/不要说出或推算具体几点/.test(base)
    };
  })()`);
  check('E1 常驻提示词无具体钟点锚点', hygiene.noAnchor === true);
  check('E2 常驻提示词不恢复旧版长防错规则', hygiene.noLongRule === true);
  check('E3 旧的「禁止报钟点」口子也已移除', hygiene.noOldBan === true);
  check('E4 优先级说明只保留一句、不重复', hygiene.onePriority === true);

  // 便签注入仍在，且不再附带时间解释
  const noteOnly = await build('2026-11-19T22:14:00', NOTE);
  check('F1 便签仍正常注入', noteOnly.sys.includes('【今日便签任务关系】') && noteOnly.sys.includes('喝水 0/3'));
  check('F2 便签段不重复钟点锚点', !/不是当前时间|23:00|十一点|任务时间/.test(noteOnly.sys));
  // 真实便签段（doRequestStarReply 内的说明句）要交代「时间是安排/期限，不是现在几点」
  const noteGuard = await ev(`(function(){
    var src = String(doRequestStarReply);
    return { has: src.indexOf('便签里出现的时间是她做这件事的安排或期望时刻，不是现在几点') > -1 };
  })()`);
  check('F3 便签说明句交代了时间不是当前时刻', noteGuard.has === true, '');

  // 每次现取：同一页面里换时间，块随之变化
  const fresh = await ev(`(function(){
    window.__setNow('2026-11-19T22:13:00'); var a = getNowBlock();
    window.__setNow('2026-11-19T22:14:00'); var b = getNowBlock();
    return { a: a, b: b, differs: a !== b && a.includes('22:13') && b.includes('22:14') };
  })()`);
  check('G1 同一页面每次调用都现取', fresh.differs === true, fresh.a.slice(0, 40) + ' / ' + fresh.b.slice(0, 40));

  // 注入点收敛到 getSystemPrompt 一处：所有路径共用，末尾不再各自重复拼一次
  const paths = await ev(`(function(){
    var sys = String(getSystemPrompt);
    var a = String(callStar);
    var b = String(doRequestStarReply);
    return {
      inBase: sys.indexOf('getNowBlock()') > -1,
      starUsesBase: a.indexOf('getSystemPrompt()') > -1 && a.indexOf('getNowBlock()') === -1,
      chatUsesBase: b.indexOf('getSystemPrompt()') > -1 && b.indexOf('getNowBlock()') === -1
    };
  })()`);
  check('H1 当前时间只由 getSystemPrompt 注入，callStar / 主聊路径不再末尾重复拼',
    paths.inBase && paths.starUsesBase && paths.chatUsesBase, JSON.stringify(paths));

  // 其余请求路径（来信 / 未来信 / 实体触摸）同样只靠 getSystemPrompt，不各自重复拼
  const others = await ev(`(function(){
    var names = ['respondToTodayLetter','touchAskAI','callStar'];
    var out = {};
    names.forEach(function(k){
      var s = String(window[k]);
      out[k] = { usesBase: s.indexOf('getSystemPrompt()') > -1, reAdds: s.indexOf('getNowBlock()') > -1 };
    });
    return out;
  })()`).catch(() => null);
  check('H2 来信 / 触摸路径也都只走 getSystemPrompt，不在末尾重复拼时间',
    !!others && Object.keys(others).every((k) => others[k].usesBase && !others[k].reAdds),
    others ? JSON.stringify(others) : '取函数源码失败');
} catch (e) {
  check('运行异常', false, String((e && e.stack) || e));
} finally {
  try { ws && ws.close(); } catch { }
  browser.kill();
}
const pass = checks.filter(Boolean).length;
console.log(`\n时间上下文测试：${pass}/${checks.length} 通过`);
process.exit(pass === checks.length ? 0 : 1);
