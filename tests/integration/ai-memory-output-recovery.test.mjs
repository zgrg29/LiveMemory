import test from 'node:test';
import assert from 'node:assert/strict';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {startServer} from '../../src/server/index.mjs';
import {T0, addBroadcaster, seedSession} from '../helpers/ai-fixtures.mjs';

/**
 * Bounded output recovery for long-term viewer profiles.
 *
 * Only `fetch` is mocked: the real runner, package builder, validator and
 * transactional importer all execute. No paid provider is called.
 */

function jsonResponse(content, {input = 50, output = 10, finishReason = 'stop'} = {}) {
  return Response.json({
    model: 'mock-model',
    choices: [{
      message: {content: typeof content === 'string' ? content : JSON.stringify(content)},
      finish_reason: finishReason
    }],
    usage: {prompt_tokens: input, completion_tokens: output, total_tokens: input + output}
  });
}

function parseMemoryPrompt(text) {
  const batchId = /^- batch_id: "([^"]+)"/m.exec(text)?.[1] ?? null;
  const refs = new Map();
  for (const line of text.split('\n')) {
    const match = /^- ref (\d+): nickname=.*; evidence_seqs=(\[[^\]]*\]); zero_excerpt=(true|false)\r?$/.exec(line);
    if (!match) continue;
    refs.set(Number(match[1]), {
      ref: Number(match[1]),
      evidence: JSON.parse(match[2]),
      zeroExcerpt: match[3] === 'true'
    });
  }
  return {batchId, refs, repair: /Return the missing viewers only\./.test(text)};
}

function memoryViewers(info, {statement = null, topic = null, locale = 'en'} = {}) {
  return [...info.refs.values()].map((entry) => {
    if (entry.ref === 1 && statement) {
      return {
        ref: 1,
        memory: {
          summary: statement,
          summary_certainty: 'stated',
          no_new_information: false,
          operations: [{
            op: 'add',
            kind: 'interest',
            topic: topic ?? `topic-${info.batchId}`,
            statement,
            certainty: 'stated',
            confidence: 0.9,
            evidence: [entry.evidence[0]]
          }]
        }
      };
    }
    return {ref: entry.ref, memory: {no_new_information: true, operations: []}};
  });
}

function makeConfig(server, {concurrency = 4} = {}) {
  const config = server.providerConfigStore.create({
    providerId: 'custom',
    regionId: 'custom',
    baseUrl: 'https://example.com/v1',
    modelId: 'paid-model',
    apiKey: 'test-key',
    pricingStatus: 'paid',
    pricing: {inputPerMillion: 1, outputPerMillion: 2, currency: 'USD'},
    concurrency
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

async function waitFor(runner, sessionId, statuses, {attempts = 1000} = {}) {
  for (let index = 0; index < attempts; index += 1) {
    if (statuses.includes(runner.getStatus(sessionId).status)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return runner.getStatus(sessionId);
}

function startMockServer({temp, onMemory}) {
  return startServer({auth: false,
    dataDir: temp.dir,
    port: 0,
    systemLocale: 'en',
    auto: {
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        const text = body.messages.map((message) => message.content).join('\n');
        if (text.includes('AUTOMATIC MEMORY CONTRACT')) {
          return onMemory({body, text, info: parseMemoryPrompt(text)});
        }
        return jsonResponse({
          session_topics: {
            summary: 'Synthetic session summary',
            topics: [],
            sentiment: [],
            disputes: [],
            highlights: []
          }
        });
      }
    }
  });
}

async function startMemory(server, sessionId, config) {
  return server.analysisRunner.start({
    sessionId,
    locale: 'zh-CN',
    mode: 'memory',
    configId: config.id,
    consent: true
  });
}

test('finish_reason=length with incomplete JSON is detected and the batch is split', async (t) => {
  const temp = createTempDir();
  const calls = [];
  const server = await startMockServer({
    temp,
    onMemory: ({info}) => {
      calls.push(info);
      if (info.refs.size > 2) {
        // A realistic truncated JSON prefix: the provider stopped at `length`.
        return jsonResponse('{"viewers":[{"ref":1,"memory":{"summary":"cut', {finishReason: 'length', output: 6000});
      }
      return jsonResponse({viewers: memoryViewers(info)});
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {
    id: 'ses_mem_split_length',
    messageCount: 8,
    viewerCount: 4,
    startedAt: T0
  });
  const config = makeConfig(server);
  await startMemory(server, session.id, config);
  const status = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action']);
  assert.equal(status.status, 'complete', JSON.stringify(status));
  assert.equal(calls.length, 3, 'one truncated parent + two child requests');
  assert.equal(status.recoveryStats.splits, 1);
  assert.ok(status.recoveryStats.autoRetries >= 2);
  assert.equal(status.outputStats.truncations, 1);
  assert.equal(status.memorySplitBatches, 2);
  assert.equal(status.memoryJob.memoryCoverage.total, 4);
  assert.equal(status.memoryJob.memoryCoverage.covered, 4);
  const splitRows = server.db.prepare(`
    SELECT viewer_id, split_path FROM ai_job_memory_viewers WHERE split_path IS NOT NULL ORDER BY split_path, viewer_id
  `).all();
  assert.equal(splitRows.length, 4);
  assert.deepEqual([...new Set(splitRows.map((row) => row.split_path))].sort(), ['1.1', '1.2']);
  // No facts were imported from the truncated parent answer.
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM memory_facts').get().n, 0);
});

test('an empty length response for one viewer bumps the answer budget once', async (t) => {
  const temp = createTempDir();
  let calls = 0;
  const server = await startMockServer({
    temp,
    onMemory: ({info}) => {
      calls += 1;
      if (calls === 1) return jsonResponse('', {finishReason: 'length', output: 6000});
      return jsonResponse({viewers: memoryViewers(info, {statement: '喜欢吉他', topic: '吉他'})});
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {
    id: 'ses_mem_single_length',
    messageCount: 3,
    viewerCount: 1,
    startedAt: T0
  });
  const config = makeConfig(server);
  await startMemory(server, session.id, config);
  const status = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action']);
  assert.equal(status.status, 'complete', JSON.stringify(status));
  assert.equal(calls, 2);
  assert.equal(status.recoveryStats.budgetBumps, 1);
  assert.equal(status.recoveryStats.splits, 0);
  assert.equal(status.outputStats.truncations, 1);
  assert.equal(status.lastRequest.maxTokens, 8192, 'the single viewer got the bounded maximum budget');
  const fact = server.db.prepare('SELECT statement FROM memory_facts').get();
  assert.equal(fact.statement, '喜欢吉他', 'the Chinese task locale is preserved');
});

test('an empty stop response is retried once before any split', async (t) => {
  const temp = createTempDir();
  let calls = 0;
  const server = await startMockServer({
    temp,
    onMemory: ({info}) => {
      calls += 1;
      if (calls === 1) return jsonResponse('', {finishReason: 'stop'});
      return jsonResponse({viewers: memoryViewers(info)});
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {
    id: 'ses_mem_empty_retry',
    messageCount: 4,
    viewerCount: 2,
    startedAt: T0
  });
  const config = makeConfig(server);
  await startMemory(server, session.id, config);
  const status = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action']);
  assert.equal(status.status, 'complete', JSON.stringify(status));
  assert.equal(calls, 2);
  assert.equal(status.attemptStats.retried, 1, 'the safe empty-response retry is counted');
  assert.equal(status.recoveryStats.splits, 0);
  assert.equal(status.error, null);
});

test('finish_reason=stop with malformed JSON uses the existing bounded repair', async (t) => {
  const temp = createTempDir();
  let calls = 0;
  const server = await startMockServer({
    temp,
    onMemory: ({info}) => {
      calls += 1;
      if (calls === 1) return jsonResponse('{"viewers":[', {finishReason: 'stop'});
      return jsonResponse({viewers: memoryViewers(info)});
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {
    id: 'ses_mem_bad_json',
    messageCount: 4,
    viewerCount: 2,
    startedAt: T0
  });
  const config = makeConfig(server);
  await startMemory(server, session.id, config);
  const status = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action']);
  assert.equal(status.status, 'complete', JSON.stringify(status));
  assert.equal(calls, 2);
  assert.equal(status.recoveryStats.splits, 0);
  assert.ok(status.outputStats.rejected >= 1, 'the malformed answer is counted as rejected output');
});

test('batch 2 failure keeps saved batches 1 and 3 and resumes only batch 2', async (t) => {
  const temp = createTempDir();
  const calls = [];
  let failBatch2 = true;
  const server = await startMockServer({
    temp,
    onMemory: ({info}) => {
      calls.push(info.batchId);
      const batchNumber = Number(/-b(\d+)$/.exec(info.batchId ?? '')?.[1] ?? 0);
      if (batchNumber === 2 && failBatch2) {
        // A hard client error is not an output truncation: it must not create a
        // split mapping. The test is about non-contiguous saved batches and
        // viewer-level resume, not about the split ladder.
        return Response.json({error: {message: 'bad request'}}, {status: 400});
      }
      return jsonResponse({
        viewers: memoryViewers(info, {
          statement: `画像事实-${batchNumber}`,
          topic: `topic-${batchNumber}`
        })
      });
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {
    id: 'ses_mem_noncontiguous',
    messageCount: 30,
    viewerCount: 30,
    startedAt: T0
  });
  const config = makeConfig(server);
  await startMemory(server, session.id, config);
  let status = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action']);
  assert.notEqual(status.status, 'complete');
  assert.equal(status.canResume, true);
  assert.equal(status.memoryJob.batchTotal, 3);
  assert.equal(status.memoryJob.batchesImported, 2, 'batches 1 and 3 were saved');
  assert.equal(status.memoryJob.batchesCompleted, 2);
  assert.equal(status.memoryJob.pendingBatches, 1);
  assert.deepEqual(status.memoryJob.failedBatches, [2]);
  assert.equal(status.memoryJob.memoryCoverage.covered, 20);
  assert.equal(status.memoryJob.memoryCoverage.pending, 10);
  const savedBefore = server.db.prepare('SELECT COUNT(*) AS n FROM memory_facts').get().n;
  const resultIdsBefore = server.db.prepare('SELECT id FROM ai_results ORDER BY id').all().map((row) => row.id);

  failBatch2 = false;
  calls.length = 0;
  await server.analysisRunner.resume(session.id, {consent: true});
  status = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action']);
  assert.equal(status.status, 'complete', JSON.stringify(status));
  assert.equal(calls.length, 1, 'resume must request only the unfinished batch');
  assert.match(calls[0], /-b02$/);
  assert.equal(status.memoryJob.memoryCoverage.covered, 30);
  const resultIdsAfter = server.db.prepare('SELECT id FROM ai_results ORDER BY id').all().map((row) => row.id);
  assert.ok(resultIdsBefore.every((id) => resultIdsAfter.includes(id)), 'saved results were not rewritten');
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM memory_facts').get().n, savedBefore + 1,
    'only batch 2 adds one new fact; no batch 1/3 fact is duplicated');

  // A repeated Continue after completion is a no-op: no request, no new facts.
  calls.length = 0;
  await server.analysisRunner.resume(session.id, {consent: true});
  assert.equal(calls.length, 0);
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM memory_facts').get().n, savedBefore + 1);
});

test('a viewer with unusually many long messages is isolated in its own batch', async (t) => {
  const temp = createTempDir();
  const sizes = [];
  const server = await startMockServer({
    temp,
    onMemory: ({info}) => {
      sizes.push(info.refs.size);
      return jsonResponse({viewers: memoryViewers(info)});
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {
    id: 'ses_mem_heavy_viewer',
    messageCount: 40,
    viewerCount: 2,
    messagePadding: 2000,
    startedAt: T0
  });
  const config = makeConfig(server);
  await startMemory(server, session.id, config);
  const status = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action']);
  assert.equal(status.status, 'complete', JSON.stringify(status));
  assert.equal(status.memoryJob.batchTotal, 2);
  assert.deepEqual(sizes.sort((a, b) => a - b), [1, 1], 'each very heavy viewer gets its own request');
  assert.equal(status.memoryJob.memoryCoverage.covered, 2);
});

test('all viewers reach coverage on a multi-batch job with mixed empty and truncated answers', async (t) => {
  const temp = createTempDir();
  let calls = 0;
  const server = await startMockServer({
    temp,
    onMemory: ({info}) => {
      calls += 1;
      if (calls === 1) return jsonResponse('', {finishReason: 'stop'});
      if (calls === 2) return jsonResponse('{"viewers":[', {finishReason: 'length'});
      return jsonResponse({viewers: memoryViewers(info)});
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {
    id: 'ses_mem_mixed',
    messageCount: 60,
    viewerCount: 60,
    startedAt: T0
  });
  const config = makeConfig(server);
  await startMemory(server, session.id, config);
  const status = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action']);
  assert.equal(status.status, 'complete', JSON.stringify(status));
  assert.equal(status.memoryJob.memoryCoverage.total, 60);
  assert.equal(status.memoryJob.memoryCoverage.covered, 60);
  assert.equal(status.memoryJob.memoryCoverage.pending, 0);
  assert.equal(status.memoryJob.memoryCoverage.failed, 0);
});

test('a 975-viewer memory job reaches 975/975 coverage without dropping a viewer', async (t) => {
  const temp = createTempDir();
  let calls = 0;
  const server = await startMockServer({
    temp,
    onMemory: ({info}) => {
      calls += 1;
      return jsonResponse({viewers: memoryViewers(info)});
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {
    id: 'ses_mem_975',
    messageCount: 975,
    viewerCount: 975,
    startedAt: T0
  });
  const config = makeConfig(server, {concurrency: 8});
  await startMemory(server, session.id, config);
  const status = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action'], {attempts: 5000});
  assert.equal(status.status, 'complete', JSON.stringify(status));
  assert.equal(status.memoryJob.batchTotal, 98);
  assert.equal(status.memoryJob.batchesCompleted, 98);
  assert.equal(status.memoryJob.memoryCoverage.total, 975);
  assert.equal(status.memoryJob.memoryCoverage.covered, 975);
  assert.equal(status.memoryJob.memoryCoverage.pending, 0);
  assert.equal(status.memoryJob.memoryCoverage.failed, 0);
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM ai_job_memory_viewers WHERE status = ?').get('pending').n, 0);
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM ai_job_memory_viewers').get().n, 975);
});
