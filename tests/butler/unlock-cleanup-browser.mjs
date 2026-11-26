/* tests/butler/unlock-cleanup-browser.mjs
 * 清理旧式游戏解锁：真实页面 + 真实 localStorage，AI/网络全 stub。
 * 验证 quiz / date 结算时不再调用 store.unlock，不再产生解锁事件与解锁文案；
 * 同时保留各自的 store.finish 结算与成绩，并确认珍藏入口不依赖游戏解锁。
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9361, BASE = process.argv[2] || 'http://127.0.0.1:8787';
const profile = `${process.env.TEMP || 'C:\\Windows\\Temp'}\\ul-edge-${Date.now()}`;
const browser = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });

const checks = [];
const check = (n, ok, d = '') => { checks.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };

// 源码层：旧解锁调用与文案彻底移除（不依赖运行时是否 no-op）
{
  const quiz = readFileSync(new URL('../../public/playground/quiz.js', import.meta.url), 'utf8');
  const date = readFileSync(new URL('../../public/playground/date.js', import.meta.url), 'utf8');
  check('U00 源码：quiz/date 无 store.unlock 调用',
    quiz.indexOf('store.unlock(') === -1 && date.indexOf('store.unlock(') === -1);
  check('U01 源码：quiz 无旧解锁文案与「解锁了星空棋局」AI 话术',
    quiz.indexOf('已解锁') === -1 && quiz.indexOf('解锁了星空棋局') === -1 && quiz.indexOf('星空棋局') === -1);
  check('U02 源码：保留 store.finish(quiz/date) 结算写入',
    quiz.indexOf("store.finish('quiz'") !== -1 && date.indexOf("store.finish('date'") !== -1);
}

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
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    window.fetch = () => Promise.resolve(new Response('{"choices":[{"message":{"content":""}}]}',{headers:{'content-type':'application/json'}}));
  })();` });

  await call('Page.navigate', { url: BASE + '/playground/' });
  for (let i = 0; i < 40; i++) {
    const ready = await ev(`document.readyState === 'complete' && !!document.body`).catch(() => false);
    if (ready) break;
    await sleep(200);
  }
  await sleep(600);
  await ev(`(function(){ localStorage.removeItem('ylxh.playground.v1'); return 1; })()`);
  await call('Page.reload'); await sleep(1200);

  // 装配：spy store.unlock 调用 + 监听 store:unlock 事件
  const setup = await ev(`(async function(){
    const { store } = await import('/playground/store.js');
    window.__st = store;
    window.__unlockCalls = []; window.__unlockEvents = [];
    const orig = store.unlock;
    store.unlock = function(id){ window.__unlockCalls.push(id); return orig.call(this, id); };
    window.addEventListener('store:unlock', e => window.__unlockEvents.push(e.detail && e.detail.id));
    return { defaultAdventureUnlocked: window.__st.isUnlocked('adventure'),
             collectionUnlocked: window.__st.isUnlocked('collection') };
  })()`);
  check('U03 前置：adventure 默认已解锁（故须 spy 方法调用，不能只看事件）',
    setup.defaultAdventureUnlocked === true && setup.collectionUnlocked === false, JSON.stringify(setup));

  // 默契问答：高分结算，不应调用 unlock('adventure')，保留成绩与结算，AI 话术无解锁语义
  const quiz = await ev(`(async function(){
    const { QuizScene } = await import('/playground/quiz.js');
    const host = document.createElement('div'); host.id='__ul_quiz'; document.body.appendChild(host);
    const q = QuizScene;
    q.container = host; q.active = true; q.contentEl = null; q.score = 3; q.current = 4;
    const spoken = []; q.triggerAISpeak = (t) => spoken.push(String(t));
    window.__unlockCalls.length = 0; window.__unlockEvents.length = 0;
    q.renderResult();
    const txt = host.innerText;
    const st = JSON.parse(localStorage.getItem('ylxh.playground.v1')||'{}');
    return { unlockCalls: window.__unlockCalls.slice(), unlockEvents: window.__unlockEvents.slice(),
             txt, spoken, best: st.finished && st.finished.quiz && st.finished.quiz.best,
             collectionUnlocked: window.__st.isUnlocked('collection') };
  })()`);
  check('U04 默契问答结算不再调用 store.unlock（含 adventure）', quiz.unlockCalls.length === 0, JSON.stringify(quiz.unlockCalls));
  check('U05 默契问答结算不产生 store:unlock 事件', quiz.unlockEvents.length === 0, JSON.stringify(quiz.unlockEvents));
  check('U06 默契问答结算页无旧解锁提示/星空棋局文案',
    quiz.txt.indexOf('已解锁') === -1 && quiz.txt.indexOf('星空棋局') === -1 && quiz.txt.indexOf('解锁') === -1,
    quiz.txt.replace(/\s+/g, ' ').slice(0, 140));
  check('U07 默契问答 AI 话术无解锁语义、保留成绩表述',
    quiz.spoken.length > 0 && quiz.spoken.every(s => s.indexOf('解锁') === -1 && s.indexOf('星空棋局') === -1) &&
    quiz.spoken.some(s => s.indexOf('3') !== -1), JSON.stringify(quiz.spoken));
  check('U08 默契问答保留成绩结算（finished.quiz.best=3）', quiz.best === 3, String(quiz.best));

  // 星夜21点：完成后 memorialize，不应调用 unlock('collection')，保留 store.finish('date')
  const date = await ev(`(async function(){
    const { DateScene } = await import('/playground/date.js');
    const d = DateScene; d.memorialized = false;
    window.__unlockCalls.length = 0; window.__unlockEvents.length = 0;
    d.memorialize();
    const st = JSON.parse(localStorage.getItem('ylxh.playground.v1')||'{}');
    return { unlockCalls: window.__unlockCalls.slice(), unlockEvents: window.__unlockEvents.slice(),
             finished: st.finished && st.finished.date,
             collectionUnlocked: window.__st.isUnlocked('collection') };
  })()`);
  check('U09 星夜21点完成不再调用 store.unlock（含 collection）', date.unlockCalls.length === 0, JSON.stringify(date.unlockCalls));
  check('U10 星夜21点完成不产生 store:unlock 事件', date.unlockEvents.length === 0, JSON.stringify(date.unlockEvents));
  check('U11 星夜21点完成不再解锁 collection', date.collectionUnlocked === false);
  check('U12 星夜21点保留结算写入（completed/place/activity）',
    date.finished && date.finished.completed === true && date.finished.place === 'casino' && date.finished.activity === 'blackjack',
    JSON.stringify(date.finished));

  // 珍藏入口独立：全新存档（无 collection 解锁、无 date 完成）仍可进入珍藏页
  await ev(`(function(){ localStorage.removeItem('ylxh.playground.v1'); location.hash='#/collection'; return 1; })()`);
  await sleep(900);
  const collect = await ev(`(function(){
    const card = document.querySelector('.scene-card[data-scene="collection"]');
    const game = document.getElementById('game-scene');
    return { cardLocked: !!(card && card.classList.contains('locked')),
             hasCard: !!card,
             sceneVisible: game && getComputedStyle(game).display !== 'none',
             sceneTxt: game ? game.innerText.replace(/\s+/g,' ').slice(0,120) : '',
             st: JSON.parse(localStorage.getItem('ylxh.playground.v1')||'{}') };
  })()`);
  check('U13 珍藏入口无 locked 标记', collect.hasCard && collect.cardLocked === false, JSON.stringify({ hasCard: collect.hasCard, locked: collect.cardLocked }));
  check('U14 无星夜21点完成/无 collection 解锁时仍可进入珍藏页',
    collect.sceneVisible === true && collect.sceneTxt.indexOf('共同珍藏') !== -1 &&
    !(collect.st.finished && collect.st.finished.date) && !(collect.st.unlocked || []).includes('collection'),
    JSON.stringify({ visible: collect.sceneVisible, txt: collect.sceneTxt }));

  check('U15 零外部请求', external.length === 0, external.slice(0, 2).join(','));
  check('U16 零页面异常', errors.length === 0, errors.slice(0, 1).join('').slice(0, 140));
} catch (e) {
  console.error('测试脚本异常：', e);
  check('脚本执行', false, String(e).slice(0, 180));
} finally {
  const passed = checks.filter(Boolean).length;
  console.log(`\n结果 ${passed}/${checks.length}`);
  try { ws && ws.close(); } catch {}
  browser.kill();
  process.exit(passed === checks.length ? 0 : 1);
}
