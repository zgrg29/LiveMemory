import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase, closeDatabase} from '../../src/storage/database/connection.mjs';
import {migrate} from '../../src/storage/database/migrations/index.mjs';
import {createSession, endSession, setSessionArchived} from '../../src/storage/repositories/sessions.mjs';
import {upsertBroadcaster} from '../../src/storage/repositories/broadcasters.mjs';
import {EventIngest} from '../../src/platforms/shared/ingest.mjs';
import {searchHistory} from '../../src/analytics/sessions/history-search.mjs';

/**
 * History search: broadcaster, title and viewer, with filters and pagination.
 * All data is synthetic and local; no platform or AI service is involved.
 */

const T0 = Date.parse('2026-11-09T10:00:00.000Z');
const DAY = 24 * 3600 * 1000;

function setup() {
  const db = openDatabase({memory: true});
  migrate(db, {now: T0});
  return db;
}

function addBroadcaster(db, platform, uid, name) {
  const id = `${platform}:${uid}`;
  upsertBroadcaster(db, {id, platform, platformUid: uid, displayName: name, identity: 'verified', seenAt: T0, now: T0});
  return id;
}

function addSession(db, {platform, roomId, title, broadcasterName, broadcasterId, startedAt, ended = true}) {
  const session = createSession(db, {
    platform,
    platformRoomId: roomId,
    roomTitle: title,
    broadcasterName,
    broadcasterId,
    broadcasterIdentity: 'verified',
    startedAt,
    now: startedAt
  });
  if (ended) endSession(db, session.id, {status: 'ended', endedAt: startedAt + 3600 * 1000});
  return session;
}

function speak(db, session, {uid, name, content = 'hello', at, externalId, platform = session.platform, paid = false}) {
  const ingest = new EventIngest({db, now: () => at});
  return ingest.record({
    session_id: session.id,
    platform,
    event_type: paid ? 'super_chat' : 'chat',
    viewer_uid: uid,
    display_name: name,
    occurred_at: at,
    content,
    ...(paid ? {amount_minor: 1000, currency: 'CNY', value_kind: 'actual', is_paid: true} : {}),
    external_id: externalId ?? `${session.id}:${at}:${uid}`
  });
}

function seed(db) {
  const bili = addBroadcaster(db, 'bilibili', '9001', '主播甲');
  const alpha = addBroadcaster(db, 'youtube', 'UC_ALPHA', 'Alpha Channel');
  const beta = addBroadcaster(db, 'youtube', 'UC_BETA', 'Beta Channel');

  const s1 = addSession(db, {
    platform: 'bilibili', roomId: '5050', title: '中文杂谈：今天的游戏很好玩',
    broadcasterName: '主播甲', broadcasterId: bili, startedAt: T0 - 40 * DAY, ended: false
  });
  const s2 = addSession(db, {
    platform: 'youtube', roomId: 'video-alpha-1', title: 'Morning English Talk Show',
    broadcasterName: 'Alpha Channel', broadcasterId: alpha, startedAt: T0 - 20 * DAY, ended: false
  });
  const s3 = addSession(db, {
    platform: 'youtube', roomId: 'video-alpha-2', title: '日本語 雑談 配信',
    broadcasterName: 'Alpha Channel', broadcasterId: alpha, startedAt: T0 - 10 * DAY, ended: false
  });
  const s4 = addSession(db, {
    platform: 'youtube', roomId: 'video-beta-1', title: 'Mixed 中文 English 日本語 chat',
    broadcasterName: 'Beta Channel', broadcasterId: beta, startedAt: T0 - 5 * DAY, ended: false
  });
  const s5 = addSession(db, {
    platform: 'bilibili', roomId: '7777', title: 'Archived 中文 test',
    broadcasterName: '主播甲', broadcasterId: bili, startedAt: T0 - 3 * DAY
  });
  setSessionArchived(db, s5.id, true, {now: T0 - 2 * DAY});

  // Same nickname, different platform and stable id: two distinct identities.
  speak(db, s1, {uid: '9002', name: 'Alex', content: '你好', at: T0 - 40 * DAY + 1000, externalId: 's1-a'});
  speak(db, s1, {uid: '9003', name: 'Known Viewer', content: 'anonymous message', at: T0 - 40 * DAY + 2000, externalId: 's1-b'});
  // A message without a stable id must not be searchable as a viewer.
  new EventIngest({db, now: () => T0 - 40 * DAY + 3000}).record({
    session_id: s1.id,
    platform: 'bilibili', event_type: 'chat', occurred_at: T0 - 40 * DAY + 3000,
    content: 'no identity here', external_id: 's1-anon'
  });

  speak(db, s2, {uid: 'UC_VIEWER', name: 'Alex', content: 'first', at: T0 - 20 * DAY + 1000, externalId: 's2-a'});
  speak(db, s2, {uid: 'UC_VIEWER', name: 'Alex', content: 'second', at: T0 - 20 * DAY + 2000, externalId: 's2-b'});
  speak(db, s2, {uid: 'UC_PAID', name: 'Patron', content: 'support', at: T0 - 20 * DAY + 3000, externalId: 's2-pay', paid: true});
  speak(db, s3, {uid: 'UC_VIEWER', name: 'Old Alex', content: '昔の名前', at: T0 - 10 * DAY + 1000, externalId: 's3-a'});
  speak(db, s3, {uid: 'UC_VIEWER', name: 'Alex', content: '新しい名前', at: T0 - 10 * DAY + 2000, externalId: 's3-b'});
  speak(db, s4, {uid: 'UC_VIEWER', name: 'Alex', content: 'mixed', at: T0 - 5 * DAY + 1000, externalId: 's4-a'});

  for (const session of [s1, s2, s3, s4]) {
    endSession(db, session.id, {status: 'ended', endedAt: session.started_at + 3600 * 1000});
  }

  // Bulk history for pagination and performance.
  for (let index = 0; index < 10; index += 1) {
    addSession(db, {
      platform: 'youtube',
      roomId: `bulk-${index}`,
      title: `Bulk session ${String(index).padStart(2, '0')}`,
      broadcasterName: 'Alpha Channel',
      broadcasterId: alpha,
      startedAt: T0 - DAY - index * 1000
    });
  }
  return {s1, s2, s3, s4, s5, bili, alpha, beta};
}

test('searches by broadcaster display name and stable platform id', () => {
  const db = setup();
  const {s1, s2, s3} = seed(db);
  const byName = searchHistory(db, {query: 'Alpha Channel', includeArchived: true});
  assert.ok(byName.total >= 3);
  assert.ok(byName.sessions.some((session) => session.id === s2.id));
  assert.ok(byName.sessions.some((session) => session.id === s3.id));
  assert.ok(byName.sessions.every((session) => session.match.broadcaster === true));
  const byUid = searchHistory(db, {query: 'UC_ALPHA', includeArchived: true});
  assert.ok(byUid.sessions.some((session) => session.id === s2.id));
  const bili = searchHistory(db, {query: '主播甲', includeArchived: true});
  assert.ok(bili.sessions.some((session) => session.id === s1.id));
  assert.ok(bili.sessions.every((session) => session.match.broadcaster === true));
  // Broadcaster search does not accidentally match titles or viewers.
  assert.equal(searchHistory(db, {query: 'UC_ALPHA', scope: 'title', includeArchived: true}).total, 0);
  closeDatabase(db);
});

test('searches titles across Chinese, Japanese, English and mixed text', () => {
  const db = setup();
  seed(db);
  const chinese = searchHistory(db, {query: '杂谈', includeArchived: true});
  assert.ok(chinese.total >= 1);
  assert.ok(chinese.sessions.every((session) => session.match.title === true));
  const japanese = searchHistory(db, {query: '雑談', includeArchived: true});
  assert.ok(japanese.sessions.some((session) => session.roomTitle.includes('日本語')));
  const english = searchHistory(db, {query: 'English', includeArchived: true});
  assert.ok(english.sessions.some((session) => session.roomTitle === 'Morning English Talk Show'));
  assert.ok(english.sessions.some((session) => session.roomTitle === 'Mixed 中文 English 日本語 chat'));
  const mixed = searchHistory(db, {query: 'English 日本語', includeArchived: true});
  assert.ok(mixed.sessions.some((session) => session.roomTitle.startsWith('Mixed')));
  // Chat content is never scanned: searching a message body must find nothing.
  assert.equal(searchHistory(db, {query: 'great stream', includeArchived: true}).total, 0);
  closeDatabase(db);
});

test('viewer search returns distinct identities, their sessions and message counts', () => {
  const db = setup();
  const {s1, s2, s3, s4} = seed(db);
  const result = searchHistory(db, {query: 'Alex', includeArchived: true});
  const ids = result.sessions.map((session) => session.id);
  for (const session of [s1, s2, s3, s4]) assert.ok(ids.includes(session.id), `missing ${session.roomTitle}`);
  const s1Row = result.sessions.find((session) => session.id === s1.id);
  const s2Row = result.sessions.find((session) => session.id === s2.id);
  assert.equal(s1Row.matchedViewers[0].viewerId, 'bilibili:9002');
  assert.equal(s2Row.matchedViewers[0].viewerId, 'youtube:UC_VIEWER');
  assert.equal(s2Row.matchedViewers[0].messageCount, 2);
  assert.equal(s3Row(result).messageCount, 2, 'historical nickname still matches the same identity');
  // Two candidate identities with the same nickname, never merged.
  const candidateIds = result.viewerCandidates.map((candidate) => candidate.id).sort();
  assert.deepEqual(candidateIds, ['bilibili:9002', 'youtube:UC_VIEWER']);
  assert.ok(result.viewerCandidates.every((candidate) => candidate.nickname === 'Alex'));

  // Stable platform id search matches only that identity.
  const byId = searchHistory(db, {query: 'UC_VIEWER', includeArchived: true});
  assert.deepEqual(
    byId.sessions.map((session) => session.id).sort(),
    [s2.id, s3.id, s4.id].sort()
  );
  // Historical nickname still resolves to the same stable identity, and then
  // returns every session in which that identity participated.
  const historical = searchHistory(db, {query: 'Old Alex', scope: 'viewer', includeArchived: true});
  assert.equal(historical.total, 3);
  assert.ok(historical.sessions.some((session) => session.id === s3.id));
  assert.ok(historical.sessions.every((session) =>
    session.matchedViewers[0].viewerId === 'youtube:UC_VIEWER'
    && session.matchedViewers[0].matchedBy === 'nickname'));
  // Anonymous messages have no viewer row and cannot be invented.
  assert.equal(searchHistory(db, {query: 'Anonymous-ish', scope: 'viewer', includeArchived: true}).total, 0);
  assert.equal(searchHistory(db, {query: 'no identity here', scope: 'viewer', includeArchived: true}).total, 0);
  // Viewer scope matches participation only, never title text.
  assert.equal(searchHistory(db, {query: '杂谈', scope: 'viewer', includeArchived: true}).total, 0);
  closeDatabase(db);
});

function s3Row(result) {
  return result.sessions.find((session) => session.roomTitle === '日本語 雑談 配信').matchedViewers[0];
}

test('filters combine with search: platform, status, date range and archive visibility', () => {
  const db = setup();
  const {s1, s2, s3, s4, s5} = seed(db);
  const all = searchHistory(db, {query: 'Alex', includeArchived: true});
  assert.equal(all.total, 4);
  const youtubeOnly = searchHistory(db, {query: 'Alex', platform: 'youtube', includeArchived: true});
  assert.equal(youtubeOnly.total, 3);
  assert.ok(youtubeOnly.sessions.every((session) => session.platform === 'youtube'));
  const bilibiliOnly = searchHistory(db, {query: 'Alex', platform: 'bilibili', includeArchived: true});
  assert.equal(bilibiliOnly.total, 1);
  assert.equal(bilibiliOnly.sessions[0].id, s1.id);

  const recently = searchHistory(db, {
    query: 'Alex',
    from: T0 - 7 * DAY,
    to: T0,
    includeArchived: true
  });
  assert.equal(recently.total, 1);
  assert.equal(recently.sessions[0].id, s4.id);

  const ended = searchHistory(db, {query: 'Alex', status: 'ended', includeArchived: true});
  assert.equal(ended.total, 4);
  const live = searchHistory(db, {query: 'Alex', status: 'live', includeArchived: true});
  assert.equal(live.total, 0);
  const interrupted = searchHistory(db, {query: 'Alex', status: 'interrupted', includeArchived: true});
  assert.equal(interrupted.total, 0);

  // Archived sessions are hidden by default and appear on demand.
  assert.equal(searchHistory(db, {query: 'Archived'}).total, 0);
  const archived = searchHistory(db, {query: 'Archived', includeArchived: true});
  assert.equal(archived.total, 1);
  assert.equal(archived.sessions[0].id, s5.id);
  assert.equal(archived.sessions[0].archived, true);
  const onlyArchived = searchHistory(db, {query: 'Archived', archivedOnly: true});
  assert.equal(onlyArchived.total, 1);
  // The hidden-archive hint counts matches without showing them.
  const hiddenHint = searchHistory(db, {query: 'Archived'});
  assert.equal(hiddenHint.hiddenArchivedCount, 1);
  assert.equal(hiddenHint.total, 0);

  // Combined: viewer + platform + last 30 days + archive excluded.
  const combined = searchHistory(db, {
    query: 'Alex',
    platform: 'youtube',
    from: T0 - 30 * DAY,
    to: T0,
    includeArchived: false
  });
  assert.deepEqual(combined.sessions.map((session) => session.id).sort(), [s2.id, s3.id, s4.id].sort());
  closeDatabase(db);
});

test('wildcard characters are matched literally and empty searches list filtered history', () => {
  const db = setup();
  seed(db);
  // `%` never expands to "match everything".
  assert.equal(searchHistory(db, {query: '%', includeArchived: true}).total, 0);
  assert.equal(searchHistory(db, {query: '100%', includeArchived: true}).total, 0);
  // `_` is literal too: it matches the underscores inside stable channel ids
  // (UC_ALPHA and friends), never an arbitrary single character.
  const underscore = searchHistory(db, {query: '_', includeArchived: true});
  assert.equal(underscore.total, 13);
  assert.ok(underscore.sessions.every((session) => session.match.broadcaster === true));
  assert.ok(underscore.sessions.every((session) => String(session.broadcasterPlatformUid).includes('_')));
  const plain = searchHistory(db, {});
  assert.equal(plain.total, 14);
  assert.equal(plain.sessions.length, 14);
  // Newest first.
  for (let index = 1; index < plain.sessions.length; index += 1) {
    assert.ok(plain.sessions[index - 1].startedAt >= plain.sessions[index].startedAt);
  }
  closeDatabase(db);
});

test('pagination returns stable slices and a correct total', () => {
  const db = setup();
  const {alpha} = seed(db);
  const first = searchHistory(db, {query: 'Bulk session', limit: 4, offset: 0, includeArchived: true});
  assert.equal(first.total, 10);
  assert.equal(first.sessions.length, 4);
  assert.equal(first.hasMore, true);
  const second = searchHistory(db, {query: 'Bulk session', limit: 4, offset: 4, includeArchived: true});
  assert.equal(second.sessions.length, 4);
  assert.equal(second.hasMore, true);
  const third = searchHistory(db, {query: 'Bulk session', limit: 4, offset: 8, includeArchived: true});
  assert.equal(third.sessions.length, 2);
  assert.equal(third.hasMore, false);
  const ids = [...first.sessions, ...second.sessions, ...third.sessions].map((session) => session.id);
  assert.equal(new Set(ids).size, 10);
  // Only that broadcaster's sessions are present.
  assert.ok([...first.sessions, ...second.sessions, ...third.sessions]
    .every((session) => session.broadcasterId === alpha));
  closeDatabase(db);
});

test('large histories keep viewer and title search fast', () => {
  const db = setup();
  const broadcasterId = addBroadcaster(db, 'youtube', 'UC_PERF', 'Performance Channel');
  const viewerId = 'youtube:UC_PERF_VIEWER';
  db.prepare(`
    INSERT INTO viewers (id, platform, platform_uid, nickname, first_seen_at, last_seen_at, message_count, payment_event_count, focused, created_at, updated_at)
    VALUES (?, 'youtube', 'UC_PERF_VIEWER', 'Perf Viewer', ?, ?, 0, 0, 0, ?, ?)
  `).run(viewerId, T0, T0, T0, T0);
  const insertSession = db.prepare(`
    INSERT INTO sessions (
      id, platform, platform_room_id, room_title, broadcaster_name, broadcaster_id,
      broadcaster_identity, status, storage_mode, source_quality, simulated, started_at,
      ended_at, last_event_at, message_count, gift_event_count, payment_event_count, ai_status, created_at, updated_at
    ) VALUES (?, 'youtube', ?, ?, 'Performance Channel', ?, 'verified', 'ended', 'compact', 'verified', 0,
      ?, ?, ?, 10, 0, 0, 'none', ?, ?)
  `);
  const insertViewerSession = db.prepare(`
    INSERT INTO viewer_sessions (viewer_id, session_id, message_count, payment_event_count, first_seen_at, last_seen_at)
    VALUES (?, ?, 10, 0, ?, ?)
  `);
  const insertEvent = db.prepare(`
    INSERT INTO events (session_id, platform, external_id, event_type, viewer_id, viewer_uid, display_name,
      occurred_at, received_at, content, gift_quantity, value_kind, is_paid, source_quality, dedupe_key)
    VALUES (?, 'youtube', ?, 'chat', ?, 'UC_PERF_VIEWER', 'Perf Viewer', ?, ?, 'perf', 1, 'unknown', 0, 'verified', ?)
  `);
  db.exec('BEGIN IMMEDIATE');
  for (let index = 0; index < 1200; index += 1) {
    const sessionId = `ses_perf_${String(index).padStart(5, '0')}`;
    const at = T0 - index * 60_000;
    insertSession.run(sessionId, `perf-${index}`, `Performance session ${index}`, broadcasterId, at, at + 1000, at + 500, at, at);
    insertViewerSession.run(viewerId, sessionId, at, at + 500);
    for (let message = 0; message < 10; message += 1) {
      insertEvent.run(sessionId, `perf-${index}-${message}`, viewerId, at + message, at + message, `perf-${index}-${message}`);
    }
  }
  db.exec('COMMIT');

  const startViewer = performance.now();
  const viewer = searchHistory(db, {query: 'Perf Viewer', scope: 'viewer', limit: 20});
  const viewerMs = performance.now() - startViewer;
  assert.equal(viewer.total, 1200);
  assert.equal(viewer.sessions.length, 20);
  assert.equal(viewer.sessions[0].matchedViewers[0].messageCount, 10);

  const startTitle = performance.now();
  const title = searchHistory(db, {query: 'session 1199', scope: 'title', limit: 20});
  const titleMs = performance.now() - startTitle;
  assert.equal(title.total, 1);
  assert.ok(viewerMs < 800, `viewer search took ${viewerMs.toFixed(1)}ms`);
  assert.ok(titleMs < 400, `title search took ${titleMs.toFixed(1)}ms`);
  closeDatabase(db);
});
