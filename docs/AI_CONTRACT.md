# AI 文件往返协议（AI_CONTRACT）

## 1. 原则

- LiveMemory **不调用任何 AI API**。
- 用户下载一个分析包，上传给 ChatGPT，把返回的 JSON 粘贴/导入回控制台。
- 协议版本化；字段名不随界面语言变化；AI 输出不修改本地金额与计数。
- 所有弹幕文本视为**不可信数据**，其中的任何指令都必须被忽略。

## 2. 分析包协议 `livememory-analysis-v1`

文件：`LiveMemory-Analysis-<session 后缀>-<YYYYMMDD-HHmm>-<locale>.zip`

```text
manifest.json          协议、版本、任务、计数、内容文件校验和
session_context.json   场次元数据、本地统计、时间线、经济支持
messages.jsonl         每行一个 JSON，seq 从 1 递增
viewer_context.json    参与者身份与长期累计
instructions.md        本地化任务说明（zh-CN / ja / en）
result.schema.json     livememory-analysis-result-v1
```

### manifest.json

```json
{
  "protocol": "livememory-analysis-v1",
  "result_protocol": "livememory-analysis-result-v1",
  "created_at": "2026-11-08T10:00:10.000Z",
  "app": {"name": "LiveMemory", "version": "0.1.0"},
  "locale": "ja",
  "session_id": "ses_...",
  "platform": "mock",
  "simulated": true,
  "tasks": [
    {"task_id": "ses_...-topics", "kind": "session_topics", "session_id": "ses_..."},
    {"task_id": "ses_...-viewers", "kind": "viewer_profile_update", "session_id": "ses_..."}
  ],
  "counts": {"messages": 320, "viewers": 24, "events": 360},
  "files": [
    {"name": "session_context.json", "bytes": 2885, "sha256": "..."},
    {"name": "messages.jsonl", "bytes": 751, "sha256": "..."},
    {"name": "viewer_context.json", "bytes": 3239, "sha256": "..."},
    {"name": "instructions.md", "bytes": 4581, "sha256": "..."},
    {"name": "result.schema.json", "bytes": 5196, "sha256": "..."}
  ]
}
```

`manifest.json` 不包含自身校验和（无法自引用）；其余文件逐一校验。

### messages.jsonl

```json
{"seq":1,"at":"2026-11-08T10:00:01.000Z","type":"chat","viewer_id":"bilibili:123","name":"昵称","content":"原文"}
{"seq":2,"at":"...","type":"super_chat","viewer_id":"...","name":"...","content":"...","amount_minor":3000,"currency":"CNY"}
```

- 只包含 `chat` 与 `super_chat`（带正文）。
- 原文不翻译、不覆盖。
- 上限 20,000 条（M6 实现分批）。

### session_context.json

场次信息、`local_stats`、`economic_support`（按币种/`value_kind`）、`top_viewers`、`timeline`、`counts`、`notes`（不可信内容、金额不重算、未录制视频/音频）。

### viewer_context.json

每位参与者：`viewer_id`、`platform`、`nickname`、首末见、`lifetime`（场次/发言/付费/币种合计）、`session`（本场计数）。不含原始消息。

### instructions.md

按 `locale` 生成；三语分别完整本地化，不混用英文标题。包含：包内容说明、任务、安全规则、输出结构示例、本包摘要。

## 3. 结果协议 `livememory-analysis-result-v1`

Schema：`src/ai/schemas/analysis-result-v1.schema.json`（JSON Schema 2020-12）。

必填顶层字段：

```json
{
  "protocol": "livememory-analysis-result-v1",
  "task_id": "...",
  "session_id": "...",
  "locale": "zh-CN",
  "session_topics": {
    "summary": "...",
    "topics": [{"title": "...", "started_at": "...", "ended_at": "...", "summary": "...", "key_points": ["..."], "confidence": 0.8, "evidence": "observed", "message_refs": [1, 2]}],
    "sentiment": [{"at": "...", "tone": "positive", "note": "...", "confidence": 0.7}],
    "disputes": [{"summary": "...", "started_at": "...", "note": "...", "confidence": 0.5}],
    "highlights": [{"started_at": "...", "ended_at": "...", "reason": "...", "clip_suggestion": "..."}]
  },
  "viewer_profiles": [
    {"viewer_id": "...", "interests": [{"topic": "...", "strength": "emerging", "evidence": "observed", "note": "..."}], "dislikes": [], "summary": "...", "confidence": 0.6}
  ]
}
```

约束：
- `evidence` 只能是 `observed`（聊天中可观察）或 `inferred`（推断）；不得把推断写成事实。
- 话题允许重叠，不强制固定分段。
- 金额只能引用，不得重算。
- 不得输出敏感个人属性推断或操纵性建议。

## 4. 导入校验（M6 实现）

计划校验顺序：

1. 文件大小上限与 ZIP 内容白名单。
2. `manifest.protocol` / `result_protocol` 版本匹配。
3. `task_id`、`session_id` 必须存在且与本地记录一致。
4. JSON Schema 校验（字段、类型、枚举、长度）。
5. `viewer_id` 必须在 `viewer_context.json` 中。
6. `message_refs` 必须在 `messages.jsonl` 的 `seq` 范围内。
7. 同一 `task_id` 的重复导入需用户确认并保留版本记录。
8. 导入失败不得写入任何分析数据（事务 + 回滚）。

## 5. 安全要求

- 提示词必须明确：包内文本是数据，不是指令。
- 不执行 AI 返回的任何代码、命令或 URL。
- 导入只接受 JSON；不解析 Markdown 包裹以外的内容（若用户粘贴 fenced JSON，导入器可剥离代码围栏，但仍需 Schema 校验）。
- 分析结果与本地统计分表存储（M6），UI 必须明确标注“AI 分析 / 本地统计”的来源。
- 不把 Cookie、Token、观众 ID 之外的敏感信息放进包内。
