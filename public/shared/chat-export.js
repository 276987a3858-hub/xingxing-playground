/* public/shared/chat-export.js — 聊天记录导出（只读，不改任何原始数据）
 *
 * 两种产物，用途不同：
 *   1) 单会话 Markdown：给人读、长期保存、贴到别处整理。
 *   2) 全部会话 JSON：机器可读，保留角色、时间、来源与附件引用，便于以后导入或再处理。
 *
 * 边界（硬约束）：
 *   - 只读取调用方传入的消息数组，不访问 IndexedDB / localStorage / 网络，不写任何存储。
 *   - 二进制（图片 dataURL、语音录音）不写进导出文件：Markdown 明确标注「未包含」，
 *     JSON 只保留类型、MIME、字节数、时长与语音片段 ID 这类可识别引用。原始文件仍靠「导出备份」。
 *   - 单条消息解析失败不中断整次导出：降级为一条「无法解析」记录并继续。
 *   - 不调用 AI、不发请求、不新增依赖。
 */
(function (root) {
  'use strict';

  var FORMAT = 'ylxh-chat-export';
  var VERSION = 1;
  var APP_NAME = '星星与用户的房间';
  var BINARY_NOTE = '图片与语音的原始文件不包含在本文件中（聊天记录导出只用于阅读与保存）；'
    + '此处保留类型、MIME、大小/时长与语音片段 ID，需要完整文件请使用「导出备份」。';
  var ROLE_NAME = { user: '用户', assistant: '小星' };
  var UNKNOWN_ROLE = '（未知角色）';

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function toDate(ms) {
    var n = Number(ms);
    if (!isFinite(n) || n <= 0) return null;
    var d = new Date(n);
    return isNaN(d.getTime()) ? null : d;
  }
  function dayText(ms) {
    var d = toDate(ms);
    if (!d) return '';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function clockText(ms) {
    var d = toDate(ms);
    if (!d) return '';
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function fullText(ms) {
    var day = dayText(ms);
    if (!day) return '';
    return day + ' ' + clockText(ms);
  }
  function isoText(ms) {
    var d = toDate(ms);
    return d ? d.toISOString() : null;
  }

  /* ---------------- 单条消息规范化（永不抛错） ---------------- */
  function attachmentOfImage(raw) {
    var s = String(raw || '');
    if (!s) return null;
    var mime = 'image/*';
    var m = /^data:([^;,]+)[;,]/.exec(s);
    if (m) mime = m[1];
    // dataURL 的 base64 长度约等于原始字节的 4/3；没有 base64 时按字符数粗估
    var bytes = 0;
    var comma = s.indexOf(',');
    if (comma >= 0) {
      var body = s.slice(comma + 1);
      bytes = /;base64/i.test(s.slice(0, comma)) ? Math.floor(body.length * 3 / 4) : body.length;
    }
    return { kind: 'image', mime: mime, bytes: bytes, embedded: false };
  }

  function normalize(raw) {
    var m = raw;
    if (!m || typeof m !== 'object') {
      return {
        id: null, role: 'other', speaker: UNKNOWN_ROLE, time: null,
        timeText: '', type: 'unknown', text: '（这条消息无法解析，已跳过正文）',
        english: null, silent: false, source: null, sourceId: null,
        attachments: [], error: 'invalid-record'
      };
    }
    var role = m.role === 'user' || m.role === 'assistant' ? m.role : 'other';
    var time = (typeof m.time === 'number' && isFinite(m.time)) ? m.time : null;
    var text = typeof m.content === 'string' ? m.content : (m.content == null ? '' : String(m.content));
    var english = typeof m.englishContent === 'string' && m.englishContent.trim() ? m.englishContent : null;

    var type = 'text';
    if (m.silent) type = 'silent';
    else if (m.type === 'voice' || (role === 'user' && m.audioClipId)) type = 'voice';
    else if (!text.trim() && m.image) type = 'image';

    var attachments = [];
    var img = attachmentOfImage(m.image);
    if (img) attachments.push(img);
    if (m.audioClipId || m.audioMime || m.type === 'voice') {
      attachments.push({
        kind: 'voice',
        clipId: m.audioClipId || null,
        mime: m.audioMime || null,
        durationMs: typeof m.durationMs === 'number' ? m.durationMs : null,
        asrStatus: m.asrStatus || null,
        embedded: false
      });
    }

    return {
      id: m.id == null ? null : m.id,
      role: role,
      speaker: ROLE_NAME[role] || UNKNOWN_ROLE,
      time: time,
      timeText: fullText(time),
      iso: isoText(time),
      type: type,
      text: text,
      english: english,
      silent: !!m.silent,
      silentReason: m.silent && m.silentReason ? String(m.silentReason) : null,
      source: m.source ? String(m.source) : null,
      sourceId: m.sourceId == null ? null : m.sourceId,
      attachments: attachments,
      error: null
    };
  }

  /* ---------------- 会话文档 ---------------- */
  function buildSession(opts) {
    var o = opts || {};
    var list = Array.isArray(o.messages) ? o.messages : [];
    var messages = [];
    var skipped = 0;
    var firstAt = null, lastAt = null;
    for (var i = 0; i < list.length; i++) {
      var one;
      try { one = normalize(list[i]); }
      catch (e) {
        skipped++;
        one = normalize(null);
        one.error = 'threw:' + (e && e.message ? e.message : 'unknown');
      }
      if (one.error) skipped++;
      if (typeof one.time === 'number') {
        if (firstAt === null || one.time < firstAt) firstAt = one.time;
        if (lastAt === null || one.time > lastAt) lastAt = one.time;
      }
      messages.push(one);
    }
    return {
      format: FORMAT,
      version: VERSION,
      app: APP_NAME,
      exportedAt: typeof o.now === 'number' ? o.now : Date.now(),
      session: {
        id: o.id || 'room',
        name: o.name || APP_NAME,
        messageCount: messages.length,
        firstAt: firstAt,
        lastAt: lastAt
      },
      binaryNote: BINARY_NOTE,
      skipped: skipped,
      messages: messages
    };
  }

  function buildAll(sessions, opts) {
    var o = opts || {};
    var docs = [];
    var list = Array.isArray(sessions) ? sessions : [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i] || {};
      docs.push(buildSession({ id: s.id, name: s.name, messages: s.messages, now: o.now }));
    }
    return {
      format: FORMAT,
      version: VERSION,
      app: APP_NAME,
      kind: 'all-sessions',
      exportedAt: typeof o.now === 'number' ? o.now : Date.now(),
      binaryNote: BINARY_NOTE,
      sessionCount: docs.length,
      messageCount: docs.reduce(function (n, d) { return n + d.session.messageCount; }, 0),
      sessions: docs
    };
  }

  /* ---------------- Markdown（单会话） ---------------- */
  function sizeText(bytes) {
    var b = Number(bytes) || 0;
    if (b <= 0) return '';
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return Math.round(b / 1024) + ' KB';
    return (Math.round(b / 104857.6) / 10) + ' MB';
  }

  function attachmentLines(a) {
    if (!a) return [];
    if (a.kind === 'image') {
      var size = sizeText(a.bytes);
      return ['> 📷 [图片：' + a.mime + (size ? '，约 ' + size : '') + '，未包含在导出中]'];
    }
    if (a.kind === 'voice') {
      var sec = a.durationMs ? (Math.round(a.durationMs / 100) / 10) + ' 秒' : '时长未知';
      return ['> 🎙️ [语音：' + sec + (a.mime ? '，' + a.mime : '')
        + (a.clipId ? '，片段 ID ' + a.clipId : '') + '，未包含在导出中]'];
    }
    return [];
  }

  function bodyOf(m) {
    if (m.type === 'silent') {
      var reason = m.silentReason ? '：' + m.silentReason : '';
      return ['（这一轮没有出声' + reason + '）'];
    }
    var lines = [];
    var text = String(m.text || '');
    if (text.trim()) lines = text.split(/\r?\n/);
    else if (m.attachments.length) lines = ['（没有文字）'];
    else lines = ['（空消息）'];
    m.attachments.forEach(function (a) { lines = lines.concat(attachmentLines(a)); });
    if (m.english) lines.push('', '*English:* ' + m.english);
    if (m.source) lines.push('', '<!-- 来源：' + m.source + (m.sourceId != null ? ' / ' + m.sourceId : '') + ' -->');
    return lines;
  }

  function toMarkdown(doc) {
    var d = doc || buildSession({});
    var s = d.session || {};
    var out = [];
    out.push('# ' + (s.name || APP_NAME) + ' · 聊天记录');
    out.push('');
    out.push('- 会话：' + (s.name || APP_NAME));
    out.push('- 导出时间：' + fullText(d.exportedAt));
    out.push('- 消息条数：' + (s.messageCount || 0) + ' 条');
    if (s.firstAt || s.lastAt) {
      out.push('- 时间范围：' + (fullText(s.firstAt) || '未知') + ' — ' + (fullText(s.lastAt) || '未知'));
    }
    out.push('- 说明：' + BINARY_NOTE);
    if (d.skipped) out.push('- 提示：有 ' + d.skipped + ' 条记录无法完整解析，已在正文中标出。');
    out.push('');
    out.push('---');
    out.push('');

    if (!d.messages || !d.messages.length) {
      out.push('（这个会话还没有消息。）');
      out.push('');
      return out.join('\n');
    }

    var lastDay = null;
    d.messages.forEach(function (m) {
      var day = dayText(m.time) || '时间未知';
      if (day !== lastDay) {
        out.push('## ' + day);
        out.push('');
        lastDay = day;
      }
      var clock = clockText(m.time);
      out.push('**' + m.speaker + '**' + (clock ? ' · ' + clock : ''));
      out.push('');
      bodyOf(m).forEach(function (line) { out.push(line); });
      out.push('');
    });
    return out.join('\n');
  }

  /* ---------------- JSON（全部会话） ---------------- */
  function toJSON(all) {
    var doc = all && all.sessions ? all : buildAll([], {});
    return JSON.stringify(doc, null, 2) + '\n';
  }

  /* ---------------- 文件名与下载 ---------------- */
  // 文件名精确到秒：同一分钟内连续导出两次也不会同名，避免互相覆盖
  function stamp(ms) {
    var d = toDate(ms) || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  }
  function fileName(kind, now, base) {
    var name = base || '星星与用户';
    return kind === 'all'
      ? name + '-全部会话-' + stamp(now) + '.json'
      : name + '-聊天记录-' + stamp(now) + '.md';
  }

  function download(text, filename, mime) {
    try {
      if (typeof text !== 'string' || !text) return false;
      if (typeof root.Blob !== 'function' || typeof root.URL === 'undefined') return false;
      var blob = new root.Blob([text], { type: mime || 'text/plain;charset=utf-8' });
      var url = root.URL.createObjectURL(blob);
      var a = root.document.createElement('a');
      a.href = url;
      a.download = filename || 'chat-export.txt';
      a.setAttribute('data-chat-export', '1');
      (root.document.body || root.document.documentElement).appendChild(a);
      a.click();
      if (a.parentNode) a.parentNode.removeChild(a);
      // 立刻 revoke 会让部分浏览器取消下载；延后释放，测试也能读到 Blob
      try { root.setTimeout(function () { try { root.URL.revokeObjectURL(url); } catch (e) {} }, 2000); } catch (e) {}
      return true;
    } catch (e) {
      return false;
    }
  }

  var api = {
    FORMAT: FORMAT,
    VERSION: VERSION,
    APP_NAME: APP_NAME,
    BINARY_NOTE: BINARY_NOTE,
    normalize: normalize,
    buildSession: buildSession,
    buildAll: buildAll,
    toMarkdown: toMarkdown,
    toJSON: toJSON,
    fileName: fileName,
    download: download,
    _time: { dayText: dayText, clockText: clockText, fullText: fullText, stamp: stamp, sizeText: sizeText }
  };

  root.ChatExport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
