/* tests/tools/purge-her-tasks.mjs
 * 一次性清理：删除「星星的今日便签」历史里 from:'her' 的旧任务（双向任务模式遗留）。
 *
 * 只处理 type === 'note-day' 的日记行里 from === 'her' 的任务项；
 * 星星发起的任务、便签留言、归档标记、其他日记/珍藏/聊天一律不动。
 *
 * 用法：
 *   node tests/tools/purge-her-tasks.mjs           # 只报告，不写库
 *   node tests/tools/purge-her-tasks.mjs --apply   # 备份后真正删除
 *
 * 前置：必须完全退出 Edge（Chromium 会锁住 profile，锁着就无法安全写入）。
 * 备份：每次运行都会把命中的 note-day 行原样写到 backups/note-card-her/。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = (process.argv.find((a) => a.startsWith('--profile=')) || '').slice('--profile='.length)
  || ((process.env.LOCALAPPDATA || '') + '\\Microsoft\\Edge\\User Data');
const PORT = 9491;
const APPLY = process.argv.includes('--apply');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const browser = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: 'ignore' });

let ws;
try {
  let info = null;
  for (let i = 0; i < 40 && !info; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) info = await r.json(); } catch { }
    if (!info) await sleep(250);
  }
  if (!info) throw new Error('DevTools 未就绪：请先完全退出 Edge 再运行（profile 被占用时会失败）');

  ws = await new Promise((res, rej) => { const s = new WebSocket(info.webSocketDebuggerUrl); s.onopen = () => res(s); s.onerror = () => rej(new Error('WS 失败')); });
  const pending = new Map();
  let mid = 0, sid = null;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    mid += 1; pending.set(mid, { resolve, reject });
    const p = { id: mid, method, params };
    if (sid && !method.startsWith('Target.')) p.sessionId = sid;
    ws.send(JSON.stringify(p));
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error('超时 ' + method)); } }, 20000);
  });
  const ev = async (expr) => {
    const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  sid = (await call('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  await call('Runtime.enable');
  await call('Page.navigate', { url: 'http://127.0.0.1:8787/migrate' });
  for (let i = 0; i < 60; i++) { if (await ev('document.readyState === "complete"').catch(() => false)) break; await sleep(200); }

  const before = await ev(`(async () => {
    const open = () => new Promise((res, rej) => { const r = indexedDB.open('star_fifi_room'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const db = await open();
    const rows = await new Promise((res) => { const q = db.transaction('diaries').objectStore('diaries').getAll(); q.onsuccess = () => res(q.result || []); });
    db.close();
    const notes = rows.filter((r) => r && r.type === 'note-day');
    const her = [];
    notes.forEach((n) => (n.tasks || []).forEach((t) => { if (t && t.from === 'her') her.push({ date: n.date, id: t.id, text: t.text, status: t.status, createdAt: t.createdAt }); }));
    return { notes: notes.map((n) => ({ date: n.date, id: n.id, tasks: (n.tasks || []).length })), her, raw: notes };
  })()`);

  console.log('便签行：', before.notes.map((n) => n.date + '(' + n.tasks + '件)').join(', ') || '无');
  console.log('from:her 任务：', before.her.length);
  before.her.forEach((t) => console.log('  -', t.date, t.id, JSON.stringify(t.text), t.status, new Date(t.createdAt).toLocaleString('zh-CN')));

  if (!before.her.length) { console.log('\n没有需要清理的记录。'); }
  else {
    const dir = join(ROOT, 'backups', 'note-card-her');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'before-purge-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
    writeFileSync(file, JSON.stringify(before.raw, null, 2), 'utf8');
    console.log('\n已备份命中行 →', file);

    if (!APPLY) {
      console.log('（演练模式）加上 --apply 才会真正写库。');
    } else {
      const out = await ev(`(async () => {
        const open = () => new Promise((res, rej) => { const r = indexedDB.open('star_fifi_room'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        const db = await open();
        const rows = await new Promise((res) => { const q = db.transaction('diaries').objectStore('diaries').getAll(); q.onsuccess = () => res(q.result || []); });
        let removed = 0, touched = 0;
        const keep = [];
        for (const n of rows) {
          if (!n || n.type !== 'note-day' || !Array.isArray(n.tasks)) { keep.push(n); continue; }
          const before = n.tasks.length;
          const next = n.tasks.filter((t) => !(t && t.from === 'her'));
          if (next.length !== before) {
            removed += before - next.length;
            touched += 1;
            n.tasks = next;
            n.updatedAt = Date.now();
          }
          keep.push(n);
        }
        await new Promise((res, rej) => {
          const tx = db.transaction('diaries', 'readwrite');
          const os = tx.objectStore('diaries');
          keep.forEach((n) => os.put(n));
          tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
        });
        db.close();
        return { removed, touched };
      })()`);
      console.log('\n已删除 from:her 任务', out.removed, '条，涉及便签', out.touched, '天');
    }
  }
} finally {
  try { ws && ws.close(); } catch { }
  try { browser.kill(); } catch { }
}
