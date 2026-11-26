const fs = require('fs');
const path = require('path');

// 素材目录：与 app.js 读取的路径保持一致，按需替换成你自己的图片目录
const STICKERS_DIR = path.join(__dirname, 'public', '小星表情包');
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

if (!fs.existsSync(STICKERS_DIR)) {
  console.error(`❌ 找不到文件夹：${STICKERS_DIR}`);
  console.error('请确认 public 目录下有“小星表情包”文件夹（自定义素材目录名请改 STICKERS_DIR）。');
  process.exit(1);
}

const folders = fs.readdirSync(STICKERS_DIR).filter(file => {
  return fs.statSync(path.join(STICKERS_DIR, file)).isDirectory();
});

folders.forEach(folderName => {
  const folderPath = path.join(STICKERS_DIR, folderName);
  const files = fs.readdirSync(folderPath);
  const images = files.filter(file => IMAGE_EXTENSIONS.includes(path.extname(file).toLowerCase()));

  if (images.length > 0) {
    fs.writeFileSync(path.join(folderPath, 'manifest.json'), JSON.stringify(images, null, 2), 'utf-8');
    console.log(`✅ [${folderName}] 成功生成清单，共 ${images.length} 张图。`);
  }
});
console.log('\n🎉 清单生成完毕！可以开始改代码了。');