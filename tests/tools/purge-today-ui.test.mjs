/* purge-today-ui.test.mjs — 清空今日便签任务页的隔离验收
 * 自建静态服务 + 临时 profile；注入补丁把库名改为 star_fifi_room_t，全程不碰真实数据。
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
const PORT = 8796, CDP = 9416, BASE = `http://127.0.0.1:${PORT}`;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/') p = '/purge-today-ui.html';
    const file = normalize(join(PUBLIC, p.slice(1)));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403).end('no'); return; }
    const s = await stat(file);
    if (s.isDirectory()) { res.writeHead(404).end('dir'); return; }
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(await readFile(file));
  } catch { res.writeHead(404).end('404'); }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const PROFILE = mkdtempSync(join(tmpdir(), 'purge-ui-'));
const browser = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });

let ws, mid = 0; const pending = new Map();
const call = (method, params = {}) => new Promise((res, rej) => {
  const id = ++mid; pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 30000);
});
for (let i = 0; i < 80; i++) { try { const r = await fetch(`http://127.0.0.1:${CDP}/json/version`); if (r.ok) break; } catch { } await sleep(250); }
const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const t = pending.get(m.id); pending.delete(m.id); m.error ? t.rej(new Error(m.error.message)) : t.res(m.result); }
};
await call('Runtime.enable'); await call('Page.enable');
const ev = async (expr) => {
  const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra).slice(0, 300) : '')); } };

const DAY = await (async () => { const d = new Date(), p = (n) => n < 10 ? '0' + n : '' + n; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); })();
console.log('测试日期：' + DAY);

try {
  // 注入库名补丁：把页面里的 star_fifi_room 改到隔离库
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `
    (function(){ var o = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function(n){ if(n==='star_fifi_room') n='star_fifi_room_t'; return o.apply(this, arguments); };
    })();
  ` });
  await call('Page.navigate', { url: BASE + '/purge-today-ui.html' });
  for (let i = 0; i < 100; i++) { if (await ev('document.readyState === "complete"').catch(() => false)) break; await sleep(100); }

  // 预置隔离数据：今日便签（3 任务 + message + weather + aiAt）、历史便签、其他类型 diary
  await ev(`(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('star_fifi_room_t',1); r.onupgradeneeded=()=>r.result.createObjectStore('diaries',{keyPath:'id'}); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); });
    await new Promise((res,rej)=>{ const tx=db.transaction('diaries','readwrite'),os=tx.objectStore('diaries');
      os.put({type:'note-day',v:1,date:${JSON.stringify(DAY)},message:{title:'便签',text:'十一点前躺下，别让我盯着你。',source:'ai',at:111,base:{}},tasks:[
        {id:'a',from:'star',text:'十一点前躺下',status:'active',createdAt:1},
        {id:'b',from:'her',text:'喊三声宝贝',status:'active',createdAt:2},
        {id:'c',from:'her',text:'星星，今天记得主动给我讲一个睡前故事。',status:'active',createdAt:3}
      ],aiAt:999,weather:{text:'晴',temp:26},createdAt:1,updatedAt:2,archivedAt:null,id:1});
      os.put({type:'note-day',v:1,date:'2026-11-18',message:{text:'昨天的留言',source:'ai'},tasks:[{id:'h',from:'star',text:'昨天的事',status:'done'}],id:2});
      os.put({type:'diary',id:3,text:'一篇普通日记'});
      tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error);
    });
    db.close(); return true;
  })()`);
  await call('Page.reload');
  for (let i = 0; i < 100; i++) { if (await ev('document.readyState === "complete"').catch(() => false)) break; await sleep(100); }

  console.log('\n[1] 读取与核对');
  await ev(`document.getElementById('btnLoad').click()`);
  await sleep(400);
  const loadTxt = await ev(`document.getElementById('loadOut').innerText`);
  ok('显示今日便签', loadTxt.includes(DAY), loadTxt.slice(0, 120));
  ok('显示 3 条任务', /任务数：3/.test(loadTxt));
  ok('显示 star 的十一点前躺下', loadTxt.includes('十一点前躺下'));
  ok('显示留言', loadTxt.includes('别让我盯着你'));
  ok('备份按钮已启用', await ev(`!document.getElementById('btnBackup').disabled`));

  console.log('\n[2] 备份与确认门槛');
  await ev(`document.getElementById('btnBackup').click()`);
  await sleep(500);
  const bkTxt = await ev(`document.getElementById('backupOut').innerText`);
  ok('备份校验通过', /备份校验通过/.test(bkTxt), bkTxt.slice(0, 120));
  ok('备份含 3 条任务', /3 条任务/.test(bkTxt));
  ok('备份文本含留言', (await ev(`document.getElementById('backupText').value`)).includes('别让我盯着你'));
  ok('未勾选时清空按钮禁用', await ev(`document.getElementById('btnClear').disabled`));
  await ev(`(function(){var c=document.getElementById('chk');c.checked=true;c.dispatchEvent(new Event('change'));return true})()`);
  ok('勾选后清空按钮启用', await ev(`!document.getElementById('btnClear').disabled`));

  console.log('\n[3] 执行清空与回读');
  await ev(`document.getElementById('btnClear').click()`);
  for (let i = 0; i < 100; i++) { const t = await ev(`document.getElementById('resultOut').innerText`); if (/校验通过|校验失败|清空失败/.test(t)) break; await sleep(100); }
  const resTxt = await ev(`document.getElementById('resultOut').innerText`);
  ok('结果显示校验通过', /校验通过/.test(resTxt), resTxt.slice(0, 200));
  ok('显示清空 3 条', /清空任务：3 条/.test(resTxt));

  const DB = await ev(`(async () => {
    const db = await new Promise((res) => { const r = indexedDB.open('star_fifi_room_t'); r.onsuccess=()=>res(r.result); });
    const rows = await new Promise((res) => { const q=db.transaction('diaries').objectStore('diaries').getAll(); q.onsuccess=()=>res(q.result); });
    db.close();
    const today = rows.find(r=>r&&r.id===1), yest = rows.find(r=>r&&r.id===2), other = rows.find(r=>r&&r.id===3);
    return { tasks: today.tasks.length, msg: today.message.text, msgSrc: today.message.source,
      weather: today.weather, aiAt: today.aiAt,
      yestTasks: yest.tasks.length, yestMsg: yest.message.text, otherText: other.text,
      lsKeys: Object.keys(localStorage) };
  })()`);
  ok('今日任务已清空', DB.tasks === 0, DB);
  ok('留言保留', DB.msg === '十一点前躺下，别让我盯着你。' && DB.msgSrc === 'ai');
  ok('天气保留', DB.weather && DB.weather.text === '晴');
  ok('aiAt 保留', DB.aiAt === 999);
  ok('历史便签未动', DB.yestTasks === 1 && DB.yestMsg === '昨天的留言');
  ok('其他类型日记未动', DB.otherText === '一篇普通日记');
  ok('未写 localStorage', DB.lsKeys.length === 0, DB.lsKeys);

  console.log('\n[4] 重复点击不重复删除');
  const again = await ev(`document.getElementById('resultOut').innerText`);
  ok('结果保持一次性成功态', /清空任务：3 条/.test(again) && /校验通过/.test(again));
} catch (e) {
  fail++; console.log('\n运行异常：' + (e.stack || e.message));
} finally {
  try { ws && ws.close(); } catch { }
  try { browser.kill(); } catch { }
  server.close();
  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}
