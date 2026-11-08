# 交接文档（HANDOFF）

本轮：2026-11-08 · M0 + M1 · v0.1.0

## 1. 本轮目标

- 检查开发环境与参考仓库 `bili-gift-drop`
- 建立独立工程、文档体系与 AGENTS 规则
- 完成可运行的第一阶段成果：本地服务器、浏览器控制台、Apple 风格 UI、三语、主题、设置持久化
- 尽可能完成模拟直播与 SQLite 基础记录
- 验证 Windows EXE 打包方案
- 运行测试、同步文档、创建本地 Commit

## 2. 实际完成

### 工程
- 新仓库结构（零运行时依赖，Node ESM）
- `AGENTS.md`、README、MIT License、`.gitignore`、`start.cmd`
- 17 份 docs + `log/2026-11-08-m0-m1.md`
- 自动化测试 86 个，全部通过

### 运行链路
- `src/launcher/launcher.mjs`：环境检查 → 数据目录 → 单实例 → 端口 → 服务就绪 → 打开浏览器 → 状态输出 → 优雅退出
- `src/server/index.mjs:startServer()`：设置、数据库、迁移、崩溃恢复、会话管理、HTTP
- `src/storage/*`：`node:sqlite`、迁移 v1、仓储层
- `src/platforms/shared/ingest.mjs`：唯一写入管线（去重/聚合/金额）
- `src/platforms/mock/*`：模拟直播源
- `src/web/*`：5 页控制台、三语、三主题、图表、SSE 实时更新
- `src/ai/export/package.mjs`：`livememory-analysis-v1` 分析包（ZIP + 校验和 + 三语说明 + Schema）
- `scripts/build-windows.mjs` + `scripts/sea-bootstrap.cjs`：EXE 构建

### 实测
- 本地启动、`/api/*` 全链路、模拟记录、分析包解压校验、EXE 启动与单实例
- 无头 Edge 截图验证明亮/黑暗/中文/日语/390px 布局（`docs/screenshots/`）

## 3. 文件变化（主要）

```text
新增  AGENTS.md  README.md  LICENSE  .gitignore  package.json  start.cmd
新增  src/launcher/{launcher,console,cli-i18n,env-check,lock,data-dir}.mjs
新增  src/server/{index,app,http,routes,settings-store,logger,sse,paths,serializers}.mjs
新增  src/storage/database/{connection,migrations/index}.mjs
新增  src/storage/repositories/{sessions,events,viewers,ai-packages}.mjs
新增  src/analytics/{sessions/hotness,sessions/summary,payments/totals,viewers/profile}.mjs
新增  src/platforms/{shared/adapter,shared/ingest,shared/session-manager,mock/mock-source}.mjs
新增  src/ai/{export/package,prompts/instructions,schemas/analysis-result-v1.schema.json}
新增  src/shared/{app-info,errors,events,ids,locale,money,storage-mode,theme,time,zip}.mjs
新增  src/web/{index.html,favicon.svg,styles/*.css,js/**,i18n/*.json}
新增  tests/unit/*.test.mjs（12 个） tests/integration/*.test.mjs（3 个） tests/helpers/*
新增  scripts/{build-windows,sea-bootstrap,capture-ui}
新增  docs/*（17 份） log/2026-11-08-m0-m1.md docs/screenshots/*（4 张）
```

## 4. 技术决策（详见 docs/DECISIONS.md）

- **零运行时依赖 + Node SEA**：`node:sqlite` 与 `node:http` 内置，避免原生模块与 `npm install`，EXE 用官方 node.exe 注入。
- **设置存 JSON**（`config/settings.json`）而非数据库：启动器在数据库打开前就需要语言偏好。
- **单写入管线**：去重与金额聚合集中在 `EventIngest`，平台适配器无写库权限。
- **金额分账**：`currency` + `value_kind`（实际支付 / 展示价值），不混加。
- **前端无框架/无构建**：便于 SEA 打包与长期维护，UI 通过 token + 原生 JS 组织。
- **SSE 而非轮询**：实时动态；聚合仍由 HTTP 读取，重连不依赖事件回放。

## 5. 测试结果

- 86 / 86 通过（6.5s），命令见 `docs/TEST_PLAN.md`
- UI 截图 6 张（4 张已归档）：明亮中文桌面、历史详情、黑暗日语设置、中文 390px
- EXE：构建成功，`--version`、单实例、API、静态资源已验证

## 6. 遗留问题

1. 真实 `Ctrl+C` 未自动化验证（代码路径与 `close()` 已测）。
2. EXE 未在干净 Windows 机器验收；未签名。
3. 动态端口未回写设置。
4. 真实平台未接入（M3）。
5. AI 导入、备份恢复、自动清理未实现（M5–M7）。
6. 截图依赖临时放宽沙箱，正常开发不受影响。

## 7. 下一轮建议

**优先 M3 的 Bilibili 最小闭环**：

1. 对照 `.ref/bili-gift-drop` 的 `login.mjs`、`bilibili.mjs`、`protocol.mjs`、`wbi.mjs`，实现 `src/platforms/bilibili/`：
   - 扫码登录（`qrcode/generate` + `poll`），Cookie 仅内存 + 可选加密保存
   - `room_init` → `getDanmuInfo`（WBI 签名）→ WebSocket 分片解码
   - `DANMU_MSG` / `SEND_GIFT` / `SUPER_CHAT_MESSAGE` / `GUARD_BUY` → canonical event
2. 用真实直播间验证 UID、昵称、礼物金额单位、大航海等级字段。
3. 把身份缺失/金额单位不确定的情况写入 `source_quality`，不猜测。
4. 为适配器补单元测试（协议包解码、消息映射、去重键），并更新 `PLATFORM_INTEGRATIONS.md` 的验证状态。
5. 保持模拟平台可用，作为无凭据演示与回归测试基座。

## 8. 启动验证方法

```bat
:: 开发
start.cmd

:: 指定独立数据目录（推荐用于验证）
node src/launcher/launcher.mjs --no-open --data-dir D:\temp\livememory-test

:: 期待输出：产品名/版本、数据目录、控制台地址、记录状态、退出方式
:: 浏览器打开控制台地址 → 直播记录 → 开始模拟直播
```

```bat
:: 测试
node --test --test-isolation=none tests/unit/*.test.mjs tests/integration/*.test.mjs
```

```bat
:: EXE
node scripts/build-windows.mjs
dist\LiveMemory.exe --no-open --data-dir D:\temp\livememory-exe
```
