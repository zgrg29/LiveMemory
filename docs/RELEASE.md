# 发布流程（RELEASE）

> 本文件描述正式发布（M8）应执行的步骤。当前阶段**尚未发布**，也未 Push。
> 未经用户明确授权，不得创建 tag / Release / 公开仓库。

## 1. 版本规则

- 语义化版本：`MAJOR.MINOR.PATCH`。
- 版本号必须同时更新并保持一致：
  - `package.json` → `version`
  - `src/shared/app-info.mjs` → `APP_VERSION`
  - `docs/CHANGELOG.md`
  - `docs/STATUS.md`
- 文档修正不自动升版本；行为变化才升版本。

## 2. 发布前检查清单

### 代码与测试
- [ ] `node --test tests/unit tests/integration` 全通过
- [ ] 新增行为有测试，未删除/弱化断言
- [ ] 无 `TODO` 冒充完成项（对照 STATUS）

### 三语与 UI
- [ ] zh-CN / ja / en 全页面无缺失键（`i18n.test.mjs`）
- [ ] 命令行三语输出无乱码（真实控制台）
- [ ] 明亮 / 黑暗 / 跟随系统
- [ ] 1440px、1024px、390px 截图检查
- [ ] 主题切换无布局跳动、刷新后保持

### Windows
- [ ] 干净 Windows 10/11 虚拟机（非管理员账户）安装/运行
- [ ] 安装目录只读（模拟 `Program Files`）
- [ ] 数据目录不可写时的错误提示与替代方案
- [ ] 端口冲突、重复启动、浏览器无法自动打开
- [ ] Ctrl+C 优雅退出并生成一致的数据库
- [ ] Windows 关机 / 强制结束后的下次启动恢复
- [ ] 杀毒软件与 SmartScreen 表现（未签名时的提示说明）

### 数据
- [ ] 金额不重复累计（重复事件、重连、重新导入）
- [ ] 完整备份 → 全新数据目录恢复 → 重启 → 再次备份（`node scripts/verify-p0-2-exe.mjs`）
- [ ] 备份/恢复失败回滚、强制结束后的 journal 恢复
- [ ] 凭据不进入日志、备份、分析包（恢复后 `secrets/` 为空）

## 3. 构建

```bat
node scripts/build-windows.mjs
```

产物：

```text
dist/
├── LiveMemory.exe
├── README.md
├── LICENSE
└── SHA256SUMS.txt   (发布时需要补充生成)
```

当前脚本会打印 EXE 的大小与 SHA-256；正式发布时应写入 `SHA256SUMS.txt`，并在发布说明中给出。

## 4. 检查产物

1. 在干净环境运行 `LiveMemory.exe --version`。
2. 双击运行，确认出现命令行窗口并自动打开浏览器。
3. 检查数据目录创建在 `%LOCALAPPDATA%\LiveMemory`。
4. 打开控制台，切换三语与三主题，刷新，重启，确认持久化。
5. 记录一次模拟直播，导出分析包，解压核对。
6. 设置 → 备份与恢复：创建备份、验证、用全新 `--data-dir` 恢复、重启、核对数据、再次备份并验证。
7. 第二次双击，确认单实例提示。
8. Ctrl+C，确认“已安全退出”，数据库无残留 WAL 异常。

## 5. 发布资产命名

```text
LiveMemory-v0.1.0-windows-x64.zip
  ├── LiveMemory.exe
  ├── README.md
  ├── LICENSE
  ├── RELEASE_NOTES.md
  └── SHA256SUMS.txt
```

## 6. 升级

- 替换 EXE 即可；数据目录保持不变。
- 首次启动自动执行数据库迁移（只追加）。
- 新版本会解压到新的 `app\<hash>` 目录；旧目录可在退出后清理（M8 实现自动清理）。
- 升级前建议用户执行一次完整备份（设置 → 备份与恢复 → 创建完整备份）。

## 7. 回滚

- 保留上一版 EXE 与升级前数据库备份。
- 若 schema 迁移导致问题：
  1. 停止程序；
  2. 用 `backups/pre-restore-*.db` 覆盖数据库；
  3. 换回旧 EXE；
  4. 在 STATUS/DECISIONS 记录原因与修复计划。
- 不提供自动降级迁移；数据格式变化必须向前兼容或明确阻止旧版本启动。

## 8. GitHub 发布（需用户授权）

1. 确认工作区干净、测试通过。
2. 更新 CHANGELOG / STATUS / 发布说明。
3. 本地提交并（经授权）Push。
4. 创建 tag `vX.Y.Z`。
5. 上传 ZIP 与 SHA256SUMS。
6. Release Notes 使用三语摘要（或链接到 README 对应语言）。
7. 不做强制推送；不覆盖历史发布资产。

## 9. 已知发布限制（v0.1.0）

- 未签名；SmartScreen 可能提示未知发布者。
- 未在第二台机器验收。
- 真实平台未接入，README/RELEASE_NOTES 必须明确写“当前为 M1/M2 阶段”。

## 10. RC0 预发布准备（v0.13.2-rc.0，2026-11-15，未发布）

本轮只准备材料，**未在本地创建 tag，未 Push，未创建远程 Tag，未发布 Release，未上传资产**。

### 10.1 命名

- 产品版本保持不变：`0.13.2`（`package.json` / `APP_VERSION` 不改）。
- Release Tag：`v0.13.2-rc.0`。
- Release Title：`LiveMemory v0.13.2 RC0`。
- 类型：**Pre-release**。
- Target：`cb286241fe5a4b3322455d661218bb0a14044983`（EXE 的 `build-info.commit`，也是全量与 EXE 回归使用的代码提交）。其后的 `2120ec7` 与本次发布准备提交都只改文档，不改变代码与 buildId。
- 命名依据：仓库此前没有任何 tag，也没有冲突的预发布命名；`docs/RELEASE.md` §1 的语义化版本允许预发布后缀，因此使用 `v0.13.2-rc.0` 表示 RC0 预发布，而不是把产品版本改成 `0.13.2-rc.0`。

### 10.2 发布资产

目录：`dist/release-v0.13.2-rc.0/`；压缩包：`dist/LiveMemory-v0.13.2-rc.0-windows-x64.zip`。

| 文件 | 大小 | SHA-256 |
| --- | --- | --- |
| `LiveMemory.exe` | 96,733,184 | `0cf672438a4723589f4164316e98965a6ff549a132deb30a243638a3f62531c8` |
| `README.md` | 48,321 | `3948d4c96c9eaf10e2d56590f65b527695e27559bd9dd110c69ec4887bcd427a` |
| `LICENSE` | 1,063 | `32f41a237cd7e80b1f83589c058ff8da73903dd25091b4eefb0114487182303b` |
| `RELEASE_NOTES.md` | 10,875 | `0a771d7fcbe25214e05f0c6f9ffeb9b0e2ad7bcc23d1149b827ce4edcfea2d7c` |
| `SHA256SUMS.txt` | 314 | `03eb1a791304251f18ebaa47d0c8120e7abc2bda3da1190a07049ba59da56c9f` |
| `LiveMemory-v0.13.2-rc.0-windows-x64.zip` | 35,724,481 | `8aa08f0e1e908e80880b578b8cf6d6eb24f560f968d338824ff5684bf5598a2f` |

- `SHA256SUMS.txt` 覆盖前四个文件；压缩包与校验文件本身的哈希在 Release 说明中另行给出。
- 发布包只包含上述 5 个文件，不包含 API Key、Token、Cookie、数据库、聊天记录、`secrets/`、缓存或日志。
- 压缩包解压后 `LiveMemory.exe` 的 SHA-256 与 `dist/LiveMemory.exe` 一致，Manifest 为 `requireAdministrator`。

### 10.3 发布前检查

- [x] 正式 EXE Manifest = `requireAdministrator`（构建断言 + 独立读取）
- [x] 全量自动化：828 passed / 0 failed / 0 skipped（212,358 ms）
- [x] EXE 回归：`verify-exe` 10/10、`verify-help-exe` 14/14、`verify-p0-5-exe` 12/12、`verify-p0-2-exe` 13/13、`verify-ai-token-exe` 16/16
- [x] buildId `e438e74803cb`、SHA-256、大小、Manifest 与实际 EXE 一致
- [x] 压缩包内 `SHA256SUMS.txt` 逐项复核通过
- [x] 工作区在提交发布准备文档后保持干净
- [x] Release Notes 与 README/STATUS/CHANGELOG 的功能描述一致，未宣称所有 Provider 已验证
- [ ] 真实 Windows 双击与 UAC 点击：**待用户人工确认**，自动化不能代替
- [ ] 实际 Push / 创建远程 Tag / 创建 Release / 上传资产：**等待用户明确授权**

### 10.4 GitHub Release 选项建议

- Tag：`v0.13.2-rc.0`，Target：`cb286241fe5a4b3322455d661218bb0a14044983`
- Title：`LiveMemory v0.13.2 RC0`
- 勾选 **Set as a pre-release**
- 不勾选 “Set as the latest release”
- 资产：优先上传 `LiveMemory-v0.13.2-rc.0-windows-x64.zip`；也可同时附加裸 `LiveMemory.exe`、`SHA256SUMS.txt` 与 `RELEASE_NOTES.md`
- Release body：使用 `docs/release-notes/v0.13.2-rc.0.md`（含中文正文与英文摘要）

---

## 11. 正式发布 v0.14.0（2026-11-16，用户明确授权）

按用户指令执行**阶段性正式 Release**（五平台版本封版）。与 §10 的 RC0 预发布不同，
本次为**正式稳定版**，并已完成 Push、Tag 与 GitHub Release。

### 11.1 命名与依据

| 项目 | 值 | 依据 |
| --- | --- | --- |
| 产品版本 | `0.14.0`（`package.json` 与 `APP_VERSION` 同步） | 相对上一个正式发布 `v0.13.2-rc.0` 新增 **三个直播平台**（Twitch / 抖音 / TikTok）与多房间并发等能力，属 SemVer 的 minor 级变化；`0.13.3` 已被用作开发期版本，故以 `0.14.0` 封版 |
| Release Tag | `v0.14.0` | 仓库已有 `v0.13.2-rc.0`，无重复 Tag，符合 `vX.Y.Z` 惯例 |
| Release Title | `LiveMemory v0.14.0 — Multi-Platform Release` | 与本轮功能范围一致 |
| 类型 | 正式稳定版（Pre-release 不勾选） | 五平台已验证，无 RC 后缀 |
| Tag Target | `d268cf9b5c64d467872c55425bf6446bf614880c`（`chore: bump version to 0.14.0`） | 该提交的 `src/` 内容即 EXE 的 `build-info.commit` 与 `sourceHash` 来源；其后仅文档提交，不改变 buildId |

### 11.2 发布资产

目录 `dist/release-v0.14.0/`；压缩包 `dist/LiveMemory-v0.14.0-windows-x64.zip`。

| 文件 | 大小 | SHA-256 |
| --- | --- | --- |
| `LiveMemory.exe` | 97,769,984 | `6862079a025fa08d5b7fcf82c16cc3152fedbb7852866022dad4c96977bbe0d9` |
| `README.md` | 54,502 | `de40a0b4b7ff74788fa78f359cc193e8329020b12663857b34c37ac54b1a4cc5` |
| `LICENSE` | 1,063 | `32f41a237cd7e80b1f83589c058ff8da73903dd25091b4eefb0114487182303b` |
| `RELEASE_NOTES.md` | 15,911 | `0fc30e7012a3c179750ab20b5c51b26123a2617067ccccd4179022fa5992a4c7` |
| `SHA256SUMS.txt` | 314 | 见 Release 说明 |
| `LiveMemory-v0.14.0-windows-x64.zip` | 35,977,845 | `5d7b7e65eb3cea72156c5ecd97496c277427e1a33782d5b75b7a16dc09091188` |

- `SHA256SUMS.txt` 覆盖前四个文件；压缩包与校验文件自身的哈希在 Release 说明中给出。
- 包内只含上述 5 个文件；不含 API Key、Token、Cookie、数据库、聊天记录、`secrets/`、缓存或日志。
- 解压后 `LiveMemory.exe` 的 SHA-256 与 `dist/LiveMemory.exe` 一致；Manifest 为 `requireAdministrator`。

### 11.3 发布前检查（本轮真实结果）

- [x] 工作区在封版前干净（`main` 起始 HEAD `25e6fbe`，仅领先远程 2 个文档提交）
- [x] 版本一致：`package.json` = `APP_VERSION` = `0.14.0`
- [x] 全量自动化：**687 unit + 347 integration = 1034 passed / 0 failed / 0 skipped**
- [x] `verify-exe` **10/10**（含全新目录、重启、硬杀恢复、端口顺延、单实例、不可写目录、异目录、解压复用、CLI 三语与 `--version`）
- [x] `verify-p0-2-exe` **13/13**（备份 → 恢复 → 再次备份闭环）
- [x] `verify-ai-token-exe` **16/16**（AI 入口、批次保存、Resume）
- [x] EXE Manifest `requireAdministrator`（构建断言 + 注入后复读）
- [x] 压缩包内 5 个文件与 `SHA256SUMS.txt` 逐项复核通过
- [x] 发布包内无密钥、Token、用户数据或测试数据
- [ ] 真实 Windows 双击与 UAC 点击：**仍需人工确认**，自动化不能代替
- [ ] 干净 Windows 环境、真实手机扫码、真实礼物事件：**未执行 / NOT-OBSERVED**

### 11.4 已知的环境限制（不影响发布产物）

本轮执行环境的文件沙箱禁止写入 `%LOCALAPPDATA%\LiveMemory`，因此 `verify-exe` 首次运行在
Bootstrap 解压阶段以 `EPERM` 中止（`no writable application folder`）。该失败是环境限制，
不是产品缺陷：把 EXE 的解压根目录与临时目录重定向到仓库内可写目录后，同一二进制
**10/10 全部通过**（`app-root` 使用 `17f84b1956e1d197afef`，即本版本资产哈希）。
真实用户环境使用 `%LOCALAPPDATA%\LiveMemory`，与此无关。

### 11.5 发布结果（已完成）

| 项目 | 值 |
| --- | --- |
| GitHub Release | `LiveMemory v0.14.0 — Multi-Platform Release`（id `446701465`） |
| URL | https://github.com/zgrg29/LiveMemory/releases/tag/v0.14.0 |
| 类型 | `draft=false`、`prerelease=false`（正式稳定版） |
| published_at | `2026-11-16T07:01:11Z` |
| Tag | `v0.14.0`（annotated tag object `ffc4a22`）→ commit `d268cf9b5c64d467872c55425bf6446bf614880c` |
| Push | `main`：`25e6fbe..aeadf56`；`v0.14.0` 为新 Tag |
| 资产 1 | `LiveMemory-v0.14.0-windows-x64.zip`，35,977,845 bytes，`sha256:5d7b7e65eb3cea72156c5ecd97496c277427e1a33782d5b75b7a16dc09091188` |
| 资产 2 | `SHA256SUMS.txt`，314 bytes，`sha256:11f89649fa77884725492bb75f366c651cfdd701b9a2600e9282d4388b8e8f07` |
| Release body | 与 `docs/release-notes/v0.14.0.md` 字节一致（SHA-256 `0fc30e70…`，15,911 bytes） |
| 下载验证 | zip Range 请求 `206`、总长 35,977,845；`SHA256SUMS.txt` 返回 `200` 且内容正确 |
| 页面可访问 | 是（`HTTP 200`，标题为 `LiveMemory v0.14.0 — Multi-Platform Release`） |
| 重复检查 | 发布前断言该 Tag 无既有 Release；未创建重复 Tag/Release |
