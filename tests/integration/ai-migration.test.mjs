import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase, closeDatabase} from '../../src/storage/database/connection.mjs';
import {
  MIGRATIONS,
  currentSchemaVersion,
  migrate
} from '../../src/storage/database/migrations/index.mjs';
import {createSession} from '../../src/storage/repositories/sessions.mjs';
import {getSession} from '../../src/storage/repositories/sessions.mjs';

const T = Date.parse('2026-11-08T00:00:00.000Z');

function databaseAtVersion(version) {
  const db = openDatabase({memory: true});
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
  for (const migration of MIGRATIONS.filter((item) => item.version <= version).sort((a, b) => a.version - b.version)) {
    db.exec('BEGIN IMMEDIATE');
    migration.up(db);
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
      .run(migration.version, migration.name, T);
    db.exec('COMMIT');
  }
  return db;
}

test('a schema v7 database upgrades to v8 without losing sessions or package provenance', () => {
  const db = databaseAtVersion(7);
  assert.equal(currentSchemaVersion(db), 7);
  const session = createSession(db, {
    platform: 'mock',
    roomTitle: 'Old package session',
    storageMode: 'compact',
    sourceQuality: 'mock',
    simulated: true,
    startedAt: T
  });
  db.prepare(`
    INSERT INTO ai_packages (id, session_id, kind, protocol_version, locale, file_name, relative_path, checksum, message_count, created_at)
    VALUES ('pkg_old', ?, 'analysis', 'livememory-analysis-v1', 'en', 'old.zip', 'old.zip', 'abc', 5, ?)
  `).run(session.id, T);
  const columnsBefore = db.prepare('PRAGMA table_info(ai_packages)').all().map((row) => row.name);
  assert.ok(!columnsBefore.includes('job_id'));

  const result = migrate(db, {now: T + 1000});
  assert.deepEqual(result.applied, [8, 9, 10]);
  assert.equal(currentSchemaVersion(db), 10);

  const columnsAfter = db.prepare('PRAGMA table_info(ai_packages)').all().map((row) => row.name);
  for (const column of ['job_id', 'batch_index', 'stage', 'prompt_version']) {
    assert.ok(columnsAfter.includes(column), `missing column ${column}`);
  }
  const old = db.prepare('SELECT * FROM ai_packages WHERE id = ?').get('pkg_old');
  assert.equal(old.job_id, null);
  assert.equal(old.batch_index, null);
  assert.equal(old.stage, 'single');
  assert.equal(old.checksum, 'abc');

  for (const table of ['ai_jobs', 'ai_job_batches', 'ai_job_messages', 'ai_job_viewers', 'ai_results', 'ai_result_evidence']) {
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    assert.ok(exists, `missing table ${table}`);
  }
  assert.equal(getSession(db, session.id).room_title, 'Old package session');
  closeDatabase(db);
});

test('a fresh database starts at the current schema and AI results cascade with their session', () => {
  const db = openDatabase({memory: true});
  migrate(db);
  assert.equal(currentSchemaVersion(db), 10);
  db.prepare(`
    INSERT INTO sessions (id, platform, status, storage_mode, started_at, created_at, updated_at)
    VALUES ('ses_cascade', 'mock', 'ended', 'compact', ?, ?, ?)
  `).run(T, T, T);
  db.prepare(`
    INSERT INTO ai_jobs (id, session_id, kind, locale, prompt_version, protocol_version, batch_total, max_messages, total_messages, created_at, updated_at)
    VALUES ('aij_cascade', 'ses_cascade', 'session_analysis', 'en', 'p', 'v', 1, 1000, 1, ?, ?)
  `).run(T, T);
  db.prepare(`
    INSERT INTO ai_job_batches (job_id, batch_index, batch_id, task_id, from_seq, to_seq, message_count, checksum, created_at)
    VALUES ('aij_cascade', 1, 'b1', 't1', 1, 1, 1, 'c', ?)
  `).run(T);
  db.prepare(`
    INSERT INTO ai_results (id, job_id, session_id, scope_key, batch_index, task_id, task_kind, protocol_version, schema_version, locale, checksum, result_version, source, result_json, imported_at)
    VALUES ('air_cascade', 'aij_cascade', 'ses_cascade', 'batch:1', 1, 't1', 'session_analysis', 'p', '1.1.0', 'en', 'sum', 1, 'paste', '{}', ?)
  `).run(T);
  db.prepare(`
    INSERT INTO ai_result_evidence (result_id, section, item_index, seq, batch_index, event_id, available)
    VALUES ('air_cascade', 'topics', 0, 1, 1, NULL, 1)
  `).run();
  db.prepare("DELETE FROM sessions WHERE id = 'ses_cascade'").run();
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM ai_jobs').get().c), 0);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM ai_job_batches').get().c), 0);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM ai_results').get().c), 0);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM ai_result_evidence').get().c), 0);
  closeDatabase(db);
});
