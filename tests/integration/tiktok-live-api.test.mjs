import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {startServer} from '../../src/server/index.mjs';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {chatMessage, fetchResult} from '../helpers/tiktok-frames.mjs';
import {FakeWebSocket} from '../helpers/tiktok-ws-fake.mjs';
import {encodePushFrame} from '../../src/platforms/tiktok/webcast.mjs';

/**
 * HTTP contract used by the live page while two TikTok rooms record.
 *
 * The TikTok WebSocket is a fake and the room metadata comes from a fake
 * client: this verifies the server/API/SQLite behaviour, not a real TikTok
 * capture. The assertions mirror what the tabbed UI renders.
 */

const T0 = 1700000000000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, {timeout = 10000, interval = 25} = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error('waitFor timeout');
    await sleep(interval);
  }
}

function jsonRequest(url, {method = 'GET', body} = {}) {
  return fetch(url, {
    method,
    headers: body === undefined ? {} : {'content-type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

function room(uniqueId, roomId, anchorName) {
  return {
    uniqueId,
    roomId,
    anchorUid: `anchor-${roomId}`,
    anchorName,
    isLive: true,
    status: 2,
    title: `${anchorName} live`,
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
      if (!found) throw Object.assign(new Error('not found'), {code: 'TIKTOK_ROOM_NOT_FOUND'});
      return found;
    },
    async checkRoom(input) {
      return this.resolveRoom(input);
    },
    async fetchRoomInfo(roomId) {
      const found = Object.values(rooms).find((entry) => entry.roomId === roomId);
      if (!found) throw Object.assign(new Error('not found'), {code: 'TIKTOK_ROOM_NOT_FOUND'});
      return found;
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

async function connect(base, handle) {
  const before = FakeWebSocket.instances.length;
  const running = jsonRequest(`${base}api/tiktok/connect`, {
    method: 'POST',
    body: {url: `https://www.tiktok.com/@${handle}/live`}
  });
  const ws = await waitFor(() => (
    FakeWebSocket.instances.length > before ? FakeWebSocket.instances.at(-1) : null
  ));
  if (ws.readyState === 0) ws.open();
  const response = await running;
  return {status: response.status, payload: await response.json(), ws};
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

async function sessionSummary(base, sessionId) {
  return (await jsonRequest(`${base}api/sessions/${encodeURIComponent(sessionId)}`)).json();
}

test('the live API exposes two concurrent TikTok rooms and keeps them independent', async (t) => {
  FakeWebSocket.reset();
  const temp = createTempDir('tiktok-live-api-');
  const rooms = {
    creator: room('creator', '7700000000000000123', 'Creator One'),
    other: room('other', '7700000000000000456', 'Creator Two')
  };
  const server = await startServer({
    auth: false,
    dataDir: temp.dir,
    port: 0,
    systemLocale: 'en',
    tiktokClient: fakeClient(rooms),
    tiktokWebSocketImpl: FakeWebSocket,
    tiktokTtwidProvider: fakeTtwid(),
    tiktokAdapterOptions: {
      statusIntervalMs: 100000,
      statusCheckDelayMs: 100000,
      streakFlushMs: 100000,
      maxBackoffMs: 30,
      heartbeatIntervalMs: 100000
    }
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  const base = server.url;

  const a = await connect(base, 'creator');
  const b = await connect(base, 'other');
  assert.equal(a.status, 201, JSON.stringify(a.payload));
  assert.equal(b.status, 201, JSON.stringify(b.payload));
  const sessionA = a.payload.session.id;
  const sessionB = b.payload.session.id;
  assert.notEqual(sessionA, sessionB);

  await t.test('the recordings endpoint reports both rooms, their names and counts', async () => {
    const payload = await waitFor(async () => {
      const value = await (await jsonRequest(`${base}api/live/recordings`)).json();
      const connected = value.recordings.filter((recording) => recording.connection.state === 'connected');
      return value.count === 2 && connected.length === 2 ? value : null;
    });
    assert.equal(payload.count, 2);
    assert.equal(payload.activeCount, 2);
    assert.deepEqual(payload.recordings.map((row) => row.sessionId).sort(), [sessionA, sessionB].sort());
    assert.ok(payload.recordings.every((row) => row.platform === 'tiktok'));
    assert.deepEqual(
      payload.recordings.map((row) => row.broadcasterName).sort(),
      ['Creator One', 'Creator Two']
    );
    assert.ok(payload.recordings.every((row) => row.messageCount === 0));
  });

  await t.test('each room ingests its own events and the same message id is not global', async () => {
    a.ws.deliver(frame([chat('9401', '701', 'Shared', 'A only')]));
    b.ws.deliver(frame([
      chat('9401', '701', 'Shared', 'B only'),
      chat('9402', '702', 'B Viewer', 'B second')
    ]));

    const summaryA = await waitFor(async () => {
      const value = await sessionSummary(base, sessionA);
      return value.stats.messages >= 1 ? value : null;
    });
    const summaryB = await waitFor(async () => {
      const value = await sessionSummary(base, sessionB);
      return value.stats.messages >= 2 ? value : null;
    });
    assert.equal(summaryA.stats.messages, 1);
    assert.equal(summaryB.stats.messages, 2);
    assert.equal(summaryA.session.broadcasterId, 'tiktok:anchor-7700000000000000123');
    assert.equal(summaryB.session.broadcasterId, 'tiktok:anchor-7700000000000000456');

    const recordings = await (await jsonRequest(`${base}api/live/recordings`)).json();
    const rowA = recordings.recordings.find((row) => row.sessionId === sessionA);
    const rowB = recordings.recordings.find((row) => row.sessionId === sessionB);
    assert.equal(rowA.messageCount, 1);
    assert.equal(rowB.messageCount, 2);

    // Both sessions can feed the AI report without mixing their data.
    for (const sessionId of [sessionA, sessionB]) {
      const report = await jsonRequest(`${base}api/ai/sessions/${encodeURIComponent(sessionId)}/report`);
      assert.equal(report.status, 200);
      const body = await report.json();
      assert.equal(body.session.id, sessionId);
      assert.equal(body.mode, 'none', 'no AI task has been started for this session yet');
    }
  });

  await t.test('starting room A again returns the existing session instead of a second one', async () => {
    const socketCount = FakeWebSocket.instances.length;
    const response = await jsonRequest(`${base}api/tiktok/connect`, {
      method: 'POST',
      body: {url: 'https://www.tiktok.com/@creator/live'}
    });
    assert.equal(response.status, 409);
    const payload = await response.json();
    assert.equal(payload.error.code, 'SESSION_DUPLICATE_ROOM');
    assert.equal(payload.error.details.sessionId, sessionA);
    assert.equal(FakeWebSocket.instances.length, socketCount, 'a duplicate opens no second socket');
    const recordings = await (await jsonRequest(`${base}api/live/recordings`)).json();
    assert.equal(recordings.count, 2);
  });

  await t.test('stopping A through the shared action leaves B recording', async () => {
    const stopped = await jsonRequest(`${base}api/live/recordings/${encodeURIComponent(sessionA)}/stop`, {
      method: 'POST',
      body: {}
    });
    assert.equal(stopped.status, 200);
    assert.equal((await stopped.json()).stopped, true);

    const payload = await waitFor(async () => {
      const value = await (await jsonRequest(`${base}api/live/recordings`)).json();
      return value.count === 1 ? value : null;
    });
    assert.equal(payload.recordings[0].sessionId, sessionB);
    assert.equal(payload.recordings[0].connection.state, 'connected');

    b.ws.deliver(frame([chat('9403', '702', 'B Viewer', 'after A stopped')]));
    const summaryB = await waitFor(async () => {
      const value = await sessionSummary(base, sessionB);
      return value.stats.messages >= 3 ? value : null;
    });
    assert.equal(summaryB.session.status, 'live');
    const summaryA = await sessionSummary(base, sessionA);
    assert.equal(summaryA.session.status, 'ended');
    assert.equal(summaryA.stats.messages, 1);
  });
});
