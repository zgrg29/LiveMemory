# 快手（Kuaishou）第七平台候选 — G1 登录态 WebSocket / 匿名 H5 双路线技术验证

状态：**G1 执行完成（2026-11-17）· 结论 C（暂缓）**
调查基线：`kuaishou-g0` 分支 `25ee5a9`（`docs: record Kuaishou G0 verification`）· 工作区开始前干净
本轮范围：只做源码调查、有限真实实验、研究脚本与文档；**未接入快手、未改六个平台生产代码、未改版本号、未 Push/Merge/Tag/Release。**

> 口径说明：本轮 G1 按用户 2026-11-17 调整后的条件执行——**允许用户主动扫码登录**，不再把“免登录”当硬门槛。
> 这与 `docs/PLATFORM_ADMISSION.md` 原有的“G1 免登录可行性”阶段名不同；**本轮没有修改准入规范**，
> 也没有因为放宽登录就降低“不绕过访问控制 / 稳定身份 / 真实证据”的要求。

> 一句话结论：**登录态 WebSocket 的字段最完整，但本轮无法完成真实登录验证；匿名 H5 仍可用但只有聊天、没有礼物，且被 `robots.txt` 明确拒绝普通自动访问。跨场稳定 ID、真实下播、登录后任意直播间监听、礼物事件都没有真实证据，因此只能给 C，不能给 A/B。**

证据标注：

| 标记 | 含义 |
| --- | --- |
| **[实测]** | 本轮亲自发起请求/解析响应得到的事实（附时间、房间、计数） |
| **[源码]** | 亲自阅读第三方或本仓库源码得到的事实 |
| **[文档]** | README / 官方文档 / 仓库元数据声明，未亲自复现 |
| **[未执行]** | 本轮没有执行，原因已写明（不是“平台拒绝”） |
| **[待验证]** | 有线索但没有证据，必须由下一阶段回答 |

---

## 1. G1 执行摘要

### 1.1 最重要的六个发现

1. **匿名 H5 仍然可用，但本轮样本聊天密度低、且出现软限流 [实测]**。
   2026-11-17 15:41 的 3 房间 45 秒样本收到 6 条 `comment`，昵称/数字 `userId`/毫秒时间/头像 **100%**，
   消息 ID **0%**，重复 0，p50 延迟 2.97–3.43 秒；随后 2 小时 3 房间长测收到 **555 条 / 229 个用户**，
   0 重复、0 HTTP 错误，但 **92.5% 的轮询为空**。多次刷新公开直播间页时，SSR 返回
   `"errorType":{"type":2,"title":"请求过快，请稍后重试"}`（57,783 字节），说明**页面访问被限流**；
   此时不能把“没有 liveStream.id”当成主播下播。同日长测中 `juedidatou` 约 13 分钟后持续返回
   `result:601` / `"直播已停止"`，这是一次**真实下播**信号；再开播未观察。
2. **登录态 WebSocket 的协议与主要字段已被 catbus 实现，但实现方式不可用于 LiveMemory [源码]**。
   catbus 的登录（含扫码）需要 `__NS_hxfalcon` / `__NS_sig3` 纯算签名、webweapon/gdfp 设备指纹、
   精确 Cookie 线序，并内置**滑块验证码自动求解**（`captcha.ts`：找缺口、造轨迹、gdfp 人机预检、加密提交）。
   它依赖的 `wreq-js` 自述为“browser TLS fingerprint impersonation (JA3/JA4). Bypass Cloudflare and anti-bot detection”。
   这属于用户明确禁止的“非公开签名 / 模拟客户端 / 绕过风控”，**只能作为协议资料阅读**。
3. **官方扫码登录的第一步不要求签名 [实测]**。
   不带 Cookie、不带签名请求 `POST https://id.kuaishou.com/rest/c/infra/ks/qr/start`
   返回 `result:1`、`qrUrl`、`qrLoginToken`、base64 PNG（125×125）；继续无签名轮询
   `scanResult`/`acceptResult` 返回 `707`（未扫码/过期），**不是签名错误**。
   这说明“干净的、无浏览器的扫码登录”存在可能性；但**完整登录需要真人用手机扫码**，本轮没有账号/手机，
   因此 callback、直播站换票、`websocketinfo` 全部 **[未执行]**。
4. **登录态能否监听“别人的公开直播间”，代码层面是肯定的 [源码]**。
   catbus `liveListen` 接受任意主播 `eid`，`roomState` 通过公开首页或 `livedetail` 取该房间的
   `liveStreamId`，`websocketInfo` 用登录 Cookie 线请求；代码里没有“只能监听自己房间”的判断。
   但这只是代码事实，**没有真实账号验证**；平台是否对普通账号的跨房间订阅做额外限制，仍是 **[待验证]**。
5. **登录态的 canonical event 没有消息 ID [源码]**。catbus 的 canonical event 没有 `id` 字段，
   `feedEvents()` 只映射 `commentFeeds/likeFeeds/giftFeeds/shareFeeds/systemNoticeFeeds`；
   `Event` 构造函数只有 `type/time/user/text/gift/stats`。raw `SC_FEED_PUSH` 是否带 `id/feedId`
   代码没有使用，本轮也**未验证**。所以“登录 WS 比 H5 更完整”成立的范围是**礼物/点赞/分享**，
   不是消息级幂等。关注、用户进入、撤回在 catbus 中也 **UNSUPPORTED / NOT-OBSERVED**。
6. **两条路线都没有通过准入 [源码+实测]**：
   - H5 域名 `livev.m.chenzhongtech.com/robots.txt` 对 `User-agent: *` 为 `Disallow: /`（本轮再次实测）；
   - 登录 WS 的官方网关需要非公开签名（catbus 源码），或至少需要一次真人扫码才能证明“无签名也能换票”；
   - 登录只代表用户本人账号的会话，**不等于平台授权 LiveMemory 自动采集、长期保存或再分发**。

### 1.2 结论与建议

**C — 暂缓。**

- 不是 A：跨场/跨日稳定 ID、真实登录 WS、礼物/点赞/分享、真实再开播都没有真实证据
  （下播已由 feed `601` 观察，但再开播未观察）。
- 不是 B：B 要求“核心功能基本可行”。目前只有**匿名聊天**这一项真实可行；身份与登录这两项最关键的准入能力仍未闭环。
- 不是 D：匿名 H5 确实仍能返回实时公开聊天；扫码登录第一步也确实可用。技术路径存在，只是证据与合规都不够。

**建议：停止在 G1 继续加码；等用户决定是否授权一次“真人扫码 + 2 小时登录态实验”。**
如果用户不愿意提供账号/手机，或合规结论为“不允许自动访问”，则保持 C，不进入 G2。

---

## 2. catbus 源码调查

仓库：<https://github.com/cv-cat/catbus>（TypeScript，MIT，627 stars，`pushed_at` 2026-11-17T00:01:15Z，未归档）
调查方式：通过 GitHub raw 读取 `master` 实际源码，不是只看 README。读取的文件：

| 文件 | 本轮确认的内容 |
| --- | --- |
| `src/platforms/kuaishou/web/live.ts` | SocketMessage 信封、AES/gzip、进入房间/心跳/退出帧、`SC_FEED_PUSH` 事件映射 |
| `src/platforms/kuaishou/web/commands.ts` | 扫码/短信/Cookie 登录、`liveListen` 长连、礼物字典、重连 |
| `src/platforms/kuaishou/web/session.ts` | Cookie/票据、webweapon（gdfp）引导、6 分钟票据、登出 |
| `src/platforms/kuaishou/web/api.ts` | QR 端点、passToken 换票、`websocketinfo`、礼物/房间接口 |
| `src/platforms/kuaishou/web/client.ts` | 各站点请求器、`__NS_hxfalcon`/`__NS_sig3` 注入、设备指纹上报 |
| `src/platforms/kuaishou/web/sign.ts` | sig4/sig3 纯算实现、设备信息前缀、硬编码常量 |
| `src/platforms/kuaishou/web/captcha.ts` | 滑块验证码自动求解（找缺口、轨迹、gdfp 预检、verifyParam） |
| `src/platforms/kuaishou/web/normalize.ts` | 直播事件/礼物的归一化字段 |
| `src/platforms/kuaishou/web/resolve.ts` | 任意主播 `eid`/直播 URL 解析，无“本人房间”限制 |
| `src/core/stream.ts` | WebSocket 包装与指数退避重连 |
| `src/core/normalize.ts` | `Event` 没有消息 ID 字段 |
| `package.json`、`LICENSE`、`README.zh-CN.md` | 依赖、MIT 文本、研究用途免责声明 |

### 2.1 扫码登录与会话管理

**[源码] 登录入口**（`index.ts`）：

```ts
login: { methods: ['qrcode', 'sms', 'cookie'], default: 'qrcode' }
```

**[源码] 扫码流程**（`commands.ts`）：

```text
POST /rest/c/infra/ks/qr/start        -> qrUrl, qrLoginToken, qrLoginSignature, imageData
POST /rest/c/infra/ks/qr/scanResult   -> 1 已扫 / 707 过期 / 711|712 手机取消
POST /rest/c/infra/ks/qr/acceptResult -> qrToken
POST /pass/kuaishou/login/qr/callback -> passToken + Set-Cookie
POST /rest/infra/sts (www/CP/live)    -> 站点 _st/_ph
GET  /rest/v/profile/get 或 userInfo  -> 校验登录
```

二维码默认等待 600 秒；707 时换一张；扫过后不能再换；手机上取消会抛 `AUTH_REQUIRED`。
登录成功后还做 CP STS、CP 文档、**设备指纹上报**、www 文档、直播站 `passToken` 换票。

**[源码] 会话存储**：`Session.prepare()` 把 Cookie 放进 `Map`；`Kwfv1`/`kwfcv1` 是持久浏览器状态；
`kwscode`/`kwssectoken` 只有 6 分钟，由 gdfp `/s/w/c` + 官方 kws 脚本现算，不落盘。
`save()` 只写非临时 Cookie 和 `kwfcv1`，凭据由 catbus 自己的 store 落盘（本仓库未使用）。

**[源码] 关键限制**：登录请求也走 `loginForm()`；`LOGIN_SIG4` 包含
`qr/start`、`qr/scanResult`、`qr/acceptResult`、`qr/callback`、`mobileCode`、`multiUserToken`。
也就是说，catbus 认为这些接口都要 sig4。**本轮实测无签名 `qr/start` 仍返回 1**，
说明服务端对“开始扫码”这一步可能不强制签名；但 catbus 的实现不能证明 callback 也不强制。

### 2.2 WebSocket 连接、心跳与重连

**[源码] 连接流程**（`commands.ts` `liveListen`）：

```text
1. 解析任意主播 eid（URL / 裸 ID）
2. 检查 kuaishou.live.web_st / web_ph；缺失则用 passToken 换票
3. roomState(eid)：首页 home/list 找，找不到用 livedetail?principalId=eid
4. GET /live_api/liveroom/websocketinfo?liveStreamId=...（登录 Cookie 线 + sig4）
5. new WebSocket(websocketUrls[attempt % urls.length])
6. 发 CS_ENTER_ROOM（token + liveStreamId + reconnectCount）
7. 收 SC_ENTER_ROOM_ACK -> heartbeatIntervalMs（默认 20000）
8. 每 interval 发 CS_HEARTBEAT；断线时发 CS_USER_EXIT
9. SC_FEED_PUSH -> feedEvents()
```

**[源码] 信封与压缩**（`live.ts`）：

```text
SocketMessage { payloadType=1, compressionType=2, payload=3 }
compressionType 3 -> AES-128-CBC（硬编码 key/iv）
compressionType 2 -> gzip / inflateRaw
其余原样
```

**[源码] 重连**（`core/stream.ts`）：

- 网络错误 / 正常断线：指数退避 1s、2s、4s … 上限 30s，**无限重连**，直到用户停止；
- `AUTH_REQUIRED`、`RISK_CONTROL`、参数错误：**立即抛出**，不重连；
- `UPSTREAM` 连续 5 次且中间没有收到任何事件：抛出；
- 重连时 `attempt` 递增，作为 `reconnectCount` 和选择 `websocketUrls` 的依据。

**会话过期处理 [源码]**：没有主动的“过期前提示”；`authStatus()` 的 `expires_at` 恒为 `null`；
登录失效通常表现为 `websocketinfo` 没有 token / `AUTH_REQUIRED` / `result=109`，命令直接失败，
由用户重新执行 `auth login`。这**不满足** LiveMemory 的“会话过期后提示重新登录”体验要求。

### 2.3 弹幕、观众 ID 与事件

**[源码] 事件映射**（`live.ts`）：

| 原始字段 | canonical 类型 | 关键字段 |
| --- | --- | --- |
| `commentFeeds[]` | `chat` | `user.principalId`、`user.userName`、`user.headUrl`、`content`、`time` |
| `likeFeeds[]` | `like` | `user`（无数量字段） |
| `giftFeeds[]` | `gift` | `user`、`giftId`、`batchSize`/`comboCount`、礼物字典名 |
| `shareFeeds[]` | `other` | `user`、文本“分享了直播间” |
| `systemNoticeFeeds[]` | `other` | `user`、`content` |

- **观众 ID**：`liveUser()` 只接受 `principalId`，转成字符串；`principalId` 为空则 `user=null`。
  没有“昵称 hash 当 ID”的做法。
- **消息 ID**：`feedEvents()` 没有把任何 `id/feedId` 传给 `n.event()`；`Event` 类型也没有 `id`。
  **登录 WS 的 canonical event 同样没有消息 ID [源码]**；raw feed 是否带 id 未验证。
- **礼物**：`giftName(id)` 来自 `gift-list` + `allgifts` 字典；`count` 取 `batchSize || comboCount || 1`；
  `gift()` 归一化保留 `unitPrice`，币种写 `KSCOIN`（快币），**不换算人民币**。但直播事件里没有
  把 `unitPrice` 放进 `Event.gift`，只保留名称和数量。
- **关注**：`feedEvents()` 没有 follow 分支；`live.ts` 也没有 `SC_FOLLOW` 之类。
- **用户进入**：没有解析 `SC_LIVE_WATCHING_LIST`。
- **撤回/删除**：没有解析。
- **点赞**：只有事件，没有点赞数。

### 2.4 多直播间与“监听别人”

**[源码]**：`liveListen` 的 `room` 参数直接来自命令；`resolveRoom()` 接受 `eid` 或
`https://live.kuaishou.com/u/<eid>`；`roomState()` 对该 `eid` 查首页或 `livedetail`；
`websocketInfo()` 用该房间的 `liveStreamId`。**没有任何 `selfEid` 比较**。
catbus 的 skill 文档也写：`catbus kuaishou live listen <主播 ID> --duration 10m`。

因此**代码支持“登录普通账号监听任意公开主播”**；限制只可能来自平台服务端。
本轮没有账号，**不能给 REAL-VERIFIED**。若平台只允许本人房间，代码会在
`websocketinfo`/`roomState` 返回 109/2/671 等错误，必须如实记录，不能硬闯。

### 2.5 许可证与“研究用途”声明

- `LICENSE`：标准 MIT，允许修改、商用、再分发，只需保留版权与许可声明。
- `README.zh-CN.md` 免责声明：“本项目仅供学习和研究使用，请勿用于商业或违法用途”、
  “自动化操作可能触发风控：验证码、限流乃至封号。一切后果由使用者自行承担”、
  “与平台没有关联，也未获授权或认可”。
- **两者不一致**：MIT 文本没有“禁止商用”的条款；README 的“仅供研究”是作者意图/请求，
  不是附加的许可证条件。法律上 MIT 仍然允许商用；但作者明确不欢迎商用，且平台授权问题独立存在。
- 依赖：`protobufjs`（BSD-3-Clause）、`wreq-js`（MIT）、`@techstark/opencv-js`（Apache-2.0）、
  `@napi-rs/canvas`、`jsdom`、`onnxruntime-web`、`crypto-js` 等 **18 个**运行时依赖。
  已抽查的三个是宽松许可证；**未逐个审计全部 18 个依赖**。
  许可证兼容不等于可以绕过平台风控。
- **本轮没有复制 catbus 的任何代码、protobuf descriptor、静态字典或签名常量**；
  只把协议事实写进报告。`research/kuaishou-g1/probe.mjs` 是独立编写的 HTTP 客户端。

### 2.6 catbus 明确不适合 LiveMemory 的部分

| 机制 | 位置 | 为什么不能进正式产品 |
| --- | --- | --- |
| `__NS_hxfalcon` / `__NS_sig3` 纯算 | `sign.ts` | 复现平台非公开签名，属于模拟官方客户端/绕过安全机制 |
| 设备指纹 / webweapon | `session.ts`、`gdfp.ts`、`oracle.ts` | 伪造设备身份，规避平台风控 |
| 滑块自动求解 | `captcha.ts`、`gap.ts`、`captcha-crypto.ts` | 直接破解验证码，用户明确禁止 |
| TLS/JA3/JA4 伪装 | `wreq-js` | 反检测依赖，不是普通 HTTP 客户端 |
| 精确 Cookie 线序 / Sentry 头 | `profile.ts`、`client.ts` | 模拟浏览器指纹，维护成本极高、随时失效 |
| 运行依赖 18 个（含 WASM/OpenCV/ONNX） | `package.json` | 违反 LiveMemory 零依赖、单 EXE 的边界 |

这些机制需要单独审查：

| 维度 | 判断 |
| --- | --- |
| **合法性** | MIT 只解决代码版权，不解决平台授权。复现 `__NS_hxfalcon`、伪造设备指纹、自动过滑块，属于规避平台安全/风控措施；即使代码开源，也不能据此认为平台允许。 |
| **稳定性** | 签名算法、SDK 版本、Cookie 线序、验证码参数都随平台前端更新；catbus 需要持续跟进（`SDK_VERSION_LIVE=43469`、固定 AES key、固定设备常量）。任何一次前端改版都可能失效，维护成本极高。 |
| **产品化** | 需要 18 个运行时依赖、WASM/OpenCV/ONNX、TLS 指纹伪装；无法满足 LiveMemory 零依赖、单 EXE、无浏览器、无云端的形态。**不适合。** |

**不得因为 catbus 已经实现，就默认这些机制可以进入正式发布。** 本轮只读，不复制、不调用。

**结论**：catbus 是很好的“协议地图”，但不是可复用实现；其登录/WS 路线在 LiveMemory 的
“不绕过访问控制、不模拟客户端、不使用非公开签名”边界内**不可直接产品化**。

### 2.7 其他项目的复核

| 项目 | 本轮复核 | 结论 |
| --- | --- | --- |
| [ykaiqx/Live-Barrage](https://github.com/ykaiqx/Live-Barrage) | MIT；`archived=true`；最后推送 2023-05-04；H5 `barrage.py` 3 秒轮询 | 只证明 H5 路径存在；无维护、无 cursor、无礼物 |
| [cv-cat/KuaiShou-Spider](https://github.com/cv-cat/KuaiShou-Spider) | **无 LICENSE**；catbus 的上游；`live_api.py` 要求 `live_room_authenticated`，`live_proto.py` 完整 protobuf | **只能读，不能复制**；与 catbus 同一套登录/签名门槛 |
| [BarryWangQwQ/UniBarrage](https://github.com/BarryWangQwQ/UniBarrage) | G0 读到的 LICENSE 为 GPL-3.0 + 商业限制；2024-12 停更；匿名移动 token `rest/k/live/byUser` | G0 实测 `result:2`；issue #5 报告失效；**不可用** |
| [frostynight-furry/furryup-live-connect](https://github.com/frostynight-furry/furryup-live-connect) | MIT；Node 外壳 + **Java collector** + browser-service；有 `KuaishouExtraEvents`/`KuaishouGiftPrices` | 架构不适合 LiveMemory（Java/浏览器服务）；未逐行审其快手协议；只作参考 |

没有发现“免登录、零依赖、2026 年仍在维护、字段完整”的第四个实现。catbus 仍是唯一同时覆盖
扫码/WS/礼物/房间状态的活跃项目，而它恰好也是最不可复用的一个。

---

## 3. 登录机制与授权范围

### 3.1 官方扫码登录的真实可行性（本轮实测）

**[实测] 2026-11-17 15:42–15:45：**

| 请求 | 结果 |
| --- | --- |
| `POST https://id.kuaishou.com/rest/c/infra/ks/qr/start`（无 Cookie、无签名） | HTTP 200，`result:1`，有 `qrUrl`、`qrLoginToken`、`qrLoginSignature`、`imageData`（base64 PNG，676 字符） |
| 继续 `POST /qr/scanResult`（带 token/signature，无签名） | HTTP 200，`result:707`（未扫码/过期），**不是 400013 签名错误** |
| 继续 `POST /qr/acceptResult` | HTTP 200，`result:707` |
| `login` PoC（保存二维码、轮询） | QR 生成成功，707 自动换码 1 次，30 秒内无人扫码 → `blocked_on_human_scan` |

`qrUrl` 形如 `http://qr.kuaishou.com/l/<短码>`，`imageData` 是可直接保存的 PNG。
这意味着：**一个不依赖浏览器、不复制 Cookie 的扫码登录 UI 在协议层是可能的**。

但本轮**没有**完成：

- 真人扫码；
- `acceptResult` 拿到 `qrToken`；
- `/pass/kuaishou/login/qr/callback` 拿到 `passToken`；
- 直播站 `passToken` 换票、`userLogin`、`websocketinfo`；
- WS 连接、protobuf 解码、任何一条真实登录态弹幕/礼物。

原因：本轮没有可用的快手账号/手机，也没有授权测试参与者。**这是实验条件阻塞，不是平台拒绝。**

### 3.2 登录后到底被授权了什么

必须区分三件事：

1. **账号会话**：扫码让 LiveMemory 拿到用户本人的 `passToken`/站点票据。它证明“用户同意这个本地程序代表他登录”。
2. **平台访问授权**：快手用户协议/直播规则是否允许第三方程序自动读取任意公开直播间的聊天、礼物、
   观众 ID，并长期保存在本地、做 AI 分析，是另一件事。**登录不等于这种授权。**
3. **数据再分发授权**：即使本地采集被允许，把观众昵称/ID/聊天上传到 AI Provider 或导出，
   仍受平台条款与个人信息保护约束。

本轮没有逐条审阅快手《用户服务协议》《直播服务协议》全文，**不能给出“合规允许”的结论**。
可确认的客观信号：

- `livev.m.chenzhongtech.com/robots.txt`：`User-agent: * / Disallow: /`；
- 快手没有面向普通开发者的“读取任意直播间聊天”的公开 API；
- catbus README 明确写“自动化可能触发风控/封号”“未获平台授权”；
- 平台对匿名 `websocketinfo`/`livedetail` 返回 `result:2`，说明接口有风控。

### 3.3 能否复用 LiveMemory 现有扫码架构

**可以复用“形态”，不能直接复用“平台实现”。**

本仓库已有：

- `src/platforms/bilibili/login.mjs`：`startQr()` / `pollQr()` / `status()` / `logout()`；
- `src/platforms/bilibili/cookie-store.mjs` + `src/platforms/shared/secret-store.mjs`：
  AES-256-GCM + 每安装密钥 + 尽力 `icacls`，只存 Cookie，不写日志；
- `src/server/routes.mjs`：`/api/bilibili/login/qrcode`、`/poll`、`/logout`；
- `src/web/js/vendor/qrcode.js` + `src/web/js/pages/live.js`：本地渲染二维码，不上传第三方；
- `src/monitoring/`：`MonitoringManager` + 每平台 detector + `connectDetected`。

快手的差异：

- 二维码不是“URL 直接渲染”，官方返回的是 PNG `imageData`；可以本地显示，不必引入 QR 编码器；
- 登录后还要做直播站 `passToken` 换票和 `userLogin`，比 Bilibili 多两跳；
- 会话过期没有 `expires_at`，只能靠请求失败感知；
- 如果 `websocketinfo` 真的强制 sig4，则“干净的扫码登录”仍然无法直接换到 WS token；
- Bilibili 的登录是**可选增强**（公开直播间匿名可看）；快手登录如果成为必需，产品体验会更重。

**建议的复用方式（G2 才做）**：新建 `src/platforms/kuaishou/auth.mjs`，复用
`EncryptedJsonStore` 的存储与清除模式、复用现有 QR 弹窗/轮询 UI 组件，但**不复制 Bilibili 的
Cookie 解析细节**，也不引入 catbus 的签名/指纹/验证码代码。

---

## 4. 登录态 WebSocket 真实实验

### 4.1 执行状态：BLOCKED（缺账号/真人扫码）

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 官方 QR 生成 | **REAL-VERIFIED** | 无签名 `qr/start` 返回 1 + PNG |
| QR 轮询/换码 | **REAL-VERIFIED（未扫码）** | 707 换码 1 次；无 400013 |
| 真人扫码 | **[未执行]** | 没有账号/手机/授权参与者 |
| callback / passToken | **[未执行]** | 依赖扫码 |
| 直播站换票 / userLogin | **[未执行]** | 依赖 callback |
| `websocketinfo`（登录态） | **[未执行]** | 依赖直播站票据 |
| WS 连接 / 进房 / 心跳 | **[未执行]** | 依赖 token/URL |
| protobuf 弹幕/礼物解析 | **[未执行]** | 只有 catbus 源码证据 |
| 会话过期/恢复 | **[未执行]** | 无会话 |
| 多直播间（登录态） | **[未执行]** | 无会话 |

**本轮没有用匿名请求冒充登录态结果，也没有用 catbus 的源码结果冒充实测。**

### 4.2 匿名 `websocketinfo` 对照（真实拒绝形态）

**[实测] 2026-11-17 15:42:**

```http
GET https://live.kuaishou.com/live_api/liveroom/websocketinfo?liveStreamId=h7uU0cV3sP4
User-Agent: 桌面 Chrome
Referer: https://live.kuaishou.com/u/3x8d9f7x5uxh3wa
（无 Cookie、无 __NS_hxfalcon）
```

响应：HTTP 200，`{"data":{"result":2}}`，无 `token`、无 `websocketUrls`。
这与 G0 一致，证明**匿名拿不到 WS token**；但不能证明“登录后一定拿得到”，也不能证明“必须 sig4”。
唯一能确定的是：catbus 的实现会加 sig4，且它认为 `websocketinfo` 在签名名单里。

### 4.3 如果要做真实登录实验，最小步骤

1. 用户在自己的手机快手 App 扫码（二维码由本地 PoC 生成，不上传）；
2. PoC 在内存中完成 callback，**不落盘**；
3. 立即测试：`passToken` → 直播站 `userLogin` → `websocketinfo`（先不加签名）；
4. 若返回 token/URLs，再连 WS、进房、收 3–5 分钟 `SC_FEED_PUSH`；
5. 同时记录 `result` 与错误码；若要求签名/滑块，立即停止，不规避；
6. 用**另一个公开主播**的房间重复一次，验证“监听别人”；
7. 用同一账号在**两个不同房间**各发一条消息（若用户愿意），验证 `principalId` 跨房间一致；
8. 观察一次真实下播→再开播；至少 2 小时、3 房间并发。

没有第 1 步，后面全部无法开始。

---

## 5. 匿名 H5 对照

### 5.1 端点与字段（2026-11-17 复测）

```http
GET https://livev.m.chenzhongtech.com/wap/live/feed?liveStreamId=<id>&cursor=<cursor>
User-Agent: iPhone Safari
Referer: https://livev.m.chenzhongtech.com/
（无 Cookie、无签名、无登录）
```

响应仍为 `result:1`、`cursor`、`currentWatchingCount`、`liveStreamFeeds[]`。
每条 `comment` 的键仍是 `author, content, time, type`；`author` 含
`userName, userText, userSex, userId, headurl`。

**本轮没有观察到 `pullCycleSeconds`**（G0 曾观察到 3）。是否字段被移除、还是只在部分响应出现，
**[待验证]**；PoC 仍按 3.2 秒轮询，并不依赖该字段。

### 5.2 真实样本

| 实验 | 时间 | 房间 | 并发 | 轮询/房 | 消息 | 独立用户 | 字段覆盖 | 重复 | 延迟 p50/p95 |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- | ---: | --- |
| A 短测 | 15:41:08–15:41:55 | 3 个在播房间 | 3 | 14 | 6 | 6 | 昵称/ID/时间/头像 100%；消息 ID 0% | 0 | 2,973–3,433 / 4,775 ms |
| B 活跃度抽样 | 15:48:30–15:48:55 | 6 个在播房间 | 6 | 8 | 6 | 4 | 100% | 0 | 未统计 |
| C 断网对照 | 15:50:16–15:54:18 | 1 个在播房间 | 1 | 68 | 6 | 5 | 100% | 0 | 4,244 / 6,468 ms |
| D 长测 | 15:48:49–17:48:52 | 3 个在播房间 | 3 | 2,211 / 2,212 / 2,211 | 555 | 229（无跨房重叠） | 昵称/ID/时间/头像 100%；消息 ID 0% | 0 | 3.06–3.14 / 4.54–4.61 s |

> 消息数偏低不是接口只返回固定条数：短测单次最多 1 条，2 小时长测单次最多 4 条，G0 曾单次 10 条；
> 本轮多数轮询为 0 条，更像“房间聊天本身稀疏 + 多次访问后的软限流”，而不是固定条数上限。

### 5.3 软限流与“假下播”

**[实测] 15:46–15:47**：对 `Pxxs88888888`、`xiaodong9094` 连续请求公开直播间页，返回
HTTP 200、57,783 字节、`<title>快手直播</title>`，页面内：

```json
"playList":[{"liveStream":{},"author":{},"gameInfo":{},"isLiving":false,
"errorType":{"type":2,"title":"请求过快，请稍后重试","content":"浏览其他内容"}}]
```

而同一次 `home/list` 明确列出这些 `eid` 正在直播、有 `liveStreamId`。
**所以：不能把“页面没有 liveStream.id”当成下播。** 监控必须识别 `请求过快` 并退避。

这也解释了为什么本轮需要用 `discover` 拿到的 `liveStreamId` 直接轮询（`--target`），
而不是每次先抓房间页。生产上应缓存 `liveStreamId`，并只在必要时刷新。

### 5.4 匿名路线的完整性限制

- 没有消息 ID → 去重只能靠 `userId + time + content` 指纹；
- 没有礼物/点赞/分享/关注/进入/撤回；
- 没有“官方承认”的实时性保证，只有 3 秒级轮询；
- 高聊天率是否截断、cursor 过期、服务端重启、IP 限流恢复：本轮**没有足够高的流量样本**；
- 重启后 cursor 不持久化 → 停机期间的消息可能漏，必须标注。

---

## 6. 稳定观众 ID 验证

### 6.1 六个问题逐条回答

| # | 问题 | 本轮证据 | 结论 |
| --- | --- | --- | --- |
| 1 | 同一观众在同一直播间多次发言，ID 是否一致 | 2 小时长测：94 个重复发言用户、0 个“同 ID 多昵称”；`usersWithMoreThanOneNickname=0` | **运行内未见异常**；无独立身份确认，样本仍短 |
| 2 | 同一观众在不同直播间发言，ID 是否一致 | 3 房间 2 小时长测：229 个独立用户，跨房间重叠 **0** | **无证据**（可能是观众不重叠，也可能 ID 房间内稳定） |
| 3 | 同一观众在不同日期发言，ID 是否一致 | 本轮只有 1 天，G0 也没有保存 ID | **[未执行]** |
| 4 | 登录态与匿名 H5 的 ID 是否同一命名空间 | H5 是数字 `userId`；catbus 是字符串 `principalId`；没有同一观众的两种样本 | **[待验证]，不得合并** |
| 5 | 观众改昵称后 ID 是否稳定 | 运行内 `usersWithMoreThanOneNickname=0`，没有观察到改名 | **无法证明**；昵称不是身份 |
| 6 | 是否存在匿名/临时/缺失 ID | H5 样本 `userId` 覆盖 100%，未见空值/0；WS 代码 `principalId` 缺失时 `user=null` | H5：未发现缺失；WS：**[待验证]** |

### 6.2 不能从“格式相似”推出“同一命名空间”

- H5 的 `author.userId` 是 9–10 位数字；
- catbus 的 `principalId` 是字符串（可能也是数字，也可能是 `3x...` 的 eid 形态）；
- 两者可能都是快手账号 ID，也可能一个是直播站 ID、一个是主站 ID。
  G0 已经发现：**直播间主播 ID 与主页 eid 是两套命名空间**（catbus `resolve.ts` 也明确写了这一点）。
  因此**不能**因为“都是数字”就把 `kuaishou:h5:<userId>` 与 `kuaishou:ws:<principalId>` 合并。

### 6.3 对长期画像的影响

在跨场/跨日/跨路线证据缺失的情况下：

- 只能把 H5 `userId` 当作**运行内/场次内 ID**；
- 不能建立跨场长期画像；
- 不能在 UI 里写“同一观众”；
- 若 G2 要用，必须先设计一个“身份证据等级”字段（`source_quality = verified/field_only/unknown`），
  并默认按 `unknown` 处理，直到真实跨场样本出现。

---

## 7. 礼物和互动事件

### 7.1 事件矩阵

| 事件 | H5 匿名 | 登录 WS（catbus 源码） | 本轮证据 |
| --- | --- | --- | --- |
| 普通弹幕 | **REAL-VERIFIED** | CODE-SUPPORTED（未实测） | H5 多轮真实消息 |
| 观众昵称 | **REAL-VERIFIED** | CODE-SUPPORTED | H5 100% |
| 稳定观众 ID | **字段 REAL-VERIFIED；跨场未验证** | CODE-SUPPORTED（`principalId`） | 见 §6 |
| 消息时间戳 | **REAL-VERIFIED** | CODE-SUPPORTED | H5 100% |
| 消息 ID | **UNSUPPORTED**（0%） | **CODE 未映射**（Event 无 id；raw 未验证） | H5 0%；WS raw 未验证 |
| 礼物 | **UNSUPPORTED** | **CODE-SUPPORTED** | 未观测到真实礼物 |
| 礼物数量 | UNSUPPORTED | CODE-SUPPORTED（`batchSize/comboCount`） | 未观测 |
| 礼物发送者 | UNSUPPORTED | CODE-SUPPORTED（`user`） | 未观测 |
| 礼物价格/币种 | UNSUPPORTED | CODE-SUPPORTED（礼物字典 `unitPrice`，KSCOIN） | 未观测；不得换算人民币 |
| 点赞 | UNSUPPORTED | CODE-SUPPORTED（`likeFeeds`，无数量） | 未观测 |
| 关注 | UNSUPPORTED | **UNSUPPORTED**（无分支） | 未观测 |
| 分享 | UNSUPPORTED | CODE-SUPPORTED（`shareFeeds` → `other`） | 未观测 |
| 用户进入 | UNSUPPORTED | **UNSUPPORTED / NOT-OBSERVED** | 未观测 |
| 直播开始/结束 | **部分 REAL-VERIFIED（在播状态）；真实下播转换未观测** | CODE-SUPPORTED（`roomState`/连接） | 真实转换未观测 |
| 消息撤回 | UNSUPPORTED | **UNSUPPORTED / NOT-OBSERVED** | 未观测 |

### 7.2 结论

- 礼物是登录路线相对 H5 的**主要潜在优势**，但本轮只有源码证据，**零真实礼物样本**。
- 不能因为 catbus 有 `giftFeeds` 就写“快手支持礼物”；必须标 `CODE-SUPPORTED` / `NOT-OBSERVED`。
- 礼物价格只保留 `unitPrice`/`KSCOIN` 原值；没有本币金额时 `amount_minor=null`、`currency=null`、
  `value_kind=unknown`。
- 关注、进入、撤回在 catbus 中也没有实现；不能把它们写进 G2 的“已支持”清单。

---

## 8. 开播监控

### 8.1 已验证的信号

| 信号 | 匿名可用 | 说明 |
| --- | --- | --- |
| 公开直播间页 SSR `liveStream.id` | 是（但会限流） | G0 验证；本轮遇到“请求过快”，必须识别 |
| `home/list` | 是 | 只列在播房间；可拿 `liveStreamId`/`author.id` |
| `livedetail?principalId=` | 匿名 `result:2` | 登录后 catbus 用它；匿名不可用 |
| `wap/live/feed` 404 | 是 | 可作辅助，但不能单凭“没消息”判下播 |
| `wap/live/feed` 的 `result:601` | 是 | `error_msg:"直播已停止"`；2 小时长测中真实出现 1,969 次，应作下播信号 |
| 真实下播 | **部分 REAL-VERIFIED** | `juedidatou` 在约 12 分 45 秒后持续 601；SSR 仍被限流，未独立确认 |
| 真实再开播 | 未观测 | 本轮窗口内没有再开播 |

### 8.2 与现有 `MonitoringManager` 的适配

本仓库的监控状态机已经具备：

- `monitor_targets` 持久化、`enabled/state/next_check_at`、重启恢复；
- 每平台 policy（`baseMs/minMs/maxMs/errorBaseMs/endCooldownMs/maxConsecutiveFailures/requestGapMs`）；
- detector 的 `resolve(input)` + `detect(target)`；
- `connectDetected(observation, {monitorTargetId})` 启动适配器；
- `noteManualStop`、`platformEndedAt`、`platformEndQuality` 等真实下播证据。

快手要接入，需要（G2 才做）：

1. `src/monitoring/detectors/kuaishou.mjs`：解析 `live.kuaishou.com/u/<eid>` / 裸 eid；
2. `observeChannel(eid)`：优先 `home/list` 缓存，必要时 SSR；识别 `请求过快` → `RATE_LIMITED`；
3. `connectDetected`：用 `liveStreamId` 启动 H5 feed 适配器（或登录 WS，若通过准入）；
4. policy：建议 `baseMs=90s`、`requestGapMs≥3s`、`maxConsecutiveFailures=4`；
5. 下播确认：SSR 连续 2 次无 id + feed `601`/404，**且排除 `请求过快`**；
6. 真实 `在播→下播→再开播` 验收。

**本轮没有修改 `MonitoringManager`，也没有新增 detector。** 这不是“已接入”，只是设计评估。

### 8.3 为什么不能把“没有弹幕”当“下播”

- 低活跃房间可以 60 秒 0 条（G0 实验 #6；本轮 2 小时长测 92.5% 轮询为空）；
- WS 临时断开、`SC_ERROR`、心跳丢失都不等于下播；
- SSR 限流会返回“无 id”的假离线页；
- feed `601`（`直播已停止`）是明确下播信号，但不能把一次 601 当网络抖动；应连续确认；
- 必须用“页面状态 + feed 601/404 + 连续确认 + 排除限流”多信号。

---

## 9. 长时间稳定性

### 9.1 2 小时 / 3 房间长测

**[实测] 2026-11-17 15:48:49–17:48:52，3 个在播房间（`juedidatou` 约 13 分钟后下播），每房间独立 3.2 秒轮询，实际 7,203 秒（约 2 小时 0 分 3 秒）：**

| 指标 | `VX99956568` | `kx545468` | `juedidatou` | 合计 / 说明 |
| --- | ---: | ---: | ---: | --- |
| 轮询 | 2,211 | 2,212 | 2,211 | **6,634** |
| HTTP/网络错误 | 0 | 0 | 0 | 0 |
| 重连 | 0 | 0 | 0 | 0 |
| 结果码 | `1`×2,211 | `1`×2,212 | `1`×242 + `601`×1,969 | `601` = **“直播已停止”** |
| 消息 | 308 | 169 | 78 | **555**（全部 `comment`） |
| 独立用户 | 107 | 75 | 47 | **229**（跨房间重叠 0） |
| 重复发言用户 | 46 | 32 | 16 | 94 |
| 同 ID 多昵称 | 0 | 0 | 0 | 0 |
| 昵称/ID/时间/头像覆盖 | 100% | 100% | 100% | **100%** |
| 消息 ID 覆盖 | 0% | 0% | 0% | **0%** |
| 重复指纹 | 0 | 0 | 0 | **0** |
| 单次最多消息 | 3 | 2 | 4 | 4 |
| 空轮询 | 1,933 | 2,050 | 2,154 | 6,137 / 6,634（92.5%） |
| 延迟 p50 / p95 | 3,055 / 4,611 ms | 3,138 / 4,542 ms | 3,101 / 4,609 ms | p50 ≈ 3.1 s |
| 在线人数范围 | 173–765 | 69–712 | 480–2,159 | 仅展示值 |
| 提前结束标记 | false | false | false | 601 未触发 `endedEarly` |

**解释：**

1. **稳定性**：6,634 次轮询、555 条消息、0 HTTP 错误、0 重连、0 重复指纹；
   昵称/数字 ID/毫秒时间/头像 **100%** 覆盖，消息 ID **0%**。
2. **聊天密度低**：只有 497 / 6,634 次轮询拿到消息（7.5%），多数轮询为空；
   单次最多 4 条。不能把“没有消息”当接口故障或下播。
3. **真实下播信号 [实测]**：`juedidatou` 在约 12 分 45 秒后停止产生消息，
   随后 **1,969 次**返回 `result:601`、`error_msg:"直播已停止"`（HTTP 仍为 200）。
   这是一次真实的下播观察；但同房间的 SSR 仍被“请求过快”限流，**没有独立页面确认**，
   也没有观察到再开播。
4. **跨房间身份没有证据**：229 个独立用户里，跨 3 个房间的重叠为 **0**。
   这可能是三场观众本来就不同，也可能是 ID 只在房间内稳定；**不能据此证明跨场稳定**。
5. **运行内一致性**：94 个重复发言用户、0 个“同一 ID 对应多个昵称”；
   但昵称不是身份，且没有独立测试账号确认“同一个人”。
6. **结果码 601 必须进监控状态机**：它不是 HTTP 错误，也不是“没消息”，而是明确的
   `直播已停止`；生产上应据此结束本场，而不是继续空轮询 1,969 次。
   本轮运行的 PoC 版本还没有把 601 当结束信号（所以 `endedEarly=false`，继续轮询到 2 小时）；
   调查结束后已把 PoC 改为收到 601 即停止本房间。

### 9.2 断网对照（20 秒本地暂停）

**[实测] 2026-11-17 15:50:16–15:54:18，`VX99956568`（`xCc_wcWp3Zw`），单房间 242 秒：**

| 指标 | 值 |
| --- | ---: |
| 轮询 | 68 |
| HTTP/网络错误 | 0 |
| 结果码 | `1` × 68 |
| 消息 | 6（全部 `comment`） |
| 独立用户 | 5（1 个重复发言） |
| 昵称/ID/时间/头像覆盖 | 100% |
| 消息 ID 覆盖 | 0% |
| 重复指纹 | 0 |
| 延迟 p50/p95 | 4,244 / 6,468 ms |
| 空轮询 | 62/68 |
| 本地暂停 | 第 61.6 秒暂停 20 秒，第 81.6 秒恢复 |
| 恢复后错误/重复 | 0 / 0 |

**结论**：HTTP 轮询在 20 秒本地暂停后能继续使用旧 cursor，没有重复；但**无法证明暂停期间没有漏消息**
（没有独立的消息源对照）。这也是 H5 路线的固有限制：cursor 不是可验证的完整日志。

### 9.3 资源占用

**[实测] 2 小时运行期间：**

- 单进程 Node.js v24.21.0；3 个房间、每房间 3.2 秒轮询（约 56 请求/分钟）。
- RSS 采样 **59.7–68.7 MB**，无单调增长；CPU 在 75 分钟采样点累计约 **15 秒**（未连续采样）。
- 0 HTTP 错误、0 重连；进程结束后无残留 node 进程。
- **未测**：EXE 打包后的占用、10+ 房间、长时间 GC/句柄增长。

### 9.4 无法在窗口内观察到的真实事件

- 真实再开播（下播已由 `601` 观察，但未观察再开播）；
- 主播改名/观众改名；
- 礼物/点赞/分享/关注/进入/撤回；
- 高聊天率（>10 条/3 秒）截断；
- cursor 过期、服务端重启、IP 限流后的恢复；
- 登录态 token 过期；
- 10+ 房间并发。

**这些都不能用模拟测试冒充真实结果。**

---

## 10. 多直播间

| 项目 | 结果 |
| --- | --- |
| 3 房间并发（H5） | **REAL-VERIFIED**：45 秒短测、2 小时长测（6,634 轮询 / 555 消息）独立轮询 |
| 房间隔离 | 每房间独立 cursor/统计；0 跨房间混入；0 重复 |
| 3 房间以上 | 未测（G0 也只到 3 并发） |
| 登录态多房间 | **[未执行]**（无会话） |
| 同一 `platform + room` 重复启动 | PoC 未做去重；生产必须由 `SessionManager` 拒绝 |
| 进程重启恢复 | **[未执行]**；H5 cursor 不持久化，重启可能漏消息 |

---

## 11. 许可证与平台规则

### 11.1 代码许可证

| 项目 | 许可证 | 能否复制 | 本轮处理 |
| --- | --- | --- | --- |
| catbus | MIT | 可以（保留声明），但**不复制** | 只读协议 |
| KuaiShou-Spider | **无 LICENSE** | **禁止** | 只读 |
| UniBarrage | GPL-3.0 + 商业限制 | **禁止**用于闭源/商业 | 只读 |
| Live-Barrage | MIT，已归档 | 可以（保留声明） | G0 参考，未复制 |
| 本仓库 | MIT | — | 未新增第三方代码 |

### 11.2 MIT 与 README 的不一致

- `LICENSE` 是标准 MIT，**没有商用限制**；
- `README.zh-CN.md` 写“仅供学习和研究使用，请勿用于商业或违法用途”；
- 这不是许可证的附加条款，而是作者的使用请求；如果 LiveMemory 复用代码，法律上 MIT 允许，
  但会违背作者意图，且平台授权问题仍然独立存在。
- **本轮没有复制，所以不产生新的 MIT 声明义务**；`THIRD_PARTY_NOTICES.md` 只登记“阅读参考”。

### 11.3 平台规则

- `livev.m.chenzhongtech.com/robots.txt`：`User-agent: * / Disallow: /`（本轮实测，513 字节）；
- `live.kuaishou.com/robots.txt`：只对白名单搜索引擎 `Allow`，没有 `User-agent: *` 组；
- 快手没有公开的“任意直播间聊天读取”开发者 API；
- 登录态 WebSocket 是平台自己的非公开协议；catbus 的实现需要非公开签名/设备指纹/验证码求解；
- 用户协议/直播规则未逐条审阅，**不能写“合规”**。

### 11.4 独立准入判断

| 路线 | 代码许可证 | 平台授权 | 结论 |
| --- | --- | --- | --- |
| H5 匿名 | 无代码复制 | `robots Disallow: /` + 条款未审 | **未通过** |
| 登录 WS（catbus 方式） | MIT，但含签名/验证码/反检测 | 明确违反“不绕过访问控制” | **不通过** |
| 登录 WS（干净扫码，未验证） | 自研 | 待验证；登录≠采集授权 | **未通过（证据不足）** |

**许可证与平台规则是独立门槛；任一不通过，不能因为功能分高就推荐产品化。**

---

## 12. 两条路线评分

权重按用户给定：实时 20 / 稳定 ID 25 / 礼物互动 15 / 开播监控 15 / 登录体验 10 / 长期稳定 10 / 本地成本 5。

| 维度（权重） | 路线 A：登录态 WS | 路线 B：匿名 H5 |
| --- | ---: | ---: |
| 实时弹幕可靠性（20） | 17 | 15 |
| 跨场稳定观众 ID（25） | 12 | 8 |
| 礼物及互动事件（15） | 12 | 1 |
| 开播监控（15） | 12 | 11 |
| 登录与用户体验（10） | 6 | 9 |
| 长期稳定性（10） | 6 | 6 |
| 本地运行及维护成本（5） | 3 | 5 |
| **总分** | **68** | **55** |

### 12.1 评分理由

**路线 A（登录 WS）**

- 实时 17/20：推送 + protobuf + 心跳，理论上优于轮询；但**没有一条真实登录态消息**，扣 3。
- 稳定 ID 12/25：`principalId` 是账号级字段，代码支持任意房间；但跨场/跨日/跨路线全未验证，扣 13。
- 礼物 12/15：comment/like/gift/share/system 有代码；follow/enter/recall 没有；礼物零实测，扣 3。
- 监控 12/15：`roomState` 支持任意 eid + 直播状态；真实转换未测；会话过期处理弱，扣 3。
- 登录 6/10：QR start 无签名可用是亮点；但完整登录/sig4/过期提示都未闭环，扣 4。
- 长期 6/10：重连退避设计好；没有 2 小时登录态证据，风控/封号风险高，扣 4。
- 本地 3/5：Node 可做，但 protobuf/签名/设备指纹/依赖重，扣 2。

**路线 B（匿名 H5）**

- 实时 15/20：3 秒轮询真实可用；没有消息 ID、软限流、低密度，扣 5。
- 稳定 ID 8/25：字段 100%，但跨场/跨日/跨路线全未验证，扣 17。
- 礼物 1/15：完全没有，只给 1 分表示平台有礼物概念。
- 监控 11/15：SSR 在播判断 + feed `601` 真实下播已观察；但再开播未测、SSR 限流，扣 4。
- 登录 9/10：零登录、零配置，扣 1 因为“无登录”也意味着无法拿礼物/更全字段。
- 长期 6/10：2 小时长测见 §9；robots/软限流/无维护库，扣 4。
- 本地 5/5：零依赖、单文件、Windows 本地可跑。

### 12.2 单独标注（不用总分掩盖）

| 维度 | 评价 |
| --- | --- |
| 哪条更完整 | **A**（礼物/点赞/分享/稳定 ID 字段），但全部未实测 |
| 哪条更稳定 | **B**（本轮真实跑通；A 无登录态证据） |
| 哪条适合长期维护 | **B**（零依赖、HTTP）；A 依赖签名/指纹/验证码，维护成本极高且不可产品化 |
| 是否需要登录 | A 需要；B 不需要 |
| 能否监听其他公开主播 | A 代码支持（未实测）；B 已实测多房间 |
| 能否达到六平台核心体验 | **都不能完整达到**：B 缺礼物；A 缺真实证据与合规 |
| 哪些达不到 | 消息 ID（H5 无；WS canonical 无、raw 未验证）、关注/进入/撤回（两条都没有）、礼物（B 没有）、跨场身份（两条都未证明） |

---

## 13. 证据与未验证项目

### 13.1 本轮真实执行清单

| 实验 | 时间（Asia/Shanghai） | 结果 |
| --- | --- | --- |
| 匿名 H5 3 房间 45 秒 | 15:41:08–15:41:55 | 6 条，100% 字段，0 重复，p50 3.0–3.4s |
| 匿名 `websocketinfo` | 15:42:10 | `result:2`，无 token |
| 无签名 QR start | 15:42:15 / 15:43:04 | `result:1`，PNG，token |
| 无签名 scan/accept | 15:43–15:44 | `707`，非签名错误 |
| 6 房间活跃度抽样 | 15:48:30–15:48:55 | 2 个房间有消息（5 + 1） |
| 2 小时 3 房间长测 | 15:48:49–17:48:52 | 555 条 / 229 用户 / 0 重复 / 0 HTTP 错误；`juedidatou` 13 分钟后 601 |
| 20 秒本地断网对照 | 15:50:16–15:54:18 | 68 轮询，0 错误，0 重复 |
| `601` 语义复测 | 17:50 | `result:601`，`error_msg:"直播已停止"` |
| SSR 限流观察 | 15:46–15:47 | “请求过快，请稍后重试” |
| catbus 源码阅读 | 15:37–16:10 | 登录/WS/事件/签名/验证码/许可证 |

### 13.2 未验证 / 未执行

- 登录态 WS 的任何真实消息、礼物、点赞、分享；
- 真人扫码、callback、passToken、直播站换票；
- `websocketinfo` 在登录态下是否强制 sig4；
- 跨场/跨日/跨路线稳定 ID；
- 真实再开播（下播已由 `601` 观察，但未观察再开播）；
- 高流量截断、cursor 过期、IP 限流恢复；
- 10+ 房间并发；
- 进程重启恢复；
- 快手用户协议/直播规则的逐条法律意见。

### 13.3 什么证据可以把 C 提升到 B

必须同时满足：

1. **一次真人扫码**完成登录，且**不**使用签名/设备指纹/验证码求解；
2. 登录态 `websocketinfo` 返回 token + WS URL，收到真实弹幕；
3. 同一账号监听**另一个公开主播**成功；
4. 同一观众在两个房间/两天出现同一 ID（或至少证明 `principalId` 是账号级）；
5. 至少 2 小时、3 房间、含一次真实再开播（下播已由 `601` 观察）；
6. 合规结论：允许自动访问该接口/该协议。

缺任何一项，都不能写“快手已具备六平台同等能力”。

---

## 14. 是否建议进入 G2

### **C — 暂缓。不建议现在进入 G2 正式开发。**

理由：

1. **最关键的身份能力没有证据**：跨场/跨日/跨路线稳定 ID 全未验证；这直接决定 LiveMemory 的长期画像能否成立。
2. **登录态 WS 没有真实样本**：只有 catbus 源码；而 catbus 的实现方式（签名/指纹/验证码）被用户边界明确禁止。
3. **匿名 H5 的合规门槛未过**：`robots.txt` 对普通 agent `Disallow: /`；软限流已经出现。
4. **礼物/点赞/分享零实测**：登录路线的主要优势仍是“代码里有”。
5. **开播监控的真实转换未观测**：不能证明自动开始/结束可靠。

**不是 D**：匿名聊天真实可用，扫码登录第一步真实可用，技术路径没有被平台彻底封死。
**不是 B**：B 需要“核心功能基本可行”；目前只有聊天这一项。

**如果用户愿意做一次真人扫码实验**，可以重开一个很小的 G1.5：
只验证“无签名扫码 → 直播站换票 → websocketinfo → 一条真实弹幕 → 另一个主播房间”，
不写生产代码。通过后再讨论 G2；不通过则保持 C，登录路线按 D 处理（对 LiveMemory 不可用）。

### 14.1 对最终问题的直接回答

> **“快手能否像 LiveMemory 已有六个平台一样，成为一个可供普通主播长期使用的正式平台？”**

**现阶段不能。** 不是“永远不能”，而是**当前证据不足以支持“能”**：

1. **身份不成立**：快手 H5 能给数字 `userId`，但没有任何跨房间、跨日期或登录态/匿名之间的
   同一观众证据；长期画像的核心前提没有验证。六个已发布平台里，稳定 ID 是可用的基础能力；
   快手目前只有“字段存在”，不是“身份已验证”。
2. **登录态 WS 不成立**：没有一条真实登录态弹幕/礼物；catbus 的实现方式（sig4、设备指纹、
   验证码求解、TLS 伪装）被产品边界明确禁止。若不使用这些，能否拿到 `websocketinfo` token
   仍是未知数。
3. **合规不成立**：H5 域名 `robots.txt` 对普通 agent `Disallow: /`，登录也不等于平台授权；
   没有书面合规结论。
4. **体验不完整**：匿名路线没有礼物/点赞/分享；登录路线即使成功，canonical event 也没有消息 ID
   （raw 是否有 id 未验证），关注/进入/撤回也没有实现。
5. **稳定性仍不完整**：匿名 H5 的 2 小时/3 房间已跑通，但再开播、登录态 2 小时、高流量截断、
   10+ 房间都未验证。

**什么时候可以说“能”？** 至少同时满足：

- 一次**干净**的真人扫码登录（不实现签名/指纹/验证码），能收到真实弹幕；
- 登录账号能监听**另一个公开主播**；
- 同一观众跨两个房间/两天保持同一 ID（或证明 `principalId` 是账号级）；
- 2 小时、3 房间、真实再开播（下播已由 `601` 观察）；
- 合规书面允许。

在这些证据出现之前，快手只能是一个“有技术线索的候选平台”，不能作为第七个正式平台发布。

---

## 15. G2 需要实现的功能清单（仅在 G1.5 通过后）

### 15.1 准入前置

- [ ] 合规书面结论：是否允许自动访问 `livev.m.chenzhongtech.com` / 登录态直播接口；
- [ ] 明确“登录≠采集授权”，在隐私说明中如实写；
- [ ] 明确不实现签名/设备指纹/验证码求解；若平台要求，停止；
- [ ] 平台标签：「非官方协议 / 实验性」；不得写“官方授权/合规”。

### 15.2 身份

- [ ] `platform_uid = String(userId)`（H5）或 `String(principalId)`（WS），二选一，**不得混用**；
- [ ] 跨场/跨日证据表；没有证据时 `source_quality=unknown`；
- [ ] 昵称只做展示，不做主键；改名保留历史；
- [ ] 匿名/缺失 ID 的消息：`viewer_uid=null`，不建长期档案。

### 15.3 事件

- [ ] chat：`content/name/uid/time`；`external_id=null`；指纹去重；
- [ ] gift：名称、数量、发送者、`unitPrice`/KSCOIN 原值；`amount_minor=null`、`value_kind=unknown`；
- [ ] like/share：能取则取，取不到标 `NOT-OBSERVED`；
- [ ] follow/enter/recall：**不实现**，除非有真实样本与字段；
- [ ] 消息 ID：两条路线都没有；不得伪造。

### 15.4 监控

- [ ] `src/monitoring/detectors/kuaishou.mjs`；
- [ ] `observeChannel(eid)`：缓存 `liveStreamId`，识别 `请求过快` → `RATE_LIMITED`；
- [ ] `connectDetected` → 适配器；
- [ ] 下播确认：SSR 无 id + feed 404 + 连续确认，排除限流；
- [ ] 多频道、重启恢复、真实再开播验收（下播已由 `601` 观察）。

### 15.5 登录与凭据（仅当干净扫码可行）

- [ ] 本地二维码 PNG 显示，不上传；
- [ ] `passToken` 只存 `EncryptedJsonStore`，路径明确、可一键清除；
- [ ] 6 分钟临时票据不落盘；
- [ ] 过期提示、主动退出、清除；
- [ ] 不复制 Cookie、不要求密码、不要求开发者 API。

### 15.6 稳定性

- [ ] ≥2 小时、≥3 房间、不同活跃度；
- [ ] 断网 30 秒、重连、cursor 续传；
- [ ] 记录消息数、ID/时间/消息 ID 覆盖率、重复率、重连次数、延迟、CPU/内存、错误类型；
- [ ] 进程重启恢复；
- [ ] 资源释放（定时器、WS、AbortController）。

---

## 附录 A：本轮 PoC

位置：`research/kuaishou-g1/`

| 文件 | 用途 |
| --- | --- |
| `probe.mjs` | 零依赖 CLI：`discover/status/watch/ws-anon/qr-probe/login/auth/cleanup` |
| `README.md` | 用法、边界、实测摘要 |

```bat
node research/kuaishou-g1/probe.mjs discover --limit 8
node research/kuaishou-g1/probe.mjs status --room https://live.kuaishou.com/u/<eid>
node research/kuaishou-g1/probe.mjs watch --room <eid> --room <eid> --seconds 120
node research/kuaishou-g1/probe.mjs watch --target <eid>:<liveStreamId> --seconds 7200 ^
  --out research/kuaishou-g1/.state/run.json
node research/kuaishou-g1/probe.mjs watch --target <eid>:<liveStreamId> --seconds 240 ^
  --drop-at 60 --drop-ms 20000
node research/kuaishou-g1/probe.mjs ws-anon --room <eid>
node research/kuaishou-g1/probe.mjs qr-probe --flow
node research/kuaishou-g1/probe.mjs login --room <eid> --wait 180
node research/kuaishou-g1/probe.mjs cleanup
```

**安全边界**：

- 只访问公开直播间；不登录（`login` 只在用户主动运行且有手机扫码时使用）；
- 不保存聊天原文/昵称/头像/ID 列表/凭据；
- `.state/` 已加入 `.gitignore`；`cleanup` 删除二维码和状态目录；
- 不引入 npm 依赖；不修改 `src/`、数据库、UI、AI、EXE。

## 附录 B：版本与 Git

| 项目 | 值 |
| --- | --- |
| 基线 | `kuaishou-g0` @ `25ee5a9` |
| `main` | `6f71f56`（未改） |
| v0.16.0 | Tag/Release/EXE 未动 |
| 本轮分支 | `kuaishou-g1`（从 `kuaishou-g0` 创建，未 Push） |
| 提交 | `a1a99ce`（`docs: verify Kuaishou G1 dual-route feasibility (C)`）；记录提交见 STATUS §0.57.5 |

## 附录 C：G1.5 最小实验协议（需用户授权账号与手机）

目的：只回答一个问题——**不使用签名/设备指纹/验证码求解，官方扫码会话能否换到
`websocketinfo` 的 token 与 WS 地址**。不写生产代码，不实现 WS protobuf。

前置：

- 用户本人拥有一个普通快手账号，愿意在自己的手机上扫码；
- 明确同意“本地程序临时持有会话、实验结束即清除”；
- 不要求密码、不复制 Cookie、不使用第三方签名/云端；
- 目标房间是**另一个公开主播**（不是扫码账号自己的直播间）。

步骤：

1. 运行：

   ```bat
   node research/kuaishou-g1/probe.mjs login --room <另一个公开主播 eid> --wait 300
   ```

2. 打开输出的 `qr.png`，用快手 App 扫码并确认；
3. PoC 在内存中完成 callback → 直播站 `passToken` → `userLogin` → `websocketinfo`；
4. 记录以下结果（PoC 已输出，不含 token/cookie 值）：

   | 字段 | 期望 | 失败含义 |
   | --- | --- | --- |
   | `callback.result` | 1 | 扫码/回调失败 |
   | `callback.hasPassToken` | true | 登录未完成 |
   | `passTokenLogin.result` | 1 | 直播站换票失败 |
   | `passTokenLogin.hasAuthToken` | true | 没有 `.at` |
   | `userLogin.result` | 1 | 直播站 userLogin 被拒 |
   | `userLogin.hasLiveSt/hasLivePh` | true | 没有直播票据 |
   | `websocketInfo.result` | 1 | 被风控/需要签名 |
   | `websocketInfo.hasToken` | true | 没 token |
   | `websocketInfo.hasWebsocketUrls` | true | 没接入地址 |

5. 如果 `websocketInfo` 返回 `result=2` 或 `400002`，停止；**不要**加签名、不要过滑块、不要换 IP 重试。
6. 如果返回 token + URL，下一步才是“干净 WS 客户端”：
   需要自己实现 WebSocket 帧 + protobuf 解码（不复用 catbus 的 descriptor/代码），
   并证明至少一条真实 `comment`。这一步属于 G2，不在 G1.5 内。

判定：

- `websocketInfo` 在无签名下成功 → 登录路线**有希望**，可进入 G2 的“干净 WS”验证；
- 返回 2/400002/109 → 登录路线在“不绕过”的边界内**不可用**，按 D 处理；
- 扫码本身失败/用户不愿提供账号 → 保持 C。

**注意**：`login` 只把会话放在内存；`qr.png` 在 `.state/`，实验后运行 `cleanup` 删除。
不要把输出中的任何 token/cookie 粘贴到文档、聊天或 Issue。

## 附录 D：参考链接

- catbus：<https://github.com/cv-cat/catbus>
- catbus `live.ts`：<https://github.com/cv-cat/catbus/blob/master/src/platforms/kuaishou/web/live.ts>
- catbus `commands.ts`：<https://github.com/cv-cat/catbus/blob/master/src/platforms/kuaishou/web/commands.ts>
- catbus `sign.ts`：<https://github.com/cv-cat/catbus/blob/master/src/platforms/kuaishou/web/sign.ts>
- catbus `captcha.ts`：<https://github.com/cv-cat/catbus/blob/master/src/platforms/kuaishou/web/captcha.ts>
- KuaiShou-Spider：<https://github.com/cv-cat/KuaiShou-Spider>
- UniBarrage：<https://github.com/BarryWangQwQ/UniBarrage>
- Live-Barrage：<https://github.com/ykaiqx/Live-Barrage>
- 快手 H5 robots：<https://livev.m.chenzhongtech.com/robots.txt>
