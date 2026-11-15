# 2026-11-15 TIKTOK-M3：浏览器中继「TikTok 采集尚未配置」修复

分支：`feature/tiktok`（未合并 main、未 Push、未 Tag、未 Release）
前置：`14752a2 docs: finalize TikTok M2 EXE and test evidence`

## 1. 真实验收现象

普通 Windows 桌面 EXE，TikTok → 「浏览器中继（实验性，需要登录）」：

1. 官方登录页打开，用户完成登录，LiveMemory 显示「已登录」。
2. 「验证直播连接」没有明确成功/失败反馈。
3. 关闭登录窗口后仍显示「已登录」。
4. `https://www.tiktok.com/@ff.esports.id/live` 检查直播间成功（主播、room id、直播中）。
5. 点击「开始记录」提示 **「TikTok 采集尚未配置。」**

## 2. 根因（代码级，已复现）

### 2.1 主因：探测了不存在的 `relay.start`

`src/platforms/tiktok/service.mjs#transport()` 旧代码：

```js
const browserAvailable = Boolean(this.browserRelay?.start);
```

`TikTokBrowserRelay`（`src/platforms/tiktok/browser-relay.mjs`）只提供
`createAdapter()`、`stop()`、`closeBrowser()`，**没有 `start()`**。

因此选择 `browser` 时：

- `browserAvailable = false`
- `transport.active = null`
- `connect()` 走到 `#startWithRoom()` 的最后一个分支，抛出
  `TikTokError(TIKTOK_ERRORS.NOT_CONFIGURED)`（503），
  i18n 键 `errors.tiktokNotConfigured` = “TikTok 采集尚未配置。”

这与登录和房间检查完全无关：即使用户已经登录且 room check 成功，
`active` 仍为 `null`。实际复现：

```text
transport: {requested:"browser", active:null, browserAvailable:false}
connect error: TIKTOK_NOT_CONFIGURED / errors.tiktokNotConfigured / 503
```

测试中的假 relay 恰好提供了 `start()`，掩盖了真实类缺少该成员的问题。

### 2.2 次因：浏览器中继丢弃全部礼物事件

`TikTokBrowserAdapter.#handleMessage()` 旧代码只接受 `mapped.kind === 'event'`，
而 `mapTikTokMessage()` 对礼物返回 `{kind:'gift', final, event}`。
所以浏览器中继即使连上，礼物也会被当成忽略消息，不进入 `EventIngest`。

已修复为与签名通道一致：

- 以 `groupKey` 缓存连送；
- `repeatEnd=1` 时写最终态；
- 10 秒无更新时按最后状态冲刷；
- 只写一条 `gift`，钻石只进 `amount_display`。

## 3. 修复内容

### 3.1 通道选择与错误分类

- `transport()` 改用 `Boolean(this.browserRelay?.createAdapter)`。
- 显式 `browser` 不再依赖 signer 是否可用。
- 缺少中继 → `TIKTOK_BROWSER_UNAVAILABLE`；缺少签名通道 →
  `TIKTOK_SIGNER_UNAVAILABLE`；只有“确实没有任何通道”才保留
  `TIKTOK_NOT_CONFIGURED`。
- 新增 `browserRelayAvailable`、`profileOwned`、`captureActive`、
  `revalidationRequired` 状态字段。

### 3.2 登录状态不再只信旧标记

- 持久化 `logged_in` 只作为提示；只要专用 profile 仍存在，允许中继实际尝试。
- 中继真实拿到 `room/enter` 200 / 事件 → `markCaptureVerified()`：
  `logged_in`、`capture=events_received|connected_no_events`。
- 中继真实 403 → `markCaptureLoginRequired()`：
  `refused`、`capture=platform_refused`、`reason=room_enter_403`。
- 浏览器启动失败 → `markCaptureFailed()`，保留登录身份但记录准确原因。
- `revalidationRequired` 在启动时从磁盘恢复为 `true`，真实验证后清除。

### 3.3 关闭登录窗口语义

- 关闭窗口不是退出登录：`logged_in` 保留，记录 `loginWindowClosedAt`，
  标记 `revalidationRequired=true`。
- 正在采集时关闭登录窗口：只关闭登录页 tab，**不终止专用浏览器进程**，
  capture 继续运行；UI 明确显示「登录页已关闭；采集中继仍在运行」。
- 正在采集时「退出登录」被拒绝（`TIKTOK_CAPTURE_ACTIVE`），
  不会删除 profile 或中断记录。

### 3.4 「验证直播连接」反馈

- 没有填写直播间时返回 `capture.state=needs_room`、
  `reason=unique_id_required`，不再把登录状态改成 `error`。
- 验证结果新增 `reason`、`eventsReceived`、`roomEnterStatus`、
  `timedOut`、`uniqueId`、`liveUrl`、`checkedAt`。
- UI 在按钮下方显示结果与具体原因，并增加五项独立状态：
  登录 / 直播间识别 / 采集连接 / 真实事件 / 开始记录。
- 失败原因（`room_enter_403`、`no_session_cookie`、`browser_did_not_start`、
  `browser_closed`、`navigate_failed` 等）三语显示，不再只给泛化错误。
- 切换通道会清除旧的验证结果；检查另一个直播间时旧房间结果不会串到新房间。

### 3.5 修改文件

```text
scripts/verify-tiktok-exe.mjs
src/platforms/tiktok/browser-login.mjs
src/platforms/tiktok/browser-relay.mjs
src/platforms/tiktok/service.mjs
src/web/i18n/en.json
src/web/i18n/ja.json
src/web/i18n/zh-CN.json
src/web/js/pages/live.js
src/web/styles/pages.css
tests/integration/tiktok-session.test.mjs
tests/unit/tiktok-browser-login.test.mjs
tests/unit/tiktok-ui.test.mjs
```

## 4. 自动化测试

### 4.1 定向测试

```text
node --test --test-isolation=none "tests/unit/tiktok-*.test.mjs" "tests/integration/tiktok-*.test.mjs"
90 passed / 0 failed / 0 skipped
```

新增 9 项：

- 真实 `TikTokBrowserRelay` 必须被识别为可用（`active=browser`）；
- 浏览器中继真实帧 → SQLite（原文、昵称、`tiktok:777`、msgId、时间、礼物）；
- 浏览器中继连送合并为一条最终礼物；
- 旧 `logged_in` + 真实 403 → `TIKTOK_LOGIN_REQUIRED` + 登录状态 `refused`；
- 显式 browser 不依赖 signer；
- 无直播间验证返回 `needs_room`，不污染登录；
- 关闭登录窗口保留登录并标记需重新验证；
- 采集中关闭登录页不终止浏览器；
- 采集中拒绝退出登录；
- capture 证据回写登录状态（`markCaptureVerified` / `markCaptureLoginRequired`）。

### 4.2 全量回归

```text
node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"
1037 passed / 0 failed / 0 skipped（504,497.50 ms，2026-11-15）
```

测试数从 1028 增至 1037，全部为新增行为测试，没有放宽既有断言。

## 5. Windows EXE

| 项目 | 值 |
| --- | --- |
| 文件 | `D:\LiveMemory\dist\LiveMemory.exe` |
| Build ID | `e11f4008b9e3` |
| source hash | `e11f4008b9e3c88dc19701d0a3aab986ba4a45af4737fb7279d28e4fff8bd5b7` |
| commit（构建时 HEAD） | `1b9a38bf69ddc56e308a5fab10e2bc931af9a732` |
| 大小 / SHA-256 | `97,867,776` bytes / `8ee91aa8db4e08f77dfdb030dc95d12096341271fbb1efd7fa1981b0ed472d88` |
| builtAt | `2026-11-15T14:33:50.564Z` |
| 资源 / 模块 | 229 files / 53 required modules |
| RT_MANIFEST | **`requireAdministrator`** |

### 5.1 `verify-exe`：10/10

启动、重启、硬杀恢复、端口顺延、单实例、不可写目录、异目录、解压复用、CLI 三语全部通过。

### 5.2 `verify-tiktok-exe`：23/23

新增两项打包 EXE 级回归：

```text
PASS  the packaged EXE recognizes the selected browser relay as an available transport
      requested browser, browserAvailable true, active browser
PASS  switching back to the signing transport takes effect without a restart
      active signer
```

真实 TikTok 结果：

| 检查 | 结果 |
| --- | --- |
| 房间 | `aljazeeraenglish` / room `7706695538414062349` / 直播中 / 主播稳定 ID `7074562477175424046` |
| 真实聊天 | 6 条；6/6 `tiktok:<user.id>`；5 个唯一身份；6/6 昵称与原文 |
| 停止 | `ended` |
| 自动监听 | 创建目标 → check → recording → 6 条真实事件 → 删除目标 |
| SQLite | 6 events；`user_id` 6/6、`external_id` 6/6、`content` 6/6 |
| 重启 | 同 Build ID；session 保留；messages 6 |
| AI 读取 | `GET /api/ai/sessions/:id/report` 200 |
| 长期画像 | `TikTok viewers 9` |
| 四平台 | Bilibili 200、YouTube 200/web、Twitch 200/anonymous-irc、Douyin 200 |

## 6. 真实浏览器验收：BLOCKED（未通过，不得写成通过）

`node scripts/verify-tiktok-browser-login.mjs`：

```text
RESULT 1/9 passed, 0 failed, 8 blocked
```

原因：DSH 沙箱把 Node 放在 Job Object 中，Chromium 子进程在写出 DevTools 端口前被终止
（`TIKTOK_BROWSER_FAILED / launch_failed`）。这不是普通 Windows 桌面的结论。

因此以下项目必须由开发者人工验收：

- 真实 TikTok 登录后浏览器中继能否收到真实弹幕；
- 真实礼物/连送（浏览器中继）；
- 关闭登录窗口后重新打开并复用 profile；
- 关闭窗口后点击「开始记录」是否自动重开专用窗口并采集。

代码级与 SQLite 级证据：浏览器中继的合成帧已完整覆盖 chat/gift 的解析、去重、
稳定 UID、消息 ID、事件时间、SQLite 与登录状态回写；但**不能替代真实登录后的平台投递证据**。

## 7. 人工验收步骤（普通 Windows 桌面）

1. 双击 `D:\LiveMemory\dist\LiveMemory.exe`，允许 UAC。
2. 直播记录 → TikTok → 采集通道改为「浏览器中继（实验性，需要登录）」。
3. 点击「打开 TikTok 登录」，确认只有一个 LiveMemory 专用窗口；在官方页完成登录。
4. 输入真实正在直播的链接，点击「检查直播间」。
5. 点击「验证直播连接」：
   - 必须显示「已收到真实事件」或「已连接，尚未收到事件」；
   - 失败时必须显示具体原因（如 `room_enter_403` / 无有效 Cookie / 浏览器启动失败）。
6. 点击「开始记录」：
   - 成功：状态为正常采集/等待第一条事件，SQLite 出现真实事件；
   - 失败：不得再出现「TikTok 采集尚未配置」；应为需要登录、浏览器不可用或平台拒绝等准确原因。
7. 点击「关闭登录窗口」，确认采集中继仍运行或明确提示；再次开始记录应能复用同一个专用 profile。
8. 停止记录后再测试「退出 TikTok 登录」。

## 8. 边界

- 免费签名通道仍是第三方云服务，匿名约 30 次/小时；本轮未改其预算。
- 浏览器中继仍为实验性；真实登录后的平台投递未在本环境验证。
- 未改数据库 schema（16）、AI 结果 Schema、提示词、其他平台适配器。
- 未新增运行时依赖。
- 自动化无法点击真实 UAC；EXE 的 Manifest 单独断言，功能场景使用同一二进制的 asInvoker 测试副本。
