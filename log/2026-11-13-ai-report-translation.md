# 2026-11-13 · AI 分析多语言输出与已保存报告翻译

## 1. 目标与审计

需求：在现有 v0.13.2 自动分析、单场报告、长期画像、三语 Prompt、Provider 与持久化机制上增量实现：

1. 新分析按用户选择的输出语言生成（功能 A）；
2. 已保存报告可按需切换阅读语言，不重新分析（功能 B）；
3. 长期画像可安全切换展示语言，不改变事实/身份/topic/版本/证据。

审计结论：

- 已有三语 Prompt、任务 `locale`、Session/Memory 独立 Job、报告只读读模型、长期记忆事实操作/证据/版本。
- 已有 AI 中心的分析语言选择，但 UI 文案易与界面语言混淆；Prompt 未明确任意/混合语言原文无需逐条翻译。
- 报告页没有阅读语言；长期画像只能按原语言阅读；没有翻译缓存、分段失败恢复、独立 usage/费用。
- 因此不重做分析系统：只补 Prompt 规则、UI 文案、报告读模型翻译层、翻译服务、独立缓存表与报告 UI。

## 2. 功能 A：分析输出语言

- `src/ai/prompts/split.mjs`（Prompt v13.2）新增规则：
  - 聊天/摘录可能是中文、日语、英语或混合语言；
  - 直接理解原意并用 `locale` 输出，不逐条预翻译；
  - JSON 键名/枚举/稳定 ID/证据编号不变。
- `src/ai/constants.mjs`：`lm-prompt-v13.1` → `lm-prompt-v13.2`（旧任务保留原版本号）。
- `src/ai/api/runner.mjs`：`getStatus()` 返回任务 `locale`。
- `src/web/js/pages/ai.js`：标签改为「分析输出语言」，增加说明；状态区显示「本次任务输出语言（已随任务保存）」。
- Session 与 Memory 仍共用 runner 中的 `entry.locale`；Resume 不接收/不改写 locale。

## 3. 功能 B：报告翻译

新增：

| 文件 | 职责 |
| --- | --- |
| `src/ai/translation/fields.mjs` | 可翻译字段提取/应用、源 hash、状态汇总、文本清洗 |
| `src/ai/translation/apply.mjs` | 报告读模型与缓存/运行状态的只读桥接 |
| `src/ai/translation/service.mjs` | 按需翻译服务：缓存检查、分块、Provider 调用、重试、独立 usage、进度 |
| `src/storage/repositories/ai-translations.mjs` | 翻译条目/运行 SQL |
| `src/storage/database/migrations/index.mjs` | schema 14：`ai_translations` / `ai_translation_runs` |

修改：

- `src/analytics/ai/report.mjs`：新增 `locale/providers` 选项；报告返回 `reportLocale`、`displayLocale`、`translation`；长期画像项增加只读 `memoryId`；应用缓存仅替换自然语言字段。
- `src/server/index.mjs`：构建/关闭 `ReportTranslationService`；暴露 getter。
- `src/server/routes.mjs`：报告 `locale` 参数；新增翻译状态/启动路由；错误映射。
- `src/web/js/pages/ai-report.js`：报告语言选择器、原文/翻译 chip、费用提示、勾选、进度、失败重试、显示原文。
- `src/web/js/pages/ai.js`：独立 `reportLocale`、翻译状态轮询、错误、清理。
- `src/web/i18n/{zh-CN,ja,en}.json`：三语键（分析输出语言说明、报告语言、翻译状态/费用/错误/原因）。
- `src/web/styles/pages.css`：报告语言/翻译面板/窄屏样式，使用 tokens。

## 4. 缓存与安全设计

缓存键：

```text
target_kind + target_id（ai_results.id / viewer_memories.id / memory_facts.id）
+ item_path + target_locale + source_hash（SHA-256）
+ translator_version（lm-translation-v1）
```

- 原始结果新版本 → 新 `ai_results.id`；事实文本变化 → 新 hash；旧翻译不会应用到新内容。
- 成功段落立即保存；失败段落标记 `failed`；重试只请求缺失/失败段落。
- 翻译只写展示缓存；不写 `ai_results` / `viewer_memories` / `memory_facts`；不调用事实操作；不创建分析 Job。
- 不翻译：`viewer_id`、`topic`、事实 ID/状态/certainty/版本/证据/时间/金额/计数/置信度/枚举/原始聊天。
- 翻译返回只按 JSON 解析、控制字符清理、长度上限；前端 `textContent` 渲染。
- 翻译 usage/费用存 `ai_translation_runs`，不进入 `ai_jobs`；未知价格 `cost=null`，界面显示「费用未知」。
- 首次翻译要求 `consent:true`；UI 明确提示调用 AI 模型并可能产生费用。

## 5. 数据生命周期

- `ai_translations` / `ai_translation_runs` 的 `session_id` 外键 `ON DELETE CASCADE`；删除单场时显式删除并纳入 residue 检查。
- `deleteMemory()` 同步删除该 `memory_summary` 与事实翻译，保留墓碑。
- `maintenance` 清空数据/恢复出厂包含两张表；备份/迁移随整库复制。
- v13→v14 只新增表与索引，不改写历史行。

## 6. 测试

命令：

```bat
node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"
```

结果：**649 passed / 0 failed**，约 155 秒（2026-11-13）。

新增：

- `tests/unit/ai-translation.test.mjs`（6）：字段提取、结构不变、stale hash、状态、文本清洗、分批报告字段定位。
- `tests/unit/ai-translation-ui.test.mjs`（2）：选择器/进度/失败重试/费用提示/三语键/无 innerHTML。
- `tests/integration/ai-report-translation.test.mjs`（7）：日语→中文、原文不变、缓存复用、双语切换、部分失败只重试失败段、新版本隔离、缺失 Provider/无 Key/网络失败、证据清理、Schema 1.1.0、Session/Memory 同 locale、删除记忆清理翻译。
- `tests/integration/ai-translation-migration.test.mjs`（2）：v13→v14、场次级联。

更新 schema 断言：`ai-api`、`memory-api`、`ai-migration`、`memory-migration`、`monitoring-migration`、`platform-status-migration`、`migration-emotes`、`broadcaster-identity`、`history-management`。

## 7. 未验证 / 限制

- **真实付费 Provider 翻译未执行**：本机无 Key；全部为 Mock fetch，不代表真实模型翻译质量、429/超时恢复或费用精度。
- **真实浏览器 UI 未验收**：本机沙箱阻止浏览器命名管道；窄屏/主题/选择器交互由静态断言与 HTTP 接口覆盖，未截图。
- **正式 EXE 未重建**：`dist/LiveMemory.exe` 仍为上一构建（schema 13）；发布前必须重建，否则不能读取 schema 14。
- **旧历史英文事实**不自动批量翻译；按需展示翻译，原事实不变。
- 原文语言来自主结果/任务 locale，不自动检测每条弹幕语言；翻译 Prompt 接受任意/混合语言。
