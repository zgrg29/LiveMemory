import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {buildZip, dataOffsetOf} from '../helpers/zip-fixture.mjs';
import {openArchive, readEntryBuffer, validateEntryName} from '../../src/server/backup/archive.mjs';
import {validateManifest} from '../../src/server/backup/manifest.mjs';
import {parseBackupSettings, settingsForBackup} from '../../src/server/backup/settings.mjs';
import {normalizeBackupDestination} from '../../src/server/backup/create.mjs';
import {buildFilePickerScript} from '../../src/server/native-dialog.mjs';
import {BACKUP_LIMITS} from '../../src/server/backup/constants.mjs';

const SHA = 'a'.repeat(64);

function manifest(overrides = {}) {
  return {
    format: 'livememory-backup',
    format_version: 1,
    app_version: '0.13.2',
    schema_version: 16,
    created_at: '2026-11-14T05:00:00.000Z',
    platform: 'win32',
    contains_credentials: false,
    encryption: null,
    counts: {sessions: 1, viewers: 2},
    files: [{name: 'database/livememory.db', bytes: 3, sha256: SHA}],
    ...overrides
  };
}

function errorCode(fn) {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  return null;
}

test('the backup reader accepts only regular stored entries with safe names', () => {
  const temp = createTempDir();
  try {
    const file = join(temp.dir, 'valid.zip');
    writeFileSync(file, buildZip([
      {name: 'manifest.json', data: '{}'},
      {name: 'database/livememory.db', data: 'abc'}
    ]));
    const archive = openArchive(file);
    try {
      assert.equal(archive.entries.length, 2);
      assert.equal(readEntryBuffer(archive, archive.entry('database/livememory.db')).toString('utf8'), 'abc');
    } finally {
      archive.close();
    }
  } finally {
    temp.cleanup();
  }
});

test('ZIP Slip, absolute paths, drive letters, duplicate names and directory entries are rejected', () => {
  const temp = createTempDir();
  try {
    const cases = [
      '../evil.db',
      'database/../../evil.db',
      '/absolute.db',
      'C:/windows/evil.db',
      'database\\evil.db',
      'folder/',
      'a//b.db'
    ];
    for (const name of cases) {
      const file = join(temp.dir, `bad-${Buffer.from(name).toString('hex')}.zip`);
      writeFileSync(file, buildZip([{name, data: 'x'}]));
      assert.equal(errorCode(() => openArchive(file)), 'BACKUP_INVALID_ARCHIVE', name);
    }
    const duplicate = join(temp.dir, 'duplicate.zip');
    writeFileSync(duplicate, buildZip([
      {name: 'manifest.json', data: 'a'},
      {name: 'manifest.json', data: 'b'}
    ]));
    assert.equal(errorCode(() => openArchive(duplicate)), 'BACKUP_INVALID_ARCHIVE');
    assert.throws(() => validateEntryName('a\0b'), /BACKUP_INVALID_ARCHIVE/);
  } finally {
    temp.cleanup();
  }
});

test('symlinks, compressed entries and data descriptors are rejected', () => {
  const temp = createTempDir();
  try {
    const symlink = join(temp.dir, 'symlink.zip');
    writeFileSync(symlink, buildZip([
      {name: 'database/livememory.db', data: 'x', externalAttributes: 0xa1ff0000}
    ]));
    assert.equal(errorCode(() => openArchive(symlink)), 'BACKUP_INVALID_ARCHIVE');

    const compressed = join(temp.dir, 'compressed.zip');
    writeFileSync(compressed, buildZip([
      {name: 'database/livememory.db', data: 'x', method: 8}
    ]));
    assert.equal(errorCode(() => openArchive(compressed)), 'BACKUP_INVALID_ARCHIVE');

    const descriptor = join(temp.dir, 'descriptor.zip');
    writeFileSync(descriptor, buildZip([
      {name: 'database/livememory.db', data: 'x', flags: 0x0808}
    ]));
    assert.equal(errorCode(() => openArchive(descriptor)), 'BACKUP_INVALID_ARCHIVE');
  } finally {
    temp.cleanup();
  }
});

test('compression bombs, entry-count bombs and oversized archives are bounded', () => {
  const temp = createTempDir();
  try {
    const bomb = join(temp.dir, 'bomb.zip');
    writeFileSync(bomb, buildZip([
      {name: 'database/livememory.db', data: 'x', method: 8, uncompressedSize: 0x7fffffff}
    ]));
    assert.equal(errorCode(() => openArchive(bomb)), 'BACKUP_INVALID_ARCHIVE');

    const many = join(temp.dir, 'many.zip');
    writeFileSync(many, buildZip([
      {name: 'a', data: '1'},
      {name: 'b', data: '2'},
      {name: 'c', data: '3'}
    ]));
    assert.equal(errorCode(() => openArchive(many, {limits: {...BACKUP_LIMITS, maxEntries: 2}})), 'BACKUP_TOO_MANY_ENTRIES');

    const large = join(temp.dir, 'large.zip');
    writeFileSync(large, buildZip([{name: 'a', data: Buffer.alloc(2048)}]));
    assert.equal(errorCode(() => openArchive(large, {limits: {...BACKUP_LIMITS, maxArchiveBytes: 1024}})), 'BACKUP_TOO_LARGE');

    const entryLarge = join(temp.dir, 'entry-large.zip');
    writeFileSync(entryLarge, buildZip([{name: 'a', data: Buffer.alloc(2048)}]));
    assert.equal(errorCode(() => openArchive(entryLarge, {limits: {...BACKUP_LIMITS, maxEntryBytes: 1024}})), 'BACKUP_INVALID_ARCHIVE');

    const total = join(temp.dir, 'total.zip');
    writeFileSync(total, buildZip([
      {name: 'a', data: Buffer.alloc(800)},
      {name: 'b', data: Buffer.alloc(800)}
    ]));
    assert.equal(errorCode(() => openArchive(total, {limits: {...BACKUP_LIMITS, maxTotalUncompressedBytes: 1000}})), 'BACKUP_TOO_LARGE');
  } finally {
    temp.cleanup();
  }
});

test('a modified entry fails the CRC check, and a truncated archive is rejected', () => {
  const temp = createTempDir();
  try {
    const archiveFile = join(temp.dir, 'crc.zip');
    const buffer = buildZip([{name: 'database/livememory.db', data: 'hello world'}]);
    writeFileSync(archiveFile, buffer);
    const archive = openArchive(archiveFile);
    try {
      const offset = dataOffsetOf(buffer, 'database/livememory.db');
      const tampered = Buffer.from(buffer);
      tampered[offset] ^= 0xff;
      writeFileSync(archiveFile, tampered);
      archive.close();
      const second = openArchive(archiveFile);
      try {
        assert.equal(
          errorCode(() => readEntryBuffer(second, second.entry('database/livememory.db'))),
          'BACKUP_CHECKSUM_MISMATCH'
        );
      } finally {
        second.close();
      }
    } finally {
      try { archive.close(); } catch { /* ignore */ }
    }

    const truncated = join(temp.dir, 'truncated.zip');
    writeFileSync(truncated, buffer.subarray(0, buffer.length - 10));
    assert.equal(errorCode(() => openArchive(truncated)), 'BACKUP_INVALID_ARCHIVE');
  } finally {
    temp.cleanup();
  }
});

test('manifest validation rejects forged, future and credential-bearing manifests', () => {
  assert.equal(validateManifest(manifest(), {currentSchemaVersion: 16}).formatVersion, 1);
  assert.equal(errorCode(() => validateManifest(manifest({format: 'other'}), {currentSchemaVersion: 16})), 'BACKUP_FORMAT_INVALID');
  assert.equal(errorCode(() => validateManifest(manifest({format_version: 2}), {currentSchemaVersion: 16})), 'BACKUP_FORMAT_UNSUPPORTED');
  assert.equal(errorCode(() => validateManifest(manifest({schema_version: 99}), {currentSchemaVersion: 16})), 'BACKUP_SCHEMA_UNSUPPORTED');
  assert.equal(errorCode(() => validateManifest(manifest({schema_version: 0}), {currentSchemaVersion: 16})), 'BACKUP_MANIFEST_INVALID');
  assert.equal(errorCode(() => validateManifest(manifest({contains_credentials: true}), {currentSchemaVersion: 16})), 'BACKUP_CREDENTIALS_PRESENT');
  assert.equal(errorCode(() => validateManifest(manifest({contains_credentials: undefined}), {currentSchemaVersion: 16})), 'BACKUP_MANIFEST_INVALID');
  assert.equal(errorCode(() => validateManifest(manifest({encryption: {algorithm: 'aes-256-gcm'}}), {currentSchemaVersion: 16})), 'BACKUP_ENCRYPTION_UNSUPPORTED');
  assert.equal(errorCode(() => validateManifest(manifest({files: []}), {currentSchemaVersion: 16})), 'BACKUP_MANIFEST_INVALID');
  assert.equal(errorCode(() => validateManifest(manifest({files: [{name: 'x', bytes: -1, sha256: SHA}]}), {currentSchemaVersion: 16})), 'BACKUP_MANIFEST_INVALID');
  assert.equal(errorCode(() => validateManifest(manifest({created_at: 'not-a-date'}), {currentSchemaVersion: 16})), 'BACKUP_MANIFEST_INVALID');
});

test('backup settings are sanitised and unknown keys are rejected', () => {
  const sanitised = settingsForBackup({
    locale: 'ja',
    theme: 'dark',
    storageMode: 'full',
    preferredPort: 49999,
    onboardingCompleted: true,
    youtubeRawRetentionDays: 30,
    updatedAt: '2026-01-01T00:00:00.000Z'
  });
  assert.deepEqual(sanitised, {
    version: 1,
    locale: 'ja',
    theme: 'dark',
    storageMode: 'full',
    onboardingCompleted: true,
    youtubeRawRetentionDays: 30
  });
  assert.equal('preferredPort' in sanitised, false);
  assert.equal(parseBackupSettings(Buffer.from(JSON.stringify(sanitised))).locale, 'ja');
  assert.equal(
    errorCode(() => parseBackupSettings(Buffer.from(JSON.stringify({locale: 'en', dataDir: 'C:\\secret'})))),
    'BACKUP_SETTINGS_INVALID'
  );
  assert.equal(errorCode(() => parseBackupSettings(Buffer.from('{not json'))), 'BACKUP_SETTINGS_INVALID');
});

test('backup destinations must be absolute local .livememory files', () => {
  assert.match(normalizeBackupDestination('C:\\Users\\me\\Documents\\a.livememory'), /a\.livememory$/);
  assert.equal(errorCode(() => normalizeBackupDestination('relative.livememory')), 'BACKUP_PATH_INVALID');
  assert.equal(errorCode(() => normalizeBackupDestination('C:\\Users\\me\\a.zip')), 'BACKUP_PATH_INVALID');
  assert.equal(errorCode(() => normalizeBackupDestination('\\\\server\\share\\a.livememory')), 'BACKUP_PATH_INVALID');
  assert.equal(errorCode(() => normalizeBackupDestination('')), 'BACKUP_PATH_INVALID');
});

test('the file picker script keeps user values out of the command text', () => {
  const script = buildFilePickerScript({
    resultFile: 'C:\\临时\\result.txt',
    initialDir: 'D:\\Live Data',
    defaultName: 'LiveMemory-Backup-2026.livememory',
    mode: 'save'
  });
  assert.match(script, /SaveFileDialog/);
  assert.match(script, /DefaultExt="livememory"/);
  assert.match(script, /AddExtension=\$true/);
  assert.doesNotMatch(script, /临时/);
  assert.doesNotMatch(script, /D:\\Live Data/);
  assert.match(buildFilePickerScript({resultFile: 'x', mode: 'open'}), /OpenFileDialog/);
});
