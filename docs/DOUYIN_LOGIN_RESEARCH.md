# 抖音扫码登录技术调查（2026-11-15）

本轮目标：先判断「抖音扫码登录是否真的不可行」，再决定是否继续使用纯 HTTP 扫码、
本机浏览器扫码或手动 Cookie。调查对象是开发者指定的 5 个公开项目，**逐项阅读了实际登录源码**，
不是只看 README。随后在本机用真实 Chrome/Edge 与抖音官方页面做了只读验证。

> 结论先说：**扫码登录本身可行，但必须由真实浏览器执行官方页面。**
> LiveMemory 旧实现用 Node 直接请求 SSO/passport 接口，必然被设备指纹/风控拒绝；
> 本轮改为「本机 Chrome/Edge + 专用配置目录 + 官方登录页 + 应用内显示同一二维码」，
> 不绕过验证码、风控或访问控制。真实手机扫码仍需人工完成，本轮没有账号，因此
> **未执行真实扫码**；二维码捕获、取消、资料目录清理已用真实浏览器验证 **8/8**。

## 1. 为什么旧实现失败（本机实测证据）

2026-11-15 13:53（Asia/Shanghai），同一台机器、普通桌面 UA、无 Cookie、只读请求：

| 请求 | 结果 |
| --- | --- |
| `GET https://sso.douyin.com/get_qrcode/?aid=6383&service=https%3A%2F%2Flive.douyin.com` | HTTP 200，`text/html`，9,938 B，返回的是设备指纹/风控 JS，**不是 JSON，也没有二维码** |
| `GET https://www.douyin.com/passport/web/get_qrcode/?aid=6383&service=...` | HTTP 200，`application/json`，`{"data":{"error_code":4031,"description":"您正在尝试访问的网站存在安全风险，为保护您的抖音账号安全与隐私，已阻止此次访问。"}}` |
| `GET https://live.douyin.com/passport/web/get_qrcode/?...` | 同上，`error_code 4031` |
| `GET https://www.douyin.com/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383`（无 Cookie） | HTTP 200，`status_code: 8`，`status_msg: 用户未登录` |

这说明：

1. 平台不是「永久禁止扫码」，而是**拒绝非浏览器客户端**。SSO 端点要求真实浏览器执行
   `bd_ticket_guard`、`msToken`、`a_bogus`、设备指纹等 JS 流程；passport 端点直接返回
   「安全风险，已阻止访问」。
2. 继续在 Node 里伪造这些字段、执行/绕过 challenge，属于绕过访问控制；本轮明确不做。
3. 因此正确方向不是「换一个 HTTP 参数」，而是**把官方登录页放进真实浏览器**。

## 2. 五个项目的实际登录实现

| 项目 | 许可证 | 技术栈 | 实际登录方式（源码核对） | 真实扫码？ | Windows | Node/SEA 集成 | 结论 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [VideoNote-MCP](https://github.com/HuangYincan/VideoNote-MCP) | **MIT** | Python + Playwright | `app/downloaders/douyin_browser.py`：用本机 Chrome/Edge（`channel: chrome/msedge`，非 headless）打开 `www.douyin.com/login_page`，拦截官网自己的 `get_qrcode` JSON，显示二维码；轮询官网请求；等待官网写入 `sessionid`；`2046` 时交还浏览器做人工验证 | **是**（官方页面内） | 是 | Playwright 不适合 SEA，但「专用浏览器 + CDP + 官方页面」架构可移植 | **架构最接近本轮方案**；MIT 允许参考，但本实现为原创 Node CDP，未复制代码 |
| [douyin-mcp](https://github.com/liaogx/douyin-mcp) | **PolyForm Noncommercial 1.0.0** | Go + go-rod（CDP） | `douyin/login.go` + `browser/browser.go`：启动专用 `browser-profile`，打开 `creator.douyin.com`，点击登录并截取二维码；从 CDP 读取 Cookie；`Reset` 时删除专用资料目录 | **是**（专用浏览器） | 是 | Go 二进制，不能直接嵌入 Node | 工程细节最完整；**非商业许可证，不能整合/复制** |
| [douyin-parse](https://github.com/coderlife-book/douyin-parse) | **无 LICENSE（保留所有权利）** | Python + FastAPI + Playwright | `services/douyin_login.py`：headful Chromium 打开 `www.douyin.com/user/self`，点击「扫码登录」，截图二维码，轮询 Cookie，成功后把 Cookie **明文**写入配置 JSON | **是**（官方页面） | 是（便携包） | Playwright 重；明文存储不符合本项目安全要求 | 可证明可行；**无许可证，不能复制** |
| [dousub](https://github.com/debiaoyu/dousub) | **无 LICENSE（保留所有权利）** | Python + Playwright | `dousub/core/browser.py`：`qr_login_async` 打开抖音首页，点击登录/扫码，保存二维码 PNG，轮询 `context.cookies()`；其失败提示明确写出「抖音检测到自动化行为，触发滑块验证码」等可能原因 | **是**（官方页面） | 是 | 同 Playwright | 可行但不稳定；**无许可证，不能复制** |
| [bytedance-nomark](https://github.com/chawu691/bytedance-nomark) | **GPL-3.0** | Flutter/Dart | `lib/services/douyin_qr_login_client.dart`：纯 HTTP 实现 `get_qrcode`/`check_qrconnect`，带 `a_bogus`、`ttwid`、`msToken`；遇 `verify_ticket/captcha/risk_control` **降级到 InAppWebView** 官方页面登录；`inappwebview_login_service.dart` 抽 Cookie | 纯 HTTP 可尝试；遇风控转 WebView | 是（Flutter Windows） | Dart/GPL，不能整合 | 证明「纯 HTTP 在有完整签名时偶尔可用，但风控时仍必须回退真实 WebView」；**GPL-3.0 不兼容本项目 MIT** |

### 2.1 关键时间线（VideoNote-MCP）

- `7ca3bba`（2026-09-09）：**「抖音扫码改本机 Chrome 过风控」**。提交说明明确：
  「直连 `sso.douyin.com/get_qrcode` 返回 HTML 风控页（HTTP 200），改为 Playwright 打开官网登录页拦截出码；
  无浏览器时回退直连并提示 `--cookie`。」
- `155a4d6`（2026-09-09）：修复「已确认后仍卡在已扫码」：官网 `is_frontier` 时确认可能只走 WebSocket，
  HTTP 轮询停在 scanned；改为在**浏览器上下文内**主动短轮询 `check_qrconnect`，状态不回退。
- `cf17948`（2026-09-11）：整合登录修复，1164 tests。

这解释了为什么「自己写 HTTP 扫码」总能遇到 HTML/4031，而开源项目最后都转向真实浏览器。

## 3. 本机真实浏览器验证（只读、未登录、未扫码）

用本机 Chrome 157 / Edge 157，以 `--remote-debugging-port=0` + **专用测试资料目录**打开：

```text
https://www.douyin.com/login_page?service=https%3A%2F%2Fwww.douyin.com
```

官方页面自身成功完成：

| 观察 | 结果 |
| --- | --- |
| 页面标题/地址 | `抖音`，`https://www.douyin.com/login_page?service=...` |
| 页面内容 | 出现「扫码登录 / 如何扫码 / 打开抖音 APP 扫一扫」 |
| 二维码 DOM | 1 张 `data:image` 二维码图片 |
| 官方 JS 请求 | `POST/GET passport/web/get_qrcode` HTTP 200，`application/json`，`data.error_code=0` |
| 返回字段 | `qrcode`（PNG base64）、`is_frontier=true`、`expire_time`（约 60 秒）、`frontier_params` |
| 后续请求 | `passport/web/check_qrconnect`、`passport/ticket_guard/*`、`ttwid/*` 均正常 |

也就是说：**同一个接口，在真实浏览器里 `error_code=0`，在 Node 里 `4031`。**
差异不在参数拼写，而在浏览器运行时与设备信号。

## 4. 本轮实现（原创，未复制上述代码）

模块：`src/platforms/douyin/browser-login.mjs`（零新增依赖）。

```text
用户点击「扫码登录（浏览器）」
  → 找到本机 Chrome/Edge（固定安装路径或显式环境变量）
  → 启动独立进程：
      --remote-debugging-port=0
      --user-data-dir=<数据目录>/runtime/douyin-browser-profile
      --no-first-run --no-default-browser-check --disable-extensions --disable-sync
      https://www.douyin.com/login_page?service=https%3A%2F%2Fwww.douyin.com
  → 通过 Chrome DevTools Protocol（Node 内置 WebSocket）连接页面
  → 捕获官网自己的 get_qrcode JSON → 把同一张二维码显示在 LiveMemory
  → 等待官网写入 sessionid（Storage.getCookies）
  → 用 /aweme/v1/web/user/profile/self/ 实际验证会话
  → AES-256-GCM 加密保存；关闭本次浏览器
```

不做的事：

- 不读取/不使用用户日常 Chrome/Edge 配置文件；只用专用目录，并写入 `.livememory-owned` 标记。
- 不启用 headless、`--no-sandbox`、`--disable-web-security`、`AutomationControlled`/stealth。
- 不伪造 `a_bogus`/`msToken`/设备指纹，不求解验证码。
- 遇到 `is_frontier`/`2046`/验证码：保持浏览器窗口，提示用户在**官方页面**完成；程序只等待结果。
- 不把 Cookie 写入日志、错误、备份、HTTP 响应或 Git。

许可证：本模块没有复制 VideoNote-MCP、douyin-mcp、douyin-parse、dousub 或 bytedance-nomark 的代码；
架构事实（真实浏览器 + CDP + 官方页面）不受版权保护，实现使用 Node 内置能力原创编写。

## 5. 登录状态的诚实区分

| 状态 | 含义 | UI |
| --- | --- | --- |
| `anonymous` | 没有会话凭据 | 未登录 |
| `saved_unverified` | Cookie 已加密保存，但验证被网络/平台限制阻断 | Cookie 已保存，未验证 + 「验证登录」 |
| `logged_in` | 平台验证接口确认会话有效 | 已登录（已验证） |
| `expired` | `sid_guard` 过期，或平台明确返回未登录 | 登录已失效 |
| `invalid` | 会话存在但平台拒绝 | 登录状态无效 |

「浏览器登录完成」与「会话验证通过」也是两件事：浏览器拿到 `sessionid` 后仍要调用验证接口；
验证不确定时保存为 `saved_unverified`，不会显示为「已登录」。

验证接口：`GET https://www.douyin.com/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383`

- `status_code=0` 且有 `user` → `valid`
- `status_code=8` / `用户未登录` → `invalid`
- HTTP 401/403/429、HTML、`error_code=4031` → `blocked`
- 5xx/超时/网络异常 → `network`
- 其他 → `unknown`

## 6. 礼物验证（四级，不得混写）

| 级别 | 本轮可验证性 | 结果 |
| --- | --- | --- |
| 1. 扫码成功 | 需要真实抖音账号 + 手机；本轮无账号 | **未执行（0 次）** |
| 2. 会话有效 | 正向需要真实 Cookie；负向可用假 Cookie 验证 | 负向：格式/不完整/假会话均被正确拒绝；**正向未验证** |
| 3. 直播采集连接 | 可匿名 | 真实房间连接、弹幕入库已验证 |
| 4. 真实礼物事件 | 需要登录会话 + 直播间真实有人送礼 | **未观测**（不能写成成功或失败） |

即使第 2 级成功，也不等于第 4 级成功；送礼是直播间的偶然事件，且平台可能只向登录会话推送。
本轮没有购买/赠送任何礼物。

## 7. 已知限制

1. 必须有 Chrome 或 Edge；都没有时明确回退到手动 Cookie 教程，不伪造扫码。
2. 官方登录页可能在扫码后要求 `is_frontier` 身份验证；只能在浏览器内由用户完成。
3. 二维码有效期约 60 秒；过期后需重新点击。
4. 专用资料目录包含浏览器会话数据；退出登录会尝试删除，若浏览器仍占用则返回 `locked` 并按加密 Cookie 清除处理。
5. 平台页面/接口可能改版；失败必须显示真实原因，不得静默降级为假成功。
6. 未在另一台干净 Windows 电脑、非管理员账户、无 Chrome 环境上验收。

## 8. 人工验收步骤

1. 启动新 EXE，进入「直播」→「抖音」。
2. 点击「扫码登录（浏览器）」：应打开 Chrome/Edge 官方抖音登录页，同时 LiveMemory 显示同一二维码。
3. 若页面要求验证码/身份验证，在浏览器窗口完成；不要在 LiveMemory 中输入密码或验证码。
4. 用抖音 App 扫码并在手机确认。成功后状态应为「已登录（已验证）」。
5. 若显示「浏览器登录完成，但会话未验证」，点击「验证登录」；仍不确定时如实显示，不写成已登录。
6. 连接真实直播间，查看「登录与礼物验证」四级状态；只有出现真实礼物事件才把第 4 级标为「已观测」。
7. 点击「删除 Cookie / 退出登录」，确认状态回到未登录；检查数据目录 `secrets/` 与 `runtime/douyin-browser-profile/` 已清理。

## 9. 参考链接

- <https://github.com/HuangYincan/VideoNote-MCP>（MIT）
- <https://github.com/liaogx/douyin-mcp>（PolyForm Noncommercial 1.0.0）
- <https://github.com/coderlife-book/douyin-parse>（无许可证）
- <https://github.com/debiaoyu/dousub>（无许可证）
- <https://github.com/chawu691/bytedance-nomark>（GPL-3.0）
- VideoNote-MCP 关键提交：<https://github.com/HuangYincan/VideoNote-MCP/commit/7ca3bbaab7a603b721ff41105b9edea89942d828>
- 风控/登录页面使用抖音官方站点：<https://www.douyin.com/>、<https://live.douyin.com/>
