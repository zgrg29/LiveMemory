# 2026-11-15 TikTok LIVE 接入（feasibility → 实现 → 测试 → EXE）

## 0. 本轮范围

1. 按开发者授权把 `feature/douyin` 合并到 `main`（仅本地）。
2. 从最新 `main` 创建 `feature/tiktok`。
3. TikTok 可行性重新调查（读源码/依赖/许可证/Issue + 真实只读探测）。
4. 实现 TikTok 平台适配器（两种传输）、统一 ingest、SQLite、监控、三语 UI。
5. 自动化测试 + 全量回归 + Windows EXE。

## 1. 抖音合并

- `main`：`git merge --no-ff` 等价合并提交
  **`410bfc3ffacc712b6fd56a9e63f4d5afcca4bcb7`**（父 `d5e9a7c` + `e3cf6e7`），
  提交信息 `Merge branch 'feature/douyin' into main`。
- 合并后工作区干净；`git diff feature/douyin main` 为空。
- 合并后全量：**947 passed / 0 failed / 0 skipped（300,810.97 ms）**。
- 四平台真实回归（合并后、`main` 上）：
  - Bilibili 房间 6（真实 `7734200`）：3 条 chat / 3 个可识别观众 / `ended`。
  - YouTube `4t4AQ15yj1M`（Lofi Girl 直播）：55 条 chat / 55 个 channel id / 10 位活跃观众 / `ended`。
  - Twitch `blastpremier`：13 条 chat / 13 个 `twitch:<id>` / `ended`。
  - 抖音 `708764876300`：3 条 chat / 3 个 `douyin:<id>` / `ended`。
- 未 Push、未 Tag、未 Release、未删除任何分支。

> 环境注意：本机 `.git` 写入需要一次性 full-access；`git checkout main` 由于
> `pages.css` 的 stat 缓存与索引不同步而失败（内容与 HEAD 一致），因此用
> `commit-tree` + `update-ref` + `symbolic-ref` 生成同样的合并提交，工作区内容完全一致。

## 2. TikTok 可行性（详见 `docs/TIKTOK_FEASIBILITY_2026-11.md`）

真实结论：

| 能力 | 结果 |
| --- | --- |
| 房间信息/开播/主播稳定 ID/标题/累计观看 | 公开接口，无需登录与签名服务 |
| 礼物目录（809 个） | 公开接口，无需登录与签名服务 |
| 官方网页匿名聊天 | **403 room/enter**，聊天面板“正在加载”，移动端同样不可用 |
| 未登录直连推送 WS | **被拒**（HTTP 200 代替 101 / 1006） |
| 免费社区签名通道 | **可用**：无 Key、无付费；6/6 真实 chat 带 `user.id` 与 `msgId` |
| 真实礼物/连送/订阅 | **未观测**（频道无送礼） |

关键限制：免费签名通道的新连接突发上限是 **5 次/分钟**（`ratelimit-limit: 5; w=60`），
因此默认 15 秒轮询，429 按 `Retry-After` 退避。

## 3. 实现

新增 `src/platforms/tiktok/`：

| 文件 | 内容 |
| --- | --- |
| `link.mjs` | `@handle` / 裸 handle / `tiktok.com/@user(/live)`；拒绝视频、短链、搜索、其它站点 |
| `protobuf.mjs` | 零依赖 wire 编解码（varint/长度/嵌套/未知字段/截断报错） |
| `messages.mjs` | `ProtoMessageFetchResult` 与 `WebcastResponse` 解码；chat/gift/member/like/social/roomseq/control/sub 映射；`tiktok:<user.id>`；`amount_display` 钻石展示值 |
| `client.mjs` | 公开 `api-live/user/room`、`webcast/room/info`、`webcast/gift/list`（礼物目录 10 分钟缓存） |
| `signer.mjs` | 免费社区签名通道（`baseUrl` 可换自建/兼容服务；429/402/403 明确分类） |
| `adapter.mjs` | 轮询、cursor、msgId 去重（10k）、连送最终态合并 + 超时冲刷、退避、看门狗、两次离线确认、控制消息 |
| `browser-relay.mjs` | 实验性 Chrome/Edge 专用资料目录 + CDP + WS 帧解析；匿名 403 → `TIKTOK_LOGIN_REQUIRED` |
| `service.mjs` | HTTP/监控/SessionManager 粘合；传输选择与能力矩阵；TikTok-only 30 天保留 |
| `transports.mjs` | `auto` / `signer` / `browser` 归一化 |
| `errors.mjs` | `TIKTOK_*` 错误码 |

其它接入：

- `src/monitoring/detectors/tiktok.mjs`：公开接口检查开播；`liveCycleKey = tiktok:<handle>:<roomId>`。
- `src/monitoring/{constants,model,manager}.mjs`：`tiktok` 平台、90 秒基准、2 秒请求间隔。
- `src/server/{index,routes,settings-store}.mjs`：`/api/tiktok/status|transport|room|connect|disconnect|retention/apply`；`tiktokTransport` 设置。
- `src/web/js/pages/live.js` + 三语 i18n：TikTok Tab、房间检查、传输选择、自动监听、能力与限制说明、保留按钮。
- `scripts/build-windows.mjs`：10 个 TikTok 必需模块。

## 4. 自动化测试

新增：

- `tests/unit/tiktok-link.test.mjs`（4）
- `tests/unit/tiktok-messages.test.mjs`（12）
- `tests/unit/tiktok-client.test.mjs`（8）
- `tests/unit/tiktok-signer.test.mjs`（8）
- `tests/unit/tiktok-adapter.test.mjs`（8）
- `tests/unit/tiktok-ui.test.mjs`（8）
- `tests/integration/tiktok-session.test.mjs`（3）
- `tests/integration/tiktok-monitoring.test.mjs`（4）
- `tests/helpers/tiktok-frames.mjs`（合成 payload 构造器，字段编号与真实抓包一致）
- `tests/integration/api-auth.test.mjs`：新增 6 个 TikTok 路由的 401 断言。

## 5. 真实端到端（源码服务器 + 真实直播）

`aljazeeraenglish`（room `7706695538414062349`）：

```
status 200  mode=signer
room   200  uniqueId=aljazeeraenglish roomId=7706695538414062349 anchorUid=7074562477175424046
            anchorName=Al Jazeera English isLive=true title=Al Jazeera English TikTok LIVE
connect 201 session=… state=connected err=none
messages 6 msgs / 5 viewers
chat identity 6/6 chats with tiktok:<id>, distinct 5
sample {"viewerId":"tiktok:7366634237712335877","displayName":"Hi","content":"OUR PRESIDENT …","sourceQuality":"verified"}
stop   200 ended
transport 200 signer
```

## 6. 边界（必须按此口径验收）

- **真实聊天**：已取得真实样本并通过正式服务器入库（6/6 稳定 ID + msgId）。
- **真实礼物/连送/订阅**：已解析 + 自动化测试，**真实事件未观测**。
- **浏览器中继**：实现完成；匿名 403 已实测；**登录后聊天未验证**（无账号）。
- **免费签名通道**：第三方云服务；无 Key、无付费；可能限流/改版；不强制 Business 计划。
- **未验证**：真实 Long-run 断网/下播、多房间并发（受 5 次/分钟限制）、干净 Windows 账户、真实 UAC 点击、TikTok 登录。

## 7. Windows EXE

| 项目 | 值 |
| --- | --- |
| 文件 | `dist/LiveMemory.exe` |
| 大小 | `97,718,784` bytes（93.2 MB） |
| SHA-256 | `3a3e7c597cdb743a6e512a3c086a0a8c89929de57a458bb50fd93cb0f0fd134b` |
| Build ID | `812c0d54f622` |
| source hash | `812c0d54f622056a6fb2fed468c85960a0742ce47c8bada1a5caae34398557b9` |
| commit | `3e6e7d8e25b86084def581a2ba8c250b7124db36` |
| builtAt | `2026-11-15T11:21:11.849Z` |
| 资源 | `226` files；50 个必需模块 |
| RT_MANIFEST | `requireAdministrator` |

验证：

| 脚本 | 结果 |
| --- | --- |
| `scripts/verify-tiktok-exe.mjs`（真实 TikTok + 自动监听 + 重启 + AI + 四平台状态） | **20/20** |
| `scripts/verify-exe.mjs`（启动/重启/硬杀/端口/单实例/不可写目录/CLI） | **10/10** |

## 8. 全量测试

```bat
node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"
```

- **1003 passed / 0 failed / 0 skipped（326,436.09 ms，2026-11-15）**（上一轮 947，本轮 +56）。

## 9. Git

- 分支 `feature/tiktok`；代码与文档提交 **`3e6e7d8e25b86084def581a2ba8c250b7124db36`**
  （`feat: add TikTok LIVE integration`，39 files，+5,713/−29），提交身份匿名。
- `main` 保持 `410bfc3`；**未合并 TikTok、未 Push、未 Tag、未 Release、未删除任何分支**。

