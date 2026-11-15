import {AppError} from '../../shared/errors.mjs';

/**
 * Stable Twitch error codes.
 *
 * The anonymous IRC path is a public, read-only compatibility path, not a
 * documented stable API. Codes stay separate from Bilibili/YouTube so the
 * console can explain exactly what failed instead of collapsing every failure
 * into a generic network error.
 */
export const TWITCH_ERRORS = Object.freeze({
  LINK_INVALID: 'TWITCH_LINK_INVALID',
  CHANNEL_NOT_FOUND: 'TWITCH_CHANNEL_NOT_FOUND',
  CHANNEL_OFFLINE: 'TWITCH_CHANNEL_OFFLINE',
  CHANNEL_UNAVAILABLE: 'TWITCH_CHANNEL_UNAVAILABLE',
  CHAT_UNAVAILABLE: 'TWITCH_CHAT_UNAVAILABLE',
  RATE_LIMITED: 'TWITCH_RATE_LIMITED',
  NETWORK: 'TWITCH_NETWORK',
  PROTOCOL: 'TWITCH_PROTOCOL',
  CONNECT_TIMEOUT: 'TWITCH_CONNECT_TIMEOUT',
  WEBSOCKET_UNAVAILABLE: 'TWITCH_WEBSOCKET_UNAVAILABLE',
  STOPPED: 'TWITCH_STOPPED',
  NOT_CONFIGURED: 'TWITCH_NOT_CONFIGURED'
});

export class TwitchError extends AppError {
  constructor(code, {
    messageKey = 'errors.twitchError',
    httpStatus = 502,
    details = null,
    cause = null,
    retryAfterMs = null,
    status = null
  } = {}) {
    super(code, {messageKey, httpStatus, details, cause});
    this.name = 'TwitchError';
    this.retryAfterMs = retryAfterMs;
    this.status = status;
  }
}

export function twitchError(code, options = {}) {
  return new TwitchError(code, options);
}
