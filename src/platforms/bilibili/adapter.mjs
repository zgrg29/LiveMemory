import {PlatformAdapter, CONNECTION_STATE} from '../shared/adapter.mjs';
import {BilibiliApi, BilibiliError} from './api.mjs';
import {decodePackets, encodeAuth, encodeHeartbeat, normalizeCommand, OP} from './protocol.mjs';
import {IGNORED_COMMANDS, mapBilibiliMessage} from './mapper.mjs';
import {
  PLATFORM_END_QUALITY,
  PLATFORM_STATUS,
  platformStatusFromLiveStatus
} from '../../shared/live-status.mjs';

/**
 * Bilibili live adapter.
 *
 * Transport only: it resolves the room, gets a signed `getDanmuInfo`, keeps a
 * WebSocket alive (30 s heartbeat, 65 s watchdog), reconnects with exponential
 * backoff and converts packets to canonical event drafts. Persistence, dedupe
 * and viewer aggregation stay in EventIngest.
 *
 * A connected Bilibili WebSocket is NOT proof that the streamer is live: the
 * server keeps the socket open after a broadcast ends and an offline room can
 * still carry occasional chat. This adapter therefore maintains a separate
 * platform-live state from two independent signals:
 *
 *   1. WebSocket commands `LIVE` and `PREPARING`/`STOP_LIVE` for this room;
 *   2. a periodic `room/v1/Room/get_info` query of `live_status`.
 *
 * A WebSocket end signal triggers an immediate status query. Two consecutive
 * valid non-live results (or one end signal plus one valid non-live result)
 * confirm the end. Timeouts, 429/risk control and malformed responses never
 * count as an end; they only back off. The platform status is sent through
 * `onPlatformStatus` so the session row can record it separately from the
 * local capture status.
 *
 * The platform connection is anonymous by default. A logged-in cookie is only
 * used for the HTTP requests that need it; no cookie ever reaches the console or
 * the log.
 */

const DEFAULT_OPTIONS = Object.freeze({
  heartbeatMs: 30000,
  watchdogMs: 65000,
  maxBackoffMs: 30000,
  connectTimeoutMs: 15000,
  maxHosts: 3,
  liveStatusIntervalMs: 60000,
  offlineConfirmDelayMs: 15000,
  statusTimeoutMs: 8000,
  maxStatusBackoffMs: 300000,
  maxStatusEventRetryMs: 120000,
  // After a LIVE WebSocket event, ignore a stale offline answer for a short
  // grace period. A PREPARING event bypasses this because it is newer evidence.
  liveSignalGraceMs: 30000
});

export class BilibiliLiveAdapter extends PlatformAdapter {
  constructor({
    roomId,
    cookie = '',
    api = null,
    WebSocketImpl = globalThis.WebSocket,
    logger = null,
    now = Date.now,
    ...options
  } = {}) {
    super({id: 'bilibili', platform: 'bilibili', label: 'Bilibili Live', capabilities: ['chat', 'gift', 'super_chat', 'guard']});
    this.roomId = Number(roomId);
    this.api = api ?? new BilibiliApi({cookie, now});
    this.WebSocketImpl = WebSocketImpl;
    this.logger = logger;
    this.now = now;
    this.options = {...DEFAULT_OPTIONS, ...options};
    this.ws = null;
    this.generation = 0;
    this.attempt = 0;
    this.heartbeat = null;
    this.watchdog = null;
    this.retry = null;
    this.startTimer = null;
    this.liveStatusTimer = null;
    this.popularity = null;
    this.room = null;
    this.connected = false;
    this.hasConnected = false;
    this.started = false;
    this.lastError = null;
    this.onEvent = () => {};
    this.onEnd = () => {};
    this.onPlatformStatus = () => {};
    this.startResolver = null;

    /** Platform state, never inferred from the socket or from message volume. */
    this.platformStatus = null;
    this.lastStatusAt = null;
    this.lastLiveSeenAt = null;
    this.hasBeenLive = false;
    this.liveKey = null;
    /** Platform `live_time` (epoch seconds) of the broadcast we are recording. */
    this.liveStartedAt = null;
    this.statusBusy = false;
    this.statusFailures = 0;
    this.offlineObservations = 0;
    /** A WebSocket end event awaiting independent confirmation. */
    this.pendingEnd = null;
    /** Set once an end is being committed; no further callbacks may revive it. */
    this.ending = false;
    this.lastLiveSignalAt = 0;
  }

  setConnection(state, detail = null) {
    if (this.state !== state) this.setState(state, detail);
    else this.detail = detail;
  }

  async start({
    onEvent = () => {},
    onStateChange = null,
    onEnd = null,
    onPlatformStatus = null
  } = {}) {
    if (!Number.isInteger(this.roomId) || this.roomId <= 0) {
      throw new BilibiliError('ROOM_INVALID', 'a numeric live room id is required');
    }
    if (typeof this.WebSocketImpl !== 'function') {
      throw new BilibiliError('WEBSOCKET_UNAVAILABLE', 'this runtime has no WebSocket implementation');
    }
    this.onEvent = onEvent;
    this.onStateChange = onStateChange;
    this.onEnd = onEnd ?? (() => {});
    this.onPlatformStatus = onPlatformStatus ?? (() => {});
    this.#clearTimers();
    this.started = true;
    this.ending = false;
    this.hasConnected = false;
    this.generation += 1;
    this.attempt = 0;
    this.statusFailures = 0;
    this.offlineObservations = 0;
    this.pendingEnd = null;
    this.platformStatus = null;
    this.lastStatusAt = null;
    this.lastLiveSeenAt = null;
    this.liveKey = null;
    this.liveStartedAt = null;
    this.lastLiveSignalAt = 0;
    this.setConnection(CONNECTION_STATE.CONNECTING, {roomId: this.roomId});
    await new Promise((resolve, reject) => {
      this.startResolver = {resolve, reject};
      this.#connect(this.generation).catch((error) => this.#failStart(error, reject));
      const timer = setTimeout(() => {
        const error = new BilibiliError('CONNECT_TIMEOUT', 'the live room did not answer in time');
        this.#failStart(error, reject);
      }, this.options.connectTimeoutMs);
      timer.unref?.();
      this.startTimer = timer;
    });
  }

  async stop() {
    this.started = false;
    this.ending = true;
    this.generation += 1;
    this.connected = false;
    this.#clearTimers();
    if (this.startResolver) {
      this.startResolver.reject(new BilibiliError('STOPPED', 'connection was stopped'));
      this.startResolver = null;
    }
    const socket = this.ws;
    this.ws = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        /* already closing */
      }
    }
    this.setConnection(CONNECTION_STATE.STOPPED);
  }

  snapshot() {
    return {
      ...super.snapshot(),
      detail: {
        ...(this.detail ?? {}),
        roomId: this.roomId,
        realRoomId: this.room?.roomId ?? null,
        popularity: this.popularity,
        attempt: this.attempt,
        loggedIn: Boolean(this.api?.loggedIn),
        platformStatus: this.platformStatus,
        platformStatusAt: this.lastStatusAt,
        lastLiveSeenAt: this.lastLiveSeenAt,
        liveKey: this.liveKey,
        statusFailures: this.statusFailures,
        pendingEnd: this.pendingEnd ? {source: this.pendingEnd.source, at: this.pendingEnd.at} : null
      }
    };
  }

  #clearTimers() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.watchdog) clearTimeout(this.watchdog);
    if (this.retry) clearTimeout(this.retry);
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.liveStatusTimer) clearTimeout(this.liveStatusTimer);
    this.heartbeat = null;
    this.watchdog = null;
    this.retry = null;
    this.startTimer = null;
    this.liveStatusTimer = null;
  }

  #failStart(error, reject) {
    this.lastError = error;
    if (this.startResolver) {
      const {reject: startReject} = this.startResolver;
      this.startResolver = null;
      startReject(error);
    }
    reject?.(error);
  }

  async #connect(generation) {
    if (generation !== this.generation || !this.started) return;
    this.setConnection(this.attempt > 0 ? CONNECTION_STATE.RECONNECTING : CONNECTION_STATE.CONNECTING, {
      roomId: this.roomId,
      attempt: this.attempt
    });
    let room;
    let info;
    let user = null;
    try {
      room = await this.api.roomInit(this.roomId);
      // A reconnect that reports a different platform `live_time` means the
      // streamer ended and started a new broadcast while we were offline. The
      // old capture must end here; the user starts a new session for the new
      // broadcast instead of mixing two broadcasts into one row.
      const reconnectedLiveTime = Number(room.liveTime);
      if (this.hasConnected
        && this.liveStartedAt !== null
        && Number.isFinite(reconnectedLiveTime)
        && reconnectedLiveTime > 0
        && reconnectedLiveTime !== this.liveStartedAt
        && platformStatusFromLiveStatus(room.liveStatus) === PLATFORM_STATUS.LIVE) {
        this.logger?.info({
          event: 'bilibili.stream.restarted',
          roomId: room.roomId,
          previousLiveTime: this.liveStartedAt,
          currentLiveTime: reconnectedLiveTime
        });
        this.#confirmEnd({
          status: PLATFORM_STATUS.ENDED,
          at: this.now(),
          source: 'reconnect',
          quality: PLATFORM_END_QUALITY.EVENT
        });
        return;
      }
      // The service already checks this before creating a session; the second
      // check closes the race where the stream ends between validation and
      // connection. A carousel room is not a live broadcast either.
      if (!this.hasConnected && platformStatusFromLiveStatus(room.liveStatus) !== PLATFORM_STATUS.LIVE) {
        const carousel = platformStatusFromLiveStatus(room.liveStatus) === PLATFORM_STATUS.CAROUSEL;
        throw new BilibiliError(carousel ? 'ROOM_ROUND' : 'ROOM_NOT_LIVE', carousel
          ? 'the room is in carousel/replay, not a live broadcast'
          : 'the room is not currently live');
      }
      info = await this.api.danmuInfo(room.roomId);
      try {
        user = await this.api.navUser();
      } catch {
        user = null; // login is optional; the stream is readable anonymously
      }
      this.room = room;
    } catch (error) {
      this.lastError = error;
      const terminalStart = !this.hasConnected && ['ROOM_NOT_LIVE', 'ROOM_ROUND'].includes(error?.code);
      this.setConnection(
        error?.code === 'AUTH'
          ? CONNECTION_STATE.AUTH_REQUIRED
          : (terminalStart ? CONNECTION_STATE.FAILED : CONNECTION_STATE.RECONNECTING),
        {
          roomId: this.roomId,
          attempt: this.attempt,
          code: error?.code ?? 'unknown'
        }
      );
      this.logger?.warn({event: 'bilibili.connect.failed', code: error?.code ?? 'unknown', biliCode: error?.biliCode ?? null});
      if ((terminalStart || generation !== this.generation) && this.startResolver) {
        this.#failStart(error);
        return;
      }
      if (terminalStart) return;
      this.#schedule(generation);
      return;
    }
    if (generation !== this.generation) return;

    const host = info.hosts[Math.min(this.attempt, Math.min(info.hosts.length, this.options.maxHosts) - 1)] ?? info.hosts[0];
    const url = `wss://${host.host}:${host.port}/sub`;
    this.logger?.info({event: 'bilibili.connecting', roomId: room.roomId, host: host.host, port: host.port});

    let ws;
    try {
      ws = new this.WebSocketImpl(url);
    } catch (error) {
      this.#schedule(generation);
      this.logger?.warn({event: 'bilibili.socket.failed', code: error?.code ?? 'unknown'});
      if (this.startResolver) this.#failStart(error);
      return;
    }
    this.ws = ws;
    try {
      ws.binaryType = 'arraybuffer';
      ws.addEventListener('open', () => {
        if (generation !== this.generation) return;
        try {
          ws.send(encodeAuth({
            roomId: room.roomId,
            uid: user?.uid ?? 0,
            token: info.token,
            buvid: this.api.buvid
          }));
        } catch (error) {
          this.logger?.warn({event: 'bilibili.auth.send.failed', code: error?.code ?? 'unknown'});
        }
      });
      ws.addEventListener('message', (event) => {
        if (generation !== this.generation) return;
        this.#armWatchdog(generation);
        this.#handleData(event?.data, generation).catch((error) => {
          this.logger?.warn({event: 'bilibili.frame.failed', code: error?.code ?? 'protocol'});
        });
      });
      ws.addEventListener('error', () => {
        if (generation === this.generation) this.logger?.warn({event: 'bilibili.socket.error'});
      });
      ws.addEventListener('close', () => {
        if (generation !== this.generation) return;
        this.connected = false;
        this.#clearHeartbeat();
        if (this.started && !this.ending) {
          this.#schedule(generation);
        }
      });
    } catch (error) {
      this.#schedule(generation);
      if (this.startResolver) this.#failStart(error);
    }
  }

  #schedule(generation) {
    if (!this.started || this.ending || generation !== this.generation) return;
    this.#clearHeartbeat();
    const delay = Math.min(this.options.maxBackoffMs, 1000 * 2 ** Math.min(this.attempt, 5));
    this.attempt += 1;
    this.setConnection(this.attempt > 1 ? CONNECTION_STATE.RECONNECTING : CONNECTION_STATE.CONNECTING, {
      roomId: this.roomId,
      attempt: this.attempt,
      delayMs: delay
    });
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => {
      this.retry = null;
      this.#connect(generation).catch(() => {});
    }, delay);
    this.retry.unref?.();
  }

  #armWatchdog(generation) {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      this.logger?.warn({event: 'bilibili.watchdog', silenceMs: this.options.watchdogMs});
      try {
        this.ws?.close();
      } catch {
        /* ignore */
      }
    }, this.options.watchdogMs);
    this.watchdog.unref?.();
    if (generation !== this.generation) clearTimeout(this.watchdog);
  }

  #clearHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  #startHeartbeat(generation) {
    this.#clearHeartbeat();
    const beat = () => {
      if (generation !== this.generation || !this.ws) return;
      try {
        this.ws.send(encodeHeartbeat());
      } catch {
        /* the close handler will reconnect */
      }
    };
    beat();
    this.heartbeat = setInterval(beat, this.options.heartbeatMs);
    this.heartbeat.unref?.();
  }

  /* ------------------------------------------------------- platform status */

  #emitPlatformStatus(info) {
    this.platformStatus = info.status;
    this.lastStatusAt = info.at ?? this.now();
    if (Number.isFinite(Number(info.lastLiveSeenAt))) {
      const seen = Number(info.lastLiveSeenAt);
      if (this.lastLiveSeenAt === null || this.lastLiveSeenAt < seen) this.lastLiveSeenAt = seen;
    }
    try {
      this.onPlatformStatus?.(info);
    } catch (error) {
      this.logger?.warn({event: 'bilibili.status.callback.failed', code: error?.code ?? 'unknown'});
    }
  }

  /**
   * Turn one valid `live_status` observation into platform state.
   * Returns the outcome without scheduling the next timer.
   */
  #observeStatus(liveStatus, {source, at, strong = false}) {
    if (this.ending || !this.started) return {kind: 'ignored'};
    const mapped = platformStatusFromLiveStatus(liveStatus);
    if (mapped === PLATFORM_STATUS.LIVE) {
      this.statusFailures = 0;
      this.offlineObservations = 0;
      this.pendingEnd = null;
      this.hasBeenLive = true;
      this.lastLiveSeenAt = this.lastLiveSeenAt === null ? at : Math.max(this.lastLiveSeenAt, at);
      this.#emitPlatformStatus({
        status: PLATFORM_STATUS.LIVE,
        at,
        lastLiveSeenAt: this.lastLiveSeenAt,
        source
      });
      return {kind: 'live', status: PLATFORM_STATUS.LIVE};
    }
    if (mapped === PLATFORM_STATUS.NOT_STARTED || mapped === PLATFORM_STATUS.CAROUSEL) {
      this.offlineObservations += 1;
      const finalStatus = mapped === PLATFORM_STATUS.CAROUSEL
        ? PLATFORM_STATUS.CAROUSEL
        : (this.hasBeenLive ? PLATFORM_STATUS.ENDED : PLATFORM_STATUS.NOT_STARTED);
      const canConfirm = this.offlineObservations >= 2
        || (strong && this.offlineObservations >= 1)
        || (Boolean(this.pendingEnd) && this.offlineObservations >= 1);
      if (!canConfirm) {
        // Do not claim an end yet. The UI can show "confirming" while capture
        // continues; the real end is written only after confirmation.
        this.#emitPlatformStatus({
          status: PLATFORM_STATUS.ENDING,
          at,
          source,
          observedStatus: finalStatus
        });
        return {kind: 'offline', status: finalStatus, confirm: false};
      }
      const quality = this.pendingEnd ? PLATFORM_END_QUALITY.EVENT : PLATFORM_END_QUALITY.POLL;
      const endSource = this.pendingEnd?.source ?? source;
      this.#confirmEnd({status: finalStatus, at, source: endSource, quality});
      return {kind: 'ended', status: finalStatus, confirm: true};
    }
    // Unknown numeric value: not an offline signal.
    return {kind: 'unknown'};
  }

  #statusRetryDelay() {
    const failures = Math.max(1, this.statusFailures);
    if (this.pendingEnd) {
      return Math.min(this.options.maxStatusEventRetryMs, 10000 * 2 ** Math.min(failures - 1, 4));
    }
    return Math.min(
      this.options.maxStatusBackoffMs,
      this.options.liveStatusIntervalMs * 2 ** Math.min(failures - 1, 4)
    );
  }

  #scheduleStatusCheck(delayMs) {
    if (!this.started || this.ending) return;
    if (this.liveStatusTimer) clearTimeout(this.liveStatusTimer);
    const delay = Math.max(0, Number(delayMs) || 0);
    this.liveStatusTimer = setTimeout(() => {
      this.liveStatusTimer = null;
      this.#checkLiveStatus({reason: this.pendingEnd ? 'websocket_confirm' : 'poll'}).catch(() => {});
    }, delay);
    this.liveStatusTimer.unref?.();
  }

  #startMonitoring({initialLiveStatus, source}) {
    if (!this.started || this.ending) return;
    this.statusFailures = 0;
    // Preserve offline observations across a reconnect: a flapping socket must
    // not reset the confirmation count and keep an offline room "live" forever.
    // A live observation resets the count in #observeStatus.
    this.pendingEnd = null;
    const outcome = this.#observeStatus(initialLiveStatus, {source, at: this.now()});
    if (this.ending) return;
    if (outcome.kind === 'offline') this.#scheduleStatusCheck(this.options.offlineConfirmDelayMs);
    else this.#scheduleStatusCheck(this.options.liveStatusIntervalMs);
  }

  async #checkLiveStatus({reason = 'poll', strong = false} = {}) {
    if (!this.started || this.ending) return;
    if (this.statusBusy) {
      // An end signal arrived while a query is in flight. Re-check after it
      // settles instead of dropping the signal.
      this.#scheduleStatusCheck(1000);
      return;
    }
    this.statusBusy = true;
    const startedAt = this.now();
    const expectedRoom = this.room?.roomId ?? this.roomId;
    try {
      const result = await this.api.roomStatus(expectedRoom, {timeoutMs: this.options.statusTimeoutMs});
      if (!this.started || this.ending) return;
      if (Number(result.roomId) !== Number(expectedRoom)) {
        throw new BilibiliError('STATUS_ROOM_MISMATCH', 'status query returned another room');
      }
      this.statusFailures = 0;
      // Ordering guard: a newer LIVE/PREPARING WebSocket signal must not be
      // overwritten by a query that started before it.
      if (result.liveStatus === 1 && this.pendingEnd && this.pendingEnd.at > startedAt) {
        this.#scheduleStatusCheck(1000);
        return;
      }
      if (result.liveStatus !== 1 && this.lastLiveSignalAt > startedAt) {
        this.#scheduleStatusCheck(1000);
        return;
      }
      if (result.liveStatus !== 1
        && !this.pendingEnd
        && this.lastLiveSignalAt > startedAt - this.options.liveSignalGraceMs) {
        this.#scheduleStatusCheck(Math.min(this.options.liveStatusIntervalMs, 30000));
        return;
      }
      const outcome = this.#observeStatus(result.liveStatus, {
        source: reason === 'websocket' || reason === 'websocket_confirm' ? 'websocket' : 'poll',
        at: this.now(),
        strong: strong || Boolean(this.pendingEnd)
      });
      if (this.ending) return;
      if (outcome.kind === 'offline') this.#scheduleStatusCheck(this.options.offlineConfirmDelayMs);
      else this.#scheduleStatusCheck(this.options.liveStatusIntervalMs);
    } catch (error) {
      if (!this.started || this.ending) return;
      this.statusFailures += 1;
      this.lastError = error;
      this.logger?.warn({
        event: 'bilibili.status.failed',
        code: error?.code ?? 'unknown',
        httpStatus: error?.status ?? null,
        biliCode: error?.biliCode ?? null,
        failures: this.statusFailures
      });
      // Failure/timeout/429/risk control is never an end. Back off and retry.
      this.#scheduleStatusCheck(this.#statusRetryDelay());
    } finally {
      this.statusBusy = false;
    }
  }

  #isCurrentRoom(event) {
    const raw = event?.roomid ?? event?.data?.roomid ?? null;
    if (raw === null || raw === undefined || raw === '') return true;
    const room = Number(raw);
    if (!Number.isFinite(room) || room <= 0) return false;
    return room === Number(this.room?.roomId ?? this.roomId);
  }

  #handleLiveEvent(event, generation) {
    if (this.ending || !this.started || generation !== this.generation) return;
    if (!this.#isCurrentRoom(event)) return;
    const at = this.now();
    const incomingKey = event?.live_key ?? event?.data?.live_key ?? null;
    const incomingTime = Number(event?.live_time ?? event?.data?.live_time);
    const hasIncomingTime = Number.isFinite(incomingTime) && incomingTime > 0;
    // A PREPARING followed by a LIVE for a different `live_key`/`live_time` is
    // a short off-air + restart. Do not merge the new broadcast into the old
    // session: end the old one and require a new capture.
    if (this.pendingEnd) {
      const differentKey = Boolean(incomingKey && this.liveKey && incomingKey !== this.liveKey);
      const differentTime = Boolean(hasIncomingTime && this.liveStartedAt && incomingTime !== this.liveStartedAt);
      const noIdentifyingField = !incomingKey && !hasIncomingTime;
      if (differentKey || differentTime || noIdentifyingField) {
        this.logger?.info({
          event: 'bilibili.stream.restarted',
          roomId: this.room?.roomId ?? this.roomId,
          source: 'websocket',
          previousLiveKey: this.liveKey,
          currentLiveKey: incomingKey
        });
        this.#confirmEnd({
          status: PLATFORM_STATUS.ENDED,
          at,
          source: 'websocket',
          quality: PLATFORM_END_QUALITY.EVENT
        });
        return;
      }
    }
    this.lastLiveSignalAt = at;
    this.liveKey = incomingKey ?? this.liveKey;
    if (hasIncomingTime) this.liveStartedAt = incomingTime;
    this.hasBeenLive = true;
    this.offlineObservations = 0;
    this.pendingEnd = null;
    this.statusFailures = 0;
    this.lastLiveSeenAt = this.lastLiveSeenAt === null ? at : Math.max(this.lastLiveSeenAt, at);
    this.#emitPlatformStatus({
      status: PLATFORM_STATUS.LIVE,
      at,
      lastLiveSeenAt: this.lastLiveSeenAt,
      source: 'websocket'
    });
    this.logger?.info({event: 'bilibili.stream.live', roomId: this.room?.roomId ?? this.roomId});
    this.#scheduleStatusCheck(this.options.liveStatusIntervalMs);
  }

  #handleEndSignal(event, generation, cmd) {
    if (this.ending || !this.started || generation !== this.generation) return;
    if (!this.#isCurrentRoom(event)) return;
    const at = this.now();
    this.pendingEnd = {source: 'websocket', at, cmd};
    this.#emitPlatformStatus({
      status: PLATFORM_STATUS.ENDING,
      at,
      source: 'websocket',
      observedStatus: PLATFORM_STATUS.ENDED
    });
    this.logger?.info({
      event: 'bilibili.stream.end.signal',
      roomId: this.room?.roomId ?? this.roomId,
      cmd
    });
    // Confirm immediately instead of waiting for the next 60 s cycle.
    if (this.liveStatusTimer) clearTimeout(this.liveStatusTimer);
    this.liveStatusTimer = null;
    this.#checkLiveStatus({reason: 'websocket', strong: true}).catch(() => {});
  }

  #confirmEnd({status, at, source, quality}) {
    if (this.ending) return;
    this.ending = true;
    this.started = false;
    this.generation += 1;
    this.#clearTimers();
    const socket = this.ws;
    this.ws = null;
    this.connected = false;
    this.#emitPlatformStatus({
      status,
      at,
      source,
      platformEndedAt: at,
      endQuality: quality
    });
    // Capture state and platform state are reported separately. The reason is
    // `platform_ended`, never `user`: the user did not stop this capture.
    this.setConnection(CONNECTION_STATE.STOPPED, {
      roomId: this.room?.roomId ?? this.roomId,
      reason: status === PLATFORM_STATUS.NOT_STARTED ? 'platform_not_live' : 'platform_ended',
      platformStatus: status,
      platformEndedAt: at,
      endQuality: quality
    });
    if (socket) {
      try {
        socket.close();
      } catch {
        /* already closing */
      }
    }
    this.logger?.info({
      event: 'bilibili.stream.ended',
      roomId: this.room?.roomId ?? this.roomId,
      platformStatus: status,
      endQuality: quality
    });
    try {
      this.onEnd?.({
        reason: status === PLATFORM_STATUS.NOT_STARTED ? 'platform_not_live' : 'platform_ended',
        platformStatus: status,
        platformEndedAt: at,
        endQuality: quality
      });
    } catch (error) {
      this.logger?.warn({event: 'bilibili.end.callback.failed', code: error?.code ?? 'unknown'});
    }
  }

  /* ----------------------------------------------------------- transport */

  async #handleData(data, generation) {
    if (data === undefined || data === null) return;
    if (typeof data === 'string') {
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        return;
      }
      this.#dispatch(json, generation);
      return;
    }
    let buffer;
    if (Buffer.isBuffer(data)) buffer = data;
    else if (data instanceof ArrayBuffer) buffer = Buffer.from(data);
    else if (ArrayBuffer.isView(data)) buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    else if (typeof data.arrayBuffer === 'function') buffer = Buffer.from(await data.arrayBuffer());
    else return;

    let packets;
    try {
      packets = decodePackets(buffer);
    } catch (error) {
      this.logger?.warn({event: 'bilibili.decode.failed', reason: String(error?.message ?? error)});
      return;
    }
    for (const packet of packets) {
      if (generation !== this.generation) return;
      if (packet.op === OP.AUTH_REPLY) {
        const code = Number(packet.json?.code ?? 0);
        if (code !== 0) {
          this.setConnection(CONNECTION_STATE.AUTH_REQUIRED, {roomId: this.roomId, code});
          this.lastError = new BilibiliError('AUTH_REQUIRED', `auth rejected with code ${code}`, {biliCode: code});
          if (this.startResolver) this.#failStart(this.lastError);
          await this.stop();
          return;
        }
        this.connected = true;
        this.hasConnected = true;
        this.attempt = 0;
        const initialLiveTime = Number(this.room?.liveTime);
        if (this.liveStartedAt === null && Number.isFinite(initialLiveTime) && initialLiveTime > 0) {
          this.liveStartedAt = initialLiveTime;
        }
        this.setConnection(CONNECTION_STATE.CONNECTED, {roomId: this.roomId, realRoomId: this.room?.roomId ?? null});
        this.logger?.info({event: 'bilibili.connected', roomId: this.room?.roomId ?? this.roomId});
        this.#startHeartbeat(generation);
        this.#startMonitoring({
          initialLiveStatus: this.room?.liveStatus ?? 1,
          source: 'room_init'
        });
        if (this.startResolver) {
          const {resolve} = this.startResolver;
          this.startResolver = null;
          if (this.startTimer) clearTimeout(this.startTimer);
          this.startTimer = null;
          resolve();
        }
        continue;
      }
      if (packet.op === OP.POPULARITY) {
        this.popularity = packet.popularity;
        continue;
      }
      if (packet.op === OP.MESSAGE) {
        this.#dispatch(packet.json, generation);
      }
    }
  }

  #dispatch(json, generation) {
    if (!json || typeof json !== 'object') return;
    if (Array.isArray(json)) {
      for (const entry of json) this.#dispatch(entry, generation);
      return;
    }
    const cmd = normalizeCommand(json.cmd);
    if (!cmd) return;
    this.#armWatchdog(generation);
    if (cmd === 'LIVE') {
      this.#handleLiveEvent(json, generation);
      return;
    }
    if (cmd === 'PREPARING' || cmd === 'STOP_LIVE') {
      this.#handleEndSignal(json, generation, cmd);
      return;
    }
    const mapped = mapBilibiliMessage({cmd, data: json.data ?? json, receivedAt: this.now()});
    if (!mapped) {
      if (!IGNORED_COMMANDS.includes(cmd)) {
        this.logger?.debug?.({event: 'bilibili.unhandled', cmd});
      }
      return;
    }
    try {
      this.onEvent(mapped.draft);
    } catch (error) {
      this.logger?.warn({event: 'bilibili.event.failed', kind: mapped.kind, code: error?.code ?? 'unknown'});
    }
  }
}

export const __internal = {DEFAULT_OPTIONS};
