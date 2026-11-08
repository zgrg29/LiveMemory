import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase, closeDatabase} from '../../src/storage/database/connection.mjs';
import {currentSchemaVersion, migrate, MIGRATIONS} from '../../src/storage/database/migrations/index.mjs';
import {
  createSession,
  endSession,
  findLiveSession,
  getSession,
  listSessions,
  recoverInterruptedSessions
} from '../../src/storage/repositories/sessions.mjs';
import {contentStats, listEvents, purgeSessionContent} from '../../src/storage/repositories/events.mjs';
import {getViewer, listViewers, viewerCurrencyTotals, viewerNicknameHistory, sessionCurrencyTotals} from '../../src/storage/repositories/viewers.mjs';
import {EventIngest} from '../../src/platforms/shared/ingest.mjs';
import {chatEvent, giftEvent, guardEvent, superChatEvent} from '../helpers/fixtures.mjs';

const T = Date.parse('2026-11-08T10:00:00.000Z');

function createDb() {
  const db = openDatabase({memory: true});
  migrate(db);
  return db;
}

test('migrations create the schema once and are idempotent', () => {
  const db = createDb();
  assert.equal(currentSchemaVersion(db), MIGRATIONS.at(-1).version);
  const again = migrate(db);
  assert.deepEqual(again.applied, []);
  assert.equal(again.from, again.to);
  closeDatabase(db);
});

test('recording events updates session, viewer and money aggregates exactly once', () => {
  const db = createDb();
  const session = createSession(db, {
    platform: 'mock',
    roomTitle: 'Test stream',
    storageMode: 'compact',
    sourceQuality: 'mock',
    simulated: true,
    startedAt: T
  });
  const ingest = new EventIngest({db});

  assert.equal(ingest.record(chatEvent({session_id: session.id, viewer_uid: 'a', display_name: 'Alice', external_id: 'e1', occurred_at: T})).inserted, true);
  const gift = giftEvent({
    session_id: session.id,
    viewer_uid: 'a',
    display_name: 'Alice',
    external_id: 'e2',
    occurred_at: T + 1000,
    unit_amount_minor: 100,
    gift_quantity: 2
  });
  assert.equal(ingest.record(gift).inserted, true);
  assert.equal(ingest.record(gift).duplicate, true, 're-delivery must be ignored');
  assert.equal(ingest.record(superChatEvent({session_id: session.id, viewer_uid: 'b', display_name: 'Bob', external_id: 'e3', occurred_at: T + 2000})).inserted, true);
  assert.equal(ingest.record(guardEvent({session_id: session.id, viewer_uid: 'c', display_name: 'Cara', external_id: 'e4', occurred_at: T + 3000})).inserted, true);

  const stored = getSession(db, session.id);
  assert.equal(stored.message_count, 2, 'chat + super chat');
  assert.equal(stored.gift_event_count, 1);
  assert.equal(stored.payment_event_count, 3, 'gift + super chat + guard');
  assert.equal(stored.status, 'live');

  const totals = sessionCurrencyTotals(db, session.id);
  const actual = totals.filter((row) => row.value_kind === 'actual');
  assert.equal(actual.length, 1);
  assert.equal(actual[0].total_minor, 200 + 3000 + 13800);
  assert.equal(actual[0].event_count, 3);

  const alice = getViewer(db, 'mock:a');
  assert.equal(alice.message_count, 1);
  assert.equal(alice.payment_event_count, 1);
  assert.equal(alice.nickname, 'Alice');
  const aliceMoney = viewerCurrencyTotals(db, 'mock:a');
  assert.equal(aliceMoney.find((row) => row.value_kind === 'actual').total_minor, 200);

  assert.equal(listEvents(db, {sessionId: session.id}).length, 4, 'duplicate was not stored');
  closeDatabase(db);
});

test('viewers keep separate identities, nickname history and cross-session counts', () => {
  const db = createDb();
  const ingest = new EventIngest({db});
  const first = createSession(db, {platform: 'mock', roomTitle: 'One', storageMode: 'compact', sourceQuality: 'mock', simulated: true, startedAt: T});
  ingest.record(chatEvent({session_id: first.id, viewer_uid: 'x', display_name: 'OldName', external_id: 'n1', occurred_at: T}));
  ingest.record(chatEvent({session_id: first.id, viewer_uid: 'x', display_name: 'NewName', external_id: 'n2', occurred_at: T + 1000}));
  ingest.record(giftEvent({session_id: first.id, viewer_uid: 'x', display_name: 'NewName', external_id: 'n3', occurred_at: T + 2000}));
  endSession(db, first.id, {endedAt: T + 5000});

  const second = createSession(db, {platform: 'mock', roomTitle: 'Two', storageMode: 'compact', sourceQuality: 'mock', simulated: true, startedAt: T + 10_000});
  ingest.record(chatEvent({session_id: second.id, viewer_uid: 'x', display_name: 'NewName', external_id: 'n4', occurred_at: T + 11_000}));
  // Same UID on another platform must stay a different person.
  ingest.record(chatEvent({platform: 'youtube', session_id: second.id, viewer_uid: 'x', display_name: 'OldName', external_id: 'n5', occurred_at: T + 12_000}));

  const viewer = getViewer(db, 'mock:x');
  assert.equal(viewer.session_count, 2);
  assert.equal(viewer.message_count, 3);
  assert.equal(viewer.payment_event_count, 1);

  const names = viewerNicknameHistory(db, 'mock:x').map((row) => row.nickname).sort();
  assert.deepEqual(names, ['NewName', 'OldName']);

  assert.equal(getViewer(db, 'youtube:x').message_count, 1);
  assert.equal(getViewer(db, 'mock:x').id, 'mock:x');
  assert.equal(listViewers(db, {}).length, 2);

  const finished = listSessions(db, {});
  assert.equal(finished.length, 2);
  closeDatabase(db);
});

test('events without a stable viewer id count for the session but not for a profile', () => {
  const db = createDb();
  const ingest = new EventIngest({db});
  const session = createSession(db, {platform: 'mock', roomTitle: 'Anon', storageMode: 'compact', sourceQuality: 'mock', simulated: true, startedAt: T});
  const result = ingest.record(chatEvent({session_id: session.id, viewer_uid: '', display_name: 'Anonymous', external_id: 'anon-1', occurred_at: T}));
  assert.equal(result.inserted, true);
  assert.equal(getSession(db, session.id).message_count, 1);
  assert.equal(listViewers(db, {}).length, 0);
  assert.equal(listEvents(db, {sessionId: session.id})[0].viewer_id, null);
  closeDatabase(db);
});

test('a live session left open by a crash is marked interrupted on recovery', () => {
  const db = createDb();
  const session = createSession(db, {platform: 'mock', roomTitle: 'Crash', storageMode: 'compact', sourceQuality: 'mock', simulated: true, startedAt: T});
  const ingest = new EventIngest({db});
  ingest.record(chatEvent({session_id: session.id, viewer_uid: 'z', display_name: 'Zed', external_id: 'z1', occurred_at: T + 4000}));
  assert.ok(findLiveSession(db));
  const recovered = recoverInterruptedSessions(db, {now: T + 60_000});
  assert.deepEqual(recovered, [session.id]);
  const stored = getSession(db, session.id);
  assert.equal(stored.status, 'interrupted');
  assert.equal(stored.ended_at, T + 4000, 'ends at the last recorded event');
  assert.equal(findLiveSession(db), null);
  closeDatabase(db);
});

test('compact mode can purge chat text without losing counts', () => {
  const db = createDb();
  const ingest = new EventIngest({db});
  const session = createSession(db, {platform: 'mock', roomTitle: 'Purge', storageMode: 'compact', sourceQuality: 'mock', simulated: true, startedAt: T});
  ingest.record(chatEvent({session_id: session.id, viewer_uid: 'p', display_name: 'Purge', external_id: 'p1', occurred_at: T}));
  ingest.record(chatEvent({session_id: session.id, viewer_uid: 'p', display_name: 'Purge', external_id: 'p2', occurred_at: T + 1000}));
  ingest.record(giftEvent({session_id: session.id, viewer_uid: 'p', display_name: 'Purge', external_id: 'p3', occurred_at: T + 2000}));
  assert.equal(contentStats(db, session.id).with_content, 2, 'only chat rows carry text');
  const purged = purgeSessionContent(db, session.id, {now: T + 5000});
  assert.equal(purged, 2, 'only chat-like rows are purged');
  assert.equal(contentStats(db, session.id).with_content, 0);
  assert.equal(getSession(db, session.id).message_count, 2);
  assert.equal(sessionCurrencyTotals(db, session.id).length, 1);
  closeDatabase(db);
});

test('events are ignored for sessions that are no longer live', () => {
  const db = createDb();
  const ingest = new EventIngest({db});
  const session = createSession(db, {platform: 'mock', roomTitle: 'Closed', storageMode: 'compact', sourceQuality: 'mock', simulated: true, startedAt: T});
  endSession(db, session.id, {endedAt: T + 1000});
  const result = ingest.record(chatEvent({session_id: session.id, viewer_uid: 'q', display_name: 'Q', external_id: 'q1', occurred_at: T + 2000}));
  assert.equal(result.skipped, true);
  assert.equal(listEvents(db, {sessionId: session.id}).length, 0);
  closeDatabase(db);
});

test('emote metadata is persisted with the raw message and survives duplicate delivery', () => {
  const db = createDb();
  const ingest = new EventIngest({db});
  const session = createSession(db, {platform: 'bilibili', roomTitle: 'Emote', storageMode: 'compact', sourceQuality: 'estimated', simulated: false, startedAt: T});
  const chat = chatEvent({
    platform: 'bilibili',
    session_id: session.id,
    viewer_uid: '42',
    display_name: '观众',
    external_id: 'emote-1',
    occurred_at: T,
    content: '今天这个剧情太好笑了😂[猫猫鼓掌]',
    emotes: [{id: 'room_5050_cat', code: '[猫猫鼓掌]', name: '猫猫鼓掌', source: 'bilibili.info13'}]
  });
  assert.equal(ingest.record(chat).inserted, true);
  assert.equal(ingest.record(chat).duplicate, true);
  const rows = listEvents(db, {sessionId: session.id});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, '今天这个剧情太好笑了😂[猫猫鼓掌]');
  assert.deepEqual(rows[0].emotes, [{id: 'room_5050_cat', code: '[猫猫鼓掌]', name: '猫猫鼓掌', source: 'bilibili.info13'}]);
  assert.equal(getSession(db, session.id).message_count, 1);
  closeDatabase(db);
});

test('compact cleanup removes emote metadata together with chat text', () => {
  const db = createDb();
  const ingest = new EventIngest({db});
  const session = createSession(db, {platform: 'bilibili', roomTitle: 'Purge emote', storageMode: 'compact', sourceQuality: 'estimated', simulated: false, startedAt: T});
  ingest.record(chatEvent({
    platform: 'bilibili',
    session_id: session.id,
    viewer_uid: '42',
    display_name: '观众',
    external_id: 'emote-purge-1',
    occurred_at: T,
    content: '就这',
    emotes: [{id: 'room_5050_96171', name: '就这', source: 'bilibili.info13'}]
  }));
  assert.equal(purgeSessionContent(db, session.id, {now: T + 1000}), 1);
  const row = listEvents(db, {sessionId: session.id})[0];
  assert.equal(row.content, null);
  assert.equal(row.emotes, null);
  assert.equal(getSession(db, session.id).message_count, 1, 'the message row still counts');
  closeDatabase(db);
});
