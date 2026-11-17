# v0.17.0 发布清单（快手 H5 预览）

状态：**已执行发布流程；v0.17.0 作为预览组件正式发布，快手在线采集未开放**。
本清单用于 main 合并与 Release 核对。没有快手书面许可时，**不得启用生产 H5 采集**，
但可以按预览组件发布，前提是界面与 Release Notes 明确标注采集未开放。

## 1. 决策门禁

- [ ] 已取得快手书面许可，明确允许第三方读取公开弹幕、保存、分析与分发
- [ ] 许可范围、房间范围、字段、配额与终止条件已记录
- [ ] 若快手提供官方接口，已评估改用官方接口；不以 H5 替代官方接口规避配额
- [ ] 确认仍不实现登录/扫码/签名/设备指纹/验证码/TLS 伪装/代理/浏览器中继

> 当前：**未取得许可 → 阻塞**。生产 H5 采集保持禁用，只提交可独立使用的组件。

## 2. 代码与测试

- [ ] 全量 `node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"` 通过
- [ ] Kuaishou 专项通过（unit + integration + monitoring）
- [ ] 六个已发布平台回归通过（Bilibili / YouTube / Twitch / 抖音 / TikTok / Kick）
- [ ] 十语言 10 × 2,351 键，键集/占位符/空值/英文残留 0
- [ ] `node --check` 新增模块通过
- [ ] 未删除/弱化既有断言，未修改六平台协议

## 3. 功能验收（许可后才可执行）

- [ ] 真实 H5 房间：链接解析 → room check → connect → 真实弹幕落库 → 停止
- [ ] 真实昵称、`userId`、时间字段覆盖率记录；消息 ID 缺失明确标注
- [ ] 真实 ≥30 分钟、≥2 房间并发；跨房间串台 0；重复 0
- [ ] 真实断线/重连；空档与可能漏消息记录
- [ ] 真实下播（`601`）结束；真实“再开播”新 session
- [ ] 真实监控：离线等待 → 开播自动录制 → 下播结束 → 下一场
- [ ] 礼物/点赞：有真实样本才更新 `NOT-OBSERVED`；无样本保持
- [ ] 跨场/跨日身份实验（需授权测试账号）；未证明前保持会话内隔离

## 4. UI / 十语言

- [ ] 十语言页签、告知、授权状态、错误/空状态无缺失键
- [ ] 1440 / 1024 / 820 / 390，明暗主题，无横向溢出/截断
- [ ] 强制告知在禁用与启用状态均完整可见
- [ ] 禁用状态“开始”不可用且原因清晰；无“绕过授权”入口
- [ ] 真实浏览器矩阵结果记录到 STATUS/HANDOFF

## 5. Windows EXE

- [ ] `node scripts/build-windows.mjs` 成功
- [ ] Manifest **`requireAdministrator`**（注入前后断言）
- [ ] Build ID / 大小 / SHA-256 记录
- [ ] `verify-exe.mjs` 通过
- [ ] `verify-kuaishou-exe.mjs` 通过（若已生成）：默认 access 禁用、connect 403、
      不访问 H5 域名、UI 资源/十语/解析存在
- [ ] 真实双击 UAC（同意/拒绝）、干净 Windows 账户验收
- [ ] EXE 未签名/SmartScreen 说明写入发布说明
- [ ] **不得**把候选 EXE 描述为“已通过真实快手采集验收”

## 6. 数据与隐私

- [ ] Schema 仍 16；无迁移
- [ ] 30 天保留对 Kuaishou scoped 生效；计数/会话内 ID/分析保留
- [ ] 备份/恢复不因 Kuaishou 数据破坏；设置白名单无新增键
- [ ] 日志不含弹幕正文、昵称、ack 引用、Cookie/Token/Key
- [ ] 用户告知与“非官方/实验性”表述在 README、UI、发布说明一致

## 7. 文档

- [ ] `docs/KUAISHOU_H5_INTEGRATION.md` 完成
- [ ] `docs/STATUS.md` §0.60 数字为真实结果
- [ ] `docs/HANDOFF.md` / `docs/ROADMAP.md` P51 更新
- [ ] `docs/PLATFORM_INTEGRATIONS.md` 新增快手预览节
- [ ] `docs/PLATFORM_ADMISSION.md` G0–G6 证据状态更新
- [ ] `docs/CHANGELOG.md` / `docs/release-notes/v0.17.0.md`
- [x] `README.md` 明确“快手预览 / 采集禁用 / 在线采集未开放”
- [ ] `log/2026-11-17-kuaishou-h5-integration.md`
- [ ] `THIRD_PARTY_NOTICES.md` 无新增复制代码（研究仅参考协议）

## 8. Git 与发布

- [ ] 工作区干净，无 `tests/.tmp/`、`dist/`、`build/`、数据库、日志、凭据
- [ ] 提交身份为 `zgrg29 <10182596+zgrg29@users.noreply.github.com>`
- [ ] 本地 Commit 完成并记录 Hash
- [ ] **用户明确授权**后才 Push / 合并 `main`
- [ ] Release Notes 与 CHANGELOG 一致
- [ ] Tag `v0.17.0`（annotated）与 GitHub Release 仅在许可与验收通过后创建
- [ ] 不覆盖 v0.16.0 及更早 Release/Tag/资产

> 当前结论：**仅完成第 2、4、5（候选）、7、8（本地提交）中不依赖许可的部分；
> 第 1、3、6（真实数据）与正式发布仍阻塞。**
