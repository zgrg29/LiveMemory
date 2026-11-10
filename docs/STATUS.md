# 工程状态（STATUS）

最后更新：2026-11-10（Bilibili 直播生命周期检测修复，版本 0.8.1，schema 9）

> 本文件是唯一进度来源。只要代码与本文不一致，以代码与实测为准，并立即修正本文。

## 1. 当前阶段

- 里程碑：**M0 / M1 / M2 核心 / P0–P6 / M6 完成；Bilibili 生命周期修复完成；M3 真实接入继续验证；M4 / M7 部分推进；M5 未完成**
- 版本：`0.8.1`（`package.json`、`src/shared/app-info.mjs` 与 EXE 一致）
- 数据库 schema：**9**（新增场次平台直播状态与结束时间证据；v8 原地升级）
- 分支：`main`，本地提交，未 Push
- 发布形态：`LiveMemory.exe`，RT_MANIFEST **requireAdministrator**

## 2. 本轮完成（2026-11-10，v0.8.1）

### 2.1 根本原因

Bilibili 适配器只处理弹幕、礼物、SC、大航海；`PREPARING` / `STOP_LIVE` 被放在
`IGNORED_COMMANDS` 中，`LIVE` 也没有业务处理。适配器从不查询 `live_status`，而
`sessions.status='live'` 只表示本地 WebSocket 采集任务仍在运行。

实际下播后，Bilibili 仍保持 WebSocket 连接，离线房间也仍可能收到零散聊天，因此：

- 没有弹幕不会触发结束；
- WebSocket 不断线不会触发结束；
- 场次一直保持 `status='live'`，前端继续显示绿色「直播中」，时长持续增长。

用户遇到的约 9 小时 45 分场次（`22014628`）在真实数据库中正是这个模式：真实消息在
约 90 分钟后基本停止，但采集任务一直开到软件退出；重启时才被标记为 `interrupted`。

### 2.2 平台状态与采集状态分离（schema 9）

`sessions` 新增：

| 列 | 含义 |
| --- | --- |
| `platform_status` | `live` / `ended` / `not_started` / `carousel` / `unknown` / `ending`（确认中） |
| `platform_status_at` | 最近一次平台状态观测/确认时间 |
| `last_live_seen_at` | 最近一次可靠确认「平台直播中」的时间 |
| `platform_ended_at` | 仅在证据成立时写入平台结束时间；未知则 NULL |
| `platform_end_quality` | `event` / `poll` / `unknown` |

`sessions.status` 仍只描述本地采集（`live` / `ended` / `interrupted`）；`end_reason` 继续区分
`user` / `platform_ended` / `platform_not_live` / `startup_recovery` / `shutdown` / `failed` 等。

### 2.3 多信号检测与确认

- **WebSocket**：处理当前房间的 `LIVE`、`PREPARING`、`STOP_LIVE`；校验 `roomid`，
  丢弃旧 generation / 已停止适配器的回调；重复事件幂等。
- **定期查询**：采集期间每 60 秒查询 `room/v1/Room/get_info` 的 `live_status`（0 未开播、
  1 直播中、2 轮播中），带 8 秒超时、指数退避与每房间独立定时器。
- **及时确认**：收到 `PREPARING` 立即查询；首次离线观测后 15 秒再确认一次；
  **两次连续有效离线**或 **一次 WebSocket 下播事件 + 一次有效离线查询**才结束。
- **绝不误判**：超时、429、风控（-352）、缺字段、房间不匹配、无效 `live_status`
  只退避，不记为下播。
- **确认后**：清除心跳/看门狗/轮询/重连定时器 → 关闭 WebSocket → 写入平台状态与结束时间证据 →
  `endSession(status='ended', end_reason='platform_ended')` → 停止该场自动重连 → SSE 通知前端。
- **快速重开**：同一房间再次开播时必须重新开始记录，创建新的 `sessions` 行；
  旧行保持 ended，旧适配器回调不能写入新场次。

### 2.4 多直播间隔离

- 每个 Bilibili 房间独立 adapter、WebSocket、心跳、状态轮询、确认计数与停止操作。
- A 下播只结束 A；B/C 不受影响。
- 状态更新限定在 `SessionManager` 中该 `sessionId` 的 recording；已停止/替换的
  recording 不存在时忽略异步回调。
- `onEvent` 在写入前再次确认 recording 仍存在且未停止，旧回调不能复活已结束场次。
- 重连时若平台 `live_time` 变化，或 `PREPARING` 后收到不同 `live_key`/`live_time` 的 `LIVE`，
  视为「下播后重新开播」：结束旧场次，要求用户新建采集，不把两场混成一个场次。

### 2.5 历史异常场次

- 启动恢复不再把 `last_event_at` 当成结束时间；`ended_at` 记为启动检测到中断的时间，
  `platform_ended_at` 保持 NULL，`end_reason='startup_recovery'`。
- 启动后后台探测历史 Bilibili 行（仅 `platform_status IS NULL` 且
  `end_reason IN (NULL,'shutdown','startup_recovery')` 且已结束/中断）：
  - 当前 `live_status=0` 且有过直播证据 → `platform_status='ended'`；
  - 当前 `2` → `carousel`；
  - 当前 `1` → `unknown`（当前直播可能是新场次，不能把旧场次改成 live）；
  - 无任何证据 → `unknown`；
  - 不改 `ended_at`、不写 `platform_ended_at`、不删除事件/金额/观众数据；
  - 幂等：修复后不再重复查询；日志可追溯。
- 用户手动停止、适配器失败、已归类为 platform_ended 的行不在自动修复范围。

### 2.6 UI

- 直播记录：采集状态与平台状态分开；平台已下播/确认中时不再显示绿色「直播中」。
- 多直播间标签页：自动结束的标签显示「已下播」，其他直播继续记录。
- 历史列表：区分「直播中 / 已下播 / 手动停止 / 采集中断 / 平台状态未知」。
- 历史详情新增「直播生命周期」卡：采集状态、平台状态、最后确认直播中、平台结束时间、
  检测时间、结束原因；结束时间未知时明确显示「未知」，并说明不会把最后一条弹幕当作下播时间。
- 记录时长在 `ended_at` 固定后不再增长；刷新、切换标签、重启 EXE 后保持一致。
- 三语文案、明暗主题、390px 响应式布局保持；新增截图：
  `docs/screenshots/live-status-history-v081-zh.png`、
  `docs/screenshots/live-status-history-v081-dark-390.png`。

## 3. 自动化测试（本轮实测）

- 全量：**386 passed / 0 failed / 约 50–75 秒**
  （`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`）。
- 本轮新增：
  - `tests/unit/bilibili-lifecycle.test.mjs`：PREPARING + 状态确认、连续离线确认、
    长时间无弹幕不结束、429/超时/异常状态不结束、LIVE 取消 PREPARING、其他房间事件、
    停止后旧回调、轮播结束、PREPARING 后新 LIVE / 重连 `live_time` 变化结束旧场次、
    重连抖动不重置离线确认计数。
  - `tests/integration/live-lifecycle.test.mjs`：三场中一场下播其余继续、手动停止 vs 平台结束、
    重复结束、快速重开新场次、旧适配器不能写入新场次、结束时长固定。
  - `tests/integration/platform-status-recovery.test.mjs`：启动恢复不使用最后弹幕时间、
    历史修复幂等/不改编排时间/失败重试/当前 live 不污染旧场次。
  - `tests/integration/platform-status-migration.test.mjs`：真实 v8→v9 升级、旧行 NULL、
    新索引、重复迁移无操作、新库直接 v9。
  - `tests/unit/bilibili-status-api.test.mjs`：真实接口形态 0/1/2、缺字段、429、-352。
  - `tests/unit/bilibili-service.test.mjs`：未开播/轮播在创建采集前被拒绝。
  - `tests/unit/live-status-ui.test.mjs`：状态映射、三语键、UI 不显示绿色已下播。
  - `tests/unit/session-status-serialization.test.mjs`：API/摘要/历史搜索暴露平台状态字段。
- 更新：schema 9、版本 0.8.1、启动恢复语义、手动停止文案、EXE 脚本断言。

## 4. 真实 Bilibili 验证

- **真实 HTTP 状态**（2026-11-10）：
  - `22014628`（用户问题房间）→ `live_status=0`，标题仍可读；
  - `6`（真实房间 `7734200`）→ `live_status=1`；
  - `5440`、`22637261` → `live_status=2`（轮播）；
  - `xlive/web-room/v1/index/getInfoByRoom` 在匿名高频请求下返回 `-352`；
    因此状态轮询使用更轻的 `room/v1/Room/get_info`，失败只退避。
- **真实 WebSocket 样本**：连接在线房间 25 秒未收到 `LIVE`（该命令只在状态切换时发送）；
  连接离线房间 20 秒仅收到 `ONLINE_RANK_*`/`STOP_LIVE_ROOM_LIST`，未收到 `PREPARING`。
  这证实「连接成功/无弹幕」不能作为直播状态，必须轮询。
- **真实多房间 20 分钟监控**：4 个真实直播间（`1946295012`、`2002290`、`27585820`、
  `1814406243`）同时记录；4 个 adapter 全部保持 `platform_status=live`，共收到 170 条真实事件，
  未出现误结束。该监控期间没有主播下播，因此**未完成真实「直播中→下播」端到端验证**。
- **真实数据库副本修复**（只读复制到 `tests/.tmp`，未写原库）：
  - v8→v9 迁移成功；
  - 精确命中用户问题行 `ses_01M70J6954WE213THTAD`（房间 `22014628`，2337 条消息）；
  - 修复后 `platform_status='ended'`，`platform_ended_at=NULL`、`platform_end_quality='unknown'`；
  - `ended_at`、`status`、`end_reason`、2951 条事件全部不变；
  - YouTube 行不受影响；
  - 结果写入 `session.platform.repaired` 日志，`endedAtUnchanged:true`。
- 另对单房间 `1732562766`（标题「播完真退圈了」）做了 15 分钟真实监控：
  结束时仍为 `live`、连接正常、17 条事件；**未捕获真实下播**。
  因此本项目当前仍缺少真实「直播中→下播」端到端证据，交付报告必须如实说明。

## 5. EXE / 构建 / UI 验证

- 构建：`node scripts/build-windows.mjs`（Node v24.21.0）
- 当前构建：**90.7 MB，119 资源**，SHA-256 `62f03b290d98652b6db93eaa491a24b68bdcff4338c31bca779cda78b0f6a409`
- Manifest：`requireAdministrator`（实际 PE 补丁）；静态校验嵌入版本 `0.8.1`、
  资源哈希 `4972ae6c2114d1d4a8fa`、`session-platform-live-status` 迁移字符串。
- **本机执行限制（必须如实记录）**：最终哈希在当前主机被执行策略拦截：
  「blocked by your organization's Device Guard policy」。同一策略下，11:26 之前构建的
  `23a040...` 仍可执行；最终哈希是新建的未签名二进制，无法在本机启动验证。
  因此不能声称最终哈希 EXE 已在本机启动验收。需要在没有该策略的机器、或签名/加入允许列表后复验。
- 下面 10/10、21/21、19/19 是 `23a040...` 同源构建的实测结果（launcher/UI 代码与最终构建相同；
  最终差异仅为 Bilibili 重连抖动保护，已由 386 项源码测试覆盖）：
- `scripts/verify-exe.mjs`：**10/10**（版本、日文帮助、诊断、单实例、不可写目录、异目录、资源复用）
- `scripts/verify-exe-history.mjs`：**19/19**（真实 v6 数据库 → schema 9、历史/搜索/归档/停止/删除/重启保持）
- `scripts/verify-live-status-ui.mjs`：**21/21**（真实打包 EXE + 种子 schema 9 数据库）
  - 已下播场次不再显示绿色 Live；
  - 未知平台结束时间明确显示 Unknown，并显示解释；
  - 自动下播详情、手动停止详情、固定时长；
  - 中文生命周期文案；390px 黑暗主题无横向溢出；
  - 截图 `live-status-history-v081-zh.png`、`live-status-history-v081-dark-390.png`。

## 6. 未完成 / 未验证

- **真实下播端到端**：本轮真实监控期间没有观察到主播下播，未拿到真实 `PREPARING`
  后的自动结束证据；不能声称「真实平台下播已完全验证」。自动化测试使用真实协议样本
  与受控 WebSocket 帧，属于协议级验证。
- **轮播/风控长期稳定性**：`get_info` 的 429/-352 长期退避、跨小时轮询未做长时间验证。
- **UAC / 管理员桌面 / 干净 Windows 虚拟机 / 代码签名 / 升级回滚**：仍未完成。
- **M5 可移植备份**：未实现。
- **AI 观众画像保留/去标识化**：仍按 M7 计划处理。
- 历史修复只处理 Bilibili；YouTube 仍使用自身 watch 页结束检测。

## 7. 相关文档

`docs/HANDOFF.md`、`docs/ARCHITECTURE.md`、`docs/DATA_MODEL.md`、
`docs/PLATFORM_INTEGRATIONS.md`、`docs/TEST_PLAN.md`、`docs/CHANGELOG.md`、
`docs/ROADMAP.md`、`docs/WINDOWS_RUNTIME.md`、`docs/UI_DESIGN.md`、
`log/2026-11-10-bilibili-live-lifecycle.md`。

## 8. 下一步

1. 继续真实直播间监控，捕获一次真实 `PREPARING`/`live_status` 变化并记录端到端结果。
2. 在真实管理员桌面完成 UAC、文件夹选择、迁移与重启验证。
3. 观察长时间（>6 小时）轮询的风控与内存表现；必要时调整间隔/退避。
4. 按 M7 计划处理 AI 画像的保留与去标识化。
