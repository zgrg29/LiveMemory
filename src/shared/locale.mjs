/**
 * Language resolution shared by the launcher (console) and the web console.
 *
 * The language list itself lives in `src/shared/locales.mjs` (the only source
 * of truth). This module adds the preference/system environment layer on top:
 *
 *   1. the user's stored preference ("system" or a declared language code);
 *   2. the language detected from the operating system;
 *   3. the language resources that are actually installed.
 *
 * Preferences are stored as either "system" or one of SUPPORTED_LOCALES. The
 * system locale is only ever used to *resolve* "system"; it never overwrites the
 * stored preference. Resolution always returns an installed language, so a
 * missing dictionary degrades instead of leaving a blank console.
 */
import {
  AI_OUTPUT_LOCALES,
  AVAILABLE_LOCALES,
  DEFAULT_LOCALE,
  LOCALE_PREFERENCE_SYSTEM,
  LOCALE_REGISTRY,
  defaultLocaleFor,
  localeDescriptor,
  localeDescriptors,
  localeDisplayName,
  parseLocaleTag,
  resolveLocaleTag
} from './locales.mjs';

export {
  AI_OUTPUT_LOCALES,
  AVAILABLE_LOCALES,
  DEFAULT_LOCALE,
  LOCALE_PREFERENCE_SYSTEM,
  LOCALE_REGISTRY,
  defaultLocaleFor,
  localeDescriptor,
  localeDescriptors,
  localeDisplayName,
  parseLocaleTag,
  resolveLocaleTag
};

/** Declared interface languages (kept as a named export for older callers). */
export const SUPPORTED_LOCALES = AVAILABLE_LOCALES;

/** Fallback used when nothing else can be resolved. */
export const FALLBACK_LOCALE = DEFAULT_LOCALE;

/**
 * Normalize a language tag to a *declared* language, or null.
 *
 * This validates what a user may store; it deliberately ignores whether the
 * dictionary file is currently present. `resolveLocale()` performs the
 * availability-driven degradation.
 */
export function normalizeLocale(value, options = {}) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (raw === LOCALE_PREFERENCE_SYSTEM) return LOCALE_PREFERENCE_SYSTEM;
  return resolveLocaleTag(raw, options);
}

/** Normalize a stored preference, defaulting to "system" when unusable. */
export function normalizeLocalePreference(value) {
  const normalized = normalizeLocale(value);
  if (!normalized) return LOCALE_PREFERENCE_SYSTEM;
  return normalized;
}

/** Map an arbitrary system locale string onto a declared language or default. */
export function mapSystemLocale(systemLocale, options = {}) {
  return resolveLocaleTag(systemLocale, options) || defaultLocaleFor(options.available);
}

/**
 * Resolve the effective UI language against the installed resources.
 *
 * @param {string} preference "system" | declared locale code
 * @param {string} systemLocale e.g. "zh-CN", "ja-JP", "de-DE"
 * @param {{available?: Array<string|object>}} [options] installed resources
 */
export function resolveLocale(preference, systemLocale, options = {}) {
  const normalized = normalizeLocale(preference, options);
  if (normalized && normalized !== LOCALE_PREFERENCE_SYSTEM) return normalized;
  return mapSystemLocale(systemLocale, options);
}

/** Best effort detection of the operating system locale. */
export function detectSystemLocale(env = process.env, options = {}) {
  for (const key of ['LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const value = env?.[key];
    if (!value || value === 'C' || value === 'POSIX') continue;
    const mapped = resolveLocaleTag(value, options);
    // An explicit but unsupported locale means the user's system language is
    // not one we support: fall back to the default instead of guessing further.
    return mapped ?? defaultLocaleFor(options.available);
  }
  try {
    const intl = new Intl.DateTimeFormat().resolvedOptions().locale;
    const mapped = resolveLocaleTag(intl, options);
    if (mapped) return mapped;
  } catch {
    /* ignore: fall through to the default language */
  }
  return defaultLocaleFor(options.available);
}

export function isSupportedLocale(value) {
  return SUPPORTED_LOCALES.includes(value);
}

/**
 * Narrow an interface language onto a language the AI output really supports.
 *
 * Since P41 every shipped interface language also has an AI output rule, prompt
 * set and result schema enum, so for the ten supported languages this is an
 * identity mapping. The narrowing still exists because it is the *capability*
 * gate: a language tag that is not an output language (`th-TH`) or a future
 * interface-only language can never reach a provider. The closest family member
 * is used when one exists (`zh-HK` → `zh-TW`), otherwise the default language.
 */
export function aiOutputLocale(value, {fallback = DEFAULT_LOCALE} = {}) {
  const resolved = resolveLocaleTag(value, {available: AI_OUTPUT_LOCALES});
  if (resolved) return resolved;
  return AI_OUTPUT_LOCALES.includes(fallback) ? fallback : (AI_OUTPUT_LOCALES[0] ?? DEFAULT_LOCALE);
}

/**
 * Stored preference value meaning "use whatever the interface language is".
 *
 * This is deliberately *not* the same thing as the interface language setting:
 * the AI output language is its own persisted preference, defaults to
 * `follow-ui`, and is snapshotted into every task when the task is created.
 */
export const AI_OUTPUT_PREFERENCE_FOLLOW_UI = 'follow-ui';

/**
 * Parse an AI output language preference.
 *
 * Accepts `follow-ui` or any language tag that resolves onto the AI output set.
 * Returns `follow-ui`, a canonical language code, or `null` when the value is not
 * usable. `normalizeAiOutputPreference()` maps "not usable" onto the default so
 * an old or corrupt settings file can never block the console.
 */
export function parseAiOutputPreference(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (raw.toLowerCase() === AI_OUTPUT_PREFERENCE_FOLLOW_UI) return AI_OUTPUT_PREFERENCE_FOLLOW_UI;
  return resolveLocaleTag(raw, {available: AI_OUTPUT_LOCALES});
}

/** Normalize a stored AI output preference, defaulting to `follow-ui`. */
export function normalizeAiOutputPreference(value) {
  return parseAiOutputPreference(value) ?? AI_OUTPUT_PREFERENCE_FOLLOW_UI;
}

/**
 * Resolve the concrete AI output language a *new* task would use.
 *
 * Order: an explicit preference wins; `follow-ui` (the default) follows the
 * effective interface language. The result is always a language with real AI
 * output support, and it never mutates any stored preference.
 */
export function resolveAiOutputPreference(preference, {uiLocale = null, systemLocale = null} = {}) {
  const parsed = parseAiOutputPreference(preference);
  if (parsed && parsed !== AI_OUTPUT_PREFERENCE_FOLLOW_UI) return aiOutputLocale(parsed);
  const ui = uiLocale === LOCALE_PREFERENCE_SYSTEM || !uiLocale ? systemLocale : uiLocale;
  return aiOutputLocale(ui);
}
