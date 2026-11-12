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
      summary: 'Budget test batch summary.',
      topics: [{
        title: 'Budget topic',
        started_at: iso(T0 + 1000),
        ended_at: iso(T0 + 2000),
        summary: 'A topic.',
        key_points: ['budget'],
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
  return JSON.stringify({
    session_topics: {
      summary: 'Merged budget report.',
      topics: [{
        title: 'Merged topic',
        started_at: iso(T0 + 1000),
        ended_at: iso(T0 + 2000),
        summary: 'Merged.',
        key_points: ['merged'],
        confidence: 0.7,
        evidence: 'observed',
        message_refs: [{batch: 1, seq: 1}, {batch: Math.max(1, total), seq: 1}]
      }],
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
  const server = await startServer({dataDir: temp.dir, port: 0, systemLocale: 'en'});
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  return fn(server);
}

/** Parse the batch metadata that the runner embeds in the prompt. */
function batchMeta(text) {
  const match = /"batch":\{"index":(\d+),"total":(\d+)/.exec(text);
  return match ? {index: Number(match[1]), total: Number(match[2])} : null;
}

function aggregateTotal(text) {
  const match = /batches: (\d+)/.exec(text);
  return match ? Number(match[1]) : 1;
}

test('a task still runs normally after 20 minutes', async (t) => {
  await withServer(t, async (server) => {
    const session = seedSession(server.db, {id: 'ses_budget_20m', messageCount: 6, viewerCount: 2, startedAt: T0});
    let fakeNow = Date.now();
    server.analysisRunner.now = () => fakeNow;
    server.analysisRunner.fetchImpl = async () => {
      fakeNow += 21 * MINUTE;
      return sse(sessionAnswer());
    };
    const config = paidConfig(server);
    await server.analysisRunner.start({
      sessionId: session.id, locale: 'en', mode: 'session', configId: config.id,
      consent: true, confirmBilling: true
    });
    const status = await waitFor(server.analysisRunner, session.id, (value) => value.status === 'complete');
    assert.equal(status.error, null);
    assert.ok(status.taskElapsedMs >= 20 * MINUTE);
    assert.notEqual(status.taskBudgetState, 'paused');
    assert.equal(status.sessionReportDone, true);
  });
});

test('45 minutes is a visible soft warning, not a stop', async (t) => {
  await withServer(t, async (server) => {
    const session = seedSession(server.db, {id: 'ses_budget_45m', messageCount: 6, viewerCount: 2, startedAt: T0});
    let fakeNow = Date.now();
    server.analysisRunner.now = () => fakeNow;
    server.analysisRunner.fetchImpl = async () => {
      fakeNow += 46 * MINUTE;
      return sse(sessionAnswer());
    };
    const config = paidConfig(server);
    await server.analysisRunner.start({
      sessionId: session.id, locale: 'en', mode: 'session', configId: config.id,
      consent: true, confirmBilling: true
    });
    const status = await waitFor(server.analysisRunner, session.id, (value) => value.status === 'complete');
    assert.equal(status.sessionReportDone, true);
    assert.equal(status.taskBudgetState, 'soft');
    assert.equal(status.taskSoftBudgetReached, true);
    assert.equal(status.taskBudgetReached, false);
  });
});

test('the hard deadline stops new batches, lets the in-flight batch save, and resume skips it', async (t) => {
  await withServer(t, async (server) => {
    const session = seedSession(server.db, {id: 'ses_budget_pause', messageCount: 420, viewerCount: 3, startedAt: T0});
    let fakeNow = Date.now();
    server.analysisRunner.now = () => fakeNow;
    const calls = [];
    let advanceOnce = true;
    server.analysisRunner.fetchImpl = async (url, options) => {
      const body = JSON.parse(options.body);
      const text = body.messages.map((message) => message.content).join('\n');
      if (text.includes('AGGREGATE MERGE CONTRACT')) {
        calls.push({kind: 'aggregate'});
        return sse(aggregateAnswer(aggregateTotal(text)));
      }
      const meta = batchMeta(text);
      calls.push({kind: 'batch', index: meta?.index ?? null});
      if (advanceOnce) {
        advanceOnce = false;
        // This in-flight batch started before the deadline; the clock passes
        // 60 minutes while it is still running. It must finish and save.
        fakeNow += 61 * MINUTE;
      }
      return sse(sessionAnswer());
    };
    const config = paidConfig(server, {batchInputTokens: 2000, contextLength: 32000, concurrency: 1});
    await server.analysisRunner.start({
      sessionId: session.id, locale: 'en', mode: 'session', configId: config.id,
      consent: true, confirmBilling: true
    });
    const paused = await waitFor(server.analysisRunner, session.id, (value) => value.status === 'paused');
    assert.equal(paused.error.code, 'ANALYSIS_TASK_PAUSED');
    assert.equal(paused.taskBudgetState, 'paused');
    assert.equal(paused.canResume, true);
    assert.ok(paused.saved.sessionBatches >= 1);
    assert.ok(paused.pendingSessionBatches > 0);
    assert.equal(calls.filter((call) => call.kind === 'batch').length, 1, 'only the in-flight batch was sent');

    const batchCallsBeforeResume = calls.filter((call) => call.kind === 'batch').length;
    await server.analysisRunner.resume(session.id, {consent: true, confirmBilling: true});
    const completed = await waitFor(server.analysisRunner, session.id, (value) => value.status === 'complete');
    assert.equal(completed.sessionReportDone, true);
    const batchCallsAfterResume = calls.filter((call) => call.kind === 'batch').length;
    assert.ok(batchCallsAfterResume > batchCallsBeforeResume, 'resume runs the missing batches');
    assert.equal(
      calls.filter((call) => call.kind === 'batch' && call.index === 1).length,
      1,
      'the saved batch is never re-sent'
    );
  });
});

test('the final aggregate is still allowed when the deadline is reached at 7/7 batches', async (t) => {
  await withServer(t, async (server) => {
    const session = seedSession(server.db, {id: 'ses_budget_aggregate', messageCount: 420, viewerCount: 2, startedAt: T0});
    let fakeNow = Date.now();
    server.analysisRunner.now = () => fakeNow;
    const calls = [];
    server.analysisRunner.fetchImpl = async (url, options) => {
      const body = JSON.parse(options.body);
      const text = body.messages.map((message) => message.content).join('\n');
      if (text.includes('AGGREGATE MERGE CONTRACT')) {
        calls.push({kind: 'aggregate'});
        return sse(aggregateAnswer(aggregateTotal(text)));
      }
      const meta = batchMeta(text);
      calls.push({kind: 'batch', index: meta?.index ?? null});
      if (meta && meta.index === meta.total) {
        // All batches are done; the clock crosses the hard deadline immediately
        // before the final merge. The merge must not be discarded.
        fakeNow += 61 * MINUTE;
      }
      return sse(sessionAnswer());
    };
    const config = paidConfig(server, {batchInputTokens: 2000, contextLength: 32000, concurrency: 1});
    await server.analysisRunner.start({
      sessionId: session.id, locale: 'en', mode: 'session', configId: config.id,
      consent: true, confirmBilling: true
    });
    const status = await waitFor(server.analysisRunner, session.id, (value) => value.status === 'complete');
    assert.equal(status.sessionAggregateRequired, true);
    assert.equal(status.sessionAggregateDone, true);
    assert.equal(calls.filter((call) => call.kind === 'aggregate').length, 1);
    assert.equal(status.status, 'complete');
  });
});

test('a finished 7/7 session resumes directly into the final aggregate without repeating batches', async (t) => {
  await withServer(t, async (server) => {
    const session = seedSession(server.db, {id: 'ses_budget_resume_aggregate', messageCount: 420, viewerCount: 2, startedAt: T0});
    let fakeNow = Date.now();
    server.analysisRunner.now = () => fakeNow;
    let failAggregate = true;
    const calls = [];
    server.analysisRunner.fetchImpl = async (url, options) => {
      const body = JSON.parse(options.body);
      const text = body.messages.map((message) => message.content).join('\n');
      if (text.includes('AGGREGATE MERGE CONTRACT')) {
        calls.push({kind: 'aggregate'});
        if (failAggregate) {
          failAggregate = false;
          throw Object.assign(new Error('synthetic aggregate timeout'), {name: 'TimeoutError'});
        }
        return sse(aggregateAnswer(aggregateTotal(text)));
      }
      const meta = batchMeta(text);
      calls.push({kind: 'batch', index: meta?.index ?? null});
      return sse(sessionAnswer());
    };
    const config = paidConfig(server, {batchInputTokens: 2000, contextLength: 32000, concurrency: 1});
    await server.analysisRunner.start({
      sessionId: session.id, locale: 'en', mode: 'session', configId: config.id,
      consent: true, confirmBilling: true
    });
    const failed = await waitFor(server.analysisRunner, session.id, (value) => value.status === 'failed');
    assert.equal(failed.error.code, 'PROVIDER_TIMEOUT');
    assert.equal(failed.sessionAggregateRequired, true);
    assert.equal(failed.sessionAggregateDone, false);
    assert.equal(failed.canResume, true);
    const batchesBefore = calls.filter((call) => call.kind === 'batch').length;
    const aggregatesBefore = calls.filter((call) => call.kind === 'aggregate').length;

    await server.analysisRunner.resume(session.id, {consent: true, confirmBilling: true});
    const completed = await waitFor(server.analysisRunner, session.id, (value) => value.status === 'complete');
    assert.equal(completed.sessionAggregateDone, true);
    assert.equal(calls.filter((call) => call.kind === 'batch').length, batchesBefore, 'no batch is re-sent');
    assert.equal(calls.filter((call) => call.kind === 'aggregate').length, aggregatesBefore + 1);
  });
});
