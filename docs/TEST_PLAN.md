# 测试计划与结果（TEST_PLAN）

## 1. 策略

| 层级 | 目的 | 位置 |
| --- | --- | --- |
| 单元测试 | 纯逻辑：语言、主题、金额、事件、Emoji/表情、去重、时间、分桶、ZIP、设置、锁、参数、数据目录、主播身份、语言控件 | `tests/unit/` |
| 集成测试 | 迁移、落库与聚合、HTTP API、安全校验、SSE、分析包、目录迁移/回滚、清空/出厂、多主播范围 | `tests/integration/` |
| 启动冒烟 | 启动器真实启动、单实例、命令行三语、EXE | 手工 + `scripts/` |
| UI 验证 | 三主题、三语言、响应式、Header 语言、数据管理、主播范围、多直播标签、Top 100、历史搜索/归档/停止/删除、AI 导入/报告 | 手工 + 无头 Chrome/Edge 截图 + `scripts/verify-live-ui.mjs` / `verify-history-ui.mjs` / `verify-ai-ui.mjs` |
| 打包 EXE | 真实 v6→v8 升级、搜索、归档、停止、删除、重启保持；M6 AI 导出/分批/导入/汇总/报告 | `scripts/verify-exe-history.mjs` / `verify-exe-ai.mjs` |
| 真实平台 | Bilibili 真实直播事件与表情元数据；YouTube 公开网页真实采样；v0.6.0 真实多场并发 | 已采样（见第 9/11/13 节）；v0.8.0 未新增 |
| 跨电脑迁移 | 备份导出/导入一致性 | 未开始（M5） |

## 2. 运行方式

```bat
node --test tests/unit tests/integration
```

受限环境（禁止子进程，如某些沙箱）使用单进程模式：

```bat
node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"
```

测试通过 `tests/helpers/temp-dir.mjs` 在 `tests/.tmp/` 下创建隔离数据目录，绝不触碰真实用户数据。API 集成测试使用 `port: 0`（系统分配端口）；位置记录/备份目录通过 `LIVE_MEMORY_LOCATION_DIR` / `LIVE_MEMORY_BACKUP_DIR` 指向临时目录。

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
| `admin.test.mjs` | 管理员检查成功/失败/未知、非 Windows |
| `native-dialog.test.mjs` | 原生选择器脚本 Base64、成功路径（中文/空格）、取消、脚本错误、spawn EPERM、结果文件清理 |
| `profile-scan.test.mjs` | 单/多用户 LiveMemory 数据目录扫描、首次运行、不可读根目录 |
| `pe-manifest.test.mjs` | node.exe RT_MANIFEST 读取、requireAdministrator 改写、容量检查 |
| `youtube-simplified.test.mjs` | 官方 YouTube 模块/路由/UI 删除、三语只含简化文案 |
| `youtube-retention.test.mjs` | 天数钳制（最大 30）、只清理过期 YouTube 原文、Bilibili 不动、金额/计数/身份保留、badges/amount_display 清理、过期昵称清理、`app_meta` 记录 |
| `youtube-anonymous-parser.test.mjs` | 真实页面/续页结构、显式/裸 `$`/`¥` 币种、格式化金额、Unicode/自定义表情、badges、watch 状态、gift 无身份、会员不猜价格 |
| `youtube-anonymous-adapter.test.mjs` | continuation 失效重开、网络错误退避恢复、不结束场次、匿名快照 |
| `youtube-mapper.test.mjs` | 文本/Unicode Emoji/`:code:`、身份缺失、Super Chat 多币种、`amountMicros` BigInt 换算与半进位、Super Sticker、新会员/里程碑/赠送/收到赠送、`is_paid` 语义、忽略删除/封禁/未知事件 |
| `broadcaster.test.mjs` | YouTube channelId vs 视频 ID、Bilibili anchor uid/room fallback/unresolved、mock、质量排序、控制字符清洗 |
| `header-language.test.mjs` | 三种语言原生名称、Header 双控件、主题控件并存、三语语言/数据管理键 |
| `live-multi-ui.test.mjs` | 直播页使用多场 API、停止路径、Top 100 接口、viewToken、标签/排行榜容器、无 innerHTML、无旧 livesummary 轮询 |
| `history-ui.test.mjs` | 列表与详情共用 `session-actions`、搜索端点/筛选参数/不读 events 正文、删除确认字段与勾选、DELETE 客户端、无 innerHTML、共享 modal、响应式/菜单键盘 CSS、路由与事务守卫、三语键 |
| `ai-prompts.test.mjs` | 三语提示词的批次/汇总/来源字段语义一致、提示词版本记录、Schema 1.0/1.1 兼容、未知字段拒绝、真实包元数据构造结果通过语义校验 |
| `ai-ui.test.mjs` | AI 页面无 innerHTML/eval、完整端点、历史详情报告入口、三语 M6 键、AI 与本地统计分离、切片提示不声称视频分析 |

### 3.2 集成

| 文件 | 覆盖 |
| --- | --- |
| `storage.test.mjs` | 迁移幂等、事件聚合、重复投递不翻倍、跨场次观众、昵称历史、跨平台隔离、匿名事件、崩溃恢复、内容清理、非 live 拒绝写入、表情元数据持久化、清理同时移除表情 |
| `migration-emotes.test.mjs` | v1 旧库升级到 v8；旧消息保留且 `emotes=NULL`；旧场次无主播信息保持 unresolved；新表/索引/列存在；`archived_at/end_reason` 默认 NULL |
| `ai-import.test.mjs` | 单批导出/导入/报告证据；非法 JSON/缺字段/错误类型/未知字段/Schema 版本；场次/任务/批次/job/主播/观众错误；未知消息与越界时间；重复导入；同任务新版本；故障注入回滚；归档导入；删除后失效；原文清理证据；跨主播隔离；旧版包兼容；HTML/控制字符；8 MB 上限；大结果性能 |
| `ai-batching.test.mjs` | 2500 条 5 批无丢失/重复、seq 映射唯一、乱序/重复/缺失批次、提前汇总拒绝、汇总包无消息、最终报告不拼接、12 批 6000 条、重新分析新 job/新 batch id |
| `ai-api.test.mjs` | HTTP 任务/批次/下载/提示词/预览不写/导入/重复/版本 409/汇总/最终报告/结果下载/请求上限/删除后结构化失败 |
| `ai-migration.test.mjs` | 真实 v7→v8 升级保留旧包来源与列默认值、新表存在、删除会话级联 AI 任务/结果/证据 |
| `youtube-anonymous-session.test.mjs` | 本地假公开网页：唯一 web 模式、无登录/Key、watch/chat 检查、SC `HK$`、gift 无 Channel ID、badge、会员/Sticker、重复与 ticker 去重、自动结束、30 天上限、AI 包 |
| `session-multi.test.mjs` | 多场独立 adapter/会话/事件、重复房间拒绝、停止/失败隔离、交错写入去重、启动恢复、Top 100 稳定排序/搜索/同名不合并 |
| `live-api-multi.test.mjs` | 双 YouTube HTTP 并发、事件归属、重复 409、Top 100、共享观众跨主播 scope、停止一场另一场继续、重启恢复 |
| `api.test.mjs` | health/bootstrap、CSP、设置校验与持久化、模拟记录、事件列表、重复开始 409、停止、历史与详情、分析包下载与校验和、观众列表/档案/关注、SSE、Host/Origin/路径穿越/404、runtime 文件、重启后设置保持 |
| `ai-package.test.mjs` | 包结构、任务与计数、seq 顺序、校验和、三语说明不混英文、导出记录、未知场次返回 null、表情字典去重/引用、`content_ai` 按需出现、未知表情标记、重复表情包大小控制 |
| `broadcaster-identity.test.mjs` | 同一 YouTube 账号在两个主播、同一主播多场、重名不合并、改名不拆分、跨平台同名不合并、主播维度发言/付费/币种、新/回访、v4→v5 迁移、AI 包 context 隔离、HTTP 范围接口 |
| `storage-management.test.mjs` | 位置记录原子写/镜像/相对路径拒绝、目标安全校验/UNC/冲突/空间、迁移复制校验与旧目录保留、复制中断回滚、**新数据空间空库+设置/凭据保留**、清空保留设置与凭据、出厂重置、应急快照一致性 |
| `history-management.test.mjs` | 三场并发停止一场其余继续、重复停止 409、同房间重启新场次、归档持久化/默认隐藏/取消归档/live 拒绝、永久删除专属数据与共享观众聚合重建、孤立 broadcaster 清理、focused 保留、导出文件删除、确认/live/adapter 守卫、数据库故障事务回滚 |
| `history-search.test.mjs` | 主播名称/稳定 ID、中日英混合标题、观众稳定 ID/昵称/历史昵称、同名不同身份不合并、跨平台/跨主播、筛选组合、隐藏归档计数、分页、通配符字面、匿名不可检索、1200 场性能 |
| `history-api.test.mjs` | HTTP 搜索/筛选、归档/取消、列表与详情两个停止端点、删除确认与 400/409、观众单场发言、删除后 404 与无关场次保留 |

## 4. 本轮结果（2026-11-09，v0.8.0，M6）

```text
tests 354
pass  354
fail  0
duration ≈ 48.3s
```

无跳过、无 todo。新增 M6 导入/分批/汇总/报告/提示词/UI 结构测试；更新 schema 8 与 v0.8.0 断言。

新增覆盖重点：

- **完整往返**：单批导出 → 构造 Schema 合法结果 → 预检查 → 导入 → 报告；证据解析到真实事件行。
- **非法输入**：非法 JSON、缺字段、错误类型、未知字段、错误 Schema 版本、错误场次/任务/批次/job/主播/观众、
  不存在的消息引用、越界时间、重复导入、同任务新版本、数据库故障回滚。
- **分批**：2500 条 5 批无丢失/重复；乱序、重复、缺失；提前汇总拒绝；汇总包不含原始消息；最终报告不拼接；
  12 批/6000 条映射；重新分析生成新任务与新批次 id。
- **安全**：AI 文本只按白名单保存、控制字符清理、`<script>`/`<img onerror>` 只显示为文本；页面无 innerHTML/eval。
- **保留/删除**：原文清理后证据标记不可用；归档可导入；删除场次级联 AI 任务/结果/证据与包文件；
  `maintenance` 清空包含全部 AI 表。
- **提示词**：三语语义结构一致，版本记录到任务与包，Schema 1.0/1.1 兼容。
- **打包 EXE**：真实 v7→v8 升级、UI 创建 3 批、粘贴导入、汇总包、最终报告、重启保持。

**真实 AI 状态**：本轮未调用真实 AI 服务；导入结果是使用真实包元数据构造的合成结果。
不得把上述结果描述为“真实 AI 文件往返已验证”。

## 5. 本轮结果（2026-11-09，v0.7.0，历史）

```text
tests 318
pass  318
fail  0
duration ≈ 25.0s
```

无跳过、无 todo。新增历史管理、搜索、HTTP、UI 结构守卫；更新 schema 7 迁移与版本断言。

新增覆盖重点：

- **场次管理**：三场并发中停止一场其余继续；归档持久化与默认隐藏；永久删除专属行、共享观众聚合重建、孤立主播清理、导出文件删除；故障注入事务回滚。
- **搜索**：主播、标题、观众（稳定 ID/昵称/历史昵称）；同名跨平台身份分离；中日英混合；筛选组合、分页、通配符字面、匿名不可检索、大规模性能。
- **UI**：列表/详情共用操作菜单、搜索与筛选、归档、停止、删除确认、观众下钻、键盘、390px、黑暗主题与中文。
- **数据兼容**：schema 7 仅新增列与索引；打包 EXE 用真实 v6 数据库升级并保留历史。
- **打包 EXE**：搜索、归档、停止、删除、重启保持与删除不复活。

## 6. 手工 / 脚本验证记录

| 项目 | 方法 | 结果 |
| --- | --- | --- |
| 启动器中文控制台 | `node src/launcher/launcher.mjs --no-open --lang zh-CN` | ✅ 名称/版本/数据目录/地址/记录状态/退出方式 |
| 启动器默认英文控制台 | EXE asInvoker 副本无 `--lang` | ✅ “Local-first livestream memory system / Idle (not recording)” |
| 多直播标签界面 | `demo-multi-recording.mjs` + `verify-live-ui.mjs` | ✅ 3 标签、Top 100、搜索、档案跳转、重入、390px，10/10 |
| 真实多场并发 | `verify-live-multi.mjs` | ✅ 2 YouTube、YouTube+Bilibili、3 场；隔离 0 串场；停止一场其余继续（见 §12.3） |
| 真实 EXE 多场并发 | EXE asInvoker 副本 + `--base` 附加 | ✅ 3 场真实直播，3/3 connected，重复 409，停 A 后 2 场 connected |
| 启动器日文控制台 | 保存语言=ja 后再次启动 | ✅ 日文提示 |
| 单实例 | 第二个进程同数据目录 | ✅ 提示已在运行，显示 URL，退出 0 |
| 非法参数 | `--port abc` | ✅ 退出 2 |
| `--help` 三语 | `--lang ja/en/zh-CN` | ✅ |
| 模拟直播 | API + 浏览器 | ✅ 消息、图表、动态、观众统计正确；含 Emoji 与平台表情样本 |
| AI 分析包 | 下载/读取 ZIP | ✅ 6 个文件，manifest 校验和一致，UTF-8 正常 |
| Emoji 界面 | 无头 Chrome 截图 | ✅ Unicode Emoji 原文显示 |
| AI 任务说明 | 无头 Chrome 截图 | ✅ 明亮中文、黑暗日语、390px 移动端 |
| 明亮/黑暗/跟随系统 | 截图 + 设置持久化测试 | ✅ |
| 中文/日语/英语界面 | 截图 | ✅ |
| 390px 响应式 | 截图 | ✅ 无横向溢出 |
| Header 语言 | Headless Chrome + DevTools | ✅ 中文/日语/英语/黑暗日语/390px；三语原生名称 |
| 数据目录迁移界面 | Headless Chrome + 真实本地服务 | ✅ 迁移对话框、结果 12→12 事件、新位置卡、位置记录 |
| 清空数据界面 | Headless Chrome + 真实本地服务 | ✅ DELETE/RESET 对话框、结果 3/12/4→0/0/0、清空后观众页为空 |
| 多主播界面 | Headless Chrome + 真实本地服务 | ✅ 范围选择、排序、Mika 在 A/B 分别统计、全局概览 |
| 迁移完整性 | SQLite 直接校验 | ✅ 旧/新 schema=6、integrity=ok、3/12/4/8/5/2 一致 |
| 清空完整性 | SQLite 直接校验 | ✅ 全部业务表 0、integrity=ok；备份 3/12/4、integrity=ok |
| 备份快照 | `VACUUM INTO` + 直接校验 | ✅ 快照在数据目录之外、integrity=ok、内容保留 |
| 历史搜索/管理 UI | `demo-history.mjs` + `verify-history-ui.mjs` | ✅ **27/27**：标题/主播/观众搜索、同名跨平台、筛选、归档/取消、停止、删除确认、详情、键盘、390px、黑暗中文 |
| EXE 历史管理与升级 | `verify-exe-history.mjs`（打包 EXE asInvoker 副本） | ✅ **19/19**：真实 v6→v8、搜索、归档、重启保持、停止、删除、共享观众聚合、专属观众清理 |
| EXE AI 往返 | `verify-exe-ai.mjs`（打包 EXE asInvoker 副本） | ✅ **14/14**：真实 v7→v8、3 批创建/粘贴导入/汇总/报告/重启保持 |
| EXE 构建 | `node scripts/build-windows.mjs` | ✅ 90.6 MB，117 资源，SHA-256 `24227987…`；Manifest `requireAdministrator` |
| EXE Manifest | `scripts/pe-manifest.mjs` / `verify-exe.mjs` | ✅ level=`requireAdministrator`，773 bytes |
| EXE 非提升启动 | `spawnSync` 最终 EXE | ✅ Windows 返回 `EACCES`（未进入程序） |
| EXE 功能矩阵 | `scripts/verify-exe.mjs` | ✅ **10/10**（manifest + 9 场景；非提升会话使用 asInvoker 副本并明确打印） |
| EXE 管理员提示 | asInvoker 副本 `--lang zh/ja/en` | ✅ 三语消息、退出 1 |
| EXE 新代码验证 | 全新数据目录启动 | ✅ schema=8、version=0.8.0 |
| EXE 旧库升级 | v6/v7 数据库启动打包 EXE | ✅ schema 8、历史完整、归档重启保持、删除不复活、AI 任务/报告重启保持 |
| YouTube 公开网页本地端到端 | 假网页 + `startServer` | ✅ 唯一 web 路径、5 条事件、SC HKD、gift 无身份、badge、自动结束 |
| YouTube 真实房间 A（历史 v0.3.0） | `FKLZiufsCk0` 35 秒 | ⚠️ 旧样本，不能作为当前版本验收（当前见 §12.3） |
| YouTube 真实房间 B（历史 v0.3.0） | `gXawf8GZDI8` 35 秒 | ⚠️ 旧样本，不能作为当前版本验收（当前见 §12.3） |

## 7. 尚未验证（必须如实保留）

1. 真实 Ctrl+C 优雅退出（自动化无法发送控制台信号）。
2. 干净 Windows 10/11 虚拟机（非管理员、无 Node）。
3. EXE 代码签名/杀毒误报。
4. **真实 UAC 交互**：当前进程 Low Mandatory Level，未点击“是”；最终 EXE 只验证 Manifest 与非提升启动 EACCES，管理员批准后的完整启动/选择器/迁移/SQLite 未人工验证。
5. **真实文件夹选择器点击/取消/选择**：无交互桌面；只验证 PowerShell 可启动（PICKER_TIMEOUT）与假进程单元测试。
6. **YouTube 真实直播采样**：v0.6.0 已完成真实并发采样（2 YouTube、YouTube+Bilibili、3 场、EXE 附加），见 §12.3；仍未覆盖数小时长直播、真实 429/验证码/年龄墙、全部事件类型与官方授权。
7. YouTube 公开网页真实 429/验证码/consent/age wall、长时断网（只有逻辑分支测试）。
8. 跨电脑备份迁移（M5）。
9. AI 结果导入与 Schema 校验（M6）。
10. 长时间（>4h）直播的稳定性与内存占用。
11. 多显示器 / 高 DPI 控制台字体。
12. Bilibili 其他房间、全局表情、粉丝牌表情、动态表情图片；`dm_v2` 解码。
13. 礼物 / SC / 大航海真实事件字段复核。
14. **YouTube 公开网页接口**：只做了两个历史 35 秒样本；未验证数小时长直播、真实 429/验证码/consent/age wall、不同地区币种、Super Sticker/会员/赠送会员。
15. **公开网页路径条款合规**：未取得 YouTube 书面许可或法务结论；不得把“技术可用”描述为“允许使用”。
16. **真实断盘/断电/磁盘写满**：迁移回滚通过注入 `afterMove` 失败测试，未做物理中断演练；空间不足通过注入 `statfs` 测试。
17. **映射网络盘**：只识别 UNC 并拒绝；盘符映射的网络盘未自动检测。
18. **数据清空文件删除**：数据库事务与 `VACUUM` 已测；文件删除为尽力而为，未做断电中断验收。
19. **旧 YouTube 场次归属**：保持 `unresolved`，没有手动指派 UI。

## 8. M3 起需补充的测试

- 平台消息解析：用录制的真实消息样本（脱敏）做夹具，验证字段映射与金额单位。
- 断线重连：模拟 close/心跳超时，验证指数退避与去重。
- 身份缺失：UID 为空时不得更新画像。
- 金额单位：每个平台单独断言“1 单位货币 = N minor units”。
- 真实直播间验收表（房间号、日期、事件类型、字段核对）。
- 迁移/删除的物理中断演练（拔盘、断电、磁盘写满）。
- 旧场次主播归属与单场/观众删除 UI。

## 9. 真实直播间验收（2026-11-08，匿名连接）

| 房间号 | 时长 | 观测 | 结论 |
| --- | --- | --- | --- |
| 21144080 | 30s | 142 条 `DANMU_MSG` | 142/142 带 UID 与昵称；`info[1]` 文本、`info[2][0]/[1]`、`info[9].ts` 映射正确 |
| 5050 | 25s | 77 条 `DANMU_MSG` | 72 条 UID=0 且昵称打码 → 记 `viewer_uid=null`、`source_quality=unknown`，不合并 |
| 7734200 | 20s | 弹幕与互动事件 | 短号 6 解析正确，连接稳定 |
| 5050 | 20s | HTTP 端到端 | `room → connect → 3 条事件入库 → disconnect`，场次 `ended`，计数一致 |
| 5050 | 35s | 32 条 `DANMU_MSG` | 21 条带 `info[0][13]`；`emoticon_unique`、URL、宽高、`is_dynamic` 可用；`info[1]` 为文字标签；`dm_v2` 空 |
| 5050 | 15s | 22 条 `DANMU_MSG` | 19 条带 `info[0][13]`；文字标签示例「就这」「乐」「Wow」；无 `[xxx]` 括号文本 |

未观测到 `SEND_GIFT` / `SUPER_CHAT_MESSAGE` / `GUARD_BUY` / `USER_TOAST_MSG` / `SEND_GIFT_V2`，因此这些事件的真实字段与金额单位仍标记为未验证。平台表情只在 `5050` 采样，不能代表所有房间/所有表情类型。

## 10. YouTube 公开网页本地端到端（v0.5.0，**假网页，非真实平台**）

> 数据来自 `tests/integration/youtube-anonymous-session.test.mjs` 的本地假 watch/live_chat 服务器。它证明「HTTP → 解析 → mapper → 去重 → SQLite → 读模型 → 历史/AI 包」链路可运行，**不是真实 YouTube 采样**。官方 Data API 假测试已随实现删除。

| 项目 | 结果 |
| --- | --- |
| 接入状态 | 只有 `mode=web`；无登录/Key/Cookie/配额字段 |
| 链接形式 | `/live/<ID>`、`youtu.be/<ID>`、裸 ID |
| 入库事件 | **5 条**：chat、Super Chat、membership、Super Sticker、gift；重复 chat 与 ticker 被丢弃 |
| Super Chat | `HK$2,000.00` → HKD 200000 最小单位，保留原显示文本 |
| gift 身份 | 无 Channel ID → `viewer_uid=null`，不按昵称建档案 |
| badge | moderator / member 文本保留 |
| 自动结束 | 假聊天结束后场次 `ended`，历史可读 |
| 保留 | `youtubeRawRetentionDays` 上限 30；超过 400 |
| AI 包 | `messages.jsonl` 含 badge、`amount_display`、`amount_minor` |
| 登录/模式 | `/api/youtube/login/status` 404；PATCH `youtubeCaptureMode` 400 |

真实环境仍需补测：真实消息条数、身份完整率、真实 Super Chat/会员样本、真实 429/断网/页面改版。

## 11. YouTube 公开网页真实采样（历史，2026-11-08 / v0.3.0）

> 来源：`scripts/verify-youtube-anonymous.mjs`，真实公开直播，无 Cookie / 无 OAuth / 无用户 API Key。只打印聚合，不打印正文或昵称。

| 房间 | 时长 | actions | 事件 | chat | 经济 | 稳定 Channel ID | badge | 错误/重复 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `FKLZiufsCk0` | 35s | 92 | 86 | 85 | 1 SC `HK$2,000.00` → HKD 200000 | 86/86（100%） | 49 | 0 / 0 |
| `gXawf8GZDI8` | 35s | 103 | 100 | 87 + 13 gift | 13 gift，金额未知 | chat 87/87；gift 0/13 | 3 | 0 / 0 |

- **重要：以上是 v0.3.0 的历史样本；v0.6.0 已另行完成真实并发采样（§12.3），不得把旧样本当作当前版本验收。**
- 2026-11-09 尝试重新运行这两个旧链接，均返回 `YOUTUBE_NOT_LIVE_ENDED`；没有可用直播，因此没有新样本。
- `pollCount=3`，`failures=0`，`endReason=null`；手动停止后场次 `ended`。
- 未观测到 Super Sticker、会员里程碑、赠送会员；这些只有结构化测试，不是真实样本。
- 重连没有在真实环境触发；`youtube-anonymous-adapter.test.mjs` 模拟 continuation 失效与网络错误，确认不结束场次。
- 官方 API 并排对照已随 v0.5.0 实现删除，不再作为后续目标。
- 兼容性：该接口不是官方 API，可能违反 YouTube ToS；详见 `YOUTUBE_ANONYMOUS_RESEARCH.md`。

## 12. 多主播与数据管理专项验证（v0.4.0）

| 场景 | 结果 |
| --- | --- |
| 同一 YouTube Channel ID 出现在主播 A、B | ✅ 一个 `viewers` 行；两条 `viewer_broadcasters`；A/B 统计独立 |
| 同一观众在同一主播多场 | ✅ scope 内 `session_count` 增加；另一主播不变 |
| 两个不同观众昵称完全相同 | ✅ 两个稳定 ID，不合并 |
| 同一观众更换昵称 | ✅ 更新展示名 + 昵称历史，不拆分身份 |
| 两个不同平台相同昵称 | ✅ `youtube:` 与 `bilibili:` 不合并 |
| 同一主播多场不同 YouTube 直播 | ✅ 场次分别关联同一 channelId |
| Bilibili 同一主播 UID 对应直播间 | ✅ 使用 anchorUid；缺失时 room fallback |
| 按主播搜索 / 全部主播搜索 | ✅ 范围接口与 UI |
| 各主播独立发言/付费/币种 | ✅ A USD 5 / B USD 10；lifetime USD 15 |
| 旧库迁移（v4→v5） | ✅ Bilibili room fallback；YouTube unresolved；mock simulated |
| 平台数据到期清理后的关联一致性 | ✅ 清理只删原文/badge/金额显示/过期昵称；关系计数/稳定 ID/合计保留 |
| AI 分析包主播上下文 | ✅ `broadcaster_context` / `lifetime` / `other_broadcaster_count` |
| 修改到新本地目录 | ✅ 迁移成功，位置记录更新，运行时同端口切换 |
| 创建新的空数据空间 | ✅ 新库 schema=6、业务表 0；旧目录保留 |
| 软件重启后仍使用新目录 | ✅ 位置记录读取；目标存在且含数据库才使用 |
| 新目录无权限 / 空间不足 | ✅ 注入 `statfs` 与写探测错误路径 |
| 复制中断 / 迁移失败回滚 | ✅ 注入 `afterMove` 失败后回滚到原目录，原数据可用 |
| 外接目录暂时不可访问 | ✅ 启动器报不可用，不创建空库 |
| 中文/日文路径 | ✅ 路径按 UTF-8/绝对路径处理，未做路径拼接删除 |
| 迁移前后记录数量一致 | ✅ 旧/新 3/12/4/8/5/2 完全一致，integrity ok |
| 清空记录但保留设置 | ✅ 设置/凭据/位置记录/backups/无关文件保留 |
| 恢复出厂设置 | ✅ 设置默认、凭据/日志/缓存/导出删除；backups/无关文件保留 |
| 取消 / 确认文字错误 | ✅ 前端禁用 + 服务端 400 |
| 直播正在记录 | ✅ 设置页禁用 + 服务端 409 |
| 清理后数据库可初始化 | ✅ 重建运行时、schema=6、空库可服务 |
| 旧数据不会从缓存重新出现 | ✅ 观众页为空；服务端重建运行时 |

## 13. 多直播并发与 Top 100 专项验证（v0.6.0）

### 12.1 自动化结果

- 全量：**296 passed / 0 failed / 约 24.5 秒**。
- `tests/integration/session-multi.test.mjs`：
  - 两个独立 adapter/session 同时运行，A/B 事件分别归属；
  - 同一 YouTube 观众在两个主播时全局身份 1 行、`viewer_broadcasters` 按主播独立；
  - 同一房间重复启动返回 duplicate，不新增 session；
  - 停止 A 后 B 继续写入；B 连接失败只结束 B；
  - A/B 各交错写入 100 条相同 `external_id`，两场各 100 条且重复投递被忽略；
  - 新 manager `recoverInterrupted()` 把残留 live 标为 interrupted，recordings 为 0；
  - 122 位有效观众 → 返回 100 行，rank 1–100；同分按 UID 稳定排序；同名不同 UID 两行；搜索保留 rank。
- `tests/integration/live-api-multi.test.mjs`（本地假 YouTube 双直播）：
  - 两场同时 201 连接，`/api/live/recordings` count=2；
  - 事件 A 131 / B 13，`wrongSession=0`；
  - 关闭浏览器 SSE 连接后两场仍为 live/connected；
  - 共享观众在两个主播的 scope 各 1 条、全局 2 条、broadcasters=2；
  - 重复 A 409 `SESSION_DUPLICATE_ROOM`；
  - Top 100：total 123、returned 100、rank/同分稳定、搜索；
  - 停止 A 后 B 仍 connected 且收到新事件；
  - 停止 B 后 recordings 0；重启后残留 live 为 interrupted，不自动新建。
- `tests/unit/live-multi-ui.test.mjs`：前端 API/令牌/容器/无 innerHTML、无旧单场轮询。
- `tests/unit/launcher.test.mjs`：控制台默认英文、`--lang` 覆盖、多场状态行。

### 12.2 无头浏览器 UI 验证

`scripts/verify-live-ui.mjs` 对 3 个模拟运行场次执行：**10/10 通过**。

> 最后一次完整运行后又增加了“排行榜刷新时保持 scrollTop”的改进；该改动由 `live-multi-ui.test.mjs` 静态守卫覆盖，最终复跑时本机无头浏览器未能再次启动，因此没有重新做浏览器滚动实测。

| 检查 | 结果 |
| --- | --- |
| 3 个标签渲染，默认选中最后一场 | ✅ |
| 新建记录按钮固定可见 | ✅ |
| Top 100 有 100 行且容器可滚动 | ✅ |
| 切换标签后 Hero 标题变化 | ✅ |
| 每场排行榜独立读取 | ✅ |
| 搜索 “Top Viewer” 只剩 1 行且保留 rank | ✅ |
| 点击观众跳转带 `broadcaster=` 的档案 URL | ✅ |
| 离开再回直播页仍显示 3 场 | ✅ |
| 390px 新建按钮可见、无横向溢出 | ✅ |
| 390px Top 100 仍可滚动 | ✅ |

### 12.3 真实直播并发结果（2026-11-09）

| 场景 | 结果 |
| --- | --- |
| 两个真实 YouTube 直播 | 2/2 connected；80 / 63 事件；`wrongSession=0`；重复启动 409；停 A 后 B connected（聊天安静，20s 无新消息） |
| YouTube + Bilibili room 6 | 2/2 connected；76 / 11 事件；`wrongSession=0`；停 A 后 B +1 事件并 connected |
| 3 场（2 YouTube + Bilibili room 6） | 3/3 connected；85 / 66 / 6 事件；`wrongSession=0`；停 A 后剩余 2 场 connected，B +1 |
| 构建后 EXE asInvoker 副本 + 3 场真实直播 | 3/3 connected；73 / 67 / 5 事件；`wrongSession=0`；重复启动 409；停 A 后剩余 2 场 connected |

脚本：`scripts/verify-live-multi.mjs`；只输出聚合，不输出标题/昵称/正文；数据目录结束后删除。

### 12.4 未完成

- 没有在真实直播中恰好观测到“同一 Channel ID 出现在两个主播”，该身份关系由自动化 SQLite/HTTP 测试覆盖。
- 真实 Bilibili 本轮仅收到普通弹幕，未观测礼物/SC/大航海。
- 未做 10+ 场、数小时压力与内存增长测试。
- 运行中标签不能关闭/隐藏；必须先停止。此行为有意，避免静默停止或误导。

## 14. 直播历史管理与搜索专项验证（v0.7.0）

### 13.1 自动化结果

- 全量：**318 passed / 0 failed / 约 25.0 秒**。
- `history-management.test.mjs`：
  - 三场同时记录，停止 A 后 A 为 `ended/end_reason=user`，事件保留；B 继续接收新事件；C 未受影响；重复停止 409；
  - 同房间重新开始创建新 session id，旧场次保持 ended；
  - 归档写入 `archived_at`、默认列表隐藏、`archivedOnly` 可见；关闭重开文件数据库后仍归档；live 与仍有 adapter 时拒绝；取消归档恢复；
  - 删除 A 后：A 专属观众删除、共享观众仍保留且计数=剩余场次、`viewer_broadcasters` 仅剩有效主播、其他场次完整；删除 D 后其唯一 broadcaster 被清理；`focused` 观众仅计数归零；
  - 该场 `ai_packages` 行与导出 ZIP 删除，其他场次 ZIP 保留；
  - 缺少 `confirm`、live、内存仍有 adapter 三种守卫；
  - SQLite 触发器模拟删除失败 → 事务回滚，场次/事件/观众/币种完全不变；移除故障后删除成功；
  - 归档场次可永久删除。
- `history-search.test.mjs`：
  - 主播显示名/稳定 ID、标题的中文/日文/英文/混合匹配；
  - 观众昵称同时匹配 `bilibili:9002` 与 `youtube:UC_VIEWER` 两个身份，消息数正确；历史昵称仍解析到同一稳定身份并返回其全部场次；
  - 稳定 ID 搜索只命中该身份；匿名消息不产生观众结果；
  - 平台/状态/日期/归档组合；隐藏归档计数；`%`/`_` 字面匹配；分页 4+4+2 稳定；1200 场/12000 事件：观众搜索约 200ms、标题 < 400ms（断言 800/400ms）。
- `history-api.test.mjs`：HTTP 搜索/筛选、归档/取消、`/api/sessions/:id/stop` 与 `/api/live/recordings/:id/stop` 共用行为、重复停止 409、删除 400/409/200、观众下钻、删除后 404 且其他场次保留。
- `history-ui.test.mjs`：列表/详情共用实现、搜索不读 `/api/events`、删除确认字段、DELETE 客户端、无 innerHTML 赋值、settings 复用共享 modal、响应式/菜单 CSS、键盘、路由/事务守卫、三语键。

### 13.2 浏览器 UI 验证

`scripts/verify-history-ui.mjs`：**27/27 通过**（模拟夹具，真实 Chromium）。

| 检查 | 结果 |
| --- | --- |
| 列表 6 行、归档默认隐藏 | ✅ |
| 标题搜索（中英混合）与匹配原因 | ✅ |
| 观众昵称搜索返回两个平台身份、UID 不同 | ✅ |
| 点击观众行进入详情 `?viewer=`，显示本场发言 | ✅ |
| 主播名称搜索与原因 | ✅ |
| 观众 + 平台筛选组合 | ✅ |
| 包含归档显示归档 chip；取消归档恢复 | ✅ |
| 归档行只显示 Unarchive/Delete | ✅ |
| live 行只显示 Stop | ✅ |
| 停止确认说明平台直播可能继续 | ✅ |
| 停止后状态即时变为 Recording stopped | ✅ |
| 删除按钮初始禁用，勾选后可用；确认框含主播/标题/日期 | ✅ |
| 删除后列表与搜索无结果 | ✅ |
| 详情页菜单归档、提示卡 | ✅ |
| 详情删除后返回列表且无结果 | ✅ |
| Enter 打开菜单、ArrowDown 聚焦、Esc 关闭并返回焦点 | ✅ |
| 390px 无横向溢出、菜单在视口内 | ✅ |
| 黑暗 + 中文（直播历史）正常 | ✅ |

截图：`docs/screenshots/history-*.png`（7 张，v0.7.0）。

### 13.3 打包 EXE 验证

`scripts/verify-exe-history.mjs`：**19/19 通过**（`dist/LiveMemory.exe` 的 asInvoker 临时副本；真实 v6 数据库）。

| 检查 | 结果 |
| --- | --- |
| 真实 schema 6 数据库启动 EXE → schema 7，4 场历史保留 | ✅ |
| 打包 EXE 历史页渲染 | ✅ |
| 观众搜索（2 场） | ✅ |
| 归档后默认隐藏；包含归档可见 | ✅ |
| EXE 内启动模拟直播 → 历史显示 Live → 停止 → Recording stopped | ✅ |
| 停止后 `/api/live/recordings` 为 0 | ✅ |
| 删除确认含主播/标题，初始禁用 | ✅ |
| 删除后 session 404，专属观众 404 | ✅ |
| 删除共享观众的其中一场 → 观众仍保留，sessionCount=1，消息 2、付费 1 | ✅ |
| 关闭并重启 EXE：schema 7、无运行任务 | ✅ |
| 归档状态重启保持 | ✅ |
| 删除数据重启后不复活 | ✅ |
| 重启后观众搜索仍可用 | ✅ |

### 13.4 真实场景边界

- 本轮**没有**进行新的真实 Bilibili/YouTube 网络采集；上述“真实”仅指真实 SQLite、真实 HTTP、真实打包 EXE 与真实浏览器。
- 未验证：真实 UAC 同意、真实文件夹选择器、真实平台长期运行、M6 AI 导入后的删除联动、百万级数据量。
- 删除测试全部使用 `tests/.tmp` 下的独立数据库，未触碰用户真实记录。

## 15. AI 文件往返专项验证（v0.8.0）

| 项目 | 方法 | 结果 |
| --- | --- | --- |
| 完整报告 | `demo-ai.mjs` + `verify-ai-ui.mjs` | ✅ 摘要 / 5 话题卡 / 4 情绪点 / 3 片段 / 来源 / 证据展开 |
| 部分导入 | 同上 | ✅ 标记 Incomplete、缺失批次、按批卡片，不显示合并报告 |
| 等待导入 | 同上 | ✅ 文件/粘贴入口、空报告状态、批次提示词 |
| 粘贴导入 | 同上 | ✅ 预检查显示场次/任务/批次/Schema/覆盖 → 确认 → 报告 |
| 文件上传 + 重复 | 同上 | ✅ DataTransfer 上传真实 JSON 文件，识别 Already imported |
| 新版本 | 同上 | ✅ 版本提示 → Import as new version → 报告显示 version 2，旧版本保留 |
| 非法 JSON | 同上 | ✅ 字段 `(root)` + 原因 + 修复建议，不出现导入按钮 |
| 历史详情 | 同上 | ✅ AI 摘要卡 + View full report → 同场报告 |
| 黑暗/中文/390px | 同上 | ✅ 无横向溢出，截图 `ai-report-dark-zh-390-v080.png` |
| 打包 EXE | `verify-exe-ai.mjs` | ✅ 14/14：v7→v8、3 批、粘贴导入、汇总、报告、重启保持 |
| EXE 回归 | `verify-exe-history.mjs` | ✅ 19/19：v6→v8、历史搜索/归档/停止/删除 |
| 真实 AI | — | ⬜ **未调用**；只验证 Schema 合法合成结果 |

> 上述 AI 结果均由真实导出的包元数据构造，不是任何真实 AI 服务的输出。

## 16. Bilibili 直播生命周期专项验证（v0.8.1）

### 16.1 自动化

- 全量：**386 passed / 0 failed / 约 50–75 秒**（`node --test --test-isolation=none`）。
- `tests/unit/bilibili-lifecycle.test.mjs`：
  - PREPARING + 1 次有效离线 → 结束一次，`endQuality=event`；
  - 两次连续离线 → 结束，`endQuality=poll`；
  - 长时间无弹幕但 `live_status=1` → 不结束；
  - 超时 / 429 / 无效状态 → 不结束，持续退避；
  - PREPARING 后 LIVE → 取消结束，保持 live；
  - 其他房间 PREPARING、停止后旧帧、重复 PREPARING → 不结束/不复活；
  - PREPARING 后收到不同 `live_key`/`live_time` 的 LIVE、重连 `live_time` 变化 → 结束旧场次；
  - 重连抖动不重置离线确认计数；
  - 轮播 `live_status=2` → 结束，`platformStatus=carousel`。
- `tests/integration/live-lifecycle.test.mjs`：
  - 三场同时记录，A 平台结束只结束 A，B/C 继续；
  - 结束前写入的事件保留，结束后旧回调不再写入；
  - 手动停止 vs 平台自动结束的 `end_reason` 与平台状态不同；
  - 重复结束只结束一次；
  - 同一房间下播后快速重开创建新场次，旧回调不能写入新场次。
- `tests/integration/platform-status-recovery.test.mjs`：
  - 启动恢复 `ended_at` = 检测时间，不使用最后弹幕时间；
  - 历史修复只处理 shutdown/startup_recovery，不改编排时间，不写未知 `platform_ended_at`；
  - 429 失败保留 NULL 下次重试；修复后幂等；当前 live 不污染旧场次。
- `tests/integration/platform-status-migration.test.mjs`：v8→v9、新列/索引、旧行 NULL、
  重复迁移无操作、新库直接 v9。
- `tests/unit/bilibili-status-api.test.mjs`：0/1/2、缺字段/非法值、429、-352。
- `tests/unit/bilibili-service.test.mjs`：未开播/轮播创建前拒绝。
- `tests/unit/live-status-ui.test.mjs`：绿色 Live 不会出现在已下播状态；三语键；UI 结构。
- `tests/unit/session-status-serialization.test.mjs`：API/摘要/历史搜索字段与固定时长。

### 16.2 打包 EXE / 浏览器

| 检查 | 方法 | 结果 |
| --- | --- | --- |
| EXE 启动、schema 9、版本 0.8.1 | `scripts/verify-exe.mjs` | ✅ 10/10 |
| 真实 v6 数据库 → schema 9、历史/停止/删除/重启 | `scripts/verify-exe-history.mjs` | ✅ 19/19 |
| 已下播不再显示绿色 Live | `scripts/verify-live-status-ui.mjs` | ✅ 21/21 |
| 未知平台结束时间显示 Unknown + 说明 | 同上 | ✅ |
| 自动下播详情/手动停止详情/固定时长 | 同上 | ✅ |
| 中文生命周期文案 | 同上 | ✅ 截图 `live-status-history-v081-zh.png` |
| 390px 黑暗主题无横向溢出 | 同上 | ✅ 截图 `live-status-history-v081-dark-390.png` |

### 16.3 真实 Bilibili

| 检查 | 结果 |
| --- | --- |
| `get_info` 真实状态 0/1/2 | ✅ `22014628=0`、`6=1`、`5440`/`22637261`=2 |
| 高频 `getInfoByRoom` 风控 | ✅ 匿名返回 `-352`，轮询改用 `get_info` |
| 在线房间 25 秒无 LIVE 事件 | ✅ 证实必须轮询 |
| 离线房间 20 秒无 PREPARING | ✅ 证实“连接/无弹幕”不能推断状态 |
| 4 个真实房间 20 分钟并发 | ✅ 4/4 保持 live，170 条真实事件，无误结束 |
| 真实数据库副本 v8→v9 + 历史修复 | ✅ 问题行 `22014628` 标为 ended、结束时间 NULL/unknown、`ended_at` 与 2951 条事件不变、YouTube 行不动 |
| 真实“直播中→下播” | ⬜ **未捕获**；不能声称完全验证 |

> 真实房间测试只写 `tests/.tmp` 下的临时数据库，未触碰用户 `E:\新建文件夹` 的真实数据。

## 20. 长期观众记忆（M7 / v0.9.0）

### 20.1 自动化

| 文件 | 覆盖 |
| --- | --- |
| `tests/unit/memory-model.test.mjs` | 话题归一化（大小写/空格/标点/emoji、CJK 保留）、去重键按 kind 区分、文本清理、证据去重、差异（新增/变更/确认/删除/不变）、180 天过时规则、分组 |
| `tests/unit/memory-engine.test.mjs` | 新增去重、stated/inferred 升降级、兴趣-反感矛盾、supersede 历史、确认复活过时、拒绝确认已替换、同键冲突跳过、未知目标跳过、uncertain、outdated、人工确认/忽略/忘记/恢复、禁止复活 |
| `tests/unit/memory-ui.test.mjs` | 页面字面 key 三语存在、状态/可信度/类型标签、禁止 innerHTML、页面与导航注册、导航图标、协议常量与 Schema 一致、三语提示词内容、CSS 只用 tokens |
| `tests/integration/memory-local-merge.test.mjs` | 首次 V1、第二场 V2、三场 V3、重复合幂等、兴趣停止提及标过时（不转 dislike）、主播隔离、无分析/无主播/无场次报错 |
| `tests/integration/memory-ai-workflow.test.mjs` | 包结构/映射、导入新增+证据解析、重复导入、需新版本、乱序批次与缺失批次、未知观众、stated 无证据拒绝、inferred 无证据降级、坏 JSON/旧 Schema/错协议、越界 seq/跨批次/陌生事实 id、跨场 supersede、矛盾双方、中日英原文 |
| `tests/integration/memory-privacy.test.mjs` | 删除记忆 + 墓碑拒绝旧包、删除后新包重建、本地合并不复活、主播隔离删除、原文清理降级、删除场次清包与证据降级、过期清理预览/执行、清空数据覆盖记忆表 |
| `tests/integration/memory-migration.test.mjs` | v9→v10 真实升级、旧数据不变、部分唯一索引、重复迁移无操作、新库 v10 |
| `tests/integration/memory-api.test.mjs` | HTTP 全流程：状态/总览、无分析 409、预览不写、应用、人工确认、回滚、任务创建/下载/指令、导入预览/导入/重复、错误 JSON 422、清理预览、删除确认 |

### 20.2 手工 / 浏览器（本轮结果）

| 检查 | 结果 |
| --- | --- |
| `node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"` | ✅ 450 passed / 0 failed |
| 记忆工作台真实渲染、合并预览、分组、证据、版本、暗色、390px | ⬜ **未执行**：本机应用控制策略终止无头 Edge/Chrome（Edge `-2147483645`、Chrome `-36863`） |
| `scripts/verify-memory-ui.mjs` | ⬜ 已编写，等待可运行浏览器的环境 |
| 打包 EXE（v0.9.0、schema 9→10） | ⬜ 未构建 |

> 不把未运行的浏览器/EXE 检查写成通过。

## 21. 自动直播监听（P7 / v0.10.0）

### 21.1 自动化

| 文件 | 覆盖 |
| --- | --- |
| `tests/unit/monitoring-bilibili-detector.test.mjs` | 房间号/URL/`blanc` 解析、非法输入拒绝、短号→真实房间号、主播身份、live/offline/carousel、429/-352/404/协议/网络错误映射 |
| `tests/unit/monitoring-discovery.test.mjs` | 频道 URL / @handle / Channel ID / 视频链接解析、播放列表/剪辑/陌生域拒绝、`externalId` 优先于推荐频道、live/upcoming/ended/VOD/offline/owner mismatch/consent、RSS 时间窗与频道过滤、抖动/退避边界、公开状态派生、错误分类、摘要计数 |
| `tests/integration/youtube-monitor-detector.test.mjs` | 真实 HTTP 形状的固定 HTML：handle/频道/视频反查、单次 `/live` 检测、429/网络/restricted、结构损坏 → RSS + watch 页确认、RSS 不单独判定直播、owner mismatch 拒绝 |
| `tests/integration/automatic-monitoring.test.mjs` | 目标持久化、离线等待、开播创建普通 session、重连不新建场次、平台确认关播后回到 waiting、第二场新 session、失败退避到 error、429 `Retry-After`、暂停/恢复/删除语义、记录中禁止删除、多目标独立、重启恢复、M6 分析包导出回归 |
| `tests/integration/monitoring-migration.test.mjs` | 真实 v10→v11、旧场次不变、新列/表/唯一约束、重复迁移无操作、新库直接 v11 |
| `tests/integration/monitoring-api.test.mjs` | HTTP：添加/重复 409/列表/状态摘要/立即检查/暂停/暂停时检查 409/恢复/场次列表/删除确认/删除、重启恢复目标 |
| `tests/integration/youtube-auto-monitoring.test.mjs` | 真实 detector + 真实匿名聊天 adapter + 真实 SessionManager：检查→开播→记录→聊天入库→聊天结束→目标 waiting→第二场新视频新 session→目标场次列表 2 条 |
| `tests/unit/monitoring-ui.test.mjs` | 监听页字面三语 key、全部状态/错误码标签、监听 Tab 与手动 Tab 分离、无 innerHTML、状态 CSS、只用 tokens、窄屏规则 |

### 21.2 覆盖矩阵（任务要求）

| Bilibili | 覆盖 |
| --- | --- |
| 未开播等待 | ✅ 状态 waiting + 下次检查 |
| 开播检测 | ✅ fake `liveStatus=1` |
| 自动连接/开始记录 | ✅ 真实 `SessionManager` + fake adapter |
| 关播检测/自动结束 | ✅ adapter `onEnd` + session ended |
| 下一场自动开始 | ✅ 同一目标第二个 session |
| 网络断线恢复 | ✅ reconnecting 不改变 session；错误不退避成关播 |
| 平台接口异常 | ✅ 网络/429/协议错误 |
| 多直播间同时监听 | ✅ 两目标独立状态 |
| 真实平台长跑 | ⬜ 未执行 |

| YouTube | 覆盖 |
| --- | --- |
| 频道 URL / @handle / Channel ID | ✅ 解析 + HTTP 添加 |
| 无直播 / 预定 / 正在直播 / 已结束 | ✅ 固定页面 fixture |
| 视频 ID 提取 | ✅ owner 校验 |
| 新直播发现 / 旧直播不重复 | ✅ 两场端到端不同 video id |
| 频道页面异常 | ✅ 结构损坏 → RSS 回退；空 feed → 显式错误 |
| 限流和退避 | ✅ 429 `Retry-After` |
| 聊天不可用 | ✅ 错误码映射与可见 error（单元/状态机覆盖；未接真实样本） |
| 多频道同时监听 | ✅ 多目标独立调度（Bilibili 为主，YouTube 解析/检测独立） |
| 真实 YouTube 页面 | 🟡 2026-11-10 只读实测 1 个频道（Lofi Girl）解析成功；不等于长期稳定 |

| 通用 | 覆盖 |
| --- | --- |
| Tab 持久化 | ✅ 目标 Tab 由 `monitor_targets` 驱动，不因 session 结束消失 |
| 软件重启恢复 | ✅ HTTP 测试真实重启；启动错峰 |
| 暂停与恢复 | ✅ |
| 重复添加目标 | ✅ 409 `MONITOR_TARGET_EXISTS` |
| 重复开播事件 | ✅ 平台状态机 + 同一 session |
| 网络重连不错误分场 | ✅ 连接状态与 session 分离 |
| 自动与手动共存 | ✅ 手动场次 tab 与监听 tab 分开；重复房间被拒绝 |
| 数据库迁移 | ✅ v10→v11、v1→v11、旧库不变 |
| M6/M7 回归 | ✅ 自动场次导出 `livememory-analysis-v1`；普通 sessions 表 |
| Windows 构建/UI | ⬜ 见 §21.3 |

### 21.3 真实浏览器与构建

| 检查 | 结果 |
| --- | --- |
| 自动监听页面真实渲染/截图/390px | ⬜ **未执行**：本机策略仍终止无头 Edge/Chrome |
| `scripts/verify-monitoring-ui.mjs` | ⬜ 未编写（本轮只有静态 UI 检查） |
| 真实 Bilibili「开播→关播→再开播」 | ⬜ 未捕获 |
| 真实 YouTube 长跑 | ⬜ 未执行（仅少量只读页面解析） |
| 打包 EXE | 结果见 `docs/STATUS.md`（本轮实测） |

> 自动监听没有下载视频/音频；网络测试只使用本地假网页或固定 fixture，真实 YouTube 仅 1 个频道、共约 5 次只读请求。

## 22. 统一分析与长期记忆（P8 / v0.11.0）

### 22.1 自动化

| 文件 | 覆盖 |
| --- | --- |
| `tests/integration/unified-analysis-memory.test.mjs` | A 五场每场一句话（客观场次/发言/最近时间、语义逐步积累、问候不生成兴趣）；B 普通问候（version 0、无事实、覆盖 no_semantics）；C 单条有效信息（stated + 证据 seq）；D 300 位低活跃观众（两批、全部覆盖、无 Top N、任务覆盖完成、300 个记忆头）；E 300 观众跨 6 批（每位只在一个记忆批次、全部摘录随行、乱序导入、重复导入幂等、部分覆盖）；缺少某观众更新 → `MEMORY_VIEWER_UPDATE_MISSING` 阻塞 |
| `tests/integration/ai-batching.test.mjs` | 消息边界、seq→event 完整映射、乱序/缺失批次、汇总任务；仍全部通过 |
| `tests/integration/ai-import.test.mjs` | 单批导入、证据、重复/新版本、回滚、旧包、清理；仍全部通过 |
| `tests/integration/ai-api.test.mjs` | HTTP 任务/包/预览/导入/版本/汇总/报告；schema 1.2.0、memory 覆盖状态 |
| `tests/integration/memory-local-merge.test.mjs` | 导入先建 version 0 客观头，再本地合并 version 1；原有 M7 规则 |
| `tests/integration/memory-migration.test.mjs` | v9→v12；旧数据不变；新表；重复迁移 |
| `tests/integration/monitoring-migration.test.mjs` | v10→v12；监听目标与统一记忆表共存 |
| `tests/unit/ai-prompts.test.mjs` | 三语提示词含 batch/aggregate/memory 规则、`viewer_memory_updates`、schema 1.2.0、prompt m6.2 |
| `tests/unit/memory-ui.test.mjs` | 独立记忆页已移除、旧链接进入 AI 分析；观众面板禁止 innerHTML；tokens |
| `tests/unit/i18n.test.mjs` | 三语键/占位符一致（含新增 memory 预览/客观历史/错误原因） |

### 22.2 关键验收对应

| 任务要求 | 结果 |
| --- | --- |
| 一次导出/一次 AI/一次导入 | ✅ 同一 result 内 `session_topics` + `viewer_memory_updates`；测试 A/C |
| 所有可识别观众 | ✅ 300 位低活跃观众全部覆盖；无 Top N/最低发言 |
| 低频观众跨场积累 | ✅ 五场一句话：场次 5、发言 5、语义事实逐步增加 |
| 只有礼物/SC | ✅ 客观历史接口与覆盖路径；真实平台礼物样本未做 |
| 已有画像进入上下文 | ✅ `memory_context.viewers[].memory`，单测/流程覆盖 |
| 分批不拆散观众 | ✅ 每位观众一个记忆批次、全部摘录随行 |
| 缺少观众更新 | ✅ 阻塞导入并给出路径 |
| 重复导入 | ✅ duplicate，不重复写入/覆盖状态不变 |
| 独立工作流移除 | ✅ 页面/导航/文件删除；旧链接到 AI 中心 |
| 真实 AI 返回统一 JSON | ⬜ **未执行**（只有合成样本） |
| 真实浏览器 UI | ⬜ **未执行**（本机策略阻止） |
| 打包 EXE | ⬜ 构建结果见 STATUS，运行验收未完成 |

### 22.3 未验证边界

- 真实 AI 是否稳定为每位观众返回条目、是否正确引用 viewer_excerpts seq；
- 数千观众真实大场的内存/包大小/导入耗时；
- 真实浏览器渲染、暗色、390px；
- 旧 M7 任务数据在真实用户库中的只读查看（自动化只覆盖表结构）。

## 23. 观众档案主播范围补丁（v0.11.1）

| 场景 | 测试 | 断言 |
| --- | --- | --- |
| 单主播 | `viewer-broadcaster-scope` / `viewer-scope` | 只返回该主播；详情隐藏下拉；`broadcasterCount=1` |
| 双主播 | 同上 | 只返回两位实际主播，不含第三位 |
| 多主播 | 同上 | 三位实际主播全部显示，无全局列表泄漏 |
| 无关联主播 | 同上 | `profile.broadcasters=[]`；`resolveDetailScope→null`；UI 显示空状态 |
| 跨平台同名 | `viewer-broadcaster-scope` | YouTube 与 Bilibili 同名观众各自只有自己的主播，ID 不合并 |
| 仅礼物互动 | 同上 | `paymentEventCount=1`、`messageCount=0`、`sessionCount=1`，仍属于该主播 |
| 无关 scope | 同上 | `buildViewerProfile(...,{broadcasterId: unrelated})` 返回 `scope.kind='none'` |
| 无效/已删除 scope | `viewer-scope` | 回退到当前有效或第一个关联主播，绝不回退“全部主播” |

全量结果：**495 passed / 0 failed**（约 80 秒）。真实浏览器渲染仍未验收。

## 24. 自动 AI 分析（v0.12.0）

### 24.1 自动化测试（Mock transport / 本地 HTTP）

| 文件 | 覆盖 |
| --- | --- |
| `tests/unit/auto-client.test.mjs` | 纯 JSON/围栏/前后说明提取；数组拒绝；滑动窗口；匿名请求头；JSON mode；429 `Retry-After`；5xx；timeout；空 content；非 JSON 响应 |
| `tests/unit/auto-prompt.test.mjs` | 批次契约列出每位观众 ID 与证据 seq；汇总契约禁止记忆更新；上下文预算错误；修复消息保留原包与错误列表 |
| `tests/integration/auto-analysis.test.mjs` | 单批成功；3 批 + 汇总；primary 失败→备用；全失败不写结果；一次 Schema 修复；错误证据拒绝；第 2 批失败保留第 1 批并恢复；重复点击 409；取消后恢复；重启 interrupted 后恢复；汇总失败保留全部批次；失败不覆盖旧记忆；重复导入 duplicate |
| `tests/integration/auto-api.test.mjs` | `consent` 400；202；运行中 409；状态/取消；超过 12 批 422 且不创建 job；手动 preview/import 仍可用 |
| `tests/unit/ai-ui.test.mjs` | 自动按钮/阶段/取消/同意/详情；三语精确错误文案；无 `alert()`、无 `innerHTML`；手动控件仍存在；配置里不含未验证 provider |

全量结果：**525 passed / 0 failed**（约 93 秒，2026-11-11）。

### 24.2 真实匿名 API 测试（非自动化，需外部网络）

本轮在开发机用临时脚本执行（未提交，避免 CI/自动化意外发出公共免费请求）；结果与时间见
`docs/ANONYMOUS_AI_RESEARCH.md`。

| 场景 | 结果 |
| --- | --- |
| OVH `gpt-oss-20b` 基础/JSON/多语言 | ✅ 200，真实模型回答 |
| OVH 真实 LiveMemory 包（3 观众） | ✅ `complete`、`semantic=3`、`source=auto`，证据 seq 正确 |
| OVH 真实跨场次记忆（画画→吉他） | ✅ 旧事实 `superseded`，新增“吉他”与“最近不怎么画画了” |
| Murakumo | ❌ 503/502；无有效回答 |
| llmfaucet | ❌ DNS NXDOMAIN |
| LLM7 | ❌ 官方要求 Token；未集成 |
| Pollinations 真实包 | ❌ HTTP 400；未集成 |

### 24.3 未验证

- 真实浏览器渲染/截图、暗色、390px；
- 打包 EXE 的出站网络行为；
- 数千观众/数万消息大场的实际耗时与免费限流；
- 第二个通过完整 LiveMemory 包的匿名 provider。

## 25. 真实故障修复回归（v0.12.1）

### 25.1 根因复现（真实样本，离线复制，不修改用户库）

| 证据 | 结果 |
| --- | --- |
| 自动 batch 1（25 观众、33 消息、`max_tokens=9250`、`json_object`） | HTTP 200，169.5 秒，`prompt_tokens=44682`，`completion_tokens=9250`，`finish_reason=length`，重复字段名，JSON 不完整 |
| 同一 batch 改 `json_schema` | HTTP 200，72 秒，`finish_reason=stop`，`completion_tokens=2014`，JSON 有效；但 2 个其他批次观众被写入、2 个本批观众缺失 |
| 批次 `viewer_context` vs `memory_context` | batch 1：32 vs 25；batch 2：32 vs 22；batch 3：23 vs 5（跨批次观众可见） |
| 手动 52 人新提示词（OVH） | 96.5 秒，`prompt_tokens=75516`，`completion_tokens=2907`，49/52 更新；3 位缺失，1 个未知 profile ID |

### 25.2 场景矩阵

| 场景 | 验证方式 | 结果 |
| --- | --- | --- |
| 3 位观众 | Mock 单批 | ✅ 3/3，事务导入 |
| 10 位观众 | 真实 OVH 单批 | ✅ 10/10，14.4 秒，489 completion tokens |
| 25 位观众（原自动上限） | 真实 OVH 单批，紧凑格式 | ✅ 25/25，20.4 秒，751 completion tokens |
| 52 位观众 / 99 条消息（真实规模） | 真实 OVH 6 批 + 汇总 | ✅ `complete`，52/52，`missing_update=0`，7 条结果 |
| 100 位低活跃观众 | 本地集成，10 批 | ✅ 100/100，10 条批次结果 |
| 多批次 | 本地集成 + 真实 6 批 | ✅ 批次隔离、顺序、最终汇总 |
| 初始空档案 | 真实 52 人（`viewer_memories=0`） | ✅ 生成 52 个记忆头；语义 0（聊天只有问候/表情，未编造） |
| 已有长期记忆 | 既有 M7/P8 测试 + 自动跨场次测试 | ✅ 更新/确认/替代旧事实路径不变 |
| 中日英混合 | 既有 prompt 测试 + 真实日语包 | ✅ 三语说明、日语真实包通过；未做混合真实 API 样本 |
| 错误 ID | 手动 52 人测试（2 未知 + 2 缺失） | ✅ 阻塞、精确 gaps、不写库、不自动改 ID |
| 错误 ref | 单元 + 集成 | ✅ 越界/重复/缺失拒绝；缺失只做一次定向补充 |
| JSON 截断 | 集成（`finish_reason=length`） | ✅ `AUTO_OUTPUT_TRUNCATED`，不导入 |
| 429 / 超时 / 5xx | 既有 client 单元测试 | ✅ Mock 分类与重试/限流逻辑未变 |
| 零摘录观众（仅 Super Sticker） | 集成 + 真实包中存在 | ✅ 必须一条 `no_new_information`；定向提示词明确“no chat excerpts” |
| 手动 52/52 正确 JSON | 集成 | ✅ 一个事务导入，覆盖率 52/52 |

### 25.3 自动化结果

- 新增：`tests/unit/auto-assemble.test.mjs`、`tests/unit/ai-import-repair.test.mjs`、
  `tests/integration/auto-compact.test.mjs`、`tests/integration/manual-52-viewers.test.mjs`。
- 更新：`auto-client`（structured output、截断、退化）、`auto-prompt`（紧凑契约）、
  `auto-api`（maxBatches=30、310 观众 → 31 批 422）、`ai-prompts`/`ai-api`/`ai-import`
  （提示词版本 m6.3）。
- 全量：**545 passed / 0 failed**（约 77 秒，2026-11-11；
  `node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`）。

### 25.4 未验证（必须保留）

- 用户手动分析实际使用的 AI 模型/服务；任意模型一次覆盖 52 位没有保证。
- 真实浏览器中的 gaps 列表、复制修复按钮、暗色、390px。
- Windows EXE 启动、出站请求、代理/防火墙/UAC。
- 1000+ 观众真实免费接口的耗时与限流；本轮未做高频压力测试。
- 新 `session.duration_seconds` 规则的真实汇总效果（未重新跑新包汇总）。
