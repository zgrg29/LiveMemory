# 付费 API 请求调度审计（v0.13.1）

审计日期：2026-11-11
审计对象：v0.13.0 提交 `613b787` 的 AI 自动分析代码
结论优先级：代码事实 > 历史文档 > 推测

## 1. 结论摘要

| 问题 | 结论 |
| --- | --- |
| 付费 API 是否复用了匿名 OVH 的 2 次/分钟限速器？ | **没有。** v0.13.0 的付费路径 `src/ai/api/runner.mjs` 没有导入或构造 `SlidingWindowLimiter`；限速器只存在于旧匿名路径 `src/ai/auto/runner.mjs`。 |
| 是否存在固定每分钟 2 次请求的限制？ | **只在匿名 OVH 路径存在。** `src/ai/auto/config.mjs:93` 的 `rateLimit:{limit:2,windowMs:60000}`；付费路径没有该值。 |
| 是否存在不区分 Provider 的全局请求队列？ | **没有全局队列。** 旧付费路径对同一场次完全串行；不同场次/Provider 由不同 runner 实例并行，但没有共享限流状态。新实现改为按 `configId` 隔离的调度器。 |
| 是否存在每次请求之间强制等待 30 秒？ | **没有 30 秒固定等待。** 旧付费路径只在失败重试时等待 `1200ms`、`2400ms`（最多 2 次），且没有读取 `Retry-After`。 |
| 是否存在硬编码 RPM/TPM/并发上限？ | 旧代码：匿名路径 2 RPM；付费路径没有 RPM/TPM，但**完全串行**，且 memory 批次上限 30。新代码：没有硬编码 RPM/TPM，只有可配置的初始并发（默认 3，1–8），并根据 429 动态降低。 |
| 是否存在免费 API 冷却影响付费 API？ | **没有。** 冷却状态只保存在匿名 runner 的 `SlidingWindowLimiter.timestamps` 中；付费 runner 不读取该对象。v0.13.1 已删除匿名路径，残留风险消失。 |
| 不同 Provider/区域/模型是否错误共享限流状态？ | 旧付费路径没有限流状态可共享；旧匿名路径按 provider id 建 limiter（只有一个 provider）。新实现按 `configId`（含 provider/region/model）隔离。 |
| 长期画像多批次是否被不必要地串行执行？ | **是。** 旧付费路径 `for (const batch of batches)` 逐批 await；这是真实吞吐瓶颈，不是模型慢。新实现使用有界 worker pool。 |
| 主要耗时来自哪里？ | 旧实现没有耗时统计。审计确认：模型推理/网络是单请求主耗时；本地额外耗时来自（1）完全串行，（2）每批同步重扫全 session 观众做客观记忆，（3）每批重复 DNS 安全检查。v0.13.1 已分别改为并发、按批次观众、5 分钟安全 URL 缓存。 |

**最终结论：付费 API 从未受到匿名免费 API 的 2 请求/分钟限速影响；但 v0.13.0 的付费调度确实存在人为串行、30 批上限、固定重试等待和重复本地开销。v0.13.1 已移除免费限速模块，并重写付费调度。**

## 2. 旧代码的具体位置

### 2.1 匿名免费限速（仅匿名路径）

| 位置 | 内容 |
| --- | --- |
| `src/ai/auto/config.mjs:93` | `rateLimit: {limit: 2, windowMs: 60000}` |
| `src/ai/auto/runner.mjs:121-128` | 为每个匿名 provider 构造 `SlidingWindowLimiter`，缺省 `limit: 2`、`windowMs: 60000` |
| `src/ai/auto/client.mjs:43-70` | 滑动窗口 limiter；`acquire()` 在窗口满时 sleep |
| `src/ai/auto/client.mjs:189` | `callProvider` 只有传入 limiter 时才 acquire；付费路径不传 |
| `src/ai/auto/runner.mjs:391` | 匿名批次 `for (const batch of batches)` 串行 |
| `src/ai/auto/config.mjs:24` | `MAX_AUTO_BATCHES = 30` |

### 2.2 付费路径（v0.13.0）

| 位置 | 内容 | 影响 |
| --- | --- | --- |
| `src/ai/api/runner.mjs:46-57` | 内置 `ANONYMOUS_PROVIDER`（OVH） | 无 configId 时仍可走匿名；UI 已删除，但后端保留 |
| `src/ai/api/runner.mjs:510-557` | memory 批次逐批 `await` | 完全串行，长直播吞吐低 |
| `src/ai/api/runner.mjs:703-772` | `requestOnce` 固定 `maxRetries=1`，失败等待 `1200/2400ms` | 不读 `Retry-After`，429 退避不精确 |
| `src/ai/api/runner.mjs:84`、`729` | `timeoutMs: 180000` | 所有 provider/model 统一下载/推理超时 |
| `src/ai/import/importer.mjs:213-223`（旧） | 每导入一个 memory 批次，重扫 session 全部观众并 `ensureObjectiveMemory` | O(批次数 × 观众数)，大场次阻塞事件循环 |
| `src/ai/api/runner.mjs:710-718`（旧） | 每次请求前 `assertSafeResolvedUrl`（含 DNS） | 每批一次 DNS，100 批约 100 次网络解析 |
| `src/ai/api/runner.mjs:175-235`（旧） | 无请求统计、无排队/限流等待/每批耗时 | 无法区分模型慢与本地慢 |

### 2.3 旧版时间线（结构，不是实测）

旧版没有性能计数器，因此不能诚实声称“某批模型耗时 X、等待 Y”。代码结构可以确定：

- 单场报告：1 次请求，串行；模型/网络耗时 = 全部请求耗时。
- 长期画像：N 批 × 1 次请求（缺失 ref 时 +1 次定向补充，schema 失败时 +1 次修复），严格串行。
- 正常路径没有固定等待；只有失败重试时有 1.2s / 2.4s 等待。
- 429 时旧 `AnalysisRunner` 不读取 `Retry-After`，只按固定 1.2/2.4s 重试。
- 30 批上限使 1,000 位观众（10 位/批）直接失败：`ANALYSIS_TOO_MANY_BATCHES`。

## 3. v0.13.1 新调度策略

### 3.1 删除的免费机制

- 删除整个 `src/ai/auto/`（匿名 provider 配置、runner、prompt、assemble、client、errors、state）。
- 删除 `/api/ai/auto/*` 四个路由。
- 删除 UI 的匿名免费入口、免费状态检测、自动切换、同意文案中的“免费”。
- 删除 `PRICING_STATUS.ANONYMOUS_FREE` 与相关权限分支。
- 删除 `MAX_AUTO_BATCHES=30` 对付费画像的限制。

保留并移动到 `src/ai/runtime/`：

- `json.mjs`：`extractJsonObject`、`sleepWithSignal`、`parseRetryAfter`、截断/退化检测。这些与 Provider 无关。
- `state.mjs`：本地任务状态恢复。仍只写阶段/错误码，不写提示词或聊天正文。

### 3.2 Provider 隔离的请求调度器

新增 `src/ai/runtime/scheduler.mjs`：

- key = `config:<configId>`；不同配置（Provider、区域、模型、密钥）不共享状态。
- 初始并发 = 配置值 `concurrency`（默认 3，范围 1–8），不是服务商 RPM 声明。
- 无固定 RPM/TPM 上限；不虚构官方额度。
- 429：并发减半，遵守 `Retry-After`（上限 300 秒），只暂停该 key。
- 5xx/408/425：短暂暂停该 key；不缩小并发。
- 连续 6 次成功后并发 +1，直到配置上限。
- 记录：总请求、完成、失败、当前并发、排队数、模型耗时、排队耗时、限流等待、429 次数、p50/p95。

### 3.3 重试与退避

`AnalysisRunner.requestOnce`：

- 最多 3 次尝试（`maxRetries=2`，可构造覆盖）。
- 429：交给调度器统一冷却；不重复叠加 `Retry-After`。
- 超时/网络/5xx：指数退避 1s、2s、4s…，带 50%–100% 抖动，上限 30 秒。
- 400/401/403/404：不重试，直接返回明确错误。
- 取消：所有等待都接受 `AbortSignal`。
- 预算：请求前估算，请求后累计；达到上限停止后续请求。

### 3.4 批次并发与顺序

- 单场报告：1 次请求，无需并发。
- 长期画像：同一 job 内批次互不共享观众，使用有界 worker pool；并发数 = 配置并发。
- 同一观众只属于一个批次，因此同批并发不会产生同一观众的写冲突。
- 同一主播的多个场次：按主播串行 gate；若较新场次已经写入记忆，则拒绝较旧场次，错误码 `ANALYSIS_MEMORY_OUT_OF_ORDER`，避免旧记忆覆盖新记忆。
- 已导入批次在恢复时跳过；失败批次重试；单批失败不会删除已成功批次。
- 批次上限改为 `ceil(MAX_ANALYSIS_VIEWERS / 10) + 1`（2,001），不再用 30 人为上限。

### 3.5 本地性能修复

| 问题 | 修复 |
| --- | --- |
| 每批导入重扫全部 session 观众 | 只处理本批 `validation.memory.memoryViewers`；legacy 无 assignment 时才回退全量 |
| 每批重复 DNS 安全检查 | 每个 runner 对 `baseUrl + allowLocalNetwork` 缓存 5 分钟；仍阻止私网/元数据/DNS 私网解析 |
| `listPackages` 默认 50 条导致大 job 找不到批次 | 新增 `getJobPackage(jobId, stage, batchIndex)` 精确查询 |
| 大 job 没有统计 | `getStatus.requestStats` 暴露请求/并发/排队/限流/耗时/p50/p95/429；`usage` 暴露 token/费用；有足够样本时给 ETA |

## 4. Mock 实测（本机，2026-11-11）

运行：`node scripts/benchmark-mock-scale.mjs <viewers> <messages> <concurrency>`
Mock 网络延迟 2ms；不使用真实 API、不消耗 token。

| 场景 | 批次数 | 请求 | 峰值并发 | 总耗时 | 吞吐 | 堆增长 | 结果 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 100 观众 / 1,000 消息 / 并发 6 | 10 | 10 | 6 | 591ms | 16.92 req/s | 4.83MB | complete，覆盖 100/100 |
| 1,000 观众 / 10,000 消息 / 并发 6 | 100 | 100 | 6 | 6,491ms | 15.41 req/s | 56.03MB | complete，覆盖 1,000/1,000 |

同一 1,000 观众场景修复前的对照（仅作为本地开销证据，不是旧版完整运行）：

| 版本 | 总耗时 | 平均单请求 | 失败 |
| --- | --- | --- | --- |
| 修复前（每批全量客观记忆 + 每次 DNS + `listPackages` 50 条上限） | 29,115ms 后失败；50 请求后 `ANALYSIS_PACKAGE_MISSING` | 1,757ms | 是 |
| 仅修 `getJobPackage` 后 | 52,359ms | 2,486ms | 否（但被全量客观记忆拖慢） |
| 修 `getJobPackage` + 按批观众 + URL 缓存 | **6,491ms** | **254ms** | 否 |

请求时间构成（新实现实测）：

- 模型/网络：平均 254ms，p50 246ms，p95 354ms（Mock 2ms + 本地调度/解析开销）。
- 本地排队：0ms（并发 6 足以覆盖 100 批 2ms 任务）。
- 限流等待：0ms（未发生 429）。
- 429 测试：`Retry-After: 0`，请求 2 次完成，`rateLimited=1`，无额外固定等待。
- 独立 Provider 429 不会阻塞另一 Provider（单元测试）。

## 5. 真实付费 API

本机 `%LOCALAPPDATA%\LiveMemory` 没有 `config/ai-providers.json`，`secrets/` 没有 `ai-keys.json`；环境变量也没有 DashScope/OpenAI/OpenRouter Key。v0.13.0 的阿里云百炼真实测试使用的是临时目录，结束后已删除。

因此本轮**无法重复真实付费 API 测试**。不把 Mock、历史记录或模型列表请求描述为真实生成验收。真实测试保持阻塞，需用户重新配置 Key 后执行。Mock 结果不能替代真实 Provider 的延迟、429 和计费验证。

补充：本轮只做了一次真实**免费网络只读**检查，`GET https://openrouter.ai/api/v1/models` 返回 HTTP 200、469 个模型、375ms。这不是生成请求，不消耗用户 token，也不能证明任何付费模型的生成能力。

## 6. 残余风险

- 调度器默认并发 3 是安全起点，不是官方额度；过高可能触发 429。用户可配置 1–8，程序会动态降低。
- 429 冷却上限 300 秒；若 Provider 要求更长等待，任务会失败而不是无限等待。
- 预算在请求后累计；并发请求可能同时越过上限，已发出的请求无法撤回。
- 同一主播的旧场次在新场次已写入记忆后会被拒绝；这是有意的顺序保护，不是故障。
- 5 分钟 DNS 缓存降低本地开销，但 DNS 记录在缓存窗口内变化不会被立即发现。
- 真实浏览器 UI、Windows EXE、真实 Provider 的 1,000 观众运行仍未验收。
