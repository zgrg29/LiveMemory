/**
 * The single source of truth for LiveMemory's interface languages.
 *
 * This module is intentionally isomorphic: the browser console imports it from
 * `/shared/locales.mjs` and Node imports the same file from `src/shared/`.
 * Nothing else may declare a second list of supported UI languages.
 *
 * Design rules (see `docs/I18N.md`):
 * - Only languages that actually ship a dictionary are listed here. A planned
 *   language must not be advertised as available before its dictionary exists.
 * - `available` is the declared availability used for preference validation.
 *   The server additionally narrows it to dictionaries that are really present
 *   on disk (`src/server/locale-resources.mjs`); a missing resource therefore
 *   degrades instead of breaking the console.
 * - Resolution is driven by language family, script and region, not by a fixed
 *   `if (zh) return zh-CN` chain. Adding `zh-TW` later only needs a registry
 *   entry plus its dictionary: `zh-HK`/`zh-Hant` then prefer it automatically.
 * - Unknown or unsupported input returns `null`; callers map that onto the
 *   explicit default (`en`) so a bad value can never produce a blank console.
 */

export const LOCALE_PREFERENCE_SYSTEM = 'system';
export const DEFAULT_LOCALE = 'en';

const freeze = (value) => Object.freeze(value);

/**
 * Declared interface languages. Keep the order stable: it is the order used by
 * every language selector. `nativeName` is always written in that language and
 * is never translated.
 */
export const LOCALE_REGISTRY = freeze([
  freeze({
    code: 'zh-CN',
    nativeName: '简体中文',
    englishName: 'Simplified Chinese',
    language: 'zh',
    script: 'Hans',
    regions: freeze(['CN', 'SG', 'MY']),
    available: true,
    aiOutput: true
  }),
  freeze({
    code: 'ja',
    nativeName: '日本語',
    englishName: 'Japanese',
    language: 'ja',
    script: null,
    regions: freeze(['JP']),
    available: true,
    aiOutput: true
  }),
  freeze({
    code: 'en',
    nativeName: 'English',
    englishName: 'English',
    language: 'en',
    script: null,
    regions: freeze(['US', 'GB', 'AU', 'CA', 'NZ', 'IE']),
    available: true,
    aiOutput: true
  }),
  freeze({
    code: 'ko',
    nativeName: '한국어',
    englishName: 'Korean',
    language: 'ko',
    script: null,
    regions: freeze(['KR']),
    available: true,
    aiOutput: false
  }),
  freeze({
    code: 'es',
    nativeName: 'Español',
    englishName: 'Spanish',
    language: 'es',
    script: null,
    regions: freeze(['ES', 'MX', 'AR', 'CO', 'CL', 'PE', 'VE', 'UY', 'US']),
    available: true,
    aiOutput: false
  }),
  freeze({
    code: 'pt-BR',
    nativeName: 'Português (Brasil)',
    englishName: 'Brazilian Portuguese',
    language: 'pt',
    script: null,
    regions: freeze(['BR']),
    available: true,
    aiOutput: false
  }),
  freeze({
    code: 'zh-TW',
    nativeName: '繁體中文',
    englishName: 'Traditional Chinese',
    language: 'zh',
    script: 'Hant',
    regions: freeze(['TW', 'HK', 'MO']),
    available: true,
    aiOutput: false
  }),
  freeze({
    code: 'fr',
    nativeName: 'Français',
    englishName: 'French',
    language: 'fr',
    script: null,
    regions: freeze(['FR', 'BE', 'CA', 'CH', 'LU', 'MC']),
    available: true,
    aiOutput: false
  }),
  freeze({
    code: 'de',
    nativeName: 'Deutsch',
    englishName: 'German',
    language: 'de',
    script: null,
    regions: freeze(['DE', 'AT', 'CH', 'LU', 'LI']),
    available: true,
    aiOutput: false
  }),
  freeze({
    code: 'id',
    nativeName: 'Bahasa Indonesia',
    englishName: 'Indonesian',
    language: 'id',
    script: null,
    regions: freeze(['ID']),
    available: true,
    aiOutput: false
  })
]);

/** Codes of the declared (shipped) interface languages, in selector order. */
export const AVAILABLE_LOCALES = freeze(
  LOCALE_REGISTRY.filter((entry) => entry.available).map((entry) => entry.code)
);

/**
 * Languages the *AI output* can be produced in. This is deliberately narrower
 * than the interface list until the prompt set, the result schema and the
 * translation target names exist for a language (P41). A language without
 * `aiOutput: true` is never sent to a provider as an analysis language; the
 * callers fall back to `DEFAULT_LOCALE` instead of inventing a locale.
 */
export const AI_OUTPUT_LOCALES = freeze(
  LOCALE_REGISTRY.filter((entry) => entry.aiOutput).map((entry) => entry.code)
);

/** Legacy BCP-47 language subtags that are still accepted as aliases. */
const LANGUAGE_ALIASES = freeze({
  in: 'id',
  iw: 'he',
  ji: 'yi'
});

/**
 * Stable script hints for Chinese regions. This is *not* a supported-language
 * list: it only lets a region-only tag (`zh-HK`) be matched against the script
 * of an available dictionary (`zh-TW` once it exists, `zh-CN` today).
 */
const REGION_SCRIPT_HINTS = freeze({
  'zh-TW': 'Hant',
  'zh-HK': 'Hant',
  'zh-MO': 'Hant',
  'zh-CN': 'Hans',
  'zh-SG': 'Hans',
  'zh-MY': 'Hans'
});

function registryFor(registry) {
  return Array.isArray(registry) ? registry : LOCALE_REGISTRY;
}

function findRegistryEntry(code, registry = LOCALE_REGISTRY) {
  if (code === null || code === undefined) return null;
  const needle = String(code).toLowerCase();
  return registryFor(registry).find((entry) => String(entry.code).toLowerCase() === needle) ?? null;
}

/** Look up one declared language by its exact code (case-insensitive). */
export function localeDescriptor(code, registry = LOCALE_REGISTRY) {
  const entry = findRegistryEntry(code, registry);
  return entry ? {...entry, regions: [...(entry.regions ?? [])]} : null;
}

function inferScript(language, region) {
  if (!language || !region) return null;
  return REGION_SCRIPT_HINTS[`${language}-${region}`] ?? null;
}

function canonicalTag(language, script, region) {
  return [language, script, region].filter(Boolean).join('-');
}

/**
 * Parse a BCP-47-ish tag. Accepts `zh_CN.UTF-8`, `ja-JP`, `zh-Hant-TW`,
 * `en-US@modifier`, and returns `{language, script, region, code}` or null.
 */
export function parseLocaleTag(value) {
  if (value === null || value === undefined) return null;
  let raw = String(value).trim();
  if (!raw || raw === LOCALE_PREFERENCE_SYSTEM) return null;
  raw = raw.split('@')[0].split('.')[0].replace(/_/g, '-');
  const parts = raw.split('-').filter(Boolean);
  if (parts.length === 0) return null;
  const base = parts[0].toLowerCase();
  if (!/^[a-z]{2,8}$/.test(base)) return null;
  const language = LANGUAGE_ALIASES[base] ?? base;
  let script = null;
  let region = null;
  for (const part of parts.slice(1)) {
    if (!script && /^[a-z]{4}$/i.test(part)) {
      script = part[0].toUpperCase() + part.slice(1).toLowerCase();
      continue;
    }
    if (!region && /^([a-z]{2}|\d{3})$/i.test(part)) {
      region = part.toUpperCase();
    }
  }
  return {language, script, region, code: canonicalTag(language, script, region)};
}

function normalizeDescriptor(input, registry) {
  const raw = typeof input === 'string' ? {code: input} : {...input};
  const code = String(raw.code ?? '');
  if (!code) throw new Error('locale descriptor requires a code');
  const known = findRegistryEntry(code, registry);
  const parsed = parseLocaleTag(code);
  const language = raw.language ?? known?.language ?? parsed?.language ?? null;
  const region = raw.region ?? known?.regions?.[0] ?? parsed?.region ?? null;
  const script = raw.script ?? known?.script ?? parsed?.script ?? inferScript(language, region);
  const regions = raw.regions
    ?? known?.regions
    ?? (region ? [region] : []);
  return {
    code: known?.code ?? code,
    nativeName: raw.nativeName ?? known?.nativeName ?? code,
    englishName: raw.englishName ?? known?.englishName ?? code,
    language,
    script,
    region,
    regions: [...regions],
    available: true
  };
}

/**
 * Describe an available subset. Entries may be codes or descriptor objects, so
 * tests can simulate planned languages and the server can pass installed codes.
 */
export function localeDescriptors(available = AVAILABLE_LOCALES, registry = LOCALE_REGISTRY) {
  const list = Array.isArray(available) ? available : [];
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    const descriptor = normalizeDescriptor(entry, registry);
    const key = descriptor.code.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(descriptor);
  }
  return out;
}

/** The default locale among an available subset (falls back to the first). */
export function defaultLocaleFor(available = AVAILABLE_LOCALES) {
  const descriptors = localeDescriptors(available);
  if (descriptors.some((entry) => entry.code === DEFAULT_LOCALE)) return DEFAULT_LOCALE;
  return descriptors[0]?.code ?? DEFAULT_LOCALE;
}

/**
 * Resolve an arbitrary language tag onto an actually available language.
 *
 * Order: exact code -> same language family with matching region/script ->
 * first remaining family member -> `null` (caller decides the default).
 */
export function resolveLocaleTag(value, {available = AVAILABLE_LOCALES, registry = LOCALE_REGISTRY} = {}) {
  const parsed = parseLocaleTag(value);
  if (!parsed) return null;
  const descriptors = localeDescriptors(available, registry);
  if (descriptors.length === 0) return null;
  const exact = descriptors.find((entry) => entry.code.toLowerCase() === parsed.code.toLowerCase());
  if (exact) return exact.code;
  const candidates = descriptors.filter((entry) => entry.language === parsed.language);
  if (candidates.length === 0) return null;
  const parsedScript = parsed.script ?? inferScript(parsed.language, parsed.region);
  let best = null;
  let bestScore = -1;
  for (const entry of candidates) {
    const entryScript = entry.script ?? inferScript(entry.language, entry.region);
    let score = 0;
    if (parsed.region) {
      if (entry.region === parsed.region || entry.regions.includes(parsed.region)) score += 100;
    }
    if (parsedScript && entryScript && parsedScript === entryScript) score += 50;
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  return best?.code ?? null;
}

/** Native name of a declared language; unknown codes fall back to English. */
export function localeDisplayName(code) {
  const descriptor = localeDescriptor(code);
  if (descriptor) return descriptor.nativeName;
  return localeDescriptor(DEFAULT_LOCALE)?.nativeName ?? DEFAULT_LOCALE;
}
