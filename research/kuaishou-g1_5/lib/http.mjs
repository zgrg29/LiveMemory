// Kuaishou G1.5 research prototype — HTTP + cookie plumbing.
//
// Zero dependency: node:fetch. No TLS fingerprinting, no proxy, no browser
// automation. Headers here are ordinary document/API headers that any plain
// HTTP client can send; nothing tries to look like a different device.

import {KuaishouError, CODES, asKuaishouError} from './errors.mjs';

export const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Parse a JSON body that may be double-encoded (Kuaishou sometimes returns a JSON string). */
export function parseJsonLoose(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    const once = JSON.parse(text);
    if (typeof once === 'string') {
      try {
        return JSON.parse(once);
      } catch {
        return once;
      }
    }
    return once;
  } catch {
    return null;
  }
}

/**
 * One HTTP request. Never retries by itself: retry policy belongs to the
 * transport so a rate limit is observable instead of hidden.
 */
export async function request(url, {method = 'GET', headers = {}, body = undefined, timeoutMs = 20000, redirect = 'follow'} = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body,
      redirect,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    throw asKuaishouError(err);
  }
  let text = '';
  try {
    text = await res.text();
  } catch (err) {
    throw asKuaishouError(err);
  }
  return {
    status: res.status,
    url: res.url,
    headers: res.headers,
    setCookies: typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [],
    text,
    json: parseJsonLoose(text)
  };
}

export async function requestJson(url, options = {}) {
  const res = await request(url, options);
  if (res.status >= 400) {
    throw new KuaishouError(CODES.HTTP, `HTTP ${res.status}`, {
      retryable: res.status === 429 || res.status >= 500,
      detail: {status: res.status, url},
    });
  }
  if (res.json === null) {
    throw new KuaishouError(CODES.UPSTREAM, '响应不是 JSON', {detail: {status: res.status, sample: res.text.slice(0, 120)}});
  }
  return res;
}

export function formBody(fields) {
  return new URLSearchParams(fields).toString();
}

/**
 * Minimal cookie jar. Kuaishou's login flow needs the Set-Cookie values later,
 * but this prototype keeps them in memory only; nothing is written to disk.
 */
export class CookieJar {
  #cookies = new Map();

  get size() {
    return this.#cookies.size;
  }

  absorb(setCookies = []) {
    for (const line of setCookies) {
      const pair = String(line).split(';')[0] ?? '';
      const i = pair.indexOf('=');
      if (i <= 0) continue;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      const attrs = String(line).toLowerCase();
      const expired = /max-age\s*=\s*(?:0|-\d+)/.test(attrs);
      if (expired) this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
  }

  get(name) {
    return this.#cookies.get(name) ?? '';
  }

  header() {
    return [...this.#cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  clear() {
    this.#cookies.clear();
  }

  /** Names only — safe to print. */
  names() {
    return [...this.#cookies.keys()];
  }
}

/** Sleep that can be cancelled by a stop signal. */
export function sleep(ms, signal) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      cleanup();
      resolve();
    }
    function abort() {
      cleanup();
      reject(new KuaishouError(CODES.STOPPED, '已停止', {retryable: false}));
    }
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', abort);
    }
    if (signal?.aborted) abort();
    else signal?.addEventListener?.('abort', abort, {once: true});
  });
}
