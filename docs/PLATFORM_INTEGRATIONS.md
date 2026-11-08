# 平台接入（PLATFORM_INTEGRATIONS）

状态：**所有真实平台接入尚未实现**。本文记录已核实的参考实现、待验证项与设计约束。模拟平台（mock）已完整实现并通过测试。

## 1. 参考仓库分析（只读，不修改）

仓库：`https://github.com/zgrg29/bili-gift-drop`（克隆到 `.ref/bili-gift-drop`，已 gitignore）

已核实的内容：

| 能力 | 参考文件 | 结论 |
| --- | --- | --- |
| Bilibili 扫码登录 | `src/server/login.mjs` | `passport-login/web/qrcode/generate` + `poll`；`code=0/86090/86038`；从 Set-Cookie 与跳转 URL 提取 `SESSDATA`、`bili_jct`、`DedeUserID`、`buvid3` 等 |
| 登录校验 | `login.mjs` → `nav` 接口 | `data.isLogin` + `mid` + `uname` + `face` |
| 直播间信息 | `src/server/bilibili.mjs` | `/room/v1/Room/room_init?id=` 获取真实 `room_id` |
| WebSocket 鉴权 | `bilibili.mjs` + `wbi.mjs` | `getDanmuInfo` 需要 WBI 签名与 buvid3，返回 `token` 与 `host_list` |
| 协议编解码 | `src/server/protocol.mjs` | 16 字节头，op=5/8，version 2=zlib、3=brotli；心跳 op=2；鉴权 op=7 |
| 心跳/重连 | `bilibili.mjs` | 30s 心跳、65s 看门狗、指数退避（上限 30s） |
| 礼物 | `src/server/gift-v2.mjs`、`src/shared/gift-names.mjs` | 礼物名/价格映射，需按当前接口再核对单位 |
| SC | `src/shared/superchat.mjs` | SC 事件字段与金额、持续时间 |
| 大航海 | `src/overlay/guard.mjs` 等 | 舰长/提督/总督三级，价格按月 |
| 多语言 | `src/shared/i18n/{zh-CN,ja,en}.mjs` | 键值结构可参考，文案不复用（产品不同） |
| 身份 | 登录流程 | `DedeUserID` 为主播自身 UID，观众 UID 来自消息字段 |
| 去重 | 参考项目按事件特征 | LiveMemory 使用 `UNIQUE(session_id, dedupe_key)` + 指纹兜底 |

**不能直接复制**：旧项目面向礼物特效，没有观众长期档案与多币种账本；协议字段、礼物价格单位、授权要求必须用当前真实直播间重新验证。

## 2. Bilibili（M3 计划）

### 2.1 授权

- 扫码登录只用于**主播本人**的连接（部分接口/房间需要登录态）。
- Cookie 属于敏感凭据：不得写入日志；默认不进入备份；仅在内存中保存，可选加密持久化。
- 观众身份来自弹幕消息中的 UID，不需要观众登录。

### 2.2 事件映射（待验证字段）

| Bilibili 消息 | LiveMemory `event_type` |
| --- | --- |
| `DANMU_MSG` | `chat` |
| `SEND_GIFT` | `gift`（`gift_type` 取决于是否付费） |
| `SUPER_CHAT_MESSAGE` | `super_chat` |
| `GUARD_BUY` | `guard` |
| `USER_TOAST_MSG` / 会员相关 | `membership` |
| 系统/开播/下播 | `system` |

金额：Bilibili 使用金瓜子/银瓜子，需确认 **1 CNY = 1000 金瓜子** 的换算后再转为 `amount_minor`，并标注 `value_kind`（实际支付或展示价值）。**在单位确认前不得累计金额。**

### 2.3 待验证清单

- [ ] 登录二维码接口当前是否需要额外头/签名
- [ ] `getDanmuInfo` 的 WBI 签名参数与 buvid 要求
- [ ] 弹幕消息中 UID、昵称、粉丝牌、房管字段是否齐全
- [ ] 礼物 `price`、`coin_type`、`discount_price` 的真实含义
- [ ] SC 金额单位与持续时间
- [ ] 大航海等级与价格
- [ ] 断线重连后的消息重复率
- [ ] 未登录状态可读取哪些事件

## 3. YouTube（M3 计划）

### 3.1 授权层级（必须区分）

| 方案 | 需要观众登录 | 需要主播 OAuth | 需要 API Key | 可获取 |
| --- | --- | --- | --- | --- |
| Live Chat 只读（公开直播） | 否 | 否 | **是** | 聊天、作者名、时间戳、部分付费事件 |
| OAuth 主播授权 | — | 是 | 是 | 私有直播、频道信息 |
| 官方 Data API + 直播聊天轮询 | 否 | 否 | 是 | 公开直播聊天（分页/polling） |

第一版优先实现 **API Key + 公开直播读取**，不要求用户登录 YouTube。若某些事件（如会员赠送）无法通过公开接口获得，则标记为不可用，而不是伪造。

### 3.2 事件映射

| YouTube | LiveMemory |
| --- | --- |
| `textMessageEvent` | `chat` |
| `superChatEvent` | `super_chat` |
| `superStickerEvent` | `super_sticker` |
| `newSponsorEvent` / `memberMilestoneChatEvent` | `membership` |
| `sponsorOnlyModeStartedEvent` 等 | `system` |

币种：YouTube 直接给出币种与微单位（`amountMicros`），需转换为最小货币单位并保留 `currency`。

### 3.3 待验证清单

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
2. 生成稳定 `external_id`（无则留空，由指纹去重）；
3. 确认金额单位与币种，否则 `amount_minor=null`、`value_kind=unknown`；
4. 标注 `source_quality`（`verified` 仅用于字段实测确认后）；
5. 通过 `EventIngest` 写入。

## 5. 真实性标注

- `mock` 平台永远 `source_quality=mock`，UI 显示“模拟”。
- 字段未逐项验证的平台事件标 `unknown` 或 `estimated`。
- 不得把模拟测试通过描述为真实平台接入完成。
- 真实平台验收需在 `docs/TEST_PLAN.md` 记录：房间号、时间、事件类型、字段核对结果。
