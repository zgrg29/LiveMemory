# 抖音 M2–M3 登录修复验收报告（DOUYIN-LOGIN-FIX）

日期：2026-11-15（Asia/Shanghai）
分支：`feature/douyin`
代码提交：`6f7f0d65fd95838e489a0021180ea66e87dfd26e`
状态：**等待开发者人工验收；未合并 main、未 Push、未 Tag、未 Release。**

## 1. 本轮目标与结论

目标：不再把「风控阻止扫码」当作终点；优先实现普通用户可用的浏览器扫码登录，保留并完善 Cookie 备用方案，
并把「扫码成功 / 会话有效 / 采集连接 / 真实礼物」四件事分开。

结论：

1. **纯 HTTP 扫码不可行**：官方 SSO 返回设备指纹 HTML；passport 返回 `error_code 4031`。这不是「抖音禁止扫码」，
   而是平台拒绝非浏览器客户端。LiveMemory 不伪造指纹、`a_bogus`、`msToken`，不求解验证码。
2. **真实浏览器扫码可行**：本机 Chrome/Edge 打开官方登录页后，官网自己成功取得二维码
   （`error_code=0`、PNG base64、`is_frontier=true`、约 60 秒有效）。本轮已实现并在应用内显示二维码。
3. **真实手机扫码未执行**：没有可用账号/手机；不能给出成功率，也不能写成成功或失败。
4. **Cookie 验证已分级**：格式/不完整/过期/平台拒绝/网络/无效；只有平台确认才显示「已登录（已验证）」。
5. **礼物未观测**：匿名连接真实直播间没有礼物；登录后的礼物推送无法在本轮验证。

## 2. 失败请求证据

| 请求 | 实际结果 |
| --- | --- |
| `sso.douyin.com/get_qrcode` | HTTP 200 `text/html` 9,938 B，设备指纹 challenge，无 JSON/二维码 |
| `www.douyin.com/passport/web/get_qrcode` | HTTP 200 JSON `{"data":{"error_code":4031,"description":"您正在尝试访问的网站存在安全风险…已阻止此次访问。"}}` |
| `live.douyin.com/passport/web/get_qrcode` | 同上 `4031` |
| `www.douyin.com/aweme/v1/web/user/profile/self/`（无 Cookie） | `status_code=8`、`status_msg=用户未登录` |

真实 Chrome 打开 `www.douyin.com/login_page` 后，官网请求同一 `get_qrcode` 得到
`error_code=0`、`qrcode` PNG、`is_frontier=true`、`expire_time`。差异在浏览器运行时与设备信号。

## 3. 实现内容

- `src/platforms/douyin/browser-login.mjs`：本机 Chrome/Edge + 专用资料目录 + CDP；捕获官方二维码；
  等待 `sessionid`；页面内 `/user/profile/self/` 验证；取消/关闭/清理；无 headless/no-sandbox/stealth。
- `src/platforms/douyin/login.mjs`：Cookie 诊断、验证状态、`saved_unverified`、退出。
- `src/platforms/douyin/cookie-store.mjs`：AES-256-GCM，保存 `verified/verifiedAt/reason`，状态不返回 Cookie。
- `src/platforms/douyin/service.mjs`：登录生命周期、四级状态（扫码/会话/连接/礼物）、退出清理。
- `src/server/{index,routes}.mjs`：`/api/douyin/login/browser/start|status|cancel`、`check|cookie|logout`；
  关闭应用时关闭浏览器；所有路由仍需本地会话认证。
- `src/web/js/pages/live.js` + 三语 i18n：状态胶囊、扫码/取消/验证/删除、12 步 Cookie 教程、四级礼物卡片。
- `scripts/verify-douyin-browser-login.mjs`：真实浏览器二维码捕获验证（不扫码）。
- `docs/DOUYIN_LOGIN_RESEARCH.md`：5 个项目的源码/许可证/可行性调查。

## 4. 自动化测试

| 项目 | 结果 |
| --- | --- |
| 全量（`--test-isolation=none`） | **944 passed / 0 failed / 0 skipped（298,824 ms，最终复跑）** |
| 新增/更新 | 浏览器登录 10、登录/Cookie 14、服务 3、礼物阶梯 1、UI/三语断言更新；API 认证新增 6 个路由 401 |
| API 认证复跑 | **14/14** |

## 5. 真实浏览器验证（未扫码）

`node scripts/verify-douyin-browser-login.mjs`，真实 Chrome 157，专用资料目录：

| 检查 | 结果 |
| --- | --- |
| 检测浏览器 | PASS（Chrome） |
| 打开流程不声称登录 | PASS（`waiting`） |
| 捕获官方二维码 | PASS（PNG base64，约 54 秒有效，`frontier=true`） |
| 状态不含 Cookie/token | PASS |
| 取消/移除二维码 | PASS |
| 删除专用资料目录 | PASS |
| 无浏览器回退 | PASS |
| **合计** | **8/8** |

**扫码：0 次。** 二维码已证明能由官方页生成并在应用内显示；真实手机确认与后续 `is_frontier` 验证需要人工完成。

## 6. Windows EXE

| 项目 | 值 |
| --- | --- |
| 完整路径 | `D:\LiveMemory\dist\LiveMemory.exe` |
| 大小 | `97,584,640` bytes（93.1 MB） |
| SHA-256 | `48cc12274c6c4e0b3d5e7a10e1c6766db8fb8f49f74c8a8f8ad7e2ae025aa699` |
| Build ID | `a0bc7f9136df` |
| source hash | `a0bc7f9136df8aebf9ddeb16f64bd334780a1a55487f3ed4cba824b16467c362` |
| commit | `6f7f0d65fd95838e489a0021180ea66e87dfd26e` |
| builtAt | `2026-11-15T05:59:01.388Z` |
| RT_MANIFEST | `requireAdministrator` |

### 6.1 EXE 验证矩阵

| 脚本 | 结果 |
| --- | --- |
| `verify-douyin-exe.mjs` | **25/27** |
| `verify-exe.mjs` | **10/10** |
| `verify-twitch-exe.mjs` | **20/20** |
| Bilibili / YouTube / Twitch status | 均 200 |
| `verify-douyin-browser-login.mjs`（模块级真实 Chrome） | **8/8** |

### 6.2 两个失败项：EXE 内浏览器启动被沙箱阻止

`verify-douyin-exe.mjs` 的两个失败项是：

1. `the packaged EXE opens the official Douyin QR login in a real browser`
2. `the browser login can be cancelled and the QR removed`

证据（EXE 日志）：

```text
douyin.login.browser.selected browser=Chrome path=C:\Program Files\Google\Chrome\Application\chrome.exe
douyin.login.browser.direct_failed diagnostics={"direct":"spawned","directExit":"2147483651/null"} portFile=false
douyin.login.browser.powershell_no_port ...
douyin.login.browser.powershell_failed reason=browser_did_not_start
```

`2147483651` = `0x80000003`。同一 `DouyinBrowserLogin` 在普通 Node 顶层进程里用真实 Chrome 8/8；
EXE 作为 DSH 作业对象的子进程时，Chrome 子进程被作业对象终止（PowerShell `Start-Process` 回退也无端口）。
这不是普通 Windows 用户环境的结论，也不能据此写成「EXE 扫码已验证」。需要开发者在普通桌面双击 EXE 人工验收。

其余 EXE 项通过：启动/Build ID、匿名真实抖音采集（聊天/昵称/`douyin:<id>`/消息 ID/正文）、停止、SQLite、
重启持久化、AI 读取、观众读模型、30 天保留、Bilibili/YouTube/Twitch 状态、Cookie 格式/不完整/假会话拒绝、
退出清除、教程资源。运行日志：`tests/.tmp/verify-douyin-exe-login5.log`。

## 7. Cookie 教程（三语，12 步）

位于 Cookie 输入框下方，可展开：

1. 打开 Chrome/Edge；2. 访问 `https://live.douyin.com/`；3. 用抖音账号登录（扫码/官方验证）；
4. F12；5. Network；6. F5；7. 选 `live.douyin.com` 请求；8. Headers；9. Request Headers；
10. 找到 Cookie；11. 复制完整值；12. 回 LiveMemory 粘贴并「保存并验证」。

另含 Firefox 差异、找不到 Cookie 的排查、无痕窗口提醒、AES-256-GCM 本地保护与删除入口。
三语键集由 `tests/unit/i18n.test.mjs` 与 `tests/unit/douyin-ui.test.mjs` 校验。

## 8. 人工验收步骤

1. 完全退出旧版 LiveMemory；双击 `D:\LiveMemory\dist\LiveMemory.exe`，确认 UAC。
2. 进入「直播」→「抖音」，确认登录状态为「未登录」、教程可展开、三语可切换。
3. 点击「扫码登录（浏览器）」：应打开 Chrome/Edge 官方抖音登录页，同时应用内出现同一二维码。
4. 用抖音 App 扫码并在手机确认；若浏览器要求验证码/身份验证，在官方页面完成。
5. 成功时应显示「已登录（已验证）」；若只显示「浏览器登录完成，但会话尚未验证」，点击「验证登录」。
6. 点击「删除 Cookie / 退出登录」，确认状态回到未登录；检查 `secrets/` 与
   `runtime/douyin-browser-profile/` 是否清理。
7. 连接真实直播间，查看「登录与礼物验证」四级状态；只有真实礼物事件出现才标「已观测」。
8. 若不使用扫码：按 12 步教程导入 Cookie，点击「保存并验证」；确认「登录有效」后再测礼物。

## 9. 未验证 / 不得宣称

- 真实手机扫码成功与扫码成功率（本轮 0 次）。
- 真实 Cookie 正向验证（需要账号）。
- 登录后的礼物推送、真实礼物/连送/付费留言（匿名 0 条，标未观测）。
- EXE 内浏览器启动（沙箱限制；模块级真实 Chrome 已 8/8）。
- 干净 Windows 电脑、无 Chrome/Edge、非管理员账户、真实 UAC 点击。
- 平台页面/接口改版后的稳定性。
