# LiveMemory 直播记忆

本地优先、不依赖 AI API 的直播记录与长期观众记忆系统，支持 **Bilibili Live** 与 **YouTube Live**（两者均已接入真实直播）。

Local-first livestream memory for Bilibili Live and YouTube Live. No cloud, no AI API keys, no account required.

---

## 简体中文

### 这是什么

LiveMemory 在你自己电脑上记录一场直播的聊天、礼物、醒目留言与大航海事件，按场次统计热度与收入，并为每一位观众建立以**平台稳定 ID** 为基础的长期档案。AI 分析通过「导出 AI 分析包 → 手动交给任意 AI 服务 → 导入结果」完成，软件本身不连接任何 AI 服务，也不绑定 AI 品牌。

### 现在能做什么（v0.9.0）

- **长期观众记忆（v0.9.0）**：每位「主播 × 观众」一份会持续更新的长期记忆；每条事实都记录来源场次、引用消息、时间、可信度（观众明确说过 / AI 推断 / 无法确认）与状态（当前 / 可能过时 / 矛盾 / 已替换 / 待确认）；「备考 → 考试结束」这类变化用状态替换保留历史，而不是覆盖
- **跨场次增量更新**：一键把已导入的单场 AI 分析合并进长期记忆（不调用 AI）；需要处理矛盾或近况变化时，导出「记忆更新包」交给任意 AI，导入 JSON 后先看到逐位观众的真实差异，再决定是否应用；重复导入不会重复应用，每次更新都是可回滚的新版本
- **观众档案标签页**：概览 / 长期记忆 / 互动历史 / 历史版本；可按需展开证据原文、确认或忽略推断、忘记单条、恢复旧版本、删除整位观众的长期记忆
- **记忆工作台**：`长期记忆` 页面四步完成「选择直播 → 本地合并 → 生成 AI 更新包 → 导入预览应用」，并显示最近任务、最近更新的观众与保留/清理说明
- 双击启动本地控制台，自动打开系统默认浏览器，数据保存在 `%LOCALAPPDATA%\LiveMemory\`
- 中文 / 日本語 / English 三语界面；语言切换同时放在**页面顶栏**（外观切换旁），三种语言名始终以各自语言显示，默认跟随系统、可手动覆盖并持久保存。**启动器控制台默认英文**，`--lang` 可覆盖，与网页语言互不影响
- **同时记录多场直播**：每个直播间独立标签、连接状态、统计与停止按钮；同一直播间重复启动被拒绝；一场失败/停止不影响其他场
- **直播记录标签页**：固定「＋ 新建记录」、可横向滚动的直播标签、连接中/记录中/重连中/已停止/连接失败；切换页面或刷新浏览器不停止后台采集
- **最活跃观众 Top 100**：按当前场次有效弹幕数排名，默认约 10 行可视、区域滚动查看最多 100 名；支持搜索、稳定同分排序、点击进入观众档案并保留主播上下文
- **Bilibili 下播自动结束（v0.8.1）**：平台直播状态与本地采集状态分开记录；通过 `LIVE`/`PREPARING` 与定期 `live_status` 查询确认下播，自动停止该场并冻结时长，其他直播间继续记录；超时/风控不会误判；历史列表与详情区分已下播、手动停止、采集中断与平台未知
- **直播历史场次管理**：在列表或详情页停止单场记录（不影响其他直播，也不代表平台直播结束）、归档/取消归档、永久删除；归档默认隐藏但可查看，重启保持
- **直播历史搜索与筛选**：按主播（名称或稳定 ID）、标题（中文/日文/英文/混合）或观众（稳定 ID、昵称、历史昵称）搜索；同名不同平台身份不合并；可叠加平台、状态、日期与归档筛选；结果说明匹配原因，并可查看该观众在本场的发言
- **永久删除更彻底**：事务删除该场消息、事件、经济支持、统计、观众参与、AI 包与导出文件；重建仍参与其他场次的观众/主播统计；只属于该场的观众会被清理；失败回滚，删除后搜索与观众档案无残留
- 数据存储位置可在设置页修改：迁移现有数据或创建新数据空间；迁移前校验、失败回滚、旧目录不自动删除；外接盘断开时不会创建空库
- 清空全部直播/观众数据或恢复出厂设置：二次确认 + `DELETE`/`RESET` 文字 + 记录中禁止 + 数据目录外的数据库快照
- **多主播观众档案**：同一平台账号保持一个稳定身份，但按主播分别保留发言、场次、经济支持与未来 AI 画像；观众页可切换主播范围、搜索、排序
- 跟随系统 / 明亮 / 黑暗三种主题，独立设计，切换不闪烁、不丢失内容
- 模拟直播：完整验证「事件 → SQLite → 统计 → 时间线 → 事件流」记录链路
- 直播记录、直播历史（含单场详情与热度曲线）、观众档案、AI 分析中心、设置五个页面
- **Bilibili 直播**：真实 WebSocket 弹幕、礼物、醒目留言、大航海、平台表情；扫码登录可选
- **YouTube 直播**：唯一入口是公开直播页面的网页聊天，无需 Google 登录、API Key、OAuth 或 Cookie；粘贴直播链接即可。支持多场并发、多币种分账与 30 天原文保留策略。该机制不是 YouTube 官方稳定 API，可能因平台变化失效
- 一键导出 `livememory-analysis-v1` 分析包（含聊天 JSONL、统计、观众上下文、平台表情字典、badge、三语 AI 分析指令与结果 Schema）
- **M6：完整 AI 文件往返**：选择直播 → 创建带提示词版本的分析任务 → 按消息边界自动分批导出 `.zip` → 复制三语提示词 → 交给任意 AI → 上传 JSON 或粘贴文本 → 预检查 → 确认导入 → 查看报告；软件不调用任何 AI API
- **严格校验与可追溯证据**：Schema 版本、场次/任务/批次/主播/观众稳定身份、时间窗口、消息引用全部校验；错误显示字段路径、原因与修改建议；证据点击展开真实原文，原文已清理时明确标为不可用
- **分批与汇总**：长直播拆成多批，乱序/重复/缺失批次可识别；全部分批导入后生成第二阶段汇总包，最终结果导入后任务才完成；部分结果不会被拼接成整场报告
- **分析报告**：直播摘要、话题时间线、情绪变化、争论热点、值得回看的候选片段、观众画像、提示词/结果版本与来源；明确说明只分析聊天与事件，没有视频/音频
- **版本与安全**：相同结果重复导入不重复统计；同任务不同结果需显式创建新版本并保留旧版本；AI 文本只按白名单存储、只以纯文本显示，不能修改事件、金额或设置
- 普通文字、Unicode Emoji 与平台表情正确保存；AI 包用文字名称/代码表达，不强制下载表情图片
- 单场直播的所有金额按币种和「实际支付 / 展示价值」分别精确累计，重复事件不会翻倍

![AI 分析中心：任务、批次包与提示词（明亮 / 英文）](docs/screenshots/ai-centre-complete-v080-light.png)

![直播分析报告：摘要、话题时间线与证据](docs/screenshots/ai-report-complete-v080-light.png)

![部分导入：不完整状态按批次展示](docs/screenshots/ai-report-partial-v080-light.png)

![黑暗主题 / 中文 / 390px 宽度下的分析报告](docs/screenshots/ai-report-dark-zh-390-v080.png)

![直播历史搜索与场次管理（明亮 / 英文）](docs/screenshots/history-list-v070-light-en.png)

![观众搜索：同名跨平台身份分别显示](docs/screenshots/history-search-viewer-v070-light-en.png)

![多直播标签与 Top 100（明亮 / 中文）](docs/screenshots/live-multi-tabs-v060-light-zh-CN.png)

![新建记录视图（后台仍有 3 场）](docs/screenshots/live-multi-new-v060-light-zh-CN.png)

![Header 语言切换（中文）](docs/screenshots/header-language-zh-CN.png)

![多主播观众档案（同一观众分别统计）](docs/screenshots/viewer-detail-two-broadcasters-zh-CN.png)

![数据存储位置与迁移](docs/screenshots/settings-data-location-after-move-zh-CN.png)

![清空数据确认](docs/screenshots/settings-clear-dialog-zh-CN.png)

![YouTube 单一公开网页入口（明亮 / 中文）](docs/screenshots/live-youtube-v050-light-zh-CN.png)

![设置中的 YouTube 接入说明（无需登录/Key/Cookie）](docs/screenshots/settings-youtube-v050-zh-CN.png)

![设置（黑暗 / 日本語）](docs/screenshots/settings-dark-ja.png)

### 尚未完成

真实 AI 服务的文件往返样本（本轮只验证了符合 Schema 的合成结果）、可迁移备份（`.livememory`）、长期 AI 画像的保留与去标识化、运行中标签的“隐藏但继续记录”交互、10+ 场长时间压力测试、正式发布版 EXE 的干净环境验收仍未完成。本轮历史与 AI 功能没有新增真实平台网络采集；v0.6.0 的真实双场/三场并发结果仍为历史样本。YouTube 公开网页路径不是官方稳定 API，条款合规性仍未确认。请以 [docs/STATUS.md](docs/STATUS.md) 与 [docs/YOUTUBE_ANONYMOUS_RESEARCH.md](docs/YOUTUBE_ANONYMOUS_RESEARCH.md) 为准。

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

- **長期メモリ（v0.9.0）**: 「配信者 × 視聴者」ごとに 1 つの長期メモリ。各事実は出典の配信・引用メッセージ・時刻・確度（本人が明言 / AI の推測 / 未確認）と状態（現在 / 古い可能性 / 矛盾 / 置換済み / 確認待ち）を持ちます。「試験勉強中 → 試験終了」のような変化は置換として履歴を残し、上書きしません
- **配信をまたぐ差分更新**: 取り込み済みの配信分析をワンクリックで長期メモリへ統合（AI 不使用）。矛盾や近況の変化を扱うときは「メモリ更新パッケージ」を書き出して任意の AI に渡し、返った JSON を取り込むと、適用前に視聴者ごとの実際の差分が表示されます。同じ結果の再取り込みは適用されず、更新はすべて新バージョンとして復元できます
- **視聴者プロフィールのタブ**: 概要 / 長期メモリ / 交流履歴 / バージョン。根拠の原文を開く、推測を確認/無視する、1 件を忘れる、以前のバージョンへ戻す、視聴者 1 人の長期メモリを削除する、が可能です
- **メモリのワークスペース**: 「長期メモリ」ページで「配信選択 → ローカル統合 → AI 更新パッケージ作成 → 取り込みプレビューと適用」の 4 段階。最近のジョブ、最近更新した視聴者、保存とクリーンアップの説明も表示します
- 対応 UI / コンソール: 简体中文・日本語・English（システム言語に追従、手動変更は保存されます）。起動コンソールは既定で英語、`--lang` で切り替え可能
- **複数配信の同時記録**: 配信ごとに独立したタブ・接続状態・統計・停止操作。同じ配信ルームの重複起動は拒否され、1 件の失敗/停止は他に影響しません
- **ライブ記録タブ**: 固定の「新規記録」と横スクロール可能な配信タブ。接続中/記録中/再接続中/停止済み/接続失敗を表示。ページ移動や再読み込みでもバックグラウンド記録は継続します
- **今の配信のトップ 100 視聴者**: 有効なチャット数順、約 10 行表示＋スクロールで最大 100 名、検索・安定した同順位ソート・配信者コンテキスト付きプロフィール遷移
- **配信履歴の管理**: 一覧/詳細から1配信だけ停止（他は継続、プラットフォーム配信の終了ではありません）、アーカイブ/解除、完全削除。アーカイブは既定で非表示ですが表示切替でき、再起動後も維持
- **配信履歴の検索・絞り込み**: 配信者（名前/安定 ID）、タイトル（中・日・英・混在）、視聴者（安定 ID/ニックネーム/過去のニックネーム）。同名でもプラットフォーム/ID が違えば別身份のまま。プラットフォーム・状態・日付・アーカイブ条件を組み合わせ可能。一致理由を表示し、その視聴者のこの配信での発言も確認できます
- **完全削除**: トランザクションでメッセージ・イベント・支援・統計・視聴者参加・AI パッケージ/ファイルを削除し、他の配信にも参加する視聴者/配信者の集計を再計算。その配信だけの視聴者は削除。失敗時はロールバックし、検索や視聴者プロフィールに残りません
- テーマ: システムに従う / ライト / ダーク（個別設計・再起動後も維持）
- 対応: 起動・設定・模擬配信の記録・履歴・視聴者一覧・AI 分析パッケージ出力・Bilibili 実配信（チャット/絵文字）・YouTube 実配信（Super Chat / Super Sticker / メンバー / 多通貨）
- YouTube は公開ライブページの Web チャットのみを使用します。Google ログイン、API キー、OAuth、Cookie は不要です。この仕組みは YouTube の公式で安定した API ではなく、プラットフォームの変更により利用できなくなる可能性があります。設定/プライバシー説明にのみ短く記載し、接続のたびにモード警告を出しません
- チャット本文・絵文字/バッジ・金額表示・古いニックネームは YouTube のポリシーに合わせて既定 30 日で削除し、統計・安定した Channel ID・金額合計は保持します（完全な個人データ削除ではありません）
- AI 分析は「パッケージ出力 → 任意の AI に手動で渡す → JSON を取り込む」方式です。M6 で **メッセージ境界の自動分割、三言語プロンプト（バージョン記録）、JSON ファイル/貼り付け取り込み、厳格な Schema・場面・配信者・視聴者・時刻・メッセージ参照検証、重複取り込み防止、結果バージョン、第 2 段階の統合パッケージ、分析レポート**を実装しました。ソフトが AI API を呼ぶことはありません
- **分析レポート**: 配信要約、話題タイムライン、感情の変化、論争、見返し候補、視聴者プロフィール、プロンプト/結果バージョンと出所。根拠は実際のメッセージに解決され、原文が保持期間で消えている場合は「利用不可」と明示します。映像・音声は分析していないことも明記します
- AI 結果は外部入力として扱い、HTML/スクリプトを実行せず、金額・件数・設定を変更できません。同一結果の再取り込みは重複として扱い、異なる結果は明示的に新しいバージョンとして追加します
- AI 结果の長期保存（視聴者プロフィールを含む）は v0.9.0 の長期メモリで扱います。ただし YouTube の 30 日クリーンアップ後は根拠が「原文削除済み」となり、メモリ自体は残ります。プラットフォームポリシーへの完全準拠を主張してはいけません
- ポータブルバックアップは今後実装予定

開発時は Node.js 22.5 以降が必要です（SQLite は実行環境に内蔵）。詳細は [docs/STATUS.md](docs/STATUS.md) と [docs/WINDOWS_RUNTIME.md](docs/WINDOWS_RUNTIME.md) を参照してください。

---

## English

LiveMemory records chat, gifts, Super Chats and membership events **on your own computer**, and builds long-term viewer profiles keyed by stable platform IDs. AI analysis is a manual round trip: export an AI analysis package, give it to any AI service you choose, import the result. No cloud service, no API key, no vendor account.

Current build (v0.8.1) delivers the Windows administrator-manifest launcher, tri-language Apple-style console with a header language switch, theme system, persistent settings, a simulated recording pipeline backed by SQLite, **concurrent recording of multiple Bilibili/YouTube broadcasts with browser-style tabs and per-stream state**, **Bilibili platform-live detection with automatic stop on `PREPARING`/`live_status` confirmation while other broadcasts keep recording**, **a scrollable Top 100 current-session leaderboard with search and broadcaster-aware viewer links**, **per-broadcast stop / archive / permanent delete managed from one shared implementation**, **history search by broadcaster, title or viewer with platform/status/date/archive filters and match reasons**, real Bilibili chat with Unicode emoji and platform emotes, and **one** YouTube path: the public live web chat, with no Google login, API key, OAuth or cookie. That mechanism is not an official stable API and may stop working; the UI explains it once in settings/privacy instead of showing a mode selector on every connection. All platforms feed one canonical pipeline, per-currency totals, a 30-day retention policy, session history, viewer profiles and AI-package export. **M6 adds the complete manual AI round trip**: a versioned analysis task, automatic message-boundary batching, localized versioned prompts, JSON file or paste import, strict schema/session/task/batch/broadcaster/viewer/time/evidence validation, duplicate and explicit result versioning, a stage-2 aggregate package for long streams, and a traceable live analysis report. LiveMemory never calls an AI API. Deleting one session runs in a single transaction, removes its AI tasks/results/evidence and packages, and recomputes the remaining viewer/broadcaster aggregates. A stable platform account can appear for multiple broadcasters while its interaction context stays per broadcaster (schema v9). The data folder can be moved with verification and rollback, and users can clear recorded data or restore factory settings with confirmation and an off-folder database snapshot. The launcher console defaults to English while the web UI keeps all three languages (`--lang` overrides the console only). Real-AI end-to-end samples and portable backup remain future work — see [docs/STATUS.md](docs/STATUS.md).

**M7 (v0.9.0) adds long-term viewer memory**: one memory per broadcaster × viewer, holding atomic facts with source session, quoted message, timestamp, certainty (stated / inferred / uncertain) and status (current / possibly outdated / contradicted / superseded / needs confirmation). A state change such as "preparing for an exam" → "the exam is over" is stored as a supersede with history instead of overwriting. Updates can be merged locally from an already-imported session analysis (no AI at all) or through a versioned memory update package (`livememory-memory-update-v1`) that any AI can answer; the app validates viewer ids, quoted messages, target facts and schema before showing the exact per-viewer diff, then applies it as a new version in one transaction. Re-importing the same answer changes nothing, every update can be rolled back, a human can confirm or forget a single fact, and deleting one viewer's memory blocks older packages from restoring it. Viewer profiles now have Overview / Long-term memory / Interaction history / Versions tabs, and a Memory workspace walks through the whole round trip.

Streamers never create an API key, OAuth client or Google Cloud project. The public-web path was re-validated in v0.6.0 with real concurrent captures (two YouTube broadcasts, YouTube + Bilibili, three streams, and the built EXE attached to the same three streams). Its terms compliance remains unconfirmed (see [docs/STATUS.md](docs/STATUS.md) and [docs/YOUTUBE_ANONYMOUS_RESEARCH.md](docs/YOUTUBE_ANONYMOUS_RESEARCH.md)).

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
