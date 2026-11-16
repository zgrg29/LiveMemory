import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {AVAILABLE_LOCALES} from '../../src/shared/locales.mjs';

/**
 * Static checks for the AI output language settings UI (P41).
 *
 * The behaviour is covered by `tests/integration/ai-i18n-locales.test.mjs`; this
 * file guards the two things a refactor silently breaks: a literal translation
 * key that is missing from some dictionary, and the UI accidentally coupling the
 * AI output language back to the interface language.
 */

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

function flatten(object, prefix = '', out = new Map()) {
  for (const [key, value] of Object.entries(object)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, path, out);
    else out.set(path, value);
  }
  return out;
}

const dictionaries = new Map(AVAILABLE_LOCALES.map((locale) => [
  locale,
  flatten(JSON.parse(read(`src/web/i18n/${locale}.json`)))
]));
const english = dictionaries.get('en');

function literalKeys(source) {
  return [...source.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)].map((match) => match[1]);
}

test('every AI output settings string exists in all ten dictionaries', () => {
  const source = read('src/web/js/pages/settings.js');
  const keys = literalKeys(source).filter((key) => key.startsWith('settings.aiOutput.'));
  assert.ok(keys.length >= 4, `expected the AI output card keys, got ${JSON.stringify(keys)}`);
  for (const key of new Set(keys)) {
    assert.ok(english.has(key), `en is missing ${key}`);
    for (const locale of AVAILABLE_LOCALES) {
      assert.ok(dictionaries.get(locale).has(key), `${locale} is missing ${key}`);
    }
  }
  // The placeholder must be identical everywhere, otherwise the effective-language
  // sentence would render a raw {locale} in some languages.
  for (const locale of AVAILABLE_LOCALES) {
    assert.match(dictionaries.get(locale).get('settings.aiOutput.effective'), /\{locale\}/, locale);
  }
  assert.ok(english.has('toast.aiOutputLanguage'));
});

test('the settings page writes the AI output preference through the API', () => {
  const settings = read('src/web/js/pages/settings.js');
  assert.match(settings, /settings\.aiOutput\.title/);
  assert.match(settings, /ctx\.setAiOutputLocale/);
  assert.match(settings, /AI_OUTPUT_FOLLOW_UI = 'follow-ui'/);
  // A native select, not a growing segmented control (eleven options).
  assert.match(settings, /el\('select', \{\s*className: 'select'/);
  // No raw HTML injection for user/platform text in this page.
  assert.doesNotMatch(settings, /\.innerHTML\s*=/);
});

test('the shell keeps the AI output language independent of the interface language', () => {
  const app = read('src/web/js/app.js');
  // Separate state, a separate setter and a separate PATCH body.
  assert.match(app, /aiOutputPreference: 'follow-ui'/);
  assert.match(app, /aiOutputLocale: DEFAULT_LOCALE/);
  assert.match(app, /get aiOutputLocale\(\)/);
  assert.match(app, /api\.patch\('\/api\/settings', \{aiOutputLocale: preference\}\)/);
  // Changing the interface language must not send aiOutputLocale.
  const setLocale = /async function setLocale\(preference\) \{([\s\S]*?)\n\}/.exec(app);
  assert.ok(setLocale, 'setLocale exists');
  assert.doesNotMatch(setLocale[1], /aiOutputLocale:/);
  assert.match(setLocale[1], /state\.aiOutputLocale = payload\.effective\?\.aiOutputLocale/);
});

test('the AI centre defaults to the AI output preference, not the UI language', () => {
  const page = read('src/web/js/pages/ai.js');
  assert.match(page, /let locale = outputLocales\.some\(\(entry\) => entry\.code === ctx\.aiOutputLocale\)/);
  assert.doesNotMatch(page, /let locale = ctx\.locale;/);
  // The per-task language is still sent explicitly with the run request, and the
  // saved task language is shown read-only.
  assert.match(page, /api\.post\('\/api\/ai\/analyze\/run', \{\s*\n\s*sessionId: selectedId,\s*\n\s*locale,/);
  assert.match(page, /ai\.center\.taskLocale/);
});

test('the report reading language stays a separate, per-view choice', () => {
  const report = read('src/web/js/pages/ai-report.js');
  assert.match(report, /Reading\/translation targets are the/);
  assert.match(report, /aiOutput/);
  assert.match(report, /onLocaleChange/);
  // Reading a translated report never writes the task or the original result.
  assert.doesNotMatch(report, /\/api\/ai\/analyze\/run/);
});
