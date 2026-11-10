import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {startServer} from '../../src/server/index.mjs';
import {addBroadcaster, seedSession, makeBatchResult, makeAggregateResult, readBatchPackage, readAggregatePackage} from '../helpers/ai-fixtures.mjs';
import {readZipEntry} from '../../src/shared/zip.mjs';

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

test('HTTP AI jobs, batch packages, prompts, preview, import, versions, aggregate and report', async (t) => {
  const temp = createTempDir();
  const server = await startServer({dataDir: temp.dir, port: 0, systemLocale: 'en'});
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  const base = server.url;
  addBroadcaster(server.db);
  const session = seedSession(server.db, {messageCount: 1200});

  await t.test('status reports import support and the current schema', async () => {
    const {payload} = await jsonRequest(`${base}api/status`);
    assert.equal(payload.ai.import, true);
    assert.equal(payload.ai.schemaVersion, '1.2.0');
    assert.equal(payload.database.schemaVersion, 12);
  });

  let job;
  let packages = [];
  let finalResult = null;
  await t.test('creating a job exports every batch and exposes it for download', async () => {
    const created = await jsonRequest(`${base}api/ai/jobs`, {
      method: 'POST',
      body: {sessionId: session.id, locale: 'en', batchSize: 500}
    });
    assert.equal(created.status, 201);
    job = created.payload.job;
    packages = created.payload.packages;
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

    const download = await fetch(`${base}api/ai/packages/${encodeURIComponent(packages[0].id)}/download`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-type'), /application\/zip/);
    const buffer = Buffer.from(await download.arrayBuffer());
    assert.equal(buffer.subarray(0, 2).toString('ascii'), 'PK');
    const manifest = JSON.parse(readZipEntry(buffer, 'manifest.json').toString('utf8'));
    assert.equal(manifest.job_id, job.id);
    assert.equal(manifest.batch.index, 1);

    const instructions = await jsonRequest(`${base}api/ai/instructions?jobId=${encodeURIComponent(job.id)}&batchIndex=1`);
    assert.equal(instructions.payload.promptVersion, 'lm-prompt-m6.2-en');
    assert.match(instructions.payload.text, /Batch analysis/);
    assert.match(instructions.payload.text, /schema_version/);
  });

  const exportsDir = join(server.paths.exports);
  const packageData = readBatchPackage(exportsDir, packages[0]);
  const batchOne = makeBatchResult(packageData.manifest, packageData.messages, packageData.viewers);
  const batchTwoData = readBatchPackage(exportsDir, packages[1]);
  const batchTwo = makeBatchResult(batchTwoData.manifest, batchTwoData.messages, batchTwoData.viewers);
  const batchThreeData = readBatchPackage(exportsDir, packages[2]);
  const batchThree = makeBatchResult(batchThreeData.manifest, batchThreeData.messages, batchThreeData.viewers);

  await t.test('preview validates without writing and the import writes exactly one result', async () => {
    const before = Number(server.db.prepare('SELECT COUNT(*) AS c FROM ai_results').get().c);
    const preview = await jsonRequest(`${base}api/ai/import/preview`, {
      method: 'POST',
      body: {json: JSON.stringify(batchOne), source: 'paste'}
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.payload.ok, true);
    assert.equal(preview.payload.action, 'import');
    assert.equal(preview.payload.target.session.id, session.id);
    assert.equal(preview.payload.target.batch.batchIndex, 1);
    assert.equal(preview.payload.target.schemaVersion, '1.1.0');
    assert.equal(Number(server.db.prepare('SELECT COUNT(*) AS c FROM ai_results').get().c), before);

    const imported = await jsonRequest(`${base}api/ai/import`, {
      method: 'POST',
      body: {json: JSON.stringify(batchOne), source: 'paste'}
    });
    assert.equal(imported.status, 201);
    assert.equal(imported.payload.duplicate, false);
    assert.equal(imported.payload.result.resultVersion, 1);
    assert.equal(imported.payload.job.status.state, 'partial');
    assert.equal(imported.payload.report.mode, 'partial');
    assert.equal(imported.payload.report.perBatch.length, 1);

    const duplicate = await jsonRequest(`${base}api/ai/import`, {
      method: 'POST',
      body: {json: JSON.stringify(batchOne), source: 'file'}
    });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.payload.duplicate, true);

    const changed = structuredClone(batchOne);
    changed.session_topics.summary = 'Changed summary for version two.';
    const versionPreview = await jsonRequest(`${base}api/ai/import/preview`, {
      method: 'POST',
      body: {json: JSON.stringify(changed)}
    });
    assert.equal(versionPreview.payload.action, 'confirm_version');
    assert.equal(versionPreview.payload.target.latestVersion, 1);

    const refused = await jsonRequest(`${base}api/ai/import`, {
      method: 'POST',
      body: {json: JSON.stringify(changed)}
    });
    assert.equal(refused.status, 409);
    assert.equal(refused.payload.error.code, 'AI_VERSION_REQUIRED');

    const accepted = await jsonRequest(`${base}api/ai/import`, {
      method: 'POST',
      body: {json: JSON.stringify(changed), createVersion: true}
    });
    assert.equal(accepted.status, 201);
    assert.equal(accepted.payload.result.resultVersion, 2);
  });

  await t.test('validation errors travel as structured field/reason/fix data', async () => {
    const broken = structuredClone(batchOne);
    delete broken.session_topics.summary;
    broken.session_topics.topics[0].confidence = 5;
    const result = await jsonRequest(`${base}api/ai/import/preview`, {
      method: 'POST',
      body: {json: JSON.stringify(broken)}
    });
    assert.equal(result.status, 200);
    assert.equal(result.payload.ok, false);
    assert.ok(result.payload.errors.length >= 2);
    for (const error of result.payload.errors) {
      assert.equal(typeof error.path, 'string');
      assert.equal(typeof error.code, 'string');
      assert.equal(typeof error.fixGroup, 'string');
    }
    const missing = result.payload.errors.find((error) => error.code === 'SCHEMA_REQUIRED');
    assert.equal(missing.path, 'session_topics.summary');
    assert.equal(missing.fixGroup, 'missing');
  });

  await t.test('the aggregate package and its final result complete the task', async () => {
    for (const payload of [batchTwo, batchThree]) {
      const imported = await jsonRequest(`${base}api/ai/import`, {
        method: 'POST',
        body: {json: JSON.stringify(payload)}
      });
      assert.equal(imported.status, 201);
    }
    const waiting = await jsonRequest(`${base}api/ai/sessions/${encodeURIComponent(session.id)}/report`);
    assert.equal(waiting.payload.mode, 'partial');
    assert.equal(waiting.payload.incompleteReason, 'awaiting_aggregate');

    const aggregate = await jsonRequest(`${base}api/ai/jobs/${encodeURIComponent(job.id)}/aggregate`, {
      method: 'POST',
      body: {}
    });
    assert.equal(aggregate.status, 201);
    assert.equal(aggregate.payload.package.stage, 'aggregate');
    const aggregateData = readAggregatePackage(exportsDir, aggregate.payload.package);
    const final = makeAggregateResult(aggregateData.manifest, aggregateData.batchResults);
    finalResult = final;

    const finalPreview = await jsonRequest(`${base}api/ai/import/preview`, {
      method: 'POST',
      body: {json: JSON.stringify(final)}
    });
    assert.equal(finalPreview.payload.ok, true);
    assert.equal(finalPreview.payload.target.mode, 'aggregate');

    const finalImport = await jsonRequest(`${base}api/ai/import`, {
      method: 'POST',
      body: {json: JSON.stringify(final)}
    });
    assert.equal(finalImport.status, 201);
    assert.equal(finalImport.payload.job.status.state, 'complete');
    assert.equal(finalImport.payload.report.mode, 'final');
    assert.equal(finalImport.payload.report.complete, true);

    const report = await jsonRequest(`${base}api/ai/sessions/${encodeURIComponent(session.id)}/report`);
    assert.equal(report.payload.complete, true);
    assert.equal(report.payload.report.summary, 'Synthetic session-wide aggregate.');
    assert.equal(report.payload.report.topics.length, 1);

    const resultDownload = await fetch(`${base}api/ai/results/${encodeURIComponent(finalImport.payload.result.id)}/download`);
    assert.equal(resultDownload.status, 200);
    assert.match(resultDownload.headers.get('content-type'), /application\/json/);
    const downloaded = await resultDownload.json();
    assert.equal(downloaded.protocol, 'livememory-analysis-result-v1');
  });

  await t.test('request limits and clean import failures stay structured', async () => {
    const wrongField = await jsonRequest(`${base}api/ai/import/preview`, {
      method: 'POST',
      body: {json: 42}
    });
    assert.equal(wrongField.status, 400);

    const tooLarge = await jsonRequest(`${base}api/ai/import/preview`, {
      method: 'POST',
      body: {json: 'x'.repeat(9 * 1024 * 1024)}
    });
    assert.equal(tooLarge.status, 413);

    const deleted = await jsonRequest(`${base}api/sessions/${encodeURIComponent(session.id)}`, {
      method: 'DELETE',
      body: {confirm: true}
    });
    assert.equal(deleted.status, 200);
    const missingReport = await jsonRequest(`${base}api/ai/sessions/${encodeURIComponent(session.id)}/report`);
    assert.equal(missingReport.status, 404);
    const lateImport = await jsonRequest(`${base}api/ai/import`, {
      method: 'POST',
      body: {json: JSON.stringify(finalResult ?? batchOne)}
    });
    assert.equal(lateImport.status, 422);
    assert.equal(lateImport.payload.error.code, 'AI_IMPORT_INVALID');
    assert.ok(lateImport.payload.error.details.errors.some((error) => error.code === 'SESSION_NOT_FOUND'));
  });
});
