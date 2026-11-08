# 平台接入（PLATFORM_INTEGRATIONS）

状态：**Bilibili 最小真实闭环已实现并通过真实直播间验证（弹幕身份、平台表情元数据）；礼物 / SC / 大航海按参考实现映射但尚未在真实直播间观测到事件。YouTube 仅有离线 mapper 预留，未接入传输层。** 模拟平台（mock）保持可用。

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

## 3. YouTube（M3 后续）

### 3.1 授权层级（必须区分）

| 方案 | 需要观众登录 | 需要主播 OAuth | 需要 API Key | 可获取 |
| --- | --- | --- | --- | --- |
| Live Chat 只读（公开直播） | 否 | 否 | **是** | 聊天、作者名、时间戳、部分付费事件 |
| OAuth 主播授权 | — | 是 | 是 | 私有直播、频道信息 |
| 官方 Data API + 直播聊天轮询 | 否 | 否 | 是 | 公开直播聊天（分页/polling） |

第一版优先实现 **API Key + 公开直播读取**，不要求用户登录 YouTube。若某些事件（如会员赠送）无法通过公开接口获得，则标记为不可用，而不是伪造。

### 3.2 待验证清单

- [ ] 公开直播聊天是否仍需 OAuth（YouTube 近年收紧 liveChatMessages 权限）
- [ ] API Key 配额与轮询频率限制
- [ ] 观众稳定 ID（channelId）是否在聊天消息中始终可见
- [ ] 会员/赠送会员事件的可获取性
- [ ] 多币种 SC 的金额单位
- [ ] 聊天分页 `nextPageToken` 的断点续传

### 3.3 已预留的离线 mapper（未真实接入）

`src/platforms/youtube/mapper.mjs` 是纯函数 mapper，没有任何网络请求、OAuth 或轮询：

- `snippet.textMessageDetails.messageText` 作为原文；`snippet.displayMessage` 作为回退。
- 普通 Unicode Emoji 原样保留。
- 自定义表情按 `:code:` 形式识别为 `{code, name, source: 'youtube.messageText'}`；不解析图片，也不要求 OAuth。
- `snippet.authorChannelId.value` / `authorDetails.channelId` 作为稳定身份；缺失时为 `null`，不按昵称合并。
- 所有事件 `source_quality=unknown`、`verified=false`，因为**没有用真实 YouTube 直播采样验证**。
- Super Chat / 会员事件不会被误标为普通聊天；等 M3 后续实现。

> 这部分只证明“统一数据结构能容纳 YouTube 文本/Emoji/自定义表情”，**不能称为 YouTube 真实接入通过**。

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
2. 生成稳定 `external_id`（礼物 `tid`、SC `id`、大航海 `payflow_id` 或 `uid:level:time:count`；弹幕不设 external_id，由指纹去重）；
3. 确认金额单位与币种，否则 `amount_minor=null`、`value_kind=unknown`；
4. 标注 `source_quality`（`verified` 仅用于字段实测确认后）；
5. 提取平台表情元数据（有可靠依据时）并写入 `emotes`；没有依据时不要猜测；
6. 通过 `EventIngest` 写入。

## 5. 真实性标注

- `mock` 平台永远 `source_quality=mock`，UI 显示「模拟」。
- Bilibili 真实会话 `source_quality=estimated`（会话级）；单条事件：弹幕/礼物/SC 身份完整时为 `verified`，身份缺失为 `unknown`，大航海为 `estimated`。
- 字段未逐项验证的平台事件标 `unknown` 或 `estimated`。
- 不得把模拟测试通过描述为真实平台接入完成。
- 真实直播间验收记录：`21144080`（2026-11-08，弹幕 142 条全部带 UID/昵称）、`7734200`、`5050`（72/77 条 UID=0 + 昵称打码；另有 21/32 条 `DANMU_MSG` 带 `info[0][13]` 表情元数据）。房间号、时间与结论已记入 `docs/TEST_PLAN.md`。
