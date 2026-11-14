# 2026-11-12 · v0.13.2-r3 任务完成优先

## 0. 目标

用户点击开始后，尽最大努力完成分析；不因费用、时间、请求次数或总 Token 预算中途终止。保留单请求技术超时、可恢复错误、用户取消与已完成批次保护。

## 1. 删除的人为限制

- 费用：`budget` 输入/校验/确认、累计费用停止、价格未知阻止、免费/付费分类、`memoryPermission` 的价格/opt-in gate。
- 时间：`createTaskBudget`、60/45 分钟 soft/hard、`maxTotalMs`、按剩余时间缩短请求、任务级 `ANALYSIS_TASK_TIMEOUT/PAUSED`。
- 规模：`MAX_MEMORY_BATCHES`、`ANALYSIS_TOO_MANY_VIEWERS`、`ANALYSIS_TOO_LARGE` 产品拒绝；`planMemoryViewerBatches` 默认无总批次上限。
- UI：预算输入、费用确认复选框、免费/付费标签、价格未知警告、预算状态行、任务时间设置提示。
- 路由/runner：`confirmBilling`、`optInMemory`、`budget` 参数与 `SPEND_CONFIRMATION`/`PAID_MODEL`/`BUDGET` 错误。

## 2. 保留的技术限制

- 单请求首响应 `timeoutMs`（默认 180 秒，可配 10–600 秒）。
- 流式 60 秒空闲超时；持续输出不被总时长截断。
- 单批输入 32k 上限、单观众 48k 硬上限、模型上下文、单批输出上限。
- 1,000,000 消息 / 200,000 观众为极端内存/磁盘保护；不是任务总量限制。
- 事务导入、Schema 校验、稳定 ID、证据引用不变。

## 3. 价格

- `pricing` 为空 → `pricingStatus=unknown`，正常分析，只统计 Token，`usage.cost=null`。
- 只填一侧 → `normalizePricing` 返回 null，正常分析，不计算总费用。
- 两侧完整 → 按实际 usage 计算并展示。
- 价格从不参与 start/resume/memory/capability 判定。

## 4. 任务状态与恢复

- 批次完成即保存；`runPool` 失败只停止调度新批次，在途兄弟完成并保存。
- 超时、401/402/403/404/429/5xx、网络 → `needs_action`，`canResume=true`；resume 只查未导入批次/缺失 aggregate，不重发已完成批次。
- 用户取消 → `canceled`，立即 abort，保留已完成结果。
- Schema/导入错误 → `failed`，已完成批次仍保留；可手动继续。
- `taskElapsedMs` 在 paused/needs_action/canceled/complete 冻结。
- 进度/ETA 只展示；ETA 不是超时。

## 5. 测试

- 全量 **603 passed / 0 failed**（约 96 秒）。
- 新增/更新：
  - `v14-pricing-optional.test.mjs`：空价格、完整价格、部分价格。
  - `v14-task-budget.test.mjs`：21/61 分钟仍完成；timeout → needs_action + 汇总-only resume；401 → needs_action + 修复后继续。
  - `ai-token-batching`：2500 观众无总批次上限。
  - `ai-ui`：预算/费用确认/免费付费文案已删除；新任务文案存在。

## 6. 未验证

- 真实付费 API 长任务（>60 分钟）。
- 真实 402 余额不足；代码归入 `needs_action`，未用真实余额触发。
- Windows EXE 提升后的真实运行。

## 7. 构建

见 `docs/STATUS.md` §5；Build ID 以最终构建输出为准。
