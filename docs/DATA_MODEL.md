# 数据模型（DATA_MODEL）

数据库：`<数据目录>/database/livememory.db`（SQLite，WAL）
Schema 版本：**5**
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
| status | TEXT | `live` / `ended` / `interrupted` |
| storage_mode | TEXT | `compact` / `full`（场次级覆盖） |
| source_quality | TEXT | `verified` / `estimated` / `unknown` / `mock` |
| simulated | INTEGER | 1 = 模拟数据 |
| started_at | INTEGER | 本地开始记录的时间（毫秒） |
| platform_started_at | INTEGER | 平台侧直播开始时间（YouTube `actualStartTime`，可空；schema v3） |
| ended_at / last_event_at | INTEGER | 毫秒 |
| message_count | INTEGER | 聊天 + SC 条数 |
| gift_event_count | INTEGER | 礼物事件数 |
| payment_event_count | INTEGER | 所有付费事件数 |
| ai_status | TEXT | `none` / `exported` / `imported` |
| created_at / updated_at | INTEGER | 毫秒 |

索引：`started_at DESC`、`status`。

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

导出记录：`id`、`session_id`、`kind`、`protocol_version`、`locale`、`file_name`、`relative_path`、`checksum`、`message_count`、`created_at`。为 M6 的导入去重与任务追踪预留。

## 3. 身份规则

- 稳定 UID 来自平台；缺失时 `viewer_id = NULL`，事件仍计入场次统计，但**不创建/更新观众档案**。
- 不同平台的相同 UID 不合并（`platform` 前缀）；昵称相同也不合并。
- 昵称变化写入 `viewer_nicknames`，更新 `viewers.nickname`，不改变主键。
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

删除场次：`DELETE FROM sessions` → 级联删除事件、`viewer_sessions`、币种合计、AI 包记录；观众本身保留（可能参与其他场次）。

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
- 未来迁移需在 `tests/integration/` 增加升级路径测试（v1→v5 见 `migration-emotes.test.mjs`；v4→v5 见 `broadcaster-identity.test.mjs`）。

## 8. 备份、清空与数据位置

- 删除/恢复出厂前可创建数据库应急快照：`VACUUM INTO %LOCALAPPDATA%\LiveMemory-Backups\livememory-database-<timestamp>.db`（`LIVE_MEMORY_BACKUP_DIR` 可覆盖）。它只含数据库，不含分析包/凭据/设置，**不是** M5 的 `.livememory` 可移植备份。
- 清空 `data`：删除业务表、`exports/`、`cache/`；保留设置、凭据、位置记录、`backups/`、日志、根目录无关文件。
- 恢复出厂 `factory`：额外删除偏好、凭据、日志、缓存并重置设置；仍保留位置记录、`backups/`、根目录无关文件。
- 删除后 `VACUUM` + WAL checkpoint，然后重建运行时；`schema_migrations` 与 schema v5 保留，数据库为空而非删除文件。
- M5 可移植备份仍需使用一致快照、`schema_version`、应用版本与文件校验和；凭据默认不进入备份。

## 9. 数据位置记录

- `%LOCALAPPDATA%\LiveMemory\data-location.json`（镜像 `%APPDATA%\LiveMemory\data-location.json`）：
  ```json
  {"version":1,"dataDir":"D:\\LiveMemoryData","updatedAt":"2026-11-08T..."}
  ```
- 只保存路径指针，不保存数据库内容或凭据；数据库移动后仍能被启动器找到。
- 目标必须已存在且包含 `database/livememory.db`；否则启动报错，不创建空库。
