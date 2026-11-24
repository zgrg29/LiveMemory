# 2026-11-24：v0.19.3 报告翻译真实 Provider 专项

## 授权、基线和保护范围

基线 `147f1e5`（构建源码 `422b781`，v0.19.2 / Build `5e9388a8ddb9`）。用户明确反馈长期画像乱序已实际可用，本轮不改 `src/memory/`、AnalysisRunner、Provider 抽象/配置/凭据、存储或平台采集。数据库 Schema 仍 16，缓存身份仍 `lm-translation-v1`，已有报告/任务语言/画像/证据/客观统计不变。

用户先明确授权：只读现有 DeepSeek 配置/当前 Windows 用户的 Credential Manager，最多 3 次极小真实请求；随后明确指定目标第一场并允许读取该报告/翻译记录；最后单独授权第 3 次使用这场的 40 个失败报告字段。没有读取聊天原文、没有发送长期画像、没有写真实数据库。所有普通测试均使用隔离目录。

## 与上一轮故障的区别

v0.19.1 的失败进度将 `usage: undefined` 绑定到 SQLite，触发 `ERR_INVALID_ARG_TYPE`，覆盖原始失败原因。v0.19.2 已解决这个次生错误，但没有真实复测原始翻译，所以不能把上轮 Mock 结果描述为真实故障已关闭。上轮日志已加明确后续更正。

## 实际调查证据与根因边界

只读指定场次的翻译运行记录，确认最新一次实际为：149 项，97 成功、40 失败、12 未完成；4 次请求，5,927 input / 3,891 output，程序费用估算 USD 0.0064473（不是官方账单）。更早两个旧运行因 SQLite 次生错误没有保存 usage，不能推定免费。

40 个失败字段全部属于单场报告（summary、topic title/summary/key_points），共 1,578 个原文字符，非长期画像失败，不是报告不存在。没有原始失败响应存储，也没有其 finish_reason，故不能还原或伪造历史响应的具体结尾。

实际代码缺陷：

1. `ReportTranslationService.#run` 用 `max(1200, ceil(sourceChars / 2))` 估算输出，忽略 JSON/40 个 ID 的开销及语言膨胀。目标批次实际只给 1,200 上限。
2. `#parseAnswer` 只把 text 交给 `extractJsonObject`，不检查 `finishReason`；JSON 语法错误和合法 JSON 但缺 items 均成为 `TRANSLATION_INVALID_JSON`。40 段为单次批次，任何顶层解析失败导致整批失败。
3. 提示词同时要求 JSON 对象和 `Output plain text only`；且请求 `responseFormat: none`、`responseSchema: null`，没有启用 Provider 支持的 JSON 输出提示。它们是已确认协议风险，但不能仅凭这些行断言旧那次确实返回了纯文本。
4. 解析错误被当作可继续后续 chunk 的错误，没有协议停止机制；旧模型输出不保存，所以失败译文不能在事后本地重解析。

本轮 3 次真实调用结果：

| 请求 | 数据 / 参数 | 真正结果 |
| --- | --- | --- |
| 1 | 无个人数据合成日语 40 段，旧协议、max_tokens 1,200 | HTTP 200，content string，无 reasoning，stop，40/40；input 2,057 / output 1,125 |
| 2 | 第二组合成日语 40 段，旧协议、max_tokens 1,200 | HTTP 200，content string，无 reasoning，stop，40/40；input 1,617 / output 1,125 |
| 3 | 用户指定原 40 个失败字段，新协议、json_object、max_tokens 4,719 | HTTP 200，content string 2,289 字，无 reasoning，stop，40/40 ID 完整唯一；input 1,798 / output **1,276** |

这排除了“DeepSeek 一律返回不同响应字段/完全不兼容”的推测，并证明旧预算低于同一目标批次本次完整实际回答的需求。历史包没有保存，不能声称原失败一定是 length；但已确认预算缺陷，并在目标失败批次上验证新协议成功。真实验证使用生产 callProvider 与本轮协议/解析函数；它不是 EXE 内真实付费验收，不混淆证据等级。

授权 3/3 已用完，总计 input **5,472** / output **3,526**；不再追加请求。只记录类型/长度/枚举/计数/用量，没有把真实报告或返回译文写到仓库/用户库。

官方依据：[DeepSeek JSON Output](https://api-docs.deepseek.com/guides/json_mode/)、[Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)：json_object 需明确 JSON 提示，max_tokens 应覆盖完整结果；length 可截断内容，JSON 模式也可能给空白。

## 实现

新增 `src/ai/translation/protocol.mjs`，仍是轻量 `{items:[{id,text}]}`，没有分析 Schema 校验或新运行时依赖。

- 将“纯文本”限定到 text 值，响应明确为 JSON；输出预算包含序列化/ID 开销与膨胀预留，1,536–12,000 上限。上限不等于实际计费，真实目标只用 1,276。
- 已知 OpenAI-compatible Provider 使用 json_object，Anthropic/未知自定义或明确 json:false 使用提示词契约。只对明确 response_format 不支持的 400/422 做一次 prompt-only 回退，本次 run 后续沿用；不修改全局配置。
- 安全解析 JSON 对象、Markdown/BOM、ID 数组/映射、translations 数组及一层字符串包装。单段纯文本可明确对应；多段纯文本不猜顺序。重复/未知 ID、缺失/无效/过长 text 保持失败，不能串段。
- length/max_tokens 有单独错误。中断 JSON 仅提取完全闭合的条目，再校验 ID；不补造引号、括号、文字。完整条目立即缓存，缺失条目标失败，未请求的后续条目继续 pending。
- 内容/协议错误或已耗尽有界重试的请求错误停止本次 run，不连续购买相同错误。传输重试沿用原分类；不对 JSON 解析错误盲重试。重复 retry/重启只请求未成功的 cache key。
- Provider 诊断并行读取 response clone，不把 body 读取延迟混入头部超时。只保留字段类型/长度/finish reason/结构/数量/位置/预算/模式，不保留 final 或 reasoning 正文。
- 新增十语技术详情及 7 个具体原因，字典每份 2,390 键。预格式化详情允许换行，无新硬编码颜色。未重写分析中心或正常模块。

## 旧失败与费用恢复

97 个已成功缓存保持有效，不自动清空。旧 raw 没有保存，不能恢复那 40 段未缓存译文，也不能计算旧被掩盖请求的真实费用。新版本只重试 failed/missing，不重新分析整场或全部历史；若报告源 hash 未变则复用原 97 段。

真实第 3 次为只读验证，未回写真实缓存，也未保存私有译文；用户安装新构建后需在原报告选择“重试”，只补失败/未完成段落，仍会产生必要翻译费用。正常新翻译运行则会立即保存任何可验证的完整条目，避免把部分有效回答整批丢弃。

## 测试与最终产物

专项冻结运行 **34/34**：18 个纯协议、15 个报告集成、1 个十语翻译；其他字典/UI/缓存专项通过。新增另一条状态断言保证“失败且后续 pending”不被显示成纯 missing。长期记忆与 Provider/存储/平台代码差异检查为空。

最终全量：**1,344 passed / 0 failed / 2 skipped**，总计 1,346，346,436.1046 ms；日志 `tests/.tmp/full-translation-0193.txt`。最终 EXE 验收待填写。

## 限制

原历史失败响应与结束原因未保存，无法唯一追溯原包；真实用户数据库未回写，不声称已把界面 40 个失败状态修复成完成。真实 DeepSeek 目标 40 字段已验证，新 EXE 使用模拟 Provider 验收；其他 Provider 未逐一真实付费重测。真实双击 UAC、干净 Windows、完整十语浏览器布局矩阵未人工验收。未 Push、Tag 或 Release。
