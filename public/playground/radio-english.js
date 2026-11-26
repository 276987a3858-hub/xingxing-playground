// playground/radio-english.js
// 午夜电台 · 英文广播素材层
// 职责：
//   1) 有限检索聊天记录里「已经存下原声」的英文消息（游标倒序，不全文扫描）
//   2) 原声直接读 messages.audioData（重播按钮用的同一份数据），不重新生成
//   3) 只有还没有原声的原创节目才会请求一次 TTS，并缓存到本机 IndexedDB
//   4) 语音额度不足时记录冷却时间，避免反复请求失败
// 边界：只读房间数据库（不升级版本、不改结构）；不新建第二套节目库（节目仍存 radioStore）。
// 复用原则：聊天英文只有文字、没有 audioData 时，不当作历史语音接入。

const ROOM_DB = 'star_fifi_room';
const MSG_STORE = 'messages';

const EN_DB = 'ylxh_radio_en';
const EN_VER = 1;
const EN_STORE = 'audio';

const TTS_URL = 'https://YOUR-TTS-PROXY.workers.dev/api/tts';
const TTS_TIMEOUT = 90000;
const COOLDOWN_KEY = 'ylxh.radio.en.voiceCooldown';
const COOLDOWN_MS = 30 * 60 * 1000;      // 失败后 30 分钟内不再自动请求
const MAX_TEXT = 900;                     // 单段文本上限（约 2~3 分钟语音）

// 明显不适合搬进广播的私人内容（只是第一道闸，具体选哪段仍由她决定）
const PRIVATE_RE = /(密码|住址|家庭地址|身份证|银行卡|手机号|电话号码|工资|password|passcode|address|phone number|bank card|id card)/i;

/* ---------------- 房间消息：只读、有限检索 ---------------- */

let roomDbPromise = null;

function openRoomDB() {
  if (roomDbPromise) return roomDbPromise;
  roomDbPromise = new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(ROOM_DB);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(MSG_STORE)) {
          db.close();
          reject(new Error('还没有聊天记录'));
          return;
        }
        resolve(db);
      };
      req.onerror = () => reject(req.error || new Error('读取聊天记录失败'));
    } catch (err) {
      reject(err);
    }
  }).catch(err => {
    roomDbPromise = null;
    throw err;
  });
  return roomDbPromise;
}

function hashText(text) {
  let h = 5381;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return 'en_' + (h >>> 0).toString(36) + '_' + s.length.toString(36);
}

// 聊天里的原声是 FileReader.readAsDataURL 的结果（data:audio/mpeg;base64,...）。
// 这里只做本地解码，不请求任何接口。
function dataUrlToBlob(dataUrl) {
  const s = String(dataUrl || '');
  const comma = s.indexOf(',');
  if (comma < 0) return null;
  const head = s.slice(0, comma);
  if (!/;base64/i.test(head)) return null;
  const mime = (head.match(/^data:([^;,]+)/i) || [])[1] || 'audio/mpeg';
  try {
    const bin = atob(s.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: mime });
    return blob.size ? blob : null;
  } catch (e) {
    return null;
  }
}

async function getMessageById(id) {
  const db = await openRoomDB();
  const asNumber = Number(id);
  const key = Number.isFinite(asNumber) && String(asNumber) === String(id) ? asNumber : id;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MSG_STORE, 'readonly');
    const req = tx.objectStore(MSG_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export const radioEnglish = {
  hashText,
  dataUrlToBlob,

  /**
   * 从最近的聊天里找「已经存下原声」的英文消息（游标倒序，最多看 limit 条助手消息）。
   * 只认 messages.audioData 真实存在的那批——它们和聊天里的重播按钮是同一份音频。
   */
  async scanChat(limit = 150) {
    const db = await openRoomDB();
    return new Promise((resolve, reject) => {
      const out = [];
      let seen = 0;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve(out);
      };
      const tx = db.transaction(MSG_STORE, 'readonly');
      const req = tx.objectStore(MSG_STORE).openCursor(null, 'prev');
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) { finish(); return; }
        const m = cur.value;
        if (!m || m.role !== 'assistant') { cur.continue(); return; }
        seen += 1;
        if (seen > limit || out.length >= 12) { finish(); return; }
        const en = String(m.englishContent || '').trim();
        const audio = typeof m.audioData === 'string' ? m.audioData : '';
        if (en.length >= 40 && en.length <= MAX_TEXT && m.id != null && audio.length > 64
          && !PRIVATE_RE.test(en) && !PRIVATE_RE.test(String(m.content || ''))) {
          out.push({
            messageId: String(m.id),
            en,
            zh: String(m.content || '').trim(),
            at: typeof m.time === 'number' ? m.time : 0,
          });
        }
        cur.continue();
      };
      req.onerror = () => {
        if (settled) return;
        settled = true;
        reject(req.error);
      };
    });
  },

  /**
   * 按外键（'msg:<id>'）取出聊天里那条消息的原声。
   * 只读、可播才返回；没有 audioData 或解码失败一律返回 null（调用方不得据此补生成）。
   */
  async getOriginalAudio(externalId) {
    const raw = String(externalId || '');
    if (!raw.startsWith('msg:')) return null;
    const id = raw.slice(4);
    if (!id) return null;
    let msg = null;
    try { msg = await getMessageById(id); } catch (e) { return null; }
    const blob = dataUrlToBlob(msg && msg.audioData);
    if (!blob) return null;
    return { blob, key: raw, messageId: id, at: typeof msg.time === 'number' ? msg.time : 0 };
  },

  /* ---------------- 语音缓存 ---------------- */

  _dbPromise: null,

  openCacheDB() {
    if (this._dbPromise) return this._dbPromise;
    this._dbPromise = new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open(EN_DB, EN_VER);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(EN_STORE)) db.createObjectStore(EN_STORE, { keyPath: 'key' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => {
          this._dbPromise = null;
          reject(req.error || new Error('打开语音缓存失败'));
        };
      } catch (err) {
        this._dbPromise = null;
        reject(err);
      }
    });
    return this._dbPromise;
  },

  async getCachedBlob(key) {
    try {
      const db = await this.openCacheDB();
      const rec = await new Promise((resolve, reject) => {
        const tx = db.transaction(EN_STORE, 'readonly');
        const req = tx.objectStore(EN_STORE).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
      return rec && rec.blob instanceof Blob && rec.blob.size > 0 ? rec.blob : null;
    } catch (e) {
      return null;
    }
  },

  async putCachedBlob(key, blob, text) {
    try {
      const db = await this.openCacheDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(EN_STORE, 'readwrite');
        tx.objectStore(EN_STORE).put({ key, blob, text: String(text || '').slice(0, 120), createdAt: Date.now() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      return true;
    } catch (e) {
      return false;
    }
  },

  /* ---------------- 语音额度冷却 ---------------- */

  cooldownUntil() {
    try {
      const n = Number(localStorage.getItem(COOLDOWN_KEY) || 0);
      return Number.isFinite(n) ? n : 0;
    } catch (e) {
      return 0;
    }
  },

  isCoolingDown() {
    return this.cooldownUntil() > Date.now();
  },

  markFailed() {
    try { localStorage.setItem(COOLDOWN_KEY, String(Date.now() + COOLDOWN_MS)); } catch (e) { /* ignore */ }
  },

  clearCooldown() {
    try { localStorage.removeItem(COOLDOWN_KEY); } catch (e) { /* ignore */ }
  },

  /**
   * 取一段英文语音：有缓存直接用；没有就请求一次并缓存。
   * 冷却期内或请求失败都会抛错，由调用方把节目标成「语音尚未生成」。
   */
  async ensureVoice(text) {
    const clean = String(text || '').trim();
    if (!clean) throw new Error('这段还没有英文文字');
    const key = hashText(clean);

    const cached = await this.getCachedBlob(key);
    if (cached) return { key, blob: cached, cached: true };

    if (this.isCoolingDown()) {
      const err = new Error('语音额度还没恢复，稍后再试');
      err.code = 'COOLDOWN';
      throw err;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TTS_TIMEOUT);
    try {
      const res = await fetch(TTS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: clean.slice(0, 1500) }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error('语音服务返回 ' + res.status);
      const blob = await res.blob();
      if (!blob || !blob.size) throw new Error('语音服务返回了空内容');
      await this.putCachedBlob(key, blob, clean);
      this.clearCooldown();
      return { key, blob, cached: false };
    } catch (err) {
      clearTimeout(timer);
      // 额度/网络类失败：进入冷却，避免她连续点几次就连续失败几次
      this.markFailed();
      const e = new Error(err && err.name === 'AbortError' ? '语音准备超时了' : (err.message || '语音生成失败'));
      e.code = 'FAILED';
      throw e;
    }
  },
};
