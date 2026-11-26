// 复制此文件为 secrets.h 后填入真实值；secrets.h 已在 .gitignore 中，不会进仓库。
#pragma once

// 必须用 2.4GHz 频段（ESP32-S3 不支持 5GHz）
#define WIFI_SSID_SECRET   "你的 2.4G Wi-Fi 名称"
#define WIFI_PASS_SECRET   "你的 Wi-Fi 密码"

// 独立语音 Worker 的域名，不要带 https:// 和路径
#define TOUCH_HOST_SECRET  "YOUR-TTS-PROXY.workers.dev"

// 与 Worker 的 TOUCH_DEVICE_SECRET 完全一致；这个值只存在于设备与 Worker
#define DEVICE_SECRET      "把你的设备密钥填在这里"
