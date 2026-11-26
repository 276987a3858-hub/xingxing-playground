/* public/shared/voice-store.js — 聊天语音的独立 Blob 存储
 * 为什么单独一个库：聊天消息里只留音频引用（audioClipId），原始音频按 Blob 存这里，
 * 不把 base64 长期堆在消息记录里；删消息时按 id 精确删，不会牵连声音素材库（ylxh_radio_voice）。
 *
 * 记录结构：{ id, blob(Blob), mime, size, durationMs, createdAt, messageId }
 *   messageId 只作溯源，判定「是否还有人用」一律以消息里的 audioClipId 为准。
 *
 * 边界：纯本地，不上传、不调任何语音服务、不生成 objectURL（交给调用方）。
 * 挂载：window.VoiceStore
 */
(function (root) {
  'use strict';

  var CFG = (root.VoiceConfig && root.VoiceConfig.store) || {};
  var DB_NAME = CFG.dbName || 'ylxh_chat_voice';
  var DB_VER = CFG.version || 1;
  var STORE = CFG.store || 'clips';

  var _dbPromise = null;

  function openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise(function (resolve, reject) {
      try {
        if (typeof indexedDB === 'undefined') throw new Error('当前环境不支持本地存储（IndexedDB 不可用）');
        var req = indexedDB.open(DB_NAME, DB_VER);
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { _dbPromise = null; reject(req.error || new Error('打开聊天语音库失败')); };
        req.onblocked = function () { _dbPromise = null; reject(new Error('聊天语音库被其他标签页占用，请关闭后重试')); };
      } catch (e) {
        _dbPromise = null;
        reject(e);
      }
    });
    return _dbPromise;
  }

  function txDone(tx) {
    return new Promise(function (res, rej) {
      tx.oncomplete = function () { res(); };
      tx.onerror = function () { rej(tx.error || new Error('语音库写入失败')); };
      tx.onabort = function () { rej(tx.error || new Error('语音库操作被中止')); };
    });
  }

  function reqDone(req) {
    return new Promise(function (res, rej) {
      req.onsuccess = function () { res(req.result); };
      req.onerror = function () { rej(req.error || new Error('语音库读取失败')); };
    });
  }

  function genId() {
    return 'vc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function normalize(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) return null;
    if (typeof Blob === 'undefined' || !(raw.blob instanceof Blob)) return null;
    if (!raw.blob.size) return null;
    return {
      id: raw.id,
      blob: raw.blob,
      mime: typeof raw.mime === 'string' && raw.mime ? raw.mime : (raw.blob.type || 'audio/webm'),
      size: raw.blob.size,
      durationMs: typeof raw.durationMs === 'number' && raw.durationMs >= 0 ? raw.durationMs : 0,
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
      messageId: raw.messageId == null ? null : raw.messageId
    };
  }

  function toMeta(rec) {
    return {
      id: rec.id,
      mime: rec.mime,
      size: rec.size,
      durationMs: rec.durationMs,
      createdAt: rec.createdAt,
      messageId: rec.messageId
    };
  }

  async function readAllRecords() {
    var db = await openDB();
    var tx = db.transaction(STORE, 'readonly');
    var rows = await reqDone(tx.objectStore(STORE).getAll());
    return (Array.isArray(rows) ? rows : [])
      .map(normalize)
      .filter(function (r) { return !!r && r.id.indexOf('__') !== 0; });   // 迁移标记不是业务数据
  }

  var API = {
    DB_NAME: DB_NAME,

    /** 保存一段录音：接受 Blob + 元数据，返回元数据（不含 blob）或 null。 */
    async save(input) {
      var src = input || {};
      var rec = normalize({
        id: genId(),
        blob: src.blob,
        mime: src.mime,
        durationMs: src.durationMs,
        createdAt: Date.now(),
        messageId: src.messageId
      });
      if (!rec) return null;
      try {
        var db = await openDB();
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(rec);
        await txDone(tx);
        return toMeta(rec);
      } catch (e) {
        console.warn('[chat-voice] 保存录音失败', e);
        return null;
      }
    },

    /** 备份恢复专用：保留原始 id 与时间，避免消息里的引用失效。 */
    async putRaw(input) {
      var rec = normalize(input);
      if (!rec) return null;
      try {
        var db = await openDB();
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(rec);
        await txDone(tx);
        return toMeta(rec);
      } catch (e) {
        console.warn('[chat-voice] 写入录音失败', e);
        return null;
      }
    },

    async getBlob(id) {
      if (typeof id !== 'string' || !id) return null;
      try {
        var db = await openDB();
        var tx = db.transaction(STORE, 'readonly');
        var rec = normalize(await reqDone(tx.objectStore(STORE).get(id)));
        return rec ? rec.blob : null;
      } catch (e) {
        console.warn('[chat-voice] 读取录音失败', e);
        return null;
      }
    },

    async getMeta(id) {
      if (typeof id !== 'string' || !id) return null;
      try {
        var db = await openDB();
        var tx = db.transaction(STORE, 'readonly');
        var rec = normalize(await reqDone(tx.objectStore(STORE).get(id)));
        return rec ? toMeta(rec) : null;
      } catch (e) {
        return null;
      }
    },

    /** 全部录音的 Blob（备份用）；孤儿不会自动剔除，由 pruneUnused 负责。 */
    async allWithBlob() {
      try { return await readAllRecords(); } catch (e) { return []; }
    },

    async list() {
      try { return (await readAllRecords()).map(toMeta); } catch (e) { return []; }
    },

    async remove(id) {
      if (typeof id !== 'string' || !id) return false;
      try {
        var db = await openDB();
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(id);
        await txDone(tx);
        return true;
      } catch (e) {
        console.warn('[chat-voice] 删除录音失败', e);
        return false;
      }
    },

    async removeMany(ids) {
      var list = (ids || []).filter(function (x) { return typeof x === 'string' && x; });
      if (!list.length) return 0;
      try {
        var db = await openDB();
        var tx = db.transaction(STORE, 'readwrite');
        var os = tx.objectStore(STORE);
        list.forEach(function (id) { os.delete(id); });
        await txDone(tx);
        return list.length;
      } catch (e) {
        console.warn('[chat-voice] 批量删除录音失败', e);
        return 0;
      }
    },

    /** 只保留 keepIds 里还活着的录音；其余视为孤儿（发送失败 / 消息已删）。 */
    async pruneUnused(keepIds) {
      var keep = keepIds instanceof Set ? keepIds : new Set(keepIds || []);
      var rows = await this.allWithBlob();
      var dead = rows.filter(function (r) { return !keep.has(r.id); }).map(function (r) { return r.id; });
      if (!dead.length) return 0;
      return this.removeMany(dead);
    },

    async setMessageId(id, messageId) {
      if (typeof id !== 'string' || !id) return false;
      try {
        var db = await openDB();
        var tx = db.transaction(STORE, 'readwrite');
        var os = tx.objectStore(STORE);
        var rec = normalize(await reqDone(os.get(id)));
        if (!rec) { tx.abort(); return false; }
        rec.messageId = messageId == null ? null : messageId;
        os.put(rec);
        await txDone(tx);
        return true;
      } catch (e) {
        return false;
      }
    },

    async clear() {
      try {
        var db = await openDB();
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).clear();
        await txDone(tx);
        return true;
      } catch (e) {
        console.warn('[chat-voice] 清空录音失败', e);
        return false;
      }
    },

    async count() {
      try {
        var db = await openDB();
        var tx = db.transaction(STORE, 'readonly');
        return await reqDone(tx.objectStore(STORE).count());
      } catch (e) { return 0; }
    }
  };

  root.VoiceStore = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
