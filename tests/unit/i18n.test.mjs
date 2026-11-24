import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {cliMessages, CLI_LOCALES, t} from '../../src/launcher/cli-i18n.mjs';
import {
  AI_OUTPUT_LOCALES,
  AVAILABLE_LOCALES,
  DEFAULT_LOCALE,
  LOCALE_REGISTRY
} from '../../src/shared/locales.mjs';
import {
  clearDictionaryCache,
  createTranslator,
  loadDictionary,
  localeDisplayName
} from '../../src/web/js/i18n.js';

const webRoot = fileURLToPath(new URL('../../src/web/i18n/', import.meta.url));
// P41 added six keys (settings.aiOutput.* and toast.aiOutputLanguage) to every
// dictionary, so the contract moved from 2,265 to 2,271 leaf keys. G2 added 31
// Kick keys (17 live/source + 13 errors + common.platform.kick) → 2,302; G5.1
// added two monitoring placeholders → 2,304. The Kuaishou preview added 47 keys
// (31 live/source + 13 errors + 2 monitoring + common.platform.kuaishou) → 2,351.
// v0.18.1 provider-save diagnostics added 20 specific errors + 2 UI keys → 2,373.
// The Credential Manager migration adds 6 credential/key errors → 2,379.
// Translation storage/internal/request diagnostics add 3 keys.
const LEAF_KEYS = 2382;

/** Legacy native-name keys kept from the three-language era. */
const LEGACY_NAME_KEYS = {'zh-CN': 'zh', ja: 'ja', en: 'en'};

/**
 * Reviewed allowlist of keys whose value may equal the English source.
 *
 * The fixture is data, not a blanket exception: it is per language, every entry
 * was inspected (placeholder-only templates, URLs, brand/technical labels, or
 * words spelled identically in that language), and the test fails both on an
 * unlisted identical key and on an entry that is no longer identical.
 */
const SAME_AS_ENGLISH = JSON.parse(
  readFileSync(new URL('../fixtures/i18n-same-as-english.json', import.meta.url), 'utf8')
).accepted;

/** Non-English dictionaries must localise at least this share of all keys. */
const MIN_LOCALISED_SHARE = 0.95;

function flatten(object, prefix = '', out = new Map()) {
  for (const [key, value] of Object.entries(object)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, path, out);
    else out.set(path, value);
  }
  return out;
}

async function loadWeb(locale) {
  return JSON.parse(await readFile(join(webRoot, `${locale}.json`), 'utf8'));
}

async function allDictionaries() {
  const out = new Map();
  for (const locale of AVAILABLE_LOCALES) out.set(locale, flatten(await loadWeb(locale)));
  return out;
}

const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

test('the product ships exactly ten interface languages', () => {
  assert.deepEqual([...AVAILABLE_LOCALES], ['zh-CN', 'ja', 'en', 'ko', 'es', 'pt-BR', 'zh-TW', 'fr', 'de', 'id']);
});

test('web dictionaries share exactly the same keys', async () => {
  const reference = flatten(await loadWeb(DEFAULT_LOCALE));
  for (const locale of AVAILABLE_LOCALES) {
    const dictionary = flatten(await loadWeb(locale));
    const missing = [...reference.keys()].filter((key) => !dictionary.has(key));
    const extra = [...dictionary.keys()].filter((key) => !reference.has(key));
    assert.deepEqual(missing, [], `${locale} is missing keys`);
    assert.deepEqual(extra, [], `${locale} has unknown keys`);
  }
});

test('the shipped dictionaries keep all 2,382 leaf translation keys', async () => {
  for (const locale of AVAILABLE_LOCALES) {
    assert.equal(flatten(await loadWeb(locale)).size, LEAF_KEYS, `${locale} leaf key count changed`);
  }
});

test('every user-visible string is non-empty and keeps its placeholders', async () => {
  const reference = flatten(await loadWeb(DEFAULT_LOCALE));
  for (const locale of AVAILABLE_LOCALES) {
    const dictionary = flatten(await loadWeb(locale));
    for (const [key, value] of dictionary) {
      assert.equal(typeof value, 'string', `${locale}.${key} must be a string`);
      assert.ok(value.trim().length > 0, `${locale}.${key} is empty`);
      assert.deepEqual(placeholders(value), placeholders(reference.get(key)), `${locale}.${key} placeholders differ`);
    }
  }
});

test('no new language was filled with untranslated English', async () => {
  const reference = flatten(await loadWeb(DEFAULT_LOCALE));
  for (const locale of AVAILABLE_LOCALES) {
    if (locale === DEFAULT_LOCALE) continue;
    const dictionary = flatten(await loadWeb(locale));
    const allowed = new Set(SAME_AS_ENGLISH[locale] ?? []);
    const identical = [];
    for (const [key, value] of dictionary) {
      if (value !== reference.get(key)) continue;
      if (allowed.has(key)) continue;
      identical.push(key);
    }
    assert.deepEqual(identical, [], `${locale} keeps ${identical.length} English value(s)`);
    const localised = [...dictionary].filter(([key, value]) => value !== reference.get(key)).length;
    assert.ok(
      localised / dictionary.size >= MIN_LOCALISED_SHARE,
      `${locale} localises only ${localised}/${dictionary.size} keys`
    );
  }
});

test('the English allowlist is exact and cannot be padded', async () => {
  const reference = flatten(await loadWeb(DEFAULT_LOCALE));
  for (const locale of AVAILABLE_LOCALES) {
    if (locale === DEFAULT_LOCALE) continue;
    assert.ok(Array.isArray(SAME_AS_ENGLISH[locale]), `${locale} needs an allowlist entry`);
    const dictionary = flatten(await loadWeb(locale));
    for (const key of SAME_AS_ENGLISH[locale]) {
      assert.equal(
        dictionary.get(key),
        reference.get(key),
        `${locale}.${key} is listed as identical but is translated`
      );
    }
  }
});

test('every key renders as translated text, never as its own raw key', async () => {
  for (const locale of AVAILABLE_LOCALES) {
    const translate = createTranslator(await loadWeb(locale));
    for (const key of flatten(await loadWeb(DEFAULT_LOCALE)).keys()) {
      assert.notEqual(translate(key), key, `${locale}.${key} renders as a raw key`);
    }
  }
});

test('native language names in every dictionary match the single registry', async () => {
  for (const locale of AVAILABLE_LOCALES) {
    const dictionary = await loadWeb(locale);
    // The three legacy keys stay byte-identical; the new languages are named by
    // the registry alone, so the language-name key set stays unchanged.
    for (const [code, key] of Object.entries(LEGACY_NAME_KEYS)) {
      assert.equal(
        dictionary.settings.language[key],
        LOCALE_REGISTRY.find((entry) => entry.code === code).nativeName,
        `${locale}.settings.language.${key}`
      );
    }
    for (const entry of LOCALE_REGISTRY) {
      assert.equal(localeDisplayName(entry.code), entry.nativeName, `registry name for ${entry.code}`);
    }
  }
});

test('AI output languages cover every shipped interface language', () => {
  // P41: the AI output set is the same registry narrowed by `aiOutput`, and every
  // language now has prompts, a schema enum and a translation target.
  assert.deepEqual([...AI_OUTPUT_LOCALES], [...AVAILABLE_LOCALES]);
  for (const code of AI_OUTPUT_LOCALES) assert.ok(AVAILABLE_LOCALES.includes(code), code);
});

test('the launcher console covers every interface language', () => {
  assert.deepEqual([...CLI_LOCALES], [...AVAILABLE_LOCALES]);
  const referenceKeys = Object.keys(cliMessages(DEFAULT_LOCALE));
  const reference = cliMessages(DEFAULT_LOCALE);
  for (const locale of CLI_LOCALES) {
    const messages = cliMessages(locale);
    assert.deepEqual(Object.keys(messages), referenceKeys, `${locale} launcher keys differ`);
    for (const [key, value] of Object.entries(messages)) {
      assert.equal(typeof value, 'string', `${locale}.${key}`);
      assert.ok(value.trim().length > 0, `${locale}.${key} is empty`);
      assert.deepEqual(
        placeholders(value),
        placeholders(reference[key]),
        `${locale}.${key} placeholders differ`
      );
    }
  }
});

test('the launcher help never hardcodes the language list per locale', () => {
  for (const locale of CLI_LOCALES) {
    assert.match(cliMessages(locale).helpBody, /\{locales\}/, `${locale} helpBody`);
    assert.doesNotMatch(cliMessages(locale).helpBody, /zh-CN \| ja \| en/, `${locale} helpBody`);
  }
});

test('launcher interpolation keeps unknown placeholders untouched', () => {
  assert.equal(t('zh-CN', 'dataDirUnwritable', {path: 'D:/x'}), '数据目录不可写入：D:/x');
  assert.match(t('ja', 'alreadyRunning'), /LiveMemory/);
  assert.match(t('en', 'unsupportedNode', {expected: '22.5', actual: '18.0'}), /22\.5/);
  assert.equal(t('en', 'doesNotExist'), 'doesNotExist');
  assert.match(t('de', 'statusRecording', {title: 'X'}), /X/);
});

test('a missing dictionary falls back to the default language once', async () => {
  clearDictionaryCache();
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    if (url.endsWith('/zh-CN.json')) return {ok: false, status: 404, json: async () => ({})};
    if (url.endsWith('/en.json')) return {ok: true, status: 200, json: async () => ({fallback: 'English'})};
    throw new Error(`unexpected request ${url}`);
  };
  const dictionary = await loadDictionary('zh-CN', {fetchImpl});
  assert.deepEqual(dictionary, {fallback: 'English'});
  assert.deepEqual(requested, ['/i18n/zh-CN.json', '/i18n/en.json']);
});

test('a load failure for the default language is reported, not hidden', async () => {
  clearDictionaryCache();
  const fetchImpl = async () => ({ok: false, status: 500, json: async () => ({})});
  await assert.rejects(loadDictionary('en', {fetchImpl}), /i18n load failed/);
  // An unknown installed subset still resolves to its own first resource.
  assert.equal(await loadDictionary('de-DE', {fetchImpl, available: ['de']}).then(
    () => null,
    (error) => error.message
  ), 'i18n load failed: de (500)');
});
