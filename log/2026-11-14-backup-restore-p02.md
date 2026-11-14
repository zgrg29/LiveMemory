# RC0 P0-2：完整备份、恢复与跨电脑迁移（2026-11-14）

> 本轮只处理 P0-2。未修改生产数据库、未对真实用户数据执行恢复/覆盖/清空、未干扰正在采集的直播、未调用真实付费 AI、未 Push/Tag/发布。
> 所有测试使用 `tests/.tmp/` 隔离数据目录；正式 EXE 使用正式构建 + 临时数据目录。
> **未完成真实桌面文件对话框点击与真实浏览器点击验收**，不将其描述为真实用户验收。

## 1. 结论摘要

- 实现真正可用的单文件 `.livememory` 备份：STORE ZIP + manifest + 数据库一致快照 + 净化设置。
- 备份使用 `VACUUM INTO`，不复制正在写入的 `.db`/`-wal`；创建后重新读取并完整校验，再原子提交。
- 恢复先验证、再冻结写入、保存恢复前安全快照、暂存迁移+校验、journal + 两次原子改名，失败回滚。
- 强制终止进程后，下一次启动按 journal 与文件 SHA-256 自动回滚或提交，不依赖 try/catch。
- 普通备份不包含 API Key、Bilibili Cookie、Provider 配置或任何凭据；恢复后明确提示重新连接。
- 24 个新增专项测试全部通过；全量 769/769；正式 EXE 13/13 完成“备份 → 全新目录恢复 → 重启 → 再次备份”。
- schema 仍为 16；无数据库迁移；未改金额/身份/去重/AI 语义。

## 2. 原有能力审计

| 能力 | 审计结果 | 本轮处理 |
| --- | --- | --- |
| SQLite 快照 | `maintenance.createDatabaseBackup()` 使用 `VACUUM INTO` + `integrity_check`，输出 `.db` 到外部备份目录 | 保留为“应急快照”，不复用为可移植备份 |
| 数据库初始化/关闭 | `openDatabase` 使用 WAL、`busy_timeout=5000`；`closeDatabase` checkpoint(TRUNCATE) | 恢复复用同一关闭路径 |
| 数据目录迁移 | `relocation.mjs` 复制 `config/database/secrets/exports/backups` 并校验 | 恢复复用 `stopAdapters/closeDatabase/build/swap`，但不复制旧数据 |
| 清空/恢复出厂 | `maintenance.clearData()`，可写前快照，没有恢复入口 | 不修改；新增独立备份/恢复 |
| 凭据 | `secrets/` AES-256-GCM；`config/ai-providers.json` 无明文 Key | 二者都排除出备份 |
| 本地 API 认证 | P0-5 会话 Cookie；维护模式原本先于认证返回 503 | 恢复流程改为认证先于维护检查 |
| 原生对话框 | 只有目录选择器 | 新增 Save/Open 文件对话框，固定脚本、base64、无 shell |
| 设置页 | 危险区只有 `.db` 应急快照按钮 | 新增“备份与恢复”卡片 |
| EXE 构建 | 遍历 `src`；必需模块列表 | 增加 backup 必需模块与嵌入标记断言 |

## 3. 实现文件

```text
src/server/backup/constants.mjs      格式/条目/排除/上限/确认词
src/server/backup/archive.mjs        流式 ZIP 读取、名称校验、CRC/SHA、安全提取
src/server/backup/write-archive.mjs  流式 STORE 写入（写入时重算 CRC）
src/server/backup/manifest.mjs       清单构建与严格校验
src/server/backup/counts.mjs         行数与数据范围
src/server/backup/settings.mjs       设置净化/白名单
src/server/backup/create.mjs         VACUUM INTO → 校验 → 临时文件 → 再校验 → 原子改名
src/server/backup/inspect.mjs        归档/清单/文件/SQLite/schema/计数全量校验
src/server/backup/journal.mjs        runtime/restore-journal.json 状态机
src/server/backup/restore.mjs        安全快照 → 冻结 → 关闭 → 切换 → 校验 → 重建
src/server/backup-jobs.mjs           进度/取消/单任务互斥
src/server/routes.mjs                /api/backup/*（认证之后）
src/server/app.mjs                   认证先于维护；仅 job 进度在维护期间可读
src/server/native-dialog.mjs         pickFile（Save/Open）
src/server/index.mjs                 启动时 recoverRestoreJournal；deps.relocation 新钩子
src/web/js/pages/settings-backup.js  备份/预览/验证/恢复/进度 UI
src/web/js/pages/settings.js          接入卡片
src/web/styles/pages.css             进度条/高级入口样式
src/web/i18n/{zh-CN,ja,en}.json      三语文案与 34 个错误码
scripts/build-windows.mjs            backup 必需模块 + 嵌入标记
scripts/verify-p0-2-exe.mjs          正式 EXE 闭环验证
tests/unit/backup-format.test.mjs    9
tests/unit/backup-ui.test.mjs        5
tests/integration/backup-restore.test.mjs 10
```

## 4. 内容清单

包含：

- `sessions`、`events`（弹幕/礼物/SC/舰长等）、观众身份与映射、昵称、支付与币种合计；
- 长期画像、事实、证据、版本；
- AI 结果、证据索引、汇总节点、翻译缓存、AI/记忆任务与批次状态；
- 自动监控目标；
- `app_meta`、schema 版本；
- `config/settings.json`：locale、theme、storageMode、onboardingCompleted、youtubeRawRetentionDays。

排除：

- `secrets/`（Bilibili Cookie、AI Keys、安装密钥）；
- `config/ai-providers.json`；
- `logs/`、`cache/`、`runtime/`、`exports/`、`backups/`、`app/`；
- 数据目录指针 `data-location.json`；
- `preferredPort`。

## 5. 格式与完整性

- `manifest.json` 记录 `format_version=1`、`schema_version`、`created_at`、`app_version/build_id/commit`、`contains_credentials=false`、`encryption=null`、包含/排除原因、行数、数据范围、文件 `bytes+sha256`。
- ZIP 只允许 STORE；固定允许 3 个条目。
- 创建时：快照 `integrity_check` → 文件 SHA-256/CRC → 临时文件写入（重算 CRC）→ 重新完整校验 → `fsync` → 原子改名。
- 读取时：中央目录结构/本地头一致性 → 名称安全 → 条目数/大小/总量上限 → 逐条 CRC → SHA-256 → SQLite `integrity_check` → schema/计数比对。
- 资源上限：归档 2 GiB、总量 2 GiB、单条 2 GiB、条目 16、中央目录 4 MiB、manifest 1 MiB、settings 256 KiB。

## 6. SQLite 一致性实测

- 直播模拟采集中把 `wal_autocheckpoint` 设为 0，确认 `-wal` 存在且非空；创建备份后：
  - 快照事件数 ≥ 备份开始前计数；
  - 快照事件数 ≤ 备份结束后实时计数；
  - 快照 `integrity_check` 通过；
  - 原库 `integrity_check` 通过且行数不变。
- 备份与 AI 分析导入并发调度时，备份仍通过完整校验，库保持完整。
- 备份不修改原库；`VACUUM INTO` 的失败会在暂存目录清理，不影响现有数据。

## 7. 恢复与崩溃回滚

恢复顺序：

1. `inspectBackup(keepStaged)` 完整验证并解压到 `runtime/restore-*`；
2. 磁盘空间检查；
3. 当前库 `VACUUM INTO backups/pre-restore-*.db` 并自身完整性检查；
4. 写入 `runtime/restore-journal.json`（phase=`prepared`）；
5. 停止采集/AI/翻译/SSE，关闭数据库；
6. 计算暂存/原库 SHA-256，phase=`committing`；
7. 原库 → `restore-previous-*.db`；暂存库 → `database/livememory.db`；phase=`placed`；
8. 新库 `integrity_check` + schema + 计数；phase=`verified`；
9. 应用设置；phase=`settings`；
10. 删除 `runtime/ai-v13.json`，`buildRuntime()` 重新打开数据库/迁移/恢复 interrupted；
11. 清理 journal/旧库/暂存。

启动恢复：

| journal 阶段 | 文件状态 | 动作 |
| --- | --- | --- |
| `prepared` | 未改名 | 清理暂存，原库不动 |
| `committing` | 目标缺失、previous 存在 | 把 previous 改回目标（回滚） |
| `committing` | 目标 SHA = staged | 已完成改名，校验有效则提交 |
| `committing` | 目标 SHA = previous | 改名未发生，清理暂存 |
| `placed/verified/settings` | 目标有效 | 提交并清理 |
| 任意 | 目标损坏、previous 存在 | 回滚 |
| 无法判定 | — | `RESTORE_RECOVERY_FAILED`，不删除文件 |

实测：

- 恢复中注入“改名后异常”：回滚后行数/标题恢复，HTTP 继续可用。
- 启动 journal 三态：仅暂存 → cleaned；第一次改名后 → rolled-back；两次改名后 → committed。
- 恢复后旧 SSE 关闭、旧 DB 连接关闭、旧 AI runtime state 删除；再次启动数据一致。

## 8. 文件安全

拒绝：

- ZIP Slip（`..`、绝对路径、盘符、UNC、反斜杠、`.`、空段）；
- 控制字符、目录条目、重复名、超长名称；
- 符号链接（Unix mode 0xA000）；
- 加密条目、data descriptor、ZIP64、非 STORE；
- 压缩炸弹（STORE 大小一致 + 条目/大小/总量上限）；
- CRC/SHA 不匹配、截断、中央目录越界、本地头与中央目录不一致；
- 损坏 SQLite、伪造 format/schema、含凭据清单；
- 未知条目、缺失 manifest/database/settings。

路径：解压只写入程序生成的 `runtime/restore-*`；最终数据库路径固定为 `paths.databaseFile`，不采用归档条目名。

认证：`/api/backup/status|create|inspect|restore|jobs/:id|jobs/:id/cancel|pick/*|open` 全部要求 P0-5 会话 Cookie。维护期间：未认证 401；已认证非 job 503；job 进度可读。

## 9. 测试

### 9.1 新增

- `tests/unit/backup-format.test.mjs` 9
- `tests/unit/backup-ui.test.mjs` 5
- `tests/integration/backup-restore.test.mjs` 10
- `tests/integration/api-auth.test.mjs` 增补备份端点未认证 401

覆盖任务 24 项：正常备份、WAL 在线一致、取消、写入失败、磁盘不足、校验和、内容缺失、格式不兼容、ZIP Slip、压缩炸弹、超大归档、损坏 SQLite、正常恢复、恢复中途回滚、强制终止进程、恢复后重启、跨电脑新目录、历史观众/事实、AI 结果、旧凭据不导入、恢复期间未授权 API、重复恢复幂等、备份与直播采集并发、备份与 AI 分析并发。

### 9.2 全量

```text
node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"
tests 769 / pass 769 / fail 0 / skipped 0 / duration 501,044 ms
```

## 10. 正式 EXE

| 项目 | 值 |
| --- | --- |
| 文件 | `dist/LiveMemory.exe` |
| 大小 | `96,594,432` bytes（92.1 MB） |
| SHA-256 | `fa1e8367bed99ce221b1f20d4f0c7efc3eaf492d499d2f39c9014233f2dbf9e6` |
| buildId | `678e8d47b6c6` |
| commit | `489ce070abca24ced6a8287cb4312cc575b24692` |
| builtAt | `2026-11-14T05:34:55.662Z` |
| 资源 | `189` files；20 个必需模块；`asInvoker` |

- 本轮代码提交 `9a23d45`；EXE 在提交前构建，`build-info.commit` 因此为上一提交 `489ce07`。buildId 由源码内容哈希决定，可由 `9a23d45` 重建复现。
- `scripts/verify-p0-2-exe.mjs` **13/13**：
  1. asInvoker + buildId/备份模块标记；
  2. 种子数据含场次/AI 报告/长期事实；
  3. 认证 status；
  4. 创建备份；
  5. 验证摘要（无凭据、含长期记忆/AI 报告）；
  6. 正常停止；
  7. 全新绝对目录恢复（计数一致、存在安全快照）；
  8. 恢复后 secrets 为空；
  9. 恢复后 HTTP 服务与设置（ja/dark）；
  10. 重启后计数/事实一致；
  11. 再次备份；
  12. 第二次归档独立完整校验；
  13. 正常停止。
- `scripts/verify-p0-5-exe.mjs` **12/12**；`scripts/verify-exe.mjs` **10/10**。
- **性质**：正式 EXE + 真实 HTTP + 隔离目录 + 本机种子数据；不是真实浏览器点击，也不是真实 Windows 文件对话框点击。

## 11. 边界与待验收

- 真实 Windows 文件对话框点击、真实浏览器点击/自动打开未验收。
- 备份未加密；包含观众昵称、聊天、AI 报告；界面提示妥善保管。
- 不支持两台电脑数据合并；重复恢复是整体替换；同一备份重复恢复行数不变。
- 不支持降级；未来 format/schema 明确拒绝。
- 同 Windows 用户恶意软件可读取备份与数据目录；HTTP 认证不消除该威胁。
- 未用真实付费 Provider/真实平台账号做跨电脑验收；数据来自本地模拟与导入。

## 12. 下一轮交接建议（RC0-AI-EFFICIENCY）

1. 先审计 AI 请求的 Token 归因与重复：`ai_jobs.usage_json`、`ai_aggregate_nodes`、`ai_translation_runs`、`ai_provider_tests`、重试/补答/拆分请求是否重复计费或重复发送。
2. 检查重复内容：同一场次的 session batch + memory viewer batch 是否重复发送相同聊天正文；`viewer_excerpts.jsonl` 是否按需最小化；aggregate/digest 是否重复压缩已发送内容。
3. 检查上下文预算：`resolveAggregateContextBudget`、`resolveMemoryOutputTokens`、`planMemoryViewerBatches` 是否在高估/低估之间反复拆分，导致额外请求。
4. 检查提示词体积：三语 instructions、Schema、修复提示是否在每次请求重复大段固定文本，能否缓存/缩短而不破坏契约。
5. 检查失败重试：空响应/截断/429/超时是否产生无上限或重复请求；确认每次请求都有明确归因与停止条件。
6. 不要为了省 Token 降低证据完整性、身份校验或事实准确性；保留可恢复状态与幂等。
7. 使用隔离数据 + Mock Provider 统计每类请求的输入/输出 Token、请求数与重复率，再决定优化点。
