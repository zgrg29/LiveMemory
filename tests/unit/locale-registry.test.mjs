import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  AVAILABLE_LOCALES,
  DEFAULT_LOCALE,
  LOCALE_REGISTRY,
  localeDescriptor,
  localeDescriptors
} from '../../src/shared/locales.mjs';
import {CLI_LOCALES} from '../../src/launcher/cli-i18n.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const FUTURE_CODES = ['ko', 'es', 'pt-BR', 'zh-TW', 'fr', 'de', 'id'];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

test('the registry is the only declaration of interface languages', () => {
  assert.deepEqual([...AVAILABLE_LOCALES], ['zh-CN', 'ja', 'en']);
  assert.equal(DEFAULT_LOCALE, 'en');
  assert.equal(LOCALE_REGISTRY.length, 3);
  for (const entry of LOCALE_REGISTRY) {
    assert.equal(entry.available, true, `${entry.code} must be available`);
    assert.ok(entry.nativeName && entry.nativeName.trim(), `${entry.code} native name`);
    assert.ok(entry.language, `${entry.code} language family`);
  }
});

test('planned languages are not advertised as available before their dictionaries exist', () => {
  for (const code of FUTURE_CODES) {
    assert.equal(
      LOCALE_REGISTRY.some((entry) => entry.code.toLowerCase() === code.toLowerCase()),
      false,
      `${code} must not be in the product registry yet`
    );
    assert.equal(localeDescriptor(code), null);
  }
});

test('every available language has a real dictionary with the same native name', () => {
  for (const entry of LOCALE_REGISTRY) {
    const file = join(root, 'src/web/i18n', `${entry.code}.json`);
    const dictionary = JSON.parse(readFileSync(file, 'utf8'));
    const key = entry.code === 'zh-CN' ? 'zh' : entry.code;
    assert.equal(dictionary.settings.language[key], entry.nativeName, file);
  }
});

test('selector metadata keeps registry order and native names', () => {
  const descriptors = localeDescriptors(AVAILABLE_LOCALES);
  assert.deepEqual(descriptors.map((entry) => entry.code), [...AVAILABLE_LOCALES]);
  assert.deepEqual(descriptors.map((entry) => entry.nativeName), ['简体中文', '日本語', 'English']);
});

test('no second hardcoded three-language array survives in src', () => {
  const offenders = [];
  const patterns = [
    /\[\s*['"]zh-CN['"]\s*,\s*['"]ja['"]\s*,\s*['"]en['"]\s*\]/,
    /\[\s*['"]en['"]\s*,\s*['"]ja['"]\s*,\s*['"]zh-CN['"]\s*\]/,
    /SUPPORTED_LOCALES\s*=\s*Object\.freeze\(\s*\[/
  ];
  for (const file of walk(join(root, 'src'))) {
    if (!/\.(mjs|js)$/.test(file)) continue;
    const source = readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      if (pattern.test(source)) offenders.push(`${relative(root, file)} :: ${pattern}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the AI result schemas mirror the registry instead of drifting', () => {
  for (const file of [
    'src/ai/schemas/analysis-result-v1.schema.json',
    'src/memory/schemas/memory-update-result-v1.schema.json'
  ]) {
    const schema = JSON.parse(readFileSync(join(root, file), 'utf8'));
    assert.deepEqual(schema.properties.locale.enum, [...AVAILABLE_LOCALES], file);
  }
});

test('the launcher console uses the same language codes', () => {
  assert.deepEqual([...CLI_LOCALES], [...AVAILABLE_LOCALES]);
});
