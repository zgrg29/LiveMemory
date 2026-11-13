# 版本变化（CHANGELOG）

## 0.13.2-r10 — 2026-11-13（长期画像输出预算、截断恢复与观众级断点）

### 新增

- **输出感知动态分批**：`estimateMemoryViewerOutputTokens()` + `resolveMemoryOutputTokens()`（基础 6,000、上限 8,192、受 context 收缩）；`planMemoryViewerBatches()` 同时按输入与预期输出分批；单观众超份额时独占一批；包 `batch_plan` 记录输出预算/估算/事实上限。
- **三语事实/证据上限**：每位观众每次最多 12 条高价值事实；每条事实通常 1–3 条同一观众证据；不静默丢弃已通过校验的事实。
- **有界恢复**：空响应自动重试 1 次；截断/仍空按观众组对半拆分，最多 2 层；单观众仍截断仅一次提高到 8,192；连续 3 个输出失败批次停止调度。
- **schema 16**：`ai_job_memory_viewers.split_path/split_reason` + 索引；拆分映射事务写入；恢复按 `(batch_index, split_path)` 只取 pending/failed 观众。
- **状态/UI**：`recoveryStats`、`outputStats.truncations/emptyResponses/autoRetries/splits`、`memoryJob.splitBatches/pendingSplitBatches/splits[]`、`currentSplitPath`；三语恢复面板区分截断/空响应/校验失败。

### 修复

- **真实任务 `aij_01M7AJ05B5E2VRG9Z82G` 根因**：空文本适配器错误丢失 finish_reason/usage；`invalid_response` 不自动重试；界面 length 来自上一子任务的陈旧 `lastOutputRejection`；分批只看输入；无拆分映射；部分子结果被当作批次完成；elapsedMs=null 显示 0；17 个成功批次是并发乱序完成。
- `finish_reason=length` 现在优先识别为 `AUTO_OUTPUT_TRUNCATED`（即使内容为空）；无文本非 length 为 `PROVIDER_RESPONSE_EMPTY`；失败响应 usage 也计入 job。
- `lastOutputRejection` 绑定子 Job；`elapsedMs=null` 不再显示 0。

### 验证

- 全量 **698 passed / 0 failed**（约 188 秒）。
- 新增 `tests/unit/ai-adapter-output.test.mjs` 3 项、`tests/unit/ai-token-batching.test.mjs` 4 项、`tests/integration/ai-memory-output-recovery.test.mjs` 9 项。
- 生产数据只读副本 + Mock：17/100、153/975 → complete 100/100、975/975；只请求 b12、19–100；b12 自动拆 12.1/12.2；旧 17 条结果保留；重复继续 0 请求。
- 正式 EXE：buildId `4b697b2cb227` / commit `ab32386` / SHA-256 `de9ddc18…` / 91.9 MB / 176 assets / `requireAdministrator`；asInvoker 测试副本 + 本地 Mock + 生产数据副本实跑旧任务，17/100、153/975 → complete 100/100、975/975，85 次 Provider 请求，旧 17 条结果保留。

## 0.13.2-r9 — 2026-11-13（可扩展分层汇总与真实 32 批恢复）

### 新增

- **分层汇总**：`src/ai/aggregate/hierarchy.mjs`、`ai_aggregate_nodes`（schema 15）、预算动态分组、单组超预算二分、受控层数、final unit 上限、确定性 digest/final 与覆盖/证据/时间去重校验。
- **可恢复局部节点**：level 0 final + level≥1 partial 独立持久化；source hash 复用；重启只补缺失节点，不重算已完成节点。
- **证据修复**：final 对 ≤96 批逐批检查；模型漏引/引用无效 seq 时，从已保存批次/局部节点补回真实 ref，不伪造；32 批真实副本 final 引用 32/32。
- **有界重试/兜底**：截断/结构错误最多 2 次；仍失败用已保存结果确定性完成，节点标记 `deterministic`；Provider 错误保持可恢复。
- **恢复语义**：`ANALYSIS_AGGREGATE_TOO_LARGE` 不再 `change-model`；32/32 已保存 → `resume-aggregate`。
- **UI/统计**：分层节点进度、确定性兜底提示；节点 usage 计入任务统计。

### 修复

- **真实 32 批故障根因**：`contextLength=null` + 旧 48,000 单请求硬上限 + 全量拼接；compact 后 64,471 token，请求未发出。累计 token 不是单次汇总输入；37 次成功请求中无 aggregate。
- **AUTO_OUTPUT_TRUNCATED**：保留独立 12k–16k 输出预算与有界 schema，并新增一次有界重试；两次截断后确定性兜底，不再永久失败。

### 验证

- 全量 **683 passed / 0 failed**（约 163 秒）。
- 新增 `tests/unit/ai-hierarchy.test.mjs`（10）、`tests/integration/ai-hierarchy.test.mjs`（3）；重写 `ai-aggregate-recovery`（3）。
- 生产 DB/runtime/exports 只读副本：原任务 32/32 → 2 节点 + final，0 次 batch 重发，final 32/32 refs。
- 正式 EXE buildId `68b663eec6fe` / commit `1070261` / SHA-256 `39562ce976ae…` / 91.9 MB / 176 assets / `requireAdministrator`；asInvoker 测试副本 + 本地 Mock Provider 实跑完成 32/32，日志只有 2 digest + 1 final。
- 未做：真实付费 DeepSeek、真实生产任务 Resume、真实 UAC 双击、真实浏览器点击。

## 0.13.2-r8 — 2026-11-13（最终汇总截断与「继续最终汇总」恢复）

### 修复

- **真实 18 批故障**：汇总沿用普通批次 8,000 输出预算；Provider 返回成功但 `finish_reason=length`。新增独立汇总预算 `clamp(ceil(batchResultTokens*0.6)+3000, 12000, 16000)`，按上下文收缩；18 批上限 16k，不再固定 8k。
- **有界汇总契约**：汇总专用 schema（topics ≤24、sentiment ≤12、disputes ≤8、highlights ≤8、message_refs ≤4、无 viewer_profiles）；三语提示词明确输出上限、合并优先、覆盖全部批次；compact 第二遍保留全部批次与证据，装不下则 `ANALYSIS_AGGREGATE_TOO_LARGE` + `change-model`。
- **恢复状态**：新增 `src/ai/tasks/recovery.mjs`；18/18 已保存且 final 缺失只提供 `resume-aggregate`；批次/画像/配置分别给出准确动作；`canResume=false` 时 UI 不显示假“继续”。
- **幂等**：`resume()` 在 complete 时直接返回；重复点击不创建任务、不请求 Provider；继续只发缺失 final。
- **`batchIndex`**：1-based 规范化，null/0/负数不再成为“批次 0”；旧数据读取兼容，`failedBatches` 不含 0。
- **UI**：AI 中心新增独立恢复面板与「继续最终汇总」；显示已保存 18/18、final 状态、原因、已保存结果；「查看技术详情」显示整场汇总阶段与 `finishReason`；刷新/重启后恢复。
- **统计**：新增 `outputStats.responses/rejected/lastFinishReason`；界面区分 API 请求成功、输出未通过完整性/结构校验、已保存结果，并说明 API 成功 ≠ 分析完成。

### 验证

- 全量 **668 passed / 0 failed**（约 130 秒）。
- 新增 `ai-aggregate-recovery`（18 批截断、重启后只发汇总、checksum 不变、重复点击幂等、无效汇总统计）、`ai-aggregate-budget`、`ai-recovery-state`、`ai-recovery-ui`。
- **EXE 已验证**：`dist/LiveMemory.exe` buildId `61da4c6991e1` / commit `205db74` / SHA-256 `7231c056…` / 91.8 MB / 174 assets / `requireAdministrator`；asInvoker 测试副本实际启动，`/api/health`、`/api/bootstrap`（schema 14）、打包 `ai.js`/三语字典与生产任务只读副本的 `/api/ai/analyze/status` 均通过。
- 未做：真实付费 Provider、真实生产任务 Resume、真实浏览器点击/截图、真实 UAC 双击。

## 0.13.2-r7 — 2026-11-13（AI 分析输出语言与报告翻译）

### 新增

- **分析输出语言（功能 A）**：AI 中心明确「分析输出语言」；默认 UI 语言、可手选 zh-CN / ja / en；Session 与 Memory 共用同一任务 locale；locale 随 `ai_jobs` 与运行时状态保存，UI 切换/暂停恢复不改变已保存任务。
- **Prompt v13.2**：明确聊天/摘录可能是中文、日语、英语或混合语言，模型直接理解原意并用 locale 输出，不逐条预翻译；技术字段/JSON 键名/枚举/稳定 ID 不变。
- **报告阅读语言（功能 B）**：报告标题区新增「报告语言」选择器与原文/翻译 chip；已缓存直接显示，未翻译才提示付费翻译；失败红字 + 只重试未完成段落；无 Provider/Key 时原文仍可读。
- **翻译展示缓存（schema 14）**：新增 `ai_translations`（段落级）与 `ai_translation_runs`（独立运行/usage/错误）。缓存键 = 原始对象 ID + 字段路径 + 源文本 SHA-256 + 目标语言 + `lm-translation-v1`。
- **长期画像保护**：只翻译 `summary` / `statement`；`viewer_id`、`topic`、事实 ID/状态/certainty/版本/证据/金额/时间/原始聊天不翻译；同一组事实在两个语言中保持一致。
- **按需翻译**：分块请求、成功段落立即保存、单段失败保留其他段落；同语言再次切换只读缓存；新结果版本/事实文本变化不会复用旧翻译。
- **费用与安全**：翻译 usage/费用独立归属，不混入 `ai_jobs`；未知价格 `cost=null`，界面显示「费用未知」；首次翻译前明确费用提示并需 `consent:true`；复用现有 Provider/超时/重试/429/URL 安全检查。
- **生命周期**：翻译随场次级联删除；删除观众记忆同时删除其摘要/事实翻译；清空数据/恢复出厂包含翻译表。

### 验证

- 全量 **649 passed / 0 failed**（约 155 秒）；新增 `ai-translation`、`ai-translation-ui`、`ai-report-translation`、`ai-translation-migration` 测试；更新 schema 14 迁移/状态断言。
- 覆盖 A–J：日语→中文、缓存复用、部分失败重试、新版本隔离、长期事实不变、证据清理、无 Provider/Key/网络失败、旧 Schema 1.1.0、Session/Memory 同 locale、三语 UI。
- **未做**：真实付费 Provider 翻译、真实浏览器窄屏截图、正式 EXE 重建（当前 EXE 仍为 schema 13）、真实生产库迁移。

## 0.13.2-r6 — 2026-11-13（真实 AI_IMPORT_INVALID 与观众级容错）

### 修复

- **真实根因**：生产任务批次 5 的 ref 5（`bilibili:1765635337`）合法证据是 seq 3，却引用了属于 ref 3（`bilibili:5240206`）的 seq 5；包/数据库映射本身一致，问题是 ref/seq 两套编号混淆，旧 Prompt 未在 excerpt 行标注 ref。
- **自动修复**：旧版批次 5 初始 schema 错误 → 一次 whole-batch repair → 修复后跨观众证据；旧版只允许一次修复，整批 7 人全部拒绝。本轮新增一次有界 viewer-scoped repair。
- **观众级容错**：整批 repair 后仍有观众级错误时，合法观众在 `viewerIds` 作用域重新完整校验并导入；非法观众标记 `failed`、不写事实；恢复导入追加批次新版本，不重复成功观众事实。
- **Prompt**：excerpt 行带 `ref`；契约明确 ref≠seq、只能引用同 ref 的 evidence；repair 增加 evidence guard；`MEMORY_EVIDENCE_OTHER_VIEWER` 携带 allowedSeqs。
- **调度**：批次级校验失败不再停止后续批次（concurrency=1/4）；Provider/取消/数据库错误仍停止新调度。
- **Resume/统计**：只请求 pending/failed 观众；coverage 增加 failed；partial 文案与报告统计区分未完成/失败。
- **真实任务副本回放**：普通 Resume 1 次请求完成 47/47；模拟真实 ref/seq 错误 3 次请求完成 47/47、41 semantic、0 failed。
- **正式 EXE（用户授权覆盖）**：dist/LiveMemory.exe 重建为 buildId 9b8daa7b2d1d、commit 2df6052、SHA-256 9b3eea3e…、91.7 MB、169 assets、Manifest equireAdministrator；生产库/包只读副本 + Mock 的 EXE Resume 实测 47/47。旧 EXE 备份在 	ests/.tmp。

### 验证

- **632 passed / 0 failed**（约 112 秒）。
- 新增 ref/seq 冲突、concurrency=1 后续批次、viewer-scoped repair 自动成功、观众级 9/1 隔离、Resume 只发失败观众等测试。
- 未做：真实付费 API、生产任务 Resume、真实浏览器 UI、UAC 双击。
## 0.13.2-r5 — 2026-11-13（AI 分析可靠性与长期画像语言修复）

### 修复

- **统一校验链**：长期画像不再因 Compact ref 覆盖完整而跳过 `validateAnalysisImport()`；固定为「组装 → 完整校验 → 最多一次修复 → 再校验 → 事务导入」。
- **稳定身份**：`assembleMemoryCompact()` 只接受 `summary` / `summary_certainty` / `no_new_information` / `operations`；`viewer_id` 永远由本地映射注入，模型字段无法覆盖；跨观众 evidence 继续拒绝。
- **诊断**：`AI_IMPORT_INVALID` 不再吞掉 `AppError.details.errors`；任务状态包含 stage、Job/Batch、字段路径、可恢复性与建议；前端「技术详情」只显示本地字段，不含模型原文/聊天/Key。
- **分批次错误**：`ai_jobs.last_error_json.batches[]` 按批次保留；成功批次只清除自己的失败，不再覆盖并发失败批次；旧格式兼容。
- **语言**：长期画像 Compact 示例与规则三语本地化；不再出现固定 `"locale": "en"`；Provider 请求改用当前运行时 instructions，旧包中的冲突示例不再发送；`topic` 作为稳定匹配键。
- **事实准确性**：三语明确 stated 需本人证据、inferred 不得写成事实、玩笑/引用/建议不算个人经历、不得编造、允许 no_semantics。
- **统计**：报告新增 `longTermProfiles.stats`（应处理/已处理/有语义/仅客观/未完成/失败批次）；AI 中心区分单场完成与画像部分完成。
- **usage**：session/memory 请求分别计入各自 Job；任务总计由子 Job 相加；修复/重试计入真实 usage；成本未知不显示为零。
- **提示词版本**：`lm-prompt-v13` → `lm-prompt-v13.1`（旧任务保留原版本号）。

### 验证

- **628 passed / 0 failed**（约 120 秒）；新增 `tests/unit/ai-compact-memory.test.mjs`、`tests/integration/ai-memory-reliability.test.mjs`，更新 `ai-ui`。
- 隔离 Mock Provider 验证 A–M：正常导入、完整 ref 但非法、自动修复成功/失败、伪造身份、跨观众证据、4 批并发仅 b02 失败、重启只补 b02、重复提交幂等、日语事实、combined partial、usage 归属、礼物-only 观众。
- **`AI_IMPORT_INVALID` 专项验收**：旧代码 `3fccba1` 用 392/37/4 结构复现（三个变体均失败、27/37、无详情、无 repair）；新代码同条件全部 37/37（一次 repair）；修复仍失败时详情/批次/Resume 正确；隔离 EXE（buildId `c51819b2f3f3`）同样通过，EXE 内 Resume 只发 b02 一次。证据见 `log/2026-11-13-ai-import-invalid-acceptance.md`。
- **正式 EXE（用户授权覆盖）**：`dist/LiveMemory.exe` 重建为 buildId `caece0818f11`、commit `2b0ade6`、SHA-256 `c827a609…`、91.7 MB、169 assets、Manifest `requireAdministrator`；asInvoker 测试副本实际启动并通过 `/api/health`、`/api/bootstrap` 验证 buildId/commit/schema 13。旧 EXE 备份在 `tests/.tmp`。
- 未做：真实付费 API、真实浏览器截图（沙箱拒绝浏览器命名管道）、生产任务 Resume、真实 UAC 双击。

## 0.13.2-r4 — 2026-11-12（观众身份专项审计）

### 修复

- **UID=0 防御**：`buildViewerId()` 与 `normalizeEvent()` 把 `0` / `"0"` 视为平台未提供身份，禁止产生 `platform:0` 共享档案；不改变真实 UID、昵称或已有数据。
- **未识别消息指标**：`sessions` 查询新增只读派生 `unidentified_message_count`（chat + super_chat 且 `viewer_uid` 为空）；summary 新增 `identifiedMessages` / `unidentifiedMessages` / `identityCoverage` / `identityComplete`；历史搜索、serializer、监控场次列表同步返回。
- **统一统计口径**：直播页、历史列表/详情、AI 中心统一「可识别观众」；有未识别消息时显示「N 条未识别」徽标或警告卡，并说明消息仍计入总数、但无法归属到观众。
- **登录文案纠错**：删除「登录不会改变观众身份字段」的错误说明；改为 Bilibili 未登录可能触发弹幕打码/UID=0，建议扫码登录后开始新记录。登录标题「可选」→「建议」。
- **无破坏**：没有修改/合并/删除历史观众，没有回填 UID，没有按昵称合并，没有改变消息/金额/AI 逻辑。

### 审计

- 真实场次 `ses_01M75S69P4H0NSX87PD4`：727 条消息，726 条弹幕无 UID，只有 1 SC + 2 大航海带 UID，去重 2 人；另一场 Bilibili 206 条全部无 UID；四场 YouTube 0 条未识别。
- 结论：Bilibili 未登录弹幕风控（平台侧）＋ UI 口径误导；不是数据库 JOIN、迁移、缓存或全局解析器故障。
- 历史消息/计数/时间线可重算；726 条弹幕的真实身份不可恢复；实际观看人数未知。
- 完整报告：`docs/AUDIT_VIEWER_IDENTITY_2026-11-12.md`。

### 验证

- **610 passed / 0 failed**（约 119 秒）；新增 `identity-stats`、`identity-labels` 与 UID=0 测试。
- 数据库副本启动实测 `/api/sessions`、`/api/history/search`、场次详情均为 `727 / 2 / 726`，重启不变；未修改用户原库。

## 0.13.2-r3 — 2026-11-12（任务完成优先：删除时间/费用/总量限制）

### 修复

- **删除任务时间上限**：`createTaskBudget`、60/45 分钟 soft/hard、`maxTotalMs`、按剩余时间缩短请求全部移除；任务可以长时间运行，只有单请求首响应与 60 秒流空闲。
- **删除费用预算**：预算输入/校验/确认、按累计费用停止、价格未知阻止、免费/付费模型分类全部移除。
- **价格完全可选**：完整价格按实际 usage 计算；空或部分价格正常分析、只统计 Token、不虚构总费用。
- **规模限制**：删除总批次/总消息/总观众拒绝；按单批 Token 自动拆分。仅保留单批 32k 输入、单观众 48k、1M 消息/200k 观众极端内存保护。
- **可恢复错误**：超时、401/402/403/404/429/5xx、网络 → `needs_action`，保留已完成批次并可继续；用户取消立即 `canceled`。
- **UI 简化**：移除预算、费用确认、免费/付费提示；保留阶段、批次、已运行时间、ETA、等待汇总、需要处理/继续。
- `taskElapsedMs` 在 paused/needs_action/canceled/complete 时冻结，不再继续增长。

### 验证

- 603 passed / 0 failed；新增可选价格、空价格、部分价格、无时间上限、2500 观众无总批次上限、timeout needs_action + 汇总-only 恢复。

## 0.13.2-r2 — 2026-11-12（60/45 分钟软/硬任务预算；已被 r3 取代）

### 修复

- 真实 7/7 批次后，final aggregate 在 435,770 ms 被任务剩余预算 `maxTotalMs` 中止，20:00 标记 `ANALYSIS_TASK_TIMEOUT`；实际并非阻止汇总启动。
- 默认任务预算 20 分钟 → **60 分钟**；45 分钟软提醒；60 分钟只停止启动新批次，在途请求按自身首响应/空闲超时完成并保存。
- 单请求不再使用 `maxTotalMs`，不会被任务剩余时间缩短；已发送超时仍不自动重发。
- 仍有未完成批次 → `ANALYSIS_TASK_PAUSED` + `status=paused`（可恢复）；用户取消仍立即 `canceled`。
- 只剩 final aggregate 时不被硬预算阻断；7/7 后 resume 只发 aggregate。
- 状态/UI 新增已运行时间、`taskBudgetState`、`waitingAggregate`、`pending*Batches`、可继续提示；暂停态明确已完成批次已保存。

### 验证

- 603 passed / 0 failed；新增 `tests/integration/v14-task-budget.test.mjs`。

## 0.13.2 — 2026-11-12（构建可验证、分批预算重平衡、输出有界）

### 修复

- **构建与运行不一致**：版本号无法区分同一版本的不同构建。新增 `buildId = <commit7>.<sourceHash8>`，随 EXE 打包；启动日志、`--version`、设置页关于、`/api/health`、`/api/bootstrap`、`/api/status` 全部显示 buildId/commit。
- **旧解压缓存复用**：bootstrap 复用缓存前逐文件校验 169 个 SHA-256；发现污染记录 `app-root.stale`、删除并重新解压，解压后再校验。
- **8k 预算被固定开销吃掉**：真实 889 消息包固定 overhead ~7.2k，8k 只剩 ~0.8k 内容，规划出 ~125 批。改为 overhead / content / output 三项分离，内容至少 50%（且 ≥1k）；默认总输入 24k。
- **输出无总上限**：Qwen 的 `max_tokens` 只限制回答，思考另计（qwen3.8-max 默认 xhigh/131072）。DashScope 增加 `max_completion_tokens = 回答 + 16k`，不关闭思考。
- **无界汇总/修复/单观众请求**：aggregate 48k 硬上限 + 上下文检查；repair 只截断上次回答并显式超限；单观众 48k 硬上限；上下文装不下显式失败。
- 尝试日志新增 requestBytes、estimatedInputTokens、maxTokens、maxCompletionTokens、reasoningChars、reasoningTokens。
- 会话 prompt 明确 `viewer_profiles` 是可选批内高亮，不承诺完整覆盖；完整覆盖由 memory 批次保证。

### 验证

- 597 passed / 0 failed（约 93 秒）。
- EXE `89bf47ac620e` / commit `b101bd0` / SHA-256 `aa3d4110…`；asInvoker 副本实际启动并返回同一 build；第二次启动 `filesVerified=169`。
- 真实 889 消息离线规划：8k=24 批、16k=11 批、24k=6 批、32k=4 批，全部 889/889 覆盖。

### 未验证

- 真实付费 API 的 `max_completion_tokens` 行为、24k/6 批真实回放、真实 UAC 双击。

## 0.13.1-r2 — 2026-11-12（AI 可靠性、token 分批、自动流式）

### 修复

- 超时不再被当作可重试错误：已发出的长请求超时后默认不重发；用户取消/暂停绝不重试；只有连接阶段网络错误允许一次安全重试。
- `runPool` 首个失败不再 abort 同批在途请求：已完成的兄弟批次继续导入，恢复只处理缺失批次。
- 新增 20 分钟任务级时间预算（`ANALYSIS_TASK_TIMEOUT`），不再等 9 分钟后才发现失败。
- 每次尝试写脱敏 `ai.request.attempt` 日志与状态（attempt、耗时、错误类型、HTTP status、响应头/输出、是否重试）。
- 修复全局 `[hidden]` 被 `.callout {display:flex}` 覆盖导致空提示框可见。
- 修复会话任务遗留旧 job id、导致 memory-only 失败被误标 partial。
- 修复 AI 中心“预计请求数”在含 session 时固定显示 1 的错误，改为自动分批提示。
- `Retry-After: 0` 不再被回退成 1.5 秒固定等待。

### 新增

- `src/ai/batching/tokens.mjs`：session 消息与 memory 观众按估算 input token 分批；默认 8k，可配 2k–32k；小上下文自适应。
- 多批 session + final aggregate：全部消息/观众覆盖，汇总证据 `{batch, seq}`，报告去重不拼接。
- 自动 Streaming：OpenAI-compatible SSE 与 Anthropic Messages SSE；流式只缓冲，完成后仍走原校验/事务导入；不兼容自动回退一次并持久化模式。
- 计时区分响应头、首字节/首 token、流持续时间、最大空闲与总耗时。
- AI 中心：单场批次 n/N、等待汇总、已收到模型输出、请求运行时间、重试状态、已保存批次、真实失败原因。
- 统计分开成功/失败/取消/超时/重试；失败无 usage 显示“用量未知”；ETA 仅 ≥3 个成功批次样本。
- Provider 配置新增“无响应超时（秒，10–600）”与“单批输入上限 tokens（留空自动）”。
- `docs/AI_RELIABILITY.md`；真实浏览器截图 `docs/screenshots/ai-reliability-*`。

### 测试

- 全量 **583 passed / 0 failed**（约 96 秒）。
- 新增 `ai-attempts`、`ai-stream`、`ai-token-batching`、`v14-session-batching`、`v14-streaming-timeout`；更新 `ai-progress`。
- 真实付费 API、真实 174k token 大场、真实 EXE 仍未验证（本机无 Key / UAC 限制）。

## 0.13.1 — 2026-11-11（移除匿名/手动 AI，重写付费调度）

### 删除

- 匿名免费 AI：`src/ai/auto/`、OVH Provider、2 请求/分钟滑动窗口、免费冷却、自动切换、健康探测、`/api/ai/auto/*`、UI 免费入口与价格状态。
- 手动 AI：创建分析包、复制提示词、下载分析 ZIP、粘贴/上传 JSON、手动导入预览/确认、汇总包按钮、修复指令 UI；对应 HTTP 写路由删除。
- `PRICING_STATUS.ANONYMOUS_FREE` 与 `MAX_AUTO_BATCHES=30`。

### 新增

- 单一五步 AI 分析中心：选择直播 → API 配置 → 内容 → 费用/预算 → 开始分析。
- `src/ai/runtime/scheduler.mjs`：按 `configId` 隔离的调度器；可配置初始并发 1–8（默认 3），429 时并发减半并遵守 `Retry-After`（上限 300 秒），成功 6 次后恢复。
- 指数退避 + 50–100% 抖动；5xx/408/425 可重试；400/401/403/404 不重试。
- 画像批次有界并发；批次上限改为 `ceil(MAX_ANALYSIS_VIEWERS / 10) + 1`。
- 同一主播跨场次记忆顺序 gate（`ANALYSIS_MEMORY_OUT_OF_ORDER`）。
- 请求统计：总数/完成/失败/并发/排队/模型耗时/排队等待/限流等待/429/p50/p95/token/费用/ETA。
- 设置页初始并发数；三语 `ai.center.*` 文案。
- `docs/AI_SCHEDULER_AUDIT.md`、`scripts/benchmark-mock-scale.mjs`。
- API 配置原地编辑：卡片「编辑配置」、表单复用、只改模型保留 Key、模型变化能力/价格失效、运行中配置保护、resume 配置变化拒绝。
- 七项实际使用修复：历史场次选择、配置状态、实时进度、无观众画像跳过、报告去重、Bilibili 未开播主播名、手动停止后同周期抑制。

### 修复

- 大 job 的 `ANALYSIS_PACKAGE_MISSING`：`listPackages` 默认 50 条；新增 `getJobPackage()` 精确查询。
- 每批导入重扫全部 session 观众造成 O(批次×观众) 阻塞：只更新本批观众。
- 每批重复 DNS 安全检查：按 Base URL 缓存 5 分钟。
- 付费路径 429 未使用 `Retry-After`、固定 1.2/2.4s 等待、完全串行、30 批上限。

### 测试

- 全量 **548 passed / 0 failed**。
- Mock：1,000 观众 / 10,000 消息 → 100 批、100 请求、峰值并发 6、6,491ms、15.41 req/s、覆盖 1,000/1,000。
- 真实付费 API：**阻塞**（本机无 Provider 配置/密钥/环境变量）；未伪造。
- EXE：已构建 v0.13.1（91.5 MB / 164 assets / requireAdministrator），未运行（UAC 拒绝）。

## 0.13.0 — 2026-11-11（单场/画像解耦 + 多 Provider + 付费画像）

### 新增

- 四种权限模式：手动（无 Key，仅单场）、匿名免费（仅单场）、API 免费模型（仅单场）、付费模型（单场 + 长期画像）。
- 独立 `session` / `memory` 任务与独立保存；单场失败不影响画像，画像失败不覆盖单场报告。
- 手动单场单包：无 `memory_context.json` / `viewer_excerpts.jsonl` / 全量 `viewer_context.json`，不要求 `viewer_profiles` / `viewer_memory_updates`。
- 多 Provider：OpenAI、Anthropic、DeepSeek、MiniMax（cn/intl）、阿里云百炼（4 区域）、OpenRouter、自定义 OpenAI-compatible。
- Provider 配置存储、加密凭据、区域密钥轮换、URL/私网/DNS 安全检查。
- 六层能力检测、费用状态（匿名免费/API 免费/付费/未知）、预算保护、usage/成本估算。
- OpenRouter 官方模型列表：上下文、输入/输出价格、免费状态、structured output 能力。
- 设置页 Provider 配置卡；AI 分析中心分析方式/内容/配置/预算/opt-in/暂停恢复/三语状态。
- schema 13：AI 任务模式、Provider 快照、预算/usage、能力检测审计表。
- 结果 Schema 1.3.0：`analysis_scope`；1.0.0–1.2.0 继续可导入。

### 变更

- 旧 combined 任务仍可读取，固定 Schema 1.2.0；新 UI 不再创建。
- 报告读模型排除 memory-only 结果；历史长期画像不删除。
- 匿名免费自动分析限定为单场；不再尝试更新长期记忆。

### 未验证

- 无真实 API Key，OpenAI/Anthropic/DeepSeek/MiniMax/DashScope 生成请求未执行；不得标记为真实通过。
- 无真实浏览器/EXE 验收。

## 0.12.1 — 2026-11-11（真实故障修复：自动分析可靠性 + 手动导入诊断）

### 修复

- **自动分析无效 JSON**：`json_object` 下 25 观众批次把 9,250 tokens 输出预算耗在重复字段名，
  `finish_reason=length`。改用 `json_schema` structured output，并记录 `finish_reason` / usage /
  退化检测；`length` 明确报 `AUTO_OUTPUT_TRUNCATED`。
- **跨批次观众 ID 混用**：批次 `viewer_context.json` 含其他记忆批次的观众，模型会写入这些
  ID 并漏掉本批观众。自动批次改为模型只输出 `ref`，本地按分配表组装真实 `viewer_id`；
  不再允许模型提供身份。
- **缺失观众**：缺少 ref 时执行一次有界定向补充（只发送缺失观众及其摘录）；仍缺失则
  `AUTO_VIEWER_COVERAGE_INCOMPLETE`，不写库、不默认 `no_new_information`。
- **手动提示词自相矛盾**：删除三语“不要输出观众身份字段”，明确 `viewer_id` 必须原样复制、
  零摘录观众仍须一条空更新、`viewer_context` 中非本批观众不得写入。
- **手动导入错误不可操作**：预览新增 `memory.gaps`（missing/unknown/duplicate，含昵称），
  界面列出缺失观众并提供「复制修复指令」；绝不自动替换 ID。
- **52 观众包过大**：`memory_context.viewers[]` 去掉与 `viewer_context` 重复的累计字段，
  新增 `evidence_seqs` / `zero_excerpt`；提示词去掉重复的 messages/excerpts 与完整结果 Schema。
- **汇总截断**：汇总阶段也用 structured output，强制 `viewer_memory_updates: []`，
  输出预算 12,000。

### 变更

- 自动批次 25 → **10 位记忆观众/批**；批次上限 12 → **30**（10×30 仍支持原 300 位）。
- 提示词版本 `lm-prompt-m6.2` → **`lm-prompt-m6.3`**；旧失败任务不再复用，点击会创建新任务。
- `session_context.session.duration_seconds` 新增；汇总提示词要求用记录时长，不用聊天回溯推断。
- 新错误码：`AUTO_OUTPUT_TRUNCATED`、`AUTO_OUTPUT_DEGENERATED`、
  `AUTO_VIEWER_COVERAGE_INCOMPLETE`。
- 数据库 schema 仍为 **12**，结果 Schema 仍为 **1.2.0**；无迁移。

### 测试 / 真实验证

- 新增 `auto-assemble`、`ai-import-repair`、`auto-compact`、`manual-52-viewers` 测试；
  更新 auto client/prompt/api、ai-prompts/api/import 的提示词版本断言。
- 真实 OVH：52 位观众 / 99 条消息 / 6 批 + 汇总 → `complete`，52/52 覆盖，7 条结果。
- 真实单批：10 位 10/10（14.4 秒）、25 位 25/25（20.4 秒）。
- 手动真实 52 人：49/52，精确列出 3 位缺失；正确 52/52 JSON 可导入。
- 全量测试结果见 `docs/STATUS.md` §3。

## 0.12.0 — 2026-11-11（匿名免费 AI 自动分析）

### 新增

- **真实接口调查**：先实测再集成。OVHcloud AI Endpoints `gpt-oss-20b` 匿名通道通过真实
  LiveMemory 包；Murakumo / llmfaucet / LLM7 / Pollinations 均未通过，详见
  `docs/ANONYMOUS_AI_RESEARCH.md`。
- **`src/ai/auto/`**：provider 配置、匿名限流客户端、包内提示词、持久状态、Runner、错误类型。
- **一键自动分析**：创建/恢复任务 → 逐批发送 → 现有 Schema/业务校验 → 事务导入 →
  第二阶段汇总 → complete；全部可识别观众仍进入批次。
- **新 API**：`GET /api/ai/auto/services`、`GET /api/ai/auto/status`、
  `POST /api/ai/auto/run`（要求 `consent:true`）、`POST /api/ai/auto/cancel`。
- **UI**：AI 分析中心新增「自动 AI 分析」按钮、免费匿名 chip、首次隐私同意、真实阶段文案、
  取消、失败时按钮下方固定红色文案 + 折叠详情；手动导出/导入完全保留。
- **三语**：`ai.auto.*`、`ai.report.sourceAuto`、`errors.aiAuto*`；更新自动/手动说明。

### 修复 / 加固

- 输出预算最低 8000 tokens（实测 3040 会截断 gpt-oss 的 JSON）；最多一次修复、一次网络重试。
- 自动批次 250 消息 / 25 观众 / 600 摘录，最多 12 批；超出明确失败，不静默裁剪观众。
- 进度状态持久化到 `runtime/ai-auto.json`（无聊天/提示词）；重启标记 interrupted，
  再次点击复用同一 job 并跳过已导入批次。
- 失败不删除已完成结果、不覆盖已有长期记忆、不自动切换手动模式。
- 日志/状态只记录稳定错误码、provider、HTTP 状态、批次与耗时。

### 测试

- 新增 `auto-client`、`auto-prompt`、`auto-analysis`、`auto-api` 与 AI UI 静态测试。
- 全量 **525 passed / 0 failed**（约 93 秒）。
- 真实 OVH 包：`complete`、`semantic=3`、`source=auto`；真实跨场次“画画→吉他”旧事实 `superseded`。
- 构建：`dist/LiveMemory.exe` 91.2 MB / 151 资源 / requireAdministrator / SHA-256
  `342294c…`；本机直接运行被“需要提升”拒绝，**运行验收未完成**。
- 未验证：真实浏览器 UI、打包 EXE 出站请求、数千观众大场耗时。

## 0.11.1 — 2026-11-10（观众档案主播范围修复）

### 修复

- **观众档案的「主播范围」只显示该观众实际出现过的主播**。此前详情页把
  `/api/broadcasters` 返回的全部主播直接传给范围选择器，导致软件记录过 20 位主播时，
  某位只在 1 位主播处出现过的观众也会看到 20 个选项。
- 选项现在来自该观众的 `viewer_broadcasters`（真实聊天、礼物、SC、大航海等可识别互动），
  不再来自全局主播列表；同名但平台/稳定 ID 不同的观众仍分别计算。
- 后端 `buildViewerProfile` 在请求一个与该观众无关系的主播时返回 `scope.kind='none'`，
  不再把无关主播包装成空范围；无效的 `?broadcaster=` 会安全回退到当前/第一个有效关联。
- 只有一位关联主播时不再渲染无意义的下拉框，改为只读主播标签；没有关联主播时显示明确空状态。
- 观众详情中的长期记忆上下文只使用该观众真实关联的主播，不回退到全局当前主播。

### 测试

- 新增 `tests/unit/viewer-scope.test.mjs`：单主播/双主播/多主播选项、无效 scope 回退、
  单主播隐藏下拉与空状态、列表页仍保留“全部/未归属”选项。
- 新增 `tests/integration/viewer-broadcaster-scope.test.mjs`：单主播、双主播、三主播、
  无关联观众、跨平台同名观众、仅礼物互动、请求无关主播返回 `scope.kind='none'`。
- 全量 **495 passed / 0 failed**。

## 0.11.0 — 2026-11-10（长期记忆与 AI 分析中心一体化）

### 新增

- **一次 AI 分析、一次导入同时完成本场报告与长期记忆**：分析包新增
  `memory_context.json` 与 `viewer_excerpts.jsonl`；结果 Schema **1.2.0** 新增
  `viewer_memory_updates`。导入在同一 SQLite 事务中保存分析结果、确保客观互动历史、
  增量合并语义记忆并更新覆盖状态。
- **全部可识别观众覆盖**：取消最低发言次数、最低活跃度、Top N 与“证据不足就省略”的长期记忆门槛。
  每场只有一句话、只有礼物/SC、没有新语义信息的观众都会进入处理范围；无新语义时明确标记为
  `no_semantics`，而不是跳过。
- **观众只分配一个批次**：每个观众的本场全部可用发言（最近 120 条）随其唯一记忆批次导出；
  观众数与消息数共同决定批次数量，批次上限 200 人 / 3000 条摘录，溢出会分配到其他批次，不静默丢弃。
- **已有画像进入上下文**：`memory_context.json` 提供每位观众现有摘要、事实、版本；AI 可 add /
  confirm / update / supersede / conflict / outdated / uncertain，证据 seq 必须属于同一观众。
- **客观历史与语义记忆分离**：首次/最近出现、场次、发言数、支持由真实记录确定性更新，
  AI 不能输出或修改；删除的记忆不会被旧包恢复。
- **覆盖预览与状态**：`ai_jobs.memory_viewers_total`、`ai_job_memory_viewers`、
  `ai_job_memory_messages`（schema 12）；导入预览显示已覆盖/新语义/无新语义/仅客观/缺失；
  任务状态增加 `memoryCoverage` / `memoryReady`。
- **移除独立长期记忆工作流**：删除 `#/memory` 页面与导航，旧书签进入 AI 分析中心；
  观众详情长期记忆标签保留，并新增客观互动历史卡（首次/最近、场次、发言、支持、最近场次）。
- **三语**：`ai.import.memory*`、`ai.jobs.memoryCoverage`、`memory.objective.*`、
  `memory.noSemantic*` 与新的记忆错误原因/修复建议。

### 修复

- 修复长期记忆只更新少数观众的问题：旧实现只合并 AI 返回的 `viewer_profiles`，
  而旧提示词明确要求“证据不足的观众请省略”；现在每位可识别观众都有独立记忆条目与覆盖状态，
  语义为空也仍更新客观历史。
- 修复 `viewer_profiles` 的 Top N/证据门槛导致的低活跃观众遗漏；长期记忆不再依赖该数组。
- 修复同一观众消息被拆到多个批次时画像无法汇总：观众只属于一个记忆批次，全部摘录随行。
- 修复旧结果缺少 `viewer_memory_updates` 时任务永远无法完成：旧 1.0/1.1 结果按
  `objective_only` 覆盖并允许任务完成。

### 测试

- 新增 `tests/integration/unified-analysis-memory.test.mjs`：五场每场一句话、普通问候、
  单条有效信息、300 位低活跃观众、跨批次/乱序/重复导入、缺少观众更新被拒绝。
- 全量 `node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`
  结果见 `docs/STATUS.md`。

### 未完成

- 真实 AI 返回统一 `viewer_memory_updates` 的样本；数千观众真实大场性能；
- 真实浏览器 UI 验收与截图（本机策略仍阻止）；
- 打包 EXE 运行验收。

## 0.10.0 — 2026-11-10（自动直播监听与持久化 Tab）

### 新增

- **自动直播监听（schema 11）**：新增 `monitor_targets`（持久监听目标）与
  `sessions.monitor_target_id`。目标对应 Bilibili 直播间或 YouTube 频道，**不等于单场直播**：
  关播只结束当前 session，目标与 Tab 保留；下次开播创建新的独立 session。
- **统一监听核心**（`src/monitoring/`）：状态机 `waiting / checking / connecting / recording /
  ending / paused / error`；公开视图可从连接状态派生 `reconnecting`，但数据库不会把重连写成新一场。
  调度器按到期时间检查，启动错峰，每平台串行 pacer，最多 2 个并发；抖动 + 指数退避 +
  `Retry-After`；连续 4 次失败进入可见 `error`，30 分钟后低速重试。
- **Bilibili 自动监听**：支持直播间 URL、短房间号、真实房间号；添加时规范化并保存主播身份；
  等待开播时只查询公开 `get_info.live_status`（约 1 分钟，45–90 秒抖动）；确认开播后复用现有
  WebSocket 适配器，下播确认仍由现有 `LIVE`/`PREPARING` + `live_status` 逻辑负责。
- **YouTube 自动监听**：支持频道 URL、`@handle`、`/c/`、`/user/`、裸 Channel ID 和已知视频链接；
  用公开 `/channel/<id>/live` 页面判断直播（`videoDetails.channelId` 必须匹配、`isLive`/`isLiveNow`），
  预定直播/首映/普通视频/回放不当作直播；解析失败时用 RSS + 最多 2 个 watch 页确认回退。
  **不需要 Google Data API、OAuth、API Key、Cookie 或登录**，也不下载视频/音频。
- **持久 Tab**：监听 Tab 固定在直播页，显示等待/检查/连接/记录/重连/确认结束/暂停/错误，
  以及上次检查、下次检查、上次直播、错误原因和最近场次；可在 Tab 内暂停/恢复/立即检查/删除。
  删除目标不删除历史场次；记录中删除目标被拒绝；暂停监听不停止当前记录。
- **重启恢复**：目标持久化，重启后错峰恢复；不要求软件关闭时继续监听。启动时残留的
  `checking/connecting/ending` 与已中断场次会被安全归位。
- **API**：`GET/POST /api/monitoring`、`PATCH/DELETE /api/monitoring/:id`、
  `POST /api/monitoring/:id/check`、`GET /api/monitoring/:id/sessions`；`/api/status` 与
  `/api/bootstrap` 增加 `monitoring` 能力与摘要。
- **M6/M7 兼容**：自动记录的场次是普通 `sessions`，可查看聊天/观众/统计、导出 AI 分析包、
  导入结果、参与长期观众记忆；`buildSessionSummary` 与 `serializeSessionRow` 暴露
  `monitorTargetId`。
- **数据管理**：删除场次清空目标指针但保留目标；删除目标只清空历史指针；清空数据/恢复出厂
  删除全部目标；数据目录迁移沿用现有数据库迁移流程。
- **文档**：新增 `docs/YOUTUBE_AUTO_DISCOVERY.md`（streammon / livestream_saver / yt-dlp /
  pytchat 调研、许可证、14 项比较、真实页面实测、请求预算与限制）。

### 测试

- 新增：Bilibili 检测器、YouTube 频道解析/页面解析/RSS 回退、监听状态机与调度、
  schema v10→v11 迁移、HTTP 目标 CRUD 与重启恢复、YouTube 两场自动记录端到端、
  M6 AI 包导出回归、监听 Tab/三语/CSS 静态检查。
- 全量 `node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`
  的结果见 `docs/STATUS.md`（本轮实测）。

### 未完成

- 真实双平台跨多天「开播→下播→再开播」长跑样本；
- 真实浏览器界面验收与截图（本机策略仍阻止无头浏览器）；
- 10+ 目标的长期请求量/限流观测；
- YouTube 页面结构变化的真实回归演练（本轮只做了少量只读实测）。

## 0.9.0 — 2026-11-10（M7：长期观众记忆）

### 新增

- **长期观众记忆（schema 10，8 张新表）**：`viewer_memories`、`memory_facts`、`memory_fact_evidence`、
  `memory_versions`、`memory_jobs`、`memory_job_batches`、`memory_job_messages`、`memory_job_viewers`、
  `memory_results`。记忆按 `broadcaster × viewer` 唯一；同一平台账号在不同主播处是两份独立记忆。
- **跨场次增量更新**：
  - 一键合并已导入的 M6 单场分析（不调用 AI），只新增/确认，不重复、不删除；
  - AI 记忆更新包（`livememory-memory-update-v1`）+ 三语提示词 `lm-prompt-m7.1-*`，按观众分批；
  - 合并引擎支持 `add`/`confirm`/`update`/`supersede`/`conflict`/`outdated`/`uncertain`。
- **事实、证据与可信度**：`certainty`（stated / inferred / uncertain）与 `status`（active / outdated /
  conflicted / superseded / needs_confirmation）分离；事实级证据（场次、批次、`seq`、`event_id`）；
  原文清理或事件删除后证据降级为 purged / partial / unavailable。
- **版本与差异**：每次应用写一个版本（完整快照 + 逐条差异）；可回滚，回滚本身也是新版本；每个记忆保留最近 20 个版本。
- **矛盾与状态变化**：状态变化用 `supersede` 保留旧事实；矛盾双方标记 `conflicted`，不替主播裁决；
  超 180 天未确认的活跃兴趣/偏好标记 `outdated`，绝不转成 dislike。
- **人工复核**：确认、标记过时、恢复、忘记单条；每次操作产生新版本。
- **隐私**：删除单个观众的长期记忆（墓碑阻止旧包恢复）；本地合并不复活已删除记忆；
  过期清理（默认仅预览）；原始聊天清理/删除场次/清空数据/恢复出厂全部联动。
- **界面**：新增 `#/memory` 四步工作台（选择直播 → 本地合并 → 导出 AI 包 → 导入预览应用）+
  最近任务 + 最近观众 + 保留与清理；观众档案改为「概览 / 长期记忆 / 互动历史 / 历史版本」标签页。
- **文档**：`docs/AI_CONTRACT.md` 新增记忆协议章节；`docs/DATA_MODEL.md`、`docs/PRIVACY_SECURITY.md`、
  `docs/UI_DESIGN.md`、`docs/TEST_PLAN.md`、`docs/ROADMAP.md` 同步更新。
- **测试**：新增 8 个测试文件（模型、引擎、UI 静态、本地合并、AI 工作流、隐私、迁移、HTTP API），
  全量 **450 passed / 0 failed**。

### 修复

- 修复 180 天过时规则误伤「身份类」与「不确定」事实；修复兴趣-反感同话题互相覆盖的风险
  （改为显式矛盾）；修复同话题 `conflict` 会破坏「一话题一条存活事实」唯一约束的问题；
  修复人工复核可复活已替换事实的问题；修复本地合并可能复活已删除记忆的问题。

### 未完成

- 真实浏览器渲染/截图（本机策略阻止无头 Edge/Chrome 启动）；
- 打包 EXE 运行验收（v0.9.0 已构建：91.0 MB / 134 资源 / requireAdministrator，本机 EPERM 无法启动）；
- 真实 AI 服务往返与大观众量性能验证。

## 0.8.1 — 2026-11-10（Bilibili 直播生命周期检测修复）

### 修复

- **Bilibili 下播后仍显示「直播中」**：适配器此前忽略 `PREPARING`/`STOP_LIVE`，
  不处理 `LIVE`，也从不查询 `live_status`；`sessions.status='live'` 只代表本地
  WebSocket 采集仍在运行。现在平台状态与采集状态分离，并由多信号确认下播。
- 启动恢复不再把最后一条弹幕时间当作场次结束时间；`ended_at` 使用启动检测时间，
  `platform_ended_at` 在证据不足时保持 NULL。
- 旧适配器的异步回调不能在停止/结束后写入场次；快速下播再开播创建新场次；
  重连 `live_time` 变化或 `PREPARING` 后的新 `LIVE` 会结束旧场次，避免混场。

### 新增

- schema **9**：`sessions.platform_status`、`platform_status_at`、`last_live_seen_at`、
  `platform_ended_at`、`platform_end_quality` 与索引。
- Bilibili 每 60 秒 `room/v1/Room/get_info` 状态查询，8 秒超时、指数退避、每房间独立。
- WebSocket `LIVE`/`PREPARING`/`STOP_LIVE` 处理；WS 下播事件 + 1 次有效离线查询，
  或 2 次连续有效离线查询才结束。
- 自动下播：清定时器/WebSocket/重连 → 写最终事件 → 更新结束时间/原因/平台状态 →
  SSE 刷新；保留全部数据。
- 历史异常行启动后台探测：证据不足标 `unknown`，不编造结束时间，幂等且可追溯。
- 历史列表/详情/多场标签区分「直播中、已下播、手动停止、采集中断、平台未知」；
  平台结束后不再显示绿色；详情新增生命周期卡；三语 + 明暗 + 390px。
- 未开播/轮播房间在创建采集前被拒绝，并显示三语错误。
- 新增 `scripts/verify-live-status-ui.mjs` 与生命周期测试；
  schema 9 / v8→v9 迁移测试；真实 Bilibili 状态接口与 4 房间 20 分钟监控。

### 测试

- 386 自动化全部通过；EXE 矩阵 10/10；EXE 历史 19/19；EXE 生命周期 UI 21/21。
- **未完成真实下播端到端**：真实监控期间没有主播下播，不能声称已完全验证。

## 0.8.0 — 2026-11-09（M6：AI 分析结果导入、分批汇总与直播分析报告）

### 新增

- **完整 AI 文件往返**
  - `POST /api/ai/jobs`：创建分析任务，按消息边界拆批导出 `livememory-analysis-v1` 包；
    任务记录场次、主播、提示词语言/版本、批次大小与消息总数；
  - 包 manifest 新增 `job_id`、`stage`、`batch`（批次 id/序号/总数/seq 范围/时间覆盖/校验和）、
    `coverage`、`prompt_version`、`schema_version`；`messages.jsonl` 新增 `event_id` 与平台 `message_id`；
  - `POST /api/ai/import/preview`：显示场次、任务、批次/汇总、包标识、Schema 版本、覆盖范围、
    重复/新版本、缺失批次、错误与警告；只读，不写结果；
  - `POST /api/ai/import`：文件或粘贴 JSON，服务端重新校验，单 SQLite 事务写入结果与证据；
    失败回滚，不留下部分结果；
  - JSON 文件上限 8 MB；支持剥离一层 Markdown 代码围栏；超大请求先丢弃再返回 413。

- **严格校验**
  - 无依赖 JSON Schema 2020-12 子集验证（type/const/enum/required/unknown field/items/min-max/
    length/number/date-time/oneOf），加上结构深度/节点/字符串/危险键防护；
  - 业务校验：协议、Schema 版本、场次、任务、批次、主播快照、观众稳定身份、时间窗口、消息引用、
    汇总前置条件；错误含字段路径、稳定错误码、原因与修复建议（三语）。

- **版本与状态**
  - 相同结果（规范化 JSON SHA-256）重复导入不写第二行；不同结果必须显式 `createVersion`，
    追加新版本并保留旧版本；报告使用最新版本；
  - 任务状态 `awaiting_import` / `partial` / `awaiting_aggregate` / `complete` / `invalid`
    全部由数据库计算，重启保持；`sessions.ai_status` 同步；
  - “重新分析”创建新任务，旧任务与结果版本保留。

- **分批与汇总**
  - 稳定批次 id、seq→event 映射、批次观众集合；消息不丢失、不重复、不截断；
  - 乱序导入、重复批次、缺失批次、错误批次检测；
  - 全部分批结果导入后可生成第二阶段汇总包（无原始消息，含 `batch_results.json`）；
    导入最终 JSON 后任务才 `complete`；
  - 部分结果按批次分别展示，不拼接成假整场报告；汇总结果中的证据必须写 `{batch, seq}`。

- **直播分析报告**
  - `GET /api/ai/sessions/:id/report` + `ai-report.js`：摘要、话题时间线、情绪、争论、候看片段、
    观众画像、来源（结果版本/提示词版本/Schema/批次覆盖/文件或粘贴）、证据；
  - 证据解析到真实事件行；原文被保留策略清理或行删除时明确显示“不可用/已删除”，不伪造；
  - 明确说明 LiveMemory 没有视频/音频，片段建议只是基于聊天与事件的候选时间范围；
  - 历史详情页新增 AI 报告摘要卡与完整报告入口；部分结果标记不完整；仅导出显示等待导入。

- **三语提示词版本**
  - `lm-prompt-m6.1-zh-CN/ja/en`；任务与包记录实际版本；三语语义结构一致；
  - 批次规则（只分析本批、时间覆盖、seq 引用、部分结果）与汇总规则（合并、冲突、`{batch, seq}`）
    全部本地化；切换界面语言不改变已创建任务/批次/校验规则。

- **数据模型 / 删除 / 清空**
  - schema 8：`ai_jobs`、`ai_job_batches`、`ai_job_messages`、`ai_job_viewers`、`ai_results`、
    `ai_result_evidence`；`ai_packages` 新增 `job_id`/`batch_index`/`stage`/`prompt_version`；
  - 删除场次于同一事务删除全部 AI 任务/批次/映射/结果/证据/包记录并删除批次/汇总文件；
  - 清空数据与备份计数包含全部 AI 表；旧整场包与 1.0.0 结果仍兼容。

- **工具 / 文档**
  - 新增 `scripts/demo-ai.mjs`、`scripts/verify-ai-ui.mjs`、`scripts/verify-exe-ai.mjs`；
  - 新增 `tests/helpers/ai-fixtures.mjs`、`ai-import`、`ai-batching`、`ai-api`、`ai-migration`、
    `ai-prompts`、`ai-ui` 测试；
  - STATUS / HANDOFF / ROADMAP / ARCHITECTURE / AI_CONTRACT / DATA_MODEL / PRIVACY_SECURITY /
    TEST_PLAN / UI_DESIGN / README / DECISIONS 与开发日志同步。

### 变更

- 版本 **0.8.0**；schema **8**；`/api/status` 与 `/api/bootstrap` 的 `ai.import` 改为 `true`，
  增加结果 Schema 版本。
- 旧版 `POST /api/ai/packages` 仍保留整场导出；新 UI 使用任务/批次接口。
- `aiChip` 支持 `partial` / `complete` / `invalid`。
- 全量测试 353；浏览器 UI 17/17；打包 EXE AI 14/14；EXE 历史回归 19/19；EXE 矩阵 10/10。

### 已知限制

- **没有调用真实 AI 服务**：测试结果是使用真实包元数据构造的 Schema 合法合成结果；
  真实 AI 输出差异仍是下一轮首要验证项。
- 本轮无新的真实 Bilibili/YouTube 采集；UAC、真实文件夹选择、干净 Windows、M5 备份仍未验证。
- YouTube 30 天清理不会自动删除已导入 AI 结果中的观众画像/摘要；不得声称完全符合平台政策。
- 无单结果版本删除；无后台自动重试/断点续传；不导入 ZIP；不处理视频/切片。
- 单任务 50,000 条上限；未做 10 万条/20+ 批次压力测试。

## 0.7.0 — 2026-11-09（直播历史场次管理、统一搜索、永久删除）

### 新增

- **场次管理（列表 + 详情共用）**
  - 停止记录：只停指定场次，保留消息/观众身份/统计/经济支持；`status=ended`、`end_reason=user`；
    UI 区分“已停止记录”与“已结束”，明确平台直播可能仍在进行；
  - 归档/取消归档：schema v7 `sessions.archived_at`，独立于 `status`；live 禁止归档；
    默认列表隐藏，支持“包含已归档/查看归档”；归档场次仍可搜索、查看、导出 AI 包；重启保持；
  - 永久删除：`DELETE /api/sessions/:id`（必须 `{confirm:true}`），事务删除消息/事件/支持/统计/
    观众参与/AI 包记录，重建观众与主播维度聚合，清理孤立派生行，删除导出文件；
    正在记录或 adapter 未退出时拒绝；失败整体回滚；无残留校验；
  - `end_reason`：user / adapter 原因 / failed / shutdown / startup_recovery。

- **直播历史搜索**
  - `GET /api/history/search`：主播（名称 + 稳定 ID）、标题（中日英/混合）、观众（稳定 ID + 昵称 + 历史昵称）；
  - 同名不同 ID、跨平台同名分别返回，绝不合并；匿名消息不生成观众结果并明确提示；
  - 结果说明主播/标题/观众匹配原因；观众匹配显示本场消息数，可下钻最近 50 条发言；
  - 平台 / 状态 / 日期范围 / 包含归档筛选可组合；默认倒序；20 条/页“加载更多”；
  - `%`/`_` 按字面匹配；不读取聊天正文。

- **UI**
  - 历史列表工具栏、行内 `···` 菜单；详情标题区同一菜单；
  - 共享 `dialog.js` 与 `actions-menu.js`；键盘/触屏/窄屏、焦点返回、视口夹紧；
  - 三语新增完整文案；v0.7.0 截图与 UI 验证脚本。

### 变更

- 新增 `src/server/session-admin.mjs`、`src/analytics/sessions/history-search.mjs`、
  `src/web/js/{dialog,actions-menu,session-actions}.js`；`history.js` 重写。
- `/api/sessions` 支持 `includeArchived` / `archivedOnly`，默认隐藏归档；AI 页面显式包含归档。
- 两个停止端点共用 `stopSessionRecording`。
- schema **7**：新增 `archived_at`、`end_reason` 与 5 个历史/搜索索引；旧库原地升级，不重写历史行。

### 测试 / 构建

- 自动化：**318 passed / 0 failed / 约 25.0 秒**。
- 浏览器 UI：`verify-history-ui.mjs` **27/27**。
- EXE：90.4 MB / 106 资源，SHA-256 `9602c5607782ee72645f32019fbba7b28ca6cb6722bfd70c1bdeebed57877e1f`；
  `verify-exe.mjs` **10/10**；`--version` 0.7.0。
- 打包 EXE UI：`verify-exe-history.mjs` **19/19**（真实 v6→v7 升级、搜索、归档、重启保持、停止、删除、
  共享观众聚合、专属观众清理）。
- 本轮没有新增真实平台网络采集；v0.6.0 真实并发结果仍为历史样本。

### 已知限制

- 删除不可撤销、无回收站；未做批量归档/删除。
- 当前没有 AI 结果/画像表；未来 M6 必须把 AI 结果加入同一删除事务。
- 真实 UAC、真实文件夹选择、干净 Windows 环境、M5 备份仍未验证。
- 性能基线 1200 场 / 12000 事件，未做百万级或 10+ 场长时间压力。

## 0.6.0 — 2026-11-09（多直播间并发记录、标签页、Top 100）

### 新增

- **多直播间同时记录**
  - `SessionManager` 改为每个 `sessionId` 独立 recording/adapter/连接状态/结束回调；
  - 同一 `platform + room` 重复启动在内存与数据库双重拒绝，返回 `409 SESSION_DUPLICATE_ROOM`；
  - 停止、失败、自动结束只影响对应场次；启动恢复仍把所有残留 live 标记 interrupted；
  - 新 `GET /api/live/recordings`、`POST /api/live/recordings/:sessionId/stop`；
  - 平台 disconnect 支持 `sessionId`；同平台多场且缺 ID 时返回 409 `SESSION_ID_REQUIRED`。

- **直播记录标签页**
  - 顶部固定「＋ 新建记录」+ 可横向滚动的直播标签；
  - 标签显示主播/直播间名称、状态点与连接中/记录中/重连中/已停止/连接失败；
  - 切换标签只切视图，不改后台采集；`viewToken` 丢弃旧响应，避免串场；
  - 每场独立 Hero、统计卡、消息密度图、最近动态、Top 100 与经济支持；
  - 运行中标签不提供关闭按钮；已停止标签可关闭，数据保留在直播历史。

- **最活跃观众 Top 100**
  - 查询上限从 20 提到 100，排序 `message_count DESC, platform_uid, viewer_id`；
  - 新 `GET /api/sessions/:id/top-viewers`，返回固定 rank；
  - UI 默认约 10 行可视、区域滚动最多 100 名；搜索昵称/UID 保留 rank；
  - 点击观众进入 `/viewers/<id>?broadcaster=<当前主播>`；
  - schema v6 新增 `idx_viewer_sessions_speakers`。

- **启动器控制台默认英文**
  - 双击 EXE 时控制台输出英文，不再跟随网页语言；
  - `--lang zh-CN|ja|en` 仍覆盖；网页界面继续三语/跟随系统；
  - 多场时状态行显示“Recording N live streams”。

- **开发/验证工具**
  - `scripts/demo-multi-recording.mjs`：3 场模拟记录，仅用于 UI 截图/联调；
  - `scripts/verify-live-ui.mjs`：DevTools 协议验证标签、Top 100、搜索、档案跳转、重入、窄屏；
  - `scripts/verify-live-multi.mjs`：真实网络并发验证，支持 `--base` 附加到 EXE。

### 变更

- 所有事件仍统一经 `EventIngest`；去重作用域仍是 `(session_id, dedupe_key)`，因此同一 external id 可以合法存在于不同场次。
- `app.js` 移除全局 `livesummary` 轮询，避免每个事件触发全量 summary 查询。
- schema 6；旧库原地升级，历史数据不重写。

### 测试 / 构建

- 自动化：**296 passed / 0 failed / 约 24.5 秒**。
- UI：`verify-live-ui.mjs` **10/10**。
- EXE：90.3 MB / 101 资源，SHA-256 `cbf17f0c83d9af40003085c0f0acba8b3f9e12e4663bfe50f5bfc61965ec1598`；`verify-exe.mjs` **10/10**；`--version` 0.6.0。
- 真实并发：
  - 2 YouTube：80 / 63 事件，隔离 0 串场，重复启动 409；
  - YouTube + Bilibili room 6：76 / 11，停 A 后 B 收到新事件；
  - 3 场：85 / 66 / 6，停 A 后 2 场仍 connected；
  - EXE 附加 3 场真实直播：73 / 67 / 5，3/3 connected。

### 已知限制

- 运行中标签不能隐藏/关闭；必须先停止。没有静默停止。
- 无并发上限；未做 10+ 场数小时压力测试。
- 真实 UAC、真实同观众跨主播观测、Bilibili 礼物/SC/大航海真实样本仍未完成。

## 0.5.0 — 2026-11-09（文件夹选择器、YouTube 单一公开网页、管理员 EXE）

### 修复

- **“在新目录创建新的数据空间”误报校验失败**
  - 根因：staging 无条件复制旧 `livememory.db`，新空间实际打开的是旧库；表非空校验触发回滚。
  - 修复：仅 `migrate` 复制数据库；`new` 由 `createFreshDatabase()` 新建空库。
  - 新空间失败文案改为“创建新数据空间失败”，不再误称“迁移”。
  - 新增集成回归测试：新空间 0 场次/事件/观众，设置与凭据保留，原目录不动。

- **Windows「浏览」文件夹选择器**
  - 根因：旧实现通过 `execFile` 捕获 PowerShell stdout，在受限/打包环境中 `spawn EPERM`，脚本未执行。
  - 改为 `spawn(..., {stdio:'ignore'})` + 临时 UTF-8 结果文件 + `-EncodedCommand`；不依赖 stdout 管道。
  - 原生 `FolderBrowserDialog`（STA + owner form），取消不报错、不改变输入；脚本错误/超时显示可诊断错误。
  - 中文/空格路径、手动输入、迁移确认流程保持不变。

### 变更 / 删除

- **YouTube 只保留公开网页聊天**
  - 删除官方 Data API 客户端、OAuth 登录/回调/令牌存储、API Key 配置、官方适配器、`capture-mode` 与对应测试。
  - 删除 `/api/youtube/login/start|status|logout`；`/api/youtube/video|connect` 不再接受 `mode`。
  - 删除 `settings.youtubeCaptureMode`；旧 settings 中的键加载时忽略。
  - 直播页与设置页删除官方/实验模式切换、Google 登录、API Key/OAuth、配额、实验 badge；只保留链接输入、检查、开始、连接状态、保留说明。
  - 保留匿名 web 适配器的聊天/SC/Sticker/会员/gift/badge/稳定 Channel ID/去重/重连/自动结束/30 天保留。
  - 设置/隐私说明保留简短、真实的“非官方稳定 API、可能失效、无官方授权”提示。

- **管理员权限 EXE**
  - 构建时把 node.exe 的 RT_MANIFEST 从 `asInvoker` 改为 **`requireAdministrator`**。
  - 非提升进程启动最终 EXE 被 Windows 拒绝（EACCES）；UAC 批准后的真实启动未在无交互会话验证。
  - 启动器增加防御性管理员检查与三语提示；非权限错误仍单独显示。
  - 打包启动且当前默认目录无数据库时扫描本地用户配置，恰好一个使用、多个拒绝猜测；防止跨账号 UAC 静默建空库。

### 测试 / 构建

- 自动化测试 **277 通过 / 0 失败**；删除 5 个官方 YouTube 测试文件，新增选择器、manifest、管理员、profile scan、简化约束、新数据空间测试。
- EXE：90.2 MB / 99 资源，Manifest `requireAdministrator`，SHA-256 `3ac16ddc4b46e569bfe11b3146e72b874a120c8ade26c3a7b709f2ed40ecf099`。
- `verify-exe.mjs`：manifest + 9 功能场景 = 10/10；非提升会话使用临时 asInvoker 副本并明确标注。
- 真实 UAC 点击、真实文件夹选择、v0.5.0 真实 YouTube 采样未完成，见 STATUS/TEST_PLAN。

## 0.4.0 — 2026-11-08（Header 语言、数据目录迁移、清空/出厂、多主播档案）

### 新增

- **Header 语言快捷切换**
  - 顶栏外观切换旁新增语言控件：宽屏三个原生语言名 + 地球“跟随系统”，窄屏原生 select。
  - 与设置页共享同一份 `locale` 偏好；切换立即生效、持久化、不刷新页面。
  - 三语 `aria-label`；390px Header 无溢出；与主题切换互不干扰。

- **数据存储位置**
  - 设置页显示真实目录、来源、位置记录、可写状态、空间、占用与计数；支持修改、打开文件夹、刷新。
  - 两种模式：迁移现有数据（推荐）/ 在新目录创建新数据空间；旧目录永不自动删除。
  - 位置记录 `data-location.json`（LOCALAPPDATA，APPDATA 镜像）；目标必须存在且含数据库，断盘时不创建空库。
  - 迁移：WAL checkpoint、staging 复制、SQLite integrity/表计数/schema/文件 SHA-256、运行时重建、单实例锁转移、失败回滚。
  - 原生目录选择器（固定 PowerShell + WinForms）、OneDrive/云同步/临时/长路径警告、UNC 拒绝、系统目录拒绝。
  - CLI：`--forget-data-location`。

- **清空数据与恢复出厂设置**
  - 数据管理危险区；`data` 模式保留设置/凭据/位置记录/备份/无关文件；`factory` 额外清除偏好/凭据/日志/缓存并恢复默认。
  - 必须输入 `DELETE` / `RESET`；记录中禁止；默认创建 `VACUUM INTO` 数据库快照到数据目录之外。
  - 事务删除 + `VACUUM` + WAL checkpoint + 运行时重建；数据库保持 schema 5 的空库。
  - 清空后不会从缓存重新出现旧观众。

- **多主播观众档案（schema v5）**
  - 新表 `broadcasters`、`viewer_broadcasters`、`viewer_broadcaster_currency_totals`；`sessions.broadcaster_id` / `broadcaster_identity`。
  - 主播身份：YouTube channelId；Bilibili anchor uid，缺失时 room fallback；mock；无法确定保留 unresolved。
  - 同一平台观众身份全局唯一，主播 × 观众互动上下文独立；发言/付费/币种按主播分账。
  - 观众页主播范围选择器、搜索、排序、新/回访观众；详情页参与主播切换与全局概览。
  - API：`/api/broadcasters`、`/api/broadcasters/:id`、`/api/broadcasters/:id/viewers`、范围化 `/api/viewers`。
  - AI 包：`session_context.broadcaster`、`viewer_context[].broadcaster_context`、`lifetime`、`other_broadcaster_count`；指令新增主播上下文隔离规则。

- **测试与构建**
  - 自动化测试 **305 通过 / 0 失败**；新增 broadcaster、header-language、broadcaster-identity、storage-management 测试。
  - EXE **90.3 MB / 103 资源**，SHA-256 `4aae59fe6f8d0a6cdc13811d27cc732e1e17cd6a6dac5d5fa4da450efbb1387f`；`verify-exe.mjs` **9/9**。
  - 18 张新截图。

### 未包含 / 未验证

- 旧 YouTube 场次无法确认主播时保持 unresolved；没有手动归属 UI。
- 映射网络盘（盘符）未自动识别；真实断盘/断电/磁盘写满迁移未做物理演练。
- 清空文件删除为尽力而为；M5 可移植备份、M6 AI 导入仍未实现。
- 未扩展 YouTube 未公开接口；匿名模式仍默认关闭、显示风险提示。
- EXE 未在第二台干净 Windows 验收；未 Push。

## 0.3.0 — 2026-11-08（YouTube 免登录实验接入与真实双房间验证）

### 新增

- **YouTube 免登录公开网页聊天（实验性，默认关闭）**
  - 新增 `src/platforms/youtube/anonymous/`：watch 页、`live_chat` 页、`get_live_chat` continuation、actions 解析。
  - 不发送 Cookie、OAuth token 或用户 API Key；只用公开页面自身的 client context 与 Web key。
  - 真实字段：`external_id`、`timestampUsec`、`authorName`、`authorExternalChannelId`、`authorBadges`、`message.runs`、`purchaseAmountText`、`giftMessageViewModel`。
  - 文字、Unicode Emoji、自定义表情代码、badge、Super Chat、Super Sticker、会员、gift 映射到现有 canonical event。
  - Continuation 更新、400/`failedPrecondition` 重开、429/网络退避、60 秒直播状态检查、自动结束。
  - 相邻消息时间跳变 > 90 秒标记 `gapSuspected`，UI 只说“可能漏消息”。

- **稳定身份与金额**
  - 聊天/SC 使用 `youtube:<channelId>`；新版 gift 无 Channel ID 时 `viewer_uid=null`，不按昵称合并。
  - 格式化金额仅在币种可确认时解析；沿用整数最小单位；保留 `amount_display` 原文；无法确认则金额未知。
  - 会员等级、gift 数量、赠送会员不换算金额。
  - ticker 展示不产生事件，避免 Super Chat 重复累计。

- **schema v4**
  - `events.badges TEXT`：owner/moderator/verified/member，可空。
  - `events.amount_display TEXT`：平台显示金额字符串，可空。
  - v1→v4 迁移测试；旧行为 NULL。

- **保留策略收紧**
  - `youtubeRawRetentionDays` 从 1–3650 改为 **1–30**，默认 30。
  - 清理原文、emotes、badges、amount_display 与过期 YouTube 昵称历史/当前昵称。
  - 保留计数、稳定 Channel ID 与金额合计；明确不等于完全删除个人数据。

- **界面**
  - 默认官方模式；无官方凭据时显示真实原因与“启用免登录实验模式”按钮。
  - 实验模式 warning：非官方接口、可能违反 YouTube ToS、可能随时失效。
  - 设置页新增 YouTube 接入卡；高级设置可切换官方/实验模式。
  - 动态流显示 badge；录制页显示实验模式、消息数与可能漏消息提示。
  - 三语、明亮/黑暗/跟随系统、390px 响应式。

- **测试与验证**
  - 自动化测试 259 → **287**；新增匿名 parser、adapter 重连、HTTP 集成、v1→v4 迁移、retention badge/nickname、settings 模式。
  - 真实房间 `FKLZiufsCk0` 35 秒：86 事件、86/86 Channel ID、1 笔 HKD 200000 SC、49 badge、0 错误。
  - 真实房间 `gXawf8GZDI8` 35 秒：100 事件、chat 87/87 Channel ID、13 gift（无身份/金额）、3 badge、0 错误。
  - EXE 90.2 MB，SHA-256 `9d586aa9…`，`verify-exe.mjs` 9/9；EXE 内真实匿名 72 条事件、72/72 Channel ID、0 错误。

### 尚未包含 / 未验证

- **匿名路径合规未确认，且很可能违反 YouTube ToS**；因此不是默认功能，正式发布前必须评估/取得许可。
- 官方 API 真实凭据下的直播采样与并排对照仍未完成。
- Super Sticker、会员、赠送会员没有真实匿名样本。
- 真实 429、验证码、consent/age wall、长时断网、数小时直播未验证。
- 30 天清理不等同于完全删除个人数据；严格删除模式未实现。

## 0.2.0 — 2026-11-08（YouTube Live 接入；并包含上一轮的表情兼容与 AI 分析中心通用化）

### 新增（本轮：YouTube Live）

- **真实的 YouTube Live 接入（仅直播）**
  - 直播定位：`videos.list` + `liveStreamingDetails`，支持 `watch?v=`、`/live/`、`youtu.be`、`embed`、`shorts`、裸视频 ID；普通视频、未开始、已结束、聊天关闭、私密/无权限、配额不足、网络错误都有独立提示。
  - 聊天传输：`liveChatMessages.list` + `nextPageToken`，遵守 `pollingIntervalMillis`；断线指数退避重连且**不结束场次**；`offlineAt` / `chatEnded` / `chatDisabled` 才结束；本地配额守卫。
  - 身份：`youtube:<channelId>`；只有昵称时 `viewer_uid=null`，不建档案、不按昵称合并。
  - 经济事件：Super Chat、Super Sticker、新会员、会员里程碑、赠送会员、收到赠送会员；`amountMicros` 用 BigInt 转最小货币单位，`JPY` 等零小数币种正确；多币种分别累计。
  - 会员等级/月数/赠送数量**不换算金额**；收到赠送会员的用户 `is_paid=false`，不再是付款者。
- **两种官方凭据模式，普通主播零 API Key 配置**
  - 公开直播模式（`api-key`）：应用级 API Key 匿名读取公开聊天，无需 Google 登录、无需 OAuth。
  - OAuth 模式：桌面应用 PKCE + 系统浏览器 + `127.0.0.1` 单次回环回调 + `state` 校验 + 5 分钟超时；自动刷新、重启恢复、失效提示、重新登录、退出登录（并 revoke）。
  - 凭据不进入仓库与默认构建；可用环境变量或数据目录私有文件提供；缺配置时界面明确说明，不伪造登录。
  - 令牌 AES-256-GCM 加密保存在 `<数据目录>\secrets\youtube-oauth.json`；`status()`、日志、AI 包、备份均不含令牌。
- **数据保留策略**
  - YouTube 公开聊天原文默认 30 天后自动清理（启动、场次结束、手动触发）；保留计数、身份、昵称历史与币种合计。
  - SQLite schema v3：`sessions.platform_started_at`（平台直播开始时间），用于相对直播时间。
- **界面**
  - 直播记录新增「YouTube 直播」标签：模式/登录状态、链接输入、检查结果、频道、当前观看、API 配额、保留策略与手动清理。
  - 录制中显示 YouTube 连接状态与当前观看人数；动态流支持 Super Sticker 与会员里程碑留言。
  - 三语（zh-CN / ja / en）、明亮/黑暗/跟随系统、390px 窄屏全部覆盖。
- **AI 分析包**
  - `session_context.session.broadcast_started_at` 与 `messages.jsonl.offset_seconds`（相对直播时间）。
- **计数修正**
  - `payment_event_count` 只在 `is_paid=true` 时累加：免费礼物与「收到赠送会员」不再计入付费事件。

### 新增（上一轮，随本版本发布）

- **Unicode Emoji 与平台表情**
  - `cleanText` / `truncateText` 改为按 grapheme 截断，组合 Emoji、变体选择符、肤色修饰符与 ZWJ 序列不会再被截断成乱码。
  - canonical event 新增可选 `emotes` 元数据（`id` / `code` / `name` / `source`），仅来自平台可靠字段。
  - SQLite schema v2：`events.emotes TEXT`，v1 旧库原地升级，旧消息 `emotes=NULL`。
  - Bilibili：识别 `DANMU_MSG.info[0][13]`，保存 `emoticon_unique` 与 `info[1]` 文字标签；无元数据时普通 `[文字]` 不误判。
  - 只有表情、没有正文的消息也会入库；UI 与 AI 包使用名称/id 回退。
  - 未知表情标记 `[未知平台表情：emote_id=…]`，不猜测情绪，不下载图片。
  - YouTube 离线 mapper 预留：文本、Unicode Emoji、`:code:` 自定义表情、稳定 channelId；明确标记未真实接入。

- **AI 分析包（文本优先）**
  - `session_context.emote_dictionary` 去重表情字典；`messages.jsonl` 使用 `emote_refs`。
  - 仅在原文不足时生成 `content_ai`，避免重复名称导致包膨胀。
  - `manifest.counts` 增加 `messages_with_emotes` / `emote_kinds`。
  - 三语 `instructions.md` 增加 Emoji/平台表情规则、未知表情禁止猜测、礼物不代表话题偏好、单表情不足以建立长期兴趣。

- **AI 分析中心通用化**
  - 界面统一为 AI 分析中心 / AI 分析包 / AI 分析指令 / AI 分析结果 / 导入 AI 分析结果，不再绑定 ChatGPT。
  - 新增自然语言任务说明卡（整场话题、时间变化、回看片段、新观众、既有观众画像）。
  - 三语 AI 分析指令由软件按任务生成，用户无需手写提示词。
  - 明确“使用你选择的 AI 服务”，不假设通用 AI 网站。

### 修复

- 聊天文本截断可能切断 surrogate pair / ZWJ 序列的问题。
- 精简清理现在同时清除 `content` 与 `emotes`，不残留聊天元数据。

### 测试

- 自动化测试从 195 增至 **259**：新增 YouTube 链接解析、官方错误映射、配额计费、PKCE/回环/令牌交换与刷新、登录状态机与重启恢复、令牌加密与篡改、全部经济事件、`amountMicros` 多币种、轮询/重连/结束/配额守卫、保留策略、v1→v3 迁移，以及本地假 API 的端到端。
- 真实 Bilibili 房间 `5050` 采样：21/32 条 `DANMU_MSG` 带 `info[0][13]`，`info[1]` 为文字标签，`dm_v2` 为空。
- EXE 重建（90.1 MB，SHA-256 `8af88e25…`），`verify-exe.mjs` 9/9。

### 尚未包含 / 未验证

- **YouTube 真实凭据下的直播采样**：本轮没有可用的 API Key 或 OAuth 客户端，真实消息条数、稳定身份比例、真实 Super Chat/会员样本均未取得。
- YouTube 真实断网、配额耗尽、真实 OAuth 同意屏与 refresh token 过期规则未在线验证。
- AI 结果导入、Schema 校验、分批与长期画像（M6/M7）。
- 表情图片下载、缓存与显示。
- Bilibili `SEND_GIFT_V2`、礼物/SC/大航海真实事件复核。

## 0.1.0 — 2026-11-08（首个可运行版本）

### 新增

- **Windows 启动器**
  - 环境检查（Node ≥ 22.5、`node:sqlite`）
  - 数据目录解析与可写探测：`%LOCALAPPDATA%\LiveMemory`
  - 单实例锁与陈旧锁接管
  - 端口自动选择（47800 起，冲突顺延，最后系统分配）
  - 服务就绪后再打开系统默认浏览器
  - 中文 / 日本語 / English 命令行，跟随系统语言并读取已保存偏好
  - UTF-8 控制台
  - 优雅退出（停止记录、WAL checkpoint、关闭数据库）
  - 崩溃后恢复：把遗留场次标记为“已中断”

- **网页控制台（Apple 风格）**
  - 直播记录、直播历史、观众档案、AI 分析中心、设置
  - 明亮 / 黑暗 / 跟随系统，首帧无闪烁，持久化并响应系统变化
  - 三语界面，语言切换即时生效并持久化
  - 响应式布局（桌面、窄窗、平板、手机）
  - 消息密度图（Canvas，自适应粒度）、实时事件流、最活跃观众
  - 单场详情：统计、支持、时间线、存储信息、AI 占位
  - 观众详情：稳定 ID、昵称历史、累计支持、参与场次、重点关注

- **本地记录引擎**
  - SQLite（`node:sqlite`，WAL）与版本化迁移
  - 统一事件模型与单一写入管线
  - 重复事件去重（唯一键 + 指纹），金额与计数不会翻倍
  - 按币种 + 实际支付/展示价值分账
  - 稳定观众身份（`platform:uid`）与昵称历史
  - 模拟直播：聊天、免费/付费礼物、醒目留言、大航海、故意重复投递

- **AI 分析包导出（`livememory-analysis-v1`）**
  - 单文件 ZIP：manifest、场次上下文、messages.jsonl、观众上下文、三语提示词、结果 Schema
  - 内容文件 SHA-256 校验
  - 导出记录与分析状态

- **Windows EXE**
  - Node SEA + postject，可见控制台，内置运行时与 SQLite
  - 资源解压到数据目录（不可写时回退临时目录）

- **工程**
  - 零运行时依赖，无前端构建
  - 86 个自动化测试（单元 + 集成）
  - 完整文档体系与 ADR

### 尚未包含（按路线图）

- 真实 Bilibili / YouTube 接入（M3）
- AI 结果导入与 Schema 校验（M6）
- 长期 AI 观众画像（M7）
- 可移植备份与跨电脑恢复（M5）
- 自动清理原始弹幕（M4/M6）
- 韩语 / 西班牙语

### 已知问题

- 未在第二台干净 Windows 设备验收
- EXE 未签名
- 真实 Ctrl+C 未自动化验证
- 动态端口不回写设置
