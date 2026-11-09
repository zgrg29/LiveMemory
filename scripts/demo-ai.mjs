import {readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startServer} from '../src/server/index.mjs';
import {createSession, endSession, setSessionArchived} from '../src/storage/repositories/sessions.mjs';
import {upsertBroadcaster} from '../src/storage/repositories/broadcasters.mjs';
import {EventIngest} from '../src/platforms/shared/ingest.mjs';
import {createAnalysisJob, buildAggregatePackage} from '../src/ai/export/job.mjs';
import {importAnalysisResult} from '../src/ai/import/importer.mjs';
import {readZipEntry} from '../src/shared/zip.mjs';

/**
 * Development-only fixture for the M6 AI round trip and report UI.
 *
 * Seeds clearly simulated broadcasts and synthetic AI answers (built from the
 * real exported packages, never from a real AI service). One broadcast has a
 * complete aggregate report, one is partially imported, one is waiting for an
 * import, and one archived broadcast has no task.
 *
 *   node scripts/demo-ai.mjs [--port 48370] [--seconds 0]
 */

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}
const port = Number(argValue('--port', 48370));
const seconds = Number(argValue('--seconds', 0));
const root = fileURLToPath(new URL('../tests/.tmp/', import.meta.url));
const dataDir = join(root, `demo-ai-${Date.now()}`);
const HOUR = 3600 * 1000;
const now = Date.now();
const T = now - 3 * HOUR;

const server = await startServer({dataDir, port, systemLocale: 'en'});
const db = server.db;
const ingest = new EventIngest({db});
const exportsDir = server.paths.exports;

function addBroadcaster(platform, uid, name) {
  const id = `${platform}:${uid}`;
  upsertBroadcaster(db, {id, platform, platformUid: uid, displayName: name, identity: 'verified', seenAt: now, now});
  return id;
}

const alpha = addBroadcaster('youtube', 'UC_DEMO_AI_ALPHA', 'Demo Alpha 主播');
const beta = addBroadcaster('bilibili', '930001', 'Demo Beta 主播');

function seedSession({platform, roomId, title, broadcasterName, broadcasterId, startedAt, messages}) {
  const session = createSession(db, {
    platform,
    platformRoomId: roomId,
    roomTitle: title,
    broadcasterName,
    broadcasterId,
    broadcasterIdentity: 'verified',
    storageMode: 'full',
    sourceQuality: 'mock',
    simulated: true,
    startedAt
  });
  let offset = 0;
  for (const message of messages) {
    offset += 1000;
    ingest.record({
      session_id: session.id,
      platform,
      event_type: message.amount ? 'super_chat' : 'chat',
      viewer_uid: message.uid,
      display_name: message.name,
      occurred_at: startedAt + offset,
      content: message.content,
      ...(message.emotes ? {emotes: message.emotes} : {}),
      ...(message.amount
        ? {amount_minor: message.amount, currency: platform === 'youtube' ? 'USD' : 'CNY', value_kind: 'actual', is_paid: true, amount_display: platform === 'youtube' ? `$${(message.amount / 100).toFixed(2)}` : `¥${(message.amount / 100).toFixed(2)}`}
        : {}),
      external_id: `demo-ai-${session.id}-${offset}`,
      source_quality: 'mock'
    });
  }
  endSession(db, session.id, {status: 'ended', endedAt: startedAt + offset + 60_000, reason: 'adapter_end'});
  return session;
}

const chat = (uid, name, content, extra = {}) => ({uid, name, content, ...extra});

const completeConversation = [
  chat('UC_AI_1', '小王', '今天先挖矿还是先建房子？'),
    chat('UC_AI_2', 'Mika', '建房子！昨天的城堡还没盖完 🏰'),
    chat('UC_AI_1', '小王', '我觉得挖矿比较稳，先攒钻石'),
    chat('UC_AI_3', '老观众', '两个都行，先去下界看看'),
    chat('UC_AI_2', 'Mika', '下界太危险了，上次差点回不来 😂'),
    chat('UC_AI_4', 'Lurker', '这个 BGM 好好听'),
    chat('UC_AI_1', '小王', '确实，歌单能发一下吗'),
    chat('UC_AI_3', '老观众', '主播今天状态不错'),
    chat('UC_AI_2', 'Mika', '猫猫鼓掌', {emotes: [{id: 'room_cat', code: '[猫猫鼓掌]', name: '猫猫鼓掌', source: 'bilibili.info13'}]}),
    chat('UC_AI_5', '新朋友', '第一次来，这个频道主要播什么？'),
    chat('UC_AI_4', 'Lurker', '主要就是 Minecraft 和杂谈'),
    chat('UC_AI_1', '小王', '欢迎新朋友 👋'),
    chat('UC_AI_5', '新朋友', '了解了，先关注一下'),
    chat('UC_AI_2', 'Mika', '别只关注，记得点个赞 😆'),
    chat('UC_AI_6', 'Support Fan', '支持一下！', {amount: 500}),
    chat('UC_AI_3', '老观众', '谢谢老板'),
    chat('UC_AI_1', '小王', '这钱够买好多钻石了'),
    chat('UC_AI_4', 'Lurker', '刚刚那个建筑教程有录播吗'),
    chat('UC_AI_2', 'Mika', '没有录播，只能看直播'),
    chat('UC_AI_1', '小王', '那太可惜了'),
    chat('UC_AI_3', '老观众', '所以今天到底挖矿还是建房？'),
    chat('UC_AI_1', '小王', '我投挖矿一票'),
    chat('UC_AI_2', 'Mika', '我坚持建房'),
    chat('UC_AI_4', 'Lurker', '不如先建房再挖矿'),
    chat('UC_AI_5', '新朋友', '听起来都可以'),
    chat('UC_AI_3', '老观众', '别吵了，看主播怎么选'),
    chat('UC_AI_1', '小王', '这不是吵，这是认真讨论 😂'),
    chat('UC_AI_2', 'Mika', '认真讨论 +1'),
    chat('UC_AI_6', 'Support Fan', '再来一发', {amount: 300}),
    chat('UC_AI_3', '老观众', '老板大气'),
    chat('UC_AI_1', '小王', '今天的直播就到这了吗'),
    chat('UC_AI_2', 'Mika', '应该还有一会儿'),
    chat('UC_AI_3', '老观众', '明天还播吗'),
    chat('UC_AI_4', 'Lurker', '同问'),
    chat('UC_AI_1', '小王', '先撤了，晚安 🌙'),
    chat('UC_AI_2', 'Mika', '晚安')
];
const fillerNames = ['小王', 'Mika', '老观众', 'Lurker', '新朋友', 'Support Fan'];
for (let index = completeConversation.length; index < 300; index += 1) {
  completeConversation.push(chat(
    `UC_AI_${(index % 6) + 1}`,
    fillerNames[index % 6],
    `演示消息 ${index}：这一条属于按消息边界拆分的批次。`
  ));
}
const completeSession = seedSession({
  platform: 'youtube',
  roomId: 'demo-ai-complete',
  title: 'Minecraft 深夜杂谈 · AI 报告演示',
  broadcasterName: 'Demo Alpha 主播',
  broadcasterId: alpha,
  startedAt: T,
  messages: completeConversation
});

const partialSession = seedSession({
  platform: 'youtube',
  roomId: 'demo-ai-partial',
  title: 'Partial Import 部分导入演示',
  broadcasterName: 'Demo Alpha 主播',
  broadcasterId: alpha,
  startedAt: now - 2 * HOUR,
  messages: Array.from({length: 240}, (_, index) => chat(
    `UC_AI_PART_${index % 4}`,
    `Partial Viewer ${index % 4}`,
    `批次演示消息 ${index}`
  ))
});

const waitingSession = seedSession({
  platform: 'bilibili',
  roomId: '930001',
  title: 'Waiting Import 等待导入演示',
  broadcasterName: 'Demo Beta 主播',
  broadcasterId: beta,
  startedAt: now - 1 * HOUR,
  messages: Array.from({length: 40}, (_, index) => chat(
    `93000${index % 3}`,
    `Bili Viewer ${index % 3}`,
    `日本語と中文の雑談 ${index}`,
    index === 5 ? {amount: 3000} : {}
  ))
});

const archivedSession = seedSession({
  platform: 'youtube',
  roomId: 'demo-ai-archived',
  title: 'Archived Broadcast 归档演示',
  broadcasterName: 'Demo Alpha 主播',
  broadcasterId: alpha,
  startedAt: now - 30 * HOUR,
  messages: [chat('UC_AI_1', '小王', '归档后的直播也能导入 AI 结果')]
});
setSessionArchived(db, archivedSession.id, true, {now: now - 20 * HOUR});

/* ------------------------------------------------------- synthetic answers */

function readBatch(pkg) {
  const buffer = readFileSync(join(exportsDir, pkg.fileName));
  return {
    manifest: JSON.parse(readZipEntry(buffer, 'manifest.json').toString('utf8')),
    messages: readZipEntry(buffer, 'messages.jsonl').toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)),
    viewers: JSON.parse(readZipEntry(buffer, 'viewer_context.json').toString('utf8'))
  };
}

function timeRange(messages) {
  return [messages[0].at, messages[messages.length - 1].at];
}

function batchAnswer({manifest, messages, viewers}, {summary, titles, tone = 'positive'}) {
  const [from, to] = timeRange(messages);
  return {
    protocol: 'livememory-analysis-result-v1',
    schema_version: '1.1.0',
    job_id: manifest.job_id,
    batch_id: manifest.batch.batch_id,
    broadcaster_id: manifest.broadcaster_id,
    task_id: manifest.tasks[0].task_id,
    session_id: manifest.session_id,
    locale: manifest.locale,
    session_topics: {
      summary,
      topics: titles.map((title, index) => ({
        title,
        started_at: messages[Math.min(index, messages.length - 1)].at,
        ended_at: messages[Math.min(index + 2, messages.length - 1)].at,
        summary: `${title} 是这一批次中观众集中讨论的内容。`,
        key_points: ['观众多次提到该话题', '讨论集中在聊天区'],
        confidence: 0.78 - index * 0.08,
        evidence: index === 0 ? 'observed' : 'inferred',
        message_refs: [1, Math.min(2 + index, messages.length)]
      })),
      sentiment: [{
        at: from,
        tone,
        note: '这一时段聊天整体友好，间或有玩笑和不同意见。',
        confidence: 0.62,
        sample_size: messages.length
      }, {
        at: to,
        tone: 'mixed',
        note: '接近尾声时出现不同选择，但语气仍然轻松。',
        confidence: 0.41
      }],
      disputes: [{
        summary: '先挖矿还是先建房子',
        title: '玩法选择的小分歧',
        started_at: from,
        ended_at: to,
        note: '这是轻松的玩法讨论，不是严重冲突。',
        viewpoints: ['先挖矿攒资源', '先把建筑盖完'],
        confidence: 0.45,
        evidence: 'inferred',
        message_refs: [1, 2]
      }],
      highlights: [{
        started_at: from,
        ended_at: to,
        title: '聊天活跃的讨论段',
        reason: '短时间内多条消息围绕同一选择展开。',
        clip_suggestion: '回看这段玩法讨论。',
        confidence: 0.66,
        evidence: 'observed',
        message_refs: [1, 3]
      }]
    },
    viewer_profiles: viewers.slice(0, 2).map((viewer, index) => ({
      viewer_id: viewer.viewer_id,
      interests: [{topic: index === 0 ? '玩法讨论' : '频道氛围', strength: 'emerging', evidence: 'observed', note: '本场多次主动发言。'}],
      dislikes: [],
      summary: index === 0 ? '喜欢参与玩法讨论，语气轻松。' : '会回应其他观众，参与互动。',
      confidence: 0.52 - index * 0.1
    }))
  };
}

const completeJob = await createAnalysisJob({
  db,
  sessionId: completeSession.id,
  locale: 'zh-CN',
  exportsDir,
  batchSize: 100,
  now
});
const completeBatches = completeJob.packages.map(readBatch);
const topicGroups = [
  ['开局计划：挖矿还是建房', '背景音乐与歌单', '新观众第一次到访'],
  ['建筑教程与录播的讨论', '付费支持与感谢', '玩法选择的不同意见'],
  ['深夜收尾与明日直播', '观众互道晚安', '整体聊天氛围']
];
for (const [index, data] of completeBatches.entries()) {
  const answer = batchAnswer(data, {
    summary: `第 ${index + 1} 批消息的局部总结：聊天围绕 Minecraft 玩法、音乐和观众互动展开。`,
    titles: topicGroups[index] ?? ['杂谈'],
    tone: index === 1 ? 'mixed' : 'positive'
  });
  importAnalysisResult({db, text: JSON.stringify(answer), now: now + index * 1000});
}
const aggregatePackage = await buildAggregatePackage({
  db,
  jobId: completeJob.job.id,
  exportsDir,
  now: now + 10_000
});
const aggregateBuffer = readFileSync(join(exportsDir, aggregatePackage.fileName));
const aggregateManifest = JSON.parse(readZipEntry(aggregateBuffer, 'manifest.json').toString('utf8'));
const aggregateBatches = JSON.parse(readZipEntry(aggregateBuffer, 'batch_results.json').toString('utf8'));
const first = aggregateBatches[0].result.session_topics.topics[0];
const last = aggregateBatches[aggregateBatches.length - 1].result.session_topics.topics[0];
const finalAnswer = {
  protocol: 'livememory-analysis-result-v1',
  schema_version: '1.1.0',
  job_id: aggregateManifest.job_id,
  broadcaster_id: aggregateManifest.broadcaster_id,
  task_id: aggregateManifest.tasks[0].task_id,
  session_id: aggregateManifest.session_id,
  locale: aggregateManifest.locale,
  session_topics: {
    summary: '本场直播以 Minecraft 深夜杂谈为主：主播和观众先讨论先挖矿还是先建房子，随后聊到背景音乐、建筑教程和录播。中途有新观众加入并得到欢迎，也出现了两次小额付费支持。临近结束时，观众确认明天的直播安排并互道晚安。整体氛围轻松友好，不同玩法偏好只是轻松讨论，没有演变成冲突。',
    topics: [
      {
        title: '开局计划：挖矿还是建房子',
        started_at: first.started_at,
        ended_at: first.ended_at,
        summary: '直播开始后，观众很快分成“先挖矿攒钻石”和“先完成城堡建筑”两种选择，主播没有强行站队，而是让观众讨论。',
        key_points: ['观众主动比较两种玩法收益', '讨论保持在轻松语气', '主播把选择留到实际游玩时决定'],
        confidence: 0.86,
        evidence: 'observed',
        message_refs: [{batch: 1, seq: 1}, {batch: 2, seq: 1}]
      },
      {
        title: '背景音乐、建筑教程与录播',
        started_at: aggregateBatches[0].result.session_topics.topics[1]?.started_at ?? first.started_at,
        ended_at: aggregateBatches[1].result.session_topics.topics[0]?.ended_at ?? last.ended_at,
        summary: '观众称赞 BGM 并询问歌单，也询问建筑教程是否有录播。主播说明没有录播，观众表达了可惜。',
        key_points: ['BGM 获得正面反馈', '观众希望有录播', '没有录播是明确的遗憾点'],
        confidence: 0.72,
        evidence: 'observed',
        message_refs: [{batch: 1, seq: 2}, {batch: 2, seq: 1}]
      },
      {
        title: '新观众加入与经济支持',
        started_at: aggregateBatches[1].result.session_topics.topics[1]?.started_at ?? first.started_at,
        ended_at: last.ended_at,
        summary: '新观众询问频道内容并得到多位老观众解释；随后出现两次付费支持，观众以“老板大气”等玩笑回应。',
        key_points: ['新观众得到欢迎', '付费支持是客观事件，不代表对话题的偏好', '观众用玩笑承接付费事件'],
        confidence: 0.68,
        evidence: 'observed',
        message_refs: [{batch: 1, seq: 3}, {batch: 3, seq: 1}]
      },
      {
        title: '收尾与明日安排',
        started_at: last.started_at,
        ended_at: last.ended_at,
        summary: '直播接近尾声，观众询问明天是否继续直播，并互道晚安。这属于常规收尾，不构成争论。',
        key_points: ['观众关心后续直播', '聊天以晚安结束'],
        confidence: 0.55,
        evidence: 'inferred',
        message_refs: [{batch: 3, seq: 1}]
      }
    ],
    sentiment: [
      {at: first.started_at, tone: 'positive', note: '开场互动积极，欢迎新观众。', confidence: 0.7, sample_size: 24},
      {at: aggregateBatches[0].result.session_topics.topics[1]?.started_at ?? first.started_at, tone: 'neutral', note: '围绕音乐和录播的信息交流。', confidence: 0.6, sample_size: 20},
      {at: aggregateBatches[1].result.session_topics.topics[0]?.started_at ?? first.started_at, tone: 'mixed', note: '出现玩法选择的分歧，但语气轻松。', confidence: 0.45, sample_size: 18, evidence_note: '含反讽与玩笑，样本较少。'},
      {at: aggregateBatches[2].result.session_topics.topics[0]?.started_at ?? last.started_at, tone: 'positive', note: '收尾阶段以晚安和感谢为主。', confidence: 0.65, sample_size: 15}
    ],
    disputes: [
      {
        title: '玩法选择的分歧',
        summary: '先挖矿还是先建房子',
        started_at: first.started_at,
        ended_at: aggregateBatches[1].result.session_topics.topics[0]?.ended_at ?? last.ended_at,
        note: '观众表达了不同偏好，但使用玩笑语气，没有人身攻击，也没有持续刷屏。',
        viewpoints: ['先挖矿更有效率', '先完成建筑更有成就感'],
        confidence: 0.42,
        evidence: 'inferred',
        message_refs: [{batch: 1, seq: 1}, {batch: 2, seq: 2}]
      }
    ],
    highlights: [
      {
        title: '玩法选择的讨论',
        started_at: first.started_at,
        ended_at: aggregateBatches[1].result.session_topics.topics[0]?.ended_at ?? last.ended_at,
        reason: '短时间内多条消息围绕同一选择展开，聊天活跃度明显上升。',
        clip_suggestion: '可回看观众分成两派讨论玩法的时段。',
        confidence: 0.76,
        evidence: 'observed',
        message_refs: [{batch: 1, seq: 1}, {batch: 2, seq: 2}]
      },
      {
        title: '新观众第一次到访',
        started_at: aggregateBatches[0].result.session_topics.topics[2]?.started_at ?? first.started_at,
        ended_at: aggregateBatches[0].result.session_topics.topics[2]?.ended_at ?? first.ended_at,
        reason: '老观众主动解释频道内容并欢迎新观众，互动集中。',
        clip_suggestion: '可回看新观众自我介绍与欢迎段。',
        confidence: 0.6,
        evidence: 'observed',
        message_refs: [{batch: 1, seq: 3}]
      },
      {
        title: '付费支持与观众玩笑',
        started_at: aggregateBatches[1].result.session_topics.topics[1]?.started_at ?? first.started_at,
        ended_at: aggregateBatches[1].result.session_topics.topics[1]?.ended_at ?? first.ended_at,
        reason: '出现付费支持，聊天出现集中的玩笑回应。',
        clip_suggestion: '可回看这段互动，但片段建议仅基于聊天。',
        confidence: 0.5,
        evidence: 'observed',
        message_refs: [{batch: 2, seq: 1}]
      }
    ]
  },
  viewer_profiles: aggregateBatches[0].result.viewer_profiles.slice(0, 2).map((profile, index) => ({
    ...profile,
    confidence: index === 0 ? 0.58 : 0.4,
    summary: index === 0 ? '经常参与玩法讨论，会主动回应其他观众。' : '对频道氛围和音乐话题有回应，但本场证据有限。'
  }))
};
importAnalysisResult({db, text: JSON.stringify(finalAnswer), createVersion: false, now: now + 15_000});

const partialJob = await createAnalysisJob({
  db,
  sessionId: partialSession.id,
  locale: 'zh-CN',
  exportsDir,
  batchSize: 120,
  now: now + 20_000
});
const partialFirst = readBatch(partialJob.packages[0]);
importAnalysisResult({
  db,
  text: JSON.stringify(batchAnswer(partialFirst, {
    summary: '这是部分导入演示的第一批结果。',
    titles: ['批次一的话题'],
    tone: 'neutral'
  })),
  now: now + 21_000
});

await createAnalysisJob({
  db,
  sessionId: waitingSession.id,
  locale: 'ja',
  exportsDir,
  batchSize: 200,
  now: now + 30_000
});

console.log(JSON.stringify({
  url: server.url,
  dataDir,
  sessions: {
    complete: completeSession.id,
    partial: partialSession.id,
    waiting: waitingSession.id,
    archived: archivedSession.id
  },
  jobs: {
    complete: completeJob.job.id,
    partial: partialJob.job.id
  }
}, null, 2));
console.log('All seeded sessions and AI answers are simulated development fixtures.');

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await server.close();
  try {
    rmSync(dataDir, {recursive: true, force: true});
  } catch {
    /* best effort */
  }
  process.exit(0);
}
process.on('SIGINT', () => { close().catch(() => process.exit(1)); });
process.on('SIGTERM', () => { close().catch(() => process.exit(1)); });
if (seconds > 0) setTimeout(() => { close().catch(() => process.exit(1)); }, seconds * 1000);
