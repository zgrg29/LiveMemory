import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {openMemoryDb, addBroadcaster, seedSession, T0, HOUR} from '../helpers/ai-fixtures.mjs';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {AutoAnalysisRunner} from '../../src/ai/auto/runner.mjs';
import {jobMemoryCoverage} from '../../src/storage/repositories/ai-jobs.mjs';
import {listResults} from '../../src/storage/repositories/ai-results.mjs';

/**
 * Compact automatic protocol (v0.12.1): the model returns `ref` numbers, the
 * runner maps them to the exact assigned viewer ids and re-validates the
 * assembled Schema 1.2.0 result. These are local tests with an injected
 * transport; the real anonymous-provider probe lives in
 * docs/ANONYMOUS_AI_RESEARCH.md.
 */

function provider(id = 'mock') {
  return {id, label: id, model: `${id}-model`, rateLimit: {limit: 1000, windowMs: 1}};
}

function compactAnswer(prompt, {omit = []} = {}) {
  return {
    session_topics: {
      summary: 'Synthetic compact result',
      topics: [],
      sentiment: [],
      disputes: [],
      highlights: []
    },
    viewers: prompt.viewerRefs
      .filter((entry) => !omit.includes(entry.ref))
      .map((entry) => ({
        ref: entry.ref,
        memory: {no_new_information: true, operations: []}
      }))
  };
}

function aggregateAnswer(prompt) {
  const manifest = prompt.manifest;
  return {
    protocol: 'livememory-analysis-result-v1',
    schema_version: '1.2.0',
    job_id: manifest.job_id,
    broadcaster_id: manifest.broadcaster_id,
    task_id: manifest.tasks[0].task_id,
    session_id: manifest.session_id,
    locale: manifest.locale,
    session_topics: {
      summary: 'Synthetic aggregate',
      topics: [],
      sentiment: [],
      disputes: [],
      highlights: []
    },
    viewer_profiles: [],
    viewer_memory_updates: []
  };
}

function setup(t, {messageCount = 99, viewerCount = 52, prefix = 'UC_COMPACT'} = {}) {
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

function runnerFor({db, paths, transport}) {
  return new AutoAnalysisRunner({
    db,
    paths,
    now: () => T0,
    providers: [provider()],
    transport
  });
}

async function waitFor(runner, sessionId, timeoutMs = 20000) {
  const started = Date.now();
  for (;;) {
    const status = runner.getStatus(sessionId);
    if (!status.running) return status;
    if (Date.now() - started > timeoutMs) throw new Error('auto runner did not finish');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('52 viewers and 99 messages are split into six batches and fully covered', async (t) => {
  const {db, session, paths} = setup(t);
  const calls = [];
  const runner = runnerFor({
    db,
    paths,
    transport: async ({prompt, kind}) => {
      calls.push({kind, refs: prompt.viewerRefs?.length ?? 0});
      if (kind === 'batch') {
        return {content: JSON.stringify(compactAnswer(prompt)), providerId: 'mock', finishReason: 'stop'};
      }
      return {content: JSON.stringify(aggregateAnswer(prompt)), providerId: 'mock', finishReason: 'stop'};
    }
  });
  await runner.start({sessionId: session.id, locale: 'ja', consent: true});
  const final = await waitFor(runner, session.id);
  assert.equal(final.status, 'complete');
  assert.equal(final.job.batchTotal, 6);
  assert.equal(final.job.memoryCoverage.total, 52);
  assert.equal(final.job.memoryCoverage.no_semantics, 52);
  assert.equal(final.job.memoryCoverage.missing_update, 0);
  assert.equal(final.job.memoryCoverage.complete, true);
  assert.equal(calls.filter((entry) => entry.kind === 'batch').length, 6);
  assert.equal(calls.filter((entry) => entry.kind === 'aggregate').length, 1);
  const scopes = listResults(db, final.jobId).map((row) => row.scopeKey).sort();
  assert.deepEqual(scopes, ['batch:1', 'batch:2', 'batch:3', 'batch:4', 'batch:5', 'batch:6', 'final']);
  const coverage = jobMemoryCoverage(db, final.jobId);
  assert.equal(coverage.total, 52);
  assert.equal(coverage.complete, true);
});

test('100 low-activity viewers still get one entry each across ten batches', async (t) => {
  const {db, session, paths} = setup(t, {messageCount: 100, viewerCount: 100, prefix: 'UC_LOW100'});
  const runner = runnerFor({
    db,
    paths,
    transport: async ({prompt, kind}) => {
      if (kind === 'batch') {
        return {content: JSON.stringify(compactAnswer(prompt)), providerId: 'mock'};
      }
      return {content: JSON.stringify(aggregateAnswer(prompt)), providerId: 'mock'};
    }
  });
  await runner.start({sessionId: session.id, locale: 'ja', consent: true});
  const final = await waitFor(runner, session.id);
  assert.equal(final.status, 'complete');
  assert.equal(final.job.batchTotal, 10);
  assert.equal(final.job.memoryCoverage.total, 100);
  assert.equal(final.job.memoryCoverage.no_semantics, 100);
  assert.equal(final.job.memoryCoverage.complete, true);
  assert.equal(listResults(db, final.jobId).filter((row) => row.batchIndex !== null).length, 10);
});

test('a missing ref triggers one targeted supplement for exactly that viewer', async (t) => {
  const {db, session, paths} = setup(t, {messageCount: 12, viewerCount: 4, prefix: 'UC_TARGETED'});
  const kinds = [];
  let omittedViewerId = null;
  let targetedPrompt = null;
  const runner = runnerFor({
    db,
    paths,
    transport: async ({prompt, kind, purpose}) => {
      kinds.push(purpose === 'targeted' ? 'targeted' : kind);
      if (kind === 'batch' && purpose !== 'targeted') {
        const omitRef = prompt.viewerRefs.length > 1 ? prompt.viewerRefs[1].ref : prompt.viewerRefs[0].ref;
        omittedViewerId = prompt.viewerRefs.find((entry) => entry.ref === omitRef).viewerId;
        return {content: JSON.stringify(compactAnswer(prompt, {omit: [omitRef]})), providerId: 'mock'};
      }
      if (purpose === 'targeted') {
        targetedPrompt = prompt;
        return {
          content: JSON.stringify({
            viewers: prompt.viewerRefs.map((entry) => ({
              ref: entry.ref,
              memory: {no_new_information: true, operations: []}
            }))
          }),
          providerId: 'mock'
        };
      }
      return {content: JSON.stringify(aggregateAnswer(prompt)), providerId: 'mock'};
    }
  });
  await runner.start({sessionId: session.id, locale: 'en', consent: true});
  const final = await waitFor(runner, session.id);
  assert.equal(final.status, 'complete', JSON.stringify(final.error));
  assert.deepEqual(kinds, ['batch', 'targeted']);
  assert.equal(targetedPrompt.viewerRefs.length, 1);
  assert.equal(targetedPrompt.viewerRefs[0].viewerId, omittedViewerId);
  assert.equal(jobMemoryCoverage(db, final.jobId).missing_update, 0);
});

test('an incomplete supplement fails the batch without importing anything', async (t) => {
  const {db, session, paths} = setup(t, {messageCount: 8, viewerCount: 3, prefix: 'UC_INCOMPLETE'});
  const runner = runnerFor({
    db,
    paths,
    transport: async ({prompt, kind, purpose}) => {
      if (kind === 'batch' && purpose !== 'targeted') {
        return {content: JSON.stringify(compactAnswer(prompt, {omit: [1]})), providerId: 'mock'};
      }
      if (purpose === 'targeted') {
        return {content: JSON.stringify({viewers: []}), providerId: 'mock'};
      }
      return {content: JSON.stringify(aggregateAnswer(prompt)), providerId: 'mock'};
    }
  });
  await runner.start({sessionId: session.id, locale: 'en', consent: true});
  const final = await waitFor(runner, session.id);
  assert.equal(final.status, 'failed');
  assert.equal(final.error.code, 'AUTO_VIEWER_COVERAGE_INCOMPLETE');
  assert.equal(listResults(db, final.jobId).length, 0);
});

test('a truncated answer is reported as truncation, not a generic schema error', async (t) => {
  const {db, session, paths} = setup(t, {messageCount: 4, viewerCount: 2, prefix: 'UC_TRUNC'});
  const runner = runnerFor({
    db,
    paths,
    transport: async () => ({
      content: '{"session_topics":',
      providerId: 'mock',
      finishReason: 'length'
    })
  });
  await runner.start({sessionId: session.id, locale: 'en', consent: true});
  const final = await waitFor(runner, session.id);
  assert.equal(final.status, 'failed');
  assert.equal(final.error.code, 'AUTO_OUTPUT_TRUNCATED');
  assert.equal(listResults(db, final.jobId).length, 0);
});

test('a viewer with no excerpt still needs, and receives, a memory entry', async (t) => {
  const {db, session, paths} = setup(t, {messageCount: 3, viewerCount: 2, prefix: 'UC_ZERO'});
  // Add a payment-only identity with zero chat messages through the normal
  // ingest path, then refresh the session window so the analysis sees it.
  const {EventIngest} = await import('../../src/platforms/shared/ingest.mjs');
  db.prepare("UPDATE sessions SET status = 'live', ended_at = NULL WHERE id = ?").run(session.id);
  const ingest = new EventIngest({db, now: () => T0 + HOUR});
  ingest.record({
    session_id: session.id,
    platform: 'youtube',
    event_type: 'super_sticker',
    viewer_uid: 'UC_ZERO',
    display_name: 'Zero Chat',
    occurred_at: T0 + 4000,
    content: null,
    amount_minor: 100,
    unit_amount_minor: 100,
    currency: 'JPY',
    value_kind: 'actual',
    is_paid: true,
    external_id: 'zero-sticker-1',
    source_quality: 'mock'
  });
  db.prepare("UPDATE sessions SET status = 'ended', ended_at = ? WHERE id = ?").run(T0 + 5000, session.id);

  let zeroRef = null;
  let targetedUser = null;
  const runner = runnerFor({
    db,
    paths,
    transport: async ({prompt, kind, purpose}) => {
      if (kind === 'batch' && purpose !== 'targeted') {
        const zero = prompt.viewerRefs.find((entry) => entry.zeroExcerpt);
        zeroRef = zero?.ref ?? null;
        return {
          content: JSON.stringify(compactAnswer(prompt, {omit: zero ? [zero.ref] : []})),
          providerId: 'mock'
        };
      }
      if (purpose === 'targeted') {
        targetedUser = prompt.user;
        return {
          content: JSON.stringify({
            viewers: prompt.viewerRefs.map((entry) => ({
              ref: entry.ref,
              memory: {no_new_information: true, operations: []}
            }))
          }),
          providerId: 'mock'
        };
      }
      return {content: JSON.stringify(aggregateAnswer(prompt)), providerId: 'mock'};
    }
  });
  await runner.start({sessionId: session.id, locale: 'en', consent: true});
  const final = await waitFor(runner, session.id);
  assert.equal(final.status, 'complete');
  assert.equal(jobMemoryCoverage(db, final.jobId).missing_update, 0);
  assert.ok(zeroRef);
  assert.match(targetedUser, /no chat excerpts/);
});
