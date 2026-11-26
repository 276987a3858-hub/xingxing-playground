# 07 · 部署与运行说明

> 先说结论：**本仓库不能克隆即用**。它包含文档、配置与三个纯函数模块，但不含入口页面与大部分运行时模块（原因见 §5）。
> 本页说明原项目的两种部署方式，以及在本仓库里能实际运行什么。

## 1. 原项目的两种部署形态

```mermaid
flowchart LR
  subgraph A["形态 A：Cloudflare Worker"]
    A1["wrangler.toml<br/>main = src/worker.js"] --> A2["Worker<br/>/api + assets"]
    A2 --> A3["env.ASSETS<br/>./public"]
  end
  subgraph B["形态 B：Cloudflare Pages"]
    B1["functions/api.js"] --> B2["Pages Functions<br/>仅 /api"]
    B3["构建输出目录<br/>public/"] --> B4["Pages 静态托管"]
  end
  A2 --> UP["上游模型服务"]
  B2 --> UP
```

两者选其一即可，不要同时部署同一份前端——`/api` 只应有一个归属。

## 2. 形态 A：Worker

### 2.1 配置

原项目根目录的 `wrangler.toml`：

```toml
name = "star-playground"
main = "src/worker.js"
compatibility_date = "2026-11-01"

[assets]
directory = "./public"
binding = "ASSETS"
```

`[assets]` 是 Workers Static Assets 的绑定方式：`/api` 由代码处理，其余请求交给 `env.ASSETS.fetch(request)`（`src/worker.js:43`）。

### 2.2 步骤

```bash
# 1. 安装依赖（仅 wrangler）
npm install

# 2. 配置密钥（不要写进文件）
npx wrangler secret put DEEPSEEK_API_KEY

# 3. 本地开发
npm run dev          # = wrangler dev

# 4. 部署
npm run deploy       # = wrangler deploy
```

| 项 | 值 |
|---|---|
| Node | 18+（`wrangler@4` 要求） |
| 依赖 | `wrangler ^4.0.0`（devDependency，见仓库 `package.json`） |
| 环境变量 | `DEEPSEEK_API_KEY`（secret） |
| 静态目录 | `./public` |
| 绑定 | `ASSETS` |

### 2.3 注意

- Worker 版**没有上游超时**（`src/worker.js:19-26`）。上游卡住时，靠客户端 45 秒断开。
- Worker 版**不校验** `DEEPSEEK_API_KEY` 是否存在。忘了配置时，用户会看到上游返回的 401，而不是一句能看懂的提示。

## 3. 形态 B：Cloudflare Pages

### 3.1 配置

| 项 | 值 |
|---|---|
| 构建命令 | 无（纯静态，无打包） |
| 输出目录 | `public` |
| Functions 目录 | `functions`（自动识别） |
| 环境变量 | `DEEPSEEK_API_KEY` |

`functions/api.js` 只导出 `onRequest`，因此只拦截 `/api`，其余请求由 Pages 静态托管。

### 3.2 与 Worker 版的差异

| 维度 | Worker | Pages |
|---|---|---|
| 上游超时 | 无 | 40 秒 |
| 缺 Key | 转发后由上游 401 | 本地 500，带中文提示 |
| 非 POST | 落到 500 | 405 |
| 错误码 | 无 `code` | `UPSTREAM_TIMEOUT` / `UPSTREAM_ERROR` |

如果只想要一套，建议保留 Pages 版：它的错误语义更完整，且超时分层（40s < 客户端 45s）能让「上游超时」先于「浏览器断开」被讲清楚。

## 4. 本地运行

### 4.1 跑测试（本仓库可直接执行）

```bash
node --test "tests/shared/*.test.mjs"
```

| 项 | 要求 |
|---|---|
| Node | 18+（`node:test` 内置；实测 22.22.2） |
| 第三方依赖 | **无** |
| 文件 IO | **无**（纯函数测试，不读写磁盘） |
| 实测结果 | 31 / 31 通过 |

> 传目录的写法（`node --test tests/shared/`）在部分 Node/Windows 组合下会报 `MODULE_NOT_FOUND`，用通配符形式更稳。

只覆盖三个纯函数模块（`life-clock`、`history-window`、`prompt-layout` 的部分行为）。`prompt-layout.test.mjs` 未纳入本仓库——它的测试夹具包含专属文本，需要中性化后才能公开。

### 4.2 跑完整前端（本仓库不具备条件）

原项目的 `public/index.html` 用相对路径加载 38 个脚本、`manifest.json`、样式与素材。其中 `manifest.json` 在该项目目录里**并不存在**——`index.html:7` 的 `<link rel="manifest">` 是悬空引用，所以这项缺失不是本仓库删减造成的。本仓库只包含 38 个脚本中的 6 个（3 个 JS + 3 个 CSS）+ 无素材，缺失项会让页面直接报错。

如果你有完整项目，本地跑法有两种：

| 方式 | 命令 | 说明 |
|---|---|---|
| `wrangler dev` | `npm run dev` | 推荐，`/api` 与静态资源都可用 |
| 任意静态服务器 | `python -m http.server -d public 8000` | `/api` 不可用，聊天发不出去 |

另一个细节：`public/app.js:6-8` 在 `file://` 协议下会把请求指向 `http://127.0.0.1:23210/...`。这是原项目的本地调试转发端口，**本仓库不包含该转发脚本**，所以双击打开 HTML 也无法工作。

## 5. 本仓库包含 / 不包含什么

| 包含 | 说明 |
|---|---|
| 文档 8 篇 | 架构、模块、请求流、记忆、存储、API、部署、索引 |
| `public/shared/life-clock.js` | 时间纯函数（可直接公开） |
| `public/shared/history-window.js` | 历史窗口纯函数 |
| `public/shared/prompt-layout.js` | messages 组装纯函数 |
| `public/shared/tokens.css` | 设计变量 |
| `public/styles.css` / `public/voice.css` | 样式 |
| `tests/shared/*.test.mjs` | 前两个纯函数的测试 |
| `package.json` / `package-lock.json` | 依赖声明（wrangler） |

| 不包含 | 原因 |
|---|---|
| `public/index.html`、`public/app.js` | 含角色文案与私人页面结构；编排层需先拆分 |
| `shared/persona*.js`、`self-narrative*.js`、`memory-*.js` | 人设与私人关系数据 |
| `shared/request-composer.js`、`ai-client.js` | 含专属文案，需中性化 |
| `src/worker.js`、`functions/api.js` | 两套代理需先合并/统一，再作为示例公开 |
| `assets/`、`audio/`、表情包目录 | 素材版权与来源需单独确认；`manifest.json` 另见 §4.2（原项目即缺失） |
| `wrangler.toml` | 指向未公开的 `src/worker.js`；本页以代码块形式给出内容 |
| 备份、数据库、日志、`.dev.vars` | 私人数据与密钥 |

## 6. 如果你要基于这套结构做自己的项目

按依赖顺序补齐，阻力最小：

1. **先跑通代理**：复制 Worker 或 Pages 版，换成你的上游与 Key，用 `curl` 验证 `/api`。
2. **再做请求管线**：直接用本仓库的 `prompt-layout.js` + `history-window.js`，它们是纯函数，不依赖本项目任何东西。
3. **然后补前端**：从 `AIClient.chat()` 的调用形状出发（`{ url, apiKey, messages, timeoutMs }`），写最小页面即可跑通一次对话。
4. **最后加记忆**：记忆机制与业务强耦合，建议先想清楚「哪些内容需要长期保留」，再参考 [04](04-memory-and-history.md) 的分层，而不是照搬四套机制。

## 7. 安全提醒

- 不要把带通配 CORS、无鉴权的 `/api` 直接暴露到公网（见 [06 · API](06-api.md) 第 6 节）。
- `DEEPSEEK_API_KEY` 只放部署环境的 secret，不要写进仓库、不要写进前端。
- 客户端自填 Key 目前不参与上游鉴权（见 [06 · API](06-api.md) 第 5 节），不要据此认为「用户用自己的额度」。
- 若复用管家库结构（睡眠/周期/账单），先评估当地对敏感个人数据的合规要求。
