# 工程状态（STATUS）

最后更新：2026-11-10（P8 长期记忆与 AI 分析中心一体化，版本 0.11.0，schema 12）

> 本文件是唯一进度来源。只要代码与本文不一致，以代码与实测为准，并立即修正本文。

## 1. 当前阶段

- 里程碑：**M0 / M1 / M2 核心 / P0–P8 / M6 / M7 核心完成**；M3 真实接入继续验证；M4 部分完成；M5 未完成
- 版本：`0.11.0`（`package.json` 与 `src/shared/app-info.mjs` 一致）
- 数据库 schema：**12**（统一分析/记忆覆盖；v11 原地升级）
- 分支：`main`，本地提交，未 Push
- 发布形态：`LiveMemory.exe`，RT_MANIFEST **requireAdministrator**（本轮构建结果见 §5）

## 2. 本轮完成（2026-11-10，v0.11.0，P8）

### 2.1 审计结论：为什么之前只更新了少数观众

不是数据库或批次丢失，而是**设计把长期记忆建立在“AI 愿意输出画像的观众”上**：

1. 旧 M6 提示词明确写“`viewer_profiles` 只给证据足够的观众；证据不足的观众请省略”，
   并要求“单条发言不足以建立长期兴趣”。
2. 旧 M7 的本地合并只消费导入结果中的 `viewer_profiles`；没有画像的观众不会被建立记忆。
3. 旧 M7 的“记忆更新包”是**第二次 AI 工作流**：用户必须再导出、再交给 AI、再导入、再点合并；
   对普通用户而言很难发现，也没有覆盖状态。
4. 旧包按消息分批；同一观众跨批次时画像会被拆散，且没有“哪些观众未处理”的事实。

因此实际只更新了少数高活跃、被 AI 写了画像的观众。本轮把长期记忆改成**分析结果的一等字段**，
每位可识别观众必须有覆盖条目，缺一条就是导入错误。

### 2.2 一次分析、一次导入

- 同一个 `livememory-analysis-result-v1`（Schema **1.2.0**）同时包含：
  - `session_topics` / `viewer_profiles`：本场报告；
  - `viewer_memory_updates`：每位观众的长期记忆增量。
- 分析包新增 `memory_context.json`（现有画像 + 客观统计）与 `viewer_excerpts.jsonl`
  （本批观众的全部可用发言，最多最近 120 条/人）。
- 导入在**同一个 SQLite 事务**中保存分析结果、证据、客观记忆头、语义事实/版本与覆盖状态；
  分析导入失败会连同记忆一起回滚。

### 2.3 所有可识别观众

- `listSessionViewers` 的全部稳定 ID 都进入 `ai_job_memory_viewers`，无最低发言次数、无活跃度门槛、无 Top N。
- 观众上限 `MAX_ANALYSIS_VIEWERS=20000`；超出时显式报错，不静默截断。
- 没有发言、只有礼物/SC 的观众也会进入记忆批次；AI 返回 `no_new_information`，
  客观互动历史仍由真实记录更新。
- 批次上限 200 人 / 3000 条摘录；观众只分配到一个批次，该批包含其全部可用摘录，跨批次不拆散。
- 批次数量由消息量与观众数共同决定；普通单观众场次保持原有 500/500/200 消息切片行为。

### 2.4 客观历史与语义记忆

- 客观：首次/最近出现、参与场次、累计发言、付费事件、支持、最近场次。全部来自
  `viewers` / `viewer_sessions` / `viewer_broadcasters` / 金额聚合，导入时只确保
  `viewer_memories` 头存在并更新 `last_session_id` / `last_update_at`，不产生语义版本。
- 语义：`interest` / `dislike` / `identity` / `life_event` / `topic` / `preference` /
  `community` / `other`；支持 add / confirm / update / supersede / conflict / outdated / uncertain。
- 只有问候、表情或礼物时允许无语义更新；观众状态为 `no_semantics`，**不是未处理**。
- 已有画像进入 `memory_context`；AI 可以补充/修正/替换同一话题，不要求重新读取全部历史聊天。
- 证据 seq 必须命中本批 `ai_job_memory_messages`，且消息作者必须等于 `viewer_id`；
  他人消息、跨批次、越界 seq、无证据 stated、未知 target_fact_id 全部拒绝。

### 2.5 覆盖状态与预览

- `ai_jobs.memory_viewers_total` + `ai_job_memory_viewers`（pending/semantic/no_semantics/
  objective_only/missing_update/deleted）+ `ai_job_memory_messages`（seq → event → viewer）。
- 导入预览新增：已覆盖/总数、新语义、已处理无新语义、仅客观、缺少更新、记忆操作数。
- 任务状态新增 `memoryCoverage` / `memoryReady`；全部分配观众覆盖后任务才可能 `complete`。
- 旧 1.0/1.1 结果仍可导入：按 `objective_only` 覆盖，不阻断报告。

### 2.6 取消独立长期记忆工作流

- 删除 `src/web/js/pages/memory.js`、`#/memory` 导航与页面；旧书签 `#/memory` 进入 AI 分析中心。
- 保留全部数据库、版本、证据、删除/回滚/人工确认 API 与隐私规则。
- 观众详情长期记忆标签新增**客观互动历史卡**；没有语义事实但有互动时显示
  「互动已记录，暂无语义记忆」，不再伪装成“没有记忆”。
- 旧 M7 `memory_jobs` 表保留，仅用于已有历史数据；不再由 UI 创建新的独立记忆任务。

## 3. 自动化测试（本轮实测）

- 全量：`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`
  → **490 passed / 0 failed**（约 68 秒）。
- 新增 `tests/integration/unified-analysis-memory.test.mjs`：
  - A 同一观众连续五场、每场一句话：5 场互动、累计发言、最近时间、3 条语义事实逐步积累；
  - B 只说“晚上好”：version 0、无事实、覆盖 `no_semantics`，仍算已处理；
  - C 只说“我最近在学习国画”：一条消息生成 `stated` 事实与可验证证据；
  - D 300 位低活跃观众：所有观众进入批次、覆盖 300/300、300 个记忆头；
  - E 300 观众跨 6 批：每位观众只在一个记忆批次、全部摘录随行、乱序导入、重复导入幂等、
    部分覆盖状态正确；
  - 缺少某位观众的更新 → `MEMORY_VIEWER_UPDATE_MISSING` 阻塞导入。
- 既有 M6/M7 全量回归通过；schema/版本断言已更新到 12 / 1.2.0 / m6.2。
- 迁移测试：v1→v12、v7→v12、v9→v12、v10→v12、v11→v12，旧数据不变。

## 4. UI 验证（如实）

- **没有真实浏览器渲染/截图验收**：本机策略仍阻止无头 Edge/Chrome。
- 已覆盖：三语键一致、页面字面 key、独立记忆页已移除/旧链接到 AI、预览字段、客观历史卡、
  无 innerHTML、CSS tokens、窄屏规则（静态测试）；HTTP/端到端行为由 Node 测试覆盖。
- 因此不能声称 AI 预览、观众记忆页、暗色、390px 已在真实浏览器验收。

## 5. 构建结果（本轮实测）

- `node scripts/build-windows.mjs` 成功：`dist/LiveMemory.exe`
  - 大小 **91.1 MB**（95,564,288 bytes），资源 **144 个**，资源哈希 `660cb130f09da0da2d3e`
  - SHA-256 `6b7ca0aaf778d36bfa2dd4e6b491efb9e98350b91cda57728e28e605db10a72e`
  - PE Manifest **requireAdministrator**（脚本断言通过）
- **未能执行验收**：本机应用控制/沙箱策略阻止启动新构建的 EXE；没有运行 `--version` 或打包后的
  schema 11→12 升级实测。

## 6. 未完成 / 未验证

- 真实 AI 返回统一 `viewer_memory_updates` 的样本（包括遗漏/乱序/证据错误的真实表现）；
- 数千观众真实大场的包大小、内存、导入耗时；
- 真实浏览器 UI、截图、暗色、390px；
- 打包 EXE 运行验收与 schema 11→12 真实升级；
- 真实平台礼物/SC-only 观众的长期记忆样本；
- 旧 M7 任务数据在真实用户库中的只读查看；
- M5 可移植备份仍未实现。

## 7. 关键规则（下一轮不要破坏）

1. 一次分析结果同时承担本场报告与长期记忆；不再创建独立记忆 AI 任务。
2. 每位可识别观众必须有且仅有一条 `viewer_memory_updates`；缺失即导入错误。
3. 观众只分配到一个记忆批次，全部可用摘录随行；不得用 Top N 或最低活跃度裁剪。
4. 客观历史只由真实记录更新；AI 不能写金额/计数/时间/身份。
5. 语义事实必须有证据或明确推断/待确认；`stated` 必须有本观众的消息。
6. 无新语义 ≠ 未处理；`pending` 才是未处理。
7. 删除记忆后的旧包不能恢复；重复导入幂等。
8. 三语键三份一致；前端禁止 `innerHTML`；颜色只用 tokens。

## 8. 相关文档

`docs/HANDOFF.md`、`docs/ARCHITECTURE.md`、`docs/DATA_MODEL.md`、`docs/AI_CONTRACT.md`、
`docs/UI_DESIGN.md`、`docs/PRIVACY_SECURITY.md`、`docs/TEST_PLAN.md`、`docs/CHANGELOG.md`、
`docs/ROADMAP.md`、`log/2026-11-10-unified-analysis-memory.md`。

## 9. 下一步

1. 用真实 AI 跑一组统一结果（至少 3 批、含遗漏/错误证据/无新语义），记录实际覆盖率与错误提示。
2. 用 1000–5000 观众的真实/合成大会话测包大小、导入耗时与内存。
3. 在允许浏览器的机器上验收 AI 预览、观众客观历史卡、暗色、390px。
4. 在无策略限制的 Windows 环境启动已构建 EXE，验证 schema 11→12 与打包 UI。
5. 决定是否移除旧 `memory_jobs` 表的创建 API（当前仅保留历史数据，不再暴露 UI）。
