import test from 'node:test';
import assert from 'node:assert/strict';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {startServer} from '../../src/server/index.mjs';
import {addBroadcaster, seedSession, T0} from '../helpers/ai-fixtures.mjs';
import {APP_VERSION} from '../../src/shared/app-info.mjs';

/**
 * OpenCode Console through the real local HTTP routes and the real runner.
 *
 * Only `fetch` is mocked. These tests prove the integration point LiveMemory
 * owns: the provider is selectable, the official endpoint/model list are used,
 * and every request of one task carries one stable `x-opencode-session`, while
 * retries and a restart+Resume reuse it and separate tasks stay isolated.
 *
 * A real paid request against opencode.ai still requires a user-supplied key and
 * is explicitly not claimed by this file.
 */

const GO_BASE = 'https://opencode.ai/inference/go/openai/v1';
const GO_MODELS = 'https://opencode.ai/inference/go/v1/models';
const PAYG_BASE = 'https://opencode.ai/inference/openai/v1';
const PAYG_MODELS = 'https://opencode.ai/inference/v1/models';

const SESSION_ANSWER = JSON.stringify({
  session_topics: {
    summary: 'Synthetic session summary',
    topics: [],
    sentiment: [],
    disputes: [],
    highlights: []
  }
});

function sseResponse(content, usage = {prompt_tokens: 20, completion_tokens: 8}) {
  const encoder = new TextEncoder();
  const body = [
    `data: ${JSON.stringify({choices: [{delta: {content}}]})}\n\n`,
    `data: ${JSON.stringify({choices: [{delta: {}, finish_reason: 'stop'}], usage})}\n\n`,
    'data: [DONE]\n\n'
  ];
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of body) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  }), {headers: {'content-type': 'text/event-stream'}});
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

function seedConfig(server, {regionId = 'go', modelId = 'kimi-k3'} = {}) {
  const config = server.providerConfigStore.create({
    providerId: 'opencode',
    regionId,
    modelId,
    apiKey: 'oc_sk_integration_secret',
    pricingStatus: 'paid',
    pricing: {inputPerMillion: 3, outputPerMillion: 15, currency: 'USD'}
  });
  server.providerConfigStore.recordTest(config.id, {
    status: 'passed',
    capabilities: {
      network: true, auth: true, text: true, json: true,
      session: true, memory: true, testedAt: new Date().toISOString()
    },
    stages: {}
  });
  return config;
}

test('OpenCode is selectable, uses the official endpoints and one probe session', async (t) => {
  const temp = createTempDir();
  const calls = [];
  const server = await startServer({
    auth: false,
    dataDir: temp.dir,
    port: 0,
    systemLocale: 'en',
    auto: {
      fetchImpl: async (url, options) => {
        const body = options?.body ? JSON.parse(options.body) : null;
        calls.push({url: String(url), headers: options?.headers ?? {}, body});
        if (String(url).includes('/models')) {
          return Response.json({
            object: 'list',
            data: [{
              id: 'kimi-k3',
              name: 'Kimi K3',
              type: 'chat',
              limit: {context: 1000000},
              cost: {text: {input: {price: 3, cache: {read: 0.3}}, output: {price: 15}}},
              capabilities: {structured_output: true}
            }]
          });
        }
        const text = (body?.messages ?? []).map((message) => message.content).join('\n');
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
        } else if (text.includes('"ok":true')) {
          content = JSON.stringify({ok: true});
        }
        return Response.json({
          model: body?.model,
          choices: [{message: {content}, finish_reason: 'stop'}],
          usage: {prompt_tokens: 10, completion_tokens: 5, cost: 0.0002}
        });
      }
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });

  const catalogue = await jsonRequest(`${server.url}api/ai/providers`);
  assert.equal(catalogue.status, 200);
  const opencode = catalogue.payload.providers.find((entry) => entry.id === 'opencode');
  assert.ok(opencode, 'the settings catalogue must offer OpenCode');
  assert.deepEqual(opencode.regions.map((region) => region.id), ['payg', 'go']);
  assert.equal(opencode.regions[1].baseUrl, GO_BASE);

  const created = await jsonRequest(`${server.url}api/ai/providers/configs`, {
    method: 'POST',
    body: {
      providerId: 'opencode',
      regionId: 'go',
      modelId: 'kimi-k3',
      apiKey: 'oc_sk_integration_secret',
      pricing: {inputPerMillion: 3, outputPerMillion: 15, currency: 'USD'}
    }
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  assert.equal(created.payload.config.regionId, 'go');
  assert.equal(created.payload.config.baseUrl, GO_BASE);
  assert.equal(created.payload.config.protocol, 'openai');
  assert.equal(JSON.stringify(created.payload).includes('oc_sk_integration_secret'), false);

  const models = await jsonRequest(
    `${server.url}api/ai/providers/models?configId=${encodeURIComponent(created.payload.config.id)}`
  );
  assert.equal(models.status, 200, JSON.stringify(models.payload));
  assert.equal(models.payload.models[0].id, 'kimi-k3');
  assert.equal(models.payload.models[0].pricing.inputPerMillion, 3);
  assert.equal(calls.at(-1).url, GO_MODELS);

  const tested = await jsonRequest(
    `${server.url}api/ai/providers/configs/${encodeURIComponent(created.payload.config.id)}/test`,
    {method: 'POST', body: {}}
  );
  assert.equal(tested.status, 200, JSON.stringify(tested.payload));
  assert.equal(tested.payload.result.status, 'passed', JSON.stringify(tested.payload.result.stages));
  assert.equal(tested.payload.result.capabilities.memory, true);

  const inference = calls.filter((call) => call.url === `${GO_BASE}/chat/completions`);
  assert.equal(inference.length, 4, 'text + json + session + memory probes');
  const sessionIds = new Set(inference.map((call) => call.headers['x-opencode-session']));
  assert.equal(sessionIds.size, 1, 'every probe request of one test shares the same conversation id');
  const [probeSession] = [...sessionIds];
  assert.match(probeSession, /^ses_[0-9a-f]{32}$/);
  // The catalogue call inside the capability test belongs to the same probe.
  const probeCatalogue = calls.filter((call) => call.url === GO_MODELS).at(-1);
  assert.equal(probeCatalogue.headers['x-opencode-session'], probeSession);
  for (const call of calls) {
    assert.equal(call.headers.authorization, 'Bearer oc_sk_integration_secret');
    assert.equal(call.headers['user-agent'], `LiveMemory/${APP_VERSION}`);
  }
  // A probe session must never be persisted next to the key or echoed back.
  assert.equal(JSON.stringify(tested.payload).includes('oc_sk_integration_secret'), false);
});

test('retries and a restart + Resume reuse the same OpenCode session for one task', async (t) => {
  const temp = createTempDir();
  let phase = 'first';
  const calls = [];
  const servers = [];

  async function startMockServer() {
    const server = await startServer({
      auth: false,
      dataDir: temp.dir,
      port: 0,
      systemLocale: 'en',
      auto: {
        maxRetries: 2,
        fetchImpl: async (url, options) => {
          const body = JSON.parse(options.body);
          const headers = options.headers ?? {};
          const text = (body?.messages ?? []).map((message) => message.content).join('\n');
          const aggregate = text.includes('AGGREGATE MERGE CONTRACT');
          calls.push({phase, url: String(url), headers, stream: body?.stream === true, aggregate});
          if (phase === 'first' && aggregate) {
            return Response.json({error: {type: 'server_error', message: 'synthetic aggregate failure'}}, {status: 500});
          }
          if (body?.stream === true) return sseResponse(SESSION_ANSWER);
          return Response.json({
            model: body?.model,
            choices: [{message: {content: SESSION_ANSWER}, finish_reason: 'stop'}],
            usage: {prompt_tokens: 10, completion_tokens: 5}
          });
        }
      }
    });
    servers.push(server);
    return server;
  }

  t.after(async () => {
    for (const server of servers) {
      try {
        await server.close();
      } catch {
        /* already closed by the test body */
      }
    }
    temp.cleanup();
  });

  const server = await startMockServer();
  addBroadcaster(server.db);
  const session = seedSession(server.db, {
    id: 'ses_opencode_resume',
    messageCount: 40,
    viewerCount: 2,
    startedAt: T0,
    // Enough content for several session batches plus one aggregate request.
    messagePadding: 3000
  });
  const config = seedConfig(server, {regionId: 'go'});

  await server.analysisRunner.start({
    sessionId: session.id,
    locale: 'en',
    mode: 'session',
    configId: config.id,
    consent: true
  });
  const failed = await waitFor(server.analysisRunner, session.id, ['complete', 'needs_action', 'failed', 'partial']);
  assert.notEqual(failed.status, 'complete', 'the synthetic aggregate failure must stop the task');
  assert.equal(failed.recovery?.canResume, true, JSON.stringify(failed.recovery));

  const firstPhase = calls.filter((call) => call.phase === 'first');
  assert.ok(firstPhase.filter((call) => !call.aggregate).length >= 2, 'more than one saved batch');
  assert.ok(firstPhase.filter((call) => call.aggregate).length >= 2, 'the aggregate was retried');
  const firstSessionIds = new Set(firstPhase.map((call) => call.headers['x-opencode-session']));
  assert.equal(firstSessionIds.size, 1, 'batch, retries and aggregate share one session id');
  const [taskSession] = [...firstSessionIds];
  assert.match(taskSession, /^ses_[0-9a-f]{32}$/);
  assert.ok(firstPhase.some((call) => call.stream === true), 'analysis requests use the streaming path');

  // Restart the process against the same isolated data directory and resume.
  await server.close();
  phase = 'second';
  const restarted = await startMockServer();
  const resumed = await restarted.analysisRunner.resume(session.id, {consent: true});
  assert.ok(resumed, 'the interrupted aggregate must be resumable');
  const completed = await waitFor(restarted.analysisRunner, session.id, ['complete', 'failed', 'needs_action', 'partial']);
  assert.equal(completed.status, 'complete', JSON.stringify(completed.error));

  const secondPhase = calls.filter((call) => call.phase === 'second');
  assert.ok(secondPhase.length >= 1, 'Resume must send the unfinished request again');
  assert.ok(secondPhase.every((call) => call.aggregate), 'only the missing aggregate is requested');
  for (const call of secondPhase) {
    assert.equal(
      call.headers['x-opencode-session'],
      taskSession,
      'a resumed task must reuse the session id stored in its job identity'
    );
  }
});

test('two concurrent OpenCode analyses never share a session id', async (t) => {
  const temp = createTempDir();
  const calls = [];
  const server = await startServer({
    auth: false,
    dataDir: temp.dir,
    port: 0,
    systemLocale: 'en',
    auto: {
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        calls.push({url: String(url), headers: options.headers ?? {}});
        if (body?.stream === true) return sseResponse(SESSION_ANSWER);
        return Response.json({
          model: body?.model,
          choices: [{message: {content: SESSION_ANSWER}, finish_reason: 'stop'}],
          usage: {prompt_tokens: 10, completion_tokens: 5}
        });
      }
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });

  addBroadcaster(server.db);
  const sessions = ['ses_opencode_parallel_a', 'ses_opencode_parallel_b'].map((id) => seedSession(server.db, {
    id,
    messageCount: 40,
    viewerCount: 2,
    startedAt: T0,
    messagePadding: 3000
  }));
  const config = seedConfig(server, {regionId: 'payg'});
  assert.equal(config.baseUrl, PAYG_BASE);

  await Promise.all(sessions.map((session) => server.analysisRunner.start({
    sessionId: session.id,
    locale: 'en',
    mode: 'session',
    configId: config.id,
    consent: true
  })));
  for (const session of sessions) {
    const status = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial']);
    assert.equal(status.status, 'complete', JSON.stringify(status.error));
  }

  const inference = calls.filter((call) => call.url === `${PAYG_BASE}/chat/completions`);
  assert.ok(inference.length >= 4);
  const ids = new Set(inference.map((call) => call.headers['x-opencode-session']));
  assert.equal(ids.size, 2, 'one conversation id per task, never shared across parallel analyses');
  for (const id of ids) assert.match(id, /^ses_[0-9a-f]{32}$/);
});
