# 版本变化（CHANGELOG）

## 0.8.1 — 2026-11-10（Bilibili 直播生命周期检测修复）

### 修复

- **Bilibili 下播后仍显示「直播中」**：适配器此前忽略 `PREPARING`/`STOP_LIVE`，
  不处理 `LIVE`，也从不查询 `live_status`；`sessions.status='live'` 只代表本地
  WebSocket 采集仍在运行。现在平台状态与采集状态分离，并由多信号确认下播。
- 启动恢复不再把最后一条弹幕时间当作场次结束时间；`ended_at` 使用启动检测时间，
  `platform_ended_at` 在证据不足时保持 NULL。
- 旧适配器的异步回调不能在停止/结束后写入场次；快速下播再开播创建新场次；
  重连 `live_time` 变化或 `PREPARING` 后的新 `LIVE` 会结束旧场次，避免混场。

### 新增

- schema **9**：`sessions.platform_status`、`platform_status_at`、`last_live_seen_at`、
  `platform_ended_at`、`platform_end_quality` 与索引。
- Bilibili 每 60 秒 `room/v1/Room/get_info` 状态查询，8 秒超时、指数退避、每房间独立。
- WebSocket `LIVE`/`PREPARING`/`STOP_LIVE` 处理；WS 下播事件 + 1 次有效离线查询，
  或 2 次连续有效离线查询才结束。
- 自动下播：清定时器/WebSocket/重连 → 写最终事件 → 更新结束时间/原因/平台状态 →
  SSE 刷新；保留全部数据。
- 历史异常行启动后台探测：证据不足标 `unknown`，不编造结束时间，幂等且可追溯。
- 历史列表/详情/多场标签区分「直播中、已下播、手动停止、采集中断、平台未知」；
  平台结束后不再显示绿色；详情新增生命周期卡；三语 + 明暗 + 390px。
- 未开播/轮播房间在创建采集前被拒绝，并显示三语错误。
- 新增 `scripts/verify-live-status-ui.mjs` 与生命周期测试；
  schema 9 / v8→v9 迁移测试；真实 Bilibili 状态接口与 4 房间 20 分钟监控。

### 测试

- 386 自动化全部通过；EXE 矩阵 10/10；EXE 历史 19/19；EXE 生命周期 UI 21/21。
- **未完成真实下播端到端**：真实监控期间没有主播下播，不能声称已完全验证。

## 0.8.0 — 2026-11-09（M6：AI 分析结果导入、分批汇总与直播分析报告）

### 新增

- **完整 AI 文件往返**
  - `POST /api/ai/jobs`：创建分析任务，按消息边界拆批导出 `livememory-analysis-v1` 包；
    任务记录场次、主播、提示词语言/版本、批次大小与消息总数；
  - 包 manifest 新增 `job_id`、`stage`、`batch`（批次 id/序号/总数/seq 范围/时间覆盖/校验和）、
    `coverage`、`prompt_version`、`schema_version`；`messages.jsonl` 新增 `event_id` 与平台 `message_id`；
  - `POST /api/ai/import/preview`：显示场次、任务、批次/汇总、包标识、Schema 版本、覆盖范围、
    重复/新版本、缺失批次、错误与警告；只读，不写结果；
  - `POST /api/ai/import`：文件或粘贴 JSON，服务端重新校验，单 SQLite 事务写入结果与证据；
    失败回滚，不留下部分结果；
  - JSON 文件上限 8 MB；支持剥离一层 Markdown 代码围栏；超大请求先丢弃再返回 413。

- **严格校验**
  - 无依赖 JSON Schema 2020-12 子集验证（type/const/enum/required/unknown field/items/min-max/
    length/number/date-time/oneOf），加上结构深度/节点/字符串/危险键防护；
  - 业务校验：协议、Schema 版本、场次、任务、批次、主播快照、观众稳定身份、时间窗口、消息引用、
    汇总前置条件；错误含字段路径、稳定错误码、原因与修复建议（三语）。

- **版本与状态**
  - 相同结果（规范化 JSON SHA-256）重复导入不写第二行；不同结果必须显式 `createVersion`，
    追加新版本并保留旧版本；报告使用最新版本；
  - 任务状态 `awaiting_import` / `partial` / `awaiting_aggregate` / `complete` / `invalid`
    全部由数据库计算，重启保持；`sessions.ai_status` 同步；
  - “重新分析”创建新任务，旧任务与结果版本保留。

- **分批与汇总**
  - 稳定批次 id、seq→event 映射、批次观众集合；消息不丢失、不重复、不截断；
  - 乱序导入、重复批次、缺失批次、错误批次检测；
  - 全部分批结果导入后可生成第二阶段汇总包（无原始消息，含 `batch_results.json`）；
    导入最终 JSON 后任务才 `complete`；
  - 部分结果按批次分别展示，不拼接成假整场报告；汇总结果中的证据必须写 `{batch, seq}`。

- **直播分析报告**
  - `GET /api/ai/sessions/:id/report` + `ai-report.js`：摘要、话题时间线、情绪、争论、候看片段、
    观众画像、来源（结果版本/提示词版本/Schema/批次覆盖/文件或粘贴）、证据；
  - 证据解析到真实事件行；原文被保留策略清理或行删除时明确显示“不可用/已删除”，不伪造；
  - 明确说明 LiveMemory 没有视频/音频，片段建议只是基于聊天与事件的候选时间范围；
  - 历史详情页新增 AI 报告摘要卡与完整报告入口；部分结果标记不完整；仅导出显示等待导入。

- **三语提示词版本**
  - `lm-prompt-m6.1-zh-CN/ja/en`；任务与包记录实际版本；三语语义结构一致；
  - 批次规则（只分析本批、时间覆盖、seq 引用、部分结果）与汇总规则（合并、冲突、`{batch, seq}`）
    全部本地化；切换界面语言不改变已创建任务/批次/校验规则。

- **数据模型 / 删除 / 清空**
  - schema 8：`ai_jobs`、`ai_job_batches`、`ai_job_messages`、`ai_job_viewers`、`ai_results`、
    `ai_result_evidence`；`ai_packages` 新增 `job_id`/`batch_index`/`stage`/`prompt_version`；
  - 删除场次于同一事务删除全部 AI 任务/批次/映射/结果/证据/包记录并删除批次/汇总文件；
  - 清空数据与备份计数包含全部 AI 表；旧整场包与 1.0.0 结果仍兼容。

- **工具 / 文档**
  - 新增 `scripts/demo-ai.mjs`、`scripts/verify-ai-ui.mjs`、`scripts/verify-exe-ai.mjs`；
  - 新增 `tests/helpers/ai-fixtures.mjs`、`ai-import`、`ai-batching`、`ai-api`、`ai-migration`、
    `ai-prompts`、`ai-ui` 测试；
  - STATUS / HANDOFF / ROADMAP / ARCHITECTURE / AI_CONTRACT / DATA_MODEL / PRIVACY_SECURITY /
    TEST_PLAN / UI_DESIGN / README / DECISIONS 与开发日志同步。

### 变更

- 版本 **0.8.0**；schema **8**；`/api/status` 与 `/api/bootstrap` 的 `ai.import` 改为 `true`，
  增加结果 Schema 版本。
- 旧版 `POST /api/ai/packages` 仍保留整场导出；新 UI 使用任务/批次接口。
- `aiChip` 支持 `partial` / `complete` / `invalid`。
- 全量测试 353；浏览器 UI 17/17；打包 EXE AI 14/14；EXE 历史回归 19/19；EXE 矩阵 10/10。

### 已知限制

- **没有调用真实 AI 服务**：测试结果是使用真实包元数据构造的 Schema 合法合成结果；
  真实 AI 输出差异仍是下一轮首要验证项。
- 本轮无新的真实 Bilibili/YouTube 采集；UAC、真实文件夹选择、干净 Windows、M5 备份仍未验证。
- YouTube 30 天清理不会自动删除已导入 AI 结果中的观众画像/摘要；不得声称完全符合平台政策。
- 无单结果版本删除；无后台自动重试/断点续传；不导入 ZIP；不处理视频/切片。
- 单任务 50,000 条上限；未做 10 万条/20+ 批次压力测试。

## 0.7.0 — 2026-11-09（直播历史场次管理、统一搜索、永久删除）

### 新增

- **场次管理（列表 + 详情共用）**
  - 停止记录：只停指定场次，保留消息/观众身份/统计/经济支持；`status=ended`、`end_reason=user`；
    UI 区分“已停止记录”与“已结束”，明确平台直播可能仍在进行；
  - 归档/取消归档：schema v7 `sessions.archived_at`，独立于 `status`；live 禁止归档；
    默认列表隐藏，支持“包含已归档/查看归档”；归档场次仍可搜索、查看、导出 AI 包；重启保持；
  - 永久删除：`DELETE /api/sessions/:id`（必须 `{confirm:true}`），事务删除消息/事件/支持/统计/
    观众参与/AI 包记录，重建观众与主播维度聚合，清理孤立派生行，删除导出文件；
    正在记录或 adapter 未退出时拒绝；失败整体回滚；无残留校验；
  - `end_reason`：user / adapter 原因 / failed / shutdown / startup_recovery。

- **直播历史搜索**
  - `GET /api/history/search`：主播（名称 + 稳定 ID）、标题（中日英/混合）、观众（稳定 ID + 昵称 + 历史昵称）；
  - 同名不同 ID、跨平台同名分别返回，绝不合并；匿名消息不生成观众结果并明确提示；
  - 结果说明主播/标题/观众匹配原因；观众匹配显示本场消息数，可下钻最近 50 条发言；
  - 平台 / 状态 / 日期范围 / 包含归档筛选可组合；默认倒序；20 条/页“加载更多”；
  - `%`/`_` 按字面匹配；不读取聊天正文。

- **UI**
  - 历史列表工具栏、行内 `···` 菜单；详情标题区同一菜单；
  - 共享 `dialog.js` 与 `actions-menu.js`；键盘/触屏/窄屏、焦点返回、视口夹紧；
  - 三语新增完整文案；v0.7.0 截图与 UI 验证脚本。

### 变更

- 新增 `src/server/session-admin.mjs`、`src/analytics/sessions/history-search.mjs`、
  `src/web/js/{dialog,actions-menu,session-actions}.js`；`history.js` 重写。
- `/api/sessions` 支持 `includeArchived` / `archivedOnly`，默认隐藏归档；AI 页面显式包含归档。
- 两个停止端点共用 `stopSessionRecording`。
- schema **7**：新增 `archived_at`、`end_reason` 与 5 个历史/搜索索引；旧库原地升级，不重写历史行。

### 测试 / 构建

- 自动化：**318 passed / 0 failed / 约 25.0 秒**。
- 浏览器 UI：`verify-history-ui.mjs` **27/27**。
- EXE：90.4 MB / 106 资源，SHA-256 `9602c5607782ee72645f32019fbba7b28ca6cb6722bfd70c1bdeebed57877e1f`；
  `verify-exe.mjs` **10/10**；`--version` 0.7.0。
- 打包 EXE UI：`verify-exe-history.mjs` **19/19**（真实 v6→v7 升级、搜索、归档、重启保持、停止、删除、
  共享观众聚合、专属观众清理）。
- 本轮没有新增真实平台网络采集；v0.6.0 真实并发结果仍为历史样本。

### 已知限制

- 删除不可撤销、无回收站；未做批量归档/删除。
- 当前没有 AI 结果/画像表；未来 M6 必须把 AI 结果加入同一删除事务。
- 真实 UAC、真实文件夹选择、干净 Windows 环境、M5 备份仍未验证。
- 性能基线 1200 场 / 12000 事件，未做百万级或 10+ 场长时间压力。

## 0.6.0 — 2026-11-09（多直播间并发记录、标签页、Top 100）

### 新增

- **多直播间同时记录**
  - `SessionManager` 改为每个 `sessionId` 独立 recording/adapter/连接状态/结束回调；
  - 同一 `platform + room` 重复启动在内存与数据库双重拒绝，返回 `409 SESSION_DUPLICATE_ROOM`；
  - 停止、失败、自动结束只影响对应场次；启动恢复仍把所有残留 live 标记 interrupted；
  - 新 `GET /api/live/recordings`、`POST /api/live/recordings/:sessionId/stop`；
  - 平台 disconnect 支持 `sessionId`；同平台多场且缺 ID 时返回 409 `SESSION_ID_REQUIRED`。

- **直播记录标签页**
  - 顶部固定「＋ 新建记录」+ 可横向滚动的直播标签；
  - 标签显示主播/直播间名称、状态点与连接中/记录中/重连中/已停止/连接失败；
  - 切换标签只切视图，不改后台采集；`viewToken` 丢弃旧响应，避免串场；
  - 每场独立 Hero、统计卡、消息密度图、最近动态、Top 100 与经济支持；
  - 运行中标签不提供关闭按钮；已停止标签可关闭，数据保留在直播历史。

- **最活跃观众 Top 100**
  - 查询上限从 20 提到 100，排序 `message_count DESC, platform_uid, viewer_id`；
  - 新 `GET /api/sessions/:id/top-viewers`，返回固定 rank；
  - UI 默认约 10 行可视、区域滚动最多 100 名；搜索昵称/UID 保留 rank；
  - 点击观众进入 `/viewers/<id>?broadcaster=<当前主播>`；
  - schema v6 新增 `idx_viewer_sessions_speakers`。

- **启动器控制台默认英文**
  - 双击 EXE 时控制台输出英文，不再跟随网页语言；
  - `--lang zh-CN|ja|en` 仍覆盖；网页界面继续三语/跟随系统；
  - 多场时状态行显示“Recording N live streams”。

- **开发/验证工具**
  - `scripts/demo-multi-recording.mjs`：3 场模拟记录，仅用于 UI 截图/联调；
  - `scripts/verify-live-ui.mjs`：DevTools 协议验证标签、Top 100、搜索、档案跳转、重入、窄屏；
  - `scripts/verify-live-multi.mjs`：真实网络并发验证，支持 `--base` 附加到 EXE。

### 变更

- 所有事件仍统一经 `EventIngest`；去重作用域仍是 `(session_id, dedupe_key)`，因此同一 external id 可以合法存在于不同场次。
- `app.js` 移除全局 `livesummary` 轮询，避免每个事件触发全量 summary 查询。
- schema 6；旧库原地升级，历史数据不重写。

### 测试 / 构建

- 自动化：**296 passed / 0 failed / 约 24.5 秒**。
- UI：`verify-live-ui.mjs` **10/10**。
- EXE：90.3 MB / 101 资源，SHA-256 `cbf17f0c83d9af40003085c0f0acba8b3f9e12e4663bfe50f5bfc61965ec1598`；`verify-exe.mjs` **10/10**；`--version` 0.6.0。
- 真实并发：
  - 2 YouTube：80 / 63 事件，隔离 0 串场，重复启动 409；
  - YouTube + Bilibili room 6：76 / 11，停 A 后 B 收到新事件；
  - 3 场：85 / 66 / 6，停 A 后 2 场仍 connected；
  - EXE 附加 3 场真实直播：73 / 67 / 5，3/3 connected。

### 已知限制

- 运行中标签不能隐藏/关闭；必须先停止。没有静默停止。
- 无并发上限；未做 10+ 场数小时压力测试。
- 真实 UAC、真实同观众跨主播观测、Bilibili 礼物/SC/大航海真实样本仍未完成。

## 0.5.0 — 2026-11-09（文件夹选择器、YouTube 单一公开网页、管理员 EXE）

### 修复

- **“在新目录创建新的数据空间”误报校验失败**
  - 根因：staging 无条件复制旧 `livememory.db`，新空间实际打开的是旧库；表非空校验触发回滚。
  - 修复：仅 `migrate` 复制数据库；`new` 由 `createFreshDatabase()` 新建空库。
  - 新空间失败文案改为“创建新数据空间失败”，不再误称“迁移”。
  - 新增集成回归测试：新空间 0 场次/事件/观众，设置与凭据保留，原目录不动。

- **Windows「浏览」文件夹选择器**
  - 根因：旧实现通过 `execFile` 捕获 PowerShell stdout，在受限/打包环境中 `spawn EPERM`，脚本未执行。
  - 改为 `spawn(..., {stdio:'ignore'})` + 临时 UTF-8 结果文件 + `-EncodedCommand`；不依赖 stdout 管道。
  - 原生 `FolderBrowserDialog`（STA + owner form），取消不报错、不改变输入；脚本错误/超时显示可诊断错误。
  - 中文/空格路径、手动输入、迁移确认流程保持不变。

### 变更 / 删除

- **YouTube 只保留公开网页聊天**
  - 删除官方 Data API 客户端、OAuth 登录/回调/令牌存储、API Key 配置、官方适配器、`capture-mode` 与对应测试。
  - 删除 `/api/youtube/login/start|status|logout`；`/api/youtube/video|connect` 不再接受 `mode`。
  - 删除 `settings.youtubeCaptureMode`；旧 settings 中的键加载时忽略。
  - 直播页与设置页删除官方/实验模式切换、Google 登录、API Key/OAuth、配额、实验 badge；只保留链接输入、检查、开始、连接状态、保留说明。
  - 保留匿名 web 适配器的聊天/SC/Sticker/会员/gift/badge/稳定 Channel ID/去重/重连/自动结束/30 天保留。
  - 设置/隐私说明保留简短、真实的“非官方稳定 API、可能失效、无官方授权”提示。

- **管理员权限 EXE**
  - 构建时把 node.exe 的 RT_MANIFEST 从 `asInvoker` 改为 **`requireAdministrator`**。
  - 非提升进程启动最终 EXE 被 Windows 拒绝（EACCES）；UAC 批准后的真实启动未在无交互会话验证。
  - 启动器增加防御性管理员检查与三语提示；非权限错误仍单独显示。
  - 打包启动且当前默认目录无数据库时扫描本地用户配置，恰好一个使用、多个拒绝猜测；防止跨账号 UAC 静默建空库。

### 测试 / 构建

- 自动化测试 **277 通过 / 0 失败**；删除 5 个官方 YouTube 测试文件，新增选择器、manifest、管理员、profile scan、简化约束、新数据空间测试。
- EXE：90.2 MB / 99 资源，Manifest `requireAdministrator`，SHA-256 `3ac16ddc4b46e569bfe11b3146e72b874a120c8ade26c3a7b709f2ed40ecf099`。
- `verify-exe.mjs`：manifest + 9 功能场景 = 10/10；非提升会话使用临时 asInvoker 副本并明确标注。
- 真实 UAC 点击、真实文件夹选择、v0.5.0 真实 YouTube 采样未完成，见 STATUS/TEST_PLAN。

## 0.4.0 — 2026-11-08（Header 语言、数据目录迁移、清空/出厂、多主播档案）

### 新增

- **Header 语言快捷切换**
  - 顶栏外观切换旁新增语言控件：宽屏三个原生语言名 + 地球“跟随系统”，窄屏原生 select。
  - 与设置页共享同一份 `locale` 偏好；切换立即生效、持久化、不刷新页面。
  - 三语 `aria-label`；390px Header 无溢出；与主题切换互不干扰。

- **数据存储位置**
  - 设置页显示真实目录、来源、位置记录、可写状态、空间、占用与计数；支持修改、打开文件夹、刷新。
  - 两种模式：迁移现有数据（推荐）/ 在新目录创建新数据空间；旧目录永不自动删除。
  - 位置记录 `data-location.json`（LOCALAPPDATA，APPDATA 镜像）；目标必须存在且含数据库，断盘时不创建空库。
  - 迁移：WAL checkpoint、staging 复制、SQLite integrity/表计数/schema/文件 SHA-256、运行时重建、单实例锁转移、失败回滚。
  - 原生目录选择器（固定 PowerShell + WinForms）、OneDrive/云同步/临时/长路径警告、UNC 拒绝、系统目录拒绝。
  - CLI：`--forget-data-location`。

- **清空数据与恢复出厂设置**
  - 数据管理危险区；`data` 模式保留设置/凭据/位置记录/备份/无关文件；`factory` 额外清除偏好/凭据/日志/缓存并恢复默认。
  - 必须输入 `DELETE` / `RESET`；记录中禁止；默认创建 `VACUUM INTO` 数据库快照到数据目录之外。
  - 事务删除 + `VACUUM` + WAL checkpoint + 运行时重建；数据库保持 schema 5 的空库。
  - 清空后不会从缓存重新出现旧观众。

- **多主播观众档案（schema v5）**
  - 新表 `broadcasters`、`viewer_broadcasters`、`viewer_broadcaster_currency_totals`；`sessions.broadcaster_id` / `broadcaster_identity`。
  - 主播身份：YouTube channelId；Bilibili anchor uid，缺失时 room fallback；mock；无法确定保留 unresolved。
  - 同一平台观众身份全局唯一，主播 × 观众互动上下文独立；发言/付费/币种按主播分账。
  - 观众页主播范围选择器、搜索、排序、新/回访观众；详情页参与主播切换与全局概览。
  - API：`/api/broadcasters`、`/api/broadcasters/:id`、`/api/broadcasters/:id/viewers`、范围化 `/api/viewers`。
  - AI 包：`session_context.broadcaster`、`viewer_context[].broadcaster_context`、`lifetime`、`other_broadcaster_count`；指令新增主播上下文隔离规则。

- **测试与构建**
  - 自动化测试 **305 通过 / 0 失败**；新增 broadcaster、header-language、broadcaster-identity、storage-management 测试。
  - EXE **90.3 MB / 103 资源**，SHA-256 `4aae59fe6f8d0a6cdc13811d27cc732e1e17cd6a6dac5d5fa4da450efbb1387f`；`verify-exe.mjs` **9/9**。
  - 18 张新截图。

### 未包含 / 未验证

- 旧 YouTube 场次无法确认主播时保持 unresolved；没有手动归属 UI。
- 映射网络盘（盘符）未自动识别；真实断盘/断电/磁盘写满迁移未做物理演练。
- 清空文件删除为尽力而为；M5 可移植备份、M6 AI 导入仍未实现。
- 未扩展 YouTube 未公开接口；匿名模式仍默认关闭、显示风险提示。
- EXE 未在第二台干净 Windows 验收；未 Push。

## 0.3.0 — 2026-11-08（YouTube 免登录实验接入与真实双房间验证）

### 新增

- **YouTube 免登录公开网页聊天（实验性，默认关闭）**
  - 新增 `src/platforms/youtube/anonymous/`：watch 页、`live_chat` 页、`get_live_chat` continuation、actions 解析。
  - 不发送 Cookie、OAuth token 或用户 API Key；只用公开页面自身的 client context 与 Web key。
  - 真实字段：`external_id`、`timestampUsec`、`authorName`、`authorExternalChannelId`、`authorBadges`、`message.runs`、`purchaseAmountText`、`giftMessageViewModel`。
  - 文字、Unicode Emoji、自定义表情代码、badge、Super Chat、Super Sticker、会员、gift 映射到现有 canonical event。
  - Continuation 更新、400/`failedPrecondition` 重开、429/网络退避、60 秒直播状态检查、自动结束。
  - 相邻消息时间跳变 > 90 秒标记 `gapSuspected`，UI 只说“可能漏消息”。

- **稳定身份与金额**
  - 聊天/SC 使用 `youtube:<channelId>`；新版 gift 无 Channel ID 时 `viewer_uid=null`，不按昵称合并。
  - 格式化金额仅在币种可确认时解析；沿用整数最小单位；保留 `amount_display` 原文；无法确认则金额未知。
  - 会员等级、gift 数量、赠送会员不换算金额。
  - ticker 展示不产生事件，避免 Super Chat 重复累计。

- **schema v4**
  - `events.badges TEXT`：owner/moderator/verified/member，可空。
  - `events.amount_display TEXT`：平台显示金额字符串，可空。
  - v1→v4 迁移测试；旧行为 NULL。

- **保留策略收紧**
  - `youtubeRawRetentionDays` 从 1–3650 改为 **1–30**，默认 30。
  - 清理原文、emotes、badges、amount_display 与过期 YouTube 昵称历史/当前昵称。
  - 保留计数、稳定 Channel ID 与金额合计；明确不等于完全删除个人数据。

- **界面**
  - 默认官方模式；无官方凭据时显示真实原因与“启用免登录实验模式”按钮。
  - 实验模式 warning：非官方接口、可能违反 YouTube ToS、可能随时失效。
  - 设置页新增 YouTube 接入卡；高级设置可切换官方/实验模式。
  - 动态流显示 badge；录制页显示实验模式、消息数与可能漏消息提示。
  - 三语、明亮/黑暗/跟随系统、390px 响应式。

- **测试与验证**
  - 自动化测试 259 → **287**；新增匿名 parser、adapter 重连、HTTP 集成、v1→v4 迁移、retention badge/nickname、settings 模式。
  - 真实房间 `FKLZiufsCk0` 35 秒：86 事件、86/86 Channel ID、1 笔 HKD 200000 SC、49 badge、0 错误。
  - 真实房间 `gXawf8GZDI8` 35 秒：100 事件、chat 87/87 Channel ID、13 gift（无身份/金额）、3 badge、0 错误。
  - EXE 90.2 MB，SHA-256 `9d586aa9…`，`verify-exe.mjs` 9/9；EXE 内真实匿名 72 条事件、72/72 Channel ID、0 错误。

### 尚未包含 / 未验证

- **匿名路径合规未确认，且很可能违反 YouTube ToS**；因此不是默认功能，正式发布前必须评估/取得许可。
- 官方 API 真实凭据下的直播采样与并排对照仍未完成。
- Super Sticker、会员、赠送会员没有真实匿名样本。
- 真实 429、验证码、consent/age wall、长时断网、数小时直播未验证。
- 30 天清理不等同于完全删除个人数据；严格删除模式未实现。

## 0.2.0 — 2026-11-08（YouTube Live 接入；并包含上一轮的表情兼容与 AI 分析中心通用化）

### 新增（本轮：YouTube Live）

- **真实的 YouTube Live 接入（仅直播）**
  - 直播定位：`videos.list` + `liveStreamingDetails`，支持 `watch?v=`、`/live/`、`youtu.be`、`embed`、`shorts`、裸视频 ID；普通视频、未开始、已结束、聊天关闭、私密/无权限、配额不足、网络错误都有独立提示。
  - 聊天传输：`liveChatMessages.list` + `nextPageToken`，遵守 `pollingIntervalMillis`；断线指数退避重连且**不结束场次**；`offlineAt` / `chatEnded` / `chatDisabled` 才结束；本地配额守卫。
  - 身份：`youtube:<channelId>`；只有昵称时 `viewer_uid=null`，不建档案、不按昵称合并。
  - 经济事件：Super Chat、Super Sticker、新会员、会员里程碑、赠送会员、收到赠送会员；`amountMicros` 用 BigInt 转最小货币单位，`JPY` 等零小数币种正确；多币种分别累计。
  - 会员等级/月数/赠送数量**不换算金额**；收到赠送会员的用户 `is_paid=false`，不再是付款者。
- **两种官方凭据模式，普通主播零 API Key 配置**
  - 公开直播模式（`api-key`）：应用级 API Key 匿名读取公开聊天，无需 Google 登录、无需 OAuth。
  - OAuth 模式：桌面应用 PKCE + 系统浏览器 + `127.0.0.1` 单次回环回调 + `state` 校验 + 5 分钟超时；自动刷新、重启恢复、失效提示、重新登录、退出登录（并 revoke）。
  - 凭据不进入仓库与默认构建；可用环境变量或数据目录私有文件提供；缺配置时界面明确说明，不伪造登录。
  - 令牌 AES-256-GCM 加密保存在 `<数据目录>\secrets\youtube-oauth.json`；`status()`、日志、AI 包、备份均不含令牌。
- **数据保留策略**
  - YouTube 公开聊天原文默认 30 天后自动清理（启动、场次结束、手动触发）；保留计数、身份、昵称历史与币种合计。
  - SQLite schema v3：`sessions.platform_started_at`（平台直播开始时间），用于相对直播时间。
- **界面**
  - 直播记录新增「YouTube 直播」标签：模式/登录状态、链接输入、检查结果、频道、当前观看、API 配额、保留策略与手动清理。
  - 录制中显示 YouTube 连接状态与当前观看人数；动态流支持 Super Sticker 与会员里程碑留言。
  - 三语（zh-CN / ja / en）、明亮/黑暗/跟随系统、390px 窄屏全部覆盖。
- **AI 分析包**
  - `session_context.session.broadcast_started_at` 与 `messages.jsonl.offset_seconds`（相对直播时间）。
- **计数修正**
  - `payment_event_count` 只在 `is_paid=true` 时累加：免费礼物与「收到赠送会员」不再计入付费事件。

### 新增（上一轮，随本版本发布）

- **Unicode Emoji 与平台表情**
  - `cleanText` / `truncateText` 改为按 grapheme 截断，组合 Emoji、变体选择符、肤色修饰符与 ZWJ 序列不会再被截断成乱码。
  - canonical event 新增可选 `emotes` 元数据（`id` / `code` / `name` / `source`），仅来自平台可靠字段。
  - SQLite schema v2：`events.emotes TEXT`，v1 旧库原地升级，旧消息 `emotes=NULL`。
  - Bilibili：识别 `DANMU_MSG.info[0][13]`，保存 `emoticon_unique` 与 `info[1]` 文字标签；无元数据时普通 `[文字]` 不误判。
  - 只有表情、没有正文的消息也会入库；UI 与 AI 包使用名称/id 回退。
  - 未知表情标记 `[未知平台表情：emote_id=…]`，不猜测情绪，不下载图片。
  - YouTube 离线 mapper 预留：文本、Unicode Emoji、`:code:` 自定义表情、稳定 channelId；明确标记未真实接入。

- **AI 分析包（文本优先）**
  - `session_context.emote_dictionary` 去重表情字典；`messages.jsonl` 使用 `emote_refs`。
  - 仅在原文不足时生成 `content_ai`，避免重复名称导致包膨胀。
  - `manifest.counts` 增加 `messages_with_emotes` / `emote_kinds`。
  - 三语 `instructions.md` 增加 Emoji/平台表情规则、未知表情禁止猜测、礼物不代表话题偏好、单表情不足以建立长期兴趣。

- **AI 分析中心通用化**
  - 界面统一为 AI 分析中心 / AI 分析包 / AI 分析指令 / AI 分析结果 / 导入 AI 分析结果，不再绑定 ChatGPT。
  - 新增自然语言任务说明卡（整场话题、时间变化、回看片段、新观众、既有观众画像）。
  - 三语 AI 分析指令由软件按任务生成，用户无需手写提示词。
  - 明确“使用你选择的 AI 服务”，不假设通用 AI 网站。

### 修复

- 聊天文本截断可能切断 surrogate pair / ZWJ 序列的问题。
- 精简清理现在同时清除 `content` 与 `emotes`，不残留聊天元数据。

### 测试

- 自动化测试从 195 增至 **259**：新增 YouTube 链接解析、官方错误映射、配额计费、PKCE/回环/令牌交换与刷新、登录状态机与重启恢复、令牌加密与篡改、全部经济事件、`amountMicros` 多币种、轮询/重连/结束/配额守卫、保留策略、v1→v3 迁移，以及本地假 API 的端到端。
- 真实 Bilibili 房间 `5050` 采样：21/32 条 `DANMU_MSG` 带 `info[0][13]`，`info[1]` 为文字标签，`dm_v2` 为空。
- EXE 重建（90.1 MB，SHA-256 `8af88e25…`），`verify-exe.mjs` 9/9。

### 尚未包含 / 未验证

- **YouTube 真实凭据下的直播采样**：本轮没有可用的 API Key 或 OAuth 客户端，真实消息条数、稳定身份比例、真实 Super Chat/会员样本均未取得。
- YouTube 真实断网、配额耗尽、真实 OAuth 同意屏与 refresh token 过期规则未在线验证。
- AI 结果导入、Schema 校验、分批与长期画像（M6/M7）。
- 表情图片下载、缓存与显示。
- Bilibili `SEND_GIFT_V2`、礼物/SC/大航海真实事件复核。

## 0.1.0 — 2026-11-08（首个可运行版本）

### 新增

- **Windows 启动器**
  - 环境检查（Node ≥ 22.5、`node:sqlite`）
  - 数据目录解析与可写探测：`%LOCALAPPDATA%\LiveMemory`
  - 单实例锁与陈旧锁接管
  - 端口自动选择（47800 起，冲突顺延，最后系统分配）
  - 服务就绪后再打开系统默认浏览器
  - 中文 / 日本語 / English 命令行，跟随系统语言并读取已保存偏好
  - UTF-8 控制台
  - 优雅退出（停止记录、WAL checkpoint、关闭数据库）
  - 崩溃后恢复：把遗留场次标记为“已中断”

- **网页控制台（Apple 风格）**
  - 直播记录、直播历史、观众档案、AI 分析中心、设置
  - 明亮 / 黑暗 / 跟随系统，首帧无闪烁，持久化并响应系统变化
  - 三语界面，语言切换即时生效并持久化
  - 响应式布局（桌面、窄窗、平板、手机）
  - 消息密度图（Canvas，自适应粒度）、实时事件流、最活跃观众
  - 单场详情：统计、支持、时间线、存储信息、AI 占位
  - 观众详情：稳定 ID、昵称历史、累计支持、参与场次、重点关注

- **本地记录引擎**
  - SQLite（`node:sqlite`，WAL）与版本化迁移
  - 统一事件模型与单一写入管线
  - 重复事件去重（唯一键 + 指纹），金额与计数不会翻倍
  - 按币种 + 实际支付/展示价值分账
  - 稳定观众身份（`platform:uid`）与昵称历史
  - 模拟直播：聊天、免费/付费礼物、醒目留言、大航海、故意重复投递

- **AI 分析包导出（`livememory-analysis-v1`）**
  - 单文件 ZIP：manifest、场次上下文、messages.jsonl、观众上下文、三语提示词、结果 Schema
  - 内容文件 SHA-256 校验
  - 导出记录与分析状态

- **Windows EXE**
  - Node SEA + postject，可见控制台，内置运行时与 SQLite
  - 资源解压到数据目录（不可写时回退临时目录）

- **工程**
  - 零运行时依赖，无前端构建
  - 86 个自动化测试（单元 + 集成）
  - 完整文档体系与 ADR

### 尚未包含（按路线图）

- 真实 Bilibili / YouTube 接入（M3）
- AI 结果导入与 Schema 校验（M6）
- 长期 AI 观众画像（M7）
- 可移植备份与跨电脑恢复（M5）
- 自动清理原始弹幕（M4/M6）
- 韩语 / 西班牙语

### 已知问题

- 未在第二台干净 Windows 设备验收
- EXE 未签名
- 真实 Ctrl+C 未自动化验证
- 动态端口不回写设置
