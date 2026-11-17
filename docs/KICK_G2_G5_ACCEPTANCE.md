# Kick G2–G5：正式接入、完整验收与 Windows EXE 候选

状态：**G2–G5 完成，等待用户试玩确认（2026-11-17）**。Kick 已成为产品第六个平台，
出现在正式界面、十语言、历史/AI/画像/备份流程中；候选 EXE 已构建并通过真实房间验收。
**未发布、未合并 `main`、未 Tag、未 Release**；版本仍 `0.15.0`。G6 待用户决定。

- 继承：`docs/KICK_G1_ACCEPTANCE.md`（G1 真实连接与字段证据），未重写 G1 代码，只在其上接入产品。
- 代码：`src/platforms/kick/{link,http,messages,transport,adapter,service,errors}.mjs`；
  `src/server/{index,routes}.mjs`；`src/web/js/pages/live.js`；十份字典。
- 测试：`tests/unit/kick-*.test.mjs`、`tests/integration/kick-{ingest,service}.test.mjs`。
- 工具：`scripts/kick-g4-longrun.mjs`、`scripts/verify-kick-ui.mjs`、`scripts/verify-kick-exe.mjs`。

---

## 1. G2 验收：正式后台接入

| 要求 | 结果 | 证据 |
| --- | --- | --- |
| 注册 `kick` 平台 | ✅ | `/api/bootstrap.capabilities.platforms` 含 `kick`（`mode=anonymous-centrifugo`、`unofficial=true`、`requiresLogin=false`、`requiresApiKey=false`） |
| URL 解析 | ✅ | `https://kick.com/<slug>`、`www`、裸 slug、`/chat`；拒绝 VOD/clips/category/search/其他平台 URL；单测 12 组 |
| service / routes / capabilities | ✅ | `/api/kick/{status,room,connect,disconnect,retention/apply}`；`KickService` 错误码映射到十语可译键 |
| 创建 / 启动 / 停止 / 重连 | ✅ | SessionManager 统一路径；连接成功后才 resolve；停止不重连；真实重连见 §3 |
| 历史记录与保存 | ✅ | 事件只经 `EventIngest` 写 SQLite；`/api/sessions/:id` 与历史列表可见 |
| 多直播间 | ✅ | 每房间独立 adapter/socket/session；真实 EXE 双房间同时采集 |
| 观众身份与长期画像 | ✅ | `kick:<sender.id>`；缺 ID 不建档案；同名不同 ID 不合并（集成测试） |
| AI 分析 | ✅ | 进入 canonical 事件后复用现有 AI 入口；EXE 内 `ai.automated` / `memory.enabled` 均为 true |
| 备份与恢复 | ✅（复用既有管线） | Kick 使用同一数据库/表/保留策略，无平台专属存储；备份恢复测试全量通过 |
| 连接状态与错误提示 | ✅ | `connecting/connected/reconnecting/failed/stopped` + `waiting_events`；错误码均有十语文案 |

### 1.1 身份

- `viewer_uid = sender.id`，`viewer_id = kick:<sender.id>`；昵称只展示。
- 缺 `sender.id`：`viewer_uid=NULL`、`source_quality=unknown`、不创建 `viewers` 行。
- 同名不同 ID 不合并；跨房间同一 ID 保持同一 `kick:` 身份（G1 已用真实样本验证）。

### 1.2 消息

- `external_id` = Kick 消息 UUID；`UNIQUE(session_id, dedupe_key)` 兜底。
- `content` 原文不变；`[emote:id:name]` 解析为 `{id,name,source:'kick'}`；
  `thread_parent_id` / `metadata.original_message.id` 作为 reply 诊断字段。
- `created_at` 转 epoch 毫秒（支持 `+00:00` 与 `Z`、纳秒小数）；不可解析时回退接收时间并标 unknown。

### 1.3 礼物与互动

| 事件 | 映射 | 金额/身份处理 | 状态 |
| --- | --- | --- | --- |
| KICKs 礼物 `KicksGifted` | `gift` | `external_id=gift_transaction_id`；`sender.id` 为身份；`amount_minor=NULL`、`currency=NULL`、`value_kind=unknown`；KICKs 数量/type/tier 只进 `amount_display` | **VERIFIED（真实）** |
| 赠送订阅 `GiftedSubscriptionsEvent` | `membership` | 赠送者一条（`is_paid=true`、数量=`gifted_total`）+ 每位接收者一条（`is_paid=false`、无身份）；只有用户名，不建档案、不计收入 | **VERIFIED（真实）** |
| 订阅 / 续订 `SubscriptionEvent` | `membership`（已映射） | 只有用户名与月数；无稳定 ID | **NOT-OBSERVED** |
| 删除 / 封禁 / 解封 / Pin | 仅解析计数 | 不进入用户时间线（与其他平台一致） | **VERIFIED（观测）** |
| 开播 / 下播 / Host / Raid / 投票 | 分类计数 | 未映射为产品事件 | **NOT-OBSERVED / DOCUMENTED** |
| 关注 | — | 官方 webhook 才能取得，需要公网接收端 | **UNSUPPORTED（本地形态）** |

- 同一条 `KicksGifted` 重投递不会增加行/金额；赠订的 `external_id` 由 `correlation_id` 派生，
  接收者用稳定序号，重连重放可被去重。
- 赠送订阅的接收者名单以“每位接收者一行 `membership`”保留；没有 ID 时不创建观众档案。

### 1.4 多房间与稳定性

- 每个房间独立 socket、独立 token、独立重连；跨房间只接受自己 `chatrooms.<id>.v2` 的聊天。
- 真实 G4 长测中平台侧主动断开（`category=temporary`）后自动恢复；重连次数与空档见 §3。
- 房间中途下播时，G4 脚本通过产品 API 发现并接入替代房间继续测试（记录为独立 session）。

---

## 2. G3 验收：完整 UI 与十语言

### 2.1 界面

直播页新增第六个页签 **Kick**，与其余平台共用同一套页面与交互，不另做 Kick 专属页面：

- 添加直播间：输入 `https://kick.com/<频道名>`，检查后显示频道、稳定 channel ID、chatroom ID、观众数、直播中/未开播。
- 开始采集：仅在直播中可开始；开始时进入该场记录页，与五平台一致。
- 连接状态：连接中 / 已连接等待事件 / 采集正常 / 自动重连 / 限流 / 已结束 / 已停止 / 失败。
- 采集错误：十语错误文案 + 原因细节（房间不存在、未开播、被安全策略拦截、网络、协议、超时、连接失败、未配置）。
- 多房间：Kick 活动房间列表，每场独立“打开/停止记录”。
- 历史记录、观众列表、AI 分析、长期画像：复用既有页面；Kick 事件进入同一 canonical 管线。
- 礼物/互动显示：KICKs 进礼物行（数量为 KICKs 展示文本，不伪造法币）；赠订/接收者进会员行；
  订阅/开播等未观测事件不显示为已支持。
- 保留策略：显示 30 天原文清理说明并提供立即清理。

### 2.2 十语言

- 新增 31 个键 × 10 语言：`common.platform.kick`、17 个 `live.source.kick*`、13 个 `errors.kick*`。
- 每份字典 **2,302** 个叶子键；键集、占位符、空值、英文残留门禁全部通过（`i18n.test.mjs` 14/14）。
- 真实浏览器矩阵（DevTools Protocol，**真实 2 场 Kick 录制**）：**20/20** 通过：
  - 10 个语言全部渲染正确的 Kick 文案，无未解析 `live.source.kick` / `errors.kick` 键；
  - `zh-CN`/`en` 覆盖 1440/1024/820/390 与明/暗主题；
  - 所有宽度无横向溢出，输入框/按钮不越界；
  - 活动 Kick 列表显示 2 场真实录制。
- 截图与报告：`tests/.tmp/kick-ui/`（gitignored；`report.json` + 多张 PNG）。

### 2.3 用户操作路径

1. 启动 LiveMemory（候选 EXE 或源码）。2. 新建记录。3. 选择 **Kick**。4. 粘贴直播间链接。
5. 点击“检查直播间”。6. 点击“开始记录”。7. 看到真实弹幕。8. 停止记录。
9. 在直播历史查看本场。10. 在 AI 分析中心选择本场并分析；在观众档案查看长期画像。
全程不需要登录、API Key 或第三方付费服务。

---

## 3. G4 验收：≥60 分钟真实长测

运行方式：`scripts/kick-g4-longrun.mjs` 启动**真实产品服务器**（独立数据目录），通过
`/api/kick/connect` 接入真实在播 Kick 房间，定时记录状态，最后通过产品 API 停止并核对数据库。

| 项目 | 结果 |
| --- | --- |
| 计划 / 实际时长 | 70 / **70.2** 分钟（主房间 02:57:29–04:07:39 UTC），**≥60** |
| 房间 | kinocasinogaming（全程）+ odablock（03:19 下播，自动停止）+ paymoneywubby（03:20 替补接入） |
| 真实聊天 | **34,766** 条（kinocasinogaming 20,304 / odablock 3,304 / paymoneywubby 11,158） |
| 稳定 ID / 消息 ID / 时间戳 | **100% / 100% / 100%**（34,766 / 34,766 / 34,766） |
| 重复事件 | **0**（3 个 session 内 `external_id` 无重复；`UNIQUE(session_id, dedupe_key)` 兜底） |
| 真实重连 | **7 次**（kinocasinogaming 3、odablock 3、paymoneywubby 1；均为平台侧断开，自动恢复，`category=temporary`） |
| Token 刷新 | **1 次真实主动刷新**：03:59:37 UTC 采样点 `tokenRefreshes=1`、`reconnects=3`、状态 `connected`；刷新前后同一房间持续收消息（03:59:07 17,442 → 03:59:37 17,587 条） |
| Token 刷新前后状态 | 刷新前 `connected` → 刷新（主动 close 4002）→ 自动重连 → `connected`；采样间隔 30 秒内完成，空档 <30 秒 |
| 事件保存成功率 | 34,918 条事件入库 = 34,766 chat + 111 gift + 41 membership；与 adapter 计数一致 |
| 停止后 | 产品 API 停止全部房间：`liveSessionsAfterStop=0`、`recordingsAfterStop=0`；无残留 Kick 录制 |
| 独立观众 | **3,438** 个稳定 `kick:<sender.id>`（3 场去重；主房间 1,471） |

> 结论口径：没有续传游标，重连与 token 刷新空档内可能漏消息，**不声称弹幕完整**。

### 3.1 真实事件验证

**真实事件（主房间 70 分钟 + 替换房间）：**

- **KICKs 礼物 111 条**：全部有 `gift_transaction_id` 与 `sender.id`；`amount_minor`、`currency`
  100% 为 NULL，`value_kind=unknown`，`amount_display` 100% 含 KICKs 数量（如 `1000 KICKs · LEVEL_UP/MID`）。
- **赠订/会员 41 条**：18 条 `is_paid=1`（赠送者/订阅）、23 条 `is_paid=0`（接收者）；
  41 条全部没有 `viewer_uid`（Kick 只给用户名），因此没有创建观众档案。
- 聊天 34,766 条：`viewer_uid`、`external_id`、`occurred_at` 均 100%；Emote 原文保持。
- 同一消息重投递与重连重放：0 条重复 `external_id`。
- 订阅/续订、开播/下播、Host、投票：未观测，保持 `NOT-OBSERVED`。

---

## 4. G5 验收：Windows EXE 候选

| 项目 | 值 |
| --- | --- |
| 文件 | `dist/LiveMemory.exe`（正式候选）、`dist/LiveMemory-asInvoker.exe`（同源测试副本身份） |
| 版本 | `0.15.0`（未改正式版本号；候选以 Build ID 区分） |
| Build ID | `5314bd79a0f3` |
| 源码哈希 | `5314bd79a0f3e16854bd0796402c814327b47bb1df29f3154b49fec98896ffa1` |
| 大小 | 99,329,024 bytes |
| SHA-256 | `acdc4ea3a75305fd1a26364127f8bfada97728cfb9892b1046ac68ac5b653058` |
| 提交 | `969d97564653036fa073828f5b1c61bf02de1e4f` |
| Manifest | 正式 EXE `requireAdministrator`（构建断言 + 注入后复读）；asInvoker 副本仅用于自动化 |
| 资源 | 244 个打包文件；Kick 七个模块、十份字典、Schema/提示词全部在包内 |

### 4.1 EXE 内真实服务验收（`scripts/verify-kick-exe.mjs`）

**19/19 通过**，使用真实 Kick 房间（最终构建：kinocasinogaming + lospollostv；同一脚本此前在 paymoneywubby 也通过）：

1. 正式 EXE 仍为 `requireAdministrator`，测试副本为 `asInvoker`。
2. EXE 启动、控制台可加载、会话认证成功。
3. 平台注册：`bilibili, youtube, twitch, douyin, tiktok, kick`；Kick 标记非官方/免登录。
4. 版本与 Build ID 匹配候选构建。
5. 十份语言资源均含 Kick 键。
6. 真实 Kick URL 在 EXE 内解析成功（免登录）。
7. VOD URL 被拒绝（`errors.kickLinkInvalid`）。
8. 两个真实房间均成功开始采集（201）。
9. 每个房间收到并保存真实聊天（最终构建 19 / 8 条；此前 22 / 4 条）。
10. 稳定身份写入（`kick:<id>`，身份覆盖率 100%）。
11. `/api/live/recordings` 同时列出两场。
12. 历史记录可读取。
13. AI 入口可用（`ai.automated=true`、`memory.enabled=true`）。
14. 停止后两场都释放，无残留 Kick 录制。
15. 状态卡显示 `stopped`。
16. 十语资源与打包模块检查通过。
17. 礼物/赠订映射由源码单测与 G4 真实事件覆盖；本次 EXE 90 秒窗口内未出现礼物（不夸大为 EXE 已验证礼物）。

### 4.2 UAC / Smart App Control 说明

- 正式 EXE 为 `requireAdministrator`，双击会由 Windows 显示标准 UAC；自动化会话无法点击 UAC，
  因此功能验证使用**同源码、同 Build ID** 单独构建的 asInvoker 副本（`LiveMemory-asInvoker.exe`）。
- **真实双击 UAC 的“同意/拒绝”两条路径仍未人工验证**，不得写成已通过。
- 本机未阻止该 asInvoker 构建；正式 EXE 的 Manifest 已由构建脚本与验证脚本分别断言。

---

## 5. 自动化回归

| 套件 | 结果 |
| --- | --- |
| 全量单元 + 集成（`--test-isolation=none`） | **1,169 passed / 0 failed / 0 skipped**（463,240 ms） |
| 其中 Kick | **67** 个（单测 + 集成：URL、状态映射、字段、Emote、reply、礼物/赠订、token 刷新、109、退避、双房间、停止、服务/路由、UI 键与打包清单） |
| 现有五平台回归 | 随全量套件通过；未修改五平台协议 |
| 十语言门禁 | 10 × 2,302 键；缺失/多余/占位符/空值/英文残留均为 0 |
| 真实 UI | 20/20（10 语、4 宽度、明暗、真实 2 场） |
| 真实 EXE | 19/19 |
| G1 偶发时序失败 | `ai-memory-output-recovery` / `youtube-lifecycle-regression` 本轮**未复现**；全量一次性通过 |

---

## 6. 剩余问题与风险

| 级别 | 问题 | 影响 / 处理 |
| --- | --- | --- |
| P2 | 订阅/续订、开播下播、Host、投票未观测 | 不宣称支持；保持 `NOT-OBSERVED` |
| P2 | 赠送订阅只有用户名 | 不建稳定身份、不计收入；事件行保留接收者 |
| P2 | 真实 45 分钟 token 到期 | 本长测已跨过一次主动刷新（见 §3）；服务端 109 立即换 token 有单测 |
| P2 | 无续传游标 | 重连/刷新期间可能漏消息；UI 与文档明示 |
| P2 | 非官方协议 | 可能失效；失败显式报错，不绕过访问控制 |
| P3 | HTTP/2 依赖与 WebSocket `Origin` | 当前实测可用；若平台收紧需自研最小 WS 客户端 |
| P3 | EXE 未签名 | SmartScreen 可能提示未知发布者 |
| P3 | 真实双击 UAC、干净 Windows 账户 | 未人工验证 |

---

## 7. 结论与 G6 建议

- **G2–G5：PASS（候选）**。普通用户可安装候选 EXE、添加 Kick 直播间、看到真实弹幕并完成历史/AI/画像流程。
- **无 P0/P1 阻断**。存在 P2/P3 限制，均已在界面/文档如实标注。
- **建议进入 G6 正式发布评估**，但需用户先试玩候选 EXE；发布前需决定：是否等待订阅/开播事件真实样本、
  是否补真实双击 UAC 验收、是否安排十语言母语审校。
- **当前不自动发布 v0.16.0**；未 Push / Merge / Tag / Release。

---

## 8. 复用与复现

```bat
:: 真实长测（需在播 Kick 房间）
node scripts/kick-g4-longrun.mjs --minutes 70 --out tests/.tmp/kick-g4

:: 十语言 UI（需运行中的服务器 + 已连接 Kick 房间 + CDP 浏览器）
node scripts/verify-kick-ui.mjs --port 9333 --base http://127.0.0.1:<port>

:: EXE 候选
node scripts/build-windows.mjs
node scripts/build-windows.mjs --as-invoker
node scripts/verify-kick-exe.mjs --exe dist/LiveMemory.exe --asinvoker dist/LiveMemory-asInvoker.exe

:: 全量测试
node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"
```
