import {PlatformAdapter, CONNECTION_STATE} from '../shared/adapter.mjs';
import {BilibiliApi, BilibiliError} from './api.mjs';
import {decodePackets, encodeAuth, encodeHeartbeat, normalizeCommand, OP} from './protocol.mjs';
import {IGNORED_COMMANDS, mapBilibiliMessage} from './mapper.mjs';

/**
 * Bilibili live adapter.
 *
 * Transport only: it resolves the room, gets a signed `getDanmuInfo`, keeps a
 * WebSocket alive (30 s heartbeat, 65 s watchdog), reconnects with exponential
 * backoff and converts packets to canonical event drafts. Persistence, dedupe
 * and viewer aggregation stay in EventIngest.
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
  maxHosts: 3
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
    this.popularity = null;
    this.room = null;
    this.connected = false;
    this.started = false;
    this.lastError = null;
    this.onEvent = () => {};
    this.startResolver = null;
  }

  setConnection(state, detail = null) {
    if (this.state !== state) this.setState(state, detail);
    else this.detail = detail;
  }

  async start({onEvent = () => {}, onStateChange = null} = {}) {
    if (!Number.isInteger(this.roomId) || this.roomId <= 0) {
      throw new BilibiliError('ROOM_INVALID', 'a numeric live room id is required');
    }
    if (typeof this.WebSocketImpl !== 'function') {
      throw new BilibiliError('WEBSOCKET_UNAVAILABLE', 'this runtime has no WebSocket implementation');
    }
    this.onEvent = onEvent;
    this.onStateChange = onStateChange;
    this.started = true;
    this.generation += 1;
    this.attempt = 0;
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
        loggedIn: Boolean(this.api?.loggedIn)
      }
    };
  }

  #clearTimers() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.watchdog) clearTimeout(this.watchdog);
    if (this.retry) clearTimeout(this.retry);
    if (this.startTimer) clearTimeout(this.startTimer);
    this.heartbeat = null;
    this.watchdog = null;
    this.retry = null;
    this.startTimer = null;
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
      info = await this.api.danmuInfo(room.roomId);
      try {
        user = await this.api.navUser();
      } catch {
        user = null; // login is optional; the stream is readable anonymously
      }
      this.room = room;
    } catch (error) {
      this.lastError = error;
      this.setConnection(error?.code === 'AUTH' ? CONNECTION_STATE.AUTH_REQUIRED : CONNECTION_STATE.RECONNECTING, {
        roomId: this.roomId,
        attempt: this.attempt,
        code: error?.code ?? 'unknown'
      });
      this.logger?.warn({event: 'bilibili.connect.failed', code: error?.code ?? 'unknown', biliCode: error?.biliCode ?? null});
      if (generation === this.generation && this.startResolver) {
        this.#failStart(error);
        return;
      }
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
        if (this.started) {
          this.#schedule(generation);
        }
      });
    } catch (error) {
      this.#schedule(generation);
      if (this.startResolver) this.#failStart(error);
    }
  }

  #schedule(generation) {
    if (!this.started || generation !== this.generation) return;
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
        this.attempt = 0;
        this.setConnection(CONNECTION_STATE.CONNECTED, {roomId: this.roomId, realRoomId: this.room?.roomId ?? null});
        this.logger?.info({event: 'bilibili.connected', roomId: this.room?.roomId ?? this.roomId});
        this.#startHeartbeat(generation);
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
