# 2026-11-12 AI 可靠性、Token 分批与自动流式

## 目标

基于 `docs/AI_TIMEOUT_INVESTIGATION.md`，修复 v0.13.1 付费 AI 分析的五类问题：

1. 大请求长时间无响应、超时后原样重发；
2. 单场请求过大（27k / 174k tokens）；
3. 无流式、无空闲超时；
4. 用户看不到真实阶段/请求状态/保存状态；
5. 失败请求 usage 缺失被当成零费用。

## 复用判断

- 结果协议、Schema 1.3.0、校验器、事务导入、报告读模型全部复用，未迁移数据库。
- 单批 session 包格式不变；只有多批时新增 final aggregate。
- 调度器、Provider 目录、加密凭据、URL/DNS 安全检查、能力检测未改语义。
- 不引入依赖、不引入云服务或遥测。

## 实施

### 1. 超时/取消/重试

- 新增 `src/ai/runtime/attempt.mjs`：
  - 分类 `canceled / timeout / network / rate_limit / server / client / invalid_response / stream_interrupted / config`；
  - `shouldRetryAttempt()`：超时/取消/无效响应/流中断不重试；连接网络一次；429/5xx 有界；
  - 任务预算、attempt 脱敏记录。
- Adapter 重写为 header timeout + 流式 idle timeout + 任务上限；外部 abort 映射为 `ANALYSIS_CANCELED`，超时映射为 `PROVIDER_TIMEOUT`。
- Runner `requestOnce()`：最多 3 次尝试，但只在策略允许时；每次写状态与日志；`Resume` 不重发已导入批次。

### 2. runPool 隔离

- 第一个失败只停止调度新批次，不 abort 在途请求；`Promise.allSettled` 后抛第一个错误。
- 新增集成测试：批 1 失败、批 2 延迟成功，批 2 仍被导入；恢复不重发批 2。

### 3. Token 分批 + 汇总

- 新增 `src/ai/batching/tokens.mjs`：
  - 预算默认 8k、可配 2k–32k、按上下文自适应；
  - session 消息连续切分；memory 观众不拆批；
  - 超预算单观众单独成批，不丢。
- `createSessionAnalysisJob()` 多批写包 + `aggregateTaskId`；`createViewerMemoryJob()` 复用一次 viewer context 做规划与打包。
- Runner 多批 session：并发执行、逐批导入、最后 aggregate；`computeJobStatus` 要求 final 才 complete。
- 新增 `buildSessionAggregatePrompt()`、`assembleSessionAggregateAnswer()`、`condenseBatchResult()`（batch-qualified refs）。

### 4. 流式

- 新增 `src/ai/runtime/stream.mjs`：SSE 增量解析、空闲 watchdog、OpenAI/Anthropic accumulator。
- Adapter：流式优先、`stream_options.include_usage` 仅已知支持者、JSON 响应兼容、stream 被拒绝一次回退并持久化。
- 流式只在内存缓冲；失败/中断不写库。

### 5. UI/统计

- 状态新增 `sessionBatchTotal/Index`、`memoryBatchTotal`、`attemptStats`、`currentRequest`、`lastRequest`、`saved`、`taskDeadlineAt`、`usageUnknownAttempts`。
- AI 中心新增请求状态/运行时间/重试/保存/统计；ETA ≥3 样本；session 请求数改“自动”。
- 设置页新增超时（秒）与单批输入上限。
- 修复 `[hidden]`；三语文案补齐。
- headless Edge + CDP 实测运行中/完成/390px/暗色/设置页，截图入 `docs/screenshots/`。

## 测试

```
node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"
→ 583 passed / 0 failed (~96s)
```

新增：

- `tests/unit/ai-attempts.test.mjs`
- `tests/unit/ai-stream.test.mjs`
- `tests/unit/ai-token-batching.test.mjs`
- `tests/integration/v14-session-batching.test.mjs`
- `tests/integration/v14-streaming-timeout.test.mjs`
- 更新 `tests/unit/ai-progress.test.mjs`

## 未验证 / 阻塞

- 真实付费 API（本机无 Key）——阻塞；未伪造。
- 真实 174k token 大场与真实 Provider 流式 usage。
- 真实 EXE/UAC。
- 真实 Provider 对 `stream_options.include_usage` 的差异。

## 关键规则补充

- 超时/取消绝不自动重发；runPool 失败不 abort 在途批次。
- 多批 session 必须 final aggregate；不丢消息/观众。
- 流式自动选择、只缓冲、完成后再校验导入。
- 无 usage → “用量未知”，不是 0 费用；ETA 必须有依据。
