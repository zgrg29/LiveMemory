# 交接文档（HANDOFF）

本轮：2026-11-10 · P7 自动直播监听与持久化 Tab · v0.10.0（schema v11）

## 1. 本轮结果

| 目标 | 结论 |
| --- | --- |
| 现状审计 | 已完成。现有 Bilibili 已有 WS 生命周期、`live_status` 查询与下播确认；YouTube 已有公开网页聊天与 watch 页解析。缺的是频道级发现、持久目标、统一调度与持久 Tab。 |
| 开源方案调查 | 已完成。比较 streammon（无许可，仅参考思路）、livestream_saver（GPL-3.0，不复制）、yt-dlp（Unlicense，语义参考，不打包）、pytchat（MIT，已归档，已有同类实现）。见 `docs/YOUTUBE_AUTO_DISCOVERY.md`。 |
| 统一监听核心 | 已完成。持久目标、状态机、调度/抖动/退避/pacer、会话创建与归位、暂停/恢复/重试/删除、重启恢复。 |
| Bilibili 自动监听 | 已完成。固定真实房间号 + 低频 `get_info.live_status`；复用现有 WebSocket 与下播确认。 |
| YouTube 自动监听 | 已完成。频道 URL/@handle/Channel ID/视频反查；公开 `/live` + `ytInitialPlayerResponse`，owner/isLive 校验；结构损坏时 RSS + watch 页回退；无 API Key/OAuth/Cookie。 |
| 持久 Tab | 已完成（代码）。监听 Tab 由目标驱动，关播不消失；下次开播创建新 session；目标视图含状态、检查时间、错误、最近场次与操作。 |
| M6/M7 兼容 | 已完成。自动场次是普通 `sessions`；M6 包导出回归测试通过；M7 规则未改。 |
| 测试 | **484 自动化全部通过**（本轮新增 8 个测试文件）。 |
| 真实浏览器验收 | **未完成**。本机策略仍阻止无头 Edge/Chrome；只有静态 UI 检查与 HTTP/端到端测试。 |
| 打包 EXE | **已构建、未能执行**。`dist/LiveMemory.exe`：91.1 MB / 143 资源 / `requireAdministrator` / SHA-256 `1ed07640…`；本机无法启动验收。 |
| 真实平台长跑 | **未完成**。YouTube 只做 1 频道少量只读解析；Bilibili 未捕获真实「关播→再开播」。 |

## 2. 后端变化

### 2.1 新模块

| 文件 | 职责 |
| --- | --- |
| `src/monitoring/constants.mjs` | 平台策略、状态、错误码、messageKey、阈值 |
| `src/monitoring/model.mjs` | 抖动/退避、状态派生、目标序列化、错误分类、摘要 |
| `src/monitoring/manager.mjs` | 目标 CRUD、调度、检查、会话创建/借用、归位、恢复 |
| `src/monitoring/pacer.mjs` | 每平台串行请求间隔 |
| `src/monitoring/errors.mjs` | 统一 `AppError` 监控错误 |
| `src/monitoring/youtube-discovery.mjs` | 频道输入/身份/`/live` 页面/RSS 纯解析 |
| `src/monitoring/detectors/bilibili.mjs` | 房间规范化、状态检测、错误映射 |
| `src/monitoring/detectors/youtube.mjs` | 公开频道页请求、检测、RSS 回退 |
| `src/storage/repositories/monitor-targets.mjs` | 全部目标 SQL |

### 2.2 修改

- `src/storage/database/migrations/index.mjs`：**v11** `monitor_targets`、`sessions.monitor_target_id`、索引。
- `src/storage/repositories/sessions.mjs`：`createSession` 可选 `monitorTargetId`；为兼容旧库迁移测试，列写入放在独立 UPDATE（仅非空时）。
- `src/platforms/shared/session-manager.mjs`：`startPlatform` 接受/传递 `monitorTargetId`，公开 recording 暴露。
- `src/platforms/bilibili/service.mjs`：新增 `connectResolved(room)`；`connect()` 复用它。
- `src/platforms/youtube/service.mjs`：新增 `connectDetected(video)`（不重复抓元数据；仍 openChat）。
- `src/server/index.mjs`：创建/启动/停止 `MonitoringManager`，SSE `monitoring` 事件；关闭时先停调度再停适配器。
- `src/server/routes.mjs`：6 个 `/api/monitoring` 端点；状态/bootstrap 增加 monitoring。
- `src/server/maintenance.mjs`：清空/恢复出厂删除目标；重建 runtime 后重启调度。
- `src/server/session-admin.mjs`：删除场次时清空目标指针，保留目标。
- `src/server/serializers.mjs`、`src/analytics/sessions/summary.mjs`：暴露 `monitorTargetId`。
- 版本：`package.json`、`src/shared/app-info.mjs` → `0.10.0`。

### 2.3 路由

```text
GET    /api/monitoring
POST   /api/monitoring                        {platform, input, autoMonitor?}
PATCH  /api/monitoring/:id                    {action: pause|resume|retry | enabled}
POST   /api/monitoring/:id/check
DELETE /api/monitoring/:id                    {confirm:true}
GET    /api/monitoring/:id/sessions?limit=20
```

## 3. 前端变化

- `src/web/js/pages/live.js`：
  - 新增 `targets` / `selectedTargetId` / 目标视图；Tab 顺序为监听目标 → 新建 → 手动场次/已结束。
  - 目标 Tab 固定，不因 session 结束消失；由目标产生的场次不生成额外 session Tab。
  - 目标视图：状态、平台/目标 ID、检查频率、上次/下次检查、上次直播、错误与下次重试、最近 10 场、暂停/恢复/立即检查/删除。
  - 记录视图增加「自动监听」chip 与专用结束提示。
  - 新建面板新增自动监听复选框；Bilibili/YouTube 各自输入提示；默认保持手动行为。
  - 删除确认弹窗、API 调用、SSE `monitoring` 刷新。
- `src/web/styles/pages.css`：监听 Tab 状态、toggle、信息行、最近场次、窄屏；只用 tokens。
- `src/web/i18n/{zh-CN,ja,en}.json`：新增 `monitoring.*`（约 70 键）与 `errors.monitorTarget*`。

## 4. 关键规则（下一轮不要破坏）

1. 目标是持久概念；Tab 不绑定单场。
2. 网络错误/重连不等于关播；同一场沿用同一 session。
3. 等待时低频只读检查；记录中不重复轮询。
4. YouTube 自动发现不得引入 Data API/OAuth/API Key/Cookie；RSS 不能单独判定直播。
5. 必须 owner + isLive 双校验；预定/首映/回放不算直播。
6. 删除目标与删除场次互不级联；记录中禁止删除目标。
7. 自动场次继续走 `SessionManager` + `EventIngest`。
8. 三语键一致；前端禁止 `innerHTML`。

## 5. 测试 / 构建 / 验证

- 全量：`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`
  → **484 passed / 0 failed**，约 70 秒。
- 新增测试文件 8 个（见 `docs/STATUS.md` §3）；既有 schema/版本断言已更新。
- 真实 YouTube：1 个频道（`@LofiGirl`）解析 + `/live` 检测，约 5 次只读请求；未发 Cookie/API Key。
- 构建：`node scripts/build-windows.mjs` 成功（91.1 MB、143 资源、requireAdministrator、SHA-256 `1ed07640…`）；**运行验收未完成**。
- **未运行**：真实浏览器 UI、真实 Bilibili 生命周期、真实 YouTube 长期检测、`verify-exe*.mjs`。

## 6. 未验证 / 边界

- 真实浏览器渲染、截图、暗色、390px（策略阻止）。
- 打包 EXE 启动与 schema 10→11 打包实测。
- 真实 Bilibili「关播→再开播」与 YouTube 多天 `/live` 行为。
- 聊天不可用/仅会员/地区限制的真实样本。
- 10+ 目标 24 小时请求量与限流。
- 同一频道多个并发直播（有意只跟随 `/live` 入口）。

## 7. 常用命令

```bat
:: 全量测试
node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"

:: 只看自动监听
node --test --test-isolation=none "tests/unit/monitoring-*.test.mjs" "tests/integration/*monitoring*.test.mjs"

:: 启动
node src/launcher/launcher.mjs --no-open

:: 打包
node scripts/build-windows.mjs
```

## 8. 本轮 Commit

- 本轮功能与文档提交：`feat: add persistent automatic live monitoring`（本地 commit，未 Push；Hash 见 `git log -1`）。
- 上一轮：`29cc500 feat: add long-term viewer memory with incremental updates`。
