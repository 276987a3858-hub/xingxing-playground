/* ============================================================
   房间共同珍藏 · 共享数据访问层（唯一数据源）
   ------------------------------------------------------------
   - 数据仍然存放在房间使用的 IndexedDB：star_fifi_room / keeps
   - 不新建数据库、不新建 store、不复制数据、不做迁移
   - 游乐场（大厅珍藏入口）只通过这里读写，和房间看到的是同一批记录
   ============================================================ */

const DB_NAME = 'star_fifi_room';
const DB_VER = 3;
const STORE = 'keeps';

let dbPromise = null;

/** 建立与房间完全一致的表结构；已存在则直接复用 */
function openWithSchema() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = event => {
      const d = event.target.result;
      // 与 app.js 的 openDB 保持一致，仅补齐缺失的表，不动已有数据
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      if (!d.objectStoreNames.contains('messages')) d.createObjectStore('messages', { keyPath: 'id', autoIncrement: true });
      if (!d.objectStoreNames.contains('diaries')) d.createObjectStore('diaries', { keyPath: 'id', autoIncrement: true });
      if (!d.objectStoreNames.contains('starDiaries')) d.createObjectStore('starDiaries', { keyPath: 'id', autoIncrement: true });
      if (!d.objectStoreNames.contains('keeps')) d.createObjectStore('keeps', { keyPath: 'id', autoIncrement: true });
      if (!d.objectStoreNames.contains('futureLetters')) d.createObjectStore('futureLetters', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('房间数据库被其它标签页占用'));
  });
}

/** 打开房间数据库（不主动升级）：没有 keeps 表时再用房间的版本号建表 */
function openRoomDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME);
    } catch (e) {
      reject(e);
      return;
    }
    req.onupgradeneeded = () => { /* 首次创建，表结构交给下面按房间版本重建 */ };
    req.onsuccess = () => {
      const connection = req.result;
      if (connection.objectStoreNames.contains(STORE)) { resolve(connection); return; }
      const version = connection.version;
      connection.close();
      if (version >= DB_VER) { reject(new Error('房间数据库缺少 keeps 表')); return; }
      // 数据库还不完整（房间从未打开过）：按房间同样的版本号补齐表
      openWithSchema().then(resolve, reject);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('房间数据库被其它标签页占用'));
  }).catch(err => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

/** 统一读取：全部记录，按时间倒序（不改动任何字段） */
export async function listKeeps() {
  const db = await openRoomDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => {
      const rows = Array.isArray(req.result) ? req.result.slice() : [];
      rows.sort((a, b) => createdAtOf(b) - createdAtOf(a));
      resolve(rows);
    };
    req.onerror = () => reject(req.error);
  });
}

/** 写入成功后通知「小屋的动静」按需刷新（不轮询、不请求） */
function notifyFeed() {
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new Event('life:feed'));
    }
  } catch (e) { /* 通知失败不影响数据写入结果 */ }
}

/** 新增一条（供游戏内提议复用；普通结算不会自动调用） */
export async function addKeep(record) {
  const db = await openRoomDB();
  const row = { ...record };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).add(row);
    req.onsuccess = () => { notifyFeed(); resolve(req.result); };
    req.onerror = () => reject(req.error);
  });
}

/** 按事件标识查一条（防止同一件事重复提议；没有就用 null） */
export async function findKeepBySource(sourceId) {
  const key = String(sourceId || '');
  if (!key) return null;
  const rows = await listKeeps();
  return rows.find(row => row && (row.sourceId === key || row.sourceToken === key)) || null;
}

/** 局部更新（确认 / 暂不收录 / 星星回应都走这里） */
export async function updateKeep(id, patch) {
  const db = await openRoomDB();
  const numericId = Number(id);
  const target = Number.isFinite(numericId) ? numericId : id;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const get = store.get(target);
    get.onsuccess = () => {
      const current = get.result;
      if (!current) { resolve(false); return; }
      const next = { ...current, ...patch };
      const put = store.put(next);
      put.onsuccess = () => { notifyFeed(); resolve(true); };
      put.onerror = () => reject(put.error);
    };
    get.onerror = () => reject(get.error);
  });
}

/* ---------------- 兼容读取：旧记录字段不完整也能正常展示 ---------------- */

export function keepText(record) {
  if (!record) return '';
  return String(record.content || record.text || '');
}

export function createdAtOf(record) {
  if (!record) return 0;
  const n = Number(record.createdAt || record.confirmedAt || record.timestamp || 0);
  return Number.isFinite(n) ? n : 0;
}

/** 旧记录没有 status：按“已收录”对待（只影响展示，不写回数据） */
export function keepStatus(record) {
  const status = record && record.status;
  if (!status) return 'saved';
  return status;
}

export const KEEP_STATUS_LABELS = {
  saved: '已收录',
  waiting_star: '等待星星回应',
  waiting_user: '等待用户确认',
  rejected: '星星暂不收录',
  rejected_by_user: '用户暂不收录'
};

export function formatKeepDate(ts) {
  const n = Number(ts);
  if (!n) return '';
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return '';
  const pad = v => String(v).padStart(2, '0');
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
}
