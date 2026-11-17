import {AppError} from '../../shared/errors.mjs';

/**
 * Kuaishou error codes.
 *
 * The anonymous H5 route is technically reachable but has not been authorised
 * for production collection. Every failure keeps its own code so the UI, the
 * monitor and the tests can distinguish "not permitted", "not live", "rate
 * limited", "risk control" and "network down" instead of collapsing them into
 * one generic error.
 */
export const KUAISHOU_ERRORS = Object.freeze({
  LINK_INVALID: 'KUAISHOU_LINK_INVALID',
  AUTHORIZATION_REQUIRED: 'KUAISHOU_AUTHORIZATION_REQUIRED',
  ACCESS_DENIED: 'KUAISHOU_ACCESS_DENIED',
  ROOM_NOT_FOUND: 'KUAISHOU_ROOM_NOT_FOUND',
  ROOM_OFFLINE: 'KUAISHOU_ROOM_OFFLINE',
  RATE_LIMITED: 'KUAISHOU_RATE_LIMITED',
  RISK_CONTROL: 'KUAISHOU_RISK_CONTROL',
  NETWORK: 'KUAISHOU_NETWORK',
  TIMEOUT: 'KUAISHOU_TIMEOUT',
  HTTP: 'KUAISHOU_HTTP',
  UPSTREAM: 'KUAISHOU_UPSTREAM',
  PROTOCOL: 'KUAISHOU_PROTOCOL',
  STATUS_UNKNOWN: 'KUAISHOU_STATUS_UNKNOWN',
  NOT_CONFIGURED: 'KUAISHOU_NOT_CONFIGURED',
  STOPPED: 'KUAISHOU_STOPPED'
});

/** Codes worth retrying with backoff. */
const RETRYABLE = new Set([
  KUAISHOU_ERRORS.NETWORK,
  KUAISHOU_ERRORS.TIMEOUT,
  KUAISHOU_ERRORS.RATE_LIMITED,
  KUAISHOU_ERRORS.HTTP
]);

export class KuaishouError extends AppError {
  constructor(code, {
    messageKey = null,
    httpStatus = 502,
    details = null,
    cause = null,
    retryable = RETRYABLE.has(code),
    retryAfterMs = null
  } = {}) {
    super(code, {messageKey, httpStatus, details, cause});
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

export function isKuaishouError(error) {
  return error instanceof AppError && String(error.code ?? '').startsWith('KUAISHOU_');
}

/**
 * Business `result` codes observed on the anonymous H5 feed.
 *
 * Anything unknown stays UPSTREAM: a new platform code must never be mistaken
 * for a successful poll. `601`/`671` are the only codes that end a capture.
 */
export function classifyFeedResult(result, body = {}) {
  const n = Number(result);
  if (n === 1) return null;
  if (n === 601) {
    return new KuaishouError(KUAISHOU_ERRORS.ROOM_OFFLINE, {
      details: {result: n, message: body?.error_msg ?? null},
      retryable: false
    });
  }
  if (n === 671) {
    return new KuaishouError(KUAISHOU_ERRORS.ROOM_OFFLINE, {
      details: {result: n, message: body?.error_msg ?? null},
      retryable: false
    });
  }
  if (n === 2) {
    return new KuaishouError(KUAISHOU_ERRORS.RATE_LIMITED, {
      details: {result: n, message: body?.error_msg ?? null},
      retryable: true
    });
  }
  if (n === 109) {
    return new KuaishouError(KUAISHOU_ERRORS.ACCESS_DENIED, {
      details: {result: n, message: body?.error_msg ?? null},
      retryable: false
    });
  }
  if (n === 22) {
    return new KuaishouError(KUAISHOU_ERRORS.ROOM_NOT_FOUND, {
      details: {result: n},
      retryable: false
    });
  }
  if (n === 400002) {
    return new KuaishouError(KUAISHOU_ERRORS.RISK_CONTROL, {
      details: {result: n},
      retryable: false
    });
  }
  return new KuaishouError(KUAISHOU_ERRORS.UPSTREAM, {
    details: {result: result ?? null, message: body?.error_msg ?? body?.message ?? null},
    retryable: false
  });
}

/** Exponential backoff with a small jitter; shared by polling and status checks. */
export function backoffDelay(attempt, {baseMs = 3200, maxMs = 60000, jitter = 0.2, random = Math.random} = {}) {
  const exp = Math.min(maxMs, Math.max(1, baseMs) * 2 ** Math.max(0, attempt));
  const spread = exp * jitter;
  return Math.max(0, Math.round(exp - spread + random() * spread));
}
