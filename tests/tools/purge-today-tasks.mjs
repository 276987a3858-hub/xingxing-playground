/* tests/tools/purge-today-tasks.mjs
 * 一次性清理：清空「今日便签」的全部任务（含 from:'star' 与 from:'her'）。
 *
 * 只处理 date === 今天 且 type === 'note-day' 的那一行：
 *   - 把 tasks 置为 []
 *   - message / 天气 / aiAt / createdAt / archivedAt / id 等其余字段原样保留
 *   - 历史便签、日记、珍藏、邮局、聊天一律不碰
 *
 * 前置：必须完全退出 Edge（profile 被占用时 headless 起不来）。
 * 备份：写库之前把命中的整行原样写到 backups/note-today/，备份成功才写库。
 *
 * 用法：
 *   node tests/tools/purge-today-tasks.mjs             # 只报告，不写库
 *   node tests/tools/purge-today-tasks.mjs --apply     # 备份后真正清空
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = (process.argv.find((a) => a.startsWith('--profile=')) || '').slice('--profile='.length)
  || ((process.env.LOCALAPPDATA || '') + '\\Microsoft\\Edge\\User Data');
const PORT = 9493;
const APPLY = process.argv.includes('--apply');
const DAY = (process.argv.find((a) => a.startsWith('--day=')) || '').slice('--day='.length)
  || new Date().toLocaleDateString('sv-SE');
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

  ws = await new Promise((res, rej) => { const s = new WebSocket(info.webSocketDebuggerUrl); s.onopen = () => res(s); s.onerror = rej; });
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
    const all = rows.filter((r) => r && r.type === 'note-day');
    const hit = all.filter((r) => r.date === ${JSON.stringify(DAY)});
    return {
      allDates: all.map((n) => n.date),
      hit: hit.map((n) => ({ id: n.id, date: n.date, taskCount: (n.tasks || []).length,
        tasks: (n.tasks || []).map((t) => ({ from: t.from, text: t.text })),
        message: n.message && n.message.text, messageSource: n.message && n.message.source })),
      raw: hit,
    };
  })()`);

  console.log('全部便签日期：', before.allDates.join(', ') || '无');
  console.log('命中', JSON.stringify(DAY), '的便签行数：', before.hit.length);
  before.hit.forEach((n) => {
    console.log('  id', n.id, '任务', n.taskCount, '条：');
    n.tasks.forEach((t) => console.log('    -', JSON.stringify(t.from), JSON.stringify(t.text)));
    console.log('  留言：', JSON.stringify(n.message), '来源', n.messageSource);
  });

  if (!before.hit.length) { console.log('\n没有需要清理的记录。'); }
  else {
    const dir = join(ROOT, 'backups', 'note-today');
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
          if (!n || n.type !== 'note-day' || n.date !== ${JSON.stringify(DAY)} || !Array.isArray(n.tasks)) { keep.push(n); continue; }
          const before = n.tasks.length;
          if (before > 0) {
            removed += before;
            touched += 1;
            n.tasks = [];
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
      console.log('\n已清空任务', out.removed, '条，涉及便签', out.touched, '天');

      // 回读校验：确认 tasks 已空、message 与其余字段未变
      const after = await ev(`(async () => {
        const open = () => new Promise((res, rej) => { const r = indexedDB.open('star_fifi_room'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        const db = await open();
        const rows = await new Promise((res) => { const q = db.transaction('diaries').objectStore('diaries').getAll(); q.onsuccess = () => res(q.result || []); });
        db.close();
        const hit = rows.filter((r) => r && r.type === 'note-day' && r.date === ${JSON.stringify(DAY)});
        return hit.map((n) => ({ id: n.id, date: n.date, tasks: (n.tasks || []).length,
          message: n.message && n.message.text, messageSource: n.message && n.message.source }));
      })()`);
      console.log('回读结果：', JSON.stringify(after));
      const ok = after.length === 1 && after[0].tasks === 0
        && after[0].message === before.hit[0].message && after[0].messageSource === before.hit[0].messageSource;
      console.log(ok ? '校验通过：任务已清空，留言与来源未变' : '校验失败：请检查备份并人工核对');
      if (!ok) process.exitCode = 2;
    }
  }
} finally {
  try { ws && ws.close(); } catch { }
  try { browser.kill(); } catch { }
}
