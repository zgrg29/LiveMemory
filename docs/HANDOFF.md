# 交接文档（HANDOFF）

本轮：2026-11-10 · Bilibili 直播生命周期检测修复 · v0.8.1（schema v9）

## 1. 本轮结果

| 目标 | 结论 |
| --- | --- |
| 根本原因 | 已定位。Bilibili 适配器忽略 `PREPARING`/`STOP_LIVE`、不处理 `LIVE`、从不查询 `live_status`；`status='live'` 只代表本地 WebSocket 采集仍在运行。 |
| 平台/采集状态分离 | 已完成。schema 9 新增 `platform_status`、`platform_status_at`、`last_live_seen_at`、`platform_ended_at`、`platform_end_quality`。 |
| WebSocket 状态事件 | 已完成。处理当前房间的 `LIVE`/`PREPARING`/`STOP_LIVE`；校验 room id、generation、重复/乱序；旧连接不能结束新场次。 |
| 定期状态查询 | 已完成。每 60 秒查询 `room/v1/Room/get_info` 的 `live_status`；8 秒超时、指数退避、每房间独立定时器。 |
| 下播确认 | 已完成。WebSocket 下播事件 + 1 次有效离线查询，或 2 次连续有效离线查询；失败/429/-352/异常响应绝不算下播。 |
| 自动结束 | 已完成。清定时器/WebSocket/重连 → 写最终事件 → 更新 `ended_at`/`end_reason='platform_ended'`/平台状态 → SSE 刷新；保留全部数据。 |
| 多直播间 | 已完成。A 下播只结束 A；B/C 继续；已停止 adapter 的异步回调被 generation/recording 双重丢弃。 |
| 快速重开 | 已完成。同一房间重新开播创建新场次；旧场次 ended，旧回调不能写入新场次。 |
| 历史异常数据 | 已完成。启动恢复不再把最后弹幕当结束时间；后台探测历史 Bilibili 行，证据不足标 unknown，不编造 `platform_ended_at`，幂等、有日志。 |
| UI | 已完成。历史列表/详情/多场标签区分已下播、手动停止、采集中断、平台未知；平台结束后不再显示绿色直播中；时长固定；三语 + 明暗 + 390px。 |
| 测试 | 386 自动化全部通过；EXE 矩阵 10/10；EXE 历史 19/19；EXE 生命周期 UI 21/21。 |
| 真实下播 | **未完成端到端**。真实 4 房间 20 分钟监控全部保持 live、无误结束，但期间没有主播下播；不能声称真实下播已验证。 |

## 2. 后端变化

### 2.1 新模块 / 关键改动

- `src/shared/live-status.mjs`：平台状态常量（`live` / `ended` / `not_started` / `carousel` /
  `unknown` / `ending`）、结束质量（`event` / `poll` / `unknown`）、`live_status` 映射。
- `src/storage/database/migrations/index.mjs`：**v9** 新增 5 个 `sessions` 列与
  `idx_sessions_platform_status`。
- `src/storage/repositories/sessions.mjs`：
  - `setSessionPlatformStatus()`：只更新平台状态，不碰采集状态；live 观测清除未确认的结束证据；
  - `listSessionsNeedingPlatformRepair()`：只挑崩溃/退出且从未修复的 Bilibili 行；
  - `recoverInterruptedSessions()`：`ended_at=now`（检测时间），不再用 `last_event_at`；
  - 返回被恢复的完整行，供启动探测使用。
- `src/platforms/bilibili/api.mjs`：新增 `roomStatus()`（`get_info`），缺字段/无效值抛错，
  429/-352/超时保持可区分。
- `src/platforms/bilibili/adapter.mjs`：
  - 处理 `LIVE`/`PREPARING`/`STOP_LIVE`；
  - 每房间独立状态轮询、离线确认、退避；
  - `#confirmEnd()` 清定时器、关 socket、写平台状态、调用 `onEnd({reason:'platform_ended'})`；
  - `onPlatformStatus` 回调把观测交给 SessionManager；
  - 初始连接时未开播/轮播直接失败，避免创建空场次。
- `src/platforms/bilibili/recovery.mjs`：历史行分类与修复，不改 `ended_at`、不编造结束时间、
  失败留待下次、修复后幂等。
- `src/platforms/bilibili/service.mjs`：`connect()` 拒绝未开播/轮播；新增
  `repairHistoricalSessions()`。
- `src/platforms/shared/session-manager.mjs`：
  - 新增 `#onPlatformStatus()`、`emitStatus()`；
  - `#publicRecording()` 暴露平台状态；
  - `onEvent` 写入前确认 recording 仍存在且未停止。
- `src/server/index.mjs`：服务器就绪后后台执行历史平台状态修复（不阻塞启动）。
- 序列化/读模型：`serializeSessionRow`、`buildSessionSummary`、`searchHistory`、
  `liveRecordingOverview` 均增加平台状态字段。

### 2.2 路由

没有新增 HTTP 路径；`/api/live/recordings`、`/api/sessions`、`/api/sessions/:id`、
`/api/history/search` 的响应增加：

```json
{
  "platformStatus": "ended",
  "platformStatusAt": 1794278400000,
  "lastLiveSeenAt": 1794277800000,
  "platformEndedAt": 1794278399000,
  "platformEndQuality": "event"
}
```

### 2.3 数据模型

- schema **9**；旧库原地升级，旧行 5 个新列全为 NULL（不猜测历史平台状态）。
- `status` 仍只表示本地采集；`platform_status` 表示平台直播状态。
- 自动下播：`status='ended'`、`end_reason='platform_ended'`、`ended_at` = 本地结束时间，
  `platform_ended_at` = 确认的平台结束时间/检测时间，`platform_end_quality` 记录证据类型。
- 未确认/未知：`platform_ended_at=NULL`，UI 显示「未知」，不复制最后弹幕时间。

## 3. 前端变化

- `src/web/js/pages/shared.js`：
  - `captureStatusMeta()`：采集状态（直播中/确认中/正在结束记录/手动停止/采集中断/已结束）；
  - `platformStatusMeta()` / `platformStatusChip()`：平台状态独立标签；
  - `endReasonLabelKey()`：结束原因三语；
  - 平台已下播/确认中时采集标签不再是绿色。
- `src/web/js/pages/live.js`：多场标签显示平台结束；hero 使用采集+平台双状态；
  已下播提示；未开播房间禁用开始按钮。
- `src/web/js/pages/history.js`：列表增加平台状态 chip；详情增加「直播生命周期」卡
  （采集状态、平台状态、最后确认直播中、平台结束时间、检测时间、结束原因）与
  「结束时间未知」说明；平台自动结束提示。
- `src/web/i18n/{zh-CN,ja,en}.json`：新增 `status.*`、`history.detail.*`、
  `history.endReason.*`、`live.hero.platformEndedNotice`、`live.source.onlyLiveCanStart`、
  `errors.bilibiliRoomNotLive|Carousel` 等键；三语键完全一致。
- 样式沿用 tokens；未引入 innerHTML；390px 无横向溢出。

## 4. 关键规则（下一轮不要破坏）

1. **连接 ≠ 直播**：WebSocket 连接、无弹幕、网络断开、用户停止都不能推断平台状态。
2. **失败 ≠ 下播**：超时、429、-352、缺字段、房间不匹配、无效 `live_status` 只退避。
3. **确认后才结束**：WS 下播事件 + 1 次有效离线，或连续 2 次有效离线。
4. **一个房间一场**：A 下播只结束 A；快速重开必须新场次；重连 `live_time` 变化或
   `PREPARING` 后不同 `live_key` 的 `LIVE` 要结束旧场次。
5. **旧回调不能复活**：generation + recording 存在性 + `stopping` 三重保护。
6. **不编造结束时间**：`platform_ended_at` 只在有证据时写；历史修复不写；最后弹幕不是下播时间。
7. **不删数据**：自动下播/历史修复不删除事件、观众、金额、AI 关联。
8. **状态从数据库读**：前端不保存唯一状态；SSE/轮询后重新读取。

## 5. 测试 / 构建 / 验证

- 全量：**386 passed / 0 failed / 约 50–75 秒**。
- 新增：`bilibili-lifecycle`、`live-lifecycle`、`platform-status-recovery`、
  `platform-status-migration`、`bilibili-status-api`、`bilibili-service`、
  `live-status-ui`、`session-status-serialization`。
- EXE：90.7 MB / 119 资源 / SHA-256 `62f03b290d98652b6db93eaa491a24b68bdcff4338c31bca779cda78b0f6a409`；
  静态校验 manifest=`requireAdministrator`、嵌入版本 `0.8.1`、资源哈希 `4972ae...`、迁移 9 字符串。
  **最终哈希在本机被执行策略（Device Guard）拦截，未能启动**；同源的 `23a040...` 构建实测
  `verify-exe.mjs` **10/10**、`verify-exe-history.mjs` **19/19**、`verify-live-status-ui.mjs` **21/21**；
  最终差异只是重连抖动保护，已由 386 项源码测试覆盖。最终哈希必须在无该策略/签名后复验。
- 真实 4 房间 20 分钟：全部保持 live，170 条真实事件，无误结束；
  **未观察到真实下播**。

## 6. 未验证 / 边界

- 真实「直播中→下播」端到端（本轮监控期间未发生）。
- 真实 `PREPARING` 样本：只按协议/类型定义与受控帧验证。
- 数小时状态轮询下的 429/-352 长期行为。
- 真实 UAC、管理员桌面完整流程（EXE 使用 asInvoker 临时副本验证功能）。
- 轮播房间只验证了接口值 2 与适配器分类，未长时间记录轮播。
- YouTube 生命周期未在本轮改动。

## 7. 常用命令

```bat
:: 全量测试
node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"

:: 构建 / EXE 验证
node scripts/build-windows.mjs
node scripts/verify-exe.mjs
node scripts/verify-exe-history.mjs --port 49321 --debug-port 9224
node scripts/verify-live-status-ui.mjs --port 49340 --debug-port 9224

:: 真实 Bilibili 单房间探测（示例）
node scripts/probe-bilibili.mjs 5050 30
```

## 8. 本轮 Commit

- 本轮功能与文档提交：见 `git log -1`（本地 commit，未 Push）。
- 上一轮：`ca39789 feat: import AI analysis results with batched reports`。
