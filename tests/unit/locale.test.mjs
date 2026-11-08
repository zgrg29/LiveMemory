import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectSystemLocale,
  mapSystemLocale,
  normalizeLocale,
  normalizeLocalePreference,
  resolveLocale
} from '../../src/shared/locale.mjs';

test('normalizeLocale accepts supported locales and aliases', () => {
  assert.equal(normalizeLocale('zh-CN'), 'zh-CN');
  assert.equal(normalizeLocale('zh_CN'), 'zh-CN');
  assert.equal(normalizeLocale('zh-Hans'), 'zh-CN');
  assert.equal(normalizeLocale('zh'), 'zh-CN');
  assert.equal(normalizeLocale('ja-JP'), 'ja');
  assert.equal(normalizeLocale('ja'), 'ja');
  assert.equal(normalizeLocale('en-US'), 'en');
  assert.equal(normalizeLocale('system'), 'system');
  assert.equal(normalizeLocale('fr-FR'), null);
  assert.equal(normalizeLocale(''), null);
  assert.equal(normalizeLocale(null), null);
});

test('unsupported preferences fall back to "system" without corrupting valid ones', () => {
  assert.equal(normalizeLocalePreference('ko-KR'), 'system');
  assert.equal(normalizeLocalePreference('ja'), 'ja');
  assert.equal(normalizeLocalePreference(undefined), 'system');
});

test('resolveLocale honours an explicit preference over the system locale', () => {
  assert.equal(resolveLocale('ja', 'zh-CN'), 'ja');
  assert.equal(resolveLocale('en', 'ja-JP'), 'en');
  assert.equal(resolveLocale('zh-CN', 'en-US'), 'zh-CN');
});

test('resolveLocale follows the system locale and falls back to English', () => {
  assert.equal(resolveLocale('system', 'zh-CN'), 'zh-CN');
  assert.equal(resolveLocale('system', 'ja-JP'), 'ja');
  assert.equal(resolveLocale('system', 'en-GB'), 'en');
  assert.equal(resolveLocale('system', 'de-DE'), 'en');
  assert.equal(resolveLocale('system', 'ko-KR'), 'en');
});

test('mapSystemLocale never returns a value outside the supported set', () => {
  assert.equal(mapSystemLocale('zh-TW'), 'zh-CN');
  assert.equal(mapSystemLocale('pt-BR'), 'en');
});

test('detectSystemLocale prefers environment hints and always returns a supported locale', () => {
  assert.equal(detectSystemLocale({LC_ALL: 'ja_JP.UTF-8'}), 'ja');
  assert.equal(detectSystemLocale({LANG: 'zh_CN.UTF-8'}), 'zh-CN');
  assert.equal(detectSystemLocale({LC_ALL: 'fr_FR.UTF-8'}), 'en');
  assert.ok(['zh-CN', 'ja', 'en'].includes(detectSystemLocale({})));
});
