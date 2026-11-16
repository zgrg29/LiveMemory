import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectSystemLocale,
  mapSystemLocale,
  normalizeLocale,
  normalizeLocalePreference,
  resolveLocale,
  resolveLocaleTag
} from '../../src/shared/locale.mjs';

const WITH_ZH_TW = ['zh-CN', 'zh-TW', 'ja', 'en'];
const TEN_LOCALES = ['zh-CN', 'ja', 'en', 'ko', 'es', 'pt-BR', 'zh-TW', 'fr', 'de', 'id'];

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

test('a zh-TW dictionary, once installed, wins for every Traditional Chinese variant', () => {
  for (const tag of ['zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant', 'zh-Hant-HK']) {
    assert.equal(resolveLocaleTag(tag, {available: WITH_ZH_TW}), 'zh-TW', tag);
  }
  // Simplified variants keep the Simplified resource.
  for (const tag of ['zh', 'zh-CN', 'zh-SG', 'zh-MY', 'zh-Hans', 'zh-Hans-CN']) {
    assert.equal(resolveLocaleTag(tag, {available: WITH_ZH_TW}), 'zh-CN', tag);
  }
  // Without the Traditional dictionary the same environment degrades safely.
  assert.equal(resolveLocaleTag('zh-HK', {available: ['zh-CN', 'ja', 'en']}), 'zh-CN');
  assert.equal(resolveLocaleTag('zh-Hant', {available: ['zh-CN', 'ja', 'en']}), 'zh-CN');
});

test('region-only variants prefer the matching script and region', () => {
  assert.equal(resolveLocaleTag('zh-SG', {available: WITH_ZH_TW}), 'zh-CN');
  assert.equal(resolveLocaleTag('zh-HK', {available: WITH_ZH_TW}), 'zh-TW');
  assert.equal(resolveLocaleTag('zh-MO', {available: WITH_ZH_TW}), 'zh-TW');
});

test('future language families degrade by family, not by a hardcoded three-language map', () => {
  assert.equal(resolveLocaleTag('pt-PT', {available: ['en', 'pt-BR']}), 'pt-BR');
  assert.equal(resolveLocaleTag('pt', {available: ['en', 'pt-BR']}), 'pt-BR');
  assert.equal(resolveLocaleTag('in-ID', {available: ['en', 'id']}), 'id');
  assert.equal(resolveLocaleTag('es-MX', {available: ['en', 'es']}), 'es');
  assert.equal(resolveLocaleTag('de-AT', {available: ['en', 'de']}), 'de');
  assert.equal(resolveLocaleTag('ko-KR', {available: ['en', 'ko']}), 'ko');
  // A full ten-language environment resolves every planned code.
  for (const code of TEN_LOCALES) {
    assert.equal(resolveLocaleTag(code, {available: TEN_LOCALES}), code);
  }
});

test('unknown languages and unknown regions fall back to the default', () => {
  assert.equal(resolveLocaleTag('fr-FR', {available: ['zh-CN', 'ja', 'en']}), null);
  assert.equal(resolveLocale('system', 'fr-FR'), 'en');
  // Missing default resource: the first installed language is used, never null.
  assert.equal(resolveLocale('en', 'de-DE', {available: ['ja']}), 'ja');
  assert.equal(resolveLocale('system', 'zh-HK', {available: []}), 'en');
});

test('user preference is preserved while the effective language degrades', () => {
  // The stored preference may name a declared language whose dictionary is
  // temporarily unavailable; resolution degrades, validation does not rewrite.
  assert.equal(normalizeLocalePreference('zh-TW'), 'zh-CN');
  assert.equal(resolveLocale('zh-TW', 'zh-CN', {available: ['zh-CN', 'ja', 'en']}), 'zh-CN');
  assert.equal(resolveLocale('zh-TW', 'zh-CN', {available: WITH_ZH_TW}), 'zh-TW');
});

test('system detection can resolve against an installed subset', () => {
  assert.equal(detectSystemLocale({LC_ALL: 'zh_HK.UTF-8'}, {available: WITH_ZH_TW}), 'zh-TW');
  assert.equal(detectSystemLocale({LC_ALL: 'zh_HK.UTF-8'}, {available: ['zh-CN']}), 'zh-CN');
  assert.equal(detectSystemLocale({LC_ALL: 'pt_BR.UTF-8'}, {available: ['en', 'pt-BR']}), 'pt-BR');
  assert.equal(detectSystemLocale({LC_ALL: 'de_DE.UTF-8'}, {available: ['zh-CN', 'ja', 'en']}), 'en');
});
