# v0.17.0 发布清单（快手 H5 预览）

状态：**已执行发布流程；v0.17.0 作为预览组件正式发布，快手在线采集未开放**。
本清单用于 main 合并与 Release 核对。没有快手书面许可时，**不得启用生产 H5 采集**，
但可以按预览组件发布，前提是界面与 Release Notes 明确标注采集未开放。

## 1. 决策门禁

- [ ] 已取得快手书面许可，明确允许第三方读取公开弹幕、保存、分析与分发
- [ ] 许可范围、房间范围、字段、配额与终止条件已记录
- [ ] 若快手提供官方接口，已评估改用官方接口；不以 H5 替代官方接口规避配额
- [x] 确认仍不实现登录/扫码/签名/设备指纹/验证码/TLS 伪装/代理/浏览器中继

> 当前：**未取得许可 → 生产 H5 采集阻塞**。经用户明确授权，预览组件按“采集未开放”发布；
> 真实采集仍保持禁用。

## 2. 代码与测试

- [x] 全量 `node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"` 通过
- [x] Kuaishou 专项通过（unit + integration + monitoring）
- [x] 六个已发布平台回归通过（Bilibili / YouTube / Twitch / 抖音 / TikTok / Kick）
- [x] 十语言 10 × 2,351 键，键集/占位符/空值/英文残留 0
- [x] `node --check` 新增模块通过
- [x] 未删除/弱化既有断言，未修改六平台协议

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

- [x] 十语言页签、告知、授权状态、错误/空状态无缺失键
- [x] 1440 / 1024 / 820 / 390，明暗主题，无横向溢出/截断
- [x] 强制告知在禁用与启用状态均完整可见
- [x] 禁用状态“开始”不可用且原因清晰；无“绕过授权”入口
- [x] 真实浏览器矩阵结果记录到 STATUS/HANDOFF

## 5. Windows EXE

- [x] `node scripts/build-windows.mjs` 成功
- [x] Manifest **`requireAdministrator`**（注入前后断言）
- [x] Build ID / 大小 / SHA-256 记录
- [x] `verify-exe.mjs` 通过
- [x] `verify-kuaishou-exe.mjs` 通过（若已生成）：默认 access 禁用、connect 403、
      不访问 H5 域名、UI 资源/十语/解析存在
- [ ] 真实双击 UAC（同意/拒绝）、干净 Windows 账户验收
- [x] EXE 未签名/SmartScreen 说明写入发布说明
- [x] **不得**把候选 EXE 描述为“已通过真实快手采集验收”

## 6. 数据与隐私

- [x] Schema 仍 16；无迁移
- [x] 30 天保留对 Kuaishou scoped 生效；计数/会话内 ID/分析保留
- [x] 备份/恢复不因 Kuaishou 数据破坏；设置白名单无新增键
- [x] 日志不含弹幕正文、昵称、ack 引用、Cookie/Token/Key
- [x] 用户告知与“非官方/实验性”表述在 README、UI、发布说明一致

## 7. 文档

- [x] `docs/KUAISHOU_H5_INTEGRATION.md` 完成
- [x] `docs/STATUS.md` §0.60 数字为真实结果
- [x] `docs/HANDOFF.md` / `docs/ROADMAP.md` P51 更新
- [x] `docs/PLATFORM_INTEGRATIONS.md` 新增快手预览节
- [x] `docs/PLATFORM_ADMISSION.md` G0–G6 证据状态更新
- [x] `docs/CHANGELOG.md` / `docs/release-notes/v0.17.0.md`
- [x] `README.md` 明确“快手预览 / 采集禁用 / 在线采集未开放”
- [x] `log/2026-11-17-kuaishou-h5-integration.md`
- [x] `THIRD_PARTY_NOTICES.md` 无新增复制代码（研究仅参考协议）

## 8. Git 与发布

- [x] 工作区干净，无 `tests/.tmp/`、`dist/`、`build/`、数据库、日志、凭据
- [x] 提交身份为 `zgrg29 <10182596+zgrg29@users.noreply.github.com>`
- [x] 本地 Commit 完成并记录 Hash
- [x] 用户明确授权本轮 Push / 合并 `main` / Tag / Release
- [x] Release Notes 与 CHANGELOG 一致
- [x] Tag `v0.17.0`（annotated）创建并推送
- [x] GitHub Release 创建，资产上传并下载复核
- [x] 不覆盖 v0.16.0 及更早 Release/Tag/资产

## 9. 实际发布记录（2026-11-17）

| 项目 | 值 |
| --- | --- |
| main 合并 | `9ae4a37f406a79ce8ae8addeb6e74c3b2ad90cf9` |
| 发布文档提交 / Tag | `5807e3e7dcb183fdd09515baacf0c4193591a7c2`（annotated tag object `4cf356a`） |
| Push | `main`：`6f71f56..5807e3e`；Tag `v0.17.0` |
| Release | ID `448828056` · `https://github.com/zgrg29/LiveMemory/releases/tag/v0.17.0` |
| Title | `LiveMemory v0.17.0 — Kuaishou H5 Preview (Live Collection Disabled)` |
| 资产 | `LiveMemory.exe`（99,492,352 B，SHA-256 `58b21dc9…830471ac`）、`SHA256SUMS.txt`（82 B） |
| 验证 | Release 页 200、latest 200、`v0.16.0` 页 200；body 与本地 Release Notes 一致；下载 EXE 哈希一致 |
| 快手状态 | **预览组件已发布；在线采集未开放；不是已支持平台** |

> 第 1 节许可条件、第 3 节真实采集验收与第 6 节真实数据验证仍未满足；
> 本轮按用户授权发布预览组件，未伪造任何真实采集结果。
