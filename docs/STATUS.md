# 工程状态（STATUS）

最后更新：2026-11-08（YouTube 免登录实验接入真实验证，版本 0.3.0，schema 4）

> 本文件是唯一进度来源。只要代码与本文不一致，以代码与实测为准，并立即修正本文。

## 1. 当前阶段

- 里程碑：**M0 / M1 / M2 核心 / P0 / P1 / P2 完成；M3 进行中（Bilibili + YouTube 官方/匿名实验双路径）**
- 版本：`0.3.0`（`package.json` 与 `src/shared/app-info.mjs` 一致）
- 数据库 schema：**4**（v2 `events.emotes`，v3 `sessions.platform_started_at`，v4 `events.badges` + `events.amount_display`）
- 分支：`main`，本地提交，未 Push

## 2. 本轮完成（2026-11-08）：YouTube 免登录实验接入

### 2.1 研究结论（先回答最重要的问题）

| 问题 | 结论 |
| --- | --- |
| 五个参考仓库是否都实际查看源码？ | 是。`youtube-chat`、`pytchat`、`ytmemchat_wails`、`chat-downloader` 逐文件读取；`komet` 仓库只有 README/许可证/截图，**没有应用源码**，已如实记录。 |
| 是否存在完全合规的免登录官方通道？ | **不存在**。官方 Data API 需要 API Key 或 OAuth；匿名网页接口不是官方 API。 |
| 匿名网页接口是否可用？ | **可用**。2026-11-08 两个真实直播间均成功读取。 |
| 是否无需用户 API Key / OAuth / Cookie？ | **是**。请求只用公开直播页自身的 context 与页面公开 Web key，不发送 Cookie。 |
| 是否取得稳定 Channel ID？ | 聊天与 Super Chat **100%**；新版 gift 消息接口本身无 Channel ID，记 0%，不伪造。 |
| 是否合法/符合平台条款？ | **不能确认，且很可能违反 YouTube ToS 的自动化访问与个人信息收集限制。** 因此不做默认方式，必须显式启用。 |
| 官方路径是否保留？ | **保留**。官方 API Key / OAuth 仍是默认与推荐路径。 |

- 因此产品上采用 **“官方优先 + 实验性免登录显式 opt-in”**：
  - 默认 `youtubeCaptureMode=official`；
  - 无官方凭据时，页面显示真实原因，并提供“启用免登录实验模式”按钮；
  - 启用后明确显示“非官方接口 / 可能与服务条款冲突 / 可能随时失效”；
  - 不在匿名失败时静默切到其他实现，也不伪造成功。
- 完整研究、许可证、真实采样与政策分析见 `docs/YOUTUBE_ANONYMOUS_RESEARCH.md`。

### 2.2 新增代码

```text
src/platforms/youtube/anonymous/
  parser.mjs      观看页/聊天页/continuation/金额/表情/badge 的纯解析
  client.mjs      公开网页与 get_live_chat 的 HTTP 传输、429/失效/协议错误
  adapter.mjs     轮询、timeout、退避、continuation 刷新、结束检测、可能漏消息诊断
src/shared/badges.mjs      owner/moderator/verified/member badge 规范化
src/shared/capture-mode.mjs official / anonymous 模式
scripts/verify-youtube-anonymous.mjs 真实网络 E2E 采样
```

- 匿名适配器只负责传输与解析；所有事件仍走现有 `mapper.mjs` → Canonical Event → `EventIngest` → SQLite。
- 不直接写数据库，不新建观众档案系统。
- 无新增运行时依赖；EXE 仍是 Node SEA 单文件。

### 2.3 数据与身份

- schema **v4**：
  - `events.badges TEXT`：`[{type, label}]`，只保存平台确认的 owner/moderator/verified/member；
  - `events.amount_display TEXT`：平台显示的原始金额字符串（如 `HK$2,000.00`），用于审计。
- 稳定身份仍为 `youtube:<channelId>`；匿名 gift 无 Channel ID 时 `viewer_uid=null`，不创建档案、不按昵称合并。
- 匿名聊天事件 `source_quality=verified`；Super Chat/会员/gift 因格式化金额或未知价格保持 `estimated`。
- 金额：
  - 明确币种符号/代码（`HK$`、`US$`、`A$`、`€`、`£`、`₹`、`JPY` 等）才直接换算；
  - 裸 `$`/`¥` 按页面 `gl` 解析并保留原始显示文本；无法确认则金额未知；
  - 会员等级、赠送数量、gift 名称不换算金额；gift 只记 `is_paid=true`、`amount_minor=null`。
- 表情：
  - Unicode Emoji 原样进 `content`；
  - 自定义表情用 `:code:` 文本回退，并保存 `id/code/name/source`；
  - 不把图片 URL 当正文，不下载图片。

### 2.4 实时稳定性

- Continuation 每页更新；使用服务端 `timeoutMs`（真实样本 10000ms），clamp 到 2–30 秒。
- 400/`failedPrecondition` → 重新打开 live_chat 页，不清空已入库消息；重复消息靠 `external_id` 去重。
- 429 → 至少 30 秒退避，读取 `Retry-After`；连续 8 次失败才停止并保存，不做无限重试。
- 网络/5xx → 指数退避（1→60s），**不结束场次**。
- 每 60 秒检查 watch 页；`isLiveNow=false` 或 `isLiveContent` 已结束 → 自动结束场次。
- `chat disabled / ended / unavailable` → 明确结束或失败，不当作网络错误。
- 相邻消息时间跳变 > 90 秒记 `gapSuspected`；UI 只显示“可能漏消息”，不声称确定遗漏。
- 连接状态、轮询次数、actions/identity/paid/gift 计数、错误码写入 `status.connection.detail`；不记录正文、昵称历史或敏感凭据。

### 2.5 保留策略修正

- `youtubeRawRetentionDays` 从 1–3650 改为 **1–30，默认 30，最大 30**。
- 清理范围：`content`、`emotes`、`badges`、`amount_display`，以及过期 YouTube 观众的昵称历史与当前昵称。
- 保留：事件行、计数、稳定 Channel ID、场次/观众币种合计。
- 明确局限：稳定 ID 与按人聚合的金额/计数仍保留，不能声称“已删除全部个人数据”；严格删除模式留给后续里程碑。

### 2.6 界面

- YouTube 标签默认显示官方路径；无官方凭据时显示真实原因 + “启用免登录实验模式”。
- 实验模式显示高对比 warning、无需 API Key、无需 Google 登录、数据保留说明。
- 高级设置（`<details>`）可切换官方 / 实验模式；设置页增加 YouTube 接入卡。
- 直播中显示“实验性网页聊天”、消息数、可能漏消息提示；官方模式保留 API 配额显示。
- 动态流显示确认的 badge 文本（Member/Moderator/Owner/Verified）。
- 三语 zh-CN / ja / en 键完全对齐；明亮 / 黑暗 / 跟随系统、390px 窄屏均验证。

### 2.7 真实直播采样（不是模拟）

| 房间 | 时长 | actions | 事件 | chat | 经济事件 | 稳定 Channel ID | badge | 错误 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `FKLZiufsCk0` | 35s | 92 | 86 | 85 | 1 SC：`HK$2,000.00` → HKD 200000 | 86/86（100%） | 49 | 0 |
| `gXawf8GZDI8` | 35s | 103 | 100 | 87 + 13 gift | 13 gift，金额未知 | chat 87/87（100%），gift 0/13 | 3 | 0 |

- 两场均 `pollCount=3`、0 失败、0 重复；停止后进入 `ended`。
- 未观测到 Super Sticker、会员里程碑、赠送会员，因此这些映射标记为“结构已实现、真实未验证”。
- 没有官方凭据，**未完成与官方 Data API 的并排对照**；不声称官方对照。
- 打包后的 EXE 在房间 A 实测约 10 秒：72 条事件、72/72 Channel ID、0 错误；最终样本未出现付费事件（源码 35 秒样本捕获到 HKD Super Chat）。

### 2.8 测试与 EXE

- 自动化：**287 个测试通过，0 失败，约 17.7 秒**。
- 新增：
  - `youtube-anonymous-parser`：真实页面/续页结构、金额与币种、Unicode/自定义表情、badges、watch 状态、gift 无身份；
  - `youtube-anonymous-adapter`：continuation 失效重开、网络错误退避恢复、场次不结束；
  - `integration/youtube-anonymous-session`：HTTP → 匿名传输 → mapper → ingest → SQLite → 观众档案 → 自动结束；
  - retention：badges/amount_display 清理、过期昵称清理；
  - settings：模式校验、30 天上限；
  - migration：v1→v4。
- EXE：`dist/LiveMemory.exe` **90.2 MB**，SHA-256 `9d586aa9cbe60274c6755b0b8ba8204cc111e6c8261b329868c38bb65190604c`；`scripts/verify-exe.mjs` **9/9 通过**；`--version` 为 0.3.0。
- UI 截图：
  - `docs/screenshots/live-youtube-anonymous-unconfigured-zh-CN.png`
  - `docs/screenshots/live-youtube-anonymous-light-zh-CN.png`
  - `docs/screenshots/live-youtube-anonymous-dark-zh-CN.png`
  - `docs/screenshots/live-youtube-anonymous-recording-zh-CN.png`
  - `docs/screenshots/live-youtube-anonymous-mobile-zh-CN.png`
  - `docs/screenshots/settings-youtube-anonymous-zh-CN.png`

## 3. 上一轮完成（2026-11-08）：YouTube 官方 API 接入

- 官方 `videos.list` + `liveChatMessages.list` 轮询、配额守卫、官方错误映射。
- 官方 API Key（公开数据）与 OAuth（PKCE + 回环回调 + 自动刷新 + 撤销）双模式。
- 官方映射：文本、Super Chat、Super Sticker、会员、里程碑、赠送会员、收到赠送会员。
- 官方路径仍完整保留；默认仍为官方。
- 上一轮没有任何真实 Google 凭据，因此官方路径的真实直播采样仍未完成。

## 4. 已完成（有代码与验证）

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
- `node:sqlite`，WAL，schema 4，迁移可重复执行
- 表：`sessions`、`events`、`viewers`、`viewer_nicknames`、`viewer_sessions`、`viewer_currency_totals`、`session_currency_totals`、`ai_packages`、`app_meta`
- 唯一写入管线 `EventIngest`：去重 → 观众聚合 → 场次金额 → 场次计数，单事务
- 观众身份 `platform:uid`；昵称历史独立保存；跨平台不合并
- 金额整数最小单位，按 `currency` + `value_kind` 分账
- `events.badges` / `events.amount_display`（v4）

### 服务器与 API
- 仅监听 `127.0.0.1`；Host/Origin 校验、CSP、nosniff、无 framing；路径穿越与 1 MB JSON 限制
- 路由：health、bootstrap、status、settings、sessions、simulate、bilibili、youtube、viewers、events + SSE、storage、AI 包
- 设置持久化 `config/settings.json`（新增 `youtubeCaptureMode`；`youtubeRawRetentionDays` 上限 30）

### 平台
- 模拟直播（中/日/英 24 位观众、话题漂移、Emoji、平台表情、3% 重复投递）
- Bilibili 真实直播：WebSocket、鉴权、心跳/看门狗/重连、弹幕/礼物/SC/大航海映射、扫码登录、平台表情元数据
- YouTube 官方 Live：官方 API Key / OAuth、轮询、官方事件映射、配额、保留策略
- YouTube 匿名实验：网页 watch/live_chat、continuation、真实聊天/SC/gift/badge、退避与重连、自动结束
- 两套 YouTube 适配器共用 Canonical Event、EventIngest、SQLite、UI、AI 包

### 网页控制台（Apple 风格）
- 5 页、三语、明亮/黑暗/跟随系统、首帧无闪烁、响应式
- Canvas 消息密度图、SSE 实时动态、观众档案与昵称历史
- YouTube 官方/实验模式选择、真实状态、badge、经济支持展示
- AI 三步向导（导出可用、复制指令可用、导入标注 M6）

### AI 分析包（导出侧）
- 单文件 ZIP，`manifest.json` 校验和，三语 `instructions.md`，结果 Schema
- `emote_dictionary` / `emote_refs` / 按需 `content_ai`
- `session_context.session.broadcast_started_at` 与 `messages.jsonl.offset_seconds`
- 新增 `badges` 与 `amount_display`（仅存在时输出）
- 含平台、稳定身份、经济支持事件；不含任何凭据

## 5. 部分完成

| 项目 | 现状 | 缺口 |
| --- | --- | --- |
| 精简/完整存储模式 | 设置可保存；清理函数与测试齐全 | 自动清理未接入（M4/M6） |
| YouTube 官方 Live | 传输层、映射、登录、控制台、保留策略、模拟端到端完成 | 真实凭据下的直播采样、真实 OAuth 授权、真实配额与长时断网验证 |
| YouTube 匿名 Live | 真实双房间采样、EXE 实测、身份/金额/badge/gift、重连测试完成 | 条款合规未确认；Super Sticker/会员未真实观测；未做官方并排对照 |
| AI 分析中心 | 导出、任务说明、指令复制可用 | 导入、Schema 校验、分批（M6） |
| 观众画像 | 稳定身份、统计、昵称历史、关注 | 兴趣/喜恶/变化（M7） |
| 备份与恢复 | 文档与数据模型已设计 | 导出/导入/校验/回滚（M5） |
| Bilibili 经济事件 | 映射与金额规则完成 | 礼物/SC/大航海真实事件仍未观测 |

## 6. 未完成

- **完全合规的 YouTube 免登录方案不存在**；匿名网页接口仍可能违反 ToS，正式发布前必须做法律/平台评估。
- YouTube 官方 API 真实凭据下的端到端验收（本轮仍无凭据）
- Bilibili 礼物 / SC / 大航海真实事件复核、`SEND_GIFT_V2`、`dm_v2`
- AI 结果导入与 Schema 校验、重复导入保护
- 长期观众 AI 画像与增量更新
- 可移植备份 `.livememory`
- 数据删除 UI、严格删除/去标识化模式
- 干净 Windows 环境 EXE 验收、代码签名、发布流水线
- 韩语 / 西班牙语

## 7. 测试结果（2026-11-08，v0.3.0）

```bat
node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"
```

结果：**287 个测试通过，0 失败，约 17.7 秒**。

EXE：`dist/LiveMemory.exe` 90.2 MB，SHA-256 `9d586aa9…`；`scripts/verify-exe.mjs` 9/9 通过。
EXE 内实测：schema=4、version=0.3.0、匿名模式真实入库 72 条事件、72/72 Channel ID、0 错误。

真实直播采样：见 §2.7 与 `docs/YOUTUBE_ANONYMOUS_RESEARCH.md`。

UI 截图：见 §2.8。

## 8. 已知问题与限制

1. `Ctrl+C` 的真实控制台信号未自动化；通过 `startServer().close()` 与代码路径验证。
2. EXE 仅在本开发机验证；沙箱内截图通过 Headless Chrome + DevTools 完成。
3. 动态选中的端口不写回设置。
4. 静态资源 `no-cache` 且无 ETag。
5. 分析包未分批（单包上限 20,000 条）。
6. 图表无区间选择。
7. 无删除场次/观众 UI。
8. `--help` 通过管道截断时进程可能以 1 退出（PowerShell 管道提前关闭）。
9. Bilibili 平台表情仅保存名称/id，不显示图片；`dm_v2` 未解码。
10. YouTube 官方 API 每次聊天请求 5 配额；匿名路径不消耗官方配额但属于未公开接口。
11. 匿名 fetch 未携带登录 Cookie，因此会员限定/私密直播不可读；这是安全边界，不是缺陷。
12. 匿名 gift 没有 Channel ID 与价格，不能累计金额。
13. 匿名接口可能被 429、验证码、consent 或页面结构变化阻断；应用会停止/退避并显示真实原因。
14. 30 天保留只覆盖原文、badge、金额显示文本与过期昵称；稳定 ID 与聚合金额仍保留，不等于完全删除个人数据。

## 9. 阻塞事项

- **法律/平台合规**：匿名网页客户端可能违反 YouTube ToS；在未获得平台书面许可或法务确认前，不能把它作为默认发布功能，也不能声称合规。
- **官方 YouTube 真实验收**：仍缺合法可用的 API Key / OAuth 客户端。
- **真实付费事件覆盖**：Super Sticker、会员、赠送会员未在真实直播中观测到。

## 10. 下一步目标

1. 对匿名路径做正式合规评估；若不允许发布，则只保留内部/开发者模式，并强化官方 API 引导。
2. 在持有官方凭据的环境完成 YouTube 官方 API 真实验收与匿名并排对照。
3. **M6 AI 结果导入**：JSON/粘贴 → Schema 校验 → `task_id`/`session_id`/`viewer_id`/`message_refs` 校验 → 事务写入与重复导入保护。
4. M4 存储管理：自动精简清理、删除场次/观众、严格删除模式。

## 11. 最近 Commit

- 本轮：待提交（`feat: record public YouTube Live chat without a developer key`）
- 上一轮：`7a86e58` docs: cite the primary YouTube authorization and policy sources
- 上一轮：`aa27417` feat: connect real YouTube Live chat with anonymous keys and Google OAuth
- P1：`a6e3443` feat: connect real Bilibili live chat and record canonical events
- 首轮：`5cb66a9` feat: initialize LiveMemory with launcher, local console and recording pipeline
