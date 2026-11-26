/* tests/shared/note-card-browser.mjs — 新版「星星的今日便签」真实首页集成冒烟
 * 隔离 profile（随机临时目录），只访问本地 8787；所有数据写在临时 profile 内，不碰真实存档。
 * 不调用真实 AI：AI 入口用 window.callAI 的桩验证，并统计真实 /api 请求必须为 0。
 * 覆盖：真实首页挂载 / 真实 IndexedDB（diaries）/ 幂等建条 / 单向任务（星星安排、用户执行）全部状态 /
 *       跨天归档 / 往日折叠 / AI 每天一次 / 聊天上下文明确任务内容 / 邮局与日记摘要隔离 /
 *       天气·留言·签名保留 / 零请求
 * 用法：node tests/shared/note-card-browser.mjs   （需本地 8787 已启动）
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 9382;
const BASE = 'http://127.0.0.1:8787';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = mkdtempSync(join(tmpdir(), 'nt-card-'));

const proc = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });

let ws, mid = 0;
const pending = new Map();
const errors = [];
const apiCalls = [];
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++mid;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});

for (let i = 0; i < 40; i++) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch {}
  await sleep(250);
}
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') errors.push('EX ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('CE ' + m.params.args.map((a) => a.value || a.description).join(' '));
  if (m.method === 'Network.requestWillBeSent' && String(m.params.request.url).includes('/api')) apiCalls.push(m.params.request.url);
  if (m.id && pending.has(m.id)) { const t = pending.get(m.id); pending.delete(m.id); m.error ? t.rej(new Error(m.error.message)) : t.res(m.result); }
};
await send('Runtime.enable');
await send('Network.enable');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return r.result.value;
};
const waitFor = async (expr, times = 50, gap = 200) => {
  for (let i = 0; i < times; i++) { if (await ev(expr)) return true; await sleep(gap); }
  return false;
};

const idbAll = (store) => ev(`(async()=>{
  const db=await new Promise((res,rej)=>{const r=indexedDB.open('star_fifi_room');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});
  const rows=await new Promise(res=>{try{const q=db.transaction('${store}').objectStore('${store}').getAll();q.onsuccess=()=>res(q.result||[]);q.onerror=()=>res([])}catch(e){res([])}});
  db.close();return rows})()`);

const snap = () => ev(`(()=>[...document.querySelectorAll('#noteTasks .nt-task')].map(r=>({
  text:(r.querySelector('.nt-text')||{}).textContent||'',
  status:r.getAttribute('data-status'),
  prog:(r.querySelector('.nt-prog')||{}).textContent||'',
  reply:(r.querySelector('.nt-reply')||{}).textContent||'',
  acts:[...r.querySelectorAll('[data-act]')].map(b=>b.textContent.trim())
})))()`);

const clickTask = (text, act) => ev(`(()=>{
  const rows=[...document.querySelectorAll('#noteTasks .nt-task')];
  const row=rows.find(r=>((r.querySelector('.nt-text')||{}).textContent||'').includes(${JSON.stringify(text)}));
  if(!row) return 'no-row';
  const b=row.querySelector('[data-act="${act}"]');
  if(!b) return 'no-btn';
  b.click(); return 'ok';
})()`);

// 单向模式下没有用户建单入口：额外任务只能通过隔离库注入，模拟星星当天又安排了一件
const injectStarTask = (text, target) => ev(`(async()=>{
  const db=await new Promise(res=>{const r=indexedDB.open('star_fifi_room');r.onsuccess=()=>res(r.result)});
  const rows=await new Promise(res=>{const q=db.transaction('diaries').objectStore('diaries').getAll();q.onsuccess=()=>res(q.result||[])});
  const d=new Date(),p=n=>n<10?'0'+n:''+n,today=d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate());
  const note=rows.find(r=>r&&r.type==='note-day'&&r.date===today);
  if(!note){db.close();return 'no-note'}
  const now=Date.now();
  note.tasks.push({id:'nt_'+now+'_'+Math.random().toString(36).slice(2,6),from:'star',text:${JSON.stringify(text)},
    unit:'次',target:${target},progress:0,status:'pending_accept',day:today,createdAt:now,updatedAt:now,reply:''});
  await new Promise(res=>{const tx=db.transaction('diaries','readwrite');tx.objectStore('diaries').put(note);tx.oncomplete=()=>res()});
  db.close();return 'ok'})()`);
const reload = async () => { await send('Page.navigate', { url: BASE + '/' }); await sleep(2200); await waitFor(`(()=>{const e=document.getElementById('noteTasks');return !!e&&e.getAttribute('data-mounted')==='1'&&document.querySelectorAll('#noteTasks .nt-task').length>0})()`); };

const noteRows = async () => (await idbAll('diaries')).filter((r) => r && r.type === 'note-day');
const todayRows = async () => {
  const today = (await ev(`(()=>{const d=new Date();const p=n=>n<10?'0'+n:''+n;return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())})()`));
  return (await noteRows()).filter((r) => r.date === today);
};

/* ---------- 1. 首次进入：真实挂载 + 原有内容保留 ---------- */
await send('Page.navigate', { url: BASE + '/' });
await sleep(2400);
ok('note-card 模块已加载', await ev('!!window.NoteCard'));
ok('首页 #noteTasks 已真实挂载', (await waitFor(`(()=>{const e=document.getElementById('noteTasks');return !!e&&e.getAttribute('data-mounted')==='1'})()`)) === true);
ok('任务区已渲染出任务行', (await waitFor(`document.querySelectorAll('#noteTasks .nt-task').length>0`)) === true);

// 天气是异步 fetch：等它落地再看（便签模块只插入节点，不参与天气渲染）
const weatherReady = await waitFor(`(()=>{const t=(document.getElementById('weatherText')||{}).textContent||'';return t.trim().length>0&&!t.includes('获取天气中')})()`, 40, 250);
ok('天气文案已渲染完成（未被便签清空）', weatherReady === true);

const shell = await ev(`(()=>{
  const card=document.querySelector('.note-card');
  const sig=[...card.children].filter(n=>{const t=(n.textContent||'').trim();return t.includes('星星留')&&!t.includes('给星星留')}).length;
  return {title:(document.getElementById('dailyTitle')||{}).textContent||'',
    text:(document.getElementById('dailyText')||{}).textContent||'',
    weather:(document.getElementById('weatherText')||{}).textContent||'',
    sig, head:(document.querySelector('#noteTasks .nt-title')||{}).textContent||'',
    addBtn:!!document.querySelector('#noteTasks [data-act="add-open"]'),
    inCard:card.contains(document.getElementById('noteTasks'))}})()`);
ok('便签仍嵌在 .note-card 内，未新建面板', shell && shell.inCard === true, shell);
ok('每日留言标题保留', shell && shell.title === '用户，欢迎回来。', shell && shell.title);
ok('每日留言正文保留', shell && shell.text === '愿今天也有一点温柔的光，落在你的肩上。', shell && shell.text);
ok('天气文案未被清空/覆盖', shell && shell.weather.trim().length > 0 && !shell.weather.includes('获取天气中'), shell && shell.weather);
ok('原有签名「—— 星星留」保留', shell && shell.sig === 1, shell);
ok('任务区标题为「今天的小事」', shell && shell.head === '今天的小事', shell);
ok('已移除「给星星留一件事」入口', shell && shell.addBtn === false, shell);
ok('无任务表单/输入框残留', (await ev(`!document.querySelector('#noteTasks .nt-form')&&!document.querySelector('#noteTasks .nt-input')`)) === true);

const first = await snap();
ok('星星侧任务自动补一条，起始为待接受', first && first.length === 1 && first[0].status === 'pending_accept', first);
ok('待接受时给出 接受/拒绝/延期', first && first[0].acts.join('|') === '接受|拒绝|延期', first && first[0].acts);

const rows1 = await todayRows();
ok('真实 diaries 里只建了 1 条今日便签', rows1.length === 1, rows1.length);
ok('便签记录 type=note-day 且带日期', rows1[0] && rows1[0].type === 'note-day' && !!rows1[0].date);

const baseCounts = await ev(`(async()=>{
  const g=(s)=>new Promise(res=>{indexedDB.open('star_fifi_room').onsuccess=e=>{const db=e.target.result;
    try{const q=db.transaction(s).objectStore(s).getAll();q.onsuccess=()=>{db.close();res((q.result||[]).length)};q.onerror=()=>{db.close();res(-1)}}catch(err){db.close();res(-1)}}});
  return {messages:await g('messages'), keeps:await g('keeps'), diaries:await g('diaries')}})()`);

/* ---------- 2. 接受 → 进度 → 完成 ---------- */
ok('点击接受生效', (await clickTask('', 'accept')) === 'ok');
await sleep(300);
let s2 = await snap();
ok('接受后进入进行中', s2[0].status === 'active', s2[0]);
await clickTask('', 'postpone');
await sleep(250);
ok('星星侧任务可延期', (await snap())[0].status === 'postponed');
ok('当天延期可「继续」', (await snap())[0].acts.includes('继续'));
await clickTask('', 'resume');
await sleep(250);
ok('继续后回到进行中', (await snap())[0].status === 'active');

/* ---------- 3. 星星再安排一件（只通过隔离库注入），用户接受并推进 ---------- */
ok('注入星星安排的任务成功', (await injectStarTask('喝三口水', 3)) === 'ok');
await reload();
let s3 = await snap();
const mine = s3.find((t) => t.text.includes('喝三口水'));
ok('星星安排的任务出现在便签上', !!mine, s3.map((t) => t.text));
ok('任务起始为待接受（用户不是执行者以外的角色）', mine && mine.status === 'pending_accept', mine && mine.status);
ok('进度显示 0/3', mine && mine.prog === '0/3', mine && mine.prog);
ok('任务正文没有「你留的」旧标记', mine && !mine.text.includes('你留的'), mine && mine.text);

ok('点击接受生效', (await clickTask('喝三口水', 'accept')) === 'ok');
await sleep(300);
const accepted = (await snap()).find((t) => t.text.includes('喝三口水'));
ok('接受后进入进行中', accepted && accepted.status === 'active', accepted);
ok('接受时给出自然回应', accepted && accepted.reply.length > 0, accepted && accepted.reply);

await clickTask('喝三口水', 'bump');
await sleep(250);
ok('点一次进度到 1/3', (await snap()).find((t) => t.text.includes('喝三口水')).prog === '1/3');
await clickTask('喝三口水', 'bump');
await sleep(250);
await clickTask('喝三口水', 'bump');
await sleep(400);
const doneTask = (await snap()).find((t) => t.text.includes('喝三口水'));
ok('满 3 次自动完成', doneTask.status === 'done', doneTask);
ok('完成有回应文案', doneTask.reply.length > 0, doneTask.reply);
ok('完成后可当天撤销', doneTask.acts.join('|') === '撤销', doneTask.acts);

const leAfterDone = await ev(`(()=>{try{const d=JSON.parse(localStorage.getItem('ylxh.life.log.v1')||'{}');return (d.items||[]).filter(i=>/^room:note-task:/.test(i.id)).length}catch(e){return -1}})()`);
ok('完成后写入生活事件（task.done）', leAfterDone >= 1, leAfterDone);

/* ---------- 4. 用户拒绝 / 延期星星安排的任务 ---------- */
ok('注入待拒绝任务', (await injectStarTask('散步', 1)) === 'ok');
ok('注入待延期任务', (await injectStarTask('早睡', 1)) === 'ok');
await reload();
ok('拒绝生效', (await clickTask('散步', 'decline')) === 'ok');
await sleep(300);
const declined = (await snap()).find((t) => t.text.includes('散步'));
ok('拒绝后状态为 declined', declined.status === 'declined', declined);
ok('拒绝不算违约，星星仍给出回应', declined.reply.length > 0, declined.reply);

await clickTask('早睡', 'postpone');
await sleep(300);
const post = (await snap()).find((t) => t.text.includes('早睡'));
ok('延期后状态为 postponed', post.status === 'postponed', post);
ok('延期不算违约，星星仍给出回应', post.reply.length > 0, post.reply);
ok('延期不改任务所属日（不跨天复制）', (await todayRows())[0].tasks.filter((t) => t.text === '早睡')[0].day === (await todayRows())[0].date);

/* ---------- 5. 刷新幂等 + 数据保留 ---------- */
await send('Page.navigate', { url: BASE + '/' });
await sleep(2600);
ok('刷新后重新挂载', (await waitFor(`(()=>{const e=document.getElementById('noteTasks');return !!e&&e.getAttribute('data-mounted')==='1'&&document.querySelectorAll('#noteTasks .nt-task').length>0})()`)) === true);

const rows2 = await todayRows();
ok('刷新后今天仍只有 1 条便签（幂等）', rows2.length === 1, rows2.length);
ok('刷新后任务条数不变（没有重复写入）', rows2[0].tasks.length === 4, rows2[0].tasks && rows2[0].tasks.length);
const s5 = await snap();
ok('刷新后完成状态保留', s5.find((t) => t.text.includes('喝三口水')).status === 'done');
ok('刷新后拒绝状态保留', s5.find((t) => t.text.includes('散步')).status === 'declined');
ok('刷新后延期状态保留', s5.find((t) => t.text.includes('早睡')).status === 'postponed');

/* ---------- 6. 跨天归档：待接受/进行中 → 过期；延期保留 ---------- */
const today = await ev(`(()=>{const d=new Date();const p=n=>n<10?'0'+n:''+n;return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())})()`);
const yest = await ev(`(()=>{const d=new Date(Date.now()-86400000);const p=n=>n<10?'0'+n:''+n;return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())})()`);
await ev(`(async()=>{
  const db=await new Promise(res=>{const r=indexedDB.open('star_fifi_room');r.onsuccess=()=>res(r.result)});
  const now=Date.now();
  const row={type:'note-day',v:1,date:${JSON.stringify(yest)},
    message:{title:'昨天',text:'昨天的话。',source:'static',at:now-86400000,base:{title:'昨天',text:'昨天的话。'}},
    tasks:[
      {id:'nt_y_pending',from:'star',text:'昨天待接受',unit:'',target:1,progress:0,status:'pending_accept',day:${JSON.stringify(yest)},createdAt:now-86400000,updatedAt:now-86400000,reply:''},
      {id:'nt_y_active',from:'her',text:'昨天进行中',unit:'',target:3,progress:1,status:'active',day:${JSON.stringify(yest)},createdAt:now-86400000,updatedAt:now-86400000,reply:''},
      {id:'nt_y_post',from:'star',text:'昨天已延期',unit:'',target:1,progress:0,status:'postponed',day:${JSON.stringify(yest)},createdAt:now-86400000,updatedAt:now-86400000,reply:''}
    ],aiAt:null,createdAt:now-86400000,updatedAt:now-86400000,archivedAt:null};
  await new Promise(res=>{const tx=db.transaction('diaries','readwrite');tx.objectStore('diaries').add(row);tx.oncomplete=()=>res()});
  db.close();return true})()`);

await send('Page.navigate', { url: BASE + '/' });
await sleep(2600);
await waitFor(`(()=>{const e=document.getElementById('noteTasks');return !!e&&e.getAttribute('data-mounted')==='1'})()`);

const yRow = (await noteRows()).find((r) => r.date === yest);
const yStat = yRow ? yRow.tasks.reduce((a, t) => (a[t.id] = t.status, a), {}) : {};
ok('跨天：待接受 → expired', yStat.nt_y_pending === 'expired', yStat);
ok('跨天：进行中 → expired', yStat.nt_y_active === 'expired', yStat);
ok('跨天：延期保留 postponed（不改 expired）', yStat.nt_y_post === 'postponed', yStat);
ok('历史遗留 from:her 行未被清理（只保留只读展示）', !!(yRow && yRow.tasks.some((t) => t.from === 'her')), yRow && yRow.tasks);
ok('昨天的记录打了归档标记', yRow && typeof yRow.archivedAt === 'number');

const todayStat = (await todayRows())[0].tasks.map((t) => t.status);
ok('今天的任务未被跨天归档误伤', todayStat.includes('done') && todayStat.includes('postponed'), todayStat);
ok('新一天没有复制旧任务', !(await todayRows())[0].tasks.some((t) => /昨天/.test(t.text)));

/* ---------- 7. 往日折叠 ---------- */
const foldBtn = await ev(`(()=>{const b=document.querySelector('#noteTasks [data-act="history"]');return b?b.textContent.trim():''})()`);
ok('底部出现往日折叠入口', /更早的便签/.test(foldBtn), foldBtn);
await ev(`(()=>{document.querySelector('#noteTasks [data-act="history"]').click();return true})()`);
await sleep(300);
const hist = await ev(`(()=>{const h=document.querySelector('#noteTasks .nt-history');return h?h.innerText:''})()`);
ok('展开后按日期显示往日记录', hist.includes('月') && hist.includes('昨天的话'), hist.slice(0, 80));
ok('往日里显示任务最终结果', /没做完|延期|完成/.test(hist), hist.slice(0, 120));

/* ---------- 8. AI 入口：桩验证，每天一次 ---------- */
const aiText = await ev(`(()=>{const b=[...document.querySelectorAll('#noteTasks .nt-foot-btn')].find(x=>x.textContent.includes('让星星说一句'));return b?'has':'none'})()`);
ok('默认存在「让星星说一句」入口', aiText === 'has', aiText);

const aiLineNow = await ev('window.NoteCard.aiLine()');
ok('AI 摘要带真实任务内容（可回答「今天给我安排了什么」）', /喝水|散步|早睡/.test(aiLineNow), aiLineNow);
ok('AI 摘要明确「你给用户安排」', /你给用户安排/.test(aiLineNow), aiLineNow);
ok('AI 摘要不把任务说成她自己的待办', /不是她自己的待办/.test(aiLineNow), aiLineNow);
ok('AI 摘要不要求星星执行', /不替她执行/.test(aiLineNow), aiLineNow);
ok('AI 摘要排除历史遗留 her 行', !aiLineNow.includes('昨天进行中'), aiLineNow);

await ev(`(()=>{window.__aiCalls=0;window.callAI=function(){window.__aiCalls++;return Promise.resolve('今天也慢一点。||| Take it slow.');};return true})()`);
await ev(`(()=>{[...document.querySelectorAll('#noteTasks .nt-foot-btn')].find(x=>x.textContent.includes('让星星说一句')).click();return true})()`);
await sleep(600);
ok('AI 只调用一次', (await ev('window.__aiCalls')) === 1, await ev('window.__aiCalls'));
ok('留言正文被替换为新的一句', (await ev(`(document.getElementById('dailyText')||{}).textContent`)) === '今天也慢一点。');
ok('双语分隔符已剥离（正文无 |||）', !(await ev(`(document.getElementById('dailyText')||{}).textContent`)).includes('|||'));
ok('用过后入口消失（当天一次）', (await ev(`(()=>{const b=[...document.querySelectorAll('#noteTasks .nt-foot-btn')].find(x=>x.textContent.includes('让星星说一句'));return !b})()`)) === true);

const again = await ev(`(async()=>{const r=await window.NoteCard._askStar();return {r:r,calls:window.__aiCalls,aiAt:window.NoteCard.note.aiAt}})()`);
ok('再次触发被挡下，不再发请求', again && again.calls === 1 && again.r === false, again);
ok('当天已用标记已落库', (await todayRows())[0].aiAt !== null);
ok('天气未被 AI 留言覆盖', (await ev(`(document.getElementById('weatherText')||{}).textContent||''`)).trim().length > 0);
ok('签名仍在（AI 留言不改卡片结构）', (await ev(`(()=>[...document.querySelector('.note-card').children].filter(n=>{const t=(n.textContent||'').trim();return t.includes('星星留')&&!t.includes('给星星留')}).length)()`)) === 1);

/* ---------- 9. 邮局与日记摘要隔离 ---------- */
await ev(`(async()=>{await renderDiaries();return true})()`);
await sleep(500);
const postView = await ev(`(()=>({hint:(document.getElementById('diaryList')||{}).innerText||'',
  cards:document.querySelectorAll('#diaryList .diary-card').length,
  cache:typeof diarySummaryCache==='string'?diarySummaryCache:'x'}))()`);
ok('时光邮册不出现便签任务内容', !/今天的小事|喝水|散步|早睡/.test(postView.hint), postView.hint.slice(0, 100));
ok('时光邮册仍在空态（没有把便签当来信）', postView.cards === 0, postView.cards);
ok('日记摘要未被便签污染', postView.cache === '', postView.cache);

/* ---------- 10. 其他数据不受影响 + 零请求 ---------- */
const endCounts = await ev(`(async()=>{
  const g=(s)=>new Promise(res=>{indexedDB.open('star_fifi_room').onsuccess=e=>{const db=e.target.result;
    try{const q=db.transaction(s).objectStore(s).getAll();q.onsuccess=()=>{db.close();res((q.result||[]).length)};q.onerror=()=>{db.close();res(-1)}}catch(err){db.close();res(-1)}}});
  return {messages:await g('messages'), keeps:await g('keeps'), diaries:await g('diaries')}})()`);
ok('聊天记录条数不受影响', endCounts.messages === baseCounts.messages, { before: baseCounts.messages, after: endCounts.messages });
ok('珍藏条数不受影响', endCounts.keeps === baseCounts.keeps, { before: baseCounts.keeps, after: endCounts.keeps });
ok('diaries 只多了昨天那条注入记录（便签未扩散）', endCounts.diaries === baseCounts.diaries + 1, { before: baseCounts.diaries, after: endCounts.diaries });
ok('便签没有写进 messages', endCounts.messages === baseCounts.messages);

/* ---------- 11. 真实聊天提问：system 上下文必须带任务内容与单向关系（AI 用桩，不发真实请求） ---------- */
await ev(`(async()=>{
  await kvSet('apiKey','sk-test'); apiKey='sk-test';
  settings.voiceEnabled=false; await kvSet('settings', settings);   // 关掉语音，避免 TTS 外网请求
  window.__chatSys='';
  window.callAI=function(msgs){ window.__chatSys=(msgs&&msgs[0]&&msgs[0].content)||'';
    return Promise.resolve('今天给你安排了喝水、散步和早睡，慢慢来。 ||| Take it easy.'); };
  document.getElementById('chatInput').value='今天给我安排了什么？';
  await sendMessage(); return true;
})()`);
await waitFor(`(window.__chatSys||'').length>0`, 40, 250);
const sysNow = await ev('window.__chatSys');
ok('聊天 system 已注入便签任务内容', /喝水|散步|早睡/.test(sysNow || ''), (sysNow || '').slice(-260));
ok('聊天 system 明确小星是发起者', /你（小星）主动安排给用户/.test(sysNow || ''), (sysNow || '').slice(-260));
ok('聊天 system 明确不是用户自己的待办', /不是用户给自己列的待办/.test(sysNow || ''), (sysNow || '').slice(-260));
ok('聊天 system 不要求星星代为执行', /不要替她执行/.test(sysNow || ''), (sysNow || '').slice(-260));
ok('聊天 system 允许她自由接受/拒绝/延期', /都不算违约/.test(sysNow || ''), (sysNow || '').slice(-260));

ok('全程 0 次 /api 请求', apiCalls.length === 0, apiCalls.slice(0, 3));
ok('零 JS 异常', errors.length === 0, errors.slice(0, 3));

console.log(`\n# 便签浏览器集成：${pass} 通过 / ${fail} 失败`);
try { ws.close(); } catch {}
try { proc.kill(); } catch {}
process.exit(fail ? 1 : 0);
