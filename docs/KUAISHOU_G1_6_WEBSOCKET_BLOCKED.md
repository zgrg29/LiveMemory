# 快手 G1.6：修正旧 ID 后的登录态 WebSocket 复测 —— 结论 E（干净客户端无法取得 WS token）

状态：**验证完成（2026-11-17 20:19，Asia/Shanghai）· 结论 E：停止正式接入**
分支：`kuaishou-g1_5`（从 G1.5 `ca804ab` 继续；未 Push / 未合并 main / 未 Tag / 未 Release）
范围：一次真人扫码复测、修正 G1.5 的旧 `liveStreamId` 方法缺陷、多个最新在播房间的 token 探测、授权路径复核、研究文档与测试。
**没有新增 `src/platforms/kuaishou/`，没有修改六个平台生产代码，没有构建候选 EXE。**

> 证据等级：**[实测]** 本次亲自发起并解析；**[文档]** 官方页面/条款原文；**[未执行]** 明确未做；
> **[不可用]** 在“不实现签名/设备指纹/验证码/TLS 伪装”的边界内无法继续。
> 功能标注沿用 **REAL-VERIFIED / CODE-SUPPORTED / NOT-OBSERVED / UNSUPPORTED / BLOCKED**。

---

## 0. 结论（先给答案）

| # | 问题 | 结论 |
| --- | --- | --- |
| 1 | 扫码登录是否成功？ | **是，REAL-VERIFIED（第二次独立复测）**：QR→扫码→确认→passToken→直播站换票→`userLogin=1` |
| 2 | 登录态 WebSocket 是否真正连上？ | **否**。8 个最新在播房间全部 `websocketinfo` HTTP 200 / `result:2` / 无 token / 无 URL |
| 3 | 是否收到真实弹幕？ | **否，NOT-OBSERVED**。没有 token，无法建立连接 |
| 4 | 是否能监听其他公开主播？ | **否（当前干净客户端）**。8 个不同主播的房间都被同一 gate 拒绝 |
| 5 | 观众 ID 是否稳定？ | **未证明**。WS 无样本；H5 跨场证据仍不足，禁止合并命名空间 |
| 6 | 礼物是否可用？ | **UNSUPPORTED / NOT-OBSERVED**。协议字段存在，但无真实连接 |
| 7 | 自动监控是否可用？ | **否（不接入生产）**。研究侧“列表快照”不能当作可靠上下播检测 |
| 8 | 多房间是否可用？ | **否（WS 路径）**。没有 token；H5 仅 3 房间研究样本且 POLICY-BLOCKED |
| 9 | AI 分析是否正常？ | **未执行（不适用）**。没有快手真实会话入库，不能拿模拟数据冒充 |
| 10 | 十语言是否完整？ | **是，未改动**。实测十份字典各 **2,304** 键；本轮没有新增 UI 文案，也没有改 AI 输出语言 |
| 11 | EXE 是否构建成功？ | **未构建**。没有可发布的快手采集功能，构建会制造“已支持”的误导 |
| 12 | 如何实机测试？ | **本轮不提供快手候选 EXE**；见 §8 的复现步骤（研究 CLI） |
| 13 | 是否满足正式发布条件？ | **否**。技术 gate 未过，且平台书面授权未取得 |
| 14 | 剩余风险 | 见 §9：gate 的具体机制未知、身份未证明、条款禁止、无授权渠道 |
| 15 | Git / 候选版本 | 见 §10：只有研究/文档改动；无候选版本、无 Tag、无 Release |

**一句话：G1.5 的“旧 ID 污染”解释已经被排除。** 正常扫码登录可以让会话到达直播站，
但 `liveroom/websocketinfo` 对 8 个刚刚从 `home/list` 取得的、仍在直播的高人气房间全部返回
`result:2`。在不实现签名、设备指纹、验证码或 TLS 伪装的前提下，无法取得 WebSocket token，
因此**没有真实弹幕、没有礼物、没有正式适配器**。按照用户要求，停止正式接入，不伪造成功。

---

## 1. 为什么必须做这次复测

G1.5 的唯一一次登录态 `websocketinfo` 使用了 7 分钟前的 `liveStreamId`：
调用发生在 18:41，ID 来自 18:34，18:44 复核时目标已下播。因此 G1.5 只能写
**NOT-OBSERVED / 结果受污染**，不能写“平台拒绝”。

本轮先修复方法缺陷，再做第二次真人扫码：

1. 登录前从 `home/list` 取一份最新快照；
2. 选当前 watching 最高的房间（9,427 人）；
3. 扫码完成后，**重新取一份快照**；
4. 对最新快照中的 8 个房间逐个调用 `websocketinfo`；
5. 每个 ID 在取得后数秒内使用，不再复用登录前的旧 ID；
6. 不重试签名、不换 IP、不引入浏览器指纹。

实现：`research/kuaishou-g1_5/live-probe.mjs`（新增，零依赖，研究代码）。

---

## 2. 真实时间线与结果

| 时间（Asia/Shanghai） | 步骤 | 结果 |
| --- | --- | --- |
| 20:10:26 | 第一次 `probe.mjs login` 启动，预选 `3xbmb6ecynxtr5s` / `w914OkErPg0` | QR 生成 |
| 20:10–20:15 | 真人扫码（二维码自动刷新 5 次） | 扫码成功 |
| 20:15:xx | `scanResult` → `acceptResult` → `callback` | `passToken` 已下发 |
| 20:15:xx | 直播站 `getCdns` / `passToken` 换票 | `result:1`，拿到 `kuaishou.live.web.at` |
| 20:15:xx | `userLogin` | `result:1`，拿到 `live.web_st/_ph` |
| 20:16:xx | `websocketinfo`（登录前旧 ID） | `result:2`，无 token |
| 20:16:xx | 20 秒后重试 | 仍 `result:2` |
| 20:17:45 | 第二次 `live-probe.mjs` 启动，选择 `KGOU5678` / `cpOytdXqitM`（9,427 watching） | QR 生成 |
| 20:18:xx | 真人扫码并确认 | 登录链路再次全部 `result:1` |
| 20:18:55 | 登录后新快照，8 个最新房间逐个探测 | **8/8 `result:2`，0 token，0 URL** |

### 2.1 八个候选房间

候选均来自登录后的同一份 `home/list` 快照，按 watching 降序：

| # | eid | liveStreamId | watching | websocketinfo |
| ---: | --- | --- | ---: | --- |
| 1 | `KGOU5678` | `cpOytdXqitM` | 9,427 | HTTP 200 / result 2 / no token |
| 2 | `gy321321321` | `UPd7_X9Ok5U` | 3,321 | HTTP 200 / result 2 / no token |
| 3 | `zj2632726957` | `I68s9IFb5_A` | 2,890 | HTTP 200 / result 2 / no token |
| 4 | `dd9898990` | `8ffqQOLdZQk` | 2,832 | HTTP 200 / result 2 / no token |
| 5 | `aa546515091` | `3btEb9XVm8Y` | 1,624 | HTTP 200 / result 2 / no token |
| 6 | `3xhzsckti2mhh5e` | `VgLsJqlTLf4` | 1,343 | HTTP 200 / result 2 / no token |
| 7 | `beimu0315` | `9s1rdPsJF3U` | 820 | HTTP 200 / result 2 / no token |
| 8 | `SANQIANOOO` | `TxH7hAdm-gE` | 819 | HTTP 200 / result 2 / no token |

聚合证据：`research/kuaishou-g1_5/evidence/g1.6-websocket-probe.json`（只含房间/结果，不含凭据或聊天原文）。

---

## 3. 这次结果证明了什么

### 3.1 已证明

- **登录链路仍然真实可用**：第二次独立扫码后，`passToken`、直播站换票、`userLogin` 全部 `result:1`。
- **不是“旧房间已下播”**：8 个刚取得的最新 ID 全部失败；其中多个房间有数千人观看。
- **不是“整个直播 API 被 IP 限流”**：同一登录会话下 `home/list` 正常返回 48 个房间；
  第一次尝试中 `gift-list` 也返回了 token；只有 `websocketinfo` 一致返回 2。
- **不是“未登录”**：`userLogin=1`，Cookie 名称包含 `kuaishou.live.web_st` / `_ph`。
- **失败形态稳定**：HTTP 200、`result:2`、无 `error_msg`、无 `token`、无 `websocketUrls`。

### 3.2 仍不能证明

- **不能证明“必须 `__NS_hxfalcon`”**：我们没有实现签名，也没有对照实验；只能确认
  “当前干净客户端缺少某个必要的平台侧条件”。
- **不能证明“换一个 IP/账号就会成功”**：没有换 IP、没有多账号，也不应通过换 IP 规避。
- **不能证明 WebSocket 协议本身不可用**：token 之前的 gate 已经阻断，协议层没有样本。
- **不能证明观众 ID/礼物/点赞/分享**：没有真实 WS 帧。

### 3.3 最可能的 gate（按证据强度）

| 假设 | 支持 | 反证/限制 |
| --- | --- | --- |
| 缺少 `__NS_hxfalcon` / `__NS_sig3` 等客户端签名 | catbus 对 `websocketinfo` 总是签名；同一接口匿名和登录态都返回 2 | 没有文档证明它是唯一条件；实现它属于禁止的“非公开签名复现” |
| 缺少 webweapon/gdfp 设备/风控 Cookie | 登录会话没有 `kwfv1`/`kwscode`/`kwssectoken`；它们由官方 kws/kwf 脚本生成 | 生成它们属于设备指纹伪装，禁止 |
| 浏览器专属的请求上下文 | 官方 web 客户端在页面内请求；我们的纯 HTTP 客户端没有完整浏览器环境 | 不能因此引入 TLS/JA3 伪装或浏览器自动化 |
| 平台侧对第三方读取的访问控制 | 条款要求书面许可；接口一致拒绝 | 这不等于“签名是唯一障碍”，但足以阻止继续 |

**结论：在“不绕过访问控制、不实现非公开签名/设备指纹/验证码/TLS 伪装”的边界内，
该路线不可用。** 不再尝试替代签名服务、换 IP、Cookie 导入或浏览器中继。

---

## 4. 平台授权复核（与技术要求分开）

### 4.1 三个判断不能混为一谈

| 维度 | 结论 |
| --- | --- |
| 正常扫码登录是否成功 | **是**（REAL-VERIFIED，两次） |
| 技术上是否能访问 WebSocket | **当前干净客户端不能**：token 端点 8/8 拒绝 |
| 是否取得第三方自动采集/公开分发的授权 | **没有**。需要快手书面许可；扫码登录不等于授权 |

### 4.2 官方条款与官方接口

- 《快手软件许可及服务协议》七、1.1 / 七、1.4 / 八、1 / 十、1：
  禁止以机器人、蜘蛛或未经授权的第三方工具监视、复制、读取平台内容；数据使用需**书面许可**。
  原文取得方式与摘录见 `docs/KUAISHOU_G1_5_DUAL_MODE.md` §3.2。
- `liveopen.kuaishou.com`：定位为“快手云直播 / 直播开放平台”，提供 OBS 推流、拉流地址，
  **不是读取任意直播间聊天的 API**。
- `open.kuaishou.com`：小程序 / 直播小玩法文档。官方确有“直播弹幕玩法”的开放能力，
  但它是给**已入驻的弹幕玩法开发者**、围绕**自己绑定的 roomCode / app_id** 使用的服务端接口，
  需要 `app_id` + `app_secret` + `sign`，不是“输入任意公开主播链接即可读取聊天”的通用 API。
  参考：
  - [直播小玩法介绍](https://open.kuaishou.com/miniPlayDocs/introduction/Barragegameplay/introduction.html)
  - [主播双人连屏文档（含 `roomCode`/`sign` 接口示例）](https://open.kuaishou.com/miniPlayDocs/technologyrelated/Affiliatedability/basicability/Linkedscreen.html)
- 官方“法律声明 / 政策”页：<https://www.kuaishou.com/about/policy>。

### 4.3 因此

1. **不能把“扫码成功”写成“已获授权”。**
2. **不能把“官方有小玩法接口”写成“LiveMemory 可以用官方 API 读任意主播弹幕”。**
3. 若要走官方路线，需要快手书面许可/合作，并明确允许：
   - 读取哪些直播间（仅自己房间？授权主播？所有公开房间？）；
   - 读取哪些字段（昵称、稳定 ID、弹幕、礼物、点赞、分享）；
   - 是否允许本地保存、AI 分析、长期画像；
   - 是否允许公开分发客户端。
4. 在这些问题得到书面答复前，**不启用生产采集、不构建含该功能的正式 EXE、不发布**。

---

## 5. 为什么没有继续写正式适配器

用户要求：“如果无法通过允许的方式获得实时数据，停止正式接入，不要伪造成功。”
本轮满足停止条件：

- G1.6 已排除旧 ID 解释；
- 8 个最新房间全部无法取得 token；
- 唯一可能继续的方向需要实现被明确禁止的签名/设备指纹/验证码/TLS 伪装；
- 平台条款要求书面许可，当前没有。

因此：

- **没有** `src/platforms/kuaishou/`；
- **没有** `/api/kuaishou/*`；
- **没有** UI 页签、监控 detector、数据库迁移；
- **没有** 版本号变更、候选 EXE、Tag、Release；
- **没有** 把 H5 匿名路线重新启用作为替代。

这不是“研究阶段停滞”，而是按门禁在真实证据面前停止。

---

## 6. 研究侧修正：`home/list` 不是完整房间清单

G1.5 的 `detectLiveStatus()` 把“在非空 `home/list` 中找不到 eid”判为 `offline`。
G1.6 实测发现：连续请求返回不同的 48 个房间，多个确定在播的房间在下一次快照中消失。
这说明它是**轮播推荐列表**，不是完整库存。

已修正 `research/kuaishou-g1_5/lib/status.mjs`：

- 找到 eid → `live`；
- 未找到但列表非空 → **`unknown` + `NOT_IN_RECOMMENDATION_SNAPSHOT`**，不再 `offline`；
- 空列表 → `unknown + EMPTY_LIST`；
- 只有房间级响应或完整库存才能判 `offline`。

对应测试已从“期望 offline”改为“期望 unknown”，并保留限流/空列表回归。
这是修正研究代码的真实缺陷，不是为了让测试通过而放宽断言。

---

## 7. 能力矩阵（本轮真实状态）

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 扫码登录 | **REAL-VERIFIED** | 两次真人扫码；无签名/指纹/验证码 |
| 登录保持（进程内） | **CODE-SUPPORTED** | 会话只在内存；未做跨进程加密持久化 |
| WS token | **BLOCKED** | 8/8 最新房间 `result:2` |
| 实时弹幕 | **NOT-OBSERVED** | 未建立 WS |
| 观众昵称 | **CODE-SUPPORTED** | 仅协议字段；无真实 WS 样本 |
| 稳定观众 ID | **NOT PROVEN / UNSUPPORTED** | 无 WS 样本；跨场/跨日/跨路线均未证明 |
| 消息 ID | **CODE-SUPPORTED** | 协议有 feed id；未观测 |
| 礼物/点赞/分享 | **UNSUPPORTED / NOT-OBSERVED** | 未连接 |
| 自动开播监控 | **NOT AVAILABLE** | `home/list` 轮播，不能作可靠上下播判断 |
| 多房间 | **NOT AVAILABLE (WS)** | 无 token |
| 断线重连 | **CODE-SUPPORTED** | 仅离线单测；无真实连接 |
| SQLite/AI/画像/UI | **未接入** | 不适用 |

---

## 8. 如何复现（研究 CLI，不面向普通用户）

```bat
:: 1) 单元测试（离线）
node --test --test-isolation=none research/kuaishou-g1_5/tests/prototype.test.mjs

:: 2) 登录 + 最新 8 个房间 token 探测（需要真人扫码）
node research/kuaishou-g1_5/live-probe.mjs --wait 600 --listen 120 --candidates 8

:: 3) 查看结果（只含房间 id/结果，不含凭据）
type research/kuaishou-g1_5\.state\ws-token-probe.json
```

扫码页：`research/kuaishou-g1_5/scan.html`（每 3 秒加载 `.state/qr.png`，二维码约 58 秒过期自动刷新）。

**不要**在复现中加入签名、设备指纹、验证码求解、TLS 伪装、代理换 IP 或第三方签名服务。

---

## 9. 剩余风险与未解决问题

1. **gate 的具体机制未知**：无法区分签名、风控 Cookie、浏览器上下文或平台侧授权控制；
   但无论哪一种，都在禁止绕过的范围内。
2. **无平台书面授权**：即使未来技术上打通，也不能公开分发自动采集功能。
3. **身份未证明**：快手 H5 的 `userId` 与登录 WS 的 `principalId` 是否同一命名空间没有证据；
   不得合并 `kuaishou:h5:*` 与 `kuaishou:ws:*`。
4. **`home/list` 不可靠**：不能用于真实上下播监控；没有房间级公开状态接口的可靠证据。
5. **二维码/登录会话**：当前研究 CLI 只在内存保存；生产化需要加密凭据库、过期提示、退出登录，
   但这些只能在实际采集可行后才有意义。
6. **条款风险**：官方条款要求书面许可；本地运行不改变平台规则。
7. **无真实礼物/点赞/分享样本**：全部 `NOT-OBSERVED`。
8. **无候选 EXE**：本轮不构建，避免让用户误以为快手功能可用。

---

## 9.5 本轮验证

| 项目 | 结果 |
| --- | --- |
| 快手原型单测 | **10 passed / 0 failed**（含轮播列表缺席回归） |
| 全量 unit + integration | **1,177 passed / 0 failed / 0 skipped**（326,590 ms） |
| 十语言字典 | 10 份 × **2,304** 键；键集 0 缺失 / 0 多余 |
| 语法检查 | `node --check` 通过（`live-probe.mjs`、`status.mjs`） |
| 生产代码差异 | **0**：没有 `src/`、`package.json`、`scripts/`、`dist/` 改动 |

全量测试通过只说明现有六平台没有被研究改动破坏，**不代表快手平台验收通过**。

## 10. Git 与交付状态

| 项目 | 值 |
| --- | --- |
| 分支 | `kuaishou-g1_5` |
| 起点 | `ca804ab`（G1.5 文档提交） |
| 本轮改动 | 研究 CLI/状态修正/测试/证据/文档；无 `src/`、`package.json`、`scripts/`、`dist/` |
| 版本 | 仍 `0.16.0`；未改 |
| 候选 EXE | **无** |
| Tag / Release | **无** |
| Push / Merge main | **未执行** |
| 工作区 | 见提交后的 `git status` |

---

## 11. 需要用户完成的事项

1. **授权**：向快手申请书面许可/商务合作，明确是否允许第三方本地客户端读取公开直播间聊天、
   保存与分析数据、公开分发。没有这一步，不应发布。
2. **官方接口范围**：若快手提供正式接口，请给出文档、允许的房间范围、字段、配额与审核要求。
3. **如果只想要“自己的直播间”**：可评估快手官方直播伴侣/小玩法能力，但它与
   “监听其他公开主播”不是同一需求，不能混写。
4. **不要提供/使用**：第三方签名服务、Cookie 导入、设备指纹、验证码破解、TLS 伪装或换 IP 规避。
5. 在授权与官方接口明确前，本轮结论保持 **E（停止正式接入）**。

---

## 12. 相关文件

- `research/kuaishou-g1_5/live-probe.mjs`（G1.6 新探测）
- `research/kuaishou-g1_5/lib/status.mjs`（轮播列表修正）
- `research/kuaishou-g1_5/tests/prototype.test.mjs`（10 个离线测试）
- `research/kuaishou-g1_5/evidence/g1.6-websocket-probe.json`（脱敏证据）
- `research/kuaishou-g1_5/README.md`（命令与边界）
- `docs/KUAISHOU_G1_5_DUAL_MODE.md`（G1.5 完整报告与条款原文）
- `docs/PLATFORM_ADMISSION.md`（准入与停止条件）
