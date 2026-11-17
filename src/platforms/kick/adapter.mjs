import {CONNECTION_STATE, PlatformAdapter} from '../shared/adapter.mjs';
import {KICK_ERRORS, KickError, isKickError} from './errors.mjs';
import {KickHttp} from './http.mjs';
import {kickEventKind, isKickChatEvent, mapKickChatEvent, mapKickEvent} from './messages.mjs';
import {KickChatSocket, fetchChatConnection, fetchGuestToken, resolveChannel} from './transport.mjs';

/**
 * Kick chat adapter (G1 skeleton).
 *
 * One instance = one Kick channel = one session. It owns the socket lifetime,
 * the guest-token refresh, the reconnect policy and its counters. It never
 * writes to the database: canonical drafts go to the injected `onEvent`, and
 * EventIngest remains the only write path.
 *
 * Honest boundaries, all verified against the live platform:
 *   - an open socket is not a capture: `start()` resolves only after the
 *     chatroom subscription was acknowledged;
 *   - `stop()` is final: a close caused by stop() never schedules a reconnect;
 *   - a dropped socket is not a platform refusal: it reconnects with
 *     exponential backoff, a fresh guest token and fresh connection config;
 *   - the transport has no replay cursor, so messages published while
 *     reconnecting can be missed (documented in the G1 report);
 *   - only chat is emitted. Subscription/gift events are counted but not turned
 *     into events until they are observed and their fields are verified (G2+).
 */

const DEFAULT_OPTIONS = Object.freeze({
  connectTimeoutMs: 15000,
  maxBackoffMs: 30000,
  baseBackoffMs: 1000,
  maxConsecutiveFailures: 12,
  offlineConfirmations: 2,
  checkLiveOnReconnect: true,
  // Guest tokens carry ~45 min TTL. Reconnect shortly before expiry so a
  // capture never relies on the server rejecting an expired token.
  tokenRefreshLeadMs: 90000,
  minTokenRefreshMs: 30000,
  // Kick chat rooms stay open after a stream ends, so the socket alone cannot
  // prove the broadcast is over. The adapter asks the public channel JSON;
  // two consecutive "offline" observations end the session.
  statusIntervalMs: 60000,
  statusOfflineConfirmations: 2
});

function backoffDelay(attempt, {baseBackoffMs, maxBackoffMs}) {
  return Math.min(maxBackoffMs, baseBackoffMs * 2 ** Math.min(Math.max(0, attempt - 1), 5));
}

function jitterMs(baseMs, random) {
  if (!Number.isFinite(baseMs) || baseMs <= 0) return 0;
  const span = Math.min(5000, Math.max(50, Math.round(baseMs * 0.1)));
  return Math.round(random() * span);
}

export class KickAdapter extends PlatformAdapter {
  constructor({
    slug,
    sessionId = null,
    channel = null,
    http = null,
    WebSocketImpl = globalThis.WebSocket,
    logger = null,
    now = Date.now,
    random = Math.random,
    options = {}
  } = {}) {
    super({
      id: 'kick',
      platform: 'kick',
      label: 'Kick',
      // Only chat has been verified. Gift/subscription events are NOT advertised
      // as supported capabilities until real events are observed and mapped.
      capabilities: ['chat', 'emote']
    });
    this.slug = slug === null || slug === undefined ? null : String(slug);
    this.sessionId = sessionId === null || sessionId === undefined ? null : String(sessionId);
    this.channel = channel;
    this.http = http ?? new KickHttp({logger, now});
    this.ownsHttp = !http;
    this.WebSocketImpl = WebSocketImpl;
    this.logger = logger;
    this.now = now;
    this.random = random;
    this.options = {...DEFAULT_OPTIONS, ...options};

    this.socket = null;
    this.started = false;
    this.stopping = false;
    this.stopReason = null;
    this.generation = 0;
    this.reconnectAttempts = 0;
    this.consecutiveFailures = 0;
    this.recoveredCount = 0;
    this.offlineObservations = 0;
    this.lastError = null;
    this.lastGap = null;
    this.gaps = [];
    this.connectedAt = null;
    this.disconnectedAt = null;
    this.lastEventAt = null;
    this.nextRetryAt = null;
    this.retryTimer = null;
    this.tokenRefreshTimer = null;
    this.statusTimer = null;
    this.statusChecking = false;
    this.statusOfflineObservations = 0;
    this.timers = new Set();
    this.onEvent = () => {};
    this.onEnd = () => {};
    this.onRawPublication = null;
    this.counters = this.#emptyCounters();
  }

  #emptyCounters() {
    return {
      connections: 0,
      reconnectAttempts: 0,
      reconnects: 0,
      publications: 0,
      chats: 0,
      gifts: 0,
      memberships: 0,
      kicksGifted: 0,
      giftedSubscriptions: 0,
      subscriptions: 0,
      tokenRefreshes: 0,
      statusChecks: 0,
      statusOffline: 0,
      skipped: 0,
      decodeErrors: 0,
      crossRoomIgnored: 0,
      emoteMessages: 0,
      withStableId: 0,
      withMessageId: 0,
      withTimestamp: 0,
      assumedUtc: 0,
      replies: 0,
      unknownEvents: 0,
      knownNonChat: 0,
      eventNames: {}
    };
  }

  #later(ms, fn) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      try {
        fn();
      } catch (error) {
        this.logger?.warn({event: 'kick.timer.failed', code: error?.code ?? 'unknown'});
      }
    }, Math.max(0, ms));
    timer.unref?.();
    this.timers.add(timer);
    return timer;
  }

  #clearTimers() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.retryTimer = null;
  }

  #expectedChatChannel() {
    return this.channel ? `chatrooms.${this.channel.chatroomId}.v2` : null;
  }

  #onPublication = (publication) => {
    this.counters.publications += 1;
    const eventName = publication?.event ?? 'unknown';
    this.counters.eventNames[eventName] = (this.counters.eventNames[eventName] ?? 0) + 1;
    if (publication?.decodeFailed) {
      this.counters.decodeErrors += 1;
      return;
    }
    // G1 evidence hook: the PoC keeps the untouched native payload so a later
    // review can check every field. No production code registers this.
    if (this.onRawPublication) {
      try {
        this.onRawPublication({channel: publication.channel, event: eventName, data: publication.data, at: this.now()});
      } catch {
        /* evidence collection must never break capture */
      }
    }
    if (!isKickChatEvent(eventName)) {
      const kind = kickEventKind(eventName);
      const {drafts, reason} = mapKickEvent(eventName, publication.data, {
        sessionId: this.sessionId,
        room: this.channel,
        receivedAt: this.now()
      });
      if (drafts.length === 0) {
        if (reason === 'unknown_event') this.counters.unknownEvents += 1;
        else this.counters.knownNonChat += 1;
        return;
      }
      if (kind === 'kicks_gifted') this.counters.kicksGifted += 1;
      if (kind === 'gifted_subscriptions') this.counters.giftedSubscriptions += 1;
      if (kind === 'subscription') this.counters.subscriptions += 1;
      for (const draft of drafts) {
        if (draft.event_type === 'gift') this.counters.gifts += 1;
        else if (draft.event_type === 'membership') this.counters.memberships += 1;
        this.lastEventAt = this.now();
        this.onEvent(draft);
      }
      return;
    }
    // Defense in depth: one adapter only ever accepts its own chatroom's topic.
    const expected = this.#expectedChatChannel();
    if (expected && publication.channel && publication.channel !== expected) {
      this.counters.crossRoomIgnored += 1;
      return;
    }
    const {draft, reason} = mapKickChatEvent(publication.data, {
      sessionId: this.sessionId,
      room: this.channel,
      receivedAt: this.now()
    });
    if (!draft) {
      this.counters.skipped += 1;
      this.logger?.warn({event: 'kick.message.skipped', reason});
      return;
    }
    this.counters.chats += 1;
    if (draft._kick?.timestampSource === 'created_at') this.counters.withTimestamp += 1;
    else this.counters.assumedUtc += 1;
    if (draft.viewer_uid) this.counters.withStableId += 1;
    if (draft.external_id) this.counters.withMessageId += 1;
    if (draft.emotes) this.counters.emoteMessages += 1;
    if (draft._kick?.messageType === 'reply') this.counters.replies += 1;
    this.lastEventAt = this.now();
    this.onEvent(draft);
  };

  #onSocketError = (error) => {
    this.lastError = error;
    this.logger?.warn({event: 'kick.socket.error', code: error?.code ?? 'unknown'});
  };

  #onSocketClose = (info) => {
    this.disconnectedAt = this.now();
    this.socket = null;
    this.#clearTokenRefresh();
    this.#clearStatusTimer();
    if (this.stopping || !this.started) return;
    const tokenExpired = info?.disconnect?.code === 109;
    const tokenRefresh = info?.reason === 'token_refresh';
    this.logger?.info({
      event: 'kick.socket.closed',
      code: info?.code ?? null,
      reason: info?.reason ?? null,
      tokenExpired
    });
    const immediate = tokenExpired || tokenRefresh;
    this.#scheduleReconnect(tokenExpired ? 'token_expired' : (info?.reason ?? 'socket_closed'), immediate ? 250 : null);
  };

  #clearTokenRefresh() {
    if (this.tokenRefreshTimer) clearTimeout(this.tokenRefreshTimer);
    this.tokenRefreshTimer = null;
  }

  #clearStatusTimer() {
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.statusTimer = null;
  }

  /**
   * Periodically confirm the broadcast is still live.
   *
   * Kick's chat socket remains connected after a stream ends, so "still
   * receiving frames" is not evidence of a live broadcast. Two consecutive
   * offline observations end the capture; a failed read changes nothing.
   */
  #armStatusCheck() {
    this.#clearStatusTimer();
    if (this.stopping || !this.started) return;
    const interval = Math.max(20, Number(this.options.statusIntervalMs) || 60000);
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      this.#checkLiveStatus()
        .catch((error) => this.logger?.warn({event: 'kick.status.failed', code: error?.code ?? 'unknown'}))
        .finally(() => this.#armStatusCheck());
    }, interval);
    this.statusTimer.unref?.();
  }

  async #checkLiveStatus() {
    if (this.statusChecking || this.stopping || !this.started || !this.channel?.slug) return;
    this.statusChecking = true;
    try {
      const observed = await resolveChannel(this.http, this.channel.slug);
      this.counters.statusChecks += 1;
      if (observed.isLive) {
        this.statusOfflineObservations = 0;
        this.channel = {...this.channel, ...observed};
        return;
      }
      this.statusOfflineObservations += 1;
      this.counters.statusOffline += 1;
      if (this.statusOfflineObservations >= (this.options.statusOfflineConfirmations ?? 2)) {
        await this.stop({reason: 'platform_ended'});
        this.onEnd({reason: 'platform_ended'});
      }
    } finally {
      this.statusChecking = false;
    }
  }

  /** Refresh the guest token before its TTL runs out instead of waiting for a refusal. */
  #armTokenRefresh(socket) {
    this.#clearTokenRefresh();
    const ttlSec = Number(socket?.connectedInfo?.ttl);
    if (!Number.isFinite(ttlSec) || ttlSec <= 0) return;
    const delay = Math.max(this.options.minTokenRefreshMs, ttlSec * 1000 - this.options.tokenRefreshLeadMs);
    this.tokenRefreshTimer = setTimeout(() => {
      this.tokenRefreshTimer = null;
      if (this.stopping || this.socket !== socket) return;
      this.counters.tokenRefreshes += 1;
      this.logger?.info({event: 'kick.token.refresh', ttlSec});
      socket.close({code: 4002, reason: 'token_refresh'});
    }, delay);
    this.tokenRefreshTimer.unref?.();
  }

  #scheduleReconnect(reason, fixedDelayMs = null) {
    if (this.stopping || !this.started) return;
    this.reconnectAttempts += 1;
    this.counters.reconnectAttempts += 1;
    const delay = fixedDelayMs ?? (backoffDelay(this.reconnectAttempts, this.options) + jitterMs(backoffDelay(this.reconnectAttempts, this.options), this.random));
    this.nextRetryAt = this.now() + delay;
    this.setState(CONNECTION_STATE.RECONNECTING, {
      reason,
      attempt: this.reconnectAttempts,
      retryInMs: delay
    });
    const generation = this.generation;
    this.retryTimer = this.#later(delay, () => {
      if (this.stopping || generation !== this.generation) return;
      this.#reconnect().catch((error) => {
        this.lastError = error;
        this.logger?.warn({event: 'kick.reconnect.failed', code: error?.code ?? 'unknown'});
      });
    });
  }

  async #reconnect() {
    if (this.stopping) return;
    const closedAt = this.disconnectedAt;
    if (this.options.checkLiveOnReconnect) {
      const channel = await resolveChannel(this.http, this.channel.slug).catch((error) => {
        if (isKickError(error) && error.code === KICK_ERRORS.ROOM_NOT_FOUND) throw error;
        this.logger?.warn({event: 'kick.reconnect.lookup_failed', code: error?.code ?? 'unknown'});
        return null;
      });
      if (channel) {
        this.channel = {...this.channel, ...channel};
        if (!channel.isLive) {
          this.offlineObservations += 1;
          if (this.offlineObservations >= this.options.offlineConfirmations) {
            await this.stop({reason: 'platform_ended'});
            this.onEnd({reason: 'platform_ended'});
            return;
          }
        } else {
          this.offlineObservations = 0;
        }
      }
    }
    try {
      await this.#connectOnce();
      // A stop() may have landed while the handshake was in flight.
      if (this.stopping) {
        this.socket?.close({code: 1000, reason: 'client_stop'});
        this.socket = null;
        return;
      }
      this.recoveredCount += 1;
      this.counters.reconnects += 1;
      this.consecutiveFailures = 0;
      this.lastGap = closedAt ? this.now() - closedAt : null;
      if (this.lastGap !== null) this.gaps.push({at: closedAt, durationMs: this.lastGap, attempt: this.reconnectAttempts});
      this.setState(CONNECTION_STATE.CONNECTED, {
        reason: 'recovered',
        attempt: this.reconnectAttempts,
        gapMs: this.lastGap
      });
      this.reconnectAttempts = 0;
      this.nextRetryAt = null;
    } catch (error) {
      this.consecutiveFailures += 1;
      this.lastError = error;
      if (this.consecutiveFailures >= this.options.maxConsecutiveFailures) {
        this.setState(CONNECTION_STATE.FAILED, {
          reason: 'max_failures',
          code: error?.code ?? 'unknown',
          failures: this.consecutiveFailures
        });
        this.onEnd({reason: 'failed', code: error?.code ?? 'unknown'});
        return;
      }
      this.#scheduleReconnect(error?.code ?? 'connect_failed');
    }
  }

  async #connectOnce() {
    const channel = this.channel;
    if (!channel) throw new KickError(KICK_ERRORS.ROOM_UNAVAILABLE, {httpStatus: 400, details: {reason: 'channel_missing'}});
    const connection = await fetchChatConnection(this.http, channel.channelId);
    const guest = await fetchGuestToken(this.http);
    const socket = new KickChatSocket({
      url: connection.url,
      token: guest.token,
      chatroomId: channel.chatroomId,
      channelId: channel.channelId,
      WebSocketImpl: this.WebSocketImpl,
      connectTimeoutMs: this.options.connectTimeoutMs,
      logger: this.logger,
      now: this.now,
      onPublication: this.#onPublication,
      onClose: this.#onSocketClose,
      onError: this.#onSocketError
    });
    this.socket = socket;
    await socket.connect();
    this.counters.connections += 1;
    this.connectedAt = this.now();
    this.disconnectedAt = null;
    this.lastError = null;
    this.#armTokenRefresh(socket);
    this.#armStatusCheck();
    return socket;
  }

  /**
   * Resolve the room and open the first subscription.
   * Rejects (rather than pretending success) when the channel is missing,
   * offline or the transport cannot subscribe.
   */
  async start({onEvent = null, onStateChange = null, onEnd = null, onRawPublication = null} = {}) {
    if (this.started) throw new KickError(KICK_ERRORS.PROTOCOL, {httpStatus: 409, details: {reason: 'already_started'}});
    if (onEvent) this.onEvent = onEvent;
    if (onEnd) this.onEnd = onEnd;
    if (onRawPublication) this.onRawPublication = onRawPublication;
    if (onStateChange) this.onStateChange = onStateChange;
    this.started = true;
    this.stopping = false;
    this.setState(CONNECTION_STATE.CONNECTING, {reason: 'resolving'});

    try {
      if (!this.channel) {
        if (!this.slug) {
          throw new KickError(KICK_ERRORS.ROOM_UNAVAILABLE, {httpStatus: 400, details: {reason: 'slug_missing'}});
        }
        this.channel = await resolveChannel(this.http, this.slug);
      }
      if (!this.channel.isLive) {
        throw new KickError(KICK_ERRORS.ROOM_OFFLINE, {
          httpStatus: 409,
          details: {slug: this.channel.slug}
        });
      }
      await this.#connectOnce();
      this.setState(CONNECTION_STATE.CONNECTED, {
        reason: 'subscribed',
        chatroomId: this.channel.chatroomId,
        provider: 'centrifugo'
      });
      return this;
    } catch (error) {
      this.lastError = error;
      this.started = false;
      try {
        this.socket?.close({code: 1000, reason: 'start_failed'});
      } catch {
        /* ignore */
      }
      this.socket = null;
      if (this.ownsHttp) {
        try {
          await this.http.close();
        } catch {
          /* ignore */
        }
      }
      this.setState(CONNECTION_STATE.FAILED, {reason: 'start_failed', code: error?.code ?? 'unknown'});
      throw error;
    }
  }

  /** Final stop: closes the socket, cancels retries and never reconnects. */
  async stop({reason = 'user'} = {}) {
    this.stopping = true;
    this.started = false;
    this.stopReason = reason;
    this.generation += 1;
    this.#clearTimers();
    this.#clearTokenRefresh();
    this.#clearStatusTimer();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close({code: 1000, reason: 'client_stop'});
      } catch {
        /* ignore */
      }
    }
    if (this.ownsHttp) {
      try {
        await this.http.close();
      } catch {
        /* ignore */
      }
    }
    this.setState(CONNECTION_STATE.STOPPED, {reason});
    return this.snapshot();
  }

  /** G1 drop test: kill the socket without stopping; the adapter reconnects. */
  debugDropConnection() {
    if (!this.socket) return false;
    this.socket.dropForTest();
    return true;
  }

  snapshot() {
    const socket = this.socket?.snapshot?.() ?? null;
    return {
      ...super.snapshot(),
      slug: this.channel?.slug ?? this.slug,
      channelId: this.channel?.channelId ?? null,
      chatroomId: this.channel?.chatroomId ?? null,
      isLive: this.channel?.isLive ?? null,
      connectedAt: this.connectedAt,
      disconnectedAt: this.disconnectedAt,
      lastEventAt: this.lastEventAt,
      reconnectAttempts: this.reconnectAttempts,
      recoveredCount: this.recoveredCount,
      lastGap: this.lastGap,
      gaps: [...this.gaps],
      nextRetryAt: this.nextRetryAt,
      lastError: this.lastError ? {code: this.lastError.code ?? null, message: this.lastError.message ?? null} : null,
      counters: {...this.counters, eventNames: {...this.counters.eventNames}},
      socket
    };
  }

  /**
   * UI-facing capture summary. Categories mirror the existing platform cards:
   * a connected socket with no event yet is `waiting_events`, not "working".
   */
  capture() {
    const snapshot = this.snapshot();
    const counters = snapshot.counters;
    const events = counters.chats + counters.gifts + counters.memberships;
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
      category = this.stopReason === 'platform_ended' ? 'ended' : 'stopped';
    }
    return {
      transport: 'centrifugo-ws',
      protocol: 'kick-centrifugo',
      connection: snapshot.state,
      category,
      captureState: category,
      messages: events,
      eventsReceived: events,
      eventsVerified: events > 0,
      chatroomId: snapshot.chatroomId,
      channelId: snapshot.channelId,
      slug: snapshot.slug,
      connectedAt: snapshot.connectedAt,
      disconnectedAt: snapshot.disconnectedAt,
      lastEventAt: snapshot.lastEventAt,
      reconnectAttempts: snapshot.reconnectAttempts,
      reconnects: counters.reconnects,
      tokenRefreshes: counters.tokenRefreshes,
      nextRetryAt: snapshot.nextRetryAt,
      lastFailure: snapshot.lastError,
      gaps: snapshot.gaps,
      lastGap: snapshot.lastGap,
      possibleGap: snapshot.gaps.length > 0,
      counters,
      stats: counters,
      host: snapshot.socket?.url ?? null,
      checkedAt: this.now()
    };
  }
}

export const __internal = {backoffDelay, jitterMs};
