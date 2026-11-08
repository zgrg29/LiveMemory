# 平台接入（PLATFORM_INTEGRATIONS）

状态：**Bilibili 最小真实闭环已实现并通过真实直播间验证（弹幕身份）；礼物 / SC / 大航海按参考实现映射但尚未在真实直播间观测到事件。YouTube 未开始。** 模拟平台（mock）保持可用。

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

### 2.4 经济支持字段与金额

| 字段 | 单位 | LiveMemory 处理 | 状态 |
| --- | --- | --- | --- |
| `SEND_GIFT.price` / `total_coin`（gold） | 金瓜子，**1000 = 1 CNY** | `amount_minor = total_coin / 10`（分），`value_kind=actual`；不能整除时取整并标 `display` | ✅ 单位来自参考仓库的换算与真实数值交叉验证（9900 → ¥9.90、100 → ¥0.10）；本轮未观测到礼物事件 |
| `SEND_GIFT.coin_type = silver` | 免费礼物 | `is_paid=false`、`gift_type=free`、金额为 `null` | ✅ 规则已测 |
| `SUPER_CHAT_MESSAGE.price` | **CNY**（元） | `amount_minor = price × 100`，`value_kind=actual` | ✅ 单位来自参考仓库；本轮未观测到 SC |
| `GUARD_BUY.price` | 金瓜子？（**未确认**） | **不记金额**：`amount_minor=null`、`value_kind=unknown`；事件本身保留 | ⬜ 参考实现自己标注未确认，本轮未观测到 |
| 会员/粉丝牌 | — | 暂不映射 | ⬜ |

**不换算成人民币的数值一律留空**，UI 显示为「—」，不为了图表好看编造金额。

### 2.5 登录与安全

- 扫码流程已实现：`POST /api/bilibili/login/open` 生成二维码并在**默认浏览器**打开 Bilibili 的扫码页（同一 `qrcode_key`），前端每 2 秒 `POST /api/bilibili/login/poll`，成功后服务端拿到 Cookie。
- 本轮**没有实现本地二维码渲染**（零依赖约束下需要一个 QR 编码器），因此二维码由 Bilibili 自己的页面显示；这是已知限制，不是「已支持内置扫码」。
- Cookie 只保存在 `%LOCALAPPDATA%\LiveMemory\secrets\bilibili-login.json`，AES-256-GCM 加密，密钥同目录、尽力用 `icacls` 限制为当前用户；状态 API 永不返回 Cookie；日志脱敏覆盖 `SESSDATA`/`bili_jct`/`DedeUserID`。
- 匿名为默认：不登录也能接收公开弹幕（本轮已实测）。

### 2.6 已知限制与未验证

- **礼物 / SC / 大航海**：字段映射来自参考仓库，本轮未在真实直播间观测到事件，不能称为「真实验证通过」。需要在一场有礼物/SC/大航海的直播中复核。
- **`SEND_GIFT_V2`（base64 protobuf）**：未实现。若平台把礼物切到 V2 通道，会漏礼物；需要采集样本后补协议解码。
- **登录后的身份字段**：本轮未扫码（没有可扫码的账号），登录是否解锁更多字段未验证。
- **`dm_v2`**：实测为空字符串；若未来携带身份信息，需要额外解析。
- **`info` 位置差异**：已兼容顶层与 `data` 两种；平台再次改动时需要重新采样。
- **大航海金额**：不记账；后续需要确认单位后再补。
- **热门房间的消息速率**：30 秒可收到 100+ 条弹幕；长时间直播需要观察内存与写放大（M4）。
- 断线重连、去重、崩溃恢复已有自动化测试；**真实断线**（网络切换）未做长时间验证。

### 2.7 复现方法

```bat
:: 平台字段与事件（匿名，不打印内容与凭据）
node scripts/probe-bilibili.mjs 21144080 30

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

## 4. 统一事件模型

`src/shared/events.mjs` 的 canonical event 是唯一跨平台格式：

```text
platform, session_id, external_id, event_type, viewer_uid, display_name,
occurred_at, received_at, content, gift_id, gift_name, gift_type,
gift_quantity, unit_amount_minor, amount_minor, currency, value_kind,
is_paid, source_quality, dedupe_key
```

适配器职责：

1. 解析原生消息；
2. 生成稳定 `external_id`（礼物 `tid`、SC `id`、大航海 `payflow_id` 或 `uid:level:time:count`；弹幕不设 external_id，由指纹去重）；
3. 确认金额单位与币种，否则 `amount_minor=null`、`value_kind=unknown`；
4. 标注 `source_quality`（`verified` 仅用于字段实测确认后）；
5. 通过 `EventIngest` 写入。

## 5. 真实性标注

- `mock` 平台永远 `source_quality=mock`，UI 显示「模拟」。
- Bilibili 真实会话 `source_quality=estimated`（会话级）；单条事件：弹幕/礼物/SC 身份完整时为 `verified`，身份缺失为 `unknown`，大航海为 `estimated`。
- 字段未逐项验证的平台事件标 `unknown` 或 `estimated`。
- 不得把模拟测试通过描述为真实平台接入完成。
- 真实直播间验收记录：`21144080`（2026-11-08，弹幕 142 条全部带 UID/昵称）、`7734200`、`5050`（72/77 条 UID=0 + 昵称打码）。房间号、时间与结论已记入 `docs/TEST_PLAN.md`。
