# 交接文档（HANDOFF）

本轮：2026-11-12 · v0.13.2 构建可验证 + 分批预算重平衡 · schema 13 · 结果 Schema 1.3.0

> 设计、边界、测试清单：`docs/AI_RELIABILITY.md`。前序根因：`docs/AI_TIMEOUT_INVESTIGATION.md`。
> 本轮**未发真实付费 API 请求**；EXE 以 asInvoker 副本启动验证 buildId，未做真实 UAC 双击。

## 0. 本轮（v0.13.2）

### 0.1 构建/版本识别

- 新增 `src/shared/build-info.mjs`：开发读 `.git/HEAD`；打包读 `build-info.json` + bootstrap 环境。`buildId = <commit7>.<sourceHash8>`。
- 构建脚本写入 commit / sourceHash（含 `scripts/sea-bootstrap.cjs`）/ assetHash / 每文件 SHA-256；断言 7 个可靠性模块存在；构建后检查 EXE 内含 buildId 与模块名。
- bootstrap 复用缓存前逐文件校验 169 个 SHA-256；不一致 `app-root.stale` 后删除重解压；解压后再校验；结果写入 `build.identity` 日志。
- 启动日志、`--version`、设置页「关于」、`/api/health`、`/api/bootstrap`、`/api/status` 均显示 build。
- **最终构建**：`89bf47ac620e` / commit `b101bd0` / SHA-256 `aa3d4110…` / 169 assets / requireAdministrator。asInvoker 副本实际启动后 `/api/health`、`/api/bootstrap` 返回同一 build，第二次启动 `filesVerified=169`。

### 0.2 分批预算

- 默认总输入预算 8k → **24k**；预算拆成 overhead / content / output reserve；内容至少 50%（且 ≥1k），不再让 6.9k 固定开销吃掉 8k。
- 真实 889 消息包：8k=24 批、16k=11 批、24k=**6 批**、32k=4 批；每档 889/889 覆盖；不再出现 125 批。
- 未回退 135k 单请求：上限 32k。
- 保护：aggregate 48k 硬上限 + 上下文检查；repair 只截断上次回答并显式 `ANALYSIS_REPAIR_TOO_LARGE`；单观众硬上限 48k；上下文不足 `ANALYSIS_CONTEXT_TOO_SMALL`。

### 0.3 输出/思考模式

- 官方文档确认 Qwen `max_tokens` 只限回答，思考另计；qwen3.8-max 默认 `reasoning_effort=xhigh`、`thinking_budget=131072`。
- DashScope 增加 `max_completion_tokens = 回答预算 + 16k`，不关闭思考；其他 Provider 不发送。
- attempt 日志新增 requestBytes / estimatedInputTokens / maxTokens / maxCompletionTokens / reasoningChars / reasoningTokens。

### 0.4 测试

- **597 passed / 0 failed**（约 93 秒）。新增 build-info、adapter output、repair guard；batching 增加 889/124 viewer/硬上限；bootstrap 增加缓存篡改重解压。
- 未验证：真实付费 API、真实 UAC 双击、`max_completion_tokens` 在百炼的实际接受度、889 消息真实回放。

### 0.5 任务完成优先（最终修订）

- 真实路径：15:48:40 第 7/7 批后已发出 aggregate；15:55:58 aggregate 在 435,770 ms 被 `maxTotalMs`（剩余任务预算）中止，20:00 标记 `ANALYSIS_TASK_TIMEOUT`。不是阻止汇总启动。
- **删除任务时间上限**：`createTaskBudget`、soft/hard deadline、`maxTotalMs`、按剩余时间缩短请求全部移除；任务可任意久运行。
- **删除费用预算**：预算输入/校验/确认、累计费用停止、价格未知阻止、免费/付费分类全部移除；价格仅可选展示。
- 单请求只保留首响应 `timeoutMs` 与 60 秒流空闲；超时/401/402/404/429/5xx/网络 → `needs_action`，已完成批次保留，可继续；用户取消立即 `canceled`。
- 规模：删除总批次/总消息/总观众拒绝；按单批 Token 自动拆分；仅保留单批 32k、单观众 48k、1M 消息/200k 观众极端内存保护。
- 测试 **603 passed / 0 failed**；新增可选价格与 2500 观众无总批次上限；`v14-task-budget` 改为无时间上限 + timeout needs_action + 汇总-only 恢复。

## 1. 上一轮：v0.13.1 可靠性专项

### 0.1 超时与重试

- `TimeoutError`、外部 `AbortError`（取消/暂停）、网络、429、5xx、4xx、无效响应、流中断现在由 adapter 分类；取消绝不重试。
- 已发出且超时的长请求**默认不自动重发**；只有连接阶段网络错误允许一次安全重试；429/5xx 保留有界退避。
- 任务级 20 分钟预算（**最终修订已彻底移除**；现在只有单请求首响应/空闲超时）。
- `runPool` 失败只停止调度新批次，在途兄弟批次继续完成并导入；恢复只处理未完成批次。
- 每次尝试写 `ai.request.attempt` 脱敏日志；状态新增 `attemptStats`、`currentRequest`、`lastRequest`、`taskDeadlineAt`、`saved`。

### 0.2 Token 分批与流式

- `src/ai/batching/tokens.mjs`：session 消息与 memory 观众按估算 input token 分批；v0.13.1 默认 8k（**v0.13.2 已改 24k，并分离固定开销**），配置 `batchInputTokens` 2k–32k，小上下文自动缩小。
- 多批 session 需要 final aggregate；聚合 prompt 只使用已校验批结果，证据必须 `{batch, seq}`。
- memory：同一观众不拆批，预算计入摘录/现有记忆/证据列表；超预算观众单独成批，不丢人。
- 自动流式：OpenAI-compatible SSE + Anthropic Messages SSE；Provider 返回 JSON 或拒绝 stream 时自动回退一次并持久化响应模式。
- 流式只缓冲，完成后仍走原校验/事务导入；中断流不写库。

### 0.3 UI 与统计

- AI 中心新增：单场批次 n/N、等待汇总、已收到模型输出、请求运行秒数、重试状态、已保存批次、真实失败原因。
- 统计分开：尝试/成功/失败/取消/超时/重试；失败无 usage 显示“用量未知”。
- ETA 需要 ≥3 个成功批次样本；含 session 的任务不再显示错误的固定“1 个请求”，改为自动分批。
- 修复全局 `[hidden]` 被 `.callout {display:flex}` 覆盖的问题。
- 真实浏览器（headless Edge + CDP）截图：运行中、完成、390px、设置页；见 `docs/screenshots/ai-reliability-*`。

### 0.4 测试

- 全量 **583 passed / 0 failed**（约 96 秒）。
- 新增 `ai-attempts`、`ai-stream`、`ai-token-batching`、`v14-session-batching`、`v14-streaming-timeout`；更新 `ai-progress`。
- 未验证：真实付费 API、真实 174k token 大场、真实 EXE/UAC。

## 1. 上一轮：七项实际使用修复（2026-11-11）


| # | 问题 | 结论/修复 | 验证 |
| --- | --- | --- | --- |
| 1 | 历史跳转未选中场次 | `query.session` 按稳定 id 选中；不在前 100 行时按 id 加载；手动选择更新 URL | `ai-selection` + 静态 UI |
| 2 | 已配置 Key 仍显示未配置 | `providerConfigState()` 区分无配置/缺 Key/测试失败/未检测/缺价格；删除历史文案 | `ai-config-state` + Provider 列表 |
| 3 | 无实时进度 | 批次/观众计数进度条 + 不确定动画 + 1.5s 轮询 + statusEpoch | `ai-progress`、`v13-progress`；真实浏览器未验收 |
| 4 | `Memory No viewers` | combined 无观众保留单场报告并显式跳过；memory-only 明确错误；状态含 `memorySkipped` | `v13-api-runner` |
| 5 | 报告重复 | `reportEpoch` 单飞，只有一个挂载点 | 静态 + 报告并发守卫 |
| 6 | Bilibili 未开播无主播名 | `Master/info` 公共回退；target 持久化并低频重试 | 真实房间 3 未开播 → `3号直播间` |
| 7 | 手动停止后自动恢复 | `live_stopped` + `meta.manualStop` 持久抑制；确认离线/新 live cycle 才解除；重启保持 | 场景 A–G 测试 |

新增文件：`src/web/js/pages/ai-progress.js`、`ai-config-state.js`、`ai-selection.js`；`tests/unit/ai-progress.test.mjs`、`ai-config-state.test.mjs`、`ai-selection.test.mjs`、`bilibili-master-info.test.mjs`；`tests/integration/v13-progress.test.mjs`、`manual-stop-monitor.test.mjs`。

修改重点：`src/web/js/pages/ai.js`、`src/ai/api/runner.mjs`、`src/monitoring/manager.mjs`、`model.mjs`、`detectors/bilibili.mjs`、`src/platforms/bilibili/api.mjs`、`service.mjs`、`src/server/session-admin.mjs`、`src/web/js/pages/live.js`、三语 i18n。

真实 Bilibili 只读验证：房间 `3` → `23058`，未开播，`displayName=3号直播间`、`platformUid=11153765`。真实浏览器/EXE 仍受阻；未伪造。

### Bug 8：已保存 API 配置可编辑

- 设置页配置卡新增「编辑配置」；复用同一表单，预填名称/Provider/区域/Base URL/模型/价格/并发/本地网络。
- API Key 输入默认留空并显示「已保存」；只有输入新 Key 才发送 `apiKey`，空字符串不覆盖旧 Key。
- 只改 Model ID：同一 `configId`、默认标记、credentialReference 保留；旧能力/测试状态/价格/contextLength 失效；新任务使用新模型。
- 改 Provider/区域/Base URL：轮换 credential reference，必须重新输入 Key；不允许静默复用旧密钥。
- 运行中任务：禁止编辑/删除其配置（409 `AI_PROVIDER_CONFIG_IN_USE`）；旧 job 的模型/区域变化后 `resume` 拒绝（409 `AI_PROVIDER_CONFIG_CHANGED`），新任务用新配置。
- 测试：`v13-providers`（store 行为/重启持久化）、`v13-provider-edit`（HTTP/运行中/新模型）、`ai-settings-edit`（UI/安全静态）。

## 2. 上一轮结果（v0.13.1 入口与调度）

| 目标 | 结论 |
| --- | --- |
| 付费 API 是否被免费限速影响 | **没有。** 2 RPM 只存在于旧匿名路径 `src/ai/auto/`；付费 `src/ai/api/runner.mjs` 未使用该 limiter。完整证据见 `docs/AI_SCHEDULER_AUDIT.md`。 |
| 删除匿名免费 AI | **已实现。** 删除 `src/ai/auto/`、`/api/ai/auto/*`、UI 入口、免费价格状态、匿名 Provider 配置与自动切换。 |
| 删除手动 AI | **已实现。** UI 不再有创建包/复制提示词/下载 ZIP/粘贴 JSON/上传 JSON/手动导入/修复指令；对应 HTTP 写路由删除。 |
| 单一 AI 分析入口 | **已实现。** 五步：选择直播 → 选择 API 配置 → 选择内容 → 费用/预算确认 → 开始 AI 分析。 |
| 保留多 Provider | **保留。** OpenAI、Anthropic、DeepSeek、MiniMax（cn/intl）、阿里云百炼（4 区域）、OpenRouter、自定义 OpenAI-compatible。 |
| 安全并发 | **已实现。** 每个 config 独立调度器；初始并发可配置 1–8，默认 3；画像批次有界并发。 |
| 429 / Retry-After | **已实现。** 429 减半并发并按 `Retry-After` 暂停该 config；5xx/408/425 短暂暂停；指数退避 + 抖动。 |
| 删除固定 30 批上限 | **已实现。** 改为 `ceil(MAX_ANALYSIS_VIEWERS / 10) + 1`（2,001）。 |
| 跨场次记忆顺序 | **已实现。** 同一主播记忆 gate；较新场次已导入后拒绝较旧场次（`ANALYSIS_MEMORY_OUT_OF_ORDER`）。 |
| 性能统计 | **已实现。** 请求/完成/失败/并发/排队/模型耗时/排队等待/限流等待/429/p50/p95/token/费用/ETA。 |
| 本地性能修复 | **已实现。** 每批只更新本批观众；DNS 安全检查缓存 5 分钟；精确 `getJobPackage()` 查询。 |
| 全量测试 | **548 passed / 0 failed**（约 73 秒）。 |
| Mock 规模测试 | **1,000 观众 / 10,000 消息：100 批、6.5 秒、峰值并发 6、覆盖 1,000/1,000。** |
| 真实付费 API | **阻塞**：本机没有 Provider 配置/密钥/环境变量。未伪造成功。 |
| EXE | **已重新构建 v0.13.1**（91.5 MB / 164 assets / SHA-256 `ba917c52…` / requireAdministrator），包含七项修复与配置编辑；**未能运行**（UAC 拒绝）。 |

## 3. 关键文件

### 新增

| 文件 | 职责 |
| --- | --- |
| `src/ai/runtime/json.mjs` | Provider 无关的 JSON 提取、取消 sleep、Retry-After 解析、退化检测 |
| `src/ai/runtime/state.mjs` | 本地任务状态恢复（不含提示词/聊天正文） |
| `src/ai/runtime/scheduler.mjs` | 按 config 隔离的请求调度器、动态并发、429 冷却、指数退避 |
| `docs/AI_SCHEDULER_AUDIT.md` | 免费限速调查结论、代码位置、新调度、Mock 时间线 |
| `scripts/benchmark-mock-scale.mjs` | 大规模 Mock 性能基准 |
| `tests/unit/ai-scheduler.test.mjs` | 并发上限、429 隔离、取消、退避 |
| `tests/integration/v13-scheduler.test.mjs` | 429 Retry-After、画像并发、失败恢复、跨场次顺序 |

### 修改

- `src/ai/api/runner.mjs`：删除匿名 Provider；必须 `configId`；调度器；有界并发；`Retry-After`；请求统计；记忆顺序 gate；精确包查询；1,000 观众批次上限。
- `src/ai/providers/adapters.mjs`：`ProviderHttpError` 携带 `retryAfterMs`；5xx/408/425 可重试。
- `src/ai/providers/catalog.mjs`：删除 `ANONYMOUS_FREE`。
- `src/ai/providers/store.mjs`：新增 `concurrency`（1–8）与 `timeoutMs`（10–600 秒）。
- `src/ai/providers/pricing.mjs`：文档删除匿名状态。
- `src/storage/repositories/ai-packages.mjs`：新增 `getJobPackage()`。
- `src/ai/import/importer.mjs`：memory 批次只更新本批观众，避免 O(批次×观众)。
- `src/server/index.mjs`：删除 `AutoAnalysisRunner` 生命周期。
- `src/server/routes.mjs`：删除匿名/手动写路由；保留只读任务/报告/结果。
- `src/web/js/pages/ai.js`：五步单入口；请求统计；暂停/取消；错误原因。
- `src/web/js/pages/ai-settings.js`：删除匿名价格；新增并发数。
- 三语 i18n：新增 `ai.center.*`、并发文案、`errors.aiProviderConfigRequired`；删除 `ai.auto`、手动/匿名方法。
- README、STATUS、HANDOFF、ROADMAP、ARCHITECTURE、AI_CONTRACT、TEST_PLAN、PRIVACY_SECURITY、CHANGELOG、日志。

### 删除

- `src/ai/auto/` 整个目录（匿名 provider、2 RPM limiter、runner、prompt、assemble、errors、client、state）。
- `src/web/js/pages/ai-import-repair.js`。
- 旧匿名/手动测试：`auto-analysis`、`auto-api`、`auto-compact`、`auto-client`、`auto-prompt`、`auto-assemble`、`manual-52-viewers`、`ai-import-repair`。

## 4. API 变化（v0.13.1）

保留：

```text
GET  /api/ai/providers
GET  /api/ai/providers/models
POST /api/ai/providers/configs
PATCH/DELETE /api/ai/providers/configs/:id
POST /api/ai/providers/configs/:id/default
POST /api/ai/providers/configs/:id/test
POST /api/ai/analyze/run
GET  /api/ai/analyze/status
POST /api/ai/analyze/pause|cancel|resume
GET  /api/ai/jobs                 (只读)
GET  /api/ai/jobs/:id             (只读)
GET  /api/ai/packages             (只读)
GET  /api/ai/sessions/:id/report
GET  /api/ai/results/:id
GET  /api/ai/results/:id/download
```

删除：

```text
POST /api/ai/jobs
POST /api/ai/jobs/:id/aggregate
POST /api/ai/packages
GET  /api/ai/packages/:id/download
GET  /api/ai/instructions
POST /api/ai/import/preview
POST /api/ai/import
GET/POST /api/ai/auto/services|status|run|cancel
```

## 5. 关键规则（下一轮不要破坏）

1. 匿名免费 AI 与手动 JSON 入口已删除；不要重新加回。
2. `session` 与 `memory` 独立保存；画像失败不覆盖单场报告。
3. `api_free` 永远不能执行 memory；付费必须价格已知 + `capabilities.memory` + opt-in。
4. 付费/未知价格必须 `confirmBilling`；未知价格不当免费。
5. 所有模型输出必须走 `validateAnalysisImport()` + `importAnalysisResult()`。
6. 每位可识别观众恰好一条 `viewer_memory_updates`；批次不拆散观众。
7. 客观历史只由真实记录更新；memory 批次只更新本批观众。
8. 同一主播跨场次按时间顺序；较旧场次不得覆盖较新记忆。
9. 调度按 `configId` 隔离；不虚构统一 RPM/TPM；429 按 `Retry-After`。
10. 初始并发可配置 1–8，默认 3；不得无上限并发。
11. Key 只存加密凭据库；不进入 JSON/日志/ZIP/DB/HTML。
12. 自定义 URL 私网/元数据/DNS 检查保留；DNS 安全缓存最长 5 分钟。
13. 历史报告与长期画像仍可只读；旧 1.0–1.2.0 结果仍可读。
14. 三语键一致；前端禁止 `innerHTML`、`alert()`、硬编码可见文案。
15. **已发出的长请求超时后不要自动重发；用户取消/暂停绝不重试。** 超时、截断、退化、流中断都不是“重试就能好”。
16. **任务完成优先：没有任务时间/费用/批次总量上限；只有单请求首响应/空闲超时、单批 Token 上限与极端内存保护。错误进入 needs_action 并保留已完成批次；用户取消立即生效；`runPool` 失败只停调度，不得 abort 在途兄弟批次。**
17. **多批 session 必须有 final aggregate 才 complete；汇总证据必须 `{batch, seq}`。**
18. **批次输入按 token 预算（默认 8k，可配 2k–32k）；不得丢消息或观众；同一观众不拆批。**
19. **Streaming 由程序自动选择；只缓冲，完成后仍校验/事务导入；不兼容最多回退一次。**
20. **统计分开成功/失败/取消/超时/重试；无 usage 显示“用量未知”，不能当零费用。**

## 6. 未验证 / 边界

- **真实付费 API 阻塞**：本机没有 `config/ai-providers.json`、`secrets/ai-keys.json` 或环境变量 Key。
- 真实浏览器 UI 已用 headless Edge + CDP 验收运行中/完成/390px/设置页；截图见 `docs/screenshots/ai-reliability-*`。未用真实 Provider 点击“开始分析”（使用合成 Fixture）。
- EXE 已重新构建但 UAC 拒绝运行；未验证打包后的流式连接与出站请求。
- 真实 Provider 的 429/Retry-After、1,000 观众、流式 usage、费用与延迟未测试。
- 真实 174k token 大场的 token 分批与 final aggregate 未运行；Mock 已覆盖 420 消息多批。
- 部分 Provider 的 `stream_options.include_usage` 支持未知：流式 usage 可能缺失，界面显示“用量未知”。
- 汇总请求仍可能因批次结果过多超过小上下文模型；会明确失败并保留批次。
- 调度器默认 3 并发是安全起点，不是官方额度；过高可能触发 429。
- 429 冷却上限 300 秒；更长要求会失败而不是无限等待。
- 预算在请求后累计；并发请求可能同时越过上限。
- 5 分钟 DNS 缓存窗口内 DNS 变化不会被立即发现。
- `src/ai/export/job.mjs`、`package.mjs`、`prompts/instructions.mjs` 仅作为历史兼容/测试的内部构建器保留，无 UI/HTTP 入口；如后续确认无历史需求可再删除。

## 7. 常用命令

```bat
node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"
node scripts/benchmark-mock-scale.mjs 1000 10000 6
node src/launcher/launcher.mjs --no-open
node scripts/build-windows.mjs
```

## 8. 本轮 Commit

- 功能/测试/文档提交：见最终答复的本地 commit hash（未 Push）。
