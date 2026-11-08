# LiveMemory 工程规则（AGENTS.md）

本文件是仓库的工程入口。**每轮开发开始时必须首先阅读本文件**，再按顺序阅读状态文档。

---

## 1. 项目目标

LiveMemory 是面向普通主播的 **Windows 本地软件**：本地优先、免费、不依赖任何 AI API、不需要开发者维护服务器。观众数据保存在用户自己的电脑上，AI 分析通过手动文件往返完成。

第一版支持 Bilibili Live 与 YouTube Live。当前发布形态为 `LiveMemory.exe`，用户不应需要安装 Python、Node.js、npm 或数据库。

---

## 2. 每轮开始：强制阅读顺序

1. `AGENTS.md`（本文件）
2. `docs/STATUS.md`（真实状态，唯一进度来源）
3. `docs/HANDOFF.md`（上一轮交接）
4. `docs/ROADMAP.md`（当前里程碑）
5. 本轮相关文档：
   - UI → `docs/UI_DESIGN.md`
   - Windows 启动 / EXE → `docs/WINDOWS_RUNTIME.md`
   - 数据库 / 备份 → `docs/DATA_MODEL.md`、`docs/BACKUP_RESTORE.md`、`docs/PRIVACY_SECURITY.md`
   - AI 文件协议 → `docs/AI_CONTRACT.md`
   - 平台接入 → `docs/PLATFORM_INTEGRATIONS.md`
6. 检查实际代码与 `git status`，核对文档与代码是否一致。

**不能只依据旧聊天记录判断项目状态。**

---

## 3. 技术栈（不要随意替换）

| 关注点 | 决定 |
| --- | --- |
| 运行时 | Node.js ≥ 22.5（需要内置 `node:sqlite`） |
| 模块 | ES Modules（`.mjs`），无构建步骤 |
| 运行时依赖 | **零依赖**。不要引入需要 `npm install` 的库，除非在 DECISIONS 中记录并说明打包影响 |
| 数据库 | `node:sqlite`（内置，同步 API，WAL） |
| HTTP | `node:http`，仅监听 `127.0.0.1` |
| 前端 | 原生 HTML/CSS/JS，无框架、无打包器 |
| 测试 | `node --test` |
| EXE | Node SEA（Single Executable Application）+ postject 注入 |
| 图表 | Canvas 2D（`src/web/js/chart.js`） |

---

## 4. 目录结构（实际）

```text
src/launcher/        启动器：参数、数据目录、单实例、浏览器、命令行三语、退出
src/server/          HTTP 服务、路由、设置存储、日志、SSE
src/platforms/       平台适配器（mock 已实现；bilibili/youtube 计划中）
  shared/            adapter 契约、ingest 写入管线、session manager
src/storage/         database（连接/迁移）、repositories（SQL 访问）
src/analytics/       sessions（时间线/汇总）、payments（币种合计）、viewers（画像读模型）
src/ai/              export（分析包）、prompts（三语说明）、schemas（结果 JSON Schema）
src/web/             index.html、js/（app、pages、i18n、chart、theme）、styles/、i18n/*.json
src/shared/          跨层纯逻辑：事件模型、金额、语言、主题、时间、zip、错误
tests/               unit / integration / helpers / fixtures
scripts/             构建 EXE、SEA bootstrap、UI 截图、冒烟脚本
docs/                产品、状态、架构、协议、发布等文档
log/                 每轮开发记录
```

**依赖方向**：`web → server → platforms/storage/analytics → shared`。`shared` 不得反向依赖上层。

---

## 5. 常用命令

```bat
:: 启动（开发模式，自动打开浏览器）
start.cmd
node src/launcher/launcher.mjs

:: 只启动服务，不打开浏览器
node src/launcher/launcher.mjs --no-open

:: 指定端口 / 数据目录 / 语言
node src/launcher/launcher.mjs --port 48300 --data-dir D:\temp\lm --lang ja

:: 测试
node --test tests/unit tests/integration

:: 受限环境（禁止子进程）下的单进程测试
node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"

:: 构建 EXE
node scripts/build-windows.mjs
```

测试必须使用独立数据目录（`tests/.tmp/` 或临时目录），绝不能读写用户真实的 `%LOCALAPPDATA%\LiveMemory`。

---

## 6. 架构纪律

1. **单一写入路径**：所有平台事件都必须经过 `src/platforms/shared/ingest.mjs`，由它负责去重、观众聚合、金额累计、场次计数。不要在路由或页面里直接写 `events` 表。
2. **平台解耦**：适配器只负责传输与解析，输出 canonical event（`src/shared/events.mjs`）。UI、统计、AI 包不得出现平台专有字段。
3. **稳定身份**：观众主键是 `platform:stable_uid`。**昵称不是身份**。不同平台的同名用户不得合并。
4. **金额**：一律使用整数最小货币单位（minor units），并同时保存 `currency` 与 `value_kind`（`actual` 实际支付 / `display` 展示价值 / `unknown`）。不得混加不同币种或不同 value_kind。
5. **去重**：事件以 `UNIQUE(session_id, dedupe_key)` 兜底；重复投递不得增加计数或金额。
6. **时间**：数据库统一存 epoch 毫秒整数（INTEGER），展示层本地化。
7. **读模型与分析分离**：`analytics/` 只读数据库生成展示数据，不写库。
8. **AI 不记账**：AI 输出永远不能修改本地金额与计数。

---

## 7. UI 规范（必须遵守）

- 视觉语言参考 Apple 官网：克制、留白、层级清晰、精致排版、柔和边框/阴影、少量强调色。
- 颜色、间距、圆角、阴影全部通过 `src/web/styles/tokens.css` 的 CSS 变量使用，不得在组件里写死颜色。
- 明亮与黑暗**分别设计**，不能简单反转。
- 首次渲染不得出现主题闪烁：`data-theme` 由 `js/theme-boot.js` 在样式表之前设置。
- 三语（`zh-CN` / `ja` / `en`）全部文案放在 `src/web/i18n/*.json`，使用 `t('key', {params})`；禁止在页面中硬编码用户可见句子。
- 启动器文案放在 `src/launcher/cli-i18n.mjs`，三语键必须一致。
- 任何来自平台/用户的文本（昵称、弹幕、标题）必须通过 `textContent` 渲染；**禁止 `innerHTML`**。
- 桌面优先；≤860px 折叠侧边栏为抽屉；窄屏不得出现横向溢出。
- 主题/语言切换不得造成布局跳动或内容丢失。

---

## 8. Windows 与数据安全

- 只监听 `127.0.0.1`，禁止 `0.0.0.0`；动态端口，端口冲突自动顺延或使用系统分配端口。
- 用户数据只能写入 `%LOCALAPPDATA%\LiveMemory\`（或用户显式指定的可写目录），**绝不写 `Program Files` / EXE 所在目录**。
- 正常运行不需要管理员权限；遇到权限错误要解释路径与替代方案，不得直接要求“以管理员身份运行”。
- 日志不得包含 Cookie、Token、API Key、聊天正文；使用 `src/server/logger.mjs` 的脱敏。
- 仅一份实例可写同一数据目录（`runtime/instance.lock`）。
- 优雅退出：停止适配器 → 关闭 SSE → 关闭 HTTP → WAL checkpoint → 关闭数据库 → 删除 runtime 文件。
- 导入外部文件（未来备份/AI 结果）必须验证格式、版本、大小、路径穿越；失败必须可回滚。

---

## 9. 文档、测试与提交

每轮结束必须：

1. 运行适用测试，并在 `docs/TEST_PLAN.md` 或 `docs/STATUS.md` 记录真实结果。
2. 更新 `docs/STATUS.md`、`docs/HANDOFF.md`、`docs/ROADMAP.md`、本轮相关技术文档、`log/<日期>-<主题>.md`。
3. 检查 `git diff`，确认没有提交用户数据、凭据、`tests/.tmp`、`dist/`、`build/`。
4. 创建本地 Commit（见下）。**未经用户明确授权，不得 Push、打标签、发布 Release 或创建远程仓库。**

### 提交身份（强制匿名）

- 本仓库的 Git 身份固定为匿名的 GitHub noreply 地址，**不得使用真实邮箱**：
  - `user.name = zgrg29`
  - `user.email = 10182596+zgrg29@users.noreply.github.com`
- 这两个值是**仓库本地**配置（`git config --local`），已在本仓库设置；新克隆或新环境必须重新设置后再提交。
- GitHub 开启 “Keep my email addresses private” 时会拒绝包含真实邮箱的 Push；noreply 地址仍能关联账号，但不会公开真实邮箱。
- 不得用 `--author` 或临时环境变量改回真实邮箱。若发现历史提交含真实邮箱，先重写历史再 Push。
- 每次提交后可用 `git log --format='%ae | %ce'` 自检。

Commit 命名：

```text
chore: initialize LiveMemory project
docs: establish architecture and roadmap
feat: implement Windows launcher
feat: add system theme and locale detection
feat: implement local session recording
feat: add AI export and import workflow
test: verify cross-device migration
fix: prevent duplicate payment events
```

---

## 10. 禁止事项

- 不得修改或提交 `.ref/bili-gift-drop` 参考仓库（只读参考，已 gitignore）。
- 不得提交真实数据库、日志、备份、分析包、Cookie、Token、API Key。
- 不得把“计划”写成“已完成”；模拟测试通过不得描述为真实平台接入完成。
- 不得为了让测试通过而修改断言掩盖真实缺陷。
- 不得引入云服务、账号体系、遥测或任何形式上传播音数据的依赖。
- 不得在未验证的情况下宣称 EXE 已在“干净 Windows 环境”通过验收。

---

## 11. 每轮交付自检清单

- [ ] 本地服务器可启动，浏览器可打开控制台
- [ ] 三语界面与命令行无缺失键、无乱码
- [ ] 明亮/黑暗/跟随系统均正常，刷新后保持
- [ ] 新增逻辑有对应测试，且 `node --test` 通过
- [ ] 金额、身份、去重规则未被破坏
- [ ] STATUS / HANDOFF / ROADMAP / 开发日志已更新
- [ ] 已创建本地 Commit 并报告 Hash
