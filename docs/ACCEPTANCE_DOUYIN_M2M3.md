# 抖音 M2/M3 验收报告（LiveMemory）

日期：2026-11-15（Asia/Shanghai）
分支：`feature/douyin`
状态：**EXE 已构建，并用真实抖音直播间验证匿名弹幕/昵称/稳定 UID/自动监听/重启；礼物与登录按平台限制标注。等待开发者人工验收。未合并 main、未 Push、未创建 Tag、未发布 Release。**

> 本报告严格区分「真实直播实测通过」「仅自动化/模拟测试通过」「部分实现」「尚未验证」。
> 未保存或公开任何真实观众聊天正文；验证只统计字段与数量。

---

## A. Git 信息

| 项目 | 值 |
| --- | --- |
| 当前分支 | `feature/douyin`（从 `main` 的 `d5e9a7c` 创建） |
| Twitch 合并提交 | `d5e9a7c5b58bb8127ddf72c46918ce51c557f312`（`Merge branch 'feature/twitch' into main`；父 `21a5bf5` + `5bb0ad0`） |
| 基线 `main` | `d5e9a7c5b58bb8127ddf72c46918ce51c557f312`（合并后；未 Push） |
| 本轮代码/文档提交 | `c08cf6c3115b750c0108b54b9d0a19b6bdbae3ce`（`feat: add Douyin live integration`，48 files，+13,646/−37） |
| 与 main 差异 | `git diff --stat main...HEAD`：48 files changed（代码、测试、文档、构建脚本；无 schema 迁移） |
| 工作区 | 提交后干净（`git status --porcelain` 为空） |
| 提交身份 | `zgrg29 <10182596+zgrg29@users.noreply.github.com>` |
| 未执行 | **未合并抖音到 main、未 Push、未创建 Tag、未发布 Release、未删除 `feature/twitch` / `feature/douyin`** |

---

## B. EXE 信息

| 项目 | 值 |
| --- | --- |
| 文件名 | `LiveMemory.exe` |
| 完整路径 | `D:\LiveMemory\dist\LiveMemory.exe` |
| Build ID | `0f848c77c2d6` |
| 文件大小 | `97,488,896` bytes（93.0 MB） |
| SHA-256 | `ebdcd40d52500ca2bb4062328cf834a4d46102a0ee18de2531e99e641ea00820` |
| source hash | `0f848c77c2d691ac2d68c307944d0327232f44324110c8f9907a062c99922c39` |
| 构建时间 | `2026-11-15T04:30:41.642Z`（Asia/Shanghai 12:20:36） |
| 对应 Commit | `d5e9a7c5b58bb8127ddf72c46918ce51c557f312`（构建时 HEAD；抖音代码提交在其后，详见 §B.1） |
| 资源 | `214` files；39 个必需模块 |
| RT_MANIFEST | **`requireAdministrator`**（双击由 Windows 显示标准 UAC；不绕过 UAC） |
| 构建结果 | 成功；build marker、必需模块与 Manifest 均验证 |
| 实际启动结果 | 成功；`/api/health` 返回 `0f848c77c2d6` / commit `d5e9a7c`；重启后 buildId 不变 |

### B.1 关于 Build ID 与 Commit

`buildId` 是**源码内容哈希**，不是 commit 前缀。EXE 在抖音代码提交之前构建，因此
`build-info.commit` 记录的是构建时 HEAD `d5e9a7c`；用同一源码重新构建会得到同一个
`0f848c77c2d6`。人工验收以 buildId + SHA-256 为准，不要只看 commit 前缀。

构建命令：

```bat
node scripts/build-windows.mjs
```

验收命令：

```bat
node scripts/verify-douyin-exe.mjs 708764876300
```

---

## C. 功能矩阵

状态口径：**真实直播实测通过** / **仅自动化或模拟测试通过** / **部分实现** / **尚未验证** / **不支持**。

| 功能 | 状态 | 证据 / 边界 |
| --- | --- | --- |
| 观众昵称 | **真实直播实测通过** | 源码路径 7/7、正式 EXE 2/2 均有 `display_name` |
| 稳定 UID | **真实直播实测通过** | `user.id` → `douyin:<id>`；7/7 与 2/2；昵称从不作为身份 |
| 实时弹幕原文 | **真实直播实测通过** | 含 CJK/Unicode；原文未替换；消息 `msgId` 去重 |
| Unicode / Emoji | **真实直播实测通过**（文本层） | CJK 7/7；Emoji 文本不破坏；平台表情代码原样保留，不猜情绪 |
| 消息 ID / 去重 | **真实直播实测通过** | 7/7 有消息 ID；20 秒 0 重复；DB `UNIQUE(session_id,dedupe_key)` |
| 房间 URL / 房间号解析 | **真实直播实测通过** | `live.douyin.com/<rid>`、裸房间号、`/root/live/<rid>`；拒绝用户/视频/搜索 |
| 直播状态检测 | **真实直播实测通过** | 公开页 `status=2`（直播）/`4`（结束）；真实房间解析成功 |
| 礼物 | **仅自动化/模拟测试通过；真实未观测** | 匿名 45 秒/20 秒均为 0 gift；解析、去重、金额未知有测试 |
| 连送礼物 | **仅自动化/模拟测试通过；真实未观测** | 只写 `repeatEnd=1` 一条；groupId 合并；中间态不写库 |
| 礼物展示价值 | **仅自动化/模拟测试通过；真实未观测** | 钻石合计写 `amount_display`；`amount_minor=null`、`value_kind=unknown`；不冒充收入 |
| 礼物发送者身份 | **仅自动化/模拟测试通过；真实未观测** | 使用 `user.id`；`toUser` 不记为付款者 |
| 登录 | **部分实现；真实扫码未验证** | 受控扫码流程 + 加密本地 Cookie + 状态/过期/退出；平台风控返回 HTML/4031，未绕过 |
| 自动监听 | **真实 EXE 实测通过（单场当前直播）** | 创建目标 → check → `recording` + 正常 session → 停止 → 删除；长期“等待→开播→下播”未捕获 |
| 断线重连 | **仅自动化测试通过** | close/看门狗/退避/同 session；真实拔网未验证 |
| 多直播间 | **仅自动化测试通过**（两房间） | 独立 adapter/session/身份；正式 EXE 只做单房间 |
| SQLite 保存 | **真实 EXE 实测通过** | 2 条真实 chat 落库；重启后 `messageCount` 仍为 2 |
| AI 分析兼容 | **真实 EXE 读模型通过** | `GET /api/ai/sessions/:id/report` 200；未用真实付费 Provider 重跑语义分析 |
| 长期观众画像 | **真实 EXE 读模型通过** | `GET /api/viewers?platform=douyin` 200，`douyin:<id>` 进入现有画像；真实 AI 语义画像未重跑 |
| 三语 UI | **自动化测试通过** | 64 个 `douyin` 键 × 3 语言，键集/占位符一致；未做真实浏览器截图 |
| Windows EXE | **真实 EXE 实测通过** | `verify-douyin-exe` 17/17；Manifest/启动/连接/入库/停止/重启/AI/观众/三平台状态 |
| TikTok | **不支持** | 本轮未修改 TikTok 正式业务代码 |

---

## D. 回归测试

### D.1 自动化

| 范围 | 结果 |
| --- | --- |
| 抖音专项 | `tests/unit/douyin-*.test.mjs` 41 项 + `tests/integration/douyin-*.test.mjs` 7 项 = **48**，全部通过 |
| 合并后（Twitch → main） | **875 passed / 0 failed / 0 skipped（215,586.9 ms）** |
| 本轮全量 | **923 passed / 0 failed / 0 skipped（283,515.6 ms，2026-11-15）** |

### D.2 正式 EXE 矩阵

| 脚本 | 结果 |
| --- | --- |
| `verify-douyin-exe.mjs`（真实抖音 + 自动监听 + 重启 + AI + 三平台状态） | **17/17**，1 条礼物 NOT-OBSERVED |
| `verify-exe.mjs`（启动/重启/硬杀/端口/单实例/权限/CLI） | **10/10** |
| `verify-p0-5-exe.mjs`（认证/Origin/Host/SSE/重启） | **12/12** |
| `verify-p0-2-exe.mjs`（备份 → 新目录恢复 → 重启 → 再备份） | **13/13** |
| `verify-help-exe.mjs`（三语说明页） | **14/14** |
| `verify-ai-token-exe.mjs`（Mock Provider/Token/Resume/备份） | **16/16** |

### D.3 已有平台

| 平台 | 结果 |
| --- | --- |
| Twitch | 状态端点 200 / `anonymous-irc`；真实 Twitch 回归见 §D.4 |
| Bilibili | 状态端点 200；真实只读房间回归见 §D.4 |
| YouTube | 状态端点 200 / `mode=web`；真实公开网页回归见 §D.4 |
| 数据库 schema | 仍 **16**；`git diff` 未包含迁移文件 |
| 备份/恢复 | p0-2 13/13；抖音 Cookie 不进入备份 |
| AI 结果 Schema / 提示词 | 仍 1.3.0 / v13.2，未改 |

### D.4 真实平台回归

| 平台 | 命令 | 结果 |
| --- | --- | --- |
| Bilibili | `node scripts/verify-bilibili.mjs 6 20` | 房间 `6` → 真实 `7734200`；`connected`；6 条消息 / 6 个可识别观众 / 0 付费；6/6 有 `bilibili:<uid>`；停止后 `ended` |
| YouTube | `node scripts/verify-youtube-anonymous.mjs https://www.youtube.com/watch?v=4t4AQ15yj1M 12` | `mode=web`；直播中 75 条消息 / 12 位活跃观众 / 0 付费；停止后 `ended` |
| Twitch | `node scripts/verify-twitch-exe.mjs` | 正式 EXE **20/20**：真实频道连接、入库、停止、自动监听、重启、AI 读取、Bilibili/YouTube 状态 |
| 首次 Bilibili 尝试 | `verify-bilibili.mjs 5050` | 单次 `BILIBILI_NETWORK` 502（平台/网络瞬时失败）；改用房间 `6` 后成功，代码未变 |

> 真实回归只统计字段与数量，未保存或展示聊天正文。Bilibili 5050 的单次失败按瞬时网络问题记录，不掩盖为平台已通过。

---

## E. 人工验收步骤（EXE）

1. 完全退出所有正在运行的 LiveMemory（旧进程会占用数据目录）。
2. 双击 `D:\LiveMemory\dist\LiveMemory.exe`，Windows 弹出标准 UAC 时选择“是”。
3. 控制台应显示 `Build ID: 0f848c77c2d6`；浏览器打开控制台。
4. 进入「直播」页 → 选择「抖音」Tab。
5. 粘贴 `https://live.douyin.com/708764876300`（或其他正在直播的抖音直播间），点「检查直播间」。
6. 应看到「正在直播」、主播昵称、直播间 ID；点「开始记录」。
7. 进入场次页查看：弹幕原文、观众昵称、稳定 UID（`douyin:<数字>`）、消息计数。
8. 点「停止记录」；关闭 EXE 后重新启动，确认历史中该场与消息仍在。
9. （可选）在抖音 Tab 打开「自动监听」，粘贴直播间地址 → 添加目标 → 等待/立即检查；
   确认目标进入“记录中”，停止后可删除目标。
10. （可选）查看 AI 分析中心能否打开该场报告与观众画像（不要求配置付费 Provider）。
11. 礼物与登录：未登录时可能完全收不到礼物，这是平台行为；扫码登录可能被风控阻止，
    界面会明确提示。**不要**据此判断程序故障，也不要把礼物数量当成主播收入。

### 已知会显示“未验证”的项目

- 真实礼物、真实连送、真实付费留言。
- 真实扫码登录与登录后的礼物推送。
- 真实断网恢复、真实“直播中→下播”、干净 Windows 账户、10+ 房间压力。
