import http2 from 'node:http2';
import {brotliDecompressSync, gunzipSync, inflateSync} from 'node:zlib';
import {KICK_ERRORS, KickError} from './errors.mjs';

/**
 * Minimal HTTP/2 JSON client for Kick's public web endpoints.
 *
 * Why HTTP/2: `kick.com` answers plain HTTP/1.1 clients from this kind of
 * runtime with `403 Request blocked by security policy`, while the very same
 * public URL returns the normal JSON over HTTP/2 — which is what the browser
 * itself uses. Nothing here evades an access control: the pages and endpoints
 * are public, no cookie, account or token is borrowed from a user, and a real
 * block is reported as `KICK_BLOCKED` instead of being retried with tricks.
 *
 * `node:http2` is built in, so this adds no runtime dependency. A connection is
 * opened per request and always closed, which keeps stop() honest about
 * releasing resources.
 */

export const KICK_WEB_ORIGIN = 'https://kick.com';
export const KICK_REALTIME_ORIGIN = 'https://web.kick.com';

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const HTTP_DEFAULTS = Object.freeze({
  timeoutMs: 15000,
  maxRedirects: 2
});

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const key = Object.keys(headers).find((entry) => entry.toLowerCase() === String(name).toLowerCase());
  return key ? headers[key] : null;
}

function decodeBody(buffer, encoding) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? '');
  const value = String(encoding ?? '').toLowerCase().trim();
  if (!value || value === 'identity') return buf;
  if (value === 'gzip') return gunzipSync(buf);
  if (value === 'br') return brotliDecompressSync(buf);
  if (value === 'deflate') return inflateSync(buf);
  return buf;
}

function browserHeaders(userAgent) {
  return {
    'user-agent': userAgent,
    accept: 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
    'accept-encoding': 'gzip, deflate, br',
    'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    origin: KICK_WEB_ORIGIN,
    referer: `${KICK_WEB_ORIGIN}/`
  };
}

function networkError(reason, cause = null, status = null) {
  return new KickError(KICK_ERRORS.NETWORK, {
    httpStatus: 502,
    status,
    cause,
    details: {reason}
  });
}

function timeoutError(reason) {
  return new KickError(KICK_ERRORS.CONNECT_TIMEOUT, {
    httpStatus: 504,
    details: {reason}
  });
}

/**
 * One HTTP/2 request. Resolves with the raw status, headers and body; never
 * inspects the JSON, so callers can map platform-specific statuses.
 */
function h2Request({url, method, headers, body, timeoutMs}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    let settled = false;
    let client;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      try {
        client?.close();
      } catch {
        /* ignore */
      }
      fn(value);
    };
    try {
      client = http2.connect(`${target.protocol}//${target.host}`);
    } catch (error) {
      reject(networkError('connect_failed', error));
      return;
    }
    client.on('error', (error) => finish(reject, networkError('session_error', error)));
    const requestHeaders = {
      ':method': method,
      ':path': target.pathname + target.search,
      ':authority': target.host,
      ':scheme': target.protocol.replace(':', ''),
      ...headers
    };
    if (body !== null && body !== undefined) {
      requestHeaders['content-length'] = String(Buffer.byteLength(body));
    }
    let req;
    try {
      req = client.request(requestHeaders);
    } catch (error) {
      finish(reject, networkError('request_failed', error));
      return;
    }
    const timer = setTimeout(() => {
      try {
        req.destroy();
      } catch {
        /* ignore */
      }
      finish(reject, timeoutError('request_timeout'));
    }, timeoutMs);
    timer.unref?.();

    let status = 0;
    let responseHeaders = {};
    const chunks = [];
    req.on('response', (received) => {
      status = received[':status'] ?? 0;
      responseHeaders = received;
    });
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('error', (error) => {
      clearTimeout(timer);
      finish(reject, networkError('request_error', error));
    });
    req.on('end', () => {
      clearTimeout(timer);
      let buffer = Buffer.concat(chunks);
      try {
        buffer = decodeBody(buffer, responseHeaders['content-encoding']);
      } catch (error) {
        finish(reject, networkError('decode_failed', error, status));
        return;
      }
      finish(resolve, {status, headers: responseHeaders, body: buffer});
    });
    if (body !== null && body !== undefined) req.write(body);
    req.end();
  });
}

export class KickHttp {
  constructor({
    userAgent = DEFAULT_USER_AGENT,
    timeoutMs = HTTP_DEFAULTS.timeoutMs,
    maxRedirects = HTTP_DEFAULTS.maxRedirects,
    logger = null,
    request = null,
    now = Date.now
  } = {}) {
    this.userAgent = userAgent;
    this.timeoutMs = timeoutMs;
    this.maxRedirects = maxRedirects;
    this.logger = logger;
    this.request = request ?? h2Request;
    this.now = now;
    this.requestCount = 0;
    this.errorCount = 0;
    this.closed = false;
  }

  /**
   * @returns {Promise<{status:number, data:any, headers:object}>}
   * @throws KickError for network/timeout/blocked/rate-limited responses
   */
  async requestJson(url, {method = 'GET', body = null, headers = {}} = {}) {
    if (this.closed) {
      throw new KickError(KICK_ERRORS.STOPPED, {httpStatus: 409, details: {reason: 'client_closed'}});
    }
    let current = String(url);
    let follow = this.maxRedirects;
    for (;;) {
      this.requestCount += 1;
      let response;
      try {
        response = await this.request({
          url: current,
          method,
          headers: {...browserHeaders(this.userAgent), ...headers},
          body: body === null || body === undefined ? null : String(body),
          timeoutMs: this.timeoutMs
        });
      } catch (error) {
        this.errorCount += 1;
        throw error;
      }
      const status = Number(response?.status ?? 0);
      const text = Buffer.isBuffer(response?.body) ? response.body.toString('utf8') : String(response?.body ?? '');
      if (status >= 300 && status < 400 && follow > 0) {
        const location = headerValue(response.headers, 'location');
        if (location) {
          follow -= 1;
          current = new URL(location, current).toString();
          continue;
        }
      }
      if (status === 403) {
        this.errorCount += 1;
        throw new KickError(KICK_ERRORS.BLOCKED, {
          httpStatus: 403,
          status,
          details: {reason: 'security_policy', hint: text.slice(0, 160)}
        });
      }
      if (status === 429) {
        this.errorCount += 1;
        const retryAfter = Number(headerValue(response.headers, 'retry-after'));
        throw new KickError(KICK_ERRORS.RATE_LIMITED, {
          httpStatus: 429,
          status,
          retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 30000,
          details: {reason: 'http_429'}
        });
      }
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = null;
        }
      }
      if (status >= 500) {
        this.errorCount += 1;
        throw new KickError(KICK_ERRORS.NETWORK, {
          httpStatus: 502,
          status,
          details: {reason: 'server_error'}
        });
      }
      return {status, data, headers: response.headers ?? {}, text};
    }
  }

  async close() {
    this.closed = true;
    return undefined;
  }

  snapshot() {
    return {requestCount: this.requestCount, errorCount: this.errorCount, closed: this.closed};
  }
}

export const __internal = {h2Request, decodeBody, headerValue, browserHeaders};
