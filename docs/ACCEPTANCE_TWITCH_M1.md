# Twitch M1 验收报告（LiveMemory）

日期：2026-11-15（Asia/Shanghai）
分支：`feature/twitch`
状态：**EXE 已构建并完成真实 Twitch / 自动监听 / 重启验证；等待开发者人工验收。未合并 main、未 Push、未创建 Tag、未发布 Release。**

> 本报告如实区分「真实直播实测」「已实现但仅模拟/解析测试」「受平台权限限制」「未实现」。
> 未保存或公开任何真实观众聊天正文；验证只统计字段与数量。

---

## A. Git 信息

| 项目 | 值 |
| --- | --- |
| 当前分支 | `feature/twitch` |
| 报告生成时 HEAD | `27bd69069b7e0cfa8b50e7d8358b26768a863ede`（验收报告首次提交；后续仅文档修订） |
| 代码提交 | `7da0e0d1905a4f16d1a844f98102fb04c211a7d2`（`feat: add Twitch live integration`） |
| 基线 | `main` / `21a5bf5d67d0741ae68d21b0e1e7a371bb1607ef`（多平台调研提交） |
| 与 main 差异 | 42 files changed（代码 + 平台/验收文档；精确数字以 `git diff --stat main...HEAD` 为准） |
| 本轮提交 | `7da0e0d` 代码与平台文档；`627eb57` 验收/构建记录；`27bd690` 完整验收报告 |
| 工作区 | 干净（`git status --porcelain=v2` 无未提交项） |
| 提交身份 | `zgrg29 <10182596+zgrg29@users.noreply.github.com>` |
| 未执行 | **未合并 main、未 Push、未创建 Tag、未发布 Release、未删除分支** |

---

## B. EXE 信息

| 项目 | 值 |
| --- | --- |
| 文件名 | `LiveMemory.exe`（同哈希副本：`LiveMemory-twitch-a4bf602de264.exe`） |
| 完整路径 | `D:\LiveMemory\dist\LiveMemory.exe` |
| Build ID | `a4bf602de264` |
| 文件大小 | `96,828,416` bytes（92.3 MB） |
| SHA-256 | `6a90f564b0fd31adabd67b68a764bfe1800d402fd35fcabe3b601ec9d15e6d2d` |
| 构建时间 | `2026-11-15T03:27:03.011Z`（Asia/Shanghai 11:27:03） |
| 对应 Commit | `7da0e0d1905a4f16d1a844f98102fb04c211a7d2` |
| source hash | `a4bf602de264d4b57203cbfc4b83319c701f1884101901a0bbbef11aae53ed12` |
| 资源 | `200` files；28 个必需模块 |
| RT_MANIFEST | **`requireAdministrator`**（双击由 Windows 显示标准 UAC；不绕过 UAC） |
| 构建结果 | 成功；嵌入 build marker 与 Manifest 均验证 |
| 实际启动结果 | 成功；`--version` / `/api/health` 均返回 `a4bf602de264` / commit `7da0e0d` |

构建命令：

```bat
node scripts/build-windows.mjs
```

说明：自动化会话不能点击 UAC，因此功能场景使用**同一二进制**的 asInvoker 测试副本；正式 EXE 的
`requireAdministrator` Manifest 单独断言。正式 EXE 未被修改。

---

## C. 功能完成情况

| 功能 | 状态 | 说明 |
| --- | --- | --- |
| 观众昵称 | **已实现且真实直播实测通过** | 418/418 条真实事件有 `display-name`；昵称只作展示 |
| 稳定 User ID | **已实现且真实直播实测通过** | 418/418 有 `user-id` → `twitch:<user-id>`；缺失 ID 不建长期档案 |
| 实时弹幕/聊天原文 | **已实现且真实直播实测通过** | PRIVMSG 原文；Unicode/Emoji；消息 `id` 去重；`/me` 只去包装 |
| 订阅 / 续订 | **已实现且真实直播实测通过** | 真实 resub/Prime；Tier/累计月数/留言；金额未知 |
| Bits / Cheer | **已实现，仅模拟/解析测试** | IRC `bits` 标签 → `super_chat`；数量 + `N Bits` 展示；**真实事件未观测到** |
| 赠送订阅 | **已实现，仅模拟/解析测试** | `subgift` → `gift`，赠送者付款；接收者仅展示；`submysterygift` 跳过防重复；**真实事件未观测到** |
| 付费附带留言 | **部分实现** | resub/订阅留言已支持；Bits Cheer 留言已解析但真实事件未观测；赠订通常无留言 |
| 自动开播 | **已实现；正式 EXE 实测 check → session → 入库** | 真实“等待开播→开播→下播”完整周期未捕获；目标持久、关播保留 |
| 断线重连 | **已实现；自动化覆盖** | close/RECONNECT/90s 看门狗；1→30s 退避；15 次后 5 分钟低速探测；同 session；**真实拔网未验证** |
| 多直播间 | **已实现且真实 6 频道并发实测通过** | 独立 adapter/session/去重；停止一场不影响其他 |
| AI 分析 | **已实现；正式 EXE 报告读取 200** | 复用现有 AI 分析中心/分析包/报告；未用真实付费 Provider 重跑语义 |
| 长期画像 | **已实现；正式 EXE 观众读模型 200** | `twitch:<user-id>` 进入现有画像；真实 AI 语义更新未重跑 |
| 官方 EventSub 增强 | **受平台权限/配置限制，未实现** | 需要 OAuth User Token、应用 Client ID、scope；本构建不要求普通主播注册开发者应用 |

### C.1 统一事件映射

| Twitch 事件 | Canonical 类型 | 金额语义 |
| --- | --- | --- |
| `PRIVMSG` 普通聊天 | `chat` | 无金额 |
| `PRIVMSG bits=N`（Cheer） | `super_chat`（`gift_name=Bits`、`gift_quantity=N`、`amount_display="N Bits"`） | `amount_minor=null`、`currency=null`、`value_kind=unknown` |
| `USERNOTICE sub` / `resub` | `membership`（Tier/Prime、月数、留言） | 未知；不换算收入 |
| `USERNOTICE subgift` | `gift`（赠送者为付款者；接收者只在 `amount_display`） | 未知；接收者不计付费 |
| `USERNOTICE submysterygift` | 跳过 | 防止与每个 `subgift` 重复计数 |
| `viewermilestone` / `bitsbadgetier` / `announcement` / `raid` 等 | 跳过 | 系统通知不冒充聊天 |

---

## D. 自动化测试

| 项目 | 结果 |
| --- | --- |
| 全量测试数量 | **875** |
| 通过 | **875** |
| 失败 | **0** |
| 跳过 | **0** |
| 耗时 | **253,002 ms**（2026-11-15） |
| 上一轮 | 828 |
| 本轮新增 | **47** |

命令：

```bat
node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"
```

新增覆盖：

- Twitch URL/账号解析；拒绝视频/剪辑/目录。
- IRCv3 标签、转义、多行帧、`emotes`、`badges`、`/me`。
- 稳定 User ID、昵称、消息 ID、Unicode、Emoji、平台表情 ID。
- 订阅/续订/赠订、Bits、`submysterygift` 跳过、系统通知不冒充聊天。
- 消息去重、断线重连、看门狗、两次离线确认、多频道隔离。
- SQLite 写入、AI 分析包、自动开播、Twitch-only 30 天保留。
- 三语 UI 键一致、历史筛选、构建必需模块。

### D.1 正式 EXE 矩阵

| 脚本 | 结果 |
| --- | --- |
| `scripts/verify-twitch-exe.mjs` | **20/20** |
| `scripts/verify-exe.mjs` | **10/10** |
| `scripts/verify-p0-5-exe.mjs` | **12/12** |
| `scripts/verify-p0-2-exe.mjs` | **13/13** |
| `scripts/verify-help-exe.mjs` | **14/14** |
| `scripts/verify-ai-token-exe.mjs` | **16/16** |
| `scripts/verify-youtube-lifecycle-exe.mjs` | **PASS**（180,524 ms 断网 → 同 session 恢复 → 去重 → `platform_ended`） |

### D.2 Bilibili / YouTube 回归

- 真实 Bilibili 房间 `6`（真实 `7734200`）20 秒：**7 条聊天 / 7 个可识别观众 / 0 付费**；
  停止后 `ended`。
- 真实 Bilibili 房间 `5050` 当时未开播，返回 409 `BILIBILI_ROOM_OFFLINE`，属于正确行为。
- 正式 EXE 的 YouTube 生命周期回放通过；Bilibili/YouTube 状态端点均 200。

---

## E. EXE 实测（真实 Twitch）

| 项目 | 结果 |
| --- | --- |
| 测试直播间 | `xqc`（channel id `71092938`），另以 6 个公开频道做源码并发验证 |
| 采集条数（EXE） | 主动连接 4 条；自动监听 session 3 条（均为真实聊天） |
| 观众昵称 / ID | 4/4 事件有 `twitch:<id>` 与昵称；SQLite 中 4/4 有 `user_id` + `external_id` |
| 真实付费事件 | EXE 本次窗口未观察到 resub/Bits/赠订；源码 6 频道 60 秒窗口观察到 1 条真实 resub（Prime） |
| 漏消息 / 重复计数 | 未观察到重复入库；协议层无法证明“零漏消息” |
| 数据库保存 | 成功；重启后 session/事件/观众仍在 |
| AI 报告读取 | `GET /api/ai/sessions/:id/report` 返回 200 |
| 长期画像读模型 | `/api/viewers` 返回 `twitch:` 观众 200 |
| 自动监听 | 添加目标 → `check` → `state=recording` → 3 条真实聊天 → 停止 → 删除目标，均通过 |
| 重启 | buildId 不变；数据持久化 |

真实只读并发样本（源码服务，非 EXE）：

- `xqc` 45 秒：138 条事件；138/138 有 User ID + 消息 ID；108 身份；7 条 `emotes`；7 条非 ASCII。
- 6 频道 60 秒：418 条事件；418/418 有 User ID + 消息 ID；304 身份；40 条 `emotes`；
  10 条非 ASCII；1 条真实 resub；0 Bits、0 赠订。
- 未登录、未付费、未保存/展示正文；数据在 `tests/.tmp` 隔离目录。

---

## F. 人工验收步骤（面向普通用户）

1. **找到 EXE**：打开文件夹 `D:\LiveMemory\dist\`，双击 `LiveMemory.exe`。
2. **允许 UAC**：Windows 弹出标准管理员权限确认时点「是」。若点「否」，Windows 会取消启动，这是预期行为。
3. **等待控制台**：程序会在本地启动并自动打开浏览器；不要手动打开普通地址（启动地址带有一次性登录片段）。
   若浏览器没有自动打开，请完全退出程序后重新双击。
4. **进入 Twitch**：左侧选择「直播记录」→「＋ 新建记录」→ 在「直播来源」卡片选择 **Twitch**。
5. **输入直播间**：粘贴一个正在直播的公开频道，例如 `https://www.twitch.tv/xqc`，或只输入 `xqc`；
   点击「检查直播间」。应看到频道名、稳定 Channel ID、正在直播、观看数与标题。
6. **开始采集**：点击「开始记录」。在「最近动态」中查看实时聊天（昵称 + 正文），
   在右侧 Top 100 中查看观众；打开某位观众可看到 `twitch:<稳定 ID>`。
7. **查看付费事件**：若该频道在此期间出现订阅/续订，最近动态会显示 Membership；
   Bits/赠订只有真实发生时才出现。Bits 显示为 `N Bits`，不会显示为金额 0.00，也不会换算成收入。
8. **停止采集**：在该直播标签上点击停止（或「停止记录」）。只结束当前场次，不影响其他场次。
9. **查看报告 / 画像**：打开「直播历史」查看该场消息与观众；打开「AI 分析中心」选择该场，
   可看到报告入口；打开「观众」查看该 Twitch 观众的长期档案（需要已保存的观众数据）。
10. **自动监听（可选）**：回到 Twitch 来源，打开「自动监听此频道」→ 添加目标；目标 Tab 会出现。
    点「立即检查」可立即检测并开始记录；关播后目标保留，下次开播自动开始新场次。
11. **重启验证**：完全退出程序，再双击同一 EXE；历史、观众与 Twitch 场次应仍存在。
12. **如验收失败**：请记录失败步骤与界面提示，反馈给开发者；修复会继续在 `feature/twitch` 分支进行，
    并重新构建 EXE 后再验收。

---

## G. 明确边界

- **Bits、赠订真实事件尚未观测到**；这两项只能按「已解析/仅模拟测试」验收，不能按「完整支持」验收。
- **EventSub OAuth 未配置**；匿名 IRC 与公开 GQL 都不是 Twitch 官方承诺的稳定 API，未来可能失效。
- **真实拔网、真实“直播中→下播”** 未捕获；自动化覆盖协议与状态机，但不能替代真实网络演练。
- **真实 UAC 双击/点击** 无法由自动化完成；本轮只断言 Manifest 与同一二进制功能副本。
- **未在另一台干净 Windows 电脑验收**；未验证 10+ 频道长时间、千条/秒、限流叠加。
- Twitch 原文保留在 M1 固定 30 天；保留计数与稳定 ID，不等同于完全删除个人数据。
- **未合并 main、未 Push、未 Tag、未发布 Release；等待开发者明确验收与授权。**
