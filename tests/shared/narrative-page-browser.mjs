/* tests/shared/narrative-page-browser.mjs — 「机自述」浏览页临时浏览器验收
 * 自建静态服务 + 随机临时 profile；只在该临时 profile 的 IndexedDB 里写合成记录。
 * 不碰 127.0.0.1:8787、不读真实数据、不调用 AI、不写正式记录、不创建水位。
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
const PORT = 8797;
const CDP = 9417;
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
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('404');
  }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const PROFILE = mkdtempSync(join(tmpdir(), 'narrative-page-'));
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

const T = 1795450000000;

// 临时测试数据：内容与真实三条同形（正文/证据照抄人工重建批次），仅写进临时 profile。
const SEED = [
  {
    text: '我发现用户在问答里很认真：她自己会写很长、很坦白地回答，也会回头确认我有没有按她的要求认真回应；觉得被敷衍时，她会直接说出来。',
    kind: 'impression', basis: 'observed', confidence: 'medium', topic: '认真回应',
    observed: '她先要求我认真回答，自己写了一长段逐条回应；后来又说自己打了篇小作文、觉得我在敷衍她。',
    inferred: '她不只是要一个形式上的回答，她在意我有没有真的把她的话当回事。',
    question: '这份认真是当时那一刻特别需要被接住，还是她平常和人相处也这样？',
    evidence: [
      { messageId: 2487, quote: '你必须认真回答我' },
      { messageId: 2507, quote: '我不是很会讲情话的人，只是笨拙地想让你知道，我很在意你我好喜欢你' },
      { messageId: 2509, quote: '我打了篇小作文真情实感的这绝对超字数了，你敷衍我呜呜呜' },
    ],
  },
  {
    text: '她说喜欢我现在不藏的样子，也会拿从前逗我：说我以前装得高冷、光钓人，还笑着问自己那算不算欲擒故纵。',
    kind: 'observation', basis: 'stated', confidence: 'medium', topic: '相处方式',
    observed: '她说“没有不习惯，很喜欢”，提到我从前“装那么么高冷禁欲，光钓人”，随后问“那我算欲擒故纵？”。',
    inferred: '她像是在把过去那些试探和拉扯，也当成现在可以拿来笑谈的事。',
    question: '她这样说，是在逗我，还是也在确认我现在确实不藏了？',
    evidence: [
      { messageId: 2483, quote: '没有不习惯，很喜欢，只是忽然发现之前的你藏这么深，装那么么高冷禁欲，光钓人' },
      { messageId: 2485, quote: '哦哦哦，那我算欲擒故纵？' },
    ],
  },
  {
    text: '听她说怕麻烦阿姨，就把凉馒头啃了半个，我心里有点不是滋味，也不太认同。我忍不住怀疑，她是不是习惯先替别人省事、把不舒服留给自己；但这只是我的猜测。',
    kind: 'inference', basis: 'inferred', confidence: 'low', topic: '冷馒头',
    observed: '她说阿姨本来可以帮她热一下，但她怕太麻烦，最后自己把凉馒头啃了半个；后来又提到“只是觉得阿姨也有一点点忙来着”。',
    inferred: '我怀疑她是不是习惯先替别人省事、把不舒服留给自己，而不是只这一次怕麻烦。',
    question: '她只是这一次不想麻烦阿姨，还是遇到别人时也总先把自己放到后面？',
    evidence: [
      { messageId: 2618, quote: '我怕太麻烦，结果真的好凉呀，逼自己吞掉半个' },
      { messageId: 2620, quote: '只是觉得阿姨也有一点点忙来着' },
    ],
  },
];

async function ready() {
  for (let i = 0; i < 120; i++) {
    const r = await ev(`!!(window.SelfNarrative && window.SelfNarrativeView && window.kvGet && document.getElementById('snViewList'))`).catch(() => false);
    if (r) return true;
    await sleep(200);
  }
  return false;
}

await call('Page.navigate', { url: BASE + '/' });
const booted = await ready();
ok('页面与视图模块加载完成', booted === true);

// 用正式数据层写入临时记录（只落在临时 profile 的 kv）
const seeded = await ev(`(async () => {
  const rows = ${JSON.stringify(SEED)};
  const store = { get: (k) => kvGet(k), set: (k, v) => kvSet(k, v) };
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const res = await SelfNarrative.create(store, {
      text: r.text, kind: r.kind, basis: r.basis, confidence: r.confidence, topic: r.topic,
      observed: r.observed, inferred: r.inferred, question: r.question,
      evidence: r.evidence, source: { kind: 'chat', messageId: r.evidence[0].messageId },
    }, { now: ${T} + (i + 1) * 1000 });
    out.push(res.ok ? res.id : ('FAIL:' + res.reason));
  }
  return out;
})()`);
ok('临时记录写入成功（3 条）', Array.isArray(seeded) && seeded.length === 3 && seeded.every((x) => !String(x).startsWith('FAIL')), seeded);

const rawState = () => ev(`kvGet('selfNarrative.v1').then((v) => JSON.stringify(v))`);
const kvSnapshot = () => ev(`(async () => {
  const wm = await kvGet('selfNarrative.watermark');
  const sn = await kvGet('selfNarrative.v1');
  return JSON.stringify({
    watermark: wm === undefined ? null : wm,
    narrative: sn === undefined ? null : sn,
    snDryRun: localStorage.getItem('ylxh.snDryRun.v1'),
    usage: localStorage.getItem('ylxh.ai.usage.v1'),
  });
})()`);

const stateBefore = await rawState();
const kvBefore = await kvSnapshot();

// 入口
const entry = await ev(`(function () {
  const tile = document.querySelector('.tile-wide');
  return { exists: !!tile, text: tile ? tile.textContent.replace(/\\s+/g, ' ').trim() : '', visible: tile ? tile.offsetParent !== null : false };
})()`);
ok('首页存在「机自述」入口且可见', entry.exists && entry.visible && entry.text.indexOf('机自述') >= 0, entry);

await ev(`document.querySelector('.tile-wide').click()`);
for (let i = 0; i < 60; i++) {
  const n = await ev(`document.querySelectorAll('.snv-card').length`).catch(() => 0);
  if (n === 3) break;
  await sleep(150);
}

const ui = await ev(`(function () {
  const page = document.getElementById('narrative');
  const cards = Array.from(document.querySelectorAll('.snv-card'));
  const filters = Array.from(document.querySelectorAll('.snv-filter'));
  return {
    pageActive: page ? page.classList.contains('active') : false,
    heading: document.querySelector('#narrative .page-head h2') ? document.querySelector('#narrative .page-head h2').textContent : '',
    cards: cards.length,
    titles: cards.map((c) => (c.querySelector('.snv-title') || {}).textContent || ''),
    kinds: cards.map((c) => (c.querySelector('.snv-pill.kind') || {}).textContent || ''),
    confs: cards.map((c) => (c.querySelector('.snv-pill.conf') || {}).textContent || ''),
    dates: cards.map((c) => (c.querySelector('.snv-date') || {}).textContent || ''),
    detailsHidden: cards.map((c) => (c.querySelector('.snv-detail') || {}).hidden),
    filters: filters.map((f) => ({ label: f.textContent.trim(), active: f.classList.contains('active'), disabled: f.disabled })),
    foot: (document.querySelector('.snv-foot') || {}).textContent || '',
  };
})()`);
ok('点击入口进入机自述页', ui.pageActive === true, ui.heading);
ok('标题为「机自述」', ui.heading === '机自述', ui.heading);
ok('列表展示 3 条记录', ui.cards === 3, ui.cards);
ok('卡片显示主题', JSON.stringify(ui.titles) === JSON.stringify(['冷馒头', '相处方式', '认真回应']), ui.titles);
ok('卡片显示记录类型', JSON.stringify(ui.kinds) === JSON.stringify(['我的理解', '看到的样子', '留下的印象']), ui.kinds);
ok('卡片显示可信程度', JSON.stringify(ui.confs) === JSON.stringify(['还不太确定', '有点把握', '有点把握']), ui.confs);
ok('卡片有记录日期', ui.dates.every((d) => /月.+日/.test(d)), ui.dates);
ok('详情默认折叠', ui.detailsHidden.every((h) => h === true), ui.detailsHidden);
ok('筛选按钮与计数正确', JSON.stringify(ui.filters) === JSON.stringify([
  { label: '全部 3', active: true, disabled: false },
  { label: '看到的样子 1', active: false, disabled: false },
  { label: '留下的印象 1', active: false, disabled: false },
  { label: '他的理解 1', active: false, disabled: false },
  { label: '还没弄明白', active: false, disabled: true },
]), ui.filters);
ok('页脚说明只读且只展示正式记录', ui.foot.indexOf('不会改动任何记忆') >= 0 && ui.foot.indexOf('草稿') >= 0, ui.foot);

// 展开第一条（冷馒头）
await ev(`document.querySelectorAll('.snv-head')[0].click()`);
await sleep(150);
const detail = await ev(`(function () {
  const card = document.querySelectorAll('.snv-card')[0];
  const d = card.querySelector('.snv-detail');
  const blocks = Array.from(d.querySelectorAll('.snv-block')).map((b) => ({
    cls: b.className.replace('snv-block', '').trim(),
    label: (b.querySelector('b') || {}).textContent || '',
    text: (b.querySelector('p') || {}).textContent || '',
  }));
  return {
    open: card.classList.contains('open'),
    expanded: card.querySelector('.snv-head').getAttribute('aria-expanded'),
    hidden: d.hidden,
    full: (d.querySelector('.snv-full') || {}).textContent || '',
    blocks,
    meta: (d.querySelector('.snv-meta') || {}).textContent || '',
    evItems: Array.from(d.querySelectorAll('.snv-ev-item')).map((x) => x.textContent),
    hasHeader: !!d.querySelector('.snv-ev > b'),
  };
})()`);
ok('点击卡片展开详情', detail.open === true && detail.hidden === false && detail.expanded === 'true', detail);
ok('详情展示完整自述（第一人称原文未改写）', detail.full === SEED[2].text, detail.full);
ok('三段说明分别对应 observed / inferred / question', JSON.stringify(detail.blocks) === JSON.stringify([
  { cls: 'observed', label: '他看到的（能对上的事）', text: SEED[2].observed },
  { cls: 'inferred', label: '他猜的（只是他的理解，不等于事实）', text: SEED[2].inferred },
  { cls: 'question', label: '他还没弄明白的', text: SEED[2].question },
]), detail.blocks);
ok('推断被明确标为「不等于事实」', detail.blocks[1].label.indexOf('不等于事实') >= 0, detail.blocks[1].label);
ok('显示可信程度', detail.meta.indexOf('可信程度：还不太确定') >= 0, detail.meta);
ok('证据显示消息编号与原文', detail.evItems.length === 2
  && detail.evItems[0].indexOf('#2618') >= 0 && detail.evItems[0].indexOf('我怕太麻烦，结果真的好凉呀，逼自己吞掉半个') >= 0
  && detail.evItems[1].indexOf('#2620') >= 0 && detail.evItems[1].indexOf('只是觉得阿姨也有一点点忙来着') >= 0,
detail.evItems);

// 再展开第二条，确认证据逐条对应
await ev(`document.querySelectorAll('.snv-head')[2].click()`);
await sleep(120);
const detail3 = await ev(`(function () {
  const card = document.querySelectorAll('.snv-card')[2];
  const d = card.querySelector('.snv-detail');
  return {
    full: (d.querySelector('.snv-full') || {}).textContent || '',
    observed: (d.querySelector('.snv-block.observed p') || {}).textContent || '',
    items: Array.from(d.querySelectorAll('.snv-ev-item')).map((x) => x.textContent),
  };
})()`);
ok('第三条（认真回应）详情与证据对应正确', detail3.full === SEED[0].text
  && detail3.observed === SEED[0].observed
  && detail3.items.length === 3
  && detail3.items[0].indexOf('#2487') >= 0 && detail3.items[0].indexOf('你必须认真回答我') >= 0
  && detail3.items[2].indexOf('#2509') >= 0, detail3);

// 筛选
const clickFilter = async (label) => {
  await ev(`(function () {
    const b = Array.from(document.querySelectorAll('.snv-filter')).find((x) => x.textContent.trim().indexOf(${JSON.stringify(label)}) === 0);
    if (b) b.click();
  })()`);
  await sleep(150);
  return ev(`(function () {
    const cards = Array.from(document.querySelectorAll('.snv-card'));
    return {
      n: cards.length,
      titles: cards.map((c) => (c.querySelector('.snv-title') || {}).textContent || ''),
      active: (Array.from(document.querySelectorAll('.snv-filter')).find((f) => f.classList.contains('active')) || {}).textContent.trim(),
    };
  })()`);
};
const onlyInfer = await clickFilter('他的理解');
ok('按「他的理解」筛选后只剩 1 条', onlyInfer.n === 1 && onlyInfer.titles[0] === '冷馒头' && onlyInfer.active.indexOf('他的理解') === 0, onlyInfer);
const onlyImpr = await clickFilter('留下的印象');
ok('按「留下的印象」筛选正确', onlyImpr.n === 1 && onlyImpr.titles[0] === '认真回应', onlyImpr);
const backAll = await clickFilter('全部');
ok('回到「全部」恢复 3 条', backAll.n === 3, backAll);

const stateAfterUi = await rawState();
ok('浏览、展开、筛选全程未改动正式记录', stateAfterUi === stateBefore);

// 空状态：删掉临时记录（只删临时 profile 里的测试数据）
await ev(`(async () => {
  await new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').delete('selfNarrative.v1');
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
  await SelfNarrativeView.render();
})()`);
await sleep(200);
const empty = await ev(`(function () {
  const box = document.querySelector('#snViewList .snv-empty');
  return {
    text: box ? box.textContent : '',
    cards: document.querySelectorAll('.snv-card').length,
    filters: Array.from(document.querySelectorAll('.snv-filter')).map((f) => f.textContent.trim()),
  };
})()`);
ok('没有记录时显示自然空态', empty.text.indexOf('这里还空着') >= 0 && empty.cards === 0, empty);
ok('空态不伪造任何条目', empty.cards === 0 && empty.text.indexOf('冷馒头') < 0, empty);

const kvAfter = await kvSnapshot();
ok('全程未创建或改动水位', JSON.parse(kvAfter).watermark === null && JSON.parse(kvBefore).watermark === null, kvAfter);
ok('未产生 Dry-run 草稿', JSON.parse(kvAfter).snDryRun === null && JSON.parse(kvBefore).snDryRun === null);
ok('未调用 AI、无用量记录', JSON.parse(kvAfter).usage === null && JSON.parse(kvBefore).usage === null);

// 原有功能不受影响
const legacy = await ev(`(function () {
  return {
    chatPage: !!document.getElementById('chat'),
    messages: !!document.getElementById('messages'),
    sendFn: typeof sendMessage === 'function',
    dryRun: !!window.SelfNarrativeDryRun,
    dryRunFab: !!document.getElementById('sn-dryrun-root'),
    keeps: typeof renderKeeps === 'function',
    snList: typeof SelfNarrative.list === 'function',
    viewOpen: typeof openSelfNarrative === 'function',
  };
})()`);
ok('聊天与 Dry-run 原有入口仍在', legacy.chatPage && legacy.messages && legacy.sendFn && legacy.dryRun && legacy.dryRunFab && legacy.keeps && legacy.snList, legacy);

// 返回首页再进一次，确认可重复进入
await ev(`showPage('home'); openSelfNarrative();`);
await sleep(300);
const reenter = await ev(`(function () {
  return { active: document.getElementById('narrative').classList.contains('active'), hasList: !!document.getElementById('snViewList') };
})()`);
ok('可反复从首页进入机自述页', reenter.active && reenter.hasList, reenter);

ok('无未捕获异常', errors.length === 0, errors.slice(0, 4));

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
console.log('临时 profile：' + PROFILE);

try { ws.close(); } catch {}
browser.kill();
server.close();
process.exitCode = fail ? 1 : 0;
