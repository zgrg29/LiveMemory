# UI 设计规范（UI_DESIGN）

## 1. 设计原则

参考 Apple 官网与其产品界面的视觉语言，但**不使用任何 Apple 商标、图片或专有资源**：

- 清晰层级：标题 → 说明 → 数据 → 操作
- 大量留白：页面最大宽度 1120px，卡片间距 16px，区块间距 32–44px
- 克制强调色：只有主操作、选中态与数据高亮使用蓝色
- 细腻边框与阴影：1px 半透明描边 + 极轻阴影，避免“卡片堆叠感”
- 统一交互反馈：hover 变色、按下轻微缩放、focus-visible 蓝色描边
- 平滑但不过度：180–240ms，`cubic-bezier(0.4, 0, 0.2, 1)`，尊重 `prefers-reduced-motion`

## 2. 字体

```css
--font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue",
  "Noto Sans SC", "PingFang SC", "Microsoft YaHei UI", "Hiragino Sans",
  "Yu Gothic UI", "Noto Sans JP", "Meiryo", sans-serif;
```

- 全部使用系统字体，无商业字体授权问题。
- 标题字重 600、字距 -0.02 ~ -0.035em；正文 15px/1.5。
- 数字使用 `font-variant-numeric: tabular-nums`，避免跳动。
- 中日文回退已显式指定，Windows 上优先 Segoe UI + 微软雅黑 UI / Yu Gothic UI。

## 3. 色彩（`src/web/styles/tokens.css`）

| Token | 明亮 | 黑暗 |
| --- | --- | --- |
| `--bg` | `#f5f5f7` + 轻微径向渐变 | `#000000` + 深灰径向渐变 |
| `--surface` | `#ffffff` | `#1c1c1e` |
| `--surface-raised` | `#ffffff` | `#242426` |
| `--surface-sunken` | `#f5f5f7` | `#141416` |
| `--text` | `#1d1d1f` | `#f5f5f7` |
| `--text-secondary` | `#6e6e73` | `#a1a1a6` |
| `--hairline` | `rgba(0,0,0,.085)` | `rgba(255,255,255,.10)` |
| `--accent` | `#0071e3` | `#0a84ff` |
| `--success / live` | `#1a7f37` / `#34a853` | `#30d158` |
| `--warning` | `#a35200` | `#ffb340` |
| `--danger` | `#c8102e` | `#ff6961` |

黑暗模式不是反色：背景分层（黑 → `#1c1c1e` → `#242426`）、边框降低对比、强调色提亮、阴影加深，图表渐变重新调色。

## 4. 间距、圆角、阴影

- 间距：4 / 8 / 12 / 16 / 24 / 32 / 44 / 64
- 圆角：6 / 9 / 13 / 18 / 24 / 980（胶囊）
- 阴影：`--shadow-xs` 到 `--shadow-lg`，黑暗模式更暗更散

## 5. 布局

```text
┌─────────────┬──────────────────────────────────────┐
│ Sidebar 256 │ Topbar（粘性、半透明模糊）            │
│ 品牌         ├──────────────────────────────────────┤
│ 5 项导航     │ Content（max 1120，居中，40px 边距）  │
│ 连接状态     │  Page head + 卡片网格                 │
└─────────────┴──────────────────────────────────────┘
```

- 侧边栏固定、半透明 + `backdrop-filter`，底部显示连接状态与版本。
- 顶栏：页面标题、隐私提示、语言切换、主题切换。
- 语言切换与外观切换同一区域：宽屏为 `简体中文 / 日本語 / English` 三个始终以各自语言显示的分段按钮 + 地球“跟随系统”按钮；≤860px 折叠为带地球标识的原生 select。不得只提供当前语言文字按钮；切换不刷新页面。
- ≤860px：侧边栏变抽屉（hamburger + 遮罩 + Esc 关闭），顶栏保留。
- 统计卡：桌面 4 列 → 900px 2 列；页面网格 900px 单列。
- 390px 宽度下无横向溢出（已截图验证）。

## 6. 组件

| 组件 | 规范 |
| --- | --- |
| 主按钮 | 胶囊、强调色、白字、`inset` 高光、按下 0.985 缩放 |
| 次按钮 | 表面色 + 1px 描边 |
| 危险按钮 | `--danger-soft` 背景 + 危险色文字（“结束记录”） |
| 统计卡 | 11px 大写标签 + 27px 数值 + 12px 注释 |
| Chip | 胶囊、11.5px、语义色（live 带脉冲点） |
| 列表行 | 1px 分隔线、hover 轻背景、整行可点击 |
| 分段控件 | 内凹容器 + 白色选中块（语言、存储模式） |
| 主题卡 | 三张预览缩略图 + 选中描边与圆点 |
| 空状态 | 圆形图标 + 标题 + 说明 + 可选操作 |
| Toast | 右下、卡片式、语义色圆点、4.2s 消失 |
| 图表 | Canvas 面积图、主题色渐变、hairline 网格、hover 提示、时间轴标签 |

## 7. 页面结构

1. **直播记录**：状态 Hero（开始/结束、已记录时长、消息数）→ 4 统计卡 → 消息密度图 → 最近动态 + 最活跃观众；空闲时展示上一场摘要。
2. **直播历史**：表格化列表（场次、时长、消息、观众、支持、AI 状态）；详情含统计卡、时间线、经济支持、最活跃观众、AI 占位、存储信息。
3. **观众档案**：主播范围选择器 + 搜索 + 列表（头像首字、平台 ID、当前主播范围的场次/发言/支持、参与主播数、关注星标）；详情含身份、参与过的主播（可切换）、当前主播的互动档案、该主播场次/支持、昵称历史、全局参与概览（明确标注）与兴趣占位。主播多时范围选择器附搜索框。
4. **AI 分析中心**：三步卡片（导出 AI 分析包 / 交给 AI / 导入 AI 分析结果）→ 自然语言任务说明卡 → 导出表单 → AI 分析指令预览与复制 → 导入占位（明确标注 M6）→ 已导出包列表。界面不绑定任何 AI 品牌，使用任意支持文件上传与结构化输出的 AI 服务。
5. **设置**：语言（含跟随系统与实际生效语言，并提示 Header 为主入口）、外观（三张预览卡）、存储模式、YouTube 接入、**数据存储位置**（真实路径、来源、位置记录、可写状态、空间、计数、修改/打开/刷新）、**数据管理**（清空数据、恢复出厂设置、数据库快照说明）、关于。

### 7.1 聊天文字与表情显示

- 弹幕原文使用 `textContent` 渲染，保留中文/日文/英文混排、Unicode Emoji、变体选择符、肤色修饰符与 ZWJ 序列。
- 平台表情优先显示平台提供的文字标签（例如 Bilibili 的「就这」）；正文已有 `[猫猫鼓掌]` 时原样显示，不额外替换成图片。
- 只有正文为空、但存在表情元数据时，才显示本地化回退「平台表情：名称 / id」；表情缺失不影响昵称、时间戳和消息顺序。
- 本版本不下载、不缓存、不显示平台表情图片；未来若增加，必须有加载失败回退到文字，并把图片缓存与长期聊天数据分开。
- 未知表情不臆测情绪，不使用颜色/图标暗示“开心/生气”。

### 7.2 AI 任务说明

- AI 分析中心顶部用自然语言列出：整场话题与变化、时段讨论变化、回看片段、新观众初始画像、既有观众新信息/兴趣变化/画像更新。
- 说明文字明确“文字、Unicode Emoji 与平台表情名称；未知表情会被标记，不会猜测含义”。
- 提供“使用你选择的 AI 服务”说明，不假设存在一个通用 AI 网站；不同 AI 的文件大小、ZIP 支持和上下文长度差异由用户自行处理。
- 正式指令由软件按任务与协议版本生成，用户只需复制，不需要手写提示词。

### 7.3 直播来源：三个标签

直播记录页的「直播来源」卡片是唯一让用户选择平台的地方，固定三个标签：**模拟直播 / Bilibili 直播 / YouTube 直播**。标签切换不得清空当前正在进行的记录。

YouTube 标签只有一个入口，与 Bilibili 一样直接：

- 一句说明 + 「直播链接或视频 ID」输入框 + 「检查直播」按钮。
- 检查结果用胶囊表达：正在直播（`live`）、尚未开始、已结束、非直播、聊天关闭；不可记录时说明原因，不显示开始按钮。
- 可记录时显示标题/频道/当前观看/开始时间与「开始记录直播」。
- 连接后显示连接状态、当前观看、已收消息数与「可能漏消息」；10 秒轮询一次。
- 不显示：官方 API / 实验模式切换、Google 登录、API Key、OAuth、配额、实验 badge、模式技术说明。
- 不要求用户先理解接入机制；数据保留说明（天数 + 立即清理）保留在面板底部。
- 设置页的 YouTube 卡只读说明：无需登录/Key/Cookie；非 YouTube 官方稳定 API、可能失效；30 天保留。
- 动态流显示平台确认的 badge 文本；没有 badge 不占位。

### 7.4 数据存储位置与危险操作

- “数据存储位置”卡显示：当前真实目录（等宽字体）、来源（默认/自定义位置/命令行临时指定）、位置记录文件、可写状态、可用空间、LiveMemory 占用、数据库占用、场次/观众/事件；按钮：修改存储位置、打开数据文件夹、刷新。
- “修改存储位置”对话框：
  - 目标路径输入 + 浏览（Windows 原生 FolderBrowserDialog，由本地服务启动；浏览器不伪造目录选择器）；
  - 浏览返回完整绝对路径；取消不报错、不改变输入；无交互桌面时仍可手动输入；
  - 两种模式：迁移现有数据（推荐）/ 在新目录创建新的数据空间，均有清楚说明；
  - 云同步/临时目录/长路径 warning + 需要勾选确认；UNC 直接拒绝；
  - 成功后显示原目录（未删除）、新目录、迁移前后事件数、位置记录；旧目录不会自动删除。
- “数据管理”危险区：两个独立操作（清空数据 / 恢复出厂设置），每个都有范围说明；二次确认对话框要求输入 `DELETE` / `RESET`，默认勾选数据库快照，记录中禁用。
- 删除成功后显示清理前后场次/事件/观众、备份路径、清理文件数；按钮“完成并刷新”。快照目录默认不在数据目录内。

### 7.5 多主播范围选择器

- 默认“当前主播”（服务端按直播中/最近真实场次确定）；选项包括全部主播、其他主播、待确认主播（仅当存在 unresolved 历史）。
- 主播数 > 8 时显示搜索框；排序：发言最多/参与场次最多/支持最多/最近出现/最新出现。
- 列表在具体主播范围下只显示该主播的场次、发言、支持；全部主播显示全局合计与“参与过 N 位主播”。
- 详情页的“参与过的主播”行可点击切换；当前主播范围高亮；全局概览放在最后并用虚线卡片与“全部主播”标注，不与当前主播档案混排。
- 主播身份 chip：已确认频道（强调色）/ 按直播间识别（警告）/ 模拟直播（中性）/ 待确认（警告）。

## 8. 主题行为

- 首次启动默认跟随系统；`theme-boot.js` 在 CSS 之前设置 `data-theme`，避免闪烁。
- 用户选择明亮/黑暗后覆盖系统，并保存到 `config/settings.json` + `localStorage` 镜像。
- 选择跟随后，`matchMedia('(prefers-color-scheme: dark)')` 变化实时响应，无需刷新。
- 图表监听 `livememory:themechange` 重绘；切换不改变布局尺寸。

## 9. 多语言

- 三语 JSON：`src/web/i18n/{zh-CN,ja,en}.json`，由测试保证键与占位符完全一致。
- 语言切换即时生效：重新加载字典 → 更新静态文案与导航 → 重渲染当前页；不刷新浏览器、不丢失数据。
- 用户可见的错误来自 `errors.*` 键，不直接展示服务器英文。
- 直播原文（昵称、弹幕、礼物名、标题）不翻译。
- 日期/数字/货币使用 `Intl` 按当前语言格式化；货币保留原币种符号与小数位。

## 10. 可访问性

- 语义化标题层级；导航 `aria-current="page"`。
- 图标按钮均有 `aria-label`（随语言更新）。
- 焦点可见（2px 强调色描边，2px offset）。
- 图表有 `aria-label` 概括，关键数值同时以文本呈现。
- 抽屉导航支持 Esc 关闭；列表行支持 Enter/Space 打开。
- 对比度：正文与背景 ≥ 7:1（明亮）/ ≥ 12:1（黑暗），次要文字 ≥ 4.5:1。
- 动画在 `prefers-reduced-motion` 下关闭。

## 11. 视觉验证记录

本机通过无头 Edge（DevTools 协议）截图，保存于：

- `docs/screenshots/live-light-zh-CN.png`（1440×1040，明亮中文）
- `docs/screenshots/history-detail-zh-CN.png`（单场详情）
- `docs/screenshots/settings-dark-ja.png`（黑暗日语）
- `docs/screenshots/live-mobile-zh-CN.png`（390×844）
- `docs/screenshots/live-emoji-light-zh-CN.png`（1440×1100，带 Emoji/表情的直播动态）
- `docs/screenshots/ai-light-zh-CN.png`（1440×1200，明亮中文 AI 分析中心与任务说明）
- `docs/screenshots/ai-dark-ja.png`（1440×1200，黑暗日语 AI 分析中心）
- `docs/screenshots/ai-mobile-light-zh-CN.png`（390×1100，移动端 AI 分析中心）
**v0.5.0 新截图（当前界面）：**

- `docs/screenshots/live-youtube-v050-light-zh-CN.png`（1440×1120，唯一公开网页入口）
- `docs/screenshots/live-youtube-v050-dark-zh-CN.png`（黑暗主题）
- `docs/screenshots/live-youtube-v050-mobile-zh-CN.png`（390×1000，窄屏）
- `docs/screenshots/settings-youtube-v050-zh-CN.png`（设置页只读说明）
- `docs/screenshots/settings-data-location-v050-zh-CN.png`（修改数据位置 + 浏览按钮）

> 以下 YouTube 官方/实验模式截图属于 v0.3.0–v0.4.0 历史记录；v0.5.0 已改为唯一公开网页入口，需以本轮新截图为准。

- `docs/screenshots/live-youtube-light-zh-CN.png`（历史：YouTube 官方模式面板）
- `docs/screenshots/live-youtube-dark-zh-CN.png`（黑暗主题）
- `docs/screenshots/live-youtube-mobile-light-zh-CN.png`（390×1000，窄屏无横向溢出）
- `docs/screenshots/live-youtube-recording-zh-CN.png`（官方模式录制中）
- `docs/screenshots/live-youtube-unconfigured-zh-CN.png`（官方未配置状态）
- `docs/screenshots/live-youtube-anonymous-unconfigured-zh-CN.png`（默认官方未配置 + 实验模式入口）
- `docs/screenshots/live-youtube-anonymous-light-zh-CN.png`（实验模式 warning + 无需 Key + 链接输入）
- `docs/screenshots/live-youtube-anonymous-dark-zh-CN.png`（实验模式黑暗主题）
- `docs/screenshots/live-youtube-anonymous-recording-zh-CN.png`（真实匿名会话统计；观众名与聊天正文已替换为示例，避免把公开观众数据长期写入仓库）
- `docs/screenshots/live-youtube-anonymous-mobile-zh-CN.png`（390×1200，同上，示例化观众数据）
- `docs/screenshots/settings-youtube-anonymous-zh-CN.png`（设置页 YouTube 接入卡）
- `docs/screenshots/header-language-zh-CN.png`（1440×1000，Header 中文分段 + 地球按钮）
- `docs/screenshots/header-language-ja.png`（Header 日语；三种语言名仍为原生写法）
- `docs/screenshots/header-language-en.png`（Header 英语）
- `docs/screenshots/header-language-dark-ja.png`（黑暗主题 + 日语）
- `docs/screenshots/header-language-mobile-zh-CN.png`（390×844，窄屏原生 select）
- `docs/screenshots/settings-data-location-zh-CN.png`（数据存储位置卡）
- `docs/screenshots/settings-data-location-after-move-zh-CN.png`（迁移后：位置记录/新目录/计数）
- `docs/screenshots/settings-relocation-dialog-zh-CN.png`（迁移/新空间对话框）
- `docs/screenshots/settings-relocation-result-zh-CN.png`（迁移结果：12→12 事件、原目录未删）
- `docs/screenshots/settings-danger-zh-CN.png`（数据管理危险区）
- `docs/screenshots/settings-clear-dialog-zh-CN.png`（输入 DELETE、快照勾选）
- `docs/screenshots/settings-factory-dialog-zh-CN.png`（输入 RESET）
- `docs/screenshots/settings-clear-result-zh-CN.png`（清空结果：3/12/4 → 0/0/0）
- `docs/screenshots/viewers-broadcaster-scope-zh-CN.png`（主播范围 + 搜索 + 排序 + 范围统计）
- `docs/screenshots/viewer-detail-two-broadcasters-zh-CN.png`（同一观众参与 2 位主播，分别统计 + 全局概览）
- `docs/screenshots/viewers-all-broadcasters-zh-CN.png`（全部主播列表 + 参与主播数）
- `docs/screenshots/viewers-mobile-zh-CN.png`（390×1000 观众范围响应式）
- `docs/screenshots/viewers-empty-after-clear-zh-CN.png`（清空后无缓存残留）

尚未在第二台 Windows 设备/真实控制台字体环境下验收。
