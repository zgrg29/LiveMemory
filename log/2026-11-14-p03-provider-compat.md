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

## 7. 正式 EXE（阶段 A 构建；最终构建与真实请求见 §13）

- 构建：`node scripts/build-windows.mjs`（代码提交后构建，build-info.commit 与提交一致）。
- 阶段 A 构建标识：`dist/LiveMemory.exe` / `96,637,952` bytes（92.2 MB）/
  SHA-256 `da2b18b1dc15096ae9c54aa2c8319b4be08a810edebe75ff37931b6dd2008f1b` /
  buildId `b0df3d53ff22` / source hash `b0df3d53ff22216ada0cf22cbc3ef31018f7ef573d6f005428a471fdf2900588` /
  builtAt `2026-11-14T10:38:00.559Z` / `189` assets / 20 个必需模块 / RT_MANIFEST `asInvoker`。
- 验证：
  - `verify-ai-token-exe` **16/16**：40/40 观众、3 批、3 请求；输入 20,893 / 输出 3,563 /
    缓存 8,356；估算费用 0.019663 USD；注入 500 后 failed=3、attempts 5 vs requests 2；
    Resume 只重发 b02；完成后 Continue 0 请求；重启 token 一致；备份 768,515 B。
  - `verify-exe` **10/10**；`verify-p0-5-exe` **12/12**；`verify-p0-2-exe` **13/13**。
- 性质：正式 EXE + 本地 Mock Provider + 合成数据；**不是**真实付费 Provider 验收，
  **不是**真实浏览器点击，**不是**用户在 UI 中输入真实 Key。

## 8. 阶段 A 未验证（后续由阶段 B 覆盖）

- 真实 Provider 的 `json_schema` 大 Schema 接受度、真实 429/5xx/空响应/截断。
- 真实 usage 与 tokenizer 校准、真实缓存命中率、真实费用与账单核对。
- 真实长期画像语义（10 vs 20）、三语言真实输出、Resume 后语言一致性。
- 真实浏览器点击；正式 EXE 中用户通过 UI 填 Key 的完整流程。

## 9. 阶段 B 授权与执行

- 用户明确授权：**Plan A / DeepSeek `deepseek-flash` / 硬上限 $1.25 / 仅合成数据**。
- 隔离目录 `tests/.tmp/paid-p03/`；用户在真实浏览器 UI 中输入 Key；Harness 未接触明文 Key，
  未读取生产 `secrets/`，未修改生产数据库。
- 实际请求：in-process 50 次 Harness 计数（T4 的 2 次本地预算停止未发出；T3 的 2 次暂停
  取消已发出但未计入 usage）+ 正式 EXE 16 次 = **66 次计数**；估算 **$0.3444**
  （高峰单价、缓存按输入价，故意保守），占授权额度 27.6%。

## 10. 第一个真实缺陷：DeepSeek thinking 耗尽探测预算

- 首次能力检测 `partial`，`text` 阶段 `finish-reason-length-empty-content`；
  2 次请求、输入 140 / 输出 8 Tokens。
- 根因：DeepSeek V4 默认 thinking（effort=high），32 Token 探测预算被隐藏推理耗尽。
- 修复：`thinking: {type: "disabled"}`（官方参数）。重新检测 `passed`：
  network/auth/text/json/session/memory/multilingual=true，structuredOutputs=false；
  4 次 usage 请求、输入 577 / 输出 237 / 推理 0，$0.0004575。

## 11. 真实任务结果

| 任务 | 数据 | 状态 | 覆盖 | 事实 | 请求 | 输入 | 输出 | 缓存 | 费用 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T1 单场 + 画像 | 80 / 800 / zh-CN | complete | 80/80 | 85 | 11 | 201,271 | 14,960 | 18,944 | $0.07833 |
| T2 cap10 #1 | 25 / 200 / zh-CN | complete | 25/25 | 67 | 7 | 62,048 | 9,209 | 32,000 | $0.02967 |
| T2 cap20 #1 | 25 / 200 / zh-CN | complete | 25/25 | 49 | 2 | 24,487 | 3,297 | 1,536 | $0.01130 |
| T3 100 观众 + Resume | 100 / 1,000 / zh-CN | complete | 100/100 | 243 | 10（8 usage + 2 取消） | 155,578 | 19,499 | 81,280 | $0.07007 |
| T4 日语 | 60 / 600 / ja | complete（先被 Harness 上限中断后 Resume） | 60/60 | 83 | 7 | 72,464 | 7,023 | 3,456 | $0.03017 |
| T2 cap10 #2 | 25 / 200 / zh-CN | complete | 25/25 | 74 | 6 | 50,088 | 8,104 | 22,912 | $0.02475 |
| T2 cap20 #2 | 25 / 200 / zh-CN | complete | 25/25 | 38 | 2 | 24,475 | 2,686 | 1,536 | $0.01057 |

- 所有任务：0 重复 topic/statement、0 跨观众证据、0 无证据事实。
- T1 单场报告 schema 1.3.0，4 批 + final；final 正确概括 13 分钟、固定话题循环、
  无打赏/争论、第 3 批起模板化、设备求助未获回应；topics 6 / sentiment 6 / highlights 6。
- 日语：kana 0.649 / CJK 0.984，无英语回退。
- T3：暂停后 2 次在途请求被取消（可能计费但未计入 usage）；重启 Resume 后 100/100，
  未重发已完成批次。
- T4：Harness 请求上限在第 3 次触发本地停止（未发送的第 4 次不计费），Resume 后 60/60。

## 12. 10 vs 20：真实语义回归与回退

- 事实保留率：第 1 次 49/67 = **73%**；第 2 次 38/74 = **51%**；覆盖均 25/25。
- cap20 第一个批次 17 位观众只产生 17 条操作（每人 1 条）；cap10 的 10 人批次产生
  37 / 11 / 26 条。
- 抽样：观众 15 的 8 条消息，cap10 提取 4 条，cap20 只 1 条；观众 0：4 vs 3。
- **RC0 恢复默认 10 人/批**；`MEMORY_MAX_VIEWERS_PER_BATCH=20` 仅保留为技术上限与实验参数。
- 这不是“20 人请求更少所以更好”的结论；正好相反，请求更少伴随事实损失。

## 13. 正式 EXE 真实验收

`scripts/ai-paid-exe-acceptance.mjs`：**11/11**（`69ec022cee31` / commit `f9b0cda`，
40 位合成观众）：

- 未认证 401；combined 202 → complete 40/40；报告 schema 1.3.0、topics 5；
  画像 79 条事实、semantic 40/40；usage 8 requests / 8 attempts、
  输入 105,982 / 输出 10,356 / 缓存 17,408；$0.04422；
  备份 1,169,923 B；重启后 complete、requests 8→8；完成后 Resume 0 请求。
- 第一次 10/11 只是脚本把已完成 Resume 的 202 当成 200；实际 8→8。修正后重跑 11/11。
- 两次 EXE 真跑 16 次 / $0.0891；总计 66 次计数 / $0.3444（含 2 次未发出、2 次取消）。

## 14. 最终费用与剩余

- 估算 $0.3444（高峰单价；DeepSeek 缓存命中价更低，实际账单应更低）。
- 2 次取消请求的输入费用未计入（保守上界 +$0.012）；DeepSeek 不返回 `usage.cost`，
  官方账单需用户在控制台核对。
- **P0-3 不能整体关闭**：只有 DeepSeek 是 L3；其他 Provider 仍 L2/L4；
  cap10 仍漏部分事实；真实 429/5xx/截断、真实浏览器截图、官方账单未验证。
