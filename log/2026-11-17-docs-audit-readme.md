# 文档审计与 README 重构（2026-11-17）

## 目标

按用户要求核验仓库真实状态，重构 README 为面向 GitHub 用户的三语首页，并对齐 STATUS /
HANDOFF / ROADMAP / RELEASE / I18N / PLATFORM_INTEGRATIONS 等文档。**不修改软件功能、
业务逻辑、许可证或发布状态。**

## 真实状态核验

- 版本：`package.json` = `APP_VERSION` = `0.17.0`。
- 最新发布：`v0.17.0`，Release ID `448828056`，Published `2026-11-17T15:31:37Z`；
  资产 `LiveMemory.exe`（99,492,352 B，SHA-256 `58b21dc9…830471ac`）与 `SHA256SUMS.txt`。
- 平台：六个已发布（Bilibili / YouTube / Twitch / 抖音 / TikTok / Kick）；
  快手为预览，实时 H5 采集默认禁用（`connect` 在请求前 403）。
- 语言：十种界面语言与十种独立 AI 输出语言；十份字典各 2,351 键。
- Schema：16（v0.17.0 无迁移）。
- Git：`main` 与 `origin/main` 同步；`v0.17.0` tag `4cf356a` → `5807e3e`。

## 发现并修正

1. README 语言顺序为 中文 → 日文 → 英文，且大量历史版本/实现细节；已重写为
   English → 简体中文 → 日本語，补充下载、UAC、快速开始、平台表、AI、隐私、FAQ、支持入口。
2. `docs/RELEASE.md` 混合发布流程与 v0.13.2-rc.0 / v0.14.0 / v0.15.0 证据，且仍写三语验收、
   zip 资产与旧版限制；已拆为 `docs/RELEASE.md`（流程）+ `docs/RELEASE_HISTORY.md`（证据）。
3. `docs/I18N.md` 写「v0.15.0 为 2,304 键」；实际 v0.15.0 为 2,271，v0.16.0 为 2,304，
   v0.17.0 为 2,351。已修正并注明版本来源。
4. `docs/WINDOWS_RUNTIME.md` §10 仍要求验证 asInvoker，§9 指向 §12；当前规则为
   requireAdministrator、当前证据在 §13。已修正。
5. `docs/PLATFORM_INTEGRATIONS.md` 顶部状态停留在早期平台，未覆盖抖音/Kick/快手；
   已新增 §0 当前平台总表，旧章节保留为详细协议记录。
6. `docs/TEST_PLAN.md` 的 v0.15.0 小节把 2,351 键写成该版本结果；已改为 2,271。
7. STATUS 的 RC0 小节标题写「未发布」，但 GitHub Release `445425123` 已发布；
   保留当时记录并加历史修正说明。
8. AGENTS 中版本/平台/键数等动态信息重复维护；改为引用 STATUS §0、
   PLATFORM_INTEGRATIONS §0 与 `src/shared/locales.mjs`，并新增文档职责表。
9. STATUS / HANDOFF / ROADMAP 增加当前状态/当前阶段/历史分隔，避免把阶段结论当当前事实。

## 变更文件

- `README.md`：三语首页重构。
- `docs/RELEASE.md`：纯发布流程。
- `docs/RELEASE_HISTORY.md`：新增，归档五次发布证据。
- `docs/STATUS.md`：新增 §0 当前状态快照；历史分隔与 RC0 修正。
- `docs/HANDOFF.md`：新增本轮交接；旧交接标历史。
- `docs/ROADMAP.md`：新增当前阶段与下一步；P51 发布结果修正。
- `docs/PLATFORM_INTEGRATIONS.md`：新增 §0 平台总表。
- `docs/I18N.md`、`docs/TEST_PLAN.md`、`docs/WINDOWS_RUNTIME.md`：数字/规则修正。
- `docs/CHANGELOG.md`：顶部说明历史 README 迁移去向。
- `docs/DECISIONS.md`：ADR-038 文档职责分离。
- `scripts/check-docs.mjs`：新增文档一致性检查（非运行时脚本）。

## 验证

- `node scripts/check-docs.mjs`：README 语言顺序 PASS；103 个相对链接 PASS；版本一致性 PASS；
  10 × 2,351 键集/占位符 PASS。
- `node --test --test-isolation=none tests/unit/i18n.test.mjs tests/unit/locale-registry.test.mjs
  tests/unit/locale.test.mjs tests/unit/ai-prompt-locales.test.mjs`：**51 passed / 0 failed**。
- README 经 GitHub Markdown API 渲染：3 个语言 H2、6 个表格（3 平台表 + 3 文档表）、无坏锚点。
- `git diff --check`：通过。
- `src/`、`tests/`、`package.json`、`dist/` 未修改；未 Push、未创建 Tag/Release。

## 未做 / 限制

- 未重跑 1,226 项全量测试（本轮无代码变更）；历史测试结果仍以 STATUS/RELEASE_HISTORY 记录为准。
- 未在真实浏览器中逐页点击 README；使用 GitHub Markdown API 渲染与本地链接/表格检查。
- 真实 Windows UAC、干净账户、真实 Provider、快手许可验收仍为待办。
