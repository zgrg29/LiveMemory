# LiveMemory RC0 最终综合验收与发布阻断项审计

日期：2026-11-14（Asia/Shanghai）
范围：RC0 最终验收；长期记忆原则性正确性、完整产品流程、安全与数据完整性、全量测试、正式 EXE。
结论一句话：**工程与数据完整性基础通过，两个数据正确性缺陷已修复；长期画像语义质量仍未达标，建议只进入 RC0 小范围闭源内测，不建议公开发布。**

> 执行边界：本轮**未调用任何真实付费 Provider**、**未发送真实观众聊天到第三方**、**未修改生产数据库**、**未 Push/Tag/发布**。
> 真实平台采集使用公开只读接口（Bilibili 公开直播接口、YouTube 公开网页聊天），数据目录全部在 `tests/.tmp`。
> 归档真实结果只读重评；所有新测试使用合成数据、Mock/本地假 Provider 或隔离目录。

---

## 1. RC0 总体结论

| 验收面 | 结论 | 依据 |
| --- | --- | --- |
| 数据损坏 / 不可恢复失败 | 通过 | 事务化导入、版本快照、备份恢复回滚、819 项测试 |
| 观众身份串联 | 主路径通过；旧导入路径缺口已修复 | 稳定 ID、跨观众证据拒绝、同名不同 ID 测试 |
| 事实错误覆盖 / 污染 | 发现并修复 1 个 P0（无证据提升为 stated）；另有 1 个 P1（同 topic 合并） | 见 §2、§3、§4 |
| 未授权读取 / 修改 | 通过 | 12/12 认证矩阵；未认证读写/SSE 均 401 |
| 基本采集 / 分析 / 保存 / 恢复 | 通过 | Bilibili 真实采集、YouTube 真实采集、EXE AI/Resume、备份恢复矩阵 |
| 重复付费请求 | 通过 | Resume 只重发失败批次；重复 Continue 0 请求 |
| 真实 EXE 启动 | 通过 | asInvoker、10/10 EXE 矩阵、真实 Chrome 打开控制台 |
| 长期事实语义质量 | **未达标、未关闭** | 严格召回 15.1%–29.5%，25.0%–31.1% stated 事实缺少引用支持 |

**发布判断**：RC0 内测可以开始；公开发布/商店发布应等到 P1 的同 topic 语义冲突与证据支持问题有明确修复或产品级提示。

---

## 2. P0 / P1 / P2 清单

### 2.1 P0：必须修复（本轮已修复并回归）

| ID | 问题 | 影响 | 修复 | 回归 |
| --- | --- | --- | --- | --- |
| P0-A | `confirm` 带 `certainty: stated` 但**没有任何 evidence** 时，本地校验接受，engine 把 `inferred` 事实提升为 `stated` | 没有证据的推断被保存成确定事实；违反 A 的核心规则；可确定性复现 | `src/memory/validate.mjs`、`src/memory/embedded.mjs` 跳过该 confirm；`src/memory/engine.mjs` 要求 evidence 才允许提升/激活；无证据的匹配 add 也跳过 | `memory-engine.test.mjs` 2 项、`memory-ai-workflow.test.mjs` 1 项、`unified-analysis-memory.test.mjs` 1 项 |
| P0-B | 旧 `POST /api/memory/import` 路径（`validateMemoryImport`）只用 batch 内 seq 校验证据，未比较 `events.viewer_id`，同一 batch 内可把观众 B 的消息挂到观众 A 的事实上 | 错误归属/观众身份串联；该路径需已认证 Cookie 且当前 UI 未暴露，但仍是数据污染入口 | `validate.mjs` 增加 `MEMORY_EVIDENCE_OTHER_VIEWER`；同一 batch 内跨观众证据直接拒绝整份答案 | `memory-ai-workflow.test.mjs` 新增 1 项 |

**P0-A 复现（修复前）**：
1. 第一场直播导入 `add`，`certainty: inferred`，有 1 条弱证据；
2. 第二场直播导入 `confirm`，`target_fact_id` 指向该事实，`certainty: stated`，**无 evidence**；
3. 修复前：该事实 `certainty = stated`、`status = active`、`evidenceCount` 仍为 1；
4. 修复后：confirm 被跳过并产生 `MEMORY_EVIDENCE_REQUIRED` 警告，事实保持 `inferred`，不创建新版本。
   验证命令：`node tests/.tmp/audit-confirm-no-evidence.mjs`（本轮临时复现脚本，未提交）。

**P0-B 复现（修复前）**：
同一 batch 内含观众 A、B；A 的 `add` 引用 B 的 `seq`；旧校验只确认 seq 存在，事实会带着 B 的原文写入 A。修复后返回 `MEMORY_EVIDENCE_OTHER_VIEWER`，整份答案不写入。
（主 v1.3 分析路径原本已有 `mapping.viewerId === viewerId` 检查；本次补的是旧 memory-only 导入路径。）

### 2.2 P1：建议修复但可评估发布

| ID | 问题 | 现状 / 影响 | 建议 |
| --- | --- | --- | --- |
| P1-A | 同一 `kind + topic`、不同 `statement` 的 `add` 被静默 `confirm`，旧 statement 保留，新 statement 丢弃，新证据挂到旧事实 | 明确可复现：旧“在便利店打工” + 新“已经在医院工作” → 仍显示“在便利店打工”，并引用新消息；否认“不再喜欢猫了”会确认“喜欢猫”。属于“语义冲突推理未实现”，不是本轮 P0；版本快照与人工 dismiss/rollback 可恢复 | 在 `add` 命中已有 topic 时要求 statement 等价，否则跳过并提示 `update/supersede/conflict`；或引入人工复核队列。会触及“one live fact/topic”不变量，需单独设计 |
| P1-B | 25.0%–31.1% 的 `stated` 事实语义不匹配或引用原文不支持 | 归档真实 DeepSeek 结果：7/28、13/47、19/61、9/35；例：观众 2“刚搬到大阪，还在找好吃的拉面”引用“最近在学做菜，失败了三次” | 优先做“引用原文支持”校验/定向补答或人工复核，而不是继续加批次或加提示词篇幅 |
| P1-C | 临时信息被写成长期事实 | 归档中“当天过生日”“今天下班晚”“这周作业交完”等作为 active `life_event` 保存；180 天后才会 `outdated` | 在提示词/校验层区分 temporary；或为 `life_event` 增加可配置 TTL；不要自动删除 |
| P1-D | `summary`（画像摘要）没有证据级校验 | `summary_certainty` 可为 stated；摘要是 AI 汇总，不是原子事实 | UI 明确标注“AI 摘要”，或只允许 inferred/uncertain；不要把它当事实引用 |

### 2.3 P2：可以延期

1. 严格召回率、重要事实召回率继续提升；5/10/20 人真实语义批次；其他 Provider 真实付费验收。
2. `scripts/verify-memory-ui.mjs` 是 v0.10 时代脚本：`/memory` 独立工作区已在 v0.11.0 移除（`/memory` 现在路由到 AI 页），且 fixture 把矛盾事实放在 VIEWER_B 却检查 VIEWER_A；本轮 15/21，其中 6 项为脚本陈旧，不是产品失败。建议重写该脚本或删除历史断言。
3. `efficiency.factQuality` 目前 API 可见，但 AI 分析中心未突出展示；建议把 stated/inferred/uncertain 与“待确认”数量放到任务卡。
4. 同 topic 不同 statement 的复杂语义冲突、跨语言同义、反讽/否定识别。
5. 更高级的数据可视化、批次策略、Token 进一步优化。
6. 旧 `memory_job_messages` 表没有 `viewer_id`；本轮已用 `events.viewer_id` 补校验，若未来要支持消息删除后仍可校验，需 schema 变更。

---

## 3. 长期事实证据审计

### 3.1 实际语义与保存规则（源码为准）

| 概念 | 代码规则 | 结论 |
| --- | --- | --- |
| `stated` | 只有 `add/update/supersede/conflict` 带**至少一条 evidence** 才允许；`confirm + stated` 现在也必须有 evidence，否则跳过 | 没有证据的 stated 写入被阻断 |
| `inferred` | 可无 evidence，但 validator 会降级为 `uncertain`；不会被提升为 stated，除非后续 `confirm/add` 带 evidence | 推断不会被保存成确定事实 |
| `uncertain` | 保存为 `needs_confirmation`，不计入 active stated；无新证据不会自动激活 | 无证据不自动 confirmed |
| 证据归属 | 主路径：`ai_job_memory_messages.viewer_id` 必须等于操作观众；旧路径：`events.viewer_id` 必须等于操作观众；均拒绝跨观众 | 归档 4 次真实运行跨观众证据 = 0 |
| 证据可用性 | 消息被删除/原文被保留策略清理时，`evidence_status` 变为 `partial/purged/unavailable`，事实保留并明确显示不可复核 | 不是“静默删除” |
| 临时信息 | 没有按 kind 的 TTL；只有 180 天未确认 → `outdated` | 仍有 P1-C；模型应自行省略，但本地不强制 |

### 3.2 归档真实结果（只读重评）

数据：`tests/.tmp/paid-p03`（上一轮用户授权的 DeepSeek `deepseek-flash`），本轮未产生新费用。评分：`scripts/memory-quality-eval.mjs p03`，输出 `tests/.tmp/p03-quality-final.json`。

| 运行 | 行数 | stated | inferred | uncertain | 正确 stated | 严格召回 | 重要召回 | 准确率 | 错误 stated | 误收（n/率） | 跨观众 | 重复 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 第 1 次 cap10 | 67 | 28 | 2 | 37 | 21 | 15.1% | 7.7% | 75.0% | 7 (25.0%) | 12 / 17.9% | 0 | 0 |
| 第 1 次 cap20 | 49 | 47 | 2 | 0 | 34 | 24.5% | 23.1% | 72.3% | 13 (27.7%) | 6 / 12.2% | 0 | 0 |
| 第 2 次 cap10 | 74 | 61 | 2 | 11 | 42 | 29.5% | 19.2% | 68.9% | 19 (31.1%) | 6 / 8.1% | 0 | 0 |
| 第 2 次 cap20 | 38 | 35 | 3 | 0 | 26 | 18.0% | 19.2% | 74.3% | 9 (25.7%) | 5 / 13.2% | 0 | 0 |

- “错误 stated”按“语义不匹配或引用原文不支持”计，包含跨观众语义污染、把他人/主播/临时信息归到本人；本地 Schema 只能证明 seq 存在且属于该观众，**不能证明这句话支持这个结论**。
- “误收”指引用了显式 `shouldPersist=false` 消息的事实，可大于“错误 stated”（含 uncertain）。
- 跨观众证据在 4 次运行中均为 0；重复率均为 0（kind+topic 去重生效）。

### 3.3 人工抽查（可复核）

从 cap10 归档中抽取，证据原文来自 `tests/.tmp/rc0-archive-a.txt`：

| 观众 / 事实 | 引用原文 | 判定 |
| --- | --- | --- |
| Viewer 0：在东京留学，时差有点难受 | “在东京留学，时差有点难受” | **合理、有直接证据** |
| Viewer 1：工作压力大，听直播放松 | “工作压力大，听直播放松” | **合理、有直接证据** |
| Viewer 2：刚搬到大阪，还在找好吃的拉面 | “最近在学做菜，失败了三次” | **明确错误**：证据不支持结论 |
| Viewer 15：最近在学做菜，已经失败三次 | “最近在学做菜，失败了三次” | **合理、有直接证据** |
| Viewer 15：在画画，目前卡在配色上 | “画画卡在配色上” | **合理、有直接证据** |
| Viewer 0：在聊天中问有没有人一起打游戏，似乎有联机游戏兴趣 | “有没有人一起打游戏” | **合理语义归纳**，且标记 `inferred`，不是 stated |
| Viewer 0：当天过生日 | “今天生日，来许个愿” | **合理但不该长期保存**：临时信息被写成 active `life_event`（P1-C） |
| Viewer 10：询问适合新手的键盘……证据不足 | “明天要早起，先睡了” + “推荐一下适合新手的键盘” | **证据不足**：事实是 uncertain，但证据列表含无关消息（P1-B） |

**分类结论**：
- 明确错误：至少 1 例（搬家/做菜）；按严格口径 25.0%–31.1% stated 事实属于此类或类似。
- 证据不足：多例 uncertain 事实附带无关消息。
- 合理语义归纳：如“似乎有联机游戏兴趣”，且正确标记为 inferred。
- 评分器过于严格：少数“生日/下班晚”事实本身有原文支持，但作为长期画像不合适；这是保存策略问题，不是评分器错误。
- 无法确定：合成语料重复模板导致“同一句话反复出现”，无法判断是否本人真实经历；归档中模型已用 uncertain 处理，属于合理保守。

**结论**：证据归属（是不是这个观众）在归档中是正确的；证据支持（这句话是否支持这个结论）仍不足。不能仅用自动评分百分比决定发布；本轮 P0 只针对“无证据提升为确定事实”的确定性缺陷。

---

## 4. 历史事实合并与冲突处理

### 4.1 九个确定性场景

| # | 场景 | 当前行为 | 判定 |
| --- | --- | --- | --- |
| 1 | 同一事实再次确认（同 kind/topic/statement，带证据） | 命中同一 live fact，`lastConfirmedAt` 更新，证据合并，不新增行 | ✅ 通过 |
| 2 | 新事实补充旧事实（不同 topic） | 新增一行，旧事实保留 | ✅ 通过 |
| 3 | 观众改变偏好（AI 使用 `supersede`） | 旧事实 `superseded` + `supersededBy`，新事实 active，历史保留 | ✅ 通过 |
| 4 | 观众明确否认旧事实（AI 使用 `supersede` / `conflict`） | `supersede` 保留历史；`conflict` 双方 `conflicted`，等待人工判断 | ✅ 通过（当 AI 用对 op） |
| 5 | 旧事实过时（`outdated` 或 180 天规则） | 状态 `outdated`，不删除；再次有证据确认可恢复 active | ✅ 通过 |
| 6 | 两条相关但不同的事实（不同 topic） | 两行独立保存 | ✅ 通过 |
| 7 | 观众昵称变化 | 稳定 ID 不变；`viewer_nicknames` 记录历史；昵称不是主键 | ✅ 通过 |
| 8 | 两位观众昵称相同 | 稳定 ID 不同；不合并；`memory-quality-gold` 断言 | ✅ 通过 |
| 9 | AI 输出互相矛盾的事实 | `interest` vs `dislike` 同 topic → conflict；同 kind 不同 statement → 目前静默 confirm | ⚠️ 部分通过（P1-A） |

### 4.2 关键结论

- **不同 topic 不会被无条件覆盖或合并**：`unique (memory_id, dedupe_key)` 只约束 live fact；`supersede` 让旧行退出唯一索引并保留历史。
- **同一 `kind+topic` 不同 statement 仍会被无条件 confirm**：这是系统当前最明确的语义缺口。`memory-engine.test.mjs` 第 46–70 行仍显式断言“同 topic 不新增第二行”，说明这是有意的不变量，不是本轮引入的回归。
- 该缺口不是本轮 P0，原因是：修复需要区分“同一事实的改写”与“不同事实/否认”，属于任务中明确允许延期的“复杂语义冲突推理”；所有版本都有完整快照，人工可 rollback/dismiss/forget。**但它确实会产生错误的当前陈述，P1-A 必须在公开发布前处理。**
- **确定性复现（保留为 P1 证据）**：
  - 旧“在便利店打工” + `add` “已经在医院工作” → `status: confirmed`，statement 仍为“在便利店打工”，evidence 含两条；
  - 旧“喜欢猫” + `add` “不再喜欢猫了” → statement 仍为“喜欢猫”，evidence 含否认消息；
  - 无任何 warning 进入 UI。临时脚本：`tests/.tmp/audit-same-topic.mjs`（未提交）。

---

## 5. 跨场次累积验证

| 验证点 | 结果 | 证据 |
| --- | --- | --- |
| 新事实能够增加 | 通过 | `unified-analysis-memory` A：5 场单消息直播，memory version ≥3，事实逐步增加 |
| 已确认事实能够保留 | 通过 | 同测试；`memory-local-merge` 三场累积，version 3，facts 3 |
| 新证据能够强化旧事实 | 通过（有证据时） | `add`/`confirm` 合并 evidence；`lastConfirmedAt` 更新 |
| 重复内容不会无限增加 | 通过 | `unique (memory_id, dedupe_key)`；重复 add → confirm；重复 import → duplicate；版本只保留 20 条 |
| 同一观众身份持续关联 | 通过 | `platform:stable_uid`；昵称变化不改 ID；同名不同 ID 不合并 |
| 未被本场提及的历史事实不会无故删除 | 通过 | `applyOperations` 从现有 facts 出发；只有 180 天未确认才 `outdated`，从不删除 |
| AI 分析失败不破坏已有长期记忆 | 通过 | `importAnalysisResult` 单事务；失败批次不影响兄弟批次；Resume 只补失败批次 |
| Resume 不重复写入 | 通过 | `memory_versions.source_key` + result checksum；EXE 16/16 中“重复 Continue 0 请求”“只重发失败批次” |
| 跨 broadcaster 隔离 | 通过 | `memory-local-merge` 同名观众两个频道，两套独立 facts |
| 删除后不被旧包复活 | 通过 | tombstone + `deleted_at` 与 job `createdAt` 比较；`memory-privacy` 测试 |

补充：
- **200 天未确认**：旧兴趣变 `outdated`，新兴趣 active，旧事实保留（`memory-local-merge` 测试）。
- **Resume/补答**：`ai-memory-reliability`、`ai-memory-supplement-regression` 与 EXE `verify-ai-token-exe` 覆盖；本轮全量通过。
- **AI 输出失败**：`verify-ai-token-exe` 注入 batch 2 失败 → 兄弟 batch 保存 → Resume 只请求 batch 2 → 完成后不再请求。

---

## 6. 完整产品流程验证

| # | 流程 | 方式 | 结果 |
| --- | --- | --- | --- |
| 1 | 普通用户双击启动 | 正式 EXE（脚本启动，当前用户令牌） | ✅ 10/10；无 UAC 提权；`asInvoker` |
| 2 | 无管理员权限要求 | PE manifest + EXE 矩阵 | ✅ `asInvoker` |
| 3 | 浏览器打开与认证 | 正式 EXE + 真实 Chrome（CDP，外部启动） | ✅ fragment token → `authenticated: true`；token 从地址栏清除；`#/live` 正常；无页面异常 |
| 4 | Bilibili 采集 | **真实公开接口**，房间 5050，30s | ✅ 9 条 chat / 4 位观众 / 0 支付；正常停止，session ended |
| 5 | YouTube 采集 | **真实公开网页**，Sky News 直播 `LXQz2kkE-C0`，20s | ✅ 8 条 chat / 8 条有 channel id / 7 位 active viewer；正常停止 |
| 6 | 直播结束与网络重连 | 正式 EXE + 本地假 YouTube，模拟 181s 断网 | ✅ 同一 session；重连后继续；重放去重；`platform_ended` 才结束 |
| 7 | 场次数据保存 | Bilibili/YouTube/EXE 测试 + SQLite 读回 | ✅ 场次、消息、观众、统计可读回 |
| 8 | AI Provider 配置 | Mock Provider（本地 HTTP）；真实 Key 录入未重复 | ✅ Mock 配置/请求；真实 DeepSeek 为上一轮归档 L3，本轮无新付费调用 |
| 9 | 单场 AI 报告 | 全量集成测试 + EXE AI/Token 矩阵 | ✅ Schema 1.3.0 报告/翻译/聚合测试通过；EXE 侧以长期画像与 Token/Resume 为主 |
| 10 | 长期观众画像 | EXE `verify-ai-token-exe` + 真实 Chrome viewer tab | ✅ facts/evidence/versions；见 §8/§9 |
| 11 | 失败、补答、Resume | 自动化 + EXE | ✅ 失败批次保留、补答合并、Resume 只补缺失、0 重复请求 |
| 12 | Token 与费用统计 | 正式 EXE + Mock provider usage | ✅ provider-reported / cache-hit / failed attempts / 估算费用；16/16 |
| 13 | 数据备份 | 正式 EXE | ✅ 13/13，备份包含 sessions/chat/memory/AI，排除 secrets |
| 14 | 数据恢复 | 正式 EXE 全新目录 + 重启 | ✅ 13/13；恢复后可读、可重启、可再次备份 |
| 15 | 程序退出 | 正式 EXE | ✅ HTTP listener 关闭、进程退出、runtime 清理 |
| 16 | 重启后数据恢复 | 正式 EXE | ✅ 10/10、12/12、13/13、16/16 均含重启/持久化断言 |

**边界说明**：
- #4/#5 是真实平台公开数据，不是 Mock；#6 是本地假 YouTube（3 分钟断网无法用真实平台稳定复现）。
- #8/#9 的 AI 是本地 Mock Provider；**不是**真实付费 Provider 验收。
- #3 是真实 Chrome，但由外部进程启动；不是“用户手动双击默认浏览器”的完整人工操作。
- #1 是当前用户权限下的脚本启动；不是干净 Windows 账户上的人工双击。

---

## 7. 安全与数据完整性

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 未认证 API 访问 | 通过 | 除 health/auth 外全部 401；`verify-p0-5-exe` 12/12 |
| SSE 认证 | 通过 | 未认证 SSE 401；认证后可建立 |
| 伪造 Origin / Host / Sec-Fetch-Site | 通过 | 403；`p0-5` 矩阵 |
| Provider Key 保护 | 通过 | 加密凭据库；不进 config JSON / 日志 / ZIP / DB 导出 / HTML |
| 本地数据目录权限 | 通过 | 默认 `%LOCALAPPDATA%`；不可写目录明确报错并退出 1（EXE 矩阵） |
| 备份凭据排除 | 通过 | 备份只含 DB + 白名单 settings；`secrets/`、`config/ai-providers.json`、logs、cache、exports、runtime 排除 |
| 恢复失败回滚 | 通过 | journal + previous DB + rollback；崩溃恢复测试 |
| 数据库 WAL 一致性 | 通过 | 备份用 `VACUUM INTO`；关闭时 `wal_checkpoint(TRUNCATE)`；恢复前关闭连接 |
| Windows asInvoker | 通过 | 最终 EXE `manifestLevel = asInvoker`；构建脚本断言 |
| 路径穿越 | 通过 | ZIP Slip/绝对路径/空 entry/超限拒绝；静态文件 root 前缀校验 |
| 旧版本数据兼容 | 通过 | schema 16 迁移；备份 schema 升级；旧包/旧结果版本校验 |
| 30 天保留 | 通过 | YouTube 原文/昵称清理测试；计数与稳定 ID 保留 |
| 备份恢复后凭据 | 通过 | 恢复安装 `secrets/` 为空；需重新连接 Bilibili/AI |

**本轮修复的两个安全/完整性点**：
1. 无证据 `confirm+stated` 提升（P0-A）——数据正确性；
2. 旧导入路径跨观众证据（P0-B）——错误归属。

未发现新的未授权读取、密钥泄露、路径穿越或不可恢复备份缺陷。

---

## 8. 全量测试结果

- 命令：`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`
- 结果：**819 passed / 0 failed / 0 skipped / 0 cancelled / 0 todo**（2026-11-14，397,114.9 ms）
- 测试文件：80 个 unit + 59 个 integration（`tests/unit/*.test.mjs`、`tests/integration/*.test.mjs`）
- 本轮新增 **5** 项测试（对应 2 个 P0）：
  1. `memory-engine.test.mjs`：confirm 无证据不得把 inferred 提升为 stated；
  2. `memory-engine.test.mjs`：无证据的匹配 add 不得提升/激活；
  3. `memory-ai-workflow.test.mjs`：stated confirm 无证据被跳过，不创建版本；
  4. `unified-analysis-memory.test.mjs`：嵌入分析中的 stated confirm 无证据不得提升；
  5. `memory-ai-workflow.test.mjs`：同一 batch 内跨观众证据被拒绝，0 写入。
- 既有断言未放宽；未修改测试以掩盖缺陷。
- 全量日志：`tests/.tmp/.full-rc0-final-audit-4.log`。

**专项/脚本矩阵（本轮实跑）**：

| 矩阵 | 结果 | 性质 |
| --- | --- | --- |
| `scripts/verify-exe.mjs` | 10/10 | 正式 EXE：asInvoker、全新目录、重启、硬杀恢复、端口顺延、单实例、不可写目录、异目录、解压复用、CLI 三语 |
| `scripts/verify-p0-5-exe.mjs` | 12/12 | 正式 EXE：未认证读写/SSE 401、伪造 Origin/Host 403、fragment→Cookie、重启旧凭据失效 |
| `scripts/verify-p0-2-exe.mjs` | 13/13 | 正式 EXE：备份 → 独立校验 → 全新目录恢复 → 重启 → 再次备份 |
| `scripts/verify-ai-token-exe.mjs` | 16/16 | 正式 EXE + 本地 Mock Provider：长期画像、Token/费用、失败归因、Resume、0 重复请求、备份 |
| `scripts/verify-youtube-lifecycle-exe.mjs` | PASS | 正式 EXE + 本地假 YouTube：181s 断网 → 同 session 恢复 → 重放去重 → `platform_ended` |
| `scripts/verify-bilibili.mjs 5050 30` | PASS | **真实 Bilibili**：9 chat / 4 viewers / ended |
| `scripts/verify-youtube-anonymous.mjs <SkyNews> 20` | PASS | **真实 YouTube**：8 chat / 8 channel id / 7 active / ended |
| `scripts/verify-memory-ui.mjs`（历史脚本） | 15/21 | 真实 Chrome；6 项失败为 v0.10 脚本陈旧（`/memory` 已移除、矛盾事实在 VIEWER_B 却检查 VIEWER_A），不是产品失败；当前 viewer 画像检查通过 |
| 自定义 EXE + 真实 Chrome | 通过 | fragment→Cookie `authenticated: true`；`#/live`、`#/viewers`、`#/ai` 均无页面异常；无障碍/异常；脚本退出码 0 |

---

## 9. 正式 EXE 结果

| 项目 | 值 |
| --- | --- |
| 文件 | `dist/LiveMemory.exe` |
| 大小 | `96,668,160` bytes（92.19 MiB） |
| SHA-256 | `861eeaef3fd647732436809aedfa655da69db0d1ce1c11bbb76d8769972ff447` |
| buildId | `7016d4295d0e` |
| source hash | `7016d4295d0e9af3b45bca411d321c6bd05e19a9bbd9a555edba0f23ecdbbbdb` |
| build commit | `996f99266b9159efb8ff8c7186163061adc73fed`（构建时 HEAD） |
| builtAt | `2026-11-14T13:27:13.373Z` |
| 资源 | `191` files；20 个必需模块；asset hash `7016d4295d0e9af3b45b` |
| RT_MANIFEST | `asInvoker` |
| 数据库 schema | 16 |
| 结果 Schema | 1.3.0 |
| 提示词 | v13.2 |

- 构建脚本显式断言最终 EXE 含 buildId、20 个必需模块、`restore-journal.json` 标记，且 manifest 为 `asInvoker`。
- EXE 矩阵全部针对上述最终二进制；真实 Chrome 测试使用同一 `dist/LiveMemory.exe`。
- 构建在代码提交之后完成，因此 `build-info.commit` 是代码提交 `996f992`；文档收尾提交在此之后，不改变 buildId（buildId 只由 `src` 内容哈希决定）。

---

## 10. 尚未完成的真实用户操作

1. **干净 Windows 账户上的人工双击 + UAC 观察**：本轮用当前用户令牌启动，manifest 为 asInvoker；未在全新账户/全新机器上人工双击。
2. **真实付费 Provider 的新调用**：本轮未获付费授权，未调用 OpenAI/Anthropic/DeepSeek/DashScope/OpenRouter/MiniMax/自定义；DeepSeek 的真实结果来自上一轮归档。
3. **真实 Key 在 UI 中重新录入**：上一轮已做；本轮用 Mock Provider 与归档配置。
4. **真实浏览器默认打开**：本轮用外部启动的 Chrome + CDP；没有验证“启动器调用系统默认浏览器”的人工体验。
5. **真实长时段直播/多天长期记忆**：Bilibili 30s、YouTube 20s；没有连续多天真实观众语料。
6. **真实平台长断网/429/5xx**：YouTube 断网用本地假服务复现 181s；没有对真实 YouTube 做长断网。
7. **真实账单核对 / 取消请求计费**：只有 Token × 单价估算；没有官方账单。
8. **5 人批次真实语义**：仍只有结构数据；没有新的付费 5/10/20 A/B。
9. **原生文件选择器**：备份/恢复/迁移走 API 与测试路径；没有在真实桌面点击原生对话框。
10. **Bilibili 登录态全功能**：本轮匿名公开采集；登录后打码/uid 行为未重新验收。

---

## 11. 已知限制与建议发布说明

### 11.1 已知限制

- **长期画像不是事实数据库**：严格召回 15%–30%，重要事实召回 8%–23%；25%–31% stated 事实缺少引用支持；不要向用户承诺“完整记住所有观众”。
- **同 topic 不同 statement 可能保留旧说法**：P1-A；用户应在观众画像的“长期记忆”里复核、dismiss 或 rollback。
- **临时信息可能被保存**：生日、当天状态、当天作业等；180 天后才 outdated；建议人工复核。
- **YouTube 公开网页聊天不是官方稳定 API**：可能随时失效；不发送 Cookie/OAuth/Key；不绕过登录/验证码/地区限制；失败会如实报错。
- **30 天保留**：YouTube 原文、表情/徽章元数据、过期昵称会清理；计数/稳定 ID/金额保留；不是完全删除个人数据。
- **备份不含凭据**：恢复后需重新连接 Bilibili/AI Provider；备份是明文 STORE ZIP（本地文件），应放在可信位置。
- **AI 费用是估算**：Token × 用户单价；DeepSeek 不返回 `usage.cost`；不是账单。
- **单机本地**：无云同步、无账号体系、无遥测；数据只在本机。

### 11.2 建议发布说明（草案）

> LiveMemory RC0 内测版：本地优先的直播记忆工具。支持 Bilibili Live 与 YouTube Live 公开聊天采集、单场 AI 分析、长期观众画像、备份/恢复。
> 长期画像是“逐步积累的参考”，不是完整事实记录；请在使用前复核“待确认/矛盾”条目。YouTube 公开聊天路径不是官方 API，可能失效。备份不包含 API Key 与平台登录，恢复后需重新连接。AI 费用按你配置的单价估算，不是账单。

---

## 12. 是否建议进入 RC0 内测

**建议：是，进入 RC0 小范围闭源内测；不建议公开发布。**

理由：
- 两个 P0 已修复并有 819 项自动化 + 5 个 EXE/真实平台矩阵回归；基本采集、分析、保存、恢复、认证、asInvoker 均通过。
- 长期画像语义质量仍未达标（召回、证据支持、同 topic 冲突），但用户接受“逐步积累、允许遗漏”；内测可用人工复核与版本回滚兜底。
- 公开发布前应至少处理 P1-A（同 topic 不同 statement）与 P1-B（引用不支持结论），并在 UI/发布说明中明确“AI 画像需复核”。

**内测准入条件**：
1. 只向明确知情的用户发放；标注“RC0 内测 / 语义质量未达标”。
2. 默认保留人工复核入口；不要默认把 AI 画像当事实展示。
3. 不在宣传中使用“完整记忆”“100% 准确”“官方 YouTube”等表述。
4. 收集真实失败样本时遵守隐私与 30 天保留规则；不上传聊天原文。

---

## 13. Git、buildId、SHA-256

- 代码提交 1：`bdeb0f78d7d3f5ae2509c6897d6486147457b325`（fix: require evidence before promoting a memory fact to stated）
- 代码提交 2 / 构建时 HEAD：`996f99266b9159efb8ff8c7186163061adc73fed`（fix: reject cross-viewer evidence in legacy memory import）
- 文档收尾提交：本文件所在的后续提交（HEAD）
- buildId：`7016d4295d0e`
- SHA-256：`861eeaef3fd647732436809aedfa655da69db0d1ce1c11bbb76d8769972ff447`
- 提交身份：`zgrg29 <10182596+zgrg29@users.noreply.github.com>`（仓库本地配置）
- **未 Push、未 Tag、未发布 Release。**

---

## 14. 后续 P1/P2 建议

### P1（公开发布前）
1. **P1-A 同 topic 冲突**：在 `add` 命中已有 kind+topic 时，比较规范化 statement；不同则跳过并提示 `update/supersede/conflict`，或进入人工复核队列。必须保留“一个 live fact/topic”、版本快照与跨场次累积测试。
2. **P1-B 证据支持**：把“引用原文支持结论”纳入本地可复核流程（定向补答/人工复核/更严格的模型约束），不要只加批次或提示词长度。
3. **P1-C 临时事实**：区分 temporary / life_event；为 life_event 增加可配置 TTL 或“仅在最近 N 天显示为当前”；不删除历史。
4. **P1-D 摘要**：摘要只允许 inferred/uncertain，或在 UI 明确“AI 摘要，非事实”。

### P2（可延期）
1. 重写/删除陈旧的 `verify-memory-ui.mjs`，改为当前 viewer 画像页与 AI 中心页。
2. 在 AI 中心展示 `efficiency.factQuality`（stated/inferred/uncertain/待确认）。
3. 5/10/20 人真实语义批次；其他 Provider 真实付费验收；真实账单。
4. 复杂语义冲突、跨语言同义、反讽/否定识别。
5. 更高召回、更低 Token、更多可视化。
6. schema 17：`memory_job_messages.viewer_id`（若未来需要消息删除后仍能校验证据归属）。

---

## 附录 A：边界对照

| 类别 | 本轮做了什么 | 不是什么 |
| --- | --- | --- |
| 代码审计 | 阅读 memory engine/validate/store/embedded、auth、backup/restore、http、viewers、migrations；定位并修复 2 个 P0 | 不是只读旧报告 |
| 自动化测试 | 819 项全量；5 项新增；既有断言未放宽 | 不是只跑专项 |
| Mock / 合成 | 本地 Mock Provider、本地假 YouTube、合成 gold corpus、归档重评 | 不是真实付费 Provider |
| 正式 EXE | `dist/LiveMemory.exe`，5 个矩阵 + 真实 Chrome | 不是源码模式 |
| 真实 Provider | 仅只读归档（上一轮授权 DeepSeek） | 本轮无新付费调用 |
| 真实浏览器 | 外部真实 Chrome 154 + CDP；fragment→Cookie；页面无异常 | 不是用户手动默认浏览器 |
| 真实平台 | Bilibili 房间 5050；YouTube Sky News 直播 | 不是长时段/多天真实语料 |

## 附录 B：本轮产物与日志

- 修复：`src/memory/engine.mjs`、`src/memory/validate.mjs`、`src/memory/embedded.mjs`
- 新增测试：`tests/unit/memory-engine.test.mjs`、`tests/integration/memory-ai-workflow.test.mjs`、`tests/integration/unified-analysis-memory.test.mjs`
- 全量日志：`tests/.tmp/.full-rc0-final-audit-4.log`
- EXE 矩阵：`tests/.tmp/.final2-verify-exe.log`、`.final2-verify-p05.log`、`.final2-verify-p02.log`、`.final2-verify-ai-token.log`
- 真实 Chrome + EXE：`tests/.tmp/.final4-exe-browser.log`
- YouTube 生命周期：`tests/.tmp/.final-youtube-lifecycle.log`
- 真实 Bilibili：`tests/.tmp/.verify-bilibili-rc0-final.log`
- 真实 YouTube：`tests/.tmp/.verify-youtube-real-rc0-final-2.log`
- 归档重评：`tests/.tmp/p03-quality-final.json`、`tests/.tmp/rc0-archive-a.txt`
- 正式 EXE：`dist/LiveMemory.exe`、`build/build-info.json`、`build/manifest.json`
