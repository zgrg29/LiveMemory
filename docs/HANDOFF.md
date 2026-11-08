# 交接文档（HANDOFF）

本轮：2026-11-08 · YouTube 免登录实验接入 · v0.3.0（schema v4）

## 1. 本轮目标

1. 实际查看五个开源项目的源码、许可证与可用性，而不是只读 README；
2. 实现无需用户 API Key / OAuth / Cookie 的 YouTube 直播聊天读取；
3. 尽可能取得稳定 Channel ID、昵称、原文、Emoji、badge、Super Chat、Super Sticker、会员与 gift；
4. 保持统一事件模型、去重、金额分账、SQLite、控制台、三语、主题与 EXE 不回归；
5. 用真实直播验证，重建 EXE，更新文档并本地提交（不 Push）。

## 2. 关键结论

| 问题 | 结论 |
| --- | --- |
| 有五套都能直接复用的开源实现吗？ | 否。`youtube-chat` 太脆弱且无 continuation；`pytchat` 已归档；`chat-downloader` 最完整但 Python 且停在 2023；`ytmemchat` 是 GPL-3.0 的 Go/桌面实现；`komet` 仓库没有源码。 |
| 免登录聊天真的可用吗？ | 是。真实双房间 35 秒采样成功，详见 `YOUTUBE_ANONYMOUS_RESEARCH.md`。 |
| 需要用户 API Key / Google 登录 / Cookie 吗？ | 不需要。请求不带 Cookie，不使用官方凭据。 |
| 稳定 Channel ID？ | 聊天/SC 100%；gift 0%（接口无该字段）。绝不拿昵称代替。 |
| Super Chat？ | 真实样本 `HK$2,000.00` → HKD 200000；保留原始显示字符串。 |
| Super Sticker / 会员？ | 映射已实现，真实未观测，标记未验证。 |
| 符合 YouTube 条款吗？ | **不能确认，且很可能违反 ToS。** 因此默认关闭，必须显式 opt-in；官方 API 仍是推荐。 |
| 原有官方 API/OAuth 路径？ | 完整保留，默认模式仍为 `official`。 |

## 3. 新增代码

```text
src/platforms/youtube/anonymous/parser.mjs   watch/live_chat/continuation/金额/emoji/badge 纯解析
src/platforms/youtube/anonymous/client.mjs   HTTP、页面重开、429/400/5xx 错误分层
src/platforms/youtube/anonymous/adapter.mjs  轮询、timeout、退避、重连、结束、gap 诊断
src/platforms/youtube/mapper.mjs             + mapYouTubeAnonymousChatItem
src/shared/badges.mjs                        badge 规范化
src/shared/capture-mode.mjs                  official / anonymous
src/storage/database/migrations/index.mjs    v4
src/storage/retention.mjs                    30 天上限 + nickname 清理
scripts/verify-youtube-anonymous.mjs         真实网络 E2E 采样
```

服务端新增/变化：

- `/api/youtube/video`、`/api/youtube/connect` 接受 `{mode}`；
- `/api/youtube/status` 增加 `officialConfigured`、`captureMode`、`anonymous`、`capabilities.modes`；
- `/api/settings` 增加 `youtubeCaptureMode`，`youtubeRawRetentionDays` 限制 1–30；
- `startServer` 新增 `youtubeWebBase`（只用于测试/自托管代理）。

## 4. 数据模型变化

- schema **4**：
  - `events.badges TEXT`：`[{type,label}]`，可空；
  - `events.amount_display TEXT`：平台显示的金额字符串，可空。
- `normalizeEvent` 会规范化 badges（最多 8 个，类型 owner/moderator/verified/member/unknown）。
- `events` 仓储、serializer、AI 包导出同步。
- `EventIngest` 与观众档案逻辑不变；所有匿名事件仍走同一写入路径。

## 5. 身份、金额、去重

- 身份：`authorExternalChannelId` → `youtube:<channelId>`。
- 无 Channel ID：
  - gift / 缺失字段 → `viewer_uid=null`、`identity_complete=false`、`source_quality=estimated/unknown`；
  - 不按昵称合并、不创建档案。
- 金额：
  - `purchaseAmountText.simpleText` 只提供格式化字符串；
  - 明确 `HK$`/`US$`/`A$`/`€`/`£`/`₹`/ISO code 等才解析；
  - 裸 `$`/`¥` 用页面 `client.gl`；无法确认则 null；
  - `amount_display` 始终保留可确认的原始字符串；
  - gift/会员数量/等级不换算金额。
- 去重：`ext:<message.id>`；ticker 展示不产生事件，所以不会重复累计 SC。
- 会员与 gift 的 `payment_event_count` 只在 `is_paid=true` 时计数；gift 金额未知但仍是付费互动。

## 6. 稳定性行为

- 轮询间隔来自服务端 `timeoutMs`（真实 10000ms），clamp 2–30s。
- 400 / `failedPrecondition`：重开 live_chat，保留 session；重复消息由 ingest 去重。
- 429：至少 30 秒退避 + `Retry-After`；连续 8 次失败停止并保存。
- 网络 / 5xx：指数退避 1→60 秒，不结束场次。
- 每 60 秒 watch 页检查直播状态；结束则自动结束场次。
- `chat disabled/ended/unavailable`：明确失败或结束。
- 相邻消息跨度 > 90 秒：`gapSuspected++`，UI 显示“可能漏消息”，不虚构确定遗漏。
- 启动失败不会留下 `live` 行；SessionManager 会结束失败场次。

## 7. 保留策略（本轮修正）

- 旧上限 3650 天与新上限 **30 天** 不一致，已改为 1–30。
- 清理：`content`、`emotes`、`badges`、`amount_display` + 过期 YouTube 观众昵称历史/当前昵称。
- 保留：事件行、计数、稳定 Channel ID、金额合计。
- 仍不等于完全删除个人数据；严格删除模式未实现，文档已明确。

## 8. 真实验证

| 房间 | 时长 | events | chat | 经济 | 身份 | 错误 |
| --- | --- | --- | --- | --- | --- | --- |
| `FKLZiufsCk0` | 35s | 86 | 85 | 1 SC HKD 200000 | 86/86 | 0 |
| `gXawf8GZDI8` | 35s | 100 | 87 | 13 gift（无金额） | chat 87/87；gift 0/13 | 0 |

- EXE 内真实匿名模式：72 条事件、72/72 Channel ID、0 错误；最终样本未出现付费事件。
- 未观测到 Super Sticker / 会员 / 赠送会员。
- 无官方凭据，未做官方 API 并排对照。

## 9. 测试与 EXE

- 自动化：**287 通过 / 0 失败 / ~17.7s**。
- 新增测试：匿名 parser、adapter 重连、完整 HTTP 集成、v1→v4 迁移、retention badges/nickname、settings 模式。
- EXE：**90.2 MB**，SHA-256 `9d586aa9cbe60274c6755b0b8ba8204cc111e6c8261b329868c38bb65190604c`，`verify-exe.mjs` **9/9**。
- 截图：`docs/screenshots/live-youtube-anonymous-*.png`、`settings-youtube-anonymous-zh-CN.png`。

## 10. 未验证 / 阻塞（必须如实保留）

- **条款合规未确认**：匿名网页接口很可能违反 YouTube ToS；正式发布前必须评估或取得许可。
- 官方 YouTube 真实验收仍缺凭据。
- Super Sticker、会员、赠送会员未在真实直播中出现。
- 真实 429、验证码、consent/age wall、长时断网、数小时直播未验证（只有自动化模拟）。
- 匿名接口只有 35 秒与 15 秒级真实样本，不能代表全部频道与地区。
- EXE 未在第二台干净 Windows 验收；未签名。
- 30 天清理不等同完全删除个人数据。

## 11. 常用命令

```bat
:: 测试
node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"

:: 真实匿名采样（聚合输出，不打印正文）
node scripts/verify-youtube-anonymous.mjs https://www.youtube.com/live/<ID> 35

:: 官方路径（可选，环境变量）
set LIVE_MEMORY_YOUTUBE_API_KEY=AIza...
set LIVE_MEMORY_YOUTUBE_CLIENT_ID=....apps.googleusercontent.com
set LIVE_MEMORY_YOUTUBE_CLIENT_SECRET=...

:: 构建与验证 EXE
node scripts/build-windows.mjs
node scripts/verify-exe.mjs
```

## 12. 下一轮建议

1. 合规评估匿名路径；若不允许发布，保留为开发者/内部模式。
2. 有官方凭据时做并排对照（消息数、身份率、付费事件、延迟、稳定性）。
3. **M6 AI 结果导入**：Schema、事务、重复导入保护。
4. M4 严格删除/去标识化与存储管理。

## 13. 本轮 Commit

- 本轮：`d314984` feat: record public YouTube Live chat without a developer key（本地，未 Push）
- 上一轮：`7a86e58` docs: cite the primary YouTube authorization and policy sources
