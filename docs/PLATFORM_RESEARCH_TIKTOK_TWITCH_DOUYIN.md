# TikTok / Twitch / 抖音直播接入技术研究报告

日期：2026-11-15（Asia/Shanghai）
范围：只做调查、静态核对与只读真实探测；**没有修改正式业务代码、数据库、AI、备份或 Bilibili/YouTube 采集**。
结论状态：Twitch 可以进入正式开发；抖音需要先决定登录 Cookie 与 AGPL 策略；TikTok 当前不适合作为免费、本地优先的默认能力。

> 本报告严格区分「官方文档」「源码静态」「README 声称」「本地 Mock」「真实直播实测」「尚未验证」。
> 文中所有「实测」均指 2026-11-15 本轮在公开直播间进行的只读探测；没有购买礼物、订阅、打赏或产生任何实际支出。

---

## 0. 结论先行

### 0.1 三平台一句话结论

| 平台 | 结论 | 主要原因 |
| --- | --- | --- |
| **Twitch** | **推荐第一个正式开发** | 匿名公开 IRC 实测可用；昵称、稳定 User ID、消息 ID 100%（本轮样本）；订阅/续订/赠订 USERNOTICE 实测可达；零运行时依赖、可用内置 WebSocket、最符合 Node SEA 与本地优先 |
| **抖音** | **可以作为第二个平台，但必须先做产品/许可证决策** | 匿名公开 WSS 实测可取得弹幕、昵称、稳定 UID、进场/点赞/关注；**礼物自 2026 年起只推给登录会话**；本地签名脚本为 AGPL-3.0；逆向协议有风控与条款风险 |
| **TikTok** | **暂缓，不建议现在承诺** | 官方没有公开 LIVE 聊天/礼物 API；TikTok-Live-Connector 当前签名依赖 Euler Stream，实测签名端点要求 **Business 计划（$50/月起）**；库为 AGPL-3.0、约 60 个 npm 包；公开 Issue 报告漏消息；本机访问 TikTok 页面被 WAF 挑战阻断 |

### 0.2 推荐顺序

1. **Twitch**（现在做）
2. **抖音**（Twitch 完成后，先弹幕/身份，礼物单独评审）
3. **TikTok**（等免费/可自托管的签名路径或官方合作通道；否则只做“用户自备 Euler Business Key”的实验能力）

### 0.3 三个必须说清楚的边界

1. **抖音匿名能看弹幕，但匿名看不到礼物。** 这不是解析缺陷，是平台策略；不能把“匿名连接成功”写成“礼物已支持”。
2. **TikTok 的“免费额度”不等于“免费可用”。** Euler 免费 Community 计划有 1,500 请求/日、100 房间/日、25 并发 WebSocket，但实际签名端点要求 Business；本轮真实连接被 `PremiumFeatureError` / “requires a Business plan” 阻断。
3. **Twitch 匿名 IRC 不是官方承诺的公开 API。** 官方文档要求 User Access Token；匿名 `justinfan` 是可用的历史行为，但未在文档中保证，可能被限流或关闭。正式实现必须有明确的失败提示与官方 EventSub 备选设计。

---

## 1. 方法、证据等级与环境

### 1.1 证据等级

| 等级 | 含义 | 本报告用法 |
| --- | --- | --- |
| **E1 官方文档** | 平台开发者文档、官方条款、官方 API Reference | 只证明“文档这样写”，不证明普通用户一定能用 |
| **E2 源码静态** | 读取开源仓库源码/类型/构建配置，未运行 | 证明实现方式与依赖，不证明当前线上可用 |
| **E3 README 声称** | 项目 README/Release Notes/Issue 的说法 | 只作为线索，必须与 E1/E2/E5 交叉 |
| **E4 本地 Mock/单元** | 用假服务、假帧、合成数据验证 | 证明本地逻辑，不证明真实平台 |
| **E5 真实直播实测** | 对公开直播间做只读连接并统计字段 | 本轮最高证据；仍受时间窗口、地区、账号状态限制 |
| **E6 尚未验证** | 没有足够证据 | 不得写成“已支持” |

### 1.2 本轮环境与限制

- Windows，Node.js `v24.21.0`（DSH 自带运行时；项目要求 ≥22.5 的内置 `node:sqlite` 不受影响）。
- 时间：2026-11-15 10:10–10:45（Asia/Shanghai）。
- 网络：可访问 Twitch、TikTok、抖音、GitHub、npm；PowerShell 的旧 TLS 栈访问失败，改用 Node `fetch`/WebSocket。
- 只读：未登录 Twitch/TikTok/抖音账号；未提供 Cookie；未购买/赠送任何礼物；未保存或展示聊天正文；只统计字段与数量。
- 未绕过：TikTok 页面返回 WAF 挑战时停止，没有执行挑战脚本、没有使用验证码服务、没有伪造 Cookie。
- 临时验证目录均已删除；没有写入 `%LOCALAPPDATA%\LiveMemory` 或正式数据库。

### 1.3 真实探测摘要

| 探测 | 对象 | 结果 | 证据 |
| --- | --- | --- | --- |
| Twitch 匿名 IRC | `xqc`、`shroud`、`sodapoppin`、`moonmoon`、`ludwig` | 40–45 秒内 **644 条 PRIVMSG**；644/644 带 `user-id`、`display-name`、`id`；3 条 USERNOTICE（resub/viewermilestone） | E5 |
| Twitch 标签/表情 | 5 个公开频道 | 239 条消息中 8 条非 ASCII、9 条带 `emotes` 标签；0 重复 `id` | E5 |
| Twitch 房间 ID | `#xqc` | `ROOMSTATE ... room-id=71092938` | E5 |
| Twitch EventSub | `wss://eventsub.wss.twitch.tv/ws` | 收到 `session_welcome`，keepalive=10s；无 Token 创建订阅返回 **401 OAuth token is missing** | E5 |
| 抖音匿名 WSS | `live.douyin.com/708764876300`（东方甄选） | 连接成功并 `live`；约 7 秒 175 条消息；45 秒窗口 16 chat / 192 member / 25 like / 3 follow / 8 room / **0 gift** | E5 |
| 抖音身份 | 同一房间 30 秒 | 13 条 chat：13/13 有 `user.id`、昵称、`secUid`、消息 ID；13/13 含 CJK；0 重复消息 ID | E5 |
| 抖音房间状态 | `live.douyin.com` 多个房间 | 直播房间 `room.status=2`；已结束房间 `status=4`；公开页面无需登录 | E5 |
| TikTok 连接 | `pollofrito1985`（Euler 排行榜标记 LIVE） | TTLC 2.5.0 / 2.4.4 均失败：`SignatureMissingTokensError`，`fetchWebcastSignatureFromEulerRoute` 返回“This endpoint requires a Business plan” | E5（失败证据） |
| TikTok 旧版 | TTLC 1.2.3（本地内置签名） | 签名请求 5 秒超时；无事件；库已落后多年 | E5（失败证据） |
| TikTok 页面 | `tiktok.com/@.../live` | 返回 WAF “Please wait...” 挑战页；未绕过 | E5（阻断证据） |

---

## 2. A. 三平台核心能力矩阵

> 图例：**完整支持** = 本轮有字段/事件实测，且未发现平台侧硬限制；**部分支持** = 能力存在但受登录、权限、付费服务或字段缺失限制；**不支持** = 官方/当前可行路径不提供；**尚未验证** = 没有足够真实证据。
> 每个格子后的编号对应 §2.1 脚注。

| 能力 | TikTok | Twitch | 抖音 |
| --- | --- | --- | --- |
| 观众昵称 | 尚未验证¹ | **完整支持**² | **完整支持**³ |
| 稳定用户 ID | 尚未验证¹ | **完整支持**² | **完整支持**³ |
| 实时弹幕原文 | 尚未验证¹ | **完整支持**⁴ | **完整支持**³ |
| 礼物 / 打赏 | 尚未验证¹ | 部分支持⁵ | 部分支持⁶ |
| 付费附带留言 | 尚未验证¹ | 部分支持⁷ | 尚未验证⁸ |
| 礼物金额或价值 | 尚未验证¹ | 部分支持⁹ | 尚未验证¹⁰ |
| 免登录 | 尚未验证¹ | **完整支持**¹¹ | 部分支持¹² |
| 免费使用 | **不支持**¹³ | **完整支持**¹⁴ | **完整支持**¹⁵ |
| 无第三方服务依赖 | **不支持**¹³ | **完整支持**¹⁶ | **完整支持**¹⁷ |
| 自动开播监听 | 尚未验证¹⁸ | **完整支持**¹⁹ | **完整支持**²⁰ |
| 断线重连 | 尚未验证²¹ | 部分支持²² | 部分支持²³ |
| Node SEA 兼容 | **不支持**²⁴ | 部分支持²⁵ | 部分支持²⁶ |

### 2.1 矩阵脚注

1. **TikTok**：TTLC 的类型与文档声明支持 chat/gift/userId/uniqueId/roomId/repeatEnd，但本轮真实连接在签名阶段被 Euler Business 计划阻断，未取得任何真实事件；因此不能写“完整支持”。TikTok 官方公开产品页没有 LIVE 聊天/礼物 API（E1/E2/E5）。
2. **Twitch 昵称/稳定 ID**：匿名 IRC 5 频道 644 条 PRIVMSG，644/644 有 `user-id` 与 `display-name`；`user-id` 是稳定 Twitch User ID，昵称/`login` 可改。E5。
3. **抖音昵称/ID/原文**：dyhub lightweight 匿名连接真实房间；13/13 chat 有 `user.id`、昵称、`secUid`、消息 ID；13/13 含 CJK；未保存正文。E5。
4. **Twitch 弹幕原文**：IRC `PRIVMSG` 文本原样取得；239 条样本含非 ASCII 8 条、`emotes` 标签 9 条；未与 Twitch 网页逐条比对，不能证明“零漏消息”。E5。
5. **Twitch 礼物/打赏**：订阅/续订 USERNOTICE 与赠订（`subgift`/`submysterygift`）在本轮较早样本中出现；Bits 的 `bits` 标签在文档中存在，但本轮三次探测均未观测到真实 Bits 事件。因此“部分支持”，Bits 仍需专门验收。E1/E5。
6. **抖音礼物**：源码/README 明确“2026 年起只把 `WebcastGiftMessage` 推给已登录会话”；匿名 45 秒 0 gift。没有登录 Cookie，不能验证礼物字段与连送。E2/E3/E5。
7. **Twitch 付费留言**：`USERNOTICE` 带 `system-msg` 与消息体；续订/订阅可带留言，Cheer 消息本身也可带文本。本轮只确认 `system-msg` 与字段存在，未逐条核对留言正文。E1/E5。
8. **抖音付费留言**：本轮未取得礼物事件，也没有观察到礼物消息中的独立留言字段；不能假设存在。E6。
9. **Twitch 金额**：Bits 有数量，订阅有 Tier（1000/2000/3000/Prime），但 Twitch 不提供美元/本币金额；价格随国家、平台（Web/iOS/Android）、税费、促销变化。只能记数量/档位，`amount_minor=null`、`value_kind=unknown`，不得换算。E1/E2。
10. **抖音金额**：源码有 `diamondCount`/`repeatCount` 等展示价值字段，但需要登录态且本轮未取得礼物；钻石不是人民币，不能当主播收入。E2/E6。
11. **Twitch 免登录**：匿名 IRC 实测可读公开聊天、订阅/续订通知；官方文档要求 User Access Token，匿名路径是未文档化行为。E1/E5。
12. **抖音免登录**：匿名可读弹幕、进场、点赞、关注、房间统计；礼物需要登录 Cookie。E5/E2。
13. **TikTok 免费/无第三方服务**：Euler Stream 定价页 Community $0（1,500 请求/日、100 房间/日、25 并发 WS），但签名端点要求 Business；Business 10K 为 $50/月。真实错误见 §6.3。TikTok 官方合作/审核通道可能不收费，但不对普通用户开放，且本轮未验证。E1/E5。
14. **Twitch 免费**：公开 IRC/EventSub 读取不收费；官方 EventSub 需注册应用与 OAuth，但不收取 API 费用。E1/E5。
15. **抖音免费**：dyhub/本地签名方案无付费 API；但使用第三方 AGPL 签名脚本，且协议逆向有风险。E2/E5。
16. **Twitch 无第三方服务**：可直接连 `wss://irc-ws.chat.twitch.tv:443` 或 `wss://eventsub.wss.twitch.tv/ws`，不依赖采集服务。E5。
17. **抖音无第三方服务**：本地生成 `a_bogus`/`signature`，不依赖云端采集服务；但依赖本地第三方脚本。E2/E5。
18. **TikTok 自动开播**：TTLC 有 `connect()`/`UserOfflineError`/`streamEnd`，但本轮没有成功连接；页面又被 WAF 挑战。E2/E6。
19. **Twitch 自动开播**：公开频道页 `isLiveBroadcast:true/false` 实测可判定；24 个频道扫描出 8 个 LIVE。E5。
20. **抖音自动开播**：公开直播间页 `room.status=2`（直播）/`4`（结束）实测；可轮询。E5。
21. **TikTok 重连**：库内有重连/状态机，但本轮没有成功连接，不能验证。E2/E6。
22. **Twitch 重连**：IRC 有 `PING`/`RECONNECT` 与消息 ID，可设计指数退避；本轮只验证连接与读取，未做真实断网恢复。E1/E5。
23. **抖音重连**：dyhub 有 5 秒心跳、ack、重连；本轮未做真实断网恢复。E2/E5。
24. **TikTok SEA**：TTLC 2.5.0 运行依赖约 60 个 npm 包（`got`、`ws`、protobuf、Euler SDK 等），AGPL-3.0；与“零运行时依赖/单 EXE”冲突，未验证可打包。E2。
25. **Twitch SEA**：只需内置 `WebSocket`/`fetch` 与自有解析器，零新增依赖；尚未把新平台模块加入 SEA 构建并实测。E2/E6。
26. **抖音 SEA**：需要 protobufjs、pako、485 KB 签名 JS 与 `vm` 加载；可嵌入但不再是零依赖，且 AGPL 脚本影响分发；未验证。E2。

---

## 3. C. 三项核心需求的实际可达程度

### 3.1 P0-1 观众昵称与身份

| 问题 | TikTok | Twitch | 抖音 |
| --- | --- | --- | --- |
| 每条聊天能取昵称？ | 文档/类型声明可以；**未实测** | **能**，644/644 | **能**，13/13 |
| 每个礼物能取支持者昵称？ | 文档/类型声明可以；**未实测** | 能（订阅/赠订 USERNOTICE 带 display-name） | 需登录；**未实测** |
| 跨场次稳定 ID？ | `userId`/`secUid`（未实测） | **`user-id`**（Twitch User ID） | **`user.id` + `secUid`**（实测） |
| 改名后还能识别？ | 设计上可以，未实测 | 可以，`user-id` 不变；昵称/`login` 可能变 | 可以，`user.id` 不变；昵称可变（需昵称历史） |
| 游客/登录身份不同？ | 未验证；库设计为匿名 | 匿名只读连接不产生观众身份；发言者都有 `user-id` | 匿名读仍有 `user.id`；登录主要影响礼物，不是身份字段 |
| ID 被隐藏/打码/截断/随机化？ | 未验证 | 本轮未发现 | 本轮未发现 |
| 主播与观众同一体系？ | 未验证 | 是；主播也是 Twitch User，badge 只是角色 | 是；主播 `anchor.id_str` 与观众 `user.id` 同为抖音数字 UID；房间号是另一概念 |

**结论：**

- **Twitch**：昵称与稳定 ID 都达到 P0-1 要求；可直接建 `twitch:<user-id>` 长期档案。
- **抖音**：匿名弹幕也带稳定 UID，达到 P0-1 要求；但礼物身份需要登录态，且不能把“匿名能看弹幕”误解为“礼物也能看”。
- **TikTok**：源码/文档显示 `user.userId`、`secUid`、`uniqueId`、`nickname`，但没有真实事件；不能提前承诺。

**产品规则（沿用 AGENTS）：** 昵称只作展示；`viewer_id = platform:stable_uid`；昵称变化写 `viewer_nicknames` 历史；没有稳定 ID 的事件不建长期档案；不得按昵称合并。

### 3.2 P0-2 实时弹幕、聊天与评论

| 问题 | TikTok | Twitch | 抖音 |
| --- | --- | --- | --- |
| 正文 | 未实测 | IRC `PRIVMSG` 原文 | WSS `WebcastChatMessage` 原文（实测收到） |
| 昵称 | 未实测 | 有 | 有 |
| 稳定 ID | 未实测 | 有 | 有 |
| 发送时间 | 未实测 | `tmi-sent-ts`（毫秒） | `createTime`/`common.createTime`（毫秒） |
| 平台消息 ID | 未实测 | `id`（UUID） | 消息 `id`（实测） |
| 消息类型 | 未实测 | PRIVMSG/USERNOTICE/ROOMSTATE 等 | chat/member/like/follow/room/gift 等 |
| 表情/Emoji | 未实测 | Unicode 原样；`emotes` 标签有 ID/位置；自定义表情需映射 | Unicode 原样；`[比心]` 方括号占位；`parts` 可含 emote URL/name |
| 中文/日文/英文 | 未实测 | 本轮无 CJK 样本，但 IRC 为 UTF-8；非 ASCII 8/239 | **13/13 含 CJK**；昵称含 emoji（🐏） |
| 高弹幕量漏消息 | 公开 Issue #280 报告漏消息 | 644 条/45 秒，0 重复；未证明零漏 | 175 条/约 7 秒；30 秒 13 chat，0 重复；千条/秒未测 |
| 网络中断恢复 | 未验证 | 需自研重连；协议有 PING/RECONNECT | dyhub 有重连/心跳；本轮未断网实测 |
| 重连去重 | 未验证 | 可用 `id` 去重 | 可用消息 `id` 去重；本轮 0 重复 |
| 多直播间并发 | 未验证 | 单 WS 可 JOIN 多频道（本轮 5 个） | dyhub 支持多房间；本轮只测 1 个 |
| 下播停止 | 未验证 | IRC 不保证下播信号；需页面/EventSub 轮询 | 页面 `status=4` 可判定；WSS 也可能断开 |
| 限流/采样 | 未验证 | 匿名路径未文档化；可能被限流 | 风控/登录/签名；高频多房间有风险 |

**结论：**

- **Twitch** 的公开聊天字段完整，消息 ID 可用于重连去重；但“完整性”仍未被平台保证，必须如实显示“可能漏消息/连接中断”。
- **抖音** 匿名聊天字段完整且带稳定 UID；但礼物、部分付费互动与高频场景需要登录/风控评估。
- **TikTok** 目前不能给出任何“已支持”结论；Issue #280 明确报告部分聊天消息收不到。

### 3.3 P0-3 礼物、打赏、SC 与其他付费支持

| 平台 | 付费形式 | 可得字段 | 连送/结算 | 金额 | 结论 |
| --- | --- | --- | --- | --- | --- |
| **Twitch** | Bits/Cheer；订阅；续订；赠送订阅；订阅留言 | `bits`、`tier`、`cumulative_months`、`is_gift`、`gifter_user_id`、`recipient_user_id`、`system-msg`、消息 ID | Bits 一条消息一个 `bits` 数量；赠订 `total` + 每个 `subgift` 接收者；需避免把“赠送者总额”和“每个接收者”重复计入 | **无本币金额**；只有 Bits 数量/Tier；价格随地区/平台/税/促销变化 | **部分支持**；Bits 未真实观测，订阅/赠订已观测 |
| **抖音** | 虚拟礼物、连送、粉丝团/会员等 | `giftId`、`giftName`、`diamondCount`、`repeatCount`、`comboCount`、`groupCount`、`repeatEnd`、`groupId`、`combo` | 以 `repeatEnd`/`groupId` 合并；中间事件不能重复计费 | `diamondCount` 是展示价值，不是人民币；实际收入不可得 | **部分支持（需登录）**；匿名 0 gift，未实测 |
| **TikTok** | 虚拟礼物、连送、订阅/Super Fan 等 | `giftId`、`gift.name`、`repeatCount`、`repeatEnd`、`groupCount`、`diamondCount`/`extendedGiftInfo.diamond_count`、`user` | 官方指南要求用 `repeatEnd` 与 gift type 判断连送结束；只对最终结算计数 | 钻石是展示价值；无本币金额 | **尚未验证**；库文档声明支持，但连接被付费签名阻断 |

**关键规则：**

1. **不得把虚拟礼物展示价值冒充主播实际收入。** Twitch Bits、TikTok 钻石、抖音钻石都只是平台内计数；不能按“1 钻石 = 1 元”换算。
2. **实际支付金额只在平台明确给出时记录。** 本报告涉及的三平台，除 Bilibili SC 等已有场景外，均未在公开事件中提供本币金额。
3. **连送只结算最终事件。** 以 `repeatEnd`/`groupId`/`repeatCount` 为准；中间事件可记录诊断日志，但不能插入付费事件导致重复计数。
4. **赠订的付款者是赠送者，接收者不是付款者。** 接收者事件 `is_paid=false`，不能计入付费人数/金额；赠送者事件才计费。
5. **第三方赞助平台不在 Twitch 官方 API 内。** Streamlabs、StreamElements、PayPal 等捐款不能宣称由 Twitch API 取得；如未来支持，必须单列为外部集成，不能混入 Twitch 原生事件。

---

## 4. B. 官方 API 调查

### 4.1 14 项官方能力对照

| 问题 | TikTok | Twitch | 抖音 |
| --- | --- | --- | --- |
| 官方实时聊天 API | **无公开文档**；合作/审核通道未验证 | **有**：EventSub `channel.chat.message`；IRC 为旧路径 | **无面向普通桌面软件的公开聊天 API**；官方“直播小玩法”是互动玩法 |
| 官方实时礼物/付费事件 API | **无公开文档** | **有**：`channel.cheer`、`channel.subscribe`、`channel.subscription.gift`、`channel.subscription.message` | 小玩法内有礼物/互动能力，但面向玩法审核，不是通用采集 |
| 昵称/稳定 ID | 官方 LIVE 无公开 API；第三方库有 | 官方/IRC 都有 | 小玩法有用户标识；通用接口无公开文档 |
| 免费 | 官方申请免费但需审核；第三方签名付费 | **免费**（API 不收费） | 官方申请免费但需审核/资质 |
| 开发者账号 | 需要（应用审核/合作） | 需要注册应用（Client ID） | 需要开放平台开发者账号 |
| OAuth | 官方需要（如获授权产品） | EventSub 需要 User Access Token；IRC 文档要求 `chat:read` | 官方小玩法使用平台鉴权/服务端；具体以审核文档为准 |
| 主播授权 | 可能需要（合作/数据授权） | 读取公开聊天时，授权的是“读取者”账号；不需要主播授权 | 小玩法需要主播使用该玩法；通用采集无官方路径 |
| API Key/Client ID | 需要 | 需要 Client ID；公共客户端可无 Secret | 需要 AppID/Client Key 等 |
| 应用审核 | 需要；无保证时限 | 读聊天不需要人工审核；发送/机器人验证另有流程 | 需要玩法提案、软著、测试白名单、提审 |
| 调用/连接限制 | 官方未公开；Euler 有请求/WS 限额 | EventSub：3 个 WS、每 WS 300 订阅、`max_total_cost=10`；IRC 无公开读取配额 | 小玩法有指令数/礼物映射限制；通用接口未公开 |
| 公网回调服务器 | 官方 Webhook 需要 HTTPS 回调 | **WebSocket 不需要**；Webhook 需要 | 小玩法服务端通常需要公网/服务端；本地桌面路径未验证 |
| 本地 WebSocket | 第三方库可以（需签名） | **可以**：EventSub WS / IRC WS | 第三方 WSS 可以（需本地签名/Cookie） |
| 普通用户桌面软件使用 | 条款/授权不明确；不建议默认 | **可以**（公开只读）；官方路径需用户 OAuth | 官方不支持普通录制软件；第三方逆向有风险 |
| 数据保存/用途/再分发 | TikTok 开发者条款；未逐条核对 | Twitch Developer Agreement/ToS；需合规评估 | 抖音开放平台条款；逆向数据使用风险 |

### 4.2 TikTok 官方能力

**结论：TikTok 没有公开的 LIVE 聊天/礼物 API。**

- [TikTok for Developers Products](https://developers.tiktok.com/products/) 公开列出 Login Kit、Share Kit、Content Posting API、Research API、Display API、Embed、Data Portability、Webhooks 等；页面没有 LIVE 聊天/礼物产品。
- [Webhooks Overview](https://developers.tiktok.com/doc/webhooks-overview/) 的事件是账号授权/应用事件，不是直播间聊天/礼物流。
- TikTok 的公开开发者指南被第三方整理为“Live 集成需审核、可访问经授权的终端用户数据”，但这不是“任意公开直播间的实时事件 API”；审核不保证通过，也没有公开时限；本轮没有取得 TikTok 的正式 Live 合作文档。
- 因此：**不能把 TikTok 官方 API 描述成普通主播可立即使用的 LIVE 采集能力。**

### 4.3 Twitch 官方能力

**两条官方/半官方路径：**

#### A. EventSub WebSocket（官方推荐）

- 端点：`wss://eventsub.wss.twitch.tv/ws`；先收 `session_welcome`，keepalive 约 10 秒；支持 `session_reconnect`。
- 聊天：`channel.chat.message`，需要 **User Access Token + `user:read:chat`**；条件含 `broadcaster_user_id` 与 `user_id`（以谁的身份读）。
- Bits：`channel.cheer`，需要 `bits:read`；事件含 `bits`、`is_anonymous`、`user_id` 等。
- 订阅：`channel.subscribe`、`channel.subscription.gift`、`channel.subscription.message`，需要 `channel:read:subscriptions`；含 Tier、累计月数、赠送数量、接收者等。
- 限制（官方文档）：每个用户令牌最多 **3 个 WebSocket 连接**，每个连接最多 **300 个启用订阅**，`max_total_cost=10`；同 type+condition 最多 3 个订阅。
- 不需要公网回调；WebSocket 模式不需要 HTTPS 回调服务器。
- 免费，但需要注册 Twitch 应用取得 Client ID；读取聊天不需要人工审核。
- 桌面端可用 **Device Code Grant（DCF）**：公共客户端（Windows）不需要 Client Secret；access token 4 小时、refresh token 30 天；用户一次性在浏览器输入代码授权。这样普通用户不需要手动创建开发者应用，但 LiveMemory 发布方需要持有并公开一个 Client ID（Client ID 不是秘密）。
- **本轮未用真实 Client ID/OAuth 验证 EventSub 订阅**；只验证了 WS 握手与“无 Token 订阅返回 401”。

#### B. IRC（旧路径，匿名可用但未文档化）

- 官方文档：`wss://irc-ws.chat.twitch.tv:443`；请求 `twitch.tv/tags` + `twitch.tv/commands`；`PRIVMSG` 带 `user-id`、`display-name`、`id`、`tmi-sent-ts`、`emotes`、`bits` 等。
- 官方文档要求 User Access Token（`chat:read`）；匿名 `NICK justinfan...` 没有在官方文档中承诺。
- 本轮实测匿名连接可读 5 个公开频道；这是 **E5 行为证据**，但不是官方保证。正式实现必须把它标为“非官方兼容路径”，失败时明确提示，不静默切换、不伪造成功。
- IRC 的 `USERNOTICE` 可带订阅/续订/赠订；`ROOMSTATE` 带 `room-id`（主播稳定 User ID）。
- IRC 没有“下播事件”：直播结束后连接可能仍保持，不能以“聊天安静”判断结束；需要公开频道页/EventSub `stream.offline` 轮询。

**推荐：** 第一版用匿名 IRC 读公开聊天（零依赖、免登录），同时把 EventSub 设计为“可选官方增强/失败备选”，不要在未验证前承诺官方授权。

### 4.4 抖音官方能力

**结论：官方“直播小玩法”不是通用聊天/礼物采集 API。**

- 官方入口是 [抖音开放平台 · 直播玩法](https://developer.open-douyin.com/docs/resource/zh-CN/interaction/)。开发者注册、创建直播小玩法应用、提交玩法提案（含视频/名称）、资质（软著）、测试白名单、提审、上线。
- 官方 FAQ 明确：个人开发者和企业开发者均可参与玩法创意投稿，提案通过即可接入；玩法需要软著，名称需与软著一致；弹幕玩法内**最多配置 10 个弹幕指令**。
- 这是“互动玩法”能力，不是“把直播间所有弹幕/礼物原样推给桌面软件”的通用 API；官方文档没有提供普通主播一键授权的通用直播聊天 API。
- 因此：**不能用官方小玩法替代 LiveMemory 的 P0 采集**；也不能把“个人可提提案”写成“普通用户无需审核即可用”。

---

## 5. B. 开源方案调查

### 5.1 候选项目总表

数据来自 GitHub API（2026-11-15）与 README/源码静态核对；“维护”以最近 push 为准，不代表质量。

| 项目 | 许可证 | 语言 | 最近 push | Star / Issue | 运行时依赖 | Windows 本地 | 登录/Cookie | 第三方服务 | 弹幕/昵称/稳定 ID/礼物 | 自动开播/重连 | SEA |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [TikTok-Live-Connector](https://github.com/zerodytrash/TikTok-Live-Connector) | **AGPL-3.0** | TypeScript/Node | 2026-11-11 | 2.3k / 7 open | 约 60 npm 包（got/ws/protobuf/Euler SDK） | 是（Node ≥20） | 库设计匿名；本轮未连通 | **Euler Stream（签名）** | 文档/类型支持；本轮未实测 | 库内有；未实测 | 高风险/未验证 |
| [TikTokLive](https://github.com/isaackogan/TikTokLive) | **AGPL-3.0** | Python | 2026-10-20 | 1.65k / 1 open | Python 运行时 | 是但需 Python | 匿名/登录 | Euler 签名 | 文档支持；未实测 | 有；未实测 | 不适用 |
| [dyhub](https://github.com/ymstar/dyhub) | **MIT（核心）+ AGPL-3.0（签名脚本）** | TypeScript/Node | 2026-11-06 | 52 / 0 open | fastify、playwright-core、protobufjs、ws、pako、long | 是（Node ≥20；浏览器内核需 Chrome） | 轻量内核可匿名；礼物需登录 Cookie | 无外部服务（轻量内核本地签名） | **本轮实测**：chat/昵称/UID/进场/点赞；0 gift | 有状态/重连；未实测 | 高风险/未验证 |
| [douyin-live-toolkit](https://github.com/chuanyue98/douyin-live-toolkit) | **AGPL-3.0** | Python | 2026-07-26 | 9 / 0 open | Python 3.12/3.13、mini_racer、SQLAlchemy 等 | **README 要求 Linux/WSL** | 匿名 chat；礼物需 Cookie | 无外部服务（内置签名 JS） | 文档支持；礼物需登录 | 有；未实测 | 不适用 |
| [douyin-live-danmu](https://github.com/Kris-95271/douyin-live-danmu) | **无许可证** | Python | 2026-07-12 | 0 / 0 | 未完成/README 说待定 | 未知 | 未知 | 未知 | 只是可行性验证，不能作为依赖 | 未知 | 不适用 |
| [BarrageGrab](https://github.com/wushuaihua520/BarrageGrab) | **AGPL-3.0** | C#/.NET | 2026-10-09 | 428 / 1 open | .NET/Windows | 是 | 视模式 | 商业产品/社群生态 | README 声称全平台弹幕/礼物 | 有 | 不适用（非 Node） |
| [DouyinLiveRecorder](https://github.com/ihmily/DouyinLiveRecorder) | **MIT** | Python | 2026-04-01 | 11.2k / 522 open | Python/FFmpeg | 是 | 视平台 | 无 | **只录制直播流，不解析弹幕/礼物** | 直播状态轮询 | 不适用 |
| [cyber-xiaoya-danmaku](https://github.com/cyber-xiaoya/cyber-xiaoya-danmaku) | **AGPL-3.0** | Python | 2026-11-12 | 83 / 0 open | Python requests/websockets | 是 | 视平台 | **依赖外部 douyinLive 采集服务** | 转发弹幕/礼物 | 有 | 不适用 |
| [Twurple](https://github.com/twurple/twurple) | **MIT** | TypeScript | 2026-09-25 | 753 / 8 open | 多个 npm 包 | 是 | OAuth | 无 | 官方 API/EventSub 封装 | 有 | 中高风险 |
| [Twitch CLI](https://github.com/twitchdev/twitch-cli) | **Apache-2.0** | Go | 2026-03-11 | 686 / 26 open | Go | 是 | OAuth | 无 | 开发/调试工具 | 不适用 | 不适用 |

> 说明：`d-fischer/dank-twitch-irc` 在 GitHub API 返回 404（仓库已不可用/迁移），本报告不以它为依据。

### 5.2 TikTok 方案分析

**TikTok-Live-Connector 2.5.0（本轮重点）**

- 许可证：**AGPL-3.0-only**。这不是“可以随便抄进 MIT 项目”的许可证。
- 维护：2026-11-11 仍有提交；7 个开放 Issue；2.3k stars；但 Issue #280 明确报告“部分聊天消息收不到”，#316 报告某些用户礼物不触发，#324 报告突发错误。
- 运行时：Node ≥20；约 60 个 npm 包；`got`、`ws`、`@bufbuild/protobuf`、`tiktok-live-proto`、`tiktok-live-api-sdk`（Euler）。
- 签名：`src/lib/web/routes/euler/config.ts` 默认 `basePath=https://api.eulerstream.com`；`fetchSignedWebSocketFromEulerRoute` / `fetchWebcastSignatureFromEulerRoute` 是默认路由。`RouteConfig` 允许替换路由，但要自己实现签名，等同于重做协议。
- 免费额度：Euler 定价页 Community $0，1,500 请求/日、100 房间/日、25 并发 WS；**但签名端点要求 Business**。Business 10K $50/月。
- 真实结果：2.5.0 与 2.4.4 均在 `pollofrito1985` 上返回：
  `SignatureMissingTokensError ... [fetchWebcastSignatureFromEulerRoute] ... This endpoint requires a Business plan`。
- 旧版 1.2.3 使用本地内置签名，但请求 5 秒超时；版本已落后多年，不能作为长期方案。
- 页面访问：TikTok 返回 WAF 挑战页（“Please wait...”），本机 Node 无法直接取直播间 HTML；未绕过。
- 结论：**库本身仍在维护，但“免费 + 无第三方 + 本地”三个条件同时不满足。**

**TikTokLive（Python）**

- AGPL-3.0；Python 运行时；不适合 LiveMemory 的 Node SEA/零依赖；不引入 Python 是产品硬约束。
- 其事件模型可作为协议参考，但不能直接复用代码。

### 5.3 抖音方案分析

**dyhub（本轮唯一真实跑通的匿名方案）**

- 核心 MIT；但 lightweight 内核依赖 `third_party/douyin-sign/` 的 `a_bogus.js` 与 `sign.js`，来源 `saermart/DouyinLiveWebFetcher`，**AGPL-3.0**。dyhub 的 README 明确说“不修改、不并入 MIT 代码，仅供运行时通过 vm 加载”；但分发 EXE 时仍会随包分发 AGPL 脚本，必须满足 AGPL 的源码提供义务。
- 采集链路：`ttwid/__ac_nonce/__ac_signature` → 直播间 HTML 解析 room_id → `a_bogus` + `signature` → `wss://webcast.../webcast/im/push/v2/` → 心跳 5s/ack → protobuf 解码。
- 真实结果：匿名连接 `708764876300` 成功；175 条消息约 7 秒；45 秒 16 chat / 192 member / 25 like / 3 follow / 8 room；0 gift；13/13 chat 有 UID/昵称/secUid/消息 ID。
- 礼物：README 明确“2026 年起只把礼物消息推给已登录会话”；`douyin-live-toolkit` 的 README 也独立确认同一策略。匿名 0 gift 与此一致。
- 浏览器内核：用真实 Chrome + CDP 旁观 WSS，不依赖签名脚本，但需要 Chrome（约 200MB 内存/房间）、非零依赖、并且仍是页面自动化；不适合“普通主播双击 EXE”的默认路径。
- 结论：**抖音匿名弹幕/身份可用；礼物需要登录 Cookie；生产集成被 AGPL 与 ToS/风控卡住。**

**douyin-live-toolkit**

- AGPL-3.0；Python 3.12/3.13；README 要求 Linux/WSL；`mini_racer` 内嵌 V8 执行签名 JS；礼物需 Cookie。
- 不适合 Windows 本地 Node SEA；其 README 对“2026 礼物只推登录会话”的说明是本轮重要交叉证据。

**BarrageGrab**

- AGPL-3.0；C#/.NET；WSS/浏览器/代理多种模式；README 有商业产品与社群生态；不是 Node，不能直接进入 SEA。
- 可作为协议字段参考，但不能复制代码；其商业合作/代理模式不符合“本地、免费、无第三方服务”。

**DouyinLiveRecorder**

- MIT、11.2k stars，但**只做直播流录制**：README 中“弹幕/礼物/chat/gift”出现次数为 0；不能用于 P0-2/P0-3。

**cyber-xiaoya-danmaku**

- AGPL-3.0；Python；抖音依赖外部 `douyinLive` 采集服务（默认 `ws://127.0.0.1:1089`）；不是纯本地 Node，且多一层第三方服务。

**douyin-live-danmu**

- 无许可证（默认保留所有权利）；0 stars；README 明确“技术栈与运行方式待定”；不能作为依赖或复用来源。

### 5.4 Twitch 方案分析

- **Twurple（MIT）**：成熟的 TypeScript Twitch API/EventSub/chat 封装；但会引入多个 npm 包与 OAuth 流程，不符合零依赖优先。
- **Twitch CLI（Apache-2.0）**：调试工具，不是运行时库。
- **自研 IRC 客户端（推荐）**：`WebSocket` + 文本行解析 + `PING/PONG` + 指数退避；无需任何 npm 包；可完全控制重连、去重、字段映射；适合 Node SEA。
- 官方 EventSub 可作为后续“官方增强”：需要 Client ID + 用户 OAuth（DCF），不需要公网回调；但会引入 OAuth/令牌存储与 3 WS/300 订阅限制。

### 5.5 许可证对 LiveMemory 的影响（必须遵守）

| 许可证 | 复制/修改/分发 | 对 LiveMemory（MIT）的影响 |
| --- | --- | --- |
| **MIT** | 允许，保留版权与许可声明 | 可复用；但仍需自行承担协议/条款风险 |
| **Apache-2.0** | 允许，保留 NOTICE/专利条款 | 可复用；注意 NOTICE 与专利终止条款 |
| **GPL-2.0/3.0** | 分发衍生作品需以 GPL 提供完整源码 | 与闭源/单 EXE 分发冲突；不建议 |
| **AGPL-3.0** | 分发/网络交互都触发源码提供义务；衍生作品需 AGPL | **不能把 AGPL 代码复制进 MIT 的 LiveMemory 并继续按 MIT 分发**；即使用 `vm` 加载独立脚本，随 EXE 分发也要评估“聚合/衍生”边界并履行 AGPL |
| 无许可证 | 默认保留所有权利 | **不能复制**，只能阅读思路；本报告不把无许可证项目列为候选 |

**结论：**

- TTLC、TikTokLive、douyin-live-toolkit、BarrageGrab、cyber-xiaoya 都是 AGPL；不能直接复制代码/脚本进 LiveMemory。
- dyhub 核心 MIT 可用，但其 lightweight 签名脚本是 AGPL；如果只用浏览器 CDP 内核，可不分发 AGPL 脚本，但仍需 Chrome 与页面自动化，且不是零依赖。
- “阅读源码作为技术参考”与“复制代码/脚本/协议文件进入项目”必须分开；本报告只做前者。
- 若未来要复用 MIT/Apache 代码，必须保留版权声明并在 `docs/` 记录来源；AGPL 需单独法律评审或整体许可证变更。

---

## 6. 真实技术验证记录（可复现）

### 6.1 Twitch：匿名 IRC 读取

**连接：** `wss://irc-ws.chat.twitch.tv:443`
**能力请求：** `CAP REQ :twitch.tv/tags twitch.tv/commands`
**昵称：** `NICK justinfan98765`（匿名；无 PASS）
**加入：** `JOIN #xqc,#shroud,#sodapoppin,#moonmoon,#ludwig`

**结果（45 秒）：**

```text
PRIVMSG 644
withUserId 644
withDisplayName 644
withMessageId 644
bits 0
USERNOTICE 3（resub 2、viewermilestone 1）
ROOMSTATE 5
NOTICE 0
```

**字段样本（不保存正文）：**

```text
room=xqc
user_id=<redacted>
display=<redacted>
msg_id=<redacted-uuid>
tmi-sent-ts=1794708803978
```

**USERNOTICE 样本：**

```text
msg-id=resub
user-id=<redacted>
display-name=<redacted>
msg-param-sub-plan=1000
msg-param-cumulative-months=72
id=<redacted-uuid>
```

**ROOMSTATE：**

```text
@emote-only=0;followers-only=10;r9k=0;room-id=71092938;slow=0;subs-only=0 :tmi.twitch.tv ROOMSTATE #xqc
```

**Unicode/表情（25 秒，4 频道）：**

```text
msgs=239
nonAscii=8
cjk=0
emoji=0
emoteTag=9
withUserId=239
withId=239
dupes=0
bits=0
```

**解释：**

- 本轮 Twitch 公开聊天以英文为主，没有 CJK/emoji 样本；但 IRC 是 UTF-8 文本，非 ASCII 8 条已保留。不能据此声称 CJK/emoji 已实测。
- `emotes` 标签只给表情 ID 与位置；需要额外的 Twitch emote API 或静态映射才能显示名称/图片。LiveMemory 可以保存 ID + 占位名称，不下载图片。
- 0 条 Bits 说明 Bits 事件较稀少，不能因为本轮没看到就写“不支持”；但也不能写“已真实验证”。

### 6.2 Twitch：EventSub 授权边界

```text
WS: wss://eventsub.wss.twitch.tv/ws
收到 session_welcome：status=connected，keepalive_timeout_seconds=10
无 Token 创建 channel.chat.message 订阅：
HTTP 401
{"error":"Unauthorized","status":401,"message":"OAuth token is missing"}
```

**解释：** WebSocket 握手本身不需要 Token，但**创建订阅必须 OAuth**；这与“匿名 IRC 可读”是两条不同路径。不能把 EventSub 描述成免授权。

### 6.3 TikTok：付费签名阻断

在临时目录安装 `tiktok-live-connector@2.5.0`（hoisted，60 包），连接 Euler 排行榜标记 LIVE 的 `pollofrito1985`：

```text
CONNECT FAILED SignatureMissingTokensError [Empty Payload]
[fetchWebcastSignatureFromEulerRoute] Failed to sign a request:
This endpoint requires a Business plan.
Purchase one at https://www.eulerstream.com/pricing.
```

2.4.4 同样结果；1.2.3（本地签名）结果：

```text
CONNECT FAILED SignatureError
Failed to sign request: Failed to sign request: timeout of 5000ms exceeded;
URL: https://webcast.tiktok.com/webcast/im/fetch/?aid=1988...
```

TikTok 页面访问：

```text
GET https://www.tiktok.com/@officialgeilegisela/live
→ 200，1,462 bytes 的 WAF 挑战壳
→ "Please wait..." + slardar/WAF 脚本
```

**没有绕过 WAF、没有使用验证码服务、没有提供账号 Cookie。**

### 6.4 抖音：匿名 WSS 读取

使用 dyhub `0.3.1` lightweight 内核（临时目录，npm 安装并 `tsc` 构建；未改仓库），连接 `live.douyin.com/708764876300`。

**连接：**

```text
room=708764876300
status=live
meta.nickname=东方甄选官方旗舰店
meta.uid=<redacted>
frameCount=42
msgCount=175（约 7 秒）
```

**45 秒事件窗口：**

```text
member 192
chat 16
like 25
follow 3
room 8
gift 0
```

**30 秒 chat 字段校验：**

```text
chat=13
nonAscii=13
cjk=13
emoji=0
withUserId=13
withNickname=13
withSecUid=13
withMsgId=13
dupes=0
```

**样本字段（不保存正文）：**

```text
type=chat
id=<redacted-message-id>
user.id=<redacted>
user.nickname=<redacted>
user.secUid 存在
contentLen=20
```

**房间状态：**

```text
live.douyin.com/708764876300 → room.status=2（直播）
live.douyin.com/369324308707 → room.status=4（结束）
```

**解释：**

- 抖音匿名连接确实能取得弹幕、昵称、稳定 UID、消息 ID、进场/点赞/关注/房间统计；中文与昵称 emoji 正常。
- 45 秒 0 gift 与“2026 年起礼物只推登录会话”的源码/README 说明一致；**没有登录 Cookie，不能验证礼物**。
- 该房间是大型电商直播，消息量大；175 条/7 秒说明高吞吐场景需要背压/批量写入，但本轮没有做千条/秒压力测试。
- dyhub 的 `id` 去重与 LiveMemory 的 `external_id` 去重思路一致；本轮 0 重复。

### 6.5 验证矩阵（严格区分）

| 验证项 | TikTok | Twitch | 抖音 |
| --- | --- | --- | --- |
| 能否连接 | ❌ 被付费签名阻断 | ✅ 匿名 IRC | ✅ 匿名 WSS |
| 能否取得昵称 | ⬜ 未实测 | ✅ 644/644 | ✅ 13/13 |
| 能否取得稳定 ID | ⬜ 未实测 | ✅ 644/644 | ✅ 13/13 |
| 能否取得聊天原文 | ⬜ 未实测 | ✅ 收到（未逐条比对） | ✅ 收到（未保存） |
| 能否取得礼物事件 | ⬜ 未实测 | ⚠️ 订阅/赠订有；Bits 未观测 | ⚠️ 匿名 0；登录未测 |
| 能否取得礼物价值 | ⬜ 未实测 | ⚠️ 只有 Bits/Tier，无金额 | ⬜ 只有 diamond 字段，未实测 |
| 能否检测下播 | ⬜ 未实测 | ⚠️ 需页面/EventSub 轮询 | ✅ 页面 status=4（未做端到端） |
| 能否断线恢复 | ⬜ 未实测 | ⚠️ 协议支持，未实测 | ⚠️ 代码有，未实测 |
| 能否避免重复计数 | ⬜ 未实测 | ✅ 消息 ID + 本地去重设计 | ✅ 消息 ID + 0 重复样本 |

---

## 7. D. 与现有 LiveMemory 架构的兼容性

### 7.1 已核对的现有结构

| 位置 | 事实 | 对新平台的含义 |
| --- | --- | --- |
| `src/shared/events.mjs` | canonical event 字段固定；`EVENT_TYPES` = chat/gift/super_chat/super_sticker/guard/membership/system；`buildViewerId(platform, uid)`；`normalizeEvent()` 统一金额/币种/value_kind/emotes/dedupe | 新平台只需输出 canonical draft，不新增平台字段 |
| `src/platforms/shared/ingest.mjs` | 唯一写入路径：`ensureViewer` → `insertEvent`（UNIQUE）→ 观众/场次/金额聚合，事务内完成 | 新平台不得直接写 `events` |
| `src/platforms/shared/session-manager.mjs` | 每场独立 adapter/closure/状态；同 platform+room 拒绝重复；`onEvent` 注入 `session_id`；停止/结束只影响本场 | Twitch/抖音/TikTok 各做一个 adapter + service；不要全局单例 |
| `src/platforms/shared/adapter.mjs` | `start(context)` / `stop()` / `setState`；状态 idle/connecting/connected/reconnecting/auth_required/failed/stopped | 新 adapter 复用状态机；下播/失败要区分 |
| `src/monitoring/manager.mjs` | 平台 detector 注册；目标状态机；等待时只读检测；录制中不轮询 | 加 `twitch`/`douyin` detector；不改 Bilibili/YouTube |
| `src/storage/database/migrations/index.mjs` | `events` 有 external_id/viewer_uid/content/gift_*/amount_*/currency/value_kind/is_paid/source_quality/dedupe_key；`UNIQUE(session_id,dedupe_key)` | 现有字段足够表达大多数事件；不足见 §7.4 |
| `src/analytics/payments.mjs` | 按 currency + value_kind 分账 | 虚拟币不能伪装成 ISO 金额；否则合计会污染 |
| `src/ai/*` | 平台无关；只读 events/viewers | 新平台不需要改 AI；只要事件进 canonical 管线 |

### 7.2 事件映射建议

| 平台原生事件 | canonical `event_type` | `external_id` | 身份 | 金额/价值 |
| --- | --- | --- | --- | --- |
| Twitch PRIVMSG | `chat` | `id`（UUID） | `user-id` / `display-name` | `amount_minor=null`, `value_kind=unknown` |
| Twitch Bits/Cheer | `gift` | `id`（UUID） | `user-id` | `gift_id='bits'`, `gift_name='Bits'`, `gift_quantity=bits`, `amount_display='N Bits'`, `is_paid=true`, `amount_minor=null`, `value_kind=unknown` |
| Twitch 新订阅 | `membership` | `id`（USERNOTICE id） | `user-id` | `gift_name='Tier 1/2/3/Prime'`, `gift_quantity=1`, `is_paid=true`, `amount_minor=null` |
| Twitch 续订 | `membership` | `id` | `user-id` | 同上；`amount_display='Tier X · N months'`；留言正文放 `content` |
| Twitch 赠送订阅（付款者） | `membership` | `id` | gifter `user-id` | `gift_quantity=total`, `is_paid=true`；`amount_display='N gift subs · Tier X'` |
| Twitch 赠订接收者 | `membership` | `id:recipient` | recipient `user-id` | `is_paid=false`；不增加付费人数/金额 |
| 抖音 ChatMessage | `chat` | 消息 `id` | `user.id` / `nickname` | 无 |
| 抖音 GiftMessage（最终） | `gift` | `groupId` 或最终 `msgId` | `user.id` | `gift_id`, `gift_name`, `gift_quantity=repeatCount`, `amount_display='N diamonds'`, `amount_minor=null`, `value_kind=unknown`, `is_paid=true` |
| 抖音礼物连送中间态 | 不写付费事件 | — | — | 只记录诊断；最终态才写 |
| 抖音 Member/Like/Follow/Room | `system` 或暂不映射 | 消息 `id` | 有则记 | 不计付费；可作为次要能力后续 |
| TikTok ChatMessage | `chat` | `msgId` | `userId` / `nickname` | 无 |
| TikTok GiftMessage（最终） | `gift` | `groupId`/最终 `msgId` | `userId` | `giftId`, `gift.name`, `repeatCount`, `diamondCount`（展示值），`amount_minor=null` |
| TikTok Subscribe/Super Fan | `membership`（如可用） | `msgId` | `userId` | 金额未知，不得猜测 |

### 7.3 身份、去重、连送与并发规则

1. **身份**：`viewer_id = platform:stable_uid`。Twitch `user-id`、抖音 `user.id`、TikTok `userId`；昵称只写 `display_name`/`viewer_nicknames`。主播单独用 `broadcasters`，不要和观众混表。
2. **去重**：优先平台事件 ID；没有 ID 时才用指纹。Twitch/Douyin 都有消息 ID；TikTok 有 `msgId`/`groupId`。重连 replay 必须命中 `UNIQUE(session_id,dedupe_key)`。
3. **连送**：适配器内部按 `userId + giftId + groupId` 聚合；只在 `repeatEnd` 或平台最终态发一条付费事件；`gift_quantity` 用最终数量；中间事件不进入 `events`，避免金额/计数虚高。
4. **赠订**：付款者与接收者分开；接收者 `is_paid=false`；付款者总额只记一次；`subgift` 的每个接收者不能重复计付款者金额。
5. **并发**：每个直播间一个 adapter；Twitch 可以“一连接多 JOIN”或“一场一连接”，第一版建议一场一连接以复用 `SessionManager` 隔离模型；抖音/TikTok 一场一 WSS。不要用全局“当前场次”。
6. **下播**：Twitch IRC 不提供可靠下播信号，使用公开频道页/EventSub `stream.offline` 二次确认；抖音用页面 `status` 两次确认；TikTok 用库 `streamEnd` + 页面确认（若未来接入）。
7. **失败**：网络/429/5xx/WAF 不结束场次；进入 `reconnecting`，保留 session 与已采集事件；连续失败进入 `failed` 但继续有上限退避；只有确认下播才 `platform_ended`。
8. **多语言/表情**：正文原样保存；Unicode emoji 不进 `emotes`；Twitch `emotes` 保存 ID/位置，名称需静态映射或留空；抖音 `[比心]` 保留原文，`parts` 的 emote name/url 只作最小元数据；TikTok 未验证。
9. **保留**：新平台默认沿用 YouTube 的 30 天原文保留策略（可配置 1–30 天），清理正文/表情/badge/过期昵称；保留事件行、稳定 ID、计数与金额合计。需法律评审，但不得无限保存。

### 7.4 现有数据模型无法完整表达的部分（只提设计，不改库）

| 缺口 | 现状 | 建议（下一轮再评审，不在本轮改 schema） |
| --- | --- | --- |
| 连送组 / 最终态 | `events` 无 `group_id`/`repeat_end` 字段 | 适配器只写最终 `gift`；`external_id` 用 groupId；如需诊断，另存日志，不写 `events` |
| 订阅 Tier / 月数 | 无 `tier`/`months` 列 | 暂用 `gift_name='Tier 1'`、`amount_display='6 months'`；未来 schema 17 可加 `subscription_tier`/`subscription_months` |
| Bits 数量 | 无 `bits` 列 | `gift_id='bits'` + `gift_quantity=bits` + `amount_display='N Bits'`；`amount_minor=null` |
| 赠订付款者/接收者 | 只有一个 `viewer_id` | 付款者事件 + 接收者事件两条；接收者 `is_paid=false`；`external_id` 加 `:recipient` 后缀 |
| 平台虚拟币 | `currency` 的语义是 ISO-4217 货币；`value_kind` 只有 actual/display/unknown | **不要把钻石写成 CNY/USD**；`amount_minor=null`、`value_kind=unknown`、`amount_display='N diamonds'`；未来可加 `platform_value_json`/`virtual_currency` 读模型 |
| 礼物实际支付 | 平台不提供 | 永远不填 `actual`；UI 显示「金额未知」而不是 0 |
| 表情名称 | `events.emotes` 有 id/name/source | Twitch 只给 emote ID，名称可空；不要猜情绪；不要下载图片 |

> 本轮**没有修改数据库**；以上只是兼容性设计。若后续要加字段，必须先做 schema 迁移设计、备份兼容与 AI 包兼容评审。

### 7.5 监控与 UI

- `MonitoringManager` 已支持按平台注入 detector；新增 `TwitchChannelDetector`、`DouyinRoomDetector`，不改 Bilibili/YouTube 逻辑。
- Twitch 目标：`login`（频道名）→ 公开页确认 live → `SessionManager.startPlatform({platform:'twitch', platformRoomId: roomId})`；等待时轮询公开页，录制中不轮询。
- 抖音目标：`web_rid`（直播间号）→ 公开页 `room.status=2` → 启动；`status=4` 两次确认结束。
- UI：`capabilities.platforms` 增加卡片；三语键必须在 `src/web/i18n/*.json`；平台专有字段不得进 UI/AI；显示“金额未知/仅展示价值/需登录才能看礼物/第三方签名实验”等真实限制。
- 不改变 Bilibili/YouTube 的采集行为；新平台失败不能影响已有平台。

---

## 8. E. 推荐开发顺序

| 维度 | Twitch | 抖音 | TikTok |
| --- | --- | --- | --- |
| 市场价值 | 高（全球、英语为主、付费文化成熟） | 高（中国大陆、电商/娱乐） | 很高（全球） |
| 技术成熟度 | **高**（本轮真实跑通） | 中（匿名聊天跑通；礼物需登录） | 低（付费签名阻断） |
| 开发复杂度 | 低–中（文本 IRC + 页面检测） | 中–高（protobuf/签名/Cookie/风控） | 高（60 包/AGPL/签名/WAF） |
| 维护风险 | 中（匿名路径未文档化） | 高（协议/签名/风控/条款） | 很高（第三方付费服务/AGPL/漏消息） |
| P0 契合度 | 高（昵称/ID/聊天/订阅/Bits） | 中（聊天/ID 好；礼物受限） | 未知 |
| 许可证 | 自研无问题 | 本地脚本 AGPL | 库 AGPL |
| **建议** | **1. 立即开发** | **2. 条件开发** | **3. 暂缓** |

**排序理由：**

1. Twitch 是唯一同时满足“真实跑通 + 免费 + 无第三方 + 零依赖 + SEA 友好 + 稳定 ID + 付费事件（订阅/赠订已实测，Bits 待验收）”的平台。
2. 抖音的聊天/身份证据很强，但礼物必须登录 Cookie，且本地签名脚本 AGPL；先做 Twitch 可复用 adapter/监控/测试基础设施，再评估抖音。
3. TikTok 的付费签名与 AGPL 使其不适合作为默认能力；等免费/自托管路径或官方合作，不把“付费才能用”包装成“免费”。

---

## 9. F. 风险与未解决问题

### 9.1 Twitch

- **匿名 IRC 未文档化**：官方要求 User Access Token；匿名 `justinfan` 是历史行为，可能被限流/关闭。必须在 UI/文档标注“非官方兼容路径”，失败时不静默切换、不伪造成功。
- **EventSub 未真实 OAuth 验证**：需要 Client ID + DCF/授权码；本轮只验证 WS 握手与 401。DCF 的 4h/30d token、刷新、撤销、3 WS/300 订阅限制需实测。
- **Bits 未真实观测**：三次探测 0 条；需要专门等待有 Bits 的直播或 Mock 帧验证。
- **下播检测**：IRC 不提供下播事件；页面轮询有延迟；需要二次确认，避免误结束。
- **消息完整性**：644 条样本不代表零漏；Twitch 不保证 IRC 完整；UI 必须允许“可能漏消息”。
- **数据保留/条款**：Twitch Developer Agreement/ToS；公开聊天仍是个人数据；30 天原文保留策略需法律评审。
- **第三方捐款**：Streamlabs/StreamElements/PayPal 不在 Twitch 官方 API；不能宣称支持。

### 9.2 抖音

- **礼物需要登录 Cookie**：匿名 0 gift；登录后是否 100% 收到礼物、连送是否完整，未验证。不能要求普通用户必须交出 Cookie 才能用核心功能；如提供，必须明确风险、加密存储、可撤销。
- **AGPL**：lightweight 签名脚本是 AGPL-3.0；随 EXE 分发会触发源码提供义务，和 MIT 分发冲突。浏览器 CDP 内核可避开脚本，但需要 Chrome、资源高、仍是页面自动化。
- **协议/风控**：`a_bogus`/X-Bogus 可能随时失效；高频/多房间/数据中心 IP 易被风控；`DEVICE_BLOCKED` 415 已有报告；需要 Cookie 链/重试/退避。
- **官方路径不适用**：直播小玩法需要提案/软著/审核，最多 10 个弹幕指令，不是通用采集；不能把“个人可提提案”写成“普通用户可用”。
- **条款风险**：逆向 WSS 可能违反平台条款；需要法律/合规评审；不得绕过验证码/登录限制。
- **未验证**：真实礼物、连送结算、跨场次改名、断线恢复、下播端到端、多房间、千条/秒、登录态稳定性。

### 9.3 TikTok

- **付费签名**：Euler Business $50/月；免费 Community 不能完成签名；价格/额度/端点可能变化；不能把成本转嫁给普通用户而不说明。
- **AGPL**：TTLC/TikTokLive 都是 AGPL；不能直接复制进 MIT 项目。
- **漏消息**：Issue #280 明确报告部分聊天消息收不到；#316 报告礼物不触发；#324 突发错误；不能承诺完整。
- **WAF/地区**：本机页面访问被 WAF 挑战；不同地区/网络可能不同；不得绕过。
- **官方通道**：没有公开 LIVE API；合作/审核通道未验证，不能承诺。
- **未验证**：真实 chat/gift/用户 ID/连送/下播/重连/金额；Node SEA 打包。

### 9.4 共同风险

- **金额口径**：虚拟币/展示价值/实际支付必须分开；不能把钻石/Bits 换算成收入；不能把“礼物数量”当“金额”。
- **身份口径**：昵称不是身份；改名不新建档案；没有稳定 ID 不建长期画像；不同平台同名不合并。
- **数据保留**：公开聊天仍是个人数据；默认 30 天原文保留；用户必须能删除/导出；不得上传开发者服务器。
- **许可证**：AGPL/GPL 代码不能随意复制；MIT/Apache 也要保留声明；无许可证项目不能复制。
- **架构**：新平台必须走 `EventIngest`；不得为平台单独建 AI 画像；不得改 Bilibili/YouTube 行为；不得改现有 DB schema（本轮）。

---

## 10. G. 下一轮实施计划（建议：Twitch 第一）

### 10.1 目标

在不引入任何 npm 运行时依赖的前提下，完成 Twitch 公开直播的：
昵称 + 稳定 User ID + 实时聊天 + Bits/订阅/赠订（能取则取）+ 自动开播监听 + 断线重连 + 去重 + 下播确认；
全部经 `EventIngest` 写入，不改 Bilibili/YouTube，不改 AI/备份，不改数据库（除非单独批准 schema 17）。

### 10.2 分阶段

| 阶段 | 内容 | 交付/验收 |
| --- | --- | --- |
| **T0 协议固化（0.5–1 天）** | 把本轮 IRC 探测固化为 fixture：PRIVMSG、USERNOTICE sub/resub/subgift、ROOMSTATE、PING/RECONNECT、Bits 标签；写纯解析单测（无网络） | 解析器对固定帧 100% 通过；未知标签忽略不崩 |
| **T1 适配器（2–3 天）** | `src/platforms/twitch/`：`link.mjs`（频道 URL/裸频道名）、`irc.mjs`（WS 连接、CAP、PING/PONG、退避、重连）、`parser.mjs`、`mapper.mjs`、`adapter.mjs`、`service.mjs` | 单场真实公开频道 10 分钟：chat 入库、昵称/ID/消息 ID 正确；停止只停本场 |
| **T2 付费事件（1–2 天）** | Bits/Cheer、订阅/续订/赠订；付款者/接收者分离；金额未知；连送/赠订去重 | 真实订阅/赠订样本或 Mock 帧；不重复计数；`value_kind=unknown` |
| **T3 生命周期（1–2 天）** | `reconnecting`/`failed`/`auth_required` 状态；指数退避；下播页面二次确认；同一频道重复启动拒绝；多频道并发 | 断网/关闭 WS/页面 offline 的 Mock + 真实短断网；不误结束、不新建 session、replay 去重 |
| **T4 监控（1–2 天）** | `TwitchChannelDetector`：公开频道页 `isLiveBroadcast`；等待/录制/结束状态；轮询节流 | 目标添加、开播创建 session、下播结束、重复不新建；不影响 Bilibili/YouTube |
| **T5 UI/三语（1–2 天）** | 平台卡片、连接状态、金额未知/可能漏消息提示、错误码；i18n 三语 | 三语键一致；无 `innerHTML`；窄屏无溢出 |
| **T6 EXE/验收（1–2 天）** | 构建脚本加入新模块；SEA 冒烟；真实频道 30 分钟；两频道并发；断线恢复；停止/重启 | `node --test` 全量；EXE `verify-*`；真实频道记录写入报告 |

### 10.3 验收标准

- [ ] 真实公开 Twitch 频道：昵称/User ID/消息 ID 覆盖 100%（本轮样本标准）；聊天正文保存；Unicode 不破坏。
- [ ] 两个频道并发：事件不串场；停止 A 不影响 B；同一频道重复启动被拒绝。
- [ ] 断线：关闭网络/WS 后进入 `reconnecting`，session 保持 `live`；恢复后同一 session 继续；replay 不重复计数。
- [ ] 下播：页面/EventSub 证据二次确认后 `platform_ended`；不因聊天安静误结束。
- [ ] 付费：Bits/订阅/赠订至少各有一个真实或 Mock 帧；金额未知不显示 0；赠订接收者不计付费。
- [ ] 监控：等待→开播→录制→下播→再开播；目标不删除；无重复 session。
- [ ] 兼容：Bilibili/YouTube 既有测试全过；AI/备份/DB schema 不变；EXE 可启动。
- [ ] 文档：STATUS/HANDOFF/ROADMAP/PLATFORM_INTEGRATIONS/TEST_PLAN/日志更新；明确“匿名 IRC 非官方”。

### 10.4 抖音/TikTok 的门槛（不阻塞 Twitch）

**抖音进入开发前必须回答：**

1. 是否接受“礼物需要用户登录 Cookie”？如果不接受，抖音只能做弹幕/身份，P0-3 不完整。
2. 是否接受 AGPL 签名脚本随 EXE 分发？如果不接受，只能用 Chrome CDP 内核（重、非零依赖）或放弃。
3. 是否接受逆向协议/条款风险？需要法务/产品明确。
4. 是否接受“无官方支持、可能随时失效”？UI 必须如实提示。

**TikTok 进入开发前必须回答：**

1. 是否愿意承担 Euler Business $50/月（或等价签名服务）？如果愿意，是否作为“用户自备 Key”的实验能力？
2. 是否接受 AGPL + 60 依赖 + 漏消息风险？如果不接受，等待官方合作/自托管签名。
3. 是否能把“TikTok 支持”标注为实验性，不承诺完整/稳定？

---

## 11. 需要用户确认的决策

1. **Twitch 第一版采用哪条读取路径？**
   - 推荐：匿名 IRC 读取公开聊天（免登录、零依赖、已实测），EventSub 只作为后续官方增强。
   - 备选：只做官方 EventSub（需要 LiveMemory 注册 Client ID + 用户 DCF 授权；更正式，但开发/验证成本更高）。
2. **抖音是否接受登录 Cookie 才能看礼物？** 如果不接受，是否接受“抖音先只做弹幕/身份，礼物标为不支持”？
3. **抖音是否接受 AGPL 签名脚本？** 如果不接受，是否接受 Chrome CDP 方案（体积/资源/依赖）或暂缓？
4. **TikTok 是否暂缓？** 如果要做，是否接受“用户自备 Euler Business Key + 实验性 + 可能漏消息”？
5. **原始聊天保留期**是否统一为 30 天（与 YouTube 一致），并在设置中可调 1–30 天？
6. **是否授权开始 Twitch 正式开发**（本轮只研究，未改代码）。

---

## 12. 引用与证据索引

### 12.1 官方文档

- Twitch EventSub Overview：https://dev.twitch.tv/docs/eventsub/
- Twitch EventSub Chat Reference：https://dev.twitch.tv/docs/eventsub/reference/chat/
- Twitch EventSub Channel Reference（Cheer/Subscribe/Gift）：https://dev.twitch.tv/docs/eventsub/reference/channel/
- Twitch EventSub Subscription Limits：https://dev.twitch.tv/docs/eventsub/manage-subscriptions/
- Twitch IRC Concepts：https://dev.twitch.tv/docs/chat/irc/
- Twitch IRC Migration：https://dev.twitch.tv/docs/chat/irc-migration/
- Twitch OAuth / Device Code Grant：https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/
- TikTok for Developers Products：https://developers.tiktok.com/products/
- TikTok Webhooks Overview：https://developers.tiktok.com/doc/webhooks-overview/
- 抖音开放平台 · 直播玩法：https://developer.open-douyin.com/docs/resource/zh-CN/interaction/
- 抖音开放平台 · 直播玩法 FAQ：https://developer.open-douyin.com/docs/resource/zh-CN/interaction/introduction/zn/FAQ

### 12.2 开源项目

- TikTok-Live-Connector：https://github.com/zerodytrash/TikTok-Live-Connector
- TTLC Issue #280（漏消息）：https://github.com/zerodytrash/TikTok-Live-Connector/issues/280
- TTLC Issue #316（礼物不触发）：https://github.com/zerodytrash/TikTok-Live-Connector/issues/316
- TTLC Gift/Streak 文档：https://ttlc.docs.isaackogan.com/events/gifts-and-goals/
- TikTokLive：https://github.com/isaackogan/TikTokLive
- Euler Stream Pricing：https://www.eulerstream.com/pricing
- Euler Stream Webcast URL（Business 计划）：https://www.eulerstream.com/docs/api/tiktok-live-anchors
- dyhub：https://github.com/ymstar/dyhub
- dyhub 第三方签名声明：https://github.com/ymstar/dyhub/blob/main/third_party/douyin-sign/README.md
- DouyinLiveWebFetcher（AGPL 上游）：https://github.com/saermart/DouyinLiveWebFetcher
- douyin-live-toolkit：https://github.com/chuanyue98/douyin-live-toolkit
- douyin-live-danmu：https://github.com/Kris-95271/douyin-live-danmu
- BarrageGrab：https://github.com/wushuaihua520/BarrageGrab
- DouyinLiveRecorder：https://github.com/ihmily/DouyinLiveRecorder
- cyber-xiaoya-danmaku：https://github.com/cyber-xiaoya/cyber-xiaoya-danmaku
- Twurple：https://github.com/twurple/twurple
- Twitch CLI：https://github.com/twitchdev/twitch-cli

### 12.3 仓库内相关文件

- `src/shared/events.mjs`
- `src/platforms/shared/ingest.mjs`
- `src/platforms/shared/adapter.mjs`
- `src/platforms/shared/session-manager.mjs`
- `src/monitoring/manager.mjs`
- `src/monitoring/detectors/bilibili.mjs`
- `src/monitoring/detectors/youtube.mjs`
- `src/storage/database/migrations/index.mjs`
- `src/storage/repositories/events.mjs`
- `src/storage/repositories/viewers.mjs`
- `src/analytics/payments.mjs`
- `src/ai/export/*`
- `docs/PLATFORM_INTEGRATIONS.md`
- `docs/STATUS.md` §0.33
- `log/2026-11-15-platform-research.md`

---

## 13. 最终结论（给产品/开发）

1. **Twitch 现在就可以做，而且是三平台里最符合 LiveMemory 产品约束的。** 匿名 IRC 的真实证据足够支撑第一版；官方 EventSub 作为后续增强，不要在第一版强行引入 OAuth 复杂度。
2. **抖音不是“不能做”，而是“不能免费、匿名、完整地做礼物”。** 弹幕/身份已经实测可用；礼物必须登录 Cookie，签名脚本 AGPL，协议逆向有风险。先把这些作为产品决策，不要默默降级。
3. **TikTok 当前不适合承诺。** 官方无公开 LIVE API；第三方库的免费额度不能完成签名；AGPL + 60 依赖 + 漏消息 + WAF，使“普通主播输入房间地址即可用”的目标无法可靠达成。
4. **三平台都不能把虚拟礼物价值当收入。** 只能记录平台数量/档位/展示价值；实际金额未知时明确显示未知。
5. **本轮没有修改任何正式代码、数据库、AI 或现有平台采集。** 等待用户确认下一轮是否按 Twitch 方案开始实现。

---

*报告完。2026-11-15。*
