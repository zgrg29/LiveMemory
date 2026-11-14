import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase, closeDatabase} from '../../src/storage/database/connection.mjs';
import {migrate} from '../../src/storage/database/migrations/index.mjs';
import {createSession} from '../../src/storage/repositories/sessions.mjs';
import {EventIngest} from '../../src/platforms/shared/ingest.mjs';
import {
  countExpiredRawEvents,
  purgeExpiredRawEvents,
  runRetention,
  retentionStatus,
  normalizeRetentionDays,
  DEFAULT_YOUTUBE_RAW_RETENTION_DAYS
} from '../../src/storage/retention.mjs';

const DAY = 86400_000;
const NOW = Date.parse('2026-11-08T12:00:00.000Z');

function setup() {
  const db = openDatabase({memory: true});
  migrate(db, {now: NOW});
  const session = createSession(db, {
    platform: 'youtube',
    platformRoomId: 'vid12345678',
    roomTitle: 'Retention test',
    storageMode: 'full',
    sourceQuality: 'estimated',
    startedAt: NOW - 40 * DAY
  });
  const ingest = new EventIngest({db, now: () => NOW});
  const record = (overrides) => ingest.record({
    platform: 'youtube',
    session_id: session.id,
    event_type: 'chat',
    viewer_uid: 'UC_A',
    display_name: 'A',
    content: 'hello',
    occurred_at: NOW - 40 * DAY,
    received_at: NOW - 40 * DAY,
    ...overrides
  });
  return {db, session, record};
}

test('retention days are clamped to a sane range', () => {
  assert.equal(normalizeRetentionDays(undefined), DEFAULT_YOUTUBE_RAW_RETENTION_DAYS);
  assert.equal(normalizeRetentionDays(0), 1);
  assert.equal(normalizeRetentionDays(-5), 1);
  assert.equal(normalizeRetentionDays('45'), 30);
  assert.equal(normalizeRetentionDays(999999), 30);
});

test('only YouTube raw chat text older than the window is purged', () => {
  const {db, session, record} = setup();
  record({external_id: 'old-yt', received_at: NOW - 40 * DAY, occurred_at: NOW - 40 * DAY});
  record({external_id: 'fresh-yt', received_at: NOW - DAY, occurred_at: NOW - DAY});
  record({
    external_id: 'old-bili',
    platform: 'bilibili',
    viewer_uid: '42',
    received_at: NOW - 40 * DAY,
    occurred_at: NOW - 40 * DAY
  });

  const dry = purgeExpiredRawEvents(db, {now: NOW, days: 30, dryRun: true});
  assert.equal(dry.purged, 1);
  assert.equal(countExpiredRawEvents(db, {now: NOW, days: 30}), 1);

  const result = purgeExpiredRawEvents(db, {now: NOW, days: 30});
  assert.equal(result.purged, 1);

  const rows = db.prepare('SELECT external_id, platform, content, content_purged_at FROM events ORDER BY external_id').all();
  const byId = Object.fromEntries(rows.map((row) => [row.external_id, row]));
  assert.equal(byId['old-yt'].content, null);
  assert.equal(byId['old-yt'].content_purged_at, NOW);
  assert.equal(byId['fresh-yt'].content, 'hello');
  // Bilibili data is not governed by the YouTube policy and stays untouched.
  assert.equal(byId['old-bili'].content, 'hello');
  assert.equal(countExpiredRawEvents(db, {now: NOW, days: 30}), 0);

  // Counters and identity are untouched by the purge.
  const counters = db.prepare('SELECT message_count FROM sessions WHERE id = ?').get(session.id);
  assert.equal(Number(counters.message_count), 3);
  const viewers = db.prepare('SELECT COUNT(*) AS count FROM viewers').get();
  assert.equal(Number(viewers.count), 2);
  closeDatabase(db);
});

test('money and message counts survive a retention purge', () => {
  const {db, session, record} = setup();
  record({
    external_id: 'old-sc',
    event_type: 'super_chat',
    content: 'support',
    amount_minor: 500,
    amount_display: 'HK$5.00',
    currency: 'HKD',
    value_kind: 'actual',
    is_paid: true,
    badges: [{type: 'member', label: 'Member (1 year)'}],
    received_at: NOW - 40 * DAY,
    occurred_at: NOW - 40 * DAY
  });
  record({external_id: 'old-chat', received_at: NOW - 40 * DAY, occurred_at: NOW - 40 * DAY});
  const result = purgeExpiredRawEvents(db, {now: NOW, days: 30});
  assert.equal(result.purged, 2);
  const totals = db.prepare('SELECT currency, value_kind, total_minor, event_count FROM session_currency_totals')
    .all()
    .map((row) => ({...row}));
  assert.deepEqual(totals, [{currency: 'HKD', value_kind: 'actual', total_minor: 500, event_count: 1}]);
  const counters = db.prepare('SELECT message_count, payment_event_count FROM sessions WHERE id = ?').get(session.id);
  assert.equal(Number(counters.message_count), 2);
  assert.equal(Number(counters.payment_event_count), 1);
  const raw = db.prepare("SELECT content, emotes, badges, amount_display FROM events WHERE external_id = 'old-sc'").get();
  assert.deepEqual({...raw}, {content: null, emotes: null, badges: null, amount_display: null});
  closeDatabase(db);
});

test('retention removes stale YouTube nicknames but keeps aggregate identity', () => {
  const {db, record} = setup();
  record({
    external_id: 'old-with-badge',
    badges: [{type: 'moderator', label: 'Moderator'}],
    received_at: NOW - 40 * DAY,
    occurred_at: NOW - 40 * DAY
  });
  // EventIngest records the *local observation* time for viewer activity, so
  // force the viewer into the stale window to exercise nickname cleanup.
  db.prepare('UPDATE viewers SET last_seen_at = ? WHERE platform_uid = ?').run(NOW - 40 * DAY, 'UC_A');
  const summary = runRetention(db, {now: NOW, days: 30});
  assert.equal(summary.purged, 1);
  assert.ok(summary.purgedNicknames >= 1);
  const viewer = db.prepare("SELECT id, nickname FROM viewers WHERE platform_uid = 'UC_A'").get();
  assert.ok(viewer?.id);
  assert.equal(viewer.nickname, null);
  const nicknames = db.prepare('SELECT COUNT(*) AS count FROM viewer_nicknames WHERE viewer_id = ?').get(viewer.id);
  assert.equal(Number(nicknames.count), 0);
  // The event and its counts remain, so the session history does not change.
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events WHERE external_id = 'old-with-badge'").get().count, 1);
  closeDatabase(db);
});

test('runRetention records its last run and reports pending rows', () => {
  const {db, record} = setup();
  record({external_id: 'old-1', received_at: NOW - 40 * DAY, occurred_at: NOW - 40 * DAY});
  const before = retentionStatus(db, {days: 30, now: NOW});
  assert.equal(before.pendingPurge, 1);
  assert.equal(before.lastRun, null);

  const summary = runRetention(db, {now: NOW, days: 30});
  assert.equal(summary.purged, 1);
  assert.equal(summary.days, 30);

  const after = retentionStatus(db, {days: 30, now: NOW});
  assert.equal(after.pendingPurge, 0);
  assert.equal(after.lastRun.purged, 1);
  assert.equal(after.lastRun.days, 30);
  closeDatabase(db);
});
