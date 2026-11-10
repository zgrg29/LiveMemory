import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase, withTransaction} from '../../src/storage/database/connection.mjs';
import {
  currentSchemaVersion,
  migrate,
  MIGRATIONS
} from '../../src/storage/database/migrations/index.mjs';
import {createSession, getSession} from '../../src/storage/repositories/sessions.mjs';

const T0 = Date.parse('2026-11-09T10:00:00.000Z');

function buildVersion8Database() {
  const db = openDatabase({memory: true});
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
  const record = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');
  for (const migration of MIGRATIONS.filter((entry) => entry.version <= 8).sort((a, b) => a.version - b.version)) {
    withTransaction(db, () => {
      migration.up(db);
      record.run(migration.version, migration.name, T0);
    });
  }
  return db;
}

test('v8 databases upgrade to v9 without rewriting history', () => {
  const db = buildVersion8Database();
  try {
    assert.equal(currentSchemaVersion(db), 8);
    assert.equal(
      db.prepare('PRAGMA table_info(sessions)').all().some((column) => column.name === 'platform_status'),
      false
    );

    const session = createSession(db, {
      id: 'ses_v8_history',
      platform: 'bilibili',
      platformRoomId: '8801',
      roomTitle: 'v8 history',
      broadcasterIdentity: 'room_fallback',
      startedAt: T0 - 10000,
      now: T0 - 10000
    });
    db.prepare(`
      UPDATE sessions
         SET status = 'interrupted', ended_at = ?, end_reason = 'shutdown',
             message_count = 7, last_event_at = ?
       WHERE id = ?
    `).run(T0 - 2000, T0 - 5000, session.id);

    const result = migrate(db, {now: T0});
    assert.equal(result.from, 8);
    assert.equal(result.to, 9);
    assert.deepEqual(result.applied, [9]);

    const columns = db.prepare('PRAGMA table_info(sessions)').all().map((column) => column.name);
    for (const name of [
      'platform_status',
      'platform_status_at',
      'last_live_seen_at',
      'platform_ended_at',
      'platform_end_quality'
    ]) {
      assert.ok(columns.includes(name), `missing ${name}`);
    }
    assert.ok(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_sessions_platform_status'").get(),
      'missing platform status index'
    );

    const row = getSession(db, session.id);
    assert.equal(row.status, 'interrupted');
    assert.equal(row.end_reason, 'shutdown');
    assert.equal(row.ended_at, T0 - 2000);
    assert.equal(row.last_event_at, T0 - 5000);
    assert.equal(row.message_count, 7);
    // Old rows stay NULL: no guessed platform state and no guessed end time.
    assert.equal(row.platform_status, null);
    assert.equal(row.platform_status_at, null);
    assert.equal(row.last_live_seen_at, null);
    assert.equal(row.platform_ended_at, null);
    assert.equal(row.platform_end_quality, null);

    // Re-running the migration is a no-op.
    assert.deepEqual(migrate(db, {now: T0 + 1000}), {from: 9, to: 9, applied: []});
  } finally {
    db.close();
  }
});

test('a fresh database creates schema 9 directly', () => {
  const db = openDatabase({memory: true});
  try {
    const result = migrate(db, {now: T0});
    assert.equal(result.from, 0);
    assert.equal(result.to, 9);
    assert.deepEqual(result.applied, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  } finally {
    db.close();
  }
});
