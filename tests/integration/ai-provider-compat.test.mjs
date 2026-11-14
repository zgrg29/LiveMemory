import test from 'node:test';
import assert from 'node:assert/strict';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {startServer} from '../../src/server/index.mjs';
import {addBroadcaster, seedSession, parsePromptMemoryRefs, T0} from '../helpers/ai-fixtures.mjs';

/**
 * P0-3: the production path for structured output.
 *
 * The capability test used to receive `capabilities.structuredOutputs` as its
 * own input, so it could never record `true` and the "schema only once"
 * optimization never activated. These tests drive the real HTTP route and the
 * real runner; only `fetch` is mocked.
 */

const SESSION_ANSWER = JSON.stringify({
  session_topics: {
    summary: 'Synthetic session summary',
    topics: [],
    sentiment: [],
    disputes: [],
    highlights: []
  }
});

function probeAnswer(text) {
  let content = 'OK';
  if (text.includes('Synthetic livestream chat')) {
    content = JSON.stringify({
      session_topics: {
        summary: 'summary',
        topics: [{
          title: 'chat',
          started_at: '2026-01-01T00:00:00Z',
          ended_at: '2026-01-01T00:01:00Z',
          summary: 'talk',
          key_points: ['point'],
          confidence: 0.7,
          evidence: 'observed'
        }],
        sentiment: [],
        disputes: [],
        highlights: []
      }
    });
  } else if (text.includes('Synthetic LiveMemory memory test')) {
    content = JSON.stringify({
      viewers: [
        {ref: 1, memory: {no_new_information: false, operations: [{op: 'add', kind: 'interest', topic: 'guitar', statement: 'learning guitar', certainty: 'stated', evidence: [1]}]}},
        {ref: 2, memory: {no_new_information: false, operations: [{op: 'add', kind: 'interest', topic: 'drawing', statement: 'enjoys drawing', certainty: 'stated', evidence: [2]}]}},
        {ref: 3, memory: {no_new_information: true, operations: []}}
      ]
    });
  } else if (text.includes('"ok":true')) content = JSON.stringify({ok: true});
  return content;
}

async function jsonRequest(url, {method = 'GET', body} = {}) {
  const response = await fetch(url, {
    method,
    headers: body ? {'content-type': 'application/json'} : {},
    body: body ? JSON.stringify(body) : undefined
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return {status: response.status, payload};
}

function waitFor(runner, sessionId, statuses, {attempts = 2000} = {}) {
  return (async () => {
    for (let index = 0; index < attempts; index += 1) {
      const status = runner.getStatus(sessionId);
      if (statuses.includes(status.status)) return status;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return runner.getStatus(sessionId);
  })();
}

test('the capability test route probes json_schema and persists verified support', async (t) => {
  const temp = createTempDir();
  const formats = [];
  const server = await startServer({
    auth: false,
    dataDir: temp.dir,
    port: 0,
    systemLocale: 'en',
    auto: {
      fetchImpl: async (url, options) => {
        if (String(url).endsWith('/models')) return Response.json({data: [{id: 'mock-model'}]});
        const body = JSON.parse(options.body);
        formats.push(body.response_format?.type ?? 'none');
        return Response.json({
          model: body.model,
          choices: [{
            message: {content: probeAnswer(body.messages.map((message) => message.content).join('\n'))},
            finish_reason: 'stop'
          }],
          usage: {prompt_tokens: 10, completion_tokens: 5}
        });
      }
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  const created = await jsonRequest(`${server.url}api/ai/providers/configs`, {
    method: 'POST',
    body: {
      providerId: 'openai',
      regionId: 'global',
      modelId: 'mock-model',
      apiKey: 'test-key',
      pricingStatus: 'paid',
      pricing: {inputPerMillion: 1, outputPerMillion: 2, currency: 'USD'}
    }
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  const configId = created.payload.config.id;
  assert.equal(created.payload.config.capabilities.structuredOutputs, false);

  const tested = await jsonRequest(`${server.url}api/ai/providers/configs/${encodeURIComponent(configId)}/test`, {
    method: 'POST',
    body: {confirmBilling: true}
  });
  assert.equal(tested.status, 200, JSON.stringify(tested.payload));
  assert.equal(tested.payload.result.status, 'passed', JSON.stringify(tested.payload.result.stages));
  assert.equal(tested.payload.result.capabilities.structuredOutputs, true);
  assert.equal(tested.payload.result.capabilities.memory, true);
  assert.equal(tested.payload.config.capabilities.structuredOutputs, true);
  // text -> json -> session -> memory; the three schema stages all use the real
  // structured-output parameter, and the session/memory schemas are non-trivial.
  assert.deepEqual(formats, ['none', 'json_schema', 'json_schema', 'json_schema']);
});

test('a rejected schema during a real job downgrades once, keeps the contract and completes', async (t) => {  const temp = createTempDir();
  const requests = [];
  const server = await startServer({
    auth: false,
    dataDir: temp.dir,
    port: 0,
    systemLocale: 'en',
    auto: {
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        const format = body.response_format?.type ?? 'none';
        const text = body.messages.map((message) => message.content).join('\n');
        requests.push({format, text});
        if (format === 'json_schema') {
          return Response.json({
            error: {message: "Invalid value for 'response_format': json_schema is not supported", type: 'invalid_request_error'}
          }, {status: 400, headers: {'content-type': 'application/json'}});
        }
        return Response.json({
          model: body.model,
          choices: [{message: {content: SESSION_ANSWER}, finish_reason: 'stop'}],
          usage: {prompt_tokens: 12, completion_tokens: 6}
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
    id: 'ses_provider_compat',
    messageCount: 6,
    viewerCount: 2,
    startedAt: T0
  });
  const config = server.providerConfigStore.create({
    providerId: 'openai',
    regionId: 'global',
    modelId: 'mock-model',
    apiKey: 'test-key',
    pricingStatus: 'paid',
    pricing: {inputPerMillion: 1, outputPerMillion: 2, currency: 'USD'}
  });
  server.providerConfigStore.recordTest(config.id, {
    status: 'passed',
    capabilities: {
      network: true, auth: true, text: true, json: true, structuredOutputs: true,
      session: true, memory: true, testedAt: new Date().toISOString()
    },
    stages: {}
  });

  await server.analysisRunner.start({
    sessionId: session.id,
    locale: 'en',
    mode: 'session',
    configId: config.id,
    consent: true
  });
  const status = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial']);
  assert.equal(status.status, 'complete', JSON.stringify(status.error));

  assert.equal(requests.length, 2);
  assert.equal(requests[0].format, 'json_schema');
  assert.equal(requests[1].format, 'json_object');
  // The retry must carry the schema it can no longer send as a parameter.
  assert.match(requests[1].text, /OUTPUT FORMAT FALLBACK/);
  assert.match(requests[1].text, /"session_topics"/);
  // The first attempt was paid for (no usage block -> unknown, not zero) and the
  // successful retry is counted separately.
  assert.equal(status.usage.attempts, 2);
  assert.equal(status.usage.requests, 1);
  assert.equal(status.usage.unknownUsageAttempts, 1);
  // The downgrade is persisted, so a later task (and Resume) never repeats it.
  assert.equal(server.providerConfigStore.get(config.id).capabilities.structuredOutputs, false);
  assert.equal(server.providerConfigStore.get(config.id).capabilities.memory, true);
});

/**
 * Structural half of the P0-3 10-vs-20 comparison.
 *
 * Same synthetic data, same mock semantics: only the viewer ceiling changes. It
 * proves the planner produces 2 batches at 10 viewers and 1 at 20 for a sparse
 * audience while covering every viewer. It does NOT prove semantic quality; that
 * requires a real provider and is a Phase B item.
 */
async function runSparseMemoryBatch({cap, viewers = 12}) {
  const temp = createTempDir();
  const requests = [];
  const server = await startServer({
    auth: false,
    dataDir: temp.dir,
    port: 0,
    systemLocale: 'en',
    auto: {
      memoryViewerCapHard: cap,
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        const text = body.messages.map((message) => message.content).join('\n');
        requests.push(text);
        const refs = parsePromptMemoryRefs(text);
        assert.ok(refs.size > 0, 'memory request must carry refs');
        return Response.json({
          model: body.model,
          choices: [{
            message: {
              content: JSON.stringify({
                viewers: [...refs.values()].map((entry) => ({
                  ref: entry.ref,
                  memory: {no_new_information: true, operations: []}
                }))
              })
            },
            finish_reason: 'stop'
          }],
          usage: {prompt_tokens: 20, completion_tokens: 10}
        });
      }
    }
  });
  try {
    addBroadcaster(server.db);
    const session = seedSession(server.db, {
      id: `ses_cap_${cap}`,
      messageCount: viewers,
      viewerCount: viewers,
      startedAt: T0
    });
    const config = server.providerConfigStore.create({
      providerId: 'custom',
      regionId: 'custom',
      baseUrl: 'https://example.com/v1',
      modelId: 'mock-model',
      apiKey: 'test-key'
    });
    server.providerConfigStore.recordTest(config.id, {
      status: 'passed',
      capabilities: {
        network: true, auth: true, text: true, json: true,
        session: true, memory: true, testedAt: new Date().toISOString()
      },
      stages: {}
    });
    await server.analysisRunner.start({
      sessionId: session.id,
      locale: 'en',
      mode: 'memory',
      configId: config.id,
      consent: true
    });
    const status = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial']);
    return {status, requests: requests.length};
  } finally {
    await server.close();
    temp.cleanup();
  }
}

test('the 10-viewer ceiling and the adaptive 20 ceiling plan the same data differently', async () => {
  const ten = await runSparseMemoryBatch({cap: 10});
  const twenty = await runSparseMemoryBatch({cap: 20});
  assert.equal(ten.status.status, 'complete', JSON.stringify(ten.status.error));
  assert.equal(twenty.status.status, 'complete', JSON.stringify(twenty.status.error));
  assert.equal(ten.status.memoryViewersTotal, 12);
  assert.equal(twenty.status.memoryViewersTotal, 12);
  assert.equal(ten.status.memoryBatchTotal, 2);
  assert.equal(twenty.status.memoryBatchTotal, 1);
  assert.equal(ten.requests, 2);
  assert.equal(twenty.requests, 1);
  // Every viewer is covered in both plans; nothing is silently dropped.
  assert.equal(ten.status.memoryCoverage.covered, 12);
  assert.equal(twenty.status.memoryCoverage.covered, 12);
});
