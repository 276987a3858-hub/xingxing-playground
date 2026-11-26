/* tests/butler/game-activity-browser.mjs
 * 游戏活动记忆：真实页面 + 真实 localStorage，AI/网络全 stub。规则逻辑用时间偏移模拟，不等待真实 45 秒。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9343, BASE = process.argv[2] || 'http://127.0.0.1:8787';
const profile = `${process.env.TEMP || 'C:\\Windows\\Temp'}\\ga-edge-${Date.now()}`;
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
      if (!u.startsWith('http://127.0.0.1') && u.indexOf('cdnjs.cloudflare.com') === -1) external.push(u);
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
    window.__net = [];
    window.fetch = (u) => { window.__net.push(String(u)); return Promise.resolve(new Response('{"choices":[{"message":{"content":""}}]}',{headers:{'content-type':'application/json'}})); };
  })();` });

  const go = async (path) => { await call('Page.navigate', { url: BASE + path }); await sleep(1800); };
  const clear = () => ev(`(function(){ ['ylxh.game.activity.v1','ylxh.game.live.v1','ylxh.game.activity.seen.v1','ylxh.life.log.v1','ylxh.playground.v1'].forEach(k=>localStorage.removeItem(k)); return 1; })()`);
  const list = () => ev(`window.GameActivity.list()`);
  const seed = (items, extra = {}) => ev(`(function(){
    localStorage.setItem('ylxh.game.activity.v1', JSON.stringify({v:1,items:${JSON.stringify(items)}}));
    ${extra.live ? `localStorage.setItem('ylxh.game.live.v1', JSON.stringify(${JSON.stringify(extra.live)}));` : ''}
    return 1; })()`);
  const mk = (id, game, name, minutesAgo, durMin, result = '') => ({ id, game, name,
    startAt: Date.now() - minutesAgo * 60000 - durMin * 60000, endAt: Date.now() - minutesAgo * 60000,
    durMs: durMin * 60000, result, createdAt: Date.now() - minutesAgo * 60000 });

  await go('/playground/');
  check('G01 模块加载并暴露只读接口', await ev(`!!(window.GameActivity && window.GameActivity.recent && window.GameActivity.search && !window.GameActivity.delete)`));
  await clear(); await call('Page.reload'); await sleep(1800);
  check('G02 仅打开游乐场不产生活动', (await list()).length === 0);

  // 进入场景 + 真实交互 + 时间偏移 10s → 离开：不足 45s 不记录
  const quick = await ev(`(function(){
    window.dispatchEvent(new CustomEvent('scene:change',{detail:{scene:'adventure'}}));
    window.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
    window.GameActivityCollector._bump(10000);
    window.dispatchEvent(new CustomEvent('scene:change',{detail:{scene:'lobby'}}));
    return window.GameActivity.list().length;
  })()`);
  check('G03 进入不足 45 秒离开不产生活动', quick === 0, String(quick));

  // 正常结算：厨房（未写 store.finished 的游戏）60s
  const normal = await ev(`(async function(){
    window.dispatchEvent(new CustomEvent('scene:change',{detail:{scene:'kitchen'}}));
    window.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
    window.GameActivityCollector._bump(60000);
    let ok = false, wrapped = false, stAfter = null;
    try {
      const m = await import('/playground/game-end.js');
      wrapped = String(m.gameEnd.show).indexOf('game:act') !== -1;
      ok = m.gameEnd.show({game:'kitchen',gameName:'厨房大危机',token:'ga-k1',line:'这盘做得不错。',result:'A级'});
      stAfter = window.GameActivityCollector._state();
    } catch (e) { stAfter = { error: String(e) }; }
    window.dispatchEvent(new CustomEvent('scene:change',{detail:{scene:'lobby'}}));
    return { ok, wrapped, stAfter, rows: window.GameActivity.list(), st: window.GameActivityCollector._state() };
  })()`);
  check('G04 正常结算产生一条真实记录', normal.ok === true && normal.rows.length === 1
    && normal.rows[0].game === 'kitchen' && normal.rows[0].name === '厨房大危机' && normal.rows[0].result === 'A级'
    && normal.rows[0].durMs >= 45000, JSON.stringify(normal).slice(0, 240));

  const dup = await ev(`(async function(){
    const m = await import('/playground/game-end.js');
    const ok = m.gameEnd.show({game:'kitchen',gameName:'厨房大危机',token:'ga-k1',line:'这盘做得不错。',result:'A级'});
    return { ok, n: window.GameActivity.list().length };
  })()`);
  check('G05 相同 token 重复结算不重复写入', dup.ok === false && dup.n === 1, JSON.stringify(dup));

  // 有效游玩后直接离开（未结算）→ 恢复
  const left = await ev(`(function(){
    window.dispatchEvent(new CustomEvent('scene:change',{detail:{scene:'adventure'}}));
    window.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
    window.GameActivityCollector._bump(70000);
    window.dispatchEvent(new CustomEvent('scene:change',{detail:{scene:'lobby'}}));
    return window.GameActivity.list();
  })()`);
  check('G06 有效游玩后直接离开可恢复记录', left.length === 2 && left.some(x => x.game === 'gomoku' && x.result === ''), String(left.length));

  // 浏览器关闭期间不累计：心跳停在 10 分钟前，activeMs 仅 60s
  await seed([], { live: { v: 1, game: 'date', name: '星夜21点', startAt: Date.now() - 660000,
    activeMs: 60000, seenAt: Date.now() - 600000 } });
  await call('Page.reload'); await sleep(1800);
  const recovered = (await list())[0] || {};
  check('G07 关闭期间不累计时长', recovered.game === 'date' && recovered.durMs === 60000
    && Math.abs(recovered.endAt - (Date.now() - 600000)) < 60000, JSON.stringify(recovered).slice(0, 110));

  // 同一局恢复重复：用相同 id/startAt 再记一次
  const again = await ev(`(function(){
    const r = window.LifeEvents.activities.record({id:${JSON.stringify(recovered.id)},game:'date',name:'星夜21点',result:'',
      startAt:${recovered.startAt},endAt:${recovered.endAt},durMs:60000});
    return { r, n: window.GameActivity.list().length };
  })()`);
  check('G08 正常结算与异常恢复不重复记录', again.n === 1 && again.r.added === false, JSON.stringify(again));

  // 真实接入结算层的所有游戏：用 scene 映射 + token 各写一条
  const games = await ev(`(async function(){
    const m = await import('/playground/game-end.js');
    const cases = [['adventure','gomoku','星空棋局'],['date','blackjack','星夜21点'],['puzzle','puzzle','星光拼图'],['planets','vocab','一起背单词']];
    const real = Date.now;
    for (const [scene, game, name] of cases) {
      window.dispatchEvent(new CustomEvent('scene:change',{detail:{scene}}));
      window.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
      window.GameActivityCollector._bump(50000);
      m.gameEnd.show({game,gameName:name,token:'ga-'+game,line:'结束啦。',result:'完成'});
      window.dispatchEvent(new CustomEvent('scene:change',{detail:{scene:'lobby'}}));
    }
    return window.GameActivity.list().filter(x=>x.result==='完成').map(x=>({g:x.game,n:x.name}));
  })()`);
  check('G09 接入结算的游戏均被识别且使用新名称', ['gomoku','blackjack','puzzle','vocab'].every(g => games.some(x => x.g === g))
    && games.some(x => x.g === 'gomoku' && x.n === '星空棋局') && games.some(x => x.g === 'blackjack' && x.n === '星夜21点'), JSON.stringify(games));

  // 24h 近期 / 历史 7 天 / 180 天
  await clear();
  await seed([mk('a', 'kitchen', '厨房大危机', 120, 25), mk('b', 'gomoku', '星空棋局', 60 * 20, 20),
    mk('cc', 'puzzle', '星光拼图', 60 * 24 * 3, 12), mk('c', 'date', '月下约会', 60 * 24 * 10, 30),
    mk('d', 'quiz', '星星问答', 60 * 24 * 100, 15)]);
  await call('Page.reload'); await sleep(1800);
  const recent = await ev(`window.GameActivity.recent(Date.now(),{hours:24,limit:3}).map(x=>x.id)`);
  check('G10 24 小时内活动可读', recent.length === 2 && recent.includes('a') && recent.includes('b'), JSON.stringify(recent));
  const h7 = await ev(`window.GameActivity.search({days:7}).map(x=>x.id)`);
  const h180 = await ev(`window.GameActivity.search({days:180}).map(x=>x.id)`);
  check('G11 超过 24h 不进近期但仍在 7 天历史', !recent.includes('cc') && h7.includes('cc'), JSON.stringify(h7));
  check('G12 7 天以上仅在放宽范围时检索', !h7.includes('d') && h180.includes('d'), JSON.stringify(h180));

  // 注入去重：markSeen 后不再注入，新活动不受影响
  await ev(`window.GameActivity.markSeen(['a'])`);
  const seen = await ev(`window.GameActivity.recent(Date.now(),{hours:24,limit:5}).map(x=>x.id)`);
  check('G13 已处理活动不重复注入，新活动不受屏蔽', !seen.includes('a') && seen.includes('b'), JSON.stringify(seen));

  // 淘汰：180 天
  await clear(); await seed([mk('old', 'quiz', '星星问答', 60 * 24 * 200, 5)]);
  await call('Page.reload'); await sleep(1500);
  const pruned = await ev(`(function(){ window.LifeEvents.activities.record({id:'fresh',game:'quiz',name:'星星问答',result:'',startAt:Date.now()-60000,endAt:Date.now(),durMs:60000}); return window.GameActivity.list().map(x=>x.id); })()`);
  check('G14 超过 180 天按时间淘汰', pruned.length === 1 && pruned[0] === 'fresh', JSON.stringify(pruned));

  // 淘汰：500 条
  await clear();
  await ev(`(function(){
    const arr = [];
    for (let i=0;i<510;i++) arr.push({id:'x'+i,game:'quiz',name:'星星问答',result:'',startAt:Date.now()-(510-i)*600000,endAt:Date.now()-(510-i)*600000+60000,durMs:60000,createdAt:i});
    localStorage.setItem('ylxh.game.activity.v1', JSON.stringify({v:1,items:arr})); return 1;
  })()`);
  await call('Page.reload'); await sleep(1500);
  const capped = await ev(`(function(){
    window.LifeEvents.activities.record({id:'newest',game:'quiz',name:'星星问答',result:'',startAt:Date.now()-60000,endAt:Date.now(),durMs:60000});
    const l = window.GameActivity.list(); return {n:l.length, hasOld:l.some(x=>x.id==='x0'), hasNew:l.some(x=>x.id==='newest')};
  })()`);
  check('G15 超过 500 条淘汰最旧', capped.n === 500 && !capped.hasOld && capped.hasNew, JSON.stringify(capped));

  // 存储不可用时不影响游戏与聊天
  const degraded = await ev(`(function(){
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function(){ throw new Error('quota'); };
    let ok = true;
    try { window.LifeEvents.activities.record({id:'fail',game:'puzzle',name:'星光拼图',result:'',startAt:Date.now()-60000,endAt:Date.now(),durMs:60000}); } catch(e){ ok=false; }
    Storage.prototype.setItem = real; return ok;
  })()`);
  check('G16 存储失败静默降级', degraded === true);

  // life-events 同步：活动映射 + 与 finished 排重
  const sync = await ev(`(async function(){
    await import('/shared/life-events.js');
    const LE = window.LifeEvents; LE._reset();
    const now = Date.now();
    localStorage.removeItem('ylxh.life.log.v1');
    localStorage.setItem('ylxh.playground.v1', JSON.stringify({finished:{puzzle:{at:now-1000}}}));
    localStorage.setItem('ylxh.game.activity.v1', JSON.stringify({v:1,items:[
      {id:'g1',game:'puzzle',name:'星光拼图',result:'',startAt:now-61000,endAt:now-1000,durMs:60000,createdAt:now-1000},
      {id:'g2',game:'kitchen',name:'厨房大危机',result:'A级',startAt:now-121000,endAt:now-61000,durMs:60000,createdAt:now-61000}
    ]}));
    const r = window.LifeEvents.syncArchives(now);
    const evs = window.LifeEvents.list().filter(x=>x.type==='game.finish');
    return { r, evs: evs.map(x=>x.id) };
  })()`);
  check('G17 活动映射为生活事件且与 finished 排重', sync.evs.length === 2 && sync.evs.some(x => x.indexOf('game:activity:g2') === 0)
    && sync.evs.filter(x => x.indexOf('puzzle') !== -1).length === 1, JSON.stringify(sync.evs));

  // 聊天注入：真实房间页 + stub AI，检查 system 内容；第二次不重复
  await go('/');
  await ev(`(async function(){
    const db = await new Promise((res, rej) => { const r = indexedDB.open('star_fifi_room'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    await new Promise((res, rej) => { const tx = db.transaction('kv','readwrite'); tx.objectStore('kv').put('mock-key','apiKey'); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    db.close(); return 1;
  })()`);
  await call('Page.reload'); await sleep(1800);
  await ev(`(function(){
    localStorage.setItem('ylxh.game.activity.v1', JSON.stringify({v:1,items:[
      {id:'chat1',game:'kitchen',name:'厨房大危机',result:'A级',startAt:Date.now()-3600000,endAt:Date.now()-1800000,durMs:1500000,createdAt:Date.now()-1800000}
    ]}));
    localStorage.removeItem('ylxh.game.activity.seen.v1');
    window.__systems = [];
    window.callAI = async function(m){ window.__systems.push(m[0].content); return '嗯，我记得。 ||| I remember.'; };
    window.fetchEnglishTranslation = async function(){ return ''; };
    window.requestAndPlaySpeech = function(){};
    return 1;
  })()`);
  const send = async (t) => { await ev(`(function(){ document.getElementById('chatInput').value=${JSON.stringify(t)}; return window.sendMessage(); })()`); await sleep(900); };
  await send('今天过得怎么样');
  let sys = await ev(`window.__systems[window.__systems.length-1]`);
  check('G18 聊天按需注入近期活动事实', String(sys).includes('厨房大危机') && String(sys).includes('约 25 分钟'), String(sys).slice(-160));
  await send('嗯');
  sys = await ev(`window.__systems[window.__systems.length-1]`);
  check('G19 同一活动不会逐轮重复注入', !String(sys).includes('厨房大危机'));
  await send('之前我们玩过什么游戏吗');
  sys = await ev(`window.__systems[window.__systems.length-1]`);
  check('G20 明确提起过去时做历史检索', String(sys).includes('按需查到的旧活动'));
  check('G21 零外部请求', external.length === 0, external.slice(0, 2).join(','));
  check('G22 零页面异常', errors.length === 0, errors.slice(0, 1).join('').slice(0, 120));
} catch (e) {
  console.error('测试脚本异常：', e);
  check('脚本执行', false, String(e).slice(0, 160));
} finally {
  const passed = checks.filter(Boolean).length;
  console.log(`\n结果 ${passed}/${checks.length}`);
  try { ws && ws.close(); } catch {}
  browser.kill();
  process.exit(passed === checks.length ? 0 : 1);
}
