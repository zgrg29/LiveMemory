# v0.18.0 发布检查单

- 日期：2026-11-18
- 版本：`0.18.0`（`0.17.0` + OpenCode AI Provider，minor）
- 发布性质：正式发布；直播平台状态未变（快手仍为预览、采集禁用）
- 数据库 Schema：16（无迁移）

## 1. 发布前

| 检查 | 结果 |
| --- | --- |
| 工作区干净、目标分支、最近提交 | ✅ `main`；`origin/main` = 开发提交 `6dffc61`；工作区干净 |
| 最新 Tag / Release | `v0.17.0`；`v0.18.0` 不存在 |
| 版本一致性 | ✅ `package.json` = `APP_VERSION` = CHANGELOG = release notes = STATUS = `0.18.0` |
| 全量测试 | ✅ 1,241 passed / 0 failed / 0 skipped（856 unit + 385 integration） |
| OpenCode 专项 | ✅ 12 unit + 3 integration；模型列表真实读取；Go 缺头 400 真实核实 |
| 其他 Provider 回归 | ✅ 全量通过；OpenAI / Anthropic / DeepSeek / 百炼 / MiniMax / OpenRouter / 自定义未改 |
| 十语 i18n | ✅ 10 × 2,351 键；键集/占位符一致；仅 Provider 文案改值 |
| 凭据检查 | ✅ 仓库与 EXE 无真实 API Key；配置 JSON 不含密钥；密钥只进加密凭据库 |
| 用户反馈复现 | 自定义 OpenCode 缺会话头（改用内置 Provider）；切换 Provider 需重输 Key（既有设计）；AppData 手动删除权限（未复现为阻断） |

## 2. 构建与 EXE

| 检查 | 结果 |
| --- | --- |
| `scripts/build-windows.mjs` | ✅ 成功；`RT_MANIFEST = requireAdministrator`（构建断言 + 复读） |
| EXE 版本 / 启动 | ✅ `--version` 为 `0.18.0`；`verify-exe` 11/11 |
| 数据目录 / 加密凭据 / 启动流程 | ✅ `verify-exe` fresh data、restart、crash recovery、denied folder、another folder |
| 打包后的 OpenCode 设置 | ✅ 打包资源含 provider catalogue/session 模块；`verify-exe` 十语/资源检查通过 |
| 无 Node/Python 依赖 | ✅ 单 EXE（Node SEA），用户无需安装运行时 |
| 无开发密钥/数据 | ✅ 只打包 `src/`、字典、提示词/Schema；不含 tests、数据库、`secrets/` |
| 帮助与 AI 恢复 | ✅ `verify-help-exe` 14/14；`verify-ai-token-exe` 16/16 |
| SHA-256 | 见 `docs/RELEASE_HISTORY.md`（发布后记录） |

**构建路径说明**：`dist/LiveMemory.exe` 被其它进程独占（`EBUSY`），本轮在隔离副本中用同一
源码/构建脚本构建并验收，正式资产以实际构建产物为准；详见 STATUS §0.61.5。

## 3. 发布

| 检查 | 结果 |
| --- | --- |
| Push `main` / Tag `v0.18.0` | ✅ `main` `6dffc61..adef993`；annotated Tag object `79a76e9` → commit `3149ffc` |
| GitHub Release | ✅ ID `449956670` · https://github.com/zgrg29/LiveMemory/releases/tag/v0.18.0 · Published `2026-11-18T12:30:18Z` |
| 资产上传与下载复核 | ✅ `LiveMemory.exe` 99,503,104 B / SHA-256 `285cfd82…2957f`；`SHA256SUMS.txt` 82 B / SHA-256 `0400aa9b…626a`；下载后哈希一致 |
| 旧 Release 未覆盖 | ✅ `v0.17.0`（Release `448828056`）及更早资产未修改 |
| Release body 与文件一致 | ✅ SHA-256 `50040e27dc64ae450d3fb31644d216e8e746bc7763160b1fe77212ea84fe6e96` |

## 4. 未验证 / 已知限制

- **无真实 OpenCode Key**：真实推理、429/5xx、模型输出、账单/`usage.cost` 未验收；Go 未真实验收。
- 免费层模型对第三方客户端 403；`json_schema` 未声明；部分模型 `temperature` 兼容性未验证。
- 真实双击 UAC、干净 Windows 账户、原生文件对话框、Ctrl+C 未人工验证；EXE 未签名。
- 快手仍为预览、采集禁用。
