import test from 'node:test';
import assert from 'node:assert/strict';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {startServer} from '../../src/server/index.mjs';
import {addBroadcaster, seedSession, T0} from '../helpers/ai-fixtures.mjs';
import {createSessionAnalysisJob} from '../../src/ai/export/split-jobs.mjs';
import {validateAnalysisImport} from '../../src/ai/import/validate.mjs';
import {importAnalysisResult} from '../../src/ai/import/importer.mjs';

async function jsonRequest(url, {method = 'GET', body} = {}) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? {} : {'content-type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { /* plain */ }
  return {status: response.status, payload};
}

test('v0.13 session-only job imports without memory and reports complete', async (t) => {
  const temp = createTempDir();
  const server = await startServer({auth: false,dataDir: temp.dir, port: 0, systemLocale: 'en'});
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {id: 'ses_v13_session', messageCount: 5, viewerCount: 2, startedAt: T0});
  const base = server.url;

  const created = await createSessionAnalysisJob({
    db: server.db,
    sessionId: session.id,
    locale: 'en',
    exportsDir: server.paths.exports
  });
  assert.ok(created, 'session job should be created');
  assert.equal(created.job.analysisMode, 'session');
  assert.equal(created.job.batchTotal, 1);
  assert.equal(created.package.stage, 'session');

  const manifest = {
    job_id: created.job.id,
    batch_id: `${created.job.id}-b01`,
    task_id: `${session.id}-analysis`,
    session_id: session.id,
    locale: 'en'
  };
  const result = {
    protocol: 'livememory-analysis-result-v1',
    schema_version: '1.3.0',
    analysis_scope: 'session',
    ...manifest,
    session_topics: {
      summary: 'A synthetic session summary.',
      topics: [],
      sentiment: [],
      disputes: [],
      highlights: []
    }
  };
  const preview = validateAnalysisImport({
    db: server.db,
    text: JSON.stringify(result),
    source: 'paste'
  });
  assert.equal(preview.ok, true, JSON.stringify(preview.errors));
  assert.equal(preview.memory, null);

  const forbidden = validateAnalysisImport({
    db: server.db,
    text: JSON.stringify({
      ...result,
      viewer_memory_updates: [{viewer_id: 'youtube:UC_VIEWER_0', no_new_information: true, operations: []}]
    }),
    source: 'paste'
  });
  assert.equal(forbidden.ok, false);
  assert.ok(forbidden.errors.some((error) => error.code === 'SESSION_MEMORY_FORBIDDEN'));

  const imported = importAnalysisResult({
    db: server.db,
    text: JSON.stringify(result),
    source: 'api'
  });
  assert.equal(imported.status.status, 'complete');
  assert.equal(imported.result.analysisMode, 'session');
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM viewer_memories').get().n, 0);
});

test('v0.13 provider catalogue is public and configuration rejects unsafe base URLs', async (t) => {
  const temp = createTempDir();
  const server = await startServer({auth: false,dataDir: temp.dir, port: 0, systemLocale: 'en'});
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  const base = server.url;
  const providers = await jsonRequest(`${base}api/ai/providers`);
  assert.equal(providers.status, 200);
  assert.ok(providers.payload.providers.some((entry) => entry.id === 'openrouter'));
  assert.equal(providers.payload.providers.find((entry) => entry.id === 'minimax').regions.length, 2);

  const bad = await jsonRequest(`${base}api/ai/providers/configs`, {
    method: 'POST',
    body: {
      providerId: 'custom',
      regionId: 'custom',
      baseUrl: 'http://169.254.169.254/latest',
      modelId: 'x',
      pricingStatus: 'unknown'
    }
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.payload.error.code, 'AI_PROVIDER_PRIVATE_URL');

  const keyless = await jsonRequest(`${base}api/ai/providers/configs`, {
    method: 'POST',
    body: {providerId: 'openai', regionId: 'global', modelId: 'gpt-4.1-mini', pricingStatus: 'unknown'}
  });
  assert.equal(keyless.status, 400);
  assert.equal(keyless.payload.error.code, 'AI_PROVIDER_KEY_REQUIRED');

  const saved = await jsonRequest(`${base}api/ai/providers/configs`, {
    method: 'POST',
    body: {
      providerId: 'custom',
      regionId: 'custom',
      baseUrl: 'https://example.com/v1',
      modelId: 'saved-model',
      apiKey: 'saved-key',
      pricingStatus: 'unknown'
    }
  });
  assert.equal(saved.status, 201, JSON.stringify(saved.payload));
  const withKey = await jsonRequest(`${base}api/ai/providers`);
  const listed = withKey.payload.configs.find((config) => config.id === saved.payload.config.id);
  assert.ok(listed);
  assert.equal(listed.hasCredential, true);
  assert.equal(JSON.stringify(withKey.payload).includes('saved-key'), false);
});

test('provider capability test route audits the result and updates the config', async (t) => {
  const temp = createTempDir();
  const server = await startServer({auth: false,
    dataDir: temp.dir,
    port: 0,
    systemLocale: 'en',
    auto: {
      fetchImpl: async (url, options) => {
        if (String(url).endsWith('/models')) return Response.json({data: [{id: 'mock-model'}]});
        const body = JSON.parse(options.body);
        const text = body.messages.map((message) => message.content).join('\n');
        let content = 'OK';
        if (text.includes('Synthetic livestream chat')) content = "{\"session_topics\":{\"summary\":\"summary\",\"topics\":[{\"title\":\"chat\",\"started_at\":\"2026-01-01T00:00:00Z\",\"ended_at\":\"2026-01-01T00:01:00Z\",\"summary\":\"talk\",\"key_points\":[\"point\"],\"confidence\":0.7,\"evidence\":\"observed\"}],\"sentiment\":[],\"disputes\":[],\"highlights\":[]}}";
        else if (text.includes('Synthetic LiveMemory memory test')) {
          content = JSON.stringify({viewers: [
            {ref: 1, no_new_information: false, operations: [{op: 'add', kind: 'interest', topic: 'guitar', statement: 'learning guitar', certainty: 'stated', evidence: [1]}]},
            {ref: 2, no_new_information: false, operations: [{op: 'add', kind: 'interest', topic: 'drawing', statement: 'enjoys drawing', certainty: 'stated', evidence: [2]}]},
            {ref: 3, no_new_information: true, operations: []}
          ]});
        } else if (text.includes('"ok":true')) content = JSON.stringify({ok: true});
        return Response.json({model: body.model, choices: [{message: {content}, finish_reason: 'stop'}], usage: {prompt_tokens: 1, completion_tokens: 1}});
      }
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  const base = server.url;
  const created = await jsonRequest(`${base}api/ai/providers/configs`, {
    method: 'POST',
    body: {
      providerId: 'openai', regionId: 'global', modelId: 'mock-model',
      apiKey: 'test-key', pricingStatus: 'paid',
      pricing: {inputPerMillion: 1, outputPerMillion: 2, currency: 'USD'}
    }
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  const configId = created.payload.config.id;
  const tested = await jsonRequest(`${base}api/ai/providers/configs/${encodeURIComponent(configId)}/test`, {
    method: 'POST',
    body: {confirmBilling: true}
  });
  assert.equal(tested.status, 200, JSON.stringify(tested.payload));
  assert.equal(tested.payload.result.status, 'passed', JSON.stringify(tested.payload.result.stages));
  assert.equal(tested.payload.result.capabilities.memory, true);
  assert.equal(tested.payload.config.capabilities.memory, true);
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM ai_provider_tests').get().n, 1);
});

test('memory is gated only by the verified technical capability, never by price', async (t) => {
  const temp = createTempDir();
  const server = await startServer({auth: false,dataDir: temp.dir, port: 0, systemLocale: 'en'});
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {id: 'ses_v13_gates', messageCount: 4, viewerCount: 2, startedAt: T0});
  const base = server.url;
  const noMemory = server.providerConfigStore.create({
    providerId: 'custom', regionId: 'custom', baseUrl: 'https://example.com/v1',
    modelId: 'no-memory-model', apiKey: 'test-free-key', pricingStatus: 'api_free',
    pricing: {inputPerMillion: 0, outputPerMillion: 0, currency: 'USD'}
  });
  server.providerConfigStore.recordTest(noMemory.id, {
    status: 'passed',
    capabilities: {network: true, auth: true, text: true, json: true, session: true, memory: false}
  });
  const memoryRejected = await jsonRequest(`${base}api/ai/analyze/run`, {
    method: 'POST',
    body: {sessionId: session.id, mode: 'memory', configId: noMemory.id, locale: 'en', consent: true}
  });
  const anonymousMemory = await jsonRequest(`${base}api/ai/analyze/run`, {
    method: 'POST',
    body: {sessionId: session.id, mode: 'memory', locale: 'en', consent: true}
  });
  assert.equal(anonymousMemory.status, 400);
  assert.equal(anonymousMemory.payload.error.code, 'AI_PROVIDER_CONFIG_REQUIRED');
  assert.equal(memoryRejected.status, 409);
  assert.equal(memoryRejected.payload.error.code, 'AI_MEMORY_CAPABILITY_REQUIRED');
});

