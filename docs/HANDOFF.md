# 交接文档（HANDOFF）

本轮：2026-11-09 · M6 AI 分析结果导入、分批汇总与直播分析报告 · v0.8.0（schema v8）

## 1. 本轮结果

| 目标 | 结论 |
| --- | --- |
| 分析任务与导出 | 已完成。`POST /api/ai/jobs` 创建带提示词版本的任务，按消息边界拆批导出；旧 `/api/ai/packages` 保留。 |
| 批次机制 | 已完成。稳定批次 id、seq 范围/时间覆盖/消息数/校验和；`ai_job_messages` 保存 seq→event 映射；不丢消息、不重复。 |
| 文件/粘贴导入 | 已完成。JSON 文件与文本框；8 MB 上限；预览 → 确认 → 单事务写入。 |
| 严格校验 | 已完成。自研 JSON Schema 子集 + 业务校验（场次/任务/批次/主播/观众/时间/消息引用/范围/汇总前置条件）。 |
| 错误体验 | 已完成。字段路径 + 原因 + 修复建议；三语；无部分写入。 |
| 重复与版本 | 已完成。相同结果判重复不写；不同结果需显式确认新版本并保留旧版本。 |
| 分批汇总 | 已完成。乱序/重复/缺失检测；全部批次后可生成第二阶段汇总包；最终结果导入后任务完成；不拼接部分结果。 |
| 分析报告 | 已完成。摘要、话题时间线、情绪、争论、片段建议、观众画像、来源与证据；原文不可用时明确标记。 |
| 安全 | 已完成。AI JSON 只按白名单存储、只作文本渲染、不执行、不能改事件/金额/设置；身份不按昵称猜测。 |
| 三语提示词 | 已完成。`lm-prompt-m6.1-zh-CN/ja/en`，记录在任务与包中，字段语义一致。 |
| 数据兼容 | schema 8 仅新增表/列/索引；旧分析包与 1.0.0 结果仍可导入；v7→v8、v6→v8 均由打包 EXE 实测。 |
| 删除/清空 | 已完成。删除场次级联任务/批次/结果/证据并删除包文件；清空数据包含全部 AI 表。 |
| 测试 | 354 自动化全部通过；浏览器 UI 17/17；打包 EXE AI 14/14；EXE 矩阵 10/10；EXE 历史回归 19/19。 |
| 真实 AI | **未调用**。只验证了符合 Schema 的合成结果；不要写成真实 AI 已验证。 |

## 2. 后端变化

### 2.1 新模块

- `src/ai/constants.mjs`：协议、结果 Schema 版本、提示词版本、批次边界、导入上限、任务 id 生成。
- `src/ai/export/context.mjs`：三语包共用的消息行、表情字典、观众上下文、会话上下文、包 notes。
- `src/ai/export/job.mjs`：
  - `createAnalysisJob({db, sessionId, locale, exportsDir, batchSize, now})`：拆批、写 ZIP、事务写
    job/batch/messages/viewers/packages；
  - `buildAggregatePackage({db, jobId, exportsDir, now})`：全部分批结果导入后生成第二阶段包；
  - 失败时删除本次写出的 ZIP，不留下半套任务。
- `src/ai/tasks/status.mjs`：`computeJobStatus()` / `recomputeSessionAiStatus()`；状态永远从数据库行计算。
- `src/ai/import/schema-validator.mjs`：无依赖 JSON Schema 2020-12 子集校验器（含结构/深度/节点上限）。
- `src/ai/import/validate.mjs`：`validateAnalysisImport({db,text,source,now})` 预览/语义校验；
  `parseImportText`、`canonicalJson`、`sanitizeResult`。
- `src/ai/import/importer.mjs`：`importAnalysisResult({..., createVersion})`；旧版结果自动创建 legacy job；
  单事务写结果与证据；失败回滚。
- `src/analytics/ai/report.mjs`：`buildSessionAnalysisReport(db, sessionId)`；完整/单批/部分三种模式；
  证据解析到真实 `events` 行；原文清理/删除时标记不可用。

### 2.2 仓储

- `src/storage/repositories/ai-jobs.mjs`：任务、批次、seq 映射、批次观众集合、失败记录、汇总包来源。
- `src/storage/repositories/ai-results.mjs`：结果版本、scope（`batch:N` / `final`）、校验和、证据。
- `ai-packages.mjs`：新增 `jobId` / `batchIndex` / `stage` / `promptVersion`，保留旧调用默认值。
- `events.mjs`：`listSessionMessagesAsc` 支持 `offset`；新增 `getEventById`、`countSessionMessages`。
- `sessions.mjs`：沿用 `setSessionAiStatus`；状态由 `recomputeSessionAiStatus` 写入。

### 2.3 路由

```text
POST   /api/ai/jobs                      创建任务并导出全部批次
GET    /api/ai/jobs?sessionId=           任务列表 + 计算状态 + 包
GET    /api/ai/jobs/:id                  任务 + 批次 + 包 + 结果版本
POST   /api/ai/jobs/:id/aggregate        生成第二阶段汇总包
GET    /api/ai/instructions?locale=&jobId=&batchIndex=&stage=
POST   /api/ai/import/preview            只读预检查
POST   /api/ai/import                    确认导入（createVersion 可显式开新版本）
GET    /api/ai/sessions/:id/report       报告读模型
GET    /api/ai/results/:id               单个结果（含原始 JSON）
GET    /api/ai/results/:id/download      下载结果 JSON 供审计
```

- `POST /api/ai/import/preview` 与 `/api/ai/import` 使用约 8 MB 请求上限；其他 API 仍为 1 MB。
- 超大请求会先读完/丢弃再返回 413，避免客户端只看到连接重置。
- `/api/ai/packages` 与 `/api/ai/packages/:id/download` 继续兼容；包序列化新增 job/批次/阶段/提示词版本。

### 2.4 数据模型

- schema **8** 新增表：`ai_jobs`、`ai_job_batches`、`ai_job_messages`、`ai_job_viewers`、`ai_results`、
  `ai_result_evidence`。
- `ai_packages` 新增列：`job_id`、`batch_index`、`stage`（默认 `single`）、`prompt_version`。
- 删除场次：显式删除 `ai_results`、`ai_jobs`（级联批次/映射/观众）与 `ai_packages`，再删其他子表；
  `assertNoResidue` 增加 `ai_jobs` / `ai_results`；提交后删除包文件。
- `maintenance.clearDatabase()` 明确删除全部 AI 表（先证据/结果/映射/批次/任务，再包与业务表），
  `CLEARED_TABLES` 同步用于预览、备份计数和清空后校验。

## 3. 前端变化

- `src/web/js/pages/ai.js` 重写：任务创建/批次包下载/提示词选择/文件与粘贴导入/预览错误/确认版本/
  任务状态/汇总包/重新分析。
- `src/web/js/pages/ai-report.js` 新增：报告渲染（摘要、话题、情绪、争论、片段、画像、来源、证据）。
- `history.js`：详情卡读取 `/api/ai/sessions/:id/report`，有报告时显示摘要与完整报告入口；
  部分结果显示不完整；仅导出显示等待导入。
- `shared.js`：`aiChip` 支持 partial / complete / invalid。
- i18n：三语新增 `ai.setup.*`、`ai.job.status.*`、`ai.jobs.*`、`ai.report.*`、`ai.import.*`
  （含 `reason.*` 与 `fix.*`）、`history.detail.aiViewReport`、`history.ai.partial/complete`、
  错误键与 toast。
- 样式：`pages.css` 新增导入预览、错误/警告、任务行、报告卡、证据、情绪、片段、画像、来源、
  响应式规则；沿用 tokens，不写死颜色。
- 安全：AI 文本一律通过 `el`/`textContent`；无 `innerHTML`/`eval`/`Function`；证据原文与不可用状态
  均为纯文本。

## 4. 关键规则（下一轮不要破坏）

1. **AI 结果不可信**：不得执行、不得直接合并进事件/金额/计数、不得按昵称解析观众身份。
2. **身份隔离**：结果只能引用该批次 `viewer_context` 中的 `viewer_id`；汇总阶段只能引用任务内批次并集。
3. **证据必须可解析**：`seq` 必须来自 `ai_job_messages`；`{batch, seq}` 必须属于该任务；报告显示真实
   事件行；原文已清理时明确不可用。
4. **不拼接部分结果**：多批任务未导入全部批次或未导入汇总结果时，状态不能标 complete。
5. **版本只追加**：相同校验和判重复；不同内容必须 `createVersion: true`；旧版本保留。
6. **任务状态从数据库计算**，不要新增前端临时状态作为唯一依据。
7. **删除/清空必须覆盖 AI 表**：改动 schema 时同步 `session-admin`、`maintenance`、`DATA_MODEL` 与测试。
8. **提示词版本**：任何提示词语义变化都要改 `PROMPT_VERSION`，并在任务/包中记录；三语一起改。

## 5. 测试 / 构建 / 验证

- 全量：**354 passed / 0 failed / 约 48.3 秒**。
- 新增：`ai-import`、`ai-batching`、`ai-api`、`ai-migration`、`ai-prompts`、`ai-ui` 测试与 `ai-fixtures`。
- 浏览器 UI：`node scripts/demo-ai.mjs --port 48370` + `node scripts/verify-ai-ui.mjs --port 9224 --base http://127.0.0.1:48370` → **17/17**。
- EXE：90.6 MB / 117 资源 / SHA-256 `215bb6c0fcefb6bcd2b17b51f0391af886b2ab2ccc67409648348ba0a2f12f05`；
  `verify-exe.mjs` **10/10**；`verify-exe-ai.mjs` **14/14**；`verify-exe-history.mjs` **19/19**；
  `--version` = 0.8.0。
- **未使用真实 AI**：所有测试结果由真实包元数据构造；真实 AI 输出差异是下一轮的首要验证项。

## 6. 未验证 / 边界

- 真实 AI 服务（ChatGPT/Claude/Gemini 等）的实际文件读取、输出长度与格式差异。
- 真实 UAC、管理员桌面完整流程（EXE 使用 asInvoker 临时副本验证功能）。
- 真实文件夹选择器人工点击。
- 本轮无新的真实 Bilibili/YouTube 采集。
- YouTube 30 天清理不会删除已导入 AI 结果中的观众画像/摘要；这是已知保留限制，不得声称完全合规。
- 无单结果版本删除 UI/API；无后台自动重试/断点续传；不导入用户提供的 ZIP；不处理视频/切片。
- 单任务上限 50,000 条；未做 10 万条与 20+ 批次压力测试。

## 7. 常用命令

```bat
:: 全量测试
node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"

:: AI UI 模拟 + 浏览器验证
node scripts/demo-ai.mjs --port 48370
node scripts/verify-ai-ui.mjs --port 9224 --base http://127.0.0.1:48370

:: 构建 / 校验 EXE
node scripts/build-windows.mjs
node scripts/verify-exe.mjs
node scripts/verify-exe-ai.mjs
node scripts/verify-exe-history.mjs
```

## 8. 本轮 Commit

- 本轮功能与文档提交：见 `git log -1`（本地 commit，未 Push）。
- 上一轮：`de292eb feat: manage and search live history sessions`。
