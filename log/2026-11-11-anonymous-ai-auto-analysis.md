# 2026-11-11 匿名免费 AI 自动分析（v0.12.0）

## 目标

在现有 AI 分析中心增加「自动 AI 分析」：用户点击一次，自动创建/恢复任务、分析、校验、
导入本场报告与全部可识别观众的长期记忆；不需要下载/上传 ZIP 或 JSON，不需要 API Key、
注册或开发者服务器；失败时显示简单红色提示并保留手动流程。

## 先调查，再集成

按任务要求先实测四个候选，再决定是否集成。完整报告：`docs/ANONYMOUS_AI_RESEARCH.md`。

### 实际结果

| 服务 | 结论 |
| --- | --- |
| OVHcloud AI Endpoints `gpt-oss-20b` | 官方匿名 2 req/min；真实 LiveMemory 包通过；采用 |
| Murakumo | 文档允许匿名，但 `/ready` 503、`murakumo/free` 502、`mishima` 180s 后无容量；不集成 |
| llmfaucet | 域名 NXDOMAIN（本地/Google/Cloudflare DNS）；不集成 |
| LLM7.io | 无 Key 可 200，但官方 README 要求 Token；授权不明确；不集成 |
| Pollinations（额外） | 基础 JSON 通过；真实 LiveMemory 包 HTTP 400；不集成 |

关键实测：

- OVH `gpt-oss-20b` 基础请求 200（2.5 秒）；JSON + 中/日/英 200（4.3 秒）。
- 真实 Runner（3 观众、9 消息、统一包）在 2026-11-10T16:41:35Z–16:41:49Z：
  `status=complete`、`memoryCoverage.semantic=3`、`source=auto`；
  事实：水彩（evidence 4）、爵士乐（evidence 5）、旅行（evidence 3）。
- 真实跨场次记忆：第一场“我最近在学画画” → 事实 `画画` active；
  第二场“最近不怎么画画了，开始学吉他” → 旧事实 `superseded`，新增“吉他”与“最近不怎么画画了”。
- 第一次 E2E 使用 `max_tokens≈3040` 失败（JSON 截断）；改为最低 8000 后成功。
- 匿名限流响应头 `x-ratelimit-limit-minute: 2`；客户端串行 + 2/60s 滑动窗口。

## 实现

### 后端

新增 `src/ai/auto/`：

- `config.mjs`：唯一已验证 provider、限流、批次/上下文/输出上限、稳定错误码。
- `client.mjs`：`fetch` + `AbortSignal`、匿名请求、JSON 提取、429/5xx/timeout 分类。
- `prompt.mjs`：读取现有 ZIP、内联包内容、精确 viewer ID + 允许证据 seq、批次/汇总/修复提示。
- `state.mjs`：`runtime/ai-auto.json`，只存 jobId/阶段/批次/错误码。
- `runner.mjs`：自动任务编排；复用 `createAnalysisJob` / `validateAnalysisImport` /
  `importAnalysisResult` / `buildAggregatePackage`。
- `errors.mjs`：`AutoAnalysisError` 与脱敏 detail。

修改：

- `createAnalysisJob()` 新增可选自动批次上限（默认原行为不变）。
- `src/server/index.mjs`：创建/关闭 `AutoAnalysisRunner`。
- `src/server/routes.mjs`：4 个 `/api/ai/auto/*` 路由。
- 版本 0.12.0；schema 保持 12，无迁移。

### 前端

- `src/web/js/pages/ai.js`：自动面板、按钮、首次同意 modal、轮询状态、取消、红色错误文案、
  折叠详情；保留全部手动控件。
- `src/web/styles/pages.css`：auto panel/status/error/details/divider；只使用 tokens。
- 三语词典新增 `ai.auto.*` 等；`ai.report.sourceAuto`。
- 无 `innerHTML`、无 `alert()`。

## 测试

- 新增：
  - `tests/unit/auto-client.test.mjs`
  - `tests/unit/auto-prompt.test.mjs`
  - `tests/integration/auto-analysis.test.mjs`
  - `tests/integration/auto-api.test.mjs`
  - `tests/unit/ai-ui.test.mjs` 扩展
- 全量：**525 passed / 0 failed**（约 93 秒，2026-11-11）。
- 真实探针（手动执行，不进入自动化）：
  - `tests/.tmp/auto-real.mjs`
  - `tests/.tmp/auto-memory-real.mjs`
  - `tests/.tmp/prompt-probe.mjs`
  - `tests/.tmp/pollinations-probe.mjs`

## 已知限制 / 未验证

- 只有一个已验证 provider，OVH 匿名层 2 请求/分钟；大场可能慢或被明确拒绝。
- v0.12.0 EXE 已构建（91.2 MB / 151 资源 / requireAdministrator / SHA-256 `342294c…`），
  但本机直接运行被“请求的操作需要提升”拒绝；未验证代理/防火墙/UAC 下的出站请求。
- 未做真实浏览器渲染/截图/暗色/390px（本机策略阻止）。
- 未做数千观众/数万消息大场的耗时与批次表现。
- 自动分析期间删除场次/清空数据未做额外 UI 守卫；服务端会失败并显示红色提示。
- Murakumo 恢复后需重新测试；Pollinations HTTP 400 原因未继续排查。

## 交付自检

- [x] 三语键一致，无硬编码新增句子
- [x] 新逻辑有单元/集成测试，全量通过
- [x] 金额/身份/去重规则未破坏（复用现有导入路径）
- [x] 手动导出/导入/报告/长期记忆保留
- [x] STATUS / HANDOFF / ROADMAP / ARCHITECTURE / AI_CONTRACT / PRIVACY_SECURITY / UI_DESIGN / TEST_PLAN / CHANGELOG 已更新
- [x] 未提交用户数据、凭据、`tests/.tmp`、`dist/`、`build/`
- [x] 本地 Commit：`b0a985a feat: add automatic anonymous AI analysis`（未 Push）
- [x] EXE 已构建（91.2 MB / requireAdministrator / SHA-256 `342294c…`）
- [ ] EXE 运行验收（本机拒绝非提升执行）
