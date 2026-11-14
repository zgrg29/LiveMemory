# RC0-ADMIN-MANIFEST：恢复双击自动请求管理员权限（2026-11-14）

## 1. 用户决定与范围

用户在实际电脑上双击上一版（`asInvoker`）`LiveMemory.exe` 时无法启动：

- 失败步骤：`Bootstrap`
- 详细信息：`No writable application folder`

用户明确决定：**不再调查目录权限、不修改 Bootstrap 目录选择策略、不做额外架构重构；只恢复 EXE 启动时自动请求管理员权限。**

本轮只允许修改管理员权限相关内容及必要的测试和文档：

- 不做目录权限诊断；
- 不改 Bootstrap / 数据目录解析；
- 不改 AI、直播采集、长期画像、Provider、备份恢复；
- 不新增使用限制；
- 不 Push、不 Tag、不发布。

## 2. 修改

### 2.1 Manifest

- `scripts/build-windows.mjs`：
  - `setManifestLevel(binary, 'asInvoker')` → `setManifestLevel(binary, 'requireAdministrator')`；
  - 注入前断言失败信息改为 `failed to apply requireAdministrator manifest`；
  - postject 注入后读取最终 EXE，断言 `final EXE manifest is not requireAdministrator`。
- `scripts/pe-manifest.mjs`：注释更新；`setManifestLevel` 仍支持三种 level，供测试副本与旧二进制检查。
- 正式 EXE 的 RT_MANIFEST 变为 `requireAdministrator`：Windows 在双击时显示标准 UAC；程序不绕过、
  不关闭 UAC；用户拒绝时由 Windows 取消启动。

### 2.2 测试启动方式

自动化在非交互、非提升会话运行，无法点击 UAC。测试**没有绕过 UAC**，而是：

- 新增 `scripts/test-exe-copy.mjs`：
  - 读取 `dist/LiveMemory.exe`；
  - 断言其 Manifest 确为 `requireAdministrator`；
  - 只在内存中把副本改为 `asInvoker`，写入 `tests/.tmp/`；
  - 正式 EXE 不被修改，也不交付该副本。
- 更新脚本：
  - `verify-exe.mjs`：正式 Manifest 单独一条断言；功能场景使用测试副本；启动日志打印 shipped/test copy 路径。
  - `verify-help-exe.mjs`：同上，仍验证说明页入口、三语、认证、schema。
  - `verify-p0-5-exe.mjs`：同上，保留认证/Origin/Host/SSE 全部场景。
  - `verify-p0-2-exe.mjs`：同上，保留备份/恢复/重启闭环。
  - `verify-ai-token-exe.mjs`：同上，保留 AI 分析与 Token 归因。
  - 历史 UI 脚本 `verify-exe-history.mjs`、`verify-exe-ai.mjs`、`verify-live-status-ui.mjs`、
    `verify-youtube-lifecycle-exe.mjs`：同步改为测试副本，避免以后运行时报 ERROR_ELEVATION_REQUIRED。
- `tests/unit/pe-manifest.test.mjs`：
  - 保留“助手可生成 asInvoker 测试副本”的测试；
  - 构建脚本测试改为断言 `requireAdministrator`，并断言不再 `setManifestLevel(binary, 'asInvoker')`。

### 2.3 注释同步

- `src/launcher/launcher.mjs`：说明打包 EXE 请求管理员权限、Windows 负责 UAC、拒绝即取消。
- `src/launcher/profile-scan.mjs`：说明当前 EXE 再次使用 `requireAdministrator`，保守扫描继续保留。
- `src/server/auth.mjs`：威胁模型说明提权监听器仍需认证；无行为变化。

### 2.4 明确未改

- Bootstrap 目录选择与回退、数据目录解析、位置记录、迁移、删除范围。
- AI 分析、长期画像、事实合并、批次调度、Provider 配置与凭据存储。
- 备份 `.livememory` 格式、恢复 journal、ZIP/路径/大小/CRC 校验。
- 数据库 schema 16、结果 Schema 1.3.0、提示词 v13.2、默认 10 人/批。
- 版本号：仍为 0.13.2。

## 3. 安全机制（保持不变）

- 除 `/api/health`、`/api/auth/status`、`/api/auth/session` 外所有 `/api/*`（含 SSE）要求随机
  会话 Cookie；未认证仍 401。
- Bootstrap token 只放在 URL fragment，一次使用、5 分钟过期，不进入查询串、日志或 runtime.json。
- 全方法 Origin 同源、`Origin:null` 拒绝、跨站 `Sec-Fetch-Site` 拒绝、Host 严格校验、无 CORS 放行。
- API Key 只存本地加密凭据库；备份排除凭据；恢复回滚与数据完整性检查不变。
- 管理员权限不是 API 授权边界；提权不放宽任何认证或数据规则。

## 4. 构建与测试结果

### 4.1 构建

```text
node scripts/build-windows.mjs
```

- buildId `e438e74803cb`
- source hash `e438e74803cbd92ff07fc85db47acada2d3b8f9d2f794f83c0982c03d6817392`
- SHA-256 `0cf672438a4723589f4164316e98965a6ff549a132deb30a243638a3f62531c8`
- size `96,733,184` B（92.3 MB）
- builtAt `2026-11-14T15:28:38.727Z`
- commit（构建时 HEAD）`cb286241fe5a4b3322455d661218bb0a14044983`
- Manifest `requireAdministrator`
- assets `192`；required modules `21`

### 4.2 自动化

- `tests/unit/pe-manifest.test.mjs`：2/2。
- 全量：**828 passed / 0 failed / 0 skipped（212,358 ms）**。
- 正式 EXE 矩阵（功能场景使用测试副本，Manifest 单独断言）：
  - `verify-exe` **10/10**
  - `verify-help-exe` **14/14**
  - `verify-p0-5-exe` **12/12**
  - `verify-p0-2-exe` **13/13**
  - `verify-ai-token-exe` **16/16**

### 4.3 未验证

- 真实 UAC 弹窗、点击“是/否”、UAC 拒绝后的系统行为：本会话无法交互，列用户人工验收。
- 干净 Windows 账户/另一台电脑上提权后的数据目录与浏览器打开：未验证。
- 提权是否会让 `profile-scan` 命中另一个管理员账户的旧库：逻辑未改，未实测。

## 5. 用户验收步骤

1. 完全退出旧版 LiveMemory。
2. 双击新的 `LiveMemory.exe`；Windows 应弹出标准 UAC。
3. 点击“是”：管理员权限启动；控制台应显示 `Build ID: e438e74803cb`。
4. 点击“否”：Windows 取消启动，属预期。
5. 启动后检查直播、历史、观众、AI 分析、备份与使用说明入口。

## 6. 状态

代码级与自动化/打包级验证完成；**真实 UAC 交互等待用户亲自双击验收**。未 Push / Tag / 发布。
