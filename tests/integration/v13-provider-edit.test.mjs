import test from 'node:test';
import assert from 'node:assert/strict';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {startServer} from '../../src/server/index.mjs';
import {addBroadcaster, seedSession, T0} from '../helpers/ai-fixtures.mjs';

function sessionAnswer() {
  return JSON.stringify({
    session_topics: {
      summary: 'Edited model summary',
      topics: [],
      sentiment: [],
      disputes: [],
      highlights: []
    }
  });
}

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

async function waitForStatus(server, sessionId, expected, limit = 200) {
  for (let index = 0; index < limit; index += 1) {
    const status = server.analysisRunner.getStatus(sessionId);
    if (expected.includes(status.status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return server.analysisRunner.getStatus(sessionId);
}

test('saved provider configuration can be edited without re-entering the key', async (t) => {
  const temp = createTempDir();
  const server = await startServer({auth: false,dataDir: temp.dir, port: 0, systemLocale: 'en'});
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  const base = server.url;
  const config = server.providerConfigStore.create({
    providerId: 'dashscope',
    regionId: 'cn-beijing',
    modelId: 'qwen-old',
    name: 'Bailian',
    apiKey: 'old-secret',
    pricingStatus: 'paid',
    pricing: {inputPerMillion: 1, outputPerMillion: 2, currency: 'CNY'},
    concurrency: 3
  });
  const other = server.providerConfigStore.create({
    providerId: 'deepseek',
    regionId: 'global',
    modelId: 'deepseek-chat',
    apiKey: 'other-secret',
    pricingStatus: 'unknown'
  });
  server.providerConfigStore.recordTest(config.id, {
    status: 'passed',
    capabilities: {network: true, auth: true, text: true, json: true, session: true, memory: true},
    stages: {}
  });

  // Model-only PATCH: same id/default/reference, old key preserved, capability
  // and stale price invalidated.
  const edited = await jsonRequest(`${base}api/ai/providers/configs/${encodeURIComponent(config.id)}`, {
    method: 'PATCH',
    body: {modelId: 'qwen-new'}
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.payload));
  assert.equal(edited.payload.config.id, config.id);
  assert.equal(edited.payload.config.isDefault, true);
  assert.equal(edited.payload.config.credentialReference, config.credentialReference);
  assert.equal(edited.payload.config.modelId, 'qwen-new');
  assert.equal(edited.payload.config.modelLabel, 'qwen-new');
  assert.equal(edited.payload.config.hasCredential, true);
  assert.equal(edited.payload.config.capabilities.session, false);
  assert.equal(edited.payload.config.capabilities.memory, false);
  assert.equal(edited.payload.config.lastTestStatus.status, 'untested');
  assert.equal(edited.payload.config.pricingStatus, 'unknown');
  assert.equal(edited.payload.config.pricing, null);
  assert.equal(server.providerConfigStore.secret(config.id), 'old-secret');
  assert.equal(server.providerConfigStore.get(other.id).modelId, 'deepseek-chat');

  const editedOther = await jsonRequest(`${base}api/ai/providers/configs/${encodeURIComponent(other.id)}`, {
    method: 'PATCH',
    body: {modelId: 'deepseek-reasoner'}
  });
  assert.equal(editedOther.status, 200);
  assert.equal(editedOther.payload.config.isDefault, false);
  assert.equal(server.providerConfigStore.get(config.id).isDefault, true);
  assert.equal(editedOther.payload.config.modelId, 'deepseek-reasoner');

  const list = await jsonRequest(`${base}api/ai/providers`);
  const listed = list.payload.configs.find((entry) => entry.id === config.id);
  assert.equal(listed.modelId, 'qwen-new');
  assert.equal(JSON.stringify(list.payload).includes('old-secret'), false);

  // Blank key is not a replacement.
  const blankKey = await jsonRequest(`${base}api/ai/providers/configs/${encodeURIComponent(config.id)}`, {
    method: 'PATCH',
    body: {apiKey: ''}
  });
  assert.equal(blankKey.status, 200);
  assert.equal(server.providerConfigStore.secret(config.id), 'old-secret');

  // Explicit new key replaces it, still with the same config id.
  const newKey = await jsonRequest(`${base}api/ai/providers/configs/${encodeURIComponent(config.id)}`, {
    method: 'PATCH',
    body: {apiKey: 'new-secret'}
  });
  assert.equal(newKey.status, 200);
  assert.equal(newKey.payload.config.id, config.id);
  assert.equal(server.providerConfigStore.secret(config.id), 'new-secret');

  // Name/concurrency edit with a price keeps the same record and makes it usable.
  const configured = await jsonRequest(`${base}api/ai/providers/configs/${encodeURIComponent(config.id)}`, {
    method: 'PATCH',
    body: {
      name: 'Bailian edited',
      concurrency: 5,
      pricingStatus: 'paid',
      pricing: {inputPerMillion: 1.5, outputPerMillion: 2.5, currency: 'CNY'}
    }
  });
  assert.equal(configured.status, 200);
  assert.equal(configured.payload.config.name, 'Bailian edited');
  assert.equal(configured.payload.config.concurrency, 5);
  assert.equal(configured.payload.config.pricing.inputPerMillion, 1.5);

  // Region change needs a new key and rotates the reference; the old key is not
  // silently reused under a different platform.
  const withoutKey = await jsonRequest(`${base}api/ai/providers/configs/${encodeURIComponent(config.id)}`, {
    method: 'PATCH',
    body: {regionId: 'singapore'}
  });
  assert.equal(withoutKey.status, 400);
  assert.equal(withoutKey.payload.error.code, 'AI_PROVIDER_REGION_KEY_REQUIRED');
  assert.equal(server.providerConfigStore.get(config.id).regionId, 'cn-beijing');
  assert.equal(server.providerConfigStore.secret(config.id), 'new-secret');

  const emptyModel = await jsonRequest(`${base}api/ai/providers/configs/${encodeURIComponent(config.id)}`, {
    method: 'PATCH',
    body: {modelId: ''}
  });
  assert.equal(emptyModel.status, 400);
  assert.equal(emptyModel.payload.error.code, 'AI_PROVIDER_MODEL_REQUIRED');
  assert.equal(server.providerConfigStore.get(config.id).modelId, 'qwen-new');
  const rotated = await jsonRequest(`${base}api/ai/providers/configs/${encodeURIComponent(config.id)}`, {
    method: 'PATCH',
    body: {regionId: 'singapore', apiKey: 'singapore-secret'}
  });
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.payload.config.credentialReference, config.credentialReference);
  assert.equal(server.providerConfigStore.secret(config.id), 'singapore-secret');
});

test('a running analysis blocks editing and a changed model cannot be resumed', async (t) => {
  const temp = createTempDir();
  const server = await startServer({auth: false,
    dataDir: temp.dir,
    port: 0,
    systemLocale: 'en',
    auto: {
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 300);
          options.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          }, {once: true});
        });
        return Response.json({
          model: body.model,
          choices: [{message: {content: sessionAnswer()}, finish_reason: 'stop'}],
          usage: {prompt_tokens: 10, completion_tokens: 5, total_tokens: 15}
        });
      }
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {messageCount: 4, viewerCount: 2, startedAt: T0});
  const config = server.providerConfigStore.create({
    providerId: 'custom',
    regionId: 'custom',
    baseUrl: 'https://example.com/v1',
    modelId: 'model-one',
    apiKey: 'test-key',
    pricingStatus: 'paid',
    pricing: {inputPerMillion: 1, outputPerMillion: 2, currency: 'USD'}
  });
  server.providerConfigStore.recordTest(config.id, {
    status: 'passed',
    capabilities: {network: true, auth: true, text: true, json: true, session: true, memory: true},
    stages: {}
  });

  await server.analysisRunner.start({
    sessionId: session.id,
    locale: 'en',
    mode: 'session',
    configId: config.id,
    consent: true,
    confirmBilling: true
  });
  const blocked = await jsonRequest(`${base(server)}api/ai/providers/configs/${encodeURIComponent(config.id)}`, {
    method: 'PATCH',
    body: {modelId: 'model-two'}
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.payload.error.code, 'AI_PROVIDER_CONFIG_IN_USE');
  const blockedDelete = await jsonRequest(`${base(server)}api/ai/providers/configs/${encodeURIComponent(config.id)}`, {
    method: 'DELETE'
  });
  assert.equal(blockedDelete.status, 409);
  assert.equal(blockedDelete.payload.error.code, 'AI_PROVIDER_CONFIG_IN_USE');

  // Pause, then edit the model. Resume must refuse because the job was started
  // with a different model snapshot.
  server.analysisRunner.pause(session.id);
  await waitForStatus(server, session.id, ['paused', 'failed', 'canceled']);
  const edited = await jsonRequest(`${base(server)}api/ai/providers/configs/${encodeURIComponent(config.id)}`, {
    method: 'PATCH',
    body: {modelId: 'model-two'}
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.payload));
  const resume = await jsonRequest(`${base(server)}api/ai/analyze/resume`, {
    method: 'POST',
    body: {
      sessionId: session.id,
      consent: true,
      confirmBilling: true,
      optInMemory: false
    }
  });
  assert.equal(resume.status, 409);
  assert.equal(resume.payload.error.code, 'AI_PROVIDER_CONFIG_CHANGED');
});

test('the analysis centre uses the edited model and keeps the saved key', async (t) => {
  const temp = createTempDir();
  const seenModels = [];
  const server = await startServer({auth: false,
    dataDir: temp.dir,
    port: 0,
    systemLocale: 'en',
    auto: {
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        seenModels.push(body.model);
        return Response.json({
          model: body.model,
          choices: [{message: {content: sessionAnswer()}, finish_reason: 'stop'}],
          usage: {prompt_tokens: 10, completion_tokens: 5, total_tokens: 15}
        });
      }
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {messageCount: 4, viewerCount: 2, startedAt: T0});
  const config = server.providerConfigStore.create({
    providerId: 'custom',
    regionId: 'custom',
    baseUrl: 'https://example.com/v1',
    modelId: 'old-model',
    apiKey: 'kept-key',
    pricingStatus: 'paid',
    pricing: {inputPerMillion: 1, outputPerMillion: 2, currency: 'USD'}
  });
  const edited = await jsonRequest(`${base(server)}api/ai/providers/configs/${encodeURIComponent(config.id)}`, {
    method: 'PATCH',
    body: {modelId: 'new-model'}
  });
  assert.equal(edited.status, 200);
  server.providerConfigStore.recordTest(config.id, {
    status: 'passed',
    capabilities: {network: true, auth: true, text: true, json: true, session: true, memory: false},
    stages: {}
  });
  await server.analysisRunner.start({
    sessionId: session.id,
    locale: 'en',
    mode: 'session',
    configId: config.id,
    consent: true,
    confirmBilling: true
  });
  const status = await waitForStatus(server, session.id, ['complete', 'failed']);
  assert.equal(status.status, 'complete', JSON.stringify(status));
  assert.equal(seenModels.includes('new-model'), true);
  assert.equal(seenModels.includes('old-model'), false);
  const report = await jsonRequest(`${base(server)}api/ai/sessions/${encodeURIComponent(session.id)}/report`);
  assert.equal(report.status, 200);
  assert.equal(report.payload.report.summary, 'Edited model summary');
});

function base(server) {
  return server.url;
}
