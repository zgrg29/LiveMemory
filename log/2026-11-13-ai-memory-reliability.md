# 2026-11-13 · v0.13.2 AI 分析可靠性、长期画像语言与错误恢复

## 范围

按上一轮只读审计的 P0/P1/P2 项进行实际修复。未修改生产数据库、未 Resume 真实任务、未调用真实付费 API、未停止采集、未替换正式 EXE。所有测试使用 `tests/.tmp` 与 Mock Provider。

## 修复

### 1. 长期画像统一校验链

`src/ai/api/runner.mjs#generateMemoryAnswer()` 原来在 `assembleMemoryCompact().ok` 后直接返回，跳过 `validateAnalysisImport()`。现在：

```text
request → extractJsonObject → assembleMemoryCompact
       → validateAnalysisImport（Schema/身份/证据/覆盖/枚举）
       → 失败：最多一次 repair（缺失 ref 定向；其他精确错误）
       → 重新组装 + 完整校验 → 导入
```

- ref 覆盖完整不再代表合法。
- repair 后仍失败：抛 `AI_IMPORT_INVALID`，带 `details.errors`、stage、job/batch；批次不导入，可 Resume。
- repair 次数有界（1 次）；定向补充只发缺失观众。

### 2. 身份与字段白名单

`src/ai/api/compact.mjs`：

- `MEMORY_UPDATE_FIELDS = summary / summary_certainty / no_new_information / operations`。
- 模型 `memory` 中的 `viewer_id`、`session_id`、`ref` 等被丢弃；`viewer_id` 在对象最后由本地 ref 映射注入。
- 记录 `ignoredFields` 字段名到日志，不记录值。
- 非法 `operations` 不被清洗，仍交给完整 Schema 拒绝。

### 3. 诊断与按批次失败

- `src/ai/api/runner.mjs#fail()` 读取 `AppError.details.errors`，输出 `error.errors[]`、`stage`、`jobId`、`batchId`、`batchIndex`、`recoverable`、`suggestedAction`。
- `src/storage/repositories/ai-jobs.mjs`：`recordJobFailure()` 写 `last_error_json.batches[]`；`clearJobFailure({batchIndex})` 只清除对应批次；旧扁平 JSON 兼容。
- `src/ai/import/importer.mjs`：失败记录带 batchIndex/batchId/stage；成功只清自己的批次。
- `src/ai/tasks/status.mjs`：返回 `batchErrors` / `failedBatches` / `usage`；serializer 与 HTTP 状态同步。
- `src/web/js/pages/ai.js`：技术详情显示代码、阶段、任务/批次、字段错误、可恢复性与建议；三语键补齐（含 `ai.center.reason.AI_IMPORT_INVALID`）。

### 4. 语言与 Prompt

`src/ai/prompts/split.mjs`：

- Memory Compact 示例按 locale 生成（不再固定英文 / `"locale":"en"`），无 `viewer_id` 与协议字段。
- memoryTasks/memoryRules 增加语言、topic 稳定键、stated/inferred/uncertain、本人证据、不得编造、no_semantics 合法等规则。

`src/ai/api/prompts.mjs`：

- Memory Provider 提示词由当前 `buildMemoryInstructions()` 生成；旧包 `instructions.md` 不再发送（数据文件仍从包读取）。
- Compact 契约明确：只返回 `viewers`，不返回 `viewer_memory_updates`/协议字段/`viewer_id`；evidence 只能来自同一 ref。
- 本地化语言规则。

`src/ai/constants.mjs`：`PROMPT_VERSION_V13` → `lm-prompt-v13.1`。

### 5. 统计与 UI

- `src/analytics/ai/report.mjs`：`longTermProfiles.stats`（total/processed/semantic/objectiveOnly/pending/failed/failedBatches/complete）。
- `src/web/js/pages/ai-report.js`：用 def-list 展示分类统计；旧任务无 stats 时回退旧文案。
- `src/web/js/pages/ai.js`：complete 显示已处理/语义/仅客观；partial 显示单场完成 + 画像进度；错误显示真实原因。

### 6. usage 归属

- `requestOnce()` 按请求 kind 选择 session/memory job；`usageByJob` 分开累计，任务总计求和。
- 修复/重试都是真实请求，计入对应 job。
- 任一子 job 费用未知 → 任务总费用未知（null），不显示为零。
- 删除批处理完成后用 job usage 覆盖任务总计的旧逻辑。

## 测试

命令：

```bat
node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"
```

结果：**628 passed / 0 failed**（约 120 秒）。

新增：

- `tests/unit/ai-compact-memory.test.mjs`（7）
- `tests/integration/ai-memory-reliability.test.mjs`（10）

覆盖：合法导入、完整 ref 但证据缺失、修复成功、修复仍失败可恢复、伪造 viewer_id、跨观众证据、4 批并发仅 b02 失败且不被成功批次清除、重启只补 b02、重复提交幂等、日语事实、combined partial、usage 归属、礼物-only 客观处理。`ai-ui` 增加诊断/统计三语键与无 HTML 断言的检查。

## 未完成 / 限制

- 真实付费 API 未验证（无 Key）；不得把 Mock 当作真实 Provider 验收。
- 真实浏览器截图未完成：本机 DSH 沙箱下 headless Edge 报 `OpenProcess 0x5` / `platform_channel 0x5`（命名管道被禁止），无法启动 CDP。
- 生产 `ses_01M77TJXG9VP4VAGNSXY` 未 Resume；步骤见 `docs/HANDOFF.md`。
- 历史英文事实不自动翻译；旧任务重复 usage 不猜测修正。
- 失败模型回答暂存只给方案（加密/生命周期/大小/清理/隐私），未实现。

## 验证边界

- 源码测试、隔离数据目录、Mock Provider 均已完成。
- 未构建测试 EXE；正式 EXE 未替换。
- 生产数据库、直播采集与已保存报告未被本轮测试触碰。
