# 版本变化（CHANGELOG）

## 0.2.0 — 2026-11-08（YouTube Live 接入；并包含上一轮的表情兼容与 AI 分析中心通用化）

### 新增（本轮：YouTube Live）

- **真实的 YouTube Live 接入（仅直播）**
  - 直播定位：`videos.list` + `liveStreamingDetails`，支持 `watch?v=`、`/live/`、`youtu.be`、`embed`、`shorts`、裸视频 ID；普通视频、未开始、已结束、聊天关闭、私密/无权限、配额不足、网络错误都有独立提示。
  - 聊天传输：`liveChatMessages.list` + `nextPageToken`，遵守 `pollingIntervalMillis`；断线指数退避重连且**不结束场次**；`offlineAt` / `chatEnded` / `chatDisabled` 才结束；本地配额守卫。
  - 身份：`youtube:<channelId>`；只有昵称时 `viewer_uid=null`，不建档案、不按昵称合并。
  - 经济事件：Super Chat、Super Sticker、新会员、会员里程碑、赠送会员、收到赠送会员；`amountMicros` 用 BigInt 转最小货币单位，`JPY` 等零小数币种正确；多币种分别累计。
  - 会员等级/月数/赠送数量**不换算金额**；收到赠送会员的用户 `is_paid=false`，不再是付款者。
- **两种官方凭据模式，普通主播零 API Key 配置**
  - 公开直播模式（`api-key`）：应用级 API Key 匿名读取公开聊天，无需 Google 登录、无需 OAuth。
  - OAuth 模式：桌面应用 PKCE + 系统浏览器 + `127.0.0.1` 单次回环回调 + `state` 校验 + 5 分钟超时；自动刷新、重启恢复、失效提示、重新登录、退出登录（并 revoke）。
  - 凭据不进入仓库与默认构建；可用环境变量或数据目录私有文件提供；缺配置时界面明确说明，不伪造登录。
  - 令牌 AES-256-GCM 加密保存在 `<数据目录>\secrets\youtube-oauth.json`；`status()`、日志、AI 包、备份均不含令牌。
- **数据保留策略**
  - YouTube 公开聊天原文默认 30 天后自动清理（启动、场次结束、手动触发）；保留计数、身份、昵称历史与币种合计。
  - SQLite schema v3：`sessions.platform_started_at`（平台直播开始时间），用于相对直播时间。
- **界面**
  - 直播记录新增「YouTube 直播」标签：模式/登录状态、链接输入、检查结果、频道、当前观看、API 配额、保留策略与手动清理。
  - 录制中显示 YouTube 连接状态与当前观看人数；动态流支持 Super Sticker 与会员里程碑留言。
  - 三语（zh-CN / ja / en）、明亮/黑暗/跟随系统、390px 窄屏全部覆盖。
- **AI 分析包**
  - `session_context.session.broadcast_started_at` 与 `messages.jsonl.offset_seconds`（相对直播时间）。
- **计数修正**
  - `payment_event_count` 只在 `is_paid=true` 时累加：免费礼物与「收到赠送会员」不再计入付费事件。

### 新增（上一轮，随本版本发布）

- **Unicode Emoji 与平台表情**
  - `cleanText` / `truncateText` 改为按 grapheme 截断，组合 Emoji、变体选择符、肤色修饰符与 ZWJ 序列不会再被截断成乱码。
  - canonical event 新增可选 `emotes` 元数据（`id` / `code` / `name` / `source`），仅来自平台可靠字段。
  - SQLite schema v2：`events.emotes TEXT`，v1 旧库原地升级，旧消息 `emotes=NULL`。
  - Bilibili：识别 `DANMU_MSG.info[0][13]`，保存 `emoticon_unique` 与 `info[1]` 文字标签；无元数据时普通 `[文字]` 不误判。
  - 只有表情、没有正文的消息也会入库；UI 与 AI 包使用名称/id 回退。
  - 未知表情标记 `[未知平台表情：emote_id=…]`，不猜测情绪，不下载图片。
  - YouTube 离线 mapper 预留：文本、Unicode Emoji、`:code:` 自定义表情、稳定 channelId；明确标记未真实接入。

- **AI 分析包（文本优先）**
  - `session_context.emote_dictionary` 去重表情字典；`messages.jsonl` 使用 `emote_refs`。
  - 仅在原文不足时生成 `content_ai`，避免重复名称导致包膨胀。
  - `manifest.counts` 增加 `messages_with_emotes` / `emote_kinds`。
  - 三语 `instructions.md` 增加 Emoji/平台表情规则、未知表情禁止猜测、礼物不代表话题偏好、单表情不足以建立长期兴趣。

- **AI 分析中心通用化**
  - 界面统一为 AI 分析中心 / AI 分析包 / AI 分析指令 / AI 分析结果 / 导入 AI 分析结果，不再绑定 ChatGPT。
  - 新增自然语言任务说明卡（整场话题、时间变化、回看片段、新观众、既有观众画像）。
  - 三语 AI 分析指令由软件按任务生成，用户无需手写提示词。
  - 明确“使用你选择的 AI 服务”，不假设通用 AI 网站。

### 修复

- 聊天文本截断可能切断 surrogate pair / ZWJ 序列的问题。
- 精简清理现在同时清除 `content` 与 `emotes`，不残留聊天元数据。

### 测试

- 自动化测试从 195 增至 **259**：新增 YouTube 链接解析、官方错误映射、配额计费、PKCE/回环/令牌交换与刷新、登录状态机与重启恢复、令牌加密与篡改、全部经济事件、`amountMicros` 多币种、轮询/重连/结束/配额守卫、保留策略、v1→v3 迁移，以及本地假 API 的端到端。
- 真实 Bilibili 房间 `5050` 采样：21/32 条 `DANMU_MSG` 带 `info[0][13]`，`info[1]` 为文字标签，`dm_v2` 为空。
- EXE 重建（90.1 MB，SHA-256 `a1becfb6…`），`verify-exe.mjs` 9/9。

### 尚未包含 / 未验证

- **YouTube 真实凭据下的直播采样**：本轮没有可用的 API Key 或 OAuth 客户端，真实消息条数、稳定身份比例、真实 Super Chat/会员样本均未取得。
- YouTube 真实断网、配额耗尽、真实 OAuth 同意屏与 refresh token 过期规则未在线验证。
- AI 结果导入、Schema 校验、分批与长期画像（M6/M7）。
- 表情图片下载、缓存与显示。
- Bilibili `SEND_GIFT_V2`、礼物/SC/大航海真实事件复核。

## 0.1.0 — 2026-11-08（首个可运行版本）

### 新增

- **Windows 启动器**
  - 环境检查（Node ≥ 22.5、`node:sqlite`）
  - 数据目录解析与可写探测：`%LOCALAPPDATA%\LiveMemory`
  - 单实例锁与陈旧锁接管
  - 端口自动选择（47800 起，冲突顺延，最后系统分配）
  - 服务就绪后再打开系统默认浏览器
  - 中文 / 日本語 / English 命令行，跟随系统语言并读取已保存偏好
  - UTF-8 控制台
  - 优雅退出（停止记录、WAL checkpoint、关闭数据库）
  - 崩溃后恢复：把遗留场次标记为“已中断”

- **网页控制台（Apple 风格）**
  - 直播记录、直播历史、观众档案、AI 分析中心、设置
  - 明亮 / 黑暗 / 跟随系统，首帧无闪烁，持久化并响应系统变化
  - 三语界面，语言切换即时生效并持久化
  - 响应式布局（桌面、窄窗、平板、手机）
  - 消息密度图（Canvas，自适应粒度）、实时事件流、最活跃观众
  - 单场详情：统计、支持、时间线、存储信息、AI 占位
  - 观众详情：稳定 ID、昵称历史、累计支持、参与场次、重点关注

- **本地记录引擎**
  - SQLite（`node:sqlite`，WAL）与版本化迁移
  - 统一事件模型与单一写入管线
  - 重复事件去重（唯一键 + 指纹），金额与计数不会翻倍
  - 按币种 + 实际支付/展示价值分账
  - 稳定观众身份（`platform:uid`）与昵称历史
  - 模拟直播：聊天、免费/付费礼物、醒目留言、大航海、故意重复投递

- **AI 分析包导出（`livememory-analysis-v1`）**
  - 单文件 ZIP：manifest、场次上下文、messages.jsonl、观众上下文、三语提示词、结果 Schema
  - 内容文件 SHA-256 校验
  - 导出记录与分析状态

- **Windows EXE**
  - Node SEA + postject，可见控制台，内置运行时与 SQLite
  - 资源解压到数据目录（不可写时回退临时目录）

- **工程**
  - 零运行时依赖，无前端构建
  - 86 个自动化测试（单元 + 集成）
  - 完整文档体系与 ADR

### 尚未包含（按路线图）

- 真实 Bilibili / YouTube 接入（M3）
- AI 结果导入与 Schema 校验（M6）
- 长期 AI 观众画像（M7）
- 可移植备份与跨电脑恢复（M5）
- 自动清理原始弹幕（M4/M6）
- 韩语 / 西班牙语

### 已知问题

- 未在第二台干净 Windows 设备验收
- EXE 未签名
- 真实 Ctrl+C 未自动化验证
- 动态端口不回写设置
