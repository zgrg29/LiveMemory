/**
 * Shared constants for automatic live monitoring.
 *
 * Monitoring is deliberately slow and boring: a check is one read-only request
 * per target, only while the target is NOT being recorded, with jitter and
 * exponential backoff. Detection latency of a few minutes is acceptable; a
 * request storm is not.
 */

export const MONITOR_PLATFORMS = Object.freeze(['bilibili', 'youtube']);

export const MONITOR_STATE = Object.freeze({
  /** Enabled, not live, waiting for the next scheduled check. */
  WAITING: 'waiting',
  /** A read-only platform check is in flight. */
  CHECKING: 'checking',
  /** Live was confirmed and the capture session is being created. */
  CONNECTING: 'connecting',
  /** One broadcast is being recorded. */
  RECORDING: 'recording',
  /** The platform reported an end; the session is being finalised. */
  ENDING: 'ending',
  /** The user paused automatic checks. An ongoing capture may continue. */
  PAUSED: 'paused',
  /** Repeated failure or an unrecoverable input; the user must act. */
  ERROR: 'error'
});

export const MONITOR_STATES = Object.freeze(Object.values(MONITOR_STATE));

/** States in which the target is considered to own a live capture. */
export const MONITOR_RECORDING_STATES = Object.freeze([
  MONITOR_STATE.CONNECTING,
  MONITOR_STATE.RECORDING,
  MONITOR_STATE.ENDING
]);

/**
 * Per-platform schedule. `baseMs` is the normal wait between checks while the
 * target is offline; `minMs`/`maxMs` bound the jitter. Error delays start at
 * `errorBaseMs` and double up to `errorMaxMs`.
 */
export const MONITOR_POLICY = Object.freeze({
  bilibili: Object.freeze({
    platform: 'bilibili',
    /** 1 request/minute per offline room (public room status endpoint). */
    baseMs: 60000,
    minMs: 45000,
    maxMs: 90000,
    errorBaseMs: 60000,
    errorMaxMs: 600000,
    /** Wait a little before looking for a follow-up broadcast. */
    endCooldownMs: 15000,
    maxConsecutiveFailures: 4,
    requestGapMs: 1200
  }),
  youtube: Object.freeze({
    platform: 'youtube',
    /** 1 public channel page request every 3 minutes per offline channel. */
    baseMs: 180000,
    minMs: 120000,
    maxMs: 240000,
    errorBaseMs: 180000,
    errorMaxMs: 1800000,
    endCooldownMs: 20000,
    maxConsecutiveFailures: 4,
    requestGapMs: 2500
  })
});

export function monitorPolicy(platform) {
  const policy = MONITOR_POLICY[String(platform ?? '')];
  if (!policy) throw new Error(`no monitoring policy for platform: ${String(platform)}`);
  return policy;
}

/** Scheduler tick; checks themselves are paced separately. */
export const MONITOR_TICK_MS = 5000;

/** At most two platform checks in parallel, to keep request bursts small. */
export const MONITOR_MAX_CONCURRENT_CHECKS = 2;

/** First check after a target is added or restored is staggered over this window. */
export const MONITOR_INITIAL_STAGGER_MS = 45000;

/** After the failure threshold, keep the target visible and retry slowly. */
export const MONITOR_ERROR_RETRY_MS = 30 * 60 * 1000;

/** Upper bound for an explicit `Retry-After` value. */
export const MONITOR_MAX_RETRY_AFTER_MS = 30 * 60 * 1000;

/**
 * Stable monitor error codes. They are intentionally platform-independent so
 * the UI and the state machine do not need to know Bilibili/YouTube internals.
 */
export const MONITOR_ERROR = Object.freeze({
  NETWORK: 'MONITOR_NETWORK',
  RATE_LIMITED: 'MONITOR_RATE_LIMITED',
  BLOCKED: 'MONITOR_BLOCKED',
  PROTOCOL: 'MONITOR_PROTOCOL',
  NOT_FOUND: 'MONITOR_NOT_FOUND',
  RESTRICTED: 'MONITOR_RESTRICTED',
  OFFLINE_RACE: 'MONITOR_OFFLINE_RACE',
  CHAT_UNAVAILABLE: 'MONITOR_CHAT_UNAVAILABLE',
  DUPLICATE: 'MONITOR_DUPLICATE',
  INVALID_INPUT: 'MONITOR_INVALID_INPUT',
  NOT_CONFIGURED: 'MONITOR_NOT_CONFIGURED',
  UNKNOWN: 'MONITOR_UNKNOWN'
});

/** Translation keys for stored monitor errors (three locales). */
export const MONITOR_ERROR_KEYS = Object.freeze({
  [MONITOR_ERROR.NETWORK]: 'monitoring.error.network',
  [MONITOR_ERROR.RATE_LIMITED]: 'monitoring.error.rateLimited',
  [MONITOR_ERROR.BLOCKED]: 'monitoring.error.blocked',
  [MONITOR_ERROR.PROTOCOL]: 'monitoring.error.protocol',
  [MONITOR_ERROR.NOT_FOUND]: 'monitoring.error.notFound',
  [MONITOR_ERROR.RESTRICTED]: 'monitoring.error.restricted',
  [MONITOR_ERROR.OFFLINE_RACE]: 'monitoring.error.offlineRace',
  [MONITOR_ERROR.CHAT_UNAVAILABLE]: 'monitoring.error.chatUnavailable',
  [MONITOR_ERROR.DUPLICATE]: 'monitoring.error.duplicate',
  [MONITOR_ERROR.INVALID_INPUT]: 'monitoring.error.invalidInput',
  [MONITOR_ERROR.NOT_CONFIGURED]: 'monitoring.error.notConfigured',
  [MONITOR_ERROR.UNKNOWN]: 'monitoring.error.unknown'
});

export function monitorErrorKey(code) {
  return MONITOR_ERROR_KEYS[String(code ?? '')] ?? MONITOR_ERROR_KEYS[MONITOR_ERROR.UNKNOWN];
}

/** HTTP status used when a monitor operation itself fails synchronously. */
export const MONITOR_ERROR_HTTP = Object.freeze({
  [MONITOR_ERROR.INVALID_INPUT]: 400,
  [MONITOR_ERROR.NOT_FOUND]: 404,
  [MONITOR_ERROR.RATE_LIMITED]: 429,
  [MONITOR_ERROR.BLOCKED]: 429,
  [MONITOR_ERROR.RESTRICTED]: 403,
  [MONITOR_ERROR.NETWORK]: 502,
  [MONITOR_ERROR.PROTOCOL]: 502,
  [MONITOR_ERROR.CHAT_UNAVAILABLE]: 409,
  [MONITOR_ERROR.NOT_CONFIGURED]: 409
});

export const MONITOR_TARGET_INPUT_MAX_LENGTH = 400;
