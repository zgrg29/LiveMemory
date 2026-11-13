import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {startServer} from '../../src/server/index.mjs';
import {addBroadcaster, seedSession, T0} from '../helpers/ai-fixtures.mjs';
import {getJob} from '../../src/storage/repositories/ai-jobs.mjs';
import {latestResultForScope, listResults} from '../../src/storage/repositories/ai-results.mjs';

/**
 * The real incident shape: 18/18 session batches were imported, and the
 * whole-session aggregate returned `finish_reason=length`. The old code then
 * stopped with no report. The current contract is:
 *
 *   - one bounded retry for a truncated/invalid final answer;
 *   - if that also fails, a deterministic merge of the already validated batch
 *     results (never a batch re-run, never dropped evidence);
 *   - a hard provider error still leaves the task resumable and Continue only
 *     retries the aggregate.
 */

const iso = (ms) => new Date(ms).toISOString();

function sessionAnswer(batch = 1) {
  const from = T0 + 1000 + batch * 1000;
  return JSON.stringify({
    session_topics: {
      summary: `Batch-level summary ${batch}.`,
      topics: [{
        title: `Batch topic ${batch}`,
        started_at: iso(from),
        ended_at: iso(from + 1000),
        summary: 'A batch topic.',
        key_points: ['point'],
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

function promptBatches(text) {
  return [...String(text).matchAll(/- batch (\d+): seq (\d+)-(\d+), messages (\d+), from ([^,]+), to ([^\n]+)/g)]
    .map((match) => ({
      batch: Number(match[1]),
      from: match[5],
      to: match[6].replace(/, partial nodes.*$/, '').trim()
    }));
}

function finalAnswer(batches) {
  const topics = [];
  for (let index = 0; index < batches.length; index += 4) {
    const chunk = batches.slice(index, index + 4);
    topics.push({
      title: `Merged topic ${chunk[0].batch}-${chunk[chunk.length - 1].batch}`,
      started_at: chunk[0].from,
      ended_at: chunk[chunk.length - 1].to,
      summary: 'One merged topic.',
      key_points: ['merged'],
      confidence: 0.7,
      evidence: 'observed',
      message_refs: chunk.map((entry) => ({batch: entry.batch, seq: 1}))
    });
  }
  return JSON.stringify({
    covered_batches: batches.map((entry) => entry.batch),
    session_topics: {
      summary: 'Merged whole-session summary.',
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

function sse(text, finishReason = 'stop') {
  const third = Math.max(1, Math.floor(text.length / 3));
  return sseResponse([
    `data: ${JSON.stringify({choices: [{delta: {content: text.slice(0, third)}, finish_reason: null}]})}\n\n`,
    `data: ${JSON.stringify({choices: [{delta: {content: text.slice(third, third * 2)}, finish_reason: null}]})}\n\n`,
    `data: ${JSON.stringify({choices: [{delta: {content: text.slice(third * 2)}, finish_reason: null}]})}\n\n`,
    `data: ${JSON.stringify({choices: [{delta: {}, finish_reason: finishReason}]})}\n\n`,
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

async function waitFor(runner, sessionId, predicate, {timeoutMs = 60000} = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = runner.getStatus(sessionId);
    if (predicate(status)) return status;
    if (Date.now() > deadline) throw new Error(`timeout: ${JSON.stringify(status)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function batchCalls(calls) {
  return calls.filter((call) => call.kind === 'batch');
}

function aggregateCalls(calls) {
  return calls.filter((call) => call.kind === 'aggregate');
}

function savedBatchRows(db, jobId) {
  return listResults(db, jobId)
    .filter((row) => row.batchIndex !== null)
    .map((row) => ({
      id: row.id,
      scopeKey: row.scopeKey,
      batchIndex: row.batchIndex,
      resultVersion: row.resultVersion,
      checksum: row.checksum,
      importedAt: row.importedAt
    }))
    .sort((a, b) => a.batchIndex - b.batchIndex);
}

function installMock(server, state, calls) {
  server.analysisRunner.fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    const text = body.messages.map((message) => message.content).join('\n');
    if (text.includes('AGGREGATE MERGE CONTRACT')) {
      const batches = promptBatches(text);
      calls.push({kind: 'aggregate', maxTokens: Number(body.max_tokens), batches, text});
      if (state.aggregateMode === 'error') {
        return new Response(JSON.stringify({error: {message: 'bad request'}}), {
          status: 400,
          headers: {'content-type': 'application/json'}
        });
      }
      const count = calls.filter((call) => call.kind === 'aggregate').length;
      if (state.aggregateMode === 'truncate'
        || (state.aggregateMode === 'truncate-once' && count === 1)) {
        return sse('{"session_topics":{"summary":"partial', 'length');
      }
      if (state.aggregateMode === 'invalid'
        || (state.aggregateMode === 'invalid-once' && count === 1)) {
        return sse('{"session_topics": {"summary": 42}}', 'stop');
      }
      return sse(finalAnswer(batches));
    }
    const count = calls.filter((call) => call.kind === 'batch').length + 1;
    calls.push({kind: 'batch', maxTokens: Number(body.max_tokens), text});
    return sse(sessionAnswer(count));
  };
}

async function seed18(server, sessionId) {
  addBroadcaster(server.db);
  return seedSession(server.db, {
    id: sessionId,
    messageCount: 3165,
    viewerCount: 3,
    startedAt: T0,
    messagePadding: 100
  });
}

test('a truncated aggregate is retried once, then the saved batches still complete a report', async (t) => {
  const temp = createTempDir();
  const sessionId = 'ses_aggregate_truncated_retry';
  const calls = [];
  const state = {aggregateMode: 'truncate-once'};
  let server = await startServer({dataDir: temp.dir, port: 0, systemLocale: 'en'});
  t.after(async () => {
    try {
      await server.close();
    } catch {
      // already closed
    }
    temp.cleanup();
  });
  const session = await seed18(server, sessionId);
  installMock(server, state, calls);
  const config = paidConfig(server, {batchInputTokens: 24000, contextLength: 0, concurrency: 1});
  await server.analysisRunner.start({
    sessionId,
    locale: 'en',
    mode: 'session',
    configId: config.id,
    consent: true
  });
  const completed = await waitFor(server.analysisRunner, sessionId, (status) => status.status === 'complete');
  const job = getJob(server.db, completed.sessionJobId);
  assert.ok(job);
  assert.equal(job.batchTotal, 18);
  assert.equal(completed.sessionBatchesCompleted, 18);
  assert.equal(completed.sessionAggregateDone, true);
  assert.equal(completed.error, null);
  assert.equal(completed.analysisOutcome, 'complete');
  assert.equal(completed.savedResults, 19);
  assert.equal(batchCalls(calls).length, 18, 'batches are requested once');
  assert.equal(aggregateCalls(calls).length, 2, 'truncation gets exactly one bounded retry');
  assert.ok(aggregateCalls(calls).every((call) => call.maxTokens >= 12000));
  assert.equal(completed.attemptStats.succeeded, 20);
  assert.equal(completed.outputStats.rejected, 1);
  assert.equal(completed.usage.requests, 20);
  const final = latestResultForScope(server.db, job.id, 'final', {includeJson: true});
  assert.ok(final);
  assert.equal(listResults(server.db, job.id).filter((row) => row.batchIndex !== null).length, 18);
  const finalRefs = final.result.session_topics.topics
    .flatMap((topic) => topic.message_refs ?? []);
  assert.equal(new Set(finalRefs.map((ref) => ref.batch)).size, 18,
    'every batch is represented by at least one evidence ref');

  // Restart and repeat Continue: complete is idempotent and calls no provider.
  await server.close();
  server = await startServer({dataDir: temp.dir, port: 0, systemLocale: 'en'});
  installMock(server, state, calls);
  const afterRestart = await fetch(
    `${server.url}api/ai/analyze/status?sessionId=${encodeURIComponent(sessionId)}`
  ).then((response) => response.json());
  assert.equal(afterRestart.status, 'complete');
  const before = calls.length;
  const again = await fetch(`${server.url}api/ai/analyze/resume`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({sessionId, consent: true})
  });
  assert.equal(again.status, 202);
  const againStatus = await again.json();
  assert.equal(againStatus.status, 'complete');
  assert.equal(calls.length, before, 'repeated Continue must not call the provider');
  assert.equal(savedBatchRows(server.db, job.id).length, 18);
});

test('a hard aggregate provider error stays resumable and Continue only retries the aggregate', async (t) => {
  const temp = createTempDir();
  const sessionId = 'ses_aggregate_provider_error';
  const calls = [];
  const state = {aggregateMode: 'error'};
  let server = await startServer({dataDir: temp.dir, port: 0, systemLocale: 'en'});
  t.after(async () => {
    try {
      await server.close();
    } catch {
      // already closed
    }
    temp.cleanup();
  });
  const session = await seed18(server, sessionId);
  installMock(server, state, calls);
  const config = paidConfig(server, {batchInputTokens: 24000, contextLength: 0, concurrency: 1});
  await server.analysisRunner.start({
    sessionId,
    locale: 'en',
    mode: 'session',
    configId: config.id,
    consent: true
  });
  const failed = await waitFor(server.analysisRunner, sessionId, (status) => (
    status.status === 'needs_action' || status.status === 'failed'
  ));
  const job = getJob(server.db, failed.sessionJobId);
  assert.equal(job.batchTotal, 18);
  assert.equal(failed.sessionBatchesCompleted, 18);
  assert.equal(failed.sessionAggregateDone, false);
  assert.equal(failed.recovery.kind, 'aggregate');
  assert.equal(failed.recovery.action, 'resume-aggregate');
  assert.equal(failed.recovery.canResume, true);
  assert.equal(failed.recovery.session.batchesSaved, 18);
  assert.equal(failed.recovery.session.pendingBatches, 0);
  assert.equal(batchCalls(calls).length, 18);
  assert.equal(aggregateCalls(calls).length, 1);
  const before = savedBatchRows(server.db, job.id);
  assert.equal(before.length, 18);

  await server.close();
  state.aggregateMode = 'success';
  server = await startServer({dataDir: temp.dir, port: 0, systemLocale: 'en'});
  installMock(server, state, calls);
  const afterRestart = await fetch(
    `${server.url}api/ai/analyze/status?sessionId=${encodeURIComponent(sessionId)}`
  ).then((response) => response.json());
  assert.equal(afterRestart.recovery.action, 'resume-aggregate');
  assert.equal(afterRestart.recovery.canResume, true);
  const callCountBeforeResume = calls.length;
  const resumeResponse = await fetch(`${server.url}api/ai/analyze/resume`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({sessionId, consent: true})
  });
  assert.equal(resumeResponse.status, 202);
  const completed = await waitFor(server.analysisRunner, sessionId, (status) => status.status === 'complete');
  assert.equal(completed.sessionAggregateDone, true);
  assert.equal(completed.recovery, null);
  assert.equal(completed.savedResults, 19);
  assert.equal(batchCalls(calls.slice(callCountBeforeResume)).length, 0,
    'Continue must not request any saved session batch');
  assert.equal(aggregateCalls(calls.slice(callCountBeforeResume)).length, 1,
    'Continue must request exactly the missing aggregate');
  assert.deepEqual(savedBatchRows(server.db, job.id), before);
  assert.ok(latestResultForScope(server.db, job.id, 'final'));
});

test('a successful HTTP response with an invalid aggregate is rejected, then a deterministic report completes', async (t) => {
  const temp = createTempDir();
  const server = await startServer({dataDir: temp.dir, port: 0, systemLocale: 'en'});
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  const session = await seed18(server, 'ses_aggregate_invalid_stats');
  const calls = [];
  const state = {aggregateMode: 'invalid'};
  installMock(server, state, calls);
  const config = paidConfig(server, {batchInputTokens: 24000, contextLength: 0, concurrency: 1});
  await server.analysisRunner.start({
    sessionId: session.id,
    locale: 'en',
    mode: 'session',
    configId: config.id,
    consent: true
  });
  const completed = await waitFor(server.analysisRunner, session.id, (status) => status.status === 'complete');
  assert.equal(completed.sessionBatchesCompleted, completed.sessionBatchTotal);
  assert.equal(completed.sessionAggregateDone, true);
  assert.equal(completed.aggregate.fallback, 'deterministic');
  assert.equal(completed.error, null);
  assert.equal(completed.attemptStats.failed, 0, 'the provider did not fail');
  assert.ok(completed.outputStats.rejected >= 2, 'each unusable output is counted separately');
  assert.ok(completed.savedResults >= completed.sessionBatchTotal);
  assert.ok(latestResultForScope(server.db, getJob(server.db, completed.sessionJobId).id, 'final'));
});
