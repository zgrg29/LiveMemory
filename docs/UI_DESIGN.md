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
- 顶栏：页面标题、隐私提示、主题切换。
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
3. **观众档案**：搜索 + 列表（头像首字、平台 ID、场次/发言/支持、关注星标）；详情含身份、累计支持、参与场次、昵称历史、兴趣占位。
4. **AI 分析中心**：三步卡片（导出 AI 分析包 / 交给 AI / 导入 AI 分析结果）→ 自然语言任务说明卡 → 导出表单 → AI 分析指令预览与复制 → 导入占位（明确标注 M6）→ 已导出包列表。界面不绑定任何 AI 品牌，使用任意支持文件上传与结构化输出的 AI 服务。
5. **设置**：语言（含跟随系统与实际生效语言）、外观（三张预览卡）、存储模式、数据统计、关于。

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

YouTube 标签的可见状态（全部三语）：

| 状态 | 显示 | 用户可做什么 |
| --- | --- | --- |
| 官方未配置（默认） | 「尚未配置」胶囊 + 真实原因 + 说明官方需要开发者一次性配置 | 阅读说明；可显式点击「启用免登录实验模式」；不显示伪造的登录按钮 |
| 官方 API Key 模式 | 「公开直播模式：使用应用级 API Key 读取公开聊天，无需登录」 | 直接粘贴直播链接 |
| 官方 OAuth 未登录 | 「未登录」+「登录 Google / YouTube」+ 授权说明 | 点击登录，浏览器打开 Google 官方页 |
| 官方已登录 / 已失效 | 「已登录：频道名」或「授权已失效」+ 重新登录 / 退出 | 输入链接或重新授权 |
| 匿名实验模式 | 「实验性 · 免登录」+ warning callout + 无需 API Key / 无需 Google 登录 | 粘贴链接 → 检查 → 开始；可切回官方 |

- 匿名模式**不是默认**；必须由用户点击按钮或高级设置切换。界面必须同时显示：非官方接口、可能与 YouTube 服务条款冲突、可能随时失效、不保证可用。
- 匿名模式没有官方配额显示；显示消息数、连接状态与「可能漏消息」诊断。
- 检查结果用胶囊表达：正在直播（`live`）、尚未开始、已结束、非直播、聊天关闭；不可记录时说明原因，不显示开始按钮。
- 官方面板底部显示 API 配额（已用/上限）与数据保留说明（天数 + 「立即清理过期原文」）。
- 直播进行中，页面头部追加 YouTube 连接状态（已连接 / 网络中断重连 / 连接失败）、模式胶囊与「当前观看 N」（官方有数据时），10 秒轮询一次，不承担高频请求。
- 动态流显示平台确认的 badge 文本；没有 badge 不占位。

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
- `docs/screenshots/live-youtube-light-zh-CN.png`（1440×1120，YouTube 官方模式面板）
- `docs/screenshots/live-youtube-dark-zh-CN.png`（黑暗主题）
- `docs/screenshots/live-youtube-mobile-light-zh-CN.png`（390×1000，窄屏无横向溢出）
- `docs/screenshots/live-youtube-recording-zh-CN.png`（官方模式录制中）
- `docs/screenshots/live-youtube-unconfigured-zh-CN.png`（官方未配置状态）
- `docs/screenshots/live-youtube-anonymous-unconfigured-zh-CN.png`（默认官方未配置 + 实验模式入口）
- `docs/screenshots/live-youtube-anonymous-light-zh-CN.png`（实验模式 warning + 无需 Key + 链接输入）
- `docs/screenshots/live-youtube-anonymous-dark-zh-CN.png`（实验模式黑暗主题）
- `docs/screenshots/live-youtube-anonymous-recording-zh-CN.png`（真实匿名直播：聊天、badge、HKD Super Chat）
- `docs/screenshots/live-youtube-anonymous-mobile-zh-CN.png`（390×1200，真实匿名直播）
- `docs/screenshots/settings-youtube-anonymous-zh-CN.png`（设置页 YouTube 接入卡）

尚未在第二台 Windows 设备/真实控制台字体环境下验收。
