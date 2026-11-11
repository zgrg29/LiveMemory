import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {openMemoryDb, addBroadcaster, seedSession, T0, HOUR} from '../helpers/ai-fixtures.mjs';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {createAnalysisJob} from '../../src/ai/export/job.mjs';
import {readBatchPackage} from '../../src/ai/auto/prompt.mjs';
import {validateAnalysisImport} from '../../src/ai/import/validate.mjs';
import {importAnalysisResult} from '../../src/ai/import/importer.mjs';
import {jobMemoryCoverage} from '../../src/storage/repositories/ai-jobs.mjs';

/**
 * Real reported scale: 99 messages, 52 viewers, one manual batch, first-ever
 * memory. The exact model answer from the user's external AI is not in the
 * repository, so this test reproduces the *validation* outcome the user saw:
 * two invented ids plus two omitted viewers must be rejected with precise
 * diagnostics, and a corrected answer must import all 52 viewers.
 */

const VIEWERS = 52;
const MESSAGES = 99;

function setup(t) {
  const db = openMemoryDb();
  addBroadcaster(db);
  const temp = createTempDir();
  t.after(() => {
    db.close();
    temp.cleanup();
  });
  const session = seedSession(db, {
    id: 'ses_manual_52',
    messageCount: MESSAGES,
    viewerCount: VIEWERS,
    viewerUidPrefix: 'UC_MANUAL52',
    startedAt: T0
  });
  const exportsDir = join(temp.dir, 'exports');
  return {db, temp, session, exportsDir};
}

async function manualJob(context) {
  const created = await createAnalysisJob({
    db: context.db,
    sessionId: context.session.id,
    locale: 'ja',
    exportsDir: context.exportsDir,
    batchSize: 1000,
    memoryViewersPerBatch: 200,
    maxMemoryExcerptMessages: 3000,
    now: T0 + HOUR
  });
  const files = readBatchPackage(context.exportsDir, created.packages[0].fileName);
  return {created, files};
}

function answerFor(job, files, {omit = [], replace = {}, extra = []} = {}) {
  const manifest = JSON.parse(files['manifest.json']);
  const memory = JSON.parse(files['memory_context.json']);
  const viewerContext = JSON.parse(files['viewer_context.json']);
  const updates = memory.viewers
    .filter((viewer) => !omit.includes(viewer.viewer_id))
    .map((viewer) => ({
      viewer_id: replace[viewer.viewer_id] ?? viewer.viewer_id,
      no_new_information: true,
      operations: []
    }));
  for (const viewerId of extra) {
    updates.push({viewer_id: viewerId, no_new_information: true, operations: []});
  }
  return {
    protocol: 'livememory-analysis-result-v1',
    schema_version: '1.2.0',
    job_id: manifest.job_id,
    batch_id: manifest.batch.batch_id,
    broadcaster_id: manifest.broadcaster_id,
    task_id: manifest.tasks[0].task_id,
    session_id: manifest.session_id,
    locale: manifest.locale,
    session_topics: {
      summary: '1分ほどの短い配信。挨拶と雑談が中心。',
      topics: [],
      sentiment: [],
      disputes: [],
      highlights: []
    },
    viewer_profiles: [{
      viewer_id: viewerContext[0].viewer_id,
      interests: [],
      dislikes: [],
      summary: '',
      confidence: 0.2
    }],
    viewer_memory_updates: updates
  };
}

test('52 viewers are a single manual batch with exact evidence seqs and ids', async (t) => {
  const context = setup(t);
  const {files} = await manualJob(context);
  const manifest = JSON.parse(files['manifest.json']);
  const memory = JSON.parse(files['memory_context.json']);
  assert.equal(manifest.batch.total, 1);
  assert.equal(manifest.batch.message_count, MESSAGES);
  assert.equal(memory.viewers.length, VIEWERS);
  const withEvidence = memory.viewers.filter((viewer) => viewer.evidence_seqs.length > 0);
  assert.equal(withEvidence.length, VIEWERS);
  // Every seq points at a line written by the same viewer.
  const excerpts = files['viewer_excerpts.jsonl'].split('\n').filter(Boolean).map((line) => JSON.parse(line));
  for (const viewer of memory.viewers) {
    for (const seq of viewer.evidence_seqs) {
      assert.equal(excerpts[seq - 1].viewer_id, viewer.viewer_id);
    }
  }
});

test('two invented ids and two omissions are rejected with exact gaps', async (t) => {
  const context = setup(t);
  const {created, files} = await manualJob(context);
  const memory = JSON.parse(files['memory_context.json']);
  const omitted = [memory.viewers[6].viewer_id, memory.viewers[7].viewer_id];
  const invented = ['youtube:UC_NOT_A_VIEWER', 'youtube:UC_ALSO_NOT_A_VIEWER'];
  const answer = answerFor(created.job, files, {
    omit: omitted,
    extra: invented
  });
  const preview = validateAnalysisImport({
    db: context.db,
    text: JSON.stringify(answer),
    now: T0 + HOUR + 1000
  });
  assert.equal(preview.ok, false);
  assert.equal(preview.action, 'blocked');
  const codes = preview.errors.map((error) => error.code);
  assert.equal(codes.filter((code) => code === 'MEMORY_VIEWER_UNKNOWN').length, 2);
  assert.equal(codes.filter((code) => code === 'MEMORY_VIEWER_UPDATE_MISSING').length, 2);
  assert.deepEqual(
    preview.target.memory.gaps.missing.map((entry) => entry.viewerId).sort(),
    [...omitted].sort()
  );
  assert.deepEqual(
    preview.target.memory.gaps.unknown.map((entry) => entry.viewerId).sort(),
    [...invented].sort()
  );
  // Nothing was written by a preview, even when it parsed the ids.
  assert.equal(context.db.prepare('SELECT COUNT(*) AS c FROM ai_results').get().c, 0);
});

test('the corrected 52-viewer answer imports in one transaction', async (t) => {
  const context = setup(t);
  const {created, files} = await manualJob(context);
  const answer = answerFor(created.job, files);
  const preview = validateAnalysisImport({
    db: context.db,
    text: JSON.stringify(answer),
    now: T0 + HOUR + 1000
  });
  assert.equal(preview.ok, true, JSON.stringify(preview.errors));
  assert.equal(preview.target.memory.coverage.total, VIEWERS);
  assert.equal(preview.target.memory.coverage.missing_update, 0);
  const imported = importAnalysisResult({
    db: context.db,
    text: JSON.stringify(answer),
    now: T0 + HOUR + 1000
  });
  assert.equal(imported.duplicate, false);
  const coverage = jobMemoryCoverage(context.db, created.job.id);
  assert.equal(coverage.total, VIEWERS);
  assert.equal(coverage.no_semantics, VIEWERS);
  assert.equal(coverage.complete, true);
});
