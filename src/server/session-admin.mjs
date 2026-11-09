import {existsSync, rmSync} from 'node:fs';
import {resolve, sep} from 'node:path';
import {AppError, ERROR_CODES} from '../shared/errors.mjs';
import {withTransaction} from '../storage/database/connection.mjs';
import {
  deleteSession,
  getSession,
  setSessionArchived
} from '../storage/repositories/sessions.mjs';
import {rebuildViewerAggregates} from '../storage/repositories/viewers.mjs';
import {rebuildViewerBroadcasterAggregates} from '../storage/repositories/broadcasters.mjs';

/**
 * Session administration shared by every surface (live recording, history list
 * and history detail): stop one capture, archive/unarchive, and permanently
 * delete one broadcast record.
 *
 * Rules enforced here rather than in the UI:
 * - stopping only touches the requested session (the SessionManager owns the
 *   adapter; this module never enumerates or stops other recordings);
 * - a live capture can never be archived or deleted, even if the browser sends
 *   the request directly;
 * - deleting never removes other sessions, settings, credentials or files
 *   outside the export folder of the deleted session;
 * - the database part of a delete is a single transaction, so a failure leaves
 *   the record exactly as it was.
 */

function sessionNotFound() {
  return new AppError(ERROR_CODES.SESSION_NOT_FOUND, {
    messageKey: 'errors.sessionNotFound',
    httpStatus: 404
  });
}

/**
 * Stop local capture for exactly one session.
 *
 * The platform broadcast is not touched. `status` stays `ended` and
 * `end_reason = user`, which the UI renders as "recording stopped" rather than
 * "the broadcast ended".
 */
export async function stopSessionRecording({deps, sessionId, reason = 'user'}) {
  const id = String(sessionId ?? '');
  const row = getSession(deps.db, id);
  if (!row) throw sessionNotFound();
  if (row.status !== 'live') {
    throw new AppError(ERROR_CODES.SESSION_NOT_ACTIVE, {
      messageKey: 'errors.sessionNotActive',
      httpStatus: 409
    });
  }
  const result = await deps.sessionManager.stopSession(id, {status: 'ended', reason});
  if (!result?.session) throw sessionNotFound();
  return result;
}

/**
 * Archive or unarchive one session.
 * @returns {object} updated session row
 */
export function archiveSession({db, sessionId, archived, manager = null, now = Date.now()}) {
  const id = String(sessionId ?? '');
  const row = getSession(db, id);
  if (!row) throw sessionNotFound();
  // A capture that has not fully stopped must never be hidden behind an archive
  // flag. Both the database status and the in-memory recording are checked.
  if (archived && (row.status === 'live' || manager?.getRecording(id))) {
    throw new AppError('SESSION_ARCHIVE_LIVE', {
      messageKey: 'errors.sessionArchiveLive',
      details: {sessionId: id},
      httpStatus: 409
    });
  }
  const updated = setSessionArchived(db, id, Boolean(archived), {now});
  if (!updated) throw sessionNotFound();
  return updated;
}

/** Files inside the exports folder only; anything else is never deleted. */
function safeExportPath(exportsDir, relativePath) {
  if (!exportsDir || !relativePath) return null;
  const root = resolve(exportsDir);
  const candidate = resolve(root, String(relativePath));
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  return candidate;
}

function countRows(db, sql, ...params) {
  return Number(db.prepare(sql).get(...params)?.count ?? 0);
}

function assertNoResidue(db, sessionId) {
  const checks = [
    ['events', 'session_id'],
    ['viewer_sessions', 'session_id'],
    ['session_currency_totals', 'session_id'],
    ['ai_packages', 'session_id'],
    ['sessions', 'id']
  ];
  for (const [table, column] of checks) {
    const count = countRows(db, `SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`, sessionId);
    if (count !== 0) {
      throw new AppError('SESSION_DELETE_INCOMPLETE', {
        messageKey: 'errors.sessionDeleteIncomplete',
        details: {table, count},
        httpStatus: 500
      });
    }
  }
}

/**
 * Permanently delete one broadcast record and every row that only exists
 * because of it.
 *
 * Deleted: events, per-session viewer participation, per-session currency
 * totals, AI package records (and their files), derived viewer aggregates that
 * lose their last evidence, and broadcaster relationships that lose their last
 * session. Kept: every other session, viewers who still appear elsewhere, the
 * broadcaster's other viewer profiles, settings, credentials and unrelated
 * files.
 */
export async function deleteSessionRecord({deps, sessionId, confirm = false, now = Date.now()}) {
  if (confirm !== true) {
    throw new AppError('DELETE_CONFIRM_REQUIRED', {
      messageKey: 'errors.deleteConfirmRequired',
      httpStatus: 400
    });
  }
  const id = String(sessionId ?? '');
  const db = deps.db;
  const session = getSession(db, id);
  if (!session) throw sessionNotFound();

  // Capture must have fully exited: the row is no longer live AND no adapter is
  // still registered for it. This makes deletion unable to race a running task.
  const recording = deps.sessionManager?.getRecording(id) ?? null;
  if (session.status === 'live' || recording) {
    throw new AppError('SESSION_STILL_RECORDING', {
      messageKey: 'errors.sessionStillRecording',
      details: {sessionId: id},
      httpStatus: 409
    });
  }

  const packages = db.prepare('SELECT id, file_name, relative_path FROM ai_packages WHERE session_id = ?').all(id);
  const viewerIds = db.prepare(`
    SELECT viewer_id FROM viewer_sessions WHERE session_id = ?
    UNION
    SELECT viewer_id FROM events WHERE session_id = ? AND viewer_id IS NOT NULL
  `).all(id, id).map((row) => row.viewer_id);

  const before = {
    events: countRows(db, 'SELECT COUNT(*) AS count FROM events WHERE session_id = ?', id),
    viewerSessions: countRows(db, 'SELECT COUNT(*) AS count FROM viewer_sessions WHERE session_id = ?', id),
    viewers: viewerIds.length,
    packages: packages.length
  };

  const result = withTransaction(db, () => {
    // Explicit child deletes come first so the operation is correct even if a
    // foreign key were ever disabled, and so a mid-way failure rolls everything
    // back inside the same transaction.
    db.prepare('DELETE FROM ai_packages WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM session_currency_totals WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM viewer_sessions WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM events WHERE session_id = ?').run(id);
    if (!deleteSession(db, id)) throw sessionNotFound();

    let viewersRemoved = 0;
    let viewersKept = 0;
    for (const viewerId of viewerIds) {
      const rebuilt = rebuildViewerAggregates(db, viewerId, {now});
      if (rebuilt.removed) {
        viewersRemoved += 1;
      } else if (rebuilt.kept) {
        viewersKept += 1;
        // Only broadcaster contexts that still have remaining sessions survive.
        rebuildViewerBroadcasterAggregates(db, viewerId, {now});
      }
    }

    // Derived broadcaster rows without any remaining session or relationship
    // have no evidence left. This only removes such orphans; a broadcaster that
    // still has other sessions or viewers is untouched.
    db.prepare(`
      DELETE FROM broadcasters
       WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.broadcaster_id = broadcasters.id)
         AND NOT EXISTS (SELECT 1 FROM viewer_broadcasters vb WHERE vb.broadcaster_id = broadcasters.id)
    `).run();

    assertNoResidue(db, id);
    return {viewersRemoved, viewersKept};
  });

  const removedFiles = [];
  const fileErrors = [];
  for (const pkg of packages) {
    const absolute = safeExportPath(deps.paths?.exports, pkg.relative_path);
    if (!absolute) {
      fileErrors.push({name: pkg.relative_path, error: 'unsafe_path'});
      continue;
    }
    try {
      if (existsSync(absolute)) {
        rmSync(absolute, {force: true});
        removedFiles.push(absolute);
      }
    } catch (error) {
      fileErrors.push({name: pkg.relative_path, error: error?.code ?? 'remove_failed'});
    }
  }

  deps.logger?.info({
    event: 'session.deleted',
    sessionId: id,
    platform: session.platform,
    events: before.events,
    packages: before.packages,
    viewersRemoved: result.viewersRemoved,
    filesRemoved: removedFiles.length
  });

  return {
    deleted: true,
    sessionId: id,
    session: {
      id,
      platform: session.platform,
      roomTitle: session.room_title,
      broadcasterName: session.broadcaster_name,
      startedAt: session.started_at
    },
    before,
    viewersRemoved: result.viewersRemoved,
    viewersKept: result.viewersKept,
    packagesRemoved: packages.length,
    removedFiles,
    fileErrors
  };
}

export const __internal = {safeExportPath, assertNoResidue};
