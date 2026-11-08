# 平台接入（PLATFORM_INTEGRATIONS）

状态：**Bilibili 最小真实闭环已实现并通过真实直播间验证（弹幕身份、平台表情元数据）；礼物 / SC / 大航海按参考实现映射但尚未在真实直播间观测到事件。YouTube 官方 Data API / OAuth 路径完整实现但缺真实凭据验收；YouTube 免登录网页聊天已实现并通过两个真实直播间采样，属于非官方实验路径，默认关闭。** 模拟平台（mock）保持可用。

## 1. 参考仓库分析（只读，不修改）

仓库：`https://github.com/zgrg29/bili-gift-drop`（克隆到 `.ref/bili-gift-drop`，已 gitignore）

| 能力 | 参考文件 | 结论 |
| --- | --- | --- |
| Bilibili 扫码登录 | `src/server/login.mjs` | `passport-login/web/qrcode/generate` + `poll`；`code=0/86090/86038`；从 Set-Cookie 与跳转 URL 提取 `SESSDATA`、`bili_jct`、`DedeUserID`、`buvid3` 等 |
| 登录校验 | `login.mjs` → `nav` | `data.isLogin` + `mid` + `uname` |
| 直播间信息 | `src/server/bilibili.mjs` | `/room/v1/Room/room_init?id=` 解析短号 |
| WebSocket 鉴权 | `bilibili.mjs` + `wbi.mjs` | `getDanmuInfo` 需 WBI 签名与 buvid3，返回 `token` 与 `host_list` |
| 协议编解码 | `src/server/protocol.mjs` | 16 字节头，op=5/8，version 2=zlib、3=brotli；心跳 op=2；鉴权 op=7 |
| 心跳/重连 | `bilibili.mjs` | 30s 心跳、65s 看门狗、指数退避（上限 30s） |
| 礼物 / SC / 大航海 | `gift-v2.mjs`、`superchat.mjs`、`guard.mjs` | 字段路径与金额口径（大航海金额参考实现自己标注为未确认） |
| 弹幕 | — | **参考仓库完全没有 `DANMU_MSG` 处理**，字段由本轮真实直播间验证 |

## 2. Bilibili（本轮已实现）

### 2.1 代码结构（`src/platforms/bilibili/`）

| 文件 | 职责 |
| --- | --- |
| `wbi.mjs` | WBI mixin key、参数排序/编码、`w_rid` 计算（含公开测试向量） |
| `protocol.mjs` | 16 字节包头编解码、多包拼接、zlib/brotli 递归解压、op 2/3/5/7/8 |
| `api.mjs` | `room_init` / `getInfoByRoom` / `getDanmuInfo` / `nav` / 二维码生成与轮询；`buvid3` 与 WBI 缓存 |
| `adapter.mjs` | WebSocket 生命周期：鉴权、30s 心跳、65s 静默看门狗、指数退避重连、主机轮换 |
| `mapper.mjs` | `DANMU_MSG` / `SEND_GIFT` / `SUPER_CHAT_MESSAGE` / `GUARD_BUY` / `USER_TOAST_MSG(_V2)` → canonical event |
| `cookie-store.mjs` | AES-256-GCM 加密保存登录态，`icacls` 限制为当前用户（尽力而为） |
| `login.mjs` | 扫码登录状态机，登录后校验 `nav` 并保存 |
| `service.mjs` | 路由与 `SessionManager` 之间的粘合层 |
| `../youtube/mapper.mjs` | YouTube Live Chat 的**离线预留** mapper：文本、Unicode Emoji、`:code:` 自定义表情；未接入 API/OAuth/轮询 |

所有事件仍然只经过 `src/platforms/shared/ingest.mjs`（去重、观众聚合、金额分账、场次计数），适配器没有直接写数据库。

### 2.2 已确认的协议（真实网络，2026-11-08）

| 项目 | 结果 |
| --- | --- |
| `room_init` | `5050 → 5050`、`7734200 → 7734200 (short 6)`、`21144080 → 21144080 (short 55)`，`live_status` 可用 |
| `nav`（未登录） | HTTP 200，`code=-101`，但 `data.wbi_img` 正常返回；**不能把 -101 当失败** |
| `getDanmuInfo` | 需要 `wts` + `w_rid`（WBI）与 `buvid3`；匿名 HTTP 200 `code=0`，返回 `token` 与 3 个 `host_list` |
| WebSocket | `wss://<host>:<wss_port>/sub`；鉴权包 `{uid, roomid, protover:3, platform:'web', type:2, key, buvid}`；匿名 `uid=0` 可连接 |
| 鉴权回包 | op=8，`code=0` 后开始推送；心跳 op=2，服务器 30s 内不要求固定内容（发送 `{}` 已验证） |
| 压缩 | version 2 = zlib，version 3 = brotli，单帧多包、递归解压均已验证 |
| 断线 | 关闭后按 1→2→4→8→16→30s 退避重连，重连时重新解析房间与 token |

### 2.3 已确认的身份字段（重点）

真实直播间 `21144080`（30 秒）：收到 **142 条 `DANMU_MSG`，142 条都带 UID 与昵称**。

`DANMU_MSG` 的真实结构（本轮实测）：

```text
{ cmd: 'DANMU_MSG', dm_v2: '<空字符串>', info: [ ... 18 项 ... ] }
info[1]   弹幕文本（string）
info[2]   [uid, uname, ...]
info[7]   大航海等级（0 = 无）
info[9]   { ts: epoch 毫秒, ... }
```

> 注意：`info` 有时在**顶层**（与 `cmd` 同级）而不是 `data.info`。适配器用 `json.data ?? json`，两种都兼容。
> 真实昵称会被平台打码（例如 `电***`），UID 仍然存在；不能根据昵称归并用户。

**身份不完整是真实存在的**：同一天在直播间 `5050` 采样 25 秒，77 条弹幕中 **72 条 `info[2][0]` 为 `0` 且昵称为打码形式**，只有 5 条带可用 UID。这类事件仍会入库（内容、时间、打码昵称），但：

- `viewer_uid = null`，不创建/合并观众档案；
- `source_quality = unknown`，`identity_complete = false`；
- 不猜测、不按昵称合并。

各事件类型的身份字段（`verified` 仅指本轮真实观测过的）：

| 事件 | UID 来源 | 昵称来源 | 本轮真实观测 |
| --- | --- | --- | --- |
| `DANMU_MSG` | `info[2][0]`（顶层或 `data.info`） | `info[2][1]` | ✅ 142/142；另有 72/77 只有 UID=0 |
| `SEND_GIFT` | `data.uid` | `data.uname` | ⬜ 未观测到礼物事件 |
| `SUPER_CHAT_MESSAGE` | `data.uid ?? data.user_info.uid` | `data.user_info.uname` | ⬜ 未观测到 |
| `GUARD_BUY` / `USER_TOAST_MSG(_V2)` | `data.uid` / `sender_uinfo.uid` | `data.username` / `sender_uinfo.base.name` | ⬜ 未观测到 |
| 匿名连接 vs 登录连接 | 鉴权包 `uid` 不同 | 观众字段不变 | ✅ 匿名可读；登录只影响主播账号相关接口 |

### 2.4 平台表情与 Emoji（2026-11-08 真实采样）

使用 `scripts/probe-bilibili-emotes.mjs` 在真实直播间 `5050` 匿名采样（35 秒 / 15 秒两次）：

| 观测项 | 结果 |
| --- | --- |
| `DANMU_MSG` 总数 | 35 秒 32 条；15 秒 22 条 |
| `info[0][13]` 存在 | 21/32（约 2/3） |
| `info[0][13]` 字段 | `emoticon_unique`、`url`、`width`、`height`、`is_dynamic`、`bulge_display`、`in_player_area` |
| `info[1]` 内容 | 表情文字标签，例如「就这」「乐」「Wow」；长度 1–4 字符 |
| 正文中的 `[xxx]` 括号文本 | 样本中 0 条 |
| Unicode Emoji | 样本中 0 条（但不能据此认为平台不支持；普通聊天仍需保留） |
| `dm_v2` | 21+ 条全部为空字符串（`length=0`） |
| 表情图片 | 平台提供 `url`，但**本版本不下载、不缓存、不打包** |

结论与实现：

- Bilibili 平台表情**不是**“正文只有特殊结构、必须靠图片才能理解”的场景：`info[1]` 已经提供可读文字标签。
- 因此 LiveMemory 保留 `info[1]` 原文，同时从 `info[0][13].emoticon_unique` 提取稳定 id，保存为最小元数据：
  ```json
  [{"id": "room_5050_96171", "name": "就这", "source": "bilibili.info13"}]
  ```
- 若正文混有 `[猫猫鼓掌]` 这类括号标签，优先把括号内文字作为表情名称；但**没有 `info[0][13]` 元数据时，绝不把普通 `[文字]` 判为平台表情**。
- 若正文为空但存在表情元数据，事件仍会入库（`content=NULL` + `emotes`），UI 与 AI 包使用名称/id 回退。
- `dm_v2` 未解析：采样中为空；若未来平台把表情迁移到 `dm_v2`，当前实现会保留正文但不会伪造 id，需重新采样后补协议。
- 未知 `emoticon_unique` 在 AI 包中标记为 `[未知平台表情：emote_id=…]`，不猜测开心/悲伤/愤怒。

### 2.5 经济支持字段与金额

| 字段 | 单位 | LiveMemory 处理 | 状态 |
| --- | --- | --- | --- |
| `SEND_GIFT.price` / `total_coin`（gold） | 金瓜子，**1000 = 1 CNY** | `amount_minor = total_coin / 10`（分），`value_kind=actual`；不能整除时取整并标 `display` | ✅ 单位来自参考仓库的换算与真实数值交叉验证（9900 → ¥9.90、100 → ¥0.10）；本轮未观测到礼物事件 |
| `SEND_GIFT.coin_type = silver` | 免费礼物 | `is_paid=false`、`gift_type=free`、金额为 `null` | ✅ 规则已测 |
| `SUPER_CHAT_MESSAGE.price` | **CNY**（元） | `amount_minor = price × 100`，`value_kind=actual` | ✅ 单位来自参考仓库；本轮未观测到 SC |
| `GUARD_BUY.price` | 金瓜子？（**未确认**） | **不记金额**：`amount_minor=null`、`value_kind=unknown`；事件本身保留 | ⬜ 参考实现自己标注未确认，本轮未观测到 |
| 会员/粉丝牌 | — | 暂不映射 | ⬜ |

**不换算成人民币的数值一律留空**，UI 显示为「—」，不为了图表好看编造金额。

### 2.6 登录与安全

- 扫码流程：`POST /api/bilibili/login/qrcode` 只返回二维码内容与过期时间；二维码在**应用页面内本地渲染**（canvas + vendored MIT qrcode-generator，与参考项目 `bili-gift-drop` 完全一致的做法），前端每 2 秒 `POST /api/bilibili/login/poll`，成功后服务端拿到 Cookie。
- **不再打开任何外部登录页面**：旧实现会跳到 `account.bilibili.com`（部分浏览器会触发下载），`/api/bilibili/login/open` 已移除。
- 参考实现位置：`D:\哔哩哔哩OBS礼物特效`（完整工程）与 `.ref/bili-gift-drop`（只读副本）；二维码库为 `src/control/vendor/qrcode.js`（MIT，Kazuhiko Arase），已复制为 `src/web/js/vendor/qrcode.js` 并保留许可证。
- Cookie 只保存在 `%LOCALAPPDATA%\LiveMemory\secrets\bilibili-login.json`，AES-256-GCM 加密，密钥同目录、尽力用 `icacls` 限制为当前用户；状态 API 永不返回 Cookie；日志脱敏覆盖 `SESSDATA`/`bili_jct`/`DedeUserID`。
- 匿名为默认：不登录也能接收公开弹幕（本轮已实测）。

### 2.7 已知限制与未验证

- **礼物 / SC / 大航海**：字段映射来自参考仓库，本轮未在真实直播间观测到事件，不能称为「真实验证通过」。需要在一场有礼物/SC/大航海的直播中复核。
- **`SEND_GIFT_V2`（base64 protobuf）**：未实现。若平台把礼物切到 V2 通道，会漏礼物；需要采集样本后补协议解码。
- **登录后的身份字段**：本轮未扫码（没有可扫码的账号），登录是否解锁更多字段未验证。
- **`dm_v2`**：采样中为空字符串；未解析。若未来平台把表情或身份信息迁移到 `dm_v2`，需要重新采样并补解码；当前实现不会伪造 id。
- **平台表情图片**：本版本不下载、不缓存、不显示图片；只保留平台提供的文字标签与 id。图片还原属于未来可选增强，不是核心路径。
- **表情样本范围**：只在 `5050` 的真实弹幕中观察到 `info[0][13]`；其他房间/其他表情类型（全局表情、粉丝牌表情、动态表情）仍需采样。带 `is_dynamic=1` 的动态表情元数据已观察到，但未做图像处理。
- **`info` 位置差异**：已兼容顶层与 `data` 两种；平台再次改动时需要重新采样。
- **大航海金额**：不记账；后续需要确认单位后再补。
- **热门房间的消息速率**：30 秒可收到 100+ 条弹幕；长时间直播需要观察内存与写放大（M4）。
- 断线重连、去重、崩溃恢复已有自动化测试；**真实断线**（网络切换）未做长时间验证。

### 2.8 复现方法

```bat
:: 平台字段与事件（匿名，不打印内容与凭据）
node scripts/probe-bilibili.mjs 21144080 30

:: 表情/Emoji 结构采样（默认不打印正文；SHOW_TEXT=1 仅用于本机一次性核对）
node scripts/probe-bilibili-emotes.mjs 5050 35

:: 端到端：房间 → 连接 → 入库 → 控制台读模型 → 停止
node scripts/verify-bilibili.mjs 5050 20
```

## 3. YouTube Live（本轮已实现）

### 3.1 授权边界（一手文档结论）

必须先区分四件常被混为一谈的事：

| 问题 | 结论 |
| --- | --- |
| 完全不需要任何凭据？ | **官方 API 不可以**；官方 API 要求调用方身份。另有免登录网页接口的实验路径（非官方，见 §3.10），默认关闭 |
| 需要 Google 账号登录？ | **不需要**（公开数据路径） |
| 需要 OAuth？ | **不需要**（公开数据路径）；只有读主播自己的频道信息才必须 OAuth |
| 需要应用级 API Key？ | **是**（公开数据路径）；或者用 OAuth access token 代替 |

依据（一手文档原文）：YouTube Live Streaming API 的 *Implement authorization* 文档写明：

> **API keys:** A request that doesn't provide an OAuth 2.0 token must send an API key. Use an API key for requests that only retrieve public data, such as public live chat messages.

来源：<https://developers.google.com/youtube/data/live/authentication>。同一页也说明安装型应用在交换 authorization code 时会自动获得 refresh token，并列出撤销端点与 scope 列表。

`liveChatMessages.list` 参考文档没有 Authorization/scope 小节（对比 `insert`/`delete` 明确列出 scope），单次调用 5 个配额单位，并在页首建议「轮询用 `liveChatMessages.streamList`」：<https://developers.google.com/youtube/data/live/reference/rest/v3/liveChatMessages/list>。
`liveBroadcasts.list` 才是必须 OAuth 的方法，而本轮用 `videos.list.activeLiveChatId` 完全绕开了它。

`liveChatMessages.streamList` 确实存在，但它是 **gRPC server-streaming RPC**，不在 `youtube/v3` REST discovery 文档中，没有 REST 路径。因此实现使用文档化的 `liveChatMessages.list` + `nextPageToken` 轮询，并严格遵守服务端返回的 `pollingIntervalMillis`。

### 3.2 两种运行模式

| 模式 | 凭据 | 主播操作 | 能做什么 |
| --- | --- | --- | --- |
| `api-key`（公开直播模式） | 应用级 API Key（部署方提供） | 直接粘贴直播链接 | 定位直播、读公开聊天、Super Chat / Super Sticker / 会员事件 |
| `oauth` | Google OAuth（主播本人） | 点一次「登录 Google」 | 同上 + 读主播自己的频道信息（登录后显示账号名） |

- 运行时自动选择：已登录 → `oauth`；否则有 Key → `api-key`；都没有 → `none`（界面明确说明缺少开发者配置）。
- **仓库与默认构建不包含任何凭据。**
  - 环境变量：`LIVE_MEMORY_YOUTUBE_API_KEY`、`LIVE_MEMORY_YOUTUBE_CLIENT_ID`、`LIVE_MEMORY_YOUTUBE_CLIENT_SECRET`；
  - 或数据目录私有文件：`<数据目录>\config\youtube-api-key.json`、`<数据目录>\config\youtube-oauth.json`；
  - 或发布时写入 `src/platforms/youtube/oauth-config.mjs` 的常量。
- 合规提醒（见 §3.8）：Developer Policies III.D.1.d 禁止在开源项目中嵌入 API 凭据；桌面端 API Key 也无法限制到具体应用。发布者必须自行完成一次性配置与合规判断，不能把凭据提交到 Git。

### 3.3 代码结构（`src/platforms/youtube/`）

| 文件 | 职责 |
| --- | --- |
| `link.mjs` | 解析 `watch?v=`、`/live/`、`youtu.be`、`embed`、`shorts`、裸 11 位 ID；拒绝播放列表/频道/其他主机 |
| `api.mjs` | Data API v3：`videos.list`、`liveChatMessages.list`、`channels.list`；API Key 与 Bearer 双凭据；配额计费；Google `reason` → 稳定错误码 |
| `oauth.mjs` | PKCE(S256)、授权 URL、回环回调接收器、code 交换、refresh、revoke、本地化回调页 |
| `oauth-manager.mjs` | `signed_out → pending → signed_in | expired → signed_out`；重启恢复、提前 60s 刷新、并发合并、`invalid_grant` → `expired` |
| `token-store.mjs` | AES-256-GCM 加密保存 refresh/access token；`status()` 不返回令牌 |
| `oauth-config.mjs` | 解析开发者一次性配置（环境变量 → 数据目录 → 内置常量） |
| `mapper.mjs` | 原生事件 → canonical event（含金额换算、表情、会员语义） |
| `adapter.mjs` | 轮询、分页、退避重连、结束检测、配额守卫 |
| `service.mjs` | 路由 ↔ OAuth ↔ API ↔ `SessionManager` 的粘合层 |

### 3.4 直播定位与状态判定

`videos.list?part=snippet,liveStreamingDetails,status` 返回后判定：

| 平台字段 | LiveMemory 判定 |
| --- | --- |
| `snippet.liveBroadcastContent=live` 且无 `actualEndTime` | `state=live`，可记录 |
| `liveBroadcastContent=upcoming` 或只有 `scheduledStartTime` | `state=upcoming`，提示「尚未开始」 |
| 有 `actualEndTime` | `state=ended`，提示「已经结束」 |
| `liveBroadcastContent=none` 且无 `activeLiveChatId` | `state=video`，提示「不是正在进行的直播」，不抓评论 |
| 正在直播但无 `activeLiveChatId` | 聊天关闭，提示「该直播没有开放聊天」 |

`platform_started_at` 取 `liveStreamingDetails.actualStartTime`，用于「相对直播时间」，与「开始记录的时间」区分。

### 3.5 聊天传输

- 首屏请求会返回近期历史（官方行为），这些消息属于当前直播聊天，正常入库；**不做事后历史回填**。
- 每次请求携带上一页 `nextPageToken`；间隔取 `max(2s, min(30s, pollingIntervalMillis))`。
- 去重：`dedupe_key = ext:<message.id>`，分页重叠或重复投递不会重复计数。
- 网络错误 / 5xx / 429：指数退避（1→2→4…30s）重连，**不结束场次**；恢复后 UI 显示「已连接」。
- `chatEnded` / `chatNotFound` / `chatDisabled` / `offlineAt`：判定直播聊天结束，自动结束场次并保留数据。
- 配额：每次聊天请求 5 单位，`videos.list` 1 单位；本地守卫在剩余不足时以 `errors.youtubeQuota` 停止轮询，界面显示已用/上限。

### 3.6 身份与经济支持

| 事件 | 来源 | LiveMemory 处理 |
| --- | --- | --- |
| 聊天 | `textMessageEvent` | `content` 原文 + Unicode Emoji + `:code:` 自定义表情代码；身份 `youtube:<channelId>` |
| Super Chat | `superChatDetails` | `event_type=super_chat`，`amountMicros` → 最小单位，`value_kind=actual`，保留留言 |
| Super Sticker | `superStickerDetails` | `event_type=super_sticker`，无留言也保留付款者、金额、币种、`stickerId`、`altText` |
| 新会员 | `newSponsorDetails` | `membership`，记录等级；**不换算金额** |
| 会员里程碑 | `memberMilestoneChatDetails` | `membership`，记录等级与月数，留言存入 `content` |
| 赠送会员 | `membershipGiftingDetails` | `membership`，`gift_quantity=数量`；**不换算金额** |
| 收到赠送会员 | `giftMembershipReceivedDetails` | `membership`，`is_paid=false`、`gift_type=free`，记录赠予者 channelId |
| 删除/封禁/公告 | `messageDeletedEvent` 等 | 有意丢弃，不猜测成聊天 |

身份规则：

- `youtube:<channelId>`，昵称只作展示；`authorChannelId.value` 与 `authorDetails.channelId` 都能用。
- 只有昵称时 `viewer_uid=null`、`identity_complete=false`，不创建档案、不按昵称合并。
- 不同平台的相同昵称不合并。

### 3.7 未验证（如实保留）

- **没有真实 Google 凭据**：未对真实直播采样。真实消息条数、真实身份完整率、真实 Super Chat / 会员样本**均无数据**。
- OAuth 只在本地回环 + 假 token 端点验证；未验证真实同意屏、未验证 Testing 应用 refresh token 7 天过期、未验证未验证应用 100 用户上限。
- 真实断网、真实配额耗尽的长时行为未验证（自动化测试覆盖了逻辑分支）。
- 会员事件评论保存在 `content`，但**不计入消息数**、不进入 AI 包 `messages.jsonl`（保守取舍，避免把会员事件当聊天）。

### 3.8 合规要点（一手条款）

- **数据保留**：公开直播聊天属于 Non-Authorized Data，Developer Policies III.E.4.d 要求不超过 **30 个日历日**；III.E.4.c 对 Authorized Data 同样是 30 天。主播的 OAuth **不能**为其他观众的数据授权无限期保存。本轮实现默认 30 天清理原始文本（保留统计与身份），见 §7。来源：<https://developers.google.com/youtube/terms/developer-policies>
- **抓取与未公开接口**：ToS 与 Developer Policies 明确禁止 scraper 与 undocumented APIs。官方路径没有实现任何绕过。免登录网页接口是唯一例外：它是未公开接口，很可能违反 ToS，因此默认关闭、显式 opt-in、带风险提示，并且不绕过登录/验证码/年龄墙/地区限制；不得把它描述为合规。
- **凭据分发**：III.D.1.d 禁止在开源项目中嵌入 API 凭据；OAuth 安装型客户端的 secret 虽然「不视为机密」，但公开仓库仍不应提交。默认常量留空是刻意的。
- **外部 AI**：分析包由用户手动交给自选 AI 服务；软件不自动上传。包内不包含凭据；保留策略先于导出生效（允许用户在导出前手动执行清理）。

### 3.9 复现方法

```bat
:: 仅验证本地链路（假 API，不需要任何真实凭据）
node --test --test-isolation=none "tests/unit/youtube-*.test.mjs" "tests/integration/youtube-session.test.mjs"

:: 有真实凭据时（不要提交这些值）
set LIVE_MEMORY_YOUTUBE_API_KEY=AIza...
node src/launcher/launcher.mjs
:: 打开「直播记录 → YouTube 直播」，粘贴 https://www.youtube.com/live/<VIDEO_ID>
```

### 3.10 免登录网页聊天（实验性，默认关闭）

> 结论：**技术可用，但非官方接口，很可能违反 YouTube ToS 的自动化访问与个人信息收集限制。** 因此不作为默认方式，必须显式启用；官方 Data API 仍是推荐方式。

#### 3.10.1 是否无需登录

- 不发送 Cookie、OAuth token、refresh token 或用户 API Key。
- 只使用公开直播网页自身的 `INNERTUBE_CONTEXT` 和页面公开的 Web API key。
- 不绕过登录、验证码、年龄墙或地区限制；遇到 `Sign in`/consent 直接报 `YOUTUBE_WEB_RESTRICTED`。

#### 3.10.2 代码结构

| 文件 | 职责 |
| --- | --- |
| `src/platforms/youtube/anonymous/parser.mjs` | watch 页、live_chat 页、continuation、runs、badge、金额的纯解析 |
| `src/platforms/youtube/anonymous/client.mjs` | HTTP、页面重开、400/429/5xx 错误分层 |
| `src/platforms/youtube/anonymous/adapter.mjs` | 轮询、timeout、退避、continuation 刷新、结束、gap 诊断 |
| `src/platforms/youtube/mapper.mjs` | `mapYouTubeAnonymousChatItem`：文本/SC/Sticker/会员/gift → canonical |
| `src/shared/badges.mjs` | owner/moderator/verified/member 规范化 |

所有事件仍经过 `EventIngest`，没有第二条写入路径。

#### 3.10.3 协议

```text
GET  /watch?v=ID
  → ytInitialPlayerResponse.videoDetails / liveBroadcastDetails / playabilityStatus
GET  /live_chat?is_popout=1&v=ID
  → ytcfg.set({INNERTUBE_CONTEXT, INNERTUBE_API_KEY, ...})
  → ytInitialData.contents.liveChatRenderer.actions + continuations[0]
POST /youtubei/v1/live_chat/get_live_chat?prettyPrint=false&key=<page key>
  body {context, continuation}
  → continuationContents.liveChatContinuation.actions + 新 continuation + timeoutMs
```

真实样本 `timeoutMs=10000`；客户端 clamp 到 2–30 秒。

#### 3.10.4 字段与限制

| 字段 | 来源 | 结论 |
| --- | --- | --- |
| 消息 ID | `renderer.id` | 稳定，`ext:<id>` 去重 |
| 时间 | `timestampUsec` | 微秒 → epoch ms（BigInt） |
| 昵称 | `authorName.simpleText` / `content` | 有 |
| Channel ID | `authorExternalChannelId` | 聊天/SC 有；新版 gift 无 |
| 正文 | `message.runs` | 原文 + Unicode Emoji；自定义表情用 `:code:` 文本回退 |
| badge | `authorBadges` | owner/moderator/verified/member；保留 label |
| SC 金额 | `purchaseAmountText.simpleText` | 只有格式化字符串；仅在币种可确认时换算 |
| gift | `giftMessageViewModel` | 有 ID/文本/礼物图，但无 Channel ID、无价格 |
| 会员 | `liveChatMembershipItemRenderer` | 结构已映射，真实未观测 |
| Sticker | `liveChatPaidStickerRenderer` | 结构已映射，真实未观测 |

#### 3.10.5 真实采样（2026-11-08）

| 房间 | 时长 | 事件 | chat | 经济 | 稳定 Channel ID | badge | 错误 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `FKLZiufsCk0` | 35s | 86 | 85 | 1 SC `HK$2,000.00` → HKD 200000 | 86/86（100%） | 49 | 0 |
| `gXawf8GZDI8` | 35s | 100 | 87 | 13 gift（金额未知） | chat 87/87；gift 0/13 | 3 | 0 |

- 两场均 0 重复、0 失败、`pollCount=3`。
- 未观测到 Super Sticker / 会员 / 赠送会员。
- 没有官方凭据，未做官方并排对照。

#### 3.10.6 稳定性

- continuation 每页更新；400/`failedPrecondition` → 重开 live_chat；重复消息由 `external_id` 去重。
- 429 → 至少 30 秒退避；网络/5xx → 1→60 秒指数退避；连续 8 次失败才停止并保存。
- 每 60 秒检查 watch 页；直播结束后自动结束场次。
- 相邻消息时间跳变 > 90 秒记 `gapSuspected`；UI 只说“可能漏消息”。
- 不把短暂网络错误当直播结束；不无限重试。

#### 3.10.7 条款与保留

- YouTube ToS 禁止自动化访问 Service、规避限制、收集可识别个人信息；本路径很可能冲突。
- 因此 UI 默认官方；实验模式必须显式启用，并在界面显示风险。
- `youtubeRawRetentionDays` 上限从 3650 收紧为 30；清理原文、emotes、badges、amount_display 和过期昵称。
- 稳定 Channel ID、计数、金额合计仍保留；不等于完全删除个人数据。
- 研究、许可证与完整政策分析见 `docs/YOUTUBE_ANONYMOUS_RESEARCH.md`。

#### 3.10.8 复现

```bat
node scripts/verify-youtube-anonymous.mjs https://www.youtube.com/live/<VIDEO_ID> 35
```

## 4. 统一事件模型

`src/shared/events.mjs` 的 canonical event 是唯一跨平台格式：

```text
platform, session_id, external_id, event_type, viewer_uid, display_name,
occurred_at, received_at, content, emotes, gift_id, gift_name, gift_type,
gift_quantity, unit_amount_minor, amount_minor, currency, value_kind,
is_paid, source_quality, dedupe_key
```

`emotes` 是可选的最小元数据数组；普通 Unicode Emoji 不进 `emotes`，直接留在 `content`。

适配器职责：

1. 解析原生消息；
2. 生成稳定 `external_id`（Bilibili 礼物 `tid`、SC `id`、大航海 `payflow_id` 或 `uid:level:time:count`；YouTube 一律使用 `message.id`；Bilibili 弹幕不设 external_id，由指纹去重）；
3. 确认金额单位与币种，否则 `amount_minor=null`、`value_kind=unknown`；
4. 标注 `source_quality`（`verified` 仅用于字段实测确认后）；
5. 提取平台表情元数据（有可靠依据时）并写入 `emotes`；没有依据时不要猜测；
6. 通过 `EventIngest` 写入。

## 5. 真实性标注

- `mock` 平台永远 `source_quality=mock`，UI 显示「模拟」。
- Bilibili 真实会话 `source_quality=estimated`（会话级）；单条事件：弹幕/礼物/SC 身份完整时为 `verified`，身份缺失为 `unknown`，大航海为 `estimated`。
- YouTube 事件 `source_quality=estimated`：字段来自官方文档，但**尚未在真实直播中采样**；`verified` 只在真实样本后使用。
- 字段未逐项验证的平台事件标 `unknown` 或 `estimated`。
- 不得把模拟测试通过描述为真实平台接入完成。
- 真实直播间验收记录：`21144080`（2026-11-08，弹幕 142 条全部带 UID/昵称）、`7734200`、`5050`（72/77 条 UID=0 + 昵称打码；另有 21/32 条 `DANMU_MSG` 带 `info[0][13]` 表情元数据）。房间号、时间与结论已记入 `docs/TEST_PLAN.md`。

## 6. 付费事件计数口径（2026-11-08 修正）

`payment_event_count`（观众级与场次级）现在只在 `is_paid=true` 时累加：

- 赠送会员的**接收者**不是付款者 → `is_paid=false`，不计数；
- 免费礼物（Bilibili 银瓜子/免费）不是付费事件 → 不计数；
- Super Chat / Super Sticker / 新会员 / 赠送会员的**赠送者** → `is_paid=true`，计数。

金额合计原本就只统计 `is_paid=1 AND amount_minor>0`，因此金额口径不变，变的是「付费事件数量」不再虚高。

## 7. YouTube 数据保留（合规实现）

| 项目 | 处理 |
| --- | --- |
| 依据 | YouTube API Services Developer Policies III.E.4.c / III.E.4.d：Authorized Data 与其他数据保存不超过 30 个日历日 |
| 默认窗口 | 30 天（`settings.youtubeRawRetentionDays`，1–30，可在设置 JSON 调整；最大 30） |
| 触发 | 应用启动；YouTube 场次结束；`POST /api/youtube/retention/apply`（面板按钮） |
| 清理内容 | `events.content`、`events.emotes`，并写 `content_purged_at` |
| 保留内容 | 行、计数、观众身份、昵称历史、币种合计、AI 包记录 |
| 作用范围 | 仅 `platform='youtube'`（Bilibili 不受 Google 政策约束，未改动） |
| 审计 | `app_meta['retention.lastRun']` 记录时间、天数、清理条数 |

主播登录 Google **不代表**获得无限期保存其他观众数据的授权；统计与身份保留是对产品长期记忆价值的最小妥协，原始文本按窗口删除。
