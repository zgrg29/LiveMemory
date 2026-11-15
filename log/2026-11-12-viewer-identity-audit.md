# 2026-11-12 观众身份专项审计

## 触发

用户报告一场 Bilibili 直播（2026-11-12 01:06–02:55，727 条消息，1h49m）在直播历史与 AI 分析中心都只显示 2 名独立观众。

## 调查

- 只读打开用户数据库 `E:\新建文件夹\database\livememory.db`（schema 13），定位 `ses_01M75S69P4H0NSX87PD4`。
- 事件：729 条 = 726 chat + 1 super_chat + 2 guard；gift 0。
- 身份：3 条事件带 UID，去重 2 个（SC：`bilibili:3462368`；大航海 ×2：`bilibili:11628777`）；726/726 条 chat 的 `viewer_uid`、`viewer_id` 均为 NULL。
- 昵称：71 个弹幕昵称全部 `***` 形式；付费事件昵称未打码。第一条弹幕（开播 59 秒）即已打码，5 分钟分桶全程 0 个 UID。
- 数据库一致性：`viewer_sessions` 正好 2 行，与 distinct UID 对应；无孤儿 `viewer_id`；无 `platform:0` 档案。
- 配置与日志：`secrets/` 没有 Bilibili Cookie，日志无 `bilibili.login.*`；本场为未登录连接。
- 跨场次：另一场 Bilibili 206 条全部无 UID、0 可识别观众；四场 YouTube 的未识别消息为 0。
- 复现对照：用项目自身 `BilibiliApi` + mapper 对当前开播房间 `1700650635`、`5050` 匿名探测，5/5 条弹幕得到真实 UID 与未打码昵称，排除解析器普遍故障。
- 外部对照：Bilibili 未登录弹幕风控会把昵称打码、uid 置 0；录播姬/blivechat 均有记录。

## 结论

- 根因：Bilibili 平台未登录弹幕风控（身份匿名化）＋ 页面把「可识别观众」称作「独立观众 / 本场参与人数」且不显示 726 条未识别消息。
- 判定 B（特定平台）+ D（UI 展示/口径），不是单场、不是全平台统计逻辑、不是 DB JOIN/迁移/缓存。
- 历史消息与计数可重算；726 条弹幕的真实身份不可恢复；实际观看人数未知（历史未保存平台 online）。

## 修改

- `src/shared/events.mjs`：UID=0 在 canonical 层视为缺失。
- `src/storage/repositories/sessions.mjs`、`monitor-targets.mjs`：增加 `unidentified_message_count` 派生列。
- `src/analytics/sessions/summary.mjs`：`identifiedMessages` / `unidentifiedMessages` / `identityCoverage` / `identityComplete`。
- `src/analytics/sessions/history-search.mjs`、`src/server/serializers.mjs`、`src/server/routes.mjs`：HTTP 字段同步。
- `src/web/js/pages/history.js`、`live.js`、`ai.js`、`session-actions.js`、`pages.css`：统一标签与警告。
- 三语 i18n：修正匿名登录说明，新增 identity 文案。
- 文档：`docs/AUDIT_VIEWER_IDENTITY_2026-11-12.md`、PLATFORM_INTEGRATIONS、DATA_MODEL、UI_DESIGN、STATUS、HANDOFF、ROADMAP、TEST_PLAN、CHANGELOG。

## 验证

- 全量测试：**610 passed / 0 failed**（约 118.6 秒）。
- 新增 `tests/integration/identity-stats.test.mjs`、`tests/unit/identity-labels.test.mjs`；`events.test.mjs` 增加 UID=0。
- 用户数据库副本（`tests/.tmp/audit-data`）启动服务实测：`/api/sessions`、`/api/history/search`、场次详情均返回 `727 / 2 / 726`；重启不变。原库只读，未修改。

## 未验证

- 登录后是否 100% 解除 Bilibili 打码（本机无账号 Cookie）。
- 原始 WebSocket 帧未保存，无法回读当时 `info[2][0]`。
- 真实浏览器视觉截图。
