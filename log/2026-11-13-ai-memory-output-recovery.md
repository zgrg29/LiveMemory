# 长期画像输出截断、Provider 空响应与观众级断点恢复（2026-11-13）

本轮目标：修复 `memory_analyzing` 阶段真实失败任务 `aij_01M7AJ05B5E2VRG9Z82G`，保留已保存的 17 个画像批次与 153 位观众，让剩余 822 位可稳定完成，并为未来输出截断提供有界恢复。**未修改生产数据库、未 Resume 生产任务、未调用真实付费 API、未干扰直播采集。** 全部验证使用生产数据只读副本 + 本地 Mock Provider。

## 1. 真实故障

任务 `aij_01M7AJ05B5E2VRG9Z82G`（`ses_01M77TP9QYPFRE4H9NCH`，DeepSeek Flash，zh-CN，memory-only）：

- 100 个画像批次，975 位观众，8,778 条消息。
- DB 中 17 条成功结果：批次 **1–11、13–18**；批次 12 的 10 位观众全部 `pending`；其余 822 位 `pending`。
- 失败批次 12 有 10 位观众、173 条消息（17–19 条/人）。
- `ai_jobs.last_error_json`：批次 12，`PROVIDER_RESPONSE_INVALID`，stage `memory_analyzing`。
- runtime `ai-v13.json`：`error.detail="empty-content"`、`finishReason=null`、`httpStatus=200`、`receivedOutput=false`、`attemptStats={total:19,succeeded:17,failed:2,retried:0}`、`usage.requests=66`（任务级）。
- 日志 `ai.request.attempt`：
  - 13:37:37 批次 4 失败：`PROVIDER_RESPONSE_INVALID`、`empty-content`、HTTP 200、耗时 32,545 ms、`receivedOutput=false`、`reasoningChars=0`、`retry=false`。
  - 用户点击继续后，13:38:20 批次 4 成功，`finishReason=stop`。
  - 13:38:52 批次 12 失败：同样 `empty-content`、HTTP 200、耗时 34,507 ms、`receivedOutput=false`、`reasoningChars=0`、`retry=false`。
  - 13:38:58 批次 18 成功；随后任务以批次 12 失败结束。
- 失败发生在两个不同批次（4 和 12），其中批次 4 消息更多（514 条、9 位观众）。说明这不是“批次 12 特别大”导致的确定性输入超限。

## 2. 根因

### 2.1 已确认

1. **空回答被当成永久格式错误。** 适配器在 streaming / non-streaming 两条路径都在 `!text` 时直接抛 `PROVIDER_RESPONSE_INVALID("empty-content")`，并在抛错前丢弃了 `finishReason`、`reasoningChars` 和 `usage`。因此：
   - 如果 Provider 返回的是 `finish_reason=length` 的 reasoning-only 回答，程序也无法识别为截断；
   - `shouldRetryAttempt` 把 `invalid_response` 视为不可重试，`retried=0`；
   - 批次 12 的两条失败尝试因此没有自动重试，`runPool` 对非校验错误停止调度新批次。
2. **UI 的“模型结束原因 length”不是批次 12 的真实结束原因。** runtime 中任务级 `lastOutputRejection` 是 13:35:54 的单场最终汇总：`AUTO_OUTPUT_TRUNCATED`、`kind=session-aggregate`、`finishReason=length`。它被 `getStatus()` 无条件当作当前任务的 `outputStats.lastFinishReason` 显示。批次 12 的失败错误本身 `finishReason=null`。因此用户看到的 `length` 是跨阶段陈旧值；但 33–35 秒无文本的流与“推理占用输出预算后返回空 content + length”的已知模型行为一致，**不能在没有原始 finish_reason 的情况下断言批次 12 一定是 length**（未持久化原始响应，属于推测）。
3. **批次规模算法只考虑输入。** `planMemoryViewerBatches()` 只使用摘录 token、现有记忆 token、观众数、摘录数与输入预算；`generateMemoryAnswer()` 对所有批次固定 6,000 输出 tokens。Schema 允许每位观众 40 个操作、每条操作 50 条证据，提示词也没有事实/证据上限。虽然本任务已保存批次的真实输出只有 1.1–3.2 KB（0–10 个操作），6,000 对它们足够，但这是结构性缺口：当一批观众需要更多事实时，没有任何输出侧预算或预估。
4. **17 个批次成功保存是正常并发乱序。** 初始并发 3；批次 4 失败后用户继续，调度继续；批次 12 失败时批次 13–18 已在途并完成。成功批次编号不连续，程序按结果/观众状态保存，没有按序号回滚。
5. **恢复本身已是观众级，但进度口径和拆分映射不足。** `runMemory()` 用 `ai_job_memory_viewers.status` 过滤 `pending/failed`，用 `buildMemoryPrompt({viewerIds})` 只请求未完成观众；成功观众不会重跑。但：
   - `batchesImported` 以“存在任意结果”计，部分子批次成功会把原批次算作已导入；
   - 没有持久化的“原批次 → 子批次”映射；
   - 没有输出截断后的拆分/预算调整路径；
   - `error.elapsedMs=null` 被 `Number(null)===0` 显示为 0 ms。
6. **单场汇总的 `length` 统计会泄漏到画像阶段。** `lastOutputRejection` 没有 job 归属，`outputStats.lastFinishReason` 跨任务复用。

### 2.2 推测 / 未确认

- 批次 12 是否真的返回了 `finish_reason=length`：未保存原始响应元数据。日志中的失败尝试 `finishReason=null` 是适配器丢弃后的结果，不能反推。外部资料说明 reasoning 模型会把 `max_tokens` 消耗在 reasoning 上并以 `content:""` + `finish_reason:"length"` 结束（例如 [goose #11142](https://github.com/aaif-goose/goose/issues/11142)、[pi #9266](https://github.com/earendil-works/pi/issues/9266)）；这与 33–35 秒的空流一致，但本轮不把它当作已确认事实。
- 批次 12 的 6,000 输出预算是否被 reasoning 完全耗尽：没有 `reasoningChars`/usage（失败路径被清零/丢弃），无法确认。

## 3. 修复

### 3.1 输出预算与动态分批

- `src/ai/batching/tokens.mjs`
  - 新增 `estimateMemoryViewerOutputTokens()`：按摘录条数、已有事实数估算；每 30 条摘录约 1 条事实，最多 12 条，单观众估算上限约 1,700 tokens。
  - 新增 `resolveMemoryOutputTokens()`：基础 6,000，按预期输出增长，最高 **8,192**，并受已知 context 收缩；不无上限提高。
  - `planMemoryViewerBatches()` 同时累加 `estimatedOutputTokens`，超过 `outputBudget * 0.8` 时换批；单观众超份额时独占一批并标记 `outputOversized`；不拆分/丢弃观众。
  - 新增常量 `MEMORY_MAX_FACTS_PER_VIEWER=12`、`MAX_MEMORY_SPLIT_DEPTH=2`。
- `src/ai/export/split-jobs.mjs`
  - 观众成本同时记录 `outputTokens`、`existingFacts`、`excerptCount`。
  - 每个包 `manifest.batch_plan` 新增 `output_budget_tokens`、`estimated_output_tokens`、`max_facts_per_viewer`、`outputOversized`；旧包没有这些字段时运行时从 refs 重新估算。
- `src/ai/prompts/split.mjs`
  - 三语提示词新增：每位观众本次最多 12 条最有长期价值的事实；每条事实通常 1–3 条同一观众证据；合并/省略低价值内容，不为凑数拆分或重复。
  - 这是**规划与提示词**上限，不是静默丢弃已通过校验的事实。

### 3.2 `finish_reason` 与错误分类

- `src/ai/providers/adapters.mjs`
  - `ProviderHttpError` 保留 `finishReason`、`reasoningChars`、`usage`、`metrics`、`elapsedMs`。
  - 空内容且 `finishReason=length` → `AUTO_OUTPUT_TRUNCATED`，detail `finish-reason-length-empty-content`。
  - 空内容且无 `length` → `PROVIDER_RESPONSE_EMPTY`，`retryable=true`。
  - 有部分文本但 `length` 仍由 `#assertUsableOutput` 识别为截断。
- `src/ai/runtime/attempt.mjs`
  - `PROVIDER_RESPONSE_EMPTY` 允许 1 次自动重试；`AUTO_OUTPUT_TRUNCATED` 仍不可在传输层重试。
- `src/ai/api/runner.mjs`
  - 失败尝试的 usage / reasoning / finishReason 计入统计；失败响应若带 usage 也计入 job usage。
  - `lastOutputRejection` 绑定产生它的子 Job；`outputStats.lastFinishReason` 只显示当前 Job 的值。
  - `error.elapsedMs=null` 不再显示为 0。
  - 新增 `recoveryStats`：`autoRetries / truncations / emptyResponses / splits / subBatches / budgetBumps`。

### 3.3 有界恢复阶梯

`#generateMemoryGroup()`：

1. 空响应：传输层自动重试 1 次。
2. 仍空：多观众组对半拆分；最多 2 层（10 → 5 → 2/3）。
3. `length`：直接拆分，不重发相同大请求。
4. 单观众仍截断：仅一次把预算提高到上限 8,192；仍失败保留 pending 与精确错误。
5. 每个拆分在请求前先写数据库映射；每个成功子结果立即导入，崩溃不丢已付费的有效回答。
6. 连续 3 个输出失败批次后停止调度新批次，避免 Provider 故障时无限请求。

### 3.4 观众级恢复与 schema 16

- 迁移 16：`ai_job_memory_viewers` 新增 `split_path`、`split_reason` 与索引；只 `ALTER ADD COLUMN`，不改历史行。
- `split_path` 形如 `12.1`、`12.1.2`；`batch_index` 保持原计划批次，结果 scope/证据 seq/事实 id/topic 不变。
- `setJobMemoryViewerSplits()` 在一个 `BEGIN IMMEDIATE` 中写完整映射。
- 恢复按 `(batch_index, split_path)` 分组，只取 `pending/failed` 观众；已有映射优先复用，不重新划分已保存观众。
- 计划批次进度按“该批次全部观众覆盖”计算；`splitBatches / pendingSplitBatches / splits[]` 可从状态读取。
- 成功子结果立即事务导入；同一观众事实去重/版本机制不变。

### 3.5 UI

- AI 中心新增：输出截断数、空响应数、自动恢复请求、自动拆分批次、已拆分子批次、运行中的拆分路径。
- 技术详情区分“输出被 length 截断”和“Provider 空内容”，并显示 `splitPath`。
- 恢复面板文案区分两种原因，说明继续只处理未完成观众；仍失败时保留「继续未完成画像」。
- 三语键同步；所有文本仍走 `textContent` / `t()`，无 `innerHTML`。

## 4. 测试与验证

### 4.1 自动化测试

- 新增 `tests/unit/ai-adapter-output.test.mjs` 3 项：空流 + length、空流 + stop、非流式空 + length；验证代码、finishReason、usage、retryable。
- `tests/unit/ai-token-batching.test.mjs` 新增 4 项：输出估算、预算上下限、按输出拆分、单观众隔离。
- 新增 `tests/integration/ai-memory-output-recovery.test.mjs` 8 项：
  1. 正常 JSON（既有测试覆盖）。
  2. `length` + 不完整 JSON → 自动拆分成功。
  3. `length` + 空内容（单观众）→ 一次预算提升到 8,192。
  4. `stop` + 空内容 → 自动重试 1 次。
  5. `stop` + JSON 格式错误 → 既有 repair。
  6. 批次 2 失败、批次 1/3 已保存 → 只恢复批次 2；结果 ID 不变；重复继续 0 请求。
  7. 异常多消息观众 → 独立批次。
  8. 混合空响应/截断的多批任务 → 全部覆盖。
  9. 975 观众 / 98 批 → 975/975。
- 迁移断言更新到 schema 16；新增 `split_path`/`split_reason` 列断言。
- 全量结果见 `docs/STATUS.md` §0.21。

### 4.2 真实任务只读副本回放

使用生产 DB/runtime/config/secrets/exports 的副本（`tests/.tmp/real-r7-run`），Mock Provider，不访问网络：

- 开始状态：`partial`、`recovery=resume-memory`、批次 17/100、观众 153/975、pending 822。
- 第一次恢复：批次 12 原 10 观众请求被 Mock 返回空内容 + `finish_reason=length`；程序拆分为 `12.1` / `12.2`，两个子批次成功。
- 只请求批次 **12、19–100**（83 个待处理批次）；批次 1–11、13–18 一个都没有重发。
- 结果：`complete`，100/100 计划批次，975/975 观众，pending 0，failed 0，facts 252，splits 1（2 个子批次），累计请求 85（83 个待处理批次 + 批次 12 的 2 个额外拆分请求）。
- 恢复前 17 条 `ai_results` 的 id/version 全部保留；结果数 17 → 101（84 个新结果：82 个普通批次 + 批次 12 的 2 个子批次）。
- 第二次、第三次点击继续：0 次 Provider 请求，结果/事实/观众行完全不变（idempotent），服务关闭重开后再继续仍为 complete。

### 4.3 未验证

- 真实付费 DeepSeek Flash 在新预算/拆分策略下的行为（本机未调用真实 API）。
- 真实 UAC 双击与真实浏览器点击（沙箱限制，沿用既有说明）。
- 原始失败响应未持久化，无法 100% 证明批次 12 当时的 `finish_reason`。

## 5. 下一步

1. 用户按 HANDOFF §0.4 使用新 EXE 继续该任务；先备份数据目录。
2. 不要重新分析已保存的 17 个批次/153 位观众。
3. 若仍出现空响应，最多自动重试 1 次；若出现截断，系统会先拆批次/提高单观众预算，不会重发相同大请求。
4. 若最终仍失败，保留「继续未完成画像」；技术详情会给出 `AUTO_OUTPUT_TRUNCATED` 或 `PROVIDER_RESPONSE_EMPTY`、批次、子批次路径与结束原因。
