import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {cliMessages, CLI_LOCALES, t} from '../../src/launcher/cli-i18n.mjs';

const WEB_LOCALES = ['zh-CN', 'ja', 'en'];
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
  const reference = flatten(await loadWeb('en'));
  for (const locale of WEB_LOCALES) {
    const dictionary = flatten(await loadWeb(locale));
    const missing = [...reference.keys()].filter((key) => !dictionary.has(key));
    const extra = [...dictionary.keys()].filter((key) => !reference.has(key));
    assert.deepEqual(missing, [], `${locale} is missing keys`);
    assert.deepEqual(extra, [], `${locale} has unknown keys`);
  }
});

test('every user-visible string is non-empty and keeps its placeholders', async () => {
  const reference = flatten(await loadWeb('en'));
  const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  for (const locale of WEB_LOCALES) {
    const dictionary = flatten(await loadWeb(locale));
    for (const [key, value] of dictionary) {
      assert.equal(typeof value, 'string', `${locale}.${key} must be a string`);
      assert.ok(value.trim().length > 0, `${locale}.${key} is empty`);
      assert.deepEqual(placeholders(value), placeholders(reference.get(key)), `${locale}.${key} placeholders differ`);
    }
  }
});

test('launcher console messages exist in all three languages', () => {
  assert.deepEqual(CLI_LOCALES, ['zh-CN', 'ja', 'en']);
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
