# 长期观众画像语义质量专项（RC0-MEMORY-QUALITY）

日期：2026-11-14 · schema 16（无迁移）· 结果 Schema 1.3.0 · 提示词 v13.2（未改）

> **执行边界**：本轮只做离线审计、合成数据、Mock/集成测试与归档真实结果的重新评分。
> **未调用任何真实付费 Provider，未修改生产数据库，未发送真实观众聊天，未 Push/Tag/发布。**
> 归档真实结果来自上一轮用户已授权的 DeepSeek `deepseek-flash` 测试（`tests/.tmp/paid-p03`），
> 本轮只读评分，不产生新费用。

## 1. 标准答案集设计

### 1.1 两套标注

| 数据集 | 用途 | 规模 |
| --- | --- | --- |
| `tests/fixtures/memory-quality/gold-corpus.mjs` | 本轮新建的 15 类场景标准答案集，供未来真实模型对照 | 16 位观众 / 3 场次 / 70 条消息 / 30 条当前事实 + 6 条被替代事实 / 11 条重要事实 / 1 条歧义 / 26 条不应保存消息 |
| `tests/fixtures/memory-quality/p03-retro-gold.mjs` | 对上一轮 16 句合成模板的事后标注，用于离线重评归档真实结果 | 25 位观众 / 200 条消息（zh-CN）；60 位 / 600 条（ja） |

两套标注都**不在模型输入中**。集成测试会读取实际 ZIP 包，断言包内不出现
`shouldPersist`、`f-haru-cs` 或标准答案中的独有句子。

### 1.2 覆盖的 15 类场景

| # | 场景 | 语料位置 |
| --- | --- | --- |
| 1 | 明确长期兴趣 | haru 吉他、lin RPG、yuki 画画、sora 吉他 |
| 2 | 职业/学习 | haru 研究生、mika 护士、ken 厨师、lin 高中生、nick_a 学日语 |
| 3 | 未来计划 | haru 日本旅行、mika 认定护士考试、lin Switch 2、yuki 美专、tomo 日本一周、mei 英国读研 |
| 4 | 长期偏好 | ken 讨厌恐怖游戏、aoi 辣食、sora 原声吉他、kai 辣食 |
| 5 | 临时情绪 | mika“今天累”、lin“今天困”、mei“面试紧张”、tomo“雨天忧郁” |
| 6 | 玩笑/反讽 | ken“百万富翁”、aoi“大阪女王”、sora“职业吉他手”、kai“CEO” |
| 7 | 否认此前信息 | aoi 先称住大阪，后称“是玩笑，其实住名古屋” |
| 8 | 更新旧事实 | ken 厨师→糕点师；mika 夜班→白班；mei 计划→offer；nick_a 学日语→N2 |
| 9 | 多位观众同一主题 | 吉他（haru/sora）、贝斯（multi）分别归属，不合并 |
| 10 | 同一观众跨场次 | haru/mika/ken/lin/aoi/yuki/nick_a/nick_b/mei 跨 2–3 场 |
| 11 | 中日英混合 | 同一语料内 zh/ja/en 混排；输出按 locale |
| 12 | 高频/低频观众 | haru 14 条、spam 15 条、yuki 2 条、tomo 2 条 |
| 13 | 大量无意义短消息 | spam 的 `wwww`/`草`/`888`/emoji |
| 14 | 昵称变化/同名 | haru 三次改名仍同一 ID；nick_a 与 nick_b 同名 Alex 但 ID 不同 |
| 15 | 敏感/推测/无长期价值 | rin 健康推测、地址电话；lin 社恐推测；tomo 猜年龄；第三方朋友 |

### 1.3 标注字段

每条应保存事实包含：

- `viewerKey`（稳定 ID，不是昵称）
- `statement`（标准事实）
- `aliases` / `topics`（可接受的语义等价表达）
- `evidence[]`（场次 + 原始 seq + eventKey + 原文）
- `category`（interest / identity / life_event / preference / dislike / community）
- `importance`（high / medium / low）
- `shouldPersist`（`true` / `false` / `'ambiguous'`）
- `status`（`current` / `superseded`）及 `supersedes` / `supersededBy`
- `ambiguous`（歧义案例，单列，不计入严格召回）

不应保存的消息单独标注 `category`（temporary / joke / speculation / sensitive_pii /
third_party / meaningless / transient / no_long_term_value / not_viewer_fact）和理由。

## 2. 质量指标及计算口径

实现：`src/ai/quality/metrics.mjs`。所有数字来自逐条 `perFact` 判定表，可人工复核。

| 指标 | 口径 |
| --- | --- |
| 事实召回率 | 被“正确”保存事实覆盖的当前严格标准事实 / 当前严格标准事实总数。允许语义等价（别名/主题包含、字符 bigram 相似），但必须由该事实自己的引用原文支持。 |
| 事实准确率 | `stated` 且语义匹配且引用原文支持且非跨观众的事实 / 全部 `stated` 事实。 |
| 重要事实召回率 | `importance=high` 的当前标准事实中被正确覆盖的比例。 |
| 跨观众证据错误率 | 引用证据的 `viewerKey` 与事实归属不一致的事实 / 已保存事实。 |
| 重复事实率 | 同一观众 `kind + topic` 归一化后重复的额外行 / 已保存事实。 |
| 不应保存内容误收率 | 引用了显式 `shouldPersist=false` 消息的事实 / 已保存事实。 |
| 歧义率 | 匹配到 `shouldPersist='ambiguous'` 或语义分数落在 0.45–0.62 区间的已保存事实；单列，不计为正确。 |
| 每条正确事实 Token | `(input + output) / 正确 stated 事实数`。 |
| 每条正确事实费用 | `估算费用 / 正确 stated 事实数`；费用仍是“Token × 用户单价”的估算，不是账单。 |

关键规则：

1. **`uncertain` / `inferred` 不算正确**，只算“待复核”；`stated` 才进入准确率与严格召回。
2. **语义匹配 + 引用原文支持** 才算正确；本地 Schema/证据归属验证只能证明“这条 seq 属于该观众”，
   不能证明“这句话支持这个结论”。
3. **歧义不计入分母**：请求推荐、单日生日、一次性抱怨等单列。
4. 一条事实可以同时覆盖同一消息中的两个独立标准事实（例如“搬到大阪”+“找拉面”），
   召回按标准事实计，准确率按已保存行计。

## 3. 事实遗漏根因（有实际证据）

### 3.1 先纠正上一轮的度量错误

上一轮把 `memory_facts` 的**行数**当作“有效事实”。归档结果的实际构成：

| 运行 | 行数 | stated | inferred | uncertain (`needs_confirmation`) |
| --- | --- | --- | --- | --- |
| 第 1 次 cap10 | 67 | 28 | 2 | **37** |
| 第 1 次 cap20 | 49 | 47 | 2 | 0 |
| 第 2 次 cap10 | 74 | 61 | 2 | 11 |
| 第 2 次 cap20 | 38 | 35 | 3 | 0 |

- 第 1 次 cap10 的 67 行中 **55% 是“待确认”**；cap20 的 49 行全部是 active、47 条 stated。
- 因此“10 人 67 条、20 人 49 条，所以 20 人更差”**不成立**：它把谨慎标记的待确认行
  与有证据的 stated 行按同一权重计数。
- 第 2 次方向相反（cap10 61 stated / cap20 35 stated），说明**运行间方差很大**；
  两次 A/B 不能证明稳定的批次优劣。

### 3.2 补答/修复请求让两次运行的请求预算不对等

`tests/.tmp/paid-p03` 的 runtime 记录：

| 运行 | 请求 | repair 尝试 | 被拒绝输出 |
| --- | --- | --- | --- |
| 第 1 次 cap10 | 7 | 4 | 4 |
| 第 1 次 cap20 | 2 | 0 | 0 |
| 第 2 次 cap10 | 6 | 3 | 3 |
| 第 2 次 cap20 | 2 | 0 | 0 |

cap10 每次运行多发 3–4 个补答请求；cap20 为 0。补答只针对**缺失的观众**，
不检查已覆盖观众的事实是否完整。原始事实总数是在不同请求预算下比较的，
不能作为批次质量结论。

### 3.3 逐请求/逐 Token 归一化后，20 人批次并不更差

| 运行 | 事实/请求 | 正确 stated/请求 | Token/正确事实 | $/正确事实 |
| --- | --- | --- | --- | --- |
| 第 1 次 cap10 | 9.6 | 3.0 | 3,393 | $0.001413 |
| 第 1 次 cap20 | 24.5 | 17.0 | 817 | $0.000332 |
| 第 2 次 cap10 | 12.3 | 7.0 | 1,386 | $0.000589 |
| 第 2 次 cap20 | 19.0 | 13.0 | 1,045 | $0.000406 |

20 人批次用更少请求和 Token 得到更多 stated 事实，但两次运行的严格召回方向相反
（第 1 次 20 更好、第 2 次 10 更好）。结论只能是：
**现有真实证据不足以判定 20 更好或更差；默认 10 是保守选择，不是被质量数据证明的最优值。**

### 3.4 已确认的确定性/工程性原因

| 原因 | 证据 | 本轮处理 |
| --- | --- | --- |
| 把 `needs_confirmation` 计入“有效事实” | 上表 37 条 uncertain 被当成事实 | 新增 `factQuality` 计数与严格指标；UI/API 可区分 stated/inferred/uncertain |
| 摘录窗口只保留最近 120 条/人，且不披露 | `MAX_MESSAGES_PER_VIEWER_EXCERPT=120`；包内无 omitted 字段 | 新增 `excerpt_total/included/omitted/window`、manifest `batch_plan.excerpt_omitted_messages`，提示词明确“不得推断省略内容” |
| 补答只检查观众覆盖 | `runner.mjs` 的 `missing refs` 触发补答；没有事实完整性检查 | 记录为已知限制；未新增付费补答 |
| 同 topic 不同 statement 被静默 confirm | `memory-engine.test.mjs` 明确断言该行为；`applyOperations` 的 add 分支只按 dedupeKey 命中 | 未改语义（会破坏“一个 live fact/topic”不变量），列为待解决语义问题 |
| 本地校验只证明证据归属，不证明语义蕴含 | 归档中出现“搬家”引用“做菜”消息 | 新增严格指标要求引用原文支持；本地不新增模型调用 |
| Schema/输出预算不是本次主因 | `operations.maxItems=40`、提示词 12 条/人；真实响应 `finish_reason=stop`，输出 2,686–3,297，预算 6,000–6,750 | 不改 Schema、不改默认输出预算 |
| 解析/本地拒绝/DB 保存失败不是主因 | cap20：50 个 op → 49 行（1 条同 topic 去重）；cap10：67 op → 67 行 | 不归因于解析或数据库 |

### 3.5 语言

- 日语归档 60 位观众 / 83 条事实（1.38 条/人），中文 cap20 25 位 / 49 条（1.96 条/人）。
  两者消息循环不同（60 mod 16 与 25 mod 16 的可达短语数不同），**不能直接比较语言差异**。
- 未发现日语事实回退成英语；语言正确性沿用上一轮结论，本轮未新增真实调用。

## 4. 修改文件

新增：

- `src/ai/quality/metrics.mjs`：语义匹配、召回/准确率/重要召回/跨观众/重复/误收/歧义/成本。
- `src/ai/quality/facts.mjs`：单任务事实质量计数（stated/inferred/uncertain，active/needs_confirmation）。
- `scripts/memory-quality-eval.mjs`：离线评分 CLI；`p03` 模式重评 4 个归档运行。
- `scripts/memory-batch-structure.mjs`：复制数据库到临时目录，离线比较 5/10/20 人批次结构。
- `tests/fixtures/memory-quality/gold-corpus.mjs`：15 类场景标准答案集。
- `tests/fixtures/memory-quality/p03-retro-gold.mjs`：P0-3 合成语料的事后标注。
- `tests/helpers/memory-quality.mjs`：种子、证据映射、usage 读取。
- `tests/unit/memory-quality-metrics.test.mjs`：10 项指标单测。
- `tests/integration/memory-quality-gold.test.mjs`：7 项端到端/防泄漏/截断披露测试。
- `docs/MEMORY_QUALITY.md`：本报告。

修改：

- `src/ai/export/split-jobs.mjs`：摘录窗口 omitted 元数据；manifest 批次计划字段。
- `src/ai/api/prompts.mjs`：把 omitted 字段传入模型；契约新增“不得推断省略内容”。
- `src/ai/api/runner.mjs`：`efficiency.factQuality`（不改数据库 schema）。
- `docs/AI_CONTRACT.md`、`docs/AI_RELIABILITY.md`、`docs/TEST_PLAN.md`、`docs/STATUS.md`、`docs/HANDOFF.md`、`docs/ROADMAP.md`、`docs/CHANGELOG.md`、`docs/AI_PROVIDER_COMPATIBILITY.md`。

**未修改**：结果 Schema 1.3.0、提示词版本 v13.2、数据库 schema 16、默认 10 人/批、
金额/身份/去重规则、Provider 兼容层、Resume/补答协议。

## 5. 优化前后对比

| 项目 | 优化前（上一轮结论） | 本轮（可复核口径） |
| --- | --- | --- |
| 10 vs 20 结论 | 20 明显更差，事实保留率 73% / 51% | 原始行数不能证明；stated-only 方向两次相反；20 每请求/每 Token 更省 |
| “有效事实” | 所有 `memory_facts` 行 | 严格：stated + 语义匹配 + 引用支持 + 非跨观众；uncertain 单列 |
| 第 1 次 cap10 | 67 条 | 21 条正确 stated（37 条 uncertain 另列），召回 15.1%，准确率 75.0% |
| 第 1 次 cap20 | 49 条 | 34 条正确 stated，召回 24.5%，准确率 72.3% |
| 第 2 次 cap10 | 74 条 | 42 条正确 stated（11 条 uncertain 另列），召回 29.5%，准确率 68.9% |
| 第 2 次 cap20 | 38 条 | 26 条正确 stated，召回 18.0%，准确率 74.3% |
| 摘录截断 | 静默保留最近 120 条 | 包内显式披露 omitted 数量；提示词禁止推断 |
| 事实质量可见性 | 只有总行数 | `efficiency.factQuality` 区分 stated/inferred/uncertain |

**没有为了提高召回而修改提示词、放宽校验或鼓励模型编造事实。**

## 6. 5/10/20 人批次结果

### 6.1 结构对照（同一 25 观众 / 200 消息数据，离线，无 Provider）

命令：`node scripts/memory-batch-structure.mjs --db <copy> --session ses_p03_ab --caps 5,10,20`

| 上限 | 批次数 | 每批观众 | 覆盖消息 | 请求估算 Token 合计 | 包总字节 | 输出预算 |
| --- | --- | --- | --- | --- | --- | --- |
| 5 | 5 | 5×5 | 200/200 | 31,303 | 249,283 | 6,000 ×5 |
| 10 | 3 | 10/10/5 | 200/200 | 25,631 | 183,012 | 6,000 ×3 |
| 20 | 2 | 15/10 | 200/200 | 22,795 | 149,921 | 6,519 + 6,000 |

- 所有观众恰好分配一次；无丢失、无拆分。
- 5 人批次请求数与固定开销最高；20 人最低，但单批输出预算首次升到 6,519。
- 这些是**结构/Token 估算**，不是语义质量证据。

### 6.2 真实语义（归档 DeepSeek，10 vs 20）

| 运行 | 正确 stated | 漏提 | 错误 stated | 误收 | 歧义 | 待复核 | 召回 | 重要召回 | 准确率 | 跨观众 | 重复 | 请求 | Token | 费用 | Token/正确 | $/正确 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 第 1 次 cap10 | 21 | 118 | 7 | 12 | 10 | 23 | 15.1% | 7.7% | 75.0% | 0 | 0 | 7 | 71,257 | $0.02967 | 3,393 | $0.001413 |
| 第 1 次 cap20 | 34 | 105 | 13 | 6 | 7 | 2 | 24.5% | 23.1% | 72.3% | 0 | 0 | 2 | 27,784 | $0.01130 | 817 | $0.000332 |
| 第 2 次 cap10 | 42 | 97 | 19 | 6 | 16 | 9 | 29.5% | 19.2% | 68.9% | 0 | 0 | 6 | 58,192 | $0.02475 | 1,386 | $0.000589 |
| 第 2 次 cap20 | 26 | 113 | 9 | 5 | 5 | 2 | 18.0% | 19.2% | 74.3% | 0 | 0 | 2 | 27,161 | $0.01057 | 1,045 | $0.000406 |

- “错误 stated”只统计 `stated` 中语义不匹配或引用不支持的事实；**“误收”**统计引用了显式
  `shouldPersist=false` 消息的事实（含 uncertain），因此可大于前者。
- 归档中的误收主要是把“今天下班晚 / 今天生日 / 问键盘推荐 / 歌曲 / 剪辑”等临时或非本人
  信息当作长期画像；歧义与待复核单列，不计入严格正确。
- 跨观众证据由本地校验拦截，归档结果为 0；重复事实在 cap20 第 1 次有 1 条同 topic 被引擎合并，
  因此严格重复率为 0（引擎已去重）。

**5 人批次没有真实语义数据**（本轮未授权真实调用），只有结构数据；不得把结构对照写成语义结论。

## 7. 质量回归

- 新增 `tests/unit/memory-quality-metrics.test.mjs` **10/10**：别名/归一化、召回、漏提、无证据支持、
  歧义、跨观众、误收、重复、同名不同人、成本。
- 新增 `tests/integration/memory-quality-gold.test.mjs` **7/7**：
  - 5/10/20 人批次覆盖每位观众一次；oracle 答案 100% 存储、100% 严格召回/准确率；
  - 标准答案不泄漏进包；
  - 退化答案被度量成漏提/误收，而不是静默接受；
  - 跨观众证据在导入前被拒绝，0 事实写入；
  - 150 条高频观众显式披露 120/30 截断；
  - 昵称变化保持同一稳定 ID，同名不同 ID 不合并。
- 既有断言未放宽：覆盖、证据、Resume、补答、去重、金额/身份规则保持不变。
- 结果 Schema 仍 1.3.0；提示词仍 v13.2；schema 仍 16；默认 10 人/批不变。

## 8. Token 成本影响

- 新增包字段是每观众 4 个整数字段 + 每批 2 个字段；在 25 观众 / 200 消息样本中
  包字节与批次数不变，估算请求 Token 不变（见 §6.1 的同一规划器）。
- 提示词新增 1 条英文契约（约 200 字节），只在发生截断的观众上附带 omitted 字段；
  不改变默认输出预算、不增加请求。
- `factQuality` 是本地 SQL 聚合，不增加 Provider 请求。
- 真实成本仍需按归档 usage 与用户单价估算；DeepSeek 不返回 `usage.cost`，本报告不称账单。

## 9. 全量测试

- 命令：`node --test --test-isolation=none "tests/unit/*.test.mjs" "tests/integration/*.test.mjs"`
- 结果：**814 passed / 0 failed / 0 skipped（219,730 ms，2026-11-14）**
- 新增：10 unit + 7 integration（共 17）。
- 既有 AI/画像/补答/Token/备份/认证/平台测试全部通过。

## 10. 正式 EXE 验证

| 项目 | 值 |
| --- | --- |
| 文件 | `dist/LiveMemory.exe` |
| 大小 | `96,665,088` bytes（92.2 MB） |
| SHA-256 | `3dfa563b88167f1e3a1985706e73f730c7b58e4c2c84c48817e48f35058fc233` |
| buildId | `ab6098700897` |
| source hash | `ab6098700897c170aa260c2a11174444854fa29e0e1fa5f30ccbf26e9056935a` |
| commit | `1b5f5809b2f622bff63fd336ac0e8bfc3541200d`（构建时 HEAD） |
| builtAt | `2026-11-14T12:07:16.155Z` |
| 资源 | `191` files；20 个必需模块；asset hash `ab6098700897c170aa26` |
| RT_MANIFEST | `asInvoker` |

EXE 矩阵（全部针对最终二进制）：

- `scripts/verify-exe.mjs`：**10/10**（asInvoker、全新目录、重启、硬杀恢复、端口顺延、单实例、
  不可写目录、异目录、解压复用、CLI 三语；`--version` 返回 buildId `ab6098700897`）。
- `scripts/verify-p0-2-exe.mjs`：**13/13**（备份 592,376 B、独立校验、全新目录恢复、重启、
  再次备份）。
- `scripts/verify-p0-5-exe.mjs`：**12/12**（未认证读写/SSE 401、伪造 Origin/Host 403、
  fragment→Cookie、重启旧凭据失效）。
- `scripts/verify-ai-token-exe.mjs`：**16/16**（40/40 观众、长期画像、注入 500 后只恢复 b02、
  完成后 0 请求、重启后一致、备份）。
- 长期画像正常、Resume 正常、数据保存正常、备份恢复正常、API 认证正常、asInvoker 正常。

**性质**：正式 EXE + 本地 Mock Provider + 合成数据；不是真实付费 Provider 验收，
也不是真实浏览器点击。

## 11. 仍未解决的语义问题

1. **严格语义质量仍低**：归档真实运行 strict recall 15.1%–29.5%，即使最好的运行也漏掉约 70%。
   这不是批次大小能单独解释的。
2. **证据支持率不足**：25%–31% 的 stated 事实的引用原文不支持其结论（跨观众语义污染、
   把他人/主播/临时信息归到本人）。本地 Schema 校验无法发现。
3. **运行间方差大**：同一数据、同一模型、同一温度，20 人批次两次的操作数 32 vs 17；
   10 人批次两次 stated 28 vs 61。需要重复运行与置信区间，不能凭一次 A/B 下结论。
4. **补答只补观众、不补事实**：已覆盖观众的事实数量不足不会被发现。
5. **摘录窗口仍为最近 120 条/人**：已披露，但早期事实仍可能无法被提取；没有真实高频观众样本验证。
6. **同 topic 不同 statement 的去重合并**：引擎按 `kind+topic` 去重，可能把独立语义合并为
   一次 confirm；本轮未改该不变量。
7. **5 人批次无真实语义数据**；其他 Provider、真实账单、thinking 开启均未验证。
8. **语料是合成数据**：重复模板会放大“内容重复、真实性存疑”，与真实主播聊天不同。

## 12. 是否满足验收标准

**工程与度量体系：通过。** 标准答案集、指标口径、离线评分 CLI、5/10/20 结构对照、
真实归档重评、确定性修复（截断披露、事实质量计数）、回归测试与 EXE 均有可复核证据。

**语义质量本身：未达标、未闭环。**
- 严格召回 15%–30%，重要事实召回 8%–23%；
- 25%–31% stated 事实缺乏引用支持；
- 两次 10 vs 20 方向相反，不能宣布任何批次“质量更优”；
- 未获本轮付费授权，未做新的真实 A/B，5 人批次无语义数据。

因此本轮**不能关闭“长期画像语义质量”**，只能关闭“没有可量化验收体系”这一项，
并把“20 人更差”的旧结论降级为“证据不足、需受控复测”。

## 13. Git、buildId、SHA-256

- 代码提交：`8d4e024bc01561be6f418aa9415a2c0dc5bfa3c5`
- 文档收尾提交：`DOC_COMMIT_PLACEHOLDER`
- 构建时 HEAD：`1b5f5809b2f622bff63fd336ac0e8bfc3541200d`（正式 EXE 的 `build-info.commit`）
- buildId：`ab6098700897`
- SHA-256：`3dfa563b88167f1e3a1985706e73f730c7b58e4c2c84c48817e48f35058fc233`
- 提交身份：`zgrg29 <10182596+zgrg29@users.noreply.github.com>`（仓库本地配置）
- 未 Push、未 Tag、未发布。

## 14. RC0 最终验收交接建议

1. **保持默认 10 人/批**；不要因为本轮重评就恢复 20。20 只有在“等请求预算、重复 ≥3 次、
   严格召回与重要召回均不低于 10”后才考虑。
2. 下一次真实付费测试必须先提交计划并等待授权；建议预算上限不超过上一轮的 $1.25，
   数据只用本报告的标准答案集，不做生产数据调用。
3. 用 `scripts/memory-quality-eval.mjs` 作为唯一评分入口；报告必须同时给出
   stated/uncertain、严格召回、重要召回、准确率、误收率、跨观众率、重复率、Token/费用。
4. 优先修“引用原文不支持结论”的语义污染，而不是继续加批次或加提示词篇幅。
5. 把 `efficiency.factQuality` 显示到 AI 分析中心，避免用户继续把总行数当质量。
6. 若要验证高频观众，先做一次经授权的“摘录窗口 120 vs 240”A/B；不要默认改动。
7. 其他 Provider、真实账单、thinking、真实浏览器/真实桌面交互仍为独立待验收项。
