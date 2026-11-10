import {createId} from '../../shared/ids.mjs';

/**
 * Persistent automatic-monitoring targets.
 *
 * A target is a room (Bilibili) or a channel (YouTube). It is deliberately a
 * separate concept from `sessions`: one target produces any number of
 * independent broadcast sessions over time. Deleting a target never deletes the
 * broadcasts it recorded, and ending a broadcast never deletes the target.
 */

const TARGET_COLUMNS = Object.freeze([
  'display_name',
  'input',
  'broadcaster_id',
  'platform_uid',
  'enabled',
  'state',
  'next_check_at',
  'last_check_at',
  'last_live_at',
  'last_session_id',
  'active_session_id',
  'consecutive_failures',
  'last_error_code',
  'last_error_at',
  'paused_at',
  'meta_json',
  'updated_at'
]);

function normalizeMeta(meta) {
  if (meta === null || meta === undefined) return null;
  if (typeof meta !== 'object' || Array.isArray(meta)) return null;
  try {
    return JSON.stringify(meta);
  } catch {
    return null;
  }
}

export function createMonitorTarget(db, {
  id = null,
  platform,
  targetKey,
  displayName = null,
  input = null,
  broadcasterId = null,
  platformUid = null,
  enabled = true,
  state = 'waiting',
  nextCheckAt = null,
  lastCheckAt = null,
  lastLiveAt = null,
  lastSessionId = null,
  activeSessionId = null,
  consecutiveFailures = 0,
  lastErrorCode = null,
  lastErrorAt = null,
  pausedAt = null,
  meta = null,
  now = Date.now()
} = {}) {
  const targetId = id ?? createId('mon');
  db.prepare(`
    INSERT INTO monitor_targets (
      id, platform, target_key, display_name, input, broadcaster_id, platform_uid,
      enabled, state, next_check_at, last_check_at, last_live_at, last_session_id,
      active_session_id, consecutive_failures, last_error_code, last_error_at,
      paused_at, meta_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(targetId),
    String(platform),
    String(targetKey),
    displayName === null ? null : String(displayName),
    input === null ? null : String(input),
    broadcasterId === null ? null : String(broadcasterId),
    platformUid === null ? null : String(platformUid),
    enabled ? 1 : 0,
    String(state),
    integerOrNull(nextCheckAt),
    integerOrNull(lastCheckAt),
    integerOrNull(lastLiveAt),
    lastSessionId === null ? null : String(lastSessionId),
    activeSessionId === null ? null : String(activeSessionId),
    Number.isFinite(Number(consecutiveFailures)) ? Math.max(0, Math.trunc(Number(consecutiveFailures))) : 0,
    lastErrorCode === null ? null : String(lastErrorCode),
    integerOrNull(lastErrorAt),
    integerOrNull(pausedAt),
    normalizeMeta(meta),
    Number(now),
    Number(now)
  );
  return getMonitorTarget(db, targetId);
}

function integerOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

export function getMonitorTarget(db, targetId) {
  if (targetId === null || targetId === undefined) return null;
  return db.prepare('SELECT * FROM monitor_targets WHERE id = ?').get(String(targetId)) ?? null;
}

export function findMonitorTargetByKey(db, platform, targetKey) {
  return db.prepare('SELECT * FROM monitor_targets WHERE platform = ? AND target_key = ?')
    .get(String(platform), String(targetKey)) ?? null;
}

export function findMonitorTargetForSession(db, sessionId) {
  if (sessionId === null || sessionId === undefined) return null;
  return db.prepare(`
    SELECT * FROM monitor_targets
     WHERE active_session_id = ? OR last_session_id = ?
     ORDER BY CASE WHEN active_session_id = ? THEN 0 ELSE 1 END
     LIMIT 1
  `).get(String(sessionId), String(sessionId), String(sessionId)) ?? null;
}

export function listMonitorTargets(db) {
  return db.prepare('SELECT * FROM monitor_targets ORDER BY created_at ASC').all();
}

export function listActiveMonitorTargets(db) {
  return db.prepare('SELECT * FROM monitor_targets WHERE enabled = 1 ORDER BY created_at ASC').all();
}

/**
 * Patch a target. Unknown keys are rejected rather than silently ignored, so a
 * typo in a scheduler write can never look like it succeeded.
 */
export function updateMonitorTarget(db, targetId, patch = {}) {
  const entries = Object.entries(patch ?? {});
  if (entries.length === 0) return getMonitorTarget(db, targetId);
  const assignments = [];
  const values = [];
  for (const [key, value] of entries) {
    if (!TARGET_COLUMNS.includes(key)) throw new Error(`unknown monitor target column: ${key}`);
    assignments.push(`${key} = ?`);
    if (key === 'enabled') values.push(value ? 1 : 0);
    else if (key === 'meta_json') values.push(normalizeMeta(value));
    else if ([
      'next_check_at',
      'last_check_at',
      'last_live_at',
      'last_error_at',
      'paused_at',
      'updated_at'
    ].includes(key)) values.push(integerOrNull(value));
    else if (key === 'consecutive_failures') values.push(Math.max(0, Math.trunc(Number(value) || 0)));
    else values.push(value === null || value === undefined ? null : String(value));
  }
  values.push(String(targetId));
  db.prepare(`UPDATE monitor_targets SET ${assignments.join(', ')} WHERE id = ?`).run(...values);
  return getMonitorTarget(db, targetId);
}

export function deleteMonitorTarget(db, targetId) {
  const id = String(targetId);
  db.prepare('UPDATE sessions SET monitor_target_id = NULL WHERE monitor_target_id = ?').run(id);
  const result = db.prepare('DELETE FROM monitor_targets WHERE id = ?').run(id);
  return result.changes > 0;
}

/** Sessions produced by one persistent target, newest first. */
export function listMonitorTargetSessions(db, targetId, {limit = 20} = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  return db.prepare(`
    SELECT s.*,
           (SELECT COUNT(*) FROM viewer_sessions vs WHERE vs.session_id = s.id) AS unique_viewer_count,
           (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id) AS event_count
      FROM sessions s
     WHERE s.monitor_target_id = ?
     ORDER BY s.started_at DESC
     LIMIT ?
  `).all(String(targetId), safeLimit);
}

/**
 * Clear references to a permanently deleted session. The target itself and its
 * other broadcasts are untouched.
 */
export function clearMonitorSessionReferences(db, sessionId) {
  const id = String(sessionId);
  db.prepare(`
    UPDATE monitor_targets
       SET active_session_id = CASE WHEN active_session_id = ? THEN NULL ELSE active_session_id END,
           last_session_id = CASE WHEN last_session_id = ? THEN NULL ELSE last_session_id END,
           updated_at = ?
     WHERE active_session_id = ? OR last_session_id = ?
  `).run(id, id, Date.now(), id, id);
}

export const __internal = {TARGET_COLUMNS, normalizeMeta};
