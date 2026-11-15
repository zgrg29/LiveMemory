# 2026-11-15 · 抖音登录修复（DOUYIN-LOGIN-FIX）

## 背景

开发者人工验收发现：匿名弹幕/昵称/稳定 UID 正常；扫码登录显示 `DOUYIN_LOGIN_BLOCKED`；
Cookie 备用入口缺少教程；登录后的礼物采集未验证。要求先调查开源项目，优先实现真实可用的浏览器扫码登录。

## 调查

阅读了 5 个项目的实际登录源码：

- VideoNote-MCP（MIT）：Playwright + 本机 Chrome/Edge；提交 `7ca3bba`（2026-09-09）明确因直连 SSO 返回 HTML 风控页而改为官网登录页；
  `155a4d6` 修复「已扫码后卡住」；`cf17948` 整合。
- douyin-mcp（PolyForm Noncommercial）：Go + rod/CDP + 专用 `browser-profile`；不可整合。
- douyin-parse（无许可证）：Playwright 打开 `www.douyin.com/user/self`，截图二维码，明文保存 Cookie；不可复制。
- dousub（无许可证）：Playwright 扫码；失败提示承认自动化检测/滑块。
- bytedance-nomark（GPL-3.0）：纯 HTTP QR + `a_bogus`，风控时降级 InAppWebView；不可整合。

本机只读复现（2026-11-15 13:53）：
- `sso.douyin.com/get_qrcode` → HTTP 200 `text/html` 9,938 B 指纹挑战页；
- `passport/web/get_qrcode` → `error_code 4031`「安全风险，已阻止此次访问」；
- 真实 Chrome/Edge 官方登录页 → 官网 `get_qrcode` 成功，`error_code=0`、PNG 二维码、`is_frontier=true`。

结论：纯 HTTP 不可行；真实浏览器官方页面可行；不伪造指纹/签名，不绕过验证。

## 实现

- 新增 `src/platforms/douyin/browser-login.mjs`：Chrome/Edge 查找、专用 profile（`.livememory-owned`）、
  `--remote-debugging-port=0`、CDP、官方二维码捕获、`sessionid` 等待、页面内 profile 验证、取消/清理。
- 重写 `login.mjs`：Cookie 格式/不完整/过期；平台验证；`logged_in` / `saved_unverified` / `expired` / `invalid`；
  `saved_unverified` 不冒充登录；`saved` 记录 `verified/verifiedAt/reason`。
- `cookie-store.mjs` 增加验证标记；`service.mjs` 增加四级礼物状态与浏览器登录生命周期；
  `routes.mjs` 新增 `/browser/start|status|cancel`，移除旧的 `/qrcode|poll`。
- UI：状态胶囊、扫码/取消/验证/删除、12 步三语教程、四级礼物卡片；输入错误直接显示。
- 服务器关闭时关闭浏览器；所有新路由在认证之后。

## 验证

### 全量测试

```bat
node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"
```

- **944 passed / 0 failed / 0 skipped（308,251 ms，2026-11-15 最终复跑）**；上一轮 923，本轮 +21。
- `api-auth` 单独复跑 14/14（新增 6 个抖音登录路由 401）。

### 真实浏览器（未扫码）

`node scripts/verify-douyin-browser-login.mjs`（真实 Chrome 157，专用资料目录）：**8/8**
- 官方二维码 PNG base64，约 54 秒，`frontier=true`；
- 状态不含 Cookie/token；取消/清理正常；
- **未执行真实手机扫码**（无账号），不能给成功率。

### 正式 EXE

- Build ID `aff3fbe6a2f1`；commit `91c2fb3`；SHA-256 `9e1940ca…`；`97,584,128` B；requireAdministrator。
- `verify-douyin-exe`：**25/27**；2 项浏览器启动在 DSH 作业对象内失败（Chrome 子进程 `0x80000003`，
  PowerShell 回退无端口），其余登录状态/Cookie 负向/教程资源/匿名真实采集/重启/AI/三平台状态通过。
- `verify-exe`：**10/10**；`verify-twitch-exe`：**20/20**（真实 Twitch + Bilibili/YouTube 状态）。
- 同一浏览器模块在普通 Node 顶层 + 真实 Chrome 8/8，说明失败是沙箱进程层级限制，不是该模块逻辑；
  但**不得**把 EXE 扫码写成已验证，需普通桌面人工验收。

## 未验证

- 真实手机扫码、扫码成功率、真实 Cookie 正向。
- 登录后的礼物推送、真实礼物/连送/付费留言（匿名 0 条，标未观测）。
- EXE 内浏览器启动（沙箱限制）。
- 干净 Windows 电脑、无 Chrome/Edge、非管理员账户、真实 UAC 点击。

## 提交

- `91c2fb35be184995e7433abec6ff67a034857eae`（`fix: add browser-assisted Douyin QR login and cookie verification`）。
- 未 Push、未合并 main、未 Tag、未 Release。
