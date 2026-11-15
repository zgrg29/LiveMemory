# Douyin signature component: license review (AGPL-3.0)

最后核对：2026-11-15。本文只记录事实与义务，不构成法律意见。

## 1. 组件与来源

| 文件 | 用途 | 上游 | 许可证 |
| --- | --- | --- | --- |
| `src/platforms/douyin/vendor/sign.js` | 抖音 WebSocket 握手 `signature`（webmssdk 反混淆产物） | [saermart/DouyinLiveWebFetcher](https://github.com/saermart/DouyinLiveWebFetcher)，经 [ymstar/dyhub `third_party/douyin-sign`](https://github.com/ymstar/dyhub/tree/main/third_party/douyin-sign) 分发 | **AGPL-3.0** |
| `src/platforms/douyin/vendor/LICENSE-AGPL-3.0.txt` | AGPL-3.0 完整文本（34,020 bytes） | GNU / SPDX `AGPL-3.0-only` | AGPL-3.0 |

> 上游同目录的 `a_bogus.js` **没有随本产品分发**：本产品只需要 WebSocket 握手签名，
> 不把不需要的 AGPL 代码打进 EXE。登录调查中提到的 `a_bogus` 是平台侧要求，不是本产品的运行依赖。

**核对结果（2026-11-15）**

- `saermart/DouyinLiveWebFetcher` 的 `LICENSE` 为 GNU AGPL v3（34,503 bytes，首行为 `GNU AFFERO GENERAL PUBLIC LICENSE`）。
- 随包分发的 `sign.js` 与 `ymstar/dyhub` 当前 `main` 的对应文件**逐字节一致**：
  - `sign.js` SHA-256 `81fb78a5e8728af99ffb9d20625b01bcedc43a82b05e3bef79e2bc0d29ccff5d`
- 没有发现额外的 npm 运行时依赖：LiveMemory 直接以 `node:vm` 加载该脚本，`node:zlib`、`node:crypto`、内置 `WebSocket` 均为 Node 内置模块。

## 2. 与主项目 MIT 的组合关系

- LiveMemory 其余源码继续保持 **MIT**。`LICENSE` 文件**未被修改**。
- `src/platforms/douyin/vendor/` 是**单独目录、单独许可证**的 AGPL-3.0 组件，目录内有自己的 `README.md` 与完整 AGPL 文本。
- 但 Windows EXE 把 `src/` 下的所有文件打进同一个可执行文件，并通过 `node:vm` 执行 AGPL 脚本。因此**分发包含该组件的 EXE 时，整个组合分发必须满足 AGPL-3.0**，不能只标注“MIT”。

## 3. 分发义务清单

发布带抖音能力的 EXE 时，需要同时满足：

1. **提供完整对应源码**（AGPL-3.0 §4–§6）：包括 LiveMemory 源码、构建脚本，以及这两个脚本的**完全相同版本**（可用上面的 SHA-256 核对）。
2. **保留版权与许可证声明**：保留 `vendor/README.md`、`LICENSE-AGPL-3.0.txt`、本文件与 `THIRD_PARTY_NOTICES.md`。
3. **向接收者说明 AGPL 权利**：接收者有权获得源码、修改并在相同许可证下再分发。
4. **网络交互条款（§13）**：如果未来把该程序作为网络服务提供给远程用户，需要向这些用户提供对应源码。当前产品是本地 Windows 软件，没有开发者运营的服务器；但文档不得否认该义务。
5. **不得声称整个项目仍是纯 MIT**：可以写“LiveMemory 自身源码为 MIT；`vendor/` 目录中的抖音签名组件为 AGPL-3.0；包含该组件的二进制分发按 AGPL-3.0 提供对应源码”。

满足方式（本项目采用）：仓库公开、源码与 vendored 文件逐字节一致、发布包附带 `THIRD_PARTY_NOTICES.md` 与许可证文本、Release Notes 与 README 明确写出组合义务。

## 4. 为什么仍然采用该方案

- 抖音网页端要求请求签名；没有签名时 WebSocket 握手直接被拒绝（实测 close 1006）。
- 自研等价签名需要逆向平台专有 SDK，工作量和失效风险都更高；上游已经提供可核对、可再分发的实现。
- 开发者已明确接受 AGPL 组件并愿意履行源码公开义务；本方案不依赖付费签名服务、云端采集服务或开发者服务器。
- 替代方案“运行时从平台下载 webmssdk 并执行”不会消除平台脚本的版权/条款风险，也不会减少义务，因此没有采用。

## 5. 仍未解决的风险（如实记录）

- 这两个脚本是平台专有代码的反混淆产物，其**上游 AGPL 授权本身**依赖上游作者对相关代码的主张；不同司法辖区的结论可能不同。
- 抖音可能随时更新签名算法，届时 `sign.js` 失效；程序会明确报 `DOUYIN_SIGNATURE_FAILED`，不会伪造签名或改用未签名连接。
- 本项目没有对“使用网页签名访问公开直播间”做平台条款合规背书。正式商业分发前建议做一次独立法律评审。
- **未修改主项目 `LICENSE`**；如果开发者希望把整个项目改为 AGPL，需要另行明确决定。
