# 工程状态（STATUS）

最后更新：2026-11-08（Header 语言快捷切换、数据目录迁移、清空/恢复出厂、多主播观众档案，版本 0.4.0，schema 5）

> 本文件是唯一进度来源。只要代码与本文不一致，以代码与实测为准，并立即修正本文。

## 1. 当前阶段

- 里程碑：**M0 / M1 / M2 核心 / P0 / P1 / P2 / M3 核心完成；M4（删除/存储管理）与 M7（主播维度记忆基础）部分推进；M5 / M6 未完成**
- 版本：`0.4.0`（`package.json` 与 `src/shared/app-info.mjs` 一致）
- 数据库 schema：**5**
  - v2 `events.emotes`
  - v3 `sessions.platform_started_at`
  - v4 `events.badges` + `events.amount_display`
  - v5 `broadcasters`、`viewer_broadcasters`、`viewer_broadcaster_currency_totals`、`sessions.broadcaster_id` + `sessions.broadcaster_identity`
- 分支：`main`，本地提交，未 Push

## 2. 本轮完成（2026-11-08）

### 2.1 Header 语言快捷切换

- 顶栏外观切换旁新增语言控件：
  - 宽屏：`简体中文` / `日本語` / `English` 三个始终以各自语言显示的分段按钮 + 地球按钮（跟随系统）；
  - ≤860px：折叠为带地球标识的原生 `<select>`，仍保留三种语言与“跟随系统”；
  - 不进入设置页、不刷新页面即可切换；与设置页使用同一 `ctx.setLocale` 状态与 `config/settings.json` 偏好。
- 设置页语言卡保留，并增加“页面顶部切换是最快方式”的说明。
- 三语键、`aria-label`、原生语言名、主题切换互不干扰；390px 头部无横向溢出。
- 截图：`header-language-zh-CN.png`、`header-language-ja.png`、`header-language-en.png`、`header-language-mobile-zh-CN.png`、`header-language-dark-ja.png`。

### 2.2 数据存储目录修改与安全迁移

- 新增启动位置记录：
  - 主文件 `%LOCALAPPDATA%\LiveMemory\data-location.json`；
  - 镜像 `%APPDATA%\LiveMemory\data-location.json`（主文件损坏或缺失时可回退读取）。
  - 记录只保存 `version/dataDir/updatedAt`，不保存凭据；不把路径只存在数据库里。
- 启动顺序：显式 `--data-dir` / `LIVE_MEMORY_DATA_DIR` → 位置记录 → 默认目录。位置记录指向的目录**必须已存在且包含 `database/livememory.db`**；否则启动失败并显示路径、位置记录、`--data-dir` 与 `--forget-data-location` 的恢复方式。**不会创建空数据库冒充旧数据。**
- 设置页新增“数据存储位置”卡与“修改存储位置”对话框：
  - 显示真实目录、来源（默认/自定义/命令行）、位置记录、可写状态、可用空间、占用、数据库、场次/观众/事件；
  - 支持手动输入完整路径与 Windows 原生目录选择器（本地 PowerShell + WinForms FolderBrowserDialog，不经 shell、不接收用户拼接命令）；
  - 两种模式：**迁移现有数据（推荐）**、**在新目录创建新的数据空间**；
  - OneDrive / Dropbox / Google Drive / 临时目录 / 长路径显示警告并需要确认；UNC 网络共享直接拒绝。
- 迁移实现（`src/server/relocation.mjs`）：
  1. 校验直播未进行、目录绝对路径、安全目录、父目录可写、目标冲突、剩余空间（源数据 + 50 MB 余量）；
  2. 停止适配器、`wal_checkpoint(TRUNCATE)`、关闭 SQLite；
  3. 复制 `config/`、`database/`（含 WAL/SHM，若存在）、`secrets/`、`exports/`、`backups/` 到目标卷的临时 staging 目录；
  4. `PRAGMA integrity_check` + 表计数 + `schema_migrations` 版本 + 配置文件 SHA-256 校验；
  5. 把 staging 中受管目录移入目标根目录；目标根目录中的无关文件不复制、不删除；
  6. 在目标目录重新初始化运行时（设置、数据库、SessionManager、Bilibili/YouTube 服务），通过 API 再校验表计数；
  7. 更新位置记录，转移单实例锁（旧锁释放、新锁建立、目标 runtime.json 写入）；
  8. 失败时回滚：移回已移动目录、删除 staging、恢复位置记录、原目录运行时重新打开；**原目录始终不删除**。
- “新数据空间”复制设置与本地登录状态，不复制直播/观众/AI 记录；旧目录保持不变。
- 设置页提供“打开数据文件夹”（`explorer.exe` 参数传递，不经过 shell）。
- 实测迁移前后（演示数据）：旧目录与新目录均 `integrity=ok`、schema=5、sessions=3、events=12、viewers=4、viewer_sessions=8、viewer_broadcasters=5、broadcasters=2；位置记录指向新目录。
- 截图：`settings-data-location-zh-CN.png`、`settings-relocation-dialog-zh-CN.png`、`settings-relocation-result-zh-CN.png`、`settings-data-location-after-move-zh-CN.png`。

### 2.3 清空数据与恢复出厂设置

- 设置页“数据管理”危险区提供两个明确分离的操作：
  - **清空全部直播与观众数据**（确认词 `DELETE`）：删除场次、事件/聊天、观众档案、昵称历史、主播—观众关系、场次/观众币种合计、AI 分析包记录与导出文件、缓存、临时导出；保留语言、主题、存储模式、数据目录、位置记录、登录凭据、`backups/`、日志、根目录无关文件。
  - **恢复出厂设置**（确认词 `RESET`）：在上一项基础上删除偏好、本地登录凭据、日志与缓存，重置设置默认值（语言/主题/存储模式/端口/YouTube 模式/保留天数），回到首次运行状态；仍不删除数据根目录、无关文件、`backups/` 或外部备份。
- 安全确认：
  - 二次确认对话框；必须输入准确的 ASCII 确认词（大小写敏感）；按钮在输入正确前禁用；
  - 正在记录直播时设置页按钮禁用，服务端再次校验并返回 409；
  - 删除前默认勾选“创建数据库快照”，可手动立即创建；快照使用 `VACUUM INTO` 保存到 `%LOCALAPPDATA%\LiveMemory-Backups`（可用 `LIVE_MEMORY_BACKUP_DIR` 覆盖），**不在即将清空的数据目录内**；这是数据库应急快照，不是 M5 的 `.livememory` 可移植备份；
  - 服务端事务删除全部业务表，随后 `VACUUM` + WAL checkpoint，再关闭/重建运行时；异常时返回真实错误，数据库仍可重新初始化。
- 实测清空后：sessions=0、events=0、viewers=0、viewer_sessions=0、viewer_broadcasters=0、broadcasters=0、ai_packages=0；`integrity=ok`、schema=5；备份数据库保留 3/12/4 且 `integrity=ok`；设置和本地凭据在“清空数据”后保留；出厂设置后恢复 `locale=system`、`theme=system`、`storageMode=compact`。
- 截图：`settings-danger-zh-CN.png`、`settings-clear-dialog-zh-CN.png`、`settings-factory-dialog-zh-CN.png`、`settings-clear-result-zh-CN.png`、`viewers-empty-after-clear-zh-CN.png`。

### 2.4 多主播观众档案与搜索

- 数据模型（schema 5）：
  - `broadcasters(id, platform, platform_uid, display_name, identity_quality, …)`；
  - `sessions.broadcaster_id`（可空）+ `sessions.broadcaster_identity`（`verified`/`room_fallback`/`simulated`/`unresolved`）；
  - `viewer_broadcasters(viewer_id, broadcaster_id, message_count, payment_event_count, …)`；
  - `viewer_broadcaster_currency_totals(viewer_id, broadcaster_id, currency, value_kind, …)`。
- 主播身份：
  - YouTube 只使用频道 ID（`youtube:UC...`），**视频 ID 永远不作为长期主播身份**；
  - Bilibili 优先 `anchorUid`（`bilibili:<uid>`）；缺失时使用已验证的直播间 ID 作为受限后备（`bilibili:room:<roomId>`，`room_fallback`）；两者都没有则 `unresolved`；
  - mock 使用 `mock:simulation`；其他平台有稳定 UID 时 `platform:uid`。
- 观众身份仍是平台全局身份 `platform:stable_uid`；昵称只作展示；不同平台不合并，同名不合并。
- `EventIngest` 在同一事务内同时更新全局观众统计与 `(broadcaster, viewer)` 上下文；重复投递不增加任何计数或金额。
- 旧库迁移：
  - Bilibili 有 room id 的历史场次归入 `bilibili:room:<id>` 并标 `room_fallback`；
  - YouTube 历史只有视频 ID，无法确定主播，**保留为 `broadcaster_id=NULL`、`broadcaster_identity=unresolved`**，不猜测；
  - mock 归入 `mock:simulation`；
  - 按 `viewer_sessions` 与 `events` 回填 `viewer_broadcasters` 和币种合计。
- API：
  - `GET /api/broadcasters`（列表、`currentId`、未确认历史统计）；
  - `GET /api/broadcasters/:id`（主播汇总、新/回访观众、支持）；
  - `GET /api/broadcasters/:id/viewers`（限定范围的观众、排序、币种支持）；
  - `GET /api/viewers?broadcasterId=` / `?scope=unassigned`；
  - `GET /api/viewers/:id?broadcasterId=` / `?scope=unassigned`（全局身份 + 主播上下文 + 参与过的主播）；
  - `GET /api/sessions?broadcasterId=`。
- 界面：
  - 观众档案页增加“主播范围”选择器，默认当前主播；支持全部主播与“待确认主播”；主播多时提供搜索框；支持按发言/场次/支持/最近/最新排序；
  - 列表在具体主播范围下显示该主播的场次、发言、支持；全部主播时显示全局合计和“参与过 N 位主播”；
  - 详情页显示身份、参与过的主播（可点击切换）、当前主播互动档案、该主播处的场次/支持、昵称历史、全局参与概览（明确标注“全部主播”，不同币种分别累计）；
  - 主播身份质量 chip：已确认频道 / 按直播间识别 / 模拟直播 / 待确认。
- AI 分析包：
  - `session_context.broadcaster` 对象、`session.broadcaster_id`/`broadcaster_identity`；
  - `viewer_context[].broadcaster_context` 只含当前主播的计数/支持/首末见；
  - `viewer_context[].lifetime` 明确是跨主播全局合计；
  - `other_broadcaster_count` 只给数量，不包含其他主播的互动细节；
  - `instructions.md` 新增“主播上下文”规则，禁止把其他主播数据混入当前画像；
  - manifest 带 `broadcaster_id` / `broadcaster_identity`。
- 截图：`viewers-broadcaster-scope-zh-CN.png`、`viewer-detail-two-broadcasters-zh-CN.png`、`viewers-all-broadcasters-zh-CN.png`、`viewers-mobile-zh-CN.png`。

### 2.5 测试与 EXE

- 自动化：**305 个测试通过，0 失败**（见 §6；完整套件约 22.8 秒）。
- 新增测试文件：
  - `tests/unit/broadcaster.test.mjs`：主播身份解析与质量排序；
  - `tests/unit/header-language.test.mjs`：原生语言名、Header 控件、三语键；
  - `tests/integration/broadcaster-identity.test.mjs`：同一 YouTube 账号在两个主播、同一主播多场、重名、改名、跨平台、v4→v5 迁移、AI 包隔离、HTTP 范围接口；
  - `tests/integration/storage-management.test.mjs`：位置记录、目标校验、迁移成功、复制中断回滚、清空/出厂、快照。
- EXE：`dist/LiveMemory.exe` **90.3 MB**，103 个资源文件，SHA-256 `4aae59fe6f8d0a6cdc13811d27cc732e1e17cd6a6dac5d5fa4da450efbb1387f`；`scripts/verify-exe.mjs` **9/9 通过**（全新目录启动、重启保留、强杀恢复、端口顺延、第二实例、不可写目录、跨目录运行、解压复用、`--version`/日语 help/`--diagnose`）。
- 截图：本轮共 18 张，见 §7 与 `docs/UI_DESIGN.md`。

## 3. 已完成并保持

- Windows 启动器/EXE、三语命令行、单实例、动态端口、优雅退出。
- Bilibili 真实直播采集；YouTube 官方 API/OAuth 与免登录实验路径（默认关闭）；模拟直播。
- SQLite WAL、单一 `EventIngest` 写入路径、去重、整数金额与币种分账、观众稳定身份。
- 三语 UI、明亮/黑暗/跟随系统、Apple 风格控制台、Canvas 图表、SSE。
- AI 分析包导出（`livememory-analysis-v1`）、三语指令、结果 Schema（导入仍属 M6）。
- 30 天 YouTube 原文保留与手动清理。

## 4. 部分完成 / 缺口

| 项目 | 现状 | 缺口 |
| --- | --- | --- |
| 多主播档案 | schema/ingest/API/UI/AI 包完成 | 旧 YouTube 未确认场次无手动归属 UI；无主播删除/合并 UI |
| 数据存储目录 | 位置记录、迁移/新空间、回滚、原生选择器完成 | 映射网络盘只能人工判断（UNC 已拒绝）；未做真实断盘/断电验收 |
| 清空/出厂 | 两种模式、确认、备份、重建完成 | 文件删除为尽力而为；未做真实断电中断验收 |
| 备份 | 数据库应急快照（`VACUUM INTO`） | M5 可移植 `.livememory` 包、导入校验、回滚 |
| AI 分析中心 | 导出/指令可用 | 结果导入、Schema 校验、分批（M6） |
| 观众画像 | 事实/统计/主播维度 | AI 兴趣/喜恶/变化（M7） |
| Bilibili 经济事件 | 映射完成 | 礼物/SC/大航海真实事件仍缺样本 |
| YouTube 官方 | 传输/映射/登录/控制台完成 | 真实凭据下采样与 OAuth 验收 |

## 5. 未完成

- M5 可移植备份/跨电脑迁移。
- M6 AI 结果导入与 Schema 校验、重复导入保护、分批。
- M7 长期兴趣/喜恶/变化与画像版本。
- YouTube 官方真实凭据验收、匿名 vs 官方并排对照。
- 干净 Windows 环境 EXE 验收、代码签名、发布流水线。
- 严格删除/去标识化模式；映射网络盘检测；真实断电/拔盘迁移演练。

## 6. 测试结果（2026-11-08，v0.4.0）

```bat
node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"
```

结果：**305 个测试通过，0 失败**（完整套件约 22.8 秒；无跳过、无 todo）。

EXE：`dist/LiveMemory.exe` 90.3 MB，103 个资源文件，SHA-256 `4aae59fe…`。
`scripts/verify-exe.mjs`：**9/9 通过，0 失败**（本机普通权限；未在第二台干净 Windows 上验收）。

真实数据验证：
- 迁移：旧/新目录 integrity=ok、schema=5、sessions=3、events=12、viewers=4、viewer_sessions=8、viewer_broadcasters=5、broadcasters=2；位置记录指向新目录。
- 清空：全部业务表为 0，integrity=ok、schema=5；备份数据库保留 3/12/4。
- 同一 YouTube 账号在两主播：A 3 条发言/1 笔 USD 5；B 3 条发言/1 笔 USD 10；全局 lifetime 6 条/USD 15；其他主播计数 1；无自动合并。

UI 截图：见 §7。

## 7. 本轮截图

```text
docs/screenshots/header-language-zh-CN.png
docs/screenshots/header-language-ja.png
docs/screenshots/header-language-en.png
docs/screenshots/header-language-mobile-zh-CN.png
docs/screenshots/header-language-dark-ja.png
docs/screenshots/settings-data-location-zh-CN.png
docs/screenshots/settings-data-location-after-move-zh-CN.png
docs/screenshots/settings-danger-zh-CN.png
docs/screenshots/settings-relocation-dialog-zh-CN.png
docs/screenshots/settings-relocation-result-zh-CN.png
docs/screenshots/settings-clear-dialog-zh-CN.png
docs/screenshots/settings-factory-dialog-zh-CN.png
docs/screenshots/settings-clear-result-zh-CN.png
docs/screenshots/viewers-broadcaster-scope-zh-CN.png
docs/screenshots/viewer-detail-two-broadcasters-zh-CN.png
docs/screenshots/viewers-all-broadcasters-zh-CN.png
docs/screenshots/viewers-mobile-zh-CN.png
docs/screenshots/viewers-empty-after-clear-zh-CN.png
```

## 8. 已知问题与限制

1. 位置记录位于 `%LOCALAPPDATA%\LiveMemory`；若用户手动删除该目录，位置记录可能丢失（镜像在 `%APPDATA%`）。
2. 映射网络盘（盘符形式）未自动识别；UNC 路径明确拒绝，OneDrive 等云同步目录只警告并要求确认。
3. 原生目录选择器只在 Windows 可用；本环境通过脚本/手动输入路径验证，未在无桌面会话中验证对话框置顶。
4. 迁移复制中断/回滚通过注入 `afterMove` 失败测试覆盖；未做真实拔盘、断电、磁盘写满的物理演练。
5. 清空/出厂的文件删除是尽力而为；数据库删除在事务内且 `VACUUM`，但极端断电可能留下部分导出/日志文件。下次启动数据库仍为空。
6. 旧 YouTube 场次无法确定主播，保持 `unresolved`；目前没有“把旧场次指派给主播”的 UI。
7. 删除单个主播/场次/观众的 UI 仍未提供。
8. AI 分析包不包含其他主播的互动细节，只提供 `other_broadcaster_count`；跨主播分析需要未来显式功能。
9. `settings.updatedAt` 在默认设置下可能为 null；不影响使用。
10. 现有 30 天保留策略仍只清理原文/badge/金额显示/过期昵称，不删除稳定 ID 与聚合金额。

## 9. 阻塞事项

- **法律/平台合规**：YouTube 匿名网页接口仍可能违反 ToS；未作为默认，也未声称合规。
- **官方 YouTube 真实验收**：仍缺合法 API Key / OAuth 客户端。
- **真实付费事件覆盖**：Bilibili 礼物/SC/大航海、YouTube Super Sticker/会员/赠送会员仍缺真实样本。

## 10. 下一步目标

1. M6 AI 结果导入：JSON/粘贴 → Schema 校验 → `task_id`/`session_id`/`viewer_id`/`message_refs` → 事务写入、重复导入保护。
2. M5 可移植备份/导入；复用当前位置记录与安全切换机制。
3. 旧场次主播归属 UI；主播/场次/观众删除与严格删除模式。
4. 真实断盘/断电迁移演练；映射网络盘检测；干净 Windows EXE 验收。

## 11. 最近 Commit

- 本轮：`66e47b6` feat: add header language switch, data relocation and broadcaster memory
- 上一轮：`c8d72c5` docs: anonymize public chat data in YouTube screenshots
- 上一轮：`d314984` feat: record public YouTube Live chat without a developer key
