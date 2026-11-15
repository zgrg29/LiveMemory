import {AppError} from '../../shared/errors.mjs';

/**
 * TikTok LIVE error codes.
 *
 * One prefix (`TIKTOK_`) so the UI, monitoring and the API can classify them
 * without knowing which module threw. Nothing here is ever turned into a fake
 * success: a blocked access-control response (login required) and a missing
 * signed-URL provider are reported as their own codes.
 */
export const TIKTOK_ERRORS = Object.freeze({
  LINK_INVALID: 'TIKTOK_LINK_INVALID',
  ROOM_NOT_FOUND: 'TIKTOK_ROOM_NOT_FOUND',
  ROOM_OFFLINE: 'TIKTOK_ROOM_OFFLINE',
  ROOM_UNAVAILABLE: 'TIKTOK_ROOM_UNAVAILABLE',
  LOGIN_REQUIRED: 'TIKTOK_LOGIN_REQUIRED',
  NETWORK: 'TIKTOK_NETWORK',
  RATE_LIMITED: 'TIKTOK_RATE_LIMITED',
  PROTOCOL: 'TIKTOK_PROTOCOL',
  CONNECT_TIMEOUT: 'TIKTOK_CONNECT_TIMEOUT',
  SIGNER_UNAVAILABLE: 'TIKTOK_SIGNER_UNAVAILABLE',
  SIGNER_PREMIUM_REQUIRED: 'TIKTOK_SIGNER_PREMIUM_REQUIRED',
  NOT_CONFIGURED: 'TIKTOK_NOT_CONFIGURED',
  STOPPED: 'TIKTOK_STOPPED',
  BROWSER_UNAVAILABLE: 'TIKTOK_BROWSER_UNAVAILABLE',
  BROWSER_FAILED: 'TIKTOK_BROWSER_FAILED'
});

export class TikTokError extends AppError {
  constructor(code, {messageKey = null, httpStatus = 502, status = null, details = null, cause = null, retryAfterMs = null} = {}) {
    super(code, {messageKey, httpStatus, status, details, cause});
    this.retryAfterMs = retryAfterMs;
  }
}

export function isTikTokError(error) {
  return error instanceof AppError && String(error.code ?? '').startsWith('TIKTOK_');
}
