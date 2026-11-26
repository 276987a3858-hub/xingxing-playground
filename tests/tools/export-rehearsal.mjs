/* tests/tools/export-rehearsal.mjs — 真实数据导出演练（只读，不下载、不写真实 profile）
 * 用法：node tests/tools/export-rehearsal.mjs [源profile/Default目录]
 * 做法：把 127.0.0.1:8787 的 IndexedDB + localStorage 复制到临时 profile，
 *       在该 profile 里打开迁移页，跑一次 exportAll({download:false})，
 *       报告真实文件大小、记录数、附件字节、自检结果与耗时。真实数据与 profile 都不改动。
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const SRC = process.argv[2] || ((process.env.LOCALAPPDATA || '') + '\\Microsoft\\Edge\\User Data\\Default');
const PORT = 9422;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const URL_ = process.env.MIGRATE_URL || 'http://127.0.0.1:8787/migrate';
const prof = mkdtempSync(join(tmpdir(), 'mig-rehearsal-'));
const destDefault = join(prof, 'Default');
const idbDest = join(destDefault, 'IndexedDB');
cpSync(join(SRC, 'IndexedDB'), idbDest, {
  recursive: true,
  filter: (s) => !/[\\/](LOCK|LOG)$/.test(s) && (s.includes('127.0.0.1_8787') || !s.includes('indexeddb')),
});
if (existsSync(join(SRC, 'Local Storage'))) {
  cpSync(join(SRC, 'Local Storage'), join(destDefault, 'Local Storage'), { recursive: true, filter: (s) => !/[\\/](LOCK|LOG)$/.test(s) });
}
console.log('[stage] profile copied →', prof);

const browser = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`,
  '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });

let ws, mid = 0, sid = null;
const pending = new Map();
const call = (method, params = {}) => new Promise((res, rej) => {
  const id = ++mid;
  pending.set(id, { res, rej });
  const m = { id, method, params };
  if (sid) m.sessionId = sid;
  ws.send(JSON.stringify(m));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 300000);
});

try {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch { }
    await sleep(250);
  }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
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
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  sid = (await call('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  await call('Runtime.enable');
  await call('Page.navigate', { url: URL_ });
  for (let i = 0; i < 100; i++) {
    if (await ev(`!!window.BackupIO && document.readyState === 'complete'`).catch(() => false)) break;
    await sleep(250);
  }
  const started = Date.now();
  const out = await ev(`(async function(){
    const t0 = Date.now();
    const r = await BackupIO.exportAll({ download: false, label: '演练' });
    if (!r.ok) return { ok: false, reason: r.reason, detail: r.detail, problems: r.problems };
    const verifyMs = Date.now() - t0;
    return {
      ok: true, size: r.size, sha: r.sha256, counts: r.counts,
      attachments: r.report.totalCount, attachmentBytes: r.report.totalBytes,
      byKind: r.report.byKind, warn: r.warn, ms: Date.now() - t0, verifyMs,
      mb: Math.round(r.size / 1048576 * 10) / 10,
    };
  })()`);
  const total = Date.now() - started;
  console.log(JSON.stringify(out, null, 2));
  console.log('[stage] 总耗时 ' + (total / 1000).toFixed(1) + ' 秒');
} catch (e) {
  console.error('[error]', e.message);
  process.exitCode = 1;
} finally {
  try { ws.close(); } catch { }
  browser.kill();
  try { rmSync(prof, { recursive: true, force: true }); } catch { }
}
