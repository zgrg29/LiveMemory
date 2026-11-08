import {AppError} from '../../shared/errors.mjs';

/**
 * YouTube Data API v3 client (read-only, OAuth bearer token).
 *
 * Why OAuth and not an API key:
 * - `videos.list` (locating a broadcast) can be called with an application key,
 *   but `liveChatMessages.list` is an OAuth-scoped method in the official
 *   discovery document, so a key alone is not a supported path for chat;
 * - a shared application key shipped inside a public EXE would be one quota and
 *   one policy footprint for every user, which is neither safe nor compliant.
 *
 * Therefore a single credential type is used: the streamer's own OAuth token,
 * obtained by clicking "Sign in with Google". No API key exists anywhere in the
 * product, and the streamer never creates one.
 *
 * Quota accounting is explicit: every request declares its official unit cost
 * so the UI can show consumption and the adapter can stop politely instead of
 * hammering the API after a `quotaExceeded` answer.
 */

export const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

/** Official quota costs (YouTube Data API v3). */
export const QUOTA_COST = Object.freeze({
  videosList: 1,
  channelsList: 1,
  liveChatMessagesList: 5
});

/** Default daily quota for a new Google Cloud project. */
export const DEFAULT_DAILY_QUOTA = 10000;

export const YOUTUBE_ERRORS = Object.freeze({
  AUTH_REQUIRED: 'YOUTUBE_AUTH_REQUIRED',
  AUTH_EXPIRED: 'YOUTUBE_AUTH_EXPIRED',
  API_KEY_INVALID: 'YOUTUBE_API_KEY_INVALID',
  QUOTA_EXCEEDED: 'YOUTUBE_QUOTA_EXCEEDED',
  RATE_LIMITED: 'YOUTUBE_RATE_LIMITED',
  CHAT_ENDED: 'YOUTUBE_CHAT_ENDED',
  CHAT_NOT_FOUND: 'YOUTUBE_CHAT_NOT_FOUND',
  CHAT_DISABLED: 'YOUTUBE_CHAT_DISABLED',
  VIDEO_NOT_FOUND: 'YOUTUBE_VIDEO_NOT_FOUND',
  FORBIDDEN: 'YOUTUBE_FORBIDDEN',
  NETWORK: 'YOUTUBE_NETWORK',
  BAD_RESPONSE: 'YOUTUBE_BAD_RESPONSE',
  BAD_REQUEST: 'YOUTUBE_BAD_REQUEST',
  /** Anonymous public web-client (experimental) failures. */
  WEB_NETWORK: 'YOUTUBE_WEB_NETWORK',
  WEB_BLOCKED: 'YOUTUBE_WEB_BLOCKED',
  WEB_PROTOCOL: 'YOUTUBE_WEB_PROTOCOL',
  WEB_STALE: 'YOUTUBE_WEB_STALE',
  WEB_RESTRICTED: 'YOUTUBE_WEB_RESTRICTED',
  WEB_NOT_CONFIGURED: 'YOUTUBE_WEB_NOT_CONFIGURED'
});

export class YouTubeApiError extends AppError {
  constructor(code, {
    messageKey = 'errors.youtubeApi',
    httpStatus = 502,
    details = null,
    cause = null,
    reason = null,
    status = null
  } = {}) {
    super(code, {messageKey, httpStatus, details, cause});
    this.name = 'YouTubeApiError';
    this.reason = reason;
    this.status = status;
  }
}

const REASON_MAP = {
  quotaExceeded: {code: YOUTUBE_ERRORS.QUOTA_EXCEEDED, messageKey: 'errors.youtubeQuota', httpStatus: 429},
  dailyLimitExceeded: {code: YOUTUBE_ERRORS.QUOTA_EXCEEDED, messageKey: 'errors.youtubeQuota', httpStatus: 429},
  dailyLimitExceededUnreg: {code: YOUTUBE_ERRORS.API_KEY_INVALID, messageKey: 'errors.youtubeApiKeyInvalid', httpStatus: 401},
  keyInvalid: {code: YOUTUBE_ERRORS.API_KEY_INVALID, messageKey: 'errors.youtubeApiKeyInvalid', httpStatus: 401},
  accessNotConfigured: {code: YOUTUBE_ERRORS.API_KEY_INVALID, messageKey: 'errors.youtubeApiKeyInvalid', httpStatus: 403},
  rateLimitExceeded: {code: YOUTUBE_ERRORS.RATE_LIMITED, messageKey: 'errors.youtubeRateLimit', httpStatus: 429},
  userRateLimitExceeded: {code: YOUTUBE_ERRORS.RATE_LIMITED, messageKey: 'errors.youtubeRateLimit', httpStatus: 429},
  liveChatEnded: {code: YOUTUBE_ERRORS.CHAT_ENDED, messageKey: 'errors.youtubeChatEnded', httpStatus: 410},
  liveChatNotFound: {code: YOUTUBE_ERRORS.CHAT_NOT_FOUND, messageKey: 'errors.youtubeChatUnavailable', httpStatus: 404},
  liveChatDisabled: {code: YOUTUBE_ERRORS.CHAT_DISABLED, messageKey: 'errors.youtubeChatDisabled', httpStatus: 409},
  liveChatPermanentlyDisabled: {code: YOUTUBE_ERRORS.CHAT_DISABLED, messageKey: 'errors.youtubeChatDisabled', httpStatus: 409},
  videoNotFound: {code: YOUTUBE_ERRORS.VIDEO_NOT_FOUND, messageKey: 'errors.youtubeVideoNotFound', httpStatus: 404},
  liveChatIdInvalid: {code: YOUTUBE_ERRORS.CHAT_NOT_FOUND, messageKey: 'errors.youtubeChatUnavailable', httpStatus: 400},
  invalid: {code: YOUTUBE_ERRORS.BAD_REQUEST, messageKey: 'errors.badRequest', httpStatus: 400},
  forbidden: {code: YOUTUBE_ERRORS.FORBIDDEN, messageKey: 'errors.youtubeForbidden', httpStatus: 403}
};

function reasonOf(payload) {
  const errors = payload?.error?.errors;
  if (Array.isArray(errors) && errors.length > 0) return errors[0]?.reason ?? null;
  return payload?.error?.status ?? null;
}

/** Map a Google API error body to a stable, translatable code. */
export function mapApiError({status, payload, path = ''} = {}) {
  const reason = reasonOf(payload);
  const known = reason ? REASON_MAP[reason] : null;
  if (known) {
    return new YouTubeApiError(known.code, {
      messageKey: known.messageKey,
      httpStatus: known.httpStatus,
      reason,
      status
    });
  }
  if (status === 401) {
    return new YouTubeApiError(YOUTUBE_ERRORS.AUTH_REQUIRED, {
      messageKey: 'errors.youtubeAuthRequired',
      httpStatus: 401,
      reason,
      status
    });
  }
  if (status === 403) {
    return new YouTubeApiError(YOUTUBE_ERRORS.FORBIDDEN, {
      messageKey: 'errors.youtubeForbidden',
      httpStatus: 403,
      reason,
      status
    });
  }
  if (status === 404) {
    return new YouTubeApiError(
      path.includes('liveChat') ? YOUTUBE_ERRORS.CHAT_NOT_FOUND : YOUTUBE_ERRORS.VIDEO_NOT_FOUND,
      {
        messageKey: path.includes('liveChat') ? 'errors.youtubeChatUnavailable' : 'errors.youtubeVideoNotFound',
        httpStatus: 404,
        reason,
        status
      }
    );
  }
  return new YouTubeApiError(YOUTUBE_ERRORS.BAD_RESPONSE, {
    messageKey: 'errors.youtubeApi',
    httpStatus: 502,
    details: {status},
    reason,
    status
  });
}

/** Normalize `videos.list` into a small, platform-agnostic live descriptor. */
export function normalizeVideo(video) {
  if (!video || typeof video !== 'object') return null;
  const snippet = video.snippet ?? {};
  const details = video.liveStreamingDetails ?? {};
  const status = video.status ?? {};
  const liveBroadcastContent = snippet.liveBroadcastContent ?? null;
  const actualStartTime = details.actualStartTime ?? null;
  const actualEndTime = details.actualEndTime ?? null;
  const scheduledStartTime = details.scheduledStartTime ?? null;
  const concurrentViewers = details.concurrentViewers === undefined || details.concurrentViewers === null
    ? null
    : Number(details.concurrentViewers);
  const isLive = liveBroadcastContent === 'live' && !actualEndTime;

  let state = 'unknown';
  if (isLive) state = 'live';
  else if (actualEndTime) state = 'ended';
  else if (liveBroadcastContent === 'upcoming' || (scheduledStartTime && !actualStartTime)) state = 'upcoming';
  else if (liveBroadcastContent === 'none' && !details.activeLiveChatId) state = 'video';

  return {
    videoId: video.id ?? null,
    title: snippet.title ?? null,
    channelId: snippet.channelId ?? null,
    channelTitle: snippet.channelTitle ?? null,
    liveBroadcastContent,
    state,
    isLive,
    scheduledStartTime,
    actualStartTime,
    actualEndTime,
    concurrentViewers: Number.isFinite(concurrentViewers) ? concurrentViewers : null,
    activeLiveChatId: details.activeLiveChatId ?? null,
    chatAvailable: Boolean(details.activeLiveChatId),
    privacyStatus: status.privacyStatus ?? null
  };
}

function toEpoch(value) {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Normalize one `liveChatMessages.list` page. */
export function normalizeChatPage(payload) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const polling = Number(payload?.pollingIntervalMillis);
  return {
    items,
    nextPageToken: payload?.nextPageToken ?? null,
    pollingIntervalMillis: Number.isFinite(polling) && polling > 0 ? polling : null,
    offlineAt: toEpoch(payload?.offlineAt),
    activePollItem: payload?.activePollItem ?? null
  };
}

export class YouTubeApi {
  /**
   * Two officially supported credential modes:
   * - `oauth`   : the streamer's own access token (Authorization: Bearer …);
   * - `api-key` : an application-level key for public data only (no user login).
   *
   * The API key is never shipped inside the repository; see `oauth-config.mjs`
   * for how a deployment can provide it. When both are available the OAuth token
   * wins, because it is scoped to the signed-in user and is revocable.
   *
   * @param {{getAccessToken?: () => (string|null|Promise<string|null>), accessToken?: string|null,
   *          apiKey?: string|null, fetchImpl?: Function, now?: Function, timeoutMs?: number,
   *          baseUrl?: string, logger?: object}} options
   */
  constructor({
    getAccessToken = null,
    accessToken = null,
    apiKey = null,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    timeoutMs = 20000,
    baseUrl = YOUTUBE_API_BASE,
    logger = null
  } = {}) {
    this.getAccessToken = typeof getAccessToken === 'function'
      ? getAccessToken
      : () => accessToken;
    this.apiKey = typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : null;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.baseUrl = baseUrl;
    this.logger = logger;
    this.quotaUsed = 0;
    this.quotaLimit = DEFAULT_DAILY_QUOTA;
    this.lastRequestAt = null;
    this.lastCredentialMode = null;
  }

  resetQuota({limit = this.quotaLimit} = {}) {
    this.quotaUsed = 0;
    this.quotaLimit = Number(limit) || DEFAULT_DAILY_QUOTA;
  }

  get quotaRemaining() {
    return Math.max(0, this.quotaLimit - this.quotaUsed);
  }

  get hasApiKey() {
    return Boolean(this.apiKey);
  }

  async #credential() {
    const value = await this.getAccessToken();
    const token = typeof value === 'string' ? value.trim() : '';
    if (token) return {mode: 'oauth', token};
    if (this.apiKey) return {mode: 'api-key', key: this.apiKey};
    throw new YouTubeApiError(YOUTUBE_ERRORS.AUTH_REQUIRED, {
      messageKey: 'errors.youtubeAuthRequired',
      httpStatus: 401
    });
  }

  async request(path, params = {}, {quotaUnits = 1} = {}) {
    const credential = await this.#credential();
    this.lastCredentialMode = credential.mode;
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value === null || value === undefined || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    const headers = {Accept: 'application/json'};
    if (credential.mode === 'oauth') headers.Authorization = `Bearer ${credential.token}`;
    else url.searchParams.set('key', credential.key);
    let response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      throw new YouTubeApiError(YOUTUBE_ERRORS.NETWORK, {
        messageKey: 'errors.youtubeNetwork',
        httpStatus: 502,
        cause: error
      });
    }
    this.lastRequestAt = this.now();
    this.quotaUsed += quotaUnits;
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      throw new YouTubeApiError(YOUTUBE_ERRORS.BAD_RESPONSE, {
        messageKey: 'errors.youtubeApi',
        httpStatus: 502,
        details: {status: response.status}
      });
    }
    if (!response.ok) throw mapApiError({status: response.status, payload, path});
    return payload;
  }

  /**
   * Read the public metadata of one video, including live-streaming details.
   * `liveStreamingDetails.activeLiveChatId` is the chat to poll.
   */
  async videos({videoId, part = 'snippet,liveStreamingDetails,status'} = {}) {
    const payload = await this.request('/videos', {part, id: videoId}, {quotaUnits: QUOTA_COST.videosList});
    const item = Array.isArray(payload?.items) ? payload.items[0] : null;
    if (!item) {
      throw new YouTubeApiError(YOUTUBE_ERRORS.VIDEO_NOT_FOUND, {
        messageKey: 'errors.youtubeVideoNotFound',
        httpStatus: 404
      });
    }
    return normalizeVideo(item);
  }

  async liveChatMessages({
    liveChatId,
    pageToken = null,
    maxResults = 500,
    part = 'snippet,authorDetails'
  } = {}) {
    const payload = await this.request('/liveChat/messages', {
      liveChatId,
      pageToken,
      maxResults,
      part
    }, {quotaUnits: QUOTA_COST.liveChatMessagesList});
    return normalizeChatPage(payload);
  }

  /** The authorized streamer's own channel (used to show "connected account"). */
  async myChannel({part = 'snippet'} = {}) {
    const payload = await this.request('/channels', {part, mine: 'true'}, {quotaUnits: QUOTA_COST.channelsList});
    const item = Array.isArray(payload?.items) ? payload.items[0] : null;
    if (!item) return null;
    return {
      id: item.id ?? null,
      title: item.snippet?.title ?? null
    };
  }
}

export const __internal = {REASON_MAP, reasonOf, toEpoch};
