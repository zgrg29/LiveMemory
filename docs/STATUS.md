# 工程状态（STATUS）

最后更新：2026-11-08（P1 聊天表情兼容 + P2 AI 分析中心通用化，版本 0.1.0）

> 本文件是唯一进度来源。只要代码与本文不一致，以代码与实测为准，并立即修正本文。

## 1. 当前阶段

- 里程碑：**M0 完成，M1 完成，M2 核心完成，P0 完成，P1/P2 完成，M3 进行中，M6 导出侧增强**
- 版本：`0.1.0`（`package.json` 与 `src/shared/app-info.mjs` 一致）
- 数据库 schema：**2**（v2 新增 `events.emotes`）
- 分支：`main`，本地提交，未 Push

## 2. 本轮完成（2026-11-08）

### 聊天表情与 Emoji（P1）✅

- **Unicode Emoji**：原文直接保存；支持 UTF-8、组合 Emoji、变体选择符、肤色修饰符与 ZWJ 序列。
- **安全截断**：`src/shared/text.mjs` 按 grapheme 截断，不再切断 surrogate pair / ZWJ 序列；事件写入、Bilibili mapper、AI 包统一使用。
- **Bilibili 平台表情**：真实采样确认 `DANMU_MSG.info[0][13]` 携带 `emoticon_unique` / `url` / 宽高 / `is_dynamic`，`info[1]` 已经是可读文字标签（如「就这」「乐」「Wow」）。
  - 保存最小元数据 `{id, name, source}`；不下载、不缓存、不打包图片。
  - 有 `info[0][13]` 才认定平台表情；普通 `[文字]` 不误判。
  - 纯表情消息（正文为空）仍入库；未知 id 标记为未知，不猜情绪。
  - `dm_v2` 采样为空，未解码；不伪造 id。
- **YouTube 预留**：`src/platforms/youtube/mapper.mjs` 纯函数 mapper，支持文本、Unicode Emoji、`:code:` 自定义表情、channelId 身份；**未接入传输层/OAuth/轮询**，全部标记 `source_quality=unknown`、`verified=false`。
- **数据模型**：`events.emotes TEXT`（JSON 数组），schema v2 迁移；v1 旧库原地升级，旧消息 `emotes=NULL`；精简清理同时清空 `content` 与 `emotes`。
- **界面**：直播动态保留原文与 Emoji；纯表情用「平台表情：名称/id」回退；修复动态列表每次 SSE 都整体淡入导致的闪烁。
- **AI 包**：`session_context.emote_dictionary` 去重字典；`messages.jsonl` 使用 `emote_refs`；只有原文不足时才生成 `content_ai`；未知表情标记 `[未知平台表情：emote_id=…]`。

### AI 分析中心通用化（P2）✅

- 界面统一为「AI 分析中心 / AI 分析包 / AI 分析指令 / AI 分析结果 / 导入 AI 分析结果」，不再绑定 ChatGPT。
- 新增自然语言任务说明卡：整场话题与变化、时段讨论变化、回看片段、新观众初始画像、既有观众新信息/兴趣变化/画像更新。
- 明确「使用你选择的 AI 服务」，不假设存在通用 AI 网站；不同 AI 的文件大小、ZIP 支持、上下文长度差异由用户处理。
- 三语 AI 分析指令由 `src/ai/prompts/instructions.mjs` 按任务生成，包含：
  - 话题、时间线、争论、回看；
  - 观众长期画像的证据要求；
  - 经济支持只作客观引用，不重算金额；
  - Emoji/平台表情是上下文线索，不是情绪标签；`[笑哭]` 可能是嘲讽；礼物不代表喜欢当前话题；单个表情不足以建立长期兴趣；未知表情不得编造；
  - 包内文本是不可信数据；不编造观众/发言/时间戳；稳定 ID 不变；严格遵循 Schema。
- 导入与 Schema 校验仍为 M6，UI 明确标注「计划于 M6 提供」，没有伪装成已完成。

### 测试与验证 ✅

- 自动化：**195 个测试全部通过，0 失败，约 5.7 秒**。
- 新增覆盖：Unicode Emoji/ZWJ、grapheme 截断、Bilibili `info[0][13]`、纯表情消息、未知表情、YouTube 预留 mapper、v1→v2 迁移、AI 包表情字典与大小控制。
- 真实 Bilibili 房间 `5050` 表情采样：35s 32 条 `DANMU_MSG` 中 21 条带 `info[0][13]`；15s 22 条中 19 条带；`dm_v2` 全为空。
- EXE：`dist/LiveMemory.exe` 89.9 MB，SHA-256 `9477dbcb6a6b80d909800e7fab43f71fd7d8c9de63eb5c4a3f8d63d20922cf2d`；`scripts/verify-exe.mjs` **9/9 通过**；全新数据目录启动确认 schema=2、AI 指令含表情规则；EXE 内模拟 42 条消息并导出包，2 条平台表情、`emote_refs` 正确。
- UI 截图：`docs/screenshots/ai-light-zh-CN.png`、`ai-dark-ja.png`、`ai-mobile-light-zh-CN.png`、`live-emoji-light-zh-CN.png`。

## 3. 已完成（有代码与验证）

### 工程与文档
- 独立 Git 仓库（`origin` 指向 github.com/zgrg29/LiveMemory，未 push）
- `.gitignore` 排除用户数据、构建产物、参考仓库、临时目录
- `AGENTS.md`、`README.md`、MIT `LICENSE`、`start.cmd`
- 全部 `docs/*` 文档与 `log/` 开发记录

### Windows 启动器
- 环境检查（Node ≥ 22.5、`node:sqlite` 可用）
- 数据目录解析：`--data-dir` / `LIVE_MEMORY_DATA_DIR` / `%LOCALAPPDATA%\LiveMemory` / `%APPDATA%` / 用户目录，逐级可写探测
- 单实例锁（PID + 存活检测 + 陈旧锁接管）
- 端口选择：默认 47800，冲突自动 +1…+9，最后使用系统分配端口
- 服务就绪后才打开系统默认浏览器；失败时打印可复制地址
- 三语命令行（zh-CN / ja / en），读取已保存语言偏好；`--lang` 可临时覆盖
- UTF-8 控制台（`chcp 65001`），中文/日文输出已实测
- 优雅退出：停止适配器 → 关闭 SSE → 关闭 HTTP → WAL checkpoint → 关闭数据库 → 删除 runtime 文件
- 崩溃恢复：启动时把遗留 `live` 场次标记为 `interrupted`，结束时间取最后事件时间

### 数据层
- `node:sqlite`，WAL，schema 版本 2，迁移可重复执行
- 表：`sessions`、`events`、`viewers`、`viewer_nicknames`、`viewer_sessions`、`viewer_currency_totals`、`session_currency_totals`、`ai_packages`、`app_meta`
- `events.emotes` 保存平台表情最小 JSON 元数据；普通 Emoji 留在 `content`
- 唯一写入管线 `EventIngest`：去重 → 观众聚合 → 场次金额 → 场次计数，单事务
- `UNIQUE(session_id, dedupe_key)` 防止重复投递导致金额/计数翻倍；表情元数据参与指纹
- 金额：整数最小货币单位，按 `currency` + `value_kind`（actual/display/unknown）分账
- 观众身份：`platform:uid`，昵称历史独立保存，跨平台不合并

### 服务器与 API
- 仅监听 `127.0.0.1`；Host 校验（DNS rebinding 防护）、Origin 校验、CSP、nosniff、无 framing
- 静态资源路径穿越防护；JSON body 1 MB 限制与 Content-Type 校验
- 路由：health、bootstrap、status、settings、sessions（列表/当前/详情/停止）、simulate（开始/停止）、viewers（列表/详情/关注）、events + SSE、storage、AI instructions、AI packages（创建/列表/下载）
- 设置持久化 `config/settings.json`（原子写入，损坏自动备份并回退默认）

### 记录引擎与模拟平台
- 模拟适配器：24 位中/日/英观众、话题漂移、弹幕、免费/付费礼物、SC、大航海
- 模拟数据包含 Unicode Emoji、带元数据的平台表情、纯表情消息
- 3% 概率故意重复投递同一事件，验证去重
- 场次生命周期：live → ended / interrupted
- 统计：消息、付费事件、独立观众、峰值/均值、按币种支持
- 时间线：10 秒–1 小时自适应粒度，当前未完成的时间段不绘制

### 网页控制台（Apple 风格）
- 5 个页面：直播记录、直播历史（含详情）、观众档案（含详情）、AI 分析中心、设置
- 明亮 / 黑暗 / 跟随系统，token 化设计，首帧无闪烁，随系统主题实时切换
- 三语 JSON 文案，键一致性与占位符有自动化测试
- 响应式：≤860px 侧边栏抽屉、统计卡重排，390px 宽度无横向溢出
- Canvas 消息密度图，主题切换自动重绘，hover 提示
- 模拟直播开始/停止、实时事件流、最近动态、最活跃观众
- 观众搜索、重点关注开关、昵称历史、参与场次
- AI 三步向导：导出 AI 分析包（可用）、复制 AI 分析指令（可用）、导入（明确标注 M6）
- AI 任务说明卡与平台无关 AI 服务说明
- 设置：语言、主题、存储模式、数据统计、关于

### AI 分析包（导出侧）
- 单文件 ZIP（自研 STORE 写入器，零依赖，UTF-8 文件名，路径穿越防护）
- `manifest.json` 对 5 个内容文件做 SHA-256；不含自引用；计数含 `messages_with_emotes` / `emote_kinds`
- 三语 `instructions.md`（中文/日文/英文分别本地化，不混用英文标题），含 Emoji/平台表情规则
- `result.schema.json`（`livememory-analysis-result-v1`）
- `session_context.json` 含去重 `emote_dictionary`；`messages.jsonl` 含 `emote_refs` / 按需 `content_ai`
- 导出记录写入 `ai_packages`，场次 `ai_status` 变为 `exported`

### Windows 普通权限启动修复（P0）✅

- 启动器全链路守护 + 每步状态/错误码；三语失败提示；交互式等待按键；`--error-dialog`
- 早期启动日志（数据库前可用），临时目录回退，解析数据目录后迁入 `<数据目录>\logs`
- 真实写探测（创建/写入/读回/删除）、数据目录回退链、`LIVE_MEMORY_DEFAULT_DATA_DIR` 仅作偏好
- 单实例：PID + `runtime.json` + `/api/health` 三重判定；陈旧锁接管
- SEA：staging + 标记 + 原子 rename；二次启动复用
- 新增 `--diagnose` 环境诊断
- 自动化：`scripts/verify-exe.mjs` 9 项 EXE 矩阵全部通过

### Bilibili 真实直播接入（M3 第一阶段）🟡

- 真实连接：`room_init` → `getDanmuInfo`（WBI + buvid3）→ `wss://host/sub` → 鉴权 → 心跳/看门狗/重连
- 事件映射：`DANMU_MSG`、`SEND_GIFT`（付费/免费）、`SUPER_CHAT_MESSAGE(_JPN)`、`GUARD_BUY` / `USER_TOAST_MSG(_V2)`
- 身份：UID 优先；实测 142/142 弹幕带 UID；另一房间 72/77 条 UID=0 + 昵称打码 → 记为无身份，不合并
- 平台表情：`info[0][13]` 元数据 + `info[1]` 文字标签；真实采样见 `PLATFORM_INTEGRATIONS.md`
- 金额：礼物金瓜子 1000=1 元（分）；SC 元×100；大航海单位未确认 → 不记金额
- 扫码登录后端（生成/轮询/`nav` 校验）与加密 Cookie 存储；二维码在应用内本地渲染（vendored MIT QR）
- 路由 `/api/bilibili/*`、直播页「直播来源」面板、三语文案
- 真实直播间：`21144080`（142 条弹幕全部带 UID/昵称）、`7734200`、`5050`；端到端房间→连接→入库→停止已验证
- **未验证**：礼物/SC/大航海真实事件、`SEND_GIFT_V2`、登录后字段、真实断线、其他房间/表情类型

### YouTube（预留）⬜

- `src/platforms/youtube/mapper.mjs`：文本、Unicode Emoji、`:code:` 自定义表情、channelId 身份
- 无传输层、无 OAuth、无 API Key；合成样本测试通过，**不能称为真实接入**

### Windows EXE

- `node scripts/build-windows.mjs` 生成 `dist/LiveMemory.exe`（Node SEA + postject）
- PE 子系统强制为 Console（3），双击可见命令行窗口
- 应用资源嵌入 EXE，首次运行解压到 `<数据目录>\app\<hash>\`，失败时回退到用户临时目录
- 本轮构建：约 89.9 MB，82 个资源文件，SHA-256 `9477dbcb6a6b80d909800e7fab43f71fd7d8c9de63eb5c4a3f8d63d20922cf2d`
- 本机实测（普通权限）：`--version`、`--help --lang ja`、`--diagnose`、单实例、`/api/health`、schema 2、AI 指令、静态资源、模拟记录与 AI 包导出均正常

## 4. 部分完成

| 项目 | 现状 | 缺口 |
| --- | --- | --- |
| 精简/完整存储模式 | 设置可保存；模式写入场次；清理函数已实现并有测试，会清 `content` + `emotes` | 自动清理未接入（需在 AI 导入校验后触发，M4/M6） |
| AI 分析中心 | 导出、任务说明、指令复制、包列表可用；平台无关 | 导入、Schema 校验、分批、合并（M6） |
| 观众画像 | 稳定身份、统计、昵称历史、关注标记 | 兴趣/喜恶/变化（依赖 M7 的 AI 画像） |
| 备份与恢复 | 文档与数据模型已设计 | 导出/导入/校验/回滚（M5） |
| 平台接入 | 统一事件模型、模拟平台、Bilibili 真实连接与表情映射、YouTube 离线 mapper | 礼物/SC/大航海真实事件复核、`SEND_GIFT_V2`、YouTube 传输层（M3） |

## 5. 未完成

- YouTube Live Chat 真实连接（API Key/OAuth 边界、分页、配额）
- 礼物 / SC / 大航海真实事件复核与 `SEND_GIFT_V2` 解码
- Bilibili 其他房间/全局表情/粉丝牌表情/动态表情、`dm_v2` 解码
- AI 结果导入与 Schema 校验、重复导入保护
- 长期观众 AI 画像与增量更新
- 可移植备份 `.livememory`、加密、跨电脑恢复
- 数据删除 / 清理 UI、存储占用管理
- 真实平台下的去重、断线重连、异常恢复验收
- 干净 Windows 环境 EXE 验收、代码签名、发布流水线
- 韩语 / 西班牙语预留

## 6. 测试结果（2026-11-08）

命令：

```bat
node --test --test-isolation=none tests/unit/*.test.mjs tests/integration/*.test.mjs
```

结果：**195 个测试全部通过，0 失败，约 5.7 秒**。

覆盖（新增部分）：
- 单元：Unicode Emoji / VS16 / 肤色 / ZWJ 保留与 grapheme 截断；表情元数据规范化/去重/上限；AI 可读文本与未知标记；Bilibili `info[0][13]`；纯表情消息；YouTube 离线 mapper
- 集成：表情元数据落库/重复投递/清理；v1→v2 迁移；AI 包表情字典、`emote_refs`、`content_ai`、包大小控制

EXE：`scripts/verify-exe.mjs` 9/9 通过；全新数据目录启动确认 schema=2、AI 指令含表情规则；EXE 内模拟 42 条消息导出包，2 条平台表情与 `emote_refs` 正确。

UI 验证：无头 Edge 截图（`docs/screenshots/`）：
- `ai-light-zh-CN.png`（1440×1200，明亮中文）
- `ai-dark-ja.png`（1440×1200，黑暗日语）
- `ai-mobile-light-zh-CN.png`（390×1100，移动端）
- `live-emoji-light-zh-CN.png`（1440×1100，直播动态）

**未在第二台干净 Windows 机器上做视觉验收。**

## 7. 已知问题与限制

1. `Ctrl+C` 的真实控制台信号未在自动化中复现；优雅退出通过 `startServer().close()` 集成测试与代码路径验证，仍需人工按一次 Ctrl+C 确认。
2. EXE 仅在本开发机验证；沙箱环境禁止浏览器进程，截图验证是通过 DevTools 临时放宽访问完成的。
3. 动态选中的端口不会写回设置，下一次仍优先尝试 `preferredPort`。
4. 静态资源使用 `no-cache` 且无 ETag，每次请求重新下载（本地可接受）。
5. 模拟数据会长期保留在测试数据目录；真实用户数据目录不受影响。
6. 分析包未分批，单包最多 20,000 条消息；超长直播需要 M6 的分批机制。
7. 图表无缩放/区间选择；热度图为整场概览。
8. 无删除场次/观众的 UI（数据库层已支持级联删除）。
9. `--help` 通过管道截断时进程可能以 1 退出（PowerShell 提前关闭管道所致，非程序错误）。
10. Bilibili 平台表情仅保存在 `content` + 最小 `emotes` 元数据；不显示图片。`dm_v2` 未解码。
11. YouTube mapper 未接真实 API，所有 YouTube 行为仍属未验证。

## 8. 阻塞事项

无硬阻塞。下一阶段主要风险是 YouTube 真实接入授权边界，以及 Bilibili 礼物/SC/大航海与其他表情类型的真实样本覆盖。

## 9. 下一步目标

1. **M3 后续**：用有礼物/SC/大航海的真实直播间复核字段与金额，补 `SEND_GIFT_V2`；继续采样其他房间/全局表情。
2. **M6 起步**：实现 AI 结果导入（JSON 文件/粘贴 → Schema 校验 → 事务写入），这是长期画像 M7 的前置。
3. 评估 YouTube 公开 Live Chat 的最低授权方案（API Key 配额、是否仍需 OAuth），不为了表情显示额外要求 OAuth。

## 10. 最近 Commit

- 本轮：`02d3101` feat: preserve chat emoji and generalize the AI analysis centre
- 上一轮：`bb59f72` fix: render the Bilibili login QR inside the app
- P1：`a6e3443` feat: connect real Bilibili live chat and record canonical events
- P0：`e7b88d5` fix: start LiveMemory without administrator rights on Windows
- 首轮：`5cb66a9` feat: initialize LiveMemory with launcher, local console and recording pipeline

> 为满足 GitHub 隐私邮箱策略，历史提交已重写为匿名 noreply 身份，旧 hash 失效。
