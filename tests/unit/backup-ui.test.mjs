import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();
const settingsJs = readFileSync(join(ROOT, 'src/web/js/pages/settings.js'), 'utf8');
const backupJs = readFileSync(join(ROOT, 'src/web/js/pages/settings-backup.js'), 'utf8');
const pagesCss = readFileSync(join(ROOT, 'src/web/styles/pages.css'), 'utf8');

function dictionary(locale) {
  return JSON.parse(readFileSync(join(ROOT, `src/web/i18n/${locale}.json`), 'utf8'));
}

function readKey(dictionaryObject, key) {
  return key.split('.').reduce((value, part) => value?.[part], dictionaryObject);
}

test('settings renders a real backup card backed by authenticated endpoints', () => {
  assert.match(settingsJs, /renderBackupCard/);
  assert.match(settingsJs, /\/api\/backup\/status/);
  assert.match(backupJs, /\/api\/backup\/pick\/save/);
  assert.match(backupJs, /\/api\/backup\/pick\/open/);
  assert.match(backupJs, /\/api\/backup\/inspect/);
  assert.match(backupJs, /\/api\/backup\/create/);
  assert.match(backupJs, /\/api\/backup\/restore/);
  assert.match(backupJs, /\/api\/backup\/jobs\//);
  assert.match(backupJs, /confirmText: 'RESTORE'/);
  assert.match(backupJs, /credentialsExcluded/);
  assert.match(backupJs, /requiresReconnect/);
  assert.match(pagesCss, /\.backup-progress/);
  assert.match(pagesCss, /\.backup-progress-fill/);
});

test('the restore preview lists what is restored, what is replaced and what must be reconnected', () => {
  for (const key of [
    'settings.backup.created',
    'settings.backup.schema',
    'settings.backup.fileSize',
    'settings.backup.sessions',
    'settings.backup.viewers',
    'settings.backup.events',
    'settings.backup.aiReports',
    'settings.backup.memoryFacts',
    'settings.backup.includesMemory',
    'settings.backup.includesReports',
    'settings.backup.credentialsIncluded',
    'settings.backup.replacesTitle',
    'settings.backup.replacesBody',
    'settings.backup.reconnectTitle',
    'settings.backup.reconnectBilibili',
    'settings.backup.reconnectYoutube',
    'settings.backup.reconnectAi',
    'settings.backup.safeSnapshot',
    'settings.backup.confirmTitle'
  ]) {
    assert.match(backupJs, new RegExp(key.replace(/\./g, '\\.')), key);
  }
  assert.match(backupJs, /formatDateTime\(backup\.createdAtMs/);
  assert.match(backupJs, /formatBytes\(backup\.archiveBytes/);
  assert.match(backupJs, /job\.percent/);
  assert.match(backupJs, /phaseLabel/);
});

test('all three locales translate the backup UI and preserve placeholders', () => {
  const locales = ['zh-CN', 'ja', 'en'];
  const dictionaries = Object.fromEntries(locales.map((locale) => [locale, dictionary(locale)]));
  const keys = [
    'title', 'desc', 'create', 'choose', 'openFolder', 'verify', 'verified', 'restore',
    'currentTitle', 'currentCounts', 'fileTitle', 'created', 'appVersion', 'schema',
    'fileSize', 'sessions', 'viewers', 'events', 'aiReports', 'memoryFacts',
    'includesMemory', 'includesReports', 'yes', 'no', 'credentialsIncluded',
    'credentialsExcluded', 'replacesTitle', 'replacesBody', 'reconnectTitle',
    'reconnectBody', 'reconnectBilibili', 'reconnectYoutube', 'reconnectAi',
    'confirmTitle', 'confirmBody', 'confirmWord', 'confirmHint', 'progressTitle',
    'successTitle', 'restoreSuccessTitle', 'restoreSuccessBody', 'restoreReload',
    'failedTitle', 'cancelled', 'overwriteTitle', 'overwriteBody', 'overwriteConfirm',
    'safeSnapshot', 'settingsRestored', 'schemaUpgrade', 'credentialsNotice',
    'advancedPath', 'advancedHint', 'filePath', 'settingsMissing', 'rolledBack'
  ];
  for (const key of keys) {
    const values = locales.map((locale) => readKey(dictionaries[locale], `settings.backup.${key}`));
    for (const value of values) {
      assert.equal(typeof value, 'string', `settings.backup.${key} missing`);
      assert.ok(value.trim().length > 0, `settings.backup.${key} empty`);
    }
    assert.equal(new Set(values).size, 3, `settings.backup.${key} must be localized`);
  }
  for (const phase of ['queued', 'validate', 'snapshot', 'checksums', 'write', 'verify', 'commit',
    'safety-snapshot', 'stopping', 'swap', 'reload', 'done']) {
    const values = locales.map((locale) => readKey(dictionaries[locale], `settings.backup.phase.${phase}`));
    for (const value of values) assert.ok(typeof value === 'string' && value.trim().length > 0, phase);
    assert.equal(new Set(values).size, 3, `phase ${phase} must be localized`);
  }
  const countValues = locales.map((locale) => readKey(dictionaries[locale], 'settings.backup.currentCounts'));
  for (const value of countValues) assert.match(value, /\{sessions\}.*\{viewers\}.*\{events\}/);
  assert.equal(dictionaries['zh-CN'].settings.backup.restore, '恢复此备份');
  assert.match(dictionaries['zh-CN'].settings.backup.warningBody, /API Key/);
});

test('every backup/restore error code used by the server has a translated message', () => {
  const locales = ['zh-CN', 'ja', 'en'];
  const codes = [
    'backupPathInvalid', 'backupTargetExists', 'backupFileNotFound', 'backupNoSpace',
    'backupCancelled', 'backupFailed', 'backupInvalidArchive', 'backupTooLarge',
    'backupTooManyEntries', 'backupChecksumMismatch', 'backupManifestInvalid',
    'backupFormatInvalid', 'backupFormatUnsupported', 'backupSchemaUnsupported',
    'backupCredentialsPresent', 'backupEncryptionUnsupported', 'backupSettingsInvalid',
    'backupUnexpectedEntry', 'backupManifestMissing', 'backupDatabaseMissing',
    'backupSettingsMissing', 'backupMissingFile', 'backupSizeMismatch',
    'backupSchemaMismatch', 'backupSourceChanged', 'backupBusy', 'backupJobNotFound',
    'restoreConfirmRequired', 'restoreSnapshotFailed', 'restoreVerifyFailed',
    'restoreRecoveryFailed', 'restoreNoSpace', 'restoreFailed'
  ];
  for (const locale of locales) {
    const dictionaryObject = dictionary(locale);
    for (const code of codes) {
      const value = dictionaryObject.errors[code];
      assert.equal(typeof value, 'string', `${locale}.errors.${code} missing`);
      assert.ok(value.trim().length > 0, `${locale}.errors.${code} empty`);
    }
  }
  assert.match(dictionary('zh-CN').errors.restoreConfirmRequired, /RESTORE/);
  assert.match(dictionary('en').errors.backupFormatUnsupported, /newer/i);
  assert.match(dictionary('ja').errors.backupChecksumMismatch, /チェックサム/);
});

test('the backup UI never uses innerHTML or alert()', () => {
  assert.doesNotMatch(backupJs, /\.innerHTML\s*=/);
  assert.doesNotMatch(backupJs, /\balert\s*\(/);
  assert.doesNotMatch(backupJs, /document\.write/);
});
