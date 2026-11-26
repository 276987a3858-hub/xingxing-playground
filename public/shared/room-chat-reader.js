/* public/shared/room-chat-reader.js — 历史聊天只读读取适配器（P1.5 / 阶段二A）
 * ------------------------------------------------------------------
 * 给机自述（以及后续的历史回顾）用：按 messages 仓库的自增主键游标分批读取。
 *
 * 两个公开读取接口，共用同一个内部扫描核心 scan()：
 *   - readBatch({ afterId, limit, maxChars })         升序：从旧到新
 *   - readBatchBefore({ beforeId, limit, maxChars })  倒序：从新到旧
 * 扫描方向由接口内部固定，外部参数改不了方向（不开放 direction 参数）。
 *
 * 边界（硬约束）：
 *   - 只读：不建库、不升级、不写任何数据、不加索引、不改消息。
 *   - 不调用 getAll()，不依赖 app.js 里的 chatHistory 内存数组。
 *   - 只投影 8 个必要字段；image / audioData 等大型媒体字段一律不进入返回值。
 *   - 不合并相邻同角色消息，不改变原始消息 id。
 *   - 读取失败必须明确返回失败：messages 为 null、done 为 false，绝不伪装成空批次或扫描完成。
 *   - 空库 / 末尾 / 无效参数 / 单条超预算都必须让游标能前进，不允许原地打转。
 *
 * 为什么不用 getAll：messages 里内联着 base64 图片与 base64 朗读音频，
 * 一条带图带语音的记录可能几百 KB 到几 MB，全量读取会直接把内存拉爆。
 *
 * 暴露 window.RoomChatReader / globalThis.RoomChatReader。
 * 测试用 _create({ open, keyRange }) 注入假后端，不碰真实 IndexedDB。
 */
(function (root) {
  'use strict';

  var DB_NAME = 'star_fifi_room';
  var STORE = 'messages';

  var DEFAULTS = {
    limit: 80,        // 单批最多条数
    maxChars: 12000,  // 单批最多正文字符数（只算 content）
    maxLimit: 500     // 单批条数硬上限：调用方传更大也按这个截断，防止一次拉爆内存
  };

  // 防御性上限：正常数据永远走不到；只在数据异常时避免游标空转。
  var SCAN_FACTOR = 20;
  var SCAN_FLOOR = 1000;

  function errText(e) { return String((e && e.message) || e || '未知错误'); }
  function isNum(n) { return typeof n === 'number' && isFinite(n); }

  // 消息 id 在库里是数字，但机自述 source.messageId 可能被存成字符串。
  // 统一按数字解析，避免 '12' 与 12 匹配失败；解析不了就返回 null（明确拒绝）。
  function toMessageId(v) {
    if (isNum(v)) return Math.floor(v) === v ? v : null;
    if (typeof v === 'string') {
      var t = v.trim();
      if (!t || !/^-?\d+$/.test(t)) return null;
      var n = Number(t);
      return isNum(n) ? n : null;
    }
    return null;
  }

  /**
   * 字段投影：白名单，只有这 8 个键。
   * 绝不下发 image / audioData / englishContent / pendingToken 等其余字段。
   */
  function project(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var content = typeof raw.content === 'string'
      ? raw.content
      : (raw.content == null ? '' : String(raw.content));
    return {
      id: toMessageId(raw.id),
      role: raw.role === 'user' ? 'user' : (raw.role === 'assistant' ? 'assistant' : ''),
      content: content,
      time: isNum(raw.time) ? raw.time : null,
      source: (typeof raw.source === 'string' && raw.source) ? raw.source : null,
      sourceId: (typeof raw.sourceId === 'number' || typeof raw.sourceId === 'string') ? raw.sourceId : null,
      silent: raw.silent === true,
      type: (typeof raw.type === 'string' && raw.type) ? raw.type : null
    };
  }

  /**
   * 统一失败形状：字段与升级前完全一致，倒序不另造一套。
   * anchor 只在升序下有回填意义（nextAfterId）；倒序调用一律传 null，保持形状不变。
   */
  function failure(reason, error, anchor) {
    return {
      ok: false,
      reason: reason,
      error: error == null ? null : String(error),
      messages: null,          // 显式 null：调用方不会把它当成「空批次」
      nextAfterId: isNum(anchor) ? anchor : null,
      done: false,             // 失败绝不等于「已扫完」
      count: 0,
      chars: 0
    };
  }

  function make(env) {
    var e = env || {};

    function open() { return e.open ? e.open() : openReal(); }
    function keyRange() { return e.keyRange || root.IDBKeyRange; }

    /* ---------------- 统一扫描核心：升序 / 倒序共用 ---------------- */

    /**
     * @param axis 'next' 升序（读 afterId 之后）| 'prev' 倒序（读 beforeId 之前）
     *        —— 只由本模块内部传入，外部无法覆盖。
     * @param opts { afterId | beforeId, limit, maxChars }
     */
    function scan(axis, opts) {
      var o = opts || {};
      var isPrev = axis === 'prev';

      /* ---- 1. 锚点校验：非法值必须报错，绝不能被当成「从头开始」 ---- */

      var anchor;
      if (isPrev) {
        if (o.beforeId === undefined || o.beforeId === null) {
          anchor = null;                       // 只有这里，null 才代表「从最新记录开始」
        } else {
          anchor = toMessageId(o.beforeId);
          // 关键：解析失败返回 null，与「未提供」的 null 撞在一起。
          // 所以必须在这里显式报错，不能让非法值静默变成「首批读取」。
          if (anchor === null || anchor <= 0) {
            return Promise.resolve(failure('bad-params', 'beforeId 必须是正整数（省略或 null 表示从最新开始）', null));
          }
        }
      } else {
        if (o.afterId === undefined || o.afterId === null) {
          anchor = 0;
        } else {
          anchor = toMessageId(o.afterId);
          if (anchor === null || anchor < 0) {
            return Promise.resolve(failure('bad-params', 'afterId 必须是非负整数消息 id', null));
          }
        }
      }

      var failAnchor = isPrev ? null : anchor;   // 失败形状与升级前保持一致

      /* ---- 2. limit ---- */

      var limit = o.limit == null ? DEFAULTS.limit : o.limit;
      if (!isNum(limit) || Math.floor(limit) !== limit || limit < 1) {
        return Promise.resolve(failure('bad-params', 'limit 必须是大于 0 的整数', failAnchor));
      }
      if (limit > DEFAULTS.maxLimit) limit = DEFAULTS.maxLimit;

      /* ---- 3. maxChars ---- */

      var maxChars = o.maxChars == null ? DEFAULTS.maxChars : o.maxChars;
      if (!isNum(maxChars) || maxChars < 1) {
        return Promise.resolve(failure('bad-params', 'maxChars 必须是大于 0 的数字', failAnchor));
      }
      maxChars = Math.floor(maxChars);

      /* ---- 4. 打开连接 ---- */

      var opening;
      try {
        opening = Promise.resolve(open());
      } catch (err) {
        return Promise.resolve(failure('open-failed', '打开房间数据库失败：' + errText(err), failAnchor));
      }

      return opening.then(function (db) {
        return new Promise(function (resolve) {
          var settled = false;
          function finish(res) { if (settled) return; settled = true; resolve(res); }

          var tx, store;
          try {
            tx = db.transaction(STORE, 'readonly');
            store = tx.objectStore(STORE);
          } catch (err) {
            finish(failure('read-failed', '打开 messages 只读事务失败：' + errText(err), failAnchor));
            return;
          }

          var KR = keyRange();
          var needBound = isPrev ? 'upperBound' : 'lowerBound';
          if (!KR || typeof KR[needBound] !== 'function') {
            finish(failure('no-keyrange', '当前环境不支持 IDBKeyRange，无法分批读取', failAnchor));
            return;
          }

          var req;
          try {
            if (isPrev) {
              // 首批：不带范围，'prev' 天然从最大主键开始（无需先查 max(id)）
              // 后续批：upperBound(beforeId, true) 开区间，保证不重复、不遗漏
              var range = anchor === null ? null : KR.upperBound(anchor, true);
              req = store.openCursor(range, 'prev');
            } else {
              // 从 afterId 之后开始（开区间），按主键升序：天然按插入顺序
              req = store.openCursor(KR.lowerBound(anchor, true), 'next');
            }
          } catch (err) {
            finish(failure('read-failed', '创建消息游标失败：' + errText(err), failAnchor));
            return;
          }

          var out = [];
          var chars = 0;
          // 本批最后一条的主键；空批时保持锚点（升序 0/afterId，倒序 null/beforeId）
          var lastId = anchor;
          var skipped = 0;
          var oversized = false;
          var guard = 0;
          var maxScan = limit * SCAN_FACTOR + SCAN_FLOOR;

          // 续读锚点：升序只给 nextAfterId，倒序只给 nextBeforeId，两者绝不混用。
          function ok(done) {
            var res = {
              ok: true,
              reason: 'ok',
              messages: out,
              done: done,
              count: out.length,
              chars: chars,
              limit: limit,
              maxChars: maxChars,
              oversized: oversized,
              skipped: skipped,
              direction: isPrev ? 'prev' : 'next'
            };
            if (isPrev) res.nextBeforeId = lastId;
            else res.nextAfterId = lastId;
            return res;
          }

          req.onerror = function () {
            finish(failure('read-failed', '读取 messages 失败：' + errText(req.error), failAnchor));
          };

          req.onsuccess = function () {
            if (settled) return;

            var cur = req.result;
            if (!cur) { finish(ok(true)); return; }   // 游标到头：这才是真正的 done

            guard += 1;
            if (guard > maxScan) {
              finish(failure('cursor-stuck', '游标异常：扫描次数超过预期上限，已中止本批', failAnchor));
              return;
            }

            // cursor.primaryKey 比 value.id 权威：keyPath 保证它一定存在
            var key = toMessageId(cur.primaryKey);
            if (key == null) {
              // 没有可用主键：跳过继续，绝不原地重读（否则会死循环）
              skipped += 1;
              try { cur.continue(); } catch (err) {
                finish(failure('cursor-stuck', '游标无法继续：' + errText(err), failAnchor));
              }
              return;
            }

            var m = project(cur.value);
            if (!m) m = { id: key, role: '', content: '', time: null, source: null, sourceId: null, silent: false, type: null };
            m.id = key;

            var len = m.content.length;

            // 已经攒了内容，再放这条就超预算：本批到此为止，这条留给下一批
            if (out.length > 0 && chars + len > maxChars) { finish(ok(false)); return; }

            // 单条自己就超预算，且本批还是空的：必须带上它，否则游标永远前进不了
            if (out.length === 0 && len > maxChars) oversized = true;

            out.push(m);
            chars += len;
            lastId = key;

            if (oversized) { finish(ok(false)); return; }
            if (out.length >= limit) { finish(ok(false)); return; }

            try { cur.continue(); } catch (err) {
              finish(failure('cursor-stuck', '游标无法继续：' + errText(err), failAnchor));
            }
          };

          // 只读事务理论上不会 abort；真 abort 说明环境异常，必须报错而不是当成读完了
          tx.onabort = function () {
            finish(failure('read-failed', '读取事务被中止', failAnchor));
          };
        });
      }, function (err) {
        return failure('open-failed', '打开房间数据库失败：' + errText(err), failAnchor);
      });
    }

    /* ---------------- readBatch：升序（公开，签名与语义保持不变） ---------------- */

    function readBatch(opts) {
      return scan('next', opts);
    }

    /* ---------------- readBatchBefore：倒序（公开，方向由内部固定） ---------------- */

    // 倒序不接受 afterId（传了会被忽略）：从最新往更早走，用 nextBeforeId 续读。
    function readBatchBefore(opts) {
      return scan('prev', opts);
    }

    /* ---------------- getById ---------------- */

    function getById(messageId) {
      var id = toMessageId(messageId);
      if (id == null) {
        return Promise.resolve({ ok: false, reason: 'bad-params', error: 'messageId 必须是整数', id: null, exists: false, message: null });
      }
      var opening;
      try {
        opening = Promise.resolve(open());
      } catch (err) {
        return Promise.resolve({ ok: false, reason: 'open-failed', error: '打开房间数据库失败：' + errText(err), id: id, exists: false, message: null });
      }
      return opening.then(function (db) {
        return new Promise(function (resolve) {
          var settled = false;
          function finish(r) { if (settled) return; settled = true; resolve(r); }

          var req;
          try {
            req = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
          } catch (err) {
            finish({ ok: false, reason: 'read-failed', error: '打开只读事务失败：' + errText(err), id: id, exists: false, message: null });
            return;
          }

          req.onsuccess = function () {
            var v = req.result;
            if (v == null) {
              finish({ ok: true, reason: 'not-found', id: id, exists: false, message: null });
              return;
            }
            var m = project(v);
            if (m) m.id = id;
            finish({ ok: true, reason: 'ok', id: id, exists: true, message: m });
          };

          req.onerror = function () {
            finish({ ok: false, reason: 'read-failed', error: '读取消息失败：' + errText(req.error), id: id, exists: false, message: null });
          };
        });
      }, function (err) {
        return { ok: false, reason: 'open-failed', error: '打开房间数据库失败：' + errText(err), id: id, exists: false, message: null };
      });
    }

    /* ---------------- hasMessage ---------------- */

    function hasMessage(messageId) {
      var id = toMessageId(messageId);
      if (id == null) {
        return Promise.resolve({ ok: false, reason: 'bad-params', error: 'messageId 必须是整数', id: null, exists: false });
      }
      var opening;
      try {
        opening = Promise.resolve(open());
      } catch (err) {
        return Promise.resolve({ ok: false, reason: 'open-failed', error: '打开房间数据库失败：' + errText(err), id: id, exists: false });
      }
      return opening.then(function (db) {
        return new Promise(function (resolve) {
          var settled = false;
          function finish(r) { if (settled) return; settled = true; resolve(r); }

          var req;
          try {
            // count(key) 只查存在性，不把正文和媒体读出来
            req = db.transaction(STORE, 'readonly').objectStore(STORE).count(id);
          } catch (err) {
            finish({ ok: false, reason: 'read-failed', error: '打开只读事务失败：' + errText(err), id: id, exists: false });
            return;
          }

          req.onsuccess = function () {
            var n = Number(req.result) || 0;
            finish({ ok: true, reason: n > 0 ? 'ok' : 'not-found', id: id, exists: n > 0 });
          };

          req.onerror = function () {
            finish({ ok: false, reason: 'read-failed', error: '查询消息存在性失败：' + errText(req.error), id: id, exists: false });
          };
        });
      }, function (err) {
        return { ok: false, reason: 'open-failed', error: '打开房间数据库失败：' + errText(err), id: id, exists: false };
      });
    }

    return {
      DB_NAME: DB_NAME,
      STORE: STORE,
      DEFAULTS: DEFAULTS,
      readBatch: readBatch,
      readBatchBefore: readBatchBefore,
      getById: getById,
      hasMessage: hasMessage
    };
  }

  /* ---------------- 真实 IndexedDB 连接（只读、不建库） ---------------- */

  var dbPromise = null;

  function openReal() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var idb = root.indexedDB;
      if (!idb || typeof idb.open !== 'function') {
        reject(new Error('当前环境不支持 IndexedDB'));
        return;
      }

      var req;
      try { req = idb.open(DB_NAME); } catch (err) { reject(err); return; }   // 不带版本号 = 不升级

      var willCreate = false;
      req.onupgradeneeded = function (ev) {
        // 库不存在时浏览器会先建一个空库再升级：立刻 abort 回滚，读一下绝不留下空库
        willCreate = true;
        try { ev.target.transaction.abort(); } catch (e2) {}
      };

      req.onsuccess = function () {
        var db = req.result;
        if (willCreate) {
          try { db.close(); } catch (e2) {}
          reject(new Error('本地还没有房间数据库'));
          return;
        }
        if (!db.objectStoreNames || !db.objectStoreNames.contains(STORE)) {
          try { db.close(); } catch (e2) {}
          reject(new Error('房间数据库里没有 messages 表'));
          return;
        }
        // 别的标签页要升级时让路，避免卡住对方
        db.onversionchange = function () {
          try { db.close(); } catch (e2) {}
          dbPromise = null;
        };
        resolve(db);
      };

      req.onerror = function () { reject(req.error || new Error('打开房间数据库失败')); };
      req.onblocked = function () { reject(new Error('房间数据库被其它标签页占用')); };
    });

    // 失败不留坏缓存：否则一次失败会让后面永远失败
    dbPromise.catch(function () { dbPromise = null; });
    return dbPromise;
  }

  var api = make({});
  api._create = make;          // 仅供测试注入假后端
  api._project = project;
  api._toMessageId = toMessageId;

  root.RoomChatReader = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
