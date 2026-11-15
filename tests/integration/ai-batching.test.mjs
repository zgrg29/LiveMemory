import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {
  T0,
  addBroadcaster,
  closeDatabase,
  makeAggregateResult,
  makeBatchResult,
  openMemoryDb,
  readAggregatePackage,
  readBatchPackage,
  seedSession
} from '../helpers/ai-fixtures.mjs';
import {buildAggregatePackage, createAnalysisJob} from '../../src/ai/export/job.mjs';
import {validateAnalysisImport} from '../../src/ai/import/validate.mjs';
import {importAnalysisResult} from '../../src/ai/import/importer.mjs';
import {buildSessionAnalysisReport} from '../../src/analytics/ai/report.mjs';
import {listJobBatches, getJob} from '../../src/storage/repositories/ai-jobs.mjs';
import {listResults} from '../../src/storage/repositories/ai-results.mjs';

async function batchFixture({messageCount = 2500, batchSize = 500} = {}) {
  const temp = createTempDir();
  const db = openMemoryDb();
  addBroadcaster(db);
  const session = seedSession(db, {messageCount});
  const exportsDir = join(temp.dir, 'exports');
  const created = await createAnalysisJob({
    db,
    sessionId: session.id,
    locale: 'zh-CN',
    exportsDir,
    batchSize,
    now: T0 + 600_000
  });
  const packages = created.packages.map((pkg) => ({pkg, data: readBatchPackage(exportsDir, pkg)}));
  return {temp, db, session, exportsDir, created, packages};
}

test('large streams are split on message boundaries without losing or duplicating a message', async () => {
  const {temp, db, session, packages, created} = await batchFixture();
  assert.equal(created.job.batchTotal, 5);
  assert.equal(packages.length, 5);
  assert.deepEqual(packages.map((entry) => entry.pkg.batchIndex), [1, 2, 3, 4, 5]);

  const eventIds = new Set();
  let total = 0;
  let expectedSeq = 1;
  for (const [index, entry] of packages.entries()) {
    const {manifest, messages} = entry.data;
    assert.equal(manifest.job_id, created.job.id);
    assert.equal(manifest.stage, 'batch');
    assert.equal(manifest.batch.total, 5);
    assert.equal(manifest.batch.index, index + 1);
    assert.equal(manifest.batch.batch_id, entry.pkg.batchId);
    assert.equal(manifest.batch.from_seq, expectedSeq);
    assert.equal(manifest.batch.to_seq, expectedSeq + messages.length - 1);
    assert.equal(manifest.batch.message_count, messages.length);
    assert.equal(messages.length, 500);
    assert.match(manifest.batch.checksum, /^[0-9a-f]{64}$/);
    // seq restarts in every package; the global mapping lives in the database.
    assert.deepEqual(messages.map((message) => message.seq), Array.from({length: 500}, (_, i) => i + 1));
    total += messages.length;
    expectedSeq += messages.length;
    for (const message of messages) {
      assert.ok(!eventIds.has(message.at + message.content), 'same message must not appear twice');
      eventIds.add(message.at + message.content);
    }
  }
  assert.equal(total, 2500);
  assert.equal(new Set(packages.map((entry) => entry.pkg.checksum)).size, 5);

  const mapping = db.prepare(`
    SELECT batch_index, seq, event_id FROM ai_job_messages WHERE job_id = ? ORDER BY batch_index, seq
  `).all(created.job.id);
  assert.equal(mapping.length, 2500);
  assert.equal(new Set(mapping.map((row) => row.event_id)).size, 2500);
  assert.equal(new Set(mapping.map((row) => `${row.batch_index}:${row.seq}`)).size, 2500);
  assert.equal(getJob(db, created.job.id).totalMessages, 2500);
  assert.equal(getJob(db, created.job.id).batchTotal, 5);
  assert.equal(listJobBatches(db, created.job.id).length, 5);
  closeDatabase(db);
  temp.cleanup();
});

test('batches can be imported out of order; duplicates and missing batches are reported honestly', async () => {
  const {temp, db, session, packages, created} = await batchFixture();
  const results = packages.map((entry) => makeBatchResult(
    entry.data.manifest,
    entry.data.messages,
    entry.data.viewers
  ));

  for (const index of [2, 0, 4]) {
    const preview = validateAnalysisImport({db, text: JSON.stringify(results[index]), now: T0 + 700_000 + index});
    assert.equal(preview.ok, true, JSON.stringify(preview.errors));
    const imported = importAnalysisResult({db, text: JSON.stringify(results[index]), now: T0 + 700_000 + index});
    assert.equal(imported.duplicate, false);
  }

  let report = buildSessionAnalysisReport(db, session.id);
  assert.equal(report.mode, 'partial');
  assert.equal(report.complete, false);
  assert.equal(report.perBatch.length, 3);
  assert.deepEqual(report.primaryJob.missingBatches, [2, 4]);
  assert.equal(report.report, null, 'partial batches are never merged into a fake whole report');

  const duplicate = importAnalysisResult({db, text: JSON.stringify(results[2]), now: T0 + 800_000});
  assert.equal(duplicate.duplicate, true);

  const wrongBatch = structuredClone(results[0]);
  wrongBatch.batch_id = packages[1].data.manifest.batch.batch_id;
  const wrongPreview = validateAnalysisImport({db, text: JSON.stringify(wrongBatch)});
  assert.equal(wrongPreview.ok, false);
  assert.ok(wrongPreview.errors.some((error) => error.code === 'BATCH_MISMATCH' || error.code === 'TASK_MISMATCH'));

  await assert.rejects(
    () => buildAggregatePackage({db, jobId: created.job.id, exportsDir: join(temp.dir, 'exports'), now: T0 + 810_000}),
    (error) => error.code === 'AGGREGATE_BATCHES_MISSING' && error.missing.length === 2
  );

  for (const index of [1, 3]) {
    importAnalysisResult({db, text: JSON.stringify(results[index]), now: T0 + 820_000 + index});
  }
  report = buildSessionAnalysisReport(db, session.id);
  assert.equal(report.mode, 'partial');
  assert.equal(report.incompleteReason, 'awaiting_aggregate');
  assert.equal(report.primaryJob.batchesImported, 5);
  assert.deepEqual(report.primaryJob.missingBatches, []);
  assert.equal(listResults(db, created.job.id).length, 5);
  closeDatabase(db);
  temp.cleanup();
});

test('the stage-2 aggregate package merges validated results and the final report does not concatenate batches', async () => {
  const {temp, db, session, exportsDir, packages, created} = await batchFixture();
  for (const [index, entry] of packages.entries()) {
    const payload = makeBatchResult(entry.data.manifest, entry.data.messages, entry.data.viewers);
    importAnalysisResult({db, text: JSON.stringify(payload), now: T0 + 700_000 + index});
  }
  const aggregate = await buildAggregatePackage({
    db,
    jobId: created.job.id,
    exportsDir,
    now: T0 + 900_000
  });
  assert.equal(aggregate.stage, 'aggregate');
  assert.equal(aggregate.batchCount, 5);
  const aggregateData = readAggregatePackage(exportsDir, aggregate);
  assert.equal(aggregateData.hasMessages, false, 'aggregate packages contain no raw chat log');
  assert.equal(aggregateData.batchResults.length, 5);
  assert.equal(aggregateData.manifest.stage, 'aggregate');
  assert.equal(aggregateData.manifest.tasks[0].kind, 'session_analysis_aggregate');
  assert.equal(aggregateData.manifest.batch_results.length, 5);

  const final = makeAggregateResult(aggregateData.manifest, aggregateData.batchResults);

  const ambiguous = structuredClone(final);
  ambiguous.session_topics.topics[0].message_refs = [1];
  const ambiguousPreview = validateAnalysisImport({db, text: JSON.stringify(ambiguous)});
  assert.ok(ambiguousPreview.errors.some((error) => error.code === 'REF_AMBIGUOUS'));

  const wrongBatchRef = structuredClone(final);
  wrongBatchRef.session_topics.topics[0].message_refs = [{batch: 99, seq: 1}];
  const wrongBatchPreview = validateAnalysisImport({db, text: JSON.stringify(wrongBatchRef)});
  assert.ok(wrongBatchPreview.errors.some((error) => error.code === 'REF_OTHER_BATCH'));

  const preview = validateAnalysisImport({db, text: JSON.stringify(final), now: T0 + 1_000_000});
  assert.equal(preview.ok, true, JSON.stringify(preview.errors));
  assert.equal(preview.target.mode, 'aggregate');
  const imported = importAnalysisResult({db, text: JSON.stringify(final), now: T0 + 1_000_000});
  assert.equal(imported.result.scopeKey, 'final');
  assert.equal(imported.status.status, 'complete');
  assert.equal(imported.job.aggregatePackageId, aggregate.id);

  const report = buildSessionAnalysisReport(db, session.id);
  assert.equal(report.mode, 'final');
  assert.equal(report.complete, true);
  assert.equal(report.perBatch.length, 0);
  assert.equal(report.report.topics.length, 1, 'aggregate topics are not concatenated batch topics');
  assert.deepEqual(report.report.topics[0].refs.map((ref) => ref.batchIndex), [1, 5]);
  assert.equal(report.report.highlights.length, 1);
  assert.equal(report.primaryJob.aggregateImported, true);
  closeDatabase(db);
  temp.cleanup();
});

test('a final aggregate answer is refused until every batch result exists', async () => {
  const {temp, db, exportsDir, packages, created} = await batchFixture();
  for (const index of [0, 1]) {
    const entry = packages[index];
    importAnalysisResult({
      db,
      text: JSON.stringify(makeBatchResult(entry.data.manifest, entry.data.messages, entry.data.viewers)),
      now: T0 + 700_000 + index
    });
  }
  await assert.rejects(
    () => buildAggregatePackage({db, jobId: created.job.id, exportsDir, now: T0 + 800_000}),
    (error) => error.code === 'AGGREGATE_BATCHES_MISSING'
  );
  const fakeAggregate = {
    protocol: 'livememory-analysis-result-v1',
    schema_version: '1.1.0',
    job_id: created.job.id,
    broadcaster_id: 'youtube:UC_AI_TEST',
    task_id: `${created.job.sessionId}-analysis-final`,
    session_id: created.job.sessionId,
    locale: 'zh-CN',
    session_topics: {summary: 'too early', topics: [], sentiment: [], disputes: [], highlights: []},
    viewer_profiles: []
  };
  const preview = validateAnalysisImport({db, text: JSON.stringify(fakeAggregate)});
  assert.equal(preview.ok, false);
  assert.ok(preview.errors.some((error) => error.code === 'AGGREGATE_NOT_READY'));
  closeDatabase(db);
  temp.cleanup();
});

test('a 12-batch job keeps complete seq → event mapping and stable batch ids', async () => {
  const temp = createTempDir();
  const db = openMemoryDb();
  addBroadcaster(db);
  const session = seedSession(db, {messageCount: 6000});
  const exportsDir = join(temp.dir, 'exports');
  const created = await createAnalysisJob({
    db,
    sessionId: session.id,
    locale: 'ja',
    exportsDir,
    batchSize: 500,
    now: T0 + 600_000
  });
  assert.equal(created.job.batchTotal, 12);
  assert.equal(created.packages.length, 12);
  const rows = db.prepare(`
    SELECT batch_index, COUNT(*) AS count FROM ai_job_messages WHERE job_id = ? GROUP BY batch_index ORDER BY batch_index
  `).all(created.job.id);
  assert.equal(rows.length, 12);
  assert.ok(rows.every((row) => Number(row.count) === 500));
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM ai_job_messages WHERE job_id = ?').get(created.job.id).c), 6000);
  const batchIds = new Set(created.packages.map((pkg) => pkg.batchId));
  assert.equal(batchIds.size, 12);
  // Re-exporting the same package set must never reuse a batch id silently; a
  // re-analysis is a new job with its own stable ids.
  const second = await createAnalysisJob({
    db,
    sessionId: session.id,
    locale: 'ja',
    exportsDir,
    batchSize: 500,
    now: T0 + 700_000
  });
  assert.notEqual(second.job.id, created.job.id);
  assert.notEqual(second.packages[0].batchId, created.packages[0].batchId);
  closeDatabase(db);
  temp.cleanup();
});
