# 工程状态（STATUS）

最后更新：2026-11-09（文件夹选择器修复、YouTube 单一公开网页接入、管理员权限 EXE，版本 0.5.0，schema 5）

> 本文件是唯一进度来源。只要代码与本文不一致，以代码与实测为准，并立即修正本文。

## 1. 当前阶段

- 里程碑：**M0 / M1 / M2 核心 / P0 / P1 / P2 / M3 核心完成；M4 与 M7 部分推进；M5 / M6 未完成**
- 版本：`0.5.0`（`package.json` 与 `src/shared/app-info.mjs` 一致）
- 数据库 schema：**5**（本轮未变更；旧库与历史场次/观众/画像全部兼容）
- 分支：`main`，本地提交，未 Push
- 发布形态：`LiveMemory.exe`，RT_MANIFEST **requireAdministrator**

## 2. 本轮完成（2026-11-09）

### 2.1 文件夹选择器修复

- 根因：旧实现用 `execFile('powershell.exe', …)` 并**捕获 stdout 管道**。在受限权限/无控制台父进程/打包 EXE 环境中，Node 子进程管道会以 `spawn EPERM` 失败，因此点击「浏览」直接报“无法打开文件夹选择器”，PowerShell 脚本根本没有执行。
- 修复：
  - `src/server/native-dialog.mjs` 改用 `spawn(..., {stdio: 'ignore'})`，不再创建 stdout/stderr 管道；
  - PowerShell 用 `-EncodedCommand` 接收固定脚本，路径参数以 Base64 传入，避免引号/中文/空格/换行问题；
  - 选择结果写入 `<数据目录>/cache/picker-*.txt` 临时 UTF-8 文件，Node 读取后删除，不依赖 stdout；
  - 原生 `FolderBrowserDialog` + 隐藏 owner form（TopMost），STD 线程 `-STA`；
  - 取消：退出码 0 且无结果文件 → 返回 `null`，前端不报错、不改输入；
  - 脚本错误写 `ERROR:` 结果文件 → 返回可诊断的 `PICKER_FAILED`；超时 `PICKER_TIMEOUT`；
  - PowerShell 候选：`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` → `powershell.exe` → `pwsh.exe`，仅在 `ENOENT` 时回退。
- API `POST /api/storage/location/pick` 传入 `paths.cache` 作为工作目录与当前数据目录作为初始目录；日志记录失败代码，不记录用户路径。
- `.tmp` 探测：修复前同环境直接 `pickFolder` 返回 `EPERM`；修复后返回 `PICKER_TIMEOUT`（说明 PowerShell 已启动并等待对话框），不再出现 spawn 失败。
- 未完成：本环境无交互桌面，**未能人工点击/选择/取消真实对话框**；已用单元测试覆盖选择、取消、脚本错误、spawn 失败与路径编码。

### 2.2 YouTube 接入简化为唯一公开网页路径

- 删除官方实现：
  - `src/platforms/youtube/adapter.mjs`（官方 Data API 适配器）
  - `api.mjs`（YouTube Data API v3 客户端/配额）
  - `oauth.mjs`、`oauth-manager.mjs`、`oauth-config.mjs`、`token-store.mjs`
  - `src/shared/capture-mode.mjs`
  - 对应 5 个官方测试文件
- 新增 `src/platforms/youtube/errors.mjs`，匿名 client/adapter 不再依赖官方 API 模块。
- `YouTubeService` 只保留 `checkVideo()` / `connect()` / `disconnect()` / 状态 / 保留清理；`mode` 固定为 `web`。
- 路由删除 `/api/youtube/login/start|status|logout`；`/api/youtube/video`、`/api/youtube/connect` 不再接受 `mode`。
- `settings.youtubeCaptureMode` 从默认值、允许键、校验与 UI 中移除；旧 settings.json 中的该键在加载时被忽略，不复活第二模式。
- 直播页移除官方/实验模式选择、Google 登录、API Key/OAuth 说明、配额显示、实验 badge；只保留链接输入、检查、开始、连接状态、消息数、可能漏消息、数据保留说明。
- 设置页 YouTube 卡改为只读说明：无需登录/Key/Cookie；非官方稳定 API、可能失效；30 天保留。
- 正常连接界面不再出现大段“实验模式/切换官方接口”警告；说明集中到设置/隐私说明。
- 保留：匿名聊天/SC/Sticker/会员/gift/badge/Unicode Emoji/稳定 Channel ID/身份不完整/断线重连/continuation/429/自动结束/30 天保留。
- schema、数据库、历史场次、观众档案、多主播关系均未改动；旧记录不会被重新归属。

### 2.3 管理员权限 EXE

- 构建脚本在 node.exe 的 PE `RT_MANIFEST` 资源中把 `requestedExecutionLevel` 从 `asInvoker` 改写为 **`requireAdministrator`**（`scripts/pe-manifest.mjs`），并更新资源数据大小。
- 构建输出验证：manifest 773 bytes，level=`requireAdministrator`。
- 非提升进程启动最终 EXE：Windows 返回 `EACCES`（不进入程序），证明清单生效；**UAC 批准后的真实管理员启动无法在本会话验证**（当前进程为 Low Mandatory Level，无交互桌面）。
- 启动器新增防御性 `isAdministrator()`（`net session`，`stdio: 'ignore'`）：
  - 仅在打包 EXE（`LIVE_MEMORY_APP_ROOT`）中检查；
  - 失败时打印三语“需要管理员权限”消息并以 1 退出；
  - 有保存语言偏好时优先该语言；设置读取失败时追加另外两种语言；
  - 非权限错误（端口、数据库、磁盘）仍走各自错误路径，不统一归类。
- 数据目录安全：即使管理员，仍保留路径校验、迁移 staging/校验回滚、删除范围限制；新增跨用户 profile 扫描：打包启动且当前默认目录无数据库时，若在本地用户配置中发现**恰好一个** LiveMemory 数据库，则使用它；发现多个则拒绝猜测并要求 `--data-dir`；不静默创建空库。
- 说明：同一 Windows 管理员账号的 UAC 同意通常保持 `%LOCALAPPDATA%` 不变；若 UAC 改用另一个管理员账号，Windows 会切换用户配置文件，profile 扫描是防止新建空库的兜底，但无法完全等同于原账号环境。

### 2.4 后续修复：“在新目录创建新的数据空间”失败

- 用户反馈：选择“在新目录创建新的数据空间”报“迁移校验失败，已回滚到原目录”；迁移现有数据正常。
- 根因：`copyIntoStage()` 无论 `mode` 都把源 `database/livememory.db` 复制进 staging；`createFreshDatabase()` 在这个已含旧数据的库上执行 `migrate()`，随后新空间校验发现表非空，触发回滚。迁移分支本来就需要复制数据库，所以不受影响。
- 修复：`copyIntoStage(..., {includeDatabase: mode === 'migrate'})`；新空间只复制 `config`/`secrets`，数据库由 `createFreshDatabase()` 真正新建。
- 文案：新空间失败不再显示“迁移”，改用 `errors.newSpaceVerifyFailed` / `errors.newSpaceFailed`。
- 回归测试：`storage-management.test.mjs` 新增“new data space creates an empty database and keeps settings/credentials”，验证 200、0 场次/事件/观众、设置/凭据保留、原目录不动。
- 未验证：真实 EXE UI 点击“创建新数据空间”；当前以真实 HTTP API 集成测试覆盖同一路径。

## 3. 测试

- 全量：**277 passed / 0 failed / 约 21.8 秒**（官方 YouTube 测试随实现删除；新增选择器、manifest、管理员、profile scan、简化约束、新数据空间测试）。
- 新增测试文件：
  - `tests/unit/native-dialog.test.mjs`：编码/成功/取消/错误/EPERM。
  - `tests/unit/pe-manifest.test.mjs`：node.exe manifest 读写。
  - `tests/unit/admin.test.mjs`：管理员检查分支。
  - `tests/unit/profile-scan.test.mjs`：单/多用户数据目录扫描。
  - `tests/unit/youtube-simplified.test.mjs`：官方模块/路由/UI/三语清理断言。
- EXE：`dist/LiveMemory.exe` **90.2 MB / 99 资源**，SHA-256（见 §5）；`verify-exe.mjs` **10/10**（manifest + 9 功能场景；非提权会话使用临时 asInvoker 副本，并明确打印该事实）。
- 本地假网页 YouTube 端到端：通过；真实直播间采样 v0.5.0 **尚未重新执行**（见 §6）。
- 文件夹选择器真实人工点击：**未验证**（环境限制）。

## 4. 未完成 / 未验证

- **真实 UAC 交互**：当前会话非管理员，无法点击 UAC 同意；最终 EXE 只验证了非提升启动被 Windows 拒绝（EACCES）与 manifest 内容。
- **文件夹选择器真实交互**：无交互桌面，无法点击/取消；已用单元假进程验证逻辑，开发环境探测确认 PowerShell 能启动并保持对话框。
- **v0.5.0 真实 YouTube 直播采样**：未重新执行；旧 35 秒样本属于 v0.3.0，简化后代码路径需重新确认。
- 跨管理员账号 UAC 的 profile 扫描只覆盖“恰好一个现有数据目录”；多用户多数据时应用会拒绝启动并要求 `--data-dir`，这是有意的防误选策略。
- 管理员权限下的真实文件夹选择、数据迁移、SQLite 写入未在本会话完成；功能矩阵在 asInvoker 副本上通过。
- 未在干净 Windows 虚拟机验收；未签名；UAC 拒绝在 Windows 启动前发生，EXE 无法捕获。
- M5 可移植备份、M6 AI 导入、M7 AI 画像仍未实现。

## 5. EXE / 构建

- Manifest：`requireAdministrator`（`scripts/pe-manifest.mjs` 实际补丁）
- 当前构建：**90.2 MB，99 资源**，SHA-256 `3ac16ddc4b46e569bfe11b3146e72b874a120c8ade26c3a7b709f2ed40ecf099`
- 历史构建哈希仅用于追溯，不得与当前混淆。

## 6. 真实 YouTube 采样状态

- 本轮尝试重新运行旧链接（2026-11-09）：`FKLZiufsCk0` 与 `gXawf8GZDI8` 均返回 `YOUTUBE_NOT_LIVE_ENDED`，没有可用直播，因此没有 2026-11-09 的真实采样数据。这不代表接入失败，只是样本不可用。
- `scripts/verify-youtube-anonymous.mjs` 可随时执行：
  ```bat
  node scripts/verify-youtube-anonymous.mjs https://www.youtube.com/live/<ID> 35
  ```
- 2026-11-08 的真实样本（`FKLZiufsCk0`、`gXawf8GZDI8`，各 35 秒）记录在 TEST_PLAN 第 10 节，属于 v0.3.0；**不能作为 v0.5.0 的验收结论**。
- 若用户提供当前直播链接，应重新运行并记录：actions/事件/chat/SC/gift/身份完整率/badge/错误/重复。

## 7. 相关文档

`docs/PLATFORM_INTEGRATIONS.md`、`docs/WINDOWS_RUNTIME.md`、`docs/PRIVACY_SECURITY.md`、`docs/UI_DESIGN.md`、`docs/TEST_PLAN.md`、`docs/CHANGELOG.md`、`docs/DECISIONS.md`、`README.md`、`AGENTS.md` 与 `log/2026-11-09-picker-youtube-admin.md` 已同步本轮变化。

## 8. 下一步

1. 在真实管理员桌面点击 UAC，验证文件夹选择、迁移、SQLite 写入与重启路径保持。
2. 用当前直播链接重新执行匿名采样，记录真实结果；不要复用旧样本。
3. 在干净 Windows 虚拟机验收 requireAdministrator EXE、UAC 拒绝提示与数据目录行为。
4. 继续 M6 AI 结果导入；不要恢复官方 YouTube 双轨实现。
