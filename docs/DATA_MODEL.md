# 数据模型（DATA_MODEL）

数据库：`<数据目录>/database/livememory.db`（SQLite，WAL）
Schema 版本：**1**
迁移入口：`src/storage/database/migrations/index.mjs`

## 1. 设计原则

1. 时间统一为 epoch 毫秒整数（INTEGER）。
2. 金额统一为整数最小货币单位（minor units），并带 `currency` 与 `value_kind`。
3. 观众主键 = `platform:stable_uid`，昵称只作展示。
4. 事件以 `(session_id, dedupe_key)` 唯一，重复投递不产生第二行。
5. 聚合值存表（场次/观众/币种），读模型不扫描全量事件。
6. 删除遵循外键级联，避免孤儿数据。

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
| broadcaster_name | TEXT | 主播名 |
| status | TEXT | `live` / `ended` / `interrupted` |
| storage_mode | TEXT | `compact` / `full`（场次级覆盖） |
| source_quality | TEXT | `verified` / `estimated` / `unknown` / `mock` |
| simulated | INTEGER | 1 = 模拟数据 |
| started_at / ended_at / last_event_at | INTEGER | 毫秒 |
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
| gift_id / gift_name / gift_type | 礼物信息；`gift_type` = `paid` / `free` |
| gift_quantity | 数量 |
| unit_amount_minor / amount_minor | 单价 / 总价（最小单位） |
| currency | ISO-4217 |
| value_kind | `actual` / `display` / `unknown` |
| is_paid | 0/1 |
| source_quality | 数据可信度 |
| dedupe_key | `ext:<id>` 或 `fp:<sha256 前 32 位>` |
| content_purged_at | 精简模式清理时间 |

约束与索引：`UNIQUE(session_id, dedupe_key)`、`(session_id, occurred_at)`、`(viewer_id, occurred_at)`、`event_type`。

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

### ai_packages

导出记录：`id`、`session_id`、`kind`、`protocol_version`、`locale`、`file_name`、`relative_path`、`checksum`、`message_count`、`created_at`。为 M6 的导入去重与任务追踪预留。

## 3. 身份规则

- 稳定 UID 来自平台；缺失时 `viewer_id = NULL`，事件仍计入场次统计，但**不创建/更新观众档案**。
- 不同平台的相同 UID 不合并（`platform` 前缀）。
- 昵称变化写入 `viewer_nicknames`，更新 `viewers.nickname`，不改变主键。
- AI 无法确认身份的事件不得写入画像（M7 约束）。

## 4. 金额规则

- `unit_amount_minor * gift_quantity = amount_minor`（整数乘法）。
- `value_kind=actual`：平台报告的真实支付；`display`：礼物展示价值；`unknown`：未知金额（不参与合计）。
- 只累计 `is_paid=1 AND amount_minor>0` 的事件。
- 同一事件重复投递 → 唯一键冲突 → 不累计。
- 不同币种分别返回，不做汇率换算。

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

清理函数：`purgeSessionContent()` 仅清空 `chat`/`super_chat` 的 `content` 并写 `content_purged_at`。**自动触发尚未接入**（M4/M6）。

删除场次：`DELETE FROM sessions` → 级联删除事件、`viewer_sessions`、币种合计、AI 包记录；观众本身保留（可能参与其他场次）。

## 7. 迁移策略

- 只追加迁移，不修改已应用迁移。
- 每个迁移在事务中执行并写入 `schema_migrations`。
- 应用版本与 schema 版本独立；`/api/status` 暴露 schema 版本。
- 迁移失败必须回滚，且不得让服务以半迁移状态启动。
- 未来迁移需在 `tests/integration/storage.test.mjs` 增加升级路径测试。

## 8. 备份相关（M5 设计）

- 备份必须使用 SQLite 一致快照（`VACUUM INTO` 或 backup API），禁止直接复制正在写入的 `.db`。
- 备份内需包含 `schema_version`、应用版本、文件校验和。
- 凭据（Cookie/Token/API Key）默认不进入备份。
