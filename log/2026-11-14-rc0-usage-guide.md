# RC0-USAGE-GUIDE：三语使用说明与 RC0 封版（2026-11-14）

## 1. 任务与边界

本轮是 RC0 的**最后一轮轻量收尾**：只新增控制台内「使用说明」入口与内容，并完成封版准备。

明确不做：

- 不新增任何观众数量、消息数量、直播时长、AI 分析次数、总 Token、总费用、总运行时间或批次数量限制。
- 不强制用户审核 AI 画像，不新增阻断正常操作的确认弹窗。
- 不修改 AI 分析、长期画像、事实合并、批次调度、数据保存/恢复机制与 Provider 配置逻辑。
- 不处理其他 P1/P2，不新增开发里程碑。
- 不 Push、不打 Tag、不发布。

## 2. 设计

### 2.1 入口

- 侧栏在「设置」之后新增第 6 项导航「使用说明 / 使い方 / User guide」，
  `data-nav="help"`，书页 SVG mask 图标（`base.css`）。
- 路由 `#/help` → `src/web/js/pages/help.js`，`titleKey: 'help.pageTitle'`。
- 页面标题、文档标题与侧栏文案都来自 i18n，切换语言后整页重渲染。

### 2.2 内容结构（9 章 + 8 问）

| # | 章节 | 关键内容 |
| --- | --- | --- |
| 1 | 首次启动与基本流程 | 双击、无管理员权限、自动打开浏览器、语言/主题、新建记录、历史与观众、AI 前置配置、Ctrl+C |
| 2 | 连接 Bilibili 和 YouTube 直播 | 房间号/链接、扫码登录可选、YouTube 公开网页聊天无需 Key/OAuth/Cookie、多场并发、自动监听、两个平台的边界说明 |
| 3 | 查看记录、观众数据与历史场次 | 直播页统计、历史搜索/筛选、单场详情、停止/归档/删除、观众档案、可识别观众 vs 未识别消息、金额口径 |
| 4 | 配置 AI Provider 与 API Key | 7 类 Provider、Base URL/Model、Key 本地加密、能力测试、价格可选、并发 1–8 |
| 5 | 单场分析与长期观众画像 | 五步入口、范围选择、任务规模、输出语言、分别保存、后台继续、**无任何使用限制** |
| 6 | 长期记忆、事实可信度与原始证据 | 事实、stated/inferred/uncertain、5 种状态、证据、版本回滚、确认/忽略/删除；AI 可能不准确的客观说明 |
| 7 | 分析进度、失败任务与继续 | 阶段/批次/观众/请求/Token/费用、技术详情、继续面板只补未完成、重启可恢复、完成后再点 0 请求、换模型 |
| 8 | 备份、恢复与迁移 | `.livememory`、默认目录、包含/排除、摘要、RESTORE、恢复前快照、journal、恢复后重连、新电脑 |
| 9 | 常见问题与注意事项 | 会话失效、Bilibili 打码、YouTube 重连、费用估算、画像不准、多场并发、数据位置、退出方式 |

### 2.3 组件与视觉

- 复用 `pageHead`、`card`、`card-head`、`card-title`、`card-body`、`callout callout--neutral`、
  `button button--secondary`、原生 `details/summary`；仅新增 `.help-*` 类。
- 桌面：236px sticky 目录 + 内容两栏；章节为编号圆点 + `h2` + 引导句 + 步骤列表 + 说明 callout。
- 窄屏：≤1000px 单列，目录变胶囊行；≤700px 术语表单列；≤520px 缩小标题/目录。
- 主题、间距、圆角、阴影全部走 `tokens.css` 变量；未写死颜色。
- 目录点击 `scrollIntoView` + `focus({preventScroll:true})`，章节 `tabindex="-1"`、
  `aria-labelledby`、`scroll-margin-top`；尊重 `prefers-reduced-motion`。

### 2.4 只读与安全

- 页面不 import `api`，不含 `/api/` 字符串，不发请求、不写设置、不读 storage。
- 全部文本经 `textContent`；无 `innerHTML`/`outerHTML`/`insertAdjacentHTML`；无 `alert`/`confirm`/`prompt`。
- 说明页不改变本地 API 认证；未认证 `/api/bootstrap` 仍为 401（打包验证覆盖）。

## 3. 文案生成方式

三份字典键必须完全一致。为避免 112 个键在三种语言间错位，本轮用一个一次性脚本
（`build/help-i18n.mjs`，`build/` 已 gitignore）以「同一 dot path × 三语」的扁平表生成
`help.*` 与 `nav.help`，写入时保持既有 2 空格格式与结尾换行；写入后由
`tests/unit/i18n.test.mjs` 验证键集、非空与占位符。

- `help.*` 叶子键：112 个
- 顶层结构：`help.pageTitle/pageSubtitle/tocTitle/introTitle/introBody/introLocal`、
  `help.action.*`、`help.sections.<id>.{title,lead,stepN,note|noteBilibili|noteYoutube,qN,aN,term.*}`
- `nav.help`：3 种语言
- 三语内容不是直译占位：日语使用です・ます体，英语避免中式表达；术语（Provider、API Key、
  RESTORE、viewer、profile 等）按各语言习惯保留。

## 4. 测试与验证

### 4.1 新增测试

`tests/unit/help-ui.test.mjs`（9 项）：

1. 导航/路由/图标接线；
2. 9 章节顺序、`aria-labelledby`、`tabindex`、目录 9 项；
3. 三语真实字典渲染、无未解析键/占位符；
4. 内容覆盖（Bilibili/YouTube/历史/API Key/开始分析/明确说过/继续/RESTORE/FAQ）；
5. 无限制与无强制审核文案；
6. 目录滚动 + 聚焦，三个按钮跳转；
7. FAQ 8 组问答；
8. 只读（无 innerHTML/alert/API/storage）；
9. 响应式 CSS 断言。

测试用只读 DOM shim 渲染真实模块与真实字典，不是纯字符串匹配。

### 4.2 既有测试

`tests/unit/i18n.test.mjs` 4/4：三语键集、非空、占位符、CLI 三语。

### 4.3 全量

```text
node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"
```

**828 passed / 0 failed / 0 skipped（209,636.8539 ms，2026-11-14）**；上一轮 819，+9。
未修改任何既有断言。

### 4.4 正式 EXE

```text
node scripts/build-windows.mjs
node scripts/verify-help-exe.mjs
node scripts/verify-exe.mjs
```

- `dist/LiveMemory.exe`：`96,733,184` B（92.3 MB），buildId `74ed76e88a51`，
  SHA-256 `0f4cf0a39d1b7182182d681e6261f7517ab952142d0c4848d177e1788b6f2cdd`，
  `192` assets，21 个必需模块，`asInvoker`；构建时 HEAD `bc48a94`。
- `verify-help-exe` **14/14**：asInvoker、启动/buildId、未认证 401、schema 16、
  导航/路由/模块/图标/响应式 CSS、三语键一致与内容覆盖、无限制文案、切日语生效。
- `verify-exe` **10/10**：asInvoker、全新目录、重启、硬杀恢复、端口顺延、单实例、
  不可写目录、异目录、解压复用、CLI 三语。
- 构建脚本把 `src/web/js/pages/help.js` 加入 `REQUIRED_MODULES`，缺少说明页的构建会直接失败。

### 4.5 真实浏览器：未执行（环境阻塞）

本轮尝试了 Chrome 154 与 Edge 157 的 headless（含 `--no-sandbox`、`--single-process`、
`--disable-breakpad`），均在启动时因 DSH 沙箱拒绝 Chromium 的 mojo `platform_channel`
（`OpenProcess` / `platform_channel` 返回 0x5）而终止，DevTools 端口无法连接。
因此：

- **没有**真实浏览器截图、点击或窄屏设备验收，文档与报告均不声称完成。
- 界面表现由以下证据覆盖：真实三语字典 + DOM 渲染测试（结构、文本、目录交互、FAQ）、
  打包后 HTML/JS/CSS 的实际下发检查、三档响应式 CSS 断言、既有 390px 无横向溢出规范。
- 建议用户在本机打开 `#/help`，检查明暗主题、三语切换与窄屏目视效果。

## 5. 没有改变的东西

- 数据库 schema **16**；结果 Schema **1.3.0**；提示词 **v13.2**；默认 **10 人/批**。
- 金额/币种/value_kind、稳定身份、去重、事件单一写入路径、备份格式与恢复 journal。
- 本地 API 认证、Origin/Host 校验、SSE 认证、asInvoker 构建断言。
- 任何既有页面的布局与交互。

## 6. 交付物

| 类型 | 文件 |
| --- | --- |
| 页面 | `src/web/js/pages/help.js` |
| 接线 | `src/web/index.html`、`src/web/js/app.js` |
| 样式 | `src/web/styles/base.css`（导航图标）、`src/web/styles/pages.css`（`.help-*`） |
| 文案 | `src/web/i18n/{zh-CN,ja,en}.json` 新增 `help.*` + `nav.help` |
| 测试 | `tests/unit/help-ui.test.mjs` |
| 打包验证 | `scripts/verify-help-exe.mjs`、`scripts/build-windows.mjs`（必需模块） |
| 文档 | README、STATUS §0.30、HANDOFF §0、ROADMAP P24、CHANGELOG r19、TEST_PLAN §42、UI_DESIGN §7.23 |

## 7. 状态

RC0 使用说明完成并通过代码级、打包级与全量回归验证；**未 Push / 未 Tag / 未发布**，
等待用户决定后续动作。
