# 2026-11-11 v0.13.1 Bug 8：已保存 API 配置可编辑

## 问题

设置页已保存配置卡片只有「检测能力 / 删除」，没有编辑按钮；改 Model ID 只能删除重建并重新输入 Key。后端 `ProviderConfigStore.update()` 和 PATCH 路由其实已存在，缺的是 UI 与部分安全/失效逻辑。

## 修复

### UI（`src/web/js/pages/ai-settings.js`）

- 每个配置卡新增「编辑配置」；复用现有表单，不新建第二套配置系统。
- 编辑态标题「编辑 API 配置」，按钮「保存修改」「取消」。
- 预填：名称、Provider、区域、Base URL、模型、价格状态/价格/币种、并发、本地网络。
- API Key 永远不回显；输入框留空，显示「已保存，留空不会替换」。
- 只改模型时不要求重输 Key；改 Provider/区域/Base URL 时显示必须重新输入 Key。
- 模型输入变化时清空旧价格并提示重新检测。
- 取消恢复创建态；保存后刷新设置页，AI 分析中心读取新配置。

### 服务端（`src/ai/providers/store.mjs`、`src/server/routes.mjs`、`src/ai/api/runner.mjs`）

- 修复 PATCH 未传 `pricing` 时被错误写成 `null` 导致付费配置无法只改模型。
- `update()` 原地更新同一 id；模型变化时：
  - 保留 credential reference / Key
  - 清空 capabilities、lastTestStatus
  - 清空旧价格、contextLength、modelLabel
- 空 `apiKey` 不覆盖；显式非空才替换。
- Provider/区域/Base URL 变化轮换 credential reference 并要求新 Key。
- `#validate` 修正 `pricing: null` 被 `??` 回退到旧价格的问题。
- 运行中的 config 禁止编辑/删除：`isConfigInUse()` + 409 `AI_PROVIDER_CONFIG_IN_USE`。
- 旧 job 的 provider/region/model 与当前配置不一致时，`resume` 返回 409 `AI_PROVIDER_CONFIG_CHANGED`；新任务使用新配置。
- `start` 的 resumable 检查加入 provider/region/model 快照匹配。

## 测试

- `tests/unit/v13-providers.test.mjs`：模型-only 编辑保留 id/default/Key，能力/价格失效；空 Key；新 Key；改名/并发；重启持久化；多配置互不影响。
- `tests/integration/v13-provider-edit.test.mjs`：HTTP 模型-only PATCH、空 Key、改名/并发、区域切换、空模型失败不改旧配置、运行中 409、resume mismatch 409、AI 中心使用新模型。
- `tests/unit/ai-settings-edit.test.mjs`：编辑按钮/表单复用/PATCH/空 Key/三语文案。
- 全量 **548 passed / 0 failed**（约 73 秒）。
- 真实浏览器点击编辑流程未执行（本机 headless 被策略阻止）；真实百炼 Key 未用于编辑测试；EXE 已重建但 UAC 未运行。

## 风险

- 只改 Model ID 会让旧价格变为 unknown；用户需重新填写新模型价格，否则付费/预算确认会按未知价格处理。这是有意的安全行为。
- 编辑 Provider/区域/Base URL 必须重新输入 Key，无法复用旧区域凭据。
- 运行中的任务不能改配置；暂停后的旧任务若配置已变，只能重新开始分析，不能 resume。
- 真实浏览器与真实 Provider 的编辑后生成仍未验收。
