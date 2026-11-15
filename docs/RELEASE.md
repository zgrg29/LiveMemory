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
