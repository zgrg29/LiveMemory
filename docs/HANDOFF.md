# 交接文档（HANDOFF）

本轮：2026-11-11 · v0.13.1 移除匿名免费 / 手动 AI，重写付费请求调度 + 七项实际使用修复 · schema 13 · 结果 Schema 1.3.0

## 0. 本轮追加：七项实际使用修复

| # | 问题 | 结论/修复 | 验证 |
| --- | --- | --- | --- |
| 1 | 历史跳转未选中场次 | `query.session` 按稳定 id 选中；不在前 100 行时按 id 加载；手动选择更新 URL | `ai-selection` + 静态 UI |
| 2 | 已配置 Key 仍显示未配置 | `providerConfigState()` 区分无配置/缺 Key/测试失败/未检测/缺价格；删除历史文案 | `ai-config-state` + Provider 列表 |
| 3 | 无实时进度 | 批次/观众计数进度条 + 不确定动画 + 1.5s 轮询 + statusEpoch | `ai-progress`、`v13-progress`；真实浏览器未验收 |
| 4 | `Memory No viewers` | combined 无观众保留单场报告并显式跳过；memory-only 明确错误；状态含 `memorySkipped` | `v13-api-runner` |
| 5 | 报告重复 | `reportEpoch` 单飞，只有一个挂载点 | 静态 + 报告并发守卫 |
| 6 | Bilibili 未开播无主播名 | `Master/info` 公共回退；target 持久化并低频重试 | 真实房间 3 未开播 → `3号直播间` |
| 7 | 手动停止后自动恢复 | `live_stopped` + `meta.manualStop` 持久抑制；确认离线/新 live cycle 才解除；重启保持 | 场景 A–G 测试 |

新增文件：`src/web/js/pages/ai-progress.js`、`ai-config-state.js`、`ai-selection.js`；`tests/unit/ai-progress.test.mjs`、`ai-config-state.test.mjs`、`ai-selection.test.mjs`、`bilibili-master-info.test.mjs`；`tests/integration/v13-progress.test.mjs`、`manual-stop-monitor.test.mjs`。

修改重点：`src/web/js/pages/ai.js`、`src/ai/api/runner.mjs`、`src/monitoring/manager.mjs`、`model.mjs`、`detectors/bilibili.mjs`、`src/platforms/bilibili/api.mjs`、`service.mjs`、`src/server/session-admin.mjs`、`src/web/js/pages/live.js`、三语 i18n。

真实 Bilibili 只读验证：房间 `3` → `23058`，未开播，`displayName=3号直播间`、`platformUid=11153765`。真实浏览器/EXE 仍受阻；未伪造。

## 1. 上一轮结果（v0.13.1 入口与调度）

| 目标 | 结论 |
| --- | --- |
| 付费 API 是否被免费限速影响 | **没有。** 2 RPM 只存在于旧匿名路径 `src/ai/auto/`；付费 `src/ai/api/runner.mjs` 未使用该 limiter。完整证据见 `docs/AI_SCHEDULER_AUDIT.md`。 |
| 删除匿名免费 AI | **已实现。** 删除 `src/ai/auto/`、`/api/ai/auto/*`、UI 入口、免费价格状态、匿名 Provider 配置与自动切换。 |
| 删除手动 AI | **已实现。** UI 不再有创建包/复制提示词/下载 ZIP/粘贴 JSON/上传 JSON/手动导入/修复指令；对应 HTTP 写路由删除。 |
| 单一 AI 分析入口 | **已实现。** 五步：选择直播 → 选择 API 配置 → 选择内容 → 费用/预算确认 → 开始 AI 分析。 |
| 保留多 Provider | **保留。** OpenAI、Anthropic、DeepSeek、MiniMax（cn/intl）、阿里云百炼（4 区域）、OpenRouter、自定义 OpenAI-compatible。 |
| 安全并发 | **已实现。** 每个 config 独立调度器；初始并发可配置 1–8，默认 3；画像批次有界并发。 |
| 429 / Retry-After | **已实现。** 429 减半并发并按 `Retry-After` 暂停该 config；5xx/408/425 短暂暂停；指数退避 + 抖动。 |
| 删除固定 30 批上限 | **已实现。** 改为 `ceil(MAX_ANALYSIS_VIEWERS / 10) + 1`（2,001）。 |
| 跨场次记忆顺序 | **已实现。** 同一主播记忆 gate；较新场次已导入后拒绝较旧场次（`ANALYSIS_MEMORY_OUT_OF_ORDER`）。 |
| 性能统计 | **已实现。** 请求/完成/失败/并发/排队/模型耗时/排队等待/限流等待/429/p50/p95/token/费用/ETA。 |
| 本地性能修复 | **已实现。** 每批只更新本批观众；DNS 安全检查缓存 5 分钟；精确 `getJobPackage()` 查询。 |
| 全量测试 | **539 passed / 0 failed**（约 73 秒）。 |
| Mock 规模测试 | **1,000 观众 / 10,000 消息：100 批、6.5 秒、峰值并发 6、覆盖 1,000/1,000。** |
| 真实付费 API | **阻塞**：本机没有 Provider 配置/密钥/环境变量。未伪造成功。 |
| EXE | **已重新构建 v0.13.1**（91.5 MB / 164 assets / SHA-256 `e3c637c8…` / requireAdministrator），包含本轮七项修复；**未能运行**（UAC 拒绝）。 |

## 2. 关键文件

### 新增

| 文件 | 职责 |
| --- | --- |
| `src/ai/runtime/json.mjs` | Provider 无关的 JSON 提取、取消 sleep、Retry-After 解析、退化检测 |
| `src/ai/runtime/state.mjs` | 本地任务状态恢复（不含提示词/聊天正文） |
| `src/ai/runtime/scheduler.mjs` | 按 config 隔离的请求调度器、动态并发、429 冷却、指数退避 |
| `docs/AI_SCHEDULER_AUDIT.md` | 免费限速调查结论、代码位置、新调度、Mock 时间线 |
| `scripts/benchmark-mock-scale.mjs` | 大规模 Mock 性能基准 |
| `tests/unit/ai-scheduler.test.mjs` | 并发上限、429 隔离、取消、退避 |
| `tests/integration/v13-scheduler.test.mjs` | 429 Retry-After、画像并发、失败恢复、跨场次顺序 |

### 修改

- `src/ai/api/runner.mjs`：删除匿名 Provider；必须 `configId`；调度器；有界并发；`Retry-After`；请求统计；记忆顺序 gate；精确包查询；1,000 观众批次上限。
- `src/ai/providers/adapters.mjs`：`ProviderHttpError` 携带 `retryAfterMs`；5xx/408/425 可重试。
- `src/ai/providers/catalog.mjs`：删除 `ANONYMOUS_FREE`。
- `src/ai/providers/store.mjs`：新增 `concurrency`（1–8）与 `timeoutMs`（10–600 秒）。
- `src/ai/providers/pricing.mjs`：文档删除匿名状态。
- `src/storage/repositories/ai-packages.mjs`：新增 `getJobPackage()`。
- `src/ai/import/importer.mjs`：memory 批次只更新本批观众，避免 O(批次×观众)。
- `src/server/index.mjs`：删除 `AutoAnalysisRunner` 生命周期。
- `src/server/routes.mjs`：删除匿名/手动写路由；保留只读任务/报告/结果。
- `src/web/js/pages/ai.js`：五步单入口；请求统计；暂停/取消；错误原因。
- `src/web/js/pages/ai-settings.js`：删除匿名价格；新增并发数。
- 三语 i18n：新增 `ai.center.*`、并发文案、`errors.aiProviderConfigRequired`；删除 `ai.auto`、手动/匿名方法。
- README、STATUS、HANDOFF、ROADMAP、ARCHITECTURE、AI_CONTRACT、TEST_PLAN、PRIVACY_SECURITY、CHANGELOG、日志。

### 删除

- `src/ai/auto/` 整个目录（匿名 provider、2 RPM limiter、runner、prompt、assemble、errors、client、state）。
- `src/web/js/pages/ai-import-repair.js`。
- 旧匿名/手动测试：`auto-analysis`、`auto-api`、`auto-compact`、`auto-client`、`auto-prompt`、`auto-assemble`、`manual-52-viewers`、`ai-import-repair`。

## 3. API 变化（v0.13.1）

保留：

```text
GET  /api/ai/providers
GET  /api/ai/providers/models
POST /api/ai/providers/configs
PATCH/DELETE /api/ai/providers/configs/:id
POST /api/ai/providers/configs/:id/default
POST /api/ai/providers/configs/:id/test
POST /api/ai/analyze/run
GET  /api/ai/analyze/status
POST /api/ai/analyze/pause|cancel|resume
GET  /api/ai/jobs                 (只读)
GET  /api/ai/jobs/:id             (只读)
GET  /api/ai/packages             (只读)
GET  /api/ai/sessions/:id/report
GET  /api/ai/results/:id
GET  /api/ai/results/:id/download
```

删除：

```text
POST /api/ai/jobs
POST /api/ai/jobs/:id/aggregate
POST /api/ai/packages
GET  /api/ai/packages/:id/download
GET  /api/ai/instructions
POST /api/ai/import/preview
POST /api/ai/import
GET/POST /api/ai/auto/services|status|run|cancel
```

## 4. 关键规则（下一轮不要破坏）

1. 匿名免费 AI 与手动 JSON 入口已删除；不要重新加回。
2. `session` 与 `memory` 独立保存；画像失败不覆盖单场报告。
3. `api_free` 永远不能执行 memory；付费必须价格已知 + `capabilities.memory` + opt-in。
4. 付费/未知价格必须 `confirmBilling`；未知价格不当免费。
5. 所有模型输出必须走 `validateAnalysisImport()` + `importAnalysisResult()`。
6. 每位可识别观众恰好一条 `viewer_memory_updates`；批次不拆散观众。
7. 客观历史只由真实记录更新；memory 批次只更新本批观众。
8. 同一主播跨场次按时间顺序；较旧场次不得覆盖较新记忆。
9. 调度按 `configId` 隔离；不虚构统一 RPM/TPM；429 按 `Retry-After`。
10. 初始并发可配置 1–8，默认 3；不得无上限并发。
11. Key 只存加密凭据库；不进入 JSON/日志/ZIP/DB/HTML。
12. 自定义 URL 私网/元数据/DNS 检查保留；DNS 安全缓存最长 5 分钟。
13. 历史报告与长期画像仍可只读；旧 1.0–1.2.0 结果仍可读。
14. 三语键一致；前端禁止 `innerHTML`、`alert()`、硬编码可见文案。

## 5. 未验证 / 边界

- **真实付费 API 阻塞**：本机没有 `config/ai-providers.json`、`secrets/ai-keys.json` 或环境变量 Key。
- 真实浏览器 UI、暗色、390px、请求统计、暂停/取消未截图验收。
- EXE 已重新构建但 UAC 拒绝运行；未验证打包后的出站请求。
- 真实 Provider 的 429/Retry-After、1,000 观众、费用与延迟未测试。
- 调度器默认 3 并发是安全起点，不是官方额度；过高可能触发 429。
- 429 冷却上限 300 秒；更长要求会失败而不是无限等待。
- 预算在请求后累计；并发请求可能同时越过上限。
- 5 分钟 DNS 缓存窗口内 DNS 变化不会被立即发现。
- `src/ai/export/job.mjs`、`package.mjs`、`prompts/instructions.mjs` 仅作为历史兼容/测试的内部构建器保留，无 UI/HTTP 入口；如后续确认无历史需求可再删除。

## 6. 常用命令

```bat
node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"
node scripts/benchmark-mock-scale.mjs 1000 10000 6
node src/launcher/launcher.mjs --no-open
node scripts/build-windows.mjs
```

## 7. 本轮 Commit

- 功能/测试/文档提交：见最终答复的本地 commit hash（未 Push）。
