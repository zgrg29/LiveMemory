/**
 * Translation loader.
 *
 * All user-visible strings live in /i18n/<locale>.json. Components never
 * concatenate sentences: they pass parameters to a single template.
 */
export const SUPPORTED_LOCALES = ['zh-CN', 'ja', 'en'];
const cache = new Map();

export async function loadDictionary(locale) {
  const safe = SUPPORTED_LOCALES.includes(locale) ? locale : 'en';
  if (cache.has(safe)) return cache.get(safe);
  const response = await fetch(`/i18n/${safe}.json`, {cache: 'no-store'});
  if (!response.ok) throw new Error(`i18n load failed: ${safe}`);
  const dictionary = await response.json();
  cache.set(safe, dictionary);
  return dictionary;
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

/** Locale label used inside language selectors (always in its own language). */
export function localeDisplayName(locale) {
  if (locale === 'zh-CN') return '简体中文';
  if (locale === 'ja') return '日本語';
  return 'English';
}
