import test from 'node:test';
import assert from 'node:assert/strict';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {startServer} from '../../src/server/index.mjs';
import {addBroadcaster, seedSession, T0} from '../helpers/ai-fixtures.mjs';
import {listJobMemoryViewers} from '../../src/storage/repositories/ai-jobs.mjs';

function iso(ms) {
  return new Date(ms).toISOString();
}

function sessionAnswer(summary = 'Streamed session summary.') {
  return JSON.stringify({
    session_topics: {
      summary,
      topics: [{
        title: 'Streamed topic',
        started_at: iso(T0 + 1000),
        ended_at: iso(T0 + 2000),
        summary: 'A streamed topic.',
        key_points: ['stream'],
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

function sseResponse(chunks, {close = true} = {}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (close) controller.close();
    }
  });
  return new Response(body, {headers: {'content-type': 'text/event-stream'}});
}

function openAiSse(text, {finish = true, usage = true, done = true} = {}) {
  const pieces = [text.slice(0, Math.max(1, Math.floor(text.length / 3))),
    text.slice(Math.max(1, Math.floor(text.length / 3)), Math.max(2, Math.floor((text.length * 2) / 3))),
    text.slice(Math.max(2, Math.floor((text.length * 2) / 3)))];
  const chunks = pieces.map((piece) => `data: ${JSON.stringify({
    choices: [{delta: {content: piece}, finish_reason: null}]
  })}\n\n`);
  if (finish) {
    chunks.push(`data: ${JSON.stringify({choices: [{delta: {}, finish_reason: 'stop'}]})}\n\n`);
  }
  if (usage) {
    chunks.push(`data: ${JSON.stringify({usage: {prompt_tokens: 120, completion_tokens: 30, total_tokens: 150}})}\n\n`);
  }
  if (done) chunks.push('data: [DONE]\n\n');
  return {chunks};
}

function paidConfig(server, overrides = {}) {
  const config = server.providerConfigStore.create({
    providerId: 'custom',
    regionId: 'custom',
    baseUrl: 'https://example.com/v1',
    modelId: 'paid-model',
    apiKey: 'test-key',
    pricingStatus: 'paid',
    pricing: {inputPerMillion: 1, outputPerMillion: 2, currency: 'USD'},
    ...overrides
  });
  server.providerConfigStore.recordTest(config.id, {
    status: 'passed',
    capabilities: {network: true, auth: true, text: true, json: true, session: true, memory: true},
    stages: {}
  });
  return config;
}

async function waitFor(runner, sessionId, predicate, {timeoutMs = 8000} = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = runner.getStatus(sessionId);
    if (predicate(status)) return status;
    if (Date.now() > deadline) throw new Error(`timeout: ${JSON.stringify(status)}`);
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

test('streaming responses are buffered, validated and imported as one answer', async (t) => {
  await withServer(t, async (server) => {
    const session = seedSession(server.db, {id: 'ses_stream_ok', messageCount: 6, viewerCount: 2, startedAt: T0});
    const calls = [];
    server.analysisRunner.fetchImpl = async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      assert.equal(body.stream, true, 'the runner should prefer streaming');
      const {chunks} = openAiSse(sessionAnswer());
      return sseResponse(chunks);
    };
    const config = paidConfig(server);
    await server.analysisRunner.start({
      sessionId: session.id,
      locale: 'en',
      mode: 'session',
      configId: config.id,
      consent: true,
      confirmBilling: true
    });
    const status = await waitFor(server.analysisRunner, session.id, (value) => value.status === 'complete');
    assert.equal(status.sessionReportDone, true);
    assert.equal(status.lastRequest.mode, 'streaming');
    assert.equal(status.lastRequest.receivedHeaders, true);
    assert.equal(status.lastRequest.receivedOutput, true);
    assert.equal(status.lastRequest.usageKnown, true);
    assert.equal(status.attemptStats.succeeded, 1);
    assert.equal(status.attemptStats.failed, 0);
    assert.equal(status.requestMode, 'streaming');
    assert.equal(calls.length, 1);
    assert.equal(server.analysisRunner.state.getProviderMode(config.id), 'streaming');

    const report = await fetch(`${server.url}api/ai/sessions/${encodeURIComponent(session.id)}/report`)
      .then((response) => response.json());
    assert.equal(report.mode, 'single');
    assert.equal(report.report.summary, 'Streamed session summary.');
  });
});

test('streaming progress reports headers and first model output while the request is still running', async (t) => {
  await withServer(t, async (server) => {
    const session = seedSession(server.db, {id: 'ses_stream_progress', messageCount: 6, viewerCount: 2, startedAt: T0});
    const encoder = new TextEncoder();
    const answer = sessionAnswer('Progress summary.');
    server.analysisRunner.fetchImpl = async () => new Response(new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          choices: [{delta: {content: answer.slice(0, 30)}, finish_reason: null}]
        })}\n\n`));
        // Give the UI polling a chance to observe "output received" before the
        // stream finishes.
        await new Promise((resolve) => setTimeout(resolve, 350));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          choices: [{delta: {content: answer.slice(30)}, finish_reason: 'stop'}]
        })}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    }), {headers: {'content-type': 'text/event-stream'}});
    const config = paidConfig(server);
    await server.analysisRunner.start({
      sessionId: session.id,
      locale: 'en',
      mode: 'session',
      configId: config.id,
      consent: true,
      confirmBilling: true
    });
    let observed = null;
    for (let index = 0; index < 100; index += 1) {
      const status = server.analysisRunner.getStatus(session.id);
      if (status.currentRequest?.receivedOutput === true) {
        observed = status.currentRequest;
        break;
      }
      if (status.status === 'complete') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(observed, 'the running request must expose receivedOutput before completion');
    assert.equal(observed.receivedHeaders, true);
    assert.equal(observed.mode, 'streaming');
    assert.ok(observed.firstTokenAt >= observed.startedAt);
    const done = await waitFor(server.analysisRunner, session.id, (value) => value.status === 'complete');
    assert.equal(done.status, 'complete');
  });
});

test('a stream that stops before the finish event fails once and saves nothing', async (t) => {
  await withServer(t, async (server) => {
    const session = seedSession(server.db, {id: 'ses_stream_cut', messageCount: 6, viewerCount: 2, startedAt: T0});
    let calls = 0;
    server.analysisRunner.fetchImpl = async () => {
      calls += 1;
      const partial = sessionAnswer().slice(0, 40);
      const {chunks} = openAiSse(partial, {finish: false, usage: false, done: false});
      return sseResponse(chunks);
    };
    const config = paidConfig(server);
    await server.analysisRunner.start({
      sessionId: session.id,
      locale: 'en',
      mode: 'session',
      configId: config.id,
      consent: true,
      confirmBilling: true
    });
    const status = await waitFor(server.analysisRunner, session.id, (value) => value.status === 'failed');
    assert.equal(status.error.code, 'PROVIDER_STREAM_INTERRUPTED');
    assert.equal(status.error.kind, 'stream_interrupted');
    assert.equal(status.error.receivedOutput, true, JSON.stringify(status.error));
    assert.equal(status.attemptStats.total, 1, 'a broken stream must not be silently re-sent');
    assert.equal(status.attemptStats.retried, 0);
    assert.equal(calls, 1);
    assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM ai_results').get().n, 0);
  });
});

test('a request that times out is reported as a timeout and is not automatically re-sent', async (t) => {
  await withServer(t, async (server) => {
    const session = seedSession(server.db, {id: 'ses_timeout_once', messageCount: 6, viewerCount: 2, startedAt: T0});
    let calls = 0;
    server.analysisRunner.fetchImpl = async () => {
      calls += 1;
      throw Object.assign(new Error('The operation was aborted due to timeout'), {name: 'TimeoutError'});
    };
    const config = paidConfig(server);
    const before = Date.now();
    await server.analysisRunner.start({
      sessionId: session.id,
      locale: 'en',
      mode: 'session',
      configId: config.id,
      consent: true,
      confirmBilling: true
    });
    const status = await waitFor(server.analysisRunner, session.id, (value) => value.status === 'needs_action');
    const elapsed = Date.now() - before;
    assert.equal(status.error.code, 'PROVIDER_TIMEOUT');
    assert.equal(status.error.kind, 'timeout');
    assert.equal(status.canResume, true);
    assert.equal(status.error.receivedHeaders, false);
    assert.equal(status.attemptStats.total, 1);
    assert.equal(status.attemptStats.timedOut, 1);
    assert.equal(status.attemptStats.retried, 0);
    assert.equal(status.attemptStats.usageUnknown, 1);
    assert.equal(status.usageKnown, false);
    assert.equal(calls, 1);
    assert.ok(elapsed < 3000, `must not repeat 180s-style waits (took ${elapsed}ms)`);
    assert.equal(status.lastRequest.outcome, 'timeout');
  });
});

test('a user cancel aborts the request once, never retries and keeps the canceled state', async (t) => {
  await withServer(t, async (server) => {
    const session = seedSession(server.db, {id: 'ses_cancel_once', messageCount: 6, viewerCount: 2, startedAt: T0});
    let calls = 0;
    server.analysisRunner.fetchImpl = async (url, options) => {
      calls += 1;
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), {name: 'AbortError'}));
        }, {once: true});
      });
    };
    const config = paidConfig(server);
    await server.analysisRunner.start({
      sessionId: session.id,
      locale: 'en',
      mode: 'session',
      configId: config.id,
      consent: true,
      confirmBilling: true
    });
    await waitFor(server.analysisRunner, session.id, (value) => Boolean(value.currentRequest));
    server.analysisRunner.cancel(session.id);
    const status = await waitFor(server.analysisRunner, session.id, (value) => value.status === 'canceled');
    assert.equal(status.error, null);
    assert.equal(status.attemptStats.canceled, 1);
    assert.equal(status.attemptStats.retried, 0);
    assert.equal(calls, 1);
    assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM ai_results').get().n, 0);
  });
});

test('a provider that rejects streaming falls back once to non-streaming and still completes', async (t) => {
  await withServer(t, async (server) => {
    const session = seedSession(server.db, {id: 'ses_stream_fallback', messageCount: 6, viewerCount: 2, startedAt: T0});
    let streamRequests = 0;
    let jsonRequests = 0;
    server.analysisRunner.fetchImpl = async (url, options) => {
      const body = JSON.parse(options.body);
      if (body.stream === true) {
        streamRequests += 1;
        return Response.json({error: {message: 'streaming is not supported by this model'}}, {status: 400});
      }
      jsonRequests += 1;
      return Response.json({
        model: body.model,
        choices: [{message: {content: sessionAnswer('Fallback summary.')}, finish_reason: 'stop'}],
        usage: {prompt_tokens: 100, completion_tokens: 20, total_tokens: 120}
      });
    };
    const config = paidConfig(server);
    await server.analysisRunner.start({
      sessionId: session.id,
      locale: 'en',
      mode: 'session',
      configId: config.id,
      consent: true,
      confirmBilling: true
    });
    const status = await waitFor(server.analysisRunner, session.id, (value) => value.status === 'complete');
    assert.equal(status.sessionReportDone, true);
    assert.equal(status.lastRequest.mode, 'non_streaming');
    assert.equal(streamRequests, 1, 'streaming is probed only once per task');
    assert.equal(jsonRequests, 1);
    assert.equal(server.analysisRunner.state.getProviderMode(config.id), 'non_streaming');
  });
});

test('an incomplete JSON answer gets one repair request, never an unbounded retry loop', async (t) => {
  await withServer(t, async (server) => {
    const session = seedSession(server.db, {id: 'ses_incomplete_json', messageCount: 6, viewerCount: 2, startedAt: T0});
    let calls = 0;
    server.analysisRunner.fetchImpl = async (url, options) => {
      calls += 1;
      const body = JSON.parse(options.body);
      return Response.json({
        model: body.model,
        choices: [{message: {content: '{"session_topics":'}, finish_reason: 'stop'}],
        usage: {prompt_tokens: 10, completion_tokens: 5, total_tokens: 15}
      });
    };
    const config = paidConfig(server);
    await server.analysisRunner.start({
      sessionId: session.id,
      locale: 'en',
      mode: 'session',
      configId: config.id,
      consent: true,
      confirmBilling: true
    });
    const status = await waitFor(server.analysisRunner, session.id, (value) => value.status === 'failed');
    assert.equal(status.error.code, 'AUTO_SCHEMA_INVALID');
    assert.equal(calls, 2, 'one original answer plus one bounded repair');
    assert.equal(status.attemptStats.total, 2);
    assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM ai_results').get().n, 0);
  });
});

test('streaming works for the Anthropic Messages protocol too', async (t) => {
  await withServer(t, async (server) => {
    const session = seedSession(server.db, {id: 'ses_anthropic_stream', messageCount: 6, viewerCount: 2, startedAt: T0});
    const answer = sessionAnswer('Anthropic streamed summary.');
    server.analysisRunner.fetchImpl = async (url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.stream, true);
      const chunks = [
        `event: message_start\ndata: ${JSON.stringify({type: 'message_start', message: {model: 'claude-test', usage: {input_tokens: 30}}})}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({type: 'content_block_delta', delta: {type: 'text_delta', text: answer.slice(0, 20)}})}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({type: 'content_block_delta', delta: {type: 'text_delta', text: answer.slice(20)}})}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({type: 'message_delta', delta: {stop_reason: 'end_turn'}, usage: {output_tokens: 40}})}\n\n`,
        `event: message_stop\ndata: ${JSON.stringify({type: 'message_stop'})}\n\n`
      ];
      return sseResponse(chunks);
    };
    const config = paidConfig(server, {
      providerId: 'anthropic',
      regionId: 'global',
      baseUrl: 'https://api.anthropic.com/v1',
      modelId: 'claude-test',
      apiKey: 'test-key'
    });
    await server.analysisRunner.start({
      sessionId: session.id,
      locale: 'en',
      mode: 'session',
      configId: config.id,
      consent: true,
      confirmBilling: true
    });
    const status = await waitFor(server.analysisRunner, session.id, (value) => value.status === 'complete');
    assert.equal(status.lastRequest.mode, 'streaming');
    assert.equal(status.usage.inputTokens, 30);
    assert.equal(status.usage.outputTokens, 40);
    const report = await fetch(`${server.url}api/ai/sessions/${encodeURIComponent(session.id)}/report`)
      .then((response) => response.json());
    assert.equal(report.report.summary, 'Anthropic streamed summary.');
  });
});

test('an in-flight request times out on its own clock and becomes resumable, not task-aborted', async (t) => {
  await withServer(t, async (server) => {
    const session = seedSession(server.db, {id: 'ses_task_budget', messageCount: 6, viewerCount: 2, startedAt: T0});
    let fakeNow = Date.now();
    server.analysisRunner.now = () => fakeNow;
    server.analysisRunner.fetchImpl = async () => {
      // The task clock crosses 60 minutes while this request is already in
      // flight. It must be bounded by its own timeout, not by a task budget.
      fakeNow += 61 * 60 * 1000;
      throw Object.assign(new Error('timeout'), {name: 'TimeoutError'});
    };
    const config = paidConfig(server);
    await server.analysisRunner.start({
      sessionId: session.id,
      locale: 'en',
      mode: 'session',
      configId: config.id,
      consent: true,
      confirmBilling: true
    });
    const status = await waitFor(server.analysisRunner, session.id, (value) => value.status === 'needs_action');
    assert.equal(status.error.code, 'PROVIDER_TIMEOUT', 'the in-flight request keeps its own timeout');
    assert.equal(status.canResume, true);
    assert.equal(status.attemptStats.total, 1);
    assert.equal(status.attemptStats.timedOut, 1);
    assert.equal(status.taskElapsedMs >= 60 * 60 * 1000, true);
  });
});

test('429 attempts are counted separately from successes and timeouts', async (t) => {
  await withServer(t, async (server) => {
    const session = seedSession(server.db, {id: 'ses_429_stats', messageCount: 6, viewerCount: 2, startedAt: T0});
    let calls = 0;
    server.analysisRunner.fetchImpl = async (url, options) => {
      calls += 1;
      if (calls <= 2) {
        return Response.json({error: {message: 'slow down'}}, {
          status: 429,
          headers: {'retry-after': '0'}
        });
      }
      const body = JSON.parse(options.body);
      return Response.json({
        model: body.model,
        choices: [{message: {content: sessionAnswer('After retry summary.')}, finish_reason: 'stop'}],
        usage: {prompt_tokens: 10, completion_tokens: 5, total_tokens: 15}
      });
    };
    const config = paidConfig(server);
    await server.analysisRunner.start({
      sessionId: session.id,
      locale: 'en',
      mode: 'session',
      configId: config.id,
      consent: true,
      confirmBilling: true
    });
    const status = await waitFor(server.analysisRunner, session.id, (value) => value.status === 'complete');
    assert.equal(calls, 3);
    assert.equal(status.attemptStats.total, 3);
    assert.equal(status.attemptStats.succeeded, 1);
    assert.equal(status.attemptStats.failed, 2);
    assert.equal(status.attemptStats.retried, 2);
    assert.equal(status.attemptStats.timedOut, 0);
    assert.equal(status.requestStats.rateLimited, 2);
    assert.equal(status.sessionReportDone, true);
  });
});

test('a small memory budget still assigns every viewer to exactly one batch and covers them all', async (t) => {
  await withServer(t, async (server) => {
    const session = seedSession(server.db, {id: 'ses_memory_budget', messageCount: 160, viewerCount: 8, startedAt: T0});
    server.analysisRunner.fetchImpl = async (url, options) => {
      const body = JSON.parse(options.body);
      const text = body.messages.map((message) => message.content).join('\n');
      if (text.includes('AUTOMATIC MEMORY CONTRACT')) {
        const match = /Cover exactly these refs, once each: ([0-9, ]+)/.exec(text);
        const refs = (match?.[1] ?? '').split(',').map((value) => Number(value.trim())).filter(Boolean);
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
          usage: {prompt_tokens: 80, completion_tokens: 20, total_tokens: 100}
        });
      }
      return Response.json({
        model: body.model,
        choices: [{message: {content: sessionAnswer()}, finish_reason: 'stop'}],
        usage: {prompt_tokens: 100, completion_tokens: 20, total_tokens: 120}
      });
    };
    const config = paidConfig(server, {batchInputTokens: 2000, contextLength: 32000});
    await server.analysisRunner.start({
      sessionId: session.id,
      locale: 'en',
      mode: 'memory',
      configId: config.id,
      consent: true,
      confirmBilling: true,
      optInMemory: true
    });
    const status = await waitFor(server.analysisRunner, session.id, (value) => value.status === 'complete');
    assert.ok(status.memoryJob.batchTotal >= 1);
    assert.equal(status.memoryJob.memoryCoverage.total, 8);
    assert.equal(status.memoryJob.memoryCoverage.covered, 8);
    const assigned = listJobMemoryViewers(server.db, status.memoryJobId);
    assert.equal(assigned.length, 8);
    assert.equal(new Set(assigned.map((row) => row.viewerId)).size, 8, 'no viewer may be assigned twice');
    assert.equal(assigned.every((row) => row.status === 'no_semantics'), true);
  });
});
