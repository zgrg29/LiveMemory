# 2026-11-16 TIKTOK-M6 人工验收通过并合并 main

## 1. 授权与范围

开发者已在普通 Windows 桌面亲自完成 TikTok 多直播间人工验收：

- 可以同时创建多个不同的 TikTok LIVE 记录。
- 多场 TikTok 直播可以同时采集。
- 不再出现之前只能记录一场 TikTok 的问题。
- 当前使用体验符合预期。

据此授权：将 `feature/tiktok` 合并到**本地** `main`，完成回归测试与 EXE 构建。
**未 Push、未创建 Tag、未发布 Release、未删除功能分支、未修改许可证。**

## 2. 合并前检查

| 项目 | 结果 |
| --- | --- |
| 当前分支 | `feature/tiktok` |
| 工作区 | clean |
| merge-base | `410bfc3ffacc712b6fd56a9e63f4d5afcca4bcb7`（当时 main HEAD） |
| `main...feature/tiktok` | `0 / 20`，main 无独立新提交 |
| 功能提交 | `54934f6` `feat: allow concurrent TikTok rooms and remove the simulator UI` |
| UI 修复 | `4224f7c` `fix: refresh the TikTok room list in place` |
| 文档提交 | `e992534` `docs: record TikTok multi-room acceptance and simulator removal` |
| 验收 EXE | Build ID `e48016f19362` / commit `4224f7c` |

特性分支只新增 TikTok 功能、测试、脚本与相关文档；不会覆盖已合并的 Bilibili / YouTube /
Twitch / 抖音。

## 3. 合并

```text
git switch main
git merge --no-ff feature/tiktok
```

| 项目 | 值 |
| --- | --- |
| 合并提交 | `980de0f97a4b700c6c29aa569ca87cc734748021` |
| 父 1 | `410bfc3ffacc712b6fd56a9e63f4d5afcca4bcb7`（原 main） |
| 父 2 | `e9925348a514fb93877889e672bfec4c3a383299`（feature/tiktok） |
| 冲突 | 无 |
| 变更 | 67 files，+11,758 / −130 |
| 合并后树 | 与 `feature/tiktok` 完全一致（`git diff --stat feature/tiktok main` 为空） |

合并前 `git switch main` 遇到索引 stat 缓存异常（`git status`/`git diff` 均为空，文件哈希一致）。
先执行 `git update-index --refresh`，随后用 `git switch --discard-changes main` 完成切换；
切换前已核对每个文件 hash 与 index 一致，未丢失任何内容。

## 4. 合并后回归

| 运行 | 结果 |
| --- | --- |
| 全量单元 `tests/unit/*.test.mjs` | **687 passed / 0 failed / 0 skipped（17,701.12 ms）** |
| 全量集成 `tests/integration/*.test.mjs` | **347 passed / 0 failed / 0 skipped（270,438.05 ms）** |
| 合计 | **1034 passed / 0 failed / 0 skipped** |
| `git diff --check` | 通过 |
| SQLite schema | 16，未变 |
| `src/storage` / `src/analytics` / `src/ai` diff | 相对合并前 main 为空 |
| 五平台路由 | `/api/{bilibili,youtube,twitch,douyin,tiktok}/connect` 均存在 |
| 五平台打包 | `build/manifest.json`：Bilibili 9 / YouTube 7 / Twitch 7 / 抖音 14 / TikTok 10 个模块 |
| 模拟直播 | 正式 UI 无标签/按钮/面板/API 调用；历史 mock 数据仍可读 |
| 三语 i18n | 键集与占位符一致 |

## 5. main 上的 Windows EXE

| 项目 | 值 |
| --- | --- |
| 文件 | `D:\LiveMemory\dist\LiveMemory.exe` |
| Build ID | `e48016f19362`（`src/` 未变，故与验收 EXE 相同） |
| 构建 commit | `980de0f97a4b700c6c29aa569ca87cc734748021`（合并提交） |
| source hash | `e48016f193625e919be6dd2e744eac093aefb889144a5a8825edd2faba51dbdb` |
| 大小 | `96,730,112` bytes |
| SHA-256 | `1b8cbe63181f97b74bf871ce9c3e2658bb715227a72d05f54691ca6aaca5909c` |
| builtAt | `2026-11-16T05:05:58.502Z` |
| 资源 / 模块 | 226 files / 51 required modules |
| RT_MANIFEST | `requireAdministrator` |

验证：

- `verify-exe.mjs`：**10/10**（启动、重启、硬杀恢复、端口顺延、单实例、不可写目录、异目录、解包复用、CLI 三语/诊断）。
- `verify-tiktok-exe.mjs @aljazeeraenglish`：**22/22 + 2 NOT-OBSERVED，0 failed**。
- `verify-tiktok-multi-exe.mjs`：**17/17 passed，0 NOT-OBSERVED，0 failed**。

真实双房间（2026-11-16 13:08–13:11 Asia/Shanghai）：

| 项目 | 结果 |
| --- | --- |
| 房间 A | `@aljazeeraenglish` / `7706695538414062349` |
| 房间 B | `@aljazeera` / `7706505863599508276` |
| Session | A `ses_01M7HC2VBSFYPV4JBW1P` / B `ses_01M7HC33MSXWTZVR5JN6` |
| 真实 chat | A 1 条 / B 2 条 |
| 停止 A | B 仍 connected；B 2→3 |
| AI report | A/B 均 200 |
| SQLite | 两场 ended、room/session 不同、UID/msgId 完整 |
| 产物 | `tests/.tmp/verify-tiktok-multi-2026-11-16T05-08-00-619Z`（不提交） |

## 6. 仍未完成 / NOT-OBSERVED

- TikTok 真实礼物：**NOT-OBSERVED**。
- TikTok 真实连送：**NOT-OBSERVED**。
- TikTok 真实订阅：**NOT-OBSERVED**。
- 长期多房间压力测试：**未执行**。
- 真实网卡断线与真实下播长跑：**未执行**。
- 干净 Windows 账户、真实双击 UAC：仍需人工确认。

不得把上述项目改成 PASS；真实双房间样本仅 A 1 条 / B 2 条。

## 7. Git

| 项目 | 值 |
| --- | --- |
| 分支 | `main` |
| 合并提交 | `980de0f` |
| 最终 HEAD | 本轮文档提交（见 `git log -1`） |
| 工作区 | clean |
| 远程 | 未 Push |
| Tag / Release | 未创建 |
| 功能分支 | `feature/tiktok` 保留 |
