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
