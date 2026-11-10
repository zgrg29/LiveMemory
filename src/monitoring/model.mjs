import {
  MONITOR_ERROR,
  MONITOR_ERROR_KEYS,
  MONITOR_INITIAL_STAGGER_MS,
  MONITOR_MAX_RETRY_AFTER_MS,
  MONITOR_STATE,
  monitorErrorKey
} from './constants.mjs';

/**
 * Pure scheduling/state helpers for automatic monitoring.
 *
 * Keeping these functions free of timers and SQL makes the state machine easy to
 * test: the manager only decides *when* to call them.
 */

/** Small deterministic hash so a target keeps a stable initial phase. */
export function hashString(value) {
  let hash = 2166136261;
  const text = String(value ?? '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Clamp an interval and add ±ratio jitter. Never returns below one second. */
export function jittered(baseMs, {random = Math.random, ratio = 0.12} = {}) {
  const base = Math.max(1000, Math.round(Number(baseMs) || 0));
  const span = Math.max(1, Math.round(base * ratio));
  const offset = Math.round((random() * 2 - 1) * span);
  return Math.max(1000, base + offset);
}

/**
 * Stagger the first check of newly added/restored targets so a restart with ten
 * channels does not fire ten requests at once.
 */
export function initialCheckDelay(id, {now = Date.now(), random = Math.random} = {}) {
  const phase = hashString(id) % MONITOR_INITIAL_STAGGER_MS;
  const extra = Math.round(random() * 5000);
  return Math.max(1000, phase + extra);
}

/**
 * Delay before the next check.
 * @param {{policy:object, kind?:'offline'|'upcoming'|'error'|'rate_limited', failures?:number,
 *   retryAfterMs?:number|null, random?:Function}} options
 */
export function retryDelay({
  policy,
  kind = 'offline',
  failures = 0,
  retryAfterMs = null,
  random = Math.random
} = {}) {
  if (!policy) throw new Error('retryDelay requires a platform policy');
  if (kind === 'rate_limited') {
    const retryAfter = Number.isFinite(Number(retryAfterMs)) && Number(retryAfterMs) > 0
      ? Number(retryAfterMs)
      : 5 * 60 * 1000;
    return Math.min(MONITOR_MAX_RETRY_AFTER_MS, Math.max(60000, retryAfter));
  }
  if (kind === 'error') {
    const attempt = Math.max(1, Math.min(Number(failures) || 1, 8));
    const base = Math.min(policy.errorMaxMs, policy.errorBaseMs * 2 ** (attempt - 1));
    return jittered(base, {random, ratio: 0.08});
  }
  const base = Math.min(policy.maxMs, Math.max(policy.minMs, Number(policy.baseMs)));
  return jittered(base, {random, ratio: 0.12});
}

export function isRecordingState(state) {
  return [
    MONITOR_STATE.CONNECTING,
    MONITOR_STATE.RECORDING,
    MONITOR_STATE.ENDING
  ].includes(state);
}

/**
 * The state shown to the user. Capture reconnection is a property of the
 * adapter, not a new broadcast, so it is derived here and never stored as a
 * monitor lifecycle state.
 */
export function derivePublicState({state, enabled, recordingState = null}) {
  const base = String(state ?? MONITOR_STATE.WAITING);
  if (!enabled && !isRecordingState(base)) return MONITOR_STATE.PAUSED;
  if (base === MONITOR_STATE.RECORDING && recordingState === 'reconnecting') return 'reconnecting';
  if (base === MONITOR_STATE.RECORDING && recordingState === 'connecting') return MONITOR_STATE.CONNECTING;
  return base;
}

export function parseMeta(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function monitorErrorOf(row) {
  if (!row?.last_error_code) return null;
  const code = String(row.last_error_code);
  return {
    code,
    at: row.last_error_at ?? null,
    messageKey: MONITOR_ERROR_KEYS[code] ?? monitorErrorKey(MONITOR_ERROR.UNKNOWN)
  };
}

/**
 * Public target shape. `recording` is the live recording snapshot for this
 * target when one exists; the session itself is still read from the sessions
 * table (history and statistics never live on the target row).
 */
export function serializeMonitorTarget(row, {now = Date.now(), recording = null} = {}) {
  if (!row) return null;
  const enabled = Boolean(row.enabled);
  const recordingState = recording?.connection?.state
    ?? (typeof recording?.connection === 'string' ? recording.connection : null);
  const state = derivePublicState({state: row.state, enabled, recordingState});
  const nextCheckAt = row.next_check_at ?? null;
  return {
    id: row.id,
    platform: row.platform,
    targetKey: row.target_key,
    displayName: row.display_name ?? null,
    input: row.input ?? null,
    broadcasterId: row.broadcaster_id ?? null,
    platformUid: row.platform_uid ?? null,
    enabled,
    state,
    baseState: row.state,
    recordingState,
    activeSessionId: row.active_session_id ?? null,
    lastSessionId: row.last_session_id ?? null,
    lastLiveAt: row.last_live_at ?? null,
    lastCheckAt: row.last_check_at ?? null,
    nextCheckAt,
    nextCheckInMs: enabled && nextCheckAt && nextCheckAt > now ? nextCheckAt - now : null,
    consecutiveFailures: Number(row.consecutive_failures ?? 0),
    pausedAt: row.paused_at ?? null,
    error: monitorErrorOf(row),
    meta: parseMeta(row.meta_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function summarizeTargets(targets) {
  const summary = {
    total: targets.length,
    enabled: 0,
    recording: 0,
    waiting: 0,
    error: 0,
    paused: 0
  };
  for (const target of targets) {
    if (target.enabled) summary.enabled += 1;
    if (['recording', 'connecting', 'reconnecting', 'ending'].includes(target.state)) summary.recording += 1;
    else if (target.state === MONITOR_STATE.ERROR) summary.error += 1;
    else if (target.state === MONITOR_STATE.PAUSED) summary.paused += 1;
    else if (target.state === MONITOR_STATE.WAITING) summary.waiting += 1;
  }
  return summary;
}

/**
 * Map platform/adapter errors to stable monitor codes. This decides only how a
 * failure is displayed and how long to back off; it never turns an error into
 * "offline" or ends a recording.
 */
export function classifyMonitorError(error) {
  const code = String(error?.code ?? '');
  if (Object.values(MONITOR_ERROR).includes(code)) {
    return {code, retryAfterMs: error?.details?.retryAfterMs ?? null};
  }
  if (['YOUTUBE_WEB_NETWORK', 'NETWORK', 'CONNECT_TIMEOUT'].includes(code)) {
    return {code: MONITOR_ERROR.NETWORK, retryAfterMs: null};
  }
  if (['YOUTUBE_RATE_LIMITED', 'RATE_LIMITED'].includes(code)) {
    return {code: MONITOR_ERROR.RATE_LIMITED, retryAfterMs: error?.details?.retryAfterMs ?? null};
  }
  if (['YOUTUBE_WEB_BLOCKED', 'YOUTUBE_WEB_RESTRICTED', 'AUTH_REQUIRED', 'FORBIDDEN'].includes(code)) {
    return {code: MONITOR_ERROR.BLOCKED, retryAfterMs: null};
  }
  if (['YOUTUBE_WEB_PROTOCOL', 'YOUTUBE_WEB_STALE', 'BAD_RESPONSE', 'STATUS_INVALID'].includes(code)) {
    return {code: MONITOR_ERROR.PROTOCOL, retryAfterMs: null};
  }
  if ([
    'YOUTUBE_VIDEO_NOT_FOUND',
    'VIDEO_NOT_FOUND',
    'ROOM_NOT_FOUND',
    'YOUTUBE_CHANNEL_NOT_FOUND',
    'UNKNOWN_CHANNEL'
  ].includes(code)) {
    return {code: MONITOR_ERROR.NOT_FOUND, retryAfterMs: null};
  }
  if ([
    'YOUTUBE_CHAT_DISABLED',
    'YOUTUBE_CHAT_NOT_FOUND',
    'YOUTUBE_CHAT_ENDED'
  ].includes(code)) {
    // The broadcast may be live but its public chat cannot be opened. This is a
    // recording blocker, not evidence that the broadcast ended.
    return {code: MONITOR_ERROR.CHAT_UNAVAILABLE, retryAfterMs: null};
  }
  if ([
    'YOUTUBE_NOT_LIVE',
    'YOUTUBE_NOT_LIVE_VIDEO',
    'YOUTUBE_NOT_LIVE_ENDED',
    'ROOM_NOT_LIVE',
    'ROOM_ROUND'
  ].includes(code)) {
    return {code: MONITOR_ERROR.OFFLINE_RACE, retryAfterMs: null};
  }
  if (['WEBSOCKET_UNAVAILABLE', 'YOUTUBE_WEB_NOT_CONFIGURED'].includes(code)) {
    return {code: MONITOR_ERROR.NOT_CONFIGURED, retryAfterMs: null};
  }
  if (['STOPPED', 'ROOM_INVALID'].includes(code)) {
    return {code: MONITOR_ERROR.UNKNOWN, retryAfterMs: null};
  }
  return {code: MONITOR_ERROR.UNKNOWN, retryAfterMs: null};
}

export const __internal = {hashString, jittered, isRecordingState};
