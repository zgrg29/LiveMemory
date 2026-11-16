import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_OUTPUT_LOCALES,
  AVAILABLE_LOCALES,
  aiOutputLocale,
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
  // P40 added seven languages; their regional variants resolve onto them.
  assert.equal(normalizeLocale('ko-KR'), 'ko');
  assert.equal(normalizeLocale('fr-FR'), 'fr');
  assert.equal(normalizeLocale('de-AT'), 'de');
  assert.equal(normalizeLocale('es-MX'), 'es');
  assert.equal(normalizeLocale('pt-PT'), 'pt-BR');
  assert.equal(normalizeLocale('zh-HK'), 'zh-TW');
  assert.equal(normalizeLocale('id-ID'), 'id');
  // Still unknown languages stay unknown instead of being guessed.
  assert.equal(normalizeLocale('th-TH'), null);
  assert.equal(normalizeLocale(''), null);
  assert.equal(normalizeLocale(null), null);
});

test('unsupported preferences fall back to "system" without corrupting valid ones', () => {
  assert.equal(normalizeLocalePreference('th-TH'), 'system');
  assert.equal(normalizeLocalePreference('ja'), 'ja');
  assert.equal(normalizeLocalePreference('ko'), 'ko');
  assert.equal(normalizeLocalePreference(undefined), 'system');
});

test('resolveLocale honours an explicit preference over the system locale', () => {
  assert.equal(resolveLocale('ja', 'zh-CN'), 'ja');
  assert.equal(resolveLocale('en', 'ja-JP'), 'en');
  assert.equal(resolveLocale('zh-CN', 'en-US'), 'zh-CN');
  assert.equal(resolveLocale('de', 'fr-FR'), 'de');
});

test('resolveLocale follows the system locale for every shipped language', () => {
  assert.equal(resolveLocale('system', 'zh-CN'), 'zh-CN');
  assert.equal(resolveLocale('system', 'ja-JP'), 'ja');
  assert.equal(resolveLocale('system', 'en-GB'), 'en');
  assert.equal(resolveLocale('system', 'de-DE'), 'de');
  assert.equal(resolveLocale('system', 'ko-KR'), 'ko');
  assert.equal(resolveLocale('system', 'fr-CA'), 'fr');
  assert.equal(resolveLocale('system', 'es-419'), 'es');
  assert.equal(resolveLocale('system', 'pt-PT'), 'pt-BR');
  assert.equal(resolveLocale('system', 'zh-HK'), 'zh-TW');
  assert.equal(resolveLocale('system', 'id-ID'), 'id');
  // A language the product does not ship still degrades to the default.
  assert.equal(resolveLocale('system', 'th-TH'), 'en');
});

test('mapSystemLocale never returns a value outside the supported set', () => {
  assert.equal(mapSystemLocale('zh-TW'), 'zh-TW');
  assert.equal(mapSystemLocale('pt-BR'), 'pt-BR');
  assert.equal(mapSystemLocale('pt-PT'), 'pt-BR');
  assert.equal(mapSystemLocale('th-TH'), 'en');
  for (const code of TEN_LOCALES) {
    assert.ok(AVAILABLE_LOCALES.includes(mapSystemLocale(code)), code);
  }
});

test('detectSystemLocale prefers environment hints and always returns a supported locale', () => {
  assert.equal(detectSystemLocale({LC_ALL: 'ja_JP.UTF-8'}), 'ja');
  assert.equal(detectSystemLocale({LANG: 'zh_CN.UTF-8'}), 'zh-CN');
  assert.equal(detectSystemLocale({LC_ALL: 'fr_FR.UTF-8'}), 'fr');
  assert.equal(detectSystemLocale({LC_ALL: 'de_DE.UTF-8'}), 'de');
  assert.equal(detectSystemLocale({LC_ALL: 'ko_KR.UTF-8'}), 'ko');
  assert.equal(detectSystemLocale({LC_ALL: 'pt_PT.UTF-8'}), 'pt-BR');
  assert.equal(detectSystemLocale({LC_ALL: 'zh_HK.UTF-8'}), 'zh-TW');
  assert.equal(detectSystemLocale({LC_ALL: 'th_TH.UTF-8'}), 'en');
  assert.ok(AVAILABLE_LOCALES.includes(detectSystemLocale({})));
});

test('every Traditional Chinese variant prefers the installed zh-TW resource', () => {
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

test('language families degrade by family, not by a hardcoded list', () => {
  assert.equal(resolveLocaleTag('pt-PT', {available: ['en', 'pt-BR']}), 'pt-BR');
  assert.equal(resolveLocaleTag('pt', {available: ['en', 'pt-BR']}), 'pt-BR');
  assert.equal(resolveLocaleTag('in-ID', {available: ['en', 'id']}), 'id');
  assert.equal(resolveLocaleTag('es-MX', {available: ['en', 'es']}), 'es');
  assert.equal(resolveLocaleTag('de-AT', {available: ['en', 'de']}), 'de');
  assert.equal(resolveLocaleTag('ko-KR', {available: ['en', 'ko']}), 'ko');
  // The shipped ten-language environment resolves every code to itself.
  for (const code of TEN_LOCALES) {
    assert.equal(resolveLocaleTag(code, {available: TEN_LOCALES}), code);
  }
});

test('unknown languages and unknown regions fall back to the default', () => {
  assert.equal(resolveLocaleTag('th-TH', {available: TEN_LOCALES}), null);
  assert.equal(resolveLocaleTag('fr-FR', {available: ['zh-CN', 'ja', 'en']}), null);
  assert.equal(resolveLocale('system', 'th-TH'), 'en');
  // Missing default resource: the first installed language is used, never null.
  assert.equal(resolveLocale('en', 'de-DE', {available: ['ja']}), 'ja');
  assert.equal(resolveLocale('system', 'zh-HK', {available: []}), 'en');
});

test('user preference is preserved while the effective language degrades', () => {
  // The stored preference may name a declared language whose dictionary is
  // temporarily unavailable; resolution degrades, validation does not rewrite.
  assert.equal(normalizeLocalePreference('zh-TW'), 'zh-TW');
  assert.equal(resolveLocale('zh-TW', 'zh-CN', {available: ['zh-CN', 'ja', 'en']}), 'zh-CN');
  assert.equal(resolveLocale('zh-TW', 'zh-CN', {available: WITH_ZH_TW}), 'zh-TW');
});

test('system detection can resolve against an installed subset', () => {
  assert.equal(detectSystemLocale({LC_ALL: 'zh_HK.UTF-8'}, {available: WITH_ZH_TW}), 'zh-TW');
  assert.equal(detectSystemLocale({LC_ALL: 'zh_HK.UTF-8'}, {available: ['zh-CN']}), 'zh-CN');
  assert.equal(detectSystemLocale({LC_ALL: 'pt_BR.UTF-8'}, {available: ['en', 'pt-BR']}), 'pt-BR');
  assert.equal(detectSystemLocale({LC_ALL: 'de_DE.UTF-8'}, {available: ['zh-CN', 'ja', 'en']}), 'en');
});

test('AI output languages are a capability subset of the interface languages', () => {
  assert.deepEqual([...AI_OUTPUT_LOCALES], ['zh-CN', 'ja', 'en']);
  for (const code of AI_OUTPUT_LOCALES) assert.ok(AVAILABLE_LOCALES.includes(code), code);
  // Ten interface languages must not become ten analysis languages in P40.
  assert.ok(AVAILABLE_LOCALES.length === 10);
  assert.ok(AI_OUTPUT_LOCALES.length < AVAILABLE_LOCALES.length);
});

test('aiOutputLocale never lets an unsupported language reach a provider', () => {
  assert.equal(aiOutputLocale('en'), 'en');
  assert.equal(aiOutputLocale('ja'), 'ja');
  assert.equal(aiOutputLocale('zh-CN'), 'zh-CN');
  // Closest supported family member first, then the default language.
  assert.equal(aiOutputLocale('zh-TW'), 'zh-CN');
  assert.equal(aiOutputLocale('zh-HK'), 'zh-CN');
  assert.equal(aiOutputLocale('ko'), 'en');
  assert.equal(aiOutputLocale('de'), 'en');
  assert.equal(aiOutputLocale('pt-BR'), 'en');
  assert.equal(aiOutputLocale('es-MX'), 'en');
  assert.equal(aiOutputLocale('th-TH'), 'en');
  assert.equal(aiOutputLocale(null), 'en');
  assert.equal(aiOutputLocale(''), 'en');
});
