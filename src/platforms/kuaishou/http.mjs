import {APP_VERSION} from '../../shared/app-info.mjs';
import {KUAISHOU_ERRORS, KuaishouError} from './errors.mjs';

/**
 * Minimal HTTP plumbing for the anonymous Kuaishou H5 feed.
 *
 * Zero dependency, no cookie jar, no browser automation, no TLS fingerprinting
 * and no proxy. The client identifies itself honestly; if Kuaishou rejects that
 * client or requires a challenge, the request fails and is reported as such.
 */

export const KUAISHOU_LIVE_ORIGIN = 'https://live.kuaishou.com';
export const KUAISHOU_H5_ORIGIN = 'https://livev.m.chenzhongtech.com';
export const KUAISHOU_USER_AGENT = `LiveMemory/${APP_VERSION} (Kuaishou H5; local client)`;

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

function toKuaishouNetworkError(error) {
  if (error instanceof KuaishouError) return error;
  const name = String(error?.name ?? '');
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new KuaishouError(KUAISHOU_ERRORS.TIMEOUT, {
      details: {reason: 'timeout'},
      cause: error
    });
  }
  return new KuaishouError(KUAISHOU_ERRORS.NETWORK, {
    details: {reason: String(error?.code ?? 'fetch_failed')},
    cause: error
  });
}

/**
 * One request. Never retries by itself: the adapter owns retry/backoff so a
 * rate limit stays observable instead of being hidden inside the client.
 *
 * @returns {Promise<{status:number, url:string, headers:Headers, text:string, json:any}>}
 */
export async function requestText(url, {
  fetchImpl = globalThis.fetch,
  headers = {},
  timeoutMs = 20000,
  signal = null
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new KuaishouError(KUAISHOU_ERRORS.NOT_CONFIGURED, {
      httpStatus: 503,
      details: {reason: 'fetch_unavailable'}
    });
  }
  const timeout = AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 20000));
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: combined
    });
  } catch (error) {
    throw toKuaishouNetworkError(error);
  }

  let text = '';
  try {
    text = await response.text();
  } catch (error) {
    throw toKuaishouNetworkError(error);
  }
  return {
    status: Number(response.status) || 0,
    url: response.url ?? String(url),
    headers: response.headers ?? new Headers(),
    text,
    json: parseJsonLoose(text)
  };
}

export function assertHttpOk(response, {what = 'Kuaishou request'} = {}) {
  if (response.status >= 200 && response.status < 300) return response;
  if (response.status === 404) {
    throw new KuaishouError(KUAISHOU_ERRORS.ROOM_NOT_FOUND, {
      httpStatus: 404,
      details: {what, status: response.status},
      retryable: false
    });
  }
  if (response.status === 429) {
    throw new KuaishouError(KUAISHOU_ERRORS.RATE_LIMITED, {
      httpStatus: 429,
      details: {what, status: response.status},
      retryable: true
    });
  }
  if (response.status === 403 || response.status === 401) {
    throw new KuaishouError(KUAISHOU_ERRORS.ACCESS_DENIED, {
      httpStatus: 403,
      details: {what, status: response.status},
      retryable: false
    });
  }
  throw new KuaishouError(KUAISHOU_ERRORS.HTTP, {
    httpStatus: response.status >= 500 ? 502 : 400,
    details: {what, status: response.status},
    retryable: response.status >= 500
  });
}

/** Sleep that can be cancelled by a stop signal. */
export function sleep(ms, signal) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    function abort() {
      cleanup();
      reject(new KuaishouError(KUAISHOU_ERRORS.STOPPED, {httpStatus: 409, retryable: false}));
    }
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', abort);
    }
    if (signal?.aborted) abort();
    else signal?.addEventListener?.('abort', abort, {once: true});
  });
}

export const __internal = {toKuaishouNetworkError};
