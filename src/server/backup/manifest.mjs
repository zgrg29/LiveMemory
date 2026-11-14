import {AppError} from '../../shared/errors.mjs';
import {BACKUP_FORMAT, BACKUP_FORMAT_VERSION, BACKUP_LIMITS} from './constants.mjs';

/**
 * Backup manifest validation.
 *
 * The manifest is data, not code. Every field that influences a decision is
 * type-checked and bounded here so a forged manifest can never silently skip a
 * compatibility check or claim to contain credentials.
 */

const MAX_COUNTS = 1_000_000_000_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function manifestError(code, messageKey, details = null, httpStatus = 400) {
  return new AppError(code, {messageKey, details, httpStatus});
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readInteger(value, field, {min = 0, max = MAX_COUNTS} = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw manifestError('BACKUP_MANIFEST_INVALID', 'errors.backupManifestInvalid', {field});
  }
  return value;
}

function readContentList(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 32) {
    throw manifestError('BACKUP_MANIFEST_INVALID', 'errors.backupManifestInvalid', {field});
  }
  return value.map((item) => {
    if (typeof item === 'string') {
      return {path: item.slice(0, 256), reason: null};
    }
    if (!isPlainObject(item) || typeof item.path !== 'string') {
      throw manifestError('BACKUP_MANIFEST_INVALID', 'errors.backupManifestInvalid', {field});
    }
    return {
      path: item.path.slice(0, 256),
      reason: typeof item.reason === 'string' ? item.reason.slice(0, 256) : null
    };
  });
}

function readString(value, field, {maxLength = 512} = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw manifestError('BACKUP_MANIFEST_INVALID', 'errors.backupManifestInvalid', {field});
  }
  return value;
}

/**
 * Validate a parsed manifest object and normalise it for the rest of the app.
 * Future format/schema versions are rejected with a distinct code so the UI can
 * tell the user to update LiveMemory instead of calling the file corrupt.
 */
export function validateManifest(raw, {currentSchemaVersion = null} = {}) {
  if (!isPlainObject(raw)) {
    throw manifestError('BACKUP_MANIFEST_INVALID', 'errors.backupManifestInvalid', {field: 'root'});
  }
  if (raw.format !== BACKUP_FORMAT) {
    throw manifestError('BACKUP_FORMAT_INVALID', 'errors.backupFormatInvalid', {
      expected: BACKUP_FORMAT,
      actual: typeof raw.format === 'string' ? raw.format.slice(0, 64) : null
    });
  }
  if (!Number.isInteger(raw.format_version) || raw.format_version < 1) {
    throw manifestError('BACKUP_MANIFEST_INVALID', 'errors.backupManifestInvalid', {field: 'format_version'});
  }
  if (raw.format_version > BACKUP_FORMAT_VERSION) {
    throw manifestError('BACKUP_FORMAT_UNSUPPORTED', 'errors.backupFormatUnsupported', {
      format_version: raw.format_version,
      supported: BACKUP_FORMAT_VERSION
    }, 409);
  }
  if (!Number.isInteger(raw.schema_version) || raw.schema_version < 1) {
    throw manifestError('BACKUP_MANIFEST_INVALID', 'errors.backupManifestInvalid', {field: 'schema_version'});
  }
  if (currentSchemaVersion !== null && raw.schema_version > currentSchemaVersion) {
    throw manifestError('BACKUP_SCHEMA_UNSUPPORTED', 'errors.backupSchemaUnsupported', {
      schema_version: raw.schema_version,
      supported: currentSchemaVersion
    }, 409);
  }
  if (raw.contains_credentials === true) {
    throw manifestError('BACKUP_CREDENTIALS_PRESENT', 'errors.backupCredentialsPresent', null, 400);
  }
  if (raw.contains_credentials !== false) {
    throw manifestError('BACKUP_MANIFEST_INVALID', 'errors.backupManifestInvalid', {field: 'contains_credentials'});
  }
  const encryption = raw.encryption;
  if (encryption !== null && encryption !== undefined) {
    if (!isPlainObject(encryption)) {
      throw manifestError('BACKUP_MANIFEST_INVALID', 'errors.backupManifestInvalid', {field: 'encryption'});
    }
    if (encryption.algorithm !== null && encryption.algorithm !== undefined) {
      throw manifestError('BACKUP_ENCRYPTION_UNSUPPORTED', 'errors.backupEncryptionUnsupported', {
        algorithm: String(encryption.algorithm).slice(0, 64)
      }, 400);
    }
  }
  const createdAt = readString(raw.created_at, 'created_at', {maxLength: 64});
  const createdAtMs = Date.parse(createdAt);
  if (!Number.isFinite(createdAtMs)) {
    throw manifestError('BACKUP_MANIFEST_INVALID', 'errors.backupManifestInvalid', {field: 'created_at'});
  }
  const appVersion = readString(raw.app_version, 'app_version', {maxLength: 64});
  const platform = typeof raw.platform === 'string' ? raw.platform.slice(0, 32) : null;

  if (!Array.isArray(raw.files) || raw.files.length === 0 || raw.files.length > BACKUP_LIMITS.maxEntries) {
    throw manifestError('BACKUP_MANIFEST_INVALID', 'errors.backupManifestInvalid', {field: 'files'});
  }
  const files = [];
  const names = new Set();
  for (const entry of raw.files) {
    if (!isPlainObject(entry)) {
      throw manifestError('BACKUP_MANIFEST_INVALID', 'errors.backupManifestInvalid', {field: 'files[]'});
    }
    const name = readString(entry.name, 'files[].name', {maxLength: BACKUP_LIMITS.maxPathLength});
    if (names.has(name)) {
      throw manifestError('BACKUP_MANIFEST_INVALID', 'errors.backupManifestInvalid', {field: 'files[].name', reason: 'duplicate'});
    }
    names.add(name);
    const bytes = readInteger(entry.bytes, 'files[].bytes', {max: BACKUP_LIMITS.maxEntryBytes});
    const sha256 = readString(entry.sha256, 'files[].sha256', {maxLength: 64});
    if (!SHA256_PATTERN.test(sha256)) {
      throw manifestError('BACKUP_MANIFEST_INVALID', 'errors.backupManifestInvalid', {field: 'files[].sha256'});
    }
    files.push({name, bytes, sha256});
  }

  const counts = {};
  if (raw.counts !== undefined) {
    if (!isPlainObject(raw.counts)) {
      throw manifestError('BACKUP_MANIFEST_INVALID', 'errors.backupManifestInvalid', {field: 'counts'});
    }
    for (const [key, value] of Object.entries(raw.counts)) {
      if (!/^[a-z_]{1,40}$/.test(key)) {
        throw manifestError('BACKUP_MANIFEST_INVALID', 'errors.backupManifestInvalid', {field: `counts.${key}`});
      }
      counts[key] = readInteger(value, `counts.${key}`);
    }
  }

  let dataRange = null;
  if (raw.data_range !== undefined && raw.data_range !== null) {
    if (!isPlainObject(raw.data_range)) {
      throw manifestError('BACKUP_MANIFEST_INVALID', 'errors.backupManifestInvalid', {field: 'data_range'});
    }
    const first = raw.data_range.first_session_at;
    const last = raw.data_range.last_session_at;
    dataRange = {
      firstSessionAt: Number.isInteger(first) && first >= 0 ? first : null,
      lastSessionAt: Number.isInteger(last) && last >= 0 ? last : null
    };
  }

  return {
    format: BACKUP_FORMAT,
    formatVersion: raw.format_version,
    schemaVersion: raw.schema_version,
    appVersion,
    buildId: typeof raw.build_id === 'string' ? raw.build_id.slice(0, 64) : null,
    commit: typeof raw.commit === 'string' ? raw.commit.slice(0, 64) : null,
    createdAt,
    createdAtMs,
    platform,
    containsCredentials: false,
    encryption: null,
    counts,
    dataRange,
    included: readContentList(raw.included, 'included'),
    excluded: readContentList(raw.excluded, 'excluded'),
    files
  };
}

/** Build the on-disk manifest object (snake_case follows the format doc). */
export function buildManifest({
  appVersion,
  buildInfo = null,
  schemaVersion,
  createdAt,
  platform,
  counts,
  dataRange,
  files,
  included,
  excluded
}) {
  return {
    format: BACKUP_FORMAT,
    format_version: BACKUP_FORMAT_VERSION,
    app_version: appVersion,
    build_id: buildInfo?.buildId ?? null,
    commit: buildInfo?.commit ?? null,
    schema_version: schemaVersion,
    created_at: createdAt,
    platform,
    contains_credentials: false,
    encryption: null,
    included,
    excluded,
    counts,
    data_range: dataRange,
    files
  };
}

export const __internal = {isPlainObject, SHA256_PATTERN};
