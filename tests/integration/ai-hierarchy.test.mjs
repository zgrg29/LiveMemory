import test from 'node:test';
import assert from 'node:assert/strict';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {startServer} from '../../src/server/index.mjs';
import {addBroadcaster, seedSession, T0} from '../helpers/ai-fixtures.mjs';
import {getJob} from '../../src/storage/repositories/ai-jobs.mjs';
import {latestResultForScope} from '../../src/storage/repositories/ai-results.mjs';
import {listAggregateNodes} from '../../src/storage/repositories/ai-aggregate-nodes.mjs';

/**
 * End-to-end hierarchical aggregation.
 *
 * The provider is a deterministic local mock. The shape being tested is the
 * real one: many saved batches, each batch result too large to fit one final
 * request under the conservative aggregate budget, so the runner must create
 * partial-summary nodes, persist them, and merge them.
 */

const iso = (ms) => new Date(ms).toISOString();

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

function coverageFromPrompt(text) {
  return [...String(text).matchAll(/- batch (\d+): seq (\d+)-(\d+), messages (\d+), from ([^,]+), to ([^\n]+)/g)]
    .map((match) => ({
      batch: Number(match[1]),
      from: match[5],
      to: match[6].replace(/, partial nodes.*$/, '').trim()
    }));
}

function batchAnswer(batch) {
  const from = T0 + 1000 + batch * 100;
  return JSON.stringify({
    session_topics: {
      summary: `batch ${batch} ` + 'summary '.repeat(80),
      topics: Array.from({length: 5}, (_, index) => ({
        title: `batch ${batch} topic ${index}`,
        started_at: iso(from + index * 10),
        ended_at: iso(from + index * 10 + 5),
        summary: 'detail '.repeat(40),
        key_points: ['point '.repeat(10), 'point2 '.repeat(10)],
        confidence: 0.7,
        evidence: 'observed',
        message_refs: [1, 2]
      })),
      sentiment: [{at: iso(from), tone: 'positive', note: 'good '.repeat(10), confidence: 0.6}],
      disputes: [],
      highlights: [{
        started_at: iso(from),
        ended_at: iso(from + 5),
        title: `batch ${batch} highlight`,
        reason: 'reason '.repeat(20),
        clip_suggestion: 'clip',
        confidence: 0.6,
        evidence: 'observed',
        message_refs: [1]
      }]
    }
  });
}

function digestAnswer(batches) {
  const topics = [];
  const topicCount = Math.min(12, Math.max(1, Math.ceil(batches.length / 4)));
  const chunkSize = Math.ceil(batches.length / topicCount);
  for (let index = 0; index < batches.length; index += chunkSize) {
    const chunk = batches.slice(index, index + chunkSize);
    topics.push({
      title: `partial ${chunk[0]}-${chunk[chunk.length - 1]}`,
      started_at: iso(T0 + 1000 + chunk[0] * 100),
      ended_at: iso(T0 + 1000 + chunk[chunk.length - 1] * 100 + 50),
      summary: 'partial merged topic',
      key_points: ['k1', 'k2'],
      confidence: 0.7,
      evidence: 'observed',
      message_refs: chunk.slice(0, 6).map((batch) => ({batch, seq: 1}))
    });
  }
  return JSON.stringify({
    covered_batches: batches,
    session_topics: {
      summary: `partial ${batches[0]}-${batches[batches.length - 1]}`,
      topics,
      sentiment: [{
        at: iso(T0 + 1000 + batches[0] * 100),
        tone: 'positive',
        note: 'partial sentiment',
        confidence: 0.6
      }],
      disputes: [],
      highlights: [{
        started_at: iso(T0 + 1000 + batches[0] * 100),
        ended_at: iso(T0 + 1000 + batches[0] * 100 + 50),
        title: 'partial highlight',
        reason: 'r',
        clip_suggestion: 'c',
        confidence: 0.6,
        evidence: 'observed',
        message_refs: [{batch: batches[0], seq: 1}]
      }]
    }
  });
}

function finalAnswer(batches) {
  const topics = [];
  const topicCount = Math.min(10, Math.max(1, Math.ceil(batches.length / 4)));
  const chunkSize = Math.ceil(batches.length / topicCount);
  for (let index = 0; index < batches.length; index += chunkSize) {
    const chunk = batches.slice(index, index + chunkSize);
    topics.push({
      title: `final ${chunk[0]}-${chunk[chunk.length - 1]}`,
      started_at: iso(T0 + 1000 + chunk[0] * 100),
      ended_at: iso(T0 + 1000 + chunk[chunk.length - 1] * 100 + 50),
      summary: 'final merged topic',
      key_points: ['merged'],
      confidence: 0.7,
      evidence: 'observed',
      message_refs: chunk.slice(0, 4).map((batch) => ({batch, seq: 1}))
    });
  }
  return JSON.stringify({
    covered_batches: batches,
    session_topics: {
      summary: 'final report',
      topics,
      sentiment: [{
        at: iso(T0 + 1000 + batches[0] * 100),
        tone: 'positive',
        note: 'final sentiment',
        confidence: 0.6
      }],
      disputes: [],
      highlights: [{
        started_at: iso(T0 + 1000 + batches[0] * 100),
        ended_at: iso(T0 + 1000 + batches[0] * 100 + 50),
        title: 'final highlight',
        reason: 'r',
        clip_suggestion: 'c',
        confidence: 0.6,
        evidence: 'observed',
        message_refs: [{batch: batches[0], seq: 1}]
      }]
    }
  });
}

function paidConfig(server) {
  const config = server.providerConfigStore.create({
    providerId: 'custom',
    regionId: 'custom',
    baseUrl: 'https://example.com/v1',
    modelId: 'mock-large',
    apiKey: 'test-key',
    pricingStatus: 'paid',
    pricing: {inputPerMillion: 1, outputPerMillion: 2, currency: 'USD'},
    batchInputTokens: 2000,
    contextLength: 32000,
    concurrency: 1
  });
  server.providerConfigStore.recordTest(config.id, {
    status: 'passed',
    capabilities: {network: true, auth: true, text: true, json: true, session: true, memory: true},
    stages: {}
  });
  return config;
}

function installMock(server, state, calls) {
  server.analysisRunner.fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    const text = body.messages.map((message) => message.content).join('\n');
    if (text.includes('PARTIAL DIGEST CONTRACT')) {
      const batches = coverageFromPrompt(text).map((entry) => entry.batch);
      calls.push({kind: 'digest', batches, maxTokens: Number(body.max_tokens), text});
      if (state.digestMode === 'truncate-once'
        && state.truncatedGroups === undefined) {
        state.truncatedGroups = new Set();
      }
      if (state.digestMode === 'truncate-once' && state.truncateUsed.size === 0) {
        state.truncateUsed.add('global');
        return sse('{"covered_batches":[', 'length');
      }
      return sse(digestAnswer(batches));
    }
    if (text.includes('AGGREGATE MERGE CONTRACT')) {
      const batches = coverageFromPrompt(text).map((entry) => entry.batch);
      calls.push({kind: 'final', batches, maxTokens: Number(body.max_tokens), text});
      if (state.finalMode === 'error') {
        return new Response(JSON.stringify({error: {message: 'bad request'}}), {
          status: 400,
          headers: {'content-type': 'application/json'}
        });
      }
      return sse(finalAnswer(batches));
    }
    const count = calls.filter((call) => call.kind === 'batch').length + 1;
    calls.push({kind: 'batch', text});
    return sse(batchAnswer(count));
  };
}

async function waitFor(runner, sessionId, predicate, {timeoutMs = 120000} = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = runner.getStatus(sessionId);
    if (predicate(status)) return status;
    if (Date.now() > deadline) throw new Error(`timeout: ${JSON.stringify(status)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function seed(server, sessionId, messageCount) {
  addBroadcaster(server.db);
  return seedSession(server.db, {
    id: sessionId,
    messageCount,
    viewerCount: 3,
    startedAt: T0,
    messagePadding: 120
  });
}

test('32 saved batches aggregate through persisted nodes and resume without re-running batches', async (t) => {
  const temp = createTempDir();
  const sessionId = 'ses_hierarchy_32';
  const calls = [];
  const state = {finalMode: 'error', digestMode: 'success'};
  let server = await startServer({auth: false,dataDir: temp.dir, port: 0, systemLocale: 'en'});
  t.after(async () => {
    try {
      await server.close();
    } catch {
      // already closed
    }
    temp.cleanup();
  });
  const session = await seed(server, sessionId, 285);
  installMock(server, state, calls);
  const config = paidConfig(server);
  await server.analysisRunner.start({
    sessionId: session.id,
    locale: 'en',
    mode: 'session',
    configId: config.id,
    consent: true
  });
  const failed = await waitFor(server.analysisRunner, sessionId, (status) => (
    status.status === 'needs_action' || status.status === 'failed'
  ));
  const job = getJob(server.db, failed.sessionJobId);
  assert.equal(job.batchTotal, 32, 'the regression shape has 32 saved batches');
  assert.equal(failed.sessionBatchesCompleted, 32);
  assert.equal(failed.sessionAggregateDone, false);
  assert.equal(failed.recovery.kind, 'aggregate');
  assert.equal(failed.recovery.action, 'resume-aggregate');
  assert.equal(failed.recovery.canResume, true);
  assert.equal(failed.aggregate.mode, 'hierarchical');
  assert.ok(failed.aggregate.nodeTotal >= 2);
  assert.equal(failed.aggregate.nodesComplete, failed.aggregate.nodeTotal);
  assert.equal(failed.aggregate.nodesFailed, 0);
  assert.ok(failed.aggregate.requests >= failed.aggregate.nodeTotal);
  assert.equal(calls.filter((call) => call.kind === 'batch').length, 32);
  const digestCallsBefore = calls.filter((call) => call.kind === 'digest').length;
  assert.ok(digestCallsBefore >= 2, 'the final request is built from partial summaries');
  const nodesBefore = listAggregateNodes(server.db, job.id)
    .filter((node) => node.level > 0)
    .map((node) => ({
      id: node.id,
      level: node.level,
      nodeIndex: node.nodeIndex,
      sourceHash: node.sourceHash,
      covered: node.coveredBatches,
      digest: node.digest
    }));
  assert.equal(nodesBefore.length, failed.aggregate.nodeTotal);

  await server.close();
  state.finalMode = 'success';
  server = await startServer({auth: false,dataDir: temp.dir, port: 0, systemLocale: 'en'});
  installMock(server, state, calls);
  const callCountBeforeResume = calls.length;
  const before = await fetch(
    `${server.url}api/ai/analyze/status?sessionId=${encodeURIComponent(sessionId)}`
  ).then((response) => response.json());
  assert.equal(before.recovery.action, 'resume-aggregate');
  assert.equal(before.aggregate.nodeTotal, nodesBefore.length);
  const resumeResponse = await fetch(`${server.url}api/ai/analyze/resume`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({sessionId, consent: true})
  });
  assert.equal(resumeResponse.status, 202);
  const completed = await waitFor(server.analysisRunner, sessionId, (status) => status.status === 'complete');
  assert.equal(completed.sessionBatchesCompleted, 32);
  assert.equal(completed.sessionAggregateDone, true);
  assert.equal(completed.aggregate.mode, 'hierarchical');
  assert.equal(completed.aggregate.fallback, null);
  assert.equal(calls.slice(callCountBeforeResume).filter((call) => call.kind === 'batch').length, 0,
    'resume must not analyse a saved batch again');
  assert.equal(calls.slice(callCountBeforeResume).filter((call) => call.kind === 'digest').length, 0,
    'resume must reuse every completed partial summary');
  assert.equal(calls.slice(callCountBeforeResume).filter((call) => call.kind === 'final').length, 1,
    'resume requests exactly the missing final synthesis');
  const nodesAfter = listAggregateNodes(server.db, job.id)
    .filter((node) => node.level > 0)
    .map((node) => ({
      id: node.id,
      level: node.level,
      nodeIndex: node.nodeIndex,
      sourceHash: node.sourceHash,
      covered: node.coveredBatches,
      digest: node.digest
    }));
  assert.deepEqual(nodesAfter, nodesBefore, 'partial summaries are reused byte-for-byte');
  const final = latestResultForScope(server.db, job.id, 'final', {includeJson: true});
  assert.ok(final);
  const citedBatches = new Set(final.result.session_topics.topics
    .flatMap((topic) => topic.message_refs ?? [])
    .map((ref) => ref.batch));
  assert.equal(citedBatches.size, 32, 'the final report cites every batch');
  assert.ok(completed.usage.requests >= 32 + nodesBefore.length + 1,
    'hierarchical requests are counted in usage');
  assert.ok(completed.aggregate.requests >= nodesBefore.length + 1);
});

test('a truncated partial summary retries only that group', async (t) => {
  const temp = createTempDir();
  const sessionId = 'ses_hierarchy_truncate_group';
  const calls = [];
  const state = {finalMode: 'success', digestMode: 'truncate-once', truncateUsed: new Set()};
  const server = await startServer({auth: false,dataDir: temp.dir, port: 0, systemLocale: 'en'});
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  const session = await seed(server, sessionId, 285);
  installMock(server, state, calls);
  const config = paidConfig(server);
  await server.analysisRunner.start({
    sessionId: session.id,
    locale: 'en',
    mode: 'session',
    configId: config.id,
    consent: true
  });
  const completed = await waitFor(server.analysisRunner, sessionId, (status) => status.status === 'complete');
  assert.equal(completed.sessionBatchesCompleted, 32);
  assert.equal(completed.sessionAggregateDone, true);
  assert.equal(completed.aggregate.mode, 'hierarchical');
  const digestCalls = calls.filter((call) => call.kind === 'digest');
  const byGroup = new Map();
  for (const call of digestCalls) {
    const key = call.batches.join(',');
    byGroup.set(key, (byGroup.get(key) ?? 0) + 1);
  }
  assert.equal([...byGroup.values()].filter((count) => count > 1).length, 1,
    'only the truncated group is retried');
  assert.equal(digestCalls.length, byGroup.size + 1);
  assert.equal(completed.outputStats.rejected, 1);
  assert.equal(completed.attemptStats.failed, 0);
});

test('64 and 128 saved batches stay within the bounded request count', async (t) => {
  for (const [messageCount, expected] of [[570, 64], [1150, 128]]) {
    const temp = createTempDir();
    const sessionId = `ses_hierarchy_${expected}`;
    const calls = [];
    const state = {finalMode: 'success', digestMode: 'success', truncateUsed: new Set()};
    const server = await startServer({auth: false,dataDir: temp.dir, port: 0, systemLocale: 'en'});
    try {
      const session = await seed(server, sessionId, messageCount);
      installMock(server, state, calls);
      const config = paidConfig(server);
      await server.analysisRunner.start({
        sessionId: session.id,
        locale: 'en',
        mode: 'session',
        configId: config.id,
        consent: true
      });
      const completed = await waitFor(server.analysisRunner, sessionId, (status) => status.status === 'complete');
      assert.ok(completed.sessionBatchTotal >= expected,
        `expected at least ${expected} batches, got ${completed.sessionBatchTotal}`);
      assert.equal(completed.sessionBatchesCompleted, completed.sessionBatchTotal);
      assert.equal(completed.sessionAggregateDone, true);
      assert.equal(completed.aggregate.mode, 'hierarchical');
      assert.ok(completed.aggregate.nodeTotal >= 2);
      assert.ok(completed.aggregate.nodeTotal <= 24, 'the final level has at most 24 units');
      assert.ok(completed.aggregate.levels <= 6,
        `depth is controlled, got ${completed.aggregate.levels}`);
      const final = latestResultForScope(server.db, completed.sessionJobId, 'final', {includeJson: true});
      assert.ok(final);
      const cited = new Set(final.result.session_topics.topics
        .flatMap((topic) => topic.message_refs ?? [])
        .map((ref) => ref.batch));
      assert.equal(cited.size, completed.sessionBatchTotal,
        'the final report cites every saved batch');
      const batchCalls = calls.filter((call) => call.kind === 'batch').length;
      const digestCalls = calls.filter((call) => call.kind === 'digest').length;
      const finalCalls = calls.filter((call) => call.kind === 'final').length;
      assert.equal(batchCalls, completed.sessionBatchTotal, 'each batch is analysed exactly once');
      assert.ok(digestCalls <= completed.sessionBatchTotal, 'at most one partial request per batch');
      assert.equal(finalCalls, 1);
      assert.ok(completed.usage.requests >= batchCalls + digestCalls + finalCalls);
    } finally {
      await server.close();
      temp.cleanup();
    }
  }
});
