# 工程状态（STATUS）

最后更新：2026-11-09（M6 AI 分析结果导入、分批汇总与直播分析报告，版本 0.8.0，schema 8）

> 本文件是唯一进度来源。只要代码与本文不一致，以代码与实测为准，并立即修正本文。

## 1. 当前阶段

- 里程碑：**M0 / M1 / M2 核心 / P0–P6 / M6 完成；M3 真实接入继续验证；M4 / M7 部分推进；M5 未完成**
- 版本：`0.8.0`（`package.json`、`src/shared/app-info.mjs` 与 EXE 一致）
- 数据库 schema：**8**（新增 AI 任务/批次/消息映射/观众集合/结果/证据表与 `ai_packages` 来源列；旧库原地升级）
- 分支：`main`，本地提交，未 Push
- 发布形态：`LiveMemory.exe`，RT_MANIFEST **requireAdministrator**

## 2. 本轮完成（2026-11-09，v0.8.0，M6）

### 2.1 完整的 AI 文件往返

- **创建分析任务**：`POST /api/ai/jobs`。任务绑定一场直播、一个提示词语言与版本、一个可配置批次大小
  （每批 100–5000 条，默认 1000）。导出全部批次包后才能继续；旧版 `POST /api/ai/packages` 保留。
- **分析包**：沿用 `livememory-analysis-v1`，新增 `job_id`、`stage`、`batch`、`coverage`、`prompt_version`、
  `schema_version`，并保留原有 `manifest.json` / `session_context.json` / `messages.jsonl` /
  `viewer_context.json` / `instructions.md` / `result.schema.json` 结构。
  `messages.jsonl` 增加 `event_id`（本地行 id）与 `message_id`（平台消息 id），seq 仍从 1 开始。
- **提示词复制**：`GET /api/ai/instructions?jobId=&batchIndex=` 或 `stage=aggregate` 返回与包内
  `instructions.md` 一致的本地化提示词；无任务时返回通用说明。
- **导入方式**：本地 JSON 文件（读取后不执行、不超过 8 MB）或文本框粘贴；支持剥离一层 Markdown 代码围栏。
- **预检查**：`POST /api/ai/import/preview` 显示场次、任务、批次/汇总、包标识、Schema 版本、覆盖范围、
  是否已导入、重复/新版本判定、错误与警告。预检查只读数据库，不写任何结果。
- **确认写入**：`POST /api/ai/import`。服务端重新完整校验（不信任预览），单事务写入结果与证据；
  失败回滚，不写入部分结果。
- **任务状态**：`awaiting_import` / `partial` / `awaiting_aggregate` / `complete` / `invalid`，全部由
  `ai_jobs`、`ai_job_batches`、`ai_results` 实时计算，重启后保持；`sessions.ai_status` 同步为
  `none` / `exported` / `partial` / `imported`。

### 2.2 严格 Schema 与数据完整性校验

- 自研无依赖 JSON Schema（2020-12 子集）校验器：type、const、enum、required、properties、
  `additionalProperties:false`、items、min/max items、min/max length、minimum/maximum、date-time、oneOf。
- 结构防护：8 MB 上限、节点数/深度上限、字符串长度上限、禁止 `__proto__`/`constructor`/`prototype`。
- 业务校验：
  - `protocol`、`schema_version`（1.0.0 兼容，1.1.0 当前）、`task_id`、`job_id`、`batch_id`、`session_id`；
  - 主播 `broadcaster_id` 与任务/场次快照一致；
  - 时间戳必须是带时区的 ISO-8601，且落在直播记录窗口内（平台开始时间与本地开始时间取较早者，前后 10 分钟容差）；
  - `message_refs` 必须能在该任务该批次的 `seq → event_id` 映射中解析，且引用真实事件行；
  - `viewer_profiles[].viewer_id` 必须在该批次 `viewer_context` 中；**绝不按昵称解析身份，绝不跨主播合并**；
  - 汇总结果中的证据必须写成 `{"batch": n, "seq": m}`，纯整数在多批任务中会被拒绝（歧义）；
  - 汇总结果必须等所有批次结果都导入后才能接受。
- 错误报告包含 JSON 字段路径、稳定错误码、原因文案与修复建议；UI 用三语显示，不显示“导入失败”一句话。
- 内容安全：结果按字段白名单重建后存储，清除控制字符；UI 全程 `textContent`，不执行 AI 文本中的
  HTML/脚本/命令；结果不能写事件表、金额或本地统计。

### 2.3 分批、汇总与重复导入

- 按 `(occurred_at, id)` 顺序在消息边界拆分，不截断单条消息；每批记录全局 seq 范围、时间范围、
  消息数、包校验和、稳定批次 id（`<jobId>-bNN`）。
- 导出后立即建立 `ai_job_messages`（seq → event id）与 `ai_job_viewers`，用于导入/报告的证据与身份校验。
- 批次可任意顺序导入；缺失批次、重复批次、错误批次全部由状态与预览显示。
- 单批次任务导入后即完成；多批次任务必须导入全部分批结果，再生成**第二阶段汇总包**
  （`stage=aggregate`，无原始消息，包含 `batch_results.json`、会话统计与全部观众上下文），
  导入最终 JSON 后才标记 `complete`。
- 部分结果绝不拼接成“整场报告”：UI 按批次分别展示，并明确标记“分析尚不完整”与缺失批次。
- 相同内容（规范化 JSON 的 SHA-256）重复导入直接判定为重复，不写第二行；不同内容需要显式
  `createVersion: true`，追加版本并保留旧版本，报告使用最新版本，不静默覆盖。
- 任务创建、导出、汇总包创建、导入都记录数据库事实；`删除直播` 事务会级联清理任务、批次、
  消息映射、结果与证据，并删除分析包文件。

### 2.4 直播分析报告

- `GET /api/ai/sessions/:id/report` 读模型 + `src/web/js/pages/ai-report.js` 渲染：
  - **直播摘要**：仅来自导入结果，不由前端生成；
  - **话题时间线**：起止时间、说明、要点、可信度、observed/inferred、引用消息；
  - **情绪分析**：AI 估计，明确提示反讽/玩梗/表情歧义，低可信度标记；
  - **争论与热点**：主题、时间、不同观点、证据、不确定性，并说明“玩法分歧”不等于严重冲突；
  - **候看片段**：起止时间、标题、原因、推荐程度、证据；明确说明 LiveMemory 没有视频/音频，
    不能生成切片，只是基于聊天与事件的候选时间范围；
  - **观众画像**：仅本场、明确为 AI 推断，不跨主播合并；
  - **分析来源**：结果版本、导入时间、任务、提示词版本、Schema 版本、批次覆盖、文件/粘贴来源；
  - **证据展开**：按批次与 seq 显示真实昵称/时间/原文；原文已过期或删除时明确显示不可用，绝不伪造。
- 直播详情页新增 AI 报告卡：有完整结果时显示摘要与“查看完整报告”，部分导入时显示不完整提示，
  仅导出时显示等待导入；不再把“没有报告”当成“没有分析”。
- 报告在明亮/黑暗、三语、390px 宽度下可用；崩溃/非法结果不会影响本地确定性统计页。

### 2.5 三语提示词版本

- 版本：`lm-prompt-m6.1-<locale>`（当前 `lm-prompt-m6.1-zh-CN` / `-ja` / `-en`）。
- 每个任务与每个包 manifest 记录实际使用的 `prompt_version`；结果导入后报告显示该版本。
- 三种语言共用同一语义结构：包内容、任务、批次/汇总规则、主播上下文、表情规则、安全与依据、
  输出结构、来源字段、本包信息；字段名/枚举/ID 不随语言变化。
- 切换界面语言不会改写已创建任务、批次 id、提示词版本或校验规则；只影响新任务/通用说明。

### 2.6 UI

- AI 分析中心重写为「选择直播 → 创建任务/导出分析包 → 复制提示词 → 任意 AI 分析 → 导入 JSON → 查看报告」，
  步骤卡解释整个流程；文件/粘贴两种导入方式并列；高级选项仅暴露“每批消息数”。
- 任务卡显示状态、创建时间、批次进度、提示词版本、结果版本、缺失批次、汇总包、重新分析入口；
  可下载每个批次/汇总包；旧版任务标记 legacy。
- 导入后立即显示报告并滚动到报告；错误列表显示字段路径、原因、修复建议；警告可折叠；重复/新版本有明确提示。
- 三语文案齐全；明亮/黑暗、390px 无横向溢出；真实浏览器 UI 验证 17/17。

## 3. 自动化测试（本轮实测）

- 全量：**354 passed / 0 failed / 约 48.3 秒**
  （`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`）。
- 本轮新增：
  - `tests/integration/ai-import.test.mjs`：单批完整往返与报告证据、非法 JSON/缺字段/错误类型/未知字段/
    错误 Schema 版本、场次/任务/批次/任务 id/主播/观众错误、未知消息引用与越界时间、重复导入、
    同任务新版本、故障注入回滚、归档导入、删除后失效、原文清理后的证据、跨主播身份隔离、旧版包兼容、
    HTML/控制字符安全、8 MB 上限与大规模合法结果性能。
  - `tests/integration/ai-batching.test.mjs`：2500 条消息 5 批无丢失/重复、seq→event 映射唯一、
    乱序/重复/缺失批次、提前汇总被拒、汇总包无原始消息、最终报告不拼接、12 批 6000 条映射、
    重新分析生成新任务与稳定新批次 id。
  - `tests/integration/ai-api.test.mjs`：HTTP 任务/批次/下载/提示词/预览不写入/导入/重复/版本 409/
    汇总/最终报告/结果下载/请求上限/删除场次后的结构化失败。
  - `tests/integration/ai-migration.test.mjs`：真实 v7→v8 升级保留旧包来源、v8 表/列存在、
    会话删除级联 AI 任务与结果。
  - `tests/unit/ai-prompts.test.mjs`：三语提示词语义结构、批次/汇总规则、提示词版本记录、
    Schema v1.0/v1.1 兼容与未知字段拒绝。
  - `tests/unit/ai-ui.test.mjs`：无 innerHTML/脚本执行、完整端点、历史详情入口、三语键、
    AI 与本地统计分离、切片提示不声称视频分析。
  - `tests/helpers/ai-fixtures.mjs`：合成直播与从真实导出包元数据构造的 Schema 合法结果。
- 更新：schema 8 / v0.8.0 / `capabilities.ai.import=true` 断言；EXE 历史脚本升级到 schema 8。

## 4. 真实 AI 与真实平台验证

- **本轮没有调用任何真实 AI 服务**。所有导入结果都是使用真实导出的分析包元数据（task_id、batch_id、
  消息时间、观众 id）构造的 Schema 合法**合成结果**，用于验证校验、事务、批次、版本与报告。
  因此不能声称“真实 AI 文件往返已完成”；只能声称“符合契约的 AI 结果已端到端导入并展示”。
- 用户完全可以使用任意 AI 服务手动完成同一流程；软件不调用 AI API、不需要登录或 API Key。
- 本轮**没有新增真实 Bilibili / YouTube 网络采集**；v0.6.0 的真实并发结果仍是历史样本。
- 真实平台阻塞项不变：UAC 交互、真实文件夹选择、同一真实观众跨主播、Bilibili 礼物/SC/大航海样本、
  YouTube 公开网页长期稳定性与条款评估。

## 5. EXE / 构建 / UI 验证

- 构建：`node scripts/build-windows.mjs`（Node v24.21.0）
- 当前构建：**90.6 MB，117 资源**，SHA-256 `215bb6c0fcefb6bcd2b17b51f0391af886b2ab2ccc67409648348ba0a2f12f05`
- Manifest：`requireAdministrator`（实际 PE 补丁）；`--version` 输出 `LiveMemory 0.8.0`
- `scripts/verify-exe.mjs`：**10/10**（含版本、日文帮助、诊断、单实例、不可写目录、异目录、资源复用）
- `scripts/verify-exe-ai.mjs`：**14/14**（真实打包 EXE，asInvoker 临时副本）
  - 真实 schema v7 数据库 → EXE 升级到 schema 8；
  - UI 创建 3 批次任务、导出 3 个包、粘贴导入 3 个批次、版本记录；
  - UI 生成汇总包、导入最终 JSON、报告与证据来自 EXE 数据库；
  - 重启后 schema 8、任务、结果、报告与 4 个包文件保持。
- `scripts/verify-exe-history.mjs`：**19/19**（真实 v6→v8 升级，历史搜索/归档/停止/删除/重启保持）
- `scripts/verify-ai-ui.mjs`：**17/17**（真实浏览器 + 模拟夹具）
  - 完整报告、部分报告、等待导入、证据展开、来源、提示词/批次选项、无效 JSON、粘贴导入、
    新版本导入、JSON 文件上传与重复检测、历史详情入口、黑暗主题 + 中文 + 390px；
  - 截图：`docs/screenshots/ai-centre-complete-v080-light.png`、
    `ai-centre-waiting-v080-light.png`、`ai-report-complete-v080-light.png`、
    `ai-report-partial-v080-light.png`、`ai-import-success-v080-light.png`、
    `ai-report-dark-zh-390-v080.png`、`ai-exe-report-v080.png`。

## 6. 未完成 / 未验证

- **真实 AI 服务端到端**：未调用；只验证了符合 Schema 的合成结果。真实 AI 的输出风格、长度、
  拒绝/截断、JSON 围栏、乱码与超时仍需人工样本。
- **真实平台**：本轮未做新的 Bilibili/YouTube 采集。
- **UAC / 管理员桌面 / 真实文件夹选择 / 干净 Windows 虚拟机 / 代码签名 / 升级回滚**：未完成。
- **M5 可移植备份**：未实现；当前仍只有数据库应急快照。
- **AI 结果的保留策略**：YouTube 原文 30 天清理会清空事件正文，报告会把证据标记为不可用；
  但已导入的 AI `viewer_profiles` 与 AI 摘要不会自动删除。它们属于本地衍生数据，随场次删除或
  清空数据移除。**不得声称这种长期保存已完全符合平台政策**；M7 需要把 AI 画像纳入保留/去标识化策略。
- **结果删除/回滚**：没有“删除单个结果版本”的 UI/API；版本只追加，场次删除或清空数据才会移除。
- **分批自动重试/断点续传**：批次可重复下载与导入，但没有后台队列或自动重试。
- **分析包 ZIP 直接导入**：本轮按要求只导入 AI 返回的 JSON；不解析用户上传的 ZIP。
- **视频/切片**：不下载、不录制、不分析视频，也不生成视频文件；报告只是聊天证据候选时间段。
- **性能**：单次任务上限 50,000 条消息；批量大小为 100–5000。未做 10 万条或 20+ 批次压力测试。
- **真实多 AI 品牌兼容**：仅验证了契约与自建合成结果；未逐一测试 ChatGPT/Claude/Gemini 的 ZIP 上传与
  JSON 输出行为。

## 7. 相关文档

`docs/ARCHITECTURE.md`、`docs/DATA_MODEL.md`、`docs/AI_CONTRACT.md`、`docs/TEST_PLAN.md`、
`docs/CHANGELOG.md`、`docs/PRIVACY_SECURITY.md`、`docs/UI_DESIGN.md`、`docs/DECISIONS.md`
（ADR-029/030）、`docs/ROADMAP.md`、`docs/HANDOFF.md`、`README.md` 与
`log/2026-11-09-ai-import-report.md` 已同步本轮变化。

## 8. 下一步

1. 用至少一个真实 AI 服务完成一次真实直播的文件往返，记录真实输出差异（不提交真实聊天原文）。
2. 在真实管理员桌面完成 UAC、文件夹选择、迁移与重启验证。
3. 为 AI 结果/观众画像增加保留、去标识化与单版本删除策略；M7 长期画像必须建立在已验证证据上。
4. 继续真实直播验证，累积 Bilibili 经济事件与同一真实观众跨主播样本。
5. 视需要增加更大规模（10 万条/20+ 批）与多 AI 服务的兼容性测试。
