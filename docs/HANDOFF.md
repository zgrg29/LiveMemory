# 交接文档（HANDOFF）

本轮：2026-11-11 · P9 匿名免费 AI 自动分析 · v0.12.0（schema 12）

## 1. 本轮结果

| 目标 | 结论 |
| --- | --- |
| 先真实测试匿名接口 | **已完成**。OVHcloud AI Endpoints 的 `gpt-oss-20b` 匿名接口通过真实 LiveMemory 包校验；Murakumo / llmfaucet / LLM7 / Pollinations 均未通过，详见 `docs/ANONYMOUS_AI_RESEARCH.md`。 |
| 一键自动创建任务、分析、校验、导入 | **已完成**。`AutoAnalysisRunner` 使用现有 `createAnalysisJob` / `validateAnalysisImport` / `importAnalysisResult` / `buildAggregatePackage`。 |
| 多批次与第二阶段汇总 | **已完成**。自动批次更小（250 消息 / 25 观众 / 600 摘录），最多 12 批；每批导入后自动生成汇总包并导入 final。 |
| 观众长期记忆 | **已完成**。真实 3 观众包得到 3 条语义事实、正确证据；真实跨场次“学画画 → 改学吉他”测试中旧事实被 `superseded`，新事实新增。 |
| 失败降级 | **已完成**。按钮正下方固定红色文案；详情折叠显示稳定错误码/HTTP 状态；手动导出/导入完全保留；不弹 `alert()`。 |
| 首次使用隐私确认 | **已完成**。`localStorage` 记录一次同意；服务端要求 `consent:true`；文案明确第三方处理。 |
| 重复点击 / 页面切换 / 重启 | **已完成**。服务端按 session 去重；状态来自服务端；`runtime/ai-auto.json` 记录 jobId/阶段/错误，重启标记 `interrupted`，可恢复同一任务。 |
| 取消 | **已完成**。取消仅停止后续请求；已导入批次保留。 |
| 测试 | **全量 525 passed / 0 failed**（约 93 秒）；真实匿名 API 测试单独执行，不混入 mock。 |
| 真实浏览器 UI | **仍未完成**。本机策略阻止无头浏览器；只有静态 UI 测试 + HTTP 端到端测试。 |
| 打包 EXE | **已构建、未能运行**：`dist/LiveMemory.exe` 91.2 MB / 151 资源 / requireAdministrator / SHA-256 `342294c…`；本机直接运行被“需要提升”拒绝。 |

## 2. 真实接口结论

| 服务 | 匿名 | 实测 | 结论 |
| --- | --- | --- | --- |
| OVHcloud AI Endpoints `gpt-oss-20b` | ✅ 官方 2 req/min | 真实包通过；Runner `complete`、`semantic=3` | **唯一采用** |
| Murakumo | 文档允许 | `/ready` 503、`murakumo/free` 502、`mishima` 180s 后无容量 | 不集成 |
| llmfaucet | — | 域名 NXDOMAIN | 不集成 |
| LLM7.io | 未确认 | 无 Key 可 200，但官方要求 Token | 不集成 |
| Pollinations | 匿名层存在 | 基础 JSON 通过；真实包 HTTP 400 | 不集成 |

## 3. 后端变化

### 3.1 新模块

| 文件 | 职责 |
| --- | --- |
| `src/ai/auto/config.mjs` | 已验证 provider、模型、匿名限流、批次/上下文/输出预算、稳定错误码 |
| `src/ai/auto/client.mjs` | `fetch` + `AbortSignal`、滑动窗口限流、`Retry-After`、JSON 提取、错误分类 |
| `src/ai/auto/prompt.mjs` | 读取现有 ZIP 包、内联批次/汇总内容、精确观众 ID 与证据 seq、修复提示词、上下文预算 |
| `src/ai/auto/state.mjs` | `runtime/ai-auto.json`：jobId、阶段、批次、错误码；不含聊天/提示词 |
| `src/ai/auto/runner.mjs` | 创建/恢复任务、逐批调用、校验、导入、汇总、取消、重试、恢复、请求预算 |
| `src/ai/auto/errors.mjs` | `AutoAnalysisError` 与脱敏 detail |

### 3.2 修改

- `src/ai/export/job.mjs`：`createAnalysisJob()` 新增可选 `memoryViewersPerBatch` / `maxMemoryExcerptMessages`，默认值保持原行为；自动模式传入更小上限。批次计算、观众分配、证据映射均复用。
- `src/server/index.mjs`：运行时创建 `AutoAnalysisRunner`；`deps.auto`；`stopAdapters` 先 `auto.shutdown()`。
- `src/server/routes.mjs`：4 个 `/api/ai/auto/*` 路由；错误映射；`AUTO_TOO_MANY_BATCHES` 422。
- `package.json` / `src/shared/app-info.mjs`：0.12.0。
- 数据库 schema **不变（12）**；没有新表、没有迁移。

### 3.3 API

```text
GET  /api/ai/auto/services
GET  /api/ai/auto/status?sessionId=
POST /api/ai/auto/run      {sessionId, locale?, consent:true}
POST /api/ai/auto/cancel   {sessionId}
```

状态字段：`status`（idle/running/complete/failed/canceled/interrupted）、`stage`（preparing/connecting/analyzing/validating/importing/aggregating/complete）、`batchIndex`、`batchTotal`、`jobId`、`error{code,detail}`、`job{state,memoryCoverage,...}`、`services`。

### 3.4 关键安全/正确性规则

1. **同一个导入路径**：自动回答必须先 `validateAnalysisImport()` 通过，再由 `importAnalysisResult({source:'auto'})` 在单事务写入；不能直接写 `ai_*` 或事件表。
2. **不降低 Schema**：观众覆盖、稳定 ID、证据归属、时间窗口、重复导入保护全部沿用。
3. **不跳过观众**：自动批次仍由 `createAnalysisJob()` 分配全部可识别观众；超出 12 批时明确失败，不静默裁剪。
4. **不伪造证据**：提示词列出每位观众允许的 excerpt seq；验证器拒绝跨观众/不存在 seq。
5. **不把推断写成事实**：沿用 `stated/inferred/uncertain` 与证据规则。
6. **不覆盖手动结果**：自动任务只处理自己创建的任务；手动任务/结果不受影响。
7. **不无限重试**：每个 provider 一次网络重试、一次修复；单次运行有请求预算；429 等待上限 90 秒。
8. **不泄漏**：日志/状态文件只含 code、provider、HTTP 状态、批次/耗时；不含提示词、聊天、回答。
9. **不发送无关数据**：只发送当前分析包（聊天、观众上下文、已有记忆、Schema），不发送数据库文件、凭据、其他直播。

## 4. 前端变化

`src/web/js/pages/ai.js`：

- 「创建分析任务」卡内、手动控件上方新增 `autoPanel`：
  - 主按钮「自动 AI 分析」、免费匿名 chip、说明；
  - 按钮正下方的红色错误文案（三语精确文案）与折叠「查看详情」；
  - 取消按钮；
  - 真实阶段文案（准备/连接/第 X/Y 批/验证/更新记忆/汇总/完成/取消）。
- 首次点击使用自定义 modal 征求同意；`localStorage` key `livememory.aiAutoConsent.v1`。
- 轮询 `/api/ai/auto/status`（1.5s），页面切换/刷新后从服务端恢复；同一任务运行中禁用按钮。
- 完成时刷新任务/报告；失败时保留手动区域，不切换模式。
- 所有动态文本 `textContent`，无 `innerHTML`、无 `alert()`。
- `src/web/js/pages/ai-report.js`：来源显示 `sourceAuto`。
- 三语 `src/web/i18n/*.json`：新增 `ai.auto.*`、`ai.report.sourceAuto`、`errors.aiAuto*`；更新 `ai.pageSubtitle` 与 `ai.setup.note`，不再声称软件从不调用 AI API。
- `src/web/styles/pages.css`：`.auto-panel` / `.auto-actions` / `.auto-status` / `.auto-error` / `.auto-details` / `.auto-divider`，使用 tokens，≤700px 换行。

## 5. 测试 / 构建 / 验证

- 全量：`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"` → **525 passed / 0 failed**，约 93 秒。
- 新增：
  - `tests/unit/auto-client.test.mjs`：JSON 提取、限流、匿名请求、429/5xx/timeout/非 JSON。
  - `tests/unit/auto-prompt.test.mjs`：观众 ID/证据 seq、汇总契约、上下文预算、修复提示。
  - `tests/integration/auto-analysis.test.mjs`：成功、多批、备用、全失败、修复、错误证据、部分成功后恢复、重复点击、取消/恢复、重启、汇总失败、旧记忆不被覆盖、重复导入幂等。
  - `tests/integration/auto-api.test.mjs`：HTTP 同意、202、409、状态、422 规模限制、取消、手动路径仍可用。
  - `tests/unit/ai-ui.test.mjs`：按钮/状态/错误文案/三语键/无 alert/无 innerHTML。
- 真实匿名 API 探针（非自动化）：`tests/.tmp/auto-real.mjs`、`auto-memory-real.mjs`、`prompt-probe.mjs`、`pollinations-probe.mjs`。结果写入 `docs/ANONYMOUS_AI_RESEARCH.md`。
- 构建：`node scripts/build-windows.mjs` 成功（v0.12.0，91.2 MB、151 资源、requireAdministrator、SHA-256 `342294c…`）；**未能运行验收**，直接执行被 Windows 以“请求的操作需要提升”拒绝。
- 真实浏览器：**未运行**（本机策略）。

## 6. 未验证 / 边界

- 真实 EXE 出站请求、代理/防火墙/UAC 下的行为；
- 真实浏览器渲染、暗色、390px、按钮位置截图；
- 数千观众/数万消息大场的自动批次与耗时；
- OVH 2 req/min 在长任务中的实际总耗时；
- 模型在多语言、反讽、低活跃观众上的长期稳定性；
- Murakumo 恢复后的可用性；
- Pollinations 真实包 HTTP 400 的具体原因；
- 自动分析期间删除场次/清空数据的交互（服务端会失败并显示红色提示，未做额外 UI 守卫）。

## 7. 常用命令

```bat
:: 全量测试
node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"

:: 只测自动分析
node --test --test-isolation=none "tests/unit/auto-*.test.mjs" "tests/integration/auto-*.test.mjs"

:: 启动
node src/launcher/launcher.mjs --no-open

:: 真实匿名接口探针（会发外部请求，勿频繁运行）
node tests/.tmp/auto-real.mjs
```

## 8. 本轮 Commit

- 待提交：`feat: add automatic anonymous AI analysis`（本地 commit，未 Push；hash 见提交输出）。

## 9. 上一轮（v0.11.1）摘要

P8 统一分析与长期记忆：一次分析结果同时承担本场报告与全部可识别观众的长期记忆；删除独立记忆页；修复观众档案主播范围。详见 `log/2026-11-10-unified-analysis-memory.md` 与 `log/2026-11-10-viewer-scope-fix.md`。
