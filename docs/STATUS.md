# 工程状态（STATUS）

最后更新：2026-11-11（v0.13.0：单场分析 / 长期画像解耦、多 Provider API、付费画像权限）

> 本文件是唯一进度来源。只要代码与本文不一致，以代码与实测为准，并立即修正本文。

## 1. 当前阶段

- 里程碑：**M0 / M1 / M2 核心 / P0–P9 / M6 / M7 / v0.13 AI 架构重构完成**；M3 真实接入继续验证；M4 部分完成；M5 未完成
- 版本：`0.13.0`（`package.json` 与 `src/shared/app-info.mjs` 一致）
- 数据库 schema：**13**（迁移 13：AI 任务模式 / Provider 快照 / 能力检测审计）
- 分析结果 Schema：**1.3.0**（新单场/画像任务）；旧 1.0.0–1.2.0 仍可导入；提示词：`lm-prompt-v13-session-<locale>`、`lm-prompt-v13-memory-<locale>`、旧 `lm-prompt-m6.3-<locale>`
- 分支：`main`，本地提交，未 Push
- 发布形态：`LiveMemory.exe`，RT_MANIFEST **requireAdministrator**（v0.13.0 已构建，未运行验收）

## 0. v0.13.0 本轮完成（2026-11-11）

### 0.1 权限与任务拆分

| 模式 | 入口 | 允许内容 | 权限边界 |
| --- | --- | --- | --- |
| 手动 AI | 导出单场包 → 任意 AI → 导入 | 单场总结/话题/情绪/互动/精彩片段/建议 | 不需要 Key；禁止 `viewer_memory_updates` |
| 匿名免费 AI | OVHcloud `gpt-oss-20b` | 单场报告 | 实验性；限流/超时/格式失败独立显示；不自动切换付费 |
| API Key 免费模型 | 用户配置的 `api_free` 模型 | 单场报告 | 即使有 Key 也不解锁长期画像 |
| 付费模型 | 已配置且通过能力验证 | 单场 + 长期画像 | 必须付费状态、价格已知、用户明确 opt-in、预算/确认 |

- 新增 `session` 与 `memory` 两种独立任务；`both` 先保存单场报告，再执行画像。单场失败不影响画像，画像失败不覆盖单场报告。
- 手动单场包不再包含 `memory_context.json`、`viewer_excerpts.jsonl`、全量 `viewer_context.json`，也不要求 `viewer_profiles` / `viewer_memory_updates`。
- 旧 `combined` 任务/结果保留读取；历史报告仍可打开；旧长期画像不删除。

### 0.2 多 Provider

- 正式 Provider：OpenAI、Anthropic、DeepSeek、MiniMax（cn/intl）、阿里云百炼（cn-beijing/singapore/us/hongkong）、OpenRouter、自定义 OpenAI-compatible。
- Anthropic 使用独立 `/v1/messages` 适配器（`x-api-key`、`anthropic-version`、system 分离）；其余使用 OpenAI Chat Completions。
- OpenRouter：官方 `/models` 动态模型列表；已真实请求返回 469 个模型，其中 15 个免费、396 个声明 structured output。价格/上下文来自官方字段，不虚构。
- 区域独立配置：切换 region/base URL 会生成新 credential reference 并要求重新输入 Key，旧区域 Key 不复用。
- 自定义 URL 阻止云元数据、私网、localhost（除非显式 `allowLocalNetwork`）；请求前做 DNS 私网解析检查。

### 0.3 能力、费用与预算

- 能力检测层级：network → auth → text → json → session → memory；只有 memory 探针通过（多观众 ref、证据归属、零发言、多语言）才写 `capabilities.memory=true`。
- OpenRouter 价格按官方 `pricing.prompt/completion` 换算；未知价格保持 unknown，不按 Provider 名称推断。
- 费用未知/付费模型请求前必须 `confirmBilling`；长期画像另需 `optInMemory`、付费状态、价格与能力验证。
- 单任务预算：请求前估算、请求后累计 usage；达到上限停止后续请求；不自动切换到更贵模型。
- 能力检测结果写入配置并追加 `ai_provider_tests` 审计表（provider/region/model/time/type）。

### 0.4 手动单场

- `POST /api/ai/jobs {analysisMode:'session'}` 生成一个 `stage=session` 包，不含长期记忆文件。
- 导入只接受 `schema_version=1.3.0`、`analysis_scope=session`；`viewer_memory_updates` 非空直接拒绝。
- `POST /api/ai/import` 仍支持文件与粘贴；单场任务导入不触发任何长期记忆写入。

### 0.5 UI

- AI 分析中心：分析方式（手动/匿名/API）、内容（单场/画像/两者）、配置选择、价格状态、预算、付费确认、长期画像 opt-in。
- 设置页新增 Provider 配置卡：Provider/区域/Base URL/Key/模型/官方模型列表/价格/默认/能力检测/删除。
- 运行状态显示 provider/model/pricing/阶段/批次/单场报告状态/长期画像状态；暂停、继续、取消。
- 三语完整键（zh-CN / ja / en），无新增硬编码可见文案。

### 0.6 真实验证（本轮）

- OpenRouter `/api/v1/models`：真实返回 **469** 个模型，15 个 `pricing=0` 免费模型，396 个声明 structured output（2026-11-11）。
- 其他 Provider 的真实生成请求：**阻塞**（无可用 API Key，未伪造成功）。
- 匿名 OVHcloud 生成：本轮未重新发起（v0.12.1 真实 52 观众样本记录保留）。
- 无真实浏览器渲染/截图验收；本机策略仍阻止无头浏览器。UI 只做静态/HTTP 覆盖。
- v0.13.0 EXE 已构建（91.5 MB / 166 assets / requireAdministrator），但 **未能运行**（UAC 拒绝）。

### 0.7 测试（本轮实测）

- 全量测试：**561 passed / 0 failed**（约 73 秒，2026-11-11，`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`）。
- 新增覆盖：Provider catalog/price/URL/credential store/Anthropic+OpenAI adapter/OpenRouter model list；单场任务导入；memory-only 任务；52 观众 6 批部分导入恢复；免费/付费权限门；预算阻断；API runner mock 单场与画像。

## 0.1 v0.12.1（历史）真实故障修复（2026-11-11）

### 0.1 真实故障与确认根因

真实样本：YouTube 日语直播 `ses_01M747HW1DH5GT9R308A`，99 条聊天 + 1 条 Super Sticker，
52 位稳定观众，录制约 51 秒，初始长期记忆为空。真实数据包和数据库从用户数据目录复制到
`tests/.tmp` 后离线分析（未修改用户数据库）。

**故障 A（自动分析）已确认根因：**

1. `response_format=json_object` + 约 44.7k 提示词 + 9,250 输出预算，在真实 25 观众批次上
   触发 gpt-oss-20b 的字段名重复退化：`finish_reason=length`、`completion_tokens=9250`、
   内容末尾反复出现 `"viewer_profiles","viewer_memory_updates","session_topics"`，JSON 不完整。
   一次“修复”请求再次发送同样的巨大提示词和退化内容，仍然失败。
2. 自动批次 `viewer_context.json` 包含属于其他记忆批次的观众（实测 batch 1：32 位 context，
   只有 25 位 memory target；batch 3：23 vs 5）。真实 structured-output 复现中，模型正确
   输出了 25 条，却把 2 位**其他批次**的观众写进 `viewer_memory_updates`，同时漏掉 2 位
   本批观众 → `MEMORY_VIEWER_UNKNOWN` ×2 + `MEMORY_VIEWER_UPDATE_MISSING` ×2。
3. 原来的客户端不读取 `finish_reason`/usage，无法区分截断、退化与普通 Schema 错误。

**故障 B（手动导入）已确认根因：**

1. 三语提示词都包含矛盾句“不要输出观众身份字段”，而同一份说明又要求每位观众必须有一条
   带 `viewer_id` 的 `viewer_memory_updates`；日语版更直接写成“視聴者 ID を出力しないでください”。
2. 52 位观众的包要求模型机械复制 52 个不透明 `youtube:UC...` ID；`memory_context.json`
   （67.6 KB）与 `viewer_context.json`（62.2 KB）大量重复；只有 Super Sticker、没有聊天
   发言的观众没有明确规则。
3. 真实 52 观众包用 OVH gpt-oss-20b 复测：新提示词下返回 49/52 条更新（3 位缺失），
   证明“模型会漏观众”是可复现的模型行为；正确覆盖 52 位的 JSON 可以正常导入。
   手动使用的具体模型仍未确认，不能把 OVH 结果等同于用户当时的模型。

### 0.2 修复内容

- 自动模式改为**紧凑回答 + 本地组装**：模型只返回 `session_topics` 和 `viewers[].ref`，
  不输出、也不能提供 `viewer_id`；本地按批次分配表把 ref 映射回稳定 ID，组装成完整
  Schema 1.2.0 结果，再走原有 `validateAnalysisImport()` + `importAnalysisResult()`。
- 自动请求改用 `json_schema` structured output；记录 `finish_reason` / usage / 退化检测；
  `length` → `AUTO_OUTPUT_TRUNCATED`。
- 缺少 ref 时执行一次**有界定向补充**（只发送缺失观众及其摘录）；仍缺失则
  `AUTO_VIEWER_COVERAGE_INCOMPLETE`，不写入任何结果。不会由程序替模型认定“无新信息”。
- 自动批次 25→**10 位/批**，批次上限 12→**30**（仍支持原 300 位观众）；汇总阶段也用
  structured output，并强制 `viewer_memory_updates: []`；汇总输出预算 12,000。
- `memory_context.viewers[]` 新增 `evidence_seqs`、`zero_excerpt`，去掉与 `viewer_context`
  重复的累计字段；手动提示词删除矛盾句，明确“原样复制 viewer_id”、零发言观众、
  `viewer_context` 中非本批观众不得写入。
- 导入预览新增 `target.memory.gaps`（missing/unknown/duplicate，含昵称）；界面显示缺失
  观众并新增「复制修复指令」，绝不自动改 ID。

### 0.3 真实验证（本轮实测）

- 自动、真实 OVH：52 位观众 / 99 条消息 / 6 批 + 汇总 → **complete**，
  `memoryCoverage.total=52`、`no_semantics=52`、`missing_update=0`、`complete=true`，
  7 条结果（batch:1–6 + final），52 个 `viewer_memories` 头。
- 单批真实对照：10 位观众 10/10、14.4 秒、489 completion tokens；25 位观众 25/25、
  20.4 秒、751 completion tokens（证明 25 位在紧凑格式下也可用；选择 10 位是为输出预算
  与语义质量留余量，代价是请求数增加）。
- 手动、真实 OVH 52 观众：49/52 + 3 位缺失，错误定位到具体观众；正确 52/52 JSON
  通过导入（见 `tests/integration/manual-52-viewers.test.mjs`）。
- 定向补充真实单次请求：只发 ref 3，2.9 秒返回仅含 `viewers` 的 1 条记录，
  无 `session_topics`、无其他 ref。
- 全量测试：**见 §3 的本轮结果**（`node --test --test-isolation=none ...`）。

### 0.4 本轮未验证 / 残余风险

- 用户手动分析时实际使用的模型/服务未知；OVH gpt-oss-20b 在 52 观众单包下仍会漏 3 位。
  现在界面会精确列出缺失观众并可复制修复指令，但不能保证任意模型一次覆盖 52 位。
- 自动 25 位单批只做了单次真实样本；10 位/批的完整 52 位真实运行已通过。
- 100 位低活跃观众、空档案、已有记忆更新、多批隔离、错误 ID、截断、429/超时/5xx
  已有 Mock/本地测试；未对免费接口做高频压力测试。
- 真实浏览器 UI（复制修复按钮、gaps 列表、暗色、390px）未在本机无头浏览器验收。
- 本轮未重新构建/运行 Windows EXE；v0.12.0 的 EXE 仍未运行验收。


## 1.1 本轮完成（2026-11-11，v0.12.0，P9 自动 AI 分析）

### 1.1.1 真实接口调查（先测试，再集成）

完整报告见 `docs/ANONYMOUS_AI_RESEARCH.md`。结论：

- **OVHcloud AI Endpoints**（官方文档 + 真实请求）是唯一通过完整 LiveMemory 包检验的匿名接口：
  - Base URL `https://oai.endpoints.kepler.ai.cloud.ovh.net/v1`，模型 `gpt-oss-20b`；
  - 匿名 **2 请求/分钟/IP/模型**，131k 上下文，JSON Mode；
  - 真实 3 观众包：`status=complete`、`memoryCoverage.semantic=3`、`source=auto`，证据 seq 正确。
- **Murakumo**：官方匿名说明存在，但实测 `/ready` 503、`murakumo/free` 502（OpenRouter 429）、`mishima` 180 秒后 `fleet_capacity_unavailable`；未取得有效回答，**不集成**。
- **llmfaucet**：`llmfaucet.dev` / `api.llmfaucet.dev` 在本地、Google DNS、Cloudflare DoH 均为 NXDOMAIN；**不集成**。
- **LLM7.io**：无 Key 请求可返回 200，但官方 README 要求 `dash.llm7.io` Token；匿名第三方授权无法确认，**不集成**。
- **Pollinations**（额外调查）：匿名基础 JSON/多语言通过，但真实 LiveMemory 包 HTTP 400；**不集成**。
- 没有第二个通过项，因此本轮**没有**生产自动切换列表；请求失败时降级到手动流程。

### 1.1.2 自动分析后端

新增：

| 模块 | 职责 |
| --- | --- |
| `src/ai/auto/config.mjs` | 唯一已验证 provider、匿名限流、批次/上下文/输出上限、稳定错误码 |
| `src/ai/auto/client.mjs` | `fetch` + `AbortSignal` 请求、滑动窗口限流、`Retry-After`、JSON 提取、错误分类 |
| `src/ai/auto/prompt.mjs` | 读取现有 ZIP 包、内联包内容、精确观众 ID/证据 seq、批次/汇总/修复提示词、上下文预算 |
| `src/ai/auto/state.mjs` | `runtime/ai-auto.json` 进度（无聊天正文/提示词），重启标记 `interrupted` |
| `src/ai/auto/runner.mjs` | 创建/恢复任务 → 逐批调用 → 校验 → 导入 → 汇总 → 完成；取消、重试、备用、请求预算 |
| `src/ai/auto/errors.mjs` | 单一 `AutoAnalysisError` 与脱敏 detail |

关键约束：

- 自动分析**不直接写数据库**：每个回答都先调用现有 `validateAnalysisImport()`，再调用 `importAnalysisResult({source:'auto'})`，与手动导入同一事务路径。
- Schema 严格程度不变；`viewer_memory_updates` 覆盖、稳定 ID、证据归属、时间窗口、重复导入保护全部沿用现有逻辑。
- 自动任务使用更小的批次（250 条消息 / 25 位观众 / 600 条摘录），最多 12 批；超出时明确 `AUTO_TOO_MANY_BATCHES`，不静默截断观众。
- 输出预算最低 8000 tokens（探测到 3040 会截断 gpt-oss 的 JSON）；修复请求最多 1 次。
- provider 调用串行；每个 provider 2 请求/60 秒滑动窗口；`429` 尊重 `Retry-After`（上限 90 秒）；单次运行有请求预算。
- 不使用 API Key、Cookie、Token、开发者服务器；首次使用需在 UI 明确同意数据发送。

### 1.1.3 自动分析 API

```text
GET  /api/ai/auto/services    已验证服务与最大批次数
GET  /api/ai/auto/status      按 sessionId 返回真实阶段/批次/错误/任务状态
POST /api/ai/auto/run         {sessionId, locale, consent:true}
POST /api/ai/auto/cancel      {sessionId}
```

`AutoAnalysisRunner` 随 `startServer` 的运行时创建/销毁；`shutdown` 会中止任务并把进行中的状态标为 `interrupted`。恢复时复用同一 job id、batch id、观众分配与已导入结果。

### 1.1.4 UI

在现有 AI 分析中心的「创建分析任务」卡内、手动控件上方新增：

- 「自动 AI 分析」主按钮 + 「免费 · 匿名」chip + 简短说明；
- 真实阶段文案：准备数据 / 连接免费 AI / 第 X/Y 批 / 验证结果 / 更新长期记忆 / 整场汇总 / 完成 / 已取消；
- 首次使用一次性同意弹窗（明确第三方数据处理）；
- 失败时按钮正下方显示规定红色文案，技术原因折叠在「查看详情」，不弹 `alert()`，不自动切换/删除手动结果；
- 手动创建任务、下载包、复制提示词、导入 JSON 全部保留；按钮下方用分隔线标注「或使用手动分析」。
- 处理中禁用同一任务重复启动；页面切换/刷新从服务端恢复状态；可取消，已导入批次保留。

### 1.1.5 本轮已知限制

- 只有一个已验证 provider；OVH 匿名层 2 请求/分钟，较大场次会更慢或明确拒绝。
- `gpt-oss` 的输出质量仍有波动；本轮通过“证据 seq 列表 + 必须输出状态变化 + 8000 输出预算 + 一次修复”降低失败率，但不能保证每个回答都完美。
- 真实长期记忆连续性测试（同一观众先“学画画”、后“改学吉他”）见 `docs/ANONYMOUS_AI_RESEARCH.md` §8：第二场自动完成后旧事实被标记为 `superseded`，新增“吉他”与“最近不怎么画画了”两条事实；这是单次真实样本，不保证所有模型都稳定。
- v0.12.0 EXE 已构建但**未能运行**（本机拒绝非提升执行）；未在真实数千观众大场执行自动分析。
- 真实浏览器 UI 仍未验收（本机策略阻止无头浏览器）；只有静态 UI 检查与 HTTP 端到端测试。

## 2. 本轮完成（2026-11-10，v0.11.0，P8）

### 2.1 审计结论：为什么之前只更新了少数观众

不是数据库或批次丢失，而是**设计把长期记忆建立在“AI 愿意输出画像的观众”上**：

1. 旧 M6 提示词明确写“`viewer_profiles` 只给证据足够的观众；证据不足的观众请省略”，
   并要求“单条发言不足以建立长期兴趣”。
2. 旧 M7 的本地合并只消费导入结果中的 `viewer_profiles`；没有画像的观众不会被建立记忆。
3. 旧 M7 的“记忆更新包”是**第二次 AI 工作流**：用户必须再导出、再交给 AI、再导入、再点合并；
   对普通用户而言很难发现，也没有覆盖状态。
4. 旧包按消息分批；同一观众跨批次时画像会被拆散，且没有“哪些观众未处理”的事实。

因此实际只更新了少数高活跃、被 AI 写了画像的观众。本轮把长期记忆改成**分析结果的一等字段**，
每位可识别观众必须有覆盖条目，缺一条就是导入错误。

### 2.2 一次分析、一次导入

- 同一个 `livememory-analysis-result-v1`（Schema **1.2.0**）同时包含：
  - `session_topics` / `viewer_profiles`：本场报告；
  - `viewer_memory_updates`：每位观众的长期记忆增量。
- 分析包新增 `memory_context.json`（现有画像 + 客观统计）与 `viewer_excerpts.jsonl`
  （本批观众的全部可用发言，最多最近 120 条/人）。
- 导入在**同一个 SQLite 事务**中保存分析结果、证据、客观记忆头、语义事实/版本与覆盖状态；
  分析导入失败会连同记忆一起回滚。

### 2.3 所有可识别观众

- `listSessionViewers` 的全部稳定 ID 都进入 `ai_job_memory_viewers`，无最低发言次数、无活跃度门槛、无 Top N。
- 观众上限 `MAX_ANALYSIS_VIEWERS=20000`；超出时显式报错，不静默截断。
- 没有发言、只有礼物/SC 的观众也会进入记忆批次；AI 返回 `no_new_information`，
  客观互动历史仍由真实记录更新。
- 批次上限 200 人 / 3000 条摘录；观众只分配到一个批次，该批包含其全部可用摘录，跨批次不拆散。
- 批次数量由消息量与观众数共同决定；普通单观众场次保持原有 500/500/200 消息切片行为。

### 2.4 客观历史与语义记忆

- 客观：首次/最近出现、参与场次、累计发言、付费事件、支持、最近场次。全部来自
  `viewers` / `viewer_sessions` / `viewer_broadcasters` / 金额聚合，导入时只确保
  `viewer_memories` 头存在并更新 `last_session_id` / `last_update_at`，不产生语义版本。
- 语义：`interest` / `dislike` / `identity` / `life_event` / `topic` / `preference` /
  `community` / `other`；支持 add / confirm / update / supersede / conflict / outdated / uncertain。
- 只有问候、表情或礼物时允许无语义更新；观众状态为 `no_semantics`，**不是未处理**。
- 已有画像进入 `memory_context`；AI 可以补充/修正/替换同一话题，不要求重新读取全部历史聊天。
- 证据 seq 必须命中本批 `ai_job_memory_messages`，且消息作者必须等于 `viewer_id`；
  他人消息、跨批次、越界 seq、无证据 stated、未知 target_fact_id 全部拒绝。

### 2.5 覆盖状态与预览

- `ai_jobs.memory_viewers_total` + `ai_job_memory_viewers`（pending/semantic/no_semantics/
  objective_only/missing_update/deleted）+ `ai_job_memory_messages`（seq → event → viewer）。
- 导入预览新增：已覆盖/总数、新语义、已处理无新语义、仅客观、缺少更新、记忆操作数。
- 任务状态新增 `memoryCoverage` / `memoryReady`；全部分配观众覆盖后任务才可能 `complete`。
- 旧 1.0/1.1 结果仍可导入：按 `objective_only` 覆盖，不阻断报告。

### 2.6 取消独立长期记忆工作流

- 删除 `src/web/js/pages/memory.js`、`#/memory` 导航与页面；旧书签 `#/memory` 进入 AI 分析中心。
- 保留全部数据库、版本、证据、删除/回滚/人工确认 API 与隐私规则。
- 观众详情长期记忆标签新增**客观互动历史卡**；没有语义事实但有互动时显示
  「互动已记录，暂无语义记忆」，不再伪装成“没有记忆”。
- 旧 M7 `memory_jobs` 表保留，仅用于已有历史数据；不再由 UI 创建新的独立记忆任务。

## 3. 自动化测试（本轮实测）

- 全量（v0.12.1）：`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`
  → **545 passed / 0 failed**（约 77 秒，2026-11-11）。
- 本轮新增/更新：
  - `tests/unit/auto-assemble.test.mjs`：ref 校验、ref→稳定 ID 组装、定向补充合并、
    定向提示词只含缺失观众；
  - `tests/unit/auto-client.test.mjs`：structured output 请求、`finish_reason`/usage、
    截断错误、退化检测；
  - `tests/unit/auto-prompt.test.mjs`：紧凑契约、refs、证据 seq、去重 messages/excerpts、
    上下文预算、修复提示；
  - `tests/integration/auto-compact.test.mjs`：52 人/99 消息 6 批、100 位低活跃 10 批、
    缺失 ref 定向补充、补充失败、截断、零摘录观众；
  - `tests/integration/manual-52-viewers.test.mjs`：52 人单批、2 未知 + 2 缺失精确 gaps、
    修正后 52/52 事务导入；
  - `tests/unit/ai-import-repair.test.mjs`：修复指令不改 ID；
  - `auto-api`：maxBatches=30、310 观众 → 31 批 422；
  - `ai-prompts`/`ai-api`/`ai-import`：提示词版本 m6.3。
- 既有 M6/M7/P8 全量回归通过；schema 仍为 12，无迁移断言变化。
- v0.12.0 的历史全量结果：525 passed / 0 failed（保留为历史记录）。


## 4. UI 验证（如实）

- **没有真实浏览器渲染/截图验收**：本机策略仍阻止无头 Edge/Chrome。
- 已覆盖：三语键一致、页面字面 key、独立记忆页已移除/旧链接到 AI、预览字段、客观历史卡、
  无 innerHTML、CSS tokens、窄屏规则（静态测试）；HTTP/端到端行为由 Node 测试覆盖。
- v0.12.0 自动分析 UI 额外覆盖（静态）：按钮/免费匿名 chip/首次同意 modal/真实阶段文案/
  按钮下方红色固定文案/折叠详情/取消/无 `alert()`/手动控件仍在；HTTP 路由与状态由
  `auto-api.test.mjs` 覆盖。
- v0.12.1 新增静态覆盖：`memory.gaps` 渲染、缺失观众列表、复制修复指令按钮；
  `ai-import-repair.test.mjs` 验证复制文本包含精确 ID/错误路径且不修改 ID。
- 因此不能声称自动按钮、gaps 列表、复制按钮、AI 预览、观众记忆页、暗色、390px
  已在真实浏览器验收。

## 5. 构建结果（如实）

- **v0.13.0 已重新构建 EXE**：`node scripts/build-windows.mjs` 成功。
  - 大小 **91.5 MB**，资源 **166 个**，资源哈希 `ee68ae2960bbeeccccb7`
  - SHA-256 `3008ddebe0f777f9c8f3120e3752b20c0584770a1cf73adae56bb0c27d8b2325`
  - PE Manifest **requireAdministrator**（脚本断言通过）
- **未能运行验收**：本机直接执行被 Windows 以“请求的操作需要提升”拒绝；未能运行
  `--version`、启动服务、验证打包后的出站请求或 UI。
- 因此只能声称“已构建”，不能声称“v0.13.0 EXE 已启动/已验收”。
- 历史：v0.12.0 / v0.12.1 的构建记录不再代表当前产物。

## 6. 未完成 / 未验证

- v0.13.0 EXE 启动、出站网络与干净 Windows 环境验收（已构建，未能运行）；
- 真实浏览器 AI 分析中心、Provider 设置卡、暗色、390px 截图；
- 真实 OpenAI/Anthropic/DeepSeek/MiniMax/DashScope 生成与能力检测（缺 Key）；
- 真实付费 52 观众端到端画像（Mock runner + 包结构测试已通过）；
- 数千观众/数万消息大场的批次、耗时、内存与 OVH 2 请求/分钟的实际总时长；
- 自动分析运行中删除场次/清空数据的 UI 守卫与真实交互；
- 第二个通过完整 LiveMemory 包的匿名 provider（本轮没有）；
- 自动分析运行中删除场次/清空数据的 UI 守卫与真实交互；
- 真实 Bilibili/YouTube 大场自动分析样本（当前真实样本为 3 位合成观众）；
- 真实平台礼物/SC-only 观众的自动分析样本；
- M5 可移植备份仍未实现。

## 7. 关键规则（下一轮不要破坏）

1. `session` 与 `memory` 是独立任务、独立保存；单场报告成功不依赖画像，画像失败不覆盖报告。
2. 免费 Provider/`api_free` 模型永远不能执行 memory 任务；长期画像必须是付费 + 已知价格 + `capabilities.memory` + 用户 opt-in。
3. 付费/未知价格请求前必须 `confirmBilling`；未知价格不得当免费；不自动切换到更贵模型。
4. Provider 配置只保存 credentialReference；Key 只存加密凭据库；区域/Base URL 变化轮换引用。
5. 自定义 URL 必须通过私网/元数据/DNS 检查；localhost 只在显式 allowLocalNetwork 时允许。
6. 能力检测不能只看 HTTP 200；memory 必须用多观众 ref、证据归属、零发言与多语言探针。
7. 每位可识别观众必须有且仅有一条 `viewer_memory_updates`；缺失即导入错误。
8. 观众只分配到一个记忆批次，全部可用摘录随行；不得用 Top N 或最低活跃度裁剪。
9. 客观历史只由真实记录更新；AI 不能写金额/计数/时间/身份。
10. 语义事实必须有证据或明确推断/待确认；`stated` 必须有本观众的消息。
11. 无新语义 ≠ 未处理；`pending` 才是未处理。
12. 删除记忆后的旧包不能恢复；重复导入幂等。
13. 三语键三份一致；前端禁止 `innerHTML`；颜色只用 tokens。
14. 所有 Provider/模型输出必须走 `validateAnalysisImport()` + `importAnalysisResult()`；不能直接写库，不能降低 Schema。
15. 画像批次仍覆盖全部可识别观众；超出安全上限明确失败，不得静默裁剪。
16. 匿名 Provider 只允许已通过真实 LiveMemory 包验证的服务；未验证服务不得进入自动列表。
17. 运行失败只写状态/错误码；不删除已完成结果、不覆盖已有记忆；单场报告成功时画像失败只标 partial。
18. 手动导入失败只显示精确 gaps 与修复指令，绝不自动替换、缩写或合并 ID。

## 8. 相关文档

`docs/HANDOFF.md`、`docs/ARCHITECTURE.md`、`docs/DATA_MODEL.md`、`docs/AI_CONTRACT.md`、
`docs/UI_DESIGN.md`、`docs/PRIVACY_SECURITY.md`、`docs/TEST_PLAN.md`、`docs/CHANGELOG.md`、
`docs/ROADMAP.md`、`docs/ANONYMOUS_AI_RESEARCH.md`、
`log/2026-11-11-anonymous-ai-auto-analysis.md`、`log/2026-11-10-unified-analysis-memory.md`、
`log/2026-11-10-viewer-scope-fix.md`。

## 9. 下一步

1. 在允许浏览器的机器上验收自动按钮、失败红色文案、详情、暗色与 390px；补截图。
2. 在无策略限制的 Windows 环境运行已构建的 v0.12.0 EXE，验证出站请求、代理/防火墙与打包 UI。
3. 用 1000–5000 观众/数万消息的大场测自动批次、耗时、内存与 OVH 2 请求/分钟的实际影响。
4. 寻找并完整测试第二个匿名 provider（必须通过真实 LiveMemory 包），再启用自动切换。
5. 评估自动运行中删除场次/清空数据的 UI 守卫；当前只依赖服务端失败与红色提示。
6. 继续观察 OVH 免费通道的稳定性与条款变化；失效时如实降级，不把历史可用写成永久可用。

## 10. 补丁 0.11.1：观众档案主播范围

- **问题**：观众详情页把 `/api/broadcasters` 的全部主播传给「主播范围」选择器，
  导致只出现过 1 位主播的观众也看到软件记录过的全部主播。
- **根因**：UI 的 `scopeOptions` 使用全局 broadcaster payload；详情页没有使用
  `/api/viewers/:id` 已经返回的 `profile.broadcasters`。后端 `buildViewerProfile` 在请求
  无关系主播时还会用 `getBroadcaster` 回退，制造了一个看似有效的空范围。
- **修复**：
  - 新增纯逻辑 `src/web/js/pages/viewer-scope.js`；详情选项只来自
    `profile.broadcasters`（即 `viewer_broadcasters`，包含礼物/SC/大航海等可识别互动），
    不再包含「全部主播」或未归属选项。
  - 无效/已删除的 `?broadcaster=` 安全回退到当前有效主播或第一个关联主播；
    无关联时 `null`，页面显示明确空状态。
  - 只有一个关联主播时隐藏无意义的下拉框，改为只读标签。
  - `buildViewerProfile` 无关系时返回 `scope.kind='none'`，不再回退到全局主播。
  - 长期记忆上下文只使用有效关联主播，不再回退到全局当前主播。
- **测试**：新增 `tests/unit/viewer-scope.test.mjs`、
  `tests/integration/viewer-broadcaster-scope.test.mjs`；全量 **495 passed / 0 failed**。
- **构建**：见 §5（0.11.1 重新构建）。
