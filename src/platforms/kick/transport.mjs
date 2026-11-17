import {KICK_ERRORS, KickError} from './errors.mjs';
import {KICK_REALTIME_ORIGIN, KICK_WEB_ORIGIN} from './http.mjs';
import {decodeJwtPayload, extractPublication, splitFrameText} from './messages.mjs';

/**
 * Kick realtime transport (Centrifugo over WebSocket).
 *
 * Flow, verified against the live platform on 2026-11-16/17:
 *   1. GET  https://kick.com/api/v2/channels/<slug>
 *        -> id (channel), chatroom.id, livestream
 *   2. POST https://web.kick.com/api/v1/realtime/channels/<channelId>/chat/connection
 *        -> connections[].credentials.url (provider "centrifugo")
 *   3. POST https://web.kick.com/api/v1/realtime/auth/connection
 *        -> anonymous guest JWT (sub "guest:<uuid>", ~45 min TTL)
 *   4. wss://realtime.<region>.platform.kick.com/connection/websocket
 *        -> {"id":1,"connect":{"token":...}}
 *        -> {"id":2,"subscribe":{"channel":"chatrooms.<chatroomId>.v2"}}
 *        -> server pings with "{}", client replies "{}"
 *
 * No account, cookie jar or user token is used. The guest token is requested
 * fresh for every connection and never persisted; there is no hard-coded
 * credential. This is Kick's public web transport, not an official API.
 */

export const KICK_API = Object.freeze({
  channel: (slug) => `${KICK_WEB_ORIGIN}/api/v2/channels/${encodeURIComponent(slug)}`,
  chatConnection: (channelId) => `${KICK_REALTIME_ORIGIN}/api/v1/realtime/channels/${encodeURIComponent(channelId)}/chat/connection`,
  authConnection: () => `${KICK_REALTIME_ORIGIN}/api/v1/realtime/auth/connection`
});

export const TRANSPORT_DEFAULTS = Object.freeze({
  connectTimeoutMs: 15000,
  subscribeTimeoutMs: 15000
});

/**
 * The five feeds one Kick chat uses. Kick's own page joins all of them, and a
 * chatroom-only subscription silently misses gifted subs, Kicks and live/offline
 * events, so the socket subscribes to all five.
 *
 * `chatrooms.<id>.v2` is the only feed that carries chat; it is the required
 * subscription. The rest are best-effort and never block a capture.
 */
export function chatTopics({chatroomId, channelId = null}) {
  const topics = [`chatrooms.${chatroomId}.v2`, `chatrooms.${chatroomId}`, `chatroom_${chatroomId}`];
  if (channelId) topics.push(`channel.${channelId}`, `channel_${channelId}`);
  return topics;
}

function protocolError(reason, details = {}) {
  return new KickError(KICK_ERRORS.PROTOCOL, {
    httpStatus: 502,
    details: {reason, ...details}
  });
}

/** GET the public channel JSON and keep only the fields LiveMemory needs. */
export async function resolveChannel(http, slug) {
  let response = await http.requestJson(KICK_API.channel(slug));
  // Kick slugs are lower-case; a pasted mixed-case URL is retried once in the
  // documented form instead of failing the user's link.
  if (response.status === 404 && String(slug) !== String(slug).toLowerCase()) {
    response = await http.requestJson(KICK_API.channel(String(slug).toLowerCase()));
  }
  if (response.status === 404) {
    throw new KickError(KICK_ERRORS.ROOM_NOT_FOUND, {httpStatus: 404, status: 404, details: {slug}});
  }
  if (response.status < 200 || response.status >= 300) {
    throw new KickError(KICK_ERRORS.ROOM_UNAVAILABLE, {
      httpStatus: 502,
      status: response.status,
      details: {reason: 'channel_lookup_failed'}
    });
  }
  const data = response.data;
  if (!data || typeof data !== 'object') {
    throw protocolError('channel_json_invalid');
  }
  if (data.is_banned === true) {
    throw new KickError(KICK_ERRORS.ROOM_UNAVAILABLE, {httpStatus: 403, details: {reason: 'channel_banned'}});
  }
  const chatroomId = data.chatroom?.id;
  if (!chatroomId) {
    throw new KickError(KICK_ERRORS.ROOM_UNAVAILABLE, {httpStatus: 502, details: {reason: 'chatroom_missing'}});
  }
  const livestream = data.livestream ?? null;
  return {
    slug: typeof data.slug === 'string' && data.slug ? data.slug : slug,
    channelId: String(data.id),
    userId: data.user_id === undefined || data.user_id === null ? null : String(data.user_id),
    chatroomId: String(chatroomId),
    isLive: Boolean(livestream),
    livestreamId: livestream?.id === undefined ? null : String(livestream.id),
    title: typeof livestream?.session_title === 'string' ? livestream.session_title : null,
    startedAt: typeof livestream?.start_time === 'string' ? Date.parse(livestream.start_time) || null : null,
    viewerCount: Number.isFinite(Number(livestream?.viewer_count)) ? Number(livestream.viewer_count) : null,
    followersCount: Number.isFinite(Number(data.followers_count)) ? Number(data.followers_count) : null
  };
}

/** Ask Kick which realtime provider/URL this channel uses. */
export async function fetchChatConnection(http, channelId, {randomUUID = () => crypto.randomUUID()} = {}) {
  const body = JSON.stringify({
    client: {id: randomUUID(), type: 'web'},
    capabilities: {accepted_providers: [{provider: 'pusher'}, {provider: 'centrifugo'}]}
  });
  const response = await http.requestJson(KICK_API.chatConnection(channelId), {
    method: 'POST',
    body,
    headers: {'content-type': 'application/json'}
  });
  if (response.status === 404) {
    throw new KickError(KICK_ERRORS.ROOM_NOT_FOUND, {httpStatus: 404, status: 404, details: {channelId}});
  }
  if (response.status < 200 || response.status >= 300) {
    throw new KickError(KICK_ERRORS.ROOM_UNAVAILABLE, {
      httpStatus: 502,
      status: response.status,
      details: {reason: 'realtime_config_failed'}
    });
  }
  const connections = response.data?.data?.connections;
  if (!Array.isArray(connections) || connections.length === 0) {
    throw protocolError('realtime_connections_missing');
  }
  const centrifugo = connections.find((entry) => entry?.provider === 'centrifugo');
  if (!centrifugo?.credentials?.url) {
    throw protocolError('centrifugo_unavailable', {providers: connections.map((entry) => entry?.provider ?? 'unknown')});
  }
  return {provider: 'centrifugo', url: String(centrifugo.credentials.url)};
}

/** Anonymous guest token. Requested per connection, never persisted or logged. */
export async function fetchGuestToken(http, {randomUUID = () => crypto.randomUUID()} = {}) {
  const response = await http.requestJson(KICK_API.authConnection(), {
    method: 'POST',
    body: JSON.stringify({client_id: randomUUID()}),
    headers: {'content-type': 'application/json'}
  });
  if (response.status < 200 || response.status >= 300) {
    throw new KickError(KICK_ERRORS.ROOM_UNAVAILABLE, {
      httpStatus: 502,
      status: response.status,
      details: {reason: 'guest_token_failed'}
    });
  }
  const token = response.data?.data?.token;
  if (typeof token !== 'string' || token.length < 20) {
    throw protocolError('guest_token_missing');
  }
  const payload = decodeJwtPayload(token);
  const expiresAt = Number.isFinite(Number(payload?.exp)) ? Number(payload.exp) * 1000 : null;
  const issuedAt = Number.isFinite(Number(payload?.iat)) ? Number(payload.iat) * 1000 : null;
  return {
    token,
    subject: typeof payload?.sub === 'string' ? payload.sub : null,
    issuedAt,
    expiresAt,
    ttlMs: expiresAt && issuedAt ? expiresAt - issuedAt : null
  };
}

/**
 * One Centrifugo WebSocket lifetime for one chatroom.
 *
 * `connect()` resolves only after the chatroom subscription was acknowledged:
 * an open socket that never subscribed is not a working capture. Publications
 * are handed to `onPublication` untouched; the adapter decides what becomes an
 * event.
 */
export class KickChatSocket {
  constructor({
    url,
    token,
    chatroomId,
    channelId = null,
    WebSocketImpl = globalThis.WebSocket,
    connectTimeoutMs = TRANSPORT_DEFAULTS.connectTimeoutMs,
    logger = null,
    now = Date.now,
    onPublication = () => {},
    onClose = () => {},
    onError = () => {}
  } = {}) {
    this.url = String(url ?? '');
    this.token = token;
    this.chatroomId = String(chatroomId);
    this.channelId = channelId === null || channelId === undefined ? null : String(channelId);
    this.topics = chatTopics({chatroomId: this.chatroomId, channelId: this.channelId});
    this.WebSocketImpl = WebSocketImpl;
    this.connectTimeoutMs = connectTimeoutMs;
    this.logger = logger;
    this.now = now;
    this.onPublication = onPublication;
    this.onClose = onClose;
    this.onError = onError;

    this.ws = null;
    this.openedAt = null;
    this.closedAt = null;
    this.closeInfo = null;
    this.connectedInfo = null;
    this.lastFrameAt = null;
    this.pingsReceived = 0;
    this.pongsSent = 0;
    this.frames = 0;
    this.publications = 0;
    this.decodeErrors = 0;
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.reportedClose = false;
    this.disconnect = null;
    this.subscriptions = new Set();
  }

  get isOpen() {
    return Boolean(this.ws) && this.ws.readyState === 1 && this.closedAt === null;
  }

  async connect() {
    if (typeof this.WebSocketImpl !== 'function') {
      throw new KickError(KICK_ERRORS.NOT_CONFIGURED, {httpStatus: 503, details: {reason: 'websocket_unavailable'}});
    }
    await this.#open();
    await this.#request({connect: {token: this.token, name: 'js', version: '5.0.0'}}, this.connectTimeoutMs);
    // Chat feed first: it is the only required subscription. The four side
    // feeds carry subs/gifts/Kicks/host/live events; a refusal there is logged
    // and does not fail the capture.
    await this.#request({subscribe: {channel: `chatrooms.${this.chatroomId}.v2`}}, this.connectTimeoutMs);
    for (const topic of this.topics.slice(1)) {
      this.#request({subscribe: {channel: topic}}, this.connectTimeoutMs).catch((error) => {
        this.logger?.warn({event: 'kick.ws.topic_failed', topic, code: error?.code ?? 'unknown'});
      });
    }
    return this;
  }

  #open() {
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new this.WebSocketImpl(this.url);
      } catch (error) {
        reject(new KickError(KICK_ERRORS.SOCKET_FAILED, {
          httpStatus: 502,
          cause: error,
          details: {reason: 'websocket_ctor_failed', message: String(error?.message ?? error)}
        }));
        return;
      }
      this.ws = ws;
      const timer = setTimeout(() => {
        try {
          ws.close(4001, 'connect_timeout');
        } catch {
          /* ignore */
        }
        reject(new KickError(KICK_ERRORS.CONNECT_TIMEOUT, {httpStatus: 504, details: {reason: 'socket_open_timeout'}}));
      }, this.connectTimeoutMs);
      timer.unref?.();

      ws.addEventListener('open', () => {
        clearTimeout(timer);
        this.openedAt = this.now();
        resolve();
      });
      ws.addEventListener('message', (event) => this.#onMessage(event));
      ws.addEventListener('error', (event) => {
        const error = new KickError(KICK_ERRORS.NETWORK, {
          httpStatus: 502,
          details: {reason: 'socket_error', message: String(event?.error?.message ?? event?.message ?? 'socket error')}
        });
        this.onError(error);
        clearTimeout(timer);
        reject(error);
      });
      ws.addEventListener('close', (event) => {
        clearTimeout(timer);
        this.#onClose(event);
        reject(new KickError(KICK_ERRORS.SOCKET_FAILED, {
          httpStatus: 502,
          details: {reason: 'socket_closed_before_open', code: event?.code ?? null}
        }));
      });
    });
  }

  #send(payload) {
    if (!this.ws || this.ws.readyState !== 1) throw protocolError('socket_not_open');
    this.ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
  }

  #request(body, timeoutMs) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new KickError(KICK_ERRORS.CONNECT_TIMEOUT, {httpStatus: 504, details: {reason: 'frame_timeout', id}}));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {resolve, reject, timer});
      try {
        this.#send({id, ...body});
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  #settle(id, {ok, value}) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (ok) entry.resolve(value);
    else entry.reject(value);
  }

  #onMessage(event) {
    this.lastFrameAt = this.now();
    const raw = typeof event?.data === 'string' ? event.data : Buffer.from(event?.data ?? '').toString('utf8');
    const parts = splitFrameText(raw);
    for (const part of parts) {
      if (part === '{}') {
        this.pingsReceived += 1;
        try {
          this.#send('{}');
          this.pongsSent += 1;
        } catch {
          /* a closed socket is reported through close */
        }
        continue;
      }
      let frame;
      try {
        frame = JSON.parse(part);
      } catch {
        this.decodeErrors += 1;
        this.logger?.warn({event: 'kick.ws.frame.decode_failed'});
        continue;
      }
      this.frames += 1;
      if (frame.id !== undefined && frame.id !== null) {
        if (frame.error) {
          const code = frame.error.code ?? null;
          this.#settle(frame.id, {
            ok: false,
            value: protocolError('frame_error', {
              code,
              message: typeof frame.error.message === 'string' ? frame.error.message : null
            })
          });
          if (code === 109 || code === 3500) this.#expireToken(code);
          continue;
        }
        if (frame.connect) {
          this.connectedInfo = {
            client: frame.connect.client ?? null,
            version: frame.connect.version ?? null,
            ttl: frame.connect.ttl ?? null,
            ping: frame.connect.ping ?? null
          };
          this.#settle(frame.id, {ok: true, value: frame.connect});
          continue;
        }
        if (frame.subscribe !== undefined) {
          this.#settle(frame.id, {ok: true, value: frame.subscribe});
          continue;
        }
        this.#settle(frame.id, {ok: true, value: frame});
        continue;
      }
      if (frame.disconnect) {
        this.disconnect = {
          code: frame.disconnect.code ?? null,
          reason: typeof frame.disconnect.reason === 'string' ? frame.disconnect.reason : null
        };
        continue;
      }
      if (frame.push) {
        if (frame.push.disconnect) {
          this.disconnect = {
            code: frame.push.disconnect.code ?? null,
            reason: typeof frame.push.disconnect.reason === 'string' ? frame.push.disconnect.reason : null
          };
          this.#expireToken(this.disconnect.code);
          continue;
        }
        const publication = extractPublication(frame.push);
        if (!publication) {
          this.decodeErrors += 1;
          continue;
        }
        this.publications += 1;
        if (publication.channel) this.subscriptions.add(publication.channel);
        this.onPublication(publication);
        continue;
      }
      // Unknown control frame: counted, never interpreted as a message.
      this.decodeErrors += 1;
    }
  }

  #onClose(event) {
    this.closedAt = this.now();
    this.closeInfo = {
      code: event?.code ?? null,
      reason: typeof event?.reason === 'string' && event.reason ? event.reason : null,
      disconnect: this.disconnect,
      wasOpen: Boolean(this.openedAt)
    };
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(new KickError(KICK_ERRORS.SOCKET_FAILED, {
        httpStatus: 502,
        details: {reason: 'socket_closed', id}
      }));
    }
    if (this.reportedClose) return;
    this.reportedClose = true;
    this.onClose(this.closeInfo);
  }

  /** Idempotent stop. A close caused by stop() is never a reconnect trigger. */
  close({code = 1000, reason = 'client_stop'} = {}) {
    this.closed = true;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(new KickError(KICK_ERRORS.STOPPED, {httpStatus: 409, details: {reason, id}}));
    }
    const ws = this.ws;
    if (ws && ws.readyState <= 1) {
      try {
        ws.close(code, reason);
      } catch {
        /* ignore */
      }
    }
  }

  /** Drop the socket without stopping the owner; used by the G1 drop test. */
  dropForTest({code = 4000, reason = 'test_drop'} = {}) {
    this.close({code, reason});
  }

  /** True when the server told us the connection token expired. */
  get tokenExpired() {
    return this.disconnect?.code === 109;
  }

  /**
   * The server refused the guest token (Centrifugo 109 / 3500). Record it and
   * close so the owner reconnects with a freshly requested token instead of
   * retrying the same expired one.
   */
  #expireToken(code) {
    if (code !== 109 && code !== 3500) return;
    this.disconnect = {
      code,
      reason: this.disconnect?.reason ?? 'token_expired'
    };
    try {
      this.ws?.close(3000, 'token_expired');
    } catch {
      /* the close event reports the state */
    }
  }

  snapshot() {
    return {
      url: this.url,
      chatroomId: this.chatroomId,
      openedAt: this.openedAt,
      closedAt: this.closedAt,
      closeInfo: this.closeInfo,
      lastFrameAt: this.lastFrameAt,
      frames: this.frames,
      publications: this.publications,
      pingsReceived: this.pingsReceived,
      pongsSent: this.pongsSent,
      decodeErrors: this.decodeErrors,
      connectedInfo: this.connectedInfo,
      disconnect: this.disconnect,
      subscriptions: [...this.subscriptions]
    };
  }
}

export const __internal = {protocolError};
