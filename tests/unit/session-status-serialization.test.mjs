import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../../src/storage/database/connection.mjs';
import {migrate} from '../../src/storage/database/migrations/index.mjs';
import {
  createSession,
  endSession,
  getSession,
  setSessionPlatformStatus
} from '../../src/storage/repositories/sessions.mjs';
import {serializeSessionRow} from '../../src/server/serializers.mjs';
import {buildSessionSummary} from '../../src/analytics/sessions/summary.mjs';
import {searchHistory} from '../../src/analytics/sessions/history-search.mjs';

const T0 = Date.parse('2026-11-10T00:00:00.000Z');

test('platform status timestamps are exposed separately from the capture timestamps', () => {
  const db = openDatabase({memory: true});
  try {
    migrate(db, {now: T0});
    const session = createSession(db, {
      id: 'ses_serialize',
      platform: 'bilibili',
      platformRoomId: '9001',
      roomTitle: 'Serialization room',
      broadcasterName: 'Anchor',
      broadcasterUid: '9001',
      broadcasterIdentity: 'verified',
      startedAt: T0,
      now: T0
    });

    setSessionPlatformStatus(db, session.id, {
      status: 'ending',
      at: T0 + 1000,
      now: T0 + 1000
    });
    setSessionPlatformStatus(db, session.id, {
      status: 'ended',
      at: T0 + 2000,
      platformEndedAt: T0 + 2000,
      endQuality: 'event',
      now: T0 + 2000
    });
    assert.equal(getSession(db, session.id).last_live_seen_at, null);
    endSession(db, session.id, {status: 'ended', endedAt: T0 + 3000, reason: 'platform_ended'});

    const row = getSession(db, session.id);
    const serialized = serializeSessionRow(row);
    assert.equal(serialized.platformStatus, 'ended');
    assert.equal(serialized.platformStatusAt, T0 + 2000);
    assert.equal(serialized.platformEndedAt, T0 + 2000);
    assert.equal(serialized.platformEndQuality, 'event');
    assert.equal(serialized.lastLiveSeenAt, null);
    assert.equal(serialized.endedAt, T0 + 3000);
    assert.equal(serialized.endReason, 'platform_ended');

    const summary = buildSessionSummary(db, session.id, {now: T0 + 10_000});
    assert.equal(summary.session.platformStatus, 'ended');
    assert.equal(summary.session.platformStatusAt, T0 + 2000);
    assert.equal(summary.session.platformEndedAt, T0 + 2000);
    assert.equal(summary.session.platformEndQuality, 'event');
    assert.equal(summary.session.durationMs, 3000, 'duration must stop at ended_at');

    const history = searchHistory(db, {query: 'Serialization'});
    const match = history.sessions.find((entry) => entry.id === session.id);
    assert.ok(match);
    assert.equal(match.platformStatus, 'ended');
    assert.equal(match.platformStatusAt, T0 + 2000);
    assert.equal(match.platformEndedAt, T0 + 2000);
  } finally {
    db.close();
  }
});
