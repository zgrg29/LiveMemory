# 交接文档（HANDOFF）

本轮：2026-11-08 · P0 普通权限启动修复 · v0.1.0

## 1. 本轮目标

1. 修复「普通权限双击 EXE → CMD 一闪而过」的真实用户问题；
2. 保留既有 M0–M2 能力（UI、三语、主题、SQLite、模拟直播、AI 分析包）；
3. 重新构建 `dist/LiveMemory.exe`，以普通权限验证完整启动链路；
4. 同步文档并创建独立本地 Commit。

## 2. 实际完成

### 根因（已实测复现）

- 启动器只守护 `startServer`，数据目录/配置/日志/单实例锁阶段的异常直接冒泡到 SEA bootstrap，只打印英文堆栈 → 双击窗口瞬间关闭。
- `accessSync(W_OK)` 在 Windows 不检查写权限，不可写目录能通过预检查，失败被推迟到锁文件（正好在盲区里）。
- 单实例只看 PID（普通权限对提权进程返回 EPERM 被当成存活；PID 复用会让程序误报「已在运行」后退出 0）。
- SEA 解压每次重写、非原子；失败会留下半套资源目录。
- 附带发现并修复 `logger.redactValue` 脱敏正则缺陷（会把原值重新拼回文本）。

### 修复

- `src/launcher/startup-log.mjs`：数据库之前的启动日志，临时目录回退，迁入 `<数据目录>\logs`，失败报告。
- `src/shared/write-probe.mjs`：真实写探测；`src/server/paths.mjs` 共用。
- `src/launcher/diagnostics.mjs`：交互式等待按键、`--error-dialog` 系统对话框、非 TTY 不阻塞。
- `src/launcher/instance.mjs`：PID + `runtime.json` + `/api/health` 三者判定；陈旧锁接管。
- `src/launcher/launcher.mjs`：全链路守护，每步状态、错误码、本地化错误、未捕获异常兜底、`--diagnose`。
- `scripts/sea-bootstrap.cjs`：极早期日志、staging + marker + 原子解压、复用、三语失败提示、异常兜底。
- `src/launcher/cli-i18n.mjs`：新增三语文案（失败步骤、错误码、日志位置、回退目录、残留锁、崩溃、诊断）。

## 3. 验证

- 自动化：**119 个测试通过，0 失败**（`node --test --test-isolation=none tests/unit/*.test.mjs tests/integration/*.test.mjs`）。
- `scripts/verify-exe.mjs`：普通权限（非管理员令牌）EXE 矩阵，覆盖全新目录、重启保留、强制结束恢复、端口占用、重复启动、不可写目录、其他目录运行、解压复用、CLI。
- 本机沙箱拒绝 `%LOCALAPPDATA%`/`%APPDATA%`，正好验证了「默认目录不可写 → 回退 `%TEMP%\LiveMemory` → 仍能启动并明确提示」的路径。

## 4. 未验证 / 边界

- 真实交互式桌面「双击」会话：本执行环境无法创建；已确认进程为非管理员令牌。
- 管理员模式对照：本环境无法触发 UAC，未执行。
- 请用户在本机双击 `dist\LiveMemory.exe` 验证：应出现控制台窗口、打印数据目录与 `http://127.0.0.1:…/`、自动打开浏览器；失败时应停留并显示错误与日志路径。
- Windows 在进入程序前拦截（SmartScreen/映像损坏）无法由程序捕获。

## 5. 下一轮建议

继续 M3：Bilibili 真实直播接入（扫码登录、WebSocket、事件映射、身份与金额验证）。

## 6. 启动 / 测试命令

```bat
node scripts/build-windows.mjs
dist\LiveMemory.exe
dist\LiveMemory.exe --diagnose
node scripts/verify-exe.mjs
node --test --test-isolation=none tests/unit/*.test.mjs tests/integration/*.test.mjs
```
