import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {localeDisplayName} from '../../src/web/js/i18n.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const LOCALES = ['zh-CN', 'ja', 'en'];

async function dictionary(locale) {
  return JSON.parse(await readFile(join(root, 'src/web/i18n', `${locale}.json`), 'utf8'));
}

test('language names are always rendered in their own language', () => {
  assert.equal(localeDisplayName('zh-CN'), '简体中文');
  assert.equal(localeDisplayName('ja'), '日本語');
  assert.equal(localeDisplayName('en'), 'English');
  // Unknown values fall back to the English native name rather than to a
  // translated string from the current interface language.
  assert.equal(localeDisplayName('de'), 'English');
});

test('the header contains both language controls next to the theme control', async () => {
  const html = await readFile(join(root, 'src/web/index.html'), 'utf8');
  assert.match(html, /id="language-segmented"/);
  assert.match(html, /id="language-select"/);
  assert.match(html, /id="language-system"/);
  assert.match(html, /id="theme-toggle"/);
  assert.match(html, /data-i18n="a11y\.languageSelect"/);
  // The header must not hardcode one translated option list; labels are built
  // from localeDisplayName() in app.js so all three native names stay visible.
  assert.doesNotMatch(html, /<option[^>]*>简体中文/);
  assert.match(await readFile(join(root, 'src/web/js/app.js'), 'utf8'), /localeDisplayName\(value\)/);
});

test('language and data-management interface keys exist in all three languages', async () => {
  for (const locale of LOCALES) {
    const dict = await dictionary(locale);
    assert.ok(dict.a11y.languageSelect);
    assert.ok(dict.a11y.languageSystem);
    assert.ok(dict.settings.language.headerHint);
    assert.ok(dict.settings.locationDialog?.title);
    assert.ok(dict.settings.danger?.clearTitle);
    assert.ok(dict.errors.relocationVerifyFailed);
    assert.ok(dict.errors.confirmTextMismatch);
    // The three language names are stored natively in every dictionary.
    assert.equal(dict.settings.language.zh, '简体中文');
    assert.equal(dict.settings.language.ja, '日本語');
    assert.equal(dict.settings.language.en, 'English');
  }
});
