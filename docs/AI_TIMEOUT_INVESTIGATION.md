# DashScope 请求 174/175 秒与 `PROVIDER_TIMEOUT` 专项调查（v0.13.1）

> **后续（2026-11-12）**：本报告的 P0/P1 修复已落地，见 `docs/AI_RELIABILITY.md`。
> 超时不再自动重发同一长请求；取消/超时分离；增加任务预算、token 分批、自动流式与 attempt 级日志。
> 本报告保留当时的根因证据与代码位置，不再代表当前行为。

- 调查日期：2026-11-12
- 范围：阿里云百炼 / DashScope `cn-beijing`、`qwen3.8-max`、初始并发 3 的真实请求异常
- 结论性质：只做根因定位。**本轮未修改任何代码、配置、超时值，未发起任何付费 API 请求。**
- 数据来源：仓库代码、`E:\新建文件夹` 数据目录的 `config/ai-providers.json`、`runtime/ai-v13.json`、
  `logs/livememory-2026-11-11.log`、`exports/` 文件时间戳，以及用户提供的百炼 Request ID 详情。

---

## 1. 结论（一句话）

**这不是百炼在 175 秒时主动断开，也不是 429、网络中断或本地排队。**
LiveMemory 为每一次 HTTP 尝试设置了 **180,000 ms 的 `AbortSignal.timeout`**；当 `qwen3.8-max`
的非流式长推理超过 180 秒仍未返回响应头时，**客户端自己断开连接**，百炼因此记录
`status=0`、耗时为服务端已处理时间（174–175 秒）、token 用量为空。
该超时被代码标记为 **可重试**，于是 LiveMemory 自动把同一请求又发了 2 次，共 3 次尝试，
最终在开始后 **543.18 秒** 记录 `PROVIDER_TIMEOUT / request-timeout`（`httpStatus=null`）。

用户看到的两条 174/175 秒请求，是**同一个逻辑 session 请求的第 1、2 次尝试**；
按本地时间与重试上限推算，平台日志中**还应存在第 3 条**约 23:39:57 开始、约 175 秒的
`status=0` 请求（见 §5.4、§9）。

---

## 2. 关键数值：默认值、配置值、实际生效值

| 项目 | 值 | 位置 |
| --- | --- | --- |
| 后端默认超时 | **180,000 ms** | `src/ai/providers/store.mjs:24` |
|  Runner 默认超时 | **180,000 ms** | `src/ai/api/runner.mjs:56` |
| 适配器兜底值 | 120,000 ms（正常路径不会用到） | `src/ai/providers/adapters.mjs:118` |
| 配置值（本机真实配置） | **180,000 ms** | `config/ai-providers.json` 的 `timeoutMs` |
| 最小 / 最大 | 10,000 / 600,000 ms | `store.mjs:33-37` |
| 实际生效值 | **每次尝试 180,000 ms** | `runner.mjs:89` → `runner.mjs:1030` → `adapters.mjs:117-120` |
| UI 可设置项 | **不存在** | `src/web/` 中只有 toast 的 `timeout`，无 `timeoutMs` 字段 |
| 能力检测超时 | **120,000 ms**（另一条路径） | `src/ai/providers/verify.mjs:185` |
| 失败重试 | 最多 3 次尝试（`maxRetries=2`） | `runner.mjs:163,172,1018` |
| 重试退避 | 0.5–1 s、1–2 s（全抖动）+ `Retry-After` | `scheduler.mjs:207-220` |

本机配置：

```text
providerId=dashscope  region=cn-beijing  model=qwen3.8-max
baseUrl=https://dashscope.aliyuncs.com/compatible-mode/v1
concurrency=3   timeoutMs=180000   pricingStatus=paid
```

`timeoutMs` 是**创建配置时写入的默认值**，设置页从未提供输入框；因此用户"找不到超时设置"
是准确的——它不是被隐藏，而是从未暴露到 UI。

---

## 3. 一次请求的完整生命周期（代码路径）

1. `POST /api/ai/analyze/run` → `AnalysisRunner.start()`（`runner.mjs:264`）。
2. `launch()` 创建一个 `AbortController`，把 `signal` 放进 `context`（`runner.mjs:339-357`）。
3. `run()` → `runSession()`（`runner.mjs:463-468,557`）。
4. `createSessionAnalysisJob()`：写分析包 ZIP（本机 23:33:51，96,782 B）；该 ZIP **只写一次**。
5. `buildSessionPrompt()`：本机该请求的估算输入为 **26,969 tokens**（`estimatedCost.inputTokens`）。
6. `requestWithRepair()` → `requestOnce()`（`runner.mjs:953,1012`）。
7. `#ensureSafeProviderUrl()`：DNS 私网检查，5 分钟内缓存（`runner.mjs:220-235`）。
8. `scheduler.run()`：按 `configId` 取并发槽（此处并发 3、只有一个 session 请求，**不排队**），
   然后调用 `callProvider()`（`runner.mjs:1022-1031`）。
9. `callOpenAICompatible()`：
   - `body.max_tokens = 8000`（session）、`temperature=0`、**非流式**；
   - `signal = AbortSignal.any([外部取消信号, AbortSignal.timeout(180000)])`
     （`adapters.mjs:117-120,166-176`）。
10. 180 秒内没有响应头 → `fetch` 以 `TimeoutError` 拒绝 → 适配器映射为
    `ProviderHttpError('PROVIDER_TIMEOUT', {retryable: true})`（`adapters.mjs:178-184`）。
11. `scheduler.run()` 记 `failed++`；**`#penalize` 对无 HTTP status 的超时不做任何降速/暂停**
    （`scheduler.mjs:103-132`）。
12. `requestOnce()` 的 catch：`isRetryable` 为真 → `retryDelayMs(0)` 0.5–1 s → **原样重发**；
    第二次再超时 → 再等 1–2 s → **第三次原样重发**（`runner.mjs:1059-1081`）。
13. 第三次仍超时 → 抛出 `PROVIDER_TIMEOUT` → `run()` 的 catch（非 paused/canceled）→ `fail()`。
14. `fail()` 写入 `status='failed'`、`error={code:'PROVIDER_TIMEOUT',detail:'request-timeout'}`，
    并写日志 `ai.analysis.failed`（`runner.mjs:531-555`）。

---

## 4. 本地证据（脱敏）

### 4.1 状态文件 `runtime/ai-v13.json`

| session | 模式/模型 | 开始（+08） | 结束（+08） | 状态 | 错误 | usage |
| --- | --- | --- | --- | --- | --- | --- |
| `ses_01M757YMPN5JHSCCVT0R` | combined / `qwen3.8-omni-flash` | 22:46:55.231 | 22:55:58.964 | failed | `PROVIDER_TIMEOUT` | `null` |
| `ses_01M75H783XM0HWPFK5H8` | combined / `qwen3.8-max` | 23:33:51.365 | 23:42:54.571 | failed | `PROVIDER_TIMEOUT` | `null` |

两条独立任务耗时分别为 **543.734 s** 与 **543.206 s**，几乎完全相同。
`543 s ≈ 3 × 180 s + 3 s`（打包 + 两次 0.5–2 s 退避），这是"3 次尝试"的直接算术证据。
两者的 `sessionReportDone=false`、`batchIndex=0`、`usage=null`，说明失败发生在
**session 请求本身**，不是导入、画像或后续批次。

### 4.2 运行日志 `logs/livememory-2026-11-11.log`

```text
15:33:51.392Z info  ai.analysis.accepted  sessionId=ses_01M75H783XM0HWPFK5H8 mode=both
15:42:54.574Z warn  ai.analysis.failed    sessionId=ses_01M75H783XM0HWPFK5H8
                     provider=dashscope model=qwen3.8-max
                     code=PROVIDER_TIMEOUT retryAfterMs=null httpStatus=null
```

- 中间 9 分 3 秒**没有任何失败/重试事件**：`requestOnce` 的重试是静默的，状态一直是 `running`。
- `httpStatus=null` 是决定性的：失败不是任何 HTTP 状态码（不是 429、408、5xx），
  而是 fetch 被 abort。
- 22:46 的失败任务同样只有 `accepted` 与 `failed` 两行，间隔 543.66 s。

### 4.3 分析包时间戳

`exports/` 中 23:33 任务只有一个包：

```text
LiveMemory-Session-HWPFK5H8-VSMENZ-20261111-2333-ja.zip  96,782 B  23:33:51
```

23:36、23:39 附近**没有新包**，说明第 2、3 次尝试复用的是同一个提示词/同一份消息，
不是重新打包，也不是"另一个批次"。

### 4.4 与平台日志交叉

用户提供：

| 平台开始 | 平台耗时 | 平台状态 | token |
| --- | --- | --- | --- |
| 23:33:59 | 174.02 s | 0 | 空 |
| 23:36:57 | 175.01 s | 0 | 空 |

- 两条开始时间相差 **178 s ≈ 180 s 超时 + 约 3–4 s 重连/退避**。
- 每条耗时 174–175 s ≈ 180 s 客户端超时 − 约 5–6 s 平台计时起点之前的预填充/排队时间。
- 状态 0 = 平台确认"客户端主动中断"；token 为空 = 没有完成的 usage 记录。
- 代码中**不存在 175 秒计时器**（全仓库仅 180000/120000/30000 等值），所以 174/175 不是
  LiveMemory 的第二套超时。

### 4.5 错误码能排除哪些假设

适配器只有在 `fetch` 本身被 abort 时才产生 `PROVIDER_TIMEOUT`：

| 假设 | 应出现的本地错误 | 实际 | 判定 |
| --- | --- | --- | --- |
| 平台 175 s 固定超时并断开 | `PROVIDER_HTTP_ERROR` / `PROVIDER_NETWORK_FAILED`，有 status 或 socket 错误 | `PROVIDER_TIMEOUT`，`httpStatus=null` | 排除 |
| 网络中断 / NAT 空闲超时 | `PROVIDER_NETWORK_FAILED`（`TypeError: fetch failed` / ECONNRESET） | 同上 | 排除 |
| 429 限流 | 429 + `rateLimited>0` + `Retry-After` | 429=0、无 Retry-After | 排除 |
| 本地并发排队 | `queueWait` 增长、`active<concurrency` | 单请求、无排队 | 排除 |
| 响应头已到、读取 body 时中断 | `safeJson` 吞掉异常 → `PROVIDER_RESPONSE_INVALID` | `PROVIDER_TIMEOUT` | 排除 |
| **客户端 180 s 超时** | `PROVIDER_TIMEOUT`、`httpStatus=null`、平台 status 0 | 完全一致 | **确认** |

结论：180 秒内**连响应头都没有收到**，服务端仍在推理/排队；客户端先放弃。

---

## 5. 逐项回答

### 5.1 `timeoutMs` 的默认值、配置值、实际生效值

- 默认 **180 s**（`store.mjs:24`，`runner.mjs:56`）。
- 本机配置 **180000**（`config/ai-providers.json`）；UI 无输入项，属于创建时写入的默认值。
- 实际生效 **每次尝试 180 s**，由 `runner.mjs:89` 注入 `provider.timeoutMs`，
  `adapters.mjs:118` 再包成 `AbortSignal.timeout`。
- 能力检测走另一条路径，固定 **120 s**（`verify.mjs:185`），不受该配置影响。

### 5.2 是否存在约 175–180 秒的取消机制

- **只有 180 s 的 `AbortSignal.timeout`**（`adapters.mjs:117-120`）。没有 175 s 常量、
  没有 `Promise.race` 定时器、没有自定义 undici dispatcher、没有设置 socket 超时。
- 其他取消来源：用户暂停/取消/关停（`runner.mjs:1095-1111,1152`）、
  `runPool` 首个失败时中止同批其他请求（`runner.mjs:126-153`）。它们与本次超时不是同一机制。
- Node/undici 默认的 300 s 响应头超时高于 180 s，不会先触发。

### 5.3 请求生命周期

见 §3。关键点：**超时发生在"等待响应"阶段**，重试发生在 `requestOnce` 内部，
状态机和 UI 都不知道"第几次尝试"；只有全部尝试失败后才进入 `fail()`。

### 5.4 两条请求是否同一逻辑任务的不同尝试

**是。** 依据：

1. 同一 session 任务只有一个 session 请求（`batchTotal=1`，`batchIndex=0`）。
2. 两条请求间隔 178 s ≈ 一次 180 s 超时 + 一次重连，而不是并发批次的启动间隔。
3. 23:33:51 之后只写过一个分析包，23:36/23:39 没有新包，重试复用同一提示词。
4. 本地任务在 543 s 后失败；`maxRetries=2` 恰好给出 3 次尝试。
5. 平台两条记录都是"客户端中断"，没有一条正常完成；不存在"一条成功、一条失败"的批次。

因此第 1 条 = 尝试 1，第 2 条 = 尝试 2。按 543 s 推算，**第 3 条应在 23:39:57 左右开始、
约 175 s 后结束**；请用平台日志确认（见 §9）。

### 5.5 为什么平台状态 0，但 LiveMemory 没有立即失败或继续

- 状态 0 是**平台侧**对"客户端断开"的记录；LiveMemory 根本收不到这个状态，也收不到任何
  HTTP 响应。它只观察到自己的 180 s abort。
- abort 被映射为**可重试**错误，`requestOnce` 会静默再发 2 次；这 9 分钟里状态一直是
  `running`、阶段一直是 `session_analyzing`、进度 0/1，看起来"停滞"，但进程没有死锁。
- 只有第 3 次超时后，`fail()` 才写 `failed` 和 `ai.analysis.failed`（23:42:54）。
- UI 只在轮询到终态后显示"AI 请求超时"；运行中没有"第 2/3 次尝试""已等待 6 分钟"之类提示。

### 5.6 重试是否会重复发送已在服务端执行的请求

**会，而且这里是必然发生。**
超时后没有取消确认（客户端已断开，服务端可能仍在生成），重试发送的是**完全相同的 body**
（同一 messages、`temperature=0`、`max_tokens=8000`），Chat Completions 没有幂等键。
平台耗时 174–175 s 说明服务端确实处理了约 3 分钟；`usage` 为空说明结果被丢弃。
本地 `usage.requests` 只在成功响应后 +1（`pricing.mjs:115-121`），所以失败任务的
`usage=null`，**不会反映这 3 次服务端工作**，本地费用统计会低估重复推理的成本/配额消耗。
百炼是否对 abort 的请求计费，需要账单侧确认（token 用量为空通常意味着未计入完成用量，
但不能据此断定未计费）。

### 5.7 本地统计与平台日志的口径差异

存在**三套不同的"请求数"**：

| 口径 | 位置 | 计数对象 | 失败任务表现 |
| --- | --- | --- | --- |
| UI「总请求数 / 已完成 / 失败请求」 | `ai.js:536-549`，来自 `scheduler.stats()` | 调度器**尝试次数**；按 `configId`、按进程累计，重启清零 | 总 3 / 完成 0 / 失败 3 |
| `usage.requests` | `ai-v13.json`，成功响应后 +1 | 只计**成功完成的响应** | `usage=null`，即 0 |
| 平台请求日志 | DashScope 控制台 | 每个 HTTP 请求（含 status 0） | 3 条（其中 2 条已确认） |

具体差异来源：

1. **能力检测请求不进调度器。** 23:32 的 4 个 1–10 s 成功请求是
   `verifyProviderConfig()` 直接调用 `callProvider()`（`routes.mjs:1175-1184`、`verify.mjs:271-280`），
   不走 `ProviderRequestScheduler`，所以平台有记录、AI 中心「总请求数」没有。
2. **重试算多次。** 一次逻辑请求超时 2 次会记 3 次尝试；平台也是 3 条，但本地"已完成"只认
   HTTP 200。
3. **重启清零。** `schedulers` 是内存 `Map`（`runner.mjs:175,203-218`），重启/重新加载后
   历史尝试数消失；平台日志仍在。
4. **按配置而非按任务。** 同一 `configId` 的多个任务共享同一个调度器计数，UI 没有标注
   "当前任务"还是"当前配置累计"。
5. **"成功"定义冲突。** 平台文档把 status 0 描述为"请求成功但客户端中断"；LiveMemory 记为
   `failed`。同一条记录在两边的成功率里会落在不同桶。

所以「429 = 0」是准确的（没有 429），但「失败请求 = 1/2/3」与平台「status 0」不是同一语义。

### 5.8 并发调度、取消、状态恢复、进度更新的潜在 Bug

| # | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| B1 | **超时被当成可重试错误**，自动重发 2 次 | `adapters.mjs:179-184`，`runner.mjs:1062-1081` | 3 倍服务端推理/费用；失败延迟 9 分钟 |
| B2 | `AbortError`（用户取消/暂停/关停/同批中止）与 `TimeoutError` 被合并为 `PROVIDER_TIMEOUT` | `adapters.mjs:178` | 取消也被标记为"超时且可重试"；当前靠循环顶部的 `signal.aborted` 兜住，未多发包，但语义/日志错误 |
| B3 | 超时不触发任何降速/暂停 | `scheduler.mjs:103-132` | 3 个并发批次同时超时后会同时重发，形成重试脉冲 |
| B4 | 没有任务级总时限，最坏耗时 = (maxRetries+1) × timeout | `runner.mjs:1018` | session 9 分钟；画像多波次可更久 |
| B5 | 没有"尝试次数/已等待"状态与日志 | `runner.mjs:1012-1085`，`state.mjs` | UI 无法区分"正在推理"与"正在重试"；排障只能靠总耗时反推 |
| B6 | `runPool` 首个失败即 abort 同批其他请求 | `runner.mjs:126-153` | 并发的其他画像批次被中途掐断，已完成部分丢弃；恢复时重发，重复工作 |
| B7 | 统计按配置/进程累计、重启清零、不按任务 | `runner.mjs:392-393` | 与平台日志对不上；用户误以为"少算了请求" |
| B8 | 失败尝试不计入 `usage.requests`/费用 | `pricing.mjs:115-121` | 本地看不到重复请求的成本；只有 `estimatedCost` 预估 |
| B9 | 无流式、无 idle-timeout | `adapters.mjs:143-176` | 只要总生成超过 180 s 必失败，即使模型一直在正常出 token |

---

## 6. 可复现条件

**真实条件（已发生两次）**

- Provider：DashScope `cn-beijing`；模型 `qwen3.8-max`（另一次为 `qwen3.8-omni-flash`）。
- 配置：`concurrency=3`、`timeoutMs=180000`（默认、UI 不可见）。
- 请求：非流式 `/chat/completions`，session 提示词约 27k input tokens（另一次约 173k），
  `max_tokens=8000`，`temperature=0`。
- 服务端首 token/总生成使"从 fetch 到响应头"超过 180 s（高峰时段、长报告、长提示词）。
- 结果：本地 3 次尝试、约 543 s、`PROVIDER_TIMEOUT`、`httpStatus=null`；平台 3 条 status 0、
  每条 174–175 s、usage 空。

**可确定复现（不消耗付费 API）**

用注入的 `fetchImpl` 模拟"永不返回响应头的 fetch"，配合可推进的时钟/短超时：

1. 让 `fetchImpl` 返回一个在 `timeoutMs` 后以 `TimeoutError` 拒绝的 Promise；
2. 断言 `runner` 发起 3 次调用、总耗时 ≈ 3×timeout+退避、终态 `failed/PROVIDER_TIMEOUT`；
3. 另一条用例让外部 `AbortController` 在第 1 次尝试中途 abort，断言**不应**再发第 2 次，
   且终态是 `canceled` 而不是 `PROVIDER_TIMEOUT`。

现有测试没有覆盖 AI 超时/重试（`tests/` 中无 `PROVIDER_TIMEOUT`、无 AI `timeoutMs` 断言），
这是本次问题未被提前发现的测试缺口。

---

## 7. 影响范围

- **必然失败**：任何"从发出到响应头 > 180 s"的 session/画像请求，在 3 次尝试后失败；
  模型越慢、提示词越长、输出预算越大，越容易触发。
- **重复服务端执行**：每次超时都重发同一长请求，最多 3 倍推理；并发的画像批次被 `runPool`
  中止后，恢复时还会再发。
- **用户体验**：9 分钟内进度停在 0/1，只有"失败请求"数字在涨；容易被误认为卡死，
  用户手动取消/重启会进一步放大重复请求。
- **费用/配额**：本地 `usage=null`，看不到这 3 次尝试；实际是否计费取决于平台对 abort 的
  处理，需要账单确认。
- **统计可信度**：AI 中心的"总请求数/失败请求"与平台日志口径不同，不能直接对账。
- **可恢复性**：失败后 `resume` 会再次用同一 180 s 配置重发；不改变超时/模型/提示词时，
  大概率再次失败。

---

## 8. 修复建议（本轮不实施）

按优先级：

**P0 —— 停止无脑重发**
1. 客户端超时（`TimeoutError`）默认**不自动重试**；只在"连接尚未建立/请求未写出"时允许一次重试。
   理由：请求已经到达服务端并执行了 174 s，重发只会重复推理。
2. 显式区分 `TimeoutError`（本地超时）与 `AbortError`（用户取消/暂停/池中止）；
   取消不得标记为 `retryable`（`adapters.mjs:178`）。

**P1 —— 让超时可见、可配、合理**
3. 设置页增加「单次请求超时」（后端已支持 10–600 s，`store.mjs:33-37`），并显示当前生效值；
   默认 180 s 对非流式 8k 输出偏低。
4. 优先改流式（`stream:true`）+ 空闲超时（如 60 s 无数据），而不是"总时长 180 s"一刀切；
   或至少给 session 请求更长的总时限。
5. 增加任务级总时限与"第 N/3 次尝试、已等待 X 分钟"的运行状态。

**P1 —— 降低重复工作**
6. 超时后不要立刻重发同一长请求；让用户选择"延长超时后重试"或"缩小范围/换模型"。
7. `runPool` 首个失败时，评估是否应等待同批其他请求自然结束（或至少记录它们的中断），
   避免把接近完成的推理全部丢弃。

**P2 —— 统计与可观测性**
8. 区分并持久化「HTTP 尝试数」「成功响应数」「失败尝试数」，按任务而非按配置展示；
   能力检测请求单独计数或明确排除。
9. 每次尝试记录：attempt、timeoutMs、elapsedMs、abort 类型、是否收到响应头、字节数；
   超时请求没有响应头，拿不到 Request ID，只能靠时间关联。
10. 失败尝试不产生 usage 是正常的；但应明确显示"本次尝试未返回 usage，费用未知"，
    不要把 `estimatedCost` 当成实际费用。

**不要做**：单纯把 180 s 改成 600 s。那会把"9 分钟失败"变成"30 分钟失败"，仍然会在
超时后重发，且不解决非流式长推理的结构问题。

---

## 9. 证据不足 / 还需要哪些日志

1. **平台第 3 条记录**：请确认 23:39:55–23:40:00 之间是否还有一条 `status=0`、
   耗时约 175 s 的请求。按 `3×180 s` 与 `maxRetries=2` 推算它必须存在；若不存在，
   说明第 3 次尝试在发出前就失败，需要重新解释（但那会产生 `PROVIDER_NETWORK_FAILED`
   而不是 `PROVIDER_TIMEOUT`，与本地记录矛盾）。
2. **平台"耗时"的定义**：是从网关收到请求算起，还是从预填充/开始生成算起？
   这决定 174/175 与 180 的 5–6 s 差值如何解释（当前最可能是预填充/TTFT/排队）。
3. **计费明细**：status 0、usage 空的请求是否计费；3 次尝试是否产生 3 份费用。
4. **本地每次尝试的时间戳**：当前代码不记录 attempt 级日志，只能由总耗时反推。
   若能在不付费的前提下复现（mock fetch），可精确验证。
5. **平台 Request ID 与本地请求的映射**：超时请求没有响应头，LiveMemory 拿不到
   `x-request-id`；只能按时间对齐。后续可在发送前记录本地 attempt 开始时间（不含正文）。
6. **网络抓包（可选）**：确认 TCP 连接在约 180 s 时由客户端发出 FIN/RST，而不是平台先断。
   现有错误码已基本排除平台先断，抓包只是加固。

> 注意：以上都不需要、也不应该通过消耗真实付费 API 来验证；mock fetch + 本地时钟即可。

---

## 10. 建议新增的测试（后续轮次，不消耗 API）

- `tests/unit/ai-timeout.test.mjs`
  - 超时 → 只尝试 1 次（修复后）或明确记录 3 次（修复前基线）；
  - `TimeoutError` 与 `AbortError` 分类不同；
  - 用户取消 → 不再发新请求、终态 `canceled`；
  - 3 个并发批次同时超时 → 不产生无退避的重试脉冲；
- `tests/integration/v13-timeout.test.mjs`
  - 543 s 场景用假时钟压缩到毫秒级；
  - 失败后 `resume` 不重复发送已成功导入的批次；
  - 统计口径：attempts / completed / failed 与平台式计数一致。

---

## 11. 代码索引

| 主题 | 位置 |
| --- | --- |
| 默认超时 180 s | `src/ai/providers/store.mjs:24`、`src/ai/api/runner.mjs:56` |
| 配置归一化/上限 | `src/ai/providers/store.mjs:33-37,105,317-320` |
| 生效超时注入 | `src/ai/api/runner.mjs:89,1030` |
| `AbortSignal.timeout` / 合并取消 | `src/ai/providers/adapters.mjs:117-120,166-176` |
| 超时→可重试错误 | `src/ai/providers/adapters.mjs:177-192` |
| 重试循环/退避 | `src/ai/api/runner.mjs:1012-1085`、`src/ai/runtime/scheduler.mjs:207-220` |
| 调度器统计 | `src/ai/runtime/scheduler.mjs:147-203` |
| 失败落状态/日志 | `src/ai/api/runner.mjs:531-555` |
| 任务总状态/统计暴露 | `src/ai/api/runner.mjs:359-457` |
| 并发池首个失败中止其他 | `src/ai/api/runner.mjs:126-153` |
| 能力检测绕过调度器、120 s | `src/server/routes.mjs:1175-1184`、`src/ai/providers/verify.mjs:185,271-280` |
| usage 只计成功 | `src/ai/providers/pricing.mjs:115-121` |
| UI 统计文案/渲染 | `src/web/js/pages/ai.js:536-549`、`src/web/i18n/zh-CN.json` 的 `ai.center.stats` |
| 重启中断恢复 | `src/ai/runtime/state.mjs:73-88` |

---

## 12. 一句话给用户

平台状态 0 不是"百炼成功了"，也不是"百炼挂了"；它是**客户端在 180 秒时主动断开**的痕迹。
真正需要修的是 LiveMemory 的"180 秒总超时 + 超时自动重发同一长请求"，而不是把责任推给
API 服务商，也不是简单把超时调大。
