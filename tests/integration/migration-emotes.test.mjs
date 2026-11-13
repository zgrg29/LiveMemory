import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase, closeDatabase} from '../../src/storage/database/connection.mjs';
import {currentSchemaVersion, migrate, MIGRATIONS} from '../../src/storage/database/migrations/index.mjs';
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

test('schema v1 databases upgrade to the current schema without losing old messages', () => {
  const db = v1Database();
  assert.equal(currentSchemaVersion(db), 1);
  const columnsBefore = db.prepare('PRAGMA table_info(events)').all().map((row) => row.name);
  assert.ok(!columnsBefore.includes('emotes'));
  const sessionColumnsBefore = db.prepare('PRAGMA table_info(sessions)').all().map((row) => row.name);
  assert.ok(!sessionColumnsBefore.includes('platform_started_at'));

  // Simulate a session and event written by the old application (v1 schema has
  // no `platform_started_at`, no `emotes`).
  const sessionId = 'ses_old_database';
  db.prepare(`
    INSERT INTO sessions (
      id, platform, platform_room_id, room_title, broadcaster_name, status,
      storage_mode, source_quality, simulated, started_at, ended_at, last_event_at,
      message_count, gift_event_count, payment_event_count, ai_status, created_at, updated_at
    ) VALUES (?, 'bilibili', NULL, 'Old database', NULL, 'live', 'compact', 'estimated', 0, ?, NULL, NULL, 0, 0, 0, 'none', ?, ?)
  `).run(sessionId, T, T, T);
  const session = {id: sessionId};
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
  // v2 added emote metadata, v3 the platform broadcast start time, v4 author
  // badges and the raw displayed amount, v5 broadcaster identity and the
  // broadcaster × viewer context, v6 the session leaderboard index, v7 archive
  // state, end reason and the history/search indexes, v8 AI jobs/results,
  // v9 platform live status, v10 long-term viewer memory, v11 persistent
  // automatic-monitoring targets.
  assert.deepEqual(result.applied, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  assert.equal(currentSchemaVersion(db), 14);
  const columnsAfter = db.prepare('PRAGMA table_info(events)').all().map((row) => row.name);
  assert.ok(columnsAfter.includes('emotes'));
  assert.ok(columnsAfter.includes('badges'));
  assert.ok(columnsAfter.includes('amount_display'));
  const sessionColumnsAfter = db.prepare('PRAGMA table_info(sessions)').all().map((row) => row.name);
  assert.ok(sessionColumnsAfter.includes('platform_started_at'));
  assert.ok(sessionColumnsAfter.includes('broadcaster_id'));
  assert.ok(sessionColumnsAfter.includes('broadcaster_identity'));
  assert.ok(sessionColumnsAfter.includes('archived_at'));
  assert.ok(sessionColumnsAfter.includes('end_reason'));
  // Old rows are not archived and have no invented end reason.
  const archivedDefaults = db.prepare('SELECT archived_at, end_reason FROM sessions WHERE id = ?').get(sessionId);
  assert.equal(archivedDefaults.archived_at, null);
  assert.equal(archivedDefaults.end_reason, null);
  // This old row has no room id, so it must stay unresolved rather than being
  // guessed into a broadcaster.
  const oldSession = db.prepare('SELECT broadcaster_id, broadcaster_identity FROM sessions WHERE id = ?').get(sessionId);
  assert.equal(oldSession.broadcaster_id, null);
  assert.equal(oldSession.broadcaster_identity, 'unresolved');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  assert.ok(tables.includes('broadcasters'));
  assert.ok(tables.includes('viewer_broadcasters'));
  assert.ok(tables.includes('viewer_broadcaster_currency_totals'));

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
