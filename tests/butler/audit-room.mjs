/**
 * 房间聊天记录只读盘点（不删除、不修改任何数据）
 * 用法：node tests/butler/audit-room.mjs "<备份json路径>"
 * 输入：房间页 设置 → 导出备份 生成的文件（exportData 产物）
 */
import { readFileSync } from 'node:fs';

const p = process.argv[2];
if (!p) { console.error('缺少备份文件路径'); process.exit(1); }
const d = JSON.parse(readFileSync(p, 'utf8'));

const pad = (n) => String(n).padStart(2, '0');
const fmt = (t) => {
  if (!t) return '---- -- --';
  const x = new Date(t);
  return `${pad(x.getMonth() + 1)}-${pad(x.getDate())} ${pad(x.getHours())}:${pad(x.getMinutes())}`;
};

const TEST_KEYS = [
  ['待办/提醒', /提醒我|待办|记好了|没记上|没记下来|记下来了|帮你记|设置提醒|remindAt/],
  ['相对时间', /(分钟|小时|钟头|刻钟)\s*(后|之后|以后|过后)|半个?小时/],
  ['钟点解析', /[一二三四五六七八九十两\d]{1,3}\s*点(钟|半)?/],
  ['机械确认', /^(好的?[，,。]?\s*)?(记好了|已记下|记下了|好的，我提醒你|我帮你记下)/],
  ['写入失败', /没记上|这条我没记下来|没记下来|写入失败|保存失败/],
  ['时间歧义', /上午还是下午|是指上午|是下午吗/],
  ['OOC/出戏', /(作为|我是一个?)(AI|人工智能|语言模型)|系统提示|OOC|出戏|我无法|扮演|角色设定/i],
  ['技术名词', /indexeddb|数据库|控制台|console|api|token|报错|bug|代码/i],
];
const LIFE_HINTS = /吃饭|睡|午休|喝水|累|想|亲|抱|晚安|早安|手术|中医|课|考试|妈妈|爸爸|天气|冷|饿|痛|月经|肚子/;

const msgs = (d.messages || []).slice().sort((a, b) => (a.time || 0) - (b.time || 0));

// 会话切分：间隔 > 25 分钟视为新一段
const sessions = [];
for (const m of msgs) {
  const last = sessions[sessions.length - 1];
  if (!last || (m.time || 0) - last.end > 25 * 60 * 1000) sessions.push({ start: m.time, end: m.time, items: [m] });
  else { last.items.push(m); last.end = m.time; }
}

const rows = msgs.map((m) => {
  const c = (m.content || '').replace(/\s+/g, ' ');
  const hits = TEST_KEYS.filter(([, re]) => re.test(c)).map(([k]) => k);
  return {
    id: m.id, time: m.time, role: m.role, source: m.source || '',
    len: c.length, snippet: c.slice(0, 70),
    hits, life: LIFE_HINTS.test(c),
    eng: !!(m.englishContent || '').trim(),
    game: m.game ? (m.game.name || m.game.result || 'game') : '',
  };
});

console.log(`总消息 ${msgs.length} 条，会话段 ${sessions.length} 段`);
console.log(`时间范围 ${fmt(msgs[0]?.time)} ~ ${fmt(msgs[msgs.length - 1]?.time)}`);
const bySource = {};
for (const r of rows) bySource[r.source || '(无)'] = (bySource[r.source || '(无)'] || 0) + 1;
console.log('source 分布', JSON.stringify(bySource));

console.log('\n==== 分段概览 ====');
sessions.forEach((s, i) => {
  const hitN = s.items.filter((m) => {
    const c = (m.content || '').replace(/\s+/g, ' ');
    return TEST_KEYS.some(([, re]) => re.test(c));
  }).length;
  console.log(`S${i + 1} ${fmt(s.start)}~${fmt(new Date(s.end).getTime())} 共${s.items.length}条 命中${hitN} | ${(s.items[0].content || '').slice(0, 40)}`);
});

console.log('\n==== 标记为「疑似开发测试」的消息 ====');
for (const r of rows) {
  if (r.hits.length >= 2 || (r.hits.length === 1 && !r.life)) {
    console.log(`#${r.id} ${fmt(r.time)} ${r.role === 'user' ? '菲' : '星'} [${r.hits.join('/')}] ${r.snippet}`);
  }
}

console.log('\n==== 其它（人工判断用，全部列出）====');
for (const r of sessions.flatMap((s) => s.items)) {
  const row = rows.find((x) => x.id === r.id);
  const suspect = row.hits.length >= 2 || (row.hits.length === 1 && !row.life);
  if (!suspect) continue;
  console.log(`#${row.id} ${fmt(row.time)} ${row.role === 'user' ? '菲' : '星'} ${row.snippet}`);
}

console.log('\n==== 跨表引用 ====');
const ref = (arr, field) => (arr || []).map((x) => `${x.id}->${x[field]}`).filter((s) => !s.endsWith('->null') && !s.endsWith('->undefined'));
console.log('diaries.replyMessageId:', ref(d.diaries, 'replyMessageId').join(', ') || '无');
console.log('futureLetters.replyMessageId:', ref(d.futureLetters, 'replyMessageId').join(', ') || '无');
console.log('keeps.sourceMessageId:', ref(d.keeps, 'sourceMessageId').join(', ') || '无');
console.log(`diaries=${(d.diaries || []).length} starDiaries=${(d.starDiaries || []).length} keeps=${(d.keeps || []).length} futureLetters=${(d.futureLetters || []).length}`);

console.log('\n==== 长期记忆检查 ====');
const mem = d.longTermMemory || '';
console.log(`长度 ${mem.length} 字`);
if (mem) {
  const bad = TEST_KEYS.filter(([, re]) => re.test(mem)).map(([k]) => k);
  console.log('可疑关键词:', bad.join('/') || '无');
  console.log('--- 全文 ---\n' + mem);
}
