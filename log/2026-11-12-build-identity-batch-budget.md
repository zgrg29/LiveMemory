# 2026-11-12 · v0.13.2 构建可验证与分批预算重平衡

## 0. 本轮目标

只修复两项已确认问题，不增加新功能：

1. 用户实际运行的 EXE 是 87bec0c，不是 fd8aedc；版本号 0.13.1 无法区分。
2. fd8aedc 的 8,000 总输入预算在真实 889 消息包上只剩约 807 tokens 给聊天，规划出约 125 批。

## 1. 构建/版本识别

### 1.1 实现

- 新增 `src/shared/build-info.mjs`：开发读 `.git/HEAD`，打包读 `build-info.json` 与 bootstrap 环境；`buildId = <commit7>.<sourceHash8>`。
- `scripts/build-windows.mjs`：
  - 逐文件 SHA-256；
  - sourceHash 覆盖 `src/**` + `scripts/sea-bootstrap.cjs`；
  - manifest 增加 `fileHashes`、`build`（commit/builtAt/sourceHash/bootstrapHash/assetHash/buildId）；
  - 断言 7 个可靠性模块存在；
  - 构建后检查 EXE 字节流包含 buildId 与 `src/ai/batching/tokens.mjs`、`src/ai/runtime/stream.mjs`。
- `scripts/sea-bootstrap.cjs`：
  - 复用缓存前 `verifyTree` 全量 SHA-256；
  - 不一致 `app-root.stale` → 删除 → 重新解压；
  - 解压到 staging 后再次校验，失败 `ASSET_HASH_MISMATCH`；
  - 写 `build.identity` 日志，设置 `LIVE_MEMORY_BUILD_*` 环境。
- 展示：启动日志 `startup.begin`/`launcher.start`、`--version`、设置页关于、`/api/health`、`/api/bootstrap`、`/api/status`。
- 旧缓存不会被复用：旧 hash 目录不同；同 hash 被污染会被校验发现并重建。

### 1.2 实测

最终构建：

| 项目 | 值 |
| --- | --- |
| SHA-256 | `06e7ecb29e835378d65d94c193158392a06a9c646e67e3bdb46c0d4030ba640c` |
| commit | `090aadf8cf51c54ebd56557f887d547338b780be` |
| buildId | `f5bbd685abe2` |
| assetHash | `f5bbd685abe2032b237b` |
| builtAt | 2026-11-12T09:41:52.970Z |
| 资源 | 169 files / 7 必需模块 / requireAdministrator |

本会话非提升，复制 EXE 并把 RT_MANIFEST 改为 asInvoker 后实际启动：

- `--version`：`Build ID: f5bbd685abe2`；
- `/api/health`、`/api/bootstrap`：同一 buildId、commit，`mode=packaged`、`verified=true`；
- 启动日志 `startup.begin` 含同一 build；
- 第二次启动 `app-root.reuse` + `filesVerified=169`；
- 打包后的 `tokens.mjs` 中 `DEFAULT_BATCH_INPUT_TOKENS = 24000`，`batching/`、`stream.mjs`、`attempt.mjs` 均存在。

仍不能声称：真实 UAC 双击、提升后的出站请求。

## 2. 分批预算

### 2.1 模型

`planBatchBudget` 把请求拆成：

- 固定 overhead（instructions + session_context + answer schema + wrapper，实测 7,193）；
- content（至少 1,000，且至少 50% 配置总预算）；
- output reserve（session 8,000 / memory 6,000，单独参与上下文计算）。

默认总输入 24,000；仍可配 2,000–32,000；上下文装不下时报 `ANALYSIS_CONTEXT_TOO_SMALL`。

### 2.2 真实 889 消息包离线规划

包：`LiveMemory-Session-XJC3158W-RD1M3M-20261112-1418-ja.zip`，889 消息，94,137 估算消息 tokens，overhead 7,193。命令：

```bat
node scripts/plan-batches-offline.mjs <session.zip>
```

| 总预算 | 有效输入 | 内容 | 批次数 | 平均消息/批 | 最大单批 | 估算总输入 | 1.366 校准 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 8,000 | 11,193 | 4,000 | 24 | 37.0 | 11,192 | 266,769 | 364,406 |
| 16,000 | 16,000 | 8,807 | 11 | 80.8 | 15,997 | 173,260 | 236,673 |
| **24,000** | **24,000** | **16,807** | **6** | **148.2** | **23,949** | **137,295** | **187,545** |
| 32,000 | 32,000 | 24,807 | 4 | 222.3 | 31,988 | 122,909 | 167,894 |

每档 889/889 覆盖，消息不丢不重；不再出现 125 批；没有退回 135k 单请求（上限 32k）。

### 2.3 规模保护

- aggregate：48k 硬上限 + 上下文检查，超过 `ANALYSIS_AGGREGATE_TOO_LARGE`；
- repair：保留原批 prompt 与错误，只截断上次回答（2k–12k 字符），超限 `ANALYSIS_REPAIR_TOO_LARGE`；
- 单观众：可独占一批，但 >48k 时报 `ANALYSIS_MEMORY_VIEWER_TOO_LARGE`，不丢观众；
- 单条消息本身超预算时独占一批，日志可见。

## 3. 输出规模与思考模式

阿里云官方文档（2026-11-10 版）确认：

- Qwen `max_tokens` 只限制**回答**；思考内容在 `reasoning_content`，单独计费；
- `qwen3.8-max` 默认 `reasoning_effort=xhigh`、`thinking_budget=131072`；
- 因此平台 18,684 output 与历史单请求 9,936/12,734 都大于 `max_tokens=8000`，8k 不是总输出上限。

实现：

- DashScope 请求增加 `max_completion_tokens = 回答 + 16,000`（session 24k / memory 22k），不关闭思考；
- 其他 Provider 不发送该参数；
- 流式只统计 `reasoning_content` 长度，不保存内容；
- attempt 日志新增 requestBytes / estimatedInputTokens / maxTokens / maxCompletionTokens / reasoningChars / reasoningTokens；
- `viewer_profiles` 在 session prompt 中明确为可选批内高亮；124 位观众的完整覆盖由 memory 批次保证。

## 4. 测试

- 全量 **597 passed / 0 failed**（约 93 秒）。
- 新增：`build-info`、`ai-adapter-output`、`ai-repair-guard`；`ai-token-batching` 增加 889/124/硬上限；`bootstrap` 增加缓存篡改重解压。
- 已有超时/流式/恢复/回退测试全部通过：超时不重发、流中断不导入、已完成批次恢复、流式回退一次且可观察。

## 5. 未验证

- 真实付费 API：`max_completion_tokens` 是否被百炼接受、思考模式是否仍默认开启、24k/6 批能否全部完成；
- 真实 UAC 双击与提升后的出站请求；
- 真实 889 消息付费回放。

## 6. 结论

两个核心问题均已修复并有可验证证据：

1. EXE 现在携带 commit + sourceHash buildId，启动/关于/HTTP 都能核对；缓存逐文件校验，旧模块不会被复用。
2. 真实 889 消息在默认 24k 下是 6 批，而不是 125 批；8/16/24/32k 全部覆盖 889/889。

不能声称真实付费 API 已验收；下一步应由用户批准一次小规模真实回放。
