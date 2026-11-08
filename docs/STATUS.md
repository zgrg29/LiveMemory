# 工程状态（STATUS）

最后更新：2026-11-08（YouTube Live 真实接入，版本 0.2.0，schema 3）

> 本文件是唯一进度来源。只要代码与本文不一致，以代码与实测为准，并立即修正本文。

## 1. 当前阶段

- 里程碑：**M0 / M1 / M2 核心 / P0 / P1 / P2 完成；M3 进行中（Bilibili 真实接入 + YouTube Live 接入）**
- 版本：`0.2.0`（`package.json` 与 `src/shared/app-info.mjs` 一致）
- 数据库 schema：**3**（v2 新增 `events.emotes`，v3 新增 `sessions.platform_started_at`）
- 分支：`main`，本地提交，未 Push

## 2. 本轮完成（2026-11-08）：YouTube Live

### 2.1 授权结论（先回答最重要的问题）

| 能力 | 是否需要 Google 账号 | 是否需要 OAuth | 是否需要应用级 API Key | 结论 |
| --- | --- | --- | --- | --- |
| 定位直播（`videos.list` + `liveStreamingDetails`） | 否 | 否 | 是 | 官方支持 |
| 读取公开直播聊天（`liveChatMessages.list`） | 否 | 否 | 是 | 官方文档明确允许 API Key 读取公开数据（含公开直播聊天） |
| 主播自己的频道信息（`channels.list?mine=true`） | 是 | 是 | 否 | 只有 OAuth 可用 |
| 私有/会员限定直播、`liveBroadcasts.list` | 是 | 是 | 否 | 本轮不实现 |

- **完全不需要任何凭据的官方通道不存在。** YouTube ToS 与 Developer Policies 禁止抓取与使用未公开接口；本轮没有实现任何绕过。
- 本轮实现 **两种官方模式**，运行时自动选择：
  1. **公开直播模式（api-key）**：应用级 API Key，匿名读取公开直播与公开聊天，主播零登录、零配置；
  2. **OAuth 模式（oauth）**：主播点一次「登录 Google」，PKCE + 系统浏览器 + `127.0.0.1` 回环回调，自动刷新令牌。
- **API Key 与 OAuth client 都不进入仓库**：Google/YouTube 政策禁止在开源项目中嵌入 API 凭据（Developer Policies III.D.1.d），且桌面端 API Key 无法有效限制给某个应用。因此默认构建为空，由发布者一次性配置（详见 `PLATFORM_INTEGRATIONS.md` §3）。
- 普通主播**不需要**注册 Google Cloud、创建项目、启用 API、申请 Key 或填写任何密钥；缺配置时界面明确说明「这个构建没有包含开发者凭据」，而不是伪装成功。

### 2.2 已实现代码

- `src/platforms/youtube/link.mjs`：直播链接/视频 ID 解析（`watch`、`/live/`、`youtu.be`、`embed`、`shorts`、裸 ID），拒绝播放列表、频道、非 YouTube 主机与非法 ID。
- `src/platforms/youtube/api.mjs`：官方 Data API v3 客户端；`videos.list`、`liveChatMessages.list`、`channels.list`；API Key 与 OAuth 双凭据模式；官方配额计费（videos 1 / chat 5 / channels 1）；Google `reason` → 稳定错误码。
- `src/platforms/youtube/oauth.mjs`：PKCE(S256)、授权 URL、**单次回环 HTTP 回调接收器**（仅 127.0.0.1、仅指定路径、校验 `state`、超时、无外部资源回调页）、code 交换、refresh、revoke。
- `src/platforms/youtube/oauth-manager.mjs`：`signed_out → pending → signed_in | expired → signed_out` 状态机；启动后恢复登录；提前 60 秒自动刷新；并发刷新合并；`invalid_grant` → `expired` 而非静默登出。
- `src/platforms/youtube/token-store.mjs` + `src/platforms/shared/secret-store.mjs`：AES-256-GCM 加密保存 refresh/access token；密钥同目录、`icacls` 尽力限制；`status()` 永不返回令牌。
- `src/platforms/youtube/mapper.mjs`：文本消息、Super Chat、Super Sticker、新会员、会员里程碑、赠送会员、收到赠送会员；`:code:` 自定义表情；`amountMicros` → 整数最小货币单位（BigInt，无浮点误差）；会员等级/月数/赠送数量**不换算金额**；收到赠送会员的用户 `is_paid=false`。
- `src/platforms/youtube/adapter.mjs`：`liveChatMessages.list` 轮询（`nextPageToken`、`pollingIntervalMillis`）、过期前配额守卫、指数退避重连、广播元数据刷新（并发观看人数 / 直播结束）、聊天 `offlineAt` 结束检测、`chatEnded/chatDisabled=真结束`、网络错误**不结束场次**。
- `src/platforms/youtube/service.mjs` + 路由 `/api/youtube/*`：状态、登录、退出、检查直播、开始/停止记录、手动执行保留清理。
- 统一写入路径不变：所有事件仍经过 `EventIngest`（去重、观众聚合、按币种累计、场次计数）。

### 2.3 数据与策略

- schema **v3**：`sessions.platform_started_at` 保存平台侧的直播开始时间（YouTube `liveStreamingDetails.actualStartTime`），用于「相对直播时间」。
- **保留策略（默认 30 天）**：YouTube 公开聊天属于 Non-Authorized Data，Developer Policies III.E.4.d 要求不超过 30 个日历日。`src/storage/retention.mjs` 在启动、场次结束与手动操作时清理 `content`/`emotes`；发言计数、观众身份、昵称历史与经济支持统计保留。Bilibili 数据不受该政策约束，未被清理。
- 金额：Super Chat / Super Sticker 使用官方 `amountMicros` + `currency`，`value_kind=actual`；不同币种分别累计（USD / JPY / EUR 各自独立）。
- 付款者统计修正：`payment_event_count` 现在只在 `is_paid=true` 时累加；赠送会员的**接收者**不再被算作付款者，免费礼物也不再计入付费事件。

### 2.4 界面

- 直播记录页新增第三个来源标签「YouTube 直播」：账号/模式状态、登录/重新登录/退出、直播链接输入、检查结果（正在直播 / 未开始 / 已结束 / 非直播 / 聊天关闭）、频道、当前观看、API 配额、数据保留说明与「立即清理过期原文」。
- 直播中新增 YouTube 专属指示：连接状态（已连接 / 网络中断重连）、当前观看人数、配额消耗；`Super Sticker`、会员里程碑留言在动态流中正确显示。
- 三语（zh-CN / ja / en）键完全对齐（自动化校验），明亮 / 黑暗 / 跟随系统均验证；窄屏 390px 无横向溢出。

### 2.5 测试与 EXE

- 自动化：**259 个测试全部通过，0 失败，约 6.5 秒**。
- 新增覆盖：链接解析、官方错误映射、配额计费、PKCE/回调/令牌交换与刷新、登录状态机与重启恢复、令牌加密存储与篡改检测、全部经济事件映射、`amountMicros` 多币种、轮询/重连/结束/配额守卫、保留策略、v1→v3 迁移、以及**本地假 API 的端到端**（连接 → 入库 → 观众 → 多币种 → 历史 → 保留）。
- EXE：`dist/LiveMemory.exe` **90.1 MB**，SHA-256 `a1becfb6e18606c5db59dc4f8c218dd473d08dab931116a310887ec1a76b2d2d`；`scripts/verify-exe.mjs` **9/9 通过**；EXE 内 `/api/youtube/status` 返回未配置状态、schema=3、`live.js` 含 YouTube 入口。
- UI 截图：`docs/screenshots/live-youtube-light-zh-CN.png`、`live-youtube-dark-zh-CN.png`、`live-youtube-mobile-light-zh-CN.png`、`live-youtube-recording-zh-CN.png`（本地假 API 的端到端录制）、`live-youtube-unconfigured-zh-CN.png`。

### 2.6 未完成的真实验收（必须如实保留）

- **没有真实 Google 凭据**：本轮没有可用的 API Key 或 OAuth 客户端，因此**未对真实 YouTube 直播做端到端采样**，也没有「真实消息条数 / 稳定身份比例」数据。
- 端到端验证使用**本地假 API 服务器**（严格按官方响应结构返回），证明链路可运行，但不能称为真实平台验收。
- OAuth 流程在本地回环与假 token 端点上验证；未与 Google 真实授权页、真实 refresh token 过期规则（Testing 状态 7 天）做在线验证。
- 30 天保留策略依据文本条款实现，未获得 Google 的书面确认。

## 3. 已完成（有代码与验证）

### 工程与文档
- 独立 Git 仓库（`origin` 指向 github.com/zgrg29/LiveMemory，未 push）
- `.gitignore` 排除用户数据、构建产物、参考仓库、临时目录
- `AGENTS.md`、`README.md`、MIT `LICENSE`、`start.cmd`
- 全部 `docs/*` 文档与 `log/` 开发记录

### Windows 启动器与 EXE
- 环境检查（Node ≥ 22.5、`node:sqlite` 可用）、数据目录解析与写探测、单实例锁、端口顺延、服务就绪后打开浏览器
- 三语命令行、UTF-8 控制台、优雅退出、崩溃恢复
- Node SEA 打包，PE 子系统 Console，首次运行解压到 `<数据目录>\app\<hash>\`

### 数据层
- `node:sqlite`，WAL，schema 3，迁移可重复执行
- 表：`sessions`、`events`、`viewers`、`viewer_nicknames`、`viewer_sessions`、`viewer_currency_totals`、`session_currency_totals`、`ai_packages`、`app_meta`
- 唯一写入管线 `EventIngest`：去重 → 观众聚合 → 场次金额 → 场次计数，单事务
- 观众身份 `platform:uid`；昵称历史独立保存；跨平台不合并
- 金额整数最小单位，按 `currency` + `value_kind` 分账

### 服务器与 API
- 仅监听 `127.0.0.1`；Host/Origin 校验、CSP、nosniff、无 framing；路径穿越与 1 MB JSON 限制
- 路由：health、bootstrap、status、settings、sessions、simulate、bilibili、youtube、viewers、events + SSE、storage、AI 包
- 设置持久化 `config/settings.json`（原子写入；新增 `youtubeRawRetentionDays`）

### 平台
- 模拟直播（中/日/英 24 位观众、话题漂移、Emoji、平台表情、3% 重复投递）
- Bilibili 真实直播：WebSocket、鉴权、心跳/看门狗/重连、弹幕/礼物/SC/大航海映射、扫码登录、平台表情元数据（真实采样：弹幕 142/142 带 UID）
- YouTube Live：见 §2（代码完成，真实直播未采样）

### 网页控制台（Apple 风格）
- 5 页、三语、明亮/黑暗/跟随系统、首帧无闪烁、响应式
- Canvas 消息密度图、SSE 实时动态、观众档案与昵称历史
- AI 三步向导（导出可用、复制指令可用、导入标注 M6）

### AI 分析包（导出侧）
- 单文件 ZIP，`manifest.json` 校验和，三语 `instructions.md`，结果 Schema
- `emote_dictionary` / `emote_refs` / 按需 `content_ai`
- 新增 `session_context.session.broadcast_started_at` 与 `messages.jsonl.offset_seconds`（相对直播时间）
- 含平台、稳定身份、经济支持事件；不含任何凭据

## 4. 部分完成

| 项目 | 现状 | 缺口 |
| --- | --- | --- |
| 精简/完整存储模式 | 设置可保存；清理函数与测试齐全 | 自动清理未接入（M4/M6） |
| YouTube Live | 传输层、映射、登录、控制台、保留策略、模拟端到端完成 | 真实直播间采样、真实 OAuth 授权、真实配额与断网长时验证 |
| AI 分析中心 | 导出、任务说明、指令复制可用 | 导入、Schema 校验、分批（M6） |
| 观众画像 | 稳定身份、统计、昵称历史、关注 | 兴趣/喜恶/变化（M7） |
| 备份与恢复 | 文档与数据模型已设计 | 导出/导入/校验/回滚（M5） |
| Bilibili 经济事件 | 映射与金额规则完成 | 礼物/SC/大航海真实事件仍未观测 |

## 5. 未完成

- YouTube 真实凭据下的端到端验收（本轮阻塞原因：无 API Key / OAuth 客户端）
- Bilibili 礼物 / SC / 大航海真实事件复核、`SEND_GIFT_V2`、`dm_v2`
- AI 结果导入与 Schema 校验、重复导入保护
- 长期观众 AI 画像与增量更新
- 可移植备份 `.livememory`
- 数据删除 UI、存储占用管理
- 干净 Windows 环境 EXE 验收、代码签名、发布流水线
- 韩语 / 西班牙语

## 6. 测试结果（2026-11-08，v0.2.0）

```bat
node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"
```

结果：**259 个测试通过，0 失败，约 6.5 秒**。

新增测试文件：`youtube-link`、`youtube-api`、`youtube-oauth`、`youtube-adapter`、`youtube-mapper`（重写）、`youtube-retention`、`youtube-token-store`、`integration/youtube-session`。
修改：`migration-emotes`（v1→v3）。

EXE：`scripts/verify-exe.mjs` 9/9 通过（含普通权限、损坏恢复、端口顺延、单实例、不可写目录、异目录运行、解压复用、三语 CLI）。
EXE 实测：`schema=3`、`version=0.2.0`、`/api/youtube/status` 未配置状态清晰、`live.js` 含 YouTube 入口。

UI 截图（无头 Edge + DevTools）：
- `docs/screenshots/live-youtube-light-zh-CN.png`
- `docs/screenshots/live-youtube-dark-zh-CN.png`
- `docs/screenshots/live-youtube-mobile-light-zh-CN.png`
- `docs/screenshots/live-youtube-recording-zh-CN.png`
- `docs/screenshots/live-youtube-unconfigured-zh-CN.png`

**未在第二台干净 Windows 机器上做视觉验收。**

## 7. 已知问题与限制

1. `Ctrl+C` 的真实控制台信号未自动化；通过 `startServer().close()` 与代码路径验证。
2. EXE 仅在本开发机验证；沙箱内截图通过 DevTools 完成。
3. 动态选中的端口不写回设置。
4. 静态资源 `no-cache` 且无 ETag。
5. 分析包未分批（单包上限 20,000 条）。
6. 图表无区间选择。
7. 无删除场次/观众 UI。
8. `--help` 通过管道截断时进程可能以 1 退出（PowerShell 管道提前关闭）。
9. Bilibili 平台表情仅保存名称/id，不显示图片；`dm_v2` 未解码。
10. YouTube 每次 `liveChatMessages.list` 消耗 5 个配额单位；10,000/天约等于 2,000 次轮询，长时间直播会耗尽。界面显示已用/上限，配额守卫会以明确原因停止轮询而不是撞墙重试。
11. YouTube 会员事件的评论会保存到 `content`，但**不计入消息数**，也不进入 AI 包的 `messages.jsonl`（分析包仍只含 chat + super_chat）；这是为防止「会员事件被当成聊天」而做的保守取舍。
12. 未配置凭据时 YouTube 面板只显示说明，不提供伪造的登录入口。

## 8. 阻塞事项

- **YouTube 真实端到端验收缺少开发者凭据**：需要一次性配置 Google Cloud 项目 + 启用的 YouTube Data API +（OAuth 客户端 或 公开数据用 API Key），并解决 Developer Policies III.D.1.d 对「开源项目内嵌凭据」的限制（例如仅发布构建注入 + 合规评估，或由发布方申请许可）。在此之前，真实消息数、真实稳定身份比例、真实 OAuth 授权均**无法给出**。
- 其余无硬阻塞。

## 9. 下一步目标

1. **在有凭据的环境完成 YouTube 真实验收**：公开直播采样聊天、Super Chat、会员；记录真实条数与身份完整率；验证真实断网与配额行为。
2. **M6 AI 结果导入**：JSON/粘贴 → Schema 校验 → `task_id`/`session_id`/`viewer_id`/`message_refs` 校验 → 事务写入与重复导入保护。
3. M4 存储管理：自动精简清理、删除场次/观众 UI。

## 10. 最近 Commit

- 本轮：`aa27417` feat: connect real YouTube Live chat with anonymous keys and Google OAuth（文档哈希修正随后一个 `docs:` 提交落地）
- 上一轮：`02d3101` feat: preserve chat emoji and generalize the AI analysis centre
- P1：`a6e3443` feat: connect real Bilibili live chat and record canonical events
- P0：`e7b88d5` fix: start LiveMemory without administrator rights on Windows
- 首轮：`5cb66a9` feat: initialize LiveMemory with launcher, local console and recording pipeline

> 为满足 GitHub 隐私邮箱策略，历史提交已重写为匿名 noreply 身份，旧 hash 失效。
