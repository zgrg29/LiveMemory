import {AppError} from '../shared/errors.mjs';
import {MONITOR_ERROR_HTTP, monitorErrorKey} from './constants.mjs';

/**
 * A monitoring failure with a stable code and a translatable message key.
 * Platform-specific errors are converted at the detector boundary so the state
 * machine only ever deals with monitor codes.
 */
export function monitorError(code, {details = null, cause = null, httpStatus = null, messageKey = null} = {}) {
  return new AppError(code, {
    messageKey: messageKey ?? monitorErrorKey(code),
    httpStatus: httpStatus ?? MONITOR_ERROR_HTTP[code] ?? 502,
    details,
    cause
  });
}
