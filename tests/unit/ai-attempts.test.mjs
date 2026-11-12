import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ERROR_KIND,
  ATTEMPT_PHASE,
  attemptRecord,
  isCanceledError,
  shouldRetryAttempt
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

