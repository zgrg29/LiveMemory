# 2026-11-10 · Bilibili 直播生命周期检测修复（v0.8.1，schema 9）

## 1. 现象与复现

用户报告：Bilibili 主播已下播，但 LiveMemory 仍显示「直播中」，记录时长增长到约 9 小时 45 分；
消息密度图后半段几乎没有弹幕。

真实数据（只读复制，未修改原库）：

- 场次 `ses_01M70J6954WE213THTAD`，房间 `22014628`；
- 开始 2026-11-09T16:27:48Z；最后一条真实弹幕 2026-11-10T02:04:08Z；
- 软件 2026-11-10T02:14:30Z 退出时才把它标为 `interrupted/shutdown`；
- 中间约 8 小时只有零散消息，但 WebSocket 一直连接。

## 2. 根本原因

1. `src/platforms/bilibili/adapter.mjs` 只把 `DANMU_MSG`/`SEND_GIFT`/SC/大航海交给 mapper；
2. `PREPARING`、`STOP_LIVE` 被列在 `IGNORED_COMMANDS`，`LIVE` 也没有处理；
3. 适配器从不查询 `live_status`；
4. `sessions.status='live'` 只表示本地采集任务在运行，前端却直接把它显示为平台「直播中」；
5. 启动恢复把 `last_event_at` 写进 `ended_at`，把最后一条弹幕误当成结束时间。

Bilibili 下播后不会立刻断开 WebSocket，离线房间也仍可能收到零散消息，因此上述实现会永久保持 live。

## 3. 修复内容

### 3.1 数据模型（schema 9）

`sessions` 新增：`platform_status`、`platform_status_at`、`last_live_seen_at`、
`platform_ended_at`、`platform_end_quality` 与索引。旧行全部 NULL，不猜测。

### 3.2 Bilibili 检测

- WS：处理 `LIVE` / `PREPARING` / `STOP_LIVE`，校验当前 `roomid`、generation、重复/乱序；
- 轮询：每 60 秒 `room/v1/Room/get_info`，8 秒超时；失败 60→120→240→300 秒退避；
- 确认：WS 下播事件 + 1 次有效离线，或 2 次连续有效离线；
- 失败/429/-352/缺字段/房间不匹配/无效 live_status：只退避，绝不结束；
- 确认后：清心跳/看门狗/轮询/重连 → 关 WS → 写平台状态/结束时间证据 →
  `endSession(status='ended', end_reason='platform_ended')` → SSE；
- 未开播/轮播：`BilibiliService.connect()` 在创建场次前拒绝。

### 3.3 多房间与旧回调

- 每房间独立 adapter/timer/状态；
- `SessionManager.#onPlatformStatus` 只更新对应 recording；
- `onEvent` 写入前检查 recording 存在且未 stopping；adapter 内部 generation 丢弃旧帧；
- 快速重开创建新 `sessions` 行。

### 3.4 历史修复

- 启动恢复 `ended_at=now`，不用 `last_event_at`；
- 后台探测历史 Bilibili 行：当前 `0` + 有直播证据 → `ended`；`2` → `carousel`；
  `1` → `unknown`（可能是新场次）；无证据 → `unknown`；
- 不改编排时间、不写 `platform_ended_at`、不删数据、幂等、有日志。

### 3.5 UI

- 历史列表/详情/多场标签区分已下播、手动停止、采集中断、平台未知；
- 详情生命周期卡显示最后确认直播中、平台结束时间、检测时间、结束原因；
- 结束时间未知时明确说明，不把最后弹幕当结束时间；
- 平台结束后不再显示绿色「直播中」；时长固定；
- 三语、明暗、390px 保持。

## 4. 自动化测试

全量：

```bat
node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"
```

结果：**386 passed / 0 failed / 约 50–75 秒**。

新增：`bilibili-lifecycle`、`live-lifecycle`、`platform-status-recovery`、
`platform-status-migration`、`bilibili-status-api`、`bilibili-service`、
`live-status-ui`、`session-status-serialization`。

## 5. 真实 Bilibili 验证

- 真实接口：
  - `22014628` → `live_status=0`；
  - `6`（`7734200`）→ `1`；
  - `5440` / `22637261` → `2`（轮播）；
  - `getInfoByRoom` 匿名高频 → `-352`，因此轮询用 `get_info`。
- 在线房间 25 秒未收到 `LIVE`；离线房间 20 秒未收到 `PREPARING` → 证明必须轮询。
- 真实 4 房间 20 分钟并发：`1946295012`、`2002290`、`27585820`、`1814406243`；
  4/4 保持 live，170 条真实事件，**无误结束**。
- **真实数据库副本**（只读复制到 `tests/.tmp`）：v8→v9 成功；精确修复问题行
  `ses_01M70J6954WE213THTAD`（`22014628`，2337 条消息）→ `platform_status='ended'`、
  `platform_ended_at=NULL`、`platform_end_quality='unknown'`；`ended_at`、`status`、
  `end_reason`、2951 条事件全部不变；YouTube 行不变；日志 `endedAtUnchanged:true`。
- 真实「直播中→下播」：**未捕获**。监控期间这些主播都没有下播；
  不能声称真实下播端到端已验证。
- 单房间 `1732562766`（标题「播完真退圈了」）另做 15 分钟监控：结束时仍为 `live`，
  17 条事件，未捕获下播。因此真实下播端到端仍未完成。

## 6. EXE / UI 验证

- 构建：90.7 MB，119 资源，SHA-256 `62f03b290d98652b6db93eaa491a24b68bdcff4338c31bca779cda78b0f6a409`；
- 静态校验：Manifest `requireAdministrator`、嵌入版本 `0.8.1`、资源哈希 `4972ae6c...`、
  迁移字符串 `session-platform-live-status`；
- **最终哈希在本机被 Device Guard 策略拦截**（`blocked by your organization's Device Guard policy`），
  无法执行；同源 `23a040...` 构建实测 `verify-exe.mjs` 10/10、
  `verify-exe-history.mjs` 19/19、`verify-live-status-ui.mjs` 21/21；
- 最终差异仅为 Bilibili 重连抖动保护，由 386 项源码测试覆盖；最终哈希需在无该策略/签名后复验。

## 7. 未完成 / 风险

- 真实下播端到端；
- 数小时轮询下的 429/-352 长期行为；
- 真实 UAC/管理员桌面/干净 Windows 验证；
- 历史修复只覆盖 Bilibili；YouTube 仍用自身 watch 页检测。

## 8. 数据安全

- 真实用户数据库只读复制到 `tests/.tmp` 诊断，未写入/迁移/删除原库；
- 所有自动化与真实网络探测使用临时目录/内存数据库；
- 未提交真实数据库、日志、截图中的用户数据或凭据。
