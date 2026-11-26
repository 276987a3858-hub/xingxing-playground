/* tests/butler/puzzle-browser.mjs
 * 星光拼图第一版：真实页面 + 真实 localStorage，AI/网络全 stub。
 * 图片上传用 Canvas 生成 JPG/PNG/WebP 的 File，验证格式校验、裁切、确认与同源切片。
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9357, BASE = process.argv[2] || 'http://127.0.0.1:8787';
const profile = `${process.env.TEMP || 'C:\\Windows\\Temp'}\\pz-edge-${Date.now()}`;
const browser = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });

const checks = [];
const check = (n, ok, d = '') => { checks.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };

// 源码层：确认其他 Agent 结算逻辑逐行保留
{
  const src = readFileSync(new URL('../../public/playground/puzzle.js', import.meta.url), 'utf8');
  const keep = ['END_LINES', 'gameEnd.pickLine(pool)', 'solvedBefore', 'token: `puzzle:${this.serial}`',
    '用了 ${this.moves} 步拼完', "gameName: '星光拼图'", "store.finish('puzzle'"];
  const missing = keep.filter(k => src.indexOf(k) === -1);
  check('P00 既有结算/步数/活动逻辑逐行保留', missing.length === 0, missing.join(','));
  const staleUnlock = src.indexOf("store.unlock('date')") !== -1 || src.indexOf('已解锁新场景') !== -1;
  check('P00b 旧式解锁调用与解锁文案已移除', staleUnlock === false);
}

let ws;
try {
  let info = null;
  for (let i = 0; i < 40 && !info; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) info = await r.json(); } catch {}
    if (!info) await sleep(250);
  }
  if (!info) throw new Error('DevTools 未就绪');
  ws = await new Promise((res, rej) => { const s = new WebSocket(info.webSocketDebuggerUrl); s.onopen = () => res(s); s.onerror = () => rej(new Error('WS')); });
  const pending = new Map(); let id = 0, sid = null;
  const external = [], errors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); return; }
    if (m.method === 'Network.requestWillBeSent' && m.sessionId === sid) {
      const u = m.params.request.url;
      if (!u.startsWith('http://127.0.0.1') && u.indexOf('cdnjs.cloudflare.com') === -1 && u.indexOf('data:') !== 0) external.push(u);
    }
    if (m.method === 'Runtime.exceptionThrown' && m.sessionId === sid) errors.push(String(m.params.exceptionDetails?.exception?.description || ''));
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    id += 1; pending.set(id, { resolve, reject });
    const p = { id, method, params }; if (sid && !method.startsWith('Target.')) p.sessionId = sid;
    ws.send(JSON.stringify(p)); setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('超时 ' + method)); } }, 15000);
  });
  const ev = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  sid = (await call('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  await call('Page.enable'); await call('Runtime.enable'); await call('Network.enable');
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    window.__net = [];
    window.fetch = (u) => { window.__net.push(String(u)); return Promise.resolve(new Response('{"choices":[{"message":{"content":""}}]}',{headers:{'content-type':'application/json'}})); };
  })();` });

  await call('Page.navigate', { url: BASE + '/playground/' });
  for (let i = 0; i < 40; i++) {
    const ready = await ev(`document.readyState === 'complete' && !!document.body`).catch(() => false);
    if (ready) break;
    await sleep(200);
  }
  await sleep(600);

  // 初始化：清数据、拿到模块引用、mount 到自建容器、等图片就绪、关掉开场预览
  const init = await ev(`(async function(){
    localStorage.removeItem('ylxh.playground.v1');
    localStorage.removeItem('ylxh.puzzle.custom.v1');
    const pz = await import('/playground/puzzle.js');
    const pi = await import('/playground/puzzle-image.js');
    const ge = await import('/playground/game-end.js');
    window.__pz = pz.PuzzleScene; window.__pi = pi.puzzleImage; window.__ge = ge.gameEnd;
    let host = document.getElementById('__pz_host');
    if (!host) { host = document.createElement('div'); host.id='__pz_host'; document.body.appendChild(host); }
    window.__pz.mount(host);
    for (let i=0;i<40 && !window.__pz.imageReady;i++) await new Promise(r=>setTimeout(r,50));
    const previewAtBoot = !!window.__pz.previewEl;
    window.__pz.closePreview();
    return { n: window.__pz.n, len: window.__pz.tiles.length, ready: window.__pz.imageReady, previewAtBoot,
             src: String(window.__pz.imageSrc).slice(0, 40) };
  })()`);
  check('P01 默认 3×3（8 块 + 1 空格）且图片就绪', init.n === 3 && init.len === 9 && init.ready === true, JSON.stringify(init));
  check('P02 开始前显示完整原图预览', init.previewAtBoot === true);

  // 真实渲染诊断：检查 DOM computed style（此前仅验证 JS 返回字符串，属假阳性）
  const computed = await ev(`(function(){
    const tiles = [...document.querySelectorAll('#__pz_host .puzzle-tile')].filter(b=>!b.disabled);
    const t = tiles[0];
    if (!t) return { count:0 };
    const cs = getComputedStyle(t);
    const rect = t.getBoundingClientRect();
    return { count: tiles.length, bgImage: cs.backgroundImage, bgSize: cs.backgroundSize,
             bgPos: cs.backgroundPosition, w: Math.round(rect.width), h: Math.round(rect.height),
             outer: t.outerHTML.slice(0, 200) };
  })()`);
  check('P02b 内置图真实渲染：computed background-image 生效且地址非空',
    computed.bgImage && computed.bgImage.indexOf('url') !== -1 &&
    !/url\(["']?["']\)/.test(computed.bgImage) &&
    computed.bgSize && computed.bgSize.indexOf('%') !== -1,
    JSON.stringify(computed));
  check('P02c 拼图块有实际渲染尺寸', computed.w > 20 && computed.h > 20, JSON.stringify({ w: computed.w, h: computed.h }));

  // 不同块必须显示不同切片位置（不能所有格子同一块内容）
  const slices = await ev(`(function(){
    const tiles = [...document.querySelectorAll('#__pz_host .puzzle-tile')].filter(b=>!b.disabled);
    return tiles.map(t => getComputedStyle(t).backgroundPosition);
  })()`);
  check('P02d 不同拼图块切片位置不同', new Set(slices).size > 1, JSON.stringify(slices.slice(0, 9)));

  // 打乱是有效排列 + 有解（15-puzzle 奇偶判据）
  const solvable = await ev(`(function(){
    function check(tiles,n){
      const arr = tiles.filter(x=>x!==0);
      const okPerm = arr.length===n*n-1 && arr.every((v,i)=>v>=1&&v<=n*n-1) && new Set(arr).size===n*n-1;
      let inv=0; for(let i=0;i<arr.length;i++)for(let j=i+1;j<arr.length;j++)if(arr[i]>arr[j])inv++;
      const emptyRowFromBottom = n - Math.floor(tiles.indexOf(0)/n);
      const ok = (n%2===1) ? (inv%2===0) : ((inv+emptyRowFromBottom)%2===1);
      return okPerm && ok;
    }
    const out = {};
    for (const n of [3,4,5]) { window.__pz.setDifficulty(n); out[n]=check(window.__pz.tiles.slice(),n); }
    return out;
  })()`);
  check('P03 三档打乱均为有效排列且保证有解', solvable['3'] && solvable['4'] && solvable['5'], JSON.stringify(solvable));

  // 难度切换保留当前图片
  const diffKeep = await ev(`(function(){
    window.__pz.setDifficulty(4); const s4=window.__pz.imageSrc, l4=window.__pz.tiles.length;
    window.__pz.setDifficulty(5); const s5=window.__pz.imageSrc, l5=window.__pz.tiles.length;
    window.__pz.setDifficulty(3);
    return { s4, s5, same:s4===s5, l4, l5 };
  })()`);
  check('P04 切换难度保留当前图片、只重排棋盘', diffKeep.same && diffKeep.l4 === 16 && diffKeep.l5 === 25, JSON.stringify({ same: diffKeep.same, l4: diffKeep.l4, l5: diffKeep.l5 }));

  // 相邻/非相邻移动
  const mv = await ev(`(function(){
    const p=window.__pz; p.setDifficulty(3); p.solved=[1,2,3,4,5,6,7,8,0]; p.tiles=p.solved.slice();
    const before=p.tiles.slice(), m0=p.moves;
    p.move(0); const afterFar=p.tiles.slice();         // 0 与空格(8)非相邻 → 无效
    p.move(7); const afterNear=p.tiles.slice();         // 7 与空格(8)相邻 → 有效
    return { farSame: JSON.stringify(before)===JSON.stringify(afterFar),
             nearChanged: JSON.stringify(afterFar)!==JSON.stringify(afterNear),
             movesAdd: p.moves-m0 };
  })()`);
  check('P05 相邻移动有效、非相邻移动无效', mv.farSame && mv.nearChanged && mv.movesAdd === 1, JSON.stringify(mv));

  // 完成判定 + 结算兼容（hook gameEnd.show）
  const done = await ev(`(function(){
    const p=window.__pz;
    p.solved=[1,2,3,4,5,6,7,8,0]; p.tiles=[1,2,3,4,5,6,7,0,8]; // 差一步
    p.completed=false; p.endPublished=false; p.serial=99; p.moves=12; p.solvedBefore=false;
    window.__shown=null; window.__unlockEvents=[];
    const onUnlock=(e)=>{ window.__unlockEvents.push(e.detail && e.detail.id); };
    window.addEventListener('store:unlock', onUnlock);
    const orig=window.__ge.show; window.__ge.show=(o)=>{window.__shown=o;return true;};
    p.move(8);
    window.__ge.show=orig;
    window.removeEventListener('store:unlock', onUnlock);
    const st=JSON.parse(localStorage.getItem('ylxh.playground.v1')||'{}');
    return { completed:p.completed, shown:window.__shown,
             finished:!!(st.finished&&st.finished.puzzle&&st.finished.puzzle.completed),
             grid:st.finished&&st.finished.puzzle&&st.finished.puzzle.grid,
             unlocked:(st.unlocked||[]).includes('date'), unlockEvents:window.__unlockEvents,
             endPublished:p.endPublished };
  })()`);
  check('P06 完成判定准确并锁定棋盘', done.completed === true && done.endPublished === true);
  check('P07 结算 gameName/token/result 与短句逻辑保留',
    done.shown && done.shown.game === 'puzzle' && done.shown.gameName === '星光拼图' &&
    String(done.shown.token).indexOf('puzzle:') === 0 && String(done.shown.result).includes('步') && !!done.shown.line,
    JSON.stringify(done.shown || {}));
  check('P08 结算写入 finished(grid) 且不再解锁 date',
    done.finished && done.grid === 3 && done.unlocked === false && done.unlockEvents.length === 0, JSON.stringify(done));

  // 结果页不再显示旧式解锁提示
  const resultTxt = await ev(`(function(){ window.__pz.renderResult(); return document.getElementById('__pz_host').innerText; })()`);
  check('P09 结果页无解锁提示、无「星夜21点」旧文案',
    !resultTxt.includes('已解锁新场景') && !resultTxt.includes('星夜21点') && !resultTxt.includes('月下约会'),
    resultTxt.replace(/\s+/g, ' ').slice(0, 160));

  // 切片 CSS：三档 background-size 正确、同源图片
  const css = await ev(`(function(){
    const out={};
    for (const n of [3,4,5]) { const p=window.__pz; p.n=n; out[n]=p.tileStyle(1); }
    return out;
  })()`);
  check('P10 图片切片按难度正确定位且同源',
    css['3'].includes('background-size:300% 300%') && css['4'].includes('background-size:400% 400%') &&
    css['5'].includes('background-size:500% 500%') && css['3'].includes('background-image:url('),
    JSON.stringify({ s3: css['3'].slice(0, 60) }));

  // 预览开合不改状态
  const pv = await ev(`(function(){
    const p=window.__pz; p.setDifficulty(3); p.moves=7;
    const before=JSON.stringify(p.tiles)+'|'+p.moves+'|'+p.completed+'|'+p.n;
    p.showPreview(false); const opened=!!p.previewEl; p.closePreview();
    const after=JSON.stringify(p.tiles)+'|'+p.moves+'|'+p.completed+'|'+p.n;
    return { opened, closed:!p.previewEl, same:before===after };
  })()`);
  check('P11 查看原图开合不改变棋盘/步数/难度', pv.opened && pv.closed && pv.same, JSON.stringify(pv));

  // 上传：JPG/PNG/WebP 格式校验 + 正方形裁切 + 确认应用（Canvas 造 File）
  const upload = await ev(`(async function(){
    const p=window.__pz, pi=window.__pi;
    async function makeFile(type,w,h){
      const c=document.createElement('canvas'); c.width=w; c.height=h;
      const x=c.getContext('2d'); x.fillStyle='#7a5'; x.fillRect(0,0,w,h);
      const blob=await new Promise(r=>c.toBlob(r,type,0.9));
      return new File([blob], 't.'+(type.split('/')[1]), {type});
    }
    async function run(type){
      const f=await makeFile(type, 200, 120);           // 非正方形 → 应居中裁成正方形
      let confirmed=null, err=null;
      pi.handleFile(f, d=>{confirmed=d;}, m=>{err=m;});
      for(let i=0;i<60 && !document.querySelector('[data-puzzle-overlay="crop"]');i++) await new Promise(r=>setTimeout(r,30));
      const btn=document.querySelector('[data-puzzle-overlay="crop"] [data-act="confirm"]');
      if(btn) btn.click();
      for(let i=0;i<60 && confirmed===null;i++) await new Promise(r=>setTimeout(r,30));
      let square=false;
      if(confirmed){ const img=new Image(); img.src=confirmed; await img.decode().catch(()=>{});
        square = img.width===img.height && img.width>0; }
      return { type, ok:!!confirmed && square, err };
    }
    const out={};
    for(const t of ['image/jpeg','image/png','image/webp']) out[t]=await run(t);
    // 错误格式
    let badErr=null; pi.handleFile(new File(['x'],'a.txt',{type:'text/plain'}),()=>{},m=>{badErr=m;});
    out.bad = { rejected: !!badErr };
    return out;
  })()`);
  check('P12 JPG/PNG/WebP 上传后裁切为正方形',
    upload['image/jpeg'].ok && upload['image/png'].ok && upload['image/webp'].ok, JSON.stringify(upload).slice(0, 220));
  check('P13 非图片格式被拒绝', upload.bad.rejected === true);

  // 裁切取消不改变当前图片
  const cancelRes = await ev(`(async function(){
    const p=window.__pz, pi=window.__pi;
    const before=p.imageSrc;
    const c=document.createElement('canvas'); c.width=c.height=100; c.getContext('2d').fillRect(0,0,100,100);
    const blob=await new Promise(r=>c.toBlob(r,'image/png'));
    pi.handleFile(new File([blob],'x.png',{type:'image/png'}),()=>{},()=>{});
    for(let i=0;i<60 && !document.querySelector('[data-puzzle-overlay="crop"]');i++) await new Promise(r=>setTimeout(r,30));
    const cancel=document.querySelector('[data-puzzle-overlay="crop"] [data-act="cancel"]');
    if(cancel) cancel.click();
    return before===p.imageSrc;
  })()`);
  check('P14 取消裁切不改变当前图片', cancelRes === true);

  // 上传确认后应用 + 同源预览
  const applied = await ev(`(async function(){
    const p=window.__pz, pi=window.__pi;
    const c=document.createElement('canvas'); c.width=300; c.height=300;
    const x=c.getContext('2d'); x.fillStyle='#48f'; x.fillRect(0,0,300,300);
    const blob=await new Promise(r=>c.toBlob(r,'image/png'));
    let url=null;
    pi.handleFile(new File([blob],'y.png',{type:'image/png'}), d=>{url=d;}, ()=>{});
    for(let i=0;i<60 && !document.querySelector('[data-puzzle-overlay="crop"]');i++) await new Promise(r=>setTimeout(r,30));
    const btn=document.querySelector('[data-puzzle-overlay="crop"] [data-act="confirm"]');
    if(btn) btn.click();
    for(let i=0;i<60 && url===null;i++) await new Promise(r=>setTimeout(r,30));
    pi.saveRecent(url);
    // 模拟业务侧应用（startUpload 的 onConfirm 逻辑）
    p.imageSrc=url; p.shuffle(); p.render(); p.showPreview(true);
    const previewImg=document.querySelector('[data-puzzle-overlay="preview"] img');
    const same = previewImg && previewImg.getAttribute('src')===p.imageSrc;
    const tileEl = document.querySelector('#__pz_host .puzzle-tile:not([disabled])');
    const domBg = tileEl ? getComputedStyle(tileEl).backgroundImage : '';
    p.closePreview();
    return { same, domHasData: domBg.indexOf('data:image/') !== -1,
             domEmpty: /url\(["']?["']\)/.test(domBg), srcPrefix:String(p.imageSrc).slice(0,15) };
  })()`);
  check('P15 上传确认后 DOM 真实显示 dataURL 且与预览同源',
    applied.same && applied.domHasData && !applied.domEmpty, JSON.stringify(applied));

  // 保存失败降级为本次会话
  const degrade = await ev(`(function(){
    const pi=window.__pi;
    const setItem=Storage.prototype.setItem;
    Storage.prototype.setItem=function(){ throw new Error('quota'); };
    const ok=pi.saveRecent('data:image/jpeg;base64,AAAA');
    Storage.prototype.setItem=setItem;
    return { ok, mem: String(pi.getRecent()).slice(0,15) };
  })()`);
  check('P16 图片保存失败降级为本次会话使用', degrade.ok === false && degrade.mem.startsWith('data:image/'), JSON.stringify(degrade));

  // 刷新后仍可读回最近一张（跳过被上面 stub 覆盖的那次）
  await ev(`(function(){ window.__pi.saveRecent(window.__pz.imageSrc); return 1; })()`);
  await call('Page.reload'); await sleep(1600);
  const persisted = await ev(`(async function(){ const pi=(await import('/playground/puzzle-image.js')).puzzleImage;
    const r=pi.getRecent(); return { has: !!r, prefix: String(r||'').slice(0,15) }; })()`);
  check('P17 刷新后可恢复最近一张自定义图', persisted.has && persisted.prefix.startsWith('data:image/'), JSON.stringify(persisted));

  // 活动记录：完成拼图经统一结算产生 game:'puzzle' 事件
  const activity = await ev(`(async function(){
    localStorage.removeItem('ylxh.game.activity.v1');
    window.dispatchEvent(new CustomEvent('scene:change',{detail:{scene:'puzzle'}}));
    window.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
    window.GameActivityCollector._bump(60000);
    const ge=await import('/playground/game-end.js');
    ge.gameEnd.show({game:'puzzle',gameName:'星光拼图',token:'puzzle:verify',line:'拼好了。',result:'用了 30 步拼完',english:''});
    return window.GameActivity.list().filter(x=>x.game==='puzzle');
  })()`);
  check('P18 完成经统一结算产生 puzzle 活动记录', Array.isArray(activity) && activity.length >= 1, JSON.stringify(activity).slice(0, 160));

  check('P19 零外部请求', external.length === 0, external.slice(0, 2).join(','));
  check('P20 零页面异常', errors.length === 0, errors.slice(0, 1).join('').slice(0, 140));
} catch (e) {
  console.error('测试脚本异常：', e);
  check('脚本执行', false, String(e).slice(0, 180));
} finally {
  const passed = checks.filter(Boolean).length;
  console.log(`\n结果 ${passed}/${checks.length}`);
  try { ws && ws.close(); } catch {}
  browser.kill();
  process.exit(passed === checks.length ? 0 : 1);
}
