import {AppError} from '../../shared/errors.mjs';

/**
 * TikTok LIVE error codes.
 *
 * One prefix (`TIKTOK_`) so the UI, monitoring and the API can classify them
 * without knowing which module threw. Nothing here is ever turned into a fake
 * success: a room that is not live, a socket that cannot be opened and a
 * throttled anonymous device-cookie request each have their own code.
 *
 * The unified capture is the anonymous local WebSocket. It has no login step,
 * no signing provider and no browser automation, so those codes are gone.
 */
export const TIKTOK_ERRORS = Object.freeze({
  LINK_INVALID: 'TIKTOK_LINK_INVALID',
  ROOM_NOT_FOUND: 'TIKTOK_ROOM_NOT_FOUND',
  ROOM_OFFLINE: 'TIKTOK_ROOM_OFFLINE',
  ROOM_UNAVAILABLE: 'TIKTOK_ROOM_UNAVAILABLE',
  NETWORK: 'TIKTOK_NETWORK',
  RATE_LIMITED: 'TIKTOK_RATE_LIMITED',
  PROTOCOL: 'TIKTOK_PROTOCOL',
  CONNECT_TIMEOUT: 'TIKTOK_CONNECT_TIMEOUT',
  SOCKET_FAILED: 'TIKTOK_SOCKET_FAILED',
  NOT_CONFIGURED: 'TIKTOK_NOT_CONFIGURED',
  STOPPED: 'TIKTOK_STOPPED'
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
