# 工程状态（STATUS）

最后更新：2026-11-08（P0 普通权限启动修复 + M3 起步，版本 0.1.0）

> 本文件是唯一进度来源。只要代码与本文不一致，以代码与实测为准，并立即修正本文。

## 1. 当前阶段

- 里程碑：**M0 完成，M1 完成，M2 部分完成，P0（普通权限启动）完成，M3 进行中**
- 版本：`0.1.0`（`package.json` 与 `src/shared/app-info.mjs` 一致）
- 分支：`main`，本地提交，未 Push


## 2. 已完成（有代码与验证）

### 工程与文档
- 独立 Git 仓库（`origin` 指向 github.com/zgrg29/LiveMemory，未 push）
- `.gitignore` 排除用户数据、构建产物、参考仓库、临时目录
- `AGENTS.md`、`README.md`、MIT `LICENSE`、`start.cmd`
- 全部 16 份 `docs/*` 文档与 `log/` 开发记录

### Windows 启动器
- 环境检查（Node ≥ 22.5、`node:sqlite` 可用）
- 数据目录解析：`--data-dir` / `LIVE_MEMORY_DATA_DIR` / `%LOCALAPPDATA%\LiveMemory` / `%APPDATA%` / 用户目录，逐级可写探测
- 单实例锁（PID + 存活检测 + 陈旧锁接管）
- 端口选择：默认 47800，冲突自动 +1…+9，最后使用系统分配端口
- 服务就绪后才打开系统默认浏览器；失败时打印可复制地址
- 三语命令行（zh-CN / ja / en），读取已保存语言偏好；`--lang` 可临时覆盖
- UTF-8 控制台（`chcp 65001`），中文/日文输出已实测
- 优雅退出：停止适配器 → 关闭 SSE → 关闭 HTTP → WAL checkpoint → 关闭数据库 → 删除 runtime 文件
- 崩溃恢复：启动时把遗留 `live` 场次标记为 `interrupted`，结束时间取最后事件时间

### 数据层
- `node:sqlite`，WAL，schema 版本 1，迁移可重复执行
- 表：`sessions`、`events`、`viewers`、`viewer_nicknames`、`viewer_sessions`、`viewer_currency_totals`、`session_currency_totals`、`ai_packages`、`app_meta`
- 唯一写入管线 `EventIngest`：去重 → 观众聚合 → 场次金额 → 场次计数，单事务
- `UNIQUE(session_id, dedupe_key)` 防止重复投递导致金额/计数翻倍
- 金额：整数最小货币单位，按 `currency` + `value_kind`（actual/display/unknown）分账
- 观众身份：`platform:uid`，昵称历史独立保存，跨平台不合并

### 服务器与 API
- 仅监听 `127.0.0.1`；Host 校验（DNS rebinding 防护）、Origin 校验、CSP、nosniff、无 framing
- 静态资源路径穿越防护；JSON body 1 MB 限制与 Content-Type 校验
- 路由：health、bootstrap、status、settings、sessions（列表/当前/详情/停止）、simulate（开始/停止）、viewers（列表/详情/关注）、events + SSE、storage、AI instructions、AI packages（创建/列表/下载）
- 设置持久化 `config/settings.json`（原子写入，损坏自动备份并回退默认）

### 记录引擎与模拟平台
- 模拟适配器：24 位中/日/英观众、话题漂移、弹幕、免费/付费礼物、SC、大航海
- 3% 概率故意重复投递同一事件，验证去重
- 场次生命周期：live → ended / interrupted
- 统计：消息、付费事件、独立观众、峰值/均值、按币种支持
- 时间线：10 秒–1 小时自适应粒度，当前未完成的时间段不绘制

### 网页控制台（Apple 风格）
- 5 个页面：直播记录、直播历史（含详情）、观众档案（含详情）、AI 分析中心、设置
- 明亮 / 黑暗 / 跟随系统，token 化设计，首帧无闪烁，随系统主题实时切换
- 三语 JSON 文案，键一致性与占位符有自动化测试
- 响应式：≤860px 侧边栏抽屉、统计卡重排，390px 宽度无横向溢出
- Canvas 消息密度图，主题切换自动重绘，hover 提示
- 模拟直播开始/停止、实时事件流、最近动态、最活跃观众
- 观众搜索、重点关注开关、昵称历史、参与场次
- AI 三步向导：导出分析包（可用）、复制提示词（可用）、导入（明确标注 M6 计划）
- 设置：语言、主题、存储模式、数据统计、关于

### AI 分析包（导出侧）
- 单文件 ZIP（自研 STORE 写入器，零依赖，UTF-8 文件名，路径穿越防护）
- `manifest.json` 对 5 个内容文件做 SHA-256；不含自引用
- 三语 `instructions.md`（中文/日文/英文分别本地化，不混用英文标题）
- `result.schema.json`（`livememory-analysis-result-v1`）
- 导出记录写入 `ai_packages`，场次 `ai_status` 变为 `exported`

### Windows 普通权限启动修复（P0）✅

用户实测普通权限双击 EXE 闪退。实测复现并定位到的代码级缺陷与修复：

- 启动器错误处理只覆盖 `startServer`，数据目录/配置/日志/锁阶段的异常直接冒泡成英文堆栈 → 改为**全链路守护**，每步记录步骤名、错误码与路径。
- `accessSync(W_OK)` 在 Windows 不检查写权限 → 改为**真实写探测**（创建/写入/读回/删除），返回失败步骤与真实错误码。
- 没有任何早期日志 → 新增启动日志（数据库之前可用），`%TEMP%\LiveMemory-logs` 兜底，解析出数据目录后迁入 `<数据目录>\logs`，失败时写 `startup-error.json` 与 `runtime\last-error.json`。
- 单实例只看 PID → 改为「PID + `runtime.json` + `/api/health` 必须是 LiveMemory」，陈旧锁自动接管，不再误报「已在运行」后静默退出。
- SEA 解压每次重写、非原子 → staging + 标记 + 原子 rename，二次启动复用；失败逐级回退并记录。
- 失败不再闪退：三语提示 + 失败步骤/错误码/日志路径 + 交互式等待按键（自动化跳过）+ `--error-dialog` 可选系统错误框 + 未捕获异常兜底。
- 附带修复：`logger.redactValue` 脱敏正则错误（会把原值重新拼回文本）。

自动化：`scripts/verify-exe.mjs` 9 项 EXE 矩阵（普通权限 8 通过 / 1 项为脚本自身判定已修正后重跑通过），详见 `docs/TEST_PLAN.md` 与 `log/2026-11-08-p0-windows-startup.md`。

### Windows EXE

- `node scripts/build-windows.mjs` 生成 `dist/LiveMemory.exe`（Node SEA + postject，校验 postject 包 SHA-256）
- PE 子系统强制为 Console（3），双击可见命令行窗口
- 应用资源嵌入 EXE，首次运行解压到 `<数据目录>\app\<hash>\`，失败时回退到用户临时目录
- 本机实测（最终源码构建）：`--version`、`--help --lang ja`、单实例提示、`/api/health`、静态资源均正常，解压目录哈希 `612f0f97b537a08cdad4`
- 构建产物：约 89.7 MB，最终构建 SHA-256 `dcd86c5db339f0e75a099597c6e1aaa4bbca2912afa465016ea7899472ce4622`（仅记录本次构建，不作发布校验值）

## 3. 部分完成

| 项目 | 现状 | 缺口 |
| --- | --- | --- |
| 精简/完整存储模式 | 设置可保存；模式写入场次；清理函数已实现并有测试 | 自动清理未接入（需在 AI 导入校验后触发，M4/M6） |
| AI 分析中心 | 导出、提示词复制、包列表可用 | 导入、Schema 校验、分批、合并（M6） |
| 观众画像 | 稳定身份、统计、昵称历史、关注标记 | 兴趣/喜恶/变化（依赖 M7 的 AI 画像） |
| 备份与恢复 | 文档与数据模型已设计 | 导出/导入/校验/回滚（M5） |
| 平台接入 | 统一事件模型、适配器契约、模拟平台 | Bilibili / YouTube 真实连接（M3） |

## 4. 未完成

- Bilibili 扫码登录与直播 WebSocket 接入（参考仓库已验证的协议需按当前平台再核实）
- YouTube 公开数据读取（API Key 方案）与 OAuth 边界
- AI 结果导入与 Schema 校验、重复导入保护
- 长期观众 AI 画像与增量更新
- 可移植备份 `.livememory`、加密、跨电脑恢复
- 数据删除 / 清理 UI、存储占用管理
- 真实平台下的去重、断线重连、异常恢复验收
- 干净 Windows 环境 EXE 验收、代码签名、发布流水线
- 韩语 / 西班牙语预留

## 5. 测试结果（2026-11-08）

命令：

```bat
node --test --test-isolation=none tests/unit/*.test.mjs tests/integration/*.test.mjs
```

结果：**119 个测试全部通过，0 失败，约 5 秒**（P0 阶段；M3 用例在下一个提交中增加）。

覆盖：
- 单元：语言解析、主题、金额、事件规范化/去重、时间、热度分桶、三语文案一致性、ZIP、设置存储、单实例锁、启动参数、数据目录、真实写探测、启动日志与回退、实例健康探测、暂停/对话框、脱敏、bootstrap 解压与标记
- 集成：启动失败路径（不可写目录 → 本地化提示 + 启动日志 + 退出码 1）、`--diagnose`
- 集成：迁移幂等、事件落库与聚合、重复投递不翻倍、跨场次观众统计、匿名事件、崩溃恢复、内容清理、HTTP API 全流程、权限/安全校验、SSE、分析包校验和

UI 验证：本机用无头 Edge 通过 DevTools 协议截图（明亮/黑暗、中文/日语、桌面/390px），截图见 `docs/screenshots/`。**未在第二台干净 Windows 机器上做视觉验收。**

## 6. 已知问题与限制

1. `Ctrl+C` 的真实控制台信号未在自动化中复现；优雅退出通过 `startServer().close()` 集成测试与代码路径验证，仍需人工按一次 Ctrl+C 确认。
2. EXE 仅在本开发机验证；沙箱环境禁止浏览器进程，截图验证是通过临时放宽访问完成的。
3. 动态选中的端口不会写回设置，下一次仍优先尝试 `preferredPort`。
4. 静态资源使用 `no-cache` 且无 ETag，每次请求重新下载（本地可接受）。
5. 模拟数据会长期保留在测试数据目录；真实用户数据目录不受影响。
6. 分析包未分批，单包最多 20,000 条消息；超长直播需要 M6 的分批机制。
7. 图表无缩放/区间选择；热度图为整场概览。
8. 无删除场次/观众的 UI（数据库层已支持级联删除）。
9. `--help` 通过管道截断时进程可能以 1 退出（PowerShell 提前关闭管道所致，非程序错误）。

## 7. 阻塞事项

无硬阻塞。真实平台接入需要对当前 Bilibili / YouTube 协议做一次带真实直播间的验证（M3），这是下一阶段的主要风险点。

## 8. 下一步目标

1. 修复/确认 Ctrl+C 优雅退出的人工验证。
2. 进入 M3：先做 Bilibili 扫码登录 + 直播间连接（复用参考仓库的协议实现，逐字段核对当前返回），再用真实直播间验证事件身份字段。
3. 同步更新 `docs/PLATFORM_INTEGRATIONS.md` 的验证状态。

## 9. 最近 Commit

见本文件同目录的 Git 历史；首轮提交信息：`feat: initialize LiveMemory with launcher, local console and recording pipeline`。
