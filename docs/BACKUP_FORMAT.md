# LiveMemory 备份格式 v1（BACKUP_FORMAT）

状态：**已实现（RC0 P0-2）**。实现：`src/server/backup/`。本文是 `.livememory` 文件的格式规范；用户操作与恢复协议见 `docs/BACKUP_RESTORE.md`。

> 本格式**不加密**。普通备份不包含 API Key、OAuth Token、Cookie 或任何平台登录凭据。需要加密时必须在新的 `format_version` 中引入成熟 AEAD（AES-256-GCM + scrypt/Argon2id），不得自创算法。

## 1. 文件形态

```text
LiveMemory-Backup-2026-11-14-153000.livememory      （ZIP，仅 STORE，无压缩）
├── manifest.json
├── database/livememory.db
└── config/settings.json
```

- 扩展名固定为 `.livememory`。
- **只允许 STORE（method 0）**。不使用 DEFLATE：声明大小必须与实际字节完全一致，从结构上排除压缩炸弹的“高压缩比”路径；读取端仍会限制条目数、单条大小、总大小与中央目录大小。
- 归档条目集合固定。出现其他条目即拒绝（`BACKUP_UNEXPECTED_ENTRY`），避免把临时文件、锁文件、凭据或可执行内容夹带进来。
- 不写入原电脑的绝对路径、Windows 用户名、机器名或数据目录指针。

## 2. manifest.json

```json
{
  "format": "livememory-backup",
  "format_version": 1,
  "app_version": "0.13.2",
  "build_id": "75588ba16aec",
  "commit": "3d4232704dd9a710ee8c55a1688ec4ff9812821c",
  "schema_version": 16,
  "created_at": "2026-11-14T07:30:00.000Z",
  "platform": "win32",
  "contains_credentials": false,
  "encryption": null,
  "included": [
    {"path": "database/livememory.db", "reason": "sessions, chat, viewers, payments, AI reports, long-term memory, tasks"},
    {"path": "config/settings.json", "reason": "language, appearance, storage mode, retention preference"}
  ],
  "excluded": [
    {"path": "secrets/", "reason": "credentials"},
    {"path": "logs/", "reason": "machine-specific logs"},
    {"path": "cache/", "reason": "regenerable cache"},
    {"path": "runtime/", "reason": "machine-specific locks and runtime state"},
    {"path": "exports/", "reason": "regenerable AI packages"},
    {"path": "backups/", "reason": "nested emergency snapshots"},
    {"path": "app/", "reason": "unpacked executable assets"},
    {"path": "config/ai-providers.json", "reason": "provider configuration bound to this device key"},
    {"path": "data-location pointer", "reason": "machine-specific absolute path"}
  ],
  "counts": {
    "sessions": 12,
    "events": 5210,
    "viewers": 340,
    "broadcasters": 3,
    "viewer_memories": 120,
    "memory_facts": 980,
    "ai_jobs": 5,
    "ai_results": 44,
    "monitor_targets": 2
  },
  "data_range": {"first_session_at": 1760000000000, "last_session_at": 1763000000000},
  "files": [
    {"name": "database/livememory.db", "bytes": 1048576, "sha256": "..."},
    {"name": "config/settings.json", "bytes": 180, "sha256": "..."}
  ]
}
```

字段规则：

| 字段 | 规则 |
| --- | --- |
| `format` | 必须为 `livememory-backup` |
| `format_version` | 正整数；大于本程序支持的版本 → `BACKUP_FORMAT_UNSUPPORTED`，不当作损坏 |
| `schema_version` | 正整数；大于当前程序 schema → `BACKUP_SCHEMA_UNSUPPORTED`；小于当前 schema 时在恢复暂存区执行本地迁移 |
| `app_version` / `build_id` / `commit` | 诊断信息，不参与兼容判断 |
| `created_at` | ISO-8601；无法解析 → 清单无效 |
| `contains_credentials` | 必须显式为 `false`；缺失或 `true` → 拒绝 |
| `encryption` | v1 必须为 `null`；出现算法 → `BACKUP_ENCRYPTION_UNSUPPORTED` |
| `files` | 只描述 `database/...` 与 `config/...`；名称必须安全、唯一；大小为整数；sha256 为 64 位小写十六进制 |
| `counts` | 备份时从快照数据库读取；恢复时重新读取并逐项比对，防止“校验和正确但内容被替换” |
| `data_range` | 仅供预览，不参与判断 |

`manifest.json` 本身不出现在 `files` 中；它的大小与 CRC 由 ZIP 中央目录校验。

## 3. 内容与排除清单

必须包含：

- 直播场次、事件/弹幕、观众身份与映射、昵称快照；
- SC、礼物、舰长等支付事件与币种合计（`events`、`viewer_currency_totals` 等）；
- 长期观众画像、事实、证据与版本（`viewer_memories`、`memory_facts`、`memory_fact_evidence`、`memory_versions`）；
- AI 分析报告、证据索引、汇总节点、翻译缓存（`ai_results`、`ai_result_evidence`、`ai_aggregate_nodes`、`ai_translations` 等）；
- AI/记忆任务及批次状态（`ai_jobs*`、`memory_jobs*`），用于恢复后显示“未完成/可继续”，而不是伪装成运行中；
- 自动监控目标（`monitor_targets`）；
- 数据库 schema 版本与 `app_meta`；
- 用户设置：语言、主题、存储模式、保留天数、引导完成标记。

必须排除：

- `secrets/`（Bilibili Cookie、AI Provider 密钥及其安装密钥）；
- `config/ai-providers.json`（绑定本机加密密钥的 Provider 配置）；
- `logs/`、`cache/`、`runtime/`（含 `instance.lock`、`runtime.json`、`ai-v13.json`）；
- `exports/`（可从数据库重新生成的 AI 包）；
- `backups/`（含恢复前安全快照，避免嵌套膨胀）；
- `app/`（SEA 解包资源）；
- 数据目录指针（`data-location.json`，机器专属绝对路径）。

`preferredPort` 不写入 `config/settings.json`：它是本机偏好，不是用户数据；迁移后由新机器重新选择端口，端口冲突会自动顺延。

## 4. 完整性模型

1. 创建：`VACUUM INTO` 生成一致快照 → `PRAGMA integrity_check` → 逐文件 SHA-256 + CRC-32 → 写入临时归档（写入时再次计算 CRC，检测源文件在两次读取之间变化）→ 重新打开临时归档做完整校验 → 原子改名。
2. 读取：中央目录结构校验 → 条目名称/类型/数量/大小上限 → 本地头与中央目录一致 → 逐条 CRC-32 → 清单字段校验 → 数据库 SHA-256 → `PRAGMA integrity_check` → schema/计数比对。
3. 任一环节失败：不触碰当前数据库；临时目录/临时文件删除；错误码见 §6。

## 5. 资源上限

| 限制 | 值 |
| --- | --- |
| 归档文件 | 2 GiB |
| 解压后总大小 | 2 GiB |
| 单条目 | 2 GiB |
| 条目数 | 16 |
| 中央目录 | 4 MiB |
| manifest | 1 MiB |
| settings | 256 KiB |

这些上限远高于普通主播的单机数据，只用于约束恶意文件。测试通过显式传入更小的 limits 验证边界。

## 6. 稳定错误码

| 错误码 | 含义 |
| --- | --- |
| `BACKUP_INVALID_ARCHIVE` | 不是 ZIP、结构损坏、ZIP Slip、符号链接、压缩条目、重复名、数据描述符、ZIP64 |
| `BACKUP_TOO_LARGE` | 超过归档/条目/总大小上限 |
| `BACKUP_TOO_MANY_ENTRIES` | 条目数超限 |
| `BACKUP_CHECKSUM_MISMATCH` | CRC 或 SHA-256 不匹配 |
| `BACKUP_MANIFEST_INVALID` | 清单字段缺失/类型错误 |
| `BACKUP_FORMAT_INVALID` | `format` 不是 `livememory-backup` |
| `BACKUP_FORMAT_UNSUPPORTED` | 未来格式版本 |
| `BACKUP_SCHEMA_UNSUPPORTED` | 未来数据库版本 |
| `BACKUP_CREDENTIALS_PRESENT` | 清单声称包含凭据 |
| `BACKUP_ENCRYPTION_UNSUPPORTED` | v1 不支持加密归档 |
| `BACKUP_CONTENT_MISMATCH` | 缺文件、大小不符、schema/计数不符 |
| `BACKUP_VERIFY_FAILED` | 数据库无法打开或 `integrity_check` 失败 |
| `BACKUP_SETTINGS_INVALID` | 设置 JSON 无效或含未知键 |

所有错误都在界面中通过三语 `errors.*` 呈现，不要求用户打开开发者工具。

## 7. 版本演进规则

- 新增可忽略字段：保持 `format_version = 1`，旧程序必须拒绝未知顶层字段？**否**——v1 读取端忽略未知字段，但任何影响语义的字段都必须有默认值。
- 改变归档布局、加密方式、清单语义：提升 `format_version`，旧程序必须给出“请更新 LiveMemory”，不得尝试恢复。
- 数据库 schema 升级仍由现有迁移链完成；备份的 `schema_version` 只用于兼容判断与迁移暂存。

## 8. 跨电脑保证

- 归档内没有绝对路径；`ai_packages.relative_path` 等数据库路径字段本来就是相对路径。
- 恢复后的数据目录可以位于任意盘符/用户名/语言路径；新机器不需要旧机器的管理员权限、Windows 用户名或安装位置。
- 恢复后 `secrets/` 为空，界面明确提示重新登录 Bilibili、重新填写 AI API Key；YouTube 公开聊天不需要登录。
