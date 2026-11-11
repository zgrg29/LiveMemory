import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {openMemoryDb, addBroadcaster, seedSession, T0, HOUR} from '../helpers/ai-fixtures.mjs';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {createAnalysisJob} from '../../src/ai/export/job.mjs';
import {
  buildAggregatePrompt,
  buildBatchPrompt,
  buildRepairMessages,
  readBatchPackage
} from '../../src/ai/auto/prompt.mjs';
import {AutoAnalysisError} from '../../src/ai/auto/errors.mjs';

async function makePackage(t) {
  const db = openMemoryDb();
  addBroadcaster(db);
  const temp = createTempDir();
  t.after(() => { temp.cleanup(); db.close(); });
  const session = seedSession(db, {
    id: 'ses_prompt_test',
    messageCount: 6,
    viewerCount: 3,
    viewerUidPrefix: 'UC_PROMPT',
    startedAt: T0
  });
  const created = await createAnalysisJob({
    db,
    sessionId: session.id,
    locale: 'zh-CN',
    exportsDir: join(temp.dir, 'exports'),
    batchSize: 100,
    memoryViewersPerBatch: 25,
    maxMemoryExcerptMessages: 600,
    now: T0 + HOUR
  });
  const files = readBatchPackage(join(temp.dir, 'exports'), created.packages[0].fileName);
  return {db, temp, session, created, files};
}

test('the automatic batch prompt names every memory viewer exactly once', async (t) => {
  const {temp, created, files} = await makePackage(t);
  const prompt = buildBatchPrompt(files);
  const memory = JSON.parse(files['memory_context.json']);
  assert.equal(prompt.kind, 'batch');
  assert.equal(prompt.manifest.job_id, created.job.id);
  assert.equal(prompt.estimatedTokens > 0, true);
  assert.deepEqual([...prompt.viewerIds].sort(), memory.viewers.map((viewer) => viewer.viewer_id).sort());
  for (const viewer of memory.viewers) {
    assert.match(prompt.system, new RegExp(viewer.viewer_id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.ok(prompt.system.includes(viewer.viewer_id));
  }
  assert.match(prompt.system, /EXACTLY 3 entries/);
  assert.match(prompt.system, /viewer_memory_updates is REQUIRED/);
  assert.match(prompt.system, /A question/);
  assert.match(prompt.user, /## messages\.jsonl/);
  assert.match(prompt.user, /## viewer_excerpts\.jsonl/);
  assert.match(prompt.user, /## result\.schema\.json/);
  temp.cleanup();
});

test('the automatic aggregate prompt forbids memory updates and uses batch evidence refs', async (t) => {
  const {temp, files} = await makePackage(t);
  const aggregateFiles = {
    ...files,
    'manifest.json': JSON.stringify({
      ...JSON.parse(files['manifest.json']),
      stage: 'aggregate',
      tasks: [{task_id: 'ses_prompt_test-analysis-final', kind: 'session_analysis_aggregate'}]
    }),
    'batch_results.json': '[]'
  };
  delete aggregateFiles['messages.jsonl'];
  delete aggregateFiles['memory_context.json'];
  delete aggregateFiles['viewer_excerpts.jsonl'];
  const prompt = buildAggregatePrompt(aggregateFiles);
  assert.equal(prompt.kind, 'aggregate');
  assert.match(prompt.system, /viewer_memory_updates MUST be an empty array/);
  assert.match(prompt.system, /"batch": <number>, "seq": <number>/);
  assert.match(prompt.user, /## batch_results\.json/);
  temp.cleanup();
});

test('a prompt that exceeds the context budget is rejected before any request', () => {
  const files = {
    'instructions.md': 'x'.repeat(400000),
    'manifest.json': JSON.stringify({
      protocol: 'livememory-analysis-v1',
      result_protocol: 'livememory-analysis-result-v1',
      schema_version: '1.2.0',
      locale: 'en',
      job_id: 'aij_test',
      session_id: 'ses_test',
      broadcaster_id: null,
      batch: {index: 1, total: 1, batch_id: 'aij_test-b01'},
      tasks: [{task_id: 'ses_test-analysis'}]
    }),
    'memory_context.json': JSON.stringify({viewers: []}),
    'session_context.json': '{}',
    'messages.jsonl': '',
    'viewer_context.json': '[]',
    'viewer_excerpts.jsonl': '',
    'result.schema.json': '{}'
  };
  assert.throws(
    () => buildBatchPrompt(files),
    (error) => error instanceof AutoAnalysisError && error.code === 'AUTO_CONTEXT_TOO_LARGE'
  );
});

test('repair messages keep the original package and list validator errors', async (t) => {
  const {temp, files} = await makePackage(t);
  const prompt = buildBatchPrompt(files);
  const repair = buildRepairMessages({
    prompt,
    previousText: '{"broken":true}',
    errors: [{path: 'viewer_memory_updates', code: 'MEMORY_UPDATES_REQUIRED'}],
    locale: 'zh-CN'
  });
  assert.equal(repair.messages.at(-2).role, 'assistant');
  assert.equal(repair.messages.at(-1).role, 'user');
  assert.match(repair.messages.at(-1).content, /viewer_memory_updates/);
  assert.ok(repair.estimatedTokens > prompt.estimatedTokens);
  temp.cleanup();
});
