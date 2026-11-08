# 测试计划与结果（TEST_PLAN）

## 1. 策略

| 层级 | 目的 | 位置 |
| --- | --- | --- |
| 单元测试 | 纯逻辑：语言、主题、金额、事件、Emoji/表情、去重、时间、分桶、ZIP、设置、锁、参数、数据目录 | `tests/unit/` |
| 集成测试 | 迁移、落库与聚合、HTTP API、安全校验、SSE、分析包、v1→v2 升级 | `tests/integration/` |
| 启动冒烟 | 启动器真实启动、单实例、命令行三语、EXE | 手工 + `scripts/` |
| UI 验证 | 三主题、三语言、响应式、图表、空状态、AI 任务卡、表情回退 | 手工 + 无头 Edge 截图 |
| 真实平台 | Bilibili 真实直播事件与表情元数据 | 已采样（见第 8 节）；YouTube 未开始 |
| 跨电脑迁移 | 备份导出/导入一致性 | 未开始（M5） |

## 2. 运行方式

```bat
node --test tests/unit tests/integration
```

受限环境（禁止子进程，如某些沙箱）使用单进程模式：

```bat
node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"
```

测试通过 `tests/helpers/temp-dir.mjs` 在 `tests/.tmp/` 下创建隔离数据目录，绝不触碰真实用户数据。API 集成测试使用 `port: 0`（系统分配端口）。

## 3. 覆盖清单

### 3.1 单元

| 文件 | 覆盖 |
| --- | --- |
| `locale.test.mjs` | 语言别名、非法值、跟随系统回退英文、环境变量识别 |
| `theme.test.mjs` | 三种主题、系统解析、存储模式 |
| `money.test.mjs` | 两位/零位小数币种、四舍五入、非法值、精确乘法 |
| `events.test.mjs` | 规范化、身份命名空间、礼物金额、免费/未知金额、别名、时间秒/毫秒、去重键、非法输入、超长文本、Emoji 安全截断、emote 元数据与指纹 |
| `emoticons.test.mjs` | Unicode Emoji / VS16 / 肤色 / ZWJ 保留、grapheme 截断、表情规范化/去重/上限、AI 可读文本、未知表情标记、括号文字不误判、字典/JSON 往返 |
| `time.test.mjs` | ISO/秒/毫秒互转、非法值、时长格式 |
| `hotness.test.mjs` | 桶大小、桶内计数/独立观众/支付、裁剪尾部、进行中桶、空场次、币种分账 |
| `i18n.test.mjs` | 三语 JSON 键一致、非空、占位符一致；启动器三语键一致 |
| `zip.test.mjs` | CRC32 参考值、读写、UTF-8 名、路径穿越拒绝、空归档 |
| `settings-store.test.mjs` | 默认值、加载、损坏回退与备份、校验、原子持久化 |
| `lock.test.mjs` | 获取/释放、存活进程拒绝、陈旧锁接管、损坏锁、PID 判定、runtime 文件 |
| `launcher.test.mjs` | 参数解析、非法端口/语言、未知参数、状态行三语 |
| `data-dir.test.mjs` | Windows 目录顺序、显式目录、不可写报错、回退、临时目录兜底、默认目录只是偏好、写探测失败步骤 |
| `startup-log.test.mjs` | JSONL 启动日志、临时目录回退、敏感值脱敏、迁入数据目录、失败报告 |
| `instance.test.mjs` | 健康探测、不可达/外来服务/PID 不一致/缺少 runtime 的判定 |
| `diagnostics.test.mjs` | 交互式等待按键、非 TTY 不阻塞、`--no-wait`、对话框禁用 |
| `bootstrap.test.mjs` | 解压候选目录、标记校验、原子解压、路径穿越拒绝、三语失败文本、语言选择 |
| `logger.test.mjs` | 敏感键脱敏、自由文本中的凭据、JSON 片段、无误伤 |
| `bilibili-wbi.test.mjs` | 公开测试向量、mixin key、键提取、排序/编码 |
| `bilibili-protocol.test.mjs` | 头布局、鉴权包、心跳、多包、zlib/brotli、人气、异常长度、命令归一化 |
| `bilibili-mapper.test.mjs` | 弹幕身份/UID=0/打码昵称、付费/免费礼物金额、不可整除标记、SC 元→分、大航海不记账、V2 嵌套、补充 toast 去重、时间戳、`info[0][13]` 表情元数据、纯表情消息、括号文字不误判、`dm_v2` 不伪造 |
| `bilibili-cookie.test.mjs` | Set-Cookie/URL 双来源、SESSDATA 必需、白名单、加密存储、篡改返回 null、状态不含 Cookie |
| `bilibili-adapter.test.mjs` | 鉴权包内容、立即心跳、事件映射、鉴权失败、close 后重连调度 |
| `bilibili-qr.test.mjs` | vendored MIT QR 库可用、登录 URL 生成矩阵、定位图案、确定性、长 URL 容量 |
| `youtube-link.test.mjs` | 全部官方链接形式（watch / `/live/` / youtu.be / embed / shorts / 裸 ID / 移动域名）、播放列表/频道/外站/javascript 拒绝、错误键与 400 |
| `youtube-api.test.mjs` | API Key 查询参数 vs Bearer 头、无凭据本地失败、官方配额计费、Google reason → 稳定错误码、网络错误、视频状态判定（live/upcoming/ended/video）、分页字段 |
| `youtube-oauth.test.mjs` | PKCE S256、授权 URL 参数、state 常量时间比较、本地化回调页无外部资源、回环接收器只接受指定路径、拒绝授权、code 交换与刷新错误映射、完整登录流程、state 不匹配、未配置拒绝、过期令牌 → `expired` |
| `youtube-token-store.test.mjs` | 加密往返、明文不落盘、`status()` 不含令牌、频道信息更新、空凭据拒绝、篡改检测、退出删除 |
| `youtube-adapter.test.mjs` | 非直播拒绝、分页与轮询间隔、`offlineAt` 结束、网络错误重连不结束、配额守卫、停止后不再请求 |
| `youtube-retention.test.mjs` | 天数钳制、只清理过期 YouTube 原文、Bilibili 不动、金额/计数/身份保留、`app_meta` 记录 |
| `youtube-mapper.test.mjs` | 文本/Unicode Emoji/`:code:`、身份缺失、Super Chat 多币种、`amountMicros` BigInt 换算与半进位、Super Sticker、新会员/里程碑/赠送/收到赠送、`is_paid` 语义、忽略删除/封禁/未知事件 |

### 3.2 集成

| 文件 | 覆盖 |
| --- | --- |
| `storage.test.mjs` | 迁移幂等、事件聚合、重复投递不翻倍、跨场次观众、昵称历史、跨平台隔离、匿名事件、崩溃恢复、内容清理、非 live 拒绝写入、表情元数据持久化、清理同时移除表情 |
| `migration-emotes.test.mjs` | v1 旧库（无 `emotes`、无 `platform_started_at`）升级到 v3；旧消息保留且 `emotes=NULL`；升级后可写表情 |
| `youtube-session.test.mjs` | 本地假 YouTube API 的端到端：匿名 API Key 模式、直播定位、普通视频 409、非法链接零请求、连接 → 8 条事件入库（含重复消息去重）、多币种分账、按 channelId 建档案、赠送会员接收者不计付费、停止后进入历史、手动保留清理 |
| `api.test.mjs` | health/bootstrap、CSP、设置校验与持久化、模拟记录、事件列表、重复开始 409、停止、历史与详情、分析包下载与校验和、观众列表/档案/关注、SSE、Host/Origin/路径穿越/404、runtime 文件、重启后设置保持 |
| `ai-package.test.mjs` | 包结构、任务与计数、seq 顺序、校验和、三语说明不混英文、导出记录、未知场次返回 null、表情字典去重/引用、`content_ai` 按需出现、未知表情标记、重复表情包大小控制 |

## 4. 本轮结果（2026-11-08，v0.2.0）

```text
tests 259
pass  259
fail  0
duration ≈ 6.5s
```

无跳过、无 todo。

## 5. 手工 / 脚本验证记录

| 项目 | 方法 | 结果 |
| --- | --- | --- |
| 启动器中文控制台 | `node src/launcher/launcher.mjs --no-open` | ✅ 名称/版本/数据目录/地址/记录状态/退出方式 |
| 启动器日文控制台 | 保存语言=ja 后再次启动 | ✅ 日文提示 |
| 单实例 | 第二个进程同数据目录 | ✅ 提示已在运行，显示 URL，退出 0 |
| 非法参数 | `--port abc` | ✅ 退出 2 |
| `--help` 三语 | `--lang ja/en/zh-CN` | ✅ |
| 模拟直播 | API + 浏览器 | ✅ 消息、图表、动态、观众统计正确；含 Emoji 与平台表情样本 |
| AI 分析包 | 下载/读取 ZIP | ✅ 6 个文件，manifest 校验和一致，UTF-8 正常 |
| Emoji 界面 | 无头 Edge 截图 | ✅ `live-emoji-light-zh-CN.png` 显示 Unicode Emoji 原文 |
| AI 任务说明 | 无头 Edge 截图 | ✅ 明亮中文 `ai-light-zh-CN.png`、黑暗日语 `ai-dark-ja.png`、390px `ai-mobile-light-zh-CN.png` |
| 明亮/黑暗/跟随系统 | 截图 + 设置持久化测试 | ✅ |
| 中文/日语界面 | 截图 | ✅ |
| 390px 响应式 | 截图 | ✅ 无横向溢出 |
| EXE 构建 | `node scripts/build-windows.mjs` | ✅ 90.1 MB，SHA-256 `8af88e25…`，92 个资源文件 |
| EXE 普通权限完整启动 | `scripts/verify-exe.mjs` | ✅ 9/9 场景通过，0 失败 |
| EXE 新代码验证 | 全新数据目录启动 EXE | ✅ schema=3、version=0.2.0、`/api/youtube/status` 未配置状态清晰、`live.js` 含 YouTube 入口 |
| EXE 端到端表情导出 | EXE 内模拟记录 42 条 → 导出包 | ✅ 2 条平台表情消息、`emote_refs` 正确、manifest `messages_with_emotes=2`、`emote_kinds=1` |
| YouTube 本地端到端 | 假 API + `startServer` | ✅ 连接 → 8 条事件 → 4 条消息 / 5 个付费事件 → 多币种 → 历史 |
| YouTube 界面 | 无头 Edge 截图 | ✅ 明亮/黑暗/390px/录制中/未配置 5 张 |

## 6. 尚未验证（必须如实保留）

1. 真实 Ctrl+C 优雅退出（自动化无法发送控制台信号）。
2. 干净 Windows 10/11 虚拟机（非管理员、无 Node）。
3. EXE 代码签名/杀毒误报。
4. **YouTube 真实 Live Chat API**：链路已实现并用本地假 API 验证，但**没有真实 Google 凭据**，因此没有真实直播采样、真实消息条数、真实稳定身份比例。
5. YouTube 真实 OAuth：同意屏、refresh token 过期（Testing 应用 7 天）、未验证应用 100 用户上限均未在线验证。
6. YouTube 真实断网 / 配额耗尽的长时行为（只有逻辑分支测试）。
7. 跨电脑备份迁移（M5）。
8. AI 结果导入与 Schema 校验（M6）。
9. 长时间（>4h）直播的稳定性与内存占用。
10. 多显示器 / 高 DPI 控制台字体。
11. Bilibili 其他房间、全局表情、粉丝牌表情、动态表情图片；`dm_v2` 解码。
12. 礼物 / SC / 大航海真实事件字段复核。

## 7. M3 起需补充的测试

- 平台消息解析：用录制的真实消息样本（脱敏）做夹具，验证字段映射与金额单位。
- 断线重连：模拟 close/心跳超时，验证指数退避与去重。
- 身份缺失：UID 为空时不得更新画像。
- 金额单位：每个平台单独断言“1 单位货币 = N minor units”。
- 真实直播间验收表（房间号、日期、事件类型、字段核对）。

## 8. 真实直播间验收（2026-11-08，匿名连接）

| 房间号 | 时长 | 观测 | 结论 |
| --- | --- | --- | --- |
| 21144080 | 30s | 142 条 `DANMU_MSG` | 142/142 带 UID 与昵称；`info[1]` 文本、`info[2][0]/[1]`、`info[9].ts` 映射正确 |
| 5050 | 25s | 77 条 `DANMU_MSG` | 72 条 UID=0 且昵称打码 → 记 `viewer_uid=null`、`source_quality=unknown`，不合并 |
| 7734200 | 20s | 弹幕与互动事件 | 短号 6 解析正确，连接稳定 |
| 5050 | 20s | HTTP 端到端 | `room → connect → 3 条事件入库 → disconnect`，场次 `ended`，计数一致 |
| 5050 | 35s | 32 条 `DANMU_MSG` | 21 条带 `info[0][13]`；`emoticon_unique`、URL、宽高、`is_dynamic` 可用；`info[1]` 为文字标签；`dm_v2` 空 |
| 5050 | 15s | 22 条 `DANMU_MSG` | 19 条带 `info[0][13]`；文字标签示例「就这」「乐」「Wow」；无 `[xxx]` 括号文本 |

未观测到 `SEND_GIFT` / `SUPER_CHAT_MESSAGE` / `GUARD_BUY` / `USER_TOAST_MSG` / `SEND_GIFT_V2`，因此这些事件的真实字段与金额单位仍标记为未验证。平台表情只在 `5050` 采样，不能代表所有房间/所有表情类型。

## 9. YouTube 端到端（2026-11-08，**本地假 API，非真实平台**）

> 这一节的数据来自 `tests/integration/youtube-session.test.mjs` 中的本地假 API 服务器（按官方响应结构返回固定样本）。它证明「传输 → 映射 → 去重 → SQLite → 读模型 → 历史」链路可运行，**不是真实 YouTube 采样**，不能计入真实平台验收。

| 项目 | 结果 |
| --- | --- |
| 输入 | `https://www.youtube.com/live/<ID>`、`youtu.be/<ID>`、裸 ID |
| 首次请求 | `videos.list`（1 配额）+ `liveChatMessages.list`（5 配额） |
| 投递消息 | 10 条（其中 1 条 `messageDeletedEvent` 忽略，1 条重复 `message.id`） |
| 入库事件 | **8 条**（去重后） |
| 消息类（chat + super_chat） | 4 条（其中 2 条 Super Chat） |
| 经济事件（`is_paid=true`） | 5 个：Super Chat ×2（USD 5.00、JPY 1500）、Super Sticker（EUR 2.00）、新会员、赠送会员 ×3 |
| 稳定身份 | 7 位观众全部由 `channelId` 建立，昵称只作展示 |
| 币种分账 | USD 500 / JPY 1500 / EUR 200（最小单位，互不相加） |
| 赠送会员接收者 | `is_paid=false`、`payment_event_count=0` |
| 停止 | `POST /api/youtube/disconnect` → 场次 `ended`，出现在直播历史 |
| 保留清理 | `pendingPurge=0`，`app_meta['retention.lastRun']` 已写入 |

真实环境仍需补测：真实消息条数、真实身份完整率、真实 Super Chat / 会员样本、真实断网与配额行为。**在拿到开发者凭据之前，这些数字不能填写。**
