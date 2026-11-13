# 数据模型（DATA_MODEL）

数据库：`<数据目录>/database/livememory.db`（SQLite，WAL）
Schema 版本：**15**
迁移入口：`src/storage/database/migrations/index.mjs`

## 1. 设计原则

1. 时间统一为 epoch 毫秒整数（INTEGER）。
2. 金额统一为整数最小货币单位（minor units），并带 `currency` 与 `value_kind`。
3. 观众主键 = `platform:stable_uid`，昵称只作展示。
4. 事件以 `(session_id, dedupe_key)` 唯一，重复投递不产生第二行。
5. 聚合值存表（场次/观众/币种），读模型不扫描全量事件。
6. 删除遵循外键级联，避免孤儿数据。
7. 聊天原文优先：`content` 永远保留平台原文；Unicode Emoji 不做转换。
8. 平台表情只存最小元数据（id/code/name/source），不存图片、不猜情绪。

## 2. 表结构

### schema_migrations / app_meta

```sql
schema_migrations(version INTEGER PK, name TEXT, applied_at INTEGER)
app_meta(key TEXT PK, value TEXT, updated_at INTEGER)   -- 预留
```

### sessions

| 列 | 类型 | 说明 |
| --- | --- | --- |
| id | TEXT PK | `ses_<ULID>` |
| platform | TEXT | `bilibili` / `youtube` / `mock` |
| platform_room_id | TEXT | 平台房间/频道 ID |
| room_title | TEXT | 直播标题（原文，不翻译） |
| broadcaster_name | TEXT | 主播名（展示） |
| broadcaster_id | TEXT | 外键 → `broadcasters`，可空；旧场次可能无法确定（schema v5） |
| broadcaster_identity | TEXT | `verified` / `room_fallback` / `simulated` / `unresolved`（schema v5） |
| status | TEXT | `live` / `ended` / `interrupted`；只描述本地采集 |
| end_reason | TEXT | schema v7：`user` / adapter 原因 / `failed` / `shutdown` / `startup_recovery`；可空 |
| archived_at | INTEGER | schema v7：归档时间；NULL = 未归档。独立管理属性，不覆盖 status |
| storage_mode | TEXT | `compact` / `full`（场次级覆盖） |
| source_quality | TEXT | `verified` / `estimated` / `unknown` / `mock` |
| simulated | INTEGER | 1 = 模拟数据 |
| started_at | INTEGER | 本地开始记录的时间（毫秒） |
| platform_started_at | INTEGER | 平台侧直播开始时间（YouTube `actualStartTime`，可空；schema v3） |
| ended_at / last_event_at | INTEGER | 毫秒 |
| platform_status | TEXT | schema v9：`live` / `ended` / `not_started` / `carousel` / `unknown` / `ending`；平台直播状态，独立于本地采集 |
| platform_status_at | INTEGER | schema v9：最近一次平台状态观测/确认时间 |
| last_live_seen_at | INTEGER | schema v9：最近一次可靠确认「平台直播中」的时间 |
| platform_ended_at | INTEGER | schema v9：有证据的平台结束时间；未知为 NULL，绝不填最后弹幕时间 |
| platform_end_quality | TEXT | schema v9：`event` / `poll` / `unknown`，记录结束时间证据 |
| message_count | INTEGER | 聊天 + SC 条数 |
| gift_event_count | INTEGER | 礼物事件数 |
| payment_event_count | INTEGER | 所有付费事件数 |
| ai_status | TEXT | `none` / `exported` / `imported` |
| monitor_target_id | TEXT | schema v11：产生本场记录的持久监听目标；手动连接为 NULL。不是外键，删除目标不删除历史 |
| created_at / updated_at | INTEGER | 毫秒 |

索引：`started_at DESC`、`status`、`broadcaster_id, started_at DESC`（v5）；
schema v7 新增 `idx_sessions_history (archived_at, started_at DESC)` 与
`idx_sessions_platform_started (platform, started_at DESC)` 供历史列表筛选/排序。

**状态语义（v0.7.0 / v0.8.1）**：`status` 只表示本地采集（`live` / `ended` / `interrupted`）。
`end_reason=user` 表示用户在应用内停止记录，**不代表 Bilibili/YouTube 直播结束**；
`end_reason=platform_ended` 表示确认平台下播后自动结束；`startup_recovery` / `shutdown` 表示
软件中断，不是平台结束。归档（`archived_at`）与状态正交：归档不改变 status，也不删除任何数据。

平台状态在 `platform_status` 中独立记录：

- `live`：最近一次有效查询/事件确认直播中；
- `ended`：确认平台已下播（`S`/两次有效离线查询），或历史证据表明曾直播且当前不再直播；
- `not_started`：未开播（当前正常不会创建采集，保留给历史/边界）；
- `carousel`：平台 `live_status=2` 轮播/回放，不是实时直播；
- `unknown`：没有可靠平台证据；不得假定为直播中或已下播；
- `ending`：已收到下播信号，正在确认（内部过渡态，不是最终状态）。

`platform_ended_at` 只在 WebSocket 下播事件 + 有效离线查询（`event`）或两次有效离线查询
（`poll`）后写入；历史修复/崩溃恢复不写。`platform_end_quality=unknown` 时 UI 必须显示“未知”，
不能用 `last_event_at` 代替。

**多场并发（v0.6.0）**：`sessions` 允许同时存在多条 `status='live'`，每行对应一场独立广播。`platform + platform_room_id` 的重复启动由 `SessionManager` 在进程内同步检查（先内存、再数据库）拒绝，不依赖数据库唯一索引；单实例锁保证不会有两个进程同时写入。启动时所有残留 `live` 行会标记为 `interrupted`，不会自动恢复；`ended_at` 写启动检测时间，`platform_ended_at` 保持 NULL，随后由后台探测补平台状态（见 §7）。

### events

| 列 | 说明 |
| --- | --- |
| id | 自增主键 |
| session_id | 外键 → sessions，级联删除 |
| platform | 平台 |
| external_id | 平台消息 ID（可空） |
| event_type | `chat`/`gift`/`super_chat`/`super_sticker`/`guard`/`membership`/`system` |
| viewer_id | 外键 → viewers（可空，匿名事件为 NULL） |
| viewer_uid | 平台稳定 UID |
| display_name | 事件发生时的昵称 |
| occurred_at / received_at | 平台时间 / 本地接收时间 |
| content | 文本（SC 含正文；礼物为空） |
| emotes | 平台表情元数据 JSON 数组（可空）：`[{id?, code?, name?, source?}]`；不存图片 |
| badges | 平台确认的作者 badge（schema v4，可空）：`[{type, label}]`，type = `owner`/`moderator`/`verified`/`member`/`unknown` |
| gift_id / gift_name / gift_type | 礼物信息；`gift_type` = `paid` / `free` |
| gift_quantity | 数量 |
| unit_amount_minor / amount_minor | 单价 / 总价（最小单位） |
| amount_display | 平台显示的原始金额字符串（schema v4，可空），例如 `HK$2,000.00`；仅用于审计，不参与累计 |
| currency | ISO-4217 |
| value_kind | `actual` / `display` / `unknown` |
| is_paid | 0/1 |
| source_quality | 数据可信度 |
| dedupe_key | `ext:<id>` 或 `fp:<sha256 前 32 位>` |
| content_purged_at | 精简模式清理时间 |

约束与索引：`UNIQUE(session_id, dedupe_key)`、`(session_id, occurred_at)`、`(viewer_id, occurred_at)`、`event_type`。

### 表情元数据（schema v2）

- 普通 Unicode Emoji 直接保存在 `content`，不新增行、不建图片表。
- 平台表情只保存最小 JSON 数组，例如 Bilibili：
  ```json
  [{"id": "room_5050_96171", "name": "就这", "source": "bilibili.info13"}]
  ```
- `name` 仅来自平台提供的文字标签；没有名称时只保留 `id`，由 AI 包标记为未知，**绝不猜测情绪**。
- 不保存表情图片 URL、宽度、高度或缓存；未来若做图片缓存，必须独立于长期聊天数据。
- 去重键在原文之外加入表情 id/code/name，避免“同一用户同一时间不同表情”被误判为重复。
- 精简模式清理时 `content` 与 `emotes` 一起清空，消息行、计数、金额、身份保留。

### viewers

| 列 | 说明 |
| --- | --- |
| id | `platform:uid` |
| platform / platform_uid | 拆开保存，便于按平台查询 |
| nickname | 最近昵称 |
| first_seen_at / last_seen_at | 毫秒 |
| message_count | 累计聊天数 |
| payment_event_count | 累计付费事件数 |
| focused | 主播重点关注（0/1） |
| created_at / updated_at | 毫秒 |

`UNIQUE(platform, platform_uid)`。

### viewer_nicknames

`(viewer_id, nickname)` 主键 + `first_seen_at` / `last_seen_at`。昵称变化不丢失历史，也不用于合并身份。

### viewer_sessions

`(viewer_id, session_id)` 主键 + 本场 `message_count` / `payment_event_count` / 首末见时间。用于计算“累计参与场次”与观众页的参与列表。

`schema v6` 新增索引：

```sql
CREATE INDEX idx_viewer_sessions_speakers
  ON viewer_sessions (session_id, message_count DESC);
```

该索引只服务单场 Top 100 排行榜；不改变数据含义，也不把长期累计混入场次排名。排行榜排序为 `message_count DESC, platform_uid ASC, viewer_id ASC`，因此同分时名次稳定且可复现。搜索在已取出的 Top 100 内过滤，保留原始名次；第 101 名不会补位进前 100。

`schema v7` 新增历史搜索索引：

```sql
CREATE INDEX idx_sessions_history ON sessions (archived_at, started_at DESC);
CREATE INDEX idx_sessions_platform_started ON sessions (platform, started_at DESC);
CREATE INDEX idx_viewers_nickname ON viewers (nickname);
CREATE INDEX idx_viewer_nicknames_nickname ON viewer_nicknames (nickname);
CREATE INDEX idx_viewer_sessions_viewer_seen ON viewer_sessions (viewer_id, last_seen_at DESC);
```

搜索**不读取 `events.content`**：主播/标题只查 `sessions` 与 `broadcasters`，观众先解析身份再通过
`viewer_sessions` 定位场次；每场事件数只做索引 `COUNT(*)`。标题/昵称使用 `LIKE` 子串匹配（中日英无需分词），
并转义 `%`/`_` 通配符。同名不同平台或不同稳定 ID 的观众会分别返回，绝不合并。

### viewer_currency_totals

`(viewer_id, currency, value_kind)` 主键 + `total_minor` + `event_count`。

### session_currency_totals

`(session_id, currency, value_kind)` 主键 + `total_minor` + `event_count`。场次详情与列表的经济支持来源。

### broadcasters（schema v5）

| 列 | 说明 |
| --- | --- |
| id | `platform:uid`（YouTube channelId / Bilibili anchor uid）或 `bilibili:room:<id>` / `mock:simulation` |
| platform / platform_uid | 拆开保存，`UNIQUE(platform, platform_uid)` |
| display_name | 最近一次可见主播名；昵称只作展示 |
| identity_quality | `verified` / `room_fallback` / `simulated` / `unresolved` |
| first_seen_at / last_seen_at | 毫秒 |

### viewer_broadcasters（schema v5）

`(viewer_id, broadcaster_id)` 主键 + `message_count` / `payment_event_count` / `first_seen_at` / `last_seen_at` / `created_at` / `updated_at`。

- 这是长期观众记忆的主要单位：主播 × 观众的互动上下文。
- 观众身份仍由 `viewers.id` 唯一；本表不复制身份。
- 删除观众级联删除关系；删除场次**不**自动减少关系计数（与全局观众计数规则一致）。

### viewer_broadcaster_currency_totals（schema v5）

`(viewer_id, broadcaster_id, currency, value_kind)` 主键 + `total_minor` + `event_count`；外键指向 `viewer_broadcasters` 复合主键。不同主播、不同币种、不同 value_kind 分别累计。

### ai_packages

导出记录：`id`、`session_id`、`kind`、`protocol_version`、`locale`、`file_name`、`relative_path`、`checksum`、`message_count`、`created_at`。schema v8 增加 `job_id`、`batch_index`、`stage`（`single` / `batch` / `aggregate`）、`prompt_version`，用于把文件与任务、批次、提示词版本关联；旧行为 `NULL` + `single`。

### AI 任务与结果（schema v8）

M6 的 AI 往返是“外部不可信输入 + 可审计版本”的模型。原始事件表仍然只由 `EventIngest` 写入；AI 数据只进入下列独立表。

#### ai_jobs

| 列 | 说明 |
| --- | --- |
| id | `aij_<ULID>` |
| session_id | 外键 → sessions，级联删除 |
| broadcaster_id | 创建任务时的主播快照（可空） |
| kind | `session_analysis`（新任务） |
| locale | 任务提示词语言 |
| prompt_version | 例如 `lm-prompt-m6.2-zh-CN` |
| protocol_version | 分析包协议 `livememory-analysis-v1` |
| batch_total / max_messages / total_messages | 批次总数、每批上限、消息总数（导出时快照） |
| legacy | 1 = 由 M6 之前的整场结果自动创建 |
| aggregate_package_id / aggregate_task_id | 第二阶段汇总包与任务 id |
| last_error_at / last_error_code / last_error_json | 最近一次导入/批次失败。v0.13.2 起 `last_error_json` 含 `batches[]`（`batchIndex`、`batchId`、`stage`、`code`、`at`、`errors[]`），按批次保留；顶层 `code`/`errors` 兼容旧读取。`batchIndex` 为 1-based；整场汇总失败为 `null`（旧数据可能为 0，读取时规范化）。只存字段路径/错误码/参数，不存 AI 正文、聊天、Key |
| created_at / updated_at | 毫秒 |

运行时 `runtime/ai-v13.json` 只保存任务阶段、计数器、错误码、`recovery`/`outputStats` 等诊断状态，**不含提示词、聊天正文或模型回答**；批次结果与 final 是否存在的权威来源仍是 `ai_results`。删除/清空数据后运行时可重建。

#### ai_job_batches

`(job_id, batch_index)` 主键；`batch_id`（稳定 `<jobId>-bNN`）、`task_id`、`from_seq`/`to_seq`（整场序号）、
`from_at`/`to_at`（毫秒）、`message_count`、`checksum`（`messages.jsonl` 的 SHA-256）、`package_id`、`created_at`。

#### ai_job_messages

`(job_id, batch_index, seq)` 主键 + `event_id`。这是**证据可追溯性的唯一权威映射**：导入时只能引用这里存在的 seq；
报告也通过它解析真实事件行。场次删除时随批次级联删除。

#### ai_job_viewers

`(job_id, batch_index, viewer_id)` 主键。记录该批次 `viewer_context.json` 中实际包含的稳定身份。
导入的 `viewer_profiles` 必须命中其中一个；汇总任务使用该任务所有批次身份的并集。**昵称不参与解析。**

#### ai_results

| 列 | 说明 |
| --- | --- |
| id | `air_<ULID>` |
| job_id / session_id | 外键，级联删除 |
| scope_key | `batch:<n>` 或 `final` |
| batch_index | 批次号；汇总结果为 NULL |
| task_id / task_kind | 结果声明的任务与类型 |
| protocol_version / schema_version | `livememory-analysis-result-v1` / `1.0.0` 或 `1.1.0` |
| locale | AI 回答声明的语言（用于不一致警告，不改变校验规则） |
| checksum | 规范化 JSON 的 SHA-256，用于重复导入 |
| result_version | 同一 `(job_id, scope_key)` 内递增，旧版本保留 |
| source | `file` / `paste` |
| result_json | 经过白名单重建/控制字符清理的完整结果 |
| evidence_total / evidence_missing | 引用总数 / 事件行已不存在的数量 |
| imported_at | 毫秒 |

`UNIQUE(job_id, scope_key, checksum)` 防止相同内容写入两次；不同内容通过 `createVersion` 显式追加版本。

#### ai_result_evidence

`(result_id, section, item_index, batch_index, seq)` 主键 + `event_id`（可空）+ `available`。
`section` = `topics` / `disputes` / `highlights`。它只保存引用与可用性，不复制聊天正文；
报告读取时再查 `events`，因此原文被保留策略清理或行被删除时能如实显示“不可用”。

**状态**：任务状态不单独存列，由 `computeJobStatus()` 根据任务、批次、最新结果实时计算：
`awaiting_import` / `partial` / `awaiting_aggregate` / `complete` / `invalid`。`sessions.ai_status` 只作为列表页的缓存，
同样由 `recomputeSessionAiStatus()` 重新计算。

## 3. 身份规则

- 稳定 UID 来自平台；缺失时 `viewer_id = NULL`，事件仍计入场次统计，但**不创建/更新观众档案**。
- **UID=0 等同缺失**：Bilibili 用 0 表示平台隐藏了身份（未登录风控）。`buildViewerId()` 与 `normalizeEvent()` 都把 `0` / `"0"` 规范成无身份，禁止产生 `platform:0` 这种所有人共用的档案。
- 不同平台的相同 UID 不合并（`platform` 前缀）；昵称相同也不合并。
- 昵称变化写入 `viewer_nicknames`，更新 `viewers.nickname`，不改变主键。
- **可识别观众** = 本场至少一条事件带稳定 UID 的去重人数（`viewer_sessions` 行数）；礼物/SC/大航海-only 的观众也算，不要求发言。
- **未识别身份消息** = `chat` / `super_chat` 中作者 `viewer_uid` 为空的条数；从 `events` 实时派生，不落冗余列，因此历史数据可重算。
- 打码昵称（例如 `A***`）不是身份，不能用于合并、搜索或反推；缺失 UID 的弹幕只保留消息与打码昵称。
- **主播身份独立于观众身份**：
  - YouTube 只认 channelId，视频 ID 不是主播长期身份；
  - Bilibili 优先 anchor uid；缺失时 room id 作为 `room_fallback`；
  - 无法确定时 `broadcaster_id=NULL`、`broadcaster_identity=unresolved`，场次保留。
- 主播 × 观众关系写入 `viewer_broadcasters`；全局 `viewers` 统计仍跨主播累计，但 UI/AI 必须明确区分。
- AI 无法确认身份的事件不得写入画像（M7 约束）。

## 4. 金额规则

- `unit_amount_minor * gift_quantity = amount_minor`（整数乘法）。
- `value_kind=actual`：平台报告的真实支付；`display`：礼物展示价值；`unknown`：未知金额（不参与合计）。
- 只累计 `is_paid=1 AND amount_minor>0` 的事件。
- 付费事件**计数**（`payment_event_count`）同样要求 `is_paid=1`：赠送会员的接收者、免费礼物不算付费事件。
- 同一事件重复投递 → 唯一键冲突 → 不累计。
- 不同币种分别返回，不做汇率换算。
- 没有金额的事件（YouTube 会员）`currency` 保持 `NULL`，不臆造默认币种。

## 4.1 YouTube 金额换算

- Super Chat / Super Sticker 的官方字段是 `amountMicros`（字符串，1 单位 = 1e-6 货币单位）。
- 换算用 BigInt：`minor = round(amountMicros / 10^(6 - currencyDigits))`，半进位；不经过浮点。
- `JPY` 等零小数币种按整数日元保存；`USD`/`EUR` 等保存为分。
- 会员等级、会员月数、赠送会员数量**永远不换算成金额**。

## 5. 去重键

```text
有 external_id → ext:<platform message id>
无 external_id → fp:<sha256(platform,type,uid,occurred_at,content,gift_id,gift_name,qty,amount,currency)[0..32]>
```

作用域为单场次（`UNIQUE(session_id, dedupe_key)`），允许同一消息在不同场次中独立存在。

## 6. 数据生命周期

| 模式 | 直播中 | 分析导入后 | 长期 |
| --- | --- | --- | --- |
| compact（默认） | 保留原文 | 校验成功后清理 `content`（保留行、计数、金额、身份） | 摘要/统计/画像 |
| full | 保留原文 | 保留 | 保留，可重新分析 |

清理函数：`purgeSessionContent()` 清空 `chat`/`super_chat` 的 `content` 与 `emotes`，并写 `content_purged_at`。**自动触发尚未接入**（M4/M6）。

### 6.1 YouTube 平台保留策略（已接入）

| 项目 | 说明 |
| --- | --- |
| 依据 | YouTube API Services Developer Policies：API 数据保存不超过 30 个日历日；匿名网页接口不是官方 API，但采用同样保守上限 |
| 默认/上限 | 30 天（`settings.youtubeRawRetentionDays`，1–30） |
| 实现 | `src/storage/retention.mjs`：`runRetention(db, {days})` / `purgeExpiredRawEvents` / `purgeExpiredYouTubeNicknames` |
| 触发 | 启动、YouTube 场次结束、`POST /api/youtube/retention/apply` |
| 清理 | `events.content`、`events.emotes`、`events.badges`、`events.amount_display` + 过期观众昵称历史/当前昵称 |
| 保留 | 行、计数、稳定 Channel ID、币种合计、`ai_packages` |
| 范围 | `platform='youtube'`；Bilibili 不清理 |
| 记录 | `app_meta['retention.lastRun'] = {at, days, platforms, purged, purgedNicknames, clearedViewerNicknames, cutoff}` |

**局限**：稳定 Channel ID 与按人聚合的金额/计数仍保留；这不等同于删除全部个人数据。严格删除/去标识化模式未实现。

### 6.2 永久删除单场（v0.7.0）

入口：`DELETE /api/sessions/:id`（必须 `{confirm:true}`）→ `session-admin.deleteSessionRecord()`。

守卫：`status='live'` 或 `SessionManager` 仍有该场 adapter 时返回 `409 SESSION_STILL_RECORDING`；
无显式确认返回 `400 DELETE_CONFIRM_REQUIRED`。

在一个 `BEGIN IMMEDIATE` 事务内：

1. 记录受影响观众（`viewer_sessions` 与 `events.viewer_id` 的并集）与该场 `ai_packages` 文件清单；
2. 显式删除 `ai_results`、`ai_jobs`（级联批次/消息映射/观众集合/证据）、`ai_packages`、
   `session_currency_totals`、`viewer_sessions`、`events`，再删除 `sessions`（外键级联仍开启，用于兜底）；
3. 对每个受影响观众 `rebuildViewerAggregates()`：
   - 仍有其他场次：`viewers.message_count/payment_event_count/first_seen_at/last_seen_at` 按剩余
     `viewer_sessions` 求和/取极值；`viewer_currency_totals` 按剩余 `events` 重新聚合；
   - 已无任何场次与事件：删除 `viewers`（级联昵称、关系、币种）；若 `focused=1`（用户标记重要），
     视为独立保留数据，保留观众但计数归零、币种合计清空；
   - 仍有 raw events 但无 `viewer_sessions`（历史/手工修复数据）：保留观众并从事件重建；
4. `rebuildViewerBroadcasterAggregates()` 重建 `viewer_broadcasters` 与
   `viewer_broadcaster_currency_totals`，只保留仍有场次的 broadcaster；其他主播的长期档案不受影响；
5. 删除没有任何场次、也没有任何 viewer 关系的孤立 `broadcasters` 行（纯派生数据）；
6. `assertNoResidue(session_id)` 校验 `events`、`viewer_sessions`、`session_currency_totals`、
   `ai_packages`、`ai_jobs`、`ai_results`、`sessions` 均无残留；失败抛错并回滚整个事务。

提交后删除该场次在 `exports/` 下的分析包文件（批次包与汇总包）。`safeExportPath()` 拒绝越出 `exports/` 的路径；
其他场次、设置、凭据、日志与无关文件不会被删除。

> **AI 结果随场次删除**：分析任务、批次、seq→event 映射、结果、证据与包记录都在同一事务内清除；
> 场次删除后不能再导入旧包或查看旧报告。AI 结果中的 `viewer_profiles` 也随结果一起删除，不会留下失去
> 来源的观众画像。**已知限制**：YouTube 30 天原文清理目前只清空事件正文/表情/徽章/过期昵称，不会自动删除
> 已导入 AI 结果中的画像或摘要；这些本地衍生存到用户删除场次或清空数据为止，不得声称完全符合平台政策。

### 6.3 启动恢复与历史平台状态修复（v0.8.1）

启动时：

1. `recoverInterruptedSessions()` 将遗留 `live` 行改为 `interrupted`，
   `end_reason='startup_recovery'`，`ended_at` = 启动检测时间；
   **不**使用 `last_event_at`，`platform_ended_at` 保持 NULL。
2. 服务就绪后后台 `repairBilibiliPlatformStatuses()` 探测
   `platform_status IS NULL` 且 `end_reason IN (NULL,'shutdown','startup_recovery')` 的
   Bilibili 已结束/中断行（最多 25 行）：
   - 当前 `live_status=0` 且该行有直播证据 → `platform_status='ended'`；
   - 当前 `2` → `carousel`；
   - 当前 `1` → `unknown`（当前直播可能是新场次，旧行不能改为 live）；
   - 无直播证据 → `unknown`；
   - 网络/429/-352 → 不写，下次启动重试；
   - 只写平台字段，不改 `status`、`ended_at`、事件、金额、观众或 AI 数据；
   - 写 `session.platform.repaired` / `session.platform.repair.failed` 日志；
   - 修复后 `platform_status` 非 NULL，后续启动不再重复查询（幂等）。
3. 用户手动停止（`end_reason='user'`）、适配器失败、已归类 `platform_ended` 的行不在修复范围。

## 7. 迁移策略

- 只追加迁移，不修改已应用迁移。
- 每个迁移在事务中执行并写入 `schema_migrations`。
- 应用版本与 schema 版本独立；`/api/status` 暴露 schema 版本。
- 迁移失败必须回滚，且不得让服务以半迁移状态启动。
- **v1 → v2**：`ALTER TABLE events ADD COLUMN emotes TEXT`。旧记录保持 `emotes = NULL`，读取时按“无表情元数据”处理；不需要重写表，不丢失旧消息。
- **v2 → v3**：`ALTER TABLE sessions ADD COLUMN platform_started_at INTEGER`。旧场次为 `NULL`，UI/AI 包按「未知直播开始时间」处理，不推断。
- **v3 → v4**：`ALTER TABLE events ADD COLUMN badges TEXT` + `amount_display TEXT`。旧行为 `NULL`；迁移不重写表。
- **v4 → v5**：
  - 新建 `broadcasters`、`viewer_broadcasters`、`viewer_broadcaster_currency_totals`；
  - `sessions` 增加 `broadcaster_id`（可空，`ON DELETE SET NULL`）与 `broadcaster_identity`；
  - 回填：Bilibili 有 room id → `bilibili:room:<id>`（`room_fallback`）；mock → `mock:simulation`；YouTube 历史只有视频 ID → `broadcaster_id=NULL` / `unresolved`，不猜测；
  - 从 `viewer_sessions` 回填 `viewer_broadcasters`，从 `events` 回填主播维度币种合计；
  - 旧场次、观众、事件、`viewer_id`、金额与计数全部保留。
- **v6 → v7**：
  - `ALTER TABLE sessions ADD COLUMN archived_at INTEGER`（旧行 NULL = 未归档）；
  - `ALTER TABLE sessions ADD COLUMN end_reason TEXT`（旧行 NULL，不推断结束原因）；
  - 新增 `idx_sessions_history`、`idx_sessions_platform_started`、`idx_viewers_nickname`、
    `idx_viewer_nicknames_nickname`、`idx_viewer_sessions_viewer_seen`；
  - 不重写表、不改历史行；v1→v7 与 v6→v7 均有测试。打包 EXE 已用真实 schema 6 数据库实测升级。
- **v7 → v8**：
  - 新建 `ai_jobs`、`ai_job_batches`、`ai_job_messages`、`ai_job_viewers`、`ai_results`、
    `ai_result_evidence` 及索引；
  - `ai_packages` 增加 `job_id`、`batch_index`、`stage`（默认 `single`）、`prompt_version`；
  - 旧包行保持 `job_id=NULL`、`batch_index=NULL`、`stage='single'`，旧分析包仍可导入（legacy 任务）；
  - 不重写旧表、不删除历史；`tests/integration/ai-migration.test.mjs` 覆盖 v7→v8 与级联删除；
    打包 EXE 用真实 schema 7 数据库实测升级到 9。
- **v8 → v9**：
  - `sessions` 增加 `platform_status`、`platform_status_at`、`last_live_seen_at`、
    `platform_ended_at`、`platform_end_quality`；
  - 新建 `idx_sessions_platform_status (platform, platform_status, started_at DESC)`；
  - 旧行 5 列全部 NULL：不猜测历史平台状态，也不伪造平台结束时间；
  - 不重写表、不影响 AI 表/事件/金额/观众；
  - `tests/integration/platform-status-migration.test.mjs` 覆盖 v8→v9、重复迁移无操作、
    新库直接 v9。
- 未来迁移需在 `tests/integration/` 增加升级路径测试（v1→v5 见 `migration-emotes.test.mjs`；v4→v5 见 `broadcaster-identity.test.mjs`；v7→v8 见 `ai-migration.test.mjs`）。

## 8. 备份、清空与数据位置

- 删除/恢复出厂前可创建数据库应急快照：`VACUUM INTO %LOCALAPPDATA%\LiveMemory-Backups\livememory-database-<timestamp>.db`（`LIVE_MEMORY_BACKUP_DIR` 可覆盖）。它只含数据库，不含分析包/凭据/设置，**不是** M5 的 `.livememory` 可移植备份。
- 清空 `data`：删除业务表与全部 AI 表（`ai_result_evidence`、`ai_results`、`ai_job_messages`、
  `ai_job_viewers`、`ai_job_batches`、`ai_jobs`、`ai_packages`）、`exports/`、`cache/`；保留设置、凭据、
  位置记录、`backups/`、日志、根目录无关文件。
- 恢复出厂 `factory`：额外删除偏好、凭据、日志、缓存并重置设置；仍保留位置记录、`backups/`、根目录无关文件。
- 删除后 `VACUUM` + WAL checkpoint，然后重建运行时；`schema_migrations` 与 schema 版本保留，数据库为空而非删除文件。
- M5 可移植备份仍需使用一致快照、`schema_version`、应用版本与文件校验和；凭据默认不进入备份。

## 9. 数据位置记录

- `%LOCALAPPDATA%\LiveMemory\data-location.json`（镜像 `%APPDATA%\LiveMemory\data-location.json`）：
  ```json
  {"version":1,"dataDir":"D:\\LiveMemoryData","updatedAt":"2026-11-08T..."}
  ```
- 只保存路径指针，不保存数据库内容或凭据；数据库移动后仍能被启动器找到。
- 目标必须已存在且包含 `database/livememory.db`；否则启动报错，不创建空库。

## 10. 长期观众记忆（schema 10 / v0.9.0）

### 10.1 表

| 表 | 主键/唯一 | 关键列 |
| --- | --- | --- |
| `viewer_memories` | `id`；`UNIQUE(broadcaster_id, viewer_id)` | `status`(active/deleted)、`version`、`summary`、`summary_certainty`、`first_memory_at`、`last_update_at`、`last_session_id`、`last_job_id`、`deleted_at`、`delete_reason` |
| `memory_facts` | `id` | `memory_id`、`kind`、`topic`、`statement`、`certainty`(stated/inferred/uncertain)、`status`(active/outdated/conflicted/superseded/needs_confirmation)、`status_reason`、`confidence`、`dedupe_key`、`evidence_status`/`evidence_count`/`evidence_available`、`source_kind`/`source_session_id`/`source_job_id`/`source_result_id`/`source_label`、`valid_from`/`valid_until`、`superseded_by`、`conflicts_with`、`user_verified`、`first_seen_at`/`last_confirmed_at` |
| `memory_fact_evidence` | `(fact_id, source_key)` | `session_id`、`batch_index`、`seq`、`event_id`、`observed_at`、`available` |
| `memory_versions` | `id`；`UNIQUE(memory_id, version)`；`UNIQUE(memory_id, source_key)` | `source_kind`、`source_job_id`、`source_result_id`、`source_session_id`、`counts_json`、`diff_json`、`snapshot_json`、`applied_at` |
| `memory_jobs` | `id` | `broadcaster_id`、`session_id`、`locale`、`prompt_version`、`protocol_version`、`schema_version`、`scope`、`batch_total`、`viewers_total`、`messages_total`、`last_error_*` |
| `memory_job_batches` | `(job_id, batch_index)`；`UNIQUE(job_id, batch_id)` | `task_id`、`viewer_count`、`message_count`、`checksum`、`file_name`、`bytes`、`package_checksum` |
| `memory_job_messages` | `(job_id, batch_index, seq)` | `event_id` |
| `memory_job_viewers` | `(job_id, batch_index, viewer_id)` | `base_memory_id`、`base_version` |
| `memory_results` | `id`；`UNIQUE(job_id, batch_id, checksum)` | `batch_index`、`result_json`、`viewer_total`、`op_total`、`evidence_total`、`evidence_missing`、`applied_at` |

### 10.2 约束与不变量

- 记忆只属于一个 `broadcaster_id`；不存在跨主播记忆行。
- 「一个话题一条存活事实」由**部分唯一索引**保证：`idx_memory_facts_dedupe(memory_id, dedupe_key) WHERE status <> 'superseded'`。
  因此 `supersede` 可以复用话题键（旧事实退出索引），而 `conflict`/同键 `update` 被引擎拒绝或跳过。
- `memory_facts` 是当前状态；`memory_versions.snapshot_json` 是对应版本的完整事实集合，`diff_json` 是逐条差异。
  两者在同一事务内写入，永不漂移。
- 删除记忆 = 删除事实/证据/版本 + 记忆头标记 `deleted`（`version=0`）。墓碑用于拒绝删除前生成的旧更新包。
- 删除场次：删除 `memory_jobs`（级联批次/映射/结果）与导出文件；事实保留，证据状态刷新为不可用。
- `memory_results` 只保存已通过校验并被应用的结果；预览不落库。
- 金额不进入任何记忆列；`source_label` 只存来源类型标签。

### 10.3 迁移

- v9 → v10 只新增表与索引，不改写任何既有行；旧库现场升级（测试覆盖真实 v9 库）。
- 记忆表同时纳入清空数据/恢复出厂范围。

## 11. 自动监听目标（schema 11 / v0.10.0）

### 11.1 概念分离

| 概念 | 表 | 生命周期 |
| --- | --- | --- |
| 监听目标（直播间 / 频道） | `monitor_targets` | 用户添加后长期存在；关播不删除，只有显式删除才移除 |
| 单场直播记录 | `sessions` | 每次开播一条；结束只改该行，不影响目标与其他场次 |

`monitor_targets` **不是**场次的父亲：删除目标不级联删除 `sessions`，只把
`sessions.monitor_target_id` 置空（历史保留）。删除场次也只清空目标上的
`active_session_id` / `last_session_id` 指针。

### 11.2 表

| 表 | 主键/唯一 | 关键列 |
| --- | --- | --- |
| `monitor_targets` | `id`；`UNIQUE(platform, target_key)` | `platform`(bilibili/youtube)、`target_key`(真实房间号/频道 ID)、`display_name`、`input`、`broadcaster_id`、`platform_uid`、`enabled`、`state`、`next_check_at`、`last_check_at`、`last_live_at`、`last_session_id`、`active_session_id`、`consecutive_failures`、`last_error_code`/`last_error_at`、`paused_at`、`meta_json` |

索引：`(enabled, state, next_check_at)` 供调度器选取到期目标；
`broadcaster_id, updated_at DESC` 供按主播查看。

### 11.3 状态与不变量

`state` 是**监听生命周期**，不是采集连接状态：

```text
waiting → checking → connecting → recording → ending → waiting
   ↑          ↓            ↓
   └── error ←┴────────────┘
paused（用户暂停；正在进行的 recording 不受影响）
```

- `recording` 时公开状态可由连接状态派生为 `reconnecting`，但数据库不把它写成新状态：
  **网络重连不是新的一场直播**，仍使用同一个 `session_id`。
- 只有 `sessions.status` 不再是 `live`（平台确认下播、用户停止、进程恢复）时，目标才回到
  `waiting` / `paused`；下一次确认 `live` 才创建新场次。
- 连续失败达到阈值进入 `error` 并显示原因；30 分钟后低频重试，用户也可手动重试。
- 同一 `(platform, target_key)` 只能有一条目标；重复添加返回 409，不是静默合并。
- 正在记录时删除目标被拒绝（409）；必须先停止记录。暂停监听不停止当前记录。

### 11.4 迁移

- v10 → v11：`ALTER TABLE sessions ADD COLUMN monitor_target_id`、新增
  `monitor_targets` 与两个索引；旧场次该列为 NULL，旧数据不改写。
- `monitor_targets` 纳入清空数据/恢复出厂范围；删除单个场次与删除目标都不删除对方。

## 12. 统一分析与长期记忆覆盖（schema 12 / v0.11.0）

### 12.1 原则

- 一次分析任务同时覆盖本场报告与**全部可识别观众**；不存在只更新前 N 名观众的字段。
- 每个观众只分配到一个分析批次，其本场全部可用发言（最近 120 条）随该批次导出；
  `ai_job_memory_viewers` 保证覆盖，`ai_job_memory_messages` 保证证据可追溯。
- 客观互动历史不新增统计表：继续使用 `viewers`、`viewer_sessions`、
  `viewer_broadcasters`、`broadcaster_viewer_currency_totals` 等既有聚合；
  导入时只确保 `viewer_memories` 头存在并更新 `last_session_id` / `last_update_at`，
  不伪造语义版本。
- 语义事实、证据、版本继续使用 `memory_facts` / `memory_fact_evidence` /
  `memory_versions`，规则与 M7 相同。

### 12.2 新增结构

| 表/列 | 主键/唯一 | 关键列 |
| --- | --- | --- |
| `ai_jobs.memory_viewers_total` | — | 本任务需要覆盖的可识别观众总数 |
| `ai_job_memory_viewers` | `(job_id, viewer_id)` | `batch_index`、`base_memory_id`、`base_version`、`message_count`、`status`、`result_id`、`processed_at` |
| `ai_job_memory_messages` | `(job_id, batch_index, seq)` | `viewer_id`、`event_id`（记忆证据 `seq → 真实事件`） |

`status` 取值：`pending`（所属批次尚未导入）、`semantic`（有新语义）、
`no_semantics`（已处理但无新语义）、`objective_only`（旧结果/仅客观）、
`missing_update`（缺少该观众的更新，阻塞导入）、`deleted`（记忆已删除，旧包不能恢复）、
`failed`（该观众校验失败被隔离；合法观众仍可独立保存，Resume 只重试该观众）。

### 12.3 覆盖与状态

- 导出时：每个观众一条 `ai_job_memory_viewers`（`pending`），任务 `memory_viewers_total`
  记录总数；批次不应有 `pending` 之外的遗漏。
- 导入时：同一事务内保存分析结果、确保客观记忆头、应用语义操作、更新覆盖状态。
  v0.13.2 起，被隔离观众的 `failed` 状态也在同一事务写入。
- `memoryCoverage.complete` 要求 `pending = 0`、`missing_update = 0` 且 `failed = 0`；
  `covered` 排除这三类。任务只有在全部分配观众处理完且（多批时）汇总结果导入后才可能 `complete`。
- 同一结果重复导入是 `duplicate`，不增加版本、不重复计数；同一批次新结果需要显式新版本。
  v0.13.2 的观众级恢复会对同一批次追加一个只含恢复观众的新版本（例如 v2），
  已成功观众的事实不重复写入。

### 12.4 迁移

- v11 → v12：新增 `ai_jobs.memory_viewers_total`、两张覆盖/证据表和索引；
  旧任务 `memory_viewers_total=0`，旧结果按无 `viewer_memory_updates` 处理，
  仅更新客观历史，不阻断 M6 报告导入。
- 旧 M7 独立记忆任务表（`memory_jobs` 等）保留，用于已存在数据的查看/删除；
  不再由 UI 创建新的独立记忆任务。

## 13. AI 任务模式与 Provider 快照（schema 13 / v0.13.0）

迁移 13 只增加列/表，不重写历史：

`ai_jobs` 新增：

- `analysis_mode`：`session` / `memory` / `combined`（旧行 default combined）。
- `provider_config_id`、`provider_id`、`region_id`、`model_id`、`pricing_status`：任务实际使用的配置快照。
- `budget_json`、`cost_estimate_json`、`usage_json`、`requested_by`。

`ai_results` 新增 `analysis_mode`（default combined），报告读模型据此排除 memory-only 结果。

新表 `ai_provider_tests`：config/provider/region/model、status、capabilities_json、stages_json、duration_ms、tested_at；用于能力检测审计，删除配置后仍可保留。

不变量：

- 旧 `combined` 行继续按旧逻辑读取；不要用迁移把它们改成 session/memory。
- session 任务结果不触发 `applyMemorySideEffects`；memory 任务结果不能作为单场报告。
- 删除场次仍级联删除 ai_jobs/ai_results；provider 配置与密钥独立于场次。

## 14. v0.13.1 无 schema 变化

- Schema 仍为 **13**；v0.13.1 不新增迁移。
- 删除的是匿名/手动入口与调度模块，不删除表、不重写历史结果。
- 大 job 的 package 读取改为 `getJobPackage(job_id, stage, batch_index)` 精确查询；`ai_packages` 表结构不变。
- 画像批次上限不再依赖 `MAX_AUTO_BATCHES=30`；实际安全边界仍是 `MAX_ANALYSIS_VIEWERS=20000`，超出明确失败。
- 请求统计只保存在 `runtime/ai-v13.json` 与内存，不写入数据库；不包含提示词、聊天正文或模型回答。

## 15. 监听目标的手动停止抑制（v0.13.1，无 schema 变化）

- `monitor_targets.meta_json` 新增可选的 `manualStop` 对象：
  ```json
  {"sessionId":"ses_...","liveKey":"bilibili:123:1760000000","stoppedAt":1760000000000,"awaitingOffline":false}
  ```
- 同一目标只保留当前直播周期的抑制；确认 offline/upcoming 后清除；新 `live_time`/`videoId` 视为新周期。
- 不新增列、不迁移；`meta_json` 仍是本地目标快照，不含聊天正文或凭据。
- `live_stopped` 是目标状态，不改变 `sessions.status`；被停止的 session 仍是 `ended` + `end_reason=user`。

## 16. API 配置原地编辑（v0.13.1，无 schema 变化）

- `config/ai-providers.json` 的配置记录保持同一 `id`；编辑不删除重建。
- `secrets/ai-keys.json` 的 credential reference 在仅改模型/名称/并发/价格时不变；Provider/区域/Base URL 变化时生成新 reference 并要求新 Key。
- 模型变化后 `capabilities`、`lastTestStatus`、`modelLabel`、`contextLength`、旧价格都会失效；不把旧模型能力写入新模型。
- `ai_jobs` 仍保存启动时的 provider/model/pricing 快照；历史 `ai_results` 与 `viewer_memories` 不因配置编辑而改写。

## 17. 报告翻译展示缓存（schema 14 / v0.13.2）

### 17.1 原则

- 翻译是**展示派生数据**，不是分析结果：它不写 `ai_results`、`viewer_memories`、`memory_facts`、金额、计数或身份。
- 原始报告/事实保持不可变；同一原始对象可以有多个目标语言的展示版本。
- `viewer_id`、`topic` 匹配键、事实 ID、状态、certainty、版本、证据引用、时间、金额、计数不进入翻译项。

### 17.2 表

| 表 | 主键/唯一 | 关键列 |
| --- | --- | --- |
| `ai_translations` | `id`；`UNIQUE(target_kind, target_id, item_path, target_locale, source_hash, translator_version)` | `session_id`、`source_locale`、`translated_text`、`status`（`ok`/`failed`）、`error_code`、provider/model 快照、`created_at`、`updated_at` |
| `ai_translation_runs` | `id` | `session_id`、`target_locale`、`source_locale`、`status`（`running`/`complete`/`partial`/`failed`/`interrupted`）、`total_items`/`translated_items`/`failed_items`/`pending_items`、`usage_json`、`error_json`、provider/model 快照、`started_at`/`updated_at`/`completed_at` |

索引：

```sql
CREATE INDEX idx_ai_translation_runs_session
  ON ai_translation_runs (session_id, target_locale, started_at DESC);
CREATE INDEX idx_ai_translations_session
  ON ai_translations (session_id, target_locale, target_kind, target_id);
CREATE INDEX idx_ai_translations_target
  ON ai_translations (target_kind, target_id, target_locale);
```

### 17.3 键与失效

- `target_kind`：`session_result`（`ai_results.id`）、`memory_summary`（`viewer_memories.id`）、`memory_fact`（`memory_facts.id`）。
- `item_path`：稳定字段路径，例如 `summary`、`topics.0.title`、`facts.mfc_x.statement`。
- `source_hash`：源文本 SHA-256；`translator_version` 当前为 `lm-translation-v1`。
- 新结果版本 = 新 `ai_results.id`；事实文本变化 = 新 hash。旧行不会被用于新内容。
- 同一条目重试成功会更新同一唯一键的 `status`/`translated_text`；失败行保留错误码，供只重试失败段使用。

### 17.4 生命周期与清理

- `session_id REFERENCES sessions(id) ON DELETE CASCADE`；删除单场时显式删除两张表并纳入 `assertNoResidue`。
- 删除观众记忆：删除该 `memory_summary` 与全部 `memory_fact` 翻译；保留记忆墓碑。
- 清空数据/恢复出厂包含两张表；数据库备份/迁移随整库复制。
- 翻译表不含聊天原文、API Key、请求头或模型推理正文；`error_json` 只存稳定错误码、HTTP 状态与时间。

### 17.5 迁移 v13 → v14

- 只新增两张表与三个索引；不 `ALTER`、不重写任何历史行。
- 旧库升级后，已有报告/画像仍按原语言显示；首次切换语言时才生成缓存。
- 测试：`tests/integration/ai-translation-migration.test.mjs`（v13→v14、重复迁移无操作、场次级联）。

## 18. 分层汇总节点（schema 15 / v0.13.2）

### 18.1 表

```text
ai_aggregate_nodes
  id TEXT PRIMARY KEY
  job_id TEXT NOT NULL REFERENCES ai_jobs(id) ON DELETE CASCADE
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
  level INTEGER NOT NULL              -- 0 = final; 1..N = partial summary
  node_index INTEGER NOT NULL         -- deterministic first batch index
  source_kind TEXT NOT NULL           -- batches | nodes | final
  source_keys_json TEXT NOT NULL      -- child checksums / node ids + digests
  source_hash TEXT NOT NULL           -- reuse only when sources are unchanged
  covered_batches_json TEXT NOT NULL  -- exact batch ledger
  status TEXT NOT NULL                -- pending | complete | failed
  digest_json TEXT                    -- bounded partial/final session_topics
  fallback TEXT                       -- null | deterministic
  attempts INTEGER NOT NULL
  input_tokens_estimated INTEGER
  output_tokens INTEGER
  usage_json TEXT
  coverage_json TEXT
  last_error_json TEXT
  created_at INTEGER NOT NULL
  updated_at INTEGER NOT NULL
  UNIQUE (job_id, level, node_index)
```

### 18.2 约束

- `level=0,node_index=0` 唯一表示 final；level>0 是局部节点，`node_index` 取该组第一个原批次号，保证同一输入得到同一节点身份。
- 节点先校验（schema/覆盖/ref/时间）再写入；`source_hash` 不匹配则不复用。
- `digest_json` 不是 `ai_results`：不会进入报告读模型，只有 final 经 `assembleSessionAggregateAnswer()` 组装成 Schema 1.3.0 后走正常导入。
- 删除场次/清空数据包含该表；`assertNoResidue` 检查 `session_id`。
- v14→v15 只新增表与两个索引，不改写任何历史行；测试覆盖 v13→v15、重复迁移、场次级联。

