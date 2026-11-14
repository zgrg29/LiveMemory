import test from 'node:test';
import assert from 'node:assert/strict';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {startServer} from '../../src/server/index.mjs';
import {addBroadcaster, seedSession, T0} from '../helpers/ai-fixtures.mjs';

function sessionAnswer() {
  return JSON.stringify({
    session_topics: {
      summary: 'Scheduler test summary',
      topics: [],
      sentiment: [],
      disputes: [],
      highlights: []
    }
  });
}

test('paid provider retries a 429 after Retry-After and records the rate-limit wait', async (t) => {
  const temp = createTempDir();
  let calls = 0;
  const server = await startServer({auth: false,
    dataDir: temp.dir,
    port: 0,
    systemLocale: 'en',
    auto: {
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(JSON.stringify({error: {message: 'slow down'}}), {
            status: 429,
            headers: {'content-type': 'application/json', 'retry-after': '0'}
          });
        }
        return Response.json({
          model: 'paid-model',
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
  const session = seedSession(server.db, {id: 'ses_v131_retry', messageCount: 4, viewerCount: 2, startedAt: T0});
  const config = server.providerConfigStore.create({
    providerId: 'custom',
    regionId: 'custom',
    baseUrl: 'https://example.com/v1',
    modelId: 'paid-model',
    apiKey: 'test-key',
    pricingStatus: 'paid',
    pricing: {inputPerMillion: 1, outputPerMillion: 2, currency: 'USD'},
    concurrency: 3
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
    confirmBilling: true
  });
  for (let index = 0; index < 200; index += 1) {
    if (server.analysisRunner.getStatus(session.id).status === 'complete') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const status = server.analysisRunner.getStatus(session.id);
  assert.equal(status.status, 'complete', JSON.stringify(status));
  assert.equal(calls, 2);
  assert.equal(status.requestStats.rateLimited, 1);
  assert.ok(status.requestStats.throttleWaitMs >= 0);
  assert.equal(status.requestStats.total, 2);
});

test('memory batches run with bounded concurrency and keep every viewer covered', async (t) => {  const temp = createTempDir();
  let active = 0;
  let peak = 0;
  let memoryCalls = 0;
  const server = await startServer({auth: false,
    dataDir: temp.dir,
    port: 0,
    systemLocale: 'en',
    auto: {
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        const text = body.messages.map((message) => message.content).join('\n');
        active += 1;
        peak = Math.max(peak, active);
        try {
          await new Promise((resolve) => setTimeout(resolve, 35));
          if (text.includes('AUTOMATIC MEMORY CONTRACT')) {
            memoryCalls += 1;
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
              usage: {prompt_tokens: 50, completion_tokens: 10, total_tokens: 60}
            });
          }
          return Response.json({
            model: body.model,
            choices: [{message: {content: sessionAnswer()}, finish_reason: 'stop'}],
            usage: {prompt_tokens: 10, completion_tokens: 5, total_tokens: 15}
          });
        } finally {
          active -= 1;
        }
      }
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {
    id: 'ses_v131_concurrency',
    messageCount: 30,
    viewerCount: 30,
    startedAt: T0
  });
  const config = server.providerConfigStore.create({
    providerId: 'custom',
    regionId: 'custom',
    baseUrl: 'https://example.com/v1',
    modelId: 'paid-model',
    apiKey: 'test-key',
    pricingStatus: 'paid',
    pricing: {inputPerMillion: 1, outputPerMillion: 2, currency: 'USD'},
    concurrency: 3
  });
  server.providerConfigStore.recordTest(config.id, {
    status: 'passed',
    capabilities: {network: true, auth: true, text: true, json: true, session: true, memory: true}
  });
  await server.analysisRunner.start({
    sessionId: session.id,
    locale: 'en',
    mode: 'memory',
    configId: config.id,
    consent: true,
    confirmBilling: true,
    optInMemory: true
  });
  for (let index = 0; index < 300; index += 1) {
    if (server.analysisRunner.getStatus(session.id).status === 'complete') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const status = server.analysisRunner.getStatus(session.id);
  assert.equal(status.status, 'complete', JSON.stringify(status));
  assert.equal(status.memoryJob.memoryCoverage.total, 30);
  assert.equal(status.memoryJob.memoryCoverage.covered, 30);
  assert.equal(memoryCalls, 3);
  assert.ok(peak >= 2, `expected concurrent memory batches, peak was ${peak}`);
  assert.ok(peak <= 3, `concurrency exceeded the configured limit: ${peak}`);
  assert.ok(status.requestStats.completed >= 3);
});

test('a failed memory batch can be resumed without repeating imported batches', async (t) => {
  const temp = createTempDir();
  let failBatchTwo = true;
  const requestedBatches = [];
  const server = await startServer({auth: false,
    dataDir: temp.dir,
    port: 0,
    systemLocale: 'en',
    auto: {
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        const text = body.messages.map((message) => message.content).join('\n');
        const batchMatch = /"batch_id":"([^"]+)"/.exec(text);
        const batchId = batchMatch?.[1] ?? 'unknown';
        requestedBatches.push(batchId);
        if (failBatchTwo && batchId.endsWith('b02')) {
          return new Response(JSON.stringify({error: {message: 'synthetic schema failure'}}), {
            status: 400,
            headers: {'content-type': 'application/json'}
          });
        }
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
          usage: {prompt_tokens: 20, completion_tokens: 5, total_tokens: 25}
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
    id: 'ses_v131_resume',
    messageCount: 30,
    viewerCount: 30,
    startedAt: T0
  });
  const config = server.providerConfigStore.create({
    providerId: 'custom',
    regionId: 'custom',
    baseUrl: 'https://example.com/v1',
    modelId: 'paid-model',
    apiKey: 'test-key',
    pricingStatus: 'paid',
    pricing: {inputPerMillion: 1, outputPerMillion: 2, currency: 'USD'},
    concurrency: 1
  });
  server.providerConfigStore.recordTest(config.id, {
    status: 'passed',
    capabilities: {network: true, auth: true, text: true, json: true, session: true, memory: true}
  });
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
    if (['failed', 'partial', 'needs_action', 'complete'].includes(server.analysisRunner.getStatus(session.id).status)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const failed = server.analysisRunner.getStatus(session.id);
  assert.equal(failed.status, 'needs_action', JSON.stringify(failed));
  assert.equal(failed.canResume, true);
  assert.equal(failed.memoryJob.memoryCoverage.covered, 10);
  assert.equal(requestedBatches.length, 2);

  failBatchTwo = false;
  await server.analysisRunner.resume(session.id, {
    consent: true,
    confirmBilling: true,
    optInMemory: true
  });
  for (let index = 0; index < 300; index += 1) {
    if (server.analysisRunner.getStatus(session.id).status === 'complete') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const complete = server.analysisRunner.getStatus(session.id);
  assert.equal(complete.status, 'complete', JSON.stringify(complete));
  assert.equal(complete.memoryJob.memoryCoverage.covered, 30);
  // b01 once, b02 failed, then b02 + b03 on resume. b01 is never requested again.
  assert.equal(requestedBatches.length, 4);
  assert.equal(requestedBatches.filter((id) => id.endsWith('b01')).length, 1);
});

test('an older broadcast cannot overwrite newer long-term memory', async (t) => {
  const temp = createTempDir();
  const server = await startServer({auth: false,
    dataDir: temp.dir,
    port: 0,
    systemLocale: 'en',
    auto: {
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        const text = body.messages.map((message) => message.content).join('\n');
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
  const older = seedSession(server.db, {
    id: 'ses_v131_older',
    messageCount: 2,
    viewerCount: 2,
    startedAt: T0 - 100000
  });
  const newer = seedSession(server.db, {
    id: 'ses_v131_newer',
    messageCount: 2,
    viewerCount: 2,
    startedAt: T0
  });
  const config = server.providerConfigStore.create({
    providerId: 'custom',
    regionId: 'custom',
    baseUrl: 'https://example.com/v1',
    modelId: 'paid-model',
    apiKey: 'test-key',
    pricingStatus: 'paid',
    pricing: {inputPerMillion: 1, outputPerMillion: 2, currency: 'USD'},
    concurrency: 2
  });
  server.providerConfigStore.recordTest(config.id, {
    status: 'passed',
    capabilities: {network: true, auth: true, text: true, json: true, session: true, memory: true}
  });
  const options = {
    locale: 'en',
    mode: 'memory',
    configId: config.id,
    consent: true,
    confirmBilling: true,
    optInMemory: true
  };
  await server.analysisRunner.start({...options, sessionId: newer.id});
  for (let index = 0; index < 200; index += 1) {
    if (server.analysisRunner.getStatus(newer.id).status === 'complete') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(server.analysisRunner.getStatus(newer.id).status, 'complete');

  await server.analysisRunner.start({...options, sessionId: older.id});
  for (let index = 0; index < 200; index += 1) {
    if (server.analysisRunner.getStatus(older.id).status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const blocked = server.analysisRunner.getStatus(older.id);
  assert.equal(blocked.status, 'failed', JSON.stringify(blocked));
  assert.equal(blocked.error.code, 'ANALYSIS_MEMORY_OUT_OF_ORDER');
});


