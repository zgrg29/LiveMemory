import {AppError} from '../../shared/errors.mjs';

/**
 * Errors raised by the YouTube public-web chat client and adapter.
 *
 * Kept in its own module so the anonymous implementation no longer depends on
 * the removed official Data API client. Codes are stable and map to localized
 * `errors.youtube*` keys in the web console.
 */
export const YOUTUBE_ERRORS = Object.freeze({
  RATE_LIMITED: 'YOUTUBE_RATE_LIMITED',
  CHAT_ENDED: 'YOUTUBE_CHAT_ENDED',
  CHAT_NOT_FOUND: 'YOUTUBE_CHAT_NOT_FOUND',
  CHAT_DISABLED: 'YOUTUBE_CHAT_DISABLED',
  VIDEO_NOT_FOUND: 'YOUTUBE_VIDEO_NOT_FOUND',
  WEB_NETWORK: 'YOUTUBE_WEB_NETWORK',
  WEB_BLOCKED: 'YOUTUBE_WEB_BLOCKED',
  WEB_PROTOCOL: 'YOUTUBE_WEB_PROTOCOL',
  WEB_STALE: 'YOUTUBE_WEB_STALE',
  WEB_RESTRICTED: 'YOUTUBE_WEB_RESTRICTED',
  WEB_NOT_CONFIGURED: 'YOUTUBE_WEB_NOT_CONFIGURED'
});

export class YouTubeApiError extends AppError {
  constructor(code, {
    messageKey = 'errors.youtubeWebProtocol',
    httpStatus = 502,
    details = null,
    cause = null,
    reason = null,
    status = null
  } = {}) {
    super(code, {messageKey, httpStatus, details, cause});
    this.name = 'YouTubeApiError';
    this.reason = reason;
    this.status = status;
  }
}
