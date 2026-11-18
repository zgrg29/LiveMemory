# 2026-11-18 AI Provider 配置保存可靠性修复

- 起点：v0.18.0 正式发布后（`142ec4a`，工作区 clean）
- 性质：发布后专项修复；**未 Push / Tag / Release**，等待用户确认
- 版本 / Schema：`0.18.0`（未发布修复）/ 16（无迁移）

## 1. 问题与复现

用户反馈：点击「保存 API 配置」提示「API 配置无效」，开发者自己的 Windows 环境无法复现。
此前还有 OpenCode 请求头错误、切回 DeepSeek 无法保存、手动删除 AppData 权限问题。

本轮不预设单一根因，使用隔离数据目录 `tests/.tmp/` + 真实本地 HTTP 路由 +
可控文件系统故障注入，复现出 6 个独立缺陷：

| # | 复现 | 根因 |
| --- | --- | --- |
| 1 | 旧 DeepSeek/OpenCode 配置 `baseUrl` 末尾有 `/`，表单保存返回 400 `AI_PROVIDER_REGION_KEY_REQUIRED`；旧自定义配置保存后 `hasCredential=false` | 前后端用原始字符串比较 Base URL；表单发送规范 URL，被误判为换端点；自定义路径轮换 reference 却不写新 Key |
| 2 | `apiKey: 'sk-valid\n'` 返回 400 `AI_PROVIDER_KEY_INVALID`，UI 显示「API 配置无效」 | `#validateKey()` 在 `trim()` 前拒绝 `\r\n`；前端发送输入框原值 |
| 3 | 任意已知校验错误 HTTP 响应 `messageKey` 都是 `errors.aiProviderConfigInvalid` | `providerConfigError()` 对全部已知 code 使用同一 messageKey |
| 4 | 注入 EACCES/EBUSY：旧 Key 先被删除/配置只写一半；损坏 `ai-keys.json` 后保存覆盖整个库 | `create/update` 非事务；`EncryptedJsonStore.load()` 把“缺失/损坏/密钥坏”都当空库 |
| 5 | 自定义 Base URL 指向 OpenCode Go，测试返回 400 `MissingSessionID` | 自定义 Provider 没有 `sessionHeader` |
| 6 | 完整表单 PATCH 后 `contextLength:null` 变成 `0` | `merged` 中已有 `null`，`Number(null) === 0` 被当成有效值 |

## 2. 修复

- `url-safety.mjs`：`sameBaseUrl()` / `canonicalBaseUrlKey()`，尾斜杠/主机大小写/默认端口归一。
- `store.mjs`：
  - Key 外层 trim 后校验；内部 CR/LF/NUL 仍拒绝。
  - 已知 Provider 保存规范 Base URL；端点未变保留 credentialReference；真正换端点且已有凭据时要求新 Key。
  - 写入顺序：新凭据 → 配置 JSON → 成功后清理旧引用；失败回滚新凭据/恢复旧 Key。
  - 损坏的 `ai-providers.json` 保存为 `ai-providers.json.<reason>-<timestamp>.json`；`loadState` 报告。
  - 损坏凭据库/密钥拒绝写入，原文件字节不变。
  - `contextLength` 的 null/空值不再变成 0。
- `secret-store.mjs`：`CredentialStoreError`、`loadDetailed()`、`strictKey`；区分缺失/损坏/密钥缺失/密钥损坏。
- `adapters.mjs`：仅 `opencode.ai` / `*.opencode.ai` 的自定义 Base URL 补发
  `x-opencode-session` + `User-Agent: LiveMemory/<version>`。
- `routes.mjs`：具体 code/messageKey/httpStatus；EACCES/EPERM、EBUSY、EROFS、ENOSPC、ENOENT、
  凭据库错误分开；GET `/api/ai/providers` 返回 `loadState` 与 `credentialError`。
- `ai-settings.js`：保存/测试错误显示在按钮旁（`role=alert`），含本地化消息、错误码与路径；
  尾斜杠比较；发送前 trim Key；配置加载/凭据库错误顶部告警。
- `i18n`：十语新增 20 个错误 + 2 个 UI 键，2,351 → **2,373**。
- `launcher.mjs`：启动日志新增 `data-dir.identity`（账户、USERPROFILE、LOCALAPPDATA、
  数据目录、source、crossProfile），用于区分保存错误与跨管理员账户写入。

## 3. 测试

新增：

- `tests/unit/provider-config-save.test.mjs`：14 项（Base URL 归一、8 个 Provider 保存、
  Key trim/拒绝内部换行、三种失败回滚、损坏库/密钥、损坏配置、旧字段、contextLength、
  空 credentialReference、自定义 OpenCode 头）。
- `tests/integration/provider-config-save.test.mjs`：13 项（全新安装、保存不联网、具体错误、
  trailing newline、旧尾斜杠、自定义保 Key、OpenCode→DeepSeek、DeepSeek→自定义、
  失败重试、权限错误、文件锁、损坏配置、重启持久化）。
- `tests/helpers/faulty-fs.mjs`：EACCES/EBUSY 注入，不修改真实权限。

结果：

| 运行 | 结果 |
| --- | --- |
| 新增 unit | **14 passed / 0 failed** |
| 新增 integration | **13 passed / 0 failed** |
| 全量 unit | **871 passed / 0 failed / 0 skipped**（20,859 ms） |
| 全量 integration | **398 passed / 0 failed / 0 skipped**（374,382 ms） |
| 合计 | **1,269 passed / 0 failed / 0 skipped**（分两次单进程模式） |
| 十语字典 | 10 × **2,373**，键集/占位符/空值/英文残留 0 |

## 4. Windows EXE

| 项目 | 值 |
| --- | --- |
| 文件 | `dist/LiveMemory.exe` |
| Build ID / commit | `70db54b950e7` / `a2d06e6` |
| builtAt | `2026-11-18T13:11:15.824Z` |
| 大小 / SHA-256 | 99,551,744 B / `e8f9751f61651d22dc0d2c1935e10463009b8e53b5d69d88364f049c4226f9f4` |
| Manifest | `requireAdministrator`（构建断言 + 注入后复读） |
| 模块 / 资源 | 70 required modules / 256 files |
| 新验收 | `scripts/verify-provider-save-exe.mjs` **14/14 passed** |
| 回归 | `scripts/verify-exe.mjs` **11/11**；`scripts/verify-help-exe.mjs` **14/14**；`scripts/verify-ai-token-exe.mjs` **16/16**；`--version` 显示 `0.18.0` / Build `70db54b950e7` / commit `a2d06e6` |
| 验收内容 | 真实 EXE：fresh install；DeepSeek 保存；Key 尾换行；配置/Key 重启保留；旧尾斜杠保存；OpenCode→DeepSeek；DeepSeek→自定义；凭据写失败返回具体错误；移除阻塞后重试；损坏凭据库不覆盖；损坏配置保留 `.unreadable-*` 备份 |
| 自动化副本 | 正式 EXE `requireAdministrator`；功能场景使用同 buildId 的 asInvoker 副本，不修改正式 EXE、不绕过 UAC |
| 未验证 | 真实双击 UAC（同意/拒绝）、干净 Windows 账户、跨管理员 over-the-shoulder、真实删除权限提示 |

## 5. 未验证 / 边界

- 真实 Provider Key 非保存前置条件；未发起真实付费推理。
- 真实双击 UAC（同意/拒绝）、干净 Windows 账户、跨管理员 over-the-shoulder 启动、
  真实 Windows 删除权限提示：**未人工验证**。
- 本轮不改变 UAC、ACL、数据目录校验与本地 API 认证；不要求用户删除配置或重装。
- 当前 v0.18.0 发布资产仍包含缺陷；本修复需重新构建并升级才能生效。

## 6. Git

- 代码/测试提交：`a2d06e6`（`fix: make AI provider configuration saves reliable`）。
- 文档/验收记录提交：见最终回复与 `git log -1`。
- **未 Push / Tag / Release**。
