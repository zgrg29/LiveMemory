import {
  listSessionsNeedingPlatformRepair,
  setSessionPlatformStatus
} from '../../storage/repositories/sessions.mjs';
import {
  PLATFORM_END_QUALITY,
  PLATFORM_STATUS,
  platformStatusFromLiveStatus
} from '../../shared/live-status.mjs';

/**
 * Historical Bilibili sessions that were closed by a crash/shutdown may still
 * carry no platform state. We can query the room today, but "the room is
 * offline now" does not prove when the old broadcast ended.
 *
 * Rules:
 * - never change `ended_at` (that is when local capture stopped);
 * - never set `platform_ended_at` from this probe (true end is unknown);
 * - a currently-live room says nothing about an old capture: it may be a new
 *   broadcast, so the old row is marked `unknown`, not `live`;
 * - a user stop or adapter failure is not a repair candidate at all;
 * - the operation is idempotent: once `platform_status` is set the row is no
 *   longer selected.
 */
export function classifyHistoricPlatformStatus(row, liveStatus) {
  const current = platformStatusFromLiveStatus(liveStatus);
  if (current === PLATFORM_STATUS.LIVE) return PLATFORM_STATUS.UNKNOWN;
  if (current === PLATFORM_STATUS.CAROUSEL) return PLATFORM_STATUS.CAROUSEL;
  if (current === PLATFORM_STATUS.NOT_STARTED) {
    // `startup_recovery` rows were recording a live room before the process
    // disappeared. Messages are weaker evidence but still show a broadcast
    // that actually produced activity. With no evidence at all we refuse to
    // guess "ended" versus "never started".
    if (row.end_reason === 'startup_recovery') return PLATFORM_STATUS.ENDED;
    if (Number(row.message_count ?? 0) > 0
      || (row.last_event_at !== null && row.last_event_at !== undefined)) {
      return PLATFORM_STATUS.ENDED;
    }
    return PLATFORM_STATUS.UNKNOWN;
  }
  return PLATFORM_STATUS.UNKNOWN;
}

/**
 * Probe and annotate historic rows. Network failures leave the row untouched so
 * a later run can retry; no failure is interpreted as "offline".
 *
 * @returns {{checked:number, updated:number, failed:number, skipped:number}}
 */
export async function repairBilibiliPlatformStatuses({
  db,
  api,
  rows = null,
  now = Date.now(),
  limit = 25,
  logger = null,
  onUpdated = null
}) {
  const candidates = Array.isArray(rows)
    ? rows
    : listSessionsNeedingPlatformRepair(db, {platform: 'bilibili', limit});
  const result = {checked: 0, updated: 0, failed: 0, skipped: 0};

  for (const row of candidates) {
    if (row?.platform_status !== null && row?.platform_status !== undefined) {
      result.skipped += 1;
      continue;
    }
    const roomId = Number(row?.platform_room_id);
    if (!Number.isInteger(roomId) || roomId <= 0) {
      result.skipped += 1;
      continue;
    }
    result.checked += 1;
    try {
      const observed = await api.roomStatus(roomId, {timeoutMs: 8000});
      if (Number(observed.roomId) !== roomId) {
        result.skipped += 1;
        logger?.warn({
          event: 'session.platform.repair.skipped',
          sessionId: row.id,
          reason: 'room_mismatch'
        });
        continue;
      }
      const platformStatus = classifyHistoricPlatformStatus(row, observed.liveStatus);
      setSessionPlatformStatus(db, row.id, {
        status: platformStatus,
        at: now,
        // The true platform end is unknown. Do not copy the last message time
        // or the shutdown time into `platform_ended_at`.
        platformEndedAt: null,
        endQuality: PLATFORM_END_QUALITY.UNKNOWN,
        now
      });
      result.updated += 1;
      logger?.info({
        event: 'session.platform.repaired',
        sessionId: row.id,
        platform: 'bilibili',
        currentLiveStatus: observed.liveStatus,
        platformStatus,
        endQuality: PLATFORM_END_QUALITY.UNKNOWN,
        endedAtUnchanged: true,
        source: 'startup_probe'
      });
      try {
        onUpdated?.(row.id);
      } catch {
        /* a listener failure must not stop the repair loop */
      }
    } catch (error) {
      result.failed += 1;
      logger?.warn({
        event: 'session.platform.repair.failed',
        sessionId: row.id,
        code: error?.code ?? 'unknown',
        httpStatus: error?.status ?? null,
        biliCode: error?.biliCode ?? null
      });
    }
  }
  return result;
}
