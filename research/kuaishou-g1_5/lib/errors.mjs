// Kuaishou G1.5 research prototype — error taxonomy.
//
// Every failure is classified once, so the CLI, the transports and the report
// never collapse "rate limited", "not live", "login required" and "network
// down" into one generic failure. This mirrors the production adapter rule
// that permission/network/upstream failures must stay distinguishable.

export const CODES = Object.freeze({
  NETWORK: 'NETWORK',
  TIMEOUT: 'TIMEOUT',
  HTTP: 'HTTP',
  RATE_LIMITED: 'RATE_LIMITED',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  RISK_CONTROL: 'RISK_CONTROL',
  OFFLINE: 'OFFLINE',
  NOT_FOUND: 'NOT_FOUND',
  UPSTREAM: 'UPSTREAM',
  UNSUPPORTED: 'UNSUPPORTED',
  CONFIG: 'CONFIG',
  /** The route is technically reachable but platform rules forbid it. */
  POLICY_BLOCKED: 'POLICY_BLOCKED',
  STOPPED: 'STOPPED'
});

/** Codes that are worth retrying with backoff. */
const RETRYABLE = new Set([CODES.NETWORK, CODES.TIMEOUT, CODES.RATE_LIMITED]);

export class KuaishouError extends Error {
  constructor(code, message, {retryable = RETRYABLE.has(code), detail = null, cause = null} = {}) {
    super(message);
    this.name = 'KuaishouError';
    this.code = code;
    this.retryable = retryable;
    this.detail = detail;
    if (cause) this.cause = cause;
  }
}

export function asKuaishouError(err) {
  if (err instanceof KuaishouError) return err;
  const name = String(err?.name ?? '');
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new KuaishouError(CODES.TIMEOUT, '请求超时', {cause: err});
  }
  return new KuaishouError(CODES.NETWORK, String(err?.message ?? err), {cause: err});
}

/**
 * Business `result` codes seen on Kuaishou endpoints.
 * The mapping is deliberately conservative: anything unknown stays UPSTREAM so
 * a new platform code can never be mistaken for success.
 */
export function classifyResult(result, body = {}) {
  const n = Number(result);
  if (n === 1) return null;
  if (n === 601) return new KuaishouError(CODES.OFFLINE, '直播已停止', {retryable: false, detail: {result: n}});
  if (n === 2) return new KuaishouError(CODES.RATE_LIMITED, '平台限流/风控（result=2）', {retryable: true, detail: {result: n}});
  if (n === 109) return new KuaishouError(CODES.AUTH_REQUIRED, '需要登录（result=109）', {retryable: false, detail: {result: n}});
  if (n === 22) return new KuaishouError(CODES.NOT_FOUND, '没有这个直播间（result=22）', {retryable: false, detail: {result: n}});
  if (n === 671) return new KuaishouError(CODES.OFFLINE, '主播未开播（result=671）', {retryable: false, detail: {result: n}});
  if (n === 400002) return new KuaishouError(CODES.RISK_CONTROL, '平台要求人机验证（result=400002）', {retryable: false, detail: {result: n}});
  return new KuaishouError(CODES.UPSTREAM, `未知业务码（result=${result}）`, {
    retryable: false,
    detail: {result: result ?? null, error: body?.error_msg ?? body?.message ?? null}
  });
}

/** Backoff with jitter; used by every transport. */
export function backoffDelay(attempt, {baseMs = 1000, maxMs = 30000, jitter = 0.2} = {}) {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  const spread = exp * jitter;
  return Math.max(0, Math.round(exp - spread + Math.random() * spread));
}
