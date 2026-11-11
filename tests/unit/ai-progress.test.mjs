import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAnalysisProgress} from '../../src/web/js/pages/ai-progress.js';

test('session-only progress is indeterminate until the server completes it', () => {
  const running = buildAnalysisProgress({
    status: 'running',
    mode: 'session',
    sessionReportDone: false,
    batchTotal: 1,
    batchIndex: 0
  });
  assert.equal(running.percent, null);
  assert.equal(running.indeterminate, true);
  assert.deepEqual(running.parts[0], {key: 'session', done: 0, total: 1, complete: false});

  const complete = buildAnalysisProgress({
    status: 'complete',
    mode: 'session',
    sessionReportDone: true,
    batchTotal: 1,
    batchIndex: 1
  });
  assert.equal(complete.percent, 100);
  assert.equal(complete.indeterminate, false);
});

test('memory progress uses completed batches and processed viewers, not elapsed time', () => {
  const progress = buildAnalysisProgress({
    status: 'running',
    mode: 'memory',
    batchTotal: 20,
    batchIndex: 13,
    memoryViewersTotal: 200,
    memoryViewersProcessed: 130,
    memoryJob: {memoryCoverage: {total: 200, covered: 130}}
  });
  assert.equal(progress.percent, 65);
  assert.equal(progress.parts[0].done, 13);
  assert.equal(progress.parts[0].total, 20);
  assert.equal(progress.parts[0].viewersDone, 130);
  assert.equal(progress.parts[0].viewersTotal, 200);
});

test('combined progress shows session and memory separately', () => {
  const progress = buildAnalysisProgress({
    status: 'running',
    mode: 'combined',
    sessionReportDone: true,
    batchTotal: 4,
    batchIndex: 2,
    memoryViewersTotal: 40,
    memoryViewersProcessed: 20
  });
  assert.deepEqual(progress.parts.map((part) => part.key), ['session', 'memory']);
  assert.equal(progress.percent, 60);
});

test('100 percent is reserved for the terminal complete state', () => {
  const failed = buildAnalysisProgress({
    status: 'failed',
    mode: 'memory',
    batchTotal: 4,
    batchIndex: 4
  });
  assert.equal(failed.percent, 99);
  assert.equal(failed.indeterminate, false);
});

test('a skipped memory half is explicit and never counted as an unfinished batch', () => {
  const progress = buildAnalysisProgress({
    status: 'complete',
    mode: 'combined',
    sessionReportDone: true,
    memorySkipped: true,
    memorySkipReason: 'ANALYSIS_MEMORY_NO_VIEWERS',
    batchTotal: 0,
    batchIndex: 0
  });
  assert.equal(progress.percent, 100);
  assert.equal(progress.memorySkipped, true);
  assert.equal(progress.parts.find((part) => part.key === 'memory').skipped, true);
  assert.equal(progress.parts.find((part) => part.key === 'memory').reason, 'ANALYSIS_MEMORY_NO_VIEWERS');
});
