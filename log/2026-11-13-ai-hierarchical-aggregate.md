# 2026-11-13 AI 分层汇总与真实 32 批恢复

## 1. 真实故障

- 任务：`aij_01M7AD29G42TSN0DCFXA`，场次 `ses_01M77TP9QYPFRE4H9NCH`，DeepSeek Flash，zh-CN。
- 32/32 批次已保存；final 缺失；错误 `ANALYSIS_AGGREGATE_TOO_LARGE`，阶段 `session_aggregating`。
- 详情：`estimated 64471 input tokens, limit 48000, batches 32, aggregate output 16000`。
- 任务级累计：37 次成功请求、929,615 input / 76,841 output（任务行）；运行状态总计 1,123,093 / 119,877 / 43 次（包含同一会话更早的子任务）。这**不是**单次汇总输入。
- 37 次 = 32 个批次 + 5 次批次修复；日志中没有 aggregate 请求，说明失败发生在发送前。

## 2. 根因

- 配置 `contextLength=null`；旧 `MAX_AGGREGATE_INPUT_TOKENS=48000` 是程序硬上限，不是模型上下文。
- 旧算法只允许“所有 batch results 一个 final 请求”。默认 condensed 73,533 token；compact 后 64,471 token，仍大于 48,000。
- 真实 batch result 总量 110,687 字节（32 份），不是累计 1.1M token。
- `ANALYSIS_AGGREGATE_TOO_LARGE` 被旧恢复映射为 `change-model`，32/32 任务无法继续。

## 3. 新算法

1. 从已保存的 latest batch results 读取 32 份结果，不读取原始弹幕。
2. 计算请求预算：已知 context 用它；未知用 64k 保守默认；输入 = context − 输出预留 − 500，单请求 ≤192k。
3. 先尝试 direct final；装不下则按实际 token 连续分组，每片 ≤72 批，单组超预算二分。
4. 每个 leaf 生成有界 `covered_batches + session_topics`（topics ≤12 等），独立写入 `ai_aggregate_nodes`。
5. final 装不下则把节点作为下一层输入，最多 6 层；final 前最多 24 个 unit。
6. 每级校验 schema、覆盖、有效 ref、时间与去重；final 对 ≤96 批逐批补真实 ref。
7. 每个节点最多 2 次输出尝试；仍失败用已保存结果确定性兜底；Provider 错误保留可恢复。
8. 节点 source hash 复用；重启只补缺失节点与 final。

## 4. 真实数据验证

- 生产 DB/runtime/exports 只读副本（schema 14→15），原任务 `failed`。
- `/api/ai/analyze/status`：32/32、`recovery.action=resume-aggregate`、`canResume=true`。
- Mock Provider Resume：2 个局部节点 + 1 次 final；0 次 batch；complete；final 引用 32/32 批次；节点 usage 计入统计。

## 5. EXE 验证

- `dist/LiveMemory.exe`：buildId `58362fa30b5f`，commit `6083375`，SHA-256 `0aca3c895fe7d9caee14925700218613b031da3f32db05c4dbabbb820ebd5e2e`，91.9 MB，176 assets，`requireAdministrator`。
- asInvoker 测试副本（`LIVE_MEMORY_SKIP_ADMIN_CHECK=1`）+ 本地 Mock Provider + 生产数据副本：
  - `/api/health` 返回同一 buildId；
  - 旧任务状态：`resume-aggregate`、32/32、`canResume=true`；
  - Resume 后：`complete`、`aggregate.mode=hierarchical`、`nodeTotal=2`、`attemptStats.failed=0`；
  - Mock 日志：2 digest + 1 final，0 batch；
  - 最终报告：8 topics、32 refs、32/32 批覆盖。
- 未验证：真实付费 DeepSeek、真实生产任务 Resume、真实 UAC 双击、真实浏览器点击。

## 6. 测试

- 全量 683 passed / 0 failed（约 163 秒）。
- 新增 `tests/unit/ai-hierarchy.test.mjs`（10）、`tests/integration/ai-hierarchy.test.mjs`（3）；重写 `tests/integration/ai-aggregate-recovery.test.mjs`（3）。
- 覆盖：1/8/18/32/64/128 批、超预算拆分、单组截断重试、重启节点复用、0 批重发、三语、时间/证据、旧任务升级、请求上限、EXE 实跑。
