import {existsSync, mkdirSync, readdirSync, rmSync, statSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {join, resolve} from 'node:path';
import {homedir} from 'node:os';
import {AppError} from '../shared/errors.mjs';
import {withTransaction} from '../storage/database/connection.mjs';

/**
 * Destructive data management: an optional emergency database snapshot, two
 * clearly separated deletion modes, and the post-deletion reinitialisation.
 *
 * `data` keeps preferences, login credentials, the data-folder pointer and
 * backups. `factory` additionally removes preferences, credentials, caches and
 * logs and restores settings defaults. Neither mode ever deletes the data root
 * itself or any file outside LiveMemory's own managed folders.
 */

const CLEARED_TABLES = Object.freeze([
  'monitor_targets',
  'sessions',
  'events',
  'viewers',
  'viewer_nicknames',
  'viewer_sessions',
  'viewer_currency_totals',
  'session_currency_totals',
  'viewer_broadcasters',
  'viewer_broadcaster_currency_totals',
  'broadcasters',
  'ai_packages',
  'ai_jobs',
  'ai_job_batches',
  'ai_job_messages',
  'ai_job_viewers',
  'ai_results',
  'ai_result_evidence',
  'ai_translation_runs',
  'ai_translations',
  'viewer_memories',
  'memory_facts',
  'memory_fact_evidence',
  'memory_versions',
  'memory_jobs',
  'memory_job_batches',
  'memory_job_messages',
  'memory_job_viewers',
  'memory_results'
]);

function tableCounts(db) {
  const counts = {};
  for (const table of CLEARED_TABLES) {
    try {
      counts[table] = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0);
    } catch {
      counts[table] = 0;
    }
  }
  return counts;
}

export function clearPreview(db, paths, {env = process.env} = {}) {
  const live = db.prepare("SELECT id FROM sessions WHERE status = 'live' LIMIT 1").get();
  return {
    dataDir: paths.root,
    counts: tableCounts(db),
    recording: Boolean(live),
    activeSessionId: live?.id ?? null,
    backupDir: backupDirectory({env}),
    backupHint: 'database-only-emergency-snapshot'
  };
}

export function backupDirectory({env = process.env, platform = process.platform, home = homedir()} = {}) {
  if (env.LIVE_MEMORY_BACKUP_DIR) return resolve(String(env.LIVE_MEMORY_BACKUP_DIR));
  if (platform === 'win32') {
    if (env.LOCALAPPDATA) return join(env.LOCALAPPDATA, 'LiveMemory-Backups');
    return join(home, 'LiveMemory-Backups');
  }
  const base = env.XDG_DATA_HOME ? resolve(env.XDG_DATA_HOME) : join(home, '.local', 'share');
  return join(base, 'livememory-backups');
}

function timestamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${String(date.getMilliseconds()).padStart(3, '0')}`;
}

/**
 * Consistent SQLite snapshot outside the data folder. This is deliberately a
 * raw database snapshot, not the portable `.livememory` format planned for M5.
 */
export function createDatabaseBackup({db, env = process.env, now = Date.now()} = {}) {
  const dir = backupDirectory({env});
  mkdirSync(dir, {recursive: true});
  const file = join(dir, `livememory-database-${timestamp(new Date(now))}.db`);
  const escaped = file.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);
  const verify = new DatabaseSync(file);
  try {
    const integrity = verify.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || String(integrity[0].integrity_check) !== 'ok') {
      throw new AppError('BACKUP_VERIFY_FAILED', {messageKey: 'errors.backupVerifyFailed', httpStatus: 500});
    }
    const counts = tableCounts(verify);
    return {file, bytes: statSync(file).size, counts, createdAt: now};
  } catch (error) {
    try {
      rmSync(file, {force: true});
    } catch {
      /* best effort */
    }
    throw error;
  } finally {
    verify.close();
  }
}

function clearDirectory(directory, {skip = null} = {}) {
  if (!existsSync(directory)) return [];
  const removed = [];
  for (const entry of readdirSync(directory)) {
    const target = join(directory, entry);
    if (skip && resolve(target) === resolve(skip)) continue;
    try {
      rmSync(target, {recursive: true, force: true});
      removed.push(target);
    } catch (error) {
      removed.push({path: target, error: error?.code ?? 'error'});
    }
  }
  return removed;
}

function clearDatabase(db, {factory = false} = {}) {
  withTransaction(db, () => {
    // Child tables first so this works regardless of cascade timing. Explicit
    // deletes also cover databases where a foreign key was disabled.
    db.exec('DELETE FROM memory_job_messages');
    db.exec('DELETE FROM memory_results');
    db.exec('DELETE FROM memory_job_viewers');
    db.exec('DELETE FROM memory_job_batches');
    db.exec('DELETE FROM memory_jobs');
    db.exec('DELETE FROM memory_fact_evidence');
    db.exec('DELETE FROM memory_facts');
    db.exec('DELETE FROM memory_versions');
    db.exec('DELETE FROM viewer_memories');
    db.exec('DELETE FROM ai_translations');
    db.exec('DELETE FROM ai_translation_runs');
    db.exec('DELETE FROM ai_result_evidence');
    db.exec('DELETE FROM ai_results');
    db.exec('DELETE FROM ai_job_messages');
    db.exec('DELETE FROM ai_job_viewers');
    db.exec('DELETE FROM ai_job_batches');
    db.exec('DELETE FROM ai_jobs');
    db.exec('DELETE FROM viewer_broadcaster_currency_totals');
    db.exec('DELETE FROM viewer_broadcasters');
    db.exec('DELETE FROM viewer_currency_totals');
    db.exec('DELETE FROM viewer_nicknames');
    db.exec('DELETE FROM viewer_sessions');
    db.exec('DELETE FROM session_currency_totals');
    db.exec('DELETE FROM ai_packages');
    db.exec('DELETE FROM events');
    db.exec('DELETE FROM monitor_targets');
    db.exec('DELETE FROM sessions');
    db.exec('DELETE FROM viewers');
    db.exec('DELETE FROM broadcasters');
    db.exec('DELETE FROM sqlite_sequence WHERE name = \'events\'');
    if (factory) db.exec('DELETE FROM app_meta');
  });
  // Remove residual pages so deleted chat text is not recoverable from free
  // space, then truncate the WAL.
  db.exec('VACUUM');
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    /* best effort */
  }
}

async function rebuildRuntime(deps, root) {
  await deps.relocation.stop();
  const next = deps.relocation.build(root);
  deps.relocation.swap(next);
  // A rebuilt runtime owns a fresh scheduler; the old one was stopped together
  // with its adapters.
  next.monitoring?.start?.();
  return next;
}

/**
 * @param {{deps:object, mode:'data'|'factory', backupFirst?:boolean, env?:object, now?:number}} options
 */
export async function clearData({
  deps,
  mode,
  backupFirst = false,
  env = process.env,
  now = Date.now()
} = {}) {
  if (!['data', 'factory'].includes(mode)) {
    throw new AppError('CLEAR_MODE_INVALID', {messageKey: 'errors.clearModeInvalid', httpStatus: 400});
  }
  const live = deps.db.prepare("SELECT id FROM sessions WHERE status = 'live' LIMIT 1").get();
  if (live) {
    throw new AppError('SESSION_ACTIVE', {messageKey: 'errors.recordingActive', httpStatus: 409});
  }

  let backup = null;
  if (backupFirst) backup = createDatabaseBackup({db: deps.db, env, now});
  if (mode === 'factory') {
    // Best effort revoke/delete remote credentials before deleting the local
    // encrypted store. A network failure must not block a local reset.
    try {
      await deps.youtube.logout();
    } catch {
      /* local deletion still proceeds */
    }
    try {
      await deps.bilibili.logout();
    } catch {
      /* local deletion still proceeds */
    }
  }

  const before = tableCounts(deps.db);
  clearDatabase(deps.db, {factory: mode === 'factory'});
  const after = tableCounts(deps.db);
  for (const table of CLEARED_TABLES) {
    if (Number(after[table] ?? 0) !== 0) {
      throw new AppError('CLEAR_VERIFY_FAILED', {
        messageKey: 'errors.clearVerifyFailed',
        details: {table, count: after[table]},
        httpStatus: 500
      });
    }
  }

  const root = deps.paths.root;
  const removed = [];
  removed.push(...clearDirectory(deps.paths.exports));
  removed.push(...clearDirectory(deps.paths.cache));
  if (mode === 'factory') {
    removed.push(...clearDirectory(deps.paths.secrets));
    removed.push(...clearDirectory(deps.paths.logs));
    deps.settingsStore.reset({now});
  }

  try {
    await rebuildRuntime(deps, root);
  } catch (error) {
    try {
      deps.relocation.swap(deps.relocation.build(root));
    } catch {
      /* the next launch will retry; the database is already empty */
    }
    throw new AppError('CLEAR_REINIT_FAILED', {
      messageKey: 'errors.clearReinitFailed',
      details: {code: error?.code ?? 'unknown'},
      cause: error,
      httpStatus: 500
    });
  }

  return {
    mode,
    dataDir: root,
    before,
    after: tableCounts(deps.db),
    backup,
    backupSkipped: backupFirst === false,
    removedFiles: removed.filter((entry) => typeof entry === 'string').length,
    fileErrors: removed.filter((entry) => typeof entry !== 'string'),
    settingsReset: mode === 'factory',
    credentialsRemoved: mode === 'factory',
    backupsPreserved: deps.paths.backups
  };
}

export const __internal = {
  CLEARED_TABLES,
  clearDatabase,
  clearDirectory,
  tableCounts,
  timestamp
};
