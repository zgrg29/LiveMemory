# 2026-11-09 · M6 AI 分析结果导入、分批汇总与直播分析报告

## 目标

把 LiveMemory 从“能导出分析包”推进到“用户能把包交给任意 AI、把 JSON 结果安全导入，并看到可信、可追溯、易理解的分析报告”。

## 约束回顾

- 不调用任何 AI API、不绑定品牌、不需要登录。
- 复用 `livememory-analysis-v1` 与 `livememory-analysis-result-v1`；兼容性扩展必须解释并保留旧包可读。
- AI 结果是不可信输入；不能改事件/金额/统计/设置，不能执行 HTML/脚本。
- 身份只按稳定平台 ID；昵称不用于解析；不跨主播合并。
- 音频/视频从未记录；切片建议只能是聊天证据候选。
- 每轮实际测试、构建 EXE、更新文档、本地提交；不 Push。

## 实施摘要

### 1. 数据模型（schema 8）

新增 `ai_jobs`、`ai_job_batches`、`ai_job_messages`、`ai_job_viewers`、`ai_results`、`ai_result_evidence`；
`ai_packages` 增加 job/批次/阶段/提示词版本。旧包保持 `job_id=NULL`、`stage='single'`。
`seq → event_id` 映射是导入证据校验与报告定位的唯一权威。

### 2. 导出与分批

`createAnalysisJob` 按 `(occurred_at, id)` 在消息边界拆批，每批写独立 ZIP；manifest 增加
`job_id/stage/batch/coverage/prompt_version/schema_version`；`messages.jsonl` 增加 `event_id` 与 `message_id`。
批次 id 稳定；重新分析创建新任务与新批次 id，不复用。

### 3. 提示词

三语提示词增加批次规则、汇总规则、来源字段与版本；版本 `lm-prompt-m6.1-<locale>`。
三语语义结构一致，字段名/枚举不变。任务与包记录实际版本。

### 4. 导入校验

自研无依赖 JSON Schema 子集 + 业务校验：
协议/Schema 版本、场次、任务、批次、主播快照、时间窗口、消息引用、观众稳定身份、汇总前置条件、
结构深度/节点/字符串/8 MB 上限、危险键名。预览只读；确认后单事务写结果 + 证据；失败回滚。
错误带字段路径、稳定错误码与修复建议组，UI 三语显示。

### 5. 重复与版本

规范化 JSON SHA-256：相同内容判重复不写；不同内容必须 `createVersion:true`，追加版本并保留旧版本；
报告使用最新版本。任务状态从数据库事实计算，重启保持。

### 6. 汇总

多批任务全部分批导入后可生成第二阶段汇总包（无原始消息，含 `batch_results.json`、全场统计、观众并集）。
最终结果导入后任务才 `complete`。未汇总/缺失批次时报告按批次分别展示，明确标记不完整，不拼接。

### 7. 报告

摘要、话题时间线、情绪、争论、候看片段、观众画像、来源与证据。证据解析到真实事件行；
原文被保留策略清理或行删除时显示“不可用”。明确说明没有视频/音频、不能生成切片。
历史详情页新增 AI 摘要卡与完整报告入口。

### 8. 删除/清空

删除场次在同一事务内删除 AI 任务/批次/映射/结果/证据/包记录并删除包文件；
`maintenance` 清空包含全部 AI 表；`assertNoResidue` 增加 `ai_jobs`/`ai_results`。

## 测试

- 全量：354 passed / 0 failed / 约 48.3 秒。
- 新增：`ai-import`、`ai-batching`、`ai-api`、`ai-migration`、`ai-prompts`、`ai-ui`、`ai-fixtures`。
- 浏览器 UI：17/17（完整/部分/等待、粘贴/文件、重复、新版本、非法 JSON、历史入口、黑暗/中文/390px）。
- 打包 EXE：`verify-exe-ai.mjs` 14/14（真实 v7→v8、3 批、导入、汇总、报告、重启保持）；
  `verify-exe.mjs` 10/10；`verify-exe-history.mjs` 19/19（v6→v8 回归）。
- 构建：90.6 MB / 117 资源 / SHA-256 `215bb6c0fcefb6bcd2b17b51f0391af886b2ab2ccc67409648348ba0a2f12f05`；
  `--version` 0.8.0；Manifest requireAdministrator。

## 真实 AI 状态

**未调用任何真实 AI 服务**。所有测试结果是用真实导出包元数据（task/batch/时间/观众 id）构造的
Schema 合法合成结果。验证的是契约、校验、事务、批次、版本与报告，不是任何 AI 的真实输出质量。
最终报告必须如实写明这一点。

## 已知限制 / 下一轮

- 真实 AI 文件往返样本（ChatGPT/Claude/Gemini）尚未验证。
- YouTube 30 天清理不会删除已导入 AI 结果里的观众画像/摘要；M7 必须补齐保留/去标识化/单版本删除。
- 无单结果版本删除；无后台自动重试/断点续传；不导入 ZIP；不做视频/切片。
- 单任务 50,000 条；未做 10 万条/20+ 批压力。
- 真实 UAC/文件夹选择/干净 Windows/M5 备份仍未完成。

## 文件

- 新增：`src/ai/constants.mjs`、`src/ai/export/{context,job}.mjs`、`src/ai/import/{schema-validator,validate,importer}.mjs`、
  `src/ai/tasks/status.mjs`、`src/analytics/ai/report.mjs`、`src/storage/repositories/{ai-jobs,ai-results}.mjs`、
  `src/web/js/pages/ai-report.js`、`scripts/{demo-ai,verify-ai-ui,verify-exe-ai}.mjs`、M6 测试与 fixtures。
- 修改：迁移 v8、`ai-packages` 仓储、`events` 仓储、`sessions`/`maintenance`/`session-admin`、路由/序列化、
  `ai.js`、`history.js`、`shared.js`、i18n、`pages.css`、提示词、结果 Schema、文档。

## Commit

见 `git log -1`。本地提交，未 Push。
