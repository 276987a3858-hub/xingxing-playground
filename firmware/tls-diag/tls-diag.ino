/*
  星星游乐场 · BJD 触摸硬件 HTTPS 独立对照测试（只读诊断，不刷现有固件）
  ------------------------------------------------------------------------
  目的：把 DNS / TCP / TLS / 证书 / HTTP 五个阶段拆开，分别测试 Google 与
        现有 Cloudflare Worker，定位触摸上报失败到底卡在哪一层。

  边界：
  - 不修改、不调用现有 bjd-touch.ino 的任何触摸/签名/重试逻辑
  - 不 POST 触摸事件，不调用 /api/tts，不消耗语音额度
  - 不创建任何云资源、不部署、不读取真实 secrets.h
  - 全部使用内置 CA bundle 做正常证书校验，不使用 setInsecure()
  - 不打印 Wi-Fi 密码、设备签名或任何密钥

  用法：把同目录 secrets.example.h 复制为 secrets.h，填入测试热点的 SSID/密码。
*/

#include <Arduino.h>
#include <WiFi.h>
#include <Network.h>
#include <NetworkClientSecure.h>
#include "mbedtls/x509.h"
#include "secrets.h"

// ==================== 统一配置 ====================
#define NET_TIMEOUT_MS   8000        // DNS 之外的 TCP/TLS 统一超时
#define HTTP_TIMEOUT_MS  5000        // 等待状态行
#define WIFI_WAIT_MS     20000

static const char* WORKER_HOST = "YOUR-TTS-PROXY.workers.dev";
static const char* GOOGLE_HOST = "www.google.com";

// 固定 IP 对照：只改 TCP 目标，SNI 与证书校验目标仍是 WORKER_HOST。
// 下面是公共 DNS 的地址，仅作示例；请替换成你自己解析到的 Cloudflare IP。
static const char* FIXED_IPS[] = { "1.1.1.1", "1.0.0.1" };
// ==================================================

void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID_SECRET, WIFI_PASS_SECRET);
  Serial.print("[wifi] 连接中");
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < WIFI_WAIT_MS) {
    delay(200);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() != WL_CONNECTED) {
    Serial.printf("[wifi] 连接失败 status=%d，测试终止\n", (int)WiFi.status());
    return;
  }
  Serial.printf("[wifi] IPv4=%s RSSI=%d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
}

void probeDns(const char* phase, const char* host) {
  IPAddress ip;
  int r = Network.hostByName(host, ip);
  if (r > 0) {
    Serial.printf("[dns] %s %s -> %s\n", phase, host, ip.toString().c_str());
  } else {
    Serial.printf("[dns] %s %s -> FAIL rc=%d\n", phase, host, r);
  }
}

// 阶段 D：系统 DNS → 指定 DNS 的对照记录
void dnsSurvey() {
  Serial.printf("[dns] 系统(DHCP) 主=%s 备=%s\n", WiFi.dnsIP(0).toString().c_str(), WiFi.dnsIP(1).toString().c_str());
  probeDns("系统DNS", WORKER_HOST);
  probeDns("系统DNS", GOOGLE_HOST);

  WiFi.setDNS(IPAddress(1, 1, 1, 1), IPAddress(8, 8, 8, 8));
  Serial.printf("[dns] 已设 1.1.1.1/8.8.8.8 回读 主=%s 备=%s\n", WiFi.dnsIP(0).toString().c_str(), WiFi.dnsIP(1).toString().c_str());
  probeDns("指定DNS", WORKER_HOST);
  probeDns("指定DNS", GOOGLE_HOST);

  Serial.println("[note] 以上只能证明 lwip 的 DNS 配置与解析返回值，不能证明 DNS 请求实际发往哪个服务器（无抓包）。");
}

/*
  单个目标的五阶段测试。
  fixedIp == NULL : 走系统 DNS 解析 host
  fixedIp != NULL : 仅 TCP 目标换成该 IP；SNI 与证书校验目标仍是 host
*/
void testTarget(const char* label, const char* host, const char* path, const char* fixedIp) {
  IPAddress ip;

  if (fixedIp) {
    if (!ip.fromString(fixedIp)) {
      Serial.printf("[%s] DNS=BAD-IP(%s) TCP=- TLS=- CERT=- HTTP=-\n", label, fixedIp);
      return;
    }
  } else {
    if (Network.hostByName(host, ip) <= 0) {
      Serial.printf("[%s] DNS=FAIL TCP=- TLS=- CERT=- HTTP=-\n", label);
      return;
    }
  }
  String ipStr = ip.toString();

  // ---- TCP ----
  WiFiClient plain;
  plain.setTimeout(NET_TIMEOUT_MS);
  bool tcpOk = plain.connect(ip, 443);
  plain.stop();
  if (!tcpOk) {
    Serial.printf("[%s] DNS=OK(%s) TCP=FAIL TLS=- CERT=- HTTP=-\n", label, ipStr.c_str());
    return;
  }

  // ---- TLS + 证书（内置 CA bundle，正常校验）----
  NetworkClientSecure client;
  client.useBuiltinCACertBundle();
  client.setTimeout(NET_TIMEOUT_MS);
  client.setHandshakeTimeout(NET_TIMEOUT_MS / 1000);
  // 关键：第 3 个参数传域名，mbedTLS 用它做 SNI 和证书域名校验；第 1 个参数只决定 TCP 连到哪
  bool tlsOk = client.connect(ip, 443, host, NULL, NULL, NULL);
  if (!tlsOk) {
    char err[128] = {0};
    int rc = client.lastError(err, sizeof(err));
    bool certFail = (rc == MBEDTLS_ERR_X509_CERT_VERIFY_FAILED);
    Serial.printf("[%s] DNS=OK(%s) TCP=OK TLS=FAIL CERT=%s ERROR=%d %s\n", label, ipStr.c_str(), certFail ? "FAIL" : "?", rc, err);
    client.stop();
    return;
  }

  // ---- HTTP（GET，无副作用；/api/touch 不带读令牌只会得到 401）----
  String req = String("GET ") + path + " HTTP/1.1\r\n"
    + "Host: " + host + "\r\n"
    + "User-Agent: bjd-tls-diag/1.0\r\n"
    + "Accept: */*\r\n"
    + "Connection: close\r\n\r\n";
  client.print(req);

  String line;
  uint32_t t0 = millis();
  while (millis() - t0 < HTTP_TIMEOUT_MS) {
    if (client.available()) { line = client.readStringUntil('\n'); break; }
    if (!client.connected()) break;
    delay(10);
  }
  client.stop();

  int code = 0;
  int sp = line.indexOf(' ');
  if (sp > 0) code = line.substring(sp + 1, sp + 4).toInt();
  Serial.printf("[%s] DNS=OK(%s) TCP=OK TLS=OK CERT=OK HTTP=%d\n", label, ipStr.c_str(), code);
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("=== BJD HTTPS 独立对照测试开始 ===");

  connectWiFi();
  if (WiFi.status() != WL_CONNECTED) return;

  dnsSurvey();
  Serial.println("--- A. Google HTTPS 对照 ---");
  testTarget("Google", GOOGLE_HOST, "/", NULL);

  Serial.println("--- B. Cloudflare Worker（域名解析）---");
  testTarget("Worker /", WORKER_HOST, "/", NULL);
  testTarget("Worker /api/touch", WORKER_HOST, "/api/touch", NULL);

  Serial.println("--- C. 固定 Cloudflare IP（SNI/证书仍用原域名）---");
  for (size_t i = 0; i < sizeof(FIXED_IPS) / sizeof(FIXED_IPS[0]); i++) {
    char label[64];
    snprintf(label, sizeof(label), "CF-IP %s", FIXED_IPS[i]);
    testTarget(label, WORKER_HOST, "/api/touch", FIXED_IPS[i]);
  }

  Serial.println("=== 测试结束；可断电重启重复 ===");
}

void loop() {
  delay(1000);
}
