import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {addBroadcaster, openMemoryDb, seedSession, T0} from '../helpers/ai-fixtures.mjs';
import {T_DAY} from '../helpers/memory-fixtures.mjs';
import {createMemoryUpdateJob, inspectMemoryPackage} from '../../src/memory/export.mjs';
import {importMemoryUpdate} from '../../src/memory/importer.mjs';
import {validateMemoryImport} from '../../src/memory/validate.mjs';
import {buildViewerMemoryView} from '../../src/memory/view.mjs';
import {mergeSessionIntoMemory} from '../../src/memory/local.mjs';
import {importSessionAnalysis} from '../helpers/memory-fixtures.mjs';
import {deleteViewerMemory, pruneStaleMemories, memoryRetentionStatus} from '../../src/memory/maintenance.mjs';
import {getMemoryJob, getMemory, listFacts, listVersions, listMemoryBatches} from '../../src/storage/repositories/viewer-memory.mjs';
import {runRetention} from '../../src/storage/retention.mjs';
import {deleteSessionRecord} from '../../src/server/session-admin.mjs';
import {__internal as maintenanceInternal} from '../../src/server/maintenance.mjs';

const BROADCASTER = 'youtube:UC_AI_TEST';
const OTHER_BROADCASTER = 'youtube:UC_OTHER';
const VIEWER = 'youtube:UC_VIEWER_0';

async function seedMemory({db, exportsDir, sessionId, viewerId = VIEWER, topic = 'testing', now = T0 + 500}) {
  const created = await createMemoryUpdateJob({
    db, sessionId, locale: 'en', exportsDir, now
  });
  const pkg = await inspectMemoryPackage(join(exportsDir, created.batches[0].fileName));
  const targetViewer = pkg.context.viewers.find((entry) => entry.viewer_id === viewerId) ?? pkg.context.viewers[0];
  const seq = pkg.excerpts.find((entry) => entry.viewer_id === targetViewer.viewer_id).seq;
  const result = {
    protocol: 'livememory-memory-update-v1',
    schema_version: '1.0.0',
    job_id: pkg.manifest.job_id,
    batch_id: pkg.manifest.batch.batch_id,
    broadcaster_id: pkg.manifest.broadcaster_id,
    task_id: pkg.manifest.batch.task_id,
    session_id: pkg.manifest.session_id,
    locale: pkg.manifest.locale,
    viewer_operations: [{
      viewer_id: targetViewer.viewer_id,
      operations: [{
        op: 'add',
        kind: 'topic',
        topic,
        statement: `talks about ${topic}`,
        certainty: 'inferred',
        evidence: [seq]
      }]
    }]
  };
  const text = JSON.stringify(result);
  importMemoryUpdate({db, text, now: now + 500});
  return {created, pkg, text, viewerId: targetViewer.viewer_id};
}

test('deleting a memory removes facts and blocks an older package from restoring it', async () => {
  const db = openMemoryDb();
  const exportsDir = mkdtempSync(join(tmpdir(), 'lm-memory-privacy-'));
  try {
    addBroadcaster(db);
    const session = seedSession(db, {messageCount: 10, viewerCount: 1});
    const seeded = await seedMemory({db, exportsDir, sessionId: session.id});
    const memory = getMemory(db, {broadcasterId: BROADCASTER, viewerId: seeded.viewerId});
    assert.equal(memory.version, 1);

    const removed = deleteViewerMemory({
      db,
      broadcasterId: BROADCASTER,
      viewerId: seeded.viewerId,
      confirm: true,
      now: T0 + 2000
    });
    assert.equal(removed.deleted, true);
    assert.equal(removed.factsRemoved, 1);
    assert.equal(removed.versionsRemoved, 1);

    const tombstone = getMemory(db, {broadcasterId: BROADCASTER, viewerId: seeded.viewerId});
    assert.equal(tombstone.status, 'deleted');
    assert.equal(tombstone.version, 0);
    assert.ok(tombstone.deletedAt);
    assert.equal(listFacts(db, tombstone.id).length, 0);
    assert.equal(listVersions(db, tombstone.id).length, 0);

    // The package was generated before the deletion, so it must not be applicable.
    const preview = validateMemoryImport({db, text: seeded.text, now: T0 + 3000});
    assert.equal(preview.ok, false);
    assert.ok(preview.errors.some((error) => error.code === 'MEMORY_DELETED'));
    assert.throws(
      () => importMemoryUpdate({db, text: seeded.text, now: T0 + 3000}),
      (error) => error.code === 'MEMORY_IMPORT_INVALID'
    );
    assert.equal(getMemory(db, {broadcasterId: BROADCASTER, viewerId: seeded.viewerId}).version, 0);
  } finally {
    db.close();
    rmSync(exportsDir, {recursive: true, force: true});
  }
});

test('a job created after a deletion may start a fresh memory', async () => {
  const db = openMemoryDb();
  const exportsDir = mkdtempSync(join(tmpdir(), 'lm-memory-refresh-'));
  try {
    addBroadcaster(db);
    const session = seedSession(db, {messageCount: 10, viewerCount: 1});
    const seeded = await seedMemory({db, exportsDir, sessionId: session.id});
    deleteViewerMemory({
      db,
      broadcasterId: BROADCASTER,
      viewerId: seeded.viewerId,
      confirm: true,
      now: T0 + 2000
    });

    const later = await seedMemory({
      db,
      exportsDir,
      sessionId: session.id,
      topic: 'fresh start',
      now: T0 + 3000
    });
    assert.equal(later.viewerId, seeded.viewerId);
    const memory = getMemory(db, {broadcasterId: BROADCASTER, viewerId: seeded.viewerId});
    assert.equal(memory.status, 'active');
    assert.equal(memory.version, 1);
    const topics = listFacts(db, memory.id).map((fact) => fact.topic);
    assert.deepEqual(topics, ['fresh start']);
  } finally {
    db.close();
    rmSync(exportsDir, {recursive: true, force: true});
  }
});

test('the no-AI merge never resurrects a deleted memory', async () => {
  const db = openMemoryDb();
  const exportsDir = mkdtempSync(join(tmpdir(), 'lm-memory-noresurrect-'));
  try {
    addBroadcaster(db);
    const session = seedSession(db, {messageCount: 6, viewerCount: 1});
    await importSessionAnalysis({
      db, sessionId: session.id, exportsDir,
      profiles: [{
        viewer_id: VIEWER,
        interests: [{topic: 'something', strength: 'stable', evidence: 'observed', note: 'note'}],
        dislikes: [],
        summary: 'summary',
        confidence: 0.6
      }]
    });
    mergeSessionIntoMemory({db, sessionId: session.id, apply: true, now: T0 + 1000});
    deleteViewerMemory({
      db, broadcasterId: BROADCASTER, viewerId: VIEWER, confirm: true, now: T0 + 2000
    });

    const preview = mergeSessionIntoMemory({db, sessionId: session.id, now: T0 + 3000});
    assert.equal(preview.ok, true);
    assert.equal(preview.totals.deleted, 1);
    assert.equal(preview.viewers[0].deleted, true);

    const applied = mergeSessionIntoMemory({db, sessionId: session.id, apply: true, now: T0 + 4000});
    assert.equal(applied.totals.deleted, 1);
    const memory = getMemory(db, {broadcasterId: BROADCASTER, viewerId: VIEWER});
    assert.equal(memory.status, 'deleted');
    assert.equal(memory.version, 0);
    assert.equal(listFacts(db, memory.id).length, 0);
  } finally {
    db.close();
    rmSync(exportsDir, {recursive: true, force: true});
  }
});

test('per-broadcaster deletion leaves the other channel memory untouched', async () => {
  const db = openMemoryDb();
  try {
    addBroadcaster(db, {id: BROADCASTER, name: 'A'});
    addBroadcaster(db, {id: OTHER_BROADCASTER, name: 'B'});
    const sessionA = seedSession(db, {
      messageCount: 4, viewerCount: 1, broadcasterId: BROADCASTER, broadcasterName: 'A'
    });
    const sessionB = seedSession(db, {
      messageCount: 4,
      viewerCount: 1,
      roomId: 'b-room',
      broadcasterId: OTHER_BROADCASTER,
      broadcasterName: 'B',
      startedAt: T0 + T_DAY
    });
    const exportsDir = mkdtempSync(join(tmpdir(), 'lm-memory-isolate-'));
    try {
      await importSessionAnalysis({
        db, sessionId: sessionA.id, exportsDir,
        profiles: [{
          viewer_id: VIEWER,
          interests: [{topic: 'a-only', strength: 'stable', evidence: 'observed', note: 'a'}],
          dislikes: [],
          summary: 'a',
          confidence: 0.6
        }]
      });
      mergeSessionIntoMemory({db, sessionId: sessionA.id, apply: true, now: T0 + 1000});
      await importSessionAnalysis({
        db, sessionId: sessionB.id, exportsDir,
        profiles: [{
          viewer_id: VIEWER,
          interests: [{topic: 'b-only', strength: 'stable', evidence: 'observed', note: 'b'}],
          dislikes: [],
          summary: 'b',
          confidence: 0.6
        }]
      });
      mergeSessionIntoMemory({db, sessionId: sessionB.id, apply: true, now: T0 + T_DAY + 1000});

      deleteViewerMemory({
        db, broadcasterId: BROADCASTER, viewerId: VIEWER, confirm: true, now: T0 + 2 * T_DAY
      });
      assert.equal(getMemory(db, {broadcasterId: BROADCASTER, viewerId: VIEWER}).status, 'deleted');
      const otherMemory = getMemory(db, {broadcasterId: OTHER_BROADCASTER, viewerId: VIEWER});
      assert.equal(otherMemory.status, 'active');
      assert.deepEqual(listFacts(db, otherMemory.id).map((fact) => fact.topic), ['b-only']);
    } finally {
      rmSync(exportsDir, {recursive: true, force: true});
    }
  } finally {
    db.close();
  }
});

test('raw chat purging downgrades evidence instead of silently keeping it', async () => {
  const db = openMemoryDb();
  const exportsDir = mkdtempSync(join(tmpdir(), 'lm-memory-purge-'));
  try {
    addBroadcaster(db);
    const session = seedSession(db, {messageCount: 10, viewerCount: 1});
    const seeded = await seedMemory({db, exportsDir, sessionId: session.id});
    const memory = getMemory(db, {broadcasterId: BROADCASTER, viewerId: seeded.viewerId});
    assert.equal(listFacts(db, memory.id)[0].evidenceStatus, 'available');

    // Simulate the YouTube 30-day raw-chat retention window.
    const summary = runRetention(db, {now: T0 + 40 * T_DAY, days: 30, platforms: ['youtube']});
    assert.ok(summary.purged > 0);
    assert.ok(summary.memoryFactsRechecked >= 1);

    const facts = listFacts(db, memory.id);
    assert.equal(facts.length, 1, 'memory is kept after the raw chat is gone');
    assert.equal(facts[0].evidenceStatus, 'purged');
    const view = buildViewerMemoryView(db, {broadcasterId: BROADCASTER, viewerId: seeded.viewerId});
    assert.equal(view.facts[0].evidence[0].verified, false);
    assert.equal(view.facts[0].evidence[0].purged, true);
    assert.equal(view.evidence.purged, 1);
  } finally {
    db.close();
    rmSync(exportsDir, {recursive: true, force: true});
  }
});

test('deleting a session removes its memory packages and degrades the evidence', async () => {
  const db = openMemoryDb();
  const exportsDir = mkdtempSync(join(tmpdir(), 'lm-memory-session-'));
  try {
    addBroadcaster(db);
    const first = seedSession(db, {messageCount: 8, viewerCount: 1, roomId: 'r1', title: 'first'});
    const second = seedSession(db, {
      messageCount: 8, viewerCount: 1, roomId: 'r2', title: 'second', startedAt: T0 + T_DAY
    });
    const seededFirst = await seedMemory({db, exportsDir, sessionId: first.id, topic: 'first topic'});
    await seedMemory({db, exportsDir, sessionId: second.id, topic: 'second topic'});
    const memory = getMemory(db, {broadcasterId: BROADCASTER, viewerId: seededFirst.viewerId});
    assert.equal(memory.version, 2);
    const jobId = seededFirst.created.job.id;
    const batch = listMemoryBatches(db, jobId)[0];
    const filePath = join(exportsDir, batch.fileName);
    assert.equal(existsSync(filePath), true);

    const result = await deleteSessionRecord({
      deps: {
        db,
        sessionManager: {getRecording: () => null},
        paths: {exports: exportsDir},
        logger: {info() {}}
      },
      sessionId: first.id,
      confirm: true,
      now: T0 + 3 * T_DAY
    });
    assert.equal(result.deleted, true);
    assert.equal(getMemoryJob(db, jobId), null);
    assert.equal(existsSync(filePath), false);

    const surviving = getMemory(db, {broadcasterId: BROADCASTER, viewerId: seededFirst.viewerId});
    assert.ok(surviving, 'the viewer still exists through the other session');
    const facts = listFacts(db, surviving.id);
    assert.equal(facts.length, 2);
    const firstFact = facts.find((fact) => fact.sourceSessionId === first.id);
    assert.equal(firstFact.evidenceStatus, 'unavailable');
    assert.equal(firstFact.status, 'active', 'a deleted source does not silently remove knowledge');
  } finally {
    db.close();
    rmSync(exportsDir, {recursive: true, force: true});
  }
});

test('stale memories can be previewed and pruned by age', async () => {
  const db = openMemoryDb();
  const exportsDir = mkdtempSync(join(tmpdir(), 'lm-memory-prune-'));
  try {
    addBroadcaster(db);
    const session = seedSession(db, {messageCount: 6, viewerCount: 1});
    await importSessionAnalysis({
      db, sessionId: session.id, exportsDir,
      profiles: [{
        viewer_id: VIEWER,
        interests: [{topic: 'old', strength: 'stable', evidence: 'observed', note: 'old'}],
        dislikes: [],
        summary: 'old',
        confidence: 0.6
      }]
    });
    mergeSessionIntoMemory({db, sessionId: session.id, apply: true, now: T0 + 1000});

    const preview = pruneStaleMemories({db, broadcasterId: BROADCASTER, olderThanDays: 30, dryRun: true, now: T0 + 100 * T_DAY});
    assert.equal(preview.dryRun, true);
    assert.equal(preview.candidates, 1);
    assert.equal(getMemory(db, {broadcasterId: BROADCASTER, viewerId: VIEWER}).status, 'active');

    const applied = pruneStaleMemories({db, broadcasterId: BROADCASTER, olderThanDays: 30, dryRun: false, now: T0 + 100 * T_DAY});
    assert.equal(applied.removed, 1);
    assert.equal(getMemory(db, {broadcasterId: BROADCASTER, viewerId: VIEWER}).status, 'deleted');

    const retention = memoryRetentionStatus(db, {broadcasterId: BROADCASTER});
    assert.equal(retention.keepUntilDeleted, true);
    assert.equal(retention.evidenceFollowsRawRetention, true);
    assert.equal(retention.deletedMemories, 1);
  } finally {
    db.close();
    rmSync(exportsDir, {recursive: true, force: true});
  }
});

test('clearing data removes every memory table', async () => {
  const db = openMemoryDb();
  const exportsDir = mkdtempSync(join(tmpdir(), 'lm-memory-clear-'));
  try {
    addBroadcaster(db);
    const session = seedSession(db, {messageCount: 6, viewerCount: 1});
    await seedMemory({db, exportsDir, sessionId: session.id});
    maintenanceInternal.clearDatabase(db, {factory: true});
    for (const table of [
      'viewer_memories', 'memory_facts', 'memory_fact_evidence', 'memory_versions',
      'memory_jobs', 'memory_job_batches', 'memory_job_messages', 'memory_job_viewers', 'memory_results'
    ]) {
      const count = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0);
      assert.equal(count, 0, `${table} still has rows`);
    }
  } finally {
    db.close();
    rmSync(exportsDir, {recursive: true, force: true});
  }
});
