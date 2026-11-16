/**
 * Time helpers. Every timestamp persisted by LiveMemory is an integer number of
 * milliseconds since the Unix epoch (UTC), which keeps bucketing and ordering
 * cheap and unambiguous. Formatting for humans happens in the web console.
 */

export function toEpochMs(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : fallback;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return fallback;
    // Accept both epoch seconds and epoch milliseconds.
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  const text = String(value).trim();
  if (!text) return fallback;
  if (/^\d+(\.\d+)?$/.test(text)) {
    const numeric = Number(text);
    return numeric < 1e12 ? Math.round(numeric * 1000) : Math.round(numeric);
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function isoFromEpochMs(value) {
  if (value === null || value === undefined) return null;
  const ms = toEpochMs(value, null);
  return ms === null ? null : new Date(ms).toISOString();
}

export function epochMsFromIso(value) {
  return toEpochMs(value, null);
}

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Human readable duration for the console and API payloads. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms) || 0) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = Math.floor(total % 60);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}
