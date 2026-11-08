import {PlatformAdapter, CONNECTION_STATE} from '../shared/adapter.mjs';
import {mapYouTubeChatMessage, IGNORED_YOUTUBE_EVENTS} from './mapper.mjs';
import {QUOTA_COST, YOUTUBE_ERRORS, YouTubeApiError} from './api.mjs';

/**
 * YouTube Live Chat transport.
 *
 * Transport only: it resolves the broadcast, polls `liveChatMessages.list`
 * (or `streamList`, see below), honours `pollingIntervalMillis` and
 * `nextPageToken`, keeps the session alive across transient network failures and
 * converts each item into a canonical draft. Persistence and de-duplication stay
 * in EventIngest, exactly like every other platform.
 *
 * The official reference recommends `liveChatMessages.streamList` for polling;
 * it is not part of the published discovery document, so this adapter uses the
 * documented `liveChatMessages.list` + `pageToken` loop and keeps the request
 * rate inside the server-provided interval. A page that arrives twice cannot
 * double count because message ids are used as dedupe keys.
 *
 * Quota: every poll costs 5 units and a broadcast metadata refresh costs 1. The
 * adapter refuses to start a poll it cannot afford and stops with a clear reason
 * instead of retrying into a `quotaExceeded` wall.
 */

const DEFAULT_OPTIONS = Object.freeze({
  pollIntervalMs: 5000,
  minPollIntervalMs: 2000,
  maxPollIntervalMs: 30000,
  metadataIntervalMs: 60000,
  backoffBaseMs: 1000,
  maxBackoffMs: 30000,
  maxStartAttempts: 3,
  startAttemptDelayMs: 1500
});

export class YouTubeLiveChatAdapter extends PlatformAdapter {
  constructor({videoId, video = null, api, logger = null, now = Date.now, ...options} = {}) {
    super({
      id: 'youtube',
      platform: 'youtube',
      label: 'YouTube Live',
      capabilities: ['chat', 'super_chat', 'super_sticker', 'membership', 'membership_gifting']
    });
    this.videoId = String(videoId ?? '');
    this.video = video;
    this.api = api;
    this.logger = logger;
    this.now = now;
    this.options = {...DEFAULT_OPTIONS, ...options};

    this.liveChatId = video?.activeLiveChatId ?? null;
    this.pageToken = null;
    this.pollTimer = null;
    this.generation = 0;
    this.started = false;
    this.ended = false;
    this.failures = 0;
    this.pollCount = 0;
    this.messagesSeen = 0;
    this.duplicatesSkipped = 0;
    this.lastPollAt = null;
    this.lastMetadataAt = null;
    this.pollingIntervalMs = this.options.pollIntervalMs;
    this.lastError = null;
    this.endReason = null;
    this.hotness = video?.concurrentViewers ?? null;
    this.onEnd = null;
    this.onAuthError = null;
  }

  async start({onEvent = () => {}, onStateChange = null, onEnd = null, onAuthError = null} = {}) {
    this.onEvent = onEvent;
    this.onStateChange = onStateChange;
    this.onEnd = onEnd ?? this.onEnd;
    this.onAuthError = onAuthError ?? this.onAuthError;
    this.started = true;
    this.ended = false;
    this.generation += 1;
    this.failures = 0;
    this.setState(CONNECTION_STATE.CONNECTING, {videoId: this.videoId});

    let video = this.video;
    if (!video) {
      video = await this.api.videos({videoId: this.videoId});
      this.video = video;
    }

    const precondition = checkRecordable(video);
    if (precondition) {
      this.lastError = precondition;
      this.setState(CONNECTION_STATE.FAILED, {reason: precondition.code});
      throw precondition;
    }
    this.liveChatId = video.activeLiveChatId;
    this.hotness = video.concurrentViewers ?? null;
    this.lastMetadataAt = this.now();

    // The first page is fetched with retries: a single packet loss must not end
    // the user's attempt to record a stream.
    const generation = this.generation;
    let lastError = null;
    for (let attempt = 1; attempt <= this.options.maxStartAttempts; attempt += 1) {
      try {
        const page = await this.#fetchPage();
        this.#consume(page);
        this.setState(CONNECTION_STATE.CONNECTED, {
          videoId: this.videoId,
          liveChatId: this.liveChatId,
          viewers: this.hotness
        });
        this.logger?.info({event: 'youtube.connected', videoId: this.videoId, attempt});
        this.#scheduleNext();
        return;
      } catch (error) {
        lastError = error;
        const fatal = this.#fatalReason(error);
        if (fatal) {
          this.lastError = error;
          this.setState(CONNECTION_STATE.FAILED, {reason: fatal});
          throw error;
        }
        if (attempt < this.options.maxStartAttempts) {
          await delay(this.options.startAttemptDelayMs * attempt);
        }
      }
    }
    this.lastError = lastError;
    this.setState(CONNECTION_STATE.FAILED, {reason: lastError?.code ?? 'unknown'});
    throw lastError;
  }

  async stop() {
    this.started = false;
    this.generation += 1;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.setState(CONNECTION_STATE.STOPPED, {videoId: this.videoId});
  }

  snapshot() {
    return {
      ...super.snapshot(),
      detail: {
        videoId: this.videoId,
        liveChatId: this.liveChatId,
        viewers: this.hotness,
        pollCount: this.pollCount,
        messagesSeen: this.messagesSeen,
        failures: this.failures,
        quotaUnits: this.api?.quotaUsed ?? 0,
        pollingIntervalMs: this.pollingIntervalMs,
        lastPollAt: this.lastPollAt,
        endReason: this.endReason,
        errorCode: this.lastError?.code ?? null
      }
    };
  }

  /* -------------------------------------------------------------- internals */

  async #fetchPage() {
    if (this.api.quotaRemaining < QUOTA_COST.liveChatMessagesList) {
      throw new YouTubeApiError(YOUTUBE_ERRORS.QUOTA_EXCEEDED, {
        messageKey: 'errors.youtubeQuota',
        httpStatus: 429,
        details: {reason: 'local-quota-guard'}
      });
    }
    return this.api.liveChatMessages({
      liveChatId: this.liveChatId,
      pageToken: this.pageToken
    });
  }

  #consume(page) {
    this.pollCount += 1;
    this.lastPollAt = this.now();
    this.failures = 0;
    const interval = page.pollingIntervalMillis ?? this.options.pollIntervalMs;
    this.pollingIntervalMs = Math.min(
      this.options.maxPollIntervalMs,
      Math.max(this.options.minPollIntervalMs, interval)
    );
    for (const item of page.items ?? []) {
      try {
        const draft = mapYouTubeChatMessage(item, {receivedAt: this.now()});
        if (!draft) {
          const type = item?.snippet?.type ?? 'unknown';
          if (!IGNORED_YOUTUBE_EVENTS.includes(type)) {
            this.logger?.debug?.({event: 'youtube.unhandled', type});
          }
          continue;
        }
        this.messagesSeen += 1;
        this.onEvent(draft);
      } catch (error) {
        this.logger?.warn({event: 'youtube.event.failed', code: error?.code ?? 'unknown'});
      }
    }
    if (page.nextPageToken) this.pageToken = page.nextPageToken;
    if (page.offlineAt) {
      this.#finish('chat_ended');
      return;
    }
    this.hotness = this.hotness ?? null;
    this.#maybeRefreshMetadata();
  }

  #maybeRefreshMetadata() {
    if (this.refreshingMetadata) return;
    const elapsed = this.now() - (this.lastMetadataAt ?? 0);
    if (elapsed < this.options.metadataIntervalMs) return;
    this.lastMetadataAt = this.now();
    this.refreshingMetadata = true;
    this.api.videos({videoId: this.videoId})
      .then((video) => {
        this.video = video;
        this.hotness = video.concurrentViewers ?? this.hotness;
        if (video.state === 'ended' || video.state === 'video') {
          this.#finish('broadcast_ended');
        } else if (video.state === 'live' && this.detail?.viewers !== this.hotness) {
          this.detail = {...(this.detail ?? {}), viewers: this.hotness};
        }
      })
      .catch((error) => {
        this.logger?.debug?.({event: 'youtube.metadata.failed', code: error?.code ?? 'unknown'});
      })
      .finally(() => {
        this.refreshingMetadata = false;
      });
  }

  #fatalReason(error) {
    const code = error?.code;
    if (code === YOUTUBE_ERRORS.CHAT_ENDED) return 'chat_ended';
    if (code === YOUTUBE_ERRORS.CHAT_DISABLED) return 'chat_disabled';
    if (code === YOUTUBE_ERRORS.CHAT_NOT_FOUND) return 'chat_not_found';
    if (code === YOUTUBE_ERRORS.QUOTA_EXCEEDED) return 'quota';
    if (code === YOUTUBE_ERRORS.VIDEO_NOT_FOUND) return 'video_not_found';
    if (code === YOUTUBE_ERRORS.AUTH_REQUIRED) return 'auth';
    if (code === YOUTUBE_ERRORS.FORBIDDEN) return 'forbidden';
    return null;
  }

  #finish(reason) {
    if (this.ended) return;
    this.ended = true;
    this.endReason = reason;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.logger?.info({event: 'youtube.ended', reason, videoId: this.videoId});
    try {
      this.onEnd?.({reason, videoId: this.videoId, messagesSeen: this.messagesSeen});
    } catch {
      /* never throw from a lifecycle callback */
    }
  }

  #scheduleNext(delayMs = this.pollingIntervalMs) {
    if (!this.started || this.ended) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    const generation = this.generation;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      this.#poll(generation).catch(() => {});
    }, delayMs);
    this.pollTimer.unref?.();
  }

  async #poll(generation) {
    if (!this.started || this.ended || generation !== this.generation) return;
    try {
      const page = await this.#fetchPage();
      if (generation !== this.generation) return;
      if (this.state !== CONNECTION_STATE.CONNECTED) {
        this.setState(CONNECTION_STATE.CONNECTED, {
          videoId: this.videoId,
          liveChatId: this.liveChatId,
          viewers: this.hotness,
          recovered: true
        });
      }
      this.#consume(page);
      if (!this.ended) this.#scheduleNext();
    } catch (error) {
      if (generation !== this.generation) return;
      this.lastError = error;
      const fatal = this.#fatalReason(error);
      if (fatal === 'chat_ended' || fatal === 'chat_not_found' || fatal === 'chat_disabled') {
        this.setState(CONNECTION_STATE.STOPPED, {reason: fatal});
        this.#finish(fatal);
        return;
      }
      if (fatal === 'quota') {
        this.setState(CONNECTION_STATE.FAILED, {reason: 'quota', code: error.code});
        this.#finish('quota');
        return;
      }
      if (fatal === 'auth') {
        const recovered = await this.#tryAuthRecovery();
        if (recovered) {
          this.#scheduleNext(0);
          return;
        }
        this.setState(CONNECTION_STATE.AUTH_REQUIRED, {reason: 'auth'});
        this.#finish('auth');
        return;
      }
      // Transient: keep the session alive and back off. A short network blip
      // must never end a recording.
      this.failures += 1;
      const wait = Math.min(this.options.maxBackoffMs, this.options.backoffBaseMs * 2 ** Math.min(this.failures - 1, 5));
      this.setState(CONNECTION_STATE.RECONNECTING, {
        videoId: this.videoId,
        failures: this.failures,
        retryInMs: wait,
        code: error?.code ?? 'unknown'
      });
      this.logger?.warn({event: 'youtube.poll.failed', code: error?.code ?? 'unknown', failures: this.failures});
      this.#scheduleNext(wait);
    }
  }

  async #tryAuthRecovery() {
    if (typeof this.onAuthError !== 'function') return false;
    try {
      return (await this.onAuthError()) === true;
    } catch {
      return false;
    }
  }
}

/**
 * A broadcast must currently be live and have a chat. Uploaded videos and
 * finished/upcoming broadcasts are rejected with distinct, translatable codes so
 * the UI can explain exactly what is wrong.
 */
export function checkRecordable(video) {
  const make = (code, messageKey) => Object.assign(new Error(code), {
    name: 'YouTubeApiError',
    code,
    messageKey
  });
  if (!video) return make(YOUTUBE_ERRORS.VIDEO_NOT_FOUND, 'errors.youtubeVideoNotFound');
  if (video.state === 'upcoming') return make('YOUTUBE_NOT_LIVE_UPCOMING', 'errors.youtubeUpcoming');
  if (video.state === 'ended') return make('YOUTUBE_NOT_LIVE_ENDED', 'errors.youtubeEnded');
  if (video.state === 'video') return make('YOUTUBE_NOT_LIVE_VIDEO', 'errors.youtubeNotLive');
  if (!video.isLive) return make('YOUTUBE_NOT_LIVE', 'errors.youtubeNotLive');
  if (!video.activeLiveChatId || video.chatAvailable === false) {
    return make(YOUTUBE_ERRORS.CHAT_DISABLED, 'errors.youtubeChatDisabled');
  }
  return null;
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export const __internal = {DEFAULT_OPTIONS, delay};
