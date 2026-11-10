# Windows 运行与打包（WINDOWS_RUNTIME）

## 1. 交付形态

- 单一可执行文件 `LiveMemory.exe`（当前构建约 90.3 MB）。
- 用户无需安装 Python、Node.js、npm、数据库或任何开发依赖。
- 双击运行，Windows 通过内嵌 **`requireAdministrator`** Manifest 弹出 UAC；同意后显示命令行窗口并打开默认浏览器控制台。
- 安装目录可以只读；用户数据仍写入 `%LOCALAPPDATA%\LiveMemory\`（或显式指定的可写目录）。
- 开发模式 `node src/launcher/launcher.mjs` 不要求管理员；只有打包 EXE 请求提升。

## 2. 启动流程（实现位置：`src/launcher/launcher.mjs`）

1. 解析参数（`--no-open`、`--port`、`--data-dir`、`--forget-data-location`、`--lang`、`--version`、`--help`、`--no-wait`、`--diagnose`、`--error-dialog`）。
2. **立即创建启动日志**（此时数据库、配置、数据目录都还不存在）：写入 `%LOCALAPPDATA%\LiveMemory\logs`，失败则逐级回退 `%TEMP%\LiveMemory-logs`、用户目录；解析出数据目录后再迁入 `<数据目录>\logs`。
3. `chcp 65001` 将控制台代码页设为 UTF-8（仅 TTY）。
4. 检查 Node ≥ 22.5 与 `node:sqlite` 可用性。
5. 解析可写数据目录（真实写探测，见 §5）：显式 `--data-dir` / `LIVE_MEMORY_DATA_DIR` → 位置记录 → 默认目录。位置记录目标必须已存在且含 `database/livememory.db`；否则报错，不创建空库。打包启动且当前默认目录无数据库时，扫描本地用户配置；恰好一个现有 LiveMemory 数据库则使用，多个则报 `DATA_DIR_AMBIGUOUS`，不猜测。创建 `config/ database/ logs/ cache/ exports/ backups/ runtime/ secrets/`。
6. 控制台语言：默认 **English**；只有 `--lang zh-CN|ja|en` 覆盖。`config/settings.json` 的网页语言偏好不再影响控制台；配置损坏或不可读不阻塞启动。
7. 打包 EXE 防御性管理员检查（`net session`，`stdio: 'ignore'`）；失败时用当前控制台语言提示“需要管理员权限”并退出 1。随后获取单实例锁：`runtime/instance.lock`（PID + `runtime.json` + `/api/health` 校验；陈旧锁自动接管）。
8. 启动服务：绑定 `127.0.0.1`，端口 47800 → +1…+9 → 系统分配。
9. 服务就绪后写 `runtime/runtime.json`（pid/port/url/version），打印状态，打开默认浏览器。
10. 等待信号；收到 SIGINT/SIGTERM 后：停止适配器 → 关闭 SSE → 关闭 HTTP → WAL checkpoint → 关闭数据库 → 删除 runtime 文件。

**每一步都记录到启动日志**（步骤名、ok/失败、错误码、路径）。任何一步失败：

1. 写 `<数据目录>\runtime\last-error.json` 与 `<日志目录>\startup-error.json`；
2. 控制台打印三语错误：原因、失败步骤、错误码、数据目录、**日志文件完整路径**、可选的 `--data-dir` 提示；
3. 交互式控制台等待按键（`--no-wait` 或重定向输出时跳过）；
4. 没有控制台时可用 `--error-dialog` 弹出系统错误框；
5. 以退出码 1 结束。

**不会再出现「闪退但没有任何提示」**。若 Windows 在进入程序之前就阻止运行（映像损坏、SmartScreen、策略拦截），进程没有机会输出，只能由系统提示；这是明确边界。


## 3. 命令行窗口

有意的产品要求：保留可见控制台。

显示内容（三语）：

- 软件名与版本
- 启动状态（环境检查、启动成功）
- 数据目录
- 本地访问地址
- 日志目录
- 直播连接状态
- 主要错误提示
- 退出方式（Ctrl+C）

**不显示原始弹幕**；详细日志写入 `logs/livememory-YYYY-MM-DD.log`（JSONL、脱敏、按大小轮转）。

### UTF-8 与字体

- Node 输出 UTF-8 字节；控制台通过 `chcp 65001` 解码。
- 已验证中文/日文字节正确输出；若使用旧版控制台的非 Unicode 位图字体，仍可能出现方框，建议使用 Windows Terminal 或默认 TrueType 字体（Consolas/微软雅黑）。
- 该设置只影响显示，不影响日志与数据编码。

## 4. 数据目录

```text
%LOCALAPPDATA%\LiveMemory\
├── app\<hash>\         EXE 解压的应用资源（仅 EXE 运行）
├── config\settings.json
├── database\livememory.db (+ -wal/-shm)
├── logs\
├── cache\
├── exports\            分析包
├── backups\            备份（清空/出厂保留）
├── runtime\            instance.lock / runtime.json / last-error.json
└── data-location.json  数据目录位置记录（自定义目录时仍保存在这里）

%LOCALAPPDATA%\LiveMemory-Backups\   删除前的数据库应急快照（数据目录之外）
```

解析顺序：`--data-dir` → `LIVE_MEMORY_DATA_DIR` → `%LOCALAPPDATA%\LiveMemory` → `%APPDATA%\LiveMemory` → 用户目录。
显式指定但不可写时**直接报错**，不会静默换目录。

### 4.1 启动位置记录（v0.4.0）

数据可以移动到其他磁盘。启动器用独立于数据库的位置记录找到它：

```text
%LOCALAPPDATA%\LiveMemory\data-location.json     （主）
%APPDATA%\LiveMemory\data-location.json          （镜像，主损坏/缺失时读取）
{ "version": 1, "dataDir": "D:\\LiveMemoryData", "updatedAt": "…" }
```

- 位置记录只含路径，不含数据库内容或凭据；原子写。
- 位置目标已存在且包含 `database/livememory.db` 时才使用。
- 目标缺失、被断开或没有数据库时：
  - 显示“已保存的数据目录当前不可用”、实际路径、位置记录文件与日志路径；
  - 提供 `--data-dir <路径>` 与 `--forget-data-location`；
  - **不会回退到默认目录并创建空数据库**。
- `--data-dir` / `LIVE_MEMORY_DATA_DIR` 仍优先于位置记录，便于临时排查；它们不会自动改写位置记录。

## 5. 权限

- 打包 EXE 通过 Manifest 请求管理员权限；开发模式仍可用普通权限运行。
- **同一管理员账号**的 UAC 同意通常保持 `%LOCALAPPDATA%` 不变。若 UAC 使用另一个管理员账号，Windows 会切换用户配置文件；应用会扫描本地用户配置中的现有数据库，恰好一个时使用，多个时拒绝猜测。跨账号提升的完整数据目录等价性仍属未验证边界。
- 不写注册表、不写 `Program Files`、不写 EXE 所在目录。
- **可写性探测是真实写探测**：`src/shared/write-probe.mjs` 依次执行「创建目录 → 创建文件 → 写入 → 读回 → 删除」，失败时返回具体步骤和 Windows 错误码（`EPERM`/`EACCES`/`ENOSPC`…）。Windows 上 `fs.accessSync(dir, W_OK)` 只检查存在，不能作为权限判断，已移除。
- 目录解析顺序：
  1. `--data-dir` / `LIVE_MEMORY_DATA_DIR`：**显式要求**，不可写即报错，不静默换目录；
  2. `LIVE_MEMORY_DEFAULT_DATA_DIR`（EXE 的默认目录）：只是**偏好**；
  3. `%LOCALAPPDATA%\LiveMemory`；
  4. `%APPDATA%\LiveMemory`；
  5. 用户目录；
  6. `%TEMP%\LiveMemory`（最后兜底；Windows 会清理它，只用于「至少能启动并说明原因」）。
- 发生回退时控制台打印 `提示: 默认数据目录不可写入，已改用 …`，用户能看到实际路径。
- 数据目录不可写时：显示本地化错误、路径、错误码、失败步骤与 `--data-dir` 替代方案，不要求管理员身份。
- 启动失败时的日志回退顺序：`<数据目录>\logs` → `%TEMP%\LiveMemory-logs` → `~/.livememory-logs`；控制台会打印实际使用的日志文件。

## 5.1 运行中修改数据目录（v0.4.0）

设置页的“修改存储位置”通过本地 API 完成；普通浏览器无法取得任意绝对目录，因此原生选择器由本地服务调用固定 PowerShell + WinForms 脚本（不经 shell）。

迁移流程：

1. 服务端校验：未在记录、路径绝对、非 UNC/系统目录/嵌套、目标无 LiveMemory 数据、空间足够、云同步/临时/长路径 warning；
2. 停止适配器 → `wal_checkpoint(TRUNCATE)` → 关闭 SQLite；
3. 复制受管目录到目标卷 staging；`PRAGMA integrity_check`、表计数、schema 版本、配置/凭据/导出文件 SHA-256；
4. 移入目标根目录；重建设置/数据库/平台服务；再次核对表计数；
5. 转移单实例锁（释放旧锁、建立新锁、写目标 `runtime.json`），更新位置记录；
6. 同一 HTTP 端口继续服务；旧目录**不删除**。

失败（权限、复制中断、校验失败、锁占用）回滚为原目录运行时，原数据保持。维护期间 API 返回 503（relocation/clear/health/status 除外）。

恢复出厂/清空数据后的数据库快照默认位于：

```text
%LOCALAPPDATA%\LiveMemory-Backups\livememory-database-YYYYMMDD-HHmmss-SSS.db
```

可用 `LIVE_MEMORY_BACKUP_DIR` 覆盖；它位于数据目录之外，避免“先删目录再删备份”。

## 6. 单实例与重复启动

- 锁文件按数据目录隔离；不同数据目录可并存（用于测试/多账号场景）。
- 第二次启动时，只有「锁中 PID 存活 + `runtime.json` 一致 + `/api/health` 回应 LiveMemory」三者同时成立，才打印「已在运行」、打开该地址并以 0 退出。
- PID 被复用、进程已死、端口被其他服务占用、进程无响应 → 视为陈旧锁并接管，而不是打印一个失效地址后退出。
- 接管前若旧锁文件无法删除（ACL/占用），给出本地化错误与日志位置，而不是闪退。
- 注意：同一 EXE 的不同数据目录可同时运行，这是有意设计（测试隔离）。

## 7. 浏览器与生命周期

| 事件 | 行为 |
| --- | --- |
| 关闭浏览器 | 不停止记录；命令行继续运行 |
| 刷新页面 | 重新加载 SPA，SSE 重连，状态从 API 恢复 |
| 关闭命令行窗口 | 进程终止（Windows 行为）；下次启动把遗留 `live` 场次标记 `interrupted` |
| 重复双击 EXE | 不重复启动，打开已有控制台 |
| 服务异常退出 | 进程退出；数据库 WAL 保证一致性，下次启动恢复 |
| Windows 关机 | 由系统终止进程；同样依赖启动时恢复 |
| Ctrl+C | 优雅退出并打印“已安全退出” |

**浏览器无法自动打开**时：打印可复制的本地地址，程序继续运行。

## 8. EXE 打包方案

### 8.1 技术选择

Node SEA（Single Executable Application）+ postject 注入。

理由：
- 应用零运行时依赖；
- SQLite 是 Node 内置 `node:sqlite`，无需原生编译；
- 不必引入 electron-builder / pkg / nexe 等重型工具；
- 直接复用官方 `node.exe`，运行时行为可预期。

### 8.2 构建步骤（`scripts/build-windows.mjs`）

1. 校验 Windows x64。
2. 下载 postject 固定版本 tarball，校验 SHA-256 后解压（构建期依赖，不进入产品）。
3. 读取官方 node.exe 的 PE `RT_MANIFEST`，把 `requestedExecutionLevel` 从 `asInvoker` 改为 `requireAdministrator`，更新资源 data-entry size；新 Manifest 必须能放入 `.rsrc` 的现有 padding（当前 773 字节；容量不足时构建直接失败，不写坏二进制）。构建后再次读取并断言。
4. 遍历 `src/`，生成 `manifest.json`（文件列表 + 内容哈希 + 版本）。
5. 生成 `sea-config.json`（assets + bootstrap），运行 `node --experimental-sea-config` 生成 blob。
6. 复制当前 `node.exe`，将 PE Subsystem 改为 `IMAGE_SUBSYSTEM_WINDOWS_CUI`（3，可见控制台）。
7. 清除 Authenticode 证书表与签名（postject 要求）。
8. 注入 `NODE_SEA_BLOB`。
9. 复制 `LICENSE`、`README.md` 到 `dist/`。

### 8.3 运行期解压（`scripts/sea-bootstrap.cjs`）

- 读取内嵌资源 → 解压到 `<默认数据目录>\app\<hash>\`；默认目录不可写时回退 `<LOCALAPPDATA>\Temp\LiveMemory-app\<hash>\`、`%TEMP%\LiveMemory-app\<hash>\`。
- **先写入 `*.staging-<pid>` 目录**，写入全部文件与 `.livememory-app.json` 标记后再原子 `rename` 到目标位置；失败会清理临时目录，不会留下半套资源。
- 已有标记且 hash、文件数、文件都存在时直接复用，**不再每次启动重写 64 个文件**（减少杀毒软件/索引器干扰与启动时间）。
- 解压失败会逐级回退，并记录每一步的路径与错误码。
- 之后设置 `LIVE_MEMORY_APP_ROOT`（应用文件位置）、`LIVE_MEMORY_DEFAULT_DATA_DIR`（数据目录偏好），再调用启动器。
- bootstrap 自身失败时：写 `bootstrap-YYYY-MM-DD.log` 与 `startup-error.json`，三语提示 + 交互式等待按键（或 `--error-dialog`），不会静默退出。
- 资源哈希变化会生成新目录；旧目录可在升级时清理（M8）。


## 9. 已验证 / 未验证（v0.8.1）

已验证（本机，2026-11-10）：

- 构建成功，PE 子系统 = 3（Console）。
- 本轮构建：**90.7 MB，119 个资源文件，SHA-256 `62f03b290d98652b6db93eaa491a24b68bdcff4338c31bca779cda78b0f6a409`**。
- **本机执行限制**：最终哈希在 2026-11-10 11:30 后被执行主机的 Device Guard 策略拦截
  （`blocked by your organization's Device Guard policy`）。同一策略下 `23a040...` 旧构建仍可执行；
  最终哈希为新建未签名二进制，本机无法启动。静态校验通过（manifest/版本/资源哈希/迁移字符串），
  但**不能声称最终哈希 EXE 已在本机启动验收**；需在无该策略的机器、签名或加入允许列表后复验。
- **PE Manifest 实测**：`scripts/pe-manifest.mjs` 读取最终 `RT_MANIFEST`，level=`requireAdministrator`，Manifest 773 bytes。
- **以下功能场景均为同源 `23a040...` 构建实测**；最终哈希受 Device Guard 限制，未执行。
- 非提升进程启动同源构建：`spawnSync` 返回 `EACCES`，说明 Windows 在程序代码执行前拒绝启动（Manifest 生效）。
- `scripts/verify-exe.mjs`：**manifest 检查 + 9 个功能场景 = 10/10 通过**；由于当前会话不是管理员，功能场景使用同一二进制的临时 `asInvoker` 副本，并明确打印该事实。若在管理员会话运行，则直接使用最终 EXE。
- 管理员检查消息：asInvoker EXE 副本在未设置 `LIVE_MEMORY_SKIP_ADMIN_CHECK` 时，`--lang zh-CN/ja/en` 分别打印对应“需要管理员权限”消息并以 1 退出（真实 EXE 启动器代码路径）。
- `LiveMemory.exe --version`（asInvoker 副本）→ `LiveMemory 0.8.1`。
- 默认无 `--lang` 的 asInvoker EXE 控制台输出英文；`--lang zh-CN`/`ja` 仍可切换。
- 全新数据目录启动确认 SQLite schema=9、新增 `sessions.platform_status` 等生命周期列存在。
- **打包 EXE AI 往返 UI**：`scripts/verify-exe-ai.mjs` 使用真实 schema 7 数据库启动 `dist/LiveMemory.exe` 的 asInvoker 副本，14/14 通过——v7→v9 升级、UI 创建 3 批任务、粘贴导入 3 个批次、版本记录、汇总包、最终报告、证据来自 EXE 数据库、重启后任务/结果/报告/4 个包文件保持。
- **打包 EXE 历史管理 UI**：`scripts/verify-exe-history.mjs` 使用真实 schema 6 数据库，19/19 通过——v6→v9 升级、历史保留、观众搜索、归档、包含归档、启动模拟直播并从历史列表停止、永久删除、共享观众聚合、重启后归档保持与删除不复活。
- **打包 EXE 生命周期 UI**：`scripts/verify-live-status-ui.mjs` 使用真实 schema 9 数据库与 `dist/LiveMemory.exe` 的 asInvoker 副本，21/21 通过——已下播不再显示绿色 Live、未知结束时间明确标 Unknown、自动下播/手动停止详情、时长固定、中文文案、390px 黑暗主题无横向溢出。
- `/api/youtube/status` 只含 `mode=web`、`capabilities.requiresApiKey/Login/Cookie=false` 与 30 天保留策略；`/api/youtube/login/status` 返回 404；PATCH `youtubeCaptureMode` 返回 400。
- 真实多场：EXE asInvoker 副本附加 3 场真实直播（2 YouTube + Bilibili），3/3 connected，停止一场后 2 场仍 connected；详见 STATUS §4 / TEST_PLAN §13.3（v0.6.0 历史结果）。
- 默认数据目录不可写时回退 `%TEMP%\LiveMemory` 并启动；不可写目录：退出码 1、三语提示、失败步骤、错误码（`EPERM`）、启动日志与 `startup-error.json`。
- 第二实例、强杀恢复、端口顺延、解压复用、跨目录运行均通过。

未验证：

- **真实 AI 服务文件往返**：M6 只验证了 Schema 合法合成结果，未调用任何真实 AI。
- **真实 UAC 交互**：当前进程为 Low Mandatory Level，无法点击“是”。最终 EXE 只验证了 Manifest 内容与非提升启动被拒绝；管理员批准后的完整启动、文件夹选择、迁移、SQLite 写入需要在真实桌面复核。
- **真实文件夹选择器点击/取消/选择**：无交互桌面；已用 PowerShell 启动探测（修复后为 `PICKER_TIMEOUT`，不再 EPERM）与假进程单元测试覆盖逻辑，但没有人工操作。
- **真实 UAC 后的多场运行**：本轮 EXE 多场验证使用临时 asInvoker 副本，不是最终 requireAdministrator 进程。
- 干净 Windows 10/11 虚拟机（无 Node、无开发环境）。
- 只读安装目录（`Program Files`）下的实际安装形态。
- 杀毒软件误报、代码签名。
- 真实 Ctrl+C 关闭与 Windows 关机流程；双屏/高 DPI 控制台字体。

**边界**：UAC 拒绝发生在程序启动前，Windows 终止执行；EXE 内部无法捕获并显示自定义提示。非权限错误（端口、数据库、磁盘断开）仍按各自错误路径显示，不会统一伪装成权限错误。

## 10. 发布与升级（M8）

- 版本号写入 `package.json` 与 `src/shared/app-info.mjs`，二者必须一致（可加测试）。
- 发布包：EXE + README + LICENSE + SHA256SUMS。
- 升级：替换 EXE；数据目录不变；schema 迁移自动执行；旧 `app\<hash>` 目录可清理。
- 发布 EXE 必须在新构建中重新验证 `requireAdministrator` Manifest 与非提升启动被拒绝；不能只沿用旧 EXE 的结论。
- 管理员权限不改变“数据目录优先、位置记录、迁移 staging/回滚、清空范围”规则；同账号 UAC 不改变 `%LOCALAPPDATA%`。
- 回滚：保留上一版本 EXE 与升级前数据库备份（M5 备份机制）。
