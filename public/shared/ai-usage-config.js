// shared/ai-usage-config.js
// API 用量统计的唯一配置点：价格表、存储键、保留条数、请求类型名称。
// 价格单位：USD / 1M tokens。默认值按 DeepSeek 官方价目（2026-11-22 核对）：
//   deepseek-flash：cache hit 0.003 / cache miss 0.15 / output 0.60，高峰时段翻倍。
// 价格会变，改这里即可，不必动任何请求逻辑；历史记录保留写入当时的估算值。
(function (root) {
  'use strict';

  var prices = {
    'deepseek-flash': { hit: 0.003, miss: 0.15, output: 0.60 },
    // deepseek-chat 是旧别名，按 flash 计费
    'deepseek-chat': { hit: 0.003, miss: 0.15, output: 0.60 },
    'deepseek-v4-pro': { hit: 0.022, miss: 0.66, output: 1.98 }
  };

  var config = {
    storageKey: 'ylxh.ai.usage.v1',
    maxRecords: 2000,          // 环形缓冲，约 1000 轮对话
    usdToCny: 7.1,             // 仅用于人民币展示的参考汇率，可自行修改
    peakMultiplier: 2,
    prices: prices,
    requestTypes: {
      chat: '主聊天',
      translate: '英文翻译',
      memory: '记忆整理',
      star: '主动关心／特殊互动',
      letter: '来信',
      diary: '日记',
      keep: '珍藏提议',
      touch: '触摸互动',
      'self-narrative-review': '机自述单批试跑',
      other: '其他'
    }
  };

  function priceOf(model) {
    return prices[model] || prices['deepseek-flash'];
  }

  // DeepSeek 高峰：UTC 周一至周五 01:00-04:00、06:00-10:00（北京时间 09-12、14-18）
  function isPeak(ts) {
    var d = ts instanceof Date ? ts : new Date(ts);
    var day = d.getUTCDay();
    if (day === 0 || day === 6) return false;
    var h = d.getUTCHours();
    return (h >= 1 && h < 4) || (h >= 6 && h < 10);
  }

  root.AIUsageConfig = {
    config: config,
    prices: prices,
    priceOf: priceOf,
    isPeak: isPeak
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
