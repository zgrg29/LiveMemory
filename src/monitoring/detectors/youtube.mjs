import {resolveBroadcasterIdentity} from '../../shared/broadcaster.mjs';
import {isAppError} from '../../shared/errors.mjs';
import {DEFAULT_USER_AGENT, YOUTUBE_WEB_BASE} from '../../platforms/youtube/anonymous/parser.mjs';
import {monitorError} from '../errors.mjs';
import {MONITOR_ERROR} from '../constants.mjs';
import {
  CHANNEL_ID_PATTERN,
  channelPagePath,
  parseChannelIdentity,
  parseChannelLivePage,
  parseChannelRss,
  parseYouTubeChannelInput
} from '../youtube-discovery.mjs';

/**
 * YouTube channel detector without the Data API, OAuth, API key or cookies.
 *
 * Per check (only while the channel is NOT being recorded):
 *   GET /channel/<id>/live            one public HTML page
 *
 * The page either embeds the watch page of the current broadcast (live/upcoming)
 * or the channel page (not live). A structural parse failure may fall back to:
 *   GET /feeds/videos.xml?channel_id=...   recent public uploads
 *   GET /watch?v=<candidate>               confirm isLive for at most 2 entries
 *
 * The fallback never marks a video live on its own; `isLive`/`isLiveNow` on the
 * watch page is always required.
 */

const RETRYABLE_STATUS = new Set([408, 425, 500, 502, 503, 504]);

function parseRetryAfter(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1000, 30 * 60 * 1000);
}

function lookRestricted(text) {
  return /consent\.youtube\.com|Before you continue to YouTube|Sign in to confirm|confirm your age/i.test(text);
}

export class YouTubeChannelDetector {
  constructor({
    client,
    fetchImpl = globalThis.fetch,
    baseUrl = YOUTUBE_WEB_BASE,
    logger = null,
    now = Date.now,
    timeoutMs = 20000,
    pacer = null,
    policy = null,
    maxFallbackVideos = 2
  } = {}) {
    this.client = client;
    this.fetchImpl = fetchImpl;
    this.baseUrl = String(baseUrl ?? YOUTUBE_WEB_BASE).replace(/\/$/, '');
    this.logger = logger;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.pacer = pacer;
    this.policy = policy;
    this.maxFallbackVideos = maxFallbackVideos;
    this.requestCount = 0;
  }

  #headers(referer) {
    return {
      'user-agent': DEFAULT_USER_AGENT,
      'accept-language': 'en-US,en;q=0.9',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      referer,
      'cache-control': 'no-cache',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none'
    };
  }

  async #fetchPage(path, {accept = null} = {}) {
    if (this.pacer) await this.pacer.wait('youtube', this.policy?.requestGapMs);
    this.requestCount += 1;
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          ...this.#headers(`${this.baseUrl}/`),
          ...(accept ? {accept} : {})
        },
        redirect: 'follow',
        credentials: 'omit',
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      throw monitorError(MONITOR_ERROR.NETWORK, {cause: error, details: {causeCode: error?.code ?? 'fetch'}});
    }
    let text = '';
    try {
      text = await response.text();
    } catch (error) {
      throw monitorError(MONITOR_ERROR.NETWORK, {cause: error, details: {causeCode: 'body'}});
    }
    if (response.status === 429) {
      throw monitorError(MONITOR_ERROR.RATE_LIMITED, {
        details: {status: 429, retryAfterMs: parseRetryAfter(response.headers.get('retry-after'))}
      });
    }
    if (response.status === 401 || response.status === 403) {
      throw monitorError(MONITOR_ERROR.BLOCKED, {details: {status: response.status}});
    }
    if (response.status === 404) {
      throw monitorError(MONITOR_ERROR.NOT_FOUND, {details: {status: 404}});
    }
    if (RETRYABLE_STATUS.has(response.status)) {
      throw monitorError(MONITOR_ERROR.NETWORK, {details: {status: response.status}});
    }
    if (!response.ok) {
      throw monitorError(MONITOR_ERROR.PROTOCOL, {details: {status: response.status}});
    }
    if (lookRestricted(text) && !text.includes('"videoDetails"') && !text.includes('"externalId"')) {
      throw monitorError(MONITOR_ERROR.RESTRICTED, {details: {status: response.status}});
    }
    return {url, finalUrl: response.url || url, status: response.status, text};
  }

  /**
   * Resolve a URL/@handle/channel id/video link into a stable channel identity.
   * This runs once when the target is added.
   */
  async resolve(input) {
    const parsed = parseYouTubeChannelInput(input);
    let channelId = null;
    let channelTitle = null;
    let handle = null;
    let canonicalUrl = null;
    let videoId = null;

    if (parsed.kind === 'video') {
      videoId = parsed.videoId;
      let video;
      try {
        video = await this.client.getVideo(videoId);
      } catch (error) {
        throw this.#clientError(error);
      }
      channelId = video.channelId ?? null;
      channelTitle = video.channelTitle ?? null;
      if (!channelId || !CHANNEL_ID_PATTERN.test(channelId)) {
        throw monitorError(MONITOR_ERROR.NOT_FOUND, {details: {reason: 'video_channel_missing'}});
      }
      // The watch page already gave us the channel id; the channel page is only
      // for the display name/handle and must not fail the whole add operation.
      try {
        const page = await this.#fetchPage(`/channel/${channelId}`);
        const identity = parseChannelIdentity(page.text);
        if (identity?.channelId === channelId) {
          channelTitle = identity.title ?? channelTitle;
          handle = identity.handle;
          canonicalUrl = identity.canonicalUrl;
        }
      } catch (error) {
        this.logger?.debug?.({event: 'monitor.youtube.channel.meta.failed', code: error?.code ?? 'unknown'});
      }
    } else {
      const page = await this.#fetchPage(channelPagePath(parsed));
      const identity = parseChannelIdentity(page.text);
      channelId = identity?.channelId ?? null;
      if (!channelId) {
        const fromUrl = /\/channel\/(UC[A-Za-z0-9_-]{22})/.exec(page.finalUrl ?? '')?.[1] ?? null;
        channelId = fromUrl;
      }
      if (!channelId || !CHANNEL_ID_PATTERN.test(channelId)) {
        throw monitorError(MONITOR_ERROR.PROTOCOL, {details: {reason: 'channel_identity_missing'}});
      }
      channelTitle = identity?.title ?? null;
      handle = identity?.handle ?? (parsed.kind === 'handle' ? parsed.handle : null);
      canonicalUrl = identity?.canonicalUrl ?? null;
    }

    const displayName = channelTitle
      || (handle ? handle.replace(/^@/, '') : null)
      || channelId;
    const broadcaster = resolveBroadcasterIdentity({
      platform: 'youtube',
      broadcasterUid: channelId,
      broadcasterName: channelTitle
    });
    return {
      platform: 'youtube',
      targetKey: channelId,
      displayName,
      platformUid: channelId,
      broadcasterId: broadcaster.id,
      broadcasterIdentity: broadcaster,
      input: String(input ?? '').trim(),
      meta: {
        channelId,
        channelTitle,
        handle,
        canonicalUrl,
        resolvedFromVideoId: videoId,
        discovery: 'public-web'
      }
    };
  }

  /**
   * @returns {{status:'live'|'upcoming'|'offline', videoId?:string|null,
   *   title?:string|null, channelTitle?:string|null, startedAt?:string|null,
   *   concurrentViewers?:number|null, via:'live-page'|'rss'}}
   */
  async detect(target) {
    const channelId = String(target.target_key ?? target.targetKey ?? '');
    if (!CHANNEL_ID_PATTERN.test(channelId)) {
      throw monitorError(MONITOR_ERROR.INVALID_INPUT, {httpStatus: 400});
    }
    try {
      return await this.#checkLivePage(channelId);
    } catch (error) {
      if (!isAppError(error) || ![MONITOR_ERROR.PROTOCOL, MONITOR_ERROR.UNKNOWN].includes(error.code)) throw error;
      try {
        return await this.#checkRssFallback(channelId, error);
      } catch (fallbackError) {
        this.logger?.warn?.({
          event: 'monitor.youtube.fallback.failed',
          code: fallbackError?.code ?? 'unknown',
          firstCode: error.code
        });
        throw error;
      }
    }
  }

  async #checkLivePage(channelId) {
    const page = await this.#fetchPage(`/channel/${channelId}/live`);
    const parsed = parseChannelLivePage(page.text, {channelId});
    if (parsed.kind === 'live') {
      return {
        status: 'live',
        videoId: parsed.videoId,
        title: parsed.title,
        channelTitle: parsed.channelTitle,
        startedAt: parsed.startedAt,
        concurrentViewers: parsed.concurrentViewers,
        via: 'live-page'
      };
    }
    if (parsed.kind === 'upcoming') {
      return {
        status: 'upcoming',
        videoId: parsed.videoId,
        title: parsed.title,
        channelTitle: parsed.channelTitle,
        startedAt: parsed.startedAt,
        via: 'live-page'
      };
    }
    if (parsed.kind === 'offline') {
      return {
        status: 'offline',
        videoId: parsed.videoId ?? null,
        title: parsed.title ?? null,
        channelTitle: parsed.channelTitle ?? null,
        via: 'live-page'
      };
    }
    if (parsed.kind === 'restricted') {
      throw monitorError(MONITOR_ERROR.RESTRICTED, {details: {reason: parsed.reason}});
    }
    throw monitorError(MONITOR_ERROR.PROTOCOL, {details: {reason: parsed.reason ?? 'invalid_live_page'}});
  }

  async #checkRssFallback(channelId, firstError) {
    const feed = await this.#fetchPage(`/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`, {
      accept: 'application/atom+xml,application/xml;q=0.9,*/*;q=0.8'
    });
    const rss = parseChannelRss(feed.text, {now: this.now()});
    if (rss.channelId && rss.channelId !== channelId) {
      throw monitorError(MONITOR_ERROR.PROTOCOL, {details: {reason: 'rss_channel_mismatch'}});
    }
    const candidates = rss.recent.slice(0, this.maxFallbackVideos);
    let upcoming = null;
    for (const entry of candidates) {
      let video;
      try {
        video = await this.client.getVideo(entry.videoId);
      } catch (error) {
        this.logger?.debug?.({event: 'monitor.youtube.fallback.video.failed', code: error?.code ?? 'unknown'});
        continue;
      }
      if (video.channelId && video.channelId !== channelId) continue;
      if (video.isLive) {
        return {
          status: 'live',
          videoId: video.videoId,
          title: video.title,
          channelTitle: video.channelTitle,
          startedAt: video.actualStartTime ?? null,
          concurrentViewers: video.concurrentViewers ?? null,
          via: 'rss'
        };
      }
      if (video.isUpcoming && !upcoming) {
        upcoming = {
          status: 'upcoming',
          videoId: video.videoId,
          title: video.title,
          channelTitle: video.channelTitle,
          startedAt: video.scheduledStartTime ?? null,
          via: 'rss'
        };
      }
    }
    if (upcoming) return upcoming;
    if (candidates.length === 0) {
      // A structurally broken /live page and an empty feed is still uncertain,
      // not evidence of "offline". Keep the original protocol error visible.
      throw firstError;
    }
    return {status: 'offline', videoId: null, title: null, channelTitle: null, via: 'rss'};
  }

  #clientError(error) {
    if (isAppError(error)) return error;
    const code = String(error?.code ?? '');
    if (code === 'YOUTUBE_VIDEO_NOT_FOUND' || code === 'VIDEO_NOT_FOUND') {
      return monitorError(MONITOR_ERROR.NOT_FOUND, {cause: error});
    }
    if (code === 'YOUTUBE_RATE_LIMITED') {
      return monitorError(MONITOR_ERROR.RATE_LIMITED, {
        cause: error,
        details: {retryAfterMs: error?.details?.retryAfterMs ?? null}
      });
    }
    if (code === 'YOUTUBE_WEB_NETWORK') return monitorError(MONITOR_ERROR.NETWORK, {cause: error});
    if (code === 'YOUTUBE_WEB_RESTRICTED') return monitorError(MONITOR_ERROR.RESTRICTED, {cause: error});
    return monitorError(MONITOR_ERROR.PROTOCOL, {cause: error, details: {causeCode: code}});
  }
}

export const __internal = {parseRetryAfter, lookRestricted, RETRYABLE_STATUS};
