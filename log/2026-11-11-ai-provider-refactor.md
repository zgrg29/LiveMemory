# 2026-11-11 · v0.13.0 AI 架构重构

## 目标

把单场直播报告与长期观众画像彻底拆开；让普通用户不需要 API Key 也能完成单场分析；让自带 API Key 的付费模型承担长期画像；保留 v0.12.1 的稳定身份、证据、批次、事务导入与失败恢复成果。

## 完成

### 单场 / 画像拆分

- 新任务 `session`：`createSessionAnalysisJob()` 生成一个 `stage=session` 包，只含 manifest/session_context/messages/instructions/schema；不含 memory_context、viewer_excerpts、全量 viewer_context；不要求 viewer_profiles / viewer_memory_updates。
- 新任务 `memory`：`createViewerMemoryJob()` 按观众分批，每批 memory_context + viewer_excerpts；模型只返回 ref，本地映射稳定 viewer_id。
- 结果 Schema 1.3.0：`analysis_scope=session|viewer_memory`；旧 1.0–1.2 继续可导入。
- 导入器：session 任务跳过 `applyMemorySideEffects`；memory 任务结果 `analysis_mode=memory`，报告读模型过滤。
- 任务状态：session/memory 不要求 aggregate；memory 批次逐批保存，失败保留已导入批次。

### 多 Provider

- `src/ai/providers/`：catalog、pricing、url-safety、adapters、store、verify。
- OpenAI-compatible 与 Anthropic 两套协议；Anthropic 独立 `/v1/messages`。
- 区域：MiniMax cn/intl；DashScope cn-beijing/singapore/us/hongkong。
- OpenRouter 官方 `/models` 动态列表；真实请求 469 models / 15 free / 396 structured（2026-11-11）。
- 配置：多配置、默认、模型、价格状态、能力、最近检测；密钥 AES-256-GCM 加密，普通 JSON 只存 credentialReference；区域切换轮换凭据。
- URL 安全：元数据/私网/localhost 默认阻止，显式 allowLocalNetwork；请求前 DNS 检查。

### 能力 / 费用 / 预算

- 六层检测 network/auth/text/json/session/memory；memory 探针含 3 refs、混合语言、零发言、证据归属。
- 费用状态 anonymous_free/api_free/paid/unknown；未知不当免费；付费/未知需 confirmBilling。
- 长期画像权限：paid + pricing + capabilities.memory + optInMemory。
- 预算：请求前估算、请求后累计 usage；达到上限停止；不自动切换更贵模型。
- `ai_provider_tests` 审计表。

### UI / 文档 / 测试

- AI 分析中心：方式/内容/配置/预算/确认/opt-in/暂停恢复/真实状态。
- 设置页 Provider 配置卡。
- 三语键合并；README/STATUS/HANDOFF/ROADMAP/AI_CONTRACT/ARCHITECTURE/PRIVACY/TEST_PLAN/CHANGELOG 更新。
- 新增 tests/unit/v13-providers 与 tests/integration/v13-*。

## 真实与 Mock 边界

- 真实：OpenRouter 模型列表（无 Key 公共接口）。
- Mock：OpenAI/Anthropic/DeepSeek/MiniMax/DashScope 协议、能力检测、runner、预算、权限。
- 阻塞：所有真实生成 Provider（无 Key）；真实浏览器/EXE。
- 未重新发起 OVHcloud 生成请求；历史 v0.12.1 真实 52 观众记录保留。

## 后续

- 用真实 Key 逐个 Provider 跑单场 + 画像能力检测并记录。
- 真实 52 观众付费画像端到端。
- 浏览器截图/窄屏/暗色；EXE 构建与运行验收。
