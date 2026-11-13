import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {startServer} from '../../src/server/index.mjs';
import {addBroadcaster, seedSession, makeBatchResult, makeAggregateResult, readBatchPackage, readAggregatePackage} from '../helpers/ai-fixtures.mjs';
import {readZipEntry} from '../../src/shared/zip.mjs';
import {buildAggregatePackage, createAnalysisJob} from '../../src/ai/export/job.mjs';
import {validateAnalysisImport} from '../../src/ai/import/validate.mjs';
import {importAnalysisResult} from '../../src/ai/import/importer.mjs';

async function jsonRequest(url, {method = 'GET', body} = {}) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? {} : {'content-type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let payload = null;
  const text = await response.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  return {status: response.status, payload, response};
}

/**
 * The manual creation/prompt/import HTTP endpoints were removed in v0.13.1.
 * This test now exercises the same validation/import/report logic directly and
 * keeps coverage of the read-only HTTP endpoints that still serve the console.
 */
test('analysis jobs validate, import, aggregate and report through shared services', async (t) => {
  const temp = createTempDir();
  const server = await startServer({dataDir: temp.dir, port: 0, systemLocale: 'en'});
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  const base = server.url;
  addBroadcaster(server.db);
  const session = seedSession(server.db, {messageCount: 1200});

  await t.test('status reports automated analysis, no manual import, and the current schema', async () => {
    const {payload} = await jsonRequest(`${base}api/status`);
    assert.equal(payload.ai.automated, true);
    assert.equal(payload.ai.import, false);
    assert.equal(payload.ai.schemaVersion, '1.3.0');
    assert.equal(payload.database.schemaVersion, 15);
  });

  let job;
  let packages = [];
  await t.test('a job exports every batch and the read-only job API exposes it', async () => {
    const created = await createAnalysisJob({
      db: server.db,
      sessionId: session.id,
      locale: 'en',
      exportsDir: server.paths.exports,
      batchSize: 500
    });
    assert.ok(created);
    job = created.job;
    packages = created.packages;
    assert.equal(job.batchTotal, 3);
    assert.equal(packages.length, 3);
    assert.ok(packages.every((pkg) => pkg.stage === 'batch'));
    assert.deepEqual(packages.map((pkg) => pkg.messageCount), [500, 500, 200]);

    const list = await jsonRequest(`${base}api/ai/jobs?sessionId=${encodeURIComponent(session.id)}`);
    assert.equal(list.payload.jobs.length, 1);
    assert.equal(list.payload.jobs[0].status.state, 'awaiting_import');

    const detail = await jsonRequest(`${base}api/ai/jobs/${encodeURIComponent(job.id)}`);
    assert.equal(detail.payload.batches.length, 3);
    assert.equal(detail.payload.packages.length, 3);

    const buffer = readFileSync(join(server.paths.exports, packages[0].fileName));
    assert.equal(buffer.subarray(0, 2).toString('ascii'), 'PK');
    const manifest = JSON.parse(readZipEntry(buffer, 'manifest.json').toString('utf8'));
    assert.equal(manifest.job_id, job.id);
    assert.equal(manifest.batch.index, 1);
  });

  const exportsDir = server.paths.exports;
  const packageData = readBatchPackage(exportsDir, packages[0]);
  const batchOne = makeBatchResult(packageData.manifest, packageData.messages, packageData.viewers);
  const batchTwoData = readBatchPackage(exportsDir, packages[1]);
  const batchTwo = makeBatchResult(batchTwoData.manifest, batchTwoData.messages, batchTwoData.viewers);
  const batchThreeData = readBatchPackage(exportsDir, packages[2]);
  const batchThree = makeBatchResult(batchThreeData.manifest, batchThreeData.messages, batchThreeData.viewers);

  await t.test('validation does not write and import writes exactly one result', async () => {
    const before = Number(server.db.prepare('SELECT COUNT(*) AS c FROM ai_results').get().c);
    const preview = validateAnalysisImport({
      db: server.db,
      text: JSON.stringify(batchOne),
      source: 'paste'
    });
    assert.equal(preview.ok, true);
    assert.equal(preview.action, 'import');
    assert.equal(preview.target.session.id, session.id);
    assert.equal(preview.target.batch.batchIndex, 1);
    assert.equal(preview.target.schemaVersion, '1.1.0');
    assert.equal(Number(server.db.prepare('SELECT COUNT(*) AS c FROM ai_results').get().c), before);

    const imported = importAnalysisResult({
      db: server.db,
      text: JSON.stringify(batchOne),
      source: 'api'
    });
    assert.equal(imported.duplicate, false);
    assert.equal(imported.result.resultVersion, 1);
    assert.equal(imported.status.status, 'partial');
    const report = await jsonRequest(`${base}api/ai/sessions/${encodeURIComponent(session.id)}/report`);
    assert.equal(report.payload.mode, 'partial');
    assert.equal(report.payload.perBatch.length, 1);

    const duplicate = importAnalysisResult({
      db: server.db,
      text: JSON.stringify(batchOne),
      source: 'api'
    });
    assert.equal(duplicate.duplicate, true);

    const changed = structuredClone(batchOne);
    changed.session_topics.summary = 'Changed summary for version two.';
    const versionPreview = validateAnalysisImport({
      db: server.db,
      text: JSON.stringify(changed),
      source: 'api'
    });
    assert.equal(versionPreview.action, 'confirm_version');
    assert.equal(versionPreview.target.latestVersion, 1);

    assert.throws(
      () => importAnalysisResult({db: server.db, text: JSON.stringify(changed), source: 'api'}),
      (error) => error?.code === 'AI_VERSION_REQUIRED'
    );

    const accepted = importAnalysisResult({
      db: server.db,
      text: JSON.stringify(changed),
      source: 'api',
      createVersion: true
    });
    assert.equal(accepted.result.resultVersion, 2);
  });

  await t.test('validation errors carry field, reason and fix data', async () => {
    const broken = structuredClone(batchOne);
    delete broken.session_topics.summary;
    broken.session_topics.topics[0].confidence = 5;
    const result = validateAnalysisImport({
      db: server.db,
      text: JSON.stringify(broken),
      source: 'paste'
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.length >= 2);
    for (const error of result.errors) {
      assert.equal(typeof error.path, 'string');
      assert.equal(typeof error.code, 'string');
      assert.equal(typeof error.fixGroup, 'string');
    }
    const missing = result.errors.find((error) => error.code === 'SCHEMA_REQUIRED');
    assert.equal(missing.path, 'session_topics.summary');
    assert.equal(missing.fixGroup, 'missing');
  });

  await t.test('the aggregate package and its final result complete the task', async () => {
    for (const payload of [batchTwo, batchThree]) {
      importAnalysisResult({db: server.db, text: JSON.stringify(payload), source: 'api'});
    }
    const waiting = await jsonRequest(`${base}api/ai/sessions/${encodeURIComponent(session.id)}/report`);
    assert.equal(waiting.payload.mode, 'partial');
    assert.equal(waiting.payload.incompleteReason, 'awaiting_aggregate');

    const aggregate = await buildAggregatePackage({
      db: server.db,
      jobId: job.id,
      exportsDir,
      now: Date.now()
    });
    assert.ok(aggregate);
    const aggregateData = readAggregatePackage(exportsDir, {fileName: aggregate.fileName});
    const final = makeAggregateResult(aggregateData.manifest, aggregateData.batchResults);
    const finalPreview = validateAnalysisImport({
      db: server.db,
      text: JSON.stringify(final),
      source: 'api'
    });
    assert.equal(finalPreview.ok, true);
    assert.equal(finalPreview.target.mode, 'aggregate');

    const finalImport = importAnalysisResult({
      db: server.db,
      text: JSON.stringify(final),
      source: 'api'
    });
    assert.equal(finalImport.status.status, 'complete');
    const report = await jsonRequest(`${base}api/ai/sessions/${encodeURIComponent(session.id)}/report`);
    assert.equal(report.payload.complete, true);
    assert.equal(report.payload.report.summary, 'Synthetic session-wide aggregate.');
    assert.equal(report.payload.report.topics.length, 1);

    const resultDownload = await fetch(`${base}api/ai/results/${encodeURIComponent(finalImport.result.id)}/download`);
    assert.equal(resultDownload.status, 200);
    assert.match(resultDownload.headers.get('content-type'), /application\/json/);
    const downloaded = await resultDownload.json();
    assert.equal(downloaded.protocol, 'livememory-analysis-result-v1');
  });

  await t.test('clean import failures stay structured', async () => {
    const tooLarge = validateAnalysisImport({
      db: server.db,
      text: 'x'.repeat(9 * 1024 * 1024),
      source: 'paste'
    });
    assert.equal(tooLarge.ok, false);
    assert.ok(tooLarge.errors.some((error) => error.code === 'TOO_LARGE'));

    const deleted = await jsonRequest(`${base}api/sessions/${encodeURIComponent(session.id)}`, {
      method: 'DELETE',
      body: {confirm: true}
    });
    assert.equal(deleted.status, 200);
    const missingReport = await jsonRequest(`${base}api/ai/sessions/${encodeURIComponent(session.id)}/report`);
    assert.equal(missingReport.status, 404);
    assert.throws(
      () => importAnalysisResult({db: server.db, text: JSON.stringify(batchOne), source: 'api'}),
      (error) => error?.code === 'AI_IMPORT_INVALID'
        && error.details?.errors?.some((item) => item.code === 'SESSION_NOT_FOUND')
    );
  });
});
