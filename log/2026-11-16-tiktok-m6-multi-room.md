# 2026-11-16 TIKTOK-M6：TikTok 多直播间并发与模拟直播清理

## 1. 范围

本轮只处理两项产品问题：

1. **P0**：TikTok 正在记录房间 A 时，不能开始房间 B。目标为同一平台多个不同房间并发记录，
   同一房间仍不得重复。
2. **P1**：正式界面移除模拟直播入口（顶部按钮、来源标签、面板与相关提示），保留测试夹具与历史数据。

未改数据库 schema（16）、AI 结果 Schema、提示词、其他四个平台适配器与事件语义；
未新增运行时依赖；未合并 main、未 Push、未 Tag、未 Release。

## 2. 根因调查（真实代码）

逐项检查后确认：**限制不在服务端**。

- `SessionManager` 使用 `Map<sessionId, recording>`；每个 recording 持有独立 adapter、连接状态、
  开始时间与停止闭包。
- `findDuplicate(platform, platformRoomId)` 只比较同一平台 + 同一 room；
  `findLiveSessionByRoom` 也按 `(platform, platform_room_id)`。
- `TikTokService.#startWithRoom()` 每次 `connect` 创建新的 `TikTokLocalAdapter`；
  仅匿名 `ttwid` 设备 Cookie 有意在进程内共享。
- `TikTokLocalAdapter` 的 socket、`seenIds`、`pendingGifts`、重连 timer、离线观测与结束判断
  都是实例字段；`webcast.mjs` 没有模块级可变连接状态。
- SQLite `events` 以 `UNIQUE(session_id, dedupe_key)` 兜底。
- 前端 `buildTikTokRoomMeta()`：
  ```js
  const canStart = Boolean(room.isLive) && !tiktokActiveRecording();
  ```
  `tiktokActiveRecording()` 返回**任意**一条 TikTok recording。于是只要 A 在记录，
  检查 B 时按钮被全局禁用并显示 `tiktokAlreadyRecordingHint`（「该 TikTok 直播间已在记录中」）。
  同时 `tiktokActiveRecording()` 只取第一条记录，第二场无法在面板区分/停止。

结论：**真实原因是 TikTok 面板把「同平台已有记录」当成「该房间重复」**。

## 3. 实现

### 3.1 前端（`src/web/js/pages/live.js`）

- `tiktokRecordings()`：当前全部 TikTok 记录。
- `tiktokRecordingForRoom(room)`：按 `platformRoomId` 匹配，handle 作为回退。
- `tiktokPanelRecording()`：选中 TikTok 标签 → 刚检查的房间 → 最近一场；不再全局取第一条。
- `buildTikTokRoomMeta()`：`canStart = room.isLive && !existing`；有**其他** TikTok 记录时显示
  「另有 N 个直播间在后台记录」，但不禁用。
- `buildTikTokRecordingsList()`：逐场显示主播/handle/采集状态/消息数，提供查看与独立停止。
- 新建记录页 `buildActiveRecordingsCard()`：列出所有平台的后台记录，含主播、平台、状态、
  消息数、观众数、查看、独立停止；数量为 0 时隐藏。
- 删除模拟直播：`sourceMode` 默认 `bilibili`；移除 mock 标签、`buildMockPanel()`、
  `startButton()`、`handleStart()`；顶部只保留「新建记录」标题与说明。
- 修正 `history.aiTitle` → `history.detail.aiTitle`。

### 3.2 服务端

- `routes.mjs`：`/api/bootstrap` capabilities 只列五个真实平台（移除 mock，补齐 Twitch/抖音/TikTok）。
- `/api/simulate/start|stop` **保留**，加注释说明仅作内部测试夹具；正式 UI 不再调用。
- `index.mjs`：新增 `tiktokTtwidProvider` 测试注入项；生产不传。

### 3.3 清理

- `launcher.mjs` / `cli-i18n.mjs`：删除启动时固定打印的「当前为模拟直播」提示与三语键。
- `i18n/*.json`：三语更新新建记录/活动列表；删除 `live.source.mockTab`、`mockNote`、
  `live.hero.start`、`starting`、`startFailed`、`simulationTitle`。
- 保留 `common.platform.mock`、`status.simulated`、`history.detail.simulatedNote`、
  `live.hero.simulatedChip`，用于历史模拟场次。
- 保留 `MockLiveSource`、`SessionManager.startSimulation()`、`/api/simulate/*`、fixtures 与演示脚本。

## 4. 测试

| 运行 | 结果 |
| --- | --- |
| 定向（新增 + 受影响既有） | **26 passed / 0 failed** |
| 全量单元 | **687 passed / 0 failed / 0 skipped（31,958.09 ms）** |
| 全量集成 | **347 passed / 0 failed / 0 skipped（445,550.52 ms，与单元测试并行运行）** |
| 合计 | **1034 passed / 0 failed / 0 skipped** |

新增：

- `tests/integration/tiktok-concurrent.test.mjs`：A/B 并发、独立 session、同一 msgId 不跨 session 去重、
  稳定 UID、停止 A、A 断线重连、A 下播、重复 A。
- `tests/integration/tiktok-live-api.test.mjs`：HTTP recordings 列表、messageCount、重复 409、
  停止 A 后 B 继续、两场 AI report。
- `tests/integration/tiktok-cross-platform.test.mjs`：TikTok + Bilibili。
- `tests/unit/live-new-ui.test.mjs`：零模拟 UI、五个真实平台、活动列表、三语键、历史兼容。
- `tests/unit/tiktok-ui.test.mjs`：新增不同 room 不是重复的结构断言。

## 5. 真实 TikTok 双房间 EXE 验收

脚本：`scripts/verify-tiktok-multi-exe.mjs`。

运行：

```text
node scripts/verify-tiktok-multi-exe.mjs dist/LiveMemory.exe \
  https://www.tiktok.com/@aljazeeraenglish/live \
  https://www.tiktok.com/@aljazeera/live 120
```

结果：**17/17 passed，0 NOT-OBSERVED，0 failed**。

| 项目 | 结果 |
| --- | --- |
| 房间 A | `@aljazeeraenglish` / `7706695538414062349` |
| 房间 B | `@aljazeera` / `7706505863599508276` |
| Session | A `ses_01M7H90WMS2MMC18X77V` / B `ses_01M7H915E4VKBFGC34VF` |
| 连接 | 两场均 `connected`，不同 room/socket |
| 真实 chat | A 4 条 / B 1 条（同一窗口） |
| UID / msgId | A 4/4、4/4；B 2/2、2/2（B 在停 A 后又收到 1 条） |
| 重复 A | HTTP 409 `SESSION_DUPLICATE_ROOM`，recordings=2 |
| 停止 A | HTTP 200；B 仍 connected；B 消息 1→2 |
| AI report | A/B 均 HTTP 200 |
| SQLite | 两场 `ended`、room 不同、session 不同、UID/msgId/content 完整 |
| 产物 | `tests/.tmp/verify-tiktok-multi-2026-11-16T04-14-29-211Z`（不提交） |

补充：更早用 `@gbnews` 作 B 的运行中，两场均 connected，A 收到 40 条真实弹幕，
B 在 90 秒内 0 条；该次未计为通过。真实礼物/连送/订阅仍 **NOT-OBSERVED**。

## 6. Windows EXE

| 项目 | 值 |
| --- | --- |
| 文件 | `D:\LiveMemory\dist\LiveMemory.exe` |
| Build ID | `e48016f19362` |
| source hash | `e48016f193625e919be6dd2e744eac093aefb889144a5a8825edd2faba51dbdb` |
| commit | `4224f7cb32852a4499518563456bbe1dfe2c9f00` |
| 大小 / SHA-256 | `96,730,112` bytes / `02acd0b1fdd916edca65cff8423316153318b04435413b2ff741e4cde307f3db` |
| builtAt | `2026-11-16T04:10:37.647Z` |
| 资源 / 模块 | 226 files / 51 required modules |
| RT_MANIFEST | `requireAdministrator` |

`verify-exe` **10/10**；`verify-tiktok-exe` **22/22 + 2 NOT-OBSERVED**；
`verify-tiktok-multi-exe` **17/17**。

说明：`verify-exe` 第一次与另外两个 EXE 验证并行运行时，启动等待在 25 秒超时；随后单独重跑
**10/10**。该次超时是并行验收环境竞争，不是代码失败；以单独重跑结果为准。

## 7. Git 与边界

- 分支：`feature/tiktok`。
- 代码/测试提交：`4224f7cb32852a4499518563456bbe1dfe2c9f00`。
- 文档/脚本/构建记录：本轮最终 HEAD。
- **未合并 main、未 Push、未 Tag、未 Release。**
- 真实双房间样本仅各 2 条弹幕，不能据此宣称长期高并发稳定性。
- 真实网卡断网、真实下播长跑、干净 Windows 账户与真实 UAC 双击仍需人工验收。
