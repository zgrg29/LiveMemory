import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {DEFAULT_SETTINGS, normalizeSettings, SettingsStore} from '../../src/server/settings-store.mjs';
import {AVAILABLE_LOCALES} from '../../src/shared/locale.mjs';

test('default settings follow the system for language and theme', () => {
  assert.equal(DEFAULT_SETTINGS.locale, 'system');
  assert.equal(DEFAULT_SETTINGS.theme, 'system');
  assert.equal(DEFAULT_SETTINGS.storageMode, 'compact');
  assert.equal(Object.hasOwn(DEFAULT_SETTINGS, 'youtubeCaptureMode'), false);
  assert.equal(normalizeSettings({}).locale, 'system');
  // P40: `fr` is a shipped language now; an unknown one still falls back.
  assert.equal(normalizeSettings({locale: 'fr'}).locale, 'fr');
  assert.equal(normalizeSettings({locale: 'th-TH'}).locale, 'system');
  assert.equal(normalizeSettings({theme: 'neon'}).theme, 'system');
  // A legacy capture-mode value from an older settings file is ignored, not
  // resurrected as a hidden second YouTube mode.
  assert.equal(Object.hasOwn(normalizeSettings({youtubeCaptureMode: 'anonymous'}), 'youtubeCaptureMode'), false);
});

test('loads an existing settings file and keeps valid preferences', () => {
  const temp = createTempDir();
  const file = join(temp.dir, 'settings.json');
  writeFileSync(file, JSON.stringify({locale: 'ja', theme: 'dark', storageMode: 'full', preferredPort: 48100}));
  const store = new SettingsStore({file});
  const settings = store.load();
  assert.equal(settings.locale, 'ja');
  assert.equal(settings.theme, 'dark');
  assert.equal(settings.storageMode, 'full');
  assert.equal(settings.preferredPort, 48100);
  temp.cleanup();
});

test('every existing language preference loads unchanged (backward compatibility)', () => {
  const temp = createTempDir();
  for (const locale of AVAILABLE_LOCALES) {
    const file = join(temp.dir, `settings-${locale}.json`);
    // A settings file written by an older release: only known keys, no new
    // language-related settings. It must load and keep the stored value.
    writeFileSync(file, JSON.stringify({
      version: 1,
      locale,
      theme: 'system',
      storageMode: 'compact',
      preferredPort: 47800,
      onboardingCompleted: true,
      youtubeRawRetentionDays: 30
    }));
    const settings = new SettingsStore({file}).load();
    assert.equal(settings.locale, locale);
    assert.equal(normalizeSettings({locale}).locale, locale);
  }
  temp.cleanup();
});

test('a corrupt settings file falls back to defaults and keeps a copy', () => {
  const temp = createTempDir();
  const file = join(temp.dir, 'settings.json');
  writeFileSync(file, '{not json');
  const store = new SettingsStore({file});
  const settings = store.load();
  assert.equal(settings.locale, 'system');
  const backups = readdirSync(temp.dir).filter((name) => name.includes('.corrupt-'));
  assert.equal(backups.length, 1);
  temp.cleanup();
});

test('updates are persisted atomically and validated', () => {
  const temp = createTempDir();
  const file = join(temp.dir, 'settings.json');
  const store = new SettingsStore({file});
  store.load();
  const updated = store.update({theme: 'dark', locale: 'zh-CN', storageMode: 'full'});
  assert.equal(updated.theme, 'dark');
  assert.equal(updated.locale, 'zh-CN');
  assert.equal(updated.storageMode, 'full');
  assert.ok(updated.updatedAt);

  const persisted = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(persisted.theme, 'dark');
  assert.equal(persisted.locale, 'zh-CN');

  const reloaded = new SettingsStore({file});
  assert.equal(reloaded.load().theme, 'dark');

  assert.throws(() => store.update({theme: 'neon'}), /SETTINGS_INVALID/);
  // Ten languages are accepted; a language the product does not ship is not.
  assert.throws(() => store.update({locale: 'th-TH'}), /SETTINGS_INVALID/);
  assert.throws(() => store.update({storageMode: 'eternal'}), /SETTINGS_INVALID/);
  assert.throws(() => store.update({unknownKey: 1}), /SETTINGS_INVALID/);
  assert.throws(() => store.update({preferredPort: 70000}), /SETTINGS_INVALID/);
  // The removed official/anonymous mode is no longer an accepted setting.
  assert.throws(() => store.update({youtubeCaptureMode: 'anonymous'}), /SETTINGS_INVALID/);
  assert.equal(store.update({locale: 'system'}).locale, 'system');
  temp.cleanup();
});

test('the AI output language is a persisted, independent preference', () => {
  const temp = createTempDir();
  const file = join(temp.dir, 'settings.json');
  const store = new SettingsStore({file});
  store.load();
  // Default is `follow-ui`, not a hard-coded analysis language.
  assert.equal(store.get().aiOutputLocale, 'follow-ui');
  assert.equal(DEFAULT_SETTINGS.aiOutputLocale, 'follow-ui');
  // The interface language and the AI output language are separate keys.
  const both = store.update({locale: 'ja', aiOutputLocale: 'de'});
  assert.equal(both.locale, 'ja');
  assert.equal(both.aiOutputLocale, 'de');
  const persisted = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(persisted.locale, 'ja');
  assert.equal(persisted.aiOutputLocale, 'de');
  // Restart keeps both values.
  const reloaded = new SettingsStore({file}).load();
  assert.equal(reloaded.locale, 'ja');
  assert.equal(reloaded.aiOutputLocale, 'de');
  // Switching the interface language does not touch the AI output language.
  assert.equal(store.update({locale: 'ko'}).aiOutputLocale, 'de');
  // Every AI output language is accepted, region variants normalize, and an
  // unknown or non-language value is rejected instead of silently stored.
  assert.equal(store.update({aiOutputLocale: 'pt-BR'}).aiOutputLocale, 'pt-BR');
  assert.equal(store.update({aiOutputLocale: 'pt-PT'}).aiOutputLocale, 'pt-BR');
  assert.equal(store.update({aiOutputLocale: 'zh-HK'}).aiOutputLocale, 'zh-TW');
  assert.equal(store.update({aiOutputLocale: 'follow-ui'}).aiOutputLocale, 'follow-ui');
  assert.throws(() => store.update({aiOutputLocale: 'th-TH'}), /SETTINGS_INVALID/);
  assert.throws(() => store.update({aiOutputLocale: 'not-a-language'}), /SETTINGS_INVALID/);
  assert.throws(() => store.update({aiOutputLocale: 42}), /SETTINGS_INVALID/);
  temp.cleanup();
});

test('a pre-P41 settings file without aiOutputLocale loads as follow-ui', () => {
  const temp = createTempDir();
  const file = join(temp.dir, 'settings.json');
  // Exactly what a P40 install has on disk: no aiOutputLocale key at all.
  writeFileSync(file, JSON.stringify({
    version: 1,
    locale: 'ko',
    theme: 'dark',
    storageMode: 'compact',
    preferredPort: 47800,
    onboardingCompleted: true,
    youtubeRawRetentionDays: 30,
    updatedAt: '2026-11-16T00:00:00.000Z'
  }));
  const settings = new SettingsStore({file}).load();
  assert.equal(settings.locale, 'ko');
  assert.equal(settings.aiOutputLocale, 'follow-ui');
  // Loading does not rewrite the file (no silent migration of the value).
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(Object.hasOwn(raw, 'aiOutputLocale'), false);
  // A corrupt AI output value in an old file degrades instead of blocking boot.
  assert.equal(normalizeSettings({aiOutputLocale: 'klingon'}).aiOutputLocale, 'follow-ui');
  temp.cleanup();
});
