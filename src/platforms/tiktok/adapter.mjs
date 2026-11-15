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
 * The first real trial exposed a state-machine bug, not a parser bug: the free
 * community signer allows ~30 requests/hour for anonymous clients, while the
 * adapter polled every 15 s and shortened the advertised `Retry-After` to 30 s.
 * The result was a permanent "reconnecting" state that kept spending requests
 * inside an already exhausted window. This adapter now:
 *   - asks the shared rate budget before every request and surfaces
 *     `waiting for quota` as its own state;
 *   - never retries a 429 before the advertised reset;
 *   - resets a stale cursor instead of retrying it forever;
 *   - keeps one poll in flight and one timer, so a watchdog cannot open a
 *     second connection;
 *   - records interruption/recovery times and a conservative "possible gap"
 *     flag, without claiming that missed chat was backfilled.
 *
 * A zero-message batch is a successful poll, never a connection failure.
 */

const DEFAULT_OPTIONS = Object.freeze({
  // Base interval when the provider has not advertised a budget yet. Once the
  // first response arrives, the shared budget normally stretches this to
  // ~2 minutes for the 30/hour anonymous allowance.
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
  maxSeenMessageIds: 10000,
  cursorMaxAgeMs: 300000,
  maxRateLimitWaitMs: 12 * 60 * 60 * 1000,
  statusCheckDelayMs: 5000
});

const FATAL_CODES = new Set([
  TIKTOK_ERRORS.NOT_CONFIGURED,
  TIKTOK_ERRORS.SIGNER_PREMIUM_REQUIRED,
  TIKTOK_ERRORS.LOGIN_REQUIRED,
  TIKTOK_ERRORS.BROWSER_UNAVAILABLE,
  TIKTOK_ERRORS.BROWSER_FAILED,
  TIKTOK_ERRORS.ROOM_OFFLINE,
  TIKTOK_ERRORS.ROOM_NOT_FOUND
]);

function backoffDelay(attempt, maxMs) {
  return Math.min(maxMs, 1000 * 2 ** Math.min(Math.max(0, attempt), 5));
}

function jitterMs(baseMs, random) {
  if (!Number.isFinite(baseMs) || baseMs <= 0) return 0;
  const span = Math.min(5000, Math.max(50, Math.round(baseMs * 0.1)));
  return Math.round(random() * span);
}

export class TikTokAdapter extends PlatformAdapter {
  constructor({
    uniqueId,
    roomId,
    client = null,
    signer,
    logger = null,
    now = Date.now,
    random = Math.random,
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
    this.random = random;
    this.options = {...DEFAULT_OPTIONS, ...options};
    if (!options.statusCheckDelayMs) {
      this.options.statusCheckDelayMs = Math.min(this.options.statusIntervalMs, 5000);
    }
    this.transport = 'signer';

    this.started = false;
    this.ending = false;
    this.generation = 0;
    this.connectAttempt = 0;
    this.consecutiveFailures = 0;
    this.cursor = null;
    this.internalExt = null;
    this.cursorFetchedAt = null;
    this.giftCatalog = null;
    this.pendingGifts = new Map();
    this.seenIds = new Set();
    this.timers = new Set();
    this.pollTimer = null;
    this.polling = false;
    this.pollAbort = null;
    this.nextPollAt = null;
    this.lastPollAt = null;
    this.lastPollOkAt = null;
    this.lastEventAt = null;
    this.lastEventType = null;
    this.lastStatusAt = null;
    this.offlineObservations = 0;
    this.viewerCount = null;
    this.platformStatus = null;
    this.lastError = null;
    this.disconnectedAt = null;
    this.lastGap = null;
    this.gaps = [];
    this.reconnectAttempts = 0;
    this.recoveredCount = 0;
    this.cursorResets = 0;
    this.disconnectCursorResets = 0;
    this.needsRoomRecheck = false;
    this.stopReason = 'user';
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
      errors: 0,
      rateLimited: 0,
      cursorResets: 0
    };
    this.onEvent = () => {};
    this.onEnd = () => {};
    this.onPlatformStatus = () => {};
    this.startResolver = null;
    this.startTimer = null;
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
    this.pollTimer = null;
  }

  #category() {
    if (this.state === CONNECTION_STATE.CONNECTED) return 'normal';
    if (this.state === CONNECTION_STATE.RATE_LIMITED) return 'rate_limit';
    if (this.state === CONNECTION_STATE.AUTH_REQUIRED) return 'user_action';
    if (this.state === CONNECTION_STATE.RECONNECTING) {
      return this.consecutiveFailures <= 1 ? 'temporary' : 'auto_reconnect';
    }
    if (this.state === CONNECTION_STATE.FAILED) {
      return this.lastError?.needsUserAction ? 'user_action' : 'failed';
    }
    if (this.state === CONNECTION_STATE.STOPPED) {
      return this.platformStatus?.reason === 'platform_ended' ? 'ended' : 'stopped';
    }
    if (this.state === CONNECTION_STATE.CONNECTING) return 'connecting';
    return 'idle';
  }

  #budgetSnapshot() {
    try {
      return this.signer?.availability?.() ?? null;
    } catch {
      return null;
    }
  }

  #detail(extra = {}) {
    const now = this.now();
    const nextRetryAt = Object.hasOwn(extra, 'nextRetryAt') ? extra.nextRetryAt : this.nextPollAt;
    return {
      uniqueId: this.uniqueId,
      roomId: this.roomId,
      transport: this.transport,
      category: extra.category ?? this.#category(),
      attempt: this.consecutiveFailures,
      reconnectAttempts: this.reconnectAttempts,
      recoveries: this.recoveredCount,
      lastSuccessAt: this.lastPollOkAt,
      lastEventAt: this.lastEventAt,
      lastEventType: this.lastEventType,
      disconnectedAt: this.disconnectedAt,
      recoveredAt: extra.recoveredAt ?? this.lastGap?.endedAt ?? null,
      gap: this.lastGap,
      possibleGap: Boolean(this.lastGap?.possibleMissed),
      lastFailure: this.lastError,
      nextRetryAt,
      retryInMs: Number.isFinite(nextRetryAt) ? Math.max(0, nextRetryAt - now) : null,
      rateLimit: this.#budgetSnapshot(),
      cursorResets: this.cursorResets,
      viewerCount: this.viewerCount,
      platformStatus: this.platformStatus,
      counters: {...this.counters},
      ...extra
    };
  }

  #setState(state, extra = {}) {
    this.setState(state, this.#detail(extra));
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
    this.stopReason = 'user';
    this.generation += 1;
    this.connectAttempt = 0;
    this.consecutiveFailures = 0;
    this.cursor = null;
    this.internalExt = null;
    this.cursorFetchedAt = null;
    this.pendingGifts.clear();
    this.seenIds.clear();
    this.lastError = null;
    this.disconnectedAt = null;
    this.lastGap = null;
    this.gaps = [];
    this.reconnectAttempts = 0;
    this.recoveredCount = 0;
    this.cursorResets = 0;
    this.disconnectCursorResets = 0;
    this.needsRoomRecheck = false;
    this.lastPollOkAt = null;
    this.lastEventAt = null;
    this.lastEventType = null;
    this.lastPollAt = null;
    this.nextPollAt = null;
    this.polling = false;
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
      errors: 0,
      rateLimited: 0,
      cursorResets: 0
    };
    this.#setState(CONNECTION_STATE.CONNECTING, {
      category: 'connecting',
      uniqueId: this.uniqueId,
      roomId: this.roomId,
      attempt: 0
    });

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
      this.startTimer = setTimeout(() => {
        if (!this.startResolver) return;
        this.startResolver = null;
        this.started = false;
        try {
          this.pollAbort?.abort();
        } catch {
          /* ignore */
        }
        reject(new TikTokError(TIKTOK_ERRORS.CONNECT_TIMEOUT, {
          messageKey: 'errors.tiktokConnectTimeout',
          httpStatus: 504,
          details: {uniqueId: this.uniqueId, roomId: this.roomId}
        }));
      }, this.options.connectTimeoutMs);
      this.startTimer.unref?.();
      this.#firstPoll(generation).catch((error) => {
        if (!this.startResolver) return;
        const {reject: rejectStart} = this.startResolver;
        this.startResolver = null;
        this.started = false;
        rejectStart(error);
      });
    });

    if (!this.started || generation !== this.generation) return;
    this.#startStatusLoop(generation);
    this.#startWatchdog(generation);
    this.#scheduleStreakFlush(generation);
  }

  #resolveStart() {
    if (!this.startResolver) return;
    const {resolve} = this.startResolver;
    this.startResolver = null;
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    resolve();
  }

  #rejectStart(error) {
    if (!this.startResolver) return;
    const {reject} = this.startResolver;
    this.startResolver = null;
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    reject(error);
  }

  async #firstPoll(generation) {
    this.lastPollAt = this.now();
    try {
      const result = await this.#requestBatch(generation);
      if (generation !== this.generation || !this.started) return;
      this.#onSuccess(result, {first: true});
      this.#resolveStart();
    } catch (error) {
      if (generation !== this.generation || !this.started) {
        this.#rejectStart(error);
        return;
      }
      if (FATAL_CODES.has(error?.code)) {
        this.lastError = this.#failureInfo(error, 'connect');
        this.#setState(CONNECTION_STATE.FAILED, {
          category: error?.code === TIKTOK_ERRORS.SIGNER_PREMIUM_REQUIRED ? 'user_action' : 'failed',
          code: error?.code ?? 'unknown',
          needsUserAction: true,
          messageKey: error?.messageKey ?? null
        });
        this.started = false;
        this.#rejectStart(error);
        return;
      }
      this.#onFailure(error, {phase: 'connect'});
      // A recoverable first failure (network, 429, signer outage) must not
      // destroy the session. The user asked for a recording; we keep it and
      // show a precise state while retrying.
      this.#resolveStart();
    }
  }

  async #requestBatch(generation) {
    this.pollAbort = new AbortController();
    try {
      return await this.signer.connect({
        roomId: this.roomId,
        cursor: this.cursor,
        signal: this.pollAbort.signal
      });
    } finally {
      this.pollAbort = null;
    }
  }

  #nextDelay() {
    const now = this.now();
    const budget = this.#budgetSnapshot();
    const budgetWait = budget?.nextAllowedAt ? Math.max(0, budget.nextAllowedAt - now) : 0;
    const fetchInterval = Number(this.lastFetchInterval) || 0;
    return Math.max(this.options.pollIntervalMs, fetchInterval, budgetWait);
  }

  #scheduleNextPoll(generation, delay) {
    if (!this.started || generation !== this.generation) return;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    const wait = Math.max(0, delay);
    this.nextPollAt = this.now() + wait;
    this.pollTimer = this.#later(wait, () => {
      this.pollTimer = null;
      this.#pollOnce(generation);
    });
  }

  async #pollOnce(generation) {
    if (!this.started || generation !== this.generation) return;
    if (this.polling) return;
    this.polling = true;
    this.lastPollAt = this.now();
    try {
      // A cursor older than the platform's useful window is likely stale. Do
      // not spend a request on it; start a fresh batch and record the gap.
      if (this.cursor && this.cursorFetchedAt && this.now() - this.cursorFetchedAt > this.options.cursorMaxAgeMs) {
        this.#resetCursor('cursor_expired');
      }
      if (this.needsRoomRecheck) {
        const live = await this.#revalidateRoom();
        if (!live || !this.started || generation !== this.generation) return;
      }
      const result = await this.#requestBatch(generation);
      if (!this.started || generation !== this.generation) return;
      this.counters.polls += 1;
      this.#onSuccess(result, {first: false});
    } catch (error) {
      if (!this.started || generation !== this.generation) return;
      if (error?.code === TIKTOK_ERRORS.STOPPED) return;
      if (FATAL_CODES.has(error?.code)) {
        this.#onFatalRuntime(error);
        return;
      }
      this.#onFailure(error, {phase: 'poll'});
    } finally {
      this.polling = false;
    }
  }

  #onSuccess(result, {first = false} = {}) {
    const fetchResult = result.fetchResult;
    this.cursor = fetchResult.cursor ?? this.cursor;
    this.internalExt = fetchResult.internalExt ?? this.internalExt;
    this.cursorFetchedAt = this.now();
    this.needsRoomRecheck = false;
    this.#applyFetchResult(fetchResult);
    if (this.ending || this.state === CONNECTION_STATE.STOPPED) return;
    this.lastPollOkAt = this.now();
    const wasDisconnected = this.disconnectedAt !== null;
    if (wasDisconnected) {
      this.#recordRecovery();
    }
    this.consecutiveFailures = 0;
    if (this.state !== CONNECTION_STATE.CONNECTED) {
      this.#setState(CONNECTION_STATE.CONNECTED, {
        category: 'normal',
        attempt: 0,
        recoveredAt: wasDisconnected ? this.now() : null
      });
    }
    this.#scheduleNextPoll(this.generation, this.#nextDelay());
  }

  #onFailure(error, {phase = 'poll'} = {}) {
    this.counters.errors += 1;
    const info = this.#failureInfo(error, phase);
    this.lastError = info;
    this.reconnectAttempts += 1;
    if (this.disconnectedAt === null) {
      this.disconnectedAt = this.now();
      this.disconnectCursorResets = this.cursorResets;
    }

    if (error?.code === TIKTOK_ERRORS.RATE_LIMITED) {
      this.counters.rateLimited += 1;
      const wait = Math.min(
        this.options.maxRateLimitWaitMs,
        Math.max(1000, Number(error?.retryAfterMs) || this.options.pollIntervalMs)
      );
      const retryAt = this.now() + wait;
      this.#setState(CONNECTION_STATE.RATE_LIMITED, {
        category: 'rate_limit',
        code: error?.code,
        messageKey: error?.messageKey ?? 'errors.tiktokRateLimit',
        retryAfterMs: wait,
        nextRetryAt: retryAt,
        needsUserAction: false,
        rateLimit: error?.details?.rateLimit ?? this.#budgetSnapshot()
      });
      this.logger?.warn({
        event: 'tiktok.capture.rate_limited',
        uniqueId: this.uniqueId,
        roomId: this.roomId,
        retryAfterMs: wait,
        limit: error?.details?.rateLimit?.limit ?? null,
        remaining: error?.details?.rateLimit?.remaining ?? null,
        attempt: this.reconnectAttempts
      });
      this.#scheduleNextPoll(this.generation, wait);
      return;
    }

    if (error?.code === TIKTOK_ERRORS.PROTOCOL) {
      this.#resetCursor('protocol_error');
    }

    const failure = this.consecutiveFailures;
    this.consecutiveFailures += 1;
    const retryAfter = Number(error?.retryAfterMs);
    const base = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter, this.options.maxBackoffMs)
      : backoffDelay(failure, this.options.maxBackoffMs);
    const wait = base + jitterMs(base, this.random);

    if (this.consecutiveFailures >= this.options.maxConsecutiveFailures) {
      const retryAt = this.now() + this.options.slowRecoveryMs;
      this.#setState(CONNECTION_STATE.FAILED, {
        category: 'failed',
        code: error?.code ?? 'unknown',
        messageKey: error?.messageKey ?? null,
        attempts: this.consecutiveFailures,
        retrying: true,
        recoverable: true,
        retryAfterMs: this.options.slowRecoveryMs,
        nextRetryAt: retryAt
      });
      this.logger?.warn({
        event: 'tiktok.capture.slow_recovery',
        uniqueId: this.uniqueId,
        roomId: this.roomId,
        code: error?.code ?? 'unknown',
        attempts: this.consecutiveFailures
      });
      this.#scheduleNextPoll(this.generation, this.options.slowRecoveryMs);
      return;
    }

    const retryAt = this.now() + wait;
    this.#setState(CONNECTION_STATE.RECONNECTING, {
      category: this.consecutiveFailures <= 1 ? 'temporary' : 'auto_reconnect',
      code: error?.code ?? 'unknown',
      messageKey: error?.messageKey ?? null,
      attempt: this.consecutiveFailures,
      retryAfterMs: wait,
      nextRetryAt: retryAt
    });
    this.logger?.warn({
      event: 'tiktok.capture.interrupted',
      uniqueId: this.uniqueId,
      roomId: this.roomId,
      code: error?.code ?? 'unknown',
      phase,
      attempt: this.consecutiveFailures,
      retryAfterMs: wait
    });
    this.#scheduleNextPoll(this.generation, wait);
  }

  #onFatalRuntime(error) {
    const needsUserAction = [TIKTOK_ERRORS.SIGNER_PREMIUM_REQUIRED, TIKTOK_ERRORS.LOGIN_REQUIRED].includes(error?.code);
    this.lastError = this.#failureInfo(error, 'poll');
    this.#setState(CONNECTION_STATE.FAILED, {
      category: needsUserAction ? 'user_action' : 'failed',
      code: error?.code ?? 'unknown',
      messageKey: error?.messageKey ?? null,
      needsUserAction,
      recoverable: false,
      retrying: false,
      nextRetryAt: null
    });
    this.logger?.warn({
      event: 'tiktok.capture.needs_action',
      uniqueId: this.uniqueId,
      roomId: this.roomId,
      code: error?.code ?? 'unknown'
    });
  }

  #failureInfo(error, phase) {
    return {
      code: error?.code ?? 'unknown',
      messageKey: error?.messageKey ?? null,
      at: this.now(),
      phase,
      reason: error?.details?.reason ?? null,
      retryAfterMs: Number.isFinite(Number(error?.retryAfterMs)) ? Number(error.retryAfterMs) : null,
      needsUserAction: [TIKTOK_ERRORS.SIGNER_PREMIUM_REQUIRED, TIKTOK_ERRORS.LOGIN_REQUIRED].includes(error?.code)
    };
  }

  #resetCursor(reason) {
    if (!this.cursor) return;
    this.cursor = null;
    this.internalExt = null;
    this.cursorFetchedAt = null;
    this.cursorResets += 1;
    this.counters.cursorResets += 1;
    this.needsRoomRecheck = true;
    this.logger?.info({event: 'tiktok.capture.cursor_reset', uniqueId: this.uniqueId, roomId: this.roomId, reason});
  }

  async #revalidateRoom() {
    if (!this.client?.fetchRoomInfo) {
      this.needsRoomRecheck = false;
      return true;
    }
    try {
      const info = await this.client.fetchRoomInfo(this.roomId);
      if (!this.started) return false;
      const resolvedId = info?.roomId ? String(info.roomId) : this.roomId;
      if (resolvedId !== String(this.roomId) || info?.isLive === false) {
        this.#observeOffline({reason: resolvedId !== String(this.roomId) ? 'room_changed' : 'room_offline'});
        return false;
      }
      this.needsRoomRecheck = false;
      return true;
    } catch (error) {
      // A failed public metadata read is not proof that the room ended; keep
      // polling the signed transport rather than ending the session.
      this.logger?.warn({event: 'tiktok.capture.recheck.failed', code: error?.code ?? 'unknown'});
      this.needsRoomRecheck = false;
      return true;
    }
  }

  #recordRecovery() {
    const endedAt = this.now();
    const startedAt = this.disconnectedAt;
    const durationMs = Math.max(0, endedAt - startedAt);
    const gap = {
      startedAt,
      endedAt,
      durationMs,
      lastEventAt: this.lastEventAt,
      cursorReset: this.cursorResets > this.disconnectCursorResets,
      possibleMissed: true,
      note: 'upstream_history_not_backfilled'
    };
    this.lastGap = gap;
    this.gaps.push(gap);
    if (this.gaps.length > 20) this.gaps.shift();
    this.disconnectedAt = null;
    this.recoveredCount += 1;
    this.logger?.info({
      event: 'tiktok.capture.recovered',
      uniqueId: this.uniqueId,
      roomId: this.roomId,
      disconnectedAt: startedAt,
      recoveredAt: endedAt,
      gapMs: durationMs,
      lastEventAt: gap.lastEventAt,
      possibleGap: true,
      note: gap.note
    });
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

  #markEvent(event) {
    this.lastEventAt = this.now();
    this.lastEventType = event?.event_type ?? null;
  }

  #emitGift(entry) {
    if (!entry?.event) return;
    this.counters.gifts += 1;
    const event = {...entry.event, occurred_at: entry.event.occurred_at ?? this.now()};
    this.#markEvent(event);
    try {
      this.onEvent(event);
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
      this.#markEvent(event);
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
    this.#later(this.options.statusCheckDelayMs, run);
  }

  async #checkPlatformStatus() {
    const observedAt = this.now();
    this.lastStatusAt = observedAt;
    try {
      const room = await this.client.resolveRoom(this.uniqueId);
      if (!this.started) return;
      const resolvedRoomId = room?.roomId ? String(room.roomId) : null;
      if (resolvedRoomId && this.roomId && resolvedRoomId !== String(this.roomId)) {
        // The handle now points at a different broadcast. The old room is gone;
        // keep the same session but require a second observation before ending.
        this.logger?.info({
          event: 'tiktok.capture.room_changed',
          sessionRoomId: this.roomId,
          observedRoomId: resolvedRoomId,
          uniqueId: this.uniqueId
        });
        this.#observeOffline({reason: 'room_changed', at: observedAt});
        return;
      }
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
      this.stopReason = 'platform_ended';
      this.#setState(CONNECTION_STATE.STOPPED, {
        category: 'ended',
        reason: 'platform_ended',
        platformEndedAt: at
      });
      try {
        this.onEnd({reason: 'platform_ended', quality: 'verified', observedAt: at});
      } catch (error) {
        this.logger?.warn({event: 'tiktok.end.callback.failed', code: error?.code ?? 'unknown'});
      }
      // The session manager ends the row with `adapterAlreadyEnded` and does
      // not call stop() again; stop our own timers so a confirmed offline room
      // cannot keep spending requests in the background.
      this.started = false;
      this.#clearTimers();
    }
  }

  #startWatchdog(generation) {
    const run = () => {
      if (!this.started || generation !== this.generation) return;
      const now = this.now();
      const due = Number.isFinite(this.nextPollAt) ? this.nextPollAt : (this.lastPollOkAt ?? now);
      if (
        this.state === CONNECTION_STATE.CONNECTED
        && !this.polling
        && !this.pollTimer
        && now - due > this.options.watchdogMs
      ) {
        this.#setState(CONNECTION_STATE.RECONNECTING, {
          category: 'temporary',
          code: 'watchdog',
          attempt: this.consecutiveFailures
        });
        this.#scheduleNextPoll(generation, 0);
      }
      this.#later(this.options.watchdogCheckMs, run);
    };
    this.#later(this.options.watchdogCheckMs, run);
  }

  capture() {
    return this.#detail();
  }

  async stop() {
    this.started = false;
    this.ending = true;
    this.stopReason = 'user';
    this.generation += 1;
    this.#clearTimers();
    try {
      this.pollAbort?.abort();
    } catch {
      /* ignore */
    }
    if (this.startResolver) {
      this.#rejectStart(new TikTokError(TIKTOK_ERRORS.STOPPED, {
        messageKey: 'errors.tiktokStopped',
        httpStatus: 409
      }));
    }
    // Emit any pending streak as its last known state so a shutdown does not
    // silently drop a gift that already arrived.
    for (const entry of this.pendingGifts.values()) this.#emitGift(entry);
    this.pendingGifts.clear();
    this.#setState(CONNECTION_STATE.STOPPED, {
      category: 'stopped',
      reason: 'user',
      nextRetryAt: null
    });
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
      lastEventAt: this.lastEventAt,
      lastError: this.lastError,
      capture: this.capture(),
      gaps: [...this.gaps]
    };
  }
}

export const __internal = {backoffDelay, DEFAULT_OPTIONS, TIKTOK_METHODS, FATAL_CODES};
