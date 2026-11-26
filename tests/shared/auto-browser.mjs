/* tests/shared/auto-browser.mjs — S3 增量自动整理 + 纠正机制 临时浏览器验收
 * 自建静态服务 + 随机临时 profile；假 AI（不调用真实接口）；合成消息写入临时库。
 * 不碰 127.0.0.1:8787、不读真实数据、不改真实正式记录/水位。
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
const PORT = 8798;
const CDP = 9420;
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

const PROFILE = mkdtempSync(join(tmpdir(), 'sn-auto-'));
const browser = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--disable-features=Translate', 'about:blank'], { stdio: 'ignore' });

let ws, mid = 0;
const pending = new Map();
const errors = [];
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

// 模块加载与入口
const loaded = await ev(`({
  auto: typeof window.SelfNarrativeAuto === 'object',
  runAuto: typeof window.SelfNarrativeAuto?.runAutoBatch === 'function',
  detect: typeof window.SelfNarrativeAuto?.detectCorrection === 'function',
  view: typeof window.SelfNarrativeView?.render === 'function',
  autoBtn: !!Array.from(document.querySelectorAll('button')).find(b=>b.textContent.indexOf('运行一次增量自动整理')>=0),
  corrBtn: !!Array.from(document.querySelectorAll('button')).find(b=>b.textContent.indexOf('生成纠正候选')>=0),
  legacyFinish: !!Array.from(document.querySelectorAll('button')).find(b=>b.textContent.indexOf('完成本批审核')>=0)
})`);
ok('自动整理模块与入口已加载', loaded.auto && loaded.runAuto && loaded.detect, loaded);
ok('面板新增两个独立入口', loaded.autoBtn && loaded.corrBtn, loaded);
ok('原有 Dry-run 完成按钮仍在', loaded.legacyFinish, loaded);

// 打开面板
await ev(`document.getElementById('sn-dryrun-root').click()`);
await sleep(200);
const panelOpen = await ev(`(function(){const p=document.querySelector('.sn-dry-panel');return p && p.style.display!=='none';})()`);
ok('面板可打开', panelOpen);

// 注入合成消息到临时库（messages store），并覆盖 callAI 为假函数（不触发真实 API）
const seeded = await ev(`(async () => {
  const db = await new Promise((resolve, reject) => {
    const r = indexedDB.open('star_fifi_room');
    r.onupgradeneeded = () => { const d = r.result; if(!d.objectStoreNames.contains('messages')) d.createObjectStore('messages',{keyPath:'id'}); if(!d.objectStoreNames.contains('kv')) d.createObjectStore('kv'); };
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction('messages','readwrite');
    const st = tx.objectStore('messages');
    st.put({ id: 9001, role:'user', content:'她不喜欢别人替她做决定', time: Date.now() });
    st.put({ id: 9002, role:'assistant', content:'那我下次先问你', time: Date.now()+1 });
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
  db.close();
  return true;
})()`).catch((e) => String(e));
ok('合成消息写入临时库', seeded === true, seeded);

// 覆盖依赖为假 AI：返回一条 medium/stated、证据真实的候选
await ev(`(function(){
  window.SelfNarrativeDryRunDeps = window.SelfNarrativeDryRunDeps || {};
  window.SelfNarrativeDryRunDeps.callAI = async function(){ 
    return JSON.stringify({ records:[{
      kind:'impression', basis:'stated', confidence:'medium',
      text:'她很在意我有没有认真听她说话这件事', observed:'她要求我认真回答',
      inferred:'', question:'', confirmed:'', topic:'认真回应',
      evidence:[{messageId:9001, quote:'她不喜欢别人替她做决定'}]
    }]});
  };
  return true;
})()`);

// 直接调用 runAutoBatch（走面板同款依赖），验证端到端写入临时库 + 水位
const autoResult = await ev(`(async () => {
  const A = window.SelfNarrativeAuto;
  const D = window.SelfNarrativeDryRunDeps;
  const r = await A.runAutoBatch({ afterId: 0, limit: 80 }, {
    callAI: D.callAI, kvGet: D.kvGet, kvSet: D.kvSet,
    reader: window.RoomChatReader, review: window.SelfNarrativeReview,
    selfNarrative: window.SelfNarrative, dryRun: window.SelfNarrativeDryRun
  });
  return { ok:r.ok, reason:r.reason, succeeded:r.adopt.succeeded, touched:r.watermark.touched, after:r.watermark.after, apiCalls:r.apiCalls };
})()`);
ok('自动整理写入成功（假AI）', autoResult.ok && autoResult.succeeded === 1, autoResult);
ok('自动整理推进独立水位', autoResult.touched === true && autoResult.after === 9002, autoResult);
ok('仅一次 AI 请求', autoResult.apiCalls === 1, autoResult);

// 校验正式记录确实落库、source.kind=chat
const stored = await ev(`(async () => {
  const r = await window.SelfNarrative.list({ get: window.SelfNarrativeDryRunDeps.kvGet, set: ()=>{} }, { status:'all' });
  return { total: r.total, source: r.records[0] && r.records[0].source && r.records[0].source.kind, text: r.records[0] && r.records[0].text };
})()`);
ok('正式记录写入临时库', stored.total === 1 && stored.source === 'chat', stored);

// 页面能读到新记录
await ev(`showPage('home'); openSelfNarrative();`);
await sleep(300);
const pageShow = await ev(`(function(){
  const cards = document.querySelectorAll('#snViewList .snv-card');
  return { n: cards.length, text: cards[0] ? cards[0].textContent : '' };
})()`);
ok('机自述页面显示新记录', pageShow.n === 1 && pageShow.text.indexOf('认真听她说话') >= 0, pageShow);

// 纠正候选：只读生成，不改记录
const corr = await ev(`(async () => {
  const A = window.SelfNarrativeAuto;
  const r = await window.SelfNarrative.list({ get: window.SelfNarrativeDryRunDeps.kvGet, set: ()=>{} }, { status:'all' });
  const c = A.prepareCorrection('你记错了，其实我认真回答问题这件事不是那样', r.records, {});
  return { needsConfirm:c.needsConfirm, isCorrection:c.isCorrection, n:c.candidates.length };
})()`);
ok('纠正候选可生成且标记待确认', corr.needsConfirm && corr.isCorrection && corr.n >= 1, corr);

// 未确认时拒绝修改
const guard = await ev(`(async () => {
  const A = window.SelfNarrativeAuto;
  const D = window.SelfNarrativeDryRunDeps;
  const r = await A.confirmCorrection({ targetId:'x', action:'retract' }, { kvGet:D.kvGet, kvSet:D.kvSet });
  return { ok:r.ok, reason:r.reason };
})()`);
ok('未确认时拒绝修改正式记录', guard.ok === false && guard.reason === 'not-confirmed', guard);

// 记录数仍为 1（纠正候选未改动）
const finalCount = await ev(`(async () => {
  const r = await window.SelfNarrative.list({ get: window.SelfNarrativeDryRunDeps.kvGet, set: ()=>{} }, { status:'all' });
  return r.total;
})()`);
ok('纠正流程未改动正式记录', finalCount === 1, finalCount);

ok('无未捕获异常', errors.length === 0, errors.slice(0, 4));

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
console.log('临时 profile：' + PROFILE);
try { ws.close(); } catch {}
browser.kill();
server.close();
process.exitCode = fail ? 1 : 0;
