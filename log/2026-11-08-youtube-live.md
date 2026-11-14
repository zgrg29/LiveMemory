# 2026-11-08 · YouTube Live 真实接入（主播零 API Key 配置）

## 0. 目标

在不要求普通主播注册 Google Cloud / 申请 API Key 的前提下，真正接入 YouTube Live：定位直播、读取实时聊天、稳定观众身份、经济支持事件，并进入既有 SQLite / 控制台 / AI 包链路。

## 1. 先恢复上下文

- 阅读 `AGENTS.md`、`STATUS`、`HANDOFF`、`ROADMAP`、`ARCHITECTURE`、`DATA_MODEL`、`PLATFORM_INTEGRATIONS`、`PRIVACY_SECURITY`、`AI_CONTRACT`、`UI_DESIGN`、`WINDOWS_RUNTIME`、`TEST_PLAN`。
- 核对 Git：分支 `main`，上一轮 `02d3101`，工作区干净；提交身份为匿名 noreply。
- 核对代码：YouTube 只有 `mapper.mjs`；schema v2；Bilibili 真实接入与统一写入管线正常。

## 2. 研究结论（决定实现方向）

一手文档 + 实测：

1. 完全无凭据读取公开直播聊天**不可行**；ToS/Developer Policies 禁止抓取与未公开接口。
2. 公开数据（含公开直播聊天）**允许只用应用级 API Key**，不需要 Google 登录、不需要 OAuth。依据：Live Streaming 授权文档 "Use an API key for requests that only retrieve public data, such as public live chat messages"；`liveChatMessages.list` 参考页无 Authorization 小节。
3. 只有 `liveBroadcasts.list` 强制 OAuth；用 `videos.list` 的 `liveStreamingDetails.activeLiveChatId` 可完全绕开。
4. `liveChatMessages.streamList` 是 gRPC server-streaming，**没有 REST 路径**，不在 discovery 文档中 → 不能臆造，改用 `list` + `nextPageToken`。
5. 配额：默认 10,000/天；`videos.list`=1，`liveChatMessages.list`=5 → 约 2,000 次轮询/天。
6. 数据保留：公开聊天属于 Non-Authorized Data，Developer Policies III.E.4.d 要求 ≤ 30 个日历日；主播 OAuth **不能**为其他观众数据授权无限期保存。
7. 凭据分发冲突：Google 安装型应用文档称 client secret「不视为机密」，但 Developer Policies III.D.1.d 禁止在开源项目中嵌入 API 凭据；桌面 API Key 也无法限制到具体应用。→ **默认构建不含凭据**，由发布者一次性配置。

## 3. 实现

新增 `src/platforms/youtube/`：

| 文件 | 内容 |
| --- | --- |
| `link.mjs` | 链接/ID 解析，拒绝播放列表/频道/外站 |
| `api.mjs` | API Key + Bearer 双凭据、三接口、配额计费、reason→code |
| `oauth.mjs` | PKCE、授权 URL、单次回环接收器、交换/刷新/撤销、三语回调页 |
| `oauth-manager.mjs` | 登录状态机、重启恢复、自动刷新、过期处理 |
| `token-store.mjs` | AES-256-GCM 令牌存储 |
| `oauth-config.mjs` | 环境变量/数据目录/内置常量的凭据解析 |
| `mapper.mjs` | 全部事件类型、金额换算、会员语义 |
| `adapter.mjs` | 轮询/分页/退避/结束检测/配额守卫 |
| `service.mjs` | 路由粘合、保留策略触发 |

其他改动：

- `src/platforms/shared/secret-store.mjs`：通用加密 JSON 存储。
- `src/storage/retention.mjs`：30 天原文保留策略。
- schema v3：`sessions.platform_started_at`。
- `EventIngest` / `viewers`：付费计数改为必须 `is_paid=true`。
- `normalizeEvent`：无金额事件不再臆造默认币种。
- 路由 `/api/youtube/*`；`startServer({youtubeApiBase})` 供本地假 API 测试。
- 直播页新增 YouTube 标签、登录流程、检查/开始/停止、配额与保留策略、连接/观看人数指示、Super Sticker 与会员留言显示。
- 三语新增约 40 个键（`live.source.youtube*`、`errors.youtube*`）。
- AI 包：`broadcast_started_at` 与 `offset_seconds`。
- 版本 0.2.0。

## 4. 验证

- 自动化 **259 通过 / 0 失败 / 约 6.5 秒**；新增 8 个测试文件（含本地假 API 集成）。
- EXE：90.1 MB，`a1becfb6…`，`verify-exe.mjs` 9/9；EXE 内 schema=3、YouTube 未配置状态清晰。
- UI 截图 5 张（明亮/黑暗/窄屏/录制中/未配置），通过无头 Edge + DevTools 验证真实渲染与交互（点击标签、真实事件流）。

## 5. 未能完成 / 原因

- **没有真实 Google 凭据**：无法对真实直播采样，无法给出真实消息条数与身份完整率，也无法在线验证真实 OAuth 同意屏与 refresh token 过期规则。
- 端到端是本地假 API，严格按官方响应结构返回；不能称为真实平台验收。
- 30 天保留依据公开条款实现，未获 Google 书面确认。

## 6. 下一轮

1. 有凭据环境完成 YouTube 真实验收并回填数据。
2. M6：AI 结果导入与 Schema 校验。
3. M4：存储管理（自动精简、删除场次/观众）。
