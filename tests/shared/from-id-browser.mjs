/* tests/shared/from-id-browser.mjs — 指定起点整理 临时浏览器验收
 * 自建静态服务 + 随机临时 profile + 假 AI；不碰 127.0.0.1:8787、不读真实数据、不发真实 API。
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
const PORT = 8799;
const CDP = 9421;
const BASE = `http://127.0.0.1:${PORT}`;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.mp3': 'audio/mpeg',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
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
  } catch { res.writeHead(404, { 'content-type': 'text/plain' }).end('404'); }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const PROFILE = mkdtempSync(join(tmpdir(), 'sn-from-id-'));
const browser = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--disable-features=Translate', 'about:blank'], { stdio: 'ignore' });

let ws, mid = 0;
const pending = new Map();
const errors = [];
const apiCalls = [];
const call = (method, params = {}) => new Promise((res, rej) => {
  const id = ++mid;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 60000);
});
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(`http://127.0.0.1:${CDP}/json/version`); if (r.ok) break; } catch {}
  await sleep(250);
}
const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    errors.push('EX ' + (d.exception?.description || d.text));
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push('CE ' + m.params.args.map((a) => a.value || a.description).join(' '));
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
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
};

await call('Page.navigate', { url: BASE + '/' });
for (let i = 0; i < 120; i++) {
  const ready = await ev(`!!(window.SelfNarrativeAuto && window.SelfNarrativeDryRun && document.getElementById('sn-dryrun-root'))`).catch(() => false);
  if (ready) break;
  await sleep(200);
}

// 入口存在且两种入口文案不同
const entry = await ev(`({
  mode: window.SelfNarrativeAuto.MODE_FROM_ID,
  dflt: window.SelfNarrativeAuto.DEFAULT_FROM_ID,
  normalBtn: !!Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='运行一次增量自动整理'),
  fromBtn: !!Array.from(document.querySelectorAll('button')).find(b=>b.textContent.indexOf('执行指定起点整理')>=0),
  refreshBtn: !!Array.from(document.querySelectorAll('button')).find(b=>b.textContent.indexOf('刷新水位与预览')>=0),
  section: !!Array.from(document.querySelectorAll('.sn-dry-sec')).find(n=>n.textContent.indexOf('指定消息 ID 之后开始')>=0)
})`);
ok('两种入口与独立警告区已加载', entry.mode === 'from-id' && entry.dflt === 2428 && entry.normalBtn && entry.fromBtn && entry.refreshBtn && entry.section, entry);

// 打开面板
await ev(`document.getElementById('sn-dryrun-root').click()`);
await sleep(200);

// 合成消息：旧消息 id=80 不应被读取；指定起点后的 2429/2430 应被读取
const seeded = await ev(`(async () => {
  const db = await new Promise((resolve, reject) => {
    const r = indexedDB.open('star_fifi_room');
    r.onupgradeneeded = () => { const d = r.result; if(!d.objectStoreNames.contains('messages')) d.createObjectStore('messages',{keyPath:'id'}); if(!d.objectStoreNames.contains('kv')) d.createObjectStore('kv'); };
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction('messages','readwrite');
    const st = tx.objectStore('messages');
    st.put({ id: 80, role:'user', content:'不应被读取的旧消息', time: Date.now() });
    st.put({ id: 2429, role:'user', content:'她不喜欢别人替她做决定', time: Date.now()+1 });
    st.put({ id: 2430, role:'assistant', content:'那我下次先问你', time: Date.now()+2 });
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
  await window.SelfNarrativeDryRunDeps.kvSet(window.SelfNarrativeDryRun.WATERMARK_KEY,
    { schema:1, lastAfterId:80, updatedAt:Date.now(), dryRun:false });
  db.close();
  return true;
})()`).catch((e) => String(e));
ok('临时库写入合成消息与水位=80', seeded === true, seeded);

// 假 AI：只记录调用，不触发真实接口
await ev(`(function(){
  window.__apiCalls = [];
  window.SelfNarrativeDryRunDeps.callAI = async function(messages){
    window.__apiCalls.push(messages);
    return JSON.stringify({ records:[{
      kind:'impression', basis:'stated', confidence:'medium',
      text:'她很在意我有没有认真听她说话这件事', observed:'她要求我认真回答',
      inferred:'', question:'', confirmed:'', topic:'认真回应',
      evidence:[{messageId:2429, quote:'她不喜欢别人替她做决定'}]
    }]});
  };
  window.confirm = function(){ return true; };
  return true;
})()`);

// 预览：默认参数 + 当前水位
await ev(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.indexOf('刷新水位与预览')>=0).click()`);
await sleep(300);
const preview = await ev(`(function(){
  const n = Array.from(document.querySelectorAll('.sn-dry-warnbox')).find(x=>x.textContent.indexOf('本次读取起点')>=0);
  return n ? n.textContent : null;
})()`);
ok('执行前显示起点/参数/水位', preview && preview.indexOf('id > 2428') >= 0 && preview.indexOf('limit=80') >= 0 &&
  preview.indexOf('maxAdopt=3') >= 0 && preview.indexOf('maxChars=12000') >= 0 && preview.indexOf('当前水位=80') >= 0, preview);
ok('界面明确警告水位跳转', preview && preview.indexOf('普通增量按钮会从本批末尾继续') >= 0 && preview.indexOf('不会倒退') >= 0, preview);

// 非法 afterId：按钮禁用，不会回退 watermark
const invalid = await ev(`(function(){
  const r = Array.from(document.querySelectorAll('.sn-dry-row')).find(x=>x.querySelectorAll('input').length===4);
  const input = r.querySelectorAll('input')[0];
  input.value = '';
  input.dispatchEvent(new Event('input', {bubbles:true}));
  const btn = Array.from(document.querySelectorAll('button')).find(b=>b.textContent.indexOf('执行指定起点整理')>=0);
  return { disabled: btn.disabled, hint: Array.from(document.querySelectorAll('.sn-dry-status')).some(n=>n.textContent.indexOf('不会回退到 watermark')>=0) };
})()`);
ok('空起点禁用执行并提示不回退', invalid.disabled && invalid.hint, invalid);

// 恢复默认起点并点击执行
const clicked = await ev(`(function(){
  const r = Array.from(document.querySelectorAll('.sn-dry-row')).find(x=>x.querySelectorAll('input').length===4);
  const input = r.querySelectorAll('input')[0];
  input.value = '2428';
  input.dispatchEvent(new Event('input', {bubbles:true}));
  const btn = Array.from(document.querySelectorAll('button')).find(b=>b.textContent.indexOf('执行指定起点整理')>=0);
  if (btn.disabled) return false;
  btn.click();
  return true;
})()`);
ok('指定起点按钮可点击执行', clicked === true, clicked);

// 等待结果
let fromResult = '';
for (let i = 0; i < 120; i++) {
  fromResult = await ev(`(function(){
    const n = Array.from(document.querySelectorAll('.sn-dry-result')).find(x=>x.textContent.indexOf('指定起点整理')>=0);
    return n ? n.textContent : '';
  })()`);
  if (fromResult && fromResult.indexOf('完成') >= 0) break;
  await sleep(200);
}
ok('结果显示指定起点专用文案', fromResult.indexOf('指定起点整理完成') >= 0, fromResult);
ok('结果显示实际读取 ID 范围', fromResult.indexOf('读取 msg 2429–2430') >= 0 && fromResult.indexOf('起点 id > 2428') >= 0, fromResult);
ok('结果显示采纳/拒绝/幂等/水位变化', fromResult.indexOf('采纳 1 条') >= 0 && fromResult.indexOf('幂等 0 条') >= 0 &&
  fromResult.indexOf('拒绝 0 条') >= 0 && fromResult.indexOf('水位 80 → 2430（已推进）') >= 0, fromResult);

// 真实落库：只读 messages/kv 核对
const state = await ev(`(async () => {
  const D = window.SelfNarrativeDryRunDeps;
  const wm = await window.SelfNarrativeDryRun.loadWatermark(D.kvGet);
  const list = await window.SelfNarrative.list({ get:D.kvGet, set:()=>{} }, { status:'all' });
  return { wm: wm.ok ? wm.value : null, total: list.total, source: list.records[0] && list.records[0].source && list.records[0].source.kind };
})()`);
ok('水位跳到批末 2430', state.wm === 2430, state);
ok('正式记录只写入一条 chat 来源', state.total === 1 && state.source === 'chat', state);

// 只有一次 AI 请求，且确实没有读取旧消息（证据只用 2429）
const ai = await ev(`({ n: window.__apiCalls.length, hasOld: JSON.stringify(window.__apiCalls).indexOf('不应被读取的旧消息')>=0 })`);
ok('只调用一次假 AI 且未包含旧消息', ai.n === 1 && !ai.hasOld, ai);
apiCalls.push(ai.n);

// 普通增量按钮仍在，且现在从 2430 继续（不再从 80）
// 先往临时库补一条更新的消息，让普通增量确实有内容可读。
await ev(`(async () => {
  const db = await new Promise((resolve, reject) => {
    const r = indexedDB.open('star_fifi_room');
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction('messages','readwrite');
    tx.objectStore('messages').put({ id: 2431, role:'user', content:'后来又发生的一件事', time: Date.now() });
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
  db.close();
  return true;
})()`);
const normal = await ev(`(async () => {
  const A = window.SelfNarrativeAuto, D = window.SelfNarrativeDryRunDeps;
  const r = await A.runAutoBatch({ limit:80 }, {
    callAI: D.callAI, kvGet: D.kvGet, kvSet: D.kvSet,
    reader: window.RoomChatReader, review: window.SelfNarrativeReview,
    selfNarrative: window.SelfNarrative, dryRun: window.SelfNarrativeDryRun
  });
  return { mode:r.mode, batchFrom:r.batch && r.batch.afterId, apiCalls:r.apiCalls, after:r.watermark.after };
})()`);
ok('普通增量入口按新水位继续', normal.mode === 'watermark' && normal.batchFrom === 2430 && normal.apiCalls === 1, normal);

ok('无未捕获异常', errors.length === 0, errors.slice(0, 4));

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
console.log('临时 profile：' + PROFILE);
try { ws.close(); } catch {}
browser.kill();
server.close();
process.exitCode = fail ? 1 : 0;
