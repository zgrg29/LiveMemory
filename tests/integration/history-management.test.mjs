import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {openDatabase, closeDatabase} from '../../src/storage/database/connection.mjs';
import {currentSchemaVersion, migrate} from '../../src/storage/database/migrations/index.mjs';
import {
  createSession,
  endSession,
  getSession,
  listSessions,
  setSessionArchived
} from '../../src/storage/repositories/sessions.mjs';
import {upsertBroadcaster} from '../../src/storage/repositories/broadcasters.mjs';
import {insertPackage} from '../../src/storage/repositories/ai-packages.mjs';
import {EventIngest} from '../../src/platforms/shared/ingest.mjs';
import {SessionManager} from '../../src/platforms/shared/session-manager.mjs';
import {
  archiveSession,
  deleteSessionRecord,
  stopSessionRecording
} from '../../src/server/session-admin.mjs';
import {searchHistory} from '../../src/analytics/sessions/history-search.mjs';
import {createTempDir} from '../helpers/temp-dir.mjs';

/**
 * Session management: stop one capture, archive/unarchive, permanent delete.
 *
 * These are automated SQLite/HTTP-independent tests against the real schema,
 * repositories and ingest pipeline. No platform network is involved.
 */

const T0 = Date.parse('2026-11-09T10:00:00.000Z');
const HOUR = 3600 * 1000;
const settings = {get: () => ({storageMode: 'compact'})};

class FakeAdapter {
  constructor(name) {
    this.name = name;
    this.handlers = null;
    this.stopped = 0;
  }

  async start(context) {
    this.handlers = context;
    context.onStateChange?.({state: 'connected', detail: {fake: this.name}});
  }

  emit(draft) {
    this.handlers?.onEvent?.(draft);
  }

  async stop() {
    this.stopped += 1;
  }

  snapshot() {
    return {id: this.name, state: 'stopped'};
  }
}

function freshDb() {
  const db = openDatabase({memory: true});
  migrate(db, {now: T0});
  return db;
}

function broadcaster(db, platform, uid, name) {
  const id = `${platform}:${uid}`;
  upsertBroadcaster(db, {
    id,
    platform,
    platformUid: uid,
    displayName: name,
    identity: 'verified',
    seenAt: T0,
    now: T0
  });
  return id;
}

function openSession(db, {
  id = null,
  platform = 'youtube',
  roomId,
  title,
  broadcasterName = null,
  broadcasterId = null,
  startedAt = T0
}) {
  return createSession(db, {
    id,
    platform,
    platformRoomId: roomId,
    roomTitle: title,
    broadcasterName,
    broadcasterId,
    broadcasterIdentity: broadcasterId ? 'verified' : 'unresolved',
    startedAt,
    now: startedAt
  });
}

function chat(db, session, {
  platform = session.platform,
  uid,
  name = `viewer-${uid}`,
  content = 'hello',
  at = T0 + 1000,
  externalId
}) {
  const ingest = new EventIngest({db, now: () => at});
  return ingest.record({
    session_id: session.id,
    platform,
    event_type: 'chat',
    viewer_uid: uid,
    display_name: name,
    occurred_at: at,
    content,
    external_id: externalId ?? `${session.id}:${uid}:${at}`
  });
}

function superChat(db, session, {uid, name, amount = 500, at = T0 + 1500, externalId}) {
  const ingest = new EventIngest({db, now: () => at});
  return ingest.record({
    session_id: session.id,
    platform: session.platform,
    event_type: 'super_chat',
    viewer_uid: uid,
    display_name: name,
    occurred_at: at,
    content: 'super chat text',
    amount_minor: amount,
    currency: 'CNY',
    value_kind: 'actual',
    is_paid: true,
    external_id: externalId ?? `${session.id}:sc:${at}`
  });
}

function count(db, sql, ...params) {
  return Number(db.prepare(sql).get(...params)?.count ?? 0);
}

function depsFor(db, {manager = null, exportsDir = null} = {}) {
  return {
    db,
    sessionManager: manager ?? {getRecording: () => null},
    logger: null,
    paths: exportsDir ? {exports: exportsDir} : null
  };
}

test('stopping one of three recordings leaves the other two running and creates a new session later', async () => {
  const db = freshDb();
  const manager = new SessionManager({db, settings, now: () => T0});
  const start = async (name, platform, roomId, channel) => {
    const adapter = new FakeAdapter(name);
    const result = await manager.startPlatform({
      platform,
      platformRoomId: roomId,
      roomTitle: `${name} live`,
      broadcasterName: `Channel ${name}`,
      broadcasterUid: channel,
      sourceQuality: 'verified',
      createAdapter: () => adapter
    });
    assert.equal(result.started, true);
    return {session: result.session, adapter};
  };
  const a = await start('a', 'youtube', 'video-a', 'UC_A');
  const b = await start('b', 'bilibili', '5050', '9001');
  const c = await start('c', 'youtube', 'video-c', 'UC_C');
  for (let index = 0; index < 3; index += 1) {
    a.adapter.emit({platform: 'youtube', event_type: 'chat', viewer_uid: 'UC_S', display_name: 'S', occurred_at: T0 + 1000 + index, content: `a${index}`, external_id: `a-${index}`});
  }
  b.adapter.emit({platform: 'bilibili', event_type: 'chat', viewer_uid: '7001', display_name: 'B', occurred_at: T0 + 1000, content: 'b1', external_id: 'b-1'});
  c.adapter.emit({platform: 'youtube', event_type: 'chat', viewer_uid: 'UC_CV', display_name: 'C', occurred_at: T0 + 1000, content: 'c1', external_id: 'c-1'});

  const stopped = await stopSessionRecording({deps: {db, sessionManager: manager}, sessionId: a.session.id});
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.session.status, 'ended');
  assert.equal(stopped.session.end_reason, 'user');
  assert.equal(stopped.session.ended_at, T0);
  assert.equal(manager.listRecordings().length, 2);
  assert.deepEqual(
    manager.listRecordings().map((recording) => recording.sessionId).sort(),
    [b.session.id, c.session.id].sort()
  );
  // Everything already captured is kept.
  assert.equal(count(db, 'SELECT COUNT(*) AS count FROM events WHERE session_id = ?', a.session.id), 3);
  assert.equal(count(db, 'SELECT COUNT(*) AS count FROM viewer_sessions WHERE session_id = ?', a.session.id), 1);
  // A stopped adapter can no longer write, and the other recordings keep going.
  a.adapter.emit({platform: 'youtube', event_type: 'chat', viewer_uid: 'UC_S', display_name: 'S', occurred_at: T0 + 5000, content: 'late', external_id: 'a-late'});
  assert.equal(count(db, 'SELECT COUNT(*) AS count FROM events WHERE session_id = ?', a.session.id), 3);
  b.adapter.emit({platform: 'bilibili', event_type: 'chat', viewer_uid: '7001', display_name: 'B', occurred_at: T0 + 5000, content: 'b2', external_id: 'b-2'});
  assert.equal(count(db, 'SELECT COUNT(*) AS count FROM events WHERE session_id = ?', b.session.id), 2);
  assert.equal(manager.getRecording(c.session.id)?.sessionId, c.session.id);

  // Stopping an already stopped session is an error, not a silent success.
  await assert.rejects(
    () => stopSessionRecording({deps: {db, sessionManager: manager}, sessionId: a.session.id}),
    (error) => error.code === 'SESSION_NOT_ACTIVE'
  );

  // Restarting the same room creates a brand-new session; the old one is not
  // reopened or written into.
  const again = await manager.startPlatform({
    platform: 'youtube',
    platformRoomId: 'video-a',
    roomTitle: 'a live again',
    broadcasterName: 'Channel a',
    broadcasterUid: 'UC_A',
    sourceQuality: 'verified',
    createAdapter: () => new FakeAdapter('a2')
  });
  assert.equal(again.started, true);
  assert.notEqual(again.session.id, a.session.id);
  assert.equal(getSession(db, a.session.id).status, 'ended');
  assert.equal(getSession(db, again.session.id).status, 'live');
  await manager.shutdown();
  closeDatabase(db);
});

test('archive is a persisted management flag, hidden by default and independent of status', async () => {
  const temp = createTempDir();
  const file = join(temp.dir, 'database', 'livememory.db');
  let db = openDatabase({file});
  migrate(db, {now: T0});
  const broadcasterId = broadcaster(db, 'youtube', 'UC_ARCHIVE', 'Archive Channel');
  const session = openSession(db, {
    platform: 'youtube',
    roomId: 'archive-video',
    title: 'Archive me',
    broadcasterName: 'Archive Channel',
    broadcasterId
  });
  chat(db, session, {uid: 'UC_1', name: 'One'});
  endSession(db, session.id, {status: 'ended', endedAt: T0 + 1000, reason: 'adapter_end'});
  const initialVersion = currentSchemaVersion(db);
  assert.equal(initialVersion, 10);

  const archived = archiveSession({db, sessionId: session.id, archived: true, now: T0 + 5000});
  assert.equal(archived.archived_at, T0 + 5000);
  assert.equal(archived.status, 'ended');
  assert.equal(archived.end_reason, 'adapter_end');
  // Idempotent.
  const again = archiveSession({db, sessionId: session.id, archived: true, now: T0 + 6000});
  assert.equal(again.archived_at, archived.archived_at);

  assert.equal(listSessions(db, {includeArchived: false}).length, 0);
  assert.equal(listSessions(db, {archivedOnly: true}).length, 1);
  assert.equal(listSessions(db, {includeArchived: true}).length, 1);
  assert.equal(searchHistory(db, {}).total, 0);
  assert.equal(searchHistory(db, {includeArchived: true}).total, 1);

  closeDatabase(db);
  db = openDatabase({file});
  migrate(db, {now: T0 + 2000});
  assert.equal(getSession(db, session.id).archived_at, archived.archived_at);

  const restored = archiveSession({db, sessionId: session.id, archived: false});
  assert.equal(restored.archived_at, null);
  assert.equal(searchHistory(db, {}).total, 1);

  // A live capture cannot be archived, even if the API is called directly.
  const live = openSession(db, {
    platform: 'bilibili',
    roomId: '9999',
    title: 'Live now',
    broadcasterName: 'Live',
    broadcasterId: broadcaster(db, 'bilibili', '9999', 'Live')
  });
  assert.throws(
    () => archiveSession({db, sessionId: live.id, archived: true}),
    (error) => error.code === 'SESSION_ARCHIVE_LIVE'
  );
  // A still-registered recording is refused too, even if the row says ended.
  assert.throws(
    () => archiveSession({
      db,
      sessionId: session.id,
      archived: true,
      manager: {getRecording: () => ({sessionId: session.id})}
    }),
    (error) => error.code === 'SESSION_ARCHIVE_LIVE'
  );
  closeDatabase(db);
  temp.cleanup();
});

test('permanent delete removes only session-scoped data, keeps shared viewers and other broadcasters', async () => {
  const temp = createTempDir();
  const exportsDir = join(temp.dir, 'exports');
  const db = freshDb();
  const b1 = broadcaster(db, 'youtube', 'UC_B1', 'Broadcaster One');
  const b2 = broadcaster(db, 'youtube', 'UC_B2', 'Broadcaster Two');
  const b3 = broadcaster(db, 'youtube', 'UC_B3', 'Broadcaster Only D');
  const a = openSession(db, {platform: 'youtube', roomId: 'v-a', title: 'A session', broadcasterName: 'Broadcaster One', broadcasterId: b1, startedAt: T0});
  const b = openSession(db, {platform: 'youtube', roomId: 'v-b', title: 'B session', broadcasterName: 'Broadcaster One', broadcasterId: b1, startedAt: T0 + HOUR});
  const c = openSession(db, {platform: 'youtube', roomId: 'v-c', title: 'C session', broadcasterName: 'Broadcaster Two', broadcasterId: b2, startedAt: T0 + 2 * HOUR});
  const d = openSession(db, {platform: 'youtube', roomId: 'v-d', title: 'D session', broadcasterName: 'Broadcaster Only D', broadcasterId: b3, startedAt: T0 + 3 * HOUR});

  chat(db, a, {uid: 'SHARED', name: 'Shared Viewer', at: T0 + 10, externalId: 'a-s1'});
  chat(db, a, {uid: 'SHARED', name: 'Shared Viewer', at: T0 + 20, externalId: 'a-s2'});
  superChat(db, a, {uid: 'SHARED', name: 'Shared Viewer', at: T0 + 30, externalId: 'a-sc'});
  chat(db, a, {uid: 'ONLY_A', name: 'Only A', at: T0 + 40, externalId: 'a-u1'});
  chat(db, b, {uid: 'SHARED', name: 'Shared Viewer', at: T0 + HOUR + 10, externalId: 'b-s1'});
  chat(db, b, {uid: 'ONLY_B', name: 'Only B', at: T0 + HOUR + 20, externalId: 'b-u1'});
  chat(db, c, {uid: 'SHARED', name: 'Shared Viewer', at: T0 + 2 * HOUR + 10, externalId: 'c-s1'});
  chat(db, d, {uid: 'ONLY_D', name: 'Only D', at: T0 + 3 * HOUR + 10, externalId: 'd-u1'});
  for (const session of [a, b, c, d]) {
    endSession(db, session.id, {status: 'ended', endedAt: session.started_at + 1000, reason: 'adapter_end'});
  }

  mkdirSync(exportsDir, {recursive: true});
  writeFileSync(join(exportsDir, 'a-package.zip'), 'a');
  writeFileSync(join(exportsDir, 'b-package.zip'), 'b');
  insertPackage(db, {
    id: 'pkg_a', sessionId: a.id, protocolVersion: 'livememory-analysis-v1', locale: 'en',
    fileName: 'a-package.zip', relativePath: 'a-package.zip', checksum: 'x', messageCount: 3, createdAt: T0
  });
  insertPackage(db, {
    id: 'pkg_b', sessionId: b.id, protocolVersion: 'livememory-analysis-v1', locale: 'en',
    fileName: 'b-package.zip', relativePath: 'b-package.zip', checksum: 'x', messageCount: 1, createdAt: T0
  });

  const result = await deleteSessionRecord({
    deps: depsFor(db, {exportsDir}),
    sessionId: a.id,
    confirm: true
  });
  assert.equal(result.deleted, true);
  assert.equal(result.before.events, 4);
  assert.equal(result.before.viewers, 2);
  assert.equal(result.packagesRemoved, 1);
  assert.equal(result.removedFiles.length, 1);
  assert.equal(existsSync(join(exportsDir, 'a-package.zip')), false);
  assert.equal(readFileSync(join(exportsDir, 'b-package.zip'), 'utf8'), 'b');

  assert.equal(getSession(db, a.id), null);
  assert.equal(count(db, 'SELECT COUNT(*) AS count FROM events WHERE session_id = ?', a.id), 0);
  assert.equal(count(db, 'SELECT COUNT(*) AS count FROM viewer_sessions WHERE session_id = ?', a.id), 0);
  assert.equal(count(db, 'SELECT COUNT(*) AS count FROM ai_packages WHERE session_id = ?', a.id), 0);

  // The viewer that only existed in A is gone.
  assert.equal(db.prepare('SELECT id FROM viewers WHERE id = ?').get('youtube:ONLY_A'), undefined);
  // The shared viewer still exists with counts recomputed from B and C only.
  const shared = db.prepare('SELECT id, message_count, payment_event_count FROM viewers WHERE id = ?').get('youtube:SHARED');
  assert.equal(shared.message_count, 2);
  assert.equal(shared.payment_event_count, 0);
  assert.deepEqual(
    db.prepare('SELECT session_id FROM viewer_sessions WHERE viewer_id = ? ORDER BY session_id').all('youtube:SHARED')
      .map((row) => row.session_id).sort(),
    [b.id, c.id].sort()
  );
  const relations = db.prepare('SELECT broadcaster_id, message_count FROM viewer_broadcasters WHERE viewer_id = ? ORDER BY broadcaster_id').all('youtube:SHARED');
  assert.deepEqual(
    relations.map((row) => [row.broadcaster_id, row.message_count]).sort(),
    [[b1, 1], [b2, 1]].sort()
  );
  assert.equal(count(db, 'SELECT COUNT(*) AS count FROM viewer_currency_totals WHERE viewer_id = ?', 'youtube:SHARED'), 0);
  assert.equal(count(db, 'SELECT COUNT(*) AS count FROM viewer_broadcaster_currency_totals WHERE viewer_id = ?', 'youtube:SHARED'), 0);

  // Other sessions, broadcasters and their viewer profiles are untouched.
  assert.equal(getSession(db, b.id).status, 'ended');
  assert.equal(getSession(db, c.id).status, 'ended');
  assert.ok(db.prepare('SELECT id FROM broadcasters WHERE id = ?').get(b1));
  assert.ok(db.prepare('SELECT id FROM broadcasters WHERE id = ?').get(b2));
  assert.ok(db.prepare('SELECT id FROM viewers WHERE id = ?').get('youtube:ONLY_B'));

  // Nothing remains in search results or exported-package listings.
  assert.equal(searchHistory(db, {query: 'A session', includeArchived: true}).total, 0);
  assert.equal(searchHistory(db, {query: 'ONLY_A', includeArchived: true}).total, 0);
  assert.equal(searchHistory(db, {query: 'Shared Viewer', includeArchived: true}).total, 2);
  const packages = db.prepare('SELECT session_id FROM ai_packages').all().map((row) => row.session_id);
  assert.deepEqual(packages, [b.id]);

  // Deleting the only session of broadcaster D removes that derived broadcaster.
  await deleteSessionRecord({deps: depsFor(db, {exportsDir}), sessionId: d.id, confirm: true});
  assert.equal(db.prepare('SELECT id FROM broadcasters WHERE id = ?').get(b3), undefined);
  assert.equal(db.prepare('SELECT id FROM viewers WHERE id = ?').get('youtube:ONLY_D'), undefined);

  // A viewer explicitly marked important survives losing its only session,
  // with zeroed derived counters and no dangling relations.
  const e = openSession(db, {platform: 'youtube', roomId: 'v-e', title: 'E session', broadcasterName: 'Broadcaster One', broadcasterId: b1, startedAt: T0 + 4 * HOUR});
  chat(db, e, {uid: 'FOCUSED', name: 'Focused', at: T0 + 4 * HOUR + 10, externalId: 'e-1'});
  endSession(db, e.id, {status: 'ended', endedAt: T0 + 4 * HOUR + 1000});
  db.prepare('UPDATE viewers SET focused = 1 WHERE id = ?').run('youtube:FOCUSED');
  await deleteSessionRecord({deps: depsFor(db, {exportsDir}), sessionId: e.id, confirm: true});
  const focused = db.prepare('SELECT focused, message_count, payment_event_count FROM viewers WHERE id = ?').get('youtube:FOCUSED');
  assert.equal(focused.focused, 1);
  assert.equal(focused.message_count, 0);
  assert.equal(focused.payment_event_count, 0);
  assert.equal(count(db, 'SELECT COUNT(*) AS count FROM viewer_broadcasters WHERE viewer_id = ?', 'youtube:FOCUSED'), 0);

  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  closeDatabase(db);
  temp.cleanup();
});

test('delete guards: explicit confirmation, no live capture, no registered adapter', async () => {
  const db = freshDb();
  const broadcasterId = broadcaster(db, 'youtube', 'UC_GUARD', 'Guard');
  const live = openSession(db, {
    platform: 'youtube',
    roomId: 'guard-live',
    title: 'Guard live',
    broadcasterName: 'Guard',
    broadcasterId
  });
  // Confirmation is required before anything is even inspected.
  await assert.rejects(
    () => deleteSessionRecord({deps: depsFor(db), sessionId: live.id, confirm: false}),
    (error) => error.code === 'DELETE_CONFIRM_REQUIRED'
  );
  await assert.rejects(
    () => deleteSessionRecord({deps: depsFor(db), sessionId: live.id, confirm: true}),
    (error) => error.code === 'SESSION_STILL_RECORDING'
  );
  // Row says ended but the adapter is still registered: refuse as well.
  const ended = openSession(db, {
    platform: 'youtube',
    roomId: 'guard-ended',
    title: 'Guard ended',
    broadcasterName: 'Guard',
    broadcasterId,
    startedAt: T0 + HOUR
  });
  chat(db, ended, {uid: 'UC_G', name: 'G'});
  endSession(db, ended.id, {status: 'ended', endedAt: T0 + HOUR + 1000});
  await assert.rejects(
    () => deleteSessionRecord({
      deps: depsFor(db, {manager: {getRecording: () => ({sessionId: ended.id})}}),
      sessionId: ended.id,
      confirm: true
    }),
    (error) => error.code === 'SESSION_STILL_RECORDING'
  );
  assert.ok(getSession(db, ended.id));
  // After the capture is gone the same call succeeds.
  const result = await deleteSessionRecord({deps: depsFor(db), sessionId: ended.id, confirm: true});
  assert.equal(result.deleted, true);
  closeDatabase(db);
});

test('a database failure during delete rolls the whole transaction back', async () => {
  const db = freshDb();
  const broadcasterId = broadcaster(db, 'youtube', 'UC_ROLLBACK', 'Rollback');
  const session = openSession(db, {
    platform: 'youtube',
    roomId: 'rollback-video',
    title: 'Rollback session',
    broadcasterName: 'Rollback',
    broadcasterId
  });
  chat(db, session, {uid: 'UC_R', name: 'R', externalId: 'r-1'});
  superChat(db, session, {uid: 'UC_R', name: 'R', externalId: 'r-sc'});
  endSession(db, session.id, {status: 'ended', endedAt: T0 + 2000});
  const before = {
    events: count(db, 'SELECT COUNT(*) AS count FROM events WHERE session_id = ?', session.id),
    viewers: count(db, "SELECT COUNT(*) AS count FROM viewers WHERE id = 'youtube:UC_R'"),
    sessions: count(db, 'SELECT COUNT(*) AS count FROM viewer_sessions WHERE session_id = ?', session.id),
    totals: count(db, "SELECT COUNT(*) AS count FROM viewer_currency_totals WHERE viewer_id = 'youtube:UC_R'")
  };
  db.exec(`
    CREATE TRIGGER fail_session_delete
    BEFORE DELETE ON events
    WHEN old.session_id = '${session.id}'
    BEGIN
      SELECT RAISE(ABORT, 'simulated database failure');
    END;
  `);
  await assert.rejects(
    () => deleteSessionRecord({deps: depsFor(db), sessionId: session.id, confirm: true}),
    (error) => /simulated database failure|DATABASE/i.test(String(error?.message ?? error))
  );
  db.exec('DROP TRIGGER fail_session_delete');

  assert.ok(getSession(db, session.id), 'session row must still exist after a failed delete');
  assert.equal(count(db, 'SELECT COUNT(*) AS count FROM events WHERE session_id = ?', session.id), before.events);
  assert.equal(count(db, 'SELECT COUNT(*) AS count FROM viewer_sessions WHERE session_id = ?', session.id), before.sessions);
  assert.equal(count(db, "SELECT COUNT(*) AS count FROM viewers WHERE id = 'youtube:UC_R'"), before.viewers);
  assert.equal(count(db, "SELECT COUNT(*) AS count FROM viewer_currency_totals WHERE viewer_id = 'youtube:UC_R'"), before.totals);

  // Once the simulated failure is gone the delete succeeds and clears everything.
  const result = await deleteSessionRecord({deps: depsFor(db), sessionId: session.id, confirm: true});
  assert.equal(result.deleted, true);
  assert.equal(getSession(db, session.id), null);
  closeDatabase(db);
});

test('deleting an ended session that is archived works and clears the archive flag with the row', async () => {
  const db = freshDb();
  const broadcasterId = broadcaster(db, 'youtube', 'UC_ARCH_DEL', 'ArchDel');
  const session = openSession(db, {
    platform: 'youtube',
    roomId: 'arch-del',
    title: 'Archived then deleted',
    broadcasterName: 'ArchDel',
    broadcasterId
  });
  chat(db, session, {uid: 'UC_X', name: 'X'});
  endSession(db, session.id, {status: 'ended', endedAt: T0 + 1000});
  setSessionArchived(db, session.id, true, {now: T0 + 2000});
  assert.equal(searchHistory(db, {}).total, 0);
  assert.equal(searchHistory(db, {includeArchived: true}).total, 1);
  const result = await deleteSessionRecord({deps: depsFor(db), sessionId: session.id, confirm: true});
  assert.equal(result.deleted, true);
  assert.equal(searchHistory(db, {includeArchived: true}).total, 0);
  assert.equal(count(db, 'SELECT COUNT(*) AS count FROM broadcasters WHERE id = ?', broadcasterId), 0);
  closeDatabase(db);
});
