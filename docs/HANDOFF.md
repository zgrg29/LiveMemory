# 交接文档（HANDOFF）

本轮：2026-11-14 · RC0 P0-4 YouTube 暂时性故障误判结束修复 · schema 16 · 结果 Schema 1.3.0 · 提示词 v13.2

> 本轮未修改生产数据库、未访问真实 YouTube 做长时断网测试、未调用真实付费 AI、未干扰正在采集的直播。自动化使用 `tests/.tmp` 隔离数据与本地假 YouTube 网页；正式 EXE 的本地假服务验证见 §0.4。

## 0. 本轮（P0-4 YouTube 暂时性故障误判结束）

完整证据：`log/2026-11-14-youtube-lifecycle-p0.md`。

### 0.1 原始故障与根因

1. `parser.mjs` 把 HTTP 200 缺 `continuationContents` 解析为 `ended:true, invalid:true`；adapter 只看到 `ended` 就 `#finish('chat_ended')`。
2. `adapter.mjs` 在 429/网络/5xx 连续 8 次后 `#finish('connection_failed')`；`SessionManager` 随即将 `sessions.status` 写成 `ended`。
3. 观看页只读一次 `state='ended'`（甚至 `'video'`）就结束，没有二次确认；`onEnd` 后缺少 generation 失效保护。
4. `openChat` 刷新失败后继续 poll 同一个 stale continuation；有 actions 但无新 token 的响应被当作成功并复用旧 token。
5. `PLATFORM_INTEGRATIONS.md` 与代码相反；错误文案仍建议使用已删除的官方 API。

### 0.2 修复

- `src/platforms/youtube/anonymous/parser.mjs`：缺 `continuationContents` / `liveChatContinuation` / 新 continuation 一律 `invalid:true, ended:false` + `invalidReason`；异常页中可读 actions 先入库，再作为可恢复结构错误处理。
- `src/platforms/youtube/anonymous/adapter.mjs`：
  - 429/5xx/网络/异常 200 只进入 `reconnecting` → 阈值后 `failed`（`retrying/recoverable/sessionPreserved`），继续 60 秒上限退避；429 至少 30 秒且尊重 `Retry-After`；**绝不 `onEnd`**。
  - 观看页 ended 二次确认（约 2 秒）→ `platform_ended`；聊天页 ended/disabled 需观看页 ended 或第二次聊天页相同结果 → `chat_ended`/`chat_disabled`。
  - 确认期间 `platform_status=ending`；确认失败回到 live/unknown，不伪造结束。
  - stale continuation 丢弃旧 token，先 `openChat` 再 poll；失败只退避重取。
  - 每 adapter 一个 poll timer + 一个结束确认 timer + 一个元数据请求；`onEnd` 最多一次；`stop()` 清全部 timer。
- `src/platforms/youtube/errors.mjs`、`client.mjs`、`service.mjs`：新增 `YOUTUBE_WEB_RESPONSE_INVALID`；`openChat`/`getVideo` 的 5xx 归为可重试网络错误。
- `src/server/index.mjs`：`youtubeAdapterOptions` 测试注入；`LIVE_MEMORY_TEST_YOUTUBE_WEB_BASE` 仅允许 loopback，用于正式 EXE 假服务回放。
- `src/web/js/pages/shared.js`、`live.js` + 三语 i18n：可恢复连接状态、最近故障、数据保留说明、聊天结束/关闭结束原因；移除「改用官方 API」的过期文案。
- **未改** Bilibili adapter、共享 `SessionManager`/`EventIngest`、数据库 schema、AI 架构。

### 0.3 修复前复现与测试

- 修复前 `tests/unit/youtube-lifecycle-regression.test.mjs` **7/8 失败**：429、连续网络失败、500/502/503、缺 continuationContents、异常 200、stale token 复用、单次 ended/`video` 全部触发 `onEnd`。
- 修复后新增 **10 个 unit + 2 个 integration**；全量 **721 passed / 0 failed**（192,929 ms，2026-11-14）。
- 集成测试使用真实 server/SessionManager/SQLite + 假 YouTube 网页，验证：同一 session、同一 viewer、消息不丢、replay 去重、单轮询器、平台结束只一次、用户停止独立。

### 0.4 正式 EXE 与本地假 YouTube

- **正式构建**：`dist/LiveMemory.exe` buildId `59b7928cb78a` / commit `31886b2` / SHA-256 `e9fe576931a0562a7969afa3bba188a3418b95374ca68c2d75d09bc6d8805b2f` / 96,419,840 bytes（92.0 MB）/ 176 assets / `requireAdministrator` / builtAt 2026-11-14T03:28:37.819Z。
- **回放**：asInvoker 测试副本（仅测试设置 `LIVE_MEMORY_SKIP_ADMIN_CHECK=1` 与 `LIVE_MEMORY_TEST_YOUTUBE_WEB_BASE=http://127.0.0.1:<port>`）+ 本地假 YouTube，EXE 内 buildId/commit 与 `/api/health` 一致。
  - 正常采集 3 条消息 / 2 位观众 → 关闭假 YouTube **180,513 ms**；
  - 断连期间 session 仍 `live`、消息数仍 3、无第二个 session、无结束；
  - 恢复后同一 session 继续到 4 条；stale 重放 `msg-1` 去重（事件行 5 / 唯一 5）；
  - 明确 ended → `platform_ended`、`platform_status=ended`、结束前后计数一致、房间 1 条 session。
- **性质**：这是正式 EXE + 本地 Mock 服务的确定性回放，不是真实 YouTube 网络断网，不是 UAC 双击，不是真实浏览器点击。

### 0.5 P0-4 结论与下一轮 P0-5 交接

- **P0-4 代码级可关闭**：根因确认、修复前失败可复现、修复后 12 个专项用例 + 721 全量通过；Bilibili 生命周期测试 53 项通过；无 schema/生产数据改动。
- **待用户验收**：真实 YouTube 直播的 429/断网 3 分钟/恢复、真实长直播、真实 UAC 双击、真实浏览器点击。
- **下一轮 P0-5「本地 HTTP API 无鉴权 + 管理员进程」交接**：
  - 现状：服务只监听 `127.0.0.1`，但所有 `/api/*` 无认证；仅对带 `Origin` 的写请求做同源校验（`src/server/app.mjs`）。本机任意进程可省略 `Origin` 直接调用 GET/POST/PATCH/DELETE。
  - 发布 EXE 以 `requireAdministrator` 运行，因此上述请求会以管理员权限执行（改设置、停止/删除场次、迁移数据目录、读取观众与聊天数据）。
  - 建议复现：从普通 PowerShell 直接 `PATCH /api/settings`、`POST /api/sessions/:id/stop`、`GET /api/viewers`、`POST /api/storage/location`（先只读/测试数据目录），确认无 token 也成功；再用非管理员进程验证权限继承。
  - 建议修复方向（需单独评审）：启动器生成每次运行随机 token；通过同源 `HttpOnly; SameSite=Strict` cookie 或 bootstrap 注入 + `Authorization` 校验所有 `/api/*`；SSE 同样校验；拒绝 `Origin: null` 与缺失 token；限制 CORS；把危险操作（迁移/删除/恢复出厂）放到需要用户确认的独立高权限 broker，而不是让任意本地 HTTP 调用提升权限；对 `runtime/` 与数据目录做 ACL 收紧。
  - 不要在本轮顺手加认证：会牵涉启动器、浏览器引导、SSE、测试与用户体验，需要独立回归。

### 0.6 不要做

1. 不要把 429/5xx/网络/异常 200 重新当作结束；结束必须有可确认证据。
2. 不要为了让测试通过把 `continuationContents` 缺失改回 `ended:true`。
3. 不要用无限高频重试代替“不误判结束”；保持指数退避、上限与用户停止能力。
4. 不要在重连时新建 session、清空 continuation/消息/观众，或绕过 EventIngest 去重。
5. 不要修改 Bilibili 的结束判定来“统一”两平台；如需改共享代码，必须补跨平台回归。

## 0.8 上一轮（P0-1 定向补答回归修复）

完整证据：`log/2026-11-14-ai-memory-supplement-p0.md`。

### 0.1 原始故障与根因

- 上一轮 RC0 审计 P0-1 已复现：首答漏 1 位观众时，`generateMemoryAnswer()` 发出的补答只含缺失 ref，但补答回来后用 `evaluate(repaired.content)` **按全量 refs** 组装/校验。
- `assembleMemoryCompact()` 只有在所有 refs 都出现时才 `ok`；补答只含缺失 ref，必然被判“首答已覆盖的观众缺失”，整批 `AI_IMPORT_INVALID`。
- `mergeMemorySupplement()` 已存在但无调用者；补答失败时首答中已合法观众被整批丢弃，也不走 viewer salvage。
- 结果：模型漏写 1 人 → 批次永久失败；每次 Continue 重发首答 + 补答 2 个付费请求且不收敛。
- 同路径独立缺陷：定向补答只发送 `evidence_seqs`，没有发送缺失观众的聊天摘录，模型无法根据真实文本补答。

### 0.2 修复

- `src/ai/api/runner.mjs`：
  - 补答按 `missingEntries` 子集组装/校验，不再按全量 refs；
  - 补答完整时用 `mergeMemorySupplement()` 合并首答 + 补答，再做一次完整校验；
  - 补答仍缺失/错误观众/非法 JSON/空响应/截断/Provider 错误/提示词超限时，保留首答中每个单独合法观众；只把仍缺失观众标记 `failed`，Resume 只请求这些观众；
  - 补答空/截断计入 `outputStats`；新增 `supplement.merged/partial/failed/too_large` 日志。
- `src/ai/api/prompts.mjs`：定向补答附带缺失观众的 `viewer_excerpts.jsonl`（按 stable `viewer_id` 过滤、注解 ref），不重发其他观众正文。
- 未改 schema 16、结果 Schema 1.3.0、提示词 v13.2、Provider/调度/翻译/汇总/金额/身份/去重规则。

### 0.3 验证

- 新增 `tests/integration/ai-memory-supplement-regression.test.mjs` **10 项**：
  - 首答漏 1 人 + 补答完整 → 2/2、双事实、2 请求、重复 Continue 0 请求；
  - 补答仍缺/错误观众 → 首答保存、缺失观众 failed，Resume 只请求它；
  - 首答完整 → 1 请求、无补答；
  - 补答部分覆盖 → 两份答案的合法观众都保存；
  - 跨观众证据 → 拒绝、首答保留、重试完成；
  - 重复事实 → 引擎去重；
  - 非法 JSON / 空 + length → 首答保留、可恢复；
  - 重启 Resume → 旧结果/事实不变，只请求失败观众；
  - 3 批并发 + 1 批补答非法 → 兄弟批次完成，Resume 只补 1 人，30/30 不重复。
- 全量 **708 passed / 0 failed**（2026-11-14，186,397 ms）。

### 0.4 正式 EXE 与真实数据只读副本

- **正式 EXE**：`dist/LiveMemory.exe` buildId `e441070b57b5` / commit `81be9cd` / SHA-256 `27c0bfbe9227ed15693370c999df0fda7d3d39ffafbffc0b7b9c2ab2a9eb6e58` / 91.9 MB / 176 assets / `requireAdministrator`。
- **回放**（asInvoker 测试副本 + 生产数据只读副本 + 本地 Mock Provider）：
  - 会话 `ses_01M7ACPCM8YB56VCV82S`，新建 memory job `aij_01M7BZPKAJ8WMYGZA8BS`（89 人 / 9 批）。
  - 首轮：批次 2 首答故意漏 1 人、补答返回非法 JSON → `partial`、88/89、8/9 批、10 请求；`bilibili:335118245` failed；首答其余 9 人已保存。
  - 关闭 EXE 后重启同一目录：health 同 build；仍 `partial`、`canResume=true`、88/89。
  - Resume：只 1 次请求、仅失败观众；`complete`、89/89、9/9、requests 10→11；批次 1/3–9 未重发。
  - 回放前 503 条 `ai_results` 全部保留；事实 1,007→1,095→1,096；新 job 10 条结果（9 v1 + b2 v2）；89 条新事实；无重复事实；再次 Resume 0 请求。
- **性质**：正式 EXE + 真实数据只读副本 + Mock Provider 的确定性回放；不是真实付费 Provider 验收，不是生产任务 Resume。

### 0.5 P0-1 结论与下一轮 P0-4 交接

- **P0-1 代码级可关闭**：根因确认、修复前失败可复现、修复后 10/10 回归 + 708/708 全量通过；无 schema/历史数据改动。
- **待用户验收**：真实付费 Provider 的补答质量、真实生产任务 Resume、真实 UAC 双击、真实浏览器点击。不得把 Mock/只读副本写成真实验收。
- 下一轮 **P0-4 YouTube 误判结束** 原始证据：
  - `src/platforms/youtube/anonymous/adapter.mjs:324-333`：429/网络错误也累计到 `maxConsecutiveFailures=8`，随后 `#finish('connection_failed')`。
  - `src/platforms/youtube/anonymous/adapter.mjs:284-288`：`page.ended` 立即 `#finish('chat_ended')`。
  - `src/platforms/youtube/anonymous/parser.mjs:249-258`：HTTP 200 缺 `continuationContents` 返回 `{ended:true,invalid:true}`，adapter 未使用 `invalid`。
  - `docs/PLATFORM_INTEGRATIONS.md:267` 与代码相反。
- 建议：先 Mock 复现；`invalid:true` 按 transient；429/网络/5xx 达阈值进入 FAILED/RECONNECTING 保留 session，不调用 `onEnd`；明确 `chat_ended` 才结束；至少两次独立证据；补 429/断网/异常 200 测试并修正文档。

### 0.6 不要做

1. 不要为了“让任务成功”重发已保存观众/批次。
2. 不要把补答失败降级为“整批成功”；缺失观众必须保持 `failed/pending` 可恢复。
3. 不要绕过 `validateAnalysisImport()` 的完整校验（Schema/身份/证据/覆盖）。
4. 不要给补答增加无上限 token 或无限重试；补答仍只有一次。
5. 不要修改生产数据库或自动 Resume 生产任务；需要用户明确授权与备份。

## 0.7 上一轮（长期画像输出预算、截断恢复与观众级断点）

完整证据：`log/2026-11-13-ai-memory-output-recovery.md`。

### 0.1 真实根因

- 任务 `aij_01M7AJ05B5E2VRG9Z82G`：100 批、975 人；17 条成功结果（1–11、13–18），批次 12 的 10 人与后续 812 人 pending。
- 批次 12 与更早的批次 4 都以 HTTP 200 + `empty-content` 失败（约 33–35 秒无文本），`retry=false`；批次 4 在用户继续后成功。不是批次 12 输入过大导致的确定性问题。
- 适配器空文本时抛 `PROVIDER_RESPONSE_INVALID` 并丢弃 `finish_reason`/usage；length 截断无法识别，也不会自动重试。
- UI 的 `length` 是上一子任务（session aggregate）13:35:54 的陈旧 `lastOutputRejection`；批次 12 错误本身 finishReason=null。b12 是否 length 未持久化，属于推测。
- 分批只看输入；输出固定 6,000；没有拆分映射；进度把任意子结果当批次完成；elapsedMs=null 显示 0。
- 17 个成功批次是并发乱序完成，不是按序号跳过。

### 0.2 实现

- `src/ai/batching/tokens.mjs`：`estimateMemoryViewerOutputTokens`、`resolveMemoryOutputTokens`、输出感知 `planMemoryViewerBatches`、上限 8,192。
- `src/ai/export/split-jobs.mjs`：观众输出成本、批次 `output_budget_tokens`、`estimated_output_tokens`、`max_facts_per_viewer`。
- `src/ai/prompts/split.mjs`：三语事实/证据上限（12 条/人，1–3 证据/事实）。
- `src/ai/providers/adapters.mjs`：保留 finishReason/reasoningChars/usage/metrics；空 + length → `AUTO_OUTPUT_TRUNCATED`；空 + 非 length → `PROVIDER_RESPONSE_EMPTY`。
- `src/ai/runtime/attempt.mjs`：空响应自动重试 1 次；截断不在传输层重试。
- `src/ai/api/runner.mjs`：失败 usage 归属、`recoveryStats`、有界拆分/预算提升、成功子结果立即导入、连续 3 个输出失败停止调度、`lastOutputRejection` 按 Job 隔离、elapsedMs null 修复。
- `src/storage/database/migrations/index.mjs` + `ai-jobs.mjs`：schema 16 `split_path/split_reason`、事务写入、状态读模型。
- `src/ai/tasks/status.mjs` / `recovery.mjs`：计划批次覆盖计数、splitBatches/pendingSplitBatches/splits。
- `src/web/js/pages/ai.js` + 三语 i18n：截断/空响应/自动重试/拆分进度/子批次路径/恢复文案。
- 文档：STATUS、HANDOFF、ROADMAP、AI_CONTRACT §25、DATA_MODEL §19、TEST_PLAN §36、CHANGELOG、本文件、日志。

### 0.3 验证

- 全量 **698 passed / 0 failed**（约 188 秒）。
- 真实任务只读副本 + Mock：17/100、153/975 → complete 100/100、975/975；只请求 b12、19–100；b12 自动拆 12.1/12.2；旧 17 条结果 id/version 全部保留；再次继续 0 请求。
- EXE：`dist/LiveMemory.exe` buildId `4b697b2cb227` / commit `ab32386` / SHA-256 `de9ddc18d6856a8d79df56673ac4e6fff76d56ccd15521020860247631855b44` / 91.9 MB / 176 assets / `requireAdministrator`。asInvoker 测试副本 + 本地 Mock Provider + 生产数据副本实跑：health 同 build；旧任务 `17/100`、`153/975`、`resume-memory`；Resume 后 `complete`、`100/100`、`975/975`、85 次 Provider 请求、b12 自动拆 `12.1/12.2`、旧 17 条结果保留、facts 252。
- 未验证：真实付费 DeepSeek Flash、真实生产任务 Resume（需用户授权）、真实 UAC 双击、真实浏览器点击；b12 原始 finish_reason 未保存。

### 0.4 生产恢复步骤

1. 完全退出 LiveMemory；备份整个数据目录（不要在运行时复制写入中的 SQLite）。
2. 替换为包含本轮修复的 EXE；设置页「关于」核对 buildId。
3. 打开 AI 分析中心，选择 `ses_01M77TP9QYPFRE4H9NCH`；应显示 17/100 批、153/975 人、822 待处理、「继续未完成画像」。
4. 选择与失败任务相同的 DeepSeek / global / deepseek-flash；点击继续。只处理批次 12 与 19–100 的待处理观众，不会重发已保存批次/观众。
5. 若仍失败，查看技术详情：`AUTO_OUTPUT_TRUNCATED` 会显示拆分子批次路径；`PROVIDER_RESPONSE_EMPTY` 表示已自动重试一次仍为空。不要新建整场分析、不要清空数据。
6. 成功后任务 complete、恢复面板消失；已保存事实不会重复写入。

### 0.5 下一轮注意

1. 不要为了“让任务成功”重新发送已保存的 17 个批次/153 位观众，也不要按“从失败批次之后全部重跑”。
2. `split_path` 是恢复边界；修改拆分算法时必须保持原 `batch_index`、证据 seq、事实 id/topic 不变。
3. 空响应自动重试只允许 1 次；截断必须先缩小批次或单观众预算，不得无上限提高 max_tokens。
4. 新增输出错误码时同步更新 `runner.mjs`、`recovery.mjs`、`ai.js`、三语 i18n 与测试。
5. 正式 EXE 已更新；后续改代码必须重建。

## 0.8 上一轮（分层汇总与 32 批恢复）

完整证据：`log/2026-11-13-ai-hierarchical-aggregate.md`。

### 0.1 真实根因

- 任务 `aij_01M7AD29G42TSN0DCFXA`：DeepSeek Flash，32/32 批次已保存，final 缺失，`ANALYSIS_AGGREGATE_TOO_LARGE`。
- 失败详情 `estimated 64471 input tokens, limit 48000`；`contextLength=null`。旧代码把全部 32 个 batch results 放进一个 final 请求，compact 后仍 64,471 > 程序硬上限 48,000，**请求从未发出**。
- 累计 1,123,093 输入是任务级 usage（32 批 + 5 次批次修复 + 更早子任务），不是单次汇总输入。模型实际 1M 上下文并未被使用；这是程序保守预算与“单请求汇总”设计的问题。
- 旧恢复把该错误归为 `change-model`，32/32 已保存任务无法继续。

### 0.2 实现

- `src/ai/aggregate/hierarchy.mjs`：预算/连续分组、单组超预算二分、level 1..N、final unit 上限、确定性 digest/final、batch/unit 覆盖、证据 ref 校验、事件去重与时间排序、`ensureFinalBatchEvidence()`。
- `src/ai/batching/tokens.mjs`：`resolveAggregateContextBudget`（已知 context 或保守 64k）、`resolveAggregateInputLimit`（输出预留 + 500，单请求 ≤192k）、`resolveDigestOutputTokens`。
- `src/ai/api/compact.mjs`：`buildAggregateDigestSchema`（有界局部汇总）与 `buildAggregateFinalEnvelopeSchema`（final 必须/可带 covered_batches）。
- `src/ai/api/prompts.mjs`：三语 `buildAggregateDigestPrompt`；`buildSessionAggregatePrompt` 支持 partial reports、coverage ledger、retry note。
- `src/ai/api/runner.mjs`：`#runSessionAggregate` 先判断 direct final 是否装得下；否则 `#runHierarchical`；`#runDigestGroup` 每个节点独立持久化、source hash 复用、最多 2 次输出尝试、确定性兜底；`#runFinalSynthesis` 同样有界重试/兜底/导入；`aggregate` 状态进入 `/api/ai/analyze/status`。
- `src/storage/repositories/ai-aggregate-nodes.mjs` + migration 15：`ai_aggregate_nodes`（level 0 final，level>0 局部节点），usage/coverage/fallback 全部持久化。
- `src/ai/tasks/recovery.mjs`：`ANALYSIS_AGGREGATE_TOO_LARGE` 不再 `change-model`，32/32 + final 缺失提供 `resume-aggregate`。
- `src/web/js/pages/ai.js` + 三语 i18n：分层节点进度、确定性兜底提示、恢复文案“只处理未完成 final/局部汇总”。
- 清理路径：删场次/清空数据包含 `ai_aggregate_nodes`；`assertNoResidue` 覆盖。

### 0.3 验证

- 全量 **683 passed / 0 failed**（约 163 秒）。
- 生产任务只读副本：原任务 32/32 → 2 个局部节点 + 1 次 final → complete；final 引用 32/32 批次；0 次 batch 重发；节点 usage 计入任务统计。
- 正式 EXE：buildId `68b663eec6fe` / commit `1070261` / SHA-256 `39562ce976ae…` / 91.9 MB / 176 assets / requireAdministrator。asInvoker 测试副本实跑：health 同 buildId；旧任务状态 `resume-aggregate`；Resume 后 complete、32/32、2 节点、3 次汇总请求、final 32/32 refs、无 batch 重发。
- 未验证：真实付费 DeepSeek 分层请求质量、真实生产任务 Resume（需用户授权）、真实 UAC 双击、真实浏览器点击（沙箱限制）。

### 0.4 生产恢复步骤

1. 完全退出 LiveMemory；备份整个数据目录。
2. 替换为 buildId `68b663eec6fe` 的 EXE，设置页「关于」核对。
3. AI 分析中心选择 `ses_01M77TP9QYPFRE4H9NCH`；应显示 32/32、最终汇总未完成、「继续最终汇总」。
4. 点击继续；只做局部汇总 + final，不会重新分析 32 个 batch。
5. 成功后 final 保存、任务 complete；若局部输出仍截断，程序会做一次有界重试并确定性兜底，不新建整场分析、不清空数据。

### 0.5 下一轮注意

1. 不要为“让汇总成功”恢复单请求全量拼接；超过预算必须分组/加层。
2. 节点 source hash 是复用边界；修改 digest schema、prompt 或 batch condense 必须使旧节点失效。
3. final 的 `ensureFinalBatchEvidence` 只补已保存结果中的真实 ref，不允许填充不存在的 seq/批次。
4. 新增失败码时同步更新 `recovery.mjs`、`ai.js`、三语 i18n 与测试。
5. 正式 EXE 已更新；后续改代码必须重建，旧 EXE 没有分层汇总。

## 0.6 上一轮（最终汇总截断与恢复）

完整证据：`log/2026-11-13-ai-aggregate-recovery.md`。

### 0.1 真实根因（已确认）

- 任务 `ses_01M77TM1Q80HQ4XSZTMV` / `aij_01M79KZEFWBCCJP8G1JK`：dashscope `qwen3.7-flash`，18 批全部保存，final 缺失。
- 汇总 `maxTokens=8000`、`maxCompletionTokens=24000`、`estimatedInputTokens=34048`、199,729ms，`finish_reason=length` → `AUTO_OUTPUT_TRUNCATED`。输入 34k < 48k，不是输入超限。
- 20 次请求全部 HTTP 成功（18 批 + 1 次批次修复 + 1 次汇总）；输出完整性失败发生在请求统计之后。
- `Number(null)===0` 把汇总失败的 `batchIndex` 持久化为 0；旧库/旧状态出现假“批次 0”。
- 旧 UI 只有与暂停共用的泛化「继续」按钮，没有汇总专属动作、说明或明确恢复面板；后端当时 `canResume=true`，未复现按钮被隐藏的具体渲染路径。

### 0.2 修复

- `src/ai/batching/tokens.mjs`：`resolveAggregateOutputTokens()`，12k–16k 独立预算，按上下文收缩。
- `src/ai/api/compact.mjs`：`buildSessionAggregateAnswerSchema()` 有界汇总 schema（不改原 schema、不含 viewer_profiles）。
- `src/ai/api/prompts.mjs`：三语汇总提示词加入输出上限、合并优先、每批覆盖；`condenseBatchResult()` 支持 compact 第二遍，保留全部批次/证据。
- `src/ai/api/runner.mjs`：独立预算、compact 预检、`outputStats`/`outputRejected`、`finishReason`、`batchIndex` 规范化、`recovery` 状态、complete 时 resume 幂等。
- `src/ai/tasks/recovery.mjs`：aggregate/session/memory/config 四类恢复动作与 `canResume`；18/18+final 缺失只给 `resume-aggregate`；装不下给 `change-model`。
- `src/ai/tasks/status.mjs`、`src/storage/repositories/ai-jobs.mjs`：不再把 null/0 当批次；旧数据读取兼容。
- `src/web/js/pages/ai.js` + `styles/pages.css`：独立恢复面板；「继续最终汇总」调用真实 `/api/ai/analyze/resume`；页面刷新/重启恢复；不再用共用暂停按钮充当恢复。
- 三语 i18n：`ai.center.recovery.*`、`incomplete`、`errorMeta.*`、`stats.outputRejected|savedResults|apiNotAnalysis`；更新 `AUTO_OUTPUT_TRUNCATED` 文案。
- 文档：STATUS、ROADMAP、AI_CONTRACT、UI_DESIGN、DATA_MODEL、TEST_PLAN、CHANGELOG、本文件、log。

### 0.3 测试

- 全量 **668 passed / 0 failed**（约 130 秒）。
- 新增 `tests/integration/ai-aggregate-recovery.test.mjs`（18 批截断/重启后只发汇总/checksum 不变/重复点击幂等/无效汇总统计）、`tests/unit/ai-aggregate-budget.test.mjs`、`ai-recovery-state.test.mjs`、`ai-recovery-ui.test.mjs`。
- 关键证据：继续前 18 条 batch 结果的 id/version/checksum 与继续后完全一致；继续请求 0 次批次、1 次汇总；重复 Continue 0 次 Provider 请求。
- **隔离 EXE 已验证**：`dist/LiveMemory.exe` 重建为 buildId `61da4c6991e1` / commit `205db74` / SHA-256 `7231c056…` / 91.8 MB / 174 assets / `requireAdministrator`。asInvoker 测试副本（仅测试设置 `LIVE_MEMORY_SKIP_ADMIN_CHECK=1`）实际启动：`/api/health` 同 build、`/api/bootstrap` schema 14、打包 `ai.js`/三语字典含恢复面板；对生产 DB/runtime 只读副本查询真实 18/18 任务，`/api/ai/analyze/status` 返回 `resume-aggregate`、`outputStats.responses=20/rejected=1`、`batchIndex=null`。
- **未验证**：真实付费 Provider、真实生产任务 Resume、真实浏览器点击/截图、真实 UAC 双击。

### 0.4 生产失败任务的安全恢复步骤（需用户明确授权）

1. 完全退出 LiveMemory；备份整个数据目录（`E:\新建文件夹` 或设置页显示的真实位置），不要在运行时复制写入中的 SQLite。
2. 替换为包含本轮修复的构建；在设置页「关于」核对 buildId。
3. 打开 AI 分析中心 → 选择 `ses_01M77TM1Q80HQ4XSZTMV`；应显示「AI 分析未完成」、单场批次 18/18、最终汇总失败/未完成、原因与「继续最终汇总」。
4. 选择与失败任务相同的 Provider/区域/模型；点击「继续最终汇总」。恢复只请求 final，不重发已保存的 18 批。
5. 成功后 final 保存、任务 complete、按钮消失；若仍失败，查看技术详情（错误码/阶段/结束原因），不要新建整场分析、不要清空数据、不要删除已保存批次。
6. 若错误为 `ANALYSIS_AGGREGATE_TOO_LARGE`（上下文不足），面板会显示「前往设置更换模型」而不是可用的「继续」；更换模型后从新任务继续前，应先备份并确认不会重做已保存批次（当前同任务 Resume 不允许更换模型）。

### 0.5 下一轮注意

1. 正式 EXE 已包含本轮修复（buildId `61da4c6991e1`）；后续若改代码必须重新构建，旧 EXE 没有独立汇总预算与恢复面板。
2. 不要为了“重试”自动重发截断请求；截断后只允许用户点击 Continue，且只重做缺失的 final。
3. `outputStats.rejected` 是“成功响应但输出不可用”的计数，不要加进 HTTP 失败数；也不要把 HTTP 成功解释为分析完成。
4. 若未来允许“汇总阶段更换模型”，必须只允许在全部批次已保存且 final 缺失时进行，并保留同一 job / 同一批次 checksum，不得重做批次。
5. 新增恢复类型时，必须同时更新 `recovery.mjs`、`ai.js`、三语 i18n 与测试。

## 0.7 上一轮（多语言输出与报告翻译）

完整记录：`log/2026-11-13-ai-report-translation.md`。

### 0.1 审计结论

- 已有：分析中心有独立「分析语言」；`locale` 写入 Session/Memory 两个 job；包内说明与 Prompt 按 locale 生成；界面语言切换不影响已创建任务。
- 缺口：报告没有阅读语言切换；长期画像只能按原语言；没有翻译缓存/分段恢复/独立 usage；「分析语言」文案与界面语言容易混淆；Prompt 未明确任意/混合语言原文不逐条预翻译。
- 未重做：结果 Schema 仍 1.3.0，Session/Memory 批次、Resume、Compact 校验、观众级容错、事实操作均未改变。

### 0.2 实现

- **功能 A**：AI 中心文案改为「分析输出语言」并增加说明；Prompt v13.2 明确「原文可能是任意/混合语言，直接理解并用 locale 输出，不逐条翻译」；Session 与 Memory 共用任务 locale；状态返回 `locale`，UI 显示「本次任务输出语言（已随任务保存）」。
- **功能 B**：报告页新增「报告语言」选择器；首次切换提示会调用 Provider 并可能产生费用；已有缓存直接显示；原文/翻译 chip；失败红色提示与「重试未完成段落」；无可用 Key 时原文仍可读。
- **翻译架构**：原始分析结果 + 段落级展示缓存。只翻译自然语言字段，绝不写 `ai_results` / `viewer_memories` / `memory_facts`；`viewer_id`、`topic`、事实 ID/状态/certainty/版本/证据/时间/金额/枚举/原始聊天均不翻译。
- **缓存**：`ai_translations` 以原始对象 ID + 字段路径 + 源文本 SHA-256 + 目标语言 + `lm-translation-v1` 为键；`ai_translation_runs` 保存独立运行状态与 usage。结果新版本或事实文本变化不会误用旧翻译；失败只替换失败段。
- **数据生命周期**：翻译表随场次级联删除；删除观众记忆同时删除其事实/摘要翻译；清空数据包含两张新表；v13→v14 只新增表/索引。
- **费用**：翻译 usage/费用只写 `ai_translation_runs`，不混入 `ai_jobs`；未知价格 `cost=null`，显示「费用未知」；复用现有 Provider 配置、超时、重试/429 与 URL 安全检查，非流式请求。

### 0.3 API

```text
GET  /api/ai/sessions/:id/report?locale=zh-CN|ja|en   只读；只应用缓存，不调用 Provider
GET  /api/ai/sessions/:id/translation?locale=...      状态/缓存计数/运行进度/可用配置
POST /api/ai/sessions/:id/translation                 {locale, configId, consent:true}
```

报告新增 `reportLocale`、`displayLocale`、`translation`。错误码：`TRANSLATION_LOCALE_INVALID`、`TRANSLATION_NOT_NEEDED`、`TRANSLATION_CONSENT_REQUIRED`、`TRANSLATION_PROVIDER_REQUIRED`、`TRANSLATION_CREDENTIAL_MISSING`、`TRANSLATION_NO_TEXT`、`TRANSLATION_ALREADY_RUNNING`、`TRANSLATION_SESSION_NOT_FOUND`。

### 0.4 测试

- 全量 **649 passed / 0 failed**（约 155 秒，`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`）。
- 新增 `tests/unit/ai-translation.test.mjs`、`tests/unit/ai-translation-ui.test.mjs`、`tests/integration/ai-report-translation.test.mjs`、`tests/integration/ai-translation-migration.test.mjs`；更新 schema 14 相关迁移断言与 `ai-api` / `memory-api` 状态断言。
- 覆盖 A–J：日语→中文、存档报告切换不重跑分析、缓存复用、部分失败重试、长期事实结构不变、翻译中断/失败保留结果、新版本隔离、证据清理、无 Provider/Key/网络失败、旧 Schema 1.1.0、三语 UI 静态断言。
- **未验证**：真实付费 Provider、真实浏览器窄屏截图、正式 EXE（未重建）、真实生产库迁移。

### 0.5 下一轮注意

1. 如需发布 EXE，必须重新构建，使 schema 14 迁移与翻译代码进入二进制；旧 EXE 不能读取 schema 14 数据库。
2. 翻译缓存是展示派生数据；不要在后续“事实合并/回滚”中把翻译文本当作事实来源。
3. 若新增可翻译字段，必须同时更新 `src/ai/translation/fields.mjs`、`TRANSLATION_VERSION`、三语字典与测试。
4. 不要为了“统一语言”批量改写历史事实；本轮只做按需展示翻译。


## 0.6 上一轮（真实 AI_IMPORT_INVALID 与观众级容错）

完整证据：`log/2026-11-13-real-ai-import-invalid-investigation.md`。

### 0.6.1 真实根因

- 任务 `aij_01M7963928KHJGNJTD64`（memory-only，47 观众/5 批）批次 5 失败；批次 1–4 已保存 40 名 semantic，批次 5 的 7 名 pending。
- 批次 5 中 `seq 3` 属于 `bilibili:1765635337`（ref 5），`seq 5` 属于 `bilibili:5240206`（ref 3）。模型为 ref 5 引用了 seq 5 → `MEMORY_EVIDENCE_OTHER_VIEWER`。
- 包/数据库映射一致；根因是 **ref 与 seq 两套小整数编号混淆**，旧 Prompt 的 excerpt 行没有 `ref`，契约未明确“ref≠seq”。
- 自动修复确实发送过：批次 5 初始（schema type/enum 错误）+ 1 次 whole-batch repair（修复后跨观众证据）；旧版只允许一次修复，随后整批失败。任务总 usage 8 请求 / 77,204 input / 37,327 output；费用 unknown。

### 0.6.2 修复

- Prompt：excerpt 行增加本地 `ref`；契约明确 ref/seq 不同命名空间；repair 增加 `MEMORY EVIDENCE GUARD`；错误携带 `allowedSeqs`。
- 观众级：whole-batch repair 失败后按 `viewer_memory_updates[i]` 拆分；合法观众在 `viewerIds` 作用域重新完整校验并导入；非法观众标记 `failed` 且不写事实；再一次 viewer-scoped repair（只发失败观众/证据），成功合并，失败保留可恢复。
- 事务：合法事实/证据/覆盖状态与 failed 状态同一事务；恢复结果追加同一批次的 `ai_results` 新版本，只含恢复观众。
- 调度：批次级校验错误不再停止后续批次（concurrency=1/4 验证）；Provider/取消/数据库错误仍停止新调度。
- Resume：按 pending/failed 观众构造子集 Prompt；只请求未完成观众。旧任务批次 5 的 7 人全是 pending，旧版没有保存其中合法 6 人，因此旧任务 Resume 会处理这 7 人，不能只挑 1 人。
- UI：coverage 增加 failed；partial 显示已处理/未完成/失败等待恢复；报告 stats 使用 failed。

### 0.6.3 验证

- 全量：**632 passed / 0 failed**（约 112 秒）。
- 真实任务副本（只读 DB+包，Mock）：
  - 普通 Resume 只请求 1 次（批次 5 的 7 名 pending），complete 47/47。
  - 模拟真实 ref/seq 错误：3 次请求（initial + whole repair + viewer repair），complete 47/47、41 semantic、0 failed，无跨观众写入。
- 未验证：真实付费 API、生产任务 Resume、真实浏览器 UI、UAC。

## 0.2 上一轮（v0.13.2 AI 分析可靠性）

### 0.1 核心修复

- Memory 回答统一走「Compact 组装 → `validateAnalysisImport()` 完整校验 → 最多一次定向修复/精确错误修复 → 再校验 → 事务导入」。ref 覆盖完整不再绕过 Schema/身份/证据/枚举校验。
- `assembleMemoryCompact()` 对 `memory` 只接受 `summary` / `summary_certainty` / `no_new_information` / `operations`；`viewer_id` 始终由本地映射最后注入；模型提供的身份/未知字段被丢弃并只记录字段名。
- `fail()` 保留字段级错误、stage、job/batch id、恢复建议；`GET /api/ai/analyze/status` 提供 `error.errors`、`batchErrors`、`memoryJob.failedBatches`。
- `ai_jobs.last_error_json` 增加 `batches[]`；导入成功只清除对应批次，其他并发批次失败保留；旧扁平格式兼容。
- 长期画像 Provider 提示词改为当前运行时 `buildMemoryInstructions()` + 单一 Compact 契约；三语示例本地化，不再出现固定 `"locale": "en"`；`topic` 作为匹配键，续写时复用原值。
- 事实规则明确 stated/inferred/uncertain、本人证据、禁止编造、允许 no_semantics。
- 报告新增 `longTermProfiles.stats`；AI 中心显示已处理/语义/仅客观/未完成与真实错误详情。
- usage 按 session/memory 子 Job 归属，任务总计由两者相加；修复/重试计入真实 usage。

### 0.2 涉及文件

- `src/ai/api/compact.mjs`、`src/ai/api/runner.mjs`、`src/ai/api/prompts.mjs`
- `src/ai/prompts/split.mjs`、`src/ai/constants.mjs`
- `src/ai/import/importer.mjs`、`src/ai/tasks/status.mjs`
- `src/storage/repositories/ai-jobs.mjs`、`src/server/serializers.mjs`
- `src/analytics/ai/report.mjs`、`src/web/js/pages/ai.js`、`src/web/js/pages/ai-report.js`
- `src/web/i18n/{zh-CN,ja,en}.json`
- 新增 `tests/unit/ai-compact-memory.test.mjs`、`tests/integration/ai-memory-reliability.test.mjs`；更新 `tests/unit/ai-ui.test.mjs`
- 文档：STATUS、HANDOFF、ROADMAP、AI_CONTRACT、DATA_MODEL、TEST_PLAN、CHANGELOG、UI_DESIGN、PRIVACY_SECURITY、log。

### 0.3 测试

- **628 passed / 0 failed**（2026-11-13，约 120 秒，`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`）。
- 覆盖 A–O 中的 A/B/C/D/E/F/G/H/I/J/K/L/M；N/O 由既有 schema 兼容/单场回归测试覆盖。
- **未验证**：真实 Provider、真实浏览器 UI（沙箱禁止浏览器命名管道）、真实生产任务 Resume。

### 0.3.1 历史英文事实与新日文画像并存的处理

- 不自动翻译、覆盖或删除历史 `memory_facts`；事实的 `id`、`source_*`、证据关联与版本关系保持原样。
- 现有画像页会按事实逐条展示 `topic`/`statement`；旧英文事实与新日文事实可能并存，这是历史真实状态，不应伪装成已统一。
- 可选的安全处理（需用户逐条授权）：由用户在观众详情中人工复核后新增/更新事实，或用相同场次重新生成受控结果；程序不提供批量翻译。
- 未来生成由任务 locale 决定；`topic` 续写时复用旧 topic，避免同一概念因翻译产生重复事实。
- 历史英文事实的语义不会被自动改写；若需要语言统一，建议先备份再逐条核对，而不是批量脚本。

### 0.3.2 失败模型回答暂存（只给方案，本轮未实现）

审计建议保留“已付费但导入失败”的原始回答以避免再次付费。本轮**没有实现持久化**，原因与安全方案如下：

- 持久化必须加密（复用本机凭据加密层）、有明确生命周期（例如仅保留到该批次成功或用户删除）、大小上限（例如单批 ≤ 2 MB）、自动清理与用户可见的隐私说明。
- 不得进入普通日志、诊断包、配置 JSON、ZIP 或任何上传；不得发送到开发者服务器。
- 读取/重新校验必须复用同一 `validateAnalysisImport()` 与事务导入，且仍受身份/证据/Schema 约束。
- 更简单的替代方案：保留已通过校验的批次结果（当前行为），失败批次由用户决定是否 Resume；自动修复已把单次失败成本降到最多一次额外请求。
- 若未来实现，建议新增独立的加密暂存目录与“仅本机、可一键清除”的设置项，并先做隐私评审；本轮不引入。

### 0.4 生产失败任务的安全恢复步骤（需用户明确授权）

场次 `ses_01M77TJXG9VP4VAGNSXY`（392 条消息、37 名可识别观众；单场报告完成；画像 1/3/4 成功、第 2 批失败、缺 10 人）：

1. **先备份数据目录**（至少复制 `%LOCALAPPDATA%\LiveMemory` 到独立位置；不要在软件运行时直接复制 SQLite 主库，使用软件已有快照/退出后再复制）。
2. 完全退出 LiveMemory，替换为新版本 EXE/源码构建；确认设置页「关于」的 buildId 与新版本一致。
3. 打开 AI 分析中心，选择该场次；选择与失败任务**相同**的 Provider/区域/模型配置。
4. 页面应显示失败批次与「查看技术详情」；确认错误属于可恢复的校验/Provider 错误，且 `canResume=true`。
5. 点击「继续」。恢复只会处理未导入批次（第 2 批）；已完成批次、单场报告与 1/3/4 批事实不会重发。
6. 若仍失败，技术详情会显示批次、字段路径与错误码；不要重复点击；把错误码/批次（不要发聊天原文或 Key）反馈。
7. 恢复后的新事实使用当前 locale（日语）与 v13.1 提示词；旧英文事实保留。若需要统一语言，只能逐条人工复核/重新生成，程序不做批量翻译（见 §0.3.1）。
8. 恢复完成前不要把任务标记为整体成功；UI 只有全部批次通过校验后才显示 complete。

**注意**：旧任务创建于 v13 提示词时代，包内 `instructions.md` 仍是旧文件；新代码在发送 Provider 请求时使用当前运行时 instructions，所以第 2 批会使用新语言/事实规则。任务记录中的 `prompt_version` 仍是创建时的 `lm-prompt-v13-memory-ja`，这是历史事实，不篡改。

### 0.4.1 `AI_IMPORT_INVALID` 专项验收（2026-11-13）

完整证据：`log/2026-11-13-ai-import-invalid-acceptance.md`。

- 旧代码 `3fccba1`，392 条合成消息 / 37 观众 / 4 批（10/10/10/7），三个变体均复现：`AI_IMPORT_INVALID`、27/37、无 stage/字段错误、无 repair、成功批次清空失败记录。
- 新代码 `e67677a` 同条件全部 complete 37/37；缺证据/跨观众证据触发一次 repair；伪造 `viewer_id` 直接被本地映射覆盖。
- 修复仍失败：精确显示 `MEMORY_EVIDENCE_REQUIRED`、stage=validation、batchIndex=2、`batchErrors=[2]`；重启 Resume 只重试 b02，最终 37/37。
- 隔离 EXE（buildId `c51819b2f3f3`，requireAdministrator；asInvoker 测试副本）通过本地 Mock Provider 完成同样三项验收。之后用户明确授权覆盖正式 EXE：`dist/LiveMemory.exe` 已重建为 buildId `caece0818f11` / commit `2b0ade6` / SHA-256 `c827a609…`，Manifest 仍为 requireAdministrator；asInvoker 测试副本实际启动验证 `/api/health`、`/api/bootstrap` 返回同一 build，schema 13。旧 EXE 备份在 `tests/.tmp/LiveMemory-pre-r5-backup.exe`。
- 2026-11-13 r6（观众级容错）：正式 EXE 再次重建为 buildId `9b8daa7b2d1d` / commit `2df6052` / SHA-256 `9b3eea3e…` / 91.7 MB / 169 assets / requireAdministrator。用生产库与 b05 包只读副本 + 本地 Mock Provider，在 asInvoker 测试副本中 resume `aij_01M7963928KHJGNJTD64`：模拟真实 ref/seq 错误，3 次请求（initial + whole repair + viewer repair）后 complete 47/47、41 semantic、0 failed；批次 1–4 未重发。独立生产数据副本已删除，正式 EXE 保留；旧 EXE 备份 `tests/.tmp/LiveMemory-pre-r6-backup.exe`。
- 原始失败的具体非法字段未保留，无法断言当时是三个变体中的哪一个；但导致该错误的结构性代码路径均已复现并修复。

## 0.5 上一轮（观众身份专项）

### 0.1 结论

- Bilibili 场次 `ses_01M75S69P4H0NSX87PD4`：727 条消息，726 条弹幕全部无 UID，只有 1 SC + 2 大航海带 UID，去重后 2 人。
- 根因是平台未登录弹幕风控（昵称打码、uid=0）＋ 页面把「可识别观众」标成「独立观众 / 本场参与人数」且隐藏 726 条未识别消息。数据库、JOIN、迁移、缓存均无丢人。
- 另一场 Bilibili 也是 206/206 条无 UID、0 可识别观众；四场 YouTube 0 条未识别。判定 B（平台特定）+ D（UI 口径），不是单场、不是全平台。
- 历史计数可重算；726 条弹幕的真实身份不可恢复；实际观看人数未知。

### 0.2 修改

- `src/shared/events.mjs`：`uid=0`/`"0"` 规范为无身份，`buildViewerId` 不再生成 `platform:0`。
- `sessions.mjs`、`history-search.mjs`、`monitor-targets.mjs`、`summary.mjs`、`serializers.mjs`、`routes.mjs`：新增 `unidentified_message_count` / `unidentifiedMessageCount` 派生指标与 `identityCoverage`。
- `history.js`、`live.js`、`ai.js`、`session-actions.js`、`pages.css`：统一「可识别观众」标签，行内徽标、详情警告、AI 规模行与画像覆盖提示。
- 三语 i18n：修正「登录不会改变身份字段」，改为未登录可能触发打码/UID=0 的警告；登录标题改为「建议」。
- 新增 `docs/AUDIT_VIEWER_IDENTITY_2026-11-12.md`；更新 PLATFORM_INTEGRATIONS、DATA_MODEL、UI_DESIGN、STATUS、TEST_PLAN、ROADMAP、CHANGELOG 与本文件。

### 0.3 测试

- **610 passed / 0 failed**（约 119 秒）。
- 新增 `tests/integration/identity-stats.test.mjs`（多消息/多用户/同名不同 UID/UID 缺失/数字 0/数字与字符串类型/礼物/SC/大航海/跨场次/跨页面一致），`tests/unit/identity-labels.test.mjs`；`events.test.mjs` 增加 UID=0。
- 数据库副本启动实测三条 HTTP 路径均返回 `727 / 2 / 726`，重启不变。
- 未验证：登录后是否 100% 解除 Bilibili 打码；原始帧未保存；未做浏览器截图。

## 1. 上一轮：v0.13.2（构建可验证与分批预算）

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
