import {withTransaction} from '../storage/database/connection.mjs';
import {AppError} from '../shared/errors.mjs';
import {DAY} from '../shared/time.mjs';
import {
  countVersions,
  deleteMemory,
  getMemory,
  listFacts,
  listStaleMemories,
  memoryOverview
} from '../storage/repositories/viewer-memory.mjs';

/**
 * Memory lifecycle: delete one viewer's memory, clean up stale memories and
 * describe the retention policy.
 *
 * Deleting is a real delete of facts, evidence and version snapshots. Only a
 * tombstone head row survives, and it exists solely to block an older AI package
 * from silently restoring what the user removed.
 */

export const MEMORY_DEFAULT_STALE_DAYS = 365;
export const MEMORY_MIN_STALE_DAYS = 30;
export const MEMORY_MAX_STALE_DAYS = 3650;

export function normalizeStaleDays(value, fallback = MEMORY_DEFAULT_STALE_DAYS) {
  const days = Number(value);
  if (!Number.isFinite(days)) return fallback;
  return Math.min(MEMORY_MAX_STALE_DAYS, Math.max(MEMORY_MIN_STALE_DAYS, Math.trunc(days)));
}

/**
 * Delete one `broadcaster × viewer` memory.
 *
 * @returns {{deleted:boolean, reason?:string, memoryId?:string, factsRemoved?:number, versionsRemoved?:number}}
 */
export function deleteViewerMemory({db, broadcasterId, viewerId, confirm = false, reason = 'user', now = Date.now()}) {
  if (confirm !== true) {
    throw new AppError('MEMORY_DELETE_CONFIRM_REQUIRED', {
      messageKey: 'errors.memoryDeleteConfirmRequired',
      httpStatus: 400
    });
  }
  if (!broadcasterId) {
    throw new AppError('MEMORY_BROADCASTER_REQUIRED', {
      messageKey: 'errors.memoryBroadcasterRequired',
      httpStatus: 400
    });
  }
  const memory = getMemory(db, {broadcasterId, viewerId});
  if (!memory) return {deleted: false, reason: 'MEMORY_NOT_FOUND'};
  if (memory.status === 'deleted') return {deleted: false, reason: 'MEMORY_ALREADY_DELETED', memoryId: memory.id};
  const factsRemoved = memory.status === 'active' ? listFacts(db, memory.id, {limit: 2000}).length : 0;
  const versionsRemoved = countVersions(db, memory.id);
  const deleted = withTransaction(db, () => deleteMemory(db, {memoryId: memory.id, reason, now}));
  return {
    deleted: true,
    memoryId: deleted.id,
    viewerId: deleted.viewerId,
    broadcasterId: deleted.broadcasterId,
    factsRemoved,
    versionsRemoved,
    deletedAt: deleted.deletedAt
  };
}

/** Remove memories of viewers not seen for a long time (manual maintenance). */
export function pruneStaleMemories({db, broadcasterId, olderThanDays, dryRun = false, now = Date.now()}) {
  const days = normalizeStaleDays(olderThanDays);
  const stale = listStaleMemories(db, {
    broadcasterId,
    olderThanMs: days * DAY,
    now,
    limit: 1000
  });
  if (dryRun) {
    return {
      dryRun: true,
      days,
      candidates: stale.length,
      facts: stale.reduce((sum, row) => sum + row.factCount, 0),
      viewers: stale.slice(0, 20)
    };
  }
  const removed = withTransaction(db, () => {
    const rows = [];
    for (const entry of stale) {
      const outcome = deleteMemory(db, {memoryId: entry.memoryId, reason: 'stale_prune', now});
      if (outcome) rows.push({viewerId: entry.viewerId, factCount: entry.factCount});
    }
    return rows;
  });
  return {
    dryRun: false,
    days,
    candidates: stale.length,
    removed: removed.length,
    facts: removed.reduce((sum, row) => sum + row.factCount, 0)
  };
}

/**
 * Describe what is stored and for how long.
 *
 * The policy is deliberately explicit: memories are kept until the user deletes
 * them (or clears data), while evidence follows the raw-chat retention window of
 * its platform. There is no automatic expiry of a *memory* — that would silently
 * destroy knowledge the streamer relies on.
 */
export function memoryRetentionStatus(db, {broadcasterId = null} = {}) {
  const overview = memoryOverview(db, {broadcasterId});
  const evidence = db.prepare(`
    SELECT f.evidence_status AS status, COUNT(*) AS count
      FROM memory_facts f
      JOIN viewer_memories m ON m.id = f.memory_id
      ${broadcasterId ? 'WHERE m.broadcaster_id = ?' : ''}
     GROUP BY f.evidence_status
  `).all(...(broadcasterId ? [String(broadcasterId)] : []));
  const byStatus = {};
  for (const row of evidence) byStatus[row.status ?? 'none'] = Number(row.count ?? 0);
  const versions = db.prepare(`
    SELECT COUNT(*) AS count FROM memory_versions
     ${broadcasterId
    ? 'WHERE memory_id IN (SELECT id FROM viewer_memories WHERE broadcaster_id = ?)'
    : ''}
  `).get(...(broadcasterId ? [String(broadcasterId)] : []));
  return {
    policy: 'viewer-memory',
    keepUntilDeleted: true,
    evidenceFollowsRawRetention: true,
    deletedMemories: overview.deletedMemories,
    activeMemories: overview.activeMemories,
    facts: overview.facts,
    byStatus: overview.byStatus,
    byCertainty: overview.byCertainty,
    evidenceByStatus: byStatus,
    versions: Number(versions?.count ?? 0),
    staleDaysDefault: MEMORY_DEFAULT_STALE_DAYS,
    staleDaysMin: MEMORY_MIN_STALE_DAYS,
    staleDaysMax: MEMORY_MAX_STALE_DAYS
  };
}

export const __internal = {normalizeStaleDays};
