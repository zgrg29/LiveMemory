# 交接文档（HANDOFF）

本轮：2026-11-11 · v0.12.1 真实故障修复（自动紧凑格式 / 手动导入诊断） · schema 12 · 结果 Schema 1.2.0

## 1. 本轮结果

| 目标 | 结论 |
| --- | --- |
| 复现自动失败 | **已复现**。真实 25 观众批次在 `json_object` 模式下退化，`finish_reason=length`、9,250 completion tokens、重复字段名，JSON 不完整；修复请求同样失败。 |
| 复现手动 4 项错误 | **已定位**。提示词自相矛盾（“不要输出观众身份字段”）、52 个不透明 ID 的机械复制、`memory_context`/`viewer_context` 重复、零发言观众无规则；真实 52 观众探针复现了“漏观众”的同类失败。 |
| 自动模式可靠完成 52 位观众 | **已通过真实 OVH**。6 批 + 汇总，`complete`，52/52 覆盖，`missing_update=0`，7 条结果。 |
| 手动模式导入 | 修正后的 52/52 JSON 可在一个事务导入（测试）；真实 OVH 52 人单包返回 49/52，界面现在精确列出缺失观众并可复制修复指令。用户实际模型未知，不能宣称任意模型一次成功。 |
| 全量测试 | **545 passed / 0 failed**（约 77 秒，2026-11-11）。 |
| 真实浏览器 UI | **仍未验收**（本机策略）。 |
| EXE | 本轮**未重建/未运行**；v0.12.0 EXE 仍未运行验收。 |

## 2. 真实根因（证据）

### 2.1 自动故障 A

- 真实包：`aij_01M747M6H2DGBWKPERAG`，6 批中的 batch 1，25 位记忆观众、33 条消息，
  `estimatedTokens=41981`，`max_tokens=9250`。
- 真实请求：HTTP 200，169.5 秒，`prompt_tokens=44682`，`completion_tokens=9250`，
  `finish_reason=length`，内容尾部为重复的
  `"viewer_profiles","viewer_memory_updates","session_topics"`。
- 同一包换 `response_format=json_schema`：HTTP 200，72 秒，`finish_reason=stop`，
  `completion_tokens=2014`，JSON 有效；但因 `viewer_context.json` 含 7 位其他批次观众，
  模型输出 25 条时把其中 2 位写入、漏掉 2 位本批观众，产生
  `MEMORY_VIEWER_UNKNOWN` + `MEMORY_VIEWER_UPDATE_MISSING`。
- 原客户端只返回 `content`，不记录 `finish_reason`、usage 或退化特征。

### 2.2 手动故障 B

- 真实包：`aij_01M747QHVKRK8HNNPC0H`，1 批，99 条消息，52 位观众，日语，
  `memory_context.json` 67.6 KB，`viewer_context.json` 62.2 KB，提示词约 75k tokens。
- 三语 `instructions.md` 的 `memoryRules` 最后一句都禁止输出“观众身份字段”，与必须输出
  `viewer_memory_updates[].viewer_id` 冲突；日语版最严重。
- 52 人中有 1 位只有 Super Sticker、没有聊天发言（`youtube:UCkNUYsGPULqxk7Y90kdqS-Q`），
  包内没有针对零摘录观众的明确规则。
- 真实 OVH 52 人单包（新提示词）返回 49/52，缺 3 位，说明“漏观众”是模型行为，
  不是验证器误判；验证器正确拒绝。

## 3. 代码变化

### 3.1 新增

| 文件 | 职责 |
| --- | --- |
| `src/ai/auto/assemble.mjs` | 紧凑回答 Schema、ref 结构检查、ref→稳定 ID 组装、定向补充合并、汇总回答 Schema |
| `src/web/js/pages/ai-import-repair.js` | 纯函数：把 missing/unknown/duplicate/errors 生成可复制的修复指令 |

### 3.2 修改

- `src/ai/auto/config.mjs`：10 位/批、30 批上限、300 秒超时、structured output 标记、
  `AUTO_OUTPUT_TRUNCATED` / `AUTO_OUTPUT_DEGENERATED` / `AUTO_VIEWER_COVERAGE_INCOMPLETE`。
- `src/ai/auto/client.mjs`：`responseSchema` → `json_schema`；返回 `finishReason`、usage、
  `reasoningTokens`、`degenerate`；空内容 + `length` → 截断错误；字段名重复检测。
- `src/ai/auto/prompt.mjs`：紧凑批次契约；slim memory/evidence seqs；去重 messages/excerpts；
  定向补充提示词；汇总 prompt 附 structured schema；提示词预算不变（90k）。
- `src/ai/auto/runner.mjs`：紧凑评估、组装、一次定向补充、`source='auto'` 校验、
  旧提示词任务不复用、错误码优先级、汇总输出预算 12k。
- `src/ai/export/job.mjs`：`memory_context.viewers[]` 新增 `evidence_seqs` / `zero_excerpt`，
  去掉重复累计字段。
- `src/ai/export/context.mjs`：`session.duration_seconds`（避免用聊天回溯推断直播时长）。
- `src/ai/prompts/instructions.mjs`：删除三语矛盾句；新增精确复制 ID、零摘录、非本批观众、
  记录时长规则；形状块加标记以便自动 prompt 去掉完整 Schema。
- `src/ai/import/validate.mjs` + `src/memory/embedded.mjs`：`memory.gaps`（missing/unknown/
  duplicate，含昵称）。
- `src/server/routes.mjs`：preview 返回 `memory.gaps`。
- `src/web/js/pages/ai.js` + 三语 i18n：显示 gaps、复制修复指令。
- `src/ai/constants.mjs`：提示词版本 `lm-prompt-m6.3`。
- `package.json` / `src/shared/app-info.mjs`：0.12.1。

### 3.3 API

HTTP 路由不变：

```text
GET  /api/ai/auto/services       maxBatches=30
GET  /api/ai/auto/status?sessionId=
POST /api/ai/auto/run            {sessionId, locale, consent:true}
POST /api/ai/auto/cancel         {sessionId}
POST /api/ai/import/preview      新增 target.memory.gaps
POST /api/ai/import              不变
```

## 4. 关键规则（下一轮不要破坏）

1. 自动模式模型**永远不输出 viewer_id**；ref 只能由本地批次分配映射，重复/越界/缺失都拒绝。
2. 组装结果必须再走 `validateAnalysisImport()` + `importAnalysisResult()`；不能直接写 `ai_*`。
3. 缺少观众只能做一次有界定向补充；仍缺失即失败，不能默认 `no_new_information`。
4. 手动导入的 `viewer_id` 只原样接受；未知/缺失/重复都阻塞，界面只提示不修改。
5. `evidence_seqs` 是提示词辅助，不是新证据来源；验证器仍检查 `ai_job_memory_messages` 归属。
6. 批次上限 30 × 10 = 300 位，保持 v0.12.0 的 12 × 25 = 300 位容量，不得静默裁剪。
7. `lm-prompt-m6.3` 的失败任务不会被复用；重新点击会创建新任务，旧任务保留。
8. 免费接口不做高频压力测试；真实探针数量有限，结果只代表样本。

## 5. 测试 / 验证

- 全量：`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`
  → **545 passed / 0 failed**（约 77 秒，2026-11-11）。
- 新增：
  - `tests/unit/auto-assemble.test.mjs`：ref 检查、组装、定向合并、定向提示词。
  - `tests/unit/ai-import-repair.test.mjs`：修复指令不改 ID。
  - `tests/integration/auto-compact.test.mjs`：52 人/99 消息 6 批、100 位低活跃 10 批、
    缺失 ref 定向补充、补充失败、截断、零摘录观众。
  - `tests/integration/manual-52-viewers.test.mjs`：52 人单批证据归属、2 未知 + 2 缺失
    精确 gaps、修正后 52/52 事务导入。
- 真实探针（非自动化）：
  - 10 位/批：10/10，14.4 秒，489 completion tokens，`previewOk=true`。
  - 25 位/批：25/25，20.4 秒，751 completion tokens，`previewOk=true`。
  - 52 位真实全流程：6 批 + 汇总，`complete`，52/52，7 条结果，52 个记忆头。
  - 手动 52 人新提示词：49/52，缺 3 位；正确 52/52 JSON 可导入。
- 真实浏览器：**未运行**。
- EXE：本轮未构建；v0.12.0 的构建产物未运行验收。

## 6. 未验证 / 边界

- 用户手动分析实际使用的模型未知；任意模型一次覆盖 52 位没有保证。
- 25 位紧凑单批只做了一次真实样本；10 位完整运行已通过。
- 免费 OVH 2 请求/分钟，长场次总耗时可能较长；本轮未做 1000+ 观众真实测试。
- 真实浏览器中的 gaps 列表、复制按钮、暗色、390px 未验收。
- Windows EXE 出站请求、UAC、代理/防火墙仍未验收。
- 汇总 summary 仍可能把“消息回溯时间”说成直播时长；本轮已加入
  `session.duration_seconds` 与提示词规则，但未用新包重新跑真实汇总验证。

## 7. 常用命令

```bat
:: 全量测试（受限环境）
node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"

:: 只测本轮
node --test --test-isolation=none "tests/unit/auto-*.test.mjs" "tests/unit/ai-import-repair.test.mjs" "tests/integration/auto-*.test.mjs" "tests/integration/manual-52-viewers.test.mjs"

:: 启动
node src/launcher/launcher.mjs --no-open
```

## 8. 本轮 Commit

- 待提交（本地 commit，不 Push）。提交信息见最终报告。

## 9. 上一轮（v0.12.0）摘要

P9 匿名免费自动分析：OVHcloud `gpt-oss-20b`、3 位合成观众真实包、自动批次/汇总/修复、
525 项测试。真实 52 位用户样本暴露本轮修复的问题。详见
`log/2026-11-11-anonymous-ai-auto-analysis.md` 与 `docs/ANONYMOUS_AI_RESEARCH.md`。
