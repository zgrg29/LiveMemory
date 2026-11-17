import {CONNECTION_STATE, PlatformAdapter} from '../shared/adapter.mjs';
import {KUAISHOU_ERRORS, KuaishouError, backoffDelay} from './errors.mjs';
import {KuaishouFeedClient} from './transport.mjs';
import {
  KUAISHOU_IDENTITY,
  feedFingerprint,
  feedTypeOf,
  isCommentFeed,
  mapKuaishouComment
} from './messages.mjs';
import {detectKuaishouStatus, ROOM_STATUS} from './status.mjs';
import {assertCollectionAllowed} from './policy.mjs';

/**
 * Kuaishou anonymous-H5 chat adapter.
 *
 * One instance = one Kuaishou room = one session. It owns the polling loop,
 * cursor, duplicate guard, retry/backoff, status checks and stop semantics. It
 * never writes to the database: canonical drafts go to the injected `onEvent`
 * and EventIngest remains the only write path.
 *
 * Boundaries that are enforced here, not just documented:
 *   - no collection without an authorised access object;
 *   - only `comment` feeds become chat events (gifts/likes are NOT-OBSERVED and
 *     are never advertised as supported);
 *   - viewer identity is session-provisional, so two sessions never merge an
 *     unproven platform id;
 *   - the feed has no message id and no replay cursor: a duplicate is removed by
 *     fingerprint, and a reconnect can miss messages;
 *   - a rate limit or an unknown status never ends a broadcast; only feed result
 *     601/671 or two consecutive room-page `offline` observations do.
 */

const DEFAULT_OPTIONS = Object.freeze({
  pollIntervalMs: 3200,
  statusIntervalMs: 60000,
  statusOfflineConfirmations: 2,
  maxBackoffMs: 60000,
  maxConsecutiveFailures: 8,
  timeoutMs: 20000,
  dedupeLimit: 20000,
  userAgent: undefined
});

export class KuaishouAdapter extends PlatformAdapter {
  constructor({
    eid,
    liveStreamId,
    sessionId,
    access = null,
    fetchImpl = globalThis.fetch,
    logger = null,
    now = Date.now,
    random = Math.random,
    options = {}
  } = {}) {
    super({
      id: 'kuaishou',
      platform: 'kuaishou',
      label: 'Kuaishou',
      // Chat only. Gift/like support is NOT claimed.
      capabilities: ['chat']
    });
    this.eid = String(eid ?? '').trim();
    this.liveStreamId = String(liveStreamId ?? '').trim();
    this.sessionId = String(sessionId ?? '').trim();
    this.access = access;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.now = now;
    this.random = random;
    this.options = {...DEFAULT_OPTIONS, ...options};

    this.client = null;
    this.cursor = '';
    this.started = false;
    this.stopping = false;
    this.stopReason = null;
    this.generation = 0;
    this.polling = false;
    this.statusChecking = false;
    this.consecutiveFailures = 0;
    this.reconnects = 0;
    this.connectedAt = null;
    this.disconnectedAt = null;
    this.lastEventAt = null;
    this.lastPollAt = null;
    this.nextPollAt = null;
    this.lastResult = null;
    this.lastStatus = null;
    this.lastError = null;
    this.statusOfflineObservations = 0;
    this.endedEmitted = false;
    this.timers = new Set();
    this.seen = new Set();
    this.onEvent = () => {};
    this.onEnd = () => {};
    this.counters = this.#emptyCounters();
  }

  #emptyCounters() {
    return {
      polls: 0,
      chats: 0,
      duplicates: 0,
      emptyPolls: 0,
      ignored: 0,
      skipped: 0,
      rateLimited: 0,
      errors: 0,
      statusChecks: 0,
      statusOffline: 0,
      withStableId: 0,
      withTimestamp: 0,
      assumedTimestamp: 0,
      missingNickname: 0,
      ignoredTypes: {}
    };
  }

  #later(ms, fn) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      try {
        fn();
      } catch (error) {
        this.logger?.warn({event: 'kuaishou.timer.failed', code: error?.code ?? 'unknown'});
      }
    }, Math.max(0, Number(ms) || 0));
    timer.unref?.();
    this.timers.add(timer);
    return timer;
  }

  #clearTimers() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  #emitEnd(info) {
    if (this.endedEmitted) return;
    this.endedEmitted = true;
    try {
      this.onEnd?.(info);
    } catch (error) {
      this.logger?.warn({event: 'kuaishou.onend.failed', code: error?.code ?? 'unknown'});
    }
  }

  #remember(fingerprint) {
    if (this.seen.has(fingerprint)) return false;
    this.seen.add(fingerprint);
    if (this.seen.size > this.options.dedupeLimit) this.seen.clear();
    return true;
  }

  #handleFeed(feed, receivedAt) {
    const type = feedTypeOf(feed);
    if (!isCommentFeed(feed)) {
      // Gift/like/enter feeds are not mapped. Counting them keeps the omission
      // observable without pretending the platform supports them.
      this.counters.ignored += 1;
      this.counters.ignoredTypes[type] = (this.counters.ignoredTypes[type] ?? 0) + 1;
      return;
    }
    if (!this.#remember(feedFingerprint(feed))) {
      this.counters.duplicates += 1;
      return;
    }
    const mapped = mapKuaishouComment(feed, {
      sessionId: this.sessionId,
      eid: this.eid,
      liveStreamId: this.liveStreamId,
      receivedAt,
      now: receivedAt
    });
    if (!mapped.draft) {
      this.counters.skipped += 1;
      return;
    }
    this.counters.chats += 1;
    if (mapped.rawUid) this.counters.withStableId += 1;
    if (mapped.timestampSource === 'feed-time') this.counters.withTimestamp += 1;
    else this.counters.assumedTimestamp += 1;
    if (!mapped.draft.display_name) this.counters.missingNickname += 1;
    this.lastEventAt = receivedAt;
    try {
      this.onEvent(mapped.draft);
    } catch (error) {
      this.logger?.warn({event: 'kuaishou.event.handler_failed', code: error?.code ?? 'unknown'});
    }
  }

  async #pollOnce() {
    if (this.polling) return null;
    this.polling = true;
    try {
      const batch = await this.client.poll(this.cursor);
      const receivedAt = this.now();
      this.counters.polls += 1;
      this.lastPollAt = receivedAt;
      this.lastResult = batch.result;
      if (batch.cursor) this.cursor = batch.cursor;
      if (batch.feeds.length === 0) this.counters.emptyPolls += 1;
      for (const feed of batch.feeds) this.#handleFeed(feed, receivedAt);
      this.consecutiveFailures = 0;
      this.lastError = null;
      return batch;
    } finally {
      this.polling = false;
    }
  }

  #schedule(delayMs) {
    if (this.stopping || !this.started) return;
    this.nextPollAt = this.now() + Math.max(0, Number(delayMs) || 0);
    const generation = this.generation;
    this.#later(delayMs, () => {
      if (this.stopping || !this.started || generation !== this.generation) return;
      this.#tick().catch((error) => {
        this.logger?.warn({event: 'kuaishou.poll.failed', code: error?.code ?? 'unknown'});
      });
    });
  }

  async #tick() {
    if (this.stopping || !this.started) return;
    try {
      await this.#pollOnce();
      if (this.stopping) return;
      this.nextPollAt = null;
      if (this.state === CONNECTION_STATE.RECONNECTING || this.state === CONNECTION_STATE.RATE_LIMITED) {
        this.reconnects += 1;
        this.setState(CONNECTION_STATE.CONNECTED, {reason: 'recovered', recovered: true});
      }
      this.#schedule(this.options.pollIntervalMs);
    } catch (error) {
      await this.#handlePollFailure(error);
    }
  }

  async #handlePollFailure(error) {
    if (this.stopping) return;
    this.lastError = error;
    this.counters.errors += 1;
    const code = error?.code ?? KUAISHOU_ERRORS.NETWORK;

    if (code === KUAISHOU_ERRORS.ROOM_OFFLINE) {
      await this.stop({reason: 'platform_ended'});
      this.#emitEnd({reason: 'platform_ended', code});
      return;
    }
    if (
      code === KUAISHOU_ERRORS.ACCESS_DENIED
      || code === KUAISHOU_ERRORS.RISK_CONTROL
      || code === KUAISHOU_ERRORS.ROOM_NOT_FOUND
      || code === KUAISHOU_ERRORS.AUTHORIZATION_REQUIRED
    ) {
      this.disconnectedAt = this.now();
      this.setState(CONNECTION_STATE.FAILED, {reason: 'platform_refused', code});
      await this.stop({reason: 'failed'});
      this.#emitEnd({reason: 'failed', code});
      return;
    }

    this.consecutiveFailures += 1;
    const rateLimited = code === KUAISHOU_ERRORS.RATE_LIMITED;
    if (rateLimited) this.counters.rateLimited += 1;
    if (this.consecutiveFailures >= this.options.maxConsecutiveFailures) {
      this.disconnectedAt = this.now();
      this.setState(CONNECTION_STATE.FAILED, {
        reason: 'max_failures',
        code,
        failures: this.consecutiveFailures
      });
      await this.stop({reason: 'failed'});
      this.#emitEnd({reason: 'failed', code});
      return;
    }
    this.disconnectedAt = this.disconnectedAt ?? this.now();
    const delay = backoffDelay(this.consecutiveFailures - 1, {
      baseMs: this.options.pollIntervalMs,
      maxMs: this.options.maxBackoffMs,
      random: this.random
    });
    this.setState(rateLimited ? CONNECTION_STATE.RATE_LIMITED : CONNECTION_STATE.RECONNECTING, {
      reason: rateLimited ? 'rate_limited' : 'network',
      code,
      attempt: this.consecutiveFailures,
      retryInMs: delay
    });
    this.#schedule(delay);
  }

  #armStatusCheck() {
    if (this.stopping || !this.started) return;
    const interval = Math.max(1000, Number(this.options.statusIntervalMs) || 60000);
    const generation = this.generation;
    this.#later(interval, () => {
      if (this.stopping || !this.started || generation !== this.generation) return;
      this.#checkStatus()
        .catch((error) => this.logger?.warn({event: 'kuaishou.status.failed', code: error?.code ?? 'unknown'}))
        .finally(() => this.#armStatusCheck());
    });
  }

  async #checkStatus() {
    if (this.statusChecking || this.stopping || !this.started) return;
    this.statusChecking = true;
    try {
      const status = await detectKuaishouStatus(this.eid, {
        fetchImpl: this.fetchImpl,
        timeoutMs: this.options.timeoutMs,
        now: this.now,
        ...(this.options.userAgent ? {userAgent: this.options.userAgent} : {})
      });
      this.counters.statusChecks += 1;
      this.lastStatus = status;
      if (status.state === ROOM_STATUS.LIVE) {
        this.statusOfflineObservations = 0;
        if (status.liveStreamId && this.liveStreamId && status.liveStreamId !== this.liveStreamId) {
          // A new broadcast id means the previous cycle is over. Never keep one
          // session across two broadcasts.
          await this.stop({reason: 'platform_restarted'});
          this.#emitEnd({reason: 'platform_restarted'});
        }
        return;
      }
      if (status.state === ROOM_STATUS.OFFLINE) {
        this.statusOfflineObservations += 1;
        this.counters.statusOffline += 1;
        if (this.statusOfflineObservations >= this.options.statusOfflineConfirmations) {
          await this.stop({reason: 'platform_ended'});
          this.#emitEnd({reason: 'platform_ended'});
        }
        return;
      }
      // rate_limited / unknown / not_found: an inconclusive page NEVER ends a
      // broadcast. The feed's own 601 remains the definitive end signal.
    } finally {
      this.statusChecking = false;
    }
  }

  async start({onEvent = null, onStateChange = null, onEnd = null} = {}) {
    if (this.started) {
      throw new KuaishouError(KUAISHOU_ERRORS.PROTOCOL, {
        httpStatus: 409,
        details: {reason: 'already_started'},
        retryable: false
      });
    }
    assertCollectionAllowed(this.access);
    if (!this.eid || !this.liveStreamId || !this.sessionId) {
      throw new KuaishouError(KUAISHOU_ERRORS.NOT_CONFIGURED, {
        httpStatus: 503,
        details: {reason: 'adapter_context_missing'},
        retryable: false
      });
    }
    if (onEvent) this.onEvent = onEvent;
    if (onEnd) this.onEnd = onEnd;
    if (onStateChange) this.onStateChange = onStateChange;
    this.started = true;
    this.stopping = false;
    this.endedEmitted = false;
    this.setState(CONNECTION_STATE.CONNECTING, {reason: 'opening_feed'});
    this.client = new KuaishouFeedClient({
      eid: this.eid,
      liveStreamId: this.liveStreamId,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.options.timeoutMs,
      ...(this.options.userAgent ? {userAgent: this.options.userAgent} : {})
    });
    try {
      // Do not report success merely because the adapter object exists: the
      // first incremental batch must actually be readable.
      await this.#pollOnce();
      if (this.stopping) {
        throw new KuaishouError(KUAISHOU_ERRORS.STOPPED, {httpStatus: 409, retryable: false});
      }
      this.connectedAt = this.now();
      this.disconnectedAt = null;
      this.setState(CONNECTION_STATE.CONNECTED, {
        reason: 'feed_readable',
        eid: this.eid,
        liveStreamId: this.liveStreamId
      });
      this.#schedule(this.options.pollIntervalMs);
      this.#armStatusCheck();
      return this;
    } catch (error) {
      this.lastError = error;
      this.started = false;
      this.disconnectedAt = this.now();
      this.setState(CONNECTION_STATE.FAILED, {reason: 'start_failed', code: error?.code ?? 'unknown'});
      throw error;
    }
  }

  async stop({reason = 'user'} = {}) {
    this.stopping = true;
    this.started = false;
    this.stopReason = reason;
    this.generation += 1;
    this.#clearTimers();
    this.nextPollAt = null;
    this.disconnectedAt = this.disconnectedAt ?? this.now();
    // A failure keeps its FAILED state so the UI can say "failed" instead of
    // presenting every terminal condition as a user stop.
    if (this.state !== CONNECTION_STATE.FAILED) {
      this.setState(CONNECTION_STATE.STOPPED, {reason});
    }
    return this.snapshot();
  }

  snapshot() {
    return {
      ...super.snapshot(),
      eid: this.eid,
      liveStreamId: this.liveStreamId,
      cursor: this.cursor,
      connectedAt: this.connectedAt,
      disconnectedAt: this.disconnectedAt,
      lastEventAt: this.lastEventAt,
      lastPollAt: this.lastPollAt,
      nextPollAt: this.nextPollAt,
      lastResult: this.lastResult,
      lastStatus: this.lastStatus ? {...this.lastStatus} : null,
      consecutiveFailures: this.consecutiveFailures,
      reconnects: this.reconnects,
      lastError: this.lastError
        ? {code: this.lastError.code ?? null, message: this.lastError.message ?? null}
        : null,
      identity: {
        mode: KUAISHOU_IDENTITY.MODE,
        stableUserId: KUAISHOU_IDENTITY.STABLE_USER_ID,
        messageId: KUAISHOU_IDENTITY.MESSAGE_ID,
        scope: 'session'
      },
      counters: {...this.counters, ignoredTypes: {...this.counters.ignoredTypes}}
    };
  }

  /** UI-facing capture summary; categories mirror the other platform cards. */
  capture() {
    const snapshot = this.snapshot();
    const counters = snapshot.counters;
    const events = counters.chats;
    let category = 'idle';
    if (snapshot.state === CONNECTION_STATE.CONNECTED) {
      category = events > 0 ? 'normal' : 'waiting_events';
    } else if (snapshot.state === CONNECTION_STATE.CONNECTING) {
      category = 'connecting';
    } else if (snapshot.state === CONNECTION_STATE.RECONNECTING) {
      category = this.consecutiveFailures <= 1 ? 'temporary' : 'auto_reconnect';
    } else if (snapshot.state === CONNECTION_STATE.RATE_LIMITED) {
      category = 'rate_limit';
    } else if (snapshot.state === CONNECTION_STATE.FAILED) {
      category = 'failed';
    } else if (snapshot.state === CONNECTION_STATE.STOPPED) {
      category = this.stopReason === 'platform_ended' || this.stopReason === 'platform_restarted'
        ? 'ended'
        : 'stopped';
    }
    return {
      transport: 'kuaishou-h5-feed',
      protocol: 'kuaishou-h5',
      connection: snapshot.state,
      category,
      captureState: category,
      messages: events,
      eventsReceived: events,
      eventsVerified: events > 0,
      chats: counters.chats,
      duplicates: counters.duplicates,
      polls: counters.polls,
      ignored: counters.ignored,
      lastResult: snapshot.lastResult,
      lastEventAt: snapshot.lastEventAt,
      lastPollAt: snapshot.lastPollAt,
      nextPollAt: snapshot.nextPollAt,
      connectedAt: snapshot.connectedAt,
      disconnectedAt: snapshot.disconnectedAt,
      reconnects: snapshot.reconnects,
      lastFailure: snapshot.lastError,
      lastStatus: snapshot.lastStatus,
      possibleGap: snapshot.reconnects > 0,
      identity: snapshot.identity,
      counters,
      checkedAt: this.now()
    };
  }
}

export const __internal = {DEFAULT_OPTIONS};
