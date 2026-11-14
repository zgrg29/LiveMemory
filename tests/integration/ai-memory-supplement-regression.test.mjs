import test from 'node:test';
import assert from 'node:assert/strict';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {startServer} from '../../src/server/index.mjs';
import {T0, addBroadcaster, seedSession} from '../helpers/ai-fixtures.mjs';

/**
 * P0-1 regression: a first memory answer that omits one viewer must be merged
 * with a targeted supplement, not re-evaluated as if it had to contain every
 * viewer. Only `fetch` is mocked; the real runner, assembler, validator and
 * transactional importer execute.
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

function parseRefLines(text) {
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
  return refs;
}

function viewerUpdate(ref, evidence, {statement, topic}) {
  return {
    ref,
    memory: {
      summary: statement,
      summary_certainty: 'stated',
      no_new_information: false,
      operations: [{
        op: 'add',
        kind: 'interest',
        topic,
        statement,
        certainty: 'stated',
        confidence: 0.9,
        evidence: [evidence[0]]
      }]
    }
  };
}

function noUpdate(ref) {
  return {ref, memory: {no_new_information: true, operations: []}};
}

function updatesFor(refs, {prefix = '事实'} = {}) {
  return [...refs.values()].map((entry) => viewerUpdate(entry.ref, entry.evidence, {
    statement: `${prefix}-${entry.ref}`,
    topic: `topic-${entry.ref}`
  }));
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

async function waitFor(runner, sessionId, statuses, {attempts = 2000} = {}) {
  for (let index = 0; index < attempts; index += 1) {
    if (statuses.includes(runner.getStatus(sessionId).status)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return runner.getStatus(sessionId);
}

function startMockServer({temp, onMemory}) {
  return startServer({
    dataDir: temp.dir,
    port: 0,
    systemLocale: 'en',
    auto: {
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        const text = body.messages.map((message) => message.content).join('\n');
        if (text.includes('AUTOMATIC MEMORY CONTRACT')) {
          return onMemory({body, text, refs: parseRefLines(text), repair: /Return the missing viewers only\./.test(text)});
        }
        return jsonResponse({
          session_topics: {summary: 'Synthetic session summary', topics: [], sentiment: [], disputes: [], highlights: []}
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

test('a first answer missing one viewer is completed by a targeted supplement', async (t) => {
  const temp = createTempDir();
  const calls = [];
  let firstEvidence = null;
  const server = await startMockServer({
    temp,
    onMemory: ({text, refs, repair}) => {
      calls.push({refs: [...refs.keys()], repair});
      if (!repair) {
        firstEvidence = refs;
        // Deliberately omit ref 2: this is ordinary model behaviour, and the
        // exact case the previous audit reproduced.
        return jsonResponse({viewers: [viewerUpdate(1, refs.get(1).evidence, {statement: '喜欢吉他', topic: '吉他'})]});
      }
      assert.deepEqual([...refs.keys()], [2], 'the supplement must ask only for the missing viewer');
      const excerptBlock = text.split('## viewer_excerpts.jsonl (missing viewers only, seq + ref)')[1]?.split('\n## ')[0] ?? '';
      assert.ok(excerptBlock.length > 0, 'the supplement must include the missing viewer evidence');
      const missingSeqs = refs.get(2).evidence;
      const otherSeqs = firstEvidence.get(1).evidence;
      for (const seq of missingSeqs) {
        assert.match(excerptBlock, new RegExp(`"seq":${seq}[,\\n]`), `missing viewer seq ${seq} is present`);
      }
      for (const seq of otherSeqs) {
        assert.doesNotMatch(excerptBlock, new RegExp(`"seq":${seq}[,\\n]`), `other viewer seq ${seq} is not re-sent`);
      }
      return jsonResponse({viewers: [viewerUpdate(2, firstEvidence.get(2).evidence, {statement: '喜欢钢琴', topic: '钢琴'})]});
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {
    id: 'ses_mem_supplement_ok',
    messageCount: 8,
    viewerCount: 2,
    startedAt: T0
  });
  const config = makeConfig(server);
  await startMemory(server, session.id, config);
  const status = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action']);
  assert.equal(status.status, 'complete', JSON.stringify(status));
  assert.equal(calls.length, 2, 'one first answer + one targeted supplement');
  assert.deepEqual(calls[0].refs, [1, 2]);
  assert.equal(calls[1].repair, true);
  assert.equal(status.memoryJob.memoryCoverage.total, 2);
  assert.equal(status.memoryJob.memoryCoverage.covered, 2);
  assert.equal(status.memoryJob.memoryCoverage.pending, 0);
  assert.equal(status.memoryJob.memoryCoverage.failed, 0);
  const facts = server.db.prepare('SELECT statement FROM memory_facts ORDER BY statement').all();
  assert.deepEqual(facts.map((row) => row.statement), ['喜欢吉他', '喜欢钢琴']);
  const results = server.db.prepare('SELECT id, result_version FROM ai_results').all();
  assert.equal(results.length, 1, 'the merged answer is imported once');
  const before = {
    resultIds: results.map((row) => row.id),
    facts: facts.length
  };

  // A repeated Continue after completion must be a pure no-op.
  calls.length = 0;
  await server.analysisRunner.resume(session.id, {consent: true});
  assert.equal(calls.length, 0, 'completion is idempotent; no provider request');
  assert.deepEqual(server.db.prepare('SELECT id FROM ai_results ORDER BY id').all().map((row) => row.id), before.resultIds);
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM memory_facts').get().n, before.facts);
});

test('a supplement that still misses viewers keeps the first answer and leaves only the missing viewer resumable', async (t) => {
  const temp = createTempDir();
  const calls = [];
  let firstEvidence = null;
  let phase = 'initial';
  const server = await startMockServer({
    temp,
    onMemory: ({refs, repair}) => {
      calls.push({refs: [...refs.keys()], repair});
      if (!repair) {
        firstEvidence = refs;
        if (phase === 'resume') {
          // A recovery prompt is rebuilt for the single pending viewer, so its
          // local ref starts at 1 again; the stable viewer_id stays the same.
          return jsonResponse({viewers: [viewerUpdate(1, refs.get(1).evidence, {statement: '第二次答对', topic: '钢琴'})]});
        }
        return jsonResponse({viewers: [viewerUpdate(1, refs.get(1).evidence, {statement: '第一次答对', topic: '吉他'})]});
      }
      // The supplement returns a different viewer instead of ref 2. The first
      // answer must still be imported and ref 2 must stay recoverable.
      return jsonResponse({viewers: [noUpdate(1)]});
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {
    id: 'ses_mem_supplement_wrong',
    messageCount: 8,
    viewerCount: 2,
    startedAt: T0
  });
  const config = makeConfig(server);
  await startMemory(server, session.id, config);
  let status = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action']);
  assert.notEqual(status.status, 'complete');
  assert.equal(calls.length, 2);
  assert.equal(status.memoryJob.memoryCoverage.covered, 1, 'the valid first-answer viewer is preserved');
  assert.equal(status.memoryJob.memoryCoverage.failed, 1, 'only the missing viewer is failed');
  assert.equal(status.canResume, true);
  const firstFacts = server.db.prepare('SELECT id, statement FROM memory_facts').all();
  assert.deepEqual(firstFacts.map((row) => row.statement), ['第一次答对']);
  const firstResultIds = server.db.prepare('SELECT id FROM ai_results').all().map((row) => row.id);
  assert.equal(firstResultIds.length, 1);

  // The failed viewer is retried alone, and the already saved viewer is never
  // requested again nor duplicated.
  calls.length = 0;
  phase = 'resume';
  await server.analysisRunner.resume(session.id, {consent: true});
  status = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action']);
  assert.equal(status.status, 'complete', JSON.stringify(status));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].refs, [1], 'resume asks only for the failed viewer (refs are rebuilt from 1)');
  assert.equal(status.memoryJob.memoryCoverage.covered, 2);
  assert.ok(firstResultIds.every((id) => server.db.prepare('SELECT 1 FROM ai_results WHERE id = ?').get(id)));
  const facts = server.db.prepare('SELECT statement FROM memory_facts ORDER BY statement').all();
  assert.deepEqual(facts.map((row) => row.statement).sort(), ['第一次答对', '第二次答对'].sort());
});

test('a complete first answer needs no supplement and imports once', async (t) => {
  const temp = createTempDir();
  const calls = [];
  const server = await startMockServer({
    temp,
    onMemory: ({refs, repair}) => {
      calls.push({refs: [...refs.keys()], repair});
      return jsonResponse({viewers: updatesFor(refs)});
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {
    id: 'ses_mem_supplement_complete',
    messageCount: 8,
    viewerCount: 2,
    startedAt: T0
  });
  const config = makeConfig(server);
  await startMemory(server, session.id, config);
  const status = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action']);
  assert.equal(status.status, 'complete', JSON.stringify(status));
  assert.equal(calls.length, 1, 'a complete answer must not trigger a supplement');
  assert.equal(calls[0].repair, false);
  assert.equal(status.memoryJob.memoryCoverage.covered, 2);
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM ai_results').get().n, 1);
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM memory_facts').get().n, 2);
});

test('a partial supplement still saves every valid viewer from both answers', async (t) => {
  const temp = createTempDir();
  const calls = [];
  let phase = 'initial';
  const server = await startMockServer({
    temp,
    onMemory: ({refs, repair}) => {
      calls.push({refs: [...refs.keys()], repair, phase});
      if (phase === 'resume') {
        return jsonResponse({viewers: updatesFor(refs, {prefix: '补答'})});
      }
      if (!repair) {
        // Deliberately omit refs 2 and 3.
        const kept = [...refs.values()].filter((entry) => entry.ref === 1);
        return jsonResponse({
          viewers: kept.map((entry) => viewerUpdate(entry.ref, entry.evidence, {
            statement: '首答-1',
            topic: 'topic-1'
          }))
        });
      }
      // The supplement only returns ref 2, leaving ref 3 missing.
      assert.deepEqual([...refs.keys()], [2, 3]);
      const entry = refs.get(2);
      return jsonResponse({viewers: [viewerUpdate(2, entry.evidence, {statement: '补答-2', topic: 'topic-2'})]});
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {
    id: 'ses_mem_supplement_partial',
    messageCount: 9,
    viewerCount: 3,
    startedAt: T0
  });
  const config = makeConfig(server);
  await startMemory(server, session.id, config);
  let status = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action']);
  assert.notEqual(status.status, 'complete');
  assert.equal(calls.length, 2);
  assert.equal(status.memoryJob.memoryCoverage.covered, 2, 'both valid answers are kept');
  assert.equal(status.memoryJob.memoryCoverage.failed, 1, 'only the still-missing viewer is failed');
  const statements = server.db.prepare('SELECT statement FROM memory_facts ORDER BY statement').all().map((row) => row.statement);
  assert.deepEqual(statements.sort(), ['首答-1', '补答-2'].sort());

  calls.length = 0;
  phase = 'resume';
  await server.analysisRunner.resume(session.id, {consent: true});
  status = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action']);
  assert.equal(status.status, 'complete', JSON.stringify(status));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].refs, [1], 'only the remaining viewer is rebuilt into a one-viewer prompt');
  assert.equal(status.memoryJob.memoryCoverage.covered, 3);
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM memory_facts').get().n, 3, 'no fact was duplicated');
});

test('cross-viewer evidence in a supplement is rejected and the first answer is preserved', async (t) => {
  const temp = createTempDir();
  let firstRefs = null;
  let phase = 'initial';
  const server = await startMockServer({
    temp,
    onMemory: ({refs, repair}) => {
      if (phase === 'resume') {
        return jsonResponse({viewers: updatesFor(refs, {prefix: '恢复'})});
      }
      if (!repair) {
        firstRefs = refs;
        return jsonResponse({viewers: [viewerUpdate(1, refs.get(1).evidence, {statement: '首答合法', topic: 'topic-1'})]});
      }
      // ref 2 is the missing viewer, but the evidence belongs to ref 1.
      return jsonResponse({viewers: [viewerUpdate(2, firstRefs.get(1).evidence, {statement: '跨观众证据', topic: 'topic-2'})]});
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {
    id: 'ses_mem_supplement_cross_evidence',
    messageCount: 8,
    viewerCount: 2,
    startedAt: T0
  });
  const config = makeConfig(server);
  await startMemory(server, session.id, config);
  let status = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action']);
  assert.notEqual(status.status, 'complete');
  assert.equal(status.memoryJob.memoryCoverage.covered, 1);
  assert.equal(status.memoryJob.memoryCoverage.failed, 1);
  assert.equal(server.db.prepare("SELECT COUNT(*) AS n FROM memory_facts WHERE statement = '跨观众证据'").get().n, 0);
  assert.equal(server.db.prepare("SELECT COUNT(*) AS n FROM memory_facts WHERE statement = '首答合法'").get().n, 1);
  assert.ok(status.outputStats.rejected >= 1);

  phase = 'resume';
  await server.analysisRunner.resume(session.id, {consent: true});
  status = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action']);
  assert.equal(status.status, 'complete', JSON.stringify(status));
  assert.equal(status.memoryJob.memoryCoverage.covered, 2);
});

test('duplicate facts in a supplement are merged by the memory engine, not inserted twice', async (t) => {
  const temp = createTempDir();
  let firstRefs = null;
  const server = await startMockServer({
    temp,
    onMemory: ({refs, repair}) => {
      if (!repair) {
        firstRefs = refs;
        return jsonResponse({viewers: [viewerUpdate(1, refs.get(1).evidence, {statement: '首答', topic: 'topic-1'})]});
      }
      const entry = refs.get(2);
      const duplicate = viewerUpdate(2, firstRefs.get(2).evidence, {statement: '重复事实', topic: '重复话题'});
      duplicate.memory.operations.push({...duplicate.memory.operations[0]});
      return jsonResponse({viewers: [duplicate]});
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {
    id: 'ses_mem_supplement_duplicate',
    messageCount: 8,
    viewerCount: 2,
    startedAt: T0
  });
  const config = makeConfig(server);
  await startMemory(server, session.id, config);
  const status = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action']);
  assert.equal(status.status, 'complete', JSON.stringify(status));
  assert.equal(server.db.prepare("SELECT COUNT(*) AS n FROM memory_facts WHERE statement = '重复事实'").get().n, 1);
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM memory_facts').get().n, 2);
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM memory_versions WHERE source_key LIKE ?').get('%').n, 2);
});

test('an invalid JSON supplement keeps the first answer and leaves the missing viewer resumable', async (t) => {
  const temp = createTempDir();
  let phase = 'initial';
  const server = await startMockServer({
    temp,
    onMemory: ({refs, repair}) => {
      if (phase === 'resume') {
        return jsonResponse({viewers: updatesFor(refs, {prefix: '恢复'})});
      }
      if (!repair) {
        return jsonResponse({viewers: [viewerUpdate(1, refs.get(1).evidence, {statement: '首答有效', topic: 'topic-1'})]});
      }
      return jsonResponse('{"viewers":[');
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {
    id: 'ses_mem_supplement_invalid_json',
    messageCount: 8,
    viewerCount: 2,
    startedAt: T0
  });
  const config = makeConfig(server);
  await startMemory(server, session.id, config);
  let status = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action']);
  assert.notEqual(status.status, 'complete');
  assert.equal(status.memoryJob.memoryCoverage.covered, 1);
  assert.equal(status.memoryJob.memoryCoverage.failed, 1);
  assert.equal(server.db.prepare("SELECT COUNT(*) AS n FROM memory_facts WHERE statement = '首答有效'").get().n, 1);

  phase = 'resume';
  await server.analysisRunner.resume(session.id, {consent: true});
  status = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action']);
  assert.equal(status.status, 'complete', JSON.stringify(status));
  assert.equal(status.memoryJob.memoryCoverage.covered, 2);
});

test('an empty length-truncated supplement keeps the first answer and does not resend it', async (t) => {
  const temp = createTempDir();
  let phase = 'initial';
  const server = await startMockServer({
    temp,
    onMemory: ({refs, repair}) => {
      if (phase === 'resume') {
        return jsonResponse({viewers: updatesFor(refs, {prefix: '恢复'})});
      }
      if (!repair) {
        return jsonResponse({viewers: [viewerUpdate(1, refs.get(1).evidence, {statement: '首答已付费', topic: 'topic-1'})]});
      }
      return jsonResponse('', {finishReason: 'length', output: 3000});
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {
    id: 'ses_mem_supplement_truncated',
    messageCount: 8,
    viewerCount: 2,
    startedAt: T0
  });
  const config = makeConfig(server);
  await startMemory(server, session.id, config);
  let status = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action']);
  assert.notEqual(status.status, 'complete');
  assert.equal(status.memoryJob.memoryCoverage.covered, 1);
  assert.equal(status.memoryJob.memoryCoverage.failed, 1);
  assert.equal(status.attemptStats.total, 2, 'first answer + one failed supplement attempt');
  assert.equal(status.attemptStats.failed, 1, 'the empty length response is a failed attempt, not a resend');
  const savedResultIds = server.db.prepare('SELECT id FROM ai_results').all().map((row) => row.id);
  assert.equal(savedResultIds.length, 1);

  phase = 'resume';
  await server.analysisRunner.resume(session.id, {consent: true});
  status = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action']);
  assert.equal(status.status, 'complete', JSON.stringify(status));
  assert.ok(savedResultIds.every((id) => server.db.prepare('SELECT 1 FROM ai_results WHERE id = ?').get(id)));
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM memory_facts').get().n, 2);
});

test('a restart resumes only the failed viewer and keeps the saved result byte-identical', async (t) => {
  const temp = createTempDir();
  let phase = 'initial';
  let server = await startMockServer({
    temp,
    onMemory: ({refs, repair}) => {
      if (phase === 'resume') {
        return jsonResponse({viewers: updatesFor(refs, {prefix: '重启恢复'})});
      }
      if (!repair) {
        return jsonResponse({viewers: [viewerUpdate(1, refs.get(1).evidence, {statement: '重启前保存', topic: 'topic-1'})]});
      }
      return jsonResponse({viewers: [noUpdate(1)]});
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {
    id: 'ses_mem_supplement_restart',
    messageCount: 8,
    viewerCount: 2,
    startedAt: T0
  });
  const config = makeConfig(server);
  const calls = [];
  // Replace the mock's fetch after the first server is built by counting only
  // resume requests in the same handler is not possible; inspect the provider
  // request count instead.
  await startMemory(server, session.id, config);
  let status = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action']);
  assert.notEqual(status.status, 'complete');
  assert.equal(status.memoryJob.memoryCoverage.covered, 1);
  const before = {
    resultIds: server.db.prepare('SELECT id FROM ai_results ORDER BY id').all().map((row) => row.id),
    resultJson: server.db.prepare('SELECT result_json FROM ai_results').get().result_json,
    facts: server.db.prepare('SELECT id, viewer_id, statement FROM memory_facts ORDER BY id').all(),
    usageRequests: status.memoryJob.usage.requests
  };

  await server.close();
  phase = 'resume';
  server = await startMockServer({
    temp,
    onMemory: ({refs}) => {
      calls.push([...refs.keys()]);
      return jsonResponse({viewers: updatesFor(refs, {prefix: '重启恢复'})});
    }
  });
  status = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action']);
  assert.equal(status.canResume, true);
  await server.analysisRunner.resume(session.id, {consent: true});
  status = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action']);
  assert.equal(status.status, 'complete', JSON.stringify(status));
  assert.deepEqual(calls, [[1]], 'only the failed viewer is requested after restart');
  assert.equal(status.memoryJob.memoryCoverage.covered, 2);
  assert.deepEqual(
    server.db.prepare('SELECT id FROM ai_results ORDER BY id').all().map((row) => row.id).filter((id) => before.resultIds.includes(id)),
    before.resultIds,
    'the saved result row is not rewritten or deleted'
  );
  assert.equal(server.db.prepare("SELECT result_json FROM ai_results WHERE id = ?").get(before.resultIds[0]).result_json, before.resultJson);
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM ai_results').get().n, 2,
    'the recovered viewer is appended as a new version of the same batch result');
  assert.deepEqual(
    server.db.prepare('SELECT id, viewer_id, statement FROM memory_facts ORDER BY id').all().slice(0, 1),
    before.facts,
    'the saved fact is not duplicated or changed'
  );
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM memory_facts').get().n, 2);
});

test('concurrent batches: one partial supplement never discards sibling batches, and resume only retries its viewer', async (t) => {
  const temp = createTempDir();
  const calls = [];
  let phase = 'initial';
  const server = await startMockServer({
    temp,
    onMemory: ({text, refs, repair}) => {
      const textEntries = [...refs.values()];
      const batchNumber = Number(/-b(\d+)/.exec(/- batch_id: "([^"]+)"/.exec(text)?.[1] ?? '')?.[1] ?? 0);
      calls.push({refs: [...refs.keys()], repair, batchNumber, phase});
      if (phase === 'resume') {
        return jsonResponse({viewers: updatesFor(refs, {prefix: '恢复'})});
      }
      if (batchNumber === 2 && !repair) {
        // Batch 2 omits its last viewer and its supplement is invalid.
        const kept = textEntries.slice(0, -1);
        return jsonResponse({
          viewers: kept.map((entry) => viewerUpdate(entry.ref, entry.evidence, {
            statement: `批次2-${entry.ref}`,
            topic: `topic-${entry.ref}`
          }))
        });
      }
      if (batchNumber === 2 && repair) {
        return jsonResponse('{"viewers":[');
      }
      return jsonResponse({viewers: updatesFor(refs, {prefix: `批次${batchNumber}`})});
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {
    id: 'ses_mem_supplement_concurrent',
    messageCount: 30,
    viewerCount: 30,
    startedAt: T0
  });
  const config = makeConfig(server, {concurrency: 3});
  await startMemory(server, session.id, config);
  let status = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action'], {attempts: 5000});
  assert.notEqual(status.status, 'complete');
  assert.equal(status.memoryJob.batchTotal, 3);
  assert.equal(status.memoryJob.batchesCompleted, 2, 'sibling batches still completed');
  assert.equal(status.memoryJob.memoryCoverage.covered, 29);
  assert.equal(status.memoryJob.memoryCoverage.failed, 1);
  assert.equal(status.canResume, true);
  const savedResults = server.db.prepare('SELECT id, batch_index FROM ai_results ORDER BY batch_index, id').all();
  assert.equal(savedResults.length, 3, 'batch 1, 2 (partial) and 3 each saved a result');
  assert.deepEqual([...new Set(savedResults.map((row) => row.batch_index))], [1, 2, 3]);
  const savedFactCount = server.db.prepare('SELECT COUNT(*) AS n FROM memory_facts').get().n;
  assert.equal(savedFactCount, 29);

  calls.length = 0;
  phase = 'resume';
  await server.analysisRunner.resume(session.id, {consent: true});
  status = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action']);
  assert.equal(status.status, 'complete', JSON.stringify(status));
  assert.equal(calls.length, 1, 'resume must not replay batch 1 or 3');
  assert.deepEqual(calls[0].refs, [1]);
  assert.equal(status.memoryJob.memoryCoverage.covered, 30);
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM memory_facts').get().n, 30, 'no sibling fact duplicated');
  assert.ok(savedResults.every((row) => server.db.prepare('SELECT 1 FROM ai_results WHERE id = ?').get(row.id)));
});
