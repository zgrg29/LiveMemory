import {readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, copyFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {normalizeLocalePreference, normalizeLocale} from '../shared/locale.mjs';
import {normalizeTheme, THEMES} from '../shared/theme.mjs';
import {STORAGE_MODES, normalizeStorageMode} from '../shared/storage-mode.mjs';
import {AppError, ERROR_CODES} from '../shared/errors.mjs';
import {DEFAULT_YOUTUBE_RAW_RETENTION_DAYS, normalizeRetentionDays} from '../storage/retention.mjs';
import {DEFAULT_YOUTUBE_CAPTURE_MODE, YOUTUBE_CAPTURE_MODES, normalizeYouTubeCaptureMode} from '../shared/capture-mode.mjs';

/**
 * Application preferences (language, theme, storage mode, preferred port).
 *
 * Stored as JSON instead of SQLite on purpose: the launcher must know the
 * language *before* the database exists (first run) or is migrated, and the
 * console must still speak the user's language if the database is broken.
 */
export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  locale: 'system',
  theme: 'system',
  storageMode: 'compact',
  preferredPort: 47800,
  onboardingCompleted: false,
  youtubeCaptureMode: DEFAULT_YOUTUBE_CAPTURE_MODE,
  youtubeRawRetentionDays: DEFAULT_YOUTUBE_RAW_RETENTION_DAYS,
  updatedAt: null
});

export const SETTINGS_KEYS = Object.freeze([
  'locale',
  'theme',
  'storageMode',
  'preferredPort',
  'onboardingCompleted',
  'youtubeCaptureMode',
  'youtubeRawRetentionDays'
]);

function validatePort(value) {
  if (value === null || value === undefined || value === '') return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
  return port;
}

export function normalizeSettings(input = {}) {
  const locale = normalizeLocalePreference(input.locale);
  const theme = normalizeTheme(input.theme);
  const storageMode = normalizeStorageMode(input.storageMode);
  const preferredPort = validatePort(input.preferredPort) ?? DEFAULT_SETTINGS.preferredPort;
  const onboardingCompleted = input.onboardingCompleted === true;
  return {
    version: 1,
    locale,
    theme,
    storageMode,
    preferredPort,
    onboardingCompleted,
    youtubeCaptureMode: normalizeYouTubeCaptureMode(input.youtubeCaptureMode),
    youtubeRawRetentionDays: normalizeRetentionDays(input.youtubeRawRetentionDays),
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : null
  };
}

export class SettingsStore {
  constructor({file, logger = null}) {
    this.file = file;
    this.logger = logger;
    this.settings = {...DEFAULT_SETTINGS};
    this.loadedFromDisk = false;
  }

  load() {
    if (!existsSync(this.file)) {
      this.settings = normalizeSettings(DEFAULT_SETTINGS);
      return this.get();
    }
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      this.settings = normalizeSettings(raw);
      this.loadedFromDisk = true;
    } catch (error) {
      // Keep the unreadable file for support, then continue with defaults so a
      // corrupt preference file can never block startup.
      try {
        copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch {
        /* best effort */
      }
      this.logger?.warn({event: 'settings.corrupt', code: error?.code ?? 'parse'});
      this.settings = normalizeSettings(DEFAULT_SETTINGS);
    }
    return this.get();
  }

  get() {
    return {...this.settings};
  }

  /** Patch preferences. Unknown or invalid values are rejected, not ignored. */
  update(patch, {now = Date.now()} = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new AppError(ERROR_CODES.SETTINGS_INVALID, {messageKey: 'errors.settingsInvalid', httpStatus: 400});
    }
    const next = {...this.settings};
    for (const [key, value] of Object.entries(patch)) {
      if (!SETTINGS_KEYS.includes(key)) {
        throw new AppError(ERROR_CODES.SETTINGS_INVALID, {
          messageKey: 'errors.settingsInvalid',
          details: {field: key},
          httpStatus: 400
        });
      }
      switch (key) {
        case 'locale': {
          const normalized = normalizeLocale(value);
          if (!normalized) {
            throw new AppError(ERROR_CODES.SETTINGS_INVALID, {
              messageKey: 'errors.settingsInvalid',
              details: {field: 'locale'},
              httpStatus: 400
            });
          }
          next.locale = normalized;
          break;
        }
        case 'theme':
          if (!THEMES.includes(String(value))) {
            throw new AppError(ERROR_CODES.SETTINGS_INVALID, {
              messageKey: 'errors.settingsInvalid',
              details: {field: 'theme'},
              httpStatus: 400
            });
          }
          next.theme = String(value);
          break;
        case 'storageMode':
          if (!STORAGE_MODES.includes(String(value))) {
            throw new AppError(ERROR_CODES.SETTINGS_INVALID, {
              messageKey: 'errors.settingsInvalid',
              details: {field: 'storageMode'},
              httpStatus: 400
            });
          }
          next.storageMode = normalizeStorageMode(value);
          break;
        case 'preferredPort': {
          const port = validatePort(value);
          if (value !== null && value !== undefined && value !== '' && port === null) {
            throw new AppError(ERROR_CODES.SETTINGS_INVALID, {
              messageKey: 'errors.settingsInvalid',
              details: {field: 'preferredPort'},
              httpStatus: 400
            });
          }
          next.preferredPort = port ?? DEFAULT_SETTINGS.preferredPort;
          break;
        }
        case 'onboardingCompleted':
          next.onboardingCompleted = value === true;
          break;
        case 'youtubeCaptureMode':
          if (!YOUTUBE_CAPTURE_MODES.includes(String(value))) {
            throw new AppError(ERROR_CODES.SETTINGS_INVALID, {
              messageKey: 'errors.settingsInvalid',
              details: {field: 'youtubeCaptureMode'},
              httpStatus: 400
            });
          }
          next.youtubeCaptureMode = normalizeYouTubeCaptureMode(value);
          break;
        case 'youtubeRawRetentionDays': {
          const days = Number(value);
          if (!Number.isFinite(days) || days < 1 || days > 30) {
            throw new AppError(ERROR_CODES.SETTINGS_INVALID, {
              messageKey: 'errors.settingsInvalid',
              details: {field: 'youtubeRawRetentionDays'},
              httpStatus: 400
            });
          }
          next.youtubeRawRetentionDays = normalizeRetentionDays(days);
          break;
        }
        default:
          break;
      }
    }
    next.updatedAt = new Date(now).toISOString();
    this.settings = next;
    this.save();
    return this.get();
  }

  /**
   * Restore factory defaults and persist them. Used by the factory-reset flow;
   * the data-location pointer is deliberately stored elsewhere and survives.
   */
  reset({now = Date.now()} = {}) {
    this.settings = normalizeSettings(DEFAULT_SETTINGS);
    this.settings.updatedAt = new Date(now).toISOString();
    this.save();
    return this.get();
  }

  save() {
    mkdirSync(dirname(this.file), {recursive: true});
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(this.settings, null, 2)}\n`, 'utf8');
    renameSync(temp, this.file);
    return this.file;
  }
}
