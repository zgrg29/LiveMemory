/**
 * Language resolution shared by the launcher (console) and the web console.
 *
 * Preferences are stored as either "system" or one of SUPPORTED_LOCALES.
 * The system locale is only ever used to *resolve* "system"; it never
 * overwrites the stored preference.
 */
export const SUPPORTED_LOCALES = Object.freeze(['zh-CN', 'ja', 'en']);
export const FALLBACK_LOCALE = 'en';
export const LOCALE_PREFERENCE_SYSTEM = 'system';

/** Normalize any user supplied value to a supported locale or null. */
export function normalizeLocale(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (raw === LOCALE_PREFERENCE_SYSTEM) return LOCALE_PREFERENCE_SYSTEM;
  const lower = raw.toLowerCase().replace(/_/g, '-');
  if (lower === 'zh' || lower.startsWith('zh-')) return 'zh-CN';
  if (lower === 'ja' || lower.startsWith('ja-')) return 'ja';
  if (lower === 'en' || lower.startsWith('en-')) return 'en';
  return null;
}

/** Normalize a stored preference, defaulting to "system" when unusable. */
export function normalizeLocalePreference(value) {
  const normalized = normalizeLocale(value);
  if (!normalized) return LOCALE_PREFERENCE_SYSTEM;
  return normalized;
}

/** Map an arbitrary system locale string onto a supported locale. */
export function mapSystemLocale(systemLocale) {
  return normalizeLocale(systemLocale) || FALLBACK_LOCALE;
}

/**
 * Resolve the effective UI language.
 * @param {string} preference "system" | "zh-CN" | "ja" | "en"
 * @param {string} systemLocale e.g. "zh-CN", "ja-JP", "de-DE"
 */
export function resolveLocale(preference, systemLocale) {
  const normalized = normalizeLocale(preference);
  if (normalized && normalized !== LOCALE_PREFERENCE_SYSTEM) return normalized;
  return mapSystemLocale(systemLocale);
}

/** Best effort detection of the operating system locale. */
export function detectSystemLocale(env = process.env) {
  for (const key of ['LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const value = env?.[key];
    if (!value || value === 'C' || value === 'POSIX') continue;
    const mapped = normalizeLocale(value);
    // An explicit but unsupported locale means the user's system language is
    // not one we support: fall back to English instead of guessing further.
    return mapped && mapped !== LOCALE_PREFERENCE_SYSTEM ? mapped : FALLBACK_LOCALE;
  }
  try {
    const intl = new Intl.DateTimeFormat().resolvedOptions().locale;
    const mapped = normalizeLocale(intl);
    if (mapped && mapped !== LOCALE_PREFERENCE_SYSTEM) return mapped;
  } catch {
    /* ignore: fall through to English */
  }
  return FALLBACK_LOCALE;
}

export function isSupportedLocale(value) {
  return SUPPORTED_LOCALES.includes(value);
}
