# 快手（Kuaishou）第七平台候选 — G1.5 匿名 H5 + 登录 WebSocket 双模式验证与实施准备

状态：**G1.5 执行完成（2026-11-17）· 结论 D（暂缓，不进入 G2）**
调查基线：`kuaishou-g1` 分支 `83a2c30`（工作区干净）· 本轮分支 `kuaishou-g1_5`（未 Push）
本轮范围：合规审查、一次真实的浏览器外扫码登录、受控的 WebSocket token 尝试、独立研究原型与测试、文档。
**未接入快手、未改六个平台生产代码、未改版本号、未 Push/Merge/Tag/Release。**

> 证据标注：
> **[实测]** 本轮亲自发起请求/解析响应；**[源码]** 亲自阅读第三方或本仓库源码；
> **[文档]** 官方页面/协议/条款原文，未逐条法律解释；**[未执行]** 本轮没有执行且原因明确；
> **[未验证]** 有线索但证据不足，必须由下一次实验回答。
> 功能标注：**REAL-VERIFIED / CODE-SUPPORTED / DOCUMENTED / SIMULATED / NOT-OBSERVED / UNSUPPORTED**。

---

## 0. 结论速览（先回答用户最关心的 12 个问题）

| # | 问题 | 答案 | 依据 |
| --- | --- | --- | --- |
| 1 | 匿名 H5 是否适合正式发布？ | **不适合** | 官方《用户服务协议》明文禁止机器人/蜘蛛监视、复制；H5 域名 `robots.txt` 为 `Disallow: /`（§3） |
| 2 | 正常扫码登录是否真实成功？ | **是，REAL-VERIFIED** | 无签名完成 QR→扫码→确认→callback→passToken→直播站换票→userLogin，全部 `result:1`（§4） |
| 3 | 登录后是否能够监听其他公开主播？ | **未验证** | 唯一一次 `websocketinfo` 返回 `result:2`，但使用了 7 分钟前的 `liveStreamId`，目标随后确认已下播，不能据此判定（§5） |
| 4 | WebSocket 是否收到真实弹幕？ | **否（NOT-OBSERVED）** | 没有拿到 token，未建立 WS 连接 |
| 5 | 是否收到真实礼物？ | **否（NOT-OBSERVED）** | 同上；礼物只是协议字段 CODE-SUPPORTED（§8） |
| 6 | 观众 ID 是否跨场稳定？ | **未证明** | H5 229 用户跨 3 房间重叠 0；WS 无样本；不能从“格式像账号 ID”推断（§7） |
| 7 | 两种模式能否共用长期画像？ | **不能** | 命名空间未证明一致；原型强制 `h5:` / `ws:` 隔离，只有显式证据才能链接（§7） |
| 8 | 哪条路线更适合默认使用？ | **都不是** | H5 授权不允许；WS 未验证且登录不应成为使用前提 |
| 9 | 双模式能否同时进入正式开发？ | **不能** | 两条路线都缺关键前置（§13） |
| 10 | 如果不能，具体还缺什么？ | 见 §12.1 | 平台书面许可；WS token 受控验证；跨场身份；礼物/开播真实样本；长测 |
| 11 | 是否推荐进入 G2？ | **否，D（暂缓）** | 见 §13 |
| 12 | Git 状态与测试结果？ | 见 §14 | 分支 `kuaishou-g1_5`；原型测试 **10/10**；无 `src/` 变更 |

**一句话结论：** 本轮把“扫码登录能不能干净地做成”这件事解决了——**能，而且已经真实跑通到直播站票据**；
但把“登录后能不能拿到直播弹幕 token”这件事**没有解决**（唯一一次尝试被自己的旧 `liveStreamId` 污染，不能算证据），
而匿名 H5 已经被官方条款明确禁止。因此**现在既不能发布匿名默认模式，也不能声称登录模式可用**，两条路线都不进入 G2。

---

## 1. 本轮最重要的五个新发现

1. **匿名 H5 的正式使用条件被官方条款否掉，而不是只被 robots 否掉 [文档]**。
   本轮从快手官方“法律声明”页背后的 CMS 接口取到了《快手软件许可及服务协议》全文（中文版，id=14）与
   《快手直播服务协议》（id=23）。前者明确写：
   - 七、1.1 不得使用“未经快手授权或许可的任何插件、外挂、系统或第三方工具”干扰平台运行；
   - 七、1.4 不得对“客户端与服务器端的交互数据”进行获取、复制，形式包括“插件、外挂、群控或非经快手授权的第三方工具/服务接入”；
   - 八、1 未经**书面许可**，不得复制、读取、采用平台信息内容，或以其他方式非法获取；
   - 十、1 未经许可，“任何人不得擅自使用与转让（包括但不限于通过任何机器人、蜘蛛等程序或设备监视、复制、传播、展示、镜像、上载、下载本软件及相关服务中的内容）”。

   这比 G0/G1 的 `robots.txt` 信号更强：不是“未声明允许”，而是**明文禁止**。因此 H5 不能作为正式默认采集器（§3）。

2. **浏览器外、无签名的官方扫码登录已经端到端真实成功 [实测]**。
   `qr/start`（无 Cookie、无签名）→ 真人扫码 → `scanResult=1` → `acceptResult=1` → `callback` 下发 `passToken`
   → 直播站 `getCdns=1`、`passToken` 换票 `result=1`、拿到 `kuaishou.live.web.at`
   → `userLogin` `result=1`、拿到 `kuaishou.live.web_st/_ph`。
   全过程**没有**实现 `__NS_hxfalcon`、设备指纹、webweapon、验证码求解或 TLS 伪装（§4）。

3. **登录态的 `websocketinfo` 仍然返回 `result:2`，但这次尝试不足以证明“签名是唯一障碍” [实测 + 自我纠错]**。
   18:41 的调用确实带着有效的直播站会话，但 `liveStreamId` 来自 18:34 的发现结果；
   18:44 复核时该直播间已不在 48 个在播房间中（已下播）。
   **因此 `result:2` 可能是“房间已结束/旧 ID”，也可能是“缺少签名/风控 cookie”，两者本轮无法区分**（§5）。
   这是本轮最重要的方法学教训：**token 调用前必须重新确认直播间在播，不能复用旧的 `liveStreamId`**。

4. **协议字段事实比 G1 更完整：登录 WS 的 feed 本身带 `id` [源码/协议定义]**。
   `WebCommentFeed.id=1`、`WebGiftFeed.id=1`、`WebLikeFeed.id=1` 等都在 web 端消息定义里。
   G1 说“登录 WS 没有消息 ID”只对 catbus 的 canonical event 成立，对**原始协议**不成立；
   但本轮没有真实帧，所以只能标 **CODE-SUPPORTED / NOT-OBSERVED**（§8）。

5. **发现并修复了一个会制造“假下播”的状态检测缺陷 [实测 + 单测]**。
   `live_api/home/list` 不保证返回顶层 `result`；旧实现把 `undefined` 交给错误分类器，
   导致明明是 48 个在播房间的成功响应被判为 `UPSTREAM`。已修复并加了回归测试（§9）。

---

## 2. 双模式架构设计

### 2.1 设计目标与硬边界

| 目标 | 设计 |
| --- | --- |
| 匿名 H5 默认 | **仅在产品获得平台书面许可后才允许**；当前代码在构造时直接抛 `POLICY_BLOCKED` |
| 登录 WS 可选增强 | 用户主动扫码；不静默登录；凭据只进本地加密库（G2 才做） |
| 两种模式独立初始化 | 各自 transport、连接状态、session、停止操作 |
| 统一事件格式 | 都经 `KuaishouEventNormalizer` 输出 canonical event |
| 身份隔离 | `kuaishou:h5:<id>` 与 `kuaishou:ws:<principalId>` 永不自动合并 |
| 错误分类 | `NETWORK/TIMEOUT/HTTP/RATE_LIMITED/AUTH_REQUIRED/RISK_CONTROL/OFFLINE/NOT_FOUND/UPSTREAM/UNSUPPORTED/POLICY_BLOCKED/STOPPED` |
| 断线恢复 | 独立退避；WS 带 `reconnectCount`；H5 带 cursor 与指纹去重 |
| 不重复记录 | WS 优先用 feed `id`；H5 无 ID，退化到 `userId+time+content` 指纹 |
| 能力如实标注 | UI/文档按 `REAL-VERIFIED / CODE-SUPPORTED / NOT-OBSERVED / UNSUPPORTED` 显示 |

### 2.2 逻辑模块（已落地为研究代码）

```text
research/kuaishou-g1_5/
  probe.mjs                  CLI：policy / rooms / status / h5 / login / selftest / cleanup
  lib/
    link.mjs                 直播间 URL/裸 ID 解析；拒绝主页、短视频、回放
    status.mjs               KuaishouLiveStatusDetector（home/list，识别限流，不把限流当下播）
    h5-transport.mjs         AnonymousH5Transport（默认 POLICY_BLOCKED，需显式承认才可运行）
    ws-transport.mjs         AuthenticatedWebSocketTransport（连接/心跳/重连/停止）
    ws-protocol.mjs          信封、进房/心跳/退出帧、feed 解码（自有实现）
    protobuf.mjs             最小 protobuf wire codec（无第三方库）
    normalize.mjs            KuaishouEventNormalizer（调用生产 `normalizeEvent` 校验）
    identity.mjs             KuaishouIdentityMapper（命名空间 + 证据链接）
    login.mjs                浏览器外扫码登录、直播站换票、websocketinfo
    errors.mjs               错误分类与业务码映射
    http.mjs                 fetch 封装、CookieJar（仅内存）、可取消 sleep
  tests/prototype.test.mjs   10 个离线单测（不访问网络）
  scan.html                  真人扫码用的大图页面（自动换码）
  README.md                  用法、边界、复现
```

### 2.3 模式切换与状态机

```text
                 ┌──────────── 用户输入直播间 URL/ID ────────────┐
                 │                                              │
        [默认] 匿名 H5（仅获书面许可后）              [可选] 扫码登录 WS
                 │                                              │
     POLICY_BLOCKED（当前）                           QR → scanned → accepted
                 │                                              │
     需 acknowledgePolicy=true                        passToken → live ticket
                 │                                              │
        polling(cursor)                                 websocketinfo(token)
                 │                                              │
   live ⇄ reconnecting ⇄ rate_limited                   connecting ⇄ reconnecting
                 │                                              │
             ended(601)                                    connected(feed push)
                 │                                              │
              stopped                                        stopped / failed
```

- **停止**：`stop()` 取消 sleep/心跳；WS 停止时发送 `CS_USER_EXIT` 并关闭 socket，H5 只取消轮询。
- **资源清理**：心跳 `setInterval` 在 `finally` 中清除；无全局单例；无残留连接。
- **错误分类**：`result:2` → `RATE_LIMITED`（可重试，但对 `websocketinfo` 同时可能意味着风控）；
  `601` → `OFFLINE`（结束本场，不重试）；`109` → `AUTH_REQUIRED`；未知码 → `UPSTREAM`。
- **身份**：normalizer 的 `viewer_uid` 在进入 canonical 模型前就带命名空间前缀，
  生产侧 `buildViewerId('kuaishou', 'h5:123')` 得到 `kuaishou:h5:123`，**不可能与 `ws:` 自动合并**。

### 2.4 能力矩阵（本轮真实状态）

| 能力 | 匿名 H5 | 登录 WS |
| --- | --- | --- |
| 直播间 URL/ID 解析 | REAL-VERIFIED（单测） | 同左 |
| 在播状态检测 | REAL-VERIFIED（48 房间；限流/空列表不判下播） | 同左（登录不改变检测） |
| 实时聊天 | REAL-VERIFIED（G1：555 条/2h/3 房间）但 **POLICY-BLOCKED** | 未建立连接（NOT-OBSERVED） |
| 观众昵称 | REAL-VERIFIED 100% | CODE-SUPPORTED（`userName`） |
| 稳定观众 ID | 字段 100%，跨场未证明 | CODE-SUPPORTED（`principalId`），无样本 |
| 消息 ID | UNSUPPORTED（0%） | 协议有 `id`，**未观测** |
| 礼物 | UNSUPPORTED | CODE-SUPPORTED，未观测 |
| 点赞/分享 | UNSUPPORTED | CODE-SUPPORTED，未观测 |
| 开播/下播监控 | 检测器已实现并有真实“消失=下播”观察；未接生产 | 同左 |
| 多房间 | REAL-VERIFIED（G1 3 房间） | 未验证 |
| 断线恢复 | REAL-VERIFIED（G1 本地暂停；无续传保证） | 代码支持（未真实断线） |
| 自动重连 | CODE-SUPPORTED + 单测 | CODE-SUPPORTED + 单测 |
| 礼物金额 | UNSUPPORTED | 无本币金额 → `amount_minor=null` |
| 长期画像 | 不允许（身份未证明 + 授权不允许） | 不允许（身份未证明） |

---

## 3. 匿名 H5 的正式使用条件审查

### 3.1 `robots.txt`（2026-11-17 18:24 实测）

| 主机 | 内容 | 含义 |
| --- | --- | --- |
| `livev.m.chenzhongtech.com`（H5 feed） | 513 字节；白名单 Baiduspider/Googlebot/bingbot/GPTBot/deepseekbot 等 `Allow: /`；**`User-agent: *` → `Disallow: /`** | 对普通自动化客户端**明确拒绝** |
| `live.kuaishou.com`（桌面直播站） | 278 字节；只有若干搜索引擎的 `Allow`；**没有 `User-agent: *` 组** | 没有通配规则 **不等于**授权自动访问；只是 robots 未禁止 |

`robots.txt` 是爬虫约定，不是 API 许可，也不能替代服务条款。H5 的问题在于**两者都不利**。

### 3.2 官方服务条款（原文摘录，2026-11-17 取得）

取得方式：官方“法律声明”页 `https://www.kuaishou.com/about/policy` 的 iframe 指向
`app.m.kuaishou.com` 的 CMS；通过其公开内容接口 `POST /rest/w/cms/detail {"id":14}` 与 `{"id":23}`
取到中文全文（分别为 33,742 与 27,620 字符的 HTML）。以下为原文摘录，不做法律解释。

**《快手软件许可及服务协议》（id=14）**

- 七、用户行为规范 1.1：
  > 使用未经快手授权或许可的任何插件、外挂、系统或第三方工具对快手软件及相关服务的正常运行进行干扰、破坏、修改或施加其他影响。
- 七、1.4：
  > 对快手软件或快手软件运行过程中释放到任何终端内存中的数据、软件运行过程中客户端与服务器端的交互数据，以及快手软件运行所必需的系统数据，进行获取、复制、修改、增加、删除、挂接运行或创作任何衍生作品，形式包括但不限于使用插件、外挂、群控或非经快手授权的第三方工具/服务接入快手软件和相关系统。
- 八、数据使用规范 1：
  > 未经快手书面许可，用户不得自行或授权、允许、协助任何第三方对快手软件及相关服务中信息内容进行如下行为：
  > 1.1 复制、读取、采用快手软件及相关服务的信息内容，用于包括但不限于宣传、增加阅读量、浏览量等商业用途；
  > … 1.4 其他非法获取快手软件及相关服务的信息内容的行为。
- 十、知识产权 1：
  > 未经快手许可，任何人不得擅自使用与转让（包括但不限于通过任何机器人、蜘蛛等程序或设备监视、复制、传播、展示、镜像、上载、下载本软件及相关服务中的内容）。

**《快手直播服务协议》（id=23）**

- 五、数据和隐私 2：
  > 为向您提供直播服务所需，您同意快手平台收集、记录、存储或与关联公司共享……您认可，快手对您使用直播服务开展网络直播活动所形成的数据信息享有整体上的财产性权益。

### 3.3 官方接口 / 合作 / 开发者路径

| 路径 | 本轮核实 | 能否读取任意直播间聊天 |
| --- | --- | --- |
| `open.kuaishou.com` | 快手开放平台，页面为「快手小程序文档」 | **不能**（小程序/开放能力，不是直播聊天 API） |
| `liveopen.kuaishou.com` | 「快手云直播 / 直播开放平台」，标题写明 OBS 直播、拉流直播、推流地址 | **不能**（推流/拉流服务，不是聊天读取） |
| 官方开发者文档中的直播聊天 | 未发现面向普通开发者的“读取任意直播间聊天”能力 | **未发现** |
| 商务合作 / 平台授权 | 未申请、未联系 | **未知**；需要快手书面许可 |

**没有找到“功能相当、访问条件更明确”的替代公开接口。** TikTok 式的匿名 webcast 在本轮没有被发现于快手；
UniBarrage 的匿名移动 token 路线在 G0 已实测失效（`result:2`）。

### 3.4 四个必须分开的判断

| 维度 | 判断 |
| --- | --- |
| 技术上能够访问 | **能**：G1 已真实采集 555 条/2h/3 房间；本轮未再请求 H5 feed |
| 平台是否允许自动访问 | **不允许（未获书面许可）**：条款明文禁止机器人/蜘蛛监视、复制；H5 robots `Disallow: /` |
| 开源项目代码是否允许复用 | G1 已审：catbus MIT（可复用但有边界）、KuaiShou-Spider 无许可证（禁止）、UniBarrage GPL+限制（禁止）；本轮未复制任何代码 |
| LiveMemory 是否适合公开分发该功能 | **不适合**：会向所有用户分发一个被平台条款明文禁止的自动采集器，且无法用“本地运行”规避平台规则 |

### 3.5 本轮决定

1. **H5 标记 `POLICY-BLOCKED`，不得作为正式默认采集器。**
2. **不再发起新的 H5 feed 请求**；保留 G1 的 555 条/2h/3 房间真实结果作为研究证据。
3. 研究代码保留，但 `AnonymousH5Transport` 在构造时**默认抛错**，必须显式 `acknowledgePolicy: true`
   才能用于复现；CLI 还需 `--acknowledge-blocked`。
4. 只有出现**快手书面许可/合作**，才重新评估 H5；仅靠“页面公开可见”“匿名可访问”不构成许可。

---

## 4. 正常扫码登录验证（REAL-VERIFIED）

### 4.1 方法与边界

- 二维码由**本机进程**调用官方 `POST /rest/c/infra/ks/qr/start` 生成；PNG 只写到
  `research/kuaishou-g1_5/.state/qr.png`，供用户在电脑屏幕上用快手 App 扫描。
- 会话（Cookie / passToken / authToken）**只在内存**；进程退出即丢失；未写 `session.json`，未打印任何凭据。
- 未实现、未调用：`__NS_hxfalcon` / `__NS_sig3`、gdfp/webweapon 设备指纹、滑块求解、
  TLS/JA3 伪装、付费签名、第三方中继。
- 全程只做登录与只读查询；**没有发送任何弹幕、点赞、礼物或关注**。

### 4.2 真实时间线（2026-11-17，Asia/Shanghai）

| 时间 | 步骤 | 结果 | 证据等级 |
| --- | --- | --- | --- |
| 18:35:15 | `qr/start`（无 Cookie、无签名） | `result:1`，返回 `qrLoginToken`、`qrLoginSignature`、base64 PNG（125×125，JPEG） | REAL-VERIFIED |
| 18:35–18:41 | 未扫码，二维码约 58 秒过期，自动换码 3 次 | `scanResult=707`，每次换新码 | REAL-VERIFIED（过期行为） |
| 18:41 左右 | 用户用快手 App 扫码并在手机确认 | `scanResult=1` | **REAL-VERIFIED（真人扫码）** |
| 18:41:5x | `acceptResult` | `result:1`，返回 `qrToken` | REAL-VERIFIED |
| 18:41:5x | `/pass/kuaishou/login/qr/callback` | 返回 `passToken`（正文/Set-Cookie） | REAL-VERIFIED |
| 18:41:5x | `POST /pass/kuaishou/getCdns` | HTTP 200，`result:1` | REAL-VERIFIED |
| 18:41:5x | `POST /pass/kuaishou/login/passToken`（`sid=kuaishou.live.web`） | `result:1`，下发 `kuaishou.live.web.at` | **REAL-VERIFIED（决定性）** |
| 18:41:59 | `POST /live_api/baseuser/userLogin` | `result:1`，Set-Cookie 下发 `kuaishou.live.web_st`、`kuaishou.live.web_ph` | **REAL-VERIFIED** |
| 18:41:59 | `GET /live_api/liveroom/websocketinfo?liveStreamId=w_sQwbdws3c` | HTTP 200，`data.result=2`，无 token、无 URL | **NOT-OBSERVED / 结果受污染** |

会话 Cookie 名称（**只有名字，没有值**）：`did`、`userId`、`passToken`、`kuaishou.live.web_st`、`kuaishou.live.web_ph`。
**没有** `kwfv1`、`kwscode`、`kwssectoken`、`kwpsecproductname` 这些 webweapon 防刷 Cookie——
因为本轮没有执行官方 kws/kwf 脚本，也没有生成设备指纹。

### 4.3 这证明了什么、没证明什么

**证明了：**

- 官方 QR 登录在**纯 HTTP、无浏览器、无签名**的条件下可以完成到“直播站已登录”；
- 直播站换票（passToken → `*.at` → `userLogin` → `live.web_st/_ph`）不要求 `__NS_hxfalcon`；
- 用户主动扫码 + 本地进程持有会话是可行的产品形态（凭据保护、退出登录见 §12）。

**没证明：**

- 登录后能否拿到 `websocketinfo` token（§5）；
- 能否监听其他公开主播；
- 能否收到真实弹幕/礼物；
- 会话过期/重新授权/服务端登出的真实行为；
- 登录是否等于平台允许自动采集——**不等于**（§3、§11）。

### 4.4 二维码行为

- 服务端 `expireTime` 约 **58 秒**，不是 G1 推测的 600 秒；未扫码会 `707`，必须换码。
- 扫码后**不能**再换码；手机上取消会返回 `711/712`。
- 为便于真人操作，研究目录提供 `scan.html`：460×460 大图，每 3 秒加载最新码。

---

## 5. 登录态 WebSocket token：一次被污染的尝试与正确复测方案

### 5.1 发生了什么

- 18:34 用匿名 `home/list` 发现 48 个在播房间，选中 `3xetq2fy4tgmiv9`（`watching=1840`，`liveStreamId=w_sQwbdws3c`）。
- 18:35–18:41 完成扫码登录。
- 18:41:59 直接用 **18:34 的** `liveStreamId` 调 `websocketinfo` → `result:2`、无 token、无 URL。
- 18:44 复核：该 `eid` **已不在** 48 个在播房间中（`state=offline`）。

### 5.2 为什么不能据此下结论

`websocketinfo` 需要**当前有效**的 `liveStreamId`。本轮在调用前没有重新确认直播间仍在直播
（状态检测器当时还有 §9.1 的缺陷，返回了 `unknown`），因此 `result:2` 至少有四种解释：

| 假设 | 支持证据 | 反证/缺口 |
| --- | --- | --- |
| A. 缺少 `__NS_hxfalcon` 签名 | catbus 对 `websocketinfo` 总是签名；G0 匿名请求也是 `result:2` | 没有登录态+当前 liveStreamId 的对照 |
| B. 缺少 webweapon 防刷 Cookie（`kwfv1`/`kwscode`/`kwssectoken`） | 本轮会话确实没有这些 Cookie | 它们由官方脚本生成，属于禁止的设备指纹路径 |
| C. IP/接口短时风控 | 同一时段多次请求；G1 也遇到 `result:2` | 18:43 `home/list` 仍返回 48 个房间，说明不是全站限流 |
| D. 目标已下播/旧 liveStreamId | 18:44 复核已 offline；ID 来自 7 分钟前 | 18:41 当时是否已下播**没有证据** |

**因此本轮把“登录后监听”标为 `NOT-OBSERVED` / 未验证，而不是 `BLOCKED` 或“平台拒绝”。**
这符合用户的要求：不能把“尚未验证”误判为“协议不可用”。

### 5.3 正确的复测（一次扫码，约 2 分钟）

已把方法缺陷修进代码（`probe.mjs`）：

- 登录后**重新**调用 `home/list`，只有 `state=live` 才使用其 `liveStreamId`；
- 如果只有旧的 `--live-stream-id`，默认**拒绝**调用 `websocketinfo`（`live_id_not_confirmed`）；
- 需要显式 `--allow-stale-live-id` 才能做对照实验，且结果不能用于证明 token 接口行为；
- `--probe` 会在同一会话下依次探测 `livedetail`、`home/list`、`gift-list`，20 秒后再试一次 `websocketinfo`，
  用于区分“整站限流”与“该接口要签名”。

复测命令：

```bat
node research/kuaishou-g1_5/probe.mjs login --room <在播主播ID> --wait 600 --listen 120 --probe
```

判读：

| 结果 | 结论 |
| --- | --- |
| 立刻拿到 token + URLs，WS 收到真实弹幕 | 登录 WS 技术可行 → 仍需平台授权才能产品化 |
| `result:2`，但 `livedetail/gift-list` 正常、房间确认在播、20 秒后仍 `2` | 该接口需要签名/风控 Cookie → 在“不绕过访问控制”边界内**不可用** |
| 所有直播接口都 `2` | 当前 IP 被限流 → 等冷却后重试，不作结论 |
| 房间在调用前已下播 | 换一个在播房间重做，不作结论 |

---

## 6. catbus：可复用与不可复用

仓库：[cv-cat/catbus](https://github.com/cv-cat/catbus)（TypeScript，MIT，2026-11-17 仍活跃）。
本轮**没有复制任何代码**，只把协议事实写进自有实现。

### 6.1 可以借鉴的“协议事实”

| 事实 | 用途 | 本轮处理 |
| --- | --- | --- |
| `SocketMessage{payloadType=1, compressionType=2, payload=3}` | 信封编解码 | 自有 `protobuf.mjs` + `ws-protocol.mjs` |
| `CS_ENTER_ROOM=200 / CS_HEARTBEAT=1 / CS_USER_EXIT=202 / SC_ENTER_ROOM_ACK=300 / SC_FEED_PUSH=310` | 帧类型 | 自有常量 |
| `CSWebEnterRoom{token=1, liveStreamId=2, reconnectCount=3}` | 进房 | 自有编码器 + 单测 |
| `SCWebFeedPush{commentFeeds=5, likeFeeds=8, giftFeeds=9, systemNoticeFeeds=11, shareFeeds=12}` | 事件 | 自有解码器 + 单测 |
| `WebCommentFeed{id=1, user=2, content=3, time=9}`、`SimpleUserInfo{principalId=1, userName=2, headUrl=3}` | 弹幕/身份 | 自有解码器 + 单测 |
| `WebGiftFeed{id=1, user=2, time=3, giftId=4, batchSize=7, comboCount=8}` | 礼物 | 自有解码器；金额留空 |
| 指数退避、`reconnectCount`、心跳间隔取 ACK | 重连 | 自有 `ws-transport.mjs` |
| 任意 `eid` 解析、`roomState` 取 `liveStreamId` | 多房间 | 自有 `link.mjs`/`status.mjs` |

### 6.2 明确不可复用

| 机制 | catbus 位置 | 为什么不能进 LiveMemory |
| --- | --- | --- |
| `__NS_hxfalcon` / `__NS_sig3` 纯算 | `sign.ts` | 复现平台非公开签名，属于模拟官方客户端/绕过安全机制 |
| 设备指纹 / webweapon / gdfp | `session.ts`、`oracle.ts`、`gdfp.ts` | 伪造设备身份，规避平台风控 |
| 滑块验证码自动求解 | `captcha.ts`、`gap.ts`、`captcha-crypto.ts` | 直接破解验证码，用户明确禁止 |
| `wreq-js` TLS/JA3/JA4 伪装 | 依赖 | 反检测，不是普通 HTTP 客户端 |
| 精确 Cookie 线序、Sentry 头、`kww` | `profile.ts`、`client.ts` | 模拟浏览器指纹；维护成本极高且随时失效 |
| 18 个运行时依赖（WASM/OpenCV/ONNX 等） | `package.json` | 违反零依赖、单 EXE 边界 |

### 6.3 许可证与声明

- catbus 为 MIT；本轮未复制代码，`THIRD_PARTY_NOTICES.md` 只登记“阅读参考”。
- 本轮使用的协议字段号与 AES 信封常量属于**协议事实**（来自 web 端消息定义与官方 bundle），
  已在 `THIRD_PARTY_NOTICES.md` 的 G1.5 附录说明来源；没有引入第三方源码文件或依赖。
- 研究代码全部为本仓库自写，`node --test` 只使用本地夹具。

---

## 7. 稳定观众身份验证

### 7.1 六个问题逐条回答

| # | 问题 | 本轮/既有证据 | 结论 |
| --- | --- | --- | --- |
| 1 | 同一用户在同一场直播内 ID 是否一致 | G1 2 小时：94 个重复发言用户、0 个“同 ID 多昵称” | 运行内**未见异常**；样本仍短 |
| 2 | 同一用户跨不同直播间 ID 是否一致 | G1：229 个独立用户，跨 3 房间重叠 **0** | **无证据**（不能因重叠 0 判不稳定） |
| 3 | 跨不同日期 ID 是否一致 | 没有保存 ID 的历史样本 | **[未执行]** |
| 4 | 改昵称后 ID 是否不变 | 未观察到改名 | **无法证明**；昵称不是身份 |
| 5 | H5 与 WS 的 ID 是否同一命名空间 | H5 `userId` 数字；WS `principalId` 字符串；无同一人两种样本 | **[未验证]，禁止合并** |
| 6 | 是否存在临时/缺失/匿名 ID | H5 样本 100% 有 `userId`；WS 字段可缺失（`user=null`） | H5 未发现缺失；WS 无样本 |

### 7.2 原型如何强制保守

- `normalize.mjs` 在进入 canonical 模型前就把身份写成 `h5:<userId>` / `ws:<principalId>`；
  生产 `buildViewerId('kuaishou', ...)` 得到 `kuaishou:h5:...` 与 `kuaishou:ws:...`，**天然不合并**。
- `identity.mjs` 的 `link()` 必须提供证据 `{kind}` 才允许合并；裸断言直接抛错。
- 单测覆盖：同 ID 跨房间计数、缺失 ID、跨命名空间默认不可合并、证据链接后才可合并。
- `source_quality` 固定为 `unknown`，因为“字段存在”不等于“身份已验证”。

### 7.3 证明身份稳定所需的最小实验（未做）

1. 用**同一个测试账号**在 2 个不同公开直播间各发 1 条弹幕（H5 侧采集 `userId`）→ 证明跨场稳定；
2. 同一天晚些时候再发 1 条 → 证明跨时段稳定；
3. 若登录 WS 可用：同一条弹幕同时被 H5 与 WS 采集 → 证明两条路线命名空间一致；
4. 改一次昵称再发 → 证明昵称变化不影响 ID。

这需要用户授权测试账号与发言行为；本轮**未做**（用户只授权了扫码登录，未授权发弹幕）。

---

## 8. 礼物与互动事件

### 8.1 事件矩阵

| 事件 | 匿名 H5 | 登录 WS（协议） | 本轮证据 |
| --- | --- | --- | --- |
| 普通弹幕 | REAL-VERIFIED（G1，但 POLICY-BLOCKED） | CODE-SUPPORTED | WS 未连接 |
| 昵称 | REAL-VERIFIED 100% | CODE-SUPPORTED（`userName`） | — |
| 稳定 ID | 字段 100%；跨场未证明 | CODE-SUPPORTED（`principalId`） | — |
| 时间戳 | REAL-VERIFIED（毫秒） | CODE-SUPPORTED（`time` uint64） | — |
| 消息 ID | **UNSUPPORTED**（0%） | **字段存在**（`WebCommentFeed.id`）但未观测 | — |
| 礼物 | **UNSUPPORTED** | CODE-SUPPORTED（`giftId`/`batchSize`/`comboCount`/`id`） | **NOT-OBSERVED** |
| 礼物金额/币种 | UNSUPPORTED | 协议无本币金额；`AiDataInfo.unitPrice` 未验证 | `amount_minor=null`、`value_kind=unknown` |
| 点赞 | UNSUPPORTED | CODE-SUPPORTED（无数量） | NOT-OBSERVED |
| 分享 | UNSUPPORTED | CODE-SUPPORTED | NOT-OBSERVED |
| 系统通知 | UNSUPPORTED | CODE-SUPPORTED | NOT-OBSERVED |
| 关注/进入/撤回 | UNSUPPORTED | 协议定义里未发现对应 feed | **UNSUPPORTED**（不实现） |

### 8.2 结论

- 礼物是登录路线相对 H5 的**潜在**优势，但本轮**零真实样本**；只能写 `CODE-SUPPORTED`。
- 没有本币金额时绝不换算收入；G2 若实现礼物，必须 `amount_minor=null`、`currency=null`、`value_kind=unknown`，
  界面显示“金额未知”，**不能显示 0**。
- 点赞/分享没有 canonical 事件类型，原型只计数，不伪造事件；G2 也不应把它们塞进 `chat`。
- 消息 ID：H5 没有；WS 原始 feed 有 `id`，但必须真实帧确认后才能用于幂等去重。

---

## 9. 开播监控

### 9.1 真实信号与一个已修复的缺陷

- `GET https://live.kuaishou.com/live_api/home/list`（匿名）本轮两次返回 **48 个在播房间**（18:34、18:43）。
- 该响应**不保证**带顶层 `result`。旧 `detectLiveStatus()` 把 `undefined` 分类成 `UPSTREAM`，
  导致成功响应被误判为失败——这是本轮发现的真实缺陷，已修复并加回归测试。
- 修复后的规则：
  - 有 `result` 且为 `2` → `RATE_LIMITED`，**绝不判下播**；
  - 有列表且能找到 `eid` → `live` + `liveStreamId`；
  - 有非空列表但找不到 → `offline`（真实观察）；
  - 空列表 → `unknown`（可疑，不判下播）；
  - 网络错误 → `unknown`。
- 18:44 用同一接口复核 `3xetq2fy4tgmiv9` → `offline`（不在 48 个房间中），这是一次真实的“消失=下播”观察。

### 9.2 与生产 `MonitoringManager` 的适配（设计，未实现）

1. `src/monitoring/detectors/kuaishou.mjs`：解析 `live.kuaishou.com/u/<eid>` 与裸 ID；
2. `observeChannel(eid)`：`home/list` 快照 + 缓存；识别限流 → `RATE_LIMITED`；
3. `connectDetected`：**连接前重新确认 live**，用当前 `liveStreamId`；
4. policy 建议：`baseMs=90s`、`requestGapMs≥3s`、`maxConsecutiveFailures=4`；
5. 下播确认：非空列表连续 2 次找不到 + H5 `601`/WS 断开，**排除限流**；
6. 验收必须包含真实 `在播→下播→再开播` 与重启恢复。

**本轮未修改 `MonitoringManager`，也未新增 detector。**

### 9.3 为什么不能把“没有弹幕”当“下播”

G1 的 2 小时长测中 92.5% 轮询为空；低活跃房间可以长时间 0 条。
下播只能由“状态接口 + 明确结束码 + 连续确认 + 排除限流”共同判断。

---

## 10. 稳定性与真实实验

| 实验 | 时间 | 结果 | 证据等级 |
| --- | --- | --- | --- |
| G1 匿名 H5 2 小时 / 3 房间 | 2026-11-17 15:48–17:48 | 555 条 / 229 用户 / 0 重复 / 0 HTTP 错误；`601` 真实下播 | REAL-VERIFIED（但本轮判定 POLICY-BLOCKED，不再复跑） |
| 本轮 `home/list` | 18:34、18:43 | 48 个在播房间 | REAL-VERIFIED |
| 扫码登录 | 18:35–18:41 | 端到端成功到 `userLogin` | **REAL-VERIFIED** |
| `websocketinfo` | 18:41:59 | `result:2`，无 token；旧 live ID，目标随后下播 | **NOT-OBSERVED / 受污染** |
| 房间下播观察 | 18:44 | 不在在播列表 → `offline` | REAL-VERIFIED（消失=下播） |
| WS 长测（2h/3 房间） | — | 未建立连接 | **[未执行]** |
| 真实礼物/点赞/分享 | — | 无样本 | **NOT-OBSERVED** |
| 真实再开播 | — | 窗口内未发生 | **[未执行]** |

**本轮没有跑新的 H5 长测**，因为 §3 已判定该路线不允许；保留 G1 结果，不重复请求受限接口。
**本轮也没有跑 WS 长测**，因为没有拿到 token。

### 10.1 自动化测试

```text
node --test --test-isolation=none research/kuaishou-g1_5/tests/prototype.test.mjs
→ 10 passed / 0 failed
```

覆盖：链接解析、protobuf 编解码、信封/进房/心跳/退出、feed 解码、canonical 映射、身份隔离、
状态解析与限流、H5 策略门禁、H5 去重与 601 结束、WS 连接/ACK/重连、错误分类。

---

## 11. 风险与未解决问题

| 等级 | 问题 | 说明 |
| --- | --- | --- |
| **P0** | 平台授权 | 官方条款明文禁止机器人/蜘蛛监视、复制；无书面许可就不能产品化任何自动采集路线 |
| **P0** | WS token 未验证 | 唯一一次尝试被旧 `liveStreamId` 污染；需要 §5.3 的受控复测 |
| **P0** | 身份未证明 | 跨场/跨日/跨路线都没有证据；长期画像不能建立 |
| **P1** | 签名/指纹诱惑 | 若 `websocketinfo` 确实要求 sig4/webweapon，路线在边界内不可用；不得“临时加一下” |
| **P1** | 消息 ID | H5 无 ID；WS 有 `id` 字段但未观测 |
| **P1** | 礼物/互动 | 零真实样本；金额语义未知 |
| **P1** | 开播监控真实周期 | 只观察到“消失=下播”，未观察“再开播” |
| **P2** | 二维码寿命 | 约 58 秒，必须自动换码；对用户体验有影响 |
| **P2** | 会话过期/登出 | 未真实验证；研究代码只做尽力登出 |
| **P2** | Node WebSocket 无 Origin | 内置 WebSocket 不能设置 `Origin`；若网关要求，需要自研握手（但不得伪装浏览器） |
| **P2** | 限流与假下播 | `result:2` 与空列表必须区分；已在状态检测器处理 |
| **P3** | 数据保留/隐私 | 即使技术可用，聊天原文/昵称/ID 的保存窗口与 AI 上传仍需按 `PRIVACY_SECURITY.md` 设计 |

---

## 12. G2 实施清单（仅在门槛满足后）

### 12.1 进入 G2 的前置门槛（全部满足才可）

- [ ] **G2-GATE-1 平台许可**：快手书面许可/合作，明确允许第三方本地软件读取公开直播间聊天并保存；
- [ ] **G2-GATE-2 WS token**：按 §5.3 复测，确认登录态能在**不实现签名/指纹/验证码**的前提下拿到 token 并收到真实弹幕；
      若确认必须签名 → WS 路线判死，不进入 G2；
- [ ] **G2-GATE-3 身份**：至少证明同一观众跨 2 个直播间 ID 一致；最好再有跨日与 H5/WS 同人证据；
- [ ] **G2-GATE-4 事件**：至少观测到 1 条真实礼物（若有礼物能力）；没有就明确 `NOT-OBSERVED` 并在 UI 隐藏；
- [ ] **G2-GATE-5 稳定性**：≥2 小时、≥3 房间、真实断线恢复、真实下播→再开播；
- [ ] **G2-GATE-6 产品规则**：确认“登录不是使用前提”；若只能登录，需用户明确批准例外。

### 12.2 若走“登录 WS 可选增强”（前提：GATE-1/2/3 通过）

| 模块 | 设计 |
| --- | --- |
| URL/频道 | `link.mjs` 解析 `live.kuaishou.com/u/<eid>`、裸 ID；拒绝主页/短视频/回放 |
| 模式选择 | 默认匿名入口；若匿名被许可则默认匿名，否则**不提供**该平台（而不是强制登录） |
| 扫码入口 | 复用 Bilibili 的 QR 弹窗/轮询；快手返回 PNG，本地显示，不上传 |
| 登录状态 | 显示“未登录/已登录（昵称）/已过期”；不显示 token |
| 凭据 | `EncryptedJsonStore`（AES-256-GCM + 每安装密钥 + 尽力 `icacls`）；一键清除；不写日志/ZIP |
| 会话过期 | `websocketinfo`/`userLogin` 失败 → `AUTH_REQUIRED` → 提示重新扫码；不静默重登 |
| 采集 | 每房间独立 adapter/session；`SessionManager` 禁止同一 `platform+room` 重复启动 |
| 事件 | 只经 `EventIngest`；`external_id = ws:<feed id>`（若真实帧确认）；否则指纹 |
| 身份 | `platform_uid = ws:<principalId>`；`source_quality=unknown` 直到跨场证据；昵称只展示 |
| 礼物 | `gift_id`/名称/数量；金额 `null`/`unknown`；UI 显示“金额未知”，不显示 0 |
| 监控 | 新增 detector；连接前重新确认在播；限流不判下播；连续确认才结束 |
| AI/画像 | 只有在 GATE-3 通过后才允许跨场画像；否则仅单场分析 |
| 十语言 | 新增 `common.platform.kuaishou`、`live.source.kuaishou`、`errors.kuaishou*`、`monitoring.kuaishou*`；十份字典同步 |
| EXE | 新增模块进 `REQUIRED_MODULES`；`verify-kuaishou-exe.mjs` 真实扫码/采集/停止/历史；`requireAdministrator` 断言不变 |
| 兼容 | 不改六平台、Schema 迁移单独评估、金额/身份/去重规则不放松 |

### 12.3 若走“匿名 H5 默认”（前提：GATE-1 明确允许 + 身份证据）

- 复用 `AnonymousH5Transport`，但必须：
  - 遵守平台给定的频率/范围限制（若许可中写明）；
  - `601` 结束本场，`result:2` 退避，空轮询不判下播；
  - 无消息 ID → 指纹去重 + 明确“可能漏消息/重复”；
  - 不提供礼物/点赞/分享，UI 如实显示不可用（**不显示 0**）；
  - 30 天保留窗口与原文清理照旧。
- 仍需 GATE-3（身份）与 GATE-5（长测）。

### 12.4 明确不做

- 不实现 `__NS_hxfalcon`/`__NS_sig3`、设备指纹、webweapon、验证码求解、TLS 伪装；
- 不引入付费签名、第三方中继、云端采集；
- 不把登录设为必需（除非用户明确批准例外）；
- 不把 H5 的“技术可用”写成“允许使用”；
- 不把模拟帧测试写成真实 WS 验收。

---

## 13. 是否允许进入 G2：最终建议

### **D — 暂缓，不进入 G2。**

理由：

1. **匿名 H5 被官方条款明文禁止**（机器人/蜘蛛监视、复制；书面许可要求），
   且 H5 域名 `robots.txt` 为 `Disallow: /`。技术上可用不等于允许使用。
2. **登录 WS 只完成了“登录”，没有完成“监听”**。
   `websocketinfo` 的唯一一次尝试使用了旧 `liveStreamId`，目标随后下播，
   因此既不能证明可用，也不能证明不可用；需要一次修正后的扫码复测。
3. **身份没有跨场证据**，长期画像的核心前提不成立。
4. **礼物/点赞/分享零真实样本**，不能写“支持”。
5. 即使 WS 技术复测通过，**平台授权仍然缺失**；登录只代表用户同意本机程序代表他登录，
   不代表快手允许 LiveMemory 自动读取、长期保存或再分发聊天数据。

### 13.1 什么条件下可以重新评估

- 快手给出**书面许可/合作**（GATE-1）；并且
- §5.3 的复测拿到 token、收到真实弹幕、能监听另一个公开主播（GATE-2）；并且
- 证明同一观众跨 2 个直播间 ID 一致（GATE-3）。

三条同时满足后，才建议以**登录 WS 可选增强**进入 G2（仍不把登录设为使用前提）；
若快手只允许匿名 H5 且给出书面许可，则改为匿名默认 + 登录增强。

### 13.2 直接回答“快手能不能像六个平台一样”

**现阶段不能。** 不是“永远不能”：
- 登录链路已经证明可以干净地跑通（这是本轮最大的技术进展）；
- 但“监听”与“身份”两个核心能力没有证据，且平台条款明确禁止未经许可的自动采集。
在这三点改变之前，快手只能是有技术线索的候选平台，不能作为第七个正式平台。

---

## 14. 交付物、复现与 Git

### 14.1 本轮产物

| 文件 | 内容 |
| --- | --- |
| `docs/KUAISHOU_G1_5_DUAL_MODE.md` | 本报告 |
| `research/kuaishou-g1_5/probe.mjs` | CLI：policy / rooms / status / h5 / login / selftest / cleanup |
| `research/kuaishou-g1_5/lib/*.mjs` | 双 transport、normalizer、identity、status、login、protocol、errors、http |
| `research/kuaishou-g1_5/tests/prototype.test.mjs` | 10 个离线单测 |
| `research/kuaishou-g1_5/scan.html` | 真人扫码大图页（自动换码） |
| `research/kuaishou-g1_5/README.md` | 用法、边界、复现、证据 |
| `docs/STATUS.md` / `docs/HANDOFF.md` / `docs/ROADMAP.md` / `docs/PLATFORM_EXPANSION_RESEARCH.md` | 状态与路线图更新 |
| `THIRD_PARTY_NOTICES.md` | G1.5 协议参考附录（未复制代码） |
| `log/2026-11-17-kuaishou-g1_5.md` | 开发日志 |

### 14.2 复现命令

```bat
:: 合规结论
node research/kuaishou-g1_5/probe.mjs policy

:: 当前在播房间（匿名 home/list）
node research/kuaishou-g1_5/probe.mjs rooms --limit 8

:: 单个房间状态（不把限流当下播）
node research/kuaishou-g1_5/probe.mjs status --room <eid>

:: 扫码登录（需要真人；二维码写到 .state/qr.png；打开 scan.html 扫）
node research/kuaishou-g1_5/probe.mjs login --room <在播eid> --wait 600 --listen 120 --probe

:: 研究复现 H5（默认拒绝；必须显式承认 POLICY-BLOCKED）
node research/kuaishou-g1_5/probe.mjs h5 --room <eid> --live-stream-id <id> --seconds 60 --acknowledge-blocked

:: 测试
node --test --test-isolation=none research/kuaishou-g1_5/tests/prototype.test.mjs
```

### 14.3 本轮未做 / 禁止

- 未新增 `src/platforms/kuaishou/`，未改路由/UI/数据库/监控生产代码；
- 未改版本号、未动 v0.16.0 Tag/Release/EXE；
- 未引入运行时依赖、未复制第三方代码、未实现签名/指纹/验证码；
- 未 Push、未 Merge main、未创建 Tag/Release；
- 未跑新的 H5 长测（因 POLICY-BLOCKED）；
- 未完成 WS 真实监听、礼物、跨场身份、再开播。

### 14.4 Git

| 项目 | 值 |
| --- | --- |
| 分支 | `kuaishou-g1_5`（从 `kuaishou-g1` `83a2c30` 创建；未 Push） |
| 本地提交 | `939f416`（`docs: verify Kuaishou G1.5 login and dual-mode boundaries`，23 files，+3,323/−17） |
| 记录提交 | `docs: record the Kuaishou G1.5 commit`（只追加本 Hash） |
| `main` | 未改（`6f71f56`）；`v0.16.0` Tag/Release/EXE 未动 |
| Push / Merge / Tag / Release | **均未执行** |
| 工作区 | 提交后干净；`research/kuaishou-g1_5/.state/`、`scan.png`、`tests/.tmp/` 未提交 |

---

## 附录 A：证据时间线（Asia/Shanghai）

| 时间 | 事件 |
| --- | --- |
| 18:24 | 取 `livev` / `live.kuaishou.com` / `www` robots.txt；确认 H5 `Disallow: /` |
| 18:26–18:30 | 取得官方《用户服务协议》《直播服务协议》《直播管理规范》全文（CMS id=14/23/25） |
| 18:34 | 匿名 `home/list` → 48 个在播房间；选中 `3xetq2fy4tgmiv9` / `w_sQwbdws3c` |
| 18:35:15 | 无签名 `qr/start` → `result:1` + PNG |
| 18:35–18:41 | 二维码约 58 秒过期，自动换码 3 次 |
| 18:41 | 用户扫码并确认 → `scanResult=1` → `acceptResult=1` → `passToken` |
| 18:41:5x | `getCdns=1` → `passToken` 换票 `result:1` → `userLogin=1`（`live.web_st/_ph`） |
| 18:41:59 | `websocketinfo`（旧 liveStreamId）→ `result:2`，无 token |
| 18:43 | 再次 `home/list` → 48 个房间（说明非全站限流） |
| 18:44 | 复核目标房间 → `offline`（不在列表） |

## 附录 B：本轮没有做的事（防止误读）

- **没有**用 catbus 的签名/指纹/验证码代码；
- **没有**把匿名 H5 再次作为“可用路线”运行；
- **没有**把扫码登录成功写成“平台授权”；
- **没有**把 `result:2` 写成“WS 不可用”；
- **没有**把模拟帧测试写成“真实弹幕已收到”；
- **没有**把 H5 的 555 条历史样本写成“现在仍允许采集”。
