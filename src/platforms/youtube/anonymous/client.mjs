import {YouTubeApiError, YOUTUBE_ERRORS} from '../api.mjs';
import {
  DEFAULT_USER_AGENT,
  DEFAULT_POLL_TIMEOUT_MS,
  YOUTUBE_WEB_BASE,
  parseChatPage,
  parseChatResponse,
  parseWatchPage
} from './parser.mjs';

/**
 * Anonymous transport for YouTube's public web live-chat client.
 *
 * No account, cookie, OAuth token or user API key is sent. Requests carry only
 * the public page's own client context. This is an *unofficial* interface: it is
 * undocumented, can change without notice, and its use may conflict with
 * YouTube's Terms of Service. The application therefore keeps it opt-in and
 * clearly labelled as experimental; the official Data API path remains the
 * recommended one.
 */

const RETRYABLE_STATUS = new Set([408, 425, 500, 502, 503, 504]);

function webError(code, messageKey, options = {}) {
  return new YouTubeApiError(code, {messageKey, httpStatus: 502, ...options});
}

function isRetryAfter(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, 300000) : null;
}

export class YouTubeAnonymousClient {
  constructor({
    fetchImpl = globalThis.fetch,
    now = Date.now,
    logger = null,
    baseUrl = YOUTUBE_WEB_BASE,
    timeoutMs = 20000,
    userAgent = DEFAULT_USER_AGENT
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.logger = logger;
    this.baseUrl = String(baseUrl ?? YOUTUBE_WEB_BASE).replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.userAgent = userAgent;
    this.requestCount = 0;
    this.lastRequestAt = null;
  }

  #headers(referer = `${this.baseUrl}/`) {
    return {
      'user-agent': this.userAgent,
      'accept-language': 'en-US,en;q=0.9',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      referer,
      'cache-control': 'no-cache',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none'
    };
  }

  async #fetchText(url, {method = 'GET', body = null, headers = {}} = {}) {
    this.requestCount += 1;
    this.lastRequestAt = this.now();
    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body,
        redirect: 'follow',
        credentials: 'omit',
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      throw webError(YOUTUBE_ERRORS.WEB_NETWORK, 'errors.youtubeWebNetwork', {cause: error});
    }
    let text = '';
    try {
      text = await response.text();
    } catch (error) {
      throw webError(YOUTUBE_ERRORS.WEB_NETWORK, 'errors.youtubeWebNetwork', {cause: error});
    }
    return {response, text};
  }

  /** Read public broadcast metadata from the watch page. */
  async getVideo(videoId) {
    const id = String(videoId ?? '').trim();
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) {
      throw webError('YOUTUBE_LINK_INVALID', 'errors.youtubeLinkInvalid', {httpStatus: 400});
    }
    const url = `${this.baseUrl}/watch?v=${encodeURIComponent(id)}`;
    const {response, text} = await this.#fetchText(url, {headers: this.#headers(url)});
    if (response.status === 429) {
      throw webError(YOUTUBE_ERRORS.RATE_LIMITED, 'errors.youtubeRateLimit', {
        httpStatus: 429,
        details: {retryAfterMs: isRetryAfter(response.headers.get('retry-after'))}
      });
    }
    if (response.status === 403 || response.status === 401) {
      throw webError(YOUTUBE_ERRORS.WEB_RESTRICTED, 'errors.youtubeWebRestricted', {
        details: {status: response.status}
      });
    }
    if (!response.ok) {
      throw webError(
        response.status === 404 ? YOUTUBE_ERRORS.VIDEO_NOT_FOUND : YOUTUBE_ERRORS.WEB_PROTOCOL,
        response.status === 404 ? 'errors.youtubeVideoNotFound' : 'errors.youtubeWebProtocol',
        {details: {status: response.status}}
      );
    }
    const parsed = parseWatchPage(text);
    if (!parsed.ok) {
      if (parsed.reason === 'restricted') {
        throw webError(YOUTUBE_ERRORS.WEB_RESTRICTED, 'errors.youtubeWebRestricted');
      }
      if (parsed.reason === 'no-player') {
        throw webError(YOUTUBE_ERRORS.WEB_PROTOCOL, 'errors.youtubeWebProtocol');
      }
      throw webError(YOUTUBE_ERRORS.VIDEO_NOT_FOUND, 'errors.youtubeVideoNotFound');
    }
    if (parsed.video.videoId && parsed.video.videoId !== id) {
      throw webError(YOUTUBE_ERRORS.WEB_PROTOCOL, 'errors.youtubeWebProtocol', {
        details: {expected: id, actual: parsed.video.videoId}
      });
    }
    return parsed.video;
  }

  /** Open the public chat page and obtain the first continuation token. */
  async openChat(videoId) {
    const id = String(videoId ?? '').trim();
    const url = `${this.baseUrl}/live_chat?is_popout=1&v=${encodeURIComponent(id)}`;
    const {response, text} = await this.#fetchText(url, {headers: this.#headers(url)});
    if (response.status === 429) {
      throw webError(YOUTUBE_ERRORS.RATE_LIMITED, 'errors.youtubeRateLimit', {
        httpStatus: 429,
        details: {retryAfterMs: isRetryAfter(response.headers.get('retry-after'))}
      });
    }
    if (response.status === 403 || response.status === 401) {
      throw webError(YOUTUBE_ERRORS.WEB_RESTRICTED, 'errors.youtubeWebRestricted');
    }
    if (!response.ok) {
      throw webError(YOUTUBE_ERRORS.WEB_PROTOCOL, 'errors.youtubeWebProtocol', {
        details: {status: response.status}
      });
    }
    const parsed = parseChatPage(text);
    if (!parsed.ok) {
      if (parsed.reason === 'disabled') {
        throw webError(YOUTUBE_ERRORS.CHAT_DISABLED, 'errors.youtubeChatDisabled', {httpStatus: 409});
      }
      if (parsed.reason === 'ended') {
        throw webError(YOUTUBE_ERRORS.CHAT_ENDED, 'errors.youtubeChatEnded', {httpStatus: 410});
      }
      if (parsed.reason === 'restricted') {
        throw webError(YOUTUBE_ERRORS.WEB_RESTRICTED, 'errors.youtubeWebRestricted');
      }
      throw webError(YOUTUBE_ERRORS.CHAT_NOT_FOUND, 'errors.youtubeChatUnavailable', {httpStatus: 404});
    }
    if (!parsed.config?.INNERTUBE_CONTEXT || !parsed.continuation) {
      throw webError(YOUTUBE_ERRORS.WEB_PROTOCOL, 'errors.youtubeWebProtocol');
    }
    return {
      videoId: id,
      config: parsed.config,
      actions: parsed.actions,
      continuation: parsed.continuation,
      timeoutMs: parsed.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
      gl: parsed.config.INNERTUBE_CONTEXT?.client?.gl ?? null,
      visitorData: parsed.config.INNERTUBE_CONTEXT?.client?.visitorData ?? null
    };
  }

  /** Fetch the next page of chat actions. */
  async poll(session, continuation = session?.continuation) {
    if (!session?.config?.INNERTUBE_CONTEXT || !continuation) {
      throw webError(YOUTUBE_ERRORS.WEB_STALE, 'errors.youtubeWebStale');
    }
    const url = new URL(`${this.baseUrl}/youtubei/v1/live_chat/get_live_chat`);
    url.searchParams.set('prettyPrint', 'false');
    const key = session.config.INNERTUBE_API_KEY;
    if (key) url.searchParams.set('key', key);
    const context = session.config.INNERTUBE_CONTEXT;
    const client = context.client ?? {};
    const headers = {
      'content-type': 'application/json',
      'user-agent': this.userAgent,
      origin: this.baseUrl,
      referer: `${this.baseUrl}/live_chat?is_popout=1&v=${encodeURIComponent(session.videoId ?? '')}`,
      'x-youtube-client-name': String(session.config.INNERTUBE_CONTEXT_CLIENT_NAME ?? 1),
      'x-youtube-client-version': String(session.config.INNERTUBE_CONTEXT_CLIENT_VERSION ?? client.clientVersion ?? '')
    };
    if (client.visitorData) headers['x-goog-visitor-id'] = client.visitorData;
    const payload = {context, continuation};
    const {response, text} = await this.#fetchText(url.toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
    if (response.status === 429) {
      throw webError(YOUTUBE_ERRORS.RATE_LIMITED, 'errors.youtubeRateLimit', {
        httpStatus: 429,
        details: {retryAfterMs: isRetryAfter(response.headers.get('retry-after'))}
      });
    }
    if (response.status === 400 || response.status === 404 || response.status === 410) {
      throw webError(YOUTUBE_ERRORS.WEB_STALE, 'errors.youtubeWebStale', {
        details: {status: response.status}
      });
    }
    if (response.status === 403 || response.status === 401) {
      throw webError(YOUTUBE_ERRORS.WEB_RESTRICTED, 'errors.youtubeWebRestricted', {
        details: {status: response.status}
      });
    }
    if (RETRYABLE_STATUS.has(response.status)) {
      throw webError(YOUTUBE_ERRORS.WEB_NETWORK, 'errors.youtubeWebNetwork', {
        details: {status: response.status}
      });
    }
    if (!response.ok) {
      throw webError(YOUTUBE_ERRORS.WEB_PROTOCOL, 'errors.youtubeWebProtocol', {
        details: {status: response.status}
      });
    }
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (error) {
      throw webError(YOUTUBE_ERRORS.WEB_PROTOCOL, 'errors.youtubeWebProtocol', {cause: error});
    }
    if (data?.error) {
      const reason = data.error?.errors?.[0]?.reason ?? data.error?.status ?? null;
      if (reason === 'failedPrecondition') {
        throw webError(YOUTUBE_ERRORS.WEB_STALE, 'errors.youtubeWebStale', {details: {reason}});
      }
      throw webError(YOUTUBE_ERRORS.WEB_PROTOCOL, 'errors.youtubeWebProtocol', {details: {reason}});
    }
    return parseChatResponse(data);
  }
}

export const __internal = {webError, RETRYABLE_STATUS};
