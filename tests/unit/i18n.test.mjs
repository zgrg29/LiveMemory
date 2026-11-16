import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {cliMessages, CLI_LOCALES, t} from '../../src/launcher/cli-i18n.mjs';
import {
  AVAILABLE_LOCALES,
  DEFAULT_LOCALE,
  LOCALE_REGISTRY
} from '../../src/shared/locales.mjs';
import {
  clearDictionaryCache,
  loadDictionary,
  localeDisplayName
} from '../../src/web/js/i18n.js';

const webRoot = fileURLToPath(new URL('../../src/web/i18n/', import.meta.url));

function flatten(object, prefix = '', out = new Map()) {
  for (const [key, value] of Object.entries(object)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') flatten(value, path, out);
    else out.set(path, value);
  }
  return out;
}

async function loadWeb(locale) {
  return JSON.parse(await readFile(join(webRoot, `${locale}.json`), 'utf8'));
}

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

test('the shipped dictionaries keep all 2,265 leaf translation keys', async () => {
  for (const locale of AVAILABLE_LOCALES) {
    assert.equal(flatten(await loadWeb(locale)).size, 2265, `${locale} leaf key count changed`);
  }
});

test('every user-visible string is non-empty and keeps its placeholders', async () => {
  const reference = flatten(await loadWeb(DEFAULT_LOCALE));
  const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  for (const locale of AVAILABLE_LOCALES) {
    const dictionary = flatten(await loadWeb(locale));
    for (const [key, value] of dictionary) {
      assert.equal(typeof value, 'string', `${locale}.${key} must be a string`);
      assert.ok(value.trim().length > 0, `${locale}.${key} is empty`);
      assert.deepEqual(placeholders(value), placeholders(reference.get(key)), `${locale}.${key} placeholders differ`);
    }
  }
});

test('native language names in every dictionary match the single registry', async () => {
  const keys = {'zh-CN': 'zh', ja: 'ja', en: 'en'};
  for (const locale of AVAILABLE_LOCALES) {
    const dictionary = await loadWeb(locale);
    for (const entry of LOCALE_REGISTRY) {
      assert.equal(
        dictionary.settings.language[keys[entry.code]],
        entry.nativeName,
        `${locale}.settings.language.${keys[entry.code]}`
      );
      assert.equal(localeDisplayName(entry.code), entry.nativeName);
    }
  }
});

test('launcher console messages exist in all three languages', () => {
  assert.deepEqual(CLI_LOCALES, ['zh-CN', 'ja', 'en']);
  assert.deepEqual([...CLI_LOCALES], [...AVAILABLE_LOCALES]);
  const referenceKeys = Object.keys(cliMessages('en'));
  for (const locale of CLI_LOCALES) {
    const messages = cliMessages(locale);
    assert.deepEqual(Object.keys(messages), referenceKeys, `${locale} launcher keys differ`);
    for (const [key, value] of Object.entries(messages)) {
      assert.equal(typeof value, 'string', `${locale}.${key}`);
      assert.ok(value.trim().length > 0, `${locale}.${key} is empty`);
    }
  }
});

test('launcher interpolation keeps unknown placeholders untouched', () => {
  assert.equal(t('zh-CN', 'dataDirUnwritable', {path: 'D:/x'}), '数据目录不可写入：D:/x');
  assert.match(t('ja', 'alreadyRunning'), /LiveMemory/);
  assert.match(t('en', 'unsupportedNode', {expected: '22.5', actual: '18.0'}), /22\.5/);
  assert.equal(t('en', 'doesNotExist'), 'doesNotExist');
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
