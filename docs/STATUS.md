# 工程状态（STATUS）

最后更新：2026-11-13（v0.13.2：最终汇总截断修复、「继续最终汇总」恢复与统计口径；668 tests；schema 14；结果 Schema 1.3.0；提示词 v13.2）

> 本文件是唯一进度来源。只要代码与本文不一致，以代码与实测为准，并立即修正本文。

## 0.19 v0.13.2 最终汇总截断与「继续最终汇总」恢复（2026-11-13）

完整证据与根因：`log/2026-11-13-ai-aggregate-recovery.md`。**未修改生产数据库、未 Resume 生产任务、未调用真实付费 API、未干扰直播采集。** 只读检查了生产 `runtime/ai-v13.json`、日志与数据库副本。

### 0.19.1 真实故障结论（已确认）

- 任务 `ses_01M77TM1Q80HQ4XSZTMV` / `aij_01M79KZEFWBCCJP8G1JK`：dashscope `qwen3.7-flash`，18 批全部保存，final 缺失。
- 汇总请求：`maxTokens=8000`、`maxCompletionTokens=24000`、`estimatedInputTokens=34048`、耗时 199,729ms；Provider 返回成功但 `finish_reason=length` → `AUTO_OUTPUT_TRUNCATED`。
- 输入 34k 低于 48k 上限，**不是输入超限**；根因是汇总沿用了普通批次的 8k 输出预算，且汇总提示词/Schema 没有限制输出条数与长度。
- 20 次请求全部 HTTP 成功（18 批 + 1 次批次修复 + 1 次汇总）；失败发生在请求之后的完整性检查，所以旧统计显示 20/20 成功。
- `batchIndex:null` 被 `Number(null)===0` 持久化为 `batchIndex:0`；旧任务/旧库存在假的“批次 0”。
- 旧前端只有与暂停共用的泛化「继续」ghost 按钮；没有「最终汇总」专属恢复状态、准确操作名或“不会重做 18 批”的说明。用户报告看不到该按钮；本轮确认的产品缺口是缺少明确、可验证的汇总恢复入口（后端当时 `canResume=true`，未复现隐藏按钮的具体渲染路径）。

### 0.19.2 修复

- **独立汇总输出预算**：`resolveAggregateOutputTokens()` = `clamp(ceil(batchResultTokens*0.6)+3000, 12000, 16000)`，再按已知上下文收缩；DashScope 的 `max_completion_tokens` 为回答预算 + 16k。18 批上限 16k，不再固定 8k；有界 schema 的实际文本远低于 16k。
- **有界汇总契约**：汇总专用 schema（topics ≤24、sentiment ≤12、disputes ≤8、highlights ≤8、每条 message_refs ≤4，移除 viewer_profiles）；三语提示词明确合并优先、输出上限、覆盖全部批次；compact 第二遍只降低每批条数，不丢批次/证据。
- **恢复状态**：新增 `src/ai/tasks/recovery.mjs`，只依据数据库真实结果计算 `aggregate/session/memory/config`、`resume-aggregate` 等动作与 `canResume`。18/18 已保存且 final 缺失时只提供「继续最终汇总」；输入装不下时提供 `change-model` 且 `canResume=false`。
- **幂等恢复**：`resume()` 在 complete 时直接返回；重复点击不创建任务、不请求 Provider；继续只发缺失的 final，不重发 18 批。
- **batchIndex**：统一 1-based，0/负/null 归一为 null；`recordJobFailure`、状态读模型与失败批次列表都不再出现批次 0；旧数据读取时兼容。
- **UI**：AI 中心新增独立恢复面板（标题、已保存/未完成、原因、[继续最终汇总]、[查看技术详情]、不会重做已保存批次的说明）；按故障显示继续未完成分析 / 继续最终汇总 / 继续未完成画像 / 前往设置更换模型；页面刷新与服务重启后从 `/api/ai/analyze/status` 恢复。
- **统计**：`outputStats.responses/rejected/lastFinishReason`；界面区分「API 请求成功」与「输出未通过完整性/结构校验」「已保存分析结果」，并解释 API 成功 ≠ 分析完成。

### 0.19.3 测试（本轮实测）

- 全量：**668 passed / 0 failed**（2026-11-13，`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`，约 164 秒）。
- 新增：
  - `tests/integration/ai-aggregate-recovery.test.mjs`（2）：18 批 + 截断、重启后恢复只发汇总、18 条结果 checksum 不变、重复点击幂等、无效汇总统计口径。
  - `tests/unit/ai-aggregate-budget.test.mjs`（5）：预算上下限、上下文收缩、DashScope headroom、有界 schema、三语提示词覆盖全部批次、compact 保留证据。
  - `tests/unit/ai-recovery-state.test.mjs`（8）：aggregate/session/memory/config 恢复、完成/乱序/无任务、单批、pending viewer。
  - `tests/unit/ai-recovery-ui.test.mjs`（4）：独立恢复面板、真实 resume API、三语键与文案一致、无 innerHTML/alert。
- 未验证：真实付费 Provider 的 16k `max_tokens` 接受度与截断后 Continue；真实生产任务 Resume；真实浏览器点击/截图；正式 EXE 重建。

### 0.19.4 用户安全恢复步骤

1. 先完全退出 LiveMemory，备份整个数据目录（不要在运行时复制写入中的 SQLite）。
2. 替换为包含本轮修复的新构建，确认设置页「关于」的 buildId 与构建记录一致。
3. 打开 AI 分析中心，选择该场次；应看到「AI 分析未完成」、单场批次 18/18、最终汇总失败、原因与「继续最终汇总」。
4. 选择与失败任务相同的 Provider/区域/模型，点击「继续最终汇总」；不会重发已保存的 18 个批次。
5. 成功后 final 保存、任务变 complete、恢复面板消失；失败则查看技术详情，不要新建整场分析、不要清空数据。

## 0.18 v0.13.2 AI 分析多语言输出与报告翻译（2026-11-13）

完整变更与验证记录：`log/2026-11-13-ai-report-translation.md`。**未修改生产数据库、未干扰正在采集的直播、未调用真实付费 API；全部使用 `tests/.tmp` 隔离数据与 Mock Provider。**

### 0.18.1 审计结论

- **已经支持的部分**：AI 分析中心已有独立的「分析输出语言」选择（zh-CN / ja / en）；`POST /api/ai/analyze/run` 把 locale 写入会话/画像两个 `ai_jobs`，包内 `instructions.md`、Prompt 版本、Session 与 Memory 任务均使用同一 locale。`topic` 已作为稳定匹配键保留。切换界面语言不会修改已创建任务。
- **本轮补齐的缺口**：
  1. 分析语言容易与界面语言混淆；UI 文案改为「分析输出语言」，并明确它与界面、弹幕原文无关；Prompt 增加「任意/混合语言原文直接理解、不逐条预翻译」规则。
  2. 已保存报告没有阅读语言切换；长期画像只能按原语言阅读。
  3. 没有翻译缓存、按需翻译、分段落失败恢复、独立的翻译 usage/费用归属。
- **未重做**：没有新增第二套分析系统，没有改变结果 Schema 1.3.0、批次/Resume/Compact/观众级容错与事实操作语义。

### 0.18.2 功能 A：分析输出语言

- 三个概念明确分离：界面语言（UI locale）、分析输出语言（task locale）、原始内容语言（弹幕/聊天实际语言）。
- AI 中心默认使用当前界面语言，可手动选择；任务开始后 locale 写入 `ai_jobs.locale` 与运行时状态，界面语言切换、暂停/恢复不会改变已保存任务的语言。
- Session 与 Memory 使用**同一个任务 locale**：Session Prompt、Memory 运行时 instructions、长期画像 Compact 示例均为该语言。
- Prompt v13.2 新增：聊天/摘录可能是中文、日语、英语或混合语言，模型直接理解原意并用 locale 输出，不要求逐条翻译；技术字段、JSON 键名、枚举、稳定 ID、证据编号不变。

### 0.18.3 功能 B：已保存报告的语言切换

- 报告标题区新增「报告语言」选择器（简体中文 / 日本語 / English）与原文/翻译 chip；默认先显示报告原文，首次切换时才提示翻译，避免误产生费用。
- **切换语言不是重新分析**：翻译服务只读取已导入的 `ai_results`、`viewer_memories`、`memory_facts` 的展示文本，不读取整场弹幕、不创建 `ai_job`、不执行 Session/Memory 批次、不调用事实操作。
- 可翻译内容：单场摘要、话题标题/摘要/要点、情绪说明、争论标题/摘要/说明/观点、回看片段标题/原因/候选说明、本场观众画像摘要与兴趣说明、长期画像摘要与事实 `statement`。
- **绝不翻译**：`viewer_id`、`topic` 匹配键、事实 ID、状态、`stated/inferred/uncertain`、版本、证据引用、时间、金额、计数、置信度、枚举值、JSON 键名、原始聊天证据正文。
- 原始报告保持只读；翻译只写独立的展示缓存。选择原文语言时直接返回原始文本，不应用缓存。

### 0.18.4 缓存、按需翻译与费用

- 新增 schema **14**：`ai_translations`（段落级展示缓存）与 `ai_translation_runs`（独立翻译运行/usage/错误）。
- 缓存键：`target_kind + target_id（ai_results.id / viewer_memories.id / memory_facts.id） + item_path + target_locale + source_hash + translator_version`。原始结果版本更新（新 `ai_results.id`）或事实文本变化（新 hash）时旧缓存不会覆盖新内容。
- 首次切换语言：读取本地缓存；缺失时调用**用户已配置的 Provider/模型**，按段落分块翻译；每块成功即保存，单段失败只标记该段，已成功段落保留。再次选择同一语言只读缓存，不重复请求。
- 失败后「重试未完成段落」只请求缺失/失败项，不重复成功项；中断/失败不清除已保存翻译，也不影响原始报告。
- 翻译 usage/费用只写入 `ai_translation_runs`，不混入 `ai_jobs` 的 Session/Memory usage。价格未知时 `cost=null`，界面显示「费用未知」，不显示为零。
- 首次翻译前 UI 显示「会调用 AI 模型并可能产生费用」并要求勾选确认；服务端要求 `consent:true`；没有可用 Key 时只说明原因，原文继续可读。

### 0.18.5 API

```text
GET  /api/ai/sessions/:id/report?locale=zh-CN|ja|en   只读；应用缓存，绝不调用 Provider
GET  /api/ai/sessions/:id/translation?locale=...      只读状态/缓存计数/运行进度/可用配置
POST /api/ai/sessions/:id/translation                 按需翻译未完成段落（locale, configId, consent）
```

报告响应新增 `reportLocale`（原文语言）、`displayLocale`（当前展示语言）与 `translation`（status、total/translated/failed/missing、run usage/error、providers）。状态包括 `original / missing / partial / complete / running / failed / unavailable`。

### 0.18.6 数据生命周期

- `ai_translations` / `ai_translation_runs` 随场次级联删除；删除单场时显式删除并纳入 `assertNoResidue`。
- 删除观众长期记忆时，同时删除该记忆及事实的翻译缓存，保留记忆墓碑，旧包不能借翻译恢复已删除内容。
- 清空数据/恢复出厂包含两张翻译表；数据库迁移 v13→v14 只新增表与索引，不改写任何历史行。

### 0.18.7 测试（本轮实测）

- 全量：**649 passed / 0 failed**（2026-11-13，`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`，约 155 秒）。
- 新增：
  - `tests/unit/ai-translation.test.mjs`（6）：字段提取、结构不变、stale hash、状态、文本清洗、分批报告字段定位。
  - `tests/unit/ai-translation-ui.test.mjs`（2）：选择器/进度/失败重试/费用提示/三语键/无 innerHTML。
  - `tests/integration/ai-report-translation.test.mjs`（7）：日语→中文、缓存复用、双语切换、部分失败只重试失败段、新结果版本隔离、缺失 Provider/网络失败、证据清理、Schema 1.1.0 旧报告、Session/Memory 同 locale。
  - `tests/integration/ai-translation-migration.test.mjs`（2）：v13→v14、场次级联。
- 覆盖任务要求的 A–J；其中移动端/真实浏览器/正式 EXE/真实付费 Provider 未执行（见 §0.18.8）。

### 0.18.8 未验证 / 边界

- **真实付费 Provider 翻译未执行**：本机无 Key，全部为 Mock fetch；真实 Provider 的翻译质量、429/超时下的分段恢复、费用精度未验收。
- **真实浏览器 UI 未验收**：本机沙箱仍阻止浏览器命名管道；选择器/进度/窄屏由静态断言、i18n 与 HTTP 接口覆盖，不声称已截图。
- **正式 EXE 未重建**：本轮未构建 `dist/LiveMemory.exe`；发布 EXE 仍为上一构建（schema 13），需下次构建才能包含 schema 14 与翻译功能。
- **翻译质量不保证**：翻译是展示层派生文本，可能与原文有措辞差异；不做人工审校，不把翻译结果写回事实或报告。
- **旧历史英文事实**：不会自动批量翻译；切换到其他语言时按需生成展示版本，原始事实保持不变。
- **混合语言/原文语言识别**：`reportLocale` 取自主结果或任务 locale，不自动检测每条弹幕语言；翻译 Prompt 明确接受任意/混合语言。


## 0.16 v0.13.2 AI 分析可靠性与长期画像语言修复（2026-11-13）

完整的只读审计报告在上一轮交付中提供，**本轮不重复审计，只按实际代码修复并验证**。生产数据、正在采集的直播、正式 `LiveMemory.exe` 与真实付费 API 均未触碰；所有测试使用 `tests/.tmp` 隔离目录与 Mock Provider。

### 0.16.1 已修复问题

| # | 问题 | 根因 | 修复 | 验证 |
| --- | --- | --- | --- | --- |
| 1 | Compact ref 覆盖完整时绕过完整校验 | `generateMemoryAnswer()` 在 `assembleMemoryCompact().ok` 后立即返回，从未调用 `validateAnalysisImport()` | 统一为「组装 → 完整校验 → 最多一次修复 → 再校验 → 导入」；ref 覆盖不再等于合法 | A/B/C/D；`ai-memory-reliability` |
| 2 | 模型可覆盖本地稳定 `viewer_id` | `assembleMemoryCompact()` 先写 `viewer_id` 再展开模型 `memory` 字段 | `memory` 四字段白名单；`viewer_id` 永远最后注入；身份/未知字段丢弃并记录字段名（不记录值） | E + `ai-compact-memory` 单元测试 |
| 3 | `AI_IMPORT_INVALID` 诊断丢失 | Runner `fail()` 只读取 `error.detail`，未读取 `AppError.details.errors` | `fail()` 提取字段级错误、阶段、Job/Batch、可恢复性与建议；随状态与 `/api/ai/analyze/status` 返回 | B/G + HTTP 状态断言 |
| 4 | 成功批次清除其他批次失败 | 导入成功调用无参 `clearJobFailure()`，清空整个 Job | `last_error_json.batches[]` 按批次保存；成功只清同批次；旧扁平失败仍兼容 | G/I + 并发/重启测试 |
| 5 | 日语长期画像输出英文事实 | `memoryShape()` 固定英文示例与 `"locale": "en"`；memory 任务缺语言要求 | 三语本地化 Compact 示例；明确自然语言字段使用 locale；`topic` 保留稳定匹配键；Provider 请求由当前运行时 instructions 生成 | J + `ai-compact-memory` |
| 6 | 旧 instructions 与 Compact 契约冲突 | 包内 `instructions.md` 同时含完整 Result 示例与 Compact 契约；Resume 继续发送旧文件 | Memory Provider 提示词改用当前 `buildMemoryInstructions()`，旧包只提供数据文件；单一 Compact 契约 | J + 单元测试传入旧 instructions 验证被忽略 |
| 7 | 事实准确性规则不足 | 未明确区分 stated/inferred/uncertain、玩笑/引用/建议 | 三语 rules 明确：本人证据、推断不可写成事实、不得编造、不得为填满而造事实、no_semantics 合法 | J + 提示词单元测试 |
| 8 | 统计口径误导 | 报告只显示 `longTermProfiles.count`（有记忆头的观众数） | 新增 `stats`：应处理/已处理/有语义/仅客观/未完成/失败批次涉及；AI 中心与报告显示分别统计 | G/K + 报告接口断言 |
| 9 | 单场成功 + 画像失败显示笼统 | 已会标 `partial`，但缺少精确的长期画像进度与批次原因 | 状态 `partial` 保留；UI 显示「单场报告已完成，长期画像未完成」+ 已处理/未完成；错误显示真实原因与技术详情 | K |
| 10 | usage 跨 Job 重复统计 | `requestOnce` 把任务累计 usage 写入 memory job（包含 session 部分） | 按请求 kind 归属子 Job；任务总计由子 Job 相加；修复/重试计入真实请求；任一子 Job 费用未知则总费用未知 | L |
| 11 | 断点恢复可能重复付费 | 需验证完成批次、语义事实与客观记录不重复 | 现有 pending 过滤 + 幂等导入；新增重启 Resume 只补失败批次、重复提交不重复写事实的测试 | G/H/I |

### 0.16.2 明确未做 / 边界

- **不自动恢复生产任务**：`ses_01M77TJXG9VP4VAGNSXY` 未执行 Resume、未调用真实 API；步骤见 HANDOFF。
- **未批量翻译历史英文事实**：已有英文 `memory_facts` 保留；未来生成使用当前 locale。处理建议见 HANDOFF。
- **未保存失败模型原始回答**：该增强涉及加密、生命周期、大小上限与隐私影响，本轮只给出方案（HANDOFF §4），不持久化任何模型正文。
- **历史重复 usage 未猜测修正**：旧版本已写入的 `usage_json` 保持原样；新任务按子 Job 归属。旧任务的展示可能仍包含历史重复值，字段中有说明。
- **真实付费 API 未验证**：本机无 Key；本轮全部是 Mock Provider 的确定性验证，不是真实 Provider 验收。
- **浏览器 UI 截图未完成**：本机 DSH 沙箱禁止浏览器命名管道/Mojo（`OpenProcess`/`platform_channel` 0x5），headless Edge 无法启动；UI 由静态断言、i18n 与 HTTP 状态/报告接口覆盖，不声称已做真实浏览器验收。
- **生产数据库未修改**：没有迁移、没有读写 `%LOCALAPPDATA%\LiveMemory`。

### 0.16.3 测试（本轮实测）

- 全量：**628 passed / 0 failed**（2026-11-13，`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`，约 120 秒）。
- 新增：
  - `tests/unit/ai-compact-memory.test.mjs`（7）：白名单/身份覆盖/非法操作保留给 Schema/旧 instructions 被忽略/三语示例与语言规则/Schema 无 viewer_id。
  - `tests/integration/ai-memory-reliability.test.mjs`（10）：A 正常导入、B 完整 ref 但证据缺失、C 一次修复成功、D 修复仍失败可恢复、E 伪造 viewer_id、F 跨观众证据、G 四批并发仅第 2 批失败且错误不被清除、H 重启只补 b02、I 重复提交幂等、J 日语事实、K combined partial、L usage 归属、M 礼物-only 客观处理。
  - `tests/unit/ai-ui.test.mjs` 新增：诊断/统计三语键、技术详情只渲染本地字段、无 HTML 注入。
- 关键命令与结果见 HANDOFF §5。
- 隔离启动冒烟：`node src/launcher/launcher.mjs --no-open --port 48300 --data-dir D:\LiveMemory\tests\.tmp\smoke2` → `/api/health` 返回 `buildId=dev-e67677a`、`commit=e67677a`；`/api/bootstrap` 返回 schema 13 与临时数据目录。结束后删除临时目录。端口 49666 在本机被系统/沙箱拒绝（EACCES），换 48300 成功，不是应用代码错误。

### 0.16.4 `AI_IMPORT_INVALID` 专项端到端验收（2026-11-13）

完整证据：`log/2026-11-13-ai-import-invalid-acceptance.md`。

- **旧代码 3fccba1**：392 条合成消息 / 37 观众 / 4 批（10/10/10/7），3 个变体（伪造 `viewer_id`、stated 缺证据、跨观众证据）全部复现 `AI_IMPORT_INVALID`；错误只有裸代码、无 stage/字段错误、无 repair；b02 仅 1 次请求；覆盖 27/37；后续成功批次清空 `last_error_*`。
- **新代码 e67677a**：同数据同变体全部 `complete` 37/37。伪造身份变体无需 repair（本地 ID 不被覆盖）；缺证据/跨观众证据变体 b02 发起一次 repair 后成功。
- **修复仍失败**：新代码显示 `AI_IMPORT_INVALID` + `MEMORY_EVIDENCE_REQUIRED` + stage=validation + batchIndex=2 + `batchErrors=[2]`；27/37 保留，facts 3。重启后 Resume 只发 1 次 b02，完成 37/37，facts 4。
- **隔离 EXE**：先用独立构建（buildId `c51819b2f3f3`）通过本地 Mock Provider 实测：repair 场景 complete 37/37；always-invalid 场景显示精确错误、27/37；EXE 内 Resume 只发 b02 一次并完成 37/37。随后按用户明确授权把正式 `dist/LiveMemory.exe` 重建为 buildId `caece0818f11`（`c827a609…`，commit `2b0ade6`，requireAdministrator），并用 asInvoker 测试副本实际启动验证 buildId/commit；正式 EXE 已替换，旧 EXE 备份在 `tests/.tmp`。
- 未验证：真实付费 API、原始 392 条聊天内容、真实生产任务 Resume、UAC 双击。


## 0.17 v0.13.2 真实 AI_IMPORT_INVALID 与观众级容错（2026-11-13）

完整调查与真实数据证据：`log/2026-11-13-real-ai-import-invalid-investigation.md`。

### 0.17.1 真实根因（已验证）

- 任务 `aij_01M7963928KHJGNJTD64`（memory-only，47 观众/5 批，locale zh-CN，qwen3.7-flash）：
  - 批次 1–4 已导入 40 名 semantic；批次 5 的 7 名全部 pending。
  - 失败批次 5 每名观众 1 条消息；`seq 3` 属于错误观众 `bilibili:1765635337`（ref 5），`seq 5` 属于另一观众 `bilibili:5240206`（ref 3）。
  - 模型在 `viewer_memory_updates[4]` 中为 ref 5 引用了 `seq 5` → `MEMORY_EVIDENCE_OTHER_VIEWER`。
  - 映射本身正确（包、`ai_job_memory_messages`、`memory_context.evidence_seqs` 一致）；根因是 **ref 与 seq 两套小整数编号混淆**：ref 5 的合法证据是 seq 3，而 seq 5 属于 ref 3。
  - 旧 Prompt 的 excerpt 行没有 `ref`，`memory_context` 使用 ref 但没有 viewer_id，模型必须自行按昵称/数字对照；这是可复现的设计缺陷，不是单纯幻觉。
- 自动修复确实发送过：批次 5 共 2 次请求（初始 + `memory-repair`）；初始错误为 `SCHEMA_TYPE`/`SCHEMA_ENUM`，修复后改为跨观众证据。旧代码只允许一次修复，修复后仍失败就拒绝整批。
- 任务总 usage：8 次请求、77,204 input / 37,327 output；`pricing_status=unknown`、`cost=null`。单请求 token 未持久化。

### 0.17.2 原有隔离能力（调查结论）

- 单场报告：独立任务，已保留；画像失败没有删除报告。
- 批次：已成功批次保留；旧 `runPool` 在首个错误后停止**尚未开始**的后续批次，已启动批次继续。真实任务 5 批均已启动，因此没有观察到后续阻断；concurrency=1 时旧逻辑会停。
- 观众：**没有观众级隔离**；批次 5 的 1 人错误导致 7 人全部不导入，旧版无法只恢复失败观众。
- 操作：同一观众的多条操作保持原子，不做单条操作拆分。

### 0.17.3 修复

- **Prompt**：Provider 的 `viewer_excerpts.jsonl` 每行增加本地生成的 `ref`；契约明确 ref/seq 不同命名空间、ref 5 可有 seq 3、只能使用同 ref 的 evidence_seqs；repair 增加 `MEMORY EVIDENCE GUARD`；错误参数携带 `allowedSeqs`。
- **观众级容错**：whole-batch repair 后仍有观众级错误时，按 `viewer_memory_updates[i]` 拆分；合法观众用 `viewerIds` 作用域重新完整校验并导入；非法观众状态 `failed`，不写任何事实；再发一次有界 viewer-scoped repair（只含失败观众/证据），成功则合并回整批，失败则保留合法观众并标记 failed。
- **事务/幂等**：合法事实、证据、覆盖状态与 failed 状态在同一 SQLite 事务；恢复导入生成新的 `ai_results` 版本（只含恢复观众），事实去重/版本机制不变。
- **调度**：`runPool` 对批次级校验错误不再停止后续批次（concurrency=1/4 均验证）；Provider/取消/数据库错误仍停止新调度。
- **Resume**：按 `ai_job_memory_viewers` 的 `pending/failed` 观众构造子集 Prompt；只请求未完成观众；旧任务失败批次 7 名仍全部 pending，因此旧任务 Resume 会处理这 7 人，不能只挑 1 人（旧响应未保存合法 6 人）。
- **UI/统计**：覆盖新增 `failed`；partial 文案显示 `{processed}/{total}`、未完成、校验失败等待恢复；报告 stats 使用覆盖 `failed`。

### 0.17.4 验证

- 全量：**632 passed / 0 failed**（2026-11-13，约 112 秒，`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`）。
- 新增/更新 `ai-memory-reliability`：ref/seq 冲突（真实生产形状，ref5↔seq3、ref3↔seq5）、concurrency=1 后续批次继续、viewer-scoped repair 自动成功、观众级 9/1 隔离、Resume 只发失败观众。
- 真实任务副本回放（只读复制生产库+包，Mock Provider）：
  - 普通 Resume：1 次请求，仅批次 5 的 7 名 pending；complete 47/47。
  - 模拟真实 ref/seq 错误：initial + whole repair + viewer repair 共 3 次请求；complete 47/47，41 semantic/6 no_semantics/0 failed，未跨观众写入。
- **正式 EXE**：`dist/LiveMemory.exe` 重建为 buildId `9b8daa7b2d1d` / commit `2df6052` / SHA-256 `9b3eea3e…`；asInvoker 测试副本 + 生产库/包只读副本 + Mock 实测 resume `aij_01M7963928KHJGNJTD64`：3 次请求后 complete 47/47、41 semantic、0 failed，批次 1–4 未重发。
- 未验证：真实付费 API、真实生产任务 Resume、真实浏览器 UI（沙箱仍阻止浏览器命名管道）、UAC 双击。

## 0.15 v0.13.2 观众身份专项审计（2026-11-12）

完整报告：`docs/AUDIT_VIEWER_IDENTITY_2026-11-12.md`。**只读审计用户数据库，未修改任何历史事件。**

### 0.15.1 结论

- 场次 `ses_01M75S69P4H0NSX87PD4`（Bilibili，727 条消息）只有 **2 个有效 UID**：1 条 Super Chat + 2 条大航海；**726/726 条弹幕 `viewer_uid` 为 NULL**，71 个昵称全部打码。
- 因此历史页与 AI 中心都显示 2 名「可识别观众」，数字一致且数据库没有 JOIN/迁移/缓存丢人。
- 根因：**Bilibili 未登录弹幕风控**（昵称打码、uid=0）＋ **UI 把「可识别观众」写成「独立观众/本场参与人数」且不显示 726 条未识别消息**。
- 跨场次：另一场 Bilibili 也是 0 个可识别观众 / 206 条未识别；四场 YouTube 的未识别消息为 0。判定 **B + D**，不是单场、不是所有平台、不是纯 UI。
- 历史消息数与时间线可重算；726 条弹幕的真实身份**不可恢复**（平台从未提供 UID；打码昵称不能用于合并）。实际观看人数未知，历史未保存平台 online。

### 0.15.2 修复

- canonical 层把 `uid=0` / `"0"` 视为缺失，禁止 `platform:0` 共享档案。
- 新增只读派生指标 `unidentified_message_count`：从 `events` 实时计算，历史自动重算，无迁移。
- 直播页 / 历史列表 / 历史详情 / AI 中心统一显示「可识别观众」+「N 条未识别」警告，并修正「登录不会改变身份字段」的错误文案。
- 登录由「可选」改为「建议」；不回填、不猜测、不删除历史身份。

### 0.15.3 测试与限制

- 全量：**610 passed / 0 failed**（2026-11-12，`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`，约 119 秒）。
- 新增：`tests/integration/identity-stats.test.mjs`、`tests/unit/identity-labels.test.mjs`；`events.test.mjs` 增加 UID=0。
- 数据库副本启动实测：`/api/sessions`、`/api/history/search`、场次详情均返回 `727 / 2 / 726`，重启不变。
- **未验证**：登录后能否 100% 解除 Bilibili 打码（本机无账号 Cookie）；原始 WebSocket 帧未保存，无法回读当时 `info[2][0]`；未做真实浏览器截图验收。

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
| SHA-256 | `aa3d41105af90eeed8608bb49caf018f17b5f0dbaa1aef0c9b297a3b870ba61d` |
| commit | `b101bd01bc227fd85abaa862873eb0ce61e792cd` |
| buildId | `89bf47ac620e` |
| asset hash | `89bf47ac620eed9ed26c` |
| builtAt | 2026-11-12T10:47:20.675Z（18:47:20 +08） |
| 资源 | 169 files；7 个必需模块；RT_MANIFEST requireAdministrator |

本机非提升会话用同一二进制的 asInvoker 副本实际启动：`/api/health` 与 `/api/bootstrap` 返回 `buildId=89bf47ac620e`、`mode=packaged`、`verified=true`；启动日志 `startup.begin` 含同一 build；第二次启动复用缓存并 `filesVerified=169`。**不是只看版本号。**

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
- 修复：DashScope 请求在 `max_tokens` 之外发送 `max_completion_tokens = 回答预算 + 16,000`（session 24k、memory 22k），有界但**不关闭思考**；其他 Provider 不发送该参数。
- 观测：attempt 日志新增 `model`、`maxTokens`、`maxCompletionTokens`、`estimatedInputTokens`、`requestBytes`、`reasoningChars`、`reasoningTokens`；流式只统计 `reasoning_content` 长度，不保存内容。
- 124 位观众：长期画像由 memory 批次保证每位恰好一条；测试覆盖 124/124。session 的 `viewer_profiles` 明确为可选、按批高亮，不再暗示完整覆盖。

### 0.14.4 测试（本轮实测）

- 全量：**597 passed / 0 failed**（2026-11-12，`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`，约 93 秒）。
- 新增：`tests/unit/build-info.test.mjs`、`ai-adapter-output.test.mjs`、`ai-repair-guard.test.mjs`；`ai-token-batching.test.mjs` 增加 889 消息 / 124 观众 / 硬上限；`bootstrap.test.mjs` 增加缓存篡改重解压。
- 未做：真实付费 API（含 `max_completion_tokens` 与思考模式行为）、真实 UAC 双击、真实 889 消息付费回放。

### 0.14.5 任务完成优先（2026-11-12 最终修订）

**真实触发路径（已确认）**：

- 15:35:58 启动，`batchTotal=7`；15:48:40 第 7 批完成并**立即发出** final aggregate 请求；15:55:58 aggregate 在 `elapsedMs=435,770` 时以 `PROVIDER_TIMEOUT` 结束，任务于 20:00 标记 `ANALYSIS_TASK_TIMEOUT`。
- 不是“阻止启动汇总”：汇总已经启动；是 `requestOnce` 把 `maxTotalMs` 设为剩余任务预算（当时约 438 秒），在途流式请求被任务预算中止。
- 7/7 批次全部保存；只有 final aggregate 丢失。

**最终语义（取代 r2 的 60/45 分钟）**：

- **删除任务级时间上限**：不再有 `createTaskBudget`、`taskTimeoutMs`、soft/hard deadline、`maxTotalMs`、按剩余时间缩短请求；任务可运行任意久。
- **删除费用预算**：删除预算输入、预算校验、预算确认、按累计费用停止、价格未知阻止分析、免费/付费模型分类。
- **只保留单请求技术超时**：首响应 `timeoutMs`（默认 180 秒）与流式 60 秒空闲；单请求超时不再让整个任务不可恢复，而是进入 `needs_action`，已完成批次保留，可继续重试未完成批次。
- **错误分类**：401/403/402/404/429/5xx/超时/网络 → `needs_action`（保留进度、可继续）；用户取消 → `canceled`（立即 abort）；Schema/导入错误 → `failed`（已完成批次仍保留）。
- **规模**：删除 `MAX_MEMORY_BATCHES`、`ANALYSIS_TOO_MANY_VIEWERS`、`ANALYSIS_TOO_LARGE` 等产品总量拒绝；消息/观众/批次按单请求 Token 预算自动拆分。仅保留 1,000,000 消息 / 200,000 观众的极端内存保护，以及单批 32k 输入、单观众 48k 硬上限等技术限制。
- **价格可选**：`pricing` 为空或只填一项 → 正常分析、只统计 Token、不计算总费用；完整填写 → 按实际 usage 计算并展示。价格不参与任何 gate。
- **状态/UI**：`needs_action`、`canResume`、`taskElapsedMs`、`waitingAggregate`、`pending*Batches`；UI 移除预算/费用确认/免费付费提示，显示已运行时间、阶段、批次、等待汇总、需要处理与继续。

**测试**：603 passed / 0 failed；新增 `v14-pricing-optional`（空/完整/部分价格）、`v14-task-budget` 改为“无时间上限 + timeout needs_action + 汇总-only 恢复”、2500 观众无总批次上限。

## 0.13 v0.13.1 可靠性专项（2026-11-12）

完整设计、边界与测试清单：`docs/AI_RELIABILITY.md`。
前序根因调查：`docs/AI_TIMEOUT_INVESTIGATION.md`。**本轮已改代码并完成本地确定性验证，但未发起真实付费 API 请求。**

### 0.13.1 超时与重试

| 问题（调查编号） | 修复 |
| --- | --- |
| B1 超时被当成可重试，自动重发 2 次 | `timeout` 明确 `retryable:false`；已发出的长请求超时后默认**不自动重试** |
| B2 `AbortError`/`TimeoutError` 合并 | adapter 区分 `canceled` / `timeout` / `network` / `rate_limit` / `server` / `client` / `invalid_response` / `stream_interrupted`；取消绝不重试 |
| B3 超时不降速 | 超时不再触发同批重发脉冲；429/5xx 仍按各自的退避与 `Retry-After` |
| B4 无任务级总时限 | 历史 20 分钟预算已在最终修订中**彻底删除**；任务只受单请求首响应/空闲超时约束 |
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

- 里程碑：**M0 / M1 / M2 核心 / P0–P9 / M6 / M7 / v0.13 AI 架构重构完成**；v0.13.1 完成 AI 入口与调度收敛；v0.13.2 完成 P13–P16（画像校验、多语言、观众级容错、最终汇总恢复）；M3 真实接入继续验证；M4 部分完成；M5 未完成
- 版本：`0.13.2`（`package.json` 与 `src/shared/app-info.mjs` 一致；构建标识见 §5）
- 数据库 schema：**14**（v13→v14 只新增 `ai_translations` / `ai_translation_runs` 与索引）
- 分析结果 Schema：**1.3.0**；旧 1.0.0–1.2.0 仍可读取；提示词版本 **v13.2**（旧任务保留原版本号）
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
| 任意已配置模型 | 已配置且通过能力验证 | 单场 + 长期画像（若 memory 能力通过） | 最终修订：价格、免费/付费分类、预算均不参与；只要求技术能力 |

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
- 价格完全可选；费用未知、部分价格、免费/付费分类、预算、`confirmBilling`、`optInMemory` 均不再阻止请求或长期画像。
- 长期画像只要求 `capabilities.memory=true`（以及 session 能力）。
- 没有任务时间/费用/总批次上限；只有单请求超时与单批 Token 技术限制（最终修订）。
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

- **2026-11-13 正式 EXE 已按用户授权重建并覆盖 `dist/LiveMemory.exe`**（观众级容错版本）：`node scripts/build-windows.mjs`。
  - 大小 **91.7 MB**
  - SHA-256 `9b3eea3eed365731a7d6f15b4ed0134cb66686e075c8b95910543b13a6f0f1b1`
  - commit `2df60527bb608e0150e05b029ae41fb50a6f8c85`（短 `2df6052`）
  - buildId `9b8daa7b2d1d`，资源哈希 `9b8daa7b2d1d5430b0d3`
  - builtAt 2026-11-13T02:55:29.142Z（10:55:29 +08）
  - 资源 **169 个**；7 个必需可靠性模块已断言存在；EXE 内 buildId 标记已验证
  - PE Manifest **requireAdministrator**（脚本断言通过；`readManifest` 复核）
- **实际启动验证**：本会话非提升，复制同一二进制并把 manifest 临时改为 asInvoker 后启动；`/api/health` 返回 `buildId=9b8daa7b2d1d`、`commit=2df6052`；`/api/bootstrap` 返回 `mode=packaged`、`verified=true`、schema 13、隔离数据目录。
- **真实任务副本 EXE 验证**：用生产库/包只读副本 + 本地 Mock Provider，在 asInvoker 测试副本中 resume `aij_01M7963928KHJGNJTD64`：模拟真实 ref/seq 错误，EXE 发出 3 次请求（initial + whole repair + viewer repair），最终 `complete` 47/47、41 semantic、0 failed；批次 1–4 未重发。测试副本与生产数据副本已删除；正式 EXE 保留。
- 旧正式 EXE 已备份到 `tests/.tmp/LiveMemory-pre-r6-backup.exe`（SHA-256 `c827a609…`，buildId `caece0818f11`），仅用于回滚，不提交。
- **仍不能声称**：真实 UAC 双击、提升后的出站请求、真实付费 Provider、生产任务 Resume 已完成验收。
- 历史：v0.13.1（`ba917c52…`）、`89bf47ac620e`、`caece0818f11` 已被本次构建取代；旧 EXE 仍可能存在于用户磁盘，必须用 buildId 判断。

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
23. **任务完成优先**：没有任务时间/费用/批次总量上限；只有单请求首响应/空闲超时、单批 Token 上限与极端内存保护。错误进入 `needs_action`，保留已完成批次并可继续；用户取消立即生效。
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
