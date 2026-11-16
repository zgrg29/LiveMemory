# 2026-11-15 TIKTOK-M4：浏览器中继真实 403 调查与完整链路审计

## 0. 本轮结论（先看这里）

- 真实 Windows EXE 的 HTTP 403 来源已定位：官方直播页自身发出的
  `POST /webcast/room/enter/`，被 CDP `Network.responseReceived` 观察到。
  不是本地中继构造的请求，也不是本地映射的错误。
- 旧实现的产品失败由三个本地缺陷叠加：
  1. 403 被当成「登录失效」并立即中止，即使事件 WebSocket 仍可能工作；
  2. WebSocket `PushFrame` 被直接当作 `WebcastResponse` 解析，真实帧恒为 0 条事件；
  3. 登录 / 直播间访问 / 采集连接 / 真实事件 / 开始记录互相混用，失败后 UI 退回原始 i18n 键。
- 已修复上述三点，并补齐回归测试、三语键、监控映射。
- **真实登录后的浏览器中继端到端投递仍未验证（BLOCKED）**：DSH 作业对象终止 Chromium，
  `verify-tiktok-browser-login` 为 1/9 passed、0 failed、8 BLOCKED。不得写成 PASS。
- 免费本地方案仅做研究：`talkaboutdesign/tiklive`（MIT）同类匿名 webcast 协议，在同一台机器
  35 秒收到 469 chat / 19 gift；**未接入产品**，因为它是 TikTok 非公开 web 协议，需产品/合规决策。

## 1. 403 调查

### 1.1 代码路径

`BrowserSession.#onEvent()` → `Network.responseReceived` → URL 包含
`/webcast/room/enter/` → `roomEnterStatus = 403`。

- 请求由官方直播页发出；中继只观察，不发送房间进入请求、不伪造签名、不重放 Cookie。
- 登录与采集共用 `<data>/browser/tiktok/account` 专用 profile；采集在同一浏览器中新建/复用 tab。
- 403 后旧 `waitForReady()` 立即返回 `loginRequired`，`TikTokBrowserAdapter.start()` 抛
  `TIKTOK_LOGIN_REQUIRED`，`TikTokBrowserLogin` 把状态改为 `refused`。
- 该判断没有服务端证据：Cookie 仍可能存在，事件 WebSocket 可能仍工作。

### 1.2 403 不是唯一原因

旧 `decodeFramePayload()` 只尝试 `decodeWebcastResponse()`。当前 TikTok web 播放器的二进制帧是
`PushFrame`：

```text
PushFrame: 1 seqId, 2 logId, 3 service, 4 method, 5 headers,
           6 payloadEncoding='pb', 7 payloadType='msg', 8 payload (gzip 批次)
```

事件批次（messages field 1）在 field 8 内。把 PushFrame 当批次解析时 field 1 不是 length-delimited
的消息列表，结果恒为 0。旧测试的 `webcastResponse()` 直接构造批次，未覆盖真实信封，掩盖了缺陷。

### 1.3 可复现证据

- `tests/unit/tiktok-ui.test.mjs`：真实 PushFrame（gzip/未压缩/控制帧）→ `decodeFramePayload`。
- `tests/integration/tiktok-session.test.mjs`：PushFrame → SQLite，保留 `tiktok:<uid>`、原文、msgId。
- `tests/unit/tiktok-browser-relay.test.mjs`：运行中 403 无事件 → 宽限后 `platform_refused`；
  403 后收到真实帧 → 正常 + 警告；浏览器关闭 → 同 recording 重连。
- `tests/integration/tiktok-session.test.mjs`：403 无事件 → `TIKTOK_ROOM_REFUSED`、无 recording；
  403 + 事件 → 正常采集、登录仍 `logged_in`。

## 2. 浏览器中继可行性

### 2.1 数据来源

`browser` 传输使用页面级 CDP：

1. 启动/复用专用 Chrome/Edge profile；
2. 打开官方 `https://www.tiktok.com/@<handle>/live`；
3. `Network.enable`；
4. 读取官方页面自身收到的 `Network.webSocketFrameReceived`；
5. 解 PushFrame → gzip 批次 → `mapTikTokMessage` → `EventIngest` → SQLite。

它不是本地代理，不是 Cookie 重新构造独立采集请求，也不发送聊天/礼物/进入房间帧。这是当前实现中
最贴近「浏览器已授权访问」的方式。

### 2.2 技术前提与限制

- 官方页面必须在专用 profile 中正常加载并建立自己的事件 WebSocket。
- WebSocket 必须在页面 target 内，CDP 才能看到 `Network.webSocketFrameReceived`；若在 worker/iframe，
  当前实现看不到。
- 页面可能因地区/账号/房间/风控拒绝 `room/enter`；该 HTTP 403 不必然阻断事件 socket，但若没有帧，
  当前实现必须在宽限后报不可用，不能显示正常。
- 没有历史回补/cursor；断线重连会丢消息（与 M2 的 `possibleMissed` 边界一致）。
- 平台改协议、改帧格式或改页面实现会使其失效；不伪造身份、不破解签名、不绕过访问控制。

### 2.3 结论

代码层现在能正确解析当前 web 播放器的 PushFrame，并且不再因单个 `room/enter` 403 丢弃真实帧；
但**没有真实登录浏览器证据**证明页面自身 WebSocket 会持续投递。因此：

- 不能宣称「浏览器中继已通过真实平台验收」；
- 也不能再把本次 403 直接写成「登录失效 / 浏览器中继永久不可用」；
- 下一步必须人工在普通 Windows 桌面验证；若仍无帧，再评估本地 unsigned 方案。

## 3. 免费本地方案调查（仅研究）

| 项目 | 许可证 | 维护 | 结论 |
| --- | --- | --- | --- |
| `talkaboutdesign/tiklive` | MIT | 2026-10 创建，7 stars，活跃 | 匿名 `ttwid` + webcast WS，本地 Node/Bun；README 明确「非官方 web 协议」；技术可用性由探针验证 |
| `nglmercer/wshook-extension` | MIT | 4 stars，活跃 | 浏览器扩展拦截页面 WS；需安装扩展，不适合 EXE 内置 |
| `isaackogan/TikTokLive` | AGPL-3.0 | 1654 stars，活跃 | Python，通常依赖第三方签名；AGPL 与当前零依赖 EXE 不匹配 |
| `frankvHoof93/TikTokLiveSharp` | NOASSERTION | 217 stars，41 open issues | C#，不匹配 Node SEA；未采用 |
| TikTok 官方 API | — | — | 无公开 LIVE 聊天/礼物 API；Research API 不覆盖实时聊天 |

只读探针（`tests/.tmp`，不提交）结果：

```text
@freefirelatino / room 7708359339993008916
35 s: frames=82, msgFrames=78, chat=469, gift=19, enterResp=1, other=214
无登录、无签名服务、仅匿名 ttwid
```

该探针证明事件通道本身可用，但不等于浏览器中继验收。后续重复运行时 TikTok 未再签发 `ttwid`，
说明平台侧存在限流/变化；只记录首次成功证据。

**未接入原因**：使用 TikTok 非公开 web 协议，按 AGENTS §10，改用未公开接口需要开发者明确的
产品/合规决策；不得默认启用，也不得描述为官方 API。

## 4. 已修复代码问题

- `messages.mjs`：新增 `decodePushFrame`；`browser-relay.mjs` 先解 PushFrame 再解批次。
- `browser-relay.mjs`：403 宽限、真实帧优先、`roomAccess`/`captureState`、运行中 403 处理、
  停止清理、浏览器关闭重连。
- `browser-login.mjs`：403 不再改登录；`markCaptureRefused`/`Unconfirmed`/`Stopped`；
  重新登录清除 `expired`。
- `service.mjs`：`lastCapture`、`captureSource`、`TIKTOK_ROOM_REFUSED`、登录过期阻止启动、
  通道切换不显示旧失败。
- `live.js` + 三语：五项状态、记录中失败/未确认、直播间拒绝说明、补 `tiktokCaptureStateIdle` 等键。
- `monitoring/detectors/tiktok.mjs`：`TIKTOK_ROOM_REFUSED` → `BLOCKED`。

## 5. 测试与 EXE

- 定向 TikTok：102 passed / 0 failed / 0 skipped。
- 全量：1050 passed / 0 failed / 0 skipped（472,033.27 ms）。
- `verify-tiktok-browser-login`：1/9 passed，0 failed，8 BLOCKED。
- 新 EXE：构建后填写（路径、Build ID、SHA-256、commit）。
- 未合并 main、未 Push、未 Tag、未 Release。
