# 2026-11-15 · 抖音扫码登录重复浏览器窗口修复

## 现象

开发者已确认真实扫码登录、官方身份验证、会话验证与礼物数据均正常；唯一问题是点击一次
「扫码登录（浏览器）」打开两个独立浏览器窗口，两个都是抖音登录页。关闭其中一个后另一个仍可完成登录。

## 调查与根因

### 代码调用链

`/api/douyin/login/browser/start` → `DouyinService.startBrowserLogin()` → `DouyinBrowserLogin.start()`
→ `#startOnce()` → `#prepareProfile()` → `#findExistingBrowser()` / `#launchBrowser()` → `#connectCdp()`
→ `#run()`。

### 决定性证据（真实 EXE 单次点击）

2026-11-15 16:05:34 的真实 EXE 日志：

```text
douyin.login.browser.direct_failed {"direct":"spawned","directExit":"0/null"} portFile=false
douyin.login.browser.launch {"browser":"Chrome","kind":"powershell"}
douyin.login.browser.target {"targetId":"7D1D58BB...","url":"https://www.douyin.com/login_page?..."}
```

直接 `child_process.spawn` 从提权 SEA 进程启动 Chrome 后立即退出（code 0）、没有写 `DevToolsActivePort`；
随后 PowerShell `Start-Process` 又启动一次。直接启动可能已经开出一个不受 CDP 管理的窗口，PowerShell
再开一个 → 两个独立窗口。进程树显示 Chrome 父进程是已退出的 PowerShell，专用 Profile 中
`DevToolsActivePort`/`browser.pid` 均缺失，也解释了为什么失败后无法 kill/复用。

### 并发风险（已复现）

修复前 `start()` 的并发判断是：

```js
if (ACTIVE_STATES.has(this.state) && this.running) return this.status();
```

但 `this.running` 在 `#connectCdp()` 之后才赋值。`opening` 期间第二次调用看到 `running === null`，
会再次 `#resetState()` 并再次 `#launchBrowser()`。真实复现：`Promise.all([flow.start(), flow.start()])`
在修复前产生两个窗口；修复后 1 个。

### 孤儿与复用缺口

直接 spawn 路径不写 `browser.pid`；失败/取消拿不到 PID 时无法 `taskkill`，Chrome 成为孤儿。下次启动
没有 `DevToolsActivePort`/`browser.pid`，无法复用，直接启动 handoff/开窗，PowerShell 再开一个。

### 排除项

用真实 Chrome 154 + CDP `Browser.getWindowForTarget` 测量：

- 干净 Profile：旧参数（`--new-window` + URL）、仅 URL、仅 `--new-window` 都是 1 target / 1 window。
- 同一 Profile 连续启动两次：每次 1 target / 1 window。
- 未同时启动 Chrome 与 Edge；未复现 Profile 恢复旧窗口导致双窗口。

因此单一参数/Profile 恢复/双浏览器不是唯一原因；实际原因是**直接 spawn 退出 0 + PowerShell 回退**，
并发与孤儿问题会放大它。

## 修复

- **Windows 只启动一次**：不再先直接 spawn 再回退；Windows 直接使用一次 PowerShell `Start-Process`
  打开官方登录页。非 Windows 开发路径保留直接 spawn。
- **启动前清理专用 Profile 的孤儿 Chrome**：只匹配命令行中包含 LiveMemory 专用 Profile 的进程，
  绝不动用户日常 Chrome/Edge。
- `start()` 使用同步 `this.startPromise`：初始化期间第二次调用直接返回当前状态并 `Page.bringToFront`
  聚焦已有窗口，不重新启动。
- 启动后立即记录 `browser.pid`；即使等待端口失败，`#closeBrowser()` 也能关闭该实例；PID 缺失时按
  Profile 命令行清理。
- `#findExistingBrowser()` 复用同一专用 Profile 的窗口（同 port/PID）。
- 移除 `--new-window`：官方 URL 在干净 Profile 中本身只有 1 个窗口。
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
- 全量 **947 passed / 0 failed / 0 skipped（292,737 ms，2026-11-15）**。

### EXE

- Build ID `d37c8f262dc4`；commit `75c574c`；SHA-256 `c3b1fa8b…`；`97,591,296` B；requireAdministrator。
- `verify-exe` **10/10**；`verify-douyin-exe` **25/27**。
- 2 项失败仍是 EXE 内浏览器启动被 DSH 作业对象终止（Chrome `0x80000003`、PowerShell 无端口），
  与本轮修复无关；EXE 内窗口数量需普通 Windows 桌面人工验收。
- 真实 Chrome 窗口计数在模块级 12/12。

## 未验证

- EXE 内实际窗口数量（沙箱限制；模块级已用真实 Chrome 验证）。
- 开发者桌面双击 EXE 后的真实窗口计数与扫码成功复验。
- 其他平台回归由全量测试与 `verify-exe` 覆盖；本轮未改 Twitch/Bilibili/YouTube 代码。

## 提交

- `75c574c0ec1824603559de88b37669466abd33ff`（`fix: prevent duplicate Douyin login browser windows`）。
- 未 Push、未合并 main、未 Tag、未 Release。
