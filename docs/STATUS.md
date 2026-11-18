# 工程状态（STATUS）

最后更新：2026-11-19（**v0.19.1 正式发布：Windows Credential Storage Fix**；
详见 §0.65、`docs/release-notes/v0.19.1.md` 与 `log/2026-11-19-v0.19.1-release.md`）

> 本文件是唯一进度来源。只要代码与本文不一致，以代码与实测为准，并立即修正本文。
> **先读 §0 当前状态快照**；§0.65 是当前版本（v0.19.1）的发布记录；§0.64 及更早是历史记录，
> 只用于追溯，不代表当前状态。发布证据另见 `docs/RELEASE_HISTORY.md`。

## 0. 当前状态快照（2026-11-18）

> 本节只做摘要；详细证据在 §0.61 与 `docs/RELEASE_HISTORY.md`。若本节与后文冲突，
> 以代码、Git/Release 事实与 `docs/RELEASE_HISTORY.md` 为准，并立即修正本节。

### 0.1 版本与发布

| 项目 | 当前值 |
| --- | --- |
| 产品版本 / 当前开发版本 | **`0.19.1`**（`package.json` = `APP_VERSION` = `0.19.1`） |
| 下一版本 | **未定**；需用户授权后才进入新里程碑 |
| 最新正式发布 | **`v0.19.1`** · Release ID `450272261` · Published `2026-11-18T16:43:01Z` |
| 发布性质 | 正式补丁发布：AI Provider API Key 迁移至 Windows Credential Manager，修复部分 Windows 用户的凭据保存权限错误；平台状态未变（快手仍为预览、采集禁用） |
| 最新 Release 资产 | `LiveMemory.exe` 99,609,088 B · SHA-256 `4d230f5f…369542`；`SHA256SUMS.txt` 81 B · SHA-256 `7ca49114…092284` |
| 当前分支 | `main`（`fea8cbe..04b30b7` 已 Push；Tag 已 Push） |
| 当前 Tag | `v0.19.1`（annotated，object `721690b4` → commit `04b30b7`） |
| 数据库 Schema | **16**（v0.19.1 无迁移） |
| 当前开发里程碑 | **P54 AI Provider 凭据可靠性（v0.19.1 正式发布）**；OpenCode 真实付费验收待办 |
| 最近开发 | 2026-11-19：AI Key 从自维护 AES JSON 迁移至 Windows Credential Manager；旧数据自动迁移；错误提示 `{path}` 修复；正式发布 v0.19.1 |
| 最近文档整理 | 2026-11-19：v0.19.1 Release Notes / 检查单 / 发布记录；STATUS、HANDOFF、ROADMAP、CHANGELOG |

### 0.2 平台状态

| 平台 | 状态 | 事实边界 |
| --- | --- | --- |
| Bilibili Live | 已发布 | 真实弹幕与稳定身份已验证；未登录可能昵称打码/UID=0；礼物真实事件未观测，SC/大航海有真实身份样本但未完整验收 |
| YouTube Live | 已发布 | 公开网页聊天路径；不是官方稳定 API；真实聊天已验证 |
| Twitch | 已发布 | 匿名 IRC；真实聊天、订阅/续订已验证；Bits/赠订未观测 |
| 抖音 | 已发布 | 匿名聊天与稳定 UID 已验证；礼物需登录，真实手机扫码与真实礼物未完全验证 |
| TikTok | 已发布（实验性） | 匿名本地 webcast；真实聊天/身份/消息 ID 已验证；礼物 `NOT-OBSERVED`；无续传游标 |
| Kick | 已发布（v0.16.0） | 真实聊天、KICKs、赠订已验证；非官方接口；KICKs 不换算法币 |
| 快手 | **预览，采集禁用** | 仅链接解析与本地 UI；`connect` 在请求前返回 403；无真实 H5 采集；礼物/点赞 `NOT-OBSERVED`；跨场身份不合并 |
| 虎牙 / 斗鱼 / CHZZK / SOOP / Niconico / 小红书 / YY / Facebook Live | 未实现 | 仅调查候选，不是路线图承诺；不得描述为支持 |

### 0.3 语言与 AI

- **十种界面语言**：`zh-CN` / `ja` / `en` / `ko` / `es` / `pt-BR` / `zh-TW` / `fr` / `de` / `id`；
  十份字典各 **2,373** 个叶子键（本次 Provider 保存诊断新增 22 键），键集与占位符一致。
- **十种 AI 输出语言**：同一注册表 `aiOutput: true`；与界面语言是两个独立持久设置
  （`locale` / `aiOutputLocale`，后者默认 `follow-ui`）。任务创建时写语言快照，之后不可变。
- **报告阅读翻译**：只读取/生成展示层译文，不重跑分析；原文、`viewer_id`、证据与事实状态不变。
- **AI Provider**：OpenAI、Anthropic Claude、DeepSeek、MiniMax（中国大陆/国际）、
  阿里云百炼（北京/新加坡/美国/中国香港）、OpenRouter、OpenCode（pay-as-you-go / Go）、
  自定义 OpenAI-compatible。
- **真实 Provider 证据**：DeepSeek `deepseek-flash` 已完成单场、画像、跨语言与翻译验收；
  OpenCode 有实现与本地/Mock 测试，但**无真实 Key、未做真实付费验收**；
  其他 Provider 有实现与本地/Mock 测试，但**未逐一做真实付费验收**。

### 0.4 数据、备份与 Windows

- 数据默认写入 `%LOCALAPPDATA%\LiveMemory\`；只监听 `127.0.0.1`；本地 API 需要会话 Cookie。
- **AI API Key 存在 Windows Credential Manager**（DPAPI，按当前 Windows 用户 SID 隔离）；
  旧 AES `secrets/ai-keys.json` 只读迁移/回退，不再写入新 Key。平台 Cookie 仍在本地
  AES-256-GCM Cookie 库。两者都不进入配置 JSON、日志、备份或 HTML。
- `.livememory` 完整备份/恢复/迁移已实现；备份**未加密**，不包含凭据，但包含观众数据。
- 发布 EXE 的 Manifest 为 **`requireAdministrator`**：双击显示标准 UAC；拒绝即取消启动。
- EXE **未签名**，SmartScreen 可能提示未知发布者；不带 Python/Node/npm/数据库依赖。
- **仍未人工验证**：真实双击 UAC 同意/拒绝、干净 Windows 账户、Windows 原生文件对话框点击、
  真实浏览器自动打开、Ctrl+C 优雅退出。

### 0.5 已验证 / 未验证（发布与验收口径）

| 项目 | 当前结论 |
| --- | --- |
| 全量自动化（2026-11-18 v0.19.0） | **1,269 passed / 0 failed / 0 skipped**（871 unit + 398 integration；单次全量 `--test-isolation=none`，365,726 ms） |
| 全量自动化（2026-11-19 v0.19.1） | **1,294 passed / 0 failed / 2 skipped**（889 unit + 407 integration；skip 为 opt-in 真实 CredMan） |
| 真实 CredMan（opt-in） | **2/2 passed**：保存/读取/更新/大 Key 分块/删除/旧 AES 迁移；随机 target 自动清理 |
| 本轮 EXE（v0.19.1） | **待最终构建填写**；`requireAdministrator`；`verify-provider-save-exe` 24/24、`verify-exe` 11/11、`verify-help-exe` 14/14、`verify-ai-token-exe` 16/16 |
| 历史 EXE（v0.19.0 发布） | Build `252939f4d41b`；99,551,744 B；SHA-256 `901f92fd…64fc9`；`requireAdministrator`；`verify-provider-save-exe` 14/14、`verify-exe` 11/11、`verify-help-exe` 14/14、`verify-ai-token-exe` 16/16 |
| 历史 EXE（v0.18.0 发布） | Build `902109197d8b`；99,503,104 B；SHA-256 `285cfd82…2957f`；`requireAdministrator`；verify-exe 11/11、verify-help-exe 14/14、verify-ai-token-exe 16/16 |
| 六平台回归 | 全量套件通过；协议未改 |
| 十语言字典 / UI 矩阵 | 10 × **2,379** 键；键集/占位符门禁通过；真实浏览器 80/80 为 v0.18.0 历史结果，本轮新增文案未做真实浏览器矩阵 |
| 真实 H5 / 真实 EXE 采集 | **未执行**（无快手书面许可） |
| 真实付费 Provider（DeepSeek 以外） | **未逐一验收**；需要真实 Key 与费用授权 |
| 真实 Windows UAC / 干净账户 | **未人工验证**；自动化只断言 Manifest 与 asInvoker 功能副本 |
| 长时压力 / 10+ 场 | 未完成；已有 70 分钟 Kick 与 30 分钟 TikTok 真实长测，但不等于通用压力验收 |
| 后台标签继续记录 | 切换页面/刷新不停止采集；专门的“隐藏但继续记录”交互未单独验收 |

### 0.6 开放问题与下一步

v0.19.1（Windows Credential Storage Fix）已发布。当前没有进行中的功能里程碑；下一步由用户决定：

1. **OpenCode 真实付费验收**：需要用户提供真实 Key 与费用授权，验证 Pay-as-you-go 的
   真实 200/429/5xx、真实模型输出、真实账单与 `usage.cost`；Go 还需额外确认套餐真实可用性。
   未通过前保持 L2/L4，不得写成真实通过。
2. **快手书面许可/官方接口**：取得前保持采集禁用；取得后按
   `docs/KUAISHOU_H5_INTEGRATION.md` 的 G4/G5 重新验收，不得直接打开生产采集。
3. **真实 Windows 人工验收**：双击 UAC（同意/拒绝）、干净账户、文件对话框、Ctrl+C。
4. **其他真实 Provider 补验**：OpenAI / Anthropic / MiniMax / 百炼 / OpenRouter / 自定义。
5. **用户反馈专项（v0.19.1 已发布）**：Provider 切换需重新输入 Key 仍是安全设计
   （密钥不能发往未经确认的新地址），但错误提示已具体化；自定义端点 OpenCode 的会话头错误
   已修复；AI Key 已迁移至 Windows Credential Manager，避免依赖数据目录内凭据文件 ACL，
   见 §0.65。仍需人工验证真实 UAC over-the-shoulder 与不同 Windows 账户。保存流程历史根因
   见 §0.62。
6. **真实平台长测与未观测事件**：Twitch Bits/赠订、抖音真实礼物、TikTok 礼物、Kick 自然
   下播→再开播；缺失事件继续标 `NOT-OBSERVED`。
7. **新平台**：必须按 `docs/PLATFORM_ADMISSION.md` 的 G0–G6 重新调查与验收；不得为了
   增加平台数量降低标准。

### 0.7 历史记录

- §0.65：v0.19.1 Windows Credential Storage Fix 发布记录（当前正式版本）。
- §0.64：AI Provider 凭据迁移至 Windows Credential Manager（已随 v0.19.1 发布）。
- §0.62：v0.18.0 发布后 AI Provider 配置保存可靠性修复（已随 v0.19.0 发布）。
- §0.61：v0.18.0 OpenCode Provider 接入、发布与证据。
- §0.60：v0.17.0 快手 H5 预览接入与发布记录。
- §0.59 及更早：历史里程碑、调查与验收记录，**只用于追溯**。
- 发布资产、Tag、Release ID 与 SHA-256 的归档：`docs/RELEASE_HISTORY.md`。
- 逐版本变化：`docs/CHANGELOG.md`。

---

## 0.60 快手 H5 预览接入：组件完成、生产采集禁用（2026-11-17）⚠️ 已发布为预览 · 采集禁用

### 0.60.1 结论

- **按用户指示只采用 G1 已验证的匿名 H5**：停止登录 WebSocket 研究，不实现扫码登录、签名、
  设备指纹、验证码、TLS 伪装、代理或浏览器中继。
- **组件全部集成**：URL 解析、公开 comment 解析、昵称/数字 `userId`/毫秒时间、去重、
  多直播间隔离、SQLite、单场 AI 分析、长期画像（受身份限制）、自动监控、异常恢复、
  上下播判断、十语 UI、发布 EXE。
- **生产采集保持禁用**：默认 `access.enabled=false`；connect 在任何网络请求前返回 403
  `KUAISHOU_AUTHORIZATION_REQUIRED`；room 在禁用时只做本地解析；UI 始终展示要求的告知。
- **未取得书面许可**：G1.5 已确认快手条款禁止未经授权的自动采集、H5 robots 为
  `Disallow: /`；因此不进行真实 H5 采集、不进行真实许可下验收、不发布为已支持。
- **礼物 / 点赞不声称支持**：研究样本未观测（`NOT-OBSERVED`），代码只映射 `comment`。
- **身份不跨场合并**：`viewer_uid=h5:<rawUserId>@<sessionId>`，两场相同 `userId` 也保持隔离；
  G3 稳定性证据仍缺失，不提供自动合并。
- **版本**：`0.16.0` → `0.17.0`（**正式发布为预览版**；Schema 仍 **16**，无迁移；快手实时采集未开放）。

### 0.60.2 实现与数据语义

| 项目 | 结果 |
| --- | --- |
| 平台标识 | `kuaishou`；`broadcaster_id=kuaishou:<eid>` |
| URL | `live.kuaishou.com/u/<eid>`、`livev.m.chenzhongtech.com/fw/live/<eid>`、裸 ID |
| 事件 | 仅 `chat`；`external_id=NULL`；`source_quality=unknown` |
| 身份 | 会话内临时 `h5:<userId>@<sessionId>`；昵称不作身份 |
| 去重 | 适配器 `userId+time+content` 指纹 + `UNIQUE(session_id, dedupe_key)` |
| 结束 | feed `601/671` 权威；房间页连续 2 次 offline；rate_limited/unknown 不结束 |
| 监控 | `kuaishou` 加入共享调度器；基础 120 秒；目标键 `eid`；循环键 `kuaishou:<eid>:<liveStreamId>` |
| 保留 | 30 天原文/昵称清理，scoped `kuaishou`；计数/会话内 ID/分析保留 |
| UI | 第七个页签；强制告知；授权状态；会话内身份/无消息 ID/无礼物说明；禁用时仅解析 |
| 语言 | 10 × **2,351** 键，新增 47 键，键集/占位符 0 差异 |

### 0.60.3 验收（真实结果）

> 全部为 fake fetch / 研究样本形状；**不是真实 H5 验收**。

| 项目 | 结果 |
| --- | --- |
| 全量测试 | **844 unit + 382 integration = 1,226 passed / 0 failed / 0 skipped**（`--test-isolation=none`，最终复跑 336,443 ms） |
| Kuaishou 专项 | **49 passed / 0 failed**（unit 39 + integration 10；含监控、去重、双房间、AI 包、会话内身份） |
| 六平台回归 | 全量套件通过；Bilibili/YouTube/Twitch/抖音/TikTok/Kick 协议与测试未改 |
| 十语言字典 | 10 × 2,351；缺失/多余/占位符/空值/英文残留 0 |
| 真实浏览器 UI | **80/80**（10 语 × 1440/1024/820/390 × 明暗；告知/授权/身份/礼物说明可见，无溢出，无原始键；每语 1440 light 执行链接解析 + 禁用开始按钮检查） |
| 发布 EXE | `dist/LiveMemory.exe`；**99,492,352 bytes**；SHA-256 `58b21dc9cb362a8f4918924aae6ab12792b198ee342f0a805ddbcb8d830471ac`；Build ID `47b42dc8417b`；提交 `9ae4a37f406a79ce8ae8addeb6e74c3b2ad90cf9`；Manifest **requireAdministrator** |
| EXE 验收 | `verify-kuaishou-exe.mjs` **10/10**；`verify-exe.mjs` **11/11**；`verify-help-exe.mjs` **14/14** |
| 真实 H5 | **未执行**（无许可） |
| 真实 EXE 采集 | **未执行** |
| 真实下播→再开播 | **未执行** |
| 礼物/点赞 | **NOT-OBSERVED** |

### 0.60.4 未做 / 保持阻塞

- 未向快手发起真实 H5 请求；未取得书面许可；未做真实许可下验收。
- 未实现礼物/点赞/进入/关注映射；未实现登录/扫码/签名/WebSocket。
- 未验证跨场/跨日身份稳定性；未提供跨场合并。
- **快手在线采集未开放**；本版仅正式发布预览组件，不把快手标记为已支持采集。
- 真实双击 UAC、干净 Windows 账户仍未人工验证。

### 0.60.5 Git

- 分支：`main`（已合并 `kuaishou-g1_5`；发布时 Push）。
- 功能提交：`d49047af32f18b271b00043c1e19db44dd796fb8`
  （`feat: integrate Kuaishou H5 preview with collection disabled`）。
- main 合并提交：`9ae4a37f406a79ce8ae8addeb6e74c3b2ad90cf9`
  （`merge: release Kuaishou H5 preview (v0.17.0)`）。
- 发布 Tag：`v0.17.0`（annotated，tag object `4cf356a` → 提交 `5807e3e`）。
- `v0.16.0` Tag/Release/资产未动；`main` 原 `6f71f56` 已包含在合并历史中。

### 0.60.6 v0.17.0 正式发布记录

| 项目 | 值 |
| --- | --- |
| Release | **LiveMemory v0.17.0 — Kuaishou H5 Preview (Live Collection Disabled)** |
| Release URL | `https://github.com/zgrg29/LiveMemory/releases/tag/v0.17.0` |
| Release ID | `448828056` |
| 状态 | `draft=false` / `prerelease=false` / `published_at 2026-11-17T15:31:37Z` |
| Push | `main`：`6f71f56..5807e3e`；Tag `v0.17.0` 新推送；发布记录提交 `de3b041` 随后 Push |
| Tag | annotated `v0.17.0`（object `4cf356a27ea73e402520bb0df0ccb38455c60bae` → commit `5807e3e7dcb183fdd09515baacf0c4193591a7c2`） |
| 资产 1 | `LiveMemory.exe`：99,492,352 B，SHA-256 `58b21dc9cb362a8f4918924aae6ab12792b198ee342f0a805ddbcb8d830471ac` |
| 资产 2 | `SHA256SUMS.txt`：82 B，SHA-256 `dfa9716b10e291104877999a114197a2410a15164e7c2f5cf49303a377001879` |
| Release body | 与 `docs/release-notes/v0.17.0.md` 逐字节一致（SHA-256 `3454b3d05d9b3d4ed6f37ac381741a743ae4bbc2c99e9bb529cd8f1180ae0e7b`） |
| 下载复核 | EXE 99,492,352 B、SHA-256 `58b21dc9…830471ac` 与本地一致；`SHA256SUMS.txt` 内容一致 |
| 页面 | Release 页 200、`/releases/latest` 200、`v0.16.0` 页 200 |
| 旧版本 | `v0.16.0`（Release ID `448187380`）与资产未修改 |

> 快手在线采集仍未开放：Release Notes、README、界面与 API 均标注预览/采集禁用；
> 真实 H5 采集、真实 EXE 采集、许可下长测、跨场身份与礼物/点赞仍未验证。

---

## 0.61 OpenCode Provider 接入：Provider 注册、官方 Endpoint、模型列表与会话头（2026-11-18）✅ 已随 v0.18.0 发布 · 无真实 Key

### 0.61.1 结论

- **OpenCode 已作为正式可选择的 AI 服务商接入**。复用既有 OpenAI-compatible 适配器
  （Chat Completions），未新增第二个请求协议、未重构 AI 系统、未新增运行时依赖。
- **自动 Endpoint**：选择 OpenCode 后只需填 API Key、选 Region、选/填 Model ID；
  Pay-as-you-go 与 Go 分别使用官方 Base URL 与模型列表 URL（复用既有 Region 选择器）。
- **动态模型列表**：官方 `/inference/v1/models` 真实返回 87 个 `type=chat` 模型；
  解析 `cost`（USD/1M）、`limit.context`、`capabilities.structured_output`。
  手动填写 Model ID 仍然保留。
- **必要请求头**：`User-Agent: LiveMemory/<version>` 与 `x-opencode-session`。
  Go 缺该头会在鉴权前返回 **HTTP 400 `MissingSessionID`**（已实测）；LiveMemory 在 Go Region
  缺失 id 时**请求前**失败，不浪费请求。
- **会话稳定性**：session id 由 `ai_jobs.id`（翻译用 session+目标语言，能力检测用单次标识）
  确定性推导为 `ses_<hash>`。同一任务的分批、聚合、补答、自动重试、暂停/重启/Resume 复用
  同一 id；并行任务互相隔离；未新增数据库列。
- **价格可选**：不填价格照常分析；不虚构价格；Provider 自报的 `usage.cost` 作为
  `providerReportedCost` 单独保存。
- **十语**：Provider 列表与使用说明加入 OpenCode；**键数仍 2,351，无新键**。
- **版本 / Schema**：`0.18.0` / **16**（无迁移）；**已随 v0.18.0 正式发布**。

### 0.61.2 官方 API 事实（2026-11-18 实测）

| 项目 | 结果 |
| --- | --- |
| 文档 | `https://opencode.ai/docs/console/api`、`/inference`、`/models`、`/harnesses`、`/go` |
| 协议 | OpenAI Chat Completions（另有 Responses / Anthropic / Gemini；LiveMemory 只用 Chat Completions） |
| Pay-as-you-go Base URL | `https://opencode.ai/inference/openai/v1` |
| Go Base URL | `https://opencode.ai/inference/go/openai/v1` |
| 模型列表 | `/inference/v1/models` 与 `/inference/go/v1/models`；公开可读，带无效 Key 返回 401 |
| 鉴权 | `Authorization: Bearer oc_sk_…` |
| Go 必需头 | `x-opencode-session`；缺失时 **400 `MissingSessionID`**（带任意非空值后进入鉴权 → 401） |
| 流式 usage | `stream_options.include_usage`（官方文档声明） |
| 费用字段 | `usage.cost`（USD）；`usage.opencode.billing_source/list_cost/tokens` |
| 免费层 | 第三方客户端对免费聊天模型返回 **403**；LiveMemory 只声称付费模型可用 |

### 0.61.3 修改范围

| 文件 | 变更 |
| --- | --- |
| `src/ai/providers/catalog.mjs` | 新增 `opencode` Provider 与 `payg` / `go` Region、`modelsUrl`、`sessionHeader`、`userAgent` |
| `src/ai/providers/session.mjs` | **新增**确定性 `providerSessionId()`（`ses_<sha256 前 32 位>`） |
| `src/ai/providers/adapters.mjs` | Provider 专属头（UA / session）、模型列表 URL、OpenCode 价格/上下文解析、`MissingSessionID` 明确错误、`stream_options` 白名单 |
| `src/ai/providers/pricing.mjs` | **新增** `pricingFromOpenCodeModel()` |
| `src/ai/api/runner.mjs` | 按 `ai_jobs.id` 传稳定 session id |
| `src/ai/providers/verify.mjs` | 能力检测的 5 个请求共用一个检测 session |
| `src/ai/translation/service.mjs` | 翻译按 `session + 目标语言` 使用独立 session |
| `src/web/i18n/*.json` | 十语 Provider 列表与使用说明加入 OpenCode（仅改值，键数不变） |
| `scripts/build-windows.mjs` | 必需模块加入 `session.mjs` |
| README / docs / log | Provider 列表、协议矩阵、AI 契约、路线图、变更记录、测试计划、开发日志 |

未改：其他 Provider 行为、数据库 Schema、金额/身份/去重、AI 任务语言快照、提示词与 Schema、
备份设置白名单（无新设置键）、平台采集代码。

### 0.61.4 测试（真实执行）

| 运行 | 结果 |
| --- | --- |
| 新增单元 `tests/unit/opencode-provider.test.mjs` | **12 passed / 0 failed** |
| 新增集成 `tests/integration/opencode-provider.test.mjs` | **3 passed / 0 failed** |
| 全量单元 | **856 passed / 0 failed / 0 skipped**（23,973 ms） |
| 全量单元 + 集成 | **1,241 passed / 0 failed / 0 skipped**（328,824 ms，`--test-isolation=none`） |
| 发布回归（v0.18.0） | **1,241 passed / 0 failed / 0 skipped**（344,314 ms；856 unit + 385 integration，`--test-isolation=none`） |
| 全量首轮/次轮 | 各 1 个**既有时间敏感测试**失败：`memory-privacy` 的 30 天保留断言依赖真实接收时间（已修正测试夹具，非产品缺陷）；`ai-memory-output-recovery` 的批次计数为既有时序抖动（单跑 8/8 通过）。第三次全量 1,241/1,241 通过。 |
| 真实 OpenCode API | **未执行**（无 Key） |

### 0.61.5 Windows EXE（v0.18.0 正式构建）

| 项目 | 值 |
| --- | --- |
| 构建 | `buildId` **`902109197d8b`**；commit **`3149ffceb2252d457d7eb7a72659bdb6999cd0de`**；builtAt `2026-11-18T12:26:22.159Z`；256 files / 70 required modules |
| 文件 / 大小 | `dist/LiveMemory.exe`（**99,503,104 bytes**）；`dist/release-v0.18.0/LiveMemory.exe` 与 `build/LiveMemory-0.18.0.exe` 为同一产物 |
| SHA-256 | `285cfd822b9a6535d0998c98bc5c5d5eee8a502a71c96a3bc02c68d09e62957f` |
| `SHA256SUMS.txt` | `285cfd…2957f  LiveMemory.exe`；82 B；SHA-256 `0400aa9bffa2ca6f6b10d97cc454551c2b3f2dcfdd7527f8dc1f2f901e1b626a` |
| Manifest | **`requireAdministrator`**（构建断言 + 注入后复读） |
| 启动 / 版本 | `--version` = `0.18.0`；Build `0.18.0 (commit 3149ffc, assets 902109197d8b938c3def)` |
| `verify-exe` | **11/11 passed**：fresh data、SQLite、live console、restart、crash recovery、denied folder、another folder、extracted-app reuse、十语 i18n、CLI |
| `verify-help-exe` | **14/14 passed** |
| `verify-ai-token-exe` | **16/16 passed**：真实 EXE 内 mock Provider 的画像、usage、断点恢复、认证、备份 |
| 构建路径说明 | 构建时 `dist/LiveMemory.exe` 被另一个进程以独占方式占用（`EBUSY`），因此先用**同一源码、同一构建脚本**在隔离副本中构建并验收（`build/LiveMemory-0.18.0.exe`）。发布后占用解除，已把同一产物同步到 `dist/LiveMemory.exe`、`dist/SHA256SUMS.txt`、`dist/README.md` 与 `dist/release-v0.18.0/`；三处 EXE 的 SHA-256 均为 `285cfd82…2957f`。 |
| 未验证 | 真实双击 UAC（同意/拒绝）、干净 Windows 账户；EXE 未签名 |

### 0.61.6 未完成 / 限制

- **无真实 OpenCode Key**：未发真实推理、未验证真实 200/429/5xx、真实模型输出、真实账单。
- 免费层模型对第三方客户端 403；模型列表会显示 `$0`，但不代表 LiveMemory 可用。
- `json_schema` 未声明（官方未承诺 Chat Completions 支持），继续用提示词 Schema + 本地校验。
- Claude 等模型元数据标注 `temperature: false`；请求仍按既有形状发 `temperature: 0`，
  Console 是否丢弃该参数未验证。
- Go 官方定位为编码代理；LiveMemory 按要求发送自身 UA 与 session id，不伪装编码代理；
  若平台限制非编码代理流量则如实失败，不绕过。
- 真实双击 UAC、干净 Windows 账户仍未人工验证。

### 0.61.7 v0.18.0 发布记录（2026-11-18）

| 项目 | 值 |
| --- | --- |
| Release | **LiveMemory v0.18.0 — OpenCode AI Provider** |
| Release URL | `https://github.com/zgrg29/LiveMemory/releases/tag/v0.18.0` |
| Release ID | `449956670` |
| 状态 | `draft=false` / `prerelease=false` / `published_at 2026-11-18T12:30:18Z` |
| Push | `main`：`6dffc61..adef993`；Tag `v0.18.0` 新推送 |
| Tag | annotated `v0.18.0`（object `79a76e9dab2e895689d829d5a233bac013073d46` → commit `3149ffceb2252d457d7eb7a72659bdb6999cd0de`） |
| 资产 1 | `LiveMemory.exe`：99,503,104 B，SHA-256 `285cfd822b9a6535d0998c98bc5c5d5eee8a502a71c96a3bc02c68d09e62957f` |
| 资产 2 | `SHA256SUMS.txt`：82 B，SHA-256 `0400aa9bffa2ca6f6b10d97cc454551c2b3f2dcfdd7527f8dc1f2f901e1b626a` |
| Release body | 与 `docs/release-notes/v0.18.0.md` 逐字节一致（SHA-256 `50040e27dc64ae450d3fb31644d216e8e746bc7763160b1fe77212ea84fe6e96`） |
| 下载复核 | EXE 大小与 SHA-256 与本地一致；`SHA256SUMS.txt` 内容一致；Release 页与 `/releases/latest` 200 |
| 旧版本 | `v0.17.0`（Release ID `448828056`）与资产未修改 |

> OpenCode 真实付费推理仍未验收（无 Key）；Go 未真实验收；免费层模型对第三方客户端 403。
> 快手在线采集仍未开放。

---

## 0.62 AI Provider 配置保存可靠性修复（2026-11-18）✅ 已随 v0.19.0 正式发布

> 本节保留修复阶段的本地构建与验收记录；**正式发布构建、资产与 Release 以 §0.63 为准**。

### 0.62.1 结论与真实根因

用户反馈“点击保存提示 API 配置无效、开发者无法复现”。本轮用隔离数据目录与真实本地 HTTP
路由复现出**多个独立缺陷**，不是单一原因：

1. **Base URL 原始字符串比较**（`src/ai/providers/store.mjs`、`src/web/js/pages/ai-settings.js`）：
   旧配置 `https://api.deepseek.com/` 与表单发送的规范值 `https://api.deepseek.com` 被当成
   “换了端点”。官方 Provider 因此返回 `AI_PROVIDER_REGION_KEY_REQUIRED`，自定义 Provider
   则轮换 `credentialReference` 却**不写新 Key**，造成静默丢 Key。已复现：旧 DeepSeek /
   OpenCode 配置保存返回 400；旧自定义配置保存后 `hasCredential=false`。
2. **API Key 尾部换行**（`store.mjs:#validateKey`）：代码在 `trim()` 之前拒绝 `\r\n`，而前端
   直接发送输入框原值。从服务商页面复制 Key 常带尾部换行，于是合法 Key 被拒绝，UI 又只显示
   “API 配置无效”。已复现：`sk-valid\n` 返回 400 `AI_PROVIDER_KEY_INVALID`。
3. **所有错误统一成 `errors.aiProviderConfigInvalid`**（`src/server/routes.mjs`）：已知错误码
   虽然不同，`messageKey` 全部是同一句；凭据权限、文件锁、磁盘满、损坏配置也都落入该提示。
4. **凭据写入非事务**（`store.mjs`、`src/platforms/shared/secret-store.mjs`）：旧 `update()`
   在写新 Key/保存配置前删除旧 Key；`create()` 先写 Key 再写配置；凭据库损坏时
   `load()` 返回 `null`，下一次保存会把整个库覆盖成只剩新 Key。
5. **自定义端点 OpenCode 缺少会话头**（`src/ai/providers/adapters.mjs`）：自定义 Provider 没有
   `sessionHeader`，Go 端点在鉴权前返回 400 `MissingSessionID`。
6. **完整表单保存把 `contextLength: null` 变成 `0`**（`store.mjs:#validate`）：`merged` 中已有
   `null`，`Number(null) === 0` 被当成有效值。

### 0.62.2 修复

| 文件 | 修复 |
| --- | --- |
| `src/ai/providers/url-safety.mjs` | 新增 `sameBaseUrl()` / `canonicalBaseUrlKey()`：尾斜杠、主机大小写、默认端口视为同一端点 |
| `src/ai/providers/store.mjs` | 外层 trim 后再校验 Key；已知 Provider 写回规范 Base URL；端点未变保留 credential reference；先写新凭据→保存配置→成功后删旧；失败回滚；损坏凭据库/配置拒绝覆盖并保留备份；`contextLength` null 不再变 0 |
| `src/platforms/shared/secret-store.mjs` | 新增 `CredentialStoreError`、`loadDetailed()`、`strictKey`；区分文件缺失/损坏/密钥损坏，Provider 库任何不可读状态都拒绝写入 |
| `src/ai/providers/adapters.mjs` | 仅对 `opencode.ai` / `*.opencode.ai` 的自定义 Base URL 补发 `x-opencode-session` 与 `User-Agent` |
| `src/server/routes.mjs` | `providerConfigError()` 返回具体 code/messageKey/httpStatus；EACCES/EPERM、EBUSY、EROFS、ENOSPC、ENOENT、凭据库错误分别映射；GET 返回 `loadState` 与 `credentialError` |
| `src/web/js/pages/ai-settings.js` | 保存/测试错误显示在按钮旁（`role=alert`），显示可复制错误码与路径；修正尾斜杠比较；发送前 trim Key；配置加载失败与凭据库不可读顶部告警 |
| `src/web/i18n/*.json` | 十语新增 20 个具体错误 + 2 个 UI 诊断键（2,351 → **2,373**），键集/占位符一致 |
| `src/launcher/launcher.mjs` | 启动日志新增 `data-dir.identity`（当前账户、USERPROFILE、LOCALAPPDATA、数据目录、source、crossProfile） |

**没有改变**：Provider 协议、请求格式、数据库 Schema（仍 16）、任务语言快照、金额/身份/去重、
平台采集、备份白名单、UAC/Manifest、ACL 规则、本地 API 会话认证与凭据加密算法。保存仍然
**不调用 Provider 网络**；能力检测仍是独立按钮。

### 0.62.3 复现与自动化测试

| 场景 | 结果 |
| --- | --- |
| 全新安装、无配置 | ✅ 集成：providers 列表 8 个、configs 空、loadState 正常 |
| 已有有效配置 | ✅ 集成：保存/编辑/重启保留 |
| 已有无效/不完整配置 | ✅ 单元：损坏 JSON、未知 Provider 记录、空 credentialReference |
| 旧版本升级 | ✅ 单元/集成：旧字段忽略、尾斜杠 Base URL、旧配置读取 |
| OpenCode → DeepSeek | ✅ 集成：无新 Key 明确 400 `AI_PROVIDER_REGION_KEY_REQUIRED`；有新 Key 保存成功且不重复 |
| DeepSeek → 自定义 Provider | ✅ 集成：新 Key 保存成功 |
| API Key 更新/重新保存 | ✅ 单元/集成：同引用更新、失败回滚、重启后仍存在 |
| 本地凭据文件不可写 | ✅ 单元/集成：EACCES → 500 `AI_PROVIDER_CREDENTIAL_PERMISSION`，旧 Key 保留 |
| 配置文件被锁定 | ✅ 单元/集成：EBUSY → 409 `AI_PROVIDER_FILE_LOCKED`，原配置保留 |
| 网络断开但格式合法 | ✅ 集成：保存期间 `fetch` 一旦调用即失败；POST/PATCH 仍成功 |
| 保存失败后再次保存 | ✅ 集成：锁失败后恢复并重试成功 |
| 重启 EXE 后配置仍存在 | ✅ 集成重启；Windows EXE 结果见 §0.62.4 |
| 真实 Provider Key | **未执行**：保存流程不需要真实 Key；能力检测/真实推理仍待 Key |

自动化结果：

- 新增 `tests/unit/provider-config-save.test.mjs` **14 passed**；
  `tests/integration/provider-config-save.test.mjs` **13 passed**；
  新增 `tests/helpers/faulty-fs.mjs`。
- 全量单元 **871 passed / 0 failed / 0 skipped**（20,859 ms）。
- 全量集成 **398 passed / 0 failed / 0 skipped**（374,382 ms）。
- 合计 **1,269 passed / 0 failed / 0 skipped**（分两次以 `--test-isolation=none` 运行）。
- 十语言字典：10 × **2,373**，键集/占位符/空值/英文残留 0。

### 0.62.4 Windows EXE 验收

| 项目 | 值 |
| --- | --- |
| 构建 | `dist/LiveMemory.exe`；Build ID **`70db54b950e7`**；commit **`a2d06e6`**；builtAt `2026-11-18T13:11:15.824Z`；256 files / 70 required modules |
| 大小 / SHA-256 | **99,551,744 B** / `e8f9751f61651d22dc0d2c1935e10463009b8e53b5d69d88364f049c4226f9f4` |
| Manifest | **`requireAdministrator`**（构建断言 + 注入后复读） |
| 新验收 | `scripts/verify-provider-save-exe.mjs` **14/14 passed**：真实 EXE 内 fresh install、DeepSeek 保存、Key 尾换行、配置/Key 重启保留、旧尾斜杠保存、OpenCode→DeepSeek、DeepSeek→自定义、凭据写失败、失败重试、损坏凭据库不覆盖、损坏配置保留备份 |
| 回归 | `scripts/verify-exe.mjs` **11/11**；`scripts/verify-help-exe.mjs` **14/14**；`scripts/verify-ai-token-exe.mjs` **16/16**（真实 EXE 内 mock Provider 的画像、usage、断点恢复、认证、备份） |
| 说明 | 正式 EXE 为 `requireAdministrator`；自动化使用同源码/同 buildId 的 `asInvoker` 副本（`prepareTestExe`），不修改正式 EXE、不绕过 UAC |
| 发布资产 | `dist/release-v0.18.0/`、`v0.18.0` Tag/Release 与旧 `SHA256SUMS.txt` **未修改**；`dist/LiveMemory.exe` 是本地未发布构建 |
| 未验证 | 真实双击 UAC（同意/拒绝）、干净 Windows 账户、跨管理员账户 over-the-shoulder、真实 Windows 删除权限提示 |

### 0.62.5 兼容性与升级结论

- **数据库 / 业务数据**：Schema 仍 16，无迁移；直播记录、观众、画像、AI 任务与报告不变。
- **已有配置 / 凭据**：读取路径兼容；不改写正常配置；仅当配置损坏/未知格式时保留
  `ai-providers.json.<reason>-<timestamp>.json` 备份。正常保存不删除其他 Provider 的 Key。
- **是否必须升级**：**是**。`v0.18.0` 正式发布资产仍包含上述保存缺陷；本修复已包含在
  **v0.19.0** 中，用户升级到 v0.19.0 后获得。
- **仍需人工验证**：真实双击 UAC（同意/拒绝）、干净 Windows 账户、不同管理员账户的
  over-the-shoulder 启动、真实 Windows 原生删除/权限提示。本轮不声称这些已通过。
- **发布状态**：已随 v0.19.0 发布，见 §0.63。

### 0.62.6 Git

- 代码/测试提交：`a2d06e6`（`fix: make AI provider configuration saves reliable`）。
- 文档/验收记录提交：`5fbda2b`（`docs: record AI provider save reliability investigation and acceptance`）。
- 版本 / Schema：修复阶段为 `0.18.0`，正式发布为 `0.19.0` / 16。

## 0.63 v0.19.0 正式发布：AI Provider Reliability Update（2026-11-18）

### 0.63.1 结论

- **正式发布**：版本 `0.19.0`，数据库 Schema **16**（无迁移）。
- 内容：v0.18.0 发布后的 AI Provider 配置保存可靠性修复，详见 §0.62。
- 未改直播平台协议、金额/身份/去重、提示词、任务语言快照、UAC/Manifest、凭据加密算法。
- 快手仍为**预览、实时采集禁用**；六个已发布平台状态未变。

### 0.63.2 自动化

| 项目 | 结果 |
| --- | --- |
| 全量测试 | **1,269 passed / 0 failed / 0 skipped**（871 unit + 398 integration；单次全量 `--test-isolation=none`，365,726 ms） |
| Provider 保存专项 | 14 unit + 13 integration |
| 十语言字典 | 10 × 2,373；键集/占位符/空值/英文残留 0 |

### 0.63.3 正式 EXE 与发布资产

| 项目 | 值 |
| --- | --- |
| 文件 | `dist/LiveMemory.exe` |
| 版本 / Manifest | `0.19.0` / `requireAdministrator` |
| Build ID / commit | **`252939f4d41b`** / **`50920d1`**；builtAt `2026-11-18T13:28:10.722Z`；256 files / 70 required modules |
| 大小 / SHA-256 | **99,551,744 B** / `901f92fd35274833456d9755fc77a7beabe7d33e3fb0c165fd6fd5a82bb64fc9` |
| `SHA256SUMS.txt` | 82 B；SHA-256 `9ee83678287d7ad4eafb7e867a3d91a17085a1a0fbdd55d43031d0a889ece952`；内容 `901f92fd…64fc9  LiveMemory.exe` |
| EXE 验收 | `verify-provider-save-exe` 14/14、`verify-exe` 11/11、`verify-help-exe` 14/14、`verify-ai-token-exe` 16/16 |
| 下载复核 | GitHub 重新下载：EXE 99,551,744 B / SHA-256 `901f92fd…64fc9` 与本地一致；`SHA256SUMS.txt` 82 B / SHA-256 `9ee83678…ece952`、内容一致；Release 页与 `/releases/latest` 均 200 |

### 0.63.4 发布记录

| 项目 | 值 |
| --- | --- |
| Release | **LiveMemory v0.19.0 — AI Provider Reliability Update** |
| Release URL | `https://github.com/zgrg29/LiveMemory/releases/tag/v0.19.0` |
| Release ID | **`450031601`** |
| 状态 | `draft=false` / `prerelease=false` / `published_at 2026-11-18T13:32:13Z` |
| Tag | annotated `v0.19.0`（object `5e366a228a8fea5def069754285c0678e69efbfd` → commit `50920d1ebf8e2daf270b610d1f960737e781979c`） |
| Push | `main`：`142ec4a..50920d1`；Tag `v0.19.0` 新推送 |
| Release body | 与 `docs/release-notes/v0.19.0.md` 逐字节一致（SHA-256 `de9fe7ba9c4f18f4e725b0030802f44507641d3c6e3c5f8041e5123ece56d30f`） |
| 旧版本 | `v0.18.0`（Release `449956670`）与资产未修改 |
| 未验证 | 真实双击 UAC、干净 Windows 账户、跨管理员账户 over-the-shoulder、真实 OpenCode 付费推理 |

### 0.63.5 兼容性

- 数据库 Schema 仍 16；已有直播记录、观众、画像、AI 任务与报告不需要迁移。
- 正常 Provider 配置与加密 Key 保留；损坏文件先备份，不要求用户删除配置或重装。
- 升级方式：替换 `LiveMemory.exe`；建议先创建完整备份。

---

## 0.64 AI Provider 凭据迁移至 Windows Credential Manager（2026-11-18，已随 v0.19.1 发布）

### 0.64.1 结论

- **已选择 Windows Credential Manager 作为 AI Provider API Key 的主存储**。每个
  `credentialReference` 对应一个 Generic Credential（`LiveMemory/ai-provider/v1/<ref>`），
  由 Windows DPAPI 保护并按当前 Windows 用户 SID 隔离；`CRED_PERSIST_LOCAL_MACHINE`
  在 Windows 重启后保留。
- **不再把 AI Key 写入 `<数据目录>/secrets/ai-keys.json`**。该文件只作为旧数据迁移来源与
  加密只读回退保留；新 Key 不会写回。旧文件不删除、不改名、不覆盖。
- **旧用户可无损迁移**：启动时逐个写入并读回校验；全部引用的 Key 校验成功后才写
  `secrets/ai-keys.migration.json` 标记。迁移失败/旧库损坏时只告警，新 Key 仍可保存并可重试。
- **已知 `AI_PROVIDER_CREDENTIAL_PERMISSION` 这一类“凭据文件 ACL/可写性”故障被消除**：
  新路径不再依赖数据目录内凭据文件的 ACL；但仍不能消除所有 Windows 数据目录/配置文件权限
  故障（例如整个数据目录不可写、配置文件被锁定）。
- **Windows 账户隔离不绕过**：`requireAdministrator` + over-the-shoulder 使用另一管理员账户时，
  Credential Manager 属于该账户；LiveMemory 不读取其他账户 vault，也不修改其他账户 ACL。
  该场景下原账户的 Key 不可见，需要重新输入；这是 Windows 隔离，不是数据丢失。
- **已随 v0.19.1 正式发布**；发布证据见 §0.65。

### 0.64.2 实现

| 文件 | 变更 |
| --- | --- |
| `src/platforms/shared/credential-store.mjs` | **新增**：Credential Manager 后端、固定 PowerShell + 内嵌 C# P/Invoke、分块、错误分类、文件后端适配器 |
| `src/ai/providers/store.mjs` | 凭据读写改走后端接口；旧 AES 迁移/只读回退；迁移标记；Provider 切换/回滚/删除/清空逻辑保留 |
| `src/server/index.mjs` / `src/launcher/launcher.mjs` | 生产启动显式启用 Windows 后端；测试/嵌入默认仍用隔离文件后端 |
| `src/server/routes.mjs` | 新增后端不可用/拒绝访问/写入失败/损坏错误映射；错误详情只含稳定码/后端/Win32 |
| `src/server/maintenance.mjs` | 恢复出厂设置清理当前配置引用的 vault 条目，并如实报告失败 |
| `src/platforms/shared/secret-store.mjs` | 旧文件 ACL 改为“先授权当前 SID 完全控制，再移除继承”，避免 `(R,W)` 缺 DELETE 导致后续原子改名失败 |
| `src/web/js/ui.js` | `describeError()` 把 `details` 传给 `t()`，修复 `{path}`/`{code}` 原样显示 |
| `src/web/js/pages/ai-settings.js` | 旧凭据迁移失败/新后端不可用告警；保存错误仍显示在按钮旁 |
| `src/web/i18n/*.json` | 十语新增 6 个错误/诊断键（2,373 → **2,379**） |
| `scripts/build-windows.mjs` | 可靠性必需模块加入 `credential-store.mjs` |
| 测试/脚本 | 新增 unit、integration、opt-in 真实 CredMan 测试；扩展 `verify-provider-save-exe.mjs` |

### 0.64.3 安全性 / 传递路径

- Key 只通过 **stdin** 传给固定 PowerShell 脚本；不进入 argv、环境变量、临时明文文件、
  配置 JSON、日志、备份、ZIP、数据库导出或 HTML。
- PowerShell 只执行固定脚本，不含用户可控代码；C# P/Invoke 只调用
  `CredWriteW` / `CredReadW` / `CredDeleteW`。
- Add-Type 编译器临时目录指向 `<数据目录>\cache\`，避免受限账户对默认 `%TEMP%` 的 ACL 差异。
- 不引入第三方云服务、运行时 npm 依赖或原生 Node addon；PowerShell 是 Windows 内置组件。
- 失败时不显示成功；没有明文回退。旧 AES 文件回退仅用于已存在、可读的旧密文。

### 0.64.4 测试（真实结果）

| 项目 | 结果 |
| --- | --- |
| 新增 unit | `credential-store.test.mjs` 10 项；`provider-credential-migration.test.mjs` 8 项 |
| 新增 integration | `provider-credential-store.test.mjs` 7 项；`windows-credential-manager.test.mjs` 2 项（默认 skip，opt-in 真实 vault） |
| 全量 unit | **889 passed / 0 failed / 0 skipped**（最终复跑 24,925 ms） |
| 全量 integration | **405 passed / 0 failed / 2 skipped**（最终复跑 359,924 ms；skip 为 opt-in 真实 CredMan） |
| 真实 CredMan（opt-in） | **2/2 passed**：保存/读取/更新/大 Key 分块/删除/旧 AES 迁移；随机 target 自动清理 |
| 真实 EXE | `verify-provider-save-exe` **24/24 passed**；最后一项验证 7 个测试 vault 引用已清理 |
| EXE 回归 | `verify-exe` **11/11**、`verify-help-exe` **14/14**、`verify-ai-token-exe` **16/16** |
| 全量合计 | **1,294 passed / 0 failed / 2 skipped**（889 unit + 407 integration） |
| 十语言 | 10 × **2,379**，键集/占位符/空值/英文残留门禁通过 |

覆盖场景：全新安装、旧版本迁移、多 Provider 独立保存、修改/删除、保存失败回滚、旧库损坏、
旧库权限不足、EXE 重启持久化、Credential Manager 不可用/拒绝访问、不同 Windows 账户隔离
（自动化无法真实切换账户，仅以 SID 隔离设计与文档说明，未人工验收）。

最终 v0.19.1 EXE 的 Build ID、大小与 SHA-256 见 §0.65。
`verify-exe` 在本机低完整性测试会话中首次使用真实 `%LOCALAPPDATA%` 时被 ACL 拒绝
（Bootstrap `EPERM`，环境限制，不是产品回归）；把 `LOCALAPPDATA`/`TEMP` 指向工作区可写
测试目录后 **11/11**。`verify-provider-save-exe` 使用隔离数据目录与 asInvoker 副本，
未使用真实 `%LOCALAPPDATA%`。

### 0.64.5 仍未验证 / 环境限制

- **真实 Windows 重启后持久化**：未执行整机重启；使用 EXE 完全退出/重启与
  `CRED_PERSIST_LOCAL_MACHINE` 设计作为证据，不得写成“已实测重启”。
- **真实不同 Windows 账户隔离**：未在第二个 Windows 账户下人工验收；自动化不切换账户。
- **真实 UAC over-the-shoulder**：未人工验证；文档说明其 vault 归属。
- **Credential Manager 被组策略/PowerShell 禁用**：单元/集成使用注入后端验证错误分类；
  未在真实被禁用的 Windows 环境中验收。
- **干净 Windows 环境**：未验收；EXE 未签名，SmartScreen 仍可能提示。
- Windows Server Core / 移除 Windows PowerShell 的环境不支持；会明确返回
  `AI_PROVIDER_CREDENTIAL_BACKEND_UNAVAILABLE`，不回退明文。

### 0.64.6 交付状态

- 功能提交：`a9c95d7a9b36d978727c31efc436f3c825c33202`
  （`fix: store AI provider keys in Windows Credential Manager`）；验收文档
  `f849ad0df4a6a2b88df7d56d57db97e6522927f6`。
- 已作为 **v0.19.1** 正式发布；版本、构建、Tag 与 Release 见 §0.65。
- 发布前已按 `docs/RELEASE.md` 复跑全量测试、真实 EXE 验收与文档检查。

---

## 0.65 v0.19.1 正式发布：Windows Credential Storage Fix（2026-11-19）

### 0.65.1 结论

- **正式发布**：版本 `0.19.1`，数据库 Schema **16**（无迁移）。
- 内容：AI Provider API Key 迁移至 Windows Credential Manager，修复部分 Windows 用户
  保存时遇到的 `AI_PROVIDER_CREDENTIAL_PERMISSION` 凭据文件权限故障。
- 未改直播平台协议、金额/身份/去重、任务语言快照、提示词、数据库 Schema、UAC/Manifest。
- 快手仍为**预览、实时采集禁用**；六个已发布平台状态未变。
- **未新增用户配置步骤**；旧配置与可读旧 Key 自动迁移，旧凭据文件不删除。

### 0.65.2 自动化

| 项目 | 结果 |
| --- | --- |
| 全量测试 | **1,294 passed / 0 failed / 2 skipped**（889 unit + 407 integration；单次全量 354,405 ms；2 skip 为 opt-in 真实 CredMan） |
| 真实 CredMan | **2/2 passed**：保存/读取/更新/大 Key 分块/删除/旧 AES 迁移；随机 target 自动清理 |
| 十语言字典 | 10 × **2,379**；键集/占位符/空值/英文残留 0 |
| 文档检查 | `scripts/check-docs.mjs` 通过 |

### 0.65.3 正式 EXE 与发布资产

| 项目 | 值 |
| --- | --- |
| 文件 | `dist/LiveMemory.exe` |
| 版本 / Manifest | `0.19.1` / `requireAdministrator` |
| Build ID / commit | **`b66818d032b5`** / **`04b30b7`**；builtAt `2026-11-18T16:38:14.404Z`；257 files / 71 required modules |
| 大小 / SHA-256 | **99,609,088 B** / **`4d230f5f1f66302a68f3403e38bde5427827e6d7371b31f1e3121655cd369542`** |
| `SHA256SUMS.txt` | 81 B；SHA-256 `7ca49114b520abb2c26551f3dc7dcb882b46890c5a3ce01af631f7fc2e092284`；内容 `4d230f5f…369542  LiveMemory.exe` |
| EXE 验收 | `verify-provider-save-exe` 24/24、`verify-exe` 11/11、`verify-help-exe` 14/14、`verify-ai-token-exe` 16/16 |
| 未验证 | 整机 Windows 重启、第二 Windows 账户、真实 UAC over-the-shoulder、组策略禁用 PowerShell/CredMan、干净 Windows 环境 |

`verify-exe` 在本机低完整性测试会话中首次使用真实 `%LOCALAPPDATA%` 时被 ACL 拒绝
（Bootstrap `EPERM`，环境限制，不是产品回归）；把 `LOCALAPPDATA`/`TEMP` 指向工作区可写
测试目录后 11/11。`verify-provider-save-exe` 与 `verify-ai-token-exe` 结束时会清理测试
Credential Manager 条目；发布验收后确认无残留。

### 0.65.4 发布记录

| 项目 | 值 |
| --- | --- |
| Release | **LiveMemory v0.19.1 — Windows Credential Storage Fix** |
| Release URL / ID | `https://github.com/zgrg29/LiveMemory/releases/tag/v0.19.1` · **`450272261`** |
| 状态 | `draft=false` / `prerelease=false` / `published_at 2026-11-18T16:43:01Z` |
| Tag | annotated `v0.19.1`（object `721690b4b9bc5dd297390336e08193c8bfcf0803` → commit `04b30b7513601916c2284a1d48214ab2d63d3ccc`） |
| Push | `main`：`fea8cbe..04b30b7`；Tag `v0.19.1` 新推送 |
| Release body | 与 `docs/release-notes/v0.19.1.md` 逐字节一致（SHA-256 `9598aa50962dbb6997ed63d76d1dc791904f632a7cd4622269826e001308b391`） |
| 下载复核 | GitHub 重新下载：EXE 99,609,088 B / SHA-256 `4d230f5f…369542` 与本地一致；`SHA256SUMS.txt` 81 B / SHA-256 `7ca49114…092284`、内容一致；Release 页与 `/releases/latest` 均 200，latest 指向 `v0.19.1` |
| 旧版本 | `v0.19.0`（Release `450031601`）与更早资产未修改 |

### 0.65.5 兼容性

- 数据库 Schema 仍 16；已有直播记录、观众、画像、AI 任务与报告不需要迁移。
- 已有 Provider 配置与可读旧 Key 自动迁移；旧 `secrets/ai-keys.json` 不删除/不改名。
- 旧 Key 不可读时保留旧文件并允许重新输入，不阻塞新配置。
- 部分企业组策略环境可能禁用 PowerShell/Credential Manager；保存会明确失败，不退明文、不伪造成功。

---

## 历史记录（§0.59 及更早）

> 以下内容按时间倒序保留，只用于追溯当时的判断、证据与决策。它们**不代表当前状态**：
> 版本号、平台数量、测试数量、未完成项与发布状态均以 §0 和代码/Release 事实为准。
> 例如 §0.59–§0.52 曾记录“快手不接入/不发布”，那都是 v0.17.0 预览发布前的阶段结论。

## 0.59 快手 G1.6：修正旧 ID 后的登录态 WebSocket 复测（2026-11-17）❌ 结论 E · 停止正式接入

### 0.59.1 结论

- **扫码登录再次真实成功（REAL-VERIFIED）**：第二次真人扫码完成
  `qr/start → scanResult=1 → acceptResult=1 → passToken → 直播站换票 result=1 → userLogin=1`；
  全程未实现 `__NS_hxfalcon` / `__NS_sig3`、设备指纹、webweapon/gdfp、验证码、TLS 伪装。
- **旧 ID 解释被排除**：登录后重新取 `home/list`，对 8 个最新在播房间（9,427 → 819 watching）
  逐个调用 `websocketinfo`；**8/8 HTTP 200、`result:2`、无 token、无 websocketUrl**。
- **不是全站 IP 限流**：同一会话下 `home/list` 正常（48 房间）；G1.5 中 `gift-list` 也曾返回 token；
  只有 `websocketinfo` 一致拒绝。
- **技术 gate 未通过**：在不实现签名/设备指纹/验证码/TLS 伪装的前提下无法取得 token，
  因此**没有真实弹幕、没有礼物、没有正式适配器**。
- **授权仍未取得**：官方条款要求书面许可；`open.kuaishou.com` 的弹幕玩法接口是
  app_id + roomCode + sign、面向已入驻玩法开发者的服务端能力，不是“任意公开主播聊天读取 API”。
- **结论 E（停止正式接入）**：不写 `src/platforms/kuaishou/`，不加路由/UI/监控/数据库，不构建发布 EXE，
  不发布；不重新启用 POLICY-BLOCKED 的匿名 H5 作为替代。

### 0.59.2 关键证据

| 项目 | 结果 |
| --- | --- |
| 第二次真人扫码 | **REAL-VERIFIED**；QR/扫码/确认/换票/登录全部 `result:1` |
| 候选房间 | 8 个，来自登录后同一份 `home/list` 快照；最高 9,427 watching |
| `websocketinfo` | **8/8 `result:2`**，HTTP 200，无 token，无 URL |
| 归因 | 旧 `liveStreamId` / 下播 / 全站限流 / 未登录均被排除；剩余 gate 未知但不可绕过 |
| `home/list` 行为 | 连续请求返回不同的 48 个房间；**不是完整库存**，缺席不能判下播 |
| 身份/礼物 | WS 无样本；`NOT-OBSERVED` / `UNSUPPORTED` |
| 单测 | 原型 **10 passed / 0 failed**（含“轮播列表缺席 → unknown”回归） |
| 全量回归 | **1,177 passed / 0 failed / 0 skipped**（`--test-isolation=none`，326,590 ms） |
| 十语言 | 十份字典各 **2,304** 键，键集对齐 0 缺失 / 0 多余；未改 UI |
| 产物 | `docs/KUAISHOU_G1_6_WEBSOCKET_BLOCKED.md`、`live-probe.mjs`、脱敏证据 JSON |

### 0.59.3 本轮修正

- 新增 `research/kuaishou-g1_5/live-probe.mjs`：登录前取快照、登录后重新取快照、
  对多个最新 ID 逐个探测；失败时写脱敏 `ws-token-probe.json`。
- 修正 `lib/status.mjs`：`home/list` 未包含目标房间时返回 `unknown + NOT_IN_RECOMMENDATION_SNAPSHOT`，
  不再误判 `offline`；更新对应测试。
- `scan.html` 改为直接加载 `.state/qr.png`（原先引用的 `qr-large.png` 不存在），
  二维码由浏览器放大显示，自动刷新。
- 未改 `src/`、`package.json`、`scripts/`、`dist/`、版本号。

### 0.59.4 未做 / 禁止

- 未实现签名、设备指纹、webweapon、验证码、TLS/JA3 伪装、代理换 IP、Cookie 导入、浏览器中继。
- 未构建 EXE、未生成候选版本、未改 v0.16.0 Tag/Release。
- 未 Push、未 Merge main、未创建新 Tag/Release。
- 未把 H5 匿名路线重新作为默认采集器。

### 0.59.5 Git

- 分支：`kuaishou-g1_5`（从 G1.5 `ca804ab` 继续；未 Push）。
- 本轮提交 Hash 见交付回复与 `docs/HANDOFF.md`；`main` 仍 `6f71f56`，v0.16.0 资产未动。
- 工作区提交后应干净（`.state/` 未跟踪）。

## 0.58 快手 G1.5：匿名 H5 + 登录 WebSocket 双模式验证（2026-11-17）✅ 验证完成 · 结论 D

### 0.58.1 结论

- **匿名 H5 被官方条款明文禁止**：从官方“法律声明”页 CMS 取得《快手软件许可及服务协议》全文，
  七、1.1 / 七、1.4 / 八、1 / 十、1 明确禁止以机器人、蜘蛛或未经授权的第三方工具监视、复制、
  读取平台内容，且数据使用需**书面许可**；H5 域名 `robots.txt` 仍为 `User-agent: * Disallow: /`。
  → H5 判 **POLICY-BLOCKED**，不得作为正式默认采集器；保留 G1 的 555 条/2h/3 房间证据，不再发起新的 H5 请求。
- **正常扫码登录端到端真实成功（首次）**：`qr/start` 无签名 → 真人扫码 → `scanResult=1` →
  `acceptResult=1` → `callback` 得 `passToken` → `getCdns=1` → 直播站 `passToken` 换票 `result=1`
  → `userLogin=1`（`live.web_st/_ph`）。全程未实现签名/设备指纹/webweapon/验证码/TLS 伪装。
- **登录后 WS token 未验证**：唯一一次 `websocketinfo`（18:41:59）返回 `result:2`、无 token/URL，
  但使用的是 18:34 的旧 `liveStreamId`，目标房间 18:44 复核已下播；因此**不能判定“签名是唯一障碍”，
  也不能判定“平台拒绝”**。已修复方法缺陷：连接前必须重新确认在播，旧 ID 默认拒绝。
- **稳定身份未证明**：G1 H5 229 用户跨 3 房间重叠 0；WS 无样本；跨日/跨路线均无证据。
  原型强制 `h5:` / `ws:` 命名空间隔离，只有显式证据才允许合并。
- **礼物/点赞/分享零真实样本**：协议字段存在（含 feed `id`）→ CODE-SUPPORTED / NOT-OBSERVED。
- **开播监控**：匿名 `home/list` 两次返回 48 个在播房间；发现并修复“无顶层 `result` 被误判为错误”的缺陷；
  目标房间从列表消失已观察；**G1.6 修正：`home/list` 是轮播推荐列表，缺席不能单独判定下播**；
  真实“再开播”未观察。
- **结论 D（暂缓，不进入 G2）**：H5 授权不允许；WS 监听未验证；身份/礼物/长测均缺证据；
  即使 WS 技术复测通过，仍缺平台书面许可。

### 0.58.2 关键证据

| 项目 | 结果 |
| --- | --- |
| H5 合规 | 官方条款明文禁止机器人/蜘蛛监视、复制 + 数据使用需书面许可；robots `Disallow: /` |
| 官方直播开放平台 | `liveopen.kuaishou.com` 为云直播（OBS 推流/拉流），不是聊天读取 API；`open.kuaishou.com` 为小程序文档 |
| QR 生成 | 无 Cookie/无签名 `result:1`，125×125 PNG，约 58 秒过期，自动换码 3 次 |
| 真人扫码 | `scanResult=1` → `acceptResult=1` → callback `passToken` → 直播站换票 `result=1` → `userLogin=1` |
| `websocketinfo` | `result:2`、无 token；旧 `liveStreamId`（7 分钟前），目标随后 offline → **受污染，不作结论** |
| 在播列表 | 18:34 / 18:43 均 48 个房间；18:44 目标不在列表（G1.6 修正：轮播列表缺席只能判 `unknown`，不能单独判 `offline`） |
| 单测 | `research/kuaishou-g1_5/tests/prototype.test.mjs` **10 passed / 0 failed** |

### 0.58.3 本轮产物

- `docs/KUAISHOU_G1_5_DUAL_MODE.md`（完整报告：合规、登录、WS、身份、礼物、监控、G2 清单、结论）。
- `research/kuaishou-g1_5/`（`probe.mjs`、`lib/` 双 transport + normalizer + identity + status + login +
  protocol + errors + http、10 个单测、`scan.html`、`README.md`）。
- `docs/PLATFORM_EXPANSION_RESEARCH.md` §3.5 G1.5 摘要、`docs/ROADMAP.md` P49、
  `log/2026-11-17-kuaishou-g1_5.md`、`THIRD_PARTY_NOTICES.md` G1.5 附录。

### 0.58.4 未做 / 禁止

- 未新增 `src/platforms/kuaishou/`，未改路由/UI/数据库/监控生产代码。
- 未改版本号、未动 v0.16.0 Tag/Release/EXE。
- 未引入依赖、未复制第三方代码、未实现签名/设备指纹/验证码。
- 未跑新的 H5 长测（因 POLICY-BLOCKED）；未完成 WS 真实监听、礼物、跨场身份、再开播。
- 未 Push、未 Merge main、未创建 Tag/Release。

### 0.58.5 Git

- 分支：`kuaishou-g1_5`（从 `kuaishou-g1` `83a2c30` 创建；未 Push）。
- 本地提交：`939f416`（`docs: verify Kuaishou G1.5 login and dual-mode boundaries`）；
  随后以 `docs: record the Kuaishou G1.5 commit` 记录本 Hash。`main` 未改，v0.16.0 资产未动。
- 工作区：提交后干净；`research/kuaishou-g1_5/.state/` 与 `scan.png` 未提交。

### 0.58.6 验证

- `node --test --test-isolation=none research/kuaishou-g1_5/tests/prototype.test.mjs`：**10 passed / 0 failed**。
- `node --check research/kuaishou-g1_5/probe.mjs`、`lib/*.mjs`：通过。
- `git diff --name-only main...HEAD`：只有 `docs/`、`log/`、`research/`、`.gitignore`、`THIRD_PARTY_NOTICES.md`；
  **没有** `src/`、`package.json`、`scripts/`、`dist/` 变更。
- `v0.16.0` Tag 仍存在；`main` 仍为 `6f71f56`。
- 本地提交 `939f416`；工作区提交后干净（`.state/`、`scan.png` 未提交）。

## 0.57 快手 G1 双路线验证（2026-11-17）✅ 验证完成 · 结论 C

### 0.57.1 结论

- **登录态 WebSocket 未能真实验证**：官方 QR `start` 无签名返回 `result:1` + PNG，
  `scanResult`/`acceptResult` 未扫码返回 `707`（不是签名错误）；但完整登录需要真人扫码，
  本轮没有账号/手机 → callback、直播站换票、`websocketinfo`、WS 全部 **[未执行]**。
- **catbus 源码审查完成**：扫码/会话/签名/设备指纹/验证码/WS/心跳/重连/事件/任意房间都读完；
  其 `__NS_hxfalcon` 纯算、gdfp 设备指纹、**滑块自动求解**、`wreq-js` TLS 伪装
  属于用户明确禁止的“非公开签名 / 模拟客户端 / 绕过风控”，**只读参考，未复制**。
- **登录 WS 同样没有消息 ID**（catbus `Event` 无 id）；礼物/点赞/分享 CODE-SUPPORTED 但零实测；
  关注/进入/撤回 UNSUPPORTED。
- **匿名 H5 仍可用**：3 房间/45 秒 6 条；2 小时 3 房间长测 **555 条 / 229 用户 / 0 重复 / 0 HTTP 错误**，
  昵称/数字 userId/时间/头像 100%、消息 ID 0%；跨房间用户重叠 **0**。
- **真实下播已观察**：`juedidatou` 约 13 分钟后持续返回 `result:601` / `"直播已停止"`（1,969 次）；
  再开播未观察，SSR 当时仍被“请求过快”限流。
- **出现软限流**：公开直播间页返回 `"errorType":{"type":2,"title":"请求过快，请稍后重试"}`；
  不能把“没有 liveStream.id”当主播下播。
- **合规门槛未过**：`livev.m.chenzhongtech.com/robots.txt` 对 `User-agent: *` 为 `Disallow: /`；
  登录≠平台采集授权；条款未逐条审阅。
- **跨场/跨日/跨路线稳定 ID 未验证**：H5 `userId` 100% 覆盖、运行内一致，但不能证明跨房间/跨天；
  不得把 `kuaishou:<h5 id>` 与 `kuaishou:<ws principalId>` 合并。

### 0.57.2 评分（G1 权重）

| 路线 | 实时 20 | 稳定 ID 25 | 礼物 15 | 监控 15 | 登录 10 | 长期 10 | 本地 5 | 总分 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 登录态 WS | 17 | 12 | 12 | 12 | 6 | 6 | 3 | **68** |
| 匿名 H5 | 15 | 8 | 1 | 11 | 9 | 6 | 5 | **55** |

两条路线都未通过独立准入（许可证/平台规则），**不能因分数进入 G2**。

### 0.57.3 本轮产物

- `docs/KUAISHOU_G1_POC.md`（完整报告：catbus 源码、登录、双路线、身份、礼物、监控、稳定性、评分、G2 清单）。
- `research/kuaishou-g1/probe.mjs`（零依赖 PoC：discover/status/watch/ws-anon/qr-probe/login/auth/cleanup）。
- `research/kuaishou-g1/README.md`（用法与安全边界）。
- `THIRD_PARTY_NOTICES.md` G1 addendum（未复制任何代码）。
- `docs/PLATFORM_EXPANSION_RESEARCH.md` §3.5、`docs/ROADMAP.md` P48、`log/2026-11-17-kuaishou-g1.md`。

### 0.57.4 未做 / 禁止

- 未新增 `src/platforms/kuaishou/`，未改路由/UI/数据库/监控生产代码。
- 未改版本号、未改 v0.16.0 Tag/Release/EXE。
- 未引入依赖、未复制第三方代码、未实现签名/设备指纹/验证码求解。
- 未 Push、未 Merge main、未创建 Tag/Release。
- 未验证：真实登录 WS、跨场/跨日身份、礼物/点赞/分享、真实再开播、高流量截断、10+ 房间。

### 0.57.5 Git

- 分支：`kuaishou-g1`（从 `kuaishou-g0` `25ee5a9` 创建；未 Push）。
- 本地提交：`a1a99ce`（`docs: verify Kuaishou G1 dual-route feasibility (C)`）；
  随后以 `docs: record the Kuaishou G1 commit` 记录本 Hash。`main` 未改，v0.16.0 资产未动。
- 工作区：提交后干净（仅本轮文档/脚本）。

### 0.57.6 验证

- `node --test --test-isolation=none "tests/unit/*.test.mjs"`：**805 passed / 0 failed / 0 skipped**（24,881 ms，最终复跑）。
- `node --check research/kuaishou-g1/probe.mjs`：通过。
- `git diff --name-only main...HEAD`：只有 `docs/`、`log/`、`research/`、`.gitignore`、`THIRD_PARTY_NOTICES.md`；
  **没有** `src/`、`package.json`、`scripts/`、`dist/` 变更。
- `v0.16.0` Tag 仍存在；`main` 仍为 `6f71f56`。

## 0.56 快手（Kuaishou）G0 技术调查（2026-11-17）✅ 调查完成 · 结论 B

### 0.56.1 结论

- **找到了真正免登录的实时公开聊天路径**：快手 H5 分享页的
  `GET https://livev.m.chenzhongtech.com/wap/live/feed?liveStreamId=<id>&cursor=<cursor>`，
  无 Cookie、无签名、无登录、无浏览器；3 秒增量，cursor 重放 0 重复。
- 真实样本 **126 条**（主样本 91 条 / 5 个在播房间，其中 3 个并发）：昵称、数字 `userId`、毫秒 `time`、公开头像
  **100% 可得**；**消息 ID 0%**；事件类型只有 `comment`（**礼物 NOT-OBSERVED**）。
- 公开直播间页 SSR 的 `liveStream.id` 可判断在播/不在播（无 Cookie）；**真实下播→再开播未观测**。
- 桌面 WebSocket + protobuf 路线字段最全，但 2026 年实现要求**登录票据 + `__NS_hxfalcon` 签名**；
  匿名 `websocketinfo`/`livedetail` 均返回 `result:2`。不满足条件一，不作为接入路线。
- **最高风险**：`livev.m.chenzhongtech.com/robots.txt` 对 `User-agent: *` 为 `Disallow: /`；
  产品化前必须做条款/合规判断。若不允许自动访问该 H5 域名 → 降为 **C（暂缓）**。
- **长期画像限制**：`userId` 形态像账号级 ID，运行内昵称零变化、ID 100% 覆盖；
  但**跨场/跨日稳定性未验证**，不得直接声称 `kuaishou:<id>` 已稳定。

### 0.56.2 评分

| 方案 | 总分 | 关键限制 |
| --- | ---: | --- |
| H5 增量拉取（推荐调查路线） | **78/100** | 无消息 ID、无礼物、跨场 ID 未验证、robots 风险 |
| 桌面 WS + protobuf（登录+sig4） | 78/100 | **免登录 0 分 → 不可准入**；需签名/登录 |
| 登录浏览器拦截 | 63/100 | 需 Chromium + 登录 |
| MITM 代理 | 59/100 | 需代理/客户端 + AGPL |
| 官方 API | 8/100 | 无公开聊天读取 |

### 0.56.3 本轮产物

- `docs/KUAISHOU_G0_FEASIBILITY.md`（完整报告：项目清单、源码审查、实验、评分、G1 目标）。
- `research/kuaishou-g0/feed-probe.mjs`（零依赖匿名 feed 探针；只输出聚合，不存原文）。
- `research/kuaishou-g0/cdp-probe.mjs`（匿名浏览器 CDP 观察脚本；本机沙箱阻止 Chromium，未成功）。
- `THIRD_PARTY_NOTICES.md` 新增「快手协议参考」段（未复制任何代码）。
- `docs/PLATFORM_EXPANSION_RESEARCH.md` §3.5 更新。
- `docs/ROADMAP.md` 新增 P47；`log/2026-11-17-kuaishou-g0.md`。

### 0.56.4 未做 / 禁止

- 未新增 `src/platforms/kuaishou/`，未改路由/UI/数据库/监控生产代码。
- 未改版本号、未改 v0.16.0 Tag/Release/EXE。
- 未引入依赖、未复制第三方代码、未使用登录/Cookie/扫码/签名/云端。
- 未 Push、未 Merge main、未创建 Tag/Release。
- 未验证：跨日身份、真实下播→再开播、礼物/点赞/进入/关注、高聊天率截断、10+ 房间并发。

### 0.56.5 Git

- 分支：`kuaishou-g0`（从 `main` `6f71f56` 创建；未 Push）。
- 本地提交：`fb964ca`（`docs: investigate Kuaishou G0 feasibility (anonymous H5 feed)`）；
  随后以 `docs: record the Kuaishou G0 commit` 记录本 Hash。`main` 未改，v0.16.0 资产未动。
- 工作区：调查结束时干净（仅本轮文档/脚本已提交）。

### 0.56.6 验证

- `node --test --test-isolation=none "tests/unit/*.test.mjs"`：**805 passed / 0 failed / 0 skipped**（14,890 ms）。
- `node --check research/kuaishou-g0/feed-probe.mjs`、`cdp-probe.mjs`：通过。
- `git diff --name-only main...HEAD`：只有 `docs/`、`log/`、`research/`、`THIRD_PARTY_NOTICES.md`；
  **没有** `src/`、`package.json`、`scripts/`、`dist/` 变更。
- `v0.16.0` Tag 仍存在；`main` 仍为 `6f71f56`。
- 未跑全量 integration：本轮没有生产代码变更；快手实验是独立研究脚本。

## 0.55 v0.16.0 正式发布：Kick 支持与自动开播监控（2026-11-17）✅ 已发布

### 0.55.1 最终审计与合并

- 发布分支 `feature/kick-g2` 工作区干净；G1–G5.1 全部提交保留；`main` 无用户未提交改动。
- 合并提交 `4a2bcd6f5c54554cc20629257b3a548011cdf056`
  （`merge: release Kick as the sixth live platform (v0.16.0)`，--no-ff）。
- 版本 `0.15.0` → **`0.16.0`**（`package.json`、`APP_VERSION`、README、CHANGELOG、
  Release Notes、EXE `--version` 与 bootstrap 全部一致）。
- Schema 仍 16；无数据库迁移；五平台代码路径未重构。

### 0.55.2 自动化测试（main 合并后）

- 全量 `node --test --test-isolation=none`：**1,177 passed / 0 failed / 0 skipped**
  （285,534 ms）。
- 首轮全量出现 1 个既有 TikTok 时序失败
  （`tiktok-local-adapter: a throttled anonymous cookie keeps the recording and retries`），
  单独重跑 14/14 通过、二次全量 1,177/1,177 通过；判定为偶发时序，非 Kick 回归，未改断言。
- Kick 专项 75、十语言字典 2,304 键、监控恢复、备份恢复、数据库兼容、打包完整性检查均通过。

### 0.55.3 正式 EXE

| 项目 | 值 |
| --- | --- |
| 文件 | `LiveMemory.exe` |
| 版本 | `0.16.0`（`--version` 实测） |
| Build ID | `ac0daca067b3` |
| 构建提交 | `4a2bcd6f5c54554cc20629257b3a548011cdf056` |
| 大小 | 99,342,336 bytes |
| SHA-256 | `d6c39ee259ed5b8f35c4174eede54c2dfc436bd49edcd57b18e50f1591118094` |
| Manifest | `requireAdministrator`（PE 复读） |
| 签名 | 未签名（SmartScreen 可能提示） |
| EXE 验收 | `verify-kick-exe.mjs` **27/27**（真实 Kick 双房间、身份、礼物、历史、AI、监控、停止） |
| 自动化副本 | `LiveMemory-asInvoker.exe`，同 Build ID/源码，仅测试用 |

**PE VERSIONINFO 已知问题（未修复）**：Windows 文件属性仍显示 Node 运行时
（FileVersion/ProductVersion `24.21.0`、ProductName `Node.js`）。本轮没有安全的零依赖
VERSIONINFO 资源重写方案；为避免破坏已通过验收的 EXE，未修改。应用内 `--version`、
bootstrap、About 与 Release 元数据均为 `0.16.0` / `ac0daca067b3`。

### 0.55.4 发布

- Annotated Tag `v0.16.0`；Release Title
  **`LiveMemory v0.16.0 — Kick Support & Auto Live Monitoring`**。
- Release URL：`https://github.com/zgrg29/LiveMemory/releases/tag/v0.16.0`
  （Release ID `448187380`，Published `2026-11-17T05:32:48Z`，非 Draft / 非 Pre-release）。
- 资产：`LiveMemory.exe`（99,342,336 B，SHA-256 同上）与 `SHA256SUMS.txt`；
  从 GitHub 重新下载 EXE 复核，大小与 SHA-256 均与本地正式构建一致。
- 未覆盖/修改 `v0.15.0` 历史 Release（复核仍可访问）。
- 已知限制：Kick 非官方实时接口、重连可能漏消息、KICKs 非法币、部分赠订无稳定 ID、
  关注需官方 Webhook、同频道跨两次开播的真实自然周期未完成观察；真实双击 UAC 未人工验证。

## 0.54 Kick G5.1：开播监控、自动录制与 EXE 补验（2026-11-17）✅ 候选

用户试玩后指出 Kick 缺少与其余五平台一致的「监控频道开播」。本轮先核实：五个平台都有
detector + policy + `MonitoringManager` 生命周期，**Kick 在平台注册、UI 开关、下播确认三个层面
都缺失**，不是纯前端问题。

### 0.54.1 修改

- `MONITOR_PLATFORMS` / `MONITOR_POLICY` 加 `kick`（90s 基础、60–150s 抖动、错误退避到 20min）。
- 新增 `src/monitoring/detectors/kick.mjs`：公开频道 JSON 查询；离线是正常 observation，
  不存在/网络/WAF 分别映射；`targetKey=channelId`，周期键 `kick:<channelId>:<livestreamId>`。
- `MonitoringManager` 注册 detector、暴露 policy、`#startPlatformSession` 走 `KickService.connectDetected`。
- `KickService` 共享 HTTP 客户端、新增 `observeChannel` / `connectDetected`。
- `KickAdapter` 每 60s 确认公开频道状态，**连续 2 次 offline** 结束 session（聊天 socket 下播后仍可能
  保持连接，不能只靠断线判断）。
- Kick 面板加入共用监控开关/表单；十语新增 2 个键（每份 **2,304** 键）。
- 构建清单加入 Kick detector。

### 0.54.2 真实验收（源码服务）

| 场景 | 结果 |
| --- | --- |
| A 离线频道（`xqc`） | 可添加，状态 `waiting`；检查后仍 waiting、0 失败、0 session |
| F 重启恢复 | 重启真实服务后目标仍 enabled/waiting |
| B 开播自动记录 | 真实在播频道自动 `recording`；真实聊天 + `kick:<id>` 身份；未重复 |
| E 多频道 | 两个真实在播频道 → 独立 session、互不串台；离线目标不受影响 |
| 手动停止 | 停止后 `live_stopped`，强制检查未自动重启 |
| 真实下播 | **本轮窗口内未自然发生**（G4 有真实 odablock 下播证据；本轮用集成测试覆盖两次确认→结束） |
| 下一次开播 | 真实窗口内未发生；集成测试覆盖“offline→新 livestream id→新 session” |
| 合计 | `scripts/kick-g51-monitor-acceptance.mjs` **16/16** |

### 0.54.3 十语 UI 与自动化

- `verify-kick-ui.mjs`（真实服务：1 个离线监控 + 1 个自动录制）：**20/20**；
  每语检查监控开关、添加表单 placeholder/按钮；真实监控 Tab 显示 `waiting` / `recording`；
  1440/1024/820/390、明暗、无溢出、无未解析键。
- 新增 `tests/integration/kick-monitoring.test.mjs` 7 个测试；全量
  **1,177 passed / 0 failed / 0 skipped**（`--test-isolation=none`，512,084 ms）。
- 五平台 monitoring 回归全绿。

### 0.54.4 发布 EXE

| 项目 | 值 |
| --- | --- |
| 文件 | `dist/LiveMemory.exe` |
| Build ID | `8bfc48086b20`（提交 `5976c78d0626de3a286aa94cafb290332c6d1edc`） |
| 大小 | 99,342,336 bytes |
| SHA-256 | `8a2b21a248cc68c3a87777d5a698472a666c57e6c5001c2535657b92e6eb32ed` |
| Manifest | `requireAdministrator`（自动化使用同 Build ID 的 asInvoker 副本） |
| EXE 验收 | **27/27**：含 Kick 监控 policy、离线 `xqc` 添加/waiting/无空 session、真实频道自动录制、真实聊天与身份、不重复、手动停止不立即重启 |
| 未验证 | 真实双击 UAC；EXE 内重启恢复（源码真实服务已验）；真实下播/下一次开播窗口 |

### 0.54.5 限制

- 频道改名后轮询 slug 会 404，需要重新添加（身份仍用 channelId）；无续传，下播/断线可能漏消息；
  非官方协议可能变化。
- 不得把本轮「模拟下播/下一次开播」描述为真实端到端；真实下播仅有 G4 的 odablock 一次。

## 0.53 Kick G2–G5：正式接入、完整验收与发布 EXE（2026-11-17）✅ 候选

用户要求连续推进 G2–G5，每个阶段独立验收，出现 P0/P1 先修复再继续，最终交付可试玩的
Windows 发布 EXE，但**不执行 G6、不发布**。本轮从 `feature/kick-g1` 的 `74b39fa` 继续。

### 0.53.1 范围与结果

| 阶段 | 结果 |
| --- | --- |
| G2 正式后台接入 | ✅ `KickService` + `/api/kick/{status,room,connect,disconnect,retention/apply}` + capabilities + SessionManager/EventIngest/历史上限 |
| G2 礼物与互动 | ✅ KICKs（交易 ID、sender.id、KICKs 数量、金额未知）、赠订（赠送者 + 每位接收者，无身份）；订阅/开播/Host/投票仍 `NOT-OBSERVED` |
| G3 UI 与十语言 | ✅ 直播页第六个平台页签；十份字典各 **2,302** 键；真实浏览器矩阵 **20/20**（10 语 × 1440/1024/820/390 × 明暗，真实 2 场录制） |
| G4 真实长测 | ✅ **70.2 分钟**、3 场真实 session、**34,766** 条聊天、**1 次真实 token 刷新**、7 次平台侧重连、0 重复 |
| G4 自动化回归 | ✅ 全量 **1,169 passed / 0 failed / 0 skipped**（463,240 ms）；G1 的两个偶发时序失败未复现 |
| G5 EXE | ✅ 候选 `dist/LiveMemory.exe`，Build ID `5314bd79a0f3`，`verify-kick-exe` **19/19**；正式 EXE `requireAdministrator`，自动化使用同 Build ID 的 asInvoker 副本 |

### 0.53.2 G4 真实长测（`tests/.tmp/kick-g4/`）

| 项目 | 值 |
| --- | --- |
| 主房间 | kinocasinogaming（02:57:29–04:07:39 UTC，70.2 分钟） |
| 替补 | odablock 03:19:18 下播自动停止；paymoneywubby 03:19:48 接入至结束 |
| 聊天 | 20,304 + 3,304 + 11,158 = **34,766** |
| 字段 | `sender.id` / 消息 ID / `occurred_at` 均 **100%** |
| 观众 | **3,438** 个稳定 `kick:<id>`（主房间 1,471） |
| 重复 | 0（`external_id` 无重复；`UNIQUE(session_id, dedupe_key)` 兜底） |
| 重连 | 7 次（3/3/1），平台侧断开自动恢复；无续传，空档可能漏消息 |
| Token 刷新 | **1 次**：03:59:37 UTC `tokenRefreshes=1`、状态 `connected`；前后 30 秒内继续收消息（17,442→17,587） |
| 事件 | 111 KICKs + 41 membership（18 paid / 23 free）；KICKs 的 `amount_minor`/`currency` 100% 为 NULL |
| 停止 | `/api/kick/disconnect` 后 `liveSessionsAfterStop=0`、`recordingsAfterStop=0` |

### 0.53.3 发布 EXE（G5）

| 项目 | 值 |
| --- | --- |
| 文件 | `dist/LiveMemory.exe`（正式候选）、`dist/LiveMemory-asInvoker.exe`（同源 asInvoker 测试副本） |
| 版本 / Build ID | `0.15.0` / `5314bd79a0f3`（提交 `969d97564653036fa073828f5b1c61bf02de1e4f`） |
| 大小 | 99,329,024 bytes |
| SHA-256（候选） | `acdc4ea3a75305fd1a26364127f8bfada97728cfb9892b1046ac68ac5b653058` |
| Manifest | `requireAdministrator`（构建断言 + 注入后复读）；副本 `asInvoker` |
| 打包 | 244 个文件；Kick 7 模块 + 十份字典 + 全部提示词/Schema |
| EXE 验收 | `verify-kick-exe.mjs` **19/19**：注册、URL、双房间真实聊天、身份、历史、AI 入口、停止、十语资源 |
| 未验证 | 真实双击 UAC（同意/拒绝）、干净 Windows 账户、EXE 未签名 |

### 0.53.4 测试与限制

- 全量 **1,169 passed / 0 failed / 0 skipped**；Kick 相关单测/集成覆盖 URL、字段、Emote、reply、
  礼物/赠订、token 刷新、109、退避、双房间、停止、服务/路由、UI 键与打包清单。
- 十语言门禁：10 × 2,302 键，缺失/多余/占位符/空值/英文残留均为 0。
- P2：订阅/续订、开播下播、Host、投票未观测；赠订只有用户名；无续传；非官方协议可能失效。
- P3：HTTP/2 与 WebSocket `Origin` 依赖；EXE 未签名；真实 UAC 未人工验证。

## 0.52 Kick G1 真实本地采集验证（2026-11-17）✅ 未接入产品

用户要求以既有 G0 调查为起点，对 Kick 做**源码核实、真实连接测试和最小可运行 PoC**，
不从零重复调查、不复制第三方项目、不新增云端依赖、不改正式版本号。本轮**未 Push / 未合并
`main` / 未 Tag / 未 Release**，版本仍 `0.15.0`（v0.15.0 仍是当前正式发布）。

### 0.52.1 起点与继承

| 项目 | 值 |
| --- | --- |
| 起始分支 / 工作区 | `main`（HEAD `0a0f9b5`），clean；v0.15.0 Tag/Release 已存在 |
| 继承的既有研究 | `docs/PLATFORM_EXPANSION_RESEARCH.md` §2（G0：kixo / Kick-Live-Connector / kick-api、官方 API 无读聊天、Centrifugo/Pusher 轮廓、字段与 6 项风险） |
| 本轮分支 | `feature/kick-g1` |
| 版本 / Schema | 未改（`0.15.0` / 16）；未改五平台协议、金额、身份、去重 |

### 0.52.2 真实采集（本地直连，免登录）

| 项目 | 结果 |
| --- | --- |
| 传输 | `kick.com/api/v2/channels/<slug>` → `web.kick.com` realtime 配置 → 匿名 guest JWT（TTL 2700s）→ Centrifugo WebSocket |
| 房间 | odablock（channel `2401072` / chatroom `2393554`）与 gmhikaru（`1770127` / `1762730`），并发 **966 秒** |
| 真实消息 | **1,604 + 332 = 1,936** 条；99.7 / 20.6 条每分钟 |
| 字段完整率 | `sender.id` **100%**、消息 `id` **100%**、`created_at` **100%**（均为 `+00:00` ISO-8601） |
| 身份 | 391 + 113 个稳定用户 ID；同名不同 ID 不合并；1 个跨房间稳定 ID 可关联 |
| Emote | 827 条含 `[emote:id:name]` 的消息全部解析，`content` 原文不变 |
| 消息 ID 唯一性 | 1,936 条全部唯一，重连前后无重复 |
| 多房间隔离 | 跨房间串台 **0**；每房间独立 adapter/socket/session |
| 断线恢复 | 强制断开后 **5.7 秒**恢复（退避 1.08s），空档 **5.338 秒**；无续传，可能漏消息 |
| 停止 | `stop()` 关闭 socket、状态 `stopped`、无重连；测试夹具断言无残留连接 |
| 事件 | 聊天/Emote/reply/封禁 6/解封 1/删除 7/Pin 3+取消 2 已真实观测；**赠送订阅 1 条、KICKs 1 条**（仅形状与限制，未映射）；订阅/续订/上下播/Host/投票 **NOT-OBSERVED** |
| 附加运行 | 10 分钟 odablock + nelkboys：1,104 条聊天、赠订 1、KICKs 1、Pin 3、删除 2；强制断开 5.3 秒恢复 |
| 传输事实 | `kick.com` 公开接口 HTTP/1.1 被 WAF 403、HTTP/2 200；Node 内置 WebSocket 不发 `Origin` 且被接受 |
| 官方 API | `api.kick.com/public/v1/channels?slug=…` 无 token → **401**；无读聊天 scope；webhook 需公网接收端 |

### 0.52.3 交付物

| 文件 | 内容 |
| --- | --- |
| `src/platforms/kick/{errors,link,http,messages,transport,adapter}.mjs` | 最小适配器骨架：URL 解析、HTTP/2 JSON、Centrifugo 五 feed、事件映射、重连/停止 |
| `scripts/kick-poc.mjs` | 真实采集 PoC：双房间、强制断线、原始 payload + canonical 草稿 + summary.json |
| `scripts/kick-g1-analyze.mjs` | 身份/字段/唯一性/跨房间证据分析 |
| `tests/unit/kick-{link,messages,transport,adapter}.test.mjs` | 离线单测（fake HTTP/WebSocket） |
| `tests/integration/kick-ingest.test.mjs` | SessionManager + SQLite + EventIngest：去重、身份、匿名降级、双房间、停止 |
| `docs/KICK_G1_ACCEPTANCE.md` | G1 完整验收报告（证据、风险、G2 设计） |

### 0.52.4 测试

| 项目 | 结果 |
| --- | --- |
| 全量单元 + 集成 | **1,155 passed / 0 failed / 0 skipped**（`--test-isolation=none`，300,336 ms；含 Kick 48 单测 + 5 集成） |
| 时序抖动（如实记录） | 本轮两次全量运行各出现 1 个与本轮无关的时序失败（`ai-memory-output-recovery`、`youtube-lifecycle-regression` 的定时断言），**单独重跑均 8/8、10/10 通过**；第三次全量 1,155/1,155 通过。未修改这些断言 |
| Kick 单测 | 48 passed（URL、HTTP 状态映射/重定向/gzip、字段、Emote、reply、缺失身份、时间、五 feed、token 刷新、109、退避、失败上限、双 adapter） |
| Kick 集成 | 5 passed（去重、同昵称不同 ID、匿名降级、双房间隔离、停止后拒绝迟到消息） |
| 现有五平台回归 | 随全量套件通过；未修改五平台代码 |
| 真实与模拟区分 | 真实采集只在 `scripts/kick-poc.mjs`；所有 `node --test` 使用 fake transport，未访问 Kick |

### 0.52.5 Git

| 项目 | 值 |
| --- | --- |
| 分支 | `feature/kick-g1`（基于 `main` `0a0f9b5`，即 v0.15.0 发布后的文档提交） |
| 本地提交 | `4e4bbb161bbe894300620d9107263af5efe67052`（24 files, +3,981/−28） |
| Push / Merge / Tag / Release | **均未执行**；`main`、`v0.15.0` Tag/Release 未改动 |
| 工作区 | clean；`tests/.tmp/` 证据未提交 |

### 0.52.6 已知限制（必须保持如实）

- 订阅/续订、开播/下播、Host、投票：**NOT-OBSERVED**；赠送订阅与 KICKs 各只观测到 1 条，
  赠订只有用户名（无稳定 ID）、KICKs 无法币币种/金额语义，**不得声明支持**。
- 45 分钟 guest token **真实到期**未等待；只验证了「提前刷新」与「109 处理」的代码路径。
- 长时（>1h）稳定性、429 限流形态、重连漏消息比例未量化。
- `Origin` 与 HTTP/2 依赖是新增的平台侧风险；被收紧时必须如实失败（`KICK_BLOCKED`）。
- Kick 仍未接入产品：无路由、无 UI、无十语言文案、无 EXE 验收（G5 未做）。

## 0.51 v0.15.0 十语言国际化正式发布（2026-11-17）🚀

用户明确授权本轮完成 **v0.15.0 合并与正式发布**，不新增开发里程碑、不扩展语言或直播平台。
本轮只做：发布前检查 → 合并 `main` → 版本统一 → 全量回归 → 正式 EXE 构建与验收 →
Push / Tag / GitHub Release → 发布后核对。**未改平台协议、数据库 Schema（仍 16）、
金额/身份/去重、任务语言快照语义、翻译缓存表结构，未新增直播平台。**

### 0.51.1 发布基线（发布前实测）

| 项目 | 值 |
| --- | --- |
| 起始分支 / 工作区 | `feature/p42-i18n-m3`（HEAD `07cfaf1`），clean |
| P39–P42 提交 | 16 个，`main..feature/p42-i18n-m3` 全部包含；`main` 无独立新提交（`0 / 16`） |
| merge-base | `a70321c`（`main` = `origin/main`，v0.14.0 发布后的文档提交） |
| 上一正式 Tag / Release | `v0.14.0` → `d268cf9`（Release id `446701465`，2026-11-16） |
| 发布前版本 | `0.14.0`（`package.json` / `APP_VERSION`），十语言代码已验收但未发布 |
| P42 基线 EXE | Build `5b9e355dccc7`、99,200,512 B、SHA-256 `7c3f3d3f…`、`requireAdministrator` |
| P42 残留风险 | 真实双击 UAC、干净 Windows 账户、母语审校、Twitch/抖音真实采集、长报告多块翻译 |

### 0.51.2 合并

| 项目 | 值 |
| --- | --- |
| 合并方式 | `git merge --no-ff feature/p42-i18n-m3` |
| 合并提交 | `37a075e1f0e726742c9133dad8a4dad232effc6b` |
| 父提交 | `a70321c`（原 `main`）+ `07cfaf1`（`feature/p42-i18n-m3`） |
| 冲突 | 无 |
| 合并后树 | 与 `feature/p42-i18n-m3` 完全一致（`git diff --stat feature/p42-i18n-m3 main` 为空） |
| 遗漏检查 | P39–P42 的 16 个提交全部在 `main` 历史中 |

### 0.51.3 版本统一（0.15.0）

| 位置 | 结果 |
| --- | --- |
| `package.json` → `version` | `0.15.0` |
| `src/shared/app-info.mjs` → `APP_VERSION` | `0.15.0` |
| Windows EXE 版本信息 / 启动器横幅 / `--version` / 设置「关于」/ `/api/health` / `/api/bootstrap` | 由 `APP_VERSION` 与 `build-info.json` 派生，均为 `0.15.0` |
| 构建元数据 | `build/build-info.json` / `build/manifest.json` 的 `version` 为 `0.15.0`，`commit` 为发布提交 |
| CHANGELOG / ROADMAP / STATUS / HANDOFF / release notes / README | 已统一；新增 `docs/release-notes/v0.15.0.md` |
| 历史不一致修正 | P41「v0.15.1」→「v0.15.0」；P42「v0.16.0」的旧标签已注明未采用，实际统一为 `v0.15.0` |
| 历史 Release 记录 | `v0.13.2-rc.0` / `v0.14.0` 的 tag、资产、SHA-256、Release id **未修改** |

### 0.51.4 发布前与发布后验证

| 项目 | 结果 |
| --- | --- |
| 全量单元 + 集成 | **747 unit + 355 integration = 1102 passed / 0 failed / 0 skipped**（`--test-isolation=none`，合计 292,904 ms；单元单独 747 passed / 13,754 ms） |
| 十语言字典门禁 | 10 份 × 2,271 键，缺失/多余/占位符/空值差异 0 |
| 十语言 AI Schema 门禁 | 三个结果 Schema 接受十语、拒绝未支持语言 |
| 国际化关键集成 | `ai-i18n-locales` 4/4、`ai-i18n-translation` 通过 |
| 真实 Provider 证据 | 复用 P42 已验收的 DeepSeek 证据（10/10 单场、10/10 画像、4/4 跨语言、5/5 翻译 + 回退），本轮未改提示词/Schema/Provider 行为，未重复消耗 Token |
| Windows EXE 构建 | Build ID `945bee868455`，`99,200,512` bytes，SHA-256 `b8458ab75704ebedc44fc64ebe000ddf97828687bf1af7896266b219469c826e` |
| EXE Manifest | `requireAdministrator`（构建断言 + 注入后复读） |
| `verify-exe` / `verify-help-exe` / `verify-ai-token-exe` | `verify-exe` **11/11**、`verify-help-exe` **14/14**、`verify-ai-token-exe` **16/16** |
| EXE 资源完整性 | 十份字典 + `/shared/locales.mjs` + `language-control.js` + 十语 AI 提示词/Schema 全部在包内 |
| 启动器十语言 | `--help --lang <code>` 10/10 exit 0 |
| 工作区 | 发布提交后 clean，无 `tests/.tmp`、`dist/`、`build/`、凭据或用户数据进入提交 |

> **EXE 验收方式（如实记录）**：本机 Windows 启用了应用控制策略（Smart App Control 强制模式），
> 会阻止**事后打补丁**的 asInvoker 副本（`An Application Control policy has blocked this file`）。
> 因此本轮改用**同一源码、同一 buildId `945bee868455` 单独构建的 asInvoker 二进制**作为功能副本，
> 并把 `LOCALAPPDATA` / `TEMP` 重定向到 `tests/.tmp`。`scripts/test-exe-copy.mjs` 会断言
> 正式 EXE 仍为 `requireAdministrator`、副本为 `asInvoker`、且两者嵌入同一 `buildId`。
> **正式 EXE 未被修改、未降低 UAC**；官方二进制单独断言 Manifest。
> 真实双击 UAC（同意/拒绝）仍为人工待办，未在本轮自动化中通过。
>
> **PE 版本资源说明**：`LiveMemory.exe` 的 PE `VERSIONINFO` 资源沿用其内嵌的 Node 运行时
> （`24.21.0`，与 v0.14.0 及更早版本一致）；LiveMemory 自身的版本以 `build-info.json`、
> `--version`、启动器横幅、设置页「关于」、`/api/health`、`/api/bootstrap` 为准，均为 `0.15.0`。

### 0.51.5 已知限制（P2/P3，允许发布）

- **P2**：真实双击 UAC 的「同意」与「拒绝」两条路径、干净 Windows 账户、Windows 原生启动器
  仍未人工验证；自动化只能断言 Manifest 并运行 asInvoker 功能副本。**不得写成已通过。**
- **P2**：十种语言均无母语审校签收人；质量由机器门禁 + 真实浏览器布局检查 + 抽样阅读保证。
- **P2**：Twitch 本轮无在播频道、抖音无真实在播房间，真实采集未验证；Bilibili/YouTube/TikTok
  已在 P42 真实房间验证。
- **P3**：错误/恢复界面未做专项十语言截图；长报告多块翻译与真实 429 未覆盖。
- **P3**：TikTok 礼物/连送/订阅、抖音真实礼物、Twitch Bits/赠订仍为 `NOT-OBSERVED`。
- **P3**：EXE 未签名，SmartScreen 可能提示未知发布者。

### 0.51.6 发布结果与 Git

| 项目 | 值 |
| --- | --- |
| Tag | `v0.15.0`（annotated tag object `75d238d`）→ `e07233cc1dababc138830bcd63d76f5eb5269338` |
| Push | `main`：`a70321c..3676735`；`v0.15.0` 为新 Tag |
| Release | `LiveMemory v0.15.0 — 10-Language Internationalization`（id `447343485`，`draft=false` / `prerelease=false`） |
| Release URL | https://github.com/zgrg29/LiveMemory/releases/tag/v0.15.0 |
| published_at | `2026-11-16T17:09:41Z` |
| 资产 1 | `LiveMemory.exe`（id `755699837`，`99,200,512` B，`sha256:b8458ab75704ebedc44fc64ebe000ddf97828687bf1af7896266b219469c826e`） |
| 资产 2 | `SHA256SUMS.txt`（id `755702168`，81 B，`sha256:ea3f61201ff2c8c63b1c988eec8d0f5762c3addedd848ec7841028e461e3421a`） |
| Release body | 与 `docs/release-notes/v0.15.0.md` 一致（SHA-256 `1b35ec4530483baacf62b763d1e7919afdc3e7bfe9ba16d28ece16b544b54b1e`） |
| 资产一致性 | **PASS**：重新下载 `LiveMemory.exe` 99,200,512 B、SHA-256 `b8458ab7…` 与本地构建逐字节一致；`SHA256SUMS.txt` 同样一致；GitHub `digest` 字段与本地哈希相同 |
| 页面可访问 | Release 页 `200`、`/releases/latest` `200`、两个资产 URL `200` 且 `content-length` 与本地一致 |
| 重复发布 | 发布前断言无既有 `v0.15.0` Tag/Release；未创建重复对象 |

## 0.50 P42 / I18N-M3 十语言最终综合验收（2026-11-16）✅ 未发布

用户要求对 P39–P41 做十语言最终综合验收、修复真实缺陷，但不发布、不合并 main、不新增平台。
本轮**新增真实 Provider 十语言证据、真实 EXE 浏览器矩阵、旧数据升级/备份恢复与五平台回归**；
**未改平台协议、数据库 Schema（仍 16）、金额/身份/去重规则、任务语言快照语义与正式版本号（仍 `0.14.0`）**。
分支从 `feature/p40-i18n-m1`（HEAD `3b75e8b`）新建 `feature/p42-i18n-m3`，P39–P41 提交完整保留。

### 0.50.1 真实 AI Provider 十语言矩阵（DeepSeek `deepseek-flash`，用户本地凭证）

| 验收 | 结果 | 真实请求 / Token |
| --- | --- | --- |
| 单场分析 10 语 | **10/10**：`zh-CN`/`en`/`ja`/`ko`/`es`/`pt-BR`/`zh-TW`/`fr`/`de`/`id`，任务与结果 locale 一致、目标文字命中、Schema 键完整、无未知字段、原文未改 | 10 次 / 40,852 input + 7,108 output |
| 长期画像 10 语 | **10/10**：每语 3–7 条事实，事实脚本族与摘要语言全部匹配（`factLocaleRatio=1.0`），任务 `complete`，证据全部属于本观众，原文未改 | 10 次 / 36,928 input + 4,576 output |
| 跨语言方案 B（zh→ko→de→zh） | **4/4**：5 条事实共存（中/韩/拉丁脚本），旧事实 0 删除，跨观众证据 0，Schema/唯一约束 0 冲突；德语任务复用韩语 piano topic 做确认、但摘要为德语；最终中文轮新增「养猫」中文事实 | 4 次 / 15,640 input + 1,441 output |
| 阅读翻译（源报告 zh-CN → ko/zh-TW/es/fr/id） | **5/5**：目标语言正确、结构化字段/证据引用不变、原文报告不变、每语独立缓存、重复阅读 0 次 Provider 请求 | 5 次 + 1 次失败路径 / 7,067 input + 4,366 output |
| 翻译失败回退 | 真实 401 失败后阅读仍返回中文原文（`summaryFallsBackToOriginal=true`），原文与证据不变 | 1 次 |
| 合计（正式取证） | **31 次真实请求 / 100,487 input + 17,491 output tokens** | 未打印/复制/提交 Key |

- 质量口径：只有机器判据（目标文字脚本/停用词、Schema、存储结果、证据归属）+ 逐条人工抽样阅读；
  **无母语签收人**，不声称母语质量验收。
- 另有探针与断言修正重跑约 17 次真实请求（首次 ko 探针、翻译断言修正、跨语言数据加强），
  总计约 48 次；重跑 token 未全部单独记账，不把它计入上表正式取证。
- 原始弹幕、`viewer_id`、`message_id`、`seq`、字段名与枚举均未翻译/改写；真实测试使用隔离目录
  `tests/.tmp/p42-*`，用户数据目录 `E:\新建文件夹` 只读复制，未写入。

### 0.50.2 界面语言 / AI 输出语言独立性

| 界面 | AI 输出 | 结果 |
| --- | --- | --- |
| ko | ko | bootstrap 生效值 ko / ko |
| ko | ja | ko / ja |
| ja | de | ja / de |
| en | pt-BR | en / pt-BR |
| zh-CN | fr | zh-CN / fr |
| zh-TW | es | zh-TW / es |
| de | id | de / id |

- 固定 `ja` 后切换界面 de→fr→zh-TW→id，AI 输出始终 `ja`；重启后 `es`+`id` 仍保留；
  `follow-ui` 在 fr 界面下解析为 fr；非法 `th-TH` 返回 400。
- 任务创建时写 `ai_jobs.locale`；已创建任务不受后续偏好变化影响（P41 真实 ko/de 任务 locale 未变）。
- 中断恢复：`tests/integration/ai-i18n-locales.test.mjs` **4/4** 真实执行「韩语任务 → 暂停 → 改界面德语 →
  AI 偏好西班牙语 → 关闭并重启 → 恢复」，恢复请求与最终报告仍为韩语，已完成批次不重发。

### 0.50.3 真实 Windows EXE 十语言矩阵

| 项目 | 值 |
| --- | --- |
| 构建 | `node scripts/build-windows.mjs`，Build ID `5b9e355dccc7`（asset hash `5b9e355dccc749bde6f2`），commit `310975e` |
| 大小 / SHA-256 | `99,200,512` bytes / `7c3f3d3f0bccd8d218dcbb560c82d7f7d89a7df6e0e35b8b9ccde054a4361830` |
| builtAt / 资源 | `2026-11-16T16:23:48.586Z` / 237 files / 51 modules |
| RT_MANIFEST | **`requireAdministrator`**（构建脚本断言） |
| `verify-exe` | **11/11**（含共享注册表、十字典、十 AI 输出、动态语言控件） |
| `verify-help-exe` | **14/14**（十语言使用说明 112 键 × 10） |
| `verify-ai-token-exe` | **16/16**（分批、失败归因、断点续跑不重发已完成批次） |
| 启动器十语言 | **10/10** `--help --lang <code>` exit 0；`--lang` 列表与十码、`--data-dir/--port/--diagnose` 均在；无乱码/截断 |
| 源码服务器浏览器矩阵 | **440/440** 页面加载 PASS（10 语 × 1440/1024/820/390 × 明暗 × live/history/viewers/ai/settings/help + 详情） |
| **EXE 内服务浏览器矩阵** | **440/440** 页面加载 PASS（同一矩阵，服务由 asInvoker 功能副本启动） |
| 截图 | `docs/screenshots/i18n-p42-*` 40 张（源码）+ `i18n-p42-exe-*` 40 张（EXE） |

> 浏览器矩阵在 asset hash `5b9e355dccc749bde6f2` 的构建上完成；提交后最终重建的 Build ID 与
> asset hash 不变，只更新了嵌入的 commit 标记 `c74dbcd` 与 SHA-256，因此布局结论仍适用。
> 最终构建重新执行了 `verify-exe` 11/11、`verify-help-exe` 14/14、`verify-ai-token-exe` 16/16。

- 布局断言：无横向溢出、无控件出视口、语言控件不遮挡主题按钮、`MUST_NOT_TRUNCATE` 标签不被省略号截断、
  无未解析翻译键；十语言 × 明暗 × 四宽度全部通过。
- 本会话非提权，**无法在自动化中接受真实 UAC**：正式 EXE 断言 `requireAdministrator`，运行场景使用同一
  二进制打补丁的 **asInvoker 功能副本**。**真实双击 UAC、干净 Windows 账户仍未人工验证**，不得写成已通过。
- 仅 EXE 功能副本测试，不等于「Windows 原生启动器双击」或「UAC 同意」测试。

### 0.50.4 启动器与管理员权限说明修复

- 真实行为核实：正式 EXE Manifest 为 `requireAdministrator`，双击由 Windows 显示 UAC；拒绝则取消启动。
- 修复十份字典的两个错误键（原本写「不需要管理员权限」）：
  - `help.sections.start.step1`：改为「Windows 显示 UAC → 选择是才启动；拒绝则取消」；
  - `help.sections.backup.step6`：迁移到新电脑同样需要同意 UAC，只免旧用户名/旧路径。
- 同步修正 `docs/WINDOWS_RUNTIME.md` §5.2 与 `docs/BACKUP_RESTORE.md`：备份逻辑本身不需额外提权，
  但整个 EXE 仍按 `requireAdministrator` 启动。
- `tests/unit/i18n.test.mjs` 等 **30/30** 通过；未改变管理员策略、启动流程或 UAC 行为。

### 0.50.5 旧数据升级、备份与恢复（真实 schema-15 数据）

使用 `tests/.tmp/prod32-copy`（schema **15**、9 场、53,042 事件、4,158 观众-场次、88 份 AI 结果、
89 条长期事实、旧 `settings.json` 无 `aiOutputLocale`）复制到隔离目录执行：

| 检查 | 结果 |
| --- | --- |
| 当前代码启动并迁移 | schema **15 → 16** |
| 数据完整性 | 场次/事件/观众-场次/AI 结果/事实/任务数量、事件内容 hash、观众 hash、结果 hash、任务 locale hash、事实 hash **全部一致** |
| 旧配置 | `settings.json` 字节与 mtime **未改写**；缺 `aiOutputLocale` 读作 `follow-ui`；旧 `locale=system` 正常解析 |
| 旧报告 | `GET /api/ai/sessions/:id/report` **200**，摘要 202 字符可读 |
| 备份 | 202 → job `completed`，生成 `.livememory` |
| 恢复 | 恢复到全新目录 202 → `completed`，核心计数与升级后完全一致 |
| 原始弹幕/观众身份 | 事件与 `viewer_sessions` hash 未变 |

### 0.50.6 五平台回归（本轮真实执行）

| 平台 | 结果 |
| --- | --- |
| Bilibili | 真实房间 `1731839361`（live=1）：连接成功、19 条真实 chat、停止/落库正常；未登录打码 UID 0/0，符合既有「未识别」口径 |
| YouTube | 真实公开直播 `4t4AQ15yj1M`：62 条 chat、13 位活跃观众、62/62 有 channel id（100%）、3 条 gift（金额未知）、原文/停播正常 |
| TikTok | `@aljazeeraenglish` 60 秒：10 条 chat、5 位观众、uid/msgId/text 缺失 0、0 重连、礼物 **NOT-OBSERVED** |
| Twitch | EXE 状态/重启/保留策略检查通过；本轮 12 个频道全部离线，真实采集 **未验证**（7/9，2 项因无在播频道失败，不计为代码缺陷） |
| 抖音 | 仅运行既有适配器/集成回归；本轮无真实在播房间，真实采集 **未验证** |

- 平台链接解析、创建、连接状态、事件标准化、稳定身份、多直播间、断线重连、停止/恢复、历史与画像关联
  由全量 355 integration 覆盖；本轮未改平台协议、未新增平台。

### 0.50.7 全量自动化

| 运行 | 结果 |
| --- | --- |
| 全量单元 | **747 passed / 0 failed / 0 skipped** |
| 全量集成 | **355 passed / 0 failed / 0 skipped** |
| 合计 | **1102 passed / 0 failed / 0 skipped** |
| 定向 | 十语言字典 30/30；`ai-i18n-locales` 4/4；真实 Provider 脚本全部 exit 0 |
| 真实浏览器 | 源码 440/440 + EXE 440/440 |

### 0.50.8 本轮发现并修复的缺陷

1. **P1 文档/界面不一致**：十语言 `help` 仍写「不需要管理员权限」，与 `requireAdministrator` 冲突。
   已修十份字典 20 个值 + 两份文档；无产品逻辑改动。
2. **测试工具假阴性（zh/zh-TW）**：真实中文报告引用了观众名 `ゆき`，旧断言「不得出现任何假名」误判；
   改为剥离已知观众名 + 汉字/假名比例，并把繁体判据改为繁体标记占比。零成本 `--reuse` 复验 10/10。
3. **事实语言断言过严**：短事实（3–8 词）用摘要级停用词阈值会误判；改为按脚本族检查事实、
   按完整摘要检查目标语，并记录 `factLocaleRatio`；复验 10/10、比例 1.0。
4. **浏览器脚本无法指向 EXE**：`verify-i18n-ui.mjs` 原先只启动源码服务器；新增 `--exe` 模式
   （asInvoker 功能副本、独立 `LOCALAPPDATA`/`TEMP`、bootstrap 会话）与 `--prefix`，完成 440/440 EXE 矩阵。
   这是测试基础设施，不是产品功能。
5. **文档旧描述**：`WINDOWS_RUNTIME.md`、`BACKUP_RESTORE.md` 的「不需要管理员权限」已修正。

### 0.50.9 未验证 / 风险

- **P2（不阻断候选）**：真实双击 UAC 同意/拒绝、干净 Windows 账户、Windows 原生启动器；本会话无法接受 UAC。
- **P2**：无母语审校人；十语言质量仅为机器判据 + 抽样阅读。
- **P2**：Twitch 本轮无在播频道，抖音无真实在播房间；真实采集未验证，不得写成通过。
- **P3**：错误/恢复界面未做专项十语言截图；API 错误码、回退与恢复逻辑由测试覆盖，帮助页已进矩阵。
- **P3**：翻译真实测试只覆盖单块短报告（每语 1 次请求），未覆盖超长多块报告与真实 429。
- **P3**：版本标签存在历史文档不一致（ROADMAP 曾写 P42→v0.16.0，当时目标为 v0.15.0）；
  **已由 v0.15.0 发布轮解决**：版本统一为 `0.15.0`，P41 的「v0.15.1」与 P42 的「v0.16.0」
  标签已修正，历史 Release 记录未被改写（见 §0.51）。

### 0.50.10 结论与 Git

- **P42 结论：PASS（有条件）**。十语言真实 Provider、方案 B、语言独立性、EXE 十语言矩阵、
  旧数据升级/备份恢复、五平台无代码回归均完成；无 P0/P1 阻断。
- 条件：真实 UAC 双击与干净 Windows 账户需人工验收；Twitch/抖音真实采集待有在播房间时补验；
  母语审校未做；版本号与 Tag/Release 未动。
- 分支 `feature/p42-i18n-m3`（从 P41 HEAD `3b75e8b` 新建）；本地提交：
  `2d6777e`（help/UAC 修复）、`68f551e`（验收脚本）、`c74dbcd`（P42 文档/截图）、
  `310975e`（最终 EXE 数字，也是最终 EXE 内嵌 commit）；其后的文档提交只记录最终 SHA-256；
  **未 Push、未 Merge main、未 Tag、未 Release**。

## 0.49 P41 / I18N-M2 十语言 AI 输出与独立输出语言（2026-11-16）✅ 未发布

用户要求「P41：让 AI 分析、单场报告、长期画像、报告阅读翻译及任务恢复完整支持现有十种语言，
并实现 AI 输出语言与界面语言独立；长期画像正式采用方案 B」。本轮完成真实开发、自动化回归与
真实 Provider 验证。**未改五平台采集、数据库 Schema（仍 16）、事件/观众/金额去重、
翻译缓存表结构、调度/重试/断点续跑算法；未发布、未 Push、未 Tag。**

### 0.49.1 本轮实际完成

| 目标 | 结果 |
| --- | --- |
| 十语言 AI 输出 | 注册表十条 `aiOutput: true`；`AI_OUTPUT_LOCALES` = `SUPPORTED_LOCALES` = `SUPPORTED_MEMORY_LOCALES` = `LOCALE_NAME` = 结果 Schema `locale.enum` = 10 |
| 提示词唯一来源 | **新增** `src/ai/prompts/language.mjs`：十语 `rule/guard/system/repair/example`；`nativeInstructions` 标记保留三套已验证正文 |
| 六个 prompt 面 | 系统提示词、包内 `instructions.md`、记忆任务、分批汇总、分层摘要、修复请求全部注入输出语言契约，并统一带 `OUTPUT LANGUAGE (<code>)` |
| 提示词体积 | 单次请求只发当前语言；新增语言规则使 session 指令增长 < 2,000 字符（测试断言） |
| 结果 Schema | 三个 Schema 只改 `locale.enum`（十项）；字段名、枚举、`required`、`additionalProperties:false` 全部未变 |
| 独立设置 | `config/settings.json` 的 `aiOutputLocale`（默认 `follow-ui`）；旧配置缺键读作 `follow-ui` 且不写回；非法值 400 |
| 备份白名单 | `BACKUP_SETTING_KEYS` 增加 `aiOutputLocale`；旧备份缺键恢复为 `follow-ui`；新备份恢复保留显式语言 |
| 任务语言快照 | 创建时写 `ai_jobs.locale`；恢复时以 job 行为准回填运行时 `locale`；改界面/改偏好/暂停/重启均不改旧任务 |
| 界面 | 设置页新增「AI 输出语言」卡片（原生 `<select>`，11 项）；AI 中心默认预选偏好；新增 6 个字典键 × 10 语（每份 2,271） |
| 报告阅读翻译 | 9 个非源语言目标各自独立缓存行；原文/证据/结构化字段不变；源语言翻译返回 409 `TRANSLATION_NOT_NEEDED` |
| 长期画像（方案 B） | 未加 `locale` 列、未加别名表、未改 `dedupe_key`；`吉他`+`기타` 共存；同字符 topic 仍去重；历史事实不翻译覆盖 |
| 提示词版本 | `lm-prompt-m6.3→m6.4`、`lm-prompt-v13.2→v13.3`、`lm-prompt-m7.1→m7.2`（旧任务保留原版本号） |

### 0.49.2 测试与真实 Provider 证据

| 运行 | 结果 |
| --- | --- |
| 全量单元 | **747 passed / 0 failed / 0 skipped** |
| 全量集成 | **355 passed / 0 failed / 0 skipped** |
| 合计 | **1102 passed / 0 failed / 0 skipped** |
| 十语言提示词门禁 | `tests/unit/ai-prompt-locales.test.mjs`（11 项）：六面 × 十语、`rule/guard/example`、跨语言不串、体积上限、Schema 十语接受/非法拒绝 |
| 十语言端到端（模拟 Provider） | `tests/integration/ai-i18n-locales.test.mjs`（4 项）：10 语 session+memory、混合语言事实共存、同语言去重、界面/AI 独立、中断→重启→恢复语言快照 |
| 十语言翻译 | `tests/integration/ai-i18n-translation.test.mjs`：9 个目标各独立缓存、原文与证据不变、同语言 409 |
| 备份/恢复 | `tests/integration/backup-restore.test.mjs`：`locale=ja` + `aiOutputLocale=ko` 恢复后保留 |
| 真实 Provider（DeepSeek `deepseek-flash`） | 单场报告 `ko`/`zh-TW`/`de`/`pt-BR` **4/4 通过**；画像 `ko` **7 条韩语事实**、`de` **7 条德语事实**；跨语言续写按 guard 复用原 topic。**12 次真实请求**，可核对 usage 44,486 input / 4,450 output tokens（用户自己的 Key、隔离目录、未打印密钥） |
| 真实语言质量 | 仅机器判据（文字脚本/停用词 + Schema 校验）；**无母语签收人**，不声称母语质量验收 |
| Windows EXE | 见 §0.49.3 |

### 0.49.3 Windows EXE

| 项目 | 值 |
| --- | --- |
| 文件 | `D:\LiveMemory\dist\LiveMemory.exe` |
| Build ID | `ad32fe5cc7fb` |
| 构建 commit | `b24f52f`（P41 实现 + 注释修正；其后的提交只改文档） |
| 大小 / SHA-256 | `99,198,976` bytes / `4434a20ff4705f10848a7874f641aa41850e0877c8654bd01f3b325765770926` |
| builtAt | `2026-11-16T14:25:33.711Z` |
| 资源 / 模块 | 237 files（含十份字典与新 `language.mjs`）/ 51 required modules |
| RT_MANIFEST | **`requireAdministrator`** |
| `verify-exe` | **11/11**（含 i18n 场景：十语字典 200、`locales.aiOutput` 十项、`aiOutputLocale=follow-ui`、`effective.aiOutputLocale` 有效） |
| `verify-help-exe` | **14/14**（十语言使用说明 112 键 × 10） |
| `verify-ai-token-exe` | **16/16**（分批、断点续跑、恢复不重发已完成批次） |

真实双击 UAC、干净 Windows 账户仍未人工验证；不得写成已通过。本轮未改版本号（仍 `0.14.0`），
因为这是 P41 开发里程碑，正式版本决策留给后续发布轮。

### 0.49.4 未验证 / 不得写成 PASS

- 十种语言的**母语人工审校**：未做；真实 Provider 只覆盖 `ko`/`zh-TW`/`de`/`pt-BR` 报告与 `ko`/`de` 画像。
- `es`/`fr`/`id`/`en` 的真实 Provider 输出：**未逐语言验证**（提示词与 Schema 由自动化覆盖）。
- 翻译缓存真实 Provider：**未执行**（模拟 Provider 覆盖机制）。
- 十语言 UI 全矩阵（每语言截图、真实浏览器走查）：**P42**。
- 干净 Windows 账户、真实双击 UAC：**未执行**。

## 0.48 P40 / I18N-M1 十语言界面与启动器（2026-11-16）✅ 未发布

用户要求「在保留现有三种语言的基础上新增七种语言，完成十语言界面和启动器的国际化」。
本轮完成开发、自动化回归、真实浏览器十语言布局验收与 Windows EXE 验收。
**未改五平台采集、AI 任务调度/结构化输出/恢复、长期画像合并去重、数据库 Schema、原始弹幕保存、
翻译缓存业务语义；未提前实现 P41；未 Push、未 Tag、未 Release。**

### 0.48.1 本轮实际完成

| 目标 | 结果 |
| --- | --- |
| 术语表 | **新增** `docs/i18n/GLOSSARY.md`：50 个核心术语 × 10 语言、18 个界面动作词、10 份语言风格卡、不翻译清单、机器门禁清单 |
| 七份新字典 | `ko` / `es` / `pt-BR` / `zh-TW` / `fr` / `de` / `id`，每份 **2,265** 个叶子键 |
| 键集/占位符 | 十份字典相对 `en.json` 缺失 **0**、多余 **0**、占位符差异 **0**、空值 **0** |
| 不新增无关键 | 语言名只来自注册表；`settings.language` 恒为 10 个历史键，字典键数保持 **2,265** |
| 注册表 | 10 条 + 新增 **`aiOutput`** 能力位；`AI_OUTPUT_LOCALES = zh-CN/ja/en` 由同一注册表派生 |
| 选择器 | Header/设置页十语言；3 项仍为分段按钮、10 项自动原生下拉；原生名只用该语言自身文字 |
| 系统识别 | `zh-HK`/`zh-MO`/`zh-Hant` → **`zh-TW`**；`pt-PT` → **`pt-BR`**；`in` → `id`；`de`/`fr`/`ko`/`es`/`id` 直命中；未知 → `en` |
| 持久化 | 十语言可保存、重启后保持；旧三语配置（`zh-CN`/`ja`/`en`）原样加载并生效 |
| 启动器 | `cli-i18n.mjs` 十套消息（61 键/语言）；`--lang` 接受十码与地区变体；`{locales}` 由注册表填充；ASCII 安全回退；SEA 引导器十语言失败消息 |
| AI 安全 | 分析/记忆任务 locale、报告/翻译只读接口、结果 Schema `enum` 全部收窄到 `AI_OUTPUT_LOCALES`；未支持语言**永不**发往 Provider |

### 0.48.2 关键设计决定

1. **界面语言 ≠ AI 输出语言**：十语言是界面语言的完成。注册表新增 `aiOutput` 布尔位，
   `AVAILABLE_LOCALES`（10）与 `AI_OUTPUT_LOCALES`（3）**同源派生**，不是第二份清单。
2. **路由层收窄**：`/api/ai/analyze/run`、`/api/memory/jobs` 经 `aiOutputLocale()` 归一
   （同族优先，例如 `zh-TW`→`zh-CN`，否则 `en`），因此任务行写入的 `locale` 一定是受支持语言；
   报告/翻译接口对 `de` 等返回 400 而不是进入不存在的提示词。
3. **字典键数不变**：P39 已把原生语言名集中到注册表，设置页/Header 从 bootstrap 渲染；
   本轮**没有**给七种新语言加 `settings.language.*` 键，2,265 键契约与「不新增无关键」同时成立。
4. **启动器 ASCII 回退**：控制台无法 UTF-8 时改用英文 ASCII 消息集并把非 ASCII 折叠为 `?`；
   写入失败不会中止启动；`console.ready` 记录 `asciiFallback`。
5. **翻译流程**：`en.json` 为源 + `zh-CN.json` 参照 → 10 个章节对齐批次 → 每批机器门禁必须 PASS →
   按 `en.json` 结构与键序合并 → 字典级门禁 → 逐语言审校。

### 0.48.3 自动化与真实 UI（本机真实执行）

| 运行 | 结果 |
| --- | --- |
| 全量单元 `node --test --test-isolation=none "tests/unit/*.test.mjs"` | **727 passed / 0 failed / 0 skipped** |
| 全量集成 `… "tests/integration/*.test.mjs"` | **350 passed / 0 failed / 0 skipped** |
| 合计 | **1077 passed / 0 failed / 0 skipped** |
| 字典门禁（`tests/unit/i18n.test.mjs`） | 10 份 × **2,265** 键；键集缺失 0 / 多余 0；占位符差异 0；空值 0；未解析键 0 |
| 英文残留 | 逐语言列出「与英文完全相同」的键并逐条审阅 → `tests/fixtures/i18n-same-as-english.json`（占位符/URL/品牌/同形词）；未列入即失败；该白名单本身也被断言「不得包含已翻译的键」 |
| 真实浏览器 `node scripts/verify-i18n-ui.mjs` | **380/380 页面加载 PASS**：10 语言 × 1440/1024/820/390 × 亮/暗 × 主要页面；**40 张截图** |
| 布局断言 | 无横向溢出、无控件出视口、语言控件不覆盖主题按钮、界面标签不被截断 |
| `scripts/verify-exe.mjs` | **11/11**（含「共享注册表 + 十字典 + `aiOutput` 子集 + 动态控件」） |
| `scripts/verify-help-exe.mjs` | **14/14**（十语言使用说明 112 键 × 10，九大主题逐语言齐全） |
| 启动器十语言 | EXE 的 asInvoker 功能副本逐个执行 `--help --lang <code>`：**10/10 exit 0**，`{locales}` 均展开为十个语言码，输出为对应语言 |
| 控制台回退 | `tests/unit/launcher-console.test.mjs`：UTF-8 控制台输出所选语言；无 Unicode 时改用英文 ASCII 集合并折叠非 ASCII；写入抛错也不中止启动 |

- 截图：`docs/screenshots/i18n-p40-<locale>-{live-1440-light,settings-1440-dark,live-390-light,ai-1440-light}.png`（10 语言 × 4）。
- 真实浏览器验收需要一次性 `danger-full-access`（沙箱禁止 Chromium 的 mojo 命名管道），已在日志中如实记录；
  这不代表产品需要提权，也不代表已在干净 Windows 账户验收。
- 本轮发现并修复的**真实布局缺陷**（由十语言实测暴露，不是猜测）：
  1. 统计卡 `.stat-label` / `.stat-sub` 的 `nowrap + ellipsis` 导致法语/德语/韩语标签被截断 → 改为换行；
  2. 「＋ 新建记录」按钮复用 `.recording-tab-label` 的 145px 上限，德语 `Neue Aufzeichnung` 被截断 → 该按钮标签不再限宽；
  3. 侧栏品牌标语 `.brand-tagline` 单行省略 → 允许两行；
  4. 窄屏顶栏 `.topbar-title` 在 390px 下德语 `Einstellungen` 被截断 → 顶栏保留省略号但**补 `title` 全文**，
     且同一文案在页面正文标题（`.page-title`）中始终完整显示。
- 审校：七种新语言各一轮「原生读者」审校，共修正 **284** 键（ko 44 / es 35 / pt-BR 15 / zh-TW 101 /
  fr 17 / de 41 / id 31），审校后门禁全部 PASS。**无母语签收人**。

### 0.48.4 Windows EXE

| 项目 | 值 |
| --- | --- |
| 文件 | `D:\LiveMemory\dist\LiveMemory.exe` |
| Build ID | `09014dc765e0` |
| 构建 commit | `1a0303eaf210cdab4ade69473a0d0ac33992faa7` |
| source hash | `09014dc765e04acde1501023cd9052f0ebfb04a7d5b84cb6badc1f80604b1324` |
| 大小 / SHA-256 | `99,160,576` bytes / `82f335c1f3d62e7a9b2fe179fecae6ae7829cddee08e88e97b5c636459b733c9` |
| builtAt | `2026-11-16T12:51:20.167Z` |
| 资源 / 模块 | **236 files**（十份字典）/ 51 required modules |
| RT_MANIFEST | **`requireAdministrator`** |
| `verify-exe` | **11/11**（含「共享注册表 + 十字典 + `aiOutput` 子集 + 动态控件」） |
| `verify-help-exe` | **14/14**（十语言使用说明 112 键 × 10，九大主题逐语言齐全） |

- EXE 大小从 P39 的 97,788,416 增至 99,160,576 bytes（+1.37 MB，七份字典 + 七套控制台文案）。
- 功能场景使用 asInvoker 功能副本；正式 EXE 单独断言 `requireAdministrator`。
- `verify-exe` 的 `LOCALAPPDATA` 重定向到仓库内临时目录，避免写入真实用户目录；不是产品缺陷。
- **真实双击 UAC、干净 Windows 账户仍未人工验证**，不得写成已通过。


### 0.48.5 明确未做 / 遗留

- AI 输出语言仍只有 `zh-CN` / `ja` / `en`：未扩提示词、记忆提示词、结果 Schema、翻译目标（P41）。
- **没有**新增 `aiOutputLocale` 设置；任务语言快照语义未变；翻译缓存业务语义未变。
- 未改五平台采集、AI 调度/恢复、长期画像合并去重、数据库 Schema、原始弹幕保存。
- 未新增任何直播平台；未改备份格式。
- SEA 引导器保留自包含消息表（解压前无法 import 注册表），其语言码由测试与注册表比对。
- 真实双击 UAC、干净 Windows 账户仍未人工验证。
- 翻译质量口径：机器门禁 + 逐语言审校 + 抽样人工检查；**没有母语签收人**，不声称做过母语终审。
- 发现一处**既有**文案与实现不一致（不在本轮范围，未改）：`help.sections.connect` /
  `start` 仍写「不需要管理员权限」，而正式 EXE 自 RC0 起为 `requireAdministrator`。

### 0.48.6 Git

| 项目 | 值 |
| --- | --- |
| 分支 | `feature/p40-i18n-m1`（从 `feature/p39-i18n-m0` / `7c704bd` 创建） |
| 代码/测试/翻译/文档提交 | `1a0303e` `feat: add seven interface languages and localise the launcher`（85 files） |
| 文档/构建记录提交 | 本轮最终 HEAD（见 `git log -1`） |
| main | **未合并、未 Push、未 Tag、未 Release** |
| 工作区 | 代码提交后仅剩本轮结果文档 |


## 0.47 P39 / I18N-M0 国际化基础架构整理（2026-11-16）✅ 未发布

用户要求把 LiveMemory 从「三语假设」升级为可扩展架构，**不新增任何语言**，最终用户仍只能选择
`zh-CN` / `ja` / `en`。本轮完成开发、自动化回归、真实浏览器布局验收与 Windows EXE 验收；
**未改平台采集、AI 分析任务/批次/恢复、长期画像合并/去重/持久化、数据库 Schema、原始弹幕、
AI 输出语言设置、翻译缓存语义。未 Push、未 Tag、未 Release。**
长期画像跨语言策略已由用户确定为**方案 B**，本轮只在 `docs/I18N.md` / 架构 / 路线图记录，
**未提前修改长期画像代码、数据库或 AI 分析逻辑**。

### 0.47.1 本轮实际完成

| 目标 | 结果 |
| --- | --- |
| 统一语言清单 | 新增 `src/shared/locales.mjs`（Node 与浏览器同一文件）：语言码、原生名、英文名、语言族、script、regions、`available`、默认 `en`；删除前端/后端/AI/记忆/翻译/四个下拉的重复三语清单 |
| 可用性驱动降级 | `resolveLocale(preference, system, {available})` + `detectInstalledLocales()`；`zh-HK` 当前降级 `zh-CN`，未来有 `zh-TW` 资源时优先 `zh-TW`；`pt-PT`→`pt-BR`、`in`→`id`（有资源时）；未知→`en` |
| 偏好/系统/资源分离 | 合法旧配置原样加载；资源缺失只影响 effective，不改写保存值；未知/不支持语言安全降级 |
| 动态语言选择器 | `src/web/js/language-control.js` 由 `/api/bootstrap` 的 `locales.available` 生成；三种语言保持原三段按钮 + 系统按钮，>3 项或长名称自动原生下拉；设置页/AI 输出/报告阅读同源 |
| 布局修复 | 删除 `.language-select` 的 `max-width:132px` 与 `112px`；真实浏览器十语言无截断/重叠/横向溢出 |
| 资源缺失 | 字典 404/损坏回退默认一次；默认也失败显示既有本地化错误页，不白屏 |
| 三语完整 | 三份字典仍各 **2,265** 键；键集缺失 0/多余 0；占位符差异 0；切换/持久化/系统识别保持 |

### 0.47.2 架构修改前后

| 项目 | 修改前 | 修改后 |
| --- | --- | --- |
| 语言清单 | 前端 `i18n.js`、`shared/locale.mjs`、`ai/constants.mjs`、`memory/constants.mjs` 各一份；`LOCALE_NAME`、`localeDisplayName`、四个下拉硬编码三语 | `src/shared/locales.mjs` 唯一来源；前端与 Node 引用同一模块 |
| 归一化 | `zh*`→`zh-CN` 等固定前缀 | 精确码 → 语言族 region/script → 默认语言；可用集合驱动 |
| Header | `LANGUAGE_CHOICES` 三项 + `max-width:132px` | 动态列表；3 项原交互，>3 项菜单；无固定宽度 |
| 资源缺失 | 可能 404/白屏 | 服务端检查真实字典；客户端回退默认一次 |

### 0.47.3 自动化与真实 UI（本机真实执行）

| 运行 | 结果 |
| --- | --- |
| 全量单元 `node --test --test-isolation=none "tests/unit/*.test.mjs"` | **711 passed / 0 failed / 0 skipped**（17,466.98 ms） |
| 全量集成 `... "tests/integration/*.test.mjs"` | **349 passed / 0 failed / 0 skipped**（404,067.46 ms） |
| 合计 | **1060 passed / 0 failed / 0 skipped** |
| 真实浏览器 `node scripts/verify-i18n-ui.mjs` | **9/9 PASS**（三语 1440/390；十语言夹具 1440/1024/820/390/黑暗） |
| `scripts/verify-exe.mjs` | **11/11**（新增 i18n 资源场景） |

- 新增/扩展测试：`locale-registry`、`i18n-locale-api`、`locale`、`i18n`、`header-language`、`settings-store`。
- 十语言夹具：`tests/fixtures/locales-10.mjs`、`tests/fixtures/i18n-header-10.html`；
  **不在 `src/`，不进入正式可选语言列表或产品构建。**
- 截图：`docs/screenshots/i18n-p39-header-3lang-*.png`、`i18n-p39-header-10lang-*.png`。
- 本环境默认沙箱禁止 Chromium mojo；真实浏览器验收以一次性 `danger-full-access` 执行，
  已在日志中如实记录；不代表普通用户环境需要提权。

### 0.47.4 Windows EXE

| 项目 | 值 |
| --- | --- |
| 文件 | `D:\LiveMemory\dist\LiveMemory.exe` |
| Build ID | `18df5c272a98` |
| 构建 commit | `ba0ff26fbd45d68d536fd0e73542a455fc5bd3bc` |
| source hash | `18df5c272a983f223f90373394dd9a86abbfc9f1c46a0dd7c0b455bf9ee9cefa` |
| 大小 / SHA-256 | `97,788,416` bytes / `691c4f002c2487f879d5a2a08ef5d3330c38e53834bbdd45509a59443527ef24` |
| builtAt | `2026-11-16T09:36:30.079Z` |
| 资源 / 模块 | 229 files / 51 required modules |
| RT_MANIFEST | **`requireAdministrator`** |
| `verify-exe` | **11/11**（启动矩阵 + i18n 资源：共享注册表/三字典/动态控件） |

- 功能场景使用 asInvoker 功能副本；正式 EXE 单独断言 `requireAdministrator`。
- `verify-exe` 的 `LOCALAPPDATA` 重定向到 `tests/.tmp`，避免写入真实用户目录；不是产品缺陷。
- **真实双击 UAC、干净 Windows 账户仍未人工验证**，不得写成已通过。

### 0.47.5 P41 方案 B（仅文档决策）

- 允许长期画像出现不同语言事实，接受跨语言语义重复。
- 不锁定首次分析语言；不自动跨语言合并；不引入别名表/语义归一化/DB 迁移。
- 保留现有同语言合并/去重；切换 AI 输出语言不得删除、覆盖或重新翻译已有事实；
  语言混合不得导致约束冲突、任务失败或数据损坏。
- 记录位置：`docs/I18N.md` §6、`docs/ARCHITECTURE.md` §10.1、`docs/ROADMAP.md` P41。
- **P39 未改任何长期画像代码、数据库或 AI 分析逻辑。**

### 0.47.6 明确未做 / 遗留

- 未新增 `ko/es/pt-BR/zh-TW/fr/de/id` 任何字典或设置；十语言整体仍未完成。
- 未新增 `aiOutputLocale`；AI 输出语言仍默认取界面语言（P41）。
- 未改启动器控制台语言行为（仍三语独立消息表）；仅测试对齐语言码，未来统一方案见 I18N.md §2.5。
- 其他页面标签的 112–260px 固定宽度仍需 P40 十语言走查。
- P40/P41/P42 仍为待开发；不得因 P39 完成而宣称十语言完成。
- 真实 UAC、干净 Windows 账户未验证。

### 0.47.7 Git

| 项目 | 值 |
| --- | --- |
| 分支 | `feature/p39-i18n-m0`（从 `main` / `a70321c` 创建） |
| 代码/测试提交 | `ba0ff26` `feat: unify the locale registry and generate language controls`（26 files，+1666/−146） |
| 文档/截图提交 | 本轮最终 HEAD（见 `git log -1`） |
| main | **未合并、未 Push、未 Tag、未 Release** |
| 工作区 | 代码提交后仅剩文档/截图/日志 |

### 0.46 v0.14.0 五平台正式发布（2026-11-16）🚀

用户明确授权本轮完成**阶段性正式 Release**。已执行：版本确认 → 测试 → 构建 → EXE 验收 →
打包校验 → 提交 → Push → Tag → GitHub Release。**未修改平台采集、AI 分析或长期画像逻辑，
未做无关重构，未创建重复 Tag 或重复 Release。**

### 0.46.1 版本决策

| 项目 | 值 | 说明 |
| --- | --- | --- |
| 上一个正式发布 | `v0.13.2-rc.0`（Tag `cb28624`，2026-11-14） | 仓库当时唯一的 Tag 与 Release |
| 开发期版本 | `0.13.3` | `package.json` / `APP_VERSION` 原值 |
| 本版版本号 | **`0.14.0`** | 相对上一版新增 **三个直播平台**（Twitch / 抖音 / TikTok）与多房间并发，属 SemVer minor；`0.13.3` 已作开发期版本，故以 `0.14.0` 封版 |
| Tag / Title | `v0.14.0` / `LiveMemory v0.14.0 — Multi-Platform Release` | 用户指定 |
| 类型 | 正式稳定版（非 Pre-release） | 五平台均有已有真实验收证据 |

版本号同步位置：`package.json` → `version`，`src/shared/app-info.mjs` → `APP_VERSION`，
`docs/CHANGELOG.md`，本文件，`docs/release-notes/v0.14.0.md`。

### 0.46.2 五平台状态（发布口径）

| 平台 | 状态 |
| --- | --- |
| Bilibili | 真实房间聊天/身份验证过；未登录可能昵称打码、UID=0；礼物/SC/大航海按公开协议映射 |
| YouTube | 仅公开网页聊天路径；真实频道验证；30 天原文保留 |
| Twitch | 匿名 IRC；真实 6 频道 60 秒 418 事件、418/418 稳定 User ID + 消息 ID、1 条真实 resub |
| 抖音 | 公开页 + 匿名签名 WS；真实聊天含 UID/昵称/消息 ID；礼物需登录，真实礼物 NOT-OBSERVED |
| TikTok | 匿名本地 webcast WS；真实 30 分钟与双房间 EXE 验收；礼物/连送/订阅 NOT-OBSERVED |

**不得改成 PASS 的项**：TikTok 礼物/连送/订阅、抖音真实礼物、Twitch Bits/赠订、
干净 Windows 环境、真实双击 UAC、长期多房间压力测试、真实网卡断线。

### 0.46.3 测试与 EXE 验收（本轮真实执行）

| 运行 | 结果 |
| --- | --- |
| `node --test --test-isolation=none "tests/unit/*.test.mjs"` | **687 passed / 0 failed / 0 skipped**（15,179.52 ms） |
| `node --test --test-isolation=none "tests/integration/*.test.mjs"` | **347 passed / 0 failed / 0 skipped**（267,428.51 ms） |
| `scripts/verify-exe.mjs` | **10 / 10**（全新目录、重启、硬杀恢复、端口顺延、单实例、不可写目录、异目录、解压复用、CLI 三语、`--version`） |
| `scripts/verify-p0-2-exe.mjs` | **13 / 13**（备份 → 恢复 → 再次备份闭环） |
| `scripts/verify-ai-token-exe.mjs` | **16 / 16**（AI 入口、批次保存、Resume） |
| 合计自动化 | **1034 passed / 0 failed / 0 skipped** |

第一次 `verify-exe` 在本环境以 `EPERM / no writable application folder` 中止：沙箱禁止写入
`%LOCALAPPDATA%\LiveMemory`。把 EXE 的解压根与临时目录重定向到仓库内可写目录后，**同一二进制
10/10 通过**，`app-root` 为 `17f84b1956e1d197afef`（本版资产哈希）。这是环境限制，
不是产品缺陷；真实用户环境使用 `%LOCALAPPDATA%\LiveMemory`。**不得因此宣称已在干净环境验收。**

### 0.46.4 发布产物

| 文件 | 大小（bytes） | SHA-256 |
| --- | --- | --- |
| `LiveMemory.exe` | 97,769,984 | `6862079a025fa08d5b7fcf82c16cc3152fedbb7852866022dad4c96977bbe0d9` |
| `README.md` | 54,502 | `de40a0b4b7ff74788fa78f359cc193e8329020b12663857b34c37ac54b1a4cc5` |
| `LICENSE` | 1,063 | `32f41a237cd7e80b1f83589c058ff8da73903dd25091b4eefb0114487182303b` |
| `RELEASE_NOTES.md` | 15,911 | `0fc30e7012a3c179750ab20b5c51b26123a2617067ccccd4179022fa5992a4c7` |
| `LiveMemory-v0.14.0-windows-x64.zip` | 35,977,845 | `5d7b7e65eb3cea72156c5ecd97496c277427e1a33782d5b75b7a16dc09091188` |

- Build ID `17f84b1956e1`；构建提交 `d268cf9b5c64d467872c55425bf6446bf614880c`；
  builtAt `2026-11-16T06:51:04.013Z`；226 files / 51 required modules；内嵌 Node `24.21.0`。
- Manifest：构建时断言 + 注入后复读，均为 **`requireAdministrator`**。
- 包内 5 个文件，`SHA256SUMS.txt` 逐项复核通过；解压后 EXE 哈希与 `dist/LiveMemory.exe` 一致。
- 包内不含 API Key、Token、Cookie、数据库、聊天记录、`secrets/`、缓存或日志。

### 0.46.5 本轮改动范围

- `package.json`、`src/shared/app-info.mjs`：版本号 `0.13.3` → `0.14.0`（唯一代码改动，2 行）。
- `README.md`：当前能力标题版本号、去掉已合并分支的「阶段交付」表述。
- 文档：`docs/release-notes/v0.14.0.md`（新增）、`docs/RELEASE_HISTORY.md`（v0.14.0）、`docs/CHANGELOG.md`、
  本文件、`docs/HANDOFF.md`、`docs/ROADMAP.md`、`log/2026-11-16-v0.14.0-release.md`。
- 未改动任何采集/AI/画像/存储/恢复逻辑。

### 0.46.6 Git 与发布

| 项目 | 值 |
| --- | --- |
| Tag | `v0.14.0`（annotated tag object `ffc4a22`）→ commit `d268cf9b5c64d467872c55425bf6446bf614880c` |
| Push | `main`：`25e6fbe..aeadf56`；Tag `v0.14.0` 为新 Tag |
| Release | `LiveMemory v0.14.0 — Multi-Platform Release`，id `446701465`，`draft=false` / `prerelease=false` |
| Release URL | https://github.com/zgrg29/LiveMemory/releases/tag/v0.14.0 |
| 资产 | `LiveMemory-v0.14.0-windows-x64.zip`（35,977,845 B，`sha256:5d7b7e65…`）、`SHA256SUMS.txt`（314 B） |
| 下载验证 | zip Range `206` 且总长一致；`SHA256SUMS.txt` `200`；Release 页面 `200` |
| Release body | 与 `docs/release-notes/v0.14.0.md` 字节一致（SHA-256 `0fc30e70…`） |
| 重复 Tag/Release | 无（发布前已断言该 Tag 无既有 Release） |

## 0.45 I18N/PLATFORM 规划轮：国际化十语言与平台准入（2026-11-16）📝 只规划，无代码改动

本轮任务性质：**项目规划、技术可行性调查与开发文档更新**。
**未修改任何正式业务代码、未新增语言包、未新增平台适配器、未改五平台采集逻辑、
未改 AI 分析/长期画像/保存/恢复逻辑、未安装依赖、未打包、未发布、未 Push/Tag/Release。**

### 0.45.1 本轮实际核实的事实（全部实测，不是推测）

| 项目 | 实测结果 |
| --- | --- |
| 工作区起始状态 | `main...origin/main`，**clean**，无未提交的用户改动 |
| HEAD | `25e6fbe docs: record TikTok M6 human acceptance and merge into main` |
| 当前语言 | `zh-CN` / `ja` / `en` 三语（`src/web/i18n/`），无其他字典 |
| 字典规模 | 每份 **2,265 个叶子键**（与 `tests/unit/i18n.test.mjs` 相同扁平化规则）；字节 160,172 / 208,639 / 168,688 |
| 键集一致性 | 三份**缺失 0、多余 0** |
| 占位符一致性 | 三份**差异 0 处** |
| 前端语言清单 | `src/web/js/i18n.js:7` `SUPPORTED_LOCALES = ['zh-CN','ja','en']` |
| 后端语言清单 | `src/shared/locale.mjs:8` 同名常量（**两份清单**） |
| 归一化 | `zh*`→`zh-CN`、`ja*`→`ja`、`en*`→`en`，其他 → `null` → `system` → `en` |
| Header 语言控件 | `LANGUAGE_CHOICES` 3 项三段按钮（`app.js:39`）+ 系统按钮；≤860px 折叠为 `<select>` |
| 语言选择器宽度 | `.language-select { max-width: 132px }`（`styles/components.css:665`） |
| 截断风险 | `white-space:nowrap` 25 处、`text-overflow` 13 处、固定标签宽度 112/132/145/260px |
| AI 输出语言默认值 | **`let locale = ctx.locale`**（`src/web/js/pages/ai.js:198`）→ 默认等于界面语言 |
| AI 输出语言持久设置 | **不存在**（无 `aiOutputLocale` 类设置；关页重开会重置为界面语言） |
| 任务语言快照 | 已存在：`POST /api/ai/analyze/run` 解析后写入 `ai_jobs.locale`（Session+Memory 同 locale）；Resume 复用已存任务（`runner.mjs:1690,1849`） |
| 提示词语言 | `SYSTEM` / `MEMORY_LANGUAGE_RULE` / `TEXT` / `MEMORY_SHAPE_TEXT` 各仅 3 个键 |
| 翻译目标语言名 | `LOCALE_NAME` 仅 3 个键（`src/ai/translation/service.mjs`） |
| 报告阅读语言 | `GET /api/ai/sessions/:id/report?locale=…` 只读、只应用缓存、不调用 Provider |
| 原始弹幕 | `events.content` 原文；提示词明确「不逐行预翻译」；`content` 不被替换 |
| 长期画像合并键 | `dedupeKeyFor() = kind:normalizeTopic(topic)`；`normalizeTopic()` 只做 NFKC/小写/去标点，**不翻译**（`src/memory/model.mjs:47-76`） |
| `memory_facts` 语言列 | **不存在**（只有 `source_job_id` 可回溯生成任务的语言） |
| 界面硬编码文案 | 对 `src/web/**` CJK 扫描仅命中 5 行：`i18n.js:42-43` 语言自身名称 + `ai.js` 3 行中文**注释** |
| 启动器 UTF-8 | `enableUtf8Console()` 执行 `chcp 65001`；失败（`not-tty`/`chcp-failed`）降级 ASCII |
| 备份设置白名单 | **显式枚举**（`src/server/backup/settings.mjs:15` 仅 `locale`）→ 新增语言设置键必须同步 |
| EXE 打包 | `build-windows.mjs` 递归遍历 `src/`，新增字典文件自动包含；`REQUIRED_MODULES` 为独立必需清单 |
| 静态服务 | `.json` 以 `application/json; charset=utf-8` 下发，无语言白名单 → 新增字典无需改代码 |

### 0.45.2 平台侧调查结论

| 项目 | 结论 |
| --- | --- |
| 现有平台 | 仍是五个：Bilibili / YouTube / Twitch / 抖音 / TikTok（未新增、未改动） |
| Kick 候选 1 `achrafthedev/kixo` | 存在；MIT；创建 2026-10-17、最后推送 **2026-10-25**；1 star；JS（Electron+React）；**唯一在 2026 年跟踪 Kick 实时协议演进的参考** |
| Kick 候选 2 `LOX-X/Kick-Live-Connector` | 存在；MIT；最后推送 **2024-11-01**（停更约 2 年）；TypeScript；README 给出完整消息结构（含 `sender.id`） |
| Kick 候选 3 `Landy-Dev/kick-api` | 存在；Apache-2.0；**Rust**；最后推送 2026-04-10；官方 API 客户端，**技术栈与用途均不适配** |
| Kick 官方 API 能力 | **无读取聊天的 scope/端点**（只有 `chat:write`、`events:subscribe` webhook、moderation）；使用官方 API 需应用+OAuth → 违反「免登录」条件 |
| Kick 免登录读聊天 | 公开 web 端点 + 匿名 guest token（Centrifugo）/ 公开 Pusher app key；**文档+源码级证据成立，本仓库未实测** |
| Kick 字段 | `sender.username`、`sender.id`（稳定 ID 候选）、消息 UUID `id`、`created_at`、`identity.badges`、内容含 `[emote:id:name]` |
| Kick 状态 | **G0 有条件通过，G1 未做**（本轮未连接 Kick）。界面/文档不得出现「已支持 Kick」 |
| 其余 9 平台 | 仅到调查清单深度：虎牙/斗鱼/快手有可参考实现（MIT Java 反向 WebSocket）；CHZZK 官方 API 需密钥、非官方库 2024-08 停更；SOOP 有 2026-04 更新的 Go 聊天库；Niconico 两个实现均已归档/停更且很可能需登录；小红书/YY 本轮未发现维护中实现；Facebook Live 预判不满足免登录 |

### 0.45.3 新增与更新的文档

| 文件 | 类型 | 主要内容 |
| --- | --- | --- |
| `docs/I18N.md` | **新增** | 三层语言模型与三条不变式；当前实现的实测矩阵；8 项技术调查结论；BCP-47 语言码与降级规则；M-I18N-0..3 里程碑（前置/范围/完成标准/风险）；AI 辅助翻译流程与机器门禁；12 项未解决风险 |
| `docs/PLATFORM_ADMISSION.md` | **新增** | 三准入条件与判定方法；字段最低要求表；登录方案优先序；G0–G6 七阶段门禁；证据等级与表述口径；8 条暂停条件；MIT/Apache/BSD/AGPL 许可证策略；每平台交付物清单 |
| `docs/PLATFORM_EXPANSION_RESEARCH.md` | **新增** | 调查方法与证据来源；10 个候选的顺序与初判；Kick 三个候选项目核实表；Kick 官方 API 边界；非官方实时通道技术轮廓与消息结构；Kick 设计要点与 6 项风险；其余平台线索与待验证清单 |
| `AGENTS.md` | 更新 | §2 阅读顺序加入三份新文档；§4 目录说明；**§6.16 国际化三层分离（长期约束）**；**§6.17 新平台三准入条件（长期约束）**；§7 三语→清单驱动 + 布局容忍译文；§10 新增 5 条禁止事项；§11 自检清单 |
| `docs/ROADMAP.md` | 更新 | 顶部本轮摘要；新增 P38（本轮规划 ✅）、P39–P42（I18N-M0..M3 ⬜）、P43（KICK-M0 🟡）、P44（平台扩展调查 🟡）；`依赖关系` 增加两条主线与排序原则 |
| `docs/ARCHITECTURE.md` | 更新 | §10 未来扩展点：平台适配器前置门禁、国际化三层与「清单单一来源 + 降级」要求 |
| `docs/PLATFORM_INTEGRATIONS.md` | 更新 | §10 末尾指向新的准入规范，声明目前无新平台通过 G1 |
| `docs/STATUS.md` | 更新 | 本节（§0.45） |

### 0.45.4 测试结果（真实执行）

| 运行 | 结果 |
| --- | --- |
| `node --test tests/unit` | ❌ 不可用：`[exit code: 1]` `spawn EPERM`（沙箱禁止带管道 stdio 的子进程；见 AGENTS.md §5 受限环境说明） |
| `node --test --test-isolation=none "tests/unit/*.test.mjs"` | **687 passed / 0 failed / 0 skipped**（13,993.61 ms）— 与 §0.44 的 687 unit 完全一致 |
| 定向 `i18n.test.mjs` + `help-ui` + `ai-ui` + `ai-translation-ui` | **20 passed / 0 failed** |
| 集成测试 | **本轮未运行**：只改 Markdown 文档，无代码路径变化；不据此宣称集成通过 |

### 0.45.5 本轮明确未做

- 未新增 `ko` / `es` / `pt-BR` / `zh-TW` / `fr` / `de` / `id` 任何字典文件或语言设置。
- 未新增 `src/platforms/<新平台>/`；未连接 Kick 或任何新平台。
- 未修改五平台采集逻辑、AI 分析、长期画像、数据保存/恢复、备份格式、数据库 schema。
- 未改 `src/web/js/i18n.js`、`locale.mjs`、任何 CSS 或 `ai.js`。
- 未安装依赖、未引入第三方代码、未复制任何开源实现代码。
- 未构建 EXE、未打包、未发布、未 Push、未 Merge、未 Tag。

### 0.45.6 Git 状态

- 分支 `main`（起始 clean，HEAD `25e6fbe`），本轮创建本地提交 **`338522a`**
  `docs: plan ten-language i18n and platform admission`（**10 files changed，+1308 / −12**）。
- 提交内容只有 `AGENTS.md`、`docs/*.md`、`log/*.md`；**没有任何 `src/`、`tests/`、`scripts/`、
  `package.json` 或配置改动**（`git show --name-only` 已核对）。
- 提交身份为匿名 noreply（`zgrg29 | 10182596+zgrg29@users.noreply.github.com`）。
- 未 Push、未打 Tag、未发布 Release。

### 0.44 TIKTOK-M6 人工验收与合并 main（2026-11-16）🟢

开发者已在普通 Windows 桌面亲自完成 TikTok 多直播间人工验收，并明确批准将 `feature/tiktok`
合并到本地 `main`。本轮只执行本地合并、回归验证、`main` 上重建 EXE 与文档记录；
**未 Push、未创建 Tag、未发布 Release、未删除功能分支、未修改许可证。**

### 0.44.1 合并前检查

| 项目 | 结果 |
| --- | --- |
| 当前分支 | `feature/tiktok` |
| 工作区 | clean |
| merge-base | `410bfc3ffacc712b6fd56a9e63f4d5afcca4bcb7`（当时 `main` HEAD） |
| 分叉关系 | `main...feature/tiktok` = `0 / 20`（main 无独立新提交） |
| 功能提交 | `54934f6` `feat: allow concurrent TikTok rooms and remove the simulator UI` |
| UI 修复 | `4224f7c` `fix: refresh the TikTok room list in place` |
| 文档提交 | `e992534` `docs: record TikTok multi-room acceptance and simulator removal` |
| 验收 EXE | Build ID `e48016f19362`，构建 commit `4224f7c` |

`git diff feature/tiktok..main` 在合并前没有“仅 main 有”的功能文件；合并后
`git diff --stat feature/tiktok main` 为空，说明 `main` 树与功能分支完全一致，
Bilibili / YouTube / Twitch / 抖音 已合并成果未被覆盖。

### 0.44.2 合并

| 项目 | 值 |
| --- | --- |
| 合并方式 | `git merge --no-ff feature/tiktok` |
| 合并提交 | `980de0f97a4b700c6c29aa569ca87cc734748021` |
| 父提交 1 | `410bfc3ffacc712b6fd56a9e63f4d5afcca4bcb7`（原 main） |
| 父提交 2 | `e9925348a514fb93877889e672bfec4c3a383299`（feature/tiktok） |
| 结果 | 无冲突；67 files changed，+11,758 / −130 |
| 合并后 main 树 | 与 `feature/tiktok` 完全一致 |

### 0.44.3 合并后回归

| 运行 | 结果 |
| --- | --- |
| 全量单元 | **687 passed / 0 failed / 0 skipped（17,701.12 ms）** |
| 全量集成 | **347 passed / 0 failed / 0 skipped（270,438.05 ms）** |
| 合计 | **1034 passed / 0 failed / 0 skipped** |
| `git diff --check` | 通过 |
| SQLite schema / AI / analytics diff | 相对合并前 main **无变更**（schema 仍 16） |
| 五平台路由 | `/api/{bilibili,youtube,twitch,douyin,tiktok}/connect` 均存在 |
| 五平台打包 | `build/manifest.json` 含五平台全部模块（Bilibili 9 / YouTube 7 / Twitch 7 / 抖音 14 / TikTok 10） |
| 模拟入口 | `live.js` 无 `mockTab`、无 `/api/simulate/start`；历史 mock 键仍存在 |
| 三语 i18n | 三语键集与占位符一致，无新增原始键 |

### 0.44.4 合并后 Windows EXE

| 项目 | 值 |
| --- | --- |
| 文件 | `D:\LiveMemory\dist\LiveMemory.exe` |
| Build ID | `e48016f19362`（`src/` 未变，故与验收 EXE 相同） |
| 构建时 commit | `980de0f97a4b700c6c29aa569ca87cc734748021`（合并提交） |
| source hash | `e48016f193625e919be6dd2e744eac093aefb889144a5a8825edd2faba51dbdb` |
| 大小 | `96,730,112` bytes |
| SHA-256 | `1b8cbe63181f97b74bf871ce9c3e2658bb715227a72d05f54691ca6aaca5909c` |
| builtAt | `2026-11-16T05:05:58.502Z` |
| 资源 / 模块 | 226 files / 51 required modules |
| RT_MANIFEST | **`requireAdministrator`** |
| `verify-exe` | **10/10** |
| `verify-tiktok-exe @aljazeeraenglish` | **22/22 passed + 2 NOT-OBSERVED，0 failed** |
| `verify-tiktok-multi-exe` | **17/17 passed，0 NOT-OBSERVED，0 failed** |

真实双房间（`main` 合并后，2026-11-16 13:08–13:11 Asia/Shanghai）：
`@aljazeeraenglish` / room `7706695538414062349` + `@aljazeera` / room `7706505863599508276`；
session A `ses_01M7HC2VBSFYPV4JBW1P`、B `ses_01M7HC33MSXWTZVR5JN6`。两场均 `connected`；
同一窗口 A 收到 **1 条**、B 收到 **2 条**真实 chat；重复 A 409 `SESSION_DUPLICATE_ROOM`；
停止 A 后 B 仍 `connected` 且消息 **2 → 3**；两场 AI report 均 200；SQLite 两场 ended、
room/session 不同、UID/msgId 完整。产物 `tests/.tmp/verify-tiktok-multi-2026-11-16T05-08-00-619Z`
（临时目录，不提交）。样本很小，**不代表长期压力测试**。

### 0.44.5 五个平台状态（合并后）

| 平台 | 状态 |
| --- | --- |
| Bilibili | 路由/适配器/打包存在；自动化全绿；EXE 状态 200 |
| YouTube | 公开网页聊天路径存在；自动化 E2E 全绿；EXE 状态 200 |
| Twitch | 匿名 IRC 适配器存在；自动化全绿；EXE 状态 200 |
| 抖音 | 适配器/登录/打包存在；自动化全绿；EXE 状态 200 |
| TikTok | 匿名本地 webcast；单房间与双房间真实 EXE 验收通过 |

### 0.44.6 仍未完成 / NOT-OBSERVED（不得改成 PASS）

- TikTok 真实礼物：**NOT-OBSERVED**。
- TikTok 真实连送：**NOT-OBSERVED**。
- TikTok 真实订阅：**NOT-OBSERVED**。
- 长期多房间压力测试：**未执行**（真实双房间样本仅 A 4 条 / B 1 条）。
- 真实网卡断线与真实下播长跑：**未执行**；仅自动化覆盖强制断线与两次离线确认。
- 干净 Windows 账户、真实双击 UAC：仍需人工确认。

### 0.44.7 Git 状态

| 项目 | 值 |
| --- | --- |
| 分支 | `main` |
| 合并提交 | `980de0f` |
| 最终 main HEAD | 本轮文档提交（见 `git log -1`） |
| 工作区 | clean |
| 远程 | `main` 领先 `origin/main`，**未 Push** |
| Tag / Release | **未创建** |
| 功能分支 | `feature/tiktok` 保留 |

## 0.43 TIKTOK-M6：TikTok 多直播间并发与模拟直播清理（2026-11-16）🟢（feature/tiktok，真实双房间 + EXE 已验收）

范围：只修复「TikTok 只能记录一个直播间」与「正式界面仍提供模拟直播」两项产品问题。
**未改数据库 schema（仍 16）、AI 结果 Schema、提示词、其他四个平台适配器或事件语义；未新增运行时依赖；
未合并 main、未 Push、未 Tag、未 Release。**

### 0.43.1 真实根因（不是后端单例）

| 检查项 | 结论 |
| --- | --- |
| `SessionManager` | 已支持同平台多个独立 recording；`Map<sessionId, recording>`，每场独立 adapter/连接/停止 |
| 重复保护 | `findDuplicate(platform, platformRoomId)` 只拒绝**同一平台 + 同一 room**，并不拒绝同平台其他房间 |
| `TikTokService` | 每次 `connect` 创建新的 `TikTokLocalAdapter`，共享的只有匿名 `ttwid` 设备 Cookie（有意共享） |
| `TikTokLocalAdapter` | 每个实例独立 socket、`seenIds`、`pendingGifts`、重连 timer、offline 观测、结束判断 |
| SQLite | `sessions` 与 `events` 按 `session_id` 隔离；`UNIQUE(session_id, dedupe_key)` |
| **前端（真实限制）** | `buildTikTokRoomMeta()` 使用 `!tiktokActiveRecording()`，把「存在任意 TikTok 记录」当成「该房间已在记录」；开始按钮被全局禁用并显示 `tiktokAlreadyRecordingHint` |
| 页面展示 | `tiktokActiveRecording()` 只取第一条 TikTok 记录，第二场无法从面板区分/停止 |

因此：后端本来支持并发，**限制来自 TikTok 面板的全局单房间判断**。修复没有取消重复保护，
而是把判断收窄为同一个 `platformRoomId`（handle 作为回退），保留服务端 `SESSION_DUPLICATE_ROOM`。

### 0.43.2 实现

| 模块 | 内容 |
| --- | --- |
| `src/web/js/pages/live.js` | 新增 `tiktokRecordings()` / `tiktokRecordingForRoom(room)` / `tiktokPanelRecording()`；只有同一 room 才禁用开始；不同 room 显示「另有 N 个直播间在后台记录」 |
| `live.js` | 新增 TikTok 活动列表：每个直播间显示主播、handle、采集状态、已记录消息数、独立「查看/停止」 |
| `live.js` | 新建记录页新增「正在记录」卡片：主播、平台、连接状态、消息数、观众数、独立停止；数量为 0 时隐藏 |
| `live.js` | 默认平台改为 `bilibili`；删除模拟直播标签、模拟面板、`handleStart()` 与顶部「开始模拟直播」按钮；同时修正 `history.aiTitle` 原始键为 `history.detail.aiTitle` |
| `src/server/routes.mjs` | `/api/bootstrap` capabilities 只列出五个真实平台（移除 mock，补齐 Twitch/抖音/TikTok）；`/api/simulate/*` 保留为内部测试夹具并加注释 |
| `src/launcher/launcher.mjs`、`cli-i18n.mjs` | 删除启动器每条命令都打印的「当前为模拟直播」提示 |
| `src/web/i18n/*.json` | 三语更新新建记录/活动列表文案；删除 `mockTab`、`mockNote`、`live.hero.start`、`starting`、`startFailed`、`simulationTitle`；保留历史模拟场次徽标与说明 |
| `src/web/styles/pages.css` | 新增 `.live-recording-row`、`.live-recording-meta`、`.live-recording-actions`、`.tiktok-active-recordings`；沿用设计 token |
| `src/server/index.mjs` | 新增测试注入项 `tiktokTtwidProvider`（仅测试使用，生产不传） |

**保留的测试基础设施**：`MockLiveSource`、`SessionManager.startSimulation()`、`/api/simulate/start|stop`、
`tests/helpers/*`、演示/验收脚本均未删除。正式页面不再引用它们；历史 `platform='mock'` 数据仍可读取。

### 0.43.3 五个平台并发审查

| 平台 | 同平台多房间 | 跨平台 | 备注 |
| --- | --- | --- | --- |
| Bilibili | ✅ 每个房间独立 adapter；UI 只按开播状态限制 | ✅ | 未改适配器 |
| YouTube | ✅ 每个视频独立 adapter/continuation；已有双场真实测试 | ✅ | 未改适配器 |
| Twitch | ✅ 每个频道独立 IRC adapter；已有双频道测试 | ✅ | 未改适配器 |
| 抖音 | ✅ `Map<sessionId, adapter>`；已有双房间测试 | ✅ | 未改适配器/登录 |
| TikTok | ✅ 修复前仅前端全局限制；服务端一直支持 | ✅ | 本轮新增真实双房间 EXE 验收 |

没有新增任何「最多 N 场」业务上限。

### 0.43.4 自动化测试

| 运行 | 结果 |
| --- | --- |
| 新增/定向（新增文件 + 受影响既有测试） | **26 passed / 0 failed** |
| 全量单元 `tests/unit/*.test.mjs` | **687 passed / 0 failed / 0 skipped（31,958.09 ms，2026-11-16）** |
| 全量集成 `tests/integration/*.test.mjs` | **347 passed / 0 failed / 0 skipped（445,550.52 ms，与单元测试并行运行，2026-11-16）** |
| 合计 | **1034 passed / 0 failed / 0 skipped** |
| `scripts/verify-exe.mjs` | **10/10**（Build ID `e48016f19362`，commit `4224f7c`） |
| `scripts/verify-tiktok-exe.mjs @aljazeeraenglish` | **22/22 passed + 2 NOT-OBSERVED，0 failed**（真实 chat、稳定 UID、msgId、帧/事件分离、自动监听、SQLite、AI、重启、四平台回归） |
| `scripts/verify-tiktok-multi-exe.mjs` | **17/17 passed，0 NOT-OBSERVED，0 failed**（真实双房间，见 §0.43.5） |

新增测试文件：

- `tests/integration/tiktok-concurrent.test.mjs`：同平台 A/B 并发；不同 room；两场各自事件；
  同一 msgId 在两个 session 都保留；稳定 UID 归属；停止 A 不影响 B；A 断线重连只影响 A；
  A 两次离线确认下播只结束 A；重复启动 A 被 409 拒绝且 session 数不增加。
- `tests/integration/tiktok-live-api.test.mjs`：HTTP `/api/live/recordings` 同时列出两场、messageCount、
  broadcaster、独立停止；重复 A 409；A 停止后 B 继续接收；两场 AI report 各自可读。
- `tests/integration/tiktok-cross-platform.test.mjs`：TikTok + Bilibili 同时记录，独立生命周期。
- `tests/unit/live-new-ui.test.mjs`：模拟入口彻底移除、五个真实平台、活动列表与独立停止、
  三语字面键齐全、历史模拟数据键仍在、`/api/simulate/*` 仅作测试夹具。
- `tests/unit/tiktok-ui.test.mjs`：新增「不同 TikTok room 不算重复」的结构断言。

五平台回归口径：

| 平台 | 本轮自动化 | 本轮真实直播 | 结论 |
| --- | --- | --- | --- |
| Bilibili | 集成/解析/会话/停止全绿 | `verify-bilibili.mjs 6 45`：room `6` → `7734200`，**2 条 chat / 2 位可识别观众**，停止 `ended` | ✅ 未回归 |
| YouTube | 公开网页聊天 E2E（本地 fake web）+ 生命周期全绿 | 未重新做真实直播采样 | 🟡 真实采样 **NOT-OBSERVED（本轮未重跑）** |
| Twitch | 匿名 IRC 适配器/服务/双频道隔离全绿 | 未重新做真实频道采样 | 🟡 真实采样 **NOT-OBSERVED（本轮未重跑）** |
| 抖音 | 适配器/服务/双房间隔离/礼物解析全绿 | 未重新做真实直播间采样 | 🟡 真实采样 **NOT-OBSERVED（本轮未重跑）** |
| TikTok | 并发/API/跨平台/UI 全绿 | 单房间 `verify-tiktok-exe` 22/22；双房间 `verify-tiktok-multi-exe` 17/17 | ✅ 真实双房间通过 |

四个非 TikTok 平台的 EXE 状态端点在 `verify-tiktok-exe` 中仍为 200（Bilibili、YouTube `web`、
Twitch `anonymous-irc`、抖音），说明路由与启动未被破坏；但**真实直播采集本轮只重跑了 Bilibili**，
不得把自动化和状态端点写成四个平台的真实采集验收。

### 0.43.5 真实 TikTok 双房间 EXE 验收

脚本：`scripts/verify-tiktok-multi-exe.mjs`（新增）。正式 EXE 的 asInvoker 功能副本
（`e48016f19362`，commit `4224f7c`）在隔离数据目录启动，通过真实 TikTok 公开接口解析两个不同直播间，
再经匿名本地 WebSocket 同时连接。

| 项目 | 结果 |
| --- | --- |
| 房间 A | `@aljazeeraenglish` / room `7706695538414062349` / 主播 Al Jazeera English |
| 房间 B | `@aljazeera` / room `7706505863599508276` / 主播 الجزيرة |
| 两场 session | `ses_01M7H90WMS2MMC18X77V` / `ses_01M7H915E4VKBFGC34VF`（不同） |
| 连接 | 两场均 `connected`，独立 room id 与 socket |
| 真实弹幕 | A **4 条**；B **1 条**（两场同一窗口内都收到真实 chat） |
| 稳定 ID / 消息 ID | A 4/4 UID、4/4 msgId、4 个不同 msgId；B 2/2 UID、2/2 msgId、2 个不同 msgId |
| 重复启动 A | HTTP 409 `SESSION_DUPLICATE_ROOM`，`recordings=2`，未创建第二个 A |
| 停止 A | HTTP 200；B 仍 `connected`，消息数 **1 → 2** |
| AI 读取 | A、B 的 `/api/ai/sessions/:id/report` 均 HTTP 200 |
| 停止 B / 退出 | 均成功；SQLite 两场均为 `ended`，room id 不同、session id 不同 |
| 脚本结果 | **17/17 passed，0 NOT-OBSERVED，0 failed** |
| 运行时间 / 产物 | 2026-11-16 12:14–12:17（Asia/Shanghai）；`tests/.tmp/verify-tiktok-multi-2026-11-16T04-14-29-211Z`（临时目录，不提交） |

说明：这是一次真实平台运行，两场确实同时收到了真实弹幕；但每场只有 1–4 条，样本很小。
更早一次用 `@gbnews` 作 B 的尝试中，两场均 `connected`，A 收到 40 条真实弹幕，B 在 90 秒内
**0 条**（该房间聊天不活跃/未投递）；该次未计为通过。礼物仍为 **NOT-OBSERVED**。

### 0.43.6 Windows EXE

| 项目 | 值 |
| --- | --- |
| 文件 | `D:\LiveMemory\dist\LiveMemory.exe` |
| Build ID | `e48016f19362` |
| source hash | `e48016f193625e919be6dd2e744eac093aefb889144a5a8825edd2faba51dbdb` |
| commit（构建时 HEAD） | `4224f7cb32852a4499518563456bbe1dfe2c9f00` |
| 大小 / SHA-256 | `96,730,112` bytes / `02acd0b1fdd916edca65cff8423316153318b04435413b2ff741e4cde307f3db` |
| builtAt | `2026-11-16T04:10:37.647Z` |
| 资源 / 模块 | 226 files / 51 required modules |
| RT_MANIFEST | **`requireAdministrator`** |
| 版本 | `0.13.3` |

- 正式 EXE 构建于代码提交 `4224f7c` 之后；`build-info.commit` 等于该提交。
  本轮最后的文档/脚本提交只改文档与验证脚本，不改变 `src/` 内容或 `buildId`。
- asInvoker 功能副本用于自动化；正式 EXE 单独断言 `requireAdministrator`。真实双击 UAC 仍需人工确认。

### 0.43.7 尚未解决 / NOT-OBSERVED / 人工验收

- **真实两场同时收到弹幕**：**已通过**（§0.43.5，A 4 条 / B 1 条，样本较小）；
  另一次 `@gbnews` 作为 B 的运行未收到 B 弹幕，已如实标为未计入通过。
- **真实礼物 / 连送 / 订阅**：本轮仍未观测到 → **NOT-OBSERVED**。
- **真实网卡断网、A 真实下播长跑**：未执行；自动化覆盖强制断线与两次离线确认。
- **干净 Windows 账户 / 真实双击 UAC**：未验证。
- TikTok 协议为非官方且无续传游标；多开不改变这一边界。

### 0.43.8 Git / 交付

| 项目 | 值 |
| --- | --- |
| 分支 | `feature/tiktok` |
| 代码 / 测试提交 | `54934f60ac465b5f1cd9a1eba716279a027afe12`（`feat: allow concurrent TikTok rooms and remove the simulator UI`）；`4224f7cb32852a4499518563456bbe1dfe2c9f00`（`fix: refresh the TikTok room list in place`，正式 EXE 构建于此提交） |
| 文档 / 验证脚本 / 构建记录 | 本轮最终 HEAD（见 `git log -1`） |
| main | **未合并、未 Push、未 Tag、未 Release** |

## 0.42 TIKTOK-M5：匿名本地 WebSocket 统一采集，删除登录与通道选择（2026-11-16）🟢（feature/tiktok，真实 30 分钟 + EXE 已验收）

范围：按用户明确授权，验证并接入 `talkaboutdesign/tiklive` 所采用的**匿名本地 TikTok LIVE WebSocket**，成功后把
TikTok 统一为唯一、无需登录的采集方式，删除扫码登录、浏览器中继与免费社区签名通道。
**未改数据库 schema（仍 16）、AI 结果 Schema、提示词；未改 Bilibili / YouTube / Twitch / 抖音适配器；未新增运行时依赖；
未合并 main、未 Push、未 Tag、未 Release。**

### 0.42.1 技术与合规审查（结论：无阻断性许可证或访问控制问题）

| 项目 | 结论 |
| --- | --- |
| 上游源码 | `talkaboutdesign/tiklive` @ `a290dd4`（v0.6.0）；MIT；Copyright 2026 Talkabout Design LLC |
| 是否复制源码 | **否**。上游核心依赖 Effect 4 + Bun，无法嵌入零依赖 Node SEA；本项目按其协议用原生 Node 重写，归属写入 `THIRD_PARTY_NOTICES.md` |
| 许可证 | MIT 允许派生/再分发；未打包上游任何文件 |
| 额外运行时 | 无（不需要 Bun / Python / Chrome / `npm install`） |
| 用户安装 | 无额外程序 |
| 第三方云服务 | 无；**不依赖付费或免费社区签名服务**，无 API Key |
| 隐藏配额 | 无开发者配额；只有 TikTok 自己的匿名页面/连接限流 |
| 持续性 | 是；真实 30 分钟连续采集 + 强制断线重连（§0.42.3） |
| 稳定 UID | 是；`tiktok:<user.id>` |
| 礼物/连送 | 解析 + 连送合并 + 去重 + SQLite 集成测试；**本轮真实运行未观测到礼物 → NOT-OBSERVED** |
| 平台条款/访问控制 | 使用 TikTok **非公开 web 协议**，不是官方 API；未绕过验证码、登录、地区或权限控制。若平台明确拒绝访问，必须停止并报告 |
| 阻断性问题 | 未发现许可证或访问控制阻断；协议可变，产品始终标注「非官方 / 实验性」 |

### 0.42.2 实现（唯一路径 `local`）

| 模块 | 内容 |
| --- | --- |
| `src/platforms/tiktok/webcast.mjs`（新） | 匿名 `ttwid`（3 次退避重试、持久化、`0600`）、socket URL、PushFrame 编解码、`im_enter_room`/`hb`/`ack`、空闲检测、双 host 回退、逐帧计数 |
| `src/platforms/tiktok/local-adapter.mjs`（新） | 连接状态机、1→30 秒退避重连、12 次后 5 分钟慢探测、两次离线确认、连送合并/超时冲刷、msgId 去重（含礼物）、历史回放跳过、房间重校验、gap 记录 |
| `src/platforms/tiktok/state.mjs`（新） | `<data>/tiktok/ttwid.json` 匿名设备 Cookie（非登录凭据；不进入备份/导出/AI 包） |
| `src/platforms/tiktok/legacy-cleanup.mjs`（新） | 只删除带 `.livememory-owned` 标记的旧 TikTok 专用 Profile 与 LiveMemory 自己的 `login-state.json`；无标记目录一律保留并记录 |
| `src/platforms/tiktok/service.mjs` | 单一 `local` 路径；`transport()` 不含选择；状态中移除 `login`；共享 ttwid；停止/结束状态可回读（含通过共享 stop 路由停止） |
| `src/server/{index,routes,settings-store}.mjs` | 删除 `/api/tiktok/login/*` 与 `/api/tiktok/transport`（现 404）；删除 `tiktokTransport` 设置（旧客户端提交得到 `SETTINGS_INVALID`）；启动时恢复 ttwid + 清理旧 Profile |
| `src/monitoring/detectors/tiktok.mjs` | 本地传输错误映射（socket/timeout/network/rate-limit/not-configured） |
| `src/web/js/pages/live.js` | 面板只保留：链接/`@用户名`、检查直播间、开始/停止记录、自动监听、采集状态与错误；**四项独立状态**（直播间识别 / 采集连接 / 真实事件 / 正式记录）+ 高级技术详情 |
| `src/web/i18n/*.json` | 删除 96 个旧键 × 3 语言；新增本地采集、四项状态、技术详情、错误文案；三语键完全一致 |
| `scripts/verify-tiktok-local-ws.mjs`（新） | 独立 30 分钟真实长测（帧/事件/UID/msgId/重复/静默/重连/请求数），JSON 报告 |
| `scripts/verify-tiktok-exe.mjs` | 改为匿名本地传输验收；断言登录/通道路由 404；礼物未观测时输出 `NOT-OBSERVED` 且不计失败 |
| `scripts/build-windows.mjs` | 必需模块列表更新为 10 个 TikTok 模块 |

事件语义未变：聊天原文原样保存；身份 `tiktok:<user.id>`；`msgId` 去重；连送只在最终态写一条；
钻石只作展示价值（`amount_minor=null`、`value_kind=unknown`）；member/like/social 只计数；
`WebcastControlMessage(3)` 只是一次离线观测，需两次确认才结束。

### 0.42.3 真实 30 分钟采集（独立验证，非正式 adapter）

命令：`node scripts/verify-tiktok-local-ws.mjs --room-id 7706695538414062349 --minutes 30 --reconnect-at-minute 12`

| 指标 | 结果 |
| --- | --- |
| 窗口 | 2026-11-16 10:54:56 → 11:24:57（Asia/Shanghai），30.00 分钟连续 |
| 房间 / host | `aljazeeraenglish` / `7706695538414062349` / `webcast-ws.tiktok.com` |
| 连接次数 / 重连 | 2 / 1（第 12 分钟强制断线，第 1 次重试即成功；仍是同一 session） |
| 帧 / 事件批 / 控制帧 | 2427 / 2247 / 180 |
| 消息 / 历史回放跳过 | 8192 / 12 |
| 真实 chat | **706**；**110** 位可识别观众（110 个稳定 UID） |
| 昵称 / 原文 | 110 个昵称；408 条非 ASCII（Unicode/Emoji 原样） |
| 缺失字段 | UID 0 / msgId 0 / 原文 0 |
| 重复事件 | **0**（0 个重复 msgId） |
| 礼物 / 连送 / 订阅 | **0 / 0 / 0 → NOT-OBSERVED** |
| 最大静默 | 8,935 ms |
| 速率 | 80.9 帧/分、273.1 消息/分、23.53 弹幕/分 |
| 请求 | ttwid 0（复用缓存）/ 房间查询 0（直接用 room-id 启动）/ WebSocket 连接 2 |
| 报告 | `tests/.tmp/verify-local-ws-30m-v2/report.json`（临时目录，不提交） |

未映射消息（只计数、不写事件）：`WebcastMemberMessage` 4,619、`WebcastLikeMessage` 1,690、
`WebcastRoomUserSeqMessage` 883、`WebcastSocialMessage` 249、`WebcastBarrageMessage` 13、
`WebcastHotRoomMessage` 10、`WebcastAISummaryMessage` 6、`WebcastImDeleteMessage` 2。
礼物与订阅在该房间的真实运行中为 0，故标记 **NOT-OBSERVED**；不得据此宣称礼物已真实验收。

### 0.42.4 删除的旧实现与兼容清理

- 删除文件：`browser-login.mjs`、`browser-launch.mjs`、`browser-relay.mjs`、`signer.mjs`、`rate-budget.mjs`、
  轮询 `adapter.mjs`、`transports.mjs`。
- 删除测试：`tiktok-browser-login`、`tiktok-browser-relay`、`tiktok-signer`、`tiktok-adapter`、`tiktok-rate-budget`、
  `tiktok-reconnect`；重写 `tiktok-session` / `tiktok-monitoring` / `tiktok-ui`。
- 删除脚本：`verify-tiktok-browser-login.mjs`、`verify-tiktok-live-30m.mjs`。
- UI / i18n：删除扫码登录、登录状态、关闭登录窗口、退出登录、Cookie 检测与会话管理、通道选择、签名额度等入口与文案。
- **抖音登录未受影响**：`src/platforms/douyin/browser-login.mjs` 等独立模块、路由、测试保持原样。
- **TikTok 不再存在登录依赖**：没有登录路由、登录状态字段、Cookie 读取、账号凭据或专用 Profile 依赖；
  唯一保留的是 `legacy-cleanup.mjs` 对旧版本遗留文件的一次性清理。
- **其他四平台未受影响**：Bilibili / YouTube / Twitch / 抖音适配器、数据库 schema、AI 契约与提示词均未改；
  EXE 回归中四个状态端点仍为 200（YouTube `web`、Twitch `anonymous-irc`）。
- 历史 TikTok 数据完整保留（schema 未改）；旧专用浏览器 Profile 由 `legacy-cleanup.mjs` 安全清理，
  绝不触碰 Chrome/Edge 日常资料。

### 0.42.5 自动化测试

| 运行 | 结果 |
| --- | --- |
| 定向 TikTok（`tests/unit/tiktok-*.test.mjs` + `tests/integration/tiktok-*.test.mjs`） | **72 passed / 0 failed / 0 skipped（6,293.84 ms，2026-11-16）** |
| 全量 `node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"` | **1019 passed / 0 failed / 0 skipped（290,038.02 ms，2026-11-16）** |
| `scripts/verify-exe.mjs` | **10/10**（Build ID `9b63b0018235`，commit `a0e6638`） |
| `scripts/verify-tiktok-exe.mjs @aljazeeraenglish` | **22/22 passed + 2 NOT-OBSERVED，0 failed**（真实 chat / 稳定 UID / msgId / 帧与事件分离 / 自动监听 / SQLite / AI / 重启 / 四平台回归） |

EXE 专项断言（真实运行）：

- TikTok 状态：`mode=local`、`transport=local/webcast-ws`，状态中**没有 `login` 字段**，`requiresLogin=false`。
- 已删除路由在打包 EXE 内返回 **404**：`/api/tiktok/login/status|start|verify|cancel|logout`、`/api/tiktok/transport`。
- 真实房间解析：`aljazeeraenglish` / room `7706695538414062349` / 主播稳定 ID `7074562477175424046`。
- 连接：HTTP 201、`connected`、`transport=local`、`ws host=webcast-ws.tiktok.com`、`error=none`。
- 帧与事件分离：frames 8 / batches 7 / chats 1（messages 31，history skipped 6）。
- 真实事件：`tiktok:<user.id>`、昵称、原文、消息 ID 写入 SQLite；AI report 200；长期画像 200。
- 自动监听：创建目标 → check → `recording` → 真实 chat → 删除目标。
- 重启：同一 Build ID，session 与数据保留；Bilibili/YouTube/Twitch/抖音状态仍 200。
- 礼物：真实运行与 SQLite 两处均为 **NOT-OBSERVED**（脚本单独计数，不计为失败）。

其他四平台真实回归（源码服务器，真实公开直播，2026-11-16）：

| 平台 | 输入 | 结果 |
| --- | --- | --- |
| Bilibili | 房间 `6` | 201 `connected`；真实 1 条消息 / 1 位可识别观众；停止成功 |
| YouTube | `4t4AQ15yj1M` | 201 `connected`；真实 75 条消息 / 12 位可识别观众；停止成功 |
| Twitch | `kato_junichi0817` | 201 `connected`；真实 7 条消息 / 7 位可识别观众；停止成功 |
| 抖音 | `708764876300` | 201 `connected`；真实 2 条消息 / 2 位可识别观众；停止成功 |

### 0.42.6 Windows EXE

| 项目 | 值 |
| --- | --- |
| 文件 | `D:\LiveMemory\dist\LiveMemory.exe` |
| Build ID | `9b63b0018235` |
| source hash | `9b63b00182354491b99948744dd6ea8109a2be8d501acdd3a0bf6a59a3a6c29f` |
| commit（构建时 HEAD） | `a0e663859b5c1d3bb4b536cf5d36859a480d9023` |
| 大小 / SHA-256 | `97,760,768` bytes / `5d66ab103549d96f6d920926da81bc04ab8853ee46891a2be4dfbd61f1dbddd1` |
| builtAt | `2026-11-16T03:26:23.262Z` |
| 资源 / 模块 | 226 files / 51 required modules |
| RT_MANIFEST | **`requireAdministrator`** |
| EXE 验收 | `verify-exe` **10/10**；`verify-tiktok-exe` **22/22 passed + 2 NOT-OBSERVED，0 failed** |
| 版本 | `0.13.3` |

- EXE 在代码提交 `a0e6638` 之后重建，因此 `build-info.commit` 等于该代码提交；本轮最后的文档/构建记录提交
  在其后（见 `git log -1`），只改文档与日志，不改变 `src/` 内容或 `buildId`。
- asInvoker 功能副本用于自动化场景；正式 EXE 单独断言 `requireAdministrator`。真实双击 UAC 仍需人工确认。

### 0.42.7 尚未解决 / NOT-OBSERVED / 人工验收

- **真实礼物与连送：NOT-OBSERVED**。本轮唯一确认正在直播的 `aljazeeraenglish` 在 30 分钟内没有礼物；
  其他候选账号公开接口均为已结束。礼物/连送/订阅语义有合成帧 + SQLite + 去重测试，但**不得**写成真实礼物通过。
- **真实订阅（`WebcastSubNotifyMessage`）：NOT-OBSERVED**。
- **真实第二直播间并发：未执行**。自动化测试覆盖两个独立 session；本轮只有一个可确认在播房间。
- **真实断网（网卡/路由器）**：未执行；已验证强制断线后的自动重连与 gap 标记。
- **干净 Windows 账户 / 真实双击 UAC**：未验证；自动化只断言 `requireAdministrator` 与 asInvoker 功能副本。
- 协议为非官方、无续传游标：重连期间可能漏消息且不补录；TikTok 更改协议可随时失效。

### 0.42.8 Git / 交付

| 项目 | 值 |
| --- | --- |
| 分支 | `feature/tiktok` |
| 代码 / 测试 / 脚本提交 | `a0e663859b5c1d3bb4b536cf5d36859a480d9023`（`feat: unify TikTok capture on the anonymous local WebSocket`） |
| 文档与构建记录 | 本轮最终 HEAD（见 `git log -1`） |
| main | **未合并、未 Push、未 Tag、未 Release** |

## 0.41 TIKTOK-M4：真实 403 调查与浏览器中继链路审计（2026-11-16）🟡（feature/tiktok，真实登录后端到端仍 BLOCKED）

范围：只处理真实 Windows EXE 人工验收暴露的问题——登录后 `room/enter` HTTP 403、登录/采集状态矛盾、无真实事件、停止后原始 i18n 键。**未改数据库 schema、AI 结果 Schema、提示词、其他平台适配器；未新增运行时依赖；未合并 main、未 Push、未 Tag、未 Release。**

### 0.41.1 403 具体来源与根因

| 项目 | 结论 |
| --- | --- |
| 来源 | 官方直播页自身发出的 `POST /webcast/room/enter/` 网络响应；`BrowserSession.#onEvent()` 的 `Network.responseReceived` 观察到，状态 **403**。该请求不是本地中继构造的，也不是本地映射出来的错误 |
| 域名/阶段 | `www.tiktok.com` / `webcast.tiktok.com` 的直播间进入阶段（页面导航后、事件 WebSocket 之外）；不是登录页、不是 `room/info`、不是事件帧 |
| 是否官方返回 | 是。TikTok 返回 403；中继只读取浏览器网络事件，没有伪造、重放或绕过 |
| 是否复用登录上下文 | 是。登录与采集都使用 `<data>/browser/tiktok/account` 专用 profile；采集在同一浏览器中新建/复用 tab，Cookie 由 profile 共享 |
| 登录是否真的失效 | **不能由这个 403 单独判定**。旧代码把「直播间进入 403」直接映射为登录 `refused`，这是错误的；账号会话 Cookie 仍可能存在 |
| 页面可看直播但程序 403 | **可能**：`room/enter` 是一个 HTTP 进入调用，事件 WebSocket 可能仍独立投递。只读探针证明同一网络/机器上 TikTok webcast 事件通道可匿名收到真实事件（见 0.41.4），因此不能把该 403 当成「事件通道不可用」 |
| 平台明确拒绝自动化 | **没有证据**证明是平台针对自动化的明确拒绝；也没有证据证明是地区/账号/房间限制。可确认的是：该房间的进入调用返回 403。不得据此伪造成功，也不得绕过 |

本轮确认的产品根因不是「TikTok 永久封禁浏览器中继」，而是三个可验证的本地缺陷：

1. **403 误判并提前中止**：`waitForReady()` 看到 403 立即返回 `loginRequired`，适配器抛 `TIKTOK_LOGIN_REQUIRED`，并把登录标成 `refused`；即使页面 WebSocket 正在投递也会被放弃。
2. **帧格式错误**：中继把 WebSocket `PushFrame` 直接当 `WebcastResponse` 解析。当前 TikTok web 播放器的事件批次在 `PushFrame.payloadType='msg'` 的 field 8 内（通常 gzip），所以真实帧恒解出 0 条消息。旧测试用「已经是批次」的合成帧，掩盖了该缺陷。
3. **登录/直播间访问/采集状态混用**：`login.state='refused'` 同时表示「账号拒绝」和「直播间 403」；开始记录失败后 `status.capture` 为空，UI 退回原始 `tiktokCaptureStateIdle`；「开始记录」只看 session 连接，不看是否收到事件/是否被拒。

### 0.41.2 修复

| 模块 | 内容 |
| --- | --- |
| `browser-relay.mjs` | 新增真实的 `PushFrame` 解码路径（field 6/7/8 → gzip 批次）；保留旧 `WebcastResponse` 兼容；非 `msg` 控制帧忽略 |
| `browser-relay.mjs` | 403 不再立即失败：`waitForReady` 在 403 后给 6 秒宽限，真实帧优先；无帧才返回 `roomRefused`。适配器抛 `TIKTOK_ROOM_REFUSED`，不抛 `LOGIN_REQUIRED` |
| `browser-relay.mjs` | 新增 `roomAccess`、`captureState`、`roomUnconfirmed`；运行中 403 无事件时宽限后进入 `FAILED/platform_refused` 并结束 session；有事件则保持 `normal` 并保留警告 |
| `browser-login.mjs` | 登录态与直播间访问分离：403 保持 `logged_in`，只写 `roomAccess='refused'`；只有 Cookie/页面明确要求登录才 `expired`/`login_required`。新增 `markCaptureRefused`、`markCaptureUnconfirmed`、`markCaptureStopped`；重新登录可清除 `expired` |
| `service.mjs` | 新增 `lastCapture`（失败/停止后仍显示准确状态）；`captureSource`；浏览器 403 抛 `TIKTOK_ROOM_REFUSED`（HTTP 403，`errors.tiktokRoomRefused`）；`EXPIRED`/`REFUSED` 登录不再尝试启动；切换通道不显示另一通道的旧失败 |
| `live.js` + 三语 | 五项状态独立；连接行区分「记录中 / 记录但采集失败 / 记录但未确认事件 / 未开始（采集失败）」；登录卡显示「账号仍可能已登录，直播间访问被拒绝」；补 `tiktokCaptureStateIdle`、`tiktokCaptureStateRoomRefused`、`tiktokCaptureStateRoomUnconfirmed` 等键；停止后显示「已停止」 |
| `monitoring/detectors/tiktok.mjs` | `TIKTOK_ROOM_REFUSED` 映射为 `BLOCKED` |

### 0.41.3 自动化测试

新增/更新：

- 真实 `PushFrame`（gzip）→ `decodeFramePayload` → `mapTikTokMessage` → SQLite（`tiktok:<uid>`、原文、`msgId`）。
- 403 + 有真实事件：启动成功、`events_received`、`roomAccess=refused`、登录仍 `logged_in`。
- 403 + 无事件：`TIKTOK_ROOM_REFUSED`、无 recording、`capture.platform_refused`、登录不变。
- 运行中 403：宽限后失败并结束，不显示正常采集；有事件则保持正常。
- 无进入响应/无事件：`room_unconfirmed`，不显示正常采集。
- 登录过期：阻止启动，无 recording。
- 重新登录：`expired` → `logged_in`。
- 浏览器关闭：同一 recording 自动重连到新 tab。
- 通道切换：browser 失败不显示为 signer 状态。
- 停止记录：`captureState=stopped`，不出现原始 i18n 键。
- 三语：新增键齐全；静态扫描所有 `live.source.tiktok*`/`errors.tiktok*` 字面量键。

结果：

| 运行 | 结果 |
| --- | --- |
| 定向 TikTok（unit+integration） | **103 passed / 0 failed / 0 skipped** |
| 全量 `node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"` | **1050 passed / 0 failed / 0 skipped（561,359.30 ms，2026-11-16）** |
| `verify-exe` | **10/10**（Build ID `a463acfad051`，commit `ea950c0`） |
| `verify-tiktok-exe @aljazeeraenglish` | **23/23**：真实 6 chat / 3 可识别观众；自动监听 6 条；SQLite/AI/重启/四平台回归通过 |
| 真实浏览器登录脚本 | **1/9 passed，0 failed，8 BLOCKED**（DSH 作业对象终止 Chromium；`launch_failed`） |

### 0.41.4 免费本地方案调查（仅研究，未接入）

- `talkaboutdesign/tiklive`：MIT，2026-10 新项目（7 stars，活跃）；无登录、无签名服务、本地 Node/Bun；源码使用匿名 `ttwid` + `webcast-ws.tiktok.com` 的 `PushFrame` 协议。
- 只读探针（不属于产品，未写入仓库）在同一台机器、同一网络、无登录条件下，35 秒收到 **82 帧 / 78 个 msg 帧 / 469 条 chat / 19 条 gift / 1 个进入响应**；证明 TikTok 的 webcast 事件通道本身可用，且不要求账号登录。
- 该方案使用 TikTok 非公开 web 协议，不是官方 API，可能受 ToS/平台变更影响；**未接入 LiveMemory**。按 AGENTS §10，改用未公开接口需要开发者明确的产品/合规决策。
- 其他：`wshook-extension`（MIT，浏览器扩展，需安装扩展，不适合 EXE）；`isaackogan/TikTokLive`（AGPL-3.0，Python，通常依赖第三方签名）；`TikTokLiveSharp`（NOASSERTION，C#，41 open issues）。均未采用。
- 现有免费社区签名通道不受影响，仍是 130 秒级轮询，**不得描述为实时**。

### 0.41.5 尚未解决 / BLOCKED

- **真实登录后浏览器中继端到端投递仍 BLOCKED**：DSH 无法启动 Chromium，无法扫码/登录并观察页面自身 WebSocket。必须由开发者在普通 Windows 桌面用新 EXE 验收。
- 无法证明 `@freefirelatino` 的 `room/enter` 403 的具体服务端原因（地区/账号/房间/请求上下文）；只能确认是 TikTok 返回，且不应与登录失效混为一谈。
- 若真实浏览器页面自身 WebSocket 也收不到帧，则浏览器中继在该房间/账号/地区仍不可用；下一步应选择人工验收后再决定是否采用本地 unsigned transport，不得强行宣称已通过。
- 未验证：真实断网、下播长跑、干净 Windows 账户、真实 UAC 双击、真实礼物在登录浏览器中的投递。

### 0.41.6 Git / EXE

| 项目 | 值 |
| --- | --- |
| 分支 | `feature/tiktok` |
| EXE | `D:\LiveMemory\dist\LiveMemory.exe` |
| Build ID | `a463acfad051` |
| source hash | `a463acfad051f8af6914c1c1ef20058dcac6358421595d701614197d19edea82` |
| commit（构建时 HEAD） | `ea950c040e96aa5a81f767918e2314ba6d084580` |
| 大小 / SHA-256 | `97,893,888` bytes / `fecf18ce7cb858770dbffda7d08e3373ecb63a613a1f29c74a8f11e8d5a84b77` |
| builtAt | `2026-11-16T02:05:12.347Z` |
| 资源 / 模块 | 229 files / 53 required modules |
| RT_MANIFEST | **`requireAdministrator`** |

- 代码与测试提交：`ea950c0`（`fix: decode TikTok PushFrame and separate room access from login`）；文档与构建记录为本轮最终 HEAD（见 `git log -1`）。
- **未合并 main、未 Push、未创建 Tag、未发布 Release。**

## 0.40 TIKTOK-M3：浏览器中继「采集尚未配置」修复（2026-11-15）🟡（feature/tiktok，等待人工验收）

范围：只修复真实 Windows 桌面验收发现的问题——TikTok 登录成功、直播间识别成功，
点击「开始记录」却提示「TikTok 采集尚未配置」。同时修复该路径上的登录窗口生命周期、
验证反馈与浏览器中继礼物事件。
**未改数据库 schema（16）、AI 结果 Schema、提示词、其他平台适配器；未新增运行时依赖；
未合并 main、未 Push、未 Tag、未 Release。**

### 0.40.1 根因（代码 + 复现）

- 「TikTok 采集尚未配置。」来源：`src/web/i18n/zh-CN.json` 的
  `errors.tiktokNotConfigured`，由 `TikTokService.#startWithRoom()` 在
  `transport.active` 为空时抛出的 `TikTokError(TIKTOK_ERRORS.NOT_CONFIGURED)` 使用。
- `TikTokService.transport()` 旧代码用 `Boolean(this.browserRelay?.start)` 判断浏览器中继；
  但 `TikTokBrowserRelay` 只有 `createAdapter` / `stop` / `closeBrowser`，**没有 `start`**。
  因此选择 `browser` 后 `browserAvailable=false`、`active=null`，无论登录与 room check 是否成功，
  `connect` 都返回 503 `TIKTOK_NOT_CONFIGURED`。
- 已用真实 `TikTokBrowserRelay` + fake login `logged_in` + fake room check 复现：
  `transport.active=null`，`connect` 得到 `TIKTOK_NOT_CONFIGURED / errors.tiktokNotConfigured / 503`。
  M2 测试中的假 relay 恰好提供 `start()`，掩盖了真实缺陷。
- 次因：`TikTokBrowserAdapter.#handleMessage()` 只接受 `mapped.kind === 'event'`，
  而礼物映射返回 `kind:'gift'`，导致浏览器中继即使连上也会丢弃全部礼物。已修复。

### 0.40.2 修复

| 模块 | 内容 |
| --- | --- |
| `service.mjs` | 中继可用性改查 `createAdapter`；显式 `browser` 不依赖 signer；缺少中继/签名通道分别返回 `TIKTOK_BROWSER_UNAVAILABLE` / `TIKTOK_SIGNER_UNAVAILABLE`；`NOT_CONFIGURED` 只在确实没有任何通道时出现；新增 `browserRelayAvailable`、`profileOwned`、`captureActive`、`revalidationRequired` |
| `service.mjs` | 持久化 `logged_in` 只作提示：profile 存在时允许中继实际尝试；真实 200/事件回写 `logged_in`，真实 403 回写 `refused`；启动/中继失败回写准确原因 |
| `browser-login.mjs` | `cancel/closeBrowser` 保留登录；记录 `loginWindowClosedAt` 与 `revalidationRequired`；采集中关闭登录页只关自己的 tab，不终止专用浏览器；采集中拒绝 `logout`；`verify` 无直播间返回 `needs_room`，不再把登录状态改成 `error`；capture 增加 `reason/eventsReceived/roomEnterStatus/timedOut/uniqueId/liveUrl/checkedAt`；新增 `markCaptureVerified/markCaptureLoginRequired/markCaptureFailed` |
| `browser-relay.mjs` | 浏览器中继礼物按 `groupKey` 合并最终态，10 秒超时冲刷；写入统一 `EventIngest`；`pendingGifts` 暴露在 capture |
| `live.js` + 三语 | 验证结果与失败原因显示在按钮下方；新增五项独立状态（登录/直播间/采集连接/真实事件/开始记录）；关闭窗口与采集中继分别说明；采集中禁用退出登录；连接失败后刷新登录徽标；切换通道/直播间清除旧验证结果 |
| `scripts/verify-tiktok-exe.mjs` | 新增打包 EXE 的 browser 通道识别与切回 signer 两项断言 |

### 0.40.3 自动化测试

- 新增 9 项：真实 relay 可用性、浏览器帧→SQLite（chat/gift/UID/msgId/时间）、连送合并、
  旧登录 + 403、显式 browser 不依赖 signer、无直播间验证、关闭窗口保留登录、
  采集中关闭登录页不终止浏览器、采集中拒绝退出、capture 回写登录。
- 定向 TikTok：**90 passed / 0 failed / 0 skipped**。
- 全量：**1037 passed / 0 failed / 0 skipped（504,497.50 ms，2026-11-15）**。

### 0.40.4 真实 EXE 验收

| 脚本 | 结果 |
| --- | --- |
| `verify-exe` | **10/10** |
| `verify-tiktok-exe` | **23/23** |
| `verify-tiktok-browser-login` | **1/9 passed，0 failed，8 BLOCKED**（DSH 作业对象终止 Chromium） |

`verify-tiktok-exe` 新增并通过：

```text
PASS  the packaged EXE recognizes the selected browser relay as an available transport
      requested browser, browserAvailable true, active browser
PASS  switching back to the signing transport takes effect without a restart
      active signer
```

真实 TikTok：`aljazeeraenglish` / room `7706695538414062349` / 主播稳定 ID
`7074562477175424046`；6 条 chat / 6/6 `tiktok:<user.id>` / 5 个唯一身份 / 6/6 原文；
自动监听 recording + 6 条真实事件；SQLite 6/6 `user_id`、`external_id`、`content`；
重启后 messages 6；AI report 200；TikTok viewers 9；四平台状态均 200。

### 0.40.5 Windows EXE

| 项目 | 值 |
| --- | --- |
| 文件 | `D:\LiveMemory\dist\LiveMemory.exe` |
| Build ID | `e11f4008b9e3` |
| source hash | `e11f4008b9e3c88dc19701d0a3aab986ba4a45af4737fb7279d28e4fff8bd5b7` |
| commit（构建时 HEAD） | `1b9a38bf69ddc56e308a5fab10e2bc931af9a732` |
| 大小 / SHA-256 | `97,867,776` bytes / `8ee91aa8db4e08f77dfdb030dc95d12096341271fbb1efd7fa1981b0ed472d88` |
| builtAt | `2026-11-15T14:33:50.564Z` |
| 资源 / 模块 | 229 files / 53 required modules |
| RT_MANIFEST | **`requireAdministrator`** |

### 0.40.6 边界与未验证

- **真实登录后的浏览器中继投递仍是 BLOCKED**：DSH 沙箱终止 Chromium，
  无法自动验收真实扫码/登录后弹幕/礼物；必须由开发者在普通 Windows 桌面验收。
- 代码级与 SQLite 级已用合成帧覆盖 chat/gift/UID/msgId/时间/去重；不得把它写成真实平台投递通过。
- 免费社区签名通道仍是第三方云服务；匿名约 30 次/小时；本轮未改预算。
- 未验证：真实网络中断、真实下播长跑、干净 Windows 账户、真实 UAC 双击。

### 0.40.7 Git

- 分支：`feature/tiktok`；本轮代码与测试提交：
  **`1b9a38bf69ddc56e308a5fab10e2bc931af9a732`**
  （`fix: start TikTok browser relay capture and report real login state`）。
- 文档与构建记录：本轮最终 HEAD（见 `git log -1`）。
- **未合并 main、未 Push、未创建 Tag、未发布 Release。**

## 0.39 TIKTOK-M2：连接稳定性、浏览器登录与真实 EXE 验收（2026-11-15）🟡（feature/tiktok，等待人工验收）

范围：只修 TikTok 第一阶段真实使用发现的问题，不新增平台。修复免费社区签名通道的频繁重连；补齐浏览器中继的登录生命周期；区分登录状态与真实事件接收；重构三语 UI；用真实 TikTok LIVE 做短测与 30 分钟长测；重建 Windows EXE。
**未改数据库 schema（仍 16）、结果 Schema 1.3.0、提示词 v13.2、默认 10 人/批、Bilibili/YouTube/Twitch/抖音适配器；未新增运行时依赖；未合并 main、未 Push、未 Tag、未 Release。**

### 0.39.1 根因（真实证据）

免费社区签名服务有两套限制：

- 正常响应头可能是 `ratelimit-limit: 1500` / `ratelimit-policy: 1500;w=60`；
- 匿名账号/IP 用尽真实小时上限后，429 响应为：

```text
HTTP 429
ratelimit-limit: 30
ratelimit-policy: 30;w=3600
ratelimit-remaining: 0
ratelimit-reset: 2708
retry-after: 2708
{"code":429,"message":"You have reached the rate limit...","limit_label":"rate_limit_account_hour"}
```

M1 每 15 秒轮询（240 次/小时），约 7.5 分钟用尽 30 次；适配器又把 `Retry-After` 截断为 30 秒，于是整个小时每 30 秒重试一次，UI 长时间停在「重连中/第 N 次重试」。这不是解析故障，也不是下播。

### 0.39.2 修复

| 模块 | 内容 |
| --- | --- |
| `src/platforms/tiktok/rate-budget.mjs`（新） | 进程内共享请求预算（按 IP）；解析 `ratelimit-*`/`Retry-After`；匿名默认 130 秒/请求；完整等待 reset；多房间共享同一预算 |
| `src/platforms/tiktok/signer.mjs` | 匿名 30 次/小时保守节奏；429 全量 Retry-After；400/403/404/429/5xx/200-JSON 分类；可中止请求 |
| `src/platforms/tiktok/adapter.mjs` | 新 `rate_limited` 状态；单飞轮询 + 单一 timer；失效 cursor 重置并重校验房间；房间 ID 变化检测；gap 时间线；`lastEventAt`；确认下播后清理定时器；0 消息批次算成功 |
| `src/platforms/tiktok/browser-launch.mjs`（新） | 专用 profile marker；Chrome→Edge 回退；PowerShell 单实例；复用已有 DevTools 端口；只清理自己 profile 的进程；PID `taskkill` 兜底 |
| `src/platforms/tiktok/browser-login.mjs`（新） | 官方 `tiktok.com/login`；二维码/手机/邮箱由用户在官方页完成；Cookie/页面检测；`idle/opening/waiting/verifying/logged_in/expired/refused/unavailable/error`；单飞行锁；只管理专用 profile |
| `src/platforms/tiktok/browser-relay.mjs` | 页面级 CDP；登录/采集复用同一 profile；停止采集只关自己的 tab；CDP 断开自动重连；无事件时显示「已连接，等待事件」 |
| `src/platforms/tiktok/service.mjs` | 浏览器中继先要求 `logged_in`；`login` 与 `capture` 分开；状态暴露 `capture/rateLimit/login`；登录 API 粘合 |
| `src/server/routes.mjs` | `/api/tiktok/login/status|start|verify|cancel|logout` |
| `src/web/js/pages/live.js` + 三语 | 简化 TikTok 面板；登录卡；采集卡；最近弹幕、重连次数、最近故障、下次重试、免费额度；技术详情折叠 |
| `scripts/verify-tiktok-live-30m.mjs`（新） | 真实 30 分钟长测；独立 SQLite；统计 UID/msgId/Unicode/断线/限流 |
| `scripts/verify-tiktok-browser-login.mjs`（新） | 真实浏览器登录入口验收；沙箱无法启动浏览器时标记 BLOCKED |

### 0.39.3 真实采集（源码 + 真实 TikTok LIVE）

`aljazeeraenglish`（room `7706695538414062349`）：

| 窗口 | 结果 |
| --- | --- |
| 3 分钟短测 | 24 条 chat / 11 位可识别观众 / 24 个不同 msgId / 24/24 稳定 UID / 11 条非 ASCII / 0 重连 / 0 限流 / 2 次请求（130 秒间隔） |
| 30 分钟长测 | **146 条 chat / 49 位可识别观众 / 146 个不同 msgId / 146/146 稳定 UID / 63 条非 ASCII / 0 重连 / 0 限流 / 14 次请求（130 秒间隔）** |

真实 30 分钟 session 的 AI 读取链路：用同一 SQLite 生成分析包，**146 条 message / 146 个 `tiktok:` 身份 / 63 条非 ASCII / 146 个 message_id**；EXE 内 `GET /api/ai/sessions/:id/report` 200、`/api/viewers?platform=tiktok` 200。

### 0.39.4 30 分钟长测

`node scripts/verify-tiktok-live-30m.mjs aljazeeraenglish 30`：

- 状态：全程 `connected`，`states=["connected"]`；`rateLimitedDuringWindow=false`、`reconnectAttempts=0`。
- 结果：30.01 分钟真实窗口；146 条 chat；49 位可识别观众；146 个不同 `external_id`（无重复）；146/146 有 `viewer_uid`、`external_id`、`content`；63 条非 ASCII；14 次共享预算请求；0 次 429。
- 报告：`tests/.tmp/verify-tiktok-live-2026-11-15T12-45-31-471Z/report.json`（临时目录，不提交）。

### 0.39.5 浏览器登录（实现完成，真实浏览器 BLOCKED）

- 官方登录页 `https://www.tiktok.com/login` 同时提供「Use QR code」与「Use phone / email / username」；程序只打开官方页，不生成二维码、不读取密码、不绕过验证码。
- 登录状态与采集状态分开：`logged_in` 不等于收到弹幕；`verify` 返回 `events_received` / `connected_no_events` / `login_required` / `platform_refused`。
- 单窗口：单飞行锁；重复点击只聚焦；关闭窗口后状态可恢复；采集停止只关自己的 tab；只管理 `<data>/browser/tiktok/account` 专用 profile；factory reset 会关闭并删除该专用 profile。
- **BLOCKED**：当前 DSH 沙箱从 Node 启动 Chrome/Edge 后被作业对象终止（`0x80000003`，无 DevTools 端口），无法自动验收真实登录/扫码/登录后弹幕。这不是普通 Windows 桌面 EXE 的结论；必须人工验收。
- `scripts/verify-tiktok-browser-login.mjs` 在当前环境输出 **BLOCKED**，不伪造 PASS。

### 0.39.6 自动化测试

- 新增：`tiktok-rate-budget` 5、`tiktok-reconnect` 6、`tiktok-browser-login` 8；扩充 `tiktok-signer` 5、`tiktok-session` +1、`tiktok-ui` 登录/路由/构建模块、`api-auth` 5 个登录路由 401。
- 全量：**1028 passed / 0 failed / 0 skipped（508,176.15 ms，2026-11-15）**。首跑 1027/1 为 `monitoring-api` 重启瞬间 `checking/waiting` 时序，修正测试等待稳定状态后重跑全绿；未放宽产品断言。
- 真实回归：Bilibili 房间 `6` 15 秒 **4 条 chat / 3 位可识别观众 / 停止 ended**；YouTube `4t4AQ15yj1M` 15 秒 **51 条 chat / 51 个 channel id / 1 条 gift / 停止 ended**；Twitch `kato_junichi0817` EXE **25 条 chat / 25 个 `twitch:<id>` / 停止 ended / 20/20**；抖音 `708764876300` EXE **3 条 chat / 3 个 `douyin:<id>` / 停止 ended / 25/27**（2 项浏览器启动受沙箱限制）。

### 0.39.7 功能完成状态（必须按此口径验收）

| 功能 | 状态 |
| --- | --- |
| 房间识别 / 开播状态 / 主播稳定 ID / 标题 / 累计观看 | **已实现且真实数据验证**（公开接口） |
| 真实聊天原文 | **已实现且真实直播验证**（3 分钟 24 条、30 分钟见 §0.39.4；Unicode/Emoji） |
| 稳定 User ID | **已实现且真实直播验证**（`tiktok:<user.id>`；30 分钟 146/146） |
| msgId 去重 | **已实现且真实直播验证**（146/146 external_id、146 个不同值；0 重复） |
| 免费签名通道稳定性 | **已修复并真实短测/长测**：共享预算 130 秒；不再因 429 高频重试；限流时显示等待恢复 |
| 断线恢复 | **已实现**：自动化覆盖网络/协议/限流/看门狗/同 session/去重；真实网络中断未执行 |
| 浏览器中继登录入口 | **已实现**；真实浏览器启动/扫码/登录后弹幕 **BLOCKED，待人工验收** |
| 浏览器登录状态识别 | **已实现 + 单元/集成测试**；真实 Cookie 正向未验证 |
| 礼物 / 连送 / 订阅 | **已解析 + 自动化测试**；真实礼物事件仍未观测 |
| 自动监听 | **已实现**：EXE 真实创建目标 → check → recording → chat；见 §0.39.8 |
| 多直播间 | **已实现**：两房间独立 session 集成测试；真实并发受 30/h 共享预算限制 |
| AI 分析读取 | **已实现**：EXE `GET /api/ai/sessions/:id/report` 200；未用真实付费 Provider 重跑语义分析 |
| 长期观众画像 | **已实现**：EXE `/api/viewers?platform=tiktok` 200；真实 AI 语义画像未重跑 |

### 0.39.8 Windows EXE（本轮交付物）

| 项目 | 值 |
| --- | --- |
| 文件 | `D:\LiveMemory\dist\LiveMemory.exe` |
| Build ID | `a97447fe6329` |
| source hash | `a97447fe6329f2a2b73651e1990eabaa7d716c5620ae81b3cdebdcafe2d64fe3` |
| commit（构建时 HEAD） | `607e5cd2942d8af104344e6ed9c6259bb41691c3` |
| 大小 / SHA-256 | `97,831,936` bytes / `aca70bd621c096a6ec93c8b5bcf3e61d93fbf0adb683be4f0494aa375519badb` |
| RT_MANIFEST | **`requireAdministrator`** |
| EXE 验证 | `verify-exe` **10/10**；`verify-tiktok-exe` **21/21**；`verify-twitch-exe` **20/20**；`verify-douyin-exe` **25/27 + 1 NOT-OBSERVED（2 项浏览器启动受沙箱限制）** |
| 资源 / 模块 | 229 files / 53 required modules |
| builtAt | `2026-11-15T13:21:51.517Z` |

### 0.39.9 边界与未验证

- **真实礼物/连送/订阅**未观测；只能写“已解析/自动化测试”。
- **浏览器真实登录、扫码、登录后弹幕**：BLOCKED，待普通 Windows 桌面人工验收；不得写成通过。
- **真实网络中断**：未执行；自动化覆盖可恢复错误、退避、同 session、去重。
- **真实“直播中→下播”长跑**：未捕获；两次离线确认有自动化测试。
- **多房间真实并发**：未执行；共享 30/h 预算会显著降低每房间频率。
- **干净 Windows 账户 / 真实 UAC 双击**：未验证。
- 免费签名通道是第三方云服务；匿名约 30 次/小时，实时性约 2 分钟/批；不保证断线期间消息补录。

### 0.39.10 Git

- 分支：`feature/tiktok`；本轮开始前 HEAD：`012c4efa8921f0eb471434201174888fcc6df004`。
- 代码提交：`392f854d8b8c7d8761617a8f4f7ddc187e166a0a`（主体）、`9effcd6c37f39a53f8431d16beabc0e39c500334`（connect 响应 capture state）、`607e5cd2942d8af104344e6ed9c6259bb41691c3`（factory reset 清理专用浏览器 profile）。
- 文档与构建记录提交：本轮最终 HEAD（见 `git log -1`）。
- **未合并 main、未 Push、未创建 Tag、未发布 Release。**

## 0.38 TIKTOK-M1：TikTok LIVE 接入、双传输与 Windows EXE（2026-11-15）🟡（feature/tiktok，等待人工验收）

范围：先把已验收的抖音合并到 `main`，再从最新 `main` 创建 `feature/tiktok`；完成 TikTok LIVE 接入
（房间识别、主播稳定 ID、真实聊天、礼物解析、连送合并、去重、断线重连、自动开播、多房间隔离、SQLite、
AI 读取链路、三语 UI），并构建 Windows EXE 完成真实 TikTok 直播验收。
完整报告：`docs/TIKTOK_FEASIBILITY_2026-11.md`；日志：`log/2026-11-15-tiktok-live.md`。

**未改数据库 schema（仍 16）、结果 Schema 1.3.0、提示词 v13.2、默认 10 人/批、Bilibili/YouTube/Twitch/抖音适配器；
未新增 npm/Python 运行时依赖；未合并 `feature/tiktok` 到 main、未 Push、未 Tag、未 Release。**

### 0.38.1 抖音合并（前置步骤）

- 本地合并提交：**`410bfc3ffacc712b6fd56a9e63f4d5afcca4bcb7`**
  （父 `d5e9a7c5b58bb8127ddf72c46918ce51c557f312` + `e3cf6e758098aa746c202aafdadde335e33f558f`，
  信息 `Merge branch 'feature/douyin' into main`）。
- 合并后工作区干净，`git diff feature/douyin main` 为空；`feature/douyin` 保留。
- 合并后全量：**947 passed / 0 failed / 0 skipped（300,810.97 ms）**。
- 合并后四平台真实回归：
  - Bilibili 房间 6（真实 `7734200`）：3 条 chat / 3 个可识别观众 / 停止 `ended`。
  - YouTube `4t4AQ15yj1M`：55 条 chat / 55 个 channel id / 10 位活跃观众 / `ended`。
  - Twitch `blastpremier`：13 条 chat / 13 个 `twitch:<id>` / `ended`。
  - 抖音 `708764876300`：3 条 chat / 3 个 `douyin:<id>` / `ended`。
- 本机 `.git` 写入需要一次性 full-access；`checkout` 因索引 stat 缓存失败，改用 `commit-tree` +
  `update-ref` + `symbolic-ref` 生成同一合并提交，文件内容完全一致。

### 0.38.2 可行性结论（真实数据）

| 能力 | 结论 |
| --- | --- |
| 房间信息 / 开播状态 / 主播稳定 ID / 标题 / 累计观看 | **完全本地免费**（`api-live/user/room`、`webcast/room/info`，无需登录/签名服务） |
| 礼物目录（名称 + 钻石展示价值） | **完全本地免费**（`webcast/gift/list`，809 个礼物） |
| 官方网页匿名聊天 | **不可用**：`room/enter` 返回 403，聊天面板停在“正在加载”；移动端 UA 也不可用 |
| 未登录直连推送 WebSocket | **被拒**：`Unexpected server response: 200` / `1006`；未签名 `im/fetch` 返回 0 字节 |
| 免费社区签名通道（无 Key、无付费、无需 Business） | **可用**：真实 `WebcastChatMessage` 带 `user.id`、`common.msgId`、Unicode 正文 |
| 礼物 / 连送 / 订阅事件 | 已实现解析与连送合并；**真实事件尚未观测** |
| 浏览器中继（用户登录后） | 已实现（实验性）；匿名 403 已实测；**登录后未验证（无账号）** |

关键限制：免费签名通道对匿名客户端的新连接突发上限为 **5 次/分钟**（`ratelimit-limit: 5; w=60`），
适配器默认 15 秒轮询，并按 `Retry-After` 退避。

### 0.38.3 实现

| 模块 | 内容 |
| --- | --- |
| `src/platforms/tiktok/link.mjs` | `@handle` / 裸 handle / `tiktok.com/@user(/live)`；拒绝视频、短链、搜索、其它站点 |
| `src/platforms/tiktok/protobuf.mjs` | 零依赖 protobuf wire 编解码（varint/长度/嵌套/未知字段；截断明确报错） |
| `src/platforms/tiktok/messages.mjs` | `ProtoMessageFetchResult` 与 `WebcastResponse`；chat/gift/member/like/social/roomseq/control/sub 映射；`tiktok:<user.id>`；msgId 去重；钻石只写 `amount_display` |
| `src/platforms/tiktok/client.mjs` | 公开房间解析 / 房间信息 / 礼物目录（10 分钟缓存）；403/429/网络/协议错误分类 |
| `src/platforms/tiktok/signer.mjs` | 免费社区签名通道（无 Key/无付费；`baseUrl` 可换自建/兼容签名服务；402/403 明确报“需要付费计划”） |
| `src/platforms/tiktok/adapter.mjs` | 15 秒轮询、cursor 续传、10k msgId 去重、连送最终态 + 超时冲刷、1→30 秒退避、90 秒看门狗、两次离线确认、控制消息（ended） |
| `src/platforms/tiktok/browser-relay.mjs` | 实验性 Chrome/Edge 专用资料目录 + CDP + WS 帧解析；匿名 `room/enter 403` → `TIKTOK_LOGIN_REQUIRED` |
| `src/platforms/tiktok/service.mjs` | 传输选择（auto/signer/browser）、能力矩阵、重复房间拒绝、TikTok-only 30 天保留、shutdown |
| `src/monitoring/detectors/tiktok.mjs` | 公开接口开播检测、错误分类、周期键 `tiktok:<handle>:<roomId>` |
| `src/server/{index,routes,settings-store}.mjs` | `/api/tiktok/status|transport|room|connect|disconnect|retention/apply`；`tiktokTransport` 设置 |
| `src/web/js/pages/live.js` + 三语 i18n | TikTok Tab、房间检查、传输选择、自动监听、能力/限制说明、保留按钮；39 个 `tiktok` 键 × 3 + 16 个错误键 |
| `scripts/verify-tiktok-exe.mjs` | 正式 EXE + 真实 TikTok 验收脚本 |
| `scripts/build-windows.mjs` | 10 个 TikTok 必需模块 |

事件映射：`WebcastChatMessage`/`WebcastEmoteChatMessage` → `chat`（`external_id` = `common.msgId`，
`viewer_uid` = `user.id`，昵称仅显示）；`WebcastGiftMessage` 仅在 `repeatEnd=1`（或 10 秒超时冲刷）
写一条 `gift`，`gift_quantity` 为最终连送数，`amount_minor=null`、`currency=null`、`value_kind=unknown`、
`amount_display="<钻石合计> TikTok Diamonds"`，`source_quality=estimated`；`WebcastSubNotifyMessage` → `membership`
（同样无金额）；Member/Like/Social 只计数；`WebcastRoomUserSeqMessage` 只更新当前观众数；`WebcastControlMessage(3)` 只算一次离线观测。

### 0.38.4 真实数据（源码服务器 + 正式 EXE）

源码服务器（`aljazeeraenglish`，room `7706695538414062349`）：

| 检查 | 结果 |
| --- | --- |
| 房间解析 | `roomId=7706695538414062349`、`status=2`、主播「Al Jazeera English」、稳定主播 ID `7074562477175424046`、标题、累计观看 50,817,556 |
| 连接 | 201 / `connected` / `err=none` |
| 真实聊天 | **6 条**；6/6 有 `tiktok:<user.id>`，5 个唯一身份，正文含 CJK/Emoji |
| 样例 | `viewerId=tiktok:7366634237712335877`、`sourceQuality=verified` |
| 停止 | 200 / `ended` |
| 传输 | `signer` |

正式 EXE（`verify-tiktok-exe.mjs`，Build ID `812c0d54f622`）：**20/20**

| 检查 | 结果 |
| --- | --- |
| Manifest | `requireAdministrator`（asInvoker 测试副本运行功能场景） |
| 真实房间 / 连接 / 聊天 | 通过；6 条真实 chat，6/6 `tiktok:<id>`，3 个唯一身份 |
| SQLite | 6 events；user_id 6/6、external_id 6/6、content 6/6 |
| 自动监听 | 目标创建 → check → `recording` → 真实 chat → 停止 → 删除目标 |
| 重启/持久化 | 同 Build ID；session 保留，messages 6 |
| AI 读取 | `GET /api/ai/sessions/:id/report` 200 |
| 长期画像 | `/api/viewers?platform=tiktok` 200，5 位观众 |
| 四平台回归 | Bilibili 200、YouTube 200/web、Twitch 200/anonymous-irc、抖音 200 |

### 0.38.5 自动化测试

- 新增 **56** 项：`tiktok-link` 4、`tiktok-messages` 12、`tiktok-client` 8、`tiktok-signer` 8、
  `tiktok-adapter` 8、`tiktok-ui` 8、`tiktok-session` 3、`tiktok-monitoring` 4；
  `api-auth` 新增 6 个 TikTok 路由的未认证 401 断言。
- 覆盖：URL 解析、protobuf 编解码/截断/未知字段、fetch/WS 两种封装、昵称与稳定 ID、Unicode/Emoji、
  msgId 去重、礼物解析、连送最终态与超时冲刷、无金额不记 0、member/like 不写事件、断线重连、
  两次离线确认、控制消息、自动开播、多房间隔离、SQLite、AI 包、三语 UI 键一致、传输设置、EXE 模块。
- 全量：**1003 passed / 0 failed / 0 skipped（326,436.09 ms，2026-11-15）**；
  `node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`。

### 0.38.6 Windows EXE（本轮交付物）

| 项目 | 值 |
| --- | --- |
| 文件 | `dist/LiveMemory.exe` |
| 完整路径 | `D:\LiveMemory\dist\LiveMemory.exe` |
| 大小 | `97,718,784` bytes（93.2 MB） |
| SHA-256 | `3a3e7c597cdb743a6e512a3c086a0a8c89929de57a458bb50fd93cb0f0fd134b` |
| Build ID | `812c0d54f622` |
| source hash | `812c0d54f622056a6fb2fed468c85960a0742ce47c8bada1a5caae34398557b9` |
| commit（构建时 HEAD） | `3e6e7d8e25b86084def581a2ba8c250b7124db36` |
| builtAt | `2026-11-15T11:21:11.849Z` |
| 资源 | `226` files；50 个必需模块 |
| RT_MANIFEST | **`requireAdministrator`** |
| Node | `v24.21.0` |

EXE 验证：`scripts/verify-tiktok-exe.mjs` **20/20**（真实 TikTok + 自动监听 + 重启 + AI + 四平台状态）；
`scripts/verify-exe.mjs` **10/10**（启动/全新目录/重启/硬杀恢复/端口/单实例/不可写目录/异目录/解压复用/CLI 三语）。

### 0.38.7 功能完成状态（必须按此口径验收）

| 功能 | 状态 |
| --- | --- |
| 房间识别 / 开播状态 / 主播稳定 ID / 标题 / 累计观看 | **已实现且真实数据验证**（公开接口） |
| 观众昵称 | **已实现且真实直播实测通过**（6/6 有昵称） |
| 稳定 User ID | **已实现且真实直播实测通过**（`tiktok:<user.id>`；从未用昵称代替） |
| 实时聊天原文 | **已实现且真实直播实测通过**（Unicode/CJK/Emoji；msgId 去重） |
| 礼物 | **已实现解析 + 自动化测试**；**真实礼物事件未观测**；钻石只作展示价值 |
| 连送礼物 | **已实现最终态合并 + 超时冲刷 + 自动化测试**；真实连送未观测 |
| 自动监听 | **已实现**：EXE 内真实创建目标 → check → recording → 真实 chat → 删除 |
| 断线重连 | **已实现**：自动化覆盖退避/看门狗/同 session；真实断网未验证 |
| 多直播间 | **已实现**：两房间独立 session 的集成测试；真实并发受 5 次/分钟签名限制 |
| AI 分析 | **已实现**：EXE 内 report 200；未用真实付费 Provider 重跑语义分析 |
| 长期观众画像 | **已实现**：EXE 内 `/api/viewers?platform=tiktok` 200；真实 AI 语义画像未重跑 |
| 浏览器中继（登录后） | **实验性/未验证**：匿名 403 已实测；需要账号 |

### 0.38.8 边界与未验证

- **免费社区签名通道是第三方云服务**：无 Key、无付费、不要求 Business 计划；可能限流或改版；
  界面明确说明，可通过 `baseUrl` 指向自建/兼容签名服务。它不绕过验证码或访问控制。
- **真实礼物、连送、订阅事件未观测**；只能写“已解析/自动化测试”。
- **浏览器中继登录后未验证**：没有 TikTok 账号；匿名状态被平台 `room/enter 403` 拒绝。
- **真实断网、真实“直播中→下播”长跑、多房间并发**未验证。
- **真实 Windows UAC 双击**仍需人工确认（自动化只断言 Manifest + 功能副本）。
- 未在另一台干净 Windows 电脑验收；TikTok 30 天原文保留未提供设置项。

### 0.38.9 Git 与等待验收

- 分支：`feature/tiktok`（从 `main` 的 `410bfc3` 创建）。
- 代码与文档提交：**`3e6e7d8e25b86084def581a2ba8c250b7124db36`**
  （`feat: add TikTok LIVE integration`，39 files，+5,713/−29）。
- 正式 EXE 在该提交之后重建：`build-info.commit` = `3e6e7d8`，buildId `812c0d54f622` 不变
  （buildId 只由 `src/` 内容决定）；随后再次运行 `verify-tiktok-exe` **20/20**。
- 构建记录补充提交：本文件所在的后续提交（HEAD）。
- **未合并 main、未 Push、未创建 Tag、未发布 Release、未删除 `feature/douyin` / `feature/tiktok`。**
- **状态：真实 TikTok 聊天/稳定 ID 已在源码服务器与正式 EXE 验证；礼物/连送/登录后浏览器中继按实际限制标注；
  等待开发者人工验收。**

## 0.37 DOUYIN-SINGLE-WINDOW：重复浏览器窗口修复（2026-11-15）🟡（feature/douyin，等待人工验收）

范围：只消除「点击一次扫码登录打开两个独立浏览器窗口」的问题。**未改扫码 URL、官方身份验证、
会话验证、AES-256-GCM 保存、Cookie 备用、礼物采集与三语 UI。未合并 main、未 Push、未 Tag、未 Release。**

### 0.37.1 根因与证据

- **决定性证据（真实 EXE 单次点击日志，16:05:34）**：`directExit=0`、`portFile=false`，紧接着
  `kind:powershell` 启动成功。直接 `child_process.spawn` Chrome 从提权 SEA 进程启动后立即退出、未写
  `DevToolsActivePort`，但可能已开出一个不受 CDP 管理的窗口；PowerShell 回退再开一个 → 两个独立窗口。
  现场 Profile 无 `DevToolsActivePort`/`browser.pid`，Chrome 父进程是已退出的 PowerShell。
- **并发风险**：`start()` 只用 `state && this.running` 防重入，而 `this.running` 在 CDP 握手后赋值；
  `opening` 期间并发 `start()` 会重复启动。真实复现 `Promise.all([start(), start()])`。
- **孤儿/复用缺口**：直接 spawn 未写 PID，失败/取消时可能无法 taskkill；下次无法复用专用窗口。
- **排除**：干净 Profile 的 `--new-window`/URL/仅 new-window 都是 1 窗口；同一 Profile 连续启动仍各 1 窗口；
  未同时启动 Chrome/Edge；未复现 Profile 恢复旧窗口。真实 Chrome 154 + `Browser.getWindowForTarget` 计数。

### 0.37.2 修复

| 位置 | 修复 |
| --- | --- |
| `browser-login.mjs#launchBrowser` | **Windows 只走一次 PowerShell `Start-Process`**；不再先直接 spawn 再回退 |
| `browser-login.mjs` | 启动前按专用 Profile 命令行清理孤儿 Chrome（只匹配 LiveMemory Profile，绝不动日常浏览器） |
| `browser-login.mjs#start` | 同步 `startPromise` 锁；初始化期间第二次点击返回当前状态并 `Page.bringToFront`，不新建 |
| `browser-login.mjs` | 启动后立即记录 `browser.pid`；`#findExistingBrowser()` 复用同 Profile 专用窗口（同 port/PID） |
| `browser-login.mjs#closeBrowser` | 串行化关闭；PID 缺失/仍存活时再按 Profile 清理；清理 `DevToolsActivePort`/`browser.pid` |
| `buildBrowserArgs` | 移除 `--new-window`（官方 URL 本身 1 个窗口），降低 handoff 多开风险 |
| `live.js` | `douyinBrowserStarting` 防止重复请求；活动窗口按钮保持禁用 |
| 日志 | 只记录 event/浏览器/PID/target ID；不含 Cookie/sessionid/token |

### 0.37.3 真实 Chrome 窗口计数（非模拟）

`node scripts/verify-douyin-browser-login.mjs`（Chrome 154，专用测试 Profile，不扫码）：

| 检查 | 结果 |
| --- | --- |
| 单次点击 | 1 target / 1 window |
| 打开时再次点击 | 0 次新 launch、1 窗口、focus +1 |
| 快速双击（并发 start） | 1 次 launch、1 target / 1 window |
| 第二个 LiveMemory 侧流程 | `kind=reuse`、同 port、1 窗口 |
| 取消/清理 | 窗口关闭、Profile 可删除 |
| **合计** | **12/12** |

### 0.37.4 测试与 EXE

- 新增 3 项浏览器测试：并发 start 只 1 次 launch、活动窗口只 focus、取消后重新 start 1 次。
- 全量：**947 passed / 0 failed / 0 skipped（292,737 ms，2026-11-15）**。
- `verify-exe`：**10/10**。
- `verify-douyin-exe`：**25/27**；2 项仍是 EXE 内浏览器启动被 DSH 作业对象阻止
  （Chrome 子进程 `0x80000003`、PowerShell 无端口），与本轮修复无关。

| 项目 | 值 |
| --- | --- |
| 文件 | `dist/LiveMemory.exe` |
| 完整路径 | `D:\LiveMemory\dist\LiveMemory.exe` |
| 大小 | `97,591,296` bytes |
| SHA-256 | `c3b1fa8b95603826ebcd98e0ecf8fa92fcccdcc9626e0483ddb06b04f67b6315` |
| Build ID | `d37c8f262dc4` |
| source hash | `d37c8f262dc4ed6dd9d678c50ca051f811ac0bfecc2ba1a5add440c267253f36` |
| commit | `75c574c0ec1824603559de88b37669466abd33ff` |
| builtAt | `2026-11-15T09:45:00.851Z` |
| RT_MANIFEST | `requireAdministrator` |

**EXE 内窗口数量无法在 DSH 沙箱自动验证**：EXE 子进程中的 Chrome 被作业对象终止。真实窗口计数来自同一模块 +
真实 Chrome；必须由开发者在普通 Windows 桌面双击 EXE 人工验收。**真实手机扫码仍需人工复验。**

## 0.36 DOUYIN-LOGIN-FIX：浏览器扫码登录、Cookie 验证与礼物分级（2026-11-15）🟡（feature/douyin，等待人工验收）

范围：只修复抖音 M2/M3 验收发现的登录问题。**未合并 main、未 Push、未 Tag、未 Release。**
完整调查：`docs/DOUYIN_LOGIN_RESEARCH.md`；平台细节：`docs/PLATFORM_INTEGRATIONS.md` §3B；
验收报告：`docs/ACCEPTANCE_DOUYIN_M2M3_FIX.md`；日志：`log/2026-11-15-douyin-login-qr.md`。

### 0.36.1 结论：浏览器扫码可行，纯 HTTP 扫码不可行

- 旧实现直接请求 `sso.douyin.com/get_qrcode` → HTTP 200 `text/html` 设备指纹挑战页；
  `www.douyin.com/passport/web/get_qrcode` → `error_code 4031`「安全风险，已阻止此次访问」。
  这是平台拒绝非浏览器客户端，不是「抖音禁止扫码」；LiveMemory 不伪造指纹/`a_bogus`/challenge。
- 改用**本机 Chrome/Edge + 专用资料目录 + 官方登录页 + CDP**：官方页自身成功调用 `get_qrcode`
  （`error_code=0`、二维码 PNG base64、`is_frontier=true`、约 60 秒有效），应用内显示同一二维码。
- 真实手机扫码**未执行**（无账号）；不得写成成功或失败。二维码捕获/取消/目录清理用真实 Chrome 验证 **8/8**。

### 0.36.2 实现

| 模块 | 内容 |
| --- | --- |
| `src/platforms/douyin/browser-login.mjs` | 查找 Chrome/Edge；专用 profile（`.livememory-owned`）；CDP 连接；捕获官方 `get_qrcode`；等待 `sessionid`；页面内 profile 校验；取消/关闭/清理；不用 headless/no-sandbox/stealth |
| `src/platforms/douyin/login.mjs` | Cookie 诊断（格式/不完整/过期）、平台有效性复查（`/aweme/v1/web/user/profile/self/`）、已验证/未验证/失效/无效、退出 |
| `src/platforms/douyin/cookie-store.mjs` | 加密保存 `verified/verifiedAt/reason`；状态永不返回 Cookie |
| `src/platforms/douyin/service.mjs` | 浏览器登录生命周期；扫码/会话/连接/礼物四级状态；退出清理 |
| `src/server/{index,routes}.mjs` | `/api/douyin/login/browser/start|status|cancel`；保留 `check|cookie|logout`；关闭时关闭浏览器 |
| `src/web/js/pages/live.js` + 三语 i18n | 登录状态胶囊；扫码登录/取消/验证/删除；完整 12 步 Cookie 教程；四级礼物验证 |
| `scripts/verify-douyin-browser-login.mjs` | 真实浏览器二维码捕获验证（不扫码） |

### 0.36.3 登录状态与安全

- 状态：`anonymous` / `saved_unverified` / `logged_in` / `expired` / `invalid`；
  「浏览器登录完成」与「会话验证通过」分开，验证不确定时保存为 `saved_unverified`。
- Cookie 仅 AES-256-GCM 保存在本机 `secrets/`；不进入日志、错误、备份、HTTP 响应、Git。
- 「删除 Cookie / 退出登录」清除加密存储并尝试删除专用浏览器资料目录（锁定则返回 `locked`）。
- 验证码/`is_frontier` 身份验证由用户在官方浏览器页面完成，程序不绕过。

### 0.36.4 Cookie 帮助

- 中文/日文/英文各 12 步：Chrome/Edge → `https://live.douyin.com/` → 登录 → F12 → Network → F5 →
  选 `live.douyin.com` 请求 → Headers → Request Headers → Cookie → 复制值 → 粘贴 → 保存并验证。
- 含 Firefox 差异、找不到 Cookie 的排查、AES-256-GCM 本地保护说明；错误直接显示在输入区下方。

### 0.36.5 自动化测试

- 新增/更新：浏览器登录 10 项、登录/Cookie 14 项、服务集成 3 项、礼物阶梯 1 项、UI/三语帮助断言更新；
  API 认证新增 6 个抖音登录路由的未认证 401 断言。
- 全量：**944 passed / 0 failed / 0 skipped（298,824 ms，2026-11-15 最终复跑）**；
  `node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`。
- `tests/integration/api-auth.test.mjs` 单独复跑 **14/14**。

### 0.36.6 Windows EXE

| 项目 | 值 |
| --- | --- |
| 文件 | `dist/LiveMemory.exe` |
| 完整路径 | `D:\LiveMemory\dist\LiveMemory.exe` |
| 大小 | `97,584,640` bytes（93.1 MB） |
| SHA-256 | `48cc12274c6c4e0b3d5e7a10e1c6766db8fb8f49f74c8a8f8ad7e2ae025aa699` |
| Build ID | `a0bc7f9136df` |
| source hash | `a0bc7f9136df8aebf9ddeb16f64bd334780a1a55487f3ed4cba824b16467c362` |
| commit | `6f7f0d65fd95838e489a0021180ea66e87dfd26e` |
| builtAt | `2026-11-15T05:59:01.388Z` |
| 资源 | `215` files；40 个必需模块 |
| RT_MANIFEST | **`requireAdministrator`** |

EXE 验证：

| 脚本 | 结果 |
| --- | --- |
| `scripts/verify-douyin-browser-login.mjs`（真实 Chrome，未扫码） | **8/8** |
| `scripts/verify-douyin-exe.mjs`（真实匿名抖音 + 登录状态/Cookie/教程/退出 + 重启/AI） | **25/27**；2 项浏览器启动在 DSH 沙箱内被作业对象阻止（Chrome 直接子进程 `0x80000003`，PowerShell 回退无端口），其余通过 |
| `scripts/verify-exe.mjs` | **10/10** |
| `scripts/verify-twitch-exe.mjs`（真实 Twitch 回归） | **20/20** |
| Bilibili / YouTube / Twitch 状态 | 均 200（在上述 EXE 脚本中） |

**EXE 浏览器启动未在沙箱内通过**：同一 `DouyinBrowserLogin` 在普通 Node 顶层进程中用真实 Chrome 捕获二维码 8/8，
但 EXE 子进程中的 Chrome 被 DSH 作业对象终止；这不是普通 Windows 用户环境的结论，必须人工验收。
**未执行真实手机扫码**。

### 0.36.7 明确未验证

- 真实手机扫码成功、扫码成功率（未扫码，不能给出比率）。
- 真实 Cookie 正向验证（需要账号）。
- 登录后的礼物推送、真实礼物/连送/付费留言（本轮匿名 0 条，标为未观测）。
- 干净 Windows 电脑、无 Chrome/Edge 环境、非管理员账户、真实 UAC 点击。


## 0.35 DOUYIN-M2M3：抖音接入、登录与礼物解析（2026-11-15）🟡（feature/douyin，等待人工验收）

范围：在 `feature/douyin`（从已合并 Twitch 的 `main` 创建）实现抖音公开直播间接入：URL/房间号解析、
公开页直播状态、昵称与稳定 UID、弹幕原文、Unicode/Emoji、消息 ID、事件去重、断线重连、多直播间隔离、
自动开播监听、SQLite、AI 读取链路与长期观众画像；另实现登录框架与礼物解析（含连送合并）。
**本轮未修改数据库 schema（仍 16）、结果 Schema 1.3.0、提示词 v13.2、Bilibili/YouTube 适配器；
未新增 npm 运行时依赖；未合并抖音分支到 main；未 Push、未创建 Tag、未发布 Release。**

### 0.35.1 Twitch 合并（前置步骤）

- 已按开发者授权把 `feature/twitch` 合并到 `main`：本地合并提交 **`d5e9a7c5b58bb8127ddf72c46918ce51c557f312`**
  （`Merge branch 'feature/twitch' into main`，父提交 `21a5bf5` + `5bb0ad0`），未 Push/Tag/Release。
- 合并后全量测试 **875 passed / 0 failed / 0 skipped（215,586.9 ms）**；工作区干净，无冲突。
- `feature/twitch` 分支保留；`main` 内容与 `feature/twitch` 一致（`git diff` 为空）。

### 0.35.2 实现内容

| 模块 | 内容 |
| --- | --- |
| `src/platforms/douyin/link.mjs` | `live.douyin.com/<rid>`、裸房间号、`www.douyin.com/root/live/<rid>`；拒绝用户页/视频/搜索/短链 |
| `src/platforms/douyin/client.mjs` | 公开页解析（`web_rid`、内部 `room_id`、`status` 2/4、标题、主播 id/secUid/昵称、在线数）；匿名 cookie；签名 WSS URL |
| `src/platforms/douyin/protobuf.mjs` | 自研 protobuf wire 编解码（varint/length/fixed、嵌套、未知字段跳过、BigInt 保精度），零依赖 |
| `src/platforms/douyin/messages.mjs` | PushFrame/Response/Message 解码；gzip；Chat/Gift/Member/Like/Social/RoomUserSeq；连送合并；canonical 映射 |
| `src/platforms/douyin/sign.mjs` | `node:vm` 沙箱加载 vendored 签名脚本，计算 WSS `signature`；失败明确报错，不伪造/不降级为未签名 |
| `src/platforms/douyin/adapter.mjs` | WSS、5 秒心跳、ack、90 秒看门狗、1→30 秒退避、15 次后 5 分钟低速重连、连接内 10,000 消息 ID 去重、两次离线确认下播 |
| `src/platforms/douyin/login.mjs` | 受控扫码登录流程（`get_qrcode` → `check_qrconnect` → 重定向换 cookie）、状态检查、过期提示、退出登录、显式本地 Cookie 备用入口 |
| `src/platforms/douyin/cookie-store.mjs` | AES-256-GCM 加密的本地 Cookie（白名单字段、备份排除、日志脱敏） |
| `src/platforms/douyin/service.mjs` | HTTP/监控/SessionManager 粘合；重复房间拒绝；Douyin-only 30 天保留 |
| `src/monitoring/detectors/douyin.mjs` | 自动开播检测（公开页 `status`）；错误分类；目标状态机 |
| `src/server/{index,routes}.mjs` | `/api/douyin/status|room|connect|disconnect|retention/apply|login/*` |
| `src/web/js/pages/live.js` + 三语 i18n | 抖音来源 Tab、房间检查/开播判断/自动监听/登录/保留；64 个 `douyin` 键 × 三语 |
| `src/platforms/douyin/vendor/` | AGPL-3.0 签名组件（独立目录、完整许可证、来源与哈希）+ 主项目 MIT 未改 |

事件映射：`WebcastChatMessage`/`WebcastEmojiChatMessage` → `chat`（`external_id` = 消息 id，
`viewer_uid` = `user.id`，昵称仅显示）；`WebcastGiftMessage` → **仅在 `repeatEnd=1` 时写一条 `gift`**，
数量为连送最大值，`amount_minor=null`、`currency=null`、`value_kind=unknown`，
`amount_display="<钻石合计> 抖音币"`（展示价值，不是收入）；Member/Like/Social/RoomUserSeq 只计数，
绝不写礼物或付费事件。

### 0.35.3 真实抖音只读验证（匿名、未登录、未付费）

| 验证 | 结果 |
| --- | --- |
| 公开页解析（`708764876300`） | `room_id=7708163643157859082`、`status=2`、主播「东方甄选官方旗舰店」、稳定主播 id、secUid、在线 `500+` |
| 签名 WSS 直连 20 秒（源码路径） | **7 条 chat**；7/7 有 `user.id`、昵称、消息 id、CJK；7 个唯一身份；0 重复；同一窗口 144 member / 4 like / 2 follow / 3 room stats |
| 正式 EXE（asInvoker 测试副本，真实房间） | 连接成功；2 条真实 chat 入库；2/2 有 `douyin:<id>`、昵称、消息 ID、原文；停止后 `ended` |
| 正式 EXE 自动监听 | 创建目标 → check → `recording` + 正常 session；真实 chat 入库；停止后删除目标 |
| 礼物 | **匿名 0 条**；与「2026 年起礼物只推给登录会话」一致，未观测到真实礼物 |
| 登录 | `sso.douyin.com/get_qrcode` 返回风控 HTML；`www.douyin.com/passport/web/get_qrcode` 返回 `error_code 4031`（访问被阻止）。**未完成真实扫码登录**，未绕过验证码/风控 |

### 0.35.4 自动化测试

- 新增 **48** 项：`douyin-link` 4、`douyin-messages` 10、`douyin-client` 7、`douyin-adapter` 5、
  `douyin-login` 9、`douyin-ui` 6、`douyin-session` 3、`douyin-monitoring` 4。
- 覆盖：URL 解析、房间 ID/状态、protobuf 编解码/截断/未知字段、gzip、昵称、稳定 UID、弹幕原文、
  Unicode/Emoji、消息 ID、礼物解析、连送合并与去重、无金额礼物不记 0 元、登录成功/过期/风控、
  Cookie 白名单、断线重连、两次离线确认、自动开播、多直播间隔离、SQLite、AI 包、长期画像、三语 UI、
  Windows 构建必需模块。
- 全量：**923 passed / 0 failed / 0 skipped（283,515.6 ms，2026-11-15）**；
  `node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`。

### 0.35.5 Windows EXE（本轮交付物）

| 项目 | 值 |
| --- | --- |
| 文件名 | `LiveMemory.exe` |
| 完整路径 | `D:\LiveMemory\dist\LiveMemory.exe` |
| Build ID | `0f848c77c2d6` |
| source hash | `0f848c77c2d6cff5882856f27af375060fdcc9811b99529480119c87d5c11fee` |
| commit（构建时 HEAD） | `1f73bed49c35e386ada1e5ca67768bc2e9f916d3`（包含抖音代码提交 `c08cf6c3115b750c0108b54b9d0a19b6bdbae3ce`） |
| builtAt | `2026-11-15T04:33:52.697Z` |
| 资源 | `214` files；39 个必需模块 |
| RT_MANIFEST | **`requireAdministrator`** |
| Node | `v24.21.0` |

EXE 验证（正式二进制断言 Manifest；功能场景使用同一二进制的 asInvoker 测试副本）：

| 脚本 | 结果 |
| --- | --- |
| `scripts/verify-douyin-exe.mjs`（真实抖音 + 自动监听 + 重启 + AI 读取 + 三平台状态 + 登录状态） | **17/17**，1 条礼物 NOT-OBSERVED（与矩阵并行时曾启动超时一次，单独重跑通过） |
| `scripts/verify-exe.mjs` | **10/10** |
| `scripts/verify-p0-5-exe.mjs` | **12/12** |
| `scripts/verify-p0-2-exe.mjs` | **13/13** |
| `scripts/verify-help-exe.mjs` | **14/14** |
| `scripts/verify-ai-token-exe.mjs` | **16/16** |
| `scripts/verify-twitch-exe.mjs`（真实 Twitch 回归） | **20/20** |

### 0.35.6 功能完成状态（必须按此口径验收）

| 功能 | 状态 |
| --- | --- |
| 观众昵称 | **已实现且真实直播实测通过**（7/7 与 2/2 均有昵称） |
| 稳定 UID | **已实现且真实直播实测通过**（`user.id` → `douyin:<id>`；从未用昵称代替） |
| 实时弹幕原文 | **已实现且真实直播实测通过**（Unicode/CJK；消息 id 去重） |
| 礼物 | **已实现解析 + 自动化测试**；**真实礼物未观测到**（匿名连接平台不推送） |
| 连送礼物 | **已实现最终态合并 + 自动化测试**；真实连送未观测到 |
| 礼物展示价值 | **已实现**：钻石合计写入 `amount_display`，`amount_minor=null`、`value_kind=unknown`；不冒充收入 |
| 登录 | **部分实现**：受控扫码流程 + 本地加密 Cookie + 状态/过期/退出；**真实扫码被风控阻止，未验证成功登录** |
| 自动监听 | **已实现**：集成测试 + 正式 EXE 真实创建目标/开播 check/删除 |
| 断线重连 | **已实现**：自动化覆盖 close/退避/看门狗/同 session；真实拔网未验证 |
| 多直播间 | **已实现**：集成测试两房间独立 session/身份；正式 EXE 单房间实测 |
| AI 分析 | **已实现**：正式 EXE `GET /api/ai/sessions/:id/report` 返回 200；未用真实付费 Provider 重跑语义分析 |
| 长期观众画像 | **已实现**：正式 EXE 观众读取 200，`douyin:<id>` 进入现有画像；真实 AI 语义画像未重跑 |

### 0.35.7 边界与未验证

- **真实平台回归**：Bilibili 房间 `6`（真实 `7734200`）20 秒 6 条消息 / 6 个可识别观众 / 停止 `ended`；
  YouTube `4t4AQ15yj1M` 12 秒 75 条消息 / 12 位活跃观众 / 停止 `ended`；Twitch 正式 EXE `verify-twitch-exe` 20/20。
  首次 Bilibili 房间 `5050` 单次 `BILIBILI_NETWORK` 502 为瞬时网络失败，换房间后成功，代码未变。

- **真实礼物、真实连送、真实付费留言未观测到**；不能写“礼物已完整支持”，只能写“已解析/自动化测试”。
- **真实扫码登录未成功**：平台风控返回 HTML/4031；未绕过验证码、风控或访问控制。登录后的礼物推送因此未验证。
- **真实断网、真实“直播中→下播”长跑未捕获**；自动化覆盖状态机，但不能替代真实网络演练。
- **签名组件为 AGPL-3.0**：EXE 分发必须履行 AGPL 源码义务；主项目 MIT 未改。详见 `docs/LICENSE_AGPL_DOUYIN.md`。
- 签名脚本可能随平台更新失效；失效时明确报 `DOUYIN_SIGNATURE_FAILED`，不伪造签名。
- 未在另一台干净 Windows 电脑验收；未做 10+ 房间/千条每秒压力测试。
- 抖音保留窗口在 M2/M3 固定 30 天，暂未提供设置项。

### 0.35.8 Git 与等待验收

- 分支：`feature/douyin`（从 `main` 的 `d5e9a7c` 创建）。
- 抖音代码与文档提交：**`c08cf6c3115b750c0108b54b9d0a19b6bdbae3ce`**
  （`feat: add Douyin live integration`，48 files，+13,646/−37）。
- **未合并 main、未 Push、未创建 Tag、未发布 Release、未删除 `feature/twitch` / `feature/douyin`。**
- **状态：EXE 已生成并完成真实抖音匿名采集/自动监听/重启验证；礼物与登录按实际限制标注；等待开发者人工验收。**

## 0.34 TWITCH-M1：Twitch 正式接入、测试与 Windows EXE（2026-11-15）🟡（等待人工验收）

范围：在独立分支 `feature/twitch` 完成 Twitch 匿名 IRC 公开聊天 + 只读公开频道元数据接入，接入统一
`EventIngest`、`SessionManager`、`MonitoringManager`、数据库、读模型与 AI 读取链路；构建 Windows EXE
并用真实公开频道运行验证。完整验收报告：`docs/ACCEPTANCE_TWITCH_M1.md`。
**未改数据库 schema（仍 16）、结果 Schema 1.3.0、提示词 v13.2、默认 10 人/批、
Bilibili 适配器、YouTube 适配器、AI Provider/调度/提示词规则；未新增运行时依赖；未合并 main、未 Push、
未创建 Tag、未发布 Release。**

### 0.34.1 实现内容

| 模块 | 内容 |
| --- | --- |
| `src/platforms/twitch/link.mjs` | `twitch.tv/<login>`、m/player/popout、裸账号解析；拒绝视频/剪辑/目录/搜索 |
| `src/platforms/twitch/irc.mjs` | IRCv3 标签与转义、多行帧、`emotes` 范围、`badges`、`/me` ACTION |
| `src/platforms/twitch/mapper.mjs` | PRIVMSG/Cheer/USERNOTICE → canonical event；明确的证据等级与忽略列表 |
| `src/platforms/twitch/client.mjs` | 公开 GQL 只读元数据：channel id、昵称、标题、直播状态、观看数、开播时间、stream id |
| `src/platforms/twitch/adapter.mjs` | IRC WebSocket、PING/PONG、90s 看门狗、1→30s 退避、15 次后 5 分钟低速探测、连接内 10,000 消息 ID 去重、两次离线确认下播、stream id 变化结束旧场 |
| `src/platforms/twitch/service.mjs` | HTTP/监控与 `SessionManager` 粘合、重复房间、Twitch-only 30 天保留 |
| `src/monitoring/detectors/twitch.mjs` | 自动开播检测、`stream.id` 周期键、错误分类 |
| `src/server/{index,routes}.mjs` | `/api/twitch/status|channel|connect|disconnect|retention/apply`；启动时 Twitch 保留清理 |
| `src/web/js/pages/live.js` + 三语 i18n | Twitch 来源 Tab、频道检查/开播判断/自动监听/错误提示/保留按钮；Bits 未知金额显示 `amount_display`，不再显示 0.00 |
| `src/storage/retention.mjs` | 平台化昵称清理；Twitch 使用独立审计键 `retention.lastRun.twitch`，不覆盖 YouTube |

事件映射：聊天 `PRIVMSG` → `chat`；Bits/Cheer → `super_chat`（`gift_name=Bits`、`gift_quantity=bits`、
`amount_display="N Bits"`、`amount_minor=null`、`value_kind=unknown`）；`sub`/`resub` → `membership`；
`subgift` → `gift`（赠送者为付款者，接收者只写入展示字段）；`submysterygift` 跳过以避免与每个 `subgift`
重复计数；`viewermilestone`/`bitsbadgetier`/`announcement`/`raid` 等不写入普通聊天。

### 0.34.2 真实 Twitch 只读验证（未登录、未付费、未保存/展示正文）

| 验证 | 结果 |
| --- | --- |
| 单频道 `xqc` 45 秒 | **138 条事件**；138/138 有稳定 `user-id` + 消息 `id`；108 个唯一身份；7 条带 `emotes`；7 条含非 ASCII |
| 6 频道并发 60 秒（`xqc`、`shroud`、`sodapoppin`、`moonmoon`、`ludwig`、`summit1g`） | **418 条事件**；418/418 有稳定 User ID + 消息 ID；304 个唯一身份；40 条带 `emotes`；10 条含非 ASCII；**1 条真实 resub（Prime）**；0 Bits、0 赠订 |
| 正式 EXE + `xqc` | 连接成功；4 条聊天入库，4/4 有 `twitch:<id>` 与消息 ID；停止后数据库保留；重启后仍在 |
| 正式 EXE + Twitch 自动监听 | 添加目标 → `check` 创建正常 session（`state=recording`）→ 3 条真实聊天入库 → 停止 → 删除目标 |

### 0.34.3 自动化测试

- 新增 **47** 项：`twitch-link` 5、`twitch-irc` 8、`twitch-mapper` 10、`twitch-adapter` 6、
  `twitch-service` 6、`monitoring-twitch-detector` 4、`twitch-session` 2、`twitch-monitoring` 1、
  `twitch-ui` 5。
- 全量：**875 passed / 0 failed / 0 skipped（253,002 ms，2026-11-15）**；
  `node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`。
- 覆盖：URL 解析、IRC 标签/转义/多行帧、Unicode、稳定 User ID、消息 ID、昵称、订阅/续订/赠订解析、
  Bits 解析、消息去重、断线重连、两次离线确认、多频道隔离、数据库写入、AI 分析包读取、自动开播、
  Twitch-only 保留、三语 UI 键一致、Windows 构建必需模块。
- Bilibili/YouTube 回归：全量既有测试通过；真实 Bilibili 房间 `6`（真实 `7734200`）20 秒
  **7 条聊天 / 7 个可识别观众 / 0 付费**，停止后 `ended`；正式 EXE 的 YouTube 生命周期回放通过。

### 0.34.4 Windows EXE（本轮交付物）

| 项目 | 值 |
| --- | --- |
| 文件名 | `LiveMemory.exe`（另保留 `LiveMemory-twitch-a4bf602de264.exe` 同哈希副本） |
| 完整路径 | `D:\LiveMemory\dist\LiveMemory.exe` |
| 大小 | `96,828,416` bytes（92.3 MB） |
| SHA-256 | `6a90f564b0fd31adabd67b68a764bfe1800d402fd35fcabe3b601ec9d15e6d2d` |
| Build ID | `a4bf602de264` |
| source hash | `a4bf602de264d4b57203cbfc4b83319c701f1884101901a0bbbef11aae53ed12` |
| commit | `7da0e0d1905a4f16d1a844f98102fb04c211a7d2` |
| builtAt | `2026-11-15T03:27:03.011Z` |
| 资源 | `200` files；28 个必需模块 |
| RT_MANIFEST | **`requireAdministrator`** |
| Node | `v24.21.0` |

EXE 验证矩阵（全部针对该二进制；功能场景使用 `tests/.tmp/` 的 asInvoker 测试副本，正式 EXE 的 Manifest
单独断言；自动化无法点击真实 UAC）：

| 脚本 | 结果 |
| --- | --- |
| `scripts/verify-twitch-exe.mjs`（真实 Twitch + 自动监听 + 重启 + AI 读取 + Bilibili/YouTube 状态） | **20/20** |
| `scripts/verify-exe.mjs`（启动/重启/硬杀恢复/端口/单实例/不可写目录/CLI） | **10/10** |
| `scripts/verify-p0-5-exe.mjs`（认证/Origin/Host/SSE/重启） | **12/12** |
| `scripts/verify-p0-2-exe.mjs`（备份 → 全新目录恢复 → 重启 → 再备份） | **13/13** |
| `scripts/verify-help-exe.mjs`（三语说明页） | **14/14** |
| `scripts/verify-ai-token-exe.mjs`（Mock Provider、Token/Resume/备份） | **16/16** |
| `scripts/verify-youtube-lifecycle-exe.mjs`（180s 断网 → 同 session 恢复 → 去重 → ended） | **PASS** |

### 0.34.5 功能完成状态（必须按此口径验收）

| 功能 | 状态 |
| --- | --- |
| 观众昵称 | **已实现且真实直播实测通过**（418/418 有 `display-name`） |
| 稳定 User ID | **已实现且真实直播实测通过**（418/418 有 `user-id` → `twitch:<id>`） |
| 实时弹幕/聊天原文 | **已实现且真实直播实测通过**（含 Unicode；消息 `id` 去重） |
| 订阅 / 续订 | **已实现且真实直播实测通过**（真实 resub/Prime；内容与 Tier/月数） |
| Bits / Cheer | **已实现，仅模拟/解析测试**；真实事件尚未观测到，不宣称完整支持 |
| 赠送订阅 | **已实现，仅模拟/解析测试**；真实事件尚未观测到；`subgift` 为赠订事件，`submysterygift` 跳过避免重复计数 |
| 付费附带留言 | **部分实现**：resub/订阅留言已支持；Bits Cheer 留言已解析但真实事件未观测；赠订通常无留言 |
| 自动开播监听 | **已实现**：集成测试 + 正式 EXE 真实 `check` 创建 session 并入库；真实“等待开播→开播→下播”长跑未捕获 |
| 断线重连 | **已实现**：自动化覆盖 close/RECONNECT/看门狗/退避/同 session；真实拔网未验证 |
| 多直播间 | **已实现且真实 6 频道并发实测通过**；正式 EXE 自动监听独立 session |
| AI 分析读取 | **已实现**：正式 EXE 的 `GET /api/ai/sessions/:id/report` 返回 200；未用真实付费 Provider 重跑语义分析 |
| 长期观众画像 | **已实现**：稳定 `twitch:<user-id>` 进入现有画像/观众读模型；正式 EXE 观众读取 200；真实 AI 语义画像未重跑 |
| 官方 EventSub 增强 | **未配置**：需要 OAuth User Token、应用 Client ID 与 scope；本轮不要求普通主播注册开发者应用 |

### 0.34.6 边界与未验证

- **Bits、赠订真实事件未观测到**；只能写“已解析/仅模拟测试”，不得写“完整支持”。
- **真实断网、真实“直播中→下播”样本未捕获**；自动化覆盖了协议与状态机，但不能替代真实网络演练。
- **EventSub OAuth 未实现**；匿名 IRC 与公开 GQL 都不是官方承诺的稳定 API，未来可能失效。
- **真实 UAC 双击/点击未自动化验收**；本轮只断言正式 Manifest 与同一二进制功能副本。
- **未在另一台干净 Windows 电脑验收**；未验证长时间 10+ 频道、千条/秒、平台限流叠加。
- Twitch 保留窗口在 M1 固定 30 天，暂未提供设置项。

### 0.34.7 Git 与等待验收

- 分支：`feature/twitch`；代码提交：`7da0e0d1905a4f16d1a844f98102fb04c211a7d2`
  （`feat: add Twitch live integration`，34 files，+4,411/−69）。
- 本文件的构建/验收记录为后续文档提交；EXE 的 `build-info.commit` 仍是 `7da0e0d`。
- **未合并 main、未 Push、未创建 Tag、未发布 Release、未删除分支。**
- **状态：EXE 已生成并完成真实 Twitch/自动监听/重启验证；等待开发者人工验收。**

## 0.33 PLATFORM-RESEARCH：TikTok / Twitch / 抖音接入调查与可行性验证（2026-11-15）🟡

范围：只做调查、源码静态核对与公开直播间只读探测。**没有修改正式业务代码、数据库 schema、AI、备份、Bilibili/YouTube 采集，也没有新增运行时依赖。** 完整报告：`docs/PLATFORM_RESEARCH_TIKTOK_TWITCH_DOUYIN.md`；日志：`log/2026-11-15-platform-research.md`。

### 0.33.1 真实只读探测（2026-11-15 10:10–10:45 Asia/Shanghai）

- **Twitch 匿名 IRC**（`wss://irc-ws.chat.twitch.tv:443`，5 个公开频道）：45 秒 **644 条 PRIVMSG，644/644 带 `user-id`、`display-name`、消息 `id`**；USERNOTICE 出现 resub/viewermilestone；`ROOMSTATE` 返回 `room-id=71092938`；25 秒样本 239 条、0 重复消息 ID、9 条带 `emotes` 标签；**Bits 事件三次探测均未观测到**。
- **Twitch EventSub**：`wss://eventsub.wss.twitch.tv/ws` 返回 `session_welcome`（keepalive 10s）；无 Token 创建 `channel.chat.message` 订阅返回 **401 OAuth token is missing**，确认 WebSocket 握手不等于免授权。
- **抖音匿名 WSS**（`live.douyin.com/708764876300`，dyhub lightweight 临时验证）：连接为 `live`；约 7 秒 175 条消息；45 秒窗口 16 chat / 192 member / 25 like / 3 follow / 8 room / **0 gift**；30 秒 13 条 chat，13/13 有 `user.id`、昵称、`secUid`、消息 ID、CJK，0 重复；公开页 `room.status=2`（直播）/`4`（结束）。
- **TikTok**：TTLC 2.5.0 与 2.4.4 连接真实 LIVE 账号均被 `fetchWebcastSignatureFromEulerRoute` 拒绝：**“This endpoint requires a Business plan”**；1.2.3 本地签名 5 秒超时；TikTok 页面返回 WAF 挑战，未绕过。**未取得任何真实 TikTok 事件。**
- 未登录任何账号、未提供 Cookie、未购买/赠送礼物、未保存聊天正文；临时目录已删除，未写用户数据目录。

### 0.33.2 结论

1. **Twitch 推荐第一个正式开发**：免登录公开聊天、稳定 User ID、消息 ID、订阅/赠订 USERNOTICE 均有真实证据；可用内置 `WebSocket` + 自研 IRC 解析，零新增依赖，适合 Node SEA。匿名 IRC 未在官方文档承诺，必须标注为非官方兼容路径；Bits 真实事件、OAuth/EventSub、断线与下播仍待专项验证。
2. **抖音可以第二个做，但礼物必须先决策**：匿名弹幕/昵称/稳定 UID 实测可用；**2026 年起礼物只推给登录会话**，匿名 0 gift；本地签名脚本为 **AGPL-3.0**，与 MIT 的 LiveMemory 分发冲突；逆向协议有风控/条款风险。官方“直播小玩法”需提案/软著/审核，且最多 10 个弹幕指令，不是通用采集 API。
3. **TikTok 暂缓**：官方公开产品页没有 LIVE 聊天/礼物 API；第三方库 AGPL、约 60 个 npm 包，签名需 Euler Business（$50/月起），公开 Issue 报告漏消息；本机页面被 WAF 阻断。不能把它描述成免费、本地优先、普通用户即用的能力。
4. **三平台都不能把虚拟礼物展示价值当主播实际收入**：Twitch Bits/Tier、TikTok/抖音钻石均无本币金额；只能记数量/档位/展示价值，`amount_minor=null`、`value_kind=unknown`，UI 显示「金额未知」。

### 0.33.3 工程兼容性

- 所有新平台事件仍只经 `src/platforms/shared/ingest.mjs`；`src/shared/events.mjs` 的 canonical 字段足够表达聊天/礼物/订阅，无需改库。
- 现有 schema 对“连送组/最终态、订阅 Tier/月数、Bits 数量、赠订付款者/接收者、平台虚拟币”没有一等字段；报告提出映射方案（最终态才写 `gift`、付款者/接收者分两条、虚拟币只写 `amount_display`），**本轮不改 schema**。
- 自动开播监听可复用 `MonitoringManager` + 新 detector；不改变 Bilibili/YouTube 行为；Twitch/抖音都能用公开页面状态做检测原语。
- 新平台默认沿用 30 天原文保留策略（可配置 1–30 天），保留稳定 ID/计数/金额合计；需法律评审。

### 0.33.4 验证边界

- **未验证**：Twitch Bits 真实事件、EventSub OAuth/DCF 端到端、真实断网恢复、真实下播；抖音礼物（需登录 Cookie）、连送、跨场次改名、下播/重连/多房间/千条每秒；TikTok 全部真实事件；三平台 Node SEA 打包。
- **未修改**：业务代码、数据库、AI/备份/画像、Bilibili/YouTube 行为、版本号、EXE。
- **未执行**：全量测试（本轮无代码改动，不适用）；未 Push、未 Tag、未发布。
- **等待用户确认**：是否按 Twitch 方案开始正式开发；抖音是否接受登录 Cookie 与 AGPL；TikTok 是否暂缓或采用用户自备 Euler Business Key 的实验方案。

## 0.32 RC0-GITHUB-RELEASE-PREP：GitHub Release 发布准备（2026-11-15）✅ 发布准备（后续已发布）

> **历史修正（2026-11-17 审计）**：本节记录的是发布准备阶段，当时确实尚未 Push/Tag/Release；
> 后续 `v0.13.2-rc.0` 已于 2026-11-14T16:22:25Z 发布（Release ID `445425123`，资产为 Windows zip）。
> 本节结尾的“未发布”只代表当时状态，不代表最终事实。发布证据见 `docs/RELEASE_HISTORY.md`。

范围：只准备发布材料，**没有修改产品代码、版本号或功能**；准备阶段未 Push、未创建 Tag（本地或远程）、未创建 GitHub Release、未上传资产。

### 0.32.1 命名与目标

- 产品版本保持 **0.13.2**；Release 标识使用预发布后缀。
- 建议 Tag：**`v0.13.2-rc.0`**
- Release Title：**`LiveMemory v0.13.2 RC0`**
- 类型：**Pre-release**
- Target：**`cb286241fe5a4b3322455d661218bb0a14044983`**（EXE 的 `build-info.commit`，全量与 EXE 回归使用的代码提交；之后均为文档提交）
- 仓库此前无任何 tag，未发现命名冲突；`docs/RELEASE.md` §1 的语义化版本允许预发布后缀，因此不改产品版本，只把 `-rc.0` 用于 Release 标识。**不创建本地或远程 tag。**

### 0.32.2 发布文件

目录 `dist/release-v0.13.2-rc.0/`（gitignored）与压缩包 `dist/LiveMemory-v0.13.2-rc.0-windows-x64.zip`：

| 文件 | 大小 | SHA-256 |
| --- | --- | --- |
| `LiveMemory.exe` | 96,733,184 | `0cf672438a4723589f4164316e98965a6ff549a132deb30a243638a3f62531c8` |
| `README.md` | 48,321 | `3948d4c96c9eaf10e2d56590f65b527695e27559bd9dd110c69ec4887bcd427a` |
| `LICENSE` | 1,063 | `32f41a237cd7e80b1f83589c058ff8da73903dd25091b4eefb0114487182303b` |
| `RELEASE_NOTES.md` | 10,875 | `0a771d7fcbe25214e05f0c6f9ffeb9b0e2ad7bcc23d1149b827ce4edcfea2d7c` |
| `SHA256SUMS.txt` | 314 | `03eb1a791304251f18ebaa47d0c8120e7abc2bda3da1190a07049ba59da56c9f` |
| `LiveMemory-v0.13.2-rc.0-windows-x64.zip` | 35,724,481 | `8aa08f0e1e908e80880b578b8cf6d6eb24f560f968d338824ff5684bf5598a2f` |

- `SHA256SUMS.txt` 覆盖前四个文件；压缩包与校验文件本身的哈希另行给出。
- 发布包仅含上述 5 个文件；不含 API Key、Token、Cookie、数据库、真实聊天、`secrets/`、缓存或日志。
- 解压后的 `LiveMemory.exe` 哈希与 `dist/LiveMemory.exe` 一致，Manifest = `requireAdministrator`。

### 0.32.3 检查结果

- [x] 正式 EXE Manifest `requireAdministrator`；buildId `e438e74803cb`、SHA-256 与构建记录一致。
- [x] 全量 **828 passed / 0 failed / 0 skipped（212,358 ms）**。
- [x] EXE 回归：`verify-exe` **10/10**、`verify-help-exe` **14/14**、`verify-p0-5-exe` **12/12**、`verify-p0-2-exe` **13/13**、`verify-ai-token-exe` **16/16**。
- [x] 压缩包解压后逐文件 SHA-256 复核通过；包内无敏感文件名/内容。
- [x] Release Notes 与实际功能一致；明确写管理员权限、自备 Key、第三方费用、AI 可能不准确、DeepSeek 真实验证范围与 RC0 预发布性质。
- [ ] **真实 Windows 双击与 UAC 点击：待用户人工确认**（自动化不能代替）。
- [ ] **Push / 本地或远程 Tag / Release / 资产上传：等待用户明确授权。**

### 0.32.4 文档与状态

- 面向用户的 Release Notes：`docs/release-notes/v0.13.2-rc.0.md`（发布包内为 `RELEASE_NOTES.md`）。
- 发布记录与资产证据：`docs/RELEASE_HISTORY.md`（v0.13.2-rc.0）。
- 开发日志：`log/2026-11-15-rc0-release-prep.md`。
- **状态（当时）：发布材料已就绪；未发布，等待用户确认。** 后续已发布，见本节开头的审计说明。

## 0.31 RC0-ADMIN-MANIFEST：恢复双击自动请求管理员权限（2026-11-14）✅

范围：只恢复正式 EXE 启动时自动请求管理员权限，并更新构建断言、测试与文档。**没有修改 Bootstrap 目录选择逻辑、数据目录解析、AI、直播采集、长期画像、Provider、备份恢复或任何业务功能；没有放宽本地 API 会话认证、Bootstrap token、Origin/Host 检查、SSE 认证、API Key/凭据保护、数据库与备份恢复机制。**

### 0.31.1 原因与决定

- 用户在实际电脑上双击上一版（`asInvoker`）EXE 时无法启动，失败步骤 `Bootstrap`，详细信息 `No writable application folder`。
- 用户明确决定：不继续调查目录权限、不修改 Bootstrap 目录选择策略、不做额外架构重构，**只恢复 EXE 启动时自动请求管理员权限**。
- 正式 EXE 的 RT_MANIFEST 改为 **`requireAdministrator`**：双击时由 Windows 显示标准 UAC 确认；同意后以管理员权限启动；用户拒绝时由 Windows 取消启动。不要求右键“以管理员身份运行”，不绕过或关闭 UAC。

### 0.31.2 修改内容

- `scripts/build-windows.mjs`：postject 注入前后都把 Manifest 设为并断言 `requireAdministrator`；最终 EXE 再读取一次。
- `scripts/pe-manifest.mjs`：注释更新；助手仍支持为测试副本生成 `asInvoker`。
- `scripts/test-exe-copy.mjs`（新增）：自动化测试无法接受交互式 UAC，因此读取正式 EXE、确认其确为 `requireAdministrator`，只在内存中把副本改为 `asInvoker` 并写入 `tests/.tmp/`；**正式 EXE 不被修改**。
- `scripts/verify-exe.mjs`、`verify-help-exe.mjs`、`verify-p0-5-exe.mjs`、`verify-p0-2-exe.mjs`、`verify-ai-token-exe.mjs`：先断言正式 Manifest，再用测试副本运行原场景；历史 UI 脚本（history / ai / live-status / YouTube lifecycle）同步改为测试副本。
- `tests/unit/pe-manifest.test.mjs`：断言构建脚本使用 `requireAdministrator`，保留测试副本能力。
- 注释同步：`src/launcher/launcher.mjs`、`src/launcher/profile-scan.mjs`、`src/server/auth.mjs`（仅注释，无行为变化）。

### 0.31.3 保持不变的安全机制

- 除 `/api/health`、`/api/auth/status`、`/api/auth/session` 外，所有 `/api/*`（含 SSE）仍要求随机会话 Cookie；未认证仍 401。
- Bootstrap token 仍只放在 URL fragment，一次使用、5 分钟过期，不进入查询串、日志或 runtime.json。
- 全方法 Origin 同源、`Origin:null` 拒绝、跨站 `Sec-Fetch-Site` 拒绝、Host 严格校验、无 CORS 放行。
- API Key 仍只写入本地加密凭据库；备份仍排除凭据；恢复 journal、ZIP/路径/大小/CRC 校验与删除范围限制不变。
- 管理员权限不是 API 授权边界；提权不放宽任何认证或数据完整性规则。

### 0.31.4 测试

- `tests/unit/pe-manifest.test.mjs`：2/2（测试副本能力 + 构建脚本 `requireAdministrator` 断言）。
- 全量：**828 passed / 0 failed / 0 skipped（212,358 ms，2026-11-14）**；上一轮 828，测试数量不变（仅更新断言）。
- 正式 EXE 矩阵（全部针对本轮 `e438e74803cb` 二进制；功能场景使用测试专用 asInvoker 副本，Manifest 单独断言）：
  - `verify-exe`：**10/10**；
  - `verify-help-exe`：**14/14**；
  - `verify-p0-5-exe`（认证/Origin/Host/SSE/重启）：**12/12**；
  - `verify-p0-2-exe`（备份 → 全新目录恢复 → 重启 → 再备份）：**13/13**；
  - `verify-ai-token-exe`（AI 分析 + Token 归因 + Resume）：**16/16**。

### 0.31.5 正式 EXE（本轮）

| 项目 | 值 |
| --- | --- |
| 文件 | `dist/LiveMemory.exe` |
| 大小 | `96,733,184` bytes（92.3 MB） |
| SHA-256 | `0cf672438a4723589f4164316e98965a6ff549a132deb30a243638a3f62531c8` |
| buildId | `e438e74803cb` |
| source hash | `e438e74803cbd92ff07fc85db47acada2d3b8f9d2f794f83c0982c03d6817392` |
| commit | `cb286241fe5a4b3322455d661218bb0a14044983`（构建时 HEAD，即本轮代码提交） |
| builtAt | `2026-11-14T15:28:38.727Z` |
| RT_MANIFEST | **`requireAdministrator`** |
| 资源 | `192` files；21 个必需模块 |

- 版本保持 **0.13.2**；数据库 schema **16**、结果 Schema **1.3.0**、提示词 **v13.2**、默认 10 人/批、金额/身份/去重、备份格式均未改动。

### 0.31.6 边界与待验收

- **真实 UAC 双击/点击未完成自动化验收**：本轮自动化在非交互、非提升会话运行，无法点击 UAC；只验证了正式 Manifest 与同一二进制的功能副本。**真实 Windows UAC 交互列为用户人工验收项**，不声称已通过真实双击测试。
- 未验证拒绝 UAC 后的系统行为（预期由 Windows 直接取消启动，程序没有额外补偿路径）。
- 未在干净 Windows 账户/另一台电脑上验证提权后的数据目录（`profile-scan` 保守逻辑保留，未改 Bootstrap）。
- 未 Push / 未 Tag / 未发布。

### 0.31.7 提交与构建记录

- 代码与文档提交：`cb286241fe5a4b3322455d661218bb0a14044983`（`fix: restore administrator manifest for the Windows EXE`）。
- 正式 EXE 在该提交**之后**重建：`build-info.commit` = `cb28624`，buildId `e438e74803cb` 只由源码内容决定，与提交前构建一致。
- 最终构建记录补充提交：本文件所在的后续提交（HEAD）。
- 提交身份：`zgrg29 <10182596+zgrg29@users.noreply.github.com>`；**未 Push / 未 Tag / 未发布**。

## 0.30 RC0-USAGE-GUIDE：三语使用说明与 RC0 封版（2026-11-14）✅

范围：只新增控制台内「使用说明」入口与内容，并完成 RC0 封版。**没有新增任何观众数量、消息数量、直播时长、AI 分析次数、总 Token、总费用、总运行时间或批次数量限制；没有强制审核 AI 画像；没有新增阻断操作的确认弹窗；没有修改 AI 分析、长期画像、事实合并、批次调度、数据保存/恢复机制或 Provider 配置逻辑。**
开发日志：`log/2026-11-14-rc0-usage-guide.md`；界面规范：`docs/UI_DESIGN.md` §7.23。

### 0.30.1 新增内容

- 侧栏在「设置」之后新增「使用说明 / 使い方 / User guide」（`data-nav="help"`，书页图标），路由 `#/help`；`src/web/js/pages/help.js` 只读渲染，不调用任何 `/api/*`、不写数据、不弹确认。
- 覆盖 9 个主题：① 首次启动与基本流程；② 连接 Bilibili / YouTube 直播；③ 直播记录、观众数据与历史场次；④ AI Provider 与 API Key；⑤ 单场分析与长期观众画像；⑥ 长期记忆、事实可信度与原始证据；⑦ 分析进度、失败处理与继续；⑧ 备份、恢复与迁移；⑨ 常见问题与注意事项（8 条可折叠问答）。
- 三语共 **112** 个 `help.*` 叶子键 + `nav.help`，三份字典键集完全一致，无空串、无占位符缺失。
- 复用现有组件与视觉语言：`pageHead`、`card`、`callout`、`button--secondary`、原生 `details`；只新增 `.help-*` 样式与一个导航图标，未改动其他页面。
- 桌面为 sticky 目录 + 章节两栏；≤1000px 单列并把目录变为胶囊行；≤700px 术语表单列；≤520px 缩小字号；长 URL/路径/长句使用 `overflow-wrap:anywhere`。
- 文案客观说明 AI 画像可能不准确、证据只保证引用合法而不保证语义正确；并明确写出没有上述任何使用限制，也不会强制审核画像或阻断操作。

### 0.30.2 测试

- 新增 `tests/unit/help-ui.test.mjs` **9** 项：导航/路由/图标接线；9 章节顺序、`aria-labelledby` 与锚点；三语真实字典渲染且无未解析键；连接/历史/Provider/分析/记忆/恢复/备份/FAQ 内容覆盖；无限制与无强制审核文案；目录滚动与操作按钮跳转；FAQ 8 条问答；只读（无 `innerHTML` / `alert` / API 调用）；响应式 CSS 断言。
- `tests/unit/i18n.test.mjs` 全部通过（三语键集、占位符、非空、CLI 三语）。
- 全量：**828 passed / 0 failed / 0 skipped（209,637 ms，2026-11-14，`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`）**；上一轮 819，本轮 +9。
- 新增 `scripts/verify-help-exe.mjs`：正式 EXE **14/14**（启动与 buildId、未认证 401 未被放宽、schema 16、导航/路由/模块/图标/响应式 CSS、三语键一致与内容覆盖、无限制文案、切换日语生效）。
- `scripts/verify-exe.mjs`：**10/10**（asInvoker、全新目录、重启、硬杀恢复、端口顺延、单实例、不可写目录、异目录、解压复用、CLI 三语）。
- 构建脚本把 `src/web/js/pages/help.js` 加入 `REQUIRED_MODULES`：缺少说明页的构建直接失败。

### 0.30.3 正式 EXE（本轮）

| 项目 | 值 |
| --- | --- |
| 文件 | `dist/LiveMemory.exe` |
| 大小 | `96,733,184` bytes（92.3 MB） |
| SHA-256 | `0f4cf0a39d1b7182182d681e6261f7517ab952142d0c4848d177e1788b6f2cdd` |
| buildId | `74ed76e88a51` |
| source hash | `74ed76e88a519ac90af5b7705abd5c167bbf598825ed9f205c400cb32bd7a8e5` |
| commit | `bc48a943af943cf8f7ae9abbbe1e3376669fb5ca`（构建时 HEAD） |
| builtAt | `2026-11-14T14:21:47.608Z` |
| 资源 | `192` files；21 个必需模块；RT_MANIFEST `asInvoker` |

- 构建与验证均在 `asInvoker` 正式二进制上完成；未使用 Mock Provider、未调用真实付费 API、未发送真实聊天、未修改生产数据库。
- 版本保持 **0.13.2**；数据库 schema **16**、结果 Schema **1.3.0**、提示词 **v13.2**、默认 10 人/批、金额/身份/去重、备份格式均未改动。

### 0.30.4 边界与未验证

- **真实浏览器像素/截图未执行**：本机 DSH 沙箱禁止 Chromium 的 mojo `platform_channel`（Chrome 154 / Edge 157 均在启动时 `0x5` 失败），无法在本轮打开真实浏览器。界面表现由「真实三语字典 + DOM 渲染测试」「打包后的 HTML/JS/CSS 实际下发检查」「三档响应式 CSS 断言」覆盖，**不声称已完成真实浏览器截图或点击验收**；建议用户在本机打开 `#/help` 做一次目视确认。
- 未在干净 Windows 账户/另一台电脑上双击验收；未验证真实窄屏设备，仅按现有 390px 断点规则与无横向溢出的样式约束验证。
- 未 Push、未打 Tag、未发布 Release；按用户要求停止开发，等待决定。

### 0.30.5 封版结论

- RC0 使用说明完成：入口、三语内容、只读行为、桌面/窄屏布局与打包验证均已覆盖；没有引入任何使用限制或强制审核，也没有改变既有 AI 分析、长期画像、事实合并、批次调度、数据保存/恢复与 Provider 逻辑。
- 既有能力回归：全量 828 项通过，正式 EXE 功能矩阵 10/10、说明页专项 14/14。
- 长期画像语义质量仍是已知 P1（§0.29），本轮按用户要求在说明中客观解释，**没有**以此限制操作。
- **状态：RC0 封版完成；等待用户决定 Push / Tag / 发布。**

### 0.30.6 提交与构建记录

- 代码与文档提交：`bc48a943af943cf8f7ae9abbbe1e3376669fb5ca`（`feat: add tri-language in-app usage guide`，19 files，+1899/−9）。
- 正式 EXE 在该提交**之后**重建，`build-info.commit` = `bc48a94`，`--version` 输出 `Build: 0.13.2 (commit bc48a94, assets 74ed76e88a519ac90af5)`。
- `buildId` 只由源码内容决定。提交前把 `pages.css` 的行尾统一为 LF，因此中间态构建（`09545e3611f2`）不是交付物；最终交付 buildId 为 `74ed76e88a51`。
- 最终构建记录补充提交：本文件所在的后续提交（HEAD）。
- 提交身份：`zgrg29 <10182596+zgrg29@users.noreply.github.com>`；**未 Push / 未 Tag / 未发布**。

## 0.29 RC0-FINAL-ACCEPTANCE：最终综合验收与发布阻断项审计（2026-11-14）

完整报告：`docs/RC0_FINAL_ACCEPTANCE.md`；日志：`log/2026-11-14-rc0-final-acceptance.md`。
**未调用真实付费 Provider、未修改生产数据库、未发送真实聊天到第三方、未 Push/Tag/发布。**

- **修复 2 个 P0**：
  1. 无 evidence 的 `confirm + stated` 会把 `inferred` 提升为 `stated`；`validate.mjs`、`embedded.mjs` 跳过无证据 confirm，`engine.mjs` 要求 evidence 才允许提升/激活，无证据的匹配 add 也跳过。
  2. 旧 `/api/memory/import` 路径只按 batch 内 seq 校验证据，未比较 `events.viewer_id`；现在同 batch 跨观众证据返回 `MEMORY_EVIDENCE_OTHER_VIEWER` 并拒绝整份答案。
- 新增 **5** 项测试（2 unit + 3 integration）；全量 **819 passed / 0 failed / 0 skipped（397,114.9 ms，2026-11-14）**。
- 正式 EXE：`dist/LiveMemory.exe`，**96,668,160 B**，SHA-256 `861eeaef3fd647732436809aedfa655da69db0d1ce1c11bbb76d8769972ff447`，
  buildId `7016d4295d0e`，commit `996f99266b9159efb8ff8c7186163061adc73fed`，schema 16，asInvoker。
- EXE 矩阵：`verify-exe` **10/10**、`verify-p0-5-exe` **12/12**、`verify-p0-2-exe` **13/13**、
  `verify-ai-token-exe` **16/16**、`verify-youtube-lifecycle-exe` PASS（181s 断网恢复）。
- 真实平台：Bilibili 房间 5050（9 chat / 4 viewers / ended）；YouTube Sky News `LXQz2kkE-C0`
  （8 chat / 8 channel id / 7 active / ended）。
- 真实浏览器：外部 Chrome 154 + 正式 EXE，fragment→Cookie `authenticated: true`；
  `#/live`、`#/viewers`、`#/ai` 无页面异常（清理 EPERM 为脚本未等待 EXE 退出）。
- 归档真实质量（只读重评）：严格召回 15.1% / 24.5% / 29.5% / 18.0%，重要召回 7.7% / 23.1% / 19.2% / 19.2%，
  错误 stated 25.0%–31.1%；跨观众 0；重复 0。
- **P1**：同 `kind+topic` 不同 statement 被静默 confirm（可确定性复现，旧“在便利店打工”+新“在医院工作”仍显示旧说法）；
  25%–31% stated 引用不支持结论；临时信息（生日/当天状态）被长期化；摘要无证据级校验。
- **结论：建议进入 RC0 小范围闭源内测；不建议公开发布。**

## 0.28 RC0-MEMORY-QUALITY：长期画像事实完整性与语义质量专项（2026-11-14）

完整报告：`docs/MEMORY_QUALITY.md`；开发日志：`log/2026-11-14-memory-quality.md`。
**未调用真实付费 Provider、未改生产数据库、未发送真实聊天、未 Push/Tag/发布。**
归档真实结果来自上一轮用户授权的 DeepSeek `deepseek-flash` 测试（`tests/.tmp/paid-p03`），
本轮只读重评。

### 0.28.1 标准答案集与指标

- 新增 `tests/fixtures/memory-quality/gold-corpus.mjs`：**16 位观众 / 3 场次 / 70 条消息 /
  30 条当前事实 + 6 条被替代 / 11 条重要 / 1 条歧义 / 26 条不应保存**，覆盖任务要求的 15 类场景。
- 新增 `tests/fixtures/memory-quality/p03-retro-gold.mjs`：上一轮 16 句合成模板的事后标注，
  用于离线重评归档真实结果（zh-CN 25/200，ja 60/600）。
- 新增 `src/ai/quality/metrics.mjs`：严格召回、准确率、重要召回、跨观众、重复、误收、
  歧义、Token/费用；`src/ai/quality/facts.mjs`：单任务 stated/inferred/uncertain 计数。
- 评分 CLI：`scripts/memory-quality-eval.mjs`；结构对照：`scripts/memory-batch-structure.mjs`。
- 标准答案不在模型输入中；集成测试读取实际 ZIP 并断言不泄漏。

### 0.28.2 关键结论：旧“20 人更差”不成立

归档 4 次真实运行的严格重评：

| 运行 | 行数 | stated | uncertain | 正确 | 召回 | 重要召回 | 准确率 | 请求/补答 | Token/正确 | $/正确 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 第 1 次 cap10 | 67 | 28 | 37 | 21 | 15.1% | 7.7% | 75.0% | 7 / 4 | 3,393 | $0.001413 |
| 第 1 次 cap20 | 49 | 47 | 0 | 34 | 24.5% | 23.1% | 72.3% | 2 / 0 | 817 | $0.000332 |
| 第 2 次 cap10 | 74 | 61 | 11 | 42 | 29.5% | 19.2% | 68.9% | 6 / 3 | 1,386 | $0.000589 |
| 第 2 次 cap20 | 38 | 35 | 0 | 26 | 18.0% | 19.2% | 74.3% | 2 / 0 | 1,045 | $0.000406 |

- 旧结论把 37 条 `needs_confirmation` 当成“有效事实”，且 cap10 多发 3–4 次补答请求；
  **行数不是质量，也不是等预算比较**。
- 两次严格召回方向相反；20 人每请求/每 Token 更省，但运行方差大，不能宣布优劣。
- **默认 10 人/批保持不变**；撤销“20 已证明更差”，改为“需等预算、重复 ≥3 次的受控复测”。
- 5 人批次只有结构数据（5 批 / 31,303 估算 Token / 249,283 B），**无语义证据**。

### 0.28.3 确定性修复

1. **摘录窗口不再静默**：`memory_context.json` 每位观众新增
   `excerpt_total/included/omitted/window`；manifest `batch_plan` 新增
   `excerpt_per_viewer_cap=120`、`excerpt_omitted_messages`、`excerpt_truncated_viewers`；
   提示词明确“不得推断被省略的早期消息”。默认 120 条/人未改动（没有真实高频样本）。
2. **事实质量可见**：`GET /api/ai/analyze/status` 的 `efficiency.factQuality` 区分
   stated/inferred/uncertain 与 active/needs_confirmation；`factsSaved` 保留兼容。
3. **未改**：结果 Schema 1.3.0、提示词 v13.2、数据库 schema 16、默认 10 人/批、
   金额/身份/去重/Resume/补答协议。
4. **已确认但未改**：同 `kind+topic` 不同 statement 会被 confirm 合并（既有不变量）；
   补答只检查观众覆盖、不检查事实完整性；本地校验不证明语义蕴含。均列入残余问题。

### 0.28.4 测试与 EXE

- 新增 10 unit + 7 integration；oracle 在 5/10/20 人批次下 100% 严格召回/准确率；
  退化答案被度量成漏提/误收；跨观众证据导入前被拒绝；150 条高频观众披露 120/30 截断。
- 全量：**814 passed / 0 failed / 0 skipped（248,833 ms，2026-11-14）**；上一轮 797，本轮 +17。
- 正式 EXE：见 §0.28.5（buildId / SHA-256 / commit / asInvoker / EXE 矩阵）。

### 0.28.5 正式 EXE（本轮）

| 项目 | 值 |
| --- | --- |
| 文件 | `dist/LiveMemory.exe` |
| 大小 | `96,665,600` bytes（92.2 MB） |
| SHA-256 | `dd4289804dae729f672bc06263558d734fbb0eed523d9ab6c1fede9dfce471bd` |
| buildId | `d951f89fe379` |
| source hash | `d951f89fe37939cda8b99b99131f85b9290897b81b6249aaa3a93cf4fb57a569` |
| commit | `52bcf6cd6792396713fae3cd84308fd386f80a71`（构建时 HEAD） |
| builtAt | `2026-11-14T12:19:42.897Z` |
| 资源 | `191` files；20 个必需模块；asset hash `d951f89fe37939cda8b9`；RT_MANIFEST `asInvoker` |

- `scripts/verify-exe.mjs`：**10/10**；`scripts/verify-p0-2-exe.mjs`：**13/13**；
  `scripts/verify-p0-5-exe.mjs`：**12/12**；`scripts/verify-ai-token-exe.mjs`：**16/16**。
- 长期画像正常、Resume 正常、数据保存正常、备份恢复正常、API 认证正常、asInvoker 正常。
- **性质**：正式 EXE + 本地 Mock Provider + 合成数据；**不是**真实付费 Provider 验收，
  **不是**真实浏览器点击。构建在代码提交之前，`build-info.commit` 记录构建时 HEAD。

### 0.28.6 提交

- 代码提交：`8d4e024bc01561be6f418aa9415a2c0dc5bfa3c5`
- 补答披露补充：`2b317212c283f6fb9beabf76c35ba2e1c0459f99`
- 文档收尾提交：本文件所在的后续提交（HEAD）
- 构建时 HEAD：`52bcf6cd6792396713fae3cd84308fd386f80a71`
- 提交身份：`zgrg29 <10182596+zgrg29@users.noreply.github.com>`；未 Push/Tag/发布。
- `buildId` 由源码内容哈希决定，与提交哈希无关；用本轮源码可重建同一 `d951f89fe379`。
  构建在代码提交前完成，因此 `build-info.commit` 是构建时 HEAD，不是代码提交哈希。

## 0.27 RC0 P0-3：Provider 兼容性、DeepSeek 真实付费验收与 20→10 回退（2026-11-14）

完整底稿、兼容性矩阵与付费方案：`docs/AI_PROVIDER_COMPATIBILITY.md`；开发日志：
`log/2026-11-14-p03-provider-compat.md`。
阶段 A 使用 `tests/.tmp` 隔离目录、合成数据与 Mock Provider。
阶段 B 在用户明确授权后（Plan A / DeepSeek `deepseek-flash` / $1.25 / 仅合成数据）执行：
**66 次 Harness 计数尝试（T4 的 2 次本地预算停止未发出；T3 的 2 次暂停取消已发出但未计入
usage）、估算 $0.3444**；未读取生产 `secrets/`、未修改生产数据库、未 Push/Tag/发布。
**只有 DeepSeek 达到 L3（真实 Provider 已验证）；其他 Provider 仍为 L2/L4。**

### 0.27.1 阶段边界与授权

- **阶段 A（完成）**：阅读/审计、离线复现、确定性修复、Mock/集成/全量测试、正式 EXE 与
  EXE 矩阵。
- **阶段 B（已执行，仅 DeepSeek）**：用户明确选择 `deepseek-flash` 与 $1.25 上限；Key 由用户
  在隔离控制台的真实浏览器 UI 中输入；Harness 未接触明文 Key。未遍历其他 Provider、未自动
  扩大规模。
- **P0-3 不能整体关闭**：DeepSeek 的真实链路可声明通过；其他 Provider、真实账单核对与
  真实 EXE 的 Key 流程仍需分别验收。

### 0.27.2 发现并修复的确定性缺陷

1. **结构化输出能力检测是循环的（严重）**：`routes.mjs` 把
   `config.capabilities?.structuredOutputs === true` 作为能力测试入参，而该字段只由测试写入。
   首次测试必然只用 `json_object`，因此永远写不回 `true`；OpenAI/OpenRouter 的真实用户
   从不发送 `response_format: json_schema`，RC0-AI-EFFICIENCY 的「Schema 只发一次」在生产中
   **未生效**（画像约 1.5 KiB、单场约 3.9 KiB/请求的文本 Schema 仍在发送）。
   离线复现：路由同形入参得到 `none, json_object, json_object, json_object`；
   传 Provider 声明后为 `none, json_schema, json_schema, json_schema`。
   现在由 Provider 目录声明触发探测，且只有 session 复杂 Schema 通过本地组装/校验才记 `true`。
2. **模型拒绝 `response_format` 时永久失败**：能力测试 fatal、真实任务 `client` 错误不重试。
   现在能力测试一次降级、真实任务在 `requestOnce()` 最多两次降级
   （`json_schema → json_object → none`）；降级时把完整 Schema 追加回最后一个 user 消息；
   持久化 `capabilities.structuredOutputs=false`，后续任务/Resume 不重复失败。
   识别范围收窄为 400/422 且错误信息含 `response_format`/`json_schema`/`json_object`/
   `structured outputs`，泛化 “schema” 错误不会触发额外付费请求。
3. **OpenAI 推理模型参数不兼容**：`max_tokens` 不能用于 o-series；推理模型只接受默认
   temperature；`system` 应改为 `developer`。现在 `providerId=openai` 发
   `max_completion_tokens`，o-series/GPT-5+ 不发 temperature、映射 `developer`，并加 16K
   思考预留上限（只按实际用量计费）。能力测试同样应用。
4. **OpenAI 缓存写入 Token 未解析**：正确字段
   `prompt_tokens_details.cache_write_tokens` 未被读取，`cacheWriteInputTokens` 恒为 0。
5. **OpenRouter `usage.cost` 被丢弃**：现在归一为 `providerReportedCost`，与本地
   「Token × 用户单价」的估算费用分开保存；`providerCostRequests` 区分完整/部分自报。
6. **DeepSeek V4 默认 thinking 导致能力检测失败（真实付费发现）**：`deepseek-flash` 默认
   `thinking` effort=high，32 Token 的文本探测被隐藏推理耗尽，返回空内容 + `finish_reason=length`
   （`AUTO_OUTPUT_TRUNCATED`）。现在对 DeepSeek 显式发送 `thinking: {type: "disabled"}`，使
   `max_tokens` 回归为回答预算；重新检测 `passed`，真实任务全部 `reasoningTokens=0`。
7. **缺失缓存单价被当成 0（费用低估）**：`Number(null) === 0`，`normalizePricing()` 二次归一
   把“未填缓存价”写成 0，`estimateCost()` 又把 0 当作免费缓存，导致缓存命中 Token 不计费。
   现在用显式 null/undefined 判断；缺价时按普通输入价估算并标 `cachePriced=false`，
   显式填 0 才表示免费缓存。
8. **20 人批次出现真实语义质量回归**：两次真实 DeepSeek A/B 中，20 人上限的有效事实只有
   10 人上限的 **73% / 51%**（覆盖仍 25/25）。RC0 恢复默认 10 人/批；
   `MEMORY_MAX_VIEWERS_PER_BATCH=20` 仅保留为技术上限与实验参数。详见 §0.27.4 与
   `docs/AI_PROVIDER_COMPATIBILITY.md` §9.4。

### 0.27.3 Provider 兼容性矩阵（摘要）

| Provider | 协议/鉴权 | 结构化输出 | 输出上限 | 流式 | 证据等级 |
| --- | --- | --- | --- | --- | --- |
| OpenAI | Chat Completions / Bearer | `json_schema`（验证后）+ 一次降级 | `max_completion_tokens`；推理模型无 temperature/developer | SSE | **L2** |
| DeepSeek | OpenAI-compatible / Bearer | 仅 `json_object` | `max_tokens`；显式关闭 thinking | SSE | **L3（`deepseek-flash`）** |
| DashScope/Qwen | compatible-mode / Bearer | `json_object` | `max_tokens` + `max_completion_tokens` | SSE | **L2** |
| OpenRouter | `/api/v1` / Bearer | 按模型；验证后 `json_schema` | `max_tokens` | SSE | **L2** |
| Anthropic | Messages / `x-api-key` | 无 `response_format`（提示词 + 本地校验） | `max_tokens` | SSE | **L2** |
| MiniMax | OpenAI-compatible / Bearer | `json_object` | `max_tokens` | SSE；usage 可能未知 | **L2** |
| 自定义 OpenAI-compatible | 用户 Base URL / Bearer（可选） | 验证后 `json_schema` + 降级 | `max_tokens` | SSE + 一次非流式回退 | **L2** |

所有 Provider 均未达到 **L3（真实 Provider 已验证）**；真实语义、真实计费与多语言仍待阶段 B。
完整字段级差异、已知不兼容与单位/费用口径见 `docs/AI_PROVIDER_COMPATIBILITY.md` §2–§4。

### 0.27.4 10 vs 20：离线结构 + 真实语义，结论是回退 10

离线结构（阶段 A，Mock）：

| 数据 | 上限 | 请求 | 输入 Token（模拟） | 请求字节 | 覆盖/事实 |
| --- | --- | --- | --- | --- | --- |
| 25 观众 / 200 消息 | 10 | 3 | 25,881 | 82,818 | 25/25 |
| 25 观众 / 200 消息 | 自适应 20 | 2 | 22,898 | 73,271 | 25/25 |
| 100 观众 / 1,000 消息 | 10 | 10 | 113,038 | 361,706 | 100/100 |
| 100 观众 / 1,000 消息 | 自适应 20 | 6 | 101,310 | 324,183 | 100/100 |

真实 DeepSeek `deepseek-flash`（阶段 B，同一数据、同一价格、温度 0、thinking 关闭）：

| 运行 | 上限 | 状态 | 覆盖 | 有效事实 | 请求 | 输入 | 输出 | 缓存 | 费用 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 第 1 次 | 10 | complete | 25/25 | **67** | 7 | 62,048 | 9,209 | 32,000 | $0.02967 |
| 第 1 次 | 20 | complete | 25/25 | **49** | 2 | 24,487 | 3,297 | 1,536 | $0.01130 |
| 第 2 次 | 10 | complete | 25/25 | **74** | 6 | 50,088 | 8,104 | 22,912 | $0.02475 |
| 第 2 次 | 20 | complete | 25/25 | **38** | 2 | 24,475 | 2,686 | 1,536 | $0.01057 |

- 事实保留率：**73%** 与 **51%**；覆盖、Schema、证据、去重全部通过。
- cap20 的第一个批次含 17 位观众，只产生 17 条操作（每人 1 条）；cap10 的 10 人批次
  分别产生 37 / 11 / 26 条。抽样：观众 15 的 8 条消息，cap10 提取 4 条、cap20 只 1 条。
- **结论：20 人上限存在明显有效事实损失，按任务要求恢复保守默认 10 人/批。**
  `AnalysisRunner` 默认 `memoryViewerCapHard=10`；`MEMORY_MAX_VIEWERS_PER_BATCH=20`
  只保留为技术上限与实验参数。20 人只有在提示词/质量修复并再次真实对照后才能重新启用。
- 复现：`scripts/ai-efficiency-baseline.mjs --viewer-cap 10|20`（离线结构）；
  `scripts/ai-paid-acceptance.mjs`（真实 A/B，需用户授权与 Key）。
- **RC0-MEMORY-QUALITY 修正（2026-11-14）**：上表的“有效事实”是行数，包含 37 条 uncertain；
  cap10 两次分别多发 4 / 3 次补答，cap20 为 0。按 stated + 语义匹配 + 引用支持重评后，
  两次方向相反（cap10 15.1%/29.5%，cap20 24.5%/18.0%），旧“20 更差”结论撤销，
  改为“证据不足、需等预算重复复测”。默认 10 人/批仍保留。详见 §0.28 与
  `docs/MEMORY_QUALITY.md`。

### 0.27.5 测试

- 新增 `tests/unit/ai-provider-compat.test.mjs` **13** 项、`tests/integration/ai-provider-compat.test.mjs` **3** 项。
- 全量：**797 passed / 0 failed / 0 skipped**（2026-11-14，最终结果见本节末尾）。
- 回归捕获的真实缺陷：最初用 `/schema/` 识别格式拒绝，导致 `v13-scheduler` 的
  “synthetic schema failure” 被当成格式拒绝并多发一次请求（预期 2、实际 3）。收窄匹配后复跑。
- 无数据库迁移、无备份格式变化、结果 Schema 仍 1.3.0、提示词版本仍 v13.2。

### 0.27.6 正式 EXE（Mock 回归）

| 项目 | 值 |
| --- | --- |
| 文件 | `dist/LiveMemory.exe` |
| 大小 | `96,640,000` bytes（92.2 MB） |
| SHA-256 | `20d7a58b1fbf4ea788b5cc3f4c0deb14528cf762ebcb0df101b7e8ef6c1fc1fd` |
| buildId | `69ec022cee31` |
| source hash | `69ec022cee31a872a81afa7b4747cc09da81ab3fa355f3786ac7ca5137a8bb4c` |
| commit | `f9b0cdaa88abaeb6ba9cd9b9789f51c46646862e` |
| builtAt | `2026-11-14T11:23:54.184Z` |
| 资源 | `189` files；20 个必需模块；RT_MANIFEST `asInvoker` |

- `scripts/verify-ai-token-exe.mjs`：**16/16**。正式 EXE + 本地 Mock Provider：40/40 观众、
  4 个计划批次（默认 10 人/批）、注入 500 后只重发 b02、完成后 Continue 0 请求、
  重启后 token 一致、便携备份可创建。
- `scripts/verify-exe.mjs`：**10/10**（asInvoker、全新目录、重启、硬杀恢复、端口顺延、单实例、
  不可写目录、异目录、解压复用、CLI 三语）。`--version` 返回 buildId `69ec022cee31`。
- `scripts/verify-p0-5-exe.mjs`：**12/12**；`scripts/verify-p0-2-exe.mjs`：**13/13**。
- **性质**：正式 EXE + 本地 Mock + 合成数据；**不是**真实付费 Provider 验收。

### 0.27.8 正式 EXE 的真实 DeepSeek 验收

`scripts/ai-paid-exe-acceptance.mjs`：**11/11**（正式 EXE + 隔离目录 + 用户已录入的
DeepSeek 配置 + 真实请求；40 位合成观众 / 400 条消息 / zh-CN）：

| 检查 | 结果 |
| --- | --- |
| EXE 启动、buildId | `69ec022cee31` / commit `f9b0cda` |
| 未认证 AI 状态 | 401 |
| 真实 combined 任务 | HTTP 202，`complete`，40/40，failed 0 |
| usage | 8 requests / 8 attempts；输入 105,982 / 输出 10,356 / 缓存 17,408（第 2 次运行） |
| 估算费用 | **$0.0442218** |
| 单场报告 | schema 1.3.0，mode final，topics 5 |
| 长期画像 | 79 条事实，semantic 40/40 |
| 备份 | `.livememory` 1,169,923 bytes，job completed |
| 重启后状态 | `complete`，requests 8 → 8 |
| 完成后重复 Resume | HTTP 202、status complete、requests 8 → 8（0 Provider 请求） |

- 第 1 次运行 10/11：唯一的 FAIL 是脚本断言要求 HTTP 200，而 API 对已完成 Resume 返回 202；
  实际 requests 8 → 8，产品行为正确。修正脚本断言后重跑 **11/11**（第 2 次）。
- 两次 EXE 真实运行合计 **16 次请求 / $0.0891**；加上 in-process 的 50 次 Harness 计数
  （其中 2 次 T4 本地停止未发出）/ $0.2553，总计 **66 次计数 / $0.3444**，仍远低于
  用户批准的 $1.25。费用按 usage 计算；未发出/取消请求不计入。
- 真实 usage 合计（全部运行）：**input 802,872 / output 86,276 / cached 195,200 /
  reasoning 0**；60 个带 usage 的响应（in-process 44 + EXE 16）。
- **性质**：正式 EXE + 隔离目录 + 真实 DeepSeek 请求；**不是**生产数据，**不是** Mock。
  用户通过真实浏览器 UI 在隔离控制台录入 Key 并完成能力检测；EXE 复用该隔离配置。

### 0.27.7 结论与待验收

**P0-3 不能整体关闭；DeepSeek `deepseek-flash` 单项可声明真实通过（L3）。**

已完成（真实付费，用户授权）：

1. 能力检测 `passed`（首次真实失败 `length` 空内容已修复为 thinking 关闭）。
2. 单场报告 + 长期画像：80/80、schema 1.3.0、85 条事实。
3. 100 观众规模 + 暂停/重启/Resume：100/100，未重发已完成批次。
4. 日语 60/60、83 条事实；kana 0.649 / CJK 0.984，无英语回退。
5. 真实 usage（input/output/reasoning/cached）与估算费用；50 次请求、$0.2553。
6. 0 重复 topic/statement、0 跨观众证据、0 无证据事实。
7. 10 vs 20 真实对照：20 的事实保留率 73% / 51%，已回退默认 10。

仍未完成：

1. **其他 Provider**（OpenAI / Anthropic / DashScope / OpenRouter / MiniMax / 自定义）
   仍为 L2/L4，必须分别授权与验收。
2. **官方账单核对**：DeepSeek 不返回 `usage.cost`，$0.2553 是按填写单价的估算；
   2 次暂停取消请求是否计费未确认；thinking 开启的质量/费用未对照。
3. **真实 EXE 的 Key 流程**：见 §0.27.8（11/11，已完成）。
4. 真实浏览器截图、真实 429/5xx/截断样本（未刻意制造）；cap10 仍会漏部分事实。
5. 长期画像质量只达到“20 明显更差、10 较保守”的结论，不是“已解决质量”。

费用方案与硬上限见 `docs/AI_PROVIDER_COMPATIBILITY.md` §7；实际执行见 §9。
**金额一律是估算，不是官方账单；其他 Provider 未授权、未发送真实请求。**

## 0.26 RC0-AI-EFFICIENCY：Token 利用率与 API 成本量化审计（2026-11-14）

完整报告：`docs/AI_TOKEN_EFFICIENCY.md`；开发日志：`log/2026-11-14-ai-token-efficiency.md`。
**未修改生产数据库、未调用真实付费 Provider、未发送真实弹幕、未 Push/Tag/发布。**
测量在 `tests/.tmp` 隔离目录中用合成数据 + Mock Provider 完成；"优化前"数据来自
`git archive HEAD` 导出的未修改仓库副本。

### 0.26.1 Token 归因体系（无 schema 变更）

- 缓存 Token：`normalizeUsage()` 现在解析 OpenAI `prompt_tokens_details.cached_tokens`、DeepSeek
  `prompt_cache_hit_tokens`、Anthropic `cache_read_input_tokens` + `cache_creation_input_tokens`
  （Anthropic 的 `input_tokens` 不含缓存，已按 `input + read + creation` 归一）。
- 推理 Token：`addUsage()` 不再丢弃 `reasoningTokens`，并同时保留缓存与尝试计数。
- 逐请求归因：日志 `ai.request.attempt` 与 `runtime/ai-v13.json` 的 `lastRequest`/`attemptStats`
  记录 job、kind、batch、attempt、model、input/output/reasoning/cached token、`usageSource`、
  `requestBytes`、`estimatedInputTokens`（标注 `estimateSource`）、finishReason、耗时、重试标记。
- 每个 job 的 `ai_jobs.usage_json` 新增 `reasoningTokens`、`cachedInputTokens`、
  `cacheWriteInputTokens`、`attempts`、`unknownUsageAttempts`、`usageReported`；
  `requests` 仍表示"带 usage 的响应数"。
- **无 usage 的请求不再消失**：成功但 Provider 未返回 usage、以及失败的尝试都计入 `attempts`
  与 `unknownUsageAttempts`，token 保持 `null`（不填 0）。用户取消的请求仍不计入。
- 能力测试与翻译：`verifyProviderConfig` 汇总 4–5 个真实请求的 usage 并计价，写入
  `lastTestStatus.usage`（配置 JSON，非 schema）；翻译失败/重试尝试也累计 usage。
- `GET /api/ai/analyze/status` 新增 `efficiency`：`tokenSource`（provider-reported/partial/unknown）、
  `attempts`、`requestsWithUsage`、`unknownUsageAttempts`、`input/output/reasoning/cached`、
  `retryTokens`、`retryShare`、`viewersCovered`、`factsSaved`、`tokensPer100Viewers`、
  `tokensPer100Facts`、`cost`、`costPer100Viewers`、`cachePriced`。

### 0.26.2 发现的真实浪费（实测）

| 浪费 | 实测 |
| --- | --- |
| JSON Schema 同时出现在提示词文本与 `response_format` | 1.5 KiB/请求（画像）、3.9 KiB/请求（单场） |
| 画像提示词内整份输出示例重复两次（同一函数） | 0.7–0.9 KiB/请求 |
| 记忆契约重复 `memory_context.json` 的逐观众 `evidence_seqs`/nickname | 2.7 KiB/请求（稀疏）、3.9 KiB（高密度） |
| 固定 10 观众/批的上限 | 1000 稀疏观众 → 100 请求，固定开销占 33.1% |
| 归因缺口（缓存/推理/无 usage/测试/翻译） | 见 0.26.1 |

### 0.26.3 优化

1. **Schema 只发一次**：仅对 `capabilities.structuredOutputs === true`（实测通过
   `response_format: json_schema`）且 Provider 目录声明支持的 OpenAI/OpenRouter 生效；
   DeepSeek/DashScope/MiniMax/Anthropic/custom 仍收到完整文本 schema。
2. **删除重复输出示例**：只保留 `buildMemoryInstructions()` 内那一份。
3. **契约去重**：`memoryContract()` 只保留规则与 `Cover exactly these refs` 列表；
   逐观众属性以 `memory_context.json` 为唯一权威（excerpt 行仍带 `ref`）。
4. **自适应分批**：`planMemoryViewerBatches()` 新增 `viewerCapHard`（上限 20）；`viewerCap` 变偏好值，
   增长仍受输出预算、摘录上限、内容预算约束。`createViewerMemoryJob()` 未显式传
   `viewersPerBatchHard` 时保持旧的硬上限语义。
5. **UI**：显示推理/缓存 Token、用量来源、重试与补答开销占比、每百观众/每百事实 Token、
   每百观众估算费用；`cost=null` 时明确显示「费用未知（未填价格）」而不是隐藏；
   「已知实际费用」改为「估算费用（Token × 已填价格）」。设置页显示上次能力测试的真实用量。三语同步。

未实施（已在报告 §5.1 说明原因）：压缩 `messages.jsonl`（实测 93.8% 字节是 JSON 结构）、
把观众上限提到 20 以上、任务级时间/费用预算、失败回答加密暂存。

### 0.26.4 优化前后（14 场景，Token 为按实测字节的模拟值）

| 指标 | 优化前 | 优化后 | 变化 |
| --- | --- | --- | --- |
| 总请求数 | 216 | 150 | -30.6% |
| 输入 Token（模拟） | 2,867,221 | 2,560,520 | -10.7% |
| 输出 Token（模拟） | 162,037 | 162,528 | +0.3% |
| 总 Token（模拟） | 3,029,258 | 2,723,048 | -10.1% |
| 请求字节（实测） | 9,274,013 | 8,312,569 | -10.4% |
| 观众覆盖 | 1715/1715 | 1715/1715 | 0 |
| 有效事实 | 1715 | 1715 | 0 |
| 重试/补答 Token | 48,402 | 53,052 | +9.6%（分母变小、单请求变大） |

单场景：大场次 -17.3%、小场次 -14.4%、多语言 -8.1%、both -7.1%、高密度 -2.0%；
单场报告（custom，`json_object`）0.0%（schema 本就只在提示词里，无可删重复）；
单场报告（openai，structured）**-6.1%**。

### 0.26.5 测试

- 新增 `tests/unit/ai-token-efficiency.test.mjs` **12 项**：三类 Provider 的缓存/推理解析、
  未知不为 0、累计与计价（含可选缓存单价）、无 usage 计一次 attempt、attempt 记录标注、
  画像/单场提示词 schema 只发一次、输出示例只出现一次、稀疏观众自适应分批、密集观众不被强行打包。
- `tests/helpers/ai-fixtures.mjs` 新增 `parsePromptMemoryRefs()`；3 个集成测试与 Mock 改用它。
- 6 个既有断言从「写死 10 观众/批」改为从规划器读回批次数量（语义不变，见 §0.26.6）。
- 全量结果见 §0.26.7。

### 0.26.6 未放宽的断言

覆盖、事实、跨观众证据、Resume 只重试失败观众、校验失败不阻塞兄弟批次、完成后 Continue
0 请求、重复事实为 0 —— 这些断言**均未放宽**。只把"批次数=3"这类与规划器实现相关的数字
改为从 job 读回，并新增等价断言（例如"每个计划批次只请求一次"）。

### 0.26.7 全量与正式 EXE

- 全量：**781 passed / 0 failed / 0 skipped（218,884 ms，2026-11-14，`node --test --test-isolation=none
  "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`）**；上一轮 769，本轮 +12。
- 专项：`tests/unit/ai-token-efficiency.test.mjs` 12/12；既有 AI/画像/汇总/翻译/调度/进度套件全部通过。

| 项目 | 值 |
| --- | --- |
| 文件 | `dist/LiveMemory.exe` |
| 大小 | `96,623,616` bytes（92.1 MB） |
| SHA-256 | `178585a6f65bbffa7f657f3ecb9a7e5c7ce1ce954ef3c8570705ea1d131a73a3` |
| buildId | `4a149ca7286e` |
| source hash | `4a149ca7286e435032a6e92d67b5a0952071357c02a1ef3da8ca77e7b36547a7` |
| commit | `649f8192bc6fe53a4957d6c906bcc1e8bf4a212c`（本轮代码提交） |
| builtAt | `2026-11-14T09:44:11.067Z` |
| 资源 | `189` files；20 个必需模块；RT_MANIFEST `asInvoker` |

- EXE 在代码提交**之后**重建，`build-info.commit` 与本轮提交一致；提交前的一次构建得到同一
  buildId 与同一 source hash（`4a149ca7286e`），说明 buildId 只取决于源码内容。
  两次构建的 SHA-256 不同（PE 时间戳等），上表是最终交付二进制。

- `scripts/verify-ai-token-exe.mjs`（**本轮新增**）：**16/16**。正式 EXE + 本地 OpenAI-compatible
  Mock Provider + 隔离数据目录：
  - asInvoker；启动即 `/api/health` 返回同一 buildId；
  - 未认证 `/api/ai/analyze/status` 401；
  - 长期画像分析完成 **40/40 观众、3 批、3 次请求**；
  - usage 落库：输入 **20,893** / 输出 **3,563** / requests 3 / attempts 3；
  - **缓存命中 8,356**（单独记录，不与新输入合并）；
  - `efficiency.tokenSource=provider-reported`、`attemptLedgerTokens=24,456`；
  - 估算费用 **0.019663 USD**、每百观众 **0.049157 USD**、每百观众 Token **61,140**、事实 40；
  - 每个计划批次只请求一次；
  - 便携备份仍可创建（`.livememory` 768,515 bytes）；
  - 完成后重复 Continue **0 请求**；重启后仍 complete 且 token 完全一致；
  - 注入 500：`failed=3`、`unknownUsageAttempts=3`、`attempts 5 vs requests 2`、
    `failedBatches=[2]`；兄弟批次已保存（23/40）；
  - Resume 后 40/40 完成，且**只**重新请求 `-b02`（1 次），已保存批次未重发。
- `scripts/verify-p0-2-exe.mjs`：**13/13**；`scripts/verify-p0-5-exe.mjs`：**12/12**；
  `scripts/verify-exe.mjs`：**10/10**（asInvoker、全新目录、重启、硬杀恢复、端口顺延、单实例、
  不可写目录、异目录、解压复用、CLI 三语）。
- 上述 EXE 矩阵全部针对最终二进制（buildId `4a149ca7286e` / commit `649f819`）运行；AI 专项在
  重建后的同一二进制上复跑仍为 **16/16**。
- **性质**：正式 EXE + 本地 Mock Provider + 合成数据；**不是**真实付费 Provider 验收，
  **不是**真实浏览器点击。


## 0.25 RC0 P0-2：完整备份、恢复与跨电脑迁移（2026-11-14）

完整证据与复现见 `log/2026-11-14-backup-restore-p02.md`；格式规范见 `docs/BACKUP_FORMAT.md`，用户流程见 `docs/BACKUP_RESTORE.md`。**未修改生产数据库；未对真实用户数据执行恢复/覆盖/清空；未 Push/Tag/发布。** 自动化使用 `tests/.tmp` 隔离目录；正式 EXE 使用正式构建 + 临时数据目录。

### 0.25.1 原有能力审计

- 已有 `VACUUM INTO` 数据库应急快照（`maintenance.mjs`），仅数据库、不含设置/长期记忆以外的文件，且不是跨电脑格式；设置页只有危险区快照按钮。
- 已有数据目录迁移（`relocation.mjs`）会连同 `secrets/` 一起复制，属于本机换目录，不是可移植备份。
- 清空/恢复出厂只有“写前快照”，没有恢复入口。
- 旧 `docs/BACKUP_RESTORE.md` 仅设计，`.livememory` 未实现；本轮在其基础上落地，并保留应急快照作为独立能力。

### 0.25.2 备份内容与格式

- `.livememory` v1 = STORE ZIP：`manifest.json` + `database/livememory.db` + `config/settings.json`，只允许这 3 个条目。
- 包含：场次、事件/弹幕、观众身份/映射/昵称、支付与币种合计、长期画像/事实/证据/版本、AI 报告/证据/汇总节点/翻译缓存、AI/记忆任务状态、监控目标、设置、schema。
- 排除：`secrets/`、`config/ai-providers.json`、日志、缓存、runtime、exports、backups、app、数据目录指针；`preferredPort` 也不写入设置。
- manifest 记录格式版本、创建时间、应用版本/buildId/commit、schema、包含/排除原因、行数、数据范围、每个文件的字节数与 SHA-256；`contains_credentials` 必须为 `false`。
- 未来 format/schema 返回独立错误码；加密归档明确拒绝（v1 不支持）。
- 备份未加密；界面明确提示包含观众数据，需妥善保管。

### 0.25.3 SQLite 一致性

- 创建时 `VACUUM INTO` 生成一致快照（包含已提交的 WAL 内容），再 `PRAGMA integrity_check`；不复制正在写入的 `.db`。
- 写入临时文件时再次计算 CRC，防止源文件在两次读取之间变化；之后重新打开临时归档做完整校验（ZIP 结构、CRC/SHA、清单、schema、计数、数据库完整性）。
- 实测：直播采集进行中 + `wal_autocheckpoint=0` + WAL 非空时创建备份，快照事件数位于备份开始与结束时的实时计数之间，快照自身 `integrity_check` 通过，原库保持完整。
- 取消、写入失败、磁盘不足、目标冲突：删除临时文件/暂存目录，原库与已有目标文件不变。
- 目标已存在需 `overwrite:true`，界面二次确认；不会静默覆盖。

### 0.25.4 恢复与崩溃回滚

- 顺序：完整验证 → 冻结写入（`maintenance`）→ 停止采集/AI/翻译/SSE → 关闭数据库 → `backups/pre-restore-*.db` 安全快照 → 暂存目录迁移+完整性检查 → journal → 两次原子改名 → 新库完整性/计数校验 → 应用设置 → `buildRuntime()` 重建运行时。
- `runtime/restore-journal.json` 阶段：`prepared → committing → placed → verified → settings`；启动时在打开数据库前按阶段与文件 SHA-256 决定回滚/提交。
- 实测三个崩溃点：仅暂存（清理并保留原库）、第一次改名后目标缺失（回滚）、两次改名后（提交）；均在 `startServer()` 启动恢复中完成。
- 进程内失败（数据库已切换后注入异常）回滚成功，行数与场次标题恢复原值，HTTP 继续服务。
- 恢复后删除 `runtime/ai-v13.json`；旧数据库连接、SSE、AI 任务与采集状态不再引用被替换的数据；遗留 `live` 场次由启动恢复标记 `interrupted`。
- 设置恢复经白名单校验；不恢复端口、路径指针与任何凭据。
- 恢复成功不需要重启 EXE；界面强制重新加载，并提示重新登录 Bilibili / 重新填写 API Key。

### 0.25.5 文件安全

- 读取端拒绝：ZIP Slip、绝对路径、盘符、UNC、反斜杠、`.`/`..`、控制字符、目录条目、重复名、符号链接、加密条目、data descriptor、ZIP64、非 STORE、压缩炸弹、条目数/单条/总量/归档大小超限、CRC/SHA 不匹配、损坏 SQLite、伪造 format/schema、含凭据清单。
- 资源上限：归档 2 GiB、解压总量 2 GiB、单条目 2 GiB、条目 16、中央目录 4 MiB、manifest 1 MiB、settings 256 KiB。
- 解压目标由程序固定生成于 `runtime/restore-*`，不采用归档条目名作为落盘路径。
- 备份/恢复全部 API 在 P0-5 会话认证之后；无新增无认证端点。
- 维护期间认证先于维护检查：未认证仍 401；已认证的非 job 请求 503；当前 job 进度可读。
- 仅允许本机绝对 `.livememory` 目标/源；拒绝 UNC 网络路径。

### 0.25.6 测试

- 新增 3 个文件 / 24 个用例：
  - `tests/unit/backup-format.test.mjs` 9：STORE 读取、ZIP Slip/绝对/盘符/反斜杠/目录/重复名、符号链接/压缩/data descriptor、压缩炸弹/条目数/大小/总量、CRC 篡改/截断、manifest 未来版本/schema/凭据/加密、设置白名单、目标路径、文件选择器脚本。
  - `tests/unit/backup-ui.test.mjs` 5：设置页真实端点、预览字段、三语键/占位符、全部错误码翻译、无 innerHTML/alert。
  - `tests/integration/backup-restore.test.mjs` 10：完整备份内容、WAL 在线一致、取消、写入失败/磁盘不足/覆盖冲突、损坏/缺失/未来版本/损坏 SQLite/ZIP Slip/炸弹、全新目录恢复（场次/观众/AI 结果/长期事实/设置/无凭据/无旧绝对路径）、重启、重复恢复幂等、恢复中途回滚、journal 回滚/提交、维护期间认证、AI 写入调度并发。
  - `tests/integration/api-auth.test.mjs` 增补：备份 status/create/inspect/restore/jobs/open/pick 未认证 401。
- 全量：**769 passed / 0 failed / 0 skipped（307,126 ms，2026-11-14，`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`）**。
- schema 仍为 16；无数据库迁移；未改金额/身份/去重/AI 语义。

### 0.25.7 正式 EXE

| 项目 | 值 |
| --- | --- |
| 文件 | `dist/LiveMemory.exe` |
| 大小 | `96,594,432` bytes（92.1 MB） |
| SHA-256 | `fa1e8367bed99ce221b1f20d4f0c7efc3eaf492d499d2f39c9014233f2dbf9e6` |
| buildId | `678e8d47b6c6` |
| commit | `489ce070abca24ced6a8287cb4312cc575b24692` |
| builtAt | `2026-11-14T05:34:55.662Z` |
| 资源 | `189` files；20 个必需模块；RT_MANIFEST `asInvoker` |

- 本轮代码提交：`9a23d45`。EXE 在提交前构建，因此 `build-info.commit` 记录构建时 HEAD `489ce07`；`buildId` 由源码内容哈希决定，可用提交 `9a23d45` 重建复现同一 buildId。文档提交在当前代码提交之后。

- `scripts/verify-p0-2-exe.mjs`：**13/13**。正式 EXE 无 UAC 启动；认证后创建备份（约 0.59 MB）；检查摘要（1 场 / 4 事件 / 4 观众 / 1 AI 报告 / 4 长期事实）；恢复到全新绝对目录并服务；`secrets/` 为空；重启后行数与事实逐字节一致；再次备份并通过独立完整校验。
- `scripts/verify-p0-5-exe.mjs`：**12/12**（认证/Origin/Host/SSE/token 不泄漏/重启失效）。
- `scripts/verify-exe.mjs`：**10/10**（asInvoker、全新目录、重启、硬杀恢复、端口顺延、单实例、不可写目录、异目录、解压复用、CLI 三语）。
- **性质**：正式 EXE + 真实 HTTP + 隔离数据目录 + 本机 Python/Node 生成的种子数据；**不是**真实浏览器点击，**不是**真实 Windows 文件对话框点击。

### 0.25.8 边界与待验收

- **真实 Windows 文件选择器点击未验收**：自动化直接向 API 传路径；`pick/save`、`pick/open` 脚本由单测覆盖（base64、无命令注入、取消/错误），但未在真实桌面手动点击。
- **真实浏览器点击/自动打开未验收**：使用与浏览器相同的 HTTP 握手。
- **备份未加密**：包含观众昵称/聊天/AI 报告；用户需自行保管。未实现加密，也不声称加密。
- **不支持两台电脑合并**：重复恢复是整体替换，不是追加；幂等性指“同一备份重复恢复后行数不变”。
- **不支持降级**：未来 format/schema 明确拒绝。
- **同 Windows 用户恶意软件**仍可读取数据目录与备份文件；HTTP 认证与文件校验不能消除该用户级威胁。
- 未使用真实付费 Provider、真实 Bilibili/YouTube 账号进行跨电脑验收；数据来自本地模拟/导入。

### 0.25.9 关闭结论

**P0-2 代码级与正式 EXE 级可关闭**：备份为真正单文件、可验证、可恢复、可跨目录迁移；SQLite WAL 在线一致性、取消/失败/磁盘不足、ZIP Slip/炸弹/超大/损坏/未来版本、恢复回滚与强制终止后的 journal 恢复、凭据排除、旧绝对路径排除、重启与再次备份闭环均有自动化与正式 EXE 证据。真实桌面文件对话框与真实浏览器点击保留为用户待验收，不阻塞代码关闭。

## 0.24 RC0 P0-5：本地 HTTP API 鉴权与 Windows 最小权限（2026-11-14）

完整证据、复现与 P0-2 交接见 `log/2026-11-14-local-api-auth-p0.md`。**未修改生产数据库、未干扰正在采集的直播、未调用真实付费 AI、未 Push/Tag/发布。** 测试使用 `tests/.tmp` 隔离数据；EXE 验证使用正式构建 + 临时数据目录。

### 0.24.1 原始漏洞与实际攻击面

- `src/server/app.mjs` 只校验 Host；Origin 只对非 GET/HEAD/OPTIONS 生效；所有 `/api/*` 没有认证。
- 隔离数据目录实测（修复前）：无凭据 `GET /api/bootstrap`、`GET /api/viewers`、`PATCH /api/settings` 200；`POST /api/simulate/start` 201；`POST /api/sessions/:id/stop` 200；`POST /api/storage/location` 进入迁移处理；`GET /api/events/stream` 返回 `text/event-stream`。
- 伪造 Origin 与 `Origin:null` 的 GET 请求也成功；Host 伪造原本已被 403。
- 发布 EXE 为 `requireAdministrator`，上述请求会以提升后的令牌执行。
- 类型区分：本机任意进程可直接发 HTTP（CORS/SameSite 不能阻止）；恶意网页是浏览器跨站问题；DNS rebinding 由 Host 校验处理；管理员权限放大是第三层问题。

### 0.24.2 认证与授权设计

- 每次启动生成随机 256-bit bootstrap token + session token，仅存进程内存；服务重启全部失效。
- 启动器打开 `http://127.0.0.1:<port>/#lm_bootstrap=<token>`；页面 `js/auth.js` 读取 fragment，`POST /api/auth/session` 交换 `HttpOnly; SameSite=Strict; Path=/` 会话 Cookie；成功后 `history.replaceState` 清除 fragment。
- bootstrap token 一次性、5 分钟过期；session 最多 7 天且随进程失效。**不存在返回 token 的端点**；token 不进入查询串、runtime.json、日志或分析包。
- `/api/health`、`/api/auth/status`、`/api/auth/session` 公开；其他 `/api/*`（含 SSE）必须有效 Cookie。认证失败统一 401 `AUTH_REQUIRED`。
- 所有带 Origin 的请求必须同源；`Origin:null` 拒绝；`/api/*` 拒绝 `Sec-Fetch-Site: cross-site/same-site`；Host 严格限定 `127.0.0.1|localhost|[::1]:<port>`；不返回 CORS 放行头。
- EventSource 与下载 anchor 自动携带同源 Cookie，因此不需要把 token 放进 URL 查询串，也不需要使用自定义 Header。

### 0.24.3 Windows 最小权限

- 逐项审计未发现日常功能需要管理员：`%LOCALAPPDATA%` 写入、`node:sqlite`、导出、PowerShell 文件夹选择、`127.0.0.1` HTTP、Provider 请求、SEA 解压、单实例锁均以普通用户完成。
- 发布 EXE 的 RT_MANIFEST 从 `requireAdministrator` 改为 **`asInvoker`**；构建脚本 patch 前后均断言；删除启动器管理员检查、`admin.mjs`、`adminRequired` 文案与 `LIVE_MEMORY_SKIP_ADMIN_CHECK` 生产绕过。
- 旧版跨管理员账号数据目录的 profile 扫描保留为历史兼容，不作为提权理由。
- 正式 EXE 在 Low Mandatory Level 会话直接启动成功，无需 UAC。

### 0.24.4 测试

- 新增 `tests/integration/api-auth.test.mjs` 14 项、`tests/integration/graceful-close.test.mjs` 1 项、`tests/unit/server-auth.test.mjs` 6 项、`tests/unit/auth-boot.test.mjs` 6 项；`pe-manifest` 增加 asInvoker/构建断言。
- 全量：**745 passed / 0 failed / 0 skipped（270,168 ms，2026-11-14）**。
- 认证专项：14 + 1 + 6 + 6 = 27 项通过。
- Bilibili 专项：**53 passed / 0 failed**。
- 既有集成测试显式 `auth:false` 仅用于进程内数据夹具；HTTP 启用路径由认证专项与 EXE 覆盖。`auth:false` 不能通过 HTTP 或环境变量在生产启用。

### 0.24.5 正式 EXE

| 项目 | 值 |
| --- | --- |
| 文件 | `dist/LiveMemory.exe` |
| 大小 | `96,436,224` bytes |
| SHA-256 | `d3d1ddc1d1b207cd72bb6c6e03a3a07216885a3e2a53ca3bf9f1a5cb48a558ae` |
| buildId | `75588ba16aec` |
| commit | `3d4232704dd9a710ee8c55a1688ec4ff9812821c` |
| builtAt | `2026-11-14T04:33:33.510Z` |
| 资源 | `177` files；RT_MANIFEST `asInvoker` |

- `scripts/verify-p0-5-exe.mjs`：**12/12**。正式 EXE 无 UAC 启动；未认证读/写/危险操作/SSE 401；伪造 Origin/null/恶意 Host 403；fragment→Cookie；认证后核心操作与 SSE 成功；一次性 token 重放 401；token 不在 runtime.json/日志；进程停止后监听关闭；重启旧 Cookie/token 401、新会话可用、数据保留。
- `scripts/verify-exe.mjs`：**10/10**（asInvoker、全新目录、重启、硬杀恢复、端口顺延、单实例、不可写目录、异目录、解压复用、CLI 三语）。
- `scripts/verify-youtube-lifecycle-exe.mjs`：**通过（180,934 ms 断连 → 同一 session 恢复 → 去重 5/5 → platform_ended）**。
- **性质**：正式 EXE + 真实 HTTP + 隔离数据目录；不是真实浏览器点击，也不是真实桌面 Ctrl+C。

### 0.24.6 边界与待验收

- **真实浏览器自动打开/点击**未验收；自动化使用与浏览器相同的 HTTP 握手。
- **真实 Ctrl+C/关闭命令行窗口**未验收；Windows 关闭窗口直接终止，源码 `server.close()` 由 graceful-close 测试覆盖。
- **真实 UAC** 不再适用（asInvoker）；本机低完整性会话启动成功是普通权限证据。
- **同 Windows 用户恶意软件**仍可读浏览器 Cookie/资料、注入浏览器或抓取启动 URL；HTTP 认证无法防御，见 PRIVACY_SECURITY §31。
- **Cookie 非 Secure**：回环 HTTP 限制；仅对当前 `127.0.0.1:<port>` 生效。
- **数据目录 ACL** 未强制收紧；共享/同步目录仍可能被其他可访问账户读取。
- **Bilibili/YouTube/AI 真实平台/真实付费 Provider** 未新增长时或付费验收；使用既有 Mock/假服务与本地测试数据。

### 0.24.7 关闭结论

**P0-5 代码级与正式 EXE 级可关闭**：原始漏洞已实际复现；认证/Origin/Host/SSE/危险操作/重启失效/多页面/Key 不泄漏均有自动化与 EXE 证据；EXE 已 asInvoker 并通过 10 项功能矩阵。真实桌面交互、真实平台与同用户恶意软件边界保留为已知限制与用户待验收，不阻塞代码关闭。

## 0.23 RC0 P0-4：YouTube 暂时性故障误判结束（2026-11-14）

完整证据与复现见 `log/2026-11-14-youtube-lifecycle-p0.md`。**未修改生产数据库、未干扰正在采集的直播、未调用真实付费 AI、未访问真实 YouTube 进行长时断网测试。** 自动化使用 `tests/.tmp` 隔离数据与本地假 YouTube 网页；真实网络级断网与正式 EXE 验证结论见 §0.23.5。

### 0.23.1 原始故障与根因（已确认）

- `src/platforms/youtube/anonymous/parser.mjs`：HTTP 200 但缺少 `continuationContents` 时返回 `ended:true, invalid:true`；adapter 直接 `#finish('chat_ended')`，把空响应、异常结构和真实结束混为一谈。
- `src/platforms/youtube/anonymous/adapter.mjs`：429/网络/5xx 连续 8 次后调用 `#finish('connection_failed')`，`SessionManager` 因而结束 `sessions` 行；暂时性故障被写成直播结束。
- 适配器只根据一次观看页 `state='ended'`（或 `'video'`）立即结束，没有二次确认；`onEnd` 触发后也没有 generation 失效保护。
- stale continuation 在 `openChat` 刷新失败后继续 poll 同一个失效 token，形成“假装恢复”的重复请求。
- 解析器对“有 actions 但没有新 continuation”的响应当作成功并复用旧 token，页面无法推进。
- `docs/PLATFORM_INTEGRATIONS.md` 声明网络/5xx 退避且不结束，与实际“8 次后结束”相反；相关错误文案仍建议使用已删除的官方 API。

### 0.23.2 修复

- **解析器**：缺少 `continuationContents` / `liveChatContinuation` / 新 continuation token 一律返回 `invalid:true, ended:false`，并记录 `invalidReason`；不再从“缺失”推断结束。若异常页仍带可读 actions，先入库再由 EventIngest 去重。
- **连接状态**：429/5xx/网络/异常 200 只进入 `reconnecting`；连续失败达到阈值进入 `failed`（`retrying/recoverable/sessionPreserved=true`），继续指数退避（上限 60 秒；429 至少 30 秒并尊重 `Retry-After`），**不再调用 `onEnd`**。
- **结束判定**：观看页 ended → 约 2 秒后再读一次仍 ended → `platform_ended`；聊天页明确 ended/disabled → 观看页 ended 或第二次聊天页相同结果 → `chat_ended`/`chat_disabled`。仅一次 ended 读取、`state='video'`、网络失败、不可读观看页都不会结束。
- **确认期间**：观看页显示 `platform_status=ending`，UI 显示「正在确认下播」；确认失败恢复为 live/unknown，不伪造结束。
- **continuation 恢复**：`WEB_STALE` 只标记失效；下一次轮询先 `openChat` 取新 continuation，失败则退避重取，不再 poll 旧 token。
- **session 连续性**：适配器从不创建/替换 session；重连沿用同一 adapter、session、continuation 与 EventIngest 去重键。每个 adapter 只有一个 poll timer、一个结束确认 timer、一个元数据请求。
- **UI**：`reconnecting`/`failed(可恢复)` 显示「重连中」/「连接中断，自动重试中」、最近一次故障与「采集尚未结束：已采集的聊天、观众和时间线都已保留」；只有确认结束才显示已下播。新增三语文案与历史结束原因（聊天结束/聊天关闭）。
- **Bilibili 未改动**：共享 `SessionManager`/`EventIngest` 未改；新增测试只驱动 YouTube adapter。Bilibili 现有生命周期测试全部通过。

### 0.23.3 修复前复现与修复后测试

- 修复前运行新增 `tests/unit/youtube-lifecycle-regression.test.mjs`：**7/8 失败**。具体为连续 429、连续网络失败、500/502/503、缺 `continuationContents`、多种异常 200、stale token 复用、单次观看页 ended/`video` 均触发 `onEnd`；只有用户停止用例通过。
- 修复后新增/更新：
  - `tests/unit/youtube-lifecycle-regression.test.mjs` **10 项**：10 次 429、12 次网络失败、9 次 5xx、缺 continuationContents、6 种异常 200、stale token 重取、单次 ended 不成结论、两次 ended 只结束一次、聊天 ended 二次确认、用户停止。
  - `tests/integration/youtube-lifecycle.test.mjs` **2 项**：假 YouTube 网页 + 真实 HTTP/SessionManager/SQLite，验证 429/500/异常 200 期间同一 session 保持 live、消息/观众不丢、恢复后继续采集且去重、明确 ended 只结束一次；用户停止立即结束且保留数据。
  - `tests/unit/youtube-anonymous-parser.test.mjs` 更新：缺 `continuationContents` 断言为 invalid 而非 ended。
  - 既有 `youtube-anonymous-session`、`youtube-auto-monitoring`、`live-api-multi` 已改为“异常 200 + 观看页 ended”的真实形状，而不是依赖 `{}` 直接结束。

### 0.23.4 全量与 EXE

- 全量：**721 passed / 0 failed / 0 skipped**（2026-11-14，192,929 ms，`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`）。
- 正式 EXE：buildId `59b7928cb78a` / commit `31886b2` / SHA-256 `e9fe576931a0562a7969afa3bba188a3418b95374ca68c2d75d09bc6d8805b2f` / 96,419,840 bytes（92.0 MB）/ 176 assets / `requireAdministrator`。
- **EXE + 本地假 YouTube 回放**（asInvoker 测试副本，仅测试设置 `LIVE_MEMORY_SKIP_ADMIN_CHECK=1` 与 `LIVE_MEMORY_TEST_YOUTUBE_WEB_BASE=http://127.0.0.1:<port>`）：
  - 正常采集 3 条消息 / 2 位观众；随后关闭假 YouTube 服务 **180,513 ms**（3 分钟真实 TCP 断连）。
  - 断连期间 `session` 始终 `live`，消息数保持 3，未生成第二个 session，未触发结束。
  - 恢复后同一 session 继续到 4 条；强制 stale continuation 重开聊天页并重放 `msg-1`，事件行 5 / 内容唯一 5，无重复。
  - 观看页 ended + 异常 200 → `platform_ended`、`platform_status=ended`，结束前后计数一致，房间仅 1 条 session。
  - 结论：**正式 EXE + 本地 Mock 服务通过**，但**不是**真实 YouTube 网络断网，也**不是** UAC 双击/真实浏览器点击。

### 0.23.5 边界与待验收

- **真实网络级断网未验证**：未在真实 YouTube 直播上拔网/切网 3 分钟；自动化使用可控假 HTTP 故障。
- **真实 YouTube 长直播/429/验证码/consent 未验证**：本轮不发送真实平台高频请求，也不绕过限流。
- **未验证真实 UAC 双击与真实浏览器点击**：EXE 验证使用 asInvoker 测试副本与本地假 YouTube。
- 平台若把真实结束表现为“200 空响应 + 观看页仍短暂 live”，会先留在重连状态，待观看页更新后结束；这是刻意的保守行为。

### 0.23.6 正式构建标识

| 项目 | 值 |
| --- | --- |
| 文件 | `dist/LiveMemory.exe` |
| 大小 | 96,419,840 bytes（92.0 MB） |
| SHA-256 | `e9fe576931a0562a7969afa3bba188a3418b95374ca68c2d75d09bc6d8805b2f` |
| buildId | `59b7928cb78a` |
| commit | `31886b2d59873b574d3fb1703a0d592396ce42c7` |
| builtAt | 2026-11-14T03:28:37.819Z（11:28:37 +08） |
| 资源 | 176 files；12 个必需模块；RT_MANIFEST `requireAdministrator` |
| source hash | `59b7928cb78ab52355f9e328a39e384a725b4fd2be83aa9503288dfad61086aa` |

## 0.22 RC0 P0-1：AI 定向补答回归修复（2026-11-14）

完整证据、复现与 P0-4 交接：`log/2026-11-14-ai-memory-supplement-p0.md`。**未修改生产数据库、未 Resume 真实生产任务、未调用真实付费 API、未干扰直播采集。** 自动化使用 `tests/.tmp` 隔离数据 + Mock Provider；真实数据只读副本 + Mock 回放见 §0.22.4。

### 0.22.1 原始故障与根因（已确认）

- 上一轮 RC0 审计 P0-1 原始结论：首答漏一位观众时，`generateMemoryAnswer()` 构造只含缺失 ref 的定向补答，但补答回来后调用 `evaluate(repaired.content)` 时**没有传补答 prompt/onlyRefs**，于是按全量 refs 组装。补答必然被判“首答已覆盖的观众缺失”，整批抛 `AI_IMPORT_INVALID`。
- 已存在但全仓库无调用者的 `mergeMemorySupplement()` 本应合并首答与补答；旧代码在补答 `assembled.ok=false` 时直接抛错，首答中已合法的观众被丢弃，也不走 `#salvageMemoryViewers()`。
- 结果：模型漏写 1 位观众这种常见行为会使该批次永久无法完成；每次 Continue 重新发送首答 + 补答 2 个付费请求且不收敛。
- 同路径独立缺陷：`buildTargetedMemoryPrompt()` 只发送缺失观众的 `evidence_seqs`，未发送 `viewer_excerpts.jsonl`，补答模型看不到真实聊天文本。
- 本轮修复前用新增集成用例复现：`status=failed`、`memoryCoverage.covered=0`、`AI_IMPORT_INVALID / MEMORY_VIEWER_UPDATE_MISSING`、`usage.requests=2`、`savedResults=0`。

### 0.22.2 修复

- **补答按缺失子集校验**：补答使用 `subsetPrompt(missingEntries)` 组装/校验，不再用全量 refs。
- **合并首答**：补答完整且合法时调用 `mergeMemorySupplement()`，将两份 compact answer 按 ref 合并，再走一次完整 `validateAnalysisImport()`；ref 齐不跳过 Schema/身份/证据/覆盖校验。
- **首答兜底**：补答仍缺失、返回错误观众、非法 JSON、空响应、截断、Provider 错误或定向提示词超输入上限时，保留首答中每个单独合法的观众；只把仍缺失的观众写入 `viewerFailures`（`status=failed`），Resume 只请求这些观众。补答中的跨观众证据/非法条目不会被导入。
- **补答证据正文**：`buildTargetedMemoryPrompt()` 只附带缺失观众的 `viewer_excerpts.jsonl`，按 stable `viewer_id` 过滤并注解 ref；其他观众正文不重发。
- **统计**：补答空/截断计入 `outputStats`；部分保存日志 `ai.analysis.memory.supplement.partial`；合并日志 `supplement.merged`；失败日志 `supplement.failed/too_large`。
- 未改 schema（仍 16）、结果 Schema（1.3.0）、提示词版本（v13.2）、Provider/调度/翻译/汇总/金额/身份/去重规则。

### 0.22.3 自动化测试

- 新增 `tests/integration/ai-memory-supplement-regression.test.mjs` **10 项**：
  1. 首答漏 1 人 + 补答完整 → 2/2、双事实、2 请求、完成后重复 Continue 0 请求；
  2. 补答返回错误观众 → 首答保存、只剩缺失观众 failed，Resume 只请求它并完成；
  3. 首答完整 → 0 补答、1 请求；
  4. 补答只返回部分缺失观众 → 两份答案的合法观众都保存；
  5. 补答含跨观众证据 → 拒绝该观众、首答保留、重试完成；
  6. 补答重复事实 → 引擎去重只写 1 条；
  7. 补答非法 JSON → 首答保留、可恢复；
  8. 补答空 + `length` → 首答保留、不重发首答、可恢复；
  9. 重启后 Resume → 只请求失败观众，旧 `ai_results.result_json` 与旧事实不变；
  10. 3 批并发、1 批补答非法 → 兄弟批次完成，Resume 只补 1 人，30/30，事实不重复。
- 全量：**708 passed / 0 failed**（2026-11-14，186,397 ms，`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`）。

### 0.22.4 EXE 与真实数据只读副本回放

- **正式 EXE**：`dist/LiveMemory.exe` buildId `e441070b57b5` / commit `81be9cd` / SHA-256 `27c0bfbe9227ed15693370c999df0fda7d3d39ffafbffc0b7b9c2ab2a9eb6e58` / 96,401,408 bytes（91.9 MB）/ 176 assets / `requireAdministrator`。
- **隔离回放**（asInvoker 测试副本，仅测试设置 `LIVE_MEMORY_SKIP_ADMIN_CHECK=1`；生产数据只读副本；本地 OpenAI-compatible Mock Provider）：
  - 会话 `ses_01M7ACPCM8YB56VCV82S`，新建 memory job `aij_01M7BZPKAJ8WMYGZA8BS`，89 位观众 / 9 批。
  - 第一次运行：Mock 在批次 2 首答故意漏 1 位观众，补答返回非法 JSON。结果 `partial`、88/89、8/9 批、10 次请求；批次 2 的 `bilibili:335118245` 为 `failed`；错误同时记录 `MEMORY_VIEWER_UPDATE_MISSING` 与 `AUTO_INVALID_JSON`；首答其余 9 位观众已保存。
  - 关闭 EXE 后重启同一数据目录：`/api/health` 返回同一 buildId/commit；状态仍为 `partial`、`canResume=true`、88/89。
  - `POST /api/ai/analyze/resume`：只请求 1 次、仅 1 位失败观众；完成 `complete`、89/89、9/9、requests 10→11；没有重发批次 1/3–9。
  - 旧数据：回放前 503 条 `ai_results` 全部保留；事实 1,007→1,095→1,096；新 job 10 条结果（9 个 v1 + 批次 2 的 v2）；89 条新事实；`memory_facts` 按 `(viewer_id, dedupe_key)` 无重复；89 位观众全部 `semantic`。
  - 再次 Resume：`complete`、`canResume=false`、Provider 请求数仍 11（0 请求）。
- **性质**：这是“正式 EXE + 生产数据只读副本 + Mock Provider”的确定性回放，不是真实付费 Provider 验收，也不是生产任务 Resume。未修改生产数据库/未自动 Resume 生产任务。

### 0.22.5 影响、边界与关闭结论

- 无数据库迁移、无历史数据回填；已保存 `ai_results` / `memory_facts` / `viewer_memories` 不变。
- 已完成任务再次 Continue 仍为 0 请求；部分任务只处理 `pending/failed` 观众。
- **P0-1 代码级可关闭**：根因确认、失败可复现、修复后 10/10 回归 + 708/708 全量通过。
- **待验收**：真实付费 Provider 的补答质量、真实生产任务 Resume、真实 UAC 双击、真实浏览器点击。未调用真实付费 API，不声称真实验收完成。
- 下一轮 P0-4（YouTube 暂时失败被误判结束）交接见 `docs/HANDOFF.md` 与日志 §11。

## 0.21 v0.13.2 长期画像输出截断、Provider 空响应与观众级断点恢复（2026-11-13）

完整证据与根因：`log/2026-11-13-ai-memory-output-recovery.md`。**未修改生产数据库、未 Resume 生产任务、未调用真实付费 API、未干扰直播采集。** 只用生产数据只读副本 + 本地 Mock Provider 验证。

### 0.21.1 真实根因（已确认）

- 任务 `aij_01M7AJ05B5E2VRG9Z82G`（`ses_01M77TP9QYPFRE4H9NCH`，DeepSeek Flash，zh-CN）：100 批、975 位观众；17 条成功结果（批次 1–11、13–18），批次 12 的 10 人 pending，剩余 822 人 pending。
- 批次 12 失败为 `PROVIDER_RESPONSE_INVALID` / `empty-content`，HTTP 200，`receivedOutput=false`，耗时 34.5 秒，`retry=false`；批次 4 更早也以同样方式失败（514 条消息/9 人），用户点击继续后成功。说明不是批次 12 特别大导致的确定性超限。
- 适配器在空文本时直接抛 `PROVIDER_RESPONSE_INVALID`，并在抛错前丢弃 `finish_reason`、reasoning 与 usage；`finish_reason=length` 无法被识别为截断，且 `invalid_response` 不自动重试（`retried=0`）。
- 界面显示的“模型结束原因 length”来自 13:35:54 的单场最终汇总 `lastOutputRejection`（`kind=session-aggregate`），被跨阶段显示；批次 12 的错误本身 `finishReason=null`。因此它是陈旧值，不是批次 12 的真实结束原因。批次 12 是否确实返回 `length` 未持久化，属于推测；33–35 秒空流与 reasoning 占满输出预算的行为一致。
- 批次规模算法只考虑输入 token；`generateMemoryAnswer()` 对所有批次固定 6,000 输出。Schema 允许 40 操作/50 证据，提示词没有事实上限。这是结构缺口；本任务已保存批次的真实输出只有 1.1–3.2 KB，所以不是本次 b12 的直接原因。
- 17 个成功批次是并发乱序完成：b12 失败时 b13–18 已在途并完成，程序没有按序号回滚。
- 恢复原本已按 `ai_job_memory_viewers.status` 过滤 pending/failed 观众；但进度把“存在任意子结果”当作批次完成、没有持久化原批次→子批次映射、没有输出截断恢复路径；`elapsedMs=null` 被显示为 0。

### 0.21.2 修复

- **输出预算/动态分批**：`estimateMemoryViewerOutputTokens()` + `resolveMemoryOutputTokens()`（基础 6,000、上限 8,192、受 context 收缩）；`planMemoryViewerBatches()` 同时按输入与预期输出分批；单观众超输出份额时独占一批。包 `batch_plan` 记录 `output_budget_tokens` / `estimated_output_tokens` / `max_facts_per_viewer`。
- **提示词**：三语新增每位观众每次最多 12 条高价值事实、每条事实通常 1–3 条同一观众证据；不静默丢弃已通过校验的事实。
- **错误分类**：`finish_reason=length` → `AUTO_OUTPUT_TRUNCATED`（即使内容为空）；无文本且非 length → `PROVIDER_RESPONSE_EMPTY`，自动重试 1 次；适配器保留 finishReason/reasoningChars/usage/metrics；失败响应的 usage 也计入 job。
- **有界恢复**：空响应重试 1 次；截断/仍空时按观众组对半拆分，最多 2 层；单观众仍截断仅一次把预算提到 8,192；连续 3 个输出失败批次停止调度。不重发相同大请求，不无上限增加 token。
- **断点恢复**：schema 16 `ai_job_memory_viewers.split_path/split_reason`；拆分映射事务写入；恢复按 `(batch_index, split_path)` 只取 pending/failed；成功子结果立即导入；计划批次进度按全部观众覆盖计算，不再以任意结果计完成。
- **统计/UI**：`recoveryStats`（autoRetries/truncations/emptyResponses/splits/subBatches/budgetBumps）、`outputStats` 新计数；`lastOutputRejection` 绑定 Job；技术详情区分截断/空响应并显示 splitPath；恢复面板三语文案区分原因；`elapsedMs=null` 不再显示 0。
- 三语 i18n、AI_CONTRACT §25、DATA_MODEL §19、TEST_PLAN §36 已更新。

### 0.21.3 真实数据只读副本回放（Mock，不联网）

- 开始：`partial`、`resume-memory`、17/100 批、153/975 人、822 pending。
- 只请求批次 **12、19–100**；批次 1–11、13–18 一个未重发。
- 批次 12 首次 Mock 返回空内容 + length → 自动拆为 `12.1`/`12.2`，两子批次成功。
- 结束：`complete`、100/100、975/975、pending 0、failed 0、facts 252、splits 1（2 子批次）、85 次请求（83 个待处理批次 + b12 的 2 个额外拆分请求）。
- 17 条旧 `ai_results` 的 id/version 全部保留；结果 17→101。
- 再次/第三次继续：0 次 Provider 请求，结果/事实/观众行不变；关闭重开后再继续仍 complete。

### 0.21.4 测试与 EXE

- 全量：**698 passed / 0 failed**（2026-11-13，约 188 秒，`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`）。
- 新增：`tests/unit/ai-adapter-output.test.mjs` 3 项；`tests/unit/ai-token-batching.test.mjs` 4 项；`tests/integration/ai-memory-output-recovery.test.mjs` 9 项（含 975/975、异常多消息观众、批次 2 失败/1&3 已保存、重复继续幂等）。
- 迁移断言更新到 schema 16，新增 split 列断言。
- **EXE**：`dist/LiveMemory.exe` buildId `4b697b2cb227` / commit `ab32386` / SHA-256 `de9ddc18d6856a8d79df56673ac4e6fff76d56ccd15521020860247631855b44` / 91.9 MB / 176 assets / `requireAdministrator`。
  - asInvoker 测试副本 + 本地 Mock Provider + 生产数据副本：`/api/health` 同 buildId/commit；`/api/status` schema 16；旧任务显示 `17/100`、`153/975`、`resume-memory`、`canResume=true`、`lastFinishReason=null`；
  - `POST /api/ai/analyze/resume` 后 `complete`、`100/100`、`975/975`、85 次 Provider 请求、b12 自动拆 `12.1/12.2`、旧 17 条结果保留、facts 252。
  - 未验证：真实付费 DeepSeek、真实生产任务 Resume（需用户授权）、真实 UAC 双击、真实浏览器点击。

### 0.21.5 用户安全继续步骤

1. 完全退出 LiveMemory，备份整个数据目录（不要在运行时复制写入中的 SQLite）。
2. 替换为包含本轮修复的 EXE；设置页「关于」核对 buildId。
3. AI 分析中心选择该场次：应显示 17/100 批、153/975 人、822 待处理、「继续未完成画像」。
4. 点击继续；只处理批次 12 与 19–100 的待处理观众，不会重发 1–11、13–18 或已保存的 153 人。
5. 若 Provider 返回空内容，自动重试 1 次；若输出截断，自动拆批次或提高单观众预算；最终仍失败则保留按钮，技术详情显示真实代码/批次/子批次路径。
6. 不要新建整场分析、不要清空数据、不要删除已保存批次。


## 0.20 v0.13.2 可扩展分层汇总与真实 32 批恢复（2026-11-13）

完整证据与根因：`log/2026-11-13-ai-hierarchical-aggregate.md`。**未修改生产数据库、未 Resume 生产任务、未调用真实付费 API、未干扰直播采集。** 只用生产数据只读副本 + 本地 Mock Provider 验证。

### 0.20.1 真实根因（已确认）

- 任务 `aij_01M7AD29G42TSN0DCFXA`（`ses_01M77TP9QYPFRE4H9NCH`，DeepSeek Flash，zh-CN）：32/32 批次已保存，final 缺失。
- 失败在 `session_aggregating`，错误 `ANALYSIS_AGGREGATE_TOO_LARGE`，详情 `estimated 64471 input tokens, limit 48000, batches 32, aggregate output 16000`。
- 这 **不是模型上下文超限**：该配置的 `contextLength` 为 `null`，程序使用旧的硬上限 `MAX_AGGREGATE_INPUT_TOKENS=48000`；真实 batch results 压缩后 64,471 token，因此请求在发出前就被程序拒绝。日志中没有该任务的 aggregate 请求。
- 原算法把所有 32 个批次结果塞进 **一个** final 请求，只在装不下时做一次 compact；compact 后仍 64,471 > 48,000，于是直接失败。累计输入 1,123,093（任务级 usage）不等于单次汇总输入；任务是 37 次成功请求（32 批 + 5 次批次修复），单次汇总从未发生。
- 旧恢复逻辑把 `ANALYSIS_AGGREGATE_TOO_LARGE` 归入 `change-model`，导致 32/32 已保存的任务没有可用的「继续最终汇总」。

### 0.20.2 新算法

- **预算**：`resolveAggregateContextBudget()` 优先使用配置的 `contextLength`；未知时使用保守的 64,000 token 请求预算（不是声称模型只有 64k）。单请求输入上限 = 上下文 − 输出预留 − 500，且不超过 192,000；未知 context 下 digest 输入约 55.5k、final 输入约 47.5k。
- **动态分组**：`groupBatchesContiguously()` 按真实 JSON token 估算切分连续区间，而不是固定批次数；每片最多 72 个 batch（12 topic × 6 ref 的覆盖能力），单组超预算时自动二分。
- **分层**：leaf 节点（批次→有界局部汇总）→ 需要时继续上层节点 → final。`MAX_AGGREGATE_DEPTH=6`，final 前最多 24 个 unit；超过则继续加层，而不是失败。
- **有界局部汇总**：`DIGEST_AGGREGATE_LIMITS`（topics 12、sentiment 8、disputes 6、highlights 6、summary 800、refs 6），只保留关键话题、时间线、情绪、事件、回看片段和有效证据索引；不重复完整原始 JSON。
- **独立持久化**：schema 15 新增 `ai_aggregate_nodes`（job/session/level/node_index/source_hash/covered_batches/digest/usage/coverage/fallback）。节点通过 source hash 复用；重启/重试只补缺失节点，不重做已完成节点。
- **确定性校验**：每级检查 `covered_batches`、unit/batch 覆盖、证据 ref 必须来自该批次已保存结果、时间顺序、事件去重；final 对 ≤144 批次逐批检查，并在证据被过滤后从已保存结果补回真实 ref（不伪造）。
- **有界重试**：截断/结构错误最多 2 次输出尝试（第二次使用 TIGHT caps）；仍失败则用已保存批次/局部汇总生成确定性兜底节点。Provider 错误不兜底，保留可恢复状态。
- **恢复**：`ANALYSIS_AGGREGATE_TOO_LARGE` 不再要求换模型；32/32 已保存时提供 `resume-aggregate`。旧任务在同一个 job、同一批结果上直接进入新分层流程。
- **统计**：每个节点保存 usage，`aggregate.requests/inputTokens/outputTokens` 与任务 `usage` 都包含额外请求；不会把汇总请求漏计。
- **UI**：AI 中心显示分层节点进度；确定性兜底明确提示；恢复面板文案改为「只处理未完成 final/局部汇总，不重新分析已保存批次」。
- **AUTO_OUTPUT_TRUNCATED**：原有独立 12k–16k 输出预算与有界 schema 仍在；本轮新增一次有界重试，第二次仍截断时确定性兜底完成，不再让任务永久失败。

### 0.20.3 真实数据与 EXE 验证

- 生产 DB/runtime/exports 只读副本（schema 14→15）：原任务 32/32 批次、0 次批次重发；2 个局部节点 + 1 次 final；完成，final 引用 32/32 批次；节点 usage 计入任务统计。
- **正式 EXE 重建**：`dist/LiveMemory.exe` buildId `68b663eec6fe` / commit `1070261` / SHA-256 `39562ce976ae…` / 91.9 MB / 176 assets / `requireAdministrator`。
- asInvoker 测试副本（仅测试 `LIVE_MEMORY_SKIP_ADMIN_CHECK=1`）+ 本地 Mock Provider + 生产数据副本实际启动：`/api/health` 返回同一 buildId；`/api/ai/analyze/status` 对旧任务显示 `resume-aggregate`；点击 Resume 后 `complete`、32/32、2 个节点、3 次汇总请求、final 引用 32/32，未重发任何 batch。
- 未验证：真实付费 DeepSeek 的 32 批分层请求质量、真实 UAC 双击、真实浏览器点击（沙箱仍阻止浏览器命名管道）。

### 0.20.4 测试（本轮实测）

- 全量：**683 passed / 0 failed**（2026-11-13，`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`，约 163 秒）。
- 新增：
  - `tests/unit/ai-hierarchy.test.mjs`（10）：预算/未知 context、1/8/18/32/64/128 分组、超预算拆分、三语 digest prompt、final partial prompt、确定性 digest 覆盖/上限、缺失批次与伪造 ref 拒绝、32 批 final、去重/排序、TIGHT schema。
  - `tests/integration/ai-hierarchy.test.mjs`（3）：32 批真实形状分层 + final 失败后重启恢复（节点逐字节复用、0 batch/0 digest 重发、只发 final）；单组截断只重试该组；64/128 批请求数量上限。
  - `tests/integration/ai-aggregate-recovery.test.mjs` 重写（3）：截断一次有界重试后完成、Provider 硬错误重启后只续 final、无效汇总计入 rejected 并确定性完成。
- 更新：schema 14→15 断言、`v14-session-batching`/`v14-task-budget` 的 final 覆盖答案、`ai-recovery-state` 的 aggregate-too-large 语义。

### 0.20.5 用户安全恢复步骤

1. 完全退出 LiveMemory，备份整个数据目录（不要在运行时复制写入中的 SQLite）。
2. 替换为 buildId `68b663eec6fe` 的 EXE；设置页「关于」核对。
3. AI 分析中心选择该场次：应显示「AI 分析未完成」、32/32 批次、最终汇总失败、「继续最终汇总」。
4. 点击继续；只执行分层局部汇总 + final，不会重发 32 个 batch。
5. 成功后 final 保存、任务 complete；若局部汇总仍被截断，程序会做有界重试并用已保存结果确定性兜底，不应新建整场分析或清空数据。

## 0.19 v0.13.2 最终汇总截断与「继续最终汇总」恢复（2026-11-13）

完整证据与根因：`log/2026-11-13-ai-aggregate-recovery.md`。**未修改生产数据库、未 Resume 生产任务、未调用真实付费 API、未干扰直播采集。** 只读检查了生产 `runtime/ai-v13.json`、日志与数据库副本。

### 0.19.1 真实故障结论（已确认）

- 任务 `ses_01M77TM1Q80HQ4XSZTMV` / `aij_01M79KZEFWBCCJP8G1JK`：dashscope `qwen3.7-flash`，18 批全部保存，final 缺失。
- 汇总请求：`maxTokens=8000`、`maxCompletionTokens=24000`、`estimatedInputTokens=34048`、耗时 199,729ms；Provider 返回成功但 `finish_reason=length` → `AUTO_OUTPUT_TRUNCATED`。
- 输入 34k 低于 48k 上限，**不是输入超限**；根因是汇总沿用了普通批次的 8k 输出预算，且汇总提示词/Schema 没有限制输出条数与长度。
- 20 次请求全部 HTTP 成功（18 批 + 1 次批次修复 + 1 次汇总）；失败发生在请求之后的完整性检查，所以旧统计显示 20/20 成功。
- `batchIndex:null` 被 `Number(null)===0` 持久化为 `batchIndex:0`；旧任务/旧库存在假的“批次 0”。
- 旧前端只有与暂停共用的泛化「继续」ghost 按钮；没有「最终汇总」专属恢复状态、准确操作名或“不会重做 18 批”的说明。用户报告看不到该按钮；本轮确认的产品缺口是缺少明确、可验证的汇总恢复入口（后端当时 `canResume=true`，未复现隐藏按钮的具体渲染路径）。

### 0.19.2 修复

- **独立汇总输出预算**：`resolveAggregateOutputTokens()` = `clamp(ceil(batchResultTokens*0.6)+3000, 12000, 16000)`，再按已知上下文收缩；DashScope 的 `max_completion_tokens` 为回答预算 + 16k。18 批上限 16k，不再固定 8k；有界 schema 的实际文本远低于 16k。
- **有界汇总契约**：汇总专用 schema（topics ≤24、sentiment ≤12、disputes ≤8、highlights ≤8、每条 message_refs ≤4，移除 viewer_profiles）；三语提示词明确合并优先、输出上限、覆盖全部批次；compact 第二遍只降低每批条数，不丢批次/证据。
- **恢复状态**：新增 `src/ai/tasks/recovery.mjs`，只依据数据库真实结果计算 `aggregate/session/memory/config`、`resume-aggregate` 等动作与 `canResume`。18/18 已保存且 final 缺失时只提供「继续最终汇总」；输入装不下时提供 `change-model` 且 `canResume=false`。
- **幂等恢复**：`resume()` 在 complete 时直接返回；重复点击不创建任务、不请求 Provider；继续只发缺失的 final，不重发 18 批。
- **batchIndex**：统一 1-based，0/负/null 归一为 null；`recordJobFailure`、状态读模型与失败批次列表都不再出现批次 0；旧数据读取时兼容。
- **UI**：AI 中心新增独立恢复面板（标题、已保存/未完成、原因、[继续最终汇总]、[查看技术详情]、不会重做已保存批次的说明）；按故障显示继续未完成分析 / 继续最终汇总 / 继续未完成画像 / 前往设置更换模型；页面刷新与服务重启后从 `/api/ai/analyze/status` 恢复。
- **统计**：`outputStats.responses/rejected/lastFinishReason`；界面区分「API 请求成功」与「输出未通过完整性/结构校验」「已保存分析结果」，并解释 API 成功 ≠ 分析完成。

### 0.19.3 测试（本轮实测）

- 全量：**668 passed / 0 failed**（2026-11-13，`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`，约 130 秒）。
- 新增：
  - `tests/integration/ai-aggregate-recovery.test.mjs`（2）：18 批 + 截断、重启后恢复只发汇总、18 条结果 checksum 不变、重复点击幂等、无效汇总统计口径。
  - `tests/unit/ai-aggregate-budget.test.mjs`（5）：预算上下限、上下文收缩、DashScope headroom、有界 schema、三语提示词覆盖全部批次、compact 保留证据。
  - `tests/unit/ai-recovery-state.test.mjs`（8）：aggregate/session/memory/config 恢复、完成/乱序/无任务、单批、pending viewer。
  - `tests/unit/ai-recovery-ui.test.mjs`（4）：独立恢复面板、真实 resume API、三语键与文案一致、无 innerHTML/alert。
- 隔离 EXE：`dist/LiveMemory.exe` 已重建（buildId `61da4c6991e1`、commit `205db74`、SHA-256 `7231c056…`、91.8 MB、174 assets、Manifest `requireAdministrator`）。用 asInvoker 测试副本（仅测试用 `LIVE_MEMORY_SKIP_ADMIN_CHECK=1`）实际启动：`/api/health` 返回同一 buildId/commit、`mode=packaged`、`verified=true`；`/api/bootstrap` 返回 schema 14；打包后的 `js/pages/ai.js` 与三语字典包含 `recoveryPanel`/「继续最终汇总」；对生产 DB/runtime **只读副本**查询真实失败任务，`/api/ai/analyze/status` 返回 `recovery.action=resume-aggregate`、18/18 已保存、`outputStats.responses=20/rejected=1`、`batchIndex=null`。
- 未验证：真实付费 Provider 的 16k `max_tokens` 接受度与截断后 Continue；真实生产任务 Resume；真实浏览器点击/截图；真实 UAC 双击。

### 0.19.4 用户安全恢复步骤

1. 先完全退出 LiveMemory，备份整个数据目录（不要在运行时复制写入中的 SQLite）。
2. 替换为包含本轮修复的新构建，确认设置页「关于」的 buildId 与构建记录一致。
3. 打开 AI 分析中心，选择该场次；应看到「AI 分析未完成」、单场批次 18/18、最终汇总失败、原因与「继续最终汇总」。
4. 选择与失败任务相同的 Provider/区域/模型，点击「继续最终汇总」；不会重发已保存的 18 个批次。
5. 成功后 final 保存、任务变 complete、恢复面板消失；失败则查看技术详情，不要新建整场分析、不要清空数据。
6. 当时正式 EXE：buildId `61da4c6991e1` / commit `205db74` / SHA-256 `7231c0560d79c0536d14dae7741609777a76ce575c52af284a73052c02b5475d` / 91.8 MB / 174 assets / `requireAdministrator`（历史；当前见 §0.24.5）。

## 0.18 v0.13.2 AI 分析多语言输出与报告翻译（2026-11-13）

完整变更与验证记录：`log/2026-11-13-ai-report-translation.md`。**未修改生产数据库、未干扰正在采集的直播、未调用真实付费 API；全部使用 `tests/.tmp` 隔离数据与 Mock Provider。**

### 0.18.1 审计结论

- **已经支持的部分**：AI 分析中心已有独立的「分析输出语言」选择（zh-CN / ja / en）；`POST /api/ai/analyze/run` 把 locale 写入会话/画像两个 `ai_jobs`，包内 `instructions.md`、Prompt 版本、Session 与 Memory 任务均使用同一 locale。`topic` 已作为稳定匹配键保留。切换界面语言不会修改已创建任务。
- **本轮补齐的缺口**：
  1. 分析语言容易与界面语言混淆；UI 文案改为「分析输出语言」，并明确它与界面、弹幕原文无关；Prompt 增加「任意/混合语言原文直接理解、不逐条预翻译」规则。
  2. 已保存报告没有阅读语言切换；长期画像只能按原语言阅读。
  3. 没有翻译缓存、按需翻译、分段落失败恢复、独立的翻译 usage/费用归属。
- **未重做**：没有新增第二套分析系统，没有改变结果 Schema 1.3.0、批次/Resume/Compact/观众级容错与事实操作语义。

### 0.18.2 功能 A：分析输出语言

- 三个概念明确分离：界面语言（UI locale）、分析输出语言（task locale）、原始内容语言（弹幕/聊天实际语言）。
- AI 中心默认使用当前界面语言，可手动选择；任务开始后 locale 写入 `ai_jobs.locale` 与运行时状态，界面语言切换、暂停/恢复不会改变已保存任务的语言。
- Session 与 Memory 使用**同一个任务 locale**：Session Prompt、Memory 运行时 instructions、长期画像 Compact 示例均为该语言。
- Prompt v13.2 新增：聊天/摘录可能是中文、日语、英语或混合语言，模型直接理解原意并用 locale 输出，不要求逐条翻译；技术字段、JSON 键名、枚举、稳定 ID、证据编号不变。

### 0.18.3 功能 B：已保存报告的语言切换

- 报告标题区新增「报告语言」选择器（简体中文 / 日本語 / English）与原文/翻译 chip；默认先显示报告原文，首次切换时才提示翻译，避免误产生费用。
- **切换语言不是重新分析**：翻译服务只读取已导入的 `ai_results`、`viewer_memories`、`memory_facts` 的展示文本，不读取整场弹幕、不创建 `ai_job`、不执行 Session/Memory 批次、不调用事实操作。
- 可翻译内容：单场摘要、话题标题/摘要/要点、情绪说明、争论标题/摘要/说明/观点、回看片段标题/原因/候选说明、本场观众画像摘要与兴趣说明、长期画像摘要与事实 `statement`。
- **绝不翻译**：`viewer_id`、`topic` 匹配键、事实 ID、状态、`stated/inferred/uncertain`、版本、证据引用、时间、金额、计数、置信度、枚举值、JSON 键名、原始聊天证据正文。
- 原始报告保持只读；翻译只写独立的展示缓存。选择原文语言时直接返回原始文本，不应用缓存。

### 0.18.4 缓存、按需翻译与费用

- 新增 schema **14**：`ai_translations`（段落级展示缓存）与 `ai_translation_runs`（独立翻译运行/usage/错误）。
- 缓存键：`target_kind + target_id（ai_results.id / viewer_memories.id / memory_facts.id） + item_path + target_locale + source_hash + translator_version`。原始结果版本更新（新 `ai_results.id`）或事实文本变化（新 hash）时旧缓存不会覆盖新内容。
- 首次切换语言：读取本地缓存；缺失时调用**用户已配置的 Provider/模型**，按段落分块翻译；每块成功即保存，单段失败只标记该段，已成功段落保留。再次选择同一语言只读缓存，不重复请求。
- 失败后「重试未完成段落」只请求缺失/失败项，不重复成功项；中断/失败不清除已保存翻译，也不影响原始报告。
- 翻译 usage/费用只写入 `ai_translation_runs`，不混入 `ai_jobs` 的 Session/Memory usage。价格未知时 `cost=null`，界面显示「费用未知」，不显示为零。
- 首次翻译前 UI 显示「会调用 AI 模型并可能产生费用」并要求勾选确认；服务端要求 `consent:true`；没有可用 Key 时只说明原因，原文继续可读。

### 0.18.5 API

```text
GET  /api/ai/sessions/:id/report?locale=zh-CN|ja|en   只读；应用缓存，绝不调用 Provider
GET  /api/ai/sessions/:id/translation?locale=...      只读状态/缓存计数/运行进度/可用配置
POST /api/ai/sessions/:id/translation                 按需翻译未完成段落（locale, configId, consent）
```

报告响应新增 `reportLocale`（原文语言）、`displayLocale`（当前展示语言）与 `translation`（status、total/translated/failed/missing、run usage/error、providers）。状态包括 `original / missing / partial / complete / running / failed / unavailable`。

### 0.18.6 数据生命周期

- `ai_translations` / `ai_translation_runs` 随场次级联删除；删除单场时显式删除并纳入 `assertNoResidue`。
- 删除观众长期记忆时，同时删除该记忆及事实的翻译缓存，保留记忆墓碑，旧包不能借翻译恢复已删除内容。
- 清空数据/恢复出厂包含两张翻译表；数据库迁移 v13→v14 只新增表与索引，不改写任何历史行。

### 0.18.7 测试（本轮实测）

- 全量：**649 passed / 0 failed**（2026-11-13，`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`，约 155 秒）。
- 新增：
  - `tests/unit/ai-translation.test.mjs`（6）：字段提取、结构不变、stale hash、状态、文本清洗、分批报告字段定位。
  - `tests/unit/ai-translation-ui.test.mjs`（2）：选择器/进度/失败重试/费用提示/三语键/无 innerHTML。
  - `tests/integration/ai-report-translation.test.mjs`（7）：日语→中文、缓存复用、双语切换、部分失败只重试失败段、新结果版本隔离、缺失 Provider/网络失败、证据清理、Schema 1.1.0 旧报告、Session/Memory 同 locale。
  - `tests/integration/ai-translation-migration.test.mjs`（2）：v13→v14、场次级联。
- 覆盖任务要求的 A–J；其中移动端/真实浏览器/正式 EXE/真实付费 Provider 未执行（见 §0.18.8）。

### 0.18.8 未验证 / 边界

- **真实付费 Provider 翻译未执行**：本机无 Key，全部为 Mock fetch；真实 Provider 的翻译质量、429/超时下的分段恢复、费用精度未验收。
- **真实浏览器 UI 未验收**：本机沙箱仍阻止浏览器命名管道；选择器/进度/窄屏由静态断言、i18n 与 HTTP 接口覆盖，不声称已截图。
- **正式 EXE 未重建**：本轮未构建 `dist/LiveMemory.exe`；发布 EXE 仍为上一构建（schema 13），需下次构建才能包含 schema 14 与翻译功能。
- **翻译质量不保证**：翻译是展示层派生文本，可能与原文有措辞差异；不做人工审校，不把翻译结果写回事实或报告。
- **旧历史英文事实**：不会自动批量翻译；切换到其他语言时按需生成展示版本，原始事实保持不变。
- **混合语言/原文语言识别**：`reportLocale` 取自主结果或任务 locale，不自动检测每条弹幕语言；翻译 Prompt 明确接受任意/混合语言。


## 0.16 v0.13.2 AI 分析可靠性与长期画像语言修复（2026-11-13）

完整的只读审计报告在上一轮交付中提供，**本轮不重复审计，只按实际代码修复并验证**。生产数据、正在采集的直播、正式 `LiveMemory.exe` 与真实付费 API 均未触碰；所有测试使用 `tests/.tmp` 隔离目录与 Mock Provider。

### 0.16.1 已修复问题

| # | 问题 | 根因 | 修复 | 验证 |
| --- | --- | --- | --- | --- |
| 1 | Compact ref 覆盖完整时绕过完整校验 | `generateMemoryAnswer()` 在 `assembleMemoryCompact().ok` 后立即返回，从未调用 `validateAnalysisImport()` | 统一为「组装 → 完整校验 → 最多一次修复 → 再校验 → 导入」；ref 覆盖不再等于合法 | A/B/C/D；`ai-memory-reliability` |
| 2 | 模型可覆盖本地稳定 `viewer_id` | `assembleMemoryCompact()` 先写 `viewer_id` 再展开模型 `memory` 字段 | `memory` 四字段白名单；`viewer_id` 永远最后注入；身份/未知字段丢弃并记录字段名（不记录值） | E + `ai-compact-memory` 单元测试 |
| 3 | `AI_IMPORT_INVALID` 诊断丢失 | Runner `fail()` 只读取 `error.detail`，未读取 `AppError.details.errors` | `fail()` 提取字段级错误、阶段、Job/Batch、可恢复性与建议；随状态与 `/api/ai/analyze/status` 返回 | B/G + HTTP 状态断言 |
| 4 | 成功批次清除其他批次失败 | 导入成功调用无参 `clearJobFailure()`，清空整个 Job | `last_error_json.batches[]` 按批次保存；成功只清同批次；旧扁平失败仍兼容 | G/I + 并发/重启测试 |
| 5 | 日语长期画像输出英文事实 | `memoryShape()` 固定英文示例与 `"locale": "en"`；memory 任务缺语言要求 | 三语本地化 Compact 示例；明确自然语言字段使用 locale；`topic` 保留稳定匹配键；Provider 请求由当前运行时 instructions 生成 | J + `ai-compact-memory` |
| 6 | 旧 instructions 与 Compact 契约冲突 | 包内 `instructions.md` 同时含完整 Result 示例与 Compact 契约；Resume 继续发送旧文件 | Memory Provider 提示词改用当前 `buildMemoryInstructions()`，旧包只提供数据文件；单一 Compact 契约 | J + 单元测试传入旧 instructions 验证被忽略 |
| 7 | 事实准确性规则不足 | 未明确区分 stated/inferred/uncertain、玩笑/引用/建议 | 三语 rules 明确：本人证据、推断不可写成事实、不得编造、不得为填满而造事实、no_semantics 合法 | J + 提示词单元测试 |
| 8 | 统计口径误导 | 报告只显示 `longTermProfiles.count`（有记忆头的观众数） | 新增 `stats`：应处理/已处理/有语义/仅客观/未完成/失败批次涉及；AI 中心与报告显示分别统计 | G/K + 报告接口断言 |
| 9 | 单场成功 + 画像失败显示笼统 | 已会标 `partial`，但缺少精确的长期画像进度与批次原因 | 状态 `partial` 保留；UI 显示「单场报告已完成，长期画像未完成」+ 已处理/未完成；错误显示真实原因与技术详情 | K |
| 10 | usage 跨 Job 重复统计 | `requestOnce` 把任务累计 usage 写入 memory job（包含 session 部分） | 按请求 kind 归属子 Job；任务总计由子 Job 相加；修复/重试计入真实请求；任一子 Job 费用未知则总费用未知 | L |
| 11 | 断点恢复可能重复付费 | 需验证完成批次、语义事实与客观记录不重复 | 现有 pending 过滤 + 幂等导入；新增重启 Resume 只补失败批次、重复提交不重复写事实的测试 | G/H/I |

### 0.16.2 明确未做 / 边界

- **不自动恢复生产任务**：`ses_01M77TJXG9VP4VAGNSXY` 未执行 Resume、未调用真实 API；步骤见 HANDOFF。
- **未批量翻译历史英文事实**：已有英文 `memory_facts` 保留；未来生成使用当前 locale。处理建议见 HANDOFF。
- **未保存失败模型原始回答**：该增强涉及加密、生命周期、大小上限与隐私影响，本轮只给出方案（HANDOFF §4），不持久化任何模型正文。
- **历史重复 usage 未猜测修正**：旧版本已写入的 `usage_json` 保持原样；新任务按子 Job 归属。旧任务的展示可能仍包含历史重复值，字段中有说明。
- **真实付费 API 未验证**：本机无 Key；本轮全部是 Mock Provider 的确定性验证，不是真实 Provider 验收。
- **浏览器 UI 截图未完成**：本机 DSH 沙箱禁止浏览器命名管道/Mojo（`OpenProcess`/`platform_channel` 0x5），headless Edge 无法启动；UI 由静态断言、i18n 与 HTTP 状态/报告接口覆盖，不声称已做真实浏览器验收。
- **生产数据库未修改**：没有迁移、没有读写 `%LOCALAPPDATA%\LiveMemory`。

### 0.16.3 测试（本轮实测）

- 全量：**628 passed / 0 failed**（2026-11-13，`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`，约 120 秒）。
- 新增：
  - `tests/unit/ai-compact-memory.test.mjs`（7）：白名单/身份覆盖/非法操作保留给 Schema/旧 instructions 被忽略/三语示例与语言规则/Schema 无 viewer_id。
  - `tests/integration/ai-memory-reliability.test.mjs`（10）：A 正常导入、B 完整 ref 但证据缺失、C 一次修复成功、D 修复仍失败可恢复、E 伪造 viewer_id、F 跨观众证据、G 四批并发仅第 2 批失败且错误不被清除、H 重启只补 b02、I 重复提交幂等、J 日语事实、K combined partial、L usage 归属、M 礼物-only 客观处理。
  - `tests/unit/ai-ui.test.mjs` 新增：诊断/统计三语键、技术详情只渲染本地字段、无 HTML 注入。
- 关键命令与结果见 HANDOFF §5。
- 隔离启动冒烟：`node src/launcher/launcher.mjs --no-open --port 48300 --data-dir D:\LiveMemory\tests\.tmp\smoke2` → `/api/health` 返回 `buildId=dev-e67677a`、`commit=e67677a`；`/api/bootstrap` 返回 schema 13 与临时数据目录。结束后删除临时目录。端口 49666 在本机被系统/沙箱拒绝（EACCES），换 48300 成功，不是应用代码错误。

### 0.16.4 `AI_IMPORT_INVALID` 专项端到端验收（2026-11-13）

完整证据：`log/2026-11-13-ai-import-invalid-acceptance.md`。

- **旧代码 3fccba1**：392 条合成消息 / 37 观众 / 4 批（10/10/10/7），3 个变体（伪造 `viewer_id`、stated 缺证据、跨观众证据）全部复现 `AI_IMPORT_INVALID`；错误只有裸代码、无 stage/字段错误、无 repair；b02 仅 1 次请求；覆盖 27/37；后续成功批次清空 `last_error_*`。
- **新代码 e67677a**：同数据同变体全部 `complete` 37/37。伪造身份变体无需 repair（本地 ID 不被覆盖）；缺证据/跨观众证据变体 b02 发起一次 repair 后成功。
- **修复仍失败**：新代码显示 `AI_IMPORT_INVALID` + `MEMORY_EVIDENCE_REQUIRED` + stage=validation + batchIndex=2 + `batchErrors=[2]`；27/37 保留，facts 3。重启后 Resume 只发 1 次 b02，完成 37/37，facts 4。
- **隔离 EXE**：先用独立构建（buildId `c51819b2f3f3`）通过本地 Mock Provider 实测：repair 场景 complete 37/37；always-invalid 场景显示精确错误、27/37；EXE 内 Resume 只发 b02 一次并完成 37/37。随后按用户明确授权把正式 `dist/LiveMemory.exe` 重建为 buildId `caece0818f11`（`c827a609…`，commit `2b0ade6`，requireAdministrator），并用 asInvoker 测试副本实际启动验证 buildId/commit；正式 EXE 已替换，旧 EXE 备份在 `tests/.tmp`。
- 未验证：真实付费 API、原始 392 条聊天内容、真实生产任务 Resume、UAC 双击。


## 0.17 v0.13.2 真实 AI_IMPORT_INVALID 与观众级容错（2026-11-13）

完整调查与真实数据证据：`log/2026-11-13-real-ai-import-invalid-investigation.md`。

### 0.17.1 真实根因（已验证）

- 任务 `aij_01M7963928KHJGNJTD64`（memory-only，47 观众/5 批，locale zh-CN，qwen3.7-flash）：
  - 批次 1–4 已导入 40 名 semantic；批次 5 的 7 名全部 pending。
  - 失败批次 5 每名观众 1 条消息；`seq 3` 属于错误观众 `bilibili:1765635337`（ref 5），`seq 5` 属于另一观众 `bilibili:5240206`（ref 3）。
  - 模型在 `viewer_memory_updates[4]` 中为 ref 5 引用了 `seq 5` → `MEMORY_EVIDENCE_OTHER_VIEWER`。
  - 映射本身正确（包、`ai_job_memory_messages`、`memory_context.evidence_seqs` 一致）；根因是 **ref 与 seq 两套小整数编号混淆**：ref 5 的合法证据是 seq 3，而 seq 5 属于 ref 3。
  - 旧 Prompt 的 excerpt 行没有 `ref`，`memory_context` 使用 ref 但没有 viewer_id，模型必须自行按昵称/数字对照；这是可复现的设计缺陷，不是单纯幻觉。
- 自动修复确实发送过：批次 5 共 2 次请求（初始 + `memory-repair`）；初始错误为 `SCHEMA_TYPE`/`SCHEMA_ENUM`，修复后改为跨观众证据。旧代码只允许一次修复，修复后仍失败就拒绝整批。
- 任务总 usage：8 次请求、77,204 input / 37,327 output；`pricing_status=unknown`、`cost=null`。单请求 token 未持久化。

### 0.17.2 原有隔离能力（调查结论）

- 单场报告：独立任务，已保留；画像失败没有删除报告。
- 批次：已成功批次保留；旧 `runPool` 在首个错误后停止**尚未开始**的后续批次，已启动批次继续。真实任务 5 批均已启动，因此没有观察到后续阻断；concurrency=1 时旧逻辑会停。
- 观众：**没有观众级隔离**；批次 5 的 1 人错误导致 7 人全部不导入，旧版无法只恢复失败观众。
- 操作：同一观众的多条操作保持原子，不做单条操作拆分。

### 0.17.3 修复

- **Prompt**：Provider 的 `viewer_excerpts.jsonl` 每行增加本地生成的 `ref`；契约明确 ref/seq 不同命名空间、ref 5 可有 seq 3、只能使用同 ref 的 evidence_seqs；repair 增加 `MEMORY EVIDENCE GUARD`；错误参数携带 `allowedSeqs`。
- **观众级容错**：whole-batch repair 后仍有观众级错误时，按 `viewer_memory_updates[i]` 拆分；合法观众用 `viewerIds` 作用域重新完整校验并导入；非法观众状态 `failed`，不写任何事实；再发一次有界 viewer-scoped repair（只含失败观众/证据），成功则合并回整批，失败则保留合法观众并标记 failed。
- **事务/幂等**：合法事实、证据、覆盖状态与 failed 状态在同一 SQLite 事务；恢复导入生成新的 `ai_results` 版本（只含恢复观众），事实去重/版本机制不变。
- **调度**：`runPool` 对批次级校验错误不再停止后续批次（concurrency=1/4 均验证）；Provider/取消/数据库错误仍停止新调度。
- **Resume**：按 `ai_job_memory_viewers` 的 `pending/failed` 观众构造子集 Prompt；只请求未完成观众；旧任务失败批次 7 名仍全部 pending，因此旧任务 Resume 会处理这 7 人，不能只挑 1 人（旧响应未保存合法 6 人）。
- **UI/统计**：覆盖新增 `failed`；partial 文案显示 `{processed}/{total}`、未完成、校验失败等待恢复；报告 stats 使用覆盖 `failed`。

### 0.17.4 验证

- 全量：**632 passed / 0 failed**（2026-11-13，约 112 秒，`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`）。
- 新增/更新 `ai-memory-reliability`：ref/seq 冲突（真实生产形状，ref5↔seq3、ref3↔seq5）、concurrency=1 后续批次继续、viewer-scoped repair 自动成功、观众级 9/1 隔离、Resume 只发失败观众。
- 真实任务副本回放（只读复制生产库+包，Mock Provider）：
  - 普通 Resume：1 次请求，仅批次 5 的 7 名 pending；complete 47/47。
  - 模拟真实 ref/seq 错误：initial + whole repair + viewer repair 共 3 次请求；complete 47/47，41 semantic/6 no_semantics/0 failed，未跨观众写入。
- **正式 EXE**：`dist/LiveMemory.exe` 重建为 buildId `9b8daa7b2d1d` / commit `2df6052` / SHA-256 `9b3eea3e…`；asInvoker 测试副本 + 生产库/包只读副本 + Mock 实测 resume `aij_01M7963928KHJGNJTD64`：3 次请求后 complete 47/47、41 semantic、0 failed，批次 1–4 未重发。
- 未验证：真实付费 API、真实生产任务 Resume、真实浏览器 UI（沙箱仍阻止浏览器命名管道）、UAC 双击。

## 0.15 v0.13.2 观众身份专项审计（2026-11-12）

完整报告：`docs/AUDIT_VIEWER_IDENTITY_2026-11-12.md`。**只读审计用户数据库，未修改任何历史事件。**

### 0.15.1 结论

- 场次 `ses_01M75S69P4H0NSX87PD4`（Bilibili，727 条消息）只有 **2 个有效 UID**：1 条 Super Chat + 2 条大航海；**726/726 条弹幕 `viewer_uid` 为 NULL**，71 个昵称全部打码。
- 因此历史页与 AI 中心都显示 2 名「可识别观众」，数字一致且数据库没有 JOIN/迁移/缓存丢人。
- 根因：**Bilibili 未登录弹幕风控**（昵称打码、uid=0）＋ **UI 把「可识别观众」写成「独立观众/本场参与人数」且不显示 726 条未识别消息**。
- 跨场次：另一场 Bilibili 也是 0 个可识别观众 / 206 条未识别；四场 YouTube 的未识别消息为 0。判定 **B + D**，不是单场、不是所有平台、不是纯 UI。
- 历史消息数与时间线可重算；726 条弹幕的真实身份**不可恢复**（平台从未提供 UID；打码昵称不能用于合并）。实际观看人数未知，历史未保存平台 online。

### 0.15.2 修复

- canonical 层把 `uid=0` / `"0"` 视为缺失，禁止 `platform:0` 共享档案。
- 新增只读派生指标 `unidentified_message_count`：从 `events` 实时计算，历史自动重算，无迁移。
- 直播页 / 历史列表 / 历史详情 / AI 中心统一显示「可识别观众」+「N 条未识别」警告，并修正「登录不会改变身份字段」的错误文案。
- 登录由「可选」改为「建议」；不回填、不猜测、不删除历史身份。

### 0.15.3 测试与限制

- 全量：**610 passed / 0 failed**（2026-11-12，`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`，约 119 秒）。
- 新增：`tests/integration/identity-stats.test.mjs`、`tests/unit/identity-labels.test.mjs`；`events.test.mjs` 增加 UID=0。
- 数据库副本启动实测：`/api/sessions`、`/api/history/search`、场次详情均返回 `727 / 2 / 726`，重启不变。
- **未验证**：登录后能否 100% 解除 Bilibili 打码（本机无账号 Cookie）；原始 WebSocket 帧未保存，无法回读当时 `info[2][0]`；未做真实浏览器截图验收。

## 0.14 v0.13.2 构建可验证与分批预算（2026-11-12）

真实事故：14:17 用户启动的仍是 87bec0c 的旧 EXE；fd8aedc 的 8k 总预算把 889 条消息切成约 125 批。完整诊断见本轮日志；本节只记录修复与实测。

### 0.14.1 构建标识（已实测）

- `src/shared/build-info.mjs`：开发模式直接读 `.git/HEAD`（不 spawn git）；打包模式读 `build-info.json` 与 bootstrap 环境变量。
- `scripts/build-windows.mjs`：写入 commit、`sourceHash`（含 `scripts/sea-bootstrap.cjs`）、`assetHash`、`buildId`、逐文件 SHA-256；断言 7 个可靠性模块存在；构建后检查 EXE 内确实包含 buildId 与模块名。
- `scripts/sea-bootstrap.cjs`：复用缓存前**逐文件校验 169 个 SHA-256**；不一致记录 `app-root.stale`、删除并重新解压；解压后再次校验；把 buildId/commit/校验结果写入环境。
- 启动日志 `startup.begin` 与 `launcher.start` 记录 build；`--version` 输出 Build / Build ID；设置页「关于」显示 Build ID、commit、构建时间；`/api/health`、`/api/bootstrap`、`/api/status` 返回 build。
- 旧缓存不再被误用：旧目录 hash 不同；同 hash 目录被篡改会被校验发现并重建。

**最终 EXE（实跑验证）**：

| 项目 | 值 |
| --- | --- |
| 文件 | `dist/LiveMemory.exe` |
| 大小 | 91.6 MB |
| SHA-256 | `aa3d41105af90eeed8608bb49caf018f17b5f0dbaa1aef0c9b297a3b870ba61d` |
| commit | `b101bd01bc227fd85abaa862873eb0ce61e792cd` |
| buildId | `89bf47ac620e` |
| asset hash | `89bf47ac620eed9ed26c` |
| builtAt | 2026-11-12T10:47:20.675Z（18:47:20 +08） |
| 资源 | 169 files；7 个必需模块；RT_MANIFEST requireAdministrator |

本机非提升会话用同一二进制的 asInvoker 副本实际启动：`/api/health` 与 `/api/bootstrap` 返回 `buildId=89bf47ac620e`、`mode=packaged`、`verified=true`；启动日志 `startup.begin` 含同一 build；第二次启动复用缓存并 `filesVerified=169`。**不是只看版本号。**

### 0.14.2 分批预算（真实 889 条消息离线规划）

- 预算拆成三项：固定 overhead（实测 instructions + session_context + answer schema + wrapper）、内容预算、输出预留；内容至少占配置总预算的 50%，且不低于 1,000 tokens。
- 默认总输入预算 **24,000**（原 8,000）；配置范围仍为 2,000–32,000。
- `batch_plan` 记录 configured/effective/content/overhead/output/context，`overheadAdjusted` 与 `contextCapped` 可见。
- 真实包（889 消息、94,137 估算消息 tokens、7,193 overhead、8,000 输出预留）实测：

| 总预算 | 有效输入 | 内容预算 | 批次数 | 平均消息/批 | 最大单批估算 | 估算总输入 | 按真实 1.366 校准 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 8,000 | 11,193 | 4,000 | 24 | 37.0 | 11,192 | 266,769 | 364,406 |
| 16,000 | 16,000 | 8,807 | 11 | 80.8 | 15,997 | 173,260 | 236,673 |
| **24,000** | **24,000** | **16,807** | **6** | **148.2** | **23,949** | **137,295** | **187,545** |
| 32,000 | 32,000 | 24,807 | 4 | 222.3 | 31,988 | 122,909 | 167,894 |

- 覆盖：每档 889/889，消息不丢、不重；不再出现 125 批。
- 未退回 135k 单请求：上限 32k，超出按批拆分。
- 明确例外/保护：单条消息本身超预算可独占一批；单观众超预算可独占一批，但硬上限 48k，超过 `ANALYSIS_MEMORY_VIEWER_TOO_LARGE`；aggregate 输入硬上限 48k 且受上下文约束；repair 只截断上次回答、保留原批内容，超限 `ANALYSIS_REPAIR_TOO_LARGE`；上下文装不下 `ANALYSIS_CONTEXT_TOO_SMALL`。

### 0.14.3 输出与思考模式（文档证据）

- 阿里云官方文档（2026-11-10 版）确认：`max_tokens` 对 Qwen 只限制**回答**；思考内容在 `reasoning_content`，单独计费。`qwen3.8-max` 默认 `reasoning_effort=xhigh`、`thinking_budget=131072`。
- 这解释了平台 18,684 output 与 9,936/12,734 历史单请求：`max_tokens=8000` 不是总输出上限。
- 修复：DashScope 请求在 `max_tokens` 之外发送 `max_completion_tokens = 回答预算 + 16,000`（session 24k、memory 22k），有界但**不关闭思考**；其他 Provider 不发送该参数。
- 观测：attempt 日志新增 `model`、`maxTokens`、`maxCompletionTokens`、`estimatedInputTokens`、`requestBytes`、`reasoningChars`、`reasoningTokens`；流式只统计 `reasoning_content` 长度，不保存内容。
- 124 位观众：长期画像由 memory 批次保证每位恰好一条；测试覆盖 124/124。session 的 `viewer_profiles` 明确为可选、按批高亮，不再暗示完整覆盖。

### 0.14.4 测试（本轮实测）

- 全量：**597 passed / 0 failed**（2026-11-12，`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`，约 93 秒）。
- 新增：`tests/unit/build-info.test.mjs`、`ai-adapter-output.test.mjs`、`ai-repair-guard.test.mjs`；`ai-token-batching.test.mjs` 增加 889 消息 / 124 观众 / 硬上限；`bootstrap.test.mjs` 增加缓存篡改重解压。
- 未做：真实付费 API（含 `max_completion_tokens` 与思考模式行为）、真实 UAC 双击、真实 889 消息付费回放。

### 0.14.5 任务完成优先（2026-11-12 最终修订）

**真实触发路径（已确认）**：

- 15:35:58 启动，`batchTotal=7`；15:48:40 第 7 批完成并**立即发出** final aggregate 请求；15:55:58 aggregate 在 `elapsedMs=435,770` 时以 `PROVIDER_TIMEOUT` 结束，任务于 20:00 标记 `ANALYSIS_TASK_TIMEOUT`。
- 不是“阻止启动汇总”：汇总已经启动；是 `requestOnce` 把 `maxTotalMs` 设为剩余任务预算（当时约 438 秒），在途流式请求被任务预算中止。
- 7/7 批次全部保存；只有 final aggregate 丢失。

**最终语义（取代 r2 的 60/45 分钟）**：

- **删除任务级时间上限**：不再有 `createTaskBudget`、`taskTimeoutMs`、soft/hard deadline、`maxTotalMs`、按剩余时间缩短请求；任务可运行任意久。
- **删除费用预算**：删除预算输入、预算校验、预算确认、按累计费用停止、价格未知阻止分析、免费/付费模型分类。
- **只保留单请求技术超时**：首响应 `timeoutMs`（默认 180 秒）与流式 60 秒空闲；单请求超时不再让整个任务不可恢复，而是进入 `needs_action`，已完成批次保留，可继续重试未完成批次。
- **错误分类**：401/403/402/404/429/5xx/超时/网络 → `needs_action`（保留进度、可继续）；用户取消 → `canceled`（立即 abort）；Schema/导入错误 → `failed`（已完成批次仍保留）。
- **规模**：删除 `MAX_MEMORY_BATCHES`、`ANALYSIS_TOO_MANY_VIEWERS`、`ANALYSIS_TOO_LARGE` 等产品总量拒绝；消息/观众/批次按单请求 Token 预算自动拆分。仅保留 1,000,000 消息 / 200,000 观众的极端内存保护，以及单批 32k 输入、单观众 48k 硬上限等技术限制。
- **价格可选**：`pricing` 为空或只填一项 → 正常分析、只统计 Token、不计算总费用；完整填写 → 按实际 usage 计算并展示。价格不参与任何 gate。
- **状态/UI**：`needs_action`、`canResume`、`taskElapsedMs`、`waitingAggregate`、`pending*Batches`；UI 移除预算/费用确认/免费付费提示，显示已运行时间、阶段、批次、等待汇总、需要处理与继续。

**测试**：603 passed / 0 failed；新增 `v14-pricing-optional`（空/完整/部分价格）、`v14-task-budget` 改为“无时间上限 + timeout needs_action + 汇总-only 恢复”、2500 观众无总批次上限。

## 0.13 v0.13.1 可靠性专项（2026-11-12）

完整设计、边界与测试清单：`docs/AI_RELIABILITY.md`。
前序根因调查：`docs/AI_TIMEOUT_INVESTIGATION.md`。**本轮已改代码并完成本地确定性验证，但未发起真实付费 API 请求。**

### 0.13.1 超时与重试

| 问题（调查编号） | 修复 |
| --- | --- |
| B1 超时被当成可重试，自动重发 2 次 | `timeout` 明确 `retryable:false`；已发出的长请求超时后默认**不自动重试** |
| B2 `AbortError`/`TimeoutError` 合并 | adapter 区分 `canceled` / `timeout` / `network` / `rate_limit` / `server` / `client` / `invalid_response` / `stream_interrupted`；取消绝不重试 |
| B3 超时不降速 | 超时不再触发同批重发脉冲；429/5xx 仍按各自的退避与 `Retry-After` |
| B4 无任务级总时限 | 历史 20 分钟预算已在最终修订中**彻底删除**；任务只受单请求首响应/空闲超时约束 |
| B5 无 attempt 级状态/日志 | 每次尝试写 `ai.request.attempt`（脱敏：attempt、耗时、错误类型、HTTP status、是否收到响应头/输出、是否重试、usage 是否存在）；状态含 `attemptStats`、`currentRequest`、`lastRequest` |
| B6 `runPool` 首个失败中止其他请求 | 失败只停止调度新批次；在途兄弟批次继续完成并导入；最后抛第一个错误 |
| B7 统计按配置/进程 | 任务级 `attemptStats` 与按 `configId` 的 `requestStats` 并存；成功/失败/取消/超时/重试分开 |
| B8 失败尝试不计 usage | 失败/超时/取消未返回 usage 时计入 `usageUnknownAttempts`，UI 显示“用量未知”，不当作零费用 |
| B9 无流式/空闲超时 | 自动流式 + 60 秒空闲超时；持续输出不会被 180 秒总时长截断 |

### 0.13.2 Token 分批与汇总

- `src/ai/batching/tokens.mjs`：按估算 input token 规划 session 消息批次与 memory 观众批次。
- session：默认 8,000 input tokens/批；Provider 配置 `batchInputTokens` 可设 2,000–32,000；小上下文模型自动缩小并限制输出。
- 单场消息多批时，必须成功导入 **final aggregate** 才算 `complete`；汇总只使用已校验批结果，证据必须 `{batch, seq}`。
- memory：同一观众不拆批；预算同时计入摘录、现有记忆、evidence seq 列表与固定开销；超预算的单观众单独成批，不丢观众。
- 批包新增可选 `manifest.batch_plan` 诊断字段；结果 Schema 仍为 1.3.0，未迁移数据库。

### 0.13.3 流式

- 默认优先 Streaming；用户只选择 Provider/区域/Model ID，不出现 Streaming 开关。
- 支持 OpenAI-compatible SSE 与 Anthropic Messages SSE；Provider 返回 JSON 或明确拒绝 stream 时自动回退，且回退模式持久化，后续任务不再重复探测。
- 流式内容只缓冲，完成后仍走原 JSON 提取、本地组装、Schema/覆盖/证据校验与事务导入；中断流不写库。
- 计时区分响应头、首字节/首 token、流持续时间、最大空闲与总耗时。

### 0.13.4 UI / 统计

- 新增：单场批次 4/70、等待汇总、已收到模型输出、请求运行秒数、重试次数、已保存单场/画像批次、失败真实原因。
- 统计分开：请求尝试、成功、失败、取消、超时、自动重试、429、并发、模型耗时、token、已知费用；失败无 usage 显示“用量未知”。
- ETA 只在 ≥3 个成功批次样本且运行中显示；无依据不显示。
- `Estimated requests` 在含 session 的任务中显示“自动（按 token 预算分批）”，不再给出错误的固定 1。
- 修复全局 `[hidden]` 被 `.callout {display:flex}` 覆盖导致空提示框可见的 CSS 缺陷。
- 真实浏览器验收：headless Edge + DevTools 截图（运行中、完成、390px、设置页），见 `docs/screenshots/ai-reliability-*`。

### 0.13.5 测试与验证（本轮实测）

- 全量：**583 passed / 0 failed**（2026-11-12，`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`，约 96 秒）。
- 新增：`tests/unit/ai-attempts.test.mjs`、`ai-stream.test.mjs`、`ai-token-batching.test.mjs`；`tests/integration/v14-session-batching.test.mjs`、`v14-streaming-timeout.test.mjs`；更新 `ai-progress.test.mjs`。
- 真实浏览器：Edge headless CDP 打开 AI 中心与设置页，确认运行中/完成/窄屏/暗色渲染；截图使用合成 Fixture，不是真实 Provider。
- **未做**：真实付费 API 请求（本机无 Key）、真实 174k token 大场、真实 EXE 运行、UAC 验收。
- **阻塞**：真实 DashScope/OpenAI/Anthropic/DeepSeek/MiniMax/OpenRouter 生成仍未验证；不得用 Mock 结果冒充。

## 1. 当前阶段

- 里程碑：**M0 / M1 / M2 核心 / P0–P9 / M6 / M7 / v0.13 AI 架构重构完成**；v0.13.1 完成 AI 入口与调度收敛；v0.13.2 完成 P13–P16（画像校验、多语言、观众级容错、最终汇总恢复）；M3 真实接入继续验证；M4 部分完成；M5 未完成
- 版本：`0.13.2`（`package.json` 与 `src/shared/app-info.mjs` 一致；构建标识见 §5）
- 数据库 schema：**16**（v14→v15 `ai_aggregate_nodes`；v15→v16 `ai_job_memory_viewers.split_path/split_reason` 与索引）
- 分析结果 Schema：**1.3.0**；旧 1.0.0–1.2.0 仍可读取；提示词版本 **v13.2**（旧任务保留原版本号）
- 分支：`main`，本地提交，未 Push
- 发布形态：`LiveMemory.exe`，RT_MANIFEST **`asInvoker`**（RC0 P0-5，无 UAC）；本地 API 使用启动器会话认证

## 0. v0.13.1 本轮完成（2026-11-11）

### 0.1 付费 API 限速审计结论

完整报告：`docs/AI_SCHEDULER_AUDIT.md`。

- **付费 API 没有复用 OVH 匿名免费限速器。** v0.13.0 的 `src/ai/api/runner.mjs` 未导入/构造 `SlidingWindowLimiter`；该 limiter 只存在于 `src/ai/auto/runner.mjs` + `src/ai/auto/config.mjs:93` 的匿名路径。
- 固定 `2 requests/minute` 只存在于匿名路径；没有 30 秒固定等待。旧付费路径只有失败重试的 1.2s / 2.4s 固定等待。
- 旧付费路径的真实问题是：**所有画像批次完全串行**、30 批上限、`Retry-After` 未使用、每次请求重复 DNS 检查、每批导入重扫全部 session 观众、`listPackages` 默认 50 条导致大 job 找不到批次。
- 已删除 `src/ai/auto/` 与 `/api/ai/auto/*`；新增 Provider 隔离调度器与有界并发。

### 0.2 删除的入口

- 匿名免费 AI：UI 按钮、免费标识、免费服务状态、匿名 Provider 配置、自动切换、2 RPM、免费冷却、健康探测、`/api/ai/auto/*` 路由。
- 手动 AI：创建分析包、复制提示词、下载 ZIP、粘贴/上传 JSON、手动导入预览/确认、汇总包按钮、旧任务列表与修复指令 UI。
- HTTP 删除路由：`/api/ai/jobs` POST、`/api/ai/jobs/:id/aggregate`、`/api/ai/packages` POST、`/api/ai/packages/:id/download`、`/api/ai/instructions`、`/api/ai/import/preview`、`/api/ai/import`、全部 `/api/ai/auto/*`。
- 保留只读：`/api/ai/jobs` GET、`/api/ai/jobs/:id` GET、`/api/ai/packages` GET、`/api/ai/sessions/:id/report`、`/api/ai/results/:id`、`/api/ai/results/:id/download`。

### 0.3 保留的底层公共模块

- `src/ai/import/validate.mjs`、`src/ai/import/importer.mjs`、`src/ai/import/schema-validator.mjs`：严格 Schema、证据/身份/批次校验、事务导入、幂等与重复导入保护。
- `src/ai/api/compact.mjs`、`src/ai/api/prompts.mjs`、`src/ai/export/split-jobs.mjs`：ref→viewer_id 映射、单场/画像组装、内部包生成。
- `src/analytics/ai/report.mjs` 与 `src/web/js/pages/ai-report.js`：历史报告、长期画像只读展示。
- `src/ai/export/job.mjs`、`src/ai/export/package.mjs`、`src/ai/prompts/instructions.mjs`：旧 combined/手动包格式的内部构建器，保留用于历史兼容与回归测试；**不再有 UI/HTTP 入口**。
- 新增 `src/ai/runtime/json.mjs`、`state.mjs`、`scheduler.mjs`；删除 `src/ai/auto/`。

### 0.4 新请求调度

- 每个 `configId` 独立调度器；不同 Provider/区域/模型/密钥不共享限流状态。
- 初始并发可配置（1–8，默认 3），没有虚构的官方 RPM/TPM；429 时并发减半并遵守 `Retry-After`（上限 300 秒），成功 6 次后逐级恢复。
- memory 批次有界并发（默认按配置并发，最多 8）；同一观众只属于一个批次；同一主播跨场次记忆按时间顺序 gate，较旧场次在新场次已导入后被拒绝（`ANALYSIS_MEMORY_OUT_OF_ORDER`）。
- 失败重试：最多 3 次尝试，指数退避 + 50–100% 抖动，5xx/408/425 可重试，400/401/403/404 不重试。
- 状态新增：总请求、完成、失败、当前并发、排队、模型耗时、排队/限流等待、429 次数、p50/p95、token、已知费用、有依据时的 ETA。
- 画像批次上限从 30 改为 `ceil(MAX_ANALYSIS_VIEWERS / 10) + 1`（2,001），不再人为限制 1,000 观众。
- 本地性能修复：按批观众更新客观记忆、DNS 安全缓存 5 分钟、`getJobPackage()` 精确查询。

### 0.5 UI

- AI 分析中心只保留五步：选择直播 → 选择 API 配置 → 选择内容（单场/画像/两者）→ 费用与预算确认 → 「开始 AI 分析」。
- 无 API Key 时只显示设置入口，不再提供匿名免费或手动 JSON 入口。
- 保留暂停/继续/取消、真实阶段、失败原因、请求统计、报告与长期画像只读展示。
- 设置页新增「初始并发数」；匿名/免费价格分支删除。
- 三语键全部补齐；无 `innerHTML`、无 `alert()`。

### 0.6 本轮测试（实测）

- 全量：**548 passed / 0 failed**（2026-11-11，约 73 秒，`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`）。
- 新增：`tests/unit/ai-scheduler.test.mjs`（并发上限、429 隔离、取消、退避）、`tests/integration/v13-scheduler.test.mjs`（429 Retry-After、1,000 观众批次并发、失败恢复、跨场次顺序）、`scripts/benchmark-mock-scale.mjs`。
- 重写：`tests/unit/ai-ui.test.mjs`（只允许一个 API Key 流程）、`tests/integration/ai-api.test.mjs`（直接测试校验/导入/报告，不再依赖已删除的手动 HTTP 路由）、`v13-session-split`、`api.test`、`youtube-anonymous-session` 的包构建部分。
- 删除：旧匿名/手动测试文件（`auto-analysis`、`auto-api`、`auto-compact`、`auto-client`、`auto-prompt`、`auto-assemble`、`manual-52-viewers`、`ai-import-repair`）。

### 0.7 Mock 性能

详见 `docs/AI_SCHEDULER_AUDIT.md` §4。

| 场景 | 批次/请求 | 峰值并发 | 总耗时 | 吞吐 | 结果 |
| --- | --- | --- | --- | --- | --- |
| 100 观众 / 1,000 消息 | 10 / 10 | 6 | 591ms | 16.92 req/s | complete，100/100 |
| 1,000 观众 / 10,000 消息 | 100 / 100 | 6 | 6,491ms | 15.41 req/s | complete，1,000/1,000 |

### 0.8 真实付费 API

- **阻塞。** 本机用户数据目录没有 `config/ai-providers.json`，`secrets/` 没有 `ai-keys.json`，环境变量也没有 DashScope/OpenAI/OpenRouter Key。
- v0.13.0 的阿里云百炼真实样本使用临时目录，结束后已删除；不能把历史记录当作本轮真实测试。
- 唯一真实网络请求：`GET https://openrouter.ai/api/v1/models` → HTTP 200、469 个模型、375ms（只读，无 token）。不是生成验收。
- 没有伪造真实 API 成功；也没有为测试速度消耗 token。

### 0.9 未验证

- 真实浏览器渲染/截图（本机策略仍阻止无头浏览器）。
- Windows EXE 运行验收（UAC 拒绝）；本轮是否重新构建见 §5。
- 真实 Provider 的 429/Retry-After、1,000 观众运行、费用与延迟。
- 真实 Bilibili/YouTube 大场自动画像。

### 0.11 v0.13.1 七项实际使用修复（2026-11-11）

| # | 问题 | 复现/根因 | 修复 | 验证 |
| --- | --- | --- | --- | --- |
| 1 | 历史跳转 AI 未选中对应场次 | `ai.js` 忽略路由 `query`，总是取列表第一场 | `chooseInitialSessionId()` 按稳定 `session_id` 选择；目标不在前 100 行时按 id 加载；手动选择后更新 URL，不会被旧参数强制切回 | `ai-selection.test` + 静态 UI 测试 |
| 2 | 已配置 Key 却显示未配置 | 只用 `configs.length` 二值判断，缺少 key/测试失败/未检测/价格缺失状态 | 新增 `providerConfigState()`；分别显示未配置、缺 Key、测试失败、未检测、缺价格；删除“不再提供匿名免费 AI”历史文案 | `ai-config-state.test` + Provider 列表真实加密引用测试 |
| 3 | 没有实时进度条 | 只有文字；初始 idle 响应可能覆盖刚启动的任务；没有批次/观众进度 | 新增计数型进度条（批次/观众）、阶段文案、不确定动画；statusEpoch 防止旧响应覆盖；1.5s 轮询；完成自动加载报告 | `ai-progress.test`、`v13-progress.test`；真实浏览器未验收 |
| 4 | `Memory No viewers` | `ANALYSIS_MEMORY_EMPTY` 未本地化；combined 任务把画像无观众当整体失败 | 新增 `ANALYSIS_MEMORY_NO_VIEWERS` / `NO_BROADCASTER`；combined 保留单场报告并显式跳过画像；memory-only 明确失败；状态返回 `memorySkipped`、覆盖率 | `v13-api-runner` 无观众测试 |
| 5 | 报告重复显示两次 | 初始 `refreshReport()` 与 `refreshStatus()` 终态刷新并发，两个响应都 append | `reportEpoch` 单飞；只有最新请求可清空/挂载；报告 DOM 只有一个挂载点 | 静态单挂载点断言 + `reportEpoch` 测试；无真实浏览器 |
| 6 | Bilibili 未开播不显示主播名 | `getInfoByRoom` 在未开播/风控时失败，`anchorName` 为空，target 只剩 `Bilibili <room>` | `BilibiliApi.masterInfo()` 公共主播资料回退；`resolve` 和低频 `detect` 补全；target 持久化 displayName/platformUid；10 分钟失败重试；改名不改 broadcasterId | 真实房间 3（未开播）→ `3号直播间` / UID `11153765`；单元/集成测试 |
| 7 | 手动停止后可能自动恢复同一场 | `#reconcile` 清除 active 后下一轮 LIVE 检查会创建新 session；无持久抑制 | 新增 `live_stopped` 状态 + `meta.manualStop`（live cycle key、sessionId、awaitingOffline）；用户停止写抑制；同周期 LIVE 不启动；确认离线才清除；新 `live_time`/videoId 才允许新场；重启保持；`resume_capture` 仅用户主动 | 场景 A–G 测试；重启恢复；多目标隔离由现有测试覆盖 |

**真实 Bilibili 验证（只读公开接口）**：房间 `3`（解析为 `23058`，未开播）→ `displayName=3号直播间`、`platformUid=11153765`、`anchorName=3号直播间`；`roomStatus.liveTime` 为 `0000-00-00 00:00:00`，未伪造开播时间。

**未验证**：真实浏览器视觉、真实 EXE、真实付费 API、真实主播“手动停止→重启→仍直播”全流程（用 Mock 可控时钟验证）。

### 0.12 v0.13.1 第 8 项：已保存 API 配置可编辑（2026-11-11）

- **原因**：后端 `ProviderConfigStore.update()` 与 `PATCH /api/ai/providers/configs/:id` 已存在，但设置页卡片只有“检测/删除”，没有编辑入口；表单只能创建。
- **UI**：每个配置卡新增「编辑配置」；复用现有表单，预填名称/Provider/区域/Base URL/模型/价格/并发/本地网络；API Key 始终留空，显示「已保存」，留空表示保留；「保存修改」「取消」；保存后刷新卡片。
- **Key 安全**：编辑请求仅在用户输入新 Key 时发送 `apiKey`；空字符串不覆盖；服务端只在显式非空 Key 时替换。切换 Provider/区域/Base URL 会轮换 credential reference，并要求重新输入 Key；不会静默复用旧区域密钥。
- **模型变更**：服务端在 model 变化时清空 `capabilities`、`lastTestStatus`、旧价格/上下文/模型标签；UI 在模型输入变化时清除旧价格并提示重新检测。旧模型能力不会被当成新模型结果。
- **保存语义**：PATCH 原地更新同一 `configId`，保留默认标记、创建时间、其他配置；不会删除重建。部分 PATCH 未提供 `pricing` 时不再错误清空价格。
- **运行中任务**：`isConfigInUse()` 阻止编辑/删除正在运行任务使用的配置（409 `AI_PROVIDER_CONFIG_IN_USE`）；暂停/中断后的旧 job 若模型/区域变化，`resume` 返回 409 `AI_PROVIDER_CONFIG_CHANGED`；新任务使用新配置，旧报告/画像不修改。
- **测试**：`tests/unit/v13-providers.test.mjs`（模型修改保留 Key、能力失效、默认/多配置、重启持久化）、`tests/integration/v13-provider-edit.test.mjs`（模型-only PATCH、空 Key、改名/并发、区域切换、运行中阻止、resume 拒绝、AI 中心使用新模型）、`tests/unit/ai-settings-edit.test.mjs`（UI/PATCH/安全静态断言）。
- **限制**：真实浏览器点击验收未执行（本机 headless 被策略阻止）；未用真实百炼 Key 做编辑；代码/HTTP/单元已覆盖。

## 0.10 v0.13.0（历史）


### 0.1 权限与任务拆分

| 模式 | 入口 | 允许内容 | 权限边界 |
| --- | --- | --- | --- |
| 手动 AI | 导出单场包 → 任意 AI → 导入 | 单场总结/话题/情绪/互动/精彩片段/建议 | 不需要 Key；禁止 `viewer_memory_updates` |
| 匿名免费 AI | OVHcloud `gpt-oss-20b` | 单场报告 | 实验性；限流/超时/格式失败独立显示；不自动切换付费 |
| 任意已配置模型 | 已配置且通过能力验证 | 单场 + 长期画像（若 memory 能力通过） | 最终修订：价格、免费/付费分类、预算均不参与；只要求技术能力 |

- 新增 `session` 与 `memory` 两种独立任务；`both` 先保存单场报告，再执行画像。单场失败不影响画像，画像失败不覆盖单场报告。
- 手动单场包不再包含 `memory_context.json`、`viewer_excerpts.jsonl`、全量 `viewer_context.json`，也不要求 `viewer_profiles` / `viewer_memory_updates`。
- 旧 `combined` 任务/结果保留读取；历史报告仍可打开；旧长期画像不删除。

### 0.2 多 Provider

- 正式 Provider：OpenAI、Anthropic、DeepSeek、MiniMax（cn/intl）、阿里云百炼（cn-beijing/singapore/us/hongkong）、OpenRouter、自定义 OpenAI-compatible。
- Anthropic 使用独立 `/v1/messages` 适配器（`x-api-key`、`anthropic-version`、system 分离）；其余使用 OpenAI Chat Completions。
- OpenRouter：官方 `/models` 动态模型列表；已真实请求返回 469 个模型，其中 15 个免费、396 个声明 structured output。价格/上下文来自官方字段，不虚构。
- 区域独立配置：切换 region/base URL 会生成新 credential reference 并要求重新输入 Key，旧区域 Key 不复用。
- 自定义 URL 阻止云元数据、私网、localhost（除非显式 `allowLocalNetwork`）；请求前做 DNS 私网解析检查。

### 0.3 能力、费用与预算

- 能力检测层级：network → auth → text → json → session → memory；只有 memory 探针通过（多观众 ref、证据归属、零发言、多语言）才写 `capabilities.memory=true`。
- OpenRouter 价格按官方 `pricing.prompt/completion` 换算；未知价格保持 unknown，不按 Provider 名称推断。
- 价格完全可选；费用未知、部分价格、免费/付费分类、预算、`confirmBilling`、`optInMemory` 均不再阻止请求或长期画像。
- 长期画像只要求 `capabilities.memory=true`（以及 session 能力）。
- 没有任务时间/费用/总批次上限；只有单请求超时与单批 Token 技术限制（最终修订）。
- 能力检测结果写入配置并追加 `ai_provider_tests` 审计表（provider/region/model/time/type）。

### 0.4 手动单场

- `POST /api/ai/jobs {analysisMode:'session'}` 生成一个 `stage=session` 包，不含长期记忆文件。
- 导入只接受 `schema_version=1.3.0`、`analysis_scope=session`；`viewer_memory_updates` 非空直接拒绝。
- `POST /api/ai/import` 仍支持文件与粘贴；单场任务导入不触发任何长期记忆写入。

### 0.5 UI

- AI 分析中心：分析方式（手动/匿名/API）、内容（单场/画像/两者）、配置选择、价格状态、预算、付费确认、长期画像 opt-in。
- 设置页新增 Provider 配置卡：Provider/区域/Base URL/Key/模型/官方模型列表/价格/默认/能力检测/删除。
- 运行状态显示 provider/model/pricing/阶段/批次/单场报告状态/长期画像状态；暂停、继续、取消。
- 三语完整键（zh-CN / ja / en），无新增硬编码可见文案。

### 0.6 真实验证（本轮）

- **阿里云百炼真实端到端（隔离数据目录）**：`cn-beijing` / `qwen3.8-omni-flash`，单场 + 长期画像，2 次请求，5,671 输入 / 3,228 输出 tokens，估算 ¥0.0109928；状态 `complete`，`sessionReportDone=true`，`memoryDone=true`；数据库 3 个记忆头、2 条语义事实；报告 `longTermProfiles.count=3`（Mika 2 条事实，Ren/GiftOnly 仅客观记录）。这证明模型 ID 实际为 `qwen3.8-omni-flash`，且修复后的 Session 组装 + Memory 组装 + Schema 校验 + 写入链路可用。
- OpenRouter `/api/v1/models`：真实返回 **469** 个模型，15 个 `pricing=0` 免费模型，396 个声明 structured output（2026-11-11）。
- 其他 Provider 的真实生成请求：**阻塞**（无可用 API Key，未伪造成功）。
- 匿名 OVHcloud 生成：本轮未重新发起（v0.12.1 真实 52 观众样本记录保留）。
- 无真实浏览器渲染/截图验收；本机策略仍阻止无头浏览器。UI 只做静态/HTTP 覆盖。
- v0.13.0 EXE 已构建（91.5 MB / 166 assets / requireAdministrator），但 **未能运行**（UAC 拒绝）。

### 0.7 测试（本轮实测）

- 全量测试：**562 passed / 0 failed**（约 98 秒，2026-11-11，`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`）。
- 新增覆盖：Provider catalog/price/URL/credential store/Anthropic+OpenAI adapter/OpenRouter model list；单场任务导入；memory-only 任务；52 观众 6 批部分导入恢复；免费/付费权限门；预算阻断；API runner mock 单场与画像。

## 0.1 v0.12.1（历史）真实故障修复（2026-11-11）

### 0.1 真实故障与确认根因

真实样本：YouTube 日语直播 `ses_01M747HW1DH5GT9R308A`，99 条聊天 + 1 条 Super Sticker，
52 位稳定观众，录制约 51 秒，初始长期记忆为空。真实数据包和数据库从用户数据目录复制到
`tests/.tmp` 后离线分析（未修改用户数据库）。

**故障 A（自动分析）已确认根因：**

1. `response_format=json_object` + 约 44.7k 提示词 + 9,250 输出预算，在真实 25 观众批次上
   触发 gpt-oss-20b 的字段名重复退化：`finish_reason=length`、`completion_tokens=9250`、
   内容末尾反复出现 `"viewer_profiles","viewer_memory_updates","session_topics"`，JSON 不完整。
   一次“修复”请求再次发送同样的巨大提示词和退化内容，仍然失败。
2. 自动批次 `viewer_context.json` 包含属于其他记忆批次的观众（实测 batch 1：32 位 context，
   只有 25 位 memory target；batch 3：23 vs 5）。真实 structured-output 复现中，模型正确
   输出了 25 条，却把 2 位**其他批次**的观众写进 `viewer_memory_updates`，同时漏掉 2 位
   本批观众 → `MEMORY_VIEWER_UNKNOWN` ×2 + `MEMORY_VIEWER_UPDATE_MISSING` ×2。
3. 原来的客户端不读取 `finish_reason`/usage，无法区分截断、退化与普通 Schema 错误。

**故障 B（手动导入）已确认根因：**

1. 三语提示词都包含矛盾句“不要输出观众身份字段”，而同一份说明又要求每位观众必须有一条
   带 `viewer_id` 的 `viewer_memory_updates`；日语版更直接写成“視聴者 ID を出力しないでください”。
2. 52 位观众的包要求模型机械复制 52 个不透明 `youtube:UC...` ID；`memory_context.json`
   （67.6 KB）与 `viewer_context.json`（62.2 KB）大量重复；只有 Super Sticker、没有聊天
   发言的观众没有明确规则。
3. 真实 52 观众包用 OVH gpt-oss-20b 复测：新提示词下返回 49/52 条更新（3 位缺失），
   证明“模型会漏观众”是可复现的模型行为；正确覆盖 52 位的 JSON 可以正常导入。
   手动使用的具体模型仍未确认，不能把 OVH 结果等同于用户当时的模型。

### 0.2 修复内容

- 自动模式改为**紧凑回答 + 本地组装**：模型只返回 `session_topics` 和 `viewers[].ref`，
  不输出、也不能提供 `viewer_id`；本地按批次分配表把 ref 映射回稳定 ID，组装成完整
  Schema 1.2.0 结果，再走原有 `validateAnalysisImport()` + `importAnalysisResult()`。
- 自动请求改用 `json_schema` structured output；记录 `finish_reason` / usage / 退化检测；
  `length` → `AUTO_OUTPUT_TRUNCATED`。
- 缺少 ref 时执行一次**有界定向补充**（只发送缺失观众及其摘录）；仍缺失则
  `AUTO_VIEWER_COVERAGE_INCOMPLETE`，不写入任何结果。不会由程序替模型认定“无新信息”。
- 自动批次 25→**10 位/批**，批次上限 12→**30**（仍支持原 300 位观众）；汇总阶段也用
  structured output，并强制 `viewer_memory_updates: []`；汇总输出预算 12,000。
- `memory_context.viewers[]` 新增 `evidence_seqs`、`zero_excerpt`，去掉与 `viewer_context`
  重复的累计字段；手动提示词删除矛盾句，明确“原样复制 viewer_id”、零发言观众、
  `viewer_context` 中非本批观众不得写入。
- 导入预览新增 `target.memory.gaps`（missing/unknown/duplicate，含昵称）；界面显示缺失
  观众并新增「复制修复指令」，绝不自动改 ID。

### 0.3 真实验证（本轮实测）

- 自动、真实 OVH：52 位观众 / 99 条消息 / 6 批 + 汇总 → **complete**，
  `memoryCoverage.total=52`、`no_semantics=52`、`missing_update=0`、`complete=true`，
  7 条结果（batch:1–6 + final），52 个 `viewer_memories` 头。
- 单批真实对照：10 位观众 10/10、14.4 秒、489 completion tokens；25 位观众 25/25、
  20.4 秒、751 completion tokens（证明 25 位在紧凑格式下也可用；选择 10 位是为输出预算
  与语义质量留余量，代价是请求数增加）。
- 手动、真实 OVH 52 观众：49/52 + 3 位缺失，错误定位到具体观众；正确 52/52 JSON
  通过导入（见 `tests/integration/manual-52-viewers.test.mjs`）。
- 定向补充真实单次请求：只发 ref 3，2.9 秒返回仅含 `viewers` 的 1 条记录，
  无 `session_topics`、无其他 ref。
- 全量测试：**见 §3 的本轮结果**（`node --test --test-isolation=none ...`）。

### 0.4 本轮未验证 / 残余风险

- 用户手动分析时实际使用的模型/服务未知；OVH gpt-oss-20b 在 52 观众单包下仍会漏 3 位。
  现在界面会精确列出缺失观众并可复制修复指令，但不能保证任意模型一次覆盖 52 位。
- 自动 25 位单批只做了单次真实样本；10 位/批的完整 52 位真实运行已通过。
- 100 位低活跃观众、空档案、已有记忆更新、多批隔离、错误 ID、截断、429/超时/5xx
  已有 Mock/本地测试；未对免费接口做高频压力测试。
- 真实浏览器 UI（复制修复按钮、gaps 列表、暗色、390px）未在本机无头浏览器验收。
- 本轮未重新构建/运行 Windows EXE；v0.12.0 的 EXE 仍未运行验收。


## 1.1 本轮完成（2026-11-11，v0.12.0，P9 自动 AI 分析）

### 1.1.1 真实接口调查（先测试，再集成）

完整报告见 `docs/ANONYMOUS_AI_RESEARCH.md`。结论：

- **OVHcloud AI Endpoints**（官方文档 + 真实请求）是唯一通过完整 LiveMemory 包检验的匿名接口：
  - Base URL `https://oai.endpoints.kepler.ai.cloud.ovh.net/v1`，模型 `gpt-oss-20b`；
  - 匿名 **2 请求/分钟/IP/模型**，131k 上下文，JSON Mode；
  - 真实 3 观众包：`status=complete`、`memoryCoverage.semantic=3`、`source=auto`，证据 seq 正确。
- **Murakumo**：官方匿名说明存在，但实测 `/ready` 503、`murakumo/free` 502（OpenRouter 429）、`mishima` 180 秒后 `fleet_capacity_unavailable`；未取得有效回答，**不集成**。
- **llmfaucet**：`llmfaucet.dev` / `api.llmfaucet.dev` 在本地、Google DNS、Cloudflare DoH 均为 NXDOMAIN；**不集成**。
- **LLM7.io**：无 Key 请求可返回 200，但官方 README 要求 `dash.llm7.io` Token；匿名第三方授权无法确认，**不集成**。
- **Pollinations**（额外调查）：匿名基础 JSON/多语言通过，但真实 LiveMemory 包 HTTP 400；**不集成**。
- 没有第二个通过项，因此本轮**没有**生产自动切换列表；请求失败时降级到手动流程。

### 1.1.2 自动分析后端

新增：

| 模块 | 职责 |
| --- | --- |
| `src/ai/auto/config.mjs` | 唯一已验证 provider、匿名限流、批次/上下文/输出上限、稳定错误码 |
| `src/ai/auto/client.mjs` | `fetch` + `AbortSignal` 请求、滑动窗口限流、`Retry-After`、JSON 提取、错误分类 |
| `src/ai/auto/prompt.mjs` | 读取现有 ZIP 包、内联包内容、精确观众 ID/证据 seq、批次/汇总/修复提示词、上下文预算 |
| `src/ai/auto/state.mjs` | `runtime/ai-auto.json` 进度（无聊天正文/提示词），重启标记 `interrupted` |
| `src/ai/auto/runner.mjs` | 创建/恢复任务 → 逐批调用 → 校验 → 导入 → 汇总 → 完成；取消、重试、备用、请求预算 |
| `src/ai/auto/errors.mjs` | 单一 `AutoAnalysisError` 与脱敏 detail |

关键约束：

- 自动分析**不直接写数据库**：每个回答都先调用现有 `validateAnalysisImport()`，再调用 `importAnalysisResult({source:'auto'})`，与手动导入同一事务路径。
- Schema 严格程度不变；`viewer_memory_updates` 覆盖、稳定 ID、证据归属、时间窗口、重复导入保护全部沿用现有逻辑。
- 自动任务使用更小的批次（250 条消息 / 25 位观众 / 600 条摘录），最多 12 批；超出时明确 `AUTO_TOO_MANY_BATCHES`，不静默截断观众。
- 输出预算最低 8000 tokens（探测到 3040 会截断 gpt-oss 的 JSON）；修复请求最多 1 次。
- provider 调用串行；每个 provider 2 请求/60 秒滑动窗口；`429` 尊重 `Retry-After`（上限 90 秒）；单次运行有请求预算。
- 不使用 API Key、Cookie、Token、开发者服务器；首次使用需在 UI 明确同意数据发送。

### 1.1.3 自动分析 API

```text
GET  /api/ai/auto/services    已验证服务与最大批次数
GET  /api/ai/auto/status      按 sessionId 返回真实阶段/批次/错误/任务状态
POST /api/ai/auto/run         {sessionId, locale, consent:true}
POST /api/ai/auto/cancel      {sessionId}
```

`AutoAnalysisRunner` 随 `startServer` 的运行时创建/销毁；`shutdown` 会中止任务并把进行中的状态标为 `interrupted`。恢复时复用同一 job id、batch id、观众分配与已导入结果。

### 1.1.4 UI

在现有 AI 分析中心的「创建分析任务」卡内、手动控件上方新增：

- 「自动 AI 分析」主按钮 + 「免费 · 匿名」chip + 简短说明；
- 真实阶段文案：准备数据 / 连接免费 AI / 第 X/Y 批 / 验证结果 / 更新长期记忆 / 整场汇总 / 完成 / 已取消；
- 首次使用一次性同意弹窗（明确第三方数据处理）；
- 失败时按钮正下方显示规定红色文案，技术原因折叠在「查看详情」，不弹 `alert()`，不自动切换/删除手动结果；
- 手动创建任务、下载包、复制提示词、导入 JSON 全部保留；按钮下方用分隔线标注「或使用手动分析」。
- 处理中禁用同一任务重复启动；页面切换/刷新从服务端恢复状态；可取消，已导入批次保留。

### 1.1.5 本轮已知限制

- 只有一个已验证 provider；OVH 匿名层 2 请求/分钟，较大场次会更慢或明确拒绝。
- `gpt-oss` 的输出质量仍有波动；本轮通过“证据 seq 列表 + 必须输出状态变化 + 8000 输出预算 + 一次修复”降低失败率，但不能保证每个回答都完美。
- 真实长期记忆连续性测试（同一观众先“学画画”、后“改学吉他”）见 `docs/ANONYMOUS_AI_RESEARCH.md` §8：第二场自动完成后旧事实被标记为 `superseded`，新增“吉他”与“最近不怎么画画了”两条事实；这是单次真实样本，不保证所有模型都稳定。
- v0.12.0 EXE 已构建但**未能运行**（本机拒绝非提升执行）；未在真实数千观众大场执行自动分析。
- 真实浏览器 UI 仍未验收（本机策略阻止无头浏览器）；只有静态 UI 检查与 HTTP 端到端测试。

## 2. 本轮完成（2026-11-10，v0.11.0，P8）

### 2.1 审计结论：为什么之前只更新了少数观众

不是数据库或批次丢失，而是**设计把长期记忆建立在“AI 愿意输出画像的观众”上**：

1. 旧 M6 提示词明确写“`viewer_profiles` 只给证据足够的观众；证据不足的观众请省略”，
   并要求“单条发言不足以建立长期兴趣”。
2. 旧 M7 的本地合并只消费导入结果中的 `viewer_profiles`；没有画像的观众不会被建立记忆。
3. 旧 M7 的“记忆更新包”是**第二次 AI 工作流**：用户必须再导出、再交给 AI、再导入、再点合并；
   对普通用户而言很难发现，也没有覆盖状态。
4. 旧包按消息分批；同一观众跨批次时画像会被拆散，且没有“哪些观众未处理”的事实。

因此实际只更新了少数高活跃、被 AI 写了画像的观众。本轮把长期记忆改成**分析结果的一等字段**，
每位可识别观众必须有覆盖条目，缺一条就是导入错误。

### 2.2 一次分析、一次导入

- 同一个 `livememory-analysis-result-v1`（Schema **1.2.0**）同时包含：
  - `session_topics` / `viewer_profiles`：本场报告；
  - `viewer_memory_updates`：每位观众的长期记忆增量。
- 分析包新增 `memory_context.json`（现有画像 + 客观统计）与 `viewer_excerpts.jsonl`
  （本批观众的全部可用发言，最多最近 120 条/人）。
- 导入在**同一个 SQLite 事务**中保存分析结果、证据、客观记忆头、语义事实/版本与覆盖状态；
  分析导入失败会连同记忆一起回滚。

### 2.3 所有可识别观众

- `listSessionViewers` 的全部稳定 ID 都进入 `ai_job_memory_viewers`，无最低发言次数、无活跃度门槛、无 Top N。
- 观众上限 `MAX_ANALYSIS_VIEWERS=20000`；超出时显式报错，不静默截断。
- 没有发言、只有礼物/SC 的观众也会进入记忆批次；AI 返回 `no_new_information`，
  客观互动历史仍由真实记录更新。
- 批次上限 200 人 / 3000 条摘录；观众只分配到一个批次，该批包含其全部可用摘录，跨批次不拆散。
- 批次数量由消息量与观众数共同决定；普通单观众场次保持原有 500/500/200 消息切片行为。

### 2.4 客观历史与语义记忆

- 客观：首次/最近出现、参与场次、累计发言、付费事件、支持、最近场次。全部来自
  `viewers` / `viewer_sessions` / `viewer_broadcasters` / 金额聚合，导入时只确保
  `viewer_memories` 头存在并更新 `last_session_id` / `last_update_at`，不产生语义版本。
- 语义：`interest` / `dislike` / `identity` / `life_event` / `topic` / `preference` /
  `community` / `other`；支持 add / confirm / update / supersede / conflict / outdated / uncertain。
- 只有问候、表情或礼物时允许无语义更新；观众状态为 `no_semantics`，**不是未处理**。
- 已有画像进入 `memory_context`；AI 可以补充/修正/替换同一话题，不要求重新读取全部历史聊天。
- 证据 seq 必须命中本批 `ai_job_memory_messages`，且消息作者必须等于 `viewer_id`；
  他人消息、跨批次、越界 seq、无证据 stated、未知 target_fact_id 全部拒绝。

### 2.5 覆盖状态与预览

- `ai_jobs.memory_viewers_total` + `ai_job_memory_viewers`（pending/semantic/no_semantics/
  objective_only/missing_update/deleted）+ `ai_job_memory_messages`（seq → event → viewer）。
- 导入预览新增：已覆盖/总数、新语义、已处理无新语义、仅客观、缺少更新、记忆操作数。
- 任务状态新增 `memoryCoverage` / `memoryReady`；全部分配观众覆盖后任务才可能 `complete`。
- 旧 1.0/1.1 结果仍可导入：按 `objective_only` 覆盖，不阻断报告。

### 2.6 取消独立长期记忆工作流

- 删除 `src/web/js/pages/memory.js`、`#/memory` 导航与页面；旧书签 `#/memory` 进入 AI 分析中心。
- 保留全部数据库、版本、证据、删除/回滚/人工确认 API 与隐私规则。
- 观众详情长期记忆标签新增**客观互动历史卡**；没有语义事实但有互动时显示
  「互动已记录，暂无语义记忆」，不再伪装成“没有记忆”。
- 旧 M7 `memory_jobs` 表保留，仅用于已有历史数据；不再由 UI 创建新的独立记忆任务。

## 3. 自动化测试（本轮实测）

- 全量（v0.12.1）：`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`
  → **545 passed / 0 failed**（约 77 秒，2026-11-11）。
- 本轮新增/更新：
  - `tests/unit/auto-assemble.test.mjs`：ref 校验、ref→稳定 ID 组装、定向补充合并、
    定向提示词只含缺失观众；
  - `tests/unit/auto-client.test.mjs`：structured output 请求、`finish_reason`/usage、
    截断错误、退化检测；
  - `tests/unit/auto-prompt.test.mjs`：紧凑契约、refs、证据 seq、去重 messages/excerpts、
    上下文预算、修复提示；
  - `tests/integration/auto-compact.test.mjs`：52 人/99 消息 6 批、100 位低活跃 10 批、
    缺失 ref 定向补充、补充失败、截断、零摘录观众；
  - `tests/integration/manual-52-viewers.test.mjs`：52 人单批、2 未知 + 2 缺失精确 gaps、
    修正后 52/52 事务导入；
  - `tests/unit/ai-import-repair.test.mjs`：修复指令不改 ID；
  - `auto-api`：maxBatches=30、310 观众 → 31 批 422；
  - `ai-prompts`/`ai-api`/`ai-import`：提示词版本 m6.3。
- 既有 M6/M7/P8 全量回归通过；schema 仍为 12，无迁移断言变化。
- v0.12.0 的历史全量结果：525 passed / 0 failed（保留为历史记录）。


## 4. UI 验证（如实）

- **没有真实浏览器渲染/截图验收**：本机策略仍阻止无头 Edge/Chrome。
- 已覆盖：三语键一致、页面字面 key、独立记忆页已移除/旧链接到 AI、预览字段、客观历史卡、
  无 innerHTML、CSS tokens、窄屏规则（静态测试）；HTTP/端到端行为由 Node 测试覆盖。
- v0.12.0 自动分析 UI 额外覆盖（静态）：按钮/免费匿名 chip/首次同意 modal/真实阶段文案/
  按钮下方红色固定文案/折叠详情/取消/无 `alert()`/手动控件仍在；HTTP 路由与状态由
  `auto-api.test.mjs` 覆盖。
- v0.12.1 新增静态覆盖：`memory.gaps` 渲染、缺失观众列表、复制修复指令按钮；
  `ai-import-repair.test.mjs` 验证复制文本包含精确 ID/错误路径且不修改 ID。
- 因此不能声称自动按钮、gaps 列表、复制按钮、AI 预览、观众记忆页、暗色、390px
  已在真实浏览器验收。

## 5. 构建结果（如实）

- **2026-11-13 正式 EXE 已按用户授权重建并覆盖 `dist/LiveMemory.exe`**（观众级容错版本）：`node scripts/build-windows.mjs`。
  - 大小 **91.7 MB**
  - SHA-256 `9b3eea3eed365731a7d6f15b4ed0134cb66686e075c8b95910543b13a6f0f1b1`
  - commit `2df60527bb608e0150e05b029ae41fb50a6f8c85`（短 `2df6052`）
  - buildId `9b8daa7b2d1d`，资源哈希 `9b8daa7b2d1d5430b0d3`
  - builtAt 2026-11-13T02:55:29.142Z（10:55:29 +08）
  - 资源 **169 个**；7 个必需可靠性模块已断言存在；EXE 内 buildId 标记已验证
  - PE Manifest **requireAdministrator**（脚本断言通过；`readManifest` 复核）
- **实际启动验证**：本会话非提升，复制同一二进制并把 manifest 临时改为 asInvoker 后启动；`/api/health` 返回 `buildId=9b8daa7b2d1d`、`commit=2df6052`；`/api/bootstrap` 返回 `mode=packaged`、`verified=true`、schema 13、隔离数据目录。
- **真实任务副本 EXE 验证**：用生产库/包只读副本 + 本地 Mock Provider，在 asInvoker 测试副本中 resume `aij_01M7963928KHJGNJTD64`：模拟真实 ref/seq 错误，EXE 发出 3 次请求（initial + whole repair + viewer repair），最终 `complete` 47/47、41 semantic、0 failed；批次 1–4 未重发。测试副本与生产数据副本已删除；正式 EXE 保留。
- 旧正式 EXE 已备份到 `tests/.tmp/LiveMemory-pre-r6-backup.exe`（SHA-256 `c827a609…`，buildId `caece0818f11`），仅用于回滚，不提交。
- **仍不能声称**：真实 UAC 双击、提升后的出站请求、真实付费 Provider、生产任务 Resume 已完成验收。
- 历史：v0.13.1（`ba917c52…`）、`89bf47ac620e`、`caece0818f11` 已被本次构建取代；旧 EXE 仍可能存在于用户磁盘，必须用 buildId 判断。

## 6. 未完成 / 未验证

- 真实 UAC 双击 / 提升后的 EXE 运行未验收；asInvoker 副本已启动并验证 buildId（§5）。
- **v0.13.2 未用真实付费 API 验证** `max_completion_tokens` 是否被 DashScope 接受、思考模式是否仍默认开启、以及 24k 预算下 889 消息的 6 批是否能全部完成。
- **真实浏览器 UI 已在本轮补验**（headless Edge + CDP）：AI 中心运行中/完成、390px、暗色与 Provider 设置页；截图见 `docs/screenshots/ai-reliability-*`。未做真实点击“开始分析”（使用合成 Fixture 与 Mock Provider）。
- **真实付费 API 生成**：本机没有 `config/ai-providers.json` / `ai-keys.json` / 环境变量 Key，阻塞；不得用 Mock 或历史样本冒充。
- 真实 Provider 的 429、`Retry-After`、并发与 1,000 观众运行。
- 真实 DashScope/OpenAI/Anthropic/DeepSeek/MiniMax 生成与能力检测。
- 真实 174k token 大场的 token 分批与汇总（Mock 已覆盖 420 消息多批）。
- 真实 Bilibili/YouTube 大场自动画像；礼物/SC-only 真实样本。
- 真实运行中删除场次/清空数据的 UI 守卫与交互。
- M5 可移植备份仍未实现。

## 7. 关键规则（下一轮不要破坏）

1. `session` 与 `memory` 是独立任务、独立保存；单场报告成功不依赖画像，画像失败不覆盖报告。
2. **匿名免费 AI 已移除；手动提示词/JSON 导入入口已移除。** 只允许用户配置的 API Key + Provider。
3. `api_free` 模型永远不能执行 memory 任务；长期画像必须是付费 + 已知价格 + `capabilities.memory` + 用户 opt-in。
4. 付费/未知价格请求前必须 `confirmBilling`；未知价格不得当免费；不自动切换到更贵模型。
5. Provider 配置只保存 credentialReference；Key 只存加密凭据库；区域/Base URL 变化轮换引用。
6. 自定义 URL 必须通过私网/元数据/DNS 检查；localhost 只在显式 allowLocalNetwork 时允许。DNS 安全缓存最多 5 分钟。
7. 能力检测不能只看 HTTP 200；memory 必须用多观众 ref、证据归属、零发言与多语言探针。
8. 每位可识别观众必须有且仅有一条 `viewer_memory_updates`；缺失即导入错误。
9. 观众只分配到一个记忆批次，全部可用摘录随行；不得用 Top N 或最低活跃度裁剪。
10. 客观历史只由真实记录更新；AI 不能写金额/计数/时间/身份。导入一个 memory 批次时只更新本批分配的观众。
11. 语义事实必须有证据或明确推断/待确认；`stated` 必须有本观众的消息。
12. 无新语义 ≠ 未处理；`pending` 才是未处理。
13. 删除记忆后的旧包不能恢复；重复导入幂等。
14. 三语键三份一致；前端禁止 `innerHTML`；颜色只用 tokens。
15. 所有 Provider/模型输出必须走 `validateAnalysisImport()` + `importAnalysisResult()`；不能直接写库，不能降低 Schema。
16. 画像批次仍覆盖全部可识别观众；超出 `MAX_ANALYSIS_VIEWERS` 明确失败，不得静默裁剪。
17. **不得重新引入固定 2 RPM、匿名冷却、免费 Provider 自动切换或“手动复制 JSON”入口。**
18. 付费调度按 `configId` 隔离；没有虚构的统一 RPM/TPM。429 按 `Retry-After`，其他可重试错误指数退避 + 抖动。
19. 同一主播跨场次记忆必须按时间顺序；较旧场次不得覆盖较新场次。批次内并发只能发生在观众互不重叠的批次之间。
20. 运行失败只写状态/错误码；不删除已完成结果、不覆盖已有记忆；单场报告成功时画像失败只标 partial。
21. 手动导入失败不再由 UI 修复；历史结果仍可只读，重复导入仍幂等。
22. **超时/取消语义**：`TimeoutError` 与 `AbortError` 必须分开；已发出的长请求超时后默认不自动重发；用户取消/暂停绝不重试。
23. **任务完成优先**：没有任务时间/费用/批次总量上限；只有单请求首响应/空闲超时、单批 Token 上限与极端内存保护。错误进入 `needs_action`，保留已完成批次并可继续；用户取消立即生效。
24. **批次隔离**：任何批次失败不得 abort 同批其他在途请求；已完成批次必须继续导入；恢复只处理未完成批次。
25. **Token 分批**：单场与画像按 input token 预算分批；默认 8k、可配 2k–32k；不得静默丢消息/观众；多批 session 必须有 final aggregate 才 complete。
26. **自动流式**：普通用户不选择 Streaming；流式只缓冲，完成后仍走同一校验/事务导入；不兼容时最多回退一次并持久化响应模式。
27. **统计诚实**：成功/失败/取消/超时/重试分开；失败无 usage 显示“用量未知”，不能当零费用；能力检测请求不计入分析任务。
28. **UI 证据**：`[hidden]` 必须真正隐藏；进度只用服务端批次/观众计数；ETA 需要 ≥3 个样本；不显示没有依据的预计。

## 8. 相关文档

`docs/AI_RELIABILITY.md`、`docs/AI_TIMEOUT_INVESTIGATION.md`、`docs/AI_SCHEDULER_AUDIT.md`、
`docs/HANDOFF.md`、`docs/ARCHITECTURE.md`、`docs/DATA_MODEL.md`、`docs/AI_CONTRACT.md`、
`docs/UI_DESIGN.md`、`docs/PRIVACY_SECURITY.md`、`docs/TEST_PLAN.md`、`docs/CHANGELOG.md`、
`docs/ROADMAP.md`、历史 `docs/ANONYMOUS_AI_RESEARCH.md`、`log/2026-11-11-ai-scheduler-v0131.md`、
`log/2026-11-12-ai-reliability-v0131.md`。

## 9. 下一步

1. 配置一个真实付费 API Key，按 `docs/AI_SCHEDULER_AUDIT.md` §5 的预算/授权流程完成小规模真实测试，记录 429、延迟与费用。
2. 在允许浏览器的机器上验收五步 AI 分析中心、请求统计、暂停/取消、暗色与 390px；补截图。
3. 在无策略限制的 Windows 环境运行 EXE，验证出站请求、代理/防火墙与打包 UI。
4. 用真实 Provider 跑 1,000 观众/10,000 消息，校准初始并发与批次大小。
5. 观察真实 429 后的并发恢复；如 Provider 明确公布 RPM/TPM，再增加可选官方限额配置，不预设统一值。
6. 评估自动运行中删除场次/清空数据的 UI 守卫。
7. M5 可移植备份仍未实现。

## 11. 2026-11-12 专项调查：DashScope 174/175 秒与 `PROVIDER_TIMEOUT`

完整报告：`docs/AI_TIMEOUT_INVESTIGATION.md`（含代码位置、脱敏日志、8 项逐条回答、复现条件、
影响、修复建议、仍需日志）。

- **根因**：`timeoutMs` 默认/配置/生效值均为 **180000 ms**；非流式 `qwen3.8-max` 长推理超过
  180 秒仍无响应头，客户端 `AbortSignal.timeout` 主动断开。平台记录 status 0、耗时 174–175 s、
  usage 空，是"客户端中断"的结果，不是平台 175 s 固定超时。
- **重试**：超时被标记为可重试，`requestOnce` 自动重发同一请求 2 次（3 次尝试）；
  本地总耗时 543.18 s ≈ 3×180 s + 打包/退避。平台两条 174/175 s 请求对应第 1、2 次尝试，
  应还有第 3 条约 23:39:57 开始。
- **为何"停滞"**：3 次重试期间状态一直是 `running / session_analyzing`，没有 attempt 级状态/日志；
  第 3 次超时后才写 `failed`（23:42:54）。
- **统计口径**：UI 总/失败请求 = 调度器尝试数（按 config、按进程，重启清零）；`usage.requests`
  只计成功响应（失败任务为 null）；平台按每个 HTTP 请求计数（含 status 0、能力检测的 4 个请求）。
- **未做**：未改代码/配置/超时，未发付费 API 请求，未提交修复。本机 PATH 无 `git`，无法创建
  本地 commit。

## 10. 补丁 0.11.1：观众档案主播范围

- **问题**：观众详情页把 `/api/broadcasters` 的全部主播传给「主播范围」选择器，
  导致只出现过 1 位主播的观众也看到软件记录过的全部主播。
- **根因**：UI 的 `scopeOptions` 使用全局 broadcaster payload；详情页没有使用
  `/api/viewers/:id` 已经返回的 `profile.broadcasters`。后端 `buildViewerProfile` 在请求
  无关系主播时还会用 `getBroadcaster` 回退，制造了一个看似有效的空范围。
- **修复**：
  - 新增纯逻辑 `src/web/js/pages/viewer-scope.js`；详情选项只来自
    `profile.broadcasters`（即 `viewer_broadcasters`，包含礼物/SC/大航海等可识别互动），
    不再包含「全部主播」或未归属选项。
  - 无效/已删除的 `?broadcaster=` 安全回退到当前有效主播或第一个关联主播；
    无关联时 `null`，页面显示明确空状态。
  - 只有一个关联主播时隐藏无意义的下拉框，改为只读标签。
  - `buildViewerProfile` 无关系时返回 `scope.kind='none'`，不再回退到全局主播。
  - 长期记忆上下文只使用有效关联主播，不再回退到全局当前主播。
- **测试**：新增 `tests/unit/viewer-scope.test.mjs`、
  `tests/integration/viewer-broadcaster-scope.test.mjs`；全量 **495 passed / 0 failed**。
- **构建**：见 §5（0.11.1 重新构建）。

### 0.8 v0.13.0 付费 API Schema 故障修复（2026-11-11）

真实失败状态（隔离复现前，用户数据未修改）：

- `mode=session`，`sessionJobId` 存在，`error.code=AUTO_SCHEMA_INVALID`，detail=`protocol:SCHEMA_REQUIRED, task_id:SCHEMA_REQUIRED, session_id:SCHEMA_REQUIRED`。
- 配置实际为 DashScope `cn-beijing` / `qwen3.8-omni-flash`，`pricingStatus=paid`，`capabilities.session=true, memory=true`。
- 根因 1：UI 的 `mode=both` 在 HTTP 路由被映射成 session-only；长期画像任务从未创建。
- 根因 2：付费 Session 回答被直接交给完整 Schema 1.3.0 校验；模型只返回语义字段，缺少由本地生成的 protocol/task_id/session_id。
- 根因 3：能力检测只验证简单 JSON 形状，没有经过 Session 组装器、最终 Schema 1.3.0 和 Memory 组装器。

修复：

- `assembleSessionAnswer()` 本地注入 protocol/schema_version/analysis_scope/job_id/batch_id/task_id/session_id/locale/broadcaster_id；忽略模型伪造字段。
- `mode=both` 在 HTTP 与 Runner 规范化为内部 `combined`。
- 能力检测的 session/memory 阶段使用同一组装器并执行最终 Schema 1.3.0 校验。
- 报告页增加长期画像只读展示（`viewer_memories`/`memory_facts`）。

真实隔离端到端（不是 Mock）：

- DashScope `qwen3.8-omni-flash`，一场合成直播，`both`，2 次请求，5,671 输入 / 3,228 输出 tokens，估算 ¥0.0109928。
- `complete`；单场报告已保存；`viewer_memories=3`、`memory_facts=2`；报告 `longTermProfiles.count=3`（Mika 2 条事实，Ren/GiftOnly 客观记录）。
- 用户真实数据库未被读取为可写目标，测试使用复制的配置/密钥和独立临时数据目录，结束后删除。
