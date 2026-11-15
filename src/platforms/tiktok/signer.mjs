import {TIKTOK_ERRORS, TikTokError} from './errors.mjs';
import {decodeFetchResult} from './messages.mjs';

/**
 * Signed fetch transport ("community signer").
 *
 * TikTok only returns live events to a client that presents a signed bootstrap
 * request. LiveMemory does not forge signatures: it calls the free community
 * signing endpoint used by the open-source TikTok LIVE ecosystem. No API key,
 * no payment and no Business plan is required; the endpoint currently answers
 * anonymous clients and reports its rate limit in response headers.
 *
 * Why this is a documented trade-off:
 *   - room metadata and the gift catalog work fully locally (see `client.mjs`);
 *   - events (`chat`/gifts) need the signed transport, and TikTok's web page
 *     gates the same data behind login;
 *   - therefore this module is an explicit, disclosed cloud dependency, not a
 *     hidden one: the UI states it, and `baseUrl` can point at a self-hosted
 *     compatible signer.
 *
 * Nothing here bypasses a captcha or an access-control response. A provider
 * that answers "premium plan required" is surfaced as `TIKTOK_SIGNER_PREMIUM_REQUIRED`
 * instead of being retried until it works.
 */

export const DEFAULT_SIGN_BASE_URL = 'https://api.eulerstream.com';
/** The provider expects a known client identifier; this one is its documented Node client. */
export const SIGNER_CLIENT = 'ttlive-node';

function retryAfterMs(response) {
  const header = response.headers?.get?.('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

export class TikTokSigner {
  constructor({
    baseUrl = DEFAULT_SIGN_BASE_URL,
    apiKey = null,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    timeoutMs = 15000,
    userAgent = null
  } = {}) {
    this.baseUrl = String(baseUrl ?? DEFAULT_SIGN_BASE_URL).replace(/\/+$/, '');
    this.apiKey = apiKey ? String(apiKey) : null;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.userAgent = userAgent;
  }

  get mode() {
    return this.apiKey ? 'community-signer-with-key' : 'community-signer';
  }

  /**
   * Fetch the next signed batch for a room.
   * @param {{roomId: string, cursor?: string|null, userAgent?: string}} options
   * @returns {Promise<{fetchResult: object, cookie: string|null, roomId: string|null, bytes: number}>}
   */
  async connect({roomId, cursor = null, userAgent = null} = {}) {
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
    let response;
    try {
      const headers = {
        accept: 'application/protobuf,application/json',
        'user-agent': 'livememory-tiktok/1'
      };
      if (this.apiKey) headers['x-api-key'] = this.apiKey;
      response = await this.fetchImpl(url, {headers, signal: controller.signal});
    } catch (error) {
      throw new TikTokError(TIKTOK_ERRORS.NETWORK, {
        messageKey: 'errors.tiktokNetwork',
        httpStatus: 502,
        cause: error,
        details: {reason: error?.name === 'AbortError' ? 'timeout' : 'signer_fetch'}
      });
    } finally {
      clearTimeout(timer);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (response.status === 429) {
      throw new TikTokError(TIKTOK_ERRORS.RATE_LIMITED, {
        messageKey: 'errors.tiktokRateLimit',
        httpStatus: 429,
        status: 429,
        retryAfterMs: retryAfterMs(response),
        details: {reason: 'signer_rate_limit', limit: response.headers?.get?.('ratelimit-limit') ?? null}
      });
    }
    if (response.status === 401 || response.status === 402 || response.status === 403) {
      throw new TikTokError(TIKTOK_ERRORS.SIGNER_PREMIUM_REQUIRED, {
        messageKey: 'errors.tiktokSignerPremiumRequired',
        httpStatus: 403,
        status: response.status,
        details: {
          reason: 'signer_refused',
          providerMessage: buffer.toString('utf8').slice(0, 200) || null
        }
      });
    }
    if (response.status >= 500) {
      throw new TikTokError(TIKTOK_ERRORS.SIGNER_UNAVAILABLE, {
        messageKey: 'errors.tiktokSignerUnavailable',
        httpStatus: 502,
        status: response.status
      });
    }
    if (response.status !== 200) {
      throw new TikTokError(TIKTOK_ERRORS.SIGNER_UNAVAILABLE, {
        messageKey: 'errors.tiktokSignerUnavailable',
        httpStatus: 502,
        status: response.status,
        details: {reason: 'signer_status'}
      });
    }
    if (buffer.length === 0) {
      throw new TikTokError(TIKTOK_ERRORS.SIGNER_UNAVAILABLE, {
        messageKey: 'errors.tiktokSignerUnavailable',
        httpStatus: 502,
        details: {reason: 'empty_body'}
      });
    }
    let fetchResult;
    try {
      fetchResult = decodeFetchResult(buffer);
    } catch (error) {
      throw new TikTokError(TIKTOK_ERRORS.PROTOCOL, {
        messageKey: 'errors.tiktokProtocol',
        httpStatus: 502,
        cause: error,
        details: {reason: 'fetch_result_decode'}
      });
    }
    if (!fetchResult.cursor) {
      throw new TikTokError(TIKTOK_ERRORS.PROTOCOL, {
        messageKey: 'errors.tiktokProtocol',
        httpStatus: 502,
        details: {reason: 'missing_cursor'}
      });
    }
    return {
      fetchResult,
      cookie: response.headers?.get?.('x-set-tt-cookie') ?? null,
      roomId: response.headers?.get?.('x-room-id') ?? null,
      bytes: buffer.length
    };
  }
}

export const __internal = {retryAfterMs};
