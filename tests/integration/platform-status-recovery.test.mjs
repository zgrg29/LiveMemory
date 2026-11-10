import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../../src/storage/database/connection.mjs';
import {migrate} from '../../src/storage/database/migrations/index.mjs';
import {
  createSession,
  endSession,
  getSession,
  listSessionsNeedingPlatformRepair,
  recoverInterruptedSessions
} from '../../src/storage/repositories/sessions.mjs';
import {BilibiliError} from '../../src/platforms/bilibili/api.mjs';
import {
  classifyHistoricPlatformStatus,
  repairBilibiliPlatformStatuses
} from '../../src/platforms/bilibili/recovery.mjs';

const T0 = Date.parse('2026-11-10T00:00:00.000Z');
const NINE_HOURS = 9 * 60 * 60 * 1000;

function createDb() {
  const db = openDatabase({memory: true});
  migrate(db, {now: T0});
  return db;
}

function makeSession(db, {id, room, status = 'live', reason = null, endedAt = null, messages = 0, lastEventAt = null}) {
  const session = createSession(db, {
    id,
    platform: 'bilibili',
    platformRoomId: room,
    roomTitle: `room ${room}`,
    startedAt: T0 - NINE_HOURS,
    now: T0 - NINE_HOURS
  });
  if (messages > 0 || lastEventAt !== null) {
    db.prepare('UPDATE sessions SET message_count = ?, last_event_at = ? WHERE id = ?')
      .run(messages, lastEventAt, id);
  }
  if (status !== 'live') {
    endSession(db, id, {status, endedAt: endedAt ?? T0 - 1000, reason});
  }
  return session;
}

test('startup recovery uses the detection time and never invents a platform end', () => {
  const db = createDb();
  try {
    makeSession(db, {
      id: 'ses_crash',
      room: '5001',
      messages: 42,
      lastEventAt: T0 - NINE_HOURS + 30 * 60 * 1000
    });

    const recovered = recoverInterruptedSessions(db, {now: T0});
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].id, 'ses_crash');

    const row = getSession(db, 'ses_crash');
    assert.equal(row.status, 'interrupted');
    assert.equal(row.end_reason, 'startup_recovery');
    // The old implementation copied last_event_at into ended_at, presenting the
    // last chat message as the broadcast end. That time is hours earlier.
    assert.equal(row.ended_at, T0);
    assert.notEqual(row.ended_at, row.last_event_at);
    assert.equal(row.platform_status, null);
    assert.equal(row.platform_ended_at, null);
    assert.equal(row.platform_end_quality, null);
    assert.equal(row.last_live_seen_at, null);
    assert.equal(row.message_count, 42);

    // Recovery is a one-shot operation for rows that were live.
    assert.equal(recoverInterruptedSessions(db, {now: T0 + 1000}).length, 0);
  } finally {
    db.close();
  }
});

test('historical repair annotates only eligible rows, never rewrites ended_at, and is idempotent', async () => {
  const db = createDb();
  try {
    makeSession(db, {
      id: 'ses_startup',
      room: '6001',
      status: 'interrupted',
      reason: 'startup_recovery',
      messages: 12,
      lastEventAt: T0 - 5 * 60 * 60 * 1000
    });
    makeSession(db, {
      id: 'ses_shutdown_empty',
      room: '6002',
      status: 'interrupted',
      reason: 'shutdown',
      messages: 0
    });
    makeSession(db, {
      id: 'ses_user',
      room: '6003',
      status: 'ended',
      reason: 'user',
      messages: 3,
      endedAt: T0 - 2000
    });
    makeSession(db, {
      id: 'ses_already',
      room: '6004',
      status: 'ended',
      reason: 'platform_ended',
      messages: 4,
      endedAt: T0 - 3000
    });
    db.prepare("UPDATE sessions SET platform_status = 'ended', platform_ended_at = ? WHERE id = 'ses_already'")
      .run(T0 - 3000);

    const candidates = listSessionsNeedingPlatformRepair(db, {limit: 10});
    assert.deepEqual(candidates.map((row) => row.id).sort(), ['ses_shutdown_empty', 'ses_startup'].sort());

    const before = new Map(candidates.map((row) => [row.id, {
      ended_at: row.ended_at,
      started_at: row.started_at,
      message_count: row.message_count
    }]));

    const logs = [];
    const api = {
      calls: 0,
      async roomStatus(roomId) {
        api.calls += 1;
        return {roomId: Number(roomId), liveStatus: 0, liveTime: null, title: null, online: null};
      }
    };
    const updatedIds = [];
    const result = await repairBilibiliPlatformStatuses({
      db,
      api,
      now: T0,
      logger: {info: (record) => logs.push(record), warn: () => {}},
      onUpdated: (id) => updatedIds.push(id)
    });
    assert.deepEqual(result, {checked: 2, updated: 2, failed: 0, skipped: 0});
    assert.equal(api.calls, 2);
    assert.equal(updatedIds.length, 2);
    assert.equal(logs.filter((record) => record.event === 'session.platform.repaired').length, 2);
    assert.ok(logs.every((record) => record.endedAtUnchanged === true));

    const startup = getSession(db, 'ses_startup');
    assert.equal(startup.platform_status, 'ended');
    assert.equal(startup.platform_status_at, T0);
    assert.equal(startup.platform_ended_at, null, 'the true end time is unknown');
    assert.equal(startup.platform_end_quality, 'unknown');
    assert.equal(startup.ended_at, before.get('ses_startup').ended_at);
    assert.equal(startup.started_at, before.get('ses_startup').started_at);
    assert.equal(startup.message_count, before.get('ses_startup').message_count);

    const empty = getSession(db, 'ses_shutdown_empty');
    assert.equal(empty.platform_status, 'unknown', 'no evidence means no invented end');
    assert.equal(empty.platform_ended_at, null);

    // User stops and already classified platform ends are untouched.
    assert.equal(getSession(db, 'ses_user').platform_status, null);
    assert.equal(getSession(db, 'ses_already').platform_status, 'ended');

    const second = await repairBilibiliPlatformStatuses({db, api, now: T0 + 1000});
    assert.deepEqual(second, {checked: 0, updated: 0, failed: 0, skipped: 0});
    assert.equal(api.calls, 2, 'already repaired rows must not be queried again');
  } finally {
    db.close();
  }
});

test('a failed status query leaves the historical row untouched for a later retry', async () => {
  const db = createDb();
  try {
    makeSession(db, {
      id: 'ses_retry',
      room: '7001',
      status: 'interrupted',
      reason: 'startup_recovery',
      messages: 1
    });

    const failing = {
      async roomStatus() {
        throw new BilibiliError('HTTP', 'HTTP 429', {status: 429});
      }
    };
    const failed = await repairBilibiliPlatformStatuses({db, api: failing, now: T0});
    assert.deepEqual(failed, {checked: 1, updated: 0, failed: 1, skipped: 0});
    assert.equal(getSession(db, 'ses_retry').platform_status, null);
    assert.equal(getSession(db, 'ses_retry').ended_at, T0 - 1000);

    const carousel = {async roomStatus(roomId) {
      return {roomId: Number(roomId), liveStatus: 2, liveTime: null, title: null, online: null};
    }};
    const retried = await repairBilibiliPlatformStatuses({db, api: carousel, now: T0 + 500});
    assert.deepEqual(retried, {checked: 1, updated: 1, failed: 0, skipped: 0});
    const row = getSession(db, 'ses_retry');
    assert.equal(row.platform_status, 'carousel');
    assert.equal(row.platform_ended_at, null);
    assert.equal(row.platform_end_quality, 'unknown');
    assert.equal(row.ended_at, T0 - 1000, 'repair must not change local capture end');
  } finally {
    db.close();
  }
});

test('a currently live room does not turn an old capture into a live one', () => {
  assert.equal(classifyHistoricPlatformStatus({end_reason: 'startup_recovery'}, 1), 'unknown');
  assert.equal(classifyHistoricPlatformStatus({end_reason: 'startup_recovery'}, 2), 'carousel');
  assert.equal(classifyHistoricPlatformStatus({end_reason: 'startup_recovery'}, 0), 'ended');
  assert.equal(classifyHistoricPlatformStatus({end_reason: 'shutdown', message_count: 0}, 0), 'unknown');
  assert.equal(classifyHistoricPlatformStatus({end_reason: 'shutdown', message_count: 4}, 0), 'ended');
  assert.equal(classifyHistoricPlatformStatus({end_reason: 'shutdown', last_event_at: T0}, 0), 'ended');
  assert.equal(classifyHistoricPlatformStatus({end_reason: 'shutdown'}, 9), 'unknown');
});
