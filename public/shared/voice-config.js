/* public/shared/voice-config.js — 语音能力的唯一配置点
 * 目的：服务商、地址、超时、冷却、录音参数集中在这里，聊天组件不出现任何服务商字样或专属参数。
 * 边界：纯常量，不发请求、不读写存储。
 * 更换 TTS / ASR：优先改本文件 + voice-service.js 的适配函数，聊天页面一行都不用动。
 */
(function (root) {
  'use strict';

  var CONFIG = {
    schema: 1,

    /* ---------------- TTS（文字转语音） ---------------- */
    tts: {
      // 适配器名：当前实现是 'proxy'（自建 worker 代理 ElevenLabs）。
      // 音色、稳定性、相似度等参数留在后端，前端不持有也不散落。
      adapter: 'proxy',
      // 部署后替换为你自己的语音代理地址（原项目地址已移除）
      endpoint: 'https://YOUR-TTS-PROXY.workers.dev/api/tts',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      maxChars: 1200,
      timeoutMs: 25000,
      // 失败冷却：额度耗尽 / 服务异常时，冷却期内直接跳过请求，不再每条回复都打一次
      failCooldownMs: 30 * 60 * 1000,
      cooldownKey: 'ylxh.chat.tts.cooldown.v1'
    },

    /* ---------------- ASR（语音转文字） ---------------- */
    asr: {
      // 'browser' = 浏览器内置听写（webkitSpeechRecognition）。换云端 ASR 时只改这里 + 适配器。
      adapter: 'browser',
      lang: 'zh-CN',
      interim: true,
      continuous: true,
      // 浏览器听写常在静音后自动结束，录音期间最多续接这么多次，避免死循环
      maxRestarts: 24
    },

    /* ---------------- 录音 ---------------- */
    recorder: {
      maxMs: 120 * 1000,          // 单条上限 2 分钟：约 0.2–1 MB，够用且不会撑爆本地库
      minMs: 500,                 // 短于这个时长按「没录到」处理
      timesliceMs: 1000,          // 分片落盘，避免长录音一次性积在内存
      maxBytes: 8 * 1024 * 1024,  // 单条硬上限，超了就提示换短一点
      // 优先 opus；iOS Safari 只支持 audio/mp4，逐个探测，全不支持就用浏览器默认
      mimeCandidates: [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        'audio/ogg;codecs=opus',
        'audio/ogg'
      ]
    },

    /* ---------------- 本地存储 ---------------- */
    store: {
      dbName: 'ylxh_chat_voice',
      version: 1,
      store: 'clips'
    },

    /* ---------------- 文案（集中管理，便于统一口径） ---------------- */
    text: {
      noAsr: '这个浏览器不支持听写，录音照常，发之前可以手动补一句。',
      asrFailed: '听写没能完成，录音已经保留，可以手动补文字或重新录。',
      clipSaveFailed: '语音没能存下来，这条先不发送，避免出现「有记录没有音频」。',
      ttsCooldown: '语音合成暂时不可用，先看文字回复。'
    }
  };

  root.VoiceConfig = CONFIG;
})(typeof globalThis !== 'undefined' ? globalThis : this);
