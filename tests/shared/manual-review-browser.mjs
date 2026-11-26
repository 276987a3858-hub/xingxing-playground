/* tests/shared/manual-review-browser.mjs — 人工重建候选入口的临时浏览器验收
 * 自建静态服务 + 随机临时 profile；只在该临时 profile 的 IndexedDB 里写合成消息。
 * 不碰 127.0.0.1:8787 的真实数据，不调用 AI，不点采纳，不创建正式机自述。
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
const PORT = 8795;
const CDP = 9415;
const BASE = `http://127.0.0.1:${PORT}`;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const MSG_ID = 9101;
const WATERMARK = { schema: 1, lastAfterId: 40, updatedAt: 1700000000000, dryRun: false };

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

const PROFILE = mkdtempSync(join(tmpdir(), 'manual-review-'));
const browser = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--disable-features=Translate', 'about:blank'], { stdio: 'ignore' });

let ws, mid = 0;
const pending = new Map();
const errors = [];
const call = (method, params = {}) => new Promise((res, rej) => {
  const id = ++mid;
  pending.set(id, { res, rej });
  const msg = { id, method, params };
  ws.send(JSON.stringify(msg));
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

async function seedTempData() {
  return ev(`(async () => {
    const watermark = ${JSON.stringify(WATERMARK)};
    return await new Promise((resolve, reject) => {
      const req = indexedDB.open('star_fifi_room');
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('messages')) db.createObjectStore('messages', { keyPath: 'id', autoIncrement: true });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      req.onerror = () => reject(req.error || new Error('open failed'));
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['messages', 'kv'], 'readwrite');
        tx.objectStore('messages').put({ id: ${MSG_ID}, role: 'user', content: '先吃饭吧等你吃完', time: Date.now(), source: null, sourceId: null, silent: false, type: null });
        tx.objectStore('kv').put(watermark, 'selfNarrative.watermark');
        tx.oncomplete = () => { db.close(); resolve(true); };
        tx.onerror = () => reject(tx.error || new Error('seed failed'));
      };
    });
  })()`);
}

async function openPanel() {
  return ev(`(function () {
    const fab = document.getElementById('sn-dryrun-root');
    if (!fab) return false;
    fab.click();
    return true;
  })()`);
}

function payload(messageId, quote) {
  return payloadList([{ messageId, quote }]);
}

function payloadList(items) {
  return JSON.stringify({
    origin: 'manual-reconstruction',
    note: '临时验收候选',
    candidates: items.map((it, i) => ({
      kind: 'impression', basis: 'observed', confidence: 'medium',
      text: it.text || ('她催我先吃饭' + (i ? '·' + (i + 1) : '')),
      observed: '她说先吃饭吧', inferred: '', confirmed: '', question: '',
      topic: '关心',
      evidence: [{ messageId: it.messageId, quote: it.quote }]
    }))
  });
}

async function importPayload(json) {
  await ev(`(function () {
    const ta = document.querySelector('.sn-dry-manual-input');
    ta.value = ${JSON.stringify(json)};
    const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === '校验并导入人工候选');
    btn.click();
    return true;
  })()`);
  for (let i = 0; i < 80; i++) {
    const done = await ev(`(function () {
      const ta = document.querySelector('.sn-dry-manual-input');
      const boxes = Array.from(document.querySelectorAll('.sn-dry-panel > div')).filter((d) => d.className.indexOf('sn-dry-status') >= 0);
      return boxes.some((d) => /核验通过|没有候选通过核验|核验异常/.test(d.textContent)) && ta && !Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === '校验并导入人工候选').disabled;
    })()`);
    if (done) return true;
    await sleep(100);
  }
  return false;
}

const uiState = () => ev(`(function () {
  const panel = document.querySelector('.sn-dry-panel');
  const cards = Array.from(document.querySelectorAll('.sn-dry-review-item'));
  const texts = Array.from(panel.querySelectorAll('div')).map((d) => d.textContent || '');
  const btns = Array.from(document.querySelectorAll('button'));
  const manualBtn = btns.find((b) => ['完成人工重建审核', '人工重建审核已完成'].indexOf(b.textContent.trim()) >= 0);
  const aiBtn = btns.find((b) => b.textContent.trim().indexOf('完成本批审核') === 0);
  const doneEl = document.querySelector('.sn-dry-done');
  return {
    fab: !!document.getElementById('sn-dryrun-root'),
    manualBox: !!document.querySelector('.sn-dry-manual-input'),
    cards: cards.length,
    tag: texts.some((t) => t.indexOf('人工重建，非原始 AI 输出') >= 0 && t.length < 200),
    verified: texts.some((t) => t.indexOf('证据核验：通过 1 条') >= 0),
    report: texts.filter((t) => /核验通过|没有候选通过核验|message-not-found|quote-mismatch|不调用 AI/.test(t)).slice(-6),
    finishText: manualBtn ? manualBtn.textContent.trim() : '',
    manualVisible: manualBtn ? getComputedStyle(manualBtn).display !== 'none' : false,
    manualDisabled: manualBtn ? manualBtn.disabled : null,
    aiVisible: aiBtn ? getComputedStyle(aiBtn).display !== 'none' : false,
    aiText: aiBtn ? aiBtn.textContent.trim() : '',
    done: doneEl && doneEl.style.display !== 'none' ? doneEl.textContent : '',
    locked: cards.length ? Array.from(cards[0].querySelectorAll('input,button')).every((n) => n.disabled) : null,
    usage: localStorage.getItem('ylxh.ai.usage.v1'),
  };
})()`);

async function markCard(index, action) {
  return ev(`(function () {
    const card = document.querySelectorAll('.sn-dry-review-item')[${index}];
    if (!card) return 'no-card';
    if ('${action}' === 'skip') {
      const b = Array.from(card.querySelectorAll('button')).find((x) => x.textContent.trim() === '明确跳过');
      if (!b) return 'no-skip';
      b.click();
      return 'skip';
    }
    const cb = card.querySelector('input[type=checkbox]');
    if (!cb) return 'no-cb';
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
    return 'adopt';
  })()`);
}

async function clickManualFinish() {
  return ev(`(function () {
    const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim().indexOf('完成人工重建审核') === 0);
    if (!b || b.disabled) return false;
    b.click();
    return true;
  })()`);
}

async function waitSettled() {
  for (let i = 0; i < 80; i++) {
    const st = await uiState();
    if (st.done) return st;
    const all = await ev(`Array.from(document.querySelectorAll('.sn-dry-panel .sn-dry-status')).map((e) => e.textContent).join(' | ')`);
    if (/失败项|人工重建审核已完成|审核执行异常|不能采纳/.test(all)) return await uiState();
    await sleep(100);
  }
  return uiState();
}

async function narrativeCount() {
  const raw = await ev(`(async () => {
    return await new Promise((resolve, reject) => {
      const req = indexedDB.open('star_fifi_room');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const g = db.transaction('kv', 'readonly').objectStore('kv').get('selfNarrative.v1');
        g.onsuccess = () => {
          db.close();
          const v = g.result;
          resolve(v && Array.isArray(v.records) ? v.records.length : 0);
        };
        g.onerror = () => reject(g.error);
      };
    });
  })()`).catch(() => -1);
  return raw;
}

const kvState = async () => {
  await ev(`(async () => {
    window.__manualKv = await new Promise((resolve, reject) => {
      const req = indexedDB.open('star_fifi_room');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const store = db.transaction('kv', 'readonly').objectStore('kv');
        const a = store.get('selfNarrative.watermark');
        const b = store.get('selfNarrative.v1');
        a.onsuccess = () => {
          b.onsuccess = () => { db.close(); resolve({ watermark: a.result || null, narrative: b.result || null }); };
          b.onerror = () => reject(b.error);
        };
        a.onerror = () => reject(a.error);
      };
    });
    return true;
  })()`).catch(async () => {
    await ev(`window.__manualKv = { watermark: 'store-missing', narrative: 'store-missing' }; true`);
  });
  const wm = await ev(`window.__manualKv.watermark ? JSON.stringify(window.__manualKv.watermark) : null`);
  const nar = await ev(`window.__manualKv.narrative ? 'present' : null`);
  return { watermark: wm ? JSON.parse(wm) : null, narrative: nar };
};

try {
  await call('Page.navigate', { url: BASE + '/' });
  for (let i = 0; i < 100; i++) {
    const ready = await ev(`!!(window.SelfNarrativeDryRun && window.RoomChatReader && document.getElementById('sn-dryrun-root'))`).catch(() => false);
    if (ready) break;
    await sleep(200);
  }
  ok('页面与面板加载', await ev(`!!(window.SelfNarrativeDryRun && window.RoomChatReader && document.getElementById('sn-dryrun-root'))`));
  ok('临时数据写入成功', await seedTempData());
  ok('面板可打开', await openPanel());
  await ev(`window.confirm = () => true`);

  const s0 = await uiState();
  ok('人工入口独立于 Dry-run', s0.manualBox === true);
  ok('初始没有审核卡片', s0.cards === 0);

  const badId = await importPayload(payload(999999, '先吃饭吧'));
  ok('不存在的 messageId 交互完成', badId);
  const s1 = await uiState();
  ok('错误 messageId 不进入审核区', s1.cards === 0, s1.report);
  ok('错误 messageId 显示明确原因', s1.report.some((t) => t.indexOf('message-not-found') >= 0), s1.report);

  const badQuote = await importPayload(payload(MSG_ID, '她其实很犹豫'));
  ok('错误 quote 交互完成', badQuote);
  const s2 = await uiState();
  ok('错误 quote 不进入审核区', s2.cards === 0, s2.report);
  ok('错误 quote 显示明确原因', s2.report.some((t) => t.indexOf('quote-mismatch') >= 0), s2.report);

  const good = await importPayload(payload(MSG_ID, '先吃饭吧'));
  ok('合法候选交互完成', good);
  const s3 = await uiState();
  ok('合法候选进入审核区', s3.cards === 1, s3);
  ok('卡片标记人工重建来源', s3.tag === true, s3.report);
  ok('卡片显示证据核验结果', s3.verified === true, s3.report);
  ok('人工完成按钮独立且文案正确', s3.manualVisible === true && s3.finishText === '完成人工重建审核', s3);
  ok('AI 完成按钮在人工模式下隐藏', s3.aiVisible === false, s3.aiText);
  ok('未调用 AI 用量', s3.usage === null || s3.usage === undefined, s3.usage);
  const kv1 = await kvState();
  ok('未创建或改动水位', JSON.stringify(kv1.watermark) === JSON.stringify(WATERMARK), kv1);
  ok('未创建正式机自述记录', kv1.narrative === null, kv1);
  ok('完成前正式记录为 0 条', (await narrativeCount()) === 0);

  /* 人工完成审核：部分采纳 + 部分跳过，水位必须保持原值 */
  const multi = await importPayload(payloadList([
    { messageId: MSG_ID, quote: '先吃饭吧' },
    { messageId: MSG_ID, quote: '等你吃完' },
    { messageId: MSG_ID, quote: '先吃饭吧等你吃完' },
  ]));
  ok('三条人工候选导入完成', multi);
  const m1 = await uiState();
  ok('三条候选都进入审核区', m1.cards === 3, m1);
  ok('采纳一条、跳过一条', (await markCard(0, 'adopt')) === 'adopt' && (await markCard(1, 'skip')) === 'skip');
  ok('仍有未审核项时不写入', (await clickManualFinish()) === true && await sleep(400).then(() => uiState()).then((x) => x.done === ''), await uiState());
  ok('未审核时正式记录仍为 0 条', (await narrativeCount()) === 0);
  await markCard(2, 'skip');
  ok('全部决定后可点完成', (await clickManualFinish()) === true);
  const s5 = await waitSettled();
  ok('显示人工审核完成状态', /已完成：采纳 1 条，明确跳过 2 条/.test(s5.done), s5.done);
  ok('完成按钮变为已完成且禁用', s5.finishText === '人工重建审核已完成' && s5.manualDisabled === true, s5);
  ok('完成后卡片控件锁定', s5.locked === true, s5.locked);
  ok('采纳项写入正式记录（1 条）', (await narrativeCount()) === 1);
  const kv3 = await kvState();
  ok('人工完成后水位仍是原值', JSON.stringify(kv3.watermark) === JSON.stringify(WATERMARK), kv3);

  ok('重复点击被拦截', (await clickManualFinish()) === false);
  ok('重复点击不产生重复记录', (await narrativeCount()) === 1);
  const kv4 = await kvState();
  ok('重复点击后水位仍不变', JSON.stringify(kv4.watermark) === JSON.stringify(WATERMARK), kv4);

  await call('Page.reload');
  for (let i = 0; i < 100; i++) {
    const ready = await ev(`!!(window.SelfNarrativeDryRun && document.getElementById('sn-dryrun-root'))`).catch(() => false);
    if (ready) break;
    await sleep(200);
  }
  await openPanel();
  const s4 = await uiState();
  ok('刷新后没有未审核候选自动载入', s4.cards === 0, s4);
  const kv2 = await kvState();
  ok('刷新后水位仍是原值', JSON.stringify(kv2.watermark) === JSON.stringify(WATERMARK), kv2);
  ok('刷新后正式记录仍为 1 条（人工采纳保留）', (await narrativeCount()) === 1);

  const fatal = errors.filter((e) => !/favicon|net::ERR|Failed to fetch|\/api/i.test(e));
  ok('无未捕获异常', fatal.length === 0, fatal.slice(0, 3));
} finally {
  ws.close();
  browser.kill();
  server.close();
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
