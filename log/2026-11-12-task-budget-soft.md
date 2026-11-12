# 2026-11-12 · v0.13.2-r2 任务时间预算（60/45 分钟）

## 0. 真实测试结果与触发路径

真实 qwen3.8-max 测试（未由本轮发起）：

- 单场 7/7 批次成功并保存；请求成功 9、失败 0。
- 15:35:58 启动；15:48:40 第 7 批完成，立即发出 final aggregate。
- 15:55:58 aggregate 在 `elapsedMs=435,770` 时以 `PROVIDER_TIMEOUT` 结束；20:00 任务标记 `ANALYSIS_TASK_TIMEOUT`，`detail=task-time-budget`。
- 7/7 批次结果已保存；只有完整报告（final aggregate）丢失。

**根因**：不是“预算阻止启动汇总”。汇总已经发出；`requestOnce` 把 `maxTotalMs` 设为剩余任务预算（当时约 438 秒），在途流式 aggregate 被任务预算中止。`timeoutMs=180000` 只限制首响应，流式已收到 header/output，因此实际由 `maxTotalMs` 触发。

## 1. 修复语义

- 默认任务预算 **60 分钟**；**45 分钟**软提醒。
- 60 分钟（或剩余 <15 秒）只停止 `runPool` 取新批次；在途 worker 不受影响。
- `requestOnce` 不再接收 `maxTotalMs`；单请求只保留 provider `timeoutMs`（首响应）与 60 秒流空闲。已发送超时仍不自动重发。
- 仍有未完成批次 → `ANALYSIS_TASK_PAUSED` + `status=paused`，可恢复；用户取消仍立即 abort → `canceled`。
- 只剩 final aggregate 时不检查 `canStart`；7/7 后 resume 直接发 aggregate。
- 暂停状态持久化 `taskPausedAt`、`taskDeadlineAt`、`taskSoftBudgetMs`、`error.code`；已完成批次在 DB 中，resume 只查未导入批次。
- 状态/UI：`taskElapsedMs`、`taskBudgetState`（normal/soft/hard/paused）、`taskSoftBudgetReached`、`taskBudgetReached`、`waitingAggregate`、`pendingSessionBatches`、`pendingMemoryBatches`、`resumeReason`；UI 显示已运行时间、阶段、批次、等待汇总、预算提示、可继续。

## 2. 测试

- 全量 **603 passed / 0 failed**（约 96 秒）。
- 新增 `tests/integration/v14-task-budget.test.mjs`：
  1. 20 分钟后仍完成；
  2. 45 分钟仅 soft、不停止；
  3. 60 分钟停止新批次；在途批次保存；paused 可恢复；
  4. resume 只跑缺失批次，不重复已完成；
  5. 所有批次完成后硬预算下 final aggregate 仍执行；
  6. aggregate 超时后 resume 只发 aggregate。
- `v14-streaming-timeout` 更新：在途请求跨过 60 分钟按自身 `PROVIDER_TIMEOUT` 结束，不是 `ANALYSIS_TASK_TIMEOUT`。
- `ai-attempts` 增加 normal/soft/hard 与默认 60/45 分钟。

## 3. 未验证

- 真实 60 分钟长任务（本轮只 Mock/注入时钟）。
- 真实 aggregate 超过 60 分钟时仍能完成（逻辑允许，未付费验证）。
- 真实 UAC 双击。

## 4. 构建

见 `docs/STATUS.md` §5；Build ID 以最终构建输出为准。
