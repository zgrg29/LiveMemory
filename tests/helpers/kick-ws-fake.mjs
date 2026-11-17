/**
 * Minimal text WebSocket fake for the Kick Centrifugo tests.
 *
 * Records every outgoing JSON frame, lets a test open/deliver/drop the socket
 * and — with `autoHandshake` — acknowledges the connect and subscribe frames
 * like the real server, so an adapter can start without any network access.
 */
export class KickFakeWebSocket {
  static instances = [];
  static autoHandshake = false;
  static ackConnect = true;
  static ackTtl = 2700;

  static reset({autoHandshake = false, ackConnect = true, ttl = 2700} = {}) {
    KickFakeWebSocket.instances = [];
    KickFakeWebSocket.autoHandshake = autoHandshake;
    KickFakeWebSocket.ackConnect = ackConnect;
    KickFakeWebSocket.ackTtl = ttl;
  }

  static get last() {
    return KickFakeWebSocket.instances.at(-1) ?? null;
  }

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    this.sent = [];
    this.closeCalls = [];
    KickFakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (this.readyState === 0) this.open();
    });
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  emit(type, event = {}) {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  send(data) {
    if (this.readyState !== 1) throw new Error('socket is not open');
    const text = String(data);
    let frame = null;
    try {
      frame = JSON.parse(text);
    } catch {
      frame = null;
    }
    this.sent.push(frame ?? text);
    if (!KickFakeWebSocket.autoHandshake || !frame) return;
    if (frame.connect && KickFakeWebSocket.ackConnect) {
      queueMicrotask(() => this.deliver({id: frame.id, connect: {client: 'fake-client', version: '6.9.7 PRO', ttl: KickFakeWebSocket.ackTtl, ping: 25}}));
      return;
    }
    if (frame.subscribe) {
      queueMicrotask(() => this.deliver({id: frame.id, subscribe: {}}));
    }
  }

  /** Deliver a JSON document (object or raw string). */
  deliver(document) {
    this.emit('message', {data: typeof document === 'string' ? document : JSON.stringify(document)});
  }

  /** Deliver several documents batched in one WebSocket message. */
  deliverBatch(documents) {
    this.emit('message', {data: documents.map((doc) => (typeof doc === 'string' ? doc : JSON.stringify(doc))).join('\n')});
  }

  /** Server ping frame: an empty object the client must echo. */
  ping() {
    this.emit('message', {data: '{}'});
  }

  open() {
    this.readyState = 1;
    this.emit('open', {});
  }

  close(code = 1000, reason = '') {
    this.closeCalls.push({code, reason});
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', {code, reason});
  }

  /** Simulate the server or network dropping the connection. */
  drop({code = 1006, reason = ''} = {}) {
    this.readyState = 3;
    this.emit('close', {code, reason});
  }

  error(message = 'socket error') {
    this.emit('error', {message, error: new Error(message)});
  }

  /** Outgoing frames that are subscriptions, for assertions. */
  get subscriptions() {
    return this.sent.filter((frame) => frame && frame.subscribe).map((frame) => frame.subscribe.channel);
  }
}

/** Fake KickHttp: returns canned `{status, data}` responses per URL. */
export function fakeKickHttp(handler) {
  const calls = [];
  const impl = {
    async requestJson(url, options = {}) {
      calls.push({url: String(url), options});
      const result = await handler(String(url), options, calls.length);
      if (result instanceof Error) throw result;
      return result;
    },
    async close() {
      impl.closed = true;
    },
    calls,
    closed: false
  };
  return impl;
}

export function jsonResult(data, status = 200) {
  return {status, data, headers: {}, text: JSON.stringify(data ?? null)};
}

export const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(check, {timeout = 5000, interval = 5, label = 'condition'} = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`waitFor timeout: ${label}`);
    await tick(interval);
  }
}
