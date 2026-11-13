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
 * The real incident: 18/18 session batches were imported, the whole-session
 * aggregate returned `finish_reason=length`, and the task was shown as failed
 * with "20 requests succeeded". This test reproduces that shape with a Mock
 * Provider (no paid API), restarts the server to simulate reopening the EXE,
 * and proves that Continue only retries the aggregate.
 */

const iso = (ms) => new Date(ms).toISOString();

function sessionAnswer() {
  return JSON.stringify({
    session_topics: {
      summary: 'Batch-level summary.',
      topics: [{
        title: 'Batch topic',
        started_at: iso(T0 + 1000),
        ended_at: iso(T0 + 2000),
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

function aggregateAnswer(total) {
  return JSON.stringify({
    session_topics: {
      summary: 'Merged whole-session summary.',
      topics: [{
        title: 'Merged topic',
        started_at: iso(T0 + 1000),
        ended_at: iso(T0 + 2000),
        summary: 'One merged topic.',
        key_points: ['merged'],
        confidence: 0.7,
        evidence: 'observed',
        message_refs: [{batch: 1, seq: 1}, {batch: total, seq: 1}]
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
  server.analysisRunner.fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    const text = body.messages.map((message) => message.content).join('\n');
    if (text.includes('AGGREGATE MERGE CONTRACT')) {
      const total = Number((/batches: (\d+)/.exec(text) ?? [])[1] ?? 1);
      calls.push({kind: 'aggregate', maxTokens: Number(body.max_tokens), text});
      if (state.aggregateMode === 'truncate') {
        return sse('{"session_topics":{"summary":"partial', 'length');
      }
      if (state.aggregateMode === 'invalid') {
        return sse('{"session_topics": {"summary": 42}}', 'stop');
      }
      return sse(aggregateAnswer(total));
    }
    calls.push({kind: 'batch', maxTokens: Number(body.max_tokens), text});
    return sse(sessionAnswer());
  };
}

test('18 saved batches survive a truncated aggregate, a restart, and only the aggregate is resumed', async (t) => {
  const temp = createTempDir();
  const sessionId = 'ses_aggregate_truncation_18';
  const calls = [];
  const state = {aggregateMode: 'truncate'};

  let server = await startServer({dataDir: temp.dir, port: 0, systemLocale: 'en'});
  t.after(async () => {
    try {
      await server.close();
    } catch {
      // The test may already have closed and restarted the server.
    }
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {
    id: sessionId,
    messageCount: 3165,
    viewerCount: 3,
    startedAt: T0,
    // Long enough to produce the same 18-batch shape as the real incident
    // without using any real chat data.
    messagePadding: 100
  });
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
    status.status === 'failed' || status.status === 'needs_action'
  ));
  const job = getJob(server.db, failed.sessionJobId);
  assert.ok(job, 'the session job must exist');
  assert.equal(job.batchTotal, 18, 'the synthetic task must have the real 18-batch shape');
  assert.equal(failed.sessionBatchTotal, 18);
  assert.equal(failed.sessionBatchesCompleted, 18);
  assert.equal(failed.sessionAggregateDone, false);
  assert.equal(failed.error.code, 'AUTO_OUTPUT_TRUNCATED');
  assert.equal(failed.error.stage, 'session_aggregating');
  assert.equal(failed.error.batchIndex, null, 'an aggregate failure has no batch index, not 0');
  assert.equal(failed.error.recoverable, true);
  assert.equal(failed.recovery.kind, 'aggregate');
  assert.equal(failed.recovery.action, 'resume-aggregate');
  assert.equal(failed.recovery.canResume, true);
  assert.equal(failed.recovery.session.batchesSaved, 18);
  assert.equal(failed.recovery.session.pendingBatches, 0);
  assert.equal(failed.analysisOutcome, 'incomplete');
  assert.equal(failed.attemptStats.failed, 0);
  assert.equal(failed.attemptStats.succeeded, 19, '18 batches + the truncated aggregate');
  assert.equal(failed.outputStats.responses, 19);
  assert.equal(failed.outputStats.rejected, 1, 'HTTP success is not a usable output');
  assert.equal(failed.savedResults, 18);
  assert.equal(failed.usage.requests, 19);
  assert.ok(failed.usage.inputTokens > 0);
  assert.ok(failed.usage.outputTokens > 0);
  const persistedError = JSON.parse(getJob(server.db, job.id).lastErrorJson);
  assert.equal(persistedError.batches[0].batchIndex, null, 'the persisted error must not fake batch 0');
  const aggregate = aggregateCalls(calls)[0];
  assert.ok(aggregate, 'the aggregate must have been requested');
  assert.ok(aggregate.maxTokens >= 12000,
    `the aggregate needs its own output budget, got ${aggregate.maxTokens}`);

  const before = savedBatchRows(server.db, job.id);
  assert.equal(before.length, 18);
  const beforeIds = before.map((row) => row.id);

  // Simulate an old task that persisted the historical `batchIndex: 0` bug and
  // then simulate reopening the EXE (server shutdown + restart on the same data).
  const oldError = JSON.parse(getJob(server.db, job.id).lastErrorJson);
  oldError.batches[0].batchIndex = 0;
  server.db.prepare('UPDATE ai_jobs SET last_error_json = ? WHERE id = ?')
    .run(JSON.stringify(oldError), job.id);
  await server.close();

  const stateFile = join(temp.dir, 'runtime', 'ai-v13.json');
  const persistedState = JSON.parse(readFileSync(stateFile, 'utf8'));
  persistedState.sessions[sessionId].error.batchIndex = 0;
  writeFileSync(stateFile, `${JSON.stringify(persistedState, null, 2)}\n`, 'utf8');

  server = await startServer({dataDir: temp.dir, port: 0, systemLocale: 'en'});
  installMock(server, state, calls);
  const serverUrl = server.url;
  const afterRestart = await fetch(
    `${serverUrl}api/ai/analyze/status?sessionId=${encodeURIComponent(sessionId)}`
  ).then((response) => response.json());
  assert.equal(afterRestart.status, 'failed');
  assert.equal(afterRestart.error.batchIndex, null, 'legacy batch 0 is normalized on read');
  assert.equal(afterRestart.recovery.action, 'resume-aggregate');
  assert.equal(afterRestart.recovery.canResume, true);
  assert.deepEqual(afterRestart.sessionJob.failedBatches, [],
    'batch 0 must never be reported as a failed batch');
  assert.equal(savedBatchRows(server.db, job.id).length, 18);
  const callCountBeforeResume = calls.length;

  state.aggregateMode = 'success';
  const resumeResponse = await fetch(`${serverUrl}api/ai/analyze/resume`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({sessionId, consent: true})
  });
  assert.equal(resumeResponse.status, 202);
  const completed = await waitFor(server.analysisRunner, sessionId, (status) => status.status === 'complete');
  assert.equal(completed.sessionAggregateDone, true);
  assert.equal(completed.recovery, null);
  assert.equal(completed.canResume, false);
  assert.equal(completed.analysisOutcome, 'complete');
  assert.equal(completed.savedResults, 19);
  assert.equal(batchCalls(calls.slice(callCountBeforeResume)).length, 0,
    'Continue must not request any saved session batch');
  assert.equal(aggregateCalls(calls.slice(callCountBeforeResume)).length, 1,
    'Continue must request exactly the missing aggregate');
  const after = savedBatchRows(server.db, job.id);
  assert.deepEqual(after, before, 'batch rows, versions and checksums must be unchanged');
  assert.equal(latestResultForScope(server.db, job.id, 'final')?.resultVersion, 1);
  assert.equal(listResults(server.db, job.id).filter((row) => row.batchIndex !== null).length, 18);

  // Repeated Continue after success is a no-op: no new task, no new rows.
  const callsAfterComplete = calls.length;
  const again = await fetch(`${serverUrl}api/ai/analyze/resume`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({sessionId, consent: true})
  });
  assert.equal(again.status, 202);
  const againStatus = await again.json();
  assert.equal(againStatus.status, 'complete');
  assert.equal(calls.length, callsAfterComplete, 'repeated Continue must not call the provider');
  assert.equal(listResults(server.db, job.id).filter((row) => row.batchIndex !== null).length, 18);
  assert.equal(new Set(listResults(server.db, job.id).map((row) => row.id)).size,
    listResults(server.db, job.id).length);
  assert.ok(beforeIds.every((id) => savedBatchRows(server.db, job.id).some((row) => row.id === id)));
  assert.equal(server.analysisRunner.isConfigInUse(config.id), false);
});

test('a successful HTTP response with an invalid aggregate is counted as rejected output, not failed request', async (t) => {
  const temp = createTempDir();
  const server = await startServer({dataDir: temp.dir, port: 0, systemLocale: 'en'});
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {
    id: 'ses_aggregate_invalid_stats',
    messageCount: 420,
    viewerCount: 2,
    startedAt: T0
  });
  const calls = [];
  const state = {aggregateMode: 'invalid'};
  installMock(server, state, calls);
  const config = paidConfig(server, {batchInputTokens: 2000, contextLength: 32000, concurrency: 1});
  await server.analysisRunner.start({
    sessionId: session.id, locale: 'en', mode: 'session', configId: config.id, consent: true
  });
  const failed = await waitFor(server.analysisRunner, session.id, (status) => (
    status.status === 'failed' || status.status === 'needs_action'
  ));
  assert.ok(failed.sessionBatchTotal > 1);
  assert.equal(failed.sessionBatchesCompleted, failed.sessionBatchTotal);
  assert.equal(failed.error.code, 'AUTO_SCHEMA_INVALID');
  assert.equal(failed.error.batchIndex, null);
  assert.equal(failed.recovery.kind, 'aggregate');
  assert.equal(failed.attemptStats.failed, 0, 'the provider did not fail');
  assert.ok(failed.attemptStats.succeeded >= failed.sessionBatchTotal + 1);
  assert.ok(failed.outputStats.rejected >= 1, 'the invalid aggregate must be counted separately');
  assert.equal(failed.outputStats.lastFinishReason, 'stop');
  assert.equal(failed.savedResults, failed.sessionBatchTotal);
  assert.equal(failed.analysisOutcome, 'incomplete');
});
