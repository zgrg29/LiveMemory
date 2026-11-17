# Kick G5.1：开播监控、自动录制与 EXE 补验

状态：**G5.1 完成（2026-11-17）**。Kick 现在与其余五个平台一样支持「添加未开播频道 →
低频只读检查 → 开播自动记录 → 下播结束 → 继续等待下一场」，并已完成真实离线/开播/重启/
多频道验收与重新构建的候选 EXE 验收。**未发布、未合并 `main`、未 Tag/Release**。

- 相关：`docs/KICK_G2_G5_ACCEPTANCE.md`（G2–G5）、`docs/PLATFORM_INTEGRATIONS.md` §3D、
  `docs/PLATFORM_ADMISSION.md` G4、`src/monitoring/`。
- 运行工具：`scripts/kick-g51-monitor-acceptance.mjs`（真实服务验收）、
  `scripts/verify-kick-ui.mjs`（十语 UI，含监控表单）、`scripts/verify-kick-exe.mjs`（EXE）。

---

## 1. 原五平台监控机制（核实结果）

| 平台 | 检测器 | 调度策略 | 自动记录 / 下播结束 | 真实状态 |
| --- | --- | --- | --- | --- |
| Bilibili | `detectors/bilibili.mjs` | 60s | 有；`live_time` 作直播周期键 | 已实现 |
| YouTube | `detectors/youtube.mjs` | 180s | 有；videoId 作周期键 | 已实现 |
| Twitch | `detectors/twitch.mjs` | 120s | 有；stream id 作周期键 | 已实现 |
| 抖音 | `detectors/douyin.mjs` | 90s | 有；无可靠周期键（靠离线确认） | 已实现 |
| TikTok | `detectors/tiktok.mjs` | 90s | 有；room id 作周期键 | 已实现 |
| **Kick（本轮前）** | **无** | **无** | **无** | **缺口** |

`MonitoringManager` 是唯一调度器：目标行持久化在 `monitor_targets`，`start()` 恢复，
每 5 秒 tick，按平台 policy 与 jitter 控制检查；`startPlatform` 的平台分支创建 session；
`noteManualStop` 持久化「本场已手动停止」抑制；session 结束后目标回到 waiting。

## 2. Kick 缺口的根因（三个层面，均已修复）

1. **平台注册**：`MONITOR_PLATFORMS`、`MONITOR_POLICY`、`MonitoringManager.#buildDetectors`、
   `#startPlatformSession` 都没有 `kick`，路由因此拒绝创建 Kick 监控任务。
2. **UI**：Kick 面板只有手动「检查/开始」，没有共用的 `autoMonitorToggle` /
   `buildAutoMonitorSection`，也没有 `monitoring.add.kickPlaceholder/Label` 文案。
3. **下播检测**：KickAdapter 只在**重连时**重新查询频道；聊天 socket 在下播后仍可能保持连接，
   因此「没有断线」不能证明仍在直播。缺少周期性直播状态确认，自动记录会迟迟不结束。
   （G4 中 odablock 的下播恰好由断线重连路径发现，属于偶然，不是完整机制。）

## 3. 本轮修改

| 文件 | 修改 |
| --- | --- |
| `src/monitoring/constants.mjs` | `MONITOR_PLATFORMS` 加 `kick`；新增 policy：90s 基础、60–150s 抖动、错误 90s→20min、下播冷却 20s、请求间隔 2s、连续失败 4 次 |
| `src/monitoring/detectors/kick.mjs` | 新增：`resolve` 用公开频道 JSON 建立目标（`targetKey=channelId`，meta 保存 slug/chatroom/liveId）；`detect` 返回 live/offline、livestream id、start_time；错误映射为 MONITOR_*（离线不是错误） |
| `src/monitoring/manager.mjs` | 构造器接收 `kick`；注册 detector；status 暴露 kick policy；`#startPlatformSession` 走 `kick.connectDetected` |
| `src/monitoring/model.mjs` | 直播周期键 `kick:<channelId>:<livestreamId>`（无 id 时用 start_time） |
| `src/platforms/kick/service.mjs` | 共享 HTTP 客户端；新增 `observeChannel` / `connectDetected`；适配器与检查共用同一客户端；shutdown 关闭 |
| `src/platforms/kick/adapter.mjs` | 周期性（默认 60s）公开频道状态确认；连续 2 次 offline 结束 session 并上报 `platform_ended`；失败读取不改状态；`statusChecks/statusOffline` 计数 |
| `src/web/js/pages/live.js` | Kick 面板加入共用监控开关与添加表单（不另做页面） |
| 十份字典 | 新增 `monitoring.add.kickPlaceholder` / `kickLabel`（各 2,304 键） |
| `scripts/build-windows.mjs` | REQUIRED_MODULES/embedded marker 加入 `monitoring/detectors/kick.mjs` |

> 未重构任何其他平台；所有平台继续共用同一个调度器、持久化表与生命周期。

## 4. 真实验收（源码服务，`scripts/kick-g51-monitor-acceptance.mjs`）

真实网络、真实数据目录、真实产品 API；**16/16 通过**：

| 场景 | 结果 |
| --- | --- |
| A 离线频道 | `xqc` 真实离线：创建监控 → `waiting`；强制检查后仍 `waiting`、0 失败、0 session |
| F 重启恢复 | 关闭并重启真实服务（同一数据目录）→ 目标仍存在、enabled、`waiting` |
| B 开播自动记录 | 真实在播频道加入监控 → 自动进入 `recording`，session 自动创建 |
| B 真实聊天/身份 | 自动 session 收到真实聊天，`identityCoverage=1`，`kick:<sender.id>` 写入 |
| B 不重复 | 录制中再次强制检查 → 目标 session 数仍为 1 |
| E 多频道 | 两个真实在播频道同时监控 → 两条独立 session，互不串台 |
| 手动停止 | 停止自动 session 后强制检查 → `live_stopped`，没有新 session |
| 隔离 | 全程离线监控保持 `waiting`，未被直播频道影响 |
| 清理 | 删除监控目标 → 剩余 0 |

**真实下播本次未观察到**（频道在测试窗口内未结束）：如实标注。真实下播的证据：
G4 长测中 odablock 于 03:19 真实下播、session 结束；本轮用集成测试验证「连续两次 offline →
结束 session → 目标 waiting」的完整状态转换，未冒充真实端到端。

**下一次开播**：真实主播在测试窗口内未再次开播；用集成测试验证「手动停止 → 同一场保持
live_stopped → 确认 offline → 新 livestream id 开播 → 新 session」，未冒充真实端到端。

## 5. 十语言 UI 验收

`scripts/verify-kick-ui.mjs` 对真实服务（一个离线监控 + 一个自动录制）运行：

- **20/20 通过**：10 语言 ×（zh/en 四宽度 + 每语 1440）；
- 每个语言都检查了 Kick 监控开关、添加表单 placeholder 与按钮文案，无未解析键；
- 390/820/1024/1440 无横向溢出，明暗主题正常；
- 浏览器实测监控 Tab：`xqc` 显示 `waiting`，`kinocasinogaming` 显示 `recording`
  （印尼语界面：`Menunggu siaran langsung` / `Siaran langsung · merekam`）。

## 6. 自动化测试

- 新增 `tests/integration/kick-monitoring.test.mjs`（7 个测试，真实 DB + manager + 假 HTTP/WS）：
  离线等待、开播自动记录、只录一次、真实形状聊天、连续两次 offline 结束、手动停止抑制、
  下一次开播新 session、双频道隔离、重启恢复、未知频道拒绝、网络失败保留目标并退避、
  policy/周期键。
- 更新 `tests/unit/kick-ui.test.mjs`（监控开关/十语 key/打包模块）、`i18n.test.mjs`（2,304 键）。
- 全量 `node --test --test-isolation=none`：**1,177 passed / 0 failed / 0 skipped**（512,084 ms）。
- 五平台监控回归随全量通过（Bilibili/YouTube/Twitch/抖音/TikTok 的 monitoring 集成测试全绿）。

## 7. 候选 EXE（G5.1）

| 项目 | 值 |
| --- | --- |
| 文件 | `dist/LiveMemory.exe` |
| Build ID | `8bfc48086b20` |
| 大小 | 99,342,336 bytes（94.7 MiB） |
| SHA-256 | `__FINAL_SHA__` |
| Manifest | `requireAdministrator` |
| EXE 验收 | `verify-kick-exe.mjs` **27/27**，含真实监控场景 |
| 监控相关 | policy=90s；离线 `xqc` 添加为 `waiting` 且无空 session；真实在播频道自动 `recording`、真实聊天、稳定身份、未重复；手动停止后 `live_stopped` |

- EXE 重启恢复由源码真实服务验收（§4）与集成测试覆盖；EXE 内未重复重启（自动化窗口限制），
  不冒充已验证。
- 真实双击 UAC 仍未人工验证；自动化使用同 Build ID 的 asInvoker 副本。

## 8. 剩余问题与风险

| 级别 | 问题 | 说明 |
| --- | --- | --- |
| P2 | 真实下播/下一次开播未在本轮窗口内自然发生 | 状态机与结束逻辑已由集成测试覆盖；G4 有真实 odablock 下播证据 |
| P2 | 频道改名 | 监控目标用 channelId 作身份，但轮询用创建时的 slug；改名后 404 → 监控报错，需要重新添加 |
| P2 | 无续传 | 下播/断线期间的聊天可能缺失 |
| P3 | 非官方协议 | Kick 可能更改公开频道 JSON 或实时通道 |
| P3 | 真实双击 UAC | 未人工验证 |

## 9. 复现

```bat
:: 真实监控验收（离线 + 开播 + 重启 + 双频道 + 手动停止）
node scripts/kick-g51-monitor-acceptance.mjs --out tests/.tmp/kick-g51

:: 十语 UI（需真实服务 + CDP 浏览器）
node scripts/verify-kick-ui.mjs --port 9333 --base http://127.0.0.1:<port>

:: EXE（含监控）
node scripts/build-windows.mjs
node scripts/build-windows.mjs --as-invoker
node scripts/verify-kick-exe.mjs --exe dist/LiveMemory.exe --asinvoker dist/LiveMemory-asInvoker.exe
```
