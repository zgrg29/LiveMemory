# 工程状态（STATUS）

最后更新：2026-11-10（P7 自动直播监听与持久化 Tab，版本 0.10.0，schema 11）

> 本文件是唯一进度来源。只要代码与本文不一致，以代码与实测为准，并立即修正本文。

## 1. 当前阶段

- 里程碑：**M0 / M1 / M2 核心 / P0–P6 / M6 / M7 核心 / P7 完成**；M3 真实接入继续验证；M4 部分完成；M5 未完成
- 版本：`0.10.0`（`package.json` 与 `src/shared/app-info.mjs` 一致）
- 数据库 schema：**11**（新增自动监听目标；v10 原地升级，旧数据不改写）
- 分支：`main`，本地提交，未 Push
- 发布形态：`LiveMemory.exe`，RT_MANIFEST **requireAdministrator**（本轮已构建 v0.10.0，但本机无法执行验收，见 §5）

## 2. 本轮完成（2026-11-10，v0.10.0，P7）

### 2.1 产品行为与不变量

- 监听 Tab **对应 Bilibili 直播间 / YouTube 频道，而不是单场直播**。关播后 Tab 保留；下一次开播在同一个 Tab 中创建新的独立 `sessions` 行。
- 添加一次目标即可长期等待；软件重启后恢复目标（错峰检查），但不要求软件关闭时继续监听。
- 四件事互相区分：**关闭 Tab**（只对手动结束场次可用）、**暂停监听**（不开始新场次，当前记录继续）、**停止当前记录**（只结束本场）、**删除监听目标**（记录中拒绝）。
- **网络断线不等于直播结束**；同一场重连继续使用原 session，只有下一次确认 `live` 才创建新 session。
- 自动记录产生的是普通场次：可查看聊天/观众/统计、导出 AI 分析包、导入结果、参与 M7 长期观众记忆。

### 2.2 数据模型（schema 11）

| 变更 | 说明 |
| --- | --- |
| `monitor_targets` | 持久目标：platform、target_key、显示名/输入、broadcaster_id、enabled、state、next_check_at、last_check_at、last_live_at、last/active_session_id、失败次数、错误码、meta_json |
| `sessions.monitor_target_id` | 本场由哪个目标产生；手动连接为 NULL。不是外键：删除目标/场次都不删除对方 |
| 索引 | `(enabled, state, next_check_at)` 调度；`broadcaster_id, updated_at DESC`；`(monitor_target_id, started_at DESC)` |
| 唯一约束 | `UNIQUE(platform, target_key)`；重复添加返回 409 |

数据管理联动：删除场次清空目标指针；删除目标只清空历史指针；清空数据/恢复出厂删除全部目标；数据目录迁移沿用现有数据库迁移。

### 2.3 统一监听核心（`src/monitoring/`）

| 文件 | 职责 |
| --- | --- |
| `constants.mjs` | 平台策略（间隔/抖动/退避/阈值/请求间隔）、状态与稳定错误码、三语 messageKey |
| `model.mjs` | 状态派生、抖动/指数退避、目标序列化、错误分类、摘要 |
| `manager.mjs` | 目标 CRUD、调度 tick、检查、创建/借用 session、结束归位、暂停/恢复/重试、重启恢复 |
| `pacer.mjs` | 每平台串行请求节流（Bilibili ≥1.2s，YouTube ≥2.5s） |
| `youtube-discovery.mjs` | 纯解析：频道输入、频道身份、`/live` 页面分类、RSS |
| `detectors/bilibili.mjs` | 房间输入规范化、`roomInit`/`roomInfo`、`roomStatus` 检测与错误映射 |
| `detectors/youtube.mjs` | 公开频道页网络层、`/live` 检测、结构损坏时的 RSS + watch 页确认回退 |

状态机：`waiting → checking → connecting → recording → ending → waiting`，另有 `paused` 与 `error`。公开视图在连接 `reconnecting` 时显示 `reconnecting`，但数据库仍保持 `recording`，避免把重连写成新一场。

调度：5 秒 tick；启动/恢复错峰 0–45 秒；新增目标 0.5–3 秒后首次检查；最多 2 个并发；到期按 `next_check_at` 排序；已记录目标不参与轮询。

### 2.4 Bilibili

- 接受直播间 URL、短房间号、真实房间号；添加时 `room_init` 规范化，保存主播名/UID 与真实房间号。
- 等待开播时只查询公开 `room/v1/Room/get_info` 的 `live_status`（每约 60 秒，45–90 秒抖动）；**不使用弹幕连接/心跳判断开播**。
- `live_status=1` → `connectResolved`，复用现有 WebSocket 适配器（适配器会再次校验）；`0` 等待，`2`（轮播）等待。
- 下播仍由现有适配器确认（WS `LIVE`/`PREPARING` + 60 秒状态查询 + 两次有效离线）；监听器不越权结束记录。
- 429/-352/超时/异常响应只退避，不结束场次；4 次连续失败进入可见 `error`，30 分钟后低速重试。

### 2.5 YouTube（最终路线）

- **不使用 Google Data API、OAuth、API Key、Cookie 或登录。**
- 目标为稳定频道 ID：频道 URL、`@handle`、`/c/`、`/user/`、裸 Channel ID、已知视频链接（公开 watch 页反查频道）。
- 等待开播时请求公开 `/channel/<id>/live`：直播时页面内嵌 `ytInitialPlayerResponse`；必须同时满足视频 ID 合法、`channelId` 匹配、`isLive`/`isLiveNow` 为真才创建会话。预定直播只等待；首映/普通视频/回放/已结束不算直播。
- 页面结构解析失败时回退到频道 RSS（最近 6 小时）+ 最多 2 个候选视频的公开 watch 页确认；RSS 条目本身不会被判定为直播。
- 检测频率约 180 秒（120–240 秒抖动），即约 15–30 次/小时/频道；429 使用 `Retry-After`，否则 5 分钟起；连续失败指数退避至 30 分钟。
- 调研（streammon / livestream_saver / yt-dlp / pytchat）、许可证与真实页面实测见 `docs/YOUTUBE_AUTO_DISCOVERY.md`。
- 2026-11-10 用真实频道 `@LofiGirl` 做了少量只读验证：身份解析为 `UCSJ4gkVC6NrvII8umztf0Ow`，`/live` 返回 `live`、视频 ID 与标题。该结果只代表调查时可解析，**不是长期稳定性保证**。

### 2.6 会话与 M6/M7 兼容

- 自动场次使用同一 `SessionManager`、同一 `EventIngest`、同一 `sessions` 表；`sessions.monitor_target_id` 只是附加关联。
- `buildSessionSummary`、`serializeSessionRow`、`liveRecordingOverview` 暴露 `monitorTargetId`，前端据此把场次归入监听 Tab。
- 自动场次导出 `livememory-analysis-v1` 的回归由自动化测试覆盖；它不会绕过 M6 校验，也不会改变 M7 的 `broadcaster × viewer` 记忆规则。

### 2.7 界面

- 直播页 Tab 分两层：**持久监听目标 Tab**（最左，带 `◎` 标记与状态）→「＋ 新建记录」→ 手动场次 Tab；由目标产生的场次不再额外生成 session-only Tab。
- 目标视图：状态、平台与目标 ID、检查频率、上次/下次检查、上次直播、错误原因与下次重试、最近 10 场（可进入历史详情）、暂停/恢复/立即检查/删除。
- 记录视图：显示「自动监听」标记；停止记录提示只结束本场；平台确认关播后提示已保存且目标保留。
- 新建记录面板：Bilibili / YouTube 都有「自动监听此直播间 / 频道」复选框；勾选后输入 URL / @handle / Channel ID，按钮变为「添加自动监听」。默认不勾选，保留原手动连接行为。
- 删除目标使用确认弹窗，明确说明历史场次不会删除；记录中删除会显示服务端原因。
- 三语（zh-CN / ja / en）、明暗主题、窄屏布局；所有文本 `textContent`，无 `innerHTML`，样式只用 tokens。

### 2.8 API

```text
GET    /api/monitoring                          目标列表 + 摘要 + 平台策略
POST   /api/monitoring                          {platform, input, autoMonitor?}
PATCH  /api/monitoring/:id                      {action: pause|resume|retry | enabled}
POST   /api/monitoring/:id/check                立即检查（仍走同一检测器/状态机）
DELETE /api/monitoring/:id                      {confirm:true}；记录中 409
GET    /api/monitoring/:id/sessions?limit=      该目标产生的场次
```

`/api/status`、`/api/bootstrap` 增加 `monitoring`（enabled、summary、policy、capabilities）。

## 3. 自动化测试（本轮实测）

- 全量：`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`
  → **484 passed / 0 failed**（单进程模式，约 70 秒）。
- 本轮新增 8 个测试文件：
  - `tests/unit/monitoring-bilibili-detector.test.mjs`：房间号/URL/blanc 解析、短号→真实房间号、身份、live/offline/carousel、429/-352/404/协议/网络错误。
  - `tests/unit/monitoring-discovery.test.mjs`：频道输入解析、`externalId` 优先、live/upcoming/ended/VOD/offline/owner mismatch/consent、RSS 时间窗、退避边界、状态派生、错误分类。
  - `tests/unit/monitoring-ui.test.mjs`：三语 key、全部状态/错误标签、监听 Tab 与手动 Tab 分离、无 innerHTML、状态 CSS、只用 tokens。
  - `tests/integration/youtube-monitor-detector.test.mjs`：固定 HTML 的解析/检测、429/网络/restricted、结构损坏 → RSS 回退、RSS 不单独判直播、owner mismatch 拒绝。
  - `tests/integration/automatic-monitoring.test.mjs`：等待/开播/重连不新分场/关播/第二场新 session/错误退避/429 长退避/暂停恢复删除/记录中禁删/多目标/重启恢复/M6 包导出。
  - `tests/integration/monitoring-api.test.mjs`：HTTP 全流程与真实重启恢复。
  - `tests/integration/monitoring-migration.test.mjs`：真实 v10→v11、旧数据不变、唯一约束、重复迁移、新库 v11。
  - `tests/integration/youtube-auto-monitoring.test.mjs`：真实 detector + 真实聊天 adapter + 真实 SessionManager：检查→记录→聊天入库→聊天结束→目标 waiting→第二场新视频新 session→目标场次 2 条。
- 既有测试更新：schema 10→11 与版本 0.10.0 的相关断言（`ai-api`、`ai-migration`、`api`、`broadcaster-identity`、`history-management`、`memory-api`、`memory-migration`、`migration-emotes`、`platform-status-migration`）。

## 4. UI 验证（实际结果，必须如实阅读）

- 本轮**没有**真实浏览器渲染/截图验收。本机应用控制策略此前会终止无头 Edge/Chrome（`0x80000003` / `-36863`），本轮未改变该系统限制。
- 已覆盖：三语字典一致性与占位符、页面字面 key 存在性、监听状态/错误标签、Tab 结构与无 `innerHTML`、CSS 状态与 tokens、窄屏规则（静态测试）；HTTP/状态机/端到端行为由 Node 测试覆盖。
- 因此**不能声称自动监听界面已在真实浏览器中验收通过**，也不能声称 390px/暗色主题在真实浏览器中实测。

## 5. 构建结果（本轮实测）

- `node scripts/build-windows.mjs` 成功：`dist/LiveMemory.exe`
  - 大小 **91.1 MB**（95,522,304 bytes），资源 **143 个**（含 `src/monitoring/**` 与 `monitor-targets.mjs`），资源哈希 `9888e47ae335f911daff`
  - SHA-256 `1ed07640704af257dcc5128473d21ab5958b374ae979761f9ff50174798583a4`
  - PE Manifest **requireAdministrator**（脚本断言通过）
- **未能执行验收**：本机应用控制/沙箱策略仍阻止启动新构建的可执行文件；没有运行 `--version`/`--help`，也没有做打包后的 schema 10→11 升级实测。
- 源码层 v10→v11 迁移有自动化测试覆盖；打包资产清单确认包含监听模块。

## 6. 未完成 / 未验证

- **真实双平台长时间运行**：真实 Bilibili「开播→关播→再开播」样本仍未捕获；YouTube 只做了 1 个频道的少量只读解析，未跨多天运行。
- **真实浏览器渲染与截图**：本机策略阻止无头浏览器；需在允许浏览器的机器复验监听 Tab、暂停/恢复、错误状态、暗色、390px。
- **打包 EXE 运行验收**：已构建，本机无法启动。
- **多目标 10+ 长期请求量/限流**：只做了请求预算设计，没有 24 小时观测。
- **YouTube 页面结构变化回归**：有 RSS 回退与显式错误，但没有真实「页面改版」演练。
- **聊天不可用/仅会员/地区限制真实样本**：只有错误映射与状态机测试，没有真实直播样本。
- **同一频道多个并发直播**：`/live` 只指向一个入口，未扫描全部并发直播（有意保持简单）。
- **M5 可移植备份**：仍未实现。

## 7. 关键规则（下一轮不要破坏）

1. 监听目标是持久概念，不能把 Tab 或目标绑定到单场 session；关播只结束 session。
2. 网络错误/重连不是关播；只有平台确认或适配器结束才归位目标。
3. 等待开播只做低频只读公开检查；记录中不重复轮询平台状态。
4. YouTube 自动发现不得引入 Data API/OAuth/API Key/Cookie；不得把 RSS 条目直接当成直播。
5. 必须校验 `channelId` 与 `isLive`/`isLiveNow`，避免把推荐/他人频道当成目标直播。
6. 删除目标与删除场次互不级联；记录中禁止删除目标。
7. 自动场次必须继续走 `SessionManager` + `EventIngest`；不得绕过 M6/M7。
8. 三语键三份一致；前端禁止 `innerHTML`；颜色只用 tokens。

## 8. 相关文档

`docs/HANDOFF.md`、`docs/ARCHITECTURE.md`、`docs/DATA_MODEL.md`、`docs/PLATFORM_INTEGRATIONS.md`、
`docs/YOUTUBE_AUTO_DISCOVERY.md`、`docs/UI_DESIGN.md`、`docs/TEST_PLAN.md`、`docs/CHANGELOG.md`、
`docs/ROADMAP.md`、`log/2026-11-10-auto-monitoring.md`。

## 9. 下一步

1. 在允许浏览器的机器上运行真实界面验证：监听 Tab 跨两场保留、暂停/恢复、错误状态、暗色、390px。
2. 用真实 Bilibili 直播间做一次「开播→关播→再开播」端到端，记录检测延迟与请求数。
3. 用一个真实 YouTube 频道跨数天观察 `/live` 检测、RSS 回退与 429 行为。
4. 在无策略限制的 Windows 环境启动已构建的 EXE，验证 schema 10→11 与打包 UI。
5. 10+ 目标 24 小时请求量/限流与内存观测，必要时调整间隔。
