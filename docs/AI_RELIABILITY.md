# AI 分析可靠性与性能（v0.13.1 专项修复）

- 日期：2026-11-12
- 范围：付费 API 分析的超时/重试、分批、流式输出、进度与费用统计
- 结论性质：**代码已修改并有本地确定性测试**；真实付费 API 仍未验证（本机无 Key）。
- 前序调查：`docs/AI_TIMEOUT_INVESTIGATION.md`（180 秒客户端超时 + 3 次原样重发）

---

## 1. 复用与改动边界

复用，不重写：

| 能力 | 复用方式 |
| --- | --- |
| 分析包协议 `livememory-analysis-v1` / 结果协议 1.3.0 | 完全沿用；单批 session 包格式不变 |
| `validateAnalysisImport()` + `importAnalysisResult()` | 所有流派生回答仍先本地组装，再走同一校验与事务导入 |
| `AnalysisState`（`runtime/ai-v13.json`） | 只增加响应模式与尝试统计；不含提示词/聊天/回答 |
| `ProviderRequestScheduler` | 保留按 `configId` 隔离的并发/429/退避；补充超时与取消计数 |
| 多 Provider Adapter | 保留 OpenAI Chat Completions 与 Anthropic Messages 两套协议 |
| 报告与长期画像读模型 | 未改 Schema；多批 session 复用既有 `final` 汇总读取路径 |
| UI 五步入口 | 不增加 Streaming/超时等普通用户设置；只增加可选 token 预算与超时输入 |

没有引入依赖、云服务、账号或遥测。数据库 Schema 仍为 **13**，结果 Schema 仍为 **1.3.0**。

---

## 2. 超时、取消与重试

### 2.1 错误分类

每次尝试（attempt）由 adapter 返回明确类别，不再把 `AbortError` 与 `TimeoutError` 合并：

| 类别 | 触发 | 自动重试 | 说明 |
| --- | --- | --- | --- |
| `canceled` | 用户暂停/取消/退出、外部 `AbortSignal` | **绝不** | 终态 `paused` / `canceled`，不记 Provider 失败 |
| `timeout` | 响应头超时、流式空闲超时、任务预算耗尽 | **默认绝不** | 请求已发出，Provider 可能仍在执行 |
| `network` | DNS/拒绝连接等连接阶段失败 | 最多 1 次 | 仅连接未建立的错误 |
| `rate_limit` | HTTP 429 | 最多 3 次尝试 | 遵守 `Retry-After`（含 0） |
| `server` | 5xx / 408 / 425 | 最多 3 次尝试 | 指数退避 + 50–100% 抖动 |
| `client` | 400/401/403/404/422 | 不重试 | 配置或请求错误 |
| `invalid_response` | 空内容、JSON body 无法解析、流式错误事件 | 不重试 | 重发不是修复 |
| `stream_interrupted` | 流在 finish 事件前结束/读中断 | 不重试 | 已产生的部分输出不导入 |
| `config` | 缺少 Key、未知协议 | 不重试 | 明确配置错误 |

核心策略在 `src/ai/runtime/attempt.mjs`。超时被明确标记为 `retryable:false`；只有连接阶段网络错误允许一次安全重试。

### 2.2 超时语义

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `timeoutMs` | 180,000 ms，UI 可设 10–600 秒 | 等待**响应头**的最长时间；流式开始后作为无进展上限基准 |
| 流式空闲超时 | 60,000 ms（不超过 `timeoutMs`） | 持续有 token 时不会因“总时长”被截断；停止输出 60 秒才失败 |
| 任务时间预算 | 20 分钟 | 达到后不再发起新尝试，返回 `ANALYSIS_TASK_TIMEOUT`；已完成批次保留 |

> 没有把 180 秒简单改成 600 秒。非流式只在“无响应头”阶段等待；流式按空闲计时，长回答可以持续推进。

### 2.3 重试与“不重复大请求”

- 超时、截断（`finish_reason=length`）、退化、流中断都不自动重发；
- 只有普通 Schema 校验失败才允许 **一次** repair 请求；
- 失败后 `resume` 只发未完成批次，已导入批次不会重发；
- 被拒绝的流式传输（400/404/415/422 且错误明确指向 stream）只回退一次到非流式，并把结果记入 `runtime/ai-v13.json`，后续任务直接使用已验证的非流式模式。

### 2.4 `runPool` 批次隔离

旧实现首个失败即 `poolController.abort()`，会掐断同批其他正在执行的请求。新实现：

1. 失败后停止**调度新批次**；
2. 已在执行的兄弟批次继续完成、继续逐批导入；
3. 全部 worker 结束后再抛出第一个错误；
4. 只有用户取消/暂停/退出才通过外部 signal 中止在途请求。

因此“一场失败导致其他已成功批次丢失/重复计费”的问题被移除。

---

## 3. 基于 token 的动态分批

### 3.1 单场分析（session）

- `createSessionAnalysisJob()` 先按消息序列化后的字节估算 token，再按 `batchInputTokens` 预算切分；
- 预算包含：system prompt、instructions、session_context、compact answer schema、消息本身；
- 默认 8,000 input tokens；UI/配置可设 2,000–32,000；模型上下文较小时自动缩小，并同步限制输出上限；
- 所有消息必须且只能出现在一个批次；单条超长消息单独成批，不丢弃；
- 多批任务需要 **一次 final aggregate** 才能 `complete`；
- 汇总只使用已校验的批结果，不含原始聊天；证据在汇总中必须是 `{"batch": n, "seq": m}`；
- 汇总失败时所有批次结果保留，可用同一 job 恢复；上下文不足以汇总时明确 `ANALYSIS_AGGREGATE_TOO_LARGE`，不伪造报告。

单批场景保持原有行为：`batchTotal=1`、`task_id=<session>-analysis`、无需汇总。

### 3.2 观众长期画像（memory）

- 仍按“同一观众只属于一个批次”分配，不跨批拆散；
- 预算内同时计入：发言摘录、现有记忆事实、允许证据 seq 列表、instructions/schema/contract 固定开销；
- 观众上限、摘录上限、批次上限继续生效；超预算的单位观众单独成批（不丢观众）；
- 每批仍独立校验、独立导入、独立恢复；一位观众失败不影响其他批次。

### 3.3 覆盖与汇总约束

- 消息覆盖：`ai_job_messages` 中每个 `(batch_index, seq)` 唯一；测试校验 420 条消息全量出现一次。
- 观众覆盖：`ai_job_memory_viewers` 中每位观众恰好一行；测试校验 8/8、30/30。
- 汇总去重：aggregate prompt 要求合并而不是拼接；最终话题只来自 final 结果，报告不再逐批拼接。
- 兼容：旧 1.0.0–1.2.0 结果、旧 `combined` 任务、既有报告仍可读；未迁移数据库。

### 3.4 新增/变更的包字段

`manifest.json` 增加可选 `batch_plan`（不是结果 Schema）：

```json
{
  "batch_plan": {
    "input_budget_tokens": 8000,
    "estimated_prompt_tokens": 6120,
    "batches_total": 5,
    "viewerOversized": false
  }
}
```

`batch_plan` 只用于诊断，不进入模型回答，也不参与结果校验。

---

## 4. 流式响应

### 4.1 自动选择，不暴露给普通用户

- 用户只选择 Provider / 区域 / Model ID；
- 默认优先 Streaming；
- Adapter 根据实际返回自动识别：
  - `text/event-stream` → 解析 SSE；
  - Provider 忽略 `stream` 返回 JSON → 按普通响应处理，并记录该配置为非流式；
  - Provider 明确拒绝 stream → 仅回退一次，记录后后续直接非流式；
- AI 中心不要求用户理解或手动选择 Streaming。

### 4.2 缓冲与校验

- 流式内容只在 adapter 内累积，完成后才返回给 runner；
- 未完成/中断的流不会调用 `importAnalysisResult()`，数据库不会出现半份结果；
- 完成后仍执行原有的 JSON 提取、本地组装、Schema 1.3.0、观众覆盖、证据归属、去重与事务导入；
- Provider 不返回 usage 时明确显示“用量未知”，不按 0 计费。

### 4.3 计时指标

每次尝试记录（状态与日志，不含正文）：

- 请求开始、响应头、首字节/首个 SSE 事件、最后一个字、结束；
- `timeToHeadersMs`、`timeToFirstByteMs`、`timeToFirstTokenMs`、`streamDurationMs`、`maxIdleMs`、总耗时；
- 是否收到响应头、是否收到模型输出；
- Provider 返回的 `finish_reason`、usage 是否存在。

### 4.4 多 Provider 兼容

| Provider/协议 | 流式 | 结构化输出 |
| --- | --- | --- |
| OpenAI Chat Completions | SSE `choices[].delta` | `response_format` 沿用 |
| Anthropic Messages | SSE `message_start` / `content_block_delta` / `message_delta` | prompt 约束（无 json_schema 参数） |
| OpenAI-compatible（含 DashScope/MiniMax/DeepSeek/OpenRouter/自定义） | 支持 SSE；`stream_options.include_usage` 仅对已知支持者发送 | 按配置能力选择 `json_schema` / `json_object` |

---

## 5. 用户体验

AI 分析中心新增/明确显示：

- 当前阶段（打包 / 单场批次 / 汇总 / 验证导入 / 画像批次）；
- 已完成批次 / 总批次（单场与画像分别显示）；
- 已处理观众 / 总观众（来自真实 `memoryCoverage`）；
- 当前请求运行时间（本地时钟，从服务端 `startedAt` 计）；
- 是否已收到模型输出（流式首 token 时更新）；
- 当前是否在重试及第几次尝试；
- 已完成结果是否已保存（单场报告、单场批次、画像批次）；
- 真实失败原因（稳定错误码 + 脱敏 detail）；
- 成功 / 失败 / 取消 / 超时 / 重试请求分别统计；
- 失败且无 usage 时显示“用量未知”。

预计剩余时间只在 **≥3 个成功批次样本** 且任务运行中显示；否则不显示，避免无依据 ETA。

真实浏览器验收（headless Edge + DevTools）截图：

- `docs/screenshots/ai-reliability-running-v0131-light.png`
- `docs/screenshots/ai-reliability-complete-v0131-light.png`
- `docs/screenshots/ai-reliability-complete-v0131-narrow.png`
- `docs/screenshots/ai-reliability-settings-v0131-light.png`

---

## 6. 请求与费用统计口径

| 字段 | 含义 |
| --- | --- |
| `attemptStats.total` | 本任务实际 HTTP 尝试次数（含重试） |
| `attemptStats.succeeded` | 收到成功响应的尝试 |
| `attemptStats.failed` | 非取消、非超时的失败尝试 |
| `attemptStats.canceled` | 用户取消/暂停导致的尝试 |
| `attemptStats.timedOut` | 超时尝试 |
| `attemptStats.retried` | 发生自动重试的尝试次数 |
| `attemptStats.usageUnknown` | 未返回 usage 的非成功尝试 |
| `requestStats` | 按 `configId`、按进程的调度器统计（并发、排队、429、p50/p95、模型耗时） |
| `usage` | 只累计 Provider 明确返回的 usage；无 usage 不写 0 |
| `estimatedCost` | 按已知价格与 token 估算，不是账单 |

能力检测请求仍不进入分析任务统计；它们记录在独立的 `ai_provider_tests` 审计表。

---

## 7. 确定性测试（不消耗真实 API）

新增：

| 文件 | 覆盖 |
| --- | --- |
| `tests/unit/ai-attempts.test.mjs` | 超时不重试、取消不重试、网络仅一次、429/5xx/4xx 策略、attempt 日志字段、任务预算 |
| `tests/unit/ai-stream.test.mjs` | SSE 解析、跨 chunk 重组、空闲超时、OpenAI/Anthropic 累积 |
| `tests/unit/ai-token-batching.test.mjs` | 预算自适应、消息/观众覆盖、超预算单观众隔离、批次上限显式失败 |
| `tests/integration/v14-session-batching.test.mjs` | 420 消息多批、全量覆盖、final aggregate、批次部分失败时兄弟批次保留、恢复不重发已完成批次 |
| `tests/integration/v14-streaming-timeout.test.mjs` | 流式成功/首 token 进度、流中断、180 秒式超时只 1 次、取消、流式回退、JSON 不完整只修一次、Anthropic 流、任务预算、429 计数、8 观众全覆盖 |

全量：**583 passed / 0 failed**（2026-11-12，`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`，约 96 秒）。

---

## 8. 仍未验证 / 边界

- **真实付费 API 生成仍阻塞**：本机没有可用的 Provider Key；不得用 Mock 结果声称真实验收。
- 真实 DashScope `qwen3.8-max` 174k token 大场未重跑；分批与汇总逻辑由 Mock 覆盖。
- 真实 EXE 未运行（UAC 限制）；未验证打包后的流式连接与代理。
- 部分 Provider 对 `stream_options.include_usage` 支持未知：本实现只对已知支持者发送，其他 Provider 的流式 usage 可能未知，界面会如实显示。
- 流式结构化输出兼容性因模型而异；不兼容时回退一次，绝不无限重发。
- 汇总请求本身可能因批次结果过多超过小上下文模型；此时明确失败并保留批次，不生成不完整“整场报告”。
- `batchInputTokens` 的估算基于 UTF-8 字节 / 3，不是精确 tokenizer；实际值记录在 `batch_plan.estimated_prompt_tokens` 与状态日志中。
