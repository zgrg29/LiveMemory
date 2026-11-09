# 交接文档（HANDOFF）

本轮：2026-11-09 · 直播历史场次管理、统一搜索与永久删除 · v0.7.0（schema v7）

## 1. 本轮结果

| 目标 | 结论 |
| --- | --- |
| 停止记录（列表 + 详情） | 已完成。共用 `stopSessionRecording`；只停目标场次，其他采集继续；保留全部数据；`end_reason=user`；重复停止 409。 |
| 归档 / 取消归档 | 已完成。`archived_at` 独立于 `status`；live 禁止归档；默认列表隐藏，可查看；持久化并重启保持；归档场次可搜索/详情/导出 AI 包。 |
| 永久删除 | 已完成。事务删除专属行 + 重建观众/主播衍生聚合 + 清理孤立派生行 + 删除导出文件；失败回滚；live/仍注册 adapter 拒绝；无残留。 |
| 搜索 | 已完成。主播（名称 + 稳定 ID）、标题（中日英混合）、观众（稳定 ID + 昵称 + 历史昵称）统一搜索；结果说明匹配原因；不读聊天正文。 |
| 筛选 | 已完成。平台、状态、日期范围、包含归档可任意组合；默认倒序；20 条/页「加载更多」。 |
| UI | 已完成。统一搜索/筛选工具栏；每行「···」菜单；详情标题区同一菜单；三语、明暗、390px 无横向溢出、键盘/触屏可用。 |
| 数据兼容 | schema 7 仅新增列与索引；v6 真实数据库由打包 EXE 实测升级成功，历史保留。 |
| 测试 | 318 自动化全部通过；EXE UI 19/19；浏览器 UI 27/27；EXE 矩阵 10/10。 |

## 2. 后端变化

### 2.1 新模块

- `src/analytics/sessions/history-search.mjs`：只读搜索读模型。
  - `searchHistory(db, {query, scope, platform, status, from, to, includeArchived, archivedOnly, limit, offset})`
  - `resolveViewerCandidates(db, query)`：按稳定 ID / 当前昵称 / 历史昵称解析身份；同名不同 ID 保持分开。
  - 只访问 `sessions` / `broadcasters` / `viewers` / `viewer_nicknames` / `viewer_sessions`；`events` 只用于 `COUNT(*)`，不读 `content`。
  - `LIKE` 通配符转义；`hiddenArchivedCount` 用于「N 场归档未显示」提示。
- `src/server/session-admin.mjs`：停止/归档/删除的唯一实现。
  - `stopSessionRecording({deps, sessionId})`
  - `archiveSession({db, sessionId, archived, manager, now})`
  - `deleteSessionRecord({deps, sessionId, confirm})`
  - 删除使用 `withTransaction`，事务内显式删除所有子表、重建聚合、清理孤立 broadcaster、`assertNoResidue` 校验。
  - 导出文件路径经 `safeExportPath()` 限制在 `paths.exports` 内。

### 2.2 仓储变化

- `sessions.mjs`
  - `endSession(..., {reason})` 写入 `end_reason`。
  - `recoverInterruptedSessions()` 写 `startup_recovery`。
  - `setSessionArchived()`：`COALESCE(archived_at, ?)`，重复归档保留时间。
  - `listSessions()` 支持 `includeArchived` / `archivedOnly`，默认兼容旧调用（含归档）。
- `viewers.mjs`
  - `rebuildViewerAggregates(db, viewerId)`：从剩余 `viewer_sessions` 重建全局计数/首末；无剩余场次且无事件时删除观众；`focused=1` 保留但归零；币种合计从剩余事件重建。
  - `viewerSessionStats(db, sessionId, viewerId)`：单场参与行。
- `broadcasters.mjs`
  - `rebuildViewerBroadcasterAggregates(db, viewerId)`：只保留仍有场次的 broadcaster 关系，重建计数与币种。
- `events.mjs`
  - `listViewerSessionMessages()`：单观众单场最多 200 条，按索引读取，供详情下钻。

### 2.3 路由

新增：

```text
GET    /api/history/search?q=&scope=&platform=&status=&from=&to=&includeArchived=&archivedOnly=&limit=&offset=
POST   /api/sessions/:id/archive        body {archived:true|false}
DELETE /api/sessions/:id                body {confirm:true}
GET    /api/sessions/:id/viewers/:viewerId?limit=50
```

更新：

- `/api/sessions` 支持 `includeArchived=1` / `archivedOnly=1`；默认隐藏归档（AI 页面显式传 `includeArchived=1`）。
- `/api/sessions/:id/stop` 与 `/api/live/recordings/:sessionId/stop` 都调用 `stopSessionRecording`。
- `serializeSessionRow` / `buildSessionSummary` 增加 `archived`、`archivedAt`、`endReason`。

## 3. 前端变化

新增：

- `src/web/js/dialog.js`：共享原生 `<dialog>` modal（从 settings 抽出）。
- `src/web/js/actions-menu.js`：`···` 菜单；fixed 定位、视口夹紧/上翻、Esc、外部点击、滚动/缩放关闭、方向键/Home/End、焦点返回、`aria-expanded`。
- `src/web/js/session-actions.js`：列表与详情共用的动作定义与确认框（停止/归档/取消归档/删除）；删除确认展示主播、标题、日期、消息、观众，并需勾选不可撤销。
- `src/web/js/pages/history.js` 重写：
  - 服务端搜索 + 筛选 + 增量加载；`token` 丢弃过期响应；
  - 匹配原因 chip、观众匹配行（昵称/平台/UID/本场消息数）；
  - 行右侧菜单；详情标题区同一菜单；删除成功回 `/history`；
  - `?viewer=` 详情下钻卡（身份、本场发言/付费/首末、最近 50 条消息、观众档案入口）。
- i18n：三语新增 `history.search.*`、`history.filters.*`、`history.actions.*`、`history.stop.*`、`history.delete.*`、`history.detail.viewer*`、`status.stopped` 与相关错误键。

样式：`pages.css` 新增 `.history-toolbar`、`.history-filters`、`.filter-field`、`.history-actions`、`.action-menu*`、匹配/观众消息、620px/900px 响应式；动作菜单不写死颜色。

## 4. 数据模型

- schema **7**：
  - `sessions.archived_at INTEGER NULL`；
  - `sessions.end_reason TEXT NULL`；
  - 索引：`idx_sessions_history (archived_at, started_at DESC)`、`idx_sessions_platform_started (platform, started_at DESC)`、`idx_viewers_nickname (nickname)`、`idx_viewer_nicknames_nickname (nickname)`、`idx_viewer_sessions_viewer_seen (viewer_id, last_seen_at DESC)`。
- 归档是独立管理状态，不覆盖 `status`；`status=ended` + `end_reason=user` 才表示「用户停止本地记录」。
- 删除后聚合规则：
  - 观众仍参与其他场次 → 全局/主播维度计数与币种按剩余场次重建；
  - 观众只存在于被删场次 → 删除观众（级联昵称/关系/币种）；`focused=1` 属用户保留数据，保留但计数归零；
  - 孤立 broadcaster（无场次、无关系）删除；其他主播的长期观众画像不动。
- 目前没有 AI 结果/画像断言表（M6 未实现）。`ai_packages` 行随场次删除，导出文件在提交后删除；未来 M6 表必须加入同一删除事务。

## 5. 测试 / 构建 / 验证

- 全量：**318 passed / 0 failed / 约 25.0 秒**。
- 新增测试：`history-management.test.mjs`、`history-search.test.mjs`、`history-api.test.mjs`、`history-ui.test.mjs`；更新迁移/API 版本断言。
- 浏览器 UI：`scripts/verify-history-ui.mjs` **27/27**；截图 `docs/screenshots/history-*-v070-*.png`。
- EXE：90.4 MB / 106 资源 / SHA-256 `9602c5607782ee72645f32019fbba7b28ca6cb6722bfd70c1bdeebed57877e1f`；`verify-exe.mjs` **10/10**；`--version` = 0.7.0。
- 打包 EXE UI：`scripts/verify-exe-history.mjs` **19/19**，包括真实 v6→v7 升级、搜索、归档、重启保持、停止、删除、共享观众聚合与专属观众清理。
- 本轮**没有**新增真实平台网络采集；v0.6.0 的真实双场/三场并发结果仍为历史样本。

## 6. 未验证 / 边界

- 真实 UAC 同意、管理员桌面完整流程（EXE 使用 asInvoker 临时副本验证功能）。
- 真实文件夹选择器人工点击。
- 本轮无新的真实 Bilibili/YouTube 采集；真实 429/验证码/年龄墙、礼物/SC/大航海长期样本仍未覆盖。
- 删除不支持撤销/回收站；未做批量归档/删除。
- 未做百万级事件与 10+ 场长时间压力测试；性能基线为 1200 场 / 12000 事件。
- M5 备份、M6 AI 结果导入、M7 AI 画像仍未实现。
- 干净 Windows 虚拟机、代码签名、升级/回滚未完成。

## 7. 常用命令

```bat
:: 全量测试
node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"

:: 历史 UI 模拟 + 浏览器验证
node scripts/demo-history.mjs --port 48360
node scripts/verify-history-ui.mjs --port 9224 --base http://127.0.0.1:48360

:: 构建 / 校验 EXE
node scripts/build-windows.mjs
node scripts/verify-exe.mjs
node scripts/verify-exe-history.mjs
```

## 8. 本轮 Commit

- 本轮功能与文档提交：见 `git log -1`（本地 commit，未 Push）。
- 上一轮：`71f527d feat: record multiple live streams with tabs and a top-100 leaderboard`。
