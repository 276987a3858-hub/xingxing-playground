/*
  星星游乐场 · BJD 触摸节点（阶段 4：单个位点最小闭环）
  ------------------------------------------------------------
  一个实体触摸位点 → Wi-Fi → Worker /api/touch → 网页 TouchBridge → 小星

  本文件只做三件事：读触摸、算时间、发签名请求。
  边界：
  - 不改网页、不改 Worker 的 /api/tts
  - 一次连续触摸只在【手离开】时发一包（带真实持续时长），按住不放不会连发
  - 发送失败用同一 seq + 同一 nonce 重试，服务端会按 nonce/seq 判重
  - 设备密钥来自 secrets.h（不进仓库、不进网页）

  如果你已经有测试通过的触摸检测代码：
  保留你的检测逻辑，只在按下时调用 sendTouchEvent(i, 0, "start")、离开时调用
  sendTouchEvent(i, durMs, "end")，其余部分不用动。
*/

#include <WiFi.h>
#include <WiFiUdp.h>
#include <Network.h>
#include <Preferences.h>
#include <time.h>
#include "mbedtls/md.h"

#include "secrets.h"

// ==================== 触摸位点配置 ====================
// 五个独立位点：D0~D4 = GPIO1~GPIO5 = TOUCH1~TOUCH5（XIAO ESP32-S3，Core 3.3.12 均已确认可用）
// D5(GPIO6) 保留备用，不启用。
#define TOUCH_CH_COUNT       5          // 启用的触摸通道数
#define USE_AUTO_BASELINE    1          // 1=开机自动测基线；0=用下面两个固定阈值
#define PRESS_THRESHOLD      26000      // USE_AUTO_BASELINE=0 时生效
#define RELEASE_THRESHOLD    22000      // USE_AUTO_BASELINE=0 时生效
#define SAMPLE_MS            20         // 采样周期
#define PRESS_SAMPLES        3          // 连续 3 次过阈值才算按下（去抖）
#define RELEASE_SAMPLES      10         // 连续 10 次回落才算松开（200ms）
#define ZONE_COOLDOWN_MS     1200       // 同一位点两次触发的最小间隔（每路独立）
#define MAX_HOLD_MS          8000       // 超过这个时长按 8 秒记，避免长时间压着
// ---------- 基线采样稳定判定 ----------
// 关键：校准必须用与 loop 相同的"五路轮询"采样方式。旧版对单路密集采样，
// 读数系统性低于 loop 轮询值，导致静置 ratio 偏高、误判为按下。
#define CAL_STABLE_WIN_MS     400        // 稳定判定窗口长度（一个"静置观测窗口"）
#define CAL_STABLE_WIN_N      3          // 连续 N 个窗口都满足漂移限制才判定稳定
#define CAL_STABLE_DRIFT      0.01f      // 窗内 (max-min)/均值 上限：1% 视为静置
#define CAL_STABLE_MEAN_DRIFT 0.008f     // 相邻窗口均值相对漂移上限：0.8%
// 新增：仅靠"相邻窗口漂移"会让读数每窗爬升 <0.8% 却累计大幅上升仍被判稳定。
// 累计漂移限制以"稳定序列起点"为基准，累计超过该比例即判定本序列无效、重新起点。
// 1.2% 依据：head 静置实测上升约 2.5%，必然被拦截；正常静置噪声远小于此，不会误伤。
#define CAL_STABLE_CUM_DRIFT  0.012f     // 稳定序列起点->当前窗口均值累计漂移上限：1.2%
// 窗口内部趋势：用后半窗口均值相对前半窗口均值的变化检测"窗内单向爬升"，
// 比首末单点更抗噪声（首末样本仍记录到日志供诊断）。0.5% 对静置噪声留有余量。
#define CAL_STABLE_WIN_SLOPE  0.005f     // 窗内后半均值相对前半均值漂移上限：0.5%
#define CAL_STABLE_TIMEOUT_MS 20000UL    // 单路最长等待稳定的时间，超时判该路失败
#define CAL_WARMUP_SAMPLES    50         // 预热丢弃样本数（改为五路轮询方式丢弃瞬态）
// ====================================================

// 位点表：引脚 / 上报 zone / 本路按下偏移 / 本路释放偏移。
// PRESS/RELEASE_OFFSET 每路独立，联调时可单独调整某一路，不影响其它路。
// hand/waist 保持原值；abs/head/back 依据实测静息值与参考触发线单独换算（见各路注释）。
// 注意：zone "abs" 目前不在 Worker 的 TOUCH_ZONE_KEYS 白名单中，腹肌上报会被判为未知区域（需在线上补白名单）。
struct TouchSite {
  uint8_t pin;
  const char* zone;
  float pressOffset;
  float releaseOffset;
};
static const TouchSite TOUCH_SITES[TOUCH_CH_COUNT] = {
  { 1, "hand",  0.127f, 0.02f },   // D0 / GPIO1 / TOUCH1  右手
  { 2, "abs",   0.1064f, 0.02f },  // D1 / GPIO2 / TOUCH2  腹肌：静息47000 → 触发≈52001 / 释放≈47940
  { 3, "head",  0.0135f, 0.006f }, // D2 / GPIO3 / TOUCH3  头部：静息52000 → 触发≈52702 / 释放≈52312（释放偏移须小于按下偏移）
  { 4, "back",  0.0313f, 0.02f },  // D3 / GPIO4 / TOUCH4  背部：静息48000 → 触发≈49502 / 释放≈48960
  { 5, "waist", 0.127f, 0.02f }    // D4 / GPIO5 / TOUCH5  腰部
};

static const char* DEVICE_ID = "bjd-01";
static const char* API_PATH = "/api/touch";

// ---------- 上报目标：电脑本地转发器（局域网明文 HTTP） ----------
// ESP32 不再直连 Cloudflare HTTPS，改发到同一局域网内的电脑转发器，
// 由电脑（走 VPN）转发到现有 Worker。签名仍由设备本地生成，body/签名头不变。
//
// 地址不写死：开机及转发器失联时向局域网 UDP 广播发发现包，
// 转发器回包里带它【当前】的局域网 IP + 端口，设备据此连接。
// 只有广播发现失败时才回退到下面的默认值（IP 变了也无需重烧固件）。
static const char* RELAY_FALLBACK_HOST = "192.168.4.1";  // 占位：换成你自己的中继地址，仅发现失败时兜底
static const uint16_t RELAY_FALLBACK_PORT = 8123;
#define RELAY_DISCOVERY_PORT 8124        // 转发器 UDP 发现监听端口
#define DISCOVERY_MAGIC      "BJDR-DISC-V1"
#define DISCOVERY_REPLY_TAG  "BJDR-HERE|"
#define DISCOVERY_TIMEOUT_MS 1500        // 单次发现最长等待（毫秒）

Preferences prefs;
uint32_t seqCounter = 0;

// 每个通道独立保存基线、按下状态、释放状态、采样计数、触摸开始时间与冷却时间
struct TouchChannelState {
  uint32_t baseline;       // 本通道开机校准基线
  bool touching;           // 本通道当前是否处于按下态
  bool suppressed;         // 本次触摸落在冷却期内：开始/结束都不上报
  uint32_t pressAt;        // 本通道按下确认时刻（时间补偿用）
  uint8_t pressHits;       // 本通道连续按下计数
  uint8_t releaseHits;     // 本通道连续释放计数
  uint32_t cooldownUntil;  // 本通道冷却截止时刻
};
static TouchChannelState ch[TOUCH_CH_COUNT];
// 基线校准完成前不启用触摸事件判断（校准在 Wi-Fi 连接并稳定后进行）
static bool touchReady = false;

// 转发器动态地址：发现成功才填充；失败则回退到 RELAY_FALLBACK_*
char relayHost[16] = "";
uint16_t relayPort = RELAY_FALLBACK_PORT;
bool relayDiscovered = false;

// ---------- 触摸检测 ----------
uint32_t readTouch(uint8_t pin) {
  return (uint32_t)touchRead(pin);
}

// 每路独立的稳定判定状态：五路并行推进，某一路波动只影响它自己，不拖住其它路。
struct CalProbe {
  uint32_t winSum;        // 当前窗口内样本和
  uint32_t winMin;        // 当前窗口最小值
  uint32_t winMax;        // 当前窗口最大值
  int      winCount;      // 当前窗口已采样本数
  uint32_t prevMean;      // 上一窗口均值（0 = 还没有）
  uint32_t seqStartMean;  // 当前稳定序列起点的窗口均值（累计漂移基准；0 = 尚未建立）
  uint8_t  stableWins;    // 连续满足稳定条件的窗口数
  bool     stable;        // 是否已判定稳定（可以采集正式基线）
  bool     failed;        // 是否超时失败（不使用错误基线）
};
static CalProbe calProbe[TOUCH_CH_COUNT];

// 稳态样本取中位数：插入排序后取中间两数平均，对偶发尖峰鲁棒（沿用原有机制）。
static uint32_t medianOf(uint32_t* s, int n) {
  for (int i = 1; i < n; i++) {
    uint32_t key = s[i];
    int j = i - 1;
    while (j >= 0 && s[j] > key) { s[j + 1] = s[j]; j--; }
    s[j + 1] = key;
  }
  return (uint32_t)(((uint64_t)s[n / 2 - 1] + s[n / 2]) / 2);
}

// 五路统一稳定判定 + 校准：
//  - 每路用与 loop 相同的"轮询节奏"采样（每轮读本路一次），不再单路密集采样；
//  - 每路独立判断：窗口内极差足够小 + 相邻窗口均值漂移足够小，连续 N 窗才算稳定；
//  - 稳定后才用该路的稳态样本中位数作为正式基线；未稳定绝不写基线；
//  - 单路超时则明确报失败并置 baseline=0（该路不参与检测），不拖住其它路。
bool calibrateBaselines() {
  const int winSamples = CAL_STABLE_WIN_MS / SAMPLE_MS;   // 每窗口样本数 = 400/20 = 20
  uint32_t winBuf[TOUCH_CH_COUNT][CAL_STABLE_WIN_MS / SAMPLE_MS];
  uint32_t roundStart[TOUCH_CH_COUNT];
  const uint32_t startAll = millis();

  for (uint8_t i = 0; i < TOUCH_CH_COUNT; i++) {
    calProbe[i].winSum = 0;
    calProbe[i].winMin = 0xFFFFFFFFu;
    calProbe[i].winMax = 0;
    calProbe[i].winCount = 0;
    calProbe[i].prevMean = 0;
    calProbe[i].seqStartMean = 0;
    calProbe[i].stableWins = 0;
    calProbe[i].stable = false;
    calProbe[i].failed = false;
    roundStart[i] = startAll;
    ch[i].baseline = 0;
  }

  // 0) 先整体预热：丢弃上电/Wi-Fi 后的瞬态读数（与 loop 一致的轮询节奏）。
  for (int r = 0; r < CAL_WARMUP_SAMPLES; r++) {
    for (uint8_t i = 0; i < TOUCH_CH_COUNT; i++) readTouch(TOUCH_SITES[i].pin);
    delay(SAMPLE_MS);
  }
  Serial.printf("[touch] 预热完成（%d 样本轮询），开始逐路稳定判定...\n", CAL_WARMUP_SAMPLES);

  int resolved = 0;
  while (resolved < TOUCH_CH_COUNT) {
    // 轮询：每一轮只对本轮仍未判定的路采一个样本，五路交错进行。
    for (uint8_t i = 0; i < TOUCH_CH_COUNT; i++) {
      if (calProbe[i].stable || calProbe[i].failed) continue;
      uint32_t v = readTouch(TOUCH_SITES[i].pin);
      winBuf[i][calProbe[i].winCount] = v;
      calProbe[i].winSum += v;
      if (v < calProbe[i].winMin) calProbe[i].winMin = v;
      if (v > calProbe[i].winMax) calProbe[i].winMax = v;
      calProbe[i].winCount++;
    }
    delay(SAMPLE_MS);

    // 每采满一个窗口，各路独立判定一次。
    for (uint8_t i = 0; i < TOUCH_CH_COUNT; i++) {
      if (calProbe[i].stable || calProbe[i].failed) continue;
      if (calProbe[i].winCount < winSamples) continue;

      uint32_t mean = calProbe[i].winSum / (uint32_t)calProbe[i].winCount;
      uint32_t span = calProbe[i].winMax - calProbe[i].winMin;
      uint32_t winMinSnapshot = calProbe[i].winMin;
      uint32_t winMaxSnapshot = calProbe[i].winMax;
      uint32_t firstSample = winBuf[i][0];
      uint32_t lastSample  = winBuf[i][winSamples - 1];

      // (1) 窗内极差（既有）：(max-min)/mean <= 1%
      bool quiet = (mean > 0) && ((float)span <= (float)mean * CAL_STABLE_DRIFT);

      // (2) 相邻窗口漂移（既有）：|mean-prevMean|/prevMean <= 0.8%
      int32_t adjSigned = calProbe[i].prevMean > 0
                          ? (int32_t)mean - (int32_t)calProbe[i].prevMean : 0;
      int32_t adjAbs = adjSigned < 0 ? -adjSigned : adjSigned;
      bool steady = (calProbe[i].prevMean > 0) &&
                    ((uint32_t)adjAbs <= (uint32_t)((float)calProbe[i].prevMean * CAL_STABLE_MEAN_DRIFT));

      // (3) 新增：窗口内部趋势，用后半窗口均值减前半窗口均值，拦截"窗内单向爬升"。
      //     比首末单点更抗噪声，首末样本仍记录到日志供诊断。
      uint32_t half = (uint32_t)winSamples / 2;              // 20 -> 10
      uint32_t secondCount = (uint32_t)winSamples - half;    // 20 -> 10
      uint32_t sumFirst = 0, sumSecond = 0;
      for (int h = 0; h < winSamples; h++) {
        if (h < (int)half) sumFirst += winBuf[i][h];
        else               sumSecond += winBuf[i][h];
      }
      uint32_t meanFirst  = sumFirst / half;
      uint32_t meanSecond = sumSecond / secondCount;
      int32_t slopeSigned = (int32_t)meanSecond - (int32_t)meanFirst;
      int32_t slopeAbs = slopeSigned < 0 ? -slopeSigned : slopeSigned;
      bool winFlat = (mean > 0) && ((uint32_t)slopeAbs <= (uint32_t)((float)mean * CAL_STABLE_WIN_SLOPE));

      // (4) 新增：相对"稳定序列起点"的累计漂移，拦截每窗只漂 <0.8% 但累计很大的情形。
      //     seqStartMean==0 表示本窗口将成为新序列起点，此时累计条件视为满足。
      uint32_t refMean = calProbe[i].seqStartMean;
      int32_t cumSigned = refMean > 0 ? (int32_t)mean - (int32_t)refMean : 0;
      int32_t cumAbs = cumSigned < 0 ? -cumSigned : cumSigned;
      bool cumOK = (refMean == 0) ||
                   ((uint32_t)cumAbs <= (uint32_t)((float)refMean * CAL_STABLE_CUM_DRIFT));

      bool windowOK = quiet && steady && winFlat && cumOK;

      // 诊断日志：每路每窗口一行；只读已采样本，不额外 touchRead、不改变采样节奏。
      float adjPct = (calProbe[i].prevMean > 0)
                     ? (float)adjSigned * 100.0f / (float)calProbe[i].prevMean : 0.0f;
      float cumPct = (refMean > 0)
                     ? (float)cumSigned * 100.0f / (float)refMean : 0.0f;
      Serial.printf("[cal] %s t=%lu mean=%u min=%u max=%u span=%u first=%u last=%u "
                    "adj=%+.2f%% cum=%+.2f%% slope=%+d quiet=%d steady=%d flat=%d cumOK=%d wins=%d\n",
                    TOUCH_SITES[i].zone, (unsigned long)millis(),
                    (unsigned)mean, (unsigned)winMinSnapshot, (unsigned)winMaxSnapshot,
                    (unsigned)span, (unsigned)firstSample, (unsigned)lastSample,
                    adjPct, cumPct, (int)slopeSigned,
                    quiet ? 1 : 0, steady ? 1 : 0, winFlat ? 1 : 0, cumOK ? 1 : 0,
                    (int)calProbe[i].stableWins);

      // 更新稳定序列：满足则计数并在序列首窗锁定起点；否则整段作废，下一窗口重新建起点。
      if (windowOK) {
        if (calProbe[i].stableWins == 0) {
          calProbe[i].seqStartMean = mean;   // 新稳定序列从本窗口开始
        }
        calProbe[i].stableWins++;
      } else {
        calProbe[i].stableWins = 0;
        calProbe[i].seqStartMean = 0;        // 序列作废，避免旧起点掩盖后续累计漂移
      }
      calProbe[i].prevMean = mean;

      // 开新窗口
      calProbe[i].winSum = 0;
      calProbe[i].winMin = 0xFFFFFFFFu;
      calProbe[i].winMax = 0;
      calProbe[i].winCount = 0;

      if (calProbe[i].stableWins >= CAL_STABLE_WIN_N) {
        // 稳定确认：用本窗口稳态样本的中位数作为正式基线（复用原有中位数机制）
        uint32_t base = medianOf(winBuf[i], winSamples);
        if (base == 0) {
          calProbe[i].failed = true;
          resolved++;
          Serial.printf("[touch] %s 错误：GPIO%d 没有触摸通道（稳定后读数仍为 0），该路不参与检测\n",
                        TOUCH_SITES[i].zone, TOUCH_SITES[i].pin);
        } else {
          ch[i].baseline = base;
          calProbe[i].stable = true;
          resolved++;
          Serial.printf("[touch] %s 校准完成 基线=%u min=%u max=%u 中位=%u (稳定%d窗口/轮询采样 "
                        "起点=%u 累计=%+.2f%% 原因=四条件全满足)\n",
                        TOUCH_SITES[i].zone, (unsigned)base,
                        (unsigned)winMinSnapshot, (unsigned)winMaxSnapshot,
                        (unsigned)base, calProbe[i].stableWins,
                        (unsigned)calProbe[i].seqStartMean, cumPct);
        }
      } else if (millis() - roundStart[i] >= CAL_STABLE_TIMEOUT_MS) {
        calProbe[i].failed = true;
        resolved++;
        Serial.printf("[touch] %s 错误：等待 %lu ms 读数仍未稳定（末窗口均值=%u "
                      "末窗 quiet=%d steady=%d flat=%d cumOK=%d，原因=无法连续%d窗同时满足四条件），"
                      "该路不参与检测\n",
                      TOUCH_SITES[i].zone, (unsigned long)(millis() - roundStart[i]), (unsigned)mean,
                      quiet ? 1 : 0, steady ? 1 : 0, winFlat ? 1 : 0, cumOK ? 1 : 0,
                      CAL_STABLE_WIN_N);
      }
    }
  }
  return true;
}

bool isPressed(uint8_t idx, uint32_t v) {
#if USE_AUTO_BASELINE
  return v > ch[idx].baseline * (1.0f + TOUCH_SITES[idx].pressOffset);
#else
  (void)idx;
  return v > PRESS_THRESHOLD;
#endif
}

bool isReleased(uint8_t idx, uint32_t v) {
#if USE_AUTO_BASELINE
  return v < ch[idx].baseline * (1.0f + TOUCH_SITES[idx].releaseOffset);
#else
  (void)idx;
  return v < RELEASE_THRESHOLD;
#endif
}

// ---------- DNS ----------
// 热点下发的 DNS 常常解析不了 workers.dev，统一改成 1.1.1.1 / 8.8.8.8。
// 两个触发点：
//   1) 每次 DHCP 拿到地址（首次连接、断线重连）→ GOT_IP 事件置脏位
//   2) 每 DNS_RECHECK_MS 低频回读一次，兜住 DHCP 续租把 DNS 写回热点的情况
// 回读值已经是目标值时不重复写。
#define DNS_RECHECK_MS 30000UL
static const IPAddress DNS_PRIMARY(1, 1, 1, 1);
static const IPAddress DNS_SECONDARY(8, 8, 8, 8);
volatile bool dnsDirty = true;
uint32_t dnsCheckedAt = 0;

bool applyDns(const char* reason) {
  bool ok = WiFi.setDNS(DNS_PRIMARY, DNS_SECONDARY);
  Serial.printf("[dns] %s：setDNS=%s 主 %s / 备 %s\n", reason, ok ? "成功" : "失败", WiFi.dnsIP(0).toString().c_str(),
                WiFi.dnsIP(1).toString().c_str());
  return ok;
}

// 回调跑在 arduino_events 任务里：只置标志，不在这里做网络操作
void onWiFiGotIp(arduino_event_id_t event) {
  (void)event;
  dnsDirty = true;
}

// 主循环里调用：dirty 或到校验周期才动手，且只在回读值不对时才真正写
void serviceDns() {
  uint32_t now = millis();
  if (!dnsDirty && now - dnsCheckedAt < DNS_RECHECK_MS) return;
  if (WiFi.status() != WL_CONNECTED) return;  // 没连上先不动，dnsDirty 留到连上之后再处理

  dnsCheckedAt = now;
  bool fromEvent = dnsDirty;
  dnsDirty = false;
  if (WiFi.dnsIP(0) == DNS_PRIMARY && WiFi.dnsIP(1) == DNS_SECONDARY) return;  // 已是目标值，不重复写
  applyDns(fromEvent ? "重连后" : "定期校验");
}

// ---------- 网络 ----------
void connectWiFi() {
  WiFi.mode(WIFI_STA);
  // 注意：这一行在 Core 3.3.12 里并不能关闭 IPv6。
  // NetworkInterface::enableIPv6(false) 只执行 clearStatusBits(ESP_NETIF_WANT_IP6_BIT)，
  // 该位在库里没有任何消费方；hostByName 的 AAAA 优先看的是 hasGlobalIPv6()（BIT4），
  // lwip 的 SLAAC/DHCPv6 也照常运行（CONFIG_LWIP_IPV6_AUTOCONFIG=y）。
  // 保留它只是为了不改变既有行为，不要把它当成"关掉 IPv6"的修复。
  WiFi.enableIPv6(false);
  // 首次连接和每次断线重连拿到 DHCP 地址都会触发 GOT_IP，统一交给 serviceDns() 处理
  WiFi.onEvent(onWiFiGotIp, ARDUINO_EVENT_WIFI_STA_GOT_IP);
  WiFi.begin(WIFI_SSID_SECRET, WIFI_PASS_SECRET);
  Serial.print("[wifi] 连接中");
  for (int i = 0; i < 100 && WiFi.status() != WL_CONNECTED; i++) { delay(200); Serial.print("."); }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[wifi] 已连接 %s  信号 %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
    Serial.printf("[net] IPv4 = %s\n", WiFi.localIP().toString().c_str());
    Serial.printf("[net] IPv6 全局地址 = %s（未做 IPv6 干预，此行仅用于观测）\n", WiFi.globalIPv6().toString().c_str());

    // 必须在 syncTime() 之前：对时也要解析域名
    applyDns("首次连接");
    dnsDirty = false;
    dnsCheckedAt = millis();
  } else {
    Serial.println("[wifi] 连接失败，触摸仍会检测，但不会上报");
  }
}

// ---------- 转发器动态发现（UDP 广播，无云/无依赖/无常驻服务） ----------
// 请求：向局域网广播一个固定魔数；转发器回 "BJDR-HERE|<ip>|<port>"。
// 只在开机和转发器失联时调用；正常触摸直接用已缓存地址，零额外开销。
bool discoverRelay() {
  if (WiFi.status() != WL_CONNECTED) return false;

  WiFiUDP udp;
  if (!udp.begin(0)) {                 // 0 = 系统分配临时端口，避免多设备冲突
    Serial.println("[disc] UDP 启动失败");
    return false;
  }

  const char* magic = DISCOVERY_MAGIC;
  size_t magicLen = strlen(magic);
  // 定向广播优先；受限广播兜底（部分热点只转发其中一种）
  udp.beginPacket(WiFi.broadcastIP(), RELAY_DISCOVERY_PORT);
  udp.write((const uint8_t*)magic, magicLen);
  udp.endPacket();
  udp.beginPacket(IPAddress(255, 255, 255, 255), RELAY_DISCOVERY_PORT);
  udp.write((const uint8_t*)magic, magicLen);
  udp.endPacket();

  uint32_t deadline = millis() + DISCOVERY_TIMEOUT_MS;
  char buf[128];
  bool ok = false;
  while (millis() < deadline) {
    int n = udp.parsePacket();
    if (n > 0) {
      int len = udp.read(buf, sizeof(buf) - 1);
      if (len > 0) {
        buf[len] = '\0';
        char ip[16] = "";
        int port = 0;
        if (sscanf(buf, DISCOVERY_REPLY_TAG "%15[^|]|%d", ip, &port) == 2
            && port > 0 && port < 65536) {
          strncpy(relayHost, ip, sizeof(relayHost) - 1);
          relayHost[sizeof(relayHost) - 1] = '\0';
          relayPort = (uint16_t)port;
          ok = true;
          break;
        }
      }
    }
    delay(5);
  }
  udp.stop();

  if (ok) {
    relayDiscovered = true;
    Serial.printf("[disc] 发现转发器 %s:%u\n", relayHost, relayPort);
  } else {
    relayDiscovered = false;
    Serial.printf("[disc] 未发现转发器，回退 %s:%u（检查 UDP %d 入站防火墙 / 热点设备互通）\n",
                  RELAY_FALLBACK_HOST, RELAY_FALLBACK_PORT, RELAY_DISCOVERY_PORT);
  }
  return ok;
}

void syncTime() {
  configTime(0, 0, "pool.ntp.org", "time.cloudflare.com");
  Serial.print("[ntp] 对时");
  time_t now = 0;
  for (int i = 0; i < 75; i++) {
    now = time(nullptr);
    if (now > 1700000000) break;
    delay(200);
    Serial.print(".");
  }
  Serial.println();
  Serial.printf("[ntp] 当前 = %ld\n", (long)now);
}

String toHex(const uint8_t* data, size_t len) {
  static const char* h = "0123456789abcdef";
  String s;
  s.reserve(len * 2);
  for (size_t i = 0; i < len; i++) { s += h[data[i] >> 4]; s += h[data[i] & 0x0F]; }
  return s;
}

String sha256Hex(const String& text) {
  uint8_t out[32];
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  mbedtls_md(info, (const unsigned char*)text.c_str(), text.length(), out);
  return toHex(out, 32);
}

String hmacHex(const String& message) {
  uint8_t out[32];
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  mbedtls_md_setup(&ctx, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 1);
  mbedtls_md_hmac_starts(&ctx, (const unsigned char*)DEVICE_SECRET, strlen(DEVICE_SECRET));
  mbedtls_md_hmac_update(&ctx, (const unsigned char*)message.c_str(), message.length());
  mbedtls_md_hmac_finish(&ctx, out);
  mbedtls_md_free(&ctx);
  return toHex(out, 32);
}

String makeNonce() {
  char buf[24];
  snprintf(buf, sizeof(buf), "%08x%08x", (unsigned)esp_random(), (unsigned)millis());
  return String(buf);
}

// 服务端在 409 里回报的当前序号（仅 reason:"seq" 时有效）
int32_t serverSeqHint = -1;

// 返回值：
//   0 = 服务端已确认收到（202/200，或 409 且 reason:"nonce" —— 这一包其实已经入库）
//   1 = 可重试（网络/服务端临时错误）
//   2 = 序号冲突（409 且 reason:"seq"），需换号重发
//   3 = 409 但原因无法识别，停止重发（宁可不发，也不制造第二条事件）
int postEvent(const String& body, uint32_t seq, const String& nonce, uint32_t budgetMs) {
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.reconnect();                 // 掉线自己接回来，别让一次断网废掉后面所有触摸
    for (int i = 0; i < 20 && WiFi.status() != WL_CONNECTED; i++) delay(100);
    if (WiFi.status() != WL_CONNECTED) {
      Serial.printf("[post] Wi-Fi 未连接（status=%d），本次放弃\n", (int)WiFi.status());
      return 1;
    }
  }
  time_t nowS = time(nullptr);
  if (nowS < 1700000000) { syncTime(); nowS = time(nullptr); if (nowS < 1700000000) {
    Serial.printf("[post] NTP 未同步（now=%ld），本次放弃\n", (long)nowS);
    return 1;
  } }

  String ts = String((long)nowS);
  String sig = hmacHex(String(DEVICE_ID) + "\n" + ts + "\n" + nonce + "\n" + sha256Hex(body));
  // ↑ 签名完全不变：仍由 ESP32 本地生成，覆盖 DEVICE_ID/ts/nonce/body 摘要。

  // 局域网明文 HTTP 连电脑转发器；不再做 DNS/TLS，也不再直连 Cloudflare。
  // 地址优先用 UDP 发现结果；未发现才广播；连不上则清除缓存，下次重发/触摸重新发现。
  if (!relayDiscovered) discoverRelay();
  const char* targetHost = relayDiscovered ? relayHost : RELAY_FALLBACK_HOST;
  uint16_t targetPort = relayDiscovered ? relayPort : RELAY_FALLBACK_PORT;

  WiFiClient client;
  client.setTimeout(8000);       // 单位是毫秒，即 8 秒
  if (!client.connect(targetHost, targetPort)) {
    Serial.printf("[post] 连接转发器失败 %s:%u\n", targetHost, targetPort);
    relayDiscovered = false;     // 电脑 IP 可能变了：让下一次尝试重新发现
    return 1;
  }

  // 方法、路径、body、四个签名头与原来完全一致；仅 Host 改为当前转发器地址。
  String hostHeader = String(targetHost) + ":" + String(targetPort);
  String req = String("POST ") + API_PATH + " HTTP/1.1\r\n"
    + "Host: " + hostHeader + "\r\n"
    + "Content-Type: application/json\r\n"
    + "X-Dev: " + DEVICE_ID + "\r\n"
    + "X-Ts: " + ts + "\r\n"
    + "X-Nonce: " + nonce + "\r\n"
    + "X-Sig: " + sig + "\r\n"
    + "Content-Length: " + String(body.length()) + "\r\n"
    + "Connection: close\r\n\r\n" + body;
  client.print(req);

  // 先读状态行，再读响应体：409 的两种含义只能靠 body 区分，不能只看状态码
  String resp = client.readStringUntil('\n');
  uint32_t deadline = millis() + budgetMs;
  while (millis() < deadline && resp.length() < 512) {
    if (client.available()) resp += (char)client.read();
    else if (!client.connected()) break;
    else delay(5);
  }
  client.stop();

  int code = 0;
  int sp = resp.indexOf(' ');
  if (sp > 0) code = resp.substring(sp + 1, sp + 4).toInt();

  Serial.printf("[post] seq=%u -> %s\n", seq, resp.substring(0, 96).c_str());
  if (code == 202 || code == 200) return 0;

  if (code == 409) {
    // 这一包已经被服务端接收（重试撞上同一 nonce）：视为成功，绝不另建事件
    if (resp.indexOf("\"reason\":\"nonce\"") >= 0) return 0;
    // 序号落后：记下服务端当前序号，交给上层按协议换号重发
    if (resp.indexOf("\"reason\":\"seq\"") >= 0) {
      int k = resp.indexOf("\"seq\":");
      if (k >= 0) serverSeqHint = (int32_t)resp.substring(k + 6).toInt();
      return 2;
    }
    return 3;   // 认不出来的 409：不猜、不重发
  }
  // 明确的客户端错误（400/401/413 等）：同一个包重发也不会变成功，直接停
  if (code >= 400 && code < 500 && code != 408 && code != 429) return 3;
  return 1;
}

void persistSeq() {
  prefs.putUInt("seq", seqCounter);
}

// 一次触摸按阶段分两包上报：
//   start = 刚接触就发（durMs=0），让网页立刻显示「正在摸」；
//   end   = 手离开时发，带本次真实持续时长，网页据此生成完整记录并交给 AI。
// seq 仍为全局单调序列（与 NVS 持久化、服务端去重保持一致），zone 取本通道实际部位。
// 冷却判定不在这里做：冷却属于「整次触摸是否成立」，在按下时判定（见 loop）。
void sendTouchEvent(uint8_t idx, uint32_t durMs, const char* phase) {
  const char* zone = TOUCH_SITES[idx].zone;
  const bool isStart = (phase != NULL && phase[0] == 's');
  if (isStart) durMs = 0;                            // 开始包不带时长
  if (durMs > MAX_HOLD_MS) durMs = MAX_HOLD_MS;      // 结束包上限 8 秒

  seqCounter += 1;
  persistSeq();

  String body = String("{\"v\":1,\"seq\":") + seqCounter
    + ",\"zone\":\"" + zone + "\""
    + ",\"durMs\":" + String(durMs)
    + ",\"phase\":\"" + (isStart ? "start" : "end") + "\"}";
  String nonce = makeNonce();

  // 开始包用短等待 + 少次数：它发生在按下瞬间，不能把采样循环拖住太久；
  // 结束包沿用原来的三次重试与 2.5 秒等待，保证时长数据尽量不丢。
  const int maxAttempts = isStart ? 2 : 3;
  const uint32_t waitMs = isStart ? 1000UL : 2500UL;

  serverSeqHint = -1;
  for (int attempt = 0; attempt < maxAttempts; attempt++) {
    int r = postEvent(body, seqCounter, nonce, waitMs);
    if (r == 0) return;          // 成功，或服务端已确认这一包收到过（nonce 重复）
    if (r == 3) {
      Serial.printf("[post] %s %s 409 原因无法识别，本次不再重发（避免重复事件）\n", zone, phase);
      return;
    }
    if (r == 2) {
      // 只有明确 reason:"seq" 才换号：优先用服务端回报的序号 +1
      if (serverSeqHint >= (int32_t)seqCounter) seqCounter = (uint32_t)serverSeqHint;
      seqCounter += 1;
      persistSeq();
      body = String("{\"v\":1,\"seq\":") + seqCounter
        + ",\"zone\":\"" + zone + "\""
        + ",\"durMs\":" + String(durMs)
        + ",\"phase\":\"" + (isStart ? "start" : "end") + "\"}";
      nonce = makeNonce();
      continue;
    }
    delay(isStart ? 80 : 300);
  }
  Serial.printf("[post] %s %s 上报未成功（不影响本路后续触摸）\n", zone, phase);
}

// ---------- 主循环 ----------
void setup() {
  Serial.begin(115200);
  Serial.setDebugOutput(true);   // 让 Core 的 log_e/log_i 走 USB CDC，而不是 UART0 引脚
  delay(200);
  prefs.begin("touch-node", false);
  seqCounter = prefs.getUInt("seq", 0);
  Serial.printf("[boot] 起始 seq = %u\n", seqCounter);

  // 1) 先连 Wi-Fi 并让无线环境稳定：Wi-Fi 启动后触摸读数整体抬升，
  //    必须以此为静置状态采集基线，否则旧基线偏低、静置也会被判为按下。
  connectWiFi();
  if (WiFi.status() == WL_CONNECTED) {
    discoverRelay();   // 开机先发现一次，避免第一次触摸才等广播
    syncTime();
  }
  // 2) Wi-Fi 就绪后不再用固定延时，改为逐路稳定判定：读数进入稳定区间才采集基线。
  //    校准阶段 touchReady=false，loop 中的触摸状态机不会运行，确保无触摸输入干扰采样。
  Serial.println("[touch] Wi-Fi 就绪，等待无线环境稳定后开始基线校准...");
  for (uint8_t i = 0; i < TOUCH_CH_COUNT; i++) {
    ch[i].touching = false;
    ch[i].suppressed = false;
    ch[i].pressHits = 0;
    ch[i].releaseHits = 0;
    ch[i].cooldownUntil = 0;
  }
  calibrateBaselines();

  // 汇总：明确列出已锁定基线的通道与失败通道（失败路 baseline=0，不参与检测）
  for (uint8_t i = 0; i < TOUCH_CH_COUNT; i++) {
    if (calProbe[i].failed) {
      Serial.printf("[touch] 汇总：%s 校准失败，不参与检测\n", TOUCH_SITES[i].zone);
    }
  }
  touchReady = true;   // 采样完成后才启用正常触摸事件判断
  Serial.println("[touch] 基线校准完成，已启用触摸检测");
}

void loop() {
  serviceDns();                  // 轻量：未置脏且未到校验周期时只是一次比较

  if (!touchReady) return;       // 基线校准完成前不采样、不判断触摸

  static uint32_t lastSample = 0;
  if (millis() - lastSample < SAMPLE_MS) { delay(1); return; }
  lastSample = millis();

  // 五路同时采样：把本轮读数先存下来，供状态机与调试输出共用同一组值
  uint32_t v[TOUCH_CH_COUNT];
  for (uint8_t i = 0; i < TOUCH_CH_COUNT; i++) {
    v[i] = readTouch(TOUCH_SITES[i].pin);
  }

  // 调试输出：每 500ms 打印一次各路原始值/基线/比值/状态，只观测不改判定。
  static uint32_t lastDbg = 0;
  if (millis() - lastDbg >= 500) {
    lastDbg = millis();
    for (uint8_t i = 0; i < TOUCH_CH_COUNT; i++) {
      uint32_t b = ch[i].baseline;
      Serial.printf("[raw] %s v=%u base=%u ratio=%.3f touching=%d\n",
                    TOUCH_SITES[i].zone, (unsigned)v[i], (unsigned)b,
                    b ? (float)v[i] / (float)b : 0.0f, ch[i].touching ? 1 : 0);
    }
  }

  // 每路独立状态机：按下/释放/计数/时间补偿/上报互不覆盖。
  for (uint8_t i = 0; i < TOUCH_CH_COUNT; i++) {
    const char* zone = TOUCH_SITES[i].zone;

    if (!ch[i].touching) {
      if (isPressed(i, v[i])) {
        if (++ch[i].pressHits >= PRESS_SAMPLES) {
          ch[i].touching = true;
          ch[i].pressAt = millis();
          ch[i].releaseHits = 0;
          // 冷却判定放在「整次触摸成立」这一刻：冷却期内按下，本次触摸从一开始就被丢弃，
          // 连 start 包也不发，避免网页出现一条没有下文的「正在摸」。
          if (millis() < ch[i].cooldownUntil) {
            ch[i].suppressed = true;
            Serial.printf("[touch] %s 冷却中，本次整次忽略\n", zone);
          } else {
            ch[i].suppressed = false;
            Serial.printf("[touch] %s 按下 v=%u（上报开始）\n", zone, (unsigned)v[i]);
            sendTouchEvent(i, 0, "start");     // 立刻上报：网页先显示触摸状态，不等 AI
          }
        }
      } else {
        ch[i].pressHits = 0;
      }
      continue;
    }

    if (isReleased(i, v[i])) {
      if (++ch[i].releaseHits >= RELEASE_SAMPLES) {
        // 按下/松开都是「连续 N 次采样」才确认，两段确认延迟要扣掉，否则时长会虚高
        // 时间补偿算法与单通道版本完全一致，仅改为取本通道的 pressAt。
        int32_t lead = (int32_t)(PRESS_SAMPLES - 1) * (int32_t)SAMPLE_MS;     // 按下确认前已过多久
        int32_t lag = (int32_t)(RELEASE_SAMPLES - 1) * (int32_t)SAMPLE_MS;    // 松开确认滞后多久
        int32_t dur = (int32_t)(millis() - ch[i].pressAt) + lead - lag;
        if (dur < 0) dur = 0;
        ch[i].touching = false;
        ch[i].releaseHits = 0;
        ch[i].pressHits = 0;
        if (ch[i].suppressed) {
          ch[i].suppressed = false;
          Serial.printf("[touch] %s 冷却中，结束也不上报\n", zone);
        } else {
          // 冷却与原逻辑一致：从「松开」这一刻起算 1200ms
          ch[i].cooldownUntil = millis() + ZONE_COOLDOWN_MS;
          // 结束包必须带 >=1ms 的时长：网页据此区分 start(0) 与 end(>0)
          uint32_t ud = (dur < 1) ? 1u : (uint32_t)dur;
          Serial.printf("[touch] %s 松开 dur=%ums（上报结束）\n", zone, (unsigned)ud);
          sendTouchEvent(i, ud, "end");        // 带完整时长交给网页，网页再决定是否请 AI 回应
        }
      }
    } else {
      ch[i].releaseHits = 0;
    }
  }
}
