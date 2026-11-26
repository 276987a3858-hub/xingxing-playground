/* tests/shared/voice-service.test.mjs — 语音适配层：TTS 冷却、超时、ASR 适配（不联网） */
import test from 'node:test';
import assert from 'node:assert/strict';

// ---- 最小环境：localStorage + FileReader（Node 没有） ----
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
globalThis.FileReader = class {
  readAsDataURL(blob) {
    blob.arrayBuffer().then((buf) => {
      this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buf).toString('base64')}`;
      if (this.onloadend) this.onloadend();
    }).catch((e) => {
      this.error = e;
      if (this.onerror) this.onerror(e);
    });
  }
};

await import('../../public/shared/voice-config.js');
await import('../../public/shared/voice-service.js');
const S = globalThis.VoiceService;

const realFetch = globalThis.fetch;

function stubFetch(fn) { globalThis.fetch = fn; }
function restoreFetch() { globalThis.fetch = realFetch; }

test('V01 配置集中在 VoiceConfig，聊天侧不持有服务商参数', () => {
  const C = globalThis.VoiceConfig;
  assert.ok(C.tts.endpoint.includes('/api/tts'));
  assert.equal(typeof C.tts.failCooldownMs, 'number');
  assert.equal(C.tts.cooldownKey, 'ylxh.chat.tts.cooldown.v1');
  assert.equal(C.store.dbName, 'ylxh_chat_voice');
  // 音色等 ElevenLabs 专属参数不得出现在前端配置里
  assert.equal('voiceId' in C.tts, false);
  assert.equal('stability' in C.tts, false);
});

test('V02 网络失败 → 进入冷却，冷却期内不再发请求', async () => {
  S.tts.clearCooldown();
  let calls = 0;
  stubFetch(async () => { calls += 1; throw new Error('offline'); });
  try {
    const a = await S.tts.synthesize('你好');
    assert.equal(a.ok, false);
    assert.equal(a.reason, 'network');
    assert.equal(calls, 1);

    // 第二条回复：冷却期内直接返回，绝不打第二次必败请求
    const b = await S.tts.synthesize('你好呀');
    assert.equal(b.ok, false);
    assert.equal(b.reason, 'cooldown');
    assert.equal(calls, 1);
    assert.ok(S.tts.cooldownLeftMs() > 0);

    S.tts.clearCooldown();
    const c = await S.tts.synthesize('再来一次');
    assert.equal(calls, 2);
    assert.equal(c.reason, 'network');
  } finally { restoreFetch(); S.tts.clearCooldown(); }
});

test('V03 HTTP 429 / 500 同样进入冷却（额度耗尽的典型表现）', async () => {
  S.tts.clearCooldown();
  let calls = 0;
  stubFetch(async () => { calls += 1; return new Response('quota', { status: 429 }); });
  try {
    const a = await S.tts.synthesize('在吗');
    assert.equal(a.ok, false);
    assert.equal(a.reason, 'http');
    assert.equal(a.detail, 429);
    const b = await S.tts.synthesize('在吗');
    assert.equal(b.reason, 'cooldown');
    assert.equal(calls, 1);
  } finally { restoreFetch(); S.tts.clearCooldown(); }
});

test('V04 成功一次就清掉冷却，并返回可播放的 blob 与 base64', async () => {
  S.tts.clearCooldown();
  const bytes = new Uint8Array([1, 2, 3, 4]);
  stubFetch(async () => new Response(new Blob([bytes], { type: 'audio/mpeg' }), { status: 200 }));
  try {
    const out = await S.tts.synthesize('你好');
    assert.equal(out.ok, true);
    assert.equal(out.blob.size, 4);
    assert.equal(out.mime, 'audio/mpeg');
    assert.ok(out.base64.startsWith('data:audio/mpeg;base64,'));
    assert.equal(S.tts.cooldownLeftMs(), 0);
  } finally { restoreFetch(); S.tts.clearCooldown(); }
});

test('V05 调用方中断（切页面）不算失败，也不该进冷却', async () => {
  S.tts.clearCooldown();
  const controller = new AbortController();
  stubFetch(async (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    }, { once: true });
  }));
  try {
    const p = S.tts.synthesize('慢慢说', { signal: controller.signal });
    controller.abort();
    const out = await p;
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'aborted');
    assert.equal(S.tts.cooldownLeftMs(), 0);
  } finally { restoreFetch(); S.tts.clearCooldown(); }
});

test('V06 空文本不发请求', async () => {
  let calls = 0;
  stubFetch(async () => { calls += 1; return new Response('x'); });
  try {
    const out = await S.tts.synthesize('   ');
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'empty');
    assert.equal(calls, 0);
  } finally { restoreFetch(); }
});

test('V07 没有 SpeechRecognition 时如实报告不支持，且不抛错', () => {
  delete globalThis.SpeechRecognition;
  delete globalThis.webkitSpeechRecognition;
  assert.equal(S.asr.supported(), false);
  assert.equal(S.asr.create({}), null);
  assert.ok(S.asr.errorText('not-allowed').includes('麦克风'));
});

test('V08 有 SpeechRecognition 时适配器按语言/连续/临时结果配置，并能 start/stop', () => {
  const created = [];
  class FakeRec {
    constructor() { created.push(this); this.started = 0; }
    start() { this.started += 1; }
    stop() {}
    abort() {}
  }
  globalThis.SpeechRecognition = FakeRec;
  const finalTexts = [];
  const session = S.asr.create({ onFinal: (t) => finalTexts.push(t) });
  assert.ok(session);
  const rec = created[0];
  assert.equal(rec.lang, 'zh-CN');
  assert.equal(rec.continuous, true);
  assert.equal(rec.interimResults, true);
  assert.equal(session.start(), true);
  assert.equal(rec.started, 1);
  // 模拟浏览器给一条最终结果
  rec.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: '今天很累' } }] });
  assert.deepEqual(finalTexts, ['今天很累']);
  session.stop();
  delete globalThis.SpeechRecognition;
});
