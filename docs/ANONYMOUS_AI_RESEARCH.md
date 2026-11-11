# 匿名免费 AI 接口实测报告

版本：0.12.0 开发轮 · 测试日期：2026-11-10（UTC，开发机本地时间 2026-11-11 +08:00）
测试环境：Windows 本地开发机，Node.js **v24.21.0**，出站 HTTPS 可用；未使用任何 API Key、登录 Cookie、代理或账号池。

> **历史文档（v0.13.1）**：匿名免费 AI 入口与 `src/ai/auto/` 已删除；本报告仅保留当时的真实请求、失败候选与限流证据，不代表当前产品能力。当前只支持用户自备 API Key。
>
> 本报告只记录**实际发出的网络请求**与官方文档。HTTP 200 不等于可用；只有通过 LiveMemory 真实分析包校验的结果才算通过。
> 未通过验证的服务没有被加入自动切换列表。

---

## 1. 结论摘要

| 服务 | 匿名可用 | 实际模型 | JSON 合格率（实测） | 速度 | 限制 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| **OVHcloud AI Endpoints** | ✅ 是（官方文档 + 实测） | `gpt-oss-20b` | 基础 JSON 2/2；真实 LiveMemory 包 3/3（含 3/3 观众语义记忆） | 2–22 秒/请求（本机） | 匿名 **2 请求/分钟/IP/模型**；请求体 2 MB；131k 上下文；输出预算需 ≥8k | **采用为唯一正式接口** |
| Murakumo | ⚠️ 文档允许，但实测不可用 | 文档标 `murakumo/free` / `mishima` | 0/1（未拿到有效回答） | 1–181 秒后失败 | 免费池 429；`mishima` 冷启动 180 秒后仍 `fleet_capacity_unavailable` | **不集成** |
| llmfaucet | ❌ 端点不存在 | — | — | — | 域名 NXDOMAIN | **不集成** |
| LLM7.io | ⚠️ 无 Key 请求可返回 200，但官方要求 Token | `gpt-oss:20b` / `mistral-Nemo-Instruct-2407` | 未继续（授权不明确） | 0.5 秒 | 官方 README 要求 `dash.llm7.io` 免费 Token；匿名第三方授权未确认 | **不集成** |
| Pollinations（额外调查） | ✅ 匿名层存在 | `openai-fast`（GPT-OSS 20B） | 基础 JSON/多语言 2/2；真实 LiveMemory 包 0/1（HTTP 400） | 0.8–101 秒 | 真实分析包被拒；未确认原因 | **不集成** |

**最终选择：OVHcloud AI Endpoints `gpt-oss-20b`，无 Key、无账号、无开发者服务器。**
由于没有第二个通过真实 LiveMemory 包检验的匿名服务，本轮不启用“多服务自动切换”；失败时按产品要求显示红色提示并保留手动流程。

---

## 2. 测试原则与边界

- 每个候选先看官网/官方仓库，再发真实请求；不根据 README 猜测接口路径。
- 不使用破解、盗用 Token、绕过验证码、模拟登录会话或未授权内部接口。
- 控制请求量：单个小请求优先；不在公共免费服务上做压力测试。
- 不把模拟响应当作 API 成功；本报告中的“通过”均附真实 HTTP 状态、模型返回内容或 LiveMemory 校验结果。
- 不记录聊天正文到仓库；测试数据为合成直播数据。

---

## 3. 候选 A：Murakumo

### 3.1 官方信息

- 网站：<https://murakumo.cloud/free>（HTTP 200）
- 文档：<https://murakumo.cloud/docs>（HTTP 200）
- 文档明确写明：无需账号、无需 API Key，未认证请求是受支持的使用方式；OpenAI-compatible；免费模型 `murakumo/free`。
- `/v1/models` 返回 `murakumo/free`：`context_window=131072`、`max_output_tokens=32768`、`is_ready=true`；路由为 OpenRouter 免费模型 + `fallback:mishima`。

### 3.2 实际请求

| 时间（UTC） | 请求 | 结果 |
| --- | --- | --- |
| 16:19:05 | `GET https://api.murakumo.cloud/ready` | **503**；`inference.ok=false`、`gateways-ready=0`、`degraded=["fleet-model-unavailable"]` |
| 16:19 左右 | `POST /v1/chat/completions`，`murakumo/free`，`max_tokens=32` | **502**，1.2 秒；`x-murakumo-free-fallback-reason: openrouter-429`；`mishima_unreachable` / `destination_unavailable` |
| 稍后 | 同一接口重试 | **502**；`openrouter-free-cooldown-until=2026-11-10T16:20:26Z`，仍回退 `mishima` 并失败 |
| 稍后 | `mishima` 直连，120 秒超时 | **TimeoutError**（客户端 120 秒） |
| 稍后 | `mishima` 直连，420 秒上限 | **503**，181 秒后返回；`retry-after: 5`、`x-murakumo-admission-wait-ms: 180023`、`fleet_capacity_unavailable`、`executed=false` |

### 3.3 结论

- 文档层面**允许匿名访问**，但测试期间免费池没有可用容量，连最小请求都无法完成。
- 未获得任何真实模型输出，因此无法评估 JSON 质量、多语言或 LiveMemory Schema。
- **不加入自动分析列表**。如果未来容量恢复，必须重新执行完整 LiveMemory 包测试后才能进入候选。

---

## 4. 候选 B：llmfaucet

### 4.1 官方信息

- GitHub：<https://github.com/llmfaucet/llmfaucet>（HTTP 200）
- README 描述：公共 OpenAI-compatible 网关，匿名层 `Authorization: Bearer free`，20 请求/天/IP。

### 4.2 实际请求

| 请求 | 结果 |
| --- | --- |
| `GET https://llmfaucet.dev/` | **DNS ENOTFOUND** |
| `GET https://api.llmfaucet.dev/v1/models` | **DNS ENOTFOUND** |
| Google Public DNS (`dns.google`) | **Status 3 / NXDOMAIN** |
| Cloudflare DoH (`cloudflare-dns.com`) | **Status 3 / NXDOMAIN** |

### 4.3 结论

- 仓库仍可访问，但生产域名在本地、Google DNS 与 Cloudflare DNS 均不存在。
- 没有发出任何推理请求，也没有获得任何模型回答。
- **不集成**；不能把“GitHub 仓库存在”当作服务可用。

---

## 5. 候选 C：OVHcloud AI Endpoints（最终采用）

### 5.1 官方信息

用户给出的 `https://endpoints.ai.cloud.ovh.net/v1` 实际是**产品网站**，不是推理 API。官方文档给出的真实 Base URL 是：

```text
https://oai.endpoints.kepler.ai.cloud.ovh.net/v1
```

- 文档：<https://docs.ovhcloud.com/en/guides/public-cloud/ai-machine-learning/ai-endpoints-getting-started.md>
- 能力与限制：<https://docs.ovhcloud.com/en/guides/public-cloud/ai-machine-learning/ai-endpoints-capabilities.md>
- Catalog API：<https://catalog.endpoints.ai.ovh.net/rest/v1/models_v2>
- 官方明确写明：
  - OpenAI-compatible；
  - **Anonymous: 2 requests per minute, per IP and per model**；
  - 请求体一般 2 MB 上限；
  - 支持 JSON Mode 与 Structured Outputs；
  - `gpt-oss-20b`：上下文 131k、最大输出 131k、`response_format` 支持 `json_object` / `json_schema`；
  - 文档声明数据不存储、基础设施位于欧洲（本次只引用官方说明，不替代法律判断）。

### 5.2 实际请求

所有请求均无 `Authorization`、无 Cookie、无自定义身份信息；只发 `content-type`、`accept`、`user-agent: LiveMemory/AutoAnalysis`。

| # | 测试 | 请求 | 结果 |
| --- | --- | --- | --- |
| 1 | 基础连通性 | `gpt-oss-20b`，`max_tokens=16` | **200**，2.5 秒；返回真实 `chat.completion`；`x-ratelimit-limit-minute: 2` |
| 2 | JSON Mode + 多语言 | 中/日/英混合，要求 JSON 对象 | **200**，4.3 秒；`content` 为合法 JSON，语言识别 `zh/ja/en` 正确 |
| 3 | 真实 LiveMemory 包（早期探针） | 3 位观众、12 条消息、真实 `instructions.md` + Schema | **200**，41 秒；`finish_reason=stop`；Schema 校验通过；3/3 观众生成语义事实 |
| 4 | 真实 LiveMemory 包（最终 Runner） | 3 位观众、9 条消息、统一分析包 | **200**，约 14 秒；Runner 自动创建任务、调用、校验、导入；`status=complete`、`memoryCoverage.semantic=3`、`source=auto` |
| 5 | 真实长期记忆连续性 | 先建立“在学画画”，下一场说“最近不怎么画画了，开始学吉他” | 见 §8（真实结果） |

**真实 Runner 输出（2026-11-10T16:41:35Z – 16:41:49Z）：**

提示词还额外列出了每位观众允许引用的 `viewer_excerpts` seq，并要求状态变化使用
`supersede`/`update` 旧事实；这是从早期失败样本中得到的加固，不改变 Schema 或验证器。

```text
status=complete
batchTotal=1
memoryCoverage.total=3
memoryCoverage.semantic=3
memoryCoverage.no_semantics=0
memoryCoverage.complete=true
lastProvider=ovh-gpt-oss-20b
source=auto
```

写入的真实语义事实：

```text
youtube:UC_REAL_0  interest  水彩   "最近在学水彩，画了猫"      stated  evidence=[4]
youtube:UC_REAL_1  interest  爵士乐 "I love jazz..."            stated  evidence=[5]
youtube:UC_REAL_2  life_event 旅行  "我下个月要去旅行"          stated  evidence=[3]
```

### 5.3 输出预算的重要发现

一次使用 `max_tokens≈3040` 的 Runner 请求返回了不可用结果（校验失败 / 非法 JSON），而同一提示在 `max_tokens=8000` 下通过。原因是推理模型会把输出预算的一部分用于 `reasoning`，过小预算可能截断 JSON。

最终实现：

- 批次请求 `max_tokens` 最低 **8000**，随观众数增长，最高 12000；
- 汇总请求 8000；
- 仍保留一次修复请求与 Schema 校验，不因提高预算而放松校验。

### 5.4 限制与风险（如实）

- 匿名层 **2 请求/分钟/IP/模型**。多批次任务必须串行并等待；本实现使用 2/60s 滑动窗口限流，尊重 `Retry-After`。
- 免费服务可能随时限流、变慢或下线；失败时产品显示统一红色提示并保留手动流程。
- 文档声明“数据不存储”，但第三方处理仍取决于其隐私政策与路由；软件首次使用会明确告知用户并请求确认。
- 单次分析规模受上下文与输出预算限制；本实现最多 12 个自动批次，超出时明确报错，不静默截断。

---

## 6. 候选 D：LLM7.io

### 6.1 官方信息

- 网站：<https://llm7.io/>（HTTP 200，页面内容很少）
- GitHub：<https://github.com/chigwell/llm7.io>
- README 明确写：**Token-required access**；免费 Token 需在 `https://dash.llm7.io` 获取。
- `/v1/models` 返回 68 个模型，tier 为 `pro`（65）与 `turbo`（3），没有看到 `free` tier 的匿名模型说明。

### 6.2 实际请求

| 请求 | 结果 |
| --- | --- |
| `POST /v1/chat/completions`，`gpt-4o-mini`，无 Key | **400** `model_unavailable` |
| `POST /v1/chat/completions`，`gpt-oss:20b`，无 Key | **200**，但只返回 `reasoning`，`content` 为空（`finish_reason=length`） |
| `POST /v1/chat/completions`，`mistral-Nemo-Instruct-2407`，无 Key | **200**，返回 `OK` |

### 6.3 结论

- 无 Key 的 HTTP 请求确实能返回 200，但官方文档要求免费 Token；匿名第三方软件是否被授权使用**无法从官方文档确认**。
- 按任务规则，不能把“技术上有响应”当作“允许第三方调用”。
- **不集成**。若未来官方明确匿名层条款，需重新做完整 LiveMemory 包测试。

---

## 7. 额外调查：Pollinations

- 官网/模型列表：`https://text.pollinations.ai/models` 返回 `openai-fast`，`tier: "anonymous"`。
- 基础测试：`POST https://text.pollinations.ai/openai`，无 Key，返回 200；JSON Mode 与中/日/英混合测试通过。
- 真实 LiveMemory 包：同一套 `buildBatchPrompt` 与 Schema，返回 **HTTP 400**（101 秒），没有拿到可校验内容。
- 结论：基础能力可用，但**未通过真实 LiveMemory 包**；不加入自动切换列表。

---

## 8. 真实长期记忆连续性测试

> 本节在开发机上以同一匿名接口连续执行两场合成直播，验证“已有记忆 → 新信息 → 证据 → 合并”。

（测试结果见下方“实测结果”小节；若该请求失败，本节必须如实写“阻塞/失败”，不能声称通过。）

### 实测结果

- 第一场：观众 `youtube:UC_MEM_REAL_0` 说「我最近在学画画」。
  - 自动分析完成（`source=auto`，`semantic=1`）；写入 `interest / 画画` 事实，`certainty=stated`，证据指向该观众的消息 seq。
  - 事实 id `mfc_01M735G0CKTPRCJVZH7D`，状态 `active`。
- 第二场：同一观众说「最近不怎么画画了，开始学吉他」。
  - 自动分析完成（`semantic=1`，memory version 2）。
  - 结果使用 **`supersede`** 处理旧事实：`mfc_01M735G0CKTPRCJVZH7D`（“我最近在学画画”）状态变为 `superseded`；
  - 新增“最近不怎么画画了”与“开始学吉他”两条 `stated` 事实，均带该观众的证据；
  - **没有**把旧事实删除，也没有把推断直接升为事实。

结论：在加入“状态变化必须 supersede/update 旧事实”的自动提示词规则后，真实模型能够完成跨场次长期记忆的增量更新。此结论只代表这次合成样本，不代表所有模型/所有输入都稳定。

---

## 9. 未验证 / 阻塞

- Murakumo 在测试期间不可用，未获得任何真实回答；未来恢复后需重新测试。
- LLM7.io 的匿名授权无法确认；未做完整 LiveMemory 包测试。
- Pollinations 真实包返回 HTTP 400；未继续排查其服务端限制。
- 未测试真实 Windows EXE 下的出站请求；本轮构建了 `dist/LiveMemory.exe`（91.2 MB，
  requireAdministrator，SHA-256 `342294c…`），但本机直接运行被 Windows 以“需要提升”拒绝，
  未能执行 `--version`、启动服务或验证打包后的出站请求。
- 未在真实 Bilibili/YouTube 大场（数千观众）上执行自动分析；只用合成数据与 3 位观众的真实 API 包验证了正确性。

---

## 10. 请求与日志安全

- 请求只包含当前分析包的聊天、观众上下文、已有记忆与 Schema；
- 不包含数据库文件、Cookie、Token、API Key、操作系统账户信息或不相关的历史直播；
- 不记录提示词或模型回答到日志；只记录 provider id、HTTP 状态、批次号、错误码与耗时；
- 模型返回内容一律作为不可信外部输入，经 Schema + 业务校验 + 事务导入后才写入本地数据库。

---

## 11. v0.12.1 真实故障复测（2026-11-11）

复测对象为真实用户样本：YouTube 日语直播 `ses_01M747HW1DH5GT9R308A`，99 条聊天 +
1 条 Super Sticker，52 位稳定观众，录制约 51 秒，初始 `viewer_memories=0`。
数据库与分析包从用户数据目录复制到 `tests/.tmp`，原始数据库未修改。所有请求仍是无
`Authorization`、无 Cookie 的官方匿名接口，遵守 2 请求/分钟；没有做压力测试。

### 11.1 修复前：自动批次 1（25 观众）

| 项 | 结果 |
| --- | --- |
| 请求 | `gpt-oss-20b`，`response_format=json_object`，`max_tokens=9250`，`reasoning_effort=low` |
| HTTP / 耗时 | 200 / 169.5 秒 |
| usage | `prompt_tokens=44682`，`completion_tokens=9250` |
| `finish_reason` | **length** |
| 内容 | 35,526 字符，尾部反复出现 `"viewer_profiles","viewer_memory_updates","session_topics"`；JSON 不完整 |

同一真实包改为 `response_format=json_schema`（紧凑回答尚未启用）：HTTP 200，72 秒，
`finish_reason=stop`，`completion_tokens=2014`，JSON 有效；但模型把 2 位**其他批次**
的观众写入 `viewer_memory_updates`，漏掉 2 位本批观众，产生
`MEMORY_VIEWER_UNKNOWN` ×2 + `MEMORY_VIEWER_UPDATE_MISSING` ×2。

### 11.2 修复后：紧凑格式真实单批

| 批次 | 观众 | 提示词估算 | 耗时 | completion | 结果 |
| --- | --- | --- | --- | --- | --- |
| v10 batch 1 | 10 | 19,632 | 14.4 秒 | 489 | 10/10 refs，`previewOk=true` |
| v25 batch 1 | 25 | 29,464 | 20.4 秒 | 751 | 25/25 refs，`previewOk=true` |

两次均 `finish_reason=stop`、无退化、无未知/缺失观众。25 位在紧凑格式下也能通过；
最终仍选择 10 位/批，是为输出预算与语义质量保留余量（代价是请求数增加）。

定向补充也做了真实单次请求：只发送 ref 3 的 memory + 摘录，schema 仅要求 `viewers`；
2.9 秒返回 `{"viewers":[{"ref":3,"memory":{"no_new_information":true,"operations":[]}}]}`，
无 `session_topics`、无其他 ref，证明该路径可用且不会重新生成整批。

### 11.3 修复后：52 位观众完整自动运行

- 6 个批次 + 1 个汇总，全部真实 OVH 请求；批次阶段约 159 秒（含 2/分钟限流等待），
  汇总约 22 秒；任务 `complete`。
- `memoryCoverage.total=52`、`no_semantics=52`、`missing_update=0`、`complete=true`；
  `source=auto` 结果 7 条（`batch:1`–`batch:6` + `final`）；52 个 `viewer_memories` 头。
- 该场聊天只有问候、表情和短句，没有可支持长期事实的第一人称陈述；`semantic=0` 是
  正确结果，程序没有为了“看起来有记忆”而编造事实。
- 汇总摘要与 topics/highlights 生成成功。首次汇总在旧的 8,000 输出预算 + `json_object`
  下截断；改用汇总 structured output + 12,000 预算后通过。汇总文本曾把聊天回溯时间
  说成“6 分钟”，本轮已加入 `session.duration_seconds` 与提示词规则，但未用新包复测。

### 11.4 手动模式真实 52 人单包

- 使用新 `lm-prompt-m6.3-ja` 包（slim memory_context + evidence_seqs）发送给 OVH
  `gpt-oss-20b`，`json_schema` 完整结果 Schema，`max_tokens=12000`。
- 96.5 秒，`prompt_tokens=75516`，`completion_tokens=2907`，`finish_reason=stop`；
  返回 49 条 `viewer_memory_updates`、5 个 profiles、1 个 topic。
- 3 位观众缺失（`@TKNG-k6r`、`@球磨川禊-m9h`、`@ゎなぉ`），1 个 profile ID 不属于本批。
  验证器正确阻塞；界面现在会列出这 3 位观众并提供修复指令。
- 该结果说明：手动路径仍依赖用户选择的模型；OVH gpt-oss-20b 在 52 人单包下不能稳定
  一次覆盖。正确的 52/52 JSON 可正常导入（集成测试），用户实际使用的模型仍未确认，
  不能把本结果等同于用户当时的 AI。

### 11.5 结论

- **自动模式在真实 52 观众/99 消息场景通过**；这是本轮修复的核心验收。
- 25 位单批本身不是根本原因；根因是要求模型复制/管理身份，以及 `json_object` 下的
  输出退化。紧凑 ref + structured output 同时消除了这两个问题。
- 手动模式的身份校验仍然严格；修复的是提示词矛盾、包体重复和错误可操作性，而不是
  放宽 Schema。
