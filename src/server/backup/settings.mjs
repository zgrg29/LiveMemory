import {normalizeSettings} from '../settings-store.mjs';
import {AppError} from '../../shared/errors.mjs';

/**
 * Settings are the only non-database input to a portable backup.
 *
 * Machine-specific values are deliberately dropped:
 * - `preferredPort` would bind the new computer to this one's port preference;
 * - `updatedAt` is bookkeeping, not a preference.
 *
 * The data-folder pointer and every credential live outside this file and are
 * never part of a backup.
 */
export const BACKUP_SETTING_KEYS = Object.freeze([
  'locale',
  'theme',
  'storageMode',
  'onboardingCompleted',
  'youtubeRawRetentionDays'
]);

export function settingsForBackup(input) {
  const normalized = normalizeSettings(input ?? {});
  const result = {version: 1};
  for (const key of BACKUP_SETTING_KEYS) result[key] = normalized[key];
  return result;
}

/** Parse and validate `config/settings.json` from an untrusted archive. */
export function parseBackupSettings(buffer) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer ?? ''));
  } catch {
    throw new AppError('BACKUP_SETTINGS_INVALID', {
      messageKey: 'errors.backupSettingsInvalid',
      details: {reason: 'json'},
      httpStatus: 400
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError('BACKUP_SETTINGS_INVALID', {
      messageKey: 'errors.backupSettingsInvalid',
      details: {reason: 'object'},
      httpStatus: 400
    });
  }
  for (const key of Object.keys(parsed)) {
    if (key === 'version') continue;
    if (!BACKUP_SETTING_KEYS.includes(key)) {
      throw new AppError('BACKUP_SETTINGS_INVALID', {
        messageKey: 'errors.backupSettingsInvalid',
        details: {reason: 'unknown-key', field: key},
        httpStatus: 400
      });
    }
  }
  return settingsForBackup(parsed);
}
