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
- [ ] 备份导出/导入/回滚（M5）
- [ ] 凭据不进入日志、备份、分析包

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
6. 第二次双击，确认单实例提示。
7. Ctrl+C，确认“已安全退出”，数据库无残留 WAL 异常。

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
- 升级前建议用户执行一次备份（M5 起提供按钮）。

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
