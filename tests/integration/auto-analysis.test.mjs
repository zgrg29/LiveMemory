import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {openMemoryDb, addBroadcaster, seedSession, T0, HOUR} from '../helpers/ai-fixtures.mjs';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {AutoAnalysisRunner} from '../../src/ai/auto/runner.mjs';
import {AutoAnalysisError} from '../../src/ai/auto/errors.mjs';
import {createAnalysisJob} from '../../src/ai/export/job.mjs';
import {buildBatchPrompt, readBatchPackage} from '../../src/ai/auto/prompt.mjs';
import {importAnalysisResult} from '../../src/ai/import/importer.mjs';
import {getJob, jobMemoryCoverage} from '../../src/storage/repositories/ai-jobs.mjs';
import {listResults} from '../../src/storage/repositories/ai-results.mjs';
import {getMemory, listFacts} from '../../src/storage/repositories/viewer-memory.mjs';
import {computeJobStatus} from '../../src/ai/tasks/status.mjs';

/**
 * Automatic analysis is exercised with an injected transport. No external
 * service is called here; the real anonymous-provider probe lives in
 * scripts/probe-anonymous-ai.mjs and docs/ANONYMOUS_AI_RESEARCH.md.
 */

function provider(id = 'mock') {
  return {id, label: id, model: `${id}-model`, rateLimit: {limit: 1000, windowMs: 1}};
}

function makeResult(prompt, kind = 'batch', {updates = null, summary = 'Synthetic result'} = {}) {
  const manifest = prompt.manifest;
  const result = {
    protocol: 'livememory-analysis-result-v1',
    schema_version: '1.2.0',
    job_id: manifest.job_id,
    ...(kind === 'batch' ? {batch_id: manifest.batch.batch_id} : {}),
    broadcaster_id: manifest.broadcaster_id,
    task_id: manifest.tasks[0].task_id,
    session_id: manifest.session_id,
    locale: manifest.locale,
    session_topics: {
      summary,
      topics: [],
      sentiment: [],
      disputes: [],
      highlights: []
    },
    viewer_profiles: [],
    viewer_memory_updates: updates ?? (kind === 'batch'
      ? prompt.viewerIds.map((viewer_id) => ({
        viewer_id,
        no_new_information: true,
        operations: []
      }))
      : [])
  };
  return result;
}

function firstExcerptSeq(prompt, viewerId) {
  const block = prompt.user.split('## viewer_excerpts.jsonl\n')[1]?.split('\n\n## ')[0] ?? '';
  for (const line of block.trim().split('\n').filter(Boolean)) {
    try {
      const entry = JSON.parse(line);
      if (entry.viewer_id === viewerId && Number.isInteger(entry.seq)) return entry.seq;
    } catch {
      /* skip malformed synthetic line */
    }
  }
  return 1;
}

function setup(t, {messageCount = 4, viewerCount = 2, prefix = 'UC_AUTO' } = {}) {
  const db = openMemoryDb();
  addBroadcaster(db);
  const temp = createTempDir();
  mkdirSync(join(temp.dir, 'runtime'), {recursive: true});
  const session = seedSession(db, {
    id: `ses_${prefix}`,
    messageCount,
    viewerCount,
    viewerUidPrefix: prefix,
    startedAt: T0
  });
  const paths = {
    root: temp.dir,
    runtime: join(temp.dir, 'runtime'),
    exports: join(temp.dir, 'exports')
  };
  t.after(() => {
    db.close();
    temp.cleanup();
  });
  return {db, temp, session, paths};
}

function runnerFor({db, paths, transport, providers = [provider()]}) {
  return new AutoAnalysisRunner({
    db,
    paths,
    now: () => T0,
    providers,
    transport
  });
}

async function waitFor(runner, sessionId, timeoutMs = 8000) {
  const started = Date.now();
  for (;;) {
    const status = runner.getStatus(sessionId);
    if (!status.running) return status;
    if (Date.now() - started > timeoutMs) throw new Error('auto runner did not finish');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('a single-batch automatic run imports through the normal transaction', async (t) => {
  const {db, session, paths} = setup(t);
  let calls = 0;
  const runner = runnerFor({
    db,
    paths,
    transport: async ({prompt, kind}) => {
      calls += 1;
      return {content: JSON.stringify(makeResult(prompt, kind)), providerId: 'mock'};
    }
  });
  const started = await runner.start({sessionId: session.id, locale: 'en', consent: true});
  assert.equal(started.running, true);
  const final = await waitFor(runner, session.id);
  assert.equal(final.status, 'complete');
  assert.equal(final.job.state, 'complete');
  assert.equal(calls, 1);
  const result = db.prepare('SELECT source, scope_key FROM ai_results').get();
  assert.equal(result.source, 'auto');
  const coverage = jobMemoryCoverage(db, final.jobId);
  assert.equal(coverage.total, 2);
  assert.equal(coverage.no_semantics, 2);
  assert.equal(coverage.complete, true);
});

test('multi-batch runs import every batch, then the stage-2 aggregate', async (t) => {
  const {db, session, paths} = setup(t, {messageCount: 700, viewerCount: 5, prefix: 'UC_AUTO_MULTI'});
  const kinds = [];
  const runner = runnerFor({
    db,
    paths,
    transport: async ({prompt, kind}) => {
      kinds.push(kind);
      return {content: JSON.stringify(makeResult(prompt, kind)), providerId: 'mock'};
    }
  });
  await runner.start({sessionId: session.id, locale: 'en', consent: true});
  const final = await waitFor(runner, session.id);
  assert.equal(final.status, 'complete');
  assert.equal(final.job.batchTotal, 3);
  assert.deepEqual(kinds, ['batch', 'batch', 'batch', 'aggregate']);
  const scopes = db.prepare('SELECT scope_key FROM ai_results ORDER BY scope_key').all().map((row) => row.scope_key);
  assert.deepEqual(scopes, ['batch:1', 'batch:2', 'batch:3', 'final']);
});

test('the second provider is used when the first one fails', async (t) => {
  const {db, session, paths} = setup(t);
  const runner = runnerFor({
    db,
    paths,
    providers: [provider('first'), provider('second')],
    transport: async ({provider: current, prompt, kind}) => {
      if (current.id === 'first') {
        throw new AutoAnalysisError('AUTO_PROVIDER_UNAVAILABLE', {detail: 'network', providerId: 'first'});
      }
      return {content: JSON.stringify(makeResult(prompt, kind)), providerId: 'second'};
    }
  });
  await runner.start({sessionId: session.id, locale: 'en', consent: true});
  const final = await waitFor(runner, session.id);
  assert.equal(final.status, 'complete');
  assert.equal(final.lastProvider, 'second');
});

test('all providers failing leaves a clean failure and writes no result', async (t) => {
  const {db, session, paths} = setup(t);
  const runner = runnerFor({
    db,
    paths,
    transport: async () => {
      throw new AutoAnalysisError('AUTO_PROVIDER_UNAVAILABLE', {detail: 'offline'});
    }
  });
  await runner.start({sessionId: session.id, locale: 'en', consent: true});
  const final = await waitFor(runner, session.id);
  assert.equal(final.status, 'failed');
  assert.equal(final.error.code, 'AUTO_ALL_PROVIDERS_FAILED');
  assert.equal(listResults(db, final.jobId).length, 0);
  assert.equal(jobMemoryCoverage(db, final.jobId).pending, 2);
});

test('a schema-invalid answer is repaired once and then imported', async (t) => {
  const {db, session, paths} = setup(t);
  let calls = 0;
  const runner = runnerFor({
    db,
    paths,
    transport: async ({prompt, kind}) => {
      calls += 1;
      const result = makeResult(prompt, kind);
      if (calls === 1) {
        // Missing viewer_memory_updates must be rejected, not silently covered.
        delete result.viewer_memory_updates;
      }
      return {content: JSON.stringify(result), providerId: 'mock'};
    }
  });
  await runner.start({sessionId: session.id, locale: 'en', consent: true});
  const final = await waitFor(runner, session.id);
  assert.equal(final.status, 'complete');
  assert.equal(calls, 2);
});

test('a wrong evidence sequence is rejected without a partial import', async (t) => {
  const {db, session, paths} = setup(t);
  const runner = runnerFor({
    db,
    paths,
    transport: async ({prompt, kind}) => {
      const result = makeResult(prompt, kind);
      if (kind === 'batch' && result.viewer_memory_updates.length > 0) {
        result.viewer_memory_updates[0] = {
          viewer_id: prompt.viewerIds[0],
          no_new_information: false,
          operations: [{
            op: 'add',
            kind: 'interest',
            topic: 'synthetic',
            statement: 'synthetic fact',
            certainty: 'stated',
            confidence: 0.9,
            evidence: [99999]
          }]
        };
      }
      return {content: JSON.stringify(result), providerId: 'mock'};
    }
  });
  await runner.start({sessionId: session.id, locale: 'en', consent: true});
  const final = await waitFor(runner, session.id);
  assert.equal(final.status, 'failed');
  assert.equal(final.error.code, 'AUTO_SCHEMA_INVALID');
  assert.equal(listResults(db, final.jobId).length, 0);
});

test('a later batch failure keeps earlier batch results and resumes without re-requesting them', async (t) => {
  const {db, session, paths} = setup(t, {messageCount: 700, viewerCount: 5, prefix: 'UC_AUTO_PARTIAL'});
  let batchCalls = 0;
  const first = runnerFor({
    db,
    paths,
    transport: async ({prompt, kind}) => {
      if (kind === 'batch') {
        batchCalls += 1;
        if (batchCalls === 2) throw new Error('synthetic network failure');
      }
      return {content: JSON.stringify(makeResult(prompt, kind)), providerId: 'mock'};
    }
  });
  await first.start({sessionId: session.id, locale: 'en', consent: true});
  const failed = await waitFor(first, session.id);
  assert.equal(failed.status, 'failed');
  assert.deepEqual(listResults(db, failed.jobId).map((row) => row.scopeKey), ['batch:1']);
  assert.equal(computeJobStatus(db, getJob(db, failed.jobId)).status, 'partial');

  const resumedCalls = [];
  const second = runnerFor({
    db,
    paths,
    transport: async ({prompt, kind}) => {
      resumedCalls.push(kind);
      return {content: JSON.stringify(makeResult(prompt, kind)), providerId: 'mock'};
    }
  });
  await second.start({sessionId: session.id, locale: 'en', consent: true});
  const complete = await waitFor(second, session.id);
  assert.equal(complete.status, 'complete');
  assert.deepEqual(resumedCalls, ['batch', 'batch', 'aggregate']);
  const scopes = db.prepare('SELECT scope_key FROM ai_results ORDER BY scope_key').all().map((row) => row.scope_key);
  assert.deepEqual(scopes, ['batch:1', 'batch:2', 'batch:3', 'final']);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM ai_results WHERE scope_key = 'batch:1'").get().c, 1);
});

test('duplicate clicks are rejected while a run is active', async (t) => {
  const {db, session, paths} = setup(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const runner = runnerFor({
    db,
    paths,
    transport: async ({prompt, kind}) => {
      await gate;
      return {content: JSON.stringify(makeResult(prompt, kind)), providerId: 'mock'};
    }
  });
  await runner.start({sessionId: session.id, locale: 'en', consent: true});
  await assert.rejects(
    () => runner.start({sessionId: session.id, locale: 'en', consent: true}),
    (error) => error instanceof AutoAnalysisError && error.code === 'AUTO_ALREADY_RUNNING'
  );
  release();
  const final = await waitFor(runner, session.id);
  assert.equal(final.status, 'complete');
});

test('a canceled run can be resumed without losing imported batches', async (t) => {
  const {db, session, paths} = setup(t, {messageCount: 700, viewerCount: 5, prefix: 'UC_AUTO_CANCEL'});
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = runnerFor({
    db,
    paths,
    transport: async ({prompt, kind}) => {
      await gate;
      return {content: JSON.stringify(makeResult(prompt, kind)), providerId: 'mock'};
    }
  });
  await first.start({sessionId: session.id, locale: 'en', consent: true});
  first.cancel(session.id);
  release();
  const canceled = await waitFor(first, session.id);
  assert.equal(canceled.status, 'canceled');
  assert.equal(canceled.canResume, true);

  const second = runnerFor({
    db,
    paths,
    transport: async ({prompt, kind}) => ({
      content: JSON.stringify(makeResult(prompt, kind)),
      providerId: 'mock'
    })
  });
  await second.start({sessionId: session.id, locale: 'en', consent: true});
  const complete = await waitFor(second, session.id);
  assert.equal(complete.status, 'complete');
});

test('a restart marks the run interrupted and the same job can resume', async (t) => {
  const {db, session, paths} = setup(t, {messageCount: 700, viewerCount: 5, prefix: 'UC_AUTO_RESTART'});
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = runnerFor({
    db,
    paths,
    transport: async ({prompt, kind}) => {
      if (kind === 'batch') await gate;
      return {content: JSON.stringify(makeResult(prompt, kind)), providerId: 'mock'};
    }
  });
  await first.start({sessionId: session.id, locale: 'en', consent: true});
  // Let the first batch finish, then simulate process shutdown while a later
  // request is in flight.
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await first.shutdown();
  const second = runnerFor({
    db,
    paths,
    transport: async ({prompt, kind}) => ({
      content: JSON.stringify(makeResult(prompt, kind)),
      providerId: 'mock'
    })
  });
  const interrupted = second.getStatus(session.id);
  assert.ok(['interrupted', 'running'].includes(interrupted.status));
  await second.start({sessionId: session.id, locale: 'en', consent: true});
  const complete = await waitFor(second, session.id);
  assert.equal(complete.status, 'complete');
});

test('an aggregate failure keeps every validated batch result', async (t) => {
  const {db, session, paths} = setup(t, {messageCount: 700, viewerCount: 5, prefix: 'UC_AUTO_AGG_FAIL'});
  const runner = runnerFor({
    db,
    paths,
    transport: async ({prompt, kind}) => {
      const result = makeResult(prompt, kind);
      if (kind === 'aggregate') {
        // Aggregate answers may not update long-term memory.
        result.viewer_memory_updates = [{
          viewer_id: prompt.manifest.session_id,
          no_new_information: true,
          operations: []
        }];
      }
      return {content: JSON.stringify(result), providerId: 'mock'};
    }
  });
  await runner.start({sessionId: session.id, locale: 'en', consent: true});
  const final = await waitFor(runner, session.id);
  assert.equal(final.status, 'failed');
  assert.equal(listResults(db, final.jobId).filter((row) => row.scopeKey === 'final').length, 0);
  assert.equal(listResults(db, final.jobId).filter((row) => row.batchIndex !== null).length, 3);
  assert.equal(computeJobStatus(db, getJob(db, final.jobId)).status, 'awaiting_aggregate');
});

test('a failed automatic run does not overwrite existing long-term memory', async (t) => {
  const {db, session, paths} = setup(t, {messageCount: 1, viewerCount: 1, prefix: 'UC_AUTO_KEEP'});
  // Create a prior session for the same stable viewer and import one real fact.
  const prior = seedSession(db, {
    id: 'ses_prior_memory',
    messageCount: 1,
    viewerCount: 1,
    viewerUidPrefix: 'UC_AUTO_KEEP',
    startedAt: T0 - HOUR
  });
  db.prepare('UPDATE events SET content = ? WHERE session_id = ?').run('我最近在学画画', prior.id);
  const priorJob = await createAnalysisJob({
    db,
    sessionId: prior.id,
    locale: 'en',
    exportsDir: paths.exports,
    now: T0 - HOUR + 1000
  });
  const priorFiles = readBatchPackage(paths.exports, priorJob.packages[0].fileName);
  const priorPrompt = buildBatchPrompt(priorFiles);
  const viewerId = priorPrompt.viewerIds[0];
  const evidence = firstExcerptSeq(priorPrompt, viewerId);
  const priorResult = makeResult(priorPrompt, 'batch', {
    updates: [{
      viewer_id: viewerId,
      no_new_information: false,
      operations: [{
        op: 'add',
        kind: 'interest',
        topic: '绘画',
        statement: '最近在学画画',
        certainty: 'stated',
        confidence: 0.9,
        evidence: [evidence]
      }]
    }]
  });
  importAnalysisResult({db, text: JSON.stringify(priorResult), now: T0 - HOUR + 2000});
  const memoryBefore = getMemory(db, {broadcasterId: 'youtube:UC_AI_TEST', viewerId});
  const factsBefore = listFacts(db, memoryBefore.id, {limit: 100});
  assert.ok(factsBefore.some((fact) => fact.statement.includes('画画')));

  const runner = runnerFor({
    db,
    paths,
    transport: async () => {
      throw new Error('synthetic failure');
    }
  });
  await runner.start({sessionId: session.id, locale: 'en', consent: true});
  const final = await waitFor(runner, session.id);
  assert.equal(final.status, 'failed');
  const memoryAfter = getMemory(db, {broadcasterId: 'youtube:UC_AI_TEST', viewerId});
  const factsAfter = listFacts(db, memoryAfter.id, {limit: 100});
  assert.deepEqual(
    factsAfter.map((fact) => [fact.id, fact.statement, fact.status]),
    factsBefore.map((fact) => [fact.id, fact.statement, fact.status])
  );
  assert.equal(memoryAfter.version, memoryBefore.version);
});

test('a successful automatic run followed by the same import is a duplicate', async (t) => {
  const {db, session, paths} = setup(t);
  const runner = runnerFor({
    db,
    paths,
    transport: async ({prompt, kind}) => ({
      content: JSON.stringify(makeResult(prompt, kind)),
      providerId: 'mock'
    })
  });
  await runner.start({sessionId: session.id, locale: 'en', consent: true});
  const final = await waitFor(runner, session.id);
  assert.equal(final.status, 'complete');
  const row = db.prepare("SELECT result_json FROM ai_results WHERE scope_key = 'batch:1'").get();
  const before = db.prepare('SELECT COUNT(*) AS c FROM ai_results').get().c;
  const duplicate = importAnalysisResult({db, text: row.result_json});
  assert.equal(duplicate.duplicate, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM ai_results').get().c, before);
});
