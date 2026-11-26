/* tests/butler/keep-proposal.mjs
 * 珍藏提议（[[KEEP_PROPOSAL]]）mock 验证：真实房间页面 + 真实 IndexedDB，AI 用 stub，不发任何网络请求。
 * 只测珍藏提议链路，不碰「放进日记」按钮。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9342;
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const profile = `${process.env.TEMP || 'C:\\Windows\\Temp'}\\keep-edge-${Date.now()}`;

const browser = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--window-size=1280,1000', 'about:blank',
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
  const externalReqs = [], errors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); return; }
    if (m.method === 'Network.requestWillBeSent' && m.sessionId === sessionId) {
      const u = m.params.request.url;
      if (!u.startsWith('http://127.0.0.1')) externalReqs.push(u);
    }
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
    if (process.env.KP_DEBUG) console.log('  · eval', String(expression).replace(/\s+/g, ' ').slice(0, 70));
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result.value;
  };

  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  sessionId = (await call('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  await call('Page.enable'); await call('Runtime.enable'); await call('Network.enable');

  // 断网：把 fetch 换成 stub，任何真实网络调用都会被记录但不发出
  await call('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      window.__netCalls = [];
      const stub = (url) => {
        window.__netCalls.push(String(url));
        return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { headers: { 'content-type': 'application/json' } }));
      };
      window.fetch = stub;
    })();`,
  });

  await call('Page.navigate', { url: BASE + '/' });
  await sleep(2200);

  // 写入 mock apiKey（走真实 kv），然后重载让 init 读到
  await evalJS(`(async function(){
    const db = await new Promise((res, rej) => { const r = indexedDB.open('star_fifi_room'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    await new Promise((res, rej) => { const tx = db.transaction('kv','readwrite'); tx.objectStore('kv').put('mock-key','apiKey'); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    db.close(); return 1;
  })()`);
  await call('Page.reload'); await sleep(2200);

  // AI 出口全部 stub：callAI 返回预设文本，语音/翻译不触发
  const setupMock = async (reply) => evalJS(`(function(){
    window.__mockReply = ${JSON.stringify(reply)};
    window.callAI = async function(){ return window.__mockReply; };
    window.fetchEnglishTranslation = async function(){ return ''; };
    window.requestAndPlaySpeech = function(){};
    return 1;
  })()`);

  const send = async (reply, userText = '嗯') => {
    await setupMock(reply);
    await evalJS(`(function(){ document.getElementById('chatInput').value = ${JSON.stringify(userText)}; return window.sendMessage(); })()`);
    await sleep(1200); // detectStarKeepProposal / detectUserKeepRequest 都是 fire-and-forget
  };

  const keeps = () => evalJS(`(async function(){
    const db = await new Promise((res, rej) => { const r = indexedDB.open('star_fifi_room'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const rows = await new Promise((res, rej) => { const tx = db.transaction('keeps'); const rq = tx.objectStore('keeps').getAll(); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
    db.close();
    return rows.map(k => ({ id:k.id, title:k.title, content:k.content, by:k.by, status:k.status, response:k.response, src:k.sourceMessageId }));
  })()`);

  const lastChat = () => evalJS(`(function(){
    const items = document.querySelectorAll('#messages .assistant-message');
    const last = items[items.length-1];
    return last ? last.innerText : '';
  })()`);

  // ---- 1) 有标记：截获 + 生成提议 ----
  const PROPOSAL = '这件事我想留下来。\n[[KEEP_PROPOSAL: {"title":"雨夜的伞","text":"她把伞往我这边偏了一半，自己肩膀湿了。","reason":"这种偏心，我想记着。"}]]';
  await send(PROPOSAL);
  let list = await keeps();
  const created = list.filter(k => k.src != null);
  check('K01 标记被截获并生成珍藏提议', created.length === 1, JSON.stringify(created[0] || null));
  check('K02 标题/正文/理由解析正确', created.length === 1 && created[0].title === '雨夜的伞' && created[0].content.includes('肩膀湿了') && created[0].response.includes('偏心'),
    created[0] ? created[0].title : '');
  check('K03 初始状态为等待用户确认', created.length === 1 && created[0].status === 'waiting_user', created[0] && created[0].status);
  check('K04 来源是星星提出，而不是用户', created.length === 1 && created[0].by === '星星', created[0] && created[0].by);

  // ---- 2) 显示：正文净化 + 卡片可见 ----
  const chatText = await lastChat();
  check('K05 聊天正文不残留标记', !chatText.includes('KEEP_PROPOSAL') && !chatText.includes('{'), chatText.slice(0, 40));
  const card = await evalJS(`(function(){
    const list = document.getElementById('keepList');
    if (!list) return null;
    const cards = Array.from(list.querySelectorAll('.diary-card'));
    const c = cards.find(x => x.innerText.includes('雨夜的伞'));
    if (!c) return null;
    return { text: c.innerText, buttons: Array.from(c.querySelectorAll('button')).map(b => b.textContent.trim()) };
  })()`);
  check('K06 珍藏页显示提议卡片', !!card, card ? card.text.replace(/\n/g, ' ').slice(0, 50) : 'null');
  check('K07 卡片提供确认/拒绝按钮', !!card && card.buttons.includes('确认珍藏') && card.buttons.includes('暂不收录'), card ? card.buttons.join(',') : '');

  // ---- 3) 确认 → saved ----
  await evalJS(`(function(){
    const list = document.getElementById('keepList');
    const c = Array.from(list.querySelectorAll('.diary-card')).find(x => x.innerText.includes('雨夜的伞'));
    const btn = Array.from(c.querySelectorAll('button')).find(b => b.textContent.includes('确认珍藏'));
    btn.click(); return 1;
  })()`);
  await sleep(600);
  list = await keeps();
  const afterConfirm = list.find(k => k.title === '雨夜的伞');
  check('K08 用户确认后进入已保存状态', afterConfirm && afterConfirm.status === 'saved', afterConfirm && afterConfirm.status);
  const savedLabel = await evalJS(`document.getElementById('keepList').innerText.includes('已收录')`);
  check('K09 界面同步显示已收录', savedLabel === true);

  // ---- 4) 拒绝 → rejected_by_user，且不再提供按钮 ----
  await send('再来一件。\n[[KEEP_PROPOSAL: {"title":"过期的电影票","text":"抽屉里翻出的两张票根。","reason":"不算什么，但想留着。"}]]');
  list = await keeps();
  const second = list.find(k => k.title === '过期的电影票');
  check('K10 第二份提议正常生成', second && second.status === 'waiting_user', second && second.status);
  await evalJS(`(function(){
    const list = document.getElementById('keepList');
    const c = Array.from(list.querySelectorAll('.diary-card')).find(x => x.innerText.includes('过期的电影票'));
    const btn = Array.from(c.querySelectorAll('button')).find(b => b.textContent.includes('暂不收录'));
    btn.click(); return 1;
  })()`);
  await sleep(600);
  list = await keeps();
  const rejected = list.find(k => k.title === '过期的电影票');
  check('K11 用户拒绝后提议正确结束', rejected && rejected.status === 'rejected_by_user', rejected && rejected.status);
  const noButtons = await evalJS(`(function(){
    const list = document.getElementById('keepList');
    const c = Array.from(list.querySelectorAll('.diary-card')).find(x => x.innerText.includes('过期的电影票'));
    return c ? c.querySelectorAll('button').length : -1;
  })()`);
  check('K12 结束后不再出现确认按钮', noButtons === 0, String(noButtons));

  // ---- 5) 普通聊天不误创建 ----
  const before = (await keeps()).length;
  await send('今天有点累，先睡了。');
  await send('那我数星星给你听。');
  const after = await keeps();
  check('K13 无标记的普通聊天不创建珍藏', after.length === before, `${before} → ${after.length}`);
  check('K14 普通回复正文完整保留', (await lastChat()).includes('数星星'), (await lastChat()).slice(0, 30));

  // ---- 去重：同一条消息不重复建卡 ----
  const dupCount = (await keeps()).filter(k => k.title === '雨夜的伞').length;
  check('K15 同一条提议不会重复建卡', dupCount === 1, String(dupCount));

  // ---- 边界 1：正文里出现花括号，仍然要能解析 ----
  await send('[[KEEP_PROPOSAL: {"title":"花括号","text":"她在本子上画了 { 和 } 两个符号。","reason":"想留着。"}]]');
  const brace = (await keeps()).find(k => k.title === '花括号');
  check('K16 正文含花括号时仍能解析', !!brace, brace ? brace.status : '未生成');

  // ---- 边界 2：模型给的不是合法 JSON，不得把标记留在聊天正文 ----
  await send('这件也留着。\n[[KEEP_PROPOSAL: {title: 单引号版本, text: 没有双引号}]]');
  const badChat = await lastChat();
  check('K17 非法 JSON 不残留标记', !badChat.includes('KEEP_PROPOSAL'), badChat.slice(0, 40));
  const badKeep = (await keeps()).filter(k => String(k.title || '').includes('单引号'));
  check('K18 非法 JSON 不乱建卡', badKeep.length === 0, String(badKeep.length));

  // ================= 新增入口：珍藏页「请星星珍藏」按钮 =================
  const hasBtn = await evalJS(`(function(){
    return Array.from(document.querySelectorAll('#keepsakes button')).some(x => x.textContent.includes('请星星珍藏'));
  })()`);
  check('U01 珍藏页有「请星星珍藏」按钮', hasBtn === true);

  const clickAsk = (reply) => evalJS(`(function(){
    window.__aiCalls = 0;
    window.callAI = async function(){ window.__aiCalls++; return ${JSON.stringify(reply)}; };
    const b = Array.from(document.querySelectorAll('#keepsakes button')).find(x => x.textContent.includes('请星星珍藏'));
    b.click(); return 1;
  })()`);

  await clickAsk('我翻了一下最近的聊天。\n[[KEEP_PROPOSAL: {"title":"凌晨的走廊","text":"她困得站不住，还坚持陪我说完那句晚安。","reason":"这种时候最想留住。"}]]');
  await sleep(1300);
  let all = await keeps();
  const asked = all.find(k => k.title === '凌晨的走廊');
  check('U02 点击按钮后生成珍藏提议', !!asked, asked ? asked.status : '未生成');
  check('U03 来源是星星、状态为等待用户确认', !!asked && asked.by === '星星' && asked.status === 'waiting_user', asked ? asked.by + '/' + asked.status : '');
  check('U04 一次点击只调用一次 AI', (await evalJS('window.__aiCalls')) === 1, String(await evalJS('window.__aiCalls')));

  const askCard = await evalJS(`(function(){
    const list = document.getElementById('keepList');
    if (!list) return null;
    const c = Array.from(list.querySelectorAll('.diary-card')).find(x => x.innerText.includes('凌晨的走廊'));
    if (!c) return null;
    return { text: c.innerText.replace(/\\n/g,' ').slice(0,60), buttons: Array.from(c.querySelectorAll('button')).map(b=>b.textContent.trim()) };
  })()`);
  check('U05 提议卡片正确显示', !!askCard && askCard.text.includes('等待用户确认'), askCard ? askCard.text : 'null');
  check('U06 卡片提供确认/拒绝按钮', !!askCard && askCard.buttons.includes('确认珍藏') && askCard.buttons.includes('暂不收录'), askCard ? askCard.buttons.join(',') : '');

  await evalJS(`(function(){
    const c = Array.from(document.getElementById('keepList').querySelectorAll('.diary-card')).find(x => x.innerText.includes('凌晨的走廊'));
    Array.from(c.querySelectorAll('button')).find(b => b.textContent.includes('确认珍藏')).click(); return 1;
  })()`);
  await sleep(600);
  all = await keeps();
  check('U07 用户确认后保存成功', (all.find(k => k.title === '凌晨的走廊') || {}).status === 'saved', (all.find(k => k.title === '凌晨的走廊') || {}).status);

  // 再点一次 → 生成第二份，测试拒绝
  await clickAsk('还有一个瞬间。\n[[KEEP_PROPOSAL: {"title":"楼下的风铃","text":"她路过时专门停下来听了一会儿。","reason":"很轻，但想记住。"}]]');
  await sleep(1300);
  all = await keeps();
  const secondAsk = all.find(k => k.title === '楼下的风铃');
  check('U08 第二次点击也能正常生成', !!secondAsk && secondAsk.status === 'waiting_user', secondAsk ? secondAsk.status : '未生成');
  await evalJS(`(function(){
    const c = Array.from(document.getElementById('keepList').querySelectorAll('.diary-card')).find(x => x.innerText.includes('楼下的风铃'));
    Array.from(c.querySelectorAll('button')).find(b => b.textContent.includes('暂不收录')).click(); return 1;
  })()`);
  await sleep(600);
  all = await keeps();
  const rej = all.find(k => k.title === '楼下的风铃');
  check('U09 用户拒绝后提议正确结束', rej && rej.status === 'rejected_by_user', rej && rej.status);

  // 星星这次没挑出来 → 不建卡
  const beforeEmpty = (await keeps()).length;
  await clickAsk('今天好像没什么特别的。');
  await sleep(1200);
  check('U10 模型没给标记时不建卡', (await keeps()).length === beforeEmpty, String((await keeps()).length - beforeEmpty));

  // ================= 聊天里的用户主动识别已移除 =================
  const removed = await evalJS(`(function(){
    return typeof window.detectUserKeepRequest === 'undefined'
      && typeof window.proposeKeepFromChat === 'undefined'
      && typeof window.isKeepRequest === 'undefined'
      && typeof window.keepContentFromChat === 'undefined';
  })()`);
  check('U11 用户主动识别的入口与辅助函数已移除', removed === true);

  const beforePlain = (await keeps()).length;
  await send('好，我记住了。', '把刚才那句放进珍藏');
  check('U12 聊天里说「放进珍藏」不再触发', (await keeps()).length === beforePlain, String((await keeps()).length - beforePlain));
  await send('嗯。', '今天别把我的话放进珍藏');
  check('U13 否定句也不会触发', (await keeps()).length === beforePlain);
  await send('嗯。', '把这段放进日记');
  check('U14 「放进日记」不触发珍藏', (await keeps()).length === beforePlain);

  // ================= 「放进日记」按钮保持原样 =================
  const diaryCount = () => evalJS(`(async function(){
    const db = await new Promise((res, rej) => { const r = indexedDB.open('star_fifi_room'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const rows = await new Promise((res, rej) => { const tx = db.transaction('starDiaries'); const rq = tx.objectStore('starDiaries').getAll(); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
    db.close(); return rows.length;
  })()`);
  const beforeDiary = await diaryCount();
  const keepsBeforeDiary = (await keeps()).length;
  await setupMock('今天陪她坐了一会儿，谁都没说话，风从窗缝进来。');
  await evalJS(`(function(){
    const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('让星星写日记'));
    b.click(); return 1;
  })()`);
  await sleep(1300);
  check('U15 日记按钮仍能写入星星日记', (await diaryCount()) === beforeDiary + 1, `${beforeDiary} → ${await diaryCount()}`);
  check('U16 写日记不产生珍藏', (await keeps()).length === keepsBeforeDiary, String((await keeps()).length - keepsBeforeDiary));

  check('K19 全程无外部网络请求', externalReqs.length === 0, externalReqs.slice(0, 3).join(','));
  check('K20 无页面异常', errors.length === 0, errors.join(' | ').slice(0, 100));

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
