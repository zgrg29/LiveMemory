/**
 * One internal error type for every automatic-analysis failure. The runner
 * stores only the stable code and a short, content-free detail; chat text,
 * prompts and provider responses are never written to the status file or log.
 */
export class AutoAnalysisError extends Error {
  constructor(code, {
    detail = null,
    providerId = null,
    httpStatus = null,
    retryable = false,
    retryAfterMs = null,
    cause = null
  } = {}) {
    super(code);
    this.name = 'AutoAnalysisError';
    this.code = code;
    this.detail = detail;
    this.providerId = providerId;
    this.httpStatus = httpStatus;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.cause = cause ?? null;
  }
}

export function isAutoAnalysisError(error) {
  return error instanceof AutoAnalysisError;
}

/** A short, non-sensitive label for logs and the status payload. */
export function errorDetail(error) {
  if (!error) return null;
  const parts = [];
  if (error.providerId) parts.push(String(error.providerId));
  if (error.httpStatus) parts.push(`HTTP ${error.httpStatus}`);
  if (error.detail) parts.push(String(error.detail).slice(0, 240));
  return parts.length > 0 ? parts.join(' · ') : null;
}
