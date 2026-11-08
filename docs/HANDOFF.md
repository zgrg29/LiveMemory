# 交接文档（HANDOFF）

本轮：2026-11-08 · P0 普通权限启动修复 + P1 M3 Bilibili 最小闭环 · v0.1.0

## 1. 本轮目标

1. 修复「普通权限双击 EXE → CMD 一闪而过」的真实用户问题；
2. P0 通过后开始 M3：Bilibili 真实直播最小闭环；
3. 保留既有 M0–M2 能力（Apple 风格 UI、三语、主题、SQLite、模拟直播、AI 分析包）；
4. 重新构建 EXE、跑测试、同步文档、创建两个独立本地 Commit。

## 2. P0：普通权限启动（commit `f8d64c4`）

### 根因（已实测复现）

- 启动器只守护 `startServer`，数据目录/配置/日志/单实例锁阶段的异常直接冒泡到 SEA bootstrap，只打印英文堆栈 → 双击窗口瞬间关闭。
- `accessSync(W_OK)` 在 Windows 不检查写权限，不可写目录能通过预检查，失败推迟到锁文件（正好在盲区）。
- 单实例只看 PID：普通权限查询提权进程返回 EPERM 被当成存活；PID 复用会误报「已在运行」并 exit 0。
- SEA 解压每次重写、非原子；失败留下半套资源。
- 附带修复 `logger.redactValue` 脱敏缺陷（会把原值拼回文本）。

### 修复

- 全链路启动守护 + 每步状态/错误码；三语失败提示；交互式等待按键；`--error-dialog`；未捕获异常兜底。
- 早期启动日志（数据库前可用），临时目录回退，解析数据目录后迁入 `<数据目录>\logs`；`startup-error.json` / `runtime\last-error.json`。
- 真实写探测（创建/写入/读回/删除）、数据目录回退链、`LIVE_MEMORY_DEFAULT_DATA_DIR` 仅作偏好。
- 单实例：PID + `runtime.json` + `/api/health` 三重判定；陈旧锁接管。
- SEA：staging + 标记 + 原子 rename；二次启动复用。
- 新增 `--diagnose` 环境诊断。

## 3. P1：Bilibili（M3 第一阶段）

- `src/platforms/bilibili/`：`wbi` / `protocol` / `api` / `adapter` / `mapper` / `cookie-store` / `login` / `service`。
- 真实直播间验证（匿名）：
  - `21144080`：30s 收到 142 条 `DANMU_MSG`，**142 条都带 UID 与昵称**；
  - `5050`：77 条弹幕中 72 条 `uid=0` + 昵称打码 → 记为无身份，不合并；
  - `7734200`、短号解析、`getDanmuInfo`（WBI + buvid3）、WebSocket 鉴权、心跳、zlib/brotli、重连调度均验证。
- 金额：礼物金瓜子 1000=1 元；SC 元×100；大航海单位未确认 → 不记金额。
- 扫码登录后端与加密 Cookie；UI 在浏览器打开 Bilibili 扫码页（未内置 QR 渲染）。
- 路由 `/api/bilibili/*` + 直播页「直播来源」面板 + 三语文案。

**未验证**：礼物/SC/大航海真实事件、`SEND_GIFT_V2`、登录后字段差异、真实断线长时间运行。

## 4. 测试与验证

- 自动化：**161 个测试通过，0 失败**（约 5.5s）。
- `scripts/verify-exe.mjs`：普通权限 EXE 矩阵（全新目录、重启保留、强制结束恢复、端口占用、重复启动、不可写目录、其他目录运行、解压复用、CLI）。
- `scripts/probe-bilibili.mjs`：真实房间字段采样（不打印内容/凭据）。
- `scripts/verify-bilibili.mjs`：房间 → 连接 → 入库 → 控制台读模型 → 停止。

## 5. 未验证 / 环境边界（如实保留）

- 真实交互式桌面「双击」：本执行环境无法创建桌面会话；已确认进程为非管理员令牌。
- 管理员模式对照：本环境无法触发 UAC，未执行。
- 本机 DSH 沙箱拒绝 `%LOCALAPPDATA%`/`%APPDATA%`，因此「默认目录不可写 → 回退 `%TEMP%`」路径被真实验证；真实用户环境应正常写入 `%LOCALAPPDATA%`。
- 浏览器自动打开只验证到「已发出系统打开请求」，没有视觉确认。
- Windows 在进入程序前拦截（SmartScreen / 映像损坏）无法被程序捕获。

## 6. 请用户本机确认

```bat
:: 1) 普通权限双击（不要右键以管理员身份运行）
dist\LiveMemory.exe

:: 2) 若怀疑环境问题
dist\LiveMemory.exe --diagnose

:: 3) 查看日志
%LOCALAPPDATA%\LiveMemory\logs\startup-*.log
%LOCALAPPDATA%\LiveMemory\logs\livememory-*.log
```

预期：控制台窗口保持打开，显示数据目录、`http://127.0.0.1:47800/`、日志目录、记录状态，并自动打开浏览器；失败时窗口停留并显示错误、失败步骤、错误码与日志路径。

## 7. 下一轮建议

1. 用有礼物/SC/大航海的真实直播间复核字段与金额单位，补 `SEND_GIFT_V2`。
2. 实现本地二维码渲染，完善登录体验。
3. 真实断线重连与长时间稳定性验收；随后评估 YouTube 接入。

## 8. 常用命令

```bat
node scripts/build-windows.mjs
node scripts/verify-exe.mjs
node scripts/probe-bilibili.mjs 21144080 30
node scripts/verify-bilibili.mjs 5050 20
node --test --test-isolation=none tests/unit/*.test.mjs tests/integration/*.test.mjs
```
