import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase, closeDatabase} from '../../src/storage/database/connection.mjs';
import {migrate} from '../../src/storage/database/migrations/index.mjs';
import {
  createSession,
  endSession,
  getSession,
  listSessions
} from '../../src/storage/repositories/sessions.mjs';
import {
  countSessionSpeakers,
  listSessionViewers,
  listViewers
} from '../../src/storage/repositories/viewers.mjs';
import {buildSessionSummary} from '../../src/analytics/sessions/summary.mjs';
import {searchHistory} from '../../src/analytics/sessions/history-search.mjs';
import {serializeSessionRow} from '../../src/server/serializers.mjs';
import {EventIngest} from '../../src/platforms/shared/ingest.mjs';
import {chatEvent, giftEvent, guardEvent, superChatEvent} from '../helpers/fixtures.mjs';

const T = Date.parse('2026-11-12T01:06:20.000+08:00');

function createDb() {
  const db = openDatabase({memory: true});
  migrate(db);
  return db;
}

test('session identity coverage counts only stable UIDs and stays consistent across pages', () => {
  const db = createDb();
  const ingest = new EventIngest({db});
  const session = createSession(db, {
    platform: 'bilibili',
    roomTitle: 'Identity coverage',
    storageMode: 'compact',
    sourceQuality: 'estimated',
    simulated: false,
    startedAt: T
  });

  // One viewer, two messages, and the same UID delivered once as number and
  // once as string: both are the same identity.
  ingest.record(chatEvent({platform: 'bilibili', session_id: session.id, viewer_uid: 100, display_name: 'SameName', external_id: 'id-1', occurred_at: T + 1000}));
  ingest.record(chatEvent({platform: 'bilibili', session_id: session.id, viewer_uid: '100', display_name: 'SameName', external_id: 'id-2', occurred_at: T + 2000}));
  // Same nickname, different UID: two people, never merged.
  ingest.record(chatEvent({platform: 'bilibili', session_id: session.id, viewer_uid: 101, display_name: 'SameName', external_id: 'id-3', occurred_at: T + 3000}));
  // Anonymous messages: masked names may repeat or collide, but they never
  // create a profile and are never merged into a fake viewer.
  ingest.record(chatEvent({platform: 'bilibili', session_id: session.id, viewer_uid: null, display_name: 'A***', external_id: 'id-4', occurred_at: T + 4000}));
  ingest.record(chatEvent({platform: 'bilibili', session_id: session.id, viewer_uid: '', display_name: 'B***', external_id: 'id-5', occurred_at: T + 5000}));
  ingest.record(chatEvent({platform: 'bilibili', session_id: session.id, viewer_uid: 0, display_name: 'A***', external_id: 'id-6', occurred_at: T + 6000}));
  // Paid events still carry a real identity.
  ingest.record(giftEvent({platform: 'bilibili', session_id: session.id, viewer_uid: 102, display_name: 'Gifter', external_id: 'id-7', occurred_at: T + 7000}));
  ingest.record(superChatEvent({platform: 'bilibili', session_id: session.id, viewer_uid: 103, display_name: 'Supporter', external_id: 'id-8', occurred_at: T + 8000}));
  ingest.record(guardEvent({platform: 'bilibili', session_id: session.id, viewer_uid: 104, display_name: 'Captain', external_id: 'id-9', occurred_at: T + 9000}));

  const stored = getSession(db, session.id);
  assert.equal(stored.message_count, 7, 'six chat messages + one Super Chat');
  assert.equal(stored.unique_viewer_count, 5, '100/101/102/103/104; UID 0 creates no profile');
  assert.equal(stored.unidentified_message_count, 3, 'two null/empty + one numeric UID 0');
  assert.equal(listViewers(db, {}).length, 5);
  assert.equal(listViewers(db, {}).some((viewer) => viewer.platform_uid === '0'), false);
  assert.equal(countSessionSpeakers(db, session.id), 3, '100, 101 and the Super Chat viewer');

  const viewers = listSessionViewers(db, session.id);
  assert.equal(viewers.length, 5);
  assert.deepEqual(
    viewers.map((viewer) => viewer.viewer_id).sort(),
    ['bilibili:100', 'bilibili:101', 'bilibili:102', 'bilibili:103', 'bilibili:104']
  );

  const summary = buildSessionSummary(db, session.id);
  assert.equal(summary.session.uniqueViewerCount, 5);
  assert.equal(summary.session.unidentifiedMessageCount, 3);
  assert.equal(summary.stats.messages, 7);
  assert.equal(summary.stats.activeViewers, 5);
  assert.equal(summary.stats.identifiedMessages, 4);
  assert.equal(summary.stats.unidentifiedMessages, 3);
  assert.equal(summary.stats.identityCoverage, 4 / 7);
  assert.equal(summary.stats.identityComplete, false);

  const history = searchHistory(db, {limit: 20, includeArchived: true});
  assert.equal(history.sessions.length, 1);
  assert.equal(history.sessions[0].uniqueViewerCount, 5);
  assert.equal(history.sessions[0].unidentifiedMessageCount, 3);
  assert.equal(history.sessions[0].messageCount, 7);

  const serialized = serializeSessionRow(getSession(db, session.id));
  assert.equal(serialized.uniqueViewerCount, 5);
  assert.equal(serialized.unidentifiedMessageCount, 3);

  const list = listSessions(db, {});
  assert.equal(list[0].unidentified_message_count, 3);
  closeDatabase(db);
});

test('a fully identified session reports complete identity coverage', () => {
  const db = createDb();
  const ingest = new EventIngest({db});
  const session = createSession(db, {
    platform: 'youtube',
    roomTitle: 'Identified only',
    storageMode: 'compact',
    sourceQuality: 'estimated',
    startedAt: T
  });
  ingest.record(chatEvent({platform: 'youtube', session_id: session.id, viewer_uid: 'UC_A', display_name: 'A', external_id: 'y-1', occurred_at: T + 1000}));
  ingest.record(chatEvent({platform: 'youtube', session_id: session.id, viewer_uid: 'UC_B', display_name: 'B', external_id: 'y-2', occurred_at: T + 2000}));

  const summary = buildSessionSummary(db, session.id);
  assert.equal(summary.stats.messages, 2);
  assert.equal(summary.stats.activeViewers, 2);
  assert.equal(summary.stats.unidentifiedMessages, 0);
  assert.equal(summary.stats.identityCoverage, 1);
  assert.equal(summary.stats.identityComplete, true);
  closeDatabase(db);
});

test('message counts remain unaffected when a session is ended', () => {
  const db = createDb();
  const ingest = new EventIngest({db});
  const session = createSession(db, {
    platform: 'bilibili',
    roomTitle: 'Ended',
    storageMode: 'compact',
    sourceQuality: 'estimated',
    startedAt: T
  });
  ingest.record(chatEvent({platform: 'bilibili', session_id: session.id, viewer_uid: null, display_name: '匿***', external_id: 'e-1', occurred_at: T + 1000}));
  endSession(db, session.id, {endedAt: T + 2000});
  const summary = buildSessionSummary(db, session.id);
  assert.equal(summary.stats.messages, 1);
  assert.equal(summary.stats.activeViewers, 0);
  assert.equal(summary.stats.unidentifiedMessages, 1);
  closeDatabase(db);
});
