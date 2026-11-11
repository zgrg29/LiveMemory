import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase, withTransaction} from '../../src/storage/database/connection.mjs';
import {currentSchemaVersion, migrate, MIGRATIONS} from '../../src/storage/database/migrations/index.mjs';
import {createSession, getSession} from '../../src/storage/repositories/sessions.mjs';
import {upsertBroadcaster} from '../../src/storage/repositories/broadcasters.mjs';
import {EventIngest} from '../../src/platforms/shared/ingest.mjs';

const T0 = Date.parse('2026-11-10T10:00:00.000Z');

function buildVersion9Database() {
  const db = openDatabase({memory: true});
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
  const record = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');
  for (const migration of MIGRATIONS.filter((entry) => entry.version <= 9).sort((a, b) => a.version - b.version)) {
    withTransaction(db, () => {
      migration.up(db);
      record.run(migration.version, migration.name, T0);
    });
  }
  return db;
}

test('a v9 database upgrades to v10 keeping every existing row', () => {
  const db = buildVersion9Database();
  try {
    assert.equal(currentSchemaVersion(db), 9);
    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'viewer_memories'").get(),
      undefined
    );

    upsertBroadcaster(db, {
      id: 'youtube:UC_MIGRATION',
      platform: 'youtube',
      platformUid: 'UC_MIGRATION',
      displayName: 'Migration channel',
      identity: 'verified',
      seenAt: T0,
      now: T0
    });
    const session = createSession(db, {
      id: 'ses_v9_history',
      platform: 'youtube',
      platformRoomId: 'video-1',
      roomTitle: 'old stream',
      broadcasterName: 'Migration channel',
      broadcasterId: 'youtube:UC_MIGRATION',
      broadcasterIdentity: 'verified',
      storageMode: 'full',
      startedAt: T0,
      now: T0
    });
    new EventIngest({db}).record({
      session_id: session.id,
      platform: 'youtube',
      event_type: 'chat',
      viewer_uid: 'UC_OLD_VIEWER',
      display_name: 'Old Viewer',
      occurred_at: T0 + 1000,
      content: 'hello from v9',
      external_id: 'v9-msg-1'
    });

    const result = migrate(db, {now: T0 + 1000});
    assert.equal(result.from, 9);
    assert.equal(result.to, 13);
    assert.deepEqual(result.applied, [10, 11, 12, 13]);

    for (const table of [
      'viewer_memories',
      'memory_facts',
      'memory_fact_evidence',
      'memory_versions',
      'memory_jobs',
      'memory_job_batches',
      'memory_job_messages',
      'memory_job_viewers',
      'memory_results'
    ]) {
      assert.ok(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
        `missing ${table}`
      );
    }

    // Existing data is untouched and no memory was invented for old viewers.
    const row = getSession(db, session.id);
    assert.equal(row.room_title, 'old stream');
    assert.equal(row.message_count, 1);
    assert.equal(
      Number(db.prepare('SELECT COUNT(*) AS count FROM viewers').get().count),
      1
    );
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM viewer_memories').get().count), 0);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM memory_facts').get().count), 0);

    // The partial unique index only prevents duplicates among live facts.
    const index = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_memory_facts_dedupe'").get();
    assert.match(index.sql, /WHERE status <> 'superseded'/);

    assert.deepEqual(migrate(db, {now: T0 + 2000}), {from: 13, to: 13, applied: []});
  } finally {
    db.close();
  }
});

test('a fresh database creates the full schema at version 13', () => {
  const db = openDatabase({memory: true});
  try {
    const result = migrate(db, {now: T0});
    assert.equal(result.from, 0);
    assert.equal(result.to, 13);
    assert.deepEqual(result.applied, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    assert.equal(currentSchemaVersion(db), 13);
  } finally {
    db.close();
  }
});
