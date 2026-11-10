# 工程状态（STATUS）

最后更新：2026-11-10（M7 长期观众记忆，版本 0.9.0，schema 10）

> 本文件是唯一进度来源。只要代码与本文不一致，以代码与实测为准，并立即修正本文。

## 1. 当前阶段

- 里程碑：**M0 / M1 / M2 核心 / P0–P6 / M6 / M7 核心完成**；Bilibili 生命周期修复完成；M3 真实接入继续验证；M4 部分完成；M5 未完成
- 版本：`0.9.0`（`package.json` 与 `src/shared/app-info.mjs` 一致）
- 数据库 schema：**10**（新增长期观众记忆；v9 原地升级，旧数据不改写）
- 分支：`main`，本地提交，未 Push
- 发布形态：`LiveMemory.exe`，RT_MANIFEST **requireAdministrator**（本轮已构建 v0.9.0，但本机无法执行，见 §5）

## 2. 本轮完成（2026-11-10，v0.9.0，M7）

### 2.1 记忆数据模型（schema 10）

| 表 | 作用 |
| --- | --- |
| `viewer_memories` | 每位「主播 × 观众」一份记忆头：当前版本、摘要、最近更新、删除墓碑 |
| `memory_facts` | 原子记忆条目：`kind`、`topic`、`statement`、`certainty`、`status`、证据计数、来源、有效期、`superseded_by`、`conflicts_with`、`user_verified` |
| `memory_fact_evidence` | 每条事实的来源：场次、批次、`seq`、真实 `event_id`、是否仍可用 |
| `memory_versions` | 仅追加的版本：来源、计数、差异 `diff_json`、完整快照 `snapshot_json` |
| `memory_jobs` / `memory_job_batches` / `memory_job_messages` / `memory_job_viewers` | 记忆更新任务、分批、`seq → event_id` 映射、批次包含的观众与基线版本 |
| `memory_results` | 已应用的 AI 结果（`UNIQUE(job_id, batch_id, checksum)` 保证重复导入不重复应用） |

结构约束：

- 记忆**只按主播隔离**（`UNIQUE(broadcaster_id, viewer_id)`）；同一平台账号在其他主播处拥有完全独立的记忆。
- 一个话题只有一条「存活」事实：`idx_memory_facts_dedupe` 是 `WHERE status <> 'superseded'` 的**部分唯一索引**，因此状态变化（备考 → 考试结束）可以复用话题键，同时保留旧事实。
- 记忆可删除：事实、证据、版本全部删除，只留 `status='deleted'` 的空墓碑；墓碑阻止旧更新包把已删除数据恢复。
- 删除场次会同时删除该场的记忆任务与导出包，并把相关证据标记为不可用；**记忆本身保留**，不会因原聊天消失而静默删除知识。

### 2.2 增量更新（最重要的部分）

两条路径，一条本地规则、一条文件往返，共用同一套合并与版本引擎：

1. **本地合并（不接 AI）**：复用 M6 已导入的单场分析（`viewer_profiles`），一键合并进每位观众的长期记忆。只做新增与确认，不重复、不删除；分析来源标记为 `source_kind='session_result'`，并**一律按推断（inferred）保存**，因为场次分析本身是 AI 解释。
2. **AI 记忆更新包**：导出「现有记忆 + 本场该观众发言 + 严格 Schema + 三语指令」，按观众分批，交给任意 AI，再导入它返回的 JSON。合并引擎逐条应用操作并在预览中显示真实差异。

引擎规则（`src/memory/engine.mjs`，纯函数，预览与写入共用）：

- `add` 命中同一话题 → 变成确认，不产生重复事实；`stated` 可升级 `inferred`，反之永不降级。
- 同一话题的 `interest` 与 `dislike` → 双方标记为**矛盾**，不替主播裁决。
- `supersede` → 旧事实保留为历史（`status=superseded`、`valid_until`、`superseded_by`），新事实为当前状态。
- `conflict` 同键冲突（同 kind + 同 topic）→ 跳过并说明，避免破坏唯一索引。
- `outdated` 只标记，不删除；`uncertain` 存为 `needs_confirmation`。
- 逾期规则：非身份类、非不确定的活跃事实若超过 180 天未被确认，自动标记 `outdated`（原因 `not_recently_confirmed`），**绝不会变成 dislike**。
- 推断没有证据时自动降级为 `uncertain` + 需确认（导入端给出警告）。
- 每次应用都是一个事务：重写事实集合 + 写入版本快照 + 更新记忆头 + 刷新证据状态；失败整体回滚。

### 2.3 AI 记忆更新协议 `livememory-memory-update-v1`

- Schema 版本 **1.0.0**，提示词版本 **`lm-prompt-m7.1-<locale>`**（zh-CN / ja / en 三语完整编写）。
- 包内容：`manifest.json`、`memory_context.json`（现有记忆 + 观众上下文）、`viewer_excerpts.jsonl`（本场该观众发言，`seq` 为本包引用号）、`instructions.md`、`result.schema.json`。
- 分批：按观众切分（默认 20 位/批，硬上限 20；单批消息上限 2000、每位观众最多 120 条），每批记录 `seq → event_id` 映射与每位观众的基线版本。
- 结果操作：`add` / `confirm` / `update` / `supersede` / `conflict` / `outdated` / `uncertain`；`certainty`：`stated` / `inferred` / `uncertain`。
- 导入校验（`src/memory/validate.mjs`）：
  - 8 MB 上限、剥离一层代码围栏、结构深度/节点/字符串防护；
  - 协议、Schema 版本、`job_id`、`batch_id`、`task_id`、`session_id`、`broadcaster_id` 必须与数据库快照一致；
  - `viewer_id` 必须在该批次 `memory_job_viewers` 中；重复 ID 拒绝；**绝不按昵称解析身份**；
  - `target_fact_id` 必须是该观众现有记忆中的事实；
  - 证据 `seq` 必须命中该批次 `seq → event_id`；越界/跨批次拒绝；原文已清理或事件已删除只警告并标记不可用；
  - **`stated` 必须有引用消息**，否则拒绝；无证据的 `inferred` 降级为 `uncertain`；
  - 已删除记忆的旧包（生成时间早于删除时间）→ `MEMORY_DELETED` 拒绝；
  - 内容规范化后 SHA-256：相同内容 → `duplicate`，不写；同批次不同内容 → 需 `createVersion`。
- 应用（`src/memory/importer.mjs`）：一个事务内写 `memory_results` + 每位观众的版本 + 事实；失败整体回滚。

### 2.4 记忆变化、证据与可信度

- 四类区分：`certainty`（观众明确说过 / AI 推断 / 无法确认）与 `status`（当前 / 过时 / 矛盾 / 已替换 / 等待确认）分开保存；`user_verified` 只在主播手动确认后为真。
- 证据可追溯：来源场次、批次、`seq`、真实 `event_id`、时间、是否可验证；报告/档案展开即可看到原消息。
- 原始聊天被清理 → 事实保留，证据状态变为 `purged`（部分 `partial`），UI 明确显示「原文已按保留策略清理」，不再声称可验证。
- 事实级人工操作：确认、标记过时、恢复、忘记单条；每次操作都产生新版本。
- 版本可回滚：恢复旧版本会追加一个新版本，历史不丢；`AI 导入错误` 不会不可逆破坏已积累的记忆。

### 2.5 隐私与数据生命周期

- 按主播隔离：读取、写入、删除、证据解析全部限定在 `broadcaster_id`。
- 删除单个观众的长期记忆：`POST /api/memory/viewers/:id/delete`（必须 `confirm: true`），删除事实/证据/版本并留下墓碑。
- 本地合并**不会复活**已删除的记忆（跳过并计数 `deleted`）；只有删除之后新建的 AI 更新包才能重新建立。
- 清理长期未出现的观众：`POST /api/memory/prune`（默认只预览；`dryRun:false` 才删除），范围 30–3650 天。
- 保留策略写清楚：记忆保留到用户删除；证据跟随平台原文保留窗口；`GET /api/memory/retention` 返回真实计数。
- 原始聊天过期清理、永久删除场次、清空数据、恢复出厂都会正确处理记忆表（清空/删除场次已加入自动化测试）。
- 礼物金额不写入任何记忆字段，提示词明确禁止由金额推断经济能力/人格/忠诚度。

### 2.6 界面

- 新增导航 **长期记忆**（`#/memory`），四步：选择直播 → 合并本场分析（无 AI） → 生成 AI 更新包 → 导入并预览 → 应用；附最近更新任务、最近更新的观众、保留与清理。
- 观众档案改为标签页：**概览 / 长期记忆 / 互动历史 / 历史版本**。
  - 长期记忆：一句话摘要、版本/时间/证据统计、待确认 / 矛盾 / 确认 / AI 推断 / 可能过时 / 过去状态分组；每条事实显示来源、证据（可展开）、有效期、操作按钮。
  - 历史版本：版本列表、变化数量、差异详情、恢复按钮。
  - 概览：长期记忆摘要卡 + 入口，替换原先的「兴趣（尚未提供）」占位。
- 全部文案三语；明暗主题；≤760px 事实卡与标签自适应；不使用 `innerHTML`；颜色只用 tokens。
- 新增截图脚本 `scripts/verify-memory-ui.mjs` 与演示数据脚本 `scripts/demo-memory.mjs`（本轮未能实际运行浏览器，见 §6）。

## 3. 自动化测试（本轮实测）

- 全量：`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`
  → **450 passed / 0 failed**（含本轮新增 64 项；单进程模式，约 70–75 秒）。
- 本轮新增：
  - `tests/unit/memory-model.test.mjs`：话题归一化、去重键、证据去重、差异、过时规则、分组。
  - `tests/unit/memory-engine.test.mjs`：新增/确认/升级/降级、兴趣-反感矛盾、状态替换、过时、未知目标、同键冲突、人工确认/忽略/忘记/拒绝复活已替换事实。
  - `tests/unit/memory-ui.test.mjs`：三语键存在性（扫描页面里所有字面 key）、分组/状态/类型标签、禁止 innerHTML、页面注册与导航图标、Schema 常量一致、三语提示词内容、CSS 用 tokens 且无硬编码颜色。
  - `tests/integration/memory-local-merge.test.mjs`：首次画像、第二场增量、三场连续、重复合幂等、兴趣变化标记过时、主播隔离、无分析/无主播报错。
  - `tests/integration/memory-ai-workflow.test.mjs`：包结构、导入新增并解析证据、重复导入、需新版本、乱序批次、缺失批次、未知观众、stated 无证据拒绝、inferred 无证据降级、坏 JSON/旧版本/错误协议、越界 seq 与跨批次、跨场 supersede、矛盾保留、中日英原文保存。
  - `tests/integration/memory-privacy.test.mjs`：删除记忆与墓碑阻断旧包、删除后新包可重建、本地合并不复活、主播隔离删除、原文清理降级、删除场次清理包与证据、过期清理预览/执行、清空数据覆盖全部记忆表。
  - `tests/integration/memory-migration.test.mjs`：真实 v9→v10 升级、旧行不变、部分唯一索引存在、重复迁移无操作、新库直接 v10。
  - `tests/integration/memory-api.test.mjs`：HTTP 全流程（状态/总览、无分析报错、预览与应用、人工确认、回滚、任务创建/下载/指令、导入预览/导入/重复、错误 JSON、清理预览、删除确认与结果）。
- 既有测试更新：schema 9→10（`ai-api`、`ai-migration`、`broadcaster-identity`、`migration-emotes`、`platform-status-migration`、`history-management`）与版本号 0.9.0（`api`、`verify-exe-ai`）。

## 4. UI 验证（实际结果，必须如实阅读）

- 已编写 `scripts/verify-memory-ui.mjs`：真实 SQLite 种子数据 + 无头 Edge/Chrome，经 DevTools 协议检查步骤卡、批次下载、合并预览变化行、观众记忆分组与证据、版本差异、暗色主题、390px 无横向溢出、页面无渲染异常；`--shots` 会输出截图。
- **本轮未能在本机实际跑通浏览器验证**：以 `--headless=new` 或 `--headless` 启动 Edge/Chrome 会被本机应用控制策略终止
  （Edge 退出码 `-2147483645` / `0x80000003`），Chrome 退出码 `-36863`；因此没有新的真实截图，
  **不能声称 M7 界面已在真实浏览器中验收通过**。UI 目前只有静态/单元检查与 HTTP 集成测试覆盖。
- 需要在策略允许的桌面环境执行一次：
  `node scripts/demo-memory.mjs --seconds 0`，另开无头浏览器（`--remote-debugging-port=9231`），
  然后 `node scripts/verify-memory-ui.mjs --base http://127.0.0.1:49420 --debug-port 9231 --no-launch --shots`。

## 5. 构建结果（本轮实测）

- `node scripts/build-windows.mjs` 成功：`dist/LiveMemory.exe`
  - 大小 **91.0 MB**，资源 **134 个**（含 `src/memory/schemas/memory-update-result-v1.schema.json`），资源哈希 `7065a6aeb722e53b64bb`
  - SHA-256 `576a6d124f0b0c48fa4189811b5e755bb16ad0894671723fe5a33490ab198104`
  - PE Manifest **requireAdministrator**（脚本断言通过）
- **未能执行验收**：把 EXE 复制为 asInvoker 后运行 `--version` / `--help` 在本机被拒绝（`EPERM`，
  沙箱/应用控制策略阻止启动新构建的可执行文件）。因此**不能声称 v0.9.0 EXE 已在本机启动验收**，
  也不能声称打包后的 schema 9→10 升级已实测。源码层的 v9→v10 迁移已有自动化测试覆盖。
- 上一轮的 Device Guard 限制仍然存在；最终验收需要无该策略的 Windows 环境或签名/允许列表。

## 6. 未完成 / 未验证

- **真实浏览器渲染与截图**：本机策略阻止无头浏览器启动（见 §4），需要在其他机器复验。
- **打包 EXE 运行验收**：已构建（§5），但本机无法启动；Manifest/版本升级的打包实测留待下一轮。
- **真实 AI 服务端到端**：M6 与本轮 M7 只验证「符合 Schema 的合成结果」与真实导出包结构，未接真实 AI 服务。
- **真实多语言/长文本 AI 输出**：只覆盖中/日/英短句与固定样本。
- **跨主播身份关联**：有意不做；同一平台账号在不同主播处始终是两份独立记忆，界面不提供合并。
- **M5 可移植备份**：仍未实现；记忆表已加入清空数据范围，但备份格式（`.livememory`）不在本轮。
- **长期性能**：记忆事实量按人计（数十条/人）；未做大观众量（>10 万）基准。

## 7. 关键规则（下一轮不要破坏）

1. 记忆**只能**按 `broadcaster × viewer` 存；不得把 lifetime 或其他主播数据写进本主播记忆。
2. AI 输出永远不能把 `inferred` 升级为 `stated`；`stated` 必须有引用消息。
3. 任何应用都是事务 + 新版本；不允许原地覆盖或删除历史版本（只有用户删除记忆时整体删除）。
4. 重复导入相同内容 → 不写入；删除记忆后旧包 → 拒绝。
5. 原始聊天被清理/场次被删除 → 只降级证据，不删除记忆，也不伪造证据。
6. 本地合并只做新增/确认，不复活已删除记忆，不把「不再提及」写成「不再喜欢」。
7. 前端只用 `textContent`；三语键必须三份一致（测试会失败）。
8. 本轮的 schema 10 迁移是原地升级，旧库 v9 直接可用，不得重写历史行。

## 8. 相关文档

`docs/HANDOFF.md`、`docs/ARCHITECTURE.md`、`docs/DATA_MODEL.md`、`docs/AI_CONTRACT.md`、
`docs/PRIVACY_SECURITY.md`、`docs/UI_DESIGN.md`、`docs/TEST_PLAN.md`、`docs/CHANGELOG.md`、
`docs/ROADMAP.md`、`log/2026-11-10-long-term-memory.md`。

## 9. 下一步

1. 在允许浏览器的机器上运行 `scripts/verify-memory-ui.mjs --shots`，补真实截图并复核 390px/暗色。
2. 在无策略限制的环境运行已构建的 `dist/LiveMemory.exe`（含 asInvoker 临时副本），验证启动、schema 9→10 升级与打包 UI。
3. 用真实 AI 服务做一次记忆更新包往返（含多批、乱序、缺批），记录实际结果。
4. 大观众量（1 万+）下的记忆列表/合并性能测试，必要时增加分页与索引。
