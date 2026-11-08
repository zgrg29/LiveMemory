# 测试计划与结果（TEST_PLAN）

## 1. 策略

| 层级 | 目的 | 位置 |
| --- | --- | --- |
| 单元测试 | 纯逻辑：语言、主题、金额、事件、去重、时间、分桶、ZIP、设置、锁、参数、数据目录 | `tests/unit/` |
| 集成测试 | 迁移、落库与聚合、HTTP API、安全校验、SSE、分析包 | `tests/integration/` |
| 启动冒烟 | 启动器真实启动、单实例、命令行三语、EXE | 手工 + `scripts/` |
| UI 验证 | 三主题、三语言、响应式、图表、空状态 | 手工 + 无头 Edge 截图 |
| 真实平台 | Bilibili / YouTube 直播事件 | 未开始（M3） |
| 跨电脑迁移 | 备份导出/导入一致性 | 未开始（M5） |

## 2. 运行方式

```bat
node --test tests/unit tests/integration
```

受限环境（禁止子进程，如某些沙箱）使用单进程模式：

```bat
node --test --test-isolation=none tests/unit/*.test.mjs tests/integration/*.test.mjs
```

测试通过 `tests/helpers/temp-dir.mjs` 在 `tests/.tmp/` 下创建隔离数据目录，绝不触碰真实用户数据。API 集成测试使用 `port: 0`（系统分配端口）。

## 3. 覆盖清单

### 3.1 单元

| 文件 | 覆盖 |
| --- | --- |
| `locale.test.mjs` | 语言别名、非法值、跟随系统回退英文、环境变量识别 |
| `theme.test.mjs` | 三种主题、系统解析、存储模式 |
| `money.test.mjs` | 两位/零位小数币种、四舍五入、非法值、精确乘法 |
| `events.test.mjs` | 规范化、身份命名空间、礼物金额、免费/未知金额、别名、时间秒/毫秒、去重键、非法输入、超长文本 |
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

### 3.2 集成

| 文件 | 覆盖 |
| --- | --- |
| `storage.test.mjs` | 迁移幂等、事件聚合、重复投递不翻倍、跨场次观众、昵称历史、跨平台隔离、匿名事件、崩溃恢复、内容清理、非 live 拒绝写入 |
| `api.test.mjs` | health/bootstrap、CSP、设置校验与持久化、模拟记录、事件列表、重复开始 409、停止、历史与详情、分析包下载与校验和、观众列表/档案/关注、SSE、Host/Origin/路径穿越/404、runtime 文件、重启后设置保持 |
| `ai-package.test.mjs` | 包结构、任务与计数、seq 顺序、校验和、三语说明不混英文、导出记录、未知场次返回 null |

## 4. 本轮结果（2026-11-08）

```text
tests 119
pass  119
fail  0
duration ≈ 5.1s
```

（P0 阶段，不含 M3 的 Bilibili 用例；M3 用例见下一次提交。）

无跳过、无 todo。

## 5. 手工 / 脚本验证记录

| 项目 | 方法 | 结果 |
| --- | --- | --- |
| 启动器中文控制台 | `node src/launcher/launcher.mjs --no-open` | ✅ 名称/版本/数据目录/地址/记录状态/退出方式 |
| 启动器日文控制台 | 保存语言=ja 后再次启动 | ✅ 日文提示，含“已在运行” |
| 单实例 | 第二个进程同数据目录 | ✅ 提示已在运行，显示 URL，退出 0 |
| 非法参数 | `--port abc` | ✅ 退出 2 |
| `--help` 三语 | `--lang ja/en/zh-CN` | ✅ |
| 模拟直播 | API + 浏览器 | ✅ 126/197 条消息，图表、动态、观众统计正确 |
| 分析包 | 下载 ZIP 后用 `Expand-Archive` | ✅ 6 个文件，manifest 校验和一致，UTF-8 正常 |
| 明亮/黑暗/跟随系统 | 截图 + 设置持久化测试 | ✅ |
| 中文/日语界面 | 截图 | ✅ |
| 390px 响应式 | 截图 | ✅ 无横向溢出 |
| EXE 构建 | `node scripts/build-windows.mjs` | ✅ 89.7 MB，SHA-256 `dcd86c5d…` |
| EXE 启动 | `dist\LiveMemory.exe --no-open --data-dir ...` | ✅ health 200、首页 200、解压 64 文件 |
| EXE `--version` | 直接运行 | ✅ |
| EXE 单实例 | 第二个 EXE | ✅ |
| EXE 控制台子系统 | 读取 PE 头 | ✅ subsystem=3 |
| EXE 普通权限完整启动 | `scripts/verify-exe.mjs`（非管理员令牌） | ✅ 全新目录启动、health 200、SQLite、控制台数据 |
| EXE 默认目录不可写 | 本机沙箱拒绝 `%LOCALAPPDATA%`/`%APPDATA%` | ✅ 回退 `%TEMP%\LiveMemory` 并启动，控制台提示实际目录 |
| EXE 显式不可写目录 | `--data-dir C:\Windows\System32\...` | ✅ 退出码 1、本地化提示、步骤 data-dir、错误码 EPERM、日志已写 |
| EXE 旧数据与重启 | 同目录重启 | ✅ 场次/观众数保持 |
| EXE 强制结束恢复 | 记录中 taskkill 后重启 | ✅ 场次 interrupted、消息保留 |
| EXE 端口占用 | 预先监听 49110 | ✅ 改用 49111 |
| EXE 重复启动 | 第二个 EXE | ✅ 退出 0、提示已运行、首实例健康 |
| EXE 其他目录运行 | 复制到 Downloads + 无关 cwd | ✅ 正常启动 |
| EXE 解压复用 | 二次启动 | ✅ 解压目录未重写 |
| EXE CLI | `--version` / `--help --lang ja` / `--diagnose` | ✅ |

## 6. 尚未验证（必须如实保留）

1. 真实 Ctrl+C 优雅退出（自动化无法发送控制台信号）。
2. 干净 Windows 10/11 虚拟机（非管理员、无 Node）。
3. EXE 代码签名/杀毒误报。
4. 真实 Bilibili / YouTube 事件（M3）。
5. 跨电脑备份迁移（M5）。
6. AI 结果导入与 Schema 校验（M6）。
7. 长时间（>4h）直播的稳定性与内存占用。
8. 多显示器 / 高 DPI 控制台字体。

## 7. M3 起需补充的测试

- 平台消息解析：用录制的真实消息样本（脱敏）做夹具，验证字段映射与金额单位。
- 断线重连：模拟 close/心跳超时，验证指数退避与去重。
- 身份缺失：UID 为空时不得更新画像。
- 金额单位：每个平台单独断言“1 单位货币 = N minor units”。
- 真实直播间验收表（房间号、日期、事件类型、字段核对）。
