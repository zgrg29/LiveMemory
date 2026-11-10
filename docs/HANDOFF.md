# 交接文档（HANDOFF）

本轮：2026-11-10 · M7 长期观众记忆 · v0.9.0（schema v10）

## 1. 本轮结果

| 目标 | 结论 |
| --- | --- |
| 现状审计 | 已完成。M6 的文件往返、分批、严格校验、证据映射可直接复用；M7 之前只有「主播维度统计」与「场次级 AI 画像」，没有跨场长期记忆。 |
| 长期画像数据模型 | 已完成。schema 10 新增 8 张表：记忆头、事实、证据、版本、记忆任务/批次/消息映射/批次观众、已应用结果。按 `broadcaster × viewer` 唯一。 |
| 增量更新（核心） | 已完成。两条路径共用同一合并引擎：①本地合并已导入的 M6 分析（不接 AI）；②AI 记忆更新包往返。只新增/确认/替换/标记，不重复、不删除。 |
| 版本与差异 | 已完成。每次应用写一个版本（含完整快照与逐条差异），可回滚（回滚本身也是新版本）。 |
| 矛盾与状态变化 | 已完成。`supersede`（状态变化，旧事实留作历史）、`conflict`（矛盾，双方标记，不替主播裁决）、`outdated`（可能过时，不删除）、`uncertain`（需确认）。 |
| 证据与可信度 | 已完成。事实级证据（场次/批次/seq/event_id）、`certainty` 与 `status` 分离、`user_verified`、原文清理后降级为 purged/partial/unavailable。 |
| AI 协议 | 已完成。`livememory-memory-update-v1` + Schema 1.0.0 + 三语提示词 `lm-prompt-m7.1-*`；8 MB、结构防护、ID/事实/证据/基线版本全部校验。 |
| 幂等与事务 | 已完成。结果按 `(job, batch, checksum)` 唯一；同内容重复导入不写；不同内容需显式新版本；应用是单事务。 |
| 隐私 | 已完成。按主播隔离；可删除单个观众记忆（墓碑阻止旧包恢复）；本地合并不复活；过期清理需显式确认；原始聊天清理/删除场次/清空数据都正确联动。 |
| 界面 | 已完成（代码）。新增 `#/memory` 四步工作台；观众档案改为 4 个标签页，含事实分组、证据、操作、版本差异与恢复。三语 + 明暗 + 响应式，无 `innerHTML`。 |
| 测试 | **450 自动化全部通过**（本轮新增 64 项）。 |
| 真实浏览器验收 | **未完成**。本机应用控制策略会终止无头 Edge/Chrome（退出码 `0x80000003` / `-36863`），`scripts/verify-memory-ui.mjs` 已写好但本轮未跑通。 |
| 打包 EXE | **已构建、未能执行**。`dist/LiveMemory.exe` v0.9.0：91.0 MB / 134 资源 / `requireAdministrator` / SHA-256 `576a6d12…`；本机运行被策略拒绝（EPERM），需在其他环境启动验收。 |

## 2. 后端变化

### 2.1 新模块

| 文件 | 职责 |
| --- | --- |
| `src/memory/constants.mjs` | 协议/版本/上限/枚举/任务与批次 ID 规则 |
| `src/memory/model.mjs` | 归一化、去重键、事实工厂、证据、差异、过时规则、分组 |
| `src/memory/engine.mjs` | 纯合并引擎（add/confirm/update/supersede/conflict/outdated/uncertain）+ 人工复核 |
| `src/memory/store.mjs` | 预览/应用/回滚/复核；版本、快照、事务、证据刷新 |
| `src/memory/local.mjs` | 复用 M6 导入结果的确定性合并（选择最新分析、生成操作、幂等 source key） |
| `src/memory/export.mjs` | 记忆更新任务与分批包（manifest、memory_context、viewer_excerpts、instructions、schema） |
| `src/memory/prompt.mjs` | 三语指令（证据规则、状态变化 vs 矛盾、敏感属性禁令） |
| `src/memory/validate.mjs` | 导入校验与真实差异预览（核心安全边界） |
| `src/memory/importer.mjs` | 事务应用、重复/新版本判定 |
| `src/memory/view.mjs` | 记忆页/观众档案/任务状态读模型、证据解析 |
| `src/memory/maintenance.mjs` | 删除、过期清理、保留状态 |
| `src/storage/repositories/viewer-memory.mjs` | 全部 SQL 读写（含部分唯一索引语义、证据刷新、版本裁剪） |
| `src/memory/schemas/memory-update-result-v1.schema.json` | 结果 Schema |

### 2.2 修改

- `src/storage/database/migrations/index.mjs`：**v10**（8 张表 + 索引；`memory_facts` 去重使用部分唯一索引 `WHERE status <> 'superseded'`）。
- `src/server/routes.mjs`：新增 `/api/memory/*` 共 13 个端点；`/api/status`、`/api/bootstrap` 增加 `memory` 能力块。
- `src/server/session-admin.mjs`：删除场次同时删除该场记忆任务与导出包，并在事务内刷新记忆证据状态；残留检查加入 `memory_jobs`。
- `src/server/maintenance.mjs`：清空/恢复出厂覆盖全部记忆表。
- `src/storage/retention.mjs`：YouTube 原文清理后刷新记忆证据（`memoryFactsRechecked`），不删除记忆。
- `src/web/js/app.js`、`src/web/index.html`、`src/web/styles/base.css`：新增 `#/memory` 路由与导航。
- `src/web/js/pages/viewers.js`：详情页改为标签页，新增长期记忆摘要卡与入口。
- `src/web/styles/components.css`：标签页、事实卡、证据、版本、差异、预览行样式（只用 tokens）。
- `src/web/i18n/{zh-CN,ja,en}.json`：新增 `memory.*`（160 键）、`viewers.detail.tab*`、`errors.memory*`；`ai.import.reason.*` 增加记忆错误码、`ai.import.fix.*` 增加 job/broadcaster/target/evidence/privacy 组。
- 版本：`package.json`、`src/shared/app-info.mjs` → `0.9.0`。

### 2.3 路由一览

```text
GET  /api/memory/overview?broadcasterId=          记忆总览 + 可合并直播 + 最近任务 + 保留状态
GET  /api/memory/sessions?broadcasterId=          可合并的直播（含是否已导入分析）
POST /api/memory/merge                            {sessionId, apply:false|true, viewerIds?, limit?}
POST /api/memory/jobs                             {sessionId, locale?, viewersPerBatch?}
GET  /api/memory/jobs?sessionId=&broadcasterId=
GET  /api/memory/jobs/:id
GET  /api/memory/jobs/:id/instructions?batchIndex=
GET  /api/memory/jobs/:id/batches/:index/download
GET  /api/memory/viewers/:id?broadcasterId=       事实/证据/版本/分组
POST /api/memory/viewers/:id/delete               {broadcasterId, confirm:true}
POST /api/memory/viewers/:id/facts/:factId/review {action: confirm|dismiss|restore|forget|mark_inferred}
POST /api/memory/viewers/:id/rollback             {broadcasterId, version}
POST /api/memory/import/preview                   {json, source}
POST /api/memory/import                           {json, source, createVersion}
POST /api/memory/prune                            {broadcasterId, olderThanDays, dryRun}
GET  /api/memory/retention?broadcasterId=
```

### 2.4 AI 文件协议要点

```text
包: LiveMemory-Memory-<session8>-<job6>-bNNofMM-<YYYYMMDD-HHmm>-<locale>.zip
    manifest.json / memory_context.json / viewer_excerpts.jsonl / instructions.md / result.schema.json
结果: protocol=livememory-memory-update-v1, schema_version=1.0.0
      job_id + batch_id + task_id + session_id + broadcaster_id (+ locale)
      viewer_operations[].operations[].op ∈ add|confirm|update|supersede|conflict|outdated|uncertain
      certainty ∈ stated|inferred|uncertain
      evidence: [seq] 或 [{batch, seq}]
```

## 3. 前端变化

- `src/web/js/pages/memory.js`：四步工作台、总览、批次下载、提示词复制、导入预览（错误/警告/差异）、最近任务、最近观众、保留与清理。
- `src/web/js/pages/viewer-memory.js`：观众记忆面板（事实卡、证据展开、人工操作、删除、版本差异与恢复、概览摘要卡）。
- `src/web/js/pages/viewers.js`：标签页（概览/长期记忆/互动历史/历史版本），按 scope 记录/切换，`broadcasterId` 只用于记忆请求。
- 三语键由测试保证完全一致；事实文本、昵称、聊天原文全部 `textContent`。

## 4. 关键规则（下一轮不要破坏）

1. 记忆只按 `broadcaster × viewer`；不得混入其他主播或 lifetime。
2. `stated` 必须有引用消息；AI 不能把推断升级为事实。
3. 应用 = 事务 + 新版本 + 快照；不得原地覆盖。
4. 相同结果重复导入不写；删除后的旧包拒绝（`MEMORY_DELETED`）。
5. 证据丢失只降级、不删记忆、不伪造。
6. 本地合并不复活已删除记忆。
7. 记忆任务的 `seq → event_id` 映射不可绕过；导入只接受真实 `seq`。
8. 三语键三份一致；UI 禁止 `innerHTML`。

## 5. 测试 / 构建 / 验证

- 全量：`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`
  → **450 passed / 0 failed**，约 70–75 秒。
- 新增测试文件 8 个（见 `docs/STATUS.md` §3）；既有 schema/版本断言已同步更新。
- `scripts/demo-memory.mjs`：生成可浏览的模拟数据（两场直播、已导入分析、记忆合并、AI 记忆更新含状态变化与矛盾），并启动服务。
- `scripts/verify-memory-ui.mjs`：浏览器端验证脚本（步骤、预览、分组、证据、版本、暗色、390px）。**本轮未能运行**：本机策略终止无头浏览器。
- 构建：`node scripts/build-windows.mjs` 成功（91.0 MB、134 资源、requireAdministrator）；
  **运行验收未完成**：本机拒绝执行新构建的 EXE（EPERM）。
- **未运行**：`verify-exe*.mjs`、真实 AI 服务往返。

## 6. 未验证 / 边界

- 真实浏览器渲染、截图与 390px 实测（策略阻止）。
- 打包 EXE 与 schema 9→10 的真实升级（代码层迁移测试已通过）。
- 真实 AI 返回的记忆更新 JSON（仅合成样本）。
- 10 万级观众性能与长期事实增长。
- 真实平台下多主播同一观众的记忆隔离（自动化已覆盖，未做真实观测）。

## 7. 常用命令

```bat
:: 全量测试
node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"

:: 只看记忆相关
node --test --test-isolation=none "tests/unit/memory-*.test.mjs" "tests/integration/memory-*.test.mjs"

:: 演示数据 + 控制台
node scripts/demo-memory.mjs --port 49420 --seconds 0

:: 浏览器验证（需先启动无头浏览器并提供 --debug-port）
node scripts/verify-memory-ui.mjs --base http://127.0.0.1:49420 --debug-port 9231 --no-launch --shots

:: 打包
node scripts/build-windows.mjs
```

## 8. 本轮 Commit

- 本轮功能与文档提交：见 `git log -1`（本地 commit，未 Push）。
- 上一轮：`62de305 fix: detect bilibili stream end and separate platform status`。
