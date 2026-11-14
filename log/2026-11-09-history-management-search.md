# 2026-11-09 · 直播历史场次管理与搜索（v0.7.0）

## 目标

为直播历史增加单场「停止记录 / 归档 / 永久删除」，并提供按主播、标题、观众的统一搜索与平台/状态/日期/归档筛选。列表与详情必须共用同一套逻辑。

## 交付

### Schema v7

- `sessions.archived_at INTEGER`：独立归档属性，不覆盖 `status`。
- `sessions.end_reason TEXT`：`user` / adapter 原因 / `failed` / `shutdown` / `startup_recovery`；用于区分“用户停止记录”与“平台直播结束”。
- 索引：`idx_sessions_history`、`idx_sessions_platform_started`、`idx_viewers_nickname`、`idx_viewer_nicknames_nickname`、`idx_viewer_sessions_viewer_seen`。
- 迁移只加列/加索引；v1→v7 与 v6→v7 都有测试；打包 EXE 用真实 v6 库实测升级。

### 停止记录

- 新 `src/server/session-admin.mjs`：`stopSessionRecording`。
- 两个端点（`/api/sessions/:id/stop`、`/api/live/recordings/:id/stop`）共用；前端列表/详情共用 `session-actions.js`。
- 只停止目标 adapter；A 停止后 B/C 继续接收事件；重复停止 409；关闭后重新开始同房间创建新 session。

### 归档

- `POST /api/sessions/:id/archive`；live 或仍有 adapter 返回 409。
- 重复归档保留首次时间；取消归档清空；默认列表隐藏，`includeArchived=1` 显示；重启保持。
- 归档不删除任何数据，仍可搜索、详情、导出 AI 包。

### 永久删除

- `DELETE /api/sessions/:id` 必须 `{confirm:true}`；live/仍有 adapter 拒绝。
- `BEGIN IMMEDIATE` 内显式删除 `ai_packages`、`session_currency_totals`、`viewer_sessions`、`events`、`sessions`；
  FK 级联兜底。
- 受影响观众：`rebuildViewerAggregates()` 重建全局计数/首末/币种；`rebuildViewerBroadcasterAggregates()` 重建主播维度；
  只存在于该场的观众删除；`focused=1` 保留但归零；共享观众/其他主播档案保留；孤立 broadcaster 清理。
- `assertNoResidue()` 事务内校验；失败回滚。提交后删除 `exports/` 内该场 AI 包文件（路径穿越防护）。
- SQLite 触发器故障注入测试验证完整回滚。

### 搜索

- 新 `src/analytics/sessions/history-search.mjs` + `GET /api/history/search`。
- 主播：显示名 + 稳定 ID；标题：子串（中日英/混合）；观众：稳定 ID、当前/历史昵称。
- 同名不同 ID / 跨平台同名分别列出；匿名消息不虚构身份。
- 只查 `sessions`/`broadcasters`/`viewers`/`viewer_nicknames`/`viewer_sessions`；事件只做索引 `COUNT`。
- 通配符转义；筛选组合；默认 `started_at DESC`；20 条/页增量加载。
- 结果返回匹配原因与观众本场发言数；`?viewer=` 下钻最近 50 条发言。
- 1200 场 / 12000 事件：观众搜索约 200ms、标题 < 400ms。

### UI

- 新 `dialog.js`（原生 `<dialog>`，settings 复用）、`actions-menu.js`（键盘/触屏/视口夹紧/焦点返回）、`session-actions.js`。
- `history.js` 重写：搜索/筛选工具栏、结果计数、隐藏归档提示、匿名身份提示、匹配 chip、观众匹配行、每行 `···`、详情标题区菜单、观众下钻卡。
- 三语新增完整文案；明暗主题、390px 无横向溢出；删除确认需勾选不可撤销。
- 修复模拟场次重复显示 “Simulated” chip；搜索范围文案改为“全部字段”。

## 验证

### 自动化（318 passed / 0 failed / ~25.0s）

新增：

- `tests/integration/history-management.test.mjs`（6 tests）
- `tests/integration/history-search.test.mjs`（7 tests）
- `tests/integration/history-api.test.mjs`（1 HTTP test，多子场景）
- `tests/unit/history-ui.test.mjs`（8 tests）

更新：`migration-emotes.test.mjs`、`broadcaster-identity.test.mjs`、`api.test.mjs`。

### 浏览器 UI（27/27）

`scripts/demo-history.mjs` + `scripts/verify-history-ui.mjs`（headless Chrome + DevTools）：

- 搜索（标题/主播/观众昵称，跨平台同名 2 身份）、筛选组合；
- 归档/取消归档、live 仅显示停止、停止确认与状态更新；
- 删除确认字段/禁用/删除后消失；
- 详情归档/删除返回列表；
- 键盘 Enter/ArrowDown/Esc + 焦点返回；
- 390px 无横向溢出、菜单在视口内；黑暗 + 中文；
- 截图 7 张：`docs/screenshots/history-*-v070-*.png`。

> 浏览器启动需要完整进程权限；本会话的受限沙箱会阻止 Chrome 的 crashpad/子进程启动，因此浏览器验证在显式放宽权限后完成。应用自身仍只监听 127.0.0.1。

### 打包 EXE（19/19）

`scripts/verify-exe-history.mjs`：

- 构造真实 schema v6 数据库（4 场历史），启动 `dist/LiveMemory.exe` 的 asInvoker 临时副本；
- 升级到 schema 7、历史保留；
- EXE 内搜索、归档、包含归档、启动模拟直播并从历史列表停止；
- 删除确认与永久删除；专属观众清理；共享观众 sessionCount=1、消息 2、付费 1；
- 关闭重开后归档保持、删除不复活、搜索仍可用。

### EXE 矩阵（10/10）

`scripts/verify-exe.mjs`：manifest、版本、端口、单实例、强杀恢复、不可写目录、跨目录、解压复用、CLI 三语。`--version` = 0.7.0。

## 构建

- `dist/LiveMemory.exe`：90.4 MB，106 资源。
- SHA-256 `9602c5607782ee72645f32019fbba7b28ca6cb6722bfd70c1bdeebed57877e1f`。
- Manifest：`requireAdministrator`（PE 补丁）。

## 已知限制

- 本轮没有新的真实 Bilibili/YouTube 网络采集；真实平台结论仍以 v0.6.0 样本为限。
- 真实 UAC 同意、真实文件夹选择器人工点击未完成。
- 无回收站；未做批量删除；性能基线 1200 场。
- 当前没有 AI 结果/画像断言表；M6 引入后必须加入删除事务。
