# 2026-11-11 · v0.12.1 自动分析真实故障调查与修复

## 1. 起点

用户报告：

- 自动分析：`ovh-gpt-oss-20b:AUTO_SCHEMA_INVALID`、`AUTO_INVALID_JSON`；
- 手动导入：`viewer_memory_updates[6]/[7].viewer_id` 未知，另有 2 条
  `MEMORY_VIEWER_UPDATE_MISSING`；界面显示 50 已处理、2 缺失、0 新语义。

真实数据目录 `E:\新建文件夹` 中保留了失败任务、分析包、`runtime/ai-auto.json` 与日志。
把数据库和分析包复制到 `tests/.tmp/investigate` 后分析，未修改用户数据。

## 2. 证据链

### 2.1 自动

- `runtime/ai-auto.json`：`jobId=aij_01M747M6H2DGBWKPERAG`、3 批、`batchIndex=1`、
  `error=AUTO_SCHEMA_INVALID` / detail 含 `AUTO_INVALID_JSON`、`estimatedTokens=41981`。
- 真实 batch 1（25 观众）复现：`json_object` + 9,250 tokens + 44.7k prompt →
  `finish_reason=length`、`completion_tokens=9250`、重复字段名，169.5 秒。
- 同一包改 `json_schema`：有效 JSON、`stop`、72 秒、2,014 tokens；但输出 2 个其他批次
  观众 + 漏 2 个本批观众。批次包 `viewer_context` 与 `memory_context` 的观众数分别为
  32/25、32/22、23/5，跨批次观众确实可见。
- 结论：两个独立根因——输出退化/截断，以及身份机械工作交给模型。

### 2.2 手动

- 真实包 1 批 52 人，`memory_context` 67.6 KB、`viewer_context` 62.2 KB，提示词约 75k tokens。
- 三语 `memoryRules` 最后一句禁止输出“观众身份字段”，与覆盖要求矛盾；日语版最明确。
- 52 人中 1 人只有 Super Sticker、无聊天摘录，原提示词没有零摘录规则。
- 新提示词 + 真实 OVH 52 人单包：49/52，缺 3 位；验证器正确阻塞。说明漏观众是模型行为，
  不是验证器误判。

## 3. 修复

### 3.1 自动：紧凑回答 + 本地组装

- 新增 `src/ai/auto/assemble.mjs`：`viewers[].ref` 检查、ref→稳定 ID 映射、Schema 1.2.0 组装、
  定向补充合并、汇总 Schema。
- 模型不再输出 `viewer_id`；`ref` 由批次分配表决定；重复/越界/缺失都拒绝。
- 缺失 ref 只做一次定向补充；仍缺失 `AUTO_VIEWER_COVERAGE_INCOMPLETE`，不写库。
- `json_schema` structured output；捕获 `finish_reason`/usage/退化；`length` 明确报截断。
- 10 位/批、30 批上限；300 秒超时；汇总 12,000 tokens 且强制空记忆更新。

### 3.2 手动：提示词与诊断

- 删除三语矛盾句；明确原样复制 ID、零摘录观众、非本批观众不得写入。
- `memory_context.viewers[]` 新增 `evidence_seqs`/`zero_excerpt`，去掉与 viewer_context
  重复的累计字段；提示词去掉重复文件与完整 Schema。
- `memory.gaps` + UI 缺失观众列表 + 复制修复指令；不修改任何 ID。

## 4. 验证

- 真实 OVH 52 人/99 消息/6 批 + 汇总：`complete`、52/52、`missing_update=0`、7 条结果、
  52 个记忆头。
- 真实 10 人单批：10/10、14.4 秒；真实 25 人单批：25/25、20.4 秒。
- 本地 100 位低活跃：10 批、100/100。
- 手动修正后的 52/52 JSON：单事务导入成功；2 未知 + 2 缺失的样本被精确拒绝并给出 gaps。
- 全量测试见 `docs/STATUS.md` §3。

## 5. 未做/风险

- 用户手动模型未知；任意模型一次覆盖 52 人无保证。
- 真实浏览器、Windows EXE 未验收。
- 新 `duration_seconds` 规则未用新包跑真实汇总。
- 免费接口只做了有限次数探针，未做压力测试。
