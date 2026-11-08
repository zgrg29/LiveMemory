# 交接文档（HANDOFF）

本轮：2026-11-08 · YouTube Live 真实接入 · v0.2.0（schema v3）

## 1. 本轮目标

1. 研究并实现「普通主播零 API Key 配置」的 YouTube Live 接入；
2. 只接入直播：定位直播、确认直播状态、读取实时聊天、稳定观众身份、经济支持事件；
3. 保持统一事件模型、去重、金额分账、SQLite、控制台、三语与主题不回归；
4. 跑测试、重建 EXE、更新文档、创建本地 Commit（不 Push）。

## 2. 关键结论（先看这里）

| 问题 | 结论 | 依据 |
| --- | --- | --- |
| 能否完全无凭据读取公开直播聊天？ | **不能** | 官方 API 需要 caller identity；ToS/政策禁止抓取与未公开接口 |
| 能否用应用级 API Key 读取公开聊天（无需 Google 登录 / OAuth）？ | **可以** | Live Streaming 授权文档：API Key 用于 "requests that only retrieve public data, such as public live chat messages"；`liveChatMessages.list` 参考页无 Authorization 小节 |
| 定位直播需要什么？ | API Key 或 OAuth | `videos.list` + `liveStreamingDetails.activeLiveChatId` |
| 主播自己的频道信息需要什么？ | OAuth | `channels.list?mine=true` |
| 能否把开发者 Key 内嵌进公开 EXE？ | **不能** | Developer Policies III.D.1.d 禁止在开源项目中嵌入 API 凭据；桌面端 Key 无法有效限制 |
| 公众聊天能存多久？ | **≤30 个日历日** | Developer Policies III.E.4.d（Non-Authorized Data） |

因此实现两种官方模式，运行时自动选择，**默认构建不含任何凭据**：

- `api-key`：应用级 Key（环境变量或数据目录私有配置文件提供），匿名读取公开直播；
- `oauth`：主播一次点击登录 Google（桌面应用 PKCE + 回环回调），自动刷新、可退出、可失效重登。

## 3. 新增代码

```text
src/platforms/youtube/
  link.mjs          直播链接/视频 ID 解析（只接受直播相关形式）
  api.mjs           Data API v3 客户端、双凭据、配额计费、错误映射
  oauth.mjs         PKCE、授权 URL、回环接收器、token 交换/刷新/撤销
  oauth-manager.mjs 登录状态机、重启恢复、自动刷新、过期处理
  token-store.mjs   加密保存 YouTube 令牌
  oauth-config.mjs  开发者一次性配置（client id/secret、可选 API Key）
  mapper.mjs        chat / Super Chat / Super Sticker / 会员 / 赠送会员 → canonical
  adapter.mjs       轮询、分页、退避重连、结束检测、配额守卫
  service.mjs       路由与 SessionManager 的粘合层
src/platforms/shared/secret-store.mjs   通用 AES-256-GCM 加密 JSON 存储
src/storage/retention.mjs               YouTube 原文保留策略
```

服务端新增 `/api/youtube/{status,login/start,login/status,login/logout,video,connect,disconnect,retention/apply}`。
`startServer` 新增 `youtubeApiBase`（仅用于本地假 API 的自动化测试与自托管代理）。

## 4. 数据模型变化

- schema **3**：`ALTER TABLE sessions ADD COLUMN platform_started_at INTEGER`（平台侧直播开始时间）。
- `serializeSessionRow` / `buildSessionSummary` / `SessionManager.status()` 增加 `platformStartedAt`。
- `EventIngest` 与 `viewers` 的付费计数改为 **必须 `is_paid=true`**：赠送会员接收者、免费礼物不再计入付费事件。
- `normalizeEvent` 不再为「没有金额」的事件臆造默认币种（`currency` 保持 `null`）。

## 5. 金额与身份规则（YouTube）

- Super Chat / Super Sticker：`amountMicros`（字符串）→ BigInt 除法 + 半进位 → 整数最小单位；`value_kind=actual`；币种来自官方字段，绝不合并不同币种。
- 会员：记录等级、里程碑月数、赠送数量；**不换算金额**，`amount_minor=null`、`value_kind=unknown`。
- 收到赠送会员：`is_paid=false`、`gift_type=free`、记录 `gifter_channel_id` 与来源消息 ID，不计为付款者。
- 身份：`youtube:<channelId>`；只有昵称时 `viewer_uid=null`、`identity_complete=false`，不按昵称合并。
- 事件 `source_quality=estimated`（官方字段但尚未真实直播采样）；`verified` 只在真实样本后使用。

## 6. 保留策略

- 默认 30 天（`settings.youtubeRawRetentionDays`，1–3650）。
- 触发：应用启动、YouTube 场次结束、`POST /api/youtube/retention/apply`（面板按钮）。
- 只清 `content` / `emotes` 并写 `content_purged_at`；行、计数、身份、昵称历史、币种合计保留。
- 只作用于 `platform='youtube'`；Bilibili 数据不动。
- `app_meta['retention.lastRun']` 记录最近一次结果；`/api/youtube/status.policy` 展示。

## 7. 测试与验证

- 自动化：**259 通过 / 0 失败 / 约 6.5 秒**。
- 新增：链接解析、官方错误映射、配额、PKCE/回环/交换/刷新、状态机与重启恢复、令牌加密与篡改、全部经济事件、`amountMicros`、轮询/重连/结束/配额、保留策略、v1→v3 迁移。
- 集成：本地假 YouTube API（严格官方响应结构）跑通「连接 → 入库 → 观众 → 多币种 → 历史 → 保留」。
- EXE：90.1 MB，SHA-256 `a1becfb6…`，`verify-exe.mjs` 9/9；EXE 内 schema=3、未配置状态清晰。
- UI：5 张截图（明亮/黑暗/窄屏/录制中/未配置）。

## 8. 未验证 / 阻塞（必须如实保留）

- **无真实 Google 凭据** → 未对真实 YouTube 直播采样；没有真实消息数、身份完整率、真实 Super Chat 样本。
- OAuth 只在本地回环 + 假 token 端点验证；未验证真实同意屏、真实 refresh token 行为（Testing 应用 7 天过期、未验证应用 100 用户上限）。
- 30 天保留是依据公开条款的实现，未获 Google 书面确认。
- 真实断网/配额耗尽的长时行为未验证；配额守卫与退避只有自动化测试。
- EXE 未在第二台干净 Windows 验收；未签名。

## 9. 常用命令

```bat
:: 测试
node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"

:: 开发运行（可选：用环境变量提供公开数据 Key）
set LIVE_MEMORY_YOUTUBE_API_KEY=AIza...
node src/launcher/launcher.mjs

:: OAuth 客户端（仅开发/构建环境，切勿提交）
set LIVE_MEMORY_YOUTUBE_CLIENT_ID=....apps.googleusercontent.com
set LIVE_MEMORY_YOUTUBE_CLIENT_SECRET=...

:: 构建与验证 EXE
node scripts/build-windows.mjs
node scripts/verify-exe.mjs
```

## 10. 下一轮建议

1. **在持有凭据的环境完成 YouTube 真实验收**：公开直播聊天、Super Chat、会员、断网重连、配额耗尽；记录真实条数与身份完整率，写入 `PLATFORM_INTEGRATIONS.md` 与 `TEST_PLAN.md`。
2. **M6 起步：AI 结果导入**（Schema 校验 → 事务写入 → 重复导入保护）。
3. M4 存储管理（自动精简、删除场次/观众）。

## 11. 本轮 Commit

- 本轮：`aa27417`（本地，未 Push）
- 上一轮：`02d3101` feat: preserve chat emoji and generalize the AI analysis centre
