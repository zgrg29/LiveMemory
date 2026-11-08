# 开发日志 · 2026-11-08 · P0：Windows 普通权限启动修复

## 1. 问题

用户实测（真实反馈）：

- `dist\LiveMemory.exe` **以管理员身份运行**：控制台正常、服务启动、浏览器打开、可正常使用。
- **普通权限双击**：CMD 窗口闪一下即关闭，浏览器不打开，看不到任何错误。

## 2. 环境与复现

- 本轮执行环境本身是 **非管理员**（`elevated: False`，无 Administrator 组令牌），因此可以直接以普通权限运行 EXE。
- 直接运行 `dist\LiveMemory.exe --no-open --port 48990`（旧构建）得到：

```text
  LiveMemory
  直播记忆 · 本地优先的直播记忆系统
  v0.1.0
  ----------------------------------------------------------------
  正在检查运行环境…
  运行环境检查通过
LiveMemory failed to start.
Error: EPERM: operation not permitted, open 'C:\Users\Rong\AppData\Local\LiveMemory\runtime\instance.lock'
    at openSync (node:fs:621:18)
    at acquireInstanceLock (.../src/launcher/lock.mjs:39:16)
    at Module.runLauncher (.../src/launcher/launcher.mjs:213:16)
    at async scripts/sea-bootstrap.cjs:42:16
```

这一条输出同时暴露了问题形态：**错误由 `runLauncher` 之外的调用点抛出，只有英文原始堆栈、没有本地化提示、没有日志文件、没有等待按键**，双击时窗口必然一闪而过。

> 说明：本机 DSH 沙箱禁止写入 `%LOCALAPPDATA%`/`%APPDATA%`（新建目录也被拒绝），因此该次 EPERM 的直接来源是沙箱，而不是 Windows 账户 ACL。它仍然真实复现了「数据目录不可写时启动器如何失败」这一路径，也正是普通用户最可能遇到的失败类型（目录被管理员/安全软件/同步盘接管）。后续所有「数据目录不可写」验证都在可写工作区内用受保护目录（`C:\Windows\System32`）与 ACL 之外的真实错误完成，未把管理员模式成功当作验收。

## 3. 根因（代码级）

1. **错误处理覆盖不全（首要原因）**：`runLauncher` 只把 `startServer` 包在 try/catch 内。数据目录解析完成之后、`startServer` 之前的步骤（`ensureDirectories`、`SettingsStore.load`、`createLogger`、`acquireInstanceLock`）抛出的异常会直接冒泡到 SEA bootstrap，只打印英文堆栈并 `exit 1`。
2. **Windows 可写性探测是假探测**：`probeWritable()` 使用 `accessSync(dir, W_OK)`。Windows 上该调用只检查路径存在，不检查写权限，因此不可写目录也能通过预检查，失败被推迟到锁文件，正好落进第 1 条的盲区。
3. **缺少早期日志**：启动日志在解析出数据目录之后才创建。数据目录、配置、锁任一环节失败时没有任何可诊断文件；且日志目录不一定会落到用户看到的数据目录下。
4. **单实例判断只看 PID**：`process.kill(pid, 0)` 在普通权限查询提权进程时返回 `EPERM`，被当作「存活」；PID 复用、残留 `runtime.json` 都会让程序误判「已在运行」，打印一个失效地址后 **exit 0**，表现同样是闪退。陈旧锁接管失败时也会被当成「已在运行」。
5. **SEA 解压无标记、非原子**：每次启动重写 64 个文件；中途失败会留下半套资源目录，下次仍会复用并报模块加载错误；被杀毒软件拦截时表现为随机失败。
6. **附带发现的安全缺陷**：`logger.redactValue` 对无捕获组的正则使用 `String.replace` 回调，第三个参数拿到的是「整个字符串」而不是后缀，导致 `SESSDATA=...` 被替换成「offset + [redacted] + 原始整串」——**既破坏文本又泄漏原值**。已用回归测试覆盖。

## 4. 修复

- 启动器改为**全链路守护**：`parse-args → console → node → sqlite → data-dir → prepare-directories → settings → logger → instance-lock → server-start → browser` 每一步都有状态、错误码与步骤名。
- 新增 `src/launcher/startup-log.mjs`：在数据库之前即可写日志；`%LOCALAPPDATA%\LiveMemory\logs` → `%TEMP%\LiveMemory-logs` → `~/.livememory-logs` 逐级回退；解析出数据目录后**迁入** `<数据目录>\logs`，与控制台打印路径一致；记录 `startup-error.json`；自动脱敏。
- 新增 `src/shared/write-probe.mjs`：真实执行 mkdir → 创建 → 写入 → 读回 → 删除，返回失败步骤与真实错误码；`assertWritable()` 与数据目录解析共用。
- 数据目录解析：`LIVE_MEMORY_DEFAULT_DATA_DIR`（EXE 默认目录）只是**偏好**，不可写时继续尝试 `%APPDATA%`、用户目录、`%TEMP%\LiveMemory`，并在控制台明确提示已改用的路径；`--data-dir` / `LIVE_MEMORY_DATA_DIR` 仍是**显式**要求，不可写即报错（含路径、错误码、失败步骤）。
- 单实例：新增 `src/launcher/instance.mjs`，用「锁里的 PID + `runtime.json` + `/api/health` 必须回应 LiveMemory」判定是否真的在运行；不可达/端口被别的服务占用/PID 不一致 → 视为陈旧锁并接管；接管失败给出本地化错误。
- SEA bootstrap 重写：极早期日志（解压前）、三语失败提示、交互式控制台等待按键、`--error-dialog` 时弹出系统错误框、`uncaughtException`/`unhandledRejection` 兜底；解压改为 **staging 目录 + marker 标记 + 原子 rename**，完成后复用，不再每次重写；数据目录改为偏好语义。
- 防御性修复：`parseArguments` 错误不再静默返回；启动器注册未捕获异常处理（交互式才等待按键）；`logger` 脱敏正则修正。
- 三语文案补齐（错误步骤、错误码、日志位置、回退目录、残留锁、崩溃提示、诊断输出）。

## 5. 验证（非管理员）

| 场景 | 方法 | 结果 |
| --- | --- | --- |
| 普通权限完整启动 | 普通权限 + 全新数据目录，`--no-open` | ✅ health 200，SQLite 写入，日志落在数据目录 |
| 数据目录不可写 | `%LOCALAPPDATA%` 被拒（沙箱）+ 全部候选回退 | ✅ 启动成功并打印「已改用 %TEMP%\LiveMemory」 |
| 显式不可写目录 | `--data-dir C:\Windows\System32\...` | ✅ 退出码 1，本地化提示 + 失败步骤 + 错误码 EPERM + 启动日志 |
| 旧数据/重启 | 同目录重启 | ✅ 场次、观众数保持不变 |
| 强制结束恢复 | 记录中 `taskkill /F` 后重启 | ✅ 场次标记 `interrupted`，消息保留 |
| 端口占用 | 先用 net 监听 49110 | ✅ 自动改用 49111，health 200 |
| 重复启动 | 第二个 EXE 同数据目录 | ✅ 提示已运行、退出 0、首个实例仍健康 |
| 其他目录运行 | EXE 复制到 `Downloads`、cwd 设为无关目录 | ✅ 正常启动，解压目录复用 |
| 解压复用 | 第二次启动 | ✅ 解压目录 mtime 不变，bootstrap 记录 reuse |
| CLI | `--version`、`--help --lang ja`、`--diagnose` | ✅ 0 退出，日文帮助、诊断列出可写性 |

自动化：`tests/unit` + `tests/integration` **119 个通过，0 失败**（P0 阶段，不含 M3 用例）。新增 8 个测试文件覆盖启动日志、写探测、数据目录回退、实例探测、暂停/对话框、bootstrap 解压、脱敏、启动失败集成路径。

## 6. 边界（如实记录）

- 本环境无法创建「真实交互式桌面 + 双击」的会话；已确认进程为非管理员令牌，浏览器打开只验证到「已发出系统打开请求」，未做视觉确认。
- 管理员模式对照无法在本环境触发 UAC 提权，本轮**未执行**管理员模式回归；普通权限已是更严格的一侧。
- 若 Windows 在进入程序前就失败（例如映像损坏、SmartScreen 阻止），进程没有机会输出；该边界写入 `docs/WINDOWS_RUNTIME.md`。
