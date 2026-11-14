# RC0 P0-4：YouTube 暂时性网络失败误判直播结束（2026-11-14）

本轮只修复 P0-4：YouTube 采集在 429、5xx、断网、HTTP 200 异常结构、continuation 失效时被错误解释为直播结束。未开发新功能，未改 AI 架构，未做数据库备份，未改 Bilibili 生命周期，未 Push/Tag。

## 1. 修复前审计（逐条核实）

| 线索 | 代码位置 | 结论 |
| --- | --- | --- |
| 429/网络累计 8 次后 `finish('connection_failed')` | `src/platforms/youtube/anonymous/adapter.mjs` `#handlePollError` | **存在**。阈值判断在 backoff 之前，直接 `#finish`；`SessionManager` 随后把 session 置 `ended` |
| `page.ended` 直接 `finish('chat_ended')` | adapter `#poll` | **存在**，且 parser 只在缺少 `continuationContents` 时设置 `ended:true` |
| HTTP 200 缺 continuation 返回 `ended:true,invalid:true` | parser `parseChatResponse` | **存在**；adapter 完全忽略 `invalid` |
| adapter 未区分 invalid 与真实结束 | adapter | **存在** |
| 文档声明网络/5xx 退避不结束 | `docs/PLATFORM_INTEGRATIONS.md` §3.3 | **与代码相反**，本轮已修正 |

额外确认的同类问题：

1. 观看页一次 `state='ended'` 或 `state='video'` 即结束，无二次确认；`onEnd` 后没有 generation 失效保护。
2. `openChat` 刷新失败后，下一轮继续用旧 continuation poll；有 actions 但无新 continuation 的响应被当成功并复用旧 token。
3. 错误文案 `youtubeWebProtocol` / `youtubeWebBlocked` 仍建议使用 v0.5.0 已删除的官方 API。

## 2. 修复前复现（失败测试）

新增 `tests/unit/youtube-lifecycle-regression.test.mjs`，直接驱动 adapter + 可控 client + 注入 timer（避免 30 秒真实退避拖慢测试）。

命令：

```bat
node --test --test-isolation=none tests/unit/youtube-lifecycle-regression.test.mjs
```

修复前结果：**7 failed / 1 passed**。

| 用例 | 修复前实际 |
| --- | --- |
| 10 次 429 | `ended.length=1`，session 被判定结束 |
| 12 次网络失败 | `ended.length=1` |
| 500/502/503 | `ended.length=1` |
| HTTP 200 `{}` | parser `ended=true`，立即 `chat_ended` |
| 6 种异常 200 | 第一个异常即 end |
| stale + 3 次 openChat | adapter 继续 poll stale token |
| 单次观看页 ended / `video` | 立即 `broadcast_ended` |
| 用户 stop | 通过（唯一通过） |

同时保留旧集成测试的“假直播结束”路径，但改成真实形状：聊天返回异常 200 + 观看页 returned ended，而不是依赖 `{}` 直接结束。

## 3. 设计

### 3.1 连接状态与直播生命周期分离

```text
sessions.status = live / ended / interrupted      （本地采集）
adapter.state   = connected / reconnecting / failed / stopped
sessions.platform_status = live / ending / ended / unknown
```

- 429、500/502/503/504、网络/DNS/超时、HTTP 200 缺结构、continuation 缺失/无法解析：
  - `reconnecting`，失败次数达到阈值后 `failed`；
  - `detail.retrying/recoverable/sessionPreserved=true`，`retryInMs/nextRetryAt/lastFailureCode` 可观测；
  - 继续指数退避：`min(60s, 1s * 2^(n-1))`；429 使用 `max(Retry-After, 30s)`，上限 5 分钟；
  - **绝不调用 `onEnd`**，`sessions.status` 保持 `live`。
- 失败期间仍每 60 秒检查一次观看页，避免“聊天接口永久失效但直播已明确结束”永远停在重连。

### 3.2 结束证据

| 事件 | 证据要求 | 结束原因 |
| --- | --- | --- |
| 用户主动停止 | 用户操作，独立路径 | `user`，立即 |
| 平台下播 | 观看页 `state=ended`，约 2 秒后第二次仍 ended | `platform_ended`，`platform_status=ended`，`platform_end_quality=poll` |
| 聊天明确结束 | 聊天页明确 text；观看页 ended，或第二次聊天页仍 ended | `chat_ended` |
| 聊天功能关闭 | 聊天页明确 text；观看页 ended，或第二次聊天页仍 disabled | `chat_disabled` |
| 单次 ended / ordinary video / 读取失败 | 不足 | 不结束 |

- 确认期间写 `platform_status=ending`（UI「正在确认下播」）；确认失败恢复 live/unknown。
- 聊天明确关闭但观看页不可确认时，`platform_status=unknown`，不冒充“平台下播”。
- `onEnd` 每个 adapter 最多一次；`#finish` 递增 generation，使在途 poll 失效。

### 3.3 continuation 与 session 连续性

- `WEB_STALE` 只设置 `continuationNeedsRefresh=true`；下一轮先 `openChat` 取新 continuation，再 poll。
- `openChat` 失败只退避；不再 poll 已知失效 token。
- `parseChatResponse` 对“有 actions 无新 token”返回 `invalid`，但 actions 仍先 `#consume` 入库，避免丢最后几条消息；重复由 `EventIngest` 的 `UNIQUE(session_id, dedupe_key)` 吸收。
- 重连只改 adapter 内部 continuation/状态，不创建/替换 session，不重置计时器、统计或观众。

## 4. 修改文件

### 源码

- `src/platforms/youtube/anonymous/parser.mjs`
- `src/platforms/youtube/anonymous/adapter.mjs`
- `src/platforms/youtube/anonymous/client.mjs`
- `src/platforms/youtube/errors.mjs`
- `src/platforms/youtube/service.mjs`
- `src/server/index.mjs`（测试注入 + loopback-only EXE 假服务地址；不影响默认行为）
- `src/web/js/pages/live.js`
- `src/web/js/pages/shared.js`
- `src/web/i18n/zh-CN.json`、`ja.json`、`en.json`

### 测试

- 新增 `tests/unit/youtube-lifecycle-regression.test.mjs`（10）
- 新增 `tests/integration/youtube-lifecycle.test.mjs`（2）
- 更新 `tests/unit/youtube-anonymous-parser.test.mjs`
- 更新 `tests/unit/live-status-ui.test.mjs`
- 更新 `tests/integration/youtube-anonymous-session.test.mjs`
- 更新 `tests/integration/youtube-auto-monitoring.test.mjs`

### 文档

STATUS、HANDOFF、ROADMAP、PLATFORM_INTEGRATIONS、ARCHITECTURE、DATA_MODEL、TEST_PLAN、UI_DESIGN、CHANGELOG、本日志。

## 5. 修复后自动化

### 5.1 专项

- Unit 10/10：10×429、12×网络、9×5xx、缺 continuation、6 种异常 200、stale 重取、单次 ended 不结束、两次 ended 只一次、聊天 ended 二次确认、用户 stop。
- Integration 2/2：真实 server/SessionManager/SQLite + 假 YouTube：
  - 429/500/异常 200 期间同一 session 保持 live，消息/观众不丢；
  - 恢复后同一 session 继续，stale 触发 openChat，重放消息去重；
  - 明确 ended 后 `platform_ended`、`platform_status=ended`、结束只一次、计数不变；
  - 用户停止立即 `user`，数据保留。

### 5.2 全量

```bat
node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"
```

**721 passed / 0 failed / 0 skipped**，192,929 ms（2026-11-14）。基线 708；新增/更新净 +13。

### 5.3 Bilibili 回归

`bilibili-adapter`、`bilibili-lifecycle`、`bilibili-service`、`bilibili-status-api`、`bilibili-mapper`、`bilibili-api`、`manual-stop-monitor`、`session-multi`：**53 passed / 0 failed**。未修改 Bilibili adapter 或共享生命周期代码。

## 6. 数据完整性与去重

- 会话：集成测试断言 `sessions WHERE platform_room_id=...` 始终 1 行；重连不新建。
- 消息：故障期间计数不变；恢复后只增加新消息；重放 `msg-1` 不产生第二行。
- 观众：故障前后 `activeViewers` 一致且 ≥2。
- 结束：结束前后 `eventCount/messages/activeViewers` 完全一致。
- 去重键仍为 `(session_id, dedupe_key)`，未改 EventIngest。

## 7. 正式 EXE 与本地假 YouTube（已实测）

| 项目 | 值 |
| --- | --- |
| 文件 | `dist/LiveMemory.exe` |
| 大小 | 96,419,840 bytes（92.0 MB） |
| SHA-256 | `e9fe576931a0562a7969afa3bba188a3418b95374ca68c2d75d09bc6d8805b2f` |
| buildId | `59b7928cb78a` |
| commit | `31886b2d59873b574d3fb1703a0d592396ce42c7` |
| builtAt | 2026-11-14T03:28:37.819Z |
| 资源 | 176 files；12 个必需模块；RT_MANIFEST `requireAdministrator` |

脚本：`scripts/verify-youtube-lifecycle-exe.mjs`。asInvoker 测试副本 + `LIVE_MEMORY_TEST_YOUTUBE_WEB_BASE=http://127.0.0.1:<port>` + 本地假 YouTube：

```text
EXE healthy buildId=59b7928cb78a commit=31886b2...
session ses_01M7C1MH5KBQTKNQET2Q
before outage: messages=3 viewers=2
fake YouTube stopped; waiting 180 s (simulated network outage)
outage lasted 180513 ms; session still live, messages=3
fake YouTube restarted; waiting for reconnect
recovered: messages=4 viewers=2
after stale replay: rows=5, unique=5, session=ses_01M7C1MH5KBQTKNQET2Q
ended: reason=platform_ended platform=ended messages=5
PASS
```

- **是**：正式 EXE 的二进制包含了本轮代码；本地 3 分钟真实 TCP 断连；同一 session 恢复；重放去重；平台结束只一次。
- **不是**：真实 YouTube 网络断网、UAC 双击、真实浏览器点击、真实平台 429/验证码/consent、数小时长直播。

## 8. 边界与未验证

- 真实 YouTube 直播拔网/切网 3 分钟、真实 429/验证码/consent、数小时长直播未验证。
- 真实 UAC 双击、真实浏览器点击未验证。
- 没有访问真实 YouTube 高频请求，没有绕过平台限流。

## 8. P0-5 交接

见 `docs/HANDOFF.md` §0.5：本地 HTTP API 无 token 鉴权，且 EXE 以管理员运行；本机任意进程可省略 Origin 直接调用 API。建议下一轮独立评审 token/cookie、SSE 鉴权、危险操作 broker 与 ACL，不要在本轮顺手加。
