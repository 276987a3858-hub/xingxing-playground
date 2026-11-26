/* tests/chat/close-talk-prompt-browser.mjs
 * 第一批：小星亲密互动表达与行为判断修复（只读 stub 验证，零真实 AI 请求）
 * 覆盖：
 *  1. 动作描写由「绝对禁止」改为「允许一两笔、禁止大段旁白」
 *  2. Dom 感与相处分寸的冲突已消除
 *  3. 亲近/情绪轮次才追加判断规则（害羞≠拒绝、明确拒绝=立刻停、不确定就问）
 *  4. 亲近轮次关闭「可以不说话」，且沉默理由里删掉了「逗你」
 *  5. 普通聊天/来信/日记/珍藏走的 getSystemPrompt 不含新增块
 */
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = path.resolve('public');
const PORT = 9481, CDP = 9482;
let reqs = [];
let totalMain = 0;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api') {
    let bodyText = '';
    req.on('data', (c) => { bodyText += c; });
    req.on('end', () => {
      let body = {}; try { body = JSON.parse(bodyText); } catch {}
      const msgs = body.messages || [];
      const sys = String(msgs[0]?.content || '');
      const translator = sys.includes('professional translator');
      if (!translator) totalMain++;
      reqs.push({ translator, sys });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: translator ? 'stub english' : '我在。' } }] }));
    });
    return;
  }
  let p = decodeURIComponent(u.pathname); if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !existsSync(f)) { res.writeHead(404); res.end(); return; }
  const ext = path.extname(f);
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' }[ext] || 'application/octet-stream';
  res.writeHead(200, { 'content-type': mime }); res.end(readFileSync(f));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

let pass = 0, fail = 0;
const check = (n, cond, d = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.join(tmpdir(), 'bl-close-talk-' + Date.now());
const browser = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP}`, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });

let ws;
try {
  let info = null;
  for (let i = 0; i < 40 && !info; i++) { try { const r = await fetch(`http://127.0.0.1:${CDP}/json/version`); if (r.ok) info = await r.json(); } catch {} if (!info) await sleep(250); }
  if (!info) throw new Error('DevTools 未就绪');
  ws = await new Promise((res, rej) => { const s = new WebSocket(info.webSocketDebuggerUrl); s.onopen = () => res(s); s.onerror = rej; });

  const pending = new Map(); let id = 0, sid = null;
  const external = [], errors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); return; }
    if (m.method === 'Network.requestWillBeSent' && m.sessionId === sid) {
      const url = m.params.request.url;
      if (!url.startsWith('http://127.0.0.1') && !url.startsWith('data:') && !url.startsWith('blob:')) external.push(url);
    }
    if (m.method === 'Runtime.exceptionThrown' && m.sessionId === sid) errors.push(String(m.params.exceptionDetails?.exception?.description || ''));
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    id++; pending.set(id, { resolve, reject });
    const p = { id, method, params }; if (sid && !method.startsWith('Target.')) p.sessionId = sid;
    ws.send(JSON.stringify(p)); setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('超时 ' + method)); } }, 20000);
  });
  const ev = async (expr) => {
    const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  sid = (await call('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  await call('Page.enable'); await call('Runtime.enable'); await call('Network.enable');
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const of = window.fetch.bind(window);
    window.fetch = (url, opts) => {
      if (typeof url === 'string' && url.includes('wttr.in')) {
        return Promise.resolve(new Response(JSON.stringify({ current_condition: [{ weatherDesc: [{ value: '晴朗' }] }] }), { headers: { 'content-type': 'application/json' } }));
      }
      return of(url, opts);
    };
  })();` });
  await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  for (let i = 0; i < 50; i++) { if (await ev(`document.readyState==='complete' && typeof sendMessage==='function'`).catch(() => false)) break; await sleep(200); }
  await sleep(400);
  await ev(`apiKey='stub'; settings.showEnglish=false; settings.voiceEnabled=false;
    requestAndPlaySpeech = function(){ return Promise.resolve(''); };
    if (window.LifeScheduler && window.LifeScheduler.stop) window.LifeScheduler.stop();
    if (window.LifePresence && window.LifePresence.stop) { try { window.LifePresence.stop(); } catch(e){} }
    'ok'`);

  const send = (text) => ev(`(function(){
    const el = document.getElementById('chatInput'); el.value = ${JSON.stringify(text)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return sendMessage();
  })()`);
  // 每次发完都必须真的抓到请求，否则直接判失败（避免「没有请求也算通过」的假绿）
  const sendSys = async (text, label) => {
    reqs = [];
    await send(text);
    const r = reqs.filter((x) => !x.translator).slice(-1)[0];
    if (!r) { console.log(`FAIL  [harness] 没有捕获到请求：${label} / ${text}`); fail++; return ''; }
    return r.sys;
  };
  const CLOSE_TAG = '【先读懂她，再决定怎么接】';
  const SILENT_TAG = '【偶尔可以不说话】';

  // ---------- 1. 基础提示词：五层接入后，人格主体来自 Persona.baseText()，动作/情绪规则在亲近事件提示词 ----------
  const base = await ev(`getSystemPrompt()`);
  const personaBase = await ev(`window.Persona.baseText()`);
  const closePrompt = await ev(`getCloseTalkPrompt()`);
  const actPrompt = await ev(`getActionDensityPrompt()`);
  check('C01 已取消「绝对禁止使用括号描述动作或心理」', !base.includes('绝对禁止使用括号描述动作或心理'));
  check('C02 情绪优先落在话里，动作仍是可选表达（正向规则）',
    actPrompt.includes('你在和用户直接说话，不是在写旁白') && actPrompt.includes('动作和神态是补充'));
  check('C03 仍禁止大段舞台说明与内心独白', closePrompt.includes('不写露骨内容') && closePrompt.includes('不写大段旁白'));
  check('C04 日常简短风格保留（新版：自然简洁，无固定 1-3 句硬上限）',
    personaBase.includes('表达自然、简洁') && !personaBase.includes('必须简短自然（1-3句）'));

  // ---------- 2. Dom 感与相处分寸：主体迁入一层人设，情绪判断在亲近事件提示词 ----------
  check('C05 退让/尊重明确停止的边界保留', personaBase.includes('明确拒绝或要求停止时') && closePrompt.includes('立刻停'));
  check('C06 明确不把害羞/撒娇当作退缩', closePrompt.includes('害羞、撒娇、嘴硬、别开脸'));
  check('C07 保留主导与掌控，没有改成温顺', personaBase.includes('Dom 气质、占有欲和掌控欲') && closePrompt.includes('笃定把用户留住'));
  check('C08 「拒绝只针对事情本身、不挡用户靠近」仍保留在按需背景层',
    await ev(`(function(){window.Persona.reset(); return window.Persona.background('拒绝','').includes('拒绝的是事情本身')})()`));

  // ---------- 3. 判断规则只在亲近轮次注入 ----------
  check('C09 getSystemPrompt 本体不含新增判断块（来信/日记/珍藏不受影响）',
    !base.includes(CLOSE_TAG) && !base.includes('不等于拒绝'));

  let sys = await sendSys('今天下午开会好无聊，坐得腰都僵了', 'ordinary');
  check('C10 普通聊天不注入判断块', !sys.includes(CLOSE_TAG), sys.includes(CLOSE_TAG) ? '误注入' : '');
  check('C11 普通聊天仍保留「偶尔可以不说话」', sys.includes(SILENT_TAG));

  sys = await sendSys('这个周末要加班，有点烦', 'ordinary-2');
  check('C12 一般抱怨不误判为亲近轮次', !sys.includes(CLOSE_TAG));

  sys = await sendSys('你靠这么近，我会脸红', 'shy');
  check('C13 害羞/亲近输入注入判断块', sys.includes(CLOSE_TAG));
  check('C14 规则写明害羞不等于拒绝', sys.includes('不等于拒绝') && sys.includes('把用户留住'));
  check('C15 写明明确拒绝要立刻停、不当欲拒还迎',
    sys.includes('就是真的不要') && sys.includes('立刻停') && sys.includes('不要当成欲拒还迎'));
  check('C16 写明不确定就先问、不替她决定', sys.includes('就直接问一句') && sys.includes('拿不准就别替用户决定'));
  check('C17 写明她已表达意愿就不再要她证明', sys.includes('不要再要用户证明') || sys.includes('不要再要她证明'));
  check('C18 写明她不适时先收起主导', sys.includes('先把主导收起来'));
  check('C18b 亲近轮次允许略长，但明确仍是短回复', sys.includes('三到五句也行') && sys.includes('普通闲聊还是照旧简短'));
  check('C19 亲近轮次关闭「可以不说话」', !sys.includes(SILENT_TAG));
  check('C20 亲近轮次不提供 [[SILENT]] 标记写法', !sys.includes('[[SILENT:'));

  sys = await sendSys('不要，停一下', 'refuse');
  check('C21 明确拒绝同样走判断块', sys.includes(CLOSE_TAG) && sys.includes('不要当成欲拒还迎'));

  sys = await sendSys('你昨天又故意逗我，讨厌', 'tease');
  check('C22 调侃/撒娇不触发沉默选项', !sys.includes(SILENT_TAG) && sys.includes(CLOSE_TAG));

  // ---------- 4. 短承接句沿上一句语境 ----------
  await sendSys('抱抱我', 'echo-prev');
  sys = await sendSys('还要', 'echo');
  check('C23 短承接句沿用上一句的亲近语境', sys.includes(CLOSE_TAG));

  await sendSys('明天几点的车', 'plain-prev');
  sys = await sendSys('还要', 'echo-2');
  check('C24 上一句是普通话题时，短句不乱判', sys.includes('你是小星') && !sys.includes(CLOSE_TAG));

  // ---------- 5. 沉默机制本身 ----------
  const silentPrompt = await ev(`getChatSilencePrompt()`);
  check('C25 沉默理由里已删除「故意逗你/捉弄你」', !silentPrompt.includes('故意逗你') && !silentPrompt.includes('捉弄你'));
  check('C26 明确禁止因调侃/撒娇/想靠近而沉默',
    silentPrompt.includes('撒娇') && silentPrompt.includes('绝对不许沉默'));
  check('C27 其他沉默规则未被削弱（求助/不适必须回复）',
    silentPrompt.includes('必须正常回复，绝对不能沉默') && silentPrompt.includes('不要连着两轮都用'));

  // ---------- 6. 检测函数边界 ----------
  const detect = JSON.parse(await ev(`JSON.stringify({
    a: looksLikeCloseTalk('把今天的水果放冰箱', []),
    b: looksLikeCloseTalk('我有一点委屈', []),
    c: looksLikeCloseTalk('嗯', [{role:'user',content:'抱抱我'}]),
    d: looksLikeCloseTalk('嗯', [{role:'user',content:'明天几点开会'}]),
    e: looksLikeCloseTalk('', [])
  })`));
  check('C28 检测函数：日常句不命中', detect.a === false);
  check('C29 检测函数：情绪句命中', detect.b === true);
  check('C30 检测函数：承接句按上文命中/不命中', detect.c === true && detect.d === false && detect.e === false);

  // ---------- 7. 统一对话表达规范：六条直接互动路径共用同一份文本 ----------
  const ACT_TAG = '【对话的写法】';
  const sysOrd = await sendSys('今天下午开会好无聊，坐得腰都僵了', 'density-ordinary');
  const sysClose = await sendSys('你靠这么近，我会脸红', 'density-close');
  check('C34 普通聊天注入统一表达规范', sysOrd.includes(ACT_TAG));
  check('C35 亲近轮同样注入统一表达规范', sysClose.includes(ACT_TAG));
  // 验证实际拼装后的完整 system，而非只测孤立字符串
  check('C36 完整 system 含直接对话视角（普通聊天）',
    sysOrd.includes('你在和用户直接说话，不是在写旁白') && sysOrd.includes('视角一致就好'));
  check('C36b 不要求每句都带第二人称（亲近轮）',
    sysClose.includes('不必每句都带「你」，视角一致就好'));
  check('C36c 明确动作是补充、不是每句必备',
    sysOrd.includes('动作和神态是补充') && sysOrd.includes('不是每句都要配一份'));
  check('C36d 统一规范在每条请求里恰好一次',
    sysOrd.split(ACT_TAG).length - 1 === 1 && sysClose.split(ACT_TAG).length - 1 === 1);
  check('C37 写明已交代状态不必每轮重述',
    actPrompt.includes('已经交代过的状态不用每轮重说'));
  check('C38 写明同一动作/句式不要连着几轮反复',
    actPrompt.includes('同一个动作或句式也别连着几轮反复'));
  check('C39 动作只在有助表达时才用',
    actPrompt.includes('让这句话更有温度时才用'));
  check('C40 保留情绪与主观表达（人设里的慵懒仍在）',
    actPrompt.includes('脾气、主见和想做的事')
    && actPrompt.includes('不必为了显得温柔把自己压平')
    && sysOrd.includes('慵懒'));
  check('C46 情绪先落在话里',
    actPrompt.includes('语气、用词、停顿、反问、逗弄本身就带着情绪'));
  check('C47 主动亲密动作保留、示范句一律第二人称',
    actPrompt.includes('牵你、把你往身边带')
    && !actPrompt.includes('牵她') && !actPrompt.includes('最多') && !actPrompt.includes('比例'));
  check('C41 getSystemPrompt 本体不含表达规范（日记/珍藏判定不受影响）', !base.includes(ACT_TAG));

  // ---------- 8. 动作主语：可省则省，视角只保留一处 ----------
  check('C42 动描可省主语，以「需要」为界',
    actPrompt.includes('能省主语就省') && actPrompt.includes('需要时再补人称'));
  check('C43 台词里的「我」「你」不受省主语影响', actPrompt.includes('台词里的「我」「你」照常说'));
  check('C44 亲近提示词不再重复视角规则（已收口到统一规范）', !closePrompt.includes('第三人称'));
  check('C45 亲近轮请求里视角规则只出现一次',
    sysClose.split('用「你」指用户').length - 1 === 1);

  // ---------- 9. 干净性 ----------
  check('C31 全程无外部网络请求', external.length === 0, external.slice(0, 3).join(' | '));
  check('C32 页面无运行时异常', errors.length === 0, errors.slice(0, 2).join(' | '));
  check('C33 每次发送都真的走了一次模型请求', totalMain >= 9, `主回复请求 ${totalMain} 次`);
} finally {
  try { browser.kill(); } catch {}
  await new Promise((r) => server.close(r));
}

console.log(`\n总计 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
