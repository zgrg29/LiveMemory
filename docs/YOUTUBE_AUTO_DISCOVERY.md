# YouTube 自动开播发现：开源方案调查与最终路线

最后更新：2026-11-10（v0.10.0）

本文记录「无需 Google Data API / OAuth / API Key」的 YouTube 频道级开播检测调研、实测与取舍。
它是实现说明，不是对 YouTube 授权或长期稳定性的承诺。

## 1. 结论（TL;DR）

LiveMemory 采用：

```text
GET https://www.youtube.com/channel/<channelId>/live     （每个离线频道约 1 次 / 3 分钟）
  ├─ 页面里的 ytInitialPlayerResponse 可解析
  │    ├─ isLive / isLiveNow = true            → live（取 videoId）
  │    ├─ isUpcoming = true                    → upcoming（继续等待）
  │    └─ 已结束 / 普通视频                    → offline
  └─ 无播放器（YouTube 返回频道页）            → offline（必须确认页面属于该频道）
结构解析失败（不包含 429/403/网络错误）
  └─ 回退：频道 RSS（最近 6 小时）→ 最多 2 个候选视频的公开 watch 页确认 isLive
```

- 不需要 Data API、OAuth、API Key、Cookie、登录。
- 不下载视频/音频，只读取公开 HTML 元数据。
- 只在「等待开播」时轮询；一旦开始记录，检测交给现有的公开网页聊天适配器。
- 页面结构变化时会进入明确的错误/回退状态，不会静默把错误当成下播。

## 2. 调查对象与证据

所有信息来自 2026-11-10 实际读取的仓库代码、API 元数据与文档，而不是只看 README。

| 项目 | 语言 / 许可 | 维护状态（调查时） | 检测机制 | 可复用性 |
| --- | --- | --- | --- | --- |
| [streammon](https://github.com/Xanthopathy/streammon) | Go；**仓库无 LICENSE 文件**（GitHub API `license: null`） | 2026-03 创建，2026-07 最近推送，3 stars，0 open issues | `/channel/<id>/live` + `ytInitialPlayerResponse`；要求 `channelId` 匹配；`isLive`/`isLiveNow`；RSS 回退；低频轮询 + 抖动 + 错误退避 | **不能复制代码**（无许可=保留所有权利）。仅参考了公开的检测思路与工程参数。 |
| [livestream_saver](https://github.com/glubsy/livestream_saver) | Python；**GPL-3.0** | 2021 创建，2026-06 最近推送，404 stars，19 open issues | 解析频道 Home/Videos 标签的 `ytInitialData`，跨标签按 `videoId` 去重；用 yt-dlp 提取实际直播 | GPL-3.0 与 LiveMemory 的 MIT 不兼容，**未复制**。其「同一视频出现在多个标签要按 ID 去重」值得借鉴。 |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Python；**Unlicense（公共领域）** | 206k stars，2026-11-04 最近推送，活跃 | 元数据 `live_status`：`is_live` / `is_upcoming` / `was_live` / `post_live` / `not_live`；`is_live`、`was_live` 布尔值 | 许可允许复用，但会引入 Python 运行时（数十 MB）或外部进程；LiveMemory 只需要布尔判断，**未打包**。语义作为设计参考。 |
| [pytchat](https://github.com/taizan-hokuto/pytchat) | Python；**MIT** | 2021 年后归档（archived），370 stars | Innertube `youtubei/v1/live_chat/get_live_chat` continuation 读取公开聊天 | LiveMemory 的 `src/platforms/youtube/anonymous/` 已经实现同类机制（continuation、轮询、重连、去重），**无需引入**。 |

补充事实：

- YouTube 的 `/channel/<id>/live` 在直播时直接返回 watch 页（HTTP 200，URL 不一定重定向），其 `ytInitialPlayerResponse.videoDetails` 含 `videoId`、`channelId`、`isLive`、`isUpcoming`，微数据含 `isLiveNow`。在未直播时返回频道页。
- 频道页的 `externalId` 是稳定频道 ID；页面上还有推荐频道的 `channelId`，**不能用页面里第一个 `channelId` 作为身份**。
- 频道 RSS `https://www.youtube.com/feeds/videos.xml?channel_id=...` 只提供最近条目，且没有可靠的「正在直播」标志，因此只能做候选发现，必须再由 watch 页确认。

## 3. 方案比较（按任务给出的 14 项标准）

| 标准 | streammon | livestream_saver | yt-dlp | pytchat | **LiveMemory 采用** |
| --- | --- | --- | --- | --- | --- |
| 1 无需 Google API Key | ✅ | ✅ | ✅ | ✅ | ✅ |
| 2 无需 OAuth | ✅ | ✅ | ✅ | ✅ | ✅ |
| 3 任意公开频道 | ✅ | ✅ | ✅ | 仅视频聊天 | ✅（频道 URL / @handle / Channel ID / 视频反查） |
| 4 稳定发现新直播 | 中（网页结构） | 中（网页 + yt-dlp） | 高（提取器持续维护） | 不负责发现 | 中（网页 + RSS 回退），失败显式可见 |
| 5 正确视频 ID | ✅ | ✅ | ✅ | ✅ | ✅（owner 校验 + 11 位 ID 校验） |
| 6 识别关播 | 靠下载器/轮询 | 靠下载器 | ✅ | ✅ 聊天结束 | ✅ 现有聊天适配器 + 平台元数据 |
| 7 请求量与限流 | 30 秒级，偏激进 | 中 | 取决于调用方式 | 聊天长轮询 | 离线频道 1 次/约 3 分钟；429 退避 |
| 8 Windows | Go 二进制 | 需 Python | 需 Python/独立二进制 | 需 Python | ✅ 零依赖，Node 内置 |
| 9 额外运行环境 | 无 | Python + FFmpeg/yt-dlp | Python | Python | **无** |
| 10 适合现有架构 | 需移植 Go | 需移植 Python | 外部进程 | 已有同类实现 | ✅ 直接使用现有会话、适配器、DB |
| 11 许可证兼容 | ❌ 无许可 | ❌ GPL-3.0 | ✅ Unlicense | ✅ MIT | ✅ 自研，无复制 |
| 12 仍在维护 | 是（但很小） | 是 | 是 | **否（归档）** | 由本项目维护 |
| 13 需要 Cookie | 可选（会员） | 可选 | 可选 | 否 | **不需要** |
| 14 页面变化后易维护 | 中 | 中 | 高（社区） | 低（归档） | 解析器隔离 + RSS 回退 + 显式错误 |

## 4. 为什么最终选择「公开频道页 + RSS 回退」

1. **没有额外运行时**：Node 22 自带 `fetch`，不需要 Python、FFmpeg、yt-dlp 或外部进程；EXE 体积不增加。
2. **许可干净**：只借鉴公开事实与思路，不复制 streammon（无许可）或 livestream_saver（GPL-3.0）代码。
3. **请求可控**：离线时每个 YouTube 频道只有 1 次 HTML 请求 / 约 3 分钟；Bilibili 为 1 次公开状态请求 / 约 1 分钟。等待时间稍长可以接受。
4. **不误判**：直播必须同时满足「视频 ID」「频道 ID 匹配」「isLive/isLiveNow」；预定直播不会被当成直播；解析失败进入错误/回退，而不是当成下播。
5. **可维护**：所有 HTML/RSS 解析集中在 `src/monitoring/youtube-discovery.mjs`（纯函数、固定 fixture 测试），网络与分类在 `src/monitoring/detectors/youtube.mjs`，平台变化不会渗透到数据库/UI。
6. **与现有聊天路径一致**：发现直播后仍然使用 `src/platforms/youtube/anonymous/` 打开公开聊天；没有第二套「官方 API 双轨」。

## 5. 请求预算与退避（实际实现）

| 场景 | 请求 |
| --- | --- |
| YouTube 频道等待开播 | `GET /channel/<id>/live`，`baseMs=180000`，抖动 ±12%（约 120–240 秒），即 **约 15–30 次/小时/频道** |
| YouTube 解析失败回退 | +1 次 RSS；最多 +2 次 watch 页确认（仅异常时） |
| Bilibili 直播间等待开播 | `GET room/v1/Room/get_info`，`baseMs=60000`，抖动 ±12%（45–90 秒），即 **约 40–80 次/小时/房间** |
| 正在记录 | 不运行监听检测；沿用现有适配器（Bilibili 60 秒状态查询 / YouTube 聊天长轮询） |
| 429 | 使用 `Retry-After`（60 秒–30 分钟），否则至少 5 分钟 |
| 连续失败 | 指数退避（Bilibili 60s→10min，YouTube 180s→30min）；4 次后进入显式 `error`，30 分钟后再试，用户可手动重试 |
| 多目标 | 每个平台一个串行 pacer（Bilibili ≥1.2s、YouTube ≥2.5s 间隔），最多 2 个并发检查，启动时错峰 0–45 秒 |

这些是固定实现参数，不是用户可调的高级设置；普通用户不需要理解。

## 6. 真实平台实测记录

2026-11-10，仅做**少量只读请求**（总计约 5 次）验证解析器：

```text
resolve https://www.youtube.com/@LofiGirl
  → channelId  UCSJ4gkVC6NrvII8umztf0Ow
  → displayName "Lofi Girl"（修正了页面 renderer 名称列表导致的 "Home" 误读）
detect  /channel/UCSJ4gkVC6NrvII8umztf0Ow/live
  → status live
  → videoId 4t4AQ15yj1M
  → title "christmas lofi radio 🎄 cozy ambience to relax to"
  → channelTitle "Lofi Girl"
  → via live-page
```

没有发送 Cookie / OAuth / API Key；没有下载视频或音频。该结果只证明「调查时」页面结构可解析，**不构成长期可用性保证**。

## 7. 已知限制

- 解析失败时必须依赖 RSS 回退；若 YouTube 同时改动 `/live` 页面、watch 页与 RSS，检测会进入 `error`，界面显示原因，不会假装正常。
- 需要登录、年龄验证、地区限制或仅会员可见的直播：公开页面拿不到状态时会显示 `restricted`/`blocked`；LiveMemory 不会绕过验证或使用账号池。
- 频道关闭聊天：检测仍能发现开播，但创建记录会失败，界面显示「聊天不可用」并退避重试；不会伪造聊天数据。
- 首播（Premiere）/普通视频不会被当作直播：`isLive` 必须为真。
- 同一频道同时有多个直播时，`/live` 页面只给其中一个；LiveMemory 记录该入口指向的直播，不扫描全部并发直播。
- 检测延迟：YouTube 最长约 2–4 分钟，Bilibili 约 45–90 秒；不追求秒级。
- 本项目不是 YouTube 官方合作方，页面结构变化可能导致功能失效；详见 `docs/PRIVACY_SECURITY.md` 与 README 的 YouTube 说明。
