import {createId} from '../../shared/ids.mjs';
import {
  normalizePlatformEndQuality,
  normalizePlatformStatus,
  PLATFORM_STATUS
} from '../../shared/live-status.mjs';

/**
 * Session persistence. A session is one live broadcast capture window.
 *
 * Counters are maintained inside the ingest transaction so the live UI can read
 * cheap aggregates without scanning the raw event table. Monetary totals are
 * deliberately not stored as a single column: they are keyed by currency and by
 * value kind (actual payment vs display value) in session_currency_totals.
 */
export const SESSION_STATUS = Object.freeze({
  LIVE: 'live',
  ENDED: 'ended',
  INTERRUPTED: 'interrupted'
});

const SESSION_SELECT = `
  SELECT s.*,
         (SELECT COUNT(*) FROM viewer_sessions vs WHERE vs.session_id = s.id) AS unique_viewer_count,
         (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id) AS event_count
  FROM sessions s
`;

export function createSession(db, {
  id = null,
  platform,
  platformRoomId = null,
  roomTitle = null,
  broadcasterName = null,
  broadcasterId = null,
  broadcasterIdentity = 'unresolved',
  storageMode = 'compact',
  sourceQuality = 'unknown',
  simulated = false,
  startedAt = Date.now(),
  platformStartedAt = null,
  now = startedAt
}) {
  const sessionId = id ?? createId('ses');
  db.prepare(`
    INSERT INTO sessions (
      id, platform, platform_room_id, room_title, broadcaster_name, broadcaster_id,
      broadcaster_identity, status,
      storage_mode, source_quality, simulated, started_at, platform_started_at, ended_at, last_event_at,
      message_count, gift_event_count, payment_event_count, ai_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'live', ?, ?, ?, ?, ?, NULL, NULL, 0, 0, 0, 'none', ?, ?)
  `).run(
    sessionId,
    String(platform),
    platformRoomId === null ? null : String(platformRoomId),
    roomTitle === null ? null : String(roomTitle),
    broadcasterName === null ? null : String(broadcasterName),
    broadcasterId === null || broadcasterId === undefined ? null : String(broadcasterId),
    String(broadcasterIdentity ?? 'unresolved'),
    storageMode === 'full' ? 'full' : 'compact',
    String(sourceQuality),
    simulated ? 1 : 0,
    startedAt,
    platformStartedAt === null || platformStartedAt === undefined ? null : Math.trunc(Number(platformStartedAt)),
    now,
    now
  );
  return getSession(db, sessionId);
}

export function getSession(db, sessionId) {
  const row = db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(String(sessionId));
  return row ?? null;
}

export function listSessions(db, {
  limit = 50,
  offset = 0,
  platform = null,
  broadcasterId = null,
  unassigned = false,
  includeArchived = true,
  archivedOnly = false
} = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const clauses = [];
  const params = [];
  if (unassigned) {
    clauses.push('s.broadcaster_id IS NULL');
  }
  if (platform) {
    clauses.push('s.platform = ?');
    params.push(String(platform));
  }
  if (broadcasterId) {
    clauses.push('s.broadcaster_id = ?');
    params.push(String(broadcasterId));
  }
  if (archivedOnly) clauses.push('s.archived_at IS NOT NULL');
  else if (!includeArchived) clauses.push('s.archived_at IS NULL');
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(safeLimit, safeOffset);
  return db.prepare(`${SESSION_SELECT} ${where} ORDER BY s.started_at DESC LIMIT ? OFFSET ?`).all(...params);
}

export function findLiveSession(db) {
  return db.prepare(`${SESSION_SELECT} WHERE s.status = 'live' ORDER BY s.started_at DESC LIMIT 1`).get() ?? null;
}

/** Every session that is currently marked live, oldest first. */
export function listLiveSessions(db) {
  return db.prepare(`${SESSION_SELECT} WHERE s.status = 'live' ORDER BY s.started_at ASC`).all();
}

/**
 * The database-side duplicate guard. In-memory recordings are checked first by
 * SessionManager; this catches a live row that has no in-memory adapter (for
 * example after a partial failure) so the same room is never recorded twice.
 */
export function findLiveSessionByRoom(db, platform, platformRoomId) {
  if (platformRoomId === null || platformRoomId === undefined) return null;
  return db.prepare(`
    ${SESSION_SELECT}
     WHERE s.status = 'live' AND s.platform = ? AND s.platform_room_id = ?
     ORDER BY s.started_at ASC LIMIT 1
  `).get(String(platform), String(platformRoomId)) ?? null;
}

/**
 * Mark every still-live session as interrupted. Called once at startup: if the
 * process was killed (console closed, power loss) no honest "live" capture can
 * remain open afterwards.
 *
 * `ended_at` is the moment recovery observed the abandoned capture, not the
 * last chat message and not the platform's end time. The last message is often
 * hours earlier and must never be presented as the broadcast end. The platform
 * status stays NULL until a later probe has real evidence; `platform_ended_at`
 * stays NULL because the true end time is unknown.
 *
 * @returns {Array<object>} the rows that were recovered (for a follow-up probe)
 */
export function recoverInterruptedSessions(db, {now = Date.now()} = {}) {
  const rows = db.prepare(`
    SELECT id, platform, platform_room_id, status, started_at, last_event_at,
           message_count, end_reason
      FROM sessions
     WHERE status = 'live'
     ORDER BY started_at ASC
  `).all();
  if (rows.length === 0) return [];
  db.prepare(`
    UPDATE sessions
       SET status = 'interrupted',
           ended_at = ?,
           end_reason = 'startup_recovery',
           updated_at = ?
     WHERE status = 'live'
  `).run(now, now);
  return rows.map((row) => ({...row, status: SESSION_STATUS.INTERRUPTED, ended_at: now}));
}

/**
 * Historical rows that were left without any platform state. Only captures that
 * ended because the process went away are eligible: a user stop, an adapter
 * failure or an already classified platform end is never rewritten here.
 */
export function listSessionsNeedingPlatformRepair(db, {
  platform = 'bilibili',
  limit = 25
} = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  return db.prepare(`
    SELECT *
      FROM sessions
     WHERE platform = ?
       AND platform_status IS NULL
       AND status IN ('ended', 'interrupted')
       AND (end_reason IS NULL OR end_reason IN ('shutdown', 'startup_recovery'))
     ORDER BY started_at DESC
     LIMIT ?
  `).all(String(platform), safeLimit);
}

/**
 * Record a platform observation without touching the capture status.
 *
 * A live observation clears any unconfirmed end evidence; an `ending` or
 * non-live observation records the observation time but never invents a
 * platform end time. Only a confirmed end may pass `platformEndedAt`.
 */
export function setSessionPlatformStatus(db, sessionId, {
  status,
  at = Date.now(),
  lastLiveSeenAt = null,
  platformEndedAt = null,
  endQuality = null,
  now = at
} = {}) {
  const normalized = normalizePlatformStatus(status);
  if (!normalized) throw new Error(`invalid platform status: ${String(status)}`);
  const quality = normalizePlatformEndQuality(endQuality);
  const id = String(sessionId);
  const rawAt = at === null || at === undefined ? now : at;
  const observedAt = Number.isFinite(Number(rawAt)) ? Math.trunc(Number(rawAt)) : Number(now);

  if (normalized === PLATFORM_STATUS.LIVE) {
    const liveAt = lastLiveSeenAt === null || lastLiveSeenAt === undefined
      ? observedAt
      : (Number.isFinite(Number(lastLiveSeenAt)) ? Math.trunc(Number(lastLiveSeenAt)) : observedAt);
    db.prepare(`
      UPDATE sessions
         SET platform_status = ?,
             platform_status_at = ?,
             last_live_seen_at = CASE
               WHEN last_live_seen_at IS NULL OR last_live_seen_at < ? THEN ?
               ELSE last_live_seen_at
             END,
             platform_ended_at = NULL,
             platform_end_quality = NULL,
             updated_at = ?
       WHERE id = ?
    `).run(normalized, observedAt, liveAt, liveAt, Number(now), id);
  } else {
    // Do not coerce null/undefined through Number(): Number(null) is 0, which
    // would fabricate a 1970 end time or a last-live time.
    const liveAt = lastLiveSeenAt === null || lastLiveSeenAt === undefined
      ? null
      : (Number.isFinite(Number(lastLiveSeenAt)) ? Math.trunc(Number(lastLiveSeenAt)) : null);
    const endedAt = platformEndedAt === null || platformEndedAt === undefined
      ? null
      : (Number.isFinite(Number(platformEndedAt)) ? Math.trunc(Number(platformEndedAt)) : null);
    db.prepare(`
      UPDATE sessions
         SET platform_status = ?,
             platform_status_at = ?,
             last_live_seen_at = CASE
               WHEN ? IS NOT NULL AND (last_live_seen_at IS NULL OR last_live_seen_at < ?) THEN ?
               ELSE last_live_seen_at
             END,
             platform_ended_at = CASE
               WHEN ? IS NOT NULL AND platform_ended_at IS NULL THEN ?
               ELSE platform_ended_at
             END,
             platform_end_quality = CASE
               WHEN ? IS NOT NULL AND platform_end_quality IS NULL THEN ?
               ELSE platform_end_quality
             END,
             updated_at = ?
       WHERE id = ?
    `).run(
      normalized,
      observedAt,
      liveAt,
      liveAt,
      liveAt,
      endedAt,
      endedAt,
      quality,
      quality,
      Number(now),
      id
    );
  }
  return getSession(db, id);
}

/**
 * Close a session. `reason` records why local capture ended and is shown in the
 * UI so a user-initiated stop is never presented as "the broadcast ended".
 */
export function endSession(db, sessionId, {status = SESSION_STATUS.ENDED, endedAt = Date.now(), reason = null} = {}) {
  const row = getSession(db, sessionId);
  if (!row) return null;
  db.prepare('UPDATE sessions SET status = ?, ended_at = ?, end_reason = ?, updated_at = ? WHERE id = ?')
    .run(status, endedAt, reason === null || reason === undefined ? null : String(reason), endedAt, String(sessionId));
  return getSession(db, sessionId);
}

/**
 * Archive or unarchive one session. Archiving never deletes anything and never
 * changes the capture status; a live session must be stopped first.
 * @returns {object|null} the updated row, or null when the session is unknown
 */
export function setSessionArchived(db, sessionId, archived, {now = Date.now()} = {}) {
  const id = String(sessionId);
  if (archived) {
    // Re-archiving keeps the original archive time, so the timestamp is stable.
    db.prepare(`
      UPDATE sessions
         SET archived_at = COALESCE(archived_at, ?), updated_at = ?
       WHERE id = ? AND status <> 'live'
    `).run(now, now, id);
  } else {
    db.prepare('UPDATE sessions SET archived_at = NULL, updated_at = ? WHERE id = ?')
      .run(now, id);
  }
  return getSession(db, id);
}

export function incrementSessionCounters(db, sessionId, {
  messages = 0,
  gifts = 0,
  payments = 0,
  lastEventAt = null,
  now = Date.now()
} = {}) {
  db.prepare(`
    UPDATE sessions
       SET message_count = message_count + ?,
           gift_event_count = gift_event_count + ?,
           payment_event_count = payment_event_count + ?,
           last_event_at = CASE
             WHEN ? IS NULL THEN last_event_at
             WHEN last_event_at IS NULL OR last_event_at < ? THEN ?
             ELSE last_event_at
           END,
           updated_at = ?
     WHERE id = ?
  `).run(messages, gifts, payments, lastEventAt, lastEventAt, lastEventAt, now, String(sessionId));
}

export function touchSession(db, sessionId, {lastEventAt = Date.now(), now = Date.now()} = {}) {
  db.prepare(`
    UPDATE sessions
       SET last_event_at = CASE WHEN last_event_at IS NULL OR last_event_at < ? THEN ? ELSE last_event_at END,
           updated_at = ?
     WHERE id = ?
  `).run(lastEventAt, lastEventAt, now, String(sessionId));
}

export function setSessionAiStatus(db, sessionId, aiStatus, {now = Date.now()} = {}) {
  db.prepare('UPDATE sessions SET ai_status = ?, updated_at = ? WHERE id = ?')
    .run(String(aiStatus), now, String(sessionId));
}

export function deleteSession(db, sessionId) {
  const result = db.prepare('DELETE FROM sessions WHERE id = ?').run(String(sessionId));
  return result.changes > 0;
}
