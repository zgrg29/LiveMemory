import test from 'node:test';
import assert from 'node:assert/strict';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {startServer} from '../../src/server/index.mjs';
import {addBroadcaster, seedSession} from '../helpers/ai-fixtures.mjs';
import {importSessionAnalysis} from '../helpers/memory-fixtures.mjs';
import {inspectMemoryPackage} from '../../src/memory/export.mjs';
import {join} from 'node:path';

async function jsonRequest(url, {method = 'GET', body} = {}) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? {} : {'content-type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  return {status: response.status, payload};
}

test('HTTP long-term memory workflow', async (t) => {
  const temp = createTempDir();
  const server = await startServer({dataDir: temp.dir, port: 0, systemLocale: 'en'});
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  const base = server.url;
  const db = server.db;
  addBroadcaster(db);
  const session = seedSession(db, {messageCount: 16, viewerCount: 2});
  const broadcasterId = 'youtube:UC_AI_TEST';
  const viewerId = 'youtube:UC_VIEWER_0';

  await t.test('status and overview expose the memory capability', async () => {
    const status = await jsonRequest(`${base}api/status`);
    assert.equal(status.payload.memory.enabled, true);
    assert.equal(status.payload.memory.protocol, 'livememory-memory-update-v1');
    assert.equal(status.payload.memory.schemaVersion, '1.0.0');
    assert.equal(status.payload.database.schemaVersion, 11);

    const overview = await jsonRequest(`${base}api/memory/overview?broadcasterId=${encodeURIComponent(broadcasterId)}`);
    assert.equal(overview.status, 200);
    assert.equal(overview.payload.overview.memories, 0);
    assert.equal(overview.payload.sessions.length, 1);
    assert.equal(overview.payload.sessions[0].analysis, null);
    assert.equal(overview.payload.retention.keepUntilDeleted, true);
  });

  await t.test('the deterministic merge needs an imported analysis first', async () => {
    const blocked = await jsonRequest(`${base}api/memory/merge`, {
      method: 'POST',
      body: {sessionId: session.id}
    });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.payload.error.messageKey, 'errors.memoryNoAnalysis');
  });

  await t.test('preview and apply a session merge over HTTP', async () => {
    await importSessionAnalysis({
      db,
      sessionId: session.id,
      exportsDir: server.paths.exports,
      profiles: [{
        viewer_id: viewerId,
        interests: [{topic: 'platformers', strength: 'stable', evidence: 'observed', note: 'Loves platformers.'}],
        dislikes: [],
        summary: 'A platformer fan.',
        confidence: 0.6
      }]
    });

    const preview = await jsonRequest(`${base}api/memory/merge`, {
      method: 'POST',
      body: {sessionId: session.id}
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.payload.apply, false);
    assert.equal(preview.payload.totals.added, 1);

    const applied = await jsonRequest(`${base}api/memory/merge`, {
      method: 'POST',
      body: {sessionId: session.id, apply: true}
    });
    assert.equal(applied.status, 200);
    assert.equal(applied.payload.apply, true);
    assert.equal(applied.payload.totals.added, 1);

    const view = await jsonRequest(`${base}api/memory/viewers/${encodeURIComponent(viewerId)}?broadcasterId=${encodeURIComponent(broadcasterId)}`);
    assert.equal(view.status, 200);
    assert.equal(view.payload.memory.version, 1);
    assert.equal(view.payload.facts.length, 1);
    assert.equal(view.payload.facts[0].certainty, 'inferred');
    assert.equal(view.payload.groups.inferred.length, 1);
    assert.equal(view.payload.versions.length, 1);
  });

  await t.test('a human can confirm a fact, creating a new version', async () => {
    const view = await jsonRequest(`${base}api/memory/viewers/${encodeURIComponent(viewerId)}?broadcasterId=${encodeURIComponent(broadcasterId)}`);
    const factId = view.payload.facts[0].id;
    const reviewed = await jsonRequest(
      `${base}api/memory/viewers/${encodeURIComponent(viewerId)}/facts/${encodeURIComponent(factId)}/review`,
      {method: 'POST', body: {action: 'confirm', broadcasterId}}
    );
    assert.equal(reviewed.status, 200);
    assert.equal(reviewed.payload.view.memory.version, 2);
    assert.equal(reviewed.payload.view.facts[0].certainty, 'stated');
    assert.equal(reviewed.payload.view.facts[0].userVerified, true);
    assert.equal(reviewed.payload.view.groups.confirmed.length, 1);

    const rollback = await jsonRequest(
      `${base}api/memory/viewers/${encodeURIComponent(viewerId)}/rollback`,
      {method: 'POST', body: {broadcasterId, version: 1}}
    );
    assert.equal(rollback.status, 200);
    assert.equal(rollback.payload.view.memory.version, 3);
    assert.equal(rollback.payload.view.facts[0].certainty, 'inferred');
    assert.equal(rollback.payload.view.versions.length, 3);
  });

  let job;
  let pkg;
  await t.test('a memory update job exports downloadable packages and a prompt', async () => {
    const created = await jsonRequest(`${base}api/memory/jobs`, {
      method: 'POST',
      body: {sessionId: session.id, locale: 'en', viewersPerBatch: 1}
    });
    assert.equal(created.status, 201);
    job = created.payload.job;
    assert.equal(job.batchTotal, 2);
    assert.equal(created.payload.batches.length, 2);
    assert.ok(created.payload.batches.every((batch) => batch.fileName));

    const download = await fetch(`${base}api/memory/jobs/${encodeURIComponent(job.id)}/batches/1/download`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'application/zip');
    const buffer = Buffer.from(await download.arrayBuffer());
    assert.ok(buffer.length > 100);

    const instructions = await jsonRequest(
      `${base}api/memory/jobs/${encodeURIComponent(job.id)}/instructions?batchIndex=1`
    );
    assert.equal(instructions.status, 200);
    assert.match(instructions.payload.text, /livememory-memory-update-v1/);
    assert.equal(instructions.payload.promptVersionLabel, 'lm-prompt-m7.1-en');
    assert.equal(instructions.payload.batch.index, 1);

    pkg = await inspectMemoryPackage(join(server.paths.exports, created.payload.batches[0].fileName));
  });

  await t.test('a memory answer can be previewed and imported over HTTP', async () => {
    const targetViewer = pkg.context.viewers[0].viewer_id;
    const seq = pkg.excerpts.find((entry) => entry.viewer_id === targetViewer).seq;
    const text = JSON.stringify({
      protocol: 'livememory-memory-update-v1',
      schema_version: '1.0.0',
      job_id: pkg.manifest.job_id,
      batch_id: pkg.manifest.batch.batch_id,
      broadcaster_id: pkg.manifest.broadcaster_id,
      task_id: pkg.manifest.batch.task_id,
      session_id: pkg.manifest.session_id,
      locale: pkg.manifest.locale,
      viewer_operations: [{
        viewer_id: targetViewer,
        operations: [{
          op: 'add',
          kind: 'topic',
          topic: 'from AI',
          statement: 'Talked about a new topic',
          certainty: 'inferred',
          evidence: [seq]
        }]
      }]
    });

    const preview = await jsonRequest(`${base}api/memory/import/preview`, {
      method: 'POST',
      body: {json: text, source: 'paste'}
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.payload.ok, true);
    assert.equal(preview.payload.action, 'apply');
    assert.equal(preview.payload.totals.added >= 1, true);
    assert.equal(preview.payload.evidence.total, 1);

    const imported = await jsonRequest(`${base}api/memory/import`, {
      method: 'POST',
      body: {json: text, source: 'paste'}
    });
    assert.equal(imported.status, 201);
    assert.equal(imported.payload.duplicate, false);
    assert.ok(imported.payload.versions.length >= 1);

    const again = await jsonRequest(`${base}api/memory/import`, {
      method: 'POST',
      body: {json: text, source: 'paste'}
    });
    assert.equal(again.status, 200);
    assert.equal(again.payload.duplicate, true);

    const jobView = await jsonRequest(`${base}api/memory/jobs/${encodeURIComponent(job.id)}`);
    assert.equal(jobView.status, 200);
    assert.equal(jobView.payload.status.status, 'partial');
    assert.deepEqual(jobView.payload.status.missingBatches, [2]);
  });

  await t.test('invalid memory answers return structured errors', async () => {
    const bad = await jsonRequest(`${base}api/memory/import/preview`, {
      method: 'POST',
      body: {json: '{not json'}
    });
    assert.equal(bad.status, 200);
    assert.equal(bad.payload.ok, false);
    assert.ok(bad.payload.errors.some((error) => error.code === 'INVALID_JSON'));

    const rejected = await jsonRequest(`${base}api/memory/import`, {
      method: 'POST',
      body: {json: '{not json'}
    });
    assert.equal(rejected.status, 422);
    assert.equal(rejected.payload.error.messageKey, 'errors.memoryImportInvalid');
  });

  await t.test('pruning is a dry run unless confirmed and deletion is explicit', async () => {
    const prunePreview = await jsonRequest(`${base}api/memory/prune`, {
      method: 'POST',
      body: {broadcasterId, olderThanDays: 30}
    });
    assert.equal(prunePreview.status, 200);
    assert.equal(prunePreview.payload.dryRun, true);

    const unconfirmed = await jsonRequest(
      `${base}api/memory/viewers/${encodeURIComponent(viewerId)}/delete`,
      {method: 'POST', body: {broadcasterId}}
    );
    assert.equal(unconfirmed.status, 400);

    const removed = await jsonRequest(
      `${base}api/memory/viewers/${encodeURIComponent(viewerId)}/delete`,
      {method: 'POST', body: {broadcasterId, confirm: true}}
    );
    assert.equal(removed.status, 200);
    assert.equal(removed.payload.deleted, true);

    const after = await jsonRequest(`${base}api/memory/viewers/${encodeURIComponent(viewerId)}?broadcasterId=${encodeURIComponent(broadcasterId)}`);
    assert.equal(after.payload.memory.status, 'deleted');
    assert.equal(after.payload.facts.length, 0);
    assert.equal(after.payload.versions.length, 0);
  });
});
