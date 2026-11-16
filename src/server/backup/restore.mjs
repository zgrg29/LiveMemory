import {
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  writeSync,
  closeSync
} from 'node:fs';
import {join, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {AppError} from '../../shared/errors.mjs';
import {LATEST_SCHEMA_VERSION} from '../../storage/database/migrations/index.mjs';
import {BACKUP_LIMITS, RESTORE_CONFIRM_WORD} from './constants.mjs';
import {inspectBackup} from './inspect.mjs';
import {sha256File} from './archive.mjs';
import {countBackupRows} from './counts.mjs';
import {
  RESTORE_PHASES,
  clearRestoreJournal,
  readRestoreJournal,
  rollbackJournalState,
  writeRestoreJournal
} from './journal.mjs';

/**
 * Transactional restore.
 *
 * Preconditions are checked before anything is touched: the archive is fully
 * validated, the staged database is migrated and integrity-checked, and a
 * pre-restore safety snapshot is created. Only then are writes stopped, the live
 * connection closed, and the database swapped by rename. A journal on disk lets
 * the next start finish or roll back a restore that was interrupted by a forced
 * process termination.
 *
 * Restore never edits rows in place. The restored file either replaces the live
 * database atomically or the previous file is renamed back.
 */

function fileTimestamp(now) {
  const date = new Date(now);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${String(date.getMilliseconds()).padStart(3, '0')}`;
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

function diskFreeBytes(directory) {
  try {
    const stats = statfsSync(directory);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

function writeJsonAtomically(file, payload) {
  const temp = `${file}.${process.pid}.tmp`;
  const fd = openSync(temp, 'w', 0o600);
  try {
    const buffer = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    let offset = 0;
    while (offset < buffer.length) offset += writeSync(fd, buffer, offset, buffer.length - offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
}

/** Consistent copy of the current database, kept after a successful restore. */
export function createRestoreSnapshot({db, paths, now = Date.now()} = {}) {
  mkdirSync(paths.backups, {recursive: true});
  const file = join(
    paths.backups,
    `pre-restore-${fileTimestamp(now)}-${randomUUID().slice(0, 8)}.db`
  );
  try {
    const escaped = file.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${escaped}'`);
    const verify = new DatabaseSync(file);
    try {
      verify.exec('PRAGMA busy_timeout = 5000');
      const integrity = verify.prepare('PRAGMA integrity_check').all();
      if (integrity.length !== 1 || String(integrity[0].integrity_check) !== 'ok') {
        throw new Error('integrity_check failed');
      }
    } finally {
      verify.close();
    }
    return {file, bytes: statSync(file).size, createdAt: now};
  } catch (error) {
    try {
      rmSync(file, {force: true});
    } catch {
      /* best effort */
    }
    throw new AppError('RESTORE_SNAPSHOT_FAILED', {
      messageKey: 'errors.restoreSnapshotFailed',
      details: {code: error?.code ?? error?.errcode ?? 'snapshot'},
      cause: error,
      httpStatus: 500
    });
  }
}

function verifyRestoredDatabase(file, {expectedSchema, expectedCounts}) {
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || String(integrity[0].integrity_check) !== 'ok') {
      throw new AppError('RESTORE_VERIFY_FAILED', {
        messageKey: 'errors.restoreVerifyFailed',
        details: {step: 'integrity_check'},
        httpStatus: 500
      });
    }
    const schema = Number(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version ?? 0);
    if (schema !== expectedSchema) {
      throw new AppError('RESTORE_VERIFY_FAILED', {
        messageKey: 'errors.restoreVerifyFailed',
        details: {step: 'schema_version', expected: expectedSchema, actual: schema},
        httpStatus: 500
      });
    }
    const counts = countBackupRows(db);
    for (const [key, value] of Object.entries(expectedCounts ?? {})) {
      if (Number(counts[key] ?? 0) !== Number(value)) {
        throw new AppError('RESTORE_VERIFY_FAILED', {
          messageKey: 'errors.restoreVerifyFailed',
          details: {step: 'table_count', table: key, expected: Number(value), actual: Number(counts[key] ?? 0)},
          httpStatus: 500
        });
      }
    }
    return counts;
  } finally {
    db.close();
  }
}

function applyRestoredSettings(paths, settings) {
  if (!settings) return false;
  writeJsonAtomically(paths.settingsFile, {version: 1, ...settings});
  return true;
}

function removeStaleRuntimeState(paths) {
  // The AI runtime state belongs to the replaced database. Keeping it could
  // make an old job look like it is still running after a restore.
  for (const name of ['ai-v13.json']) {
    try {
      rmSync(join(paths.runtime, name), {force: true});
    } catch {
      /* best effort */
    }
  }
}

/**
 * @param {{deps: object, file: string, now?: number, confirmText?: string,
 *   limits?: object, signal?: AbortSignal, logger?: object}} options
 */
export async function restoreBackup({
  deps,
  file,
  now = Date.now(),
  confirmText = null,
  limits = BACKUP_LIMITS,
  signal = null,
  logger = null,
  onProgress = () => {},
  hooks = null
} = {}) {
  if (confirmText !== RESTORE_CONFIRM_WORD) {
    throw new AppError('RESTORE_CONFIRM_REQUIRED', {
      messageKey: 'errors.restoreConfirmRequired',
      details: {expected: RESTORE_CONFIRM_WORD},
      httpStatus: 400
    });
  }
  const paths = deps.paths;
  const source = resolve(String(file ?? ''));
  const before = countBackupRows(deps.db);
  const liveSessions = Number(deps.db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE status = 'live'").get()?.count ?? 0);
  const id = `rst_${now}_${randomUUID().slice(0, 8)}`;
  const stageDir = join(paths.runtime, `restore-${id}`);
  const previousDb = join(paths.runtime, `restore-previous-${id}.db`);
  const settingsBackup = join(stageDir, 'settings.before.json');

  // 1. Validate the archive and stage its database. This happens while the live
  // database is still open and untouched.
  let summary;
  onProgress({phase: 'validate', percent: 5});
  try {
    summary = await inspectBackup({
      file: source,
      limits,
      now,
      keepStaged: true,
      workDir: stageDir,
      currentSchemaVersion: LATEST_SCHEMA_VERSION,
      upgradeStaged: true,
      signal
    });
  } catch (error) {
    try {
      rmSync(stageDir, {recursive: true, force: true});
    } catch {
      /* best effort */
    }
    throw error;
  }
  const staged = summary.staged;
  if (!staged?.databaseFile || !existsSync(staged.databaseFile)) {
    rmSync(stageDir, {recursive: true, force: true});
    throw new AppError('RESTORE_VERIFY_FAILED', {
      messageKey: 'errors.restoreVerifyFailed',
      details: {step: 'missing_staged_database'},
      httpStatus: 500
    });
  }

  // 2. Free-space and safety snapshot before any destructive action. The
  // snapshot is a consistent copy of the current data and is kept afterwards.
  const freeBytes = diskFreeBytes(paths.root);
  const requiredBytes = statSync(staged.databaseFile).size + 64 * 1024 * 1024;
  if (freeBytes !== null && freeBytes < requiredBytes) {
    rmSync(stageDir, {recursive: true, force: true});
    throw new AppError('RESTORE_NO_SPACE', {
      messageKey: 'errors.restoreNoSpace',
      details: {freeBytes, requiredBytes},
      httpStatus: 507
    });
  }

  let snapshot;
  onProgress({phase: 'safety-snapshot', percent: 20});
  try {
    snapshot = createRestoreSnapshot({db: deps.db, paths, now});
  } catch (error) {
    rmSync(stageDir, {recursive: true, force: true});
    throw error;
  }

  if (existsSync(paths.settingsFile)) {
    try {
      copyFileSync(paths.settingsFile, settingsBackup);
    } catch {
      /* settings are optional */
    }
  }

  const started = Date.now();
  let stopped = false;
  let committed = false;
  const state = {
    id,
    phase: RESTORE_PHASES.PREPARED,
    createdAt: new Date(now).toISOString(),
    targetDb: paths.databaseFile,
    stagedDb: staged.databaseFile,
    previousDb,
    stageDir,
    settingsFile: paths.settingsFile,
    settingsBackup: existsSync(settingsBackup) ? settingsBackup : null,
    safetySnapshot: snapshot.file,
    stagedSha256: null,
    previousSha256: null,
    fromSchema: summary.schemaVersion,
    toSchema: LATEST_SCHEMA_VERSION
  };

  try {
    writeRestoreJournal(paths, state);
    logger?.info({event: 'backup.restore.started', id, fromSchema: summary.schemaVersion});
    onProgress({phase: 'stopping', percent: 35});
    // 3. Block new write tasks: close adapters and the AI scheduler, stop SSE.
    await deps.relocation.stopAdapters();
    stopped = true;
    deps.hub?.closeAll?.();
    deps.relocation.closeDatabase();

    state.stagedSha256 = sha256File(staged.databaseFile).sha256;
    state.previousSha256 = existsSync(paths.databaseFile) ? sha256File(paths.databaseFile).sha256 : null;
    state.phase = RESTORE_PHASES.COMMITTING;
    writeRestoreJournal(paths, state);
    onProgress({phase: 'swap', percent: 55});

    // 4. Swap by rename inside the same folder. Renames are atomic; the journal
    // records what may have happened if the process dies between them.
    removeSidecars(paths.databaseFile);
    if (existsSync(paths.databaseFile)) renameSync(paths.databaseFile, previousDb);
    renameSync(staged.databaseFile, paths.databaseFile);
    state.phase = RESTORE_PHASES.PLACED;
    writeRestoreJournal(paths, state);
    hooks?.afterPlace?.({target: paths.databaseFile});

    // 5. Verify the file that is actually in place, then apply settings.
    onProgress({phase: 'verify', percent: 70});
    verifyRestoredDatabase(paths.databaseFile, {
      expectedSchema: LATEST_SCHEMA_VERSION,
      expectedCounts: summary.counts
    });
    state.phase = RESTORE_PHASES.VERIFIED;
    writeRestoreJournal(paths, state);
    hooks?.afterVerify?.({target: paths.databaseFile});

    const settingsRestored = applyRestoredSettings(paths, staged.settings);
    state.phase = RESTORE_PHASES.SETTINGS;
    writeRestoreJournal(paths, state);

    removeSidecars(paths.databaseFile);
    removeStaleRuntimeState(paths);
    hooks?.beforeBuild?.({target: paths.databaseFile});
    onProgress({phase: 'reload', percent: 90});
    const next = deps.relocation.build(paths.root, {skipRestoreRecovery: true});
    deps.relocation.swap(next);
    // The previous scheduler was stopped before the swap. Restored monitor
    // targets must resume in the new runtime, otherwise automatic monitoring
    // would silently stay off after a restore.
    next.monitoring?.start?.();
    committed = true;
    onProgress({phase: 'done', percent: 100});
    logger?.info({
      event: 'backup.restore.completed',
      id,
      counts: summary.counts,
      settingsRestored,
      fromSchema: summary.schemaVersion,
      toSchema: LATEST_SCHEMA_VERSION
    });

    return {
      restored: true,
      id,
      file: source,
      backup: {
        createdAt: summary.createdAt,
        createdAtMs: summary.createdAtMs,
        appVersion: summary.appVersion,
        schemaVersion: summary.schemaVersion,
        archiveBytes: summary.archiveBytes,
        counts: summary.counts,
        dataRange: summary.dataRange,
        hasLongTermMemory: summary.hasLongTermMemory,
        hasAiReports: summary.hasAiReports,
        warnings: summary.warnings
      },
      counts: {before, after: summary.counts},
      interruptedSessions: liveSessions,
      safetySnapshot: snapshot,
      settingsRestored,
      credentialsExcluded: true,
      requiresReconnect: ['bilibili-login', 'ai-provider-key'],
      schema: {
        from: summary.schemaVersion,
        to: LATEST_SCHEMA_VERSION,
        upgraded: Number(summary.schemaVersion) < LATEST_SCHEMA_VERSION
      },
      durationMs: Date.now() - started
    };
  } catch (error) {
    if (!committed) {
      let rollbackError = null;
      try {
        if (!stopped) {
          // The live connection may still be open if stopping failed.
          deps.relocation.closeDatabase();
        }
      } catch {
        /* ignore */
      }
      try {
        const journal = readRestoreJournal(paths) ?? state;
        rollbackJournalState(journal);
      } catch (failure) {
        rollbackError = failure;
        logger?.error({event: 'backup.restore.rollback.failed', id, code: failure?.code ?? 'unknown'});
      }
      try {
        clearRestoreJournal(paths);
      } catch {
        /* best effort */
      }
      try {
        const restored = deps.relocation.build(paths.root, {skipRestoreRecovery: true});
        deps.relocation.swap(restored);
        restored.monitoring?.start?.();
      } catch (restoreError) {
        error.restoreError = restoreError;
      }
      logger?.warn({
        event: 'backup.restore.rolled-back',
        id,
        code: error?.code ?? 'unknown',
        rollbackOk: !rollbackError
      });
      if (error instanceof AppError && error.code !== 'RESTORE_FAILED') {
        error.details = {...(error.details ?? {}), rolledBack: !rollbackError};
        throw error;
      }
      throw new AppError('RESTORE_FAILED', {
        messageKey: 'errors.restoreFailed',
        details: {
          code: error?.code ?? 'unknown',
          rolledBack: !rollbackError,
          rollbackCode: rollbackError?.code ?? null
        },
        cause: error,
        httpStatus: 500
      });
    }
    throw error;
  } finally {
    if (committed) {
      try {
        rmSync(previousDb, {force: true});
      } catch {
        /* best effort */
      }
      removeSidecars(previousDb);
      try {
        rmSync(stageDir, {recursive: true, force: true});
      } catch {
        /* best effort */
      }
      try {
        clearRestoreJournal(paths);
      } catch {
        /* best effort */
      }
    } else if (!existsSync(readRestoreJournalPath(paths))) {
      try {
        rmSync(stageDir, {recursive: true, force: true});
      } catch {
        /* best effort */
      }
    }
  }
}

function readRestoreJournalPath(paths) {
  return join(paths.runtime, 'restore-journal.json');
}

export const __internal = {verifyRestoredDatabase, applyRestoredSettings, fileTimestamp};
