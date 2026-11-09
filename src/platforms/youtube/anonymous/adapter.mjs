import {PlatformAdapter, CONNECTION_STATE} from '../../shared/adapter.mjs';
import {mapYouTubeAnonymousChatItem} from '../mapper.mjs';
import {YouTubeApiError, YOUTUBE_ERRORS} from '../errors.mjs';
import {chatItemOfAction, DEFAULT_POLL_TIMEOUT_MS} from './parser.mjs';

/**
 * Transport adapter for the anonymous public web live-chat client.
 *
 * Polling, continuation refresh, backoff and end detection live here. Every
 * parsed item still becomes a canonical draft through `../mapper.mjs` and is
 * written by SessionManager -> EventIngest; this adapter never touches SQLite.
 */

const DEFAULT_OPTIONS = Object.freeze({
  minPollIntervalMs: 2000,
  maxPollIntervalMs: 30000,
  metadataIntervalMs: 60000,
  backoffBaseMs: 1000,
  maxBackoffMs: 60000,
  maxStartAttempts: 2,
  maxConsecutiveFailures: 8
});

function transientError(code, messageKey) {
  return new YouTubeApiError(code, {messageKey, httpStatus: 502});
}

/**
 * A broadcast must currently be live. Chat availability is verified separately
 * by opening the public chat page before the session is created.
 */
export function checkAnonymousRecordable(video) {
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
  if (video.chatAvailable === false) return make(YOUTUBE_ERRORS.CHAT_DISABLED, 'errors.youtubeChatDisabled');
  return null;
}

export class YouTubeAnonymousLiveChatAdapter extends PlatformAdapter {
  constructor({videoId, video = null, client, logger = null, now = Date.now, ...options} = {}) {
    super({
      id: 'youtube-anonymous',
      platform: 'youtube',
      label: 'YouTube Live (anonymous web)',
      capabilities: ['chat', 'super_chat', 'super_sticker', 'membership', 'membership_gifting', 'gift', 'badges']
    });
    this.videoId = String(videoId ?? '');
    this.video = video;
    this.client = client;
    this.logger = logger;
    this.now = now;
    this.options = {...DEFAULT_OPTIONS, ...options};

    this.session = null;
    this.continuation = null;
    this.pollTimer = null;
    this.generation = 0;
    this.started = false;
    this.ended = false;
    this.failures = 0;
    this.consecutiveFailures = 0;
    this.pollCount = 0;
    this.actionsSeen = 0;
    this.messagesSeen = 0;
    this.identityComplete = 0;
    this.paidEvents = 0;
    this.giftEvents = 0;
    this.gapSuspected = 0;
    this.lastEventAt = null;
    this.lastPollAt = null;
    this.lastMetadataAt = null;
    this.pollingIntervalMs = DEFAULT_POLL_TIMEOUT_MS;
    this.lastError = null;
    this.endReason = null;
    this.hotness = video?.concurrentViewers ?? null;
    this.onEnd = null;
    this.gl = null;
    this._refreshingMetadata = false;
  }

  async start({onEvent = () => {}, onStateChange = null, onEnd = null} = {}) {
    this.onEvent = onEvent;
    this.onStateChange = onStateChange;
    this.onEnd = onEnd ?? this.onEnd;
    this.started = true;
    this.ended = false;
    this.generation += 1;
    this.failures = 0;
    this.consecutiveFailures = 0;
    this.setState(CONNECTION_STATE.CONNECTING, {
      mode: 'web',
      videoId: this.videoId
    });

    let video = this.video;
    let lastError = null;
    for (let attempt = 1; attempt <= this.options.maxStartAttempts; attempt += 1) {
      try {
        if (!video) video = await this.client.getVideo(this.videoId);
        this.video = video;
        const precondition = checkAnonymousRecordable(video);
        if (precondition) throw precondition;
        this.hotness = video.concurrentViewers ?? null;
        this.lastMetadataAt = this.now();
        const session = await this.client.openChat(this.videoId);
        this.session = session;
        this.continuation = session.continuation;
        this.gl = session.gl ?? null;
        this.pollingIntervalMs = this.#clampInterval(session.timeoutMs);
        this.#consume(session.actions);
        this.setState(CONNECTION_STATE.CONNECTED, this.#detail({recovered: false}));
        this.logger?.info({
          event: 'youtube.anonymous.connected',
          videoId: this.videoId,
          actions: session.actions.length
        });
        this.#scheduleNext();
        return;
      } catch (error) {
        lastError = error;
        const fatal = this.#fatalReason(error);
        if (fatal) {
          this.lastError = error;
          this.setState(CONNECTION_STATE.FAILED, {mode: 'web', reason: fatal});
          throw error;
        }
        if (attempt < this.options.maxStartAttempts) {
          await delay(this.options.backoffBaseMs * attempt);
        }
      }
    }
    this.lastError = lastError;
    this.setState(CONNECTION_STATE.FAILED, {
      mode: 'web',
      reason: lastError?.code ?? 'unknown'
    });
    throw lastError;
  }

  async stop() {
    this.started = false;
    this.generation += 1;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.setState(CONNECTION_STATE.STOPPED, {mode: 'web', videoId: this.videoId});
  }

  snapshot() {
    return {
      ...super.snapshot(),
      detail: this.#detail()
    };
  }

  #detail(extra = {}) {
    return {
      mode: 'web',
      videoId: this.videoId,
      title: this.video?.title ?? null,
      viewers: this.hotness,
      pollCount: this.pollCount,
      actionsSeen: this.actionsSeen,
      messagesSeen: this.messagesSeen,
      identityComplete: this.identityComplete,
      paidEvents: this.paidEvents,
      giftEvents: this.giftEvents,
      gapSuspected: this.gapSuspected,
      lastEventAt: this.lastEventAt,
      failures: this.failures,
      pollingIntervalMs: this.pollingIntervalMs,
      lastPollAt: this.lastPollAt,
      endReason: this.endReason,
      errorCode: this.lastError?.code ?? null,
      ...extra
    };
  }

  /* -------------------------------------------------------------- internals */

  #clampInterval(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_POLL_TIMEOUT_MS;
    return Math.min(this.options.maxPollIntervalMs, Math.max(this.options.minPollIntervalMs, numeric));
  }

  #consume(actions, {checkGap = false} = {}) {
    if (!Array.isArray(actions) || actions.length === 0) return;
    for (const action of actions) {
      this.actionsSeen += 1;
      const item = chatItemOfAction(action);
      if (!item) continue;
      try {
        const draft = mapYouTubeAnonymousChatItem(item, {
          receivedAt: this.now(),
          gl: this.gl,
          videoId: this.videoId
        });
        if (!draft) {
          this.logger?.debug?.({event: 'youtube.anonymous.unhandled', type: Object.keys(item)[0] ?? 'unknown'});
          continue;
        }
        // A jump of more than 90 s between consecutive received messages can
        // indicate a dropped page. It is only a diagnostic: a quiet chat can
        // legitimately have long gaps, so the UI says "possible", never
        // "incomplete".
        if (checkGap && this.lastEventAt && draft.occurred_at - this.lastEventAt > 90000) {
          this.gapSuspected += 1;
        }
        this.lastEventAt = Math.max(this.lastEventAt ?? 0, draft.occurred_at);
        this.messagesSeen += 1;
        if (draft.identity_complete) this.identityComplete += 1;
        if (draft.is_paid) this.paidEvents += 1;
        if (draft.event_type === 'gift') this.giftEvents += 1;
        this.onEvent(draft);
      } catch (error) {
        this.logger?.warn({event: 'youtube.anonymous.event.failed', code: error?.code ?? 'unknown'});
      }
    }
  }

  #maybeRefreshMetadata() {
    if (this._refreshingMetadata) return;
    if (this.now() - (this.lastMetadataAt ?? 0) < this.options.metadataIntervalMs) return;
    this.lastMetadataAt = this.now();
    this._refreshingMetadata = true;
    this.client.getVideo(this.videoId)
      .then((video) => {
        this.video = video;
        this.hotness = video.concurrentViewers ?? this.hotness;
        if (video.state === 'ended' || video.state === 'video') {
          this.#finish('broadcast_ended');
        }
      })
      .catch((error) => {
        this.logger?.debug?.({event: 'youtube.anonymous.metadata.failed', code: error?.code ?? 'unknown'});
      })
      .finally(() => {
        this._refreshingMetadata = false;
      });
  }

  #fatalReason(error) {
    const code = error?.code;
    if (code === YOUTUBE_ERRORS.CHAT_ENDED) return 'chat_ended';
    if (code === YOUTUBE_ERRORS.CHAT_DISABLED) return 'chat_disabled';
    if (code === YOUTUBE_ERRORS.CHAT_NOT_FOUND) return 'chat_not_found';
    if (code === YOUTUBE_ERRORS.VIDEO_NOT_FOUND) return 'video_not_found';
    if (code === 'YOUTUBE_NOT_LIVE_UPCOMING') return 'upcoming';
    if (code === 'YOUTUBE_NOT_LIVE_ENDED' || code === 'YOUTUBE_NOT_LIVE_VIDEO' || code === 'YOUTUBE_NOT_LIVE') return 'not_live';
    if (code === YOUTUBE_ERRORS.WEB_NOT_CONFIGURED) return 'not_configured';
    return null;
  }

  #scheduleNext(delayMs = this.pollingIntervalMs) {
    if (!this.started || this.ended) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    const generation = this.generation;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      this.#poll(generation).catch(() => {});
    }, Math.max(0, delayMs));
    this.pollTimer.unref?.();
  }

  async #poll(generation) {
    if (!this.started || this.ended || generation !== this.generation) return;
    try {
      const page = await this.client.poll(this.session, this.continuation);
      if (generation !== this.generation) return;
      this.consecutiveFailures = 0;
      this.failures = 0;
      this.pollCount += 1;
      this.lastPollAt = this.now();
      if (page.continuation) this.continuation = page.continuation;
      if (page.timeoutMs) this.pollingIntervalMs = this.#clampInterval(page.timeoutMs);
      if (page.ended) {
        this.#consume(page.actions);
        this.#finish('chat_ended');
        return;
      }
      if (this.state !== CONNECTION_STATE.CONNECTED) {
        this.setState(CONNECTION_STATE.CONNECTED, this.#detail({recovered: true}));
      }
      this.#consume(page.actions, {checkGap: true});
      this.#maybeRefreshMetadata();
      if (!this.ended) this.#scheduleNext();
    } catch (error) {
      if (generation !== this.generation) return;
      await this.#handlePollError(error);
    }
  }

  async #handlePollError(error) {
    this.lastError = error;
    const fatal = this.#fatalReason(error);
    if (fatal) {
      this.setState(CONNECTION_STATE.STOPPED, {mode: 'web', reason: fatal});
      this.#finish(fatal);
      return;
    }
    this.consecutiveFailures += 1;
    this.failures += 1;
    const code = error?.code ?? 'unknown';

    if (code === YOUTUBE_ERRORS.WEB_STALE) {
      const refreshed = await this.#refreshChat();
      if (this.ended) return;
      if (refreshed) {
        this.setState(CONNECTION_STATE.CONNECTED, this.#detail({recovered: true, reason: 'continuation_refreshed'}));
        this.consecutiveFailures = 0;
        this.#scheduleNext(0);
        return;
      }
    }

    if (this.consecutiveFailures >= this.options.maxConsecutiveFailures) {
      this.setState(CONNECTION_STATE.FAILED, {
        mode: 'web',
        reason: code,
        failures: this.consecutiveFailures
      });
      this.logger?.warn({event: 'youtube.anonymous.stopped', code, failures: this.consecutiveFailures});
      this.#finish('connection_failed');
      return;
    }

    const retryAfter = Number(error?.details?.retryAfterMs);
    const backoff = code === YOUTUBE_ERRORS.RATE_LIMITED
      ? Math.max(retryAfter || 0, 30000)
      : Math.min(this.options.maxBackoffMs, this.options.backoffBaseMs * 2 ** Math.min(this.consecutiveFailures - 1, 6));
    this.setState(CONNECTION_STATE.RECONNECTING, {
      mode: 'web',
      failures: this.consecutiveFailures,
      retryInMs: backoff,
      code
    });
    this.logger?.warn({event: 'youtube.anonymous.poll.failed', code, failures: this.consecutiveFailures});
    this.#scheduleNext(backoff);
  }

  async #refreshChat() {
    try {
      const session = await this.client.openChat(this.videoId);
      this.session = session;
      this.continuation = session.continuation;
      this.gl = session.gl ?? this.gl;
      this.pollingIntervalMs = this.#clampInterval(session.timeoutMs);
      this.#consume(session.actions);
      this.logger?.info({event: 'youtube.anonymous.chat.refreshed', videoId: this.videoId});
      return true;
    } catch (error) {
      this.logger?.warn({event: 'youtube.anonymous.chat.refresh.failed', code: error?.code ?? 'unknown'});
      const fatal = this.#fatalReason(error);
      if (fatal) {
        this.setState(CONNECTION_STATE.STOPPED, {mode: 'web', reason: fatal});
        this.#finish(fatal);
      }
      return false;
    }
  }

  #finish(reason) {
    if (this.ended) return;
    this.ended = true;
    this.endReason = reason;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.logger?.info({event: 'youtube.anonymous.ended', reason, videoId: this.videoId});
    try {
      this.onEnd?.({
        reason,
        videoId: this.videoId,
        actionsSeen: this.actionsSeen,
        messagesSeen: this.messagesSeen
      });
    } catch {
      /* never throw from a lifecycle callback */
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export const __internal = {DEFAULT_OPTIONS, delay, transientError};
