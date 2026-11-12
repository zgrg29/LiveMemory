/**
 * Provider-attempt policy.
 *
 * The important distinction is between what an HTTP status or transport failure
 * *means*, not only whether it looks transient:
 *
 *   - `canceled`  user pause/cancel/shutdown — never retried, never counted as
 *                 a provider error;
 *   - `timeout`   no response headers (or no stream data) within the configured
 *                 window. The request was already sent and may still be running
 *                 on the provider. Re-sending the same large prompt is unsafe and
 *                 expensive, so timeouts are NOT automatically retried;
 *   - `network`   connection never established (DNS/refused/reset before send).
 *                 A single safe retry is allowed;
 *   - `rate_limit` 429 — retried after Retry-After, with bounded attempts;
 *   - `server`    5xx/408/425 — retried with exponential backoff + jitter;
 *   - `client`    400/401/403/404/422 — configuration or request problem, never
 *                 retried automatically;
 *   - `invalid_response` / `stream_interrupted` — the provider answered, but the
 *                 answer is unusable or truncated. Re-sending is not a repair.
 */

export const ERROR_KIND = Object.freeze({
  CANCELED: 'canceled',
  TIMEOUT: 'timeout',
  NETWORK: 'network',
  RATE_LIMIT: 'rate_limit',
  SERVER: 'server',
  CLIENT: 'client',
  INVALID_RESPONSE: 'invalid_response',
  STREAM_INTERRUPTED: 'stream_interrupted',
  CONFIG: 'config'
});

export const ATTEMPT_PHASE = Object.freeze({
  CONNECT: 'connect',
  HEADERS: 'headers',
  BODY: 'body',
  STREAM: 'stream'
});

/** How many times one logical request may be resent, by error kind. */
const MAX_AUTO_ATTEMPTS = Object.freeze({
  [ERROR_KIND.NETWORK]: 2,
  [ERROR_KIND.RATE_LIMIT]: 3,
  [ERROR_KIND.SERVER]: 3
});

export function isCanceledError(error) {
  if (!error) return false;
  return error.code === 'ANALYSIS_CANCELED'
    || error.kind === ERROR_KIND.CANCELED
    || error.name === 'AbortError' && error.canceled === true;
}

/**
 * Decide whether a failed attempt may be automatically retried.
 *
 * @param error      adapter error (ProviderHttpError or internal)
 * @param attempt    0-based index of the attempt that just failed
 * @param maxRetries configured upper bound (default 2)
 * @param random     injected for deterministic tests
 */
export function shouldRetryAttempt(error, {attempt = 0, maxRetries = 2, random = Math.random} = {}) {
  if (!error) return false;
  if (isCanceledError(error)) return false;
  const kind = error.kind ?? null;
  const limit = MAX_AUTO_ATTEMPTS[kind] ?? 0;
  const allowed = Math.min(Math.max(0, Number(maxRetries) || 0) + 1, limit);
  if (allowed <= 0) return false;
  if (attempt + 1 >= allowed) return false;
  // A timeout means the provider may still be working on a large request. Do not
  // resend it: the safe response is to report the timeout and let the user resume
  // only the unfinished batches (which may pick a smaller model or longer wait).
  if (kind === ERROR_KIND.TIMEOUT) return false;
  if (kind === ERROR_KIND.INVALID_RESPONSE || kind === ERROR_KIND.STREAM_INTERRUPTED) return false;
  if (kind === ERROR_KIND.CLIENT || kind === ERROR_KIND.CONFIG) return false;
  if (kind === ERROR_KIND.NETWORK && error.phase === ATTEMPT_PHASE.STREAM) return false;
  if (error.retryable !== true) return false;
  // `random` is part of the signature so a future policy can add jitter here;
  // retry delays are produced by retryDelayMs().
  void random;
  return true;
}

/** Timing budget for one whole analysis task (all batches and the aggregate). */
export function createTaskBudget({now = Date.now, taskTimeoutMs = 20 * 60 * 1000} = {}) {
  const startedAt = now();
  const ms = Math.max(60000, Number(taskTimeoutMs) || 20 * 60 * 1000);
  return {startedAt, deadlineAt: startedAt + ms, taskTimeoutMs: ms};
}

export function taskBudgetRemaining(budget, now = Date.now()) {
  if (!budget) return null;
  return Math.max(0, Number(budget.deadlineAt) - now);
}

/**
 * Build the safe, content-free record written to the log and to the status
 * object after every attempt. No prompt text, response text, URL query or API
 * key is included.
 */
export function attemptRecord({
  kind,
  batchIndex = null,
  attempt = 0,
  maxAttempts = 1,
  mode = null,
  outcome = 'failed',
  error = null,
  elapsedMs = null,
  timeoutMs = null,
  receivedHeaders = false,
  receivedOutput = false,
  retry = false,
  nextRetryAt = null,
  usage = null,
  metrics = null,
  model = null,
  maxTokens = null,
  maxCompletionTokens = null,
  estimatedInputTokens = null,
  requestBytes = null,
  reasoningChars = 0,
  reasoningTokens = null
} = {}) {
  return {
    kind: kind ?? null,
    batchIndex: batchIndex === null || batchIndex === undefined ? null : Number(batchIndex),
    attempt: Number(attempt) + 1,
    maxAttempts: Math.max(1, Number(maxAttempts) || 1),
    mode: mode ?? null,
    outcome,
    errorKind: error?.kind ?? null,
    errorCode: error?.code ?? null,
    httpStatus: Number.isFinite(Number(error?.status)) ? Number(error.status) : null,
    elapsedMs: elapsedMs === null ? null : Math.max(0, Math.round(Number(elapsedMs))),
    timeoutMs: timeoutMs === null ? null : Math.max(0, Math.round(Number(timeoutMs))),
    receivedHeaders: receivedHeaders === true,
    receivedOutput: receivedOutput === true,
    retry: retry === true,
    nextRetryAt: nextRetryAt ?? null,
    usageKnown: Boolean(usage),
    model: model ?? null,
    maxTokens: maxTokens === null ? null : Math.max(0, Math.round(Number(maxTokens))),
    maxCompletionTokens: maxCompletionTokens === null
      ? null
      : Math.max(0, Math.round(Number(maxCompletionTokens))),
    estimatedInputTokens: estimatedInputTokens === null
      ? null
      : Math.max(0, Math.round(Number(estimatedInputTokens))),
    requestBytes: requestBytes === null ? null : Math.max(0, Math.round(Number(requestBytes))),
    reasoningChars: Math.max(0, Math.round(Number(reasoningChars) || 0)),
    reasoningTokens: reasoningTokens === null ? null : Math.max(0, Math.round(Number(reasoningTokens) || 0)),
    timeToFirstByteMs: metrics?.timeToFirstByteMs ?? null,
    timeToFirstTokenMs: metrics?.timeToFirstTokenMs ?? null,
    streamDurationMs: metrics?.streamDurationMs ?? null,
    maxIdleMs: metrics?.maxIdleMs ?? null
  };
}
