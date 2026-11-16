# 直播平台扩展：候选调查记录

状态：**调查记录（2026-11-16）**。本轮**没有接入任何新平台、没有连接任何新平台、没有安装依赖、
没有复制任何第三方代码**。本文所有结论限于「读代码 / 读文档 / 读公开 API 元数据」，
未做真实连接，因此**除已明确标注者外一律为「待验证」**。

准入判据与门禁流程见 `docs/PLATFORM_ADMISSION.md`。本文件只记录「调查到了什么」。

## 0. 调查方法与证据来源

| 来源 | 用途 | 时间 |
| --- | --- | --- |
| GitHub REST API `api.github.com/repos/...` | 仓库是否存在、`pushed_at`、`archived`、`license`、stars、language | 2026-11-16 快照 |
| 仓库 README（`raw.githubusercontent.com`） | 功能声明、是否免登录、事件字段、依赖 | 2026-11-16 |
| 仓库源码（只读阅读） | 确认实际协议路径与字段名，而不是只看 README 宣传 | 2026-11-16 |
| npm registry（`registry.npmjs.org`） | 包许可证、最后发布时间、依赖 | 2026-11-16 |
| 平台官方开发者文档（`docs.kick.com`） | 官方 API 能力边界（是否有读取聊天的能力） | 2026-11-16 |

> 说明：阅读开源实现是为了**确认协议事实**，不是为了抄代码。若将来复用任何代码片段，
> 必须按其许可证在 `THIRD_PARTY_NOTICES.md` 标注（见 `PLATFORM_ADMISSION.md` §7）。

---

## 1. 候选顺序与当前初判

顺序取自本轮需求（**调查优先级，不是无条件开发承诺**）。命中暂停条件即可跳过后继续调查。

| # | 平台 | 当前初判 | 关键未决问题 |
| --- | --- | --- | --- |
| 1 | **Kick** | **G0 有条件通过**（免登录、有用户名、有稳定 ID 的可能性高）→ 下一步应做 G1 真实连接 | 非官方 web 端点稳定性；guest token 有效期与限流；字段真实性未实测 |
| 2 | 虎牙 Huya | 有可参考实现（反向 WebSocket，无需开发者认证） | 用户名/稳定 ID 字段、是否需要 Cookie、协议变动频率 |
| 3 | 斗鱼 Douyu | 有可参考实现 | 是否部分房间需要登录 Cookie；稳定 UID 可得性 |
| 4 | CHZZK | 官方 API 需 Client ID/Secret → 官方路径**违反条件一**；非官方库存在但已停更 | 非官方路径当前是否仍可匿名读聊天 |
| 5 | SOOP（原 AfreecaTV） | 有 2026 年仍在更新的 Go 聊天库 | 读聊天是否必须登录；稳定 ID |
| 6 | 快手 Kuaishou | 有可参考实现（Protobuf WebSocket） | 稳定 ID、礼物可用性、协议变动 |
| 7 | Niconico | 历史实现均已归档/停更；观看通常需账号 | 是否可能免登录；官方 watch session 要求 |
| 8 | 小红书 | **本轮未检索到持续维护的开源实现** | 协议封闭程度、是否存在合规公开路径 |
| 9 | YY 直播 | **本轮未检索到持续维护的开源实现** | 同上 |
| 10 | Facebook Live | 预判**不满足条件一**（Graph API 需应用+审核；抓取违反条款） | 是否存在官方公开聊天读取能力 |

> 「本轮未检索到」只代表本次检索范围内没有发现，不等于「不存在」。后续若有人提供可行实现，
> 仍需按 `PLATFORM_ADMISSION.md` 的 G0–G6 走一遍。

---

## 2. Kick 技术预研（重点）

### 2.1 三个候选开源项目核实结果

| 项目 | 是否存在 | 维护状态（2026-11-16） | 许可证 | 语言/技术栈 | Stars / Forks | 与 LiveMemory 的关系 |
| --- | --- | --- | --- | --- | --- | --- |
| [`achrafthedev/kixo`](https://github.com/achrafthedev/kixo) | ✅ 存在 | 新建 2026-10-17，最后推送 **2026-10-25**（约 3 周前）；未归档；0 issue | **MIT** | JavaScript（Electron + React 19） | 1 / 0 | **最有参考价值**：唯一在 2026 年仍跟踪 Kick 实时协议演进的实现（Centrifugo + Pusher 双路径）。协议事实可借鉴，代码不可直接用于零依赖 Node 栈 |
| [`LOX-X/kick-live-connector`](https://github.com/LOX-X/Kick-Live-Connector) | ✅ 存在 | 创建 2024-11-01，最后推送 **2024-11-01**（单次提交后未更新，约 2 年停更）；未归档 | **MIT** | TypeScript（Node.js 库，最贴近本仓库栈） | 5 / 0 | 技术栈最匹配，README 给出了完整消息结构（含 `sender.id`）。但明显停更，且其描述仍停留在 Pusher 时代；**只能作为字段参考，不能作为协议现状依据** |
| [`Landy-Dev/kick-api`](https://github.com/Landy-Dev/kick-api) | ✅ 存在 | 创建 2026-02-07，最后推送 **2026-04-10**；未归档 | **Apache-2.0** | **Rust** 客户端库 | 2 / 3 | **不适配**：Rust 与 Node 零依赖栈不兼容；且定位是官方 API 客户端，官方 API 无「读聊天」能力（见 2.3） |

结论：三个候选里，**kixo 是唯一具备「2026 年协议现实」参考价值的项目**；
`kick-live-connector` 可作为字段结构佐证；`kick-api` 不适合本项目的技术栈与用途。

### 2.2 三个核心准入条件的核实

| 条件 | 结论 | 依据 |
| --- | --- | --- |
| **条件一：免登录** | **满足（文档+源码级证据，未实测）** | kixo README：「You don't need an account to read chat.」；其源码只要求匿名 guest token 或公开 Pusher app key；`kick-live-connector` README：「requiring only the streamer's username … without needing any credentials」 |
| **条件二：用户名** | **满足（文档+源码级证据，未实测）** | 消息对象含 `sender.username`（`kick-live-connector` README 与 kixo `parse.js` 一致） |
| **条件二：稳定用户 ID** | **很可能满足（未实测）** | 消息含 `sender.id`（数值型用户 ID），kixo 归一化后即 `user.id`。**需要在 G2 用真实样本确认它跨场次稳定、且不是每场重新编号** |
| **条件三：实时聊天** | **满足（文档+源码级证据，未实测）** | 公开实时通道（Centrifugo / Pusher 双路径），且是「登录前访客也能看到的同一路公开流」 |
| **消息 ID** | 满足 | 消息含 UUID `id` |
| **时间** | 满足 | 消息含 `created_at`（ISO 8601，带时区） |
| **礼物** | 可获取（可选增强） | 存在 `KicksGifted`、`SubscriptionEvent`、`GiftedSubscriptionsEvent` 等事件；**本轮未观测**，标 `NOT-OBSERVED` |
| **断线重连** | 可做（需自研） | 参考实现有指数退避 + token 过期前主动重连；无「续传游标」，**重连期间可能漏消息** |
| **多直播间** | 可做 | 单个 socket 按 topic 订阅多个房间（kixo 模式）；每房间一个 topic 集合 |

### 2.3 官方 API 的能力边界（重要，决定「不能用官方 API」）

Kick 提供了官方 Public API（`docs.kick.com`，OAuth 2.1 + PKCE）。核实要点：

- 官方 scope 列表中只有 **`chat:write`**（发消息）、**`events:subscribe`**（订阅频道事件）、
  `moderation:chat_message:manage` 等；**没有「读取聊天历史/实时聊天流」的 scope/端点**。
- `events:subscribe` 交付方式是 **webhook**（需要公网可访问的接收端），不是长连接；
  LiveMemory 是本地无服务器形态，无法作为 webhook 接收方。
- 使用官方 API 需要**创建应用、获取 Client ID/Secret、走 OAuth**，普通主播无法满足
  `PLATFORM_ADMISSION.md` 条件一。

因此：**Kick 的聊天读取只能走「与登录前访客相同的公开实时通道」**，属于非官方协议路径。
这与现有 TikTok 匿名 webcast 的定位同类，必须按 `AGENTS.md` §6.12 的口径标注
「非官方 / 实验性 / 可能失效」，**不得描述为官方授权或合规**。

### 2.4 非官方实时通道的技术轮廓（源码阅读得出，未实测）

以下为 kixo（MIT，2026-10）源码中体现的路径，仅作**协议事实**记录；
LiveMemory 若实现必须自行重写，不得复制代码。

```text
1) 房间/聊天室标识（公开网页端点）
   GET https://kick.com/api/v2/channels/{slug}
       -> chatroom.id（聊天室）、id/user_id（频道/用户）、livestream{id, session_title, start_time, viewer_count}

2) 实时连接配置（公开 web 端点）
   POST https://web.kick.com/api/v1/realtime/channels/{channelId}/chat/connection
        Origin: https://kick.com, Referer: https://kick.com/
        body: {client:{id:<随机UUID>,type:"web"},
               capabilities:{accepted_providers:[{provider:"pusher"},{provider:"centrifugo"}]}}
   -> data.connections[] —— 每项含 provider + credentials

3) 两条传输路径
   a) Centrifugo（2026 起的新路径）
      - 取匿名 guest token：POST https://web.kick.com/api/v1/realtime/auth/connection  {client_id}
      - WebSocket：credentials.url；首帧 {"id":1,"connect":{"token":...,"name":"js"}}
      - 订阅：{"id":n,"subscribe":{"channel":"chatrooms.<chatroomId>.v2"}} 与 "channel.<channelId>"
      - 心跳：服务端发一行 "{}"，客户端回 "{}"
      - token 有 TTL（参考实现按 ~45 分钟处理，提前重连换新 token）
   b) Pusher（旧路径/回退）
      - wss://ws-<cluster>.pusher.com/app/<appKey>?protocol=7&client=js&version=8.4.0
      - 订阅：{"event":"pusher:subscribe","data":{"auth":"","channel":"chatrooms.<id>.v2"}}
      - 未取到配置时参考实现回退到公开默认 app key + cluster
```

**消息结构（`kick-live-connector` README 与 kixo `parse.js` 一致）：**

```json
{
  "id": "<uuid>",
  "chatroom_id": 12345,
  "content": "text [emote:37226:pepe] more text",
  "type": "message | reply",
  "created_at": "2024-10-27T14:11:52+00:00",
  "sender": {
    "id": 346148,
    "username": "User",
    "slug": "user",
    "identity": {"color": "#FF9D00", "badges": [{"type":"subscriber","text":"Subscriber","count":4}]}
  },
  "metadata": {"original_sender": {"id": 1, "username": "User1"},
               "original_message": {"id": "...", "content": "..."}}
}
```

### 2.5 Kick 适配器设计要点（供后续开发轮参考，本轮不实现）

1. **身份**：`platform_uid` 用 `sender.id`；`nickname` 用 `sender.username`；
   观众主键 `kick:<sender.id>`。`sender.id` 缺失时该消息标 `source_quality=unknown`，不建档案。
2. **消息 ID**：`id`（UUID）作为 `platform_message_id` 与去重依据。
3. **时间**：`created_at` 是带时区 ISO 字符串，需转为 epoch 毫秒；**不要用接收时间冒充**。
4. **表情是内容里的标记**：原文形如 `[emote:37226:pepe]`。
   必须遵守「原文不得替换」：`content` 保留平台原始字符串，
   同时把 `[emote:id:name]` 解析进 `emotes`（保留 id 与 name），
   展示层按现有表情规则渲染；**不得**直接把 `content` 改写成纯文本。
5. **回复消息**：`type=reply` 的 `metadata.original_message` 只作为补充信息，不改变身份判定。
6. **重连**：无续传游标 → 必须标注「重连期间可能漏消息」；token 到期前主动重连；
   指数退避 + 抖动；失败不静默降级为「已连接」。
7. **只接直播**：不使用 `api/v2/channels/{id}/messages` 之类的历史消息端点做「补录」，
   否则等于抓取历史回放，违反 `AGENTS.md` §6.11。
8. **不得**内置账号 Cookie、不得引入第三方签名服务、不得绕过任何访问控制。

### 2.6 Kick 主要风险

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| **非官方端点会变** | 参考实现注释明确「Kick moved live chat from Pusher to Centrifugo in 2026」——**一年内已迁移过一次** | 传输层必须可替换（provider 抽象）；失败要显式报错并给出「该路径可能已失效」文案；定期重跑 G1 |
| **guest token 时效** | 匿名 token 有 TTL，且发 token 的端点可能限流 | 提前换 token；429/拒绝时退避，不掩盖为成功 |
| **字段稳定性未实测** | `sender.id` 是否跨场次稳定、是否对匿名观众可见，均未实测 | G2 必须用真实样本统计比例并记录 |
| **无历史补偿** | 断线只能从当前时刻继续 | UI 与文档如实说明「可能不完整」 |
| **条款/合规表述** | 非官方协议；不得称官方/合规 | 界面与文档统一标「非官方 / 实验性」 |
| **单一参考实现依赖** | 2026 年仍在维护的实现只有 1 个（1 star 的个人项目） | 只借鉴协议事实；自研传输；不把它当依赖 |

### 2.7 Kick 预研结论

**G0 结论：有条件通过。** 三个核心准入条件在「文档 + 源码」层面均成立，
但**全部为待验证**——本仓库尚未真实连接 Kick，也没有真实样本。

下一步（下一轮或后续轮）应当只做一件小事：**G1 真实连接验证**（只读、只记录，不做适配器），
判定标准见 `PLATFORM_ADMISSION.md` §4。**在 G1 通过前，任何界面都不得出现 Kick。**

---

## 3. 其他平台的调查清单（本轮只到 G0 深度）

每一节都要在真正开工前补齐：项目地址与维护状态、许可证、是否免登录、用户名、稳定 ID、
实时聊天、重连、技术栈、付费依赖、非官方接口风险。下表是本轮查到的**线索**。

### 3.1 虎牙 Huya

- 线索：`KByteArray/ordinaryroad-live-chat-client`（MIT，Java/Netty）支持 Huya；
  README 明确「抓取浏览器 WebSocket 二进制流…**不需要开发者认证**」，并注明虎牙流程参考
  `Kain-90/huya-danmu`。虎牙官方开放平台（`open.huya.com`）存在，但属于另一条需申请力的路径。
- 待验证：用户名与稳定 UID 字段；是否必须 Cookie；进入房间类事件是否只对「高级用户」可见；
  协议（`vplayerUI.js` / `taf-signal`）变动频率。
- 风险：Java 实现无法直接复用，需按协议自研；反混淆依赖平台 JS 资源，变动即失效。

### 3.2 斗鱼 Douyu

- 线索：同上项目支持 Douyu（MIT）；npm 生态有 `douyudm`。斗鱼官方开放平台存在（`open.douyu.com`）。
- 待验证：部分房间是否要求登录 Cookie（历史上斗鱼对未登录有较强限制）；
  稳定 UID 与实际弹幕字段；心跳/重连细节。
- 风险：登录依赖一旦成立即违反条件一 → 需先判定「免登录可读」是否覆盖目标房间。

### 3.3 CHZZK（韩国 Naver）

- 线索：官方 Open API 需在 `developers.chzzk.naver.com` 申请 Client ID/Secret → **官方路径违反条件一**。
  非官方 npm [`chzzk`](https://github.com/kimcore/chzzk)（MIT，v1.10.4，最后发布 **2024-08**，
  依赖 `ws` + `isomorphic-ws`）自述为「비공식 API 라이브러리」（非官方 API 库）。
- 待验证：当前是否仍可匿名读取聊天；字段中的频道/用户 ID 是否稳定；是否已随平台改版失效。
- 风险：非官方库停更约 2 年；若走官方 API 则需用户配置密钥 → 直接否决。

### 3.4 SOOP（原 AfreecaTV，韩国）

- 线索：[`halfdogs/soopchat`](https://github.com/halfdogs/soopchat)（MIT，Go，最后推送 **2026-04-19**，
  5 stars）— 「숲(SOOP) 채팅 Golang 라이브러리」。另有 `taewooyo/soopplus-collector`。
- 待验证：**读聊天是否需要登录/票券**（这是 SOOP 的关键问号）；稳定 ID；礼物字段。
- 风险：Go 实现，仅可借鉴协议；若必须登录则可能在条件一被否决，但可按
  `PLATFORM_ADMISSION.md` §3 评估「二维码登录是否可接受」。

### 3.5 快手 Kuaishou

- 线索：`ordinaryroad` 支持 Kuaishou（Protobuf WebSocket，README 引用了其协议分析文章）；
  也有 `BarrageGrab` 类工具覆盖抖音/快手。
- 待验证：稳定 UID；礼物信息完整性（README 自评「礼物信息不全」）；协议变动。
- 风险：Protobuf 结构随版本变化；直播间 id 解析依赖页面。

### 3.6 Niconico

- 线索：`tsuwatch/nicolive-api`（npm，MIT，**2019 年**，依赖已废弃的 `request`/`cheerio`）；
  `proshunsuke/niconama-client`（MIT，**已 archived**，2016 年，JavaScript）。
- 待验证：Niconico 现行「watch session」机制是否要求登录；匿名是否可读评论。
- 风险：两个实现都已不可用；Niconico 观看通常需要账号 → **很可能违反条件一**，
  建议排在后面，并做好「否决」准备。

### 3.7 小红书 / YY 直播

- 本轮检索**未发现**持续维护、许可证明确、可匿名读取直播聊天评论的开源实现。
- 待验证：是否存在公开的 H5/小程序聊天通道；是否需要登录态；协议封闭程度。
- 建议：除非出现可信实现，否则默认**不纳入**开发计划（命中 `PLATFORM_ADMISSION.md` §6 第 7 条）。

### 3.8 Facebook Live

- 事实：Facebook 的直播互动数据只能通过 Graph API / Webhooks 获取，需要
  **应用审核、页面访问令牌与相应权限**；直接抓取网页聊天违反其条款。
- 结论（预判）：**不满足条件一**（普通主播无法只填链接就用）。建议正式评估后标记「不纳入」，
  并在文档中写明原因，避免反复评估。

---

## 4. 待验证清单（下一轮可直接照做）

按优先级排列，每项都要给出真实证据后才能升级结论：

1. **Kick G1**：真实公开直播间只读连接 15 分钟，记录连接成功率、消息条数、字段完整率。
2. **Kick G2**：统计（有 `sender.id`）/（有 `sender.username`）/（有 `id`）/（有 `created_at`）的比例，
   并抓取含 CJK、Emoji、`[emote:...]`、`reply` 类型的样本各若干。
3. **Kick 页面结构**：`/api/v2/channels/{slug}` 是否仍公开返回 `chatroom.id`（未登录、无 Cookie）。
4. **Kick 稳定性**：token TTL、限流形态（429？连接被拒？）、Centrifugo 与 Pusher 何者为主。
5. **虎牙 / 斗鱼 / 快手**：确认「免登录可读」是否对所有房间成立，还是仅部分房间；
   抽取真实样本统计稳定 UID 覆盖比例。
6. **SOOP**：确认读聊天是否需要登录。
7. **CHZZK**：确认非官方库当前是否可用；若不可用则整条线暂停。
8. **Niconico**：确认匿名可读性；若必须登录，记录并暂停。

**禁止**：为通过验证而绕过验证码、伪造登录态、引入第三方签名服务或付费服务。
失败就写失败，标注 `BLOCKED`。

---

## 5. 本轮未做

- 未连接 Kick（也未连接任何新平台）。
- 未新增 `src/platforms/<新平台>/` 任何文件。
- 未新增依赖、未复制第三方代码。
- 未修改五个现有平台的采集逻辑。
- 未在界面、README、STATUS 中宣称任何新平台「已支持」。
