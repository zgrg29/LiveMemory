import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {openDatabase, closeDatabase} from '../../src/storage/database/connection.mjs';
import {migrate} from '../../src/storage/database/migrations/index.mjs';
import {createSession, endSession, setSessionArchived} from '../../src/storage/repositories/sessions.mjs';
import {upsertBroadcaster} from '../../src/storage/repositories/broadcasters.mjs';
import {EventIngest} from '../../src/platforms/shared/ingest.mjs';
import {readZipEntry} from '../../src/shared/zip.mjs';

/**
 * Shared M6 fixtures. Everything is synthetic; no platform network is used.
 * Timestamps are fixed so assertions are reproducible.
 */
export const T0 = Date.parse('2026-11-08T10:00:00.000Z');
export const HOUR = 3600 * 1000;

export function openMemoryDb() {
  const db = openDatabase({memory: true});
  migrate(db);
  return db;
}

export function addBroadcaster(db, {id = 'youtube:UC_AI_TEST', name = 'AI Test Broadcaster', platform = 'youtube'} = {}) {
  const uid = id.split(':').slice(1).join(':');
  upsertBroadcaster(db, {
    id,
    platform,
    platformUid: uid,
    displayName: name,
    identity: 'verified',
    seenAt: T0,
    now: T0
  });
  return id;
}

export function seedSession(db, {
  id = null,
  platform = 'youtube',
  roomId = 'ai-test-room',
  title = 'M6 analysis test',
  broadcasterId = 'youtube:UC_AI_TEST',
  broadcasterName = 'AI Test Broadcaster',
  messageCount = 25,
  viewerCount = 2,
  viewerUidPrefix = 'UC_VIEWER',
  startedAt = T0,
  archived = false,
  simulated = true,
  messagePadding = 0
} = {}) {
  const session = createSession(db, {
    id,
    platform,
    platformRoomId: roomId,
    roomTitle: title,
    broadcasterName,
    broadcasterId,
    broadcasterIdentity: 'verified',
    storageMode: 'full',
    sourceQuality: 'mock',
    simulated,
    startedAt
  });
  const ingest = new EventIngest({db});
  const identifiable = Number(viewerCount) > 0;
  // Optional padding lets a test build a realistic multi-batch session without
  // depending on real chat data; the default keeps existing fixtures unchanged.
  const padding = Number(messagePadding) > 0 ? ` ${'x'.repeat(Math.floor(Number(messagePadding)))}` : '';
  for (let index = 0; index < messageCount; index += 1) {
    ingest.record({
      session_id: session.id,
      platform,
      event_type: 'chat',
      viewer_uid: identifiable ? `${viewerUidPrefix}_${index % viewerCount}` : '',
      display_name: identifiable ? `Viewer ${index % viewerCount}` : 'Anonymous',
      occurred_at: startedAt + 1000 + index * 1000,
      content: index === 0 ? 'Hello <script>alert(1)</script> 😂' : `Message ${index}${padding}`,
      external_id: `m6-${session.id}-${index}`,
      source_quality: 'mock'
    });
  }
  endSession(db, session.id, {
    status: 'ended',
    endedAt: startedAt + 1000 + messageCount * 1000,
    reason: 'adapter_end'
  });
  if (archived) setSessionArchived(db, session.id, true, {now: startedAt + HOUR});
  return session;
}

export function readBatchPackage(exportsDir, pkg) {
  const buffer = readFileSync(join(exportsDir, pkg.fileName));
  return {
    buffer,
    manifest: JSON.parse(readZipEntry(buffer, 'manifest.json').toString('utf8')),
    messages: readZipEntry(buffer, 'messages.jsonl').toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)),
    viewers: JSON.parse(readZipEntry(buffer, 'viewer_context.json').toString('utf8'))
  };
}

export function readAggregatePackage(exportsDir, pkg) {
  const buffer = readFileSync(join(exportsDir, pkg.fileName));
  return {
    buffer,
    manifest: JSON.parse(readZipEntry(buffer, 'manifest.json').toString('utf8')),
    batchResults: JSON.parse(readZipEntry(buffer, 'batch_results.json').toString('utf8')),
    viewers: JSON.parse(readZipEntry(buffer, 'viewer_context.json').toString('utf8')),
    hasMessages: (() => {
      try {
        readZipEntry(buffer, 'messages.jsonl');
        return true;
      } catch {
        return false;
      }
    })()
  };
}

/**
 * A schema-valid batch answer built from the package's real metadata. Tests use
 * this to exercise import semantics without claiming a real AI was involved.
 */
export function makeBatchResult(manifest, messages, viewers, overrides = {}) {
  const first = messages[0];
  const last = messages[messages.length - 1];
  const result = {
    protocol: 'livememory-analysis-result-v1',
    schema_version: '1.1.0',
    job_id: manifest.job_id,
    batch_id: manifest.batch.batch_id,
    broadcaster_id: manifest.broadcaster_id,
    task_id: manifest.tasks[0].task_id,
    session_id: manifest.session_id,
    locale: manifest.locale,
    session_topics: {
      summary: 'Synthetic analysis answer for tests.',
      topics: [{
        title: 'A test topic',
        started_at: first.at,
        ended_at: last.at,
        summary: 'The chat talked about testing.',
        key_points: ['First point', 'Second point'],
        confidence: 0.8,
        evidence: 'observed',
        message_refs: [1, Math.min(2, messages.length)]
      }],
      sentiment: [{
        at: first.at,
        tone: 'positive',
        note: 'Friendly chat.',
        confidence: 0.6,
        sample_size: Math.min(5, messages.length)
      }],
      disputes: [],
      highlights: [{
        started_at: first.at,
        ended_at: last.at,
        title: 'Test highlight',
        reason: 'Chat activity peaked.',
        clip_suggestion: 'Replay this segment.',
        confidence: 0.7,
        evidence: 'observed',
        message_refs: [1]
      }]
    },
    viewer_profiles: viewers.length > 0
      ? [{
        viewer_id: viewers[0].viewer_id,
        interests: [{topic: 'testing', strength: 'emerging', evidence: 'observed', note: 'Said it in chat.'}],
        dislikes: [],
        summary: 'Synthetic viewer profile.',
        confidence: 0.6
      }]
      : []
  };
  return {...result, ...overrides};
}

/** Build a final aggregate answer from the imported per-batch results. */
export function makeAggregateResult(aggregateManifest, batchResults, overrides = {}) {
  const firstTopic = batchResults[0].result.session_topics.topics[0];
  const lastTopic = batchResults[batchResults.length - 1].result.session_topics.topics[0];
  return {
    protocol: 'livememory-analysis-result-v1',
    schema_version: '1.1.0',
    job_id: aggregateManifest.job_id,
    broadcaster_id: aggregateManifest.broadcaster_id,
    task_id: aggregateManifest.tasks[0].task_id,
    session_id: aggregateManifest.session_id,
    locale: aggregateManifest.locale,
    session_topics: {
      summary: 'Synthetic session-wide aggregate.',
      topics: [{
        title: 'Merged topic',
        started_at: firstTopic.started_at,
        ended_at: lastTopic.ended_at,
        summary: 'Merged across batches.',
        key_points: ['One topic, not duplicates'],
        confidence: 0.7,
        evidence: 'inferred',
        message_refs: [{batch: 1, seq: 1}, {batch: batchResults.length, seq: 1}]
      }],
      sentiment: [{
        at: firstTopic.started_at,
        tone: 'mixed',
        note: 'Changed over time.',
        confidence: 0.5
      }],
      disputes: [],
      highlights: [{
        started_at: lastTopic.started_at,
        ended_at: lastTopic.ended_at,
        title: 'Final highlight',
        reason: 'Aggregate pick.',
        clip_suggestion: 'Review the final batch.',
        confidence: 0.6,
        evidence: 'inferred',
        message_refs: [{batch: batchResults.length, seq: 1}]
      }]
    },
    viewer_profiles: [],
    ...overrides
  };
}

export {closeDatabase};
