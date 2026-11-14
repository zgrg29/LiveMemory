# 备份与恢复（BACKUP_RESTORE）

状态：**RC0 P0-2 已实现并验证**（2026-11-14）。格式规范见 `docs/BACKUP_FORMAT.md`；实现位于 `src/server/backup/`，API 位于 `src/server/routes.mjs`，界面位于 `src/web/js/pages/settings-backup.js`。

> 本轮未修改生产数据库；所有测试与 EXE 验证使用独立数据目录。备份/恢复 API 沿用 RC0 P0-5 的本地会话认证（Cookie），没有新增无认证端点。

## 1. 原有能力审计（实现前）

| 能力 | 原状态 | 结论 |
| --- | --- | --- |
| SQLite 快照 | `VACUUM INTO` 到 `%LOCALAPPDATA%\LiveMemory-Backups` | 可靠，但只含数据库，不含设置，不能跨电脑恢复 |
| 数据目录迁移 | `relocation.mjs` 复制 `config/database/secrets/exports/backups` 并校验 | 用于本机换目录，会把凭据一起搬走；不是可移植备份 |
| 数据清空/恢复出厂 | `maintenance.mjs`，可选快照 | 只删除，不提供恢复 |
| 可移植 `.livememory` | `docs/BACKUP_RESTORE.md` 仅有设计，未实现 | 本轮实现 |
| 设置页 | 危险区只有应急 `.db` 快照按钮 | 本轮新增完整备份/恢复卡片 |

旧版“数据库应急快照”保留：它仍是清空数据前的本机保护，不是跨电脑备份。界面明确区分两者。

## 2. 用户体验

设置 → **备份与恢复**：

1. **创建完整备份**：Windows 原生“另存为”对话框，默认文件名 `LiveMemory-Backup-YYYYMMDD-HHmmss.livememory`，默认目录 `%LOCALAPPDATA%\LiveMemory-Backups`。若对话框不可用，可直接使用默认目录并在结果中显示完整路径。
2. **选择备份文件**：Windows 原生“打开”对话框。选择后立即显示摘要：创建时间、LiveMemory 版本、数据库版本、文件大小、场次/观众/弹幕/AI 报告/长期事实数量、是否包含长期记忆、是否包含 AI 报告、是否包含敏感凭据、将替换的当前数据、恢复后需要重新连接的服务。
3. **验证备份**：重新读取并完整校验；失败时在对话框内显示三语错误。
4. **恢复此备份**：必须输入大写 `RESTORE`。确认后显示阶段进度；成功后提供“重新加载控制台”。
5. **覆盖冲突**：目标文件已存在时服务端返回 `BACKUP_TARGET_EXISTS`，界面要求二次确认后才带 `overwrite:true` 重试；不会静默覆盖。
6. **进度与取消**：创建备份可取消；恢复不提供“中途取消”（避免半切换），只显示阶段。
7. 高级入口默认折叠：仅在 Windows 文件对话框无法打开时允许手动输入路径。

整个流程不需要用户理解 SQLite、WAL、数据库文件、命令行或目录结构；也不需要管理员权限。

## 3. 创建流程

1. 校验目标路径：绝对路径、`.livememory`、非 UNC、父目录存在。
2. 检查目标是否存在、磁盘剩余空间（约 3 倍数据库大小 + 32 MiB）。
3. `VACUUM INTO` 生成一致快照（包含已提交的 WAL 内容，不复制正在写入的主文件）。
4. 对快照执行 `PRAGMA integrity_check`，读取 schema、行数、时间范围。
5. 计算数据库 SHA-256 + CRC-32；生成净化后的 `config/settings.json`。
6. 写 `manifest.json`（`contains_credentials:false`、明确 included/excluded）。
7. 流式写入临时文件 `<target>.partial-*`（STORE，仅此一种方法），写入时再次计算 CRC；支持取消与磁盘满。
8. 重新打开临时归档做完整校验（含数据库再次 `integrity_check` 与计数比对）。
9. `fsync` 后原子改名到最终路径；如覆盖，先把旧文件改名为 `.replaced-*`，成功后删除。
10. 任一步失败：删除临时文件与暂存目录；当前数据库、现有目标文件不被破坏。

## 4. 恢复流程（事务化）

```text
校验文件 → 预览/确认 → 冻结写入 → 停止采集与 AI → 关闭数据库
→ 恢复前安全快照 → 独立暂存目录解压 → 暂存库迁移+完整性检查
→ 写入 journal → 两次原子改名 → 校验新库 → 应用设置
→ 重新初始化运行时 → 清理
```

关键点：

1. **先验证再动数据**：`inspectBackup()` 在暂存目录完成 CRC/SHA、ZIP 结构、清单、schema、计数、`integrity_check`；失败时当前数据库仍打开且未被修改。
2. **恢复前安全快照**：`VACUUM INTO backups/pre-restore-<时间>-<随机>.db`，并自身执行 `integrity_check`。快照失败则中止恢复。
3. **只做文件切换**：暂存数据库移动到 `database/livememory.db`；不使用“逐表删除再导入”，避免中途留下半套数据。
4. **journal**：`runtime/restore-journal.json` 在第一次改名之前写入，记录目标、暂存、旧库、设置备份、SHA-256 与阶段（`prepared → committing → placed → verified → settings`）。
5. **崩溃恢复**：启动时在打开数据库之前调用 `recoverRestoreJournal()`：
   - `prepared` 且尚未改名 → 只清理暂存目录，原库不动；
   - `committing` 且目标缺失、旧库存在 → 把旧库改回目标（回滚）；
   - 目标已存在且 SHA-256 等于暂存库 → 继续完成（提交），清理旧库与暂存；
   - 目标损坏且旧库存在 → 回滚；
   - 无法判定 → `RESTORE_RECOVERY_FAILED`，不删除任何文件，启动失败并要求支持介入。
6. **进程内失败**：任何阶段抛出都会关闭数据库、按 journal 回滚、重建运行时并重新打开原库；错误详情包含 `rolledBack`。
7. **不依赖 try/catch**：强制结束进程后由下一次启动按文件内容与 journal 判定，而不是假设 catch 一定执行。
8. **旧连接失效**：恢复前停止所有适配器、AI 调度与翻译写入，关闭 SSE，关闭数据库连接，删除 `runtime/ai-v13.json`，然后 `buildRuntime()` 重新打开新库、迁移、`recoverInterrupted()` 标记遗留 `live` 场次为 `interrupted`。
9. **设置**：暂存设置经过 `normalizeSettings()` 白名单校验后才写入；不恢复 `preferredPort`、数据目录指针、任何凭据。
10. **中断后的任务状态**：数据库中运行中的 AI 任务按既有读模型显示为未完成/可继续；不会被伪装成正在运行。

## 5. 内容与凭据

- 包含：场次、事件/弹幕、观众身份与映射、支付、长期画像/事实/证据/版本、AI 报告与证据、AI/记忆任务状态、监控目标、设置、schema。
- 排除：`secrets/`、`config/ai-providers.json`、日志、缓存、runtime、exports、backups、app、数据目录指针。
- `manifest.contains_credentials` 必须为 `false`；声称包含凭据的备份会被拒绝（`BACKUP_CREDENTIALS_PRESENT`），不会静默导入。
- 恢复后 `secrets/` 为空（或仅保留新机器原有凭据）。界面提示：
  - Bilibili：需要重新登录才能继续录制；
  - YouTube 公开聊天：无需登录；
  - AI 分析：需要在设置中重新填写 API Key。

## 6. 安全边界

备份是不可信输入。读取端拒绝：ZIP Slip、绝对路径、盘符、UNC、反斜杠、`..`/`.`、控制字符、目录条目、重复名、符号链接、加密条目、data descriptor、ZIP64、非 STORE 方法、超大条目/总量/条目数，以及 CRC/SHA 不匹配、损坏 SQLite、伪造格式/schema、声称含凭据的清单。详见 `docs/BACKUP_FORMAT.md` §4–§6。

路径策略：备份目标必须是本机绝对路径；恢复源必须是存在的 `.livememory` 文件；解压只写入 `runtime/restore-*/` 暂存目录，最终写入路径由程序固定生成，不来自归档条目名。

API：`/api/backup/status`、`/api/backup/create`、`/api/backup/inspect`、`/api/backup/restore`、`/api/backup/jobs/:id`、`/api/backup/jobs/:id/cancel`、`/api/backup/pick/*`、`/api/backup/open` 全部要求会话认证；恢复期间除健康/认证与当前 job 进度外全部返回 503；未认证请求始终先返回 401。

## 7. 测试

代码级覆盖见 `tests/unit/backup-format.test.mjs`、`tests/unit/backup-ui.test.mjs`、`tests/integration/backup-restore.test.mjs`，共 24 个用例；正式 EXE 闭环见 `scripts/verify-p0-2-exe.mjs`。测试只使用 `tests/.tmp` 隔离目录，不对生产数据库执行恢复/清空。

## 8. 已知边界

- 备份未加密：文件包含观众昵称、弹幕与 AI 报告，界面明确提示妥善保管。
- 不支持两台电脑数据合并；重复恢复是“整体替换”，不是追加。
- 不支持跨版本降级：未来 schema/format 会被明确拒绝。
- 真实 Windows 文件对话框需要交互式桌面会话；自动化验收使用 API 直接传路径（标记为用户待验收）。
- 恢复期间若 Windows 强制终止进程，下一次启动按 journal 自动回滚或提交；但若磁盘在改名过程中损坏，仍可能需要人工保留数据目录并联系支持。
