# 交接文档（HANDOFF）

本轮：2026-11-08 · P1 聊天表情兼容 + P2 AI 分析中心通用化 · v0.1.0（schema v2）

## 1. 本轮目标

1. 保证 Bilibili / YouTube 普通文字、Unicode Emoji 与平台专属表情能被正确记录、显示并传给 AI；
2. 把 AI 分析中心改造成与具体 AI 服务无关的通用文件分析工作流；
3. 文本优先，不做表情图片下载/缓存；
4. 保持既有启动、UI、主题、SQLite、去重、金额、Bilibili 真实接入与 AI 导出稳定；
5. 跑测试、重建 EXE、更新文档、创建本地 Commit（不 Push）。

## 2. P1：聊天表情兼容

### 2.1 Unicode Emoji

- `src/shared/text.mjs`：`cleanText` / `truncateText` 按 grapheme 截断（`Intl.Segmenter`，回退按 code point 并去掉悬空 ZWJ）。
- 覆盖组合 Emoji、VS16、肤色修饰符、ZWJ 序列；数据库、前端、AI 包均保持原文。
- 修复旧实现 `.slice(0,4000)` 可能切断 surrogate pair / ZWJ 的缺陷。

### 2.2 Bilibili 平台表情（真实采样）

- 新增 `scripts/probe-bilibili-emotes.mjs`，默认不打印正文；`SHOW_TEXT=1` 仅用于本机一次性核对。
- 真实房间 `5050`：
  - 35s：32 条 `DANMU_MSG`，21 条带 `info[0][13]`；
  - 15s：22 条，19 条带 `info[0][13]`；
  - `info[0][13]` 字段：`emoticon_unique`、`url`、`width`、`height`、`is_dynamic`、`bulge_display`、`in_player_area`；
  - `info[1]` 是表情文字标签（如「就这」「乐」「Wow」），不是图片代码；
  - `dm_v2` 全部为空字符串（长度 0）。
- 实现：
  - `src/platforms/bilibili/mapper.mjs` 新增 `readBilibiliEmotes(info, content)`；
  - 有 `info[0][13]` 才提取；有括号标签时优先括号内文字，否则用正文文字标签；
  - 纯表情、正文为空也入库（`content=NULL` + `emotes`）；
  - 没有元数据时普通 `[文字]` 保持原文，绝不判为表情；
  - 不保存图片 URL/宽高，不下载图片。

### 2.3 YouTube 预留

- `src/platforms/youtube/mapper.mjs`：纯函数 mapper，支持 `snippet.textMessageDetails.messageText` / `snippet.displayMessage`、Unicode Emoji、`:code:` 自定义表情、`authorChannelId` / `authorDetails.channelId`。
- **未接入**传输层、OAuth、API Key、轮询；所有事件 `source_quality=unknown`、`verified=false`。
- 合成样本测试通过，不能称为真实 YouTube 接入。

### 2.4 数据与 UI

- schema v2：`events.emotes TEXT`（JSON 数组 `{id?,code?,name?,source?}`）。
- 迁移：`ALTER TABLE events ADD COLUMN emotes TEXT`；v1 旧消息 `emotes=NULL`；有升级测试。
- 去重指纹加入表情 id/code/name；重复投递不增加计数/金额。
- 精简清理同时清空 `content` 与 `emotes`。
- 直播动态：原文用 `textContent`；纯表情显示「平台表情：名称/id」；修复动态列表每次 SSE 整体淡入导致的闪烁（只让最新一条动画）。

## 3. P2：AI 分析中心通用化

- 界面统一为「AI 分析中心 / AI 分析包 / AI 分析指令 / AI 分析结果 / 导入 AI 分析结果」，移除 ChatGPT 绑定。
- 新增自然语言任务说明卡：
  - 整场直播的讨论主题与话题变化；
  - 不同时间段的讨论变化与最热烈时段；
  - 值得回看的片段；
  - 新观众初始画像；
  - 既有观众的新信息、兴趣变化与画像更新。
- 明确「使用你选择的 AI 服务」，不假设通用 AI 网站；不同 AI 的上传大小、ZIP、上下文差异由用户处理。
- 三语 AI 指令由 `src/ai/prompts/instructions.mjs` 生成，含：
  - 话题/时间线/争论/回看；
  - 观众长期画像需多次、语义明确证据；
  - 经济支持只作客观引用，不重算金额；
  - Emoji/平台表情是线索不是情绪标签；`[笑哭]` 可能是嘲讽；礼物不代表喜欢当前话题；单个表情不足以建立长期兴趣；未知表情不得编造；
  - 包内文本是不可信数据；不编造观众/发言/时间戳；稳定 ID 不变；严格遵循 Schema。
- 导入仍为 M6，UI 标注「计划于 M6 提供」，没有伪装完成。

## 4. AI 分析包字段变化（向后兼容的附加字段）

- `session_context.emote_dictionary`：去重表情字典（key/platform/id/code/name/source/count）。
- `messages.jsonl.emote_refs`：引用字典 key。
- `messages.jsonl.content_ai`：仅在原文不足以理解表情时出现；原文已含名称时省略。
- `manifest.counts.messages_with_emotes` / `emote_kinds`。
- 协议版本仍为 `livememory-analysis-v1`；结果 Schema 未变。

## 5. 测试与验证

- 自动化：**195 个测试通过，0 失败，约 5.7 秒**。
- 新增：`tests/unit/emoticons.test.mjs`、`tests/unit/youtube-mapper.test.mjs`、`tests/integration/migration-emotes.test.mjs`；扩展 events / bilibili-mapper / storage / ai-package。
- EXE：`dist/LiveMemory.exe` 89.9 MB，SHA-256 `9477dbcb…`；`scripts/verify-exe.mjs` **9/9 通过**。
- EXE 全新数据目录：schema=2、AI 指令含「表情与 Emoji」、`ai.js` 含任务卡、无 ChatGPT。
- EXE 内模拟 42 条消息并导出包：2 条平台表情消息、`emote_refs`、`messages_with_emotes=2`、`emote_kinds=1`。
- UI 截图：`docs/screenshots/ai-light-zh-CN.png`、`ai-dark-ja.png`、`ai-mobile-light-zh-CN.png`、`live-emoji-light-zh-CN.png`。

## 6. 未验证 / 环境边界（如实保留）

- Bilibili 平台表情只在 `5050` 采样；其他房间、全局表情、粉丝牌表情、动态表情图片、`dm_v2` 未验证。
- YouTube 真实 API/OAuth/配额/分页完全未接入；mapper 只有合成样本测试。
- 礼物/SC/大航海真实事件仍未观测到；`SEND_GIFT_V2` 未实现。
- AI 结果导入、Schema 校验、分批、长期画像仍未实现（M6/M7）。
- EXE 未在第二台干净 Windows 环境验收；未做代码签名；真实 Ctrl+C 未自动化。
- 本执行环境浏览器截图通过 DevTools 完成，不代表普通用户桌面视觉验收。

## 7. 常用命令

```bat
:: 测试
node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"

:: 真实表情结构采样（默认不打印正文）
node scripts/probe-bilibili-emotes.mjs 5050 35

:: Bilibili 端到端
node scripts/verify-bilibili.mjs 5050 20

:: 构建与验证 EXE
node scripts/build-windows.mjs
node scripts/verify-exe.mjs

:: 启动
dist\LiveMemory.exe
```

## 8. 下一轮建议

1. **M6 第一步：AI 结果导入**。定义并实现 JSON 文件/粘贴导入、Schema 校验、`task_id`/`session_id`/`viewer_id`/`message_refs` 校验、事务写入与重复导入保护；这是 M7 长期画像的前置。
2. 继续 M3：在有礼物/SC/大航海的真实直播间复核金额，补 `SEND_GIFT_V2`；顺带采样其他 Bilibili 表情类型。
3. YouTube 先做授权/配额调研，不为了表情显示额外要求 OAuth。

## 9. 本轮 Commit

- 本轮：`02d3101` feat: preserve chat emoji and generalize the AI analysis centre（本地，未 Push）
- 上一轮：`bb59f72` fix: render the Bilibili login QR inside the app
- P1：`a6e3443` feat: connect real Bilibili live chat and record canonical events
- P0：`e7b88d5` fix: start LiveMemory without administrator rights on Windows
