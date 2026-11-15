# 2026-11-08 · YouTube 免登录实验接入

## 目标

在不要求普通用户申请 API Key / Google Cloud / OAuth / Cookie 的前提下，读取正在直播的 YouTube 聊天；保留官方路径；真实双房间验证。

## 研究

- `letruxux/youtube-chat`：TS，读取 live_chat HTML 首批 actions，无 continuation/SC；MIT 包元数据但无 LICENSE 文件。
- `taizan-hokuto/pytchat`：Python，已归档；手写 protobuf continuation，timeoutMs，事件类型与金额正则。
- `HardDie/ytmemchat_wails`：Go/Wails，GPL-3.0；空 Key 用无 Key 客户端，填 Key 只用官方 v3。
- `xenova/chat-downloader`：Python/MIT；最完整的 continuation、headers、ticker 去重、事件分类。
- `sigvt/komet`：AGPL-3.0，仓库无应用源码，只有 README/截图；无法复用实现。

未复制 GPL/AGPL 代码。参考协议与行为后，自行实现 Node ESM。

## 实现

- `src/platforms/youtube/anonymous/parser.mjs`
  - 平衡括号提取 `ytInitialData` / `ytInitialPlayerResponse` / `ytcfg`；
  - watch 状态：live/upcoming/ended/video/restricted；
  - `liveChatRenderer` 首批 actions + continuation + timeout；
  - runs → 原文 + 自定义表情元数据；
  - authorBadges → owner/moderator/verified/member；
  - 格式化金额：显式符号/ISO code 优先，裸 `$`/`¥` 用 client.gl，无法确认则未知；
  - timestampUsec → ms（BigInt）。
- `src/platforms/youtube/anonymous/client.mjs`
  - GET watch / live_chat；
  - POST `/youtubei/v1/live_chat/get_live_chat`；
  - 400/410→stale、429→rate limit、5xx→network、403→restricted、页面无 renderer→disabled/ended/unavailable；
  - 不发送 Cookie/OAuth/用户 Key。
- `src/platforms/youtube/anonymous/adapter.mjs`
  - 初次 actions + 轮询；
  - continuation 更新；400 重开；429/网络退避；连续 8 次失败停止；
  - 60s watch 状态检查；自动结束；
  - gap 诊断（90s）。
- `mapper.mjs` 新增匿名映射：文本/SC/Sticker/会员/gift。
- schema v4：badges、amount_display。
- retention：30 天上限，清理 badges/amount_display/过期昵称。
- 设置：`youtubeCaptureMode` official/anonymous；默认 official。
- UI：官方未配置 → 实验模式按钮；warning；设置页模式卡；badge 显示。

## 真实采样

| 房间 | 时长 | events | chat | 经济 | 身份 | 错误 |
| --- | --- | --- | --- | --- | --- | --- |
| `FKLZiufsCk0` | 35s | 86 | 85 | 1 SC HK$2,000.00 → HKD 200000 | 86/86 | 0 |
| `gXawf8GZDI8` | 35s | 100 | 87 | 13 gift，无金额 | chat 87/87；gift 0/13 | 0 |

未观测到 Super Sticker/会员/赠送会员；无官方凭据，未做官方并排对照。

## 测试与 EXE

- 287 tests pass / 0 fail / ~17.7s。
- EXE 90.2 MB，SHA-256 `9d586aa9…`；verify-exe 9/9。
- EXE 内匿名真实直播约 10 秒：72 事件、72/72 Channel ID、0 错误；最终样本未出现付费事件。
- 截图 6 张（未配置/实验明亮/实验黑暗/真实录制/390px/设置页）。

## 结论与风险

- 技术可用，但不是官方 API；YouTube ToS 禁止自动化访问与收集可识别个人信息，**很可能冲突**。
- 因此默认关闭、显式 opt-in、warning、官方路径保留。
- 匿名接口可能失效；金额币种只能谨慎解析；gift 无 Channel ID；30 天清理不等于完全删除个人数据。
