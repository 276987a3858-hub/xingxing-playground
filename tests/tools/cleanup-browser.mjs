/* tests/tools/cleanup-browser.mjs — 「数据整理」临时工具真实浏览器验收
 * 自建静态服务（public/），随机 profile，库名带 _t 后缀，
 * 全程不碰 127.0.0.1:8787 的真实数据，不调用 /api，不写 localStorage。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = join(ROOT, 'public');
const PORT = 8794;
const CDP = 9414;
const BASE = `http://127.0.0.1:${PORT}`;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.mp3': 'audio/mpeg',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/') p = '/index.html';
    const file = normalize(join(PUBLIC, p.slice(1)));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403).end('no'); return; }
    const s = await stat(file);
    if (s.isDirectory()) { res.writeHead(404).end('dir'); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('404');
  }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const PROFILE = mkdtempSync(join(tmpdir(), 'cleanup-tool-'));
const browser = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--disable-features=Translate', 'about:blank'], { stdio: 'ignore' });

let ws, mid = 0;
const pending = new Map();
const pageErrors = [];
const call = (method, params = {}) => new Promise((res, rej) => {
  const id = ++mid;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 60000);
});

for (let i = 0; i < 80; i++) {
  try { const r = await fetch(`http://127.0.0.1:${CDP}/json/version`); if (r.ok) break; } catch { }
  await sleep(250);
}
const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    pageErrors.push('EX ' + (d.exception?.description || d.text));
  }
  if (m.id && pending.has(m.id)) {
    const t = pending.get(m.id); pending.delete(m.id);
    m.error ? t.rej(new Error(m.error.message)) : t.res(m.result);
  }
};
await call('Runtime.enable');
await call('Page.enable');

const ev = async (expr) => {
  const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 300) : '')); }
};
const section = (t) => console.log('\n' + t);

const goto = async (url, readyExpr) => {
  await call('Page.navigate', { url });
  for (let i = 0; i < 100; i++) {
    const r = await ev(`!!(${readyExpr}) && document.readyState === 'complete'`).catch(() => false);
    if (r) return true;
    await sleep(150);
  }
  throw new Error('页面没准备好: ' + url);
};

// ---------------------------------------------------------------- 灌数据
const SEED = (suffix) => `(async () => {
  const S = ${JSON.stringify(suffix)};
  const open = (name, ver, up) => new Promise((res, rej) => {
    const r = indexedDB.open(name + S, ver);
    r.onupgradeneeded = () => up(r.result);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const put = (db, store, rows) => new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    rows.forEach((x) => tx.objectStore(store).put(x));
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
  const T = 1763500000000;

  const room = await open('star_fifi_room', 3, (d) => {
    if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
    ['messages','diaries','starDiaries','keeps','futureLetters'].forEach((n) => {
      if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, { keyPath: 'id', autoIncrement: true });
    });
  });
  await put(room, 'messages', [
    { id: 1, role: 'user', content: '测试：今天晚饭吃了面', time: T },
    { id: 2, role: 'assistant', content: '星星回的一条测试消息', time: T + 1000, silent: true, silentReason: '测试沉默' },
    { id: 3, role: 'user', content: '这条带一张测试图片', time: T + 2000, image: 'data:image/png;base64,AAAA' },
    { id: 4, role: 'user', content: '这条带一段测试语音', time: T + 3000, audioData: 'data:audio/mpeg;base64,AAEC' },
  ]);
  await put(room, 'keeps', [
    { id: 1, title: '测试珍藏', content: '从聊天里留的测试珍藏', by: '用户', createdAt: T, status: 'approved', sourceMessageId: 1, photo: 'data:image/jpeg;base64,AAAA' },
    { id: 2, title: '另一条珍藏', content: '这条不该被删', by: '用户', createdAt: T + 10 },
  ]);
  await put(room, 'starDiaries', [{ id: 1, title: '星星的日记', content: '测试日记内容', createdAt: T, date: '2026-11-19' }]);
  await put(room, 'futureLetters', [{ id: 1, title: '一封测试的信', content: '未来信内容', createdAt: T, openDate: '2026-12-01', openAt: T, status: 'sealed', replyMessageId: 1, reply: '', replyStatus: 'waiting' }]);
  room.close();

  const but = await open('star_butler_v1', 2, (d) => {
    if (!d.objectStoreNames.contains('tasks')) d.createObjectStore('tasks', { keyPath: 'id' });
    if (!d.objectStoreNames.contains('transactions')) d.createObjectStore('transactions', { keyPath: 'id' });
    if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
  });
  await put(but, 'tasks', [{ id: 'task_test1', type: 'todo', title: '测试待办', note: '备注', date: '2026-11-20', status: 'pending', createdAt: T, updatedAt: T, history: [] }]);
  await put(but, 'transactions', [{ id: 'tx_test1', type: 'expense', amount: 12.5, category: '餐饮', date: '2026-11-19', note: '测试账单', createdAt: T, updatedAt: T, history: [] }]);
  but.close();

  const rad = await open('ylxh_radio_voice', 1, (d) => {
    if (!d.objectStoreNames.contains('clips')) d.createObjectStore('clips', { keyPath: 'id' });
  });
  const bytes = new Uint8Array([1,2,3,4,5,6,7,8]);
  await put(rad, 'clips', [{ id: 'clip_test1', name: '测试素材.mp3', blob: new Blob([bytes], { type: 'audio/mpeg' }), mime: 'audio/mpeg', size: bytes.length, createdAt: T, use: 'none' }]);
  rad.close();
  return 'seeded';
})()`;

const DBSTATE = `(async () => {
  const open = (n) => new Promise((res, rej) => { const r = indexedDB.open(n); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const all = (db, s) => new Promise((res) => { const tx = db.transaction(s, 'readonly'); const q = tx.objectStore(s).getAll(); q.onsuccess = () => res(q.result); });
  const keys = (db, s) => new Promise((res) => { const tx = db.transaction(s, 'readonly'); const q = tx.objectStore(s).getAllKeys(); q.onsuccess = () => res(q.result); });
  const room = await open('star_fifi_room_t');
  const msgIds = await keys(room, 'messages');
  const keeps = await all(room, 'keeps');
  const letters = await all(room, 'futureLetters');
  room.close();
  const but = await open('star_butler_v1_t');
  const tasks = await keys(but, 'tasks');
  const txns = await keys(but, 'transactions');
  but.close();
  const rad = await open('ylxh_radio_voice_t');
  const clips = await keys(rad, 'clips');
  rad.close();
  return {
    msgIds: msgIds.sort((a,b)=>a-b),
    keeps: keeps.map(k => ({ id: k.id, sourceMessageId: k.sourceMessageId === undefined ? null : k.sourceMessageId, photo: !!k.photo })),
    letters: letters.map(l => ({ id: l.id, replyMessageId: l.replyMessageId === undefined ? null : l.replyMessageId })),
    tasks: tasks.length, txns: txns.length, clips: clips.length,
  };
})()`;

// ---------------------------------------------------------------- 跑
try {
  await goto(BASE + '/cleanup.html?suffix=_t', `window.CleanupTool`);
  // 空库：页面不该创建任何库
  let dbsBefore = await ev(`indexedDB.databases().then(l => l.map(d => d.name).sort())`);
  section('[1] 空环境不创建数据库');
  ok('打开整理页后没有新建任何库', dbsBefore.length === 0, dbsBefore);

  await ev(SEED('_t'));
  dbsBefore = await ev(`indexedDB.databases().then(l => l.map(d => d.name).sort())`);
  ok('灌入三个隔离库（_t 后缀）', dbsBefore.length === 3, dbsBefore);

  const lsBefore = await ev(`JSON.stringify(Object.keys(localStorage).sort())`);
  await goto(BASE + '/cleanup.html?suffix=_t', `window.CleanupTool && document.querySelectorAll('#tabs .tab').length === 7`);

  section('[2] 概况与分类');
  const stats = await ev(`document.getElementById('dbStat').innerText.replace(/\\n/g,' ')`);
  ok('统计显示聊天记录 4', /聊天记录\s*4/.test(stats), stats);
  ok('统计显示珍藏 2', /珍藏\s*2/.test(stats));
  ok('统计显示星星日记 1', /星星日记\s*1/.test(stats));
  ok('统计显示未来信 1', /未来信\s*1/.test(stats));
  ok('统计显示电台声音 1', /电台声音\s*1/.test(stats));

  const tabCount = await ev(`document.querySelectorAll('#tabs .tab').length`);
  ok('七个分类入口', tabCount === 7, tabCount);

  const rows = await ev(`document.querySelectorAll('#list .row').length`);
  ok('聊天列表渲染 4 条', rows === 4, rows);
  const tagText = await ev(`Array.from(document.querySelectorAll('#list .tag')).map(e=>e.textContent).join('|')`);
  ok('标签识别出沉默/图片/语音', /沉默消息/.test(tagText) && /图片/.test(tagText) && /语音/.test(tagText), tagText);
  const order = await ev(`document.querySelector('#list .row .meta').textContent`);
  ok('按时间倒序（最新一条在最上面）', /#4/.test(order), order);

  section('[3] 二次确认：摘要与关联提示');
  await ev(`(function(){var r=document.querySelectorAll('#list .row')[3]; r.querySelector('.del').click(); return true;})()`);
  await sleep(400);
  const dlgOpen = await ev(`document.getElementById('mask').classList.contains('on')`);
  ok('点击删除先弹确认卡片，不直接删', dlgOpen === true);
  const dlgQuote = await ev(`document.getElementById('dlgQuote').textContent`);
  ok('确认卡片显示记录摘要', /今天晚饭吃了面/.test(dlgQuote), dlgQuote);
  const dlgTitle = await ev(`document.getElementById('dlgTitle').textContent`);
  ok('标题标明分类', /聊天记录/.test(dlgTitle), dlgTitle);
  const relText = await ev(`document.getElementById('dlgRel').textContent`);
  ok('关联检查列出 1 条珍藏', /珍藏\s*1\s*条/.test(relText), relText);
  ok('关联检查列出 1 条未来信', /未来信\s*1\s*条/.test(relText), relText);
  ok('明确说明不会连带删除', /不会被删除/.test(relText));

  await ev(`document.getElementById('dlgCancel').click()`);
  await sleep(200);
  const stillOpen = await ev(`document.getElementById('mask').classList.contains('on')`);
  ok('取消后卡片关闭', stillOpen === false);
  ok('取消后记录仍在', (await ev(DBSTATE)).msgIds.includes(1));

  section('[4] 确认删除单条消息（关联数据必须保留）');
  await ev(`(function(){var r=document.querySelectorAll('#list .row')[3]; r.querySelector('.del').click(); return true;})()`);
  await sleep(400);
  await ev(`document.getElementById('dlgOk').click()`);
  let logged = '';
  for (let i = 0; i < 60; i++) {
    logged = await ev(`document.getElementById('log').innerText`);
    if (/已删除/.test(logged)) break;
    await sleep(150);
  }
  ok('操作记录显示已删除', /已删除 聊天记录 #1/.test(logged), logged.slice(0, 120));
  let st = await ev(DBSTATE);
  ok('消息 1 已从库中消失', st.msgIds.join(',') === '2,3,4', st.msgIds);
  ok('珍藏仍是 2 条（没有连带删除）', st.keeps.length === 2, st.keeps);
  ok('珍藏的 sourceMessageId 未被改写', st.keeps.find(k => k.id === 1).sourceMessageId === 1, st.keeps);
  ok('未来信仍是 1 封且 replyMessageId 未被改写', st.letters.length === 1 && st.letters[0].replyMessageId === 1, st.letters);
  ok('待办/账单/电台素材都没动', st.tasks === 1 && st.txns === 1 && st.clips === 1, st);
  const remain = await ev(`document.querySelectorAll('#list .row').length`);
  ok('删除后列表立即刷新为 3 条', remain === 3, remain);
  const tabN = await ev(`Array.from(document.querySelectorAll('#tabs .tab')).find(b=>/聊天记录/.test(b.textContent)).querySelector('.n').textContent`);
  ok('分类数字同步为 3', tabN === '3', tabN);

  section('[5] 带附件的记录会明确提示');
  await ev(`(function(){var rows=document.querySelectorAll('#list .row'); for(var i=0;i<rows.length;i++){ if(/测试图片/.test(rows[i].querySelector('.txt').textContent)){ rows[i].querySelector('.del').click(); return true; } } return false;})()`);
  await sleep(400);
  const warnImg = await ev(`document.getElementById('dlgWarn').hidden ? '' : document.getElementById('dlgWarn').textContent`);
  ok('提示图片会随消息一起删除', /图片/.test(warnImg) && /无法找回|一起删除/.test(warnImg), warnImg);
  await ev(`document.getElementById('dlgOk').click()`);
  await sleep(700);
  st = await ev(DBSTATE);
  ok('消息 3 已删除，剩下 2、4', st.msgIds.join(',') === '2,4', st.msgIds);
  ok('珍藏（另一条也有照片）仍在', st.keeps.length === 2);

  section('[6] 删除失败必须保留原记录');
  await ev(`(function(){
    window.__origDel = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function(k){ if (k === 2) throw new Error('模拟删除失败'); return window.__origDel.call(this, k); };
    return true;
  })()`);
  await ev(`(function(){var rows=document.querySelectorAll('#list .row'); for(var i=0;i<rows.length;i++){ if(/星星回的一条测试消息/.test(rows[i].querySelector('.txt').textContent)){ rows[i].querySelector('.del').click(); return true; } } return false;})()`);
  await sleep(400);
  await ev(`document.getElementById('dlgOk').click()`);
  let errTxt = '';
  for (let i = 0; i < 40; i++) {
    errTxt = await ev(`document.getElementById('dlgErr').hidden ? '' : document.getElementById('dlgErr').textContent`);
    if (errTxt) break;
    await sleep(150);
  }
  ok('界面显示删除失败', /删除失败/.test(errTxt), errTxt);
  ok('明确说明记录已保留', /记录已保留/.test(errTxt), errTxt);
  ok('失败时确认卡片不关闭（可重试）', (await ev(`document.getElementById('mask').classList.contains('on')`)) === true);
  st = await ev(DBSTATE);
  ok('失败的消息 2 仍在库里', st.msgIds.join(',') === '2,4', st.msgIds);
  await ev(`IDBObjectStore.prototype.delete = window.__origDel; delete window.__origDel; document.getElementById('dlgCancel').click();`);
  await sleep(200);

  section('[7] 其余分类逐条删除');
  const clickTab = async (label) => {
    await ev(`(function(){var t=Array.from(document.querySelectorAll('#tabs .tab')).find(b=>b.textContent.indexOf(${JSON.stringify(label)})===0); t.click(); return true;})()`);
    await sleep(500);
  };
  await clickTab('珍藏');
  ok('珍藏列表 2 条', (await ev(`document.querySelectorAll('#list .row').length`)) === 2);
  await ev(`(function(){var rows=document.querySelectorAll('#list .row'); for(var i=0;i<rows.length;i++){ if(/测试珍藏/.test(rows[i].textContent)){ rows[i].querySelector('.del').click(); return true; } } return false;})()`);
  await sleep(400);
  const keepWarn = await ev(`document.getElementById('dlgWarn').hidden ? '' : document.getElementById('dlgWarn').textContent`);
  ok('珍藏的照片也会提示', /照片/.test(keepWarn), keepWarn);
  await ev(`document.getElementById('dlgOk').click()`);
  await sleep(600);
  st = await ev(DBSTATE);
  ok('珍藏 1 已删，另一条保留', st.keeps.length === 1 && st.keeps[0].id === 2, st.keeps);

  await clickTab('星星日记');
  ok('星星日记 1 条', (await ev(`document.querySelectorAll('#list .row').length`)) === 1);
  await ev(`document.querySelector('#list .row .del').click()`);
  await sleep(350);
  await ev(`document.getElementById('dlgOk').click()`);
  await sleep(600);
  ok('星星日记已清空', (await ev(`document.querySelectorAll('#list .row').length`)) === 0);

  await clickTab('未来信');
  await ev(`document.querySelector('#list .row .del').click()`);
  await sleep(350);
  const letterQuote = await ev(`document.getElementById('dlgQuote').textContent`);
  ok('未来信确认卡显示标题', /一封测试的信/.test(letterQuote), letterQuote);
  await ev(`document.getElementById('dlgOk').click()`);
  await sleep(600);
  ok('未来信已删除', (await ev(`document.querySelectorAll('#list .row').length`)) === 0);

  await clickTab('待办与日程');
  await ev(`document.querySelector('#list .row .del').click()`);
  await sleep(350);
  ok('待办确认卡显示标题', /测试待办/.test(await ev(`document.getElementById('dlgQuote').textContent`)));
  await ev(`document.getElementById('dlgOk').click()`);
  await sleep(600);
  ok('待办已删除', (await ev(`document.querySelectorAll('#list .row').length`)) === 0);

  await clickTab('账单');
  await ev(`document.querySelector('#list .row .del').click()`);
  await sleep(350);
  ok('账单确认卡显示金额', /测试账单/.test(await ev(`document.getElementById('dlgQuote').textContent`)));
  await ev(`document.getElementById('dlgOk').click()`);
  await sleep(600);
  ok('账单已删除', (await ev(`document.querySelectorAll('#list .row').length`)) === 0);

  await clickTab('电台声音');
  await ev(`document.querySelector('#list .row .del').click()`);
  await sleep(350);
  const clipWarn = await ev(`document.getElementById('dlgWarn').hidden ? '' : document.getElementById('dlgWarn').textContent`);
  ok('电台素材提示音频文件会被删', /音频/.test(clipWarn), clipWarn);
  await ev(`document.getElementById('dlgOk').click()`);
  await sleep(700);
  ok('电台素材已删除', (await ev(`document.querySelectorAll('#list .row').length`)) === 0);
  st = await ev(DBSTATE);
  ok('管家与电台隔离库已清空（只剩聊天 2、4）', st.tasks === 0 && st.txns === 0 && st.clips === 0 && st.msgIds.join(',') === '2,4', st);

  section('[8] 不存在的库：报错且不得创建');
  const miss = await ev(`(async () => {
    CleanupTool.setSuffix('_none');
    try { await CleanupTool.list('clips'); return 'no-error'; }
    catch (e) { return 'err: ' + e.message; }
  })()`);
  ok('缺库时读取报错而不是新建', /^err:/.test(miss), miss);
  const dbsAfter = await ev(`indexedDB.databases().then(l => l.map(d => d.name).sort())`);
  ok('没有生成 *_none 的库', !dbsAfter.some((n) => /_none$/.test(n)), dbsAfter);

  section('[9] 不写 localStorage、不动设置');
  const lsAfter = await ev(`JSON.stringify(Object.keys(localStorage).sort())`);
  ok('localStorage 键完全没变', lsBefore === lsAfter, { before: lsBefore, after: lsAfter });

  section('[10] 搜索过滤');
  await ev(`CleanupTool.setSuffix('_t')`);
  await goto(BASE + '/cleanup.html?suffix=_t', `window.CleanupTool && document.querySelectorAll('#tabs .tab').length === 7`);
  await ev(`(function(){var q=document.getElementById('q'); q.value='测试语音'; q.dispatchEvent(new Event('input')); return true;})()`);
  await sleep(400);
  const filtered = await ev(`document.querySelectorAll('#list .row').length`);
  ok('搜索命中 1 条', filtered === 1, filtered);
  await ev(`(function(){var q=document.getElementById('q'); q.value='绝对不存在的词'; q.dispatchEvent(new Event('input')); return true;})()`);
  await sleep(400);
  const none = await ev(`document.getElementById('list').innerText`);
  ok('无匹配时给出提示而不是空白', /没有匹配/.test(none), none);

  section('[11] 首页入口');
  await goto(BASE + '/index.html', `document.readyState === 'complete'`);
  const entry = await ev(`(function(){var a=document.querySelector('a[href="/cleanup.html"]'); return a ? a.textContent : null;})()`);
  ok('房间设置里有数据整理入口', !!entry && /数据整理/.test(entry), entry);

  ok('页面没有抛出未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 3));
} catch (e) {
  fail++;
  console.log('\n  ✗ 运行中断：' + e.message);
  if (pageErrors.length) console.log('  页面异常：' + pageErrors.slice(0, 5).join(' | '));
} finally {
  try { ws.close(); } catch { }
  try { browser.kill(); } catch { }
  try { server.close(); } catch { }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
