/* public/butler/butler-intent.js — 生活管家 · 聊天意图桥接层
 * 经典脚本（非 module），挂到 window.ButlerIntent，由房间 public/app.js 调用。
 * 原则：
 *  - AI 只负责「识别意图 + 提取字段」，输出 <bl>{...}</bl> 标记；
 *  - 增删改查与统计全部由本地代码完成（IndexedDB star_butler_v1），不把历史账单/待办发给 AI；
 *  - 高置信查询（完全匹配的固定句式）本地直接回答，0 次 AI 调用；
 *  - 信息不足或有歧义时不执行任何写操作，由 AI/本地追问用户。
 */
(function () {
  'use strict';

  /* ---------------- 日期工具（本地时区） ---------------- */
  function pad(n) { return String(n).padStart(2, '0'); }
  function dayStr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function todayStr() { return dayStr(new Date()); }
  function addDays(n) { const d = new Date(); d.setDate(d.getDate() + n); return dayStr(d); }
  function monthHead(s) { return String(s || todayStr()).slice(0, 7) + '-01'; }
  const WEEK_IDX = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7 };

  // today/tomorrow/yesterday/后天/周X/下周X/YYYY-MM-DD/MM-DD → YYYY-MM-DD；解析失败返回 null
  function resolveDate(token) {
    if (token === undefined || token === null || token === '') return null;
    const t = String(token).trim();
    let m;
    if ((m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
    if ((m = t.match(/^(\d{1,2})-(\d{1,2})$/))) { const n = new Date(); return `${n.getFullYear()}-${pad(+m[1])}-${pad(+m[2])}`; }
    if (t === '今天' || t === 'today') return todayStr();
    if (t === '明天' || t === '明日' || t === 'tomorrow') return addDays(1);
    if (t === '昨天' || t === '昨日' || t === 'yesterday') return addDays(-1);
    if (t === '后天') return addDays(2);
    if ((m = t.match(/^(下)?(?:周|星期)([一二三四五六日天])$/))) {
      const idx = WEEK_IDX[m[2]];
      const now = new Date();
      const cur = now.getDay() === 0 ? 7 : now.getDay();
      let diff = idx - cur;
      if (m[1]) { const toMon = ((1 - cur) + 7) % 7 || 7; diff = toMon + idx - 1; }
      else if (diff < 0) diff += 7;
      const d = new Date(); d.setDate(d.getDate() + diff);
      return dayStr(d);
    }
    return null;
  }

  /* ---------------- 仓储加载 ---------------- */
  let repoPromise = null;
  const api = { _repo: null };
  function loadRepo() {
    if (api._repo) return Promise.resolve(api._repo);
    if (!repoPromise) repoPromise = import('/butler/butler-repository.js').then((m) => m.repository);
    return repoPromise;
  }

  const TX_CATS = ['餐饮', '交通', '购物', '日用', '娱乐', '其他'];
  const TX_IN_CATS = ['工资', '红包', '理财', '其他'];

  /* ---------------- 关键词分类门控：只负责「唤醒」，不代表执行 ---------------- */
  const CATS = {
    // 待办：需要明确的交代/改动动作，单纯的物品名（洗衣服、牛奶）不算
    task: /(提醒我|提醒一下|待办|日程|安排|要做|帮我记|记一下|记得(?:买|去|带|交|做|提醒)|做完了|办完了|办妥了|改到|改期|推迟|延期|取消)/,
    // 记账：必须有明确金额、或明确的记账/查账意图；只是分享「花了很多钱」不算
    money: /(记账|记一笔|帮我记一笔|账单|报销)|(\d+(?:\.\d+)?\s*(?:元|块|毛|角))|([一二三四五六七八九十百]{1,4}\s*[块元])|多少钱|花了多少|一共花|消费了?\d|支出多少|收入多少/,
    // 本轮只预留分类，不扩展聊天操作
    cycle: /(月经|生理期|经期|姨妈|周期)/,
    sleep: /(睡觉|入睡|起床|醒来|睡了|起床了|作息)/,
  };

  function classify(text) {
    const t = String(text || '');
    const r = { task: false, money: false, cycle: false, sleep: false };
    if (!t) return r;
    r.task = CATS.task.test(t);
    r.money = CATS.money.test(t);
    r.cycle = CATS.cycle.test(t);
    r.sleep = CATS.sleep.test(t);
    return r;
  }

  // 只有待办/记账才需要追加提示词（生理期、睡眠本轮不接聊天操作）
  function gate(text) {
    const c = classify(text);
    return c.task || c.money;
  }

  /* ---------------- 是否注入精确时间上下文（纯本地判断，0 token） ----------------
   * 普通闲聊不带时间说明；涉及待办、提醒、时间/日期时才带，省掉每轮的固定开销。
   */
  const TIME_HINT_RE = /(提醒|待办|日程|安排|几点|点钟|时间|现在|今天|明天|后天|昨天|刚刚?|等会|一会儿|马上|上午|中午|下午|傍晚|晚上|凌晨|深夜|分钟|小时|迟到|来不及|赶不上|睡过头|熬夜|晚安|早安|午休|睡)/;

  function needsClockContext(text) {
    return TIME_HINT_RE.test(String(text || ''));
  }

  /* ---------------- 追加到系统提示词的说明块（仅在门控命中时附加） ---------------- */
  function systemPrompt() {
    return [
      '',
      '【生活管家指令】仅当用户明确交代待办/日程、记账或查询花销时使用，普通聊天、价格讨论、玩笑绝不触发。',
      '需要操作时，在回复的最开头为每一项操作各输出一行 <bl>{"op":...}</bl> 标记；一条消息里有多笔消费时必须逐笔各输出一行标记，不能合并、不能漏掉任何一笔。之后再按一贯语气只确认真正记下的那几笔（标记必须放在最前面，其余仍遵循中文 ||| 英文格式）。',
      '可用操作与字段：',
      'task_add {"op":"task_add","title":"买牛奶","date":"tomorrow","time":"18:00"}（date 支持 today/tomorrow/yesterday/周X/下周X/YYYY-MM-DD）',
      '相对时间（"十五分钟后""半小时后""两个小时后"）同样要立刻建待办：time 原样写 "15分钟后" / "半小时后"，系统会按收到这条消息的时间换算，不要换算成几点几分的猜测。',
      '没有输出标记，就绝对不要在回复里承诺"我叫你""提醒你"——只答应不落地是最严重的错误。',
      'task_done {"op":"task_done","match":"买牛奶"}（match 为能定位事项的关键词）',
      'task_update_date {"op":"task_update_date","match":"买牛奶","date":"周五"}',
      'task_query {"op":"task_query","range":"today|tomorrow|week|month"}',
      'tx_add {"op":"tx_add","type":"expense|income","amount":7,"category":"餐饮","date":"today","note":"午饭"}（支出分类仅限：餐饮/交通/购物/日用/娱乐/其他；收入：工资/红包/理财/其他）',
      'tx_update {"op":"tx_update","match":"午饭","amount":8,"category":null,"date":null}（只带需要改的字段）',
      'tx_query {"op":"tx_query","period":"today|month","category":"餐饮"}（category 可省略）',
      '查询统计由本地程序完成，你不需要知道结果，标记后自然回应即可（如"我帮你看看"）。',
      '金额、日期、分类或对象不明确、有多个可能时：不要输出标记、不要猜，用自然的话向她确认。',
      '她只是分享花销、没说"记一下"时，不要索要金额、不要主动记账，先回应她分享的事；她说不想聊这件事，就真的放下，不要再用「我还记着」绕回来。',
      '待办建好后只自然确认一次，之后不要顺口再提。系统会在到点前 10 分钟把提醒递给你一次：那一次可以说得认真、带一点训诫和祈使句，说完就收。',
      '没收到系统的提醒时，不要自己掐时间催她，也不要把事项的钟点说成"现在已经到点了"。',
      '不要追问进度、不要要她汇报、不要隔几分钟催一次；她答应了、说累了、要午休要忙、或者换了话题，就顺着她走，不逼她按原计划。',
      '但如果是「事情明确、只差一个字段」（如她只说"下午提醒我洗衣服"却没给钟点，或只说"午饭花了"没给金额），要输出带 need 的标记，并随口问那一句：',
      '<bl>{"op":"task_add","title":"洗衣服","date":"today","need":["time"]}</bl> 下午几点提醒你比较好？ ||| What time this afternoon should I remind you?',
      '<bl>{"op":"tx_add","type":"expense","category":"餐饮","note":"午饭","need":["amount"]}</bl> 午饭花了多少呀？ ||| How much did lunch cost?',
      '所有示例只是示范，真实回复照旧中文在前、英文在后，三条竖线 ||| 不能省略（标记本身放在最前面，中文紧跟其后）。',
      'need 只放缺失字段（time / date / amount / title）。她下一句补充"三点""明天""7元"时，系统会自己在本地补全保存，你不需要再输出标记。',
      '',
    ].join('\n');
  }

  /* ---------------- 匹配工具 ---------------- */
  function matchTasks(match, tasks) {
    const kw = String(match || '').trim();
    if (!kw) return [];
    return tasks.filter((t) => t.title.includes(kw) || kw.includes(t.title));
  }

  function matchTxns(match, rows) {
    const kw = String(match || '').trim();
    const todays = rows.filter((r) => r.date === todayStr());
    if (!kw || /^(最近|刚才|刚|最新|上一笔|那笔)/.test(kw)) {
      if (todays.length === 1) return [todays[0]];
      if (todays.length === 0 && rows.length === 1) return [rows[0]];
      return todays.slice(0, 5);
    }
    const parts = kw.split(/\s+/).filter(Boolean);
    return rows.filter((r) => parts.every((k) => `${r.note} ${r.category} ¥${r.amount} ${r.date}`.includes(k)));
  }

  function appendToReply(display, extra) {
    if (!extra) return display;
    const i = display.indexOf('|||');
    return i === -1 ? `${display}\n${extra}`.trim() : `${display.slice(0, i).trim()}\n${extra}${display.slice(i)}`;
  }

  function yuan(n) { return '¥' + (Math.round((Number(n) || 0) * 100) / 100); }

  // 回复里是否已经算作「确认过这件事」（提到事项名，或用了记下/提醒这类话）
  function confirmedIn(display, title) {
    const t = String(display || '');
    if (!t) return false;
    if (title && title.length >= 2 && t.includes(title.slice(0, 2))) return true;
    return /(记好|记下|记一下|记着|记在|提醒你|叫你|喊你|安排上|写进)/.test(t);
  }

  async function taskQueryText(range) {
    const repo = await loadRepo();
    const tasks = await repo.listTasks();
    const pending = tasks.filter((t) => t.status === 'pending');
    let from, to, label;
    if (range === 'tomorrow') { from = to = addDays(1); label = '明天'; }
    else if (range === 'week') { from = todayStr(); to = addDays(7); label = '接下来一周'; }
    else if (range === 'month') { from = monthHead(); to = addDays(31); label = '这个月'; }
    else { from = to = todayStr(); label = '今天'; }
    const list = pending.filter((t) => t.date >= from && t.date <= to)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.time || '').localeCompare(String(b.time || ''))));
    if (!list.length) return `${label}还没有安排，想记点什么吗？`;
    const items = list.slice(0, 8).map((t) => (t.date === todayStr() || range === 'today' || range === 'tomorrow'
      ? `${t.title}${t.time ? '（' + t.time + '）' : ''}`
      : `${t.date} ${t.title}${t.time ? '（' + t.time + '）' : ''}`));
    const more = list.length > 8 ? `，还有 ${list.length - 8} 件` : '';
    return `${label}有 ${list.length} 件事：${items.join('、')}${more}。`;
  }

  async function txQueryText(period, category) {
    const repo = await loadRepo();
    const from = period === 'month' ? monthHead() : todayStr();
    const to = period === 'month' ? addDays(31) : todayStr();
    const stat = await repo.txStats({ from, to });
    const label = period === 'month' ? '这个月' : '今天';
    if (category) {
      const pool = TX_CATS.includes(category) ? TX_CATS : TX_IN_CATS;
      const cat = pool.includes(category) ? category : '其他';
      const val = stat.byCategory[cat] || 0;
      return `${label}${cat}一共花了 ${yuan(val)}。`;
    }
    return `${label}支出 ${yuan(stat.expense)}${stat.income ? `，收入 ${yuan(stat.income)}` : ''}。`;
  }

  /* ---------------- 临时待处理上下文（15 分钟，纯本地，不调用 AI） ----------------
   * 场景：她说「下午提醒我洗衣服」，缺钟点 → 存一条 pending；她回「三点」→ 本地补全并保存。
   * 只存完成当前操作所需的最小信息，不检索聊天历史，不扩大发给 AI 的上下文。
   */
  const PENDING_TTL = 15 * 60 * 1000;
  const PENDING_MAX = 3;
  let pendings = [];
  let pendingSeq = 0;

  const CN_NUM = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

  function cn2num(s) {
    const t = String(s || '').replace(/\s/g, '');
    if (/^\d+$/.test(t)) return Number(t);
    if (CN_NUM[t] !== undefined) return CN_NUM[t];
    const m = t.match(/^([一二三四五])?十([一二三四五六七八九])?$/);
    if (m) return (m[1] ? CN_NUM[m[1]] : 1) * 10 + (m[2] ? CN_NUM[m[2]] : 0);
    return null;
  }

  function prunePending() {
    const t = Date.now();
    pendings = pendings.filter((p) => t - p.at < PENDING_TTL);
  }

  function addPending(kind, data, missing) {
    prunePending();
    const p = { id: 'p' + ++pendingSeq, kind, data: Object.assign({}, data), missing: (missing || []).slice(), at: Date.now() };
    pendings.push(p);
    if (pendings.length > PENDING_MAX) pendings.shift();
    return p;
  }

  function clearPending(id) {
    pendings = id ? pendings.filter((p) => p.id !== id) : [];
  }

  function hasPending() { prunePending(); return pendings.length > 0; }

  /* --- 补充信息解析（只用于待处理上下文，不触发任何写操作） --- */
  // 「三点」「15:30」「下午三点半」「晚上八点一刻」→ "HH:MM"
  function parseTimeToken(text) {
    const t = String(text || '');
    let m = t.match(/(\d{1,2})\s*[:：]\s*(\d{2})/);
    if (m) { const h = +m[1], mi = +m[2]; return h <= 23 && mi <= 59 ? `${pad(h)}:${pad(mi)}` : null; }
    m = t.match(/(上午|中午|下午|晚上|早上|傍晚|夜里|凌晨)?\s*(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*[点时]\s*(?:钟)?\s*(半|一刻|三刻|\d{1,2}\s*分?|[一二三四五六七八九十]{1,3}\s*分)?/);
    if (!m) return null;
    let h = cn2num(m[2]);
    if (h === null || h > 23) return null;
    let mi = 0;
    const tail = m[3] || '';
    if (tail === '半') mi = 30;
    else if (tail === '一刻') mi = 15;
    else if (tail === '三刻') mi = 45;
    else if (/^\d{1,2}/.test(tail)) mi = Math.min(59, +tail.match(/^\d{1,2}/)[0]);
    else if (/^[一二三四五六七八九十]{1,3}\s*分$/.test(tail)) {
      const cn = cn2num(tail.trim().replace(/分$/, ''));
      if (cn !== null) mi = Math.min(59, cn);
    }
    const ap = m[1] || '';
    if ((ap === '下午' || ap === '晚上' || ap === '傍晚' || ap === '夜里') && h < 12) h += 12;
    if (ap === '中午' && h < 11) h += 12;
    return `${pad(h)}:${pad(mi)}`;
  }

  function parseDateToken(text) {
    const t = String(text || '').trim();
    const direct = resolveDate(t);
    if (direct) return direct;
    for (const kw of ['后天', '明天', '明日', '今天', '昨天', '昨日']) {
      if (t.includes(kw)) return resolveDate(kw);
    }
    let m = t.match(/(下)?(?:周|星期)([一二三四五六日天])/);
    if (m) return resolveDate((m[1] || '') + '周' + m[2]);
    m = t.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/);
    if (m) { const n = new Date(); return `${n.getFullYear()}-${pad(+m[1])}-${pad(+m[2])}`; }
    m = t.match(/(\d{1,2})\s*号/);
    if (m) {
      const day = +m[1];
      if (day >= 1 && day <= 31) {
        const n = new Date();
        let y = n.getFullYear(), mo = n.getMonth();
        if (day < n.getDate()) { mo += 1; if (mo > 11) { mo = 0; y += 1; } }
        const cand = new Date(y, mo, day);
        if (cand.getMonth() === mo) return dayStr(cand);
      }
    }
    return null;
  }

  function parseAmountToken(text) {
    const t = String(text || '').trim();
    let m = t.match(/(\d+(?:\.\d{1,2})?)\s*(?:元|块|块钱|毛|角)/);
    if (m) return Number(m[1]);
    m = t.match(/([一二两三四五六七八九十]{1,3})\s*(?:元|块|块钱)/);
    if (m) { const n = cn2num(m[1]); return n === null ? null : n; }
    m = t.match(/^(?:金额|一共|共|是|改成|改为|就)?\s*(\d+(?:\.\d{1,2})?)\s*$/);
    if (m) return Number(m[1]);
    return null;
  }

  function parseCategoryToken(text) {
    const t = String(text || '');
    for (const c of TX_CATS.concat(TX_IN_CATS)) if (t.includes(c)) return c;
    return null;
  }

  function parsePickIdx(raw) {
    const m = String(raw || '').match(/第\s*([一二两三四五1-5])\s*(?:个|件|笔|条)?/);
    if (m) { const n = cn2num(m[1]); return n === null ? null : n - 1; }
    if (/^(前一个|前面那个|上一笔|上一个)$/.test(raw)) return 0;
    return null;
  }

  function periodFrom(text) {
    const m = String(text || '').match(/(上午|中午|下午|晚上|早上|傍晚|夜里)/);
    if (m) return m[1];
    // 没写时段但明显是午后的事（「两点十分去午休」），按下午算，避免落成凌晨两点
    if (/(午休|午觉|午睡|午饭|午间)/.test(String(text || ''))) return '下午';
    return '';
  }

  // 她说"三点"没说是上午下午时，沿用原句里的「下午」这类时段
  function applyPeriod(hhmm, period) {
    let h = Number(String(hhmm).slice(0, 2));
    const mi = String(hhmm).slice(3);
    if (!period) return hhmm;
    if (h < 12 && (period === '下午' || period === '晚上' || period === '傍晚' || period === '夜里')) h += 12;
    else if (h < 11 && period === '中午') h += 12;
    return `${pad(h)}:${mi}`;
  }

  // 判断这句话是不是「单纯的补充」（去掉时间/日期/金额/序号后几乎没剩内容），
  // 用来防止把「我今天有点累，想和你说说话」当成在补时间。
  function supplementResidual(raw) {
    let s = String(raw || '').replace(/[\s，,。.！!？?~～、]/g, '');
    s = s.replace(/^(那就|那就这样|就|那|嗯|好|好的|ok)/i, '');
    s = s.replace(/(上午|中午|下午|晚上|早上|傍晚|夜里)/g, '');
    s = s.replace(/(今天|明天|明日|后天|昨天|昨日)/g, '');
    s = s.replace(/(下)?(周|星期)[一二三四五六日天]/g, '');
    s = s.replace(/\d{1,2}月\d{1,2}[日号]/g, '');
    s = s.replace(/\d{1,2}号/g, '');
    s = s.replace(/\d{1,2}[:：]\d{2}/g, '');
    s = s.replace(/[零一二两三四五六七八九十\d]{1,3}[点时](半|一刻|三刻)?(\d{1,2}分?)?/g, '');
    s = s.replace(/(金额|一共|共|就是|改成|改为|换成|记成|花了|是)/g, '');
    s = s.replace(/第[一二两三四五1-5](个|件|笔|条)?/g, '');
    s = s.replace(/(前一个|前面那个|上一笔|上一个|那个|这个)/g, '');
    s = s.replace(/(餐饮|交通|购物|日用|娱乐|其他)/g, '');
    s = s.replace(/[\d一二两三四五六七八九十.]+(元|块|块钱|毛|角)?/g, '');
    return s;
  }

  function askText(p) {
    const m = p.missing[0];
    const name = p.data.title ? `「${p.data.title}」` : '';
    if (m === 'time') return `（${name || '这件事'}大约几点提醒你？说个时间就好。）`;
    if (m === 'date') return `（${name || '这件事'}要记在哪一天？）`;
    if (m === 'amount') return '（多少钱呀？告诉我数字就好。）';
    if (m === 'title') return '（要记的是哪件事呢？）';
    return '（还差一点信息，再和我说一句？）';
  }

  function pendingData(op) {
    const kind = String(op.op || '');
    const date = resolveDate(op.date) || null;
    if (kind === 'task_add') return { title: String(op.title || '').trim(), date, time: op.time && /^\d{1,2}:\d{2}$/.test(String(op.time)) ? String(op.time) : '', note: String(op.note || '') };
    if (kind === 'tx_add') {
      const amount = Number(op.amount);
      return { type: op.type === 'income' ? 'income' : 'expense', amount: Number.isFinite(amount) && amount > 0 ? amount : null, category: op.category || '', date, note: String(op.note || '') };
    }
    return Object.assign({}, op);
  }

  /* --- 相对时间（十五分钟后 / 半小时后 / 2小时后）：以收到消息的本地时间为基准 --- */
  function cnNumber(s) {
    const t = String(s || '').trim();
    if (/^\d+$/.test(t)) return Number(t);
    if (CN_NUM[t] !== undefined) return CN_NUM[t];
    const m = t.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/);
    if (m) return (m[1] ? CN_NUM[m[1]] : 1) * 10 + (m[2] ? CN_NUM[m[2]] : 0);
    return null;
  }

  // 返回偏移分钟数；不是相对时间返回 null
  function parseRelativeOffset(text) {
    const t = String(text || '');
    let m = t.match(/半\s*个?\s*(?:小时|钟头)/);
    if (m && /(后|之后|以后|过)/.test(t)) return 30;
    if (/一刻钟/.test(t) && /(后|之后|以后|过)/.test(t)) return 15;
    m = t.match(/([一二两三四五六七八九十\d]{1,3})\s*个?\s*(分钟|分|小时|钟头)\s*(?:后|之后|以后|过后)/);
    if (!m) m = t.match(/(?:过|再过)\s*([一二两三四五六七八九十\d]{1,3})\s*个?\s*(分钟|分|小时|钟头)/);
    if (!m) return null;
    const n = cnNumber(m[1]);
    if (n === null || n <= 0 || n > 24 * 60) return null;
    return n * (/^(小时|钟头)$/.test(m[2]) ? 60 : 1);
  }

  // 「十五分钟后」→ { date:'YYYY-MM-DD', time:'HH:MM' }（本地时区，可跨天）
  function relativeTarget(text, baseMs) {
    const off = parseRelativeOffset(text);
    if (off === null) return null;
    const d = new Date((Number.isFinite(baseMs) ? baseMs : Date.now()) + off * 60000);
    return { date: dayStr(d), time: `${pad(d.getHours())}:${pad(d.getMinutes())}`, offset: off };
  }

  // 去掉开头的时间/日期说法：「明天上午九点起床」→「起床」
  function stripLeadTime(text) {
    return String(text || '')
      .replace(/^\s*(?:今天|明天|明日|后天|昨天|昨日|下周|这周|周[一二三四五六日天])?\s*/, '')
      .replace(/^\s*\d{1,2}\s*[:：]\s*\d{2}\s*/, '')
      .replace(/^\s*(?:上午|中午|下午|晚上|早上|傍晚|夜里|凌晨)?\s*(?:\d{1,2}|[一二两三四五六七八九十]{1,3})\s*[点时]\s*(?:钟)?\s*(?:半|一刻|三刻|\d{1,2}\s*分?|[一二三四五六七八九十]{1,3}\s*分)?\s*/, '')
      .trim();
  }

  // 「几点」是否说得够明确：带上午/下午等限定词、24 小时制、或 0/13~23 点这种只有一个意思的写法
  function explicitClock(text) {
    const t = String(text || '');
    if (periodFrom(t)) return true;                            // 上午/下午/晚上…（含「午休」这类明显午后的）
    if (/\d{1,2}\s*[:：]\s*\d{2}/.test(t)) return true;        // 17:00
    const m = t.match(/(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*[点时]/);
    const h = m ? cn2num(m[1]) : null;
    return h !== null && (h === 0 || h > 12);                  // 「十七点」「零点」
  }

  // 裸 12 小时制才算歧义（「五点钟」）：返回小时数用于追问，明确时不返回
  function ambiguousHour(text) {
    const t = String(text || '');
    if (!parseTimeToken(t) || explicitClock(t)) return 0;
    const m = t.match(/(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*[点时]/);
    const h = m ? cn2num(m[1]) : null;
    return h !== null && h >= 1 && h <= 12 ? h : 0;
  }

  // 「下午两点十分」→ { date, time }；没有钟点、或只有歧义的裸钟点，返回 null（交给追问，不猜）
  function absoluteTarget(text, baseMs) {
    const t0 = String(text || '');
    if (/[点时]\s*(小|钱|事|儿)/.test(t0)) return null;   // 「一点小事」「一点钱」不是钟点
    const clock = parseTimeToken(t0);
    if (!clock) return null;
    if (ambiguousHour(t0)) return null;                   // 「五点钟」：上午还是下午，宁可问
    const time = applyPeriod(clock, periodFrom(text));
    const base = Number.isFinite(baseMs) ? baseMs : Date.now();
    const explicit = parseDateToken(text);
    let date = explicit || dayStr(new Date(base));
    // 没说日期、今天这个点已经过了：顺延到明天，避免存一条永远不会提醒的过期事项
    if (!explicit) {
      const ms = dtMs(date, time);
      if (ms !== null && ms < base - 5 * 60000) date = dayStr(new Date(base + 86400000));
    }
    return { date, time };
  }

  // 从「提醒我去午休，十五分钟后吧」里取出事项名「午休」
  function reminderTitleFrom(text) {
    const s = String(text || '');
    const m = s.match(/(?:提醒我|叫我|喊我|帮我记|记一下)\s*([^，。,.！!？?；;\n]{1,20})/);
    if (!m) return '';
    let t = stripLeadTime(m[1]);
    // 时间在前（「十五分钟后午休」）：先剥掉前缀型相对时间，剩下的才是事项
    t = t.replace(/^(?:[一二两三四五六七八九十\d]{1,3}\s*个?\s*(?:分钟|分|小时|钟头)|半\s*个?\s*小时|一刻钟)\s*(?:后|之后|以后|过后)\s*/, '');
    // 时间在后：只有「这一段本身就是时间」才整段清空，不能把后面的事项一起删掉
    t = t.replace(/^[一二两三四五六七八九十\d]{1,3}\s*个?\s*(?:分钟|分|小时|钟头|刻钟)?\s*(?:后|之后|以后)$/, '');
    t = t.replace(/^(?:半\s*个?\s*小时|一刻钟)\s*(?:后|之后|以后)?$/, '');
    t = t.replace(/^(去|要|得|该|先|马上|一会儿|待会儿)/, '');
    t = t.replace(/(吧|呀|啊|哦|嘛|了)$/, '').trim();
    return t.length >= 1 && t.length <= 20 ? t : '';
  }

  // 事项时间归一化：HH:MM 原样；绝对钟点（「两点十分」）按句内时段补全；相对时间按基准换算；否则空
  function normalizeTaskTime(op, userText, baseMs) {
    const raw = String((op && op.time) || '');
    if (/^\d{1,2}:\d{2}$/.test(raw)) return raw;
    const clock = parseTimeToken(raw) || parseTimeToken(userText);
    if (clock) return applyPeriod(clock, periodFrom(raw) || periodFrom(userText));
    const rt = relativeTarget(raw, baseMs) || relativeTarget(userText, baseMs);
    return rt ? rt.time : '';
  }

  // 「下午提醒我洗衣服」这类只给了时段没给钟点的，即使 AI 没标 need 也按缺时间处理
  function lacksClockTime(userText, op) {
    if (!op || op.op !== 'task_add' || op.time) return false;
    if (parseRelativeOffset(userText) !== null) return false;  // 相对时间已经足够精确
    const t = String(userText || '');
    return /(上午|中午|下午|晚上|早上|傍晚)/.test(t) && !/(\d{1,2}\s*[:：]\s*\d{2}|\d{1,2}\s*点|[一二两三四五六七八九十]{1,3}\s*点)/.test(t);
  }

  /* --- 她补充信息时：本地补全并保存（0 次 AI） --- */
  async function applyPending(p, patch) {
    const repo = await loadRepo();
    const d = p.data;
    if (patch.time) {
      let tv = patch.time;
      if (!periodFrom(patch.raw || '') && d.period) tv = applyPeriod(tv, d.period);
      d.time = tv;
      p.missing = p.missing.filter((f) => f !== 'time');
    }
    if (patch.date) { d.date = patch.date; p.missing = p.missing.filter((f) => f !== 'date'); }
    if (patch.amount !== null && patch.amount !== undefined) { d.amount = patch.amount; p.missing = p.missing.filter((f) => f !== 'amount'); }
    if (patch.cat) { d.category = patch.cat; p.missing = p.missing.filter((f) => f !== 'category'); }

    if (p.kind === 'task_add') {
      if (!d.title) { p.missing = ['title']; return { handled: true, reply: askText(p), pending: true }; }
      if (p.missing.length) return { handled: true, reply: askText(p), pending: true };
      await repo.addTask({ title: d.title, date: d.date || todayStr(), time: d.time || '', type: 'todo', note: d.note || '' });
      clearPending(p.id);
      const when = [d.date && d.date !== todayStr() ? d.date : '今天', d.time].filter(Boolean).join(' ');
      return { handled: true, reply: `好，${when} 提醒你${d.title}。已经记在待办里了。`, saved: true };
    }

    if (p.kind === 'tx_add') {
      if (!(d.amount > 0)) return { handled: true, reply: askText(p), pending: true };
      const type = d.type === 'income' ? 'income' : 'expense';
      const pool = type === 'income' ? TX_IN_CATS : TX_CATS;
      const category = pool.includes(d.category) ? d.category : '其他';
      await repo.addTransaction({ type, amount: d.amount, category, date: d.date || todayStr(), note: d.note || '' });
      clearPending(p.id);
      return { handled: true, reply: `记好了，${category}${type === 'income' ? '收入' : '支出'} ${yuan(d.amount)}。`, saved: true };
    }

    if (p.kind === 'pick') {
      const cands = d.candidates || [];
      let target = null;
      if (patch.pickIdx !== null && patch.pickIdx !== undefined && cands[patch.pickIdx]) target = cands[patch.pickIdx];
      if (!target && patch.raw) {
        const hits = cands.filter((c) => String(patch.raw).includes(c.title));
        if (hits.length === 1) target = hits[0];
      }
      if (!target) {
        return { handled: true, reply: `（是哪一件呀？${cands.map((c, i) => `${i + 1}. ${c.title}`).join('  ')}）`, pending: true };
      }
      if (d.action === 'task_done') {
        await repo.completeTask(target.id);
        clearPending(p.id);
        return { handled: true, reply: `好，${target.title}标成做完了。`, saved: true };
      }
      if (d.action === 'task_update_date') {
        const nd = patch.date || (d.patch && d.patch.date);
        if (!nd) return { handled: true, reply: '（要改到哪一天呢？）', pending: true };
        await repo.deferTask(target.id, { date: nd });
        clearPending(p.id);
        return { handled: true, reply: `好，${target.title}改到 ${nd} 了。`, saved: true };
      }
      if (d.action === 'tx_update') {
        if (!(patch.amount > 0)) return { handled: true, reply: '（改成多少呢？）', pending: true };
        await repo.updateTransaction(target.id, { amount: patch.amount });
        clearPending(p.id);
        return { handled: true, reply: `好，那笔改成 ${yuan(patch.amount)} 了。`, saved: true };
      }
      clearPending(p.id);
      return { handled: true, reply: '好，我处理好了。' };
    }

    clearPending(p.id);
    return { handled: false };
  }

  async function tryPending(text) {
    prunePending();
    if (!pendings.length) return { handled: false };
    const raw = String(text || '').trim();
    if (!raw) return { handled: false };

    const time = parseTimeToken(raw);
    const date = parseDateToken(raw);
    const amount = parseAmountToken(raw);
    const cat = parseCategoryToken(raw);
    const pickIdx = parsePickIdx(raw);

    // 补充信息必须短、且确实含时间/日期/金额/分类/序号；否则视为换了话题，丢弃上下文
    const looksSupplement = raw.length <= 24 && supplementResidual(raw).length <= 4 &&
      !!(time || date || amount !== null || (cat && pendings.some((p) => p.kind === 'tx_add')) || pickIdx !== null);
    if (!looksSupplement) { clearPending(); return { handled: false }; }

    const patch = { time, date, amount, cat, pickIdx, raw };

    if (pendings.length > 1) {
      // 多个待处理：只认能唯一定位的补充，否则先问，不擅自关联
      const byTitle = pendings.filter((p) => p.data.title && raw.includes(p.data.title));
      if (byTitle.length === 1) return applyPending(byTitle[0], patch);
      if (pickIdx !== null && pendings[pickIdx]) return applyPending(pendings[pickIdx], patch);
      return { handled: true, reply: `（我还记着几件事：${pendings.map((p) => p.data.title || '这件事').join('、')}，这句是补哪一件呢？）`, pending: true };
    }

    return applyPending(pendings[0], patch);
  }


  async function execute(op) {
    const repo = await loadRepo();
    const kind = String(op.op || '');

    if (kind === 'task_add') {
      const title = String(op.title || '').trim();
      if (!title) return { append: '（事项没听清，再和我说一次？）' };
      const rt = relativeTarget(String(op.time || ''));
      const date = resolveDate(op.date) || (rt ? rt.date : todayStr());
      const time = normalizeTaskTime(op);
      await repo.addTask({ title, date, time, type: 'todo', note: String(op.note || '') });
      return {};
    }

    if (kind === 'task_done') {
      const tasks = (await repo.listTasks()).filter((t) => t.status === 'pending');
      const hits = matchTasks(op.match, tasks);
      if (hits.length === 1) { await repo.completeTask(hits[0].id); return {}; }
      if (hits.length === 0) return { append: '（没找到对应的待办哦）' };
      addPending('pick', { action: 'task_done', candidates: hits.slice(0, 3).map((t) => ({ id: t.id, title: t.title })) }, ['pick']);
      return { append: `（有几件事都像：${hits.slice(0, 3).map((t, i) => `${i + 1}. ${t.title}`).join('  ')}，你说的是哪件？）` };
    }

    if (kind === 'task_update_date') {
      const date = resolveDate(op.date);
      if (!date) return { append: '（要改到哪一天呢？）' };
      const tasks = (await repo.listTasks()).filter((t) => t.status === 'pending');
      const hits = matchTasks(op.match, tasks);
      if (hits.length === 1) { await repo.deferTask(hits[0].id, { date }); return {}; }
      if (hits.length === 0) return { append: '（没找到对应的待办哦）' };
      addPending('pick', { action: 'task_update_date', patch: { date }, candidates: hits.slice(0, 3).map((t) => ({ id: t.id, title: t.title })) }, ['pick']);
      return { append: `（有几件事都像：${hits.slice(0, 3).map((t, i) => `${i + 1}. ${t.title}`).join('  ')}，你说的是哪件？）` };
    }

    if (kind === 'task_query') return { append: await taskQueryText(String(op.range || 'today')) };

    if (kind === 'tx_add') {
      const amount = Number(op.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        addPending('tx_add', pendingData(op), ['amount']);
        return { append: '（多少钱呀？告诉我数字就好。）' };
      }
      const type = op.type === 'income' ? 'income' : 'expense';
      const pool = type === 'income' ? TX_IN_CATS : TX_CATS;
      const category = pool.includes(op.category) ? op.category : '其他';
      const date = resolveDate(op.date) || todayStr();
      await repo.addTransaction({ type, amount, category, date, note: String(op.note || '') });
      return {};
    }

    if (kind === 'tx_update') {
      const rows = await repo.listTransactions();
      const hits = matchTxns(op.match, rows);
      if (hits.length === 1) {
        const patch = {};
        if (op.amount !== undefined && op.amount !== null) patch.amount = Number(op.amount);
        if (op.category) patch.category = op.category;
        if (op.date) { const d = resolveDate(op.date); if (d) patch.date = d; }
        if (op.note !== undefined) patch.note = op.note;
        await repo.updateTransaction(hits[0].id, patch);
        return {};
      }
      if (hits.length === 0) return { append: '（没找到那笔记账哦）' };
      addPending('pick', { action: 'tx_update', candidates: hits.slice(0, 3).map((r) => ({ id: r.id, title: `${r.note || r.category} ${yuan(r.amount)}` })) }, ['pick']);
      return { append: `（有几笔都像：${hits.slice(0, 3).map((r, i) => `${i + 1}. ${r.note || r.category} ${yuan(r.amount)}`).join('  ')}，你说的是哪一笔？）` };
    }

    if (kind === 'tx_query') return { append: await txQueryText(String(op.period || 'today'), op.category ? String(op.category) : null) };

    return {};
  }

  /* ---------------- 提前提醒：本地算时刻，只提醒一次 ----------------
   * 由 app.js 在「消息涉及待办/时间/日期」时才调用；普通闲聊不扫描、不注入提醒。
   * 规则：
   *  - 有明确事项时间 → 提醒时刻 = 事项时间 - 10 分钟；用户另设了提醒时间（remindAt）则以其为准；
   *  - 没有明确时间 → 不生成提醒（不擅自编造精确时刻）；
   *  - 未到提醒时刻返回空；到点后同一「事项 ID + 日期 + 提醒时刻」只触发一次；
   *  - 只取今天、pending 的事项：已完成/已取消/已延期自动失效；改了时间则 key 变化，新时间照常提醒。
   */
  const REMIND_KEY = 'ylxh.butler.reminded';
  const REMIND_AHEAD_MIN = 10;
  const REMIND_MAX_AHEAD_MIN = 15;               // 距事项开始超过 15 分钟：不注入催促式提醒
  const REMIND_STALE_MS = 6 * 60 * 60 * 1000; // 超过 6 小时不再补提醒，避免翻旧账

  function readReminded() {
    try {
      const raw = (typeof localStorage !== 'undefined') && localStorage.getItem(REMIND_KEY);
      const v = raw ? JSON.parse(raw) : [];
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }

  function markReminded(key) {
    try {
      if (typeof localStorage === 'undefined') return;
      const list = readReminded();
      if (list.includes(key)) return;
      list.push(key);
      while (list.length > 120) list.shift();
      localStorage.setItem(REMIND_KEY, JSON.stringify(list));
    } catch (e) { /* 忽略隐私模式写入失败 */ }
  }

  // 「不再打扰」的永久名单：只由「过期不补」与「已真正投递」写入。
  // 旧键 ylxh.butler.reminded 曾被聊天上下文注入路径（remindContext）写入，
  // 那次注入不保证真的说出口（请求失败/回复没提），却会永久吃掉提醒 → 不再作为硬门槛。
  const DONE_KEY = 'ylxh.butler.remind.done';

  function readDone() {
    try {
      const raw = (typeof localStorage !== 'undefined') && localStorage.getItem(DONE_KEY);
      const v = raw ? JSON.parse(raw) : [];
      return Array.isArray(v) ? v.filter((k) => typeof k === 'string') : [];
    } catch (e) { return []; }
  }

  function markDone(key) {
    try {
      if (typeof localStorage === 'undefined' || !key) return;
      const list = readDone().filter((k) => k !== key);
      list.push(key);
      while (list.length > 120) list.shift();
      localStorage.setItem(DONE_KEY, JSON.stringify(list));
    } catch (e) { /* 忽略隐私模式写入失败 */ }
  }

  // 'YYYY-MM-DD' + 'HH:MM' → 本地时间戳；非法返回 null
  function dtMs(day, hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
    const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
    if (!m || !d) return null;
    const h = Number(m[1]), mi = Number(m[2]);
    if (h > 23 || mi > 59) return null;
    return new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), h, mi, 0, 0).getTime();
  }

  // 提醒时刻（毫秒）：用户设过提醒就按用户的，否则提前 10 分钟；没有明确时间返回 null
  function reminderMs(task) {
    const explicit = Number(task && task.remindAt);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    const base = dtMs(task && task.date, task && task.time);
    if (base === null) return null;
    return base - REMIND_AHEAD_MIN * 60000;
  }

  function hhmmOf(ms) { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }

  // 提醒上下文：触发时刻与文案必须同一个基准（ms），且距离事项开始太远时根本不注入
  // P2-a：判定逻辑抽成纯本地 dueReminders()，调度器与 sendMessage 共用同一套规则与去重状态
  const REMIND_SHOWN_KEY = 'ylxh.butler.remind.shown';
  const SHOWN_SUPPRESS_MS = 10 * 60 * 1000;     // 刚由调度器呈现过的提醒，短时间内不在聊天里重复
  const SHOWN_CONTEXT_MS = 40 * 60 * 1000;      // 已经写进提示词的那条，40 分钟内不再反复催

  function readShown() {
    try {
      const raw = (typeof localStorage !== 'undefined') && localStorage.getItem(REMIND_SHOWN_KEY);
      const v = raw ? JSON.parse(raw) : [];
      return Array.isArray(v) ? v.filter((x) => x && typeof x.key === 'string') : [];
    } catch (e) { return []; }
  }

  function markShown(key, at) {
    try {
      if (typeof localStorage === 'undefined' || !key) return;
      const list = readShown().filter((x) => x.key !== key);
      list.push({ key, at: Number(at) || Date.now() });
      while (list.length > 120) list.shift();
      localStorage.setItem(REMIND_SHOWN_KEY, JSON.stringify(list));
    } catch (e) { /* 隐私模式忽略 */ }
  }

  function shownRecently(key, now, winMs) {
    const hit = readShown().filter((x) => x.key === key).pop();
    const win = Number.isFinite(Number(winMs)) ? Number(winMs) : SHOWN_SUPPRESS_MS;
    return !!hit && (now - Number(hit.at || 0)) < win;
  }

  // 已成功投递到聊天的一次性记录：只有 assistant 消息真正落库后才写入，落库失败可重试
  const REMIND_SENT_KEY = 'ylxh.butler.remind.sent';

  function readSent() {
    try {
      const raw = (typeof localStorage !== 'undefined') && localStorage.getItem(REMIND_SENT_KEY);
      const v = raw ? JSON.parse(raw) : [];
      // 兼容两种历史写法：纯字符串 key / { key } 对象（早期写入是字符串，旧解析器会全部读成空）
      if (!Array.isArray(v)) return [];
      return v.map((x) => (typeof x === 'string' ? x : (x && typeof x.key === 'string' ? x.key : null))).filter(Boolean);
    } catch (e) { return []; }
  }

  function markRemindDelivered(key, at) {
    try {
      if (typeof localStorage === 'undefined' || !key) return false;
      heldContextKeys = heldContextKeys.filter((k) => k !== key);
      const list = readSent().filter((k) => k !== key);
      list.push(key);
      while (list.length > 120) list.shift();
      localStorage.setItem(REMIND_SENT_KEY, JSON.stringify(list));
      markShown(key, at);
      return true;
    } catch (e) { return false; }
  }

  // 自然口吻的提醒文案（固定模板，0 次 AI）
  function reminderMessage(hit, nowMs) {
    const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const t = (hit && hit.t) || {};
    const title = String(t.title || '').trim() || '说好的事';
    const taskAt = hit && hit.taskAt !== undefined ? hit.taskAt : dtMs(t.date, t.time);
    const restMin = taskAt === null ? null : Math.round((taskAt - now) / 60000);
    let lead;
    if (restMin === null) lead = `${hhmmOf(hit && hit.ms ? hit.ms : now)} 了。`;
    else if (restMin > 0) lead = `${hhmmOf(taskAt)} 还有 ${restMin} 分钟。`;
    else if (restMin === 0) lead = `${hhmmOf(taskAt)} 到了。`;
    else lead = `${hhmmOf(taskAt)} 已经过了 ${-restMin} 分钟。`;
    const sleepy = /(睡|休息|洗漱|洗澡|上床|晚安)/.test(title);
    const tail = sleepy ? '别熬，去准备一下。' : '别装没看见。';
    return `${lead}${title}——${tail}`;
  }

  // 纯判定：只读事务、不写任何状态（过期项登记「不再打扰」以免反复扫描）
  async function dueReminders(nowMs) {
    let tasks = [];
    try { const repo = await loadRepo(); tasks = await repo.listTasks(); } catch (e) { return []; }
    const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const today = dayStr(new Date(now));
    const done = readDone();
    const sent = readSent();
    const hits = [];

    for (const t of tasks) {
      if (!t || t.status !== 'pending') continue;   // 已完成/已取消：不再用旧提醒
      if (t.date !== today) continue;               // 延期或跨天：不拿旧提醒追人
      const ms = reminderMs(t);
      if (ms === null) continue;                    // 没有明确时间 → 不生成提醒
      const taskAt = dtMs(t.date, t.time);
      if (now < ms) continue;                       // 未到提醒时刻，什么都不说
      // 距离事项开始还超过 15 分钟：不注入催促式提醒（她只是提前设了提醒，不是马上要做）
      if (taskAt !== null && taskAt - now > REMIND_MAX_AHEAD_MIN * 60000) continue;
      const key = `${t.id}|${t.date}|${ms}`;
      if (done.indexOf(key) !== -1) continue;       // 已经过期作废，不再翻旧账
      if (sent.indexOf(key) !== -1) continue;       // 已经成功投递到聊天：不再重复
      if (now - ms > REMIND_STALE_MS) { markDone(key); continue; }
      hits.push({ t, ms, taskAt, key });
    }
    return hits;
  }

  // 单条提醒的事实描述（与既有文案语义逐字一致）
  function reminderLine(hit, now) {
    const { t, ms, taskAt } = hit;
    const explicit = Number.isFinite(Number(t.remindAt)) && Number(t.remindAt) > 0;
    const toStart = taskAt === null ? null : Math.round((taskAt - now) / 60000);
    let when;
    if (toStart === null) {
      when = `你定过 ${hhmmOf(ms)} 提醒她`;
    } else if (toStart > 0) {
      when = `距离 ${t.time} 开始还有 ${toStart} 分钟（提醒时刻 ${hhmmOf(ms)} 已到）`;
    } else if (toStart === 0) {
      when = `${t.time} 到点，就是现在（提醒时刻 ${hhmmOf(ms)}）`;
    } else {
      when = `${t.time} 已经过去 ${-toStart} 分钟（提醒时刻 ${hhmmOf(ms)}）`;
    }
    if (explicit) when += `；这个提醒时刻是她自己定的`;
    return `- ${t.title}：${when}`;
  }

  // 本轮注入过提醒的条目：只有这条回复真的提到了它、并且落库成功，调用方才把它记为「已说出」
  let pendingContextKeys = [];
  // 注入过但模型没说出口的：允许调度器绕过一次「刚呈现过」的抑制，立刻补一句
  let heldContextKeys = [];

  async function remindContext(nowMs) {
    const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const hits = await dueReminders(now);
    // 刚刚由调度器在页面上呈现过的，这轮不重复播报
    const fresh = hits.filter((h) => !shownRecently(h.key, now, SHOWN_CONTEXT_MS));
    if (!fresh.length) { pendingContextKeys = []; return ''; }

    const used = fresh.slice(0, 2);
    const lines = used.map((hit) => {
      markShown(hit.key, now);                      // 10 分钟软抑制：同一窗口连续几轮不反复催
      return reminderLine(hit, now);
    });
    // 注入不等于说出口：请求失败/回复没提到时不得消费，交给调度器在窗口内补投递
    pendingContextKeys = used.map((h) => ({
      key: h.key,
      title: String((h.t && h.t.title) || '').trim(),
      clock: String((h.t && h.t.time) || ''),      // 事项时间（她最容易复述的那个）
      at: hhmmOf(h.ms),                           // 提醒时刻
    }));

    return [
      `【提醒她一次】现在是 ${hhmmOf(now)}。`,
      ...lines,
      `上面写的是事项时间和提醒时刻，都不是当前时间；当前只有 ${hhmmOf(now)}，不要把她的 ${fresh[0].t.time || '事项时间'} 说成"已经到点了"。`,
      '只说这一次：可以认真、带一点不容敷衍的训诫语气；但她正好在说心里话或撒娇，就先把那句话接住，再顺一句带过。不要连着催，不要要她汇报，这轮之后不要再主动提。',
    ].join('\n');
  }

  // P2-a：调度器入口。只做本地判定与「呈现一次」的状态记录，不产生任何 AI 请求。
  async function remindTick(nowMs, opts) {
    const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const o = opts || {};
    const hits = await dueReminders(now);
    const out = [];
    for (const hit of hits) {
      if (out.length >= 2) break;
      // 模型没把这条说出口时，允许绕过一次抑制，避免「聊过一轮就再也没提醒」
      const held = heldContextKeys.indexOf(hit.key) !== -1;
      if (!held && shownRecently(hit.key, now)) continue;
      // o.commit === false：调用方要先把消息写入聊天，成功后再自行标记，避免落库失败却永久消费
      if (o.commit !== false) markShown(hit.key, now);
      if (held) heldContextKeys = heldContextKeys.filter((k) => k !== hit.key);
      out.push({
        key: hit.key,
        title: hit.t.title,
        text: reminderMessage(hit, now),
        line: reminderLine(hit, now),
        at: now,
      });
    }
    return out;
  }

  /* ---------------- 高置信本地查询（完全匹配固定句式，0 次 AI） ---------------- */
  async function tryLocal(text) {
    const t = String(text || '').trim().replace(/[?？。!！~～\s]+$/g, '');
    try {
      let m = t.match(/^(今天|明天|明日)有(什么|啥)?(安排|待办|日程)$/) || t.match(/^(今天|明天|明日)的安排$/);
      if (m) {
        const range = m[1] === '今天' ? 'today' : 'tomorrow';
        return { handled: true, reply: await taskQueryText(range) };
      }
      m = t.match(/^(今天|这个月|本月)(一共)?花了?多少钱$/) || t.match(/^(今天|这个月|本月)(一共)?(消费|支出)了?多少(钱)?$/);
      if (m) return { handled: true, reply: await txQueryText(m[1] === '今天' ? 'today' : 'month', null) };
      m = t.match(/^(这个月|本月)(餐饮|交通|购物|日用|娱乐|其他)(一共)?花了?多少(钱)?$/);
      if (m) return { handled: true, reply: await txQueryText('month', m[2]) };
    } catch (e) { /* 本地查询失败则回落到 AI 链路 */ }
    return { handled: false };
  }

  /* ---------------- 处理 AI 回复：提取并剥离 <bl> 标记，执行本地操作 ---------------- */
  // 一条回复可能带多个 <bl> 标记，也可能把多笔放进 {"ops":[...]}；两种都要逐笔执行。
  // 未闭合的尾标记也要取出来执行，否则会出现「看得到 tx_add、却没写库」。
  function markerChunks(raw) {
    const chunks = [];
    const re = /<bl>\s*([\s\S]*?)\s*<\/bl>/g;
    let m;
    while ((m = re.exec(raw)) !== null) chunks.push(m[1]);
    const lastOpen = raw.lastIndexOf('<bl>');
    if (lastOpen > raw.lastIndexOf('</bl>')) {
      const tail = raw.slice(lastOpen + 4);
      const end = tail.indexOf('}');
      if (end !== -1) chunks.push(tail.slice(0, end + 1));
    }
    return chunks;
  }

  function opsFromChunk(chunk) {
    let v;
    try { v = JSON.parse(chunk); } catch (e) { return []; }
    const list = Array.isArray(v) ? v : (v && Array.isArray(v.ops) ? v.ops : [v]);
    return list.filter((x) => x && typeof x === 'object' && x.op);
  }

  // 无论执行成功与否，操作标记/裸 JSON 指令都不能出现在用户可见正文里。
  function stripInternal(raw) {
    let s = String(raw || '');
    s = s.replace(/<bl>[\s\S]*?<\/bl>/g, '');
    s = s.replace(/<bl>([\s\S]*?\})/g, '');          // 未闭合：连到第一个 } 一起删，保留后面的自然语言
    s = s.replace(/<bl>[\s\S]*$/g, '');              // 连 } 都没有：整段视为指令删掉
    s = s.replace(/<\/bl>/g, '');
    s = s.replace(/\{[^{}]*"op"[^{}]*\}/g, '');            // 裸 JSON 指令（不在标记里）同样不展示
    return s.trim();
  }

  const WRITE_OPS = new Set(['task_add', 'tx_add', 'task_done', 'task_update_date', 'tx_update']);
  const SUCCESS_CLAIM_RE = /(记上|记好|记下|记了|记进|记到|已记|logged|recorded|saved|noted|both)/i;

  // 写库失败（或只写出一部分）时，把模型抢先说的成功话术去掉，只留本地按结果生成的确认。
  function withoutSuccessClaims(display) {
    const s = String(display || '');
    const i = s.indexOf('|||');
    const zh = i === -1 ? s : s.slice(0, i);
    const en = i === -1 ? '' : s.slice(i + 3);
    const clean = (part) => String(part || '').split(/(?=[。！？!?\n])/)
      .filter((seg) => !SUCCESS_CLAIM_RE.test(seg)).join('').trim();
    const cz = clean(zh), ce = clean(en);
    return i === -1 ? cz : (ce ? `${cz} ||| ${ce}` : cz);
  }
  // baseMs：收到这条消息的本地时间（由 app.js 传入），相对时间以它为准，而不是 AI 回复完成的那一刻
  /* 同一条消息的幂等保护：只用「消息时间戳 + 原文」标识一次处理，不看标题/日期/时间，
   * 所以用户有意再建一条同名事项不会被拦；仅在写入成功后记账，失败不记账以便重试。 */
  let handledMsg = { key: '', at: 0 };
  const REPLAY_MS = 120000;
  function msgKey(baseMs, userText) {
    const t = String(userText || '').trim();
    const b = Number(baseMs) || 0;
    return t && b ? `${b}|${t}` : '';
  }
  function isReplay(key) {
    return !!key && key === handledMsg.key && (Date.now() - handledMsg.at) < REPLAY_MS;
  }
  function markHandled(key) { if (key) handledMsg = { key, at: Date.now() }; }

  // 她说清楚了几点时，才认为这是一次「要落库」的交代；纯闲聊里的「提醒我」不算
  const TIME_WORD_RE = /(\d{1,2}\s*[:：]\s*\d{2}|\d{1,2}\s*点|[一二两三四五六七八九十]{1,3}\s*点|分钟后|小时后|一刻钟|半小时)/;

  async function handleAIResponse(rawReply, userText, baseMs) {
    const raw = String(rawReply || '');
    const key = msgKey(baseMs, userText);
    const rel = relativeTarget(userText, baseMs);   // "十五分钟后" → 具体时刻

    // 先把全部操作取出来；标记本身一律从用户可见正文里剥离。
    const ops = [];
    for (const chunk of markerChunks(raw)) ops.push(...opsFromChunk(chunk));
    const text = stripInternal(raw);

    // 没有标记但确实是「提醒我 + 明确时间（相对或绝对）」：本地兜底建待办，避免只口头承诺却不落地
    if (!ops.length) {
      const title = reminderTitleFrom(userText);
      const wantsRemind = /(提醒我|叫我|喊我)/.test(String(userText || ''));
      if (!wantsRemind) return text;                        // 不是在托她记事，一个字都不加
      if (isReplay(key)) return text;                       // 同一条消息已落过库：不重复写、不重复确认
      const when = rel || absoluteTarget(userText, baseMs);
      if (!when) {
        const h = ambiguousHour(userText);
        if (h) {                                            // 时间有歧义：追问，不猜
          if (/[?？]/.test(text)) return text;               // 模型已经在问了，不叠一句
          return appendToReply(text, `${h}点是上午还是下午？`);
        }
        if (!TIME_WORD_RE.test(String(userText || ''))) return text;
        return appendToReply(text, '（这条我没记下来：时间没算准，你再说一次？）');
      }
      if (!title) {
        if (!TIME_WORD_RE.test(String(userText || ''))) return text;
        return appendToReply(text, '（这条我没记下来：没听清要提醒什么，你再说一次？）');
      }
      try {
        const repo = await loadRepo();
        await repo.addTask({ title, date: when.date, time: when.time, type: 'todo', note: '' });
        markHandled(key);                                   // 写成功才记账
        if (confirmedIn(text, title)) return text;           // 模型已经自然确认过，不再贴系统腔
        const label = when.date === dayStr(new Date()) ? '今天' : when.date;
        return appendToReply(text, `记好了，${title} ${label} ${when.time}，提前十分钟提醒你。`);
      } catch (e) {
        return appendToReply(text, `（没记上：${e && e.message ? e.message : '保存失败'}。这件事没有设置提醒。）`);
      }
    }

    let display = text;
    const results = [];
    const txAttempts = [];
    const notes = [];
    let anyWrite = false;

    for (const op of ops) {
      // 相对时间：模型写成 "15分钟后" 或干脆没写 time，都按收到消息的时间补齐
      if (op.op === 'task_add') {
        const t = normalizeTaskTime(op, userText, baseMs);
        if (t) op.time = t;
        if (rel) {
          const d = resolveDate(op.date);
          if (!d || d === todayStr()) op.date = rel.date;   // 跨天时日期跟着走
        }
      }

      // 信息不全：不猜、不写库，转成临时上下文；下一条补充由本地补全（AI 已在回复里追问）
      const need = Array.isArray(op.need) ? op.need.slice() : [];
      if (op.op === 'task_add' && !String(op.title || '').trim() && !need.includes('title')) need.push('title');
      if (op.op === 'tx_add' && !(Number(op.amount) > 0) && !need.includes('amount')) need.push('amount');
      if (lacksClockTime(userText, op) && !need.includes('time')) need.push('time');
      if (need.length) {
        const data = pendingData(op);
        const per = periodFrom(userText);
        if (per && !data.period) data.period = per;
        addPending(op.op, data, need);
        if (op.op === 'tx_add') txAttempts.push({ op, ok: false, pending: true });
        // AI 忘了追问时，本地补一句，避免她不知道该回什么
        if (!/[?？]/.test(display)) notes.push(askText({ missing: need, data }));
        continue;
      }

      if (WRITE_OPS.has(op.op) && isReplay(key)) continue;   // 同一条消息重复处理：不重复写

      if (WRITE_OPS.has(op.op)) anyWrite = true;
      let result;
      try {
        const res = await execute(op);
        result = { op, ok: true, append: res && res.append };
        results.push(result);
        if (result.append) notes.push(result.append);
        // 建好后确认一次：她没听到确认时本地补一句（只在这一轮，之后不再提）
        if (op.op === 'task_add' && !(res && res.append)) {
          const title = String(op.title || '').trim();
          const time = /^\d{1,2}:\d{2}$/.test(String(op.time || '')) ? String(op.time) : '';
          if (title && !confirmedIn(display, title)) {
            notes.push(`记好了，${title}${time ? ' ' + time : ''}，到点前我提醒你。`);
          }
        }
      } catch (e) {
        result = { op, ok: false, error: e };
        results.push(result);
      }
      if (op.op === 'tx_add') txAttempts.push(result);
    }

    // 记账确认只按真实落库结果播报：写失败/只写成功一部分时，撤掉模型抢先说的「都记上了」。
    const failed = results.filter((r) => !r.ok);
    if (txAttempts.length > 1 || (txAttempts.length === 1 && /(两顿|两笔|都记上|都记好|都记了|both|all)/i.test(display))) {
      const line = (r) => {
        const amount = Number(r.op.amount) > 0 ? ` ${yuan(r.op.amount)}` : '';
        return `${String(r.op.note || '').trim() || '一笔'}${amount}`;
      };
      const okList = txAttempts.filter((r) => r.ok).map(line);
      const badList = txAttempts.filter((r) => !r.ok);
      if (okList.length) notes.push(`已记下：${okList.join('、')}。`);
      if (badList.length) notes.push(`没记上：${badList.map(line).join('、')}（${badList.some((r) => r.pending) ? '还差金额，' : ''}保存失败，没有写进账单）。`);
      if (failed.length || badList.length || txAttempts.length === 1) display = withoutSuccessClaims(display);
    } else if (failed.length) {
      const names = failed.map((r) => {
        const o = r.op;
        if (o.op === 'tx_add') return `${String(o.note || '').trim() || '一笔'} ${yuan(o.amount)}`;
        return String(o.title || o.match || o.op || '这件事');
      }).join('、');
      notes.push(`（没记上：${names} 保存失败，没有写进账单/待办，请再说一次。）`);
      display = withoutSuccessClaims(display);
    }
    if (notes.length) display = notes.reduce((s, n) => appendToReply(s, n), display);
    if (anyWrite && !failed.length) markHandled(key);
    return display;
  }

  const ButlerIntent = {
    gate,
    classify,
    needsClockContext,
    systemPrompt,
    tryLocal,
    tryPending,
    remindContext,
    dueReminders,
    remindTick,
    reminderMessage,
    markRemindDelivered,
    // 取走本轮注入的提醒 key。给了回复文本时，只返回「回复里真的提到了」的那些：
    // 模型没提到 ≠ 已经提醒过，不能因为回复落库就把这条提醒永久消费掉（否则调度器再也不会补一句）。
    takeContextKeys(replyText) {
      const list = pendingContextKeys.slice();
      pendingContextKeys = [];
      if (typeof replyText !== 'string') return list.map((x) => x.key);
      const said = [];
      list.forEach((item) => {
        const title = String(item.title || '');
        const clock = String(item.clock || '');
        const at = String(item.at || '');
        const hit = (title && replyText.indexOf(title) !== -1)
          || (clock && replyText.indexOf(clock) !== -1)
          || (at && replyText.indexOf(at) !== -1);
        // 没有任何可核对的信息时才按「已说出」处理，避免无标题的提醒被反复打扰
        if (hit || (!title && !clock && !at)) said.push(item.key);
        else {
          heldContextKeys.push(item.key);        // 没说出口：留给调度器立刻补一句
          if (heldContextKeys.length > 20) heldContextKeys.shift();
        }
      });
      return said;
    },
    wasRemindDelivered(key) { return readSent().indexOf(key) !== -1; },
    reminderMs,
    hasPending,
    clearPending,
    handleAIResponse,
    resolveDate,
    parseRelativeOffset,
    relativeTarget,
    absoluteTarget,
    ambiguousHour,
    parseTimeToken,
    reminderTitleFrom,
    _setRepository(repo) { api._repo = repo; },
    _resetHandled() { handledMsg = { key: '', at: 0 }; },
  };

  (typeof window !== 'undefined' ? window : globalThis).ButlerIntent = ButlerIntent;
})();
