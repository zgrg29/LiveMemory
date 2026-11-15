import {AppError} from '../../shared/errors.mjs';

/**
 * Douyin (抖音) live error codes.
 *
 * They are platform-specific so the HTTP layer can map each one to a stable
 * status and a translatable message key. They never leak a cookie, a signature
 * or a raw platform payload.
 */
export const DOUYIN_ERRORS = Object.freeze({
  LINK_INVALID: 'DOUYIN_LINK_INVALID',
  ROOM_NOT_FOUND: 'DOUYIN_ROOM_NOT_FOUND',
  ROOM_OFFLINE: 'DOUYIN_ROOM_OFFLINE',
  ROOM_ENDED: 'DOUYIN_ROOM_ENDED',
  NETWORK: 'DOUYIN_NETWORK',
  RATE_LIMITED: 'DOUYIN_RATE_LIMITED',
  BLOCKED: 'DOUYIN_BLOCKED',
  PROTOCOL: 'DOUYIN_PROTOCOL',
  SIGNATURE_FAILED: 'DOUYIN_SIGNATURE_FAILED',
  CONNECT_TIMEOUT: 'DOUYIN_CONNECT_TIMEOUT',
  WEBSOCKET_UNAVAILABLE: 'DOUYIN_WEBSOCKET_UNAVAILABLE',
  LOGIN_REQUIRED: 'DOUYIN_LOGIN_REQUIRED',
  LOGIN_BLOCKED: 'DOUYIN_LOGIN_BLOCKED',
  LOGIN_EXPIRED: 'DOUYIN_LOGIN_EXPIRED',
  QR_MISSING: 'DOUYIN_QR_MISSING',
  AUTH: 'DOUYIN_AUTH',
  NOT_CONFIGURED: 'DOUYIN_NOT_CONFIGURED',
  STOPPED: 'DOUYIN_STOPPED'
});

export class DouyinError extends AppError {
  constructor(code, {messageKey = 'errors.douyinError', httpStatus = 502, details = null, cause = null} = {}) {
    super(code, {messageKey, httpStatus, details, cause});
    this.name = 'DouyinError';
  }
}

export const __internal = {DOUYIN_ERRORS};
