
// playground/main.js
import { AdventureScene } from './adventure.js';
import { PuzzleScene } from './puzzle.js';
import { DateScene } from './date.js';
import { CollectionScene } from './collection.js';
import { KitchenScene } from './kitchen.js';
import { RadioScene } from './radio.js';
import { VocabScene } from './vocab.js';
import { Background } from './background.js';

// 注册全部场景
// 注：原「星球漫游」入口已由背单词游戏接管，沿用 planets 场景 id 保留路由/解锁/收藏联动
const SCENES = {
  planets: VocabScene,
  adventure: AdventureScene,
  puzzle: PuzzleScene,
  date: DateScene,
  collection: CollectionScene,
  kitchen: KitchenScene,
  radio: RadioScene
};

const lobbyEl = document.getElementById('lobby-scene');
const gameEl = document.getElementById('game-scene');

let activeScene = null;

// 场景切换
function handleSceneChange(sceneName) {
  // 离开上一个场景时，清理它
  if (activeScene && activeScene.unmount) {
    activeScene.unmount(gameEl);
  }
  activeScene = null;

  const isLobby = !sceneName || sceneName === 'lobby';
  const Scene = isLobby ? null : SCENES[sceneName];

  // 场景不存在时回到大厅
  if (!isLobby && !Scene) {
    Background.set('none');
    window.PlaygroundRouter.go('lobby');
    return;
  }

  // 旧场景已卸载、新场景还未挂载：此时切换公共背景
  // 未声明背景的场景默认无背景；厨房使用自己的局部背景
  Background.set(Scene && Scene.background ? Scene.background : 'none');

  // 返回大厅
  if (isLobby) {
    lobbyEl.style.display = 'block';
    gameEl.style.display = 'none';
    return;
  }

  // 进入游戏
  lobbyEl.style.display = 'none';
  gameEl.style.display = 'block';

  activeScene = Scene;
  Scene.mount(gameEl);
}

// 厨房暂时使用自己的局部背景，不叠加公共星空
KitchenScene.background = 'none';
// 午夜电台使用自己的局部氛围，不叠加公共星空
RadioScene.background = 'none';
// 背单词使用自己的浅色界面，不叠加公共星空
VocabScene.background = 'none';

// 监听路由发来的场景切换事件
window.addEventListener('scene:change', e => {
  handleSceneChange(e.detail.scene);
});

// 绑定大厅卡片点击事件
function bindCards() {
  document.querySelectorAll('.scene-card').forEach(card => {
    // 防止重复绑定点击事件
    if (card.dataset.bound === 'true') return;

    card.dataset.bound = 'true';
    card.style.cursor = 'pointer';

    card.addEventListener('click', () => {
      const sceneId = card.dataset.scene;

      window.PlaygroundRouter.go(sceneId);
    });
  });
}

// 初始化大厅
bindCards();
