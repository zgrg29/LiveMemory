import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ERROR_KIND,
  ATTEMPT_PHASE,
  attemptRecord,
  createTaskBudget,
  isCanceledError,
  shouldRetryAttempt,
  taskBudgetElapsed,
  taskBudgetRemaining,
  taskBudgetState
} from '../../src/ai/runtime/attempt.mjs';

function error(kind, {retryable = false, status = null, phase = ATTEMPT_PHASE.HEADERS} = {}) {
  return {kind, retryable, status, phase, code: `PROVIDER_${kind.toUpperCase()}`};
}

test('a sent request that timed out is never automatically re-sent', () => {
  const timeout = error(ERROR_KIND.TIMEOUT, {retryable: false});
  assert.equal(shouldRetryAttempt(timeout, {attempt: 0, maxRetries: 2}), false);
  assert.equal(shouldRetryAttempt(timeout, {attempt: 1, maxRetries: 2}), false);
});

test('user cancel and pause never retry and are classified separately from timeout', () => {
  const canceled = {code: 'ANALYSIS_CANCELED', kind: ERROR_KIND.CANCELED, retryable: true};
  assert.equal(isCanceledError(canceled), true);
  assert.equal(shouldRetryAttempt(canceled, {attempt: 0, maxRetries: 5}), false);
  const paused = {code: 'ANALYSIS_PAUSED'};
  assert.equal(shouldRetryAttempt(paused, {attempt: 0, maxRetries: 5}), false);
});

test('only transport-level network failures get one safe retry', () => {
  const connectFailure = error(ERROR_KIND.NETWORK, {retryable: true, phase: ATTEMPT_PHASE.HEADERS});
  assert.equal(shouldRetryAttempt(connectFailure, {attempt: 0, maxRetries: 2}), true);
  assert.equal(shouldRetryAttempt(connectFailure, {attempt: 1, maxRetries: 2}), false);
  const midStream = error(ERROR_KIND.NETWORK, {retryable: true, phase: ATTEMPT_PHASE.STREAM});
  assert.equal(shouldRetryAttempt(midStream, {attempt: 0, maxRetries: 2}), false);
});

test('429 honours Retry-After with bounded attempts; 5xx is retried; 4xx is not', () => {
  const rate = error(ERROR_KIND.RATE_LIMIT, {retryable: true, status: 429});
  assert.equal(shouldRetryAttempt(rate, {attempt: 0, maxRetries: 2}), true);
  assert.equal(shouldRetryAttempt(rate, {attempt: 1, maxRetries: 2}), true);
  assert.equal(shouldRetryAttempt(rate, {attempt: 2, maxRetries: 2}), false);

  const server = error(ERROR_KIND.SERVER, {retryable: true, status: 503});
  assert.equal(shouldRetryAttempt(server, {attempt: 0, maxRetries: 2}), true);
  assert.equal(shouldRetryAttempt(server, {attempt: 2, maxRetries: 2}), false);

  const client = error(ERROR_KIND.CLIENT, {retryable: true, status: 400});
  assert.equal(shouldRetryAttempt(client, {attempt: 0, maxRetries: 2}), false);
  const invalid = error(ERROR_KIND.INVALID_RESPONSE, {retryable: true});
  assert.equal(shouldRetryAttempt(invalid, {attempt: 0, maxRetries: 2}), false);
});

test('attempt records are content-free and carry the fields needed for diagnosis', () => {
  const record = attemptRecord({
    kind: 'session',
    batchIndex: 3,
    attempt: 1,
    maxAttempts: 3,
    mode: 'streaming',
    outcome: 'timeout',
    error: {kind: ERROR_KIND.TIMEOUT, code: 'PROVIDER_TIMEOUT', status: null},
    elapsedMs: 180012,
    timeoutMs: 180000,
    receivedHeaders: false,
    receivedOutput: false,
    retry: false,
    usage: null
  });
  assert.equal(record.attempt, 2);
  assert.equal(record.outcome, 'timeout');
  assert.equal(record.errorKind, 'timeout');
  assert.equal(record.receivedHeaders, false);
  assert.equal(record.usageKnown, false);
  assert.equal(record.elapsedMs, 180012);
  assert.equal(JSON.stringify(record).includes('prompt'), false);
});

test('the task budget is finite and uses the injected clock', () => {
  let now = 1000;
  const budget = createTaskBudget({now: () => now, taskTimeoutMs: 120000});
  assert.equal(budget.deadlineAt, 121000);
  assert.equal(taskBudgetRemaining(budget, 1000), 120000);
  now = 61000;
  assert.equal(taskBudgetRemaining(budget, now), 60000);
  assert.equal(taskBudgetRemaining(budget, 999999), 0);
  const floored = createTaskBudget({now: () => 0, taskTimeoutMs: 1});
  assert.equal(floored.taskTimeoutMs, 60000, 'a task budget can never be effectively zero');
  assert.equal(budget.softBudgetMs, 120000, 'the soft warning cannot exceed the hard deadline');
  const withSoft = createTaskBudget({now: () => 0, taskTimeoutMs: 120000, softBudgetMs: 60000});
  assert.equal(withSoft.softBudgetMs, 60000);
  assert.equal(withSoft.softDeadlineAt, 60000);
});

test('the task budget moves through normal, soft and hard states', () => {
  const budget = createTaskBudget({
    now: () => 0,
    taskTimeoutMs: 60 * 60 * 1000,
    softBudgetMs: 45 * 60 * 1000
  });
  assert.equal(taskBudgetState(budget, 20 * 60 * 1000), 'normal');
  assert.equal(taskBudgetState(budget, 45 * 60 * 1000), 'soft');
  assert.equal(taskBudgetState(budget, 59 * 60 * 1000), 'soft');
  assert.equal(taskBudgetState(budget, 60 * 60 * 1000), 'hard');
  assert.equal(taskBudgetElapsed(budget, 61 * 60 * 1000), 61 * 60 * 1000);
  const defaultBudget = createTaskBudget({now: () => 0});
  assert.equal(defaultBudget.taskTimeoutMs, 60 * 60 * 1000);
  assert.equal(defaultBudget.softBudgetMs, 45 * 60 * 1000);
});
