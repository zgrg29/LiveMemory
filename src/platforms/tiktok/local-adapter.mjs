import {PlatformAdapter, CONNECTION_STATE} from '../shared/adapter.mjs';
import {TIKTOK_ERRORS, TikTokError} from './errors.mjs';
import {mapTikTokMessage} from './messages.mjs';
import {TtwidProvider, WebcastSocket, SOCKET_DEFAULTS} from './webcast.mjs';

/**
 * TikTok LIVE adapter over the anonymous local WebSocket transport.
 *
 * Transport only: it owns the socket lifetime, heartbeat/ack frames, streak
 * aggregation, reconnect policy and platform-state observation. Persistence,
 * dedupe and viewer aggregation stay in EventIngest, exactly like every other
 * platform.
 *
 * What this adapter refuses to conflate:
 *   - a WebSocket frame is not a chat or a gift (frames/control/batches are
 *     counted separately, and only decoded messages become events);
 *   - a TCP connection is not a confirmed capture (the UI needs real events);
 *   - a dropped socket is not a platform refusal (it reconnects with backoff);
 *   - a closed room is only reported after two independent observations.
 *
 * No login, no cookie jar beyond the anonymous `ttwid` device cookie, no paid
 * signing service and no browser. This is TikTok's private web protocol, not an
 * official API.
 */

const DEFAULT_OPTIONS = Object.freeze({
  heartbeatIntervalMs: SOCKET_DEFAULTS.heartbeatIntervalMs,
  idleTimeoutMs: SOCKET_DEFAULTS.idleTimeoutMs,
  connectTimeoutMs: 20000,
  startTimeoutMs: 45000,
  statusIntervalMs: 60000,
  statusCheckDelayMs: 5000,
  statusTimeoutMs: 15000,
  maxBackoffMs: 30000,
  maxConsecutiveFailures: 12,
  slowRecoveryMs: 300000,
  minRateLimitWaitMs: 15000,
  streakFlushMs: 10000,
  maxSeenMessageIds: 10000
});

const FATAL_CODES = new Set([
  TIKTOK_ERRORS.NOT_CONFIGURED,
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

export class TikTokLocalAdapter extends PlatformAdapter {
  constructor({
    uniqueId,
    roomId,
    client = null,
    ttwidProvider = null,
    logger = null,
    now = Date.now,
    random = Math.random,
    WebSocketImpl = globalThis.WebSocket,
    fetchImpl = globalThis.fetch,
    ...options
  } = {}) {
    super({
      id: 'tiktok',
      platform: 'tiktok',
      label: 'TikTok Live',
      capabilities: ['chat', 'gift', 'gift_streak', 'membership', 'viewer_count']
    });
    this.uniqueId = String(uniqueId ?? '').replace(/^@/, '');
    this.roomId = roomId === null || roomId === undefined ? null : String(roomId);
    this.client = client;
    this.logger = logger;
    this.now = now;
    this.random = random;
    this.WebSocketImpl = WebSocketImpl;
    this.fetchImpl = fetchImpl;
    this.options = {...DEFAULT_OPTIONS, ...options};
    this.transport = 'local';
    this.ttwidProvider = ttwidProvider ?? new TtwidProvider({fetchImpl, now, logger});
    this.ownsTtwidProvider = !ttwidProvider;

    this.started = false;
    this.ending = false;
    this.generation = 0;
    this.refreshTtwid = false;
    this.socket = null;
    this.wsHost = null;
    this.connectedAt = null;
    this.disconnectedAt = null;
    this.lastFrameAt = null;
    this.lastEventAt = null;
    this.lastEventType = null;
    this.lastError = null;
    this.lastGap = null;
    this.gaps = [];
    this.reconnectAttempts = 0;
    this.recoveredCount = 0;
    this.consecutiveFailures = 0;
    this.nextRetryAt = null;
    this.retryTimer = null;
    this.statusTimer = null;
    this.streakTimer = null;
    this.offlineObservations = 0;
    this.viewerCount = null;
    this.platformStatus = null;
    this.lastStatusAt = null;
    this.lastRoomLookupAt = null;
    this.stopReason = 'user';
    this.pendingGifts = new Map();
    this.seenIds = new Set();
    this.giftCatalog = null;
    this.startResolver = null;
    this.startTimer = null;
    this.counters = this.#emptyCounters();
    this.onEvent = () => {};
    this.onEnd = () => {};
    this.onPlatformStatus = () => {};
  }

  #emptyCounters() {
    return {
      connections: 0,
      frames: 0,
      batchFrames: 0,
      controlFrames: 0,
      textFrames: 0,
      decodeErrors: 0,
      messages: 0,
      chats: 0,
      gifts: 0,
      giftUpdates: 0,
      memberships: 0,
      ignored: 0,
      historySkipped: 0,
      duplicates: 0,
      heartbeats: 0,
      acks: 0,
      ttwidFetches: 0,
      roomLookups: 0,
      errors: 0
    };
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

  get timers() {
    if (!this.timerSet) this.timerSet = new Set();
    return this.timerSet;
  }

  #clearTimers() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.retryTimer = null;
  }

  #category() {
    if (this.state === CONNECTION_STATE.CONNECTED) {
      return this.counters.chats + this.counters.gifts + this.counters.memberships > 0
        ? 'normal'
        : 'waiting_events';
    }
    if (this.state === CONNECTION_STATE.RATE_LIMITED) return 'rate_limit';
    if (this.state === CONNECTION_STATE.RECONNECTING) {
      return this.consecutiveFailures <= 1 ? 'temporary' : 'auto_reconnect';
    }
    if (this.state === CONNECTION_STATE.FAILED) {
      return this.lastError?.needsUserAction ? 'user_action' : 'failed';
    }
    if (this.state === CONNECTION_STATE.STOPPED) {
      return this.stopReason === 'platform_ended' ? 'ended' : 'stopped';
    }
    if (this.state === CONNECTION_STATE.CONNECTING) return 'connecting';
    return 'idle';
  }

  #eventsVerified() {
    return this.counters.chats + this.counters.gifts + this.counters.memberships > 0;
  }

  #detail(extra = {}) {
    const now = this.now();
    return {
      uniqueId: this.uniqueId,
      roomId: this.roomId,
      transport: this.transport,
      protocol: 'webcast-ws',
      state: this.state,
      category: extra.category ?? this.#category(),
      attempt: this.consecutiveFailures,
      reconnectAttempts: this.reconnectAttempts,
      recoveries: this.recoveredCount,
      connectedAt: this.connectedAt,
      disconnectedAt: this.disconnectedAt,
      wsHost: this.wsHost,
      lastFrameAt: this.lastFrameAt,
      lastEventAt: this.lastEventAt,
      lastEventType: this.lastEventType,
      eventsVerified: this.#eventsVerified(),
      framesReceived: this.counters.frames,
      gap: this.lastGap,
      possibleGap: Boolean(this.lastGap?.possibleMissed),
      lastFailure: this.lastError,
      nextRetryAt: Object.hasOwn(extra, 'nextRetryAt') ? extra.nextRetryAt : this.nextRetryAt,
      viewerCount: this.viewerCount,
      platformStatus: this.platformStatus,
      ttwid: this.ttwidProvider?.snapshot?.() ?? null,
      counters: {...this.counters},
      pendingStreaks: this.pendingGifts.size,
      ...extra
    };
  }

  #setState(state, extra = {}) {
    this.setState(state, this.#detail(extra));
  }

  async start({onEvent = () => {}, onStateChange = null, onEnd = null, onPlatformStatus = null} = {}) {
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
    this.refreshTtwid = false;
    this.generation += 1;
    this.consecutiveFailures = 0;
    this.reconnectAttempts = 0;
    this.recoveredCount = 0;
    this.pendingGifts.clear();
    this.seenIds.clear();
    this.lastError = null;
    this.lastGap = null;
    this.gaps = [];
    this.disconnectedAt = null;
    this.lastEventAt = null;
    this.lastEventType = null;
    this.lastFrameAt = null;
    this.nextRetryAt = null;
    this.counters = this.#emptyCounters();
    this.#setState(CONNECTION_STATE.CONNECTING, {category: 'connecting', attempt: 0, nextRetryAt: null});

    // The gift catalog is optional metadata for display values only; a failure
    // must not block capture.
    if (this.client?.fetchGiftCatalog) {
      try {
        this.giftCatalog = await this.client.fetchGiftCatalog(this.roomId);
      } catch {
        this.giftCatalog = null;
      }
    }

    const generation = this.generation;

    await new Promise((resolve, reject) => {
      this.startResolver = {resolve, reject};
      this.startTimer = setTimeout(() => {
        if (!this.startResolver) return;
        this.startResolver = null;
        reject(new TikTokError(TIKTOK_ERRORS.CONNECT_TIMEOUT, {
          messageKey: 'errors.tiktokConnectTimeout',
          httpStatus: 504,
          details: {uniqueId: this.uniqueId, roomId: this.roomId}
        }));
      }, this.options.startTimeoutMs);
      this.startTimer.unref?.();
      this.#connectOnce(generation).catch((error) => this.#rejectStart(error));
    }).catch((error) => {
      this.started = false;
      this.socket?.close({code: 1000, reason: 'start_failed'});
      throw error;
    });

    if (!this.started || generation !== this.generation) return;
    this.#startStatusLoop(generation);
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

  async #connectOnce(generation) {
    if (!this.started || generation !== this.generation) return;
    this.#setState(
      this.state === CONNECTION_STATE.RECONNECTING ? CONNECTION_STATE.RECONNECTING : CONNECTION_STATE.CONNECTING,
      {category: this.state === CONNECTION_STATE.RECONNECTING ? 'auto_reconnect' : 'connecting', attempt: this.consecutiveFailures}
    );
    let ttwid;
    try {
      // A cached anonymous cookie is normally still valid; refresh it only
      // after a socket-open failure, because a burst of page requests is what
      // TikTok throttles.
      ttwid = await this.ttwidProvider.get({refresh: this.refreshTtwid === true});
      this.refreshTtwid = false;
      this.counters.ttwidFetches = this.ttwidProvider.snapshot().fetchCount;
    } catch (error) {
      this.#onConnectFailure(error, generation);
      return;
    }
    if (!this.started || generation !== this.generation) return;

    const socket = new WebcastSocket({
      roomId: this.roomId,
      heartbeatIntervalMs: this.options.heartbeatIntervalMs,
      idleTimeoutMs: this.options.idleTimeoutMs,
      connectTimeoutMs: this.options.connectTimeoutMs,
      WebSocketImpl: this.WebSocketImpl,
      now: this.now,
      logger: this.logger,
      onFrame: (frame) => this.#onFrame(frame, generation),
      onClose: (info) => this.#onSocketClose(info, generation),
      onError: (error) => this.logger?.warn({
        event: 'tiktok.ws.error',
        uniqueId: this.uniqueId,
        roomId: this.roomId,
        reason: error?.details?.reason ?? error?.code ?? 'unknown'
      })
    });
    this.socket = socket;
    try {
      await socket.connect({ttwid});
    } catch (error) {
      if (this.socket === socket) this.socket = null;
      this.#onConnectFailure(error, generation);
      return;
    }
    if (!this.started || generation !== this.generation) {
      socket.close({code: 1000, reason: 'stopped'});
      return;
    }
    this.wsHost = socket.host;
    this.connectedAt = this.now();
    this.counters.connections += 1;
    this.consecutiveFailures = 0;
    this.nextRetryAt = null;
    const wasDisconnected = this.disconnectedAt !== null;
    if (wasDisconnected) this.#recordRecovery();
    this.#setState(CONNECTION_STATE.CONNECTED, {
      category: 'waiting_events',
      attempt: 0,
      nextRetryAt: null,
      wsHost: socket.host,
      connectedAt: this.connectedAt
    });
    this.logger?.info({
      event: 'tiktok.ws.connected',
      uniqueId: this.uniqueId,
      roomId: this.roomId,
      host: socket.host,
      reconnected: wasDisconnected
    });
    this.#resolveStart();
  }

  #onConnectFailure(error, generation) {
    if (!this.started || generation !== this.generation) return;
    this.counters.errors += 1;
    const info = {
      code: error?.code ?? 'unknown',
      messageKey: error?.messageKey ?? null,
      at: this.now(),
      phase: this.connectedAt ? 'reconnect' : 'connect',
      reason: error?.details?.reason ?? null,
      needsUserAction: false
    };
    this.lastError = info;
    // A refused socket usually means the anonymous device cookie went stale.
    // Ask for a fresh one on the next attempt; a plain network drop does not.
    if (error?.code === TIKTOK_ERRORS.SOCKET_FAILED || error?.code === TIKTOK_ERRORS.CONNECT_TIMEOUT) {
      this.refreshTtwid = true;
    }
    if (FATAL_CODES.has(error?.code)) {
      this.#setState(CONNECTION_STATE.FAILED, {
        category: error?.code === TIKTOK_ERRORS.ROOM_OFFLINE ? 'ended' : 'failed',
        code: error?.code ?? 'unknown',
        messageKey: error?.messageKey ?? null,
        needsUserAction: error?.code === TIKTOK_ERRORS.NOT_CONFIGURED,
        recoverable: false,
        nextRetryAt: null
      });
      this.started = false;
      this.#rejectStart(error);
      return;
    }
    this.#scheduleReconnect(error, generation, {firstAttempt: !this.connectedAt});
  }

  #scheduleReconnect(error, generation, {firstAttempt = false} = {}) {
    if (!this.started || generation !== this.generation) return;
    this.reconnectAttempts += 1;
    if (this.disconnectedAt === null) this.disconnectedAt = this.now();
    if (error?.code === TIKTOK_ERRORS.RATE_LIMITED) {
      const wait = Math.max(this.options.minRateLimitWaitMs, Number(error?.retryAfterMs) || 30000);
      const retryAt = this.now() + wait;
      this.nextRetryAt = retryAt;
      this.#setState(CONNECTION_STATE.RATE_LIMITED, {
        category: 'rate_limit',
        code: error?.code,
        messageKey: error?.messageKey ?? 'errors.tiktokRateLimit',
        retryAfterMs: wait,
        nextRetryAt: retryAt
      });
      this.#scheduleRetry(wait, generation);
      this.#resolveStart();
      return;
    }

    const attempt = this.consecutiveFailures;
    this.consecutiveFailures += 1;
    const base = backoffDelay(attempt, this.options.maxBackoffMs);
    const wait = base + jitterMs(base, this.random);
    const retryAt = this.now() + wait;
    this.nextRetryAt = retryAt;

    if (this.consecutiveFailures >= this.options.maxConsecutiveFailures) {
      const slow = this.options.slowRecoveryMs;
      this.nextRetryAt = this.now() + slow;
      this.#setState(CONNECTION_STATE.FAILED, {
        category: 'failed',
        code: error?.code ?? 'unknown',
        messageKey: error?.messageKey ?? null,
        attempts: this.consecutiveFailures,
        retrying: true,
        recoverable: true,
        retryAfterMs: slow,
        nextRetryAt: this.nextRetryAt
      });
      this.#scheduleRetry(slow, generation);
      this.#resolveStart();
      return;
    }

    this.#setState(CONNECTION_STATE.RECONNECTING, {
      category: this.consecutiveFailures <= 1 ? 'temporary' : 'auto_reconnect',
      code: error?.code ?? 'unknown',
      messageKey: error?.messageKey ?? null,
      attempt: this.consecutiveFailures,
      retryAfterMs: wait,
      nextRetryAt: retryAt
    });
    this.logger?.warn({
      event: 'tiktok.ws.reconnect_scheduled',
      uniqueId: this.uniqueId,
      roomId: this.roomId,
      code: error?.code ?? 'unknown',
      attempt: this.consecutiveFailures,
      retryInMs: wait
    });
    this.#scheduleRetry(wait, generation);
    if (firstAttempt) {
      // A recoverable first failure must not destroy a recording the user
      // explicitly started: keep the session and show the real capture state.
      this.#resolveStart();
    }
  }

  #scheduleRetry(wait, generation) {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = this.#later(wait, () => {
      this.retryTimer = null;
      this.#retryConnect(generation);
    });
  }

  async #retryConnect(generation) {
    if (!this.started || generation !== this.generation) return;
    // Room ids change when a streamer restarts. Re-resolve before reconnecting
    // so a restarted stream is followed instead of joining a dead room.
    const live = await this.#revalidateRoom();
    if (!live || !this.started || generation !== this.generation) return;
    await this.#connectOnce(generation);
  }

  #onSocketClose(info, generation) {
    if (!this.started || generation !== this.generation) return;
    if (this.ending) return;
    const detail = info?.reason === 'idle_timeout'
      ? 'no frames received within the idle window'
      : `socket closed (${info?.code ?? 'unknown'}${info?.reason ? `: ${info.reason}` : ''})`;
    this.logger?.warn({event: 'tiktok.ws.closed', uniqueId: this.uniqueId, roomId: this.roomId, code: info?.code ?? null, reason: info?.reason ?? null});
    this.#scheduleReconnect(new TikTokError(TIKTOK_ERRORS.SOCKET_FAILED, {
      messageKey: 'errors.tiktokSocketFailed',
      httpStatus: 502,
      details: {reason: info?.reason ?? 'socket_closed', message: detail, code: info?.code ?? null}
    }), generation);
  }

  #onFrame({frame, result}, generation) {
    if (!this.started || generation !== this.generation) return;
    const at = this.now();
    this.lastFrameAt = at;
    this.counters.frames += 1;
    if (!result) {
      this.counters.controlFrames += 1;
      // A frame proves the socket is alive; only the transport knows control
      // types. Nothing here is turned into a chat or gift event.
      if (this.state === CONNECTION_STATE.RECONNECTING) this.#setState(CONNECTION_STATE.CONNECTED, {category: 'waiting_events'});
      return;
    }
    this.counters.batchFrames += 1;
    const socketSnapshot = this.socket?.snapshot?.();
    if (socketSnapshot) {
      this.counters.heartbeats = socketSnapshot.heartbeatsSent;
      this.counters.acks = socketSnapshot.acksSent;
      this.counters.decodeErrors = socketSnapshot.decodeErrors;
      this.counters.textFrames = socketSnapshot.textFrames;
    }
    for (const message of result.messages) this.#applyMessage(message);
    if (this.state !== CONNECTION_STATE.CONNECTED) {
      this.#setState(CONNECTION_STATE.CONNECTED, {category: this.#category()});
    } else if (this.detail?.category !== this.#category()) {
      // Promote "connected, waiting" to "connected, events" once real events
      // arrive so the UI can distinguish a socket from a working capture.
      this.#setState(CONNECTION_STATE.CONNECTED, {category: this.#category()});
    }
  }

  #applyMessage(message) {
    this.counters.messages += 1;
    if (message?.isHistory) {
      this.counters.historySkipped += 1;
      return;
    }
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
      if (mapped.action === 3) this.#observeOffline({reason: 'control_message'});
      return;
    }
    if (mapped.kind === 'gift') {
      const key = mapped.groupKey;
      this.counters.giftUpdates += 1;
      const previous = this.pendingGifts.get(key);
      if (!previous) {
        this.pendingGifts.set(key, {event: mapped.event, updatedAt: this.now()});
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
      const at = this.now();
      if (event.event_type === 'chat') {
        this.counters.chats += 1;
        this.#noteEvent(event, at);
      } else if (event.event_type === 'membership') {
        this.counters.memberships += 1;
        this.#noteEvent(event, at);
      }
    }
  }

  #noteEvent(event, at) {
    this.lastEventAt = at;
    this.lastEventType = event?.event_type ?? null;
    try {
      this.onEvent(event);
    } catch (error) {
      this.logger?.warn({event: 'tiktok.emit.failed', kind: event?.event_type, code: error?.code ?? 'unknown'});
    }
  }

  #emitGift(entry) {
    if (!entry?.event) return;
    // A resent final gift carries the same message id; it must not raise the
    // gift counter even though EventIngest would also drop the duplicate row.
    const dedupeId = entry.event.external_id ? String(entry.event.external_id) : null;
    if (dedupeId && this.seenIds.has(dedupeId)) {
      this.counters.duplicates += 1;
      return;
    }
    if (dedupeId) {
      this.seenIds.add(dedupeId);
      if (this.seenIds.size > this.options.maxSeenMessageIds) {
        const oldest = this.seenIds.values().next().value;
        this.seenIds.delete(oldest);
      }
    }
    this.counters.gifts += 1;
    const event = {...entry.event, occurred_at: entry.event.occurred_at ?? this.now()};
    this.#noteEvent(event, this.now());
  }

  #scheduleStreakFlush(generation) {
    if (!this.started || generation !== this.generation) return;
    const tick = Math.min(2000, Math.max(50, this.options.streakFlushMs));
    this.#later(tick, () => {
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

  #recordRecovery() {
    const endedAt = this.now();
    const startedAt = this.disconnectedAt;
    const gap = {
      startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - startedAt),
      lastEventAt: this.lastEventAt,
      possibleMissed: true,
      note: 'webcast_ws_has_no_resume_cursor'
    };
    this.lastGap = gap;
    this.gaps.push(gap);
    if (this.gaps.length > 20) this.gaps.shift();
    this.disconnectedAt = null;
    this.recoveredCount += 1;
    this.logger?.info({
      event: 'tiktok.ws.recovered',
      uniqueId: this.uniqueId,
      roomId: this.roomId,
      gapMs: gap.durationMs,
      lastEventAt: gap.lastEventAt,
      possibleGap: true
    });
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

  /** Room metadata read. Never the evidence that a session ended on its own. */
  async #checkPlatformStatus() {
    const observedAt = this.now();
    this.lastStatusAt = observedAt;
    if (!this.client?.resolveRoom) return true;
    this.counters.roomLookups += 1;
    this.lastRoomLookupAt = observedAt;
    let room;
    try {
      room = await this.client.resolveRoom(this.uniqueId);
    } catch (error) {
      this.logger?.warn({event: 'tiktok.status.failed', code: error?.code ?? 'unknown'});
      return true;
    }
    if (!this.started) return false;
    const resolvedRoomId = room?.roomId ? String(room.roomId) : null;
    if (resolvedRoomId && this.roomId && resolvedRoomId !== String(this.roomId)) {
      this.#observeOffline({reason: 'room_changed', at: observedAt});
      return false;
    }
    if (room?.isLive) {
      this.offlineObservations = 0;
      this.platformStatus = {status: 'live', at: observedAt};
      this.onPlatformStatus({status: 'live', at: observedAt});
      return true;
    }
    this.#observeOffline({reason: 'room_offline', at: observedAt});
    return false;
  }

  async #revalidateRoom() {
    if (!this.client?.resolveRoom) return true;
    const observedAt = this.now();
    this.counters.roomLookups += 1;
    this.lastRoomLookupAt = observedAt;
    try {
      const room = await this.client.resolveRoom(this.uniqueId);
      if (!this.started) return false;
      const resolvedRoomId = room?.roomId ? String(room.roomId) : null;
      if (resolvedRoomId && this.roomId && resolvedRoomId !== String(this.roomId)) {
        this.logger?.info({
          event: 'tiktok.ws.room_changed',
          sessionRoomId: this.roomId,
          observedRoomId: resolvedRoomId,
          uniqueId: this.uniqueId
        });
        this.#observeOffline({reason: 'room_changed', at: observedAt});
        return false;
      }
      if (room && room.isLive === false) {
        this.#observeOffline({reason: 'room_offline', at: observedAt});
        return false;
      }
      return true;
    } catch (error) {
      // A failed metadata read is not proof the room ended. Keep the socket
      // capture alive rather than ending a real recording.
      this.logger?.warn({event: 'tiktok.ws.recheck.failed', code: error?.code ?? 'unknown'});
      return true;
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
      this.#setState(CONNECTION_STATE.STOPPED, {category: 'ended', reason: 'platform_ended', platformEndedAt: at});
      try {
        this.onEnd({reason: 'platform_ended', quality: 'verified', observedAt: at});
      } catch (error) {
        this.logger?.warn({event: 'tiktok.end.callback.failed', code: error?.code ?? 'unknown'});
      }
      this.started = false;
      this.#clearTimers();
      this.socket?.close({code: 1000, reason: 'platform_ended'});
    }
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
    for (const entry of this.pendingGifts.values()) this.#emitGift(entry);
    this.pendingGifts.clear();
    this.socket?.close({code: 1000, reason: 'client_stop'});
    this.socket = null;
    if (this.startResolver) {
      this.#rejectStart(new TikTokError(TIKTOK_ERRORS.STOPPED, {
        messageKey: 'errors.tiktokStopped',
        httpStatus: 409
      }));
    }
    this.#setState(CONNECTION_STATE.STOPPED, {category: 'stopped', reason: 'user', nextRetryAt: null});
  }

  snapshot() {
    return {
      ...super.snapshot(),
      uniqueId: this.uniqueId,
      roomId: this.roomId,
      wsHost: this.wsHost,
      counters: {...this.counters},
      pendingStreaks: this.pendingGifts.size,
      viewerCount: this.viewerCount,
      platformStatus: this.platformStatus,
      lastFrameAt: this.lastFrameAt,
      lastEventAt: this.lastEventAt,
      lastError: this.lastError,
      capture: this.capture(),
      gaps: [...this.gaps]
    };
  }
}

export const __internal = {backoffDelay, DEFAULT_OPTIONS, FATAL_CODES};
