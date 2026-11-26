/* tests/shared/backup-io-browser.mjs — 迁移 v2 IO 层真实浏览器验收
 * 自建静态服务（public/ + /__test/ → tests/fixtures/），随机 profile，库名带 _t 后缀，
 * 全程不碰 127.0.0.1:8787 的真实数据，不调用 /api。
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
const FIXTURES = join(ROOT, 'tests', 'fixtures');
const PORT = 8791;
const CDP = 9411;
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
    const base = p.startsWith('/__test/') ? FIXTURES : PUBLIC;
    const rel = p.startsWith('/__test/') ? p.slice('/__test/'.length) : p.slice(1);
    const file = normalize(join(base, rel));
    if (!file.startsWith(base)) { res.writeHead(403).end('no'); return; }
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

const PROFILE = mkdtempSync(join(tmpdir(), 'mig-io-'));
const browser = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--disable-features=Translate', 'about:blank'], { stdio: 'ignore' });

let ws, mid = 0, sid = null;
const pending = new Map();
const errors = [];
const call = (method, params = {}) => new Promise((res, rej) => {
  const id = ++mid;
  pending.set(id, { res, rej });
  const msg = { id, method, params };
  if (sid) msg.sessionId = sid;
  ws.send(JSON.stringify(msg));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 120000);
});

for (let i = 0; i < 60; i++) {
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
const eq = (name, a, b) => ok(name, a === b, { actual: a, expect: b });

async function run(step) {
  const out = await ev(`T.${step}()`);
  if (out && out.__err) throw new Error(step + ': ' + out.__err);
  return out;
}

// 载入页面与测试场景
await call('Page.navigate', { url: BASE + '/migrate.html' });
for (let i = 0; i < 60; i++) {
  const ready = await ev(`!!(window.BackupIO && window.BackupFormat) && document.readyState === 'complete'`).catch(() => false);
  if (ready) break;
  await sleep(200);
}
await ev(`(function(){var s=document.createElement('script');s.src='/__test/migrate-scenarios.js';document.body.appendChild(s);return true;})()`);
for (let i = 0; i < 60; i++) {
  if (await ev('!!window.T').catch(() => false)) break;
  await sleep(150);
}
if (!(await ev('!!window.T'))) { console.log('场景脚本未加载'); process.exit(1); }

console.log('\n[1] 源数据采集');
const s1 = await run('step1');
eq('消息 3 条', s1.counts.room.messages, 3);
eq('珍藏/日记/星星日记/未来信各 1 条', s1.counts.room.keeps + s1.counts.room.diaries + s1.counts.room.starDiaries + s1.counts.room.futureLetters, 4);
eq('管家待办 2 条', s1.counts.butler.tasks, 2);
eq('管家账单 1 条', s1.counts.butler.transactions, 1);
eq('声音素材 2 段', s1.counts.radioVoice, 2);
eq('本地状态只取白名单 2 项', s1.counts.localStorage, 2);
eq('附件 7 个（图片 2 + 语音 1 + 照片 2 + 壁纸 1 + 素材 2）', s1.counts.attachments, 7);
eq('采集无异常', s1.problems.length, 0);
ok('草稿被显式排除', s1.excluded.includes('pending_chat_message'), s1.excluded);

console.log('\n[2] 导出与回读校验');
const s2 = await run('step2');
ok('导出成功', s2.ok === true, s2);
eq('回读校验通过', s2.recheck, true);
eq('附件数 7', s2.attachments, 7);
eq('附件真实字节 36', s2.attachmentBytes, 36);
ok('未导出 API Key', s2.hasApiKey === false);
ok('未导出草稿', s2.hasDraft === false);
ok('未导出非白名单键', s2.hasForeignKey === false);
ok('文件 SHA-256 为 64 位', /^[0-9a-f]{64}$/.test(s2.sha256), s2.sha256);
ok('文件体积 > 1KB', s2.size > 1024, s2.size);

console.log('\n[3] 篡改必须被发现');
const s3 = await run('step3');
ok('改正文 → 失败', s3.contentTamper.ok === false, s3.contentTamper);
eq('改正文的错误原因', s3.contentTamper.reason, 'payload-hash-mismatch');
ok('改音频 base64 → 失败', s3.audioTamper.ok === false, s3.audioTamper);
ok('结构不完整 → 失败', s3.brokenShape.ok === false, s3.brokenShape);

console.log('\n[4] 计划：合并 / 替换 / 跳过');
const s4 = await run('step4');
eq('合并模式预计新增 15 条/项', s4.merge.insert, 15);
eq('合并模式跳过 0', s4.merge.skip, 0);
eq('合并模式冲突 0', s4.merge.conflict, 0);
eq('替换模式会清空', s4.replace.willClear, true);
eq('替换模式同样写 15 条/项', s4.replace.insert, 15);
eq('目标机消息为 0', s4.target.room.messages, 0);
eq('备份消息 3 条', s4.backup.room.messages, 3);
eq('计划哈希稳定', s4.planHashStable, true);
eq('本地状态写入 2 项', s4.localStorageKeys.length, 2);
ok('草稿不在计划里', s4.hasDraftKey === false);

console.log('\n[5] 导入空库并核对内容');
const s5 = await run('step5');
ok('导入成功', s5.ok === true, s5);
ok('四个阶段全部完成', s5.stages.every((x) => x.endsWith(':done')), s5.stages);
eq('消息 3 条', s5.counts.room.messages, 3);
eq('珍藏 1 条', s5.counts.room.keeps, 1);
eq('日记 1 条', s5.counts.room.diaries, 1);
eq('未来信 1 条', s5.counts.room.futureLetters, 1);
eq('待办 2 条', s5.counts.butler.tasks, 2);
eq('账单 1 条', s5.counts.butler.transactions, 1);
eq('管家 meta 只有 1 条业务数据（标记另算）', s5.counts.butler.meta, 1);
eq('管家提交标记已写入', s5.counts.butler.marker, 1);
eq('声音素材 2 段', s5.counts.clips, 2);
ok('聊天图片保留', s5.image && s5.image.startsWith('data:image/png'), s5.image);
ok('聊天语音保留', s5.audio && s5.audio.startsWith('data:audio/webm'), s5.audio);
eq('英文翻译保留', s5.english, 'Good night.');
ok('沉默标记保留', s5.silent && s5.silent.silent === true && s5.silent.reason === '有点累，但不想说。', s5.silent);
eq('珍藏引用消息 id', s5.keepRef, 2);
ok('珍藏照片保留', s5.keepPhoto && s5.keepPhoto.startsWith('data:image/jpeg'));
eq('日记引用消息 id', s5.diaryRef, 2);
eq('未来信引用消息 id', s5.letterRef, 2);
ok('未来信照片保留', s5.letterPhoto && s5.letterPhoto.startsWith('data:image/png'));
eq('设置里的字号', s5.settings && s5.settings.fontSize, '16');
ok('壁纸保留', s5.settings && s5.settings.wallpaper.startsWith('data:image/jpeg'));
eq('长期记忆保留', s5.memory, '她喜欢雨声。');
ok('库内提交标记 stage=room', s5.marker && s5.marker.stage === 'room', s5.marker);
ok('恢复日志标记完成', s5.journalDone === true);
const c1 = s5.clips.find((c) => c.id === 'c1');
const c2 = s5.clips.find((c) => c.id === 'c2');
ok('素材 1 落地为 Blob', c1 && c1.isBlob && c1.type === 'audio/mpeg', c1);
eq('素材 1 字节数', c1 && c1.size, 3);
ok('素材 1 字节内容一致', JSON.stringify(c1 && c1.bytes) === '[1,2,3]', c1 && c1.bytes);
eq('素材 2 字节数', c2 && c2.size, 5);
eq('素材用途保留', c1 && c1.use, 'sleep');
eq('本地状态已恢复', s5.ls.vocab, '["rain"]');
eq('非白名单键没被写入', s5.ls.foreign, 'x');
eq('草稿没被写入', s5.ls.draft, '还没发出去的草稿');

console.log('\n[6] 重复导入');
const s6 = await run('step6');
eq('重复导入预计新增 0', s6.summary.insert, 0);
eq('重复导入全部跳过 15', s6.summary.skip, 15);
eq('重复导入后消息数不变', s6.after.room.messages, s6.before.room.messages);
eq('重复导入后素材数不变', s6.after.clips, s6.before.clips);
eq('重复导入后待办数不变', s6.after.butler.tasks, s6.before.butler.tasks);

console.log('\n[7] 冲突合并与引用改写');
const s7 = await run('step7');
ok('冲突导入成功', s7.ok === true, s7);
eq('冲突 1 条', s7.conflictCount, 1);
eq('手机原记录未被覆盖', s7.oldKept, '手机上原来就有的第二条');
ok('备份里的那条换了新 id', typeof s7.movedId === 'number' && s7.movedId > 3, s7.movedId);
eq('换 id 后图片仍在', s7.movedImage && s7.movedImage.startsWith('data:image/png'), true);
eq('珍藏引用跟着改写到新 id', s7.keepRefPointsToMoved, true);

console.log('\n[8] 坏附件必须阻断');
const s8 = await run('step8');
ok('声明字节数不符 → 拒绝', s8.bytesMismatch.ok === false && /^attachment-/.test(s8.bytesMismatch.reason), s8.bytesMismatch);
ok('字节与声明哈希不符 → 拒绝', s8.hashMismatch.ok === false && s8.hashMismatch.reason === 'attachment-broken', s8.hashMismatch);
ok('缺附件 → 拒绝', s8.missing.ok === false && s8.missing.reason === 'attachment-missing', s8.missing);
ok('坏文件进不到写入阶段', String(s8.planAttempt).startsWith('blocked'), s8.planAttempt);
eq('目标库一条没动', s8.countsUnchanged, true);

console.log('\n[9] 中断与续传');
const s9 = await run('step9');
eq('第一轮在 room 后停下', s9.paused, true);
eq('停在 room', s9.pausedAt, 'room');
eq('此时消息已写入', s9.mid.room.messages, 3);
eq('此时素材还没写', s9.mid.clips, 0);
eq('库内标记 stage=room', s9.markerStage, 'room');
ok('换一份备份续传被拒绝', s9.refused.ok === false && s9.refused.reason === 'backup-mismatch', s9.refused);
ok('同一份备份续传成功', s9.resumedOk === true, s9);
ok('room 阶段要么按日志跳过、要么幂等重跑', /room:(skipped-committed|done)/.test(s9.resumedStages.join(',')), s9.resumedStages);
eq('续传后消息仍是 3 条（没有重复插入）', s9.messageCount, 3);
eq('续传后消息 id 无重复', s9.uniqueIds, 3);
eq('续传后素材补齐', s9.after.clips, 2);
eq('续传后待办补齐', s9.after.butler.tasks, 2);
eq('续传后日志标记完成', s9.journalDone, true);

console.log('\n[10] 撤销本次导入');
const s10 = await run('step10');
ok('撤销成功', s10.ok === true);
ok('写入记录被删除', s10.removed > 0, s10.removed);
eq('撤销后消息为 0', s10.after.room.messages, 0);
eq('撤销后素材为 0', s10.after.clips, 0);
eq('撤销后待办为 0', s10.after.butler.tasks, 0);
eq('撤销后日志清空', s10.journal, null);

console.log('\n[11] 导入真实库名 + 主页渲染');
const s11 = await run('step11');
ok('导入真实库成功', s11.ok === true, s11);
eq('真实库消息 3 条', s11.counts.room.messages, 3);
eq('真实库素材 2 段', s11.counts.clips, 2);
eq('真实库设置已写入', s11.settings && s11.settings.fontSize, '16');

await call('Page.navigate', { url: BASE + '/' });
await sleep(3000);
const dom = await ev(`(function(){
  var box = document.getElementById('messages');
  return {
    bubbles: box ? box.querySelectorAll('.message, .bubble').length : -1,
    silent: document.querySelectorAll('.silent-bubble').length,
    hasNight: document.body.innerText.indexOf('晚安，用户。') !== -1,
    bg: document.body.style.backgroundImage.indexOf('data:image/jpeg') !== -1
  };
})()`);
ok('主页渲染出消息', dom.bubbles >= 3, dom.bubbles);
ok('沉默气泡渲染正常', dom.silent >= 1, dom.silent);
ok('聊天正文可见', dom.hasNight === true);
ok('壁纸已应用', dom.bg === true, dom.bg);


console.log('\n[12] 迁移页 UI 全流程');
await call('Page.setDownloadBehavior', { behavior: 'deny' }).catch(() => { });
await call('Page.navigate', { url: BASE + '/migrate.html' });
for (let i = 0; i < 60; i++) {
  if (await ev(`!!window.BackupIO && document.readyState === 'complete'`).catch(() => false)) break;
  await sleep(200);
}
await sleep(1200);
const uiStats = await ev(`document.getElementById('exportStats').innerText`);
ok('统计卡显示聊天消息', /聊天消息/.test(uiStats), uiStats.slice(0, 60));
ok('统计卡显示声音素材', /声音素材/.test(uiStats));

// 先在页面里生成一份可注入的小备份（不下载），再走按钮流程
await ev(`(async()=>{const r=await BackupIO.exportAll({download:false});window.__uiText=r.text;return !!r.ok})()`);
await ev(`document.getElementById('btnExport').click()`);
let expTxt = '';
for (let i = 0; i < 80; i++) {
  expTxt = await ev(`document.getElementById('exportOut').innerText`);
  if (/备份已生成/.test(expTxt)) break;
  await sleep(250);
}
ok('导出按钮产出并自检通过', /备份已生成并通过回读校验/.test(expTxt), expTxt.slice(0, 120));
ok('导出台显示 SHA-256', /SHA-256/.test(expTxt));

await ev(`(function(){
  var dt = new DataTransfer();
  dt.items.add(new File([window.__uiText], 'backup.json', {type:'application/json'}));
  var inp = document.getElementById('fileIn');
  inp.files = dt.files;
  inp.dispatchEvent(new Event('change'));
  return true;
})()`);
let fileTxt = '';
for (let i = 0; i < 80; i++) {
  fileTxt = await ev(`document.getElementById('fileOut').innerText`);
  if (/文件完整/.test(fileTxt)) break;
  await sleep(250);
}
ok('选文件后显示校验通过', /文件完整，校验通过/.test(fileTxt), fileTxt.slice(0, 120));
ok('显示备份消息数', /聊天消息/.test(fileTxt));

await ev(`document.getElementById('btnPlan').click()`);
let planTxt = '';
for (let i = 0; i < 80; i++) {
  planTxt = await ev(`document.getElementById('planOut').innerText`);
  if (/预计新增/.test(planTxt)) break;
  await sleep(250);
}
ok('预览显示预计新增', /预计新增/.test(planTxt), planTxt.slice(0, 120));
ok('预览显示计划哈希', /计划哈希/.test(planTxt));

await ev(`document.getElementById('btnSnapshot').click()`);
let snapTxt = '';
for (let i = 0; i < 80; i++) {
  snapTxt = await ev(`document.getElementById('snapOut').innerText`);
  if (/快照已生成/.test(snapTxt)) break;
  await sleep(250);
}
ok('快照生成并校验通过', /手机快照已生成并通过回读校验/.test(snapTxt), snapTxt.slice(0, 120));

await ev(`(function(){
  var c = document.getElementById('snapOk');
  c.checked = true;
  c.dispatchEvent(new Event('change'));
  return !document.getElementById('btnImport').disabled;
})()`);
const importEnabled = await ev(`!document.getElementById('btnImport').disabled`);
ok('确认快照后才允许导入', importEnabled === true);

await ev(`document.getElementById('btnImport').click()`);
let impTxt = '';
for (let i = 0; i < 200; i++) {
  impTxt = await ev(`document.getElementById('importOut').innerText`);
  if (/导入完成|已中止|导入中断/.test(impTxt)) break;
  await sleep(250);
}
ok('UI 导入走到完成', /导入完成/.test(impTxt), impTxt.slice(0, 160));
ok('UI 结果展示跳过数量', /跳过/.test(impTxt));

const fatal = errors.filter((e) => !/favicon|net::ERR|Failed to fetch|\/api/i.test(e));
ok('无未捕获异常', fatal.length === 0, fatal.slice(0, 3));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close();
browser.kill();
server.close();
process.exit(fail === 0 ? 0 : 1);
