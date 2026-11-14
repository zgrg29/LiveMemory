# RC0 P0-5：本地 HTTP API 鉴权与 Windows 最小权限（2026-11-14）

> 本轮只处理 P0-5。未修改生产数据库、未干扰正在采集的直播、未调用真实付费 AI、未 Push/Tag/发布。
> 所有复现与测试使用 `tests/.tmp/` 隔离数据目录；正式 EXE 验证使用本机构建与临时数据目录。
> **未完成真实桌面交互验收**（浏览器自动打开/点击、真实 Ctrl+C/关闭窗口），不得描述为真实验收。

## 1. 结论摘要

- 修复前：`/api/*` 全部无认证。隔离数据目录中实测 `GET /api/bootstrap`、`GET /api/viewers`、`PATCH /api/settings`、`POST /api/simulate/start`、`POST /api/sessions/:id/stop`、`POST /api/storage/location`、`GET /api/events/stream` 均可无凭据成功；伪造 Origin 与 `Origin:null` 对 GET 也成功。
- 修复后：除 `/api/health`、`/api/auth/status`、`/api/auth/session` 外，所有 `/api/*`（含 SSE）要求启动器建立的一次性 fragment token → `HttpOnly; SameSite=Strict` Cookie；无凭据/错误凭据 401；伪造 Origin、`Origin:null`、恶意 Host、跨站 `Sec-Fetch-Site` 均 403。
- 发布 EXE 从 `requireAdministrator` 改为 `asInvoker`。正式 EXE 在 Low Mandatory Level 会话直接启动，无需 UAC；10 项功能矩阵与 12 项 P0-5 安全矩阵通过。
- 未发现日常功能需要管理员权限。旧版跨管理员账号数据目录的 profile 扫描保留为历史兼容，不作为提权理由。

## 2. 修复前复现证据

脚本：`tests/.tmp/p0-5-probe.mjs`（隔离目录，后删除）。修复前实际输出：

| 请求 | 修复前 | 说明 |
| --- | --- | --- |
| `GET /api/bootstrap` | **200** | 包含设置、状态、数据目录等 |
| `GET /api/viewers` | **200** | 读取个人数据 |
| `PATCH /api/settings` | **200** | 修改主题成功 |
| `POST /api/simulate/start` | **201** | 创建场次 `ses_01M7C39NX0A989ESXGVS` |
| `POST /api/sessions/:id/stop` | **200** | `stopped:true` |
| `POST /api/storage/location` | **400** `RELOCATION_INVALID` | 无认证即进入迁移处理；使用相对路径避免真实迁移 |
| `GET /api/events/stream` | **200** `text/event-stream` | 无认证订阅实时事件 |
| `GET /api/viewers` + `Origin: http://evil.example` | **200** | Origin 只校验写请求 |
| `GET /api/viewers` + `Origin: null` | **200** | `null` 被当作缺失 |
| `GET /api/health` + `Host: evil.example` | **403** | Host 校验原本有效 |
| `POST /api/auth/session` | **404** | 认证端点不存在 |
| `PATCH /api/settings` + 无效 Cookie | **200** | Cookie 完全未被检查 |

**根因**：`src/server/app.mjs` 只做 Host 校验，且 Origin 只对非 GET/HEAD/OPTIONS 校验；没有服务端会话认证；EXE manifest 为 `requireAdministrator`，上述请求以提升权限执行。

## 3. 威胁模型

| 类别 | 能力 | 修复前风险 | 修复后边界 |
| --- | --- | --- | --- |
| 本机同用户进程 | 可直接构造 HTTP、无需浏览器 | 可读写全部 API、停止/删除场次、迁移目录 | 需要浏览器会话 Cookie；不能调用 token 分发端点；重启后旧 Cookie 失效 |
| 恶意网页 | 浏览器跨站请求 | GET 可触发副作用；CORS 不阻止请求 | `SameSite=Strict` + 全方法 Origin + `Sec-Fetch-Site` + 无 CORS 放行 |
| DNS rebinding | 恶意域名解析到 127.0.0.1 | Host 已阻止 | Host 继续严格校验；API 仍需 Cookie |
| 管理员权限放大 | 提权进程内执行 | 所有 API 操作继承管理员令牌 | Manifest `asInvoker`，日常不提权 |
| 重启后的旧凭据 | 读取旧 URL/Cookie | 不适用 | token 仅进程内存；旧 Cookie/旧 token 401 |
| 同用户恶意软件 | 读浏览器资料/注入/抓启动参数 | 无法防御 | **仍无法防御**；本地单用户应用边界 |

CORS/SameSite 只约束浏览器；**不能**阻止本机进程直接发 HTTP。因此服务端会话认证是主控制，Origin/Host/Sec-Fetch-Site 是浏览器纵深。

## 4. 方案选择

考虑过：

1. **固定/安装级 token + 用户手动输入**：拒绝。违反“无需用户配置”，且固定 token 可预测/长期有效。
2. **`/api/token` 或 `/api/bootstrap` 无条件返回 token**：拒绝。任何本机进程都能取得，等于无认证。
3. **仅 `Authorization: Bearer`**：拒绝作为唯一方案。原生 EventSource 不能加 Header；下载 anchor 也不方便。可作为附加能力，但本轮不引入。
4. **启动器生成一次性 bootstrap token，放在 URL fragment；页面交换 HttpOnly Cookie**：采用。满足零用户配置、SSE/下载兼容、重启失效、无查询串秘密、无 token 分发端点。
5. **Cookie + SameSite=Strict + 全方法 Origin + Sec-Fetch-Site**：采用为浏览器纵深。Cookie 不设 `Secure`，因为回环 HTTP 无法使用；Cookie 不设 `Domain`，只对当前 127.0.0.1 host 生效。
6. **保留 requireAdministrator，只加认证**：拒绝。认证不能消除管理员权限放大；日常功能没有提权需求。

## 5. 实现

新增/修改：

- `src/server/auth.mjs`：`createAuthService()`，256-bit 随机 bootstrap/session token、5 分钟一次性 bootstrap、7 天会话、常量时间比较、Cookie 解析、公开路径集合、`invalidateSessions()`/`invalidateBootstrap()` 测试钩子。
- `src/server/app.mjs`：所有带 Origin 的请求校验；`Sec-Fetch-Site` 对 `/api/*` 校验；公开路径白名单；其他 `/api/*` 认证；SSE 同一入口；401 `AUTH_REQUIRED`；认证拒绝只记录原因。
- `src/server/http.mjs`：`sendJson()` 支持额外响应头（`Set-Cookie`）；`isAllowedOrigin()` 拒绝 `Origin:null`；新增 `isAllowedFetchSite()`。
- `src/server/routes.mjs`：新增 `GET /api/auth/status`（只返回布尔）、`POST /api/auth/session`（只接受已持有 token，成功设置 Cookie）。
- `src/server/index.mjs`：启动时创建 auth；`server.browserUrl` 含 fragment token；`runtime.json` 只写 plain URL；`server.auth` 暴露给同进程测试；测试专用 `LIVE_MEMORY_TEST_BOOTSTRAP_FILE` 供非交互 EXE 回归读取一次性 URL。
- `src/web/js/auth.js`：读取/清除 fragment token、交换 Cookie、状态检查；不写 localStorage/sessionStorage，不打印 token。
- `src/web/js/app.js`：先 `establishSession()` 再加载 `/api/bootstrap`；401 事件渲染三语“请从 LiveMemory 重新打开”页面。
- `src/web/js/api.js`：401 时派发 `lm:auth-required`，不包含凭据。
- 三语 i18n：`auth.title/body/invalid/reload`、`errors.authRequired`。
- `src/launcher/launcher.mjs`：删除管理员检查；浏览器打开 `server.browserUrl`；`browserFailed` 三语改为重新运行 LiveMemory 的说明。
- 删除 `src/launcher/admin.mjs` 与 `tests/unit/admin.test.mjs`；三语 `adminRequired` 键移除。
- `scripts/build-windows.mjs`：manifest 显式归一为 `asInvoker`，注入后再次断言。
- `scripts/verify-p0-5-exe.mjs`（新增）、`scripts/verify-exe.mjs`、`scripts/verify-youtube-lifecycle-exe.mjs`、`scripts/verify-exe-ai.mjs`、`scripts/verify-exe-history.mjs`、`scripts/verify-live-status-ui.mjs`：asInvoker + bootstrap Cookie 流程。
- 进程内测试/开发脚本：`startServer({auth:false})` 仅用于隔离夹具；HTTP/环境变量不能关闭生产认证。

## 6. 修复前后行为对照

| 场景 | 修复前 | 修复后 |
| --- | --- | --- |
| 无凭据 `GET /api/viewers` | 200 数据 | 401 `AUTH_REQUIRED` |
| 无凭据 `PATCH /api/settings` | 200 修改 | 401，未修改 |
| 无凭据 `POST /api/sessions/:id/stop` | 200 停止 | 401，未停止 |
| 无凭据 `POST /api/storage/location` | 进入迁移处理 | 401，未进入 |
| 无凭据 SSE | 200 事件流 | 401 JSON，无 `event-stream` |
| 伪造 Origin（GET） | 200 | 403 |
| `Origin:null` | 200 | 403 |
| 恶意 Host | 403 | 403 |
| 无效 Cookie | 200 | 401 |
| 有效浏览器会话 | 200（无认证概念） | 200，Cookie 可完成核心操作 |
| 重启后旧 Cookie | 不适用 | 401 |
| 旧 bootstrap token | 不适用 | 401，一次性 |
| 多个页面/SSE | 不适用 | 同一 Cookie，均 200 |
| EXE 权限 | `requireAdministrator` / UAC | `asInvoker` / 无 UAC |

## 7. 自动化测试

新增：

- `tests/integration/api-auth.test.mjs`：14 项（无凭据读/写/危险操作/SSE、伪造 Origin/null/跨站元数据、恶意 Host、无效 Cookie/token、fragment-only URL、核心操作、危险操作校验、多页面/多 SSE、失效、重启、Provider Key 与 token 不泄漏）。
- `tests/integration/graceful-close.test.mjs`：1 项（`startServer.close()` 删除 runtime 文件、停止 HTTP、重启数据库可用）。
- `tests/unit/server-auth.test.mjs`：6 项（一次性、Cookie 属性、过期、无效、禁用、公开路径、Cookie 解析）。
- `tests/unit/auth-boot.test.mjs`：6 项（fragment 读取/清除、交换、状态、静态 boot 顺序）。
- `tests/unit/pe-manifest.test.mjs`：新增 asInvoker/构建脚本断言。
- 既有集成测试显式 `auth:false`，只用于进程内数据/功能夹具；认证启用路径由 `api-auth` + EXE 覆盖。

结果：

- 全量：`745 passed / 0 failed / 0 skipped（270,168 ms，2026-11-14）`。
- 单元：`457 passed / 0 failed`。
- 集成：`288 passed / 0 failed`。
- Bilibili 专项：`53 passed / 0 failed`。
- 认证专项：14 integration + 6 auth service + 6 auth boot + 1 graceful = 27 项通过。

## 8. 正式 EXE 验证

构建（2026-11-14，最终构建见 §11）：

- buildId `75588ba16aec`
- commit `3d4232704dd9a710ee8c55a1688ec4ff9812821c`（构建对应源码提交）
- SHA-256 `d3d1ddc1d1b207cd72bb6c6e03a3a07216885a3e2a53ca3bf9f1a5cb48a558ae`
- 96,436,224 bytes（92.0 MB）
- 177 assets
- RT_MANIFEST `asInvoker`

`scripts/verify-p0-5-exe.mjs`：**12/12**

- 正式 EXE 在 Low Mandatory Level 会话直接启动，无需 UAC；`/api/health` 同 buildId。
- 未认证 `GET /api/viewers` 401、`PATCH /api/settings` 401、`POST /api/storage/location` 401、SSE 401。
- 伪造 Origin 403、`Origin:null` 403、恶意 Host 403。
- 无效 Cookie 401、无效 bootstrap token 401。
- fragment token → Cookie：`HttpOnly`、`SameSite=Strict`、无 `Secure`（回环 HTTP）。
- 认证后 bootstrap/status/settings/simulate/SSE/stop 全部成功；一次性 token 重放 401。
- token 不出现在 `runtime.json` 与日志。
- 进程停止后 HTTP 监听关闭；重启后旧 Cookie/token 401、新 URL 可用、原场次数据保留。
- **性质**：正式 EXE + 真实 HTTP 服务 + 隔离数据目录；模拟浏览器相同的交换流程，不是真实浏览器点击。

`scripts/verify-exe.mjs`：**10/10**

- asInvoker manifest、全新数据目录启动/HTTP/SQLite、重启保留、硬杀恢复、端口顺延、单实例、不可写目录错误、异目录运行、解压复用、CLI 三语。

`scripts/verify-youtube-lifecycle-exe.mjs`：

- 通过：180,934 ms 断连 → 同一 session 恢复 → stale 重放后事件行 5 / 唯一 5 → `platform_ended`；buildId 与最终 EXE 一致。

## 9. 未验证 / 已知边界

1. **真实浏览器自动打开与点击**：本机沙箱无法进行可靠桌面交互；只验证了与浏览器相同的 HTTP 握手。
2. **真实 Ctrl+C / 关闭命令行窗口的优雅退出**：Windows 关闭窗口直接终止进程；`scripts/verify-p0-5-exe.mjs` 的 SIGTERM 是强制终止。源码级 `server.close()` 已由 `graceful-close` 测试覆盖；真实桌面退出需用户验收。
3. **真实 UAC**：asInvoker 不再需要 UAC；本机 Low Mandatory Level 启动成功即为普通权限证据。旧版 UAC 行为不再适用。
4. **同 Windows 用户的恶意软件**：可读浏览器 Cookie/资料、注入浏览器或抓取启动 URL；HTTP 认证无法防御。
5. **Cookie 非 Secure**：回环 HTTP 限制；Cookie 仅对 `127.0.0.1:<port>` 生效。
6. **数据目录 ACL**：未强制收紧；用户选择共享/同步目录时其他可访问账户仍可能读取。
7. **旧版跨管理员账号数据目录**：profile 扫描保留，但未做完整跨账号等价性验证。
8. **Bilibili/YouTube/AI 真实平台/真实付费 Provider**：本轮未新增真实平台长时运行或真实付费 API；使用既有 Mock/假服务与本地测试数据。
9. **旧 EXE 升级**：`dist/LiveMemory.exe` 已替换为 asInvoker 新构建；旧 EXE 的 UAC 行为不再适用。发布前仍需在干净 Windows 机器复核。

## 10. P0-5 关闭结论

**代码级与正式 EXE 级可关闭**：

- 原始漏洞已实际复现（无凭据读/写/停止/SSE/Origin）。
- 认证、Origin/Host、SSE、危险操作、重启失效、多页面、Provider Key 不泄漏均有自动化与 EXE 证据。
- 发布 EXE 已改为 asInvoker 并通过 10 项功能矩阵。
- 未验证项均为真实桌面/真实平台/真实付费 Provider/同用户恶意软件边界，不阻塞 P0-5 代码关闭，但必须在 STATUS/HANDOFF 中列为用户待验收。

## 11. Git / 构建信息

- 代码提交：`3d4232704dd9a710ee8c55a1688ec4ff9812821c`
- 最终构建：buildId `75588ba16aec` / commit `3d4232704dd9a710ee8c55a1688ec4ff9812821c` / SHA-256 `d3d1ddc1d1b207cd72bb6c6e03a3a07216885a3e2a53ca3bf9f1a5cb48a558ae` / `96,436,224` bytes / `177` assets / `asInvoker`
- 构建时间：`2026-11-14T04:33:33.510Z`
- 未 Push、未 Tag、未发布。

## 12. 下一轮 P0-2 交接

1. 备份/恢复必须在认证之后实现；新增备份下载/上传接口默认受同一会话保护，不得另开无认证端口。
2. 导入外部备份是高风险写操作：格式/版本/大小/路径穿越/压缩炸弹/覆盖预览/回滚必须先设计；不要复用 `storage/clear` 的宽泛删除路径。
3. 备份文件可能含聊天、观众身份、长期记忆与设置；不要包含 `secrets/` 凭据，除非用户明确选择并加密码。
4. 迁移/备份的失败路径要保留原数据；测试必须使用独立目录，不得触碰生产库。
5. 若需要管理员权限完成某些恢复操作，必须先证明必要性，并用独立受控提权，不得恢复整个 EXE 的 requireAdministrator。
