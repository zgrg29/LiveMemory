import {
  MEMORY_PROMPT_VERSION,
  MEMORY_PROTOCOL,
  MEMORY_SCHEMA_VERSION,
  MAX_OPS_PER_VIEWER,
  MAX_EVIDENCE_PER_OP,
  SUPPORTED_MEMORY_LOCALES
} from './constants.mjs';
import {isoFromEpochMs} from '../shared/time.mjs';

/**
 * Localized instructions for the long-term memory update round trip.
 *
 * Written for a human who will paste this into any chat AI: the protocol rules
 * are explicit, the output is strict JSON, and every "do not do this" covers a
 * failure mode the importer rejects or the UI must never claim.
 */

export function memoryInstructionVersion(locale) {
  return `${MEMORY_PROMPT_VERSION}-${SUPPORTED_MEMORY_LOCALES.includes(locale) ? locale : 'en'}`;
}

const OP_TABLE = `| op | 何时使用 | 必填字段 |
| --- | --- | --- |
| add | 出现了现有记忆没有的新信息 | kind, statement, certainty, evidence |
| confirm | 现有记忆在本场再次得到印证 | target_fact_id, evidence |
| update | 现有记忆需要措辞/细节修正 | target_fact_id, statement, evidence |
| supersede | 状态发生了变化（旧的结束、新的开始） | target_fact_id, statement, evidence |
| conflict | 与现有记忆直接矛盾且无法判断哪个正确 | target_fact_id, statement, evidence |
| outdated | 现有记忆可能已不再适用（不是删除） | target_fact_id |
| uncertain | 有人提到但无法确认 | statement, certainty=uncertain |

kind：interest（兴趣）/ dislike（明确反感）/ identity（自身身份相关信息）/ life_event（近况、经历、事件）/ topic（常聊话题）/ preference（偏好习惯）/ community（与主播或社区的关系）/ other。`;

const OP_TABLE_JA = `| op | 使用場面 | 必須フィールド |
| --- | --- | --- |
| add | 既存メモリにない新しい情報 | kind, statement, certainty, evidence |
| confirm | 既存メモリが今回も裏付けられた | target_fact_id, evidence |
| update | 既存メモリの表現・詳細を修正する | target_fact_id, statement, evidence |
| supersede | 状態が変わった（旧状態が終わり、新状態が始まった） | target_fact_id, statement, evidence |
| conflict | 既存メモリと明確に矛盾し、どちらが正しいか判断できない | target_fact_id, statement, evidence |
| outdated | 既存メモリが現在は当てはまらない可能性（削除ではない） | target_fact_id |
| uncertain | 話題には出たが確認できない | statement, certainty=uncertain |

kind：interest（興味）/ dislike（明確な苦手）/ identity（本人の属性に関する発言）/ life_event（近況・出来事）/ topic（よく話す話題）/ preference（好み・習慣）/ community（配信者やコミュニティとの関係）/ other。`;

const OP_TABLE_EN = `| op | when to use | required fields |
| --- | --- | --- |
| add | genuinely new information not present in the current memory | kind, statement, certainty, evidence |
| confirm | the current memory was supported again in this session | target_fact_id, evidence |
| update | the wording/details of a current memory need correction | target_fact_id, statement, evidence |
| supersede | a state changed (the old one ended, a new one started) | target_fact_id, statement, evidence |
| conflict | it directly contradicts the memory and the winner is unclear | target_fact_id, statement, evidence |
| outdated | the memory may no longer apply (never a deletion) | target_fact_id |
| uncertain | something was mentioned but cannot be confirmed | statement, certainty=uncertain |

kind: interest / dislike (explicit dislike) / identity (things the viewer said about themselves) / life_event (current situation, experience, event) / topic / preference / community (relationship with the streamer or chat) / other.`;

const EXAMPLE = `{
  "protocol": "livememory-memory-update-v1",
  "schema_version": "1.0.0",
  "job_id": "mjob_...",
  "batch_id": "mjob_...-b01",
  "task_id": "ses_...-memory",
  "session_id": "ses_...",
  "broadcaster_id": "bilibili:room:5050",
  "locale": "zh-CN",
  "viewer_operations": [
    {
      "viewer_id": "bilibili:12345",
      "summary": "准备考试的考生，喜欢节奏游戏。",
      "operations": [
        {
          "op": "supersede",
          "target_fact_id": "mfc_...",
          "kind": "life_event",
          "topic": "考试",
          "statement": "考试已经结束，正在等成绩",
          "certainty": "stated",
          "confidence": 0.9,
          "evidence": [{"batch": 1, "seq": 4}]
        },
        {
          "op": "add",
          "kind": "interest",
          "topic": "音乐游戏",
          "statement": "最近在玩音乐游戏",
          "certainty": "stated",
          "confidence": 0.7,
          "evidence": [{"batch": 1, "seq": 12}]
        }
      ]
    }
  ]
}`;

function header(locale, {session, broadcaster, batch, jobId}) {
  const lines = [
    `- protocol: ${MEMORY_PROTOCOL}`,
    `- schema_version: ${MEMORY_SCHEMA_VERSION}`,
    `- prompt_version: ${memoryInstructionVersion(locale)}`
  ];
  if (jobId) lines.push(`- job_id: ${jobId}`);
  if (batch) {
    lines.push(`- batch_id: ${batch.batchId}`);
    lines.push(`- task_id: ${batch.taskId}`);
    lines.push(`- batch: ${batch.index} / ${batch.total}`);
  }
  if (session) {
    lines.push(`- session_id: ${session.id}`);
    if (session.startedAt) lines.push(`- session_started_at: ${isoFromEpochMs(session.startedAt)}`);
    if (session.endedAt) lines.push(`- session_ended_at: ${isoFromEpochMs(session.endedAt)}`);
  }
  if (broadcaster?.id) lines.push(`- broadcaster_id: ${broadcaster.id}`);
  lines.push(`- viewers_in_package: ${batch?.viewerCount ?? ''}`);
  return lines.join('\n');
}

const ZH = ({context}) => `# LiveMemory 长期观众记忆更新

你正在帮助一位主播维护「长期观众记忆」。软件已经把**现有记忆**和**本场新聊天**放进这个包，
请只输出本次值得写入记忆的变化。

## 1. 包内容

- \`memory_context.json\`：本场直播信息、主播，以及每位观众的现有记忆（\`facts\` 中每条都有 \`id\`、\`certainty\`、\`status\`）。
- \`viewer_excerpts.jsonl\`：本场这些观众的聊天摘录，每行一个 JSON，\`seq\` 是本包内的引用号。
- \`result.schema.json\`：输出必须满足的 JSON Schema。

## 2. 任务

对每位观众，把他的现有记忆与本场发言对比，输出：

1. 真正的新信息（add）；
2. 被再次印证的信息（confirm）；
3. 需要修正的细节（update）；
4. 状态发生变化的信息（supersede，例如「在准备考试」→「考试结束」）；
5. 与历史直接矛盾、无法判断的信息（conflict）；
6. 可能已不再适用的信息（outdated）；
7. 无法确认的信息（uncertain）。

**不要重写整份画像，也不要输出没有变化的内容。**

## 3. 证据规则（最重要）

- 每个 add / confirm / update / supersede / conflict 都必须带 \`evidence\`，引用本包内真实存在的 \`seq\`（本包是单批次时可直接写整数）。
- \`certainty\` 三选一：
  - \`stated\`：观众**原话明确表达**（例如「我明天考试」）。必须有直接引用的 \`seq\`。
  - \`inferred\`：你根据上下文推测（例如多次提到某游戏 → 可能喜欢）。必须能从引用看出来。
  - \`uncertain\`：有人提到但无法确认。
- **推断不得写成 stated。** 一条消息重复出现也不能升级为事实。
- 玩笑、反讽、引用别人的话、角色扮演、复读、玩梗，都不能当作观众的真实个人事实。
- Emoji 与平台表情只是语气线索，不能单独证明情绪、性别、年龄或任何个人属性；未知表情不要猜测含义。
- 不要输出金额、礼物数量、粉丝数或任何计数；这些由软件自己统计，AI 数字无效。
- 不要推断敏感属性：健康、性取向、宗教、政治立场、财务状况、真实姓名、住址、联系方式、身份证件。
- 礼物金额不代表经济能力、人格或忠诚度，不得据此生成任何记忆。
- 语言保持原样：中文、日文、英文混排时按原语言记录，不要翻译成别的语言。
- 宁少勿多：证据不足就省略，或使用 \`uncertain\`。

## 4. 状态变化 vs 矛盾

- 「以前在备考，现在考完了」= **状态变化**，用 \`supersede\`，旧事实会被保留为历史，不会删除。
- 「说喜欢 A 游戏，又说最讨厌 A 游戏」= **矛盾**，用 \`conflict\`，让主播自己判断，不要替主播选。
- 「以前常聊 A，最近常聊 B」= 可以 add B、confirm A，但**不能**断言「已经不喜欢 A」。

## 5. 操作与字段

${OP_TABLE}

- \`target_fact_id\` 只能使用 \`memory_context.json\` 中**这位观众**现有 facts 的 \`id\`，不能编造，也不能使用其他观众的 id。
- 同一条事实只输出一次；同一话题不要既 add 又 update。
- 每位观众最多 ${MAX_OPS_PER_VIEWER} 个操作，每个操作最多 ${MAX_EVIDENCE_PER_OP} 条证据。
- \`viewer_id\` 必须来自本包 \`memory_context.json\`；不要创建新观众，不要用昵称代替 id。
- \`summary\`（可选）用一两句话概括这位观众**当前**的状态，不要堆砌所有历史。

## 6. 输出

只输出一个 JSON 对象，不要 Markdown 代码块以外的解释文字。字段如下：

\`\`\`json
${EXAMPLE}
\`\`\`

本包信息：
${context}

如果本场没有任何值得写入记忆的内容，返回 \`"viewer_operations": []\`。`;

const JA = ({context}) => `# LiveMemory 長期視聴者メモリの更新

配信者のための「長期視聴者メモリ」を更新します。このパッケージには**既存のメモリ**と**今回の配信の新しいチャット**が入っています。
今回書き込む価値のある変化だけを出力してください。

## 1. パッケージ内容

- \`memory_context.json\`：配信情報、配信者、視聴者ごとの既存メモリ（\`facts\` の各項目に \`id\`・\`certainty\`・\`status\`）。
- \`viewer_excerpts.jsonl\`：今回の視聴者の発言抜粋。1 行 1 JSON、\`seq\` がパッケージ内の参照番号です。
- \`result.schema.json\`：出力が従う JSON Schema。

## 2. タスク

視聴者ごとに、既存メモリと今回の発言を比較し、次だけを出力します。

1. 本当に新しい情報（add）
2. 再確認できた情報（confirm）
3. 修正が必要な詳細（update）
4. 状態の変化（supersede：例「試験勉強中」→「試験が終わった」）
5. 履歴と矛盾し判断できない情報（conflict）
6. もう当てはまらない可能性がある情報（outdated）
7. 確認できない情報（uncertain）

**プロフィール全体を書き直さないでください。変化のない項目も出力しないでください。**

## 3. 根拠のルール（最重要）

- add / confirm / update / supersede / conflict には必ず \`evidence\` を付け、このパッケージ内に実在する \`seq\` を引用します（単一バッチなら整数可）。
- \`certainty\` は 3 種類：
  - \`stated\`：視聴者本人が**明言**した（例「明日試験です」）。直接引用できる \`seq\` が必須。
  - \`inferred\`：文脈からの推測（例：同じゲームの話が多い → 好きかもしれない）。引用から読み取れること。
  - \`uncertain\`：話題には出たが確認できない。
- **推測を stated にしないでください。** 同じ発言が何度も出ても事実にはなりません。
- 冗談・皮肉・他人の引用・ロールプレイ・コピペ・内輪ネタは、本人の事実として扱わないでください。
- Emoji とプラットフォーム絵文字は文脈の手がかりに過ぎません。単独で感情・性別・年齢などの属性を証明できません。未知の絵文字の意味を推測しないでください。
- 金額・ギフト数・フォロワー数などの数値は出力しないでください。集計はソフト側が行います。
- センシティブな属性（健康・性的指向・宗教・政治・経済状況・本名・住所・連絡先・身分証）を推測しないでください。
- ギフト額から経済力・人格・忠誠心を推測しないでください。
- 言語はそのまま：中国語・日本語・英語の混在は原文の言語で記録し、翻訳しないでください。
- 少なすぎるくらいで構いません。根拠が弱ければ省略するか \`uncertain\` を使ってください。

## 4. 状態変化と矛盾

- 「以前は試験勉強、今は終わった」= **状態変化**。\`supersede\` を使います。古い事実は履歴として残り、削除されません。
- 「A が好き」と「A が大嫌い」= **矛盾**。\`conflict\` を使い、配信者に判断を委ねてください。
- 「以前は A の話、最近は B の話」= B を add、A を confirm してもよいですが、「A が嫌いになった」と断定してはいけません。

## 5. 操作とフィールド

${OP_TABLE_JA}

- \`target_fact_id\` は \`memory_context.json\` の**その視聴者**の facts の \`id\` のみ使用できます。捏造や他視聴者の id は禁止です。
- 同じ事実を 1 回だけ出力してください。同じ話題を add と update の両方に書かないでください。
- 1 視聴者あたり最大 ${MAX_OPS_PER_VIEWER} 操作、1 操作あたり最大 ${MAX_EVIDENCE_PER_OP} 件の根拠。
- \`viewer_id\` は \`memory_context.json\` の値のみ。新しい視聴者を作らず、ニックネームを id の代わりにしないでください。
- \`summary\`（任意）は現在の状態を 1〜2 文で。履歴の詰め込みは不要です。

## 6. 出力

JSON オブジェクトを 1 つだけ出力してください（説明文は不要）。

\`\`\`json
${EXAMPLE}
\`\`\`

パッケージ情報：
${context}

書き込む内容がなければ \`"viewer_operations": []\` を返してください。`;

const EN = ({context}) => `# LiveMemory long-term viewer memory update

You are maintaining the streamer's long-term memory of viewers. The package contains the
**current memory** and the **new chat from this session**. Output only what is worth remembering.

## 1. Package contents

- \`memory_context.json\`: session info, broadcaster, and each viewer's current memory (\`facts\` carry \`id\`, \`certainty\`, \`status\`).
- \`viewer_excerpts.jsonl\`: this session's messages for those viewers, one JSON per line; \`seq\` is the reference number inside this package.
- \`result.schema.json\`: the JSON Schema your answer must satisfy.

## 2. Task

For each viewer, compare the current memory with what they said this time and output only:

1. genuinely new information (add);
2. information confirmed again (confirm);
3. details that need correction (update);
4. state changes (supersede, e.g. "preparing for an exam" -> "the exam is over");
5. direct contradictions that cannot be resolved (conflict);
6. information that may no longer apply (outdated);
7. information that cannot be confirmed (uncertain).

**Do not rewrite the whole profile and do not output unchanged items.**

## 3. Evidence rules (most important)

- Every add / confirm / update / supersede / conflict must carry \`evidence\` referencing \`seq\` values that really exist in this package (a plain integer is fine for a single-batch package).
- \`certainty\` is one of:
  - \`stated\`: the viewer **explicitly said it** ("I have an exam tomorrow"). A direct \`seq\` is mandatory.
  - \`inferred\`: you inferred it from context (repeated talk about a game). It must be readable from the cited messages.
  - \`uncertain\`: mentioned but unconfirmed.
- **Never write an inference as stated.** Repetition does not make something a fact.
- Jokes, sarcasm, quotes of other people, role play, copypasta and running gags are not personal facts.
- Emoji and platform emotes are contextual clues only; they cannot prove emotion, gender, age or any personal attribute. Never guess unknown emotes.
- Never output money amounts, gift counts, follower counts or any statistics — the app computes those locally.
- Do not infer sensitive attributes: health, sexual orientation, religion, politics, finances, real name, address, contact details, ID documents.
- Gift value says nothing about wealth, personality or loyalty; do not create memories from it.
- Keep the original language: mixed Chinese/Japanese/English stays as written, never translated.
- Prefer fewer, well-supported items; omit weak ones or use \`uncertain\`.

## 4. State change vs contradiction

- "was studying for an exam, now it is over" = **state change** -> \`supersede\`; the old fact is kept as history.
- "loves game A" vs "hates game A" = **contradiction** -> \`conflict\`; the streamer decides.
- "used to talk about A, now talks about B" -> you may add B and confirm A, but never claim the viewer stopped liking A.

## 5. Operations and fields

${OP_TABLE_EN}

- \`target_fact_id\` may only be an \`id\` from **that viewer's** facts in \`memory_context.json\`. Never invent ids and never use another viewer's id.
- Output each fact once; do not add and update the same topic in one answer.
- At most ${MAX_OPS_PER_VIEWER} operations per viewer and ${MAX_EVIDENCE_PER_OP} evidence references per operation.
- \`viewer_id\` must come from \`memory_context.json\`; never create viewers and never use a nickname as an id.
- \`summary\` (optional) is one or two sentences about the viewer's current state, not a history dump.

## 6. Output

Return exactly one JSON object (no prose):

\`\`\`json
${EXAMPLE}
\`\`\`

Package:
${context}

If nothing is worth remembering, return \`"viewer_operations": []\`.`;

const BUILDERS = {'zh-CN': ZH, ja: JA, en: EN};

/**
 * @param {'zh-CN'|'ja'|'en'} locale
 * @param {{session?:object, broadcaster?:object, batch?:object, jobId?:string}} options
 */
export function buildMemoryInstructions(locale, options = {}) {
  const builder = BUILDERS[SUPPORTED_MEMORY_LOCALES.includes(locale) ? locale : 'en'];
  const context = header(locale, options);
  return builder({context});
}

export const __internal = {EXAMPLE, OP_TABLE, header, BUILDERS};
