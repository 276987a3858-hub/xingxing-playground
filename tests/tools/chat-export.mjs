import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const SRC = process.argv[2];
const OUT = process.argv[3];
const URL_ = process.argv[4] || 'http://127.0.0.1:8787/';
const PORT = 9499;
const prof = path.join(tmpdir(), 'xh-backup-' + Date.now());
const idbDir = path.join(prof, 'Default', 'IndexedDB');
fs.mkdirSync(idbDir, { recursive: true });
fs.cpSync(SRC, path.join(idbDir, path.basename(SRC)), {
  recursive: true,
  filter: (s) => !s.endsWith('LOCK') && !s.endsWith('LOG'),
});
const blobDir = SRC.replace(/\.indexeddb\.leveldb$/, '.indexeddb.blob');
if (fs.existsSync(blobDir) && !process.env.SKIP_BLOB) {
  fs.cpSync(blobDir, path.join(idbDir, path.basename(blobDir)), { recursive: true });
}

console.log('[stage] profile ready');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const browser = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + prof, '--no-first-run', '--no-default-browser-check'], { stdio: 'ignore' });

let ws;
try {
  console.log('[stage] edge spawned');
  let info = null;
  for (let i = 0; i < 60 && !info; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) info = await r.json(); } catch { }
    if (!info) await sleep(250);
  }
  if (!info) throw new Error('CDP 未就绪');
  ws = await new Promise((res, rej) => { const s = new WebSocket(info.webSocketDebuggerUrl); s.onopen = () => res(s); s.onerror = rej; });
  const pending = new Map(); let id = 0, sid = null;
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
  const call = (method, params = {}) => new Promise((res, rej) => {
    id++; pending.set(id, { res, rej });
    const p = { id, method, params }; if (sid) p.sessionId = sid;
    ws.send(JSON.stringify(p));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 25000);
  });
  const ev = async (x) => {
    const r = await call('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception?.description || ''));
    return r.result.value;
  };
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  sid = (await call('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  await call('Page.enable'); await call('Runtime.enable');
  console.log('[stage] navigate');
  await call('Page.navigate', { url: URL_ });
  for (let i = 0; i < 80; i++) {
    const ready = await ev(`document.readyState === 'complete'`).catch(() => false);
    if (ready) break;
    await sleep(250);
  }
  await sleep(1500);
  const origin = await ev(`location.origin`);
  console.log('[stage] dumping');
  const dump = await ev(`(async function(){
    const names = (indexedDB.databases ? await indexedDB.databases() : []).map(d=>d.name);
    const open = (name) => new Promise((res,rej)=>{const q=indexedDB.open(name);q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error);});
    const out = {origin: location.origin, dbs: {}, dbNames: names};
    for (const dbName of names) {
      const db = await open(dbName);
      const stores = Array.from(db.objectStoreNames);
      const data = {};
      for (const s of stores) {
        data[s] = await new Promise((res,rej)=>{const tx=db.transaction(s,'readonly');const rq=tx.objectStore(s).getAll();rq.onsuccess=()=>res(rq.result);rq.onerror=()=>rej(rq.error);});
      }
      const kv = {};
      if (stores.includes('kv')) {
        await new Promise((res,rej)=>{
          const tx = db.transaction('kv','readonly'), rq = tx.objectStore('kv').openCursor();
          rq.onsuccess = () => { const c = rq.result; if (!c) return res(); kv[String(c.key)] = c.value; c.continue(); };
          rq.onerror = () => rej(rq.error);
        });
      }
      out.dbs[dbName] = {version: db.version, stores: data, kv};
      db.close();
    }
    return out;
  })()`);
  const db = dump.dbs['star_fifi_room'];
  const exportObj = {
    messages: db?.stores?.messages || [],
    diaries: db?.stores?.diaries || [],
    starDiaries: db?.stores?.starDiaries || [],
    keeps: db?.stores?.keeps || [],
    futureLetters: db?.stores?.futureLetters || [],
    settings: db?.kv?.settings ?? null,
    longTermMemory: typeof db?.kv?.longTermMemory === 'string' ? db.kv.longTermMemory : '',
    exportedAt: Date.now(),
  };
  if (Array.isArray(exportObj.messages)) exportObj.messages = exportObj.messages.map((r) => { const c = { ...r }; delete c.audioData; return c; });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(exportObj, null, 2));
  const raw = OUT.replace(/\.json$/, '.raw.json');
  fs.writeFileSync(raw, JSON.stringify(dump, null, 2));
  console.log(JSON.stringify({
    origin, dbNames: dump.dbNames,
    counts: Object.fromEntries(Object.entries(exportObj).filter(([k, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length])),
    kvKeys: Object.keys(db?.kv || {}),
    bytes: fs.statSync(OUT).size,
  }, null, 1));
} catch (e) {
  console.log('ERR', e.message);
  process.exitCode = 1;
} finally {
  try { ws && ws.close(); } catch { }
  browser.kill();
  await sleep(500);
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch { }
}
