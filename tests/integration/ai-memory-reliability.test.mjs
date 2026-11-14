import test from 'node:test';
import assert from 'node:assert/strict';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {startServer} from '../../src/server/index.mjs';
import {T0, addBroadcaster, seedSession} from '../helpers/ai-fixtures.mjs';
import {giftEvent} from '../helpers/fixtures.mjs';
import {createSession, endSession} from '../../src/storage/repositories/sessions.mjs';
import {EventIngest} from '../../src/platforms/shared/ingest.mjs';
import {importAnalysisResult} from '../../src/ai/import/importer.mjs';
import {listResults} from '../../src/storage/repositories/ai-results.mjs';

/**
 * Real provider path, mock transport.
 *
 * These tests exercise the exact runner/importer/validation code that handles a
 * paid provider answer. Only `fetch` is mocked: no network, no API key, no real
 * data directory.
 */

function sessionAnswer() {
  return {
    session_topics: {
      summary: 'Synthetic session summary',
      topics: [],
      sentiment: [],
      disputes: [],
      highlights: []
    }
  };
}

function jsonResponse(content, {input = 50, output = 10} = {}) {
  return Response.json({
    model: 'mock-model',
    choices: [{
      message: {content: typeof content === 'string' ? content : JSON.stringify(content)},
      finish_reason: 'stop'
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
  const repair = /Return the missing viewers only\./.test(text);
  return {batchId, refs, repair};
}

/** One record per ref, optionally with a stated fact for the first ref. */
function memoryViewers(info, {statement = null, topic = null} = {}) {
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

/** Complete refs but ref 1 claims a stated fact without evidence. */
function missingEvidenceViewers(info) {
  return [...info.refs.values()].map((entry) => (
    entry.ref === 1
      ? {
        ref: 1,
        memory: {
          no_new_information: false,
          operations: [{
            op: 'add',
            kind: 'interest',
            topic: 'guitar',
            statement: 'likes guitar',
            certainty: 'stated',
            evidence: []
          }]
        }
      }
      : {ref: entry.ref, memory: {no_new_information: true, operations: []}}
  ));
}

function crossViewerEvidenceViewers(info) {
  const first = info.refs.get(1);
  const second = info.refs.get(2);
  return [...info.refs.values()].map((entry) => {
    if (entry.ref === 1) {
      return {
        ref: 1,
        memory: {
          no_new_information: false,
          operations: [{
            op: 'add',
            kind: 'interest',
            topic: 'borrowed',
            statement: 'borrowed another viewer evidence',
            certainty: 'stated',
            evidence: [second?.evidence?.[0] ?? 1]
          }]
        }
      };
    }
    if (entry.ref === 2) {
      return {
        ref: 2,
        memory: {
          no_new_information: false,
          operations: [{
            op: 'add',
            kind: 'interest',
            topic: `own-${first.ref}`,
            statement: 'own fact',
            certainty: 'stated',
            evidence: [entry.evidence[0]]
          }]
        }
      };
    }
    return {ref: entry.ref, memory: {no_new_information: true, operations: []}};
  });
}

function makeConfig(server, {concurrency = 3} = {}) {
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

async function waitFor(runner, sessionId, statuses, {attempts = 500} = {}) {
  for (let index = 0; index < attempts; index += 1) {
    if (statuses.includes(runner.getStatus(sessionId).status)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return runner.getStatus(sessionId);
}

function startMockServer({temp, onMemory, sessionUsage, memoryUsage}) {
  return startServer({auth: false,
    dataDir: temp.dir,
    port: 0,
    systemLocale: 'en',
    auto: {
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        const text = body.messages.map((message) => message.content).join('\n');
        if (text.includes('AUTOMATIC MEMORY CONTRACT')) {
          return onMemory({
            body,
            text,
            info: parseMemoryPrompt(text),
            messages: body.messages
          });
        }
        return jsonResponse(sessionAnswer(), sessionUsage);
      }
    }
  });
}

test('a valid compact memory answer is imported once and maps refs to stable ids', async (t) => {
  const temp = createTempDir();
  const calls = [];
  const server = await startMockServer({
    temp,
    memoryUsage: {input: 60, output: 15},
    onMemory: ({info}) => {
      calls.push(info);
      return jsonResponse({viewers: memoryViewers(info)}, {input: 60, output: 15});
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {
    id: 'ses_mem_valid',
    messageCount: 4,
    viewerCount: 2,
    startedAt: T0
  });
  const config = makeConfig(server);
  await server.analysisRunner.start({
    sessionId: session.id,
    locale: 'en',
    mode: 'memory',
    configId: config.id,
    consent: true
  });
  const status = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action']);
  assert.equal(status.status, 'complete', JSON.stringify(status));
  assert.equal(calls.length, 1, 'one valid answer needs no repair request');
  assert.equal(status.memoryJob.memoryCoverage.total, 2);
  assert.equal(status.memoryJob.memoryCoverage.covered, 2);
  assert.equal(status.memoryJob.memoryCoverage.no_semantics, 2);
  assert.equal(status.memoryJob.batchErrors.length, 0);
  const results = server.db.prepare('SELECT COUNT(*) AS n FROM ai_results').get().n;
  assert.equal(results, 1);
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM viewer_memories').get().n, 2);
  // No semantics is a processed state, not a failure.
  const coverage = status.memoryJob.memoryCoverage;
  assert.equal(coverage.pending, 0);
  assert.equal(coverage.missing_update, 0);
});

test('complete ref coverage does not skip schema and evidence validation', async (t) => {
  const temp = createTempDir();
  let calls = 0;
  const server = await startMockServer({
    temp,
    onMemory: ({info}) => {
      calls += 1;
      // The first and the single repair answer are both complete in refs but
      // invalid in business validation.
      return jsonResponse({viewers: missingEvidenceViewers(info)});
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {
    id: 'ses_mem_invalid_missing_evidence',
    messageCount: 4,
    viewerCount: 2,
    startedAt: T0
  });
  const config = makeConfig(server);
  await server.analysisRunner.start({
    sessionId: session.id,
    locale: 'en',
    mode: 'memory',
    configId: config.id,
    consent: true
  });
  const status = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action']);
  assert.equal(status.status, 'partial', JSON.stringify(status));
  assert.equal(status.error.code, 'AI_IMPORT_INVALID');
  assert.ok(status.error.errors.some((item) => item.code === 'MEMORY_EVIDENCE_REQUIRED'), JSON.stringify(status.error));
  assert.equal(calls, 3, 'whole-batch repair plus one bounded viewer repair');
  // The invalid viewer is isolated; the valid viewer's result is still saved.
  assert.equal(status.memoryJob.memoryCoverage.covered, 1);
  assert.equal(status.memoryJob.memoryCoverage.failed, 1);
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM ai_results').get().n, 1);
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM memory_facts').get().n, 0);
  assert.equal(status.canResume, true);
  assert.equal(status.error.recoverable, true);
  assert.equal(status.error.batchIndex, 1);
});

test('one automatic repair can fix an invalid answer and the repaired usage is counted', async (t) => {
  const temp = createTempDir();
  let calls = 0;
  const server = await startMockServer({
    temp,
    onMemory: ({info, messages}) => {
      calls += 1;
      if (messages.length <= 2) {
        return jsonResponse({viewers: missingEvidenceViewers(info)}, {input: 40, output: 20});
      }
      return jsonResponse({
        viewers: memoryViewers(info, {statement: 'Started learning guitar', topic: 'guitar'})
      }, {input: 45, output: 25});
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {
    id: 'ses_mem_repaired',
    messageCount: 5,
    viewerCount: 2,
    startedAt: T0
  });
  const config = makeConfig(server);
  await server.analysisRunner.start({
    sessionId: session.id,
    locale: 'en',
    mode: 'memory',
    configId: config.id,
    consent: true
  });
  const status = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action']);
  assert.equal(status.status, 'complete', JSON.stringify(status));
  assert.equal(calls, 2);
  assert.equal(status.error, null);
  assert.equal(status.memoryJob.memoryCoverage.semantic, 1);
  assert.equal(status.memoryJob.usage.requests, 2, 'the repair request is real usage');
  const fact = server.db.prepare('SELECT viewer_id, statement, certainty FROM memory_facts').get();
  assert.equal(fact.viewer_id, 'youtube:UC_VIEWER_0');
  assert.equal(fact.statement, 'Started learning guitar');
  assert.equal(fact.certainty, 'stated');
});

test('a model-supplied viewer_id cannot move a fact to another viewer', async (t) => {
  const temp = createTempDir();
  const server = await startMockServer({
    temp,
    onMemory: ({info}) => {
      const first = info.refs.get(1);
      const viewers = [...info.refs.values()].map((entry) => {
        if (entry.ref === 1) {
          return {
            ref: 1,
            memory: {
              // Model attempts to redirect ref 1 to viewer 1's stable id.
              viewer_id: 'youtube:UC_VIEWER_1',
              session_id: 'ses_forged',
              no_new_information: false,
              operations: [{
                op: 'add',
                kind: 'interest',
                topic: 'guitar',
                statement: 'ref one fact',
                certainty: 'stated',
                evidence: [first.evidence[0]]
              }]
            }
          };
        }
        return {ref: entry.ref, memory: {no_new_information: true, operations: []}};
      });
      return jsonResponse({viewers});
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {
    id: 'ses_mem_identity_override',
    // Odd message count gives viewer 0 three messages and viewer 1 two, so
    // ref 1 maps to UC_VIEWER_0 deterministically.
    messageCount: 5,
    viewerCount: 2,
    startedAt: T0
  });
  const config = makeConfig(server);
  await server.analysisRunner.start({
    sessionId: session.id,
    locale: 'en',
    mode: 'memory',
    configId: config.id,
    consent: true
  });
  const status = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action']);
  assert.equal(status.status, 'complete', JSON.stringify(status));
  const facts = server.db.prepare('SELECT viewer_id, statement FROM memory_facts ORDER BY viewer_id').all();
  assert.equal(facts.length, 1, 'the forged record must not create a second fact');
  assert.equal(facts[0].viewer_id, 'youtube:UC_VIEWER_0');
  assert.equal(facts[0].statement, 'ref one fact');
  const stored = server.db.prepare("SELECT result_json FROM ai_results WHERE batch_index = 1").get();
  const parsed = JSON.parse(stored.result_json);
  assert.deepEqual(parsed.viewer_memory_updates.map((entry) => entry.viewer_id), [
    'youtube:UC_VIEWER_0',
    'youtube:UC_VIEWER_1'
  ]);
  assert.equal(parsed.locale, 'en');
});

test('cross-viewer evidence is rejected and never written to the wrong profile', async (t) => {
  const temp = createTempDir();
  let calls = 0;
  const server = await startMockServer({
    temp,
    onMemory: ({info}) => {
      calls += 1;
      return jsonResponse({viewers: crossViewerEvidenceViewers(info)});
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {
    id: 'ses_mem_cross_evidence',
    messageCount: 4,
    viewerCount: 2,
    startedAt: T0
  });
  const config = makeConfig(server);
  await server.analysisRunner.start({
    sessionId: session.id,
    locale: 'en',
    mode: 'memory',
    configId: config.id,
    consent: true
  });
  const status = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action']);
  assert.equal(status.status, 'partial', JSON.stringify(status));
  assert.equal(status.error.code, 'AI_IMPORT_INVALID');
  assert.ok(
    status.error.errors.some((item) => item.code === 'MEMORY_EVIDENCE_OTHER_VIEWER'),
    JSON.stringify(status.error)
  );
  assert.equal(calls, 3, 'whole-batch repair plus one bounded viewer repair');
  // Ref 1 is isolated; ref 2's own valid fact is still saved.
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM memory_facts').get().n, 1);
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM ai_results').get().n, 1);
  const facts = server.db.prepare('SELECT viewer_id FROM memory_facts').all();
  const failedViewer = status.error.errors
    .find((item) => item.code === 'MEMORY_EVIDENCE_OTHER_VIEWER')?.params?.viewerId;
  assert.ok(failedViewer, 'error names the invalid viewer');
  assert.ok(!facts.some((row) => row.viewer_id === failedViewer), 'invalid viewer got no fact');
});

test('a ref/seq number collision isolates only the mistaken viewer', async (t) => {
  const temp = createTempDir();
  const calls = [];
  let phase = 'first';
  const server = await startMockServer({
    temp,
    onMemory: ({info}) => {
      calls.push({size: info.refs.size, phase});
      const targetRef = info.refs.size === 1 ? 1 : 5;
      const otherRef = info.refs.size === 1 ? null : 3;
      const target = info.refs.get(targetRef);
      const other = otherRef ? info.refs.get(otherRef) : null;
      const viewers = [...info.refs.values()].map((entry) => {
        if (entry.ref === targetRef) {
          // Real production shape: ref 5's own seq is 3, while seq 5 belongs
          // to ref 3. The model incorrectly uses seq 5 for ref 5.
          const evidence = phase === 'second'
            ? entry.evidence[0]
            : (other?.evidence?.[0] ?? 5);
          return {
            ref: targetRef,
            memory: {
              no_new_information: false,
              operations: [{
                op: 'add',
                kind: 'interest',
                topic: phase === 'second' ? 'recovered' : 'guitar',
                statement: phase === 'second' ? 'recovered fact' : 'wrong evidence fact',
                certainty: 'stated',
                evidence: [evidence]
              }]
            }
          };
        }
        return {ref: entry.ref, memory: {no_new_information: true, operations: []}};
      });
      assert.ok(target, 'ref 5 exists');
      return jsonResponse({viewers});
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {
    id: 'ses_mem_ref_seq_collision',
    messageCount: 7,
    viewerCount: 7,
    startedAt: T0
  });
  const config = makeConfig(server);
  await server.analysisRunner.start({
    sessionId: session.id,
    locale: 'zh-CN',
    mode: 'memory',
    configId: config.id,
    consent: true
  });
  const partial = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action']);
  assert.equal(partial.status, 'partial', JSON.stringify(partial));
  assert.equal(partial.memoryJob.memoryCoverage.total, 7);
  assert.equal(partial.memoryJob.memoryCoverage.covered, 6);
  assert.equal(partial.memoryJob.memoryCoverage.failed, 1);
  const batchError = partial.memoryJob.batchErrors[0];
  assert.ok(batchError.errors.some((item) => item.code === 'MEMORY_EVIDENCE_OTHER_VIEWER'));
  const failedViewer = batchError.viewerErrors?.[0]?.viewerId ?? null;
  assert.ok(failedViewer, 'failed viewer is recorded');
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM memory_facts').get().n, 0);
  assert.equal(calls.filter((entry) => entry.phase === 'first' && entry.size === 7).length, 2);

  phase = 'second';
  await server.analysisRunner.resume(session.id, {consent: true});
  const complete = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action']);
  assert.equal(complete.status, 'complete', JSON.stringify(complete));
  assert.equal(complete.memoryJob.memoryCoverage.covered, 7);
  assert.equal(complete.memoryJob.memoryCoverage.failed, 0);
  const secondCalls = calls.filter((entry) => entry.phase === 'second');
  assert.equal(secondCalls.length, 1);
  assert.equal(secondCalls[0].size, 1, 'resume only sends the failed viewer');
  const fact = server.db.prepare('SELECT viewer_id, statement FROM memory_facts').get();
  assert.equal(fact.viewer_id, failedViewer);
  assert.equal(fact.statement, 'recovered fact');
});

test('a viewer-scoped repair can recover the rejected viewer automatically', async (t) => {
  const temp = createTempDir();
  const calls = [];
  const server = await startMockServer({
    temp,
    onMemory: ({info}) => {
      calls.push({size: info.refs.size});
      // Whole-batch attempts are invalid; the viewer-scoped retry (only one ref)
      // returns a valid fact with that viewer's own evidence.
      if (info.refs.size > 1) {
        return jsonResponse({viewers: missingEvidenceViewers(info)});
      }
      return jsonResponse({
        viewers: memoryViewers(info, {statement: 'recovered viewer fact', topic: 'recovered'})
      });
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {
    id: 'ses_mem_viewer_repair_success',
    messageCount: 2,
    viewerCount: 2,
    startedAt: T0
  });
  const config = makeConfig(server);
  await server.analysisRunner.start({
    sessionId: session.id,
    locale: 'en',
    mode: 'memory',
    configId: config.id,
    consent: true
  });
  const status = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action']);
  assert.equal(status.status, 'complete', JSON.stringify(status));
  assert.equal(status.memoryJob.memoryCoverage.covered, 2);
  assert.equal(status.memoryJob.memoryCoverage.failed, 0);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].size, 1, 'third call is scoped to the failed viewer');
  const fact = server.db.prepare('SELECT viewer_id, statement FROM memory_facts').get();
  assert.ok(fact);
  assert.equal(fact.statement, 'recovered viewer fact');
});

test('a Japanese task keeps Japanese long-term facts and the compact contract', async (t) => {
  const temp = createTempDir();
  const prompts = [];
  const server = await startMockServer({
    temp,
    onMemory: ({text, info}) => {
      prompts.push(text);
      return jsonResponse({
        viewers: memoryViewers(info, {statement: 'ギターを始めました', topic: 'ギター'})
      });
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {
    id: 'ses_mem_ja',
    messageCount: 4,
    viewerCount: 2,
    startedAt: T0
  });
  const config = makeConfig(server);
  await server.analysisRunner.start({
    sessionId: session.id,
    locale: 'ja',
    mode: 'memory',
    configId: config.id,
    consent: true
  });
  const status = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action']);
  assert.equal(status.status, 'complete', JSON.stringify(status));
  const fact = server.db.prepare('SELECT statement, topic FROM memory_facts').get();
  assert.equal(fact.statement, 'ギターを始めました');
  assert.equal(fact.topic, 'ギター');
  const stored = server.db.prepare('SELECT locale FROM ai_results WHERE batch_index = 1').get();
  assert.equal(stored.locale, 'ja');
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /自然で読みやすい日本語/);
  assert.match(prompts[0], /ギターを始めました/);
  assert.doesNotMatch(prompts[0], /"locale": "en"/);
  assert.match(prompts[0], /## 出力例（コンパクト）/);
});

test('four concurrent memory batches keep batch 2 failure after siblings succeed', async (t) => {
  const temp = createTempDir();
  const calls = [];
  let phase = 'first';
  const server = await startMockServer({
    temp,
    onMemory: ({info}) => {
      calls.push({batchId: info.batchId, phase, repair: info.repair, refs: info.refs.size});
      if (phase === 'first' && info.batchId?.endsWith('b02')) {
        return jsonResponse({viewers: missingEvidenceViewers(info)});
      }
      const suffix = info.batchId?.slice(-3) ?? 'bxx';
      return jsonResponse({
        viewers: memoryViewers(info, {statement: `Fact ${suffix}`, topic: `topic-${suffix}`})
      });
    }
  });
  const cleanup = [];
  t.after(async () => {
    for (const fn of cleanup.reverse()) await fn();
  });
  // Always close the primary server, even when an assertion fails before the
  // explicit restart below; otherwise the test process would keep the handle.
  cleanup.push(async () => {
    await server.close().catch(() => {});
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {
    id: 'ses_mem_concurrent_batches',
    messageCount: 40,
    viewerCount: 40,
    startedAt: T0
  });
  const config = makeConfig(server, {concurrency: 4});
  await server.analysisRunner.start({
    sessionId: session.id,
    locale: 'en',
    mode: 'memory',
    configId: config.id,
    consent: true
  });
  const failed = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action']);
  assert.equal(failed.status, 'partial', JSON.stringify(failed));
  assert.equal(failed.canResume, true);
  assert.equal(failed.memoryJob.memoryCoverage.total, 40);
  // 9 valid viewers of batch 2 are salvaged; only the invalid one waits.
  assert.equal(failed.memoryJob.memoryCoverage.covered, 39);
  assert.equal(failed.memoryJob.memoryCoverage.pending, 0);
  assert.equal(failed.memoryJob.memoryCoverage.failed, 1);
  assert.deepEqual(failed.memoryJob.failedBatches, [2]);
  const batchErrors = failed.memoryJob.batchErrors;
  assert.equal(batchErrors.length, 1, JSON.stringify(batchErrors));
  assert.equal(batchErrors[0].batchIndex, 2);
  assert.equal(batchErrors[0].code, 'AI_IMPORT_INVALID');
  assert.ok(batchErrors[0].errors.some((item) => item.code === 'MEMORY_EVIDENCE_REQUIRED'));
  // A successful sibling import must not clear batch 2's stored failure.
  const jobRow = server.db.prepare('SELECT last_error_code, last_error_json FROM ai_jobs WHERE id = ?')
    .get(failed.memoryJobId);
  assert.equal(jobRow.last_error_code, 'AI_IMPORT_INVALID');
  assert.deepEqual(JSON.parse(jobRow.last_error_json).batches.map((entry) => entry.batchIndex), [2]);
  const httpStatus = await fetch(
    `${server.url}api/ai/analyze/status?sessionId=${encodeURIComponent(session.id)}`
  ).then((response) => response.json());
  assert.equal(httpStatus.error.code, 'AI_IMPORT_INVALID');
  assert.ok(httpStatus.error.errors.some((item) => item.code === 'MEMORY_EVIDENCE_REQUIRED'));
  assert.equal(httpStatus.error.batchIndex, 2);
  assert.equal(httpStatus.error.stage, 'validation');
  assert.equal(httpStatus.memoryJob.batchErrors[0].batchIndex, 2);

  const report = await fetch(`${server.url}api/ai/sessions/${encodeURIComponent(session.id)}/report`)
    .then((response) => response.json());
  assert.deepEqual(report.longTermProfiles.stats, {
    jobId: failed.memoryJobId,
    status: 'partial',
    total: 40,
    processed: 39,
    semantic: 3,
    objectiveOnly: 36,
    pending: 0,
    failed: 1,
    failedBatches: [2],
    complete: false
  });

  const firstRunBatchCalls = calls.filter((entry) => entry.phase === 'first' && !entry.repair);
  assert.deepEqual([...new Set(firstRunBatchCalls.map((entry) => entry.batchId.slice(-3)))].sort(), [
    'b01', 'b02', 'b03', 'b04'
  ]);

  // Restart the process against the same isolated data directory.
  await server.close();
  phase = 'second';
  const restarted = await startMockServer({
    temp,
    onMemory: ({info}) => {
      calls.push({batchId: info.batchId, phase, repair: info.repair, refs: info.refs.size});
      return jsonResponse({
        viewers: memoryViewers(info, {
          statement: 'Fact after resume',
          topic: 'resumed-topic'
        })
      });
    }
  });
  cleanup.push(async () => {
    await restarted.close();
  });
  const beforeResume = restarted.analysisRunner.getStatus(session.id);
  assert.equal(beforeResume.status, 'partial');
  await restarted.analysisRunner.resume(session.id, {consent: true});
  const completed = await waitFor(restarted.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action']);
  assert.equal(completed.status, 'complete', JSON.stringify(completed));
  assert.equal(completed.memoryJob.memoryCoverage.covered, 40);
  assert.equal(completed.memoryJob.batchErrors.length, 0);
  const secondRunCalls = calls.filter((entry) => entry.phase === 'second');
  assert.equal(secondRunCalls.length, 1, JSON.stringify(secondRunCalls));
  assert.ok(secondRunCalls[0].batchId.endsWith('b02'), 'only the failed viewer batch is retried');
  assert.equal(secondRunCalls[0].refs, 1, 'only the failed viewer is sent, not the 9 salvaged ones');
  assert.equal(restarted.db.prepare('SELECT COUNT(*) AS n FROM memory_facts').get().n, 4);
  // Batch 2 now has the original partial result (v1) plus the recovery result
  // (v2) for the single failed viewer; results are not facts and are versioned.
  assert.equal(restarted.db.prepare('SELECT COUNT(*) AS n FROM ai_results').get().n, 5);

  // Re-submitting the same recovery result is an idempotent duplicate.
  const batchTwo = listResults(restarted.db, completed.memoryJobId, {includeJson: true})
    .filter((row) => row.batchIndex === 2)
    .sort((a, b) => b.resultVersion - a.resultVersion)[0];
  const failedViewerId = batchTwo.result.viewer_memory_updates?.[0]?.viewer_id ?? null;
  const duplicate = importAnalysisResult({
    db: restarted.db,
    text: JSON.stringify(batchTwo.result),
    source: 'api',
    viewerIds: failedViewerId ? [failedViewerId] : null
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(restarted.db.prepare('SELECT COUNT(*) AS n FROM memory_facts').get().n, 4);
  assert.equal(restarted.db.prepare('SELECT COUNT(*) AS n FROM ai_results').get().n, 5);
});

test('a failed validation batch does not block later batches when concurrency is 1', async (t) => {
  const temp = createTempDir();
  const requested = [];
  let phase = 'first';
  const server = await startMockServer({
    temp,
    onMemory: ({info}) => {
      requested.push({batchId: info.batchId, repair: info.repair, refs: info.refs.size, phase});
      if (phase === 'first' && info.batchId.endsWith('b01')) {
        return jsonResponse({viewers: missingEvidenceViewers(info)});
      }
      if (info.batchId.endsWith('b01')) {
        return jsonResponse({
          viewers: memoryViewers(info, {statement: 'recovered fact', topic: 'recovered'})
        });
      }
      return jsonResponse({
        viewers: memoryViewers(info, {
          statement: `fact ${info.batchId.slice(-3)}`,
          topic: `topic-${info.batchId.slice(-3)}`
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
    id: 'ses_mem_concurrency_one_continue',
    messageCount: 30,
    viewerCount: 30,
    startedAt: T0
  });
  const config = makeConfig(server, {concurrency: 1});
  await server.analysisRunner.start({
    sessionId: session.id,
    locale: 'en',
    mode: 'memory',
    configId: config.id,
    consent: true
  });
  const partial = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action']);
  assert.equal(partial.status, 'partial', JSON.stringify(partial));
  // b01: 9 valid + 1 failed; b02/b03 still run and import.
  assert.equal(partial.memoryJob.memoryCoverage.total, 30);
  assert.equal(partial.memoryJob.memoryCoverage.covered, 29);
  assert.equal(partial.memoryJob.memoryCoverage.failed, 1);
  assert.deepEqual(partial.memoryJob.failedBatches, [1]);
  const firstPhase = requested.filter((entry) => entry.phase === 'first');
  assert.deepEqual([...new Set(firstPhase.map((entry) => entry.batchId.slice(-3)))].sort(), [
    'b01', 'b02', 'b03'
  ]);
  assert.equal(firstPhase.filter((entry) => entry.batchId.endsWith('b01')).length, 3);

  phase = 'second';
  const failedViewerId = server.db.prepare(
    "SELECT viewer_id FROM ai_job_memory_viewers WHERE job_id = ? AND status = 'failed'"
  ).get(partial.memoryJobId)?.viewer_id ?? null;
  assert.ok(failedViewerId);
  await server.analysisRunner.resume(session.id, {consent: true});
  const complete = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action']);
  assert.equal(complete.status, 'complete', JSON.stringify(complete));
  assert.equal(complete.memoryJob.memoryCoverage.covered, 30);
  const secondPhase = requested.filter((entry) => entry.phase === 'second');
  assert.equal(secondPhase.length, 1);
  assert.ok(secondPhase[0].batchId.endsWith('b01'));
  assert.equal(secondPhase[0].refs, 1, 'resume sends only the failed viewer');
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM memory_facts').get().n, 3);
});

test('session success with a failed memory half is partial and keeps the report', async (t) => {
  const temp = createTempDir();
  const server = await startMockServer({
    temp,
    sessionUsage: {input: 100, output: 20},
    onMemory: ({info}) => jsonResponse({viewers: missingEvidenceViewers(info)})
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {
    id: 'ses_mem_partial_both',
    messageCount: 4,
    viewerCount: 2,
    startedAt: T0
  });
  const config = makeConfig(server);
  await server.analysisRunner.start({
    sessionId: session.id,
    locale: 'en',
    mode: 'both',
    configId: config.id,
    consent: true
  });
  const status = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action']);
  assert.equal(status.status, 'partial', JSON.stringify(status));
  assert.equal(status.sessionReportDone, true);
  assert.equal(status.memoryDone, false);
  assert.equal(status.saved.sessionReport, true);
  assert.equal(status.saved.memory, false);
  assert.equal(status.error.code, 'AI_IMPORT_INVALID');
  assert.equal(status.canResume, true);
  const report = await fetch(`${server.url}api/ai/sessions/${encodeURIComponent(session.id)}/report`)
    .then((response) => response.json());
  assert.equal(report.mode, 'single');
  assert.equal(report.report.summary, 'Synthetic session summary');
  assert.equal(report.longTermProfiles.stats.total, 2);
  assert.equal(report.longTermProfiles.stats.processed, 1);
  assert.equal(report.longTermProfiles.stats.pending, 0);
  assert.equal(report.longTermProfiles.stats.failed, 1);
});

test('usage is attributed to the child job that made each request', async (t) => {
  const temp = createTempDir();
  const server = await startMockServer({
    temp,
    sessionUsage: {input: 100, output: 20},
    memoryUsage: {input: 50, output: 10},
    onMemory: ({info}) => jsonResponse({viewers: memoryViewers(info)}, {input: 50, output: 10})
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = seedSession(server.db, {
    id: 'ses_mem_usage',
    messageCount: 4,
    viewerCount: 2,
    startedAt: T0
  });
  const config = makeConfig(server);
  await server.analysisRunner.start({
    sessionId: session.id,
    locale: 'en',
    mode: 'both',
    configId: config.id,
    consent: true
  });
  const status = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action']);
  assert.equal(status.status, 'complete', JSON.stringify(status));
  assert.equal(status.sessionJob.usage.requests, 1, JSON.stringify(status.sessionJob.usage));
  assert.equal(status.memoryJob.usage.requests, 1, JSON.stringify(status.memoryJob.usage));
  assert.equal(status.sessionJob.usage.inputTokens, 100);
  assert.equal(status.memoryJob.usage.inputTokens, 50);
  assert.equal(status.memoryJob.usage.outputTokens, 10);
  assert.equal(status.usage.requests, 2, JSON.stringify({total: status.usage, byJob: status.usageByJob}));
  assert.equal(status.usage.inputTokens, 150);
  assert.equal(status.usage.outputTokens, 30);
  assert.ok(status.usage.cost, 'both halves have known pricing');
  assert.ok(status.usage.cost.amount > 0);
});

test('a gift-only viewer is processed as objective history, not a failed profile', async (t) => {
  const temp = createTempDir();
  const observedRefs = [];
  const server = await startMockServer({
    temp,
    onMemory: ({info}) => {
      observedRefs.push(info.refs);
      const viewers = [...info.refs.values()].map((entry) => {
        if (entry.zeroExcerpt) {
          return {ref: entry.ref, memory: {no_new_information: true, operations: []}};
        }
        return {ref: entry.ref, memory: {no_new_information: true, operations: []}};
      });
      return jsonResponse({viewers});
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  addBroadcaster(server.db);
  const session = createSession(server.db, {
    platform: 'youtube',
    platformRoomId: 'gift-room',
    roomTitle: 'Gift only test',
    broadcasterName: 'AI Test Broadcaster',
    broadcasterId: 'youtube:UC_AI_TEST',
    broadcasterIdentity: 'verified',
    storageMode: 'full',
    sourceQuality: 'mock',
    simulated: true,
    startedAt: T0
  });
  const ingest = new EventIngest({db: server.db});
  for (let index = 0; index < 4; index += 1) {
    ingest.record({
      session_id: session.id,
      platform: 'youtube',
      event_type: 'chat',
      viewer_uid: `UC_CHAT_${index % 2}`,
      display_name: `Chat ${index % 2}`,
      occurred_at: T0 + 1000 + index * 1000,
      content: index === 0 ? 'こんにちは' : `Message ${index}`,
      external_id: `chat-${session.id}-${index}`,
      source_quality: 'mock'
    });
  }
  ingest.record({
    ...giftEvent({
      platform: 'youtube',
      viewer_uid: 'UC_GIFT_ONLY',
      display_name: 'Gift Only',
      occurred_at: T0 + 6000,
      external_id: `gift-${session.id}`
    }),
    session_id: session.id
  });
  endSession(server.db, session.id, {
    status: 'ended',
    endedAt: T0 + 7000,
    reason: 'adapter_end'
  });
  const config = makeConfig(server);
  await server.analysisRunner.start({
    sessionId: session.id,
    locale: 'en',
    mode: 'memory',
    configId: config.id,
    consent: true
  });
  const status = await waitFor(server.analysisRunner, session.id, ['complete', 'failed', 'partial', 'needs_action']);
  assert.equal(status.status, 'complete', JSON.stringify(status));
  assert.equal(status.memoryJob.memoryCoverage.total, 3);
  assert.equal(status.memoryJob.memoryCoverage.pending, 0);
  assert.equal(status.memoryJob.memoryCoverage.no_semantics, 3);
  assert.ok(observedRefs[0].size >= 1);
  assert.ok([...observedRefs[0].values()].some((entry) => entry.zeroExcerpt === true),
    'the gift-only viewer is sent with zero_excerpt=true');
  const giftMemory = server.db.prepare('SELECT status FROM viewer_memories WHERE viewer_id = ?')
    .get('youtube:UC_GIFT_ONLY');
  assert.ok(giftMemory, 'objective memory header exists for the gift-only viewer');
  assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM memory_facts').get().n, 0);
});
