# 工程状态（STATUS）

最后更新：2026-11-12（v0.13.2 构建可验证 + 分批预算重平衡；596 tests；EXE 已实跑验证 buildId）

> 本文件是唯一进度来源。只要代码与本文不一致，以代码与实测为准，并立即修正本文。

## 0.14 v0.13.2 构建可验证与分批预算（2026-11-12）

真实事故：14:17 用户启动的仍是 87bec0c 的旧 EXE；fd8aedc 的 8k 总预算把 889 条消息切成约 125 批。完整诊断见本轮日志；本节只记录修复与实测。

### 0.14.1 构建标识（已实测）

- `src/shared/build-info.mjs`：开发模式直接读 `.git/HEAD`（不 spawn git）；打包模式读 `build-info.json` 与 bootstrap 环境变量。
- `scripts/build-windows.mjs`：写入 commit、`sourceHash`（含 `scripts/sea-bootstrap.cjs`）、`assetHash`、`buildId`、逐文件 SHA-256；断言 7 个可靠性模块存在；构建后检查 EXE 内确实包含 buildId 与模块名。
- `scripts/sea-bootstrap.cjs`：复用缓存前**逐文件校验 169 个 SHA-256**；不一致记录 `app-root.stale`、删除并重新解压；解压后再次校验；把 buildId/commit/校验结果写入环境。
- 启动日志 `startup.begin` 与 `launcher.start` 记录 build；`--version` 输出 Build / Build ID；设置页「关于」显示 Build ID、commit、构建时间；`/api/health`、`/api/bootstrap`、`/api/status` 返回 build。
- 旧缓存不再被误用：旧目录 hash 不同；同 hash 目录被篡改会被校验发现并重建。

**最终 EXE（实跑验证）**：

| 项目 | 值 |
| --- | --- |
| 文件 | `dist/LiveMemory.exe` |
| 大小 | 91.6 MB |
| SHA-256 | `7bcc365fd95d8f20d722196328db8f85218309187d65b2fa84d425ed30fc29a1` |
| commit | `84b54f09b40a6709af83c96a075ea78be0ef71b4` |
| buildId | `b62882c5a365` |
| asset hash | `b62882c5a365d6cd2519` |
| builtAt | 2026-11-12T07:19:02.385Z（15:19:02 +08） |
| 资源 | 169 files；7 个必需模块；RT_MANIFEST requireAdministrator |

本机非提升会话用同一二进制的 asInvoker 副本实际启动：`/api/health` 与 `/api/bootstrap` 返回 `buildId=b62882c5a365`、`mode=packaged`、`verified=true`；启动日志 `startup.begin` 含同一 build；第二次启动复用缓存并 `filesVerified=169`。**不是只看版本号。**

### 0.14.2 分批预算（真实 889 条消息离线规划）

- 预算拆成三项：固定 overhead（实测 instructions + session_context + answer schema + wrapper）、内容预算、输出预留；内容至少占配置总预算的 50%，且不低于 1,000 tokens。
- 默认总输入预算 **24,000**（原 8,000）；配置范围仍为 2,000–32,000。
- `batch_plan` 记录 configured/effective/content/overhead/output/context，`overheadAdjusted` 与 `contextCapped` 可见。
- 真实包（889 消息、94,137 估算消息 tokens、7,193 overhead、8,000 输出预留）实测：

| 总预算 | 有效输入 | 内容预算 | 批次数 | 平均消息/批 | 最大单批估算 | 估算总输入 | 按真实 1.366 校准 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 8,000 | 11,193 | 4,000 | 24 | 37.0 | 11,192 | 266,769 | 364,406 |
| 16,000 | 16,000 | 8,807 | 11 | 80.8 | 15,997 | 173,260 | 236,673 |
| **24,000** | **24,000** | **16,807** | **6** | **148.2** | **23,949** | **137,295** | **187,545** |
| 32,000 | 32,000 | 24,807 | 4 | 222.3 | 31,988 | 122,909 | 167,894 |

- 覆盖：每档 889/889，消息不丢、不重；不再出现 125 批。
- 未退回 135k 单请求：上限 32k，超出按批拆分。
- 明确例外/保护：单条消息本身超预算可独占一批；单观众超预算可独占一批，但硬上限 48k，超过 `ANALYSIS_MEMORY_VIEWER_TOO_LARGE`；aggregate 输入硬上限 48k 且受上下文约束；repair 只截断上次回答、保留原批内容，超限 `ANALYSIS_REPAIR_TOO_LARGE`；上下文装不下 `ANALYSIS_CONTEXT_TOO_SMALL`。

### 0.14.3 输出与思考模式（文档证据）

- 阿里云官方文档（2026-11-10 版）确认：`max_tokens` 对 Qwen 只限制**回答**；思考内容在 `reasoning_content`，单独计费。`qwen3.8-max` 默认 `reasoning_effort=xhigh`、`thinking_budget=131072`。
- 这解释了平台 18,684 output 与 9,936/12,734 历史单请求：`max_tokens=8000` 不是总输出上限。
- 修复：DashScope 请求在 `max_tokens` 之外发送 `max_completion_tokens = 回答预算 + 8,000`（session 16k、memory 14k），有界但**不关闭思考**；其他 Provider 不发送该参数。
- 观测：attempt 日志新增 `model`、`maxTokens`、`maxCompletionTokens`、`estimatedInputTokens`、`requestBytes`、`reasoningChars`、`reasoningTokens`；流式只统计 `reasoning_content` 长度，不保存内容。
- 124 位观众：长期画像由 memory 批次保证每位恰好一条；测试覆盖 124/124。session 的 `viewer_profiles` 明确为可选、按批高亮，不再暗示完整覆盖。

### 0.14.4 测试（本轮实测）

- 全量：**596 passed / 0 failed**（2026-11-12，`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`，约 94 秒）。
- 新增：`tests/unit/build-info.test.mjs`、`ai-adapter-output.test.mjs`、`ai-repair-guard.test.mjs`；`ai-token-batching.test.mjs` 增加 889 消息 / 124 观众 / 硬上限；`bootstrap.test.mjs` 增加缓存篡改重解压。
- 未做：真实付费 API（含 `max_completion_tokens` 与思考模式行为）、真实 UAC 双击、真实 889 消息付费回放。

## 0.13 v0.13.1 可靠性专项（2026-11-12）

完整设计、边界与测试清单：`docs/AI_RELIABILITY.md`。
前序根因调查：`docs/AI_TIMEOUT_INVESTIGATION.md`。**本轮已改代码并完成本地确定性验证，但未发起真实付费 API 请求。**

### 0.13.1 超时与重试

| 问题（调查编号） | 修复 |
| --- | --- |
| B1 超时被当成可重试，自动重发 2 次 | `timeout` 明确 `retryable:false`；已发出的长请求超时后默认**不自动重试** |
| B2 `AbortError`/`TimeoutError` 合并 | adapter 区分 `canceled` / `timeout` / `network` / `rate_limit` / `server` / `client` / `invalid_response` / `stream_interrupted`；取消绝不重试 |
| B3 超时不降速 | 超时不再触发同批重发脉冲；429/5xx 仍按各自的退避与 `Retry-After` |
| B4 无任务级总时限 | 新增 20 分钟任务预算（可注入时钟测试）；达到后 `ANALYSIS_TASK_TIMEOUT`，已完成批次保留 |
| B5 无 attempt 级状态/日志 | 每次尝试写 `ai.request.attempt`（脱敏：attempt、耗时、错误类型、HTTP status、是否收到响应头/输出、是否重试、usage 是否存在）；状态含 `attemptStats`、`currentRequest`、`lastRequest` |
| B6 `runPool` 首个失败中止其他请求 | 失败只停止调度新批次；在途兄弟批次继续完成并导入；最后抛第一个错误 |
| B7 统计按配置/进程 | 任务级 `attemptStats` 与按 `configId` 的 `requestStats` 并存；成功/失败/取消/超时/重试分开 |
| B8 失败尝试不计 usage | 失败/超时/取消未返回 usage 时计入 `usageUnknownAttempts`，UI 显示“用量未知”，不当作零费用 |
| B9 无流式/空闲超时 | 自动流式 + 60 秒空闲超时；持续输出不会被 180 秒总时长截断 |

### 0.13.2 Token 分批与汇总

- `src/ai/batching/tokens.mjs`：按估算 input token 规划 session 消息批次与 memory 观众批次。
- session：默认 8,000 input tokens/批；Provider 配置 `batchInputTokens` 可设 2,000–32,000；小上下文模型自动缩小并限制输出。
- 单场消息多批时，必须成功导入 **final aggregate** 才算 `complete`；汇总只使用已校验批结果，证据必须 `{batch, seq}`。
- memory：同一观众不拆批；预算同时计入摘录、现有记忆、evidence seq 列表与固定开销；超预算的单观众单独成批，不丢观众。
- 批包新增可选 `manifest.batch_plan` 诊断字段；结果 Schema 仍为 1.3.0，未迁移数据库。

### 0.13.3 流式

- 默认优先 Streaming；用户只选择 Provider/区域/Model ID，不出现 Streaming 开关。
- 支持 OpenAI-compatible SSE 与 Anthropic Messages SSE；Provider 返回 JSON 或明确拒绝 stream 时自动回退，且回退模式持久化，后续任务不再重复探测。
- 流式内容只缓冲，完成后仍走原 JSON 提取、本地组装、Schema/覆盖/证据校验与事务导入；中断流不写库。
- 计时区分响应头、首字节/首 token、流持续时间、最大空闲与总耗时。

### 0.13.4 UI / 统计

- 新增：单场批次 4/70、等待汇总、已收到模型输出、请求运行秒数、重试次数、已保存单场/画像批次、失败真实原因。
- 统计分开：请求尝试、成功、失败、取消、超时、自动重试、429、并发、模型耗时、token、已知费用；失败无 usage 显示“用量未知”。
- ETA 只在 ≥3 个成功批次样本且运行中显示；无依据不显示。
- `Estimated requests` 在含 session 的任务中显示“自动（按 token 预算分批）”，不再给出错误的固定 1。
- 修复全局 `[hidden]` 被 `.callout {display:flex}` 覆盖导致空提示框可见的 CSS 缺陷。
- 真实浏览器验收：headless Edge + DevTools 截图（运行中、完成、390px、设置页），见 `docs/screenshots/ai-reliability-*`。

### 0.13.5 测试与验证（本轮实测）

- 全量：**583 passed / 0 failed**（2026-11-12，`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`，约 96 秒）。
- 新增：`tests/unit/ai-attempts.test.mjs`、`ai-stream.test.mjs`、`ai-token-batching.test.mjs`；`tests/integration/v14-session-batching.test.mjs`、`v14-streaming-timeout.test.mjs`；更新 `ai-progress.test.mjs`。
- 真实浏览器：Edge headless CDP 打开 AI 中心与设置页，确认运行中/完成/窄屏/暗色渲染；截图使用合成 Fixture，不是真实 Provider。
- **未做**：真实付费 API 请求（本机无 Key）、真实 174k token 大场、真实 EXE 运行、UAC 验收。
- **阻塞**：真实 DashScope/OpenAI/Anthropic/DeepSeek/MiniMax/OpenRouter 生成仍未验证；不得用 Mock 结果冒充。

## 1. 当前阶段

- 里程碑：**M0 / M1 / M2 核心 / P0–P9 / M6 / M7 / v0.13 AI 架构重构完成**；v0.13.1 完成 AI 入口与调度收敛；M3 真实接入继续验证；M4 部分完成；M5 未完成
- 版本：`0.13.2`（`package.json` 与 `src/shared/app-info.mjs` 一致；构建标识见 §5）
- 数据库 schema：**13**（本轮无迁移）
- 分析结果 Schema：**1.3.0**；旧 1.0.0–1.2.0 仍可读取；提示词版本不变
- 分支：`main`，本地提交，未 Push
- 发布形态：`LiveMemory.exe`，RT_MANIFEST **requireAdministrator**

## 0. v0.13.1 本轮完成（2026-11-11）

### 0.1 付费 API 限速审计结论

完整报告：`docs/AI_SCHEDULER_AUDIT.md`。

- **付费 API 没有复用 OVH 匿名免费限速器。** v0.13.0 的 `src/ai/api/runner.mjs` 未导入/构造 `SlidingWindowLimiter`；该 limiter 只存在于 `src/ai/auto/runner.mjs` + `src/ai/auto/config.mjs:93` 的匿名路径。
- 固定 `2 requests/minute` 只存在于匿名路径；没有 30 秒固定等待。旧付费路径只有失败重试的 1.2s / 2.4s 固定等待。
- 旧付费路径的真实问题是：**所有画像批次完全串行**、30 批上限、`Retry-After` 未使用、每次请求重复 DNS 检查、每批导入重扫全部 session 观众、`listPackages` 默认 50 条导致大 job 找不到批次。
- 已删除 `src/ai/auto/` 与 `/api/ai/auto/*`；新增 Provider 隔离调度器与有界并发。

### 0.2 删除的入口

- 匿名免费 AI：UI 按钮、免费标识、免费服务状态、匿名 Provider 配置、自动切换、2 RPM、免费冷却、健康探测、`/api/ai/auto/*` 路由。
- 手动 AI：创建分析包、复制提示词、下载 ZIP、粘贴/上传 JSON、手动导入预览/确认、汇总包按钮、旧任务列表与修复指令 UI。
- HTTP 删除路由：`/api/ai/jobs` POST、`/api/ai/jobs/:id/aggregate`、`/api/ai/packages` POST、`/api/ai/packages/:id/download`、`/api/ai/instructions`、`/api/ai/import/preview`、`/api/ai/import`、全部 `/api/ai/auto/*`。
- 保留只读：`/api/ai/jobs` GET、`/api/ai/jobs/:id` GET、`/api/ai/packages` GET、`/api/ai/sessions/:id/report`、`/api/ai/results/:id`、`/api/ai/results/:id/download`。

### 0.3 保留的底层公共模块

- `src/ai/import/validate.mjs`、`src/ai/import/importer.mjs`、`src/ai/import/schema-validator.mjs`：严格 Schema、证据/身份/批次校验、事务导入、幂等与重复导入保护。
- `src/ai/api/compact.mjs`、`src/ai/api/prompts.mjs`、`src/ai/export/split-jobs.mjs`：ref→viewer_id 映射、单场/画像组装、内部包生成。
- `src/analytics/ai/report.mjs` 与 `src/web/js/pages/ai-report.js`：历史报告、长期画像只读展示。
- `src/ai/export/job.mjs`、`src/ai/export/package.mjs`、`src/ai/prompts/instructions.mjs`：旧 combined/手动包格式的内部构建器，保留用于历史兼容与回归测试；**不再有 UI/HTTP 入口**。
- 新增 `src/ai/runtime/json.mjs`、`state.mjs`、`scheduler.mjs`；删除 `src/ai/auto/`。

### 0.4 新请求调度

- 每个 `configId` 独立调度器；不同 Provider/区域/模型/密钥不共享限流状态。
- 初始并发可配置（1–8，默认 3），没有虚构的官方 RPM/TPM；429 时并发减半并遵守 `Retry-After`（上限 300 秒），成功 6 次后逐级恢复。
- memory 批次有界并发（默认按配置并发，最多 8）；同一观众只属于一个批次；同一主播跨场次记忆按时间顺序 gate，较旧场次在新场次已导入后被拒绝（`ANALYSIS_MEMORY_OUT_OF_ORDER`）。
- 失败重试：最多 3 次尝试，指数退避 + 50–100% 抖动，5xx/408/425 可重试，400/401/403/404 不重试。
- 状态新增：总请求、完成、失败、当前并发、排队、模型耗时、排队/限流等待、429 次数、p50/p95、token、已知费用、有依据时的 ETA。
- 画像批次上限从 30 改为 `ceil(MAX_ANALYSIS_VIEWERS / 10) + 1`（2,001），不再人为限制 1,000 观众。
- 本地性能修复：按批观众更新客观记忆、DNS 安全缓存 5 分钟、`getJobPackage()` 精确查询。

### 0.5 UI

- AI 分析中心只保留五步：选择直播 → 选择 API 配置 → 选择内容（单场/画像/两者）→ 费用与预算确认 → 「开始 AI 分析」。
- 无 API Key 时只显示设置入口，不再提供匿名免费或手动 JSON 入口。
- 保留暂停/继续/取消、真实阶段、失败原因、请求统计、报告与长期画像只读展示。
- 设置页新增「初始并发数」；匿名/免费价格分支删除。
- 三语键全部补齐；无 `innerHTML`、无 `alert()`。

### 0.6 本轮测试（实测）

- 全量：**548 passed / 0 failed**（2026-11-11，约 73 秒，`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`）。
- 新增：`tests/unit/ai-scheduler.test.mjs`（并发上限、429 隔离、取消、退避）、`tests/integration/v13-scheduler.test.mjs`（429 Retry-After、1,000 观众批次并发、失败恢复、跨场次顺序）、`scripts/benchmark-mock-scale.mjs`。
- 重写：`tests/unit/ai-ui.test.mjs`（只允许一个 API Key 流程）、`tests/integration/ai-api.test.mjs`（直接测试校验/导入/报告，不再依赖已删除的手动 HTTP 路由）、`v13-session-split`、`api.test`、`youtube-anonymous-session` 的包构建部分。
- 删除：旧匿名/手动测试文件（`auto-analysis`、`auto-api`、`auto-compact`、`auto-client`、`auto-prompt`、`auto-assemble`、`manual-52-viewers`、`ai-import-repair`）。

### 0.7 Mock 性能

详见 `docs/AI_SCHEDULER_AUDIT.md` §4。

| 场景 | 批次/请求 | 峰值并发 | 总耗时 | 吞吐 | 结果 |
| --- | --- | --- | --- | --- | --- |
| 100 观众 / 1,000 消息 | 10 / 10 | 6 | 591ms | 16.92 req/s | complete，100/100 |
| 1,000 观众 / 10,000 消息 | 100 / 100 | 6 | 6,491ms | 15.41 req/s | complete，1,000/1,000 |

### 0.8 真实付费 API

- **阻塞。** 本机用户数据目录没有 `config/ai-providers.json`，`secrets/` 没有 `ai-keys.json`，环境变量也没有 DashScope/OpenAI/OpenRouter Key。
- v0.13.0 的阿里云百炼真实样本使用临时目录，结束后已删除；不能把历史记录当作本轮真实测试。
- 唯一真实网络请求：`GET https://openrouter.ai/api/v1/models` → HTTP 200、469 个模型、375ms（只读，无 token）。不是生成验收。
- 没有伪造真实 API 成功；也没有为测试速度消耗 token。

### 0.9 未验证

- 真实浏览器渲染/截图（本机策略仍阻止无头浏览器）。
- Windows EXE 运行验收（UAC 拒绝）；本轮是否重新构建见 §5。
- 真实 Provider 的 429/Retry-After、1,000 观众运行、费用与延迟。
- 真实 Bilibili/YouTube 大场自动画像。

### 0.11 v0.13.1 七项实际使用修复（2026-11-11）

| # | 问题 | 复现/根因 | 修复 | 验证 |
| --- | --- | --- | --- | --- |
| 1 | 历史跳转 AI 未选中对应场次 | `ai.js` 忽略路由 `query`，总是取列表第一场 | `chooseInitialSessionId()` 按稳定 `session_id` 选择；目标不在前 100 行时按 id 加载；手动选择后更新 URL，不会被旧参数强制切回 | `ai-selection.test` + 静态 UI 测试 |
| 2 | 已配置 Key 却显示未配置 | 只用 `configs.length` 二值判断，缺少 key/测试失败/未检测/价格缺失状态 | 新增 `providerConfigState()`；分别显示未配置、缺 Key、测试失败、未检测、缺价格；删除“不再提供匿名免费 AI”历史文案 | `ai-config-state.test` + Provider 列表真实加密引用测试 |
| 3 | 没有实时进度条 | 只有文字；初始 idle 响应可能覆盖刚启动的任务；没有批次/观众进度 | 新增计数型进度条（批次/观众）、阶段文案、不确定动画；statusEpoch 防止旧响应覆盖；1.5s 轮询；完成自动加载报告 | `ai-progress.test`、`v13-progress.test`；真实浏览器未验收 |
| 4 | `Memory No viewers` | `ANALYSIS_MEMORY_EMPTY` 未本地化；combined 任务把画像无观众当整体失败 | 新增 `ANALYSIS_MEMORY_NO_VIEWERS` / `NO_BROADCASTER`；combined 保留单场报告并显式跳过画像；memory-only 明确失败；状态返回 `memorySkipped`、覆盖率 | `v13-api-runner` 无观众测试 |
| 5 | 报告重复显示两次 | 初始 `refreshReport()` 与 `refreshStatus()` 终态刷新并发，两个响应都 append | `reportEpoch` 单飞；只有最新请求可清空/挂载；报告 DOM 只有一个挂载点 | 静态单挂载点断言 + `reportEpoch` 测试；无真实浏览器 |
| 6 | Bilibili 未开播不显示主播名 | `getInfoByRoom` 在未开播/风控时失败，`anchorName` 为空，target 只剩 `Bilibili <room>` | `BilibiliApi.masterInfo()` 公共主播资料回退；`resolve` 和低频 `detect` 补全；target 持久化 displayName/platformUid；10 分钟失败重试；改名不改 broadcasterId | 真实房间 3（未开播）→ `3号直播间` / UID `11153765`；单元/集成测试 |
| 7 | 手动停止后可能自动恢复同一场 | `#reconcile` 清除 active 后下一轮 LIVE 检查会创建新 session；无持久抑制 | 新增 `live_stopped` 状态 + `meta.manualStop`（live cycle key、sessionId、awaitingOffline）；用户停止写抑制；同周期 LIVE 不启动；确认离线才清除；新 `live_time`/videoId 才允许新场；重启保持；`resume_capture` 仅用户主动 | 场景 A–G 测试；重启恢复；多目标隔离由现有测试覆盖 |

**真实 Bilibili 验证（只读公开接口）**：房间 `3`（解析为 `23058`，未开播）→ `displayName=3号直播间`、`platformUid=11153765`、`anchorName=3号直播间`；`roomStatus.liveTime` 为 `0000-00-00 00:00:00`，未伪造开播时间。

**未验证**：真实浏览器视觉、真实 EXE、真实付费 API、真实主播“手动停止→重启→仍直播”全流程（用 Mock 可控时钟验证）。

### 0.12 v0.13.1 第 8 项：已保存 API 配置可编辑（2026-11-11）

- **原因**：后端 `ProviderConfigStore.update()` 与 `PATCH /api/ai/providers/configs/:id` 已存在，但设置页卡片只有“检测/删除”，没有编辑入口；表单只能创建。
- **UI**：每个配置卡新增「编辑配置」；复用现有表单，预填名称/Provider/区域/Base URL/模型/价格/并发/本地网络；API Key 始终留空，显示「已保存」，留空表示保留；「保存修改」「取消」；保存后刷新卡片。
- **Key 安全**：编辑请求仅在用户输入新 Key 时发送 `apiKey`；空字符串不覆盖；服务端只在显式非空 Key 时替换。切换 Provider/区域/Base URL 会轮换 credential reference，并要求重新输入 Key；不会静默复用旧区域密钥。
- **模型变更**：服务端在 model 变化时清空 `capabilities`、`lastTestStatus`、旧价格/上下文/模型标签；UI 在模型输入变化时清除旧价格并提示重新检测。旧模型能力不会被当成新模型结果。
- **保存语义**：PATCH 原地更新同一 `configId`，保留默认标记、创建时间、其他配置；不会删除重建。部分 PATCH 未提供 `pricing` 时不再错误清空价格。
- **运行中任务**：`isConfigInUse()` 阻止编辑/删除正在运行任务使用的配置（409 `AI_PROVIDER_CONFIG_IN_USE`）；暂停/中断后的旧 job 若模型/区域变化，`resume` 返回 409 `AI_PROVIDER_CONFIG_CHANGED`；新任务使用新配置，旧报告/画像不修改。
- **测试**：`tests/unit/v13-providers.test.mjs`（模型修改保留 Key、能力失效、默认/多配置、重启持久化）、`tests/integration/v13-provider-edit.test.mjs`（模型-only PATCH、空 Key、改名/并发、区域切换、运行中阻止、resume 拒绝、AI 中心使用新模型）、`tests/unit/ai-settings-edit.test.mjs`（UI/PATCH/安全静态断言）。
- **限制**：真实浏览器点击验收未执行（本机 headless 被策略阻止）；未用真实百炼 Key 做编辑；代码/HTTP/单元已覆盖。

## 0.10 v0.13.0（历史）


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

- **阿里云百炼真实端到端（隔离数据目录）**：`cn-beijing` / `qwen3.8-omni-flash`，单场 + 长期画像，2 次请求，5,671 输入 / 3,228 输出 tokens，估算 ¥0.0109928；状态 `complete`，`sessionReportDone=true`，`memoryDone=true`；数据库 3 个记忆头、2 条语义事实；报告 `longTermProfiles.count=3`（Mika 2 条事实，Ren/GiftOnly 仅客观记录）。这证明模型 ID 实际为 `qwen3.8-omni-flash`，且修复后的 Session 组装 + Memory 组装 + Schema 校验 + 写入链路可用。
- OpenRouter `/api/v1/models`：真实返回 **469** 个模型，15 个 `pricing=0` 免费模型，396 个声明 structured output（2026-11-11）。
- 其他 Provider 的真实生成请求：**阻塞**（无可用 API Key，未伪造成功）。
- 匿名 OVHcloud 生成：本轮未重新发起（v0.12.1 真实 52 观众样本记录保留）。
- 无真实浏览器渲染/截图验收；本机策略仍阻止无头浏览器。UI 只做静态/HTTP 覆盖。
- v0.13.0 EXE 已构建（91.5 MB / 166 assets / requireAdministrator），但 **未能运行**（UAC 拒绝）。

### 0.7 测试（本轮实测）

- 全量测试：**562 passed / 0 failed**（约 98 秒，2026-11-11，`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`）。
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

- **v0.13.2 已构建并实际启动验证（asInvoker 副本）**：`node scripts/build-windows.mjs`。
  - 大小 **91.6 MB**
  - SHA-256 `7bcc365fd95d8f20d722196328db8f85218309187d65b2fa84d425ed30fc29a1`
  - commit `84b54f09b40a6709af83c96a075ea78be0ef71b4`
  - buildId `b62882c5a365`，资源哈希 `b62882c5a365d6cd2519`
  - 资源 **169 个**；7 个必需可靠性模块已断言存在；EXE 内 buildId 标记已验证
  - PE Manifest **requireAdministrator**（脚本断言通过）
- **实际启动验证**：本会话非提升，使用同一二进制临时改 manifest 为 asInvoker 后启动；`/api/health`、`/api/bootstrap` 返回上面的 buildId/commit，`mode=packaged`、`verified=true`；启动日志 `startup.begin` 记录同一 build；第二次启动复用缓存并校验 169 个文件。
- **仍不能声称**：真实 UAC 双击、提升后的出站请求、真实付费 Provider 已完成验收。
- 历史：v0.13.1（`ba917c52…` / 164 assets）已被本次构建取代；旧 EXE 仍可能存在于用户磁盘，必须用 buildId 判断。

## 6. 未完成 / 未验证

- 真实 UAC 双击 / 提升后的 EXE 运行未验收；asInvoker 副本已启动并验证 buildId（§5）。
- **v0.13.2 未用真实付费 API 验证** `max_completion_tokens` 是否被 DashScope 接受、思考模式是否仍默认开启、以及 24k 预算下 889 消息的 6 批是否能全部完成。
- **真实浏览器 UI 已在本轮补验**（headless Edge + CDP）：AI 中心运行中/完成、390px、暗色与 Provider 设置页；截图见 `docs/screenshots/ai-reliability-*`。未做真实点击“开始分析”（使用合成 Fixture 与 Mock Provider）。
- **真实付费 API 生成**：本机没有 `config/ai-providers.json` / `ai-keys.json` / 环境变量 Key，阻塞；不得用 Mock 或历史样本冒充。
- 真实 Provider 的 429、`Retry-After`、并发与 1,000 观众运行。
- 真实 DashScope/OpenAI/Anthropic/DeepSeek/MiniMax 生成与能力检测。
- 真实 174k token 大场的 token 分批与汇总（Mock 已覆盖 420 消息多批）。
- 真实 Bilibili/YouTube 大场自动画像；礼物/SC-only 真实样本。
- 真实运行中删除场次/清空数据的 UI 守卫与交互。
- M5 可移植备份仍未实现。

## 7. 关键规则（下一轮不要破坏）

1. `session` 与 `memory` 是独立任务、独立保存；单场报告成功不依赖画像，画像失败不覆盖报告。
2. **匿名免费 AI 已移除；手动提示词/JSON 导入入口已移除。** 只允许用户配置的 API Key + Provider。
3. `api_free` 模型永远不能执行 memory 任务；长期画像必须是付费 + 已知价格 + `capabilities.memory` + 用户 opt-in。
4. 付费/未知价格请求前必须 `confirmBilling`；未知价格不得当免费；不自动切换到更贵模型。
5. Provider 配置只保存 credentialReference；Key 只存加密凭据库；区域/Base URL 变化轮换引用。
6. 自定义 URL 必须通过私网/元数据/DNS 检查；localhost 只在显式 allowLocalNetwork 时允许。DNS 安全缓存最多 5 分钟。
7. 能力检测不能只看 HTTP 200；memory 必须用多观众 ref、证据归属、零发言与多语言探针。
8. 每位可识别观众必须有且仅有一条 `viewer_memory_updates`；缺失即导入错误。
9. 观众只分配到一个记忆批次，全部可用摘录随行；不得用 Top N 或最低活跃度裁剪。
10. 客观历史只由真实记录更新；AI 不能写金额/计数/时间/身份。导入一个 memory 批次时只更新本批分配的观众。
11. 语义事实必须有证据或明确推断/待确认；`stated` 必须有本观众的消息。
12. 无新语义 ≠ 未处理；`pending` 才是未处理。
13. 删除记忆后的旧包不能恢复；重复导入幂等。
14. 三语键三份一致；前端禁止 `innerHTML`；颜色只用 tokens。
15. 所有 Provider/模型输出必须走 `validateAnalysisImport()` + `importAnalysisResult()`；不能直接写库，不能降低 Schema。
16. 画像批次仍覆盖全部可识别观众；超出 `MAX_ANALYSIS_VIEWERS` 明确失败，不得静默裁剪。
17. **不得重新引入固定 2 RPM、匿名冷却、免费 Provider 自动切换或“手动复制 JSON”入口。**
18. 付费调度按 `configId` 隔离；没有虚构的统一 RPM/TPM。429 按 `Retry-After`，其他可重试错误指数退避 + 抖动。
19. 同一主播跨场次记忆必须按时间顺序；较旧场次不得覆盖较新场次。批次内并发只能发生在观众互不重叠的批次之间。
20. 运行失败只写状态/错误码；不删除已完成结果、不覆盖已有记忆；单场报告成功时画像失败只标 partial。
21. 手动导入失败不再由 UI 修复；历史结果仍可只读，重复导入仍幂等。
22. **超时/取消语义**：`TimeoutError` 与 `AbortError` 必须分开；已发出的长请求超时后默认不自动重发；用户取消/暂停绝不重试。
23. **任务级时间预算**：所有尝试受任务预算约束；达到后停止新请求并保留已完成批次，不得无限重试。
24. **批次隔离**：任何批次失败不得 abort 同批其他在途请求；已完成批次必须继续导入；恢复只处理未完成批次。
25. **Token 分批**：单场与画像按 input token 预算分批；默认 8k、可配 2k–32k；不得静默丢消息/观众；多批 session 必须有 final aggregate 才 complete。
26. **自动流式**：普通用户不选择 Streaming；流式只缓冲，完成后仍走同一校验/事务导入；不兼容时最多回退一次并持久化响应模式。
27. **统计诚实**：成功/失败/取消/超时/重试分开；失败无 usage 显示“用量未知”，不能当零费用；能力检测请求不计入分析任务。
28. **UI 证据**：`[hidden]` 必须真正隐藏；进度只用服务端批次/观众计数；ETA 需要 ≥3 个样本；不显示没有依据的预计。

## 8. 相关文档

`docs/AI_RELIABILITY.md`、`docs/AI_TIMEOUT_INVESTIGATION.md`、`docs/AI_SCHEDULER_AUDIT.md`、
`docs/HANDOFF.md`、`docs/ARCHITECTURE.md`、`docs/DATA_MODEL.md`、`docs/AI_CONTRACT.md`、
`docs/UI_DESIGN.md`、`docs/PRIVACY_SECURITY.md`、`docs/TEST_PLAN.md`、`docs/CHANGELOG.md`、
`docs/ROADMAP.md`、历史 `docs/ANONYMOUS_AI_RESEARCH.md`、`log/2026-11-11-ai-scheduler-v0131.md`、
`log/2026-11-12-ai-reliability-v0131.md`。

## 9. 下一步

1. 配置一个真实付费 API Key，按 `docs/AI_SCHEDULER_AUDIT.md` §5 的预算/授权流程完成小规模真实测试，记录 429、延迟与费用。
2. 在允许浏览器的机器上验收五步 AI 分析中心、请求统计、暂停/取消、暗色与 390px；补截图。
3. 在无策略限制的 Windows 环境运行 EXE，验证出站请求、代理/防火墙与打包 UI。
4. 用真实 Provider 跑 1,000 观众/10,000 消息，校准初始并发与批次大小。
5. 观察真实 429 后的并发恢复；如 Provider 明确公布 RPM/TPM，再增加可选官方限额配置，不预设统一值。
6. 评估自动运行中删除场次/清空数据的 UI 守卫。
7. M5 可移植备份仍未实现。

## 11. 2026-11-12 专项调查：DashScope 174/175 秒与 `PROVIDER_TIMEOUT`

完整报告：`docs/AI_TIMEOUT_INVESTIGATION.md`（含代码位置、脱敏日志、8 项逐条回答、复现条件、
影响、修复建议、仍需日志）。

- **根因**：`timeoutMs` 默认/配置/生效值均为 **180000 ms**；非流式 `qwen3.8-max` 长推理超过
  180 秒仍无响应头，客户端 `AbortSignal.timeout` 主动断开。平台记录 status 0、耗时 174–175 s、
  usage 空，是"客户端中断"的结果，不是平台 175 s 固定超时。
- **重试**：超时被标记为可重试，`requestOnce` 自动重发同一请求 2 次（3 次尝试）；
  本地总耗时 543.18 s ≈ 3×180 s + 打包/退避。平台两条 174/175 s 请求对应第 1、2 次尝试，
  应还有第 3 条约 23:39:57 开始。
- **为何"停滞"**：3 次重试期间状态一直是 `running / session_analyzing`，没有 attempt 级状态/日志；
  第 3 次超时后才写 `failed`（23:42:54）。
- **统计口径**：UI 总/失败请求 = 调度器尝试数（按 config、按进程，重启清零）；`usage.requests`
  只计成功响应（失败任务为 null）；平台按每个 HTTP 请求计数（含 status 0、能力检测的 4 个请求）。
- **未做**：未改代码/配置/超时，未发付费 API 请求，未提交修复。本机 PATH 无 `git`，无法创建
  本地 commit。

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

### 0.8 v0.13.0 付费 API Schema 故障修复（2026-11-11）

真实失败状态（隔离复现前，用户数据未修改）：

- `mode=session`，`sessionJobId` 存在，`error.code=AUTO_SCHEMA_INVALID`，detail=`protocol:SCHEMA_REQUIRED, task_id:SCHEMA_REQUIRED, session_id:SCHEMA_REQUIRED`。
- 配置实际为 DashScope `cn-beijing` / `qwen3.8-omni-flash`，`pricingStatus=paid`，`capabilities.session=true, memory=true`。
- 根因 1：UI 的 `mode=both` 在 HTTP 路由被映射成 session-only；长期画像任务从未创建。
- 根因 2：付费 Session 回答被直接交给完整 Schema 1.3.0 校验；模型只返回语义字段，缺少由本地生成的 protocol/task_id/session_id。
- 根因 3：能力检测只验证简单 JSON 形状，没有经过 Session 组装器、最终 Schema 1.3.0 和 Memory 组装器。

修复：

- `assembleSessionAnswer()` 本地注入 protocol/schema_version/analysis_scope/job_id/batch_id/task_id/session_id/locale/broadcaster_id；忽略模型伪造字段。
- `mode=both` 在 HTTP 与 Runner 规范化为内部 `combined`。
- 能力检测的 session/memory 阶段使用同一组装器并执行最终 Schema 1.3.0 校验。
- 报告页增加长期画像只读展示（`viewer_memories`/`memory_facts`）。

真实隔离端到端（不是 Mock）：

- DashScope `qwen3.8-omni-flash`，一场合成直播，`both`，2 次请求，5,671 输入 / 3,228 输出 tokens，估算 ¥0.0109928。
- `complete`；单场报告已保存；`viewer_memories=3`、`memory_facts=2`；报告 `longTermProfiles.count=3`（Mika 2 条事实，Ren/GiftOnly 客观记录）。
- 用户真实数据库未被读取为可写目标，测试使用复制的配置/密钥和独立临时数据目录，结束后删除。
