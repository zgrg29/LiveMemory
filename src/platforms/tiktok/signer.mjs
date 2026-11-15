import {TikTokError, TIKTOK_ERRORS} from './errors.mjs';
import {decodeFetchResult} from './messages.mjs';
import {TikTokRateBudget, parseRateLimitHeaders} from './rate-budget.mjs';

/**
 * Signed fetch transport ("community signer").
 *
 * TikTok only returns live events to a client that presents a signed bootstrap
 * request. LiveMemory does not forge signatures: it calls the free community
 * signing endpoint used by the open-source TikTok LIVE ecosystem. No API key,
 * no payment and no Business plan is required; the endpoint currently answers
 * anonymous clients and reports its real allowance in rate-limit headers.
 *
 * What changed after the first real trial:
 *   - the endpoint now advertises `30;w=3600` for anonymous clients, not the
 *     larger budget that older notes mentioned;
 *   - every request is admitted by a shared `TikTokRateBudget`, so the adapter
 *     cannot exceed the advertised allowance and a 429 is never retried with a
 *     locally shortened delay;
 *   - 403/429/5xx are classified separately from "premium required" so the UI
 *     can say "waiting for the free quota" instead of "needs payment".
 *
 * Nothing here bypasses a captcha or an access-control response. A provider
 * that answers "premium plan required" is surfaced as
 * `TIKTOK_SIGNER_PREMIUM_REQUIRED` instead of being retried until it works.
 */

export const DEFAULT_SIGN_BASE_URL = 'https://api.eulerstream.com';
/** The provider expects a known client identifier; this one is its documented Node client. */
export const SIGNER_CLIENT = 'ttlive-node';

function bodyText(buffer) {
  try {
    return buffer.toString('utf8').trim().slice(0, 500);
  } catch {
    return '';
  }
}

function parseBody(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function looksRateLimited({status, body, text, rateLimit}) {
  if (status === 429) return true;
  if (body && Number(body.code) === 429) return true;
  if (body?.limit_label) return true;
  if (rateLimit?.remaining === 0 && Number.isFinite(rateLimit?.retryAfterMs)) return true;
  return /rate limit|too many requests|quota|request limit/i.test(String(text ?? ''));
}

function looksPremium(text) {
  return /business plan|premium|paid plan|subscription|upgrade|payment required/i.test(String(text ?? ''));
}

export class TikTokSigner {
  constructor({
    baseUrl = DEFAULT_SIGN_BASE_URL,
    apiKey = null,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    timeoutMs = 15000,
    userAgent = null,
    budget = null,
    budgetOptions = null
  } = {}) {
    this.baseUrl = String(baseUrl ?? DEFAULT_SIGN_BASE_URL).replace(/\/+$/, '');
    this.apiKey = apiKey ? String(apiKey) : null;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.userAgent = userAgent;
    // The anonymous free tier has an account/IP ceiling of 30 requests per
    // hour that is only revealed after it is exhausted. A 15 s poll (240/h)
    // therefore always ends in HTTP 429 after ~30 batches. Pace anonymous
    // requests at ~2 minutes so the hour window rolls before the ceiling is
    // reached; the response headers still refine this when they are stricter.
    // A caller-provided budget (or API key) can opt out.
    const anonymousBudget = apiKey ? {} : {minIntervalMs: 130000, hourlyLimit: 30};
    this.budget = budget ?? new TikTokRateBudget({now, ...anonymousBudget, ...(budgetOptions ?? {})});
  }

  get mode() {
    return this.apiKey ? 'community-signer-with-key' : 'community-signer';
  }

  /** What the shared budget currently allows; used by status/UI. */
  availability() {
    return this.budget.snapshot({at: this.now()});
  }

  /**
   * Fetch the next signed batch for a room.
   * @param {{roomId: string, cursor?: string|null, userAgent?: string, signal?: AbortSignal}} options
   * @returns {Promise<{fetchResult: object, cookie: string|null, roomId: string|null, bytes: number, rateLimit: object|null}>}
   */
  async connect({roomId, cursor = null, userAgent = null, signal = null} = {}) {
    const id = String(roomId ?? '').trim();
    if (!/^\d{6,}$/.test(id)) {
      throw new TikTokError(TIKTOK_ERRORS.PROTOCOL, {
        messageKey: 'errors.tiktokProtocol',
        httpStatus: 502,
        details: {reason: 'room_id_invalid'}
      });
    }
    if (typeof this.fetchImpl !== 'function') {
      throw new TikTokError(TIKTOK_ERRORS.NOT_CONFIGURED, {
        messageKey: 'errors.tiktokNotConfigured',
        httpStatus: 503
      });
    }
    const at = this.now();
    const reservation = this.budget.reserve({at});
    if (!reservation.allowed) {
      throw new TikTokError(TIKTOK_ERRORS.RATE_LIMITED, {
        messageKey: 'errors.tiktokRateLimit',
        httpStatus: 429,
        status: 429,
        retryAfterMs: Math.max(1, reservation.waitMs),
        details: {
          reason: `local_budget_${reservation.reason ?? 'wait'}`,
          local: true,
          rateLimit: this.budget.snapshot({at})
        }
      });
    }

    const effectiveUa = userAgent ?? this.userAgent;
    const params = new URLSearchParams({
      client: SIGNER_CLIENT,
      client_enter: 'true',
      platform: 'web'
    });
    if (effectiveUa) params.set('user_agent', effectiveUa);
    if (cursor) params.set('cursor', String(cursor));
    const url = `${this.baseUrl}/webcast/rooms/${encodeURIComponent(id)}/connect?${params.toString()}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, {once: true});
    }
    let response;
    try {
      const headers = {
        accept: 'application/protobuf,application/json',
        'user-agent': 'livememory-tiktok/1'
      };
      if (this.apiKey) headers['x-api-key'] = this.apiKey;
      response = await this.fetchImpl(url, {headers, signal: controller.signal});
    } catch (error) {
      const aborted = error?.name === 'AbortError';
      throw new TikTokError(TIKTOK_ERRORS.NETWORK, {
        messageKey: 'errors.tiktokNetwork',
        httpStatus: 502,
        cause: error,
        details: {reason: signal?.aborted ? 'aborted' : (aborted ? 'timeout' : 'signer_fetch')}
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }

    const rateLimit = parseRateLimitHeaders(response.headers, {at: this.now()});
    const buffer = Buffer.from(await response.arrayBuffer());
    const text = bodyText(buffer);
    const body = parseBody(text);

    if (response.status === 200) {
      this.budget.observe(rateLimit, {at: this.now()});
      if (buffer.length === 0) {
        throw new TikTokError(TIKTOK_ERRORS.SIGNER_UNAVAILABLE, {
          messageKey: 'errors.tiktokSignerUnavailable',
          httpStatus: 502,
          details: {reason: 'empty_body', rateLimit}
        });
      }
      let fetchResult;
      try {
        fetchResult = decodeFetchResult(buffer);
      } catch (error) {
        if (looksRateLimited({status: 200, body, text, rateLimit})) {
          const snapshot = this.budget.penalize({
            retryAfterMs: rateLimit.retryAfterMs,
            resetAt: rateLimit.resetAt,
            at: this.now()
          });
          throw new TikTokError(TIKTOK_ERRORS.RATE_LIMITED, {
            messageKey: 'errors.tiktokRateLimit',
            httpStatus: 429,
            status: 200,
            retryAfterMs: Math.max(1000, (snapshot.blockedUntil ?? this.now()) - this.now()),
            details: {reason: 'signer_json_rate_limit', providerMessage: text || null, rateLimit: snapshot}
          });
        }
        throw new TikTokError(TIKTOK_ERRORS.PROTOCOL, {
          messageKey: 'errors.tiktokProtocol',
          httpStatus: 502,
          cause: error,
          details: {
            reason: 'fetch_result_decode',
            providerMessage: body ? text : null,
            rateLimit
          }
        });
      }
      if (!fetchResult.cursor) {
        throw new TikTokError(TIKTOK_ERRORS.PROTOCOL, {
          messageKey: 'errors.tiktokProtocol',
          httpStatus: 502,
          details: {reason: 'missing_cursor', rateLimit}
        });
      }
      return {
        fetchResult,
        cookie: response.headers?.get?.('x-set-tt-cookie') ?? null,
        roomId: response.headers?.get?.('x-room-id') ?? null,
        bytes: buffer.length,
        rateLimit
      };
    }

    if (looksRateLimited({status: response.status, body, text, rateLimit})) {
      const snapshot = this.budget.penalize({
        retryAfterMs: rateLimit.retryAfterMs,
        resetAt: rateLimit.resetAt,
        at: this.now()
      });
      const resetWait = Number.isFinite(rateLimit.resetAt) ? Math.max(0, rateLimit.resetAt - this.now()) : 0;
      const advertisedWait = Math.max(Number(rateLimit.retryAfterMs) || 0, resetWait);
      const waitMs = Math.max(1000, advertisedWait || 60 * 1000);
      throw new TikTokError(TIKTOK_ERRORS.RATE_LIMITED, {
        messageKey: 'errors.tiktokRateLimit',
        httpStatus: 429,
        status: response.status,
        retryAfterMs: waitMs,
        details: {
          reason: 'signer_rate_limit',
          providerMessage: text || null,
          rateLimit: snapshot
        }
      });
    }

    if (response.status === 401 || response.status === 402 || (response.status === 403 && looksPremium(text))) {
      this.budget.observe(rateLimit, {at: this.now()});
      throw new TikTokError(TIKTOK_ERRORS.SIGNER_PREMIUM_REQUIRED, {
        messageKey: 'errors.tiktokSignerPremiumRequired',
        httpStatus: 403,
        status: response.status,
        details: {
          reason: 'signer_refused',
          providerMessage: text || null,
          rateLimit
        }
      });
    }

    if (response.status === 403) {
      this.budget.observe(rateLimit, {at: this.now()});
      throw new TikTokError(TIKTOK_ERRORS.SIGNER_UNAVAILABLE, {
        messageKey: 'errors.tiktokSignerUnavailable',
        httpStatus: 502,
        status: 403,
        details: {reason: 'signer_forbidden', providerMessage: text || null, rateLimit}
      });
    }

    if (response.status === 404) {
      this.budget.observe(rateLimit, {at: this.now()});
      throw new TikTokError(TIKTOK_ERRORS.ROOM_NOT_FOUND, {
        messageKey: 'errors.tiktokRoomNotFound',
        httpStatus: 404,
        status: 404,
        details: {reason: 'signer_room_not_found', rateLimit}
      });
    }

    if (response.status === 400) {
      this.budget.observe(rateLimit, {at: this.now()});
      throw new TikTokError(TIKTOK_ERRORS.PROTOCOL, {
        messageKey: 'errors.tiktokProtocol',
        httpStatus: 502,
        status: 400,
        details: {reason: 'signer_bad_request', providerMessage: text || null, rateLimit}
      });
    }

    this.budget.observe(rateLimit, {at: this.now()});
    if (response.status >= 500) {
      throw new TikTokError(TIKTOK_ERRORS.SIGNER_UNAVAILABLE, {
        messageKey: 'errors.tiktokSignerUnavailable',
        httpStatus: 502,
        status: response.status,
        details: {reason: 'signer_5xx', rateLimit}
      });
    }
    throw new TikTokError(TIKTOK_ERRORS.SIGNER_UNAVAILABLE, {
      messageKey: 'errors.tiktokSignerUnavailable',
      httpStatus: 502,
      status: response.status,
      details: {reason: 'signer_status', providerMessage: text || null, rateLimit}
    });
  }
}

export const __internal = {parseRateLimitHeaders, looksRateLimited, looksPremium};
