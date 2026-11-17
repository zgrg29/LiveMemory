// Kuaishou G1.5 research prototype — authenticated WebSocket transport.
//
// The socket carries an authenticated token obtained from
// `liveroom/websocketinfo`; the token travels inside CS_ENTER_ROOM, not in a
// Cookie header. No signing, fingerprinting or captcha handling is involved.
//
// Node's built-in WebSocket cannot set an Origin header. This prototype
// therefore connects without one and records the result honestly; if the
// gateway requires browser-only headers, that is a platform constraint and is
// reported, not worked around.

import {KuaishouError, CODES, backoffDelay} from './errors.mjs';
import {sleep} from './http.mjs';
import {
  decodeEnvelope, decodeEnterRoomAck, decodeFeedPush, decodeServerError,
  encodeEnterRoom, encodeHeartbeat, encodeUserExit
} from './ws-protocol.mjs';

const AUTH_ERROR_CODES = new Set([109, 400002, 400013]);

function defaultSocketFactory(url) {
  if (typeof globalThis.WebSocket !== 'function') {
    throw new KuaishouError(CODES.CONFIG, '当前运行时没有 WebSocket');
  }
  return new globalThis.WebSocket(url);
}

function toBuffer(data) {
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (Buffer.isBuffer(data)) return data;
  return null;
}

export class AuthenticatedWebSocketTransport {
  #stopped = false;
  #abort = new AbortController();

  constructor({
    normalizer,
    urls = [],
    token,
    liveStreamId,
    socketFactory = defaultSocketFactory,
    maxReconnects = 5,
    giftNames = new Map(),
    now = Date.now
  } = {}) {
    if (!normalizer) throw new KuaishouError(CODES.CONFIG, '需要 normalizer');
    if (!token || !liveStreamId) throw new KuaishouError(CODES.CONFIG, '需要 token 与 liveStreamId');
    if (!Array.isArray(urls) || urls.length === 0) throw new KuaishouError(CODES.CONFIG, 'websocketinfo 没有返回接入地址');
    this.normalizer = normalizer;
    this.urls = urls;
    this.token = token;
    this.liveStreamId = liveStreamId;
    this.socketFactory = socketFactory;
    this.maxReconnects = maxReconnects;
    this.giftNames = giftNames;
    this.now = now;
    this.state = 'idle';
    this.stats = {
      connections: 0,
      reconnects: 0,
      frames: 0,
      feedPushes: 0,
      comments: 0,
      gifts: 0,
      likes: 0,
      shares: 0,
      system: 0,
      duplicates: 0,
      errors: 0,
      lastError: null,
      heartbeatIntervalMs: null
    };
    this.#seen = new Set();
  }

  #seen = new Set();

  get stopped() {
    return this.#stopped;
  }

  #emit(onEvents, events) {
    if (!events.length) return;
    onEvents(events);
  }

  #handleFrame(frame, ctx) {
    this.stats.frames += 1;
    if (frame.type === 'SC_ENTER_ROOM_ACK') {
      const ack = decodeEnterRoomAck(frame.payload);
      this.stats.heartbeatIntervalMs = ack.heartbeatIntervalMs;
      ctx.startHeartbeat(Math.max(1000, ack.heartbeatIntervalMs || 20000));
      return;
    }
    if (frame.type === 'SC_ERROR') {
      const err = decodeServerError(frame.payload);
      this.stats.errors += 1;
      this.stats.lastError = err;
      if (AUTH_ERROR_CODES.has(err.code)) {
        throw new KuaishouError(CODES.AUTH_REQUIRED, `直播服务端拒绝：${err.message || err.code}`, {detail: err});
      }
      return;
    }
    if (frame.type !== 'SC_FEED_PUSH') return;

    this.stats.feedPushes += 1;
    const feed = decodeFeedPush(frame.payload);
    const events = [];
    const receivedAt = this.now();

    for (const c of feed.comments) {
      if (c.id) {
        const key = `comment:${c.id}`;
        if (this.#seen.has(key)) {
          this.stats.duplicates += 1;
          continue;
        }
        this.#seen.add(key);
      }
      this.stats.comments += 1;
      events.push(this.normalizer.chat({
        id: c.id,
        principalId: c.user?.principalId ?? null,
        nickname: c.user?.nickname ?? '',
        content: c.content,
        time: c.time
      }, receivedAt));
    }
    for (const g of feed.gifts) {
      if (g.id) {
        const key = `gift:${g.id}`;
        if (this.#seen.has(key)) continue;
        this.#seen.add(key);
      }
      this.stats.gifts += 1;
      events.push(this.normalizer.gift({
        id: g.id,
        principalId: g.user?.principalId ?? null,
        nickname: g.user?.nickname ?? '',
        giftId: g.giftId,
        giftName: g.giftId ? (this.giftNames.get(String(g.giftId)) ?? '') : '',
        count: g.count,
        time: g.time
      }, receivedAt));
    }
    for (const s of feed.system) {
      this.stats.system += 1;
      events.push(this.normalizer.system({id: s.id, content: s.content, time: s.time}, receivedAt));
    }
    this.stats.likes += feed.likes.length;
    this.stats.shares += feed.shares.length;
    this.#emit(ctx.onEvents, events);
  }

  async #connectOnce(attempt, onEvents, onStatus) {
    const url = this.urls[attempt % this.urls.length];
    const socket = this.socketFactory(url);
    socket.binaryType = 'arraybuffer';
    if (socket.addEventListener) socket.addEventListener('message', () => {});
    this.stats.connections += 1;

    let heartbeat = null;
    const ctx = {
      onEvents,
      startHeartbeat(intervalMs) {
        if (heartbeat) return;
        heartbeat = setInterval(() => {
          try {
            socket.send(encodeHeartbeat(this.now()));
          } catch {
            /* socket closed; the close handler drives reconnection */
          }
        }, intervalMs);
        heartbeat.unref?.();
      }
    };

    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new KuaishouError(CODES.TIMEOUT, 'WebSocket 连接超时')), 15000);
        timer.unref?.();
        socket.addEventListener('open', () => {
          clearTimeout(timer);
          resolve();
        }, {once: true});
        socket.addEventListener('error', (ev) => {
          clearTimeout(timer);
          reject(new KuaishouError(CODES.NETWORK, 'WebSocket 连接失败', {detail: {attempt, event: ev?.type ?? 'error'}}));
        }, {once: true});
      });

      socket.send(encodeEnterRoom({token: this.token, liveStreamId: this.liveStreamId, reconnectCount: attempt}));
      this.state = 'connected';
      onStatus({state: 'connected', url, attempt});

      await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (err) => {
          if (settled) return;
          settled = true;
          if (err) reject(err);
          else resolve();
        };
        socket.addEventListener('message', (event) => {
          try {
            const raw = toBuffer(event.data);
            if (!raw) return;
            const frame = decodeEnvelope(raw);
            this.#handleFrame(frame, ctx);
          } catch (err) {
            this.stats.errors += 1;
            this.stats.lastError = {code: err?.code ?? 'DECODE', message: String(err?.message ?? err)};
            if (err instanceof KuaishouError) finish(err);
          }
        });
        socket.addEventListener('close', (event) => {
          finish(new KuaishouError(CODES.NETWORK, 'WebSocket 已关闭', {
            retryable: true,
            detail: {code: event?.code ?? null, reason: event?.reason ?? ''}
          }));
        }, {once: true});
        socket.addEventListener('error', () => {
          finish(new KuaishouError(CODES.NETWORK, 'WebSocket 错误', {retryable: true}));
        }, {once: true});
      });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      try {
        socket.send(encodeUserExit(this.now()));
      } catch {
        /* already closed */
      }
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    }
  }

  async start({onEvents = () => {}, onStatus = () => {}} = {}) {
    this.state = 'connecting';
    onStatus({state: this.state});
    let attempt = 0;

    while (!this.#stopped) {
      try {
        await this.#connectOnce(attempt, onEvents, onStatus);
        if (this.#stopped) break;
        throw new KuaishouError(CODES.NETWORK, '连接意外结束', {retryable: true});
      } catch (err) {
        if (this.#stopped) break;
        const fatal = err instanceof KuaishouError && !err.retryable;
        this.stats.errors += 1;
        this.stats.lastError = {code: err?.code ?? 'NETWORK', message: String(err?.message ?? err)};
        if (fatal) {
          this.state = 'failed';
          onStatus({state: 'failed', code: err.code, message: err.message});
          throw err;
        }
        attempt += 1;
        if (attempt > this.maxReconnects) {
          this.state = 'failed';
          onStatus({state: 'failed', code: err?.code ?? 'NETWORK', attempts: attempt - 1});
          throw new KuaishouError(CODES.NETWORK, `重连 ${this.maxReconnects} 次仍失败`, {detail: this.stats.lastError});
        }
        this.stats.reconnects += 1;
        this.state = 'reconnecting';
        onStatus({state: 'reconnecting', attempt});
        try {
          await sleep(backoffDelay(attempt - 1, {baseMs: 1000, maxMs: 30000}), this.#abort.signal);
        } catch {
          break;
        }
      }
    }
    if (this.state !== 'failed') this.state = 'stopped';
    onStatus({state: this.state});
    return this.stats;
  }

  stop() {
    this.#stopped = true;
    this.#abort.abort();
    if (this.state !== 'failed') this.state = 'stopped';
  }
}
