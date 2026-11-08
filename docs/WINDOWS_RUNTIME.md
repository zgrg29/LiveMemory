# Windows 运行与打包（WINDOWS_RUNTIME）

## 1. 交付形态

- 单一可执行文件 `LiveMemory.exe`（当前构建约 89.7 MB）。
- 用户无需安装 Python、Node.js、npm、数据库或任何开发依赖。
- 双击运行，显示命令行窗口并打开默认浏览器控制台。
- 安装目录可以只读；所有用户数据写入 `%LOCALAPPDATA%\LiveMemory\`。

## 2. 启动流程（实现位置：`src/launcher/launcher.mjs`）

1. 解析参数（`--no-open`、`--port`、`--data-dir`、`--lang`、`--version`、`--help`、`--no-wait`、`--diagnose`、`--error-dialog`）。
2. **立即创建启动日志**（此时数据库、配置、数据目录都还不存在）：写入 `%LOCALAPPDATA%\LiveMemory\logs`，失败则逐级回退 `%TEMP%\LiveMemory-logs`、用户目录；解析出数据目录后再迁入 `<数据目录>\logs`。
3. `chcp 65001` 将控制台代码页设为 UTF-8（仅 TTY）。
4. 检查 Node ≥ 22.5 与 `node:sqlite` 可用性。
5. 解析可写数据目录（真实写探测，见 §5），创建 `config/ database/ logs/ cache/ exports/ backups/ runtime/ secrets/`。
6. 读取 `config/settings.json` → 决定命令行语言（保存偏好优先；`--lang` 临时覆盖）。配置损坏或不可读不阻塞启动。
7. 单实例锁：`runtime/instance.lock`（PID + `runtime.json` + `/api/health` 校验；陈旧锁自动接管）。
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
├── backups\            未来备份
└── runtime\            instance.lock / runtime.json / last-error.json
```

解析顺序：`--data-dir` → `LIVE_MEMORY_DATA_DIR` → `%LOCALAPPDATA%\LiveMemory` → `%APPDATA%\LiveMemory` → 用户目录。
显式指定但不可写时**直接报错**，不会静默换目录。

## 5. 权限

- 正常运行不需要管理员权限；普通用户令牌即可完成数据库、日志、锁与网络监听。
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
3. 遍历 `src/`，生成 `manifest.json`（文件列表 + 内容哈希 + 版本）。
4. 生成 `sea-config.json`（assets + bootstrap），运行 `node --experimental-sea-config` 生成 blob。
5. 复制当前 `node.exe`，将 PE Subsystem 改为 `IMAGE_SUBSYSTEM_WINDOWS_CUI`（3，可见控制台）。
6. 清除 Authenticode 证书表与签名（postject 要求）。
7. 注入 `NODE_SEA_BLOB`。
8. 复制 `LICENSE`、`README.md` 到 `dist/`。

### 8.3 运行期解压（`scripts/sea-bootstrap.cjs`）

- 读取内嵌资源 → 解压到 `<默认数据目录>\app\<hash>\`；默认目录不可写时回退 `<LOCALAPPDATA>\Temp\LiveMemory-app\<hash>\`、`%TEMP%\LiveMemory-app\<hash>\`。
- **先写入 `*.staging-<pid>` 目录**，写入全部文件与 `.livememory-app.json` 标记后再原子 `rename` 到目标位置；失败会清理临时目录，不会留下半套资源。
- 已有标记且 hash、文件数、文件都存在时直接复用，**不再每次启动重写 64 个文件**（减少杀毒软件/索引器干扰与启动时间）。
- 解压失败会逐级回退，并记录每一步的路径与错误码。
- 之后设置 `LIVE_MEMORY_APP_ROOT`（应用文件位置）、`LIVE_MEMORY_DEFAULT_DATA_DIR`（数据目录偏好），再调用启动器。
- bootstrap 自身失败时：写 `bootstrap-YYYY-MM-DD.log` 与 `startup-error.json`，三语提示 + 交互式等待按键（或 `--error-dialog`），不会静默退出。
- 资源哈希变化会生成新目录；旧目录可在升级时清理（M8）。


## 9. 已验证 / 未验证

已验证（本机，2026-11-08，普通权限 = 非管理员令牌，最终源码构建）：

- 构建成功，PE 子系统 = 3（Console）
- 本轮构建：90.1 MB，92 个资源文件，SHA-256 `a1becfb6e18606c5db59dc4f8c218dd473d08dab931116a310887ec1a76b2d2d`
- 全新数据目录启动确认 SQLite schema=3、`platform_started_at` 列存在、`live.js` 含 YouTube 来源标签
- `/api/youtube/status` 在未配置构建中返回 `configured=false`、`authMode=none`、`policy.days=30`，界面显示「这个构建没有包含开发者凭据」，不提供伪造登录
- `LiveMemory.exe --version` → `LiveMemory 0.2.0`
- `scripts/verify-exe.mjs` 自动矩阵：全新目录启动、HTTP API、SQLite 写入、重启保留、强制结束后恢复、端口占用顺延、第二实例、不可写目录报错、复制到 `Downloads` 运行、解压复用、`--version` / `--help --lang ja` / `--diagnose`
- 默认数据目录不可写时自动回退到 `%TEMP%\LiveMemory` 并启动成功（本机沙箱拒绝 `%LOCALAPPDATA%`/`%APPDATA%`，正好覆盖该分支）
- 不可写目录：退出码 1、三语提示、失败步骤、错误码（`EPERM`）、启动日志与 `startup-error.json`
- 第二实例：真实在运行时提示并退出 0；进程被强制结束后重启会接管陈旧锁
- 解压目录带标记，第二次启动不再重写
- `/api/health`、`/api/bootstrap`、`index.html`、`js/app.js` 均 200
- 控制台输出中文/日文正常（UTF-8）

**YouTube 凭据与 EXE 的关系**：EXE 内嵌的是 `src/**` 源码，默认不包含任何 Google 凭据；发布者若要提供「匿名公开直播模式」，必须在构建/部署时注入 API Key（环境变量或数据目录私有文件），并且需要自行评估 Developer Policies III.D.1.d 对开源项目内嵌凭据的限制。EXE 内不含 OAuth 客户端时，主播只能看到「尚未配置」说明，不能登录。

未验证：

- **真实交互式桌面双击**（本执行环境无法创建桌面会话；已确认进程为非管理员令牌，但「双击后窗口保持可见/浏览器自动弹出」仍需用户本机确认）
- **管理员模式对照**（本环境无法触发 UAC 提权）
- 干净 Windows 10/11 虚拟机（无 Node、无开发环境）
- 只读安装目录（`Program Files`）下的实际安装形态
- 杀毒软件误报与代码签名
- 真实 Ctrl+C 关闭与 Windows 关机流程
- 双屏/高 DPI 下的控制台字体

**边界**：如果 Windows 在进入程序前就阻止运行（映像损坏、SmartScreen、组策略），进程无法输出任何内容；这属于操作系统层，程序无法捕获。除此之外的启动失败都会留下日志与可见提示。


## 10. 发布与升级（M8）

- 版本号写入 `package.json` 与 `src/shared/app-info.mjs`，二者必须一致（可加测试）。
- 发布包：EXE + README + LICENSE + SHA256SUMS。
- 升级：替换 EXE；数据目录不变；schema 迁移自动执行；旧 `app\<hash>` 目录可清理。
- 回滚：保留上一版本 EXE 与升级前数据库备份（M5 备份机制）。
