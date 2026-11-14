# 2026-11-10 自动直播监听与持久化 Tab（v0.10.0 / P7）

## 目标

添加一次 Bilibili 直播间或 YouTube 频道后，软件在运行期间自动检测开播、开始记录、检测关播、结束记录，并继续等待下一场。监听 Tab 必须长期保留，对应直播间/频道而非单场直播。

## 阶段 A：现状审计

- Bilibili 已有完整 WS 生命周期、`LIVE`/`PREPARING`、60 秒 `live_status` 查询与两次离线确认；缺的是「等待开播」的持久目标与调度。
- YouTube 已有公开 watch 页解析（`live_status` 等价信息）、匿名聊天 adapter、continuation 重连；缺的是频道身份与频道级发现。
- `SessionManager` 已支持多场并发，`sessions` 是单场记录；Tab 目前完全由 active recording 派生，关播即消失。
- schema 10；`createSession` 写入列与 schema 版本绑定，迁移测试会构造旧库，因此新增列必须兼容旧库插入。

## 阶段 B：开源方案调查（详见 docs/YOUTUBE_AUTO_DISCOVERY.md）

- **streammon**（Go）：`/channel/<id>/live` + `ytInitialPlayerResponse`，要求 owner 匹配；RSS 回退；轮询 30 秒、2 rps、±10% 抖动、错误每次 +1 分钟。**无 LICENSE 文件**，不复制代码。
- **livestream_saver**（Python）：频道 Home/Videos 标签解析 + 按 videoId 去重；GPL-3.0，不复制。
- **yt-dlp**（Unlicense）：`live_status` 语义（is_live/is_upcoming/was_live/post_live/not_live）；需要 Python，不打包。
- **pytchat**（MIT，已归档）：Innertube continuation；LiveMemory 已有同类实现，不引入。
- 结论：自研「公开频道页 + RSS 回退」，Node 内置 fetch，零依赖；不下载视频/音频。

## 阶段 C：统一监听核心

- schema v11：`monitor_targets`、`sessions.monitor_target_id`。
- `MonitoringManager`：目标 CRUD、状态机、5 秒 tick、按 `next_check_at` 调度、启动错峰、最多 2 并发、每平台 pacer、抖动/指数退避/`Retry-After`、错误阈值与 30 分钟低速重试。
- 目标结束时只清 `active_session_id`，保留 `last_session_id`；下一次确认 live 才创建新 session。
- 连接重连由适配器维护，监听状态派生 `reconnecting`，不写新场次。

## 阶段 D：Bilibili

- 输入：URL / 短号 / 真实房间号；`room_init` 规范化，`roomInfo` 取主播名/UID。
- 检测：`get_info.live_status` 0/1/2；`2` 轮播不算开播。
- 开播：`connectResolved` 复用现有 adapter；adapter 再校验，避免竞态。
- 下播：完全交给现有 adapter（WS + 状态查询 + 两次确认）。

## 阶段 E：YouTube

- 输入解析：频道 URL、@handle、`/c/`、`/user/`、裸 Channel ID、视频链接。
- 频道身份：优先 `externalId`；发现真实页面中 renderer 名称列表会让「第一个 title」误读为 "Home"，改为 object 匹配 + `og:title` 优先。
- 检测：`/channel/<id>/live`；owner 匹配 + `isLive`/`isLiveNow`；预定只等待；RSS 回退最多 2 个 watch 页确认。
- 真实验证：`@LofiGirl` → `UCSJ4gkVC6NrvII8umztf0Ow`，live 视频 ID/标题解析成功；只读、无 Cookie/Key。

## 阶段 F：Tab 与界面

- 监听目标 Tab 在最左，`◎` 标记；由目标产生的场次不生成额外 Tab。
- 目标视图、错误/暂停提示、最近 10 场、暂停/恢复/立即检查/删除、确认弹窗。
- 新建面板复选框；默认手动行为不变。
- 三语约 70 键；CSS 只用 tokens；无 innerHTML。

## 阶段 G：验证与交付

- 484 自动化测试通过（新增 8 个测试文件）。
- 构建 EXE：91.1 MB、143 资源、requireAdministrator、SHA-256 `1ed07640…`；本机仍无法启动验收。
- 真实浏览器验收未执行（策略阻止无头浏览器），已如实记录。
- 未验证：真实 Bilibili 关播→再开播、YouTube 多天长跑、聊天不可用真实样本、10+ 目标限流。

## 交付判断

功能代码、数据库迁移、API、界面、测试与文档已完成；真实平台长期稳定性与浏览器渲染仍需在允许的环境补验，不能把本地假网页测试描述为真实平台验收。
