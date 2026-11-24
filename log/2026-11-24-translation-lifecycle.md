# 2026-11-24：v0.19.4 报告翻译完整流程审查

## 基线、授权与边界

基线 3d5b73d；v0.19.3 / f90ab3d39fdf。用户已确认乱序记忆正常，本轮不改记忆算法、Provider/凭据、分析 Runner、平台/统计或 Schema。用户要求只读调查指定报告；未写生产库、未读取事件正文、未输出报告/画像正文或 Key。新增真实授权为最多 3 次合成小请求、总文本不超过 2,000 字，独立数据库；此前已用完的授权不复用。

## 12 项真实根因

只读源库：最新两次 v0.19.3 run 均 partial、137 translated / 0 failed / 12 pending；先前为 97 / 40 / 12。两次新运行分别已用 2 次请求（2,309 input / 1,531 output、本地估算 USD 0.0025299）和 1 次（511 input / 258 output、本地估算 USD 0.0004629）。说明重复请求确实产生用量；估算非官方账单。

逐一匹配全部 12 项：6 个 memory_summary.summary，6 个 memory_fact.statement；每项在数据库均有非空 ok 译文，targetKind/targetId/path/sourceHash/locale/version 完全匹配，但 session_id 属另一场。原文总计 350 字（以只读检查实际字段长度为准），未持久化正文。

真实失败函数：listTranslationItems 按 session_id 过滤；upsertTranslationItem 的唯一键不含 session_id，冲突更新也不改变首次场次。start 把这些项当缺失发送，#saveChunk 成功更新共享行；结束时按场次再查仍缺 12，因此 TRANSLATION_INCOMPLETE。不是模型漏答、尾批丢失、Token 截断或重试未入队；本次 metadata 证明译文实际存在。上轮只验证 40 个 session_result 字段，绕过了整个服务与跨场缓存读写，无法覆盖这一层。

## 修改与生命周期审查

- 保存报告读取：translationInputOnly 跳过 events 证据解析、观众昵称、实时画像与任务覆盖率；只读保存结果文本。阅读页与调度按已保存 final/single/batch 结果选相同来源，避免记忆状态决定报告选择。
- 输入：collectTranslatableItems 默认只取保存的报告及报告内文本；实时画像不入队、不参与完成条件。includeMemory 只用于兼容已有画像缓存，绝不借此发新画像请求。
- 缓存：按指定 items 完整唯一键读取，源场次不再导致漏查；语言/hash/version 不匹配仍严格隔离。没有挪动/清空缓存，Schema 16 / lm-translation-v1 保留。
- 调度：保留轻量 id/text、最多 40 项分批、有界传输重试、按能力 JSON 提示、输出预算与协议错误停止。所有尾批均执行；失败/缺失均入下次队列；完整有效字段永不重复请求。
- 进度：每批持久化后按完整缓存重算成功/失败/待处理，恢复时保留成功基数；程序重启的 interrupted run 不把 pending 误写为 0。
- 完成：只有报告所有必要文本有效才 complete；新打开全缓存报告不调用 AI。历史 run 的 usage/error 保留审计，UI 已完成时不把历史尝试错误显示为当前失败。
- AI 协议：无需再重写；v0.19.3 已是轻量 items/id/text，没有业务 JSON Schema。此次主要简化业务输入与完成边界，未加 Provider 特例或不兼容参数。DeepSeek 已有适配器关闭思考的行为沿用。
- 原文、聊天、证据、画像、金额/统计均不写。十语 languageHint 同步更新，2,390 键；AGENTS §6.19 与 AI_CONTRACT 固化独立文本转换决定。

## 真实证据（区分 API 与本地/EXE）

1. 实际用户报告只读生产代码验收：旧页面 149 项全部找到有效缓存并实际应用 149 项，缺失 0；报告本身 72/72、missing 0、failed 0、complete。强制禁止 API，生产库写入 0。12 项不是被忽略或标成功，而是全数复用既有有效译文。
2. 真实 DeepSeek deepseek-flash：独立合成完整日语报告（2 个必要字段）从空缓存经过 2 个请求/批次到 complete；删除合成缓存末项并关闭重开数据库/服务，第三次请求只补该项到 complete；再次关闭重开、打开/启动同语言为 complete、额外请求 0。保存报告、事件、画像、任务的逐表 hash 前后一致。
3. 新授权用尽 3/3，共 15 字输入文本；真实 usage 输入 552 / 输出 50、无 reasoning，程序估算 USD 0.0002256，非账单。总输入不是计费 token，提示词/JSON 开销已包含在 usage。未发送用户报告或画像。safe-result 仅含合成元数据，ignored。
4. 真实付费验证运行生产服务/解析/缓存/展示读模型，非单次 callProvider；不是 EXE 内真实付费测试，也不代表大报告/其他 Provider 全部真实验收。多字段/多批次规模与故障恢复另由模拟集成/EXE 验证。

## 验证与交付

新增跨场 12 项真实机制复现、禁读实时画像/事件/证据/覆盖率断言、多批次失败+pending+重启+尾批+无重复、interrupted 计数测试。既有日→中、九目标语言隔离、缓存版本、旧 Schema、推理/截断、记忆独立性及原文保护继续运行；旧“自动翻译当前画像”测试按本轮明确产品决定改为“不得发画像、原画像保持原文”，旧缓存映射保护测试仍保留。

完整回归 **1,348 passed / 0 failed / 2 skipped**（1,350 总计，344,365.0507 ms）；skip 为默认关闭的 opt-in 真实 CredMan。构建输出选项随后仅补跑 Manifest 专项 **2/2**，运行时代码未再改。

最终 EXE **89/89**：启动 11、十语帮助 14、凭据保存 24、备份迁移 13、AI 用量/恢复 16、翻译完整生命周期 11。新增跨场缓存零请求与实际 EXE 重启后报告仍 complete；凭据测试随机 target 均清理。Manifest **requireAdministrator**；功能自动化使用相同 Build 的 asInvoker 副本，不代表人工 UAC/干净账户验收。真实 API 为生产服务合成样本，EXE 使用本地模拟 Provider，二者明确区分。

交付文件 `D:\LiveMemory\dist\LiveMemory-v0.19.4.exe`，**99,856,384 B**；Build **`3ada1d72c57a`**；构建源码 **`818662d4cbe5c7b127eeffad5e6a689657b6cc5b`**（核心修复 `1d48965`）；builtAt `2026-11-24T11:17:27.347Z`；258 assets / 72 required modules；SHA-256 `db32a085afd02d0854e400b36927d97735a4f4e74fb4e612ba14dab2d45294c4`。校验文件为 `dist/SHA256SUMS-v0.19.4.txt`。旧 EXE 正在运行导致默认输出 EBUSY，未终止用户进程，改为独立版本文件。

## 尚未验证

其他 Provider 真实付费、真实双击 UAC/干净账户、十语人工浏览器布局矩阵未补验。生产库未写回，升级后重新打开报告由缓存派生完成；保留历史失败尝试作为费用审计，不伪造历史记录。未 Push / Tag / Release。

## 后续正式发布（用户明确授权，2026-11-24）

用户表示已 Push，并明确要求准备 release title/notes 后直接发布。远程 main 核对为 5106a61；发布准备 Commit 90fe50e，annotated Tag object 03f3f947 → 90fe50e 已 Push。标题 `LiveMemory v0.19.4 — Flexible Memory Updates & Report Translation Fixes`，发布说明英/中/日覆盖自正式 v0.19.1 后的本地修复与验收限制。运行时 src/package.json 相对已验收 818662d 无差异，未重新打包。

Release `https://github.com/zgrg29/LiveMemory/releases/tag/v0.19.4`，ID 456754532，published_at 2026-11-24T12:48:10Z，draft=false / prerelease=false / latest=true。先草稿上传并核对 digest，再发布；随后公开重新下载两文件校验通过。标准 LiveMemory.exe 99,856,384 B / db32a085…5294c4，SHA256SUMS.txt 82 B / 23c72620…b2283f；正文 hash `a480fa2dad7931951a108a71bf107b69c244eb6979cda94c6718babcc11bfa81`，与 Tag 中发布说明一致。旧发布未覆盖。

发布前版本/Manifest/i18n 19/19，复用全量及 89/89 EXE。发布凭据只通过现有 Git credential helper 在进程内读取，未打印或持久化；不使用 AI Key，无新增付费请求。最终发布事实同步 STATUS §0.69、RELEASE_HISTORY、HANDOFF、ROADMAP 与 TEST_PLAN。
