# RC0 GitHub Release 发布准备（2026-11-15）

## 1. 范围

本轮只准备发布材料，不实际发布：

- 不 Push；
- 不创建本地或远程 Tag；
- 不创建 GitHub Release；
- 不上传发布包；
- 不改产品版本、功能或数据库。

## 2. 现有规范检查

- 仓库此前没有任何 tag（`git tag -l` 为空；无远程 tag）。
- `package.json` / `APP_VERSION` 均为 `0.13.2`。
- `docs/RELEASE.md` §1 规定语义化版本 `MAJOR.MINOR.PATCH`；允许在 Release 标识上使用预发布后缀。
- 因此采用用户建议的 `v0.13.2-rc.0`，但**产品版本仍是 0.13.2**，不把 `-rc.0` 写进 `package.json` / `APP_VERSION`。
- 仓库没有既有 Release 命名冲突；`docs/RELEASE.md` 的示例 `vX.Y.Z` 由 §10 的 RC0 预发布命名补充，首次发布不冲突。

## 3. 建议的 Release 信息

| 项目 | 值 |
| --- | --- |
| Tag | `v0.13.2-rc.0` |
| Title | `LiveMemory v0.13.2 RC0` |
| 类型 | Pre-release |
| Target | `cb286241fe5a4b3322455d661218bb0a14044983` |
| 是否 latest | 否（不要勾选 Set as the latest release） |

- `cb28624` 是 EXE 的 `build-info.commit`，也是 828 项全量与 5 个 EXE 矩阵使用的代码提交。
- 其后的 `2120ec7` 与本次发布准备提交都只改文档，不改变源码内容、buildId 或二进制。
- 本轮**没有创建任何 tag**；以上只是建议。

## 4. 发布包

目录：`dist/release-v0.13.2-rc.0/`（`dist/` 已 gitignore，不进入提交）
压缩包：`dist/LiveMemory-v0.13.2-rc.0-windows-x64.zip`

| 文件 | 字节 | SHA-256 |
| --- | --- | --- |
| `LiveMemory.exe` | 96,733,184 | `0cf672438a4723589f4164316e98965a6ff549a132deb30a243638a3f62531c8` |
| `README.md` | 48,321 | `3948d4c96c9eaf10e2d56590f65b527695e27559bd9dd110c69ec4887bcd427a` |
| `LICENSE` | 1,063 | `32f41a237cd7e80b1f83589c058ff8da73903dd25091b4eefb0114487182303b` |
| `RELEASE_NOTES.md` | 10,875 | `0a771d7fcbe25214e05f0c6f9ffeb9b0e2ad7bcc23d1149b827ce4edcfea2d7c` |
| `SHA256SUMS.txt` | 314 | `03eb1a791304251f18ebaa47d0c8120e7abc2bda3da1190a07049ba59da56c9f` |

压缩包：35,724,481 bytes，
SHA-256 `8aa08f0e1e908e80880b578b8cf6d6eb24f560f968d338824ff5684bf5598a2f`。

`SHA256SUMS.txt` 覆盖前四个文件；`SHA256SUMS.txt` 与 ZIP 自身的哈希在 Release 说明/本文档中给出。

## 5. 复核

- 解压 ZIP → 5 个根级文件，无额外的嵌套目录。
- 逐项运行 `Get-FileHash` 对照 `SHA256SUMS.txt`：4/4 通过。
- 解压出的 `LiveMemory.exe` 与 `dist/LiveMemory.exe` 哈希一致。
- 解压出的 EXE Manifest = `requireAdministrator`；buildId `e438e74803cb`。
- 包内无 API Key、Token、Cookie、数据库、真实聊天、`secrets/`、缓存、日志或测试脚本。
- Release Notes 与实际功能一致；明确写了管理员权限、自备 Key、第三方费用、AI 可能不准确、
  DeepSeek 已真实验证而其他 Provider 仅代码/Mock、RC0 预发布性质。
- 全量与 EXE 回归结果沿用上一轮（未改代码）：828 passed / 0 failed；10/10、14/14、12/12、13/13、16/16。

## 6. 未完成 / 待确认

- 真实 Windows 双击与 UAC 点击：自动化无法代替，等待用户人工确认。
- Push、Tag、Release、资产上传：等待用户明确授权；本轮未执行。
- SmartScreen/杀毒软件、第二台电脑、干净 Windows 账户：未验证。

## 7. 文档

- 面向用户：`docs/release-notes/v0.13.2-rc.0.md`
- 发布流程：`docs/RELEASE.md` §10
- 状态：`docs/STATUS.md` §0.32
- 交接：`docs/HANDOFF.md` §0
- 测试复核：`docs/TEST_PLAN.md` §44

## 8. 状态

发布材料已就绪，**未发布**，等待用户确认。
