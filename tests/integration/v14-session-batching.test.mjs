import test from 'node:test';
import assert from 'node:assert/strict';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {startServer} from '../../src/server/index.mjs';
import {addBroadcaster, seedSession, T0} from '../helpers/ai-fixtures.mjs';
import {getJob, listJobBatches} from '../../src/storage/repositories/ai-jobs.mjs';
import {listResults, latestResultForScope} from '../../src/storage/repositories/ai-results.mjs';
import {listJobs} from '../../src/storage/repositories/ai-jobs.mjs';

function iso(ms) {
  return new Date(ms).toISOString();
}

function sessionAnswer(refSeq = 1) {
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
        message_refs: [refSeq]
      }],
      sentiment: [],
      disputes: [],
      highlights: []
    }
  });
}

function aggregateAnswer(batchTotal) {
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
        message_refs: [{batch: 1, seq: 1}, {batch: batchTotal, seq: 1}]
      }],
      sentiment: [],
      disputes: [],
      highlights: []
    }
  });
}

function installMockProvider(server, {onRequest = null} = {}) {
  const calls = [];
  server.analysisRunner.fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    const text = body.messages.map((message) => message.content).join('\n');
    calls.push({text, url, body});
    if (onRequest) {
      const custom = await onRequest({text, body, calls});
      if (custom) return custom;
    }
    if (text.includes('AGGREGATE MERGE CONTRACT')) {
      const total = Number((/batches: (\d+)/.exec(text) ?? [])[1] ?? 1);
      return Response.json({
        model: body.model,
        choices: [{message: {content: aggregateAnswer(total)}, finish_reason: 'stop'}],
        usage: {prompt_tokens: 50, completion_tokens: 20, total_tokens: 70}
      });
    }
    return Response.json({
      model: body.model,
      choices: [{message: {content: sessionAnswer()}, finish_reason: 'stop'}],
      usage: {prompt_tokens: 100, completion_tokens: 20, total_tokens: 120}
    });
  };
  return calls;
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

async function waitForStatus(runner, sessionId, predicate, {timeoutMs = 8000} = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = runner.getStatus(sessionId);
    if (predicate(status)) return status;
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for status: ${JSON.stringify(status)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

test('a large session is split by input tokens, every message is covered, and a final aggregate is required', async (t) => {
  const temp = createTempDir();
  const server = await startServer({dataDir: temp.dir, port: 0, systemLocale: 'en'});
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {
    id: 'ses_token_batching',
    messageCount: 420,
    viewerCount: 3,
    startedAt: T0
  });
  const calls = installMockProvider(server);
  const config = paidConfig(server, {
    // A deliberately small budget forces several batches; it is a per-config
    // value, not a hard-coded constant.
    batchInputTokens: 2000,
    contextLength: 32000
  });

  const started = await server.analysisRunner.start({
    sessionId: session.id,
    locale: 'en',
    mode: 'session',
    configId: config.id,
    consent: true,
    confirmBilling: true
  });
  assert.equal(started.running, true);
  const status = await waitForStatus(server.analysisRunner, session.id, (value) => value.status === 'complete');
  assert.equal(status.sessionReportDone, true, JSON.stringify(status));
  assert.ok(status.sessionBatchTotal > 1, 'the small budget must create more than one batch');
  assert.equal(status.sessionBatchesCompleted, status.sessionBatchTotal);
  assert.equal(status.sessionAggregateRequired, true);
  assert.equal(status.sessionAggregateDone, true);

  const job = getJob(server.db, status.sessionJobId);
  const batches = listJobBatches(server.db, job.id);
  assert.equal(batches.length, status.sessionBatchTotal);
  assert.equal(job.aggregateTaskId, `${session.id}-analysis-final`);
  // Every message appears exactly once across all batch packages.
  const mapping = server.db.prepare(`
    SELECT batch_index, seq, event_id FROM ai_job_messages WHERE job_id = ? ORDER BY batch_index, seq
  `).all(job.id);
  assert.equal(mapping.length, 420);
  assert.equal(new Set(mapping.map((row) => row.event_id)).size, 420);
  for (const row of mapping) {
    const batch = batches.find((entry) => entry.batchIndex === row.batch_index);
    assert.ok(row.seq >= 1 && row.seq <= batch.messageCount);
  }

  const results = listResults(server.db, job.id);
  assert.equal(results.filter((row) => row.batchIndex !== null).length, status.sessionBatchTotal);
  assert.ok(latestResultForScope(server.db, job.id, 'final'));
  const final = latestResultForScope(server.db, job.id, 'final', {includeJson: true});
  assert.equal(final.result.session_topics.summary, 'Merged whole-session summary.');
  assert.equal(final.result.analysis_scope, 'session');
  assert.equal(final.result.batch_id, undefined);

  const report = await fetch(`${server.url}api/ai/sessions/${encodeURIComponent(session.id)}/report`)
    .then((response) => response.json());
  assert.equal(report.mode, 'final');
  assert.equal(report.complete, true);
  assert.equal(report.report.summary, 'Merged whole-session summary.');
  assert.equal(report.perBatch.length, 0);

  const aggregateCalls = calls.filter((call) => call.text.includes('AGGREGATE MERGE CONTRACT'));
  assert.equal(aggregateCalls.length, 1, 'the aggregate is requested exactly once');
  assert.equal(calls.length, status.sessionBatchTotal + 1);
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM viewer_memories').get().n, 0);
});

test('a failed session batch does not cancel or lose a sibling batch that is already running', async (t) => {
  const temp = createTempDir();
  const server = await startServer({dataDir: temp.dir, port: 0, systemLocale: 'en'});
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {
    id: 'ses_partial_batches',
    messageCount: 420,
    viewerCount: 2,
    startedAt: T0
  });
  const batchIds = new Map();
  let resumeStarted = false;
  const calls = installMockProvider(server, {
    onRequest: async ({text, body}) => {
      const match = /-analysis-b(\d+)\b/.exec(text);
      const batchIndex = match ? Number(match[1]) : null;
      if (batchIndex !== null) batchIds.set(batchIndex, (batchIds.get(batchIndex) ?? 0) + 1);
      if (batchIndex === 1 && !resumeStarted) {
        return new Response(JSON.stringify({error: {message: 'synthetic server failure'}}), {
          status: 500,
          headers: {'content-type': 'application/json'}
        });
      }
      if (batchIndex === 2) {
        // Keep the sibling in flight while batch 1 fails, so the old
        // pool-wide abort would have killed it.
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      return null;
    }
  });
  const config = paidConfig(server, {batchInputTokens: 2000, contextLength: 32000, concurrency: 2});
  await server.analysisRunner.start({
    sessionId: session.id,
    locale: 'en',
    mode: 'session',
    configId: config.id,
    consent: true,
    confirmBilling: true
  });
  const failed = await waitForStatus(server.analysisRunner, session.id, (value) => value.status === 'failed');
  assert.equal(failed.error.code, 'PROVIDER_HTTP_ERROR');
  assert.ok(failed.saved.sessionBatches >= 1, JSON.stringify({saved: failed.saved, sessionJob: failed.sessionJob, error: failed.error}));
  const jobId = failed.sessionJobId;
  const savedBeforeResume = listResults(server.db, jobId).filter((row) => row.batchIndex !== null);
  assert.ok(savedBeforeResume.some((row) => row.batchIndex === 2), 'the in-flight sibling must still be imported');
  assert.equal(latestResultForScope(server.db, jobId, 'final'), null, 'a failed batch must block the aggregate');

  // Resuming must only request the missing batches, then the aggregate.
  const beforeResumeCalls = calls.length;
  resumeStarted = true;
  await server.analysisRunner.resume(session.id, {consent: true, confirmBilling: true});
  const completed = await waitForStatus(server.analysisRunner, session.id, (value) => value.status === 'complete');
  assert.equal(completed.sessionReportDone, true);
  const resumeCalls = calls.slice(beforeResumeCalls);
  const resumeBatchCalls = resumeCalls.filter((call) => !call.text.includes('AGGREGATE MERGE CONTRACT'));
  const missingBefore = listJobBatches(server.db, jobId)
    .filter((batch) => !savedBeforeResume.some((row) => row.batchIndex === batch.batchIndex))
    .map((batch) => batch.batchIndex);
  for (const batchIndex of missingBefore) {
    assert.ok(resumeBatchCalls.some((call) => new RegExp(`-analysis-b0?${batchIndex}\\b`).test(call.text)),
      `resume must request pending batch ${batchIndex}`);
  }
  for (const saved of savedBeforeResume) {
    assert.equal(
      resumeBatchCalls.filter((call) => new RegExp(`-analysis-b0?${saved.batchIndex}\\b`).test(call.text)).length,
      0,
      `resume must not repeat imported batch ${saved.batchIndex}`
    );
  }
  assert.equal(resumeCalls.filter((call) => call.text.includes('AGGREGATE MERGE CONTRACT')).length, 1);
  assert.ok(listJobs(server.db, {sessionId: session.id}).length >= 1);
});
