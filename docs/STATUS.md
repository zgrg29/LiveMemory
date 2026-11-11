# 工程状态（STATUS）

最后更新：2026-11-11（P9 自动 AI 分析，版本 0.12.0，schema 12）

> 本文件是唯一进度来源。只要代码与本文不一致，以代码与实测为准，并立即修正本文。

## 1. 当前阶段

- 里程碑：**M0 / M1 / M2 核心 / P0–P9 / M6 / M7 核心完成**；M3 真实接入继续验证；M4 部分完成；M5 未完成
- 版本：`0.12.0`（`package.json` 与 `src/shared/app-info.mjs` 一致）
- 数据库 schema：**12**（本轮未改表结构；自动分析使用现有 `ai_*` 表）
- 分支：`main`，本地提交，未 Push
- 发布形态：`LiveMemory.exe`，RT_MANIFEST **requireAdministrator**（v0.12.0 已构建，未能运行验收）

## 1.1 本轮完成（2026-11-11，v0.12.0，P9 自动 AI 分析）

### 1.1.1 真实接口调查（先测试，再集成）

完整报告见 `docs/ANONYMOUS_AI_RESEARCH.md`。结论：

- **OVHcloud AI Endpoints**（官方文档 + 真实请求）是唯一通过完整 LiveMemory 包检验的匿名接口：
  - Base URL `https://oai.endpoints.kepler.ai.cloud.ovh.net/v1`，模型 `gpt-oss-20b`；
  - 匿名 **2 请求/分钟/IP/模型**，131k 上下文，JSON Mode；
  - 真实 3 观众包：`status=complete`、`memoryCoverage.semantic=3`、`source=auto`，证据 seq 正确。
- **Murakumo**：官方匿名说明存在，但实测 `/ready` 503、`murakumo/free` 502（OpenRouter 429）、`mishima` 180 秒后 `fleet_capacity_unavailable`；未取得有效回答，**不集成**。
- **llmfaucet**：`llmfaucet.dev` / `api.llmfaucet.dev` 在本地、Google DNS、Cloudflare DoH 均为 NXDOMAIN；**不集成**。
- **LLM7.io**：无 Key 请求可返回 200，但官方 README 要求 `dash.llm7.io` Token；匿名第三方授权无法确认，**不集成**。
- **Pollinations**（额外调查）：匿名基础 JSON/多语言通过，但真实 LiveMemory 包 HTTP 400；**不集成**。
- 没有第二个通过项，因此本轮**没有**生产自动切换列表；请求失败时降级到手动流程。

### 1.1.2 自动分析后端

新增：

| 模块 | 职责 |
| --- | --- |
| `src/ai/auto/config.mjs` | 唯一已验证 provider、匿名限流、批次/上下文/输出上限、稳定错误码 |
| `src/ai/auto/client.mjs` | `fetch` + `AbortSignal` 请求、滑动窗口限流、`Retry-After`、JSON 提取、错误分类 |
| `src/ai/auto/prompt.mjs` | 读取现有 ZIP 包、内联包内容、精确观众 ID/证据 seq、批次/汇总/修复提示词、上下文预算 |
| `src/ai/auto/state.mjs` | `runtime/ai-auto.json` 进度（无聊天正文/提示词），重启标记 `interrupted` |
| `src/ai/auto/runner.mjs` | 创建/恢复任务 → 逐批调用 → 校验 → 导入 → 汇总 → 完成；取消、重试、备用、请求预算 |
| `src/ai/auto/errors.mjs` | 单一 `AutoAnalysisError` 与脱敏 detail |

关键约束：

- 自动分析**不直接写数据库**：每个回答都先调用现有 `validateAnalysisImport()`，再调用 `importAnalysisResult({source:'auto'})`，与手动导入同一事务路径。
- Schema 严格程度不变；`viewer_memory_updates` 覆盖、稳定 ID、证据归属、时间窗口、重复导入保护全部沿用现有逻辑。
- 自动任务使用更小的批次（250 条消息 / 25 位观众 / 600 条摘录），最多 12 批；超出时明确 `AUTO_TOO_MANY_BATCHES`，不静默截断观众。
- 输出预算最低 8000 tokens（探测到 3040 会截断 gpt-oss 的 JSON）；修复请求最多 1 次。
- provider 调用串行；每个 provider 2 请求/60 秒滑动窗口；`429` 尊重 `Retry-After`（上限 90 秒）；单次运行有请求预算。
- 不使用 API Key、Cookie、Token、开发者服务器；首次使用需在 UI 明确同意数据发送。

### 1.1.3 自动分析 API

```text
GET  /api/ai/auto/services    已验证服务与最大批次数
GET  /api/ai/auto/status      按 sessionId 返回真实阶段/批次/错误/任务状态
POST /api/ai/auto/run         {sessionId, locale, consent:true}
POST /api/ai/auto/cancel      {sessionId}
```

`AutoAnalysisRunner` 随 `startServer` 的运行时创建/销毁；`shutdown` 会中止任务并把进行中的状态标为 `interrupted`。恢复时复用同一 job id、batch id、观众分配与已导入结果。

### 1.1.4 UI

在现有 AI 分析中心的「创建分析任务」卡内、手动控件上方新增：

- 「自动 AI 分析」主按钮 + 「免费 · 匿名」chip + 简短说明；
- 真实阶段文案：准备数据 / 连接免费 AI / 第 X/Y 批 / 验证结果 / 更新长期记忆 / 整场汇总 / 完成 / 已取消；
- 首次使用一次性同意弹窗（明确第三方数据处理）；
- 失败时按钮正下方显示规定红色文案，技术原因折叠在「查看详情」，不弹 `alert()`，不自动切换/删除手动结果；
- 手动创建任务、下载包、复制提示词、导入 JSON 全部保留；按钮下方用分隔线标注「或使用手动分析」。
- 处理中禁用同一任务重复启动；页面切换/刷新从服务端恢复状态；可取消，已导入批次保留。

### 1.1.5 本轮已知限制

- 只有一个已验证 provider；OVH 匿名层 2 请求/分钟，较大场次会更慢或明确拒绝。
- `gpt-oss` 的输出质量仍有波动；本轮通过“证据 seq 列表 + 必须输出状态变化 + 8000 输出预算 + 一次修复”降低失败率，但不能保证每个回答都完美。
- 真实长期记忆连续性测试（同一观众先“学画画”、后“改学吉他”）见 `docs/ANONYMOUS_AI_RESEARCH.md` §8：第二场自动完成后旧事实被标记为 `superseded`，新增“吉他”与“最近不怎么画画了”两条事实；这是单次真实样本，不保证所有模型都稳定。
- v0.12.0 EXE 已构建但**未能运行**（本机拒绝非提升执行）；未在真实数千观众大场执行自动分析。
- 真实浏览器 UI 仍未验收（本机策略阻止无头浏览器）；只有静态 UI 检查与 HTTP 端到端测试。

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
  → **525 passed / 0 failed**（约 93 秒，2026-11-11）。
- 新增本轮自动分析测试：
  - `tests/unit/auto-client.test.mjs`：JSON 提取、滑动窗口、匿名请求头、429/5xx/timeout/非 JSON；
  - `tests/unit/auto-prompt.test.mjs`：观众 ID/证据 seq、汇总契约、上下文预算、修复提示；
  - `tests/integration/auto-analysis.test.mjs`：成功、多批 + 汇总、备用 provider、全失败、
    Schema 修复、错误证据、部分成功后恢复、重复点击、取消/恢复、重启中断恢复、
    汇总失败保留批次、旧记忆不被覆盖、重复导入幂等；
  - `tests/integration/auto-api.test.mjs`：HTTP 同意、202、409、状态、422 规模上限、取消、
    手动导入路径仍可用；
  - `tests/unit/ai-ui.test.mjs`：按钮/阶段/红色文案/三语键/无 `alert()`/无 `innerHTML`。
- 既有 M6/M7/P8 全量回归通过；schema 仍为 12，无迁移断言变化。


## 4. UI 验证（如实）

- **没有真实浏览器渲染/截图验收**：本机策略仍阻止无头 Edge/Chrome。
- 已覆盖：三语键一致、页面字面 key、独立记忆页已移除/旧链接到 AI、预览字段、客观历史卡、
  无 innerHTML、CSS tokens、窄屏规则（静态测试）；HTTP/端到端行为由 Node 测试覆盖。
- v0.12.0 自动分析 UI 额外覆盖（静态）：按钮/免费匿名 chip/首次同意 modal/真实阶段文案/
  按钮下方红色固定文案/折叠详情/取消/无 `alert()`/手动控件仍在；HTTP 路由与状态由
  `auto-api.test.mjs` 覆盖。
- 因此不能声称自动按钮、AI 预览、观众记忆页、暗色、390px 已在真实浏览器验收。

## 5. 构建结果（如实）

- `node scripts/build-windows.mjs` 成功：`dist/LiveMemory.exe`（v0.12.0）
  - 大小 **91.2 MB**，资源 **151 个**，资源哈希 `c5a20ea9c14c707fc659`
  - SHA-256 `342294c97ebb200fe8796ac783fa841f5e2b6f451fcc996a641db8368d82cebe`
  - PE Manifest **requireAdministrator**（脚本断言通过）
- **未能运行验收**：本机直接执行被 Windows 以“请求的操作需要提升”拒绝；未能运行
  `--version`、启动服务、验证打包后的自动分析出站请求或 UI。
- 因此只能声称“已构建”，不能声称“v0.12.0 EXE 已启动/已验收”。

## 6. 未完成 / 未验证

- v0.12.0 EXE 启动、出站网络与干净 Windows 环境验收（已构建，未能运行）；
- 真实浏览器自动分析 UI、暗色、390px、按钮位置截图；
- 数千观众/数万消息大场的自动批次、耗时、内存与 OVH 2 请求/分钟的实际总时长；
- 第二个通过完整 LiveMemory 包的匿名 provider（本轮没有）；
- 自动分析运行中删除场次/清空数据的 UI 守卫与真实交互；
- 真实 Bilibili/YouTube 大场自动分析样本（当前真实样本为 3 位合成观众）；
- 真实平台礼物/SC-only 观众的自动分析样本；
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
9. 自动分析必须走 `validateAnalysisImport()` + `importAnalysisResult()`；不能直接写库，不能降低 Schema。
10. 自动批次仍覆盖全部可识别观众；超出 12 批或 90k 上下文时明确失败，不得静默裁剪。
11. 只允许 `docs/ANONYMOUS_AI_RESEARCH.md` 中通过完整 LiveMemory 包的匿名 provider；未验证服务不得进入自动列表。
12. 自动失败只写状态/错误码；不删除已完成结果、不覆盖已有记忆、不自动切换手动模式；红色文案在按钮正下方。

## 8. 相关文档

`docs/HANDOFF.md`、`docs/ARCHITECTURE.md`、`docs/DATA_MODEL.md`、`docs/AI_CONTRACT.md`、
`docs/UI_DESIGN.md`、`docs/PRIVACY_SECURITY.md`、`docs/TEST_PLAN.md`、`docs/CHANGELOG.md`、
`docs/ROADMAP.md`、`docs/ANONYMOUS_AI_RESEARCH.md`、
`log/2026-11-11-anonymous-ai-auto-analysis.md`、`log/2026-11-10-unified-analysis-memory.md`、
`log/2026-11-10-viewer-scope-fix.md`。

## 9. 下一步

1. 在允许浏览器的机器上验收自动按钮、失败红色文案、详情、暗色与 390px；补截图。
2. 在无策略限制的 Windows 环境运行已构建的 v0.12.0 EXE，验证出站请求、代理/防火墙与打包 UI。
3. 用 1000–5000 观众/数万消息的大场测自动批次、耗时、内存与 OVH 2 请求/分钟的实际影响。
4. 寻找并完整测试第二个匿名 provider（必须通过真实 LiveMemory 包），再启用自动切换。
5. 评估自动运行中删除场次/清空数据的 UI 守卫；当前只依赖服务端失败与红色提示。
6. 继续观察 OVH 免费通道的稳定性与条款变化；失效时如实降级，不把历史可用写成永久可用。

## 10. 补丁 0.11.1：观众档案主播范围

- **问题**：观众详情页把 `/api/broadcasters` 的全部主播传给「主播范围」选择器，
  导致只出现过 1 位主播的观众也看到软件记录过的全部主播。
- **根因**：UI 的 `scopeOptions` 使用全局 broadcaster payload；详情页没有使用
  `/api/viewers/:id` 已经返回的 `profile.broadcasters`。后端 `buildViewerProfile` 在请求
  无关系主播时还会用 `getBroadcaster` 回退，制造了一个看似有效的空范围。
- **修复**：
  - 新增纯逻辑 `src/web/js/pages/viewer-scope.js`；详情选项只来自
    `profile.broadcasters`（即 `viewer_broadcasters`，包含礼物/SC/大航海等可识别互动），
    不再包含「全部主播」或未归属选项。
  - 无效/已删除的 `?broadcaster=` 安全回退到当前有效主播或第一个关联主播；
    无关联时 `null`，页面显示明确空状态。
  - 只有一个关联主播时隐藏无意义的下拉框，改为只读标签。
  - `buildViewerProfile` 无关系时返回 `scope.kind='none'`，不再回退到全局主播。
  - 长期记忆上下文只使用有效关联主播，不再回退到全局当前主播。
- **测试**：新增 `tests/unit/viewer-scope.test.mjs`、
  `tests/integration/viewer-broadcaster-scope.test.mjs`；全量 **495 passed / 0 failed**。
- **构建**：见 §5（0.11.1 重新构建）。
