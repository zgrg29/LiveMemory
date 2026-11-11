# 2026-11-11 v0.13.1 七项实际使用修复

## 1. 场次跳转

- 复现：`#/ai` 初始化固定 `sessions[0]`，忽略 `?session=`。
- 修复：`chooseInitialSessionId()` 按稳定 id；列表外按 id 拉取；手动选择更新 URL；旧参数不强制切回。
- 测试：`tests/unit/ai-selection.test.mjs` + `ai-ui` 静态断言。

## 2. 已配置 API Key 仍显示未配置

- 根因：只用配置数量判断；缺 Key、测试失败、未检测、缺价格被混为“未配置”。
- 修复：`providerConfigState()` 六态；删除“不再提供匿名免费 AI”历史文案；Provider 列表测试确认 `hasCredential=true` 且不返回明文 Key。
- 测试：`tests/unit/ai-config-state.test.mjs`、`v13-session-split`。

## 3. 实时进度

- 根因：只有文字；初始 idle 响应可能覆盖刚启动任务；无批次/观众计数。
- 修复：`buildAnalysisProgress()` + 进度条 + 不确定动画；1.5s 轮询；`statusEpoch` 防旧响应；100% 仅 complete。
- 测试：`ai-progress.test.mjs`、`v13-progress.test.mjs`（运行中 batch/covered 递增）。
- 未做：真实浏览器视觉验收（本机无头浏览器被策略阻止）。

## 4. Memory No viewers

- 根因：`ANALYSIS_MEMORY_EMPTY` 未本地化；combined 把无观众画像当整体失败。
- 修复：`ANALYSIS_MEMORY_NO_VIEWERS` / `ANALYSIS_MEMORY_NO_BROADCASTER`；combined 保留报告并跳过画像；memory-only 明确失败；状态含 `memorySkipped`。
- 测试：`v13-api-runner` 无观众场景。

## 5. 报告重复

- 根因：初始 `refreshReport()` 与终态 `refreshStatus()` 并发，两个响应都 append。
- 修复：`reportEpoch` 单飞；只有最新请求清空/挂载；DOM 只有一个挂载点。
- 测试：静态单挂载点断言；无真实浏览器。

## 6. Bilibili 未开播主播名

- 根因：`getInfoByRoom` 在未开播/风控时失败，`anchorName` 为空，target 只剩 `Bilibili <room>`。
- 修复：`BilibiliApi.masterInfo(uid)` 公共接口回退；`resolve`/`detect` 补全；target 持久化 displayName/platformUid；10 分钟失败重试；身份仍按 UID。
- 真实只读：房间 3（23058，未开播）→ `3号直播间` / `11153765`；5050/21144080 在 roomInfo 风控失败时 masterInfo 仍成功。
- 测试：`monitoring-bilibili-detector`、`bilibili-master-info`。

## 7. 手动停止后自动恢复

- 复现：`#reconcile` 清除 active 后，下一轮 LIVE 检查创建新 session。
- 修复：`live_stopped` + `meta.manualStop` 持久抑制；同一 live cycle（Bilibili `live_time` / YouTube videoId）不重启；确认 offline 才清除；重启保持；`resume_capture` 仅用户主动；`paused` 与 `live_stopped` 分离。
- 测试：`automatic-monitoring` 场景 A–G；`manual-stop-monitor` HTTP 停止路径。
- 未做：真实 Bilibili“手动停止→重启→仍直播→下播→再开播”全流程（Mock 可控时钟覆盖）。

## 测试

- 全量 **539 passed / 0 failed**（约 74 秒）。
- 未做：真实浏览器、真实 EXE 运行、真实付费 API（无 Key，阻塞）。未伪造。
