import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRecovery} from '../../src/ai/tasks/recovery.mjs';

function sessionStatus(overrides = {}) {
  return {
    batchTotal: 18,
    batchesImported: 18,
    aggregateRequired: true,
    aggregateImported: false,
    complete: false,
    ...overrides
  };
}

function memoryStatus(overrides = {}) {
  return {
    batchTotal: 4,
    batchesImported: 2,
    complete: false,
    memoryCoverage: {total: 10, covered: 5, pending: 4, failed: 1, complete: false},
    ...overrides
  };
}

test('an aggregate failure after 18/18 saved batches offers only final merge', () => {
  const recovery = buildRecovery({
    status: 'failed',
    errorCode: 'AUTO_OUTPUT_TRUNCATED',
    sessionJobId: 'job-session',
    memoryJobId: null,
    sessionStatus: sessionStatus(),
    memoryStatus: null
  });
  assert.equal(recovery.kind, 'aggregate');
  assert.equal(recovery.action, 'resume-aggregate');
  assert.equal(recovery.canResume, true);
  assert.equal(recovery.session.batchesSaved, 18);
  assert.equal(recovery.session.pendingBatches, 0);
  assert.equal(recovery.session.aggregateDone, false);
  assert.equal(recovery.savedResults, 18);
});

test('a failed session batch offers unfinished analysis, not an aggregate retry', () => {
  const recovery = buildRecovery({
    status: 'needs_action',
    errorCode: 'PROVIDER_TIMEOUT',
    sessionJobId: 'job-session',
    sessionStatus: sessionStatus({batchesImported: 15, aggregateImported: false}),
    memoryStatus: null
  });
  assert.equal(recovery.kind, 'session');
  assert.equal(recovery.action, 'resume-session');
  assert.equal(recovery.session.pendingBatches, 3);
  assert.equal(recovery.canResume, true);
});

test('a memory-only failure offers unfinished profiles', () => {
  const recovery = buildRecovery({
    status: 'failed',
    errorCode: 'AI_IMPORT_INVALID',
    memoryJobId: 'job-memory',
    sessionStatus: null,
    memoryStatus: memoryStatus()
  });
  assert.equal(recovery.kind, 'memory');
  assert.equal(recovery.action, 'resume-memory');
  assert.equal(recovery.memory.batchesSaved, 2);
  assert.equal(recovery.memory.pendingBatches, 2);
  assert.equal(recovery.memory.viewersTotal, 10);
  assert.equal(recovery.savedResults, 2);
});

test('a combined task with a saved report and unfinished profiles offers profiles', () => {
  const recovery = buildRecovery({
    status: 'partial',
    errorCode: 'AI_IMPORT_INVALID',
    sessionJobId: 'job-session',
    memoryJobId: 'job-memory',
    sessionStatus: sessionStatus({complete: true, aggregateImported: true}),
    memoryStatus: memoryStatus()
  });
  assert.equal(recovery.kind, 'memory');
  assert.equal(recovery.action, 'resume-memory');
});

test('too large for the current model does not fake a working Continue', () => {
  const recovery = buildRecovery({
    status: 'failed',
    errorCode: 'ANALYSIS_AGGREGATE_TOO_LARGE',
    sessionJobId: 'job-session',
    sessionStatus: sessionStatus(),
    memoryStatus: null
  });
  assert.equal(recovery.kind, 'aggregate');
  assert.equal(recovery.action, 'change-model');
  assert.equal(recovery.canResume, false);
});

test('a completed, canceled-like or out-of-order task has no recovery entry', () => {
  assert.equal(buildRecovery({
    status: 'complete',
    sessionJobId: 'job-session',
    sessionStatus: sessionStatus({aggregateImported: true, complete: true})
  }), null);
  assert.equal(buildRecovery({
    status: 'failed',
    errorCode: 'ANALYSIS_MEMORY_OUT_OF_ORDER',
    sessionJobId: 'job-session',
    sessionStatus: sessionStatus()
  }), null);
  assert.equal(buildRecovery({status: 'failed', errorCode: 'PROVIDER_TIMEOUT'}), null);
});

test('a single-batch session with no saved result offers the session retry', () => {
  const recovery = buildRecovery({
    status: 'failed',
    errorCode: 'AUTO_SCHEMA_INVALID',
    sessionJobId: 'job-session',
    sessionStatus: {
      batchTotal: 1,
      batchesImported: 0,
      aggregateRequired: false,
      aggregateImported: false,
      complete: false
    }
  });
  assert.equal(recovery.kind, 'session');
  assert.equal(recovery.action, 'resume-session');
});

test('pending viewer coverage is recovered even when every memory batch row imported', () => {
  const recovery = buildRecovery({
    status: 'partial',
    errorCode: 'AI_IMPORT_INVALID',
    memoryJobId: 'job-memory',
    memoryStatus: memoryStatus({
      batchTotal: 2,
      batchesImported: 2,
      complete: false,
      memoryCoverage: {total: 10, covered: 8, pending: 1, failed: 1, complete: false}
    })
  });
  assert.equal(recovery.kind, 'memory');
  assert.equal(recovery.memory.pendingBatches, 0);
  assert.equal(recovery.memory.viewersTotal, 10);
});
