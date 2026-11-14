# AI Token 效率与 API 成本专项（RC0-AI-EFFICIENCY）

最后更新：2026-11-14 · 范围：Token 归因、请求效率、重复输入、动态分批、输出预算、成本口径、进度 UI
状态：**代码级与正式 EXE 级可关闭**；真实付费 Provider 验收留给 P0-3。

> 本轮**未修改生产数据库、未调用真实付费 Provider、未发送任何真实弹幕到第三方、未 Push/Tag/发布**。
> 所有测量在 `tests/.tmp` 隔离目录中用合成数据 + 本地 Mock Provider 完成。
> 完整开发记录：`log/2026-11-14-ai-token-efficiency.md`。

---

## 1. 结论摘要

| 项目 | 结果 |
| --- | --- |
| 测量场景 | 14 个（小/中/大场次、高密度、少量高活跃、多语言、单场报告、both、Resume、异常、补答、重复 Continue、structured-output Provider） |
| 总请求数 | **216 → 150（-30.6%）** |
| 请求字节（实测） | **9,274,013 → 8,312,569（-10.4%）** |
| Token（按实测字节模拟） | **3,029,258 → 2,723,048（-10.1%）** |
| 单场景幅度 | 见 §7：-17.3% ~ -2.0%，两个场景 0.0%（原因见 §7.3） |
| 观众覆盖率 | **1715/1715，优化前后均 100%** |
| 有效事实数 | **1715 → 1715（完全一致）** |
| 重复事实 | 0 → 0 |
| 结构化校验失败 | 仅注入场景；优化前后均自动恢复为 complete |
| 费用 | 有价格 → 估算；无价格 → `null` + 界面「费用未知」，从不虚构金额 |

**没有达到"大幅削减"的原因已量化**：在真实形态的长期画像场次里，输入 Token 的主体是
观众摘录与现有记忆本身（内容），而不是可删除的开销；单场报告的输入主体是
`messages.jsonl` 的 JSON 结构（见 §12 剩余空间）。本轮只删除了**可证明的重复**与
**过保守的分批**，没有删除任何语义。

---

## 2. 测量方法与诚实标注

### 2.1 工具

新增两个脚本（不进入产品运行路径）：

```text
scripts/ai-efficiency-baseline.mjs   # 14 个场景的确定性测量（Mock Provider + 隔离目录）
scripts/ai-efficiency-report.mjs     # 打印分段字节归因 / 前后对比
```

复现：

```bat
node scripts/ai-efficiency-baseline.mjs --label before
node scripts/ai-efficiency-baseline.mjs --label after
node scripts/ai-efficiency-report.mjs --compare <before.json> <after.json>
```

基线对照必须使用**同一份代码以外的不同实现**：`before` 数据来自 `git archive HEAD`
导出的、未修改的仓库副本（`tests/.tmp/before-repo`），因此"优化前"不是靠估算
推算，而是旧代码真实发出的请求。

### 2.2 什么是实测，什么是模拟

| 项目 | 性质 | 说明 |
| --- | --- | --- |
| 请求数量 | **实测** | Mock Provider 每次被调用即计数 |
| 请求字节 / system / 分段字节 | **实测** | 记录真实序列化后的请求体 |
| 重复请求字节 | **实测** | 对请求体做 SHA-256，重复哈希即重复输入 |
| 批次数量、观众覆盖、事实数、校验失败 | **实测** | 直接来自 SQLite 与 job 状态 |
| 耗时 | **实测**，但由 Mock 主导，**不代表真实 Provider 延迟** | 只用于同环境横向比较 |
| Token 数 | **模拟** | 无 tokenizer、无付费调用。规则：`input=ceil(requestBytes/3.2)`、`output=ceil(answerBytes/3.2)` |
| 费用 | **估算** | 模拟 Token × 场景内填写的单价（1 USD/Mtok 输入、2 USD/Mtok 输出） |
| 真实 Provider 的 tokenizer 差异 | **无数据** | 见 §11 |

同一模拟规则同时用于"优化前"和"优化后"，因此**Token 的差值反映的是真实发送字节的差值**；
但绝对数值不得引用为 Provider 账单。

### 2.3 与 Provider 自报 usage 的交叉校验

Mock 对每个成功响应返回 `usage`，程序按 job 写入 `ai_jobs.usage_json`。
脚本同时统计「Mock 侧模拟用量」与「程序自报 usage」，两者对账差即"发出但未被归因的请求"。
优化前该差值在异常场景为 2 次（429/500 无 usage），优化后所有请求都计入
`attempts`（见 §4.2），差值只体现在 `unknownUsageAttempts`。

---

## 3. 原始 Token 架构（所有可能计费的请求路径）

### 3.1 请求路径清单

| # | 路径 | 入口 | job 归属 | 触发条件 |
| --- | --- | --- | --- | --- |
| 1 | 单场直播报告批次 | `runSession` | session job | 每个消息批次 1 次 |
| 2 | 单场最终汇总（direct / 分层 final） | `#runSessionAggregate` / `#runFinalSynthesis` | session job | 多批任务全部批次导入后 |
| 3 | 分层局部汇总（digest） | `#runDigestGroup` | session job | final 装不下时按层追加 |
| 4 | 单场回答修复 | `requestWithRepair` | session job | 输出未通过本地校验，**最多 1 次** |
| 5 | 长期观众画像批次 | `runMemory` | memory job | 每个观众批次 1 次 |
| 6 | 画像回答修复（整批） | `generateMemoryAnswer` | memory job | 输出未通过校验，**最多 1 次** |
| 7 | 画像定向补答 | `buildTargetedMemoryPrompt` | memory job | 首答漏写观众，只含缺失观众 |
| 8 | 观众级修复 | `memory-viewer-repair` | memory job | 整批修复仍部分非法 |
| 9 | 批次拆分重发 | `#generateMemoryGroup` | memory job | 截断/空响应，按观众组对半拆分（≤2 层） |
| 10 | 传输层重试 | `requestOnce` | 所属 job | 429/5xx/网络（有上限与退避） |
| 11 | 空响应自动重试 | `attempt.mjs` | 所属 job | 仅 `PROVIDER_RESPONSE_EMPTY`，1 次 |
| 12 | Resume / Continue | `resume()` | 原 job | 只处理 pending/failed 批次与观众 |
| 13 | 报告翻译 | `ReportTranslationService` | **`ai_translation_runs`** | 用户切换阅读语言时按块 |
| 14 | Provider 能力测试 | `verifyProviderConfig` | 无 job（配置级） | 用户点击「检测」 |

### 3.2 每次请求的归因字段

新增/补齐的归因（不含任何提示词或聊天正文）：

| 字段 | 来源 | 说明 |
| --- | --- | --- |
| `jobId` | runner | 请求归属的 session/memory job |
| `kind` | runner | `session` / `memory` / `*-repair` / `memory-supplement` / `memory-viewer-repair` / digest / final |
| `batchIndex`、`attempt`、`maxAttempts` | runner | 1-based；attempt 从 1 开始 |
| `model`、`mode`（streaming/non_streaming） | provider 快照 | 与配置无关地记录实际模型 |
| `inputTokens` / `outputTokens` | **Provider 自报** | 缺失为 `null`，从不填 0 |
| `reasoningTokens` | Provider 自报 | OpenAI `completion_tokens_details.reasoning_tokens`、DashScope 等 |
| `cachedInputTokens` | Provider 自报 | OpenAI `prompt_tokens_details.cached_tokens`、DeepSeek `prompt_cache_hit_tokens`、Anthropic `cache_read_input_tokens` |
| `cacheWriteInputTokens` | Provider 自报 | Anthropic `cache_creation_input_tokens` |
| `usageSource` | 派生 | `provider-reported` / `unknown` |
| `estimatedInputTokens` + `estimateSource` | 本地估算 | `bytes-per-3-estimate`，**与真实用量分开标注** |
| `requestBytes` | 实测 | 真实请求体字节 |
| `finishReason`、`httpStatus`、`elapsedMs`、`timeToFirstTokenMs` | 实测 | |
| `outcome`、`retry`、`errorCode` | 实测 | 区分成功/失败/取消/超时/重试 |

落点（**未新增数据库表**）：

1. 日志事件 `ai.request.attempt`：每次尝试一行，含上述 token 与字节字段（不含正文/Key）。
2. 运行状态 `runtime/ai-v13.json`：
   - `lastRequest`：最近一次尝试的完整归因；
   - `attemptStats`：按尝试累计的 `inputTokens/outputTokens/reasoningTokens/cachedInputTokens/retryTokens/repairTokens/repairAttempts/usageUnknown`。
3. `ai_jobs.usage_json`（每 job 一份，session/memory 分开）：新增
   `reasoningTokens`、`cachedInputTokens`、`cacheWriteInputTokens`、`attempts`、`unknownUsageAttempts`、`usageReported`；
   `requests` 保持历史语义（**带 usage 的响应数**）。
4. `GET /api/ai/analyze/status` 新增 `efficiency` 块（见 §8）。

### 3.3 估算/模拟/真实三者的边界

- **真实**：Provider 返回了 usage → 原样保存，界面标「Provider 报告用量」。
- **估算**：本地 `bytes/3` 预算、每百观众/每百事实派生值、费用 → 一律标注 `estimated`。
- **模拟**：本轮基线脚本的 Token 数 → 只在本文档与本轮日志中出现，界面永不显示。
- **缺失**：Provider 未返回 usage → `null` + 「用量未知」；`attempts` 仍 +1。

---

## 4. 发现的真实浪费（均有实测证据）

### 4.1 同一份 JSON Schema 每次请求发送两次

Provider 支持 structured outputs 时，schema 同时出现在：

1. 提示词文本块 `## compact answer schema`（约 **1.5 KiB / 请求**，画像；**3.9 KiB / 请求**，单场）；
2. 请求参数 `response_format.json_schema`（机器强制）。

两处都是**输入 Token**，信息完全重复。实测（s3：1000 位观众 / 6000 条消息 / 100 请求）：
schema 合计 153.7 KiB；s7（单场 12 批）合计 50.9 KiB。

### 4.2 画像提示词内有一份完全重复的输出示例

`buildMemoryInstructions()` 已经把 `memoryCompactShape(locale)` 写进 `## 输出结构示例（紧凑）`，
`buildMemoryPrompt()` 又在末尾追加了**同一个函数**生成的 `## Output example (compact, …)`。
实测：**0.7–0.9 KiB / 请求**，100 个批次即 ~75 KiB 纯重复。

### 4.3 画像契约重复了 `memory_context.json` 里的逐观众数组

`AUTOMATIC MEMORY CONTRACT` 的 `- ref N: nickname=…; evidence_seqs=[…]; zero_excerpt=…`
逐行重复了紧邻其上的 `memory_context.json`（同名字段）。实测：稀疏批次 2.7 KiB/请求，
高密度批次（s4，人均 150 条）**3.9 KiB/请求**，其中大部分是第二次出现的 `evidence_seqs` 数组。
它不是"必要的规则重复"，而是**同一份数据被序列化两次**。

### 4.4 固定观众上限让请求数远超预算需要

`memoryViewersPerBatch()` 只按上下文长度给 10/15/20，与**实际输入/输出需求无关**。
稀疏观众（真实直播最常见：975 位观众 / 8,778 条消息 ≈ 9 条/人）时：

- 1000 位观众 → **100 个请求**；
- 每个请求仅约 28.3 KiB，其中 **~9.4 KiB（33.1%）为固定开销**（指令、契约、schema、示例、system）；
- 配置的 24k 输入预算大部分未被使用。

### 4.5 归因缺口（不是 token 浪费，但会低估成本）

| 缺口 | 影响 |
| --- | --- |
| `normalizeUsage()` 完全不解析缓存 Token | Anthropic/OpenAI/DeepSeek 的缓存命中被当成全价输入；无法报告缓存命中量 |
| `addUsage()` 丢弃 `reasoningTokens` | 推理 Token 在任务累计里永久丢失 |
| 无 usage 的成功响应不计数 | `usage.requests` 低于真实请求数；界面既不显示 token 也不提示"未知" |
| Provider 能力测试的 usage 不汇总 | 用户每次点「检测」的 4–5 次真实请求不可见 |
| 翻译失败/重试尝试的 usage 不累计 | 失败块的成本不可见 |
| 逐请求 token 未进日志 | 无法计算重试开销占比，只能看总数 |

---

## 5. 优化方案与取舍

| # | 方案 | 证据 | 质量风险 | 回滚 |
| --- | --- | --- | --- | --- |
| O1 | **Schema 只发一次**：已校验 `structured_outputs` 的 Provider 不再把 schema 写进提示词，只保留一句指向 `response_format` 的说明；未校验的 Provider（DeepSeek/DashScope/MiniMax/Anthropic/custom 目前均为 `json_object`）**继续发送完整文本 schema** | §4.1 | 无：schema 仍由 `response_format` 机器强制，并通过同一个 `validateAnalysisImport()`；被删的是重复副本 | 删除 `answerSchemaBlock()` 的分支即可恢复 |
| O2 | **删除重复的输出示例**：只保留 `instructions` 内的那一份 | §4.2 | 无：两份由同一函数生成，`estimatedTokens` 随之下降 | 单行改回 |
| O3 | **契约只保留规则与覆盖列表**：逐观众属性以 `memory_context.json` 为唯一权威（excerpt 行仍带 `ref`） | §4.3 | 低：信息未删除，只去重；模型仍能看到每个 ref 的 nickname/evidence_seqs/zero_excerpt | `memoryContract()` 加回逐行即可 |
| O4 | **自适应分批**：`viewerCap` 变为"偏好值"，规划器在**输出预算、摘录上限、内容预算**仍满足时最多扩到 20（与既有 200k 上下文模型的上限一致）；`viewersPerBatchHard` 未显式传入时仍按旧语义硬上限 | §4.4 | 中：单请求观众更多，理论上模型漏写概率上升；失败由既有「定向补答 + 观众级 Resume」兜底，代价远低于翻倍请求 | Runner 不传 `viewersPerBatchHard` 即恢复旧分批 |
| O5 | **归因补齐**：缓存/推理 Token、attempts、unknown 计数、能力测试与翻译失败用量 | §4.5 | 无：只增加记录，不改变请求 | 字段为可选，读取端全部容错 |

### 5.1 明确**未**实施的方案及原因

| 方案 | 实测潜力 | 未实施原因 |
| --- | --- | --- |
| 压缩 `messages.jsonl`（去掉 `event_id`/`message_id`、改用紧凑分隔符） | 单场输入可降 ~50%（实测 93.8% 的字节是 JSON 结构，见 §12） | 会改变提示词的证据行格式，属"重写协议"级变更；无法用 Mock 证明语义质量，留给 P0-3 与独立评审 |
| 提高 `memoryViewersPerBatch` 的硬上限超过 20 | 进一步减少请求数 | 10→20 已是既有设计认可的上限；再提高缺乏质量证据 |
| 任务级时间/费用预算 | — | 前几轮已明确删除（AI_RELIABILITY §10.2），本轮不重新引入 |
| 失败回答加密暂存以避免重发 | 省一次修复请求 | 需新增加密存储与生命周期，超出本轮范围（历史交接已记录） |

---

## 6. 修改的文件

| 文件 | 变更 |
| --- | --- |
| `src/ai/providers/adapters.mjs` | `normalizeUsage()` 解析三类缓存字段 + 推理 Token，区分 Anthropic 的 input 语义 |
| `src/ai/providers/pricing.mjs` | `addUsage()` 保留缓存/推理/attempts；新增 `countRequestWithoutUsage()`；`estimateCost()` 支持可选缓存单价且不虚构折扣 |
| `src/ai/runtime/attempt.mjs` | attempt 记录携带 token、`usageSource`、`estimateSource`；未知保持 `null` |
| `src/ai/api/runner.mjs` | 单一 usage 写路径 `#attributeRequestUsage()`；失败/无 usage 请求也计数；`efficiency` 状态块；prompt 构造传入 `structuredOutputs` |
| `src/ai/api/prompts.mjs` | `answerSchemaBlock()`；删除重复示例；契约去重 |
| `src/ai/batching/tokens.mjs` | `MEMORY_MAX_VIEWERS_PER_BATCH`、`viewerCapHard` |
| `src/ai/export/split-jobs.mjs` | `viewersPerBatchHard` 透传 |
| `src/ai/providers/verify.mjs` | 能力测试 usage 汇总 + 计价 + `usageKnown` |
| `src/ai/providers/store.mjs` | `lastTestStatus.usage` 持久化（无 schema 变更） |
| `src/ai/translation/service.mjs` | 失败/重试尝试也计入 usage（unknown 不填 0） |
| `src/web/js/pages/ai.js` | 推理/缓存 Token、用量来源、重试开销占比、每百观众/每百事实、费用未知 |
| `src/web/js/pages/ai-settings.js` | 显示上次能力测试的真实用量 |
| `src/web/i18n/{zh-CN,ja,en}.json` | 新增 10 个键 + 把「已知实际费用」改为「估算费用」；三语键集合保持一致 |
| `scripts/ai-efficiency-baseline.mjs`、`scripts/ai-efficiency-report.mjs` | 新增测量工具 |
| `tests/unit/ai-token-efficiency.test.mjs` | 12 项新断言 |
| `tests/helpers/ai-fixtures.mjs` | 新增 `parsePromptMemoryRefs()`（唯一权威 ref 表） |
| 既有测试 | 6 个把"10 观众/批"写死的断言改为**从规划器读回**批次数量，语义不变 |

**没有 schema 变更**：数据库仍为 16，备份格式仍为 `.livememory` v1，结果 Schema 仍为 1.3.0，提示词版本仍为 v13.2（文本内容有去重，版本号不因删除重复文本而变更；语义规则未改）。

---

## 7. 优化前后量化对比

测量：14 个场景，合成数据，Mock Provider，同一模拟规则；`before` 来自未修改的 `git archive HEAD` 副本。

### 7.1 核心指标（14 场景合计）

| 指标 | 优化前 | 优化后 | 变化 |
| --- | --- | --- | --- |
| 总请求数 | 216 | 150 | **-30.6%** |
| 输入 Token（模拟） | 2,867,221 | 2,560,520 | **-10.7%** |
| 输出 Token（模拟） | 162,037 | 162,528 | +0.3% |
| 总 Token（模拟） | 3,029,258 | 2,723,048 | **-10.1%** |
| 请求字节（实测） | 9,274,013 | 8,312,569 | **-10.4%** |
| 重试/补答 Token（模拟） | 48,402 | 53,052 | +9.6%（见 §7.3） |
| 观众覆盖 | 1715/1715 | 1715/1715 | 0 |
| 有效事实 | 1715 | 1715 | 0 |

### 7.2 分场景

| 场景 | 请求 前→后 | 输入 Token 前→后 | 总 Token 前→后 | 变化 | 每百观众 Token 前→后 |
| --- | --- | --- | --- | --- | --- |
| 小场次 25 位观众 | 3 → 2 | 27,150 → 22,898 | 29,454 → 25,206 | -14.4% | 117,816 → 100,824 |
| 中场次 100 位观众 | 10 → 6 | 117,953 → 101,310 | 127,163 → 110,562 | -13.1% | 127,163 → 110,562 |
| 大场次 1000 位观众 | 100 → 59 | 884,329 → 715,564 | 976,429 → 807,916 | **-17.3%** | 97,643 → 80,792 |
| 高消息密度（人均 150 条） | 10 → 10 | 419,327 → 410,889 | 423,037 → 414,599 | -2.0% | 1,057,593 → 1,036,498 |
| 少量高活跃 + 大量低活跃 | 11 → 7 | 114,149 → 96,971 | 123,357 → 106,211 | -13.9% | 123,357 → 106,211 |
| 多语言弹幕 | 6 → 4 | 122,255 → 111,850 | 127,793 → 117,402 | -8.1% | 212,988 → 195,670 |
| 单场报告（300 人 / 3000 条） | 13 → 13 | 296,950 → 296,951 | 298,722 → 298,723 | 0.0% | N/A |
| 单场 + 长期画像（both） | 12 → 9 | 169,814 → 157,090 | 177,674 → 164,981 | -7.1% | 222,093 → 206,226 |
| 部分失败后 Resume | 11 → 7 | 117,952 → 101,310 | 127,162 → 110,562 | -13.1% | 127,162 → 110,562 |
| 异常响应（空/截断/429/500） | 11 → 9 | 97,803 → 92,682 | 103,336 → 98,228 | -4.9% | 172,227 → 163,713 |
| 首答漏写 → 定向补答 | 3 → 3 | 25,753 → 24,833 | 27,600 → 26,689 | -3.3% | 138,000 → 133,445 |
| 完成后再次 Continue | 3 → 2 | 35,369 → 30,964 | 38,132 → 33,737 | -11.5% | 127,107 → 112,457 |
| structured-output 画像（openai） | 10 → 6 | 123,341 → 101,503 | 132,551 → 110,755 | -16.4% | 132,551 → 110,755 |
| structured-output 单场（openai） | 13 → 13 | 315,076 → 295,705 | 316,848 → 297,477 | -6.1% | N/A |

### 7.3 为什么两个场景是 0.0% / 为什么重试占比上升

- **单场报告 0.0%**：该场景使用 `custom`（`response_format=json_object`）Provider，schema 本来
  只存在于提示词中，没有第二份可删；单场提示词也没有重复示例。因此本轮的 prompt 去重对它
  **无效**，这是正确结果，不是测量失败。换成 `openai`（已校验 structured outputs）后同一形态
  为 **-6.1%**（见最后一行）。
- **重试/补答 Token +9.6%**：请求变少、单请求变大，注入的异常命中同一批次时，重发一次的成本更高；
  同时 `usage` 现在把无 usage 的失败尝试计为 attempts（旧代码直接丢失）。**绝对量仍远小于
  请求数下降带来的节省**；重试占比从 26.5% → 27.0%（s10），因为分母（总 Token）下降了 4.9%。

### 7.4 分段字节归因（s3：1000 位观众 / 6000 条消息）

| 分段 | 优化前（100 请求） | 优化后（59 请求） |
| --- | --- | --- |
| 观众摘录（内容） | 1,241.8 KiB | 1,243.0 KiB（不变） |
| `memory_context` | 333.2 KiB | 287.6 KiB |
| 记忆契约 | 266.2 KiB | 118.4 KiB（**-55%**） |
| JSON Schema 文本 | 153.7 KiB | 97.0 KiB（**-37%**，仅 structured 场景可归零） |
| 指令：任务 / 规则 / 示例 | 328.8 KiB | 194.1 KiB |
| 重复输出示例 | 72.9 KiB | **0** |
| 合计字节 | 2,829,718 B（fixed 33.1%） | 2,289,711 B（fixed 20.8%） |

---

## 8. 质量约束与回归

| 约束 | 验证 |
| --- | --- |
| 观众覆盖率不下降 | 14 场景全部 `covered == total`（1715/1715）；`ai_job_memory_viewers` 无 pending/failed |
| 事实正确性不下降 | 事实数 1715 → 1715；同一 mock 规则下逐观众 statement 内容与优化前完全一致 |
| 跨观众证据错误不增加 | 既有 `ai-memory-reliability` 的 `MEMORY_EVIDENCE_OTHER_VIEWER` 用例全部通过（17 项） |
| 重复事实不增加 | `memory_facts` 的 `(memory_id, dedupe_key)` 唯一性由导入事务保证；基线统计重复事实 0 → 0 |
| `AI_IMPORT_INVALID` 不增加 | 只有注入场景出现，且优化前后都通过补答/观众级修复恢复为 `complete` |
| 恢复能力不下降 | Resume 场景：优化后 7 个请求完成 100/100；再次 Continue 0 请求 |
| 任务成功率不下降 | 14/14 场景 `complete`（注入异常的场景也恢复） |
| 结构化契约不下降 | 未校验 structured outputs 的 Provider 仍收到完整文本 schema；所有回答仍经 `validateAnalysisImport()` |
| 身份/证据/金额/去重规则 | 未改动；`viewer_id` 仍由本地映射注入，金额仍不进入 AI |

**明确声明**：上述"质量"是**结构化与覆盖层面的回归**，不是语义质量评估。Mock Provider 不
产生真实语义，因此**不能据此宣称真实模型的报告质量相同**；O4（自适应分批）的语义影响必须由
P0-3 真实付费 Provider 复核。

---

## 9. 费用口径

- 价格完全可选。填写 `inputPerMillion` + `outputPerMillion` 后，界面显示
  「估算费用（Token × 已填价格）」，并注明 `basis=estimated_tokens_x_published_price`。
- 未填写价格：`cost=null`，界面显示「费用未知（未填该模型价格；Token 用量不受影响）」，
  **不阻断任务、不显示 0、不显示虚构金额**。
- 缓存命中：单独记录 `cachedInputTokens`；若用户填写了可选缓存单价则按该价计，否则按输入单价计
  （偏高，不虚构折扣），并在 `cost.cachePriced=false` 中标明。
- 缓存写入（Anthropic `cache_creation_input_tokens`）按输入单价计，不猜测 1.25× 之类的倍率。
- 真实 Provider 返回的 `usage.cost`（OpenRouter）**不被采用**：本地只做估算，避免把厂商字段
  当作账单；该字段仍保留在适配器返回值中供未来评审。
- 能力测试与翻译的用量独立展示，不混入 `ai_jobs.usage_json`。

---

## 10. 不同模型的适配

| Provider | `response_format` | 本轮 schema 去重是否生效 | 备注 |
| --- | --- | --- | --- |
| OpenAI / OpenRouter | `json_schema`（已校验） | **是** | 最大受益者（-6.1% ~ -16.4%） |
| DeepSeek / DashScope / MiniMax / Anthropic / custom | `json_object` 或提示词 | 否 | 继续收到完整文本 schema；只受益于 O2/O3/O4 |
| Anthropic | 无 `json_schema` | 否 | 缓存字段（`cache_read`/`cache_creation`）现在被正确解析并计入 input |
| DashScope 思考模式 | `max_completion_tokens = 回答 + 16k` | — | 推理 Token 现在进入 usage 与界面（若 Provider 返回） |

**不假设所有模型共享同一 Token 计算方式**：预算仍使用本地 `bytes/3` 估算并记录
`estimateSource`；真实用量一律以 Provider 自报为准；未知时保持未知。

---

## 11. 限制与待验收

1. **无真实付费 Provider 数据**：Token 绝对值是模拟；真实 tokenizer 与估算的比值（历史记录为
   ~1.366×）未在本轮重新校准。→ P0-3。
2. **无语义质量评估**：Mock 只能验证覆盖、结构、证据归属，不能验证摘要/事实的语义正确性。
3. **O4 自适应分批的风险未在真实模型上验证**：单请求从 10 位观众增至最多 20 位，需观察真实模型的
   漏写率与补答率。缓解：既有定向补答与观众级 Resume 仍在；`viewersPerBatchHard` 可一键回退。
4. **耗时不可比**：Mock 主导，不代表真实延迟。
5. **缓存命中的真实性未知**：只解析 Provider 字段；不同 Provider 何时命中缓存不在本轮范围。
6. **未验证真实 UI 点击**：界面改动由单元测试（三语键、无 innerHTML、真实 API 形状）与正式 EXE
   的 HTTP 响应覆盖，不是真实浏览器点击。

---

## 12. 剩余可优化空间（已量化，未实施）

| 空间 | 实测/估算 | 说明 |
| --- | --- | --- |
| `messages.jsonl` 结构开销 | **93.8%** 的字节是 JSON 结构（实测 3000 条消息：563,312 B，其中正文 34,917 B，187.8 B/条 vs 11.6 B/条正文） | 真实弹幕更长，比例会下降；但仍是单场输入的最大单一项 |
| `session_context.json` 每批重复 | 8.6 KiB × 12 = 111.7 KiB（s7 的 11.7%） | 时间线/表情字典/经济支持对批次分析有用，未改 |
| 固定指令文本 | s3 优化后仍有 194 KiB（约 8.5% 的字节） | 三语规则不能随意删；可考虑按任务裁剪，但需质量证据 |
| 单场 schema（非 structured Provider） | 3.9 KiB × 12 = 50.9 KiB | 无法删除：这些 Provider 只能靠提示词获得 schema |
| 模型级 prompt cache（如 DeepSeek/Anthropic 的稳定前缀） | 未测量 | 固定前缀（system + 指令 + schema）在各请求间高度相同，若 Provider 支持前缀缓存可显著降本；需要真实用量验证命中率 |
| 输出预算 | 输出仅占总 Token 5.3% | 优化输出对总成本影响有限；继续保证不截断 |

---

## 13. 复现

```bat
:: 1) 基线（未修改的代码副本）
git archive HEAD -o tests\.tmp\before-repo.tar
tar -x -f tests\.tmp\before-repo.tar -C tests\.tmp\before-repo
copy scripts\ai-efficiency-baseline.mjs tests\.tmp\before-repo\scripts\
node tests\.tmp\before-repo\scripts\ai-efficiency-baseline.mjs --label baseline-head

:: 2) 优化后
node scripts\ai-efficiency-baseline.mjs --label after

:: 3) 对比
node scripts\ai-efficiency-report.mjs --compare tests\.tmp\before-repo\tests\.tmp\ai-efficiency\baseline-head.json tests\.tmp\ai-efficiency\after.json

:: 4) 正式 EXE 上的归因/Resume 验证（本地 Mock Provider）
node scripts\verify-ai-token-exe.mjs
```

产物：`tests/.tmp/ai-efficiency/*.json`（含逐场景分段字节与阶段明细），不进入 Git。

## 14. 正式 EXE（本轮实测）

| 项目 | 值 |
| --- | --- |
| 文件 | `dist/LiveMemory.exe` |
| 大小 | `96,623,616` bytes（92.1 MB） |
| SHA-256 | `178585a6f65bbffa7f657f3ecb9a7e5c7ce1ce954ef3c8570705ea1d131a73a3` |
| buildId | `4a149ca7286e` |
| commit | `649f8192bc6fe53a4957d6c906bcc1e8bf4a212c` |
| builtAt | `2026-11-14T09:44:11.067Z` |
| 资源 | `189` files；20 个必需模块；`asInvoker` |

`scripts/verify-ai-token-exe.mjs` **16/16**（正式 EXE + 本地 OpenAI-compatible Mock Provider）：

- 分析完成 40/40 观众 / 3 批 / 3 请求；
- usage 输入 20,893 / 输出 3,563 / **缓存命中 8,356** / requests 3 / attempts 3；
- `tokenSource=provider-reported`，逐尝试账本 24,456 tokens；
- 估算费用 0.019663 USD、每百观众 0.049157 USD、每百观众 Token 61,140、事实 40；
- 每个计划批次只请求一次；便携备份仍可创建（768,515 B）；
- 完成后重复 Continue **0 请求**；重启后 token 完全一致；
- 注入 500：failed=3、unknownUsageAttempts=3、attempts 5 vs requests 2、failedBatches=[2]，
  兄弟批次已保存（23/40）；
- Resume 后 40/40 完成，且**只**重新请求 b02（1 次）。

同轮回归：`verify-p0-2-exe` 13/13、`verify-p0-5-exe` 12/12、`verify-exe` 10/10。

