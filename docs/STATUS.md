# 工程状态（STATUS）

最后更新：2026-11-09（直播历史场次管理、统一搜索与筛选、永久删除，版本 0.7.0，schema 7）

> 本文件是唯一进度来源。只要代码与本文不一致，以代码与实测为准，并立即修正本文。

## 1. 当前阶段

- 里程碑：**M0 / M1 / M2 核心 / P0 / P1 / P2 / P3 / P4 / P5 / P6 完成；M3 真实接入继续验证；M4 / M7 部分推进；M5 / M6 未完成**
- 版本：`0.7.0`（`package.json` 与 `src/shared/app-info.mjs` 一致）
- 数据库 schema：**7**（新增 `sessions.archived_at`、`sessions.end_reason` 与历史/搜索索引；旧库原地升级）
- 分支：`main`，本地提交，未 Push
- 发布形态：`LiveMemory.exe`，RT_MANIFEST **requireAdministrator**

## 2. 本轮完成（2026-11-09，v0.7.0）

### 2.1 统一场次管理

新增 `src/server/session-admin.mjs`，直播历史列表与单场详情共用同一套服务端逻辑；前端共用
`src/web/js/session-actions.js`，避免两个页面行为不一致。

- **停止记录**（`stopSessionRecording`）：
  - 只接受目标 `sessionId`，调用 `SessionManager.stopSession` 停止该场 adapter；
  - 已停止/已结束/已中断返回 `409 SESSION_NOT_ACTIVE`，不静默成功；
  - 已采集消息、观众身份、统计、经济支持原样保留；场次 `status=ended`、`end_reason=user`、写入 `ended_at`；
  - UI 文案区分「已停止记录」与「已结束」；确认框明确「平台直播可能仍在进行」；
  - 同一房间再次开始记录会创建全新场次（`createSession`），不会写入旧场次。
- **归档**（`POST /api/sessions/:id/archive`）：
  - schema v7 `sessions.archived_at` 是独立管理属性，不覆盖 `status`；
  - 仅 `ended` / `interrupted` 可归档；`live` 或仍注册 adapter 时返回 `409 SESSION_ARCHIVE_LIVE`；
  - 重复归档保留原时间戳；取消归档清空 `archived_at`；
  - 默认历史列表隐藏归档场次；「包含已归档」与「查看归档」入口可显示；归档场次仍可搜索、查看详情、导出 AI 分析包；
  - 归档状态持久化，重启 EXE 后保持（EXE 实测见 §5）。
- **永久删除**（`DELETE /api/sessions/:id`，body 必须 `{confirm:true}`）：
  - 正在记录（`status=live` 或内存仍有 adapter）返回 `409 SESSION_STILL_RECORDING`；
  - 单个 `BEGIN IMMEDIATE` 事务内显式删除：`events`、`viewer_sessions`、`session_currency_totals`、`ai_packages` 行、`sessions` 行；外键级联仍开启；
  - 事务内重建受影响观众的衍生数据：全局 `viewers` 计数与首末时间、`viewer_currency_totals`、`viewer_broadcasters`、`viewer_broadcaster_currency_totals`；
  - 只存在于被删除场次的观众会被清理；`focused=1`（用户标记重要）的观众保留但计数归零；仍参与其他场次的观众及其其他主播档案不受影响；
  - 无任何场次/关系引用的派生 `broadcasters` 行被清理；仍有其他场次的广播者保留；
  - 删除事务内校验所有关联表无残留，失败抛出 `SESSION_DELETE_INCOMPLETE` 并回滚；
  - 提交后删除该场次导出目录内的分析包文件（路径限制在 `exports/` 内，拒绝路径穿越）；
  - 本地无回收站，确认框展示主播、标题、日期、消息数、观众数，并要求勾选「不可撤销」后才启用删除按钮；
  - 删除后历史、搜索、观众参与记录、AI 分析包列表均不残留（自动化 + EXE UI 实测）。
- 场次结束原因新增 `end_reason`：`user` / adapter 原因 / `failed` / `shutdown` / `startup_recovery`；`status=ended` 不再被一律解释为「平台直播结束」。

### 2.2 直播历史搜索

新增只读读模型 `src/analytics/sessions/history-search.mjs` 与 `GET /api/history/search`。

- 统一搜索框 + 范围选择：全部字段 / 主播 / 标题 / 观众。
- **主播**：`sessions.broadcaster_name`、`broadcasters.display_name`、稳定 ID（`broadcaster_id` / `platform_uid`）模糊匹配；优先稳定 ID，昵称只作显示。
- **标题**：`room_title` 子串匹配，SQLite `LIKE` 支持中文、日文、英文与混合文本，不依赖分词。
- **观众**：
  - 稳定 ID 精确匹配（`platform:uid` 或裸 `uid`）；昵称与历史昵称子串匹配；
  - 通过 `viewer_sessions` 找场次，返回该身份在每场的发言数、付费事件数、首末见时间；
  - 同名不同 ID / 跨平台同名分别作为不同身份列出，绝不合并；
  - 无稳定身份的匿名消息不会生成观众结果；界面明确提示；
  - 匹配结果说明原因（主播名称匹配 / 标题匹配 / 观众参与匹配），点击场次进入详情，点击观众行进入 `历史详情?viewer=` 查看该观众本场发言（最多 50 条）。
- 通配符 `%` / `_` 按字面匹配（`LIKE ... ESCAPE '\'`），不会变成「匹配全部」。
- 搜索只扫描 `sessions`、`viewers`、`viewer_nicknames`、`viewer_sessions`、`broadcasters`，不读取聊天正文；每场仅用索引 `COUNT` 事件数。
- 筛选：平台（全部 / Bilibili / YouTube）、状态（全部 / 记录中 / 已停止或结束 / 已中断）、日期范围（本地日期起止）、是否包含归档；所有条件可组合。
- 默认按 `started_at DESC` 排序；分页 `limit=20` + `offset`，前端「加载更多」，不一次性加载全部场次。
- 搜索与筛选使用 `idx_sessions_history`、`idx_sessions_platform_started`、`idx_viewers_nickname`、`idx_viewer_nicknames_nickname`、`idx_viewer_sessions_viewer_seen` 等索引。
- 1200 场 / 12000 事件内存库测试：观众搜索约 200ms 内（断言 < 800ms），标题搜索 < 400ms。

### 2.3 历史 UI

- 列表顶部：统一搜索框 + 搜索范围 + 平台/状态/日期/包含归档筛选 + 重置；结果计数、隐藏归档提示、匿名身份提示。
- 每行右侧「···」操作菜单：根据状态只显示可执行动作（记录中只有停止；否则归档/取消归档 + 永久删除）。
- 保留标题、主播、日期、时长、消息数、观众数、支持、AI 状态与归档标记；新增匹配原因 chip 与观众匹配行。
- 详情页标题区右上角「···」菜单；停止/归档后原地刷新；删除成功后自动返回历史列表。
- 共用 `dialog.js`（原生 `<dialog>`）与 `actions-menu.js`（键盘、触屏、视口翻转/夹紧、Esc、焦点返回）。
- 三语（zh-CN / ja / en）文案齐全；明暗主题、390px 窄屏无横向溢出；操作菜单在窄屏视口内。
- v0.6.0 的多直播间标签页、Top 100、并发采集保持不变。

### 2.4 文档/工具/版本

- 新增 `scripts/demo-history.mjs`（开发/截图用的历史夹具，全部标记为模拟数据）。
- 新增 `scripts/verify-history-ui.mjs`（DevTools 协议 UI 验证，27 项）。
- 新增 `scripts/verify-exe-history.mjs`（构建后的 EXE + 真实 v6→v7 升级 + UI 操作，19 项）。
- 版本升至 `0.7.0`；schema 升至 `7`。

## 3. 自动化测试（本轮实测）

- 全量：**318 passed / 0 failed / 约 25.0 秒**（`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`）。
- 本轮新增：
  - `tests/integration/history-management.test.mjs`：
    - 三场同时记录，停止其中一场，另外两场继续接收事件；停止后重新开始同房间创建新场次；
    - 列表/详情共用停止服务；重复停止返回 409；
    - 归档持久化（关闭重开数据库）、默认隐藏、`archivedOnly`、live 禁止归档、adapter 仍注册时禁止归档；
    - 永久删除专属数据、共享观众保留与聚合重建、其他主播档案完整、孤立 broadcaster 清理、focused 观众保留、导出文件删除、路径安全；
    - 确认缺失 / live 删除 / 仍注册 adapter 的删除守卫；
    - SQLite 触发器模拟数据库异常 → 整个事务回滚，数据完全不变；移除故障后删除成功；
    - 归档场次可直接永久删除。
  - `tests/integration/history-search.test.mjs`：
    - 主播显示名/稳定 ID、中文/日文/英文/混合标题、观众昵称/历史昵称/稳定 ID；
    - 同名不同身份、跨平台同名、同一观众跨主播；
    - 平台/状态/日期/归档筛选组合、隐藏归档计数、分页、通配符字面匹配；
    - 1200 场 / 12000 事件性能；
    - 匿名消息不生成观众结果。
  - `tests/integration/history-api.test.mjs`：HTTP 级搜索、归档、列表/详情两个停止端点、删除确认、观众本场发言、404 清理。
  - `tests/unit/history-ui.test.mjs`：两页面共用管理实现、搜索端点与不加载聊天、删除确认字段、DELETE 客户端、无 `innerHTML`、共享 modal、响应式 CSS、菜单键盘、路由/事务守卫、三语键。
  - 更新 `migration-emotes.test.mjs`、`broadcaster-identity.test.mjs`、`api.test.mjs` 到 schema 7 / v0.7.0。

## 4. 平台/真实直播验证

- 本轮**没有**新增真实 Bilibili / YouTube 网络采集验证；v0.6.0 的真实双场/三场并发结果仍有效（见 §5 与 HANDOFF 历史）。
- 本轮新增的是本地 SQLite、HTTP、打包 EXE 与真实浏览器 UI 验证；不得把这些描述为真实平台验收。
- 真实平台验证阻塞项与 v0.6.0 相同：UAC 交互、真实文件夹选择、同一真实观众跨主播观测、Bilibili 礼物/SC/大航海样本、YouTube 公开网页长期稳定性。

## 5. EXE / 构建 / UI 验证

- 构建：`node scripts/build-windows.mjs`（Node v24.21.0）
- 当前构建：**90.4 MB，106 资源**，SHA-256 `9602c5607782ee72645f32019fbba7b28ca6cb6722bfd70c1bdeebed57877e1f`
- Manifest：`requireAdministrator`（实际 PE 补丁）
- `scripts/verify-exe.mjs`：**10/10 通过**；`--version` 输出 `LiveMemory 0.7.0`；非提权会话使用临时 asInvoker 副本并明确打印该事实。
- `scripts/verify-exe-history.mjs`：**19/19 通过**（真实打包 EXE，asInvoker 临时副本）：
  - 准备真实 schema v6 数据库 → EXE 启动后升级到 schema 7，历史保留；
  - 打包 EXE 内执行观众搜索、归档、包含归档显示、启动模拟直播并从历史列表停止、删除确认、永久删除；
  - 删除后专属观众清理、共享观众聚合重建；
  - 关闭并重启 EXE：schema 保持 7、归档状态保持、删除数据不复活、搜索仍可用。
- `scripts/verify-history-ui.mjs`：**27/27 通过**（真实浏览器 + 模拟夹具）：
  - 标题/主播/观众昵称搜索与匹配原因、同名跨平台身份、平台筛选组合；
  - 隐藏归档与查看归档、取消归档、live 仅显示停止、确认框文案、停止后状态即时更新；
  - 删除确认字段与禁用状态、确认后消失；
  - 详情页归档/删除、删除后返回列表；
  - 键盘打开菜单 / 方向键 / Esc 焦点返回、390px 无横向溢出、菜单在视口内；
  - 黑暗主题 + 中文界面；
  - 截图保存于 `docs/screenshots/history-*-v070-*.png`。

## 6. 未完成 / 未验证

- **真实 UAC 交互**：当前会话非管理员，最终 EXE 只验证 manifest 与 asInvoker 副本；未点击 UAC 同意。
- **真实文件夹选择器人工点击**：无交互桌面，逻辑测试保留。
- **真实平台**：本轮未做新的真实直播采集；v0.6.0 结果仍以历史样本为限。
- **AI 长期记忆删除**：当前 schema 只有场次级 `ai_packages` 索引，没有 AI 结果/画像断言表（M6 未实现）；删除会清除包记录与文件。未来 M6 引入 AI 结果表时必须同样级联/重建（已写入 DATA_MODEL 与 DECISIONS）。
- **回收站/撤销**：有意不实现。
- **批量归档/删除**：未实现，本轮只做单场。
- **超大数据量**：1200 场 / 12000 事件为性能基线；未做百万级事件或 10+ 场长时间压力测试。
- **干净 Windows 虚拟机、代码签名、升级回滚**：未完成。

## 7. 相关文档

`docs/ARCHITECTURE.md`、`docs/DATA_MODEL.md`、`docs/UI_DESIGN.md`、`docs/TEST_PLAN.md`、`docs/CHANGELOG.md`、`docs/DECISIONS.md`（ADR-027/028）、`docs/PRIVACY_SECURITY.md`、`docs/WINDOWS_RUNTIME.md`、`README.md`、`AGENTS.md` 与 `log/2026-11-09-history-management-search.md` 已同步本轮变化。

## 8. 下一步

1. 在真实管理员桌面完成 UAC、文件夹选择、迁移与重启验证。
2. 继续真实直播验证，并累积 Bilibili 经济事件与同一真实观众跨主播样本。
3. M6 AI 结果导入时，同时为“删除场次”补齐 AI 结果/画像证据的级联或重算。
4. 视需要增加批量归档/清理与更大的性能基线；不要恢复官方 YouTube 双轨实现。
