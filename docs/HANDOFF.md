# 交接文档（HANDOFF）

本轮：2026-11-10 · P8 长期记忆一体化 + 观众档案主播范围补丁 · v0.11.1（schema v12）

## 1. 本轮结果

| 目标 | 结论 |
| --- | --- |
| 审计“为什么只更新 4 位观众” | 已完成。旧提示词要求“证据不足的观众请省略”，旧 M7 本地合并只消费 `viewer_profiles`，而独立记忆任务又要求第二次 AI 往返；三者叠加导致只更新少数高活跃观众。 |
| 一次分析/一次导入 | 已完成。结果 Schema 1.2.0 新增 `viewer_memory_updates`；导入在同一事务保存报告与记忆。 |
| 所有可识别观众 | 已完成。无最低发言/活跃度/Top N；300 位低活跃观众测试全部覆盖。 |
| 低频观众跨场积累 | 已完成。五场每场一句话：客观场次/发言/时间 + 3 条逐步积累的语义事实。 |
| 已有画像进入上下文 | 已完成。`memory_context.json` 提供每位观众现有 summary/facts/version；`viewer_context.json` 也带 `memory`。 |
| 分批不拆散观众 | 已完成。观众只分配一个记忆批次，全部可用摘录（最近 120 条）随行；批次按消息+观众共同决定。 |
| 覆盖状态与预览 | 已完成。`ai_job_memory_viewers` / `ai_job_memory_messages`；预览显示覆盖/新语义/无新语义/仅客观/缺失。 |
| 移除独立记忆工作流 | 已完成。删除 `#/memory` 页面/导航/文件；旧链接进入 AI 分析中心；观众详情保留长期记忆与客观历史。 |
| 测试 | **490 自动化全部通过**（本轮新增 1 个综合流程测试文件，并更新既有 schema/版本断言）。 |
| 真实浏览器 UI | **未完成**。本机策略仍阻止无头浏览器；只有静态 UI 检查。 |
| 真实 AI 统一结果 | **未完成**。只有合成结果；真实 AI 覆盖率与错误表现待验证。 |
| 打包 EXE | **已构建、未能执行**（91.1 MB / 145 资源 / requireAdministrator / SHA-256 `8cbd7209…`）。 |

## 2. 后端变化

### 2.1 新模块

| 文件 | 职责 |
| --- | --- |
| `src/memory/embedded.mjs` | 校验/预览/应用嵌入在分析结果中的长期记忆更新；观众覆盖、证据归属、版本与事务 |
| `src/memory/objective.mjs` | 客观互动历史的记忆头确保与读模型；不产生语义版本 |
| `src/storage/repositories/monitor-targets.mjs` | 上一轮监听目标仓储（未变） |

### 2.2 修改

- `src/ai/constants.mjs`：Schema 1.2.0、prompt m6.2、观众/摘录上限。
- `src/ai/export/job.mjs`：观众分配、`memory_context.json`、`viewer_excerpts.jsonl`、
  `ai_job_memory_viewers/messages`、批次由消息与观众共同决定、固定消息切片保持兼容。
- `src/ai/export/context.mjs`：`viewer_context` 增加 `memory`；`buildMemoryPayload`。
- `src/ai/schemas/analysis-result-v1.schema.json`：`viewer_memory_updates` 与 1.2.0。
- `src/ai/prompts/instructions.mjs`：三语任务说明，要求覆盖每位观众、无最低门槛、客观统计不由 AI 输出、
  证据/状态变化/冲突规则；汇总阶段不再更新记忆。
- `src/ai/import/validate.mjs`：合并嵌入记忆校验、sanitize、目标/预览。
- `src/ai/import/importer.mjs`：事务内应用记忆、客观历史、覆盖状态。
- `src/ai/tasks/status.mjs`：任务状态包含 `memoryCoverage` / `memoryReady`，未覆盖不得 complete。
- `src/server/routes.mjs`：导入预览返回 `memory`；错误映射；`/api/status` 继续暴露 schema。
- `src/analytics/sessions/summary.mjs`：`monitorTargetId`（上一轮）。
- `src/memory/view.mjs`：观众记忆视图附带 `objective`。
- 版本：统一记忆重构 → `0.11.0`；观众范围补丁 → `0.11.1`（`package.json`、`src/shared/app-info.mjs` 一致）。

### 2.3 数据库（schema 12）

```text
ai_jobs.memory_viewers_total INTEGER NOT NULL DEFAULT 0
ai_job_memory_viewers(job_id, viewer_id, batch_index, base_memory_id, base_version,
                      message_count, status, result_id, processed_at)
ai_job_memory_messages(job_id, batch_index, seq, viewer_id, event_id)
```

状态：`pending` / `semantic` / `no_semantics` / `objective_only` / `missing_update` / `deleted`。
旧 M7 `memory_jobs` 等表保留历史，不再由 UI 创建新任务。

### 2.4 关键 API

```text
POST /api/ai/jobs                     创建统一分析任务（含全部观众）
GET  /api/ai/jobs/:id                 状态含 memoryCoverage / memoryReady
POST /api/ai/import/preview           返回 memory.coverage / totals / plan
POST /api/ai/import                   同一事务保存报告 + 记忆 + 覆盖
GET  /api/memory/viewers/:id          观众长期记忆 + objective 客观历史
```

旧 `/api/memory/jobs`、`/api/memory/merge`、`/api/memory/import` 仍保留用于已有数据/测试，
不再有 UI 入口；下一轮可评估是否移除。

## 3. 前端变化

- 删除 `src/web/js/pages/memory.js`；`src/web/index.html` 移除「长期记忆」导航。
- `src/web/js/app.js`：`#/memory` 路由指向 AI 分析中心（旧书签兼容），不再导入 `memoryPage`。
- `src/web/js/pages/ai.js`：
  - 导入预览新增长期记忆覆盖卡（已覆盖/新语义/无新语义/仅客观/缺失/操作数）；
  - 任务行显示 `长期记忆覆盖 X/Y`；
  - 导入成功 callout 显示记忆覆盖人数。
- `src/web/js/pages/viewer-memory.js`：
  - 新增「客观互动历史」卡：首次/最近、场次、发言、付费、最近场次（可跳转历史）；
  - 无版本 0 语义事实时显示「已记录互动，暂无语义记忆」；
  - 来源新增 `session_analysis_result`。
- 三语新增 `ai.import.memory*`、`ai.jobs.memoryCoverage`、`memory.objective.*`、
  `memory.noSemantic*`、`memory.sourceAnalysisResult`、错误原因。
- CSS：客观历史列表；继续保持无 `innerHTML`、只用 tokens。

## 4. 关键规则（下一轮不要破坏）

1. 一次分析结果同时承担本场报告与长期记忆；不要再引入独立记忆 AI 任务。
2. 每位可识别观众必须有且仅有一条 `viewer_memory_updates`；缺失即导入错误。
3. 观众只分配一个记忆批次，全部可用摘录随行；不得 Top N/最低活跃度裁剪。
4. 客观历史只由真实记录更新；AI 不能写金额/计数/时间/身份。
5. `stated` 必须有本观众的消息证据；无证据的 `inferred` 降级为 `uncertain`。
6. 无新语义 ≠ 未处理；`pending` 才是未处理。
7. 删除记忆后的旧包不能恢复；重复导入幂等；分析+记忆同一事务。
8. 三语键一致；前端禁止 `innerHTML`。

## 5. 测试 / 构建 / 验证

- 全量：`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`
  → **495 passed / 0 failed**，约 80 秒。
- 新增 `tests/integration/unified-analysis-memory.test.mjs`（A–E + 缺失覆盖）。
- 迁移测试更新到 schema 12；旧断言 1.1.0/m6.1 已更新为 1.2.0/m6.2。
- 构建：`node scripts/build-windows.mjs` 成功（91.1 MB、145 资源、requireAdministrator、SHA-256 `8cbd7209…`）；运行验收未完成。
- **未运行**：真实浏览器、真实 AI 统一结果、真实大场性能、打包 EXE。

## 6. 未验证 / 边界

- 真实 AI 是否稳定返回每位观众的条目、是否正确引用 `viewer_excerpts` seq；
- 数千观众包大小/导入耗时/内存；
- 真实浏览器 UI、暗色、390px；
- 打包 EXE 启动与 schema 11→12 真实升级；
- 旧 M7 任务数据在真实用户库中的只读查看。

## 7. 常用命令

```bat
:: 全量测试
node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"

:: 只看统一记忆
node --test --test-isolation=none "tests/integration/unified-analysis-memory.test.mjs"

:: 启动
node src/launcher/launcher.mjs --no-open

:: 打包
node scripts/build-windows.mjs
```

## 8. 本轮 Commit

- 统一记忆重构：`808335d feat: unify long-term memory with AI analysis import`（本地 commit，未 Push）。
- 观众范围补丁：见 `git log -1`（`fix: scope viewer broadcaster picker to real interactions`）。
- 上一轮：`0ca7b8a feat: add persistent automatic live monitoring`。

## 9. 补丁 0.11.1：观众档案主播范围

| 项目 | 内容 |
| --- | --- |
| 现象 | 观众详情页「主播范围」显示软件记录的全部主播，而不是该观众实际出现过的主播 |
| 根因 | 详情页把 `/api/broadcasters` 的全局列表传给选择器；`buildViewerProfile` 对无关系主播还会回退到全局 broadcaster |
| 数据来源 | `profile.broadcasters` ← `viewer_broadcasters`，由真实聊天/礼物/SC/大航海等互动更新 |
| UI | 新增 `src/web/js/pages/viewer-scope.js` 纯逻辑；详情只列关联主播、无「全部」；单主播隐藏下拉；无关联显示空状态；无效 scope 安全回退 |
| 后端 | `buildViewerProfile` 无关系返回 `scope.kind='none'`，不再用 `getBroadcaster` 填充 |
| 测试 | `tests/unit/viewer-scope.test.mjs`、`tests/integration/viewer-broadcaster-scope.test.mjs`；全量 495 passed |
| 未验证 | 真实浏览器渲染/截图；EXE 运行验收 |
