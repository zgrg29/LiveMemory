import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  writeSync
} from 'node:fs';
import {createHash} from 'node:crypto';
import {basename, dirname, isAbsolute, join, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {AppError} from '../../shared/errors.mjs';
import {createCrc32} from '../../shared/zip.mjs';
import {
  BACKUP_ALLOWED_ENTRIES,
  BACKUP_ENTRIES,
  BACKUP_EXCLUDED,
  BACKUP_EXTENSION,
  BACKUP_INCLUDED,
  BACKUP_LIMITS
} from './constants.mjs';
import {buildManifest} from './manifest.mjs';
import {countBackupRows, backupDataRange, backupSchemaVersion} from './counts.mjs';
import {settingsForBackup} from './settings.mjs';
import {writeBackupArchive} from './write-archive.mjs';
import {inspectBackup} from './inspect.mjs';
import {sha256File} from './archive.mjs';

/**
 * Create a portable `.livememory` backup.
 *
 * Order matters and is intentionally conservative:
 * 1. a consistent SQLite snapshot via `VACUUM INTO` (never a raw copy of a WAL
 *    database), verified with `PRAGMA integrity_check`;
 * 2. checksums of every file;
 * 3. a ZIP written to a temporary sibling file, with the CRC computed again
 *    while writing;
 * 4. the temporary archive is re-opened and fully validated, including a second
 *    integrity check of the extracted database;
 * 5. only then is it atomically renamed to its final path. An existing target is
 *    never overwritten without the explicit `overwrite` flag.
 */

const CHUNK_SIZE = 1024 * 1024;
const OVERHEAD_BYTES = 32 * 1024 * 1024;

function cancelled() {
  return new AppError('BACKUP_CANCELLED', {messageKey: 'errors.backupCancelled', httpStatus: 409});
}

function checkAbort(signal) {
  if (signal?.aborted) throw cancelled();
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** Validate and normalise a user-chosen destination path. */
export function normalizeBackupDestination(file) {
  const raw = String(file ?? '').trim();
  if (!raw || raw.length > 4096 || raw.includes('\u0000')) {
    throw new AppError('BACKUP_PATH_INVALID', {messageKey: 'errors.backupPathInvalid', httpStatus: 400});
  }
  if (!isAbsolute(raw)) {
    throw new AppError('BACKUP_PATH_INVALID', {
      messageKey: 'errors.backupPathInvalid',
      details: {reason: 'relative'},
      httpStatus: 400
    });
  }
  const target = resolve(raw);
  if (/^\\\\/.test(target)) {
    throw new AppError('BACKUP_PATH_INVALID', {
      messageKey: 'errors.backupPathInvalid',
      details: {reason: 'network'},
      httpStatus: 400
    });
  }
  if (!target.toLowerCase().endsWith(BACKUP_EXTENSION)) {
    throw new AppError('BACKUP_PATH_INVALID', {
      messageKey: 'errors.backupPathInvalid',
      details: {reason: 'extension', expected: BACKUP_EXTENSION},
      httpStatus: 400
    });
  }
  return target;
}

function diskFreeBytes(directory, statfs = statfsSync) {
  try {
    const stats = statfs(directory);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

function hashAndCrc(file, {signal, onProgress} = {}) {
  const crc = createCrc32();
  const hash = createHash('sha256');
  const fd = openSync(file, 'r');
  try {
    const size = statSync(file).size;
    const buffer = Buffer.alloc(CHUNK_SIZE);
    let position = 0;
    while (position < size) {
      checkAbort(signal);
      const length = Math.min(buffer.length, size - position);
      const read = readSync(fd, buffer, 0, length, position);
      if (read <= 0) break;
      const chunk = buffer.subarray(0, read);
      crc.update(chunk);
      hash.update(chunk);
      position += read;
      onProgress?.({done: position, total: size});
    }
    return {bytes: position, crc: crc.digest(), sha256: hash.digest('hex')};
  } finally {
    closeSync(fd);
  }
}

function mapSpaceError(error) {
  const code = String(error?.code ?? '');
  const message = String(error?.message ?? '');
  const errcode = Number(error?.errcode);
  if (code === 'ENOSPC' || code === 'EDQUOT' || errcode === 13 || /disk is full|no space left/i.test(message)) {
    return new AppError('BACKUP_NO_SPACE', {
      messageKey: 'errors.backupNoSpace',
      details: {code: code || 'ENOSPC'},
      cause: error,
      httpStatus: 507
    });
  }
  return error;
}

/**
 * @param {{db: object, paths: object, settings: object, file: string, now?: number,
 *   appVersion: string, buildInfo?: object, platform?: string, signal?: AbortSignal,
 *   onProgress?: Function, overwrite?: boolean, limits?: object, statfs?: Function}} options
 */
export async function createBackup({
  db,
  paths,
  settings,
  file,
  now = Date.now(),
  appVersion,
  buildInfo = null,
  platform = process.platform,
  signal = null,
  onProgress = () => {},
  overwrite = false,
  limits = BACKUP_LIMITS,
  statfs = statfsSync,
  hooks = null
} = {}) {
  if (!db || !paths?.root) throw new Error('createBackup: db and paths are required');
  const target = normalizeBackupDestination(file);
  const targetDirectory = dirname(target);
  if (!existsSync(targetDirectory)) {
    throw new AppError('BACKUP_PATH_INVALID', {
      messageKey: 'errors.backupPathInvalid',
      details: {reason: 'missing-directory', path: targetDirectory},
      httpStatus: 400
    });
  }
  if (existsSync(target) && !statSync(target).isFile()) {
    throw new AppError('BACKUP_PATH_INVALID', {
      messageKey: 'errors.backupPathInvalid',
      details: {reason: 'not-a-file', path: target},
      httpStatus: 400
    });
  }
  if (existsSync(target) && !overwrite) {
    throw new AppError('BACKUP_TARGET_EXISTS', {
      messageKey: 'errors.backupTargetExists',
      details: {path: target},
      httpStatus: 409
    });
  }

  const sourceDatabase = paths.databaseFile;
  const sourceBytes = existsSync(sourceDatabase) ? statSync(sourceDatabase).size : 0;
  const requiredBytes = sourceBytes * 3 + OVERHEAD_BYTES;
  const freeBytes = diskFreeBytes(targetDirectory, statfs);
  if (freeBytes !== null && freeBytes < requiredBytes) {
    throw new AppError('BACKUP_NO_SPACE', {
      messageKey: 'errors.backupNoSpace',
      details: {freeBytes, requiredBytes},
      httpStatus: 507
    });
  }

  const stageDir = join(paths.runtime, `backup-${process.pid}-${now}-${randomUUID().slice(0, 8)}`);
  const snapshotFile = join(stageDir, 'livememory.db');
  const partialFile = join(
    targetDirectory,
    `.${basename(target)}.partial-${process.pid}-${randomUUID().slice(0, 8)}`
  );
  let completed = false;

  try {
    mkdirSync(stageDir, {recursive: true});
    onProgress({phase: 'snapshot', percent: 5});
    checkAbort(signal);

    // VACUUM INTO produces a consistent, compact copy including committed WAL
    // content. It never modifies the live database.
    const escaped = snapshotFile.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${escaped}'`);
    hooks?.afterSnapshot?.({snapshotFile});
    checkAbort(signal);

    let snapshotStats;
    const verify = new DatabaseSync(snapshotFile);
    try {
      verify.exec('PRAGMA busy_timeout = 5000');
      const integrity = verify.prepare('PRAGMA integrity_check').all();
      if (integrity.length !== 1 || String(integrity[0].integrity_check) !== 'ok') {
        throw new AppError('BACKUP_VERIFY_FAILED', {
          messageKey: 'errors.backupVerifyFailed',
          details: {step: 'integrity_check'},
          httpStatus: 500
        });
      }
      snapshotStats = {
        counts: countBackupRows(verify),
        dataRange: backupDataRange(verify),
        schemaVersion: backupSchemaVersion(verify)
      };
    } finally {
      verify.close();
    }

    onProgress({phase: 'checksums', percent: 35});
    const databaseHash = hashAndCrc(snapshotFile, {
      signal,
      onProgress: ({done, total}) => {
        onProgress({
          phase: 'checksums',
          percent: clampPercent(35 + (done / Math.max(total, 1)) * 15)
        });
      }
    });

    onProgress({phase: 'checksums', percent: 50});
    const settingsBytes = Buffer.from(
      `${JSON.stringify(settingsForBackup(settings), null, 2)}\n`,
      'utf8'
    );
    const settingsCrc = createCrc32().update(settingsBytes).digest();
    const settingsHash = createHash('sha256').update(settingsBytes).digest('hex');

    const createdAt = new Date(now).toISOString();
    const manifest = buildManifest({
      appVersion,
      buildInfo,
      schemaVersion: snapshotStats.schemaVersion,
      createdAt,
      platform,
      counts: snapshotStats.counts,
      dataRange: snapshotStats.dataRange,
      included: BACKUP_INCLUDED.map((item) => ({path: item.path, reason: item.reason})),
      excluded: BACKUP_EXCLUDED.map((item) => ({path: item.path, reason: item.reason})),
      files: [
        {name: BACKUP_ENTRIES.database, bytes: databaseHash.bytes, sha256: databaseHash.sha256},
        {name: BACKUP_ENTRIES.settings, bytes: settingsBytes.length, sha256: settingsHash}
      ]
    });
    if (manifest.files.some((entry) => !BACKUP_ALLOWED_ENTRIES.includes(entry.name))) {
      throw new Error('backup: manifest contains an unsupported entry');
    }
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const manifestCrc = createCrc32().update(manifestBytes).digest();

    onProgress({phase: 'write', percent: 50});
    writeBackupArchive({
      file: partialFile,
      timestamp: new Date(now),
      signal,
      onProgress: ({done, total}) => {
        onProgress({
          phase: 'write',
          percent: clampPercent(50 + (done / Math.max(total, 1)) * 39)
        });
      },
      entries: [
        {name: BACKUP_ENTRIES.manifest, size: manifestBytes.length, crc: manifestCrc, data: manifestBytes},
        {
          name: BACKUP_ENTRIES.database,
          size: databaseHash.bytes,
          crc: databaseHash.crc,
          filePath: snapshotFile
        },
        {name: BACKUP_ENTRIES.settings, size: settingsBytes.length, crc: settingsCrc, data: settingsBytes}
      ]
    });

    hooks?.afterWrite?.({partialFile});
    onProgress({phase: 'verify', percent: 90});
    checkAbort(signal);
    await inspectBackup({
      file: partialFile,
      limits,
      now,
      keepStaged: false,
      currentSchemaVersion: snapshotStats.schemaVersion,
      workDir: join(stageDir, 'verify'),
      expectedCounts: snapshotStats.counts
    });

    onProgress({phase: 'commit', percent: 99});
    checkAbort(signal);
    const replaced = existsSync(target) ? `${target}.replaced-${now}` : null;
    if (replaced) renameSync(target, replaced);
    try {
      renameSync(partialFile, target);
    } catch (error) {
      if (replaced) {
        try {
          renameSync(replaced, target);
        } catch {
          /* leave the replaced file for manual recovery */
        }
      }
      throw error;
    }
    if (replaced) {
      try {
        rmSync(replaced, {force: true});
      } catch {
        /* the backup itself is complete; the old file is harmless */
      }
    }
    completed = true;
    const archiveHash = sha256File(target).sha256;
    onProgress({phase: 'done', percent: 100});

    return {
      file: target,
      bytes: statSync(target).size,
      sha256: archiveHash,
      databaseSha256: databaseHash.sha256,
      createdAt,
      createdAtMs: now,
      schemaVersion: snapshotStats.schemaVersion,
      appVersion,
      counts: snapshotStats.counts,
      dataRange: snapshotStats.dataRange,
      containsCredentials: false,
      included: manifest.included,
      excluded: manifest.excluded
    };
  } catch (error) {
    throw mapSpaceError(error);
  } finally {
    try {
      rmSync(stageDir, {recursive: true, force: true});
    } catch {
      /* best effort */
    }
    if (!completed) {
      try {
        rmSync(partialFile, {force: true});
      } catch {
        /* best effort */
      }
    }
  }
}
