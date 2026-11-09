import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase, closeDatabase} from '../../src/storage/database/connection.mjs';
import {migrate} from '../../src/storage/database/migrations/index.mjs';
import {getSession} from '../../src/storage/repositories/sessions.mjs';
import {listEvents} from '../../src/storage/repositories/events.mjs';
import {buildSessionLeaderboard, LEADERBOARD_LIMIT} from '../../src/analytics/sessions/leaderboard.mjs';
import {buildSessionSummary} from '../../src/analytics/sessions/summary.mjs';
import {createSession, endSession} from '../../src/storage/repositories/sessions.mjs';
import {upsertBroadcaster} from '../../src/storage/repositories/broadcasters.mjs';
import {EventIngest} from '../../src/platforms/shared/ingest.mjs';
import {SessionManager} from '../../src/platforms/shared/session-manager.mjs';

/**
 * Concurrent recording must be independent at the manager level.
 *
 * These tests use real SQLite and the real ingest pipeline. The transport is a
 * controllable fake adapter, so no network is involved — this is deliberately
 * an automated simulation, not a real platform capture.
 */

const T0 = Date.parse('2026-11-09T10:00:00.000Z');
const settings = {get: () => ({storageMode: 'compact'})};

class FakeAdapter {
  constructor(name) {
    this.name = name;
    this.state = 'idle';
    this.detail = null;
    this.stopped = 0;
    this.handlers = null;
  }

  async start(context) {
    this.handlers = context;
    this.state = 'connected';
    this.detail = {fake: this.name};
    context.onStateChange?.({state: 'connected', detail: this.detail});
  }

  emit(draft) {
    this.handlers?.onEvent?.(draft);
  }

  end(reason = 'fake_end') {
    this.handlers?.onEnd?.({reason});
  }

  async stop() {
    this.stopped += 1;
    this.state = 'stopped';
  }

  snapshot() {
    return {id: this.name, state: this.state, detail: this.detail};
  }
}

function chat(platform, uid, name, at, content, externalId) {
  return {
    platform,
    event_type: 'chat',
    viewer_uid: uid,
    display_name: name,
    occurred_at: at,
    content,
    external_id: externalId,
    source_quality: 'verified'
  };
}

function createManager() {
  const db = openDatabase({memory: true});
  migrate(db, {now: T0});
  const manager = new SessionManager({db, settings, now: () => T0});
  return {db, manager};
}

function startFake(manager, {platform, roomId, broadcasterUid, broadcasterName, name}) {
  const adapter = new FakeAdapter(name);
  return manager.startPlatform({
    platform,
    platformRoomId: roomId,
    roomTitle: `${name} live`,
    broadcasterName,
    broadcasterUid,
    sourceQuality: 'verified',
    simulated: false,
    createAdapter: () => adapter
  }).then((result) => ({result, adapter}));
}

test('two recordings keep their own adapters, sessions and events', async () => {
  const {db, manager} = createManager();
  try {
    const {result: a, adapter: adapterA} = await startFake(manager, {
      platform: 'youtube',
      roomId: 'video-a',
      broadcasterUid: 'UC_CHANNEL_A',
      broadcasterName: 'Channel A',
      name: 'a'
    });
    const {result: b, adapter: adapterB} = await startFake(manager, {
      platform: 'bilibili',
      roomId: '5050',
      broadcasterUid: '9001',
      broadcasterName: 'Channel B',
      name: 'b'
    });
    assert.equal(a.started, true);
    assert.equal(b.started, true);
    assert.notEqual(a.session.id, b.session.id);
    assert.equal(manager.listRecordings().length, 2);

    adapterA.emit(chat('youtube', 'UC_SAME', 'Same', T0 + 1000, 'from A', 'a-1'));
    adapterA.emit(chat('youtube', 'UC_SAME', 'Same renamed', T0 + 2000, 'from A again', 'a-2'));
    adapterB.emit(chat('bilibili', 'UC_SAME', 'Same', T0 + 1000, 'from B', 'b-1'));
    adapterB.emit(chat('bilibili', 'UC_OTHER', 'Twin', T0 + 2000, 'from B 2', 'b-2'));

    const aEvents = listEvents(db, {sessionId: a.session.id, limit: 50});
    const bEvents = listEvents(db, {sessionId: b.session.id, limit: 50});
    assert.deepEqual(aEvents.map((event) => event.external_id).sort(), ['a-1', 'a-2']);
    assert.deepEqual(bEvents.map((event) => event.external_id).sort(), ['b-1', 'b-2']);
    assert.ok(aEvents.every((event) => event.session_id === a.session.id));
    assert.ok(bEvents.every((event) => event.session_id === b.session.id));

    const viewerSession = db.prepare(`
      SELECT vs.session_id, vs.message_count
        FROM viewer_sessions vs
       WHERE vs.viewer_id = 'youtube:UC_SAME'
       ORDER BY vs.session_id
    `).all();
    assert.deepEqual(viewerSession.map((row) => Number(row.message_count)).sort((x, y) => x - y), [2]);
    // The same platform uid (YouTube) is global, while its two broadcaster
    // contexts stay independent.
    const relationships = db.prepare(`
      SELECT broadcaster_id, message_count FROM viewer_broadcasters
       WHERE viewer_id = 'youtube:UC_SAME'
    `).all();
    assert.equal(relationships.length, 1);
    assert.equal(relationships[0].broadcaster_id, 'youtube:UC_CHANNEL_A');
    assert.equal(Number(relationships[0].message_count), 2);

    const status = manager.status();
    assert.equal(status.activeCount, 2);
    assert.equal(status.recordings.length, 2);
    assert.equal(status.connection, 'connected');
  } finally {
    await manager.shutdown();
    closeDatabase(db);
  }
});

test('a duplicate room is refused while other recordings continue', async () => {
  const {db, manager} = createManager();
  try {
    const {result: first, adapter} = await startFake(manager, {
      platform: 'youtube',
      roomId: 'same-video',
      broadcasterUid: 'UC_A',
      broadcasterName: 'A',
      name: 'first'
    });
    assert.equal(first.started, true);
    adapter.emit(chat('youtube', 'UC_1', 'One', T0 + 1000, 'hello', 'x-1'));

    const duplicate = await startFake(manager, {
      platform: 'youtube',
      roomId: 'same-video',
      broadcasterUid: 'UC_A',
      broadcasterName: 'A',
      name: 'second'
    });
    assert.equal(duplicate.result.started, false);
    assert.equal(duplicate.result.reason, 'duplicate_room');
    assert.equal(duplicate.result.duplicate.sessionId, first.session.id);
    assert.equal(manager.listRecordings().length, 1);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count,
      1
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE status = 'live'").get().count,
      1
    );
  } finally {
    await manager.shutdown();
    closeDatabase(db);
  }
});

test('stopping or failing one recording leaves the other running', async () => {
  const {db, manager} = createManager();
  try {
    const {result: a, adapter: adapterA} = await startFake(manager, {
      platform: 'youtube', roomId: 'video-a', broadcasterUid: 'UC_A', broadcasterName: 'A', name: 'a'
    });
    const {result: b, adapter: adapterB} = await startFake(manager, {
      platform: 'youtube', roomId: 'video-b', broadcasterUid: 'UC_B', broadcasterName: 'B', name: 'b'
    });
    adapterA.emit(chat('youtube', 'UC_A_VIEWER', 'A viewer', T0 + 1000, 'a1', 'a-1'));
    adapterB.emit(chat('youtube', 'UC_B_VIEWER', 'B viewer', T0 + 1000, 'b1', 'b-1'));

    const stopped = await manager.stopSession(a.session.id, {status: 'ended', reason: 'user'});
    assert.equal(stopped.stopped, true);
    assert.equal(adapterA.stopped, 1);
    assert.equal(getSession(db, a.session.id).status, 'ended');
    assert.equal(getSession(db, b.session.id).status, 'live');
    assert.equal(manager.listRecordings().length, 1);

    // B still ingests after A has been stopped.
    adapterB.emit(chat('youtube', 'UC_B_VIEWER', 'B viewer', T0 + 2000, 'b2', 'b-2'));
    assert.equal(listEvents(db, {sessionId: b.session.id, limit: 20}).length, 2);

    // A later connection failure ends B only.
    adapterB.end('connection_failed');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(getSession(db, b.session.id).status, 'ended');
    assert.equal(manager.listRecordings().length, 0);
    // A's recorded data is untouched by B's failure.
    assert.equal(listEvents(db, {sessionId: a.session.id, limit: 20}).length, 1);
  } finally {
    await manager.shutdown();
    closeDatabase(db);
  }
});

test('interleaved writes keep per-session dedupe and counts exact', async () => {
  const {db, manager} = createManager();
  try {
    const {result: a, adapter: adapterA} = await startFake(manager, {
      platform: 'youtube', roomId: 'interleave-a', broadcasterUid: 'UC_IA', broadcasterName: 'A', name: 'ia'
    });
    const {result: b, adapter: adapterB} = await startFake(manager, {
      platform: 'youtube', roomId: 'interleave-b', broadcasterUid: 'UC_IB', broadcasterName: 'B', name: 'ib'
    });
    for (let index = 0; index < 100; index += 1) {
      // The same external id is legitimate in two different sessions: the
      // unique index is (session_id, dedupe_key), so neither can swallow the
      // other broadcast's event.
      adapterA.emit(chat('youtube', 'UC_A', 'A viewer', T0 + index, `a${index}`, `shared-${index}`));
      adapterB.emit(chat('youtube', 'UC_B', 'B viewer', T0 + index, `b${index}`, `shared-${index}`));
    }
    // A repeated delivery inside one session must be ignored.
    adapterA.emit(chat('youtube', 'UC_A', 'A viewer', T0, 'a0', 'shared-0'));
    assert.equal(listEvents(db, {sessionId: a.session.id, limit: 500}).length, 100);
    assert.equal(listEvents(db, {sessionId: b.session.id, limit: 500}).length, 100);
    assert.equal(getSession(db, a.session.id).message_count, 100);
    assert.equal(getSession(db, b.session.id).message_count, 100);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM viewer_sessions WHERE session_id = ?').get(a.session.id).count,
      1
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM viewer_sessions WHERE session_id = ?').get(b.session.id).count,
      1
    );
  } finally {
    await manager.shutdown();
    closeDatabase(db);
  }
});

test('startup recovery never resurrects a previous live recording', async () => {
  const db = openDatabase({memory: true});
  migrate(db, {now: T0});
  try {
    const first = new SessionManager({db, settings, now: () => T0});
    await startFake(first, {
      platform: 'youtube', roomId: 'crash-video', broadcasterUid: 'UC_CRASH', broadcasterName: 'Crash', name: 'crash'
    });
    assert.equal(first.listRecordings().length, 1);

    const second = new SessionManager({db, settings, now: () => T0 + 1000});
    const recovered = second.recoverInterrupted();
    assert.equal(recovered.length, 1);
    assert.equal(second.listRecordings().length, 0);
    assert.equal(second.status().activeCount, 0);
    const row = db.prepare("SELECT status, ended_at FROM sessions WHERE platform_room_id = 'crash-video'").get();
    assert.equal(row.status, 'interrupted');
    assert.ok(row.ended_at);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 1);
  } finally {
    closeDatabase(db);
  }
});

test('the session leaderboard is capped at 100 with stable, identity-based ranks', () => {
  const db = openDatabase({memory: true});
  migrate(db, {now: T0});
  try {
    upsertBroadcaster(db, {
      id: 'youtube:UC_LEADER',
      platform: 'youtube',
      platformUid: 'UC_LEADER',
      displayName: 'Leader channel',
      identity: 'verified',
      seenAt: T0
    });
    const session = createSession(db, {
      id: 'ses_leader',
      platform: 'youtube',
      platformRoomId: 'leader-video',
      roomTitle: 'Leaderboard',
      broadcasterName: 'Leader channel',
      broadcasterId: 'youtube:UC_LEADER',
      broadcasterIdentity: 'verified',
      startedAt: T0
    });
    const ingest = new EventIngest({db, now: () => T0 + 1000});
    let counter = 0;
    const speak = (uid, name, count) => {
      for (let index = 0; index < count; index += 1) {
        counter += 1;
        ingest.record({
          ...chat('youtube', uid, name, T0 + counter, `m${counter}`, `led-${counter}`),
          session_id: session.id
        });
      }
    };
    speak('UC_TOP', 'Top Viewer', 5);
    speak('UC_SECOND', 'Second Viewer', 3);
    // Same nickname, different stable ids: they must stay two rows.
    speak('UC_TWIN_A', 'Same Name', 2);
    speak('UC_TWIN_B', 'Same Name', 2);
    // Equal message counts are ordered by stable uid, not by nickname.
    for (let index = 0; index < 118; index += 1) {
      speak(`UC_${String(index).padStart(3, '0')}`, `Viewer ${index}`, 1);
    }
    endSession(db, session.id, {status: 'ended', endedAt: T0 + 100000});

    const leaderboard = buildSessionLeaderboard(db, session.id, {limit: 100});
    assert.equal(leaderboard.limit, LEADERBOARD_LIMIT);
    assert.equal(leaderboard.total, 122);
    assert.equal(leaderboard.viewers.length, 100);
    assert.equal(leaderboard.viewers[0].rank, 1);
    assert.equal(leaderboard.viewers[0].viewerId, 'youtube:UC_TOP');
    assert.equal(leaderboard.viewers[0].messageCount, 5);
    assert.equal(leaderboard.viewers[1].rank, 2);
    assert.equal(leaderboard.viewers[1].viewerId, 'youtube:UC_SECOND');
    assert.equal(leaderboard.viewers.at(-1).rank, 100);
    assert.ok(leaderboard.viewers.every((row) => row.viewerId.includes(':')));

    const twins = leaderboard.viewers.filter((row) => row.nickname === 'Same Name');
    assert.equal(twins.length, 2);
    assert.deepEqual(twins.map((row) => row.viewerId).sort(), ['youtube:UC_TWIN_A', 'youtube:UC_TWIN_B']);

    const search = buildSessionLeaderboard(db, session.id, {limit: 100, query: 'top viewer'});
    assert.equal(search.viewers.length, 1);
    assert.equal(search.viewers[0].rank, 1);
    assert.equal(search.returned, 1);

    // Ties at the tail follow the stable uid order and are reproducible.
    const firstRun = buildSessionLeaderboard(db, session.id, {limit: 100}).viewers.map((row) => row.viewerId);
    const secondRun = buildSessionLeaderboard(db, session.id, {limit: 100}).viewers.map((row) => row.viewerId);
    assert.deepEqual(firstRun, secondRun);

    const summaryDefault = buildSessionSummary(db, session.id);
    assert.equal(summaryDefault.top.speakers.length, 5);
    const summary100 = buildSessionSummary(db, session.id, {topLimit: 100});
    assert.equal(summary100.top.speakers.length, 100);
  } finally {
    closeDatabase(db);
  }
});
