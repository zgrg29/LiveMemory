# Windows 运行与打包（WINDOWS_RUNTIME）

## 1. 交付形态

- 单一可执行文件 `LiveMemory.exe`（当前构建约 89.7 MB）。
- 用户无需安装 Python、Node.js、npm、数据库或任何开发依赖。
- 双击运行，显示命令行窗口并打开默认浏览器控制台。
- 安装目录可以只读；所有用户数据写入 `%LOCALAPPDATA%\LiveMemory\`。

## 2. 启动流程（实现位置：`src/launcher/launcher.mjs`）

1. 解析参数（`--no-open`、`--port`、`--data-dir`、`--lang`、`--version`、`--help`、`--no-wait`）。
2. `chcp 65001` 将控制台代码页设为 UTF-8（仅 TTY）。
3. 检查 Node ≥ 22.5 与 `node:sqlite` 可用性。
4. 解析可写数据目录，创建 `config/ database/ logs/ cache/ exports/ backups/ runtime/`。
5. 读取 `config/settings.json` → 决定命令行语言（保存偏好优先；`--lang` 临时覆盖）。
6. 单实例锁：`runtime/instance.lock`（PID + 存活检测 + 陈旧接管）。已有实例时打印地址并打开浏览器后退出 0。
7. 启动服务：绑定 `127.0.0.1`，端口 47800 → +1…+9 → 系统分配。
8. 服务就绪后写 `runtime/runtime.json`（pid/port/url/version），打印状态，打开默认浏览器。
9. 等待信号；收到 SIGINT/SIGTERM 后：停止适配器 → 关闭 SSE → 关闭 HTTP → WAL checkpoint → 关闭数据库 → 删除 runtime 文件。

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

- 正常运行不需要管理员权限。
- 不写注册表、不写 `Program Files`、不写 EXE 所在目录。
- 数据目录不可写时：显示本地化错误、给出路径与 `--data-dir` 替代方案，不要求“以管理员身份运行”。

## 6. 单实例与重复启动

- 锁文件按数据目录隔离；不同数据目录可并存（用于测试/多账号场景）。
- 第二次启动检测到存活 PID：打印“已在运行”，读取 `runtime.json` 的 URL 并打开浏览器，退出 0。
- 进程崩溃留下的锁：`isProcessAlive` 判定死亡后接管。
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

- 读取内嵌资源 → 解压到 `<数据目录>\app\<hash>\`。
- 若该位置不可写，回退到 `<用户临时目录>\LiveMemory-app\<hash>\`。
- 之后把 `LIVE_MEMORY_DATA_DIR` 指向数据目录并调用启动器。
- 资源哈希变化会生成新目录；旧目录可在升级时清理（M8）。

## 9. 已验证 / 未验证

已验证（本机，2026-11-08，最终源码构建）：

- 构建成功，PE 子系统 = 3（Console）
- `LiveMemory.exe --version` → `LiveMemory 0.1.0`
- 首次运行解压 64 个资源文件（`app\612f0f97b537a08cdad4`）、创建数据目录、启动服务
- `/api/health`、`/api/bootstrap`、`index.html`、`js/app.js` 均 200
- 第二实例提示“已在运行”并给出 URL
- `--help --lang ja` 输出日文帮助
- 控制台输出中文/日文正常（UTF-8）

未验证：

- 干净 Windows 10/11 虚拟机（无 Node、无开发环境）
- 非管理员账户 + `Program Files` 只读安装目录
- 杀毒软件误报与代码签名
- 真实 Ctrl+C 关闭与 Windows 关机流程
- 双屏/高 DPI 下的控制台字体

## 10. 发布与升级（M8）

- 版本号写入 `package.json` 与 `src/shared/app-info.mjs`，二者必须一致（可加测试）。
- 发布包：EXE + README + LICENSE + SHA256SUMS。
- 升级：替换 EXE；数据目录不变；schema 迁移自动执行；旧 `app\<hash>` 目录可清理。
- 回滚：保留上一版本 EXE 与升级前数据库备份（M5 备份机制）。
