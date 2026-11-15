# 抖音扫码登录重复浏览器窗口修复验收（DOUYIN-SINGLE-WINDOW）

日期：2026-11-15（Asia/Shanghai）
分支：`feature/douyin`
代码提交：`db0dcb1f79fc60590a7ea3ceb4340ca1c502be7c`
状态：**等待开发者人工验收；未合并 main、未 Push、未 Tag、未 Release。**

## 1. 现象

开发者真实人工验收反馈：点击一次「扫码登录（浏览器）」会打开**两个完全独立的浏览器窗口**，
两个都是抖音登录页；关闭其中一个，在另一个完成扫码和官方身份验证后，LiveMemory 登录与礼物数据正常。

本轮只修复重复窗口，不改变已经成功的扫码、官方验证、会话验证、加密保存、Cookie 备用与礼物采集机制。

## 2. 根因

### 2.1 主因：`start()` 的并发锁设置得太晚

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

`this.running` 只在 CDP 握手完成后赋值。在 `opening` 期间（可能持续数秒），第二次 `start()` 看到
`this.running === null`，于是重新 `#resetState()` 并再次 `#launchBrowser()`。两次调用各自启动一个
Chrome 进程/窗口，两个窗口都指向官方登录页。

真实复现：`Promise.all([flow.start(), flow.start()])`（等价于快速双击或两个并发登录请求）
在修复前产生两个独立窗口；修复后同一调用只产生 **1 个 target / 1 个 window**。

前端虽然会 `button.disabled = true`，但浏览器双击事件、重复请求或页面重渲染都可能让两个请求到达后端；
后端必须有同步的并发锁，不能依赖按钮状态。

### 2.2 次因：Chrome 慢启动时的 PowerShell 回退

修复前 `#launchBrowser()` 直接 `spawn` Chrome 后只等 12 秒。若 Chrome 进程仍活着、但
`DevToolsActivePort` 因冷启动/杀毒扫描尚未写出，代码会 `kill` 它并再用 PowerShell `Start-Process`
启动第二次；用户会看到两个窗口。

现在：直接子进程仍存活时再等 20 秒；**绝不在直接进程存活时启动第二个浏览器**；只有确认直接进程已退出
（或 spawn 失败）才使用 PowerShell 回退。若 32 秒仍无 DevTools，报 `browser_no_devtools` 并关闭该实例，
不启动第二个。

### 2.3 复用缺口：直接 spawn 未写 PID 文件

`#findExistingBrowser()` 需要 `DevToolsActivePort` + `browser.pid` 才能确认窗口属于 LiveMemory。
直接 `spawn` 路径只把 PID 放在内存、没有写文件，所以应用重启/崩溃后无法复用旧窗口，可能再开一个。
现在直接 spawn 也写 `browser.pid`；已有窗口通过同一端口/PID 复用，并 `Page.bringToFront` 聚焦。

### 2.4 已排除的原因

用真实 Chrome 154 与 CDP `Browser.getWindowForTarget` 逐个计数：

| 场景 | 结果 |
| --- | --- |
| 干净 Profile，当前参数（含 `--new-window` + URL） | 1 target / 1 window |
| 干净 Profile，仅 URL | 1 target / 1 window |
| 干净 Profile，仅 `--new-window` | 1 target / 1 window |
| 同一 Profile 连续启动两次 | 每次 1 target / 1 window |
| Chrome + Edge 同时启动 | 未发生；只选择一个浏览器 |
| Profile 恢复旧窗口 | 未复现；同一 Profile 两次启动仍各 1 窗口 |

因此 `--new-window`、Profile 恢复、双浏览器不是本问题的主因；主因是并发 `start()` 与慢启动回退。

## 3. 修复

- `start()` 增加同步 `this.startPromise` 锁：初始化期间的第二次调用立即返回当前状态，并调用
  `Page.bringToFront` 聚焦已有窗口；不会重新初始化或启动浏览器。
- `#startOnce()` 保留原扫码流程；`this.running` 仍按原逻辑启动轮询。
- `#launchBrowser()`：直接进程存活时等待同一进程，绝不并行启动 PowerShell 回退。
- 直接 spawn 写 `browser.pid`；`#findExistingBrowser()` 复用专用 Profile 的现有窗口（同端口/PID）。
- `#closeBrowser()` 统一串行化，清理 `DevToolsActivePort`、`browser.pid` 与启动错误文件；只管理
  带 `.livememory-owned` 标记的专用 Profile。
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
- 全量：**947 passed / 0 failed / 0 skipped（253,845 ms，2026-11-15）**。

### 4.3 Windows EXE

| 项目 | 值 |
| --- | --- |
| 完整路径 | `D:\LiveMemory\dist\LiveMemory.exe` |
| 大小 | `97,589,760` bytes |
| SHA-256 | `a67163e3d3f2e116173ee067949b73adae34bd57a8bdd0409aec27cb9d372cc4` |
| Build ID | `6a65b07dbf08` |
| source hash | `6a65b07dbf0898b2d9b2fc74ea788abebd8c18c398fe27f8e8bd89ea97365923` |
| commit | `db0dcb1f79fc60590a7ea3ceb4340ca1c502be7c` |
| builtAt | `2026-11-15T08:00:17.430Z` |
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
