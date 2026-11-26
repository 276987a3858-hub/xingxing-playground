/* tests/butler/voice-chat-browser.mjs — 聊天语音消息真实浏览器验证（Edge DevTools Protocol）
 * 覆盖：录音（假麦克风）/ 结束 / 试听 / 手补文字 / 发送 / 气泡播放与转写展开 /
 *       刷新后仍可播放 / 删除同步清理音频 / 备份含原始录音 / TTS 失败冷却 / 手机端可见性。
 * 运行前需先起本地服务：npx wrangler dev --port 8787 --ip 127.0.0.1
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9300 + Math.floor(Math.random() * 350);   // 随机端口，避免上一轮残留实例占用
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const profile = `${process.env.TEMP}\\voice-chat-${Date.now()}`;

const browser = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-component-update', '--window-size=1280,900',
  // 假麦克风：让 MediaRecorder 真的产出音频数据，才能验证「录下来的东西能存能播」
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  'about:blank',
], { stdio: 'ignore' });

async function waitForDevTools() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return await r.json(); } catch {}
    await sleep(250);
  }
  throw new Error('DevTools 端口未就绪');
}

function connectWS(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error('WS 连接失败: ' + (e.message || '')));
  });
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

let ws;
try {
  const info = await waitForDevTools();
  ws = await connectWS(info.webSocketDebuggerUrl);

  let id = 0; const pending = new Map();
  const errors = [];
  let sessionId = null;
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      return;
    }
    // 原生 confirm 在无头浏览器里会卡住渲染进程，统一自动确认
    if (m.method === 'Page.javascriptDialogOpening') {
      const sid = m.sessionId || sessionId;
      id += 1;
      ws.send(JSON.stringify({ id, method: 'Page.handleJavaScriptDialog', params: { accept: true }, sessionId: sid }));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      errors.push(String(d.text || 'exception') + ' ' + String((d.exception && d.exception.description) || ''));
    }
  };
  const C = (method, params = {}, sid) => { id++; return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)); } }, 20000);
  }); };

  const { targetId } = await C('Target.createTarget', { url: 'about:blank' });
  const attached = await C('Target.attachToTarget', { targetId, flatten: true });
  sessionId = attached.sessionId;
  await C('Page.enable', {}, sessionId);
  await C('Runtime.enable', {}, sessionId);

  const ev = async (expression, awaitPromise = false) => {
    const r = await C('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result.value;
  };
  const waitFor = async (expr, ms = 6000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await ev(expr)) return true;
      await sleep(120);
    }
    return false;
  };

  await C('Page.navigate', { url: `${BASE}/` }, sessionId);
  await sleep(1500);

  // ===== 模块与入口 =====
  const mods = await ev(`({
    config: typeof VoiceConfig, store: typeof VoiceStore, service: typeof VoiceService,
    bubble: typeof VoiceBubble, recorder: typeof VoiceRecorder,
    open: typeof window.openVoiceRecorder
  })`);
  check('V01 语音模块全部加载', mods.config === 'object' && mods.store === 'object'
    && mods.service === 'object' && mods.bubble === 'object'
    && mods.recorder === 'object' && mods.open === 'function', JSON.stringify(mods));

  await ev(`document.getElementById('micBtn').click()`);
  await sleep(300);
  const panel = await ev(`(() => { const p = document.getElementById('voicePanel');
    return { hidden: p.hidden, dict: (document.getElementById('vpDictBtn')||{}).textContent || '',
             hasSend: !!document.getElementById('vpSendBtn') }; })()`);
  check('V02 🎙️ 打开录音面板，且保留「只用听写」次要入口', panel.hidden === false && panel.dict.includes('听写'), JSON.stringify(panel));

  // 准备：填 API Key（只写本地），关掉英文朗读与双语，避免测试里去请求翻译/TTS
  await ev(`(() => {
    const i = document.getElementById('apiKeyInput'); i.value = 'sk-test';
    saveApiKey();
    settings.voiceEnabled = false; settings.showEnglish = false;
    window.AIClient.chat = async () => '嗯，我在听。';
    window.confirm = () => true;
    return true;
  })()`);

  // ===== 录音 =====
  await ev(`VoiceRecorder.toggle()`);
  await sleep(1900);
  const recState = await ev(`({ phase: VoiceRecorder.phase, time: document.getElementById('vpTime').textContent,
    btn: document.getElementById('vpRecBtn').textContent, asr: document.getElementById('vpAsrState').textContent })`);
  check('V03 开始录音：进入录制态并走时', recState.phase === 'recording' && recState.time !== '0:00', JSON.stringify(recState));

  await ev(`VoiceRecorder.stop()`);
  const ready = await waitFor(`VoiceRecorder.phase === 'ready'`, 6000);
  const clipInfo = await ev(`({ phase: VoiceRecorder.phase, hasClip: VoiceRecorder.hasClip(),
    dur: document.getElementById('vpTime').textContent,
    playHidden: document.getElementById('vpPlayBtn').hidden,
    sendDisabled: document.getElementById('vpSendBtn').disabled })`);
  check('V04 结束录音：拿到音频且可发送', ready && clipInfo.hasClip && clipInfo.playHidden === false && clipInfo.sendDisabled === false,
    JSON.stringify(clipInfo));

  await ev(`document.getElementById('vpPlayBtn').click()`);
  await sleep(400);
  const previewing = await ev(`document.getElementById('vpPlayBtn').textContent`);
  check('V05 试听按钮可用（点击后进入播放/暂停态）', /暂停|试听/.test(previewing), previewing);
  await ev(`document.getElementById('vpPlayBtn').click()`);
  await sleep(150);

  // ===== 重录 / 取消 =====
  await ev(`document.getElementById('vpRedoBtn').click()`);
  await sleep(250);
  const redo = await ev(`({ phase: VoiceRecorder.phase, has: VoiceRecorder.hasClip(),
    text: document.getElementById('vpTranscript').value, send: document.getElementById('vpSendBtn').disabled })`);
  check('V05b 重录：丢弃上一条录音并回到待录状态', redo.phase === 'idle' && redo.has === false && redo.send === true, JSON.stringify(redo));

  await ev(`VoiceRecorder.start()`);
  await sleep(1400);
  await ev(`VoiceRecorder.stop()`);
  await waitFor(`VoiceRecorder.phase === 'ready'`, 6000);
  await ev(`[...document.querySelectorAll('.vp-actions .vp-btn')].find(b => b.textContent.includes('取消')).click()`);
  await sleep(300);
  const cancelled = await ev(`({ hidden: document.getElementById('voicePanel').hidden,
    voiceCount: chatHistory.filter(m => m && m.type === 'voice').length,
    phase: VoiceRecorder.phase })`);
  check('V05c 取消：关闭面板且不留下任何消息', cancelled.hidden === true && cancelled.voiceCount === 0 && cancelled.phase === 'idle', JSON.stringify(cancelled));

  // 正式录一条用于发送
  await ev(`openVoiceRecorder()`);
  await sleep(250);
  await ev(`VoiceRecorder.start()`);
  await sleep(1900);
  await ev(`VoiceRecorder.stop()`);
  await waitFor(`VoiceRecorder.phase === 'ready'`, 8000);

  // 手动补/改转写文字（ASR 失败时的兜底路径）
  await ev(`(() => { const t = document.getElementById('vpTranscript');
    t.value = '今天有点累，想早点睡'; t.dispatchEvent(new Event('input', { bubbles: true })); return t.value; })()`);

  // ===== 发送 =====
  await ev(`document.getElementById('vpSendBtn').click()`);
  const sent = await waitFor(`document.getElementById('voicePanel').hidden === true`, 8000);
  const msg = await ev(`(async () => {
    const m = chatHistory.filter(x => x && x.type === 'voice').pop();
    if (!m) return null;
    const blob = await VoiceStore.getBlob(m.audioClipId);
    return { id: m.id, role: m.role, content: m.content, clipId: m.audioClipId,
             mime: m.audioMime, dur: m.durationMs, asr: m.asrStatus,
             blobSize: blob ? blob.size : 0, blobMime: blob ? blob.type : '',
             hasAudioData: !!m.audioData };
  })()`, true);
  check('V06 发送后聊天记录里是一条语音消息', !!msg && msg.role === 'user' && msg.content === '今天有点累，想早点睡', JSON.stringify(msg));
  check('V07 原始音频按 Blob 独立保存（不在消息里堆 base64）', !!msg && msg.blobSize > 0 && msg.hasAudioData === false,
    msg ? `blob=${msg.blobSize} ${msg.blobMime}` : '');
  check('V08 消息里保留时长 / MIME / 转录状态', !!msg && msg.dur > 500 && !!msg.mime && !!msg.asr,
    msg ? `${msg.dur}ms ${msg.mime} ${msg.asr}` : '');

  // ===== 气泡 =====
  const bubble = await ev(`(() => {
    const b = document.querySelector('.voice-bubble');
    if (!b) return null;
    const play = b.querySelector('.vb-play');
    const time = b.querySelector('.vb-time');
    const toggle = b.querySelector('.vb-toggle');
    const text = b.querySelector('.vb-text');
    return { play: !!play, time: time ? time.textContent : '', toggle: !!toggle,
             textDisplay: text ? getComputedStyle(text).display : '',
             textValue: text ? text.textContent.trim() : '' };
  })()`);
  check('V09 语音气泡有播放键 / 时长 / 转写入口', !!(bubble && bubble.play && bubble.toggle && /\d+:\d\d/.test(bubble.time)), JSON.stringify(bubble));
  check('V10 转写默认收起', bubble && bubble.textDisplay === 'none', bubble ? bubble.textDisplay : '');

  await ev(`document.querySelector('.voice-bubble .vb-toggle').click()`);
  await sleep(200);
  const opened = await ev(`(() => { const t = document.querySelector('.voice-bubble .vb-text');
    return { display: getComputedStyle(t).display, text: t.textContent.trim() }; })()`);
  check('V11 转写可以展开且内容正确', opened.display !== 'none' && opened.text === '今天有点累，想早点睡', JSON.stringify(opened));

  // 聊天页会频繁整表重绘（输入中、翻译回填），展开状态不能被重绘吞掉
  const reopened = await ev(`(() => { renderMessages();
    const b = document.querySelector('.voice-bubble');
    return { open: b.classList.contains('is-open'), text: getComputedStyle(b.querySelector('.vb-text')).display }; })()`);
  check('V11b 重绘后转写仍保持展开', reopened.open === true && reopened.text !== 'none', JSON.stringify(reopened));

  await ev(`document.querySelector('.voice-bubble .vb-play').click()`);
  await sleep(700);
  const playing = await ev(`(() => { const b = document.querySelector('.voice-bubble');
    return { btn: b.querySelector('.vb-play').textContent, time: b.querySelector('.vb-time').textContent,
             fill: b.querySelector('.vb-fill').style.width }; })()`);
  check('V12 气泡可播放并显示进度', playing.btn === '⏸' && /\//.test(playing.time), JSON.stringify(playing));
  await ev(`document.querySelector('.voice-bubble .vb-play').click()`);

  const reply = await ev(`(async () => {
    const last = chatHistory[chatHistory.length - 1];
    return { role: last.role, content: last.content, count: chatHistory.length };
  })()`, true);
  check('V13 AI 文字回复照常生成（走原有聊天流程）', reply.role === 'assistant' && reply.content.includes('我在听'), JSON.stringify(reply));

  // ===== 备份：完整备份必须带上原始录音 =====
  const backup = await ev(`(async () => {
    await import('/shared/backup-format.js');
    await import('/shared/backup-io.js');
    const F = globalThis.BackupFormat, IO = globalThis.BackupIO;
    const r = await IO.exportAll({ download: false });
    if (!r.ok) return { ok: false, reason: r.reason, detail: r.detail && r.detail.at };
    const clips = (r.file.chat_voice && r.file.chat_voice.clips) || [];
    const refs = (r.file.star_fifi_room.messages || []).filter(m => m && m.audioClipId);
    const ids = new Set(clips.map(c => c.id));
    const check = await F.verifyIntegrity(r.file);
    return { ok: true, clips: clips.length, refs: refs.length,
             matched: refs.filter(m => ids.has(m.audioClipId)).length,
             packed: clips.every(c => c.blob && c.blob.bytes > 0 && c.blob.sha256),
             verify: check.ok };
  })()`, true);
  check('V14 完整备份包含聊天语音分区且与消息引用对得上',
    !!backup && backup.ok === true && backup.clips >= 1 && backup.matched === backup.refs && backup.packed === true && backup.verify === true,
    JSON.stringify(backup));

  // ===== 设置页那份「导出备份」也要带上语音原始录音，并且能导回来 =====
  const legacy = await ev(`(async () => {
    const realCreate = URL.createObjectURL;
    let captured = null;
    URL.createObjectURL = (b) => { captured = b; return 'blob:stub'; };
    try { await exportData(); } finally { URL.createObjectURL = realCreate; }
    if (!captured) return { ok: false, reason: 'no-blob' };
    const text = await captured.text();
    const data = JSON.parse(text);
    const clips = data.voiceClips || [];
    const vm = (data.messages || []).filter(m => m && m.audioClipId);
    const summary = {
      clips: clips.length,
      refs: vm.length,
      match: vm.filter(m => clips.some(c => c.id === m.audioClipId)).length,
      dataUrl: clips[0] ? String(clips[0].data).slice(0, 22) : ''
    };
    // 同一份备份再导回去：消息与音频引用必须仍然对得上
    await importData({ files: [new File([text], 'legacy.json', { type: 'application/json' })], value: '' });
    await new Promise(r => setTimeout(r, 800));
    const back = (chatHistory || []).filter(m => m && m.audioClipId).pop();
    const blob = back ? await VoiceStore.getBlob(back.audioClipId) : null;
    return Object.assign({ ok: true }, summary, {
      restored: !!back,
      restoredText: back ? back.content : '',
      blobSize: blob ? blob.size : 0,
      bubbles: document.querySelectorAll('.voice-bubble').length
    });
  })()`, true);
  check('V14b 设置页导出备份含语音原始录音，且能原样导回',
    !!legacy && legacy.ok === true && legacy.clips === legacy.refs && legacy.match === legacy.refs
    && legacy.dataUrl.startsWith('data:audio/') && legacy.restored === true && legacy.blobSize > 0,
    JSON.stringify(legacy));

  // ===== 刷新后历史语音仍能播 =====
  await C('Page.navigate', { url: `${BASE}/` }, sessionId);
  await sleep(1500);
  await ev(`showPage('chat')`);
  await sleep(400);
  const afterReload = await waitFor(`(() => { const b = document.querySelector('.voice-bubble');
    return !!(b && !b.classList.contains('is-missing') && b.querySelector('.vb-play') && !b.querySelector('.vb-play').disabled); })()`, 6000);
  const reloadInfo = await ev(`(() => { const b = document.querySelector('.voice-bubble');
    return b ? { time: b.querySelector('.vb-time').textContent, text: b.querySelector('.vb-text').textContent.trim() } : null; })()`);
  check('V15 刷新后历史语音仍可读取播放（不依赖原语音服务）', afterReload === true, JSON.stringify(reloadInfo));

  // ===== 删除消息 → 音频一起清理 =====
  // 刷新后页面里的覆盖会失效，重新挂上（confirm 另有对话框处理器兜底）
  await ev(`window.confirm = () => true; true`);
  const delRes = await ev(`(async () => {
    const m = chatHistory.filter(x => x && x.type === 'voice').pop();
    const clipId = m.audioClipId;
    await deleteMsg(m.id);
    await new Promise(r => setTimeout(r, 400));
    const blob = await VoiceStore.getBlob(clipId);
    return { blobGone: blob === null, bubbles: document.querySelectorAll('.voice-bubble').length,
             msgGone: !chatHistory.some(x => x.id === m.id) };
  })()`, true);
  check('V16 删除语音消息时同步删掉音频，不留孤儿', delRes.blobGone === true && delRes.msgGone === true, JSON.stringify(delRes));

  // ===== 文字聊天回归：拆出 sendUserTurn 后原有发送不受影响 =====
  const textChat = await ev(`(async () => {
    settings.voiceEnabled = false;
    window.AIClient.chat = async () => '嗯，下点雨好。';
    const i = document.getElementById('chatInput');
    i.value = '今天下了点雨';
    await sendMessage();
    return {
      inputCleared: document.getElementById('chatInput').value === '',
      user: (chatHistory.filter(m => m.role === 'user').pop() || {}).content || '',
      last: (chatHistory[chatHistory.length - 1] || {}).content || '',
      voiceCount: chatHistory.filter(m => m.type === 'voice').length
    };
  })()`, true);
  check('V16b 文字聊天仍按原方式发送与回复',
    textChat.inputCleared === true && textChat.user === '今天下了点雨' && textChat.last.includes('下点雨'), JSON.stringify(textChat));

  // ===== TTS 失败冷却 =====
  const tts = await ev(`(async () => {
    VoiceService.tts.clearCooldown();
    let calls = 0;
    const real = window.fetch;
    window.fetch = async (url, opts) => {
      if (String(url).includes('/api/tts')) { calls += 1; throw new Error('quota'); }
      return real(url, opts);
    };
    settings.voiceEnabled = true;
    try {
      await requestAndPlaySpeech('第一句');
      await requestAndPlaySpeech('第二句');
      await requestAndPlaySpeech('第三句');
      return { calls, cooling: VoiceService.tts.cooldownLeftMs() > 0 };
    } finally {
      window.fetch = real;
      settings.voiceEnabled = false;
      VoiceService.tts.clearCooldown();
    }
  })()`, true);
  check('V17 TTS 失败后进入冷却：三次回复只请求一次语音', tts.calls === 1 && tts.cooling === true, JSON.stringify(tts));

  // ===== 手机视口 =====
  await C('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, sessionId);
  await C('Page.navigate', { url: `${BASE}/` }, sessionId);
  await sleep(1400);
  await ev(`showPage('chat'); openVoiceRecorder()`);
  await sleep(400);
  // 显式模拟触屏媒体特性，验证「不再依赖 hover」这条修复（不靠机型猜测）
  await C('Emulation.setEmulatedMedia', { features: [{ name: 'hover', value: 'none' }, { name: 'pointer', value: 'coarse' }] }, sessionId);
  const mobile = await ev(`(() => {
    const p = document.getElementById('voicePanel').getBoundingClientRect();
    const send = document.getElementById('vpSendBtn').getBoundingClientRect();
    const rec = document.getElementById('vpRecBtn').getBoundingClientRect();
    // 造一个临时重播按钮，直接看它是否会因为「没有 hover」而 display:none
    const probe = document.createElement('div');
    probe.className = 'bubble bot';
    probe.innerHTML = '<span class="replay-btn">🔊</span>';
    document.getElementById('messages').appendChild(probe);
    const el = probe.querySelector('.replay-btn');
    const replayDisplay = getComputedStyle(el).display;
    const replayOpacity = getComputedStyle(el).opacity;
    probe.remove();
    // 删除入口在触屏上的兜底规则是否真的写进了样式表
    const cssFallback = [...document.styleSheets].some(ss => {
      try {
        return [...ss.cssRules].some(r => r.conditionText && /hover|pointer/.test(r.conditionText)
          && String(r.cssText).includes('.del-btn'));
      } catch (e) { return false; }
    });
    return { panelW: Math.round(p.width), vw: window.innerWidth,
             overflow: document.body.scrollWidth <= window.innerWidth + 2,
             sendVisible: send.width > 0 && send.right <= window.innerWidth + 1,
             recVisible: rec.width > 0,
             replayDisplay, replayOpacity, cssFallback, hoverNone: window.matchMedia('(hover: none)').matches };
  })()`);
  check('V18 手机端面板不溢出、按钮可见', mobile.panelW <= mobile.vw && mobile.overflow && mobile.sendVisible && mobile.recVisible, JSON.stringify(mobile));
  check('V19 语音重播按钮始终可见，不再依赖 hover',
    mobile.replayDisplay !== 'none' && Number(mobile.replayOpacity) < 1, JSON.stringify(mobile));
  check('V19b 触屏下删除入口有 hover:none 兜底规则', mobile.cssFallback === true, JSON.stringify(mobile));

  const mobileBubble = await ev(`(async () => {
    // 手机端再录一条短语音，确认录音入口在小屏同样可用
    settings.voiceEnabled = false;
    window.AIClient.chat = async () => '嗯。';
    await VoiceRecorder.start();
    await new Promise(r => setTimeout(r, 1300));
    VoiceRecorder.stop();
    for (let i = 0; i < 40 && VoiceRecorder.phase !== 'ready'; i++) await new Promise(r => setTimeout(r, 120));
    const ready = VoiceRecorder.phase === 'ready';
    document.getElementById('vpTranscript').value = '手机上说一句';
    VoiceRecorder.send();
    for (let i = 0; i < 60 && !document.getElementById('voicePanel').hidden; i++) await new Promise(r => setTimeout(r, 120));
    await new Promise(r => setTimeout(r, 400));
    const b = document.querySelector('.voice-bubble--user');
    return { ready, sent: document.getElementById('voicePanel').hidden, hasBubble: !!b,
             wrapW: b ? Math.round(b.querySelector('.vb-wrap').getBoundingClientRect().width) : 0 };
  })()`, true);
  check('V20 手机端可完成「录音→发送→生成气泡」闭环', mobileBubble.ready && mobileBubble.sent && mobileBubble.hasBubble, JSON.stringify(mobileBubble));

  check('V21 全程无未捕获异常', errors.length === 0, errors.slice(0, 3).join(' | '));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  if (failed.length) process.exitCode = 1;
} catch (e) {
  console.error('测试脚本异常：', e && e.message);
  process.exitCode = 1;
} finally {
  try { ws && ws.close(); } catch {}
  try { browser.kill(); } catch {}
}
