# 2026-11-09 多直播间并发、直播标签页与 Top 100（v0.6.0）

## 目标

- 同时记录多个 Bilibili / YouTube 直播间；
- 直播记录页改为浏览器式标签，每场独立状态与数据；
- 最活跃观众扩展到当前场次 Top 100，支持滚动、搜索、档案跳转；
- 完成代码、UI、测试、EXE 与本地提交。

## 后端

### SessionManager

- 由单 adapter/managed session 改为 `Map<sessionId, recording>`。
- 每个 recording：adapter、connection/detail、sessionId、platform/room、broadcaster、startedAt、meta、onEnded、stopping。
- `startPlatform` / `startSimulation`：
  - `findDuplicate` 先查内存、再查 `sessions WHERE status='live'`；
  - 同步创建 session 并加入 map，之后才 await adapter.start；
  - onEvent 闭包固定 session id；
  - 启动失败只结束该场。
- `stopSession` / `stopPlatform` / `stopActive`：
  - 按 sessionId 精确停止；
  - 同平台多场时，无 ID 的旧调用返回 `session_id_required`，避免误停；
  - `stopActive` 仅用于兼容，停最近开始的一场。
- `shutdown` 逐场 interrupted，并兜底清理 orphan live 行。
- `status()` 增加 `recordings`、`activeCount`；`activeSession` 仅兼容旧状态行。

### 平台服务 / API

- Bilibili/YouTube 服务不再持有唯一 adapter；connect 只校验 + 创建 adapter，生命周期归 manager。
- YouTube 自动结束通过 manager 的 onEnded 触发 lastEnd 与 retention。
- 新 API：
  - `GET /api/live/recordings`
  - `POST /api/live/recordings/:sessionId/stop`
  - `GET /api/sessions/:id/top-viewers`
- 平台 disconnect 支持 body.sessionId；多场缺 ID 返回 409。
- `/api/simulate/stop` 只停 mock，不再误停其他平台。

### Top 100

- `topSessionViewers` limit 20 → 100。
- 排序 `message_count DESC, platform_uid ASC, viewer_id ASC`。
- 新 `analytics/sessions/leaderboard.mjs`：
  - 只读当前 session 的 `viewer_sessions`；
  - 固定 rank；
  - 搜索在 Top 100 内过滤，保留 rank；
  - 总数与 returned 分离。
- schema v6：`idx_viewer_sessions_speakers(session_id, message_count DESC)`。

### 启动器

- 用户要求控制台英文：`resolveConsoleLocale(options)` 默认 `en`，`--lang` 覆盖；网页语言不受影响。
- 多场时状态行显示 “Recording N live streams”。

## 前端

- `live.js` 重写：
  - 固定“新建记录” + 独立滚动标签区；
  - 状态点与短状态；运行中标签不可关闭；已停止标签可关闭；
  - `viewToken` 防旧响应；
  - 每 session 缓存 summary/feed/leaderboard/query；
  - 4s 轮询 + 700ms/2.5s 事件节流；
  - Top 100 固定高度滚动、签名去重、搜索、档案跳转带 broadcaster；
  - 已结束/失败保留标签与最终状态。
- `app.js` 移除 `livesummary`/`refreshLive` 全局轮询，降低事件风暴下的全量 summary 查询。
- `pages.css` 新增标签栏、状态点、排行榜、hero note、后台提示；390px 无横向溢出。
- 三语新增 tabs/new/top/hero/errors/status 键；三语键一致。

## 测试

- 全量 296 passed / 0 failed / ~24.5s。
- 新增：
  - `session-multi.test.mjs`（6 tests）：独立记录、重复拒绝、停止/失败隔离、交错写入去重、启动恢复、Top 100。
  - `live-api-multi.test.mjs`（8 steps）：双假 YouTube HTTP 并发、隔离、重复 409、Top 100、共享观众跨主播、停 A B 继续、重启。
  - `live-multi-ui.test.mjs`：前端结构守卫。
- 更新 launcher / migration 测试。
- UI：`verify-live-ui.mjs` 10/10（3 标签、100 行、搜索、档案跳转、重入、390px）。随后增加排行榜刷新保持 scrollTop；该改动由静态守卫覆盖，最终浏览器复跑未成功启动。

## 真实直播验证

- 2 YouTube（Lofi Girl + Al Jazeera English）：80/63 事件，0 串场，重复 409，停 A B connected。
- YouTube + Bilibili room 6：76/11，停 A 后 B +1。
- 3 场（2 YouTube + Bilibili room 6）：85/66/6，停 A 后 2 场 connected，B +1。
- 构建后 EXE asInvoker 副本附加同 3 场：79/66/1，3/3 connected，重复 409，停 A 后 2 场 connected。
- 未在真实直播中观测到同一观众跨两个主播；自动化测试覆盖。

## 构建

- `dist/LiveMemory.exe` v0.6.0：90.3 MB / 101 资源 / SHA-256 `cbf17f0c83d9af40003085c0f0acba8b3f9e12e4663bfe50f5bfc61965ec1598`。
- `verify-exe.mjs` 10/10；`--version` = `LiveMemory 0.6.0`。
- 默认控制台英文：用 asInvoker 副本无 `--lang` 启动，输出 “Local-first livestream memory system / Idle (not recording)”。

## 已知限制

- 运行中标签必须停止后才能关闭；不支持隐藏。
- 无并发硬上限；未做 10+ 场数小时压力测试。
- 真实 UAC 点击、真实文件夹选择、同观众跨主播实测、Bilibili 经济事件真实样本仍未完成。
- YouTube 公开网页路径不是官方稳定 API，条款合规未确认。

## 产物

- 截图：`docs/screenshots/live-multi-tabs-v060-light-zh-CN.png`、`...dark...`、`...mobile...`、`live-multi-new-v060-light-zh-CN.png`。
- 开发工具：`scripts/demo-multi-recording.mjs`、`scripts/verify-live-ui.mjs`、`scripts/verify-live-multi.mjs`。
