# 2026-11-24：长期记忆乱序兼容与报告翻译修复（v0.19.2 本地补丁）

## 范围与基线

- 用户使用 v0.19.1；仓库基线 `cbf4d33`（此前发布证据修订，正式版本仍 v0.19.1）。本轮授权本地开发、兼容处理、专项/全量回归、EXE 与 Commit；未授权远程发布。
- 保留零依赖、用户自备 Key、Credential Manager、六平台/快手禁用、多直播隔离、身份/金额/EventIngest、语言快照和原文保留政策。

## 原顺序限制与替代设计

原 `src/ai/api/runner.mjs` 的 `#assertMemoryOrder` 查询同主播已有 memory/combined 结果的较新场次；在 `runMemory` 以及 broadcaster gate 前后抛 `ANALYSIS_MEMORY_OUT_OF_ORDER`。因此单场报告可已保存，但记忆任务尚未打包就被拒绝。`recovery.mjs`、canResume 和错误恢复逻辑又明确排除了该错误。

本轮移除 chronology 拒绝；gate 只按同主播串行，覆盖新任务创建、打包和请求，任务内不同观众批次保持有界并发。事务内重新读取当前事实再应用操作，旧 snapshot 不整份覆盖当前画像。

1. 使用消息 `occurred_at` / 证据 `observed_at`；缺少时回溯真实来源场次 `platform_started_at` / `started_at`；无法恢复的日期为 0（导出 null）。分析/更新时间仍在 created_at、updated_at、版本 applied_at，不能冒充事实时间。观察日期也不等于陈述中人生事件的实际发生日期。
2. 请求包含事实来源、观察时间、certainty、confidence、证据可用性、分析时间；明确 chronology.historical_backfill / known_memory_through，未知不猜测；消息原文保持原语言。
3. 不同兴趣允许共存。同 topic 身份状态或显式 update/supersede 保留历史；可靠新状态胜出时旧事实 superseded，旧信息后到时补历史，历史链按观察时间重建。较新弱证据、时间未知或用户核实保护命中时保留 competing/conflicted，不无条件覆盖。明确 conflict 保留双方。
4. stated > inferred > uncertain；同等级、置信度降低超过 0.15 时不因更近就覆盖；更早的明确陈述可纠正较新的弱推测，弱候选仍保留。程序不判断所有自然语言语义，不能把这个保守门槛当作真实性证明。
5. 固定天数不再自动失效稳定事实；临时状态仍需证据支持变化。没有半衰期分类系统，没有改变客观计数或金额算法。
6. 证据跨 job 按真实 event_id 去重；无 event 的旧单场派生依据按场次去重。同证据重放不升 confidence/certainty；无实际变化不创建版本。事务重读、旧 target 重合并、IMMEDIATE 事务和原单实例锁共同保护写入。
7. 摘要时间锚点来自语义版本/事实来源；不能使用客观账本会提前更新的 last_session_id。历史补录保留新摘要，新增历史事实仍可查看。

## 旧任务恢复与费用

旧错误不再被排除；已保存单场报告有效时提供 resume-memory。现有报告、成功批次、成功观众及 split 进度继续复用。v0.19.1 的 gate 通常发生于 memory job 创建之前，往往没有可复用的记忆提取结果；这种情况下只执行缺失记忆阶段，仍可能产生一次正常 AI 费用，不能声称完全免 Token。

没有自动遍历全部历史发起请求。EXE 专项实际验证从持久化的旧错误状态恢复：报告 job 不变，单场不再请求，仅 memory 请求 1 次。

## 翻译故障的真实根因与证据

v0.19.1 正式 EXE Build `b66818d032b5`（Node 24.21.0）在隔离本地模拟 Provider 返回 401 时，实际报告 `ERR_INVALID_ARG_TYPE`。复现输出在 `tests/.tmp/translation-baseline-2.txt`，仅包含合成数据。

精确调用链：

```text
ReportTranslationService.#run：没有 answer 的分支
  -> #updateRunProgress(run.id, {translated, failed}, progress)
  -> 组装 { ..., usage: undefined, ... }
  -> updateTranslationRun：JSON.stringify(undefined) 仍为 undefined
  -> StatementSync.run(...values)：usage_json 对应的第 4 个参数为 undefined
  -> ERR_INVALID_ARG_TYPE（旧 EXE）
```

另将基线 `ai-translations.mjs` 原函数在独立内存 SQLite 执行，获得准确调用栈（Node 24.22.1 对同一非法值显示 TypeError）：

```text
TypeError: Provided value cannot be bound to SQLite parameter 4.
  at updateTranslationRun (.../baseline-translations.mjs:146:80)
  at .../trace-translation-baseline.mjs:12:7
```

该错误属于本地失败进度持久化，掩盖了真实 Provider 错误；不依赖长期记忆任务状态。用户此前真实 Provider 的原始错误已经被旧版覆盖，无法据此断定用户当时也收到了 401。

修复：进度始终携带累计 usage；Repository 对 undefined 按省略处理，null 仍保留显式 SQL NULL 语义；最终 run 保存具体 Provider 原因。已成功/失败段落独立保存，重试只请求未完成内容。一次响应解析失败不重复计入 usage；本地程序/存储/参数错误准确分类，不自动付费重试。完整 hash/version 有效缓存优先于 Provider/凭据校验返回。

没有修改 Provider/模型/协议/Key，没有覆盖原报告、弹幕或长期画像；翻译仍只写 ai_translations / ai_translation_runs。新 EXE 已验证 401 原因保留为 PROVIDER_AUTH_FAILED，后续恢复 Provider 后独立成功。

## 数据兼容与国际化

Schema **16**，不增加列、不全库重写。旧时间在读取时恢复，下一次正常合并才保存；raw purged/unavailable 状态继续生效，不恢复原文。旧数据库、备份恢复、目录迁移沿用现有整库流程。设置、缓存、有效 API Key、稳定身份、金额/互动计数不重置。允许长期画像多语言事实共存，不作全量翻译。

十份字典各 **2,382** 键；新增 storage/internal/request 三种翻译原因，旧顺序错误文案改为可继续历史合并。新任务记忆提示词 v13.4-memory / m7.3；单场 v13.3-session 不变，既有任务快照不改。

## 验证与环境边界

- 专项：memory-temporal **21/21**，包括六排列、历史状态、弱证据、同 event 重复、过期 snapshot、旧时间/purged/unknown、多语言、三场历史链、同证据状态保护、事务回滚、明确历史补录标记。
- 现有翻译测试加独立失败/缓存/参数回归通过；Provider 失败精确断言原因与 unknown usage，不再只验证 failed。
- 首轮开发中全量 **1,298 pass / 11 fail / 2 skip**，发现并修正逻辑/快照期望问题后重跑。两项 Cookie 清理失败来自受管仓库继承的 Everyone Deny DeleteSubdirectoriesAndFiles；测试辅助允许 `LIVEMEMORY_TEST_TMP_ROOT` 指向独立 OS temp，原有全部 6 条断言通过。生产 ACL 和断言不变，未 skip 掩盖。
- 后续完整回归一轮 **1,311 pass / 0 fail / 2 skip**（364,520 ms）；新增最终案例的全量结果待填。
- 初步新 EXE 专项 **7/7**：旧错误 recovery、401 具体原因、日→中、缓存零额外请求、日语原文保留、只补 memory、运行身份。使用真实 Windows Credential Manager 随机测试引用并自动删除；Provider 为本地模拟，**不是**真实 DeepSeek 付费验收。
- 正式 EXE Manifest 仍 requireAdministrator；自动化仅使用已验证 Manifest 后生成的 asInvoker 测试副本，不能声称真实 UAC 点击/干净 Windows 已通过。

最终构建、最终回归、Commit 与文件哈希：待验收后更新。

## 尚未验证

真实 DeepSeek `deepseek-flash` 付费重测、用户原始失败请求的已丢失原因、真实双击 UAC 同意/拒绝、干净 Windows 账户、真实十语浏览器布局矩阵。未使用真实用户数据库/聊天/Key；没有未经授权的大量付费调用、Push、Tag 或 Release。
