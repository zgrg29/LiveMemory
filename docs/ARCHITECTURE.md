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
         ├─ src/monitoring/             自动监听：目标状态机、调度/退避、平台检测器（Bilibili roomStatus、YouTube /live + RSS 回退）
         ├─ src/storage/retention.mjs   YouTube 原文/badge/过期昵称保留策略
         ├─ src/analytics/              只读读模型（时间线/汇总/画像/历史搜索/AI 报告）
         ├─ src/ai/export/              分析包生成（整场/批次/汇总、表情字典、版本）
         ├─ src/ai/import/              解析、JSON Schema 子集、业务校验、事务导入
         ├─ src/ai/translation/         报告/长期画像的只读展示翻译、缓存与独立运行状态
         ├─ src/ai/tasks/               任务状态计算（从数据库事实）
         ├─ src/ai/prompts/             三语提示词与提示词版本
         ├─ src/ai/auto/                自动分析：匿名 provider 客户端、包内提示词、Runner、状态
         ├─ src/ai/providers/           多 Provider 目录、适配器、加密配置、能力检测、费用
         └─ src/ai/api/                 配置 Provider 运行器、单场/画像任务、预算与暂停恢复
   └─ src/web/                          浏览器控制台（原生 ES Modules）
```

## 1.1 AI 文件往返数据流（v0.8.0）

```text
createAnalysisJob()
  ├─ countSessionMessages() → 按 batchSize 计算批次
  ├─ 每批：listSessionMessagesAsc(offset/limit) → messages.jsonl（seq 从 1）
  │        + 本批 viewer_context + 整场统计 + 三语 instructions + result.schema.json
  ├─ 写 ZIP + ai_packages
  └─ BEGIN IMMEDIATE
       ├─ ai_jobs（job_id、prompt_version、batch_total、total_messages）
       ├─ ai_job_batches（稳定 batch_id、整场 seq 范围、时间范围、消息校验和）
       ├─ ai_job_messages（seq → event_id）
       └─ ai_job_viewers（本批 viewer_context 的稳定身份）
     COMMIT

用户把 ZIP 交给任意 AI → AI 返回 JSON

validateAnalysisImport()
  ├─ 8 MB / 结构 / JSON Schema / 协议版本
  ├─ job / batch / task / session / broadcaster 快照
  ├─ 时间窗口与批次覆盖
  ├─ message_refs → ai_job_messages → events（可用性）
  ├─ viewer_profiles → ai_job_viewers（绝不按昵称）
  └─ 规范化 → SHA-256 → duplicate / confirm_version / import

importAnalysisResult()
  └─ BEGIN IMMEDIATE
       ├─ ai_results（scope=batch:N|final、result_version、result_json）
       ├─ ai_result_evidence（section/item/batch/seq/event_id/available）
       ├─ 清空 last_error；recompute sessions.ai_status
       └─ COMMIT

用户生成汇总包（buildAggregatePackage）
  └─ session_context + viewer_context + batch_results.json + aggregate instructions

buildSessionAnalysisReport()
  ├─ 选择 complete job；有 final 用 final，单批用 batch，否则按批次 partial
  ├─ evidence → events：原文、昵称、时间；已清理/删除 → unavailable
  └─ 报告只含 AI 内容；本地统计仍在场次详情
```

关键保证：

- AI 结果永远不写 `events`、`sessions` 计数、金额或观众聚合；它只写独立的 `ai_*` 表。
- 结果只能引用导出时真实存在的 `seq`；`ai_job_messages` 是唯一映射，报告也用它解析证据。
- 批次任务缺少批次、缺少汇总或校验失败时，状态不是 `complete`；部分结果不会被拼成整场报告。
- 相同内容重复导入不新增行；不同内容必须显式创建新版本，旧版本保留。
- 删除场次级联删除任务/批次/映射/结果/证据与包文件；清空数据包含全部 AI 表。

## 1.2 统一分析与长期记忆数据流（v0.11.0）

```text
createAnalysisJob()
  ├─ listSessionMessagesAsc() → 按消息顺序切片（时间线批次）
  ├─ listSessionViewers() → 全部可识别观众（无 Top N / 无最低发言）
  ├─ 观众分配：每位观众只进入一个记忆批次；该批包含其最近 120 条摘录
  ├─ 每批：messages.jsonl + viewer_context.json + memory_context.json + viewer_excerpts.jsonl
  └─ ai_job_memory_viewers / ai_job_memory_messages（覆盖 + 证据映射）

importAnalysisResult()
  └─ 单事务：
     ├─ 保存 ai_results + ai_result_evidence
     ├─ 确保每位会话观众的客观记忆头（version 0 或原版本）
     ├─ 应用 viewer_memory_updates（add/confirm/update/supersede/conflict/outdated/uncertain）
     ├─ 写 memory_facts / memory_fact_evidence / memory_versions
     └─ 更新 ai_job_memory_viewers.status（semantic/no_semantics/objective_only/deleted）

computeJobStatus()
  └─ 全部分配观众 covered 后，任务才可能 complete
```

关键不变量：

- 语义记忆只能来自 `viewer_memory_updates`，证据必须命中本批 `ai_job_memory_messages` 且属于同一观众。
- 客观统计只来自现有真实表，重复导入/重复消息不会重复计数。
- 无新语义 ≠ 未处理：`no_semantics` 仍覆盖，`pending` 才是未处理。
- 删除记忆后的旧包不能恢复；同一结果重复导入不写。
- 独立的 M7 记忆任务不再是用户流程；旧任务表保留只读历史。

## 1.3 自动分析数据流（v0.12.1）

```text
AutoAnalysisRunner.start({sessionId, locale, consent:true})
  ├─ 预检查：消息/观众/摘录 → 需要批次数；>30 直接失败，不创建任务
  ├─ 若有进行中的同一 auto job 且 promptVersion 匹配：恢复（相同 job/batch/观众分配）
  ├─ 旧 promptVersion 的失败任务不复用；创建新任务，旧任务保留
  └─ 否则 createAnalysisJob({batchSize:250, viewersPerBatch:10, excerptsPerBatch:600})

每批
  ├─ 读取导出的 ZIP（manifest/messages/viewer_context/memory_context/
  │   viewer_excerpts/session_context/instructions/schema）
  ├─ buildBatchPrompt()：紧凑契约 + ref（1..N）+ 每 ref 的证据 seq + viewer_directory
  ├─ callProvider()：无 Key、json_schema structured output、2/60s 限流、300s 超时
  ├─ 回答：{"session_topics":..., "viewers":[{"ref":n,"memory":...,"profile":...}]}
  ├─ assembleCompactAnswer()：ref → 本批稳定 viewer_id（模型从不输出 ID）
  ├─ validateAnalysisImport()：Schema + 业务 + 观众覆盖 + 证据归属（只读预览）
  ├─ 缺 ref：一次定向补充（只发缺失观众及其摘录）；仍缺则失败，不写库
  ├─ 其他失败：一次修复请求；再失败则切换已验证 provider 或停止
  └─ importAnalysisResult({source:'auto'})：单事务保存报告 + 记忆 + 覆盖

全部批次后
  ├─ buildAggregatePackage()（复用 M6）
  ├─ buildAggregatePrompt()：只合并已验证 batch_results；structured output 强制
  │   viewer_memory_updates=[]；12000 输出预算
  └─ validate + import final

状态
  ├─ 内存 active map（防同一 session 重复启动）
  ├─ runtime/ai-auto.json：jobId/stage/batchIndex/batchTotal/error（无聊天/提示词）
  └─ 重启：running → interrupted；再次点击复用同一 job，已导入批次跳过
```

关键保证：

- 自动模式只新增入口，不改变 M6/M7/P8 的协议、Schema、事务和覆盖率规则。
- AI 永远不能直接写数据库，也不能提供观众身份；组装结果仍经
  `validateAnalysisImport` + `importAnalysisResult`。
- 批次失败不会回滚已成功批次；`partial` 状态与已导入结果保留。
- 所有 provider 失败后停止自动流程；UI 显示统一红色提示，手动流程继续可用。
- `runtime/ai-auto.json` 与日志不含聊天正文、提示词、模型回答或观众隐私内容。
- 截断（`finish_reason=length`）与字段名退化有独立错误码，不再伪装成 Schema 错误。

## 2. 启动时序

1. 解析参数（`--no-open`、`--port`、`--data-dir`、`--lang`）。
2. `chcp 65001` 设置控制台 UTF-8；解析系统语言。
3. 检查 Node 版本与 `node:sqlite`。
4. 解析数据目录：显式 `--data-dir` / `LIVE_MEMORY_DATA_DIR` 优先；否则读取 `data-location.json`（`%LOCALAPPDATA%\LiveMemory`，镜像 `%APPDATA%`）；只有记录目标已存在且含数据库才使用，否则显示不可用错误，不创建空库；最后才回退默认目录。创建子目录并写探针。
5. 读取 `config/settings.json`，确定命令行语言（保存的偏好优先，`--lang` 覆盖）。
6. 获取单实例锁 `runtime/instance.lock`；若已有存活实例，打印地址并打开浏览器后退出。
7. `startServer()`：
   - 迁移数据库并记录 schema 版本
   - 将遗留 `live` 场次标记为 `interrupted`（`ended_at` = 启动检测时间，不用最后弹幕时间）
   - 绑定 `127.0.0.1:preferredPort`（冲突 +1…+9，最后 0）
   - 写 `runtime/runtime.json`（pid/port/url）
   - 服务就绪后后台探测历史 Bilibili 行的平台状态（不阻塞启动、不改编排时间）
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

## 3.5 平台直播状态与下播检测（v0.8.1）

```text
sessions.status         本地采集：live / ended / interrupted
sessions.platform_status 平台直播：live / ended / not_started / carousel / unknown / ending
```

Bilibili 适配器同时维护两条独立信号：

```text
WebSocket: LIVE / PREPARING / STOP_LIVE（仅当前 roomid、当前 generation）
   ├─ LIVE      → platform_status=live，重置离线计数，last_live_seen_at
   └─ PREPARING → platform_status=ending，立即查询一次状态

定时器: room/v1/Room/get_info `live_status`
   ├─ 1 → live
   ├─ 0/2 → 第一次记 ending，15s 后再查；连续 2 次有效离线才结束
   └─ 超时/429/-352/缺字段/房间不匹配 → 只退避，绝不结束

确认结束
  → 清心跳/看门狗/轮询/重连
  → 关闭 WebSocket
  → 写 platform_status、platform_ended_at、platform_end_quality
  → endSession(status='ended', end_reason='platform_ended')
  → SSE 'status' → 前端刷新
```

- `onPlatformStatus` 只写该 `sessionId` 的平台字段，不改变采集状态；`onEnd` 才停止采集。
- 旧适配器回调在 `SessionManager` 中通过 recording 存在性 + `stopping` 丢弃，
  适配器内部通过 generation 丢弃。
- 历史修复 `repairBilibiliPlatformStatuses()` 只注解 `platform_status IS NULL` 且
  `shutdown`/`startup_recovery` 的 Bilibili 行；不改 `ended_at`、不写未知结束时间。
- 未开播/轮播房间在 `BilibiliService.connect()` 创建场次前拒绝。

## 4. 读模型

- `analytics/sessions/hotness.mjs`：按场次时长选择 10s–1h 的桶；输出消息数、按稳定 UID 的观众、按币种支付；直播中不绘制未完成的桶。
- `analytics/sessions/summary.mjs`：场次摘要 + 时间线 + 支持 + 活跃观众（默认前 5，可传 `topLimit`）+ 存储统计；`uniqueViewerCount` 只表示可识别观众，`unidentifiedMessages` / `identityCoverage` 从 `events` 实时派生。
- `analytics/sessions/leaderboard.mjs`：单场 Top 100 读模型；`rank` 按有效弹幕数 → `platform_uid` → `viewer_id` 稳定排序；搜索只在 Top 100 内过滤且保留原始名次。
- `analytics/sessions/history-search.mjs`：历史搜索读模型；`scope=all|broadcaster|title|viewer`，组合平台/状态/日期/归档筛选；只查场次与身份关系表，不读聊天正文；`LIKE` 通配符转义；返回匹配原因、实际参与身份与未识别消息数。
- `analytics/viewers/profile.mjs`：观众档案（身份、累计、昵称历史、参与场次）。
- `analytics/payments/totals.mjs`：按币种合并 actual/display，绝不混加。

### 4.1 AI 分析包（文本优先）

- `messages.jsonl` 保留 `content` 原文；Unicode Emoji 不转换；M6 起另带 `event_id` 与平台 `message_id` 便于追溯。
- 平台表情进入 `session_context.emote_dictionary`，消息通过 `emote_refs` 引用；同一表情只存一份元数据。
- 仅当原文不足以理解表情时，才增加 `content_ai`；未知表情标记 `[未知平台表情：emote_id=…]`，不猜情绪。
- 不打包表情图片；包大小主要由文本和聚合决定。
- `instructions.md` 由 `src/ai/prompts/instructions.mjs` 按 `locale` 生成，包含话题、观众画像、经济支持、
  Emoji/表情、数据可靠性、不可信数据、批次/汇总与来源字段规则；版本 `lm-prompt-m6.2-<locale>` 记录在
  `manifest.prompt_version` 与 `ai_jobs.prompt_version`。
- M6 的批次/汇总包结构与校验见 `AI_CONTRACT.md`；导出、导入、报告分别由
  `ai/export/job.mjs`、`ai/import/*`、`analytics/ai/report.mjs` 负责。

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
| GET | `/api/ai/instructions` | 指定语言的通用提示词，或按 `jobId`/`batchIndex`/`stage` 返回任务提示词 |
| POST | `/api/ai/packages` | 生成旧版整场分析包（兼容） |
| GET | `/api/ai/packages` | 已导出包列表（可按 `sessionId`/`jobId`） |
| GET | `/api/ai/packages/:id/download` | 下载 ZIP |
| POST | `/api/ai/jobs` | 创建分析任务并导出全部批次包 |
| GET | `/api/ai/jobs` | 任务列表 + 实时状态 + 包 |
| GET | `/api/ai/jobs/:id` | 任务 + 批次 + 包 + 结果版本 |
| POST | `/api/ai/jobs/:id/aggregate` | 全部分批导入后生成第二阶段汇总包 |
| POST | `/api/ai/import/preview` | 只读预检查（场次/任务/批次/覆盖/重复/错误） |
| POST | `/api/ai/import` | 确认导入（事务；`createVersion` 显式新版本） |
| GET | `/api/ai/sessions/:id/report` | 直播分析报告读模型 |
| GET | `/api/ai/results/:id` | 单个结果元数据 + 原始 JSON |
| GET | `/api/ai/results/:id/download` | 下载结果 JSON 供审计 |
| GET | `/api/ai/auto/services` | 已验证匿名服务与自动批次数上限 |
| GET | `/api/ai/auto/status` | 自动分析状态（按 `sessionId`；真实阶段/批次/错误） |
| POST | `/api/ai/auto/run` | 启动或恢复自动分析（必须 `consent:true`） |
| POST | `/api/ai/auto/cancel` | 取消自动分析（保留已导入批次） |

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
- `js/pages/history.js`：服务端搜索/筛选/增量加载；列表与详情共用 `session-actions.js`；`?viewer=` 下钻；
  详情页读取 AI 报告摘要并提供完整报告入口。
- `js/pages/ai.js`：AI 分析中心（任务/批次包/提示词/文件与粘贴导入/预检查/版本/汇总/重新分析）。
- `js/pages/ai-report.js`：分析报告（摘要、话题、情绪、争论、片段、画像、来源、证据展开）。
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
- AI 导入：M6 已实现 `src/ai/import/`（JSON 校验 → 事务写入 `ai_results`/`ai_result_evidence`）与报告。
- 长期记忆：M7 已实现 `src/memory/`（`broadcaster × viewer` 记忆、原子事实、事实级证据、
  仅追加版本与差异、本地合并、`livememory-memory-update-v1` 往返、删除与保留）。
  依赖方向仍为 `web → server → memory/analytics/storage → shared`；`src/memory` 复用
  `ai/import` 的解析/校验工具与 `shared/zip.mjs`，不改写 M6 的分析表。

## 1.4 v0.13 单场 / 画像拆分与多 Provider（2026-11-11）

```text
手动模式
  POST /api/ai/jobs {analysisMode:session}
    -> createSessionAnalysisJob()
       - stage=session 单包：manifest/session_context/messages/instructions/schema
       - 无 memory_context / viewer_excerpts / 全量 viewer_context
    -> 用户交给任意 AI -> 导入 -> 只写 ai_results（analysis_mode=session）
       - applyMemorySideEffects() 直接跳过

匿名免费 / API 免费
  POST /api/ai/analyze/run {mode:session, configId:null|free}
    -> AnalysisRunner -> session job -> provider -> validate -> import
    -> 不允许 mode=memory/both

已配置模型（最终修订）
  POST /api/ai/analyze/run {mode:session|memory|both, configId}
    -> 权限门：session 需要 capabilities.session；memory 还需要 capabilities.memory
       价格、免费/付费、optInMemory、confirmBilling、budget 不参与
    -> session job 先执行/保存
    -> memory job：createViewerMemoryJob() 每批：
       memory_context + viewer_excerpts -> 模型返回 ref -> 本地映射稳定 ID
       -> validate -> import -> ai_results.analysis_mode=memory
    -> 报告读模型排除 memory-only 结果
    -> 暂停/继续/取消；已导入批次跳过；needs_action 保留已保存结果

Provider 配置
  config/ai-providers.json（无密钥）
  secrets/ai-keys.json（AES-256-GCM）
  ProviderConfigStore -> Provider adapter（OpenAI-compatible / Anthropic）
  capabilities / pricing / usage 快照写入 ai_jobs
```

关键保证：

- `session` 与 `memory` 永远不共用一次事务写入；单场报告成功不依赖画像。
- 免费 Provider/模型没有 `memory` 路径；`memoryPermission()` 是唯一入口。
- 画像结果不进入单场报告读模型；历史 combined 结果仍按旧逻辑读取。
- Provider 配置/能力/费用全部来自配置快照；切换默认配置不影响运行中任务。
- API Key 不进入普通配置、日志、ZIP、数据库导出或 HTML。

## 1.5 v0.13.1 单一 AI 入口与付费请求调度（2026-11-11）

```text
唯一入口
  AI 分析中心（五步）
    1 选择直播
    2 选择 API 配置（Provider / 区域 / 模型 / Key）
    3 选择内容 session | memory | both
    4 费用 / 预算确认（付费或未知价格）
    5 开始 AI 分析
  -> POST /api/ai/analyze/run
     -> AnalysisRunner（只接受 configId；无匿名 fallback）
     -> createSessionAnalysisJob / createViewerMemoryJob（内部包，不暴露下载）
     -> ProviderRequestScheduler（按 configId 隔离）
     -> Provider adapter -> validate -> import -> 报告

  UI 读取
    GET /api/ai/analyze/status -> 阶段 / 批次 / 请求统计 / usage / error
    GET /api/ai/sessions/:id/report -> 单场报告 + 长期画像只读
    GET /api/ai/results/:id(/download) -> 历史结果
```

调度层：

```text
ProviderRequestScheduler(configId)
  - 初始并发：配置 1–8（默认 3），不是官方 RPM 声明
  - 429：并发减半 + Retry-After 冷却（仅此 config）
  - 5xx/408/425：短冷却
  - 连续成功：逐级恢复到配置上限
  - 统计：请求/完成/失败/并发/排队/模型耗时/排队等待/限流等待/429/p50/p95
  - 无固定 RPM/TPM；Provider 官方额度需等真实文档/响应，不虚构

AnalysisRunner.requestOnce
  - 最多 3 次尝试；429 交给调度器；其他可重试错误指数退避 + 抖动
  - 取消/超时/预算/URL 安全检查保留
  - 同一主播 memory gate：较旧场次不得覆盖较新场次
  - memory 批次：有界 worker pool；观众互不重叠
```

已删除：

- `src/ai/auto/`（匿名 OVH 2 RPM、冷却、自动切换、免费状态）。
- `/api/ai/auto/*`、`/api/ai/instructions`、`/api/ai/import*`、手动 job/package 写路由。
- UI 的手动包/提示词/JSON paste/upload/修复。

保留的公共层：

- `src/ai/import/`（Schema、证据/身份/批次验证、事务导入、幂等）。
- `src/ai/api/compact.mjs`、`src/ai/api/prompts.mjs`、`src/ai/export/split-jobs.mjs`。
- `src/ai/runtime/json.mjs`、`state.mjs`、`scheduler.mjs`。
- 历史结果/报告读取与旧 1.0–1.2.0 兼容。

## 1.6 v0.13.1 实际使用修复（2026-11-11）

```text
AI 分析中心
  #/ai?session=<stable_id>
    -> chooseInitialSessionId()：按 id 选择；早期列表没有时 GET /api/sessions/:id
    -> 手动选择 replaceState 更新 URL
  statusEpoch/reportEpoch：旧异步响应不得覆盖新任务/新报告
  buildAnalysisProgress()：批次/观众真实计数；无计数用不确定动画；100% 仅 complete
  providerConfigState()：none / missing_key / test_failed / untested /
                          pricing_missing / ready
  memorySkipped：combined 无观众时保留单场报告，画像显式跳过

监控
  target.meta.manualStop = {sessionId, liveKey, stoppedAt, awaitingOffline}
  liveKey = bilibili:<room>:<live_time> 或 youtube:<videoId>
  用户停止 -> state=live_stopped，active_session_id=null
  同周期 LIVE -> hold；offline -> clear；新 liveKey -> new session
  resume_capture -> 仅用户主动清除抑制并创建新 session
  Bilibili metadata: roomInfo -> masterInfo(uid) 回退
```

关键不变量：

- 自动监听与当前场次采集分离；`live_stopped` 不是 `paused`，也不是 `ended`。
- 没有可靠 live cycle key 时，宁可继续抑制，不根据时间猜测新场。
- 重启后从 `monitor_targets.meta_json` 恢复；不使用内存布尔变量。
- 已结束的 session 永不重新打开；显式恢复创建新 session。
- Bilibili 主播身份仍是 `bilibili:<anchorUid>`；昵称只用于显示。

## 1.7 v0.13.1 API 配置原地编辑（2026-11-11）

```text
PATCH /api/ai/providers/configs/:id
  -> 若 analysisRunner.isConfigInUse(id) -> 409 AI_PROVIDER_CONFIG_IN_USE
  -> body 未提供 pricing 时不要传入 null（否则会误清空）
  -> ProviderConfigStore.update(id, patch)
       - 同一 id，不删除重建
       - credentialReference 不变（provider/region/baseUrl 未变）
       - 显式非空 apiKey 才替换；空/缺省保留旧 Key
       - provider/region/baseUrl 变化：轮换 reference；非自定义 provider 必须有新 Key
       - modelId 变化：capabilities=空、lastTestStatus=untested、
         pricing=null/unknown、contextLength=null、modelLabel=新 modelId
       - name/concurrency/pricing 等非模型字段变化不否定能力
  -> 返回 public config（不含 Key）

AnalysisRunner
  - start 的 resumable 要求 provider/region/model 与 state 快照一致
  - resume 时配置身份变化 -> 409 AI_PROVIDER_CONFIG_CHANGED
  - 运行中的 config 禁止编辑/删除；新任务读取新配置
```

安全边界：

- 浏览器只收到 `hasCredential`，不收到 Key。
- 编辑表单的 Key 输入为空；只有用户输入才随 PATCH 发送。
- 旧模型能力、价格、上下文不会被新模型继承。
- 历史分析结果、长期画像、其他 Provider 配置不因编辑而修改。

## 1.8 v0.13.2 分析输出语言与报告翻译（2026-11-13）

```text
分析输出语言
  AI 中心 locale select（默认 UI locale，可手选）
    -> POST /api/ai/analyze/run {locale}
    -> ai_jobs.locale（Session 与 Memory 两个 Job 同 locale）
    -> Prompt / instructions.md / Compact 示例按 locale
    -> 状态返回 locale（任务期间/Resume 不因 UI 切换改变）

报告阅读语言
  GET /api/ai/sessions/:id/report?locale=zh-CN
    -> buildSessionAnalysisReport()（原分析读模型，只读）
    -> collectTranslatableItems()（仅自然语言展示字段）
    -> ai_translations 缓存（source_hash + target_locale + version）
    -> 应用已缓存段落；绝不调用 Provider / 不创建 Job

首次翻译
  POST /api/ai/sessions/:id/translation {locale, configId, consent}
    -> ReportTranslationService（独立于 AnalysisRunner）
    -> 读取已导入结果 + 长期记忆的展示字段
    -> 按字数分块 -> 用户配置 Provider（非流式）
    -> 解析 JSON -> 逐段保存 ai_translations（成功/失败）
    -> ai_translation_runs 独立 usage/费用；不写 ai_jobs
    -> 失败段可由 UI 只重试未完成部分
```

关键保证：

- 翻译只读已保存结果，不读取整场弹幕、不运行 Session/Memory 批次、不触发事实操作。
- 翻译缓存键包含原始对象 ID、字段路径、源文本 hash、目标语言与翻译版本；新结果版本/新事实文本不会复用旧翻译。
- `viewer_id`、`topic`、事实 ID/状态/certainty/版本/证据/时间/金额/计数/枚举/原始聊天不翻译。
- 翻译服务有独立状态与 usage；失败/中断不影响已保存分析，也不影响原文阅读。
- 翻译表随场次删除；删除记忆时删除其展示翻译；清空数据包含翻译表。

