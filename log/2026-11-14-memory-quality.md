# 2026-11-14 · RC0-MEMORY-QUALITY 长期画像事实完整性与语义质量

## 1. 边界

- 未调用真实付费 Provider；未发送真实观众聊天；未修改生产数据库；未 Push/Tag/发布。
- 归档真实结果来自 `tests/.tmp/paid-p03`（上一轮用户授权的 DeepSeek `deepseek-flash`），
  本轮用 `node:sqlite` 只读重评，不产生新费用。
- 新语料、测试、结构对照全部在 `tests/.tmp` 隔离目录/内存数据库完成。

## 2. 起点与异常

上一轮报告：10 人批次 67 / 74 条“有效事实”，20 人批次 49 / 38 条，结论“20 人明显更差”。
本轮先复现归档结果，发现：

1. `memory_facts` 行数包含 `needs_confirmation`。第 1 次 cap10 的 67 行 = 28 stated +
   2 inferred + **37 uncertain**；cap20 的 49 行 = 47 stated + 2 inferred。
2. `runtime/ai-v13.json` 显示 cap10 两次分别 7 / 6 次请求、4 / 3 次补答、4 / 3 次被拒输出；
   cap20 两次都是 2 次请求、0 补答。
3. 两次严格口径方向相反：cap10 15.1% / 29.5%，cap20 24.5% / 18.0%。
4. 20 人每请求/每 Token 更省：Token/正确事实 817/1,045 vs 3,393/1,386；
   $/正确事实 0.000332/0.000406 vs 0.001413/0.000589。

结论：旧结论不成立；默认 10 保留，但撤销“20 已证明更差”。

## 3. 本轮实现

### 3.1 标准答案集

- `tests/fixtures/memory-quality/gold-corpus.mjs`
  - 16 观众 / 3 场次 / 70 消息 / 30 当前事实 + 6 被替代 / 11 重要 / 1 歧义 / 26 不应保存。
  - 覆盖任务要求的 15 类场景；含同一观众跨场次、昵称变化、同名不同 ID、高频/低频、
    大量无意义短消息、敏感信息/推测/玩笑。
- `tests/fixtures/memory-quality/p03-retro-gold.mjs`
  - 16 句模板的 zh-CN / ja / en 文本与逐句标注；用于归档真实结果的事后评分。
  - 明确把“今天下班晚”“今天累”“今天生日”“问键盘”“夸剪辑”“歌曲”等单列，
    不自动算正确。

### 3.2 指标

`src/ai/quality/metrics.mjs`：

- 严格召回：stated + 语义匹配 + 引用原文支持 + 非跨观众。
- 准确率：正确 stated / 全部 stated。
- 重要召回：`importance=high`。
- 跨观众、重复、误收、歧义、Token/费用。
- 每条判定写入 `perFact`，可人工复核；歧义不计入严格分母。
- 修复过两个评分器缺陷：
  - 单字 CJK 别名（“猫”“絵”）被 `length>=2` 错误排除；
  - “猫踩键盘”同时命中猫/键盘主题时，优先选自引用原文支持的候选。

`src/ai/quality/facts.mjs`：单任务 stated/inferred/uncertain 与 active/needs_confirmation 计数。

### 3.3 工具

- `scripts/memory-quality-eval.mjs`
  - `score`：任意数据库 + job 的标准答案评分；
  - `p03`：只读重评 4 个归档运行，输出 JSON/Markdown，含 repair/rejected 列。
- `scripts/memory-batch-structure.mjs`
  - 先复制数据库到临时目录，再离线创建 5/10/20 人 job；只输出结构/Token/字节，不调用 Provider。

### 3.4 确定性修复

- `src/ai/export/split-jobs.mjs`：
  - 每位观众 `excerpt_total_messages` / `excerpt_included_messages` /
    `excerpt_omitted_messages` / `excerpt_window`；
  - manifest `batch_plan` 新增 `excerpt_per_viewer_cap=120`、`excerpt_window=most_recent`、
    `excerpt_omitted_messages`、`excerpt_truncated_viewers`；
  - job 返回汇总字段。
- `src/ai/api/prompts.mjs`：
  - `redactMemoryContext()` 保留 omitted 字段；
  - 契约新增“若 omitted>0，只包含最近消息，不得推断被省略内容”。
- `src/ai/api/runner.mjs`：
  - `efficiency.factQuality`，`factsSaved` 保留为 total 兼容。
- 未改：Schema 1.3.0、提示词 v13.2、DB schema 16、默认 10 人/批、补答/Resume/去重规则。

## 4. 测试

- 新增 `tests/unit/memory-quality-metrics.test.mjs` 10/10。
- 新增 `tests/integration/memory-quality-gold.test.mjs` 7/7：
  - 标准答案集一致性；
  - 5/10/20 人批次每位观众一次，oracle 100% 严格召回/准确率；
  - 标准答案不泄漏进 ZIP；
  - 退化答案 2 行、1 正确、1 应保存误收、召回<1；
  - 跨观众证据导入前 `AI_IMPORT_INVALID`，0 事实写入；
  - 150 条高频观众 120/30 披露；
  - 昵称变化同一 ID、同名不同 ID 不合并。
- 全量：814 passed / 0 failed / 0 skipped（248,833 ms）。

## 5. 结构对照（25 观众 / 200 消息）

| 上限 | 批次 | 每批观众 | 请求 Token 估算合计 | 包字节 |
| --- | --- | --- | --- | --- |
| 5 | 5 | 5×5 | 31,303 | 249,283 |
| 10 | 3 | 10/10/5 | 25,631 | 183,012 |
| 20 | 2 | 15/10 | 22,795 | 149,921 |

覆盖 200/200；无丢失。5 人无真实语义数据，不能把结构当质量。

## 6. 仍未解决

- 严格召回 15.1%–29.5%，重要召回 7.7%–23.1%；
- 25%–31% stated 事实引用原文不支持（语义污染）；
- 运行间方差大；n=2，不能判定批次优劣；
- 补答只补观众、不补事实；
- 摘录窗口仍 120 条/人；
- 同 topic 不同 statement 的合并语义未改；
- 其他 Provider、真实账单、thinking、真实浏览器未验证。

## 7. 复现

```bat
:: 归档真实重评（只读）
node scripts/memory-quality-eval.mjs p03 --root tests/.tmp/paid-p03 --json out.json --md out.md

:: 结构对照（先复制数据库）
node scripts/memory-batch-structure.mjs --db <copy.db> --session ses_p03_ab --caps 5,10,20

:: 专项
node --test --test-isolation=none tests/unit/memory-quality-metrics.test.mjs
node --test --test-isolation=none tests/integration/memory-quality-gold.test.mjs
```
