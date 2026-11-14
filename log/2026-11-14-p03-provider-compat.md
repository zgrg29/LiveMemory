# 2026-11-14 · RC0 P0-3 阶段 A：Provider 兼容性、真实用量与付费测试计划

本轮性质：**阶段 A（免费、只读与 Mock 预验收）**。
未调用任何真实付费 API；未发送真实聊天、观众身份或长期画像；未修改生产数据库；
未 Push/Tag/发布。全部测试使用 `tests/.tmp` 隔离目录、合成数据与 Mock Provider。

完整矩阵、费用口径与付费方案：`docs/AI_PROVIDER_COMPATIBILITY.md`。

---

## 1. 阶段划分与授权边界

- **阶段 A（本轮）**：阅读源码/文档、审计 7 个 Provider、离线复现、修复确定性缺陷、
  Mock/集成/全量测试、正式 EXE 构建与 EXE 矩阵。
- **阶段 B（未开始）**：真实付费请求。必须先由用户选择 Provider 与模型、确认费用上限并
  明确授权。此前填过 Key 不构成授权；不自动遍历 Provider，不使用最贵模型。

## 2. 审计范围内的实际源码

`AnalysisRunner.requestOnce()`、`src/ai/providers/{adapters,catalog,verify,store,pricing,url-safety}.mjs`、
`src/ai/runtime/{attempt,stream,json,scheduler}.mjs`、`src/ai/batching/tokens.mjs`、
`src/ai/api/{prompts,compact,runner}.mjs`、`src/ai/tasks/{status,recovery}.mjs`、
`src/server/routes.mjs`、`src/web/js/pages/{ai,ai-settings}.js`、三语 i18n。

## 3. 发现的确定性缺陷与修复

### 3.1 结构化输出能力检测是循环的（严重）

- 路由 (`src/server/routes.mjs`) 把 `config.capabilities?.structuredOutputs === true` 传给
  `verifyProviderConfig`；该字段只由能力测试写入。
- 结果：首次测试必然只用 `json_object`，永远写不回 `true`。OpenAI/OpenRouter 的真实用户
  **从不发送 `response_format: json_schema`**；RC0-AI-EFFICIENCY 的“Schema 只发一次”
  优化在生产中未生效，画像/单场每请求多付约 1.5/3.9 KiB 输入。
- 复现：按路由同形入参调用 `verifyProviderConfig`，捕获序列
  `none, json_object, json_object, json_object`、`structuredOutputs=false`；
  传 provider 声明后为 `none, json_schema, json_schema, json_schema`。
- 修复：路由传 provider 目录声明；`verify` 只在 session 复杂 Schema 通过本地组装/校验后
  才写 `structuredOutputs=true`。

### 3.2 `response_format` 被拒绝时永久失败

- 旧：能力测试 fatal；真实任务 `client` 错误不重试。
- 新：能力测试一次降级到 `json_object`；真实任务 `requestOnce()` 最多两次降级
  （`json_schema → json_object → none`）；降级时把完整 Schema 追加到最后一个 user 消息；
  持久化 `downgradeStructuredOutputs()`，后续任务/Resume 不再重复失败。
- 识别范围收窄：只匹配 400/422 且错误信息含 `response_format` / `json_schema` /
  `json_object` / `structured outputs`。全量回归曾捕获 `/schema/` 过宽导致
  “synthetic schema failure” 被误判并多发请求，已修正。

### 3.3 OpenAI 推理模型参数

- 官方文档：`max_tokens` 废弃且不兼容 o-series；推理模型只接受默认 temperature；
  o-series/GPT-5+ 用 `developer` 取代 `system`。
- 修复：`providerId === 'openai'` 发 `max_completion_tokens`；o-series/GPT-5+ 不发
  `temperature`、`system→developer`；`resolveMaxCompletionTokens()` 增加 16K 思考预留
  （只是上限，未使用不计费）。能力测试同样应用。
- 非 OpenAI 家族保持 `max_tokens`；DashScope 仍额外发 `max_completion_tokens`。

### 3.4 OpenAI 缓存写入 Token 未解析

- 正确字段 `prompt_tokens_details.cache_write_tokens` 未被读取，`cacheWriteInputTokens`
  恒为 0。已修复并加单测；缓存读取仍作为输入子集，不与输入相加。

### 3.5 OpenRouter 自报费用被丢弃

- `usage.cost` 之前只放进 result 后被忽略。现在归一为 `providerReportedCost`，
  累计进 `ai_jobs.usage_json` 与 `efficiency`，与本地估算 `cost` 分开；
  `providerCostRequests` 标记完整/部分自报。

## 4. 10 vs 20 离线结构对照

`node scripts/ai-efficiency-baseline.mjs --only <scenario> --viewer-cap 10|20`

| 数据 | 上限 | 请求 | 批次 | 输入 Token（模拟） | 输出 Token（模拟） | 请求字节 | 覆盖/事实 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 25 观众 / 200 消息 | 10 | 3 | 3 | 25,881 | 2,304 | 82,818 | 25/25 |
| 25 观众 / 200 消息 | 自适应 20 | 2 | 2 | 22,898 | 2,308 | 73,271 | 25/25 |
| 100 观众 / 1,000 消息 | 10 | 10 | 10 | 113,038 | 9,210 | 361,706 | 100/100 |
| 100 观众 / 1,000 消息 | 自适应 20 | 6 | 6 | 101,310 | 9,252 | 324,183 | 100/100 |

只证明结构、覆盖与请求数；Mock 事实是确定性生成，**不证明语义质量**。真实语义质量、
漏写率、跨观众证据污染与补答率必须由阶段 B 盲评。

`--viewer-cap` 是 harness 传入的 runner 构造参数，只能收紧上限；不是 HTTP/配置/UI 开关。

## 5. 测试

- 新增 `tests/unit/ai-provider-compat.test.mjs` **12** 项。
- 新增 `tests/integration/ai-provider-compat.test.mjs` **3** 项。
- 全量：**796 passed / 0 failed / 0 skipped**（2026-11-14，
  `node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`，
  468,209 ms）。
- 期间的一次真实失败：`v13-scheduler` 的“failed memory batch resume”预期 2 请求、实际 3，
  原因是 `/schema/` 过宽识别把 “synthetic schema failure” 当成格式拒绝。收窄后复跑 18/18，
  全量 796/0。

## 6. Provider 兼容性矩阵

见 `docs/AI_PROVIDER_COMPATIBILITY.md` §2。结论：7 个 Provider 全部 L1+L2；
**没有一个达到 L3（真实 Provider 已验证）**。

## 7. 正式 EXE

- 构建：`node scripts/build-windows.mjs`（代码提交后构建，使 build-info.commit 与提交一致）。
- 验证脚本：`verify-ai-token-exe`、`verify-exe`、`verify-p0-5-exe`、`verify-p0-2-exe`。
- 具体 buildId / commit / SHA-256 / 大小 / 构建时间与逐项结果见 `docs/STATUS.md` §0.27。

## 8. 未验证（阶段 B 或后续）

- 真实 Provider 的 `json_schema` 大 Schema 接受度、真实 429/5xx/空响应/截断。
- 真实 usage 与 tokenizer 校准、真实缓存命中率、真实费用与账单核对。
- 真实长期画像语义（10 vs 20 盲评）、三语言真实输出、Resume 后语言一致性。
- 真实浏览器点击；正式 EXE 中用户通过 UI 填 Key 的完整流程。

**P0-3 未完成，不得宣称通过。** 下一步是用户批准 `docs/AI_PROVIDER_COMPATIBILITY.md` §7
的方案与费用上限。
