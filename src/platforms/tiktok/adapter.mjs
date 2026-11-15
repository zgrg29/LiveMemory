import {PlatformAdapter, CONNECTION_STATE} from '../shared/adapter.mjs';
import {TIKTOK_ERRORS, TikTokError} from './errors.mjs';
import {mapTikTokMessage, TIKTOK_METHODS} from './messages.mjs';

/**
 * TikTok LIVE adapter over the signed polling transport.
 *
 * Transport only: it owns the polling loop, streak aggregation, reconnect
 * policy and platform-state observation. Persistence, dedupe and viewer
 * aggregation stay in EventIngest.
 *
 * Design notes:
 *   - TikTok's event stream is fetched in signed batches; `cursor` continues a
 *     batch. A batch may contain zero messages, which is not an error.
 *   - `msgId` (inside the message envelope) is the dedupe anchor; a replay after
 *     reconnect therefore never double counts.
 *   - a streakable gift is held until `repeatEnd=1` and emitted once with the
 *     final repeat count. A stale streak is flushed after `streakFlushMs` so a
 *     gift is not lost if the final update never arrives.
 *   - the platform end is confirmed by two independent offline observations
 *     (room page status or a stream-ended control message); network failures
 *     never end a recording.
 */

const DEFAULT_OPTIONS = Object.freeze({
  // The free community signer allows 5 new connections per minute for
  // anonymous clients, so a 15 s poll (4/min) keeps a safety margin. Faster
  // polling would be rejected with HTTP 429, not with more data.
  pollIntervalMs: 15000,
  connectTimeoutMs: 30000,
  statusIntervalMs: 60000,
  statusTimeoutMs: 15000,
  watchdogMs: 90000,
  watchdogCheckMs: 15000,
  maxBackoffMs: 30000,
  maxConsecutiveFailures: 15,
  slowRecoveryMs: 300000,
  streakFlushMs: 10000,
  maxSeenMessageIds: 10000
});

function backoffDelay(attempt, maxMs) {
  return Math.min(maxMs, 1000 * 2 ** Math.min(Math.max(0, attempt), 5));
}

export class TikTokAdapter extends PlatformAdapter {
  constructor({
    uniqueId,
    roomId,
    client = null,
    signer,
    logger = null,
    now = Date.now,
    ...options
  } = {}) {
    super({
      id: 'tiktok',
      platform: 'tiktok',
      label: 'TikTok Live',
      capabilities: ['chat', 'gift', 'gift_streak', 'viewer_count']
    });
    this.uniqueId = String(uniqueId ?? '').replace(/^@/, '');
    this.roomId = roomId === null || roomId === undefined ? null : String(roomId);
    this.client = client;
    this.signer = signer;
    this.logger = logger;
    this.now = now;
    this.options = {...DEFAULT_OPTIONS, ...options};

    this.started = false;
    this.ending = false;
    this.generation = 0;
    this.connectAttempt = 0;
    this.consecutiveFailures = 0;
    this.cursor = null;
    this.internalExt = null;
    this.giftCatalog = null;
    this.pendingGifts = new Map();
    this.seenIds = new Set();
    this.timers = new Set();
    this.lastPollAt = null;
    this.lastPollOkAt = null;
    this.lastStatusAt = null;
    this.offlineObservations = 0;
    this.viewerCount = null;
    this.platformStatus = null;
    this.lastError = null;
    this.counters = {
      polls: 0,
      batches: 0,
      messages: 0,
      chats: 0,
      gifts: 0,
      memberships: 0,
      ignored: 0,
      duplicates: 0,
      emptyBatches: 0,
      errors: 0
    };
    this.onEvent = () => {};
    this.onEnd = () => {};
    this.onPlatformStatus = () => {};
    this.startResolver = null;
  }

  #later(ms, fn) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      try {
        fn();
      } catch (error) {
        this.logger?.warn({event: 'tiktok.timer.failed', code: error?.code ?? 'unknown'});
      }
    }, Math.max(0, ms));
    timer.unref?.();
    this.timers.add(timer);
    return timer;
  }

  #clearTimers() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  #setState(state, detail = null) {
    this.setState(state, detail);
  }

  async start({onEvent = () => {}, onStateChange = null, onEnd = null, onPlatformStatus = null} = {}) {
    if (!this.signer || typeof this.signer.connect !== 'function') {
      throw new TikTokError(TIKTOK_ERRORS.NOT_CONFIGURED, {
        messageKey: 'errors.tiktokSignerUnavailable',
        httpStatus: 503
      });
    }
    if (!this.roomId) {
      throw new TikTokError(TIKTOK_ERRORS.PROTOCOL, {
        messageKey: 'errors.tiktokProtocol',
        httpStatus: 502,
        details: {reason: 'room_id_missing'}
      });
    }
    this.onEvent = onEvent;
    this.onStateChange = onStateChange;
    this.onEnd = onEnd ?? (() => {});
    this.onPlatformStatus = onPlatformStatus ?? (() => {});
    this.started = true;
    this.ending = false;
    this.generation += 1;
    this.connectAttempt = 0;
    this.consecutiveFailures = 0;
    this.cursor = null;
    this.internalExt = null;
    this.pendingGifts.clear();
    this.seenIds.clear();
    this.counters = {
      polls: 0,
      batches: 0,
      messages: 0,
      chats: 0,
      gifts: 0,
      memberships: 0,
      ignored: 0,
      duplicates: 0,
      emptyBatches: 0,
      errors: 0
    };
    this.lastError = null;
    this.#setState(CONNECTION_STATE.CONNECTING, {uniqueId: this.uniqueId, roomId: this.roomId, attempt: 0});

    const generation = this.generation;
    // Gift catalog is optional metadata: a failure only means gift names fall
    // back to the payload name, so it must not block the capture.
    if (this.client?.fetchGiftCatalog) {
      try {
        this.giftCatalog = await this.client.fetchGiftCatalog(this.roomId);
      } catch {
        this.giftCatalog = null;
      }
    }

    await new Promise((resolve, reject) => {
      this.startResolver = {resolve, reject};
      const timer = setTimeout(() => {
        if (this.startResolver) {
          this.startResolver = null;
          reject(new TikTokError(TIKTOK_ERRORS.CONNECT_TIMEOUT, {
            messageKey: 'errors.tiktokConnectTimeout',
            httpStatus: 504,
            details: {uniqueId: this.uniqueId, roomId: this.roomId}
          }));
        }
      }, this.options.connectTimeoutMs);
      timer.unref?.();
      this.#firstPoll(generation).catch((error) => {
        if (!this.startResolver) return;
        const {reject: rejectStart} = this.startResolver;
        this.startResolver = null;
        clearTimeout(timer);
        rejectStart(error);
      }).finally(() => {
        clearTimeout(timer);
      });
    });

    this.#startStatusLoop(generation);
    this.#startWatchdog(generation);
    this.#scheduleStreakFlush(generation);
  }

  async #firstPoll(generation) {
    try {
      const result = await this.signer.connect({roomId: this.roomId, cursor: null});
      if (generation !== this.generation || !this.started) return;
      this.cursor = result.fetchResult.cursor ?? null;
      this.internalExt = result.fetchResult.internalExt ?? null;
      this.#applyFetchResult(result.fetchResult);
      this.lastPollAt = this.now();
      this.lastPollOkAt = this.lastPollAt;
      this.#setState(CONNECTION_STATE.CONNECTED, {
        uniqueId: this.uniqueId,
        roomId: this.roomId,
        transport: this.signer.mode ?? 'community-signer'
      });
      this.#scheduleNextPoll(generation, this.#nextDelay());
      if (this.startResolver) {
        const {resolve} = this.startResolver;
        this.startResolver = null;
        resolve();
      }
    } catch (error) {
      if (generation !== this.generation || !this.started) {
        if (this.startResolver) {
          const {reject} = this.startResolver;
          this.startResolver = null;
          reject(error);
        }
        return;
      }
      this.#recordError(error, {phase: 'connect'});
      if (this.startResolver) {
        const {reject} = this.startResolver;
        this.startResolver = null;
        reject(error);
      }
    }
  }

  #nextDelay() {
    const fetchInterval = Number(this.lastFetchInterval) || 0;
    return Math.max(this.options.pollIntervalMs, fetchInterval);
  }

  #scheduleNextPoll(generation, delay) {
    if (!this.started || generation !== this.generation) return;
    this.#later(delay, () => this.#pollOnce(generation));
  }

  async #pollOnce(generation) {
    if (!this.started || generation !== this.generation) return;
    this.lastPollAt = this.now();
    try {
      const result = await this.signer.connect({roomId: this.roomId, cursor: this.cursor});
      if (!this.started || generation !== this.generation) return;
      this.counters.polls += 1;
      this.cursor = result.fetchResult.cursor ?? this.cursor;
      this.internalExt = result.fetchResult.internalExt ?? this.internalExt;
      this.#applyFetchResult(result.fetchResult);
      this.consecutiveFailures = 0;
      this.lastPollOkAt = this.now();
      if (this.state !== CONNECTION_STATE.CONNECTED) {
        this.#setState(CONNECTION_STATE.CONNECTED, {
          uniqueId: this.uniqueId,
          roomId: this.roomId,
          attempt: this.connectAttempt
        });
      }
      this.#scheduleNextPoll(generation, this.#nextDelay());
    } catch (error) {
      if (!this.started || generation !== this.generation) return;
      this.counters.errors += 1;
      this.#recordError(error, {phase: 'poll'});
      const failure = this.consecutiveFailures;
      if (failure >= this.options.maxConsecutiveFailures) {
        this.#setState(CONNECTION_STATE.FAILED, {
          uniqueId: this.uniqueId,
          roomId: this.roomId,
          code: error?.code ?? 'unknown',
          attempts: failure
        });
        this.#scheduleNextPoll(generation, this.options.slowRecoveryMs);
        return;
      }
      this.#setState(CONNECTION_STATE.RECONNECTING, {
        uniqueId: this.uniqueId,
        roomId: this.roomId,
        code: error?.code ?? 'unknown',
        attempt: failure
      });
      const retryAfter = Number(error?.retryAfterMs);
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter, this.options.maxBackoffMs)
        : backoffDelay(failure, this.options.maxBackoffMs);
      this.#scheduleNextPoll(generation, delay);
    }
  }

  #recordError(error, {phase = 'poll'} = {}) {
    this.counters.errors += 1;
    this.lastError = {code: error?.code ?? 'unknown', at: this.now(), phase};
    this.consecutiveFailures += 1;
    this.logger?.warn({
      event: 'tiktok.transport.error',
      phase,
      code: error?.code ?? 'unknown',
      uniqueId: this.uniqueId,
      roomId: this.roomId,
      attempt: this.consecutiveFailures
    });
    if (error?.code === TIKTOK_ERRORS.SIGNER_PREMIUM_REQUIRED) {
      // A provider that suddenly wants a paid plan will not start working by
      // retrying quickly; keep the state explicit and probe slowly.
      this.consecutiveFailures = this.options.maxConsecutiveFailures;
    }
  }

  #scheduleStreakFlush(generation) {
    if (!this.started || generation !== this.generation) return;
    this.#later(2000, () => {
      this.#flushStaleStreaks();
      if (this.started && generation === this.generation) this.#scheduleStreakFlush(generation);
    });
  }

  #flushStaleStreaks() {
    const cutoff = this.now() - this.options.streakFlushMs;
    for (const [key, entry] of this.pendingGifts) {
      if (entry.updatedAt > cutoff) continue;
      this.pendingGifts.delete(key);
      this.#emitGift(entry);
    }
  }

  #emitGift(entry) {
    if (!entry?.event) return;
    this.counters.gifts += 1;
    try {
      this.onEvent({...entry.event, occurred_at: entry.event.occurred_at ?? this.now()});
    } catch (error) {
      this.logger?.warn({event: 'tiktok.emit.failed', kind: 'gift', code: error?.code ?? 'unknown'});
    }
  }

  #applyFetchResult(fetchResult) {
    const interval = Number(fetchResult?.fetchInterval);
    if (Number.isFinite(interval) && interval > 0) this.lastFetchInterval = interval;
    const messages = fetchResult?.messages ?? [];
    if (messages.length === 0) {
      this.counters.emptyBatches += 1;
      return;
    }
    this.counters.batches += 1;
    for (const message of messages) {
      this.#applyMessage(message);
    }
  }

  #applyMessage(message) {
    this.counters.messages += 1;
    let mapped;
    try {
      mapped = mapTikTokMessage(message, {giftCatalog: this.giftCatalog, now: this.now()});
    } catch (error) {
      this.counters.ignored += 1;
      this.logger?.warn({event: 'tiktok.message.decode.failed', method: message?.method ?? null, code: error?.code ?? 'unknown'});
      return;
    }
    if (mapped.kind === 'ignored') {
      this.counters.ignored += 1;
      return;
    }
    if (mapped.kind === 'viewers') {
      if (Number.isFinite(mapped.viewerCount)) this.viewerCount = mapped.viewerCount;
      return;
    }
    if (mapped.kind === 'control') {
      // 3 = STREAM_ENDED. Treated as one offline observation; two are required.
      if (mapped.action === 3) this.#observeOffline({reason: 'control_message'});
      return;
    }
    if (mapped.kind === 'gift') {
      const key = mapped.groupKey;
      const previous = this.pendingGifts.get(key);
      if (!previous) {
        this.pendingGifts.set(key, {event: mapped.event, updatedAt: this.now(), generation: this.generation});
      } else {
        previous.event = mapped.event;
        previous.updatedAt = this.now();
      }
      if (mapped.final) {
        const entry = this.pendingGifts.get(key);
        this.pendingGifts.delete(key);
        if (entry) this.#emitGift(entry);
      }
      return;
    }
    if (mapped.kind === 'event') {
      const event = mapped.event;
      const dedupeId = event.external_id ? String(event.external_id) : null;
      if (dedupeId) {
        if (this.seenIds.has(dedupeId)) {
          this.counters.duplicates += 1;
          return;
        }
        this.seenIds.add(dedupeId);
        if (this.seenIds.size > this.options.maxSeenMessageIds) {
          const oldest = this.seenIds.values().next().value;
          this.seenIds.delete(oldest);
        }
      }
      if (event.event_type === 'chat') this.counters.chats += 1;
      if (event.event_type === 'membership') this.counters.memberships += 1;
      try {
        this.onEvent(event);
      } catch (error) {
        this.logger?.warn({event: 'tiktok.emit.failed', kind: event.event_type, code: error?.code ?? 'unknown'});
      }
    }
  }

  #startStatusLoop(generation) {
    if (!this.client?.resolveRoom) return;
    const run = async () => {
      if (!this.started || generation !== this.generation) return;
      await this.#checkPlatformStatus();
      if (!this.started || generation !== this.generation) return;
      this.#later(this.options.statusIntervalMs, run);
    };
    this.#later(this.options.statusIntervalMs, run);
  }

  async #checkPlatformStatus() {
    const observedAt = this.now();
    this.lastStatusAt = observedAt;
    try {
      const room = await this.client.resolveRoom(this.uniqueId);
      if (!this.started) return;
      if (room.isLive) {
        this.offlineObservations = 0;
        this.platformStatus = {status: 'live', at: observedAt};
        this.onPlatformStatus({status: 'live', at: observedAt, lastLiveSeenAt: observedAt});
        return;
      }
      this.#observeOffline({reason: 'room_offline', at: observedAt});
    } catch (error) {
      // A failed status read is not evidence that the stream ended.
      this.logger?.warn({event: 'tiktok.status.failed', code: error?.code ?? 'unknown'});
    }
  }

  #observeOffline({reason, at = this.now()} = {}) {
    this.offlineObservations += 1;
    this.platformStatus = {status: 'offline', at, reason};
    this.onPlatformStatus({
      status: 'offline',
      at,
      platformEndedAt: at,
      endQuality: 'verified',
      reason
    });
    if (this.offlineObservations >= 2 && !this.ending) {
      this.ending = true;
      this.#setState(CONNECTION_STATE.STOPPED, {reason: 'platform_ended'});
      try {
        this.onEnd({reason: 'platform_ended', quality: 'verified', observedAt: at});
      } catch (error) {
        this.logger?.warn({event: 'tiktok.end.callback.failed', code: error?.code ?? 'unknown'});
      }
    }
  }

  #startWatchdog(generation) {
    const run = () => {
      if (!this.started || generation !== this.generation) return;
      const last = this.lastPollAt ?? 0;
      if (this.lastPollOkAt && this.now() - last > this.options.watchdogMs && this.state === CONNECTION_STATE.CONNECTED) {
        this.#setState(CONNECTION_STATE.RECONNECTING, {
          uniqueId: this.uniqueId,
          roomId: this.roomId,
          code: 'watchdog'
        });
        this.#scheduleNextPoll(generation, 0);
      }
      this.#later(this.options.watchdogCheckMs, run);
    };
    this.#later(this.options.watchdogCheckMs, run);
  }

  async stop() {
    this.started = false;
    this.ending = true;
    this.generation += 1;
    this.#clearTimers();
    if (this.startResolver) {
      const {reject} = this.startResolver;
      this.startResolver = null;
      reject(new TikTokError(TIKTOK_ERRORS.STOPPED, {messageKey: 'errors.tiktokStopped', httpStatus: 409}));
    }
    // Emit any pending streak as its last known state so a shutdown does not
    // silently drop a gift that already arrived.
    for (const entry of this.pendingGifts.values()) this.#emitGift(entry);
    this.pendingGifts.clear();
    this.#setState(CONNECTION_STATE.STOPPED, {uniqueId: this.uniqueId});
  }

  snapshot() {
    return {
      ...super.snapshot(),
      uniqueId: this.uniqueId,
      roomId: this.roomId,
      cursor: this.cursor ? `${String(this.cursor).slice(0, 12)}...` : null,
      counters: {...this.counters},
      pendingStreaks: this.pendingGifts.size,
      viewerCount: this.viewerCount,
      platformStatus: this.platformStatus,
      lastPollOkAt: this.lastPollOkAt,
      lastError: this.lastError
    };
  }
}

export const __internal = {backoffDelay, DEFAULT_OPTIONS, TIKTOK_METHODS};
