# 2026-11-17 快手 H5 预览接入

## 起点

- 分支 `kuaishou-g1_5`，上一提交 `b012da9`（G1.6 停止 WS 接入）。
- 用户明确指示：停止登录 WebSocket 研究；采用 G1 已验证的匿名 H5 作为唯一候选；
  不重做 G0/G1/G1.5/G1.6，不实现扫码登录/签名/WebSocket；一次性完成全部适配、UI、
  数据库、AI 分析与测试；无许可时保持生产采集禁用，不发布为已支持。

## 决策

1. **只做 H5 组件集成，不发起真实 H5 请求**。G1.5 已确认条款禁止未授权自动采集、
   robots `Disallow: /`；无书面许可 → 默认 `access.enabled=false`。
2. **门禁先于网络**：`assertCollectionAllowed` 在解析/连接前执行；禁用时 `checkRoom`
   只做纯本地解析；`connect` 返回 403 `KUAISHOU_AUTHORIZATION_REQUIRED`。
3. **身份会话内临时**：`h5:<rawUserId>@<localSessionId>`；跨场不合并，等待 G3 证据。
4. **只映射 comment**；礼物/点赞 `NOT-OBSERVED`，不解析、不宣称支持。
5. **无消息 ID**：去重靠 `userId+time+content` + `UNIQUE(session_id,dedupe_key)`；
   文档/UI 明示可能漏消息与同毫秒同内容去重。
6. **上下播保守**：feed 601/671 权威结束；房间页连续 2 次 offline 结束；
   rate_limited/unknown 不结束；`home/list` 缺席永不判下播。

## 实现

- 新增 `src/platforms/kuaishou/{errors,link,policy,http,messages,status,transport,adapter,service}.mjs`。
- 新增 `src/monitoring/detectors/kuaishou.mjs`；修改 `monitoring/{constants,model,manager}.mjs`。
- 修改 `server/{index,routes}.mjs`：服务装配、5 个路由、capabilities `state:'preview'`、30 天保留。
- 修改 `web/js/pages/live.js`：第七个页签、告知、授权状态、链接解析、监控（仅授权）、capture。
- 十份字典各 +47 键 → **2,351**；`i18n.test.mjs` 与英文白名单同步。
- 新增 `tests/unit/kuaishou-*.test.mjs`、`tests/integration/kuaishou-*.test.mjs`、
  `tests/fixtures/kuaishou.mjs`。
- `scripts/build-windows.mjs` 必需模块与 EXE 标记加入 Kuaishou 模块/detector。
- 版本 `0.16.0` → `0.17.0`（候选，未 Tag/Release）。

## 测试（真实执行）

- 全量：**844 unit + 382 integration = 1,226 passed / 0 failed / 0 skipped**。
- Kuaishou 专项：**49 passed**。
- 六平台：全量回归，未改协议。
- 十语言：10 × 2,351，键集/占位符/空值/英文残留 0；真实浏览器 **80/80**。
- 候选 EXE：99,492,352 B、Build ID `47b42dc8417b`、`requireAdministrator`；
  `verify-kuaishou-exe` 10/10、`verify-exe` 11/11、`verify-help-exe` 14/14。
- 真实 H5、真实 EXE 采集、真实下播/再开播、跨场身份：**未执行**。

## 未做 / 禁止

- 未发起真实 H5 请求；未取得许可；未发布。
- 未实现登录、扫码、签名、设备指纹、验证码、TLS 伪装、代理、浏览器中继。
- 未映射礼物/点赞；未跨场合并身份。
- 未 Push / Tag / Release。

## Git

- 分支 `kuaishou-g1_5`；本地提交
  `d49047af32f18b271b00043c1e19db44dd796fb8`
  （`feat: integrate Kuaishou H5 preview with collection disabled`）。
- `main` 仍 `6f71f56`；v0.16.0 Tag/Release 未动。
