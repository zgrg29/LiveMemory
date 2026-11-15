# 2026-11-15 · 抖音扫码登录重复浏览器窗口修复

## 现象

开发者已确认真实扫码登录、官方身份验证、会话验证与礼物数据均正常；唯一问题是点击一次
「扫码登录（浏览器）」打开两个独立浏览器窗口，两个都是抖音登录页。关闭其中一个后另一个仍可完成登录。

## 调查与根因

### 代码调用链

`/api/douyin/login/browser/start` → `DouyinService.startBrowserLogin()` → `DouyinBrowserLogin.start()`
→ `#startOnce()` → `#prepareProfile()` → `#findExistingBrowser()` / `#launchBrowser()` → `#connectCdp()`
→ `#run()`。

修复前 `start()` 的并发判断是：

```js
if (ACTIVE_STATES.has(this.state) && this.running) return this.status();
```

但 `this.running` 在 `#connectCdp()` 之后才赋值。`opening` 期间第二次调用看到 `running === null`，
于是再次 `#resetState()` 并再次 `#launchBrowser()`。真实复现：并发 `Promise.all([flow.start(), flow.start()])`
会启动两个浏览器窗口；这正是用户看到的两个独立窗口。

### 次因

1. `#launchBrowser()` 直接 spawn 后仅等 12 秒；若 Chrome 仍活着但 `DevToolsActivePort` 未写出，
   代码 kill 后启动 PowerShell 回退 → 第二个窗口。
2. 直接 spawn 路径没有写 `browser.pid`；`#findExistingBrowser()` 无法复用上次专用窗口，应用重启后
   再次启动可能多开一个。
3. 前端没有 in-flight 标志，依赖按钮 disabled；双击/重渲染仍可能发两次请求。

### 排除项

用真实 Chrome 154 + CDP `Browser.getWindowForTarget` 测量：

- 干净 Profile：当前参数（`--new-window` + URL）、仅 URL、仅 `--new-window` 都是 1 target / 1 window。
- 同一 Profile 连续启动两次：每次 1 target / 1 window。
- 未同时启动 Chrome 与 Edge；未复现 Profile 恢复旧窗口导致双窗口。

因此不是启动参数、Profile 恢复或双浏览器；是应用层并发启动与慢启动回退。

## 修复

- `start()` 使用同步 `this.startPromise`：初始化期间第二次调用直接返回当前状态并 `Page.bringToFront`
  聚焦已有窗口，不重新启动。
- `#launchBrowser()`：直接子进程存活时继续等待同一进程（12s + 20s），绝不启动 PowerShell 回退；
  只有直接进程确认退出或 spawn 失败才回退。若仍无 DevTools，报 `browser_no_devtools` 并关闭，不开第二个。
- 直接 spawn 写 `browser.pid`；`#findExistingBrowser()` 复用同一专用 Profile 的窗口（同 port/PID）。
- `#closeBrowser()` 串行化并清理 `DevToolsActivePort`/`browser.pid`；只管理带 `.livememory-owned` 的 Profile。
- 前端新增 `douyinBrowserStarting` 防止重复请求。
- 日志只含 event/浏览器/PID/target ID，不含 Cookie/sessionid/token。

未修改：扫码 URL、官方验证、`sessionid` 捕获与验证、AES-256-GCM 保存、Cookie 备用、礼物解析/四级状态、三语 UI。

## 验证

### 真实 Chrome 窗口计数

`node scripts/verify-douyin-browser-login.mjs`（专用测试 Profile，不扫码）：

- 单次点击：1 target / 1 window。
- 已打开时再次点击：0 次新 launch、1 个窗口、focus +1。
- 快速双击（并发 start）：1 次 launch、1 target / 1 window。
- 第二个 LiveMemory 侧流程：`kind=reuse`、同 port、1 个窗口。
- 取消/清理：窗口关闭、Profile 可删除。
- **12/12**。

### 自动化

- `douyin-browser-login` 新增：并发 start 只 1 次 launch、活动窗口只 focus、取消后重新 start 1 次。
- 全量 **947 passed / 0 failed / 0 skipped（253,845 ms，2026-11-15）**。

### EXE

- Build ID `6a65b07dbf08`；commit `db0dcb1`；SHA-256 `a67163e3…`；`97,589,760` B；requireAdministrator。
- `verify-exe` **10/10**；`verify-douyin-exe` **25/27**。
- 2 项失败仍是 EXE 内浏览器启动被 DSH 作业对象终止（Chrome `0x80000003`、PowerShell 无端口），
  与本轮修复无关；EXE 内窗口数量需普通 Windows 桌面人工验收。
- 真实 Chrome 窗口计数在模块级 12/12。

## 未验证

- EXE 内实际窗口数量（沙箱限制；模块级已用真实 Chrome 验证）。
- 开发者桌面双击 EXE 后的真实窗口计数与扫码成功复验。
- 其他平台回归由全量测试与 `verify-exe` 覆盖；本轮未改 Twitch/Bilibili/YouTube 代码。

## 提交

- `db0dcb1f79fc60590a7ea3ceb4340ca1c502be7c`（`fix: prevent duplicate Douyin login browser windows`）。
- 未 Push、未合并 main、未 Tag、未 Release。
