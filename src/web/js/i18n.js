/**
 * Translation loader.
 *
 * All user-visible strings live in /i18n/<locale>.json. Components never
 * concatenate sentences: they pass parameters to a single template.
 *
 * The locale list and native names come from `src/shared/locales.mjs` — the
 * same file the Node server imports. There is no second hardcoded list here.
 */
import {
  AVAILABLE_LOCALES,
  DEFAULT_LOCALE,
  localeDisplayName,
  resolveLocaleTag
} from '../../shared/locales.mjs';

export {AVAILABLE_LOCALES as SUPPORTED_LOCALES, localeDisplayName};

const cache = new Map();
const DEFAULT_DICTIONARY = DEFAULT_LOCALE;

/** Test-only hook so a failed-resource case can be exercised deterministically. */
export function clearDictionaryCache() {
  cache.clear();
}

function dictionaryLocale(locale, available) {
  const resolved = resolveLocaleTag(locale, {available});
  return resolved ?? defaultDictionaryLocale(available);
}

function defaultDictionaryLocale(available) {
  const list = Array.isArray(available) ? available : AVAILABLE_LOCALES;
  const codes = list.map((entry) => (typeof entry === 'string' ? entry : entry?.code)).filter(Boolean);
  return codes.includes(DEFAULT_DICTIONARY) ? DEFAULT_DICTIONARY : (codes[0] ?? DEFAULT_DICTIONARY);
}

async function fetchDictionary(locale, fetchImpl) {
  const response = await fetchImpl(`/i18n/${locale}.json`, {cache: 'no-store'});
  if (!response.ok) throw new Error(`i18n load failed: ${locale} (${response.status})`);
  return response.json();
}

/**
 * Load a dictionary. A missing/renamed resource falls back to the default
 * language once; only when the default is also unavailable does this throw, so
 * the shell can show its existing localized failure page.
 */
export async function loadDictionary(locale, {
  fetchImpl = globalThis.fetch,
  available = AVAILABLE_LOCALES
} = {}) {
  const requested = dictionaryLocale(locale, available);
  if (cache.has(requested)) return cache.get(requested);
  try {
    const dictionary = await fetchDictionary(requested, fetchImpl);
    cache.set(requested, dictionary);
    return dictionary;
  } catch (error) {
    const fallback = defaultDictionaryLocale(available);
    if (requested === fallback) throw error;
    if (cache.has(fallback)) return cache.get(fallback);
    const dictionary = await fetchDictionary(fallback, fetchImpl);
    cache.set(fallback, dictionary);
    return dictionary;
  }
}

function lookup(dictionary, key) {
  let node = dictionary;
  for (const part of String(key).split('.')) {
    if (node === null || typeof node !== 'object' || !(part in node)) return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/** Build a translate function for a dictionary. */
export function createTranslator(dictionary) {
  return function t(key, params = {}) {
    const template = lookup(dictionary, key) ?? lookup(dictionary, '') ?? key;
    if (typeof template !== 'string') return key;
    return template.replace(/\{(\w+)\}/g, (match, name) => (
      Object.hasOwn(params, name) ? String(params[name]) : match
    ));
  };
}
