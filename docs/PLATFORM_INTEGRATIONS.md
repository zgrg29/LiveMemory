# 平台接入（PLATFORM_INTEGRATIONS）

状态：**Bilibili 最小真实闭环已实现并通过真实直播间验证（弹幕身份、平台表情元数据）；v0.8.1 增加平台直播状态与下播检测（WebSocket `LIVE`/`PREPARING` + 定期 `live_status` 查询），已用真实房间验证状态查询与 4 房间 20 分钟并发，但真实“直播中→下播”端到端仍未捕获。礼物 / SC / 大航海按参考实现映射但尚未在真实直播间观测到事件。YouTube 自 v0.5.0 起只保留公开网页聊天路径，不需要 API Key / OAuth / Cookie；该路径不是官方稳定 API。v0.6.0 已完成真实双场/三场并发验证（2 YouTube、YouTube+Bilibili、构建后 EXE），同一视频/房间重复启动会被拒绝。Twitch M1（2026-11-15）已完成匿名 IRC + 公开元数据的正式接入：真实公开频道 6 场并发 60 秒 418 条事件，418/418 带稳定 User ID 与消息 ID，订阅/续订通知已实测；Bits 与赠订仅完成解析，尚未观测到真实事件。TikTok M6（2026-11-16）允许同一平台多个不同直播间并发记录，并修复了前端全局单房间限制；已通过开发者普通 Windows 桌面人工验收并合并到本地 main（`980de0f`）。** 模拟平台（mock）只保留为内部自动化测试夹具与历史数据兼容，正式界面不再提供。

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
| `../youtube/mapper.mjs` | YouTube 公开网页聊天 mapper：文本、Unicode Emoji、`:code:` 自定义表情、SC、会员、gift、badge；已接入匿名 client/adapter，不依赖官方 API/OAuth |

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
> 真实昵称可能被平台打码（例如 `电***`）。打码时 UID **不一定**仍然存在：2026-11-12 的真实场次中，726/726 条弹幕的 `uid` 都为 0（详见 §2.3.1）。不能根据昵称归并用户。

**主播身份（v0.4.0）**：`getInfoByRoom` 的 `anchor_info.base_info.uid` 作为 `bilibili:<uid>`；若缺失但房间 id 已验证，使用 `bilibili:room:<roomId>` 并标记 `room_fallback`；两者都没有则场次保留为 `unresolved`。主播身份与观众 UID 是两套独立标识。

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
| 匿名连接 vs 登录连接 | 鉴权包 `uid` 不同 | 平台可能整体打码 | ⚠️ 匿名可读；**登录是否解除打码尚未在本机实测** |

### 2.3.1 2026-11-12 真实事故：整场弹幕无 UID

真实场次 `ses_01M75S69P4H0NSX87PD4`（房间 `1921719032`，2026-11-12 01:06–02:55，727 条消息）：

- 726 条 `chat` **全部** `viewer_uid=null`、`viewer_id=null`，71 个昵称全部是 `***` 形式；
- 1 条 Super Chat 与 2 条大航海仍带真实 UID，去重后正好 2 个身份；
- 历史页与 AI 中心因此都显示 2 名「可识别观众」；
- 本项目不保存原始 WebSocket 帧，故无法回读当时的 `info[2][0]` 原值；但库内签名与 Bilibili 的公开风控行为一致：**未登录连接下弹幕昵称打码、uid 变为 0**（参见 [Bilibili 风控记录](https://www.bilibili.com/opus/846907189335425030) 与 [blivechat #111](https://github.com/xfgryujk/blivechat/issues/111)）。
- 同日用项目自身 `BilibiliApi` + mapper 匿名探测正常开播房间（`1700650635`、`5050`），5/5 条弹幕得到真实 UID 与未打码昵称，说明解析器本身没有普遍性故障。

**结论与产品处理：**

- 这是平台侧身份匿名化，不是本地 JOIN、UID 类型或前端字段问题；
- 未登录时不能承诺完整观众身份；界面必须提示「可识别观众」而非「独立观众」，并显示未识别消息数；
- UID=0 在 canonical 层统一视为缺失，绝不允许形成 `platform:0` 的共享档案；
- 需要可靠身份时由用户扫码登录后再开始新记录；历史场次无法恢复这些 UID。

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
- **但未登录不保证拿到观众身份**：2026-11-12 事故显示整场弹幕可能被打码且 UID=0。登录按钮已改为「建议」，未登录状态明确提示观众统计会不完整；不要恢复「登录不会改变身份字段」的旧文案。

### 2.7 已知限制与未验证

- **礼物 / SC / 大航海**：字段映射来自参考仓库，本轮未在真实直播间观测到事件，不能称为「真实验证通过」。需要在一场有礼物/SC/大航海的直播中复核。
- **`SEND_GIFT_V2`（base64 protobuf）**：未实现。若平台把礼物切到 V2 通道，会漏礼物；需要采集样本后补协议解码。
- **登录后的身份字段**：本轮未扫码（没有可扫码的账号）。2026-11-12 事故的公开资料表明登录可解除弹幕打码，但**本机未实测**，界面不承诺 100%。
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

### 2.9 直播状态与下播检测（v0.8.1）

Bilibili WebSocket 连接成功**不代表主播仍在直播**：下播后服务端会保持连接，离线房间也可能
收到零散弹幕/在线排名消息。`sessions.status` 只描述本地采集，平台状态单独记录。

**真实接口（2026-11-10 实测）**

| 房间 | 接口 | 结果 |
| --- | --- | --- |
| `22014628`（用户问题房间） | `room/v1/Room/get_info` | HTTP 200，`live_status=0`，标题仍可读 |
| `6`（真实房间 `7734200`） | 同上 | `live_status=1` |
| `5440` / `22637261` | 同上 | `live_status=2`（轮播） |
| 高频匿名请求 | `xlive/web-room/v1/index/getInfoByRoom` | `code=-352` 风控；状态轮询因此改用轻量 `get_info` |

`live_status`：0 未开播，1 直播中，2 轮播中。字段缺失/其他数值视为“状态未知”，**不是**离线。

**WebSocket 状态命令**（协议字段来自真实抓包/类型定义，设备受控帧测试）

| 命令 | 关键字段 | 处理 |
| --- | --- | --- |
| `LIVE` | `live_key`、`live_time`、`roomid` | 当前房间/当前 generation → `platform_status=live`，重置离线计数 |
| `PREPARING` | `roomid`、`round` | 校验房间 → `ending`，立即查询一次 `live_status` |
| `STOP_LIVE` | 旧命令/房间 | 与 `PREPARING` 同路径 |

- 连接在线房间 25 秒**没有**收到 `LIVE`；连接离线房间 20 秒只收到
  `ONLINE_RANK_*`/`STOP_LIVE_ROOM_LIST`，**没有**收到 `PREPARING`。因此 `LIVE`/`PREPARING`
  只能作为“状态变化”信号，不能替代定期查询。
- 状态查询：每 60 秒一次；收到下播事件立即查；首次离线后 15 秒复查；
  8 秒超时；失败按 60→120→240→300 秒退避（有下播事件时 10→20→40→80→120 秒）。
- 确认规则：**WS 下播事件 + 1 次有效离线查询**，或 **2 次连续有效离线查询**。
  超时、429、-352、缺字段、房间不匹配、无效 `live_status` 只退避，绝不结束。
- 确认后停止该场采集、清定时器/WebSocket/重连、写最终事件、更新
  `ended_at` / `end_reason='platform_ended'` / `platform_ended_at` / `platform_end_quality`，
  保留全部事件、观众、金额与 AI 关联，SSE 通知前端。
- 同一房间快速下播再开播：旧场次已 `ended`，重新记录会创建新 `sessions` 行；
  旧 adapter 的异步回调由 generation + recording 存在性丢弃。
- 重连时平台 `live_time` 变化，或 `PREPARING` 后收到不同 `live_key`/`live_time` 的 `LIVE`，
  视为新直播：结束旧场次，不把两场写入同一行。
- 未开播/轮播房间在 `BilibiliService.connect()` 中直接拒绝（409，三语错误），
  避免创建没有直播的场次。

**验证状态**：真实 4 房间 20 分钟并发监控（`1946295012`、`2002290`、`27585820`、
`1814406243`）全部保持 `platform_status=live`，共 170 条真实事件，未误结束；
监控期间没有主播下播，**未完成真实“直播中→下播”端到端验证**。真实下播事件仍待捕获。

**已知限制**

- `PREPARING` 不是所有下播场景都保证发送；状态轮询是兜底。
- `get_info` 可能 429/风控；长期退避行为未做数小时验证。
- 平台实际结束时间通常只能精确到检测时刻；未知时 UI 显示“未知”，不伪造。
- 轮播（`live_status=2`）按非直播处理；若主播从轮播恢复直播，需要重新开始记录。

## 3. YouTube Live（v0.5.0：只保留公开网页聊天）

### 3.1 接入边界

- YouTube 只有一条连接路径：读取公开直播页面使用的网页聊天机制。
- **不需要** Google 登录、OAuth、API Key、Cookie 或开发者凭据；默认构建不包含任何 YouTube 凭据。
- 该机制**不是** YouTube 官方提供的稳定 API，也没有获得 YouTube 官方授权；页面结构、接口参数或平台策略变化都可能使它失效。
- 不绕过登录、验证码、年龄墙或地区限制；被拒绝时显示真实原因，不静默切换实现、不伪造成功。
- 只读取直播聊天，不抓取普通视频、评论、字幕或历史回放。

### 3.2 代码结构（`src/platforms/youtube/`）

| 文件 | 职责 |
| --- | --- |
| `link.mjs` | 解析 `watch?v=`、`/live/`、`youtu.be`、`embed`、`shorts`、裸视频 ID；拒绝频道/播放列表/普通视频页面 |
| `anonymous/parser.mjs` | watch 页、`live_chat` 页、continuation、金额/表情/badge 的纯解析 |
| `anonymous/client.mjs` | 公开网页与 `get_live_chat` 的 HTTP 传输；网络/429/协议/失效错误分层 |
| `anonymous/adapter.mjs` | 轮询、timeout、退避、continuation 刷新、结束检测、可能漏消息诊断 |
| `mapper.mjs` | 匿名聊天 action → canonical event（文本、Unicode Emoji、`:code:`、badge、SC、Sticker、会员、gift） |
| `errors.mjs` | `YouTubeApiError` 与稳定的错误码（不再依赖官方 API 客户端） |
| `service.mjs` | 路由与 `SessionManager` 之间的粘合层，仅含唯一网页路径 |

官方 `api.mjs`、`oauth*.mjs`、`token-store.mjs`、官方 `adapter.mjs` 及其测试已在 v0.5.0 删除。所有事件仍然只经过 `src/platforms/shared/ingest.mjs`。

### 3.3 连接流程

```text
用户粘贴直播链接/视频 ID
  → parseYouTubeInput()
  → GET /watch?v=ID          读取直播状态、标题、频道、当前观看
  → GET /live_chat?v=ID      验证聊天可打开并取得 continuation
  → SessionManager.startPlatform({platform:'youtube', broadcasterUid: channelId})
  → YouTubeAnonymousLiveChatAdapter
      → POST /youtubei/v1/live_chat/get_live_chat
      → mapper.mjs → EventIngest（去重/观众/金额/计数）
      → SSE → 控制台
```

- 普通视频、未开始、已结束、聊天关闭、网络/页面受限都有独立的可翻译错误码。
- 轮询间隔取服务端 `timeoutMs`（clamp 2–30 秒）。
- **连接状态与直播生命周期分离（v0.13.2 P0-4）**：
  - HTTP 429（至少 30 秒退避并读取 `Retry-After`）、500/502/503/504、断网/超时、HTTP 200 缺 `continuationContents`、结构异常、continuation 缺失或无法解析，都只进入 `reconnecting`/可恢复 `failed`，**不结束场次、不生成新 session**。
  - 连续 8 次失败进入 `failed`，但适配器继续以指数退避（上限 60 秒）重试；`sessions.status` 保持 `live`，已采集消息/观众/时间线全部保留。UI 显示「连接中断，自动重试中」、最近一次故障与「采集尚未结束」说明。
  - stale continuation：丢弃旧 token，通过 `openChat` 重新取得 continuation 后再轮询；不会反复 poll 已知失效的 token。
  - 结束证据：观看页连续两次 `state=ended`（间隔约 2 秒）→ `platform_ended`；聊天页明确 `ended`/`disabled` 需观看页 ended 或第二次聊天页相同结果确认 → `chat_ended`/`chat_disabled`。缺 continuationContents 本身**不是**结束证据。
  - `onEnd` 最多触发一次；用户主动停止是独立路径，立即结束且不受平台二次确认延迟影响。
  - 失败期间仍每 60 秒检查一次 watch 页，以避免“聊天接口永久失效但直播已明确结束”永远停留在重连状态。
- 相邻消息时间跳变 > 90 秒记 `gapSuspected`，UI 只显示“可能漏消息”。

### 3.4 身份、金额、表情

- 稳定身份来自 `authorExternalChannelId` → `youtube:<channelId>`；昵称只作展示。
- 新版 gift（`giftMessageViewModel`）可能没有 Channel ID：`viewer_uid=null`、`identity_complete=false`，不按昵称建档案或合并。
- Super Chat 的 `purchaseAmountText` 只有格式化文本：明确币种（`HK$`、`US$`、`€`、`£`、`₹`、ISO code 等）才换算；裸 `$`/`¥` 使用页面 `gl` 并保留原始文本；无法确认则金额未知。
- 会员等级、赠送数量、gift 名称**不换算金额**；gift 只记 `is_paid=true`、`amount_minor=null`。
- Unicode Emoji 原样保留；自定义表情用 `:code:` 回退并保存最小元数据；不下载图片、不猜情绪。
- badge 只保存平台确认的 owner/moderator/verified/member。

### 3.5 数据保留

- YouTube 公开聊天属于平台数据。`youtubeRawRetentionDays` 仍为 **1–30 天，默认 30**。
- 清理原文、emotes、badges、amount_display 与过期昵称；保留事件行、计数、稳定 Channel ID、金额合计。
- 这不等同于删除全部个人数据；严格删除/去标识化模式仍未实现。
- 不因为“免登录”而绕过保留限制。

### 3.6 验证状态（必须如实区分）

- **本地假网页端到端**：`tests/integration/youtube-anonymous-session.test.mjs` 覆盖检查、连接、聊天/SC/Sticker/会员/gift、badge、稳定身份、自动结束、保留上限、AI 包；`live-api-multi.test.mjs` 覆盖两个假直播的并发、隔离、Top 100、停止一场另一场继续、重启恢复。
- **生命周期回归（v0.13.2 P0-4，Mock HTTP）**：`tests/unit/youtube-lifecycle-regression.test.mjs` 10 项 + `tests/integration/youtube-lifecycle.test.mjs` 2 项。覆盖连续 429、连续网络失败、500/502/503、缺 `continuationContents`、多种异常 200、stale token 重取、连续故障后同一 session 恢复、观看页两次 ended、聊天 ended/disabled 二次确认、用户停止、消息去重与单轮询器。全部通过。
- **正式 EXE + 本地假 YouTube（v0.13.2 P0-4）**：`scripts/verify-youtube-lifecycle-exe.mjs` 用 asInvoker 测试副本与 loopback 假服务；关闭假服务 **180,513 ms** 后同一 session 恢复、消息去重、观看页 ended 只结束一次。是正式 EXE 回放，不是真实 YouTube 网络断网。
- **真实直播间并发采样（v0.6.0，2026-11-09）**：两个 YouTube（Lofi Girl + Al Jazeera English 当日直播）各收到 80 / 63 条事件；跨场 `wrongSession=0`；重复启动 409；停止 A 后 B 仍 connected。另与 Bilibili room 6、三场并发、构建后 EXE 附加验证均通过。详见 TEST_PLAN §12.3。
- **未验证**：真实 429/验证码/consent/age wall、真实网络级断网（拔网/切网）、真实 YouTube 直播的“网络中断→恢复→同一场次”端到端、数小时长直播、不同地区币种、Super Sticker/会员/赠送会员真实样本、同一真实观众跨两个主播的观测、官方授权（不存在）。
- 该路径不是官方 API，可能违反 YouTube 服务条款；正式发布前仍需平台合规评估。

### 3.7 多直播间并发与资源控制（v0.6.0）

- 每个 YouTube 直播一个独立 adapter 和 continuation 轮询定时器；Bilibili 每个房间一个 WebSocket + 心跳。
- 轮询/重连完全由各 adapter 自身管理，避免全局轮询；一个直播的 429/断线退避不影响其他直播。
- 每个 adapter 只有一个 poll 定时器、一个结束确认定时器和一个观看页元数据请求；重新调度会先清除旧 timer，停止/确认结束会清除全部 timer，不会产生重复轮询器或并发结束确认。
- 重复启动同一视频/房间被 `SessionManager` 拒绝，不会重复请求页面或重复统计。
- 没有人为并发上限；实际受 CPU、内存、网络与平台限流约束。每个直播的前端缓存上限为 40 条 feed + 100 行排行榜。
- 长时间多场压力、内存增长与平台限流叠加尚未做 10+ 场数小时验证。


## 3A. Twitch Live（M1，2026-11-15）

### 3A.1 接入边界与代码结构

- 唯一路径：**匿名 IRC 公开聊天 + 只读公开频道元数据**；不需要 Twitch 账号、OAuth Token、API Key、Cookie 或付费采集服务。
- 匿名 IRC 与公开网页元数据都**不是 Twitch 官方承诺的稳定 API**；平台可能限流、改字段或关闭该行为。界面与文档不得描述为“官方授权”。
- 不绕过登录、验证码、封禁、聊天限制或地区限制；失败显示真实原因，不静默切换。
- 只附加正在直播的公开频道；视频、剪辑、目录、搜索链接一律拒绝。

| 文件 | 职责 |
| --- | --- |
| `src/platforms/twitch/link.mjs` | 解析 `twitch.tv/<login>`、m/player/popout 与裸账号；拒绝视频/剪辑/目录 |
| `src/platforms/twitch/irc.mjs` | IRCv3 标签/转义/多行帧、`emotes` 范围、`badges`、`/me` ACTION 的纯解析 |
| `src/platforms/twitch/mapper.mjs` | PRIVMSG / Cheer / USERNOTICE → canonical event；证据等级与忽略列表 |
| `src/platforms/twitch/client.mjs` | 公开 GQL 元数据（频道 ID、昵称、标题、直播状态、观看数、开播时间、stream id） |
| `src/platforms/twitch/adapter.mjs` | IRC WebSocket 生命周期、心跳/看门狗、重连、稳定 ID、消息去重、直播状态确认 |
| `src/platforms/twitch/service.mjs` | 路由/监控与 `SessionManager` 之间的粘合层、30 天保留 |
| `src/monitoring/detectors/twitch.mjs` | 开播检测与稳定 target 解析 |

所有事件只经 `src/platforms/shared/ingest.mjs`；适配器不写数据库。

### 3A.2 连接流程

```text
用户输入链接/账号
  → parseTwitchInput()
  → 公开 GQL user(login)：stable channel id / displayName / title / stream.id / viewers / startedAt
  → 拒绝未开播、频道不存在、非频道链接
  → SessionManager.startPlatform({platform:'twitch', platformRoomId: channelId})
  → TwitchIrcAdapter
      → wss://irc-ws.chat.twitch.tv:443（CAP tags/commands，匿名 NICK justinfan…，JOIN #login）
      → ROOMSTATE 校验 room-id == channel id
      → PRIVMSG / USERNOTICE → mapper → EventIngest（去重/观众/金额/计数）
      → SSE → 控制台
```

### 3A.3 观众身份与聊天

- `user-id` → `viewer_uid` → 长期身份 `twitch:<user-id>`；`display-name`/`login` 只作展示。缺失 `user-id` 时 `viewer_uid=null`、`identity_complete=false`，绝不用昵称建档案或合并。
- `id` → `external_id` → `UNIQUE(session_id, dedupe_key)`；适配器另保留最近 10,000 个消息 ID 作为连接内快速去重。
- `tmi-sent-ts` → `occurred_at`（epoch 毫秒）；`room-id` → 主播稳定 ID。
- 正文保留完整 UTF-8（中文/日文/英文/Emoji）；`/me` 只去掉 `\u0001ACTION …\u0001` 包装，不改文字。
- `emotes` 标签只提供 emote id 与字符范围，Twitch IRC 不提供表情名称；`content` 原文保留 emote 文本，`emotes` 只写 `{id, source}`，不下载图片、不猜情绪。
- `badges` 映射为 owner/moderator/member/unknown 的最小集合；`CLEARCHAT`/`CLEARMSG` 等管理事件不当作聊天。

### 3A.4 订阅、赠订与 Bits（证据分级）

| 事件 | 映射 | 金额语义 | 证据等级 |
| --- | --- | --- | --- |
| `PRIVMSG` 普通聊天 | `chat` | 无 | **真实观测**（2026-11-15，418/418 有 user-id/id） |
| `PRIVMSG` 带 `bits`（Cheer） | `super_chat`，`gift_name=Bits`，`gift_quantity=bits`，`amount_display="N Bits"` | `amount_minor=null`、`currency=null`、`value_kind=unknown` | **已解析，未观测到真实事件** |
| `USERNOTICE msg-id=resub` | `membership`，`gift_name=Subscription · Tier N/Prime`，`amount_display=N months` | 同上，不换算收入 | **真实观测**（2026-11-15，Prime 续订） |
| `USERNOTICE msg-id=sub` | 同上 | 同上 | 已解析，未观测到真实事件 |
| `USERNOTICE msg-id=subgift` | `gift`，`viewer_uid` 是赠送者；接收者只写入 `amount_display`，`is_paid=false` 的接收者事件不生成 | 同上 | 已解析，未观测到真实事件 |
| `USERNOTICE msg-id=submysterygift` | 跳过（随后每个接收者都有 `subgift`） | — | 防止重复计数 |
| `viewermilestone` / `bitsbadgetier` / `announcement` / `raid` 等 | 跳过，不写入普通聊天 | — | 系统通知不得冒充观众弹幕 |

- Twitch 不提供 Bits/订阅/赠订的本币金额；价格随国家、平台、税费、促销变化。**不得**把 Tier、Bits、月数换算成主播实际收入。
- 赠订只把赠送者记为付款者；接收者不是付款者，不增加付费人数或金额。
- 当前匿名 IRC 无法取得官方 EventSub 的完整事件能力。EventSub 需要 OAuth User Access Token、应用 Client ID 与相应 scope；本构建**未配置**，不会要求普通主播注册开发者应用。后续若要增强，必须先提供开发者侧公开 Client ID 方案并单独评审。

### 3A.5 直播状态、结束与重连

- IRC 连接成功不等于主播仍在直播。适配器每 60 秒读一次公开频道元数据；
  **连续 2 次有效离线**才确认 `platform_ended`。网络错误、429、协议异常只退避，绝不结束。
- `stream.id` 变化表示上一场已结束、新一场已开始：结束旧 session，不把两场混在一行；监听会为新场创建新 session。
- 服务端 `RECONNECT`、连接关闭、90 秒静默看门狗：进入 `reconnecting`，指数退避（1→30 秒）重连，保留同一 session。
- 连续 15 次失败进入可恢复 `failed`，之后每 5 分钟低速探测一次，不高速空转、不重复创建 session。
- 用户主动停止后 `started=false`，不再重连；多直播间各自独立 adapter/session，互不影响。
- 平台状态写入 `sessions.platform_status` / `platform_ended_at` / `platform_end_quality`，与本地采集状态分离。

### 3A.6 自动开播监听

- `MonitoringManager` 新增 `twitch` detector：等待开播时每 120 秒（90–180 秒抖动）读取一次公开频道元数据；每个平台一个 pacer（Twitch ≥1.5 秒），最多 2 个并发检查。
- 目标 key 为 channel login，`platform_uid` 为稳定 channel id；`liveCycleKey` 使用 `twitch:<login>:<stream.id>`，避免把同一场重复创建 session。
- 发现开播后调用 `TwitchService.connectDetected`，复用普通适配器/`EventIngest`；关播后目标保留并等待下一场。
- 失败 4 次进入可见 `error`，30 分钟后低速重试；网络错误不会被当成“未开播”或“已结束”。

### 3A.7 数据保留

- Twitch 原文、emotes、badges、`amount_display` 与过期昵称按 **30 天**清理（Twitch-only scope）；保留事件行、计数、稳定 User ID 与金额合计。
- 清理在启动、Twitch 场次结束与 `POST /api/twitch/retention/apply` 时执行。
- 这不等于完全删除个人数据；文档与界面不得声称“已彻底删除”。

### 3A.8 验证状态（2026-11-15，Asia/Shanghai）

真实只读公开频道（未登录、未付费、未保存/展示聊天正文）：

| 验证 | 结果 |
| --- | --- |
| 单频道 `xqc` 45 秒 | 138 条事件，138/138 有稳定 User ID + 消息 ID；108 个唯一身份；7 条带 `emotes`；7 条含非 ASCII |
| 6 频道并发 60 秒（xqc/shroud/sodapoppin/moonmoon/ludwig/summit1g） | 418 条事件，418/418 有稳定 User ID + 消息 ID；304 个唯一身份；40 条带 `emotes`；10 条含非 ASCII；**1 条真实 resub（Prime）**；0 Bits、0 赠订 |
| 断线重连 | 自动化覆盖连接关闭、`RECONNECT`、看门狗、退避与同 session 恢复；真实拔网未验证 |
| 下播确认 | 自动化覆盖两次离线确认、stream id 变化、错误不结束；真实“直播中→下播”未捕获 |
| 多直播间隔离 | 6 个真实频道并发连接、独立 session；自动化覆盖停止一场另一场继续 |
| Windows EXE | `scripts/verify-twitch-exe.mjs` **20/20**：真实 `xqc` 连接/入库/停止、自动监听目标→check→session→聊天→删除、重启持久化、AI 报告 200、观众读模型 200、Bilibili/YouTube 状态 200；buildId `a4bf602de264` / commit `7da0e0d` / `requireAdministrator` |

**未验证 / 不得宣称**：真实 Bits 事件、真实赠订事件、EventSub OAuth 端到端、真实长时间断网/下播、千条每秒压力、Twitch 官方稳定性承诺。

## 3B. 抖音 Douyin Live（M2/M3，2026-11-15，`feature/douyin`）

### 3B.1 接入边界与代码结构

- 唯一路径：**公开直播间网页 + 签名的匿名 WebSocket**。弹幕、昵称、稳定 UID、进场/点赞/关注不需要登录；
  礼物自 2026 年起只推给登录会话。
- 公开网页与 `webcast` WebSocket 都**不是抖音官方承诺的稳定 API**；界面与文档不得描述为“官方授权”或“合规接口”。
- 不绕过验证码、风控、登录或访问控制；失败显示真实原因。浏览器授权/扫码流程被风控阻止时如实报告。
- 只附加正在直播的公开直播间；用户页、视频、搜索、短链一律拒绝。
- 签名组件为 **AGPL-3.0**，单独目录分发；主项目 `LICENSE` 仍为 MIT。见 `docs/LICENSE_AGPL_DOUYIN.md`。

| 文件 | 职责 |
| --- | --- |
| `src/platforms/douyin/link.mjs` | `live.douyin.com/<rid>`、裸房间号、`/root/live/<rid>`；拒绝用户/视频/搜索/短链 |
| `src/platforms/douyin/client.mjs` | 公开页解析、匿名 cookie、签名 WSS URL |
| `src/platforms/douyin/protobuf.mjs` | 自研 protobuf wire 编解码（零依赖、BigInt 保精度） |
| `src/platforms/douyin/messages.mjs` | PushFrame/Response/消息体解码、gzip、canonical 映射、连送合并 |
| `src/platforms/douyin/sign.mjs` | `node:vm` 沙箱执行 vendored 签名脚本 |
| `src/platforms/douyin/adapter.mjs` | WSS 生命周期、心跳/ack/看门狗/重连/去重/下播确认 |
| `src/platforms/douyin/login.mjs` | Cookie 诊断（格式/不完整/过期）、平台有效性复查、已验证/未验证状态、退出 |
| `src/platforms/douyin/browser-login.mjs` | 本机 Chrome/Edge + CDP：打开官方登录页、捕获官方二维码、等待 `sessionid`、专用资料目录、取消/清理 |
| `src/platforms/douyin/cookie-store.mjs` | AES-256-GCM 本地 Cookie（白名单、验证标记、备份排除） |
| `src/platforms/douyin/service.mjs` | 路由/监控与 `SessionManager` 粘合、30 天保留 |
| `src/monitoring/detectors/douyin.mjs` | 公开页直播状态检测与稳定 target |
| `src/platforms/douyin/vendor/` | AGPL-3.0 `sign.js` + 完整许可证与来源（未分发 `a_bogus.js`） |

### 3B.2 连接流程

```text
用户输入链接/房间号
  → parseDouyinInput()
  → GET https://live.douyin.com/<web_rid>（公开页）
      → room_id（19 位内部 ID）、status=2/4、标题、主播 id/secUid/昵称、在线数
      → Set-Cookie ttwid（匿名）
  → get_sign(md5(<协议参数串>)) → signature
  → wss://webcast100-ws-web-lq.douyin.com/webcast/im/push/v2/?…&signature=…
      → 5 秒心跳（PushFrame payload_type=hb）、needAck 时回 ack
      → gzip PushFrame → Response → Message[]
      → Chat/Gift/Member/Like/Social/RoomUserSeq
      → mapper / 连送合并 → EventIngest（去重/观众/金额/计数）
      → SSE → 控制台
```

### 3B.3 观众身份与聊天

- `user.id` → `viewer_uid` → 长期身份 `douyin:<user.id>`；`nickname` 只作展示，`secUid` 解析但不作为身份。
  缺失/为零时 `viewer_uid=null`，绝不用昵称建档案或把不同观众合并。
- 消息 `msgId` → `external_id`；适配器另保留最近 10,000 个消息 ID 作为连接内快速去重，数据库仍以
  `UNIQUE(session_id, dedupe_key)` 兜底。
- `common.createTime`（秒）→ `occurred_at`（毫秒）；偏离接收窗口过大的时间回退到本地接收时间。
- 正文 `content` 原样保存（中文/日文/Emoji/`[比心]` 等平台表情代码），不替换、不猜情绪；`rtfContent`
  仅在有可靠文本时才使用，缺失时不伪造。
- Member/Like/Social 只计数，不写普通聊天，更不写付费事件。

### 3B.4 礼物、连送与价值

| 事件 | 映射 | 金额语义 | 证据等级 |
| --- | --- | --- | --- |
| `WebcastGiftMessage`（`repeatEnd=1`） | `gift`，`gift_id`、`gift_name`、`gift_quantity`=连送最终数量 | `amount_minor=null`、`currency=null`、`value_kind=unknown`；`amount_display="<钻石合计> 抖音币"` 仅展示 | **已解析，真实礼物未观测到** |
| 连送中间消息 | 只更新合并状态，不写库 | — | 防止重复计数 |
| 未收到 `repeatEnd` 的连送 | TTL 后丢弃，不猜成礼物 | — | 不把未知当已支付 |
| 无 `diamondCount` 的礼物 | `amount_display=null` | 不写 0 元 | 不得把“没有金额”记成零收入 |

- 钻石/抖音币是平台展示价值，**不是人民币，也不是主播实际收入**；不得换算。
- 礼物发送者使用 `user.id`（付款者）；`toUser` 不是付款者，不据此增加付费人数。
- 礼物事件 ID 使用最终消息 `msgId`；重连 replay 命中唯一约束后不会再入库。
- 进场、点赞、关注、房间统计永远不会被映射成 `gift`。

### 3B.5 登录（礼物所需）

目标体验：普通用户点击「扫码登录」，在浏览器官方页面/应用内二维码完成扫码，不需要自己找 Cookie。
技术调查与证据见 `docs/DOUYIN_LOGIN_RESEARCH.md`。

- **纯 HTTP 直连不可用（2026-11-15 复测）**：`sso.douyin.com/get_qrcode` 返回 `text/html` 设备指纹挑战页；
  `www.douyin.com/passport/web/get_qrcode` 返回 `error_code 4031`「安全风险，已阻止此次访问」。
  这不是「抖音禁止扫码」，而是平台拒绝非浏览器客户端。LiveMemory 不伪造指纹/`a_bogus`/challenge。
- **浏览器扫码（本轮实现）**：`browser-login.mjs` 启动本机 Chrome/Edge 的**专用资料目录**
  （`<数据目录>/runtime/douyin-browser-profile`，带 `.livememory-owned` 标记），打开官方
  `https://www.douyin.com/login_page?service=https%3A%2F%2Fwww.douyin.com`，通过 CDP 读取官网自己的
  `get_qrcode` JSON，把同一张二维码显示在应用内。用户用抖音 App 扫码；若平台要求 `is_frontier`
  身份验证/验证码，用户必须在**官方浏览器页面**完成，程序只等待结果。
- 官网写入 `sessionid` 后，LiveMemory 用
  `GET https://www.douyin.com/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383`
  实际验证；只有 `status_code=0` 且有用户信息才记为「已登录（已验证）」。
- **状态分离**：未登录 / Cookie 已保存但未验证 / 已登录（已验证）/ 登录失效 / 登录无效或被平台限制。
  验证被网络或平台拒绝阻断时保存为 `saved_unverified`，不显示为登录成功。
- **手动 Cookie 备用**：界面临近输入框提供完整中文/日文/英文 12 步教程（F12 → Network → 刷新 →
  `live.douyin.com` 请求 → Headers → Request Headers → Cookie → 复制 → 保存并验证）。
- Cookie 只保存到 `secrets/douyin-login.json`（AES-256-GCM），不进入日志、错误、备份、HTTP 响应或 Git；
  「删除 Cookie / 退出登录」同时清除加密存储并尝试删除专用浏览器资料目录。
- 仍未绕过验证码、风控或访问控制；**真实手机扫码本轮未执行**（无账号），二维码捕获用真实 Chrome 验证。

### 3B.6 直播状态、结束与重连

- 连接成功不等于仍在直播。适配器每 60 秒读一次公开页；**连续 2 次有效离线**才确认
  `platform_ended`。网络错误、429、风控页只退避，绝不结束。
- 90 秒无帧看门狗、连接关闭、服务端断流：进入 `reconnecting`，1→30 秒指数退避，保留同一 session；
  连续 15 次失败进入可恢复 `failed`，之后每 5 分钟低速探测。
- 多直播间各自独立 adapter/session；同一 `platform + room` 双重拒绝重复启动。
- 平台状态写入 `sessions.platform_status` / `platform_ended_at` / `platform_end_quality`。

### 3B.7 自动开播监听

- `MonitoringManager` 新增 `douyin` detector：等待时每 90 秒（60–150 秒抖动）读取一次公开页；
  每平台一个 pacer（抖音 ≥2 秒），最多 2 个并发检查。
- 目标 key 为 `web_rid`，`platform_uid` 为主播 id；公开页没有可靠的“本场开始 id”，因此
  `liveCycleKey('douyin')` 返回 `null`：手动停止后保持抑制，直到页面确认下播，避免把同一场重复开播。
- 发现开播后调用 `DouyinService.connectDetected`，复用普通适配器/`EventIngest`；关播后目标保留。

### 3B.8 数据保留

- 抖音原文、展示标签与过期昵称按 **30 天**清理（Douyin-only scope）；保留事件行、计数、稳定 UID。
- 清理在启动、抖音场次结束与 `POST /api/douyin/retention/apply` 时执行。
- 这不等于完全删除个人数据；文档与界面不得声称“已彻底删除”。

### 3B.9 验证状态（2026-11-15，Asia/Shanghai）

真实公开直播间 `708764876300`（未登录、未付费、未保存/展示正文）：

| 验证 | 结果 |
| --- | --- |
| 源码路径 20 秒 | 7 条 chat，7/7 有 `user.id`、昵称、消息 ID、CJK；7 个唯一身份；0 重复；144 member / 4 like / 2 follow / 3 stats；0 gift |
| 正式 EXE | 连接成功，2 条真实 chat 入库；2/2 有 `douyin:<id>`、昵称、消息 ID、原文；停止 `ended`；重启后数据仍在 |
| 正式 EXE 自动监听 | 创建目标 → check → `recording` + 正常 session → 停止 → 删除目标 |
| 浏览器扫码（真实 Chrome/Edge、未扫码） | 官方登录页打开；捕获官方 `get_qrcode` 二维码（PNG base64，`is_frontier=true`，约 60 秒）；取消后资料目录可删除；`verify-douyin-browser-login` **8/8** |
| 真实手机扫码 | **未执行（无账号）**；不得写成成功或失败 |
| Cookie 负向验证 | 格式错误/不完整/假 session 分别被 400/400/401 拒绝；不保存为登录 |
| Cookie 正向验证 | **未验证**（需要真实账号 Cookie） |
| 礼物/连送 | 匿名 0；真实事件未观测到；自动化覆盖解析/合并/去重/金额未知 |
| 断线/下播/多房间 | 自动化覆盖；真实拔网与“直播中→下播”未捕获 |

**未验证 / 不得宣称**：真实手机扫码成功、登录后的礼物推送、真实礼物、真实连送、真实付费留言、
真实断网恢复、真实下播、10+ 房间压力、抖音官方稳定性承诺。

## 3C. TikTok Live（M5，2026-11-16，`feature/tiktok`：统一为匿名本地 WebSocket）

M5 产品决定（用户明确授权）：TikTok 面向普通用户**只有一条采集路径**——匿名本地 webcast WebSocket。
本轮已删除浏览器扫码登录、登录状态 UI、专用浏览器中继、免费社区签名通道与「采集通道」选择。
历史实现与调查见 §3C.9；真实验收数字见 `docs/STATUS.md` §0.42。

### 3C.1 唯一传输：匿名本地 webcast WebSocket

| 项目 | 事实 |
| --- | --- |
| 端点 | `wss://webcast-ws.tiktok.com/webcast/im/ws_proxy/ws_reuse_supplement/`（备选 `webcast-ws.us.tiktok.com`） |
| 凭据 | 仅匿名 `ttwid` 设备 Cookie（TikTok 对任何访客的普通页面请求都会下发） |
| 账号 | **不需要**；不扫码、不导入 Cookie、不读用户浏览器资料 |
| 第三方服务 | **不需要**；不依赖付费或免费社区签名服务，无 API Key |
| 额外运行时 | **不需要**；Node 22+ 内置 `fetch` + 全局 `WebSocket`，可在 Node SEA Windows EXE 内运行 |
| 请求签名 | 不需要 `X-Bogus`/`signature`/`msToken`；`im/fetch` 未被使用 |
| 协议性质 | **TikTok 非公开 web 协议，不是官方 API**；TikTok 可随时更改或限制，界面与文档均标注「非官方/实验性」 |

连接参数（`src/platforms/tiktok/webcast.mjs` `buildSocketUrl`）镜像网页播放器：`room_id`、`identity=audience`、
`compress=gzip`、`resp_content_type=protobuf`、`heartbeat_duration=10000`、`aid=1988` 等。
握手头只带 `user-agent`、`cookie: ttwid=…`、`origin: https://www.tiktok.com`。
**没有**任何登录、签名或 token 参数。

### 3C.2 连接与帧处理

1. 取匿名 `ttwid`：`GET https://www.tiktok.com/`，读 `set-cookie: ttwid=…`；缓存到 `<data>/tiktok/ttwid.json`
   （`0600`，仅设备 Cookie，不是登录凭据）。TikTok 会对突发页面请求返回无 Cookie 的错误页
   （`x-tt-system-error: 3`）；实现按 1.5s/3s 退避重试 3 次，仍失败则报告 `TIKTOK_RATE_LIMITED`。
2. 房间元数据仍来自公开接口（见 §3C.3）。
3. 打开 WebSocket，发送 `im_enter_room`（`room id / live_id=12 / audience`）。
4. 每 10 秒发送 `hb` 心跳；TikTok 在心跳缺失时以 `client_ping_timeout` 关闭连接。
5. 每帧是 `PushFrame`：`field 6` encoding、`field 7` payloadType、`field 8` payload、`field 2` logId。
   仅 `payloadType='msg'` 且 `encoding='pb'` 的帧解事件批；gzip 魔数 `1f 8b` 时先解压，
   再解 `ProtoMessageFetchResult`（`field 1` 消息数组、`field 6` isHistory）。
6. 有 `logId` 的帧回 `ack`（payload `-`）。
7. `ProtoMessageFetchResult.Message` → `mapTikTokMessage` → canonical event → **统一 `EventIngest`**。
8. 无续传游标：重连期间的消息可能遗漏，恢复后不补录；UI 显示「可能遗漏」。

### 3C.3 本地免费公开接口（房间元数据）

| 端点 | 用途 |
| --- | --- |
| `www.tiktok.com/api-live/user/room/?...&uniqueId=<handle>&sourceType=54` | 房间 ID、开播状态、主播 `user.id`/昵称、标题 |
| `webcast.tiktok.com/webcast/room/info/?room_id=<id>` | 标题、开播时间、主播 `id_str`/`sec_uid`、累计观看 |
| `webcast.tiktok.com/webcast/gift/list/?room_id=<id>` | 礼物目录（名称 + 钻石数，10 分钟缓存） |

这些接口在突发请求下会返回 403/空响应（限流）：实现把它分类为 `RATE_LIMITED`，**不**把它当成登录失效或下播，
也不会因为一次元数据读取失败就结束正在进行的采集。

### 3C.4 事件映射

| TikTok 消息 | canonical | 去重 | 说明 |
| --- | --- | --- | --- |
| `WebcastChatMessage` / `WebcastEmoteChatMessage` | `chat` | `common.msgId` | 原文保留 Unicode/Emoji；`viewer_uid = user.id`；历史回放（`isHistory`）跳过 |
| `WebcastGiftMessage`（`repeatEnd=1` 或超时冲刷） | `gift` | `common.msgId` | 同 `groupId` 只写一条最终态；`amount_display` 为钻石展示值，`amount_minor=null`、`value_kind=unknown`、不换算收入 |
| `WebcastSubNotifyMessage` | `membership` | `common.msgId` | 无金额 |
| `WebcastMemberMessage` / `LikeMessage` / `SocialMessage` | 只计数 | — | 不写事件 |
| `WebcastRoomUserSeqMessage` | 当前观众数 | — | 只更新 snapshot |
| `WebcastControlMessage(action=3)` | 一次离线观测 | — | 需两次独立观测才结束 |

- 稳定身份：`tiktok:<user.id>`；昵称只用于显示；`tiktok:<handle>` 只作监控目标键。
- 连送：同一 `groupId` 仅最终态写一条；10 秒未收到最终态时按最后值冲刷一次；礼物是否真实观测到
  以每次运行的实际事件为准，未收到即标 `NOT-OBSERVED`。
- 一帧不等于弹幕：`frames / batchFrames / controlFrames / messages / chats / gifts` 分开计数，
  `eventsVerified` 只在收到真实 chat/gift/membership 后为真。

### 3C.5 状态机、重连与多房间

- 连接状态：`connecting / connected / reconnecting / rate_limited / failed / stopped`；
  采集分类：`waiting_events`（已连接但还没有事件）、`normal`（已有真实事件）等。
- 掉线：1→30 秒指数退避 + 抖动；连续 12 次失败后进入 5 分钟慢探测，不放弃记录。
- 60 秒无任何帧 → 视为死连接并重连（`idle_timeout`）。
- 重连前重新解析房间：room id 变化（主播重新开播）或公开状态 `isLive=false` 作为一次离线观测；
  两次独立观测才结束同一 session，并标记 `platform_ended`。
- 只有 socket-open 失败才刷新 `ttwid`；普通网络掉线复用缓存 Cookie，避免触发页面请求限流。
- 多房间：每个 `tiktok` 录制拥有独立 adapter、socket、session、去重集合、重连定时器与停止操作；同一 `platform+room` 不允许重复启动。**M6 根因修复**：旧前端把「存在任意 TikTok 记录」当成「该直播间重复」，按钮被全局禁用；真正限制来自 UI，而不是 `SessionManager`/adapter。现改为只比较 `platformRoomId`/handle；不同 room 可并发，服务端仍以 `(platform, platform_room_id)` 拒绝真正重复。
- 每次中断/恢复记录 `disconnectedAt`、`recoveredAt`、`gapMs`、`lastEventAt`、`possibleMissed=true`，不声称补录。

### 3C.6 UI：四项状态分离

TikTok 面板只保留普通用户需要的东西：直播间链接/`@用户名`、检查直播间、开始/停止记录、自动监听、
采集状态与错误。技术上不再有登录，也不再有采集通道选择。

| 状态 | 来源 |
| --- | --- |
| 直播间识别 | 当前「检查直播间」的结果或正在记录的 `roomId`；切换输入不会用旧结果冒充新直播间 |
| 采集连接 | adapter 的 `connected/reconnecting/rate_limited/...` |
| 真实事件 | `counters.chats/gifts/memberships` 与 `lastEventAt`；帧数不算事件 |
| 正式记录 | `SessionManager` 中确实存在的 session；没有 session 绝不显示「正在记录」 |

高级详情保留：协议 `webcast-ws`、ws host、帧/批/控制帧数、消息数、重复数、历史跳过、心跳数、间隔与错误原因。

### 3C.7 监控与保留

- 检测器：`src/monitoring/detectors/tiktok.mjs`；周期键 `tiktok:<handle>:<roomId>`（每场新 roomId）。
- 策略：90 秒基准、60–150 秒抖动、2 秒请求间隔、4 次连续失败进入错误态、30 分钟慢重试。
- 保留：TikTok-only 30 天清理原文与过期昵称；保留事件行、计数、稳定 ID、金额合计。

### 3C.8 已删除的旧实现与兼容清理

| 删除项 | 说明 |
| --- | --- |
| `browser-login.mjs` / `browser-launch.mjs` / `browser-relay.mjs` | 扫码登录、专用 Profile、CDP 中继 |
| `signer.mjs` / `rate-budget.mjs` | 免费社区签名通道与共享预算 |
| `adapter.mjs` / `transports.mjs` | 15 秒轮询适配器与 `auto/signer/browser` 通道选择 |
| `/api/tiktok/login/*`、`/api/tiktok/transport` | 登录与通道选择路由（现在返回 404） |
| 设置 `tiktokTransport` | 不再接受；旧客户端提交该字段会得到 `SETTINGS_INVALID` |
| 三语 `tiktokLogin*` / `tiktokTransport*` / `tiktokSigner*` / `tiktokBrowser*` 文案 | 已删除；`tiktokLogin*` 等遗留键不得再出现 |

- **旧 Profile 清理**：`src/platforms/tiktok/legacy-cleanup.mjs` 在启动时删除
  `<data>/browser/tiktok/login-state.json` 与**带 `.livememory-owned` 标记**的
  `<data>/browser/tiktok/account`；没有标记的目录一律保留并记录跳过原因。
  绝不读取或删除 Chrome/Edge 的日常用户资料。
- 历史 TikTok 直播、弹幕、观众画像与 AI 数据不受影响（数据库 schema 未改）。
- 抖音的扫码登录、Cookie 教程与浏览器登录代码**未改动**（独立模块，单独测试）。

### 3C.9 历史调查（已归档，不再作为产品路径）

- `signer` 免费社区通道：30 次/小时匿名上限，130 秒级轮询，不是实时；M5 已删除。
- `browser` 中继：真实桌面 EXE 登录后 `room/enter` 403、`PushFrame` 解析、登录/采集状态分离等
  M2–M4 修复均保留在历史文档中；真实登录后端到端投递始终 BLOCKED。M5 不再需要它。
- `talkaboutdesign/tiklive`（MIT）：M4 只读探针 35 秒收到 469 chat / 19 gift；M5 以它作为协议参考，
  用零依赖的本地实现替代，未引入 Bun / Effect / 任何运行时依赖。许可证与归属见 `THIRD_PARTY_NOTICES.md`。
- 使用该协议的前提是**不绕过任何访问控制**：不破解验证码、不伪造登录态、不规避地区限制。
  若平台明确拒绝访问，必须停止该路径并报告。


## 3D. Kick（v0.16.0 候选，G2–G5 完成，未发布）

### 3D.1 接入边界与代码结构

- 唯一路径：匿名 Centrifugo 实时通道（`kick.com` 前端自己使用的公开 feed），**免登录**、无 Cookie、
  无 API Key、无第三方采集服务、无公网服务器。官方 API 无读聊天能力（webhook 需公网接收端），不作为采集路径。
- 代码：`src/platforms/kick/{link,http,messages,transport,adapter,service,errors}.mjs`；
  `KickAdapter` 每房间一个 socket，事件只经 `EventIngest` 写入。
- 非官方 / 实验性：不得描述为官方 API；无续传游标，重连期间可能漏消息。

### 3D.2 连接流程

```text
GET  https://kick.com/api/v2/channels/<slug>                 (HTTP/2; HTTP/1.1 会被 WAF 403)
POST https://web.kick.com/api/v1/realtime/channels/<channelId>/chat/connection
POST https://web.kick.com/api/v1/realtime/auth/connection     → guest JWT (TTL 2700s)
WSS  realtime.<region>.platform.kick.com/connection/websocket
     connect → subscribe 五条 feed：chatrooms.<id>.v2（必需）、chatrooms.<id>、
     chatroom_<id>、channel.<channelId>、channel_<channelId>
```

- 服务端每 25 秒发 `{}`，客户端回 `{}`。
- token 在 TTL 前 90 秒主动重连换新；`disconnect/error 109/3500` 立即换 token。
- 退避 1–30 秒 + 抖动；连续失败 12 次进入 `failed`；主动停止不重连。

### 3D.3 身份、文本与金额

- 身份：`kick:<sender.id>`；缺 ID 的消息 `viewer_uid=NULL`、`source_quality=unknown`、不建档案；
  昵称只用于展示，不作为身份。
- 消息：`external_id` = Kick 消息 UUID；`content` 原文不变；`[emote:id:name]` 解析进 `emotes`；
  reply 的父消息 ID 作为诊断字段保留。
- KICKs 礼物：`KicksGifted` → `gift`；`external_id` = `gift_transaction_id`；`amount_minor=NULL`、
  `currency=NULL`、`value_kind=unknown`；KICKs 数量与 gift type/tier 只写入 `amount_display`，不换算收入。
- 赠送订阅：`GiftedSubscriptionsEvent` 只有用户名。按 YouTube 赠订语义，赠送者一条 `membership`
  （`is_paid=true`、数量 = gifted_total），每位接收者一条免费 `membership`（`is_paid=false`、无身份）；
  接收者名单因此按事件行保留，不按用户名建档案、不计收入。
- 订阅/续订、开播/下播、Host、投票：已解析分类但未观测到真实事件，标 `NOT-OBSERVED`；
  封禁/删除/Pin 只计数、不进入用户时间线（与其他平台一致）。关注事件只能走官方 webhook → 本地形态不支持。

### 3D.4 状态、重连与多房间

- 每房间独立 adapter/socket/session；同 `platform+room` 拒绝重复启动；跨房间事件按 chatroom topic 校验。
- 状态 `connecting/connected/reconnecting/failed/stopped`；连接成功但无事件显示「已连接，等待第一条事件」。
- 真实 G4 长测（≥60 分钟）中出现过平台侧断线并自动恢复，记录在 `docs/KICK_G2_G5_ACCEPTANCE.md`。
- **开播监控（G5.1）**：Kick 已接入共用 `MonitoringManager`（与其余五平台同一调度器/表/生命周期）。
  `detectors/kick.mjs` 每 90 秒（抖动 60–150 秒）只读查询公开频道；离线是正常等待，
  频道不存在/网络/WAF 分别映射；目标身份用 `channelId`，直播周期键 `kick:<channelId>:<livestreamId>`。
  开播后 `connectDetected` 创建 session；适配器每 60 秒确认频道状态，**连续两次 offline** 才结束
  （聊天 socket 下播后可能仍连接，不能只靠断线）；手动停止写入 `manualStop`，同一场不会被自动重启，
  确认 offline 后清除并等待下一场。详见 `docs/KICK_G5_1_MONITORING.md`。

### 3D.5 保留、UI 与验证状态

- 30 天原文保留策略，平台作用域 `kick`；清理 `content/emotes/badges/amount_display`，保留计数与稳定 ID。
- UI：直播页第六个平台页签；十语言 2,304 键；添加房间 / 检查 / 开始 / 停止 / 开播监控 / 状态 / 历史 / 画像 / AI 全部复用现有页面。
- 验证：G1 真实连接（3,040 条聊天）→ G2 产品接入 → G3 十语言 UI → G4 ≥60 分钟长测 →
  G5 真实 EXE（`verify-kick-exe.mjs`）。未发布：版本仍 `0.15.0`，未合并 `main`。
  详见 `docs/KICK_G1_ACCEPTANCE.md`、`docs/KICK_G2_G5_ACCEPTANCE.md`。

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
2. 生成稳定 `external_id`（Bilibili 礼物 `tid`、SC `id`、大航海 `payflow_id` 或 `uid:level:time:count`；YouTube 一律使用 `message.id`；Twitch 使用 IRC `id`；Bilibili 弹幕不设 external_id，由指纹去重）；
3. 确认金额单位与币种，否则 `amount_minor=null`、`value_kind=unknown`；
4. 标注 `source_quality`（`verified` 仅用于字段实测确认后）；
5. 提取平台表情元数据（有可靠依据时）并写入 `emotes`；没有依据时不要猜测；
6. 通过 `EventIngest` 写入。

## 5. 真实性标注

- `mock` 平台永远 `source_quality=mock`；它只用于自动化测试夹具与历史数据，正式界面不再显示「模拟直播」入口。
- Bilibili 真实会话 `source_quality=estimated`（会话级）；单条事件：弹幕/礼物/SC 身份完整时为 `verified`，身份缺失为 `unknown`，大航海为 `estimated`。
- YouTube 事件 `source_quality=estimated`：字段来自官方文档，但**尚未在真实直播中采样**；`verified` 只在真实样本后使用。
- Twitch：普通聊天与 `resub` 为 `verified`（真实公开频道观测）；`sub`、`subgift`、Bits/Cheer 为 `estimated`（标签已解析、真实事件未观测）。不得因为 Mock 通过就升级证据等级。
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

Twitch 自 M1 起采用同样的 30 天原文保留（独立 `platform='twitch'` scope）：清理 `content`/`emotes`/`badges`/`amount_display` 与过期昵称，保留事件行、计数、稳定 User ID 与金额合计。清理触发：启动、Twitch 场次结束、`POST /api/twitch/retention/apply`；审计写入 `app_meta['retention.lastRun.twitch']`，不会覆盖 YouTube 的 `retention.lastRun`。该窗口在 M1 固定为 30 天，暂未提供用户配置项。

## 8. 自动开播监听（v0.10.0）

### 8.1 统一架构

```text
monitor_targets（持久目标，schema 11）
  → MonitoringManager（状态机 / 调度 / 重试 / 会话创建）
  → Platform Detector（Bilibili roomStatus / YouTube channel live page / Twitch public channel metadata）
  → SessionManager.startPlatform（普通适配器 + 普通 events 写入）
  → sessions（每场一条，monitor_target_id 关联目标）
```

监听目标与单场 `sessions` 是两个概念。关播只结束当前 session，目标保留；下次开播创建新的
session。网络重连不创建新 session（连接状态由适配器维护）。

| 状态 | 含义 |
| --- | --- |
| `waiting` | 已启用、当前未开播，等待下次检查 |
| `checking` | 正在执行一次只读检测 |
| `connecting` | 已确认开播，正在创建并连接会话 |
| `recording` | 本场正在记录；公开视图可派生 `reconnecting` |
| `ending` | 平台已报告结束，正在确认/收尾 |
| `paused` | 用户暂停；当前记录不停止 |
| `error` | 连续失败或输入不可用，需要处理；30 分钟后低速重试 |

### 8.2 Bilibili

- 目标为真实房间号：用户可粘贴直播间 URL、短房间号或真实房间号；添加时用
  `room_init` 规范化，并读取 `getInfoByRoom` 的主播名/UID。
- 等待开播时只请求 `room/v1/Room/get_info`（`live_status` 0/1/2），**不使用 WebSocket 心跳或
  弹幕连接状态判断开播**。
- 确认 `live_status=1` 后调用 `BilibiliService.connectResolved`，仍由现有适配器再次校验并
  建立 WebSocket；`live_status=2`（轮播）视为未开播。
- 记录开始后由现有适配器负责下播确认（WS `LIVE`/`PREPARING` + 60 秒状态查询 + 两次有效离线）。
- 失败（超时、429、-352、异常响应）只退避，不结束、不开始新场次。

### 8.3 YouTube

- 目标为稳定频道 ID：接受 `/channel/UC...`、`@handle`、`/c/...`、`/user/...`、裸 Channel ID，
  以及普通/直播视频链接（通过公开 watch 页解析所属频道）。
- 等待开播时请求 `/channel/<id>/live`：直播时页面内嵌 watch 播放器
  （`videoDetails.isLive` / `microdata.isLiveNow`），未直播时返回频道页。
- 必须同时满足「视频 ID 合法」「`channelId` 与目标一致」「`isLive`/`isLiveNow` 为真」才创建
  会话；`isUpcoming` 只算等待，首映/普通视频/已结束不算直播。
- 页面结构解析失败时，回退到频道 RSS（最近 6 小时）+ 最多 2 个候选视频的公开 watch 页确认；
  RSS 条目本身不会被当成直播。
- 发现后使用现有 `YouTubeService.connectDetected` 与匿名公开聊天适配器；不调用 Data API、
  OAuth、API Key，不发送 Cookie。

### 8.3.1 Twitch

- 目标为 channel login（URL/账号规范化），`platform_uid` 为稳定 channel id。
- 等待开播时读取公开频道元数据：`stream.id` 存在才算 LIVE；`stream.id` 是同一场直播的稳定周期键。
- 发现开播后调用 `TwitchService.connectDetected`，由普通 IRC 适配器再次用 `ROOMSTATE room-id`
  校验频道；关播由适配器两次有效离线确认，不由监控器结束记录。
- 失败、429、GQL 结构异常只退避，不创建 session、不结束记录。

### 8.4 频率、缓存与限流

| 平台 | 等待时基准间隔 | 抖动 | 429/失败 |
| --- | --- | --- | --- |
| Bilibili | 60 秒 | ±12%（45–90 秒） | `Retry-After`；否则指数退避至 10 分钟 |
| YouTube | 180 秒 | ±12%（120–240 秒） | `Retry-After`；否则指数退避至 30 分钟 |
| Twitch | 120 秒 | ±12%（90–180 秒） | `Retry-After`；否则指数退避至 20 分钟 |

- 每个平台一个 `RequestPacer`（Bilibili ≥1.2 秒、YouTube ≥2.5 秒、Twitch ≥1.5 秒请求间隔），最多 2 个并发检查。
- 启动/重启时目标错峰 0–45 秒检查；新增目标 0.5–3 秒后首次检查。
- 正在记录的目标不参与监听轮询，避免与适配器自身状态查询重复。
- 缓存：频道身份、显示名、上次观察结果保存在目标行；浏览器窗口只读 API，不自行轮询平台。
- 连续失败 4 次进入 `error`，30 分钟后重试；错误码与翻译后的原因显示在目标页。

详细调研、许可证与真实页面实测见 `docs/YOUTUBE_AUTO_DISCOVERY.md`。

## 9. v0.13.1 主播元数据与手动停止采集

### 9.1 Bilibili 未开播主播名

- `BilibiliRoomDetector.resolve()` 先尝试 `getInfoByRoom`（`anchor_info.base_info`），失败或缺少名称时回退到公开的 `live_user/v1/Master/info?uid=<anchorUid>`；`room_init.data.uid` 提供稳定 UID。
- `detect()` 对旧目标（displayName 仍为 `Bilibili <roomId>`）每 10 分钟最多重试一次元数据；成功后更新 `monitor_targets.display_name`、`platform_uid` 与 `meta.anchorName`。失败只保留房间号，不伪造名称。
- 真实只读验证（2026-11-11）：房间 `3` 未开播 → 解析 `23058`，`Master/info` 返回 `3号直播间` / `11153765`；房间 `5050` / `21144080` 的 `getInfoByRoom` 被风控拒绝时，`Master/info` 仍返回真实主播名。
- 主播改名不改变 `bilibili:<uid>` 身份；同名不同 UID 不合并。

### 9.2 手动停止当前直播采集后的抑制

- 新增目标状态 `live_stopped`：主播仍 LIVE，但本场采集由用户停止；Tab 保留，显示「直播中 · 本场已停止采集」。
- `monitor_targets.meta_json.manualStop` 持久保存 `{sessionId, liveKey, stoppedAt, awaitingOffline}`，跨进程重启有效。
- `liveKey` 优先使用 Bilibili `live_time`（epoch 秒或平台时间字符串）、YouTube `videoId` 或 Twitch `stream.id`；没有可靠 key 时不解除抑制。
- 同周期 LIVE + 错误/超时/未知：继续抑制；只有 `detect` 返回 offline/upcoming 才清除；下一次 LIVE 若 key 不同（新 `live_time` / 新 videoId）才创建新 session。
- 用户明确点击「开始接收弹幕」（`action:resume_capture`）清除抑制并创建新的本地 session；不会重新打开已结束的旧记录。
- 暂停整个监听（`paused`）与停止当前采集（`live_stopped`）是不同状态；暂停不会删除抑制。
- 真实平台“停止后仍直播→重启”未执行；Mock + 可控时钟覆盖同周期、重启、错误、离线、新场、主动恢复。

## 10. 2026-11-15 多平台调研结论（TikTok / Twitch / 抖音）

完整报告：`docs/PLATFORM_RESEARCH_TIKTOK_TWITCH_DOUYIN.md`。**本节保留调研结论索引；Twitch 的 M1 实现与证据见 §3A，抖音/TikTok 尚未开发。**

| 平台 | 推荐 | 已验证 | 主要阻碍 |
| --- | --- | --- | --- |
| **Twitch** | **M1 已接入（`feature/twitch`）** | 调研：匿名 IRC 5 频道 45 秒 644 条 PRIVMSG，644/644 有 `user-id`/`display-name`/消息 `id`；USERNOTICE 有 resub/viewermilestone；`ROOMSTATE room-id`；EventSub 无 Token 订阅 401。M1 真实验证：6 频道并发 60 秒 418 条事件，418/418 有稳定 User ID + 消息 ID，304 身份，1 条真实 resub；单频道 45 秒 138/138 | 匿名 IRC/公开 GQL 未在官方文档承诺；Bits/赠订未观测到真实事件；EventSub OAuth 未配置；等待人工验收 |
| **抖音** | **第二个，先决策** | 匿名 WSS 连接真实房间；约 7 秒 175 条消息；45 秒 16 chat / 192 member / 25 like / 3 follow / 8 room / **0 gift**；13/13 chat 有 UID/昵称/secUid/消息 ID/CJK；公开页 `status=2/4` | **2026 年起礼物只推登录会话**；本地签名脚本 AGPL-3.0；逆向协议风控/条款风险；官方“直播小玩法”不是通用采集 |
| **TikTok** | **暂缓** | TTLC 2.5.0/2.4.4 均被 Euler 签名端点拒绝（Business plan）；1.2.3 本地签名超时；页面 WAF；**无真实事件** | 官方无公开 LIVE API；Euler Business $50/月起；AGPL + 约 60 包；Issue #280 报告漏消息 |

**接入原则（M2+ 平台必须遵守）：**

1. 所有事件只经 `src/platforms/shared/ingest.mjs`；不改 Bilibili/YouTube。
2. 稳定身份：Twitch `user-id`、抖音 `user.id`、TikTok `userId`；昵称只作展示。
3. 金额：Twitch Bits/Tier、TikTok/抖音钻石均无本币金额；`amount_minor=null`、`value_kind=unknown`，不得换算。
4. 连送：只在 `repeatEnd`/最终态写一条 `gift`；赠订付款者与接收者分两条，接收者 `is_paid=false`。
5. 自动开播：Twitch/抖音用公开页面状态，二次确认下播；不因聊天安静结束。
6. 保留：默认 30 天原文清理（可配置 1–30 天）；保留稳定 ID/计数/金额合计。
7. 许可证：不复制 AGPL 代码/脚本；不使用无许可证项目；MIT/Apache 保留声明。

> **2026-11-16 起，新平台的准入与验收统一由 `docs/PLATFORM_ADMISSION.md` 规定**
> （三个核心准入条件、字段最低要求、登录优先序、G0–G6 门禁、暂停条件、许可证策略）。
> 本节的 7 条原则仍然有效，但只是其中一部分；两者冲突时以 `docs/PLATFORM_ADMISSION.md`
> 与 `AGENTS.md` §6.12/§6.17 为准。候选平台调查记录见 `docs/PLATFORM_EXPANSION_RESEARCH.md`。
> **目前 Kick 已通过 G1 真实连接验证（2026-11-17），但尚未通过 G2–G6，未接入产品；
> 其余候选平台均未通过 G1。界面、README 与发布说明不得出现「已支持 Kick」或任何新平台。**
> Kick 的 G1 证据与 G2 设计见 `docs/KICK_G1_ACCEPTANCE.md`；代码位于
> `src/platforms/kick/`（骨架，未接入 routes/UI/监控）。
