# TikTok LIVE 可行性研究与接入决策（2026-11-15）

范围：本轮 `feature/tiktok`。只做只读真实探测与自研代码，未登录任何 TikTok 账号、未提供 Cookie、未赠送/购买礼物、未购买任何签名服务、未绕过验证码或访问控制。

结论速览：

| 能力 | 结论 | 证据等级 |
| --- | --- | --- |
| 直播间识别 / 开播状态 / 主播稳定 ID / 标题 / 累计观看 | **可以，完全本地免费**（公开接口，无需登录、无需签名服务） | 真实数据 |
| 礼物目录（名称 + 钻石展示价值） | **可以，完全本地免费**（公开接口，809 个礼物） | 真实数据 |
| 聊天 / 礼物事件（官方网页匿名） | **不可以**：匿名访问 `room/enter` 返回 403，聊天面板停在“正在加载” | 真实阻断证据 |
| 聊天 / 礼物事件（未登录直连推送 WebSocket） | **不可以**：握手被拒（HTTP 200 代替 101） | 真实阻断证据 |
| 聊天 / 礼物事件（免费社区签名通道） | **可以**：无需 API Key、无需付费、无需 Business 计划 | 真实数据（6/6 有 `user.id` + `msgId`） |
| 礼物 / 连送 / 订阅事件 | 已按公开协议实现解析、连送合并与去重；**真实事件尚未观测到** | 解析 + 自动化测试 |
| 浏览器中继（用户登录后） | M2 已实现官方登录页/状态机/单窗口与验证流程；**真实浏览器启动在当前 DSH 沙箱 BLOCKED**（`0x80000003`），登录后聊天投递待普通 Windows 桌面人工验收 | 实现 + 单元/集成测试；真实阻断证据 |

## 1. 为什么不是“直接照抄现成库”

两个主流库都能拿到 TikTok LIVE 事件，但都不满足本项目的约束：

| 项目 | 版本/时间 | 许可证 | 签名方式 | 主要问题 |
| --- | --- | --- | --- | --- |
| [TikTok-Live-Connector](https://github.com/zerodytrash/TikTok-Live-Connector) | 2.5.0（2026-11-11 推送） | AGPL-3.0 | 默认走 Euler Stream（`tiktok-live-api-sdk`） | 约 60 个 npm 运行时依赖；`fetchWebcastSignature` 与部分路由要求 Business 计划；公开 Issue 报告漏消息、礼物不触发、签名 404 |
| [TikTokLive](https://github.com/isaackogan/TikTokLive)（Python） | 6.x（2026-10-20 推送） | 修改版 AGPL-3.0 | 同样通过 Euler Stream 签名 | 需要 Python 运行时；官方文档自述“不是生产级 API”“签名由第三方签名服务器处理” |
| 其它语言实现（Java/C#/Go/Rust） | — | 多为 AGPL | 同样依赖签名服务 | 与 Node SEA 打包不兼容 |

LiveMemory 的运行时是零依赖 Node SEA，因此：

- 不引入 npm 依赖、不引入 Python；
- 不复制 AGPL 代码；
- 只参考**协议字段编号**这类接口事实（公开 Webcast protobuf 定义），自行实现 wire 编解码与事件映射。

## 2. 真实只读探测（2026-11-15，Asia/Shanghai）

### 2.1 公开接口可以完全本地读取

`GET https://www.tiktok.com/api-live/user/room/?...&uniqueId=<handle>&sourceType=54`：

```json
{"uniqueId":"aljazeeraenglish","roomId":"7706695538414062349","anchorUid":"7074562477175424046",
 "anchorName":"Al Jazeera English","isLive":true,"status":2,"title":"Al Jazeera English TikTok LIVE",
 "totalViewers":50817556}
```

`GET https://webcast.tiktok.com/webcast/room/info/?room_id=<roomId>` 返回 245 个字段（标题、主播 `id_str`/`nickname`/`sec_uid`、开播时间、推拉流地址、统计）。

`GET https://webcast.tiktok.com/webcast/gift/list/?room_id=<roomId>`（约 3.4 MB）返回 **809 个礼物**，例如 `{"id":56560,"name":"My First Rose","diamond_count":1,"combo":true}`。没有本币币种字段：钻石只能作为展示价值，不能当收入。

以上三个请求均**不需要登录、Cookie、API Key 或签名服务**。

### 2.2 官方网页的聊天需要登录（访问控制，不是技术故障）

真实 Chrome 154 + CDP 打开 `https://www.tiktok.com/@aljazeeraenglish/live`：

- 页面正常加载，标题为“正在直播”；
- 页面自身创建 `wss://im-ws-sg.tiktok.com/ws/v2?...`，发送进入房间帧，仅收到 1 个 sync 响应帧，**没有任何聊天消息**；
- 页面 `POST https://webcast.tiktok.com/webcast/room/enter/` 连续 3 次返回 **403**；
- 聊天面板显示“观众 / 正在加载…”，直播间提示“当前画质体验剩余 29 秒。登录后继续体验”。

移动端 UA 打开同一路径：页面显示“Something is wrong on our end”，同样没有聊天。

结论：TikTok 网页端把 **进入房间与聊天** 放在登录之后。这是平台访问控制，程序不绕过。

### 2.3 未登录直连推送 WebSocket 被拒

用免费签名通道拿到的 `pushServer`（`wss://webcast-ws.tiktok.com/webcast/im/ws_proxy/ws_reuse_supplement/`）、cursor、internalExt、routeParams（`X-Bogus`/`X-Gnarly`/`wrss`）直连：

- `ws` 8.23.0：`Unexpected server response: 200`（应为本 101）；
- 内置 WebSocket：`1006`；
- 未签名 `GET https://webcast.tiktok.com/webcast/im/fetch/`：HTTP 200，**0 字节**。

结论：TikTok 不接受未签名/非浏览器指纹的推送连接；本项目不伪造 TLS 指纹、不重放签名。

### 2.4 免费社区签名通道（本轮默认通道）

`GET https://api.eulerstream.com/webcast/rooms/<roomId>/connect?client=ttlive-node&client_enter=true&platform=web&user_agent=...`

- **匿名可用**：无 API Key、无账号、无付费；
- 返回 protobuf `ProtoMessageFetchResult`（cursor / internalExt / pushServer / messages）与 `x-set-tt-cookie`；
- 真实批次示例：18 条消息，其中 6 条 `WebcastChatMessage`，全部带 `common.msgId` 与 `user.id`，正文含 Unicode Emoji；
- M1 记录过的响应头示例为 `ratelimit-limit: 1500; w=60`，并曾把新连接理解为 5 次/分钟突发；M2 的真实账号上限更正见 §2.4.1。

真实样本（已脱敏，仅保留结构与类型）：

| 字段 | 示例 |
| --- | --- |
| `user.id`（稳定身份） | `7366634237712335877` |
| `nickname`（仅显示） | `Hi` |
| `common.msgId`（去重） | `7708351856309832470` |
| `common.createTime` | `1794740531745`（epoch ms） |
| `content` | `OUR PRESIDENT HERE IN PHILIPPINES IS COR...`、`good afternoon 🌃🌅😊👍` |

#### 2.4.1 2026-11-15 M2 更正：匿名上限是 30 次/小时

M1 记录「新连接突发 5 次/分钟」只描述了短窗口。M2 实测发现，匿名免费通道还有 **30 次/小时** 的账号/IP 上限，且只在用尽后通过 429 暴露：

```text
HTTP 429
ratelimit-limit: 30
ratelimit-policy: 30;w=3600
ratelimit-remaining: 0
ratelimit-reset: 2708
retry-after: 2708
{"code":429,"message":"You have reached the rate limit. Sign up for a free API key ...","limit_label":"rate_limit_account_hour"}
```

未用尽时响应头可能仍是 `1500;w=60`。因此：

- 15 秒轮询（240/h）会在约 7.5 分钟后耗尽 30 次，随后进入 429；M1 把 `Retry-After` 截断到 30 秒，导致整个小时反复重试，这是频繁「重连中」的根因。
- M2 使用进程内共享预算：匿名默认 130 秒/请求，完整遵守 `Retry-After`/`ratelimit-reset`，429 状态为 `rate_limited`，不误判下播。
- 代价是免费通道的实时性约 2 分钟一批；这是平台限制，不是界面故障。需要更快节奏时只能由用户显式选择浏览器中继（需登录），不自动切换。

## 3. 采用的方案

### 3.1 传输 A（默认）：免费社区签名通道

- 模块：`src/platforms/tiktok/signer.mjs` + `src/platforms/tiktok/rate-budget.mjs`
- 轮询：`cursor` 续传；匿名默认 **130 秒/次**，共享进程内请求预算；429 完整遵守 `Retry-After`/`ratelimit-reset`，状态 `rate_limited`；连续 15 次可恢复失败后进入 `failed` 并 5 分钟慢探测。
- 0 消息批次是成功；协议错误会重置过期 cursor 并重新校验房间。
- 自动开播监听：只使用公开 `api-live` 接口（不经签名服务）。
- 明确披露：这是**第三方云服务**，不是 TikTok 官方 API；接口变化时界面显示 `TIKTOK_SIGNER_*` 错误，不会静默降级。可通过 `baseUrl` 指向自建/兼容签名服务。

### 3.2 传输 B（实验性，可切换）：浏览器中继 + 官方登录

- 模块：`src/platforms/tiktok/browser-relay.mjs` + `browser-login.mjs` + `browser-launch.mjs`
- 本机 Chrome/Edge + 专用资料目录（`<data>/browser/tiktok/account`，含 `.livememory-owned` 标记）。
- 登录：打开官方 `https://www.tiktok.com/login`；用户自行选择二维码/手机/邮箱/用户名；程序只检测官方 Cookie 与页面状态，不生成二维码、不读取密码、不绕过验证码。
- 状态：未登录/等待/验证中/已登录/已失效/平台拒绝/浏览器不可用；登录与采集分开验证。
- 采集：页面级 CDP 读取官方直播页自身收到的 WebSocket 帧（gzip protobuf）。
- 不启用 `--no-sandbox`、不关闭 Web 安全、不注入 stealth 脚本、不伪造签名。
- **真实登录与登录后聊天投递未验证**：当前环境没有 TikTok 账号；2026-11-15 DSH 沙箱也无法从 Node 启动 Chromium（`0x80000003`），必须普通 Windows 桌面人工验收。不能把单元测试写成真实登录成功。

## 4. 事件映射（全部经 `EventIngest`）

| TikTok 消息 | canonical | 去重 | 身份 |
| --- | --- | --- | --- |
| `WebcastChatMessage` / `WebcastEmoteChatMessage` | `chat` | `common.msgId` | `tiktok:<user.id>` |
| `WebcastGiftMessage`（`repeatEnd=1` 或超时冲刷） | `gift` | `common.msgId` | `tiktok:<user.id>` |
| `WebcastSubNotifyMessage` | `membership` | `common.msgId` | `tiktok:<user.id>` |
| `WebcastMemberMessage` / `Like` / `Social` | 只计数，不写事件 | — | — |
| `WebcastRoomUserSeqMessage` | 当前观众数（状态） | — | — |
| `WebcastControlMessage(action=3)` | 一次离线观测 | — | — |

金额规则：礼物只写 `amount_display = "<钻石数> TikTok Diamonds"`，`amount_minor=null`、`currency=null`、`value_kind=unknown`；**不把钻石换算成收入**。连送仅在最终状态计一次；超时未收到最终状态时按最后已知值冲刷一次。

## 5. 许可证

- 未复制 TTLC / TikTokLive / tiktok-live-proto 的代码；仅参考公开 protobuf **字段编号**（接口事实），编解码与映射为本项目自研。
- 主项目 `LICENSE`（MIT）未修改；本轮没有新增任何 AGPL 代码或 npm 依赖。
- 第三方签名服务的使用属于**运行时可选依赖**，不是代码依赖；`src/platforms/tiktok/signer.mjs` 不包含其 SDK。

## 6. 已知限制与风险

1. 免费签名通道是第三方服务：可能限流、改版或收费；若其要求付费计划，界面显示“不会强制购买”，并提供浏览器中继/自建签名地址。
2. 匿名免费通道实际约 **30 次/小时**；M2 以约 130 秒/次共享预算避免触发 429，实时性因此下降。多房间共享同一预算。
3. 登录态浏览器中继未验证；TikTok 可能继续收紧匿名 Web 能力。本机沙箱无法启动 Chromium，真实登录待普通桌面人工验收。
4. 真实礼物、连送、订阅事件尚未观测到（本次直播没有送礼）。
5. TikTok 未提供官方 LIVE 聊天/礼物 API；所有路径都属非官方兼容，可能失效。
6. 30 天原文保留同样适用于 TikTok（TikTok-only 清理，不影响其它平台）。
7. 限流/断线期间的消息是否由平台补齐无法保证；界面只写“可能有缺口”，不声称完整。

## 7. 复现方式

```bat
:: 公开接口（本地免费）
node -e "import('./src/platforms/tiktok/client.mjs').then(async m=>console.log(await new m.TikTokClient().checkRoom('aljazeeraenglish')))"

:: 免费签名通道（真实事件）
node -e "import('./src/platforms/tiktok/signer.mjs').then(async m=>{const s=new m.TikTokSigner();const r=await s.connect({roomId:'7706695538414062349'});console.log(r.fetchResult.messages.length)})"

:: 自动化测试
node --test --test-isolation=none "tests/unit/tiktok-*.test.mjs" "tests/integration/tiktok-*.test.mjs"
```
