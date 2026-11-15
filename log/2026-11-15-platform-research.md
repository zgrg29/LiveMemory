# 2026-11-15 多平台直播接入技术调查（TikTok / Twitch / 抖音）

## 目标

调查并验证 LiveMemory 扩展 TikTok LIVE、Twitch、抖音直播的可行性，重点回答：

- 能否取得观众昵称与稳定用户 ID？
- 能否取得实时弹幕原文？
- 能否取得礼物/打赏/订阅等付费互动及其价值？
- 官方 API、开源方案、许可证、维护与 Node SEA 兼容性如何？
- 下一轮应该先做哪个平台？

## 边界

- **只调查与只读验证**：没有修改 `src/`、数据库、AI、备份、Bilibili/YouTube 采集或版本号。
- 没有新增运行时依赖；所有第三方库只装在系统临时目录，验证后删除。
- 没有登录 Twitch/TikTok/抖音账号，没有提供 Cookie，没有购买/赠送礼物、订阅或打赏。
- 没有绕过 TikTok WAF/验证码/登录限制；TikTok 被阻断后停止。
- 没有保存或展示聊天正文；只统计字段、数量与长度。
- 未 Push、未 Tag、未发布。

## 环境

- Windows；Node.js v24.21.0（DSH 自带运行时）。
- 2026-11-15 10:10–10:45 Asia/Shanghai。
- 网络可访问 Twitch/TikTok/抖音/GitHub/npm；PowerShell 旧 TLS 栈失败，改用 Node `fetch`/WebSocket。

## 做了什么

### 1. 阅读现有工程

- `AGENTS.md`、`docs/STATUS.md`、`docs/HANDOFF.md`、`docs/ROADMAP.md`、`docs/PLATFORM_INTEGRATIONS.md`。
- `src/shared/events.mjs`、`src/platforms/shared/ingest.mjs`、`adapter.mjs`、`session-manager.mjs`。
- `src/monitoring/manager.mjs`、`detectors/bilibili.mjs`、`detectors/youtube.mjs`。
- `src/storage/database/migrations/index.mjs` 的 events/viewers/sessions 表；`src/shared/money.mjs`。
- `git status` 干净（Git 使用 GitHub Desktop 自带 `git.exe`，因为 PATH 中没有 git）。

### 2. Twitch 真实只读探测

- 匿名 IRC：`wss://irc-ws.chat.twitch.tv:443`，`CAP REQ :twitch.tv/tags twitch.tv/commands`，`NICK justinfan98765`。
- 加入 `xqc/shroud/sodapoppin/moonmoon/ludwig`。
- 45 秒：644 PRIVMSG，644/644 有 `user-id`/`display-name`/消息 `id`；ROOMSTATE 5；USERNOTICE 3。
- 25 秒：239 条，非 ASCII 8，`emotes` 9，0 重复 ID，Bits 0。
- `ROOMSTATE #xqc` 返回 `room-id=71092938`。
- EventSub：`wss://eventsub.wss.twitch.tv/ws` 返回 `session_welcome`（keepalive 10s）；无 Token 创建 `channel.chat.message` 订阅返回 401 `OAuth token is missing`。
- 公开频道页 `isLiveBroadcast` 扫描 24 个频道，8 个 LIVE。

### 3. 抖音真实只读探测

- 下载 dyhub 0.3.1 源码到临时目录；pnpm 安装、直接 `tsc` 构建（`pnpm run` 在该环境试图 spawn Harness exe，改用 tsc）。
- `DYHUB_COLLECTOR=lightweight`，本机 127.0.0.1:8758。
- 创建空账号（无 Cookie），连接 `708764876300`。
- 结果：`status=live`，`frameCount=42`，约 7 秒 175 条消息，meta 为东方甄选官方旗舰店。
- 45 秒事件：16 chat / 192 member / 25 like / 3 follow / 8 room / 0 gift。
- 30 秒 chat：13 条，13/13 有 `user.id`、昵称、`secUid`、消息 ID，13/13 含 CJK，0 重复。
- 公开页：`room.status=2`（直播）、`4`（结束）。
- 匿名 0 gift，与 README/源码“2026 年起礼物只推登录会话”一致；没有 Cookie，未验证礼物。

### 4. TikTok 验证

- 临时安装 `tiktok-live-connector@2.5.0`（60 包）与 `2.4.4`，连接 Euler 排行榜 LIVE 账号 `pollofrito1985`。
- 两者均在 `fetchWebcastSignatureFromEulerRoute` 失败：`This endpoint requires a Business plan`。
- `1.2.3` 本地签名请求 5 秒超时，无事件。
- TikTok 页面返回 WAF “Please wait...” 挑战壳；未绕过。
- **没有取得任何真实 TikTok 事件。**

### 5. 官方文档与开源项目调查

- Twitch EventSub/IRC/OAuth/DCF、订阅限制、WebSocket 限制。
- TikTok Products/Webhooks、Euler 定价与 Business 端点。
- 抖音官方直播玩法 FAQ（提案/软著/审核、最多 10 个弹幕指令）。
- GitHub API：TTLC、TikTokLive、dyhub、douyin-live-toolkit、douyin-live-danmu、BarrageGrab、DouyinLiveRecorder、cyber-xiaoya、Twurple、Twitch CLI；核对 license、push、stars、issues、依赖。
- 关键许可证：TTLC/TikTokLive/douyin-live-toolkit/BarrageGrab/cyber-xiaoya 为 AGPL；dyhub 核心 MIT 但 lightweight 签名脚本 AGPL；douyin-live-danmu 无许可证；DouyinLiveRecorder 仅录制。

## 结果

| 项目 | 结果 |
| --- | --- |
| Twitch 真实聊天/身份 | 644/45s；644/644 有稳定 User ID + 昵称 + 消息 ID；0 重复样本 |
| Twitch 付费 | 订阅/续订/赠订 USERNOTICE 有；Bits 未观测 |
| 抖音真实聊天/身份 | 13/13 有 UID/昵称/secUid/消息 ID/CJK；0 重复 |
| 抖音礼物 | 匿名 0；需登录 Cookie；未验证 |
| TikTok | 未连接成功；付费签名 + AGPL + WAF |
| 代码/DB/AI | 未修改 |
| 测试 | 未跑全量（无代码改动，不适用）；未新增测试 |
| 提交 | 仅文档；未 Push/Tag/Release |

## 结论

1. **Twitch 第一个正式开发**：免登录公开聊天、稳定 ID、消息 ID、订阅/赠订有真实证据；零新增依赖，适合 SEA；匿名 IRC 未文档化，需标注并准备 EventSub 备选。
2. **抖音第二个，但先决策**：匿名弹幕/身份可用；礼物必须登录 Cookie；签名脚本 AGPL；官方小玩法不是通用采集；逆向协议有风控/条款风险。
3. **TikTok 暂缓**：官方无公开 LIVE API；第三方签名需 Euler Business（$50/月起）；AGPL、60 依赖、漏消息、WAF。
4. **金额**：三平台都不能把虚拟礼物展示价值当收入；无本币金额时 `amount_minor=null`、`value_kind=unknown`。
5. **兼容性**：所有事件仍经 `EventIngest`；现有 schema 可表达聊天/礼物/订阅，但连送组/Tier/月数/Bits/赠订双方/虚拟币需要映射方案，本轮不改库。

## 修改的文件

- 新增 `docs/PLATFORM_RESEARCH_TIKTOK_TWITCH_DOUYIN.md`
- 更新 `docs/STATUS.md` §0.33
- 更新 `docs/HANDOFF.md` §0
- 更新 `docs/ROADMAP.md` P26
- 更新 `docs/PLATFORM_INTEGRATIONS.md` §10
- 更新 `docs/TEST_PLAN.md` §45
- 新增本日志

## 下一步

等待用户确认：

- 是否按 Twitch 方案开始正式开发；
- 抖音是否接受登录 Cookie 与 AGPL；
- TikTok 是否暂缓，或采用用户自备 Euler Business Key 的实验方案；
- 原始聊天保留期是否统一 30 天。

未经确认不开始改代码。
