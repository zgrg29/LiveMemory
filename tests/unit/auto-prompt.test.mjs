import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
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

const RESULT_SCHEMA = readFileSync(
  fileURLToPath(new URL('../../src/ai/schemas/analysis-result-v1.schema.json', import.meta.url)),
  'utf8'
);

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
    memoryViewersPerBatch: 10,
    maxMemoryExcerptMessages: 600,
    now: T0 + HOUR
  });
  const files = readBatchPackage(join(temp.dir, 'exports'), created.packages[0].fileName);
  return {db, temp, session, created, files};
}

test('the automatic batch prompt uses refs and never asks for viewer ids', async (t) => {
  const {temp, created, files} = await makePackage(t);
  const prompt = buildBatchPrompt(files);
  const memory = JSON.parse(files['memory_context.json']);
  assert.equal(prompt.kind, 'batch');
  assert.equal(prompt.format, 'compact');
  assert.equal(prompt.manifest.job_id, created.job.id);
  assert.equal(prompt.estimatedTokens > 0, true);
  assert.deepEqual(prompt.viewerRefs.map((entry) => entry.ref), [1, 2, 3]);
  assert.deepEqual(
    prompt.viewerRefs.map((entry) => entry.viewerId).sort(),
    memory.viewers.map((viewer) => viewer.viewer_id).sort()
  );
  // The compact contract lists refs, not ids: copying an opaque id is exactly
  // the mechanical step that failed on real packages.
  assert.match(prompt.system, /EXACTLY 3 entries/);
  assert.match(prompt.system, /ref 1/);
  assert.match(prompt.system, /never output viewer_id/i);
  assert.doesNotMatch(prompt.system, /youtube:UC_PROMPT_0/);
  assert.match(prompt.system, /"session_topics"/);
  assert.match(prompt.user, /## memory_context/);
  assert.match(prompt.user, /## viewer_directory/);
  assert.match(prompt.user, /## viewer_excerpts\.jsonl/);
  assert.match(prompt.user, /evidence_seqs/);
  assert.match(prompt.user, /"viewers"/);
  // A single-slice batch must not send an identical chat log twice.
  assert.match(prompt.user, /identical to viewer_excerpts\.jsonl/);
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
    'result.schema.json': RESULT_SCHEMA
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
    errors: [{path: 'viewers[1].memory', code: 'MEMORY_REQUIRED'}],
    locale: 'zh-CN'
  });
  assert.equal(repair.messages.at(-2).role, 'assistant');
  assert.equal(repair.messages.at(-1).role, 'user');
  assert.match(repair.messages.at(-1).content, /viewers\[1\]\.memory/);
  assert.match(repair.messages.at(-1).content, /ref/);
  assert.ok(repair.estimatedTokens > prompt.estimatedTokens);
  temp.cleanup();
});
