# 2026-11-18 AI Provider 凭据迁移至 Windows Credential Manager

## 1. 背景

用户反馈部分 Windows 用户在保存 AI Provider 配置时得到
`AI_PROVIDER_CREDENTIAL_PERMISSION`，提示无法把 API Key 写入本地加密凭据库。开发者无法复现，
也不能要求用户检查 Windows 权限、删除配置或提供诊断。本轮目标是从软件自身消除这一类
凭据文件权限故障，同时保留旧 Key、不要求新增用户步骤。

## 2. 调查

### 2.1 旧实现

- `src/ai/providers/store.mjs`：配置 JSON 只保存 `credentialReference`；Key 进入
  `src/platforms/shared/secret-store.mjs` 的 `EncryptedJsonStore`。
- `secrets/ai-keys.json`：AES-256-GCM 密文；`secrets/ai-keys.key`：每安装随机密钥。
- `restrictPermissions()`：`icacls <file> /inheritance:r /grant:r <USERNAME>:(R,W)`。
- `AI_PROVIDER_CREDENTIAL_PERMISSION` 来自文件写入/改名的 `EACCES`/`EPERM`。

### 2.2 为什么普通用户会失败

无法取得用户环境样本，因此不能声称单一根因；但代码审计确认了多个真实风险面：

1. `icacls` 的 `/grant:r ...:(R,W)` 不含 DELETE。保存采用“写临时文件 → rename 覆盖目标”；
   Windows 覆盖改名需要目标 DELETE 权限。ACL 生效后，后续更新可能失败。
2. `/inheritance:r` 与 `/grant:r` 在同一条命令中执行。若当前账户名无法解析（Microsoft
   账户、域账户、另一个管理员账户），可能先移除继承而未成功授权，导致当前用户失去访问。
3. 密钥文件与密文文件都在数据目录内；跨管理员账户 over-the-shoulder、目录 ACL 异常、
   旧文件被占用、杀毒/索引器锁定都会让保存失败。
4. 旧库损坏/密钥损坏时，历史实现曾把“不可读”当成空库；v0.19.0 已修复为拒绝覆盖，但
   仍然无法写入。
5. `requireAdministrator` 不保证进程仍在双击它的账户下；另一个管理员账户的
   `%LOCALAPPDATA%` 与 ACL 都可能不同。不能假设管理员权限能读取其他用户的加密凭据。

## 3. 方案选择

### 3.1 评估 Windows Credential Manager

优点：

- Windows 原生 DPAPI，按当前用户 SID 隔离；不依赖数据目录 ACL。
- 每个 Generic Credential 独立；支持保存/读取/修改/删除；Windows 重启后保留
  （`CRED_PERSIST_LOCAL_MACHINE`）。
- 不引入云服务、账号体系或运行时依赖。

限制与处理：

- **Node 没有内置 FFI**。不引入原生 addon（会破坏 SEA 零依赖）。采用固定 Windows
  PowerShell 脚本 + 内嵌 C# P/Invoke（`Add-Type`）调用 `CredWriteW`/`CredReadW`/
  `CredDeleteW`。这不是第三方服务；PowerShell 是 Windows 内置组件。
- **单条 blob 上限 2560 字节**。API Key 通常远小于此；仍实现 2400 字节分块，支持现有
  8192 字节上限，并在更新/删除时清理旧块。
- **不能传 Key 到 argv/env/临时明文文件**。请求 JSON（含 base64 Key）只经 stdin；
  脚本与命令行不含 Key；Add-Type 临时目录只含固定 C# 代码。
- **受限账户的 `%TEMP%` ACL**。真实 EXE 验收发现 `Add-Type` 写默认 `%TEMP%` 被拒绝；
  改为使用 `<数据目录>\cache\`（应用已证明可写），EXE 验收通过。
- **PowerShell/组策略不可用**。明确返回 503 `AI_PROVIDER_CREDENTIAL_BACKEND_UNAVAILABLE`，
  不伪造成功、不回退明文；用户可重试或重新输入 Key。

结论：适合当前 Node SEA 架构，选择 Credential Manager 作为主存储；旧 AES 文件保留为
迁移来源与加密只读回退。

## 4. 实现

### 4.1 新模块

`src/platforms/shared/credential-store.mjs`：

- `WindowsCredentialStore`：target 前缀 `LiveMemory/ai-provider/v1/`，只接受
  `aicred_<32 hex>`；读取缓存；批量读取；分块；错误状态。
- `PowerShellCredentialBridge`：固定脚本、`-EncodedCommand`、stdin JSON、安全环境、
  超时/错误分类、`tempDir`。
- `FileCredentialBackend`：旧文件后端适配器，保留测试/嵌入使用；仍拒绝覆盖损坏文件。
- `CredentialBackendError`：`CREDENTIAL_BACKEND_UNAVAILABLE` / `_ACCESS_DENIED` /
  `_WRITE_FAILED` / `_CORRUPT` / `_VERIFY_FAILED` 等。

### 4.2 存储语义

- 单条 Key：blob = `0x01 + UTF-8 Key`。
- 分块 Key：parts 写 `<base>#<gen>#<i>`，最后写 marker
  `0x02 + {"v":1,"gen":...,"parts":n}`；更新/删除先读旧 marker，再清理旧 parts。
- 写入脚本读回校验；失败不更新 store 缓存。
- `clear(references)` 一次调用删除多条（恢复出厂设置）。

### 4.3 迁移

- `ProviderConfigStore.load()` 读取旧 `EncryptedJsonStore.loadDetailed()`。
- 旧文件缺失：正常。
- 旧文件不可读/密钥坏：状态 `legacyCredential.readable=false`；不修改旧文件；新 Key 仍可保存。
- 旧文件可读：按配置引用逐个迁移；已存在的新值不覆盖；写后读回校验；全部成功才写
  `secrets/ai-keys.migration.json`（含来源哈希，避免重复迁移）。
- 迁移中断/失败：不写标记；下次重试；旧文件字节不变。
- `secret()` 先读新后端；为空时从旧文件只读回退。新 Key 永不写回旧文件。
- 删除配置/更新引用只清理新后端；旧文件保留。

### 4.4 错误与 UI

- 新增 6 个十语错误/诊断键（2,379）。
- `describeError()` 传 `details` 参数，修复 `{path}`；`{code}` 回退为错误码。
- 设置页显示旧迁移失败与新后端不可用告警；保存按钮旁显示具体码。
- 不记录 Key、Authorization、Cookie、Token。

### 4.5 其他

- 恢复出厂设置：`clearCredentials()` 清理当前配置引用；失败不声称已清理。
- 平台 Cookie 的旧文件 ACL：改为先 `grant:r SID:(F)`，成功后再 `/inheritance:r`，
  避免授权失败却移除继承，并补上 DELETE 权限。
- 构建脚本必需模块加入 `credential-store.mjs`。

## 5. 测试

### 5.1 自动化

- 新增 unit：`tests/unit/credential-store.test.mjs` 10 项；
  `tests/unit/provider-credential-migration.test.mjs` 8 项。
- 新增 integration：`tests/integration/provider-credential-store.test.mjs` 7 项；
  `tests/integration/windows-credential-manager.test.mjs` 2 项（默认 skip，opt-in）。
- 全量 unit **889 passed / 0 failed / 0 skipped**（最终复跑 24,925 ms）。
- 全量 integration **405 passed / 0 failed / 2 skipped**（最终复跑 359,924 ms）。
- 合计 **1,294 passed / 0 failed / 2 skipped**。
- 真实 CredMan opt-in **2/2 passed**；测试使用随机 target，finally 清理。
- 真实 EXE `verify-provider-save-exe` **24/24 passed**：fresh、尾换行、重启、旧尾斜杠、
  OpenCode 切换、自定义端点、损坏旧库不阻塞、旧文件不变、新 Key 保存、删除清理、损坏配置、
  首次启动迁移、迁移标记；测试结束清理全部测试 vault 条目。

### 5.2 未执行

- 整机 Windows 重启后持久化（使用 EXE 退出/重启 + `CRED_PERSIST_LOCAL_MACHINE` 作为证据，
  不声称整机重启已实测）。
- 第二个 Windows 用户 / 真实 UAC over-the-shoulder。
- 组策略禁用 PowerShell 或 Credential Manager 的真实环境。
- 干净 Windows 环境；EXE 未签名。

## 6. 兼容性 / 升级

- 数据库 Schema 仍 16；直播记录、观众、画像、AI 任务与报告不变。
- 正常配置与旧 Key 保留；旧文件不删除。
- 降级到旧版本时，旧 Key 仍在 `ai-keys.json`；但新版本保存的新 Key 只在 CredMan，
  旧版本看不到。升级后不要依赖降级读取新 Key。
- 同一 Windows 用户、同一数据目录下迁移无感；跨 Windows 账户需要重新输入 Key
  （Credential Manager 账户隔离，非数据丢失）。

## 7. 结论

- 选择的存储方案：Windows Credential Manager（DPAPI，按用户 SID；PowerShell + C# P/Invoke）。
- 比旧方案可靠：不再依赖数据目录内凭据文件 ACL；每个 Key 独立；迁移/回滚/错误分类明确。
- 已知权限故障：消除了“凭据文件 ACL/可写性”这一类；不能消除所有数据目录/配置文件权限故障。
- 旧用户：可无损迁移；不可读时保留旧文件并允许重新输入。
- 仍有限制：整机重启、跨账户、UAC over-the-shoulder、组策略禁用、干净环境未人工验收。
- 发布建议：适合作为 `0.19.1` 补丁发布；需用户授权后再改版本、构建、Tag/Release。
