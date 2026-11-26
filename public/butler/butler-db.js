/* public/butler/butler-db.js
 * 生活管家 · IndexedDB 数据层
 * 独立数据库 star_butler_v1，与房间原 star_fifi_room 完全隔离。
 * 迁移策略：onupgradeneeded 只「补建」缺失的 store/index，绝不删除或重建已有 store。
 * 未来阶段新增字段可直接写入记录（IndexedDB 无 schema 约束）；
 * 新增 store 时提升 DB_VER 并在 UPGRADE_STEPS 里追加即可，旧数据保持不动。
 */

import { SCHEMA_VERSION } from './butler-core.js';

export const DB_NAME = 'star_butler_v1';
export const DB_VER = 2;

export const STORES = Object.freeze({
  TASKS: 'tasks',
  SLEEP: 'sleepLogs',
  CYCLES: 'cycles',
  META: 'meta',
  TXNS: 'transactions',
});

// 升级步骤：版本 -> 需要补建的 store/index。只增不删。
const UPGRADE_STEPS = {
  1: (db) => {
    if (!db.objectStoreNames.contains(STORES.TASKS)) {
      const s = db.createObjectStore(STORES.TASKS, { keyPath: 'id' });
      s.createIndex('by_date', 'date');
      s.createIndex('by_status', 'status');
    }
    if (!db.objectStoreNames.contains(STORES.SLEEP)) {
      const s = db.createObjectStore(STORES.SLEEP, { keyPath: 'id' });
      s.createIndex('by_date', 'date');
    }
    if (!db.objectStoreNames.contains(STORES.CYCLES)) {
      const s = db.createObjectStore(STORES.CYCLES, { keyPath: 'id' });
      s.createIndex('by_start', 'startDate');
    }
    if (!db.objectStoreNames.contains(STORES.META)) {
      db.createObjectStore(STORES.META, { keyPath: 'key' });
    }
  },
  // v2：新增记账 store（只补建，不触碰 v1 的任何数据）
  2: (db) => {
    if (!db.objectStoreNames.contains(STORES.TXNS)) {
      const s = db.createObjectStore(STORES.TXNS, { keyPath: 'id' });
      s.createIndex('by_date', 'date');
    }
  },
};

let dbPromise = null;

export function openButlerDB(factory) {
  const idb = factory || (typeof indexedDB !== 'undefined' ? indexedDB : null);
  if (!idb) return Promise.reject(new Error('当前环境不支持 IndexedDB'));
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = idb.open(DB_NAME, DB_VER);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        // 从 v1 到当前版本的每一步都执行，且全部是幂等的「补建」
        for (let v = e.oldVersion + 1; v <= DB_VER; v += 1) {
          const step = UPGRADE_STEPS[v];
          if (typeof step === 'function') step(db, e.target.transaction);
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { try { db.close(); } catch {} dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => { dbPromise = null; reject(req.error || new Error('打开生活管家数据库失败')); };
      // 被其他标签页挡住：清掉缓存的 promise，下次调用重新尝试（否则一次阻塞会永久失效）
      req.onblocked = () => { dbPromise = null; reject(new Error('数据库被其他标签页占用，请关闭其他标签页后重试')); };
    });
  }
  return dbPromise;
}

export function resetDBHandle() {
  dbPromise = null;
}

function tx(db, names, mode) {
  return db.transaction(names, mode);
}

function requestPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('数据库操作失败'));
  });
}

function txDone(t) {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error || new Error('事务失败'));
    t.onabort = () => reject(t.error || new Error('事务已中止'));
  });
}

export async function getAll(store) {
  const db = await openButlerDB();
  const t = tx(db, store, 'readonly');
  const rows = await requestPromise(t.objectStore(store).getAll());
  return Array.isArray(rows) ? rows : [];
}

export async function get(store, key) {
  const db = await openButlerDB();
  const t = tx(db, store, 'readonly');
  return requestPromise(t.objectStore(store).get(key));
}

export async function put(store, value) {
  const db = await openButlerDB();
  const t = tx(db, store, 'readwrite');
  t.objectStore(store).put(value);
  await txDone(t);
  return value;
}

export async function remove(store, key) {
  const db = await openButlerDB();
  const t = tx(db, store, 'readwrite');
  t.objectStore(store).delete(key);
  await txDone(t);
}

export async function clearStore(store) {
  const db = await openButlerDB();
  const t = tx(db, store, 'readwrite');
  t.objectStore(store).clear();
  await txDone(t);
}

export async function getMeta(key) {
  const row = await get(STORES.META, key);
  return row ? row.value : undefined;
}

export async function setMeta(key, value) {
  return put(STORES.META, { key, value, updatedAt: Date.now() });
}

// 首次初始化时记录 schema 版本；不覆盖已有值，便于未来做数据迁移判断
export async function ensureMeta() {
  const current = await getMeta('schemaVersion');
  if (current === undefined) await setMeta('schemaVersion', SCHEMA_VERSION);
  return getMeta('schemaVersion');
}
