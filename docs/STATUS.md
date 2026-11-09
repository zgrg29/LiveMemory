# 工程状态（STATUS）

最后更新：2026-11-09（多直播间并发记录、直播标签页、Top 100 排行榜，版本 0.6.0，schema 6）

> 本文件是唯一进度来源。只要代码与本文不一致，以代码与实测为准，并立即修正本文。

## 1. 当前阶段

- 里程碑：**M0 / M1 / M2 核心 / P0 / P1 / P2 / P3 / P4 完成；M3 真实接入继续验证；M4 / M7 部分推进；M5 / M6 未完成**
- 版本：`0.6.0`（`package.json` 与 `src/shared/app-info.mjs` 一致）
- 数据库 schema：**6**（新增 `idx_viewer_sessions_speakers`；旧库原地升级，历史场次/观众/画像兼容）
- 分支：`main`，本地提交，未 Push
- 发布形态：`LiveMemory.exe`，RT_MANIFEST **requireAdministrator**

## 2. 本轮完成（2026-11-09）

### 2.1 多直播间同时记录

- `SessionManager` 从“单场 + 单 adapter”改为 `recordings: Map<sessionId, recording>`：
  - 每场拥有独立 adapter、连接状态、detail、直播场次 ID、数据库 session、事件闭包与结束回调；
  - `startPlatform` / `startSimulation` 在写入前同时检查内存与数据库，同一 `platform + room` 重复启动返回 `409 SESSION_DUPLICATE_ROOM`；
  - `stopSession(sessionId)` 只停止指定场次；某场 adapter 结束、启动失败或连接失败只结束该场；
  - 启动时 `recoverInterrupted()` 仍把所有残留 `live` 标记为 `interrupted`，不会自动创建新场次；
  - 关闭进程时逐场停止并兜底清理 orphan live 行。
- 事件隔离：每个 adapter 的 `onEvent` 闭包强制写入自己的 `session.id`；统一经过 `EventIngest`，保留 `(session_id, dedupe_key)` 去重、观众/主播聚合与金额累计规则。
- 平台服务解耦：
  - `BilibiliService` / `YouTubeService` 不再持有唯一 adapter 或唯一房间；
  - `connect` 只负责校验与创建 adapter，生命周期交给 `SessionManager`；
  - `disconnect` 接受 `sessionId`；同一平台存在多场且未指定 ID 时返回 `SESSION_ID_REQUIRED`，不会误停；
  - YouTube 自动结束仍会写 `lastEnd` 并执行 30 天保留清理。
- 新 API：
  - `GET /api/live/recordings`：所有运行中任务的独立状态、消息数、独立观众、支持、元数据；
  - `POST /api/live/recordings/:sessionId/stop`：按场次停止；
  - `GET /api/sessions/:id/top-viewers?limit=100&query=`：单场排行榜；
  - `/api/sessions/current` 保留为“最近开始的一场”，仅用于兼容；标签页不再依赖它。
- SSE `status` 现在包含 `recordings` 数组与 `activeCount`；事件帧仍带 `sessionId`，前端按会话归属。
- SQLite 仍为单进程同步串行写入，`busy_timeout=5000`，事件与聚合同事务；并发 adapter 不会产生跨场写入。

### 2.2 直播记录页面标签页

- 顶部固定「＋ 新建记录」，右侧为可横向滚动的直播标签；新建按钮独立于滚动区，窄屏始终可见。
- 每个标签显示主播名/直播间名、状态点与短状态：连接中 / 记录中 / 重连中 / 已停止 / 连接失败。
- 切换标签只切换当前视图；服务端采集与前端页面完全解耦，切换页面、刷新浏览器、关闭页面都不会停止其他任务。
- 每个场次使用递增 `viewToken` 丢弃过期异步响应，旧标签的 summary/feed/leaderboard 响应不会覆盖新标签。
- 停止记录只影响当前场次；hero 中明确提示“只停止当前这一场”。
- 运行中的标签不提供关闭按钮，避免用户误以为关闭标签会保留后台记录；结束/失败的标签显示 `×`，关闭仅移除已停止的标签且数据已在直播历史中。
- 页面重新进入时从 `/api/live/recordings` 恢复所有运行中任务；软件重启后不会恢复为“记录中”。
- 移动端 390px、平板与桌面均无横向溢出；标签区独立滚动。

### 2.3 最活跃观众 Top 100

- `topSessionViewers` 上限由 20 提到 **100**；
- 固定排序：本场有效弹幕数（chat + super_chat）降序 → `platform_uid` → `viewer_id`；昵称不参与身份与次级排序；
- 新 `buildSessionLeaderboard` 返回 `rank`、`viewerId`、昵称、平台 UID、本场消息数、付费事件数；当前场次只有 N 位有效观众时只返回 N 位；
- 新 schema v6 索引 `idx_viewer_sessions_speakers (session_id, message_count DESC)`；
- 前端默认显示约 10 行，容器固定最大高度并可滚动查看最多 100 名；支持当前场次搜索（匹配昵称或稳定 UID）、显示“显示 X / Y 名”；
- 点击观众跳转 `/viewers/<id>?broadcaster=<当前主播>`，保留主播上下文；
- 排行榜每约 4 秒刷新，事件触发时 2.5 秒节流，并在内容签名未变化时跳过 DOM 重建；
- 排行榜只属于当前场次，不读取长期累计或跨主播统计。

### 2.4 启动器控制台默认英文

- 双击 EXE 时启动器控制台默认输出英文，不再跟随网页界面保存的语言；
- `--lang zh-CN|ja|en` 仍可显式切换控制台语言；
- 网页界面继续保留系统语言检测和三语切换，二者互不覆盖；
- 多场记录时状态行显示“Recording N live streams”。

### 2.5 文档/工具/版本

- 新增 `scripts/demo-multi-recording.mjs`（仅供开发/截图，3 场模拟记录，不进入产品路径）；
- 新增 `scripts/verify-live-ui.mjs`（DevTools 协议验证标签切换、Top 100 搜索/滚动、档案跳转、页面重入、窄屏）；
- 新增 `scripts/verify-live-multi.mjs`（真实网络并发验证；支持 `--base` 附加到已运行的 EXE 服务）；
- 版本号升至 `0.6.0`；schema 升至 `6`。

## 3. 自动化测试（本轮实测）

- 全量：**296 passed / 0 failed / 约 24.5 秒**（`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`）。
- 新增/更新：
  - `tests/integration/session-multi.test.mjs`：两场独立 adapter/会话/事件、重复房间拒绝、停止 A 后 B 继续、A 失败不影响 B、交错写入 100×2 事件去重与计数、启动恢复标记 interrupted、Top 100 稳定排序/搜索/昵称不合并、summary `topLimit`。
  - `tests/integration/live-api-multi.test.mjs`：本地假公开网页的两个 YouTube 直播，HTTP 级验证双场连接、事件归属、关闭浏览器 SSE 后两场仍运行、重复 409、Top 100、共享观众跨主播上下文、停止 A 后 B 继续接收、停止 B、重启后无运行任务且残留行 interrupted。
  - `tests/unit/live-multi-ui.test.mjs`：前端使用多场 API、`viewToken`、标签/排行榜容器、无 innerHTML、无旧单场轮询。
  - `tests/unit/launcher.test.mjs`：控制台默认英文、显式 `--lang` 覆盖、多场状态行。
  - `migration-emotes.test.mjs` / `broadcaster-identity.test.mjs`：schema 6。
- 新增 UI 验证：`scripts/verify-live-ui.mjs` **10/10 通过**（3 个模拟标签、100 行滚动、搜索、档案跳转、页面重入、390px 新建按钮可见且无横向溢出）。最后一次完整运行后，排行榜增加了“刷新时保持滚动位置”的改进；该改进由 `live-multi-ui.test.mjs` 静态守卫覆盖，最终复跑时本机无头浏览器未能再次启动，未重新做浏览器实测。

## 4. 真实直播并发验证（2026-11-09）

以下是真实网络结果，不是模拟数据；数据目录使用 `tests/.tmp` 并在结束后删除。只记录聚合，不保存/展示聊天正文或昵称。

| 场景 | 结果 |
| --- | --- |
| 两个 YouTube 直播（Lofi Girl + Al Jazeera English 当日直播） | 2/2 connected；事件 80 / 63；跨场 `wrongSession=0`；重复启动 409；停止 A 后 B 仍 connected（该时段 B 聊天安静，20 秒内无新消息） |
| 一个 YouTube + 一个 Bilibili（room 6） | 2/2 connected；事件 76 / 11；`wrongSession=0`；停止 A 后 B 收到新事件（+1），仍 connected |
| 三个同时（2 YouTube + Bilibili room 6） | 3/3 connected；事件 85 / 66 / 6；`wrongSession=0`；重复启动 409；停止 A 后剩余 2 场仍 connected，B 收到新事件（+1） |
| 构建后的 EXE（asInvoker 副本，附加同一组三个真实直播） | 3/3 connected；事件 73 / 67 / 5；`wrongSession=0`；重复启动 409；停止 A 后剩余 2 场仍 connected；B 在 20 秒内无新消息但保持连接 |

说明：
- 真实直播的聊天活跃度不同；B 未收到新消息时只能确认连接状态仍为 connected，不能伪称“持续收到消息”。
- 本环境未运行真实 UAC 同意后的最终 EXE；功能场景使用同一二进制的临时 asInvoker 副本，manifest 对最终 EXE 单独验证。

## 5. EXE / 构建

- 构建：`node scripts/build-windows.mjs`（Node v24.21.0）
- 当前构建：**90.3 MB，101 资源**，SHA-256 `cbf17f0c83d9af40003085c0f0acba8b3f9e12e4663bfe50f5bfc61965ec1598`
- Manifest：`requireAdministrator`（实际 PE 补丁）
- `scripts/verify-exe.mjs`：**10/10 通过**；`--version` 输出 `LiveMemory 0.6.0`；非提权会话使用临时 asInvoker 副本并明确打印该事实。
- 额外验证：使用 EXE asInvoker 副本附加 3 个真实直播 API 验证通过（见 §4）。

## 6. 未完成 / 未验证

- **真实 UAC 交互**：当前会话非管理员，未点击 UAC 同意；最终 EXE 仅验证未提升启动被 Windows 拒绝与 manifest 内容。
- **真实文件夹选择器人工点击**：无交互桌面；逻辑测试保留。
- **真实 UAC 后的数据目录/迁移/SQLite 写入**：未在当前会话完成。
- **同一真实观众跨两个主播的实测**：自动化 DB/HTTP 测试覆盖“全局身份 + 主播独立上下文”，真实直播未恰好观测到同一 Channel ID 出现在两场；不得声称已完成真实观测。
- **真实 Bilibili 经济事件**：本轮真实 room 6 仅收到普通弹幕，未观测礼物/SC/大航海；既有结论仍以历史样本为限。
- **运行中标签的关闭/隐藏**：本版本明确不支持；必须先停止记录，再关闭已停止标签。这是为避免“关闭标签却仍在偷偷记录”的歧义。
- **并发上限**：没有人为限制；实际能力取决于网络、CPU、SQLite 与平台限流。未做 10+ 场长时间压力测试。
- **YouTube 公开网页路径**：不是官方稳定 API，可能失效；未做 ToS/合规结论。
- **干净 Windows 虚拟机、代码签名、升级/回滚**：未完成。

## 7. 相关文档

`docs/ARCHITECTURE.md`、`docs/DATA_MODEL.md`、`docs/UI_DESIGN.md`、`docs/TEST_PLAN.md`、`docs/CHANGELOG.md`、`docs/DECISIONS.md`、`docs/PLATFORM_INTEGRATIONS.md`、`docs/WINDOWS_RUNTIME.md`、`README.md`、`AGENTS.md` 与 `log/2026-11-09-multi-live-tabs-top100.md` 已同步本轮变化。

## 8. 下一步

1. 在真实管理员桌面完成 UAC、文件夹选择、迁移与重启验证。
2. 继续用真实直播检验 Top 100 排名、长时间多场稳定性与 Bilibili 经济事件。
3. 增加可选的并发保护/资源提示（不是人为限制），以及运行中标签的显式“隐藏但继续记录”交互（若产品需要）。
4. 继续 M6 AI 结果导入；不要恢复官方 YouTube 双轨实现。
