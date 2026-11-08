# 备份与恢复（BACKUP_RESTORE）

状态：**设计完成，功能未实现（M5）**。当前设置页明确提示“M5 阶段提供”，不提供半成品按钮。

## 1. 目标

用户更换电脑后，用一个文件恢复过去积累的全部资料：场次、统计、热度时间线、AI 分析、观众档案、长期画像、经济支持累计、重点关注、保留的原始记录、AI 任务与结果、自定义配置、语言/主题偏好、存储模式、直播间列表。

**第一版只做完整恢复，不做两台电脑数据合并。**

## 2. 备份格式（版本化）

```text
LiveMemory-Backup-2026-11-08.livememory     (ZIP，STORE 或 DEFLATE 均可)
├── manifest.json
├── checksums.json
├── database/livememory.db
├── settings/settings.json
└── resources/            （可选：保留的原始记录、AI 包）
```

### manifest.json

```json
{
  "format": "livememory-backup",
  "format_version": 1,
  "app_version": "0.1.0",
  "schema_version": 1,
  "created_at": "2026-11-08T10:00:00.000Z",
  "platform": "win32",
  "encryption": {"algorithm": null, "kdf": null, "salt": null, "nonce": null},
  "counts": {"sessions": 12, "viewers": 340, "events": 5210, "ai_packages": 3},
  "contains_credentials": false,
  "files": [
    {"name": "database/livememory.db", "bytes": 1048576, "sha256": "..."},
    {"name": "settings/settings.json", "bytes": 512, "sha256": "..."}
  ]
}
```

- 不使用旧电脑的绝对路径。
- 包含 `schema_version` 与应用版本，导入时先判兼容。
- `checksums.json` 可选，与 manifest 中的 `files` 二选一或互为校验（实现时定一种，避免分叉）。

## 3. 凭据策略

默认**不备份**：Bilibili Cookie、YouTube OAuth Token、API Key、其他登录秘密。
迁移后需要重新授权。

保留：直播间列表、平台配置（非敏感）、语言/主题/存储模式、观众与统计。

## 4. 导出流程

1. 设置页点击“导出全部数据”。
2. 若正在直播：提示先停止记录（第一版允许要求暂停）。
3. 使用 SQLite 一致快照：
   ```sql
   VACUUM INTO '<临时目录>/livememory.db';
   ```
   或使用 SQLite backup API；**禁止直接复制正在写入的 `.db`/`-wal`**。
4. 写入 `settings/settings.json`（剔除敏感字段）。
5. 计算每个文件 SHA-256，写 manifest。
6. 打包为单个 `.livememory`。
7. 可选密码加密（见第 7 节）。
8. 提示用户：备份包含长期观众资料，请妥善保管。

## 5. 导入流程

1. 选择文件 → 大小上限（例如 2 GB）与 ZIP 完整性检查。
2. 读取 `manifest.json`：格式、版本、schema 兼容性。
3. 校验每个文件大小与 SHA-256。
4. 预览内容：场次/观众/事件数量、时间范围、应用版本。
5. 检测现有数据冲突（当前数据非空时必须提示）。
6. 用户明确确认。
7. 安全恢复：
   - 解压到临时目录，拒绝绝对路径、`..`、符号链接、超长路径；
   - 校验解压总大小与文件数（防压缩炸弹）；
   - 将当前数据库备份为 `backups/pre-restore-<时间>.db`；
   - 用事务/替换方式写入新数据库；
   - 写回非敏感设置。
8. 重新打开数据库并验证：表存在、schema 版本、计数一致。
9. 失败时回滚到恢复前数据库，并保留错误报告。
10. 重新加载控制台。

## 6. 安全

- 防路径穿越：归档条目名规范化后必须位于目标目录内。
- 防压缩炸弹：限制条目数、单文件大小、总解压大小。
- 拒绝可执行文件与未知扩展名（备份只应包含 db/json/resources）。
- 不自动执行归档中的任何内容。
- 导入过程不联网。

## 7. 加密（建议）

- 使用成熟方案：**AES-256-GCM**（认证加密）+ **Argon2id** 或 **scrypt** 派生密钥。
- 不得自行设计加密算法。
- 加密层应覆盖整个归档（或数据库文件 + manifest 校验和），并认证头部，防止篡改。
- 未实现加密时必须明确提示：“备份文件未加密”。

Node 内置 `crypto.scrypt` 与 `aes-256-gcm` 可满足要求，无需第三方依赖。

## 8. 跨电脑测试（M5 验收）

| 步骤 | 检查 |
| --- | --- |
| 环境 A 创建 2 场直播、若干观众、礼物/SC、画像、设置 | 数据完整 |
| 导出备份 | 文件可生成、校验和正确 |
| 环境 B（全新数据目录）导入 | 预览 → 确认 → 恢复 |
| 比较 | 场次、观众、消息数、经济支持、AI 分析、画像、语言/主题 |
| 金额 | 不重复累计，币种与 value_kind 一致 |
| 损坏文件 | 被拒绝且不修改现有数据 |
| 失败导入 | 原数据保持不变（回滚成功） |
| 凭据 | 备份中不存在 Cookie/Token |

## 9. 未来扩展

- 增量备份（仅为可安全合并的表设计）。
- 两台电脑合并：必须做冲突检测与用户选择，不得用简单拼接冒充可靠合并。
- 加密强度选项与密码找回说明（丢失密码不可恢复）。
