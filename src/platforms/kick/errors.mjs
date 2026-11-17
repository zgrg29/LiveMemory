import {AppError} from '../../shared/errors.mjs';

/**
 * Kick error codes.
 *
 * One prefix (`KICK_`) so the API, monitoring and tests can classify a failure
 * without knowing which module threw it. A blocked request, a missing room, an
 * offline room and a failed socket each get their own code: none of them is
 * ever reported as a successful capture.
 *
 * G1 scope: the Kick transport is not wired into routes or the UI yet, so no
 * `kick*` message keys exist in `src/web/i18n/*.json`. When the adapter is
 * wired (G2), every code below must gain a translated key in all ten
 * dictionaries at the same time. Until then `messageKey` is the code itself and
 * is only read by tests, the PoC and the logs.
 */
export const KICK_ERRORS = Object.freeze({
  LINK_INVALID: 'KICK_LINK_INVALID',
  ROOM_NOT_FOUND: 'KICK_ROOM_NOT_FOUND',
  ROOM_OFFLINE: 'KICK_ROOM_OFFLINE',
  ROOM_UNAVAILABLE: 'KICK_ROOM_UNAVAILABLE',
  BLOCKED: 'KICK_BLOCKED',
  NETWORK: 'KICK_NETWORK',
  RATE_LIMITED: 'KICK_RATE_LIMITED',
  PROTOCOL: 'KICK_PROTOCOL',
  CONNECT_TIMEOUT: 'KICK_CONNECT_TIMEOUT',
  SOCKET_FAILED: 'KICK_SOCKET_FAILED',
  NOT_CONFIGURED: 'KICK_NOT_CONFIGURED',
  STOPPED: 'KICK_STOPPED'
});

export class KickError extends AppError {
  constructor(code, {messageKey = null, httpStatus = 502, status = null, details = null, cause = null, retryAfterMs = null} = {}) {
    super(code, {messageKey, httpStatus, status, details, cause});
    this.retryAfterMs = retryAfterMs;
  }
}

export function isKickError(error) {
  return error instanceof AppError && String(error.code ?? '').startsWith('KICK_');
}
