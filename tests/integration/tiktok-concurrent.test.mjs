import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {openDatabase, closeDatabase} from '../../src/storage/database/connection.mjs';
import {migrate} from '../../src/storage/database/migrations/index.mjs';
import {SessionManager} from '../../src/platforms/shared/session-manager.mjs';
import {TikTokService} from '../../src/platforms/tiktok/service.mjs';
import {getSession} from '../../src/storage/repositories/sessions.mjs';
import {listSessionViewers} from '../../src/storage/repositories/viewers.mjs';
import {chatMessage, fetchResult} from '../helpers/tiktok-frames.mjs';
import {FakeWebSocket} from '../helpers/tiktok-ws-fake.mjs';
import {encodePushFrame} from '../../src/platforms/tiktok/webcast.mjs';

/**
 * Two different TikTok LIVE rooms captured through the real anonymous local
 * WebSocket adapter, SessionManager, EventIngest and SQLite.
 *
 * The sockets are fake and every nickname/message below is fabricated: this is
 * an automated transport-level test, not a real TikTok capture. A single room
 * can never be started twice; different rooms are fully independent.
 */

const T0 = 1700000000000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeout = 6000) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error('waitFor timeout');
    await sleep(10);
  }
}

function room(uniqueId, roomId, nickname, isLive = true) {
  return {
    uniqueId,
    roomId,
    anchorUid: `anchor-${roomId}`,
    anchorName: nickname,
    isLive,
    status: isLive ? 2 : 4,
    title: `${nickname} live`,
    startedAt: T0,
    checkedAt: T0,
    liveUrl: `https://www.tiktok.com/@${uniqueId}/live`
  };
}

function fakeClient(rooms) {
  return {
    async resolveRoom(input) {
      const uniqueId = typeof input === 'string' ? input : input?.uniqueId;
      const found = rooms[String(uniqueId).replace(/^@/, '')];
      if (!found) {
        const error = new Error('not found');
        error.code = 'TIKTOK_ROOM_NOT_FOUND';
        throw error;
      }
      return found;
    },
    async checkRoom(input) {
      return this.resolveRoom(input);
    },
    async fetchRoomInfo(roomId) {
      const found = Object.values(rooms).find((entry) => entry.roomId === roomId);
      if (!found) {
        const error = new Error('not found');
        error.code = 'TIKTOK_ROOM_NOT_FOUND';
        throw error;
      }
      return {
        roomId: found.roomId,
        isLive: found.isLive,
        title: found.title,
        anchorUid: found.anchorUid,
        anchorName: found.anchorName
      };
    },
    async fetchGiftCatalog() {
      return new Map();
    }
  };
}

function fakeTtwid() {
  return {
    get: async () => 'anon-device-cookie-value',
    snapshot: () => ({cached: true, fetchCount: 1, retryCount: 0, source: 'test'})
  };
}

function harness(rooms, adapterOptions = {}) {
  FakeWebSocket.reset();
  const db = openDatabase({memory: true});
  migrate(db, {now: T0});
  const sessionManager = new SessionManager({
    db,
    settings: {get: () => ({storageMode: 'compact'})},
    now: () => T0
  });
  const tiktok = new TikTokService({
    sessionManager,
    db,
    client: fakeClient(rooms),
    ttwidProvider: fakeTtwid(),
    WebSocketImpl: FakeWebSocket,
    now: () => T0,
    adapterOptions: {
      statusIntervalMs: 100000,
      statusCheckDelayMs: 100000,
      streakFlushMs: 100000,
      maxBackoffMs: 30,
      heartbeatIntervalMs: 100000,
      ...adapterOptions
    }
  });
  return {db, sessionManager, tiktok};
}

/** Start one capture and complete the fake WebSocket handshake it opens. */
async function connect(service, input) {
  const before = FakeWebSocket.instances.length;
  const running = service.connect(input);
  const ws = await waitFor(() => (
    FakeWebSocket.instances.length > before ? FakeWebSocket.instances.at(-1) : null
  ));
  if (ws.readyState === 0) ws.open();
  const result = await running;
  return {result, ws};
}

function frame(entries) {
  return encodePushFrame({payload: gzipSync(fetchResult({messages: entries}))});
}

function chat(msgId, userId, nickname, content) {
  return {
    method: 'WebcastChatMessage',
    payload: chatMessage({msgId, userId, nickname, content}),
    msgId: BigInt(msgId)
  };
}

function eventCount(db, sessionId) {
  return db.prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?').get(sessionId).c;
}

async function waitForEvents(db, sessionId, expected) {
  await waitFor(() => eventCount(db, sessionId) >= expected);
}

function twoRooms() {
  return {
    creator: room('creator', '7700000000000000123', 'Creator One'),
    other: room('other', '7700000000000000456', 'Creator Two')
  };
}

test('two different TikTok rooms record concurrently with isolated sessions and dedupe', async () => {
  const rooms = twoRooms();
  const {db, sessionManager, tiktok} = harness(rooms);
  try {
    const a = await connect(tiktok, '@creator');
    const b = await connect(tiktok, '@other');
    const sessionA = a.result.session.id;
    const sessionB = b.result.session.id;

    assert.notEqual(sessionA, sessionB);
    assert.notEqual(a.ws, b.ws, 'each room owns its own WebSocket');
    assert.equal(a.result.session.platform_room_id, '7700000000000000123');
    assert.equal(b.result.session.platform_room_id, '7700000000000000456');
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE platform = 'tiktok' AND status = 'live'").get().c, 2);

    const status = tiktok.status();
    assert.equal(status.recordings.length, 2);
    assert.deepEqual(
      status.recordings.map((recording) => recording.sessionId).sort(),
      [sessionA, sessionB].sort()
    );
    assert.equal(new Set(status.recordings.map((recording) => recording.platformRoomId)).size, 2);

    // The same platform message id and the same stable uid are legitimate in
    // two different sessions: the unique index is (session_id, dedupe_key).
    a.ws.deliver(frame([chat('9001', '101', 'Shared Viewer', 'from room A')]));
    b.ws.deliver(frame([
      chat('9001', '101', 'Shared Viewer', 'from room B'),
      chat('9002', '202', 'B Viewer', 'only in B')
    ]));
    await waitForEvents(db, sessionA, 1);
    await waitForEvents(db, sessionB, 2);

    const eventsA = db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY id').all(sessionA);
    const eventsB = db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY id').all(sessionB);
    assert.equal(eventsA.length, 1);
    assert.equal(eventsB.length, 2);
    assert.ok(eventsA.every((event) => event.session_id === sessionA));
    assert.ok(eventsB.every((event) => event.session_id === sessionB));
    assert.equal(eventsA[0].external_id, '9001');
    assert.equal(eventsB[0].external_id, '9001');
    assert.equal(eventsA[0].content, 'from room A');
    assert.equal(eventsB[0].content, 'from room B');

    // Stable uids are scoped to their own session viewer rows.
    assert.deepEqual(listSessionViewers(db, sessionA).map((viewer) => viewer.platform_uid), ['101']);
    assert.deepEqual(
      listSessionViewers(db, sessionB).map((viewer) => viewer.platform_uid).sort(),
      ['101', '202']
    );
    assert.equal(getSession(db, sessionA).broadcaster_id, 'tiktok:anchor-7700000000000000123');
    assert.equal(getSession(db, sessionB).broadcaster_id, 'tiktok:anchor-7700000000000000456');
    assert.equal(a.result.connection.uniqueId ?? a.result.connection.detail?.uniqueId, 'creator');
    assert.equal(b.result.connection.uniqueId ?? b.result.connection.detail?.uniqueId, 'other');

    // Starting the same room again is refused and never creates a second A.
    await assert.rejects(
      () => tiktok.connect('@creator'),
      (error) => error.code === 'SESSION_DUPLICATE_ROOM'
        && error.details?.sessionId === sessionA
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c, 2);
    assert.equal(tiktok.status().recordings.length, 2);

    // Stopping A leaves B connected and still ingesting.
    const stopped = await tiktok.disconnect({sessionId: sessionA});
    assert.equal(stopped.stopped, true);
    assert.equal(getSession(db, sessionA).status, 'ended');
    assert.equal(getSession(db, sessionB).status, 'live');
    assert.equal(tiktok.status().recordings.length, 1);
    assert.equal(tiktok.status().recordings[0].sessionId, sessionB);

    b.ws.deliver(frame([chat('9003', '202', 'B Viewer', 'after A stopped')]));
    await waitForEvents(db, sessionB, 3);
    assert.equal(eventCount(db, sessionA), 1, 'A never receives B events');
    assert.equal(b.ws.readyState, 1, 'B socket was never closed by A stop');

    await sessionManager.shutdown();
  } finally {
    await sessionManager.shutdown().catch(() => {});
    closeDatabase(db);
  }
});

test('A dropping its socket reconnects in the same session and does not disturb B', async () => {
  const rooms = twoRooms();
  const {db, sessionManager, tiktok} = harness(rooms);
  try {
    const a = await connect(tiktok, '@creator');
    const b = await connect(tiktok, '@other');
    const sessionA = a.result.session.id;
    const sessionB = b.result.session.id;

    b.ws.deliver(frame([chat('9101', '303', 'B Viewer', 'B before A drop')]));
    await waitForEvents(db, sessionB, 1);

    a.ws.drop({code: 1006});
    const reconnected = await waitFor(() => (
      FakeWebSocket.instances.length >= 3 ? FakeWebSocket.instances.at(-1) : null
    ));
    assert.notEqual(reconnected, a.ws);
    assert.notEqual(reconnected, b.ws, 'B keeps its original socket');
    reconnected.open();
    await waitFor(() => {
      const recordings = tiktok.status().recordings;
      const recordingA = recordings.find((recording) => recording.sessionId === sessionA);
      return recordingA && Number(recordingA.capture?.counters?.connections) >= 2 ? recordingA : null;
    });

    assert.equal(b.ws.readyState === 1 || b.ws.readyState === 0, true);
    b.ws.deliver(frame([chat('9102', '303', 'B Viewer', 'B after A drop')]));
    await waitForEvents(db, sessionB, 2);

    assert.equal(getSession(db, sessionA).status, 'live');
    assert.equal(getSession(db, sessionB).status, 'live');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c, 2, 'reconnect never creates a second A');
    const recordingA = tiktok.status().recordings.find((recording) => recording.sessionId === sessionA);
    assert.equal(recordingA.capture.counters.connections, 2);
    assert.equal(recordingA.capture.possibleGap, true);

    await sessionManager.shutdown();
  } finally {
    await sessionManager.shutdown().catch(() => {});
    closeDatabase(db);
  }
});

test('room A ending on its own never ends room B', async () => {
  const rooms = twoRooms();
  const {db, sessionManager, tiktok} = harness(rooms, {
    statusCheckDelayMs: 20,
    statusIntervalMs: 30
  });
  try {
    const a = await connect(tiktok, '@creator');
    const b = await connect(tiktok, '@other');
    const sessionA = a.result.session.id;
    const sessionB = b.result.session.id;

    b.ws.deliver(frame([chat('9201', '404', 'B Viewer', 'B before A ends')]));
    await waitForEvents(db, sessionB, 1);

    // The platform reports room A as no longer live; two observations confirm
    // it. B is untouched, keeps its socket and keeps recording.
    rooms.creator.isLive = false;
    rooms.creator.status = 4;
    await waitFor(() => getSession(db, sessionA).status === 'ended');
    assert.equal(getSession(db, sessionB).status, 'live');
    assert.equal(b.ws.readyState, 1);

    b.ws.deliver(frame([chat('9202', '404', 'B Viewer', 'B after A ended')]));
    await waitForEvents(db, sessionB, 2);
    assert.equal(eventCount(db, sessionA), 0);
    assert.equal(tiktok.status().recordings.length, 1);
    assert.equal(tiktok.status().recordings[0].sessionId, sessionB);

    await sessionManager.shutdown();
  } finally {
    await sessionManager.shutdown().catch(() => {});
    closeDatabase(db);
  }
});
