/**
 * Minimal browser-like WebSocket fake for the TikTok webcast transport tests.
 *
 * It records outgoing frames, lets a test open/drop the socket and deliver
 * binary frames, and never touches the network.
 */
export class FakeWebSocket {
  static instances = [];

  static reset() {
    FakeWebSocket.instances = [];
  }

  static get last() {
    return FakeWebSocket.instances.at(-1) ?? null;
  }

  constructor(url, options = {}) {
    this.url = url;
    this.options = options;
    this.readyState = 0;
    this.listeners = new Map();
    this.sent = [];
    this.closeCalls = [];
    FakeWebSocket.instances.push(this);
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
    this.sent.push(Buffer.from(data));
  }

  close(code = 1000, reason = '') {
    this.closeCalls.push({code, reason});
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', {code, reason});
  }

  /** Mark the handshake complete and fire `open`. */
  open() {
    this.readyState = 1;
    this.emit('open', {});
  }

  /** Deliver one binary frame. */
  deliver(buffer) {
    const bytes = Buffer.from(buffer);
    this.emit('message', {data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)});
  }

  /** Simulate the server dropping the connection. */
  drop({code = 1006, reason = ''} = {}) {
    this.readyState = 3;
    this.emit('close', {code, reason});
  }
}

/** A fetch fake that returns whatever `handler` decides for each call. */
export function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({url: String(url), options});
    const result = await handler(String(url), options, calls.length);
    if (result instanceof Error) throw result;
    return result;
  };
  impl.calls = calls;
  return impl;
}

export function jsonResponse(body, {status = 200, headers = {}} = {}) {
  const map = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    status,
    headers: {
      get(name) {
        return map.get(String(name).toLowerCase()) ?? null;
      },
      getSetCookie() {
        return [];
      }
    },
    async text() {
      return JSON.stringify(body);
    },
    async json() {
      return body;
    }
  };
}

export function cookieResponse(cookies, {status = 200, body = '<html></html>'} = {}) {
  const setCookies = Array.isArray(cookies) ? cookies : [cookies];
  return {
    status,
    headers: {
      get() {
        return null;
      },
      getSetCookie() {
        return setCookies;
      }
    },
    async text() {
      return body;
    },
    async json() {
      return {};
    }
  };
}
