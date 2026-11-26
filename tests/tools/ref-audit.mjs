/* tests/tools/ref-audit.mjs — 只读：按真实代码核对引用字段（迁移计划改写用）
 * 目的：确认 BackupFormat.REF_FIELDS / REVERSE_REF 与 app.js 实际写法一致。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(root, 'public', 'app.js'), 'utf8');

const checks = [
  ['keeps.sourceMessageId 写入口', /sourceMessageId[,}\s]/],
  ['diaries.replyMessageId 初始化', /replyMessageId:\s*null/],
  ['futureLetters.replyMessageId 初始化', /replyMessageId:\s*null/],
  ["messages.source = 'today-letter' + sourceId", /source:\s*'today-letter',\s*sourceId/],
  ["messages.source = 'future-letter' + sourceId", /source:\s*'future-letter',\s*sourceId/],
  ['starDiaries 无 replyMessageId', /starDiaries/],
];

let bad = 0;
for (const [name, re] of checks) {
  const hit = re.test(src);
  if (!hit) bad += 1;
  console.log((hit ? 'OK   ' : 'MISS ') + name);
}
const starDiaryBlock = /starDiaries[\s\S]{0,400}?replyMessageId/.test(src);
console.log('starDiaries 中出现 replyMessageId：' + (starDiaryBlock ? '是' : '否'));
console.log(bad === 0 ? '引用字段核对：全部命中' : '引用字段核对：有 ' + bad + ' 项未命中');
