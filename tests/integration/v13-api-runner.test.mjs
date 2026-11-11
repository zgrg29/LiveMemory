import test from 'node:test';
import assert from 'node:assert/strict';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {startServer} from '../../src/server/index.mjs';
import {addBroadcaster, seedSession, T0} from '../helpers/ai-fixtures.mjs';

function sessionAnswer() {
  return JSON.stringify({
    session_topics: {
      summary: 'API session summary',
      topics: [],
      sentiment: [],
      disputes: [],
      highlights: []
    }
  });
}

test('paid verified runner can update memory without replacing the session report', async (t) => {
  const temp = createTempDir();
  const server = await startServer({
    dataDir: temp.dir,
    port: 0,
    systemLocale: 'en',
    auto: {
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        const text = body.messages.map((message) => message.content).join('\n');
        if (text.includes('AUTOMATIC MEMORY CONTRACT')) {
          const refs = [...new Set([...text.matchAll(/"ref":(\d+)/g)].map((match) => Number(match[1])))];
          return Response.json({
            model: body.model,
            choices: [{
              message: {
                content: JSON.stringify({
                  viewers: refs.map((ref) => ({ref, memory: {no_new_information: true, operations: []}}))
                })
              },
              finish_reason: 'stop'
            }],
            usage: {prompt_tokens: 100, completion_tokens: 30, total_tokens: 130}
          });
        }
        return Response.json({
          model: body.model,
          choices: [{message: {content: sessionAnswer({messages: body.messages})}, finish_reason: 'stop'}],
          usage: {prompt_tokens: 100, completion_tokens: 20, total_tokens: 120}
        });
      }
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {id: 'ses_v13_memory_api', messageCount: 6, viewerCount: 2, startedAt: T0});
  const config = server.providerConfigStore.create({
    providerId: 'custom',
    regionId: 'custom',
    baseUrl: 'https://example.com/v1',
    modelId: 'paid-model',
    apiKey: 'test-key',
    pricingStatus: 'paid',
    pricing: {inputPerMillion: 1, outputPerMillion: 2, currency: 'USD'}
  });
  server.providerConfigStore.recordTest(config.id, {
    status: 'passed',
    capabilities: {
      network: true, auth: true, text: true, json: true,
      session: true, memory: true, testedAt: new Date().toISOString()
    },
    stages: {}
  });
  // One HTTP click with `mode: both` must run session then memory. This is the
  // path the console uses; a previous mapping treated `both` as session-only.
  const started = await fetch(`${server.url}api/ai/analyze/run`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({
      sessionId: session.id,
      mode: 'both',
      configId: config.id,
      locale: 'en',
      consent: true,
      confirmBilling: true,
      optInMemory: true,
      budget: {amount: 10, currency: 'USD'}
    })
  });
  const startedText = await started.text();
  assert.equal(started.status, 202, startedText);
  const startedBody = JSON.parse(startedText);
  assert.equal(startedBody.mode, 'combined');
  for (let index = 0; index < 200; index += 1) {
    if (server.analysisRunner.getStatus(session.id).status === 'complete') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const status = server.analysisRunner.getStatus(session.id);
  assert.equal(status.status, 'complete', JSON.stringify(status));
  assert.equal(status.memoryDone, true);
  assert.ok(status.sessionJobId);
  assert.ok(status.memoryJobId);
  assert.equal(status.memoryJob.memoryCoverage.covered, 2);

  const report = await fetch(`${server.url}api/ai/sessions/${encodeURIComponent(session.id)}/report`).then((response) => response.json());
  assert.equal(report.mode, 'single');
  assert.equal(report.report.summary, 'API session summary');
  assert.equal(report.longTermProfiles.count, 2);
  assert.equal(report.longTermProfiles.items.length, 2);
});

test('a broadcast with no identifiable viewers keeps its session report and skips memory clearly', async (t) => {
  const temp = createTempDir();
  const server = await startServer({
    dataDir: temp.dir,
    port: 0,
    systemLocale: 'en',
    auto: {
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
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
  const session = seedSession(server.db, {
    id: 'ses_v131_no_viewers',
    messageCount: 4,
    viewerCount: 0,
    startedAt: T0
  });
  const config = server.providerConfigStore.create({
    providerId: 'custom',
    regionId: 'custom',
    baseUrl: 'https://example.com/v1',
    modelId: 'paid-model',
    apiKey: 'test-key',
    pricingStatus: 'paid',
    pricing: {inputPerMillion: 1, outputPerMillion: 2, currency: 'USD'}
  });
  server.providerConfigStore.recordTest(config.id, {
    status: 'passed',
    capabilities: {network: true, auth: true, text: true, json: true, session: true, memory: true}
  });
  await server.analysisRunner.start({
    sessionId: session.id,
    locale: 'en',
    mode: 'both',
    configId: config.id,
    consent: true,
    confirmBilling: true,
    optInMemory: true
  });
  for (let index = 0; index < 200; index += 1) {
    if (server.analysisRunner.getStatus(session.id).status === 'complete') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const status = server.analysisRunner.getStatus(session.id);
  assert.equal(status.status, 'complete', JSON.stringify(status));
  assert.equal(status.sessionReportDone, true);
  assert.equal(status.memorySkipped, true);
  assert.equal(status.memorySkipReason, 'ANALYSIS_MEMORY_NO_VIEWERS');
  assert.equal(status.memoryJobId, null);
  const report = await fetch(`${server.url}api/ai/sessions/${encodeURIComponent(session.id)}/report`).then((response) => response.json());
  assert.equal(report.mode, 'single');
  assert.equal(report.report.summary, 'API session summary');
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM viewer_memories').get().n, 0);

  await server.analysisRunner.start({
    sessionId: session.id,
    locale: 'en',
    mode: 'memory',
    configId: config.id,
    consent: true,
    confirmBilling: true,
    optInMemory: true
  });
  for (let index = 0; index < 200; index += 1) {
    if (server.analysisRunner.getStatus(session.id).status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const failed = server.analysisRunner.getStatus(session.id);
  assert.equal(failed.status, 'failed', JSON.stringify(failed));
  assert.equal(failed.error.code, 'ANALYSIS_MEMORY_NO_VIEWERS');
});

test('the per-task budget stops paid requests before they are sent', async (t) => {
  const temp = createTempDir();
  let calls = 0;
  const server = await startServer({
    dataDir: temp.dir,
    port: 0,
    systemLocale: 'en',
    auto: {
      fetchImpl: async () => {
        calls += 1;
        return Response.json({choices: [{message: {content: '{}'}, finish_reason: 'stop'}]});
      }
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {id: 'ses_v13_budget', messageCount: 4, viewerCount: 2, startedAt: T0});
  const config = server.providerConfigStore.create({
    providerId: 'custom', regionId: 'custom', baseUrl: 'https://example.com/v1',
    modelId: 'paid-model', apiKey: 'test-key', pricingStatus: 'paid',
    pricing: {inputPerMillion: 1, outputPerMillion: 2, currency: 'USD'}
  });
  server.providerConfigStore.recordTest(config.id, {
    status: 'passed',
    capabilities: {network: true, auth: true, text: true, json: true, session: true, memory: true}
  });
  await server.analysisRunner.start({
    sessionId: session.id,
    locale: 'en',
    mode: 'session',
    configId: config.id,
    consent: true,
    confirmBilling: true,
    budget: {amount: 0.0000001, currency: 'USD'}
  });
  for (let index = 0; index < 100; index += 1) {
    if (server.analysisRunner.getStatus(session.id).status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const status = server.analysisRunner.getStatus(session.id);
  assert.equal(status.status, 'failed');
  assert.equal(status.error.code, 'ANALYSIS_BUDGET_EXCEEDED');
  assert.equal(calls, 0);
});

test('configured free API runner analyses only one session and saves it', async (t) => {
  const temp = createTempDir();
  const calls = [];
  const server = await startServer({
    dataDir: temp.dir,
    port: 0,
    systemLocale: 'en',
    auto: {
      fetchImpl: async (url, options) => {
        calls.push(String(url));
        const body = JSON.parse(options.body);
        return Response.json({
          model: body.model,
          choices: [{message: {content: sessionAnswer({messages: body.messages})}, finish_reason: 'stop'}],
          usage: {prompt_tokens: 100, completion_tokens: 20, total_tokens: 120}
        });
      }
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {id: 'ses_v13_api', messageCount: 8, viewerCount: 2, startedAt: T0});
  const config = server.providerConfigStore.create({
    providerId: 'custom',
    regionId: 'custom',
    baseUrl: 'https://example.com/v1',
    modelId: 'free-model',
    apiKey: 'test-key',
    pricingStatus: 'api_free',
    pricing: {inputPerMillion: 0, outputPerMillion: 0, currency: 'USD'}
  });
  server.providerConfigStore.recordTest(config.id, {
    status: 'passed',
    capabilities: {
      network: true,
      auth: true,
      text: true,
      json: true,
      session: true,
      memory: false,
      testedAt: new Date().toISOString()
    },
    stages: {}
  });

  const started = await server.analysisRunner.start({
    sessionId: session.id,
    locale: 'en',
    mode: 'session',
    configId: config.id,
    consent: true
  });
  assert.equal(started.running, true);
  assert.equal(started.mode, 'session');

  for (let index = 0; index < 200; index += 1) {
    if (server.analysisRunner.getStatus(session.id).status === 'complete') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const status = server.analysisRunner.getStatus(session.id);
  assert.equal(status.status, 'complete', JSON.stringify(status));
  assert.equal(status.sessionReportDone, true);
  assert.equal(status.memoryDone, true);
  assert.equal(status.memoryJobId, null);
  assert.ok(calls.every((url) => url.endsWith('/chat/completions')));

  const report = await fetch(`${server.url}api/ai/sessions/${encodeURIComponent(session.id)}/report`).then((response) => response.json());
  assert.equal(report.mode, 'single');
  assert.equal(report.report.summary, 'API session summary');

  const memory = await fetch(`${server.url}api/ai/analyze/run`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({
      sessionId: session.id,
      mode: 'memory',
      configId: config.id,
      locale: 'en',
      consent: true,
      optInMemory: true
    })
  });
  assert.equal(memory.status, 403);
  const payload = await memory.json();
  assert.equal(payload.error.code, 'AI_MEMORY_PERMISSION_DENIED');
});
