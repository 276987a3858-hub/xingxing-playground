/* =====================================================
   公共背景层
   负责：背景主题的注册、切换、销毁
   背景层是纯被动的视觉层，不接收鼠标事件，也不承载玩法交互
   ===================================================== */

const THEMES = new Map();
let layer = null;
let active = null;
let generation = 0;

function ensureLayer() {
  if (layer && layer.isConnected) return layer;
  layer = document.createElement('div');
  layer.id = 'playground-bg-layer';
  layer.setAttribute('aria-hidden', 'true');
  layer.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:0;pointer-events:none;overflow:hidden;';
  document.body.appendChild(layer);
  return layer;
}

function clearLayerDom() {
  if (!layer) return;
  while (layer.firstChild) layer.removeChild(layer.firstChild);
  delete layer.dataset.theme;
}

function destroyActive() {
  const current = active;
  active = null;
  if (current && current.instance && typeof current.instance.dispose === 'function') {
    try {
      current.instance.dispose();
    } catch (err) {
      console.warn('背景主题销毁失败:', err);
    }
  }
  clearLayerDom();
}

export function registerBackground(id, factory) {
  if (!id || typeof factory !== 'function') return false;
  THEMES.set(id, factory);
  return true;
}

export function hasBackground(id) {
  return THEMES.has(id);
}

/**
 * 切换背景主题。先完整销毁旧主题，再初始化新主题。
 * 传 'none' / 空值 = 无背景。
 */
export function setBackground(id) {
  const nextId = id || 'none';

  // 先推进 generation，旧主题遗留的异步回调会因此失效
  generation += 1;
  const gen = generation;
  destroyActive();

  if (nextId === 'none') return null;

  const factory = THEMES.get(nextId);
  if (!factory) {
    console.warn(`[background] 未注册的背景主题：${nextId}`);
    return null;
  }

  const root = ensureLayer();
  root.dataset.theme = nextId;

  const isCurrent = () => gen === generation;
  let instance = null;
  try {
    instance = factory({ root, isCurrent });
  } catch (err) {
    console.warn('背景主题启动失败:', err);
    return null;
  }

  // 防御：主题初始化过程中又发生了一次切换
  if (!isCurrent()) {
    if (instance && typeof instance.dispose === 'function') {
      try { instance.dispose(); } catch (err) { /* ignore */ }
    }
    return null;
  }

  active = { id: nextId, instance, generation: gen };
  return instance && instance.api ? instance.api : null;
}

export function clearBackground() {
  generation += 1;
  destroyActive();
}

export function getActiveBackgroundId() {
  return active ? active.id : null;
}

export function getBackgroundApi(id) {
  if (!active) return null;
  if (id && active.id !== id) return null;
  return active.instance && active.instance.api ? active.instance.api : null;
}

export const Background = {
  register: registerBackground,
  has: hasBackground,
  set: setBackground,
  clear: clearBackground,
  get id() { return getActiveBackgroundId(); },
  get api() { return getBackgroundApi(); }
};

/* =====================================================
   公共星空主题（由问答场景迁移）
   只负责视觉：星空、地形、花海、漂浮星星、相机与渲染循环
   抓星星的交互逻辑留在问答场景内
   ===================================================== */

export function createStarsBackground({ root }) {
  const THREE = window.THREE;
  if (!THREE) {
    console.warn('[background] THREE 未加载，星空背景无法启动');
    return { api: null, dispose() {} };
  }

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x1a1c3b, 0.015);

  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 1000);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;pointer-events:none;';
  root.appendChild(renderer.domElement);

  const textures = [];
  const extraGeometries = [];

  // 星空
  const skyCanvas = document.createElement('canvas');
  skyCanvas.width = 2048; skyCanvas.height = 1024;
  const ctx = skyCanvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 1024);
  grad.addColorStop(0, '#05081c'); grad.addColorStop(0.5, '#1f2957'); grad.addColorStop(0.8, '#4d3b7b'); grad.addColorStop(1, '#1a1c3b');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, 2048, 1024);
  for (let i = 0; i < 800; i++) {
    ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.8 + 0.2})`;
    ctx.beginPath(); ctx.arc(Math.random() * 2048, Math.random() * 1024, Math.random() * 1.5, 0, Math.PI * 2); ctx.fill();
  }
  const skyTexture = new THREE.CanvasTexture(skyCanvas);
  textures.push(skyTexture);
  scene.add(new THREE.Mesh(
    new THREE.SphereGeometry(400, 64, 64),
    new THREE.MeshBasicMaterial({ map: skyTexture, side: THREE.BackSide })
  ));

  // 光与地形
  scene.add(new THREE.AmbientLight(0x2a3b6b, 1.8));
  const dirLight = new THREE.DirectionalLight(0xaaddff, 1.5);
  dirLight.position.set(10, 20, 10); scene.add(dirLight);

  const groundGeo = new THREE.PlaneGeometry(200, 200, 32, 32);
  groundGeo.rotateX(-Math.PI / 2);
  const pos = groundGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) { pos.setY(i, Math.sin(pos.getX(i) * 0.1) * Math.cos(pos.getZ(i) * 0.1) * 1.5); }
  groundGeo.computeVertexNormals();
  scene.add(new THREE.Mesh(groundGeo, new THREE.MeshStandardMaterial({ color: 0x050814, roughness: 1 })));

  // 花海
  const flowerCanvas = document.createElement('canvas');
  flowerCanvas.width = 512; flowerCanvas.height = 512;
  const fCtx = flowerCanvas.getContext('2d');
  const cx = 256, cy = 256;
  for (let i = 0; i < 6; i++) {
    fCtx.save(); fCtx.translate(cx, cy); fCtx.rotate((i * Math.PI * 2) / 6);
    const fGrad = fCtx.createLinearGradient(0, 0, 0, -180);
    fGrad.addColorStop(0, 'rgba(255, 255, 255, 1)'); fGrad.addColorStop(0.5, 'rgba(80, 160, 255, 0.95)'); fGrad.addColorStop(1, 'rgba(30, 80, 180, 0.1)');
    fCtx.fillStyle = fGrad; fCtx.beginPath(); fCtx.moveTo(0, 0);
    fCtx.bezierCurveTo(60, -50, 50, -160, 0, -200); fCtx.bezierCurveTo(-50, -160, -60, -50, 0, 0);
    fCtx.fill(); fCtx.restore();
  }
  fCtx.fillStyle = '#ffffff'; fCtx.beginPath(); fCtx.arc(cx, cy, 16, 0, Math.PI * 2); fCtx.fill();

  const flowerTexture = new THREE.CanvasTexture(flowerCanvas);
  textures.push(flowerTexture);
  const geo1 = new THREE.PlaneGeometry(3, 3);
  const geo2 = new THREE.PlaneGeometry(3, 3); geo2.rotateY(Math.PI / 2);
  extraGeometries.push(geo1, geo2);
  const mergedGeo = THREE.BufferGeometryUtils ? THREE.BufferGeometryUtils.mergeBufferGeometries([geo1, geo2]) : geo1;

  const flowerMat = new THREE.MeshStandardMaterial({ map: flowerTexture, alphaTest: 0.3, side: THREE.DoubleSide, emissive: 0x1133aa, emissiveIntensity: 0.8 });
  const flowerMesh = new THREE.InstancedMesh(mergedGeo, flowerMat, 6000);
  const dummy = new THREE.Object3D();
  const colorObj = new THREE.Color();

  for (let i = 0; i < 6000; i++) {
    const r = Math.random() * 50, theta = Math.random() * Math.PI * 2;
    const x = Math.cos(theta) * r, z = Math.sin(theta) * r;
    dummy.position.set(x, Math.sin(x * 0.1) * Math.cos(z * 0.1) * 1.5 + Math.random() * 1.5, z);
    dummy.rotation.set((Math.random() - 0.5) * 0.4, Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.4);
    const scale = (1 - r / 50) * 0.9 + 0.4 + Math.random() * 0.2;
    dummy.scale.set(scale, scale, scale); dummy.updateMatrix();
    flowerMesh.setMatrixAt(i, dummy.matrix);
    colorObj.setHex(Math.random() > 0.8 ? 0xccaaff : 0x88ccff);
    flowerMesh.setColorAt(i, colorObj);
  }
  scene.add(flowerMesh);

  // 漂浮星星（被动视觉；抓取交互由问答场景处理）
  const stars = [];
  const starCanvas = document.createElement('canvas');
  starCanvas.width = 64; starCanvas.height = 64;
  const sCtx = starCanvas.getContext('2d');
  const sGrad = sCtx.createRadialGradient(32, 32, 0, 32, 32, 32);
  sGrad.addColorStop(0, 'rgba(255,255,255,1)');
  sGrad.addColorStop(0.3, 'rgba(200,240,255,0.8)');
  sGrad.addColorStop(1, 'rgba(0,0,0,0)');
  sCtx.fillStyle = sGrad; sCtx.fillRect(0, 0, 64, 64);
  const starTexture = new THREE.CanvasTexture(starCanvas);
  textures.push(starTexture);

  const starGeo = new THREE.PlaneGeometry(2, 2);
  const starMat = new THREE.MeshBasicMaterial({ map: starTexture, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });

  for (let i = 0; i < 15; i++) {
    const star = new THREE.Mesh(starGeo, starMat);
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * 30;
    star.position.set(Math.cos(a) * r, 8 + Math.random() * 10, Math.sin(a) * r);
    star.userData = { baseY: star.position.y, offset: Math.random() * 10, isCaught: false, speed: 1 + Math.random() };
    scene.add(star);
    stars.push(star);
  }

  // 相机控制（由场景通过 api 驱动）
  let cameraAngle = 0;
  let cameraDistance = 35;
  let cameraHeight = 6;
  let dragging = false;
  let previousX = 0;
  let previousY = 0;
  let disposed = false;
  let frameId = null;
  const frameCallbacks = new Set();

  const api = {
    scene,
    camera,
    renderer,
    stars,
    starTexture,
    beginDrag(clientX, clientY) {
      dragging = true;
      previousX = clientX;
      previousY = clientY;
    },
    moveDrag(clientX, clientY) {
      if (!dragging) return;
      const deltaX = clientX - previousX;
      const deltaY = clientY - previousY;
      cameraAngle -= deltaX * 0.005;
      cameraHeight = Math.max(1, Math.min(15, cameraHeight + deltaY * 0.05));
      previousX = clientX;
      previousY = clientY;
    },
    endDrag() {
      dragging = false;
    },
    zoom(deltaY) {
      cameraDistance += deltaY * 0.03;
      cameraDistance = Math.max(10, Math.min(60, cameraDistance));
    },
    onFrame(callback) {
      if (typeof callback !== 'function' || disposed) return () => {};
      frameCallbacks.add(callback);
      return () => frameCallbacks.delete(callback);
    }
  };

  const onResize = () => {
    if (disposed) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', onResize);

  const animate = () => {
    if (disposed) return;
    frameId = requestAnimationFrame(animate);

    if (!dragging) cameraAngle += 0.001;

    camera.position.set(Math.sin(cameraAngle) * cameraDistance, cameraHeight, Math.cos(cameraAngle) * cameraDistance);
    camera.lookAt(0, 6, 0);

    const t = performance.now() * 0.001;
    stars.forEach(star => {
      if (!star.userData.isCaught) {
        star.position.y = star.userData.baseY + Math.sin(t * star.userData.speed + star.userData.offset) * 0.8;
        star.lookAt(camera.position);
        const scale = 1 + Math.sin(t * 3 + star.userData.offset) * 0.3;
        star.scale.set(scale, scale, scale);
      }
    });

    frameCallbacks.forEach(callback => {
      try { callback(t); } catch (err) { console.warn('背景帧回调失败:', err); }
    });

    renderer.render(scene, camera);
  };
  animate();

  return {
    api,
    dispose() {
      if (disposed) return;
      disposed = true;

      if (frameId) {
        cancelAnimationFrame(frameId);
        frameId = null;
      }
      frameCallbacks.clear();
      window.removeEventListener('resize', onResize);

      scene.traverse(object => {
        if (object.geometry && object.geometry.dispose) object.geometry.dispose();
        if (object.material) {
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach(material => {
            if (material && material.dispose) material.dispose();
          });
        }
      });

      extraGeometries.forEach(geometry => {
        try { geometry.dispose(); } catch (err) { /* ignore */ }
      });
      textures.forEach(texture => {
        try { texture.dispose(); } catch (err) { /* ignore */ }
      });

      try { renderer.dispose(); } catch (err) { /* ignore */ }
      if (renderer.forceContextLoss) {
        try { renderer.forceContextLoss(); } catch (err) { /* ignore */ }
      }
      if (renderer.domElement && renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement);
      }
    }
  };
}
