/* public/butler/butler-repository.js
 * 生活管家 · 业务/仓储层
 * 只依赖一个 adapter（getAll/get/put/remove/getMeta/setMeta），
 * 浏览器里 adapter 来自 butler-db.js，Node 测试里可注入内存 adapter。
 * 不含 DOM、不含网络，不调用任何 AI。
 */

import * as core from './butler-core.js';
import * as DB from './butler-db.js';

const { STORES } = DB;

// 浏览器默认 adapter；Node 测试通过 createRepository(adapter) 注入
export const indexedDBAdapter = {
  getAll: (store) => DB.getAll(store),
  get: (store, key) => DB.get(store, key),
  put: (store, value) => DB.put(store, value),
  remove: (store, key) => DB.remove(store, key),
  getMeta: (key) => DB.getMeta(key),
  setMeta: (key, value) => DB.setMeta(key, value),
};

function now() { return Date.now(); }

function sortTasks(rows) {
  return [...rows].sort((a, b) => {
    const d = core.compareDay(a.date, b.date);
    if (d !== 0) return d;
    return String(a.time || '').localeCompare(String(b.time || ''));
  });
}

function validateTask(input) {
  if (!input || typeof input.title !== 'string' || !input.title.trim()) throw new Error('请填写事项内容。');
  if (!core.isValidDay(input.date)) throw new Error('请选择有效日期。');
  if (input.time && core.parseHHMM(input.time) === null) throw new Error('时间格式应为 HH:MM。');
  if (input.remindAt !== undefined && input.remindAt !== null && input.remindAt !== '' && !Number.isFinite(Number(input.remindAt))) {
    throw new Error('提醒时间格式不正确。');
  }
}

const TX_TYPES = ['expense', 'income'];
const TX_CATEGORIES = ['餐饮', '交通', '购物', '日用', '娱乐', '其他'];
const TX_INCOME_CATEGORIES = ['工资', '红包', '理财', '其他'];

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function validateTx(input) {
  if (!input) throw new Error('记录内容不能为空。');
  const type = TX_TYPES.includes(input.type) ? input.type : 'expense';
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('金额需要是大于 0 的数字。');
  if (amount > 1e9) throw new Error('金额太大了。');
  if (!core.isValidDay(input.date)) throw new Error('请选择有效日期。');
  const pool = type === 'income' ? TX_INCOME_CATEGORIES : TX_CATEGORIES;
  const category = pool.includes(input.category) ? input.category : '其他';
  return { type, amount: round2(amount), category, date: input.date, note: String(input.note || '').trim() };
}

function txDescribe(rec) {
  const arrow = rec.type === 'income' ? '收入' : '支出';
  return `${rec.date} ${arrow} ¥${rec.amount}（${rec.category}）${rec.note ? ' ' + rec.note : ''}`;
}

export function createRepository(adapter) {
  const A = adapter;
  const S = core;
  const T = STORES;

  function changed(type, detail) {
    if (typeof window === 'undefined' || typeof window.CustomEvent !== 'function') return;
    window.dispatchEvent(new window.CustomEvent('butler:change', { detail: { type, detail, at: Date.now() } }));
  }

  // P1-b：真实写入成功后才登记生活事件（本地 localStorage，不发请求、不影响记账/提醒）
  function emitLife(kind, task, status) {
    try {
      const LE = typeof window !== 'undefined' ? window.LifeEvents : null;
      if (!LE || !task || !task.id) return;
      const at = (kind === 'done' ? task.completedAt : task.updatedAt) || Date.now();
      LE.record({
        id: `butler:task:${task.id}:${kind}:${at}`,
        at,
        day: task.date || null,
        source: 'butler',
        type: `task.${kind}`,
        status: status || (kind === 'add' ? 'planned' : 'occurred'),
        title: task.title || '',
      });
    } catch (e) { /* 事件登记失败不影响主流程 */ }
  }

  const repo = {
    /* ---------------- 任务 ---------------- */
    async listTasks() {
      const rows = await A.getAll(T.TASKS);
      return sortTasks(rows.filter(r => r && r.id));
    },

    async getTask(id) {
      return A.get(T.TASKS, id);
    },

    async addTask(input) {
      validateTask(input);
      const t = now();
      const task = {
        id: S.uid('task'),
        type: input.type === 'event' ? 'event' : 'todo',
        title: input.title.trim(),
        note: String(input.note || ''),
        date: input.date,
        time: input.time || '',
        remindAt: input.remindAt === '' || input.remindAt === undefined ? null : Number(input.remindAt) || null,
        status: S.TASK_STATUS.PENDING,
        createdAt: t,
        updatedAt: t,
        completedAt: null,
        history: [],
        v: S.SCHEMA_VERSION,
      };
      S.pushHistory(task, 'created', `新建${task.type === 'event' ? '日程' : '待办'}：${S.describeTask(task)}`);
      await A.put(T.TASKS, task);
      emitLife('add', task, 'planned');
      changed('task:add', task.id);
      return task;
    },

    async updateTask(id, patch) {
      const task = await A.get(T.TASKS, id);
      if (!task) throw new Error('事项不存在。');
      const next = { ...task, ...patch, id: task.id, history: task.history || [] };
      // 改了日期或时间：旧提醒时刻作废（除非这次明确给了不同的提醒时刻）
      const timeChanged = (patch.date !== undefined && patch.date !== task.date)
        || (patch.time !== undefined && patch.time !== task.time);
      if (timeChanged) {
        const keepNewRemind = patch.remindAt !== undefined && Number(patch.remindAt) !== Number(task.remindAt);
        if (!keepNewRemind) next.remindAt = null;
      }
      validateTask(next);
      if (patch.status !== undefined && patch.status !== task.status && !S.canTransition(task.status, patch.status)) {
        throw new Error('不允许的状态变化。');
      }
      next.updatedAt = now();
      S.pushHistory(next, 'updated', `修改事项：${S.describeTask(next)}`);
      await A.put(T.TASKS, next);
      changed('task:update', id);
      return next;
    },

    async completeTask(id) {
      const task = await A.get(T.TASKS, id);
      if (!task) throw new Error('事项不存在。');
      if (task.status === S.TASK_STATUS.DONE) return task;
      if (!S.canTransition(task.status, S.TASK_STATUS.DONE)) throw new Error('已取消的事项不能标记完成。');
      const next = {
        ...task,
        status: S.TASK_STATUS.DONE,
        completedAt: now(),
        updatedAt: now(),
        history: task.history || [],
      };
      S.pushHistory(next, 'done', `标记完成，实际完成时间：${new Date(next.completedAt).toLocaleString('zh-CN')}`);
      await A.put(T.TASKS, next);
      emitLife('done', next);
      changed('task:done', id);
      return next;
    },

    async cancelTask(id) {
      const task = await A.get(T.TASKS, id);
      if (!task) throw new Error('事项不存在。');
      if (task.status === S.TASK_STATUS.CANCELLED) return task;
      if (!S.canTransition(task.status, S.TASK_STATUS.CANCELLED)) throw new Error('已完成的事项不能取消，请先重新打开。');
      const next = { ...task, status: S.TASK_STATUS.CANCELLED, updatedAt: now(), history: task.history || [] };
      S.pushHistory(next, 'cancelled', '取消事项');
      await A.put(T.TASKS, next);
      emitLife('cancel', next);
      changed('task:cancel', id);
      return next;
    },

    async reopenTask(id) {
      const task = await A.get(T.TASKS, id);
      if (!task) throw new Error('事项不存在。');
      if (task.status === S.TASK_STATUS.PENDING) return task;
      const next = { ...task, status: S.TASK_STATUS.PENDING, completedAt: null, updatedAt: now(), history: task.history || [] };
      S.pushHistory(next, 'reopened', '重新打开事项');
      await A.put(T.TASKS, next);
      changed('task:reopen', id);
      return next;
    },

    // 延期：更新原事项的日期/时间，不新建记录
    async deferTask(id, { date, time, note } = {}) {
      const task = await A.get(T.TASKS, id);
      if (!task) throw new Error('事项不存在。');
      const nextDate = date || task.date;
      const nextTime = time === undefined ? task.time : time;
      const timeChanged = nextDate !== task.date || nextTime !== task.time;
      const next = {
        ...task,
        date: nextDate,
        time: nextTime,
        note: note === undefined ? task.note : String(note),
        // 时间改了：旧提醒作废，按新时间重新算提前 10 分钟，不让旧提醒残留
        remindAt: timeChanged ? null : task.remindAt,
        status: S.TASK_STATUS.PENDING,
        completedAt: null,
        updatedAt: now(),
        history: task.history || [],
      };
      const before = `${task.date}${task.time ? ' ' + task.time : ''}`;
      const after = `${next.date}${next.time ? ' ' + next.time : ''}`;
      S.pushHistory(next, 'deferred', `延期：${before} → ${after}（原事项更新，未新建）`);
      await A.put(T.TASKS, next);
      emitLife('defer', next);
      changed('task:defer', id);
      return next;
    },

    async removeTask(id) {
      await A.remove(T.TASKS, id);
      changed('task:remove', id);
    },

    /* ---------------- 作息 ---------------- */
    async listSleep() {
      const rows = await A.getAll(T.SLEEP);
      return [...rows].filter(r => r && r.id).sort((a, b) => core.compareDay(b.date, a.date));
    },

    // 按「起床日期」补录/修改：同一天只保留一条，重复写入视为修改
    async saveSleep(input) {
      if (!core.isValidDay(input.date)) throw new Error('请选择有效的起床日期。');
      if (!input.sleepTime || !input.wakeTime) throw new Error('请填写入睡和起床时间。');
      const built = core.buildSleepRecord(input);
      const rows = await A.getAll(T.SLEEP);
      const existing = rows.find(r => r.date === input.date);
      const rec = existing
        ? {
            ...built,
            id: existing.id,
            createdAt: existing.createdAt,
            history: existing.history || [],
          }
        : built;
      if (existing) S.pushHistory(rec, 'updated', `补录/修改：${rec.sleepDate} ${rec.sleepTime} 入睡，${rec.date} ${rec.wakeTime} 起床（${S.formatDuration(rec.durationMs)}）`);
      else S.pushHistory(rec, 'created', `记录睡眠：${rec.sleepDate} ${rec.sleepTime} 入睡，${rec.date} ${rec.wakeTime} 起床（${S.formatDuration(rec.durationMs)}）`);
      await A.put(T.SLEEP, rec);
      changed('sleep:save', rec.id);
      return rec;
    },

    async removeSleep(id) {
      await A.remove(T.SLEEP, id);
      changed('sleep:remove', id);
    },

    /* ---------------- 周期 ---------------- */
    async listCycles() {
      const rows = await A.getAll(T.CYCLES);
      return core.cyclesWithLengths(rows);
    },

    async addCycle(input) {
      const rows = await A.getAll(T.CYCLES);
      const err = core.validateCycle({ ...input, id: null }, rows);
      if (err) throw new Error(err);
      const t = now();
      const rec = {
        id: S.uid('cycle'),
        startDate: input.startDate,
        endDate: input.endDate || null,
        symptoms: Array.isArray(input.symptoms) ? input.symptoms : [],
        state: String(input.state || ''),
        note: String(input.note || ''),
        createdAt: t,
        updatedAt: t,
        history: [],
        v: S.SCHEMA_VERSION,
      };
      S.pushHistory(rec, 'created', `记录经期开始：${rec.startDate}`);
      await A.put(T.CYCLES, rec);
      changed('cycle:add', rec.id);
      return rec;
    },

    async updateCycle(id, patch) {
      const rows = await A.getAll(T.CYCLES);
      const rec = rows.find(r => r.id === id);
      if (!rec) throw new Error('记录不存在。');
      const next = { ...rec, ...patch, id: rec.id, history: rec.history || [], updatedAt: now() };
      if (next.endDate === '') next.endDate = null;
      const err = core.validateCycle(next, rows);
      if (err) throw new Error(err);
      let detail = '修改周期记录';
      if (next.endDate && !rec.endDate) detail = `补充结束日期：${next.endDate}`;
      else if (!next.endDate && rec.endDate) detail = `撤销结束日期：${rec.endDate}（恢复为进行中）`;
      else if (next.startDate !== rec.startDate) detail = `开始日期 ${rec.startDate} → ${next.startDate}`;
      S.pushHistory(next, 'updated', detail);
      await A.put(T.CYCLES, next);
      changed('cycle:update', id);
      return next;
    },

    async removeCycle(id) {
      await A.remove(T.CYCLES, id);
      changed('cycle:remove', id);
    },

    async prediction() {
      const rows = await A.getAll(T.CYCLES);
      return core.predictCycle(rows);
    },

    /* ---------------- 记账（收入/支出） ---------------- */
    async listTransactions() {
      const rows = await A.getAll(T.TXNS);
      return [...rows]
        .filter(r => r && r.id)
        .sort((a, b) => core.compareDay(b.date, a.date) || (b.createdAt || 0) - (a.createdAt || 0));
    },

    async getTransaction(id) {
      return A.get(T.TXNS, id);
    },

    async addTransaction(input) {
      const built = validateTx(input);
      const t = now();
      const rec = {
        id: S.uid('tx'),
        ...built,
        createdAt: t,
        updatedAt: t,
        history: [],
        v: S.SCHEMA_VERSION,
      };
      S.pushHistory(rec, 'created', txDescribe(rec));
      await A.put(T.TXNS, rec);
      changed('tx:add', rec.id);
      return rec;
    },

    async updateTransaction(id, patch) {
      const rec = await A.get(T.TXNS, id);
      if (!rec) throw new Error('记录不存在。');
      const next = { ...rec, ...patch, id: rec.id, history: rec.history || [], updatedAt: now() };
      const built = validateTx(next);
      Object.assign(next, built);
      S.pushHistory(next, 'updated', `修改记账：${txDescribe(rec)} → ${txDescribe(next)}`);
      await A.put(T.TXNS, next);
      changed('tx:update', id);
      return next;
    },

    async removeTransaction(id) {
      await A.remove(T.TXNS, id);
      changed('tx:remove', id);
    },

    // 统计：{from,to} 为 YYYY-MM-DD 闭区间；返回支出/收入合计与支出分类明细
    async txStats({ from, to } = {}) {
      const rows = (await A.getAll(T.TXNS)).filter(r => r && r.id);
      const inRange = rows.filter(r => (!from || r.date >= from) && (!to || r.date <= to));
      const stat = { expense: 0, income: 0, count: inRange.length, byCategory: {}, byDay: {} };
      for (const r of inRange) {
        const amt = Number(r.amount) || 0;
        if (r.type === 'income') stat.income += amt;
        else {
          stat.expense += amt;
          const c = r.category || '其他';
          stat.byCategory[c] = (stat.byCategory[c] || 0) + amt;
        }
        stat.byDay[r.date] = (stat.byDay[r.date] || 0) + (r.type === 'income' ? -amt : amt);
      }
      stat.expense = round2(stat.expense);
      stat.income = round2(stat.income);
      for (const k of Object.keys(stat.byCategory)) stat.byCategory[k] = round2(stat.byCategory[k]);
      return stat;
    },

    /* ---------------- 统一历史 ---------------- */
    async history(limit = 120) {
      const [tasks, sleeps, cycles, txns] = await Promise.all([A.getAll(T.TASKS), A.getAll(T.SLEEP), A.getAll(T.CYCLES), A.getAll(T.TXNS)]);
      const items = [];
      for (const group of [['任务', tasks], ['作息', sleeps], ['周期', cycles], ['记账', txns]]) {
        const [label, rows] = group;
        for (const r of rows || []) {
          for (const h of (r.history || [])) {
            items.push({
              at: h.at || r.updatedAt || 0,
              group: label,
              action: h.action,
              detail: h.detail,
              refId: r.id,
            });
          }
        }
      }
      return items.sort((a, b) => b.at - a.at).slice(0, limit);
    },

    async schemaVersion() {
      if (typeof A.getMeta === 'function') return A.getMeta('schemaVersion');
      return core.SCHEMA_VERSION;
    },
  };

  return repo;
}

export const TX_CATEGORY_LISTS = { expense: TX_CATEGORIES, income: TX_INCOME_CATEGORIES };

export const repository = createRepository(indexedDBAdapter);
