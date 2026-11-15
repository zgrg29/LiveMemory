/**
 * Shared request budget for the free community signer.
 *
 * The signing endpoint is a third-party service. Its anonymous allowance is not
 * a fixed number in our code: it is reported per response through standard
 * rate-limit headers. The observed policy in 2026-11 was
 * `ratelimit-policy: 30;w=3600` (thirty requests per hour per IP), while older
 * deployments advertised a much larger request budget and a 5/minute burst
 * limit. Hard-coding either value is what made the first TikTok build enter a
 * reconnect loop: a 15 s poll needs 240 requests/hour, the service refuses
 * request 31 with HTTP 429 and `retry-after: 2708`, and the adapter capped that
 * delay at 30 s and retried for the rest of the hour.
 *
 * This class turns the server headers into a pacing rule:
 *   - never issue two requests closer than `minIntervalMs`;
 *   - never issue more than the advertised remaining budget;
 *   - spread the remaining requests across the advertised window;
 *   - honour the full `Retry-After` / `ratelimit-reset` (with jitter), not a
 *     locally invented short cap.
 *
 * One instance is shared by every TikTok adapter in the process, because the
 * provider counts the budget per IP, not per room. This is what prevents two
 * simultaneous rooms from silently starving each other or double-spending the
 * same allowance.
 */

const MAX_BLOCK_MS = 12 * 60 * 60 * 1000;

function nonNegative(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/**
 * Normalise the subset of rate-limit headers the signer uses.
 * @param {{get?: Function}} headers
 * @param {number} at epoch ms
 */
export function parseRateLimitHeaders(headers, {at = Date.now()} = {}) {
  const get = (name) => {
    try {
      return headers?.get?.(name) ?? null;
    } catch {
      return null;
    }
  };
  const policy = get('ratelimit-policy');
  let limit = nonNegative(get('ratelimit-limit'));
  let windowMs = null;
  if (policy) {
    const match = String(policy).match(/(\d+)\s*;\s*w\s*=\s*(\d+)/i);
    if (match) {
      limit = limit ?? Number(match[1]);
      windowMs = Number(match[2]) * 1000;
    }
  }
  const resetSeconds = nonNegative(get('ratelimit-reset'));
  const retryAfter = get('retry-after');
  let retryAfterMs = null;
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) retryAfterMs = Math.round(seconds * 1000);
    else {
      const date = Date.parse(retryAfter);
      if (Number.isFinite(date)) retryAfterMs = Math.max(0, date - at);
    }
  }
  return {
    limit,
    windowMs,
    remaining: nonNegative(get('ratelimit-remaining')),
    resetAt: resetSeconds === null ? null : at + resetSeconds * 1000,
    retryAfterMs,
    policy: policy ? String(policy) : null,
    label: get('ratelimit-limit') !== null ? String(get('ratelimit-limit')) : null
  };
}

export class TikTokRateBudget {
  constructor({
    now = Date.now,
    random = Math.random,
    minIntervalMs = 15000,
    defaultBlockMs = 60 * 1000,
    safety = 1.1,
    reserve = 1,
    hourlyLimit = null,
    maxBlockMs = MAX_BLOCK_MS
  } = {}) {
    this.now = now;
    this.random = random;
    this.minIntervalMs = Math.max(1000, Number(minIntervalMs) || 15000);
    this.defaultBlockMs = Math.max(1000, Number(defaultBlockMs) || 60000);
    this.safety = Math.max(1, Number(safety) || 1.1);
    this.reserveSlots = Math.max(0, Number(reserve) || 0);
    this.hourlyLimit = Number.isFinite(Number(hourlyLimit)) && Number(hourlyLimit) > 0 ? Number(hourlyLimit) : null;
    this.maxBlockMs = Math.max(this.defaultBlockMs, Number(maxBlockMs) || MAX_BLOCK_MS);
    this.limit = null;
    this.windowMs = null;
    this.remaining = null;
    this.resetAt = null;
    this.blockedUntil = 0;
    this.lastRequestAt = null;
    this.updatedAt = null;
    this.lastReason = null;
    this.requests = 0;
    this.rateLimitedResponses = 0;
  }

  #jitter(ms) {
    const bounded = Math.max(0, Math.min(this.maxBlockMs, ms));
    if (bounded === 0) return 0;
    const spread = Math.min(15000, Math.max(250, Math.round(bounded * 0.05)));
    return bounded + Math.round(this.random() * spread);
  }

  /** Apply a response's advertised budget. */
  observe(info, {at = this.now()} = {}) {
    if (!info || typeof info !== 'object') return this.snapshot({at});
    if (Number.isFinite(info.limit) && info.limit > 0) this.limit = info.limit;
    if (Number.isFinite(info.windowMs) && info.windowMs > 0) this.windowMs = info.windowMs;
    if (Number.isFinite(info.remaining)) this.remaining = info.remaining;
    if (Number.isFinite(info.resetAt)) this.resetAt = info.resetAt;
    if (Number.isFinite(info.retryAfterMs) && info.retryAfterMs > 0) {
      this.blockedUntil = Math.max(this.blockedUntil, at + info.retryAfterMs);
    }
    if (Number.isFinite(info.remaining) && info.remaining > 0 && this.blockedUntil <= at) {
      this.blockedUntil = 0;
    }
    this.updatedAt = at;
    return this.snapshot({at});
  }

  /** Record an explicit refusal (HTTP 429/403 rate limit). */
  penalize({retryAfterMs = null, resetAt = null, at = this.now()} = {}) {
    this.rateLimitedResponses += 1;
    const advertised = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : null;
    const untilReset = Number.isFinite(resetAt) ? Math.max(0, resetAt - at) : 0;
    const wait = Math.max(advertised ?? 0, untilReset) || this.defaultBlockMs;
    this.blockedUntil = at + this.#jitter(wait);
    this.remaining = 0;
    if (Number.isFinite(resetAt)) this.resetAt = resetAt;
    else if (this.resetAt === null || this.resetAt <= at) this.resetAt = this.blockedUntil;
    this.lastReason = 'rate_limited';
    this.updatedAt = at;
    return this.snapshot({at});
  }

  #windowRolled(at) {
    return Number.isFinite(this.resetAt) && at >= this.resetAt;
  }

  #interval(at) {
    if (Number.isFinite(this.remaining) && this.remaining > 0 && Number.isFinite(this.resetAt)) {
      const secondsLeft = Math.max(0, this.resetAt - at);
      const usable = Math.max(1, this.remaining - this.reserveSlots);
      if (secondsLeft <= 0) return this.minIntervalMs;
      return Math.max(this.minIntervalMs, Math.ceil((secondsLeft / usable) * this.safety));
    }
    return this.minIntervalMs;
  }

  /**
   * Reserve one request slot.
   * @returns {{allowed:boolean, waitMs:number, reason:string|null, intervalMs:number, nextAt:number}}
   */
  reserve({at = this.now(), minIntervalMs = this.minIntervalMs} = {}) {
    const floor = Math.max(1000, Number(minIntervalMs) || this.minIntervalMs);
    if (this.blockedUntil > at) {
      this.lastReason = 'blocked';
      return {allowed: false, waitMs: this.blockedUntil - at, reason: 'blocked', intervalMs: floor, nextAt: this.blockedUntil};
    }
    if (this.#windowRolled(at) && Number.isFinite(this.remaining) && this.remaining <= 0) {
      this.remaining = this.limit ?? null;
      this.resetAt = null;
      this.blockedUntil = 0;
    }
    if (Number.isFinite(this.remaining) && this.remaining <= 0) {
      const until = Number.isFinite(this.resetAt) ? this.resetAt : at + this.defaultBlockMs;
      this.blockedUntil = until;
      this.lastReason = 'exhausted';
      return {allowed: false, waitMs: Math.max(0, until - at), reason: 'exhausted', intervalMs: floor, nextAt: until};
    }
    const interval = Math.max(floor, this.#interval(at));
    const nextAt = (this.lastRequestAt ?? -Infinity) + interval;
    if (this.lastRequestAt !== null && at < nextAt) {
      this.lastReason = 'pacing';
      return {allowed: false, waitMs: nextAt - at, reason: 'pacing', intervalMs: interval, nextAt};
    }
    this.lastRequestAt = at;
    this.requests += 1;
    this.lastReason = null;
    return {allowed: true, waitMs: 0, reason: null, intervalMs: interval, nextAt: at + interval};
  }

  snapshot({at = this.now()} = {}) {
    const interval = this.#interval(at);
    let nextAt = this.lastRequestAt === null ? at : this.lastRequestAt + interval;
    if (this.blockedUntil > at) nextAt = Math.max(nextAt, this.blockedUntil);
    return {
      limit: this.limit,
      windowMs: this.windowMs,
      remaining: this.remaining,
      resetAt: this.resetAt,
      blockedUntil: this.blockedUntil > at ? this.blockedUntil : null,
      lastRequestAt: this.lastRequestAt,
      nextAllowedAt: nextAt,
      intervalMs: interval,
      requests: this.requests,
      rateLimitedResponses: this.rateLimitedResponses,
      hourlyLimit: this.hourlyLimit,
      scope: 'shared-ip',
      reason: this.blockedUntil > at ? 'rate_limited' : (Number.isFinite(this.remaining) && this.remaining <= 0 ? 'exhausted' : null)
    };
  }
}

export const __internal = {nonNegative};
