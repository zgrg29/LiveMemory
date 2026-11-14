import {
  copyFileSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  closeSync
} from 'node:fs';
import {join, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {AppError} from '../../shared/errors.mjs';
import {isSubPath} from '../relocation.mjs';
import {sha256File} from './archive.mjs';

/**
 * Crash-recovery journal for restore.
 *
 * Restore swaps a single database file. A journal written before the first
 * rename lets the next start decide what actually happened, using file contents
 * (SHA-256) rather than a try/catch claim:
 *
 * - `prepared`     : staging is ready, the live database was not touched;
 * - `committing`   : renames may have started; hashes identify the live file;
 * - `placed`       : the restored database is in place;
 * - `verified`     : the restored database passed integrity/schema checks;
 * - `settings`     : settings were applied.
 *
 * If the restored file is valid the restore is completed (forward); otherwise
 * the previous database is renamed back (rollback). The pre-restore safety
 * snapshot is never deleted by recovery.
 */

const JOURNAL_NAME = 'restore-journal.json';
const JOURNAL_VERSION = 1;

export const RESTORE_PHASES = Object.freeze({
  PREPARED: 'prepared',
  COMMITTING: 'committing',
  PLACED: 'placed',
  VERIFIED: 'verified',
  SETTINGS: 'settings'
});

export function restoreJournalPath(paths) {
  return join(paths.runtime, JOURNAL_NAME);
}

function writeFileDurable(file, text) {
  const temp = `${file}.${process.pid}.tmp`;
  const fd = openSync(temp, 'w', 0o600);
  try {
    writeFileSync(fd, text, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
}

export function writeRestoreJournal(paths, state) {
  const file = restoreJournalPath(paths);
  const payload = {
    ...state,
    version: JOURNAL_VERSION,
    updatedAt: new Date().toISOString()
  };
  writeFileDurable(file, `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

export function readRestoreJournal(paths) {
  const file = restoreJournalPath(paths);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function clearRestoreJournal(paths) {
  try {
    rmSync(restoreJournalPath(paths), {force: true});
  } catch {
    /* best effort */
  }
}

function discardJournal(paths, reason, logger) {
  const file = restoreJournalPath(paths);
  try {
    renameSync(file, `${file}.invalid-${Date.now()}`);
  } catch {
    try {
      rmSync(file, {force: true});
    } catch {
      /* best effort */
    }
  }
  logger?.warn({event: 'restore.journal.discarded', reason});
  return {action: 'discarded', reason};
}

/** Every path in the journal must stay inside the current data folder. */
function journalPathsSafe(paths, state) {
  const root = resolve(paths.root);
  if (typeof state.targetDb !== 'string') return false;
  const candidates = [state.stagedDb, state.previousDb, state.stageDir, state.settingsFile, state.settingsBackup]
    .filter((value) => typeof value === 'string' && value.length > 0);
  if (resolve(state.targetDb) !== resolve(paths.databaseFile)) return false;
  return candidates.every((candidate) => isSubPath(root, candidate));
}

function databaseState(file) {
  if (!file || !existsSync(file)) return {exists: false, usable: false};
  let db;
  try {
    db = new DatabaseSync(file);
    db.exec('PRAGMA busy_timeout = 2000');
    const integrity = db.prepare('PRAGMA integrity_check').all();
    const version = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get();
    return {
      exists: true,
      usable: integrity.length === 1 && String(integrity[0].integrity_check) === 'ok',
      schemaVersion: Number(version?.version ?? 0)
    };
  } catch {
    return {exists: true, usable: false};
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

function removeSidecars(file) {
  for (const suffix of ['-wal', '-shm']) {
    try {
      rmSync(`${file}${suffix}`, {force: true});
    } catch {
      /* best effort */
    }
  }
}

function restoreSettingsBackup(state) {
  if (!state.settingsFile || !state.settingsBackup || !existsSync(state.settingsBackup)) return false;
  try {
    copyFileSync(state.settingsBackup, `${state.settingsFile}.restore-tmp`);
    renameSync(`${state.settingsFile}.restore-tmp`, state.settingsFile);
    return true;
  } catch {
    return false;
  }
}

function removeStage(state) {
  if (!state.stageDir) return;
  try {
    rmSync(state.stageDir, {recursive: true, force: true});
  } catch {
    /* best effort */
  }
}

function commitCleanup(state) {
  if (state.previousDb) {
    try {
      rmSync(state.previousDb, {force: true});
    } catch {
      /* best effort */
    }
    removeSidecars(state.previousDb);
  }
  removeStage(state);
}

export function rollbackJournalState(state, {restoreSettings = true} = {}) {
  const target = state.targetDb;
  const previous = state.previousDb;
  const targetState = databaseState(target);
  if (previous && existsSync(previous)) {
    if (targetState.exists && targetState.usable) {
      // The live file is valid, so it is probably the restored one; the caller
      // only reaches this on an explicit in-process failure after placement.
      try {
        rmSync(target, {force: true});
      } catch {
        /* fall through to the error below */
      }
    }
    removeSidecars(target);
    renameSync(previous, target);
  } else if (state.phase === RESTORE_PHASES.COMMITTING && targetState.exists && targetState.usable) {
    // Nothing was renamed yet: the live database is the original.
  } else if (!targetState.exists || !targetState.usable) {
    throw new AppError('RESTORE_RECOVERY_FAILED', {
      messageKey: 'errors.restoreRecoveryFailed',
      details: {step: 'rollback', target},
      httpStatus: 500
    });
  }
  if (restoreSettings) restoreSettingsBackup(state);
  removeStage(state);
}

/**
 * Run at every start, before the database is opened.
 * @returns {{action: 'none'|'discarded'|'cleaned'|'rolled-back'|'committed', id?: string}}
 */
export function recoverRestoreJournal({paths, logger = null} = {}) {
  const file = restoreJournalPath(paths);
  if (!existsSync(file)) return {action: 'none'};
  let state;
  try {
    state = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return discardJournal(paths, 'unreadable', logger);
  }
  if (!state || state.version !== JOURNAL_VERSION || typeof state.phase !== 'string') {
    return discardJournal(paths, 'invalid', logger);
  }
  if (!journalPathsSafe(paths, state)) return discardJournal(paths, 'unsafe-path', logger);

  const target = paths.databaseFile;
  const targetState = databaseState(target);

  if (state.phase === RESTORE_PHASES.PREPARED) {
    // No rename was attempted; remove only our staging directory.
    removeStage(state);
    clearRestoreJournal(paths);
    logger?.info({event: 'restore.journal.cleaned', id: state.id ?? null, phase: state.phase});
    return {action: 'cleaned', id: state.id ?? null};
  }

  if (state.phase === RESTORE_PHASES.COMMITTING) {
    // The first rename may already have moved the live database away before the
    // second one completed. A missing target with a previous file is the
    // rollback case, not an unknown state.
    if (!targetState.exists && state.previousDb && existsSync(state.previousDb)) {
      rollbackJournalState(state);
      clearRestoreJournal(paths);
      logger?.warn({event: 'restore.journal.rolled-back', id: state.id ?? null, phase: state.phase});
      return {action: 'rolled-back', id: state.id ?? null};
    }
    let liveHash = null;
    try {
      liveHash = targetState.usable ? sha256File(target).sha256 : null;
    } catch {
      liveHash = null;
    }
    if (liveHash && state.stagedSha256 && liveHash === state.stagedSha256) {
      // Both renames happened; the restored file is already in place.
      if (!targetState.usable) {
        return discardJournal(paths, 'restored-unusable', logger);
      }
      commitCleanup(state);
      clearRestoreJournal(paths);
      logger?.info({event: 'restore.journal.committed', id: state.id ?? null, phase: state.phase});
      return {action: 'committed', id: state.id ?? null};
    }
    if (liveHash && state.previousSha256 && liveHash === state.previousSha256) {
      // Rename did not happen: the original database is intact.
      removeStage(state);
      clearRestoreJournal(paths);
      logger?.info({event: 'restore.journal.aborted', id: state.id ?? null});
      return {action: 'cleaned', id: state.id ?? null};
    }
    if (targetState.exists && existsSync(state.previousDb)) {
      rollbackJournalState(state);
      clearRestoreJournal(paths);
      logger?.warn({event: 'restore.journal.rolled-back', id: state.id ?? null, phase: state.phase});
      return {action: 'rolled-back', id: state.id ?? null};
    }
    return discardJournal(paths, 'committing-unknown', logger);
  }

  if (!targetState.exists || !targetState.usable) {
    if (state.previousDb && existsSync(state.previousDb)) {
      rollbackJournalState(state);
      clearRestoreJournal(paths);
      logger?.warn({event: 'restore.journal.rolled-back', id: state.id ?? null, phase: state.phase});
      return {action: 'rolled-back', id: state.id ?? null};
    }
    throw new AppError('RESTORE_RECOVERY_FAILED', {
      messageKey: 'errors.restoreRecoveryFailed',
      details: {step: 'startup', target},
      httpStatus: 500
    });
  }

  // target is valid: the restore reached the database-swap stage.
  commitCleanup(state);
  clearRestoreJournal(paths);
  logger?.info({event: 'restore.journal.committed', id: state.id ?? null, phase: state.phase});
  return {action: 'committed', id: state.id ?? null};
}

export const __internal = {journalPathsSafe, databaseState, removeSidecars, JOURNAL_NAME};
