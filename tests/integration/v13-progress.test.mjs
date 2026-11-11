import test from 'node:test';
import assert from 'node:assert/strict';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {startServer} from '../../src/server/index.mjs';
import {addBroadcaster, seedSession, T0} from '../helpers/ai-fixtures.mjs';

test('analysis status advances batch and viewer progress while the task is running', async (t) => {
  const temp = createTempDir();
  const server = await startServer({
    dataDir: temp.dir,
    port: 0,
    systemLocale: 'en',
    auto: {
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        const text = body.messages.map((message) => message.content).join('\n');
        await new Promise((resolve) => setTimeout(resolve, 60));
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
  const session = seedSession(server.db, {
    id: 'ses_progress_live',
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
  const seen = [];
  for (let index = 0; index < 300; index += 1) {
    const status = server.analysisRunner.getStatus(session.id);
    if (status.status !== 'idle') {
      seen.push({
        status: status.status,
        batches: Number(status.batchIndex ?? 0),
        covered: Number(status.memoryJob?.memoryCoverage?.covered ?? 0)
      });
    }
    if (status.status === 'complete') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(seen.length > 0);
  assert.ok(seen.some((entry) => entry.status === 'running'));
  assert.ok(seen.some((entry) => entry.batches > 0 && entry.batches < 3));
  assert.ok(seen.some((entry) => entry.covered > 0 && entry.covered < 30));
  assert.equal(seen.at(-1).status, 'complete');
  assert.equal(seen.at(-1).batches, 3);
  assert.equal(seen.at(-1).covered, 30);
});
