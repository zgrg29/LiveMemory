# 2026-11-14 RC0 最终综合验收与发布阻断项审计

## 范围

从正式 EXE、当前源码与归档真实结果出发，完成 RC0 最终验收：长期事实证据、历史事实合并/冲突、跨场次累积、
完整产品流程、安全与数据完整性、全量测试、正式 EXE。**未调用真实付费 Provider、未修改生产数据库、未 Push/Tag/发布。**

## 发现与修复

### P0-A：无证据的 confirm 把 inferred 提升为 stated

- 复现：第一场 `add` inferred（1 条弱证据）→ 第二场 `confirm` stated 无 evidence → 修复前 fact 变 stated/active。
- 修复：`validate.mjs`、`embedded.mjs` 跳过无证据 stated confirm；`engine.mjs` 要求 evidence 才提升/激活；
  无证据的匹配 add 也跳过。
- 测试：2 unit + 2 integration。
- 设计取舍：跳过而不是拒绝整份答案，避免触发额外付费补答；事实保持原 certainty。

### P0-B：旧导入路径跨观众证据

- 旧 `validateMemoryImport` 只校验 batch 内 seq 存在，未比较 `events.viewer_id`；同 batch 内可把 B 的消息挂到 A。
- 修复：比较 `event.viewer_id`，不同则 `MEMORY_EVIDENCE_OTHER_VIEWER`，拒绝整份答案。
- 测试：`memory-ai-workflow` 新增 1 项；0 写入。
- 主 v1.3 路径原本已有 `mapping.viewerId === viewerId` 检查。

## 验证

- 全量：**819 passed / 0 failed / 0 skipped（397,114.9 ms）**，`tests/.tmp/.full-rc0-final-audit-4.log`。
- 正式 EXE：`dist/LiveMemory.exe` 96,668,160 B，SHA-256 `861eeaef...`，buildId `7016d4295d0e`，
  commit `996f99266b9159efb8ff8c7186163061adc73fed`，schema 16，asInvoker。
- `verify-exe` 10/10；`verify-p0-5-exe` 12/12；`verify-p0-2-exe` 13/13；`verify-ai-token-exe` 16/16；
  `verify-youtube-lifecycle-exe` PASS（181s 断网 → 同 session → 去重 → platform_ended）。
- 真实 Bilibili 5050：9 chat / 4 viewers / 0 支付 / ended。
- 真实 YouTube Sky News `LXQz2kkE-C0`：8 chat / 8 channel id / 7 active / ended。
- 真实 Chrome + 正式 EXE：fragment→Cookie `authenticated: true`；`#/live`、`#/viewers`、`#/ai` 无页面异常。
- 归档质量（只读）：严格召回 15.1% / 24.5% / 29.5% / 18.0%；错误 stated 25.0%–31.1%；跨观众 0；重复 0。

## 未关闭问题

- **P1-A**：同 `kind+topic` 不同 statement 静默 confirm。确定性复现：旧“在便利店打工”+新“已经在医院工作”仍显示旧说法；
  旧“喜欢猫”+新“不再喜欢猫了”仍确认“喜欢猫”。属于语义冲突推理未实现；版本/人工复核可恢复。
- **P1-B**：25%–31% stated 引用不支持结论（如“搬到大阪”引用“学做菜”）；本地只证明归属，不证明蕴含。
- **P1-C**：临时信息（生日/当天状态/作业交完）被保存为 active `life_event`。
- **P1-D**：摘要无证据级校验。
- **P2**：`verify-memory-ui.mjs` 是 v0.10 陈旧脚本（`/memory` 已移除；矛盾事实在 VIEWER_B 却检查 VIEWER_A），15/21；
  其他 Provider/真实账单/5 人语义批次/原生对话框/干净 Windows 人工双击未验收。

## 结论

工程与数据完整性基础通过，2 个 P0 已修复；长期画像语义质量仍未达标。
**建议 RC0 小范围闭源内测，不建议公开发布。** 完整报告：`docs/RC0_FINAL_ACCEPTANCE.md`。

## 提交

- `bdeb0f78d7d3f5ae2509c6897d6486147457b325` fix: require evidence before promoting a memory fact to stated
- `996f99266b9159efb8ff8c7186163061adc73fed` fix: reject cross-viewer evidence in legacy memory import
- 文档提交：本文件所在提交（HEAD）
- 未 Push、未 Tag、未发布。
