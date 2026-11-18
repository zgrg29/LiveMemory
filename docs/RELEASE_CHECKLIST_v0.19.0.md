# v0.19.0 发布检查单

- 日期：2026-11-18
- 版本：`0.19.0`（`0.18.0` + AI Provider Reliability Update，minor）
- 发布性质：正式发布；直播平台状态未变（六个已发布平台；快手仍为预览、采集禁用）
- 数据库 Schema：16（无迁移）

## 1. 发布前

| 检查 | 结果 |
| --- | --- |
| 工作区干净、目标分支、最近提交 | ✅ `main`；包含 `a2d06e6`、`5fbda2b`；发布前 `origin/main` = `142ec4a`，本地领先 2 个提交 |
| 最新 Tag / Release | `v0.18.0`；`v0.19.0` 不存在 |
| 版本一致性 | ✅ `package.json` = `APP_VERSION` = CHANGELOG = release notes = STATUS = `0.19.0` |
| 全量测试 | ✅ **1,269 passed / 0 failed / 0 skipped**（871 unit + 398 integration；365,726 ms） |
| Provider 保存专项 | ✅ 14 unit + 13 integration；真实 EXE `verify-provider-save-exe` 14/14 |
| 其他 Provider 回归 | ✅ 全量通过；OpenAI / Anthropic / DeepSeek / 百炼 / MiniMax / OpenRouter / 自定义未改协议 |
| 十语 i18n | ✅ 10 × 2,373 键；键集/占位符一致；新增 20 个错误 + 2 个 UI 键 |
| 凭据检查 | ✅ 仓库与 EXE 无真实 API Key；配置 JSON 不含密钥；密钥只进加密凭据库 |
| 用户反馈复现 | ✅ 尾斜杠误判、Key 尾换行、错误统一、凭据非事务、自定义 OpenCode 会话头 |

## 2. 构建与 EXE

| 检查 | 结果 |
| --- | --- |
| `scripts/build-windows.mjs` | ✅ 成功；Build `252939f4d41b` / commit `50920d1`；256 files / 70 required modules |
| EXE 版本 / 启动 | ✅ `--version` = `0.19.0`；`verify-exe` 11/11 |
| Manifest | ✅ `requireAdministrator`（构建断言 + 复读） |
| 数据目录 / 加密凭据 / 启动流程 | `verify-exe` fresh data、restart、crash recovery、denied folder、another folder |
| 打包后的 Provider 设置 | 打包资源含 Provider 保存、凭据与错误提示模块；`verify-provider-save-exe` 14/14 |
| 无 Node/Python 依赖 | 单 EXE（Node SEA），用户无需安装运行时 |
| 无开发密钥/数据 | 只打包 `src/`、字典、提示词/Schema；不含 tests、数据库、`secrets/` |
| 帮助与 AI 恢复 | `verify-help-exe` 14/14；`verify-ai-token-exe` 16/16 |
| SHA-256 | ✅ 99,551,744 B / `901f92fd35274833456d9755fc77a7beabe7d33e3fb0c165fd6fd5a82bb64fc9`；`SHA256SUMS.txt` 82 B |

## 3. 发布

| 检查 | 结果 |
| --- | --- |
| Push `main` / Tag `v0.19.0` | ✅ `main` `142ec4a..50920d1`；annotated Tag object `5e366a2` → commit `50920d1` |
| GitHub Release | ✅ ID `450031601` · https://github.com/zgrg29/LiveMemory/releases/tag/v0.19.0 · Published `2026-11-18T13:32:13Z` |
| 资产上传与下载复核 | ✅ EXE 99,551,744 B / SHA-256 `901f92fd…64fc9`；`SHA256SUMS.txt` 82 B / SHA-256 `9ee83678…ece952`；下载后均一致 |
| 旧 Release 未覆盖 | ✅ `v0.18.0`（Release `449956670`）及更早资产未修改 |
| Release body 与文件一致 | ✅ SHA-256 `de9fe7ba9c4f18f4e725b0030802f44507641d3c6e3c5f8041e5123ece56d30f` |

## 4. 未验证 / 已知限制

- **真实双击 UAC、干净 Windows 账户、原生文件对话框、Ctrl+C** 未人工验证；EXE 未签名。
- **真实 OpenCode 付费推理未执行（无 Key）**；真实 429/5xx、账单与 `usage.cost` 仍待验收。
- 其他 Provider 的真实付费验收仍未逐个完成。
- 快手仍为预览、采集禁用；Twitch Bits/赠订、抖音礼物、TikTok 礼物与部分 Kick 事件仍
  `NOT-OBSERVED`。
