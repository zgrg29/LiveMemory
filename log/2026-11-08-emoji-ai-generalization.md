# 开发日志 · 2026-11-08 · 聊天表情兼容 + AI 分析中心通用化

## 1. 本轮目标

- P1：确保 Bilibili / YouTube 的普通文字、Unicode Emoji 与平台专属表情被正确记录、显示并传给 AI。
- P2：把 AI 分析中心改造成与具体 AI 服务无关的通用文件分析工作流。
- 文本优先，不做表情图片下载/缓存；不破坏既有启动、UI、SQLite、金额、去重、Bilibili 接入与 AI 导出。

## 2. 真实数据先行

没有直接假设 Bilibili 使用图片或只有文字。新增 `scripts/probe-bilibili-emotes.mjs`，对真实房间 `5050` 匿名采样：

- 35 秒：32 条 `DANMU_MSG`，其中 21 条带 `info[0][13]`；
- 15 秒：22 条，其中 19 条带 `info[0][13]`；
- `info[0][13]`：`emoticon_unique`、`url`、`width`、`height`、`is_dynamic`、`bulge_display`、`in_player_area`；
- `info[1]`：表情文字标签（「就这」「乐」「Wow」），不是 `[xxx]` 代码；
- `dm_v2`：全部为空字符串；
- 平台提供图片 URL，但本轮明确不下载。

结论：Bilibili 平台表情的正文已经是可读文字，最简单可靠的方案是**保留原文 + 保存 `emoticon_unique` 与文字标签**，而不是引入图片下载。

## 3. 实现

### 3.1 文本与 Emoji

- 新增 `src/shared/text.mjs`：`cleanText` / `truncateText` 按 grapheme 截断；优先 `Intl.Segmenter`，回退按 code point 并去掉悬空 ZWJ。
- 修复旧 `.slice(0, 4000)` 可能切断 surrogate pair / ZWJ 的缺陷。

### 3.2 表情元数据

- 新增 `src/shared/emoticons.mjs`：
  - `normalizeEmotes` 限制每条 20 个、按 id/code/name 去重；
  - `emoteKey` 为 AI 包字典生成稳定 key；
  - `buildAiReadableContent` 只在原文不足时追加名称；未知 id 标记未知，不猜情绪。
- 新增 schema v2 迁移：`ALTER TABLE events ADD COLUMN emotes TEXT`。
- `EventIngest` 单写入路径不变；表情元数据参与指纹去重。
- `purgeSessionContent` 同时清空 `content` 与 `emotes`。

### 3.3 Bilibili

- `readBilibiliEmotes(info, content)`：
  - 只认 `info[0][13]`；
  - 有 `[括号]` 时优先括号内名称，否则用正文标签；
  - 纯表情、正文为空也返回 chat draft；
  - 无元数据时 `emotes=null`，普通 `[文字]` 不误判。
- 未解码 `dm_v2`；采样为空，不伪造 id。

### 3.4 YouTube

- 新增 `src/platforms/youtube/mapper.mjs`：纯函数，支持 `textMessageDetails.messageText` / `displayMessage`、Unicode Emoji、`:code:` 自定义表情、channelId。
- 无传输层/OAuth/轮询；所有事件 `unknown` + `verified=false`；测试明确标记 `unverified`。

### 3.5 AI 包

- `session_context.emote_dictionary` 去重；
- `messages.jsonl` `emote_refs`；
- 只有原文不足时 `content_ai`；
- `manifest.counts.messages_with_emotes` / `emote_kinds`；
- 三语 instructions 增加 Emoji/表情、经济支持、数据可靠性规则；
- 包大小测试：200 条重复表情只保留 1 个字典条目，消息只带短引用。

### 3.6 AI 分析中心

- i18n 三语移除 ChatGPT 绑定，统一 AI 分析中心 / AI 分析包 / AI 分析指令 / AI 分析结果。
- 新增任务说明卡（5 条自然语言任务 + 表情说明 + AI 服务选择）。
- 复制按钮改为「复制 AI 分析指令」。
- 导入仍明确标注 M6。

### 3.7 UI 细节

- 直播动态只让最新一条执行进入动画，避免每次 SSE 重绘导致整列淡入闪烁。
- 纯表情消息回退「平台表情：名称/id」。
- 新增 `ai-light-zh-CN.png`、`ai-dark-ja.png`、`ai-mobile-light-zh-CN.png`、`live-emoji-light-zh-CN.png`。

## 4. 测试结果

```text
tests 195
pass  195
fail  0
duration ≈ 5.7s
```

EXE：

```text
dist/LiveMemory.exe 89.9 MB
sha256 9477dbcb6a6b80d909800e7fab43f71fd7d8c9de63eb5c4a3f8d63d20922cf2d
verify-exe: 9 passed, 0 failed
fresh data-dir: schema=2, AI instructions contain emoji rules
EXE end-to-end: 42 messages, 2 platform emotes, emote_refs verified
```

## 5. 未验证

- Bilibili 其他房间/全局表情/粉丝牌表情/动态表情图片、`dm_v2`。
- 礼物/SC/大航海真实事件、`SEND_GIFT_V2`。
- YouTube 真实 API/OAuth/配额/分页。
- AI 结果导入、Schema 校验、分批、长期画像。
- 干净 Windows 环境 EXE 验收、代码签名、真实 Ctrl+C。
