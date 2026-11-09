# 架构（ARCHITECTURE）

## 1. 总览

```text
LiveMemory.exe (Node SEA)
└─ scripts/sea-bootstrap.cjs            解压内嵌资源 → 调用启动器
   └─ src/launcher/launcher.mjs         环境/数据目录/单实例/端口/浏览器/退出
      └─ src/server/index.mjs           startServer(): 设置 → DB → 迁移 → 恢复 → HTTP
         ├─ src/server/http.mjs         安全头、Host/Origin 校验、静态服务、JSON
         ├─ src/server/routes.mjs       API 路由
         ├─ src/server/sse.mjs          EventStream（实时推送）
         ├─ src/server/settings-store.mjs  config/settings.json
         ├─ src/server/relocation.mjs    数据目录迁移/回滚
         ├─ src/server/maintenance.mjs   清空数据/出厂快照
         ├─ src/server/session-admin.mjs 单场停止/归档/永久删除（列表与详情共用）
         ├─ src/server/native-dialog.mjs 原生目录选择/打开文件夹
         ├─ src/server/logger.mjs        脱敏 JSONL 日志
         ├─ src/storage/                node:sqlite + 迁移 + 仓储（含 broadcasters）
         ├─ src/shared/data-location.mjs 启动位置记录（LOCALAPPDATA + APPDATA 镜像）
         ├─ src/platforms/shared/       适配器契约、EventIngest、SessionManager（多场并发）
         ├─ src/platforms/mock/         模拟直播源
         ├─ src/platforms/bilibili/     真实直播适配器（WebSocket，可多房间）
         ├─ src/platforms/youtube/      公开网页聊天（唯一路径；可多直播）
         ├─ src/platforms/youtube/anonymous/  公开页面 parser/client/adapter
         ├─ src/storage/retention.mjs   YouTube 原文/badge/过期昵称保留策略
         ├─ src/analytics/              只读读模型（时间线/汇总/画像）
         └─ src/ai/export/              分析包生成（含表情字典）
   └─ src/web/                          浏览器控制台（原生 ES Modules）
```

## 2. 启动时序

1. 解析参数（`--no-open`、`--port`、`--data-dir`、`--lang`）。
2. `chcp 65001` 设置控制台 UTF-8；解析系统语言。
3. 检查 Node 版本与 `node:sqlite`。
4. 解析数据目录：显式 `--data-dir` / `LIVE_MEMORY_DATA_DIR` 优先；否则读取 `data-location.json`（`%LOCALAPPDATA%\LiveMemory`，镜像 `%APPDATA%`）；只有记录目标已存在且含数据库才使用，否则显示不可用错误，不创建空库；最后才回退默认目录。创建子目录并写探针。
5. 读取 `config/settings.json`，确定命令行语言（保存的偏好优先，`--lang` 覆盖）。
6. 获取单实例锁 `runtime/instance.lock`；若已有存活实例，打印地址并打开浏览器后退出。
7. `startServer()`：
   - 迁移数据库并记录 schema 版本
   - 将遗留 `live` 场次标记为 `interrupted`
   - 绑定 `127.0.0.1:preferredPort`（冲突 +1…+9，最后 0）
   - 写 `runtime/runtime.json`（pid/port/url）
8. 打印数据目录、控制台地址、日志目录、连接状态、退出方式。
9. 打开系统默认浏览器（`cmd /c start "" <url>`）。
10. 等待 SIGINT/SIGTERM 或服务关闭 → 逆序关闭并清理 runtime 文件。

## 3. 事件数据流

```text
平台适配器（Bilibili/YouTube/mock）
  └─ normalizeEvent()  → canonical event（shared/events.mjs）
      ├─ content 原文 / Unicode Emoji 原样保留
      └─ emotes 可选最小元数据（id/code/name/source）
      └─ EventIngest.record()  [单事务]
          ├─ ensureViewer()              先建身份（满足外键）
          ├─ insertEvent()               INSERT OR IGNORE（唯一去重键）
          ├─ recordViewerActivity()      观众全局计数/昵称/场次/币种累计
          ├─ recordViewerBroadcasterActivity()  当前主播维度的计数与币种累计
          ├─ recordSessionPayment()      场次币种累计（actual/display）
          └─ incrementSessionCounters()  消息/礼物/付费事件/最后事件时间
      └─ commit → SSE 'event' 广播 → 控制台即时渲染
```

**关键保证**：重复事件在 `insertEvent` 处返回 `changes=0`，后续聚合全部跳过，因此金额与计数不会翻倍。表情元数据参与指纹去重，但不改变 `content` 原文。

## 3.0 主播维度上下文（schema v5）

```text
SessionManager.startPlatform({platform, platformRoomId, broadcasterUid, broadcasterName})
  └─ resolveBroadcasterIdentity()
      ├─ youtube: channelId → youtube:<channelId>（verified）
      ├─ bilibili: anchorUid → bilibili:<uid>（verified）
      │           否则 roomId → bilibili:room:<roomId>（room_fallback）
      ├─ mock → mock:simulation（simulated）
      └─ 缺失 → id=null（unresolved；场次保留但不归入任何主播）
  └─ upsertBroadcaster() → sessions.broadcaster_id / broadcaster_identity
  └─ EventIngest 同事务更新 viewer_broadcasters 与 viewer_broadcaster_currency_totals
```

- 观众身份仍是平台全局 `platform:stable_uid`；主播维度只增加互动上下文，不复制观众身份。
- 旧的 YouTube 场次只有视频 ID，迁移时保持 `unresolved`；Bilibili room fallback 明确标记质量。
- 读模型：`buildViewerProfile(db, viewerId, {broadcasterId|unassigned})` 返回 `scope` + 全局 `lifetime`；榜单查询限定 `broadcaster_id`。
- AI 包只导出当前主播的 `broadcaster_context`；`lifetime` 标注为全局；其他主播只给 `other_broadcaster_count`。

## 3.1 YouTube 公开网页数据流（唯一路径，v0.5.0）

```text
parseYouTubeInput(link) → YouTubeService.checkVideo()
  ├─ GET /watch?v=ID       → ytInitialPlayerResponse / ytInitialData
  ├─ GET /live_chat?v=ID   → ytcfg + liveChatRenderer 首批 actions + continuation
  ├─ 非直播/未开始/已结束/聊天关闭 → 明确错误码（三语）
  └─ 可记录 → SessionManager.startPlatform({platformStartedAt, broadcasterUid})
               → YouTubeAnonymousLiveChatAdapter.start()
                   ├─ POST /youtubei/v1/live_chat/get_live_chat
                   │    body {context, continuation} → actions + 新 continuation + timeoutMs
                   └─ actions → mapper.mjs → canonical draft
                        → EventIngest（去重/观众/金额/计数）
                        → SSE → 控制台
```

- 不发送 Cookie、OAuth token 或用户 API Key；只使用公开页面自身的客户端上下文。
- 只有这一条 YouTube 路径；官方 Data API/OAuth/API Key 实现已删除。
- 该接口不是官方稳定 API，可能违反 YouTube ToS；不绕过访问控制，失败不伪装成功。
- continuation：每页更新；400/`failedPrecondition` 重开 live_chat；429/网络指数退避；连续 8 次失败停止并保存。
- 身份：`authorExternalChannelId` → `youtube:<channelId>`；新版 gift 无该字段时 `viewer_uid=null`，不按昵称合并。
- 金额：只解析可确认的格式化金额；`amount_display` 保留原文，无法确认时 `amount_minor=null`。

## 3.2 保留策略

`src/storage/retention.mjs` 在启动、YouTube 场次结束与手动调用时清理超过窗口（默认/上限 30 天）的 YouTube 聊天原文、emote/badge 元数据、金额显示文本和过期昵称；保留事件行、计数、稳定 Channel ID 与金额合计。目的与局限见 `PRIVACY_SECURITY.md` §14。

## 3.3 多场并发记录（v0.6.0）

```text
SessionManager.recordings: Map<sessionId, recording>
  recording = {
    sessionId, platform, platformRoomId, adapter,
    connection, detail, startedAt, broadcasterId, meta, onEnded, stopping
  }

startPlatform()
  ├─ findDuplicate(platform, roomId)
  │    ├─ 内存 recordings 同 platform+room → 拒绝
  │    └─ sessions WHERE status='live' 同房间 → 拒绝
  ├─ createSession() → 独立 DB 行
  ├─ recordings.set(sessionId, recording)
  ├─ adapter.start({onEvent, onStateChange, onEnd})
  │    └─ onEvent 闭包固定写入该 session.id
  └─ 失败：只结束该 session 并从 map 移除

stopSession(sessionId)
  ├─ 只停止该 recording 的 adapter
  ├─ endSession(该 id)
  ├─ onEnded（YouTube 保留清理等）
  └─ 广播 status
```

关键保证：

- 每场有独立 adapter、连接状态、错误状态、事件闭包与数据库行；一场失败/结束/停止不会触碰其他场。
- 同一 `platform + room` 不会创建第二个 live session；重复启动返回 `409 SESSION_DUPLICATE_ROOM`。
- 所有事件仍进入唯一写入路径 `EventIngest`；去重键为 `(session_id, dedupe_key)`，所以同一 `external_id` 可以合法存在于两个不同场次。
- 前端通过 `GET /api/live/recordings` 读取运行任务；采集不依赖任何浏览器页面是否打开。
- 软件启动时 `recoverInterrupted()` 把所有残留 live 行标记 interrupted，不自动恢复或新建场次。
- 单进程 `node:sqlite` 同步写入；多个 adapter 的回调在事件循环中串行进入事务，WAL + `busy_timeout` 保证一致性。

## 3.4 场次生命周期管理（v0.7.0）

```text
停止：POST /api/sessions/:id/stop
      POST /api/live/recordings/:id/stop
  └─ session-admin.stopSessionRecording()
      ├─ 目标行必须 status='live'，否则 409 SESSION_NOT_ACTIVE
      ├─ SessionManager.stopSession(id)（只动该场 adapter）
      └─ sessions.status='ended', end_reason='user', ended_at

归档：POST /api/sessions/:id/archive {archived}
  └─ session-admin.archiveSession()
      ├─ live 或仍有 adapter → 409 SESSION_ARCHIVE_LIVE
      ├─ archived_at = COALESCE(archived_at, now)（独立于 status）
      └─ 取消归档：archived_at = NULL

删除：DELETE /api/sessions/:id {confirm:true}
  └─ session-admin.deleteSessionRecord()
      ├─ 守卫：confirm === true；status!=='live' 且无内存 recording
      ├─ 读取受影响 viewer ids + 该场 ai_packages 文件清单
      ├─ BEGIN IMMEDIATE
      │   ├─ DELETE ai_packages / session_currency_totals / viewer_sessions / events
      │   ├─ DELETE sessions（FK 级联兜底）
      │   ├─ 每个受影响 viewer：rebuildViewerAggregates()
      │   │      仍保留 → rebuildViewerBroadcasterAggregates()
      │   ├─ 清理无场次且无关系的 broadcasters
      │   └─ assertNoResidue(session_id) → 任一残留则抛错回滚
      ├─ COMMIT
      └─ 删除 exports/ 内该场分析包文件（safeExportPath 防穿越）
```

- 停止**不**代表平台直播结束：`status` 只描述本地采集；UI 用 `end_reason` 区分「已停止记录 / 已结束」。
- 归档不改变采集状态，不删除任何数据。
- 删除后观众/主播衍生数据按剩余证据重建，避免“删了场次但长期统计仍有旧数据”。
- 搜索与删除都只走这一处业务模块，列表页与详情页不会出现两套行为。

## 4. 读模型

- `analytics/sessions/hotness.mjs`：按场次时长选择 10s–1h 的桶；输出消息数、独立观众、按币种支付；直播中不绘制未完成的桶。
- `analytics/sessions/summary.mjs`：场次摘要 + 时间线 + 支持 + 活跃观众（默认前 5，可传 `topLimit`）+ 存储统计。
- `analytics/sessions/leaderboard.mjs`：单场 Top 100 读模型；`rank` 按有效弹幕数 → `platform_uid` → `viewer_id` 稳定排序；搜索只在 Top 100 内过滤且保留原始名次。
- `analytics/sessions/history-search.mjs`：历史搜索读模型；`scope=all|broadcaster|title|viewer`，组合平台/状态/日期/归档筛选；只查场次与身份关系表，不读聊天正文；`LIKE` 通配符转义；返回匹配原因与实际参与身份。
- `analytics/viewers/profile.mjs`：观众档案（身份、累计、昵称历史、参与场次）。
- `analytics/payments/totals.mjs`：按币种合并 actual/display，绝不混加。

### 4.1 AI 分析包（文本优先）

- `messages.jsonl` 保留 `content` 原文；Unicode Emoji 不转换。
- 平台表情进入 `session_context.emote_dictionary`，消息通过 `emote_refs` 引用；同一表情只存一份元数据。
- 仅当原文不足以理解表情时，才增加 `content_ai`；未知表情标记 `[未知平台表情：emote_id=…]`，不猜情绪。
- 不打包表情图片；包大小主要由文本和聚合决定。
- `instructions.md` 由 `src/ai/prompts/instructions.mjs` 按 `locale` 生成，包含话题、观众画像、经济支持、Emoji/表情、数据可靠性与不可信数据规则。

## 5. HTTP API（v0.1.0）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 存活检查 |
| GET | `/api/bootstrap` | 应用、设置、状态、能力矩阵 |
| GET | `/api/status` | 服务/平台/数据库状态 |
| GET/PATCH | `/api/settings` | 读取/更新偏好（校验后持久化） |
| GET | `/api/sessions` | 场次列表（含币种支持） |
| GET | `/api/sessions/current` | 最近开始的一场记录摘要（兼容；标签页改用 recordings） |
| GET | `/api/sessions/:id` | 单场摘要 + 时间线（`topLimit` 可选，最多 100） |
| GET | `/api/sessions/:id/top-viewers` | 单场 Top 100（`limit`、`query`） |
| POST | `/api/sessions/:id/stop` | 停止指定场次记录（与 live recordings 端点共用实现） |
| POST | `/api/sessions/:id/archive` | 归档/取消归档（`{archived}`；live 返回 409） |
| DELETE | `/api/sessions/:id` | 永久删除单场（必须 `{confirm:true}`；记录中拒绝） |
| GET | `/api/sessions/:id/viewers/:viewerId` | 单观众单场参与统计 + 最近发言 |
| GET | `/api/history/search` | 历史统一搜索 + 筛选 + 分页 |
| GET | `/api/live/recordings` | 所有运行中记录任务及独立状态/统计 |
| POST | `/api/live/recordings/:sessionId/stop` | 只停止指定记录任务 |
| POST | `/api/simulate/start` | 开始模拟场次（`title`、`speed`） |
| POST | `/api/simulate/stop` | 停止当前场次 |
| GET | `/api/viewers` | 观众列表（`query`、`limit`、`broadcasterId`、`scope=unassigned`） |
| GET | `/api/viewers/:id` | 观众档案（`broadcasterId` 或 `scope=unassigned`） |
| PATCH | `/api/viewers/:id` | 关注标记 |
| GET | `/api/bilibili/status` | Bilibili 登录与连接状态 |
| POST | `/api/bilibili/login/qrcode` | 生成扫码二维码 |
| POST | `/api/bilibili/login/poll` | 轮询扫码结果 |
| POST | `/api/bilibili/login/logout` | 退出 Bilibili 登录 |
| POST | `/api/bilibili/room` | 校验直播间 |
| POST | `/api/bilibili/connect` | 开始记录 Bilibili 直播（可与其他场次并存） |
| POST | `/api/bilibili/disconnect` | 停止指定 `sessionId`；多场且缺 ID 时返回 409 |
| GET | `/api/youtube/status` | 唯一 web 模式、连接、运行任务、保留策略（无登录/配额字段） |
| POST | `/api/youtube/video` | 解析直播链接并返回可记录性 |
| POST | `/api/youtube/connect` | 开始记录 YouTube 直播（无 mode 参数，可多场并存） |
| POST | `/api/youtube/disconnect` | 停止指定 `sessionId`；多场且缺 ID 时返回 409 |
| POST | `/api/youtube/retention/apply` | 立即执行 YouTube 原文保留清理 |
| GET | `/api/events` | 场次事件（倒序、分页） |
| GET | `/api/events/stream` | SSE（`event`、`status`） |
| GET | `/api/storage` | 数据目录、占用、计数 |
| GET | `/api/storage/location` | 当前数据目录、位置记录、空间、计数 |
| POST | `/api/storage/location/validate` | 校验目标目录（安全/空间/警告） |
| POST | `/api/storage/location/pick` | Windows 原生目录选择器 |
| POST | `/api/storage/location` | 迁移或创建新数据空间（维护模式） |
| POST | `/api/storage/open` | 在 Explorer 打开受管目录 |
| GET | `/api/storage/clear/preview` | 删除范围与记录中状态 |
| POST | `/api/storage/backup` | 数据库应急快照（`VACUUM INTO`） |
| POST | `/api/storage/clear` | `data` / `factory` 清空（确认文字） |
| GET | `/api/broadcasters` | 主播列表、当前主播、未确认历史 |
| GET | `/api/broadcasters/:id` | 主播汇总、新/回访、支持 |
| GET | `/api/broadcasters/:id/viewers` | 主播范围观众与排序 |
| GET | `/api/ai/instructions` | 指定语言的提示词 |
| POST | `/api/ai/packages` | 生成分析包 |
| GET | `/api/ai/packages` | 已导出包列表 |
| GET | `/api/ai/packages/:id/download` | 下载 ZIP |

## 5.1 数据目录迁移（运行中切换）

`src/server/relocation.mjs` 在同一个 HTTP 端口内切换数据目录：

1. 校验直播未进行、路径安全、目标冲突、空间与云同步警告；
2. `SessionManager`/平台服务停止、WAL checkpoint、关闭 SQLite；
3. 复制受管目录到目标卷 staging，`PRAGMA integrity_check` + 表计数 + schema + 文件 SHA-256；
4. 移入目标根目录（不碰无关文件），`buildRuntime()` 重新打开数据库；
5. 调用 launcher 的 `beginLockMove` 转移单实例锁，写 `data-location.json`；
6. `deps` 的 runtime getter 切换到新运行时；失败则回滚目录、位置记录与原运行时。

维护期间 `deps.maintenance` 使除 relocation/clear/health/status 外的 API 返回 503。

## 6. 并发与一致性

- `node:sqlite` 同步 API，单进程串行写入；`BEGIN IMMEDIATE` 包裹一次事件写入。
- 多个直播 adapter 可以同时运行；它们的回调在 Node 事件循环中依次进入同一数据库连接，不存在线程级同时写。
- WAL + `busy_timeout=5000`；退出时 `wal_checkpoint(TRUNCATE)`。
- 单实例锁避免两个进程写同一数据库。
- 事件插入与聚合同事务，避免“计数成功但事件缺失”。
- 场次状态由数据库读取，内存 recordings 只作运行期索引；启动时恢复 interrupted。
- 前端每个标签用 `viewToken` 丢弃过期请求，避免旧页面响应覆盖新选中场次。

## 7. 错误处理

- `AppError` 携带稳定 `code`、i18n `messageKey`、`httpStatus`；API 返回 `{error:{code,messageKey,details}}`。
- 控制台按 `messageKey` 本地化，不解析英文句子。
- 启动器捕获致命错误 → 写 `runtime/last-error.json` → 三语提示 → 等待回车（TTY）→ 退出码 1。
- 前端页面渲染异常 → 捕获并展示重试界面，同时写入 `window.__lmLastError` 便于诊断。

## 8. 前端结构

- `js/app.js`：bootstrap、hash 路由、Header 语言/主题切换、SSE、状态刷新。
- Header 语言控件：宽屏 `#language-segmented`（三种原生语言名）+ `#language-system`；窄屏 `#language-select`；两者共享 `state.settings.locale`。
- `js/pages/*.js`：页面模块，`render(container, ctx, params, query)` 返回清理函数。
- `js/pages/live.js`：多场标签页；每个 session 独立缓存 summary/feed/leaderboard；`viewToken` 防止串场；`/api/live/recordings` 恢复运行任务。
- `js/pages/history.js`：服务端搜索/筛选/增量加载；列表与详情共用 `session-actions.js`；`?viewer=` 下钻。
- `js/session-actions.js`：停止/归档/取消归档/永久删除的动作定义与确认框（列表与详情唯一实现）。
- `js/actions-menu.js`：可访问的 `···` 菜单（fixed 定位、视口夹紧、键盘/Esc/外部点击/焦点返回）。
- `js/dialog.js`：共享原生 `<dialog>` modal（settings 与 history 共用）。
- `js/ui.js`：DOM 构造（只用 `textContent`）、格式化、toast、空状态。
- `js/chart.js`：Canvas 时间线图，DPR 适配、主题重绘、hover 提示。
- `js/i18n.js`：按需加载 JSON 字典，`t(key, params)`。
- `js/theme-boot.js`：样式表前同步设置 `data-theme`，避免闪烁。
- `styles/tokens.css`：颜色/间距/圆角/阴影变量；明亮与黑暗分别定义。

## 9. 打包架构

```text
node.exe (官方运行时，含 node:sqlite)
  + SEA blob（src/** + manifest.json）
  + postject 注入 NODE_SEA_BLOB
  → dist/LiveMemory.exe（PE 子系统 = Console）
```

首次运行解压到 `<数据目录>/app/<content-hash>/`，内容变化时生成新目录，旧目录可安全删除（升级清理属 M8）。

## 10. 未来扩展点

- 平台适配器：实现 `PlatformAdapter.start({onEvent,onStateChange})`，产出 canonical event，即可复用全部统计、UI 与 AI 导出。
- 备份：复用 `shared/zip.mjs`，加入 `manifest.json` → `checksums.json` → `database/` → `settings/`。
- AI 导入：`src/ai/import/` 读取 ZIP/JSON → 校验 `result.schema.json` → 事务写入分析表与画像版本。
