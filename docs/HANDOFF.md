# 交接文档（HANDOFF）

本轮：2026-11-11 · v0.13.0 AI 架构重构（单场/画像解耦、多 Provider、付费画像） · schema 13 · 结果 Schema 1.3.0

## 1. 本轮结果

| 目标 | 结论 |
| --- | --- |
| 手动 AI 只做单场 | **已实现**。`analysisMode=session` 生成单包；无 memory 文件；导入拒绝非空 `viewer_memory_updates`。 |
| 匿名免费只做单场 | **已实现**。新统一 runner 的匿名路径强制 `mode=session`；旧自动 API 保留兼容。 |
| API Key 免费模型只做单场 | **已实现**。`api_free` 配置无法通过 `memoryPermission()`。 |
| 付费模型完整画像 | **已实现（Mock 验证）**。独立 memory job，付费+价格+能力 `memory=true`+opt-in 才能运行；分批、暂停/恢复/取消、预算与 usage。 |
| 单场与画像独立保存 | **已实现**。单场先导入；画像失败只标记 partial；已导入画像批次保留；报告读取排除 memory-only 结果。 |
| 多 Provider | **已实现适配层**；OpenRouter 模型列表已真实请求。OpenAI/Anthropic/DeepSeek/MiniMax/DashScope 真实生成未验证（无 Key）。 |
| 密钥安全 | **已实现**。AES-256-GCM 本地存储；普通配置只保存 credentialReference；切换 region 轮换引用。测试断言配置文件不含 Key。 |
| 三语 UI | **已实现静态键与页面**；无真实浏览器验收。 |
| 真实 API | **部分**：OpenRouter 模型列表真实；生成请求全部阻塞（无 Key）。不得声称 Provider 已通过真实生成测试。 |
| 全量测试 | **561 passed / 0 failed**（2026-11-11，约 73 秒）。 |
| EXE | **已构建 v0.13.0（包含入口、状态与模型预设修复）**（91.5 MB / 166 assets / SHA-256 `19eac42ad747393fa0974420533456c3eb833d26a9b8ff814839e88a4d64aae8` / requireAdministrator），**未能运行**（UAC 拒绝）。 |

## 2. 关键文件

### 新增

| 文件 | 职责 |
| --- | --- |
| `src/ai/providers/catalog.mjs` | Provider/区域/协议/官方 Base URL |
| `src/ai/providers/pricing.mjs` | 费用状态、价格换算、估算、付费画像权限 |
| `src/ai/providers/url-safety.mjs` | 自定义 Base URL/私网/元数据/DNS 检查 |
| `src/ai/providers/adapters.mjs` | OpenAI-compatible + Anthropic 适配器、模型列表 |
| `src/ai/providers/store.mjs` | 多配置 JSON + 加密凭据 + 区域轮换 |
| `src/ai/providers/verify.mjs` | 六层能力检测 |
| `src/ai/export/split-jobs.mjs` | session-only 单包任务 + memory-only 分批任务 |
| `src/ai/prompts/split.mjs` | 单场/画像两类三语提示词 |
| `src/ai/api/compact.mjs` | 画像 ref 紧凑输出组装 |
| `src/ai/api/prompts.mjs` | 从真实 ZIP 构建 Provider 提示词 |
| `src/ai/api/runner.mjs` | 多 Provider 运行器（session/memory/both、暂停/恢复/预算） |
| `src/web/js/pages/ai-settings.js` | 设置页 Provider 配置卡 |
| `tests/unit/v13-providers.test.mjs` | Provider/价格/URL/密钥/适配器/能力测试 |
| `tests/integration/v13-*.test.mjs` | 单场、画像、52 观众批次、权限、预算、runner、能力检测路由测试 |

### 修改

- `src/ai/constants.mjs`：`RESULT_SCHEMA_VERSION=1.3.0`、`ANALYSIS_MODE`、prompt version 分支。
- `src/ai/import/validate.mjs`：1.3 Schema 选择、scope 检查、session 禁止 memory、memory job taskKind。
- `src/ai/import/importer.mjs`：session 任务不执行 `applyMemorySideEffects`；结果记录 analysisMode。
- `src/ai/export/job.mjs`：旧 combined 路径固定 Schema 1.2.0（兼容历史）。
- `src/ai/tasks/status.mjs`：session/memory 任务不要求 aggregate；独立完成条件。
- `src/analytics/ai/report.mjs`：排除 memory-only 结果，避免覆盖/伪装单场报告。
- `src/storage/database/migrations/index.mjs`：schema 13。
- `src/server/index.mjs`：ProviderConfigStore + AnalysisRunner 生命周期、退出中止。
- `src/server/routes.mjs`：Provider 配置/模型/能力检测/analyze 路由；session 任务创建；1.3 instructions。
- `src/server/serializers.mjs`：analysisMode/provider/usage 字段。
- `src/web/js/pages/ai.js`：分析方式/内容/配置/价格/预算/opt-in/暂停恢复/新状态。
- `src/web/js/pages/settings.js`：Provider 配置卡。
- 三语 i18n、README、STATUS、HANDOFF、ROADMAP、AI_CONTRACT、ARCHITECTURE、PRIVACY_SECURITY、TEST_PLAN、CHANGELOG、日志。

## 3. API 变化（v0.13）

```text
GET  /api/ai/providers
GET  /api/ai/providers/models?configId=|providerId=&regionId=
POST /api/ai/providers/configs
PATCH/DELETE /api/ai/providers/configs/:id
POST /api/ai/providers/configs/:id/default
POST /api/ai/providers/configs/:id/test   {confirmBilling}
POST /api/ai/analyze/run                  {sessionId, mode, configId?, consent, confirmBilling?, optInMemory?, budget?}
GET  /api/ai/analyze/status?sessionId=
POST /api/ai/analyze/pause|cancel|resume
POST /api/ai/jobs                          {analysisMode:'session'} → 单场单包
```

## 4. 关键规则（下一轮不要破坏）

1. session 任务永远不能写长期记忆；memory 任务永远不能替换单场报告。
2. 免费模型/匿名 Provider 永远不能执行 memory 任务。
3. 长期画像必须同时满足：付费状态、已知价格、`capabilities.memory=true`、`optInMemory=true`。
4. 任何付费/未知价格请求前必须 `confirmBilling=true`；未知价格不自动当免费。
5. Provider 配置只保存 credentialReference；密钥不得进入 JSON/日志/ZIP/DB 导出/HTML。
6. 区域/Base URL 变化必须轮换 credential reference，不得复用旧 Key。
7. 自定义 URL 必须经过私网/元数据/DNS 检查；localhost 只在显式 `allowLocalNetwork` 时允许。
8. 能力检测不能仅凭 HTTP 200；memory 必须用多观众/证据/零发言探针。
9. 单场先保存；画像失败只标记 partial，已导入批次保留。
10. 旧 combined/1.2.0 结果仍可读；不要删除历史画像或伪造报告。

## 5. 未验证 / 边界

- OpenAI、Anthropic、DeepSeek、MiniMax、阿里云百炼真实生成未验证（无 API Key）；只完成了适配器/协议 Mock 测试。
- 真实浏览器 UI、暗色、390px、Windows EXE 运行未验收。
- 匿名 OVHcloud 当前可用性未在本轮重新探测；免费通道可能限流/失效。
- 手动单场当前是**一个单包**（符合“优先单个最终文件”），未实现“多批打包后本地合并成一个最终 JSON”；超大场次可能超过所选模型的上下文窗口。
- 付费长期画像的真实 52 观众 Provider 运行未执行；仅 Mock runner + 真实包结构/批次测试。
- 预算只对已知价格/币种生效；实际账单可能高于估算。

## 6. 常用命令

```bat
node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"
node src/launcher/launcher.mjs --no-open
node scripts/build-windows.mjs
```

## 7. 本轮 Commit

- 功能/测试/文档提交：见最终答复的本地 commit hash（未 Push）。
