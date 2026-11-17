# 发布流程（RELEASE）

本文件是**可重复执行的发布流程**，不是版本历史。已经发生的 Tag、Release ID、资产哈希和
验收证据归档在 [`docs/RELEASE_HISTORY.md`](RELEASE_HISTORY.md)；逐版本功能变化见
[`docs/CHANGELOG.md`](CHANGELOG.md)。

> **授权边界**：Push、创建 Tag、创建或修改 GitHub Release、上传资产都必须得到用户明确授权。
> 本文只描述获得授权后应当执行的步骤，不构成任何一次发布的授权。

---

## 1. 角色与唯一信息源

| 信息 | 唯一权威来源 | 发布时如何使用 |
| --- | --- | --- |
| 产品版本 | `package.json` 的 `version` 与 `src/shared/app-info.mjs` 的 `APP_VERSION` | 两处必须相同；不一致时禁止发布 |
| 当前工程状态、平台支持状态、未完成项 | [`docs/STATUS.md`](STATUS.md) | 发布说明与 README 只能写这里确认的状态 |
| 逐版本变化 | [`docs/CHANGELOG.md`](CHANGELOG.md) | 新增一个版本小节 |
| 历史发布证据 | [`docs/RELEASE_HISTORY.md`](RELEASE_HISTORY.md) | 发布成功后追加本次记录 |
| 发布说明正文 | `docs/release-notes/vX.Y.Z.md` | Release body 与该文件保持一致 |
| 发布检查单 | 本次发布专用的 `docs/RELEASE_CHECKLIST_vX.Y.Z.md`（可选） | 只记录本次检查，不复制通用流程 |
| 界面语言 / AI 输出语言 | [`docs/I18N.md`](I18N.md) 与 `src/shared/locales.mjs` | 逐语言门禁按注册表实际语言数量执行 |
| 平台支持状态 | [`docs/PLATFORM_INTEGRATIONS.md`](PLATFORM_INTEGRATIONS.md)、`/api/bootstrap` capabilities | 不以 README 或旧发布说明为准 |

不要在本文中维护当前版本号、平台数量、测试数量或里程碑；这些值会变化，必须在发布时从上述
权威来源读取。

## 2. 版本规则

- 使用语义化版本 `MAJOR.MINOR.PATCH`。
- 行为变化才升版本；纯文档修正不自动升版本。
- 版本号必须同时出现在：
  - `package.json` → `version`
  - `src/shared/app-info.mjs` → `APP_VERSION`
  - `docs/CHANGELOG.md` 的版本小节
  - `docs/release-notes/vX.Y.Z.md`（文件名与正文）
  - `docs/STATUS.md` 的当前状态快照
- 构建产物的 `build-info.json`、`--version`、启动器横幅、设置页「关于」、`/api/health` 与
  `/api/bootstrap` 必须与上述版本一致。
- 预发布使用 `vX.Y.Z-rc.N`，默认标记为 Pre-release；是否标记、是否作为 latest release 由用户决定。
- 不为历史版本改写已有 Tag 或 Release 资产。

## 3. 发布前检查

### 3.1 代码、测试与构建

- [ ] 工作区干净；`git status` 与目标分支一致。
- [ ] 目标提交的全部改动已经审查；没有未提交的用户数据、日志、凭据、`tests/.tmp/`、`dist/`、
      `build/`。
- [ ] `node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`
      全通过；记录真实的 unit / integration 数量与耗时。
- [ ] 本次改动的专项测试通过；未删除或弱化断言。
- [ ] `node scripts/build-windows.mjs` 成功，构建脚本断言最终 EXE
      `RT_MANIFEST = requireAdministrator`。
- [ ] 构建元数据 `build/build-info.json` 与 `build/manifest.json` 的 `version`、`commit`、
      `buildId`、`assetHash` 与目标提交一致。

### 3.2 平台与数据

- [ ] 六个已发布平台（Bilibili / YouTube / Twitch / 抖音 / TikTok / Kick）的回归通过；
      未改动的平台不应出现回归。
- [ ] 快手仍按 STATUS 记录的状态发布：默认 **预览、实时采集禁用**；不得因为发布而打开采集，
      也不得写成“已支持快手采集”。
- [ ] 金额、稳定身份、去重、场次生命周期、30 天保留策略未被放宽。
- [ ] 备份 / 恢复 / 迁移闭环通过（EXE 级验证优先）。
- [ ] 凭据不进入日志、备份、分析包或发布资产。

### 3.3 语言与界面

- [ ] 按 `src/shared/locales.mjs` 的实际可用语言逐语言检查，**不再假定三语**。当前为十语：
      `zh-CN` / `ja` / `en` / `ko` / `es` / `pt-BR` / `zh-TW` / `fr` / `de` / `id`。
- [ ] 所有字典键集、`{param}` 占位符、空值与残留英文整句检查通过。
- [ ] 界面语言与 AI 输出语言仍是两个独立设置；任务语言快照不可变。
- [ ] 启动器 `--help --lang <code>` 对全部可用语言返回 0；控制台无乱码。
- [ ] 真实或等价浏览器矩阵覆盖全部语言与 1440 / 1024 / 390 宽度、明暗主题，无溢出与原始键。
- [ ] 内置使用说明、README 与本轮实际能力一致。

### 3.4 文档

- [ ] `docs/STATUS.md` 当前状态快照更新为本次版本。
- [ ] `docs/HANDOFF.md` 记录本轮交接。
- [ ] `docs/ROADMAP.md` 的当前阶段与后续计划更新。
- [ ] `docs/CHANGELOG.md` 与 `docs/release-notes/vX.Y.Z.md` 完成。
- [ ] README 的功能、平台表、下载链接、UAC 说明与许可证说明与实际一致。
- [ ] 没有把计划写成已完成；未观测事件仍标 `NOT-OBSERVED`。

### 3.5 Windows 人工项

以下项目不能由非交互自动化代替，发布前必须如实记录为“待人工确认”或由用户确认：

- [ ] 真实双击 EXE，UAC 选择“是”后正常启动。
- [ ] UAC 选择“否”由 Windows 取消启动。
- [ ] 干净 Windows 环境（无 Node、无开发环境）首次运行。
- [ ] Windows Defender / SmartScreen 的实际提示行为。
- [ ] 真实浏览器自动打开与 Ctrl+C 优雅退出。

未完成项必须写进 Release Notes 与 STATUS，不得写成“已通过”。

## 4. 构建

```bat
node scripts/build-windows.mjs
```

产物位于 `dist/`：

```text
dist/
├── LiveMemory.exe
├── README.md
├── LICENSE
└── SHA256SUMS.txt
```

- 构建脚本会打印 EXE 大小、SHA-256 与 Build ID；记录下来供 Release Notes 与
  `RELEASE_HISTORY.md` 使用。
- `SHA256SUMS.txt` 必须覆盖实际发布的 EXE；校验文件本身的大小与 SHA-256 也记录下来。
- 不要把 `dist/`、`build/`、测试数据、数据库或凭据提交到 Git。

## 5. 发布资产

当前发布形态：

- `LiveMemory.exe`（裸 EXE；Windows 10/11 x64）
- `SHA256SUMS.txt`

早期版本曾使用 `LiveMemory-vX.Y.Z-windows-x64.zip`（内含 EXE、README、LICENSE、
RELEASE_NOTES、SHA256SUMS）。是否重新启用压缩包由用户决定；不要在没有授权的情况下改变
发布形态或覆盖历史资产。

- 单个 EXE 必须自带运行时；用户不需要安装 Python、Node.js、npm 或数据库。
- 资产中不得包含 API Key、Token、Cookie、数据库、聊天记录、`secrets/`、缓存、日志或测试数据。
- 上传后必须重新下载一次，核对大小与 SHA-256 与本地构建一致。

## 6. 发布说明

- 正文来源：`docs/release-notes/vX.Y.Z.md`。
- 至少包含：
  - 版本、发布日期、支持平台与状态；
  - 新增、改变、修复；
  - 真实已验收与未验证项（明确 `NOT-OBSERVED` / 阻塞）；
  - Windows UAC、未签名、SmartScreen 说明；
  - 升级说明（Schema 是否变化、数据是否需要迁移）；
  - 许可证与 AGPL 二进制分发义务的简短提示（如资产包含 Douyin 组件）。
- 多语言摘要可以使用，但 README 与 Release Notes 的主要语言不强制固定；核心事实必须一致。
- Release body 与仓库中的 release notes 文件建议逐字节一致，并记录 SHA-256。

## 7. 发布操作（需用户授权）

1. 确认工作区干净、测试通过、版本一致。
2. 提交发布文档与版本变化（本地 Commit）。
3. 获得用户明确授权后 Push 目标分支。
4. 创建 annotated Tag `vX.Y.Z`，指向包含最终 `src/` 的发布提交。
5. 创建 GitHub Release（Draft 或直接 Published，按用户决定），上传 EXE 与 `SHA256SUMS.txt`。
6. 将 Release body 设置为 `docs/release-notes/vX.Y.Z.md` 的内容。
7. 发布后核对：Tag 指向、Release 状态、资产大小与 SHA-256、`/releases/latest`、
   旧版本页面仍可访问。
8. 把本次发布证据写入 `docs/RELEASE_HISTORY.md` 与 `docs/STATUS.md`，并提交。
9. 不使用强制推送；不覆盖、不删除历史 Release 资产。

## 8. 升级与回滚

### 升级

- 用户替换 EXE 即可；数据目录保持不变。
- 首次启动自动执行数据库迁移（只追加）。
- 新版本解压到新的 `app\<assetHash>` 目录；旧目录可在退出后清理。
- 升级前建议用户创建完整备份。

### 回滚

- 保留上一版 EXE 与升级前数据库备份。
- 如果 Schema 迁移导致问题：
  1. 停止程序；
  2. 用 `backups/pre-restore-*.db` 覆盖数据库；
  3. 换回旧 EXE；
  4. 在 STATUS / DECISIONS 记录原因与修复计划。
- 不提供自动降级迁移；数据格式变化必须向前兼容，或明确阻止旧版本启动。

## 9. 发布后记录

发布成功后，必须在 `docs/RELEASE_HISTORY.md` 追加：

- 版本、类型、发布日期；
- Tag、Tag object、目标 Commit；
- Release ID 与 URL、`draft` / `prerelease` 状态；
- 每个资产的文件名、大小、SHA-256；
- 全量测试数量与耗时、专项与 EXE 验收结果；
- 真实未验证项与已知限制；
- Release body 的 SHA-256（如有）。

同时更新 `docs/STATUS.md` 的当前状态快照，并把本次发布从 ROADMAP 的“下一步”移到
“已完成里程碑”。历史记录只追加，不改写既有证据。
