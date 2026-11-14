# 2026-11-09 · 文件夹选择器修复、YouTube 单一公开网页、管理员 EXE

版本：v0.5.0（schema 5 未变）
范围：本轮用户要求的三项改动
状态：代码、文档、自动化测试、本地提交完成；真实 UAC/真实文件夹点击/真实 YouTube 采样未完成

## 1. 文件夹选择器

### 根因

旧 `src/server/native-dialog.mjs` 使用 `execFile('powershell.exe', …, {stdio: capture})`。Node 需要创建 stdout/stderr 管道；在受限权限、无控制台父进程或打包 EXE 环境中管道创建失败，返回 `spawn EPERM`。PowerShell 实际未启动，前端只看到通用 `PICKER_FAILED`，表现为“点浏览就报无法打开”。

### 修复

- 改为 `spawn(powershell, args, {stdio:'ignore', windowsHide:true})`。
- PowerShell 脚本固定，通过 `-EncodedCommand` 传入；结果路径/初始目录用 Base64 嵌入，避免中文、空格、引号、换行和注入。
- 选择结果写入 `<数据目录>/cache/picker-*.txt`，Node 读取后删除；不再依赖 stdout。
- `FolderBrowserDialog` + `-STA` + 隐藏 TopMost owner form。
- 取消：退出 0 且无结果文件 → `null`，前端不报错、不改变输入。
- 脚本异常：写 `ERROR:<message>` → `PICKER_FAILED` + 诊断；超时 → `PICKER_TIMEOUT`；spawn 错误不再吞掉。
- PowerShell 绝对路径优先；`powershell.exe`/`pwsh.exe` 仅在 ENOENT 时回退。
- API 传入 `paths.cache` 与当前数据目录；日志只记错误码/摘要，不记录用户路径。
- 未做浏览器伪选择器，未要求管理员，手动路径输入保留。

### 验证

- 修复前开发探测：`PICKER_FAILED / EPERM / spawn EPERM`。
- 修复后同环境：`PICKER_TIMEOUT`（PowerShell 已启动并保持对话框），证明不再 spawn 失败。
- `tests/unit/native-dialog.test.mjs`：脚本结构、Base64、成功（中文/空格）、取消、ERROR、EPERM。
- 未验证：真实桌面点击/取消/选择；当前环境无交互桌面。

## 1.1 后续修复：新数据空间误报校验失败

- 用户实测“在新目录创建新的数据空间”报“迁移校验失败”；迁移现有数据正常。
- 根因：`copyIntoStage()` 无条件复制旧数据库；`createFreshDatabase()` 在旧库上执行 `migrate()`，随后 `new_space_not_empty` 校验失败并回滚。
- 修复：`includeDatabase: mode === 'migrate'`；新空间只复制 config/secrets，数据库真正新建。
- 新空间错误文案单独使用 `newSpaceVerifyFailed` / `newSpaceFailed`。
- 新增 `storage-management.test.mjs` 回归用例，断言 200、空库、设置/凭据保留、原目录不动。
- 全量测试 277 通过；EXE 已重建。

## 2. YouTube 单一公开网页

### 删除

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

### 服务 / 路由 / 设置 / UI

- `YouTubeService` 只保留唯一 `web` 路径；状态无登录/配额/模式字段。
- 删除 `/api/youtube/login/start|status|logout`；`video`/`connect` 不再接受 `mode`。
- 删除 `settings.youtubeCaptureMode`；旧 settings 中的键加载时忽略。
- 直播页只保留：链接输入 → 检查 → 开始；连接状态、消息数、可能漏消息、30 天保留。
- 设置页 YouTube 卡改为只读：无需登录/Key/Cookie；非官方稳定 API、可能失效；30 天保留。
- 保留匿名聊天/SC/Sticker/会员/gift/badge/稳定 Channel ID/身份不完整/重连/自动结束。
- 三语 JSON 删除官方/模式/登录/配额/实验旧键；新增简化文案。
- 正常连接 UI 不再堆叠实验模式警告。

### 验证

- `tests/integration/youtube-anonymous-session.test.mjs`：唯一路径 + 5 类事件 + 身份 + 30 天上限 + AI 包。
- `tests/unit/youtube-simplified.test.mjs`：官方模块/路由/UI/三语清理。
- 旧真实样本属于 v0.3.0；v0.5.0 简化后尝试重跑 `FKLZiufsCk0` 与 `gXawf8GZDI8`，均返回 `YOUTUBE_NOT_LIVE_ENDED`，没有可用直播，因此仍无 v0.5.0 真实样本。

## 3. 管理员 EXE

### Manifest

- 新增 `scripts/pe-manifest.mjs`：解析 PE `.rsrc` RT_MANIFEST；替换 `requestedExecutionLevel`；更新 data-entry size；容量不足则构建失败。
- `scripts/build-windows.mjs` 在写 EXE 前把 node.exe manifest 改为 `requireAdministrator`，构建后再次断言。
- 当前 Manifest 773 bytes；构建会检查 `.rsrc` padding，容量不足则失败。
- 非提升进程启动最终 EXE：`EACCES`（Windows 在程序代码执行前拒绝）。

### 启动器

- 新增 `src/launcher/admin.mjs`：`net session` + `stdio:'ignore'` 防御性检查，仅打包 EXE 启用。
- 失败时三语提示“需要管理员权限”，退出 1；有保存语言优先该语言；设置读取失败追加另外两种。
- 非权限错误仍走端口/数据库/磁盘各自路径。
- `LIVE_MEMORY_SKIP_ADMIN_CHECK=1` 仅用于 asInvoker 自动化副本；发布 EXE 的 Manifest 仍强制执行。
- 新增 `profile-scan.mjs`：打包启动且当前默认目录无数据库时，扫描本地用户配置；恰好 1 个现有库则使用，多个则 `DATA_DIR_AMBIGUOUS`，不静默建空库。
- 管理员权限未放宽路径校验、迁移 staging/回滚、删除范围。

### 验证

- `scripts/verify-exe.mjs`：manifest + 9 场景 = 10/10；当前非提权，功能场景使用 asInvoker 副本并明确标注。
- asInvoker 副本 `--lang zh-CN/ja/en`：三语管理员消息正确，退出 1。
- `--version`：0.5.0。
- 最终 EXE：90.2 MB / 99 资源，SHA-256 `3ac16ddc4b46e569bfe11b3146e72b874a120c8ade26c3a7b709f2ed40ecf099`。
- 未验证：真实 UAC 点击、管理员权限下的文件夹/迁移/SQLite 完整流程；当前进程 Low Mandatory Level。

## 4. 测试 / 数据兼容

- 全量：**277 passed / 0 failed / 约 21.8 秒**。
- 删除官方 YouTube 测试后新增 5 个测试文件：native-dialog、pe-manifest、admin、profile-scan、youtube-simplified。
- schema 仍为 5；没有迁移脚本/表结构变化；历史场次、观众、主播关系、AI 包格式未被重写。
- 用户真实数据目录本轮未读写；所有验证使用 `tests/.tmp/`。

## 5. 已知限制

- UAC 拒绝在程序启动前发生，EXE 无法捕获；只能由 Windows 处理。
- 跨管理员账号 UAC 会切换 `%LOCALAPPDATA%`；profile 扫描只覆盖“恰好一个现有库”，多个时拒绝启动，需 `--data-dir`。
- 文件夹选择器真实人工交互未做。
- v0.5.0 YouTube 真实直播采样未做；旧样本不可复用。
- 干净 Windows 虚拟机、签名、杀毒误报、真实断电/拔盘未验证。

## 6. 产物

- EXE：`dist/LiveMemory.exe`
- 新截图：`docs/screenshots/live-youtube-v050-*.png`、`settings-youtube-v050-zh-CN.png`、`settings-data-location-v050-zh-CN.png`
- 文档：STATUS/HANDOFF/ROADMAP/ARCHITECTURE/PLATFORM_INTEGRATIONS/WINDOWS_RUNTIME/PRIVACY_SECURITY/UI_DESIGN/TEST_PLAN/CHANGELOG/DECISIONS/README/AGENTS
- 本地 Commit：见 `git log -1`
