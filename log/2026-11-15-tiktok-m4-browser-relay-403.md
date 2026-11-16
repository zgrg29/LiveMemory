# 2026-11-15 TIKTOK-M4：浏览器中继真实 403 调查与完整链路审计

## 0. 本轮结论

- 真实 Windows EXE 的 HTTP 403 来源：官方直播页自身发出的 `POST /webcast/room/enter/`，被 CDP `Network.responseReceived` 观察到。不是本地中继构造，也不是本地映射错误。
- 旧实现有三个本地缺陷：403 被当成登录失效并立即中止；把 `PushFrame` 当 `WebcastResponse` 解析，真实帧恒为 0 条；登录/直播间访问/采集/事件/开始记录混用，失败后 UI 退回原始 i18n 键。
- 已修复并补齐测试、三语键、监控映射。
- **真实登录后的浏览器中继端到端投递仍未验证（BLOCKED）**：DSH 作业对象终止 Chromium，`verify-tiktok-browser-login` 为 1/9 passed、0 failed、8 BLOCKED。不得写成 PASS。
- 免费本地方案仅研究：`talkaboutdesign/tiklive`（MIT）同类匿名 webcast 协议，35 秒 469 chat / 19 gift；未接入产品，因为它是 TikTok 非公开 web 协议，需产品/合规决策。

## 1. 403 调查

`BrowserSession.#onEvent()` → `Network.responseReceived` → URL 包含 `/webcast/room/enter/` → `roomEnterStatus = 403`。

- 请求由官方直播页发出；中继只观察，不发送进入请求、不伪造签名、不重放 Cookie。
- 登录与采集共用 `<data>/browser/tiktok/account` 专用 profile；采集在同一浏览器中新建/复用 tab。
- 旧 `waitForReady()` 见到 403 立即返回 `loginRequired`，适配器抛 `TIKTOK_LOGIN_REQUIRED`，登录被标为 `refused`。
- 该判断没有服务端证据：Cookie 仍可能存在，事件 WebSocket 可能仍工作。

旧 `decodeFramePayload()` 只尝试 `decodeWebcastResponse()`。当前 web 播放器帧是 `PushFrame`：field 6 `payloadEncoding='pb'`、field 7 `payloadType='msg'`、field 8 是 gzip 事件批次。把 PushFrame 当批次解析时 field 1 不是消息列表，结果恒为 0。旧测试直接构造 `webcastResponse()`，未覆盖真实信封。

证据：`tests/unit/tiktok-ui.test.mjs`（PushFrame 解码）、`tests/integration/tiktok-session.test.mjs`（PushFrame→SQLite、403 无事件/有事件）、`tests/unit/tiktok-browser-relay.test.mjs`（运行中 403、浏览器关闭重连）。

## 2. 浏览器中继可行性

数据来源：页面级 CDP 读取官方页面自身收到的 `Network.webSocketFrameReceived`，解 PushFrame → gzip 批次 → `mapTikTokMessage` → `EventIngest` → SQLite。不是本地代理，不是 Cookie 重新构造独立请求，不发送聊天/礼物/进入房间帧。

前提与限制：

- 官方页面必须在专用 profile 中正常加载并建立自己的事件 WebSocket。
- WebSocket 必须在页面 target 内；若在 worker/iframe，当前实现看不到。
- `room/enter` 403 不必然阻断事件 socket；若没有帧，宽限后必须报不可用，不能显示正常。
- 没有历史回补/cursor；断线重连会丢消息。
- 平台改协议/帧格式/页面实现会使其失效；不伪造身份、不破解签名、不绕过访问控制。

结论：代码层现在能正确解析当前 PushFrame，并且不再因单个 403 丢弃真实帧；但**没有真实登录浏览器证据**证明页面自身 WebSocket 会持续投递。不能宣称已通过真实平台验收，也不能再把本次 403 直接写成登录失效/永久不可用。下一步必须人工在普通 Windows 桌面验证；若仍无帧，再评估本地 unsigned 方案。

## 3. 免费本地方案调查（仅研究）

| 项目 | 许可证 | 维护 | 结论 |
| --- | --- | --- | --- |
| `talkaboutdesign/tiklive` | MIT | 2026-10 创建，7 stars，活跃 | 匿名 `ttwid` + webcast WS，本地 Node/Bun；README 明确非官方 web 协议；探针验证技术可用 |
| `nglmercer/wshook-extension` | MIT | 4 stars，活跃 | 浏览器扩展拦截页面 WS；不适合 EXE 内置 |
| `isaackogan/TikTokLive` | AGPL-3.0 | 1654 stars，活跃 | Python，通常依赖第三方签名；AGPL 与零依赖 EXE 不匹配 |
| `frankvHoof93/TikTokLiveSharp` | NOASSERTION | 217 stars，41 open issues | C#，不匹配 Node SEA |
| TikTok 官方 API | — | — | 无公开 LIVE 聊天/礼物 API |

只读探针（`tests/.tmp`，不提交）：

```text
@freefirelatino / room 7708359339993008916
35 s: frames=82, msgFrames=78, chat=469, gift=19, enterResp=1, other=214
无登录、无签名服务、仅匿名 ttwid
```

证明事件通道本身可用，但不等于浏览器中继验收。后续重复运行时 TikTok 未再签发 `ttwid`，说明平台侧存在限流/变化；只记录首次成功证据。

未接入原因：使用 TikTok 非公开 web 协议，按 AGENTS §10，改用未公开接口需要开发者明确的产品/合规决策；不得默认启用，也不得描述为官方 API。

## 4. 已修复代码问题

- `messages.mjs`：新增 `decodePushFrame`；`browser-relay.mjs` 先解 PushFrame 再解批次。
- `browser-relay.mjs`：403 宽限、真实帧优先、`roomAccess`/`captureState`、运行中 403、停止清理、浏览器关闭重连。
- `browser-login.mjs`：403 不再改登录；`markCaptureRefused`/`Unconfirmed`/`Stopped`；重新登录清除 `expired`。
- `service.mjs`：`lastCapture`、`captureSource`、`TIKTOK_ROOM_REFUSED`、登录过期阻止启动、通道切换不显示旧失败。
- `live.js` + 三语：五项状态、记录中失败/未确认、直播间拒绝说明、补 `tiktokCaptureStateIdle` 等键。
- `monitoring/detectors/tiktok.mjs`：`TIKTOK_ROOM_REFUSED` → `BLOCKED`。

## 5. 测试与 EXE

- 定向 TikTok：103 passed / 0 failed / 0 skipped。
- 全量：1050 passed / 0 failed / 0 skipped。
- `verify-exe`：10/10；`verify-tiktok-exe @aljazeeraenglish`：23/23（真实 6 chat / 3 可识别观众；自动监听 6；SQLite/AI/重启）。
- `verify-tiktok-browser-login`：1/9 passed，0 failed，8 BLOCKED。
- 新 EXE：`D:\LiveMemory\dist\LiveMemory.exe`，Build ID `a463acfad051`，commit `ea950c0`，`97,893,888` B，SHA-256 `fecf18ce7cb858770dbffda7d08e3373ecb63a613a1f29c74a8f11e8d5a84b77`，builtAt `2026-11-16T02:05:12.347Z`，RT_MANIFEST `requireAdministrator`。
- 未合并 main、未 Push、未 Tag、未 Release。