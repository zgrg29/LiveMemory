# 架构（ARCHITECTURE）

## 1. 总览

```text
LiveMemory.exe (Node SEA)
└─ scripts/sea-bootstrap.cjs            解压内嵌资源 → 调用启动器
   └─ src/launcher/launcher.mjs         环境/数据目录/单实例/端口/浏览器/退出
      └─ src/server/index.mjs           startServer(): 设置 → DB → 迁移 → 恢复 → HTTP
         ├─ src/server/http.mjs         安全头、Host/Origin 校验、静态服务、JSON
         ├─ src/server/routes.mjs       API 路由
         ├─ src/server/sse.mjs          EventStream（实时推送）
         ├─ src/server/settings-store.mjs  config/settings.json
         ├─ src/server/logger.mjs       脱敏 JSONL 日志
         ├─ src/storage/                node:sqlite + 迁移 + 仓储
         ├─ src/platforms/shared/       适配器契约、EventIngest、SessionManager
         ├─ src/platforms/mock/         模拟直播源
         ├─ src/platforms/bilibili/     真实直播适配器（WebSocket）
         ├─ src/platforms/youtube/      真实直播适配器（OAuth / API Key + 轮询）
         ├─ src/storage/retention.mjs   YouTube 原始内容保留策略
         ├─ src/analytics/              只读读模型（时间线/汇总/画像）
         └─ src/ai/export/              分析包生成（含表情字典）
   └─ src/web/                          浏览器控制台（原生 ES Modules）
```

## 2. 启动时序

1. 解析参数（`--no-open`、`--port`、`--data-dir`、`--lang`）。
2. `chcp 65001` 设置控制台 UTF-8；解析系统语言。
3. 检查 Node 版本与 `node:sqlite`。
4. 解析数据目录（显式路径优先，其次 `%LOCALAPPDATA%\LiveMemory`），创建子目录并写探针。
5. 读取 `config/settings.json`，确定命令行语言（保存的偏好优先，`--lang` 覆盖）。
6. 获取单实例锁 `runtime/instance.lock`；若已有存活实例，打印地址并打开浏览器后退出。
7. `startServer()`：
   - 迁移数据库并记录 schema 版本
   - 将遗留 `live` 场次标记为 `interrupted`
   - 绑定 `127.0.0.1:preferredPort`（冲突 +1…+9，最后 0）
   - 写 `runtime/runtime.json`（pid/port/url）
8. 打印数据目录、控制台地址、日志目录、连接状态、退出方式。
9. 打开系统默认浏览器（`cmd /c start "" <url>`）。
10. 等待 SIGINT/SIGTERM 或服务关闭 → 逆序关闭并清理 runtime 文件。

## 3. 事件数据流

```text
平台适配器（Bilibili/YouTube/mock）
  └─ normalizeEvent()  → canonical event（shared/events.mjs）
      ├─ content 原文 / Unicode Emoji 原样保留
      └─ emotes 可选最小元数据（id/code/name/source）
      └─ EventIngest.record()  [单事务]
          ├─ ensureViewer()              先建身份（满足外键）
          ├─ insertEvent()               INSERT OR IGNORE（唯一去重键）
          ├─ recordViewerActivity()      观众计数/昵称/场次/币种累计
          ├─ recordSessionPayment()      场次币种累计（actual/display）
          └─ incrementSessionCounters()  消息/礼物/付费事件/最后事件时间
      └─ commit → SSE 'event' 广播 → 控制台即时渲染
```

**关键保证**：重复事件在 `insertEvent` 处返回 `changes=0`，后续聚合全部跳过，因此金额与计数不会翻倍。表情元数据参与指纹去重，但不改变 `content` 原文。

## 3.1 YouTube 凭据与数据流

```text
凭据解析（oauth-config.mjs）
  ├─ 环境变量 / <数据目录>/config/*.json / 内置常量（默认空）
  ├─ api-key 模式：YouTubeApi 把 key 放在查询参数，无 Authorization 头
  └─ oauth 模式：YouTubeOAuthManager 提供 Bearer token（提前 60s 刷新）

连接流程
  parseYouTubeInput(link) → videos.list → checkRecordable()
    ├─ 非直播/未开始/已结束/聊天关闭 → 明确错误码（三语）
    └─ 可记录 → SessionManager.startPlatform({platformStartedAt})
                 → YouTubeLiveChatAdapter.start()
                     → liveChatMessages.list(pageToken)  ← 轮流询
                     → mapper.mjs → canonical draft
                     → EventIngest（去重/观众/金额/计数）
                     → SSE → 控制台
```

- OAuth：`startLogin()` 启动单次回环接收器（`127.0.0.1` 随机端口）→ 系统浏览器打开 Google 官方授权页 → 回调校验 `state` → code + PKCE verifier 换 token → AES-256-GCM 加密保存。UI 轮询 `/api/youtube/login/status`。
- 令牌只存在于加密文件与内存；`status()`、日志、AI 包、备份都不含令牌。
- 适配器只负责传输：任何平台事件都必须经过 `EventIngest`。

## 3.2 保留策略

`src/storage/retention.mjs` 在启动、YouTube 场次结束与手动调用时清理 `platform='youtube'` 且超过窗口的聊天原文与表情元数据，保留行、计数、身份与金额。目的见 `PRIVACY_SECURITY.md` §12。

## 4. 读模型

- `analytics/sessions/hotness.mjs`：按场次时长选择 10s–1h 的桶；输出消息数、独立观众、按币种支付；直播中不绘制未完成的桶。
- `analytics/sessions/summary.mjs`：场次摘要 + 时间线 + 支持 + 活跃观众 + 存储统计。
- `analytics/viewers/profile.mjs`：观众档案（身份、累计、昵称历史、参与场次）。
- `analytics/payments/totals.mjs`：按币种合并 actual/display，绝不混加。

### 4.1 AI 分析包（文本优先）

- `messages.jsonl` 保留 `content` 原文；Unicode Emoji 不转换。
- 平台表情进入 `session_context.emote_dictionary`，消息通过 `emote_refs` 引用；同一表情只存一份元数据。
- 仅当原文不足以理解表情时，才增加 `content_ai`；未知表情标记 `[未知平台表情：emote_id=…]`，不猜情绪。
- 不打包表情图片；包大小主要由文本和聚合决定。
- `instructions.md` 由 `src/ai/prompts/instructions.mjs` 按 `locale` 生成，包含话题、观众画像、经济支持、Emoji/表情、数据可靠性与不可信数据规则。

## 5. HTTP API（v0.1.0）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 存活检查 |
| GET | `/api/bootstrap` | 应用、设置、状态、能力矩阵 |
| GET | `/api/status` | 服务/平台/数据库状态 |
| GET/PATCH | `/api/settings` | 读取/更新偏好（校验后持久化） |
| GET | `/api/sessions` | 场次列表（含币种支持） |
| GET | `/api/sessions/current` | 当前记录中的场次摘要 |
| GET | `/api/sessions/:id` | 单场摘要 + 时间线 |
| POST | `/api/sessions/:id/stop` | 结束指定场次 |
| POST | `/api/simulate/start` | 开始模拟场次（`title`、`speed`） |
| POST | `/api/simulate/stop` | 停止当前场次 |
| GET | `/api/viewers` | 观众列表（`query`、`limit`） |
| GET | `/api/viewers/:id` | 观众档案 |
| PATCH | `/api/viewers/:id` | 关注标记 |
| GET | `/api/bilibili/status` | Bilibili 登录与连接状态 |
| POST | `/api/bilibili/login/qrcode` | 生成扫码二维码 |
| POST | `/api/bilibili/login/poll` | 轮询扫码结果 |
| POST | `/api/bilibili/login/logout` | 退出 Bilibili 登录 |
| POST | `/api/bilibili/room` | 校验直播间 |
| POST | `/api/bilibili/connect` | 开始记录 Bilibili 直播 |
| POST | `/api/bilibili/disconnect` | 停止记录 |
| GET | `/api/youtube/status` | YouTube 模式、登录、连接、配额、保留策略 |
| POST | `/api/youtube/login/start` | 启动 Google 授权（返回授权 URL） |
| GET | `/api/youtube/login/status` | 登录状态（供页面轮询） |
| POST | `/api/youtube/login/logout` | 撤销授权并删除本地令牌 |
| POST | `/api/youtube/video` | 解析直播链接并返回可记录性 |
| POST | `/api/youtube/connect` | 开始记录 YouTube 直播 |
| POST | `/api/youtube/disconnect` | 停止记录 |
| POST | `/api/youtube/retention/apply` | 立即执行 YouTube 原文保留清理 |
| GET | `/api/events` | 场次事件（倒序、分页） |
| GET | `/api/events/stream` | SSE（`event`、`status`） |
| GET | `/api/storage` | 数据目录、占用、计数 |
| GET | `/api/ai/instructions` | 指定语言的提示词 |
| POST | `/api/ai/packages` | 生成分析包 |
| GET | `/api/ai/packages` | 已导出包列表 |
| GET | `/api/ai/packages/:id/download` | 下载 ZIP |

## 6. 并发与一致性

- `node:sqlite` 同步 API，单进程串行写入；`BEGIN IMMEDIATE` 包裹一次事件写入。
- WAL + `busy_timeout=5000`；退出时 `wal_checkpoint(TRUNCATE)`。
- 单实例锁避免两个进程写同一数据库。
- 事件插入与聚合同事务，避免“计数成功但事件缺失”。
- 场次状态由数据库读取，内存状态仅作缓存。

## 7. 错误处理

- `AppError` 携带稳定 `code`、i18n `messageKey`、`httpStatus`；API 返回 `{error:{code,messageKey,details}}`。
- 控制台按 `messageKey` 本地化，不解析英文句子。
- 启动器捕获致命错误 → 写 `runtime/last-error.json` → 三语提示 → 等待回车（TTY）→ 退出码 1。
- 前端页面渲染异常 → 捕获并展示重试界面，同时写入 `window.__lmLastError` 便于诊断。

## 8. 前端结构

- `js/app.js`：bootstrap、hash 路由、语言/主题切换、SSE、状态刷新。
- `js/pages/*.js`：页面模块，`render(container, ctx, params, query)` 返回清理函数。
- `js/ui.js`：DOM 构造（只用 `textContent`）、格式化、toast、空状态。
- `js/chart.js`：Canvas 时间线图，DPR 适配、主题重绘、hover 提示。
- `js/i18n.js`：按需加载 JSON 字典，`t(key, params)`。
- `js/theme-boot.js`：样式表前同步设置 `data-theme`，避免闪烁。
- `styles/tokens.css`：颜色/间距/圆角/阴影变量；明亮与黑暗分别定义。

## 9. 打包架构

```text
node.exe (官方运行时，含 node:sqlite)
  + SEA blob（src/** + manifest.json）
  + postject 注入 NODE_SEA_BLOB
  → dist/LiveMemory.exe（PE 子系统 = Console）
```

首次运行解压到 `<数据目录>/app/<content-hash>/`，内容变化时生成新目录，旧目录可安全删除（升级清理属 M8）。

## 10. 未来扩展点

- 平台适配器：实现 `PlatformAdapter.start({onEvent,onStateChange})`，产出 canonical event，即可复用全部统计、UI 与 AI 导出。
- 备份：复用 `shared/zip.mjs`，加入 `manifest.json` → `checksums.json` → `database/` → `settings/`。
- AI 导入：`src/ai/import/` 读取 ZIP/JSON → 校验 `result.schema.json` → 事务写入分析表与画像版本。
