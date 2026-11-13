# 2026-11-13 · 真实 AI_IMPORT_INVALID 调查与观众级容错

## 1. 真实失败任务（只读复制生产库）

- 失败任务：`aij_01M7963928KHJGNJTD64`（`viewer_memory_analysis`，memory-only，locale zh-CN，prompt `lm-prompt-v13.1-memory-zh-CN`）。
- 场次：`ses_01M7859TYTHCSZC13B8K`（Bilibili，紗耶_sayako）。单场报告任务 `aij_01M795YNYTMSP2WW8YM3` 已 `complete`，有 final 结果；长期画像失败没有删除它。
- 画像任务：47 名观众、5 批；批次 1–4 已导入（40 名 semantic），批次 5 **7 名全部 pending**。
- 失败批次 `aij_01M7963928KHJGNJTD64-b05`：7 条消息、7 名观众，每名观众 1 条消息。
- `ai_jobs.usage_json`：**8 次请求，77,204 input / 37,327 output**，`pricing_status=unknown`，`cost=null`（未知，不显示为 0）。
- 生产库仅复制到 `tests/.tmp/prod-audit-2026-11-13` 只读查询；未写入生产数据。

## 2. 真实错误与证据映射

错误：

```text
viewer_memory_updates[4].operations[0].evidence[0]
MEMORY_EVIDENCE_OTHER_VIEWER
{"seq":5,"viewerId":"bilibili:1765635337","actual":"bilibili:5240206"}
```

批次 5 的实际映射（来自 `ai_job_memory_messages` 与包内 `memory_context.json`）：

| ref | viewer_id | nickname | 允许 evidence seq |
| --- | --- | --- | --- |
| 3 | `bilibili:5240206` | （另一名观众） | **5** |
| 5 | `bilibili:1765635337` | （失败观众） | **3** |

`seq 3` 属于 ref 5（`1765635337`）；`seq 5` 属于 ref 3（`5240206`）。模型在为 ref 5 生成事实时引用了 **seq 5**，也就是另一名观众的消息。

### 已验证事实

1. `seq` 是**单个批次内全局唯一**的编号（`viewer_excerpts.jsonl` 的序号），不是每名观众从 1 开始；同一个 seq 不会对应两个观众。
2. 包的 `memory_context.json`、`ai_job_memory_messages`、`memory_context.viewers[].evidence_seqs` 三者的 viewer/seq 映射一致；**没有发现数据打包或编号映射错位**。
3. 失败批次是 7 名观众、7 条散点消息；ref 顺序与 seq 顺序相反：ref 5 自己只有 seq 3，而 seq 5 属于 ref 3。
4. 旧 Prompt 的 `viewer_excerpts.jsonl` 每行只有 `seq`、`viewer_id`、`name`，**没有 `ref`**；`memory_context` 使用 `ref` 但没有 viewer_id。模型需要在两套编号空间之间自行对照。
5. 旧 `memory_context` 中 ref 5 的 `evidence_seqs=[3]`，但模型仍用了 seq 5。这是 **ref 与 seq 两套小整数编号发生混淆**的高置信度解释；无法读取模型内部推理，故不能把它写成“已证明的模型思考过程”。

### 自动修复为什么没有成功（日志证据）

生产日志 `ai.request.attempt` / `ai.analysis.memory.repair`：

- 批次 5 首次回答失败，错误类别为 `SCHEMA_TYPE` / `SCHEMA_ENUM`（不是跨观众证据）。
- 程序确实发送了 **1 次 whole-batch repair**（`kind=memory-repair`，batchIndex=5）。
- 修复回答修好了 schema，但引用了 seq 5 → `MEMORY_EVIDENCE_OTHER_VIEWER`。
- 旧代码的自动修复上限是 1 次；修复后的结果再次失败后直接失败整个批次，**没有第二次针对性修复**。
- 8 次请求的构成：batch1 1、batch2 2、batch3 2、batch4 1、batch5 2。单请求 token 未持久化，只有任务总 usage。
- 因此“自动修复没有解决”不是因为没发请求，而是因为：
  1. 第一次修复的输入错误是 schema 类型/枚举，没有把“证据归属”作为重点；
  2. 修复回答引入了新的 evidence 归属错误；
  3. 旧代码只允许一次修复，不会针对失败观众再试一次；
  4. 旧 Prompt 没有在 excerpt 行上标注 `ref`，也没有明确“ref 数字不等于 seq 数字”。

## 3. 原有错误隔离能力

| 层级 | 旧版实际行为 |
| --- | --- |
| 整场单场报告 | **保留**。单场任务独立完成；memory 失败不删除报告。 |
| 批次 | 已成功批次独立保存；失败批次 7 人全部 pending。`runPool` 在首个错误后停止调度**尚未开始**的批次；已启动的其他批次继续。并发 3 时，这个真实任务的 5 批都已在失败前启动/完成，所以没有观察到后续批次被阻断；concurrency=1 时旧逻辑会停止后续批次。 |
| 单个观众 | **没有观众级隔离**。一名观众 evidence 错误导致整个批次 7 人都不导入；批次内 6 名合法观众的结果丢失（未持久化），Resume 只能重跑整批 7 人。 |
| 单条记忆操作 | 没有操作级保存；同一观众的多条操作作为一个整体校验/导入，这是合理的原子边界。 |

## 4. 本轮代码修复

### 4.1 Prompt：分离 ref 与 seq

- `viewer_excerpts.jsonl` 的每一行在发送给 Provider 时增加 `ref`（由本地 viewer_id→ref 映射生成）；`seq` 仍是唯一证据编号。
- `memoryContract` 明确：
  - `ref` 与 `seq` 是不同命名空间；
  - ref 5 可以拥有 seq 3；
  - 只能使用同一 ref 的 `evidence_seqs`；
  - 每行同时带 `seq` 与 `ref`。
- 修复请求增加 `MEMORY EVIDENCE GUARD`，要求逐观众检查 ref→seq，不得借用其他观众 seq。
- 旧包 `instructions.md` 仍不使用；Resume 时同样使用新 Prompt。

### 4.2 观众级容错

- 旧行为：一个观众失败 → 整批拒绝。
- 新行为：
  1. 整批完整校验；
  2. 若失败，仍先做一次 whole-batch repair（原有上限）；
  3. 修复后仍有观众级错误时，按索引拆分：
     - 合法观众重新通过完整 `validateAnalysisImport(viewerIds=valid)`；
     - 非法观众不写入任何事实；
  4. 合法观众在同一事务中导入（`viewerIds` 作用域），非法观众状态标记 `failed`；
  5. 对非法观众再发 **一次有界 viewer-scoped repair**（只发送失败观众、其允许 evidence 和错误）；
  6. 修复成功则合并回整批并完整校验后导入；仍失败则合法观众保留、失败观众保持 `failed`；
  7. 后续批次继续调度（仅批次级校验错误不阻断；Provider/取消/数据库错误仍停止新调度）；
  8. Resume 只取 `pending`/`failed` 观众，构造该批次的子集 Prompt；已成功观众不再请求。
- 事务：合法观众的事实、证据、`ai_job_memory_viewers` 状态与失败观众 `failed` 状态在同一 SQLite 事务中提交；不会出现“事实已写但覆盖状态未写”。
- 恢复结果：同一批次会产生新的 `ai_results` 版本（v2），只含恢复观众；不重复已成功观众的事实。事实操作仍由 `applyMemoryOperations` 的 dedupe/版本机制保证幂等。

### 4.3 调度

- `runPool` 新增 `shouldStop(error)`：
  - `AI_IMPORT_INVALID` / `AUTO_SCHEMA_INVALID` / `AUTO_VIEWER_COVERAGE_INCOMPLETE`：不停止后续批次；
  - Provider 鉴权/超时/限流/网络、取消、数据库错误：仍停止新批次调度（在途继续）。
- concurrency=1 和 4 均验证：一个批次失败后，后续批次继续完成。
- 任务最终状态：有成功观众时为 `partial`，不是 `complete`；全部失败才是 `failed`。

### 4.4 统计

- `ai_job_memory_viewers.status` 新增 `failed`；`jobMemoryCoverage` 新增 `failed`，`covered` 排除 failed，`complete` 要求 pending/missing_update/failed 全为 0。
- 报告 `longTermProfiles.stats` 与 AI 中心 partial 文案显示 `failed`（校验失败等待恢复）与 `pending`。
- 旧任务失败批次 7 人仍是 `pending`（旧版没有观众级状态），新版 Resume 会处理这 7 人；**对旧任务不能只挑 1 人**，因为其余 6 人当时也没有保存。

## 5. 真实包验证

用生产包 `b05.zip`（只读复制）构造新 Prompt：

- ref 5（`1765635337`）evidence_seqs=`[3]`
- ref 3（`5240206`）evidence_seqs=`[5]`
- 新 excerpt 行：
  - `seq 3 ... viewer_id=1765635337 ... ref=5`
  - `seq 5 ... viewer_id=5240206 ... ref=3`
- 新契约包含 “ref and seq are different namespaces”。

这说明新 Prompt 不再要求模型靠数字猜测 ref↔seq；但模型仍可能出错，所以保留完整校验和观众级隔离。

## 6. 测试

（结果见 `docs/STATUS.md` §0.17 与最终报告；本轮新增 `ai-memory-reliability` 的 ref/seq 冲突、concurrency=1、viewer-scoped repair 等用例。）

### 6.1 真实任务副本回放（隔离数据库，Mock Provider）

把生产库与 `b05` 包**只读复制**到 `tests/.tmp`，用新代码和新 Provider 配置 resume 同一任务（不改生产库）：

1. **普通 Resume**（Mock 返回全部 no_new）：
   - 只请求 1 次（只发批次 5 的 7 名 pending 观众；批次 1–4 未重发）；
   - `complete`，47/47，40 semantic + 7 no_semantics，`ai_results=5`。
2. **复现真实 ref/seq 错误**（Mock 为 ref 5 故意引用 seq 5，即另一观众的消息；whole-batch repair 仍错误）：
   - 请求 3 次：initial + whole-batch repair + viewer-scoped repair；
   - viewer-scoped repair 成功；`complete`，47/47，41 semantic、6 no_semantics、0 failed；
   - `ai_results=5`；该观众新增恢复事实；
   - 未发生跨观众写入。
- 这是**真实任务数据 + 真实包 + 新生产代码 + Mock Provider**；不是真实 Provider 调用，也不是生产 Resume。
### 6.2 隔离 Windows EXE 回放（正式构建的测试副本）

- 正式 EXE 重建：buildId `9b8daa7b2d1d`、commit `2df6052`、SHA-256 `9b3eea3e…`、91.7 MB、169 assets、Manifest requireAdministrator。
- 非提升会话使用同一二进制的 asInvoker 测试副本 + `LIVE_MEMORY_SKIP_ADMIN_CHECK=1`，数据目录为生产库/包只读副本。
- 本地 Mock Provider 模拟真实 ref/seq 错误：初始与 whole-batch repair 都让 ref 5 引用 seq 5；viewer-scoped repair 返回该观众自己的 seq。
- EXE 内 `/api/ai/analyze/resume` 实测：
  - 3 次请求（7 refs → 7 refs → 1 ref）；
  - `complete`，coverage 47/47、41 semantic、6 no_semantics、0 failed；
  - `batchErrors=[]`；批次 1–4 未重发；
  - `/api/health`、`/api/bootstrap` 返回 buildId `9b8daa7b2d1d`。
- 这是**真实任务数据 + 真实包 + 正式 EXE 代码 + Mock Provider**；不是真实 Provider 调用，也不是生产 Resume。

## 7. 未做

- 未自动 Resume 生产任务；未修改生产数据库；未调用真实付费 API。
- 未保存失败模型原始回答；因此无法还原首次 schema 错误的具体字段值。
- 未做真实浏览器 UI 截图（本机沙箱仍阻止浏览器命名管道）。
- 未对真实生产任务执行观众级恢复（需要用户授权）。
