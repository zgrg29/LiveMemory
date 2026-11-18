# 2026-11-18 OpenCode Provider 接入（P52）

## 目标

在 LiveMemory 现有 AI Provider 架构中新增 **OpenCode** 作为正式可选择的 AI 服务商。
约束：最小改动、最大复用；不重构 AI 系统；不新增运行时依赖；不伪造真实 API 验收；
本轮不 Push / Tag / Release。

## 1. 官方 API 调查（真实访问）

文档：

- <https://opencode.ai/docs/console/api>
- <https://opencode.ai/docs/console/api/inference/>
- <https://opencode.ai/docs/console/models/>
- <https://opencode.ai/docs/console/harnesses/>
- <https://opencode.ai/docs/console/go/>

2026-11-18 实测（本机 Node 22 原生 `fetch`，**无真实 API Key**）：

| 探针 | 结果 |
| --- | --- |
| `GET https://opencode.ai/inference/v1/models`（无 Key） | **200**，87 个 `type=chat` 模型 |
| 同上 + `Authorization: Bearer oc_sk_invalid` | **401** `authentication_error: Invalid credential`（带 Key 时会校验） |
| `POST https://opencode.ai/inference/openai/v1/chat/completions`（无效 Key） | **401**（路径存在） |
| `POST https://opencode.ai/inference/go/openai/v1/chat/completions`（无效 Key，**无** session 头） | **400** `MissingSessionID`，在鉴权之前 |
| 同上 + 任意非空 `x-opencode-session` | **401**（进入鉴权；session 值未做格式校验） |
| `POST https://opencode.ai/inference/anthropic/v1/messages`（无效 Key） | **401**（Anthropic 路径存在，本程序不使用） |

模型元数据形状（真实响应节选，已脱敏、无 Key）：

```json
{
  "id": "claude-sonnet-5-5",
  "object": "model",
  "name": "Claude Sonnet 5.5",
  "type": "chat",
  "limit": {"context": 1000000, "output": 128000},
  "capabilities": {"structured_output": false, "temperature": false},
  "cost": {
    "text": {
      "input": {"price": 2, "cache": {"read": 0.1, "write": 2.5}},
      "output": {"price": 10}
    }
  },
  "api": {"messages": {"base_url": "https://opencode.ai/inference/anthropic/v1"}}
}
```

`cost` 的单位与官方定价表一致（每 1M tokens、USD）。示例：Claude Sonnet 5.5 = 2 / 10，
缓存读取 0.1。**没有**把 `cost` 当作每条请求的账单；真实账单以 `usage.cost` 为准。

计费模式结论：

- Pay-as-you-go：通用 Console API，官方说明供 scripts/integrations 调用 → LiveMemory 可用。
- Go：独立 Base URL；官方要求稳定 `x-opencode-session`，定位为编码代理并监测滥用流量。
  LiveMemory 按要求发送自身 UA 与稳定 session id，**不伪装编码代理**；如平台限制此类流量
  则请求会失败，不绕过。两者用既有 Region 选择器区分，未新增套餐开关。

免费层：官方明确免费聊天模型只在 OpenCode 客户端内可用，其它客户端即使带 Key 也 403。
LiveMemory 不声称免费模型可用；界面价格显示 `$0` 只代表 Provider 报价，不代表可调用。

## 2. 实现（最小改动）

### 2.1 Provider 注册

`src/ai/providers/catalog.mjs`：

- `id: 'opencode'`，`protocol: 'openai'`，`docsUrl`，`keyHint: 'oc_sk_…'`；
- `supportsModelList: true`，`supportsStructuredOutputs: false`；
- `sessionHeader: 'x-opencode-session'`、`userAgent: 'LiveMemory'`；
- Region `payg` → `https://opencode.ai/inference/openai/v1`，
  models `https://opencode.ai/inference/v1/models`；
- Region `go` → `https://opencode.ai/inference/go/openai/v1`，
  models `https://opencode.ai/inference/go/v1/models`，`requiresSession: true`。

没有新增 UI 组件：Provider 下拉、Region 下拉、Base URL、API Key、模型列表、价格字段全部复用。

### 2.2 请求头与错误

`src/ai/providers/adapters.mjs`：

- 仅对目录声明的 Provider 追加头：
  `user-agent: LiveMemory/<APP_VERSION>`、`x-opencode-session: <stable id>`；
- Go Region 缺 session id → **不发起请求**，抛 `PROVIDER_CONFIG_INVALID`
  （detail `x-opencode-session-required`）；
- `MissingSessionID`（400）→ `PROVIDER_CONFIG_INVALID`，保留 Provider 文案到 detail；
- 401/403 仍为 `PROVIDER_AUTH_FAILED`，429/5xx 仍走既有重试；
- `stream_options.include_usage` 白名单加入 `opencode`（官方文档声明支持）；
- 模型列表 URL 使用 Region `modelsUrl`，不再假定 `baseUrl + /models`；
- OpenCode 模型条目解析 `cost` / `limit.context` / `capabilities.structured_output`，
  `type !== 'chat'` 不提供。

Header 不进入日志、attempt 记录、结果 JSON、配置 JSON 或 HTML；单测断言结果中不含 Key。

### 2.3 稳定 session（新增 `session.mjs`）

```text
ses_<sha256(scope parts) 前 32 位>
```

调用方：

| 场景 | 作用域 |
| --- | --- |
| 单场报告 / 长期画像 / 聚合 / 补答 / 自动重试 | `ai_jobs.id`（session 或 memory 子任务） |
| 报告阅读翻译 | `config.id + sessionId + targetLocale` |
| 能力检测 | `config + region + model + baseUrl + 检测开始时间` |
| 模型列表 | `provider + region + baseUrl`（非任务会话） |

`ai_jobs.id` 在暂停、重启、Resume 后保持不变，因此同一任务的分批与恢复复用同一 id；
不同任务、不同语言、不同能力检测互不共享。**没有新增数据库列。**

### 2.4 价格与 token

- `pricingFromOpenCodeModel()`：缺失 `cost` → `unknown`；`0/0` → `api_free`；其余 `paid`。
- 用户价格仍可选；不填不影响分析。
- `usage.cost` 由既有 `normalizeUsage` 识别为 `providerReportedCost`，与本地估算分开。
- `usage.opencode.tokens.*` 未解析（字段语义与 `prompt_tokens` 的关系未验证）；文档如实记录。

### 2.5 复用清单（未重复开发）

单场分析、长期画像、分批/自适应批次、结构化输出与降级、断点恢复、报告翻译、Token 统计、
费用估算、调度/429 退避、凭据加密、模型列表 UI、十语 i18n 全部沿用既有实现。

## 3. 测试（真实执行）

| 运行 | 结果 |
| --- | --- |
| `tests/unit/opencode-provider.test.mjs`（新增 12） | **12 passed / 0 failed** |
| `tests/integration/opencode-provider.test.mjs`（新增 3） | **3 passed / 0 failed** |
| 全量单元 | **856 passed / 0 failed / 0 skipped**（23,973 ms） |
| 全量单元 + 集成 | **1,241 passed / 0 failed / 0 skipped**（328,824 ms，`--test-isolation=none`） |
| `node scripts/check-docs.mjs` | 见下方结果 |

新增测试覆盖：

- Provider 目录、两个 Region、官方 Endpoint、`publicCatalog` 不含密钥；
- Bearer、`User-Agent`、`x-opencode-session`（普通 / 流式 / Anthropic 适配器）；
- Go 缺 session 头在请求前失败；payg 不强制；
- `MissingSessionID` → 配置错误并保留 Provider 文案；
- 模型列表 URL（payg / go）、价格、上下文、结构化能力、非 chat 过滤；
- 重试与“重启 + Resume”复用同一 session；
- 两个并行分析得到两个不同 session，互不干扰；
- `usage.cost` 归一为 `providerReportedCost`；
- session id 确定性与任务隔离。

全量运行说明（如实记录）：

- 首轮 1 个失败：`tests/integration/memory-privacy.test.mjs` 的 30 天保留断言。
  根因是测试夹具用真实 `received_at`（今天）却用合成 `now=T0+40d`，随日历日期必然失败；
  已把该测试的 `events.received_at` 固定到合成时间线，属于**测试夹具去时间依赖**，不是产品缺陷。
- 次轮 1 个失败：`tests/integration/ai-memory-output-recovery.test.mjs` 的批次计数；
  单跑 **8/8** 通过，且该文件在既有 STATUS 中已记录为偶发时序抖动；未改断言。
- 第三轮全量 **1,241/1,241** 通过。

## 4. 文档与文案

- 十语字典：只修改 `ai.v13.providers.desc` 与 `help.sections.providers.step2` 的值，
  加入 OpenCode；**键数仍 2,351，占位符不变**。
- README 三语：AI Provider 列表加入 OpenCode（pay-as-you-go / Go）。
- `docs/AI_PROVIDER_COMPATIBILITY.md`：矩阵新增行 + §2.1 完整事实、实现与限制。
- `docs/AI_CONTRACT.md` §1 / §28：Provider 列表、参数形状、session 说明。
- `docs/AI_RELIABILITY.md`：SSE/usage 表加入 OpenCode。
- `docs/i18n/GLOSSARY.md`：品牌列表加入 OpenCode。
- STATUS / HANDOFF / ROADMAP / CHANGELOG / TEST_PLAN 同步。

## 5. Windows EXE

构建与验收结果记录于 `docs/STATUS.md` §0.61.5。**未 Push、未 Tag、未 Release。**

## 6. 未完成 / 限制

- **没有真实 OpenCode API Key**：没有任何真实推理请求；真实 200/429/5xx、真实模型输出、
  真实账单、真实 `usage.cost` 全部待办。不得写成“真实通过”。
- 免费层模型第三方 403。
- `json_schema` 未声明；Claude 等模型的 `temperature: false` 兼容性未验证。
- Go 面向编码代理的定位与流量监测：LiveMemory 不伪装；如被限制则如实失败。
- 真实双击 UAC、干净 Windows 账户仍未人工验证。
