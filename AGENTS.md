# LiveMemory 工程规则（AGENTS.md）

本文件是仓库的工程入口。**每轮开发开始时必须首先阅读本文件**，再按顺序阅读状态文档。

---

## 1. 项目目标

LiveMemory 是面向普通主播的 **Windows 本地软件**：本地优先、免费、不需要开发者维护服务器。观众数据保存在用户自己的电脑上；AI 分析只由本地程序使用**用户自己配置的 API Key** 调用 Provider，不经过开发者服务器。

**当前版本、已发布平台、预览平台、未完成项与下一步，以 `docs/STATUS.md` §0 为唯一权威来源；平台字段与限制以 `docs/PLATFORM_INTEGRATIONS.md` §0 及对应章节为准。** 本文件不重复维护会随版本变化的具体数量与发布状态。

当前发布形态为 `LiveMemory.exe`，用户不应需要安装 Python、Node.js、npm 或数据库。快手（Kuaishou）是**预览接入**：组件可能已发布，但实时 H5 采集默认禁用；未取得书面许可前不开放采集，不得把它描述为“已正式支持”，公开版本也不得把采集标记为可用。

---

## 2. 每轮开始：强制阅读顺序

1. `AGENTS.md`（本文件）
2. `docs/STATUS.md`（真实状态，唯一进度来源）
3. `docs/HANDOFF.md`（上一轮交接）
4. `docs/ROADMAP.md`（当前里程碑）
5. 本轮相关文档：
   - UI → `docs/UI_DESIGN.md`
   - Windows 启动 / EXE → `docs/WINDOWS_RUNTIME.md`
   - 数据库 / 备份 → `docs/DATA_MODEL.md`、`docs/BACKUP_RESTORE.md`、`docs/BACKUP_FORMAT.md`、`docs/PRIVACY_SECURITY.md`
   - AI 文件协议 → `docs/AI_CONTRACT.md`
   - 平台接入（六个已发布 + 快手预览）→ `docs/PLATFORM_INTEGRATIONS.md`
   - **新增直播平台 → `docs/PLATFORM_ADMISSION.md`（准入与验收门禁，必读）+ `docs/PLATFORM_EXPANSION_RESEARCH.md`（候选调查记录）**
   - **语言 / 翻译 / AI 输出语言 → `docs/I18N.md`（三层语言模型与十语言规划，必读）**
   - **发布 / 版本 → `docs/RELEASE.md`（流程）+ `docs/RELEASE_HISTORY.md`（历史证据）+ `docs/CHANGELOG.md`**
6. 检查实际代码与 `git status`，核对文档与代码是否一致。

**不能只依据旧聊天记录判断项目状态。**

### 2.1 文档职责（每种信息只有一个权威来源）

| 文件 | 职责 | 不应用于 |
| --- | --- | --- |
| `README.md` | 面向用户的项目首页：产品价值、功能、平台状态、下载、快速开始、AI/隐私、FAQ | 记录内部算法、历史修复流水、发布证据 |
| `AGENTS.md` | 工程规则、架构约束、开发入口、每轮阅读顺序 | 维护当前版本号/平台数量/进度 |
| `docs/STATUS.md` | 当前真实工程状态、版本快照、未完成项（唯一进度来源） | 存放完整历史测试流水 |
| `docs/HANDOFF.md` | 最近一次开发交接 | 代替 STATUS 的完整状态 |
| `docs/ROADMAP.md` | 当前阶段与未来计划 | 作为发布日志或历史全量归档 |
| `docs/CHANGELOG.md` | 逐版本功能变化 | 描述当前状态 |
| `docs/RELEASE.md` | 稳定、可重复执行的发布流程 | 归档各版本 Tag/资产/哈希 |
| `docs/RELEASE_HISTORY.md` | 已发生发布的证据归档 | 约束未来发布的规则 |
| `docs/PLATFORM_INTEGRATIONS.md` | 平台协议、字段、验证边界（平台字段权威） | 宣传“已支持” |
| `docs/I18N.md` | 三层语言模型、语言门禁 | 重复维护语言清单（清单在 `src/shared/locales.mjs`） |
| `docs/*` 专题文档 | 架构、数据、AI、备份、Windows、隐私等详细规则 | 与 README 竞争产品首页 |

**新增文档前先检查能否复用现有文档；不要为拆分制造重复文件。**

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
src/launcher/        启动器：参数、数据目录、单实例、浏览器、命令行多语言、退出
src/server/          HTTP 服务、路由、设置存储、日志、SSE
src/platforms/       平台适配器（六个已发布平台：bilibili、youtube/anonymous、twitch、douyin、tiktok、kick；kuaishou 为预览，采集默认禁用；mock 仅测试夹具）
  shared/            adapter 契约、ingest 写入管线、session manager、凭据存储（Windows Credential Manager + 旧 AES 凭据迁移）
src/storage/         database（连接/迁移）、repositories（SQL 访问）
src/analytics/       sessions（时间线/汇总）、payments（币种合计）、viewers（画像读模型）
src/ai/              export（分析包）、prompts（分语言说明与输出语言规则）、schemas（结果 JSON Schema）
src/web/             index.html、js/（app、pages、i18n、chart、theme）、styles/、i18n/*.json
src/shared/          跨层纯逻辑：事件模型、Emoji/表情、文本安全截断、金额、语言、主题、时间、zip、错误
tests/               unit / integration / helpers / fixtures
scripts/             构建 EXE、SEA bootstrap、UI 截图、冒烟脚本
docs/                产品、状态、架构、协议、发布等文档（含 I18N.md 与 PLATFORM_ADMISSION.md）
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
9. **文本优先**：聊天原文 `content` 永不替换；Unicode Emoji 原样保存。平台表情只在有可靠元数据时写入 `emotes`，保留平台提供的名称/代码；没有名称就保留 id 并标记未知。不要为还原表情图片引入下载/缓存，也不要猜测未知表情的情绪。
10. **AI 平台无关、自备密钥**：界面与提示词使用「AI 分析中心 / AI 分析 / 观众长期画像」，不得绑定某个 AI 品牌。只支持用户自备 API Key 的 Provider（OpenAI、Anthropic、DeepSeek、MiniMax、阿里云百炼、OpenRouter、自定义 OpenAI-compatible）；不得重新引入匿名免费 AI、手动复制提示词或粘贴/上传 JSON 的用户入口。API Key 只存 **Windows Credential Manager**（DPAPI，按当前 Windows 用户 SID 隔离），不进入配置 JSON、日志、ZIP、数据库导出或 HTML；旧 `secrets/ai-keys.json` 只作为迁移来源/加密只读回退，不得再写入新 Key。不得改用命令行参数、环境变量、临时明文文件或明文回退传递 Key。
11. **只接直播**：平台 URL/ID 只用于定位正在进行的直播。不得抓取普通视频、视频评论、字幕或历史回放；非直播输入必须明确拒绝。
12. **平台接入边界（v0.5.0 产品决定）**：Bilibili 继续使用其公开直播接口。YouTube **只保留** `src/platforms/youtube/anonymous/` 的公开网页聊天路径，不再提供官方 Data API/OAuth/API Key 实现。该路径必须同时满足：不发送 Cookie/OAuth/用户 API Key；不绕过登录、验证码、年龄墙、地区限制；失败不静默切换、不伪造成功；界面不反复展示技术模式选择，但在设置/隐私说明中如实告知它不是 YouTube 官方稳定 API、可能失效；不得描述为“官方授权”或“合规”。`liveChatMessages.streamList` 是 gRPC，REST 路径不存在，不得臆造。

    **TikTok（TIKTOK-M5 产品决定，2026-11-16 用户明确授权）**：唯一采集路径是匿名本地 webcast WebSocket（`src/platforms/tiktok/webcast.mjs`）。使用 TikTok 非公开 web 协议的前提与边界必须同时成立：
    - 只使用任何访客都会获得的匿名 `ttwid` 设备 Cookie；**不需要账号、不需要扫码登录、不需要导入 Cookie、不需要浏览器中继、不依赖付费或免费第三方签名服务**。不得恢复 TikTok 扫码登录、登录状态 UI 或专用浏览器 Profile。
    - **不得绕过访问控制**：不破解验证码、不伪造登录态、不规避地区/年龄/权限限制。若平台明确拒绝访问（例如 WebSocket 被一致拒绝或要求人机验证），必须停止该路径并如实报告，不得尝试规避。
    - 不得描述为 TikTok 官方 API、官方授权或“合规”；界面与文档必须标注「非官方协议 / 实验性」。
    - 没有续传游标：重连期间可能漏消息，不得声称弹幕完整；礼物是否观测到以每次运行的真实证据为准，未观测到必须标 `NOT-OBSERVED`。
    - 旧版本遗留的 TikTok 专用浏览器 Profile 只能通过 `legacy-cleanup.mjs` 清理：仅删除带 `.livememory-owned` 标记的目录与 LiveMemory 自己的 `login-state.json`，绝不触碰 Chrome/Edge 日常资料。
13. **凭据不进仓库**：任何 API Key、OAuth client secret、access/refresh token 都不得提交，也不得默认打进 EXE。凭据由发布者通过环境变量或数据目录私有文件一次性配置；缺少配置时必须明确提示，不得伪造登录或成功。
14. **数据保留合规**：YouTube 公开聊天属于平台数据；超过保留窗口（默认/上限 30 天）必须清理原文、emote/badge 元数据与过期昵称。即使 v0.5.0 不再使用 OAuth/官方 API，也采用同样的 30 天上限，不得认为“免登录/非 API”就可以无限保存。保留计数、稳定 ID 与金额合计，但这不等同于完全删除个人数据，文档必须如实说明。
15. **多直播隔离（v0.6.0）**：允许多场同时记录；每场必须有独立 adapter、连接状态、session、事件闭包与停止操作。同一 `platform + room` 不得重复启动。所有事件仍只经 `EventIngest`，去重键限定在 `session_id` 内；不得用全局单例 adapter/全局唯一“当前场次”实现多场。前端切换标签不得停止后台采集，旧页面异步响应不得覆盖新标签。
16. **国际化三层分离（2026-11-16 制定，长期约束）**：详见 `docs/I18N.md`。
    - **软件界面语言**（L1）与 **AI 分析输出语言**（L2）**必须互相独立**：允许「韩语界面 + 日语报告」。L2 必须是独立持久偏好（`follow-ui` 或具体语言码），不得只把界面语言当默认值。
    - **任务语言快照不可变**：L2 在任务创建时写入任务行（`ai_jobs.locale` / 记忆任务 `locale`）；暂停、继续、重启、升级、切换界面语言都不得改变该任务语言，也不得重写已保存结果的正文。历史报告只能通过「翻译缓存」按需切换**阅读语言**，原文永久保留。
    - **原始弹幕永不翻译覆盖**：`events.content` 永远是平台原文。AI 必须能直接理解中文/日文/韩文/英文/混合语聊天，不得先把原文替换成译文再分析；平台表情标记（如 `[emote:id:name]`）保留原始字符串并解析进 `emotes`，不得改写成纯文本。
    - **语言清单只有一处来源**：`src/shared/locales.mjs`（Node 与浏览器同一模块）。受支持语言集合、原生语言名、AI 提示词语言表、翻译目标语言表必须由该清单驱动；不得在多处硬编码三语或任何固定语言数量。JSON Schema 的 `locale.enum` 是协议镜像，由测试强制同步。新增语言必须同时满足：字典键集与占位符 100% 一致、无空串、无残留英文整句、逐语言 UI/EXE 验收。
    - **新增语言设置键必须同步备份白名单**（`src/server/backup/settings.mjs`），否则备份/恢复会静默丢失。
    - 语言码使用 BCP-47（`zh-CN` / `zh-TW` / `pt-BR` / `id` …），归一化必须按**可用集合逐级降级**，不得因目标字典未就绪而白屏。
17. **新平台三准入条件（2026-11-16 制定，长期约束）**：详见 `docs/PLATFORM_ADMISSION.md`。新增任何直播平台必须**同时**满足：
    - **条件一 免登录优先**：普通用户只填公开直播间链接/房间号/主播用户名即可采集；不得要求用户申请开发者 API、配置密钥、购买采集服务或签付费协议。免登明确不可行时才评估二维码登录或官方授权，且不得绕过访问控制、验证码或平台安全机制。
    - **条件二 必须有用户名**：每条聊天消息必须能关联平台实际展示的用户名或昵称；尽量取到稳定用户 ID（`platform:stable_uid`）。只能取昵称时必须评估改名/重名/误判风险，**不得用昵称或昵称 hash 伪造稳定身份**。
    - **条件三 必须能实时取得公开聊天**：并尽量保留内容、用户名、稳定 ID、时间、消息 ID、平台与直播间标识；必须调查断线重连、去重与多直播间并行。
    - **礼物是可选增强**：缺少礼物数据**不得**否决一个能满足「用户名 + 实时聊天」的平台；金额未知时 `amount_minor=null`、`value_kind=unknown`，不得换算收入。
    - **门禁**：必须顺序通过 G0 调查 → G1 免登录可行性 → G2 字段验证 → G3 身份评估 → G4 重连/多房间 → G5 真实 EXE 验收 → G6 合并判断；G0 不通过不得写代码。命中暂停条件时允许暂停并继续调查后续候选，**不得为增加平台数量而降低标准**。
    - **开源组件**：优先使用持续维护、许可证兼容的公开实现；MIT/Apache/BSD 必须保留声明，AGPL 必须明确义务并记录到 `THIRD_PARTY_NOTICES.md`，**不得直接复制不兼容代码**；不得引入运行时 `npm` 依赖；不得依赖付费采集服务。

18. **长期记忆乱序兼容（2026-11-24 产品决定）**：必须支持任意分析顺序及历史补录，以真实事实观察时间、证据强度和事实性质合并；不得恢复“较新场次已分析就拒绝旧场次”的规则。旧信息可补充历史，不能无条件覆盖可靠的新状态；未知时间不能用当前时间填补。重复证据不得增加可信度，事务内必须重读并合并实时事实。同主播 gate 只作并发保护，不作时间顺序门禁。已保存单场报告及其翻译不得因记忆更新失败而失效；恢复只执行缺失阶段，不自动付费重跑全部历史。详见 `docs/AI_CONTRACT.md` 最新修订。

---

## 7. UI 规范（必须遵守）

- 视觉语言参考 Apple 官网：克制、留白、层级清晰、精致排版、柔和边框/阴影、少量强调色。
- 颜色、间距、圆角、阴影全部通过 `src/web/styles/tokens.css` 的 CSS 变量使用，不得在组件里写死颜色。
- 明亮与黑暗**分别设计**，不能简单反转。
- 首次渲染不得出现主题闪烁：`data-theme` 由 `js/theme-boot.js` 在样式表之前设置。
- 全部界面文案放在 `src/web/i18n/*.json`，使用 `t('key', {params})`；禁止在页面中硬编码用户可见句子。**界面语言集合以 `src/shared/locales.mjs` 的 `available` 为准（当前注册表为十种界面语言，具体语言码与键数以该文件及 `docs/I18N.md` 为准，不在本文件维护固定数量）；AI 输出语言由同一注册表的 `aiOutput` 能力位决定。界面语言与 AI 输出语言是两个独立持久设置（`locale` / `aiOutputLocale`，后者默认 `follow-ui`）。详见 `docs/I18N.md`、`docs/i18n/GLOSSARY.md`。**
- 新增/修改文案必须**同时**更新清单内所有语言的字典，键集与 `{param}` 占位符必须完全一致；不得先只加英文再「以后再补」。
- 启动器文案放在 `src/launcher/cli-i18n.mjs`，各语言键必须一致；控制台编码失败时必须走既有 ASCII 降级，不得输出乱码。
- 语言名在语言选择器中**始终用该语言自身文字显示**（简体中文 / 日本語 / English / 한국어 …），不跟随界面语言翻译。
- 布局必须容忍译文变长：不得为某一句文案写死宽度；语言选择器、按钮、胶囊标签在最长译文下不得截断或溢出（现有 `max-width:132px` 等约束必须复核）。
- 任何来自平台/用户的文本（昵称、弹幕、标题）必须通过 `textContent` 渲染；**禁止 `innerHTML`**。
- 桌面优先；≤860px 折叠侧边栏为抽屉；窄屏不得出现横向溢出。
- 主题/语言切换不得造成布局跳动或内容丢失。

---

## 8. Windows 与数据安全

- 只监听 `127.0.0.1`，禁止 `0.0.0.0`；动态端口，端口冲突自动顺延或使用系统分配端口。
- 用户数据只能写入 `%LOCALAPPDATA%\LiveMemory\`（或用户显式指定的可写目录），**绝不写 `Program Files` / EXE 所在目录**。
- **发布 EXE 的 RT_MANIFEST 必须为 `requireAdministrator`**（RC0-ADMIN-MANIFEST，2026-11-14 用户明确决定，取代 RC0 P0-5 的 `asInvoker`）：双击时由 Windows 显示标准 UAC 确认，用户同意后以管理员权限启动；不得要求用户右键“以管理员身份运行”，不得绕过或关闭 UAC，用户拒绝时由 Windows 正常取消启动。构建脚本必须显式断言最终 EXE 为 `requireAdministrator`。
- 提权只用于按用户决定让 Windows 在双击启动时显示标准 UAC；不得因此放宽数据目录路径校验、迁移 staging/校验/回滚、删除范围限制与“不删除无关文件”的规则，也不得放宽本地 API 会话认证、Origin/Host 校验、SSE 认证与凭据保护。未来若出现新的权限需求，仍必须单独设计最小权限/受控提权，不得在现有整包提权之上再扩大权限。
- 本地 HTTP API 必须有会话认证：除 `/api/health`、`/api/auth/status`、`/api/auth/session` 外，所有 `/api/*`（含 SSE）都要求启动器建立的随机会话 Cookie；不得添加返回 token 的端点，不得把 token 放进查询串或日志。
- 权限失败必须解释路径、错误码与替代方案；不得把所有启动失败统一归类为权限不足。
- **AI Provider API Key 不依赖数据目录 ACL**：生产环境写入 Windows Credential Manager（`src/platforms/shared/credential-store.mjs`），通过固定 PowerShell + 内嵌 C# P/Invoke 调用 CredWrite/CredRead/CredDelete；Key 只经 stdin 传递，PowerShell 编译器临时目录必须使用应用可写的 cache。Credential Manager 不可用时必须明确失败，不得回退为明文或伪造成功。
- **Windows 账户隔离不可绕过**：Credential Manager 按当前用户 SID 隔离；不得读取/修改其他账户的 vault，也不得为跨账户复用而修改其他账户文件 ACL。UAC over-the-shoulder 进入另一管理员账户时，凭据属于该账户；文档必须如实说明。
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
- 不得为了绕过平台的授权或配额限制而改用抓取、未公开接口或共享凭据。YouTube 公开网页聊天是唯一接入路径，但必须遵守 §6.12 的不绕过访问控制、不描述为官方/合规、如实说明可能失效等边界；不得偷偷恢复官方 API 双轨实现。TikTok 的匿名 webcast WebSocket 是 §6.12 明确授权的唯一例外，并只能在该节边界内使用：不绕过访问控制、不登录、不依赖第三方签名服务、标注非官方/实验性、失败即如实报告。
- 不得在文档或界面中把「模拟/假 API 验证」描述为「真实平台验收」。缺少真实凭据时必须如实写「阻塞」。真实凭据与 API Key 不得出现在代码、测试、文档、截图或提交中。
- **不得把「计划支持」写成「已支持」**：已发布平台、预览平台、当前版本与未实现候选，以 `docs/STATUS.md` §0 与 `docs/PLATFORM_INTEGRATIONS.md` §0 为准。十种**界面**语言与十种 **AI 输出语言**均已实现，但「界面十语 = AI 十语」只是能力集合相同，**仍是两个独立设置**（`locale` / `aiOutputLocale`）。翻译**阅读**语言只读取缓存、不重跑分析；每个任务的语言快照不可变。快手是**预览组件**：即使已随版本发布，H5 实时采集默认禁用、未取得书面许可、未完成真实许可下验收，**不得写成已支持快手采集**。README、界面、发布说明与 STATUS 只能描述实际存在的能力。
- **不得仅凭开源项目 README、示例或接口存在就宣称平台支持**：没有本仓库真实样本与真实 EXE 验收的一律标「待验证」，缺失的事件一律标 `NOT-OBSERVED`。
- **不得为通过平台验证而绕过访问控制**：不破解验证码、不伪造登录态、不规避地区/年龄/权限限制、不购买第三方采集/签名服务、不引入运行时第三方依赖。失败即停止并如实报告。
- **不得复制许可证不兼容的代码**：AGPL 代码不得直接进入 MIT 代码区；引用任何第三方实现必须按其许可证在 `THIRD_PARTY_NOTICES.md` 标注。
- **不得把界面语言与 AI 输出语言合并成一个开关**，也不得在任务创建后改写已保存结果的语言或正文。

---

## 11. 每轮交付自检清单

- [ ] 本地服务器可启动，浏览器可打开控制台
- [ ] 界面与命令行在**清单内所有语言**下无缺失键、无乱码、无截断（当前十语；新增语言按 `docs/I18N.md` 门禁）
- [ ] 明亮/黑暗/跟随系统均正常，刷新后保持
- [ ] 新增逻辑有对应测试，且 `node --test` 通过
- [ ] 金额、身份、去重规则未被破坏
- [ ] 若涉及语言：界面语言与 AI 输出语言互不影响，任务语言快照未变，原文未被翻译覆盖
- [ ] 若涉及新平台：`docs/PLATFORM_ADMISSION.md` 的 G0–G6 阶段证据齐备，未验证项已标「待验证」/`NOT-OBSERVED`
- [ ] STATUS / HANDOFF / ROADMAP / 开发日志已更新
- [ ] 已创建本地 Commit 并报告 Hash
- [ ] 发布 EXE 的 Manifest 已验证为 `requireAdministrator`（如本轮涉及打包）
- [ ] 提权未放宽认证、Origin/Host 校验、SSE 认证、凭据保护与数据完整性规则
