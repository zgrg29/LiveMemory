import test from 'node:test';
import assert from 'node:assert/strict';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {startServer} from '../../src/server/index.mjs';
import {addBroadcaster, seedSession, T0} from '../helpers/ai-fixtures.mjs';

function extract(pattern, text) {
  return pattern.exec(text)?.[1] ?? null;
}

function sessionAnswer(prompt) {
  const text = prompt.messages.map((message) => message.content).join('\n');
  return JSON.stringify({
    protocol: 'livememory-analysis-result-v1',
    schema_version: '1.3.0',
    analysis_scope: 'session',
    job_id: extract(/job_id: `([^`]+)`/, text),
    batch_id: extract(/batch_id: `([^`]+)`/, text),
    task_id: extract(/task_id: `([^`]+)`/, text),
    session_id: extract(/session_id: `([^`]+)`/, text),
    locale: 'en',
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
  // First create the session report through the same runner.
  await server.analysisRunner.start({
    sessionId: session.id,
    locale: 'en',
    mode: 'session',
    configId: config.id,
    consent: true,
    confirmBilling: true
  });
  for (let index = 0; index < 100; index += 1) {
    if (server.analysisRunner.getStatus(session.id).status === 'complete') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(server.analysisRunner.getStatus(session.id).status, 'complete');

  const started = await fetch(`${server.url}api/ai/analyze/run`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({
      sessionId: session.id,
      mode: 'memory',
      configId: config.id,
      locale: 'en',
      consent: true,
      confirmBilling: true,
      optInMemory: true,
      budget: {amount: 10, currency: 'USD'}
    })
  });
  assert.equal(started.status, 202, await started.text());
  for (let index = 0; index < 200; index += 1) {
    if (server.analysisRunner.getStatus(session.id).status === 'complete') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const status = server.analysisRunner.getStatus(session.id);
  assert.equal(status.status, 'complete', JSON.stringify(status));
  assert.equal(status.memoryDone, true);
  assert.ok(status.memoryJobId);
  assert.equal(status.memoryJob.memoryCoverage.covered, 2);

  const report = await fetch(`${server.url}api/ai/sessions/${encodeURIComponent(session.id)}/report`).then((response) => response.json());
  assert.equal(report.mode, 'single');
  assert.equal(report.report.summary, 'API session summary');
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
