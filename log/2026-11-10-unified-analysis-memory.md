# 2026-11-10 长期记忆与 AI 分析中心一体化（v0.11.0 / P8）

## 审计：为什么只更新了少数观众

- 旧 M6 提示词：`viewer_profiles` 只给“证据足够”的观众，证据不足请省略；单条发言不足以建立长期兴趣。
- 旧 M7 本地合并：只读取导入结果里的 `viewer_profiles`，没有画像的观众不会建立记忆。
- 旧 M7 AI 记忆更新包：独立的第二次任务，用户要再导出/再交给 AI/再导入/再手动合并。
- 旧分批按消息；同一观众跨批次时画像被拆散，也没有“未处理观众”的状态。

结论：不是数据库丢数据，而是产品设计把“是否被记住”交给了 AI 是否愿意写画像。

## 方案

- 统一结果 Schema 1.2.0：`session_topics` + `viewer_profiles` + `viewer_memory_updates`。
- 分析包新增 `memory_context.json` / `viewer_excerpts.jsonl`；每位观众一个记忆批次。
- 导入同一事务：分析结果 + 客观记忆头 + 语义事实/版本 + 覆盖状态。
- 客观历史由真实表确定性更新；AI 只写语义。
- 每一位观众必须有一条更新；无新语义返回空 operations + `no_new_information`，仍算已处理。
- 移除独立 `#/memory` 页面/文件/导航；观众详情保留长期记忆并新增客观历史卡。

## 分批设计

- `batchTotal = max(ceil(messages/messagesPerBatch), ceil(viewers/200), ceil(excerpts/3000))`。
- 消息切片：若批次只由消息决定，保持旧的固定切片（500/500/200），兼容 M6 测试；
  若观众数导致更多批次，则均匀切分消息。
- 观众按首个消息所在批次优先，超出 200 人/3000 条时溢到其他批次；只分配一次。
- 每个观众的全部可用消息（最近 120 条）进入该批次 `viewer_excerpts.jsonl`，跨批次不拆散。
- 无消息观众也会被分配并进入 memory_context。

## 覆盖与幂等

- `ai_job_memory_viewers` 每个观众一行；`ai_job_memory_messages` seq → event → viewer。
- 导入前预览：覆盖/新语义/无新语义/仅客观/缺失/操作数。
- 缺失观众更新 → 导入错误；旧 1.0/1.1 结果 → objective_only，不阻断报告。
- 相同结果重复导入 → duplicate，覆盖状态不变；分析/记忆同一事务，失败整体回滚。

## 测试

- 新增 `tests/integration/unified-analysis-memory.test.mjs`：A 五场一句话、B 问候、C 单条有效信息、
  D 300 位低活跃观众、E 跨 6 批/乱序/重复导入、缺失更新拒绝。
- 全量 490 passed（最终数字见 STATUS）。
- 迁移测试更新到 schema 12；旧库 v1/v7/v9/v10/v11 升级路径均覆盖。
- 构建 EXE 成功：91.1 MB / 144 资源 / requireAdministrator / SHA-256 `6b7ca0aa…`；本机仍无法启动验收。

## 未验证

- 真实 AI 返回统一 JSON 的覆盖率与错误表现；
- 数千观众真实大场性能；
- 真实浏览器 UI、暗色、390px；
- 打包 EXE 运行与 schema 11→12 真实验收。
