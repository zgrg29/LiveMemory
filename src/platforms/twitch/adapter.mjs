import {PlatformAdapter, CONNECTION_STATE} from '../shared/adapter.mjs';
import {TWITCH_ERRORS, TwitchError} from './errors.mjs';
import {parseIrcPayload} from './irc.mjs';
import {mapTwitchPrivmsg, mapTwitchRoomState, mapTwitchUsernotice} from './mapper.mjs';

/**
 * Anonymous Twitch IRC adapter (read-only public chat).
 *
 * Transport only: it joins one public channel, parses IRCv3 messages into
 * canonical drafts and reports connection/platform state. Persistence, dedupe
 * and viewer aggregation stay in EventIngest.
 *
 * The IRC socket staying open is not proof that the streamer is live. A public
 * metadata check owns the live/offline state; two consecutive offline reads (or
 * an explicit channel error) confirm the end. Network failures, 429s and
 * malformed replies never end a recording.
 *
 * Reconnects use capped exponential backoff. After `maxReconnectAttempts` the
 * adapter enters a visible `failed` state but keeps a slow recovery probe once
 * per `slowRecoveryMs`; it never spins or creates a second session.
 */

const DEFAULT_OPTIONS = Object.freeze({
  url: 'wss://irc-ws.chat.twitch.tv:443',
  connectTimeoutMs: 15000,
  heartbeatMs: 60000,
  watchdogMs: 90000,
  maxBackoffMs: 30000,
  maxReconnectAttempts: 15,
  slowRecoveryMs: 300000,
  statusIntervalMs: 60000,
  statusTimeoutMs: 10000,
  maxStatusBackoffMs: 600000,
  offlineConfirmDelayMs: 15000
});

const MAX_SEEN_MESSAGE_IDS = 10000;

function backoffDelay(attempt, maxMs) {
  return Math.min(maxMs, 1000 * 2 ** Math.min(Math.max(0, attempt), 5));
}

export class TwitchIrcAdapter extends PlatformAdapter {
  constructor({
    login,
    channelId = null,
    channel = null,
    client = null,
    WebSocketImpl = globalThis.WebSocket,
    logger = null,
    now = Date.now,
    ...options
  } = {}) {
    super({
      id: 'twitch',
      platform: 'twitch',
      label: 'Twitch Live',
      capabilities: ['chat', 'subscription', 'gifted_subscription', 'bits']
    });
    this.login = String(login ?? '').trim().toLowerCase();
    this.channelId = channelId === null || channelId === undefined ? null : String(channelId);
    this.channel = channel && typeof channel === 'object' ? {...channel} : null;
    this.client = client;
    this.WebSocketImpl = WebSocketImpl;
    this.logger = logger;
    this.now = now;
    this.options = {...DEFAULT_OPTIONS, ...options};

    this.socket = null;
    this.generation = 0;
    this.attempt = 0;
    this.started = false;
    this.ending = false;
    this.connected = false;
    this.hasConnected = false;
    this.startResolver = null;
    this.startTimer = null;
    this.heartbeat = null;
    this.watchdog = null;
    this.reconnectTimer = null;
    this.statusTimer = null;
    this.statusBusy = false;
    this.statusFailures = 0;
    this.offlineObservations = 0;
    this.lastMessageAt = null;
    this.lastStatusAt = null;
    this.platformStatus = null;
    this.roomId = null;
    this.streamId = this.channel?.streamId ?? null;
    this.startedAtPlatform = this.channel?.startedAt ?? null;
    this.viewers = this.channel?.viewers ?? null;
    this.onEvent = () => {};
    this.onEnd = () => {};
    this.onPlatformStatus = () => {};
    this.nick = null;
    this.seenIds = new Set();
    this.counters = {privmsg: 0, usernotice: 0, ignored: 0, duplicateDropped: 0, unknown: 0};
    this.lastError = null;
  }

  setConnection(state, detail = null) {
    if (this.state !== state) this.setState(state, detail);
    else this.detail = detail;
  }

  async start({onEvent = () => {}, onStateChange = null, onEnd = null, onPlatformStatus = null} = {}) {
    if (!this.login) {
      throw new TwitchError(TWITCH_ERRORS.LINK_INVALID, {
        messageKey: 'errors.twitchLinkInvalid',
        httpStatus: 400
      });
    }
    if (typeof this.WebSocketImpl !== 'function') {
      throw new TwitchError(TWITCH_ERRORS.WEBSOCKET_UNAVAILABLE, {
        messageKey: 'errors.twitchWebSocketUnavailable',
        httpStatus: 503
      });
    }
    this.onEvent = onEvent;
    this.onStateChange = onStateChange;
    this.onEnd = onEnd ?? (() => {});
    this.onPlatformStatus = onPlatformStatus ?? (() => {});
    this.#clearTimers();
    this.started = true;
    this.ending = false;
    this.connected = false;
    this.hasConnected = false;
    this.generation += 1;
    this.attempt = 0;
    this.statusFailures = 0;
    this.offlineObservations = 0;
    this.seenIds.clear();
    this.counters = {privmsg: 0, usernotice: 0, ignored: 0, duplicateDropped: 0, unknown: 0};
    this.lastError = null;
    this.setConnection(CONNECTION_STATE.CONNECTING, {login: this.login, attempt: 0});

    await new Promise((resolve, reject) => {
      this.startResolver = {resolve, reject};
      this.#connect(this.generation).catch((error) => this.#failStart(error));
      const timer = setTimeout(() => {
        this.#failStart(new TwitchError(TWITCH_ERRORS.CONNECT_TIMEOUT, {
          messageKey: 'errors.twitchConnectTimeout',
          httpStatus: 504,
          details: {login: this.login}
        }));
      }, this.options.connectTimeoutMs);
      timer.unref?.();
      this.startTimer = timer;
    });
  }

  async stop() {
    this.started = false;
    this.ending = true;
    this.connected = false;
    this.generation += 1;
    this.#clearTimers();
    if (this.startResolver) {
      const {reject} = this.startResolver;
      this.startResolver = null;
      reject(new TwitchError(TWITCH_ERRORS.STOPPED, {
        messageKey: 'errors.twitchStopped',
        httpStatus: 409
      }));
    }
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        /* already closing */
      }
    }
    this.setConnection(CONNECTION_STATE.STOPPED, {login: this.login});
  }

  snapshot() {
    return {
      ...super.snapshot(),
      detail: {
        ...(this.detail ?? {}),
        login: this.login,
        channelId: this.channelId,
        roomId: this.roomId,
        streamId: this.streamId,
        viewers: this.viewers,
        attempt: this.attempt,
        platformStatus: this.platformStatus,
        platformStatusAt: this.lastStatusAt,
        offlineObservations: this.offlineObservations,
        counters: {...this.counters}
      }
    };
  }

  #clearTimers() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.watchdog) clearTimeout(this.watchdog);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.statusTimer) clearTimeout(this.statusTimer);
    if (this.startTimer) clearTimeout(this.startTimer);
    this.heartbeat = null;
    this.watchdog = null;
    this.reconnectTimer = null;
    this.statusTimer = null;
    this.startTimer = null;
  }

  #failStart(error) {
    this.lastError = error;
    this.started = false;
    this.ending = true;
    this.generation += 1;
    this.#clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        /* already closing */
      }
    }
    this.setConnection(
      error?.code === TWITCH_ERRORS.CHANNEL_UNAVAILABLE
        ? CONNECTION_STATE.AUTH_REQUIRED
        : CONNECTION_STATE.FAILED,
      {login: this.login, code: error?.code ?? 'unknown'}
    );
    if (this.startResolver) {
      const {reject} = this.startResolver;
      this.startResolver = null;
      reject(error);
    }
  }

  #resolveStart() {
    if (!this.startResolver) return;
    const {resolve} = this.startResolver;
    this.startResolver = null;
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
    resolve();
  }

  async #connect(generation) {
    if (generation !== this.generation || !this.started) return;
    this.setConnection(this.attempt > 0 ? CONNECTION_STATE.RECONNECTING : CONNECTION_STATE.CONNECTING, {
      login: this.login,
      attempt: this.attempt
    });
    let socket;
    try {
      socket = new this.WebSocketImpl(this.options.url);
    } catch (error) {
      this.lastError = error;
      if (this.startResolver) {
        this.#failStart(new TwitchError(TWITCH_ERRORS.NETWORK, {
          messageKey: 'errors.twitchNetwork',
          httpStatus: 502,
          cause: error
        }));
      } else {
        this.#scheduleReconnect(generation, {reason: 'socket_create'});
      }
      return;
    }
    this.socket = socket;
    this.nick = `justinfan${Math.floor(Math.random() * 90000) + 10000}`;

    try {
      socket.addEventListener('open', () => {
        if (generation !== this.generation) return;
        this.logger?.info({event: 'twitch.socket.open', login: this.login, attempt: this.attempt});
        // Anonymous read-only login. No OAuth token or user credentials are sent.
        this.#send('CAP REQ :twitch.tv/tags twitch.tv/commands');
        this.#send('PASS SCHMOOPIIE');
        this.#send(`NICK ${this.nick}`);
        this.#send(`JOIN #${this.login}`);
      });
      socket.addEventListener('message', (event) => {
        if (generation !== this.generation) return;
        this.#handleFrame(event?.data, generation)
          .catch((error) => this.logger?.warn({event: 'twitch.frame.failed', code: error?.code ?? 'frame'}));
      });
      socket.addEventListener('error', () => {
        if (generation === this.generation) this.logger?.warn({event: 'twitch.socket.error', login: this.login});
      });
      socket.addEventListener('close', () => {
        if (generation !== this.generation) return;
        this.connected = false;
        this.#clearHeartbeat();
        if (this.started && !this.ending) {
          this.logger?.warn({event: 'twitch.socket.closed', login: this.login, attempt: this.attempt});
          this.#scheduleReconnect(generation, {reason: 'closed'});
        }
      });
    } catch (error) {
      this.#scheduleReconnect(generation, {reason: 'listener'});
    }
  }

  #send(line) {
    try {
      this.socket?.send(line);
      return true;
    } catch (error) {
      this.logger?.warn({event: 'twitch.send.failed', code: error?.code ?? 'send'});
      return false;
    }
  }

  async #handleFrame(data, generation) {
    if (data === undefined || data === null) return;
    let text;
    if (typeof data === 'string') text = data;
    else if (typeof data.text === 'function') text = await data.text();
    else if (typeof data.toString === 'function') text = data.toString();
    else return;
    this.lastMessageAt = this.now();
    for (const parsed of parseIrcPayload(text)) {
      if (generation !== this.generation) return;
      this.#armWatchdog(generation);
      this.#handleLine(parsed);
    }
  }

  #handleLine(parsed) {
    switch (parsed.command) {
      case 'PING':
        this.#send(`PONG :${parsed.trailing ?? 'tmi.twitch.tv'}`);
        return;
      case 'PONG':
        return;
      case 'ROOMSTATE':
        this.#handleRoomState(parsed);
        return;
      case 'PRIVMSG':
        this.#handlePrivmsg(parsed);
        return;
      case 'USERNOTICE':
        this.#handleUsernotice(parsed);
        return;
      case 'NOTICE':
        this.#handleNotice(parsed);
        return;
      case 'RECONNECT':
        // Twitch asks clients to reconnect. Keep the same session and dedupe
        // window; do not create a new recording.
        this.logger?.info({event: 'twitch.server.reconnect', login: this.login});
        this.attempt = 0;
        try {
          this.socket?.close();
        } catch {
          /* close handler reconnects */
        }
        return;
      case 'CLEARCHAT':
      case 'CLEARMSG':
        // Moderation actions are not chat and are not payment events.
        this.counters.ignored += 1;
        return;
      case '001':
      case '002':
      case '003':
      case '004':
      case '375':
      case '372':
      case '376':
      case 'JOIN':
      case 'PART':
      case 'USERSTATE':
      case 'GLOBALUSERSTATE':
      case 'CAP':
        return;
      default:
        this.counters.unknown += 1;
        return;
    }
  }

  #isCurrentChannel(parsed) {
    const target = String(parsed.params?.[0] ?? '').replace(/^#/, '').toLowerCase();
    return !target || target === this.login;
  }

  #handleRoomState(parsed) {
    if (!this.#isCurrentChannel(parsed)) return;
    const state = mapTwitchRoomState(parsed);
    if (!state) return;
    if (state.roomId) {
      if (this.channelId && state.roomId !== this.channelId) {
        this.logger?.warn({
          event: 'twitch.room.mismatch',
          login: this.login,
          expected: this.channelId,
          actual: state.roomId
        });
        this.#failStart(new TwitchError(TWITCH_ERRORS.PROTOCOL, {
          messageKey: 'errors.twitchProtocol',
          httpStatus: 502,
          details: {reason: 'room_id_mismatch'}
        }));
        return;
      }
      this.roomId = state.roomId;
      this.channelId = this.channelId ?? state.roomId;
    }
    if (!this.hasConnected) {
      this.hasConnected = true;
      this.attempt = 0;
      this.connected = true;
      this.setConnection(CONNECTION_STATE.CONNECTED, {
        login: this.login,
        channelId: this.channelId,
        roomId: this.roomId
      });
      this.#emitPlatformStatus({status: 'live', at: this.now(), lastLiveSeenAt: this.now(), source: 'irc'});
      this.#startHeartbeat(this.generation);
      this.#scheduleStatus(this.options.statusIntervalMs);
      this.logger?.info({
        event: 'twitch.connected',
        login: this.login,
        roomId: this.roomId,
        channelId: this.channelId
      });
      this.#resolveStart();
    } else {
      // A ROOMSTATE after reconnect proves the socket is healthy again.
      this.connected = true;
      this.attempt = 0;
      this.setConnection(CONNECTION_STATE.CONNECTED, {
        login: this.login,
        channelId: this.channelId,
        roomId: this.roomId
      });
      this.#emitPlatformStatus({status: 'live', at: this.now(), lastLiveSeenAt: this.now(), source: 'irc'});
      this.#startHeartbeat(this.generation);
      this.#scheduleStatus(this.options.statusIntervalMs);
    }
  }

  #handlePrivmsg(parsed) {
    if (!this.#isCurrentChannel(parsed)) return;
    const draft = mapTwitchPrivmsg(parsed, {receivedAt: this.now()});
    if (!draft) return;
    if (!this.#markSeen(draft.external_id)) return;
    this.counters.privmsg += 1;
    this.#emit(draft);
  }

  #handleUsernotice(parsed) {
    if (!this.#isCurrentChannel(parsed)) return;
    const draft = mapTwitchUsernotice(parsed, {receivedAt: this.now()});
    if (!draft) {
      this.counters.ignored += 1;
      return;
    }
    if (!this.#markSeen(draft.external_id)) return;
    this.counters.usernotice += 1;
    this.#emit(draft);
  }

  #markSeen(id) {
    if (!id) return true;
    if (this.seenIds.has(id)) {
      this.counters.duplicateDropped += 1;
      return false;
    }
    this.seenIds.add(id);
    if (this.seenIds.size > MAX_SEEN_MESSAGE_IDS) {
      // Drop the oldest insertion. Set preserves insertion order.
      const oldest = this.seenIds.values().next().value;
      if (oldest !== undefined) this.seenIds.delete(oldest);
    }
    return true;
  }

  #handleNotice(parsed) {
    const tags = parsed.tags ?? {};
    const msgId = String(tags['msg-id'] ?? '').trim();
    const text = String(parsed.trailing ?? '');
    const code = this.#classifyNotice(msgId, text);
    if (!code) {
      this.logger?.debug?.({event: 'twitch.notice', login: this.login, msgId});
      return;
    }
    this.logger?.warn({event: 'twitch.notice.terminal', login: this.login, msgId, code});
    const error = new TwitchError(code, {
      messageKey: code === TWITCH_ERRORS.RATE_LIMITED ? 'errors.twitchRateLimit' : 'errors.twitchChatUnavailable',
      httpStatus: code === TWITCH_ERRORS.RATE_LIMITED ? 429 : 403,
      details: {msgId}
    });
    if (this.startResolver) {
      this.#failStart(error);
      return;
    }
    if (code === TWITCH_ERRORS.RATE_LIMITED) {
      this.attempt = Math.max(this.attempt, 5);
      try {
        this.socket?.close();
      } catch {
        /* close handler backs off */
      }
      return;
    }
    this.#terminalEnd('chat_disabled', error);
  }

  #classifyNotice(msgId, text) {
    if (msgId === 'msg_login_authentication_failed' || /login authentication failed|improperly formatted auth/i.test(text)) {
      return TWITCH_ERRORS.CHANNEL_UNAVAILABLE;
    }
    if (msgId === 'msg_channel_suspended' || msgId === 'msg_banned' || /suspended|banned from chatting/i.test(text)) {
      return TWITCH_ERRORS.CHANNEL_UNAVAILABLE;
    }
    if (msgId === 'msg_channel_not_found' || /no such channel|unknown channel/i.test(text)) {
      return TWITCH_ERRORS.CHANNEL_NOT_FOUND;
    }
    if (msgId === 'msg_ratelimit' || /rate limit/i.test(text)) {
      return TWITCH_ERRORS.RATE_LIMITED;
    }
    return null;
  }

  #emit(draft) {
    try {
      this.onEvent(draft);
    } catch (error) {
      this.logger?.warn({event: 'twitch.event.failed', code: error?.code ?? 'event'});
    }
  }

  #emitPlatformStatus(info) {
    this.platformStatus = info.status;
    this.lastStatusAt = info.at ?? this.now();
    try {
      this.onPlatformStatus?.(info);
    } catch (error) {
      this.logger?.warn({event: 'twitch.status.callback.failed', code: error?.code ?? 'status'});
    }
  }

  #startHeartbeat(generation) {
    this.#clearHeartbeat();
    const beat = () => {
      if (generation !== this.generation || !this.connected) return;
      this.#send('PING :tmi.twitch.tv');
    };
    beat();
    this.heartbeat = setInterval(beat, this.options.heartbeatMs);
    this.heartbeat.unref?.();
  }

  #clearHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  #armWatchdog(generation) {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      if (generation !== this.generation) return;
      this.logger?.warn({event: 'twitch.watchdog', silenceMs: this.options.watchdogMs});
      try {
        this.socket?.close();
      } catch {
        /* close handler reconnects */
      }
    }, this.options.watchdogMs);
    this.watchdog.unref?.();
  }

  #scheduleReconnect(generation, {reason = 'closed'} = {}) {
    if (!this.started || this.ending || generation !== this.generation) return;
    this.#clearHeartbeat();
    if (this.reconnectTimer) return;
    const exhausted = this.attempt >= this.options.maxReconnectAttempts;
    const delayMs = exhausted
      ? this.options.slowRecoveryMs
      : backoffDelay(this.attempt, this.options.maxBackoffMs);
    this.attempt += 1;
    this.setConnection(exhausted ? CONNECTION_STATE.FAILED : CONNECTION_STATE.RECONNECTING, {
      login: this.login,
      attempt: this.attempt,
      delayMs,
      reason,
      recoverable: true
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.started || this.ending) return;
      if (exhausted) this.attempt = 0;
      this.#connect(this.generation).catch(() => {});
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  #scheduleStatus(delayMs) {
    if (!this.started || this.ending) return;
    if (this.statusTimer) clearTimeout(this.statusTimer);
    const delay = Math.max(0, Number(delayMs) || 0);
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      this.#checkStatus().catch(() => {});
    }, delay);
    this.statusTimer.unref?.();
  }

  async #checkStatus() {
    if (!this.started || this.ending) return;
    if (!this.client) {
      this.#scheduleStatus(this.options.statusIntervalMs);
      return;
    }
    if (this.statusBusy) {
      this.#scheduleStatus(1000);
      return;
    }
    this.statusBusy = true;
    const startedAt = this.now();
    try {
      const channel = await this.client.getChannel(this.login);
      if (!this.started || this.ending) return;
      if (!channel.isLive) {
        this.offlineObservations += 1;
        if (this.offlineObservations >= 2) {
          this.#confirmEnd({source: 'poll', at: this.now()});
          return;
        }
        this.#emitPlatformStatus({
          status: 'ending',
          at: this.now(),
          source: 'poll',
          observedStatus: 'ended'
        });
        this.#scheduleStatus(this.options.offlineConfirmDelayMs);
        return;
      }
      this.statusFailures = 0;
      this.offlineObservations = 0;
      this.viewers = channel.viewers ?? null;
      if (this.streamId && channel.streamId && channel.streamId !== this.streamId) {
        // A new broadcast started while the old capture was still open. Do not
        // merge two broadcasts into one session; the monitor can start a new one.
        this.logger?.info({
          event: 'twitch.stream.restarted',
          login: this.login,
          previousStreamId: this.streamId,
          currentStreamId: channel.streamId
        });
        this.#confirmEnd({source: 'poll', at: this.now(), reason: 'platform_ended'});
        return;
      }
      this.streamId = channel.streamId ?? this.streamId;
      this.#emitPlatformStatus({
        status: 'live',
        at: this.now(),
        lastLiveSeenAt: this.now(),
        source: 'poll'
      });
      this.#scheduleStatus(this.options.statusIntervalMs);
    } catch (error) {
      if (!this.started || this.ending) return;
      this.statusFailures += 1;
      this.lastError = error;
      const retry = error?.code === TWITCH_ERRORS.RATE_LIMITED && Number(error?.retryAfterMs) > 0
        ? Math.min(this.options.maxStatusBackoffMs, Number(error.retryAfterMs))
        : Math.min(
          this.options.maxStatusBackoffMs,
          this.options.statusIntervalMs * 2 ** Math.min(this.statusFailures - 1, 4)
        );
      this.logger?.warn({
        event: 'twitch.status.failed',
        login: this.login,
        code: error?.code ?? 'unknown',
        failures: this.statusFailures,
        nextCheckInMs: retry
      });
      // A failed status read is never evidence that the broadcast ended.
      this.#scheduleStatus(retry);
    } finally {
      this.statusBusy = false;
      if (this.statusTimer === null && this.started && !this.ending) {
        this.#scheduleStatus(this.options.statusIntervalMs);
      }
    }
  }

  #terminalEnd(reason, error = null) {
    if (this.ending) return;
    this.lastError = error;
    this.ending = true;
    this.started = false;
    this.connected = false;
    this.generation += 1;
    this.#clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        /* already closing */
      }
    }
    this.#emitPlatformStatus({
      status: 'ended',
      at: this.now(),
      source: 'irc',
      platformEndedAt: this.now(),
      endQuality: 'event'
    });
    this.setConnection(CONNECTION_STATE.STOPPED, {
      login: this.login,
      reason,
      code: error?.code ?? null
    });
    try {
      this.onEnd?.({reason, platformStatus: 'ended', platformEndedAt: this.now(), endQuality: 'event'});
    } catch (callbackError) {
      this.logger?.warn({event: 'twitch.end.callback.failed', code: callbackError?.code ?? 'end'});
    }
  }

  #confirmEnd({source = 'poll', at = this.now(), reason = 'platform_ended'} = {}) {
    if (this.ending) return;
    this.ending = true;
    this.started = false;
    this.connected = false;
    this.generation += 1;
    this.#clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        /* already closing */
      }
    }
    this.#emitPlatformStatus({
      status: 'ended',
      at,
      source,
      platformEndedAt: at,
      endQuality: 'poll'
    });
    this.setConnection(CONNECTION_STATE.STOPPED, {
      login: this.login,
      reason,
      platformStatus: 'ended',
      platformEndedAt: at,
      endQuality: 'poll'
    });
    try {
      this.onEnd?.({reason, platformStatus: 'ended', platformEndedAt: at, endQuality: 'poll'});
    } catch (error) {
      this.logger?.warn({event: 'twitch.end.callback.failed', code: error?.code ?? 'end'});
    }
  }
}

export const __internal = {DEFAULT_OPTIONS, backoffDelay, MAX_SEEN_MESSAGE_IDS};
