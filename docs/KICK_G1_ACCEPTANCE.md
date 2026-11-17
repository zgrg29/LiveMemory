# Kick G1：真实本地采集验证报告

状态：**G1 通过（2026-11-17）**。真实公开直播间、免登录、本地直连已成功；
**Kick 仍未接入 LiveMemory 的产品功能**（无路由、无界面、无正式平台标识），
本轮只提交研究 PoC 与最小适配器骨架。

本轮同时取得了 G2 字段统计与 G3 身份评估的大部分证据，但**不宣称 G2/G3 正式通过**
（事件映射、产品接入未做）；**G4 未通过**（最长单轮 16.1 分钟 < 30 分钟；强制断线与双房间已验证）。

- 相关文档：`docs/PLATFORM_ADMISSION.md`（G0–G6 门禁）、
  `docs/PLATFORM_EXPANSION_RESEARCH.md` §2（G0 调查记录）、
  `docs/PLATFORM_INTEGRATIONS.md`（现有五平台架构）、`AGENTS.md` §6.12/§10。
- 代码：`src/platforms/kick/`（骨架）、`scripts/kick-poc.mjs`（真实采集 PoC）、
  `scripts/kick-g1-analyze.mjs`（证据分析）。
- 测试：`tests/unit/kick-*.test.mjs`、`tests/integration/kick-ingest.test.mjs`。

---

## 1. 结论摘要

| 完成标准 | 结果 | 证据 |
| --- | --- | --- |
| 至少一个真实 Kick 直播间成功接收聊天 | ✅ | 两个真实在播房间，共 1,936 条真实聊天 |
| 两个真实直播间同时采集 | ✅ | odablock 与 gmhikaru 并发 966 秒，各自独立 socket |
| 能提取可靠的观众身份 | ✅ | `sender.id` 覆盖率 **100%**（1,604 + 332 条） |
| 能保存真实消息及原始字段 | ✅ | 原始 payload 逐条落盘（`raw.jsonl`）+ canonical 草稿（`events.jsonl`） |
| 能正常停止连接 | ✅ | `stop()` 后 socket 关闭、状态 `stopped`、无重连 |
| 重连机制有实际测试 | ✅ | 强制断开后 **5.7 秒**恢复，期间 5.3 秒空档，无重复消息 |
| 不依赖收费第三方服务 | ✅ | 直连 Kick 公共端点，无代理、无第三方采集服务 |
| 不要求用户配置开发者 API | ✅ | 仅使用匿名 guest token（无账号、无 Cookie、无 API Key） |
| 不影响现有五个平台 | ✅ | 未改五平台代码；全量测试通过（见 §12） |

**判定：G1 通过，可进入 G2。** 但以下三项必须在 G2 解决，不能当作已完成：

1. 订阅 / 续订、开播下播、Host、投票未观测；赠送订阅与 KICKs 各真实验证到 **1 条**，
   但赠送订阅只有用户名（无稳定 ID）、KICKs 只有 KICKs 数量（无法币币种），G2 仍要补样本与映射；
2. 45 分钟 guest token 的**真实到期**未等待验证（代码路径与单测已覆盖，采用提前 90 秒主动刷新）；
3. 长时间（>1 小时）稳定性、限流形态与「重连期间漏消息」比例未量化。

---

## 2. 范围与边界

- **免登录**：只用任何访客都能获得的匿名 guest token；不登录、不导入 Cookie、不读取用户浏览器会话。
- **不绕过访问控制**：没有破解验证码、没有伪造登录态、没有规避地区/年龄限制。
- **只接直播**：房间 `livestream` 为空时直接拒绝；全程**没有**调用聊天历史端点
  （`/api/v2/channels/{id}/messages`），不抓取回放。
- **非官方协议**：Kick 实时聊天是 `kick.com` 前端自己使用的 Centrifugo 通道，不是官方 API。
  本文与后续界面都不得描述为「官方授权」或「合规」。
- **零运行时依赖**：`node:http2`、`node:zlib`、内置 `WebSocket`；未引入任何 npm 包。
- **不复制第三方代码**：协议事实来自真实抓包与开源实现阅读，代码为本仓库自行编写（见 §11）。

---

## 3. 真实环境

| 项目 | 值 |
| --- | --- |
| 时间 | 2026-11-17 01:35–01:51（Asia/Shanghai）= 2026-11-16 17:35–17:51 UTC |
| 系统 | Windows 10.0.26300（Windows 11）x64，本机普通网络 |
| Node.js | v24.21.0（仓库要求 ≥ 22.5；用内置 `WebSocket` 与 `node:http2`） |
| 采集工具 | `scripts/kick-poc.mjs`（研究工具，**不是**产品采集路径） |
| 证据目录 | `tests/.tmp/kick-g1-run/`（gitignored，未提交任何真实聊天内容） |

---

## 4. 实际连接机制（全部为 2026-11-17 实测）

```text
1) 房间与 chatroom
   GET https://kick.com/api/v2/channels/<slug>
   → id=channelId, chatroom.id=chatroomId, livestream{...}

2) 实时服务地址
   POST https://web.kick.com/api/v1/realtime/channels/<channelId>/chat/connection
   body: {"client":{"id":"<uuid>","type":"web"},
          "capabilities":{"accepted_providers":[{"provider":"pusher"},{"provider":"centrifugo"}]}}
   → {"connections":[{"provider":"centrifugo","credentials":{"url":"wss://realtime.<region>.platform.kick.com/connection/websocket"}}]}

3) 匿名 guest token（每次连接都重新申请，不落盘、不打日志）
   POST https://web.kick.com/api/v1/realtime/auth/connection
   body: {"client_id":"<同一 uuid>"}
   → {"data":{"token":"<JWT>"}}；JWT 的 sub=guest:<uuid>，exp-iat=2700 秒（45 分钟）

4) Centrifugo WebSocket
   → {"id":1,"connect":{"token":"<JWT>","name":"js","version":"5.0.0"}}
   ← {"id":1,"connect":{"client":"...","version":"6.9.7 PRO","expires":true,"ttl":2700,"ping":25,"pong":true}}
   → {"id":2,"subscribe":{"channel":"chatrooms.<chatroomId>.v2"}}   ← {"id":2,"subscribe":{}}
   → 其余四条 feed（见 §4.1）
   服务端每 25 秒发一行 "{}"；客户端回 "{}"（pong）。

5) 消息
   {"push":{"channel":"chatrooms.<id>.v2",
            "pub":{"data":{"event":"App\\Events\\ChatMessageEvent",
                           "data":"{\"id\":\"<uuid>\",\"content\":\"...\", ...}"}}}}
```

### 4.1 五条 feed（kicksdk 文档与本次实测一致）

Kick 前端为同一个聊天加入五条 feed；只订阅 `chatrooms.<id>.v2` 会**静默漏掉**礼物与订阅：

| feed | 内容 |
| --- | --- |
| `chatrooms.<id>.v2` | 聊天、删除、封禁、订阅、清屏、Pin、投票、Host 进入 |
| `chatrooms.<id>` | Host 进入（另一种 shape，与上行重复计数） |
| `chatroom_<id>` | 赠送订阅、频道积分兑换（事件名**无** `App\Events\` 前缀） |
| `channel.<channelId>` | 开播/下播、Host 离开 |
| `channel_<channelId>` | KICKs 礼物（无前缀） |

骨架已订阅全部五条；`chatrooms.<id>.v2` 是唯一必需订阅，其余失败只记录、不阻断聊天。

### 4.2 两个重要实测发现

1. **HTTP/1.1 会被 WAF 拒绝，HTTP/2 正常。**
   同一公开 URL，Node `fetch`（HTTP/1.1，Chrome UA）返回
   `403 {"error":"Request blocked by security policy."}`；用 `node:http2` 请求
   （同样的浏览器头、无 Cookie、无账号）返回 `200` 与完整 JSON。因此 `src/platforms/kick/http.mjs`
   固定使用 HTTP/2。这不是绕过：访问的是任意访客都能打开的公开页面/接口，且被真正拒绝时
   会以 `KICK_BLOCKED` 失败，不做重试花招。
   > 与 `kicksdk` 记录的「非浏览器 + 完整 Chrome UA 会被拒绝、`Mozilla/5.0` 反而通过」互为印证：
   > 这是请求指纹层面的 WAF 行为，不是权限控制。

2. **Node 内置 WebSocket 不发送 `Origin`，Kick 当前接受。**
   本地握手抓包确认只发送 `user-agent: node` 等头，没有 `Origin`；真实连接成功。
   `kicksdk` 文档称 Origin 必须是 `https://kick.com`，与「浏览器页面」场景一致；
   对无 Origin 的服务端客户端 Kick 目前放行。**这是 G2 风险**：若 Kick 收紧，
   内置 WebSocket 无法设置该头，需要自研最小 WS 客户端（仍为零依赖）。

### 4.3 与 Pusher 旧路径的关系

- `web.kick.com` 的 connection 接口在请求中同时声明 `pusher` 与 `centrifugo`，
  **只返回 `centrifugo`**（多次请求一致）。
- `kicksdk` 记录 Pusher app key `32cbd69e4b950bf97679` 自 2026-10-13 起全部集群报
  `4001 App key not in this cluster`。本轮**没有**使用任何硬编码 Pusher key，
  骨架在只拿到 pusher 时以 `KICK_PROTOCOL` 失败，不静默降级。

---

## 5. 真实采集结果

16.1 分钟、两个真实在播房间、同一进程内两个独立 adapter/socket：

| 指标 | odablock | gmhikaru |
| --- | --- | --- |
| 频道 / chatroom | `2401072` / `2393554` | `1770127` / `1762730` |
| 采集时长 | 966 s | 966 s |
| 真实聊天条数 | **1,604**（99.7 条/分） | **332**（20.6 条/分） |
| 独立稳定用户 ID | **391** | **113** |
| `sender.id` 覆盖率 | **100%** | **100%** |
| 消息 `id` 覆盖率 | **100%** | **100%** |
| `created_at` 覆盖率 | **100%** | **100%** |
| `created_at` 格式 | ISO-8601 带 `+00:00` | 同左 |
| 含 Emote 标记的消息 | 48.82%（783 条） | 13.25%（44 条） |
| 唯一 Emote 数 / 出现次数 | 135 / 1,207 | 34 / 52 |
| `reply` 消息 | 1.56%（25 条） | 19.88%（66 条） |
| 重复消息 ID | **0** | **0** |
| 跨房间串台 | **0** | **0** |
| 非聊天事件 | 封禁 2、删除 2 | 封禁 3、解封 1、删除 3 |
| 重连次数 | 1（强制断开测试） | 0 |

原始 payload 的字段集合（两个房间一致）：
`id, chatroom_id, content, type, created_at, sender{id,username,slug,identity{badges,badges_v2}}, metadata, thread_parent_id`。
字段缺失率 **0%**；没有出现「用接收时间冒充原始时间」的情况（`assumedUtcCount=0`）。

### 5.1 附加运行：五条 feed 的事件发现（10 分钟）

首次运行时只订阅了 `chatrooms.<id>.v2` 与 `channel.<id>`，订阅/礼物事件必然收不到。
补齐**五条 feed** 后在 odablock + nelkboys 重跑 10 分钟（第 180 秒强制断开 nelkboys）：

| 指标 | odablock | nelkboys |
| --- | --- | --- |
| 聊天 | 987（97.9/分） | 117（11.6/分） |
| 稳定 ID / 消息 ID / 时间 | 100% / 100% / 100% | 100% / 100% / 100% |
| Emote / reply | 44.68%（441）/ 1.62%（16） | 15.38%（18）/ 9.4%（11） |
| 唯一 Emote / 出现次数 | 111 / 567 | 16 / 26 |
| 非聊天事件 | 赠送订阅 **1**、礼物榜更新 1、Pin 2、取消 Pin 1、封禁 1 | **KICKs 礼物 1**、KICKs 榜更新 1、删除 2 |
| 重连 | 0 | 1（5.3 秒恢复，空档 4.54 秒） |

**真实观测到的两个付费事件形状**（只记录字段，不在仓库保存用户数据）：

- `KicksGifted`（`channel_<channelId>`）：
  `gift_transaction_id`（UUID）、`message`（可为空）、
  `sender{id, username, username_color, profile_picture}`、
  `gift{gift_id, name, amount, type, tier, character_limit, pinned_time}`、`created_at`。
  该样本 `amount=100`、`type/tier=BASIC`；**Kick 未给出法币币种**，只能记为 KICKs 数量，
  不得换算收入。`sender.id` 有稳定用户 ID。
- `GiftedSubscriptionsEvent`（`chatroom_<chatroomId>`）：
  `chatroom_id`、`correlation_id`、`gifter_username`、`gifted_usernames[]`、
  `gifted_total`、`gifter_total`、`chunk_details`。
  **只有用户名，没有赠送者/接收者的稳定 ID**；因此赠送订阅**不能**建立可靠画像身份，
  G2 只能作为「无稳定身份的事件」保存，或标 `source_quality=unknown`。
- 榜单事件 `GiftsLeaderboardUpdated` / `KicksLeaderboardUpdated` 也出现在 feed 中，
  但包含大量用户的聚合排行数据；**本 PoC 与后续正式适配器都不消费它**
  （与 LiveMemory 的观众记忆无关，且属于批量个人数据）。

`created_at` 精度不一致：聊天是 `+00:00`、秒精度；KICKs 是 `Z`、9 位小数秒。
两者都能转成 epoch 毫秒，但只保留到毫秒（纳秒部分被截断），文档必须如实说明。

### 5.2 Emote

- 原文形如 `[emote:5216699:gregYikes]`，`content` **原样保存**，同时解析为
  `{id, name, source:'kick'}` 写入 `emotes`；同一条消息内重复的同一 Emote 在元数据中去重，
  原文中的重复次数不变。
- 两轮共 3,040 条真实消息中，1,286 条含 Emote 标记并全部解析成功（`emoteParseFailures=0`）；
  第一轮 1,936 条中为 827 条，第二轮 1,104 条中为 459 条。
- 不下载、不缓存图片；不猜测 Emote 含义。

---

## 6. 身份证据（重点）

| 问题 | 实测结论 |
| --- | --- |
| 同一观众多条消息是否使用相同 ID | ✅ 是。1,604 条来自 391 个 ID；最高频用户 70 条，ID 不变 |
| 用户改名是否影响身份 | ✅ 身份是 `sender.id`（数值用户 ID），与 `username`/`slug` 无关；本轮样本内没有观察到同名不同 ID（`nameCollisions=0`）或同 ID 不同名（`renameCandidates=0`） |
| 用户名是否可能重复 | 可能（Kick 只保证 slug 唯一），因此**不把昵称当身份**；同名不同 ID 的合并测试见 `tests/integration/kick-ingest.test.mjs` |
| 不同直播间的同一观众能否关联 | ✅ 能。证据中出现 **1 个跨房间稳定 ID**（同一 `sender.id` 在 odablock 与 gmhikaru 各发言；同一 `username`），说明 `kick:<sender.id>` 可作为全局身份 |
| 消息 ID 是否真正唯一 | ✅ 本轮 1,936 条消息 ID 全部唯一；重连前后无重复；平台给出的是 UUID |
| 缺失用户 ID 时如何降级 | 该消息仍保存（`viewer_uid=NULL`、`source_quality=unknown`、不建档案），不伪造 ID、不按昵称合并（有单测） |
| 是否会把不同观众错误合并 | 不会：`buildViewerId` 只接受非空、非 `0` 的平台 ID；同名不同 ID 分属两个档案 |

补充事实：`sender.id` 是**用户 ID**，与 channel id / chatroom id 不是同一命名空间
（`kicksdk` 文档同样区分 user/channel/chatroom 三类 id）；本骨架只把 `sender.id` 用作观众身份。

---

## 7. 多房间、隔离与停止

- 两个房间各自一个 `KickAdapter` + 一个 WebSocket + 一个 session 闭包；没有全局 socket、
  没有「当前房间」单例。
- 隔离验证：每个 adapter 只接受 `chatrooms.<自己 chatroomId>.v2` 的聊天；
  跨房间消息计数 **0**；另外在单测中人为投递其他 chatroom 的 publication，被 `crossRoomIgnored` 计数并丢弃。
- 主动停止：`stop()` 关闭 socket、清空重连/刷新定时器、状态 `stopped`；
  之后的 `close` 事件不再触发重连（单测断言 socket 实例数不增加）。
- 停止后迟到的回调不会写入已结束的 session（集成测试覆盖）。

---

## 8. 断线重连（实测 + 自动化）

| 场景 | 结果 |
| --- | --- |
| 强制断开（客户端 `close(4000,'test_drop')`，模拟传输中断） | 状态 `reconnecting` → 重新解析房间 → 重新申请 guest token/连接配置 → `connected`；**5.7 秒**恢复（含 1.08 秒退避），区间空档 5.338 秒 |
| 重连期间消息 | 通道**没有续传游标**，空档内发布的消息会丢失；必须标注「重连期间可能漏消息」 |
| 重复消息 | 重连后没有出现重复行：平台消息 ID 作为 `external_id`，`UNIQUE(session_id, dedupe_key)` 兜底 |
| guest token 到期 | 代码路径：服务端 `disconnect 109` / `error 109/3500` → 立即用新 token 重连（单测覆盖）；另在 TTL 前 90 秒主动重连，不依赖服务端拒绝 |
| 45 分钟真实到期 | **未等待验证**（G2 用长测补齐）；当前证据是「提前刷新」+「109 处理」两条路径的单测 |
| 退避 | 1s→2s→4s…上限 30s，带随机抖动；连续失败 12 次进入 `failed` 并停止，不会无限高频重试（单测覆盖） |
| 房间中途下播 | 重连前重新查询 `livestream`；连续 2 次确认离线后停止并上报 `platform_ended` |
| 主动停止 vs 断线 | 主动停止不重连；只有非主动关闭才进入重连 |
| 资源释放 | 停止后 socket 关闭、HTTP 客户端关闭、定时器清空；PoC 退出后无残留句柄 |

---

## 9. 事件能力矩阵

标注口径见 `docs/PLATFORM_ADMISSION.md` §5。**本轮只映射聊天**；其余事件仅做「是否真的收到」的观测。

| 事件 | 级别 | 说明 |
| --- | --- | --- |
| 普通聊天 | **VERIFIED** | 两轮共 **3,040** 条真实消息（1,936 + 1,104） |
| Emote | **VERIFIED** | 两轮共 **1,286** 条含标记消息全部解析（827 + 459） |
| 回复（reply） | **VERIFIED** | 两轮共 **118** 条；保留 `thread_parent_id`/原消息 ID 作为诊断字段 |
| 封禁 / 超时 | **VERIFIED** | 两轮共观测 6 条 `UserBannedEvent`（未映射为产品事件） |
| 解除封禁 | **VERIFIED** | 观测 1 条 `UserUnbannedEvent` |
| 消息删除 | **VERIFIED** | 两轮共观测 7 条 `MessageDeletedEvent` |
| Pin / 取消 Pin | **VERIFIED** | 三轮共观测 `PinnedMessageCreatedEvent` 3 条、`PinnedMessageDeletedEvent` 2 条 |
| 订阅 / 续订 | **NOT-OBSERVED** | 已订阅承载 feed（`chatrooms.<id>.v2`）；两轮共 26 分钟未出现 `SubscriptionEvent`；形状来自官方文档与 kicksdk 记录（UNOFFICIAL） |
| 赠送订阅 | **VERIFIED（1 条，5 个接收者）** | `chatroom_<id>` 的 `GiftedSubscriptionsEvent`；**只有 `gifter_username` / `gifted_usernames[]`，没有稳定 ID** → 不能建立可靠画像，G2 只能作为无稳定身份事件 |
| KICKs 礼物 | **VERIFIED（1 条）** | `channel_<id>` 的 `KicksGifted`；`gift_transaction_id` + `sender.id`（稳定）+ `gift{gift_id,name,amount,type,tier}`；`amount=100` 是 KICKs 数量，**无法币币种，不换算收入** |
| 开播 / 下播 | **DOCUMENTED** | `channel.<id>` 的 `StreamerIsLive` / `StopStreamBroadcast`；本轮未观测 |
| Raid / Host | **DOCUMENTED** | `StreamHostEvent`（`chatrooms.<id>.v2`）与 `ChatMoveToSupportedChannelEvent`（`channel.<id>`）；本轮未观测 |
| 投票 | **DOCUMENTED** | `PollUpdateEvent` / `PollDeleteEvent`；本轮未观测 |
| 礼物榜 / KICKs 榜 | **VERIFIED（观测到，但刻意不消费）** | `GiftsLeaderboardUpdated` / `KicksLeaderboardUpdated`；含大量用户聚合排行，与观众记忆无关，正式适配器不保存 |
| 关注 | **UNSUPPORTED（本地形态）** | 只在官方 webhook `channel.followed` 出现；webhook 需要公网接收端，不符合本地 EXE 形态 |
| 聊天历史 / 回放 | **UNSUPPORTED（产品禁止）** | 存在历史端点但 `AGENTS.md` §6.11 禁止抓取；本轮未调用 |

> 不得因为「解析代码存在」就宣称支持礼物/订阅。本轮真实观测到的只有上表标 VERIFIED 的项。

---

## 10. 官方 API 是否适合本地实时采集

**不适合作为默认采集路径**，理由均为本轮或近期实测/官方文档：

| 能力 | 结论 | 证据 |
| --- | --- | --- |
| 读聊天（实时/历史） | **没有** | 官方 scope 列表无 `chat:read`（只有 `chat:write`）；Swagger 无读聊天端点 |
| `chat:write` | 是「发消息」不是「读消息」 | 官方文档；不得混用 |
| `events:subscribe` | **webhook**，需要公网可访问接收端 | 本地 EXE 无法成为 webhook 接收方 |
| 公开数据读取 | 需要 app/user token | 本轮 `GET https://api.kick.com/public/v1/channels?slug=xqc` → **401 Unauthorized**（无 app token） |
| 订阅/赠订/KICKs | 官方 webhook 可提供，但同样需要公网接收端 | `channel.subscription.new/renewal/gifts`、`kicks.gifted` |

结论：官方 API 可以作为 G2 之后**可选增强**（用户自备 app 时读取频道元数据/订阅总量），
但**不能**作为聊天采集的必要条件；默认路径继续使用免登录 Centrifugo 通道。

---

## 11. 开源许可证、依赖与第三方记录

| 项目 | 许可证 | 使用方式 | 结论 |
| --- | --- | --- | --- |
| [`achrafthedev/kixo`](https://github.com/achrafthedev/kixo) | **MIT** | 只读源码核对协议（2026-10-25 最后推送；`src/renderer/src/lib/realtime.js`） | 兼容；**未复制代码**；已在 `THIRD_PARTY_NOTICES.md` 记录协议参考 |
| [`AnisAbdellatif/kicksdk`](https://github.com/AnisAbdellatif/kicksdk) | **MIT OR Apache-2.0**（双许可） | 只读 `docs/KICK.md` 交叉验证事件、五条 feed、token/重连语义（2026-11-15 推送） | 兼容；未引入其 Rust/WASM 包，未复制代码 |
| `LOX-X/Kick-Live-Connector` | MIT | 仅作旧字段参考 | 2024-11 停更，不作为协议依据 |
| 运行时依赖 | — | `node:http2` / `node:zlib` / 内置 WebSocket | **新增 0 个 npm 依赖** |

kixo 的登录/角色管理走它自己的托管 `auth-proxy`；LiveMemory **不使用**该代理，
也不需要它——聊天读取本身只用匿名 guest token。这一点是本轮与 kixo 的关键差异。

---

## 12. 正式适配器架构建议（G2）

现有五平台的结构（`src/platforms/<platform>/link|client|messages|adapter|service|errors` +
`shared/ingest` + `SessionManager`）可以直接套用，Kick 不需要例外：

| 关注点 | 方案 |
| --- | --- |
| 平台标识 | `kick` |
| URL 解析 | `kick.com/<slug>`、`/chat`、裸 slug；拒绝 `/video`、`/category`、`/clips`、`/search` 等 |
| 房间标识 | `platform_room_id = channelId`（稳定，不随 slug 改名）；chatroomId 放 `meta` |
| 观众 ID | `kick:<sender.id>`；缺 ID 的消息 `viewer_uid=NULL`、`source_quality=unknown`、不建档案 |
| 消息 ID | `external_id = message.id`（UUID）；去重 `UNIQUE(session_id, dedupe_key)`，缺失时用内容+用户+时间指纹并记录风险 |
| 事件标准化 | 本轮只 `chat`；G2 先映射订阅/赠订/KICKs/上下播，再决定 `gift`/`membership`/`system` 的 canonical 形状与 `value_kind` |
| 聊天文本 | `content` 原文永不变；Emote 只写元数据 |
| 订阅与礼物 | 金额未知时 `amount_minor=null`、`value_kind=unknown`；KICKs 的 `amount` 是 KICKs 数量，不是法币；赠订事件只有用户名 → 不能建稳定身份，只能记 `source_quality=unknown` 的事件或不入库；不换算收入、不猜币种 |
| 连接状态 | `connecting/connected/reconnecting/failed/stopped`；连接成功但长时间无消息时 UI 用 `waiting_events` 类语义（参考 TikTok） |
| 断线重连 | 指数退避 1–30s + 抖动；token 提前 90s 刷新；`109/3500` 立即换 token；连续失败上限；无续传 → UI/文档标注「可能漏消息」 |
| 多直播间隔离 | 每房间独立 adapter/socket/session；同 `platform+room` 拒绝重复启动；跨 feed 事件按 chatroom 校验 |
| 历史记录 | 只存 canonical 事件；原始 payload 不长期入库（隐私最小化），研究证据只落 `tests/.tmp` |
| 长期画像 | 使用稳定 ID 跨场次聚合；昵称只用于展示 |
| AI 分析 | 平台无关：Kick 事件进入现有事件模型后即可被现有分析/画像使用，不需要新提示词 |
| 十语言界面 | G2 一次性新增 `common.platform.kick`、`live.source.kick`、`errors.kick*` 到十份字典（键集/占位符一致），并同步备份白名单（如涉及设置键） |

G2 还需要新增（本轮刻意未做）：

1. `src/platforms/kick/service.mjs` 与 `src/server/routes.mjs` 的连接/检查/停止路由；
2. `/api/bootstrap` 的 `capabilities.platforms` 条目（真实标记 `requiresLogin:false`、`unofficial:true`、
   `events:['chat']`，礼物未验证前不得声明）；
3. `src/monitoring/constants.mjs` 的平台常量与开播检测（若支持）；
4. 十语言字典与 UI 的 Kick 卡片；
5. `scripts/build-windows.mjs` 的 `REQUIRED_MODULES`；
6. `scripts/verify-kick-exe.mjs`（G5 真实 EXE 验收）。

---

## 13. 风险与仍未解决的问题

| 风险 | 现状 | 缓解 / 下一步 |
| --- | --- | --- |
| 非官方协议随时可能变化 | 2026 年已从 Pusher 迁到 Centrifugo（kixo/kicksdk 与本轮均确认） | 传输层抽象；失败显式报错；每次 G 阶段重跑真实连接 |
| HTTP/2 依赖 | HTTP/1.1 被 WAF 403，本轮用 HTTP/2 成功 | 若 Kick 也封 HTTP/2，则如实失败（`KICK_BLOCKED`），不做规避 |
| WebSocket `Origin` | Node 内置客户端不发 Origin，当前被接受 | 若平台收紧 → 自研最小 WS 客户端（零依赖） |
| guest token 45 分钟 | 提前 90 秒主动刷新；`109` 处理有单测；**未真实等到 45 分钟** | G2 长测 ≥60 分钟，记录刷新次数与空档 |
| 无续传 | 重连期间可能漏消息 | 文档与 UI 标注；不声称完整 |
| 礼物/订阅样本不足 | 订阅/续订 `NOT-OBSERVED`；赠订 1 条、KICKs 1 条 | G2 在有人送礼/订阅的时段重跑；赠订无稳定 ID、KICKs 无法币金额，映射前必须定清语义 |
| 限流形态未知 | 未遇到 429 | G2 记录 429/拒绝形态，退避处理 |
| 聊天内容隐私 | 研究证据只落 `tests/.tmp`，未提交 | 正式接入沿用 30 天保留与脱敏规则 |
| 单一参考实现 | kixo 为个人项目 | 已用 kicksdk（更新、更完整）交叉验证；协议事实以真实连接为准 |

---

## 14. 下一阶段（G2）计划

1. **长约与 token**：单房间 ≥60 分钟，记录 token 刷新次数、空档、消息速率；
   模拟一次 45 分钟到期（可通过缩短 TTL 的测试注入或等待）并记录恢复。
2. **事件补齐**：在有订阅/送礼的时段抓真实 `SubscriptionEvent`、`GiftedSubscriptionsEvent`、
   `KicksGifted`，逐一记录字段与缺失率；礼物金额/币种不可得就保持 `unknown`。
3. **身份深挖**：跟踪同一 ID 改名（跨场次）、同名不同 ID、匿名/隐藏身份样本，给出比例。
4. **接入产品**：service/routes/capabilities/十语言/监控/保留/UI。
5. **G4/G5**：断线与多房间自动化 + `verify-kick-exe.mjs` 真实 EXE 验收。
6. **合并判断（G6）**：三个准入条件 + 证据齐备后才允许在 README/UI 写「支持 Kick」。

---

## 15. 复现命令

```bat
:: 真实采集（两个房间，16 分钟，第 300 秒强制断开 odablock）
node scripts/kick-poc.mjs --rooms https://kick.com/odablock,gmhikaru ^
  --minutes 16 --drop-at 300 --drop-room odablock --out tests/.tmp/kick-g1-run

:: 证据分析（身份、字段、唯一性、跨房间）
node scripts/kick-g1-analyze.mjs --dir tests/.tmp/kick-g1-run

:: 自动化测试（离线，不访问 Kick）
node --test --test-isolation=none tests/unit/kick-*.test.mjs tests/integration/kick-ingest.test.mjs
```

> PoC 会写入 `tests/.tmp/`，不写数据库、不写 `%LOCALAPPDATA%`。测试全部使用 fake HTTP/WebSocket，
> 与真实采集严格区分。

---

## 16. 本轮未做

- 未新增产品路由、界面、平台卡片或十语言文案；界面上**看不到 Kick**。
- 未修改五个现有平台的采集协议、金额/身份/去重规则、数据库 Schema。
- 未构建 EXE、未跑 G5、未合并 `main`、未 Push/Tag/Release。
- 未提交任何真实聊天内容、用户名、用户 ID 或 token；证据只在 gitignored 目录。
