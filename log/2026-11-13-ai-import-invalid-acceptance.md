# 2026-11-13 · AI_IMPORT_INVALID 专项端到端验收

目标：只回答原来的 `AI_IMPORT_INVALID` 是否真正修好，不增加功能。

## 1. 复现结构

- 旧代码：`3fccba1`（修复前）。
- 新代码：`e67677a`。
- 数据：**392 条合成聊天 / 37 名可识别观众**，`contextLength=32000`，画像批次上限 10 人/批 → **4 批 10/10/10/7**。
- 模式：`memory`（长期画像单独任务），locale `ja`，Mock Provider，隔离数据目录。
- 原始 392 条聊天正文与观众昵称**没有**使用；数量、观众数、批次数与原始案例一致，内容为合成。原始批次分配若因模型上下文不同而不同，无法从生产库确认。
- 原始失败的具体非法字段未保留（旧代码丢弃了 `details.errors`，且未读生产库）。验收使用 3 个真实可能触发 `AI_IMPORT_INVALID` 的模型输出：
  1. `forged-viewer-id`：模型在 `memory` 中返回伪造 `viewer_id`（旧提示词示例正是这样教的）；
  2. `missing-evidence`：`stated` 事实的 `evidence: []`；
  3. `cross-viewer-evidence`：ref 1 引用 ref 2 的 evidence seq。
- 每个变体第一轮都“ref 覆盖完整”，因此旧代码会走快速返回路径；这正对应审计中的结构性根因。

## 2. 旧代码对照结果（3 个变体）

命令（在 `3fccba1` 隔离树中）：

```bat
node acceptance-memory-replay.mjs --variant <variant> --scenario repair
```

| 变体 | 旧代码状态 | 错误详情 | 覆盖率 | b02 请求 | 修复请求 | 事实/结果 |
| --- | --- | --- | --- | --- | --- | --- |
| forged-viewer-id | `failed` | `AI_IMPORT_INVALID`，无 stage/字段错误 | 27/37，pending 10 | 1 | 0 | 3 / 3 |
| missing-evidence | `failed` | `AI_IMPORT_INVALID`，无 stage/字段错误 | 27/37，pending 10 | 1 | 0 | 3 / 3 |
| cross-viewer-evidence | `failed` | `AI_IMPORT_INVALID`，无 stage/字段错误 | 27/37，pending 10 | 1 | 0 | 3 / 3 |

旧代码的可观察症状与用户报告一致：

- 只显示 `AI_IMPORT_INVALID`，`error.detail` 也是 `AI_IMPORT_INVALID`；
- 无 `stage`、无 `batchIndex`、无 `errors[]`；
- 第 1/3/4 批成功，第 2 批失败，覆盖 27/37；
- 后续成功批次把 Job 的 `last_error_*` 清空（`lastErrorCode=null`），真实原因完全丢失；
- 没有发出任何 repair 请求（b02 仅 1 次调用）。

## 3. 新代码对照结果（同数据、同变体）

| 变体 | 新代码状态 | 覆盖率 | b02 请求 | 修复请求 | 事实/结果 |
| --- | --- | --- | --- | --- | --- |
| forged-viewer-id | `complete` | 37/37 | 1 | 0 | 4 / 4 |
| missing-evidence | `complete` | 37/37 | 2 | 1 | 4 / 4 |
| cross-viewer-evidence | `complete` | 37/37 | 2 | 1 | 4 / 4 |

- `forged-viewer-id`：新代码直接丢弃模型 `viewer_id`，用本地 ref 映射；无需 repair 即合法导入。这证明稳定身份不再被覆盖。
- `missing-evidence` / `cross-viewer-evidence`：第一轮完整校验失败 → 自动 repair（b02 2 次请求）→ 重新校验通过 → 导入。
- `missing-evidence` 单次 repair 的精确错误为 `MEMORY_EVIDENCE_REQUIRED`，不是笼统错误。

## 4. 修复仍失败 + 重启 Resume（新代码源码）

`--variant missing-evidence --scenario always-invalid-resume`：

第一次：

- `status=failed`，`canResume=true`；
- `error.code=AI_IMPORT_INVALID`；
- `error.detail=viewer_memory_updates[0].operations[0].evidence:MEMORY_EVIDENCE_REQUIRED`；
- `error.stage=validation`，`error.batchIndex=2`；
- `batchErrors=[{batchIndex:2, code:AI_IMPORT_INVALID, errors:[MEMORY_EVIDENCE_REQUIRED]}]`；
- `lastErrorBatches=[2]`；
- 覆盖率 27/37，pending 10，facts 3，results 3；
- b02 2 次请求（初始 + 修复）。

关闭服务、同一隔离数据目录重启并 `resume`：

- `status=complete`，37/37；
- **只发出 1 次 b02 请求**，b01/b03/b04 未重发；
- facts 4，results 4；
- `batchErrors=[]`，`lastErrorCode=null`。

## 5. 隔离 Windows EXE 验收

构建（独立目录 `tests/.tmp/exe-build`，未覆盖正式 `dist`/运行中 EXE）：

- 大小 91.6 MB；SHA-256 `9b8832d45b824567f37dde8a93b6ccd19680979be7545a932d9398a4ae61e487`
- commit `e67677a68d81560cb10821cb99316c7127dea1c5`
- buildId `c51819b2f3f3`，169 assets，7 个必需模块，embedded build marker 已校验
- 正式构建 manifest：**requireAdministrator**
- 为当前非提升会话复制一份测试副本，manifest 改为 asInvoker，并设置 `LIVE_MEMORY_SKIP_ADMIN_CHECK=1` 后运行；正式构建未被修改/替换。

EXE + 本地 Mock OpenAI-compatible HTTP Provider（127.0.0.1:48303）：

1. **修复场景**（b02 第一轮非法、repair 合法）：
   - `/api/ai/analyze/run` → `complete`
   - 4 批，覆盖 37/37，semantic 4
   - b02 调用 2 次（初始 + repair）
   - 报告 `longTermProfiles.stats`: total 37 / processed 37 / semantic 4 / objectiveOnly 33 / pending 0 / failed 0
2. **修复仍失败场景**（mock 始终返回缺证据）：
   - `status=failed`，`canResume=true`
   - `error.code=AI_IMPORT_INVALID`
   - `error.detail=viewer_memory_updates[0].operations[0].evidence:MEMORY_EVIDENCE_REQUIRED`
   - `error.stage=validation`，`error.batchIndex=2`
   - `batchErrors=[{batchIndex:2, code:AI_IMPORT_INVALID, errors:[MEMORY_EVIDENCE_REQUIRED]}]`
   - 覆盖率 27/37，pending 10，b02 初始 + repair 共 2 次
3. **EXE 内 Resume**：
   - 切换 mock 为合法
   - `POST /api/ai/analyze/resume` → `complete`
   - **只有 b02 一次请求**
   - 37/37，semantic 4，`batchErrors=[]`
   - 报告 stats: total 37 / processed 37 / semantic 4 / pending 0 / failed 0

## 6. 结论

- 旧代码用同一 392/37/4 结构和三个真实可能的非法输出，稳定复现了 `AI_IMPORT_INVALID`、27/37 覆盖、无细节、无 repair、成功批次清除失败记录。
- 新代码在同样条件下：
  - 伪造身份不再覆盖稳定 ID；
  - 缺证据/跨观众证据触发一次 repair 并成功；
  - repair 仍失败时显示精确字段、阶段、批次、可恢复性；
  - 重启后 Resume 只重试失败批次；
  - 以上均在隔离 EXE 中通过本地 Mock Provider 实测。
- 原始失败的具体非法字段无法从生产库确认；但导致 `AI_IMPORT_INVALID` 的代码路径（Compact 成功后跳过完整校验、`viewer_id` 可被覆盖、错误详情被丢弃、成功批次清除失败）已被三条独立证据覆盖并修复。
- 未验证：真实付费 API、真实生产任务 Resume、真实 UAC 双击、真实 392 条原始聊天内容。

## 7. 正式 EXE 覆盖（用户授权，2026-11-13）

用户确认 LiveMemory 已不再运行并明确授权覆盖 `dist/LiveMemory.exe`。执行：

```bat
node scripts/build-windows.mjs
```

| 项目 | 值 |
| --- | --- |
| 文件 | `dist/LiveMemory.exe` |
| 大小 | 91.7 MB |
| SHA-256 | `c827a609d56a0db7ed32d41871757cad7fc6a798c89588af8a24701df84c090a` |
| commit | `2b0ade6678b2f4e6a60a3fa6162426ec2de737c9` |
| buildId | `caece0818f11` |
| builtAt | 2026-11-13T00:33:30.336Z（08:33 +08） |
| assets | 169 files，7 个必需模块，embedded build marker 已校验 |
| Manifest | requireAdministrator（`readManifest` 复核） |

- 覆盖前旧 EXE 备份：`tests/.tmp/LiveMemory-pre-r5-backup.exe`，SHA-256 `aa3d4110…`（buildId `89bf47ac620e`）。
- 非提升会话无法直接启动 requireAdministrator EXE，因此复制同一二进制到 `tests/.tmp/LiveMemory-formal-asinvoker.exe`、临时改 manifest 为 asInvoker，并设置 `LIVE_MEMORY_SKIP_ADMIN_CHECK=1`，使用隔离数据目录 `tests/.tmp/formal-exe-smoke` 启动。
- 实际结果：
  - `/api/health` → `buildId=caece0818f11`、`commit=2b0ade6`；
  - `/api/bootstrap` → `mode=packaged`、`verified=true`、schema 13、数据目录为隔离临时目录；
  - 启动后正常监听 48304，关闭后删除测试副本与临时数据目录。
- 正式 EXE 的 AI 行为与之前完整验收的源码/隔离 EXE 相同（同一 `src`；正式 build 仅 commit 记录不同）。未对正式 EXE 重新跑完整 392/37 画像回放，避免重复消耗；完整回放证据见 §2–§5。
- 未做：真实 UAC 双击、提升后的出站请求、真实付费 API、生产任务 Resume。
