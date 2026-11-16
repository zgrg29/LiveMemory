import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {openDatabase} from '../../src/storage/database/connection.mjs';
import {migrate} from '../../src/storage/database/migrations/index.mjs';
import {SessionManager} from '../../src/platforms/shared/session-manager.mjs';
import {TikTokService} from '../../src/platforms/tiktok/service.mjs';
import {getSession} from '../../src/storage/repositories/sessions.mjs';
import {listSessionViewers, viewerCurrencyTotals} from '../../src/storage/repositories/viewers.mjs';
import {buildAnalysisPackage} from '../../src/ai/export/package.mjs';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {chatMessage, fetchResult, giftMessage, roomUserSeqMessage} from '../helpers/tiktok-frames.mjs';
import {FakeWebSocket} from '../helpers/tiktok-ws-fake.mjs';
import {encodePushFrame} from '../../src/platforms/tiktok/webcast.mjs';

/**
 * TikTok anonymous local WebSocket -> mapper -> EventIngest -> SQLite -> AI
 * package, with a real SessionManager and database.
 *
 * The socket is a fake: no real TikTok request is made. Payloads use the same
 * protobuf field numbers as the frames captured from a real live room, so this
 * covers the pipeline rather than the network.
 */

const T0 = 1700000000000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeout = 5000) {
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
      const found = rooms[String(uniqueId)];
      if (!found) {
        const error = new Error('not found');
        error.code = 'TIKTOK_ROOM_NOT_FOUND';
        throw error;
      }
      return found;
    },
    async checkRoom(input) {
      const uniqueId = typeof input === 'string' ? input : input?.uniqueId;
      const found = rooms[String(uniqueId)];
      if (!found) {
        const error = new Error('not found');
        error.code = 'TIKTOK_ROOM_NOT_FOUND';
        throw error;
      }
      return found;
    },
    async fetchRoomInfo(roomId) {
      const found = Object.values(rooms).find((entry) => entry.roomId === roomId);
      if (!found) {
        const error = new Error('not found');
        error.code = 'TIKTOK_ROOM_NOT_FOUND';
        throw error;
      }
      return {roomId: found.roomId, isLive: found.isLive, title: found.title, anchorUid: found.anchorUid, anchorName: found.anchorName};
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

function harness(rooms = {creator: room('creator', '7700000000000000123', 'Creator One')}) {
  FakeWebSocket.reset();
  const db = openDatabase({memory: true});
  migrate(db, {now: T0});
  const sessionManager = new SessionManager({db, settings: {get: () => ({storageMode: 'compact'})}, now: () => T0});
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
      heartbeatIntervalMs: 100000
    }
  });
  return {db, sessionManager, tiktok};
}

/** Start a capture and complete the fake socket handshake it opens. */
async function connect(service, input) {
  const before = FakeWebSocket.instances.length;
  const running = service.connect(input);
  const ws = await waitFor(() => (FakeWebSocket.instances.length > before ? FakeWebSocket.instances.at(-1) : null));
  if (ws.readyState === 0) ws.open();
  const result = await running;
  return {result, ws};
}

function frame(entries, {logId = null} = {}) {
  return encodePushFrame({payload: gzipSync(fetchResult({messages: entries})), logId});
}

function chatEntry({msgId, userId = '4242', nickname = 'Alice', content = 'hello'}) {
  return {
    method: 'WebcastChatMessage',
    payload: chatMessage({msgId, userId, nickname, content}),
    msgId: BigInt(msgId)
  };
}

test('a TikTok live room records chat, stable viewer identity and the AI package', async () => {
  const {db, sessionManager, tiktok} = harness();
  const temp = createTempDir('tiktok-session-');
  try {
    const {result, ws} = await connect(tiktok, 'https://www.tiktok.com/@creator/live');
    assert.equal(result.room.isLive, true);
    assert.equal(result.connection.transport, 'local');
    assert.equal(result.connection.protocol, 'webcast-ws');

    ws.deliver(frame([
      chatEntry({msgId: '1001', userId: '4242', nickname: 'Alice', content: 'こんにちは 🌏'}),
      chatEntry({msgId: '1002', userId: '4242', nickname: 'Alice', content: '你好'}),
      chatEntry({msgId: '1003', userId: '7777', nickname: 'Bob', content: 'hello'}),
      {method: 'WebcastRoomUserSeqMessage', payload: roomUserSeqMessage({msgId: '6001', viewerCount: 321}), msgId: 6001n}
    ]));

    const sessionId = result.session.id;
    await waitFor(() => db.prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?').get(sessionId).c >= 3);
    const events = db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY id').all(sessionId);
    assert.deepEqual(events.map((event) => event.event_type), ['chat', 'chat', 'chat']);
    assert.equal(events[0].viewer_uid, '4242');
    assert.equal(events[0].display_name, 'Alice');
    assert.equal(events[0].external_id, '1001');
    assert.equal(events[0].content, 'こんにちは 🌏');
    assert.equal(events[0].source_quality, 'verified');

    const viewers = listSessionViewers(db, sessionId);
    assert.equal(viewers.length, 2, 'two stable ids, not two nicknames');
    assert.deepEqual(viewers.map((viewer) => viewer.platform_uid).sort(), ['4242', '7777']);

    const session = getSession(db, sessionId);
    assert.equal(session.platform, 'tiktok');
    assert.equal(session.platform_room_id, '7700000000000000123');
    assert.equal(session.broadcaster_id, 'tiktok:anchor-7700000000000000123');

    // The AI package reads the same rows; AI never edits them.
    const pkg = await buildAnalysisPackage({
      db,
      sessionId,
      locale: 'en',
      exportsDir: join(temp.dir, 'exports'),
      now: T0
    });
    assert.ok(pkg, 'an analysis package is produced');

    await sessionManager.shutdown();
  } finally {
    await sessionManager.shutdown().catch(() => {});
    temp.cleanup();
  }
});

test('a gift streak becomes one paid event with the final quantity and no income amount', async () => {
  const {db, sessionManager, tiktok} = harness();
  try {
    const {result, ws} = await connect(tiktok, '@creator');
    const sessionId = result.session.id;
    ws.deliver(frame([
      {method: 'WebcastGiftMessage', payload: giftMessage({msgId: '2001', giftId: 56560, giftName: 'Rose', diamonds: 1, repeatCount: 1, repeatEnd: 0, groupId: '77'}), msgId: 2001n},
      {method: 'WebcastGiftMessage', payload: giftMessage({msgId: '2002', giftId: 56560, giftName: 'Rose', diamonds: 1, repeatCount: 2, repeatEnd: 0, groupId: '77'}), msgId: 2002n},
      {method: 'WebcastGiftMessage', payload: giftMessage({msgId: '2003', giftId: 56560, giftName: 'Rose', diamonds: 1, repeatCount: 5, repeatEnd: 1, groupId: '77'}), msgId: 2003n}
    ]));
    await waitFor(() => db.prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ? AND event_type = ?').get(sessionId, 'gift').c === 1);
    const gifts = db.prepare('SELECT * FROM events WHERE session_id = ? AND event_type = ?').all(sessionId, 'gift');
    assert.equal(gifts.length, 1);
    assert.equal(gifts[0].gift_quantity, 5);
    assert.equal(gifts[0].amount_minor, null, 'diamonds are never income');
    assert.equal(gifts[0].value_kind, 'unknown');
    assert.equal(gifts[0].is_paid, 1);
    assert.match(gifts[0].amount_display ?? '', /Diamonds/);
    assert.equal(viewerCurrencyTotals(db, sessionId).length, 0, 'no currency total is invented for diamonds');
    await sessionManager.shutdown();
  } finally {
    await sessionManager.shutdown().catch(() => {});
  }
});

test('duplicate message ids never add a second row or count', async () => {
  const {db, sessionManager, tiktok} = harness();
  try {
    const {result, ws} = await connect(tiktok, '@creator');
    const sessionId = result.session.id;
    const entry = chatEntry({msgId: '3001', content: 'only once'});
    ws.deliver(frame([entry]));
    await waitFor(() => db.prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?').get(sessionId).c === 1);
    ws.deliver(frame([entry]));
    await sleep(80);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?').get(sessionId).c, 1);
    const viewer = listSessionViewers(db, sessionId)[0];
    assert.equal(viewer.message_count, 1);
    await sessionManager.shutdown();
  } finally {
    await sessionManager.shutdown().catch(() => {});
  }
});

test('a dropped socket reconnects into the same session and records the gap', async () => {
  const {db, sessionManager, tiktok} = harness();
  try {
    const {result, ws} = await connect(tiktok, '@creator');
    const sessionId = result.session.id;
    ws.deliver(frame([chatEntry({msgId: '4001', content: 'before'})]));
    await waitFor(() => db.prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?').get(sessionId).c === 1);

    ws.drop({code: 1006});
    const second = await waitFor(() => (FakeWebSocket.instances.length >= 2 ? FakeWebSocket.instances[1] : null));
    second.open();
    await waitFor(() => tiktok.status().capture?.category === 'normal');
    const capture = tiktok.status().capture;
    assert.equal(capture.counters.connections, 2);
    assert.equal(capture.possibleGap, true);

    second.deliver(frame([chatEntry({msgId: '4002', content: 'after'})]));
    await waitFor(() => db.prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?').get(sessionId).c === 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c, 1, 'same session, not a new recording');
    await sessionManager.shutdown();
  } finally {
    await sessionManager.shutdown().catch(() => {});
  }
});

test('the same room cannot be recorded twice and other creators stay independent', async () => {
  const rooms = {
    creator: room('creator', '7700000000000000123', 'Creator One'),
    other: room('other', '7700000000000000456', 'Creator Two')
  };
  const {sessionManager, tiktok} = harness(rooms);
  try {
    const first = await connect(tiktok, '@creator');
    await assert.rejects(() => tiktok.connect('@creator'), (error) => String(error.code).includes('DUPLICATE'));

    const second = await connect(tiktok, '@other');
    assert.notEqual(first.result.session.id, second.result.session.id);
    const status = tiktok.status();
    assert.equal(status.recordings.length, 2);
    assert.equal(new Set(status.recordings.map((recording) => recording.sessionId)).size, 2);
    await sessionManager.shutdown();
  } finally {
    await sessionManager.shutdown().catch(() => {});
  }
});

test('status exposes one no-login transport and the honest capability boundaries', () => {
  const {sessionManager, tiktok} = harness();
  try {
    const status = tiktok.status();
    assert.equal(status.mode, 'local');
    assert.equal(status.transport.active, 'local');
    assert.equal(status.transport.protocol, 'webcast-ws');
    assert.equal(status.transport.requiresLogin, false);
    assert.equal(status.transport.requiresPaidService, false);
    assert.equal(status.transport.requiresBrowser, false);
    assert.equal(status.capabilities.requiresLogin, false);
    assert.equal(status.capabilities.requiresSigningService, false);
    assert.equal(status.capabilities.stableUserId, true);
    assert.equal(status.capabilities.messageId, true);
    assert.equal(status.login, undefined, 'no login state exists for TikTok any more');
    assert.ok(status.policy, 'the 30-day raw-content policy is still reported');
  } finally {
    sessionManager.shutdown().catch(() => {});
  }
});

test('stopping reports stopped and keeps a last capture for the UI', async () => {
  const {sessionManager, tiktok} = harness();
  try {
    const {result, ws} = await connect(tiktok, '@creator');
    ws.deliver(frame([chatEntry({msgId: '5001'})]));
    await waitFor(() => (tiktok.status().capture?.counters?.chats ?? 0) === 1);
    const stopped = await tiktok.disconnect({sessionId: result.session.id});
    assert.equal(stopped.stopped, true);
    const status = tiktok.status();
    assert.equal(status.captureSource, 'last_attempt');
    assert.equal(status.capture.captureState, 'stopped');
    assert.equal(status.recordings.length, 0);
    await sessionManager.shutdown();
  } finally {
    await sessionManager.shutdown().catch(() => {});
  }
});

test('a room that is not live is refused before a session exists', async () => {
  const {db, sessionManager, tiktok} = harness({offline: room('offline', '7700000000000000789', 'Offline', false)});
  try {
    await assert.rejects(() => tiktok.connect('@offline'), (error) => error.code === 'TIKTOK_ROOM_OFFLINE');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c, 0);
    assert.equal(FakeWebSocket.instances.length, 0, 'no socket is opened for an offline room');
  } finally {
    await sessionManager.shutdown().catch(() => {});
  }
});

test('a stop through the shared recording action still reports stopped', async () => {
  const {sessionManager, tiktok} = harness();
  try {
    const {result} = await connect(tiktok, '@creator');
    // The live/history pages stop a session through the shared session manager,
    // not through TikTokService.disconnect(). The capture card must not fall
    // back to "not started" after that.
    const stopped = await sessionManager.stopSession(result.session.id, {status: 'ended', reason: 'stopped'});
    assert.equal(stopped.stopped, true);
    const status = tiktok.status();
    assert.equal(status.recordings.length, 0);
    assert.equal(status.capture?.captureState, 'stopped');
    assert.equal(status.captureSource, 'last_attempt');
    await sessionManager.shutdown();
  } finally {
    await sessionManager.shutdown().catch(() => {});
  }
});
