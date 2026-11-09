import {createId} from '../../shared/ids.mjs';

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

export function listSessions(db, {limit = 50, offset = 0, platform = null, broadcasterId = null, unassigned = false} = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  if (unassigned) {
    return db.prepare(`${SESSION_SELECT} WHERE s.broadcaster_id IS NULL ORDER BY s.started_at DESC LIMIT ? OFFSET ?`)
      .all(safeLimit, safeOffset);
  }
  if (platform && broadcasterId) {
    return db.prepare(`${SESSION_SELECT} WHERE s.platform = ? AND s.broadcaster_id = ? ORDER BY s.started_at DESC LIMIT ? OFFSET ?`)
      .all(String(platform), String(broadcasterId), safeLimit, safeOffset);
  }
  if (broadcasterId) {
    return db.prepare(`${SESSION_SELECT} WHERE s.broadcaster_id = ? ORDER BY s.started_at DESC LIMIT ? OFFSET ?`)
      .all(String(broadcasterId), safeLimit, safeOffset);
  }
  if (platform) {
    return db.prepare(`${SESSION_SELECT} WHERE s.platform = ? ORDER BY s.started_at DESC LIMIT ? OFFSET ?`)
      .all(String(platform), safeLimit, safeOffset);
  }
  return db.prepare(`${SESSION_SELECT} ORDER BY s.started_at DESC LIMIT ? OFFSET ?`)
    .all(safeLimit, safeOffset);
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
 * process was killed (console closed, power loss) no honest "live" session can
 * remain open afterwards.
 */
export function recoverInterruptedSessions(db, {now = Date.now()} = {}) {
  const rows = db.prepare("SELECT id FROM sessions WHERE status = 'live'").all();
  if (rows.length === 0) return [];
  db.prepare(`
    UPDATE sessions
       SET status = 'interrupted',
           ended_at = COALESCE(last_event_at, started_at),
           updated_at = ?
     WHERE status = 'live'
  `).run(now);
  return rows.map((row) => row.id);
}

export function endSession(db, sessionId, {status = SESSION_STATUS.ENDED, endedAt = Date.now()} = {}) {
  const row = getSession(db, sessionId);
  if (!row) return null;
  db.prepare('UPDATE sessions SET status = ?, ended_at = ?, updated_at = ? WHERE id = ?')
    .run(status, endedAt, endedAt, String(sessionId));
  return getSession(db, sessionId);
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
