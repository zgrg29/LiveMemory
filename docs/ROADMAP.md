# 路线图（ROADMAP）

状态标记：✅ 完成 · 🟡 部分完成 · ⬜ 未开始

> **本文件回答“下一步做什么”，不是发布日志。** 当前真实状态、版本、平台与未完成项以
> `docs/STATUS.md` §0 为准；已发生的发布证据以 `docs/RELEASE_HISTORY.md` 为准。
> 下方的 P51 及更早条目是**已完成里程碑的历史记录**，其中“未发布/不发布”等字样只代表
> 当时的阶段结论，不代表最终结果。

## 当前阶段（2026-11-24）

- 🟡 **P55 / v0.19.2 本地补丁**：乱序记忆、历史状态与弱证据保护、证据去重、旧任务恢复、报告翻译参数故障已实现；专项及初步 EXE 通过，冻结源码全量与最终构建验收中。真实状态见 STATUS §0.66。
- 本轮已获本地修改/测试/构建/Commit 授权；不 Push、Tag 或发布 Release。
- 仍需单独进行真实 Provider 付费与 Windows 人工验收；不打开快手采集，不扩展平台。

## 先前阶段（2026-11-18，历史）

- ✅ **v0.19.0 已发布：AI Provider Reliability Update**。定位并修复 Base URL 尾斜杠误判、
  Key 尾部换行被拒、错误统一为「API 配置无效」、凭据写入非事务/损坏库被覆盖、自定义
  OpenCode 缺会话头、`contextLength` null 变 0。新增十语具体错误与按钮旁诊断；
  数据库 Schema（16）、Provider 协议、平台采集与 UAC/ACL 规则未变。
- ✅ **v0.18.0 已发布**：新增 OpenCode AI Provider（Pay-as-you-go / Go）。六个已发布平台与
  快手预览状态未变（快手实时 H5 采集仍默认禁用）。
- ✅ **P52 / OpenCode Provider 接入**：在既有 OpenAI-compatible 适配器上新增
  OpenCode Console，自动 Endpoint、动态模型列表、稳定 `x-opencode-session`
  （批次/重试/恢复复用、任务隔离）、价格可选；未改其他 Provider、数据库 Schema（16）、
  金额/身份/去重与平台采集。**真实 Key 付费验收未完成**（无 Key）。
- ⬜ **等待用户决定下一轮方向**。以下候选不是已授权计划：

  1. **OpenCode 真实付费验收**：Pay-as-you-go 的真实推理、429/5xx、账单与 `usage.cost`；
     Go 套餐的真实可用性。需要用户提供 Key 与费用授权。
  2. **快手书面许可 / 官方接口**：取得前保持采集禁用；取得后重新做 G3–G5 验收。
  3. **真实 Windows 人工验收**：双击 UAC（同意/拒绝）、干净账户、文件对话框、Ctrl+C。
  4. **其他 Provider 补验**：OpenAI / Anthropic / MiniMax / 百炼 / OpenRouter / 自定义。
  5. **用户反馈专项（已随 v0.19.0 发布）**：Provider 切换重输 Key 仍是安全设计；
     自定义 OpenCode 会话头已修复；AppData 删除权限已定位为运行中占用/跨管理员账户 ACL，
     见 `docs/WINDOWS_RUNTIME.md` §4.2。保存流程修复见 `docs/STATUS.md` §0.62/§0.63。
  6. **未观测事件与长测**：Twitch Bits/赠订、抖音真实礼物、TikTok 礼物、Kick 自然
     下播→再开播；继续标 `NOT-OBSERVED`，不得用 Mock 代替。
  7. **新平台**：必须按 `docs/PLATFORM_ADMISSION.md` 的 G0–G6 执行；不得为增加数量降低标准。

- 🚫 **未授权事项**：不打开快手生产采集、不改许可证、不改已确认的产品原则；
  后续发布仍需用户明确授权。新平台没有通过 G0 不得写代码。

## 已完成里程碑（历史，P51 及更早，倒序）

> 以下内容保留历史证据与决策。版本号、测试数量、平台数量与“未发布”状态均以
> `docs/STATUS.md` §0 与 `docs/RELEASE_HISTORY.md` 为准。

> v0.13.3（2026-11-16，TIKTOK-M6 合并 main）：开发者已在普通 Windows 桌面完成多直播间人工验收，正式批准合并。`feature/tiktok` 以 `--no-ff` 合并到本地 main，合并提交 `980de0f`（父 `410bfc3` + `e992534`），合并后树与功能分支一致。合并后全量 **1034 passed / 0 failed / 0 skipped**；main 重建 EXE Build ID `e48016f19362`（commit `980de0f`，SHA-256 `1b8cbe63…`，requireAdministrator），`verify-exe` 10/10、`verify-tiktok-exe` 22/22 + 2 NOT-OBSERVED、`verify-tiktok-multi-exe` 17/17。真实礼物/连送/订阅仍 **NOT-OBSERVED**；未 Push、未 Tag、未 Release、未删除功能分支。详见 `docs/STATUS.md` §0.44。
> v0.13.3（2026-11-16，TIKTOK-M6）：允许同一平台多个**不同** TikTok 直播间并发记录。真实根因是 TikTok 面板把「存在任意 TikTok 记录」当成「该房间重复」，全局禁用开始按钮；后端 `SessionManager`/adapter 一直支持多场。修复收窄为同一 `platformRoomId`，新增逐场活动列表与独立停止；正式界面删除模拟直播标签/面板/顶部按钮，保留 `MockLiveSource` 与 `/api/simulate/*` 作为测试夹具。真实双房间 EXE `@aljazeeraenglish` + `@aljazeera` **17/17**（A 4 条 / B 1 条真实 chat，停 A 后 B 继续 1→2），全量 **1034 passed**；EXE `e48016f19362`（commit `4224f7c`，`96,730,112` B，requireAdministrator）。礼物仍 **NOT-OBSERVED**。**未合并 main、未 Push/Tag/Release。** 详见 `docs/STATUS.md` §0.43。
> v0.13.3（2026-11-16，TIKTOK-M5）：TikTok 统一为**唯一匿名本地 webcast WebSocket 采集**：只使用任何访客都会获得的匿名 `ttwid`，不需要账号/扫码登录/Cookie 导入/浏览器中继，也不依赖付费或免费社区签名服务。新增 `webcast.mjs`、`local-adapter.mjs`、`state.mjs`、`legacy-cleanup.mjs`，重写 `service.mjs`；删除 TikTok 扫码登录、登录状态 UI、专用浏览器 Profile、浏览器中继、免费社区签名通道与通道选择；`/api/tiktok/login/*`、`/api/tiktok/transport` 现返回 404，`tiktokTransport` 设置被拒绝。UI 只保留链接/检查/开始/停止/自动监听与四项独立状态。真实 30 分钟长测与正式 EXE 验收通过；**真实礼物/连送/订阅 NOT-OBSERVED**（本轮在播房间无礼物）。协议为非官方、无续传游标。**未合并 main、未 Push/Tag/Release。** 详见 `docs/STATUS.md` §0.42。
> v0.13.2（2026-11-16，TIKTOK-M4）：真实 Windows EXE 登录后 `room/enter` 403 调查。确认 403 来自官方直播页自身请求，不是本地映射；旧实现误判为登录失效并提前中止，且把 `PushFrame` 当 `WebcastResponse` 解析，真实事件恒为 0。M4 改为「真实帧优先、403 宽限、登录/直播间访问分离」；补齐 `captureState`/`lastCapture`、停止状态、三语键与监控映射。定向 TikTok **103 passed**；全量 **1050 passed / 0 failed / 0 skipped**；`verify-exe` **10/10**、`verify-tiktok-exe` **23/23**（真实 6 chat / 3 可识别观众）。真实登录后浏览器端到端仍 **BLOCKED**（DSH 终止 Chromium）。仅研究报告 `tiklive` 本地 unsigned webcast 方案（35 秒 469 chat / 19 gift），未接入。EXE `a463acfad051`（commit `ea950c0`，`97,893,888` B，`requireAdministrator`）。**未合并 main、未 Push/Tag/Release。** 详见 `docs/STATUS.md` §0.41。
> v0.13.2（2026-11-15，TIKTOK-M3）：修复真实桌面验收的阻断问题。浏览器中继可用性误查 `relay.start`（真实类只有 `createAdapter`），导致登录和 room check 成功后仍返回 `TIKTOK_NOT_CONFIGURED` 503；已改为 `createAdapter` 并将显式 browser 从 signer 依赖中解耦。同步修复浏览器中继丢弃礼物、关闭登录窗口生命周期、`needs_room` 验证反馈与五项状态分离。新增 9 测试，全量 **1037 passed / 0 failed**；`verify-tiktok-exe` **23/23**（含 EXE 内 browser 通道识别与 6 条真实 chat）；真实登录后浏览器投递仍因沙箱终止 Chromium 而 **BLOCKED**，待人工验收。正式 EXE `e11f4008b9e3`（commit `1b9a38b`，`97,867,776` B，`requireAdministrator`）。**未合并 main、未 Push/Tag/Release。** 详见 `docs/STATUS.md` §0.40。
> v0.13.2（2026-11-15，TIKTOK-M2）：修复免费社区签名通道频繁重连。匿名 429 的真实上限是 **30 次/小时**；M1 15 秒轮询约 7.5 分钟用尽，`Retry-After: 2708` 又被截断到 30 秒。M2 新增共享预算（130 秒/请求、多房间共享、完整遵守 `Retry-After`），状态机区分 `rate_limited` 与 `failed`；浏览器登录生命周期与专用 profile；真实 30 分钟 **146 条 chat / 49 位可识别观众 / 146 个 msgId / 0 重连 / 0 限流**；全量 **1028 passed**；EXE `a97447fe6329`，`verify-tiktok-exe` **21/21**。真实浏览器登录/扫码 **BLOCKED**，待普通 Windows 桌面验收。**未合并 main、未 Push/Tag/Release。** 详见 `docs/STATUS.md` §0.39。
> v0.13.2（2026-11-15，TIKTOK-M1）：先把已验收的抖音合并到 `main`（`410bfc3`，合并后全量 947 passed，四平台真实回归通过），再从最新 main 创建 `feature/tiktok`。TikTok 接入采用双传输：默认**免费社区签名通道**（无 API Key、无付费、不要求 Business；15 秒轮询，平台突发上限 5 次/分钟），可选**浏览器中继**（专用 Chrome/EDGE 资料目录 + CDP，匿名 `room/enter 403` 如实报“需要登录”）。房间信息/开播/主播稳定 ID/礼物目录完全本地免费；真实聊天 6/6 带 `tiktok:<user.id>` 与 `msgId`；礼物/连送/订阅已解析但真实事件未观测。新增 56 测试，全量 **1003 passed**；正式 EXE `812c0d54f622`（requireAdministrator，97,718,784 B，SHA-256 `3a3e7c59…`，commit `3e6e7d8`），`verify-tiktok-exe` **20/20**。**未合并 TikTok 到 main、未 Push/Tag/Release，等待人工验收。** 详见 `docs/STATUS.md` §0.38、`docs/TIKTOK_FEASIBILITY_2026-11.md`。
> v0.13.2（2026-11-15，DOUYIN-LOGIN-FIX）：修复抖音登录验收问题。纯 HTTP 扫码确认不可行（SSO 返回 HTML 指纹页、passport 返回 `4031`）；改为本机 Chrome/Edge + 专用资料目录 + 官方登录页 + CDP，应用内显示官网二维码；真实 Chrome 捕获 **8/8**（未扫码）。区分 Cookie 格式/不完整/过期/平台拒绝/网络/无效；三语 12 步 Cookie 教程；扫码/会话/连接/礼物四级状态。全量 **944 passed / 0 failed**；EXE `a0bc7f9136df` / commit `6f7f0d6` / requireAdministrator；EXE 验收 **25/27**（2 项浏览器启动被 DSH 作业对象阻止）；`verify-exe` 10/10、`verify-twitch-exe` 20/20。**未合并 main、未 Push/Tag/Release；真实手机扫码与真实 Cookie 正向待人工验收。** 详见 `docs/STATUS.md` §0.36、`docs/DOUYIN_LOGIN_RESEARCH.md`。
> v0.13.2（2026-11-15，DOUYIN-M2M3）：先合并已验收的 Twitch（`main` = `d5e9a7c`，合并后全量 875 passed），再从最新 main 创建 `feature/douyin`，完成抖音公开直播间匿名单播采集：昵称、稳定 UID（`douyin:<user.id>`）、弹幕原文、Unicode、消息 ID、去重、断线重连、两次离线确认、多房间隔离、自动开播、SQLite、AI 读取与长期画像；礼物解析（连送只在 `repeatEnd=1` 写一条、钻石只作展示价值、无金额不记 0）、登录框架（扫码被风控阻止时如实报错 + 本地加密 Cookie 备用）、三语 UI（64 键 × 3）。真实匿名采集 7 条 chat（7/7 UID/昵称/消息 ID/CJK）与正式 EXE 2 条；**真实礼物与真实扫码登录未验证**。新增 48 测试；正式 EXE `0f848c77c2d6`（requireAdministrator）；`verify-douyin-exe` **17/17**。**未合并抖音到 main、未 Push/Tag/Release，等待人工验收。** 详见 `docs/STATUS.md` §0.35、`docs/PLATFORM_INTEGRATIONS.md` §3B、`docs/LICENSE_AGPL_DOUYIN.md`。
> v0.13.2（2026-11-15，TWITCH-M1）：Twitch 正式接入（匿名 IRC + 公开元数据），真实 6 频道并发 418 条事件、418/418 有稳定 User ID + 消息 ID、1 条真实 resub；Bits/赠订已解析但真实事件未观测；新增 47 测试，全量 875 passed；正式 EXE `a4bf602de264`（`requireAdministrator`，96,828,416 B）；EXE Twitch 验证 20/20，既有矩阵全部通过。**已按开发者授权合并到 main（`d5e9a7c`）；未 Push/Tag/Release。** 详见 `docs/STATUS.md` §0.34。
> v0.13.2（2026-11-14，RC0-ADMIN-MANIFEST）：恢复正式 EXE 双击自动请求管理员权限。RT_MANIFEST 从 `asInvoker` 改为 **`requireAdministrator`**：Windows 显示标准 UAC，同意后提权启动，拒绝即取消；不右键、不绕过 UAC。构建注入前后双重断言；自动化因无法接受 UAC，改用测试专用 asInvoker 副本运行功能场景，正式 EXE 单独断言 Manifest。未改 Bootstrap 目录选择与任何业务逻辑；API 认证、Origin/Host/SSE、凭据与备份恢复规则不变。全量 **828 passed / 0 failed**；`verify-exe` 10/10、`verify-help-exe` 14/14、`verify-p0-5-exe` 12/12、`verify-p0-2-exe` 13/13、`verify-ai-token-exe` 16/16；正式 EXE `e438e74803cb`。**真实 UAC 双击待用户验收；未 Push/Tag/Release。** 完整说明见 `docs/STATUS.md` §0.31 与 `docs/WINDOWS_RUNTIME.md` §13。
> v0.13.2（2026-11-14，RC0-USAGE-GUIDE）：内置三语使用说明与 RC0 封版。侧栏新增「使用说明 / 使い方 / User guide」（`#/help`），覆盖首次启动、Bilibili/YouTube 连接、记录与历史、Provider 与 API Key、单场分析与长期画像、长期记忆与证据、进度与失败继续、备份/恢复/迁移、FAQ（8 条）；112 个 `help.*` 键三语一致；只读、无 API 调用、无新增使用限制、无强制审核。新增 9 项 UI 测试；全量 **828 passed / 0 failed**；正式 EXE `74ed76e88a51`（asInvoker，`96,733,184` B）`verify-help-exe` 14/14、`verify-exe` 10/10。真实浏览器截图因本机沙箱禁止 Chromium mojo 未执行，由 DOM 渲染与打包资源检查覆盖。**未 Push/Tag/Release，等待用户决定。** 完整说明见 `docs/STATUS.md` §0.30。
> v0.13.2（2026-11-14，RC0-AI-EFFICIENCY）：Token 归因、重复输入、动态分批与成本口径。缓存/推理 Token 归因、逐尝试 token 账本、无 usage 请求不再消失；删除三处可证明的重复输入（structured-output Provider 的 schema、画像重复示例、契约逐观众数组）；画像观众上限从写死 10 改为"偏好 10、按预算最多 20"；三语界面显示重试开销占比与每百观众/每百事实 Token，无价格时明确「费用未知」。14 场景基线：请求 -30.6%、总 Token（按实测字节模拟）-10.1%、覆盖与事实完全不变；781 自动化测试。完整说明见 `docs/AI_TOKEN_EFFICIENCY.md`、`docs/STATUS.md` §0.26、`docs/HANDOFF.md` §0 与 `log/2026-11-14-ai-token-efficiency.md`。
> v0.13.2（2026-11-14，RC0-FINAL-ACCEPTANCE）：最终综合验收。修复无证据 `confirm+stated` 提升（P0-A）与旧导入路径跨观众证据（P0-B）；819 自动化测试；正式 EXE `7016d4295d0e`（commit `996f992`，asInvoker）10/10 + 12/12 + 13/13 + 16/16 + YouTube 生命周期；真实 Bilibili 5050 与 YouTube Sky News 采集、真实 Chrome + EXE 认证。长期画像语义质量仍未达标（严格召回 15%–30%，错误 stated 25%–31%），同 topic 静默 confirm 为 P1。建议 RC0 小范围闭源内测，不建议公开发布。完整报告 `docs/RC0_FINAL_ACCEPTANCE.md`。
> v0.13.2（2026-11-14，RC0 P0-2）：完整备份、恢复与跨电脑迁移。新增 `.livememory` v1（STORE ZIP + manifest + SHA-256/CRC + schema/format 兼容检查）、SQLite `VACUUM INTO` 一致快照、事务化恢复 + `runtime/restore-journal.json` 崩溃回滚、ZIP Slip/压缩炸弹/超大/损坏/未来版本拒绝、三语设置页备份/预览/验证/恢复/进度/取消；备份明确排除 API Key 与平台登录。24 个专项测试、全量通过；正式 EXE 完成“备份 → 全新目录恢复 → 重启 → 再次备份”闭环。完整说明见 `docs/BACKUP_FORMAT.md`、`docs/BACKUP_RESTORE.md`、`docs/STATUS.md` §0.25、`docs/HANDOFF.md` §0 与 `log/2026-11-14-backup-restore-p02.md`。
> v0.13.2（2026-11-14，RC0 P0-5）：本地 HTTP API 会话认证 + 发布 EXE 改为 `asInvoker`。除 health/auth 外所有 `/api/*`（含 SSE）要求启动器建立的一次性 fragment token → `HttpOnly; SameSite=Strict` Cookie；`Origin:null`/伪造 Origin/恶意 Host/跨站元数据拒绝；重启旧凭据失效；删除管理员检查。正式 EXE `75588ba16aec` 在 Low Mandatory Level 直接启动，12/12 安全矩阵 + 10/10 功能矩阵通过。完整说明见 `docs/STATUS.md` §0.24、`docs/HANDOFF.md` §0 与 `log/2026-11-14-local-api-auth-p0.md`。
> v0.13.2（2026-11-14，RC0 P0-4）：YouTube 暂时性故障不再误判直播结束；429/5xx/断网/异常 200 进入可恢复重连，连续失败只进入可恢复 `failed` 并继续退避；缺 `continuationContents` 改为 invalid；stale continuation 先重取再 poll；观看页两次 ended 或聊天明确关闭才结束；UI 显示重连/最近故障/数据保留。10 个 unit + 2 个 integration 专项、721 自动化测试；Bilibili 53 项生命周期回归通过；正式 EXE `59b7928cb78a`（commit `31886b2`）asInvoker 副本 + 本地假 YouTube 实跑 3 分钟断连 → 同 session 恢复 → 去重 → `platform_ended`。完整说明见 `docs/STATUS.md` §0.23、`docs/HANDOFF.md` §0-A 与 `log/2026-11-14-youtube-lifecycle-p0.md`。
> v0.13.2（2026-11-14，RC0 P0-1）：AI 定向补答回归修复；补答按缺失子集校验并与首答合并，失败时保留首答合法观众、只把缺失观众标 `failed`；补答附带缺失观众摘录；10 个新回归、708 自动化测试；正式 EXE `e441070b57b5` + 生产数据只读副本 Mock 回放 88/89 → 重启 Resume → 89/89。完整说明见 `docs/STATUS.md` §0.22、`docs/HANDOFF.md` §0 与 `log/2026-11-14-ai-memory-supplement-p0.md`。
> v0.13.2（2026-11-13）：长期画像输出预算与动态分批、`finish_reason=length` 与空响应分类、有界拆分/预算提升、观众级 `split_path` 断点恢复（schema 16）、UI/统计；真实 975 人任务只读副本回放 975/975；正式 EXE buildId `4b697b2cb227` 实跑同一任务 100/100、975/975；698 自动化测试。完整说明见 `docs/STATUS.md` §0.21 与 `docs/HANDOFF.md` §0。
> v0.13.2（2026-11-13）：可扩展分层汇总；schema 15 `ai_aggregate_nodes`；32 批真实任务只读副本恢复为 2 个局部节点 + final；正式 EXE buildId `58362fa30b5f` 实跑验证；683 自动化测试。完整说明见 `docs/STATUS.md` §0.20 与 `docs/HANDOFF.md` §0.6。
> v0.13.2（2026-11-13）：最终汇总截断修复、独立 12k–16k 汇总预算、有界汇总契约、`recovery` 状态与「继续最终汇总」恢复面板、API/输出统计分离；668 自动化测试。完整说明见 `docs/STATUS.md` §0.19 与 `docs/HANDOFF.md` §0.6。
> v0.13.2（2026-11-13）：AI 分析输出语言与已保存报告翻译；新增 schema 14 翻译缓存、段落级按需翻译/重试、长期画像多语言展示；649 自动化测试。完整说明见 `docs/STATUS.md` §0.18 与 `docs/HANDOFF.md` §0.7。
> v0.13.2（2026-11-13）：长期画像统一校验链、身份白名单、分批次错误、三语/语言 Prompt、统计口径与 usage 归属修复；新增 17 个回归测试。完整说明见 `docs/STATUS.md` §0.16 与 `docs/HANDOFF.md` §0。
> v0.13.2（2026-11-12）：观众身份专项审计；Bilibili 未登录打码/uid=0 被确认为平台风控，新增「可识别观众」统一口径与未识别消息警告；canonical 层拒绝 uid=0 建档。完整报告 `docs/AUDIT_VIEWER_IDENTITY_2026-11-12.md`。
> v0.13.2（2026-11-12）：构建标识、缓存逐文件校验、默认 24k 分批、aggregate/repair/单观众请求上限。
> 仍未完成：P0-3 的**其他 Provider** 真实付费验收。DeepSeek `deepseek-flash` 已完成 L3 验收（能力检测、单场 + 画像、100 观众 Resume、日语；50 次请求、估算 $0.2553）；OpenAI / Anthropic / DashScope / OpenRouter / MiniMax / 自定义仍为 L2/L4，必须分别授权。20 人批次因真实事实保留率仅 73%/51% 已回退为默认 10。真实官方账单、取消请求计费、真实 EXE Key 流程、真实 YouTube 断网/429、真实浏览器点击/关闭窗口、登录后是否 100% 解除 Bilibili 打码仍未实测。P0-1/P0-2/P0-4/P0-5 与 RC0-AI-EFFICIENCY 代码级与正式 EXE 级已关闭。

> v0.14.0 规划轮（2026-11-16，I18N/PLATFORM）：**只做规划、调查与文档，不改业务代码、不新增语言、不接入新平台、不打包、不发布。** 核实当前国际化真实结构（三语、每份字典 2,265 键、键集与占位符零差异），确认「界面语言」与「AI 输出语言」目前是默认耦合且无独立持久设置；定位到真实缺口（两份语言清单、3 项 Header 语言控件、`max-width:132px`、`LOCALE_NAME` 三语、`dedupe_key` 语言相关）。调查 Kick 三个候选开源项目（kixo / Kick-Live-Connector / kick-api）并确认官方 API 无「读取聊天」能力。新增 `docs/I18N.md`、`docs/PLATFORM_ADMISSION.md`、`docs/PLATFORM_EXPANSION_RESEARCH.md`。详见 `docs/STATUS.md` §0.45。

> v0.14.0 正式发布（2026-11-16，Multi-Platform Release）：五平台版本封版。产品版本 `0.13.3` → `0.14.0`，Tag `v0.14.0` 指向 `d268cf9`，GitHub Release 已发布。EXE Build ID `17f84b1956e1` / SHA-256 `6862079a…` / 97,769,984 bytes / `requireAdministrator`；发布包 `LiveMemory-v0.14.0-windows-x64.zip`（35,977,845 bytes / SHA-256 `5d7b7e65…`）。验收：**687 unit + 347 integration = 1034 passed**；`verify-exe` 10/10、`verify-p0-2-exe` 13/13、`verify-ai-token-exe` 16/16。TikTok 礼物/连送/订阅、抖音真实礼物、Twitch Bits/赠订仍 **NOT-OBSERVED**。**十语言、独立 AI 输出语言与 Kick 等新平台均为后续规划，不在本版。** 详见 `docs/STATUS.md` §0.46、`docs/RELEASE_HISTORY.md`（v0.14.0）。

> v0.15.0 开发线（2026-11-16，P39 / I18N-M0）：**国际化基础架构整理完成，未新增语言、未发布。** 新增单一语言清单 `src/shared/locales.mjs`（Node 与浏览器同源），语言解析改为「用户偏好 / 系统检测 / 实际已安装资源」三层 + 语言族/script/region 逐级降级；`zh-HK` 当前安全降级 `zh-CN`，未来加入 `zh-TW` 后自动优先。Header 语言控件改为由 `/api/bootstrap` 动态生成：三种语言保持原三段按钮交互，>3 项或长名称自动使用原生下拉；删除 `max-width:132px/112px`。真实浏览器 **9/9** 布局截图通过（三语 1440/390 + 十语言夹具 1440/1024/820/390/黑暗），全量 **711 unit + 349 integration = 1060 passed / 0 failed**，三语 2,265 键/占位符零差异。P41 长期画像跨语言策略已由用户确定为**方案 B（允许混合并接受跨语言重复）**，仅记录文档，未改代码/DB/AI。**未 Push、未 Tag、未 Release。**

> v0.15.0 开发线（2026-11-16，P41 / I18N-M2）：**十语言 AI 输出完成，未发布。** 注册表十条 `aiOutput: true`；新增 `src/ai/prompts/language.mjs` 作为输出语言规则的唯一来源（rule/guard/system/repair/example × 10），六个 prompt 面全部注入并带 `OUTPUT LANGUAGE (<code>)`；三套已验证指令正文保留，其余七语用英文正文 + 各自输出语言规则（单次请求仍只含当前语言）。新增独立持久设置 `aiOutputLocale`（默认 `follow-ui`，`config/settings.json`，已同步备份白名单与设置页），任务创建写入 `ai_jobs.locale` 快照并在恢复时以 job 行为准；结果 Schema `locale.enum` 扩到十项，字段名/枚举/稳定标识不变。长期画像按方案 B 落地（跨语言事实共存、同字符 topic 仍去重、历史事实不翻译覆盖）。**747 unit + 355 integration = 1102 passed / 0 failed**；真实 DeepSeek Provider：4 语单场报告通过、`ko` 7 条韩语事实、`de` 7 条德语事实。**未 Push、未 Tag、未 Release。** 详见 `docs/I18N.md` §2.8、`docs/STATUS.md` §0.49。

> v0.15.0 正式发布（2026-11-17，10-Language Internationalization）：十语言国际化正式封版并发布。
> P39–P42 全部合并到 `main`，产品版本 `0.14.0` → **`0.15.0`**，Tag `v0.15.0`，GitHub Release 已发布；
> 十份字典各 **2,271** 键、十语言 AI 输出、独立 `aiOutputLocale`、十语言阅读翻译与启动器；
> 五平台与数据库 Schema（16）未变，**未新增直播平台**。详见 `docs/STATUS.md` §0.51。

## P51 快手 H5 预览接入：组件完成、生产采集禁用（2026-11-17）⚠️ 已发布为预览 · 采集禁用

- ✅ 用户明确指示：停止登录 WebSocket 研究，**只采用 G1 已验证的匿名 H5**；不实现扫码登录、签名、设备指纹、验证码、TLS 伪装、代理或浏览器中继。
- ✅ 集成：`src/platforms/kuaishou/`（link / policy / http / transport / messages / status / adapter / service）、路由 `/api/kuaishou/*`、capabilities `state:'preview'`、监控 detector、30 天保留、十语 UI、AI 分析包与长期画像（会话内）。
- ✅ 数据：仅 `comment` → `chat`；`external_id=NULL`；`viewer_uid=h5:<rawUserId>@<sessionId>`；`source_quality=unknown`；礼物/点赞 **NOT-OBSERVED**，不映射。
- ✅ 门禁：默认 `access.enabled=false`；`connect` 在任何网络请求前 403；`room` 在禁用时只本地解析；UI 始终展示要求的告知。内部启用需同时设置 `LIVEMEMORY_KUAISHOU_H5_OPT_IN=1` 与 `LIVEMEMORY_KUAISHOU_AUTHORIZATION_ACK`。
- ✅ 自动监控：`MONITOR_PLATFORMS` 增加 `kuaishou`；基础 120 秒；目标键 `eid`；循环键 `kuaishou:<eid>:<liveStreamId>`；feed 601 权威结束，房间页连续 2 次 offline 结束，rate_limited/unknown 不结束。
- ✅ 十语言：10 × **2,351** 键，新增 47 键，键集/占位符 0 差异。
- ⚠️ 验收：全部 fake fetch / 研究样本；**真实 H5 未执行**；真实许可下长测、跨场身份、真实下播→再开播均未验证。
- ⚠️ **发布结果**：开发阶段按 G6 阻塞处理（不 Push/Tag/Release）；后续经用户授权，快手预览组件已随
  **v0.17.0 正式发布**，但实时 H5 采集仍默认禁用，不得写成“已支持快手采集”。
- 📄 `docs/KUAISHOU_H5_INTEGRATION.md`；`docs/release-notes/v0.17.0.md`；`docs/RELEASE_CHECKLIST_v0.17.0.md`；`docs/RELEASE_HISTORY.md`。

## P50 快手 G1.6：登录态 WebSocket 复测（2026-11-17）❌ 结论 E · 停止正式接入

- ✅ **第二次真人扫码登录成功**：`qr/start → scanResult=1 → acceptResult=1 → passToken →`
  直播站换票 `result=1` → `userLogin=1`；未实现签名/设备指纹/验证码/TLS 伪装。
- ❌ **WS token 被 gate**：登录后重新取 `home/list`，对 8 个最新在播房间
  （最高 9,427 watching）逐个请求 `websocketinfo`，**8/8 HTTP 200 `result:2`、0 token、0 URL**。
- ✅ **排除旧 ID/下播/全站限流**：同会话 `home/list` 正常（48 房间）；G1.5 `gift-list` 曾返回 token；
  只有 token 端点一致拒绝。
- ✅ **研究缺陷修正**：`home/list` 是轮播推荐列表（连续请求房间不同），缺席不再判 `offline`，
  改为 `unknown + NOT_IN_RECOMMENDATION_SNAPSHOT`；单测 **10/10**。
- ❌ **授权未取得**：官方条款要求书面许可；`open.kuaishou.com` 的弹幕玩法接口是
  app_id + roomCode + sign、面向已入驻玩法开发者，不是任意公开主播聊天读取 API。
- ⛔ **不进入 G2**：不新增 `src/platforms/kuaishou/`，不加路由/UI/监控/DB，不构建候选 EXE，
  不重新启用 H5，不 Push/Tag/Release。
- ✅ 回归：原型 **10/10**；全量 **1,177 passed / 0 failed / 0 skipped**（326,590 ms）；
  十份字典各 2,304 键，键集一致。
- 📄 `docs/KUAISHOU_G1_6_WEBSOCKET_BLOCKED.md`；`research/kuaishou-g1_5/live-probe.mjs`；
  脱敏证据 `evidence/g1.6-websocket-probe.json`。
- ⬜ 等待用户：向快手申请书面许可/官方接口；在明确允许范围前保持 E。

## P49 快手 G1.5 匿名 H5 + 登录 WebSocket 双模式验证（2026-11-17）✅ 验证完成 · 结论 D

- ❌ **匿名 H5 判 POLICY-BLOCKED**：官方《快手软件许可及服务协议》七、1.1 / 七、1.4 / 八、1 / 十、1
  明文禁止以机器人、蜘蛛或未授权第三方工具监视、复制、读取平台内容，数据使用需**书面许可**；
  H5 `robots.txt` 仍 `User-agent: * Disallow: /`。**不得作为正式默认采集器**，不再发起新的 H5 请求。
- ✅ **正常扫码登录端到端真实成功（首次）**：无签名 `qr/start` → 真人扫码 → `acceptResult=1` →
  `passToken` → 直播站换票 `result=1` → `userLogin=1`（`live.web_st/_ph`）；
  **未实现** sig4、设备指纹、webweapon、验证码求解、TLS 伪装。
- ⚠️ **登录后 WS token 未验证**：`websocketinfo` `result:2`、无 token，但使用 7 分钟前的旧
  `liveStreamId`，目标 18:44 已下播 → 不能判定“签名是唯一障碍”，也不能判定“平台拒绝”。
  已修复方法缺陷：连接前必须重新确认在播，旧 ID 默认拒绝；复测命令见报告 §5.3。
- ❌ **身份/礼物/再开播仍无证据**：跨场/跨日/跨路线均未证明；礼物/点赞/分享 CODE-SUPPORTED 但
  NOT-OBSERVED；`h5:` / `ws:` 命名空间强制隔离，只有显式证据才允许合并。
- ✅ **开播监控**：匿名 `home/list` 两次 48 个在播房间；修复“无顶层 result 被误判为错误”的缺陷；
  “从列表消失=下播”真实观察；真实再开播未观察；未接生产 `MonitoringManager`。
- ❌ **不进入 G2**：H5 授权不允许；WS 监听未验证；身份/礼物/长测缺证据；且即使 WS 通过仍缺平台许可。
- 📄 `docs/KUAISHOU_G1_5_DUAL_MODE.md`；代码 `research/kuaishou-g1_5/`；单测 **10/10**。
- ⬜ 等待用户决定：是否做一次修正后的扫码复测；是否向快手申请书面许可。

## P48 快手 G1 登录态 WS / 匿名 H5 双路线验证（2026-11-17）✅ 验证完成 · 结论 C

- ✅ **匿名 H5 复测可用**：3 房间/45 秒 6 条，昵称/数字 userId/时间/头像 **100%**、消息 ID **0%**、重复 0；
  2 小时 3 房间长测 **555 条 / 229 用户 / 0 重复 / 0 HTTP 错误**，20 秒断网对照见报告 §9。
- ✅ **真实下播已观察**：`juedidatou` 约 13 分钟后 `result:601` / “直播已停止”；再开播未观察。
- ✅ **扫码登录第一步无签名可用**：`qr/start` 返回 `result:1` + PNG；`scanResult`/`acceptResult`
  未扫码返回 `707`，不是 400013；完整登录仍缺真人扫码 → **[未执行]**。
- ✅ **catbus 源码审查**：登录/WS/心跳/重连/事件/任意房间/会话过期全部读完；
  其 sig4、设备指纹、webweapon、**滑块自动求解**、`wreq-js` TLS 伪装不可复用。
- ✅ **登录 WS 也无消息 ID**；礼物/点赞/分享仅 CODE-SUPPORTED，关注/进入/撤回 UNSUPPORTED。
- ⚠️ **最高风险不变**：H5 `robots.txt` `Disallow: /`；SSR 出现“请求过快”软限流；条款未审。
- ❌ **不进入 G2**：跨场稳定 ID、真实登录 WS、礼物、真实再开播都未验证；两条路线均未通过独立准入。
- 📄 `docs/KUAISHOU_G1_POC.md`；脚本 `research/kuaishou-g1/probe.mjs`；评分 A 68 / B 55。
- ⬜ 等待用户决定：是否授权一次真人扫码的 G1.5；若否/不合规则保持 C。

## P47 快手 G0 技术调查（2026-11-17）✅ 调查完成 · 结论 B

- ✅ **找到免登录实时公开聊天路径**：快手 H5 `GET /wap/live/feed?liveStreamId=&cursor=`，
  无 Cookie/签名/登录/浏览器；3 秒增量，cursor 重放 0 重复。
- ✅ 真实样本 **126 条**（主样本 91 条 / 5 个在播房间，其中 3 个并发）：昵称、数字 `userId`、毫秒 `time`、
  公开头像 **100%**；消息 ID **0%**；事件仅 `comment`（礼物 **NOT-OBSERVED**）。
- ✅ 公开直播间 SSR `liveStream.id` 判断在播/不在播；真实下播→再开播 **未观测**。
- ✅ 桌面 WS + protobuf（字段最全）确认要求**登录票据 + `__NS_hxfalcon` 签名**；
  匿名 `websocketinfo`/`livedetail` 返回 `result:2` → **不满足条件一，不接入**。
- ⚠️ **最高风险**：`livev.m.chenzhongtech.com/robots.txt` 对 `User-agent: *` 为 `Disallow: /`；
  产品化前必须做条款/合规判断；若不允许 → **C（暂缓）**。
- ⚠️ **长期画像限制**：`userId` 跨场/跨日稳定性未验证；不得直接声称 `kuaishou:<id>` 稳定。
- 📄 完整报告 `docs/KUAISHOU_G0_FEASIBILITY.md`；脚本 `research/kuaishou-g0/`；
  评分 **78/100**；**未接入生产代码、未改 v0.16.0、未 Push/Tag/Release**。
- ⬜ 等待用户/法务决定是否允许自动访问 H5 域名，再决定是否进入 G1。

## P46 v0.15.0 十语言正式发布（2026-11-17）🚀

- ✅ 合并：`feature/p42-i18n-m3` 以 `--no-ff` 合并到 `main`（合并提交 `37a075e1f0e726742c9133dad8a4dad232effc6b`），
  合并后 `main` 树与功能分支完全一致，P39–P42 共 16 个提交全部包含
- ✅ 版本统一：`package.json` / `APP_VERSION` / EXE 版本信息 / 启动器 / 应用内版本信息 /
  CHANGELOG / ROADMAP / STATUS / 发布说明全部为 **`0.15.0`**；
  修正历史文档中 P41「v0.15.1」与 P42「v0.16.0」的版本标签不一致
- ✅ 发布前检查：EXE Manifest `requireAdministrator`、十语言启动器、十份字典与十语言 AI 能力、
  版本号与资源完整（真实双击 UAC 与干净账户仍需人工验收）
- ✅ 回归：**747 unit + 355 integration = 1102 passed / 0 failed / 0 skipped**（`--test-isolation=none`，合计 292,904 ms；单元单独 747 passed / 13,754 ms）；十语言字典 / Schema / `ai-i18n-locales` / `ai-i18n-translation` 全部通过
- ✅ 正式 EXE：Build ID `945bee868455`、`99,200,512` bytes、
  SHA-256 `b8458ab75704ebedc44fc64ebe000ddf97828687bf1af7896266b219469c826e`、Manifest `requireAdministrator`；
  `verify-exe` / `verify-help-exe` / `verify-ai-token-exe`：`verify-exe` **11/11**、`verify-help-exe` **14/14**、`verify-ai-token-exe` **16/16**
- ✅ Release：`LiveMemory v0.15.0 — 10-Language Internationalization`，
  https://github.com/zgrg29/LiveMemory/releases/tag/v0.15.0
- ⬜ 真实双击 UAC（同意/拒绝）、干净 Windows 账户、母语审校、Twitch/抖音真实采集：仍需人工或在播房间
- ⬜ **不启动** v0.16.0 规划与任何新直播平台开发，等待用户下一步指令

## P45 v0.14.0 五平台正式发布（2026-11-16）🚀

- ✅ 版本决策：`0.14.0`（相对 `v0.13.2-rc.0` 新增 Twitch / 抖音 / TikTok 三平台，SemVer minor）
- ✅ 版本号同步：`package.json`、`src/shared/app-info.mjs`、CHANGELOG、STATUS、release notes
- ✅ 全量自动化：**687 unit + 347 integration = 1034 passed / 0 failed / 0 skipped**
- ✅ EXE 验收：`verify-exe` **10/10**、`verify-p0-2-exe` **13/13**、`verify-ai-token-exe` **16/16**
- ✅ 正式 EXE：Build ID `17f84b1956e1`、97,769,984 bytes、SHA-256 `6862079a…`、Manifest `requireAdministrator`
- ✅ 发布包：`LiveMemory-v0.14.0-windows-x64.zip`（35,977,845 bytes / SHA-256 `5d7b7e65…`），
  含 EXE / README / LICENSE / RELEASE_NOTES / SHA256SUMS，逐项校验通过，无密钥与用户数据
- ✅ Tag `v0.14.0` → `d268cf9`；GitHub Release 与 Tag 一致；未创建重复 Tag/Release
- ⬜ 真实双击 UAC、干净 Windows 环境、真实手机扫码、真实礼物：仍需人工或事件触发，未宣称通过

## P38 I18N/PLATFORM 规划：十语言与平台准入规范（v0.14.0 规划，2026-11-16）✅

- ✅ 只读调查：`src/web/i18n/*.json`（三语、2,265 键/份）、`src/web/js/i18n.js`、`src/shared/locale.mjs`、
  `src/launcher/cli-i18n.mjs`、`src/ai/prompts/*`、`src/ai/api/prompts.mjs`、`src/ai/translation/*`、
  `src/memory/model.mjs`、`src/server/settings-store.mjs`、`src/server/backup/settings.mjs`
- ✅ 实测三份字典键集完全一致、占位符差异 0（`node` 脚本比对，未落盘）
- ✅ 定位 L2 缺口：`src/web/js/pages/ai.js:198` 默认 `ctx.locale`；无 `aiOutputLocale` 设置
- ✅ 定位合并键风险：`dedupeKeyFor()` = `kind:normalizeTopic(topic)`，`normalizeTopic()` 不翻译
- ✅ 定位布局风险：`components.css:665` `max-width:132px`；`app.js:39` 三段按钮仅 3 项
- ✅ 新增 `docs/I18N.md`（三层语言模型、8 项技术调查结论、M-I18N-0..3 里程碑、翻译流程与门禁）
- ✅ 新增 `docs/PLATFORM_ADMISSION.md`（三准入条件、字段最低要求、登录优先序、G0–G6 门禁、暂停条件、许可证策略）
- ✅ 新增 `docs/PLATFORM_EXPANSION_RESEARCH.md`（候选顺序、Kick 深度预研、其他平台调查清单、待验证清单）
- ✅ 更新 `AGENTS.md` §2/§4/§6.16/§6.17/§7/§10/§11（长期约束）
- ⬜ 未新增语言、未接入平台、未改任何业务代码（本轮边界）

## P39 I18N-M0：国际化架构整理（v0.15.0 开发线，2026-11-16）✅ 完成，未发布

目标：拆掉「三语假设」，**不新增语言**即可独立验收。

- ✅ 单一语言清单 `src/shared/locales.mjs`：语言码、原生名、英文名、语言族、script、regions、`available`、默认 `en`；
  Node 与浏览器引用同一文件（`/shared/locales.mjs`）
- ✅ 所有选择器/常量从清单派生：Header、设置页、AI 输出语言、报告阅读语言、`src/ai/constants.mjs`、
  `src/memory/constants.mjs`、翻译 `LOCALE_NAME`
- ✅ 可用性驱动降级：`resolveLocale(..., {available})` + `detectInstalledLocales()` 检查真实字典；
  `zh-HK`→当前 `zh-CN`、未来 `zh-TW`；`pt-PT`→`pt-BR`（有资源时）；`in`→`id`；未知→`en`
- ✅ 区分用户偏好 / 系统检测 / 实际资源；合法旧配置原样加载，不因资源缺失重写
- ✅ Header 动态生成：3 项保持原三段按钮 + 系统按钮，>3 项或长名称自动原生下拉；≤860px 折叠行为不变
- ✅ 布局：删除 `.language-select` 的 `max-width:132px` / `112px`；真实浏览器十语言无截断/重叠/横向溢出
- ✅ 资源缺失：字典 404/损坏回退默认一次，默认失败显示既有错误页，不白屏
- ✅ 测试：新增 `locale-registry` / `i18n-locale-api`，扩展 `locale` / `i18n` / `header-language` / `settings-store`；
  十语言夹具 `tests/fixtures/locales-10.mjs` 与 `i18n-header-10.html`（不进入产品）
- ✅ 全量 **711 unit + 349 integration = 1060 passed / 0 failed / 0 skipped**
- ✅ 真实浏览器 UI **9/9**：`docs/screenshots/i18n-p39-*.png`
- ✅ Windows EXE：Build ID `18df5c272a98`（commit `ba0ff26`，`97,788,416` B，SHA-256 `691c4f00…`，
  `requireAdministrator`）；`verify-exe` **11/11**（新增 i18n 资源场景）
- ⬜ 未新增七语言、未改 AI 输出语言设置（P41）、未改长期画像代码/DB、未发布
- 详见 `docs/I18N.md` §2、`docs/STATUS.md` §0.47

## P40 I18N-M1：十语言界面与启动器（v0.15.0）✅（2026-11-16，未发布）

目标：`ko` / `es` / `pt-BR` / `zh-TW` / `fr` / `de` / `id` 七份字典 100% 对齐，界面与启动器十语言。

- ✅ 术语表：`docs/i18n/GLOSSARY.md`（50 核心术语 × 10 语言 + 18 动作词 + 10 风格卡 + 不翻译清单 + 门禁）
- ✅ 7 份新字典，各 **2,265** 叶子键；键集缺失 0 / 多余 0、占位符差异 0、空值 0、无整句英文残留
- ✅ 注册表 10 条 + `aiOutput` 能力位；`AVAILABLE_LOCALES`（10）与 `AI_OUTPUT_LOCALES`（3）同源派生
- ✅ 语言控件：3 项仍为分段按钮；十项自动原生下拉；设置页/AI 下拉同源；原生名只用自身文字
- ✅ 降级：`zh-HK`/`zh-MO`/`zh-Hant`→`zh-TW`、`pt-PT`→`pt-BR`、`in`→`id`、未知→`en`；旧三语配置原样可用
- ✅ 启动器：`cli-i18n.mjs` 十语（61 键/语言）、`{locales}` 由注册表填充、ASCII 安全回退；
  SEA 引导器十语言失败消息
- ✅ AI 安全收窄：分析/记忆任务 locale、报告/翻译只读接口、Schema `enum` 全部限定在 `AI_OUTPUT_LOCALES`，
  未支持语言永不发往 Provider（**没有提前实现 P41**）
- ✅ 真实浏览器：十语言 × 1440/1024/820/390 × 明暗 × 主要页面，见 `docs/I18N.md` §2.6.4
- ⬜ 未做：`aiOutputLocale` 设置、十语提示词/结果 Schema/翻译目标（P41）；平台采集/DB/画像未改；未 Push/Tag/Release
- 详见 `docs/I18N.md` §2.6、`docs/STATUS.md` §0.48、`log/2026-11-16-p40-i18n-m1.md`


## P41 I18N-M2：AI 输出语言解耦与十语言支持（v0.15.0）✅ 2026-11-16

目标：L2 独立、持久、任务内不可变，跨语言不破坏长期画像。

- ✅ 前置：P39/P40 完成；长期画像跨语言策略按**方案 B** 落地（允许混合语言事实、接受跨语言语义重复；
  不锁首次语言、不做跨语言合并/别名表/DB 迁移；现有同语言去重不变）
- ✅ 十语言 AI 输出：注册表十条 `aiOutput: true`；提示词/结果 Schema/翻译目标/LOCALE_NAME 全部十语
- ✅ 提示词国际化：新模块 `src/ai/prompts/language.mjs`（rule/guard/system/repair/example）；
  三套已验证完整正文保留，其余七语复用英文正文 + 各自输出语言规则；每个 prompt 面都可断言 `OUTPUT LANGUAGE (<code>)`
- ✅ 独立设置 `aiOutputLocale`（默认 `follow-ui`）+ 备份白名单 + 设置页卡片 + bootstrap 原始/生效值 + 非法值 400
- ✅ 任务语言快照：创建时写 `ai_jobs.locale`，恢复以 job 行为准，改界面/改偏好/暂停/重启都不改旧任务
- ✅ 报告阅读翻译：9 个非源语言目标各自独立缓存行，原文/证据/结构化字段不变
- ✅ 回归：**747 unit + 355 integration = 1102 passed / 0 failed / 0 skipped**
- ✅ 真实 Provider（DeepSeek `deepseek-flash`）：单场报告 `ko`/`zh-TW`/`de`/`pt-BR` 4/4 通过；
  长期画像 `ko` 7 条韩语事实、`de` 7 条德语事实；跨语言续写按 guard 复用原 topic（方案 B 成立）
- ⬜ 未做：发布/Push/Tag；数据库 Schema（仍 16）；P42 的十语言 UI/EXE 全矩阵
- 详见 `docs/I18N.md` §2.8、`docs/STATUS.md` §0.49、`log/2026-11-16-p41-i18n-m2.md`

## P42 I18N-M3：十语言 UI/EXE 与回归验收（v0.15.0）✅ 2026-11-16，已随 v0.15.0 发布

目标：十语言在真实 Windows EXE 上完成整体验收。

- ✅ 真实 Provider：10 语单场 **10/10**、10 语画像 **10/10**、跨语言 zh→ko→de→zh **4/4**、
  阅读翻译 5 语 **5/5** + 失败回退；正式取证 31 次请求 / 100,487 input + 17,491 output tokens
- ✅ 方案 B：跨语言事实共存、旧事实 0 删除、跨观众证据 0、同语言去重不变
- ✅ 语言独立性：7 组界面/AI 组合、固定输出不随界面变、重启保留、`follow-ui`、非法值 400
- ✅ 任务恢复：韩语任务暂停 → 界面德语 + AI 西班牙语 → 重启 → 恢复仍韩语（`ai-i18n-locales` 4/4）
- ✅ 真实 EXE：Build `5b9e355dccc7`、commit `310975e`、99,200,512 B、SHA-256 `7c3f3d3f…`、`requireAdministrator`；
  `verify-exe` 11/11、`verify-help-exe` 14/14、`verify-ai-token-exe` 16/16
- ✅ 真实浏览器：源码 **440/440**、EXE 内服务 **440/440**；40 + 40 张截图
- ✅ 旧 schema-15 数据升级到 16：计数/hash 全一致、settings 未改写、旧报告可读、备份→恢复计数一致
- ✅ 五平台：Bilibili/YouTube/TikTok 真实采集通过；Twitch 无在播频道、抖音无真实房间，均如实标未验证
- ✅ 修复：十语言 help 的「不需要管理员权限」说明、三处测试工具假阴性、浏览器脚本 EXE 模式
- ✅ 全量 **747 unit + 355 integration = 1102 passed / 0 failed / 0 skipped**
- ⬜ 真实双击 UAC、干净 Windows 账户、母语审校、Twitch/抖音真实采集仍待人工/在播房间
- ✅ 已随 **v0.15.0** 合并 `main`、打 Tag 并发布（原「未 Push / Merge main / Tag / Release」状态已结束；
  版本号已由发布轮的 0.14.0 更新为 0.15.0）
- 详见 `docs/STATUS.md` §0.50、`docs/I18N.md` §2.9、`log/2026-11-16-p42-i18n-m3.md`

## P43 KICK-G2–G6：Kick 正式接入、开播监控与 v0.16.0 发布 ✅ 已发布

- ✅ G1（2026-11-17）：双直播间 966 秒、1,936 条真实聊天；字段 100%、0 重复/0 串台
- ✅ G2：`KickService` + `/api/kick/{status,room,connect,disconnect,retention/apply}` + capabilities；
  KICKs 礼物（交易 ID、sender.id、KICKs 数量、无金额）、赠订（赠送者 + 接收者、无身份）；
  多房间隔离、停止、30 天保留；历史/画像/AI 复用既有管线
- ✅ G3：直播页第六个平台页签；十语 2,304 键；真实浏览器 20/20（10 语 × 4 宽度 × 明暗，真实 2 场）
- ✅ G4：70.2 分钟真实长测；34,766 聊天、3,438 观众、0 重复、7 次真实重连、**1 次真实 token 刷新**；
  全量 1,169 passed / 0 failed
- ✅ G5：候选 EXE Build ID `5314bd79a0f3`、99,329,024 B、`verify-kick-exe` 19/19；
  正式 EXE `requireAdministrator`，自动化使用同 Build ID 的 asInvoker 副本
- ✅ **G5.1 开播监控**（2026-11-17）：Kick 接入共用 `MonitoringManager`（90s 轮询、抖动、退避、
  手动停止抑制、重启恢复）；新增 Kick detector；适配器连续 2 次确认 offline 才结束 session；
  真实服务验收 16/16（离线 xqc、开播自动记录、双频道、重启、手动停止）、十语 UI 20/20、
  EXE 27/27（含监控）；全量 1,177 passed
- ✅ **G6 正式发布**（2026-11-17）：合并 `main`（`4a2bcd6`，--no-ff）；版本 `0.16.0`；
  正式 EXE Build ID `ac0daca067b3`、99,342,336 B、SHA-256 `d6c39ee2…`、`verify-kick-exe` 27/27；
  Tag `v0.16.0`；GitHub Release **Published**（`LiveMemory v0.16.0 — Kick Support & Auto Live Monitoring`）；
  全量 1,177 passed；PE VERSIONINFO 仍显示 Node 运行时（已记录，未破坏 EXE）
- 未观测：真实下播/下一次开播窗口（集成测试覆盖状态机；G4 有真实 odablock 下播）；
  订阅/续订、开播下播事件、Host、投票（`NOT-OBSERVED`）；关注仅官方 webhook → 本地不支持
- 详见 `docs/KICK_G2_G5_ACCEPTANCE.md`、`docs/KICK_G5_1_MONITORING.md`、`docs/KICK_G1_ACCEPTANCE.md`、
  `docs/release-notes/v0.16.0.md`

## P44 PLATFORM-EXPANSION：候选平台调查与准入评估（持续）🟡

调查优先级（**不是无条件开发承诺**，命中暂停条件即跳过）：

1. Kick 🟢 G5 完成、等待试玩与 G6 判断｜2. 虎牙 ⬜｜3. 斗鱼 ⬜｜4. CHZZK ⬜（官方 API 违反条件一）｜
5. SOOP ⬜｜6. 快手 ⬜｜7. Niconico ⬜（很可能需登录）｜8. 小红书 ⬜（未发现维护中实现）｜
9. YY 直播 ⬜（未发现维护中实现）｜10. Facebook Live ⬜（预判不满足条件一）

- 每个平台必须顺序通过 G0–G6，门禁与暂停条件见 `docs/PLATFORM_ADMISSION.md`
- 礼物、打赏、订阅是**可选增强**，不得因缺少礼物否决一个能取到用户名与实时聊天的平台
- 未验证一律标「待验证」，未观测事件一律标 `NOT-OBSERVED`

## P37 TIKTOK-M6 人工验收与合并 main（v0.13.3，2026-11-16）🟢

- ✅ 开发者已在普通 Windows 桌面亲自完成 TikTok 多直播间人工验收：可同时创建并采集多个不同
  TikTok LIVE；不再出现只能记录一场的问题；体验符合预期
- ✅ 本地 `--no-ff` 合并：合并提交 `980de0f`，父 `410bfc3`（原 main）+ `e992534`（feature/tiktok）
- ✅ 合并后树与 `feature/tiktok` 完全一致；无冲突，未覆盖 Bilibili / YouTube / Twitch / 抖音
- ✅ 合并后全量：**687 unit + 347 integration = 1034 passed / 0 failed / 0 skipped**
- ✅ 五平台路由/适配器/打包全部存在；SQLite schema 16、AI/analytics 无 diff；三语 i18n 通过
- ✅ 模拟直播入口已从正式 UI 移除；历史模拟记录仍可读
- ✅ `main` 重建 EXE：Build ID `e48016f19362` / commit `980de0f` / `96,730,112` B /
  SHA-256 `1b8cbe63…` / requireAdministrator；`verify-exe` 10/10
- ✅ `verify-tiktok-exe` 22/22 + 2 NOT-OBSERVED；`verify-tiktok-multi-exe` 17/17
  （A 1 条 / B 2 条真实 chat，停 A 后 B 2→3）
- 🟡 真实礼物/连送/订阅仍 **NOT-OBSERVED**；长期多房间压力、真实网卡断线/下播长跑未执行
- ⬜ 未 Push、未创建 Tag、未发布 Release、未删除功能分支

## P36 TIKTOK-M6：TikTok 多直播间并发与模拟直播清理（v0.13.3，2026-11-16）🟢 真实双房间 + EXE 已验收

- ✅ 真实根因：不是 `SessionManager`/adapter 单例，而是 TikTok 面板用 `!tiktokActiveRecording()`
  把「存在任意 TikTok 记录」当成「该房间重复」，全局禁用开始按钮
- ✅ 重复判断收窄到同一 `platformRoomId`（handle 回退）；服务端 `SESSION_DUPLICATE_ROOM` 保留
- ✅ 每场独立 session/room/WebSocket/连接状态/事件流/去重/重连/下播判断/SQLite/AI
- ✅ 新建记录页与 TikTok 面板新增活动列表：主播、平台、状态、消息数、观众数、查看、独立停止
- ✅ 正式 UI 删除模拟直播标签、面板、顶部按钮与启动器模拟提示；默认平台改为 Bilibili
- ✅ 保留 `MockLiveSource`、`SessionManager.startSimulation()`、`/api/simulate/*` 与全部测试夹具
- ✅ 历史 mock 数据、SQLite schema 16、AI 契约与提示词未变；修正 `history.aiTitle` 原始键
- ✅ 五个平台审查：Bilibili / YouTube / Twitch / 抖音无同平台全局限制，未做无意义重构
- ✅ 自动化 **1034 passed / 0 failed / 0 skipped**（687 unit + 347 integration）
- ✅ 真实双房间 EXE：`@aljazeeraenglish` + `@aljazeera`，**17/17 passed**；A 4 条 / B 1 条真实 chat；
  停 A 后 B 继续 1→2；重复 A 409；两场 AI report 200
- ✅ `verify-exe` **10/10**；`verify-tiktok-exe` **22/22 + 2 NOT-OBSERVED**
- ✅ EXE：`e48016f19362` / commit `4224f7c` / `96,730,112` B / SHA-256 `02acd0b1…` / requireAdministrator
- 🟡 真实礼物/连送/订阅仍 **NOT-OBSERVED**；真实网卡断网、真实下播长跑、干净 Windows 账户与真实 UAC 双击待人工验收
- ⬜ 未合并 main、未 Push、未 Tag、未 Release

## P35 TIKTOK-M5：匿名本地 WebSocket 统一采集（v0.13.3，2026-11-16）🟢 真实 30 分钟 + EXE 已验收

- ✅ 源码与合规审查：`talkaboutdesign/tiklive`（MIT）实际源码、许可证、依赖、连接/解析/重连；
  Effect 4 + Bun 无法嵌入零依赖 Node SEA → 按其协议用原生 Node 重写，未复制源码
- ✅ 唯一采集路径：匿名 `ttwid` + `webcast-ws.tiktok.com` PushFrame → 既有 mapper → 统一 `EventIngest`
- ✅ 无需登录、无需浏览器、不依赖付费或免费签名服务、无 API Key、无新增运行时依赖
- ✅ 真实 30 分钟连续采集 + 强制断线自动重连；帧/事件分离；UID/msgId/重复/静默/请求数上报
- ✅ 删除扫码登录、登录状态、专用浏览器 Profile、浏览器中继、社区签名通道与通道选择
- ✅ 旧 Profile 安全清理：仅带 `.livememory-owned` 标记的目录 + 自有 `login-state.json`
- ✅ UI：四项独立状态（直播间识别 / 采集连接 / 真实事件 / 正式记录）+ 高级技术详情；三语一致
- ✅ 抖音登录、其他四平台、SQLite schema、AI 契约均未改动
- 🟡 真实礼物/连送/订阅 **NOT-OBSERVED**（本轮在播房间没有礼物；只有合成帧 + 集成测试）
- 🟡 真实第二直播间并发、真实断网、干净 Windows 账户与真实 UAC 双击待人工验收
- ⬜ 未合并 main、未 Push、未 Tag、未 Release

## P34 TIKTOK-M4：浏览器中继真实 403 与完整链路审计（v0.13.2，2026-11-16）🟡 真实登录后端到端 BLOCKED

- ✅ 真实 403 定位：官方直播页自身 `POST /webcast/room/enter/` → HTTP 403；中继通过 `Network.responseReceived` 观察，不是本地映射
- ✅ 根因 1：403 被误判为登录失效并立即中止 → 改为 6 秒宽限、真实帧优先、`TIKTOK_ROOM_REFUSED`
- ✅ 根因 2：`PushFrame` 被当作 `WebcastResponse` 解析 → 真实帧恒 0 条；M4 先解 field 8（gzip 批次）
- ✅ 根因 3：登录/直播间访问/采集状态混用 → `roomAccess`、`captureState`、`lastCapture` 分离
- ✅ UI：五项状态；记录中采集失败/未确认；登录成功但直播间拒绝；停止后 `stopped`；补 `tiktokCaptureStateIdle` 等三语键
- ✅ 回归：403+事件、403+无事件、运行中 403、浏览器关闭重连、登录过期、重新登录、通道切换、PushFrame→SQLite、三语键
- ✅ 定向 TikTok **103 passed**；全量 **1050 passed / 0 failed / 0 skipped**；`verify-exe` 10/10、`verify-tiktok-exe` 23/23（真实 6 chat / 3 可识别观众）
- 🟡 **BLOCKED**：真实登录后浏览器事件投递；DSH 无法启动 Chromium（`verify-tiktok-browser-login` 1/9，8 blocked）
- 🟡 免费本地方案：仅研究 `tiklive`（MIT）匿名 webcast，35 秒 469 chat/19 gift；非公开协议，未接入，需产品/合规决策
- ✅ 新 EXE：`a463acfad051` / commit `ea950c0` / `97,893,888` B / SHA-256 `fecf18ce…` / requireAdministrator
- ⬜ 未合并 main、未 Push、未 Tag、未 Release

## P33 TIKTOK-M3：浏览器中继「采集尚未配置」修复（v0.13.2，2026-11-15）🟡 等待人工验收

- ✅ 主因：`transport()` 误查 `browserRelay.start`（真实类只有 `createAdapter`），显式 browser 时 `active=null` → `TIKTOK_NOT_CONFIGURED` 503
- ✅ 真实复现：真实 relay + fake login/room → `active=null`；测试假 relay 的 `start()` 掩盖缺陷
- ✅ 修复：改查 `createAdapter`；显式 browser 不依赖 signer；仅确实无通道时才用 `NOT_CONFIGURED`
- ✅ 登录状态：持久化 `logged_in` 只作提示；真实 200/事件回写登录，真实 403 回写 `refused`
- ✅ 关闭窗口：保留登录并标记 `revalidationRequired`；采集中只关登录 tab，不终止专用浏览器；采集中拒绝退出
- ✅ 验证按钮：无直播间返回 `needs_room`（不污染登录）；按钮下方显示原因/事件数/room-enter 状态/时间
- ✅ 五项状态分开：登录 / 直播间识别 / 采集连接 / 真实事件 / 开始记录
- ✅ 浏览器中继礼物：按 `groupKey` 合并最终态、10 秒冲刷，写入统一 `EventIngest`
- ✅ 自动化：新增 9 项；定向 TikTok **90 passed**；全量 **1037 passed / 0 failed / 0 skipped（504,497.50 ms）**
- ✅ `verify-exe` **10/10**；`verify-tiktok-exe` **23/23**，含 EXE 内 browser 通道识别
- ✅ 真实 TikTok：6 chat / 5 唯一身份 / 6/6 UID+msgId+原文；自动监听 6 条；重启保留；AI report 200
- ✅ 新 EXE：`e11f4008b9e3` / commit `1b9a38b` / SHA-256 `8ee91aa8…` / `97,867,776` B / requireAdministrator
- 🟡 **BLOCKED**：真实登录后的浏览器中继弹幕/礼物投递；DSH 沙箱在 DevTools 端口前终止 Chromium（`verify-tiktok-browser-login` 1/9 pass，8 blocked）
- ⬜ 未合并 main、未 Push、未 Tag、未 Release

## P32 TIKTOK-M2：连接稳定性、浏览器登录与真实 EXE 验收（v0.13.2，2026-11-15）🟡 等待人工验收

- ✅ 根因（真实 429）：匿名签名通道有 **30 次/小时** 账号/IP 上限；M1 15 秒轮询约 7.5 分钟用尽，随后把 `Retry-After: 2708` 截断为 30 秒，形成整小时重试
- ✅ `TikTokRateBudget`：进程内共享预算；匿名 130 秒/请求；完整遵守 `ratelimit-*`/`Retry-After`；多房间共享
- ✅ 适配器状态机：`rate_limited` 独立于 `failed`；单飞轮询；失效 cursor 重置并重校验房间；房间 ID 变化；gap 时间线；0 消息批次不代表失败
- ✅ 真实短测：`aljazeeraenglish` 3 分钟 24 条 chat / 11 位可识别观众 / 24/24 UID + msgId / 0 重连 / 2 次请求
- ✅ 真实 30 分钟长测：146 chat / 49 viewers / 146 个不同 msgId / 146/146 UID / 63 条非 ASCII / 0 重连 / 0 限流 / 14 次请求
- ✅ 浏览器登录生命周期：官方 `tiktok.com/login`；二维码/手机/邮箱由用户完成；`idle/opening/waiting/verifying/logged_in/expired/refused/unavailable/error`
- ✅ 单窗口/复用/关闭恢复：单飞行锁、专用 profile marker、仅管理 LiveMemory profile；停止采集只关自己的 tab
- ✅ 登录与采集分开：`logged_in` 不等于收到弹幕；`verify` 返回 `events_received`/`connected_no_events`/`login_required`/`platform_refused`
- ✅ 三语 UI：采集方式、是否需要登录、最近弹幕、重连次数、最近故障、下次重试、免费额度；错误就地显示，技术详情折叠
- ✅ 自动化：**1028 passed / 0 failed / 0 skipped（508,176.15 ms）**；rate-budget 5、reconnect 6、browser-login 8、signer +5、session +1、UI/API 认证
- ✅ 真实回归：Bilibili 4 chat/3 viewers；YouTube 51 chat/51 channel id/1 gift；Twitch EXE 20/20；抖音 EXE 25/27（2 项沙箱浏览器）
- ✅ 最新 EXE：`a97447fe6329` / commit `607e5cd` / SHA-256 `aca70bd6…` / `97,831,936` B / requireAdministrator；`verify-exe` 10/10、`verify-tiktok-exe` 21/21
- 🟡 **BLOCKED**：DSH 沙箱从 Node 启动 Chromium 被作业对象终止（`0x80000003`）；真实扫码/登录/登录后弹幕必须普通 Windows 桌面人工验收
- 🟡 未验证：真实礼物/连送/订阅、真实断网、真实下播长跑、多房间真实并发、干净 Windows 账户、真实 UAC 双击
- ⬜ 未合并 main、未 Push、未 Tag、未 Release

## P31 TIKTOK-M1：TikTok LIVE 接入、双传输与 Windows EXE（v0.13.2，2026-11-15）🟡 等待人工验收

- ✅ 前置：`feature/douyin` 本地合并到 `main`（`410bfc3`，父 `d5e9a7c` + `e3cf6e7`）；合并后全量 947 passed
- ✅ 合并后四平台真实回归：Bilibili 3/3、YouTube 55/55、Twitch 13/13、抖音 3/3，全部 `ended`
- ✅ 从最新 main 创建 `feature/tiktok`；所有 TikTok 开发在该分支
- ✅ 可行性（真实）：房间信息/开播/主播稳定 ID/礼物目录（809 个）完全本地免费
- ✅ 可行性（真实阻断）：官方网页匿名 `room/enter 403`；未登录直连推送 WS 被拒；移动端不可用
- ✅ 可行性（真实可用）：免费社区签名通道取得真实 `WebcastChatMessage`（6/6 带 `user.id` + `msgId`）
- ✅ 传输 A：`signer.mjs`（无 Key/无付费；15 秒轮询；429 退避；`baseUrl` 可换自建）
- ✅ 传输 B：`browser-relay.mjs`（专用 Chrome/Edge + CDP + WS 帧；匿名 403 → `TIKTOK_LOGIN_REQUIRED`；登录后未验证）
- ✅ 统一管线：chat/gift/membership → `EventIngest`；`tiktok:<user.id>`；msgId 去重；连送最终态 + 超时冲刷
- ✅ 金额：钻石只写 `amount_display`，`amount_minor=null`、`value_kind=unknown`；连送不重复计数
- ✅ 监控：公开接口开播检测、周期键 `tiktok:<handle>:<roomId>`、90 秒基准、2 秒请求间隔
- ✅ 多房间：两房间独立 session 集成测试；真实并发受 5 次/分钟签名突发限制
- ✅ 三语 UI：TikTok Tab、传输选择、能力边界、30 天保留；39 个 `tiktok` 键 ×3 + 16 个错误键
- ✅ 新增 56 测试；全量 **1003 passed / 0 failed / 0 skipped（326,436 ms）**
- ✅ 真实端到端：源码服务器 6 条 chat / 5 身份；正式 EXE 6 条 / 3 身份，SQLite 6/6 external_id
- ✅ 正式 EXE `812c0d54f622` / SHA-256 `3a3e7c59…` / `97,718,784` B / `requireAdministrator` / 226 assets / 50 modules
- ✅ `verify-tiktok-exe` **20/20**；`verify-exe` **10/10**
- 🟡 **未验证**：真实礼物/连送/订阅事件、登录后浏览器中继、真实断网/下播、多房间并发、干净 Windows 账户、真实 UAC 双击
- ⬜ 等待开发者人工验收；未合并 main、未 Push/Tag/Release

## P30 DOUYIN-SINGLE-WINDOW：重复浏览器窗口修复（v0.13.2，2026-11-15）🟡 等待人工验收

- ✅ 真实 EXE 日志定位：直接 spawn Chrome 退出 0 无 DevTools，随后 PowerShell 回退再启动一次
- ✅ Windows 只走一次 PowerShell；启动前只清理专用 Profile 的孤儿 Chrome
- ✅ 同步 `startPromise` 锁；初始化期间第二次点击只返回状态并 `Page.bringToFront`
- ✅ 启动后记录 `browser.pid`；同一专用 Profile 的已有窗口复用（同 port/PID）；移除 `--new-window`
- ✅ 关闭串行化并清理 `DevToolsActivePort`/`browser.pid`；只管理 `.livememory-owned` Profile
- ✅ 真实 Chrome 12/12：单次 1 窗口、再次点击 0 launch、并发双击 1 window、reuse 1 window
- ✅ 全量 947 passed / 0 failed；`verify-exe` 10/10；`verify-douyin-exe` 25/27（2 项沙箱浏览器限制）
- ✅ 正式 EXE `d37c8f262dc4` / commit `75c574c` / SHA-256 `c3b1fa8b…` / requireAdministrator
- 🟡 **未验证**：EXE 内实际窗口数量（DSH 沙箱作业对象阻止 Chrome）、真实手机扫码复验
- ⬜ 等待开发者普通桌面人工验收；未合并 main、未 Push/Tag/Release

## P29 DOUYIN-LOGIN-FIX：浏览器扫码登录、Cookie 验证与礼物分级（v0.13.2，2026-11-15）🟡 等待人工验收

- ✅ 技术调查：5 个项目实际登录源码（VideoNote-MCP MIT、douyin-mcp PolyForm 非商业、douyin-parse/dousub 无许可证、bytedance-nomark GPL-3.0）
- ✅ 确认纯 HTTP 扫码不可行：SSO 返回 HTML 指纹页；passport `get_qrcode` 返回 `4031`；不伪造/绕过
- ✅ 本机 Chrome/Edge + 专用 profile + 官方登录页 + CDP；应用内显示官网二维码；`is_frontier`/验证码交用户
- ✅ Cookie 格式/不完整/过期/平台拒绝/网络/无效分类；平台验证通过才 `logged_in`，否则 `saved_unverified`
- ✅ 三语 12 步 Cookie 教程 + Firefox 差异 + 排查 + AES-256-GCM 本地保护说明
- ✅ 扫码/会话/连接/礼物四级状态；匿名礼物标「未观测」，不写成功或失败
- ✅ 真实 Chrome 二维码捕获 8/8（未扫码）；EXE 验收 25/27（2 项浏览器启动被 DSH 作业对象阻止）
- ✅ 全量 944 passed / 0 failed；`verify-exe` 10/10、`verify-twitch-exe` 20/20
- ✅ 正式 EXE `a0bc7f9136df` / commit `6f7f0d6` / SHA-256 `48cc1227…` / requireAdministrator
- 🟡 **未验证**：真实手机扫码成功、真实 Cookie 正向、登录后礼物推送、真实礼物/连送、干净 Windows 账户
- ⬜ 等待开发者人工验收；未合并 main、未 Push/Tag/Release

## P28 DOUYIN-M2M3：抖音接入、登录框架与礼物解析（v0.13.2，2026-11-15）🟡 等待人工验收

- ✅ 前置：`feature/twitch` 合并到 main（`d5e9a7c`）；合并后全量 875 passed；未 Push/Tag/Release
- ✅ 分支 `feature/douyin`（从 `d5e9a7c` 创建）；所有抖音开发在该分支
- ✅ 公开页解析：`web_rid` → 内部 `room_id`、`status` 2/4、标题、主播 id/secUid/昵称、在线数
- ✅ 自研 protobuf（无依赖、BigInt 保精度）、gzip、签名 WSS、5 秒心跳/ack、90 秒看门狗
- ✅ 昵称只显示；稳定身份 `douyin:<user.id>`；消息 `msgId` 去重；Unicode/Emoji 原文
- ✅ 礼物：`repeatEnd=1` 才写一条；连送按 groupId 合并；`amount_minor=null`、`value_kind=unknown`；
  钻石只写 `amount_display`；无金额不记 0 元；Member/Like/Follow 不写付费
- ✅ 登录框架：受控扫码 → 重定向换 `sessionid` → AES-GCM 本地保存；状态检查/过期/退出；
  平台风控阻止时 `DOUYIN_LOGIN_BLOCKED` + 显式本地 Cookie 备用；**真实扫码未成功**
- ✅ 自动开播（90 秒基准、60–150 秒抖动、Douyin-only pacer）；两次离线确认；1→30 秒退避重连
- ✅ 多房间独立 adapter/session；同一 `platform+room` 拒绝重复
- ✅ 64 个 `douyin` 键 × 三语；直播页抖音 Tab；登录/保留/能力边界说明
- ✅ 新增 48 测试（URL、protobuf、消息、礼物、连送、登录、重连、自动开播、多房间、SQLite、AI 包、UI）
- ✅ 真实匿名采集：源码路径 7 条 chat（7/7 UID/昵称/消息 ID/CJK、0 重复）；正式 EXE 2 条
- ✅ 正式 EXE `0f848c77c2d6` / `requireAdministrator` / 214 files / 39 modules；`verify-douyin-exe` **17/17**
- 🟡 **未验证**：真实礼物、真实连送、真实付费留言、真实扫码登录、登录后礼物推送、真实断网/下播、10+ 房间压力
- 🟡 AGPL-3.0 签名组件已独立标注；主项目 MIT 未改；EXE 分发须履行 AGPL 源码义务
- ⬜ 等待开发者人工验收；验收通过并再次授权后才合并 main

## P27 TWITCH-M1：Twitch 正式接入与 Windows EXE（v0.13.2，2026-11-15）🟡 等待人工验收

- ✅ 独立分支 `feature/twitch`（从 `21a5bf5` 创建）；代码提交 `7da0e0d`；未合并 main/Push/Tag/Release
- ✅ 匿名 IRC 公开聊天 + 公开频道元数据；无需 Twitch 登录、OAuth、API Key、Cookie 或付费采集服务
- ✅ 稳定身份 `user-id` → `twitch:<id>`；消息 `id` 去重；Unicode/Emoji 原样；`/me` 只去 ACTION 包装
- ✅ 订阅/续订 `USERNOTICE` → `membership`；赠订 `subgift` → `gift`（赠送者付款）；`submysterygift` 跳过防重复计数
- ✅ Bits/Cheer → `super_chat`，只记数量与 `amount_display`；`amount_minor=null`、`value_kind=unknown`，不换算收入
- ✅ 自动开播监听（120 秒基准、90–180 秒抖动、`stream.id` 周期键）；两次离线确认下播；断线 1→30 秒退避
- ✅ 多频道独立 adapter/session；真实 6 频道并发 60 秒 418 条事件、418/418 有 User ID + 消息 ID、304 身份、1 条真实 resub
- ✅ 新增 47 项测试；全量 **875 passed / 0 failed / 0 skipped（253,002 ms）**
- ✅ 正式 EXE `a4bf602de264` / SHA-256 `6a90f564…` / `96,828,416` B / `requireAdministrator`
- ✅ `verify-twitch-exe` **20/20**（真实 Twitch、自动监听、重启、AI 读取、Bilibili/YouTube 状态）
- ✅ 既有 EXE 矩阵：`verify-exe` 10/10、`verify-p0-5-exe` 12/12、`verify-p0-2-exe` 13/13、`verify-help-exe` 14/14、`verify-ai-token-exe` 16/16、YouTube 生命周期 PASS
- ✅ 真实 Bilibili 回归：房间 `6` 20 秒 7 条聊天 / 7 个可识别观众 / 停止 `ended`
- 🟡 **未验证**：Bits 真实事件、赠订真实事件、EventSub OAuth、真实拔网/下播、真实 UAC 双击、长时间 10+ 频道
- ⬜ 等待开发者人工验收；验收通过并授权后才合并 main

## P26 PLATFORM-RESEARCH：TikTok / Twitch / 抖音接入调查（v0.13.2，2026-11-15）🟡

- ✅ Twitch 匿名 IRC 真实只读：5 频道 45 秒 **644 条 PRIVMSG**，644/644 带 `user-id`/`display-name`/消息 `id`；USERNOTICE 有 resub/viewermilestone；0 重复（239 条样本）；Bits 未观测
- ✅ Twitch EventSub：`session_welcome` 成功；无 Token 订阅 **401 OAuth token is missing**；官方限制 3 WS / 300 订阅 / max cost 10；DCF 公共客户端可无 Secret
- ✅ 抖音匿名 WSS 真实只读：约 7 秒 175 条消息；45 秒 16 chat / 192 member / 25 like / 3 follow / 8 room / **0 gift**；13/13 chat 有 UID/昵称/secUid/消息 ID/CJK；0 重复；公开页 `status=2/4`
- ✅ TikTok 验证：TTLC 2.5.0/2.4.4 被 Euler **Business plan** 阻断；1.2.3 本地签名超时；页面 WAF；**未取得真实事件**
- ✅ 官方 API：TikTok 无公开 LIVE 聊天/礼物 API；抖音官方“直播小玩法”需提案/软著/审核且最多 10 个弹幕指令，不是通用采集；Twitch 官方 EventSub 需 OAuth
- ✅ 开源/License：TTLC/TikTokLive/douyin-live-toolkit/BarrageGrab/cyber-xiaoya 为 AGPL；dyhub 核心 MIT 但 lightweight 签名脚本 AGPL；DouyinLiveRecorder 仅录制；douyin-live-danmu 无许可证
- ✅ 结论：**Twitch 第一、抖音第二（先决策 Cookie/AGPL）、TikTok 暂缓**
- 🟡 未验证：Twitch Bits/OAuth/断网/下播；抖音礼物/连送/重连/多房间/高频；TikTok 全部；三平台 SEA
- ⬜ 未改业务代码/DB/AI/备份；未 Push/Tag/Release；等待用户确认后开始 Twitch 正式开发
- 完整报告：`docs/PLATFORM_RESEARCH_TIKTOK_TWITCH_DOUYIN.md`；日志：`log/2026-11-15-platform-research.md`

## P25 RC0-ADMIN-MANIFEST：恢复双击自动请求管理员权限（v0.13.2，2026-11-14）✅

- ✅ 正式 EXE RT_MANIFEST：`asInvoker` → **`requireAdministrator`**；Windows 显示标准 UAC，同意后提权启动，拒绝即取消
- ✅ 不要求右键“以管理员身份运行”，不绕过/关闭 UAC；用户拒绝时由 Windows 取消启动
- ✅ 构建脚本 postject 注入前后双重断言；最终 EXE 再读取一次
- ✅ 自动化无法接受 UAC：正式 Manifest 单独断言，功能场景使用 `tests/.tmp/` 的 asInvoker 测试副本；正式 EXE 不被修改
- ✅ `pe-manifest` 单测 2/2；全量 **828 passed / 0 failed / 0 skipped**
- ✅ `verify-exe` 10/10、`verify-help-exe` 14/14、`verify-p0-5-exe` 12/12、`verify-p0-2-exe` 13/13、`verify-ai-token-exe` 16/16
- ✅ 正式 EXE `e438e74803cb` / SHA-256 `0cf67243…` / `96,733,184` B / `192` assets / `requireAdministrator`
- ✅ 未改 Bootstrap 目录选择、数据目录解析与任何业务逻辑；API 认证、Origin/Host/SSE、凭据与备份恢复规则不变
- 🟡 **真实 UAC 双击/拒绝未自动化验收**，等待用户人工双击确认
- ⬜ Push / Tag / 发布：等待用户决定
- 完整说明：`docs/STATUS.md` §0.31、`docs/WINDOWS_RUNTIME.md` §13、`log/2026-11-14-admin-manifest.md`

## P24 RC0-USAGE-GUIDE：三语使用说明与 RC0 封版（v0.13.2，2026-11-14）✅

- ✅ 侧栏「使用说明 / 使い方 / User guide」+ `#/help`：9 个主题、8 条 FAQ、桌面 sticky 目录、窄屏单列胶囊目录
- ✅ 三语 112 个 `help.*` 键 + `nav.help`，键集完全一致；复用现有卡片/按钮/callout/details 组件
- ✅ 只读：不调用 `/api/*`、不写设置、不弹确认；**没有新增任何使用限制，也不强制审核 AI 画像**
- ✅ 内容覆盖 Bilibili/YouTube 连接、记录与历史、Provider/API Key、单场+画像、长期记忆与证据、进度与恢复、备份/迁移、常见问题
- ✅ 新增 `tests/unit/help-ui.test.mjs` 9 项；全量 **828 passed / 0 failed / 0 skipped（240,768 ms）**
- ✅ 正式 EXE `74ed76e88a51`：`verify-help-exe` **14/14**、`verify-exe` **10/10**、`asInvoker`
- 🟡 真实浏览器截图/点击未执行（本机沙箱禁止 Chromium mojo）；由 DOM 渲染测试与打包资源检查覆盖
- ✅ 版本 0.13.2、DB schema 16、结果 Schema 1.3.0、提示词 v13.2、默认 10 人/批、备份格式、金额/身份/去重均未改
- ⬜ Push / Tag / 发布：等待用户决定
- 完整说明：`docs/STATUS.md` §0.30、`docs/HANDOFF.md` §0、`docs/UI_DESIGN.md` §7.23、`log/2026-11-14-rc0-usage-guide.md`

## P23 RC0-FINAL-ACCEPTANCE：最终综合验收与发布阻断项（v0.13.2，2026-11-14）🟡

- ✅ 修复 P0-A：无 evidence 的 `confirm + stated` 不再把 inferred 提升为 stated；无证据匹配 add 不再提升/激活。
- ✅ 修复 P0-B：旧导入路径比较 `events.viewer_id`，同 batch 跨观众证据被拒绝。
- ✅ 新增 5 测试；全量 **819 passed / 0 failed / 0 skipped（397,114.9 ms）**。
- ✅ 正式 EXE `7016d4295d0e`（commit `996f992`，SHA-256 `861eeaef...`）：verify-exe 10/10、p0-5 12/12、p0-2 13/13、ai-token 16/16、YouTube 生命周期 PASS。
- ✅ 真实平台：Bilibili 5050、YouTube Sky News 直播；真实 Chrome + EXE 认证与页面。
- 🟡 未关闭：严格召回 15%–30%、错误 stated 25%–31%、同 kind+topic 静默 confirm（P1-A）、临时事实长期化（P1-C）。
- **结论：建议 RC0 小范围闭源内测；不建议公开发布。** 完整报告 `docs/RC0_FINAL_ACCEPTANCE.md`。

## P22 RC0-MEMORY-QUALITY：长期画像事实完整性与语义质量（v0.13.2，2026-11-14）🟡

- ✅ 标准答案集：16 观众 / 3 场次 / 70 消息 / 30 当前事实 + 6 被替代 / 11 重要 / 1 歧义 /
  26 不应保存，覆盖 15 类场景；P0-3 16 句模板事后标注。
- ✅ 指标与 CLI：严格召回、准确率、重要召回、跨观众、重复、误收、歧义、Token/费用；
  `scripts/memory-quality-eval.mjs`、`scripts/memory-batch-structure.mjs`。
- ✅ 归档真实 4 次运行重评：旧“20 人更差”不成立；行数含 37 条 uncertain、cap10 多发 3–4 次补答；
  严格口径两次方向相反。默认 10 保留，20 需等预算重复复测。
- ✅ 确定性修复：摘录 omitted 元数据 + 提示词禁止推断；`efficiency.factQuality`。
- ✅ 新增 17 测试；全量 **814 passed / 0 failed**；EXE 见 `docs/STATUS.md` §0.28.5。
- 🟡 未完成：严格召回仅 15%–30%；25%–31% stated 事实引用不支持；5 人无语义数据；
  未获付费授权；其他 Provider/真实账单/thinking 未验证。

## P21 RC0 P0-3：Provider 兼容性、DeepSeek 真实付费验收与 20→10 回退（v0.13.2，2026-11-14）🟡

- ✅ 审计 7 个 Provider 的请求格式、鉴权、端点、结构化输出、输出上限、流式、usage 语义，建立兼容性矩阵（`docs/AI_PROVIDER_COMPATIBILITY.md`）
- ✅ 定位并修复 **结构化输出能力检测循环**：生产环境此前从不发 `json_schema`，每请求多付一份文本 Schema
- ✅ 修复 **`response_format` 被拒绝即永久失败**：能力测试一次降级、真实任务两次有界降级、Schema 回填提示词、持久化降级
- ✅ 修复 **OpenAI 推理模型参数**：`max_completion_tokens`、无 `temperature`、`system→developer`、16K 思考预留
- ✅ 修复 **OpenAI 缓存写入 Token** 未解析、**OpenRouter 自报费用** 被丢弃、**缺失缓存价被当作 0**
- ✅ **DeepSeek 真实付费验收（L3）**：能力检测、单场 + 画像（80/80）、100 观众 Resume（100/100）、日语 60/60；50 次请求、估算 $0.2553（授权 $1.25）；0 重复事实、0 跨观众证据、0 无证据事实
- ✅ 真实 A/B 发现 **20 人上限事实保留率仅 73% / 51%**；RC0 恢复默认 **10 人/批**，20 只保留为技术上限与实验参数
- ✅ 修复 **DeepSeek V4 默认 thinking 耗尽输出预算**：显式 `thinking:{type:"disabled"}`
- ✅ 新增 16 项自动化（13 unit + 3 integration）；全量 **797 passed / 0 failed**
- ✅ 正式 EXE `69ec022cee31`（commit `f9b0cda`）：Mock 矩阵 `verify-ai-token-exe` 16/16、`verify-exe` 10/10、`verify-p0-5-exe` 12/12、`verify-p0-2-exe` 13/13；真实 DeepSeek EXE 验收 **11/11**（40/40、79 事实、8 请求、$0.04422、备份、重启、Resume 0 请求）
- ⬜ 其他 Provider 的真实 `json_schema`/429/5xx/截断、真实缓存与费用（仍 L2/L4）
- ⬜ 真实官方账单核对、取消请求计费、thinking 开启时的质量/费用对照
- ⬜ cap10 仍会漏部分事实；长期画像质量只达到“20 明显更差、10 较保守”的结论
- 完整证据：`docs/AI_PROVIDER_COMPATIBILITY.md`、`log/2026-11-14-p03-provider-compat.md`

## P20 RC0-AI-EFFICIENCY Token 利用率与 API 成本（v0.13.2，2026-11-14）✅

- ✅ Token 归因：缓存命中/缓存写入/推理 Token；逐尝试 token 账本；`usageSource`；`attempts` 与 `unknownUsageAttempts`；无 usage 的请求不再消失
- ✅ 能力测试与翻译失败尝试的用量也被记录与计价（不再有"已付费但不可见"的调用）
- ✅ 删除三处可证明的重复输入：structured-output Provider 的文本 schema、画像重复输出示例、契约逐观众数组
- ✅ 自适应分批：观众上限从写死 10 改为"偏好 10、受输出预算/摘录上限/内容预算约束最多 20"；`viewersPerBatchHard` 未传时保持旧语义
- ✅ 14 场景确定性基线（`scripts/ai-efficiency-baseline.mjs`）：请求 -30.6%、总 Token（按实测字节模拟）-10.1%、请求字节 -10.4%
- ✅ 质量：观众覆盖 1715/1715 不变、有效事实 1715 不变、重复事实 0、Resume 只重试失败观众、完成后 Continue 0 请求
- ✅ 三语 UI：推理/缓存 Token、用量来源、重试与补答开销占比、每百观众/每百事实 Token、每百观众估算费用；无价格时明确「费用未知」
- ✅ 无 schema 变更（16）、备份格式不变、结果 Schema 1.3.0、提示词 v13.2；全量测试见 `docs/STATUS.md` §0.26
- ⬜ 真实付费 Provider 的 Token 校准、缓存命中率、自适应分批的语义影响（P0-3 待验收）
- ⬜ `messages.jsonl` 结构开销（实测 93.8% 字节为 JSON 结构）未压缩：需真实模型质量对照
- 完整证据：`docs/AI_TOKEN_EFFICIENCY.md`、`log/2026-11-14-ai-token-efficiency.md`

## P19 RC0 P0-2 完整备份、恢复与跨电脑迁移（v0.13.2，2026-11-14）✅

- ✅ `.livememory` v1：manifest（格式/时间/版本/schema/包含与排除/计数/文件 SHA-256）+ STORE ZIP；只允许固定 3 个条目
- ✅ 创建：`VACUUM INTO` 一致快照 → `integrity_check` → 临时文件 → 重新完整校验 → 原子改名；已存在目标需显式覆盖
- ✅ 在线一致性：录制中、WAL 未 checkpoint、AI 写入调度期间均可备份并通过完整性/计数检查
- ✅ 取消/写入失败/磁盘不足/目标冲突：不留下半成品，不修改原库
- ✅ 恢复：先验证再冻结写入 → 停止采集/AI/SSE → 关闭数据库 → 恢复前安全快照 → 暂存目录迁移+校验 → journal → 两次原子改名 → 新库校验 → 应用设置 → 重建运行时
- ✅ 崩溃恢复：启动时按 journal 与文件 SHA-256 判定回滚或提交，不依赖 try/catch
- ✅ 安全：ZIP Slip、绝对路径、盘符、反斜杠、符号链接、加密条目、data descriptor、ZIP64、压缩条目、重复名、条目数/大小/总量上限、CRC/SHA、损坏 SQLite、伪造格式/schema、含凭据清单全部拒绝
- ✅ 凭据：`secrets/`、`config/ai-providers.json`、日志、缓存、runtime、exports、backups、数据目录指针不进入备份；恢复后提示重新登录 Bilibili、重新填写 API Key，YouTube 公开聊天无需登录
- ✅ 跨电脑：全新绝对路径/新 Windows 数据目录恢复；数据库内无旧电脑绝对路径；重启后数据、AI 报告、长期事实保持一致
- ✅ UI：设置页备份与恢复卡片；原生保存/打开对话框（失败可手动路径）；摘要、覆盖提示、`RESTORE` 确认、阶段进度、取消、三语错误
- ✅ 24 个专项测试；全量测试结果见 `docs/STATUS.md` §0.25；正式 EXE 完成备份 → 新目录恢复 → 重启 → 再次备份闭环
- ⬜ 真实 Windows 文件对话框点击、真实浏览器点击（用户待验收）
- ⬜ 备份未加密；不提供两台电脑数据合并（如实记录）
- 完整证据：`docs/BACKUP_FORMAT.md`、`docs/BACKUP_RESTORE.md`、`log/2026-11-14-backup-restore-p02.md`

## P18 RC0 P0-5 本地 API 鉴权与 Windows 最小权限（v0.13.2，2026-11-14）✅

- ✅ 修复前实测：隔离目录无凭据可读 `/api/bootstrap`、`/api/viewers`，可改设置、启动/停止场次、进入迁移、订阅 SSE；伪造 Origin/`Origin:null` 的 GET 也成功
- ✅ 每次启动随机 bootstrap token + session token，仅内存；服务重启全部失效
- ✅ 启动器 URL fragment 一次性 token → `HttpOnly; SameSite=Strict` Cookie；无 token 分发端点；token 不进入查询串/runtime.json/日志
- ✅ 除 `/api/health`、`/api/auth/status`、`/api/auth/session` 外所有 `/api/*`（含 SSE）要求 Cookie；401 `AUTH_REQUIRED`
- ✅ 全方法 Origin 校验、`Origin:null` 拒绝、`Sec-Fetch-Site` 跨站拒绝、Host 严格校验、无 CORS 放行
- ✅ 前端 `js/auth.js` 引导 + 401 三语重开页面；EventSource/下载自动携带 Cookie
- ✅ 发布 EXE 改为 `asInvoker`；构建 patch 前后断言；删除管理员检查/文案/绕过
- ✅ 14 项认证集成 + 1 项优雅关闭 + 6 项 auth service + 6 项 auth boot 单测；全量 **745 passed / 0 failed / 0 skipped（270,168 ms，2026-11-14）**
- ✅ 正式 EXE `75588ba16aec`：Low Mandatory Level 无 UAC 启动；`verify-p0-5-exe` 12/12、`verify-exe` 10/10；旧 Cookie/token 重启后 401、数据保留
- ⬜ 真实浏览器自动打开/点击、真实 Ctrl+C/关闭窗口（用户待验收）
- ⬜ 同 Windows 用户恶意软件、共享目录 ACL、真实平台/真实付费 Provider 边界（按文档如实说明）
- 完整证据：`log/2026-11-14-local-api-auth-p0.md`

## M0 项目初始化与架构验证 ✅

- ✅ 检查参考仓库 `bili-gift-drop`（README/AGENTS/源码/登录/WebSocket/礼物/SC/大航海/去重/多语言）
- ✅ 确认技术栈：Node 22.5+、ESM、`node:sqlite`、零运行时依赖、原生前端、SEA 打包
- ✅ 新建独立 Git 仓库（不修改旧仓库）
- ✅ AGENTS.md 与 17 份文档
- ✅ 数据库结构、AI 协议、备份协议设计
- ✅ Windows EXE 方案可行性验证（实际构建并运行）
- ✅ 测试环境与 86 个自动化测试

**交付**：可启动的工程骨架、工程规范、可运行控制台。

## M1 Windows 启动器与基础 UI ✅

- ✅ 本地 HTTP 服务（仅 127.0.0.1、动态端口）
- ✅ 服务就绪后打开系统默认浏览器
- ✅ 可见命令行窗口（PE 子系统 = Console）
- ✅ 中日英启动提示、系统语言识别、用户覆盖持久化
- ✅ 明亮 / 黑暗 / 跟随系统，首帧无闪烁，持久化
- ✅ Apple 风格控制台（5 页、响应式、SSE 实时）
- ✅ Windows 数据目录、单实例、优雅退出、崩溃恢复
- ✅ UTF-8 控制台（中文/日文实测）

**交付**：可运行、可操作、可持久化的本地控制台。

## P0 Windows 普通权限启动修复 ✅

- ✅ 复现普通权限启动失败（缺捕获的 EPERM）并定位到代码级缺陷
- ✅ 全链路启动守护 + 早期日志 + 三语错误 + 失败不闪退
- ✅ 真实写探测、数据目录回退、单实例健康探测、原子解压与复用
- ✅ `scripts/verify-exe.mjs` 普通权限 EXE 矩阵
- ✅ 修复日志脱敏缺陷

**交付**：普通用户双击 EXE 即可启动；失败时可见、可诊断。

## M2 本地记录引擎 🟡

- ✅ SQLite schema v1–v6 与迁移
- ✅ 统一事件模型与规范化
- ✅ 模拟直播（弹幕/礼物/SC/大航海/重复投递）
- ✅ 场次管理与计数
- ✅ 观众聚合与稳定身份
- ✅ UID=0 视为缺失（禁止 `platform:0` 共享档案）；未识别消息从 events 实时派生
- ✅ 礼物统计（币种 + value_kind 分账）
- ✅ 基础图表（消息密度）
- ✅ **多直播间并发记录**：独立 adapter/状态/停止/失败隔离，同房间重复启动拒绝（v0.6.0）
- ✅ 单场 Top 100 排行榜与稳定次级排序（v0.6.0）
- ✅ 数据目录修改、迁移与新数据空间（v0.4.0）
- ✅ 清空全部数据 / 恢复出厂设置（v0.4.0）
- ✅ 单场停止 / 归档 / 永久删除（v0.7.0）
- ✅ 直播历史统一搜索与筛选（v0.7.0）
- ⬜ 手动事件导入 / 批量删除
- ⬜ 存储占用趋势与容量告警
- ⬜ 10+ 场长时间压力与资源上限策略

**交付**：不依赖真实平台和 AI 的可运行记录系统；用户可以同时记录多场直播，并控制数据位置与安全清空。

## P1 聊天表情与 Emoji 兼容 ✅

- ✅ Unicode Emoji / 组合 Emoji / ZWJ / 肤色修饰符完整保存，截断不破坏字形
- ✅ Bilibili 真实表情元数据 `info[0][13]` 采样与映射（`emoticon_unique` + 文字标签）
- ✅ 只有表情代码/无正文的消息仍入库；未知表情明确标记，不猜情绪
- ✅ 统一事件模型与 SQLite schema v2（`events.emotes`，旧库安全迁移）
- ✅ AI 包去重表情字典、`emote_refs`、按需 `content_ai`
- ✅ YouTube 离线 mapper 预留（未真实接入）
- ✅ 三语界面与 AI 指令中的表情语义规则

**交付**：文字、Emoji 与平台表情可被正确记录、显示并传给任意 AI。

## P2 AI 分析中心通用化 ✅

- ✅ 界面与分析指令移除 ChatGPT 专属绑定，统一为 AI 分析中心 / AI 分析包 / AI 分析指令 / AI 分析结果
- ✅ 自然语言任务说明（话题、时间变化、回看片段、新观众、既有观众画像）
- ✅ 三语 AI 分析指令由软件生成，含 Emoji/平台表情、经济支持、数据可靠性规则
- ✅ 导出/复制/下载流程保持平台无关；失败重试与导入仍按 M6 计划
- ⬜ AI 结果导入与 Schema 校验（M6）

**交付**：用户可把同一分析包交给任意 AI 服务。

## P3 语言快捷切换、数据自主控制与多主播档案 ✅（v0.4.0）

- ✅ Header 语言快捷切换（三语原生名称 + 跟随系统；宽屏分段、窄屏 select；与设置页同一状态）
- ✅ 数据存储目录修改、迁移、新数据空间、位置记录、原生目录选择器
- ✅ 迁移 staging、WAL checkpoint、完整性/计数/校验和验证、单实例锁转移、失败回滚
- ✅ 清空数据与恢复出厂设置（确认文字、记录中禁止、数据库快照、事务清理、运行时重建）
- ✅ schema v5 多主播身份与主播维度观众档案、范围选择、搜索、排序、全局概览
- ✅ AI 分析包主播上下文隔离（`broadcaster_context` / `lifetime` / `other_broadcaster_count`）
- ⬜ 旧场次手动归属、映射网络盘检测、真实断电/拔盘演练

**交付**：用户能随时找到语言切换、控制数据位置、安全清空自己的数据，并按主播分别理解观众。

## P4 文件夹选择器、YouTube 单一入口与管理员 EXE ✅（v0.5.0）

- ✅ 修复「浏览」：`stdio:'ignore'` + 临时结果文件 + `-EncodedCommand`，不再 `spawn EPERM`
- ✅ 取消不报错、手动输入保留、错误可诊断；中文/空格路径
- ✅ 删除官方 YouTube Data API/OAuth/API Key/模式切换与对应测试
- ✅ 唯一公开网页路径：链接 → 检查 → 开始；保留聊天/SC/会员/gift/badge/稳定身份/30 天保留
- ✅ 三语清理，设置页只读说明，不在正常连接 UI 堆叠实验警告
- ✅（历史，已被 P18 取代）EXE RT_MANIFEST `requireAdministrator`；非提升启动被 Windows 拒绝；三语管理员提示
- ⬜ 真实 UAC 点击、真实文件夹选择；v0.6.0 已完成真实并发采样（见 P5）

**交付**：用户双击 EXE 由 Windows 请求管理员权限，YouTube 像 Bilibili 一样只需粘贴链接。

## P5 多直播间记录、标签页与 Top 100 ✅（v0.6.0）

- ✅ `SessionManager` 独立 recording/adapter/session；停止、失败、自动结束互不影响
- ✅ 同一 `platform + room` 重复启动在内存与数据库双重拒绝（409 `SESSION_DUPLICATE_ROOM`）
- ✅ `GET /api/live/recordings`、按 sessionId 停止、SSE 多场状态
- ✅ 直播页浏览器式标签：固定「新建记录」、可横向滚动、连接中/记录中/重连中/已停止/连接失败
- ✅ 切换标签/页面/浏览器不停止后台采集；`viewToken` 防止旧页面响应串场
- ✅ 每场独立消息密度、最近动态、最活跃观众、消息数、经济支持与状态
- ✅ Top 100 数据库查询、稳定次级排序、默认约 10 行可视滚动、搜索、观众档案跳转与主播上下文
- ✅ schema v6 排行榜索引；旧库兼容
- ✅ 启动器控制台默认英文，`--lang` 与网页三语互不覆盖
- ✅ 真实网络验证：2 YouTube、YouTube+Bilibili、3 场并发；构建后 EXE 附加真实 3 场验证
- ⬜ 运行中标签的显式“隐藏但继续记录”交互（当前必须先停止再关闭）
- ⬜ 并发资源提示与 10+ 场长时间压力测试

**交付**：用户可同时记录多场直播，标签切换流畅、数据不串场，并查看每场 Top 100 观众。

## P6 直播历史场次管理与搜索 ✅（v0.7.0）

- ✅ 列表与详情共用停止记录服务；只停目标场次；保留已采集数据；`end_reason=user`
- ✅ 归档/取消归档作为独立 `archived_at` 属性；live 禁止归档；默认隐藏 + 包含归档入口；重启保持
- ✅ 永久删除：事务删除专属行、重建观众/主播衍生聚合、清理孤立派生行、删除分析包文件、无残留校验
- ✅ 删除守卫：必须显式确认；记录中或 adapter 仍在时拒绝；失败整体回滚
- ✅ 搜索：主播名称/稳定 ID、标题（中日英混合）、观众稳定 ID/昵称/历史昵称；同名身份不合并
- ✅ 匹配原因、观众本场发言数、详情下钻与最近 50 条发言
- ✅ 筛选：平台、状态、日期范围、包含归档；可组合；20 条/页增量加载
- ✅ 「···」菜单（列表 + 详情）、键盘/触屏/窄屏、三语、明暗主题
- ✅ schema v7 列与索引；旧 schema 6 数据库由打包 EXE 实测升级
- ✅ 318 自动化测试、浏览器 UI 27/27、打包 EXE UI 19/19、EXE 矩阵 10/10
- ⬜ 回收站/撤销（有意不做）、批量归档/删除、百万级性能基线

**交付**：用户可以在直播历史中安全地停止、归档、恢复和永久删除单场直播，并按主播、标题或观众快速找到历史场次。

## M3 真实平台接入 🟡

- 🟡 Bilibili 扫码登录：生成/轮询/校验与加密存储完成；二维码由应用内 canvas 显示
- ✅ Bilibili 直播间 WebSocket（分片/压缩/心跳/看门狗/断线重连）
- 🟡 弹幕、付费/免费礼物、SC、大航海映射已实现；弹幕身份与平台表情元数据已真实验证，礼物/SC/大航海尚未在真实直播观测到
- ✅ 身份字段完整性验证：弹幕 142/142 带 UID；UID=0 + 昵称打码场景已记录
- ✅ Bilibili 平台表情：`info[0][13].emoticon_unique` + `info[1]` 文字标签；不下载图片
- ✅ 普通文字 / Unicode Emoji / 平台表情统一进入 canonical event、SQLite、UI 与 AI 包
- ✅ YouTube 链接定位与状态判定：直播 / 未开始 / 已结束 / 普通视频 / 聊天关闭 / 网络错误
- ✅ YouTube 唯一公开网页路径：watch/live_chat + continuation + 真实聊天/SC/gift/badge
- ✅ YouTube 官方 Data API/OAuth/API Key/token-store/capture-mode 已在 v0.5.0 删除
- ✅ 稳定身份 `youtube:<channelId>`；仅昵称不建档案、不合并
- ✅ 多币种分别累计；会员等级/数量不换算金额；赠送会员接收者不计为付款者
- ✅ 30 天原始聊天保留策略（启动、场次结束、手动触发）
- ✅ continuation 失效重开、429/网络退避、自动结束、可能漏消息诊断
- ✅ v0.6.0 真实并发验证：2 个 YouTube、YouTube+Bilibili、3 场并发；隔离/重复启动/停止一场均通过
- ⬜ 同一真实观众跨两个主播的实测（自动化测试已覆盖身份与上下文隔离）
- ⬜ 公开网页路径的 YouTube ToS/合规评估（可能冲突，不得描述为官方/合规）
- ⬜ Super Sticker / 会员 / 赠送会员的真实样本
- ⬜ `SEND_GIFT_V2`、Bilibili 礼物/SC/大航海真实复核、真实断线长时间验证

**交付**：能够记录真实直播间事件；YouTube 只有一个入口——公开网页聊天，界面不要求 API Key/OAuth。

**风险**：网页接口不是官方稳定 API，平台页面/策略变化可能导致失效；不得恢复官方双轨或描述为已授权。

## M4 直播统计与存储管理 🟡

- ⬜ 更完整的场次统计与对比
- ⬜ 经济支持明细页
- ⬜ 精简/完整模式的实际清理流程
- ✅ 清空全部直播/观众数据（保留设置与凭据）
- ✅ 恢复出厂设置（保留位置记录、备份与无关文件）
- ✅ 数据目录迁移 / 新数据空间 / 失败回滚
- ✅ 数据库应急快照（`VACUUM INTO`，非 M5 可移植格式）
- ✅ 删除指定场次（v0.7.0，含观众/主播衍生数据重算）
- ⬜ 单独删除观众 / 主播
- ⬜ 严格删除 / 去标识化模式
- ⬜ 容量管理与真实断盘/断电演练

## M5 完整备份与跨电脑迁移 ⬜

- 🟡 数据库应急快照（`VACUUM INTO`）已用于删除前保护；不是可移植备份
- ⬜ 版本化 `.livememory` 包（manifest/checksums/database/settings/resources）
- ⬜ SQLite 安全备份，禁止直接复制写入中的数据库
- ⬜ 导入校验、版本兼容、冲突预览、回滚
- ⬜ 压缩炸弹 / 路径穿越 / 非法覆盖防护
- ⬜ 可选密码加密（成熟 AEAD + KDF）
- ⬜ 跨电脑模拟迁移测试

## Bilibili 直播生命周期修复 ✅（v0.8.1）

- ✅ 平台状态与本地采集状态分离（schema v9：`platform_status`、`platform_status_at`、
  `last_live_seen_at`、`platform_ended_at`、`platform_end_quality`）
- ✅ WebSocket `LIVE`/`PREPARING`/`STOP_LIVE` + 每 60 秒 `live_status` 查询
- ✅ WS 下播事件 + 1 次有效离线，或 2 次连续有效离线才确认；超时/429/-352/异常不算下播
- ✅ 自动结束：清定时器/WebSocket/重连、写最终事件、更新结束时间/原因、SSE 刷新、保留全部数据
- ✅ 多房间隔离：A 下播只结束 A；快速重开创建新场次；旧回调不能复活
- ✅ 启动恢复不再用最后弹幕时间；历史异常行后台探测，证据不足标 unknown，不编造结束时间
- ✅ 历史列表/详情/多场标签区分已下播、手动停止、采集中断、平台未知；三语 + 明暗 + 390px
- ✅ 386 自动化测试；EXE 矩阵 10/10；EXE 历史 19/19；EXE 生命周期 UI 21/21
- ⬜ 真实「直播中→下播」端到端样本（真实监控期间未发生）
- ⬜ 数小时轮询下的 429/-352 长期行为

## M6 AI 文件往返与直播分析 ✅（v0.8.0）

- ✅ 分析包导出（`livememory-analysis-v1`，含三语说明与结果 Schema），新增 job/batch/coverage/prompt_version 元数据
- ✅ 文本优先的 Emoji/平台表情处理：`emote_dictionary`、`emote_refs`、`content_ai`、未知表情标记
- ✅ AI 分析中心通用化：不绑定 AI 品牌、自然语言任务说明、可复制分析指令
- ✅ 提示词复制；批次/汇总提示词；`lm-prompt-m6.1-zh-CN/ja/en` 版本记录
- ✅ JSON 文件与文本粘贴导入；8 MB 上限；Markdown 围栏剥离
- ✅ 严格 Schema + 业务校验（场次/任务/批次/主播/观众/时间/消息引用/范围）；字段路径 + 原因 + 修复建议
- ✅ 事务导入与回滚；预览不写入；失败不留下部分结果
- ✅ 重复导入保护（规范化校验和）；同任务不同结果版本需显式确认并保留旧版本
- ✅ 大批量分批：消息边界、稳定批次 id、seq→event 映射、无丢失/重复
- ✅ 乱序/重复/缺失/错误批次检测；全部分批后生成第二阶段汇总包；最终结果导入后才 complete
- ✅ 汇总不拼接重复话题；部分结果按批次展示并明确标记不完整
- ✅ 话题时间线、情绪、争论、候看片段、观众画像、来源与证据入库/展示
- ✅ 原文已清理/删除时证据明确不可用；AI 输出与本地确定性统计分离
- ✅ schema v8；旧分析与 1.0.0 结果兼容；v7→v8、v6→v8 由打包 EXE 实测
- ✅ 353 自动化测试、浏览器 UI 17/17、打包 EXE AI 14/14、EXE 历史回归 19/19
- ⬜ 真实 AI 服务端到端样本（本轮只验证 Schema 合法合成结果）
- ⬜ AI 结果/观众画像的保留、去标识化与单版本删除（M7 前必须补齐）

**交付**：用户可以选择一场直播，导出可分批的分析包与三语提示词，交给任意 AI，导入通过严格校验的 JSON，并看到可信、可追溯、分阶段的直播分析报告。

## M7 长期观众记忆 🟡（v0.9.0 核心完成）

- ✅ 平台全局身份 + 主播维度互动档案（schema v5）
- ✅ 按主播的发言/场次/支持统计与观众搜索
- ✅ 主播—观众关系表、跨主播全局概览、AI 包中的主播上下文隔离
- ✅ M6 已导入 AI `viewer_profiles`（仅本场、仅本主播、带证据要求）并展示在报告中
- ✅ 长期记忆数据模型（schema v10）：`broadcaster × viewer` 一份记忆、原子事实、事实级证据、
  仅追加版本、记忆更新任务/批次/seq 映射/已应用结果
- ✅ 跨场次增量更新：①本地合并已导入的 M6 分析（不接 AI）；②AI 记忆更新包
  （`livememory-memory-update-v1`、Schema 1.0.0、三语提示词 `lm-prompt-m7.1-*`、按观众分批）
- ✅ 事实/推断/不确定/过时/矛盾的区分；`supersede` 状态变化保留历史；矛盾不自动裁决；
  历史规则为 180 天未确认标记过时；**2026-11-24 已取代**，稳定事实不再仅因年龄自动失效（仍绝不变成 dislike）
- ✅ 证据可追溯（场次/批次/seq/event_id/时间/可用性）；原文清理后降级为 purged/partial
- ✅ 画像版本记录、逐条差异、回滚（回滚也是新版本）；重复导入不重复应用
- ✅ 观众档案 UI：概览 / 长期记忆 / 互动历史 / 历史版本 标签页；事实分组、证据展开、人工复核
- ✅ 记忆工作台 `#/memory`：选择直播 → 本地合并预览 → AI 更新包（下载/提示词）→ 导入预览 → 应用
- ✅ 隐私：按主播隔离；删除单个观众记忆（墓碑阻断旧包）；清理长期未出现观众（默认仅预览）；
  原始聊天清理/删除场次/清空数据联动；礼物金额不写入记忆
- ✅ 450 自动化测试（新增 8 个测试文件）
- ⬜ 真实浏览器渲染验收与截图（本机策略阻止无头浏览器）
- ⬜ 打包 EXE 实测 schema 9→10 与记忆 UI
- ⬜ 真实 AI 服务的记忆更新往返样本
- ⬜ 大观众量（1 万+）性能基线
- ⬜ 按主播的长期经济支持明细页（记忆已可按主播记录事实，但金额明细页仍未做）
- ⬜ 跨主播身份关联（有意不做；如需，必须先有明确的产品与隐私决定）

**交付**：主播可以把每场直播的分析持续合并成每位观众的长期记忆，看到「谁知道什么、什么时候说的、
证据在哪、最近有什么变化」，并能在不接 AI API 的前提下用外部 AI 处理矛盾与近况变化。

## P7 自动直播监听与持久化 Tab ✅（v0.10.0）

- ✅ 持久监听目标（schema v11 `monitor_targets`）+ `sessions.monitor_target_id`；目标与单场记录彻底分离
- ✅ 统一监听状态机：waiting / checking / connecting / recording（含派生 reconnecting）/ ending / paused / error
- ✅ 统一调度：到期检查、错峰启动、每平台串行 pacer（Bilibili ≥1.2s、YouTube ≥2.5s）、最多 2 并发
- ✅ 抖动 + 指数退避 + `Retry-After`；连续 4 次失败进入可见 error，30 分钟后低速重试；不静默重试
- ✅ Bilibili：固定真实房间号（URL/短号规范化）+ `get_info.live_status` 低频检测；复用现有 WebSocket 适配器与下播确认
- ✅ YouTube：公开 `/channel/<id>/live` + `ytInitialPlayerResponse`（owner 校验、isLive/isLiveNow、预定直播区分），解析失败时 RSS + watch 页确认回退；无 Data API/OAuth/API Key/Cookie
- ✅ 频道身份：频道 URL、@handle、`/c/`、`/user/`、裸 Channel ID、已知视频链接反查；`externalId` 优先
- ✅ 发现直播后复用现有聊天采集；不下载视频/音频
- ✅ 网络重连沿用同一 session；只有确认新一场才创建新 session；关播后 Tab 保留
- ✅ Tab：监听 Tab 固定展示目标状态、最近检查/下次检查/上次直播、错误原因、最近场次；可暂停/恢复/立即检查/删除
- ✅ 区分关闭 Tab（仅手动结束场次）、暂停监听、停止当前记录、删除监听目标；记录中禁止删除目标
- ✅ 重启恢复目标（错峰），不要求软件关闭时继续监听
- ✅ 与 M6/M7 兼容：自动场次就是普通 `sessions`，可导出 AI 包、导入结果、参与长期记忆
- ✅ 清空数据/恢复出厂/删除场次/数据迁移联动
- ⬜ 真实双平台长时间运行（跨多天、真实下播→再开播）样本
- ⬜ 真实 YouTube 页面结构变化的回归演练（只做了少量只读实测）
- ⬜ 多目标（10+）长时间请求量与限流观测

**交付**：用户添加一次直播间/频道，软件在运行期间自动完成开播检测、记录、关播保存，并在同一持久 Tab 中等待下一场。

## P8 长期记忆与 AI 分析中心一体化 ✅（v0.11.0–0.11.1）

- ✅ 一次导出/一次 AI/一次导入：本场分析与全部可识别观众的长期记忆在同一任务、同一事务中完成
- ✅ 取消最低发言次数、最低活跃度、Top N：每场一句话的观众也持续积累
- ✅ 观众按批次分配且只分配一次；其全部可用发言（最近 120 条）随批次导出，跨批次不拆散
- ✅ 客观互动历史（首次/最近、场次、发言数、支持）由真实记录确定性更新，AI 不能修改；无新语义时仍标记已处理
- ✅ 已有长期画像（summary + facts）自动进入分析包；AI 可 add/confirm/update/supersede/conflict/outdated/uncertain
- ✅ 证据 seq → event_id → viewer_id 三重校验；他人消息、跨批次、无证据 stated、未知 fact 全部拒绝
- ✅ 导入预览显示观众覆盖：已覆盖/已处理无新语义/仅客观/缺失/冲突；任务状态含 `memoryCoverage`
- ✅ 移除独立 `长期记忆` 页面与导航；旧书签进入 AI 分析中心；观众详情保留长期记忆标签并新增客观互动历史
- ✅ v0.11.1 修复观众档案「主播范围」：只显示该观众实际互动过的主播，单主播隐藏下拉、无关联显示空状态
- ✅ 旧 1.0/1.1 结果仍可导入（仅客观历史）；新 1.2 结果必须覆盖本批全部记忆观众
- ✅ 300 位低活跃观众、每场一句话五场、重复导入、跨批次、隐私与 M6/M7 回归测试
- ⬜ 真实 AI 返回统一 `viewer_memory_updates` 的样本
- ⬜ 数千观众真实大场与 10+ 目标并发性能
- ⬜ 真实浏览器记忆页/预览 UI 验收（本机策略阻止）

**交付**：用户只使用原有 AI 分析中心，一次分析导入即可同时得到本场报告与每位可识别观众的持续长期记忆。

## P9 匿名免费 AI 自动分析 ✅（v0.12.0）

- ✅ 先实测候选接口再集成：OVHcloud AI Endpoints `gpt-oss-20b` 匿名通道通过真实 LiveMemory 包；
  Murakumo 不可用、llmfaucet 域名消失、LLM7 需 Token、Pollinations 真实包 400，均未集成
- ✅ `src/ai/auto/`：provider 配置、限流客户端、包内提示词、持久状态、Runner、错误类型
- ✅ 自动创建/恢复任务 → 逐批发送 → 现有 Schema/业务校验 → 事务导入 → 第二阶段汇总 → complete
- ✅ 全部可识别观众仍进入批次；自动模式使用 250 消息 / 25 观众 / 600 摘录、最多 12 批；
  超出时明确失败，不静默裁剪
- ✅ 输出预算最低 8000 tokens；一次修复；网络重试一次；429 尊重 `Retry-After`；
  单次运行请求预算；没有无限重试
- ✅ 取消、页面切换、刷新、退出/重启恢复；已导入批次保留；同一任务防重复启动
- ✅ UI：AI 分析中心新增「自动 AI 分析」；首次同意；真实阶段文案；按钮下方红色固定文案；
  「查看详情」；手动流程全部保留
- ✅ 三语 `ai.auto.*`、`errors.aiAuto*`、`ai.report.sourceAuto`；无 `innerHTML`、无 `alert()`
- ✅ 无 API Key、无账号、无开发者服务器；数据库 schema 仍为 12
- ✅ 525 自动化测试；真实 OVH 包 `complete`、`semantic=3`；真实跨场次 `supersede` 样本
- ⬜ 真实浏览器 UI/截图（本机策略阻止）
- ⬜ 真实 EXE 出站请求与干净 Windows 验收
- ⬜ 数千观众/数万消息大场性能与免费限流实际耗时
- ⬜ 第二个通过完整 LiveMemory 包的匿名 provider（本轮没有）

**交付**：普通用户在 AI 分析中心点一次「自动 AI 分析」，即可完成本场报告与全部可识别观众的长期记忆更新；不可用时看到简单红色提示并继续使用手动流程。

## P9.1 自动分析真实故障修复 ✅（v0.12.1）

- ✅ 用真实 52 观众/99 消息日语样本复现并定位 `AUTO_SCHEMA_INVALID` / `AUTO_INVALID_JSON`
- ✅ 自动批次改为紧凑 `ref` 回答 + 本地组装 Schema 1.2.0；模型不再输出/伪造观众 ID
- ✅ `json_schema` structured output；记录 `finish_reason`；截断/退化明确报错
- ✅ 缺失 ref 一次有界定向补充；仍缺失则失败，不写库、不默认无新信息
- ✅ 10 位/批、30 批上限；真实 52 人自动运行 `complete`，52/52 覆盖
- ✅ 手动提示词删除“不要输出观众身份字段”的矛盾句；补充 evidence_seqs/zero_excerpt 规则
- ✅ 导入预览 gaps + 「复制修复指令」；绝不自动改 ID
- ⬜ 用户手动模型一次覆盖 52 人的保证（模型相关）
- ⬜ 真实浏览器 gaps/复制按钮、EXE、1000+ 观众免费限流实测

**交付**：真实规模（52 位观众、99 条消息、初始空记忆）的自动分析可以完成并覆盖全部观众；手动导入失败时能精确指出缺失观众并可复制修复指令。

## M8 Windows 正式发布 ⬜

- ⬜ EXE 打包与干净 Windows 环境验收
- ⬜ 三语完整校对
- ⬜ UI/UX 与性能优化
- ⬜ 升级、回滚、备份兼容策略
- ⬜ GitHub Release 资产与校验和
- ⬜ 用户使用说明（三语）

## P11 AI 入口收敛与付费调度（v0.13.1）✅

- ✅ 调查确认付费 API 未复用匿名 OVH 2 RPM；2 RPM/冷却只存在于旧 `src/ai/auto/`
- ✅ 删除匿名免费 AI：UI、Provider、`/api/ai/auto/*`、免费价格状态、自动切换
- ✅ 删除手动 AI 写入口：创建包、复制提示词、下载 ZIP、粘贴/上传 JSON、手动导入
- ✅ 单一五步 AI 分析中心：选择直播 → API 配置 → 内容 → 费用/预算 → 开始分析
- ✅ 新增按 `configId` 隔离的请求调度器：可配置初始并发 1–8、动态降级/恢复、429 `Retry-After`、指数退避 + 抖动
- ✅ 画像批次有界并发；删除 30 批上限；1,000 观众 Mock 通过
- ✅ 跨主播记忆 gate：较旧场次不得覆盖较新记忆
- ✅ 请求统计：请求/完成/失败/并发/排队/模型耗时/排队等待/限流等待/429/token/费用/ETA
- ✅ 本地性能修复：按批观众客观记忆、DNS 缓存、精确包查询
- ✅ 519 自动化测试；Mock 1,000 观众/10,000 消息 6.5 秒
- ✅（历史）v0.13.1 EXE 已构建（requireAdministrator；P18 已改为 asInvoker）
- ⬜ 真实付费 API（本机无 Key，阻塞）
- ⬜ 真实浏览器 UI / EXE 运行验收
- ⬜ 真实 Provider 429/1,000 观众/费用验证

## P14 真实 AI_IMPORT_INVALID 与观众级容错（v0.13.2，2026-11-13）✅

- ✅ 只读复制生产库/包，定位真实根因：ref 5 的合法证据是 seq 3，却引用 seq 5（属于 ref 3）；ref/seq 两套编号混淆
- ✅ 自动修复确曾发送；旧版一次 whole-batch repair 后仍跨观众，整批 7 人全部拒绝
- ✅ Prompt：excerpt 行增加 `ref`，契约明确 ref≠seq；repair 增加 evidence guard；错误携带 allowedSeqs
- ✅ 观众级容错：合法观众独立保存，非法观众 `failed`，再一次 viewer-scoped repair；失败仍可 Resume
- ✅ Resume 只请求 pending/failed 观众；旧任务无观众级保存的批次仍重跑该批 pending 观众
- ✅ 调度：批次级校验失败不阻断后续批次（concurrency=1/4）；Provider/取消/数据库错误仍停止新调度
- ✅ 统计：coverage.failed 与 partial 文案；真实任务副本回放 complete 47/47
- ✅ 632 自动化测试
- ⬜ 真实付费 API 生产任务 Resume（需用户授权）
- ⬜ 真实浏览器 UI 截图（本机沙箱限制）

## P15 AI 分析多语言输出与报告翻译（v0.13.2，2026-11-13）✅

- ✅ 区分 UI locale / 分析输出 locale / 原始内容语言；分析中心明确「分析输出语言」，默认 UI 语言、可手选
- ✅ Session 与 Memory 共用同一任务 locale；locale 随 `ai_jobs` 与运行时状态保存，UI 切换/暂停恢复不改变已保存任务
- ✅ Prompt v13.2 明确任意/混合语言原文直接理解、不逐条预翻译；自然语言字段按 locale，技术字段/枚举/ID 不变
- ✅ 报告页「报告语言」选择器；已有翻译直接显示，未翻译才提示付费翻译；原文/翻译对照
- ✅ 原始分析结果 + 段落级展示缓存：翻译不写 `ai_results` / `viewer_memories` / `memory_facts`
- ✅ 长期画像：只翻译 summary/statement；`viewer_id`、`topic`、事实 ID/状态/certainty/版本/证据/金额/时间不变
- ✅ schema 14：`ai_translations` / `ai_translation_runs`；按原始 ID + 字段路径 + 源 hash + 目标语言 + 翻译版本缓存
- ✅ 按需翻译：分块、单段失败保留成功段、只重试未完成段；缓存命中不再请求 Provider
- ✅ 翻译 usage/费用独立于 `ai_jobs`；未知价格不显示为零；首次翻译前明确费用提示与勾选确认
- ✅ 删除场次/删除记忆/清空数据联动清理翻译缓存；v13→v14 只新增表/索引
- ✅ 649 自动化测试；A–J 场景（日语→中文、缓存复用、部分失败、新版本隔离、证据清理、无 Provider/Key/网络失败、旧 Schema 1.1.0、三语 UI）
- ⬜ 真实付费 Provider 翻译质量/429/超时验收（本机无 Key）
- ⬜ 真实浏览器窄屏截图（本机沙箱限制）
- ⬜ 正式 EXE 重建（当前 `dist/LiveMemory.exe` 仍为 schema 13）

## P17 可扩展分层汇总与 32 批恢复（v0.13.2，2026-11-13）✅

- ✅ 真实任务只读定位：`contextLength=null` + 单请求 48k 硬上限 + compact 后 64,471 token → 请求未发出，非模型上下文超限
- ✅ 动态 token 分组：连续批次按真实估算切分，单组超预算自动二分，不再固定批次数
- ✅ 有界局部汇总：topics ≤12、sentiment ≤8、disputes ≤6、highlights ≤6、每项 refs ≤6；不重复完整原始 JSON
- ✅ 受控多层：depth ≤6，final 前最多 24 个 unit；超出继续加层，不静默丢批次
- ✅ schema 15 `ai_aggregate_nodes`：局部/final 节点独立持久化，source hash 复用，重启只补缺失节点
- ✅ 确定性校验：covered_batches、unit/batch 覆盖、有效 ref、时间顺序、事件去重；final 对 ≤96 批逐批补真实 ref
- ✅ 有界重试：截断/结构错误最多 2 次；仍失败用已保存结果确定性兜底；Provider 错误保留可恢复
- ✅ 恢复：`ANALYSIS_AGGREGATE_TOO_LARGE` 不再 change-model；32/32 已保存 → resume-aggregate
- ✅ 统计/UI：节点 usage 计入任务；AI 中心显示分层进度与兜底提示
- ✅ 683 自动化测试；生产副本 32/32 → 2 节点 + final（32/32 refs）；正式 EXE `58362fa30b5f` asInvoker 实跑验证
- ⬜ 真实付费 DeepSeek 32 批分层请求质量与费用（本机无 Key）
- ⬜ 真实生产任务 Resume（需用户授权）
- ⬜ 真实 UAC 双击与浏览器点击

## P16 最终汇总截断与恢复（v0.13.2，2026-11-13）✅

- ✅ 真实 18/18 任务只读定位：汇总 8k 输出预算 + 无界汇总契约 + `finish_reason=length`，输入 34k 未超限
- ✅ 独立汇总预算 12k–16k（按实际合并输入与上下文计算，不无限增长）
- ✅ 汇总专用有界 schema/三语提示词：topics ≤24、sentiment ≤12、disputes ≤8、highlights ≤8、message_refs ≤4
- ✅ compact 第二遍压缩保留全部批次与证据；装不下明确返回 `ANALYSIS_AGGREGATE_TOO_LARGE` 并提示更换模型
- ✅ `recovery` 状态：18/18+final 缺失只给 `resume-aggregate`；批次/画像/配置分别给准确动作
- ✅ 「继续最终汇总」独立恢复面板调用真实 Resume；刷新/重启后恢复；重复点击幂等
- ✅ `batchIndex` 1-based 规范化，旧 `batchIndex=0` 读取兼容且不再出现在失败批次
- ✅ `outputStats` 区分 API 成功与输出完整性/Schema 失败；界面解释 API 成功 ≠ 分析完成
- ✅ 668 自动化测试；18 条批次 id/version/checksum 在继续前后完全一致
- ✅ 正式 EXE 重建：buildId `61da4c6991e1` / commit `205db74` / SHA-256 `7231c056…` / 174 assets / requireAdministrator；asInvoker 副本实际启动，`/api/health`/`/api/bootstrap` 与打包 UI/API 已验证
- ⬜ 真实付费 Provider 的 16k 输出预算与截断后 Continue（本机无 Key）
- ⬜ 真实生产任务 Resume（需用户授权）
- ⬜ 真实浏览器点击与 UAC 双击验收

## P13 长期画像校验、语言与错误恢复（v0.13.2，2026-11-13）✅

- ✅ Memory 回答统一「组装 → 完整校验 → 最多一次修复 → 再校验 → 导入」，ref 覆盖完整不能绕过校验
- ✅ `viewer_id` 永远由本地映射注入；`memory` 四字段白名单；模型身份/未知字段被丢弃
- ✅ 字段级错误、stage、Job/Batch、可恢复性与建议进入任务状态和技术详情；`AI_IMPORT_INVALID` 不再空泛
- ✅ `last_error_json.batches[]` 按批次保留失败；成功批次不清除其他批次错误
- ✅ 三语长期画像 Compact 示例与语言要求；`topic` 作为稳定匹配键；旧包 instructions 不再产生冲突契约
- ✅ 事实准确性规则：stated/inferred/uncertain、本人证据、禁止编造、no_semantics 合法
- ✅ 报告/AI 中心统计划分：应处理/已处理/有语义/仅客观/未完成/失败
- ✅ session/memory usage 按子 Job 归属；任务总计由明细汇总；修复/重试计入真实 usage
- ✅ 628 自动化测试；并发 4 批、重启只补失败批、重复提交幂等
- ⬜ 真实付费 API 验收（本机无 Key）
- ⬜ 真实浏览器 UI 截图（本机沙箱禁止浏览器命名管道）
- ⬜ 失败模型回答的加密暂存（本轮只给方案）
- ⬜ 历史英文事实的人工/受控语言统一（不自动批量翻译）

## P12 AI 分析可靠性与 token 分批（v0.13.1，2026-11-12）✅

- ✅ 区分超时 / 用户取消 / 暂停 / 网络 / 429 / 5xx / 4xx / 无效响应 / 流中断
- ✅ 已发出的长请求超时默认不自动重试；取消与暂停绝不重试；仅连接错误一次安全重试
- ✅ `runPool` 失败改为停止调度新批次，不 abort 在途兄弟批次；已完成批次兼容保留
- ✅ 任务完成优先：无任务时间/费用/批次总量上限；单请求超时进入可恢复 needs_action；已完成批次保留
- ✅ 每次尝试脱敏日志：attempt、耗时、错误类型、HTTP status、是否收到响应头/输出、是否重试
- ✅ Token 预算动态分批：session 默认 24k、可配 2k–32k，固定开销/内容/输出分开；memory 观众不拆批
- ✅ 多批 session + final aggregate；全部消息覆盖、汇总去重、证据 `{batch, seq}`
- ✅ 自动 Streaming（OpenAI-compatible / Anthropic SSE），只缓冲、完成后校验；不兼容一次回退并持久化
- ✅ AI 中心：单场批次 n/N、等待汇总、已收到输出、运行时长、重试、已保存批次、真实失败原因
- ✅ 统计分开成功/失败/取消/超时/重试；无 usage 显示“用量未知”；ETA 需 ≥3 样本
- ✅ 全局 `[hidden]` 修复；真实浏览器 headless Edge 截图（运行中/完成/390px/设置页）
- ✅ 583 自动化测试通过
- ⬜ 真实付费 API 生成（本机无 Key，阻塞）
- ⬜ 真实 174k token 大场、真实 Provider 流式 usage 与费用
- ⬜ 真实 EXE / UAC / 打包后的流式连接验收

## 依赖关系

```text
M0 ✅ → M1 ✅ → M2 🟡 → M3 🟡 → M4 🟡 → M6 ✅ → M7 🟡 → P7 ✅ → P8 ✅ → P9 ✅ → P10 ✅ → P11 ✅ → P12 ✅ → P13 ✅ → P14 ✅ → P15 ✅ → P16 ✅ → P17 ✅
                     ↘ M5 ⬜（可与 M3/M4 并行设计）
所有 → M8 ⬜

# 2026-11-16 起的两条主线（互不阻塞，可交替推进）
P45 ✅（v0.14.0 正式发布）→ P38 ✅（规划/文档）→ P39 ✅（I18N-M0，2026-11-16）→ P40 ✅ → P41 ✅ → P42 ✅ → **P46 ✅（v0.15.0 正式发布，2026-11-17）**
P45 ✅（v0.14.0 正式发布）→ P38 ✅（规划/文档）→ P43 🟡（Kick G0 完成，待 G1）→ P44 🟡（后续候选逐个 G0–G6）
```

**主线排序原则**：国际化优先（P39–P42）已于 v0.15.0 发布完成；P43 的第一个新平台 G1 真实验证**尚未开始**，
且按用户指令本轮不启动 v0.16.0 或新平台开发，等待下一步指令。
理由：平台适配器会新增大量用户可见文案，先扩语言再逐个平台开发，可避免「每接一个平台就要
重新补 7 种语言」的重复工作；同时语言扩展不依赖任何新平台。

M3 的外部风险仍在：Bilibili 经济事件样本、YouTube 公开网页路径的条款合规评估与长期稳定性。P7 的真实浏览器界面验证与真实平台长时间运行仍需在允许网络与浏览器的环境补验。P8 的统一记忆仍需真实 AI 样本与真实大场覆盖验证；P9 已补上一条真实匿名接口样本，但只有一个 provider、受 2 请求/分钟限制，且未做 EXE/浏览器验收。M6 已完成文件协议与结果 Schema 的兼容性扩展；M5 备份与 M7 画像应继续沿用版本化、可校验的格式。

## P10 AI 权限重构与多 Provider（v0.13.0）✅

- ✅ 单场 Session Analysis 与长期 Viewer Memory Analysis 拆成独立任务/独立保存
- ✅ 手动 AI 仅单场：单包、无 memory 文件、无 viewer_profiles 要求、导入拒绝长期记忆
- ✅ 匿名免费 AI 仅单场；失败独立显示，不自动切换付费
- ✅ 自带 Key 免费模型仅单场；免费状态不因有 Key 而变成付费
- ✅ 历史：付费模型通过能力验证后可执行长期画像；**最终修订已删除价格/免费付费/opt-in/预算 gate，仅保留 memory 技术能力**
- ✅ 多 Provider Adapter：OpenAI、Anthropic、DeepSeek、MiniMax（区域）、阿里云百炼（区域）、OpenRouter、自定义
- ✅ OpenRouter 官方模型列表/价格/上下文/免费状态/结构化能力
- ✅ 本地加密凭据、区域密钥隔离、URL/私网/DNS 安全检查
- ✅ 六层能力检测、可选价格展示、usage 记录；**最终修订删除预算保护**
- ✅ 三语 UI：分析方式/内容/配置/价格/状态/暂停恢复
- ✅ schema 13、结果 Schema 1.3.0、旧 1.0–1.2 兼容
- ✅ 自动化测试（Mock）覆盖权限、Provider、单场、画像、52 观众批次、预算
- ⬜ 真实 Provider 生成（OpenAI/Anthropic/DeepSeek/MiniMax/DashScope）——缺 Key，阻塞
- ⬜ 真实浏览器 UI / Windows EXE 验收

## P54 AI Provider 凭据可靠性：Windows Credential Manager（2026-11-19，v0.19.1 正式发布）

- ✅ 调查旧 AES `secrets/ai-keys.json` + `icacls` 路径的权限失败面（ACL、账户切换、文件锁、
  `(R,W)` 缺 DELETE、损坏库）
- ✅ 主存储改为 Windows Credential Manager Generic Credential；每 Provider/引用独立；
  DPAPI + 当前 SID；`CRED_PERSIST_LOCAL_MACHINE`
- ✅ 固定 PowerShell + 内嵌 C# P/Invoke；Key 仅 stdin；Add-Type 临时目录使用应用 cache
- ✅ 旧凭据自动迁移、读回校验、标记、重试；旧文件不删除；只读回退
- ✅ 错误分类（不可用/拒绝/写入失败/损坏）；`{path}` 显示修复；不伪造成功、无明文回退
- ✅ 恢复出厂设置清理 vault 条目；数据库 Schema 仍 16
- ✅ unit 889 + integration 407（405 pass + 2 skip）；真实 CredMan 2/2；EXE 24/24
- ⬜ 整机重启、第二 Windows 账户、真实 UAC over-the-shoulder、组策略禁用 PowerShell 环境
- ✅ 作为 `0.19.1` 正式发布（Tag / Release / 资产证据见 `docs/RELEASE_HISTORY.md`）
