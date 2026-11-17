# Kick G5.1：开播监控、自动录制与 EXE 补验（2026-11-17）

分支：`feature/kick-g2`（继承 G2–G5 `969d975` / `47a918e`）
范围：补齐 Kick 开播监控，重新构建候选 EXE；**不发布、不 Push、不 Tag**。

## 1. 缺口核实

- 五个平台（Bilibili/YouTube/Twitch/抖音/TikTok）都有 detector + policy + `MonitoringManager`。
- Kick 缺三处：`MONITOR_PLATFORMS`/policy/detector/manager 分支未注册；Kick 面板无监控开关；
  adapter 只在重连时查频道，聊天 socket 下播后仍连接，缺少周期性下播确认。
- 结论：不是纯前端问题，三层都缺。

## 2. 实现

- `src/monitoring/constants.mjs`：加 `kick` 与 90s policy（抖动 60–150s、错误退避到 20min、冷却 20s）。
- `src/monitoring/detectors/kick.mjs`：公开频道 resolve/detect；离线是正常 observation；
  `targetKey=channelId`，meta 保存 slug/chatroom/liveId；错误映射 MONITOR_*。
- `manager.mjs`：构造器/detector/status/`#startPlatformSession` 接入 Kick。
- `model.mjs`：周期键 `kick:<channelId>:<livestreamId>`。
- `KickService`：共享 HTTP 客户端、`observeChannel`、`connectDetected`、shutdown 关闭。
- `KickAdapter`：60s 周期状态检查；连续 2 次 offline → stop + `platform_ended`；读取失败不改状态。
- UI：Kick 面板加入共用 `autoMonitorToggle`/`buildAutoMonitorSection`；十语 +2 键（2,304）。
- 构建：REQUIRED_MODULES 与 embedded marker 加入 detector。

## 3. 真实验收（源码服务）

`scripts/kick-g51-monitor-acceptance.mjs` **16/16**：

- 离线真实频道 `xqc` 添加监控 → waiting、0 session、0 失败；
- 重启真实服务（同一数据目录）→ 目标仍在、enabled、waiting；
- 真实在播频道加入监控 → 自动 recording、真实聊天、`kick:<id>` 身份；
- 再次检查不重复建 session；
- 两个真实频道独立监控、独立 session；
- 手动停止 → live_stopped，强制检查不重启、不重复；
- 离线目标全程 waiting；删除目标后 0 残留。

未观察到：真实下播/下一次开播自然发生（G4 有真实 odablock 下播；本轮用集成测试覆盖状态机）。

## 4. 十语 UI

`verify-kick-ui.mjs` 对真实服务（离线 + 自动录制）运行：**20/20**。
每语检查监控开关、添加表单 placeholder/按钮；无未解析键；4 宽度、明暗无溢出；
浏览器实测监控 Tab：`xqc` waiting、`kinocasinogaming` recording。

## 5. 测试

- 新增 `tests/integration/kick-monitoring.test.mjs`（7 个）：离线、开播、只录一次、两次 offline 结束、
  手动停止抑制、下一次开播新 session、双频道、重启恢复、未知频道、网络退避、policy/周期键。
- 更新 kick-ui / i18n 测试（2,304 键）。
- 全量：**1,177 passed / 0 failed / 0 skipped**（512,084 ms）；五平台 monitoring 回归全绿。

## 6. EXE

- 构建 Build ID `8bfc48086b20`、99,342,336 B、`requireAdministrator`；asInvoker 同源副本。
- `verify-kick-exe.mjs` **27/27**：新增 policy、离线添加/waiting/无空 session、真实在播自动录制、
  真实聊天 + 身份、不重复、手动停止不立即重启。
- EXE 内未做重启恢复（源码真实服务已验）；真实双击 UAC 未人工验证。

## 7. 未做 / 风险

- 真实下播/下一次开播窗口未遇到；频道改名后 slug 轮询 404 需重新添加；无续传；非官方协议。
- 未 Push / Merge main / Tag / Release；未执行 G6。
