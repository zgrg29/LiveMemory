import {AppError, ERROR_CODES} from './errors.mjs';

/**
 * Shared API errors for concurrent recording.
 *
 * `SESSION_DUPLICATE_ROOM` means the same platform + room is already being
 * recorded; it is not a generic "busy" state, because other rooms may keep
 * running independently. `SESSION_ID_REQUIRED` protects older single-stream
 * clients from stopping the wrong stream once more than one is active.
 */
export function duplicateRoomError(duplicate) {
  return new AppError(ERROR_CODES.SESSION_DUPLICATE_ROOM, {
    messageKey: 'errors.sessionDuplicateRoom',
    details: {
      sessionId: duplicate?.sessionId ?? null,
      platform: duplicate?.session?.platform ?? null,
      roomId: duplicate?.session?.platform_room_id ?? null
    },
    httpStatus: 409
  });
}

export function sessionIdRequiredError(details = null) {
  return new AppError(ERROR_CODES.SESSION_ID_REQUIRED, {
    messageKey: 'errors.sessionIdRequired',
    details,
    httpStatus: 409
  });
}
