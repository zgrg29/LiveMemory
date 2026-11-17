# 发布历史与验收证据（RELEASE_HISTORY）

本文件归档**已经发生的发布**及其可追溯证据：Tag、Commit、GitHub Release ID、资产大小与
SHA-256、自动化结果和已知限制。它是历史记录，不是当前发布规则。

- 当前可重复执行的发布流程见 [`docs/RELEASE.md`](RELEASE.md)。
- 当前工程状态与待办见 [`docs/STATUS.md`](STATUS.md)。
- 逐版本功能变化见 [`docs/CHANGELOG.md`](CHANGELOG.md)。
- 每个版本的完整 Release Notes 在 [`docs/release-notes/`](release-notes/)。

> **证据优先级**：GitHub Release / Tag / 资产哈希是发布事实；本文记录当时的验收结果。
> 历史版本的测试数量、EXE 大小与限制不得被当作当前版本的验收要求或当前功能承诺。

## 版本总览

| 版本 | 类型 | Tag / Commit | GitHub Release | 发布资产 | 状态 |
| --- | --- | --- | --- | --- | --- |
| `v0.17.0` | 正式发布（快手预览组件；在线采集未开放） | `v0.17.0` → `5807e3e` | `448828056` · 2026-11-17T15:31:37Z | `LiveMemory.exe` + `SHA256SUMS.txt` | Published |
| `v0.16.0` | 正式稳定版（Kick） | `v0.16.0` → `c6c1ee4`（构建提交 `4a2bcd6`） | `448187380` · 2026-11-17T05:32:48Z | `LiveMemory.exe` + `SHA256SUMS.txt` | Published |
| `v0.15.0` | 正式稳定版（十语言） | `v0.15.0` → `e07233c` | `447343485` · 2026-11-16T17:09:41Z | `LiveMemory.exe` + `SHA256SUMS.txt` | Published |
| `v0.14.0` | 正式稳定版（五平台） | `v0.14.0` → `d268cf9` | `446701465` · 2026-11-16T07:01:11Z | `LiveMemory-v0.14.0-windows-x64.zip` + `SHA256SUMS.txt` | Published |
| `v0.13.2-rc.0` | RC0 预发布 | `v0.13.2-rc.0`（lightweight）→ `f14a932`（构建提交 `cb28624`） | `445425123` · 2026-11-14T16:22:25Z | `LiveMemory-v0.13.2-rc.0-windows-x64.zip` + `SHA256SUMS.txt` | Published |

---

## v0.17.0 — 快手 H5 预览（2026-11-17）

**范围**：新增第七个平台页签「快手」，定位为预览。URL 解析、H5 comment 适配器、SQLite、
单场 AI 分析、会话内长期画像、自动监控、异常恢复、十语 UI 与发布 EXE 已集成；**实时 H5
采集默认禁用**。六个已发布平台的协议、金额、身份、去重与保留策略未改；Schema 仍 16。

| 项目 | 值 |
| --- | --- |
| Release | `LiveMemory v0.17.0 — Kuaishou H5 Preview (Live Collection Disabled)` |
| Release ID / URL | `448828056` · https://github.com/zgrg29/LiveMemory/releases/tag/v0.17.0 |
| 状态 | `draft=false` / `prerelease=false` / `published_at 2026-11-17T15:31:37Z` |
| Tag | annotated `v0.17.0`（object `4cf356a27ea73e402520bb0df0ccb38455c60bae` → commit `5807e3e7dcb183fdd09515baacf0c4193591a7c2`） |
| 合并提交 | `9ae4a37f406a79ce8ae8addeb6e74c3b2ad90cf9`（`merge: release Kuaishou H5 preview (v0.17.0)`） |
| 功能提交 | `d49047af32f18b271b00043c1e19db44dd796fb8`（`feat: integrate Kuaishou H5 preview with collection disabled`） |
| EXE | 99,492,352 B；Build ID `47b42dc8417b`；SHA-256 `58b21dc9cb362a8f4918924aae6ab12792b198ee342f0a805ddbcb8d830471ac` |
| `SHA256SUMS.txt` | 82 B；SHA-256 `dfa9716b10e291104877999a114197a2410a15164e7c2f5cf49303a377001879` |
| Manifest | `requireAdministrator` |
| 全量测试 | 844 unit + 382 integration = **1,226 passed / 0 failed / 0 skipped**（`--test-isolation=none`，336,443 ms） |
| Kuaishou 专项 | **49 passed**（unit 39 + integration 10） |
| 十语言字典 | 10 × 2,351；缺失/多余/占位符/空值/英文残留 0 |
| 真实浏览器 UI | **80/80**（10 语 × 1440/1024/820/390 × 明暗） |
| EXE 验收 | Kuaishou **10/10**；`verify-exe` **11/11**；`verify-help-exe` **14/14** |
| 真实 H5 / 真实 EXE 采集 | **未执行**（无书面许可） |
| Release body | 与 `docs/release-notes/v0.17.0.md` 逐字节一致（SHA-256 `3454b3d05d9b3d4ed6f37ac381741a743ae4bbc2c99e9bb529cd8f1180ae0e7b`） |
| 下载复核 | EXE 大小与 SHA-256 与本地一致；`SHA256SUMS.txt` 内容一致 |

**未验证 / 已知限制**：未取得快手书面许可，未进行真实 H5 采集、真实许可下长测、真实
下播→再开播；跨场/跨日 `userId` 稳定性未证明；礼物/点赞 `NOT-OBSERVED`；H5 无消息 ID、
无续传游标；真实双击 UAC 与干净 Windows 账户未人工验证；EXE 未签名。

**相关记录**：`docs/release-notes/v0.17.0.md`、`docs/RELEASE_CHECKLIST_v0.17.0.md`、
`docs/KUAISHOU_H5_INTEGRATION.md`、`docs/STATUS.md` §0.60。

---

## v0.16.0 — Kick 支持与自动开播监控（2026-11-17）

**范围**：新增第六个直播平台 Kick（免登录公开聊天、KICKs/赠订、开播监控、自动录制）。
原五个平台、Schema 16、金额/身份/去重规则与任务语言快照语义未改。

| 项目 | 值 |
| --- | --- |
| Release | `LiveMemory v0.16.0 — Kick Support & Auto Live Monitoring` |
| Release ID / URL | `448187380` · https://github.com/zgrg29/LiveMemory/releases/tag/v0.16.0 |
| 状态 | `draft=false` / `prerelease=false` / `published_at 2026-11-17T05:32:48Z` |
| Tag / 构建提交 | `v0.16.0`（annotated object `1fcbe2b`）→ `c6c1ee4cf9305cb9b0acec8074278222fd3b0b17`（`docs: release v0.16.0 and record the Kick release verification`）；构建提交 `4a2bcd6f5c54554cc20629257b3a548011cdf056`（`merge: release Kick as the sixth live platform (v0.16.0)`） |
| EXE | 99,342,336 B；Build ID `ac0daca067b3`；SHA-256 `d6c39ee259ed5b8f35c4174eede54c2dfc436bd49edcd57b18e50f1591118094` |
| `SHA256SUMS.txt` | 82 B；SHA-256 `08967360d0986ca89b130a006814c7905b0720bd64030e5b8f10a6bb45499543` |
| Manifest | `requireAdministrator` |
| 全量测试 | **1,177 passed / 0 failed / 0 skipped**（285,534 ms） |
| Kick 专项 | 75 passed；真实监控验收 16/16；Kick UI 20/20 |
| EXE 验收 | `verify-kick-exe.mjs` **27/27** |
| 下载复核 | 从 GitHub 重新下载 EXE，大小与 SHA-256 均与本地一致 |

**未验证 / 已知限制**：真实下播/下一次开播在 G5.1 窗口内未自然发生（状态机由集成测试覆盖）；
订阅/续订、开播/下播事件、Host、投票 `NOT-OBSERVED`；频道改名后轮询 slug 会 404；无续传游标；
KICKs 不换算法币；真实双击 UAC 与干净 Windows 账户未人工验证。

**相关记录**：`docs/release-notes/v0.16.0.md`、`docs/KICK_G2_G5_ACCEPTANCE.md`、
`docs/KICK_G5_1_MONITORING.md`、`docs/STATUS.md` §0.55。

---

## v0.15.0 — 十语言国际化（2026-11-17）

**范围**：界面语言从三种扩到十种，AI 输出十语，新增独立 `aiOutputLocale`、报告阅读翻译、
跨语言长期画像共存与十语言启动器/内置使用说明。**未新增直播平台**。

| 项目 | 值 |
| --- | --- |
| Release | `LiveMemory v0.15.0 — 10-Language Internationalization` |
| Release ID / URL | `447343485` · https://github.com/zgrg29/LiveMemory/releases/tag/v0.15.0 |
| 状态 | `draft=false` / `prerelease=false` / `published_at 2026-11-16T17:09:41Z` |
| Tag / 目标提交 | `v0.15.0`（annotated object `75d238d`）→ `e07233cc1dababc138830bcd63d76f5eb5269338` |
| 合并提交 | `37a075e1f0e726742c9133dad8a4dad232effc6b`（`--no-ff`，父 `a70321c` + `07cfaf1`） |
| EXE | 99,200,512 B；Build ID `945bee868455`；SHA-256 `b8458ab75704ebedc44fc64ebe000ddf97828687bf1af7896266b219469c826e` |
| `SHA256SUMS.txt` | 81 B；SHA-256 `ea3f61201ff2c8c63b1c988eec8d0f5762c3addedd848ec7841028e461e3421a` |
| Manifest | `requireAdministrator` |
| 全量测试 | 747 unit + 355 integration = **1,102 passed / 0 failed / 0 skipped**（292,904 ms） |
| EXE 验收 | `verify-exe` **11/11**；`verify-help-exe` **14/14**；`verify-ai-token-exe` **16/16** |
| 十语言字典 | 10 × **2,271** 键；键集/占位符差异 0 |
| 真实 Provider | DeepSeek `deepseek-flash`：单场 10/10、画像 10/10、跨语言 4/4、翻译 5/5 + 失败回退（复用 P42 证据） |
| 下载复核 | 重新下载 EXE，大小与 SHA-256 与本地一致 |

**未验证 / 已知限制**：真实双击 UAC 与干净 Windows 账户未人工验证；十种语言无母语审校签收；
长报告多块翻译与真实 429 未覆盖；EXE 未签名；TikTok 礼物/抖音真实礼物/Twitch Bits 仍
`NOT-OBSERVED`。

**相关记录**：`docs/release-notes/v0.15.0.md`、`docs/STATUS.md` §0.51。

---

## v0.14.0 — 五平台正式发布（2026-11-16）

**范围**：在 Bilibili 与 YouTube 之外正式加入 Twitch、抖音与 TikTok；五平台、多房间并发、
长期观众画像、独立 AI 输出、备份恢复与三语界面。

| 项目 | 值 |
| --- | --- |
| Release | `LiveMemory v0.14.0 — Multi-Platform Release` |
| Release ID / URL | `446701465` · https://github.com/zgrg29/LiveMemory/releases/tag/v0.14.0 |
| 状态 | `draft=false` / `prerelease=false` / `published_at 2026-11-16T07:01:11Z` |
| Tag / 目标提交 | `v0.14.0`（annotated object `ffc4a22`）→ `d268cf9b5c64d467872c55425bf6446bf614880c` |
| 发布包 | `LiveMemory-v0.14.0-windows-x64.zip`，35,977,845 B，SHA-256 `5d7b7e65eb3cea72156c5ecd97496c277427e1a33782d5b75b7a16dc09091188` |
| 包内 EXE | 97,769,984 B；Build ID `17f84b1956e1`；SHA-256 `6862079a025fa08d5b7fcf82c16cc3152fedbb7852866022dad4c96977bbe0d9` |
| `SHA256SUMS.txt` | 314 B；SHA-256 `11f89649fa77884725492bb75f366c651cfdd701b9a2600e9282d4388b8e8f07` |
| Manifest | `requireAdministrator` |
| 全量测试 | 687 unit + 347 integration = **1,034 passed / 0 failed / 0 skipped** |
| EXE 验收 | `verify-exe` **10/10**；`verify-p0-2-exe` **13/13**；`verify-ai-token-exe` **16/16** |
| 下载复核 | zip Range 请求 206、总长一致；`SHA256SUMS.txt` 200 且内容正确 |

**未验证 / 已知限制**：真实双击 UAC 与干净 Windows 账户未人工验证；真实手机扫码、真实礼物
未执行；TikTok 礼物/连送/订阅、抖音真实礼物、Twitch Bits/赠订仍 `NOT-OBSERVED`；界面仍三语。

**相关记录**：`docs/release-notes/v0.14.0.md`、`docs/STATUS.md` §0.46。

---

## v0.13.2-rc.0 — RC0 预发布（2026-11-14）

**范围**：RC0 稳定性、安全性与可靠性版本：管理员清单、本地 API 会话认证、AI 批次保存/继续、
长期画像校验、YouTube 生命周期修复、三语使用说明与完整备份恢复。

| 项目 | 值 |
| --- | --- |
| Release | `LiveMemory v0.13.2 RC0` |
| Release ID / URL | `445425123` · https://github.com/zgrg29/LiveMemory/releases/tag/v0.13.2-rc.0 |
| 状态 | 已发布（`published_at 2026-11-14T16:22:25Z`）；Release 正文标注为 RC0 预发布 |
| Tag / 构建提交 | `v0.13.2-rc.0`（lightweight tag）→ `f14a932ad5220de46e3204bc22821b6dd15bc698`（`docs: prepare RC0 GitHub release materials`）；EXE 的 `build-info.commit` 为 `cb286241fe5a4b3322455d661218bb0a14044983`（`fix: restore administrator manifest for the Windows EXE`） |
| 发布包 | `LiveMemory-v0.13.2-rc.0-windows-x64.zip`，35,724,481 B，SHA-256 `8aa08f0e1e908e80880b578b8cf6d6eb24f560f968d338824ff5684bf5598a2f` |
| 包内 EXE | 96,733,184 B；Build ID `e438e74803cb`；SHA-256 `0cf672438a4723589f4164316e98965a6ff549a132deb30a243638a3f62531c8` |
| 包内其他文件 | `README.md` 48,321 B；`LICENSE` 1,063 B；`RELEASE_NOTES.md` 10,875 B |
| `SHA256SUMS.txt` | 314 B；SHA-256 `03eb1a791304251f18ebaa47d0c8120e7abc2bda3da1190a07049ba59da56c9f` |
| Manifest | `requireAdministrator`（构建断言 + 注入后复读） |
| 自动化 | **828 passed / 0 failed / 0 skipped**（212,358 ms） |
| EXE 回归 | `verify-exe` 10/10、`verify-help-exe` 14/14、`verify-p0-5-exe` 12/12、`verify-p0-2-exe` 13/13、`verify-ai-token-exe` 16/16 |

> **历史说明**：`docs/RELEASE.md` 的早期版本曾把 RC0 写成“未发布”，那是发布准备阶段的记录；
> 实际上该 Tag 与 GitHub Release 已于 2026-11-14 发布。本文件以 GitHub 发布事实为准。
> Release 正文将它标为预发布，但 GitHub API 的 `prerelease` 字段为 `false`；两种记录同时保留，
> 不修改历史 Release。

**未验证 / 已知限制**：真实 Windows 双击与 UAC 点击待人工确认；干净 Windows 环境未验收；
真实礼物/扫码等事件未覆盖；界面三语。

**相关记录**：`docs/release-notes/v0.13.2-rc.0.md`、`docs/STATUS.md` §0.32。
