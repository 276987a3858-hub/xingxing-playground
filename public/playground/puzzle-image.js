
// playground/puzzle-image.js
// 星光拼图图片模块：内置默认图、上传、格式校验、正方形裁切预览、确认应用、最近一张本地保存
// 全部在浏览器本地处理，不上传服务器；任何失败都静默降级，不影响游戏

const SAVE_KEY = 'ylxh.puzzle.custom.v1';
const MAX_SIDE = 1024;          // 裁切后最长边上限：兼顾清晰度与本地存储容量
const JPEG_QUALITY = 0.82;
const ACCEPT = ['image/jpeg', 'image/png', 'image/webp'];

// 跨刷新的最近一张：从 localStorage 读；读不到则本会话内为空
function loadRecent() {
  try {
    const v = localStorage.getItem(SAVE_KEY);
    return (typeof v === 'string' && v.indexOf('data:image/') === 0) ? v : null;
  } catch (e) { return null; }
}

let recentDataUrl = loadRecent();

function getRecent() { return recentDataUrl; }

function saveRecent(dataUrl) {
  // 本次会话一定可用（先写内存），持久化失败只影响刷新后恢复
  recentDataUrl = dataUrl;
  try {
    localStorage.setItem(SAVE_KEY, dataUrl);
    return true;
  } catch (e) {
    return false; // 配额不足 / 隐私模式：降级为仅本次会话
  }
}

function getDefault() { return '/playground/star-bg.jpg'; }

// 图片加载为 Promise（URL 或 dataURL 均可）
function load(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = src;
  });
}

// 居中裁正方形 → 降采样到 ≤MAX_SIDE → JPEG dataURL
function squareDataUrl(img) {
  try {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return null;
    const side = Math.min(w, h);
    const sx = (w - side) / 2;
    const sy = (h - side) / 2;
    const out = Math.min(side, MAX_SIDE);
    const canvas = document.createElement('canvas');
    canvas.width = out;
    canvas.height = out;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, sx, sy, side, side, 0, 0, out, out);
    return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  } catch (e) { return null; }
}

function closeOverlay(node) {
  try { if (node && node.parentNode) node.parentNode.removeChild(node); } catch (e) {}
}

// 正方形裁切预览：显示已处理好的最终图片，用户确认后才应用
function showCropConfirm(dataUrl, onConfirm) {
  const overlay = document.createElement('div');
  overlay.setAttribute('data-puzzle-overlay', 'crop');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9998;background:rgba(8,6,22,.86);' +
    'display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;';
  overlay.innerHTML = `
    <div style="max-width:420px;width:100%;background:rgba(30,25,55,.96);border:1px solid rgba(200,160,255,.35);
                border-radius:20px;padding:22px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.45);">
      <h3 style="color:#e8d5ff;letter-spacing:2px;margin:0 0 8px;">裁切预览</h3>
      <p style="color:#b8a5db;font-size:12px;line-height:1.7;margin:0 0 14px;">已居中裁成正方形，确认后用于拼图切片与预览。</p>
      <img src="${dataUrl}" alt="裁切预览" style="width:min(70vw,300px);height:min(70vw,300px);object-fit:cover;
           border-radius:14px;border:1px solid rgba(200,160,255,.4);display:block;margin:0 auto 16px;" />
      <button data-act="confirm" style="padding:10px 26px;border-radius:24px;background:rgba(200,160,255,.2);
              border:1px solid rgba(200,160,255,.5);color:#e8d5ff;cursor:pointer;margin-right:10px;">使用这张</button>
      <button data-act="cancel" style="padding:10px 26px;border-radius:24px;background:transparent;
              border:1px solid rgba(200,160,255,.25);color:#b8a5db;cursor:pointer;">取消</button>
    </div>`;
  const confirm = overlay.querySelector('[data-act="confirm"]');
  const cancel = overlay.querySelector('[data-act="cancel"]');
  confirm.addEventListener('click', () => {
    closeOverlay(overlay);
    if (typeof onConfirm === 'function') onConfirm(dataUrl);
  });
  cancel.addEventListener('click', () => closeOverlay(overlay));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeOverlay(overlay); });
  document.body.appendChild(overlay);
}

// 处理一个已选文件：校验类型 → 读 dataURL → 裁正方形 → 预览确认 → 回调最终 dataURL
function handleFile(file, onConfirm, onError) {
  const fail = (msg) => { if (typeof onError === 'function') onError(msg); };
  if (!file) { fail('没有选择图片'); return; }
  const type = String(file.type || '').toLowerCase();
  if (ACCEPT.indexOf(type) === -1) { fail('只支持 JPG、PNG、WebP 图片'); return; }
  const reader = new FileReader();
  reader.onerror = () => fail('图片读取失败');
  reader.onload = () => {
    load(String(reader.result || '')).then((img) => {
      const dataUrl = squareDataUrl(img);
      if (!dataUrl) { fail('图片处理失败'); return; }
      showCropConfirm(dataUrl, onConfirm);
    }).catch(() => fail('图片加载失败'));
  };
  reader.readAsDataURL(file);
}

// 打开文件选择器：选中的文件交给 handleFile（仅本地，不上传服务器）
function openUpload(onConfirm, onError) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/jpeg,image/png,image/webp';
  input.style.display = 'none';
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    handleFile(file, onConfirm, onError);
    try { input.value = ''; } catch (e) {}
  });
  document.body.appendChild(input);
  input.click();
  // 稍后移除，避免堆积隐藏 input
  setTimeout(() => closeOverlay(input), 60000);
}

function _reset() {
  try { localStorage.removeItem(SAVE_KEY); } catch (e) {}
  recentDataUrl = null;
}

export const puzzleImage = {
  getDefault, getRecent, saveRecent, load, squareDataUrl,
  showCropConfirm, handleFile, openUpload, _reset,
  _keys: { SAVE_KEY, MAX_SIDE, ACCEPT },
};
