import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {
  T0,
  addBroadcaster,
  closeDatabase,
  makeBatchResult,
  openMemoryDb,
  readBatchPackage,
  seedSession
} from '../helpers/ai-fixtures.mjs';
import {createAnalysisJob} from '../../src/ai/export/job.mjs';
import {buildAnalysisPackage} from '../../src/ai/export/package.mjs';
import {validateAnalysisImport} from '../../src/ai/import/validate.mjs';
import {importAnalysisResult} from '../../src/ai/import/importer.mjs';
import {buildSessionAnalysisReport} from '../../src/analytics/ai/report.mjs';
import {getSession} from '../../src/storage/repositories/sessions.mjs';
import {purgeSessionContent} from '../../src/storage/repositories/events.mjs';
import {listResults} from '../../src/storage/repositories/ai-results.mjs';
import {listJobs} from '../../src/storage/repositories/ai-jobs.mjs';
import {deleteSessionRecord} from '../../src/server/session-admin.mjs';
import {__internal as maintenance} from '../../src/server/maintenance.mjs';

async function jobFixture({messageCount = 25, batchSize = 1000, sessionOptions = {}} = {}) {
  const temp = createTempDir();
  const db = openMemoryDb();
  addBroadcaster(db);
  const session = seedSession(db, {messageCount, ...sessionOptions});
  const exportsDir = join(temp.dir, 'exports');
  const job = await createAnalysisJob({db, sessionId: session.id, locale: 'en', exportsDir, batchSize, now: T0 + 600_000});
  const packageData = readBatchPackage(exportsDir, job.packages[0]);
  return {temp, db, session, exportsDir, job, packageData};
}

function payloadFor(packageData, overrides = {}) {
  return makeBatchResult(packageData.manifest, packageData.messages, packageData.viewers, overrides);
}

test('single-batch export, import and report keep evidence traceable to real messages', async () => {
  const {temp, db, session, packageData, exportsDir} = await jobFixture();
  const payload = payloadFor(packageData);
  const preview = validateAnalysisImport({db, text: JSON.stringify(payload), now: T0 + 700_000});
  assert.equal(preview.ok, true);
  assert.equal(preview.action, 'import');
  assert.equal(preview.target.batch.batchIndex, 1);
  assert.equal(preview.target.taskId, packageData.manifest.tasks[0].task_id);
  assert.equal(preview.evidenceRows.length, 3);

  const imported = importAnalysisResult({db, text: JSON.stringify(payload), now: T0 + 700_000});
  assert.equal(imported.duplicate, false);
  assert.equal(imported.result.resultVersion, 1);
  assert.equal(imported.status.status, 'complete');
  assert.equal(getSession(db, session.id).ai_status, 'imported');

  const report = buildSessionAnalysisReport(db, session.id);
  assert.equal(report.mode, 'single');
  assert.equal(report.complete, true);
  assert.equal(report.report.summary, 'Synthetic analysis answer for tests.');
  assert.equal(report.report.topics.length, 1);
  assert.equal(report.report.topics[0].refs.length, 2);
  assert.equal(report.report.topics[0].refs[0].seq, 1);
  assert.equal(report.report.topics[0].refs[0].available, true);
  assert.match(report.report.topics[0].refs[0].content, /<script>alert\(1\)<\/script>/);
  assert.equal(report.result.schemaVersion, '1.1.0');
  assert.equal(report.primaryJob.promptVersion, 'lm-prompt-m6.3-en');
  assert.equal(report.viewerProfiles.count, 1);

  // Creating a re-analysis task must not downgrade an already imported session.
  await createAnalysisJob({
    db,
    sessionId: session.id,
    locale: 'en',
    exportsDir,
    batchSize: 1000,
    now: T0 + 800_000
  });
  assert.equal(getSession(db, session.id).ai_status, 'imported');
  closeDatabase(db);
  temp.cleanup();
});

test('invalid JSON, missing fields, wrong types, unknown fields and bad versions are rejected with paths', async () => {
  const {temp, db, packageData} = await jobFixture();
  const base = payloadFor(packageData);

  const invalidJson = validateAnalysisImport({db, text: '{not json'});
  assert.equal(invalidJson.ok, false);
  assert.equal(invalidJson.errors[0].code, 'INVALID_JSON');

  const fenced = validateAnalysisImport({db, text: `\`\`\`json\n${JSON.stringify(base, null, 2)}\n\`\`\``});
  assert.equal(fenced.ok, true, 'one Markdown fence may be stripped');
  assert.equal(fenced.action, 'import');

  const missing = structuredClone(base);
  delete missing.session_topics.summary;
  const missingPreview = validateAnalysisImport({db, text: JSON.stringify(missing)});
  assert.equal(missingPreview.ok, false);
  assert.ok(missingPreview.errors.some((error) => error.code === 'SCHEMA_REQUIRED'
    && error.path === 'session_topics.summary'));

  const wrongType = structuredClone(base);
  wrongType.session_topics.topics[0].confidence = 'high';
  const typePreview = validateAnalysisImport({db, text: JSON.stringify(wrongType)});
  assert.ok(typePreview.errors.some((error) => error.code === 'SCHEMA_TYPE'
    && error.path === 'session_topics.topics[0].confidence'));

  const unknown = structuredClone(base);
  unknown.session_topics.topics[0].html = '<b>no</b>';
  const unknownPreview = validateAnalysisImport({db, text: JSON.stringify(unknown)});
  assert.ok(unknownPreview.errors.some((error) => error.code === 'SCHEMA_UNKNOWN_FIELD'));

  const badVersion = structuredClone(base);
  badVersion.schema_version = '9.9.9';
  const versionPreview = validateAnalysisImport({db, text: JSON.stringify(badVersion)});
  assert.ok(versionPreview.errors.some((error) => error.code === 'SCHEMA_VERSION_UNSUPPORTED'));

  const badProtocol = structuredClone(base);
  badProtocol.protocol = 'livememory-analysis-v2';
  const protocolPreview = validateAnalysisImport({db, text: JSON.stringify(badProtocol)});
  assert.ok(protocolPreview.errors.some((error) => error.code === 'PROTOCOL_MISMATCH'));

  assert.equal(listResults(db, listJobs(db)[0]?.id ?? 'missing').length, 0);
  closeDatabase(db);
  temp.cleanup();
});

test('session, task, batch, job, broadcaster and viewer identity mismatches are blocked', async () => {
  const {temp, db, packageData} = await jobFixture();
  const base = payloadFor(packageData);

  const wrongSession = {...base, job_id: undefined, session_id: 'ses_does_not_exist'};
  delete wrongSession.job_id;
  delete wrongSession.batch_id;
  assert.ok(validateAnalysisImport({db, text: JSON.stringify(wrongSession)}).errors
    .some((error) => error.code === 'SESSION_NOT_FOUND'));

  const sessionMismatch = {...base, session_id: 'ses_other_but_has_job'};
  assert.ok(validateAnalysisImport({db, text: JSON.stringify(sessionMismatch)}).errors
    .some((error) => error.code === 'SESSION_MISMATCH'));

  const wrongJob = {...base, job_id: 'aij_missing'};
  assert.ok(validateAnalysisImport({db, text: JSON.stringify(wrongJob)}).errors
    .some((error) => error.code === 'JOB_NOT_FOUND'));

  const wrongTask = {...base, task_id: `${base.session_id}-analysis-b99`};
  assert.ok(validateAnalysisImport({db, text: JSON.stringify(wrongTask)}).errors
    .some((error) => error.code === 'TASK_MISMATCH'));

  const wrongBatch = {...base, batch_id: 'batch_fake'};
  assert.ok(validateAnalysisImport({db, text: JSON.stringify(wrongBatch)}).errors
    .some((error) => error.code === 'BATCH_MISMATCH'));

  const wrongBroadcaster = {...base, broadcaster_id: 'youtube:UC_SOMEONE_ELSE'};
  assert.ok(validateAnalysisImport({db, text: JSON.stringify(wrongBroadcaster)}).errors
    .some((error) => error.code === 'BROADCASTER_MISMATCH'));

  const wrongViewer = structuredClone(base);
  wrongViewer.viewer_profiles[0].viewer_id = 'youtube:UC_UNKNOWN_VIEWER';
  assert.ok(validateAnalysisImport({db, text: JSON.stringify(wrongViewer)}).errors
    .some((error) => error.code === 'VIEWER_UNKNOWN'));

  const duplicateViewer = structuredClone(base);
  duplicateViewer.viewer_profiles.push({...duplicateViewer.viewer_profiles[0]});
  assert.ok(validateAnalysisImport({db, text: JSON.stringify(duplicateViewer)}).errors
    .some((error) => error.code === 'VIEWER_DUPLICATE'));

  closeDatabase(db);
  temp.cleanup();
});

test('unknown message references and times outside the broadcast are rejected', async () => {
  const {temp, db, packageData} = await jobFixture();
  const base = payloadFor(packageData);

  const badRef = structuredClone(base);
  badRef.session_topics.topics[0].message_refs = [9999];
  const refPreview = validateAnalysisImport({db, text: JSON.stringify(badRef)});
  assert.ok(refPreview.errors.some((error) => error.code === 'MESSAGE_REF_UNKNOWN'
    && error.path === 'session_topics.topics[0].message_refs[0]'));

  const early = structuredClone(base);
  early.session_topics.topics[0].started_at = '2020-01-01T00:00:00.000Z';
  const earlyPreview = validateAnalysisImport({db, text: JSON.stringify(early)});
  assert.ok(earlyPreview.errors.some((error) => error.code === 'TIME_OUT_OF_RANGE'));

  const reversed = structuredClone(base);
  reversed.session_topics.highlights[0].ended_at = '2020-01-01T00:00:00.000Z';
  assert.ok(validateAnalysisImport({db, text: JSON.stringify(reversed)}).errors
    .some((error) => error.code === 'TIME_ORDER' || error.code === 'TIME_OUT_OF_RANGE'));

  const badTime = structuredClone(base);
  badTime.session_topics.sentiment[0].at = 'yesterday evening';
  assert.ok(validateAnalysisImport({db, text: JSON.stringify(badTime)}).errors
    .some((error) => error.code === 'SCHEMA_DATETIME' || error.code === 'TIME_INVALID'));

  closeDatabase(db);
  temp.cleanup();
});

test('importing the same answer twice is a duplicate; a different answer needs an explicit new version', async () => {
  const {temp, db, session, packageData} = await jobFixture();
  const first = payloadFor(packageData);
  const firstImport = importAnalysisResult({db, text: JSON.stringify(first), now: T0 + 700_000});
  assert.equal(firstImport.result.resultVersion, 1);

  const duplicate = importAnalysisResult({db, text: JSON.stringify(first), now: T0 + 800_000});
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.result.resultVersion, 1);
  assert.equal(listResults(db, firstImport.job.id).length, 1);

  const second = structuredClone(first);
  second.session_topics.summary = 'A genuinely different answer.';
  const preview = validateAnalysisImport({db, text: JSON.stringify(second), now: T0 + 900_000});
  assert.equal(preview.action, 'confirm_version');
  assert.equal(preview.target.latestVersion, 1);

  assert.throws(
    () => importAnalysisResult({db, text: JSON.stringify(second), now: T0 + 900_000}),
    (error) => error.code === 'AI_VERSION_REQUIRED'
  );
  assert.equal(listResults(db, firstImport.job.id).length, 1, 'failed confirmation writes nothing');

  const versionTwo = importAnalysisResult({
    db,
    text: JSON.stringify(second),
    createVersion: true,
    now: T0 + 950_000
  });
  assert.equal(versionTwo.result.resultVersion, 2);
  assert.equal(listResults(db, firstImport.job.id).length, 2);
  const report = buildSessionAnalysisReport(db, session.id);
  assert.equal(report.result.resultVersion, 2, 'report uses the latest version');
  assert.equal(report.report.summary, 'A genuinely different answer.');
  closeDatabase(db);
  temp.cleanup();
});

test('a database failure during import rolls back results, evidence and status', async () => {
  const {temp, db, session, packageData} = await jobFixture();
  const payload = payloadFor(packageData);
  const job = listJobs(db)[0];
  db.exec(`
    CREATE TRIGGER fail_ai_results BEFORE INSERT ON ai_results
    BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END;
  `);
  assert.throws(() => importAnalysisResult({db, text: JSON.stringify(payload), now: T0 + 700_000}));
  assert.equal(listResults(db, job.id).length, 0);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM ai_result_evidence').get().c), 0);
  assert.equal(getSession(db, session.id).ai_status, 'exported');
  db.exec('DROP TRIGGER fail_ai_results');
  const imported = importAnalysisResult({db, text: JSON.stringify(payload), now: T0 + 710_000});
  assert.equal(imported.duplicate, false);
  assert.equal(imported.result.resultVersion, 1);
  closeDatabase(db);
  temp.cleanup();
});

test('archived sessions can still be imported; deleting a session invalidates its answers and reports', async () => {
  const archivedFixture = await jobFixture({sessionOptions: {archived: true}});
  const archivedPayload = payloadFor(archivedFixture.packageData);
  const preview = validateAnalysisImport({
    db: archivedFixture.db,
    text: JSON.stringify(archivedPayload),
    now: T0 + 700_000
  });
  assert.equal(preview.ok, true);
  assert.equal(preview.target.session.archived, true);
  const imported = importAnalysisResult({
    db: archivedFixture.db,
    text: JSON.stringify(archivedPayload),
    now: T0 + 700_000
  });
  assert.equal(imported.status.status, 'complete');
  closeDatabase(archivedFixture.db);
  archivedFixture.temp.cleanup();

  const {temp, db, session, packageData, job} = await jobFixture();
  const payload = payloadFor(packageData);
  importAnalysisResult({db, text: JSON.stringify(payload), now: T0 + 700_000});
  const deps = {
    db,
    sessionManager: {getRecording: () => null},
    paths: {exports: join(temp.dir, 'exports')}
  };
  await deleteSessionRecord({deps, sessionId: session.id, confirm: true, now: T0 + 800_000});
  assert.equal(listJobs(db).length, 0);
  assert.equal(listResults(db, job.job.id).length, 0);
  assert.equal(buildSessionAnalysisReport(db, session.id), null);
  const late = validateAnalysisImport({db, text: JSON.stringify(payload), now: T0 + 900_000});
  assert.equal(late.ok, false);
  assert.ok(late.errors.some((error) => error.code === 'SESSION_NOT_FOUND'));
  closeDatabase(db);
  temp.cleanup();
});

test('purged chat text is imported with a warning and the report marks the original unavailable', async () => {
  const {temp, db, session, packageData} = await jobFixture();
  const payload = payloadFor(packageData);
  purgeSessionContent(db, session.id, {now: T0 + 650_000});
  const preview = validateAnalysisImport({db, text: JSON.stringify(payload), now: T0 + 700_000});
  assert.equal(preview.ok, true);
  assert.ok(preview.warnings.some((warning) => warning.code === 'EVIDENCE_PURGED'));
  importAnalysisResult({db, text: JSON.stringify(payload), now: T0 + 700_000});
  const report = buildSessionAnalysisReport(db, session.id);
  const ref = report.report.topics[0].refs[0];
  assert.equal(ref.available, true);
  assert.equal(ref.contentAvailable, false);
  assert.equal(ref.purged, true);
  assert.equal(report.evidence.missing, 0, 'row still exists; only text is gone');
  closeDatabase(db);
  temp.cleanup();
});

test('a viewer from another broadcaster is never accepted, even when the nickname matches', async () => {
  const {temp, db, packageData} = await jobFixture();
  addBroadcaster(db, {id: 'youtube:UC_OTHER_CHANNEL', name: 'Other Channel'});
  const otherSession = seedSession(db, {
    platform: 'youtube',
    roomId: 'other-room',
    title: 'Other broadcaster',
    broadcasterId: 'youtube:UC_OTHER_CHANNEL',
    broadcasterName: 'Other Channel',
    messageCount: 3,
    viewerCount: 1,
    viewerUidPrefix: 'UC_OTHER_VIEWER',
    startedAt: T0 + 10_000
  });
  const otherViewer = db.prepare(`
    SELECT viewer_id FROM viewer_sessions WHERE session_id = ? LIMIT 1
  `).get(otherSession.id).viewer_id;
  const payload = payloadFor(packageData);
  payload.viewer_profiles[0].viewer_id = otherViewer;
  // Viewer 0 of this fixture is UC_VIEWER_0; the other session's identity is
  // different even if it were displayed with the same nickname.
  const preview = validateAnalysisImport({db, text: JSON.stringify(payload)});
  assert.equal(preview.ok, false);
  assert.ok(preview.errors.some((error) => error.code === 'VIEWER_UNKNOWN'));
  closeDatabase(db);
  temp.cleanup();
});

test('a pre-M6 whole-session package answer is still importable and tracked', async () => {
  const temp = createTempDir();
  const db = openMemoryDb();
  addBroadcaster(db);
  const session = seedSession(db, {messageCount: 6});
  const exportsDir = join(temp.dir, 'exports');
  const legacyPackage = await buildAnalysisPackage({
    db,
    sessionId: session.id,
    locale: 'en',
    exportsDir,
    now: T0 + 100_000
  });
  const {readZipEntry} = await import('../../src/shared/zip.mjs');
  const buffer = await import('node:fs/promises').then((fs) => fs.readFile(legacyPackage.absolutePath));
  const manifest = JSON.parse(readZipEntry(buffer, 'manifest.json').toString('utf8'));
  const messages = readZipEntry(buffer, 'messages.jsonl').toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const result = makeBatchResult(
    {...manifest, batch: {batch_id: null}},
    messages,
    [],
    {job_id: undefined, batch_id: undefined, schema_version: undefined, task_id: `${session.id}-topics`, viewer_profiles: []}
  );
  delete result.job_id;
  delete result.batch_id;
  delete result.schema_version;
  const preview = validateAnalysisImport({db, text: JSON.stringify(result), now: T0 + 200_000});
  assert.equal(preview.ok, true);
  assert.equal(preview.target.legacy, true);
  assert.ok(preview.warnings.some((warning) => warning.code === 'LEGACY_PACKAGE'));
  const imported = importAnalysisResult({db, text: JSON.stringify(result), now: T0 + 200_000});
  assert.equal(imported.status.status, 'complete');
  assert.equal(imported.job.legacy, true);
  assert.equal(imported.result.taskId, `${session.id}-topics`);
  const duplicate = importAnalysisResult({db, text: JSON.stringify(result), now: T0 + 300_000});
  assert.equal(duplicate.duplicate, true);
  const report = buildSessionAnalysisReport(db, session.id);
  assert.equal(report.mode, 'single');
  assert.equal(report.report.topics.length, 1);
  closeDatabase(db);
  temp.cleanup();
});

test('hostile HTML and control characters stay plain text in the stored result', async () => {
  const {temp, db, session, packageData} = await jobFixture();
  const payload = payloadFor(packageData);
  payload.session_topics.summary = '<img src=x onerror="window.pwn=1">\u0000\u0001 visible';
  payload.session_topics.topics[0].title = '<script>alert(1)</script>';
  const imported = importAnalysisResult({db, text: JSON.stringify(payload), now: T0 + 700_000});
  const stored = JSON.parse(db.prepare('SELECT result_json FROM ai_results WHERE id = ?').get(imported.result.id).result_json);
  assert.equal(stored.session_topics.topics[0].title, '<script>alert(1)</script>');
  assert.ok(!stored.session_topics.summary.includes('\u0000'));
  assert.match(stored.session_topics.summary, /<img src=x/);
  const report = buildSessionAnalysisReport(db, session.id);
  assert.match(report.report.summary, /<img src=x/);
  closeDatabase(db);
  temp.cleanup();
});

test('oversized input is rejected before parsing and a large valid answer still validates', async () => {
  const {temp, db, packageData} = await jobFixture();
  const tooLarge = JSON.stringify(payloadFor(packageData)) + 'x'.repeat(8 * 1024 * 1024);
  const oversized = validateAnalysisImport({db, text: tooLarge});
  assert.equal(oversized.ok, false);
  assert.equal(oversized.errors[0].code, 'TOO_LARGE');

  const payload = payloadFor(packageData);
  payload.session_topics.topics = [];
  for (let index = 0; index < 60; index += 1) {
    payload.session_topics.topics.push({
      title: `Topic ${index}`,
      started_at: packageData.messages[0].at,
      ended_at: packageData.messages[packageData.messages.length - 1].at,
      summary: `Summary ${index}`.padEnd(2000, 'x'),
      key_points: Array.from({length: 12}, (_, point) => `Point ${point} `.padEnd(400, 'y')),
      confidence: 0.5,
      evidence: 'inferred',
      message_refs: Array.from({length: 200}, (_, ref) => (ref % 25) + 1)
    });
  }
  const started = Date.now();
  const large = validateAnalysisImport({db, text: JSON.stringify(payload)});
  const elapsed = Date.now() - started;
  assert.equal(large.ok, true, JSON.stringify(large.errors.slice(0, 3)));
  assert.ok(elapsed < 5000, `large validation took ${elapsed}ms`);
  closeDatabase(db);
  temp.cleanup();
});

test('clearing all data removes AI jobs, batches, results and evidence', async () => {
  const {temp, db, session, packageData} = await jobFixture();
  importAnalysisResult({db, text: JSON.stringify(payloadFor(packageData)), now: T0 + 700_000});
  assert.ok(Number(db.prepare('SELECT COUNT(*) AS c FROM ai_jobs').get().c) >= 1);
  assert.ok(Number(db.prepare('SELECT COUNT(*) AS c FROM ai_results').get().c) >= 1);
  maintenance.clearDatabase(db);
  for (const table of ['ai_jobs', 'ai_job_batches', 'ai_job_messages', 'ai_job_viewers', 'ai_results', 'ai_result_evidence', 'ai_packages']) {
    assert.equal(Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c), 0, `${table} must be empty`);
  }
  closeDatabase(db);
  temp.cleanup();
});
