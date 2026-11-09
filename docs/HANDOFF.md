# 交接文档（HANDOFF）

本轮：2026-11-09 · 多直播间并发记录、直播标签页、Top 100 排行榜 · v0.6.0（schema v6）

## 1. 本轮结果

| 目标 | 结论 |
| --- | --- |
| 同时记录多场直播 | 已完成。`SessionManager` 管理独立 recording/adapter/session，同一房间重复启动被内存 + 数据库双重拒绝；停止、失败、结束互不影响。 |
| 直播记录标签页 | 已完成。顶部「＋ 新建记录」固定可见，直播标签横向滚动，显示名称与状态；切换标签只切视图；运行中标签不能关闭，只能停止。 |
| 每场独立展示 | 已完成。状态、统计、图表、最近动态、Top 100、经济支持均按当前选中场次读取；`viewToken` 防止旧响应覆盖新页面。 |
| Top 100 | 已完成。数据库查询上限 100，稳定次级排序，默认约 10 行可视、容器滚动，搜索、档案跳转与主播上下文均可用。 |
| 数据兼容 | schema 6 仅新增排行榜索引；旧库原地升级，历史场次/观众/主播关系未重写。 |
| 启动器英文 | 控制台默认英文，`--lang` 可覆盖；网页界面仍保留三语与系统语言。 |

## 2. 后端架构变化

### 2.1 SessionManager

`src/platforms/shared/session-manager.mjs`

- `recordings: Map<sessionId, recording>`；
- recording 包含 adapter、connection/detail、sessionId、platform、room、broadcaster、startedAt、meta、onEnded、stopping；
- `startPlatform` / `startSimulation`：
  - `findDuplicate(platform, roomId)` 先查内存，再查 `sessions WHERE status='live'`；
  - 创建 session，把 recording 放入 map，再 await adapter.start；
  - adapter 的 `onEvent` 闭包固定写入该 session；
  - adapter.start 失败只结束该 session 并从 map 移除。
- `stopSession(id)`：只停指定 adapter，结束该 DB session，调用平台 onEnded，广播状态；
- `stopPlatform(platform, {sessionId})`：有 ID 精确停；无 ID 且多场时返回 `session_id_required`；
- `status()` 返回 `{connection, recordings, activeCount, activeSession, adapter}`，`activeSession` 仅兼容旧状态行；
- `shutdown()` 逐场 interrupted 并兜底处理 orphan live 行。

### 2.2 平台服务

- `BilibiliService`：只保留 CookieStore、BilibiliApi、BilibiliLogin、checkRoom；连接交给 manager。
- `YouTubeService`：只保留 checkVideo、adapter 创建、lastEnd/retention；不再维护“唯一 adapter”。
- `disconnect` 接受 `sessionId`；多场且缺 ID 返回 409 `SESSION_ID_REQUIRED`。
- `GET /api/bilibili/status` / `/api/youtube/status` 现在同时返回 `recordings[]`。

### 2.3 API

新增：

```text
GET  /api/live/recordings
POST /api/live/recordings/:sessionId/stop
GET  /api/sessions/:id/top-viewers?limit=100&query=
```

兼容保留：

```text
GET  /api/sessions/current          -> 最近开始的一场
POST /api/sessions/:id/stop
POST /api/simulate/stop             -> 只停 mock
POST /api/bilibili/disconnect       -> body.sessionId 可选
POST /api/youtube/disconnect        -> body.sessionId 可选
```

## 3. 前端变化

`src/web/js/pages/live.js` 重写：

- 顶部标签：固定“新建记录” + 可滚动标签组；状态点/短文案；已结束标签可关闭；
- `viewToken`：每次切换/刷新递增，所有异步请求返回后校验 `token === viewToken`；
- 缓存：summary、最近 40 条 feed、Top 100、搜索词按 session 分开；
- 轮询：4 秒刷新 recordings + 选中 summary + leaderboard；事件触发 summary 700ms、leaderboard 2.5s 节流；
- 排行榜：固定高度滚动、搜索、`rank` 使用服务端值、签名未变不重建 DOM；
- 标签切换/页面重入：从 `/api/live/recordings` 恢复全部运行任务；
- 旧 `livesummary` 全局轮询已从 `app.js` 删除，避免每个事件触发全量 summary 查询。

`src/web/js/app.js`：

- 移除 `liveSummary` / `refreshLive` / `livesummary`；
- SSE `event` 只广播给页面；`status` 更新连接状态；
- 连接胶囊在多场时显示“记录中 · N 场”。

样式：

- `.recording-tabs-*`、`.leaderboard-*`、`.hero-note`、`.live-background-notice`；
- 桌面/700px 以下/390px 无横向溢出；标签区独立滚动。

## 4. 数据模型

- schema **6**：`CREATE INDEX idx_viewer_sessions_speakers ON viewer_sessions (session_id, message_count DESC)`。
- 查询：

```sql
SELECT vs.viewer_id, v.nickname, v.platform, v.platform_uid,
       vs.message_count, vs.payment_event_count, vs.last_seen_at
  FROM viewer_sessions vs JOIN viewers v ON v.id = vs.viewer_id
 WHERE vs.session_id = ? AND vs.message_count > 0
 ORDER BY vs.message_count DESC, v.platform_uid ASC, v.id ASC
 LIMIT 100;
```

- 排行榜是单场读模型；不读取 `viewers.message_count` 长期累计或 `viewer_broadcasters` 跨场汇总。
- 搜索先取 Top 100，再按昵称/UID 过滤，保留原始 rank；不会把第 101 名补进前 100。

## 5. 测试 / 构建

- 全量：**296 passed / 0 failed / 约 24.5 秒**。
- 新增：`session-multi.test.mjs`、`live-api-multi.test.mjs`、`live-multi-ui.test.mjs`；更新 launcher / migration 测试。
- UI 验证：`scripts/verify-live-ui.mjs` 10/10（3 个模拟标签、100 行列表、搜索、档案跳转、页面重入、390px）。
- EXE：90.3 MB / 101 资源 / SHA-256 `cbf17f0c83d9af40003085c0f0acba8b3f9e12e4663bfe50f5bfc61965ec1598`。
- `verify-exe.mjs` 10/10；`--version` = 0.6.0。
- 真实直播验证：
  - 2 YouTube：80 / 63，`wrongSession=0`，重复 409，停 A 后 B connected；
  - YouTube + Bilibili：76 / 11，停 A 后 B +1；
  - 3 场（2 YouTube + Bilibili）：85 / 66 / 6，停 A 后 2 场仍 connected，B +1；
  - 构建后 EXE 附加同样 3 场真实直播：73 / 67 / 5，3/3 connected，重复 409，停 A 后 2 场仍在记录。

## 6. 未验证 / 边界

- 真实 UAC 同意、管理员桌面下的完整流程。
- 真实文件夹选择器点击。
- 同一真实观众跨两个主播的实测；自动化测试覆盖了身份关系与隔离。
- 真实 Bilibili 礼物/SC/大航海样本未在本轮出现。
- 运行中标签不支持隐藏/关闭；必须先停止，再关闭已停止标签（有意设计）。
- 无并发上限；未做 10+ 场长时间压力测试。
- 干净 Windows 虚拟机、代码签名、M5 备份、M6 导入。

## 7. 常用命令

```bat
:: 全量测试
node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"

:: 多场 UI 模拟 + 截图
node scripts/demo-multi-recording.mjs --port 48350
node scripts/verify-live-ui.mjs --port 9223 --base http://127.0.0.1:48350

:: 真实并发（至少两个输入）
node scripts/verify-live-multi.mjs --youtube <url> --bilibili <roomId> --seconds 30
node scripts/verify-live-multi.mjs --base http://127.0.0.1:49160 --youtube <url> --youtube <url> --seconds 20

:: 构建 / 验证 EXE
node scripts/build-windows.mjs
node scripts/verify-exe.mjs
```

## 8. 本轮 Commit

- 本轮功能与文档提交：见 `git log -1`（本地 commit，未 Push）。
- 上一轮：`06119c9 docs: record the new-space fix commit`。
