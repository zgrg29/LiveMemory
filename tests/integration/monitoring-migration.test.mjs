import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase, withTransaction} from '../../src/storage/database/connection.mjs';
import {currentSchemaVersion, migrate, MIGRATIONS} from '../../src/storage/database/migrations/index.mjs';
import {getSession} from '../../src/storage/repositories/sessions.mjs';
import {upsertBroadcaster} from '../../src/storage/repositories/broadcasters.mjs';
import {createMonitorTarget, listMonitorTargets} from '../../src/storage/repositories/monitor-targets.mjs';

const T0 = Date.parse('2026-11-10T10:00:00.000Z');

function buildVersion10Database() {
  const db = openDatabase({memory: true});
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
  const record = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');
  for (const migration of MIGRATIONS.filter((entry) => entry.version <= 10).sort((a, b) => a.version - b.version)) {
    withTransaction(db, () => {
      migration.up(db);
      record.run(migration.version, migration.name, T0);
    });
  }
  return db;
}

test('a v10 database upgrades to v11 keeping existing broadcasts unchanged', () => {
  const db = buildVersion10Database();
  try {
    assert.equal(currentSchemaVersion(db), 10);
    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'monitor_targets'").get(),
      undefined
    );
    // Use raw SQL: the current helper already writes the v11 column.
    upsertBroadcaster(db, {
      id: 'youtube:UC_OLD_CHANNEL',
      platform: 'youtube',
      platformUid: 'UC_OLD_CHANNEL',
      displayName: 'Old channel',
      identity: 'verified',
      seenAt: T0,
      now: T0
    });
    db.prepare(`
      INSERT INTO sessions (
        id, platform, platform_room_id, room_title, broadcaster_name, broadcaster_id,
        broadcaster_identity, status, storage_mode, source_quality, simulated,
        started_at, platform_started_at, ended_at, last_event_at,
        message_count, gift_event_count, payment_event_count, ai_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'live', 'full', 'verified', 0, ?, NULL, NULL, NULL, 0, 0, 0, 'none', ?, ?)
    `).run(
      'ses_v10_history',
      'youtube',
      'old-video',
      'old stream',
      'Old channel',
      'youtube:UC_OLD_CHANNEL',
      'verified',
      T0,
      T0,
      T0
    );
    const session = getSession(db, 'ses_v10_history');

    const result = migrate(db, {now: T0 + 1000});
    assert.equal(result.from, 10);
    assert.equal(result.to, 15);
    assert.deepEqual(result.applied, [11, 12, 13, 14, 15]);

    const columns = db.prepare('PRAGMA table_info(sessions)').all().map((row) => row.name);
    assert.ok(columns.includes('monitor_target_id'));
    const row = getSession(db, session.id);
    assert.equal(row.monitor_target_id, null);
    assert.equal(row.room_title, 'old stream');
    assert.equal(row.status, 'live');

    const target = createMonitorTarget(db, {
      platform: 'youtube',
      targetKey: 'UC_MIGRATED',
      displayName: 'Channel',
      broadcasterId: 'youtube:UC_MIGRATED',
      nextCheckAt: T0,
      now: T0
    });
    assert.equal(target.platform, 'youtube');
    assert.equal(target.enabled, 1);
    assert.equal(listMonitorTargets(db).length, 1);

    // One target per platform + key.
    assert.throws(() => createMonitorTarget(db, {
      platform: 'youtube',
      targetKey: 'UC_MIGRATED',
      now: T0
    }));

    // Re-running the migration is a no-op (no column/table duplication).
    const again = migrate(db, {now: T0 + 2000});
    assert.equal(again.from, 15);
    assert.equal(again.to, 15);
    assert.deepEqual(again.applied, []);
    assert.equal(listMonitorTargets(db).length, 1);
  } finally {
    db.close();
  }
});

test('a fresh database is created directly at v15', () => {
  const db = openDatabase({memory: true});
  try {
    const result = migrate(db, {now: T0});
    assert.equal(result.from, 0);
    assert.equal(result.to, 15);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'monitor_targets'").get());
    assert.ok(db.prepare('PRAGMA table_info(sessions)').all().some((row) => row.name === 'monitor_target_id'));
  } finally {
    db.close();
  }
});
