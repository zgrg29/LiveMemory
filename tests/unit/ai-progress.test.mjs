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
  assert.equal(running.parts[0].key, 'session');
  assert.equal(running.parts[0].done, 0);
  assert.equal(running.parts[0].total, 1);
  assert.equal(running.parts[0].complete, false);
  assert.equal(running.parts[0].aggregateRequired, false);

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

test('a multi-batch session shows batch and aggregate progress instead of an indeterminate bar', () => {
  const mid = buildAnalysisProgress({
    status: 'running',
    mode: 'session',
    sessionReportDone: false,
    sessionBatchTotal: 4,
    sessionBatchIndex: 2,
    sessionBatchesCompleted: 2,
    sessionAggregateRequired: true,
    sessionAggregateDone: false
  });
  assert.equal(mid.percent, 40, '(2 of 4 batches, aggregate still pending)');
  assert.equal(mid.parts[0].batchTotal, 4);
  assert.equal(mid.parts[0].batchDone, 2);
  assert.equal(mid.parts[0].aggregateRequired, true);
  assert.equal(mid.parts[0].complete, false);

  const batchesDone = buildAnalysisProgress({
    status: 'running',
    mode: 'session',
    sessionReportDone: false,
    sessionBatchTotal: 4,
    sessionBatchIndex: 4,
    sessionAggregateRequired: true,
    sessionAggregateDone: false
  });
  assert.equal(batchesDone.percent, 80, 'all batches imported still waits for the aggregate');

  const complete = buildAnalysisProgress({
    status: 'complete',
    mode: 'session',
    sessionReportDone: true,
    sessionBatchTotal: 4,
    sessionBatchIndex: 4,
    sessionAggregateRequired: true,
    sessionAggregateDone: true
  });
  assert.equal(complete.percent, 100);
});

test('combined progress counts session batches, aggregate and memory batches as real units', () => {
  const progress = buildAnalysisProgress({
    status: 'running',
    mode: 'combined',
    sessionBatchTotal: 2,
    sessionBatchIndex: 2,
    sessionAggregateDone: true,
    sessionReportDone: true,
    batchTotal: 2,
    batchIndex: 1,
    memoryViewersTotal: 20,
    memoryViewersProcessed: 10
  });
  // Session units: 2 batches + 1 aggregate = 3 done; memory 1 of 2.
  assert.equal(progress.percent, 80);
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
