import {gunzipSync} from 'node:zlib';
import {TIKTOK_ERRORS, TikTokError} from './errors.mjs';
import {encodeBytesField, encodeVarintField} from './protobuf.mjs';
import {decodeFetchResult, decodePushFrame} from './messages.mjs';

/**
 * Anonymous TikTok LIVE WebSocket transport.
 *
 * TikTok's web player receives LIVE events over a WebSocket at
 * `webcast-ws.tiktok.com/webcast/im/ws_proxy/ws_reuse_supplement/`. The socket
 * needs no account, no OAuth, no request signing and no third-party service:
 * the only credential is an anonymous `ttwid` device cookie that TikTok issues
 * to any visitor. Every frame is a `PushFrame` envelope; event batches sit in
 * field 8 (normally gzip-compressed) and decode to the same
 * `ProtoMessageFetchResult` shape as other TikTok transports.
 *
 * This module is deliberately transport-only: it opens the socket, sends the
 * room-enter/heartbeat/ack frames, decodes envelopes and reports them. It never
 * writes to the database and never invents events.
 *
 * Protocol reference: talkaboutdesign/tiklive (MIT), `packages/core/src/
 * LiveConnection.ts` and `proto/frames.ts`. The implementation here is plain
 * Node ESM so it can run inside a Node SEA executable with zero dependencies.
 *
 * This is TikTok's private web protocol, not an official API.
 */

export const TIKTOK_WEB_ORIGIN = 'https://www.tiktok.com';
export const TIKTOK_WS_PATH = '/webcast/im/ws_proxy/ws_reuse_supplement/';
export const TIKTOK_WS_HOSTS = Object.freeze(['webcast-ws.tiktok.com', 'webcast-ws.us.tiktok.com']);

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

export const SOCKET_DEFAULTS = Object.freeze({
  heartbeatIntervalMs: 10000,
  idleTimeoutMs: 60000,
  connectTimeoutMs: 15000,
  ttwidTimeoutMs: 15000
});

function protocolError(reason) {
  return new TikTokError(TIKTOK_ERRORS.PROTOCOL, {
    messageKey: 'errors.tiktokProtocol',
    httpStatus: 502,
    details: {reason}
  });
}

/* --------------------------------------------------------------- encoding */

/** Envelope for every frame. `pb` is the only encoding used; batches are `msg`. */
export function encodePushFrame({logId = null, payloadType = 'msg', payload, payloadEncoding = 'pb'}) {
  const parts = [];
  if (logId !== null && logId !== undefined && logId !== '') parts.push(encodeVarintField(2, BigInt(logId)));
  parts.push(encodeBytesField(6, Buffer.from(payloadEncoding, 'utf8')));
  parts.push(encodeBytesField(7, Buffer.from(payloadType, 'utf8')));
  parts.push(encodeBytesField(8, Buffer.from(payload)));
  return Buffer.concat(parts);
}

/** `im_enter_room`: room id (1), live_id 12 (4), identity "audience" (5). */
export function encodeEnterRoom(roomId) {
  const payload = Buffer.concat([
    encodeVarintField(1, BigInt(roomId)),
    encodeVarintField(4, 12n),
    encodeBytesField(5, Buffer.from('audience', 'utf8'))
  ]);
  return encodePushFrame({payloadType: 'im_enter_room', payload});
}

/** Heartbeat carries only the room id. Missing heartbeats close the socket. */
export function encodeHeartbeat(roomId) {
  return encodePushFrame({payloadType: 'hb', payload: encodeVarintField(1, BigInt(roomId))});
}

/** Acknowledge a batch by its envelope `logId`. The web client sends `-`. */
export function encodeAck(logId, payload = '-') {
  return encodePushFrame({logId, payloadType: 'ack', payload: Buffer.from(payload, 'utf8')});
}

/**
 * Socket URL for one host.
 *
 * The parameters mirror the web player's own handshake. `compress=gzip` is why
 * event batches arrive gzipped; `resp_content_type=protobuf` keeps them binary.
 */
export function buildSocketUrl({
  host,
  roomId,
  userAgent = DEFAULT_USER_AGENT,
  heartbeatIntervalMs = SOCKET_DEFAULTS.heartbeatIntervalMs,
  timeZone = null
}) {
  const params = new URLSearchParams({
    version_code: '180800',
    device_platform: 'web',
    cookie_enabled: 'true',
    screen_width: '1920',
    screen_height: '1080',
    browser_language: 'en-US',
    browser_platform: 'Win32',
    browser_name: 'Mozilla',
    browser_version: userAgent.replace(/^Mozilla\//, ''),
    browser_online: 'true',
    tz_name: timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
    app_name: 'tiktok_web',
    sup_ws_ds_opt: '1',
    update_version_code: '2.0.0',
    compress: 'gzip',
    webcast_language: 'en',
    ws_direct: '1',
    aid: '1988',
    live_id: '12',
    app_language: 'en',
    client_enter: '1',
    room_id: String(roomId),
    identity: 'audience',
    history_comment_count: '6',
    heartbeat_duration: String(heartbeatIntervalMs),
    resp_content_type: 'protobuf',
    did_rule: '3'
  });
  const base = /^wss?:\/\//.test(host) ? host : `wss://${host}${TIKTOK_WS_PATH}`;
  return `${base}?${params}`;
}

/* ----------------------------------------------------------------- ttwid */

/**
 * Anonymous device cookie cache.
 *
 * TikTok sets `ttwid` on a normal page request. It is not a login: it identifies
 * a browser install, exactly like the web page's own first visit. A stale value
 * is the most common cause of a refused socket, so callers can force a refresh.
 *
 * TikTok answers part of a request burst with a tiny error page and no cookie
 * (`x-tt-system-error: 3`). That is throttling, not a login wall, so the
 * provider retries with a short backoff and only reports a real failure after
 * every attempt was refused.
 */
export class TtwidProvider {
  constructor({
    fetchImpl = globalThis.fetch,
    userAgent = DEFAULT_USER_AGENT,
    timeoutMs = SOCKET_DEFAULTS.ttwidTimeoutMs,
    now = Date.now,
    logger = null,
    attempts = 3,
    retryDelayMs = 2000,
    store = null,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.userAgent = userAgent;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.logger = logger;
    this.attempts = Math.max(1, attempts);
    this.retryDelayMs = Math.max(0, retryDelayMs);
    this.store = store;
    this.sleep = sleep;
    this.cached = null;
    this.fetchedAt = null;
    this.source = null;
    this.lastError = null;
    this.fetchCount = 0;
    this.retryCount = 0;
  }

  get value() {
    return this.cached;
  }

  /** Restore a persisted anonymous cookie (no network). Returns the value or null. */
  async load() {
    if (!this.store?.read) return null;
    try {
      const saved = await this.store.read();
      if (typeof saved?.ttwid === 'string' && saved.ttwid.length > 20) {
        this.cached = saved.ttwid;
        this.fetchedAt = Number(saved.fetchedAt) || null;
        this.source = 'persisted';
        return this.cached;
      }
    } catch (error) {
      this.logger?.warn({event: 'tiktok.ttwid.load_failed', code: error?.code ?? 'unknown'});
    }
    return null;
  }

  async #persist(value) {
    if (!this.store?.write) return;
    try {
      await this.store.write({ttwid: value, fetchedAt: this.fetchedAt});
    } catch (error) {
      this.logger?.warn({event: 'tiktok.ttwid.persist_failed', code: error?.code ?? 'unknown'});
    }
  }

  async #requestOnce() {
    if (typeof this.fetchImpl !== 'function') {
      throw new TikTokError(TIKTOK_ERRORS.NOT_CONFIGURED, {
        messageKey: 'errors.tiktokNotConfigured',
        httpStatus: 503,
        details: {reason: 'fetch_unavailable'}
      });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    this.fetchCount += 1;
    try {
      const response = await this.fetchImpl(`${TIKTOK_WEB_ORIGIN}/`, {
        headers: {
          'user-agent': this.userAgent,
          // A plain `*/*` request does not receive the cookie; the request must
          // look like a browser navigation.
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9'
        },
        signal: controller.signal
      });
      const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
      const match = cookies.map((entry) => /^\s*ttwid=([^;]+)/.exec(entry)).find(Boolean);
      if (!match) {
        return {ok: false, status: response.status, throttled: true};
      }
      return {ok: true, status: response.status, ttwid: decodeURIComponent(match[1])};
    } catch (error) {
      return {ok: false, status: 0, throttled: false, reason: error?.name === 'AbortError' ? 'ttwid_timeout' : 'ttwid_network', error};
    } finally {
      clearTimeout(timer);
    }
  }

  async get({refresh = false} = {}) {
    if (this.cached && !refresh) return this.cached;
    let last = null;
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      last = await this.#requestOnce();
      if (last.ok) {
        this.cached = last.ttwid;
        this.fetchedAt = this.now();
        this.source = 'fetched';
        this.lastError = null;
        await this.#persist(this.cached);
        return this.cached;
      }
      this.retryCount += 1;
      if (attempt < this.attempts) {
        await this.sleep(this.retryDelayMs * attempt);
      }
    }
    this.lastError = {
      reason: last?.reason ?? 'ttwid_throttled',
      status: last?.status ?? null,
      at: this.now()
    };
    // Throttling is temporary: report it as a network/rate condition, not as a
    // login requirement or a permission problem.
    if (last?.reason === 'ttwid_network' || last?.reason === 'ttwid_timeout') {
      throw new TikTokError(TIKTOK_ERRORS.NETWORK, {
        messageKey: 'errors.tiktokNetwork',
        httpStatus: 502,
        cause: last?.error ?? null,
        details: {reason: last.reason}
      });
    }
    throw new TikTokError(TIKTOK_ERRORS.RATE_LIMITED, {
      messageKey: 'errors.tiktokRateLimit',
      httpStatus: 429,
      status: last?.status ?? null,
      retryAfterMs: 30000,
      details: {reason: 'ttwid_throttled', status: last?.status ?? null}
    });
  }

  snapshot() {
    return {
      cached: Boolean(this.cached),
      source: this.source,
      fetchedAt: this.fetchedAt,
      fetchCount: this.fetchCount,
      retryCount: this.retryCount,
      lastError: this.lastError
    };
  }
}

/* ---------------------------------------------------------------- socket */

function isGzip(buffer) {
  return buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

function socketErrorText(error) {
  return error?.message ?? error?.error?.message ?? 'socket error';
}

/**
 * One WebSocket lifetime for one room.
 *
 * `connect()` resolves once the socket is open and the room-enter frame has been
 * written. Frames are decoded and handed to `onFrame`; a frame is reported even
 * when its payload is not an event batch, so callers can distinguish
 * "connected, control frames only" from "receiving events".
 */
export class WebcastSocket {
  constructor({
    roomId,
    userAgent = DEFAULT_USER_AGENT,
    hosts = TIKTOK_WS_HOSTS,
    heartbeatIntervalMs = SOCKET_DEFAULTS.heartbeatIntervalMs,
    idleTimeoutMs = SOCKET_DEFAULTS.idleTimeoutMs,
    connectTimeoutMs = SOCKET_DEFAULTS.connectTimeoutMs,
    WebSocketImpl = globalThis.WebSocket,
    now = Date.now,
    logger = null,
    onFrame = () => {},
    onClose = () => {},
    onError = () => {}
  } = {}) {
    this.roomId = String(roomId);
    this.userAgent = userAgent;
    this.hosts = hosts;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.idleTimeoutMs = idleTimeoutMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.WebSocketImpl = WebSocketImpl;
    this.now = now;
    this.logger = logger;
    this.onFrame = onFrame;
    this.onClose = onClose;
    this.onError = onError;

    this.ws = null;
    this.host = null;
    this.openedAt = null;
    this.closedAt = null;
    this.closeInfo = null;
    this.lastFrameAt = null;
    this.frames = 0;
    this.batchFrames = 0;
    this.controlFrames = 0;
    this.textFrames = 0;
    this.decodeErrors = 0;
    this.heartbeatsSent = 0;
    this.acksSent = 0;
    this.bytesReceived = 0;
    this.reportedClose = false;

    this.heartbeatTimer = null;
    this.idleTimer = null;
    this.openTimer = null;
  }

  get isOpen() {
    return Boolean(this.ws) && this.ws.readyState === 1 && this.closedAt === null;
  }

  async connect({ttwid, signal = null} = {}) {
    if (!ttwid) throw protocolError('ttwid_missing');
    if (typeof this.WebSocketImpl !== 'function') {
      throw new TikTokError(TIKTOK_ERRORS.NOT_CONFIGURED, {
        messageKey: 'errors.tiktokNotConfigured',
        httpStatus: 503,
        details: {reason: 'websocket_unavailable'}
      });
    }
    const errors = [];
    for (const host of this.hosts) {
      try {
        await this.#openHost(host, ttwid, signal);
        return this;
      } catch (error) {
        errors.push(`${host}: ${error?.message ?? 'failed'}`);
        this.#teardown();
      }
    }
    throw new TikTokError(TIKTOK_ERRORS.SOCKET_FAILED, {
      messageKey: 'errors.tiktokSocketFailed',
      httpStatus: 502,
      details: {reason: 'all_hosts_failed', hosts: [...this.hosts], errors}
    });
  }

  #openHost(host, ttwid, signal) {
    return new Promise((resolve, reject) => {
      const url = buildSocketUrl({host, roomId: this.roomId, userAgent: this.userAgent, heartbeatIntervalMs: this.heartbeatIntervalMs});
      let settled = false;
      const settleReject = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(this.openTimer);
        reject(error);
      };
      let ws;
      try {
        ws = new this.WebSocketImpl(url, {
          headers: {
            'user-agent': this.userAgent,
            cookie: `ttwid=${ttwid}`,
            origin: TIKTOK_WEB_ORIGIN
          }
        });
      } catch (error) {
        settleReject(new TikTokError(TIKTOK_ERRORS.SOCKET_FAILED, {
          messageKey: 'errors.tiktokSocketFailed',
          httpStatus: 502,
          cause: error,
          details: {reason: 'websocket_ctor_failed', host, message: socketErrorText(error)}
        }));
        return;
      }
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      this.host = host;

      this.openTimer = setTimeout(() => {
        settleReject(new TikTokError(TIKTOK_ERRORS.CONNECT_TIMEOUT, {
          messageKey: 'errors.tiktokConnectTimeout',
          httpStatus: 504,
          details: {reason: 'socket_open_timeout', host}
        }));
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }, this.connectTimeoutMs);
      this.openTimer.unref?.();

      if (signal) {
        signal.addEventListener('abort', () => {
          try {
            ws.close(1000, 'client_stop');
          } catch {
            /* ignore */
          }
          settleReject(new TikTokError(TIKTOK_ERRORS.STOPPED, {
            messageKey: 'errors.tiktokStopped',
            httpStatus: 409
          }));
        }, {once: true});
      }

      ws.addEventListener('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(this.openTimer);
        this.openedAt = this.now();
        try {
          ws.send(encodeEnterRoom(this.roomId));
        } catch (error) {
          settleReject(new TikTokError(TIKTOK_ERRORS.SOCKET_FAILED, {
            messageKey: 'errors.tiktokSocketFailed',
            httpStatus: 502,
            cause: error,
            details: {reason: 'enter_room_send_failed', message: socketErrorText(error)}
          }));
          return;
        }
        this.heartbeatTimer = setInterval(() => this.#sendHeartbeat(), this.heartbeatIntervalMs);
        this.heartbeatTimer.unref?.();
        this.#armIdleTimer();
        resolve();
      });

      ws.addEventListener('message', (event) => this.#onMessage(event));

      ws.addEventListener('error', (event) => {
        this.decodeErrors += 0;
        this.onError(new TikTokError(TIKTOK_ERRORS.NETWORK, {
          messageKey: 'errors.tiktokNetwork',
          httpStatus: 502,
          details: {reason: 'socket_error', host, message: socketErrorText(event?.error ?? event)}
        }));
        settleReject(new TikTokError(TIKTOK_ERRORS.SOCKET_FAILED, {
          messageKey: 'errors.tiktokSocketFailed',
          httpStatus: 502,
          details: {reason: 'socket_error', host, message: socketErrorText(event?.error ?? event)}
        }));
      });

      ws.addEventListener('close', (event) => this.#onClose(event));
    });
  }

  #armIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.isOpen) return;
      // Nothing arrived for a full idle window: treat it as a dead socket and
      // let the adapter reconnect. This is not a platform refusal.
      this.close({code: 4000, reason: 'idle_timeout'});
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  #onMessage(event) {
    this.lastFrameAt = this.now();
    this.#armIdleTimer();
    if (typeof event.data === 'string') {
      this.textFrames += 1;
      return;
    }
    const buffer = Buffer.from(event.data);
    this.bytesReceived += buffer.length;
    this.frames += 1;
    let frame;
    try {
      frame = decodePushFrame(buffer);
    } catch (error) {
      this.decodeErrors += 1;
      this.logger?.warn({event: 'tiktok.ws.frame.decode_failed', host: this.host, code: error?.code ?? 'unknown'});
      return;
    }
    if (!frame) {
      this.decodeErrors += 1;
      return;
    }
    if (frame.logId && frame.logId !== '0') this.#sendAck(frame.logId);
    if (frame.payloadType !== 'msg') {
      this.controlFrames += 1;
      this.onFrame({frame, result: null});
      return;
    }
    this.batchFrames += 1;
    let result = null;
    try {
      let payload = frame.payload;
      if (isGzip(payload)) payload = gunzipSync(payload);
      result = decodeFetchResult(payload);
    } catch (error) {
      this.decodeErrors += 1;
      this.logger?.warn({event: 'tiktok.ws.batch.decode_failed', host: this.host});
      this.onFrame({frame, result: null, error});
      return;
    }
    this.onFrame({frame, result});
  }

  #onClose(event) {
    this.closedAt = this.now();
    this.closeInfo = {code: event?.code ?? null, reason: event?.reason ?? '', hostedAt: this.host};
    this.#stopTimers();
    if (this.reportedClose) return;
    this.reportedClose = true;
    this.onClose({
      code: event?.code ?? null,
      reason: event?.reason || (event?.code === 4000 ? 'idle_timeout' : 'socket_closed'),
      wasOpen: Boolean(this.openedAt),
      frames: this.frames
    });
  }

  #sendAck(logId) {
    try {
      this.ws?.send(encodeAck(logId));
      this.acksSent += 1;
    } catch {
      /* a closed socket will surface through close/error */
    }
  }

  #sendHeartbeat() {
    if (!this.isOpen) return;
    try {
      this.ws.send(encodeHeartbeat(this.roomId));
      this.heartbeatsSent += 1;
    } catch {
      /* ignore; the close event drives reconnection */
    }
  }

  #stopTimers() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.openTimer) clearTimeout(this.openTimer);
    this.heartbeatTimer = null;
    this.idleTimer = null;
    this.openTimer = null;
  }

  #teardown() {
    this.#stopTimers();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
    }
    this.ws = null;
  }

  /** Close the socket. Idempotent; the close event is reported once. */
  close({code = 1000, reason = 'client_stop'} = {}) {
    this.#stopTimers();
    const socket = this.ws;
    if (socket && socket.readyState <= 1) {
      try {
        socket.close(code, reason);
      } catch {
        /* ignore */
      }
    }
  }

  snapshot() {
    return {
      host: this.host,
      openedAt: this.openedAt,
      closedAt: this.closedAt,
      closeInfo: this.closeInfo,
      lastFrameAt: this.lastFrameAt,
      frames: this.frames,
      batchFrames: this.batchFrames,
      controlFrames: this.controlFrames,
      textFrames: this.textFrames,
      decodeErrors: this.decodeErrors,
      heartbeatsSent: this.heartbeatsSent,
      acksSent: this.acksSent,
      bytesReceived: this.bytesReceived
    };
  }
}

export const __internal = {isGzip, socketErrorText};
