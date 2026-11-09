# 2026-11-08 · Header 语言、数据目录、清空/出厂、多主播档案（v0.4.0 / schema 5）

## 1. 本轮目标

1. 语言切换从设置页移到 Header，三种语言名始终以各自语言显示，保留跟随系统。
2. 允许修改数据存储目录，并安全迁移已有数据；启动器必须能在下次双击 EXE 时找到新位置。
3. 提供清空全部数据与恢复出厂设置，明确范围、二次确认、备份与清理完整性。
4. 区分平台全局观众身份与主播维度互动档案，重做观众搜索/筛选与 AI 包上下文。

## 2. 基线

- 起始 HEAD：`c8d72c5`（docs: anonymize public chat data in YouTube screenshots）
- 工作区干净；版本 0.3.0；schema 4；287 测试通过。
- 环境注意：本机 PATH 没有 `node`/`git`；使用 DeepSeek Harness 自带 Node v24.21.0 与 GitHub Desktop 自带 Git 完成构建/提交。这不是项目缺陷。

## 3. 实施顺序与结果

### 阶段 A：Header 语言切换

- `index.html` 顶栏新增 `language-control`：
  - `#language-system` 地球按钮（跟随系统）；
  - `#language-segmented` 三个按钮：`简体中文`、`日本語`、`English`，始终用 `localeDisplayName()` 的原生写法；
  - `#language-select` 窄屏 select，含“跟随系统”和三种原生语言。
- `app.js`：
  - `syncLanguageControls()` 根据 `state.settings.locale` 重建两种控件并同步 `aria-pressed`/`aria-label`；
  - `chooseLocale()` 串行化切换，失败恢复控件；
  - `setLocale()` 仍是唯一持久化入口，设置页与 Header 共用。
- 设置页语言卡增加 header 提示；三语键 `a11y.languageSelect`、`a11y.languageSystem`、`settings.language.headerHint`。
- CSS：宽屏分段紧凑、≤860px 切换为 select；`.topbar-title` 省略号防溢出；`scroll-margin-top` 让卡片滚动避开 sticky topbar。
- 截图：中文/日语/英语/黑暗日语/390px。

### 阶段 B：多主播观众档案（schema 5）

- 新增 `src/shared/broadcaster.mjs`：
  - YouTube 只用 channelId；视频 ID 明确不是主播身份；
  - Bilibili anchor uid → `bilibili:<uid>`；缺失用 room id → `bilibili:room:<id>`（`room_fallback`）；
  - mock → `mock:simulation`；无法确定 → `unresolved`。
- schema v5：
  - `broadcasters`；
  - `sessions.broadcaster_id`（ON DELETE SET NULL）+ `broadcaster_identity`；
  - `viewer_broadcasters`；
  - `viewer_broadcaster_currency_totals`（复合外键）。
- v4→v5 迁移：
  - Bilibili 历史按 room fallback 回填；
  - mock 回填；
  - YouTube 历史只有视频 ID，保持 `unresolved`，不猜；
  - 从 `viewer_sessions`/`events` 回填关系与币种合计。
- `SessionManager` 在创建场次前解析并 upsert 主播；Bilibili service 传 `anchorUid`，YouTube 传 `video.channelId`，mock 传 mock 身份。
- `EventIngest` 同事务写 `viewer_broadcasters` / 币种合计；重复事件不增加。
- 读模型 `buildViewerProfile(db, id, {broadcasterId|unassigned})`：全局 lifetime + scope + 参与主播列表。
- API：`/api/broadcasters`、`/api/broadcasters/:id`、`/api/broadcasters/:id/viewers`、范围化 `/api/viewers` 与 `/api/sessions`。
- UI：
  - 观众列表主播范围选择器（>8 个主播显示搜索）、排序、范围统计、新/回访；
  - 详情页当前主播档案、参与主播切换、全局概览（标注“全部主播”）；
  - 主播身份 chip；清除缓存后不会显示旧档案。
- AI 包：
  - `session_context.broadcaster`、`session.broadcaster_id/identity`、manifest 字段；
  - `viewer_context[].broadcaster_context` / `lifetime` / `other_broadcaster_count`；
  - `instructions.md` 三语“主播上下文”规则。

### 阶段 C：数据目录

- `src/shared/data-location.mjs`：主/镜像位置记录、原子写、损坏回退、相对路径拒绝。
- 启动器：位置记录优先于默认目录，但严格于显式 `--data-dir`；目标必须存在且含 `database/livememory.db`；否则 `DATA_DIR_UNAVAILABLE`，提供 `--data-dir` / `--forget-data-location`。
- `src/server/relocation.mjs`：staging 复制、WAL checkpoint、integrity/计数/schema/文件 SHA-256、目标冲突/空间/UNC/云同步校验、运行时重建、锁转移、失败回滚；`hooks` 仅供测试注入失败。
- `src/server/index.mjs` 重构为 `buildRuntime/stopRuntime` + getter deps，支持同一端口切换运行时。
- `native-dialog.mjs`：固定 PowerShell + WinForms FolderBrowserDialog（不经 shell）；打开文件夹只接受受管键。
- UI：数据存储位置卡、迁移/新空间对话框、原生浏览、警告确认、迁移结果（原目录未删、12→12 事件、位置记录）。

### 阶段 D：清空/出厂

- `src/server/maintenance.mjs`：
  - `data`：删业务表 + exports/cache；保留设置/凭据/位置记录/backups/日志/无关文件；
  - `factory`：额外删偏好/凭据/日志/缓存并重置默认；
  - 事务删除 + `VACUUM` + checkpoint；
  - `VACUUM INTO` 快照到 `%LOCALAPPDATA%\LiveMemory-Backups`（可覆盖），不在数据目录内；
  - 完成后重建运行时。
- API + UI：`DELETE`/`RESET` 确认文字、记录中 409、默认备份勾选、结果页显示前后计数。
- 实测清空：3/12/4 → 0/0/0；备份 3/12/4、integrity ok；数据目录、设置、凭据、backups 保留。

## 4. 测试

- 初始 287 → 本轮 **305**。
- 新增：
  - `tests/unit/broadcaster.test.mjs`
  - `tests/unit/header-language.test.mjs`
  - `tests/integration/broadcaster-identity.test.mjs`
  - `tests/integration/storage-management.test.mjs`
- 迁移测试更新到 v5；v1→v5 迁移断言旧 YouTube 场次 unresolved。
- 全量结果：305 passed / 0 failed / ~22.8s。
- EXE：90.3 MB、103 资源、SHA-256 `4aae59fe…`；`verify-exe.mjs` 9/9；`--version` 0.4.0。

## 5. 数据验证

- 迁移：旧/新目录 integrity=ok、schema=5、sessions=3、events=12、viewers=4、viewer_sessions=8、viewer_broadcasters=5、broadcasters=2；位置记录指向新目录。
- 清空：全部业务表 0、integrity=ok、schema=5；备份 3/12/4、integrity=ok。
- 同一 YouTube 账号：
  - A：3 条发言（含 SC）、1 笔 USD 5；B：3 条发言、1 笔 USD 10；
  - 全局 lifetime 6 条、USD 15；`other_broadcaster_count=1`；无自动合并。

## 6. 已知问题

- 位置记录目标要求已存在且含数据库；用户手动删除数据目录会触发不可用错误（这是有意的）。
- UNC 拒绝；映射网络盘未自动识别；OneDrive 等只警告。
- 原生目录选择器未在无桌面会话验证。
- 迁移回滚用注入 `afterMove` 失败测试，未做真实断电/拔盘/磁盘写满。
- 清空文件删除尽力而为；数据库事务 + VACUUM。
- 旧 YouTube 场次 unresolved，无手动归属 UI。
- 未实现 M5 可移植备份 / M6 AI 导入 / M7 AI 画像。

## 7. 下一轮

1. M6 AI 结果导入与 Schema 校验。
2. 旧场次主播归属、单场/观众/主播删除、严格删除模式。
3. 真实断盘/断电迁移演练；映射网络盘检测。
4. 干净 Windows EXE 验收与发布准备。
