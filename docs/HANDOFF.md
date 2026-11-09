# 交接文档（HANDOFF）

本轮：2026-11-08 · Header 语言快捷切换、数据目录迁移、清空/恢复出厂、多主播观众档案 · v0.4.0（schema v5）

## 1. 本轮目标与结论

| 目标 | 结论 |
| --- | --- |
| Header 语言快捷切换 | 完成。宽屏三个原生语言名 + 地球按钮（跟随系统），窄屏原生 select；与设置页共享状态，持久化，三语截图。 |
| 修改数据存储目录 | 完成。位置记录 + staging 复制 + integrity/计数/校验和验证 + 运行时重建 + 单实例锁转移 + 失败回滚；原目录不删。 |
| 清空数据 / 恢复出厂 | 完成。`DELETE` / `RESET` 确认文字、记录中禁止、默认数据库快照、事务清理 + `VACUUM` + 运行时重建；保留数据目录、无关文件与 `backups/`。 |
| 多主播观众档案 | 完成。schema v5；平台全局观众身份 + 主播维度互动档案；范围选择、搜索、排序、详情、AI 包隔离。 |

## 2. 关键设计决定

### 2.1 语言切换

- `index.html` 顶栏 `language-control`：`#language-system` 地球按钮、`#language-segmented` 三个原生语言名、`#language-select` 窄屏 select。
- `app.js` 的 `syncLanguageControls()` 从同一 `state.settings.locale` 构建两种控件；`chooseLocale()` 串行化切换；`setLocale()` PATCH 后重载字典并重渲染当前页。
- 设置页语言卡保留，仅补充 header 提示；两侧都调用 `ctx.setLocale`，不存在第二份状态。

### 2.2 数据位置与迁移

- 位置记录模块：`src/shared/data-location.mjs`
  - 主：`%LOCALAPPDATA%\LiveMemory\data-location.json`
  - 镜像：`%APPDATA%\LiveMemory\data-location.json`
  - 原子写；主损坏时读镜像；相对路径/非法版本忽略。
- 启动器：`--data-dir` / `LIVE_MEMORY_DATA_DIR` 优先；否则读位置记录；目标**必须已存在且含数据库**，否则 `DATA_DIR_UNAVAILABLE`，提供 `--data-dir` 与 `--forget-data-location`。不会创建空数据库。
- 迁移：`src/server/relocation.mjs`
  - 校验安全目录、UNC 拒绝、OneDrive/Dropbox/Google Drive/临时目录/长路径警告、目标冲突、可用空间；
  - 停止适配器 → WAL checkpoint → 关闭 DB → staging 复制 → `integrity_check` + 表计数 + schema 版本 + 文件 SHA-256 → 移入目标 → 重新构建 runtime → 调用方锁转移 → 写位置记录 → 切换；
  - 失败：回滚已移动目录、删除 staging、恢复位置记录、重新打开原目录；原目录永不删除；
  - `hooks.afterCopy/afterMove/beforePointer` 仅供测试注入失败。
- 服务端 `startServer` 已重构为 `buildRuntime/stopRuntime`，可以在同一 HTTP 端口内切换数据库与服务；`deps` 使用 getter 暴露当前 runtime。
- 单实例锁：launcher 传入 `beginLockMove`，提交时释放旧锁、建立新锁、写目标 `runtime.json`；失败时 abort。
- 目录选择器：`src/server/native-dialog.mjs`，固定 PowerShell + WinForms 脚本，不经 shell；打开文件夹只接受受管目录键。

### 2.3 清空与恢复出厂

- `src/server/maintenance.mjs`
  - 模式 `data`：删业务表 + 导出/缓存；保留设置、凭据、位置记录、`backups/`、日志、根目录无关文件。
  - 模式 `factory`：额外删偏好/凭据/日志/缓存并重置设置默认值；仍保留位置记录、`backups/`、根目录无关文件。
  - 事务删除 + `VACUUM` + WAL checkpoint；异常时抛出可本地化错误。
  - 备份：`VACUUM INTO` 到 `%LOCALAPPDATA%\LiveMemory-Backups`（`LIVE_MEMORY_BACKUP_DIR` 可覆盖），默认不在数据目录内；是数据库应急快照，不是 M5 `.livememory`。
  - 完成后通过 `deps.relocation.stop/build/swap` 重建运行时，清掉内存中的服务与凭据状态。
- API：
  - `GET /api/storage/location`
  - `POST /api/storage/location/validate`
  - `POST /api/storage/location/pick`
  - `POST /api/storage/location`
  - `POST /api/storage/open`
  - `GET /api/storage/clear/preview`
  - `POST /api/storage/backup`
  - `POST /api/storage/clear`
- `deps.maintenance` 期间除 relocation/clear/health/status 外返回 503，防止复制中并发写库。

### 2.4 多主播身份

- `src/shared/broadcaster.mjs`：`resolveBroadcasterIdentity()`。
  - YouTube：仅 `channelId`；视频 ID 不作为长期身份。
  - Bilibili：`anchorUid` → `bilibili:<uid>`；否则 room id → `bilibili:room:<id>`（`room_fallback`）。
  - mock：`mock:simulation`。
- schema v5：
  - `broadcasters`、`viewer_broadcasters`、`viewer_broadcaster_currency_totals`；
  - `sessions.broadcaster_id`（可空）+ `broadcaster_identity`；
  - 迁移回填 Bilibili room fallback、mock；YouTube 旧场次保持 unresolved。
- `EventIngest` 同事务调用 `recordViewerBroadcasterActivity`；重复事件不重复计数。
- 读模型：`analytics/viewers/profile.mjs` 支持 `{broadcasterId}` / `{unassigned}`，返回 `scope` 与 `broadcasters[]`；全局 `lifetime` 独立标注。
- API 与 UI：见 `docs/STATUS.md` §2.4。
- AI 包：`viewer_context[].broadcaster_context`、`lifetime`、`other_broadcaster_count`；`instructions.md` 有“主播上下文”规则。

## 3. 数据模型变化

- schema **5**；`MIGRATIONS` v5。
- v1→v5 迁移测试覆盖：
  - Bilibili 有 room id → room fallback；
  - YouTube 视频 ID → unresolved；
  - mock → simulated；
  - `viewer_broadcasters` 与币种合计回填。
- 旧 `viewer_id`、事件引用、计数、金额不变。
- 清空数据不删 `schema_migrations`；数据库仍为 v5 空库。

## 4. 测试与验证

- 全量：**305 passed / 0 failed**（`node --test --test-isolation=none ...`，约 22.8 秒）。
- 新增：`broadcaster.test.mjs`、`header-language.test.mjs`、`broadcaster-identity.test.mjs`、`storage-management.test.mjs`。
- 数据验证：
  - 迁移前后旧/新目录：integrity=ok、schema=5、3 sessions / 12 events / 4 viewers / 8 viewer_sessions / 5 viewer_broadcasters / 2 broadcasters。
  - 清空后：全部业务表 0、integrity=ok、schema=5；备份保留 3/12/4。
- EXE：`dist/LiveMemory.exe` 90.3 MB，103 资源，SHA-256 `4aae59fe6f8d0a6cdc13811d27cc732e1e17cd6a6dac5d5fa4da450efbb1387f`；`verify-exe.mjs` **9/9 通过**（`--version` = 0.4.0）。
- 截图 18 张，见 `STATUS.md` §7。

## 5. 未验证 / 边界（必须如实保留）

- 原生目录选择器未在无桌面会话/真实双击桌面验证；测试环境无法弹出 WinForms 对话框。
- 迁移中断回滚通过测试注入 `afterMove` 失败验证；**未做真实拔盘、断电、磁盘写满**演练。
- 映射网络盘（盘符）未自动识别；UNC 明确拒绝，OneDrive 等仅警告。
- 清空/出厂的文件删除是尽力而为；数据库删除是事务 + `VACUUM`。
- 旧 YouTube 场次 unresolved；无手动归属 UI。
- 无删除单场/单观众/单主播 UI。
- M6 AI 导入未实现；本轮未扩展 YouTube 未公开接口，未改变匿名模式默认关闭与合规提示。
- EXE 未在第二台干净 Windows 验收；未签名；未 Push。

## 6. 常用命令

```bat
:: 测试
node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"

:: 启动
node src/launcher/launcher.mjs --no-open --port 48300

:: 忘记自定义位置（恢复到默认目录）
node src/launcher/launcher.mjs --forget-data-location --no-open

:: 构建与验证 EXE
node scripts/build-windows.mjs
node scripts/verify-exe.mjs
```

## 7. 下一轮建议

1. M6 AI 结果导入：Schema、事务、重复导入保护、任务状态。
2. 旧场次主播归属 UI；单场/观众删除；严格删除/去标识化。
3. M5 可移植备份，复用迁移的安全切换与校验逻辑。
4. 真实断盘/断电迁移演练、映射网络盘检测、干净 Windows EXE 验收。

## 8. 本轮 Commit

- 本轮：`66e47b6` feat: add header language switch, data relocation and broadcaster memory
- 上一轮：`c8d72c5` docs: anonymize public chat data in YouTube screenshots
