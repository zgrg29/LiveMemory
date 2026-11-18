# v0.19.1 发布检查单

- 日期：2026-11-19
- 版本：`0.19.1`（Windows Credential Storage Fix，patch）
- 发布性质：正式补丁发布；直播平台状态未变（六个已发布平台；快手仍为预览、采集禁用）
- 数据库 Schema：16（无迁移）

## 1. 发布前

| 检查 | 结果 |
| --- | --- |
| 工作区干净、目标分支、最近提交 | ✅ `main`；包含 `a9c95d7`、`f849ad0`；发布前 HEAD = `f849ad0` |
| 远程 v0.19.1 Tag / Release | ✅ 不存在（发布前经 GitHub API 与 `git ls-remote` 确认） |
| 版本一致性 | ✅ `package.json` = `APP_VERSION` = CHANGELOG = release notes = STATUS = `0.19.1` |
| 全量测试 | ✅ **1,294 passed / 0 failed / 2 skipped**（889 unit + 407 integration；单次全量 354,405 ms；2 skip 为 opt-in CredMan） |
| 真实 CredMan | ✅ **2/2**：保存/读取/更新/大 Key 分块/删除/旧 AES 迁移；随机 target 清理 |
| 十语 i18n | ✅ 10 × 2,379 键；键集/占位符/空值/英文残留 0 |
| 文档检查 | ✅ `scripts/check-docs.mjs` 通过 |
| 凭据检查 | ✅ 仓库与 EXE 无真实 API Key；配置 JSON 不含密钥；Key 只进 Credential Manager |

## 2. 构建与 EXE

| 检查 | 结果 |
| --- | --- |
| `scripts/build-windows.mjs` | 待最终构建填写 |
| EXE 版本 / 启动 | 待最终构建填写（`--version` = `0.19.1`） |
| Manifest | 待最终构建确认 `requireAdministrator` |
| Provider 保存 | `verify-provider-save-exe` 24/24（发布构建） |
| 启动 / 数据目录 | `verify-exe` 11/11（低完整性测试会话使用可写 LOCALAPPDATA/TEMP） |
| 帮助 / AI 恢复 | `verify-help-exe` 14/14；`verify-ai-token-exe` 16/16 |
| 无 Node/Python 依赖 | 单 EXE（Node SEA），用户无需安装运行时 |
| 无开发密钥/数据 | 只打包 `src/`、字典、提示词/Schema；不含 tests、数据库、`secrets/` |
| SHA-256 | 待最终构建填写 |

## 3. 发布

| 检查 | 结果 |
| --- | --- |
| Push `main` / Tag `v0.19.1` | 待发布填写 |
| GitHub Release | 待发布填写 |
| 资产上传与下载复核 | 待发布填写 |
| 旧 Release 未覆盖 | `v0.19.0` 及更早不得修改 |
| Release body 与文件一致 | 待发布填写 |

## 4. 未验证 / 已知限制

- **真实双击 UAC、干净 Windows 账户、第二个 Windows 用户、整机重启、企业组策略环境**
  未人工验证；EXE 未签名。
- 部分企业环境可能禁用 PowerShell/Credential Manager；保存会明确失败，不写明文、不伪造成功。
- 真实 OpenCode / OpenAI / Anthropic / MiniMax / 百炼 / OpenRouter / 自定义端点付费验收未逐个完成。
- 快手仍为预览、采集禁用；Twitch Bits/赠订、抖音礼物、TikTok 礼物与部分 Kick 事件仍
  `NOT-OBSERVED`。
