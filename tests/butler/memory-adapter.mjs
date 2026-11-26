/* tests/butler/memory-adapter.mjs
 * 内存 adapter：实现与 butler-db.js 相同的接口，供 Node 测试使用。
 * 通过共享 backing Object 模拟「刷新页面后重新连接同一数据库」。
 */

export function createMemoryAdapter(backing = {}) {
  for (const k of ['tasks', 'sleepLogs', 'cycles', 'meta']) {
    if (!backing[k]) backing[k] = new Map();
  }
  const A = {
    backing,
    async getAll(store) {
      if (!backing[store]) return [];
      return [...backing[store].values()].map(v => structuredClone(v));
    },
    async get(store, key) {
      if (!backing[store]) return undefined;
      const v = backing[store].get(key);
      return v === undefined ? undefined : structuredClone(v);
    },
    async put(store, value) {
      if (!backing[store]) backing[store] = new Map();
      backing[store].set(value.id ?? value.key, structuredClone(value));
      return value;
    },
    async remove(store, key) {
      if (backing[store]) backing[store].delete(key);
    },
    async getMeta(key) {
      const v = backing.meta.get(key);
      return v ? v.value : undefined;
    },
    async setMeta(key, value) {
      backing.meta.set(key, { key, value, updatedAt: Date.now() });
    },
  };
  return A;
}
