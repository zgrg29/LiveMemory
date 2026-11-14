# YouTube 免登录直播聊天：开源方案研究与实际验证

日期：2026-11-08（Asia/Shanghai）
状态：**已实现并通过真实直播采样；属于非官方、实验性路径，不作为 LiveMemory 默认方式。**

---

## 1. 结论先行

| 问题 | 结论 |
| --- | --- |
| 是否真正无需登录？ | **是**。不发送 Cookie、OAuth token 或个人 API Key。 |
| 是否无需用户 API Key？ | **是**。请求只使用公开直播网页自身的 `INNERTUBE_CONTEXT` 与页面公开的 Web API key。 |
| 是否能取得真实聊天？ | **是**。两个真实直播间分别采样到 86 与 100 条事件。 |
| 是否能取得昵称？ | **是**。`authorName.simpleText` / `authorName.content`。 |
| 是否能取得稳定 Channel ID？ | **聊天与 Super Chat 可以**（真实样本 86/86、87/87）；**新版 gift 消息没有 Channel ID**（13/13 缺失），LiveMemory 不伪造。 |
| 是否能取得 Super Chat？ | **是**。真实样本：`HK$2,000.00`，解析为 `HKD 200000` 最小单位。 |
| 是否能取得 Super Sticker / 会员？ | **映射已实现，但未在真实直播中观测到**，因此标记为尚未真实验证。 |
| 是否符合 YouTube 条款？ | **不能确认，且很可能冲突**。YouTube ToS 禁止用自动化方式访问 Service、禁止收集可识别个人身份的信息，除非获得书面许可。v0.5.0 把它作为唯一 YouTube 路径，但仍不声称官方授权/合规；设置与隐私说明中如实提示可能失效。 |

---

## 2. 参考仓库逐项核对

所有源码均通过 GitHub API / raw 文件实际读取；未克隆失败后凭 README 猜测实现。

### 2.1 `letruxux/youtube-chat`

- 仓库：<https://github.com/letruxux/youtube-chat>
- 检查版本：`main` @ `d5722610e29ff8e13b8137e0430d4cd016d60953`（2025-03-29，v1.0.7）
- 许可证：`package.json` 写 `MIT`，但仓库树中**没有 LICENSE 文件**；只能按包元数据理解，不能视为完整许可证文本。
- 技术：TypeScript + 零运行时依赖，ESM。
- 实现：
  - `GET https://www.youtube.com/live_chat?is_popout=1&v=<id>`；
  - 从 HTML 中截取 `window["ytInitialData"] = ...`；
  - 只读取 `contents.liveChatRenderer.actions` 里的 `liveChatTextMessageRenderer`；
  - 轮询时重新拉取整页 HTML，自己用 `Set<messageId>` 做短期去重；
  - 解析 `authorName`、`authorExternalChannelId`、`authorBadges`、`timestampUsec`、`runs`。
- 局限：
  - 没有 Continuation Token，没有增量更新；高频重拉整页，不适合数小时直播；
  - 不解析 Super Chat / Super Sticker / 会员 / 礼物；
  - 没有错误分层、退避、429 处理；
  - 依赖 HTML 字符串切片（`split('"}};')`），对页面变化很脆弱。
- 本轮采用：只参考了“读取 live_chat 初始化页 + runs 结构 + `authorExternalChannelId`”的思路。没有复制代码；Continuation、退避、事件映射均自行实现。

### 2.2 `taizan-hokuto/pytchat`

- 仓库：<https://github.com/taizan-hokuto/pytchat>
- 检查版本：`master` @ `6c7dc03d069136d9ae124b7d47a26660a7c48a0c`（2021-07-24，v0.5.5）；**仓库已 archived**。
- 许可证：MIT。
- 技术：Python / httpx / protobuf 编码手写参数。
- 实现：
  - 不依赖 live_chat HTML，而是自行构造 protobuf 风格的 `continuation`（`liveparam.py`：videoId、channelId、时间戳、`past_sec`）；
  - POST 到 `youtubei/v1/live_chat/get_live_chat`，解析 `continuationContents.liveChatContinuation`；
  - 使用 `timeoutMs` 控制下一次请求；
  - `liveChatPaidMessageRenderer.purchaseAmountText.simpleText` 用正则拆符号与金额；
  - `liveChatMembershipItemRenderer`、`liveChatPaidStickerRenderer`、`liveChatDonationAnnouncementRenderer`。
- 局限：
  - 已停止维护；构造 continuation 依赖旧协议与 channelId；
  - 金额正则与币种映射把 `$` 直接当 USD，不能直接采用；
  - Python 运行时，不适合零依赖 Node EXE。
- 本轮采用：协议行为参考（continuation / timeout / actions / 事件类型），没有复制代码。

### 2.3 `HardDie/ytmemchat_wails`

- 仓库：<https://github.com/HardDie/ytmemchat_wails>
- 检查版本：`main` @ `9cb8966f778113027982f11cc1358196f04613d0`（2026-10-10）
- 许可证：**GPL-3.0**。
- 技术：Go + Wails + Svelte；Windows/macOS/Linux 桌面软件。
- 实现（`internal/youtube/nokey/client.go`）：
  - 空 API Key 时使用无 Key 客户端；填了 Key 则只用官方 v3，绝不回退（ADR 004）；
  - GET `live_chat?v=...`，提取 `"continuation":"..."`；
  - POST `youtubei/v1/live_chat/get_live_chat`，body 只有 `{context:{client:{clientName:"WEB", clientVersion}}, continuation}`；
  - 处理 `timedContinuationData` / `invalidationContinuationData` 的 `continuation` 与 `timeoutMs`；
  - 解析文本、Super Chat、Super Sticker；Super Chat 把金额字符串拼回消息正文；
  - 固定 5 秒轮询；失败后继续，不区分永久/暂时错误。
- 局限：
  - **GPL-3.0**：不能把代码复制进 MIT 的 LiveMemory；
  - 无 Channel ID、无会员、无 gift、无 badge；
  - 金额被拼进正文，没有金额字段；
  - 没有 429/退避/continuation 失效恢复。
- 本轮采用：验证了“无 Key 模式 + 明确的模式选择 + 不复用官方 Key”的产品设计；也确认了 2026 年该接口仍可用。**未复制 GPL 代码**。

### 2.4 `xenova/chat-downloader`

- 仓库：<https://github.com/xenova/chat-downloader>
- 检查版本：`master` @ `94ed3fe9dd2af8f193ea5b25adc7509a8cbb0e63`（0.2.8，2023-09-03）
- 许可证：MIT。
- 技术：Python。
- 实现（`chat_downloader/sites/youtube.py`）：
  - 从 watch 页取 `ytInitialData` + `ytcfg`；
  - 从 `conversationBar.liveChatRenderer` 或 chat 页取 continuation；
  - POST `youtubei/v1/live_chat/get_live_chat`，headers 带 `x-youtube-client-name/version`、visitorData；
  - 遍历 `continuationContents.liveChatContinuation.actions`，解析文本、paid message、paid sticker、membership、gift；
  - `authorExternalChannelId` → `author_id`；
  - `_CURRENCY_SYMBOLS` 把 `$`→USD、`A$`→AUD、`HK$`→HKD、`¥`→JPY；
  - 对轮询 timeout 做 clamp（最多 8 秒），避免长间隔漏消息；
  - 忽略 ticker（`addLiveChatTickerItemAction`）以避免 Super Chat 重复；
  - 有删除/封禁/占位事件处理。
- 局限：
  - `$` 直接当 USD，不适用于所有地区；
  - 代码停止在 2023，未覆盖 2026 的新版 `giftMessageViewModel`、`creatorHeart` 等；
  - Python 运行时。
- 本轮采用：**最重要的行为参考**：continuation、client headers、ticker 去重、事件分类、金额符号表。没有复制代码；金额改为“显式符号/代码优先，裸 `$`/`¥` 用页面国家上下文，否则未知”。

### 2.5 `sigvt/komet`

- 仓库：<https://github.com/sigvt/komet>
- 检查版本：`master` @ `dd6f8143a1a462e1a77da7ceb779c3949a4ed324`（2022-05-31）
- 许可证：AGPL-3.0。
- 技术/可检查内容：仓库只有 `README.md`、`LICENSE`、截图和 FUNDING；**没有应用源码**。README 指向已发布的 macOS/Windows 二进制。
- 功能描述：Tweetdeck 式多面板、会员/管理员/验证/Super Chat 过滤、Spamreaper 反垃圾。
- 结论：**无法检查实际接入代码**；AGPL-3.0 也使其不适合复制。仅作为 UI/过滤需求参考，未采用其实现。

---

## 3. 实际验证的协议（2026-11-08）

### 3.1 页面初始化

1. `GET https://www.youtube.com/watch?v=<id>`
   - `window["ytInitialPlayerResponse"]`：`videoDetails`（`isLive`、`isLiveContent`、`isUpcoming`、`channelId`、`author`、`title`）、`playabilityStatus`、`microformat.playerMicroformatRenderer.liveBroadcastDetails`。
2. `GET https://www.youtube.com/live_chat?is_popout=1&v=<id>`
   - 页面中的 `ytcfg.set({...})` 含 `INNERTUBE_CONTEXT`、`INNERTUBE_API_KEY`、`INNERTUBE_CONTEXT_CLIENT_NAME/VERSION`、`visitorData`。
   - `window["ytInitialData"].contents.liveChatRenderer` 含首批 `actions` 与 `continuations[0].invalidationContinuationData`。

### 3.2 增量请求

```http
POST https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?prettyPrint=false&key=<page key>
content-type: application/json
x-youtube-client-name: 1
x-youtube-client-version: <page version>
x-goog-visitor-id: <page visitorData>
origin: https://www.youtube.com
referer: https://www.youtube.com/live_chat?is_popout=1&v=<id>

{"context": <page INNERTUBE_CONTEXT>, "continuation": "<token>"}
```

响应：

- `continuationContents.liveChatContinuation.actions[]`
- `continuationContents.liveChatContinuation.continuations[0].invalidationContinuationData.continuation`
- 同节点的 `timeoutMs`（真实样本 10000ms）

### 3.3 观测到的事件 renderer

| renderer | 含义 | 本轮真实观测 |
| --- | --- | --- |
| `liveChatTextMessageRenderer` | 普通文字/Emoji/自定义表情 | ✅ 两个房间 |
| `liveChatPaidMessageRenderer` | Super Chat | ✅ 一个 `HK$2,000.00` |
| `giftMessageViewModel` | 新版直播礼物（无价格、无 Channel ID） | ✅ 13 条 |
| `liveChatPaidStickerRenderer` | Super Sticker | ⬜ 未观测到 |
| `liveChatMembershipItemRenderer` | 会员/里程碑 | ⬜ 未观测到 |
| `liveChatSponsorshipsGiftPurchaseAnnouncementRenderer` | 赠送会员 | ⬜ 未观测到 |
| `liveChatSponsorshipsGiftRedemptionAnnouncementRenderer` | 收到赠送会员 | ⬜ 未观测到 |
| `addLiveChatTickerItemAction` | 付费事件的 ticker 展示 | ✅ 结构存在；必须忽略以避免重复 |
| `addBannerToLiveChatCommand` | 置顶公告 | ✅ 忽略 |

### 3.4 身份字段

真实普通聊天样本：

```text
id                          ChwKGk...
timestampUsec               1794144956117356
authorName.simpleText       @name
authorExternalChannelId     UC...
authorBadges[].liveChatAuthorBadgeRenderer
  icon.iconType             MODERATOR / OWNER / VERIFIED
  customThumbnail           member badge
  accessibilityData.label   "Member (1 year)"
message.runs[]              text / emoji
```

- **稳定 Channel ID 是真实字段**，不是从昵称推导。
- 新版 gift 消息只有 `authorName.content`，没有 `authorExternalChannelId`；因此 13/13 无稳定身份，LiveMemory 写入 `viewer_uid=null`，不创建档案。
- 昵称仅作展示，**从不作为主键**。

### 3.5 金额字段

Super Chat 只有：

```json
"purchaseAmountText": {"simpleText": "HK$2,000.00"}
```

没有 `amountMicros`、没有 ISO 代码。因此：

- 明确前缀/代码（`HK$`、`US$`、`A$`、`€`、`£`、`₹`、`JPY` 等）才直接采用；
- 裸 `$` / `¥` 用页面 `INNERTUBE_CONTEXT.client.gl` 解析，并标记为 `currencySource=country`；
- 无法确认币种时 `amount_minor=null`、`currency=null`、`value_kind=unknown`，但保留 `amount_display` 原文；
- 绝不把会员等级、赠送数量或平台点数换算成金额。

### 3.6 不完整/变化风险

- 页面是未公开接口，字段随时可能改；
- `timeoutMs` 通常 10 秒，热门房间可能返回 0 条 action；这不一定代表漏消息；
- 我们增加了“相邻消息时间跳变 > 90 秒”的诊断 `gapSuspected`，UI 只说“可能漏消息”，不声称确定遗漏；
- 不绕过登录、验证码、年龄墙或地区限制；遇到 `Sign in`/consent 直接报 `YOUTUBE_WEB_RESTRICTED`。

---

## 4. 真实直播采样结果

采样时间：2026-11-08 21:58–22:16（Asia/Shanghai）。网络：本机住宅网络，未使用任何 cookie 或账号。

### 4.1 房间 A

- URL：`https://www.youtube.com/live/FKLZiufsCk0`
- 时长：35 秒
- `actionsSeen`：92
- 生成事件：86
- 消息类：86（chat 85 + Super Chat 1）
- 有昵称：86/86
- 有稳定 Channel ID：86/86（**100%**）
- 有 badge：49
- 经济支持：1 笔 Super Chat，`HK$2,000.00` → `HKD 200000`
- 入库事件：86
- 去重：0（无重复投递）
- 连接错误：0；`pollCount=3`
- 重连：未触发
- 停止后场次：`ended`，独立观众 33

### 4.2 房间 B

- URL：`https://www.youtube.com/live/gXawf8GZDI8`
- 时长：35 秒
- `actionsSeen`：103
- 生成事件：100
- chat：87；gift：13
- 聊天稳定 Channel ID：87/87（**100%**）
- gift 稳定 Channel ID：0/13（**0%**；接口本身没有该字段）
- 有 badge：3
- 经济支持：13 个 gift（`is_paid=true`，金额未知，未累计金额）
- 入库事件：100
- 去重：0
- 连接错误：0；`pollCount=3`
- 重连：未触发
- 停止后场次：`ended`，独立观众 21

### 4.3 打包后的 EXE

- 在 `dist/LiveMemory.exe` 内切换匿名模式，真实连接房间 A 约 10 秒：
  - schema=4，version=0.3.0
  - 72 条事件，72/72 有 Channel ID
  - 0 连接错误；最终样本没有付费事件（同一房间的 35 秒源码采样捕获到 `HK$2,000.00` Super Chat）
- 未在 EXE 中重复做 35 秒双房间采样；源码与 EXE 使用同一套 `src/`。

### 4.4 未完成的真实对照

- 没有合法可用的官方 API Key / OAuth 客户端，**未做官方 API 与匿名接口的并排比较**；不能声称消息完整率、延迟或付费事件数量已与官方一致。
- Super Sticker、会员里程碑、赠送会员未在真实直播中观测到；只有结构测试样本。
- 未做数小时长直播、真实 429、真实断网重连；这些只有自动化测试覆盖。

---

## 5. 平台条款与数据保留

### 5.1 条款风险

YouTube Terms of Service（2023-11-06）的 “Permissions and Restrictions” 明确禁止：

1. 除 Service 明确授权或书面许可外，访问、复制、下载、分发、传输、展示任何 Service 内容；
2. 规避、禁用或干扰 Service 的安全/限制功能；
3. **使用自动化方式访问 Service**（robots、botnets、scrapers），除非是遵守 robots.txt 的公共搜索引擎或获得 YouTube 书面许可；
4. 收集或抓取可识别个人身份的信息（例如用户名），除非本人许可或符合第 3 条例外。

来源：<https://www.youtube.com/static?template=terms>

YouTube API Services Terms of Service 还要求 API Client 只通过文档描述的方式访问 API：
<https://developers.google.com/youtube/terms/api-services-terms-of-service>

因此：

- 该方式**不是官方 API**，很可能违反 YouTube ToS；
- v0.5.0 起它是**唯一** YouTube 连接路径，不再要求用户切换模式；设置/隐私说明保留简短、真实的失效与授权风险提示；
- 正常连接界面不堆叠技术模式警告，也不显示伪造的官方登录/成功；
- 官方 Data API 双轨已删除，不再作为推荐路径。

### 5.2 保存期限

- 旧实现允许 `youtubeRawRetentionDays` 到 3650 天，这与“YouTube API 数据最多 30 个日历日”的政策声明矛盾。本轮改为 **1–30 天，默认 30 天，最大 30 天**。
- 清理范围扩大到：
  - `events.content`
  - `events.emotes`
  - 新增 `events.badges`
  - 新增 `events.amount_display`
  - 过期 YouTube 观众的 `viewer_nicknames` 与 `viewers.nickname`
- 保留：
  - 事件行、消息计数、独立观众数
  - 稳定 Channel ID（`youtube:<channelId>`）
  - 场次/观众币种合计
- **这仍不是“删除所有个人数据”**：稳定 Channel ID 与按人聚合的金额/计数仍保留。若监管或平台要求彻底删除，需要增加“删除指定观众/场次”的严格模式；本轮不声称已完成完全合规。
- 公开网页接口不是官方 Data API，不能因为“不是 API”就认为可以无限期保存观众数据；即使 v0.5.0 不再使用 OAuth，也采用 30 天上限作为保守默认。

---

## 6. 最终选型

### 采用

- 自行实现 **Node ESM、零运行时依赖** 的 `src/platforms/youtube/anonymous/`：
  - `parser.mjs`：HTML/JSON/金额/表情/badge 解析
  - `client.mjs`：页面与 continuation HTTP 传输、错误分层
  - `adapter.mjs`：轮询、超时、退避、continuation 刷新、结束检测
- 复用现有 `mapper.mjs`、Canonical Event、EventIngest、SessionManager、SQLite、UI、AI 包。
- v0.5.0 起该公开网页路径是**唯一** YouTube 入口；不再有官方 API 并行实现。

### 不采用

- 不引入 Python、Playwright、Puppeteer、`youtube-chat` npm 包或任何新运行时依赖。
- 不复制 GPL/AGPL 代码。
- 不把匿名接口伪装成官方 API。
- 不使用 Cookie、OAuth token、登录态或验证码绕过。

---

## 7. 复现

```bat
:: 代码级测试
node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"

:: 真实直播（需替换为正在直播的 URL；只打印聚合，不打印正文）
node scripts/verify-youtube-anonymous.mjs https://www.youtube.com/live/<VIDEO_ID> 35

:: EXE
dist\LiveMemory.exe --no-open --port 48320 --data-dir tests\.tmp\exe-anon
:: 打开 http://127.0.0.1:48320，直播记录 → YouTube → 启用实验模式
```
