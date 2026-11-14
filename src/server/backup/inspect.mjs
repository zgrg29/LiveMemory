import {existsSync, mkdirSync, rmSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {AppError} from '../../shared/errors.mjs';
import {
  BACKUP_ALLOWED_ENTRIES,
  BACKUP_ENTRIES,
  BACKUP_LIMITS,
  BACKUP_FORMAT
} from './constants.mjs';
import {openArchive, extractEntryToFile, readEntryBuffer} from './archive.mjs';
import {validateManifest} from './manifest.mjs';
import {countBackupRows, backupDataRange, backupSchemaVersion} from './counts.mjs';
import {parseBackupSettings} from './settings.mjs';
import {closeDatabase, openDatabase} from '../../storage/database/connection.mjs';
import {migrate, LATEST_SCHEMA_VERSION} from '../../storage/database/migrations/index.mjs';

/**
 * Validate a backup file end to end.
 *
 * Nothing is written outside `workDir` (a per-operation folder inside the
 * application's own runtime directory). The database is extracted, hashed and
 * checked with SQLite itself before the caller is allowed to restore it.
 */

function invalidEntry(messageKey = 'errors.backupContentMismatch', details = null) {
  return new AppError('BACKUP_CONTENT_MISMATCH', {messageKey, details, httpStatus: 400});
}

function manifestFileMap(manifest) {
  const map = new Map();
  for (const entry of manifest.files) map.set(entry.name, entry);
  return map;
}

function summarize({
  manifest,
  archive,
  counts,
  dataRange,
  schemaVersion,
  currentSchemaVersion,
  settings,
  upgradedFrom
}) {
  const warnings = [];
  if (Number(manifest.schemaVersion) < Number(currentSchemaVersion)) {
    warnings.push({code: 'schema_upgrade', from: manifest.schemaVersion, to: currentSchemaVersion});
  }
  if (!settings) warnings.push({code: 'settings_missing'});
  const countsObject = counts ?? manifest.counts;
  return {
    format: BACKUP_FORMAT,
    formatVersion: manifest.formatVersion,
    schemaVersion,
    currentSchemaVersion,
    upgradedFrom: upgradedFrom ?? (Number(schemaVersion) < Number(currentSchemaVersion) ? schemaVersion : null),
    appVersion: manifest.appVersion,
    buildId: manifest.buildId,
    commit: manifest.commit,
    createdAt: manifest.createdAt,
    createdAtMs: manifest.createdAtMs,
    platform: manifest.platform,
    archiveBytes: archive.size,
    uncompressedBytes: archive.entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0),
    entryCount: archive.entries.length,
    containsCredentials: false,
    encryption: null,
    counts: countsObject,
    dataRange: dataRange ?? manifest.dataRange,
    included: manifest.included,
    excluded: manifest.excluded,
    files: manifest.files,
    filesVerified: true,
    hasLongTermMemory: Number(countsObject?.memory_facts ?? 0) > 0
      || Number(countsObject?.viewer_memories ?? 0) > 0,
    hasAiReports: Number(countsObject?.ai_results ?? 0) > 0,
    settings,
    verified: true,
    warnings
  };
}

function verifyDatabaseFile(file, {signal = null} = {}) {
  let db = null;
  try {
    db = new DatabaseSync(file);
    db.exec('PRAGMA busy_timeout = 5000');
    if (signal?.aborted) {
      throw new AppError('BACKUP_CANCELLED', {messageKey: 'errors.backupCancelled', httpStatus: 409});
    }
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || String(integrity[0].integrity_check) !== 'ok') {
      throw new AppError('BACKUP_VERIFY_FAILED', {
        messageKey: 'errors.backupVerifyFailed',
        details: {step: 'integrity_check'},
        httpStatus: 400
      });
    }
    return {
      schemaVersion: backupSchemaVersion(db),
      counts: countBackupRows(db),
      dataRange: backupDataRange(db)
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('BACKUP_VERIFY_FAILED', {
      messageKey: 'errors.backupVerifyFailed',
      details: {step: 'sqlite', code: String(error?.code ?? 'notadb')},
      cause: error,
      httpStatus: 400
    });
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {{file: string, limits?: object, now?: number, keepStaged?: boolean,
 *   workDir?: string, currentSchemaVersion?: number, upgradeStaged?: boolean,
 *   expectedCounts?: object, signal?: AbortSignal}} options
 */
export async function inspectBackup({
  file,
  limits = BACKUP_LIMITS,
  now = Date.now(),
  keepStaged = false,
  workDir = null,
  currentSchemaVersion = LATEST_SCHEMA_VERSION,
  upgradeStaged = false,
  expectedCounts = null,
  signal = null
} = {}) {
  const target = resolve(String(file ?? ''));
  const directory = workDir ?? join(resolve('.'), `.livememory-inspect-${process.pid}-${now}`);
  let archive = null;
  let success = false;
  try {
    mkdirSync(directory, {recursive: true});
    archive = openArchive(target, {limits});

    const allowed = new Set(BACKUP_ALLOWED_ENTRIES);
    for (const entry of archive.entries) {
      if (!allowed.has(entry.name)) {
        throw invalidEntry('errors.backupUnexpectedEntry', {entry: entry.name});
      }
    }
    if (!archive.has(BACKUP_ENTRIES.manifest)) throw invalidEntry('errors.backupManifestMissing');
    if (!archive.has(BACKUP_ENTRIES.database)) throw invalidEntry('errors.backupDatabaseMissing');

    const manifestEntry = archive.entry(BACKUP_ENTRIES.manifest);
    let manifest;
    try {
      manifest = validateManifest(
        JSON.parse(readEntryBuffer(archive, manifestEntry, {maxBytes: limits.maxManifestBytes}).toString('utf8')),
        {currentSchemaVersion}
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('BACKUP_MANIFEST_INVALID', {
        messageKey: 'errors.backupManifestInvalid',
        details: {reason: 'json'},
        httpStatus: 400
      });
    }

    const declared = manifestFileMap(manifest);
    for (const name of declared.keys()) {
      if (name !== BACKUP_ENTRIES.database && name !== BACKUP_ENTRIES.settings) {
        throw invalidEntry('errors.backupManifestInvalid', {entry: name});
      }
    }
    const databaseEntry = archive.entry(BACKUP_ENTRIES.database);
    if (!declared.has(BACKUP_ENTRIES.database)) throw invalidEntry('errors.backupManifestInvalid');
    const settingsEntry = archive.entry(BACKUP_ENTRIES.settings);
    if (settingsEntry && !declared.has(BACKUP_ENTRIES.settings)) {
      throw invalidEntry('errors.backupManifestInvalid');
    }
    if (!settingsEntry && declared.has(BACKUP_ENTRIES.settings)) {
      throw invalidEntry('errors.backupSettingsMissing');
    }
    for (const [name, entry] of declared) {
      const archived = archive.entry(name);
      if (!archived) throw invalidEntry('errors.backupMissingFile', {entry: name});
      if (archived.uncompressedSize !== entry.bytes) {
        throw invalidEntry('errors.backupSizeMismatch', {
          entry: name,
          expected: entry.bytes,
          actual: archived.uncompressedSize
        });
      }
    }

    let settings = null;
    if (settingsEntry) {
      settings = parseBackupSettings(readEntryBuffer(archive, settingsEntry, {
        maxBytes: limits.maxSettingsBytes
      }));
    }

    const databaseFile = join(directory, 'livememory.db');
    const extracted = extractEntryToFile(archive, databaseEntry, databaseFile, {signal});
    if (extracted.sha256 !== declared.get(BACKUP_ENTRIES.database).sha256) {
      throw new AppError('BACKUP_CHECKSUM_MISMATCH', {
        messageKey: 'errors.backupChecksumMismatch',
        details: {entry: BACKUP_ENTRIES.database},
        httpStatus: 400
      });
    }

    let verified = verifyDatabaseFile(databaseFile, {signal});
    if (Number(verified.schemaVersion) !== Number(manifest.schemaVersion)) {
      throw invalidEntry('errors.backupSchemaMismatch', {
        manifest: manifest.schemaVersion,
        actual: verified.schemaVersion
      });
    }
    if (Number(verified.schemaVersion) < 1) throw invalidEntry('errors.backupSchemaUnsupported');

    let upgradedFrom = null;
    if (upgradeStaged && Number(verified.schemaVersion) < Number(currentSchemaVersion)) {
      upgradedFrom = verified.schemaVersion;
      const db = openDatabase({file: databaseFile});
      try {
        migrate(db, {now});
        const integrity = db.prepare('PRAGMA integrity_check').all();
        if (integrity.length !== 1 || String(integrity[0].integrity_check) !== 'ok') {
          throw new AppError('BACKUP_VERIFY_FAILED', {
            messageKey: 'errors.backupVerifyFailed',
            details: {step: 'post_migration_integrity_check'},
            httpStatus: 400
          });
        }
      } finally {
        closeDatabase(db);
      }
      // The migration opens the file in WAL mode; remove sidecars so the staged
      // file can be renamed into place as one consistent database.
      rmSync(`${databaseFile}-wal`, {force: true});
      rmSync(`${databaseFile}-shm`, {force: true});
      verified = verifyDatabaseFile(databaseFile, {signal});
    }

    const expected = expectedCounts ?? manifest.counts;
    for (const [key, value] of Object.entries(expected ?? {})) {
      const actual = Number(verified.counts[key] ?? 0);
      if (Number(value) !== actual) {
        throw invalidEntry('errors.backupContentMismatch', {
          field: key,
          expected: Number(value),
          actual
        });
      }
    }

    const summary = summarize({
      manifest,
      archive,
      counts: verified.counts,
      dataRange: verified.dataRange,
      schemaVersion: verified.schemaVersion,
      currentSchemaVersion,
      settings,
      upgradedFrom
    });
    if (keepStaged) {
      summary.staged = {
        directory,
        databaseFile,
        settingsFile: settings ? join(directory, 'settings.json') : null,
        settings
      };
    }
    success = true;
    return summary;
  } finally {
    try {
      archive?.close();
    } catch {
      /* ignore */
    }
    if (!keepStaged) {
      try {
        rmSync(directory, {recursive: true, force: true});
      } catch {
        /* best effort */
      }
    }
  }
}

export const __internal = {verifyDatabaseFile, summarize};
