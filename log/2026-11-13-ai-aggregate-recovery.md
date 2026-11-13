# 2026-11-13 · 最终汇总截断与「继续最终汇总」恢复

## 1. 故障结论（只读证据）

真实任务：`ses_01M77TM1Q80HQ4XSZTMV` / `aij_01M79KZEFWBCCJP8G1JK`，Provider `dashscope`，模型 `qwen3.7-flash`，单场分析，18 个批次。

只读取生产数据目录中的状态、日志与数据库副本（未写入、未 Resume、未调用付费 API）：

- `runtime/ai-v13.json`：`status=failed`、`stage=failed`、`error.code=AUTO_OUTPUT_TRUNCATED`、`error.stage=session_aggregating`、`error.batchIndex=0`、`error.recoverable=true`；`sessionBatches=18/18`。
- `lastRequest`：`kind=session-aggregate`、`maxTokens=8000`、`maxCompletionTokens=24000`、`estimatedInputTokens=34048`、`outcome=succeeded`、`elapsedMs=199729`（3 分 20 秒）。
- `attemptStats`：`total=20`、`succeeded=20`、`failed=0`、`canceled=0`、`timedOut=0`、`retried=0`。
- `ai_jobs.usage_json`：`inputTokens=615812`、`outputTokens=136220`、`requests=20`、`cost=null`。
- `ai_jobs.last_error_json.batches[0].batchIndex=0`，`stage=session_aggregating`。
- 数据库有 18 条 `batch:*` 结果（版本均为 1），没有 `final` 结果。
- 日志：`ai.analysis.session.aggregate.request`（`batches=18`、`inputLimit=48000`）；约 3 分 20 秒后 `ai.analysis.failed`（`code=AUTO_OUTPUT_TRUNCATED`、`finish-reason-length`、`batchIndex=0`、`recoverable=true`）。

**已确认的根因不是输入超限。** 18 批汇总输入估算 34,048 tokens，低于 48,000 硬上限；请求成功发出并返回，但回答在 8,000 tokens 处被 Provider 以 `finish_reason=length` 截断。

## 2. 根因

### 2.1 汇总沿用了普通批次的输出预算

`#runSessionAggregate()` 使用 `AGGREGATE_OUTPUT_TOKENS = 8000`，而 Session 批次也使用 8,000。18 个批次的合并报告需要覆盖整场时间线、话题、情绪、争论与回看片段，8,000 远低于合并所需；模型回答刚好在 8,000 处被截断。

### 2.2 汇总输出契约没有上界

结果 Schema 允许 `topics` 最多 60 条（每条 summary 2,000 字符、key_points 12 条）、`sentiment` 120 条、`disputes` 50 条、`highlights` 30 条。旧汇总提示词只说“合并、不要拼接”，没有限制输出条数、文本长度或证据数量。18 个批次的结果给了模型足够素材把 8,000 tokens 用完。

### 2.3 `batchIndex: null` 被强制转换成 0

`fail()` 使用 `Number.isInteger(Number(error?.batchIndex))`；`Number(null) === 0`。汇总失败没有批次号，却被持久化为 `batchIndex: 0`。`recordJobFailure()` 与状态读模型也做同样的转换，导致：

- 旧任务/旧数据库出现不存在的“批次 0”；
- 技术详情显示 `batch 0`；
- 前端若用 falsy 条件判断批次/阶段，会把汇总失败误当成普通批次或丢失恢复入口。

### 2.4 没有专门的汇总恢复状态与入口

后端实际返回 `canResume=true`，但前端唯一可用的恢复控件是与「暂停」共用的一个小型 ghost 按钮，失败时文字只是泛化的「继续」；没有「最终汇总」语义，也没有说明继续只会重做汇总。任务状态仍是 `failed`，错误文案建议“增大输出上限或缩小批次”，但界面没有提供任何调整上限的操作。用户报告中看不到「继续」按钮；无论当时是按钮未被注意还是旧构建渲染差异，产品上确实缺少一个明确、可测试的汇总恢复入口。

### 2.5 统计只区分 HTTP 成功，不区分可用输出

`attemptStats.succeeded` 在 Provider 返回后立即 +1；`finish_reason=length` 在请求统计之后才被发现。因此出现“20 次成功 / 0 次失败”与“AI 分析失败”同时显示。缺少“成功响应但输出未通过完整性/结构校验”的计数。

## 3. 修复

### 3.1 独立、可验证的汇总输出预算

`src/ai/batching/tokens.mjs`：

```text
desired = clamp(ceil(condensedBatchResultTokens * 0.6) + 3000, 12000, 16000)
output  = resolveOutputTokens({desired, inputTokens, contextLength})
```

- 18 批、约 30k 合并输入 → 16,000 回答 tokens（上限；真实事故不再固定 8k）。
- 下限 12,000，上限 16,000；不会无限制增长。有界汇总 schema 的实际文本上限远低于 16k，避免 Provider 输出上限拒绝。
- 上下文已知时仍按 `context - input - 500` 收缩。
- DashScope 的 `max_completion_tokens` 仍为回答预算 + 16k（16k + 16k = 32k），有界。

### 3.2 有界汇总契约

- `buildSessionAggregateAnswerSchema()`：在不修改原始 Schema 的前提下，为汇总输出单独生成更严格的 schema：topics ≤ 24、sentiment ≤ 12、disputes ≤ 8、highlights ≤ 8、topic summary ≤ 320 字符、key_points ≤ 4、message_refs ≤ 4，并移除 `viewer_profiles`。
- `buildSessionAggregatePrompt()`：三语提示词明确输出上限、合并优先、覆盖全部批次（列出每个批次的 seq 范围）。
- `condenseBatchResult()`：支持第二遍 compact 压缩（每批 topics ≤ 16 等），**始终保留全部批次与全部证据引用**，不删除后面的批次。
- 输入装不下时先 compact 再判断；仍装不下返回 `ANALYSIS_AGGREGATE_TOO_LARGE`，并标记为需要更换模型/配置，而不是伪造一个可用的继续按钮。

### 3.3 恢复状态与幂等

- 新增 `src/ai/tasks/recovery.mjs`：根据数据库真实结果计算 `recovery.kind`（aggregate/session/memory/config）、`action`、`canResume`、已保存/未完成数量。
- 18/18 已保存且 final 缺失 → `kind=aggregate`、`action=resume-aggregate`。
- 有未保存批次 → 只建议补批次；画像未完成 → 只建议补画像。
- 输入/上下文不足 → `action=change-model`、`canResume=false`，不显示可用的「继续」。
- `resume()` 在任务已 `complete` 时直接返回，不创建任务、不请求 Provider；重复点击幂等。
- `batchIndex` 统一规范化：1-based；0/负数/null 均为 null；旧数据在读取时规范化，不改写历史数据库。

### 3.4 明确的「继续最终汇总」

`src/web/js/pages/ai.js`：

- 分析进度卡新增独立恢复面板（不是共用的暂停按钮）：
  - 「AI 分析未完成」
  - 单场批次：已保存 18/18
  - 最终汇总：失败/未完成
  - 原因：AI 输出在达到上限时被截断…
  - [继续最终汇总] [查看技术详情]
  - 继续后只处理尚未完成的最终汇总，不会重新分析已保存的 18 个批次。
- 按故障类型显示准确操作：继续未完成分析 / 继续最终汇总 / 继续未完成画像 / 前往设置更换模型。
- 面板数据来自后端 `status.recovery`，按钮调用真实 `POST /api/ai/analyze/resume`。
- 页面刷新、EXE 重启后从 `/api/ai/analyze/status` 恢复；不会用刷新代替恢复。
- 阶段标签不再把 `failed` 回退为“准备数据”；显示“AI 分析未完成”。

### 3.5 统计口径

- `attemptStats` 新增 `outputRejected`；`getStatus()` 返回 `outputStats`：
  - `responses`：HTTP/Provider 成功响应数；
  - `rejected`：成功响应但被截断/退化/JSON/Schema/覆盖校验拒绝的数量；
  - `lastFinishReason`：最后一次拒绝的结束原因。
- 界面把「成功请求」改为「API 请求成功」，并显示「输出未通过完整性/结构校验」「已保存分析结果」。
- 失败但 `failed=0` 时显示说明：API 请求成功不等于 AI 输出通过校验，也不等于分析完成。
- 旧任务没有 `outputRejected` 时，依据最终错误码保守显示至少 1 条被拒绝输出；不把未知用量当作 0。

## 4. 测试证据

新增：

- `tests/integration/ai-aggregate-recovery.test.mjs`
  - 18 批全部成功、汇总 `finish_reason=length`；
  - 18/18 保存、final 缺失；
  - `error.batchIndex=null`（新）且旧 `batchIndex=0` 读取后规范化；
  - 关闭并重启服务后仍返回 `resume-aggregate`；
  - HTTP `POST /resume` 只请求 1 次汇总，0 次批次；
  - 18 条批次结果的 id/version/checksum 完全不变；
  - 成功后恢复面板/`recovery` 消失；
  - 重复 Continue 0 次 Provider 请求、0 条重复结果；
  - 成功 HTTP + 无效汇总的统计口径。
- `tests/unit/ai-aggregate-budget.test.mjs`：预算上下限、上下文收缩、DashScope headroom、有界 schema 不修改原 schema、三语提示词覆盖全部批次、compact 保留证据引用。
- `tests/unit/ai-recovery-state.test.mjs`：aggregate/session/memory/config 四类恢复动作；完成/乱序/无任务不显示恢复。
- `tests/unit/ai-recovery-ui.test.mjs`：恢复面板、真实 API、不再用共用暂停按钮、三语键与文案一致、无 `innerHTML`/`alert()`。

全量：**668 passed / 0 failed**（2026-11-13，`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`，约 164 秒）。

## 5. 未验证 / 边界

- 没有调用真实付费 Provider；本轮全部是 Mock Provider。真实截断后的聚合行为（例如 Provider 是否接受 16k `max_tokens`）仍需用户实际 Continue 验证。
- 没有在真实生产任务上执行 Resume；安全步骤见 HANDOFF。
- 真实浏览器点击/截图受限；UI 由静态断言、三语键、HTTP 状态与集成测试覆盖。
- 正式 EXE 是否包含本轮代码需重新构建并核对 buildId；旧 EXE 不含本轮修复。
