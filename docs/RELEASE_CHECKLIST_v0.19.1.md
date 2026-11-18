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
| `scripts/build-windows.mjs` | ✅ Build `b66818d032b5` / commit `04b30b7`；257 files / 71 required modules |
| EXE 版本 / 启动 | ✅ `--version` = `0.19.1`；Build `0.19.1 (commit 04b30b7, assets b66818d032b5782b3da0)` |
| Manifest | ✅ `requireAdministrator`（构建断言 + 复读） |
| Provider 保存 | `verify-provider-save-exe` 24/24（发布构建） |
| 启动 / 数据目录 | `verify-exe` 11/11（低完整性测试会话使用可写 LOCALAPPDATA/TEMP） |
| 帮助 / AI 恢复 | `verify-help-exe` 14/14；`verify-ai-token-exe` 16/16 |
| 无 Node/Python 依赖 | 单 EXE（Node SEA），用户无需安装运行时 |
| 无开发密钥/数据 | 只打包 `src/`、字典、提示词/Schema；不含 tests、数据库、`secrets/` |
| SHA-256 | ✅ 99,609,088 B / `4d230f5f1f66302a68f3403e38bde5427827e6d7371b31f1e3121655cd369542`；`SHA256SUMS.txt` 81 B |

## 3. 发布

| 检查 | 结果 |
| --- | --- |
| Push `main` / Tag `v0.19.1` | ✅ `main` `fea8cbe..04b30b7`；annotated Tag object `3344363` → commit `04b30b7` |
| GitHub Release | ✅ ID `450272261` · https://github.com/zgrg29/LiveMemory/releases/tag/v0.19.1 · Published `2026-11-18T16:43:01Z` |
| 资产上传与下载复核 | ✅ EXE 99,609,088 B / SHA-256 `4d230f5f…369542`；`SHA256SUMS.txt` 81 B / SHA-256 `7ca49114…092284`；下载后均一致 |
| 旧 Release 未覆盖 | ✅ `v0.19.0`（Release `450031601`）及更早页面未修改 |
| Release body 与文件一致 | ✅ SHA-256 `9598aa50962dbb6997ed63d76d1dc791904f632a7cd4622269826e001308b391` |

## 4. 未验证 / 已知限制

- **真实双击 UAC、干净 Windows 账户、第二个 Windows 用户、整机重启、企业组策略环境**
  未人工验证；EXE 未签名。
- 部分企业环境可能禁用 PowerShell/Credential Manager；保存会明确失败，不写明文、不伪造成功。
- 真实 OpenCode / OpenAI / Anthropic / MiniMax / 百炼 / OpenRouter / 自定义端点付费验收未逐个完成。
- 快手仍为预览、采集禁用；Twitch Bits/赠订、抖音礼物、TikTok 礼物与部分 Kick 事件仍
  `NOT-OBSERVED`。
