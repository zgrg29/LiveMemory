# 2026-11-16 · TIKTOK-M5：匿名本地 WebSocket 统一采集，删除登录与通道选择

分支 `feature/tiktok`。起始状态：代码 `ea950c0`、文档 `3ebe3d5`、EXE `a463acfad051`、全量 1050 测试。
本轮目标：验证并接入 `talkaboutdesign/tiklive` 所采用的匿名 TikTok LIVE WebSocket 方案；成功后将 TikTok
统一为**唯一、无需登录**的采集方式，删除扫码登录、浏览器中继与社区签名通道。

## 1. 源码与合规审查

| 项目 | 结论 |
| --- | --- |
| 上游 | `talkaboutdesign/tiklive` @ `a290dd4`（Release v0.6.0，2026-10-30）；MIT，Copyright 2026 Talkabout Design LLC |
| 许可证义务 | MIT 允许派生与再分发；本项目未复制其源码，仅按其协议实现重写，归属写入 `THIRD_PARTY_NOTICES.md` |
| 运行时依赖 | 上游核心依赖 **Effect 4**（peer）与 Bun 工具链；不能直接嵌入零依赖 Node SEA → 只采用协议 |
| 本实现 | `webcast.mjs` + `local-adapter.mjs`，仅用 Node 内置 `fetch` / 全局 `WebSocket` / `node:zlib` / `node:sqlite` |
| 额外运行时 | 无；不需要 Bun、Python、浏览器或 `npm install` |
| 用户安装 | 无额外程序；只输入直播间链接 |
| 第三方云服务 | 无；不需要付费或免费签名服务，无隐藏配额（TikTok 自己的匿名限流除外） |
| 持续事件 | 是；真实 30 分钟长跑 + 断线重连见 §5 |
| 稳定 UID | 是；`tiktok:<user.id>` |
| 礼物/连送 | 解析与连送合并已实现并有自动化测试；**真实礼物是否观测到以运行证据为准** |
| 平台条款/访问控制 | 使用 TikTok **非公开 web 协议**，不是官方 API；未绕过验证码/登录/地区限制。若平台明确拒绝访问必须停止路径并报告 |
| 阻断性问题 | 未发现阻断性许可证或访问控制问题；但协议可能随时变更，必须持续标注非官方/实验性 |

协议要点（`docs/PLATFORM_INTEGRATIONS.md` §3C）：匿名 `ttwid` → `webcast-ws.tiktok.com` PushFrame（field 8，gzip）
→ `ProtoMessageFetchResult` → 既有 `mapTikTokMessage` → 统一 `EventIngest`。客户端帧：`im_enter_room`、`hb`、`ack`。
无续传游标；10 秒心跳；60 秒无帧视为死连接。

## 2. 独立验证（先于正式接入）

工具：`scripts/verify-tiktok-local-ws.mjs`（独立进程、独立统计，不复用 adapter 状态机）。

发现并修正的验证工具问题：

- 首次 30 分钟长跑在 12 分钟强制断线后**只重试一次**，ttwid 刷新被 TikTok 限流 → 采集中断。
  这不是产品结论，但暴露了两个真实设计点：
  1. 普通掉线不应刷新 `ttwid`（会触发页面请求限流）；只有 socket-open 失败才刷新；
  2. 重连必须按退避持续重试，而不是一次失败就放弃。
  产品 adapter 已按此实现；验证工具改为最多 6 次退避重试并复用缓存 Cookie。

真实环境约束（如实记录）：

- `aljazeeraenglish`（room `7706695538414062349`）是本轮唯一可确认正在直播的房间；其余候选账号
  公开接口均返回 `liveRoom.status=4`（已结束）。
- 公开元数据接口在突发请求下会返回 403/空响应；验证脚本只在开始时解析一次，不与采集抢请求。
- 该房间观众以垃圾弹幕为主，**未观测到礼物**（`NOT-OBSERVED`）。礼物/连送语义由自动化测试覆盖，
  不以推测冒充真实证据。

> 真实 30 分钟数字见 `docs/STATUS.md` §0.42.3；本节只记录方法与限制。

## 3. 正式接入

| 模块 | 内容 |
| --- | --- |
| `src/platforms/tiktok/webcast.mjs`（新） | 匿名 ttwid（重试/持久化/0600）、socket URL、PushFrame 编解码、heartbeat/ack、空闲检测、双 host 回退、帧/批/控制帧计数 |
| `src/platforms/tiktok/local-adapter.mjs`（新） | 连接状态机、退避重连、两次离线确认、连送合并、msgId 去重、历史回放跳过、房间重校验、gap 记录 |
| `src/platforms/tiktok/state.mjs`（新） | `<data>/tiktok/ttwid.json` 匿名设备 Cookie 存储（非登录凭据、0600、不进备份/导出） |
| `src/platforms/tiktok/legacy-cleanup.mjs`（新） | 仅删除 LiveMemory 自己创建的旧浏览器 Profile 与登录状态文件；无所有权标记一律保留 |
| `src/platforms/tiktok/service.mjs` | 单一路径 `local`；`transport()` 不再提供选择；状态里彻底移除 `login`；共享 ttwid；停止/结束状态可回读 |
| `src/server/{index,routes,settings-store}.mjs` | 删除 `/api/tiktok/login/*`、`/api/tiktok/transport` 与 `tiktokTransport` 设置；启动时执行清理与 ttwid 恢复 |
| `src/monitoring/detectors/tiktok.mjs` | 错误映射改为本地传输（socket/timeout/network/rate-limit/not-configured） |
| `src/web/js/pages/live.js` | TikTok 面板重写：链接/检查/开始/停止/自动监听 + 四项独立状态 + 高级技术详情；无登录、无通道选择 |
| `src/web/i18n/*.json` | 删除 96 个旧键 × 3 语言；新增本地采集、四项状态、技术详情与错误文案（三语一致） |
| `scripts/verify-tiktok-local-ws.mjs`（新） | 独立 30 分钟真实验证；JSON 报告；强制断线重连 |
| `scripts/verify-tiktok-exe.mjs` | 改为验证匿名本地传输；断言登录/通道路由 404；礼物 `NOT-OBSERVED` 语义 |
| `scripts/build-windows.mjs` | 必需模块列表更新为 10 个 TikTok 模块 |

## 4. 删除的旧实现

- 删除文件：`browser-login.mjs`、`browser-launch.mjs`、`browser-relay.mjs`、`signer.mjs`、
  `rate-budget.mjs`、`adapter.mjs`（轮询）、`transports.mjs`。
- 删除测试：`tiktok-browser-login`、`tiktok-browser-relay`、`tiktok-signer`、`tiktok-adapter`、
  `tiktok-rate-budget`、`tiktok-reconnect`；`tiktok-session` / `tiktok-monitoring` / `tiktok-ui` 重写。
- 删除脚本：`verify-tiktok-browser-login.mjs`、`verify-tiktok-live-30m.mjs`（由 `verify-tiktok-local-ws.mjs` 取代）。
- 数据保留：数据库 schema 未改；历史 TikTok 会话/弹幕/观众画像/AI 结果不受影响。
- 抖音登录未受影响：`src/platforms/douyin/browser-login.mjs` 等独立模块与测试仍在。

## 5. 测试与验收

## 5. 测试与验收

| 运行 | 结果 |
| --- | --- |
| 定向 TikTok（unit + integration） | **72 passed / 0 failed / 0 skipped（6,293.84 ms）** |
| 全量 | **1019 passed / 0 failed / 0 skipped（290,038.02 ms，2026-11-16）** |
| 真实 30 分钟 | **706 chat / 110 位稳定 UID / 0 缺失 / 0 重复 / 2427 帧 / 1 次强制断线后重连成功**；ttwid 0（复用缓存）/ 房间查询 0（直接用 room-id 启动）/ WebSocket 连接 2 |
| 礼物 / 连送 / 订阅 | **NOT-OBSERVED**（真实运行 0；只有合成帧 + SQLite 测试） |
| `scripts/verify-exe.mjs` | **10/10** |
| `scripts/verify-tiktok-exe.mjs @aljazeeraenglish` | **22/22 passed + 2 NOT-OBSERVED，0 failed** |
| 其他四平台真实回归 | Bilibili 房间 6：1 条 / 1 人；YouTube `4t4AQ15yj1M`：75 条 / 12 人；Twitch `kato_junichi0817`：7 条 / 7 人；抖音 `708764876300`：2 条 / 2 人；全部 `connected` 并停止成功 |
| EXE | `D:\LiveMemory\dist\LiveMemory.exe` / Build ID `9b63b0018235` / commit `a0e6638` / `97,760,768` B / SHA-256 `5d66ab103549d96f6d920926da81bc04ab8853ee46891a2be4dfbd61f1dbddd1` / `requireAdministrator` |
| main | 未合并、未 Push、未 Tag、未 Release |

真实 30 分钟报告：`tests/.tmp/verify-local-ws-30m-v2/report.json`（临时目录，不提交）。

## 6. 边界与未解决

- 非官方协议：TikTok 可随时更改；没有游标，重连期间可能漏消息，不补录。
- 真实礼物/连送：本轮未观测到（`NOT-OBSERVED`），只有合成帧与 SQLite 集成测试。
- 真实订阅（`WebcastSubNotifyMessage`）：本轮未观测到。
- 干净 Windows 账户、真实双击 UAC、真实断网重启：需人工验收。
- 长时间多房间并发：仅自动化测试（两个独立 session）；真实第二直播间未找到。
