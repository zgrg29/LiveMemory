import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  AI_OUTPUT_LOCALES,
  AVAILABLE_LOCALES,
  DEFAULT_LOCALE,
  LOCALE_REGISTRY,
  localeDescriptor,
  localeDescriptors
} from '../../src/shared/locales.mjs';
import {CLI_LOCALES} from '../../src/launcher/cli-i18n.mjs';
import {SUPPORTED_LOCALES, promptVersionFor} from '../../src/ai/constants.mjs';
import {SUPPORTED_MEMORY_LOCALES, memoryPromptVersionFor} from '../../src/memory/constants.mjs';
import {buildInstructions} from '../../src/ai/prompts/instructions.mjs';
import {LOCALE_NAME} from '../../src/ai/translation/service.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const TEN_CODES = ['zh-CN', 'ja', 'en', 'ko', 'es', 'pt-BR', 'zh-TW', 'fr', 'de', 'id'];

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
  assert.deepEqual([...AVAILABLE_LOCALES], TEN_CODES);
  assert.equal(DEFAULT_LOCALE, 'en');
  assert.equal(LOCALE_REGISTRY.length, 10);
  for (const entry of LOCALE_REGISTRY) {
    assert.equal(entry.available, true, `${entry.code} must be available`);
    assert.ok(entry.nativeName && entry.nativeName.trim(), `${entry.code} native name`);
    assert.ok(entry.englishName && entry.englishName.trim(), `${entry.code} english name`);
    assert.ok(entry.language, `${entry.code} language family`);
    assert.equal(typeof entry.aiOutput, 'boolean', `${entry.code} aiOutput flag`);
  }
  assert.deepEqual(
    LOCALE_REGISTRY.map((entry) => entry.nativeName),
    ['简体中文', '日本語', 'English', '한국어', 'Español', 'Português (Brasil)', '繁體中文', 'Français', 'Deutsch', 'Bahasa Indonesia']
  );
});

test('every advertised language really ships a dictionary', () => {
  for (const code of AVAILABLE_LOCALES) {
    const file = join(root, 'src/web/i18n', `${code}.json`);
    assert.ok(existsSync(file), `${code} must have a dictionary`);
    const dictionary = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(dictionary.settings.language.title.length > 0, true, `${code} dictionary looks empty`);
  }
});

test('legacy three-language native name keys stay untouched in every dictionary', () => {
  const legacy = {'zh-CN': 'zh', ja: 'ja', en: 'en'};
  for (const entry of LOCALE_REGISTRY) {
    const file = join(root, 'src/web/i18n', `${entry.code}.json`);
    const dictionary = JSON.parse(readFileSync(file, 'utf8'));
    for (const [code, key] of Object.entries(legacy)) {
      const expected = LOCALE_REGISTRY.find((candidate) => candidate.code === code).nativeName;
      assert.equal(dictionary.settings.language[key], expected, `${file} settings.language.${key}`);
    }
    // The ten-language product names languages from the registry only, so no
    // dictionary key was added for the seven new languages.
    assert.equal(Object.keys(dictionary.settings.language).length, 10, `${file} settings.language key count`);
  }
});

test('selector metadata keeps registry order and native names', () => {
  const descriptors = localeDescriptors(AVAILABLE_LOCALES);
  assert.deepEqual(descriptors.map((entry) => entry.code), [...AVAILABLE_LOCALES]);
  assert.deepEqual(
    descriptors.map((entry) => entry.nativeName),
    ['简体中文', '日本語', 'English', '한국어', 'Español', 'Português (Brasil)', '繁體中文', 'Français', 'Deutsch', 'Bahasa Indonesia']
  );
});

test('AI and memory output languages are the aiOutput subset only', () => {
  assert.deepEqual([...AI_OUTPUT_LOCALES], ['zh-CN', 'ja', 'en']);
  assert.deepEqual([...SUPPORTED_LOCALES], [...AI_OUTPUT_LOCALES]);
  assert.deepEqual([...SUPPORTED_MEMORY_LOCALES], [...AI_OUTPUT_LOCALES]);
  for (const code of ['ko', 'es', 'pt-BR', 'zh-TW', 'fr', 'de', 'id']) {
    assert.equal(AI_OUTPUT_LOCALES.includes(code), false, `${code} must not be an AI output language yet`);
  }
});

test('every AI output language has prompts, a versioned name and a translation label', () => {
  for (const code of AI_OUTPUT_LOCALES) {
    assert.match(promptVersionFor(code), new RegExp(`-${code}$`), code);
    assert.match(memoryPromptVersionFor(code), new RegExp(`-${code}$`), code);
    const instructions = buildInstructions(code, {schemaVersion: '1.3.0'});
    assert.ok(instructions.length > 500, `${code} instructions too short`);
    assert.ok(LOCALE_NAME[code], `${code} translation label`);
  }
  // The three prompt languages are genuinely different, not English copies.
  assert.notEqual(buildInstructions('ja'), buildInstructions('en'));
  assert.notEqual(buildInstructions('zh-CN'), buildInstructions('en'));
  // An interface-only language degrades instead of inventing a prompt locale.
  assert.match(promptVersionFor('ko'), /-en$/);
  assert.match(memoryPromptVersionFor('de'), /-en$/);
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

test('the AI result schemas mirror the AI output registry instead of drifting', () => {
  for (const file of [
    'src/ai/schemas/analysis-result-v1.schema.json',
    'src/memory/schemas/memory-update-result-v1.schema.json'
  ]) {
    const schema = JSON.parse(readFileSync(join(root, file), 'utf8'));
    assert.deepEqual(schema.properties.locale.enum, [...AI_OUTPUT_LOCALES], file);
  }
});

test('the launcher console uses the same language codes as the interface', () => {
  assert.deepEqual([...CLI_LOCALES], [...AVAILABLE_LOCALES]);
});

test('registry resolution never returns a code outside the registry', () => {
  for (const code of TEN_CODES) {
    assert.equal(localeDescriptor(code)?.code, code);
  }
  assert.equal(localeDescriptor('th-TH'), null);
});
