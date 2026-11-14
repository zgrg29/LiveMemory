# 开发日志 · 2026-11-14 · RC0 P0-1：AI 定向补答回归修复

## 1. 本轮范围与边界

- 只处理上一轮 RC0 审计中的 **P0-1：AI 定向补答回归**。
- 未修改其他 P0、未重构 AI 架构、未新增用户配置、未引入云端服务、未改动身份/金额/去重规则。
- **未修改生产数据库、未 Resume 真实生产任务、未调用真实付费 API、未停止或干扰直播采集。**
- 自动化测试全部使用 `tests/.tmp` 隔离数据目录与 Mock Provider。

## 2. 原始审计证据（不是凭问题名猜测）

上一轮审计报告保存在上一轮 DSH 会话 `session-8bf219c7-0825-40a6-b427-8783dd226eda` 中。P0-1 原始结论：

- `src/ai/api/runner.mjs:3376-3386`：首答缺 ref 时构造 `buildTargetedMemoryPrompt`，Schema 只允许缺失 ref。
- `src/ai/api/runner.mjs:3442`：补答回来后调用 `evaluate(repaired.content)`，**没有传 `repairPrompt`**，于是按全量 refs 组装。
- `src/ai/api/compact.mjs:417-427`：`assembleMemoryCompact` 只有在 `missing.length === 0` 时才 `ok:true`；补答只含缺失观众，必然被判“其余观众缺失”。
- `mergeMemorySupplement()` 已存在但全仓库无调用者。
- 补答 `assembled.ok === false` 时直接抛 `AI_IMPORT_INVALID`，首答中已合法的观众被整批丢弃，也不走 salvage。
- 审计复现结果：
  ```text
  first with full refs:       {"ok":false,"missing":[2]}
  supplement with full refs:  {"ok":false,"missing":[1]}
  supplement with onlyRefs:   {"ok":true,"missing":[]}
  merge helper:               {"ok":true,"refs":[1,2]}
  ```

## 3. 本轮复现

新增 `tests/integration/ai-memory-supplement-regression.test.mjs`，先写失败用例再改代码。修复前首用例实际输出（节选）：

```text
status=failed
canResume=true
memoryCoverage={total:2, pending:2, covered:0, failed:0}
last_error=AI_IMPORT_INVALID
errors=[{path:"viewers", code:"MEMORY_VIEWER_UPDATE_MISSING", params:{ref:1}}]
usage.requests=2
savedResults=0
```

复现路径与真实模型行为一致：首次回答只返回观众 1，观众 2 缺失；定向补答只返回观众 2；旧代码按全量 refs 评估补答，报观众 1 缺失，整批失败。首答中合法的观众 1 也没有落库，Continue 会再次发送两个付费请求且不收敛。

## 4. 根因（已确认）

1. **补答校验作用域错误**：补答只覆盖缺失 refs，却用全量 refs 的 assemble/validate；`mergeMemorySupplement()` 存在但从未被调用。
2. **首答合法结果没有兜底**：补答失败/仍缺失时直接抛错，首答已付费且合法的观众没有被保存。
3. **补答提示词缺少证据正文**（同路径的独立缺陷）：`buildTargetedMemoryPrompt()` 只发送缺失观众的 `evidence_seqs`，没有发送 `viewer_excerpts.jsonl`；模型无法根据真实聊天文本回答，只能猜或无信息。
4. **补答失败没有标记具体观众**：没有把“仍缺失的观众”写入 `viewerFailures`，恢复只能按整个批次重发，扩大重复付费。

## 5. 修复

| 文件 | 修改 |
| --- | --- |
| `src/ai/api/runner.mjs` | 新增 subset evaluate：补答按缺失 refs 组装/校验；用 `mergeMemorySupplement()` 合并首答与补答后做一次全量校验；补答无效/缺失/截断/空响应/Provider 错误时，保留首答中每个单独合法的观众，并把仍缺失的观众写成 `viewerFailures`，只让这些观众失败并可恢复；补答提示词超过同一输入上限时不发送并走同样兜底；补答空/截断计入 `outputStats`。 |
| `src/ai/api/prompts.mjs` | 定向补答只附带缺失观众的 `viewer_excerpts.jsonl`（按 stable viewer_id 过滤，并注解 ref），不再只给 evidence_seq。 |
| `tests/integration/ai-memory-supplement-regression.test.mjs` | 新增 10 个回归用例。 |

关键不变量：

- 补答请求**只包含缺失观众**的上下文、摘录、契约与 Schema。
- 合并后仍走 `validateAnalysisImport()` 的完整 Schema/身份/证据/覆盖/枚举校验；不因“ref 齐了”跳过校验。
- 观众身份始终由本地 `ref → viewer_id` 映射注入；补答中的跨观众证据会被拒绝。
- 首答合法观众只导入一次；重复 Continue、重启 Resume 都不重复写事实。
- 仍缺失的观众状态为 `failed`，Resume 只请求这些观众；不会重发已保存观众。

## 6. 新增回归测试（10 项）

`tests/integration/ai-memory-supplement-regression.test.mjs`：

1. 首答漏 1 位观众 + 补答完整 → 合并后 2/2、事实正确、只发 2 次请求；完成后重复 Continue 0 请求。
2. 补答仍缺（返回错误观众）→ 首答合法观众保存，只有缺失观众 `failed`；Resume 只请求该观众并完成，事实不重复。
3. 首答完整 → 不触发补答，只 1 次请求。
4. 补答只返回部分缺失观众 → 首答与补答中所有合法观众都保存，只把仍缺失者标失败。
5. 补答包含跨观众证据 → 拒绝该观众，首答保留，重试后完成。
6. 补答返回重复事实 → 记忆引擎去重，只写 1 条事实，不重复导入。
7. 补答返回非法 JSON → 首答保留，缺失观众可恢复。
8. 补答空响应 + `finish_reason=length` → 首答保留，不重发首答，缺失观众可恢复。
9. 关闭/重启后 Resume → 只请求失败观众；旧 `ai_results` 行与 `result_json` 不变，旧事实不变，新观众追加为新版本。
10. 3 批并发、其中 1 批首答漏 1 人且补答非法 → 其他批次照常完成；Resume 只请求该观众，30/30，兄弟批次事实不重复。

## 7. 全量测试

```text
node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"
708 passed / 0 failed / 0 skipped
186,397 ms
2026-11-14
```

基线为 698；本轮新增 10 个用例，全部通过。

## 8. EXE 与真实数据只读副本

- 正式构建：`dist/LiveMemory.exe`，buildId `e441070b57b5`，commit `81be9cdc38dbd5679f936687c368f77ba5596b9b`，SHA-256 `27c0bfbe9227ed15693370c999df0fda7d3d39ffafbffc0b7b9c2ab2a9eb6e58`，96,401,408 bytes（91.9 MB），176 assets，`requireAdministrator`，builtAt `2026-11-14T02:54:03.831Z`。
- 回放使用：asInvoker 测试副本（仅 `LIVE_MEMORY_SKIP_ADMIN_CHECK=1`）+ 生产数据只读副本 `tests/.tmp/rc0-exe-data` + 本地 OpenAI-compatible Mock Provider（127.0.0.1:48991）。生产数据未被修改。
- 会话 `ses_01M7ACPCM8YB56VCV82S`，新建 memory job `aij_01M7BZPKAJ8WMYGZA8BS`，89 人 / 9 批。
- 首轮：批次 2 首答故意漏 1 人（missing ref 10），补答返回非法 JSON；结果 `partial`、88/89、8/9 批、10 请求、1 failed（`bilibili:335118245`）；首答其余 9 人已保存；错误记录 `MEMORY_VIEWER_UPDATE_MISSING` + `AUTO_INVALID_JSON`。
- 关闭 EXE 后重启同一数据目录：`/api/health` 同 buildId/commit；状态仍 `partial`、`canResume=true`、88/89。
- `POST /api/ai/analyze/resume`：只发 1 次请求，仅 1 位失败观众；`complete`、89/89、9/9、requests 10→11；批次 1/3–9 未重发。
- 数据：回放前 503 条 `ai_results` 全部保留；事实 1,007→1,095→1,096；新 job 10 条结果（9 v1 + b2 v2）；89 条新事实；`(viewer_id, dedupe_key)` 无重复；再次 Resume 0 请求。
- 性质：正式 EXE + 真实数据只读副本 + Mock Provider 的确定性回放；不是真实付费 Provider 验收，也不是生产任务 Resume。

## 9. 对现有数据与其他 AI 流程的影响

- **无 schema 迁移**：数据库仍为 schema 16，结果 Schema 1.3.0，提示词版本 v13.2 不变。
- 不改 Session 分析、分层汇总、翻译、Provider、调度/重试、金额/身份/去重。
- 不改已保存 `ai_results` / `memory_facts` / `viewer_memories`；没有清空或回填。
- 影响仅限：下次 Resume/新 memory 批次遇到“首答漏观众”时不再整批失败；补答会带缺失观众摘录；补答失败时保存首答合法观众并把剩余观众标 `failed`。
- 已完成的 memory job 不重新请求任何观众（`resume` 在 complete 时直接返回）。

## 10. P0-1 结论

- **代码缺陷已确认、已修复、有可复现失败→修复后通过的证据。**
- 自动化回归 10/10，全量 708/708。
- **待验收**：真实付费 Provider 下的补答质量、真实生产任务 Resume、真实 UAC 双击、真实浏览器点击。没有真实 Key/授权，不能声称真实验收完成。
- 因此 P0-1 可作为**代码级发布阻断关闭**；真实验收部分标记为“待用户验收”，不冒充已完成。

## 11. 下一轮 P0-4 交接（YouTube 误判结束）

上一轮审计的 P0-4 原始证据：

- `src/platforms/youtube/anonymous/adapter.mjs:324-333`：连续失败达到 `maxConsecutiveFailures = 8` 就 `#finish('connection_failed')`；**429/网络错误也累计**。
- `src/platforms/youtube/anonymous/adapter.mjs:284-288`：`page.ended` 立即 `#finish('chat_ended')`。
- `src/platforms/youtube/anonymous/parser.mjs:249-258`：HTTP 200 但缺少 `continuationContents` 时返回 `{ended:true, invalid:true}`；adapter 没有使用 `invalid`，直接结束。
- `docs/PLATFORM_INTEGRATIONS.md:267` 写“网络/5xx 退避且不结束场次”，与代码相反。

建议下一轮顺序：

1. 先复现：Mock 429/网络错误/200 非 continuation；断言当前会结束场次。
2. `invalid:true` 按 transient 处理，不结束；只有明确 `chat_ended`/`chat_disabled`/平台确认下播才结束。
3. 429/网络/5xx 达到阈值后进入 `FAILED/RECONNECTING` 并保留 session，不调用 `onEnd`；由用户/监听器决定是否结束。
4. 增加二次确认（chat 页 + watch 页/状态至少两个独立证据）才结束。
5. 补测试：10 次 429/网络仍 recording/reconnecting；200 非 continuation 不结束；明确 `chat_ended` 只结束一次；真实断网 3 分钟不误结束。
6. 同步修正 `PLATFORM_INTEGRATIONS.md` 与 TEST_PLAN。

## 12. 未做 / 明确不声称

- 未修 P0-2/P0-3/P0-4/P0-5，也未开始其他 P0。
- 未调用真实付费 API；未 Resume 真实生产任务。
- 未在干净 Windows / 真实 UAC 下双击验收。
- 未做真实浏览器点击（本机沙箱限制），UI 未改动。
