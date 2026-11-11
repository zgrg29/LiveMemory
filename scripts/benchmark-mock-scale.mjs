/**
 * Mock scale benchmark for the paid-provider scheduler.
 *
 * No network and no real API key are used. It seeds synthetic large sessions,
 * runs the real packaging + scheduler + importer path with a mock transport, and
 * prints observable timings. Run:
 *
 *   node scripts/benchmark-mock-scale.mjs 1000 10000
 *   node scripts/benchmark-mock-scale.mjs 100 1000
 */
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../src/server/index.mjs';
import {addBroadcaster, seedSession, T0} from '../tests/helpers/ai-fixtures.mjs';

const viewerCount = Math.max(1, Number(process.argv[2]) || 100);
const messageCount = Math.max(1, Number(process.argv[3]) || 1000);
const concurrency = Math.max(1, Math.min(8, Number(process.argv[4]) || 6));

const temp = await mkdtemp(join(tmpdir(), 'livememory-scale-'));
let active = 0;
let peak = 0;
let requests = 0;
const server = await startServer({
  dataDir: temp,
  port: 0,
  systemLocale: 'en',
  auto: {
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      const text = body.messages.map((message) => message.content).join('\n');
      active += 1;
      peak = Math.max(peak, active);
      requests += 1;
      try {
        await new Promise((resolve) => setTimeout(resolve, 2));
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
      } finally {
        active -= 1;
      }
    }
  }
});
try {
  addBroadcaster(server.db);
  const seedStarted = performance.now();
  const session = seedSession(server.db, {
    id: `ses_scale_${viewerCount}`,
    messageCount,
    viewerCount,
    startedAt: T0
  });
  const seedMs = performance.now() - seedStarted;
  const config = server.providerConfigStore.create({
    providerId: 'custom',
    regionId: 'custom',
    baseUrl: 'https://example.com/v1',
    modelId: 'mock-scale-model',
    apiKey: 'mock-key',
    pricingStatus: 'paid',
    pricing: {inputPerMillion: 1, outputPerMillion: 2, currency: 'USD'},
    concurrency
  });
  server.providerConfigStore.recordTest(config.id, {
    status: 'passed',
    capabilities: {network: true, auth: true, text: true, json: true, session: true, memory: true}
  });
  if (global.gc) global.gc();
  const heapBefore = process.memoryUsage().heapUsed;
  const started = performance.now();
  await server.analysisRunner.start({
    sessionId: session.id,
    locale: 'en',
    mode: 'memory',
    configId: config.id,
    consent: true,
    confirmBilling: true,
    optInMemory: true
  });
  let status = null;
  for (let index = 0; index < 6000; index += 1) {
    status = server.analysisRunner.getStatus(session.id);
    if (['complete', 'failed', 'partial'].includes(status.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const elapsedMs = performance.now() - started;
  const heapAfter = process.memoryUsage().heapUsed;
  console.log(JSON.stringify({
    viewerCount,
    messageCount,
    concurrency,
    status: status?.status,
    batchTotal: status?.batchTotal,
    covered: status?.memoryJob?.memoryCoverage?.covered,
    requests,
    peakConcurrency: peak,
    seedMs: Math.round(seedMs),
    elapsedMs: Math.round(elapsedMs),
    requestsPerSecond: elapsedMs > 0 ? Number((requests / (elapsedMs / 1000)).toFixed(2)) : null,
    heapDeltaMb: Number(((heapAfter - heapBefore) / 1024 / 1024).toFixed(2)),
    requestStats: status?.requestStats ?? null,
    error: status?.error ?? null
  }, null, 2));
} finally {
  await server.close();
  await rm(temp, {recursive: true, force: true});
}
