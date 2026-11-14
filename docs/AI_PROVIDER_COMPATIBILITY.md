# AI Provider 兼容性、真实用量与付费验收计划（P0-3）

- 日期：2026-11-14
- 阶段：**P0-3 阶段 A（免费、只读与 Mock 预验收）**
- 代码基线：本轮修复后的本地提交（见 `docs/STATUS.md` §0.27 与 `docs/HANDOFF.md` §0）
- 结论性质：**没有调用任何真实付费 API**。本文的“已验证”只到 Mock/离线级别；真实
  Provider、真实计费与真实长期画像语义质量仍是 **未验证**，必须等用户批准阶段 B。

> 本文是 P0-3 的审计底稿与付费测试方案。测试总费用必须由用户明确批准；本文的金额是
> **按公开单价的估算**，不是账单。

---

## 1. 证据等级

| 级别 | 含义 |
| --- | --- |
| L1 代码已适配 | 有明确的请求构造、响应解析、错误分类与恢复路径 |
| L2 Mock 已验证 | 本地 Mock Provider 驱动的单元/集成测试通过；不联网 |
| L3 真实 Provider 已验证 | 用户授权的真实 Key + 真实计费请求通过，并有 usage/费用证据 |
| L4 尚未验证 | 没有对应证据 |
| L5 已知不兼容 | 文档明确说明不支持，或协议本身无法支持 |

**L2 不能替代 L3。** 本轮只把 L1/L2 做到完整；L3 全部待阶段 B。

---

## 2. Provider 兼容性矩阵（阶段 A 结束状态）

| Provider | 协议 / 端点 | 鉴权 | 结构化输出 | 输出上限参数 | 流式 | usage 语义 | 阶段 A 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| OpenAI | Chat Completions `/chat/completions` | `Authorization: Bearer` | `json_schema`（能力测试通过后）+ `json_object` 回退 | `max_completion_tokens`；推理模型不发送 `temperature`；`system`→`developer` | SSE，`stream_options.include_usage` | `prompt_tokens` 含缓存；`prompt_tokens_details.cached_tokens` / `cache_write_tokens`；`completion_tokens_details.reasoning_tokens` 已含在 completion 内 | **L2**（本轮新增推理模型适配、缓存写入解析） |
| DeepSeek | OpenAI-compatible `/chat/completions` | Bearer | 仅 `json_object`（官方文档无 `json_schema`） | `max_tokens`（1–384K） | SSE；官方文档说明最后一帧总带 usage | `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`，prompt 含缓存 | **L2** |
| DashScope / Qwen | compatible-mode `/chat/completions` | Bearer | `json_object`（不发 `json_schema`） | `max_tokens` + `max_completion_tokens`（回答 + 16K 思考预留） | SSE | `prompt_tokens_details.cached_tokens`；`reasoning_content` 只计字符数 | **L2** |
| OpenRouter | `/api/v1/chat/completions` | Bearer + `HTTP-Referer`/`X-Title` | 按模型；能力测试通过后 `json_schema`，拒绝则降级 | `max_tokens`（透传） | SSE | `prompt_tokens_details.cached_tokens`；`usage.cost` 记录为 `providerReportedCost` | **L2**（本轮新增 provider 自报费用采集） |
| Anthropic | Messages `/messages` | `x-api-key` + `anthropic-version` | 无 `response_format`；Schema 只在提示词里，本地校验 | `max_tokens`（≤32,000） | SSE `message_start` / `content_block_delta` / `message_delta` | `input_tokens` **不含**缓存；`cache_read_input_tokens` + `cache_creation_input_tokens` 归一为总输入 | **L2** |
| MiniMax | OpenAI-compatible（中国/国际区域分开） | Bearer | `json_object`（不发 `json_schema`） | `max_tokens` | SSE；未发送 `stream_options`，usage 可能未知 | 若返回 usage 则按 OpenAI 字段归一；否则 `unknown`，不填 0 | **L2**（仅通用 OpenAI-compatible 路径，无真实样本） |
| 自定义 OpenAI-compatible | 用户 Base URL `/chat/completions` | Bearer（可选） | 能力测试通过后 `json_schema`；拒绝时一次降级 | `max_tokens` | 支持 SSE；拒绝 stream 时一次非流式回退 | 同 OpenAI 字段；自定义服务器可能完全不返回 usage | **L2**（测试中大量使用） |

状态细化：

| 项目 | 状态 |
| --- | --- |
| 请求格式、鉴权、端点、超时/重试、错误分类 | L1 + L2 |
| JSON Schema / JSON Object / prompt-only 三种模式 | L1 + L2 |
| 推理模型参数（`max_completion_tokens`、无 temperature、`developer`） | L1 + L2（本轮修复） |
| 缓存/推理 Token 归一 | L1 + L2 |
| 真实 Provider 的 200/400/429/5xx/截断/空响应 | **L4**（阶段 B） |
| 真实长期画像语义质量（10 vs 20） | **L4**（阶段 B） |
| 真实费用与官方账单核对 | **L4**（阶段 B；OpenRouter 可自动采集 `usage.cost`） |
| 三语言真实输出 | **L4**（阶段 B 代表性验证） |

已知不兼容 / 边界：

1. **DashScope 原生（非 compatible-mode）协议**不支持；只支持 OpenAI-compatible 端点。
2. **MiniMax 的 Anthropic SDK 路径**未接入；本程序走 OpenAI-compatible 路径。
3. 需要非 Bearer 鉴权、签名、企业网关自定义 Header 的服务不在支持范围内（自定义配置只发
   `Authorization: Bearer` 与 `content-type`）。
4. 不支持 Responses API / Assistants / 工具调用；只使用 Chat Completions 与 Messages。
5. Anthropic 没有 `json_schema` 参数，Schema 只能放在提示词里；结构正确性由本地
   `validateAnalysisImport()` 兜底，不能声称“服务端强制结构化”。
6. 不同 Provider 的 `finish_reason` 词表不同（如 DeepSeek 还有
   `insufficient_system_resource` / `aborted`）；程序只把 `length` / `max_tokens` 视为截断，
   其他值原样记录，不猜测语义。
7. 缓存与推理 Token 的计费折扣依赖用户是否填写缓存单价；未填写时按普通输入价估算，并标记
   `cachePriced=false`，不虚构折扣。

---

## 3. 本轮修复的确定性缺陷（离线可复现）

### 3.1 结构化输出能力检测是循环的（严重）

- 位置：`src/server/routes.mjs` 能力测试路由传入
  `supportsStructuredOutputs: config.capabilities?.structuredOutputs === true`。
- 问题：`capabilities.structuredOutputs` 只由这次能力测试写入。首次测试时它必为 `false`，
  测试只发 `json_object`，因此永远写不回 `true`。结果是：
  - OpenAI / OpenRouter 的真实用户**永远走不到** `response_format: json_schema`；
  - RC0-AI-EFFICIENCY 声称的“Schema 只发一次、每请求省 1.5–3.9 KiB”在生产中**没有生效**；
  - Mock 测试直接给 `verifyProviderConfig` 传 `supportsStructuredOutputs: true`，因此没有
    暴露该问题。
- 复现（Phase A 实测）：用路由同样的入参调用 `verifyProviderConfig`，捕获到的
  `response_format` 序列为 `none, json_object, json_object, json_object`；
  `capabilities.structuredOutputs=false`。改为 provider 声明后序列为
  `none, json_schema, json_schema, json_schema`，且只在 session 复杂 Schema 通过后才记为
  `true`。
- 修复：路由传入 provider 声明（`config.supportsStructuredOutputs`，来自目录）或已记录的
  能力；`verify` 只在 session 阶段用 `json_schema` 成功且本地组装/校验通过时才写
  `structuredOutputs=true`。

### 3.2 模型拒绝 `response_format` 时任务永久失败

- 旧行为：能力测试直接 fatal，后续阶段全部跳过；真实分析任务收到 400/422 后按
  `client` 错误永久失败，用户只能换模型。
- 修复：
  - 能力测试：仅当 400/422 且错误信息指向 format/schema 时，**一次**降级到
    `json_object`，继续完成其余阶段；不会把降级冒充为结构化能力。
  - 真实任务：`requestOnce()` 做有界降级 `json_schema → json_object → prompt-only`。
    降级时把完整 JSON Schema **追加回提示词**（因为结构化模式的提示词只留了一行指针），
    所以输出契约没有丢失；`structuredOutputs` 持久化降为 `false`，后续任务与 Resume 不再
    重复失败。每次请求最多 2 次降级，仍计入真实 attempt 与 usage。

### 3.3 OpenAI 推理模型的请求参数不兼容

- 官方文档：`max_tokens` 已废弃，且 **不能用于 o-series**；推理模型的
  `temperature` 只接受默认值；o-series / GPT-5+ 用 `developer` 取代 `system`。
- 旧行为：所有 OpenAI 请求都发 `max_tokens` + `temperature: 0` + `system`，推理模型会 400。
- 修复：
  - `providerId === 'openai'` 使用 `max_completion_tokens`（回答 + 推理的总上限）；
  - 识别 o-series / GPT-5+ 时不再发 `temperature`，并把 `system` 映射为 `developer`；
  - 推理模型增加 16,000 Token 的“思考预留”（只是上限，不花未使用的 Token），避免
    6,000 的回答预算被思考吃光后返回空 + `length`。
  - 非 OpenAI 家族保持原 `max_tokens` 形状；DashScope 仍额外发 `max_completion_tokens`。

### 3.4 OpenAI 缓存写入 Token 未被解析

- OpenAI 当前字段是 `prompt_tokens_details.cache_write_tokens`；旧代码只读
  `prompt_cache_write_tokens` / `cache_creation_tokens`，因此缓存写入永远是 0。
- 修复并新增单测。缓存读取仍按“包含在输入内”处理，不与输入相加；Anthropic 仍按
  “input + cache_read + cache_write”归一。**没有把缓存/推理 Token 简单重复相加。**

### 3.5 OpenRouter 自报费用未保存

- OpenRouter 在 `usage.cost` 返回实际扣费（credits，锚定 USD）。旧代码读取后丢弃。
- 修复：归一为 `providerReportedCost`，按请求累计并写入 `ai_jobs.usage_json`
  与 `/api/ai/analyze/status.efficiency`；与本地“Token × 用户单价”的估算费用**分开**保存。
  没有自报费用的请求计入 `providerCostRequests`，因此部分数据不会被冒充为完整账单。

---

## 4. 用量与费用口径

| 字段 | 含义 | 归一规则 |
| --- | --- | --- |
| `inputTokens` | 计费输入总量 | OpenAI/DeepSeek/DashScope `prompt_tokens` 已含缓存；Anthropic `input + cache_read + cache_write` |
| `cachedInputTokens` | 输入中的缓存命中子集 | 永远 `≤ inputTokens`；不额外加到输入 |
| `cacheWriteInputTokens` | 缓存写入 | OpenAI `prompt_tokens_details.cache_write_tokens`；Anthropic `cache_creation_input_tokens` |
| `outputTokens` | 计费输出 | `completion_tokens` / `output_tokens`；推理 Token 已包含在内 |
| `reasoningTokens` | 推理 Token | 单独展示，**不**再加到 output |
| `providerReportedCost` | Provider 自报扣费 | 仅 OpenRouter 当前提供；与估算费用分开 |
| `cost` | 估算费用 | Token × 用户填写单价；缺价格时 `null`，界面显示“费用未知” |
| `requests` | 带 usage 的响应数 | 旧口径保留 |
| `attempts` | 实际发送的尝试数 | 含失败与无 usage 的请求；取消不计 |
| `unknownUsageAttempts` | 无 usage 的尝试数 | Token 保持未知，不填 0 |

费用上界（阶段 B 的硬上限依据）：

```text
input tokens ≤ 请求体字节数            （一个 token 至少 1 字节，字节数是安全上界）
output tokens ≤ 每次请求的 max output  （memory ≤ 8,192；session 批次 ≤ 8,000；final ≤ 16,000；
                                        OpenAI 推理模型另有 16,000 思考预留上限，但只按实际用量计费）
最大费用 = Σ(请求体字节 × 输入单价 / 1e6) + Σ(输出上限 × 输出单价 / 1e6)
```

该上界故意忽略缓存折扣，因此是保守上界；实际费用通常明显更低。Provider 的账单以官方为准，
本程序只能给“估算费用”或 Provider 自报费用。

---

## 5. 10 人与自适应 20 人批次的离线对照（结构层）

同一合成数据、同一 Mock 语义、同一 Provider 配置，仅观众上限不同：

| 数据 | 上限 | 请求 | 批次 | 输入 Token（模拟） | 输出 Token（模拟） | 请求字节 | 覆盖 | 事实 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 25 观众 / 200 消息 | 10 | 3 | 3 | 25,881 | 2,304 | 82,818 | 25/25 | 25 |
| 25 观众 / 200 消息 | 自适应 20 | 2 | 2 | 22,898 | 2,308 | 73,271 | 25/25 | 25 |
| 100 观众 / 1,000 消息 | 10 | 10 | 10 | 113,038 | 9,210 | 361,706 | 100/100 | 100 |
| 100 观众 / 1,000 消息 | 自适应 20 | 6 | 6 | 101,310 | 9,252 | 324,183 | 100/100 | 100 |

结论（仅结构层）：20 人上限在稀疏观众上减少 33–40% 请求、约 10% 输入字节，覆盖与事实数不变。
**这不等于语义质量不下降**；Mock 的事实是确定性生成，不能证明真实模型在更大批次里不漏写、
不串证据、不编造。语义结论必须等阶段 B 的盲评。

复现：

```bat
node scripts/ai-efficiency-baseline.mjs --only s1-small-25-viewers --viewer-cap 10 --label p03-cap10
node scripts/ai-efficiency-baseline.mjs --only s1-small-25-viewers --viewer-cap 20 --label p03-cap20
```

`--viewer-cap` 是 harness 注入的 runner 构造参数（只能收紧上限），不是 HTTP/配置/UI 开关。

---

## 6. 自动化测试（阶段 A）

| 文件 | 用例 | 覆盖 |
| --- | --- | --- |
| `tests/unit/ai-provider-compat.test.mjs` | 9 | 缓存写入字段、推理模型识别、OpenAI 参数形状、其他家族参数形状、思考预留、能力测试 `json_schema`、一次降级、无关 400 仍失败、自报费用分离 |
| `tests/integration/ai-provider-compat.test.mjs` | 3 | 真实 HTTP 路由首次测试即发 `json_schema` 并持久化；真实任务拒绝 Schema 后一次降级 + 契约回填 + usage 归因 + 持久化降级；10/20 上限同数据批次规划与覆盖 |

回归保证：既有 781 项测试在改动前全绿（2026-11-14，235,750 ms）；本轮新增 12 项后全量结果
见 `docs/STATUS.md` §0.27。

未覆盖（必须在阶段 B 或后续补）：真实 Provider 的 429/5xx/空响应/截断、真实
`json_schema` 大 Schema 接受度、真实缓存命中、真实费用、真实长期画像语义、真实 UI 点击。

---

## 7. 阶段 B 付费测试计划（待用户批准）

> **在用户明确批准前不会发送任何真实请求。** “以前填过 Key”不构成授权。

### 7.1 数据

- 默认：**合成数据**（`scripts/ai-efficiency-baseline.mjs` 同一生成器；语言可 zh-CN/ja/en）。
  不含真实观众身份、真实聊天或真实长期画像，隐私风险最低。
- 可选：用户明确授权的脱敏真实数据。只在该独立数据目录中使用，不写入报告原文。
- 所有测试使用 `tests/.tmp/paid-<timestamp>` 隔离目录；不读写生产数据库。

### 7.2 任务与预算（推荐 Plan A，硬上限 $1.25）

| 任务 | 数据 | 请求上界 | 输入字节上界 | 输出 Token 上界 | 说明 |
| --- | --- | --- | --- | --- | --- |
| T0 能力测试 | 3 位合成观众 | 5 | ~8 KB | 1,296 | 每个 Provider 一次；包含 text/json/session/memory |
| T1 单场 + 长期画像 | 80 观众 / 800 消息 | 9 | 502,675 | 80,960 | 3 个 session 批 + final + 5 个 memory 批 |
| T2 10 vs 20 语义对照 | 25 观众 / 200 消息 | 5 | 156,089 | 40,960 | 同一数据两份隔离副本，cap 10 与 20 各一次 |
| T3 规模验证（仅 20） | 100 观众 / 1,000 消息 | 6 | 324,183 | 49,152 | 覆盖/漏写/补答率，不做 A/B |
| T4 日语较长画像 | 60 观众 / 600 消息 | 4 | 357,913 | 32,768 | 输出语言 ja，检查是否无故回英语 |
| T5 Resume | 复用 T3 | 0 新增数据 | 0 | 0 | 中途暂停/重启，只处理剩余批次 |
| T7 正式 EXE | 同 T0 + T1 | 14 | 510,675 | 82,256 | EXE + 用户 UI 填 Key + 真实请求 |
| **合计上界** | | **43** | **1,859,535 B** | **287,392** | 不含最多 20% 重试余量 |

上界费用（按 2026-11-14 官方单价，忽略缓存折扣）：

| 模型 | 输入单价 | 输出单价 | 上界 | 预计实际 |
| --- | --- | --- | --- | --- |
| DeepSeek `deepseek-flash`（高峰） | $0.30/M | $1.20/M | **~$0.90** | ~$0.25–0.40 |
| DeepSeek `deepseek-flash`（非高峰） | $0.15/M | $0.60/M | ~$0.45 | ~$0.12–0.20 |
| Anthropic `claude-haiku-5.5`（≤100K 提示） | $0.10/M | $0.50/M | ~$0.33 | ~$0.08–0.15 |
| OpenAI `gpt-5-mini` | $0.25/M | $2.00/M | ~$1.04 | ~$0.30–0.50 |
| OpenAI `gpt-4.1-mini` | $0.40/M | $1.60/M | ~$1.20 | ~$0.35–0.55 |

Plan A 的 **$1.25** 硬上限覆盖上表任一单一模型；推荐 DeepSeek 或 Haiku 5.5。
Plan B（可选，$2.50）在 Plan A 基础上增加第二个 Provider 的 T0+T1 与 T3 的 cap10/cap20
对照；只有在 Plan A 结果正常且用户再次确认后才执行。

DeepSeek 高峰时段为 UTC 01:00–04:00 与 06:00–10:00（周一至周五），即北京时间
09:00–12:00 与 14:00–18:00；其他时间为非高峰半价。

**硬性停止**：harness 在请求数达到上表上界时立即取消任务；不使用无限重试。若用户批准的上限
低于上界，则按任务分批执行，每批完成后重新确认是否继续。

**费用上界无法做到逐分钱精确的原因**：真实 tokenizer 与估算不同、Provider 可能在失败请求上
计费、汇率与价格可能变化。因此用“请求字节 + 输出上限”给出保守上界；若需要绝对账单，只能以
Provider 控制台的账单为准。

### 7.3 模型与 Provider 选择

必须由用户明确选择，不默认用最贵模型、不自动遍历全部 Provider。建议：

| 方案 | Provider / 模型 | 理由 |
| --- | --- | --- |
| 推荐 | DeepSeek `deepseek-flash` | 便宜、1M 上下文、JSON Object、官方中文/日文友好；不适合 `json_schema` 路径 |
| 第二 | Anthropic `claude-haiku-5.5` | 便宜、Messages 协议、无 `response_format`，可验证纯提示词路径 |
| 第三 | OpenAI `gpt-5-mini` 或 `gpt-4.1-mini` | 验证 `json_schema` 与推理模型参数；稍贵 |

若只验证一个 Provider，只能声明该 Provider 通过；其余保持 L4。

### 7.4 语义质量评估（10 vs 20）

- 盲评：把 cap10 与 cap20 的事实合并、打乱观众顺序、去掉批次信息后人工逐条核对证据。
- 指标：覆盖率、长期画像生成率、有效事实数、事实准确性、证据是否来自正确观众、
  跨观众证据污染、重要事实遗漏、无证据推断、重复事实、Schema 失败、`MEMORY_VIEWER_UPDATE_MISSING`、
  `AI_IMPORT_INVALID`、补答率、平均耗时、实际 Token、实际费用。
- 不以模型自评作为唯一证据；每份画像至少有 1 条可人工核对的证据原文。
- 温度：程序发送 `temperature: 0`（推理模型不发送，使用默认值）；同一配置重复 2 次，
  记录 `seed` 是否可用（当前程序不发送 seed）。
- 判定：若 20 人批次的证据归属、事实准确性或补答率明显变差，停止 20 人默认策略，恢复
  `viewersPerBatchHard=10`（代码层回退点）。

### 7.5 Resume / 失败验收

- 真实付费只做**可控暂停/重启**的 Resume：暂停 → 停止进程 → 重启 → 继续；不故意制造
  大量 429/500。
- 429/500/空响应/截断/`length`/补答失败/跨观众证据用 Mock 验证（已有覆盖，阶段 B 复跑
  相关套件）。
- 检查：已完成批次不重发、已保存事实不丢、单批失败不丢整场、补答只处理缺失观众、
  Resume 只处理未完成部分、失败 usage 可归因、统计失败不阻断分析。

### 7.6 隐私

- 默认合成数据；不发真实聊天/观众身份/长期画像。
- 不记录 API Key、OAuth Token、Cookie、完整聊天正文；报告只含聚合数字与脱敏证据片段。
- 测试使用独立数据目录；不修改生产数据库；生成的分析包与数据库在测试后删除或保留在
  `tests/.tmp`（gitignore）。

---

## 8. 阶段 A 结论

- 代码级兼容性缺口已修复并有离线证据：结构化输出开关、format 降级、OpenAI 推理模型参数、
  缓存写入解析、Provider 自报费用。
- 7 个 Provider 全部达到 **L1+L2**；没有一个达到 **L3**。
- 真实付费 Provider、真实计费、真实长期画像语义、真实多语言与正式 EXE 真实请求均**未验证**。
- **P0-3 尚未完成，不得宣称通过。** 下一步是用户批准本文 §7 的方案与费用上限。
