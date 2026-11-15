import {PlatformAdapter, CONNECTION_STATE} from '../shared/adapter.mjs';
import {DOUYIN_ERRORS, DouyinError} from './errors.mjs';
import {GiftComboTracker, METHOD, decodeFrame, decodeMessageBody, mapDouyinMessage} from './messages.mjs';
import {encodeMessage, MESSAGE_SCHEMAS} from './protobuf.mjs';

/**
 * Anonymous Douyin live adapter (public chat, gifts when the platform sends
 * them, room statistics).
 *
 * One adapter owns exactly one room: its WebSocket, heartbeat, watchdog,
 * status poll, reconnect backoff and combo tracker. The SessionManager injects
 * the session id, so two rooms can never cross-write events, and all writes go
 * through EventIngest.
 *
 * Honest boundaries:
 *   - The webcast WebSocket is not a public, stable API. A signature failure or
 *     an unexpected close is reported, never hidden.
 *   - Since 2026 the platform only pushes gift messages to a logged-in session.
 *     Anonymous capture can therefore stay at zero gifts; that is a platform
 *     property, not a parser bug.
 *   - Disconnect is never treated as "the broadcast ended". Only a confirmed
 *     offline page read ends the capture.
 */

const DEFAULT_OPTIONS = Object.freeze({
  connectTimeoutMs: 20000,
  heartbeatMs: 5000,
  watchdogMs: 90000,
  maxBackoffMs: 30000,
  maxReconnectAttempts: 15,
  slowRecoveryMs: 300000,
  statusIntervalMs: 60000,
  statusTimeoutMs: 12000,
  maxStatusBackoffMs: 600000,
  offlineConfirmDelayMs: 15000
});

const MAX_SEEN_MESSAGE_IDS = 10000;

const HEARTBEAT_FRAME = encodeMessage(
  {payloadType: 'hb'},
  {7: {name: 'payloadType', type: 'string'}}
);

function backoffDelay(attempt, maxMs) {
  return Math.min(maxMs, 1000 * 2 ** Math.min(Math.max(0, attempt), 5));
}

export class DouyinLiveAdapter extends PlatformAdapter {
  constructor({
    webRid,
    roomId = null,
    room = null,
    client,
    WebSocketImpl = globalThis.WebSocket,
    logger = null,
    now = Date.now,
    cookie = '',
    ...options
  } = {}) {
    super({
      id: 'douyin',
      platform: 'douyin',
      label: 'Douyin Live',
      capabilities: ['chat', 'gift', 'viewer_identity', 'room_stats']
    });
    this.webRid = String(webRid ?? '').trim();
    this.roomId = roomId === null || roomId === undefined ? null : String(roomId);
    this.room = room && typeof room === 'object' ? {...room} : null;
    this.client = client;
    this.WebSocketImpl = WebSocketImpl;
    this.logger = logger;
    this.now = now;
    this.cookie = String(cookie ?? '');
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
    this.lastFrameAt = null;
    this.lastStatusAt = null;
    this.platformStatus = null;
    this.online = null;
    this.onEvent = () => {};
    this.onEnd = () => {};
    this.onPlatformStatus = () => {};
    this.seenIds = new Set();
    this.counters = {
      chat: 0,
      giftFinal: 0,
      giftPending: 0,
      giftDropped: 0,
      member: 0,
      like: 0,
      follow: 0,
      stats: 0,
      ignored: 0,
      duplicateDropped: 0,
      unknown: 0,
      frames: 0
    };
    this.combo = new GiftComboTracker({now});
    this.lastError = null;
  }

  setConnection(state, detail = null) {
    if (this.state !== state) this.setState(state, detail);
    else this.detail = detail;
  }

  async start({onEvent = () => {}, onStateChange = null, onEnd = null, onPlatformStatus = null} = {}) {
    if (!this.webRid) {
      throw new DouyinError(DOUYIN_ERRORS.LINK_INVALID, {
        messageKey: 'errors.douyinLinkInvalid',
        httpStatus: 400
      });
    }
    if (typeof this.WebSocketImpl !== 'function') {
      throw new DouyinError(DOUYIN_ERRORS.WEBSOCKET_UNAVAILABLE, {
        messageKey: 'errors.douyinWebSocketUnavailable',
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
    this.combo.clear();
    this.counters = {
      chat: 0,
      giftFinal: 0,
      giftPending: 0,
      giftDropped: 0,
      member: 0,
      like: 0,
      follow: 0,
      stats: 0,
      ignored: 0,
      duplicateDropped: 0,
      unknown: 0,
      frames: 0
    };
    this.lastError = null;
    this.setConnection(CONNECTION_STATE.CONNECTING, {webRid: this.webRid, attempt: 0});

    const room = this.room ?? await this.client.fetchRoom(this.webRid);
    this.room = room;
    this.roomId = this.roomId ?? String(room.roomId ?? '');
    if (!room.isLive) {
      this.started = false;
      this.ending = true;
      throw new DouyinError(
        room.ended ? DOUYIN_ERRORS.ROOM_ENDED : DOUYIN_ERRORS.ROOM_OFFLINE,
        {
          messageKey: room.ended ? 'errors.douyinRoomEnded' : 'errors.douyinRoomOffline',
          httpStatus: 409,
          details: {webRid: this.webRid, status: room.status}
        }
      );
    }

    await new Promise((resolve, reject) => {
      this.startResolver = {resolve, reject};
      this.#connect(this.generation).catch((error) => this.#failStart(error));
      const timer = setTimeout(() => {
        this.#failStart(new DouyinError(DOUYIN_ERRORS.CONNECT_TIMEOUT, {
          messageKey: 'errors.douyinConnectTimeout',
          httpStatus: 504,
          details: {webRid: this.webRid}
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
    const dropped = this.combo.clear();
    this.counters.giftDropped += dropped.dropped;
    if (this.startResolver) {
      const {reject} = this.startResolver;
      this.startResolver = null;
      reject(new DouyinError(DOUYIN_ERRORS.STOPPED, {
        messageKey: 'errors.douyinStopped',
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
    this.setConnection(CONNECTION_STATE.STOPPED, {webRid: this.webRid});
  }

  snapshot() {
    return {
      ...super.snapshot(),
      detail: {
        ...(this.detail ?? {}),
        webRid: this.webRid,
        roomId: this.roomId,
        title: this.room?.title ?? null,
        online: this.online,
        attempt: this.attempt,
        platformStatus: this.platformStatus,
        platformStatusAt: this.lastStatusAt,
        offlineObservations: this.offlineObservations,
        counters: {...this.counters},
        combo: this.combo.snapshot()
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
      error?.code === DOUYIN_ERRORS.BLOCKED ? CONNECTION_STATE.AUTH_REQUIRED : CONNECTION_STATE.FAILED,
      {webRid: this.webRid, code: error?.code ?? 'unknown'}
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
      webRid: this.webRid,
      attempt: this.attempt
    });
    let target;
    try {
      if (!this.roomId) {
        this.room = this.room ?? await this.client.fetchRoom(this.webRid);
        this.roomId = String(this.room.roomId ?? '');
      }
      target = this.client.buildWebSocketUrl({
        roomId: this.roomId,
        userUniqueId: this.roomId,
        cookie: this.cookie || this.client.cookieHeader()
      });
    } catch (error) {
      this.lastError = error;
      if (this.startResolver) {
        this.#failStart(error);
      } else {
        this.#scheduleReconnect(generation, {reason: 'signature'});
      }
      return;
    }

    let socket;
    try {
      socket = new this.WebSocketImpl(target.url, {headers: target.headers});
    } catch (error) {
      this.lastError = error;
      if (this.startResolver) {
        this.#failStart(new DouyinError(DOUYIN_ERRORS.NETWORK, {
          messageKey: 'errors.douyinNetwork',
          httpStatus: 502,
          cause: error
        }));
      } else {
        this.#scheduleReconnect(generation, {reason: 'socket_create'});
      }
      return;
    }
    this.socket = socket;

    try {
      socket.addEventListener('open', () => {
        if (generation !== this.generation) return;
        this.logger?.info({event: 'douyin.socket.open', webRid: this.webRid, roomId: this.roomId, attempt: this.attempt});
        this.connected = true;
        this.hasConnected = true;
        this.attempt = 0;
        this.setConnection(CONNECTION_STATE.CONNECTED, {
          webRid: this.webRid,
          roomId: this.roomId,
          title: this.room?.title ?? null
        });
        this.#emitPlatformStatus({status: 'live', at: this.now(), lastLiveSeenAt: this.now(), source: 'ws'});
        this.#startHeartbeat(generation);
        this.#armWatchdog(generation);
        this.#scheduleStatus(this.options.statusIntervalMs);
        this.#resolveStart();
      });
      socket.addEventListener('message', (event) => {
        if (generation !== this.generation) return;
        this.#handleFrame(event?.data, generation)
          .catch((error) => this.logger?.warn({event: 'douyin.frame.failed', code: error?.code ?? 'frame'}));
      });
      socket.addEventListener('error', () => {
        if (generation === this.generation) this.logger?.warn({event: 'douyin.socket.error', webRid: this.webRid});
      });
      socket.addEventListener('close', (event) => {
        if (generation !== this.generation) return;
        this.connected = false;
        this.#clearHeartbeat();
        if (this.started && !this.ending) {
          this.logger?.warn({
            event: 'douyin.socket.closed',
            webRid: this.webRid,
            code: event?.code ?? null,
            attempt: this.attempt
          });
          this.#scheduleReconnect(generation, {reason: 'closed'});
        }
      });
    } catch (error) {
      this.#scheduleReconnect(generation, {reason: 'listener'});
    }
  }

  async #handleFrame(data, generation) {
    if (data === undefined || data === null) return;
    let buffer;
    if (Buffer.isBuffer(data)) buffer = data;
    else if (data instanceof ArrayBuffer) buffer = Buffer.from(data);
    else if (ArrayBuffer.isView(data)) buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    else if (typeof data.arrayBuffer === 'function') buffer = Buffer.from(await data.arrayBuffer());
    else if (typeof data.text === 'function') buffer = Buffer.from(await data.text(), 'utf8');
    else return;

    this.lastFrameAt = this.now();
    this.#armWatchdog(generation);
    let frame;
    try {
      frame = decodeFrame(buffer);
    } catch (error) {
      this.counters.unknown += 1;
      this.logger?.warn({event: 'douyin.frame.invalid', code: error?.code ?? 'protocol'});
      return;
    }
    this.counters.frames += 1;
    if (frame.needAck && frame.internalExt) this.#sendAck(frame);
    for (const message of frame.messages) {
      if (generation !== this.generation) return;
      this.#handleMessage(message);
    }
  }

  #sendAck(frame) {
    try {
      const payload = encodeMessage(
        {logId: frame.logId || undefined, payloadType: 'ack', payload: Buffer.from(frame.internalExt, 'utf8')},
        MESSAGE_SCHEMAS.PushFrame
      );
      this.socket?.send(payload);
    } catch (error) {
      this.logger?.warn({event: 'douyin.ack.failed', code: error?.code ?? 'ack'});
    }
  }

  #handleMessage(message) {
    if (message.msgId) {
      if (this.seenIds.has(message.msgId)) {
        this.counters.duplicateDropped += 1;
        return;
      }
      this.seenIds.add(message.msgId);
      if (this.seenIds.size > MAX_SEEN_MESSAGE_IDS) {
        const oldest = this.seenIds.values().next().value;
        if (oldest !== undefined) this.seenIds.delete(oldest);
      }
    }
    let body;
    try {
      body = decodeMessageBody(message.method, message.payload);
    } catch (error) {
      this.counters.unknown += 1;
      this.logger?.warn({event: 'douyin.body.invalid', method: message.method, code: error?.code ?? 'protocol'});
      return;
    }
    if (!body) {
      this.counters.ignored += 1;
      return;
    }
    const receivedAt = this.now();
    if (message.method === METHOD.GIFT) {
      // A combo is collapsed into one final event; intermediate steps are
      // counted but never written as separate gifts.
      this.ingestGift(body, {msgId: message.msgId});
      return;
    }
    const mapped = mapDouyinMessage({
      method: message.method,
      msgId: message.msgId,
      body,
      receivedAt,
      roomId: this.roomId
    });
    switch (mapped.kind) {
      case 'chat':
        this.counters.chat += 1;
        this.#emit(mapped.draft);
        return;
      case 'stats':
        this.counters.stats += 1;
        if (mapped.online !== null && mapped.online !== undefined) this.online = mapped.online;
        return;
      case 'member':
        this.counters.member += 1;
        return;
      case 'like':
        this.counters.like += 1;
        return;
      case 'follow':
        this.counters.follow += 1;
        return;
      case 'ignored':
        this.counters.ignored += 1;
        return;
      default:
        this.counters.unknown += 1;
    }
  }

  /**
   * Gift messages are handled outside `mapDouyinMessage` because a combo must
   * be collapsed into one final event.
   */
  ingestGift(body, {msgId = ''} = {}) {
    const receivedAt = this.now();
    const result = this.combo.ingest(body, {receivedAt, msgId});
    if (result.pending) {
      this.counters.giftPending += 1;
      return null;
    }
    if (!result.draft) return null;
    this.counters.giftFinal += 1;
    this.#emit(result.draft);
    return result.draft;
  }

  #emit(draft) {
    if (!draft) return;
    try {
      this.onEvent(draft);
    } catch (error) {
      this.logger?.warn({event: 'douyin.event.failed', code: error?.code ?? 'event'});
    }
  }

  #emitPlatformStatus(info) {
    this.platformStatus = info.status;
    this.lastStatusAt = info.at ?? this.now();
    try {
      this.onPlatformStatus?.(info);
    } catch (error) {
      this.logger?.warn({event: 'douyin.status.callback.failed', code: error?.code ?? 'status'});
    }
  }

  #startHeartbeat(generation) {
    this.#clearHeartbeat();
    const beat = () => {
      if (generation !== this.generation || !this.connected) return;
      try {
        this.socket?.send(HEARTBEAT_FRAME);
      } catch (error) {
        this.logger?.warn({event: 'douyin.heartbeat.failed', code: error?.code ?? 'heartbeat'});
      }
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
      this.logger?.warn({event: 'douyin.watchdog', webRid: this.webRid, silenceMs: this.options.watchdogMs});
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
      webRid: this.webRid,
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
    try {
      const room = await this.client.checkRoom(this.webRid);
      if (!this.started || this.ending) return;
      if (!room.isLive) {
        this.offlineObservations += 1;
        if (this.offlineObservations >= 2) {
          this.#confirmEnd({source: 'poll', at: this.now(), status: room.status});
          return;
        }
        this.#emitPlatformStatus({status: 'ending', at: this.now(), source: 'poll', observedStatus: 'ended'});
        this.#scheduleStatus(this.options.offlineConfirmDelayMs);
        return;
      }
      this.statusFailures = 0;
      this.offlineObservations = 0;
      if (room.userCount) this.online = this.online ?? null;
      this.#emitPlatformStatus({status: 'live', at: this.now(), lastLiveSeenAt: this.now(), source: 'poll'});
      this.#scheduleStatus(this.options.statusIntervalMs);
    } catch (error) {
      if (!this.started || this.ending) return;
      this.statusFailures += 1;
      this.lastError = error;
      const retry = error?.code === DOUYIN_ERRORS.RATE_LIMITED && Number(error?.retryAfterMs) > 0
        ? Math.min(this.options.maxStatusBackoffMs, Number(error.retryAfterMs))
        : Math.min(
          this.options.maxStatusBackoffMs,
          this.options.statusIntervalMs * 2 ** Math.min(this.statusFailures - 1, 4)
        );
      this.logger?.warn({
        event: 'douyin.status.failed',
        webRid: this.webRid,
        code: error?.code ?? 'unknown',
        failures: this.statusFailures,
        nextCheckInMs: retry
      });
      // A failed page read is never evidence that the broadcast ended.
      this.#scheduleStatus(retry);
    } finally {
      this.statusBusy = false;
      if (this.statusTimer === null && this.started && !this.ending) {
        this.#scheduleStatus(this.options.statusIntervalMs);
      }
    }
  }

  #confirmEnd({source = 'poll', at = this.now(), status = null} = {}) {
    if (this.ending) return;
    this.ending = true;
    this.started = false;
    this.connected = false;
    this.generation += 1;
    this.#clearTimers();
    const dropped = this.combo.clear();
    this.counters.giftDropped += dropped.dropped;
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
      webRid: this.webRid,
      reason: 'platform_ended',
      platformStatus: 'ended',
      platformEndedAt: at,
      endQuality: 'poll',
      roomStatus: status
    });
    try {
      this.onEnd?.({reason: 'platform_ended', platformStatus: 'ended', platformEndedAt: at, endQuality: 'poll'});
    } catch (error) {
      this.logger?.warn({event: 'douyin.end.callback.failed', code: error?.code ?? 'end'});
    }
  }
}

export const __internal = {DEFAULT_OPTIONS, backoffDelay, MAX_SEEN_MESSAGE_IDS, HEARTBEAT_FRAME};
