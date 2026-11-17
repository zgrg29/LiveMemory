# 快手（Kuaishou）第七平台候选 — G0 技术可行性调查报告

状态：**G0 调查完成（2026-11-17）· 结论 B（有条件进入 G1）**
调查基线：`main` = `6f71f56`（v0.16.0 已发布、工作区干净）· 调查分支 `kuaishou-g0`
本轮范围：只做检索、源码阅读、有限真实实验与文档；**未接入快手、未改六个平台生产代码、未改版本号、未 Push/Tag/Release。**

> 一句话结论：**找到了真正免登录、可在本地 Node 运行的快手实时公开聊天路径**——不是 WebSocket，而是快手 H5 分享页使用的 HTTP 增量拉取接口 `GET https://livev.m.chenzhongtech.com/wap/live/feed`。
> 真实样本中昵称、数字用户 ID、毫秒时间戳 100% 可得；但**跨场/跨日稳定 ID 尚未验证、没有消息 ID、没有礼物事件，且该 H5 域名 `robots.txt` 对普通 agent 为 `Disallow: /`**。因此只能给 **B**，不能给 A。

证据标注约定（全文统一）：

| 标记 | 含义 |
| --- | --- |
| **[实测]** | 本轮亲自发起请求/解析响应得到的事实（附时间、房间、计数） |
| **[源码]** | 亲自阅读第三方开源代码得到的事实 |
| **[文档]** | README / 官方文档 / 仓库元数据声明，未亲自复现 |
| **[推测]** | 由平台语义或字段形态推断，尚无直接证据 |
| **[待验证]** | 本轮没有证据，必须由 G1/G2 回答 |

---

## 1. 执行摘要

### 1.1 最重要的发现

1. **存在免登录实时公开聊天路径 [实测]**：对任意在播公开直播间，使用移动端 UA、不带 Cookie、不带签名，直接请求
   `https://livev.m.chenzhongtech.com/wap/live/feed?liveStreamId=<id>&cursor=<cursor>`，
   返回 `result:1`、`cursor`、`pullCycleSeconds:3`、`currentWatchingCount` 与 `liveStreamFeeds[]`。
   每条 `comment` 含：
   - `content`（原文）
   - `author.userName`（昵称）
   - `author.userId`（数字账号 ID）
   - `author.headurl`（公开头像）
   - `author.userSex`（公开性别）
   - `time`（epoch 毫秒）
   - `type: "comment"`
2. **3 秒级增量、无重复 [实测]**：主样本 91 条消息（5 个在播房间，其中 3 个并发）；扩展样本合计 126 条；
   游标重放返回 0 条；实测重复 0；消息时间到接收时间 p50 约 2.7–3.3 秒、p95 约 4.5–4.9 秒。
3. **开播状态可免登录判断 [实测]**：公开直播间页 `https://live.kuaishou.com/u/<主播ID>` 的 SSR HTML 中，
   在播时含 `"playList":[{"liveStream":{"id":"<liveStreamId>"`；不在播时该片段不存在。
   该页面无需 Cookie；但**真实“下播→再开播”转换本轮窗口内未自然发生 [待验证]**。
4. **桌面 WebSocket/protobuf 路线确实存在，但当前要求登录 [源码]**：
   `live_api/liveroom/websocketinfo` 在 2026 年的实现中需要 `__NS_hxfalcon` 签名与“已登录直播站”Cookie 线
   （catbus `liveListen` 直接抛“快手直播弹幕需要登录”；KuaiShou-Spider 的请求契约也要求 `live_room_authenticated`）。
   匿名请求本轮返回 `result:2`（风控/限流），不是“未登录也能拿 token”。
5. **匿名移动端 token 路线已失效 [实测+文档]**：UniBarrage 2024 年使用的
   `POST https://v.m.chenzhongtech.com/rest/k/live/byUser` 本轮返回
   `{"result":2,"error_msg":"操作太快了，请稍微休息一下"}`；该项目 2025-05 的 issue #5 也明确报告“快手用不了/弹幕无法获取”。
6. **没有消息 ID [实测]**：`liveStreamFeeds[]` 只有 `author,content,time,type` 四个键；`id/feedId` 均不存在。
   去重必须退化为“用户+毫秒时间+内容”指纹。
7. **没有礼物/点赞/进入/关注事件 [实测+待验证]**：126 条样本中 `types` 只有 `comment`；
   礼物只在桌面 WS 的 `giftFeeds` 中出现，而该路线需要登录。匿名 H5 路线本轮 **NOT-OBSERVED**。
8. **平台规则风险高 [实测]**：`https://livev.m.chenzhongtech.com/robots.txt` 明确
   `User-agent: * / Disallow: /`（仅对 Baiduspider、Googlebot、bingbot、PerplexityBot、GPTBot、deepseekbot 等白名单放行）。
   这不是“技术不可行”，但意味着**产品化前必须做条款/合规判断**；不能把“公开页面可见”等同于“允许自动采集”。

### 1.2 评分与建议

| 方案 | 实时弹幕 25 | 稳定 ID 25 | 免登录 20 | 开播监控 15 | 许可/维护 10 | 礼物 5 | 总分 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **H5 增量拉取（推荐调查路线）** | 22 | 16 | 20 | 12 | 7 | 1 | **78** |
| 桌面 WebSocket + protobuf（登录+sig4） | 25 | 25 | 0 | 15 | 8 | 5 | **78（不可准入）** |
| 登录浏览器拦截（Playwright/CDP） | 20 | 22 | 0 | 10 | 6 | 5 | 63 |
| MITM 代理（BarrageGrab 类） | 18 | 22 | 0 | 12 | 3 | 4 | 59 |
| 官方开放平台 API | 0 | 0 | 0 | 0 | 8 | 0 | 8 |

> 两个 78 分不能相提并论：桌面 WS 路线在“免登录”这一**准入硬条件**上是 0 分，按
> `docs/PLATFORM_ADMISSION.md` 条件一直接否决。总分不能掩盖关键缺失。

**最终建议：B — 有条件进入 G1。**
条件：先解决 H5 域名的条款/合规判断；G1 必须验证跨场/跨日稳定 ID、真实开播/下播转换、长时稳定性与消息完整性。
若合规结论为“不允许自动访问该 H5 域名”，则降为 **C（暂缓）**。

---

## 2. 调查方法与仓库状态

### 2.1 仓库状态确认（开始前）

| 项目 | 值 | 证据 |
| --- | --- | --- |
| 当前分支（开始前） | `main` | `git branch -vv` |
| `main` HEAD | `6f71f56`（`docs: mark Kick as released in the current documentation`） | `git log --oneline -1` |
| 工作区 | 开始前干净；调查中新增 `research/`（未跟踪），结束时已提交 | `git status --porcelain` |
| Tag | `v0.16.0` 存在 | `git tag --list` |
| Kick | 已作为第六平台随 v0.16.0 发布 | `docs/STATUS.md` §0.55、`docs/HANDOFF.md` |
| 本轮分支 | `kuaishou-g0`（从 `main` 创建，未 Push） | `git branch --show-current` |
| 本轮调查提交 | `fb964ca`（`docs: investigate Kuaishou G0 feasibility (anonymous H5 feed)`） | `git log --oneline -1` |

> 说明：本机 `git` 不在 PATH，使用 GitHub Desktop 自带 git；
> `.git/logs` 目录被环境 ACL 拒绝写入，分支创建通过 `git branch` + 手写 `.git/HEAD` 完成（见 §12）。
> 未修改 v0.16.0 的 Tag、Release、EXE 或任何已发布资产。

### 2.2 证据来源

| 来源 | 用途 | 时间 |
| --- | --- | --- |
| GitHub REST API `api.github.com/repos/...` | 仓库存在性、license、pushed_at、archived、stars、issues | 2026-11-17 快照 |
| `raw.githubusercontent.com` 源码 | 确认实际协议、登录要求、字段名，而不是只看 README | 2026-11-17 |
| 公开网页/接口（`live.kuaishou.com`、`livev.m.chenzhongtech.com`） | 真实请求、状态检测、聊天增量 | 2026-11-17 14:55–15:25（Asia/Shanghai） |
| `robots.txt` | 平台自动访问政策信号 | 2026-11-17 |
| 本仓库源码/文档 | 事件模型、ingest、monitoring、许可证策略 | 2026-11-17 |

### 2.3 实验边界

- 只访问**公开在播直播间**；不登录、不扫码、不导入 Cookie、不使用私人账号。
- 不发送任何消息、不点赞、不送礼、不关注。
- 轮询间隔 3.15 秒（服务端 `pullCycleSeconds=3`），单房间顺序请求；多房间实验最多 3 个并发。
- 不保存聊天原文/昵称/头像；报告只保留聚合统计与脱敏样本。
- 不尝试绕过验证码、风控、签名或访问控制；请求被拒绝时记录拒绝形态，不重试规避。
- 实验脚本独立放在 `research/kuaishou-g0/`，不接入 `src/`。

---

## 3. 快手直播接入现状

### 3.1 两套 Web 生态

| 生态 | 入口 | 实时聊天 | 登录要求 | 本轮结论 |
| --- | --- | --- | --- | --- |
| 桌面直播站 | `https://live.kuaishou.com/u/<主播ID>` | WebSocket + protobuf；`SC_FEED_PUSH` 含 comment/like/gift/share/system | **需要登录态 + `__NS_hxfalcon` 签名** | 不作为准入路线（条件一不满足） |
| 移动 H5 分享页 | `https://livev.m.chenzhongtech.com/fw/live/<主播ID>` | HTTP 增量拉取 `wap/live/feed` | **不需要** | **本轮唯一可行匿名路线** |
| 官方开放平台 | `open.kuaishou.com` | 无公开“读取任意直播间聊天”的普通开发者能力 | 需要应用/审核/授权 | 不满足条件一 |
| 视频流/CDN | `*.pull.yximgs.com` 等 | 与聊天无关 | — | 不能把“能下载视频”当“能采集弹幕” |

### 3.2 关键区分

本报告严格区分以下四件事，避免误判：

1. **视频流地址解析**（能看/能录）≠ 实时聊天接入。
2. **直播间状态查询**（是否在播）≠ 聊天接入。
3. **历史评论爬取**（短视频评论）≠ 直播实时弹幕。
4. **登录后的桌面 WebSocket**（字段最全）≠ 免登录路线。

快手生态里大量项目只做 1/2/3；真正做 4 的项目又多数要求登录或浏览器环境。匿名 H5 拉取是独立的一条路。

---

## 4. GitHub 开源项目清单

> 元数据为 2026-11-17 GitHub API 快照；`pushed_at` 是最后推送时间，不等于最后 Release。
> “真实弹幕”指项目是否提供**直播实时聊天**（不是视频下载、不是历史评论）。
> “登录/Cookie/扫码/主播授权/付费/云端/私有 SDK”按项目实现判断；“未审”表示本轮未逐行阅读。

| # | 仓库 | 语言 | 许可证 | 最后推送 | Stars | 维护 | 真实弹幕 | 登录 | Cookie | 扫码 | 主播授权 | 付费/云端 | 私有 SDK | Node 可移植 | 备注 |
| --- | --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | [cv-cat/catbus](https://github.com/cv-cat/catbus) | TypeScript | **MIT** | 2026-11-17 | 627 | 活跃 | 是（桌面 WS） | **是** | 是 | 是 | 否 | 否 | 否（自研签名器） | 中（TS，但依赖多） | `liveListen` 要求登录；协议/字段最完整 |
| 2 | [cv-cat/KuaiShou-Spider](https://github.com/cv-cat/KuaiShou-Spider) | Python | **无 LICENSE** | 2026-10-08 | 83 | 较活跃 | 是（桌面 WS） | **是** | 是 | 是 | 否 | 否 | 自研 VM/签名 | 低（Python + VM） | 无许可证 → **只能读，不能复制** |
| 3 | [BarryWangQwQ/UniBarrage](https://github.com/BarryWangQwQ/UniBarrage) | Go | **GPL-3.0 + 商业限制** | 2024-12-08 | 108 | 停更近 2 年 | 声称是（移动 token + WS） | 否 | 否 | 否 | 否 | 否 | 否 | 低（Go） | issue #5 报告快手失效；许可证不兼容 |
| 4 | [ykaiqx/Live-Barrage](https://github.com/ykaiqx/Live-Barrage) | JavaScript | **MIT** | 2023-05-04 | 102 | **已归档** | 是（H5 轮询） | 否 | 否 | 否 | 否 | 否 | 否 | **高** | 本轮匿名 H5 路径的直接参考 |
| 5 | [Superheroff/kuaishou_websocket](https://github.com/Superheroff/kuaishou_websocket) | Python | **MIT** | 2024-01-10 | 48 | **已归档** | 是（浏览器拦截） | **是** | 是（storage_state） | 否 | 否 | 否 | 否 | 低（Playwright） | 需先手机登录 |
| 6 | [atvkh/kuaishou-live-mate](https://github.com/atvkh/kuaishou-live-mate) | Python | **MIT** | 2026-08-20 | 46 | 2026 年有更新 | 是（Playwright 拦截） | **是** | 是 | **是** | 否 | 否 | 否 | 低（Playwright + 1GB 安装包） | README 明示“扫码登录” |
| 7 | [wushuaihua520/BarrageGrab](https://github.com/wushuaihua520/BarrageGrab) | C# | **AGPL-3.0** | 2026-10-09 | 428 | 活跃 | 是（MITM 代理） | 取决于客户端 | 是 | 否 | 否 | 否 | 否 | 低（Windows/C#） | 需代理/客户端；许可证义务重 |
| 8 | [Ikaros-521/AI-Vtuber](https://github.com/Ikaros-521/AI-Vtuber) | Python | **GPL-3.0** | 2026-11-08 | 4,629 | 活跃 | 声称支持快手 | 未审 | 未审 | 未审 | 否 | 否 | 否 | 低（Python 桌面） | 未逐行审查其快手实现 |
| 9 | [xuanxuan123xuan/simple-live-kuaishou](https://github.com/xuanxuan123xuan/simple-live-kuaishou) | Dart | **GPL-3.0** | 2026-07-31 | 37 | 2026 年有更新 | 声称是（直播+弹幕） | 未审 | 未审 | 未审 | 否 | 否 | 否 | 低（Flutter） | 基于 SimpleLive；未审其快手协议 |
| 10 | [frostynight-furry/furryup-live-connect](https://github.com/frostynight-furry/furryup-live-connect) | JS/Java | **MIT** | 2026-11-08 | 2 | 很新 | 声称是（KuaishouExtraEvents） | 未审 | 未审 | 未审 | 否 | 否 | 否 | 中（Node 外壳 + Java collector） | 含 browser-service；未审快手细节 |
| 11 | [py-wuhao/ks_barrage](https://github.com/py-wuhao/ks_barrage) | Python | **无 LICENSE** | 2022-12-08 | 84 | 停更 3 年 | 历史实现 | 未审 | 未审 | 未审 | 否 | 否 | 否 | 低 | 无许可证 → 只能读，不能复制 |
| 12 | [Coaixy/Live_Barrage](https://github.com/Coaixy/Live_Barrage) | Python | **MIT** | 2023-01-29 | 1 | 停更 | 是 ykaiqx 的 fork | 否 | 否 | 否 | 否 | 否 | 否 | 中 | 与 #4 同源，无新增价值 |

### 4.1 许可证义务（与本仓库 MIT 的关系）

| 许可证 | 能否参考 | 能否复制代码 | 义务 | 本轮处理 |
| --- | --- | --- | --- | --- |
| MIT / ISC / BSD | 可以 | 可以（保留声明） | 保留版权与许可声明，记入 `THIRD_PARTY_NOTICES.md` | 只读参考，未复制 |
| Apache-2.0 | 可以 | 可以（保留 NOTICE，标注修改） | NOTICE/许可证 | 未使用 |
| GPL-3.0 | 可以阅读 | **不能**直接复制进 MIT 代码区 | 分发衍生作品需 GPL 源码 | 只读；不复制 |
| AGPL-3.0 | 可以阅读 | **不能**直接复制进 MIT 代码区 | 网络分发/打包需提供对应源码；可能触发整体义务 | 只读；不复制 |
| 无 LICENSE | 可以阅读 | **禁止** | — | 只读；不复制 |
| GPL + 商业限制（UniBarrage） | 可以阅读 | **禁止**用于商业/闭源集成 | 需商业授权 | 只读；不复制 |

**本轮没有复制、改写、内联任何第三方代码，也没有引入任何运行时 npm 依赖。**
报告中的协议事实来自公开客户端行为与源码阅读；若 G1 复用任何片段，必须按对应许可证登记。

---

## 5. 逐个候选深度审查

### 5.1 `cv-cat/catbus`（MIT，2026-11-17 活跃）

**为什么最重要**：它是 2026 年仍在维护、许可证兼容（MIT）、同时覆盖桌面直播站的签名、Cookie 线、protobuf、礼物字典与监控逻辑的实现。它不是“README 声称”，而是有完整源码与测试。

**仓库事实**
- URL：https://github.com/cv-cat/catbus
- 语言 TypeScript；MIT；627 stars；最后推送 2026-11-17T00:01:15Z；未归档；20 个 open issues（多为 PR）。
- 关键文件：
  - `src/platforms/kuaishou/web/live.ts`：protobuf 信封 `SocketMessage{payloadType=1, compressionType=2, payload=3}`；AES-128-CBC 常量；`feedEvents()` 把 `commentFeeds/likeFeeds/giftFeeds/shareFeeds/systemNoticeFeeds` 映射为事件。
  - `src/platforms/kuaishou/web/commands.ts`：`liveListen` 长连接；`websocketInfo`；`giftList`；`emojiAllGifts`；`roomState`。
  - `src/platforms/kuaishou/web/api.ts`：`websocketInfo()` 使用 `cookieProfile: ks.roomProfile('authenticated')`。
  - `src/platforms/kuaishou/web/client.ts`：`checkLive()` 把 `data.result=2` 映射为“直播风控拦截”。
  - `src/platforms/kuaishou/UPSTREAM`：记录上游为 `cv-cat/KuaiShou-Spider`，并说明 `livedetail` 的 671/22 业务码。
- **登录要求 [源码]**：`liveListen` 在缺少 `kuaishou.live.web_st` / `kuaishou.live.web_ph` 时，如果没有 `passToken` 或换票失败，直接抛
  `AUTH_REQUIRED: 快手直播弹幕需要登录（缺少直播站票据）`。
- **签名要求 [源码]**：`websocketinfo` 在 `LIVE_SIG4_INTERFACES` 中，需要 `__NS_hxfalcon`；直播站使用独立 SDK 版本签名器。
- **稳定性 [实测]**：匿名请求 `websocketinfo` 返回 `{"data":{"result":2}}`；`livedetail` 也返回 `result:2`。
  这不是 catbus 的 bug；是平台对匿名/无签名请求的风控。
- **可移植性**：TypeScript/Node，但依赖 `protobufjs`、自定义签名 VM、Cookie 会话、Sentry 头、设备指纹等；
  与 LiveMemory 的零依赖、无浏览器、无登录边界不兼容。**协议可参考，代码不可直接搬。**
- **许可证结论**：MIT，允许参考/复用并保留声明；但本项目选择不复制，只记录协议事实。

### 5.2 `cv-cat/KuaiShou-Spider`（无 LICENSE，2026-10-08）

**为什么重要**：它是 catbus 的上游，2026 年最激进的快手逆向工程；包含直播 API、WebSocket、protobuf、签名/风控/设备指纹。

- URL：https://github.com/cv-cat/KuaiShou-Spider
- Python；**无 LICENSE**；83 stars；最后推送 2026-10-08；未归档；3 个 open issues。
- 关键文件：
  - `ks_apis/live_ws.py`：`LiveDanmakuClient`。
  - `ks_apis/live_api.py`：`websocketinfo` 的请求契约；注释明确“只有少数接口需要 `__NS_hxfalcon`，实抓到的是 `baseuser/userLogin` 与 `liveroom/websocketinfo`”。
  - `utils/live_proto.py`：完整 protobuf 描述符驱动编解码；支持 AES/GZIP；上行 `CS_ENTER_ROOM=200`、`CS_HEARTBEAT=1`、`CS_USER_EXIT=202`。
  - `reverse/fixtures/live_ws_proto.json`、`live_ws_maps.json`：descriptor 与运行时映射。
  - `utils/sign/*`：falcon/kws/kwf/sig3 等签名；`utils/gdfp_*`：设备指纹/人机验证。
- **登录/风控要求 [源码]**：
  - `websocketinfo` 检查 `cookie_profile in {"live_room_authenticated","live_room_current_authenticated"}`。
  - 请求必须带 `sentry-trace/baggage`，GET 不带 `origin`，POST 才带。
  - 失败契约包含 `result=400002`（滑块）、`result=2`（风控）。
- **issue 证据 [文档]**：issue #4「限流问题」报告 10 个账号、2 秒间隔仍返回
  `操作太快了，请稍微休息一下`，换账号/换 IP 仍如此。与本轮匿名 `byUser` 的返回一致。
- **许可证结论**：**无 LICENSE → 只能阅读，禁止复制**。本报告只引用协议事实，不引用其代码。

### 5.3 `BarryWangQwQ/UniBarrage`（GPL-3.0 + 商业限制，2024-12-08）

**为什么重要**：它展示了一条“免登录移动端 token + WebSocket”的旧路径，是本轮最初认为可行的路线。

- URL：https://github.com/BarryWangQwQ/UniBarrage
- Go；GPL-3.0（附加商业授权条款）；108 stars；最后推送 2024-12-08；未归档；4 个 open issues。
- 关键文件 `kuaishou/kuaishou.go`：
  - `POST https://v.m.chenzhongtech.com/rest/k/live/byUser?kpn=KUAISHOU&kpf=OUTSIDE_IOS_H5&captchaToken=`
  - body `{source:6, eid, shareMethod:"card", clientType:"WEB_OUTSIDE_SHARE_H5"}`
  - 移动 UA；代码里 Cookie 行被注释掉（当年可匿名）。
  - 返回 `token`、`liveStream.liveStreamId`、`webSocketAddresses[0]`。
  - 进房帧硬编码：`SocketMessage.payloadType=200` + `CSWebEnterRoom{token,liveStreamId}` + `KUAISHOU_H5` / `OUTSIDE_IOS_H5`。
  - 解析 `SC_FEED_PUSH` 的 comment/gift/like。
- **本轮实测**：同一 `byUser` 端点返回 `{"result":2,"error_msg":"操作太快了，请稍微休息一下"}`（两个 eid、带/不带 did 均如此）。
- **issue 证据**：issue #5（2025-05-06，open）标题「快手用不了」，正文“快手弹幕无法获取了，求更新”。
- **结论**：2024 年的匿名 token 路线已失效或至少被风控/改签；**不可作为 2026 现状依据**。
- **许可证**：GPL-3.0 + 商业限制；不能复制进 MIT 项目；只能读协议。

### 5.4 `ykaiqx/Live-Barrage`（MIT，已归档，2023-05-04）

**为什么重要**：它是本轮匿名 H5 路径的直接参考；代码极简，证明“HTTP 轮询 + userId + userName + content + time”曾经可行。

- URL：https://github.com/ykaiqx/Live-Barrage
- JavaScript；MIT；102 stars；最后推送 2023-05-04；**archived**。
- `Kwai/barrage.py`：
  - `GET https://livev.m.chenzhongtech.com/wap/live/feed?liveStreamId=<id>`
  - 每 3 秒轮询；解析 `liveStreamFeeds[]` 的 `author.userId`、`author.userName`、`content`、`time`。
  - 没有任何 Cookie/签名/登录。
- **本轮实测**：该端点 2026-11 仍返回 `result:1`，字段与 2023 代码一致；新增了 `cursor` 增量语义。
- **限制**：已归档、无维护；没有 cursor（2023 版每次取当前 feed，可能重复/漏）；没有礼物；没有消息 ID。
- **许可证**：MIT；可以复用并保留声明。本轮只参考协议，未复制代码。

### 5.5 `Superheroff/kuaishou_websocket`（MIT，已归档，2024-01-10）

- URL：https://github.com/Superheroff/kuaishou_websocket
- Python；MIT；48 stars；**archived**；21 forks。
- `main.py`：Playwright Firefox 打开 `live.kuaishou.com`，使用已保存的 `storage_state` 登录态；进入 `/u/<id>`，
  监听 `/websocket` 帧；`kuaishou_pb2.SocketMessage.payloadType==310` 解析 `SCWebFeedPush`。
- **登录要求 [源码]**：先手机号登录，等待用户信息选择器，保存 cookie；否则“登录失败”。
- **结论**：证明 protobuf 字段（`userName`、`principalId`、`content`、gift/like），但依赖浏览器 + 登录，不可移植到 LiveMemory 的免登录本地 Node 服务。

### 5.6 `atvkh/kuaishou-live-mate`（MIT，2026-08-20）

- URL：https://github.com/atvkh/kuaishou-live-mate
- Python/PyQt6/Playwright；MIT；46 stars；最后推送 2026-08-20；1 个 open issue。
- README 明确流程：“点击启动 → 浏览器弹出快手/抖音 → **扫码登录（自动记住）** → 手动进入目标直播间 → 程序自动工作”。
- `src/danmu.py`：Playwright `page.on("websocket")` + JS Hook 双通道；`src/platforms/kuaishou.py` 解析 `payloadType=310`，
  取 `userName`、`content`；AES 压缩类型 3 明确“暂不支持解密”。
- **结论**：2026 年仍在维护，但它是**登录后的浏览器拦截**，不是免登录 API；安装包约 1GB，依赖 Chromium/FFmpeg，不适合 LiveMemory。
- **价值**：证明桌面 WS 的 `SC_FEED_PUSH` 字段与“浏览器环境”要求；也证明 AES 帧在部分版本出现。

### 5.7 `wushuaihua520/BarrageGrab`（AGPL-3.0，C#，2026-10-09）

- URL：https://github.com/wushuaihua520/BarrageGrab
- C#；AGPL-3.0；428 stars；最后推送 2026-10-09；1 个 open issue。
- 定位：“抖音快手bilibili直播弹幕 wss 直连，非系统代理方式，无需多开浏览器窗口”。
- 实现形态是 Windows 本地代理/拦截，需要用户运行其客户端或代理；不是纯 HTTP API。
- **结论**：技术上可参考“MITM/本地代理”路线，但：
  1. 需要额外的本地代理/客户端，不符合 LiveMemory“一个 EXE、零依赖、无浏览器”的形态；
  2. AGPL-3.0 对分发有强义务；
  3. 仍需登录/客户端环境。
- **本轮未运行**，只做元数据与定位判断。

### 5.8 其他项目

| 项目 | 判断 |
| --- | --- |
| `Ikaros-521/AI-Vtuber`（GPL-3.0，4,629 stars，2026-11-08） | 声称支持快手直播互动；Python 桌面 + 多种 TTS/LLM；本轮未逐行审查其快手采集实现。许可证不兼容复制，且体量巨大，不作为候选。 |
| `xuanxuan123xuan/simple-live-kuaishou`（GPL-3.0，Dart，2026-07-31） | 基于 SimpleLive 的五平台客户端；声称“完整适配快手直播与弹幕”；Flutter/Dart 不可移植；未审协议细节。 |
| `frostynight-furry/furryup-live-connect`（MIT，JS/Java，2026-11-08） | Node/Electron 外壳 + Java collector + browser-service；有 `KuaishouExtraEvents/KuaishouGiftPrices/UserBadges`；许可证友好，但架构仍依赖 Java/浏览器服务，未审其匿名性。 |
| `py-wuhao/ks_barrage`（无 LICENSE，2022-12-08） | 84 stars，17 open issues；无许可证，禁止复制；只能作为历史协议线索。 |
| `Coaixy/Live_Barrage`（MIT，2023-01-29） | `ykaiqx/Live-Barrage` 的 fork，1 star，无新增价值。 |

---

## 6. 实时弹幕可行性（G0-A）

### 6.1 已验证的匿名路径

**[实测] 端点**

```http
GET https://livev.m.chenzhongtech.com/wap/live/feed?liveStreamId=<liveStreamId>
GET https://livev.m.chenzhongtech.com/wap/live/feed?liveStreamId=<liveStreamId>&cursor=<cursor>
User-Agent: Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) ... Mobile/15E148 Safari/604.1
Accept: application/json, text/plain, */*
Referer: https://livev.m.chenzhongtech.com/
```

**无 Cookie、无签名、无登录、无浏览器。**

**[实测] 响应**

```json
{
  "result": 1,
  "cursor": "<opaque>",
  "pullCycleSeconds": 3,
  "currentWatchingCount": "442",
  "liveStreamFeeds": [
    {
      "content": "<原文>",
      "author": {
        "userName": "<昵称>",
        "userText": "<简介>",
        "userSex": "M",
        "userId": 1234567890,
        "headurl": "https://p22.a.yximgs.com/uhead/..."
      },
      "type": "comment",
      "time": 1794899004587
    }
  ]
}
```

**[实测] 行为**

- `result:1` 表示成功；非法 `liveStreamId` 返回 **HTTP 404**（无 JSON）。
- `cursor` 是增量游标；带上上一次的 cursor 只返回之后的新消息。
- 游标重放（同一 cursor 再请求一次）返回 `feeds:0`，未观察到重复。
- `pullCycleSeconds:3` 表示官方客户端每 3 秒拉一次；我们以 3.15 秒轮询。
- `currentWatchingCount` 是公开在线人数，可用于辅助状态显示，但**不能当开播判断**。
- 响应头 `content-type: application/json;charset=UTF-8`，`server: Tengine/2.3.2`；
  本轮未观察到 `Retry-After` / `X-RateLimit-*`。

### 6.2 真实实验结果

#### 实验环境

| 项目 | 值 |
| --- | --- |
| 时间 | 2026-11-17 14:55–15:25（Asia/Shanghai） |
| 系统 | Windows（DSH 工作区） |
| 运行时 | Node.js `v24.21.0`（DSH bundled） |
| 网络 | 本机直连；无代理 |
| 浏览器 | 未使用；Chromium 被 DSH 沙箱阻止（见 §9.4） |
| 账号 | 无 |
| 脚本 | `research/kuaishou-g0/feed-probe.mjs`（主）、`research/kuaishou-g0/cdp-probe.mjs`（未成功） |

#### 主样本表

| # | 房间 | 时长 | 轮询 | 消息 | 独立 userId | 重复 | 字段覆盖 | 延迟 p50/p95 | 事件类型 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |
| 1 | `Hhzoat1UMTk`（约 442–498 观看） | 90s | 29 | 33 | 23 | 0 | 昵称/ID/时间/头像 100% | 3,283 / 4,498 ms | comment 33 |
| 2 | 3 个房间并发（约 191–367 观看） | 100s | 30/房 | 23 | 未合并 | 0 | 100% | 未测 | comment 23 |
| 3 | 首页最热房间（2,309 观看） | 180s | 58 | 35 | 19 | 0 | 100% | 2,714 / 4,946 ms | comment 35 |
| 4 | 首页最热房间（1,172 观看） | 15s | 5 | 23 | 20 | 0 | 100% | 未测 | comment 23 |
| 5 | 内容特征抽样（685 观看） | 75s | 25 | 12 | 未统计 | 0 | 100% | 未测 | comment 12 |
| 6 | `yl123565`（约 92–100 观看） | 60s | 20 | 0 | 0 | 0 | — | — | 无消息（低活跃） |

> 合计 **126 条**观测（主样本 91 条 + 短测 35 条）；主样本来自 **5 个在播房间**（90s 与 180s 各 1 个房间，3 房间并发 100s）。
> 表中房间用 liveStreamId 标识；观看数为当时的 `currentWatchingCount`。未保存昵称/原文。

#### 字段覆盖（主样本 91 条）

| 字段 | 覆盖 | 说明 |
| --- | ---: | --- |
| `author.userName` | 100% | 每条都有非空昵称 |
| `author.userId` | 100% | 数字，9–10 位；未见空值/0 |
| `time` | 100% | epoch 毫秒；与当前时间一致 |
| `author.headurl` | 100% | 公开头像 URL |
| 消息 ID（`id/feedId`） | **0%** | 对象键仅 `author,content,time,type` |
| `type` | 100% | 样本中只有 `comment` |

#### 内容特征（12 条抽样）

- CJK：12/12；Emoji：1/12；纯 ASCII：0/12；空内容：0；换行：0；URL：0；最大长度 11 字符。
- 说明：CJK 与 Emoji 原样保留，未被转义/替换；符合 LiveMemory“原文永不翻译/替换”的要求。

#### 延迟与完整性

- 延迟定义为 `接收时刻 - 消息 time`，包含 3 秒轮询周期，因此 p50 2.7–3.3 秒是合理的。
- 游标重放 0 条、重复 0 条，说明增量语义正常。
- 未观察到消息上限/截断；单次最多 10 条（15 秒高活跃房间），没有触发分页。
- **未验证**：高聊天率房间（>10 条/3 秒）是否截断、cursor 过期行为、断线后从旧 cursor 恢复、长时间 429。

### 6.3 与“实时”定义的差距

- 这是 **3 秒级 HTTP 增量拉取**，不是 WebSocket 推送。对 LiveMemory 的“实时弹幕”展示与 AI 分析足够接近，
  但必须如实标注“轮询、非官方 H5 接口、最长约 3 秒延迟”，不能写成“实时 WebSocket”。
- 没有消息 ID，去重只能靠指纹；如果同一用户在同一毫秒发送两条完全相同的内容，指纹会合并。
  概率极低，但必须在 G2 测量并记录。
- 没有“续传游标”之外的会话概念；cursor 过期/服务端重启时的行为未验证。

---

## 7. 观众昵称与稳定 ID 可行性（G0-B）

### 7.1 已观测到的身份字段

| 字段 | 类型 | 示例形态 | 稳定性判断 |
| --- | --- | --- | --- |
| `author.userId` | 数字 | 9–10 位（脱敏示例 `1234567890`） | **高可能性为账号级 ID**；本轮未跨场/跨日验证 |
| `author.userName` | 字符串 | 可含 Emoji、空格、CJK、全角空格 | **不是身份**；可改名、可重名 |
| `author.headurl` | URL | 公开头像 | 可改；URL 内含用户 ID 片段，但不是独立身份来源 |
| `author.userSex` | `M/F` | 公开性别 | 非身份 |
| `time` | 毫秒 | `1794899...` | 消息时间；不是身份 |
| 消息 ID | 不存在 | — | 无法做消息级幂等 |

### 7.2 本轮证据

- **覆盖率 100%**：主样本 91 条中 `userName` 与 `userId` 均存在；扩展样本未发现缺失；
  没有空值、没有 `0`、没有“匿名用户”。
- **同一用户一致性**：180 秒长测中 19 个用户、7 个重复发言用户；
  **0 个用户在本次运行内出现两个不同昵称**（`usersWithMoreThanOneNickname = 0`）。
- **数字 ID 形态**：9–10 位数字，符合快手账号 ID 的形态；不是“房间内临时序号”（没有随房间/场次重置的迹象）。
- **公开主页反查失败**：用 `https://live.kuaishou.com/u/<userId>` 请求数字 ID，返回通用“快手直播”页（无该用户昵称），
  说明数字 `userId` 不是直播间 URL 的 `eid` slug；不能用它直接反查公开主页。
  `https://live.kuaishou.com/profile/<userId>` 同样只返回通用页。
  `live_api/profile/public?principalId=<userId>` 匿名返回 `result:2`（风控），不能作为独立校验。
- **跨场/跨日未验证**：本轮只在同一天、不同房间做了短时观测；没有观察到同一 `userId` 在两个房间/两天出现。
  因此**不能声称** `kuaishou:<userId>` 已经满足 LiveMemory 的跨场长期画像要求。

### 7.3 结论与风险

- **可以取得昵称**：是，100%。
- **可以取得数字用户 ID**：是，100%；**但“跨场稳定”仍是 [待验证]**。
- **不得把昵称当身份**：昵称可改、可重复、可含不可见字符；不能用昵称或昵称 hash 冒充稳定 ID。
- **建议映射**：
  - 若 G1 证明 `userId` 跨场/跨日稳定：`platform_uid = String(author.userId)`，`viewer_id = kuaishou:<userId>`。
  - 若 G1 证明不稳定：只能把 `userId` 当作“场次内 ID”，`viewer_id = null`，`source_quality = unknown`，
    长期画像功能对该平台降级或不做；不得伪造稳定身份。
- **消息 ID 缺失**：`external_id = null`；`dedupe_key` 使用
  `platform + event_type + viewer_uid + occurred_at + content` 指纹。
  需要测量同用户同毫秒同内容的碰撞率；本轮 126 条中 0 重复。
- **头像/简介**：`headurl`、`userText` 是公开资料；按 LiveMemory 保留策略处理，不能无限保存。
  昵称/头像属于个人数据，30 天保留上限同样适用。

> **对长期画像的影响（单独提示）**：即使总分 78，只要跨场稳定 ID 未验证，
> “同一位观众在不同场次/不同直播间映射为同一 `kuaishou:<id>`”就仍是假设。
> 这是本轮最重要的未决问题，不能用一个总分掩盖。

---

## 8. 开播与下播监控可行性（G0-C）

### 8.1 已验证的公开状态信号

**[实测] 公开直播间页 SSR**

```http
GET https://live.kuaishou.com/u/<主播ID>
User-Agent: 桌面 Chrome
（无 Cookie）
```

在播页面 HTML 含：

```text
"playList":[{"liveStream":{"id":"<liveStreamId>", ...
```

不在播/无效页面不含该片段。

| 主播 ID | HTTP | 页面大小 | `<title>` | `liveStream.id` | 判断 |
| --- | ---: | ---: | --- | --- | --- |
| `yl123565` | 200 | 93,397 B | `传奇十三（追龙传奇）-快手直播` | `zJp09dz0hoI` | **在播** |
| `Yuccovo6` | 200 | 93,482 B | `童家堡宇儿-快手直播` | `TRXBMp5pdWE` | **在播** |
| `zzzzzzzzzzzz` | 200 | 59,396 B | `✌️小岩✌🏿-快手直播` | 无 | **真实账号但不在播** |
| `3xtgiecv6inq83i` | 200 | 57,787 B | `快手直播`（通用） | 无 | **无效/不可见** |

**结论 [实测]**：
- 在播判断：`liveStream.id` 是否存在，而不是 `author.living`（后者在在播页面也为 `false`，catbus 也记录了这个坑）。
- 页面大小/标题不能单独作为判断；`<title>` 在离线真实账号也带主播名。
- 无效 ID 与离线真实账号都表现为“无 liveStream.id”；监控层可以把两者都当作“未在播/等待”，
  但应在连续多次无 id 且页面为通用标题时给出 `NOT_FOUND` 提示（可区分，但不是硬阻断）。

### 8.2 不可用的匿名状态 API

| 端点 | 匿名结果 | 结论 |
| --- | --- | --- |
| `GET /live_api/liveroom/livedetail?principalId=<id>` | `{"data":{"result":2}}` | 风控；不可用 |
| `GET /live_api/liveroom/websocketinfo?liveStreamId=<id>` | `{"data":{"result":2}}` | 风控；不可用 |
| `GET /live_api/profile/public?principalId=<id>` | `{"data":{"result":2,...}}` | 风控；不可用 |
| `GET /live_api/home/list` | `result:1`，只列在播房间 | 不能用于“等待未开播频道” |
| `GET /wap/live/feed?liveStreamId=<id>` | 非法/结束 id 返回 404 | 可作辅助信号，但不能用“没消息”判下播 |

### 8.3 推荐的监控设计

```text
目标：用户输入 https://live.kuaishou.com/u/<eid> 或 <eid>
每 60–90 秒（带抖动、失败退避）：
  1. GET https://live.kuaishou.com/u/<eid>（无 Cookie）
  2. 解析 "playList":[{"liveStream":{"id":"..."}
  3. 有 id → live；无 id → offline / not_found
  4. live 时启动 feed 轮询（3 秒），把 id 作为会话的 liveStreamId
  5. feed 连续 404/result!=1 且页面无 id → 结束本场
  6. 只凭“没收到消息”绝不判下播
```

- **多频道**：每个目标独立定时器 + 独立 feed 轮询；用 `requestGapMs` 错峰。
  本轮 3 房间并发 100 秒无错误，但 10+ 房间未测。
- **重启恢复**：目标与状态可以复用 LiveMemory 的 `MonitoringManager` 持久化；feed 的 cursor 不建议持久化
  （重启后从当前 feed 重新开始，可能漏掉停机期间的消息；必须标注）。
- **下播确认**：连续 2 次页面无 id（间隔 ≥60 秒）才结束，避免单次抖动/缓存误判。
- **不能把“没有弹幕”当下播**：低活跃房间可能长时间 0 条（实验 #6 60 秒 0 条）。
- **真实转换未验证 [待验证]**：本轮 30 分钟窗口内没有自然下播；G1 必须观察至少 1 次真实
  `在播 → 下播 → 再开播`，并验证自动停止/自动开始。

---

## 9. 礼物与其他互动事件

### 9.1 事件可得性矩阵

| 事件 | H5 匿名 feed | 桌面 WS（登录+sig4） | 本轮证据 |
| --- | --- | --- | --- |
| 普通聊天 | **已在真实数据中观察** | 代码支持 | 126 条 `type:"comment"` |
| 礼物 | **尚未发现/不可得** | 代码支持 `giftFeeds` | 126 条中 0 条 gift |
| 礼物数量 | 不可得 | `batchSize/comboCount` | 未观测 |
| 礼物类型/名称 | 不可得 | `giftId` + 礼物字典 | 未观测 |
| 付费金额/平台价值 | 不可得 | 部分实现有 `unitPrice`，但非本币收入 | 未观测；不得换算人民币 |
| 点赞 | 不可得（只有总 watchingCount） | `likeFeeds` / `displayLikeCount` | 未观测 |
| 关注 | 未发现 | 未发现独立事件 | 未观测 |
| 分享 | 未发现 | `shareFeeds` | 未观测 |
| 用户进入 | 未发现 | 可能 `SC_LIVE_WATCHING_LIST` | 未观测 |
| 会员/粉丝团 | 未发现 | 未确认 | 未观测 |
| 开播/下播 | 通过页面 SSR 检测 | 通过状态接口/连接 | 状态检测已验证；真实转换未验证 |
| 消息撤回/删除 | 未发现 | 未发现 | 未观测 |

### 9.2 结论

- **礼物不是准入条件**（`PLATFORM_ADMISSION.md` §1）。H5 匿名路线没有礼物，不因此否决平台；
  但必须在文档/界面标 `NOT-OBSERVED` / “该路线不提供礼物”，不能因为桌面 WS 代码有 `giftFeeds` 就宣称“支持礼物”。
- **不得把礼物价值换算成人民币**；即使未来从桌面 WS 拿到 `unitPrice/virtualPrice`，也只能作为 `display`/`unknown`，
  没有本币金额时 `amount_minor=null`、`currency=null`、`value_kind=unknown`。
- 若 G1 需要礼物，只能另做“登录后的桌面 WS”研究；那会违反条件一，需要用户单独授权，不能默认开启。

---

## 10. 协议与技术路线比较

### 10.1 路线总表

| 路线 | 传输 | 免登录 | 签名/风控 | 浏览器 | Node 本地 | 礼物 | 稳定 ID | 当前可用性 | 许可证/维护 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **H5 增量拉取** | HTTPS JSON | **是** | 无签名；有 IP/频率风控 | 否 | **是（零依赖）** | 否 | 数字 userId（待跨场验证） | **实测可用** | 无直接代码依赖；参考 MIT/归档 + GPL 项目 |
| 桌面 WebSocket | WSS + protobuf | 否 | `__NS_hxfalcon` + 登录票据 + Sentry + 设备指纹 | 否 | 需自研 protobuf/签名 | 是（代码支持） | `principalId` | 匿名 `result:2`；登录后可能可用 | catbus MIT；KuaiShou-Spider 无证 |
| 移动 token + WS | HTTPS + WSS | 曾可 | 现需 sig4/风控 | 否 | 需 protobuf | 是（代码支持） | `principalId` | **实测失效** | UniBarrage GPL+商业限制 |
| 登录浏览器拦截 | Playwright/CDP | 否 | 由真实浏览器完成 | **是** | 否（需 Chromium） | 是 | `principalId` | 项目可用但需登录 | MIT/atvkh、Superheroff |
| MITM 代理 | 本地代理 | 否 | 由客户端完成 | 可能 | 否 | 是 | 是 | 需客户端/代理 | AGPL BarrageGrab |
| 官方 API | REST | 否 | OAuth/应用审核 | 否 | 是 | 否 | 是 | 无公开聊天读取 | 官方条款 |

### 10.2 桌面 WS 的真实门槛（为什么不能作为 G0 路线）

**[源码] catbus `commands.ts`**

```ts
if (!k.s.cookies.get('kuaishou.live.web_st') || !k.s.cookies.get('kuaishou.live.web_ph')) {
  if (!k.s.cookies.get('passToken') || !(await api.refreshLiveSession(k, referer))) {
    throw new CatbusError('AUTH_REQUIRED', '快手直播弹幕需要登录（缺少直播站票据）')
  }
}
```

**[源码] catbus `api.ts`**

```ts
export async function websocketInfo(ks, liveStreamId, eid) {
  const [data] = await ks.live('GET', '/live_api/liveroom/websocketinfo', {
    query: [['liveStreamId', liveStreamId]],
    referer: roomReferer(eid),
    cookieProfile: ks.roomProfile('authenticated'), // 已登录 Cookie 线
  })
  return data
}
```

**[源码] KuaiShou-Spider `live_api.py`**：`websocketinfo` 的契约检查

```python
cookie_profile in {"live_room_authenticated", "live_room_current_authenticated"}
```

并且只有 `baseuser/userLogin` 与 `liveroom/websocketinfo` 需要 `__NS_hxfalcon`（直播站 SDK 43469）。

**[实测]** 匿名 `websocketinfo` → `{"data":{"result":2}}`；匿名 `livedetail` → `result:2`。
**结论**：要拿桌面 WS 的礼物/点赞/完整事件，必须登录并复现签名/设备指纹；这违反条件一，
且自研签名 VM 属于“绕过平台安全机制”的高风险行为。**本轮明确不做。**

### 10.3 H5 路线的协议细节

| 项目 | 值 | 证据 |
| --- | --- | --- |
| 入口 | `https://live.kuaishou.com/u/<eid>`（桌面 UA）| [实测] |
| 移动跳转 | 302/内容到 `https://livev.m.chenzhongtech.com/fw/live/<eid>?...&shareObjectId=<liveStreamId>` | [实测] |
| liveStreamId | 从 SSR `"playList":[{"liveStream":{"id":"..."` 解析 | [实测] |
| 聊天 | `GET /wap/live/feed?liveStreamId=&cursor=` | [实测] |
| 认证 | 无 | [实测] |
| 签名 | 无 | [实测] |
| Token 生命周期 | 无 token；cursor 生命周期未知 | [待验证] |
| 心跳 | 无；客户端轮询 | [实测] |
| 断线重连 | HTTP 失败重试；cursor 可续；重启后 cursor 丢失 | [推测] |
| 多房间 | 每房间独立请求；3 房间并发无错误 | [实测] |
| 去重 | 无消息 ID；指纹去重 | [实测] |
| 封禁/限流风险 | 有；`result:2` / “操作太快了”已在其他端点出现 | [实测+文档] |

### 10.4 是否依赖浏览器/第三方签名/云端

| 问题 | H5 路线 |
| --- | --- |
| 依赖浏览器环境 | **否** |
| 能在 Windows EXE 的本地 Node 服务运行 | **是**（`fetch` + `node:zlib` 即可，无需 npm） |
| 依赖第三方在线签名服务 | **否** |
| 依赖硬编码参数 | `liveStreamId`/`eid` 动态；`User-Agent` 是普通移动 UA；无可逆签名密钥 |
| 已知封禁/访问限制 | 有 IP/频率风控；`robots.txt` `Disallow: /` |
| 平台规则/法律限制 | **高风险，需合规判断** |

---

## 11. 真实实验记录

### 11.1 做了什么

1. 匿名拉取 `home/list`、`category/classify`，确认公开首页与分类可用。
2. 解析 `home/list` 的 `liveInfo[]`，取 `id`（liveStreamId）与 `author.id`（eid）。
3. 解析 `https://live.kuaishou.com/u/<eid>` 的 SSR，确认在播/不在播状态。
4. 对在播房间轮询 `wap/live/feed`，记录字段、延迟、重复、事件类型、内容特征。
5. 尝试桌面 WS 相关端点（`livedetail`、`websocketinfo`、`profile/public`）与 UniBarrage 的 `byUser`，
   记录匿名拒绝形态；不做规避重试。
6. 尝试用 Chrome CDP 观察匿名浏览器行为；被 DSH 沙箱阻止（见 11.4）。

### 11.2 真实数据（主样本）

| 指标 | 90s 房间 | 180s 房间 | 3 房间/100s |
| --- | ---: | ---: | ---: |
| 轮询次数 | 29 | 58 | 30/房 |
| 消息数 | 33 | 35 | 23 |
| 独立 userId | 23 | 19 | 未合并 |
| 重复（指纹） | 0 | 0 | 0 |
| 昵称覆盖 | 100% | 100% | 100% |
| userId 覆盖 | 100% | 100% | 100% |
| time 覆盖 | 100% | 100% | 100% |
| 头像覆盖 | 100% | 100% | 100% |
| 消息 ID 覆盖 | 0% | 0% | 0% |
| p50 延迟 | 3,283 ms | 2,714 ms | 未测 |
| p95 延迟 | 4,498 ms | 4,946 ms | 未测 |
| 单次最多消息 | 2 | 2 | 2 |
| 0 消息轮询 | 未统计 | 30/58 | 未统计 |
| 事件类型 | comment 33 | comment 35 | comment 23 |

> 180 秒房间的 `perPollCounts` 显示最多 2 条/3 秒、30 次空轮询；说明该房间聊天率低，
> 不是“接口只返回 2 条”。15 秒高活跃房间曾单次返回 10 条，说明没有固定 2 条上限。

### 11.3 失败/被拒绝记录

| 请求 | 结果 | 处理 |
| --- | --- | --- |
| 匿名 `GET /live_api/liveroom/websocketinfo?liveStreamId=...` | `{"data":{"result":2}}` | 记录；不重试规避 |
| 匿名 `GET /live_api/liveroom/livedetail?principalId=...` | `{"data":{"result":2}}` | 记录；改用 SSR |
| 匿名 `GET /live_api/profile/public?principalId=...` | `result:2`（风控） | 记录；不用于身份校验 |
| `POST v.m.chenzhongtech.com/rest/k/live/byUser` | `{"result":2,"error_msg":"操作太快了，请稍微休息一下"}` | 记录；不换 IP/账号重试 |
| `GET /wap/live/feed?liveStreamId=AAAAAAAAAAA` | HTTP 404 | 作为无效 id 信号 |

### 11.4 未能完成的实验：匿名浏览器观察

- 目的：确认“登录前的真实浏览器”是否也会拿到 WS token/弹幕。
- 方法：`research/kuaishou-g0/cdp-probe.mjs` 启动本机 Chrome `--headless=new` + CDP，捕获
  `Network.webSocketCreated` / `webSocketFrameReceived` 与相关 XHR。
- 结果：**被环境阻止，不是快手拒绝**。Chrome/Edge 在 DSH 沙箱下创建 mojo channel 时报
  `Check failed: platform_channel.cc: ... 拒绝访问 (0x5)`，进程立即退出；Node `child_process.spawn` 也报 `EPERM`。
- 处理：停止该实验，不尝试绕过沙箱；改用 HTTP 实测。
- 影响：**没有独立验证“匿名浏览器是否收到弹幕”**；但下面的源码证据足以说明桌面 WS 需要登录：
  catbus 的 `AUTH_REQUIRED`、KuaiShou-Spider 的 `live_room_authenticated` 契约、以及匿名 `websocketinfo` 的 `result:2`。

### 11.5 未观测项

- 真实“下播 → 再开播”转换（窗口内未发生）。
- 礼物/点赞/进入/关注/分享/撤回。
- 高聊天率（>10 条/3 秒）下的截断/丢失。
- cursor 过期、服务端重启、IP 限流后的恢复。
- 10+ 房间并发。
- 跨日/跨房间的同一 userId。

---

## 12. 安全、法律与维护风险

### 12.1 平台规则风险（本轮最高风险）

**[实测] `robots.txt`**

```text
# https://livev.m.chenzhongtech.com/robots.txt
User-agent: Baiduspider
Allow: /
...
User-agent: deepseekbot
Allow: /

User-agent: *
Disallow: /
```

- `livev.m.chenzhongtech.com` 对**所有未列名 agent** 禁止抓取全站。
- `live.kuaishou.com/robots.txt` 没有 `User-agent: *` 组（对普通 agent 默认允许），但 H5 接口在 `livev` 域名。
- robots 不是法律，但它是平台“是否欢迎自动访问”的明确信号；结合快手用户协议/直播规则未逐条审阅，
  **产品化前必须由用户/法务做书面判断**。
- 本轮只做“用户主动、低频、公开直播间”的技术可行性实验；不对外分发、不长期运行、不采集大规模数据。

### 12.2 绕过访问控制的边界

- 本轮**没有**破解验证码、没有伪造登录态、没有规避地区/年龄限制、没有复现签名 VM、没有使用付费签名/采集服务。
- 匿名 `result:2` / “操作太快了”被视为平台拒绝；没有换 IP、换账号、加代理重试。
- 桌面 WS 的 `__NS_hxfalcon` 签名是平台安全机制；**LiveMemory 不应自研复现**。
- 若未来平台对 H5 feed 加签名/验证码，应停止该路线并如实报告，不得规避。

### 12.3 维护风险

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 未公开 H5 接口 | 官方未承诺稳定；可能改路径/字段/加签 | 适配器隔离、协议版本探测、失败即报错 |
| 无专门维护库 | 没有 2026 年仍维护的“H5 feed”库；只有归档的 2023 实现 | 自研薄客户端 + 监控告警 |
| 无消息 ID | 去重靠指纹 | G2 测碰撞率；保留原始 `time` |
| 限流/风控 | 其他端点已出现 `result:2`；H5 feed 暂时未见 | 3 秒/房间、错峰、指数退避、不超过 3 房间并发先验证 |
| 登录路线诱惑 | 桌面 WS 字段更全，但会破坏免登录边界 | 明确禁止在本平台默认启用登录 |
| 网页结构变化 | SSR 解析依赖 `playList` 片段 | 多信号回退（feed 404、页面标题、连续确认） |

### 12.4 隐私与数据保留

- 聊天、昵称、头像、数字 userId 都是**个人数据**，即使是公开可见。
- LiveMemory 现有 30 天原文保留上限同样适用；不能因为“免登录/非官方”就无限保存。
- 本轮实验**没有把聊天原文/昵称/头像写入仓库或日志**；报告只保留聚合与脱敏样本。
- 头像 URL 不应下载/缓存（AGENTS.md 禁止为表情引入下载/缓存；头像同理应谨慎）。
- 若未来做 AI 分析，仍遵守“原文永不翻译覆盖”“金额不换算收入”。

### 12.5 许可证风险

- 本轮**未复制任何第三方代码**；`research/` 脚本是独立编写的 HTTP 客户端。
- 协议事实来源包括 MIT（ykaiqx、catbus、Superheroff、atvkh）、GPL-3.0（UniBarrage、AI-Vtuber、simple-live）、
  AGPL-3.0（BarrageGrab）、无 LICENSE（KuaiShou-Spider、py-wuhao）。
- 若 G1 复用任何代码片段，必须按对应许可证登记；GPL/AGPL 代码不得直接进入 MIT 代码区。
- 不引入运行时 npm 依赖；不引入付费 API/云端中转。

---

## 13. 100 分制方案评分

### 13.1 评分表

| 维度（权重） | H5 拉取 | 桌面 WS | 登录浏览器 | MITM | 官方 API |
| --- | ---: | ---: | ---: | ---: | ---: |
| 实时弹幕采集可行性（25） | 22 | 25 | 20 | 18 | 0 |
| 跨场稳定观众 ID（25） | 16 | 25 | 22 | 22 | 0 |
| 免登录和本地运行（20） | 20 | 0 | 0 | 0 | 0 |
| 开播与下播监控（15） | 12 | 15 | 10 | 12 | 0 |
| 开源许可证与维护状态（10） | 7 | 8 | 6 | 3 | 8 |
| 礼物及其他互动事件（5） | 1 | 5 | 5 | 4 | 0 |
| **总分** | **78** | **78** | **63** | **59** | **8** |

### 13.2 评分理由（H5 路线）

- **实时 22/25**：3 秒增量、cursor、126 条真实消息；扣分因为不是推送、无消息 ID、高聊天率未验证。
- **稳定 ID 16/25**：字段 100%、数字账号 ID、运行内一致；扣分因为跨场/跨日未验证、无法公开反查。
- **免登录 20/20**：无 Cookie、无签名、无浏览器、无云端、Node 内置即可。
- **监控 12/15**：SSR 在播/不在播已验证；扣分因为真实下播→再开播未观测、页面轮询成本。
- **许可/维护 7/10**：无代码复制、协议来源多样；扣分因为无维护中的 H5 库、未公开接口、robots 风险。
- **礼物 1/5**：匿名路线 0 礼物；给 1 分只因为桌面 WS 代码证明平台存在礼物事件，但不能用于本路线。

### 13.3 单独标注（不用总分掩盖）

| 维度 | 评价 |
| --- | --- |
| 技术可行性 | **高**（匿名 HTTP 已实测；Node 零依赖可实现） |
| 维护风险 | **中高**（未公开 H5 接口、无维护库、可能加签/改版） |
| 平台规则风险 | **高**（H5 域名 robots `Disallow: /`；条款未审） |
| 预计开发难度 | **中**（HTTP + SSR 解析 + 监控 + 映射；无需 protobuf/浏览器） |
| 证据可信度 | **高**（126 条真实消息、5 个房间、多轮；但仅 1 天、无跨日身份） |
| 长期画像限制 | **重大未决**：跨场稳定 ID 未验证；若失败，长期画像不能按 `kuaishou:<id>` 建 |

---

## 14. 最终决策建议

### 14.1 结论：**B — 有条件进入 G1**

理由：

1. **实时公开聊天可行**：已用真实公开直播间验证，免登录、无 Cookie、无签名、无浏览器。
2. **昵称可得**：100%。
3. **数字 userId 可得**：100%，形态像账号级 ID；但**跨场/跨日稳定性未验证**。
4. **开播检测可行**：公开 SSR 的 `liveStream.id` 已验证；真实下播转换未验证。
5. **礼物/互动不可得（匿名路线）**：属于可选增强，不否决平台。
6. **平台规则风险高**：H5 域名 robots 全站拒绝普通 agent；产品化前必须做合规判断。

**不是 A**：稳定 ID 与真实下播转换未验证，且 robots/条款风险未解决。
**不是 C**：匿名实时聊天确实可用，且有 126 条真实证据；不应因“没有 WebSocket”或“没有礼物”而否定。
**不是 D**：存在合法可研究的公开路径，不是“完全无法接入”。

### 14.2 进入 G1 的前置条件（硬门槛）

1. **合规判断**：用户/法务明确回答“LiveMemory 是否可以自动访问 `livev.m.chenzhongtech.com` 的公开 H5 feed”。
   若答案为否 → 立即降为 **C**，不写生产代码。
2. **不登录**：G1 不得引入账号、Cookie、扫码、浏览器中继、签名服务。
3. **不绕过**：若平台对 feed 加签名/验证码/风控，停止并记录，不规避。
4. **低频**：单房间 3 秒；并发不超过 3 房间；长测前先做 10 分钟试跑。
5. **不落地原文**：G1 研究脚本不持久化聊天原文/昵称/头像；只记聚合。

### 14.3 若合规不通过

保留本报告与实验脚本，标记 **C（暂缓）**，等待：
- 平台开放官方公开聊天 API；或
- 出现许可证兼容、免登录、可维护的新实现；或
- 用户明确接受“登录后桌面 WS”的另一条产品路线（需单独 G0，不属本轮）。

---

## 15. 如果进入 G1：下一阶段验证什么

### G1-A 跨场稳定身份（最高优先级）

- 选择 2 个不同直播间，连续观察 ≥2 天；记录同一 `userId` 是否在不同房间/不同日期出现。
- 统计：有 `userId` 的消息占比、同一 `userId` 的昵称变化次数、跨房间映射成功率。
- 判定：
  - 若同一 `userId` 跨房间/跨日稳定 → 可用 `kuaishou:<userId>`。
  - 若只在单场稳定 → 只能作场次内 ID，长期画像降级；文档/UI 明确写“昵称不是身份”。
- 不得用昵称 hash 伪造稳定 ID。

### G1-B 真实开播/下播

- 观察至少 1 次真实 `在播 → 下播 → 再开播`（最好 2 次）。
- 验证：页面 SSR 的 `liveStream.id` 消失/出现；feed 404/恢复；自动停止/自动开始；下播确认不被单次抖动误判。
- 验证多频道：≥2 个离线目标等待 + 1 个在播目标，互不串台。
- 验证重启恢复：重启服务后目标仍 enabled/waiting/recording。

### G1-C 长时稳定性与限流

- ≥2 小时、≥3 个真实在播房间并发；记录 429/`result:2`/超时/断线/重连。
- 记录每房间消息数、延迟 p50/p95、空轮询比例、cursor 失效行为。
- 高聊天率房间（>10 条/3 秒）测截断/丢失；与官方页面可见聊天做 10 分钟人工对照，估算覆盖率。
- 10 房间并发另做，不默认开启。

### G1-D 消息完整性与去重

- 无消息 ID：测量“同用户+同毫秒+同内容”碰撞率；验证 cursor 重放/重复投递。
- 模拟断网 30 秒、进程重启、cursor 丢失；明确“重启期间可能漏消息”。
- 对照官方页面：随机抽取 10 分钟，统计 feed 条数 vs 页面可见条数。

### G1-E 礼物与互动

- 确认匿名 feed 是否永远只有 `comment`（多房间、多时段）。
- 若确认无礼物：标 `NOT-OBSERVED`/“该路线不提供”，不阻塞平台准入。
- 不为了礼物引入登录；如用户坚持要礼物，另立 G0（登录路线），不与本路线混合。

### G1-F 实现形态

- 在 `research/kuaishou-g0/` 写零依赖 Node 原型：
  - `link.mjs`：解析 `live.kuaishou.com/u/<eid>`、裸 eid、分享链接；拒绝非直播。
  - `status.mjs`：SSR `liveStream.id` 检测。
  - `feed.mjs`：HTTP 轮询 + cursor + 指数退避 + 3 秒节奏。
  - `mapper.mjs`：canonical event 映射（chat；`external_id=null`；`viewer_uid=userId`）。
  - `probe` 脚本：只输出聚合，不落原文。
- 不接入 `src/platforms/`；不改路由/UI/数据库。

### G1 退出判据

- 通过：跨场身份稳定 + 真实开播/下播 + ≥2 小时稳定 + 覆盖率可接受 + 合规通过 → 可讨论 G2。
- 不通过：身份不稳定或合规不允许 → 回到 C；不得用“先上线再说”降低标准。

---

## 16. 附录

### 16.1 关键源码/文档引用

| 主题 | 链接 |
| --- | --- |
| catbus 仓库 | https://github.com/cv-cat/catbus |
| catbus `live.ts`（protobuf/feed） | https://github.com/cv-cat/catbus/blob/master/src/platforms/kuaishou/web/live.ts |
| catbus `commands.ts`（`liveListen` 登录要求） | https://github.com/cv-cat/catbus/blob/master/src/platforms/kuaishou/web/commands.ts |
| catbus `api.ts`（`websocketInfo` 认证 Cookie） | https://github.com/cv-cat/catbus/blob/master/src/platforms/kuaishou/web/api.ts |
| catbus `client.ts`（`result=2` 风控映射） | https://github.com/cv-cat/catbus/blob/master/src/platforms/kuaishou/web/client.ts |
| KuaiShou-Spider | https://github.com/cv-cat/KuaiShou-Spider |
| KuaiShou-Spider `live_api.py` | https://github.com/cv-cat/KuaiShou-Spider/blob/master/ks_apis/live_api.py |
| KuaiShou-Spider `live_proto.py` | https://github.com/cv-cat/KuaiShou-Spider/blob/master/utils/live_proto.py |
| KuaiShou-Spider issue #4（限流） | https://github.com/cv-cat/KuaiShou-Spider/issues/4 |
| UniBarrage | https://github.com/BarryWangQwQ/UniBarrage |
| UniBarrage `kuaishou.go` | https://github.com/BarryWangQwQ/UniBarrage/blob/main/kuaishou/kuaishou.go |
| UniBarrage LICENSE（GPL+商业限制） | https://github.com/BarryWangQwQ/UniBarrage/blob/main/LICENSE |
| UniBarrage issue #5（快手失效） | https://github.com/BarryWangQwQ/UniBarrage/issues/5 |
| ykaiqx/Live-Barrage | https://github.com/ykaiqx/Live-Barrage |
| ykaiqx `Kwai/barrage.py`（H5 feed） | https://github.com/ykaiqx/Live-Barrage/blob/main/Kwai/barrage.py |
| Superheroff/kuaishou_websocket | https://github.com/Superheroff/kuaishou_websocket |
| Superheroff `main.py`（Playwright 登录） | https://github.com/Superheroff/kuaishou_websocket/blob/master/main.py |
| atvkh/kuaishou-live-mate | https://github.com/atvkh/kuaishou-live-mate |
| atvkh `danmu.py`（Playwright 拦截） | https://github.com/atvkh/kuaishou-live-mate/blob/main/src/danmu.py |
| BarrageGrab | https://github.com/wushuaihua520/BarrageGrab |
| AI-Vtuber | https://github.com/Ikaros-521/AI-Vtuber |
| simple-live-kuaishou | https://github.com/xuanxuan123xuan/simple-live-kuaishou |
| furryup-live-connect | https://github.com/frostynight-furry/furryup-live-connect |
| py-wuhao/ks_barrage | https://github.com/py-wuhao/ks_barrage |
| 快手直播 robots | https://live.kuaishou.com/robots.txt |
| H5 robots | https://livev.m.chenzhongtech.com/robots.txt |

### 16.2 本轮实验脚本

| 文件 | 用途 | 是否运行 |
| --- | --- | --- |
| `research/kuaishou-g0/feed-probe.mjs` | 匿名 H5 feed 轮询、字段/延迟/重复/事件统计 | 是（多轮） |
| `research/kuaishou-g0/cdp-probe.mjs` | 匿名浏览器 CDP 观察（WebSocket 帧） | 否（DSH 沙箱阻止 Chromium） |

两个脚本都只使用 Node 内置模块，不写聊天原文。

### 16.3 复现命令

```bat
node research/kuaishou-g0/feed-probe.mjs --room <主播ID> --seconds 60
node research/kuaishou-g0/feed-probe.mjs --live-stream-id <liveStreamId> --seconds 180
node research/kuaishou-g0/feed-probe.mjs --top --seconds 60
node research/kuaishou-g0/cdp-probe.mjs --room <主播ID> --seconds 35
```

> 复现时请遵守：低频、公开直播间、不登录、不发送消息、不保存原文/昵称/头像。

### 16.4 本轮未做

- 未新增 `src/platforms/kuaishou/`。
- 未修改路由、UI、数据库、监控生产代码。
- 未改版本号、未改 v0.16.0 Tag/Release/EXE。
- 未引入运行时依赖、未复制第三方代码。
- 未 Push、未 Merge main、未创建 Tag/Release。
- 未做真实礼物/点赞/关注/进入事件验证。
- 未做跨日身份验证、真实下播转换、10+ 房间并发。
