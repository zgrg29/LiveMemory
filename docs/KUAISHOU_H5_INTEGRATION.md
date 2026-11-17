# 快手 H5 预览接入（Kuaishou H5 Preview）

状态：**v0.17.0 已发布 · 预览接入 · 实时 H5 采集默认禁用**
最后更新：2026-11-17

> 本轮按用户明确指示停止“快手登录 WebSocket”研究，复用 G1 已验证的匿名 H5
> 作为**唯一候选技术方案**。G0/G1/G1.5/G1.6 不再重做，不实现扫码登录、签名、
> 设备指纹、验证码或 WebSocket。
>
> **未取得快手书面许可。** 因此实时 H5 网络采集在公开版本默认关闭、不开放生产采集；
> 链接解析、字段解析、SQLite、AI 分析/长期画像、自动监控、十语 UI 与发布 EXE
> 均已集成，并用研究样本/模拟数据完成自动化验收。**v0.17.0 发布的是预览组件，
> 快手不是已支持采集的平台。**

---

## 1. 交付范围

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 直播间 URL / 裸 ID 解析 | ✅ 已实现 | 仅接受 `live.kuaishou.com/u/<id>`、`livev.m.chenzhongtech.com/fw/live/<id>` 与裸 ID；拒绝个人主页、短视频、回放、其他平台 |
| 公开弹幕解析 | ✅ 已实现（研究样本） | 仅 `comment`；昵称、数字 `userId`、毫秒时间、原文；**无消息 ID** |
| 昵称 / 用户 ID / 时间戳 | ✅ 已实现 | 昵称原样保存；`userId` 100% 可得时建立**会话内临时身份**；时间缺失时用接收时间并计数 |
| 消息去重 | ✅ 已实现 | H5 无消息 ID：适配器按 `userId + 时间 + 内容` 指纹去重，`UNIQUE(session_id, dedupe_key)` 兜底 |
| 多直播间隔离 | ✅ 已实现 | 每场独立 adapter、连接状态、session、停止操作；同一 `kuaishou + eid` 不可重复启动 |
| SQLite 会话存储 | ✅ 已实现 | 复用现有 Schema 16，无迁移；所有事件只经 `EventIngest` |
| 单场 AI 分析 | ✅ 已实现 | 复用平台无关的 AI 分析包、Provider、语言快照与恢复 |
| 长期画像 | ✅ 已实现（受身份限制） | 观众 ID 为会话内临时身份，因此**不跨场合并**；单场内画像与 AI 记忆可用 |
| 自动监控 / 上下播 | ✅ 已实现（需授权后才可启用） | 房间页状态探测、低频检查、开播自动录制、`result=601` 结束、连续两次 offline 结束 |
| 异常恢复 | ✅ 已实现 | 网络/超时/限流退避重试；风控/拒绝如实失败；重启后 monitoring 目标恢复 |
| 十语言 UI | ✅ 已实现 | 10 份字典各 **2,351** 键；新增 47 键，键集/占位符零差异 |
| Windows EXE | ✅ 候选可构建 | 内部候选 `LiveMemory.exe`；Manifest `requireAdministrator`；H5 采集默认关闭 |
| 礼物 / 点赞 | ❌ 不支持（NOT-OBSERVED） | 研究样本未观测到；不解析、不展示为已支持 |

---

## 2. 为什么保持禁用

G1.5 已核实并记录在 `docs/KUAISHOU_G1_5_DUAL_MODE.md`：

- 快手《软件许可及服务协议》七、1.1 / 七、1.4 / 八、1 / 十、1 明确禁止以机器人、
  蜘蛛或未经授权的第三方工具监视、复制、读取平台内容；数据使用需书面许可。
- `livev.m.chenzhongtech.com/robots.txt` 对 `User-agent: *` 为 `Disallow: /`。
- G1.6 进一步确认登录态 WebSocket 在当前边界内无法取得 token；不在本轮恢复。

因此本实现：

1. **不发起任何真实 H5 请求**（本轮测试全部使用 fake fetch / 研究样本形状）。
2. `access.enabled` 默认 `false`；`/api/kuaishou/connect` 在任何网络请求前返回
   `KUAISHOU_AUTHORIZATION_REQUIRED`（403）。
3. `/api/kuaishou/room` 在禁用时只做**本地链接解析**，不访问网络。
4. UI 始终展示用户要求的透明告知，并明确“采集未启用”，不提供可点击的“绕过授权”入口。
5. 只有运营者同时设置两个环境变量才启用内部采集：
   - `LIVEMEMORY_KUAISHOU_H5_OPT_IN=1`
   - `LIVEMEMORY_KUAISHOU_AUTHORIZATION_ACK=<内部许可引用>`
   该开关只表示“运营者声明已取得许可”，**不能自动取得授权**，也不验证许可真伪；
   引用值不写日志、不进 API、不进数据库。

---

## 3. 组件与数据流

```text
URL/裸 ID
  └─ src/platforms/kuaishou/link.mjs        （纯解析，始终可用）
       └─ KuaishouService.checkRoom        （禁用时仅返回解析结果）
            └─ status.mjs                  （授权后读取房间页；live/offline/unknown/rate_limited）
                 └─ KuaishouAdapter        （授权后轮询 H5 feed）
                      ├─ transport.mjs     （单次增量请求、cursor、result 分类）
                      ├─ messages.mjs      （comment → canonical draft；无消息 ID）
                      └─ SessionManager → EventIngest → SQLite
                           └─ analytics / AI export / AI jobs / memory / UI
```

- 单一写入路径：适配器只产出 canonical draft，`EventIngest` 负责去重、观众聚合、计数。
- 平台解耦：UI、统计、AI 包不出现 H5 字段名。
- 会话字段：`platform=kuaishou`、`platform_room_id=<eid>`、`broadcaster_id=kuaishou:<eid>`。
- 保留：`platforms: ['kuaishou']`、30 天原文/昵称清理，计数与会话内 ID 保留。

---

## 4. 字段与去重

| canonical 字段 | 来源 | 结论 |
| --- | --- | --- |
| `content` | `liveStreamFeeds[].content` | 原文，不翻译、不替换 |
| `display_name` | `author.userName` | 原样保存；昵称不是身份 |
| `viewer_uid` | `author.userId` | `h5:<userId>@<sessionId>`（会话内临时） |
| `occurred_at` | `time`（毫秒） | 合法范围外/缺失时用接收时间并计数 |
| `external_id` | 无 | **NULL**，不伪造消息 ID |
| `source_quality` | — | `unknown`（身份稳定性未证明） |
| `emotes` / `badges` | 无可靠元数据 | 不写入 |
| 金额 | 无 | 礼物不映射，`amount_minor=null` 也不产生礼物行 |

去重：

1. 适配器内存指纹 `userId + time + content`（每场上限 20,000，超出清空防内存膨胀）。
2. `EventIngest` 的 `UNIQUE(session_id, dedupe_key)`，无消息 ID 时使用确定性 fingerprint。
3. 同一用户在同一毫秒发送两条完全相同的弹幕会被视为重复；这是无消息 ID 的已知限制。

---

## 5. 身份模型（关键）

**跨场用户 ID 稳定性未证明前，不得错误合并观众身份。**

- G1：229 个用户跨 3 个房间重叠 **0**；运行内一致，但跨房间/跨日/跨路线均无证据。
- 因此本轮采用 **session-provisional**：

```text
viewer_uid = h5:<rawUserId>@<localSessionId>
viewer_id  = kuaishou:h5:<rawUserId>@<localSessionId>
```

- 原始 `userId` 保留在 ID 中便于审计；两场直播即使 `rawUserId` 相同，也是两个观众记录。
- 不提供“跨场合并”开关；未来若取得 G3 证据，只能切换到新身份模式并保留历史隔离，
  不得自动改写旧数据。
- 昵称、头像、昵称 hash 都不作为身份。
- 长期画像：单场/单会话内可用；**跨场不聚合**。UI 明示该限制。

---

## 6. 上下播与自动监控

### 6.1 权威信号

- **结束**：H5 feed `result=601` / `671`（`直播已停止`）是权威结束信号。
- **房间页**：`liveStream.id` 出现 → `live`；没有 `liveStream` 且页面含该 `eid` 的真实房间标记
  → `offline`；`请求过快` / 风控壳 → `rate_limited`；其他 → `unknown`。
- **绝不**用 `home/list` 推荐列表缺席判下播（G1.6 已证明列表轮播）。

### 6.2 适配器

- 每 3.2 秒增量轮询；cursor 由平台返回；空批次正常。
- 网络/超时/限流：指数退避（最大 60 秒、最多 8 次连续失败）；恢复后 `reconnects+1`。
- 风控 / 登录要求 / 房间不存在：立即失败并结束 session，不重试绕过。
- 每 60 秒房间页检查：连续 **2 次 offline** 结束；`rate_limited` / `unknown` 不结束。
- 新 `liveStreamId` 出现：结束旧场，绝不把两场拼成一场。

### 6.3 自动监控

- `MONITOR_PLATFORMS` 增加 `kuaishou`；基础间隔 120 秒、抖动 90–180 秒、错误退避到 30 分钟。
- 目标键为 `eid`；场次循环键为 `kuaishou:<eid>:<liveStreamId>`。
- 授权关闭时 **不显示监控开关**，后端也不允许创建目标（`MONITOR_RESTRICTED`），且不发起网络请求。
- 重启后目标保留，由共享 `MonitoringManager` 恢复并错峰检查。

---

## 7. UI 与透明告知

直播页第七个平台页签「快手」，面板始终包含：

> 快手平台对未经授权的自动数据采集存在限制。LiveMemory 并非快手官方产品。使用者应遵守快手平台协议，并确保拥有必要的数据访问权限。第三方接口可能随时变更或停止服务。

其他固定说明：

- 采集未启用 / 内部授权状态（二选一，来自服务端真实 access）。
- 不需要登录、API Key、Cookie 或付费服务；取得授权后直接读取公开 H5 页面与 feed。
- 非官方 / 实验性；可能变更或停止；无续传游标，重连可能漏消息。
- 观众 ID 为会话内临时身份，不跨场合并。
- H5 无消息 ID，按用户 + 时间 + 内容去重。
- 礼物与点赞 **NOT-OBSERVED**，不声称支持。
- 30 天保留与“立即清理”按钮。

禁用状态下仍可粘贴链接并解析出 `eid` / 规范链接，但开始按钮禁用并显示
“未取得采集授权前无法开始记录”。

---

## 8. G0–G6 证据状态

| 阶段 | 状态 | 证据 |
| --- | --- | --- |
| G0 调查 | ✅ 完成 | `docs/KUAISHOU_G0_FEASIBILITY.md` |
| G1 免登录可行性 | ✅ 真实完成（H5） | `docs/KUAISHOU_G1_POC.md`：3 房间 / 555 条 / 229 用户 / 0 重复 |
| G2 字段验证 | ⚠️ 部分（研究样本） | 昵称、`userId`、时间 100%；消息 ID 0%；**本轮未新增真实请求** |
| G3 身份评估 | ❌ 未通过 | 跨场/跨日稳定性未证明；因此会话内隔离 |
| G4 重连/多房间 | ⚠️ 仅模拟/自动化 | fake feed 去重、断线重连、双房间、停止；**无授权下的真实长测** |
| G5 真实 EXE 验收 | ⚠️ 仅发布 EXE 组件验收 | 内部发布 EXE 断言采集禁用、UI/资源/路由/解析；**无真实 H5 采集验收** |
| G6 合并/发布 | ⛔ 阻塞 | 缺书面许可与真实许可下验收；不得发布为已支持 |

**结论：组件可独立使用/评审，平台不可发布为已支持。**

---

## 9. 验收记录

- 全量：**844 unit + 382 integration = 1,226 passed / 0 failed / 0 skipped**（`--test-isolation=none`）。
- Kuaishou 专项：**49 passed / 0 failed**（unit 39 + integration 10）。
- 六平台回归：全量套件通过；未修改六平台协议。
- 十语言：10 × **2,351** 键，键集/占位符 0 差异；真实浏览器 UI **80/80**
  （10 语 × 1440/1024/820/390 × 明暗；告知/授权/身份/礼物说明、无溢出、无原始键；
  每语 1440 light 执行链接解析与禁用开始按钮检查）。
- EXE：99,492,352 B、Build ID `47b42dc8417b`、SHA-256
  `58b21dc9cb362a8f4918924aae6ab12792b198ee342f0a805ddbcb8d830471ac`、`requireAdministrator`、
  `verify-kuaishou-exe` **10/10**、`verify-exe` **11/11**、`verify-help-exe` **14/14**。
- **未执行**：真实 H5 网络采集、真实许可下长测、真实下播→再开播、礼物/点赞观测、跨场身份实验。

---

## 10. 内部发布 EXE

- 构建：`node scripts/build-windows.mjs`（正式候选，`requireAdministrator`）。
- 验收：`node scripts/verify-kuaishou-exe.mjs`（10/10）与既有 `verify-exe.mjs`（11/11）。
- 默认 access 为禁用：EXE 内 `/api/kuaishou/status` 返回 `authorization-required`，
  `/api/kuaishou/connect` 返回 403；不会访问 `live.kuaishou.com` / `livev.m.chenzhongtech.com`。
- 未签名；SmartScreen 可能提示。真实双击 UAC 仍未人工验证。

---

## 11. 剩余阻碍（发布前必须解决）

1. **书面许可**：快手平台条款要求；没有它不得启用 H5 采集或发布为已支持。
2. **真实许可下验收**：真实房间、真实弹幕、真实结束、≥30 分钟、≥2 房间、断线恢复。
3. **身份证据**：跨场/跨日 `userId` 稳定性；在证据前保持会话内身份。
4. **下播/再开播真实样本**：房间页 offline 判定的真实边界。
5. **礼物/点赞**：未观测，保持 `NOT-OBSERVED`；不实现猜测映射。
6. **平台变更风险**：H5 无公开契约，可能随时失效；需在发布说明中如实标注。

---

## 12. 代码与测试索引

| 文件 | 作用 |
| --- | --- |
| `src/platforms/kuaishou/link.mjs` | URL/ID 解析，拒绝非直播输入 |
| `src/platforms/kuaishou/policy.mjs` | 访问门禁、公开投影、内部开关 |
| `src/platforms/kuaishou/http.mjs` | 零依赖 HTTP、错误分类、超时 |
| `src/platforms/kuaishou/transport.mjs` | H5 feed 单次增量请求与 result 分类 |
| `src/platforms/kuaishou/messages.mjs` | comment → draft、时间、会话内身份、指纹 |
| `src/platforms/kuaishou/status.mjs` | 房间页 live/offline/rate_limited/unknown |
| `src/platforms/kuaishou/adapter.mjs` | 轮询、去重、退避、状态确认、停止、capture |
| `src/platforms/kuaishou/service.mjs` | 路由/监控/SessionManager 装配、保留 |
| `src/monitoring/detectors/kuaishou.mjs` | 自动监控解析与错误映射 |
| `tests/unit/kuaishou-*.test.mjs` | 链接、解析、状态、门禁、传输、适配器、UI |
| `tests/integration/kuaishou-*.test.mjs` | 服务/路由/存储/AI 包/监控 |
| `tests/fixtures/kuaishou.mjs` | 研究样本形状的 fake feed/page |
