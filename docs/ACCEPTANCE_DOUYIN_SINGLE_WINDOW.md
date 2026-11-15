# 抖音扫码登录重复浏览器窗口修复验收（DOUYIN-SINGLE-WINDOW）

日期：2026-11-15（Asia/Shanghai）
分支：`feature/douyin`
代码提交：`75c574c0ec1824603559de88b37669466abd33ff`
状态：**等待开发者人工验收；未合并 main、未 Push、未 Tag、未 Release。**

## 1. 现象

开发者真实人工验收反馈：点击一次「扫码登录（浏览器）」会打开**两个完全独立的浏览器窗口**，
两个都是抖音登录页；关闭其中一个，在另一个完成扫码和官方身份验证后，LiveMemory 登录与礼物数据正常。

本轮只修复重复窗口，不改变已经成功的扫码、官方验证、会话验证、加密保存、Cookie 备用与礼物采集机制。

## 2. 根因

### 2.1 决定性证据：真实 EXE 单次点击日志

2026-11-15 16:05:34（本机时间）真实 EXE（上一构建 `6a65b07dbf08`）的日志：

```text
douyin.login.browser.direct_failed {"direct":"spawned","directExit":"0/null"} portFile=false
douyin.login.browser.launch {"browser":"Chrome","kind":"powershell"}
douyin.login.browser.target {"targetId":"7D1D58BB...","url":"https://www.douyin.com/login_page?..."}
douyin.login.browser.state {"from":"opening","to":"waiting"}
douyin.login.browser.qr {"hasImage":true,"hasUrl":true,"frontier":true}
```

结论：**直接 `child_process.spawn` Chrome 立即以 0 退出、没有写 `DevToolsActivePort`；随后 PowerShell
`Start-Process` 又启动了一次。** 直接启动的 Chrome 已可能开出一个不受 CDP 管理的窗口，PowerShell 再开一个，
形成两个独立窗口。进程树也显示 Chrome 的父进程是已退出的 PowerShell（不是 LiveMemory 直接子进程），
专用 Profile 中 `DevToolsActivePort` / `browser.pid` 均缺失。

这是单次点击出现双窗口的实际原因，也是本轮修复的重点。

### 2.2 并发 `start()` 锁设置得太晚（已真实复现）

修复前代码：

```js
async start() {
  if (ACTIVE_STATES.has(this.state) && this.running) return this.status();
  ...
  this.#setState(OPENING);
  await this.#prepareProfile();
  await this.#launchBrowser();   // 第二个浏览器在这里启动
  await this.#connectCdp();      // this.running 直到这之后才赋值
  this.running = this.#run()...
}
```

`this.running` 只在 CDP 握手完成后赋值。`opening` 期间第二次 `start()` 看到 `running === null`，
会重新初始化并再次启动浏览器。真实复现：`Promise.all([flow.start(), flow.start()])` 在修复前产生两个
独立窗口；修复后只产生 1 个 target / 1 个 window。

### 2.3 孤儿与复用缺口

直接 `spawn` 路径没有写 `browser.pid`；失败/取消时若拿不到 PID，`#closeBrowser()` 无法 `taskkill`，
Chrome 会作为孤儿继续运行。下次启动时没有 `DevToolsActivePort`/`browser.pid`，`#findExistingBrowser()`
无法复用，直接启动又会 handoff/开窗，PowerShell 再开一个。

现场检查：专用 Profile 中确实没有 `DevToolsActivePort`/`browser.pid`，而 Chrome 主进程仍在运行，
父进程是已退出的 PowerShell。这解释了为什么关闭窗口后仍可能残留进程并影响下一次启动。

### 2.4 已排除的原因

用真实 Chrome 154 与 CDP `Browser.getWindowForTarget` 逐个计数：

| 场景 | 结果 |
| --- | --- |
| 干净 Profile，旧参数（`--new-window` + URL） | 1 target / 1 window |
| 干净 Profile，仅 URL | 1 target / 1 window |
| 干净 Profile，仅 `--new-window` | 1 target / 1 window |
| 同一 Profile 连续启动两次 | 每次 1 target / 1 window |
| Chrome + Edge 同时启动 | 未发生；只选择一个浏览器 |
| Profile 恢复旧窗口 | 未复现；同一 Profile 两次启动仍各 1 窗口 |

因此单一启动参数、Profile 恢复、双浏览器不是唯一原因；真实原因是**直接 spawn 退出 0 + PowerShell 回退**
以及并发/孤儿问题。修复中仍移除了不必要的 `--new-window`，降低再次 handoff 时多开窗口的风险。

## 3. 修复

- **Windows 只启动一次**：不再先直接 `spawn` 再回退；Windows 上直接使用一次 PowerShell `Start-Process`
  启动官方登录页。非 Windows 开发路径保留直接 spawn。
- **启动前清理专用 Profile 的孤儿 Chrome**：只匹配命令行中包含 LiveMemory 专用 Profile 路径的
  `chrome.exe`，绝不匹配用户日常 Chrome/Edge。
- `start()` 增加同步 `this.startPromise` 锁：初始化期间的第二次调用立即返回当前状态，并调用
  `Page.bringToFront` 聚焦已有窗口；不会重新初始化或启动浏览器。
- `#launchBrowser()` 启动后立即记录 `browser.pid`；即使等待端口失败，`#closeBrowser()` 也能关闭该实例。
- 直接/失败路径统一写 `browser.pid`；`#findExistingBrowser()` 复用专用 Profile 的现有窗口（同端口/PID）。
- `#closeBrowser()` 串行化；若 PID 缺失或进程仍存活，再按专用 Profile 命令行清理；清理
  `DevToolsActivePort`/`browser.pid`/启动错误文件。
- 移除 `--new-window`：官方 URL 在干净 Profile 中本身就是 1 个窗口。
- 前端增加 `douyinBrowserStarting`，防止同一页面重复发请求。
- 日志只记录 `event`、浏览器名称、PID、target ID、窗口状态；**不记录 Cookie、sessionid 或 token**。

没有修改：扫码 URL、官方身份验证流程、`sessionid` 捕获、`saveBrowserCookie` 验证、AES-256-GCM 存储、
Cookie 备用入口、礼物解析/四级状态、三语 UI 文案。

## 4. 验证

### 4.1 真实 Chrome 窗口计数（非模拟）

`node scripts/verify-douyin-browser-login.mjs`（Chrome 154，专用测试 Profile，不扫码）：

| 检查 | 结果 |
| --- | --- |
| 单次点击 | 1 target / 1 window |
| 登录已打开时再次点击 | 0 次新 launch，1 个窗口，focus +1 |
| 快速双击（并发 `start()`） | 1 次 launch，1 target / 1 window |
| 新建第二个 LiveMemory 侧流程 | `kind=reuse`，同一 port，1 个窗口 |
| 取消/清理 | 窗口关闭、Profile 可删除 |
| **合计** | **12/12** |

真实日志示例（无凭据）：

```text
douyin.login.browser.launch {"browser":"Chrome","kind":"spawn"}
douyin.login.browser.target {"targetId":"647A...","url":"https://www.douyin.com/login_page?..."}
douyin.login.browser.reuse {"port":54824,"pid":13528}
```

### 4.2 自动化

- 新增 3 项浏览器登录测试：并发 `start()` 只启动 1 次、活动窗口只聚焦不新建、取消后重新启动 1 次。
- 全量：**947 passed / 0 failed / 0 skipped（292,737 ms，2026-11-15）**。

### 4.3 Windows EXE

| 项目 | 值 |
| --- | --- |
| 完整路径 | `D:\LiveMemory\dist\LiveMemory.exe` |
| 大小 | `97,591,296` bytes |
| SHA-256 | `c3b1fa8b95603826ebcd98e0ecf8fa92fcccdcc9626e0483ddb06b04f67b6315` |
| Build ID | `d37c8f262dc4` |
| source hash | `d37c8f262dc4ed6dd9d678c50ca051f811ac0bfecc2ba1a5add440c267253f36` |
| commit | `75c574c0ec1824603559de88b37669466abd33ff` |
| builtAt | `2026-11-15T09:45:00.851Z` |
| RT_MANIFEST | `requireAdministrator` |

- `verify-exe`：**10/10**（启动/重启/硬杀恢复/端口顺延/单实例/不可写目录/异目录/解压复用/CLI）。
- `verify-douyin-exe`：**25/27**；2 项仍是 EXE 内浏览器启动被 DSH 作业对象阻止
  （Chrome 子进程 `0x80000003`、PowerShell 回退无端口），其余登录状态/Cookie/教程/匿名采集/重启/AI 通过。
- 真实 Chrome 窗口计数在模块级 **12/12**；**EXE 内窗口数量无法在当前 DSH 沙箱自动验证**，
  因为 EXE 子进程中的 Chrome 被作业对象终止。必须在普通 Windows 桌面人工双击 EXE 验证。

## 5. 人工验收步骤

1. 完全退出旧版 LiveMemory；双击 `D:\LiveMemory\dist\LiveMemory.exe`，确认 UAC。
2. 进入「直播」→「抖音」，点击一次「扫码登录（浏览器）」。
3. 确认只出现 **1 个** Chrome/Edge 窗口，且是抖音官方登录页；应用内也应显示同一二维码。
4. 再快速点击一次按钮：不应再出现新窗口；已有窗口应被聚焦/置前。
5. 扫码并在官方页面完成验证；确认「已登录（已验证）」与礼物数据仍正常。
6. 关闭浏览器窗口后再次点击登录：应能重新打开 1 个窗口并重新扫码。
7. 点击「删除 Cookie / 退出登录」：确认回到未登录，且专用浏览器 Profile 被清理。
8. 若仍出现两个窗口，请记录两个窗口的 PID/Parent PID、启动参数与 CDP Target ID，交回开发者继续排查。

## 6. 不得宣称

- 未改变已成功的扫码/官方验证/Cookie 加密/礼物采集逻辑。
- EXE 内窗口数量尚未在普通桌面人工验证；本轮真实窗口计数来自同一模块 + 真实 Chrome。
- 真实手机扫码仍需开发者按上述步骤验收。
