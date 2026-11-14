# 开发日志：RC0-AI-EFFICIENCY Token 利用率与 API 成本专项（2026-11-14）

范围：Token 归因、请求效率、重复输入、动态分批、成本口径、进度 UI。
**未修改生产数据库、未调用真实付费 Provider、未发送真实弹幕、未 Push/Tag/发布。**
专项报告：`docs/AI_TOKEN_EFFICIENCY.md`。

本轮起点：`git HEAD = 021e2be`（P0-2 文档提交，工作区干净）。

---

## 1. 阅读与核对

按 AGENTS.md 顺序阅读 STATUS / HANDOFF / ROADMAP，并按需查阅 AI_CONTRACT、AI_RELIABILITY、
DATA_MODEL、ARCHITECTURE、TEST_PLAN、PRIVACY_SECURITY、BACKUP_FORMAT、UI_DESIGN。

核对结果（文档 vs 代码）：

- `ai_jobs.usage_json` 实际形状为 `{inputTokens, outputTokens, requests, cost}`；文档描述正确，
  但没有缓存/推理 Token 字段。
- `ai_aggregate_nodes.usage_json`、`ai_translation_runs.usage_json` 存在并写入。
- `resolveAggregateContextBudget`、`resolveMemoryOutputTokens`、`planMemoryViewerBatches`、
  `viewer_excerpts.jsonl` 均存在，与上一轮交接一致。
- **文档全文没有任何关于缓存 Token 的陈述**，代码也没有解析 → 本轮从零建立事实。
- 陈旧描述（不影响本轮判定，未逐一改写）：ARCHITECTURE §1.3 的 30 批上限/300s/12000 预算，
  UI_DESIGN §7.13 的"单任务预算/确认费用"，TEST_PLAN 中 `ANALYSIS_BUDGET_EXCEEDED` 等。

## 2. Token 归因体系（第一阶段）

新增/补齐的归因落点（无 schema 变更）：

- `src/ai/providers/adapters.mjs#normalizeUsage()`：按三类 Provider 语义解析
  `prompt_tokens_details.cached_tokens`、`prompt_cache_hit_tokens`、
  `cache_read_input_tokens` + `cache_creation_input_tokens`（Anthropic 的 input 语义是"不含缓存"，
  因此总输入 = input + read + creation）。未知字段保持 0 且 `cacheReported=false`。
- `src/ai/providers/pricing.mjs`：
  - `addUsage()` 保留 `reasoningTokens / cachedInputTokens / cacheWriteInputTokens / attempts /
    unknownUsageAttempts / usageReported`；
  - 新增 `countRequestWithoutUsage()`：无 usage 的请求计一次 attempt，token 保持未知；
  - `estimateCost()` 支持可选 `cachedInputPerMillion`；未填时按输入单价计，`cachePriced=false`。
- `src/ai/runtime/attempt.mjs`：attempt 记录新增 `usageSource`、`estimateSource`、
  `inputTokens/outputTokens/cachedInputTokens/cacheWriteInputTokens`，未知为 `null`。
- `src/ai/api/runner.mjs`：
  - 新增单一写路径 `#attributeRequestUsage()`（成功、失败、无 usage 全部经过）；
  - 取消的请求不计入（用户主动中止，无远端结果）；
  - `attemptStats` 新增尝试级 token 账本与 `retryTokens/repairTokens/repairAttempts`；
  - `getStatus()` 新增 `efficiency` 块：`tokenSource`、`attempts`、`requestsWithUsage`、
    `unknownUsageAttempts`、`reasoning/cached`、`retryShare`、`tokensPer100Viewers`、
    `tokensPer100Facts`、`cost`、`costPer100Viewers`、`cachePriced`。
- 日志 `ai.request.attempt` 增加 token 字段（仍不含正文与 Key）。

## 3. 基线（第二阶段）

新增 `scripts/ai-efficiency-baseline.mjs`：
14 个场景、合成数据、Mock Provider、`tests/.tmp` 隔离目录；记录真实请求字节与分段字节，
Token 按固定规则模拟（`ceil(bytes/3.2)`）并明确标注为模拟。

"优化前"数据不是推算：用 `git archive HEAD` 导出未修改仓库到 `tests/.tmp/before-repo`，
在副本里跑同一脚本。基线（14 场景合计）：

```text
请求 216 · 输入 Token(模拟) 2,867,221 · 输出 162,037 · 总 3,029,258 · 字节 9,274,013
```

## 4. 发现的真实浪费（第三阶段）

| 发现 | 实测 |
| --- | --- |
| Schema 同时出现在提示词与 `response_format` | 1.5 KiB/请求（画像）、3.9 KiB/请求（单场） |
| 画像提示词内重复整份输出示例 | 0.7–0.9 KiB/请求 |
| 记忆契约重复 `memory_context.json` 的逐观众数组 | 2.7 KiB/请求（稀疏）、3.9 KiB（高密度） |
| 固定 10 观众上限导致过度拆分 | 1000 稀疏观众 → 100 请求，固定开销占 33.1% |
| 归因缺口（缓存/推理/无 usage/能力测试/翻译失败） | 见报告 §4.5 |

另外实测 `messages.jsonl` 的 93.8% 字节是 JSON 结构（3000 条：563,312 B，正文 34,917 B），
列为"剩余空间"，本轮**不改**（会改变证据行格式，需真实模型质量证据）。

## 5. 实施（第四阶段）

- O1 schema 只发一次（仅对已校验 structured outputs 的 Provider；其余仍发完整文本 schema）。
- O2 删除重复输出示例（保留 instructions 内那份）。
- O3 契约只保留规则 + 覆盖 ref 列表；逐观众属性以 `memory_context.json` 为唯一权威。
- O4 自适应分批：`viewerCap` 变偏好值，`viewerCapHard` 显式传入时最多 20；输出预算/摘录上限/
  内容预算仍为硬约束。`createViewerMemoryJob` 未传 `viewersPerBatchHard` 时保持旧语义。
- O5 归因补齐 + UI（推理/缓存 Token、用量来源、重试开销占比、每百观众/每百事实、费用未知）
  + 能力测试用量展示 + 翻译失败尝试计入 usage。

未实施：压缩 `messages.jsonl`、把观众上限提到 20 以上、任务级预算、失败回答加密暂存（原因见报告 §5.1）。

## 6. 优化后测量（第五阶段）

```text
请求 150（-30.6%） · 输入 2,560,520（-10.7%） · 输出 162,528（+0.3%） · 总 2,723,048（-10.1%）
字节 8,312,569（-10.4%） · 覆盖 1715/1715（不变） · 事实 1715（不变）
```

单场景：大场次 -17.3%、小场次 -14.4%、高密度 -2.0%、单场报告(custom) 0.0%、
单场报告(openai) -6.1%。0.0% 的原因与重试占比上升的原因已在报告 §7.3 说明。

## 7. 质量回归与测试

- 覆盖率/事实/重复事实/跨观众证据/恢复能力/成功率：见报告 §8。
- 新增 `tests/unit/ai-token-efficiency.test.mjs` 12 项。
- 既有测试调整 6 处：把"30 位观众=3 批"之类写死的断言改为从规划器读回批次数量，
  语义（非连续批次保存、Resume 只重试失败观众、校验失败不阻塞兄弟批次）保持不变。
- `parsePromptMemoryRefs()` 进入 `tests/helpers/ai-fixtures.mjs`，供 3 个集成测试与 Mock 使用。

## 8. 失败与处置记录

- **PowerShell 5.1 编码事故**：用 `Get-Content -Raw | Set-Content` 批量替换 `runner.mjs` 时，
  Windows PowerShell 以 ANSI 读写，导致 UTF-8 中文与破折号损坏（文件变为非法 UTF-8）。
  处置：`git checkout` 还原该文件，改用编辑工具重做全部改动；同时误覆盖的 `.gitignore` 一并还原。
  **结论：本仓库内禁止用 PowerShell 做文本编辑，只能用编辑工具。**
- **`.git` 写入被拒**：`git checkout`/`git add` 报 `index.lock: Permission denied`。
  用 ACL 诊断脚本检查 `D:\LiveMemory\.git`：当前用户拥有 FullControl、WRITE_DAC/WRITE_OWNER
  均可用，判定为 `NOT_THIS_CLASS`（不是 ACL 类问题），属沙箱对 `.git` 的写入限制；
  最终在用户批准的更宽权限下完成 git 写入。
- 测试断言随分批策略变化：逐个核对，只放宽"批次数"这类实现细节断言，不放宽覆盖/证据/恢复断言。

## 9. 结论

Token 归因、基线、浪费证据、优化、前后对比、质量回归均已落地；数据库 schema 未变更，
备份格式与结果 Schema 不变。真实付费 Provider 的 Token 校准与语义质量属 P0-3 待验收。
