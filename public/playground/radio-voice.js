// playground/radio-voice.js
// 午夜电台 · 中文声音素材库（独立数据层）
// 职责：把用户本地上传的音频 Blob 存入独立 IndexedDB，提供列表/读取/重命名/删除等管理能力。
// 边界：纯本地存储；不上传服务器、不调用 ElevenLabs、不做声音克隆、不自动关联任何节目。
//      播放交给 radio-voice-audio.js，试听由调用方取 blob 后进行。

const DB_NAME = 'ylxh_radio_voice';
const DB_VER = 1;
const STORE = 'clips';

// 单条记录结构：
// { id, name, blob(Blob), mime, size, duration, createdAt, updatedAt, inMusic, use }
// duration 由调用方在写入前探测填入（本模块不解码音频）。
// inMusic: 旧版「加入音乐频道」标记（保留兼容，不再作为唯一依据）。
// use: 用途分类 'music' | 'sleep' | 'both' | 'none'；一段音频可同时属于音乐与哄睡。
//      旧记录没有 use 时不猜用途：原本 inMusic=true 视为 music（这是用户当初的明确选择），
//      否则为 none（暂不分类），由用户自行设置。仅标记，不改动原始文件与记录本身。

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    try {
      if (typeof indexedDB === 'undefined') {
        throw new Error('当前环境不支持本地存储（IndexedDB 不可用）');
      }
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        _dbPromise = null;
        reject(req.error || new Error('打开声音素材库失败'));
      };
      req.onblocked = () => {
        _dbPromise = null;
        reject(new Error('声音素材库被其他标签页占用，请关闭后重试'));
      };
    } catch (err) {
      _dbPromise = null;
      reject(err);
    }
  });
  return _dbPromise;
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('素材库写入失败'));
    tx.onabort = () => reject(tx.error || new Error('素材库操作被中止'));
  });
}

function reqDone(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('素材库读取失败'));
  });
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) return null;
  if (!(raw.blob instanceof Blob)) return null;
  return {
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name ? raw.name : '未命名录音',
    blob: raw.blob,
    mime: typeof raw.mime === 'string' ? raw.mime : (raw.blob.type || 'audio/*'),
    size: typeof raw.size === 'number' && raw.size >= 0 ? raw.size : raw.blob.size,
    duration: typeof raw.duration === 'number' && raw.duration >= 0 ? raw.duration : 0,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
    inMusic: raw.inMusic === true,
    use: (() => {
      if (['music', 'sleep', 'both', 'none'].includes(raw.use)) return raw.use;
      return raw.inMusic === true ? 'music' : 'none';   // 旧数据：只沿用用户当初的显式选择
    })(),
  };
}

// 对外只暴露元数据（不含 Blob），避免大对象在 UI 层被误用
function toMeta(rec) {
  return {
    id: rec.id,
    name: rec.name,
    mime: rec.mime,
    size: rec.size,
    duration: rec.duration,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    inMusic: rec.inMusic === true,
    use: rec.use,
  };
}

function genId() {
  return 'clip_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

export const radioVoice = {
  // ---------- 写 ----------

  // 新增素材：接受 File 或 Blob + 名称；返回元数据或 null
  async add(name, blob, duration = 0) {
    if (!(blob instanceof Blob) || blob.size <= 0) return null;
    const now = Date.now();
    const rec = normalize({
      id: genId(),
      name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : '未命名录音',
      blob,
      mime: blob.type || 'audio/*',
      size: blob.size,
      duration: typeof duration === 'number' && duration >= 0 ? duration : 0,
      createdAt: now,
      updatedAt: now,
    });
    if (!rec) return null;
    try {
      const db = await openDB();
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(rec);
      await txDone(tx);
      return toMeta(rec);
    } catch (err) {
      console.warn('[radio-voice] 保存素材失败', err);
      return null;
    }
  },

  async rename(id, name) {
    if (typeof id !== 'string' || typeof name !== 'string' || !name.trim()) return false;
    try {
      const db = await openDB();
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const rec = normalize(await reqDone(store.get(id)));
      if (!rec) {
        tx.abort();
        return false;
      }
      rec.name = name.trim().slice(0, 80);
      rec.updatedAt = Date.now();
      store.put(rec);
      await txDone(tx);
      return true;
    } catch (err) {
      console.warn('[radio-voice] 重命名素材失败', err);
      return false;
    }
  },

  // 设置用途分类：music / sleep / both / none；仅改标记，不删除原始文件
  async setUse(id, use) {
    if (typeof id !== 'string' || !id) return false;
    if (!['music', 'sleep', 'both', 'none'].includes(use)) return false;
    try {
      const db = await openDB();
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const rec = normalize(await reqDone(store.get(id)));
      if (!rec) {
        tx.abort();
        return false;
      }
      rec.use = use;
      rec.inMusic = (use === 'music' || use === 'both');   // 旧字段保持同步，旧代码仍可用
      rec.updatedAt = Date.now();
      store.put(rec);
      await txDone(tx);
      return true;
    } catch (err) {
      console.warn('[radio-voice] 更新用途失败', err);
      return false;
    }
  },

  // 按用途筛选（晚安哄睡用 sleep/both，音乐频道用 music/both）
  async listByUse(kind) {
    const all = await this.list();
    if (kind === 'sleep') return all.filter(m => m.use === 'sleep' || m.use === 'both');
    if (kind === 'music') return all.filter(m => m.use === 'music' || m.use === 'both');
    if (kind === 'none') return all.filter(m => m.use === 'none');
    return all;
  },

  // 设置素材是否加入音乐频道随机抽取范围；仅改标记，不删除原始文件
  async setInMusic(id, enabled) {
    if (typeof id !== 'string' || !id) return false;
    try {
      const db = await openDB();
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const rec = normalize(await reqDone(store.get(id)));
      if (!rec) {
        tx.abort();
        return false;
      }
      rec.inMusic = enabled === true;
      // 用途随之同步：加入音乐=music（本来就用于哄睡则 both），取消=退出音乐（仍在哄睡则 sleep）
      if (enabled === true) rec.use = rec.use === 'sleep' ? 'both' : 'music';
      else rec.use = rec.use === 'both' ? 'sleep' : (rec.use === 'music' ? 'none' : rec.use);
      rec.updatedAt = Date.now();
      store.put(rec);
      await txDone(tx);
      return true;
    } catch (err) {
      console.warn('[radio-voice] 更新音乐频道资格失败', err);
      return false;
    }
  },

  // 已加入音乐频道随机抽取范围的素材元数据（按创建时间倒序）
  async listInMusic() {
    const all = await this.list();
    return all.filter(m => m.inMusic === true);
  },

  async remove(id) {
    if (typeof id !== 'string' || !id) return false;
    try {
      const db = await openDB();
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      await txDone(tx);
      return true;
    } catch (err) {
      console.warn('[radio-voice] 删除素材失败', err);
      return false;
    }
  },

  // ---------- 读 ----------

  // 素材列表（仅元数据），按创建时间倒序
  async list() {
    try {
      const db = await openDB();
      const tx = db.transaction(STORE, 'readonly');
      const rows = await reqDone(tx.objectStore(STORE).getAll());
      return (Array.isArray(rows) ? rows : [])
        .map(normalize)
        .filter(Boolean)
        .map(toMeta)
        .sort((a, b) => b.createdAt - a.createdAt);
    } catch (err) {
      console.warn('[radio-voice] 读取素材列表失败', err);
      return [];
    }
  },

  // 取单条元数据
  async get(id) {
    if (typeof id !== 'string' || !id) return null;
    try {
      const db = await openDB();
      const tx = db.transaction(STORE, 'readonly');
      const rec = normalize(await reqDone(tx.objectStore(STORE).get(id)));
      return rec ? toMeta(rec) : null;
    } catch (err) {
      console.warn('[radio-voice] 读取素材失败', err);
      return null;
    }
  },

  // 取音频 Blob（供 radio-voice-audio 试听使用），不在此处创建 objectURL
  async getBlob(id) {
    if (typeof id !== 'string' || !id) return null;
    try {
      const db = await openDB();
      const tx = db.transaction(STORE, 'readonly');
      const rec = normalize(await reqDone(tx.objectStore(STORE).get(id)));
      return rec ? rec.blob : null;
    } catch (err) {
      console.warn('[radio-voice] 读取音频数据失败', err);
      return null;
    }
  },

  async count() {
    return (await this.list()).length;
  },
};
