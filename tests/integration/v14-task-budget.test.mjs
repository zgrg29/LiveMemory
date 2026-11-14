import test from 'node:test';
import assert from 'node:assert/strict';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {startServer} from '../../src/server/index.mjs';
import {addBroadcaster, seedSession, T0} from '../helpers/ai-fixtures.mjs';

const MINUTE = 60 * 1000;

function iso(ms) {
  return new Date(ms).toISOString();
}

function sessionAnswer() {
  return JSON.stringify({
    session_topics: {
      summary: 'Long-running budget test.',
      topics: [{
        title: 'Long topic',
        started_at: iso(T0 + 1000),
        ended_at: iso(T0 + 2000),
        summary: 'A topic.',
        key_points: ['long'],
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

function aggregateAnswer(total) {
  const topics = [];
  const topicCount = Math.min(24, Math.max(1, Math.ceil(total / 4)));
  const chunkSize = Math.max(1, Math.ceil(total / topicCount));
  for (let batch = 1; batch <= total; batch += chunkSize) {
    const refs = [];
    for (let index = batch; index < Math.min(total + 1, batch + chunkSize); index += 1) {
      refs.push({batch: index, seq: 1});
    }
    topics.push({
      title: `Merged topic ${batch}`,
      started_at: iso(T0 + 1000),
      ended_at: iso(T0 + 2000),
      summary: 'Merged.',
      key_points: ['merged'],
      confidence: 0.7,
      evidence: 'observed',
      message_refs: refs
    });
  }
  return JSON.stringify({
    covered_batches: Array.from({length: total}, (_, index) => index + 1),
    session_topics: {
      summary: 'Merged long report.',
      topics,
      sentiment: [],
      disputes: [],
      highlights: []
    }
  });
}

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  });
  return new Response(body, {headers: {'content-type': 'text/event-stream'}});
}

function sse(text) {
  const third = Math.max(1, Math.floor(text.length / 3));
  return sseResponse([
    `data: ${JSON.stringify({choices: [{delta: {content: text.slice(0, third)}, finish_reason: null}]})}\n\n`,
    `data: ${JSON.stringify({choices: [{delta: {content: text.slice(third, third * 2)}, finish_reason: null}]})}\n\n`,
    `data: ${JSON.stringify({choices: [{delta: {content: text.slice(third * 2)}, finish_reason: null}]})}\n\n`,
    `data: ${JSON.stringify({choices: [{delta: {}, finish_reason: 'stop'}]})}\n\n`,
    `data: ${JSON.stringify({usage: {prompt_tokens: 100, completion_tokens: 20, total_tokens: 120}})}\n\n`,
    'data: [DONE]\n\n'
  ]);
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

async function waitFor(runner, sessionId, predicate, {timeoutMs = 15000} = {}) {
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
  const server = await startServer({auth: false,dataDir: temp.dir, port: 0, systemLocale: 'en'});
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  return fn(server);
}

function batchMeta(text) {
  const match = /"batch":\{"index":(\d+),"total":(\d+)/.exec(text);
  return match ? {index: Number(match[1]), total: Number(match[2])} : null;
}

function aggregateTotal(text) {
  const match = /batches: (\d+)/.exec(text);
  return match ? Number(match[1]) : 1;
}

test('no task time limit: a task still completes after 20 and 60 minutes', async (t) => {
  for (const advanceMinutes of [21, 61]) {
    await withServer(t, async (server) => {
      const session = seedSession(server.db, {
        id: `ses_no_time_limit_${advanceMinutes}`,
        messageCount: 6,
        viewerCount: 2,
        startedAt: T0
      });
      let fakeNow = Date.now();
      server.analysisRunner.now = () => fakeNow;
      server.analysisRunner.fetchImpl = async () => {
        fakeNow += advanceMinutes * MINUTE;
        return sse(sessionAnswer());
      };
      const config = paidConfig(server);
      await server.analysisRunner.start({
        sessionId: session.id, locale: 'en', mode: 'session', configId: config.id, consent: true
      });
      const status = await waitFor(server.analysisRunner, session.id, (value) => value.status === 'complete');
      assert.equal(status.error, null);
      assert.ok(status.taskElapsedMs >= advanceMinutes * MINUTE);
      assert.equal(status.sessionReportDone, true);
    });
  }
});

test('a request timeout preserves progress and resumes the unfinished aggregate only', async (t) => {
  await withServer(t, async (server) => {
    const session = seedSession(server.db, {id: 'ses_timeout_resume', messageCount: 420, viewerCount: 2, startedAt: T0});
    let failAggregate = true;
    const calls = [];
    server.analysisRunner.fetchImpl = async (url, options) => {
      const body = JSON.parse(options.body);
      const text = body.messages.map((message) => message.content).join('\n');
      if (text.includes('AGGREGATE MERGE CONTRACT')) {
        calls.push({kind: 'aggregate'});
        if (failAggregate) {
          failAggregate = false;
          throw Object.assign(new Error('synthetic timeout'), {name: 'TimeoutError'});
        }
        return sse(aggregateAnswer(aggregateTotal(text)));
      }
      const meta = batchMeta(text);
      calls.push({kind: 'batch', index: meta?.index ?? null});
      return sse(sessionAnswer());
    };
    const config = paidConfig(server, {batchInputTokens: 2000, contextLength: 32000, concurrency: 1});
    await server.analysisRunner.start({
      sessionId: session.id, locale: 'en', mode: 'session', configId: config.id, consent: true
    });
    const waiting = await waitFor(server.analysisRunner, session.id, (value) => value.status === 'needs_action');
    assert.equal(waiting.error.code, 'PROVIDER_TIMEOUT');
    assert.equal(waiting.canResume, true);
    assert.ok(waiting.saved.sessionBatches > 0);
    assert.equal(waiting.sessionAggregateDone, false);
    const batchesBefore = calls.filter((call) => call.kind === 'batch').length;
    const aggregatesBefore = calls.filter((call) => call.kind === 'aggregate').length;

    await server.analysisRunner.resume(session.id, {consent: true});
    const completed = await waitFor(server.analysisRunner, session.id, (value) => value.status === 'complete');
    assert.equal(completed.sessionAggregateDone, true);
    assert.equal(calls.filter((call) => call.kind === 'batch').length, batchesBefore, 'no batch is re-sent');
    assert.equal(calls.filter((call) => call.kind === 'aggregate').length, aggregatesBefore + 1);
  });
});

test('a balance failure is needs_action and resumes from the next batch', async (t) => {
  await withServer(t, async (server) => {
    const session = seedSession(server.db, {id: 'ses_balance_needs_action', messageCount: 420, viewerCount: 2, startedAt: T0});
    let batchCalls = 0;
    let blocked = true;
    const calls = [];
    server.analysisRunner.fetchImpl = async (url, options) => {
      const body = JSON.parse(options.body);
      const text = body.messages.map((message) => message.content).join('\n');
      if (text.includes('AGGREGATE MERGE CONTRACT')) return sse(aggregateAnswer(aggregateTotal(text)));
      const meta = batchMeta(text);
      calls.push({kind: 'batch', index: meta?.index ?? null});
      batchCalls += 1;
      if (blocked && batchCalls === 2) {
        return Response.json({error: {message: 'insufficient balance'}}, {status: 402});
      }
      return sse(sessionAnswer());
    };
    const config = paidConfig(server, {batchInputTokens: 2000, contextLength: 32000, concurrency: 1});
    await server.analysisRunner.start({
      sessionId: session.id, locale: 'en', mode: 'session', configId: config.id, consent: true
    });
    const waiting = await waitFor(server.analysisRunner, session.id, (value) => value.status === 'needs_action');
    assert.equal(waiting.error.httpStatus, 402);
    assert.equal(waiting.canResume, true);
    assert.ok(waiting.saved.sessionBatches >= 1);
    blocked = false;
    await server.analysisRunner.resume(session.id, {consent: true});
    const completed = await waitFor(server.analysisRunner, session.id, (value) => value.status === 'complete');
    assert.equal(completed.sessionReportDone, true);
    const firstBatchCalls = calls.filter((call) => call.index === 1).length;
    assert.equal(firstBatchCalls, 1, 'the completed first batch is never re-sent');
  });
});

test('an auth failure is needs_action, keeps progress, and resumes after the key is fixed', async (t) => {
  await withServer(t, async (server) => {
    const session = seedSession(server.db, {id: 'ses_auth_needs_action', messageCount: 420, viewerCount: 2, startedAt: T0});
    let calls = 0;
    server.analysisRunner.fetchImpl = async (url, options) => {
      calls += 1;
      if (calls === 1) {
        return Response.json({error: {message: 'invalid key'}}, {status: 401});
      }
      const body = JSON.parse(options.body);
      const text = body.messages.map((message) => message.content).join('\n');
      if (text.includes('AGGREGATE MERGE CONTRACT')) return sse(aggregateAnswer(aggregateTotal(text)));
      return sse(sessionAnswer());
    };
    const config = paidConfig(server, {batchInputTokens: 2000, contextLength: 32000, concurrency: 1});
    await server.analysisRunner.start({
      sessionId: session.id, locale: 'en', mode: 'session', configId: config.id, consent: true
    });
    const waiting = await waitFor(server.analysisRunner, session.id, (value) => value.status === 'needs_action');
    assert.equal(waiting.error.code, 'PROVIDER_AUTH_FAILED');
    assert.equal(waiting.needsUserAction, true);
    assert.equal(waiting.canResume, true);
    assert.equal(waiting.saved.sessionBatches, 0);

    await server.analysisRunner.resume(session.id, {consent: true});
    const completed = await waitFor(server.analysisRunner, session.id, (value) => value.status === 'complete');
    assert.equal(completed.sessionReportDone, true);
  });
});
