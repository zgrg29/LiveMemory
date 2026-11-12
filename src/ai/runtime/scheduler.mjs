import {cancellationError, sleepWithSignal} from './json.mjs';

/**
 * Per-provider request scheduler.
 *
 * There is deliberately no hard-coded requests-per-minute value here. A paid
 * provider's real quota is account-, region- and model-specific and is not
 * discoverable from a local configuration. The scheduler therefore starts from
 * a conservative, user-configurable concurrency, and reacts to the provider's
 * actual feedback:
 *
 *   - HTTP 429 reduces concurrency and pauses this provider key only;
 *   - Retry-After is honoured (set by the caller on the error object);
 *   - 5xx responses pause this provider briefly but do not shrink the pool;
 *   - sustained successes slowly restore concurrency up to the configured cap.
 *
 * The key is `providerId:regionId:modelId` (or the config id), so two providers,
 * regions, models or independent account configurations never share state.
 */

const DEFAULT_INITIAL_CONCURRENCY = 3;
const DEFAULT_MAX_CONCURRENCY = 6;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 8;
const SUCCESSES_BEFORE_RAMP = 6;
const DEFAULT_429_PAUSE_MS = 1500;
const DEFAULT_5XX_PAUSE_MS = 750;

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

export class ProviderRequestScheduler {
  constructor({
    key,
    initialConcurrency = DEFAULT_INITIAL_CONCURRENCY,
    maxConcurrency = DEFAULT_MAX_CONCURRENCY,
    minConcurrency = MIN_CONCURRENCY,
    now = Date.now,
    random = Math.random
  } = {}) {
    this.key = String(key ?? 'provider');
    this.minConcurrency = clampInteger(minConcurrency, 1, MAX_CONCURRENCY, MIN_CONCURRENCY);
    this.maxConcurrency = Math.max(
      this.minConcurrency,
      clampInteger(maxConcurrency, 1, MAX_CONCURRENCY, DEFAULT_MAX_CONCURRENCY)
    );
    this.concurrency = Math.max(
      this.minConcurrency,
      Math.min(this.maxConcurrency, clampInteger(initialConcurrency, 1, MAX_CONCURRENCY, DEFAULT_INITIAL_CONCURRENCY))
    );
    this.now = now;
    this.random = random;
    this.active = 0;
    this.waiting = 0;
    this.throttleUntil = 0;
    this.rateLimited = 0;
    this.lastRetryAfterMs = null;
    this.lastErrorAt = null;
    this.consecutiveSuccess = 0;
    this.total = 0;
    this.completed = 0;
    this.failed = 0;
    this.timedOut = 0;
    this.canceled = 0;
    this.queueWaitMsTotal = 0;
    this.throttleWaitMsTotal = 0;
    this.durationMsTotal = 0;
    this.durations = [];
  }

  #isThrottled(now = this.now()) {
    return now < this.throttleUntil;
  }

  async #acquire(signal) {
    const queuedAt = this.now();
    let throttleWaitMs = 0;
    for (;;) {
      if (signal?.aborted) throw cancellationError();
      const now = this.now();
      if (this.#isThrottled(now)) {
        const waitMs = Math.min(250, Math.max(25, this.throttleUntil - now));
        await sleepWithSignal(waitMs, signal);
        throttleWaitMs += waitMs;
        continue;
      }
      if (this.active < this.concurrency) {
        this.waiting = Math.max(0, this.waiting - 1);
        this.active += 1;
        this.queueWaitMsTotal += Math.max(0, now - queuedAt);
        this.throttleWaitMsTotal += throttleWaitMs;
        return;
      }
      // Poll a short interval instead of a shared wake-up structure: the number
      // of in-flight tasks is small (<= 8) and this keeps cancellation exact.
      const waitMs = 50;
      await sleepWithSignal(waitMs, signal);
      throttleWaitMs += 0;
    }
  }

  #penalize(error) {
    const now = this.now();
    this.lastErrorAt = now;
    const status = Number(error?.status ?? 0);
    if (status === 429) {
      this.rateLimited += 1;
      const retryAfter = error?.retryAfterMs;
      this.lastRetryAfterMs = (retryAfter !== null && retryAfter !== undefined
        && Number.isFinite(Number(retryAfter)))
        ? Number(retryAfter)
        : null;
      this.concurrency = Math.max(this.minConcurrency, Math.floor(this.concurrency / 2));
      this.consecutiveSuccess = 0;
      const pause = Math.min(
        300000,
        this.lastRetryAfterMs ?? DEFAULT_429_PAUSE_MS
      );
      this.throttleUntil = Math.max(this.throttleUntil, now + Math.max(0, pause));
      return;
    }
    if (status >= 500 || status === 408 || status === 425) {
      this.consecutiveSuccess = 0;
      const retryAfter = error?.retryAfterMs;
      const pause = (retryAfter !== null && retryAfter !== undefined
        && Number.isFinite(Number(retryAfter)))
        ? Number(retryAfter)
        : DEFAULT_5XX_PAUSE_MS;
      this.throttleUntil = Math.max(this.throttleUntil, now + Math.max(0, pause));
    }
  }

  #recover() {
    this.consecutiveSuccess += 1;
    if (this.concurrency >= this.maxConcurrency) return;
    if (this.consecutiveSuccess < SUCCESSES_BEFORE_RAMP) return;
    this.consecutiveSuccess = 0;
    this.concurrency = Math.min(this.maxConcurrency, this.concurrency + 1);
  }

  /**
   * Run one request inside the scheduler. `task` must perform exactly one HTTP
   * attempt. Retries are the caller's responsibility so that repair/retry logic
   * can honour Retry-After and the shared budget.
   */
  async run(task, {signal = null} = {}) {
    this.waiting += 1;
    try {
      await this.#acquire(signal);
    } catch (error) {
      this.waiting = Math.max(0, this.waiting - 1);
      throw error;
    }
    this.total += 1;
    const startedAt = this.now();
    try {
      const value = await task();
      this.completed += 1;
      const duration = Math.max(0, this.now() - startedAt);
      this.durationMsTotal += duration;
      this.durations.push(duration);
      if (this.durations.length > 200) this.durations.shift();
      this.#recover();
      return value;
    } catch (error) {
      if (error?.kind === 'canceled') this.canceled += 1;
      else if (error?.kind === 'timeout') this.timedOut += 1;
      else this.failed += 1;
      this.#penalize(error);
      throw error;
    } finally {
      this.active = Math.max(0, this.active - 1);
    }
  }

  stats() {
    const durations = [...this.durations].sort((a, b) => a - b);
    const percentile = (p) => {
      if (durations.length === 0) return null;
      const index = Math.min(durations.length - 1, Math.max(0, Math.ceil(p * durations.length) - 1));
      return durations[index];
    };
    return {
      key: this.key,
      total: this.total,
      completed: this.completed,
      failed: this.failed,
      timedOut: this.timedOut,
      canceled: this.canceled,
      active: this.active,
      waiting: this.waiting,
      concurrency: this.concurrency,
      minConcurrency: this.minConcurrency,
      maxConcurrency: this.maxConcurrency,
      rateLimited: this.rateLimited,
      lastRetryAfterMs: this.lastRetryAfterMs,
      throttleRemainingMs: Math.max(0, this.throttleUntil - this.now()),
      queueWaitMs: this.queueWaitMsTotal,
      throttleWaitMs: this.throttleWaitMsTotal,
      modelMs: this.durationMsTotal,
      averageModelMs: this.completed > 0 ? Math.round(this.durationMsTotal / this.completed) : null,
      p50ModelMs: percentile(0.5),
      p95ModelMs: percentile(0.95),
      lastErrorAt: this.lastErrorAt
    };
  }
}

/** Exponential backoff with full jitter, bounded by `maxMs`. */
export function retryDelayMs(attempt, {
  baseMs = 1000,
  maxMs = 30000,
  random = Math.random,
  retryAfterMs = null
} = {}) {
  if (retryAfterMs !== null && retryAfterMs !== undefined
    && Number.isFinite(Number(retryAfterMs)) && Number(retryAfterMs) >= 0) {
    return Math.min(Number(retryAfterMs), maxMs);
  }
  const exponential = Math.min(maxMs, baseMs * (2 ** Math.max(0, Number(attempt) || 0)));
  // Full jitter avoids a synchronised retry burst after a shared outage.
  return Math.round(exponential * (0.5 + random() * 0.5));
}
