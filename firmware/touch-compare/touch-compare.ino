/*
  临时对照诊断 sketch —— T1(GPIO1) vs T2(GPIO2) 两路触摸读数
  ------------------------------------------------------------
  目的：区分「GPIO1 单通道异常 / 触摸电极连接问题 / 触摸驱动整体异常」。

  边界（严格遵守本次要求）：
  - 独立文件，不修改正式固件 bjd-touch.ino。
  - 只调用 touchRead(1) 与 touchRead(2)，每 300ms 输出两路原始读数。
  - 保留必要初始化：touchRead 首次调用会自动初始化对应通道；预热若干次
    让 ng 驱动完成 benchmark 扫描 / enable / start，并以稳定状态开始输出。
  - 不接 Wi-Fi / UDP / HTTP / Worker / HMAC / AI / TTS，不需要任何密钥。
  - 不改滤波器参数、不加动态基线、不加阈值判断、不触发任何上报逻辑。
  - 只用 Arduino ESP32 Core 3.3.12 自带 API，FQBN = esp32:esp32:XIAO_ESP32S3。

  读数说明：Core 3.3.12 的 touchRead() 返回 TOUCH_CHAN_DATA_TYPE_SMOOTH
  （硬件平滑值，uint32_t），类型与正式固件完全一致，可直接横向对比。

  安全测试法（见交付说明）：
  A) 原铜箔/导线不动，接在 D0(GPIO1) 上观察 t1、t2；
  B) 断电后把同一套导线+铜箔从 D0 移到 D1(GPIO2) 再观察；
  用金属物隔绝缘层触碰（或直接捏导线金属端），不直接摸裸露引脚。
*/

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n[touch-compare] boot, XIAO ESP32-S3 / Core 3.3.12");
  Serial.println("[touch-compare] t1=touchRead(GPIO1=D0/T1)  t2=touchRead(GPIO2=D1/T2)");

  // 预热：首次 touchRead(pin) 会触发该通道自动初始化
  // （__touchInit -> __touchChannelInit -> benchmark 扫描 -> enable/start）。
  // 两路都读若干次，使 3 次 oneshot benchmark 与 IIR 平滑进入稳定状态，
  // 避免开头几帧的暂态值干扰观察。不改变任何驱动参数。
  for (int i = 0; i < 20; i++) {
    touchRead(1);
    touchRead(2);
    delay(25);
  }
  Serial.println("[touch-compare] warmed up. start reading every 300ms:");
  Serial.println("[t1,t2]");
}

void loop() {
  uint32_t t1 = touchRead(1);
  uint32_t t2 = touchRead(2);
  Serial.printf("[raw] t1=%u t2=%u\n", (unsigned int)t1, (unsigned int)t2);
  delay(300);
}
