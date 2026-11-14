import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import {dirname, join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {startServer} from '../../src/server/index.mjs';
import {createBackup} from '../../src/server/backup/create.mjs';
import {inspectBackup} from '../../src/server/backup/inspect.mjs';
import {restoreBackup} from '../../src/server/backup/restore.mjs';
import {openArchive, extractEntryToFile, readEntryBuffer, sha256File} from '../../src/server/backup/archive.mjs';
import {writeRestoreJournal, restoreJournalPath, RESTORE_PHASES} from '../../src/server/backup/journal.mjs';
import {BACKUP_ENTRIES} from '../../src/server/backup/constants.mjs';
import {settingsForBackup} from '../../src/server/backup/settings.mjs';
import {buildZip, dataOffsetOf} from '../helpers/zip-fixture.mjs';
import {importSessionAnalysis} from '../helpers/memory-fixtures.mjs';
import {mergeSessionIntoMemory} from '../../src/memory/local.mjs';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function envFor(root) {
  return {
    ...process.env,
    LIVE_MEMORY_LOCATION_DIR: join(root, 'location'),
    LIVE_MEMORY_BACKUP_DIR: join(root, 'external-backups'),
    LOCALAPPDATA: join(root, 'local'),
    APPDATA: join(root, 'roaming')
  };
}

async function api(base, path, {method = 'GET', body, headers = {}} = {}) {
  const response = await fetch(`${base}api${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : {'content-type': 'application/json'}),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  return {status: response.status, body: payload, text};
}

async function waitJob(base, id, {timeout = 60000} = {}) {
  const started = Date.now();
  for (;;) {
    const response = await api(base, `/backup/jobs/${encodeURIComponent(id)}`);
    const job = response.body?.job;
    if (job && job.status !== 'running') return job;
    if (Date.now() - started > timeout) throw new Error(`backup job timeout: ${id} ${JSON.stringify(job)}`);
    await sleep(100);
  }
}

async function start(dataDir, env, options = {}) {
  return startServer({auth: false, dataDir, port: 0, systemLocale: 'en', env, ...options});
}

function count(db, table) {
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0);
}

function integrityOk(db) {
  const rows = db.prepare('PRAGMA integrity_check').all();
  return rows.length === 1 && String(rows[0].integrity_check) === 'ok';
}

async function seed(server, title = 'Fixture stream') {
  const started = await api(server.url, '/simulate/start', {
    method: 'POST',
    body: {title, speed: 'busy'}
  });
  assert.equal(started.status, 201);
  const sessionId = started.body.session.id;
  await sleep(1400);
  const stopped = await api(server.url, '/simulate/stop', {method: 'POST', body: {}});
  assert.equal(stopped.status, 200);
  await importSessionAnalysis({db: server.db, sessionId, exportsDir: server.paths.exports});
  const merged = mergeSessionIntoMemory({db: server.db, sessionId, apply: true});
  assert.equal(merged.ok, true);
  return sessionId;
}

async function makeBackup(server, file, options = {}) {
  const created = await api(server.url, '/backup/create', {method: 'POST', body: {path: file, ...options}});
  assert.equal(created.status, 202, JSON.stringify(created.body));
  const job = await waitJob(server.url, created.body.job.id);
  assert.equal(job.status, 'completed', JSON.stringify(job));
  return job.result;
}

async function restore(server, file) {
  const started = await api(server.url, '/backup/restore', {
    method: 'POST',
    body: {path: file, confirmText: 'RESTORE'}
  });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const job = await waitJob(server.url, started.body.job.id);
  return job;
}

function tableCounts(db) {
  const tables = ['sessions', 'events', 'viewers', 'ai_results', 'memory_facts', 'viewer_memories', 'broadcasters'];
  return Object.fromEntries(tables.map((table) => [table, count(db, table)]));
}

function findTextInDatabase(db, needle) {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
  ).all().map((row) => row.name);
  const hits = [];
  for (const table of tables) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    for (const column of columns) {
      if (!/TEXT|CHAR|CLOB/i.test(String(column.type ?? ''))) continue;
      const row = db.prepare(
        `SELECT COUNT(*) AS count FROM ${table} WHERE ${column.name} LIKE ?`
      ).get(`%${needle}%`);
      if (Number(row?.count ?? 0) > 0) hits.push(`${table}.${column.name}`);
    }
  }
  return hits;
}

function readBackupManifest(file) {
  const archive = openArchive(file);
  try {
    const entry = archive.entry(BACKUP_ENTRIES.manifest);
    return JSON.parse(readEntryBuffer(archive, entry).toString('utf8'));
  } finally {
    archive.close();
  }
}

/* ------------------------------------------------------------------ tests */

test('a full backup is one file with a verified manifest, database and settings but no secrets', async () => {
  const temp = createTempDir('backup-full-');
  const data = join(temp.dir, 'data');
  const env = envFor(temp.dir);
  const backupFile = join(temp.dir, 'full.livememory');
  const server = await start(data, env);
  try {
    const sessionId = await seed(server);
    await api(server.url, '/settings', {method: 'PATCH', body: {locale: 'ja', theme: 'dark'}});
    writeFileSync(join(server.paths.secrets, 'bilibili-cookies.json'), '{"fake":"secret"}', 'utf8');
    writeFileSync(join(server.paths.secrets, 'ai-keys.json'), '{"fake":"key"}', 'utf8');

    const previousCounts = tableCounts(server.db);
    const result = await makeBackup(server, backupFile);
    assert.equal(result.file, backupFile);
    assert.ok(existsSync(backupFile));
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    assert.equal(integrityOk(server.db), true, 'the live database must stay valid');
    assert.deepEqual(tableCounts(server.db), previousCounts, 'creating a backup must not change rows');

    const summary = await inspectBackup({file: backupFile});
    assert.equal(summary.verified, true);
    assert.equal(summary.containsCredentials, false);
    assert.equal(summary.counts.sessions, previousCounts.sessions);
    assert.equal(summary.counts.events, previousCounts.events);
    assert.equal(summary.counts.viewers, previousCounts.viewers);
    assert.equal(summary.counts.ai_results > 0, true);
    assert.equal(summary.counts.memory_facts > 0, true);
    assert.equal(summary.hasLongTermMemory, true);
    assert.equal(summary.hasAiReports, true);
    assert.equal(summary.settings.locale, 'ja');
    assert.equal(summary.settings.theme, 'dark');

    const manifest = readBackupManifest(backupFile);
    assert.equal(manifest.format, 'livememory-backup');
    assert.equal(manifest.format_version, 1);
    assert.equal(manifest.schema_version, 16);
    assert.equal(manifest.contains_credentials, false);
    assert.ok(manifest.created_at);
    assert.ok(Array.isArray(manifest.excluded));
    assert.ok(manifest.excluded.some((entry) => String(entry.path).includes('secrets')));
    assert.equal(JSON.stringify(manifest).includes(data), false, 'manifest must not contain absolute source paths');
    assert.deepEqual(
      manifest.files.map((entry) => entry.name).sort(),
      [BACKUP_ENTRIES.database, BACKUP_ENTRIES.settings].sort()
    );

    const archive = openArchive(backupFile);
    try {
      assert.deepEqual(
        archive.entries.map((entry) => entry.name).sort(),
        [BACKUP_ENTRIES.manifest, BACKUP_ENTRIES.database, BACKUP_ENTRIES.settings].sort()
      );
      assert.equal(archive.entries.some((entry) => entry.name.startsWith('secrets/')), false);
    } finally {
      archive.close();
    }
    assert.ok(sessionId);
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('backup during live capture is consistent with uncheckpointed WAL data', async () => {
  const temp = createTempDir('backup-wal-');
  const data = join(temp.dir, 'data');
  const env = envFor(temp.dir);
  const backupFile = join(temp.dir, 'wal.livememory');
  const server = await start(data, env);
  try {
    await seed(server);
    server.db.exec('PRAGMA wal_autocheckpoint = 0');
    const started = await api(server.url, '/simulate/start', {
      method: 'POST',
      body: {title: 'Live while backing up', speed: 'busy'}
    });
    assert.equal(started.status, 201);
    await sleep(1200);
    const wal = `${data}/database/livememory.db-wal`;
    assert.ok(existsSync(wal), 'WAL file should exist');
    assert.ok(statSync(wal).size > 0, 'WAL should contain uncheckpointed data');
    const before = count(server.db, 'events');

    await makeBackup(server, backupFile);
    const after = count(server.db, 'events');
    const summary = await inspectBackup({file: backupFile});
    assert.ok(summary.counts.events >= before, `${summary.counts.events} >= ${before}`);
    assert.ok(summary.counts.events <= after, `${summary.counts.events} <= ${after}`);
    assert.ok(summary.counts.events > 0);

    const archive = openArchive(backupFile);
    try {
      extractEntryToFile(archive, archive.entry(BACKUP_ENTRIES.database), join(temp.dir, 'inspect-snapshot.db'));
    } finally {
      archive.close();
    }
    const snapshot = new DatabaseSync(join(temp.dir, 'inspect-snapshot.db'));
    try {
      assert.equal(integrityOk(snapshot), true);
      assert.equal(count(snapshot, 'events'), summary.counts.events);
    } finally {
      snapshot.close();
    }
    assert.equal(integrityOk(server.db), true);
    await api(server.url, '/simulate/stop', {method: 'POST', body: {}});
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('cancelling a backup mid-write leaves no target, no partial file and no changed data', async () => {
  const temp = createTempDir('backup-cancel-');
  const data = join(temp.dir, 'data');
  const env = envFor(temp.dir);
  const server = await start(data, env);
  try {
    await seed(server);
    const before = tableCounts(server.db);

    const preAborted = new AbortController();
    preAborted.abort();
    await assert.rejects(
      () => createBackup({
        db: server.db,
        paths: server.paths,
        settings: server.settings.get(),
        file: join(temp.dir, 'pre-aborted.livememory'),
        appVersion: 'test',
        signal: preAborted.signal
      }),
      (error) => error.code === 'BACKUP_CANCELLED'
    );

    const controller = new AbortController();
    let writeProgress = 0;
    await assert.rejects(
      () => createBackup({
        db: server.db,
        paths: server.paths,
        settings: server.settings.get(),
        file: join(temp.dir, 'mid-write.livememory'),
        appVersion: 'test',
        signal: controller.signal,
        onProgress: (update) => {
          if (update.phase === 'write') {
            writeProgress += 1;
            if (writeProgress > 1) controller.abort();
          }
        }
      }),
      (error) => error.code === 'BACKUP_CANCELLED'
    );
    assert.equal(existsSync(join(temp.dir, 'mid-write.livememory')), false);
    assert.equal(
      readdirSync(temp.dir).some((name) => name.includes('.partial-')),
      false,
      'no partial file may remain'
    );
    assert.deepEqual(tableCounts(server.db), before);
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('write failures, disk-space shortage and overwrite conflicts never replace data silently', async () => {
  const temp = createTempDir('backup-errors-');
  const data = join(temp.dir, 'data');
  const env = envFor(temp.dir);
  const server = await start(data, env);
  try {
    await seed(server);
    const base = {
      db: server.db,
      paths: server.paths,
      settings: server.settings.get(),
      appVersion: 'test'
    };
    const failedFile = join(temp.dir, 'write-fails.livememory');
    await assert.rejects(
      () => createBackup({
        ...base,
        file: failedFile,
        hooks: {afterWrite() { throw new Error('simulated disk failure'); }}
      }),
      /simulated disk failure|BACKUP/
    );
    assert.equal(existsSync(failedFile), false);
    assert.equal(readdirSync(temp.dir).some((name) => name.includes('.partial-')), false);

    await assert.rejects(
      () => createBackup({
        ...base,
        file: join(temp.dir, 'no-space.livememory'),
        statfs: () => ({bavail: 1, bsize: 1})
      }),
      (error) => error.code === 'BACKUP_NO_SPACE'
    );

    const target = join(temp.dir, 'existing.livememory');
    writeFileSync(target, 'old file', 'utf8');
    await assert.rejects(
      () => createBackup({...base, file: target}),
      (error) => error.code === 'BACKUP_TARGET_EXISTS'
    );
    assert.equal(readFileSync(target, 'utf8'), 'old file');
    await createBackup({...base, file: target, overwrite: true});
    assert.ok(statSync(target).size > 100);
    assert.equal(integrityOk(server.db), true);

    await assert.rejects(
      () => createBackup({...base, file: join(temp.dir, 'missing-dir', 'x.livememory')}),
      (error) => error.code === 'BACKUP_PATH_INVALID'
    );
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('a damaged, incomplete, future-version or hostile backup is rejected before any restore', async () => {
  const temp = createTempDir('backup-hostile-');
  const data = join(temp.dir, 'data');
  const env = envFor(temp.dir);
  const server = await start(data, env);
  try {
    await seed(server);
    const good = join(temp.dir, 'good.livememory');
    await makeBackup(server, good);

    // 1. A single modified byte fails the CRC / SHA checksum.
    const tampered = join(temp.dir, 'tampered.livememory');
    const tamperedBuffer = readFileSync(good);
    const offset = dataOffsetOf(tamperedBuffer, BACKUP_ENTRIES.database);
    tamperedBuffer[offset] ^= 0xff;
    writeFileSync(tampered, tamperedBuffer);
    assert.equal(
      await inspectBackup({file: tampered}).then(() => 'ok', (error) => error.code),
      'BACKUP_CHECKSUM_MISMATCH'
    );

    // 2. A backup whose database entry is missing is incomplete.
    const archive = openArchive(good);
    let databaseBytes;
    let settingsBytes;
    try {
      databaseBytes = readEntryBuffer(archive, archive.entry(BACKUP_ENTRIES.database), {maxBytes: 32 * 1024 * 1024});
      settingsBytes = readEntryBuffer(archive, archive.entry(BACKUP_ENTRIES.settings));
    } finally {
      archive.close();
    }
    const baseManifest = readBackupManifest(good);
    const settingsOnly = join(temp.dir, 'missing-db.livememory');
    const settingsHash = (await import('node:crypto')).createHash('sha256').update(settingsBytes).digest('hex');
    writeFileSync(settingsOnly, buildZip([
      {
        name: BACKUP_ENTRIES.manifest,
        data: JSON.stringify({
          ...baseManifest,
          files: [{name: BACKUP_ENTRIES.settings, bytes: settingsBytes.length, sha256: settingsHash}]
        })
      },
      {name: BACKUP_ENTRIES.settings, data: settingsBytes}
    ]));
    assert.equal(
      await inspectBackup({file: settingsOnly}).then(() => 'ok', (error) => error.code),
      'BACKUP_CONTENT_MISMATCH'
    );

    // 3. A future format version is identified, not treated as corruption.
    const future = join(temp.dir, 'future.livememory');
    writeFileSync(future, buildZip([
      {
        name: BACKUP_ENTRIES.manifest,
        data: JSON.stringify({...baseManifest, format_version: 2})
      },
      {name: BACKUP_ENTRIES.database, data: databaseBytes},
      {name: BACKUP_ENTRIES.settings, data: settingsBytes}
    ]));
    assert.equal(
      await inspectBackup({file: future}).then(() => 'ok', (error) => error.code),
      'BACKUP_FORMAT_UNSUPPORTED'
    );

    // 4. A database that is not SQLite fails integrity checking even when its
    //    checksum and CRC are internally consistent.
    const garbage = Buffer.from('this is not a sqlite database at all');
    const garbageHash = (await import('node:crypto')).createHash('sha256').update(garbage).digest('hex');
    const corrupt = join(temp.dir, 'corrupt-db.livememory');
    writeFileSync(corrupt, buildZip([
      {
        name: BACKUP_ENTRIES.manifest,
        data: JSON.stringify({
          ...baseManifest,
          files: [{name: BACKUP_ENTRIES.database, bytes: garbage.length, sha256: garbageHash}]
        })
      },
      {name: BACKUP_ENTRIES.database, data: garbage}
    ]));
    assert.equal(
      await inspectBackup({file: corrupt}).then(() => 'ok', (error) => error.code),
      'BACKUP_VERIFY_FAILED'
    );

    // 5. ZIP Slip and a compressed entry are rejected by the archive reader.
    const slip = join(temp.dir, 'slip.livememory');
    writeFileSync(slip, buildZip([
      {name: '../escape.db', data: 'x'},
      {name: BACKUP_ENTRIES.manifest, data: '{}'}
    ]));
    assert.equal(
      await inspectBackup({file: slip}).then(() => 'ok', (error) => error.code),
      'BACKUP_INVALID_ARCHIVE'
    );

    const bomb = join(temp.dir, 'bomb.livememory');
    writeFileSync(bomb, buildZip([{name: BACKUP_ENTRIES.database, data: 'x', method: 8, uncompressedSize: 0x7fffffff}]));
    assert.equal(
      await inspectBackup({file: bomb}).then(() => 'ok', (error) => error.code),
      'BACKUP_INVALID_ARCHIVE'
    );

    // The live database was never touched by any of these rejected files.
    assert.equal(integrityOk(server.db), true);
    assert.ok(count(server.db, 'sessions') > 0);
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('restore into a fresh directory keeps sessions, viewers, AI reports and long-term memory', async () => {
  const temp = createTempDir('backup-restore-');
  const sourceData = join(temp.dir, 'source-data');
  const targetData = join(temp.dir, 'target-data');
  const env = envFor(temp.dir);
  const backupFile = join(temp.dir, 'migrate.livememory');
  const source = await start(sourceData, env);
  let target = null;
  try {
    const sessionId = await seed(source, 'Migrated broadcast');
    await api(source.url, '/settings', {method: 'PATCH', body: {locale: 'ja', theme: 'dark'}});
    writeFileSync(join(source.paths.secrets, 'bilibili-cookies.json'), '{"fake":"cookie"}', 'utf8');
    const sourceCounts = tableCounts(source.db);
    const factRows = source.db.prepare('SELECT statement FROM memory_facts ORDER BY statement').all();
    const resultRows = source.db.prepare('SELECT result_json FROM ai_results').all();
    await makeBackup(source, backupFile);

    target = await start(targetData, env);
    assert.notEqual(sourceData, targetData);
    const job = await restore(target, backupFile);
    assert.equal(job.status, 'completed', JSON.stringify(job));
    assert.equal(job.error, null);
    assert.deepEqual(tableCounts(target.db), sourceCounts);
    assert.equal(job.result.credentialsExcluded, true);
    assert.ok(job.result.requiresReconnect.includes('bilibili-login'));
    assert.ok(job.result.requiresReconnect.includes('ai-provider-key'));

    const sessions = await api(target.url, '/sessions');
    assert.equal(sessions.status, 200);
    assert.equal(sessions.body.sessions.length, sourceCounts.sessions);
    assert.equal(sessions.body.sessions[0].id, sessionId);

    assert.deepEqual(
      target.db.prepare('SELECT statement FROM memory_facts ORDER BY statement').all(),
      factRows,
      'long-term facts must survive byte for byte'
    );
    assert.deepEqual(
      target.db.prepare('SELECT result_json FROM ai_results').all(),
      resultRows,
      'AI analysis results must survive byte for byte'
    );
    assert.ok(count(target.db, 'viewer_memories') > 0);

    const settings = await api(target.url, '/settings');
    assert.equal(settings.body.settings.locale, 'ja');
    assert.equal(settings.body.settings.theme, 'dark');

    // Credentials are not present in the restored folder.
    const secretFiles = readdirSync(target.paths.secrets);
    assert.deepEqual(secretFiles, [], 'no credential file may be restored');

    // No machine-specific absolute path from the old computer is stored.
    assert.deepEqual(findTextInDatabase(target.db, sourceData), []);
    const packagePaths = target.db.prepare('SELECT relative_path FROM ai_packages').all();
    for (const row of packagePaths) {
      assert.equal(/^[A-Za-z]:/.test(String(row.relative_path)), false);
      assert.equal(String(row.relative_path).startsWith('/'), false);
    }
    const restoredSettingsText = readFileSync(join(targetData, 'config', 'settings.json'), 'utf8');
    assert.equal(restoredSettingsText.includes(sourceData), false);

    // A pre-restore safety snapshot exists and is itself consistent.
    const safety = job.result.safetySnapshot;
    assert.ok(existsSync(safety.file));
    const safetyDb = new DatabaseSync(safety.file);
    try {
      assert.equal(integrityOk(safetyDb), true);
      assert.equal(count(safetyDb, 'sessions'), 0, 'the target was empty before the restore');
    } finally {
      safetyDb.close();
    }
    assert.equal(existsSync(restoreJournalPath(target.paths)), false, 'journal must be removed');

    // Restart the restored installation.
    const restoredCounts = tableCounts(target.db);
    await target.close();
    target = await start(targetData, env);
    assert.deepEqual(tableCounts(target.db), restoredCounts);
    assert.ok(count(target.db, 'sessions') > 0);
    assert.equal(existsSync(restoreJournalPath(target.paths)), false);

    // Restore the same file again: replacement is idempotent, not a merge.
    const again = await restore(target, backupFile);
    assert.equal(again.status, 'completed');
    assert.deepEqual(tableCounts(target.db), sourceCounts);

    // Backup -> restore -> backup: the new archive verifies and matches.
    const secondFile = join(temp.dir, 'after-restore.livememory');
    await makeBackup(target, secondFile);
    const second = await inspectBackup({file: secondFile});
    assert.equal(second.verified, true);
    assert.equal(second.counts.sessions, sourceCounts.sessions);
    assert.equal(second.counts.events, sourceCounts.events);
    assert.equal(second.counts.memory_facts, sourceCounts.memory_facts);
  } finally {
    await source.close();
    if (target) await target.close();
    temp.cleanup();
  }
});

test('a failure after the database swap rolls the previous data back', async () => {
  const temp = createTempDir('backup-rollback-');
  const sourceData = join(temp.dir, 'source-data');
  const targetData = join(temp.dir, 'target-data');
  const env = envFor(temp.dir);
  const backupFile = join(temp.dir, 'rollback.livememory');
  const source = await start(sourceData, env);
  let target = null;
  try {
    await seed(source, 'Source broadcast');
    await makeBackup(source, backupFile);

    target = await start(targetData, env);
    await seed(target, 'Target broadcast');
    const before = tableCounts(target.db);
    const beforeTitles = target.db.prepare('SELECT room_title FROM sessions ORDER BY room_title').all();

    await assert.rejects(
      () => restoreBackup({
        deps: target.deps,
        file: backupFile,
        confirmText: 'RESTORE',
        hooks: {
          afterPlace() {
            throw new Error('simulated crash after swap');
          }
        }
      }),
      (error) => error.code === 'RESTORE_FAILED' && error.details?.rolledBack === true
    );

    assert.deepEqual(tableCounts(target.db), before, 'the original rows must be back');
    assert.deepEqual(
      target.db.prepare('SELECT room_title FROM sessions ORDER BY room_title').all(),
      beforeTitles
    );
    assert.equal(integrityOk(target.db), true);
    assert.equal(existsSync(restoreJournalPath(target.paths)), false);
    const sessions = await api(target.url, '/sessions');
    assert.equal(sessions.status, 200);
    assert.ok(sessions.body.sessions.some((session) => session.roomTitle === 'Target broadcast'));

    // A failure while rebuilding the runtime (after the new file was verified
    // and settings applied) must still be able to roll back: the restore's own
    // build skips startup journal recovery so the previous file is not deleted
    // before the new runtime has actually opened.
    await assert.rejects(
      () => restoreBackup({
        deps: target.deps,
        file: backupFile,
        confirmText: 'RESTORE',
        hooks: {
          beforeBuild() {
            throw new Error('simulated runtime rebuild failure');
          }
        }
      }),
      (error) => error.code === 'RESTORE_FAILED' && error.details?.rolledBack === true
    );
    assert.deepEqual(tableCounts(target.db), before);
    assert.deepEqual(
      target.db.prepare('SELECT room_title FROM sessions ORDER BY room_title').all(),
      beforeTitles
    );
    assert.equal(integrityOk(target.db), true);
    assert.equal(existsSync(restoreJournalPath(target.paths)), false);
  } finally {
    await source.close();
    if (target) await target.close();
    temp.cleanup();
  }
});

test('startup recovers an interrupted restore: roll back or finish using the journal', async () => {
  const temp = createTempDir('backup-crash-');
  const sourceData = join(temp.dir, 'source-data');
  const targetData = join(temp.dir, 'target-data');
  const env = envFor(temp.dir);
  const backupFile = join(temp.dir, 'crash.livememory');
  const source = await start(sourceData, env);
  try {
    await seed(source, 'Source broadcast');
    await makeBackup(source, backupFile);
  } finally {
    await source.close();
  }

  async function prepareTarget() {
    const target = await start(targetData, env);
    await seed(target, 'Target broadcast');
    const originalCounts = tableCounts(target.db);
    await target.close();
    return originalCounts;
  }

  async function stageBackup(prefix) {
    const stageDir = join(targetData, 'runtime', prefix);
    mkdirSync(stageDir, {recursive: true});
    const stagedDb = join(stageDir, 'livememory.db');
    const archive = openArchive(backupFile);
    try {
      extractEntryToFile(archive, archive.entry(BACKUP_ENTRIES.database), stagedDb);
    } finally {
      archive.close();
    }
    return {stageDir, stagedDb};
  }

  // Case 1: only the staging folder exists (`prepared`); the original survives.
  const originalCounts = await prepareTarget();
  {
    const {stageDir, stagedDb} = await stageBackup('restore-prepared');
    writeRestoreJournal({root: targetData, runtime: join(targetData, 'runtime'), databaseFile: join(targetData, 'database', 'livememory.db'), settingsFile: join(targetData, 'config', 'settings.json')}, {
      id: 'rst_prepared',
      phase: RESTORE_PHASES.PREPARED,
      targetDb: join(targetData, 'database', 'livememory.db'),
      stagedDb,
      previousDb: join(targetData, 'runtime', 'restore-previous-prepared.db'),
      stageDir,
      settingsFile: join(targetData, 'config', 'settings.json'),
      settingsBackup: null
    });
    const recovered = await start(targetData, env);
    try {
      assert.equal(recovered.runtime.restoreRecovery.action, 'cleaned');
      assert.deepEqual(tableCounts(recovered.db), originalCounts);
      assert.equal(existsSync(stageDir), false);
      assert.equal(existsSync(restoreJournalPath(recovered.paths)), false);
    } finally {
      await recovered.close();
    }
    rmSync(stageDir, {recursive: true, force: true});
  }

  // Case 2: crash between the two renames (`committing`, target missing) -> rollback.
  {
    const {stageDir, stagedDb} = await stageBackup('restore-rollback');
    const targetDb = join(targetData, 'database', 'livememory.db');
    const previousDb = join(targetData, 'runtime', 'restore-previous-rollback.db');
    const previousSha = sha256File(targetDb).sha256;
    const stagedSha = sha256File(stagedDb).sha256;
    renameSync(targetDb, previousDb);
    writeRestoreJournal({root: targetData, runtime: join(targetData, 'runtime'), databaseFile: targetDb, settingsFile: join(targetData, 'config', 'settings.json')}, {
      id: 'rst_rollback',
      phase: RESTORE_PHASES.COMMITTING,
      targetDb,
      stagedDb,
      previousDb,
      stageDir,
      settingsFile: join(targetData, 'config', 'settings.json'),
      settingsBackup: null,
      stagedSha256: stagedSha,
      previousSha256: previousSha
    });
    const recovered = await start(targetData, env);
    try {
      assert.equal(recovered.runtime.restoreRecovery.action, 'rolled-back');
      assert.deepEqual(tableCounts(recovered.db), originalCounts);
      assert.equal(existsSync(previousDb), false);
      assert.equal(existsSync(restoreJournalPath(recovered.paths)), false);
    } finally {
      await recovered.close();
    }
    rmSync(stageDir, {recursive: true, force: true});
  }

  // Case 3: crash after both renames (`committing`, target is the new file) -> commit.
  {
    const {stageDir, stagedDb} = await stageBackup('restore-commit');
    const targetDb = join(targetData, 'database', 'livememory.db');
    const previousDb = join(targetData, 'runtime', 'restore-previous-commit.db');
    const previousSha = sha256File(targetDb).sha256;
    const stagedSha = sha256File(stagedDb).sha256;
    renameSync(targetDb, previousDb);
    renameSync(stagedDb, targetDb);
    writeRestoreJournal({root: targetData, runtime: join(targetData, 'runtime'), databaseFile: targetDb, settingsFile: join(targetData, 'config', 'settings.json')}, {
      id: 'rst_commit',
      phase: RESTORE_PHASES.COMMITTING,
      targetDb,
      stagedDb,
      previousDb,
      stageDir,
      settingsFile: join(targetData, 'config', 'settings.json'),
      settingsBackup: null,
      stagedSha256: stagedSha,
      previousSha256: previousSha
    });
    const recovered = await start(targetData, env);
    try {
      assert.equal(recovered.runtime.restoreRecovery.action, 'committed');
      assert.ok(count(recovered.db, 'sessions') > 0);
      assert.ok(count(recovered.db, 'memory_facts') > 0);
      assert.equal(existsSync(previousDb), false);
      assert.equal(existsSync(restoreJournalPath(recovered.paths)), false);
    } finally {
      await recovered.close();
    }
    rmSync(stageDir, {recursive: true, force: true});
  }
});

test('during maintenance unauthenticated requests stay 401 and job progress stays readable', async () => {
  const temp = createTempDir('backup-auth-');
  const data = join(temp.dir, 'data');
  const env = envFor(temp.dir);
  const server = await start(data, env, {auth: true});
  try {
    const unauth = await api(server.url, '/viewers');
    assert.equal(unauth.status, 401);

    const browserUrl = new URL(server.browserUrl);
    const token = decodeURIComponent(browserUrl.hash.replace(/^#lm_bootstrap=/, ''));
    const exchange = await fetch(`${server.url}api/auth/session`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({token})
    });
    assert.equal(exchange.status, 200);
    const cookie = (exchange.headers.get('set-cookie') ?? '').split(';')[0];

    server.deps.maintenance = true;
    try {
      const unauthDuring = await api(server.url, '/viewers');
      assert.equal(unauthDuring.status, 401, 'authentication must be checked before maintenance');
      const unauthRestore = await api(server.url, '/backup/restore', {method: 'POST', body: {path: 'x'}});
      assert.equal(unauthRestore.status, 401);

      const authedDuring = await api(server.url, '/viewers', {headers: {cookie}});
      assert.equal(authedDuring.status, 503);
      assert.equal(authedDuring.body.error.code, 'MAINTENANCE');

      const jobDuring = await api(server.url, '/backup/jobs/unknown', {headers: {cookie}});
      assert.equal(jobDuring.status, 404);
    } finally {
      server.deps.maintenance = false;
    }
  } finally {
    await server.close();
    temp.cleanup();
  }
});

test('a backup taken while analysis writes are scheduled is still consistent', async () => {
  const temp = createTempDir('backup-ai-');
  const data = join(temp.dir, 'data');
  const env = envFor(temp.dir);
  const backupFile = join(temp.dir, 'ai.livememory');
  const server = await start(data, env);
  try {
    const sessionId = await seed(server);
    const backupFilePromise = createBackup({
      db: server.db,
      paths: server.paths,
      settings: server.settings.get(),
      file: backupFile,
      appVersion: 'test'
    });
    const importPromise = importSessionAnalysis({
      db: server.db,
      sessionId,
      exportsDir: server.paths.exports
    });
    const [backup] = await Promise.all([backupFilePromise, importPromise]);
    assert.ok(existsSync(backup.file));
    const summary = await inspectBackup({file: backup.file});
    assert.equal(summary.verified, true);
    assert.equal(integrityOk(server.db), true);
    assert.ok(count(server.db, 'ai_results') >= 2);
  } finally {
    await server.close();
    temp.cleanup();
  }
});
