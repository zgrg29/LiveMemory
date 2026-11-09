# 交接文档（HANDOFF）

本轮：2026-11-09 · 文件夹选择器修复、YouTube 单一公开网页接入、管理员权限 EXE · v0.5.0（schema v5）

## 1. 本轮结果

| 目标 | 结论 |
| --- | --- |
| 修复「浏览」文件夹选择器 | 已定位为 `execFile` stdout 管道导致的 `spawn EPERM`；改为 `stdio:'ignore'` + 临时结果文件 + `-EncodedCommand`。逻辑测试通过；真实人工点击未验证（无交互桌面）。 |
| YouTube 只保留公开网页路径 | 删除官方 Data API/OAuth/API Key/token-store/capture-mode 与 5 个官方测试；服务/路由/UI/三语只保留单一入口。 |
| 管理员权限 EXE | RT_MANIFEST 已实际写入 `requireAdministrator`；非提升启动被 Windows 拒绝（EACCES）。UAC 批准后的真实启动未在当前会话验证。 |
| 数据兼容 | schema 仍为 5；未改表/迁移；旧历史、观众、主播关系不会被重新归属。 |

## 1.1 后续修复：新数据空间误报校验失败

- 用户实测：选择“在新目录创建新的数据空间”报“迁移校验失败，已回滚到原目录”；迁移现有数据正常。
- 根因：`src/server/relocation.mjs` 的 `copyIntoStage()` 无论 `mode` 都复制旧 `database/livememory.db`；`createFreshDatabase()` 实际打开旧库，`new_space_not_empty` 校验失败。
- 修复：`copyIntoStage(..., {includeDatabase: mode === 'migrate'})`；新空间只复制 `config`/`secrets`，空库由 migrations 创建。
- 新空间失败文案改为 `errors.newSpaceVerifyFailed` / `errors.newSpaceFailed`。
- 回归测试：`tests/integration/storage-management.test.mjs` 新增新空间用例，验证 200、counts 0、设置/凭据保留、原目录不动。
- 自动化 277 通过；EXE 已重建（新哈希见 §5）。

## 2. 文件夹选择器

### 根因

旧 `native-dialog.mjs` 使用：

```js
execFile('powershell.exe', args, {stdio: ['ignore','pipe','pipe']})
```

Node 在受限/打包/无控制台父进程环境中无法创建捕获管道，直接以 `spawn EPERM` 失败。前端只看到 `PICKER_FAILED`，PowerShell 脚本未执行。开发探测复现：

```text
{"code":"PICKER_FAILED","details":{"code":"EPERM"},"causeMessage":"spawn EPERM"}
```

### 修复

- `spawn(..., {stdio:'ignore'})`，不创建 stdout/stderr 管道。
- PowerShell 脚本通过 `-EncodedCommand`（UTF-16LE Base64）传入；结果路径与初始目录也以 Base64 嵌入，避免中文/空格/引号/换行。
- 结果写入 `<数据目录>/cache/picker-*.txt`（UTF-8），Node 读取后删除。
- `FolderBrowserDialog` + `-STA` + 隐藏 owner form（TopMost）；取消不写文件 → 返回 `null`；脚本错误写 `ERROR:`；spawn 错误/超时分别返回 `PICKER_FAILED`/`PICKER_TIMEOUT`。
- PowerShell 绝对路径优先，`powershell.exe`/`pwsh.exe` 仅在 ENOENT 时回退。
- API 传入 `cache` 工作目录与当前数据目录作为初始目录；日志只记录错误码/消息摘要。

### 验证

- 修复前同环境 `pickFolder` → `EPERM`；修复后同环境 → `PICKER_TIMEOUT`（PowerShell 已启动并保持对话框），不再 spawn 失败。
- 单元测试：成功路径（中文/空格）、取消、脚本 ERROR、spawn EPERM、脚本结构/Base64。
- **未验证**：真实桌面点击、取消、选择目录；需要用户在有交互桌面的 Windows 上确认。

## 3. YouTube 单一接入

删除：

```text
src/platforms/youtube/adapter.mjs
src/platforms/youtube/api.mjs
src/platforms/youtube/oauth.mjs
src/platforms/youtube/oauth-manager.mjs
src/platforms/youtube/oauth-config.mjs
src/platforms/youtube/token-store.mjs
src/shared/capture-mode.mjs
tests/unit/youtube-adapter.test.mjs
tests/unit/youtube-api.test.mjs
tests/unit/youtube-oauth.test.mjs
tests/unit/youtube-token-store.test.mjs
tests/integration/youtube-session.test.mjs
```

新增 `src/platforms/youtube/errors.mjs`，匿名 client/adapter 改用它。

服务：

- `YouTubeService` 仅 `checkVideo()` / `connect()` / `disconnect()` / `status()` / `applyRetention()`。
- `status.mode='web'`，`capabilities.requiresApiKey/Login/Cookie=false`。
- 路由删除 `/api/youtube/login/start|status|logout`；`video`/`connect` 不再接受 `mode`。
- `settings.youtubeCaptureMode` 从默认值/键/校验/UI 删除；旧 settings 中的值加载时忽略。
- 直播页删除官方/实验模式、Google 登录、API Key/OAuth、配额、实验 badge；只保留链接输入、检查、开始、连接状态、消息数、可能漏消息与保留说明。
- 设置页只读说明：无需登录/Key/Cookie；不是官方稳定 API、可能失效；30 天保留。
- 保留匿名适配器全部能力与错误/重连/去重/身份规则。

## 4. 管理员 Manifest

- `scripts/pe-manifest.mjs` 解析 PE `.rsrc` 的 RT_MANIFEST，替换 `requestedExecutionLevel` 并更新 data-entry size。
- 构建脚本在写 EXE 前调用 `setManifestLevel(binary,'requireAdministrator')`。
- 当前构建 manifest：773 bytes，level=`requireAdministrator`。
- 非提升进程启动最终 EXE：`EACCES`；这是 Windows 在程序启动前执行的 UAC 限制，EXE 内无法捕获。
- 启动器 `isAdministrator()` 防御性检查（`net session` + `stdio:'ignore'`），仅在打包 EXE 中启用；失败打印三语消息。`LIVE_MEMORY_SKIP_ADMIN_CHECK=1` 只供 asInvoker 自动化副本使用。
- 跨用户数据目录：打包启动且当前默认目录无数据库时扫描 `C:\Users\*\AppData\Local|Roaming\LiveMemory\database\livememory.db`；恰好 1 个则使用；多个则 `DATA_DIR_AMBIGUOUS` 并要求 `--data-dir`。这是 UAC 切换管理员账号时的防新建空库兜底，不是完整跨账号迁移。

## 5. 测试 / EXE

- 全量：**277 passed / 0 failed / 约 21.8 秒**。
- 删除官方 YouTube 测试后新增 5 个测试文件（选择器、PE manifest、admin、profile scan、简化约束）。
- 本地假网页 YouTube 端到端：通过。
- EXE：90.2 MB / 99 资源，SHA-256 `3ac16ddc4b46e569bfe11b3146e72b874a120c8ade26c3a7b709f2ed40ecf099`；`verify-exe.mjs` 10/10（manifest + 9 功能场景；非提权会话使用 asInvoker 副本）。
- `--version` 见构建 / 最终报告。

## 6. 未验证 / 边界

- 真实 UAC 同意与管理员权限下的完整 UI 流程（当前 Low Mandatory Level）。
- 真实文件夹选择器点击/取消/选择。
- v0.5.0 真实 YouTube 直播采样（旧样本属于 v0.3.0，不能复用）。
- 干净 Windows 虚拟机、代码签名、UAC 拒绝后的自定义提示（Windows 启动前终止）。
- 多用户 profile 扫描在真实多账号环境下的 ACL/性能。
- 端口/数据库/磁盘错误仍按各自错误路径显示，未被统一成权限错误。

## 7. 常用命令

```bat
:: 测试
node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"

:: 真实匿名采样（不要复用旧结果）
node scripts/verify-youtube-anonymous.mjs https://www.youtube.com/live/<ID> 35

:: 构建 / 验证 EXE
node scripts/build-windows.mjs
node scripts/verify-exe.mjs
```

## 8. 本轮 Commit

- 新数据空间修复：`761a54d` fix: create an empty database for a new data space
- 本轮功能：`3efb791` feat: fix folder picker and unify YouTube on public web chat
- 上一轮：`452905c` docs: record the v0.4.0 feature commit
