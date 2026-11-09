# LiveMemory 直播记忆

本地优先、不依赖 AI API 的直播记录与长期观众记忆系统，支持 **Bilibili Live** 与 **YouTube Live**（两者均已接入真实直播）。

Local-first livestream memory for Bilibili Live and YouTube Live. No cloud, no AI API keys, no account required.

---

## 简体中文

### 这是什么

LiveMemory 在你自己电脑上记录一场直播的聊天、礼物、醒目留言与大航海事件，按场次统计热度与收入，并为每一位观众建立以**平台稳定 ID** 为基础的长期档案。AI 分析通过「导出 AI 分析包 → 手动交给任意 AI 服务 → 导入结果」完成，软件本身不连接任何 AI 服务，也不绑定 AI 品牌。

### 现在能做什么（v0.5.0）

- 双击启动本地控制台，自动打开系统默认浏览器，数据保存在 `%LOCALAPPDATA%\LiveMemory\`
- 中文 / 日本語 / English 三语界面与命令行；语言切换同时放在**页面顶栏**（外观切换旁），三种语言名始终以各自语言显示，默认跟随系统、可手动覆盖并持久保存
- 数据存储位置可在设置页修改：迁移现有数据或创建新数据空间；迁移前校验、失败回滚、旧目录不自动删除；外接盘断开时不会创建空库
- 清空全部直播/观众数据或恢复出厂设置：二次确认 + `DELETE`/`RESET` 文字 + 记录中禁止 + 数据目录外的数据库快照
- **多主播观众档案**：同一平台账号保持一个稳定身份，但按主播分别保留发言、场次、经济支持与未来 AI 画像；观众页可切换主播范围、搜索、排序
- 跟随系统 / 明亮 / 黑暗三种主题，独立设计，切换不闪烁、不丢失内容
- 模拟直播：完整验证「事件 → SQLite → 统计 → 时间线 → 事件流」记录链路
- 直播记录、直播历史（含单场详情与热度曲线）、观众档案、AI 分析中心、设置五个页面
- **Bilibili 直播**：真实 WebSocket 弹幕、礼物、醒目留言、大航海、平台表情；扫码登录可选
- **YouTube 直播**：唯一入口是公开直播页面的网页聊天，无需 Google 登录、API Key、OAuth 或 Cookie；粘贴直播链接即可。该机制不是 YouTube 官方稳定 API，可能因平台变化失效；界面只在设置/隐私说明中简短告知，不在每次连接时堆叠模式警告。支持多币种分账与 30 天原文保留策略
- 一键导出 `livememory-analysis-v1` 分析包（含聊天 JSONL、统计、观众上下文、平台表情字典、badge、三语 AI 分析指令与结果 Schema）
- 普通文字、Unicode Emoji 与平台表情正确保存；AI 包用文字名称/代码表达，不强制下载表情图片
- 单场直播的所有金额按币种和「实际支付 / 展示价值」分别精确累计，重复事件不会翻倍

![Header 语言切换（中文）](docs/screenshots/header-language-zh-CN.png)

![多主播观众档案（同一观众分别统计）](docs/screenshots/viewer-detail-two-broadcasters-zh-CN.png)

![数据存储位置与迁移](docs/screenshots/settings-data-location-after-move-zh-CN.png)

![清空数据确认](docs/screenshots/settings-clear-dialog-zh-CN.png)

![YouTube 单一公开网页入口（明亮 / 中文）](docs/screenshots/live-youtube-v050-light-zh-CN.png)

![设置中的 YouTube 接入说明（无需登录/Key/Cookie）](docs/screenshots/settings-youtube-v050-zh-CN.png)

![设置（黑暗 / 日本語）](docs/screenshots/settings-dark-ja.png)

### 尚未完成

AI 结果导入与校验、可迁移备份（`.livememory`）、AI 长期画像、正式发布版 EXE 的干净环境验收仍未完成。YouTube 官方 Data API/OAuth 已在 v0.5.0 删除；唯一公开网页路径此前有两个真实 35 秒样本，但 **v0.5.0 简化后尚未重新采样**，且条款合规性未确认。请以 [docs/STATUS.md](docs/STATUS.md) 与 [docs/YOUTUBE_ANONYMOUS_RESEARCH.md](docs/YOUTUBE_ANONYMOUS_RESEARCH.md) 为准。

### YouTube 接入说明

- **不需要** Google 登录、API Key、OAuth 客户端或 Cookie；粘贴正在直播的 YouTube 链接即可。
- v0.5.0 已删除官方 Data API/OAuth/API Key 双轨实现，只保留公开直播页面的网页聊天。
- 该机制不是 YouTube 官方提供的稳定 API，未来可能失效；LiveMemory 不声称获得 YouTube 授权，也不保证永久可用。
- 不绕过登录、验证码、年龄墙或地区限制；失败时显示真实原因。
- YouTube 数据默认 30 天后清理聊天原文、emote/badge 元数据、金额显示文本与过期昵称；保留统计、稳定 Channel ID 与金额合计，但这不等同于完全删除个人数据（上限 30 天）。

### 开发运行

需要 Node.js **22.5 或更高**（内置 SQLite）。项目运行时零依赖，无需 `npm install`。

```bat
start.cmd
:: 或者
node src/launcher/launcher.mjs
```

常用参数：

```text
--no-open            启动后不自动打开浏览器
--port <端口>        指定本地端口（默认 47800，占用时自动顺延）
--data-dir <路径>    指定用户数据目录
--forget-data-location  清除已保存的数据目录位置记录，回到默认目录
--lang <语言>        zh-CN | ja | en
--version / --help
```

运行测试：

```bat
node --test tests/unit tests/integration
```

> 在受限环境（禁止子进程）中可使用单进程模式：
> `node --test --test-isolation=none "tests/**/*.test.mjs"`

### 打包 Windows EXE

```bat
node scripts/build-windows.mjs
```

产物为 `dist/LiveMemory.exe`。使用 Node 官方运行时 + SEA 注入，内置 `node:sqlite`，无需在用户机器上编译原生模块。

### 数据与隐私

- 只监听 `127.0.0.1`，端口动态选择，不暴露公网
- 不写入注册表、不写 `Program Files`；发布 EXE 通过 Manifest 请求管理员权限（UAC），开发模式 `node` 启动不需要管理员
- 日志不记录 Cookie、Token、聊天正文；备份默认不包含任何登录凭据
- 关闭控制台窗口应使用 Ctrl+C，程序会刷新数据并关闭数据库

---

## 日本語

LiveMemory は、配信のチャット・ギフト・スーパーチャット・ギャラリーを**自分の PC 上**に記録し、視聴者ごとの長期プロフィールを作るローカル優先のツールです。AI 分析は「AI 分析パッケージ出力 → 任意の AI サービスに手動で渡す → 結果を取り込む」方式で、クラウドや API キーは使わず、特定の AI ブランドにも依存しません。

- 対応 UI / コンソール: 简体中文・日本語・English（システム言語に追従、手動変更は保存されます）
- テーマ: システムに従う / ライト / ダーク（個別設計・再起動後も維持）
- 対応: 起動・設定・模擬配信の記録・履歴・視聴者一覧・AI 分析パッケージ出力・Bilibili 実配信（チャット/絵文字）・YouTube 実配信（Super Chat / Super Sticker / メンバー / 多通貨）
- YouTube は公開ライブページの Web チャットのみを使用します。Google ログイン、API キー、OAuth、Cookie は不要です。この仕組みは YouTube の公式で安定した API ではなく、プラットフォームの変更により利用できなくなる可能性があります。設定/プライバシー説明にのみ短く記載し、接続のたびにモード警告を出しません
- チャット本文・絵文字/バッジ・金額表示・古いニックネームは YouTube のポリシーに合わせて既定 30 日で削除し、統計・安定した Channel ID・金額合計は保持します（完全な個人データ削除ではありません）
- AI 結果の取り込み、ポータブルバックアップは今後実装予定

開発時は Node.js 22.5 以降が必要です（SQLite は実行環境に内蔵）。詳細は [docs/STATUS.md](docs/STATUS.md) と [docs/WINDOWS_RUNTIME.md](docs/WINDOWS_RUNTIME.md) を参照してください。

---

## English

LiveMemory records chat, gifts, Super Chats and membership events **on your own computer**, and builds long-term viewer profiles keyed by stable platform IDs. AI analysis is a manual round trip: export an AI analysis package, give it to any AI service you choose, import the result. No cloud service, no API key, no vendor account.

Current build (v0.5.0) delivers the Windows administrator-manifest launcher, tri-language Apple-style console with a header language switch, theme system, persistent settings, a simulated recording pipeline backed by SQLite, real Bilibili chat with Unicode emoji and platform emotes, and **one** YouTube path: the public live web chat, with no Google login, API key, OAuth or cookie. That mechanism is not an official stable API and may stop working; the UI explains it once in settings/privacy instead of showing a mode selector on every connection. All platforms feed one canonical pipeline, per-currency totals, a 30-day retention policy, session history, viewer profiles and AI-package export. A stable platform account can appear for multiple broadcasters while its interaction context stays per broadcaster (schema v5). The data folder can be moved with verification and rollback, and users can clear recorded data or restore factory settings with confirmation and an off-folder database snapshot. AI result import and portable backup are scheduled for later milestones — see [docs/STATUS.md](docs/STATUS.md).

Streamers never create an API key, OAuth client or Google Cloud project. The public-web path was sampled on two real broadcasts in v0.3.0, but the v0.5.0 simplification has not yet been re-sampled and its terms compliance is unconfirmed (see [docs/STATUS.md](docs/STATUS.md) and [docs/YOUTUBE_ANONYMOUS_RESEARCH.md](docs/YOUTUBE_ANONYMOUS_RESEARCH.md)).

```bat
start.cmd            :: development
node scripts/build-windows.mjs   :: LiveMemory.exe
```

Node.js 22.5+ is required for development runs. There are no runtime dependencies.

---

## 文档 / Documents

| 文档 | 内容 |
| --- | --- |
| [AGENTS.md](AGENTS.md) | 开发规则：每轮必读、命令、提交约定 |
| [docs/PRODUCT.md](docs/PRODUCT.md) | 产品定位与验收标准 |
| [docs/STATUS.md](docs/STATUS.md) | 真实工程状态（唯一进度来源） |
| [docs/HANDOFF.md](docs/HANDOFF.md) | 跨对话交接 |
| [docs/ROADMAP.md](docs/ROADMAP.md) | M0–M8 里程碑 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 模块边界与数据流 |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | 数据库、身份、金额、生命周期 |
| [docs/AI_CONTRACT.md](docs/AI_CONTRACT.md) | 分析包与结果 Schema 协议 |
| [docs/PLATFORM_INTEGRATIONS.md](docs/PLATFORM_INTEGRATIONS.md) | 平台接入现状与限制 |
| [docs/YOUTUBE_ANONYMOUS_RESEARCH.md](docs/YOUTUBE_ANONYMOUS_RESEARCH.md) | 开源方案、许可证、真实采样与条款风险 |
| [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md) | 备份格式与恢复流程 |
| [docs/WINDOWS_RUNTIME.md](docs/WINDOWS_RUNTIME.md) | EXE、启动器、权限、单实例 |
| [docs/UI_DESIGN.md](docs/UI_DESIGN.md) | 视觉规范、主题、响应式、多语言 |
| [docs/PRIVACY_SECURITY.md](docs/PRIVACY_SECURITY.md) | 本地监听、凭据、导入安全 |
| [docs/TEST_PLAN.md](docs/TEST_PLAN.md) | 测试策略与验收记录 |
| [docs/DECISIONS.md](docs/DECISIONS.md) | ADR |
| [docs/RELEASE.md](docs/RELEASE.md) | 打包与发布流程 |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | 版本变化 |

## License

MIT © 2026 zgrg29
