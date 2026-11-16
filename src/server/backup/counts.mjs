import {currentSchemaVersion} from '../../storage/database/migrations/index.mjs';

/**
 * Row counts that describe what a backup contains. They are recorded in the
 * manifest and re-read from the snapshot on restore, so a truncated or swapped
 * database is detected even when the ZIP checksums happen to be valid.
 */
export const BACKUP_COUNTED_TABLES = Object.freeze([
  'sessions',
  'events',
  'viewers',
  'broadcasters',
  'viewer_memories',
  'memory_facts',
  'ai_jobs',
  'ai_results',
  'monitor_targets'
]);

export function countBackupRows(db) {
  const counts = {};
  for (const table of BACKUP_COUNTED_TABLES) {
    try {
      counts[table] = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0);
    } catch {
      counts[table] = 0;
    }
  }
  return counts;
}

export function backupDataRange(db) {
  try {
    const row = db.prepare('SELECT MIN(started_at) AS first, MAX(started_at) AS last FROM sessions').get();
    return {
      firstSessionAt: Number.isFinite(Number(row?.first)) ? Number(row.first) : null,
      lastSessionAt: Number.isFinite(Number(row?.last)) ? Number(row.last) : null
    };
  } catch {
    return {firstSessionAt: null, lastSessionAt: null};
  }
}

export function backupSchemaVersion(db) {
  return currentSchemaVersion(db);
}
