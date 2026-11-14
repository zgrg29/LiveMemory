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
 *
 * Connection health and broadcast lifecycle are deliberately separate:
 *
 * - HTTP 429, 5xx, network errors, malformed 200 responses and a missing
 *   continuation are *transport* problems. They move the adapter to
 *   `reconnecting`/`failed` (a recoverable state) and never call `onEnd`.
 * - Only an explicit chat closure (the chat page says it has ended/disabled)
 *   or an ended watch page, confirmed by a second independent read, ends the
 *   session. The session row, its messages, viewers and timeline are untouched
 *   by reconnects.
 */

const DEFAULT_OPTIONS = Object.freeze({
  minPollIntervalMs: 2000,
  maxPollIntervalMs: 30000,
  metadataIntervalMs: 60000,
  backoffBaseMs: 1000,
  maxBackoffMs: 60000,
  rateLimitMinBackoffMs: 30000,
  maxRetryAfterMs: 300000,
  maxStartAttempts: 2,
  // Consecutive transport failures before the public state becomes `failed`.
  // The adapter keeps retrying at maxBackoffMs; this is not an end condition.
  maxConsecutiveFailures: 8,
  // A single watch-page end read is only a candidate; wait briefly and read it
  // again before closing the session.
  endConfirmDelayMs: 2000,
  // Do not probe the watch page more often than this after invalid 200s.
  endProbeMinIntervalMs: 10000
});

const DEFAULT_TIMERS = Object.freeze({
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle)
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
  constructor({
    videoId,
    video = null,
    client,
    logger = null,
    now = Date.now,
    options = null,
    timers = null,
    ...rest
  } = {}) {
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
    this.options = {...DEFAULT_OPTIONS, ...(options ?? {}), ...rest};
    this.timers = {...DEFAULT_TIMERS, ...(timers ?? {})};

    this.session = null;
    this.continuation = null;
    this.pollTimer = null;
    this.endConfirmTimer = null;
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
    this.onPlatformStatus = null;
    this.gl = null;

    this.continuationNeedsRefresh = false;
    this.lastFailureAt = null;
    this.lastFailureCode = null;
    this.lastRetryDelayMs = null;
    this.nextRetryAt = null;
    this.endPending = null;
    this.lastEndProbeAt = 0;
    this._refreshingMetadata = false;
  }

  async start({onEvent = () => {}, onStateChange = null, onEnd = null, onPlatformStatus = null} = {}) {
    this.onEvent = onEvent;
    this.onStateChange = onStateChange;
    this.onEnd = onEnd ?? this.onEnd;
    this.onPlatformStatus = onPlatformStatus ?? this.onPlatformStatus;
    this.started = true;
    this.ended = false;
    this.generation += 1;
    this.failures = 0;
    this.consecutiveFailures = 0;
    this.lastError = null;
    this.lastFailureAt = null;
    this.lastFailureCode = null;
    this.lastRetryDelayMs = null;
    this.nextRetryAt = null;
    this.endPending = null;
    this.continuationNeedsRefresh = false;
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
        if (!this.started) return;
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
    this.#clearPollTimer();
    this.#clearEndTimer();
    this.endPending = null;
    this.nextRetryAt = null;
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
      failures: this.consecutiveFailures,
      pollingIntervalMs: this.pollingIntervalMs,
      lastPollAt: this.lastPollAt,
      endReason: this.endReason,
      errorCode: this.lastError?.code ?? null,
      lastFailureCode: this.lastFailureCode,
      lastFailureAt: this.lastFailureAt,
      retrying: this.consecutiveFailures > 0 && !this.ended,
      recoverable: this.consecutiveFailures > 0 && !this.ended,
      retryInMs: this.lastRetryDelayMs,
      nextRetryAt: this.nextRetryAt,
      sessionPreserved: true,
      confirmingEnd: this.endPending?.reason ?? null,
      ...extra
    };
  }

  /* -------------------------------------------------------------- internals */

  #clampInterval(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_POLL_TIMEOUT_MS;
    return Math.min(this.options.maxPollIntervalMs, Math.max(this.options.minPollIntervalMs, numeric));
  }

  #clearPollTimer() {
    if (!this.pollTimer) return;
    this.timers.clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  #clearEndTimer() {
    if (!this.endConfirmTimer) return;
    this.timers.clearTimeout(this.endConfirmTimer);
    this.endConfirmTimer = null;
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

  #emitPlatformStatus(info) {
    try {
      this.onPlatformStatus?.(info);
    } catch (error) {
      this.logger?.warn({event: 'youtube.anonymous.platform.status.failed', code: error?.code ?? 'unknown'});
    }
  }

  /**
   * Read the public watch page. It is only used for metadata and for confirming
   * an explicit end signal; a failed read never ends a session.
   */
  #refreshMetadata({force = false} = {}) {
    if (!this.started || this.ended || this._refreshingMetadata) return;
    const now = this.now();
    if (!force && now - (this.lastMetadataAt ?? 0) < this.options.metadataIntervalMs) return;
    this.lastMetadataAt = now;
    this._refreshingMetadata = true;
    const generation = this.generation;
    this.client.getVideo(this.videoId)
      .then((video) => {
        if (generation !== this.generation || !this.started || this.ended) return;
        if (!video || (video.videoId && video.videoId !== this.videoId)) return;
        this.video = video;
        this.hotness = video.concurrentViewers ?? this.hotness;
        if (video.state === 'ended') {
          this.#requestEndConfirmation('platform_ended', {source: 'watch', generation});
        }
        // `video` (ordinary VOD) and `upcoming` are not proof of a *live*
        // broadcast ending. A transient page variant must not close a session.
      })
      .catch((error) => {
        this.logger?.debug?.({event: 'youtube.anonymous.metadata.failed', code: error?.code ?? 'unknown'});
      })
      .finally(() => {
        this._refreshingMetadata = false;
      });
  }

  #endSignalOf(error) {
    const code = error?.code;
    if (code === YOUTUBE_ERRORS.CHAT_ENDED) return 'chat_ended';
    if (code === YOUTUBE_ERRORS.CHAT_DISABLED) return 'chat_disabled';
    return null;
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
    this.#clearPollTimer();
    const generation = this.generation;
    this.pollTimer = this.timers.setTimeout(() => {
      this.pollTimer = null;
      this.#poll(generation).catch(() => {});
    }, Math.max(0, delayMs));
    this.pollTimer?.unref?.();
  }

  async #poll(generation) {
    if (!this.started || this.ended || generation !== this.generation) return;
    try {
      if (this.continuationNeedsRefresh || !this.session || !this.continuation) {
        await this.#reopenChat(generation);
      }
      if (!this.started || this.ended || generation !== this.generation) return;

      const page = await this.client.poll(this.session, this.continuation);
      if (!this.started || this.ended || generation !== this.generation) return;

      if (!page || page.invalid || (page.ended !== true && !page.continuation)) {
        if (Array.isArray(page?.actions) && page.actions.length > 0) {
          // A malformed page may still carry the last readable messages; ingest
          // them, then treat the structure itself as a recoverable failure.
          this.#consume(page.actions);
        }
        throw new YouTubeApiError(YOUTUBE_ERRORS.WEB_RESPONSE_INVALID, {
          messageKey: 'errors.youtubeWebResponseInvalid',
          httpStatus: 502,
          details: {reason: page?.invalidReason ?? 'missing-continuation-token'}
        });
      }

      if (page.ended === true) {
        this.#consume(page.actions);
        await this.#confirmEnd('chat_ended', {source: 'chat', generation});
        return;
      }

      this.consecutiveFailures = 0;
      this.failures = 0;
      this.lastError = null;
      this.lastRetryDelayMs = null;
      this.nextRetryAt = null;
      this.continuationNeedsRefresh = false;
      this.pollCount += 1;
      this.lastPollAt = this.now();
      if (page.continuation) this.continuation = page.continuation;
      if (page.timeoutMs) this.pollingIntervalMs = this.#clampInterval(page.timeoutMs);
      if (this.state !== CONNECTION_STATE.CONNECTED) {
        this.setState(CONNECTION_STATE.CONNECTED, this.#detail({recovered: true}));
      }
      this.#consume(page.actions, {checkGap: true});
      this.#refreshMetadata();
      if (!this.ended) this.#scheduleNext();
    } catch (error) {
      if (!this.started || this.ended || generation !== this.generation) return;
      await this.#handlePollError(error);
    }
  }

  async #reopenChat(generation) {
    const session = await this.client.openChat(this.videoId);
    if (!this.started || this.ended || generation !== this.generation) return;
    if (!session?.continuation) {
      throw new YouTubeApiError(YOUTUBE_ERRORS.WEB_RESPONSE_INVALID, {
        messageKey: 'errors.youtubeWebResponseInvalid',
        httpStatus: 502,
        details: {reason: 'chat-page-missing-continuation'}
      });
    }
    this.session = session;
    this.continuation = session.continuation;
    this.gl = session.gl ?? this.gl;
    this.pollingIntervalMs = this.#clampInterval(session.timeoutMs);
    this.continuationNeedsRefresh = false;
    this.#consume(session.actions);
    this.logger?.info({event: 'youtube.anonymous.chat.refreshed', videoId: this.videoId});
  }

  async #handlePollError(error) {
    this.lastError = error;
    this.lastFailureAt = this.now();
    this.lastFailureCode = error?.code ?? 'unknown';
    const code = this.lastFailureCode;

    // An explicit "this chat has ended / is disabled" page is an end signal,
    // but it is not trusted on its own: confirm it against the watch page (and,
    // if the broadcast is still live, against a second chat-page read).
    const endSignal = this.#endSignalOf(error);
    if (endSignal) {
      const outcome = await this.#confirmEnd(endSignal, {source: 'chat', generation: this.generation});
      if (outcome === 'ended' || outcome === 'stale' || this.ended) return;
    }

    this.consecutiveFailures += 1;
    this.failures += 1;

    if (code === YOUTUBE_ERRORS.WEB_STALE) {
      // The current continuation can no longer advance. Reopen the chat page
      // before the next poll instead of retrying the same stale token.
      this.continuationNeedsRefresh = true;
    }
    if (code === YOUTUBE_ERRORS.WEB_RESPONSE_INVALID) {
      const now = this.now();
      if (now - this.lastEndProbeAt >= this.options.endProbeMinIntervalMs) {
        this.lastEndProbeAt = now;
        // A missing continuationContents is the classic shape of an ended
        // stream, but also of a temporary bad response. Probe the watch page;
        // the confirmation step still needs a second ended read.
        this.#refreshMetadata({force: true});
      }
    }

    const retryAfter = Number(error?.details?.retryAfterMs);
    const exponential = Math.min(
      this.options.maxBackoffMs,
      this.options.backoffBaseMs * 2 ** Math.min(this.consecutiveFailures - 1, 10)
    );
    const rateLimited = code === YOUTUBE_ERRORS.RATE_LIMITED;
    const retryAfterMs = Number.isFinite(retryAfter) ? Math.max(0, retryAfter) : 0;
    const backoff = rateLimited
      ? Math.min(
        this.options.maxRetryAfterMs,
        Math.max(retryAfterMs, this.options.rateLimitMinBackoffMs)
      )
      : exponential;

    const now = this.now();
    this.lastRetryDelayMs = backoff;
    this.nextRetryAt = now + backoff;
    const escalated = this.consecutiveFailures >= this.options.maxConsecutiveFailures;
    const detail = {
      mode: 'web',
      reason: code,
      code,
      failures: this.consecutiveFailures,
      retryInMs: backoff,
      nextRetryAt: this.nextRetryAt,
      retrying: true,
      recoverable: true,
      sessionPreserved: true,
      lastFailureCode: code,
      lastFailureAt: this.lastFailureAt
    };
    this.setState(escalated ? CONNECTION_STATE.FAILED : CONNECTION_STATE.RECONNECTING, detail);
    this.logger?.warn({
      event: 'youtube.anonymous.poll.failed',
      code,
      failures: this.consecutiveFailures,
      retryInMs: backoff,
      escalated
    });
    // Also check the watch page periodically while chat transport is failing:
    // if the platform explicitly ended the broadcast and chat never recovers,
    // the session must still be able to end from reliable evidence. The helper
    // respects metadataIntervalMs, so a pure network outage adds no request
    // storm.
    this.#refreshMetadata();
    this.#scheduleNext(backoff);
  }

  /**
   * Confirm an end signal. `watch` means the watch page already says ended and
   * is read a second time after a short delay. `chat` means the chat page
   * explicitly reported ended/disabled; it is checked against the watch page,
   * then against a second chat-page read.
   *
   * @returns {Promise<'ended'|'not-ended'|'unconfirmed'|'stale'>}
   */
  async #confirmEnd(reason, {source, generation}) {
    if (!this.started || this.ended || generation !== this.generation) return 'stale';
    const now = this.now();

    if (source === 'watch') {
      let video = null;
      try {
        video = await this.client.getVideo(this.videoId);
      } catch (error) {
        this.lastError = error;
        this.lastFailureCode = error?.code ?? 'unknown';
        this.lastFailureAt = this.now();
        this.#clearEndPending({at: now});
        return 'unconfirmed';
      }
      if (!this.started || this.ended || generation !== this.generation) return 'stale';
      if (video?.videoId && video.videoId !== this.videoId) {
        this.#clearEndPending({at: now});
        return 'not-ended';
      }
      this.video = video ?? this.video;
      if (video?.state === 'ended') {
        this.#finishPlatformEnd(reason, now);
        return 'ended';
      }
      this.#clearEndPending({at: now, live: video?.state === 'live'});
      return 'not-ended';
    }

    let watch = null;
    try {
      watch = await this.client.getVideo(this.videoId);
    } catch (error) {
      this.logger?.debug?.({event: 'youtube.anonymous.end.confirm.watch.failed', code: error?.code ?? 'unknown'});
    }
    if (!this.started || this.ended || generation !== this.generation) return 'stale';
    if (watch?.state === 'ended') {
      this.video = watch;
      this.#finishPlatformEnd(reason, now);
      return 'ended';
    }

    try {
      const session = await this.client.openChat(this.videoId);
      if (!this.started || this.ended || generation !== this.generation) return 'stale';
      this.session = session;
      this.continuation = session.continuation;
      this.gl = session.gl ?? this.gl;
      this.pollingIntervalMs = this.#clampInterval(session.timeoutMs);
      this.continuationNeedsRefresh = false;
      this.#consume(session.actions);
      this.#clearEndPending({at: now, live: watch?.state === 'live'});
      return 'not-ended';
    } catch (error) {
      if (!this.started || this.ended || generation !== this.generation) return 'stale';
      if (this.#endSignalOf(error) === reason) {
        // Two independent reads of the same explicit chat closure. The
        // broadcast may still be live, but chat capture cannot continue.
        this.#finishWithoutPlatformEnd(reason, now);
        return 'ended';
      }
      this.lastError = error;
      this.lastFailureCode = error?.code ?? 'unknown';
      this.lastFailureAt = this.now();
      this.#clearEndPending({at: now});
      return 'unconfirmed';
    }
  }

  #requestEndConfirmation(reason, {source, generation = this.generation}) {
    if (!this.started || this.ended || this.endPending || this.endConfirmTimer) return;
    const now = this.now();
    this.endPending = {reason, source, at: now};
    this.#emitPlatformStatus({status: 'ending', at: now});
    this.setState(this.state, this.#detail());
    this.logger?.info({event: 'youtube.anonymous.end.pending', reason, source});
    this.endConfirmTimer = this.timers.setTimeout(() => {
      this.endConfirmTimer = null;
      this.#confirmEnd(reason, {source, generation}).catch((error) => {
        this.logger?.warn({
          event: 'youtube.anonymous.end.confirm.failed',
          reason,
          code: error?.code ?? 'unknown'
        });
        this.#clearEndPending({at: this.now()});
      });
    }, Math.max(0, this.options.endConfirmDelayMs));
    this.endConfirmTimer?.unref?.();
  }

  #clearEndPending({at = this.now(), live = false} = {}) {
    this.#clearEndTimer();
    const pending = this.endPending;
    this.endPending = null;
    if (!pending) return;
    this.#emitPlatformStatus({
      status: live ? 'live' : 'unknown',
      at,
      ...(live ? {lastLiveSeenAt: at} : {})
    });
    this.setState(this.state, this.#detail());
  }

  #finishPlatformEnd(reason, at) {
    this.#emitPlatformStatus({
      status: 'ended',
      at,
      platformEndedAt: at,
      endQuality: 'poll'
    });
    this.setState(CONNECTION_STATE.STOPPED, this.#detail({reason, platformEnded: true}));
    this.#finish(reason);
  }

  #finishWithoutPlatformEnd(reason, at) {
    // The chat page explicitly closed, but the watch page was not available to
    // confirm the broadcast state. Never claim the broadcast is either live or
    // ended; record that the platform state is unknown.
    this.#emitPlatformStatus({status: 'unknown', at});
    this.setState(CONNECTION_STATE.STOPPED, this.#detail({reason}));
    this.#finish(reason);
  }

  #finish(reason) {
    if (this.ended || !this.started) return;
    this.ended = true;
    this.endReason = reason;
    this.generation += 1;
    this.endPending = null;
    this.#clearPollTimer();
    this.#clearEndTimer();
    this.nextRetryAt = null;
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
