# 2026-11-16 LiveMemory 下一阶段规划：国际化十语言与直播平台扩展

## 1. 任务性质与边界

本轮是**项目规划 / 技术可行性调查 / 开发文档更新**，不是功能开发。

允许并实际完成的：

- 阅读仓库代码、配置与文档；调查国际化与平台适配器架构；
- 调查公开技术资料与 GitHub 开源项目；
- 制定分阶段路线；更新 `AGENTS.md`、`ROADMAP.md` 与必要规划文档；检查文档一致性。

明确未做（可逐条核对 `git diff`）：

- 未修改任何正式业务代码；未新增语言包或平台适配器；
- 未改五平台采集逻辑；未改 AI 分析/长期画像/数据保存/恢复；
- 未安装依赖、未引入第三方代码；
- 未打包、未发布、未 Push/Merge/Tag/Release。

工作区起始状态：`main`，clean，HEAD `25e6fbe`。没有覆盖任何用户未提交的修改。

## 2. 为什么要先国际化、再扩平台

平台适配器会引入大量新的用户可见文案（来源 Tab、能力边界、状态胶囊、错误码、技术详情）。
若先接平台，则每接一个平台都要回头补 7 种语言；若先扩语言，则新平台只需一次性补齐 10 语言。
两者互不阻塞，但顺序上**国际化优先**能显著减少返工。该排序已写入 `docs/ROADMAP.md` 的「依赖关系」。

## 3. 国际化的真实结构（实测）

### 3.1 三层语言模型

| 层 | 含义 | 当前实现 |
| --- | --- | --- |
| L1 界面语言 | 菜单/按钮/设置/错误/说明 | 三语字典 + `t()` 插值；`config/settings.json` 的 `locale`（`system` 或三语之一） |
| L2 AI 输出语言 | 单场报告、长期画像自然语言 | 任务创建时解析并写入 `ai_jobs.locale`；**默认取界面语言，无独立持久设置** |
| L3 原始弹幕 | 观众原文 | `events.content` 原文；提示词明确不逐行预翻译 |

### 3.2 实测数据

三份字典各 **2,265 个叶子键**，键集缺失 0 / 多余 0，占位符差异 0。
比对脚本用仓库自带 Node 运行（未落盘到仓库）：

```js
// 对 src/web/i18n/{zh-CN,ja,en}.json 扁平化后比较键集与 /\{(\w+)\}/g 占位符
```

### 3.3 已定位的三个结构债

1. **语言清单有两份**：`src/web/js/i18n.js:7` 与 `src/shared/locale.mjs:8`。
2. **Header 语言控件为 3 项设计**：`app.js:39` 的 `LANGUAGE_CHOICES` 渲染成三段按钮；
   同处 `.language-select { max-width:132px }`（`components.css:665`）写死宽度。
3. **AI 输出语言未独立**：`ai.js:198` `let locale = ctx.locale`；无 `aiOutputLocale` 设置；
   `LOCALE_NAME`、`SYSTEM`、`MEMORY_LANGUAGE_RULE`、`TEXT`、`MEMORY_SHAPE_TEXT` 都只有 3 个键。

另外确认：`build-windows.mjs` 递归遍历 `src/`，新增字典文件会自动打进 EXE；
`serveStatic` 以 `application/json; charset=utf-8` 下发，无语言白名单 → **新增语言不需要改打包或路由代码**，
只需要改清单与界面。

### 3.4 最高优先级风险：长期画像合并键与语言绑定

```text
src/memory/model.mjs:47  normalizeTopic()  = NFKC + 小写 + 去标点（不翻译）
src/memory/model.mjs:66  dedupeKeyFor()    = `${kind}:${normalizeTopic(topic)}`
```

同一观众同一兴趣，中文输出得到 `interest:吉他`、英文输出得到 `interest:guitar`，
在「同一 memory 下只有一条 live 事实」的唯一索引下**并存**，表现为重复事实 + 时间线语言混杂。
`memory_facts` 也没有 `locale` 列（只有 `source_job_id` 可回溯）。

这不是可以靠「多加语言」顺手解决的问题，必须在 M-I18N-2 开工前做出产品决策。
本文档建议的默认方案是「同一观众记忆锁定首次输出语言」，因为它不破坏 `dedupe_key` 稳定性、
不需要 schema 迁移。

### 3.5 其它已确认的兼容性事实

- 旧配置值（`zh-CN`/`ja`/`en`）语义不变，**不需要迁移**。
- `ai_jobs.locale` / `ai_translations.target_locale` / `ai_results.locale` 都是自由 TEXT，新增语言码不冲突。
- 历史报告正文不会被界面语言改写（原文 + 翻译缓存分离）。
- **备份设置白名单是显式枚举**（`src/server/backup/settings.mjs:15` 只有 `locale`）：
  新增语言设置键必须同步，否则备份/恢复静默丢失。
- 启动器控制台依赖 `chcp 65001`，失败时降级 ASCII（`console.mjs:13-24`）。

## 4. 五个平台适配器的结构（实测）

统一分层（以 TikTok 为例，其余同构）：

```text
link.mjs        解析 URL/房间号/用户名 → platform + platformRoomId
client/webcast  传输（HTTP + WebSocket / IRC / protobuf）
mapper/messages 原生负载 → canonical event（src/shared/events.mjs）
adapter.mjs     状态机（idle/connecting/connected/reconnecting/rate_limited/auth_required/failed/stopped）
service.mjs     装配：createAdapter 注入 SessionManager，注册路由与监控 detector
```

关键点：

- `src/platforms/shared/adapter.mjs` 定义契约；`session-manager.mjs` 通过调用方注入的
  `createAdapter` 创建实例 → **平台与服务/存储完全解耦**；
- 所有事件只经 `src/platforms/shared/ingest.mjs` 写入，去重键限定在 `session_id` 内；
- 平台能力声明集中在 `src/server/routes.mjs` 的 `capabilities.platforms`；
  自动开播监听的平台白名单在 `src/monitoring/constants.mjs` 的 `MONITOR_PLATFORMS`。

因此「新增平台」的真实改动面是：`src/platforms/<p>/` 一组文件 + 路由/能力声明 +
监控白名单 + UI/10 语言文案 + 测试 + EXE 验收脚本。这也正是新准入规范里「交付物清单」的来源。

## 5. Kick 预研结论

| 项目 | 许可证 | 维护（2026-11-16） | 结论 |
| --- | --- | --- | --- |
| `achrafthedev/kixo` | MIT | 2026-10-25 推送，活跃 | **最有参考价值**（2026 年协议现状：Centrifugo + Pusher 双路径） |
| `LOX-X/Kick-Live-Connector` | MIT | 2024-11-01 推送，停更约 2 年 | 字段结构佐证（`sender.id`/`sender.username`/UUID/`created_at`） |
| `Landy-Dev/kick-api` | Apache-2.0 | 2026-04-10 推送 | Rust + 官方 API → **不适配** |

官方 API（`docs.kick.com`）scope 里只有 `chat:write`、`events:subscribe`（webhook）、moderation，
**没有读取聊天的能力**；使用官方 API 还需创建应用 + OAuth → 违反「免登录」准入条件。
所以 Kick 的聊天只能走「与登录前访客相同的公开实时通道」，属于**非官方协议**，
必须按 `AGENTS.md` §6.12 口径标注「非官方 / 实验性 / 可能失效」。

三个核心准入条件在文档+源码层面均成立（免登录、有用户名、有实时聊天，且很可能有稳定 `sender.id`），
但**本仓库没有连接过 Kick、没有任何真实样本**，因此只能写 **G0 有条件通过、G1 未做**。

风险集中在：非官方端点一年内已迁移过一次（Pusher → Centrifugo）、guest token 有时效与限流、
无续传游标（重连可能漏消息）、唯一维护中的参考实现是 1 star 个人项目。

## 6. 建立的长期规范

`docs/PLATFORM_ADMISSION.md` 把平台开发固定为七个阶段（G0 调查 → G1 免登录 → G2 字段 →
G3 身份 → G4 重连/多房间 → G5 真实 EXE → G6 合并判断），并规定：

- 未通过 G0 不得写代码；
- 未真实验证一律标「待验证」，未见真实事件一律标 `NOT-OBSERVED`；
- 礼物是可选增强，缺少礼物不得否决能取到用户名 + 实时聊天的平台；
- 命中 8 条暂停条件即可暂停并继续调查后续候选，不得为凑数量降标准。

`AGENTS.md` 新增 §6.16（国际化三层分离）与 §6.17（新平台三准入条件）作为长期约束，
并在 §10 增加 5 条禁止事项（不得把计划写成已支持、不得仅凭 README 宣称支持、
不得绕过访问控制、不得复制不兼容代码、不得合并界面语言与输出语言）。

## 7. 测试与验证

| 运行 | 结果 |
| --- | --- |
| `node --test tests/unit` | ❌ `spawn EPERM`（沙箱禁止带管道 stdio 的子进程；`AGENTS.md` §5 已记录该受限情形） |
| `node --test --test-isolation=none "tests/unit/*.test.mjs"` | **687 passed / 0 failed / 0 skipped**（13,993.61 ms） |
| 定向 i18n + help-ui + ai-ui + ai-translation-ui | **20 passed / 0 failed** |
| 集成测试 | 未运行（本轮无代码改动，不据此宣称通过） |

687 与上一轮 §0.44 记录的 unit 数量完全一致，说明本轮文档改动没有影响任何断言。

## 8. 文档一致性检查

- `AGENTS.md` §7 原写「三语」→ 改为「清单驱动 + 当前三语/目标十语」，与 `docs/I18N.md` 一致；
- `ROADMAP.md` 的 P38–P44 与 `docs/I18N.md` §5、`docs/PLATFORM_ADMISSION.md` §4 的里程碑命名一一对应；
- `ARCHITECTURE.md` §10 与 `PLATFORM_INTEGRATIONS.md` §10 均指向新规范，避免出现第二套规则；
- `STATUS.md` §0.45 的每条事实都能在代码里定位到具体文件与行号；
- 全文未把任何未实现能力写成已完成；Kick 与其余 9 平台一律标「待验证 / 未连接」。

## 9. 下一轮建议

单一起点：**P39 / I18N-M0（国际化架构整理，不新增语言）**。

理由：它是七语言资源、AI 输出语言解耦、十语言 EXE 验收三者共同的前置；
改动范围清晰、可独立验收回滚；能一次性消除已定位的三个结构债。

若用户更希望先确认 Kick 的可行性，则可改为**只做 Kick G1 只读验证**（不写适配器、不动 UI），
但必须接受「之后每加一个平台都要补 7 种语言」的返工。
