import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {startServer} from '../../src/server/index.mjs';
import {
  clearDataLocation,
  locationFileCandidates,
  readDataLocation,
  writeDataLocation
} from '../../src/shared/data-location.mjs';
import {openDatabase, closeDatabase} from '../../src/storage/database/connection.mjs';
import {migrate} from '../../src/storage/database/migrations/index.mjs';
import {relocateDataDir, validateTarget, isUnsafeTarget} from '../../src/server/relocation.mjs';
import {backupDirectory, createDatabaseBackup} from '../../src/server/maintenance.mjs';

/**
 * Data-folder relocation and destructive data management, exercised through the
 * real HTTP API and file system. These tests use temporary folders only.
 */

const json = async (base, path, {method = 'GET', body} = {}) => {
  const response = await fetch(`${base}api${path}`, {
    method,
    headers: body === undefined ? undefined : {'content-type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  return {status: response.status, body: text ? JSON.parse(text) : null};
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('the data-location pointer is atomic, mirrored and never relative', () => {
  const temp = createTempDir();
  try {
    const env = {
      ...process.env,
      LOCALAPPDATA: join(temp.dir, 'local'),
      APPDATA: join(temp.dir, 'roaming'),
      LIVE_MEMORY_LOCATION_DIR: ''
    };
    const target = join(temp.dir, 'target');
    const written = writeDataLocation(target, {env, now: 1234});
    assert.equal(written.files.length, 2);
    const read = readDataLocation({env});
    assert.equal(read.dataDir, target);
    assert.equal(read.version, 1);

    // A corrupt primary file must not hide the valid mirror.
    const [primary, mirror] = locationFileCandidates({env});
    writeFileSync(primary, '{not json', 'utf8');
    assert.ok(existsSync(mirror));
    assert.equal(readDataLocation({env}).dataDir, target);

    // Relative paths are rejected instead of resolving against the CWD.
    writeFileSync(primary, JSON.stringify({version: 1, dataDir: 'relative\\path'}), 'utf8');
    assert.equal(readDataLocation({env}).dataDir, target);

    assert.equal(clearDataLocation({env}).length, 2);
    assert.equal(readDataLocation({env}), null);
  } finally {
    temp.cleanup();
  }
});

test('target validation rejects unsafe, nested, network and full targets', () => {
  const temp = createTempDir();
  try {
    const source = join(temp.dir, 'data');
    mkdirSync(source, {recursive: true});
    assert.throws(() => validateTarget({targetDir: 'relative', sourceDir: source}), /RELOCATION_INVALID/);
    assert.throws(() => validateTarget({targetDir: '\\\\server\\share', sourceDir: source}), /RELOCATION_NETWORK_PATH/);
    assert.throws(() => validateTarget({targetDir: source, sourceDir: source}), /RELOCATION_INVALID/);
    assert.throws(() => validateTarget({targetDir: join(source, 'inside'), sourceDir: source}), /RELOCATION_INVALID/);
    assert.equal(isUnsafeTarget(process.env.SystemRoot ?? 'C:\\Windows'), 'protected_root');
    assert.equal(isUnsafeTarget(process.env.SystemRoot ? join(process.env.SystemRoot, 'Temp') : 'C:\\Windows\\Temp'), 'protected_subtree');

    const conflict = join(temp.dir, 'conflict');
    mkdirSync(join(conflict, 'database'), {recursive: true});
    writeFileSync(join(conflict, 'database', 'livememory.db'), 'x');
    assert.throws(
      () => validateTarget({targetDir: conflict, sourceDir: source}),
      /RELOCATION_TARGET_IN_USE/
    );

    assert.throws(
      () => validateTarget({
        targetDir: join(temp.dir, 'no-space'),
        sourceDir: source,
        sourceBytes: 10 * 1024 * 1024,
        statfs: () => ({bavail: 1, bsize: 1})
      }),
      /RELOCATION_NO_SPACE/
    );

    const cloud = validateTarget({
      targetDir: join(temp.dir, 'OneDrive', 'data'),
      sourceDir: source,
      env: {...process.env, OneDrive: join(temp.dir, 'OneDrive')}
    });
    assert.ok(cloud.warnings.some((warning) => warning.code === 'cloud_sync'));
  } finally {
    temp.cleanup();
  }
});

test('relocation copies, verifies and switches without touching the old folder', async (t) => {
  const temp = createTempDir();
  const data = join(temp.dir, 'data');
  const target = join(temp.dir, 'OneDrive', 'target');
  const env = {
    ...process.env,
    LIVE_MEMORY_LOCATION_DIR: join(temp.dir, 'location'),
    LIVE_MEMORY_BACKUP_DIR: join(temp.dir, 'external-backups'),
    OneDrive: join(temp.dir, 'OneDrive')
  };
  const server = await startServer({auth: false,dataDir: data, port: 0, systemLocale: 'en', env});
  const base = server.url;
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });

  assert.equal((await json(base, '/simulate/start', {method: 'POST', body: {title: 'Relocation', speed: 'busy'}})).status, 201);
  await sleep(1200);
  assert.equal((await json(base, '/simulate/stop', {method: 'POST', body: {}})).status, 200);
  writeFileSync(join(data, 'personal-note.txt'), 'keep me', 'utf8');
  writeFileSync(join(data, 'secrets', 'dummy-secret.txt'), 'local secret', 'utf8');
  mkdirSync(join(data, 'exports'), {recursive: true});
  writeFileSync(join(data, 'exports', 'package.zip'), 'zip', 'utf8');
  mkdirSync(join(data, 'backups'), {recursive: true});
  writeFileSync(join(data, 'backups', 'keep.bin'), 'backup', 'utf8');

  const before = await json(base, '/storage/location');
  // The temporary folder is not %LOCALAPPDATA%\LiveMemory, so it is reported
  // as an explicit override rather than as the default location.
  assert.equal(before.body.source, 'override');
  assert.ok(before.body.counts.events > 0);

  // Warnings (the target is inside the temp tree) require explicit acceptance.
  const refused = await json(base, '/storage/location', {
    method: 'POST',
    body: {targetDir: target, mode: 'migrate'}
  });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'RELOCATION_WARNINGS');

  const moved = await json(base, '/storage/location', {
    method: 'POST',
    body: {targetDir: target, mode: 'migrate', acceptWarnings: true}
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.relocation.dataDir, target);
  assert.equal(moved.body.relocation.mode, 'migrate');
  assert.equal(moved.body.relocation.counts.before.events, moved.body.relocation.counts.after.events);
  assert.equal(moved.body.storage.dataDir, target);
  assert.equal(moved.body.storage.source, 'pointer');

  // The launch pointer names the new folder, and both local copies exist.
  const pointer = readDataLocation({env});
  assert.equal(pointer.dataDir, target);
  assert.ok(pointer.pointerFile.endsWith('data-location.json'));
  assert.ok(existsSync(join(target, 'database', 'livememory.db')));
  assert.ok(existsSync(join(target, 'secrets', 'dummy-secret.txt')));
  assert.ok(existsSync(join(target, 'exports', 'package.zip')));
  assert.ok(existsSync(join(target, 'backups', 'keep.bin')));

  // The old folder is untouched, including unrelated files.
  assert.ok(existsSync(join(data, 'database', 'livememory.db')));
  assert.equal(readFileSync(join(data, 'personal-note.txt'), 'utf8'), 'keep me');
  // The migration never copies the whole root.
  assert.equal(existsSync(join(target, 'personal-note.txt')), false);

  // The running server now uses the target without a restart.
  const after = await json(base, '/storage/location');
  assert.equal(after.body.dataDir, target);
  assert.equal(after.body.counts.events, before.body.counts.events);
  const health = await json(base, '/health');
  assert.equal(health.status, 200);
  const oldDataDir = data;
  assert.ok(existsSync(oldDataDir));
});

test('new data space creates an empty database and keeps settings/credentials', async (t) => {
  const temp = createTempDir();
  const data = join(temp.dir, 'data');
  const target = join(temp.dir, 'new-space-target');
  const env = {
    ...process.env,
    LIVE_MEMORY_LOCATION_DIR: join(temp.dir, 'location'),
    LIVE_MEMORY_BACKUP_DIR: join(temp.dir, 'external-backups')
  };
  const server = await startServer({auth: false,dataDir: data, port: 0, systemLocale: 'en', env});
  const base = server.url;
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });

  assert.equal((await json(base, '/simulate/start', {method: 'POST', body: {title: 'New space', speed: 'busy'}})).status, 201);
  await sleep(1200);
  assert.equal((await json(base, '/simulate/stop', {method: 'POST', body: {}})).status, 200);
  writeFileSync(join(data, 'secrets', 'dummy-secret.txt'), 'local secret', 'utf8');
  assert.equal((await json(base, '/settings', {method: 'PATCH', body: {locale: 'ja'}})).status, 200);
  const before = await json(base, '/storage/location');
  assert.equal(before.body.counts.events > 0, true);

  const created = await json(base, '/storage/location', {
    method: 'POST',
    body: {targetDir: target, mode: 'new', acceptWarnings: true}
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.relocation.mode, 'new');
  assert.equal(created.body.storage.dataDir, target);
  assert.equal(created.body.storage.counts.sessions, 0);
  assert.equal(created.body.storage.counts.events, 0);
  assert.equal(created.body.storage.counts.viewers, 0);
  assert.ok(existsSync(join(target, 'database', 'livememory.db')));
  // Settings and local secrets are carried over; history is not.
  assert.ok(existsSync(join(target, 'config', 'settings.json')));
  assert.equal((await json(base, '/settings')).body.settings.locale, 'ja');
  assert.ok(existsSync(join(target, 'secrets', 'dummy-secret.txt')));
  assert.equal(existsSync(join(data, 'database', 'livememory.db')), true);
  assert.ok(before.body.counts.events > 0);
  assert.equal((await json(base, '/health')).status, 200);
});

test('a copy interruption after the source stops rolls back to the original folder', async (t) => {
  const temp = createTempDir();
  const data = join(temp.dir, 'data');
  const target = join(temp.dir, 'OneDrive', 'rollback-target');
  const env = {
    ...process.env,
    LIVE_MEMORY_LOCATION_DIR: join(temp.dir, 'location'),
    LIVE_MEMORY_BACKUP_DIR: join(temp.dir, 'external-backups'),
    OneDrive: join(temp.dir, 'OneDrive')
  };
  const server = await startServer({auth: false,dataDir: data, port: 0, systemLocale: 'en', env});
  const base = server.url;
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  assert.equal((await json(base, '/simulate/start', {method: 'POST', body: {title: 'Rollback', speed: 'busy'}})).status, 201);
  await sleep(1200);
  assert.equal((await json(base, '/simulate/stop', {method: 'POST', body: {}})).status, 200);
  const before = await json(base, '/storage/location');
  assert.ok(before.body.counts.events > 0);

  await assert.rejects(
    () => relocateDataDir({
      deps: server.deps,
      targetDir: target,
      mode: 'migrate',
      acceptWarnings: true,
      env,
      hooks: {
        afterMove() {
          throw new Error('simulated copy interruption');
        }
      }
    }),
    /RELOCATION_FAILED/
  );

  // The original runtime was rebuilt and still serves the same data.
  const after = await json(base, '/storage/location');
  assert.equal(after.body.dataDir, data);
  assert.equal(after.body.counts.events, before.body.counts.events);
  assert.equal(readDataLocation({env}), null);
  // The partially moved target is rolled back; the original is untouched.
  assert.equal(existsSync(join(target, 'database', 'livememory.db')), false);
  assert.ok(existsSync(join(data, 'database', 'livememory.db')));
  const health = await json(base, '/health');
  assert.equal(health.status, 200);
});

test('clear-data keeps preferences and credentials, and factory reset removes them', async (t) => {
  const temp = createTempDir();
  const data = join(temp.dir, 'data');
  const env = {
    ...process.env,
    LIVE_MEMORY_LOCATION_DIR: join(temp.dir, 'location'),
    LIVE_MEMORY_BACKUP_DIR: join(temp.dir, 'external-backups')
  };
  const server = await startServer({auth: false,dataDir: data, port: 0, systemLocale: 'en', env});
  const base = server.url;
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });

  await json(base, '/settings', {method: 'PATCH', body: {locale: 'ja', theme: 'dark'}});
  assert.equal((await json(base, '/simulate/start', {method: 'POST', body: {title: 'Clear', speed: 'busy'}})).status, 201);
  await sleep(1200);

  // Clearing while recording is refused.
  const recording = await json(base, '/storage/clear', {
    method: 'POST',
    body: {mode: 'data', confirmText: 'DELETE', backupFirst: false}
  });
  assert.equal(recording.status, 409);
  assert.equal(recording.body.error.code, 'SESSION_ACTIVE');

  assert.equal((await json(base, '/simulate/stop', {method: 'POST', body: {}})).status, 200);
  writeFileSync(join(data, 'personal-note.txt'), 'keep me', 'utf8');
  writeFileSync(join(data, 'secrets', 'dummy-secret.txt'), 'local secret', 'utf8');
  writeFileSync(join(data, 'exports', 'old-package.zip'), 'zip', 'utf8');
  mkdirSync(join(data, 'backups'), {recursive: true});
  writeFileSync(join(data, 'backups', 'keep-backup.bin'), 'backup', 'utf8');

  const wrong = await json(base, '/storage/clear', {
    method: 'POST',
    body: {mode: 'data', confirmText: 'delete', backupFirst: false}
  });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error.code, 'CONFIRM_TEXT_MISMATCH');
  const stillThere = await json(base, '/storage/location');
  assert.ok(stillThere.body.counts.events > 0);

  const cleared = await json(base, '/storage/clear', {
    method: 'POST',
    body: {mode: 'data', confirmText: 'DELETE', backupFirst: true}
  });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.equal(cleared.body.clear.after.sessions, 0);
  assert.equal(cleared.body.clear.after.events, 0);
  assert.equal(cleared.body.clear.after.viewers, 0);
  assert.ok(cleared.body.clear.backup?.file);
  assert.ok(existsSync(cleared.body.clear.backup.file));
  // Backup is outside the data folder by default.
  assert.equal(cleared.body.clear.backup.file.startsWith(data), false);
  assert.equal(backupDirectory({env}).startsWith(data), false);

  // Preferences and local credentials survive "clear data".
  const settings = await json(base, '/settings');
  assert.equal(settings.body.effective.locale, 'ja');
  assert.equal(settings.body.settings.theme, 'dark');
  assert.ok(existsSync(join(data, 'secrets', 'dummy-secret.txt')));
  assert.equal(readFileSync(join(data, 'personal-note.txt'), 'utf8'), 'keep me');
  assert.ok(existsSync(join(data, 'backups', 'keep-backup.bin')));
  assert.equal(existsSync(join(data, 'exports', 'old-package.zip')), false);
  const emptyViewers = await json(base, '/viewers');
  assert.equal(emptyViewers.body.viewers.length, 0);
  const integrity = new DatabaseSync(join(data, 'database', 'livememory.db'));
  try {
    assert.equal(integrity.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(Number(integrity.prepare('SELECT COUNT(*) AS count FROM events').get().count), 0);
  } finally {
    integrity.close();
  }

  // Factory reset removes preferences, credentials, exports and cache but never
  // unrelated root files or backups.
  writeDataLocation(data, {env});
  writeFileSync(join(data, 'secrets', 'dummy-secret.txt'), 'again', 'utf8');
  writeFileSync(join(data, 'exports', 'again.zip'), 'zip', 'utf8');
  writeFileSync(join(data, 'logs', 'dummy.log'), 'log', 'utf8');
  const factory = await json(base, '/storage/clear', {
    method: 'POST',
    body: {mode: 'factory', confirmText: 'RESET', backupFirst: false}
  });
  assert.equal(factory.status, 200, JSON.stringify(factory.body));
  assert.equal(factory.body.clear.settingsReset, true);
  assert.equal(factory.body.settings.locale, 'system');
  assert.equal(factory.body.settings.theme, 'system');
  assert.equal(factory.body.effective.locale, 'en');
  assert.equal(existsSync(join(data, 'secrets', 'dummy-secret.txt')), false);
  assert.equal(existsSync(join(data, 'exports', 'again.zip')), false);
  assert.equal(existsSync(join(data, 'logs', 'dummy.log')), false);
  assert.equal(readFileSync(join(data, 'personal-note.txt'), 'utf8'), 'keep me');
  assert.ok(existsSync(join(data, 'backups', 'keep-backup.bin')));
  // The launch pointer is not inside a managed folder and survives reset.
  const pointer = readDataLocation({env});
  assert.ok(pointer);
  assert.equal(pointer.dataDir, data);
});

test('the emergency database snapshot is consistent and independent of the live database', () => {
  const temp = createTempDir();
  try {
    const file = join(temp.dir, 'database', 'livememory.db');
    mkdirSync(join(temp.dir, 'database'), {recursive: true});
    const db = openDatabase({file});
    try {
      migrate(db);
      db.prepare(`
        INSERT INTO app_meta (key, value, updated_at) VALUES ('test.marker', 'kept', ?)
      `).run(1234);
      const backup = createDatabaseBackup({
        db,
        env: {...process.env, LIVE_MEMORY_BACKUP_DIR: join(temp.dir, 'external-backups')},
        now: Date.parse('2026-11-08T10:00:00.000Z')
      });
      assert.ok(existsSync(backup.file));
      assert.equal(backup.file.startsWith(temp.dir), true);
      assert.equal(backup.file.startsWith(join(temp.dir, 'database')), false);
      assert.equal(typeof backup.counts, 'object');
      const copied = new DatabaseSync(backup.file);
      try {
        assert.equal(copied.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
        assert.equal(copied.prepare("SELECT value FROM app_meta WHERE key = 'test.marker'").get().value, 'kept');
      } finally {
        copied.close();
      }
      // The live database is still usable after VACUUM INTO.
      assert.equal(db.prepare("SELECT value FROM app_meta WHERE key = 'test.marker'").get().value, 'kept');
    } finally {
      closeDatabase(db);
    }
  } finally {
    temp.cleanup();
  }
});
