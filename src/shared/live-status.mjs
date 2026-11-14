/**
 * Platform live status is deliberately separate from the local capture status.
 *
 * `sessions.status` answers "is LiveMemory recording this session?".
 * `sessions.platform_status` answers "what did the platform last tell us about
 * the broadcast?". A connected WebSocket, a quiet chat or a local stop must
 * never be interpreted as proof that the broadcast is still live.
 */
export const PLATFORM_STATUS = Object.freeze({
  LIVE: 'live',
  ENDED: 'ended',
  NOT_STARTED: 'not_started',
  CAROUSEL: 'carousel',
  UNKNOWN: 'unknown',
  /** Internal transitional state while an end signal is being confirmed. */
  ENDING: 'ending'
});

export const PLATFORM_STATUS_VALUES = Object.freeze(Object.values(PLATFORM_STATUS));

/** How the platform-side end time was established. */
export const PLATFORM_END_QUALITY = Object.freeze({
  /** A live WebSocket end event for this room, confirmed by a status query. */
  EVENT: 'event',
  /** Two consecutive valid status queries reported a non-live state. */
  POLL: 'poll',
  /** The end time could not be established; never invent one. */
  UNKNOWN: 'unknown'
});

export const PLATFORM_END_QUALITY_VALUES = Object.freeze(Object.values(PLATFORM_END_QUALITY));

/**
 * Bilibili `live_status`:
 *   0 not started, 1 live, 2 carousel/replay loop.
 * Anything else is unknown and must never be treated as "offline".
 */
export function platformStatusFromLiveStatus(value) {
  const status = Number(value);
  if (status === 1) return PLATFORM_STATUS.LIVE;
  if (status === 0) return PLATFORM_STATUS.NOT_STARTED;
  if (status === 2) return PLATFORM_STATUS.CAROUSEL;
  return PLATFORM_STATUS.UNKNOWN;
}

export function normalizePlatformStatus(value) {
  const status = String(value ?? '');
  return PLATFORM_STATUS_VALUES.includes(status) ? status : null;
}

export function normalizePlatformEndQuality(value) {
  const quality = String(value ?? '');
  return PLATFORM_END_QUALITY_VALUES.includes(quality) ? quality : null;
}
