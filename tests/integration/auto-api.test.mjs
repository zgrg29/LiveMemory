import test from 'node:test';
import assert from 'node:assert/strict';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {startServer} from '../../src/server/index.mjs';
import {addBroadcaster, seedSession, T0} from '../helpers/ai-fixtures.mjs';

function makeResult(prompt, kind) {
  const manifest = prompt.manifest;
  return {
    protocol: 'livememory-analysis-result-v1',
    schema_version: '1.2.0',
    job_id: manifest.job_id,
    ...(kind === 'batch' ? {batch_id: manifest.batch.batch_id} : {}),
    broadcaster_id: manifest.broadcaster_id,
    task_id: manifest.tasks[0].task_id,
    session_id: manifest.session_id,
    locale: manifest.locale,
    session_topics: {summary: 'Synthetic HTTP result', topics: [], sentiment: [], disputes: [], highlights: []},
    viewer_profiles: [],
    viewer_memory_updates: kind === 'batch'
      ? prompt.viewerIds.map((viewer_id) => ({viewer_id, no_new_information: true, operations: []}))
      : []
  };
}

async function jsonRequest(url, {method = 'GET', body} = {}) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? {} : {'content-type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { /* plain text */ }
  return {status: response.status, payload};
}

async function waitForStatus(base, sessionId, timeoutMs = 8000) {
  const started = Date.now();
  for (;;) {
    const response = await jsonRequest(`${base}api/ai/auto/status?sessionId=${encodeURIComponent(sessionId)}`);
    if (!response.payload?.running) return response.payload;
    if (Date.now() - started > timeoutMs) throw new Error('automatic HTTP run timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('automatic analysis HTTP routes require consent, stream status and keep the manual import path', async (t) => {
  const temp = createTempDir();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let blocked = false;
  const server = await startServer({
    dataDir: temp.dir,
    port: 0,
    systemLocale: 'en',
    auto: {
      providers: [{id: 'mock', label: 'Mock provider', model: 'mock-model', rateLimit: {limit: 1000, windowMs: 1}}],
      transport: async ({prompt, kind}) => {
        if (blocked) await gate;
        return {content: JSON.stringify(makeResult(prompt, kind)), providerId: 'mock'};
      }
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const base = server.url;

  const services = await jsonRequest(`${base}api/ai/auto/services`);
  assert.equal(services.status, 200);
  assert.equal(services.payload.maxBatches, 12);
  assert.deepEqual(services.payload.services.map((entry) => entry.id), ['mock']);

  assert.equal((await jsonRequest(`${base}api/ai/auto/status`)).status, 400);

  const session = seedSession(server.db, {id: 'ses_auto_http', messageCount: 5, viewerCount: 2, startedAt: T0});
  const noConsent = await jsonRequest(`${base}api/ai/auto/run`, {
    method: 'POST',
    body: {sessionId: session.id, locale: 'en', consent: false}
  });
  assert.equal(noConsent.status, 400);
  assert.equal(noConsent.payload.error.code, 'AUTO_CONSENT_REQUIRED');

  blocked = true;
  const started = await jsonRequest(`${base}api/ai/auto/run`, {
    method: 'POST',
    body: {sessionId: session.id, locale: 'en', consent: true}
  });
  assert.equal(started.status, 202);
  assert.equal(started.payload.running, true);

  const duplicate = await jsonRequest(`${base}api/ai/auto/run`, {
    method: 'POST',
    body: {sessionId: session.id, locale: 'en', consent: true}
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.payload.error.code, 'AUTO_ALREADY_RUNNING');

  const runningStatus = await jsonRequest(`${base}api/ai/auto/status?sessionId=${encodeURIComponent(session.id)}`);
  assert.equal(runningStatus.payload.running, true);
  assert.equal(runningStatus.payload.canCancel, true);

  blocked = false;
  release();
  const final = await waitForStatus(base, session.id);
  assert.equal(final.status, 'complete');
  assert.equal(final.job.state, 'complete');
  assert.equal(final.job.memoryCoverage.complete, true);

  const report = await jsonRequest(`${base}api/ai/sessions/${session.id}/report`);
  assert.equal(report.status, 200);
  assert.equal(report.payload.result.source, 'auto');

  // Manual preview/import remains reachable after an automatic run.
  const manualPreview = await jsonRequest(`${base}api/ai/import/preview`, {
    method: 'POST',
    body: {json: '{"protocol":"livememory-analysis-result-v1"}', source: 'paste'}
  });
  assert.equal(manualPreview.status, 200);
  assert.equal(manualPreview.payload.ok, false);
});

test('automatic analysis can be canceled over HTTP', async (t) => {
  const temp = createTempDir();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const server = await startServer({
    dataDir: temp.dir,
    port: 0,
    systemLocale: 'en',
    auto: {
      providers: [{id: 'mock', label: 'Mock provider', model: 'mock-model', rateLimit: {limit: 1000, windowMs: 1}}],
      transport: async ({prompt, kind}) => {
        await gate;
        return {content: JSON.stringify(makeResult(prompt, kind)), providerId: 'mock'};
      }
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {id: 'ses_auto_cancel_http', messageCount: 3, viewerCount: 1, startedAt: T0});
  const accepted = await jsonRequest(`${server.url}api/ai/auto/run`, {
    method: 'POST',
    body: {sessionId: session.id, locale: 'en', consent: true}
  });
  assert.equal(accepted.status, 202);
  const canceled = await jsonRequest(`${server.url}api/ai/auto/cancel`, {
    method: 'POST',
    body: {sessionId: session.id}
  });
  assert.equal(canceled.status, 200);
  release();
  const final = await waitForStatus(server.url, session.id);
  assert.equal(final.status, 'canceled');
  assert.equal(final.canResume, true);
});

test('a broadcast that needs too many free batches is refused before creating a job', async (t) => {
  const temp = createTempDir();
  const server = await startServer({dataDir: temp.dir, port: 0, systemLocale: 'en'});
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {
    id: 'ses_auto_too_big',
    messageCount: 3250,
    viewerCount: 1,
    startedAt: T0
  });
  const response = await jsonRequest(`${server.url}api/ai/auto/run`, {
    method: 'POST',
    body: {sessionId: session.id, locale: 'en', consent: true}
  });
  assert.equal(response.status, 422);
  assert.equal(response.payload.error.code, 'AUTO_TOO_MANY_BATCHES');
  assert.equal(
    Number(server.db.prepare('SELECT COUNT(*) AS c FROM ai_jobs WHERE session_id = ?').get(session.id).c),
    0
  );
});
