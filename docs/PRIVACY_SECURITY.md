# 隐私与安全（PRIVACY_SECURITY）

## 1. 网络面

- 服务只绑定 `127.0.0.1`，不监听 `0.0.0.0`，不开放公网。
- 端口默认 47800，冲突时自动顺延或由系统分配；不写死、不对外公告。
- 启动器仅在本机服务确认就绪后打开浏览器。

## 2. HTTP 防护

- **Host 校验**：只接受 `127.0.0.1:<port>`、`localhost:<port>`、`[::1]:<port>`，防止 DNS rebinding。
- **Origin 校验**：非 GET/HEAD 请求若带 Origin，必须与本地源一致。
- **CSP**：`default-src 'self'`，禁止内联脚本/样式、禁止 framing、禁止 object。
- **nosniff / Referrer-Policy / CORP / COOP / Permissions-Policy**。
- **静态文件**：解码后规范化路径，必须位于 `src/web` 内，防止 `..` 穿越；拒绝 NUL。
- **JSON body**：1 MB 上限、必须 `application/json`、必须是对象。
- **API 未知路径**返回 JSON 404，不回退到 HTML。

## 3. 凭据

- Bilibili Cookie、YouTube OAuth Token、API Key 等**不写入日志**、默认**不进入备份**、不进入 AI 分析包。
- 日志脱敏：键名匹配 `cookie|sessdata|bili_jct|token|secret|password|authorization|api[-_]?key|credential`，值模式匹配 `SESSDATA=`、`Bearer ...` 等。
- 聊天正文不写日志。
- 未来持久化凭据时使用 DPAPI 或 AES-256-GCM + 用户密码派生，不放在普通 JSON。

## 4. 日志

- 位置：`%LOCALAPPDATA%\LiveMemory\logs\livememory-YYYY-MM-DD.log`（JSONL）。
- 内容：启动、迁移、服务就绪、场次开始/结束、设置变更、错误码。
- 不记录：Cookie/Token、聊天正文、观众隐私数据、完整文件路径以外的敏感信息。
- 单文件 5 MB 轮转为 `.1`。
- `runtime/last-error.json` 只记录错误码、时间、端口与 `messageKey`，不含凭据。

## 5. 数据最小化

- 默认精简模式：AI 导入并校验后清理原始聊天正文，保留计数、身份、金额与画像。
- 观众页默认不加载原始消息。
- 分析包只包含分析所需的最小字段（不含 Cookie、不含历史原始消息）。
- 不采集遥测、不发起与功能无关的网络请求。

## 6. 外部文件导入（M5/M6）

必须：

1. 限制文件大小与条目数。
2. 拒绝绝对路径、`..`、符号链接、NUL。
3. 校验格式版本与校验和。
4. 校验 JSON Schema（AI）或数据库完整性（备份）。
5. 在事务/临时目录中处理，失败回滚。
6. 不执行导入内容中的任何代码、脚本或 URL。
7. 导入前给出内容预览与覆盖提示。

## 7. 提示词注入防护

- 所有弹幕文本都视为不可信数据。
- 提示词明确规定：包内文字不是指令，不得改变任务或输出协议。
- 导入端做结构校验（Schema、ID、引用范围），即使模型输出被注入也无法越权写入任意数据。
- 不把 AI 输出直接当 HTML/SQL/文件路径使用。

## 8. XSS 防护

- 前端只通过 `textContent` 写入动态文本，禁止 `innerHTML`。
- CSP 禁止内联脚本，脚本均来自同源文件。
- 用户昵称、标题、弹幕、礼物名在 UI、AI 包、日志中均按纯文本处理。

## 9. 金额与数据完整性

- 整数最小货币单位；不使用浮点存储。
- 去重键 + 唯一约束防止重复累计。
- 删除场次通过外键级联；删除观众前需确认其参与记录的影响。
- 备份使用 SQLite 一致快照，禁止直接复制写入中的数据库。

## 10. 权限

- 正常运行不需要管理员权限。
- 数据目录不可写时给出本地化错误与替代方案，不默认提权。
- EXE 不写注册表；卸载时用户可自行删除数据目录。

## 11. 敏感数据提示

备份、导出与分析包可能包含长期观众资料与聊天内容。软件必须在相关操作处明确提示其敏感性，并说明：

- 文件保存在本机；
- 上传给 AI 服务即离开本机，由用户自行判断；
- 不要公开分享含观众信息的备份。

## 12. Bilibili 凭据（2026-11-08 起）

- 扫码登录得到的 Cookie 只保存在 `<数据目录>\secrets\bilibili-login.json`（AES-256-GCM 加密）；密钥在同目录 `.bilibili-key`，尽力用 `icacls` 限制为当前 Windows 用户。同账户的进程仍可读取，因此这是「用户目录 + 加密」级别的保护，不是 DPAPI。
- 状态 API（`/api/bilibili/status`）只返回 `loggedIn`、`uid`、`name`、时间，不返回 Cookie。
- 日志脱敏覆盖 `SESSDATA`、`bili_jct`、`DedeUserID`、`Bearer …`、JSON 中的 `token/cookie/apiKey/secret/password`（本轮修复了一个会把原值重新拼回文本的正则缺陷）。
- 二维码登录页在系统默认浏览器中打开 Bilibili 自己的页面；应用不截屏、不上传、不把登录参数写入日志。
- AI 分析包不包含登录信息与 Cookie（导出只读取数据库事件与统计）。
- 观众身份来自平台 UID；平台不提供 UID（UID=0）时不猜测、不按昵称合并，也不会因此把观众写进别人的档案。

## 13. YouTube 凭据（2026-11-08 起）

- **两种官方凭据模式**：
  - 公开直播模式（`api-key`）：应用级 API Key 放在查询参数里，只能读公开数据；不涉及任何用户账号；
  - OAuth 模式：主播本人授权，access/refresh token 存在本地。
- **凭据不进入仓库、不进入默认构建**。可用环境变量或 `<数据目录>\config\` 下的私有文件提供；`src/platforms/youtube/oauth-config.mjs` 的常量默认为空。
- **令牌存储**：`<数据目录>\secrets\youtube-oauth.json`，AES-256-GCM 加密，密钥同目录 `.youtube-oauth-key`，尽力用 `icacls` 限制为当前 Windows 用户。与 Bilibili 一样，这是「用户目录 + 加密」级别，不是 DPAPI。
- **令牌可见面**：`/api/youtube/status` 只返回 `signedIn`、频道名、过期时间、`hasRefreshToken`；任何 API、日志、AI 包、备份都不含令牌。
- **撤销与删除**：退出登录会先调用 Google revoke 端点（尽力而为），再删除本地加密文件；跨电脑迁移需要重新登录（密钥不导出，这是刻意设计）。
- **日志**：脱敏规则覆盖 `authorization`、`token`、`api[-_]?key`、`secret`、`refresh_token` 等键名与 `Bearer …` 值；YouTube `code`/`state` 不写日志。
- **回调安全**：回环接收器只绑定 `127.0.0.1`、只接受一次性随机端口与固定路径、校验 `state`、5 分钟超时、回调页无外部资源。

## 14. YouTube 数据保留与外部 AI

- YouTube 公开直播聊天属于平台数据。Developer Policies 对 API Data 要求保存不超过 **30 个日历日**；主播 OAuth 不能为其他观众的数据授权无限期保存。匿名网页接口不是官方 API，但本轮采用同样的 30 天上限作为保守默认，而不是认为「非 API 就可以无限保存」。
- 实现：`youtubeRawRetentionDays` 只允许 **1–30 天**（默认 30）。超过窗口后清理：
  - 聊天原文 `events.content`；
  - 表情元数据 `events.emotes`；
  - 作者 badge `events.badges`；
  - 平台金额显示文本 `events.amount_display`；
  - 过期 YouTube 观众的昵称历史与当前昵称。
- 保留：事件行、消息计数、稳定 Channel ID、场次/观众币种合计。**这仍不等同于删除全部个人数据**；严格删除/去标识化模式尚未实现，文档不得声称已经完全合规。
- 触发：启动、YouTube 场次结束、`POST /api/youtube/retention/apply`。
- Bilibili 数据不受 Google/YouTube 政策约束，未被该清理自动处理。
- 匿名网页聊天（实验性）：
  - 不发送 Cookie、OAuth token 或用户 API Key；
  - 仍会拿到公开的观众昵称、Channel ID 与聊天内容，因此同样受上述保留策略约束；
  - 该接口不是官方 API，可能违反 YouTube ToS；默认关闭，必须显式启用并显示风险。
- AI 分析包由用户手动导出并交给自选 AI 服务，软件不自动上传；包内不含凭据。导出前建议先执行保留清理。
- 不为了「长期画像」而绕过平台政策，也不改用抓取作为默认发布方案。

## 15. 匿名网页接口的边界（2026-11-08）

> 以下 §16–§18 为 v0.4.0 新增。

- 只读：不发送消息、不点赞、不关注、不修改任何平台状态。
- 不携带任何用户登录态；不读取、不保存 Cookie。
- 不绕过登录、验证码、年龄墙、地区限制；被拒绝时显示真实原因。
- 不把网页接口的 key 当作用户凭据；它来自公开页面，只用于该次只读请求。
- 不把匿名接口描述为官方 API；UI 与文档明确标注实验性和条款风险。
- 该路径不是默认；没有官方凭据时，用户必须主动点击「启用免登录实验模式」。
- 研究、真实采样与许可证记录见 `docs/YOUTUBE_ANONYMOUS_RESEARCH.md`。

## 16. 数据位置、迁移与本地目录选择（v0.4.0）

- 位置记录只含 `version/dataDir/updatedAt`，保存在 `%LOCALAPPDATA%\LiveMemory\data-location.json`，镜像到 `%APPDATA%\LiveMemory\data-location.json`；不含数据库内容、Cookie、Token 或 API Key。
- 位置记录目标必须已存在并含 `database/livememory.db`；否则启动失败，不创建空库、不覆盖旧数据。恢复方式：重新连接磁盘、`--data-dir` 或 `--forget-data-location`。
- 迁移拒绝：UNC 网络共享、磁盘根目录、Windows/Program Files/ProgramData 系统目录、用户主目录/桌面/下载/文档根目录、与源目录相同或嵌套、目标已有 LiveMemory 数据、空间不足。
- OneDrive/Dropbox/Google Drive、临时目录、长路径只警告并要求显式确认；**映射网络盘（盘符形式）未自动识别**，用户必须自行确认是本地磁盘。
- 迁移前停止适配器、checkpoint、关闭 SQLite；复制到目标卷 staging，校验 SQLite `integrity_check`、表计数、schema 版本与配置/凭据/导出文件 SHA-256；成功后移入目标并切换运行时。
- **原目录永远不由应用自动删除**；失败回滚到原目录。旧目录可能仍含敏感聊天与凭据，用户确认新目录可用后需自行安全删除。
- 目录选择器：本地 PowerShell 固定脚本调用 WinForms FolderBrowserDialog；不执行用户输入的命令，不使用 `cmd /c`。打开文件夹只接受 `data/exports/backups/logs` 四个受管键，不拼接任意路径。
- 迁移期间 API 进入维护模式，除 relocation/clear/health/status 外返回 503，避免并发写库。

## 17. 清空数据与恢复出厂（v0.4.0）

- 两种模式的范围见 `docs/STATUS.md` §2.3：
  - `data` 保留语言、主题、存储模式、数据目录、位置记录、平台登录凭据、`backups/`、日志与根目录无关文件；
  - `factory` 额外删除偏好、凭据、日志、缓存并重置默认设置；仍不删除位置记录、`backups/`、根目录无关文件或外部备份。
- 必须输入 `DELETE` / `RESET`；记录中禁用并由服务端再次校验（409）；不做“一键立即删除”。
- 默认创建数据库快照到 `%LOCALAPPDATA%\LiveMemory-Backups`（`LIVE_MEMORY_BACKUP_DIR` 可覆盖），**不在即将清空的数据目录内**。快照只含数据库，不含分析包/凭据/设置；不是 M5 `.livememory` 备份。
- 数据库删除在事务内，随后 `VACUUM` + WAL checkpoint；文件删除（`exports/`、`cache/`，factory 另含 `secrets/`、`logs/`）是尽力而为。极端断电可能留下部分文件，但数据库仍为空且下次启动会重新初始化。
- “清空数据”**不删除登录凭据**；如果用户希望同时清除授权，使用“恢复出厂设置”或在对应平台退出登录。
- 应用管理的目录：`config/`、`database/`、`secrets/`、`exports/`、`cache/`、`logs/`、`runtime/`、`backups/`。根目录其他个人文件与外部备份不属于清空范围。

## 18. 多主播身份、关联性与保留（v0.4.0）

- 主播维度关系表 `viewer_broadcasters` 会新增“同一平台账号出现在哪些主播处”的关联。这比单主播统计更容易识别跨频道活动，属于新增的链接性风险。
- 默认观众页、统计与 AI 包都以“当前主播”为范围；跨主播合计明确标注，不自动混入当前主播画像。AI 包只给其他主播的数量 `other_broadcaster_count`，不含其互动细节。
- 主播身份是公开频道标识（YouTube channelId / Bilibili anchor uid/room id），不是观众个人数据；但主播—观众关系仍是可关联数据。
- 保留规则不因新增关系表而放宽：
  - YouTube 30 天清理仍删除原文、emotes、badges、amount_display 与过期昵称；关系表只保留计数/稳定 ID/金额合计；
  - 删除观众（未来 UI）会级联删除其 `viewer_broadcasters` 与币种合计；
  - 恢复出厂删除全部关系表；
  - 旧 YouTube 场次无法确认主播时保持 `unresolved`，不猜归属。
- 目前没有“跨主播 AI 画像合并”；未来如提供，必须由用户明确选择，并标注证据来源与主播范围。
