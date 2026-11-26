/* tests/radio/radio-ui-browser.mjs — 午夜电台真实页面验证
 * 隔离：独立端口 + 独立 Edge profile，测试数据自带前缀，结束即清理。
 * 不发送任何 TTS / DeepSeek 请求；用合成的极小 base64 音频当「聊天原声」。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9393;
const BASE = process.argv[2] || 'http://127.0.0.1:8795';
const PREFIX = '电台验证_';

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined && detail !== '' ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
}

const browser = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.env.TEMP}\\radio-ui-${Date.now()}`,
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--window-size=480,1400',
], { stdio: 'ignore' });

async function waitCDP() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return await r.json(); } catch { /* retry */ }
    await sleep(250);
  }
  throw new Error('DevTools 未就绪');
}

const netUrls = [];
let ws;
try {
  const info = await waitCDP();
  ws = await new Promise((res, rej) => { const w = new WebSocket(info.webSocketDebuggerUrl); w.onopen = () => res(w); w.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Network.requestWillBeSent') netUrls.push(m.params.request.url);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  };
  const C = (method, params = {}, sid) => { id++; return new Promise((res, rej) => { pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) })); setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 30000); }); };

  const { targetId } = await C('Target.createTarget', { url: 'about:blank' });
  const sessionId = (await C('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  await C('Page.enable', {}, sessionId);
  await C('Runtime.enable', {}, sessionId);
  await C('Network.enable', {}, sessionId);
  const ev = (expression, awaitPromise = false) => C('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, sessionId).then(r => {
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result.value;
  });
  // 轮询等待页面到达预期状态，避免固定 sleep 在不同机器上抢跑
  const waitFor = async (expr, timeout = 10000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try { if (await ev(expr)) return true; } catch { /* 页面切换中，重试 */ }
      await sleep(120);
    }
    return false;
  };

  // ---------- 1. 造聊天原声（模拟 messages.audioData） ----------
  await C('Page.navigate', { url: `${BASE}/playground/` }, sessionId);
  await sleep(1200);

  const seed = await ev(`(async () => {
    const audio = 'data:audio/mpeg;base64,' + 'A'.repeat(240);   // 仅用于证明「原声确实存在」，不真的解码播放
    const lines = [
      'Goodnight. The moon is hanging low tonight, and the whole city looks quiet from up here.',
      'I hope you can sleep a little earlier today. You always stay up too late for someone you love.',
      'Late night talks are always my favourite, because that is when you tell me the smallest things.',
      'Look at the star above the window. It is bright and it is shining just for you tonight.',
      'After a long busy day, the best part is still the moment you say you are home.',
      'I remember every small thing you said today, even the ones you thought I would forget.',
      'Tomorrow will be better. Rest now, and I will keep the light on until you fall asleep.',
    ];
    const db = await new Promise((res, rej) => {
      const req = indexedDB.open('star_fifi_room', 1);
      req.onupgradeneeded = () => { const d = req.result; if (!d.objectStoreNames.contains('messages')) d.createObjectStore('messages', { keyPath: 'id', autoIncrement: true }); };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    await new Promise((res, rej) => {
      const tx = db.transaction('messages', 'readwrite');
      const st = tx.objectStore('messages');
      st.clear();
      const base = Date.now() - 7 * 86400000;
      lines.forEach((en, i) => st.add({ role: 'assistant', content: '${PREFIX}第 ' + (i + 1) + ' 段中文', englishContent: en, audioData: audio, time: base + i * 3600000 }));
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
    });
    db.close();
    localStorage.removeItem('ylxh.radio.episodes');
    localStorage.removeItem('ylxh.radio.progress');
    return { ok: true, count: lines.length };
  })()`, true);
  check('R01 造出 7 条带原声的英文聊天消息', seed && seed.count === 7, JSON.stringify(seed));

  // ---------- 2. 进入电台首页：三层布局 ----------
  await C('Page.navigate', { url: `${BASE}/playground/#/radio` }, sessionId);
  await waitFor(`!!document.querySelector('.radio-programs .radio-ch-card')`);
  await sleep(200);

  const home = await ev(`(() => {
    const q = s => Array.from(document.querySelectorAll(s));
    const bg = el => getComputedStyle(el).backgroundColor;
    const lum = rgb => { const m = rgb.match(/[\\d.]+/g) || []; const [r,g,b] = m.map(Number); return 0.2126*r + 0.7152*g + 0.0722*b; };
    const tiers = q('.radio-tier').map(el => el.textContent.trim());
    const programs = q('.radio-programs .radio-ch-card');
    const tones = q('.radio-atmosphere .radio-ch-card');
    const shelves = q('.radio-shelf .shelf-card');
    const card = document.querySelector('.radio-ch-card:not(.lead)');
    const scene = document.querySelector('.radio-scene');
    return {
      tiers,
      programNames: programs.map(el => el.querySelector('.ch-name').textContent.trim()),
      leadName: (document.querySelector('.radio-programs .radio-ch-card.lead .ch-name') || {}).textContent || '',
      toneNames: tones.map(el => el.querySelector('.ch-name').textContent.trim()),
      shelfNames: shelves.map(el => el.querySelector('.shelf-title').textContent.trim()),
      cardCount: programs.length,
      cardBg: card ? bg(card) : '',
      cardBgLum: card ? Math.round(lum(bg(card))) : null,
      cardText: card ? getComputedStyle(card.querySelector('.ch-name')).color : '',
      cardTextLum: card ? Math.round(lum(getComputedStyle(card.querySelector('.ch-name')).color)) : null,
      sceneColor: scene ? Math.round(lum(getComputedStyle(scene).color)) : null,
      pageBg: getComputedStyle(document.body).backgroundImage.slice(0, 24),
    };
  })()`);

  check('R02 第一层「节目」= 读书分享 + 深夜谈心 + 英文广播', JSON.stringify(home.programNames) === JSON.stringify(['读书分享', '深夜谈心', '英文广播']) && home.leadName === '读书分享', JSON.stringify(home.programNames));
  check('R03 第二层「今晚的声音」= 晚安哄睡 + 音乐频道，横向两张', JSON.stringify(home.tiers) === JSON.stringify(['今晚的声音', '馆藏']) && JSON.stringify(home.toneNames) === JSON.stringify(['晚安哄睡', '音乐频道']), JSON.stringify(home.toneNames));
  check('R04 第三层「馆藏」= 声音收藏馆 + 阅读书架，并排两张', JSON.stringify(home.shelfNames) === JSON.stringify(['声音收藏馆', '小星的阅读书架']), JSON.stringify(home.shelfNames));
  check('R05 不再有「五个小方块」布局（第一层只有 3 张卡）', home.cardCount === 3, `第一层 ${home.cardCount} 张`);
  check('R06 卡片是浅色纸面（背景亮、文字深蓝紫）', home.cardBgLum > 200 && home.cardTextLum < 120, `bg=${home.cardBg}(${home.cardBgLum}) text=${home.cardText}(${home.cardTextLum})`);

  // ---------- 3. 英文广播：整理一期节目 ----------
  await ev(`document.querySelector('.radio-ch-card[data-channel="english"]').click()`);
  await waitFor(`!!document.querySelector('#en-make-program')`);
  await sleep(200);
  const before = await ev(`document.querySelectorAll('.radio-program-card').length`);
  check('R07 进入英文广播（还没有节目）', before === 0, `已有 ${before} 期`);

  await ev(`document.querySelector('#en-make-program').click()`);
  await waitFor(`document.querySelectorAll('.radio-program-card').length > 0`, 15000);
  await sleep(300);

  const made = await ev(`(async () => {
    const m = await import('/playground/radio-store.js');
    const eps = m.radioStore.getEpisodeByChannel('english').filter(e => e.program);
    return {
      count: eps.length,
      title: eps[0] ? eps[0].title : '',
      cover: eps[0] ? eps[0].cover : '',
      summary: eps[0] ? eps[0].summary : '',
      segCount: eps[0] ? eps[0].segments.length : 0,
      segIds: eps[0] ? eps[0].segments.map(s => s.messageId) : [],
      atSorted: eps[0] ? eps[0].segments.every((s, i, a) => i === 0 || a[i-1].at <= s.at) : false,
      voiceStatus: eps[0] ? eps[0].voiceStatus : '',
      source: eps[0] ? eps[0].source : '',
      cards: document.querySelectorAll('.radio-program-card').length,
      msg: (document.querySelector('.voice-msg') || {}).textContent || '',
    };
  })()`, true);

  check('R08 一期节目收进 3~5 段原声（7 段素材 → 5 段）', made.segCount === 5 && made.cards === 1, `segments=${made.segCount} 卡片=${made.cards}`);
  check('R09 段内按聊天时间从早到晚排列', made.atSorted === true);
  check('R10 标题/封面/简介本地生成且有内容', !!made.title && !!made.cover && made.summary.includes('没有再重新生成语音'), `${made.cover} ${made.title}`);
  check('R11 节目就是聊天原声（不补生成语音）', made.voiceStatus === 'ready' && made.source === 'conversation', `${made.voiceStatus}/${made.source}`);

  const segReal = await ev(`(async () => {
    const m = await import('/playground/radio-store.js');
    const ep = m.radioStore.getEpisodeByChannel('english').find(e => e.program);
    const db = await new Promise((res, rej) => { const r = indexedDB.open('star_fifi_room'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const get = id => new Promise((res, rej) => { const tx = db.transaction('messages', 'readonly'); const q = tx.objectStore('messages').get(Number(id)); q.onsuccess = () => res(q.result || null); q.onerror = () => rej(q.error); });
    let ok = 0;
    for (const s of ep.segments) { const msg = await get(s.messageId); if (msg && typeof msg.audioData === 'string' && msg.audioData.length > 64 && String(msg.englishContent).trim()) ok++; }
    db.close();
    return { ok, total: ep.segments.length };
  })()`, true);
  check('R12 每一段都能在聊天里找回原始 audioData', segReal.ok === segReal.total, `${segReal.ok}/${segReal.total}`);

  // ---------- 4. 不重复制作 ----------
  await ev(`document.querySelector('#en-make-program').click()`);
  await sleep(2000);   // 这次期望「不新增」，只能等它跑完再看结果
  const second = await ev(`(async () => {
    const m = await import('/playground/radio-store.js');
    const eps = m.radioStore.getEpisodeByChannel('english').filter(e => e.program);
    return { count: eps.length, segTotal: eps.reduce((n, e) => n + e.segments.length, 0), msg: (document.querySelector('.voice-msg') || {}).textContent || '' };
  })()`, true);
  check('R13 只剩 2 段素材时不再硬凑新一期（不重复制作）', second.count === 1 && second.segTotal === 5, `节目 ${second.count} 期 / ${second.segTotal} 段 · ${second.msg}`);
  check('R14 没有新素材时给出明确说明', /至少|都已经收进/.test(second.msg), second.msg);

  // ---------- 5. 持久化：刷新后节目还在 ----------
  await C('Page.navigate', { url: `${BASE}/playground/?reload=${Date.now()}#/radio` }, sessionId);
  await waitFor(`!!document.querySelector('.radio-ch-card[data-channel="english"]')`);
  await ev(`document.querySelector('.radio-ch-card[data-channel="english"]').click()`);
  await waitFor(`document.querySelectorAll('.radio-program-card').length > 0`);
  await sleep(200);
  const persisted = await ev(`(async () => {
    const m = await import('/playground/radio-store.js');
    const eps = m.radioStore.getEpisodeByChannel('english').filter(e => e.program);
    return { count: eps.length, cards: document.querySelectorAll('.radio-program-card').length, title: eps[0] ? eps[0].title : '' };
  })()`, true);
  check('R15 刷新后已整理的节目仍在（持久化，不重新整理）', persisted.count === 1 && persisted.cards === 1, `${persisted.title}`);

  // ---------- 6. 整期连播队列（自动接下一段） ----------
  const queue = await ev(`(async () => {
    const m = await import('/playground/radio.js');
    const st = await import('/playground/radio-store.js');
    const Scene = m.RadioScene;
    const ep = st.radioStore.getEpisodeByChannel('english').find(e => e.program);
    Scene._enProgram = { episodeId: ep.id, index: 0, segments: ep.segments.slice() };
    const calls = [];
    const orig = Scene._playProgramSegment;
    Scene._playProgramSegment = async function () { calls.push(this._enProgram ? this._enProgram.index : -1); };
    Scene._onAudioEnded('ep:' + ep.id, 100);   // 第 1 段播完
    Scene._onAudioEnded('ep:' + ep.id, 100);   // 第 2 段播完
    const midStatus = st.radioStore.getEpisode(ep.id).status;
    Scene._onAudioEnded('ep:' + ep.id, 100);
    Scene._onAudioEnded('ep:' + ep.id, 100);
    const beforeLast = calls.slice();
    Scene._onAudioEnded('ep:' + ep.id, 100);   // 第 5 段播完 → 整期结束
    const after = st.radioStore.getEpisode(ep.id);
    Scene._playProgramSegment = orig;
    return { calls: beforeLast, status: after.status, heard: !!after.heardAt, queueCleared: Scene._enProgram === null, midStatus };
  })()`, true);
  check('R16 一段播完自动接下一段（队列索引 1→2→3→4）', JSON.stringify(queue.calls) === JSON.stringify([1, 2, 3, 4]), JSON.stringify(queue.calls));
  check('R17 最后一段播完才标记整期已完成 + 记为听过', queue.status === 'completed' && queue.heard === true && queue.queueCleared === true, `status=${queue.status} heard=${queue.heard}`);

  // ---------- 7. 原有功能未被破坏 ----------
  const original = await ev(`(async () => {
    const st = await import('/playground/radio-store.js');
    const m = await import('/playground/radio.js');
    const Scene = m.RadioScene;
    const ep = st.radioStore.getEpisodeByChannel('english').find(e => e.program);
    const fav = document.querySelector('[data-fav="' + ep.id + '"]');
    fav.click();
    const favOn = st.radioStore.getEpisode(ep.id).favorite;
    document.querySelector('[data-fav="' + ep.id + '"]').click();
    const favOff = st.radioStore.getEpisode(ep.id).favorite;
    // 单段语音仍可单独收听：独立节目不会被当成整期
    const single = st.radioStore.addEpisode({ id: 'ep_single_test', title: 'Single', channel: 'english', content: 'One short english line.', type: 'basic', lang: 'en', source: 'original', voiceStatus: 'missing', externalId: 'msg:1' });
    Scene.openDetail ? Scene.openDetail('ep_single_test') : null;
    const singleView = { view: Scene.view, isProgram: !!(st.radioStore.getEpisode('ep_single_test') || {}).program };
    st.radioStore.deleteEpisode('ep_single_test');
    // 读文字→标记完成仍然可用
    Scene.view = 'english';
    return { favOn, favOff, singleView, hasToggle: typeof st.radioStore.toggleFavorite === 'function' };
  })()`, true);
  check('R18 特别喜欢仍可切换（节目卡）', original.favOn === true && original.favOff === false, `on=${original.favOn} off=${original.favOff}`);
  check('R19 单段英文节目仍按单集处理（不是整期）', original.singleView.isProgram === false, JSON.stringify(original.singleView));

  // ---------- 8. 全流程零 TTS / DeepSeek 请求 ----------
  const bad = netUrls.filter(u => /api\/tts|deepseek|workers\.dev|elevenlabs/i.test(u));
  check('R20 全程没有 TTS / DeepSeek 请求', bad.length === 0, bad.slice(0, 3).join(' | '));

  // ---------- 8b. 只有文字、没有原声的英文消息不能进节目 ----------
  const noAudio = await ev(`(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('star_fifi_room'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    await new Promise((res, rej) => { const tx = db.transaction('messages', 'readwrite');
      tx.objectStore('messages').add({ role: 'assistant', content: '${PREFIX}没有原声的一段', englishContent: 'NOAUDIO This English line only exists as text, there is no stored audio for it at all.', time: Date.now() });
      tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    db.close();
    const m = await import('/playground/radio-english.js');
    const list = await m.radioEnglish.scanChat(150);
    return { scanned: list.length, leaked: list.some(c => c.en.includes('NOAUDIO')) };
  })()`, true);
  check('R21 没有 audioData 的英文消息不会作为语音素材', noAudio.leaked === false, `扫描到 ${noAudio.scanned} 条，纯文字未混入`);

  // ---------- 9. 清理测试数据 ----------
  await ev(`(async () => {
    const st = await import('/playground/radio-store.js');
    for (const ep of st.radioStore.getEpisodeByChannel('english')) st.radioStore.deleteEpisode(ep.id);
    const db = await new Promise((res, rej) => { const r = indexedDB.open('star_fifi_room'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    await new Promise((res) => { const tx = db.transaction('messages', 'readwrite'); tx.objectStore('messages').clear(); tx.oncomplete = res; tx.onerror = res; });
    db.close();
    return true;
  })()`, true);

  console.log(`\n总计 ${pass} 通过 / ${fail} 失败`);
} finally {
  try { ws && ws.close(); } catch { /* ignore */ }
  browser.kill();
}
process.exit(fail ? 1 : 0);
