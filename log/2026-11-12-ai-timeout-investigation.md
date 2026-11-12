# 2026-11-12 · DashScope 174/175 秒与 PROVIDER_TIMEOUT 专项调查

## 范围

只调查、不改代码、不改配置、不调整超时、不发起付费 API 请求。

## 结论

- 根因是 **LiveMemory 自身的 180 s `AbortSignal.timeout`**（`timeoutMs=180000`，默认值，
  UI 不可见），不是百炼 175 s 固定超时、429、网络中断或本地排队。
- 超时被标记为 `retryable`，`requestOnce` 自动重发同一 session 请求 2 次（共 3 次尝试）；
  本地总耗时 543.18 s ≈ 3×180 s + 打包/退避。
- 平台两条 174.02 s / 175.01 s、status 0、usage 空，分别是第 1、2 次尝试；按推算应有第 3 条
  约 23:39:57 开始、约 175 s 的 status 0 记录。
- 用户看到的"进度停滞"是 3 次静默重试期间状态一直是 `running / session_analyzing`，
  没有 attempt 级状态或日志；第 3 次超时后才写 `failed`。
- 重试会重复执行已在服务端运行的请求；本地 `usage.requests` 只计成功响应，失败任务为 `null`，
  因此本地统计会低估重复请求。
- 统计存在三套口径：调度器尝试数（UI）、成功 usage.requests、平台每个 HTTP 请求；
  能力检测请求绕过调度器（`verify.mjs` 120 s、直接 `callProvider`），平台有记录、UI 不计数。

## 证据

- 配置：`config/ai-providers.json` → `qwen3.8-max`、`concurrency=3`、`timeoutMs=180000`。
- 状态：`runtime/ai-v13.json` 两个 failed session，`PROVIDER_TIMEOUT / request-timeout`，
  耗时 543.7 s / 543.2 s，`usage=null`。
- 日志：`ai.analysis.accepted` 23:33:51.392 → `ai.analysis.failed` 23:42:54.574，
  `httpStatus=null`、`retryAfterMs=null`。
- 分析包：23:33 任务只有一个 ZIP（23:33:51），23:36/23:39 无新包 → 重试复用同一请求体。
- 代码：`store.mjs:24`、`runner.mjs:56,89,1018-1081`、`adapters.mjs:117-120,177-192`、
  `scheduler.mjs:103-132,207-220`。

## 产物

- `docs/AI_TIMEOUT_INVESTIGATION.md`（完整报告、8 项逐条回答、复现条件、影响、修复建议、
  仍需日志、建议测试）。

## 未做

- 未改任何代码/配置/超时值；未调用真实 API；未提交修复。
- 本机 PATH 中没有 `git`，无法创建本地 commit；本轮为纯文档调查。
