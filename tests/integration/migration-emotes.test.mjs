import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase, closeDatabase} from '../../src/storage/database/connection.mjs';
import {currentSchemaVersion, migrate, MIGRATIONS} from '../../src/storage/database/migrations/index.mjs';
import {createSession} from '../../src/storage/repositories/sessions.mjs';
import {listEvents} from '../../src/storage/repositories/events.mjs';
import {EventIngest} from '../../src/platforms/shared/ingest.mjs';

const T = Date.parse('2026-11-08T10:00:00.000Z');

function v1Database() {
  const db = openDatabase({memory: true});
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
  const initial = MIGRATIONS.find((migration) => migration.version === 1);
  db.exec('BEGIN IMMEDIATE');
  initial.up(db);
  db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
    .run(1, initial.name, T);
  db.exec('COMMIT');
  return db;
}

test('schema v1 databases upgrade to v2 without losing old messages', () => {
  const db = v1Database();
  assert.equal(currentSchemaVersion(db), 1);
  const columnsBefore = db.prepare('PRAGMA table_info(events)').all().map((row) => row.name);
  assert.ok(!columnsBefore.includes('emotes'));

  const session = createSession(db, {
    platform: 'bilibili',
    roomTitle: 'Old database',
    storageMode: 'compact',
    sourceQuality: 'estimated',
    simulated: false,
    startedAt: T
  });
  // Simulate a row written by the old application (no emotes column).
  db.prepare(`
    INSERT INTO events (
      session_id, platform, external_id, event_type, viewer_id, viewer_uid, display_name,
      occurred_at, received_at, content, gift_quantity, value_kind, is_paid, source_quality, dedupe_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    session.id, 'bilibili', 'old-1', 'chat', null, null, '旧观众',
    T, T, '旧消息😂', 1, 'unknown', 0, 'unknown', 'ext:old-1'
  );

  const result = migrate(db, {now: T + 1000});
  assert.deepEqual(result.applied, [2]);
  assert.equal(currentSchemaVersion(db), 2);
  const columnsAfter = db.prepare('PRAGMA table_info(events)').all().map((row) => row.name);
  assert.ok(columnsAfter.includes('emotes'));

  const oldRows = listEvents(db, {sessionId: session.id});
  assert.equal(oldRows.length, 1);
  assert.equal(oldRows[0].content, '旧消息😂');
  assert.equal(oldRows[0].emotes, null);

  // The upgraded schema accepts new emote metadata.
  const ingest = new EventIngest({db});
  ingest.record({
    platform: 'bilibili',
    session_id: session.id,
    event_type: 'chat',
    viewer_uid: '42',
    display_name: '新观众',
    external_id: 'new-1',
    occurred_at: T + 2000,
    content: '就这',
    emotes: [{id: 'room_5050_96171', name: '就这', source: 'bilibili.info13'}]
  });
  const rows = listEvents(db, {sessionId: session.id});
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.find((row) => row.external_id === 'new-1').emotes, [{
    id: 'room_5050_96171',
    name: '就这',
    source: 'bilibili.info13'
  }]);
  closeDatabase(db);
});
