import test from 'node:test';
import assert from 'node:assert/strict';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {startServer} from '../../src/server/index.mjs';
import {addBroadcaster, seedSession, T0} from '../helpers/ai-fixtures.mjs';

function answer() {
  return JSON.stringify({
    session_topics: {
      summary: 'Optional pricing test.',
      topics: [{
        title: 'Price topic',
        started_at: new Date(T0 + 1000).toISOString(),
        ended_at: new Date(T0 + 2000).toISOString(),
        summary: 'A topic.',
        key_points: ['price'],
        confidence: 0.7,
        evidence: 'observed',
        message_refs: [1]
      }],
      sentiment: [],
      disputes: [],
      highlights: []
    }
  });
}

function provider(server, pricing) {
  const config = server.providerConfigStore.create({
    providerId: 'custom',
    regionId: 'custom',
    baseUrl: 'https://example.com/v1',
    modelId: 'priced-model',
    apiKey: 'test-key',
    ...(pricing === undefined ? {} : {pricing})
  });
  server.providerConfigStore.recordTest(config.id, {
    status: 'passed',
    capabilities: {network: true, auth: true, text: true, json: true, session: true, memory: true},
    stages: {}
  });
  return config;
}

async function runWith(server, session, config) {
  server.analysisRunner.fetchImpl = async () => Response.json({
    model: config.modelId,
    choices: [{message: {content: answer()}, finish_reason: 'stop'}],
    usage: {prompt_tokens: 100, completion_tokens: 20, total_tokens: 120}
  });
  await server.analysisRunner.start({
    sessionId: session.id, locale: 'en', mode: 'session', configId: config.id, consent: true
  });
  const deadline = Date.now() + 5000;
  for (;;) {
    const status = server.analysisRunner.getStatus(session.id);
    if (status.status !== 'running') return status;
    if (Date.now() > deadline) throw new Error('timeout');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

async function withServer(t, fn) {
  const temp = createTempDir();
  const server = await startServer({dataDir: temp.dir, port: 0, systemLocale: 'en'});
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  return fn(server);
}

test('an empty price runs normally, records tokens, and never invents a cost', async (t) => {
  await withServer(t, async (server) => {
    const session = seedSession(server.db, {id: 'ses_price_empty', messageCount: 6, viewerCount: 2, startedAt: T0});
    const config = provider(server, undefined);
    const status = await runWith(server, session, config);
    assert.equal(status.status, 'complete');
    assert.equal(status.usage.inputTokens, 100);
    assert.equal(status.usage.cost, null);
    assert.equal(status.estimatedCost, null);
  });
});

test('a complete price produces a cost; a partial price does not', async (t) => {
  await withServer(t, async (server) => {
    const fullSession = seedSession(server.db, {id: 'ses_price_full', messageCount: 6, viewerCount: 2, startedAt: T0});
    const fullConfig = provider(server, {inputPerMillion: 1, outputPerMillion: 2, currency: 'USD'});
    const full = await runWith(server, fullSession, fullConfig);
    assert.equal(full.status, 'complete');
    assert.ok(full.usage.cost);
    assert.equal(full.usage.cost.currency, 'USD');
    assert.ok(full.usage.cost.amount > 0);

    const partialSession = seedSession(server.db, {id: 'ses_price_partial', messageCount: 6, viewerCount: 2, startedAt: T0});
    const partialConfig = provider(server, {inputPerMillion: 1, currency: 'USD'});
    assert.equal(partialConfig.pricing, null, 'partial pricing is not stored as a complete price');
    const partial = await runWith(server, partialSession, partialConfig);
    assert.equal(partial.status, 'complete');
    assert.equal(partial.usage.inputTokens, 100);
    assert.equal(partial.usage.cost, null);
  });
});
