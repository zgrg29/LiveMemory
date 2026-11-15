# 交接文档（HANDOFF）

本轮：2026-11-15 · TIKTOK-M1：抖音合并 + TikTok 双传输接入 · **等待人工验收**

> 已按开发者授权把 `feature/douyin` 本地合并到 `main`（`410bfc3`）；从最新 `main` 创建 `feature/tiktok`，
> 完成 TikTok 房间/聊天/礼物解析、统一入库、监控、三语 UI 与 Windows EXE。
> **未合并 `feature/tiktok` 到 main、未 Push、未 Tag、未 Release。**
> 可行性：`docs/TIKTOK_FEASIBILITY_2026-11.md`；状态：`docs/STATUS.md` §0.38；日志：`log/2026-11-15-tiktok-live.md`。

## 0. 本轮（TIKTOK-M1）

### 0.1 做了什么

1. **抖音合并**：本地合并 `feature/douyin` → `main`，合并提交 **`410bfc3`**（父 `d5e9a7c` + `e3cf6e7`）；
   工作区干净；合并后全量 **947 passed**；四平台真实回归（Bilibili 3/3、YouTube 55/55、Twitch 13/13、抖音 3/3）。
2. **分支**：从 `410bfc3` 创建 `feature/tiktok`；所有 TikTok 开发都在该分支。
3. **可行性**：读 TTLC 2.5.0 / TikTokLive 6.x 源码、依赖、许可证与近期 Issue；真实只读探测确认：
   房间信息/开播/主播稳定 ID/礼物目录可完全本地免费取得；官方网站在匿名状态 `room/enter` 返回 403；
   未登录直连推送 WS 被拒；免费社区签名通道可取得真实聊天（6/6 带 `user.id` 与 `msgId`）。
4. **传输 A（默认）**：`signer.mjs` 免费社区签名通道（无 Key、无付费、不要求 Business）；
   15 秒轮询（平台突发上限 5 次/分钟）、cursor 续传、429 退避。
5. **传输 B（实验）**：`browser-relay.mjs` 本机 Chrome/Edge 专用资料目录 + CDP + WS 帧解析；
   匿名 `room/enter 403` → `TIKTOK_LOGIN_REQUIRED`，不伪造事件；**登录后未验证**。
6. **统一管线**：chat/gift/membership → `EventIngest`；`tiktok:<user.id>` 稳定身份；
   `msgId` 去重；连送最终态 + 超时冲刷；钻石只写 `amount_display`，`amount_minor=null`。
7. **监控/多房间**：`TikTokRoomDetector`；周期键 `tiktok:<handle>:<roomId>`；两房间独立 session 测试。
8. **UI**：直播页 TikTok Tab、房间检查、传输选择（auto/signer/browser）、自动监听、能力边界、30 天保留。
9. **测试**：新增 56 项；全量 **1003 passed / 0 failed / 0 skipped（326,436 ms）**。
10. **EXE**：Build ID `812c0d54f622` / SHA-256 `bb689de6…` / `97,718,784` B / `requireAdministrator`；
    `verify-tiktok-exe` **20/20**（真实 TikTok + 自动监听 + 重启 + AI + 四平台状态）。

### 0.2 结果

| 项目 | 结果 |
| --- | --- |
| 抖音合并 | `main` = `410bfc3`；合并后全量 947 passed；四平台真实回归通过 |
| 分支 | `feature/tiktok`（从 `410bfc3`） |
| 房间信息 | 真实：room `7706695538414062349`、status 2、主播稳定 ID `7074562477175424046` |
| 礼物目录 | 真实：809 个礼物（名称 + 钻石展示价值） |
| 真实聊天 | 源码服务器 6 条 / EXE 6 条；6/6 `tiktok:<id>` + `msgId` + 原文 |
| 礼物事件 | **真实未观测**；解析/连送/去重有自动化测试 |
| 浏览器中继 | 实现完成；匿名 403 实测；**登录后未验证（无账号）** |
| 全量测试 | **1003 passed / 0 failed / 0 skipped（326,436 ms）** |
| 正式 EXE | `812c0d54f622` / `bb689de6…` / requireAdministrator / 226 assets / 50 modules |
| EXE TikTok | **20/20** |
| main | **未合并 TikTok、未 Push、未 Tag、未 Release** |

### 0.3 下一轮必须先做 / 不要做

1. **人工验收**：双击 `D:\LiveMemory\dist\LiveMemory.exe`（UAC 允许），进入直播页 → TikTok Tab →
   输入 `https://www.tiktok.com/@aljazeeraenglish/live` 或其它正在直播的频道 → 检查直播间 →
   开始记录 → 确认弹幕、昵称、`tiktok:<id>`、停止、重启后数据仍在。
2. **礼物验收**：找一个有送礼的直播间，确认礼物事件、连送只计一次、金额显示为钻石展示值而不是 0 元。
3. **浏览器中继**：若要用纯本地方案，需要提供 TikTok 账号并在专用浏览器窗口登录；未登录时如实显示“需要登录”。
4. **不要**把免费社区签名通道写成“官方 API”或“完全本地”；它是第三方云服务，无 Key、无付费、可能改版。
5. **不要**把礼物的钻石展示价值换算成主播收入；不要用昵称当身份；不要绕过 `room/enter 403`。
6. **未获明确授权不要合并 main、Push、Tag、Release。**

### 0.4 边界与提交

- 真实 TikTok 只读公开直播间；未登录、未付费、未保存/展示正文到仓库；测试均用 `tests/.tmp` 隔离目录。
- 真实礼物/连送/订阅、登录后浏览器中继、真实断网/下播、多房间并发、干净 Windows 账户仍未验证。
- 本轮代码与文档提交见 STATUS §0.38.9；提交身份匿名；**未 Push / 未 Tag / 未发布**。

## 0-A 上一轮（DOUYIN-SINGLE-WINDOW）

### 0.1 做了什么（DOUYIN-SINGLE-WINDOW）

1. **复现与定位**：真实 Chrome 154 + CDP `Browser.getWindowForTarget` 计数；真实 EXE 日志显示直接
   `spawn` 退出 0 无 DevTools，随后 PowerShell 回退再启动一次。
2. **主因**：Windows 上直接 `child_process.spawn` 从提权 SEA 启动 Chrome 会退出 0 且不写 DevTools 端口，
   但可能已开窗；PowerShell 回退又开一个。另有 `start()` 在 `running` 赋值前无并发锁、孤儿进程无法清理。
3. **修复**：**Windows 只走一次 PowerShell `Start-Process`**；启动前只清理专用 Profile 的孤儿 Chrome；
   同步 `startPromise` 锁 + `Page.bringToFront`；启动后立即写 PID 并复用同 Profile 窗口；关闭串行化；
   移除 `--new-window`；前端 `douyinBrowserStarting` 防重复请求。
4. **验证**：真实 Chrome 12/12（单次 1 窗口、再次点击只聚焦、并发双击 1 窗口、已有窗口 reuse 同 port 1 窗口）。
5. **测试**：新增 3 项并发/复用测试；全量 **947 passed / 0 failed / 0 skipped（292,737 ms）**。
6. **EXE**：Build ID `d37c8f262dc4` / commit `75c574c` / SHA-256 `c3b1fa8b…` / `97,591,296` B /
   requireAdministrator；`verify-exe` **10/10**；`verify-douyin-exe` **25/27**。

### 0.2 结果

| 项目 | 结果 |
| --- | --- |
| 单次点击 | 真实 Chrome 1 target / 1 window |
| 快速双击 | 1 次 launch / 1 window |
| 已打开时再次点击 | 0 次新 launch / focus +1 / 1 window |
| 已有专用窗口 | `kind=reuse` / 同 port / 1 window |
| 全量测试 | 947 passed / 0 failed / 0 skipped |
| EXE | `d37c8f262dc4` / `75c574c` / `c3b1fa8b…` / requireAdministrator |
| EXE 内窗口数量 | **沙箱无法自动验证**；需普通桌面人工双击 |
| main | **未合并、未 Push、未 Tag、未 Release** |

### 0.3 下一轮必须先做 / 不要做

1. **人工复验**：普通 Windows 桌面双击新 EXE，点击一次扫码登录，确认只有 1 个 Chrome/Edge 窗口；
   再快速点击一次，确认只聚焦、不新开；关闭窗口后重新登录应重新打开 1 个。
2. 保持现有扫码/官方验证/Cookie 加密/礼物采集机制，不要回退到手动 Cookie 唯一方案。
3. 若仍出现两个窗口，记录两个窗口的 PID/Parent PID、启动参数、CDP Target ID，再排查；不要靠强制关闭
   第二个窗口掩盖问题。
4. 不要把「模块级真实 Chrome 12/12」写成「EXE 内窗口已验证」；EXE 浏览器启动在 DSH 沙箱被作业对象阻止。
5. **未获明确授权不要合并 main、Push、Tag、Release。**

### 0.4 边界与提交

- 代码提交：`75c574c0ec1824603559de88b37669466abd33ff`（`fix: prevent duplicate Douyin login browser windows`）。
- 真实 Chrome 窗口计数 12/12；EXE 内窗口数量待普通桌面人工验收；真实手机扫码需复验。
- 提交身份匿名；**未 Push / 未 Tag / 未发布**。

## 0-A 上一轮（DOUYIN-LOGIN-FIX）

### 0.1 做了什么

1. **技术调查**：逐一阅读 5 个项目的实际登录源码（VideoNote-MCP、douyin-mcp、douyin-parse、dousub、bytedance-nomark），
   确认纯 HTTP 扫码会被设备指纹/风控拒绝，真实浏览器官方页面可出码；记录许可证与可整合性。
2. **浏览器扫码**：新增 `browser-login.mjs`，启动本机 Chrome/Edge 的专用资料目录，打开官方
   `www.douyin.com/login_page`，通过 CDP 捕获官网 `get_qrcode` 二维码并在应用内显示；等待 `sessionid`；
   用页面内 profile 请求验证会话；不启用 headless/no-sandbox/stealth，不伪造签名。
3. **Cookie 验证**：区分格式错误/不完整/已过期/平台拒绝/网络异常/登录无效；只有平台确认才 `logged_in`，
   不确定时 `saved_unverified`；保存 `verified/verifiedAt/reason`；退出清除。
4. **教程**：Cookie 输入区下方新增中文/日文/英文 12 步教程（F12 → Network → 刷新 → 选请求 → Headers →
   Request Headers → Cookie → 复制 → 保存并验证），含 Firefox 差异、排查与安全说明。
5. **礼物分级**：UI 与 API 分开显示「扫码/浏览器登录」「登录会话有效」「直播采集连接」「真实礼物事件」；
   未观测写「尚未观测到」，不写成成功或失败。
6. **安全**：专用 profile 有 `.livememory-owned` 标记；不读取用户日常浏览器资料；Cookie 不进日志/备份/HTTP；
   退出删除加密存储与资料目录；所有新路由仍要求本地会话认证。
7. **测试**：全量 **944 passed / 0 failed / 0 skipped（298,824 ms，最终复跑）**；新增浏览器登录 10 项、服务 3 项、
   礼物阶梯 1 项，更新登录/Cookie 14 项与三语 UI/API 认证断言。
8. **EXE**：`a0bc7f9136df` / commit `6f7f0d6` / SHA-256 `48cc1227…` / `97,584,640` B / requireAdministrator。
9. **验证**：真实 Chrome 二维码捕获 **8/8**（未扫码）；EXE 验收 **25/27**（2 项浏览器启动被 DSH 沙箱作业对象阻止，教程资源在包内通过）；
   `verify-exe` **10/10**、`verify-twitch-exe` **20/20**。

### 0.2 结果

| 项目 | 结果 |
| --- | --- |
| 纯 HTTP 扫码 | 仍不可行：SSO 返回 HTML 指纹页，passport 返回 `4031` |
| 真实浏览器扫码 | 官方页 `error_code=0`，二维码 PNG + `is_frontier=true`；应用内可显示 |
| 真实手机扫码 | **0 次（无账号）**；不能给成功率 |
| Cookie 负向验证 | 格式/不完整 400；假会话 401；不保存为登录 |
| Cookie 正向验证 | **未验证**（需要账号） |
| 礼物 | 匿名 0；真实事件未观测；解析/合并/去重有自动化覆盖 |
| 全量测试 | 944 passed / 0 failed / 0 skipped |
| EXE | `a0bc7f9136df` / `48cc1227…` / 93.1 MB / requireAdministrator |
| EXE 登录 | 入口/状态/Cookie/教程/退出可用；浏览器启动在沙箱内被作业对象阻止，需人工验收 |
| main | **未合并、未 Push、未 Tag、未 Release** |

### 0.3 下一轮必须先做 / 不要做

1. **人工验收扫码**：在真实 Windows 桌面运行 `dist/LiveMemory.exe`，点击「扫码登录（浏览器）」，
   用抖音 App 扫码；确认应用内二维码、浏览器官方页、验证码/身份验证、登录后状态。
2. **人工验收 Cookie 正向**：若扫码不可用，按 12 步教程导入真实 Cookie，确认「登录有效」；
   再连接真实直播间，观察是否收到礼物。没有真实礼物时只能写「未观测」。
3. **不要把浏览器启动失败写成产品缺陷**：沙箱作业对象会终止 EXE 子进程中的 Chrome；用普通桌面重测。
4. **不要合并 main / Push / Tag / Release**，除非开发者明确授权。
5. **不要把「二维码捕获成功」写成「扫码登录成功」**；不要把「Cookie 已保存」写成「登录成功」。
6. 若平台改版导致二维码捕获失败，更新选择器/接口，保留真实错误，不伪造二维码。

### 0.4 边界与提交

- 代码提交：`6f7f0d65fd95838e489a0021180ea66e87dfd26e`（`fix: add browser-assisted Douyin QR login and cookie verification`）；
  提交身份匿名；**未 Push / 未 Tag / 未发布**。
- 真实手机扫码、真实 Cookie 正向、登录后礼物、干净 Windows 账户仍待人工验收。
- 临时数据目录均为 `tests/.tmp`；未读取用户日常浏览器配置。

## 0-A 上一轮（DOUYIN-M2M3）

### 0.1 做了什么

1. **Twitch 合并**：在 `main` 上创建合并提交 `d5e9a7c`（父 `21a5bf5` + `5bb0ad0`），无冲突；
   合并后全量 875 passed；未 Push/Tag/Release。
2. **分支**：从 `main`（`d5e9a7c`）创建 `feature/douyin`；所有抖音代码、测试、文档都在该分支。
3. **匿名采集**：公开页解析（`web_rid`/内部 `room_id`/`status` 2/4/标题/主播 id/secUid/昵称/在线数）、
   自研 protobuf、签名 WSS、gzip、心跳/ack、消息去重。
4. **身份与原文**：`user.id` → `douyin:<id>`；昵称只显示；`msgId` → `external_id`；Unicode/Emoji 原文保留。
5. **礼物**：`WebcastGiftMessage` 仅在 `repeatEnd=1` 写一条；连送按 groupId 合并；无金额礼物不记 0 元；
   钻石只写 `amount_display`，`amount_minor=null`、`value_kind=unknown`。
6. **登录**：受控扫码流程 + 本地 AES-GCM Cookie + 状态检查/过期提示/退出；平台风控阻止自动扫码时
   明确报 `DOUYIN_LOGIN_BLOCKED`，并提供显式本地 Cookie 备用入口（不上传）。
7. **监控/多房间**：`DouyinRoomDetector`；自动开播、两次离线确认、断线退避重连、独立 adapter/session。
8. **UI**：直播页抖音 Tab、房间检查、自动监听、登录/保留；64 个 `douyin` 键 × 三语。
9. **测试**：新增 48 项；全量结果见 §0.2。
10. **EXE**：buildId `0f848c77c2d6` / SHA-256 `cccfc6a6…` / requireAdministrator；
    `verify-douyin-exe` **17/17**（1 条礼物 NOT-OBSERVED），既有 EXE 矩阵见 §0.2。
11. **许可证**：vendored AGPL-3.0 签名组件独立目录 + 完整许可证 + 哈希核对；**主项目 MIT 未改**。

### 0.2 结果

| 项目 | 结果 |
| --- | --- |
| Twitch 合并 | `main` = `d5e9a7c`；合并后全量 875 passed |
| 分支 | `feature/douyin`（从 `d5e9a7c`） |
| 真实抖音聊天 | 源码路径 7 条（7/7 UID/昵称/消息 ID/CJK，0 重复）；正式 EXE 2 条（2/2 同上） |
| 真实礼物 | **0 条（匿名）**；真实事件未观测到 |
| 登录 | 风控阻止；未完成真实扫码；无伪造 |
| 全量测试 | 见 `docs/STATUS.md` §0.35.6（本轮新增 48 项） |
| 正式 EXE | `0f848c77c2d6` / `cccfc6a6…` / `requireAdministrator` / 93.0 MB |
| EXE Douyin | **17/17**（含真实连接、入库、停止、自动监听、重启、AI 读取、三平台状态） |
| main | **未合并抖音、未 Push、未 Tag、未 Release** |

### 0.3 下一轮必须先做 / 不要做

1. **先等待开发者人工验收**：按 `docs/STATUS.md` §0.35.5 的路径启动 EXE，确认抖音 Tab、输入
   `live.douyin.com/708764876300`、检查直播间、开始记录、查看弹幕/昵称/稳定 UID、停止、重启后数据仍在。
2. **未获明确授权前不要合并 `feature/douyin` 到 main、不要 Push/Tag/Release、不要删除分支。**
3. 若验收失败：在 `feature/douyin` 修复 → 重跑专项/全量 → **重新构建 EXE** → 再交付；不要用旧 EXE。
4. **不要把礼物写成“已真实验证”**：匿名 0 条；真实礼物、连送、付费留言均未观测到。
5. **不要把登录写成“已完成”**：扫码被风控阻止；不要绕过验证码/风控；不要声称登录后礼物已验证。
6. **不要改回 MIT-only 描述**：EXE 含 AGPL-3.0 组件，分发必须履行 AGPL 源码义务；主项目 `LICENSE` 未改。
7. 若要继续做登录/礼物，优先评估合规的浏览器授权或用户显式 Cookie 体验；必须先解决平台风控，
   并重新做真实事件验证。

### 0.4 边界与提交

- 真实抖音只读公开直播间；未登录、未付费、未保存/展示正文；测试均用 `tests/.tmp` 隔离目录。
- 真实礼物/连送、真实扫码登录、真实断网、真实“直播中→下播”、干净 Windows 账户仍未验证。
- 代码与文档提交：`c08cf6c3115b750c0108b54b9d0a19b6bdbae3ce`（`feat: add Douyin live integration`）；
  提交身份匿名；**未 Push / 未 Tag / 未发布**。

## 0-A 上一轮（TWITCH-M1）

> 本轮在 `feature/twitch` 完成 Twitch 匿名 IRC + 公开元数据接入，构建正式 EXE 并用真实公开频道验证。
> **已按开发者授权合并到 main（`d5e9a7c`）；未 Push、未创建 Tag、未发布 Release。** 完整交付说明：
> `docs/STATUS.md` §0.34；验收报告：`docs/ACCEPTANCE_TWITCH_M1.md`；平台细节：
> `docs/PLATFORM_INTEGRATIONS.md` §3A；日志：`log/2026-11-15-twitch-m1.md`。

## 0-B 上一轮（TWITCH-M1 原始交接）

### TWITCH-M1 原始交接内容

### 0.1 做了什么

1. **分支**：从 `main`（`21a5bf5`，含已确认的多平台调研提交）创建 `feature/twitch`；所有开发与提交在该分支。
2. **Twitch 接入**：`src/platforms/twitch/`（link/irc/mapper/client/adapter/service/errors）+
   `src/monitoring/detectors/twitch.mjs`；无新增运行时依赖。
3. **统一管线**：所有事件经 `EventIngest`；稳定身份 `twitch:<user-id>`；消息 ID 去重；两次离线确认下播；
   断线指数退避、15 次后 5 分钟低速探测；多频道独立 adapter/session。
4. **监控**：`MonitoringManager` 增加 Twitch detector（120 秒基准、90–180 秒抖动、`stream.id` 周期键）；
   `SessionManager`/数据库/AI 读模型复用，不新建 Twitch 专用画像。
5. **付费事件**：resub/订阅 → `membership`；赠订 `subgift` → `gift`（赠送者付款、接收者仅展示）；
   `submysterygift` 跳过防重复；Bits Cheer → `super_chat`（数量 + `amount_display`，金额未知）。
   **Bits/赠订真实事件未观测到**。
6. **UI**：直播页新增 Twitch 来源 Tab、频道检查、直播判断、自动监听、三语错误与能力边界说明；
   Bits 等未知金额显示 `amount_display`，不再显示 0.00。
7. **保留**：Twitch-only 30 天原文/表情/徽章/展示标签与过期昵称清理；独立审计键，不影响 YouTube。
8. **测试**：新增 47 项；全量 **875 passed / 0 failed / 0 skipped（253,002 ms）**。
9. **EXE**：buildId `a4bf602de264` / commit `7da0e0d` / SHA-256 `6a90f564…` / `96,828,416` B /
   `requireAdministrator`；`verify-twitch-exe` **20/20**，既有 EXE 矩阵全部通过。
10. **文档**：README、ARCHITECTURE、PLATFORM_INTEGRATIONS、STATUS、HANDOFF、ROADMAP、TEST_PLAN、
    CHANGELOG 与本日志。

### 0.2 结果

| 项目 | 结果 |
| --- | --- |
| 分支 / 代码提交 | `feature/twitch` / `7da0e0d1905a4f16d1a844f98102fb04c211a7d2` |
| 真实 Twitch 聊天 | 单频道 138 条；6 频道并发 418 条；418/418 有 User ID + 消息 ID；304 身份；1 条真实 resub |
| 真实 Bilibili 回归 | 房间 `6`（真实 `7734200`）20 秒 7 条聊天 / 7 个可识别观众 / 停止 `ended` |
| YouTube 回归 | 正式 EXE 生命周期回放 PASS（180s 断网恢复、同 session、去重、`platform_ended`） |
| 全量测试 | **875 passed / 0 failed / 0 skipped（253,002 ms）** |
| 正式 EXE | `a4bf602de264` / `6a90f564b0fd31adabd67b68a764bfe1800d402fd35fcabe3b601ec9d15e6d2d` / 96,828,416 B / requireAdministrator |
| EXE 矩阵 | Twitch 20/20、启动 10/10、认证 12/12、备份 13/13、说明 14/14、AI 16/16、YouTube 生命周期 PASS |
| main | **未合并、未 Push、未 Tag、未 Release** |

### 0.3 下一轮必须先做 / 不要做

1. **先等待开发者人工验收**：按 `docs/STATUS.md` §0.34.4 的 EXE 路径启动，或直接双击
   `D:\LiveMemory\dist\LiveMemory.exe`，确认 UAC、Twitch Tab、输入直播间、查看昵称/ID/弹幕、
   付费事件、停止、报告/画像。
2. **未获明确授权前不要合并 main、不要 Push、不要 Tag/Release、不要删除 `feature/twitch`。**
3. 若验收失败：在 `feature/twitch` 修复 → 重跑专项/全量 → **重新构建 EXE** → 再交付；不要用旧 EXE。
4. **不要把 Bits/赠订写成真实已支持**；真实事件仍未观测到。不要把 EventSub 写成已配置。
5. **不要为通过验收而放宽**金额/身份/去重规则；不要把 Tier/Bits/月数换算成收入。
6. 验收通过并获授权后合并 main，再检查合并结果、重跑必要测试、汇报最终 Git 状态；本轮不要求 Release。

### 0.4 边界与提交

- 真实 Twitch 只读公开频道，未登录、未付费、未保存/展示正文；未写用户真实数据目录（测试均用
  `tests/.tmp` 隔离目录）。
- 真实 UAC 双击/点击、真实拔网、真实“直播中→下播”、Bits/赠订真实事件、EventSub OAuth 仍未验证。
- 代码提交 `7da0e0d`；文档/构建记录为后续提交。提交身份匿名；**未 Push / 未 Tag / 未发布**。

## 0-A 上一轮（PLATFORM-RESEARCH）

完整报告：`docs/PLATFORM_RESEARCH_TIKTOK_TWITCH_DOUYIN.md`；状态：`docs/STATUS.md` §0.33；日志：`log/2026-11-15-platform-research.md`。

### 0.1 做了什么

1. **真实只读探测 Twitch**：匿名 IRC 5 个公开频道，45 秒 644 条 PRIVMSG，644/644 带 `user-id`/`display-name`/消息 `id`；USERNOTICE 有 resub/viewermilestone；`ROOMSTATE room-id` 可用；EventSub 无 Token 订阅 401；Bits 三次探测未观测到。
2. **真实只读探测抖音**：dyhub lightweight 匿名连接 `708764876300`，约 7 秒 175 条消息；45 秒 16 chat / 192 member / 25 like / 3 follow / 8 room / 0 gift；30 秒 13/13 chat 有 UID/昵称/secUid/消息 ID/CJK；公开页 `status=2/4`。
3. **TikTok 可行性验证**：TTLC 2.5.0/2.4.4 均被 Euler 签名端点拒绝（Business plan）；1.2.3 本地签名超时；页面 WAF 挑战；未绕过，未取得真实事件。
4. **官方 API 调查**：Twitch EventSub/IRC、TikTok 公开产品与 Webhooks、抖音官方直播玩法 FAQ；确认 TikTok 无公开 LIVE API、抖音官方小玩法不是通用采集、Twitch EventSub 需 OAuth 且 WebSocket 有 3 连接/300 订阅限制。
5. **开源方案调查**：TTLC/TikTokLive/dyhub/douyin-live-toolkit/BarrageGrab/DouyinLiveRecorder/cyber-xiaoya/Twurple/Twitch CLI 的许可证、维护、依赖、能力与 SEA 风险；重点标注 AGPL 与无许可证项目。
6. **工程兼容性设计**：canonical event 映射、连送最终态、赠订付款者/接收者、虚拟币不换算、监控 detector、30 天保留；未改 schema。
7. **文档**：新增本报告；更新 STATUS/HANDOFF/ROADMAP/PLATFORM_INTEGRATIONS/TEST_PLAN/日志。

### 0.2 结果

| 项目 | 结果 |
| --- | --- |
| Twitch 真实聊天 | 644 PRIVMSG / 45s；身份/消息 ID 644/644；0 重复（239 条样本） |
| Twitch 付费 | 订阅/续订/赠订 USERNOTICE 有；Bits 未观测 |
| 抖音真实聊天 | 13/13 chat 有 UID/昵称/secUid/消息 ID/CJK；0 重复 |
| 抖音礼物 | 匿名 0；需登录 Cookie；未验证 |
| TikTok | 未连接成功；付费签名 + AGPL + WAF |
| 代码/数据库 | **未修改** |
| 测试 | 未运行全量（无代码改动，不适用）；未新增测试 |
| 提交 | 仅文档；未 Push/Tag/Release |

### 0.3 下一轮必须先做 / 不要做

1. **先等用户确认**：是否按 Twitch 方案开始正式开发；抖音是否接受登录 Cookie 与 AGPL；TikTok 是否暂缓。
2. 若开始 Twitch：先做 T0/T1（纯解析 + IRC adapter + 单场真实频道），不要同时接抖音/TikTok。
3. **不要把匿名 IRC 写成官方 API**；不要把 Twitch Bits/TikTok 钻石/抖音钻石换算成人民币或美元；不要把抖音匿名 0 gift 写成“礼物已支持”。
4. **不要复制 AGPL 代码/脚本**进 MIT 的 LiveMemory；不要用无许可证项目；不要在未评审的情况下改 DB schema。
5. **不要引入 Euler 共享 Key 或强制云端采集**；TikTok 若做，只能实验性、用户自备 Key，并如实标注成本与漏消息风险。
6. 若做抖音，先明确 Cookie 存储/撤销/加密与 UI 风险提示；不得要求普通用户必须登录才能使用基础弹幕。
7. 任何新平台都必须走 `EventIngest`，不得单独建 AI 画像；不得改 Bilibili/YouTube 行为。

### 0.4 边界与提交

- 真实探测只读、公开直播间、未登录、未付费；临时目录已删除；未写用户数据目录。
- **未验证**：Twitch Bits/EventSub OAuth/真实断网/下播；抖音礼物/连送/重连/多房间/高频；TikTok 全部；三平台 SEA。
- 文档提交身份匿名；**未 Push / 未 Tag / 未发布**。

## 0-A 上一轮（RC0-GITHUB-RELEASE-PREP）

> 本轮只准备发布材料；**未改产品代码/版本、未 Push、未创建本地或远程 Tag、未创建 Release、未上传资产**。
> 发布包位于 `dist/`（gitignored），面向用户的 Notes 位于 `docs/release-notes/`。

完整报告：`docs/STATUS.md` §0.32；Release Notes：`docs/release-notes/v0.13.2-rc.0.md`；发布流程：`docs/RELEASE.md` §10；日志：`log/2026-11-15-rc0-release-prep.md`。

### 0.1 做了什么

1. **检查现状**：仓库此前没有任何 tag（本地与已知远程）；产品版本 `0.13.2`；`docs/RELEASE.md` 允许语义化版本 + 预发布后缀。
2. **命名**：建议 Tag `v0.13.2-rc.0`、Title `LiveMemory v0.13.2 RC0`、Pre-release，Target `cb28624`（EXE 的 `build-info.commit`）。
3. **Release Notes**：新增 `docs/release-notes/v0.13.2-rc.0.md`，中文正文 + 英文摘要，覆盖用途、平台、AI Provider、长期记忆、进度/恢复、Token/费用、备份/迁移、三语说明、RC0 改进、已知限制与必要声明。
4. **发布包**：`dist/release-v0.13.2-rc.0/`（EXE、README、LICENSE、RELEASE_NOTES、SHA256SUMS）与 `dist/LiveMemory-v0.13.2-rc.0-windows-x64.zip`。
5. **校验**：解压后逐文件 SHA-256 校验通过；EXE Manifest `requireAdministrator`；包内无敏感文件；只含 5 个文件。
6. **文档**：RELEASE §10、STATUS §0.32、HANDOFF、TEST_PLAN §44、本日志。

### 0.2 结果

| 项目 | 值 |
| --- | --- |
| 建议 Tag / Title | `v0.13.2-rc.0` / `LiveMemory v0.13.2 RC0` |
| Release 类型 | Pre-release（非 latest） |
| Target | `cb286241fe5a4b3322455d661218bb0a14044983` |
| EXE | buildId `e438e74803cb` / SHA-256 `0cf67243…` / `96,733,184` B / `requireAdministrator` |
| ZIP | `8aa08f0e1e908e80880b578b8cf6d6eb24f560f968d338824ff5684bf5598a2f` / `35,724,481` B |
| 全量测试 | 828 passed / 0 failed / 0 skipped（212,358 ms） |
| EXE 回归 | 10/10、14/14、12/12、13/13、16/16 |

### 0.3 下一轮必须先做 / 不要做

1. **先等用户确认**：真实 Windows 双击 + UAC 点击、是否 Push、是否创建 Tag/Release/上传资产。
2. 未经明确授权，**不要** Push、创建本地/远程 tag、发布 Release 或上传发布包。
3. 不要修改产品版本号来匹配 tag；Tag 是 Release 标识，产品版本仍为 0.13.2。
4. 不要在 Release Notes 中声称所有 Provider 已真实验证或 AI 结果完全准确。
5. 若发布前重新构建 EXE，必须重新生成包与 `SHA256SUMS.txt`，并重新核对 buildId/SHA-256。

### 0.4 边界与提交

- **真实 Windows UAC 双击仍未人工验收**；自动化只验证 Manifest 与功能副本，Release Notes 已如实标注。
- Release 包在 `dist/`（gitignored），**不进入 Git**；可提交的是 `docs/release-notes/`、RELEASE/STATUS/HANDOFF/TEST_PLAN 与日志。
- 发布准备文档提交后工作区应保持干净；**本轮不创建任何 tag**。
- 提交身份匿名；**未 Push / 未 Tag / 未发布**。

## 0-A 上一轮（RC0-ADMIN-MANIFEST）

完整报告：`docs/STATUS.md` §0.31；日志：`log/2026-11-14-admin-manifest.md`；Windows 细节：`docs/WINDOWS_RUNTIME.md` §13。

### 0.1 做了什么

1. **正式 EXE Manifest**：`asInvoker` → **`requireAdministrator`**。双击时 Windows 显示标准 UAC；同意后以管理员权限启动；拒绝则取消。不右键、不绕过/关闭 UAC。
2. **构建**：`scripts/build-windows.mjs` 在 postject 注入前后都断言 `requireAdministrator`；最终 EXE 再读取一次，错误即失败。
3. **测试方式**：新增 `scripts/test-exe-copy.mjs`；非交互自动化无法接受 UAC，因此正式 EXE 单独断言 Manifest，功能场景使用 `tests/.tmp/` 中的 asInvoker 测试副本，正式文件不被修改。
4. **测试脚本**：`verify-exe` / `verify-help-exe` / `verify-p0-5-exe` / `verify-p0-2-exe` / `verify-ai-token-exe` 与历史 UI 脚本同步改为“断言正式 Manifest + 测试副本运行”。
5. **单测**：`tests/unit/pe-manifest.test.mjs` 断言构建脚本使用 `requireAdministrator`，并保留生成测试副本的能力。
6. **注释**：`src/launcher/launcher.mjs`、`profile-scan.mjs`、`src/server/auth.mjs` 更新为提权后事实，无行为变化。
7. **未改**：Bootstrap 目录选择、数据目录解析、AI、直播采集、长期画像、Provider、备份恢复；版本/DB schema/结果 Schema/提示词/备份格式全部不变。
8. **文档**：README、STATUS、HANDOFF、CHANGELOG、WINDOWS_RUNTIME、PRIVACY_SECURITY、ARCHITECTURE、DECISIONS、AGENTS、TEST_PLAN、本日志。

### 0.2 结果

| 指标 | 值 |
| --- | --- |
| Manifest | **`requireAdministrator`**（构建脚本与正式 EXE 双重断言） |
| 全量测试 | **828 passed / 0 failed / 0 skipped**（212,358 ms，2026-11-14） |
| EXE 矩阵 | `verify-exe` **10/10**、`verify-help-exe` **14/14**、`verify-p0-5-exe` **12/12**、`verify-p0-2-exe` **13/13**、`verify-ai-token-exe` **16/16** |
| 正式 EXE | buildId `e438e74803cb` / SHA-256 `0cf672438a4723589f4164316e98965a6ff549a132deb30a243638a3f62531c8` / `96,733,184` B / `192` assets / `192` files |
| 版本/Schema | 0.13.2 / DB 16 / 结果 1.3.0 / 提示词 v13.2（未改） |

### 0.3 用户验收步骤

1. 完全退出旧版 LiveMemory。
2. 双击新的 `LiveMemory.exe`，确认 Windows 弹出标准 UAC。
3. 点击“是”：应以管理员权限启动，控制台显示 `Build ID: e438e74803cb`。
4. 点击“否”：Windows 取消启动，这是预期行为。
5. 进入控制台检查直播、历史、观众、AI 分析、备份与使用说明入口。

### 0.4 下一轮必须先做 / 不要做

1. 先等用户回报真实双击 UAC 结果；未回报前不要宣称“已通过真实 UAC 验收”。
2. **不要再改回 `asInvoker`**，除非用户再次明确决定；这是用户本轮亲自要求的修复。
3. 不得因为提权而放宽 API 认证、Origin/Host/SSE 校验、凭据保护、备份/恢复或删除范围。
4. 不要借本轮继续调查 Bootstrap 目录权限或修改目录选择策略（用户已明确排除）。
5. 不要新增目录权限诊断、自动提权 broker、计划任务或其他无关功能。

### 0.5 边界与提交

- **真实 UAC 交互未自动化**：本机沙箱无法启动交互式桌面，自动化只验证 Manifest 与功能副本；拒绝 UAC 的系统行为也未实测。
- 自动化功能场景使用测试专用 asInvoker 副本；**正式 EXE 仍是 requireAdministrator**，测试副本不交付、不提交。
- 代码与文档提交：`cb286241fe5a4b3322455d661218bb0a14044983`（`fix: restore administrator manifest for the Windows EXE`）。EXE 在该提交后重建，`build-info.commit` = `cb28624`；buildId `e438e74803cb` 不变，最终 SHA-256 为 `0cf672438a4723589f4164316e98965a6ff549a132deb30a243638a3f62531c8`。
- 构建记录补充提交：本文件所在的后续提交（HEAD）。
- 提交身份匿名；**未 Push / 未 Tag / 未发布**。

## 0-B 上一轮（RC0-USAGE-GUIDE 封版）

完整报告：`docs/STATUS.md` §0.30；日志：`log/2026-11-14-rc0-usage-guide.md`；界面规范：`docs/UI_DESIGN.md` §7.23。

### 0.1 做了什么

1. **唯一新增功能**：控制台侧栏「使用说明 / 使い方 / User guide」与 `#/help` 页面。只读，不调用 `/api/*`，不写数据，不弹确认，不新增限制。
2. **9 个主题**：首次启动、Bilibili/YouTube 连接、记录/观众/历史、Provider 与 API Key、单场分析 + 长期画像、长期记忆与事实/证据、进度与失败继续、备份/恢复/迁移、FAQ（8 条）。
3. **三语一致**：112 个 `help.*` 键 + `nav.help`；复用 `pageHead`/`card`/`callout`/`details`，只新增 `.help-*` 样式与一个书页图标。
4. **布局**：桌面 sticky 目录 + 两栏；≤1000px 单列胶囊目录；≤700px 术语表单列；≤520px 缩小字号；长文本不横向溢出。
5. **文案边界**：客观解释 AI 画像可能不准确、证据只保证引用合法；明确写出没有观众数/消息数/时长/分析次数/Token/费用/运行时间/批次限制，也不强制审核。
6. **测试**：新增 `help-ui` 9 项；全量 **828 passed / 0 failed / 0 skipped（209,637 ms）**；`verify-help-exe` **14/14**；`verify-exe` **10/10**。
7. **打包**：`src/web/js/pages/help.js` 加入构建必需模块；正式 EXE `74ed76e88a51` / SHA-256 `0f4cf0a3…` / `96,733,184` B / `192` assets / asInvoker。
8. **文档**：README、STATUS、HANDOFF、ROADMAP、CHANGELOG、TEST_PLAN、UI_DESIGN 与本日志已更新。

### 0.2 结果

| 指标 | 值 |
| --- | --- |
| 全量测试 | **828 passed / 0 failed / 0 skipped**（209,637 ms，2026-11-14） |
| 新增测试 | `tests/unit/help-ui.test.mjs` 9 项（i18n 键集由既有 `i18n.test.mjs` 覆盖） |
| 正式 EXE | buildId `74ed76e88a51` / commit（构建时）`bc48a943af943cf8f7ae9abbbe1e3376669fb5ca` / SHA-256 `0f4cf0a39d1b7182182d681e6261f7517ab952142d0c4848d177e1788b6f2cdd` / `96,733,184` B / 92.3 MB / asInvoker |
| 打包验证 | `verify-help-exe` **14/14**；`verify-exe` **10/10** |
| 版本/Schema | 0.13.2 / DB 16 / 结果 1.3.0 / 提示词 v13.2（均未改） |

### 0.3 下一轮必须先做

1. **等用户决定**是否 Push、打 Tag、发布；不要自行推送或发布。
2. 用户可在本机打开控制台 `#/help`，目视检查三语、明暗主题与窄屏（本轮沙箱无法启动真实浏览器，见 §0.4）。
3. 若用户要求继续开发，先读 `docs/STATUS.md` §0.29 的 P1 列表（语义质量），不要以“说明页已完成”当作质量已解决。
4. 任何新改动都必须重建 EXE 并重新跑 `verify-help-exe` / `verify-exe`。

### 0.4 边界与不要做

1. **不要新增使用限制**：观众数、消息数、时长、分析次数、Token、费用、运行时间、批次数量都不得加限；不得强制审核画像或增加阻断弹窗。
2. **不要改说明页为可写**：不要加设置、Provider 或数据修改入口；不要在该页调用 API 或加“开始分析”按钮。
3. **不要声称真实浏览器/截图已验收**：本机 Chromium mojo `platform_channel` 被沙箱拒绝（Chrome 154、Edge 157 均 0x5），只完成 DOM 渲染测试与打包资源检查。
4. 不要改 DB schema、结果 Schema、提示词版本、备份格式、金额/身份/去重规则；本轮没有这些改动。
5. 不要把文档提交 Hash 与二进制 buildId 混为一谈：buildId 是源码内容哈希，构建时 HEAD 记录在 `build-info.commit`。

### 0.5 提交与构建记录

- 代码与文档提交：`bc48a943af943cf8f7ae9abbbe1e3376669fb5ca`（`feat: add tri-language in-app usage guide`）。
- 正式 EXE 在该提交之后重建：`build-info.commit` = `bc48a94`，buildId `74ed76e88a51`，
  SHA-256 `0f4cf0a39d1b7182182d681e6261f7517ab952142d0c4848d177e1788b6f2cdd`，`96,733,184` B。
- 构建记录补充提交：本文件所在的后续提交（HEAD）。
- 提交身份：`zgrg29 <10182596+zgrg29@users.noreply.github.com>`；**未 Push / 未 Tag / 未发布**。
- **环境备注**：本机 DSH 沙箱下 `.git` 为中等完整性，受限进程写入会 `Permission denied`；本轮在一次性 full access 下执行 `git add`/`git commit`。该环境的 Git 还会把已暂存改动判为“空提交”，需加 `--allow-empty` 才能生成提交（提交 tree 与文件内容不受影响）。真实用户环境不需要这些处理。

## 0-C 上一轮（RC0-FINAL-ACCEPTANCE）

完整报告：`docs/RC0_FINAL_ACCEPTANCE.md`；日志：`log/2026-11-14-rc0-final-acceptance.md`。

### 0.1 做了什么

1. **P0-A**：无 evidence 的 `confirm + stated` 会把 `inferred` 提升为 `stated`。两个 validator 现在跳过无证据的 stated confirm；
   engine 要求 evidence 才允许提升/激活；无证据的匹配 add 也跳过。
2. **P0-B**：旧 `/api/memory/import` 路径未比较 `events.viewer_id`，同 batch 内可跨观众引用证据。
   现在返回 `MEMORY_EVIDENCE_OTHER_VIEWER` 并拒绝整份答案。
3. 新增 5 项测试；全量 **819 passed / 0 failed / 0 skipped（397,114.9 ms）**；既有断言未放宽。
4. 正式 EXE：`7016d4295d0e` / SHA-256 `861eeaef...` / commit `996f992` / 96,668,160 B / asInvoker；
   `verify-exe` 10/10、`verify-p0-5-exe` 12/12、`verify-p0-2-exe` 13/13、`verify-ai-token-exe` 16/16、
   YouTube 生命周期 PASS。
5. 真实平台：Bilibili 5050（9 chat / 4 viewers / ended）；YouTube Sky News `LXQz2kkE-C0`
   （8 chat / 8 channel id / 7 active / ended）。
6. 真实浏览器：外部 Chrome 154 + 正式 EXE，fragment→Cookie `authenticated: true`，`#/live`、`#/viewers`、`#/ai` 无异常。
7. 归档质量：严格召回 15.1% / 24.5% / 29.5% / 18.0%；错误 stated 25.0%–31.1%；跨观众 0；重复 0。

### 0.2 下一轮必须先做

1. **不要直接公开发布**；先做 RC0 小范围闭源内测，明确标注“长期画像需复核”。
2. **P1-A**：同 `kind+topic` 不同 statement 的静默 confirm 必须处理（statement 等价检查/复核队列/提示 update-supersede），
   但不要破坏“一 live fact/topic”、版本快照与跨场次累积。
3. **P1-B**：优先修“引用原文不支持结论”（25%–31% stated），而不是继续加批次或提示词。
4. **P1-C/D**：临时事实长期化、摘要无证据级校验；UI 标注或 TTL。
5. 其他 Provider、真实账单、5 人语义批次、原生对话框、干净 Windows 账户人工双击仍待验收。

### 0.3 不要做

1. 不要把 819 测试通过等同于“语义质量通过”；召回与证据支持仍低。
2. 不要因为 P0-A/B 已修复就恢复默认 20 人/批；默认 10 不变。
3. 不要把旧 `verify-memory-ui.mjs` 的 15/21 当产品失败；它是 v0.10 陈旧脚本（`/memory` 已移除）。
4. 不要为了提高召回而放宽证据/身份/金额/去重规则。

## 0.28 上一轮（RC0-MEMORY-QUALITY）

完整报告：`docs/MEMORY_QUALITY.md`；日志：`log/2026-11-14-memory-quality.md`。

### 0.1 做了什么

1. **建立标准答案集**：`tests/fixtures/memory-quality/gold-corpus.mjs`（16 观众 / 3 场次 /
   70 消息 / 30 当前事实 + 6 被替代 / 11 重要 / 1 歧义 / 26 不应保存），覆盖 15 类场景；
   另建 P0-3 16 句模板的事后标注，用于离线重评归档真实结果。
2. **建立指标与 CLI**：严格召回、准确率、重要召回、跨观众、重复、误收、歧义、Token/费用；
   `scripts/memory-quality-eval.mjs`、`scripts/memory-batch-structure.mjs`。
3. **重评归档真实 10 vs 20**：旧“20 更差”不成立。第 1 次 cap10 67 行中 37 行是
   `needs_confirmation`；cap10 两次多发 4/3 次补答，cap20 为 0。严格 stated 口径两次方向相反；
   20 每请求/每 Token 更省。默认 10 不变，但撤销“20 已证明更差”。
4. **确定性修复**：摘录窗口 omitted 元数据 + 提示词禁止推断；`efficiency.factQuality`
   区分 stated/inferred/uncertain。未改 Schema/提示词版本/DB schema/默认批次。
5. **新增 17 项测试**：10 unit + 7 integration；oracle 在 5/10/20 下 100% 严格召回；
   退化/跨观众/截断/同名场景均有断言。
6. **全量 814 passed / 0 failed**；正式 EXE 与 EXE 矩阵见 `docs/STATUS.md` §0.28.5；
   代码提交 `8d4e024bc01561be6f418aa9415a2c0dc5bfa3c5`。

### 0.2 下一轮必须先做

1. **不要恢复 20 人默认**，也不要继续引用“20 人事实保留率 73%/51%”作为质量结论；
   那是行数与不等请求预算的比较。
2. 下一次真实付费 A/B 必须先获授权；建议等请求预算、重复 ≥3 次，用本报告 CLI 评分。
3. 优先修“引用原文不支持结论”的语义污染（25%–31% stated 事实），而不是加批次或加提示词。
4. 5 人批次没有真实语义数据；其他 Provider、真实账单、thinking、真实浏览器仍未验证。
5. 摘录窗口仍为最近 120 条/人；若要改，先做授权的 120 vs 240 对照。

### 0.3 不要做

1. 不要把 `memory_facts` 行数当质量，或把 uncertain 与 stated 混算。
2. 不要在未复测前重新启用 20 人默认。
3. 不要为了召回率放宽证据校验或鼓励编造。
4. 不要声称本轮完成了真实付费语义验收。

## 0-A 上一轮（P0-3 阶段 A + DeepSeek 真实付费验收）

完整底稿、兼容性矩阵与真实结果：`docs/AI_PROVIDER_COMPATIBILITY.md`；日志：
`log/2026-11-14-p03-provider-compat.md`。

### 0.1 做了什么

1. **阶段 A 审计 7 个 Provider** 的端点、鉴权、JSON 模式、输出上限、流式与 usage 语义，
   建立 L1–L5 证据矩阵。
2. **修复 8 个确定性缺陷**：结构化输出开关循环、`response_format` 拒绝后永久失败、
   OpenAI 推理模型参数、OpenAI 缓存写入字段、OpenRouter 自报费用、DeepSeek thinking
   消耗输出预算、缺失缓存价被当作 0、20 人批次事实质量回归。
3. **阶段 B（用户授权）**：DeepSeek `deepseek-flash`、$1.25 上限、仅合成数据；
   50 次真实请求、估算 $0.2553；用户通过隔离控制台的真实浏览器 UI 输入 Key。
4. **真实 10 vs 20 对照**：20 人上限的事实保留率只有 73% / 51%，覆盖率仍 25/25；
   RC0 恢复默认 10 人/批。
5. **真实单场 + 画像、100 观众 Resume、日语 60 观众**全部 `complete`；0 重复事实、
   0 跨观众证据、0 无证据事实。
6. **全量测试 + 正式 EXE + EXE 矩阵**复跑（最终 buildId 见 `docs/STATUS.md` §0.27）。

### 0.2 结果

| 指标 | 值 |
| --- | --- |
| 全量测试 | **797 passed / 0 failed / 0 skipped**（2026-11-14，见 `docs/STATUS.md` §0.27） |
| 新增测试 | 13 unit + 3 integration |
| 真实请求 / 估算费用 | in-process 50 次 Harness 计数 / $0.2553（T4 2 次本地停止未发出；T3 2 次暂停取消未计入 usage） + 正式 EXE 16 次 / $0.0891 = **66 次计数 / $0.3444**（授权 $1.25） |
| 能力检测 | 首次 `length` 空内容 → 关闭 DeepSeek thinking → `passed` |
| 10 vs 20（第 1 次） | 67 vs 49 条事实；7 vs 2 请求；覆盖 25/25 |
| 10 vs 20（第 2 次） | 74 vs 38 条事实；6 vs 2 请求；覆盖 25/25 |
| 单场 + 画像 | 80/80，85 条事实，session 4 批 + final，11 请求，$0.07833 |
| 100 观众 + Resume | 100/100，243 条事实，6 批；暂停/重启/Resume 后完成；$0.07007 |
| 日语 60 观众 | 60/60，83 条事实；kana 0.649 / CJK 0.984，无英语回退；$0.03017 |
| 正式 EXE | buildId `69ec022cee31` / commit `f9b0cda` / SHA-256 `20d7a58b1fbf4ea788b5cc3f4c0deb14528cf762ebcb0df101b7e8ef6c1fc1fd` / `96,640,000` bytes / `189` assets / `asInvoker`；真实 DeepSeek EXE 验收 **11/11**（40/40、79 事实、8 请求、$0.04422、备份、重启、Resume 0 请求） |

### 0.3 关键实现位置

- `src/ai/providers/adapters.mjs`：DeepSeek `thinking:{type:"disabled"}`、OpenAI 推理参数、
  `developer` 角色、缓存写入字段、`providerReportedCost`。
- `src/ai/providers/pricing.mjs`：缺失缓存价不再被 `Number(null)` 当作 0；
  缺价按输入价并标 `cachePriced=false`。
- `src/ai/api/runner.mjs`：格式降级与 Schema 回填、`downgradeStructuredOutputs()`、
  **默认 `memoryViewerCapHard=10`**、`providerReportedCost` 汇总。
- `src/server/routes.mjs`：能力测试传入 Provider 目录声明的 `supportsStructuredOutputs`。
- `src/ai/providers/verify.mjs`：`json_schema` 探测/一次降级/复杂 Schema 通过才记 true。
- `scripts/ai-efficiency-baseline.mjs --viewer-cap`（离线结构对照）。
- `scripts/ai-paid-acceptance.mjs` / `scripts/ai-paid-exe-acceptance.mjs`（真实付费验收，
  含请求上限；不属于产品运行路径）。

### 0.4 下一轮必须先做

1. **不要重新启用 20 人上限**，除非提示词/质量修复后用同一协议再次真实对照并达到不低于
   10 人批次的“有效事实/观众”。
2. 其他 Provider（OpenAI / Anthropic / DashScope / OpenRouter / MiniMax / 自定义）仍为
   L2/L4；要分别授权、分别验收，不能因为 DeepSeek 通过就宣称全部通过。
3. 真实账单需用户在 DeepSeek 控制台核对；本程序只有估算（DeepSeek 不返回 `usage.cost`）。
4. cap10 仍会漏部分事实；长期画像质量只达到“20 人明显更差、10 人较保守”的结论，
   不是“已解决质量”。
5. thinking 被关闭；若未来启用，需要重测输出预算、费用与事实质量。
6. 真实 EXE 的 Key 流程、真实浏览器截图与取消请求计费仍需补证。

### 0.5 不要做

1. 不要把 DeepSeek 的真实结果写成“所有 Provider 已验证”。
2. 不要为了省请求重新打开 20 人上限；真实证据显示事实损失 27–49%。
3. 不要在未校验 `response_format` 支持的 Provider 上恢复“Schema 只发一次”。
4. 不要把格式降级做成无限重试；每次请求最多 2 次，且必须把 Schema 回填提示词。
5. 不要把 `providerReportedCost` 或估算费用当作官方账单。
6. 不要自动读取生产 `secrets/` 或复用用户已保存的 Key；真实测试必须由用户在隔离控制台输入。

## 0-B 上一轮（AI Token 效率与成本）

完整报告：`docs/AI_TOKEN_EFFICIENCY.md`；日志：`log/2026-11-14-ai-token-efficiency.md`。

### 0.1 本轮做了什么

1. **建立 Token 归因**（无 schema 变更）：缓存命中 Token、推理 Token、逐尝试 token 账本、
   `usageSource`、`attempts`/`unknownUsageAttempts`；能力测试与翻译失败尝试也计入。
2. **建立可复现基线**：`scripts/ai-efficiency-baseline.mjs` 14 个场景；"优化前"由
   `git archive HEAD` 的未修改副本真实跑出，不是推算。
3. **删除可证明的重复输入**：Schema 只发一次（仅已校验 structured outputs 的 Provider）、
   删除重复输出示例、记忆契约不再重复 `memory_context` 的逐观众数组。
4. **自适应分批**：观众上限从"写死 10"改为"偏好 10、按输出预算/摘录上限/内容预算最多 20"。
5. **UI 与口径**：推理/缓存 Token、用量来源、重试开销占比、每百观众/每百事实 Token、
   每百观众估算费用；无价格时明确「费用未知」；「已知实际费用」改为「估算费用」。三语同步。

### 0.2 结果

| 指标 | 优化前 | 优化后 | 变化 |
| --- | --- | --- | --- |
| 总请求数 | 216 | 150 | -30.6% |
| 输入 Token（模拟） | 2,867,221 | 2,560,520 | -10.7% |
| 总 Token（模拟） | 3,029,258 | 2,723,048 | -10.1% |
| 请求字节（实测） | 9,274,013 | 8,312,569 | -10.4% |
| 观众覆盖 / 事实 | 1715 / 1715 | 1715 / 1715 | 不变 |

Token 为"按真实请求字节模拟"的值（无 tokenizer、无付费调用），只用于同规则前后比较；
界面与数据库里的用量一律是 Provider 自报值。

### 0.3 关键实现位置

- `src/ai/providers/adapters.mjs#normalizeUsage()`：三类 Provider 的缓存/推理解析。
- `src/ai/providers/pricing.mjs`：`addUsage()` / `countRequestWithoutUsage()` / `estimateCost()`。
- `src/ai/runtime/attempt.mjs`：尝试记录（token/usageSource/estimateSource）。
- `src/ai/api/runner.mjs`：`#attributeRequestUsage()`（唯一 usage 写路径）、`#efficiencyStatus()`、
  `#structuredOutputs()`；prompt 构造传入 `structuredOutputs`。
- `src/ai/api/prompts.mjs`：`answerSchemaBlock()`、删除重复示例、契约去重。
- `src/ai/batching/tokens.mjs`：`MEMORY_MAX_VIEWERS_PER_BATCH`、`viewerCapHard`。
- `src/ai/export/split-jobs.mjs`：`viewersPerBatchHard`。
- `src/web/js/pages/ai.js`、`ai-settings.js`、`src/web/i18n/*.json`：展示与三语文案。

### 0.4 正式 EXE 与验证结果

| 项目 | 值 |
| --- | --- |
| 文件 | `dist/LiveMemory.exe` |
| 大小 | `96,623,616` bytes（92.1 MB） |
| SHA-256 | `178585a6f65bbffa7f657f3ecb9a7e5c7ce1ce954ef3c8570705ea1d131a73a3` |
| buildId | `4a149ca7286e` |
| commit | `649f8192bc6fe53a4957d6c906bcc1e8bf4a212c` |
| builtAt | `2026-11-14T09:44:11.067Z` |
| 资源 | `189` files；20 个必需模块；`asInvoker` |

- 全量：**781 passed / 0 failed**（218,884 ms）。
- `scripts/verify-ai-token-exe.mjs` **16/16**（新）：正式 EXE + 本地 Mock Provider：
  40/40 观众、3 批、3 请求；usage 输入 20,893 / 输出 3,563 / 缓存 8,356；
  `tokenSource=provider-reported`；估算费用 0.019663 USD、每百观众 0.049157 USD；
  注入 500 后 failed=3、attempts 5 vs requests 2、failedBatches=[2]；
  Resume 只重发 b02（1 次）后 40/40 完成；完成后重复 Continue 0 请求；重启后 token 一致。
- `verify-p0-2-exe` **13/13**、`verify-p0-5-exe` **12/12**、`verify-exe` **10/10**。
- **性质**：正式 EXE + 本地 Mock Provider + 合成数据；不是真实付费 Provider 验收，
  也不是真实浏览器点击。

### 0.5 下一轮注意（P0-3 真实付费验收）

1. **首要待验收**：用真实付费 Provider 校准 `bytes/3` 估算与真实 tokenizer 的比值，
   并对照 `usage_json` 检查重试/补答占比。历史记录该比值约 1.366×，本轮未重新校准。
2. **必须复核自适应分批的语义影响**：单请求观众数从 10 增到最多 20。观察
   `MEMORY_VIEWER_UPDATE_MISSING` 与补答率是否上升。若上升，最省事的回退是
   `config` 不再传 `viewersPerBatchHard`（或把 `MEMORY_MAX_VIEWERS_PER_BATCH` 调回 10）。
3. **缓存命中率**：本轮只解析 Provider 字段；真实命中率、缓存写入成本需真实数据验证。
4. **不要**把本轮"模拟 Token"写进任何对外结论；不要把估算费用说成账单。
5. 若要继续压输入，最大空间是 `messages.jsonl` 的结构开销（实测 93.8% 字节为 JSON 结构），
   但会改变证据行格式，必须先做真实模型质量对照。
6. 编辑器警告：本仓库内不要用 PowerShell 的 `Get-Content | Set-Content` 改文件（PS 5.1
   会以 ANSI 读写并破坏 UTF-8 中文），只能用编辑工具；`.git` 写入可能被沙箱拒绝。

### 0.6 不要做

1. 不要为了省 Token 删除 Schema/证据/覆盖/语言/身份规则。
2. 不要在未校验 structured outputs 的 Provider 上删除文本 schema。
3. 不要把未知用量当 0，或把估算费用显示成"实际费用"。
4. 不要把 `messages.jsonl` 的改动与"省 Token"一起提交而不做质量对照。
5. 不要用提高 `max_tokens` 的方式"解决"截断；先缩小批次。

## 0-A 上一轮（P0-2 完整备份与恢复）

完整证据：`log/2026-11-14-backup-restore-p02.md`；格式：`docs/BACKUP_FORMAT.md`；流程：`docs/BACKUP_RESTORE.md`。

### 0.1 原有能力审计

- 已有 `VACUUM INTO` 数据库应急快照：只含数据库，不含设置/凭据，不是跨电脑格式。
- 数据目录迁移会把 `secrets/` 一起复制，只适合本机换目录。
- 清空/出厂只有“写前快照”，没有恢复入口；旧 `.livememory` 只有设计文档。

### 0.2 实现

- `src/server/backup/`：`archive.mjs`（流式 ZIP 读取/CRC/SHA/安全条目）、`write-archive.mjs`（流式 STORE 写入）、`manifest.mjs`、`counts.mjs`、`settings.mjs`、`create.mjs`、`inspect.mjs`、`journal.mjs`、`restore.mjs`。
- 创建：`VACUUM INTO` → `integrity_check` → 临时文件 → 重新完整校验 → `fsync` + 原子改名；目标存在需显式 `overwrite`。取消/写入失败/磁盘不足不留半成品。
- 恢复：验证 → 冻结 → 停采集/AI/SSE → 关闭 DB → `backups/pre-restore-*.db` → 暂存迁移+校验 → journal → 两次原子改名 → 新库校验 → 设置 → `buildRuntime()`。
- journal：`runtime/restore-journal.json` 阶段 + SHA-256；启动时在打开数据库前回滚/提交。
- `src/server/backup-jobs.mjs`：进度、取消、单任务互斥；`src/server/routes.mjs` 新增 `/api/backup/*`；`src/server/app.mjs` 认证先于维护检查，恢复期间 job 进度可读。
- `src/server/native-dialog.mjs`：原生 Save/Open 文件对话框（固定 PowerShell 脚本、base64、无 shell）。
- UI：`src/web/js/pages/settings-backup.js` + 设置页卡片 + 三语 i18n；摘要/覆盖确认/`RESTORE` 确认/阶段进度/取消/错误。
- 构建：`scripts/build-windows.mjs` 增加 backup 必需模块与嵌入标记；新增 `scripts/verify-p0-2-exe.mjs`。

### 0.3 内容与安全

- 包含：场次、事件、观众/映射/昵称、支付、长期画像/事实/证据/版本、AI 结果/证据/汇总/翻译、任务状态、监控目标、设置、schema。
- 排除：`secrets/`、`config/ai-providers.json`、日志、缓存、runtime、exports、backups、app、数据目录指针、`preferredPort`。
- 拒绝：ZIP Slip、绝对/盘符/UNC/反斜杠、`.`/`..`、控制字符、目录、重复名、符号链接、加密/data descriptor/ZIP64、非 STORE、压缩炸弹、条目数/大小/总量超限、CRC/SHA、损坏 SQLite、伪造 format/schema、含凭据。
- 未加密；界面明确提示。所有 API 在 P0-5 认证之后；未认证始终 401。

### 0.4 测试与 EXE

- 新增 `backup-format` 9、`backup-ui` 5、`backup-restore` 10；`api-auth` 增补备份端点 401。
- 全量 **769 passed / 0 failed / 0 skipped（307,126 ms，2026-11-14）**；schema 16 不变。
- 正式 EXE：buildId `678e8d47b6c6` / commit `489ce070abca24ced6a8287cb4312cc575b24692` / SHA-256 `fa1e8367bed99ce221b1f20d4f0c7efc3eaf492d499d2f39c9014233f2dbf9e6` / `96,594,432` bytes / `189` assets / `asInvoker`。
- 本轮代码提交 `9a23d45`；EXE 在提交前构建，`build-info.commit` 因此是上一提交。buildId 由源码内容哈希决定，用 `9a23d45` 可重建同一 buildId。
- `verify-p0-2-exe` **13/13**：创建 → 验证 → 全新目录恢复 → 重启 → 再次备份 → 独立校验；`verify-p0-5-exe` **12/12**；`verify-exe` **10/10**。
- 未验证：真实 Windows 文件对话框点击、真实浏览器点击；真实付费 Provider/真实账号跨电脑；同用户恶意软件/共享目录 ACL。

### 0.5 用户安全升级步骤

1. 更新到 buildId `678e8d47b6c6`；设置页「关于」核对。
2. 先创建一次完整备份；默认保存到 `%LOCALAPPDATA%\LiveMemory-Backups\`，可用 Windows 对话框另存。
3. 换电脑：在新电脑启动 LiveMemory，设置 → 备份与恢复 → 选择备份文件 → 验证 → 恢复；不需要管理员权限、旧用户名或旧路径。
4. 恢复后重新登录 Bilibili、重新填写 AI API Key；YouTube 公开聊天不需要登录。
5. 若恢复失败，程序会自动回滚；若 Windows 强制结束进程，下次启动按 journal 回滚或提交。不要删除数据目录。

### 0.6 不要做

1. 不要在备份中悄悄加入 `secrets/` 或 API Key。
2. 不要直接复制运行中的 `.db`/`-wal` 并称为完整备份。
3. 不要用 `try/catch` 代替 journal 崩溃协议。
4. 不要接纳未来 format/schema、压缩条目、符号链接或 ZIP Slip；不要放宽 2 GiB/16 条目上限。
5. 不要在恢复期间允许新的采集/AI 写入，或让旧 DB 连接继续服务。
6. 不要恢复 `preferredPort`、数据目录指针或旧凭据。

## 0-A 上一轮（P0-5 本地 API 认证 + asInvoker）

完整证据：`log/2026-11-14-local-api-auth-p0.md`。

### 0.1 原始漏洞与根因

- `src/server/app.mjs` 只校验 Host；Origin 只对写请求生效；所有 `/api/*` 没有认证。
- 隔离目录实测无凭据 `GET /api/bootstrap`、`GET /api/viewers`、`PATCH /api/settings`、`POST /api/simulate/start`、`POST /api/sessions/:id/stop`、`GET /api/events/stream` 全部成功；伪造 Origin/`Origin:null` 的 GET 也成功。
- 发布 EXE 为 `requireAdministrator`，本机任意进程的 API 调用继承管理员令牌。CORS/SameSite 只约束浏览器，不能阻止本机进程直接发 HTTP。

### 0.2 修复

- 新增 `src/server/auth.mjs`：每次启动随机 256-bit bootstrap token + session token，仅内存；bootstrap 一次性、5 分钟；session 最多 7 天；常量时间比较。
- 启动器打开 `http://127.0.0.1:<port>/#lm_bootstrap=<token>`；`src/web/js/auth.js` 读取 fragment → `POST /api/auth/session` → `HttpOnly; SameSite=Strict` Cookie → 清除 fragment。不存在返回 token 的端点；token 不进入查询串、runtime.json、日志。
- `src/server/app.mjs`：所有带 Origin 请求必须同源；`Origin:null` 拒绝；`/api/*` 拒绝跨站 `Sec-Fetch-Site`；公开路径仅 health/auth；其余（含 SSE）要求 Cookie；401 `AUTH_REQUIRED`。
- `src/web/js/app.js`/`api.js`：先建立会话再加载数据；401 渲染三语“请从 LiveMemory 重新打开”页面。
- 发布 EXE 改为 `asInvoker`：构建脚本 patch 前后断言；删除管理员检查/`admin.mjs`/`adminRequired`/`LIVE_MEMORY_SKIP_ADMIN_CHECK`。
- 测试专用 `startServer({auth:false})` 仅供进程内夹具；HTTP/环境变量无法关闭生产认证。EXE 回归使用 `LIVE_MEMORY_TEST_BOOTSTRAP_FILE` 走与浏览器相同的交换流程。

### 0.3 测试与 EXE

- 新增 `tests/integration/api-auth.test.mjs` 14 项、`graceful-close.test.mjs` 1 项、`tests/unit/server-auth.test.mjs` 6 项、`tests/unit/auth-boot.test.mjs` 6 项；全量 **745 passed / 0 failed / 0 skipped（270,168 ms，2026-11-14）**。
- 正式 EXE：buildId `75588ba16aec` / commit `3d4232704dd9a710ee8c55a1688ec4ff9812821c` / SHA-256 `d3d1ddc1d1b207cd72bb6c6e03a3a07216885a3e2a53ca3bf9f1a5cb48a558ae` / `96,436,224` bytes / `177` assets / `asInvoker`。
- `scripts/verify-p0-5-exe.mjs` **12/12**；`scripts/verify-exe.mjs` **10/10**；YouTube EXE 回放 **通过（180,934 ms 断连 → 同一 session 恢复 → 去重 5/5 → platform_ended）**。
- 未验证：真实浏览器点击/自动打开、真实 Ctrl+C/关闭窗口、真实桌面 UAC（asInvoker 后不再需要）、同用户恶意软件、共享目录 ACL、真实平台/真实付费 Provider。

### 0.4 用户安全升级步骤

1. 完全退出旧版 LiveMemory；备份整个数据目录（不要在运行时复制写入中的 SQLite）。
2. 替换为 asInvoker 新 EXE；双击不再弹出 UAC。设置页「关于」核对 buildId。
3. 双击后浏览器会自动打开已授权控制台；若浏览器未打开，重新运行 LiveMemory（不要手动打开普通地址，它不会获得会话）。
4. 旧浏览器标签页在服务重启后失效是预期行为；从新启动的浏览器标签继续。
5. 若防火墙/杀毒软件拦截 127.0.0.1，不要把监听改为 0.0.0.0；按提示排查本机回环。
6. 真实 Ctrl+C/关闭命令行窗口、真实浏览器交互仍需人工验收。

### 0.5 不要做

1. 不要新增 `/api/token`、无条件 `/api/bootstrap` 或其他返回凭据的端点。
2. 不要把 token 放进查询串、localStorage、配置、日志、数据库或分析包。
3. 不要为“兼容旧页面”关闭认证或允许 `Origin:null`。
4. 不要恢复 `requireAdministrator` 来“解决权限问题”；需要提权的功能必须单独评审。
5. 不要把 `startServer({auth:false})` 暴露为 CLI/环境变量/HTTP 开关。

## 0-B 上一轮（P0-4 YouTube 暂时性故障误判结束）

完整证据：`log/2026-11-14-youtube-lifecycle-p0.md`。

### 0.1 原始故障与根因

1. `parser.mjs` 把 HTTP 200 缺 `continuationContents` 解析为 `ended:true, invalid:true`；adapter 只看到 `ended` 就 `#finish('chat_ended')`。
2. `adapter.mjs` 在 429/网络/5xx 连续 8 次后 `#finish('connection_failed')`；`SessionManager` 随即将 `sessions.status` 写成 `ended`。
3. 观看页只读一次 `state='ended'`（甚至 `'video'`）就结束，没有二次确认；`onEnd` 后缺少 generation 失效保护。
4. `openChat` 刷新失败后继续 poll 同一个 stale continuation；有 actions 但无新 token 的响应被当作成功并复用旧 token。
5. `PLATFORM_INTEGRATIONS.md` 与代码相反；错误文案仍建议使用已删除的官方 API。

### 0.2 修复

- `src/platforms/youtube/anonymous/parser.mjs`：缺 `continuationContents` / `liveChatContinuation` / 新 continuation 一律 `invalid:true, ended:false` + `invalidReason`；异常页中可读 actions 先入库，再作为可恢复结构错误处理。
- `src/platforms/youtube/anonymous/adapter.mjs`：
  - 429/5xx/网络/异常 200 只进入 `reconnecting` → 阈值后 `failed`（`retrying/recoverable/sessionPreserved`），继续 60 秒上限退避；429 至少 30 秒且尊重 `Retry-After`；**绝不 `onEnd`**。
  - 观看页 ended 二次确认（约 2 秒）→ `platform_ended`；聊天页 ended/disabled 需观看页 ended 或第二次聊天页相同结果 → `chat_ended`/`chat_disabled`。
  - 确认期间 `platform_status=ending`；确认失败回到 live/unknown，不伪造结束。
  - stale continuation 丢弃旧 token，先 `openChat` 再 poll；失败只退避重取。
  - 每 adapter 一个 poll timer + 一个结束确认 timer + 一个元数据请求；`onEnd` 最多一次；`stop()` 清全部 timer。
- `src/platforms/youtube/errors.mjs`、`client.mjs`、`service.mjs`：新增 `YOUTUBE_WEB_RESPONSE_INVALID`；`openChat`/`getVideo` 的 5xx 归为可重试网络错误。
- `src/server/index.mjs`：`youtubeAdapterOptions` 测试注入；`LIVE_MEMORY_TEST_YOUTUBE_WEB_BASE` 仅允许 loopback，用于正式 EXE 假服务回放。
- `src/web/js/pages/shared.js`、`live.js` + 三语 i18n：可恢复连接状态、最近故障、数据保留说明、聊天结束/关闭结束原因；移除「改用官方 API」的过期文案。
- **未改** Bilibili adapter、共享 `SessionManager`/`EventIngest`、数据库 schema、AI 架构。

### 0.3 修复前复现与测试

- 修复前 `tests/unit/youtube-lifecycle-regression.test.mjs` **7/8 失败**：429、连续网络失败、500/502/503、缺 continuationContents、异常 200、stale token 复用、单次 ended/`video` 全部触发 `onEnd`。
- 修复后新增 **10 个 unit + 2 个 integration**；全量 **721 passed / 0 failed**（192,929 ms，2026-11-14）。
- 集成测试使用真实 server/SessionManager/SQLite + 假 YouTube 网页，验证：同一 session、同一 viewer、消息不丢、replay 去重、单轮询器、平台结束只一次、用户停止独立。

### 0.4 正式 EXE 与本地假 YouTube

- **正式构建**：`dist/LiveMemory.exe` buildId `59b7928cb78a` / commit `31886b2` / SHA-256 `e9fe576931a0562a7969afa3bba188a3418b95374ca68c2d75d09bc6d8805b2f` / 96,419,840 bytes（92.0 MB）/ 176 assets / `requireAdministrator` / builtAt 2026-11-14T03:28:37.819Z。
- **回放**：asInvoker 测试副本（仅测试设置 `LIVE_MEMORY_SKIP_ADMIN_CHECK=1` 与 `LIVE_MEMORY_TEST_YOUTUBE_WEB_BASE=http://127.0.0.1:<port>`）+ 本地假 YouTube，EXE 内 buildId/commit 与 `/api/health` 一致。
  - 正常采集 3 条消息 / 2 位观众 → 关闭假 YouTube **180,513 ms**；
  - 断连期间 session 仍 `live`、消息数仍 3、无第二个 session、无结束；
  - 恢复后同一 session 继续到 4 条；stale 重放 `msg-1` 去重（事件行 5 / 唯一 5）；
  - 明确 ended → `platform_ended`、`platform_status=ended`、结束前后计数一致、房间 1 条 session。
- **性质**：这是正式 EXE + 本地 Mock 服务的确定性回放，不是真实 YouTube 网络断网，不是 UAC 双击，不是真实浏览器点击。

### 0.5 P0-4 结论与下一轮 P0-5 交接

- **P0-4 代码级可关闭**：根因确认、修复前失败可复现、修复后 12 个专项用例 + 721 全量通过；Bilibili 生命周期测试 53 项通过；无 schema/生产数据改动。
- **待用户验收**：真实 YouTube 直播的 429/断网 3 分钟/恢复、真实长直播、真实 UAC 双击、真实浏览器点击。
- **下一轮 P0-5「本地 HTTP API 无鉴权 + 管理员进程」交接**：
  - 现状：服务只监听 `127.0.0.1`，但所有 `/api/*` 无认证；仅对带 `Origin` 的写请求做同源校验（`src/server/app.mjs`）。本机任意进程可省略 `Origin` 直接调用 GET/POST/PATCH/DELETE。
  - 发布 EXE 以 `requireAdministrator` 运行，因此上述请求会以管理员权限执行（改设置、停止/删除场次、迁移数据目录、读取观众与聊天数据）。
  - 建议复现：从普通 PowerShell 直接 `PATCH /api/settings`、`POST /api/sessions/:id/stop`、`GET /api/viewers`、`POST /api/storage/location`（先只读/测试数据目录），确认无 token 也成功；再用非管理员进程验证权限继承。
  - 建议修复方向（需单独评审）：启动器生成每次运行随机 token；通过同源 `HttpOnly; SameSite=Strict` cookie 或 bootstrap 注入 + `Authorization` 校验所有 `/api/*`；SSE 同样校验；拒绝 `Origin: null` 与缺失 token；限制 CORS；把危险操作（迁移/删除/恢复出厂）放到需要用户确认的独立高权限 broker，而不是让任意本地 HTTP 调用提升权限；对 `runtime/` 与数据目录做 ACL 收紧。
  - 不要在本轮顺手加认证：会牵涉启动器、浏览器引导、SSE、测试与用户体验，需要独立回归。

### 0.6 不要做

1. 不要把 429/5xx/网络/异常 200 重新当作结束；结束必须有可确认证据。
2. 不要为了让测试通过把 `continuationContents` 缺失改回 `ended:true`。
3. 不要用无限高频重试代替“不误判结束”；保持指数退避、上限与用户停止能力。
4. 不要在重连时新建 session、清空 continuation/消息/观众，或绕过 EventIngest 去重。
5. 不要修改 Bilibili 的结束判定来“统一”两平台；如需改共享代码，必须补跨平台回归。

## 0.8 上一轮（P0-1 定向补答回归修复）

完整证据：`log/2026-11-14-ai-memory-supplement-p0.md`。

### 0.1 原始故障与根因

- 上一轮 RC0 审计 P0-1 已复现：首答漏 1 位观众时，`generateMemoryAnswer()` 发出的补答只含缺失 ref，但补答回来后用 `evaluate(repaired.content)` **按全量 refs** 组装/校验。
- `assembleMemoryCompact()` 只有在所有 refs 都出现时才 `ok`；补答只含缺失 ref，必然被判“首答已覆盖的观众缺失”，整批 `AI_IMPORT_INVALID`。
- `mergeMemorySupplement()` 已存在但无调用者；补答失败时首答中已合法观众被整批丢弃，也不走 viewer salvage。
- 结果：模型漏写 1 人 → 批次永久失败；每次 Continue 重发首答 + 补答 2 个付费请求且不收敛。
- 同路径独立缺陷：定向补答只发送 `evidence_seqs`，没有发送缺失观众的聊天摘录，模型无法根据真实文本补答。

### 0.2 修复

- `src/ai/api/runner.mjs`：
  - 补答按 `missingEntries` 子集组装/校验，不再按全量 refs；
  - 补答完整时用 `mergeMemorySupplement()` 合并首答 + 补答，再做一次完整校验；
  - 补答仍缺失/错误观众/非法 JSON/空响应/截断/Provider 错误/提示词超限时，保留首答中每个单独合法观众；只把仍缺失观众标记 `failed`，Resume 只请求这些观众；
  - 补答空/截断计入 `outputStats`；新增 `supplement.merged/partial/failed/too_large` 日志。
- `src/ai/api/prompts.mjs`：定向补答附带缺失观众的 `viewer_excerpts.jsonl`（按 stable `viewer_id` 过滤、注解 ref），不重发其他观众正文。
- 未改 schema 16、结果 Schema 1.3.0、提示词 v13.2、Provider/调度/翻译/汇总/金额/身份/去重规则。

### 0.3 验证

- 新增 `tests/integration/ai-memory-supplement-regression.test.mjs` **10 项**：
  - 首答漏 1 人 + 补答完整 → 2/2、双事实、2 请求、重复 Continue 0 请求；
  - 补答仍缺/错误观众 → 首答保存、缺失观众 failed，Resume 只请求它；
  - 首答完整 → 1 请求、无补答；
  - 补答部分覆盖 → 两份答案的合法观众都保存；
  - 跨观众证据 → 拒绝、首答保留、重试完成；
  - 重复事实 → 引擎去重；
  - 非法 JSON / 空 + length → 首答保留、可恢复；
  - 重启 Resume → 旧结果/事实不变，只请求失败观众；
  - 3 批并发 + 1 批补答非法 → 兄弟批次完成，Resume 只补 1 人，30/30 不重复。
- 全量 **708 passed / 0 failed**（2026-11-14，186,397 ms）。

### 0.4 正式 EXE 与真实数据只读副本

- **正式 EXE**：`dist/LiveMemory.exe` buildId `e441070b57b5` / commit `81be9cd` / SHA-256 `27c0bfbe9227ed15693370c999df0fda7d3d39ffafbffc0b7b9c2ab2a9eb6e58` / 91.9 MB / 176 assets / `requireAdministrator`。
- **回放**（asInvoker 测试副本 + 生产数据只读副本 + 本地 Mock Provider）：
  - 会话 `ses_01M7ACPCM8YB56VCV82S`，新建 memory job `aij_01M7BZPKAJ8WMYGZA8BS`（89 人 / 9 批）。
  - 首轮：批次 2 首答故意漏 1 人、补答返回非法 JSON → `partial`、88/89、8/9 批、10 请求；`bilibili:335118245` failed；首答其余 9 人已保存。
  - 关闭 EXE 后重启同一目录：health 同 build；仍 `partial`、`canResume=true`、88/89。
  - Resume：只 1 次请求、仅失败观众；`complete`、89/89、9/9、requests 10→11；批次 1/3–9 未重发。
  - 回放前 503 条 `ai_results` 全部保留；事实 1,007→1,095→1,096；新 job 10 条结果（9 v1 + b2 v2）；89 条新事实；无重复事实；再次 Resume 0 请求。
- **性质**：正式 EXE + 真实数据只读副本 + Mock Provider 的确定性回放；不是真实付费 Provider 验收，不是生产任务 Resume。

### 0.5 P0-1 结论与下一轮 P0-4 交接

- **P0-1 代码级可关闭**：根因确认、修复前失败可复现、修复后 10/10 回归 + 708/708 全量通过；无 schema/历史数据改动。
- **待用户验收**：真实付费 Provider 的补答质量、真实生产任务 Resume、真实 UAC 双击、真实浏览器点击。不得把 Mock/只读副本写成真实验收。
- 下一轮 **P0-4 YouTube 误判结束** 原始证据：
  - `src/platforms/youtube/anonymous/adapter.mjs:324-333`：429/网络错误也累计到 `maxConsecutiveFailures=8`，随后 `#finish('connection_failed')`。
  - `src/platforms/youtube/anonymous/adapter.mjs:284-288`：`page.ended` 立即 `#finish('chat_ended')`。
  - `src/platforms/youtube/anonymous/parser.mjs:249-258`：HTTP 200 缺 `continuationContents` 返回 `{ended:true,invalid:true}`，adapter 未使用 `invalid`。
  - `docs/PLATFORM_INTEGRATIONS.md:267` 与代码相反。
- 建议：先 Mock 复现；`invalid:true` 按 transient；429/网络/5xx 达阈值进入 FAILED/RECONNECTING 保留 session，不调用 `onEnd`；明确 `chat_ended` 才结束；至少两次独立证据；补 429/断网/异常 200 测试并修正文档。

### 0.6 不要做

1. 不要为了“让任务成功”重发已保存观众/批次。
2. 不要把补答失败降级为“整批成功”；缺失观众必须保持 `failed/pending` 可恢复。
3. 不要绕过 `validateAnalysisImport()` 的完整校验（Schema/身份/证据/覆盖）。
4. 不要给补答增加无上限 token 或无限重试；补答仍只有一次。
5. 不要修改生产数据库或自动 Resume 生产任务；需要用户明确授权与备份。

## 0.7 上一轮（长期画像输出预算、截断恢复与观众级断点）

完整证据：`log/2026-11-13-ai-memory-output-recovery.md`。

### 0.1 真实根因

- 任务 `aij_01M7AJ05B5E2VRG9Z82G`：100 批、975 人；17 条成功结果（1–11、13–18），批次 12 的 10 人与后续 812 人 pending。
- 批次 12 与更早的批次 4 都以 HTTP 200 + `empty-content` 失败（约 33–35 秒无文本），`retry=false`；批次 4 在用户继续后成功。不是批次 12 输入过大导致的确定性问题。
- 适配器空文本时抛 `PROVIDER_RESPONSE_INVALID` 并丢弃 `finish_reason`/usage；length 截断无法识别，也不会自动重试。
- UI 的 `length` 是上一子任务（session aggregate）13:35:54 的陈旧 `lastOutputRejection`；批次 12 错误本身 finishReason=null。b12 是否 length 未持久化，属于推测。
- 分批只看输入；输出固定 6,000；没有拆分映射；进度把任意子结果当批次完成；elapsedMs=null 显示 0。
- 17 个成功批次是并发乱序完成，不是按序号跳过。

### 0.2 实现

- `src/ai/batching/tokens.mjs`：`estimateMemoryViewerOutputTokens`、`resolveMemoryOutputTokens`、输出感知 `planMemoryViewerBatches`、上限 8,192。
- `src/ai/export/split-jobs.mjs`：观众输出成本、批次 `output_budget_tokens`、`estimated_output_tokens`、`max_facts_per_viewer`。
- `src/ai/prompts/split.mjs`：三语事实/证据上限（12 条/人，1–3 证据/事实）。
- `src/ai/providers/adapters.mjs`：保留 finishReason/reasoningChars/usage/metrics；空 + length → `AUTO_OUTPUT_TRUNCATED`；空 + 非 length → `PROVIDER_RESPONSE_EMPTY`。
- `src/ai/runtime/attempt.mjs`：空响应自动重试 1 次；截断不在传输层重试。
- `src/ai/api/runner.mjs`：失败 usage 归属、`recoveryStats`、有界拆分/预算提升、成功子结果立即导入、连续 3 个输出失败停止调度、`lastOutputRejection` 按 Job 隔离、elapsedMs null 修复。
- `src/storage/database/migrations/index.mjs` + `ai-jobs.mjs`：schema 16 `split_path/split_reason`、事务写入、状态读模型。
- `src/ai/tasks/status.mjs` / `recovery.mjs`：计划批次覆盖计数、splitBatches/pendingSplitBatches/splits。
- `src/web/js/pages/ai.js` + 三语 i18n：截断/空响应/自动重试/拆分进度/子批次路径/恢复文案。
- 文档：STATUS、HANDOFF、ROADMAP、AI_CONTRACT §25、DATA_MODEL §19、TEST_PLAN §36、CHANGELOG、本文件、日志。

### 0.3 验证

- 全量 **698 passed / 0 failed**（约 188 秒）。
- 真实任务只读副本 + Mock：17/100、153/975 → complete 100/100、975/975；只请求 b12、19–100；b12 自动拆 12.1/12.2；旧 17 条结果 id/version 全部保留；再次继续 0 请求。
- EXE：`dist/LiveMemory.exe` buildId `4b697b2cb227` / commit `ab32386` / SHA-256 `de9ddc18d6856a8d79df56673ac4e6fff76d56ccd15521020860247631855b44` / 91.9 MB / 176 assets / `requireAdministrator`。asInvoker 测试副本 + 本地 Mock Provider + 生产数据副本实跑：health 同 build；旧任务 `17/100`、`153/975`、`resume-memory`；Resume 后 `complete`、`100/100`、`975/975`、85 次 Provider 请求、b12 自动拆 `12.1/12.2`、旧 17 条结果保留、facts 252。
- 未验证：真实付费 DeepSeek Flash、真实生产任务 Resume（需用户授权）、真实 UAC 双击、真实浏览器点击；b12 原始 finish_reason 未保存。

### 0.4 生产恢复步骤

1. 完全退出 LiveMemory；备份整个数据目录（不要在运行时复制写入中的 SQLite）。
2. 替换为包含本轮修复的 EXE；设置页「关于」核对 buildId。
3. 打开 AI 分析中心，选择 `ses_01M77TP9QYPFRE4H9NCH`；应显示 17/100 批、153/975 人、822 待处理、「继续未完成画像」。
4. 选择与失败任务相同的 DeepSeek / global / deepseek-flash；点击继续。只处理批次 12 与 19–100 的待处理观众，不会重发已保存批次/观众。
5. 若仍失败，查看技术详情：`AUTO_OUTPUT_TRUNCATED` 会显示拆分子批次路径；`PROVIDER_RESPONSE_EMPTY` 表示已自动重试一次仍为空。不要新建整场分析、不要清空数据。
6. 成功后任务 complete、恢复面板消失；已保存事实不会重复写入。

### 0.5 下一轮注意

1. 不要为了“让任务成功”重新发送已保存的 17 个批次/153 位观众，也不要按“从失败批次之后全部重跑”。
2. `split_path` 是恢复边界；修改拆分算法时必须保持原 `batch_index`、证据 seq、事实 id/topic 不变。
3. 空响应自动重试只允许 1 次；截断必须先缩小批次或单观众预算，不得无上限提高 max_tokens。
4. 新增输出错误码时同步更新 `runner.mjs`、`recovery.mjs`、`ai.js`、三语 i18n 与测试。
5. 正式 EXE 已更新；后续改代码必须重建。

## 0.8 上一轮（分层汇总与 32 批恢复）

完整证据：`log/2026-11-13-ai-hierarchical-aggregate.md`。

### 0.1 真实根因

- 任务 `aij_01M7AD29G42TSN0DCFXA`：DeepSeek Flash，32/32 批次已保存，final 缺失，`ANALYSIS_AGGREGATE_TOO_LARGE`。
- 失败详情 `estimated 64471 input tokens, limit 48000`；`contextLength=null`。旧代码把全部 32 个 batch results 放进一个 final 请求，compact 后仍 64,471 > 程序硬上限 48,000，**请求从未发出**。
- 累计 1,123,093 输入是任务级 usage（32 批 + 5 次批次修复 + 更早子任务），不是单次汇总输入。模型实际 1M 上下文并未被使用；这是程序保守预算与“单请求汇总”设计的问题。
- 旧恢复把该错误归为 `change-model`，32/32 已保存任务无法继续。

### 0.2 实现

- `src/ai/aggregate/hierarchy.mjs`：预算/连续分组、单组超预算二分、level 1..N、final unit 上限、确定性 digest/final、batch/unit 覆盖、证据 ref 校验、事件去重与时间排序、`ensureFinalBatchEvidence()`。
- `src/ai/batching/tokens.mjs`：`resolveAggregateContextBudget`（已知 context 或保守 64k）、`resolveAggregateInputLimit`（输出预留 + 500，单请求 ≤192k）、`resolveDigestOutputTokens`。
- `src/ai/api/compact.mjs`：`buildAggregateDigestSchema`（有界局部汇总）与 `buildAggregateFinalEnvelopeSchema`（final 必须/可带 covered_batches）。
- `src/ai/api/prompts.mjs`：三语 `buildAggregateDigestPrompt`；`buildSessionAggregatePrompt` 支持 partial reports、coverage ledger、retry note。
- `src/ai/api/runner.mjs`：`#runSessionAggregate` 先判断 direct final 是否装得下；否则 `#runHierarchical`；`#runDigestGroup` 每个节点独立持久化、source hash 复用、最多 2 次输出尝试、确定性兜底；`#runFinalSynthesis` 同样有界重试/兜底/导入；`aggregate` 状态进入 `/api/ai/analyze/status`。
- `src/storage/repositories/ai-aggregate-nodes.mjs` + migration 15：`ai_aggregate_nodes`（level 0 final，level>0 局部节点），usage/coverage/fallback 全部持久化。
- `src/ai/tasks/recovery.mjs`：`ANALYSIS_AGGREGATE_TOO_LARGE` 不再 `change-model`，32/32 + final 缺失提供 `resume-aggregate`。
- `src/web/js/pages/ai.js` + 三语 i18n：分层节点进度、确定性兜底提示、恢复文案“只处理未完成 final/局部汇总”。
- 清理路径：删场次/清空数据包含 `ai_aggregate_nodes`；`assertNoResidue` 覆盖。

### 0.3 验证

- 全量 **683 passed / 0 failed**（约 163 秒）。
- 生产任务只读副本：原任务 32/32 → 2 个局部节点 + 1 次 final → complete；final 引用 32/32 批次；0 次 batch 重发；节点 usage 计入任务统计。
- 正式 EXE：buildId `68b663eec6fe` / commit `1070261` / SHA-256 `39562ce976ae…` / 91.9 MB / 176 assets / requireAdministrator。asInvoker 测试副本实跑：health 同 buildId；旧任务状态 `resume-aggregate`；Resume 后 complete、32/32、2 节点、3 次汇总请求、final 32/32 refs、无 batch 重发。
- 未验证：真实付费 DeepSeek 分层请求质量、真实生产任务 Resume（需用户授权）、真实 UAC 双击、真实浏览器点击（沙箱限制）。

### 0.4 生产恢复步骤

1. 完全退出 LiveMemory；备份整个数据目录。
2. 替换为 buildId `68b663eec6fe` 的 EXE，设置页「关于」核对。
3. AI 分析中心选择 `ses_01M77TP9QYPFRE4H9NCH`；应显示 32/32、最终汇总未完成、「继续最终汇总」。
4. 点击继续；只做局部汇总 + final，不会重新分析 32 个 batch。
5. 成功后 final 保存、任务 complete；若局部输出仍截断，程序会做一次有界重试并确定性兜底，不新建整场分析、不清空数据。

### 0.5 下一轮注意

1. 不要为“让汇总成功”恢复单请求全量拼接；超过预算必须分组/加层。
2. 节点 source hash 是复用边界；修改 digest schema、prompt 或 batch condense 必须使旧节点失效。
3. final 的 `ensureFinalBatchEvidence` 只补已保存结果中的真实 ref，不允许填充不存在的 seq/批次。
4. 新增失败码时同步更新 `recovery.mjs`、`ai.js`、三语 i18n 与测试。
5. 正式 EXE 已更新；后续改代码必须重建，旧 EXE 没有分层汇总。

## 0.6 上一轮（最终汇总截断与恢复）

完整证据：`log/2026-11-13-ai-aggregate-recovery.md`。

### 0.1 真实根因（已确认）

- 任务 `ses_01M77TM1Q80HQ4XSZTMV` / `aij_01M79KZEFWBCCJP8G1JK`：dashscope `qwen3.7-flash`，18 批全部保存，final 缺失。
- 汇总 `maxTokens=8000`、`maxCompletionTokens=24000`、`estimatedInputTokens=34048`、199,729ms，`finish_reason=length` → `AUTO_OUTPUT_TRUNCATED`。输入 34k < 48k，不是输入超限。
- 20 次请求全部 HTTP 成功（18 批 + 1 次批次修复 + 1 次汇总）；输出完整性失败发生在请求统计之后。
- `Number(null)===0` 把汇总失败的 `batchIndex` 持久化为 0；旧库/旧状态出现假“批次 0”。
- 旧 UI 只有与暂停共用的泛化「继续」按钮，没有汇总专属动作、说明或明确恢复面板；后端当时 `canResume=true`，未复现按钮被隐藏的具体渲染路径。

### 0.2 修复

- `src/ai/batching/tokens.mjs`：`resolveAggregateOutputTokens()`，12k–16k 独立预算，按上下文收缩。
- `src/ai/api/compact.mjs`：`buildSessionAggregateAnswerSchema()` 有界汇总 schema（不改原 schema、不含 viewer_profiles）。
- `src/ai/api/prompts.mjs`：三语汇总提示词加入输出上限、合并优先、每批覆盖；`condenseBatchResult()` 支持 compact 第二遍，保留全部批次/证据。
- `src/ai/api/runner.mjs`：独立预算、compact 预检、`outputStats`/`outputRejected`、`finishReason`、`batchIndex` 规范化、`recovery` 状态、complete 时 resume 幂等。
- `src/ai/tasks/recovery.mjs`：aggregate/session/memory/config 四类恢复动作与 `canResume`；18/18+final 缺失只给 `resume-aggregate`；装不下给 `change-model`。
- `src/ai/tasks/status.mjs`、`src/storage/repositories/ai-jobs.mjs`：不再把 null/0 当批次；旧数据读取兼容。
- `src/web/js/pages/ai.js` + `styles/pages.css`：独立恢复面板；「继续最终汇总」调用真实 `/api/ai/analyze/resume`；页面刷新/重启恢复；不再用共用暂停按钮充当恢复。
- 三语 i18n：`ai.center.recovery.*`、`incomplete`、`errorMeta.*`、`stats.outputRejected|savedResults|apiNotAnalysis`；更新 `AUTO_OUTPUT_TRUNCATED` 文案。
- 文档：STATUS、ROADMAP、AI_CONTRACT、UI_DESIGN、DATA_MODEL、TEST_PLAN、CHANGELOG、本文件、log。

### 0.3 测试

- 全量 **668 passed / 0 failed**（约 130 秒）。
- 新增 `tests/integration/ai-aggregate-recovery.test.mjs`（18 批截断/重启后只发汇总/checksum 不变/重复点击幂等/无效汇总统计）、`tests/unit/ai-aggregate-budget.test.mjs`、`ai-recovery-state.test.mjs`、`ai-recovery-ui.test.mjs`。
- 关键证据：继续前 18 条 batch 结果的 id/version/checksum 与继续后完全一致；继续请求 0 次批次、1 次汇总；重复 Continue 0 次 Provider 请求。
- **隔离 EXE 已验证**：`dist/LiveMemory.exe` 重建为 buildId `61da4c6991e1` / commit `205db74` / SHA-256 `7231c056…` / 91.8 MB / 174 assets / `requireAdministrator`。asInvoker 测试副本（仅测试设置 `LIVE_MEMORY_SKIP_ADMIN_CHECK=1`）实际启动：`/api/health` 同 build、`/api/bootstrap` schema 14、打包 `ai.js`/三语字典含恢复面板；对生产 DB/runtime 只读副本查询真实 18/18 任务，`/api/ai/analyze/status` 返回 `resume-aggregate`、`outputStats.responses=20/rejected=1`、`batchIndex=null`。
- **未验证**：真实付费 Provider、真实生产任务 Resume、真实浏览器点击/截图、真实 UAC 双击。

### 0.4 生产失败任务的安全恢复步骤（需用户明确授权）

1. 完全退出 LiveMemory；备份整个数据目录（`E:\新建文件夹` 或设置页显示的真实位置），不要在运行时复制写入中的 SQLite。
2. 替换为包含本轮修复的构建；在设置页「关于」核对 buildId。
3. 打开 AI 分析中心 → 选择 `ses_01M77TM1Q80HQ4XSZTMV`；应显示「AI 分析未完成」、单场批次 18/18、最终汇总失败/未完成、原因与「继续最终汇总」。
4. 选择与失败任务相同的 Provider/区域/模型；点击「继续最终汇总」。恢复只请求 final，不重发已保存的 18 批。
5. 成功后 final 保存、任务 complete、按钮消失；若仍失败，查看技术详情（错误码/阶段/结束原因），不要新建整场分析、不要清空数据、不要删除已保存批次。
6. 若错误为 `ANALYSIS_AGGREGATE_TOO_LARGE`（上下文不足），面板会显示「前往设置更换模型」而不是可用的「继续」；更换模型后从新任务继续前，应先备份并确认不会重做已保存批次（当前同任务 Resume 不允许更换模型）。

### 0.5 下一轮注意

1. 正式 EXE 已包含本轮修复（buildId `61da4c6991e1`）；后续若改代码必须重新构建，旧 EXE 没有独立汇总预算与恢复面板。
2. 不要为了“重试”自动重发截断请求；截断后只允许用户点击 Continue，且只重做缺失的 final。
3. `outputStats.rejected` 是“成功响应但输出不可用”的计数，不要加进 HTTP 失败数；也不要把 HTTP 成功解释为分析完成。
4. 若未来允许“汇总阶段更换模型”，必须只允许在全部批次已保存且 final 缺失时进行，并保留同一 job / 同一批次 checksum，不得重做批次。
5. 新增恢复类型时，必须同时更新 `recovery.mjs`、`ai.js`、三语 i18n 与测试。

## 0.7 上一轮（多语言输出与报告翻译）

完整记录：`log/2026-11-13-ai-report-translation.md`。

### 0.1 审计结论

- 已有：分析中心有独立「分析语言」；`locale` 写入 Session/Memory 两个 job；包内说明与 Prompt 按 locale 生成；界面语言切换不影响已创建任务。
- 缺口：报告没有阅读语言切换；长期画像只能按原语言；没有翻译缓存/分段恢复/独立 usage；「分析语言」文案与界面语言容易混淆；Prompt 未明确任意/混合语言原文不逐条预翻译。
- 未重做：结果 Schema 仍 1.3.0，Session/Memory 批次、Resume、Compact 校验、观众级容错、事实操作均未改变。

### 0.2 实现

- **功能 A**：AI 中心文案改为「分析输出语言」并增加说明；Prompt v13.2 明确「原文可能是任意/混合语言，直接理解并用 locale 输出，不逐条翻译」；Session 与 Memory 共用任务 locale；状态返回 `locale`，UI 显示「本次任务输出语言（已随任务保存）」。
- **功能 B**：报告页新增「报告语言」选择器；首次切换提示会调用 Provider 并可能产生费用；已有缓存直接显示；原文/翻译 chip；失败红色提示与「重试未完成段落」；无可用 Key 时原文仍可读。
- **翻译架构**：原始分析结果 + 段落级展示缓存。只翻译自然语言字段，绝不写 `ai_results` / `viewer_memories` / `memory_facts`；`viewer_id`、`topic`、事实 ID/状态/certainty/版本/证据/时间/金额/枚举/原始聊天均不翻译。
- **缓存**：`ai_translations` 以原始对象 ID + 字段路径 + 源文本 SHA-256 + 目标语言 + `lm-translation-v1` 为键；`ai_translation_runs` 保存独立运行状态与 usage。结果新版本或事实文本变化不会误用旧翻译；失败只替换失败段。
- **数据生命周期**：翻译表随场次级联删除；删除观众记忆同时删除其事实/摘要翻译；清空数据包含两张新表；v13→v14 只新增表/索引。
- **费用**：翻译 usage/费用只写 `ai_translation_runs`，不混入 `ai_jobs`；未知价格 `cost=null`，显示「费用未知」；复用现有 Provider 配置、超时、重试/429 与 URL 安全检查，非流式请求。

### 0.3 API

```text
GET  /api/ai/sessions/:id/report?locale=zh-CN|ja|en   只读；只应用缓存，不调用 Provider
GET  /api/ai/sessions/:id/translation?locale=...      状态/缓存计数/运行进度/可用配置
POST /api/ai/sessions/:id/translation                 {locale, configId, consent:true}
```

报告新增 `reportLocale`、`displayLocale`、`translation`。错误码：`TRANSLATION_LOCALE_INVALID`、`TRANSLATION_NOT_NEEDED`、`TRANSLATION_CONSENT_REQUIRED`、`TRANSLATION_PROVIDER_REQUIRED`、`TRANSLATION_CREDENTIAL_MISSING`、`TRANSLATION_NO_TEXT`、`TRANSLATION_ALREADY_RUNNING`、`TRANSLATION_SESSION_NOT_FOUND`。

### 0.4 测试

- 全量 **649 passed / 0 failed**（约 155 秒，`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`）。
- 新增 `tests/unit/ai-translation.test.mjs`、`tests/unit/ai-translation-ui.test.mjs`、`tests/integration/ai-report-translation.test.mjs`、`tests/integration/ai-translation-migration.test.mjs`；更新 schema 14 相关迁移断言与 `ai-api` / `memory-api` 状态断言。
- 覆盖 A–J：日语→中文、存档报告切换不重跑分析、缓存复用、部分失败重试、长期事实结构不变、翻译中断/失败保留结果、新版本隔离、证据清理、无 Provider/Key/网络失败、旧 Schema 1.1.0、三语 UI 静态断言。
- **未验证**：真实付费 Provider、真实浏览器窄屏截图、正式 EXE（未重建）、真实生产库迁移。

### 0.5 下一轮注意

1. 如需发布 EXE，必须重新构建，使 schema 14 迁移与翻译代码进入二进制；旧 EXE 不能读取 schema 14 数据库。
2. 翻译缓存是展示派生数据；不要在后续“事实合并/回滚”中把翻译文本当作事实来源。
3. 若新增可翻译字段，必须同时更新 `src/ai/translation/fields.mjs`、`TRANSLATION_VERSION`、三语字典与测试。
4. 不要为了“统一语言”批量改写历史事实；本轮只做按需展示翻译。


## 0.6 上一轮（真实 AI_IMPORT_INVALID 与观众级容错）

完整证据：`log/2026-11-13-real-ai-import-invalid-investigation.md`。

### 0.6.1 真实根因

- 任务 `aij_01M7963928KHJGNJTD64`（memory-only，47 观众/5 批）批次 5 失败；批次 1–4 已保存 40 名 semantic，批次 5 的 7 名 pending。
- 批次 5 中 `seq 3` 属于 `bilibili:1765635337`（ref 5），`seq 5` 属于 `bilibili:5240206`（ref 3）。模型为 ref 5 引用了 seq 5 → `MEMORY_EVIDENCE_OTHER_VIEWER`。
- 包/数据库映射一致；根因是 **ref 与 seq 两套小整数编号混淆**，旧 Prompt 的 excerpt 行没有 `ref`，契约未明确“ref≠seq”。
- 自动修复确实发送过：批次 5 初始（schema type/enum 错误）+ 1 次 whole-batch repair（修复后跨观众证据）；旧版只允许一次修复，随后整批失败。任务总 usage 8 请求 / 77,204 input / 37,327 output；费用 unknown。

### 0.6.2 修复

- Prompt：excerpt 行增加本地 `ref`；契约明确 ref/seq 不同命名空间；repair 增加 `MEMORY EVIDENCE GUARD`；错误携带 `allowedSeqs`。
- 观众级：whole-batch repair 失败后按 `viewer_memory_updates[i]` 拆分；合法观众在 `viewerIds` 作用域重新完整校验并导入；非法观众标记 `failed` 且不写事实；再一次 viewer-scoped repair（只发失败观众/证据），成功合并，失败保留可恢复。
- 事务：合法事实/证据/覆盖状态与 failed 状态同一事务；恢复结果追加同一批次的 `ai_results` 新版本，只含恢复观众。
- 调度：批次级校验错误不再停止后续批次（concurrency=1/4 验证）；Provider/取消/数据库错误仍停止新调度。
- Resume：按 pending/failed 观众构造子集 Prompt；只请求未完成观众。旧任务批次 5 的 7 人全是 pending，旧版没有保存其中合法 6 人，因此旧任务 Resume 会处理这 7 人，不能只挑 1 人。
- UI：coverage 增加 failed；partial 显示已处理/未完成/失败等待恢复；报告 stats 使用 failed。

### 0.6.3 验证

- 全量：**632 passed / 0 failed**（约 112 秒）。
- 真实任务副本（只读 DB+包，Mock）：
  - 普通 Resume 只请求 1 次（批次 5 的 7 名 pending），complete 47/47。
  - 模拟真实 ref/seq 错误：3 次请求（initial + whole repair + viewer repair），complete 47/47、41 semantic、0 failed，无跨观众写入。
- 未验证：真实付费 API、生产任务 Resume、真实浏览器 UI、UAC。

## 0.2 上一轮（v0.13.2 AI 分析可靠性）

### 0.1 核心修复

- Memory 回答统一走「Compact 组装 → `validateAnalysisImport()` 完整校验 → 最多一次定向修复/精确错误修复 → 再校验 → 事务导入」。ref 覆盖完整不再绕过 Schema/身份/证据/枚举校验。
- `assembleMemoryCompact()` 对 `memory` 只接受 `summary` / `summary_certainty` / `no_new_information` / `operations`；`viewer_id` 始终由本地映射最后注入；模型提供的身份/未知字段被丢弃并只记录字段名。
- `fail()` 保留字段级错误、stage、job/batch id、恢复建议；`GET /api/ai/analyze/status` 提供 `error.errors`、`batchErrors`、`memoryJob.failedBatches`。
- `ai_jobs.last_error_json` 增加 `batches[]`；导入成功只清除对应批次，其他并发批次失败保留；旧扁平格式兼容。
- 长期画像 Provider 提示词改为当前运行时 `buildMemoryInstructions()` + 单一 Compact 契约；三语示例本地化，不再出现固定 `"locale": "en"`；`topic` 作为匹配键，续写时复用原值。
- 事实规则明确 stated/inferred/uncertain、本人证据、禁止编造、允许 no_semantics。
- 报告新增 `longTermProfiles.stats`；AI 中心显示已处理/语义/仅客观/未完成与真实错误详情。
- usage 按 session/memory 子 Job 归属，任务总计由两者相加；修复/重试计入真实 usage。

### 0.2 涉及文件

- `src/ai/api/compact.mjs`、`src/ai/api/runner.mjs`、`src/ai/api/prompts.mjs`
- `src/ai/prompts/split.mjs`、`src/ai/constants.mjs`
- `src/ai/import/importer.mjs`、`src/ai/tasks/status.mjs`
- `src/storage/repositories/ai-jobs.mjs`、`src/server/serializers.mjs`
- `src/analytics/ai/report.mjs`、`src/web/js/pages/ai.js`、`src/web/js/pages/ai-report.js`
- `src/web/i18n/{zh-CN,ja,en}.json`
- 新增 `tests/unit/ai-compact-memory.test.mjs`、`tests/integration/ai-memory-reliability.test.mjs`；更新 `tests/unit/ai-ui.test.mjs`
- 文档：STATUS、HANDOFF、ROADMAP、AI_CONTRACT、DATA_MODEL、TEST_PLAN、CHANGELOG、UI_DESIGN、PRIVACY_SECURITY、log。

### 0.3 测试

- **628 passed / 0 failed**（2026-11-13，约 120 秒，`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`）。
- 覆盖 A–O 中的 A/B/C/D/E/F/G/H/I/J/K/L/M；N/O 由既有 schema 兼容/单场回归测试覆盖。
- **未验证**：真实 Provider、真实浏览器 UI（沙箱禁止浏览器命名管道）、真实生产任务 Resume。

### 0.3.1 历史英文事实与新日文画像并存的处理

- 不自动翻译、覆盖或删除历史 `memory_facts`；事实的 `id`、`source_*`、证据关联与版本关系保持原样。
- 现有画像页会按事实逐条展示 `topic`/`statement`；旧英文事实与新日文事实可能并存，这是历史真实状态，不应伪装成已统一。
- 可选的安全处理（需用户逐条授权）：由用户在观众详情中人工复核后新增/更新事实，或用相同场次重新生成受控结果；程序不提供批量翻译。
- 未来生成由任务 locale 决定；`topic` 续写时复用旧 topic，避免同一概念因翻译产生重复事实。
- 历史英文事实的语义不会被自动改写；若需要语言统一，建议先备份再逐条核对，而不是批量脚本。

### 0.3.2 失败模型回答暂存（只给方案，本轮未实现）

审计建议保留“已付费但导入失败”的原始回答以避免再次付费。本轮**没有实现持久化**，原因与安全方案如下：

- 持久化必须加密（复用本机凭据加密层）、有明确生命周期（例如仅保留到该批次成功或用户删除）、大小上限（例如单批 ≤ 2 MB）、自动清理与用户可见的隐私说明。
- 不得进入普通日志、诊断包、配置 JSON、ZIP 或任何上传；不得发送到开发者服务器。
- 读取/重新校验必须复用同一 `validateAnalysisImport()` 与事务导入，且仍受身份/证据/Schema 约束。
- 更简单的替代方案：保留已通过校验的批次结果（当前行为），失败批次由用户决定是否 Resume；自动修复已把单次失败成本降到最多一次额外请求。
- 若未来实现，建议新增独立的加密暂存目录与“仅本机、可一键清除”的设置项，并先做隐私评审；本轮不引入。

### 0.4 生产失败任务的安全恢复步骤（需用户明确授权）

场次 `ses_01M77TJXG9VP4VAGNSXY`（392 条消息、37 名可识别观众；单场报告完成；画像 1/3/4 成功、第 2 批失败、缺 10 人）：

1. **先备份数据目录**（至少复制 `%LOCALAPPDATA%\LiveMemory` 到独立位置；不要在软件运行时直接复制 SQLite 主库，使用软件已有快照/退出后再复制）。
2. 完全退出 LiveMemory，替换为新版本 EXE/源码构建；确认设置页「关于」的 buildId 与新版本一致。
3. 打开 AI 分析中心，选择该场次；选择与失败任务**相同**的 Provider/区域/模型配置。
4. 页面应显示失败批次与「查看技术详情」；确认错误属于可恢复的校验/Provider 错误，且 `canResume=true`。
5. 点击「继续」。恢复只会处理未导入批次（第 2 批）；已完成批次、单场报告与 1/3/4 批事实不会重发。
6. 若仍失败，技术详情会显示批次、字段路径与错误码；不要重复点击；把错误码/批次（不要发聊天原文或 Key）反馈。
7. 恢复后的新事实使用当前 locale（日语）与 v13.1 提示词；旧英文事实保留。若需要统一语言，只能逐条人工复核/重新生成，程序不做批量翻译（见 §0.3.1）。
8. 恢复完成前不要把任务标记为整体成功；UI 只有全部批次通过校验后才显示 complete。

**注意**：旧任务创建于 v13 提示词时代，包内 `instructions.md` 仍是旧文件；新代码在发送 Provider 请求时使用当前运行时 instructions，所以第 2 批会使用新语言/事实规则。任务记录中的 `prompt_version` 仍是创建时的 `lm-prompt-v13-memory-ja`，这是历史事实，不篡改。

### 0.4.1 `AI_IMPORT_INVALID` 专项验收（2026-11-13）

完整证据：`log/2026-11-13-ai-import-invalid-acceptance.md`。

- 旧代码 `3fccba1`，392 条合成消息 / 37 观众 / 4 批（10/10/10/7），三个变体均复现：`AI_IMPORT_INVALID`、27/37、无 stage/字段错误、无 repair、成功批次清空失败记录。
- 新代码 `e67677a` 同条件全部 complete 37/37；缺证据/跨观众证据触发一次 repair；伪造 `viewer_id` 直接被本地映射覆盖。
- 修复仍失败：精确显示 `MEMORY_EVIDENCE_REQUIRED`、stage=validation、batchIndex=2、`batchErrors=[2]`；重启 Resume 只重试 b02，最终 37/37。
- 隔离 EXE（buildId `c51819b2f3f3`，requireAdministrator；asInvoker 测试副本）通过本地 Mock Provider 完成同样三项验收。之后用户明确授权覆盖正式 EXE：`dist/LiveMemory.exe` 已重建为 buildId `caece0818f11` / commit `2b0ade6` / SHA-256 `c827a609…`，Manifest 仍为 requireAdministrator；asInvoker 测试副本实际启动验证 `/api/health`、`/api/bootstrap` 返回同一 build，schema 13。旧 EXE 备份在 `tests/.tmp/LiveMemory-pre-r5-backup.exe`。
- 2026-11-13 r6（观众级容错）：正式 EXE 再次重建为 buildId `9b8daa7b2d1d` / commit `2df6052` / SHA-256 `9b3eea3e…` / 91.7 MB / 169 assets / requireAdministrator。用生产库与 b05 包只读副本 + 本地 Mock Provider，在 asInvoker 测试副本中 resume `aij_01M7963928KHJGNJTD64`：模拟真实 ref/seq 错误，3 次请求（initial + whole repair + viewer repair）后 complete 47/47、41 semantic、0 failed；批次 1–4 未重发。独立生产数据副本已删除，正式 EXE 保留；旧 EXE 备份 `tests/.tmp/LiveMemory-pre-r6-backup.exe`。
- 原始失败的具体非法字段未保留，无法断言当时是三个变体中的哪一个；但导致该错误的结构性代码路径均已复现并修复。

## 0.5 上一轮（观众身份专项）

### 0.1 结论

- Bilibili 场次 `ses_01M75S69P4H0NSX87PD4`：727 条消息，726 条弹幕全部无 UID，只有 1 SC + 2 大航海带 UID，去重后 2 人。
- 根因是平台未登录弹幕风控（昵称打码、uid=0）＋ 页面把「可识别观众」标成「独立观众 / 本场参与人数」且隐藏 726 条未识别消息。数据库、JOIN、迁移、缓存均无丢人。
- 另一场 Bilibili 也是 206/206 条无 UID、0 可识别观众；四场 YouTube 0 条未识别。判定 B（平台特定）+ D（UI 口径），不是单场、不是全平台。
- 历史计数可重算；726 条弹幕的真实身份不可恢复；实际观看人数未知。

### 0.2 修改

- `src/shared/events.mjs`：`uid=0`/`"0"` 规范为无身份，`buildViewerId` 不再生成 `platform:0`。
- `sessions.mjs`、`history-search.mjs`、`monitor-targets.mjs`、`summary.mjs`、`serializers.mjs`、`routes.mjs`：新增 `unidentified_message_count` / `unidentifiedMessageCount` 派生指标与 `identityCoverage`。
- `history.js`、`live.js`、`ai.js`、`session-actions.js`、`pages.css`：统一「可识别观众」标签，行内徽标、详情警告、AI 规模行与画像覆盖提示。
- 三语 i18n：修正「登录不会改变身份字段」，改为未登录可能触发打码/UID=0 的警告；登录标题改为「建议」。
- 新增 `docs/AUDIT_VIEWER_IDENTITY_2026-11-12.md`；更新 PLATFORM_INTEGRATIONS、DATA_MODEL、UI_DESIGN、STATUS、TEST_PLAN、ROADMAP、CHANGELOG 与本文件。

### 0.3 测试

- **610 passed / 0 failed**（约 119 秒）。
- 新增 `tests/integration/identity-stats.test.mjs`（多消息/多用户/同名不同 UID/UID 缺失/数字 0/数字与字符串类型/礼物/SC/大航海/跨场次/跨页面一致），`tests/unit/identity-labels.test.mjs`；`events.test.mjs` 增加 UID=0。
- 数据库副本启动实测三条 HTTP 路径均返回 `727 / 2 / 726`，重启不变。
- 未验证：登录后是否 100% 解除 Bilibili 打码；原始帧未保存；未做浏览器截图。

## 1. 上一轮：v0.13.2（构建可验证与分批预算）

### 0.1 构建/版本识别

- 新增 `src/shared/build-info.mjs`：开发读 `.git/HEAD`；打包读 `build-info.json` + bootstrap 环境。`buildId = <commit7>.<sourceHash8>`。
- 构建脚本写入 commit / sourceHash（含 `scripts/sea-bootstrap.cjs`）/ assetHash / 每文件 SHA-256；断言 7 个可靠性模块存在；构建后检查 EXE 内含 buildId 与模块名。
- bootstrap 复用缓存前逐文件校验 169 个 SHA-256；不一致 `app-root.stale` 后删除重解压；解压后再校验；结果写入 `build.identity` 日志。
- 启动日志、`--version`、设置页「关于」、`/api/health`、`/api/bootstrap`、`/api/status` 均显示 build。
- **最终构建**：`89bf47ac620e` / commit `b101bd0` / SHA-256 `aa3d4110…` / 169 assets / requireAdministrator。asInvoker 副本实际启动后 `/api/health`、`/api/bootstrap` 返回同一 build，第二次启动 `filesVerified=169`。

### 0.2 分批预算

- 默认总输入预算 8k → **24k**；预算拆成 overhead / content / output reserve；内容至少 50%（且 ≥1k），不再让 6.9k 固定开销吃掉 8k。
- 真实 889 消息包：8k=24 批、16k=11 批、24k=**6 批**、32k=4 批；每档 889/889 覆盖；不再出现 125 批。
- 未回退 135k 单请求：上限 32k。
- 保护：aggregate 48k 硬上限 + 上下文检查；repair 只截断上次回答并显式 `ANALYSIS_REPAIR_TOO_LARGE`；单观众硬上限 48k；上下文不足 `ANALYSIS_CONTEXT_TOO_SMALL`。

### 0.3 输出/思考模式

- 官方文档确认 Qwen `max_tokens` 只限回答，思考另计；qwen3.8-max 默认 `reasoning_effort=xhigh`、`thinking_budget=131072`。
- DashScope 增加 `max_completion_tokens = 回答预算 + 16k`，不关闭思考；其他 Provider 不发送。
- attempt 日志新增 requestBytes / estimatedInputTokens / maxTokens / maxCompletionTokens / reasoningChars / reasoningTokens。

### 0.4 测试

- **597 passed / 0 failed**（约 93 秒）。新增 build-info、adapter output、repair guard；batching 增加 889/124 viewer/硬上限；bootstrap 增加缓存篡改重解压。
- 未验证：真实付费 API、真实 UAC 双击、`max_completion_tokens` 在百炼的实际接受度、889 消息真实回放。

### 0.5 任务完成优先（最终修订）

- 真实路径：15:48:40 第 7/7 批后已发出 aggregate；15:55:58 aggregate 在 435,770 ms 被 `maxTotalMs`（剩余任务预算）中止，20:00 标记 `ANALYSIS_TASK_TIMEOUT`。不是阻止汇总启动。
- **删除任务时间上限**：`createTaskBudget`、soft/hard deadline、`maxTotalMs`、按剩余时间缩短请求全部移除；任务可任意久运行。
- **删除费用预算**：预算输入/校验/确认、累计费用停止、价格未知阻止、免费/付费分类全部移除；价格仅可选展示。
- 单请求只保留首响应 `timeoutMs` 与 60 秒流空闲；超时/401/402/404/429/5xx/网络 → `needs_action`，已完成批次保留，可继续；用户取消立即 `canceled`。
- 规模：删除总批次/总消息/总观众拒绝；按单批 Token 自动拆分；仅保留单批 32k、单观众 48k、1M 消息/200k 观众极端内存保护。
- 测试 **603 passed / 0 failed**；新增可选价格与 2500 观众无总批次上限；`v14-task-budget` 改为无时间上限 + timeout needs_action + 汇总-only 恢复。

## 1. 上一轮：v0.13.1 可靠性专项

### 0.1 超时与重试

- `TimeoutError`、外部 `AbortError`（取消/暂停）、网络、429、5xx、4xx、无效响应、流中断现在由 adapter 分类；取消绝不重试。
- 已发出且超时的长请求**默认不自动重发**；只有连接阶段网络错误允许一次安全重试；429/5xx 保留有界退避。
- 任务级 20 分钟预算（**最终修订已彻底移除**；现在只有单请求首响应/空闲超时）。
- `runPool` 失败只停止调度新批次，在途兄弟批次继续完成并导入；恢复只处理未完成批次。
- 每次尝试写 `ai.request.attempt` 脱敏日志；状态新增 `attemptStats`、`currentRequest`、`lastRequest`、`taskDeadlineAt`、`saved`。

### 0.2 Token 分批与流式

- `src/ai/batching/tokens.mjs`：session 消息与 memory 观众按估算 input token 分批；v0.13.1 默认 8k（**v0.13.2 已改 24k，并分离固定开销**），配置 `batchInputTokens` 2k–32k，小上下文自动缩小。
- 多批 session 需要 final aggregate；聚合 prompt 只使用已校验批结果，证据必须 `{batch, seq}`。
- memory：同一观众不拆批，预算计入摘录/现有记忆/证据列表；超预算观众单独成批，不丢人。
- 自动流式：OpenAI-compatible SSE + Anthropic Messages SSE；Provider 返回 JSON 或拒绝 stream 时自动回退一次并持久化响应模式。
- 流式只缓冲，完成后仍走原校验/事务导入；中断流不写库。

### 0.3 UI 与统计

- AI 中心新增：单场批次 n/N、等待汇总、已收到模型输出、请求运行秒数、重试状态、已保存批次、真实失败原因。
- 统计分开：尝试/成功/失败/取消/超时/重试；失败无 usage 显示“用量未知”。
- ETA 需要 ≥3 个成功批次样本；含 session 的任务不再显示错误的固定“1 个请求”，改为自动分批。
- 修复全局 `[hidden]` 被 `.callout {display:flex}` 覆盖的问题。
- 真实浏览器（headless Edge + CDP）截图：运行中、完成、390px、设置页；见 `docs/screenshots/ai-reliability-*`。

### 0.4 测试

- 全量 **583 passed / 0 failed**（约 96 秒）。
- 新增 `ai-attempts`、`ai-stream`、`ai-token-batching`、`v14-session-batching`、`v14-streaming-timeout`；更新 `ai-progress`。
- 未验证：真实付费 API、真实 174k token 大场、真实 EXE/UAC。

## 1. 上一轮：七项实际使用修复（2026-11-11）


| # | 问题 | 结论/修复 | 验证 |
| --- | --- | --- | --- |
| 1 | 历史跳转未选中场次 | `query.session` 按稳定 id 选中；不在前 100 行时按 id 加载；手动选择更新 URL | `ai-selection` + 静态 UI |
| 2 | 已配置 Key 仍显示未配置 | `providerConfigState()` 区分无配置/缺 Key/测试失败/未检测/缺价格；删除历史文案 | `ai-config-state` + Provider 列表 |
| 3 | 无实时进度 | 批次/观众计数进度条 + 不确定动画 + 1.5s 轮询 + statusEpoch | `ai-progress`、`v13-progress`；真实浏览器未验收 |
| 4 | `Memory No viewers` | combined 无观众保留单场报告并显式跳过；memory-only 明确错误；状态含 `memorySkipped` | `v13-api-runner` |
| 5 | 报告重复 | `reportEpoch` 单飞，只有一个挂载点 | 静态 + 报告并发守卫 |
| 6 | Bilibili 未开播无主播名 | `Master/info` 公共回退；target 持久化并低频重试 | 真实房间 3 未开播 → `3号直播间` |
| 7 | 手动停止后自动恢复 | `live_stopped` + `meta.manualStop` 持久抑制；确认离线/新 live cycle 才解除；重启保持 | 场景 A–G 测试 |

新增文件：`src/web/js/pages/ai-progress.js`、`ai-config-state.js`、`ai-selection.js`；`tests/unit/ai-progress.test.mjs`、`ai-config-state.test.mjs`、`ai-selection.test.mjs`、`bilibili-master-info.test.mjs`；`tests/integration/v13-progress.test.mjs`、`manual-stop-monitor.test.mjs`。

修改重点：`src/web/js/pages/ai.js`、`src/ai/api/runner.mjs`、`src/monitoring/manager.mjs`、`model.mjs`、`detectors/bilibili.mjs`、`src/platforms/bilibili/api.mjs`、`service.mjs`、`src/server/session-admin.mjs`、`src/web/js/pages/live.js`、三语 i18n。

真实 Bilibili 只读验证：房间 `3` → `23058`，未开播，`displayName=3号直播间`、`platformUid=11153765`。真实浏览器/EXE 仍受阻；未伪造。

### Bug 8：已保存 API 配置可编辑

- 设置页配置卡新增「编辑配置」；复用同一表单，预填名称/Provider/区域/Base URL/模型/价格/并发/本地网络。
- API Key 输入默认留空并显示「已保存」；只有输入新 Key 才发送 `apiKey`，空字符串不覆盖旧 Key。
- 只改 Model ID：同一 `configId`、默认标记、credentialReference 保留；旧能力/测试状态/价格/contextLength 失效；新任务使用新模型。
- 改 Provider/区域/Base URL：轮换 credential reference，必须重新输入 Key；不允许静默复用旧密钥。
- 运行中任务：禁止编辑/删除其配置（409 `AI_PROVIDER_CONFIG_IN_USE`）；旧 job 的模型/区域变化后 `resume` 拒绝（409 `AI_PROVIDER_CONFIG_CHANGED`），新任务用新配置。
- 测试：`v13-providers`（store 行为/重启持久化）、`v13-provider-edit`（HTTP/运行中/新模型）、`ai-settings-edit`（UI/安全静态）。

## 2. 上一轮结果（v0.13.1 入口与调度）

| 目标 | 结论 |
| --- | --- |
| 付费 API 是否被免费限速影响 | **没有。** 2 RPM 只存在于旧匿名路径 `src/ai/auto/`；付费 `src/ai/api/runner.mjs` 未使用该 limiter。完整证据见 `docs/AI_SCHEDULER_AUDIT.md`。 |
| 删除匿名免费 AI | **已实现。** 删除 `src/ai/auto/`、`/api/ai/auto/*`、UI 入口、免费价格状态、匿名 Provider 配置与自动切换。 |
| 删除手动 AI | **已实现。** UI 不再有创建包/复制提示词/下载 ZIP/粘贴 JSON/上传 JSON/手动导入/修复指令；对应 HTTP 写路由删除。 |
| 单一 AI 分析入口 | **已实现。** 五步：选择直播 → 选择 API 配置 → 选择内容 → 费用/预算确认 → 开始 AI 分析。 |
| 保留多 Provider | **保留。** OpenAI、Anthropic、DeepSeek、MiniMax（cn/intl）、阿里云百炼（4 区域）、OpenRouter、自定义 OpenAI-compatible。 |
| 安全并发 | **已实现。** 每个 config 独立调度器；初始并发可配置 1–8，默认 3；画像批次有界并发。 |
| 429 / Retry-After | **已实现。** 429 减半并发并按 `Retry-After` 暂停该 config；5xx/408/425 短暂暂停；指数退避 + 抖动。 |
| 删除固定 30 批上限 | **已实现。** 改为 `ceil(MAX_ANALYSIS_VIEWERS / 10) + 1`（2,001）。 |
| 跨场次记忆顺序 | **已实现。** 同一主播记忆 gate；较新场次已导入后拒绝较旧场次（`ANALYSIS_MEMORY_OUT_OF_ORDER`）。 |
| 性能统计 | **已实现。** 请求/完成/失败/并发/排队/模型耗时/排队等待/限流等待/429/p50/p95/token/费用/ETA。 |
| 本地性能修复 | **已实现。** 每批只更新本批观众；DNS 安全检查缓存 5 分钟；精确 `getJobPackage()` 查询。 |
| 全量测试 | **548 passed / 0 failed**（约 73 秒）。 |
| Mock 规模测试 | **1,000 观众 / 10,000 消息：100 批、6.5 秒、峰值并发 6、覆盖 1,000/1,000。** |
| 真实付费 API | **阻塞**：本机没有 Provider 配置/密钥/环境变量。未伪造成功。 |
| EXE | **已重新构建 v0.13.1**（91.5 MB / 164 assets / SHA-256 `ba917c52…` / requireAdministrator），包含七项修复与配置编辑；**未能运行**（UAC 拒绝）。 |

## 3. 关键文件

### 新增

| 文件 | 职责 |
| --- | --- |
| `src/ai/runtime/json.mjs` | Provider 无关的 JSON 提取、取消 sleep、Retry-After 解析、退化检测 |
| `src/ai/runtime/state.mjs` | 本地任务状态恢复（不含提示词/聊天正文） |
| `src/ai/runtime/scheduler.mjs` | 按 config 隔离的请求调度器、动态并发、429 冷却、指数退避 |
| `docs/AI_SCHEDULER_AUDIT.md` | 免费限速调查结论、代码位置、新调度、Mock 时间线 |
| `scripts/benchmark-mock-scale.mjs` | 大规模 Mock 性能基准 |
| `tests/unit/ai-scheduler.test.mjs` | 并发上限、429 隔离、取消、退避 |
| `tests/integration/v13-scheduler.test.mjs` | 429 Retry-After、画像并发、失败恢复、跨场次顺序 |

### 修改

- `src/ai/api/runner.mjs`：删除匿名 Provider；必须 `configId`；调度器；有界并发；`Retry-After`；请求统计；记忆顺序 gate；精确包查询；1,000 观众批次上限。
- `src/ai/providers/adapters.mjs`：`ProviderHttpError` 携带 `retryAfterMs`；5xx/408/425 可重试。
- `src/ai/providers/catalog.mjs`：删除 `ANONYMOUS_FREE`。
- `src/ai/providers/store.mjs`：新增 `concurrency`（1–8）与 `timeoutMs`（10–600 秒）。
- `src/ai/providers/pricing.mjs`：文档删除匿名状态。
- `src/storage/repositories/ai-packages.mjs`：新增 `getJobPackage()`。
- `src/ai/import/importer.mjs`：memory 批次只更新本批观众，避免 O(批次×观众)。
- `src/server/index.mjs`：删除 `AutoAnalysisRunner` 生命周期。
- `src/server/routes.mjs`：删除匿名/手动写路由；保留只读任务/报告/结果。
- `src/web/js/pages/ai.js`：五步单入口；请求统计；暂停/取消；错误原因。
- `src/web/js/pages/ai-settings.js`：删除匿名价格；新增并发数。
- 三语 i18n：新增 `ai.center.*`、并发文案、`errors.aiProviderConfigRequired`；删除 `ai.auto`、手动/匿名方法。
- README、STATUS、HANDOFF、ROADMAP、ARCHITECTURE、AI_CONTRACT、TEST_PLAN、PRIVACY_SECURITY、CHANGELOG、日志。

### 删除

- `src/ai/auto/` 整个目录（匿名 provider、2 RPM limiter、runner、prompt、assemble、errors、client、state）。
- `src/web/js/pages/ai-import-repair.js`。
- 旧匿名/手动测试：`auto-analysis`、`auto-api`、`auto-compact`、`auto-client`、`auto-prompt`、`auto-assemble`、`manual-52-viewers`、`ai-import-repair`。

## 4. API 变化（v0.13.1）

保留：

```text
GET  /api/ai/providers
GET  /api/ai/providers/models
POST /api/ai/providers/configs
PATCH/DELETE /api/ai/providers/configs/:id
POST /api/ai/providers/configs/:id/default
POST /api/ai/providers/configs/:id/test
POST /api/ai/analyze/run
GET  /api/ai/analyze/status
POST /api/ai/analyze/pause|cancel|resume
GET  /api/ai/jobs                 (只读)
GET  /api/ai/jobs/:id             (只读)
GET  /api/ai/packages             (只读)
GET  /api/ai/sessions/:id/report
GET  /api/ai/results/:id
GET  /api/ai/results/:id/download
```

删除：

```text
POST /api/ai/jobs
POST /api/ai/jobs/:id/aggregate
POST /api/ai/packages
GET  /api/ai/packages/:id/download
GET  /api/ai/instructions
POST /api/ai/import/preview
POST /api/ai/import
GET/POST /api/ai/auto/services|status|run|cancel
```

## 5. 关键规则（下一轮不要破坏）

1. 匿名免费 AI 与手动 JSON 入口已删除；不要重新加回。
2. `session` 与 `memory` 独立保存；画像失败不覆盖单场报告。
3. `api_free` 永远不能执行 memory；付费必须价格已知 + `capabilities.memory` + opt-in。
4. 付费/未知价格必须 `confirmBilling`；未知价格不当免费。
5. 所有模型输出必须走 `validateAnalysisImport()` + `importAnalysisResult()`。
6. 每位可识别观众恰好一条 `viewer_memory_updates`；批次不拆散观众。
7. 客观历史只由真实记录更新；memory 批次只更新本批观众。
8. 同一主播跨场次按时间顺序；较旧场次不得覆盖较新记忆。
9. 调度按 `configId` 隔离；不虚构统一 RPM/TPM；429 按 `Retry-After`。
10. 初始并发可配置 1–8，默认 3；不得无上限并发。
11. Key 只存加密凭据库；不进入 JSON/日志/ZIP/DB/HTML。
12. 自定义 URL 私网/元数据/DNS 检查保留；DNS 安全缓存最长 5 分钟。
13. 历史报告与长期画像仍可只读；旧 1.0–1.2.0 结果仍可读。
14. 三语键一致；前端禁止 `innerHTML`、`alert()`、硬编码可见文案。
15. **已发出的长请求超时后不要自动重发；用户取消/暂停绝不重试。** 超时、截断、退化、流中断都不是“重试就能好”。
16. **任务完成优先：没有任务时间/费用/批次总量上限；只有单请求首响应/空闲超时、单批 Token 上限与极端内存保护。错误进入 needs_action 并保留已完成批次；用户取消立即生效；`runPool` 失败只停调度，不得 abort 在途兄弟批次。**
17. **多批 session 必须有 final aggregate 才 complete；汇总证据必须 `{batch, seq}`。**
18. **批次输入按 token 预算（默认 8k，可配 2k–32k）；不得丢消息或观众；同一观众不拆批。**
19. **Streaming 由程序自动选择；只缓冲，完成后仍校验/事务导入；不兼容最多回退一次。**
20. **统计分开成功/失败/取消/超时/重试；无 usage 显示“用量未知”，不能当零费用。**

## 6. 未验证 / 边界

- **真实付费 API 阻塞**：本机没有 `config/ai-providers.json`、`secrets/ai-keys.json` 或环境变量 Key。
- 真实浏览器 UI 已用 headless Edge + CDP 验收运行中/完成/390px/设置页；截图见 `docs/screenshots/ai-reliability-*`。未用真实 Provider 点击“开始分析”（使用合成 Fixture）。
- EXE 已重新构建但 UAC 拒绝运行；未验证打包后的流式连接与出站请求。
- 真实 Provider 的 429/Retry-After、1,000 观众、流式 usage、费用与延迟未测试。
- 真实 174k token 大场的 token 分批与 final aggregate 未运行；Mock 已覆盖 420 消息多批。
- 部分 Provider 的 `stream_options.include_usage` 支持未知：流式 usage 可能缺失，界面显示“用量未知”。
- 汇总请求仍可能因批次结果过多超过小上下文模型；会明确失败并保留批次。
- 调度器默认 3 并发是安全起点，不是官方额度；过高可能触发 429。
- 429 冷却上限 300 秒；更长要求会失败而不是无限等待。
- 预算在请求后累计；并发请求可能同时越过上限。
- 5 分钟 DNS 缓存窗口内 DNS 变化不会被立即发现。
- `src/ai/export/job.mjs`、`package.mjs`、`prompts/instructions.mjs` 仅作为历史兼容/测试的内部构建器保留，无 UI/HTTP 入口；如后续确认无历史需求可再删除。

## 7. 常用命令

```bat
node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"
node scripts/benchmark-mock-scale.mjs 1000 10000 6
node src/launcher/launcher.mjs --no-open
node scripts/build-windows.mjs
```

## 8. 本轮 Commit

- 功能/测试/文档提交：见最终答复的本地 commit hash（未 Push）。
