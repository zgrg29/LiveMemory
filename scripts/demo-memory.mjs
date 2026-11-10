/**
 * Development-only fixture for the M7 long-term memory UI.
 *
 * Seeds simulated broadcasts (never real platform data), imports a synthetic M6
 * analysis built from the real exported package, applies the deterministic
 * memory merge, and imports one synthetic AI memory update containing a state
 * change and a contradiction. Then serves the console so the pages can be
 * inspected or screenshotted.
 *
 *   node scripts/demo-memory.mjs [--port 49420] [--seconds 0] [--data-dir D:\tmp\lm]
 *
 * Press Ctrl+C to stop (or pass --seconds to exit automatically).
 */

import {existsSync, mkdirSync, rmSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {openDatabase, closeDatabase} from '../src/storage/database/connection.mjs';
import {migrate} from '../src/storage/database/migrations/index.mjs';
import {startServer} from '../src/server/index.mjs';
import {addBroadcaster, seedSession, readBatchPackage, makeBatchResult} from '../tests/helpers/ai-fixtures.mjs';
import {createAnalysisJob} from '../src/ai/export/job.mjs';
import {importAnalysisResult} from '../src/ai/import/importer.mjs';
import {mergeSessionIntoMemory} from '../src/memory/local.mjs';
import {createMemoryUpdateJob, inspectMemoryPackage} from '../src/memory/export.mjs';
import {importMemoryUpdate} from '../src/memory/importer.mjs';
import {getMemory, listFacts} from '../src/storage/repositories/viewer-memory.mjs';

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}
const port = Number(argValue('--port', 49420));
const seconds = Number(argValue('--seconds', 0));
const keepData = args.includes('--keep');
const dataDir = argValue('--data-dir', join(resolve('tests', '.tmp'), `demo-memory-${Date.now()}`));
mkdirSync(dataDir, {recursive: true});

const T0 = Date.parse('2026-11-10T02:00:00.000Z');
const DAY = 24 * 3600 * 1000;
const VIEWER_A = 'youtube:UC_VIEWER_0';
const VIEWER_B = 'youtube:UC_VIEWER_1';
const BROADCASTER = 'youtube:UC_AI_TEST';

const db = openDatabase({file: join(dataDir, 'database', 'livememory.db'), createDirectory: true});
migrate(db, {now: T0});
addBroadcaster(db, {id: BROADCASTER, name: 'Memory Demo Channel'});
const first = seedSession(db, {messageCount: 20, viewerCount: 2, startedAt: T0});
const second = seedSession(db, {
  messageCount: 20,
  viewerCount: 2,
  roomId: 'memory-demo-room-2',
  title: 'Memory demo · second broadcast',
  startedAt: T0 + DAY
});
const exportsDir = join(dataDir, 'exports');
mkdirSync(exportsDir, {recursive: true});

const analysisJob = await createAnalysisJob({
  db,
  sessionId: first.id,
  locale: 'zh-CN',
  exportsDir,
  batchSize: 100000
});
for (const pkg of analysisJob.packages) {
  const data = readBatchPackage(exportsDir, pkg);
  const result = makeBatchResult(data.manifest, data.messages, data.viewers, {
    viewer_profiles: [
      {
        viewer_id: VIEWER_A,
        interests: [
          {topic: '音乐游戏', strength: 'stable', evidence: 'observed', note: '经常聊音乐游戏'},
          {topic: '中文学习', strength: 'emerging', evidence: 'observed', note: '最近在学中文'}
        ],
        dislikes: [],
        summary: '长期观众，喜欢音乐游戏。',
        confidence: 0.7
      },
      {
        viewer_id: VIEWER_B,
        interests: [{topic: '音游', strength: 'stable', evidence: 'observed', note: '也聊音游'}],
        dislikes: [],
        summary: '话不多但每场都在。',
        confidence: 0.5
      }
    ]
  });
  importAnalysisResult({db, text: JSON.stringify(result), now: T0});
}
mergeSessionIntoMemory({db, sessionId: first.id, apply: true, now: T0 + 1000});

const job = await createMemoryUpdateJob({
  db,
  sessionId: second.id,
  locale: 'zh-CN',
  exportsDir,
  now: T0 + DAY + 1000
});
const pkg = await inspectMemoryPackage(join(exportsDir, job.batches[0].fileName));
const memoryA = getMemory(db, {broadcasterId: BROADCASTER, viewerId: VIEWER_A});
const factA = listFacts(db, memoryA.id).find((fact) => fact.topic === '音乐游戏');
const memoryB = getMemory(db, {broadcasterId: BROADCASTER, viewerId: VIEWER_B});
const factB = listFacts(db, memoryB.id).find((fact) => fact.topic === '音游');
const seqFor = (viewerId) => pkg.excerpts.find((line) => line.viewer_id === viewerId)?.seq ?? 1;
importMemoryUpdate({
  db,
  text: JSON.stringify({
    protocol: 'livememory-memory-update-v1',
    schema_version: '1.0.0',
    job_id: pkg.manifest.job_id,
    batch_id: pkg.manifest.batch.batch_id,
    broadcaster_id: pkg.manifest.broadcaster_id,
    task_id: pkg.manifest.batch.task_id,
    session_id: pkg.manifest.session_id,
    locale: pkg.manifest.locale,
    viewer_operations: [
      {
        viewer_id: VIEWER_A,
        summary: '正在准备考试，仍然喜欢音乐游戏。',
        operations: [
          {
            op: 'supersede',
            target_fact_id: factA.id,
            kind: 'life_event',
            topic: '考试',
            statement: '下周要考试，最近在复习',
            certainty: 'stated',
            confidence: 0.9,
            evidence: [seqFor(VIEWER_A)]
          },
          {
            op: 'add',
            kind: 'life_event',
            topic: '搬家',
            statement: '可能准备搬到别的城市',
            certainty: 'uncertain',
            evidence: [seqFor(VIEWER_B)]
          }
        ]
      },
      {
        viewer_id: VIEWER_B,
        operations: [
          {
            op: 'conflict',
            target_fact_id: factB.id,
            kind: 'dislike',
            topic: '音游',
            statement: '说音游是最无聊的',
            certainty: 'stated',
            confidence: 0.6,
            evidence: [seqFor(VIEWER_B)]
          }
        ]
      }
    ]
  }),
  createVersion: true,
  now: T0 + DAY + 2000
});
closeDatabase(db);

const server = await startServer({dataDir, port});
console.log(`LiveMemory memory demo: ${server.url}#/memory`);
console.log(`Broadcaster: ${BROADCASTER}`);
console.log(`Viewer: ${server.url}#/viewers/${encodeURIComponent(VIEWER_A)}?broadcaster=${encodeURIComponent(BROADCASTER)}`);
console.log('Seeded data is simulated. No real platform data was used.');

async function stop() {
  await server.close();
  if (!keepData) {
    try {
      rmSync(dataDir, {recursive: true, force: true});
    } catch {
      /* best effort */
    }
  }
  process.exit(0);
}
process.on('SIGINT', () => { stop().catch(() => {}); });
process.on('SIGTERM', () => { stop().catch(() => {}); });
if (seconds > 0) {
  const timer = setTimeout(() => { stop().catch(() => {}); }, seconds * 1000);
  timer.unref();
}
void existsSync;
