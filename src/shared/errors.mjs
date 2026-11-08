/**
 * Error type used across the app. `code` is stable and machine readable;
 * `messageKey` maps to the shared i18n catalogue on both the launcher and the
 * web console. Raw platform/user data is never placed into `message`.
 */
export class AppError extends Error {
  constructor(code, {messageKey = null, details = null, cause = null, httpStatus = 500} = {}) {
    super(code);
    this.name = 'AppError';
    this.code = code;
    this.messageKey = messageKey ?? code;
    this.details = details ?? null;
    this.httpStatus = httpStatus;
    if (cause) this.cause = cause;
  }

  toJSON() {
    return {
      code: this.code,
      messageKey: this.messageKey,
      details: this.details
    };
  }
}

export const ERROR_CODES = Object.freeze({
  EVENT_INVALID: 'EVENT_INVALID',
  SETTINGS_INVALID: 'SETTINGS_INVALID',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_ACTIVE: 'SESSION_ACTIVE',
  SESSION_NOT_ACTIVE: 'SESSION_NOT_ACTIVE',
  VIEWER_NOT_FOUND: 'VIEWER_NOT_FOUND',
  DATABASE_ERROR: 'DATABASE_ERROR',
  DATA_DIR_UNWRITABLE: 'DATA_DIR_UNWRITABLE',
  NOT_FOUND: 'NOT_FOUND',
  BAD_REQUEST: 'BAD_REQUEST',
  FORBIDDEN: 'FORBIDDEN',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL'
});

export function isAppError(value) {
  return value instanceof AppError;
}

export function toAppError(value, fallbackCode = ERROR_CODES.INTERNAL) {
  if (isAppError(value)) return value;
  const error = new AppError(fallbackCode, {cause: value});
  if (value && typeof value.message === 'string') error.details = null;
  return error;
}
