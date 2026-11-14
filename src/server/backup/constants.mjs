/**
 * Portable backup format constants.
 *
 * A `.livememory` file is a ZIP archive using the STORE method only (no
 * compression). Storing entries lets the reader verify that the declared
 * uncompressed size equals the bytes actually present, which removes the
 * classic compression-bomb ratio attack; the resource limits below still cap
 * every dimension of a hostile archive.
 *
 * The format itself is documented in docs/BACKUP_FORMAT.md. Bump
 * `BACKUP_FORMAT_VERSION` only for an incompatible layout change.
 */

export const BACKUP_FORMAT = 'livememory-backup';
export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_EXTENSION = '.livememory';

export const BACKUP_ENTRIES = Object.freeze({
  manifest: 'manifest.json',
  database: 'database/livememory.db',
  settings: 'config/settings.json'
});

/** Entries a v1 archive may contain. Anything else is rejected. */
export const BACKUP_ALLOWED_ENTRIES = Object.freeze([
  BACKUP_ENTRIES.manifest,
  BACKUP_ENTRIES.database,
  BACKUP_ENTRIES.settings
]);

/** Directories that are never copied into a backup, with the reason. */
export const BACKUP_EXCLUDED = Object.freeze([
  {path: 'secrets/', reason: 'credentials'},
  {path: 'logs/', reason: 'machine-specific logs'},
  {path: 'cache/', reason: 'regenerable cache'},
  {path: 'runtime/', reason: 'machine-specific locks and runtime state'},
  {path: 'exports/', reason: 'regenerable AI packages'},
  {path: 'backups/', reason: 'nested emergency snapshots'},
  {path: 'app/', reason: 'unpacked executable assets'},
  {path: 'config/ai-providers.json', reason: 'provider configuration bound to this device key'},
  {path: 'data-location pointer', reason: 'machine-specific absolute path'}
]);

export const BACKUP_INCLUDED = Object.freeze([
  {path: 'database/livememory.db', reason: 'sessions, chat, viewers, payments, AI reports, long-term memory, tasks'},
  {path: 'config/settings.json', reason: 'language, appearance, storage mode, retention preference'}
]);

/**
 * Defensive limits. A real single-streamer database is far below these values
 * (the archive is uncompressed); they exist to bound a hostile file.
 */
export const BACKUP_LIMITS = Object.freeze({
  maxArchiveBytes: 2 * 1024 * 1024 * 1024,
  maxTotalUncompressedBytes: 2 * 1024 * 1024 * 1024,
  maxEntryBytes: 2 * 1024 * 1024 * 1024,
  maxEntries: 16,
  maxCentralDirectoryBytes: 4 * 1024 * 1024,
  maxManifestBytes: 1024 * 1024,
  maxSettingsBytes: 256 * 1024,
  maxPathLength: 512
});

export const RESTORE_CONFIRM_WORD = 'RESTORE';

export const BACKUP_JOB_KINDS = Object.freeze({CREATE: 'create', RESTORE: 'restore'});
