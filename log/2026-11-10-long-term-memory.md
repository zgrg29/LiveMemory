# 2026-11-10 · M7 长期观众记忆（v0.9.0 / schema 10）

## 1. 起点：现状审计

- 读 `AGENTS.md` → `STATUS` → `HANDOFF` → `ROADMAP`，再读 `AI_CONTRACT`、`DATA_MODEL`、`PRIVACY_SECURITY`、`UI_DESIGN`、`TEST_PLAN`、`DECISIONS`。
- 核对代码而非文档：`grep`/`read` 了路由、AI 导出/导入、viewers 仓储、schema 迁移、观众与 AI 页面、保留策略、清空/删除场次。
- 结论：
  - M6 的「任务 → 批次 → seq→event 映射 → 严格校验 → 版本 → 证据」完整可用，可直接复用；
  - M7 之前只有「主播维度统计」（schema v5）与「场次级 AI 画像」，**没有跨场长期记忆**；
  - 保存/删除仍按场次：删除场次会连带删除 AI 结果，30 天清理不会动 AI 画像 → 必须先建独立的长期记忆表与生命周期；
  - 身份锚点 `viewers.id = platform:stable_uid`、`sessions.broadcaster_id` 已经支持按主播隔离。

## 2. 设计取舍

- **两层更新**：本地规则合并（复用 M6 已导入结果，不接 AI）+ 可选的 AI 记忆更新包（只处理语言理解）。
  这直接对应用户要求「优先用规则处理确定情况，只有真正需要理解的部分交给外部 AI」。
- **原子事实而非文本拼接**：`memory_facts` 一行一条，带 kind/topic/statement/certainty/status/证据。
  用 `dedupe_key` 去重，用部分唯一索引保证「一话题一条存活事实」。
- **版本 = 快照 + 差异**：每次应用写一条 `memory_versions`（`snapshot_json` + `diff_json`），
  应用时整体重写事实集合。事实只有几十条/人，整体重写换取「当前状态与版本永不漂移」。
- **宁可少写，不可假装**：`stated` 必须有引用消息；无证据的推断自动降级为 `uncertain`；
  原文清理后证据变 `purged`，界面如实说「无法再验证」。
- **删除即删除**：删除记忆会删除事实/证据/版本，只留空墓碑用于阻止旧包恢复，不用软删除假装删除。

## 3. 实现顺序

1. schema 10 迁移 + `viewer-memory` 仓储。
2. 纯函数模型与合并引擎（含 180 天过时规则、矛盾、状态替换、人工复核）。
3. 版本持久化/回滚/删除/清理与生命周期联动（删除场次、保留清理、清空数据）。
4. 本地合并（选择最新 M6 分析 → 生成操作 → 幂等 source key）。
5. AI 协议：常量、Schema、三语提示词、分批导出（`seq → event_id` 映射、观众基线版本）。
6. 导入校验（安全边界）与事务应用（重复/新版本）。
7. HTTP 路由 13 个。
8. UI：`#/memory` 工作台 + 观众档案 4 标签页 + i18n 160 键 + CSS。
9. 测试 8 个新文件；同步既有 schema/版本断言。
10. 文档与日志。

## 4. 发现并修复的问题

- 差异计算把 `confidence` 当「变更」，导致「再次确认」被显示成「修改」→ 移除该字段，确认就是确认。
- 同话题 `conflict` 会撞上部分唯一索引 → 引擎显式跳过并给出原因。
- 人工「恢复」已替换事实会复活旧话题并与新事实冲突 → 复核接口拒绝，UI 不提供该操作。
- 本地一键合并会复活用户已删除的记忆 → 合并跳过并计数 `deleted`。
- 单批 M6 任务没有 `final` 结果时被判定为「不完整」→ 单批即完整。
- 写文档时用 PowerShell `Set-Content` 误把 5 个测试文件按本地代码页重写，CJK 变乱码；
  用 `git checkout`（需更宽文件权限）恢复，之后所有多字节文件改用 `write`/`edit` 或 Node `fs` 写入。

## 5. 测试

- 全量：**450 passed / 0 failed**（单进程模式，约 70–75 秒）。
- 新增：`memory-model`、`memory-engine`、`memory-ui`、`memory-local-merge`、`memory-ai-workflow`、
  `memory-privacy`、`memory-migration`、`memory-api`。
- 既有的 schema 9 断言更新为 10（`ai-api`、`ai-migration`、`broadcaster-identity`、
  `migration-emotes`、`platform-status-migration`、`history-management`），版本断言更新为 0.9.0。

## 6. 未能完成

- **真实浏览器渲染/截图**：本机应用控制策略会终止无头 Edge/Chrome（Edge `-2147483645` /
  `0x80000003`，Chrome `-36863`）。`scripts/verify-memory-ui.mjs` 与 `scripts/demo-memory.mjs` 已写好，
  但没有运行成功，因此没有新截图，也不能声称界面已通过真实浏览器验收。
- **打包 EXE 运行验收**：已构建 v0.9.0（91.0 MB、134 资源、requireAdministrator），
  但本机拒绝执行新构建的 EXE（EPERM），无法启动验收。
- **真实 AI 往返**：只有合成的 Schema 合法结果。

## 7. 下一轮建议

1. 在可运行浏览器的机器上执行 `scripts/demo-memory.mjs` + `scripts/verify-memory-ui.mjs --shots`，补齐截图与 390px 实测。
2. 构建 v0.9.0 EXE，验证 Manifest、schema 9→10 升级与打包 UI。
3. 用真实 AI 完成一次含多批、乱序、缺批的记忆更新往返。
4. 大观众量记忆列表/合并性能与索引评估。
