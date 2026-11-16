import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {TikTokLocalAdapter} from '../../src/platforms/tiktok/local-adapter.mjs';
import {encodePushFrame} from '../../src/platforms/tiktok/webcast.mjs';
import {
  chatMessage,
  controlMessage,
  envelopeEntry,
  fetchResult,
  giftMessage,
  memberMessage
} from '../helpers/tiktok-frames.mjs';
import {FakeWebSocket} from '../helpers/tiktok-ws-fake.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeout = 3000) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error('waitFor timeout');
    await sleep(5);
  }
}

const ROOM = '7706695538414062349';

function fakeTtwid() {
  return {
    get: async () => 'anon-device-cookie-value',
    snapshot: () => ({cached: true, fetchCount: 1, retryCount: 0, source: 'test'})
  };
}

function fakeClient({live = true, roomId = ROOM, resolve = null, giftCatalog = null} = {}) {
  return {
    live,
    roomId,
    giftCatalog,
    lookups: 0,
    async resolveRoom() {
      this.lookups += 1;
      if (resolve) return resolve(this.lookups);
      return {uniqueId: 'creator', roomId: this.roomId, isLive: this.live, status: this.live ? 2 : 4, anchorUid: '42', anchorName: 'Creator'};
    },
    async fetchGiftCatalog() {
      return this.giftCatalog ?? new Map();
    }
  };
}

function makeAdapter({client = fakeClient(), options = {}} = {}) {
  return new TikTokLocalAdapter({
    uniqueId: 'creator',
    roomId: ROOM,
    client,
    ttwidProvider: fakeTtwid(),
    WebSocketImpl: FakeWebSocket,
    random: () => 0,
    ...options
  });
}

/** Start an adapter and complete the fake socket handshake. */
async function startAdapter(adapter) {
  const events = [];
  const states = [];
  const ends = [];
  const platformStatuses = [];
  const starting = adapter.start({
    onEvent: (event) => events.push(event),
    onStateChange: (state) => states.push(state),
    onEnd: (info) => ends.push(info),
    onPlatformStatus: (status) => platformStatuses.push(status)
  });
  const ws = await waitFor(() => FakeWebSocket.instances.length >= 1 && FakeWebSocket.last);
  ws.open();
  await starting;
  return {events, states, ends, platformStatuses, ws};
}

function batchFrame(entries, {logId = null} = {}) {
  return encodePushFrame({payload: gzipSync(fetchResult({messages: entries})), logId});
}

test('a real frame delivers canonical chat with a stable id and message id', async () => {
  FakeWebSocket.reset();
  const adapter = makeAdapter();
  const {events, ws} = await startAdapter(adapter);
  assert.equal(adapter.state, 'connected');
  assert.equal(adapter.capture().category, 'waiting_events');

  ws.deliver(batchFrame([{
    method: 'WebcastChatMessage',
    payload: chatMessage({msgId: '9001', userId: '4242', nickname: 'Alice', content: 'こんにちは 🌏'}),
    msgId: 9001n
  }], {logId: 5n}));
  await waitFor(() => events.length >= 1);
  const event = events[0];
  assert.equal(event.event_type, 'chat');
  assert.equal(event.viewer_uid, '4242');
  assert.equal(event.display_name, 'Alice');
  assert.equal(event.external_id, '9001');
  assert.equal(event.content, 'こんにちは 🌏');
  const capture = adapter.capture();
  assert.equal(capture.category, 'normal');
  assert.equal(capture.counters.messages, 1);
  assert.equal(capture.counters.chats, 1);
  assert.equal(capture.eventsVerified, true);
  assert.ok(capture.counters.frames >= 1);
  assert.ok(capture.counters.batchFrames >= 1);
  assert.equal(capture.protocol, 'webcast-ws');
  assert.equal(capture.wsHost, 'webcast-ws.tiktok.com');
  await adapter.stop();
});

test('a frame is not a chat: control frames and joins never become events', async () => {
  FakeWebSocket.reset();
  const adapter = makeAdapter();
  const {events, ws} = await startAdapter(adapter);
  // Control frame with a payload type that is not `msg`.
  ws.deliver(encodePushFrame({payloadType: 'hb', payload: Buffer.from([0x08, 0x01])}));
  await waitFor(() => adapter.capture().counters.controlFrames >= 1);
  // A member-join batch is decoded but is not a chat/gift event.
  ws.deliver(batchFrame([{method: 'WebcastMemberMessage', payload: memberMessage({msgId: '3001'}), msgId: 3001n}]));
  await waitFor(() => adapter.capture().counters.messages >= 1);
  assert.equal(events.length, 0);
  assert.equal(adapter.capture().counters.chats, 0);
  assert.equal(adapter.capture().counters.ignored, 1);
  assert.equal(adapter.capture().eventsVerified, false);
  await adapter.stop();
});

test('history comments replayed on join are skipped, not counted as new chat', async () => {
  FakeWebSocket.reset();
  const adapter = makeAdapter();
  const {events, ws} = await startAdapter(adapter);
  ws.deliver(batchFrame([{
    method: 'WebcastChatMessage',
    payload: chatMessage({msgId: '8001', content: 'old message'}),
    msgId: 8001n,
    isHistory: true
  }, {
    method: 'WebcastChatMessage',
    payload: chatMessage({msgId: '8002', content: 'new message'}),
    msgId: 8002n
  }]));
  await waitFor(() => events.length >= 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].content, 'new message');
  assert.equal(adapter.capture().counters.historySkipped, 1);
  assert.equal(adapter.capture().counters.chats, 1);
  await adapter.stop();
});

test('a streak is merged and recorded once at its final state', async () => {
  FakeWebSocket.reset();
  const adapter = makeAdapter();
  const {events, ws} = await startAdapter(adapter);
  ws.deliver(batchFrame([{
    method: 'WebcastGiftMessage',
    payload: giftMessage({msgId: '2001', giftId: 56560, giftName: 'Rose', diamonds: 1, repeatCount: 1, repeatEnd: 0, groupId: '77'}),
    msgId: 2001n
  }, {
    method: 'WebcastGiftMessage',
    payload: giftMessage({msgId: '2002', giftId: 56560, giftName: 'Rose', diamonds: 1, repeatCount: 2, repeatEnd: 0, groupId: '77'}),
    msgId: 2002n
  }, {
    method: 'WebcastGiftMessage',
    payload: giftMessage({msgId: '2003', giftId: 56560, giftName: 'Rose', diamonds: 1, repeatCount: 3, repeatEnd: 1, groupId: '77'}),
    msgId: 2003n
  }]));
  await waitFor(() => events.length >= 1);
  assert.equal(events.length, 1, 'one gift event for the whole streak');
  assert.equal(events[0].event_type, 'gift');
  assert.equal(events[0].gift_quantity, 3, 'final streak quantity');
  assert.equal(events[0].amount_minor, null, 'diamonds are never income');
  assert.equal(events[0].value_kind, 'unknown');
  assert.equal(adapter.capture().counters.gifts, 1);
  assert.equal(adapter.capture().counters.giftUpdates, 3);
  await adapter.stop();
});

test('an unfinished streak is flushed after the timeout instead of being lost', async () => {
  FakeWebSocket.reset();
  const adapter = makeAdapter({options: {streakFlushMs: 20}});
  const {events, ws} = await startAdapter(adapter);
  ws.deliver(batchFrame([{
    method: 'WebcastGiftMessage',
    payload: giftMessage({msgId: '2101', repeatCount: 2, repeatEnd: 0, groupId: '88'}),
    msgId: 2101n
  }]));
  await waitFor(() => events.length >= 1, 2000);
  assert.equal(events[0].event_type, 'gift');
  assert.equal(events[0].gift_quantity, 2);
  await adapter.stop();
});

test('a resent final gift is not counted twice', async () => {
  FakeWebSocket.reset();
  const adapter = makeAdapter();
  const {events, ws} = await startAdapter(adapter);
  const entry = {
    method: 'WebcastGiftMessage',
    payload: giftMessage({msgId: '2301', repeatCount: 2, repeatEnd: 1, groupId: '55'}),
    msgId: 2301n
  };
  ws.deliver(batchFrame([entry]));
  await waitFor(() => events.length >= 1);
  ws.deliver(batchFrame([entry]));
  await waitFor(() => adapter.capture().counters.duplicates >= 1);
  assert.equal(events.length, 1, 'the same gift event is not delivered twice');
  assert.equal(adapter.capture().counters.gifts, 1);
  await adapter.stop();
});

test('a duplicated message id never reaches the ingest pipeline twice', async () => {
  FakeWebSocket.reset();
  const adapter = makeAdapter();
  const {events, ws} = await startAdapter(adapter);
  const entry = {method: 'WebcastChatMessage', payload: chatMessage({msgId: '9100', content: 'same'}), msgId: 9100n};
  ws.deliver(batchFrame([entry]));
  await waitFor(() => events.length >= 1);
  ws.deliver(batchFrame([entry]));
  await waitFor(() => adapter.capture().counters.duplicates >= 1);
  assert.equal(events.length, 1);
  assert.equal(adapter.capture().counters.duplicates, 1);
  await adapter.stop();
});

test('a dropped socket reconnects without pretending the gap is filled', async () => {
  FakeWebSocket.reset();
  const adapter = makeAdapter({options: {maxBackoffMs: 5, statusIntervalMs: 60000}});
  const {events, ws} = await startAdapter(adapter);
  ws.deliver(batchFrame([{
    method: 'WebcastChatMessage',
    payload: chatMessage({msgId: '9200', content: 'before drop'}),
    msgId: 9200n
  }]));
  await waitFor(() => events.length >= 1);

  ws.drop({code: 1006});
  assert.equal(adapter.state, 'reconnecting');
  const second = await waitFor(() => FakeWebSocket.instances.length >= 2 && FakeWebSocket.instances[1]);
  second.open();
  await waitFor(() => adapter.state === 'connected');
  const capture = adapter.capture();
  assert.equal(capture.counters.connections, 2);
  assert.ok(capture.reconnectAttempts >= 1);
  assert.equal(capture.possibleGap, true);
  assert.equal(capture.gap.note, 'webcast_ws_has_no_resume_cursor');

  second.deliver(batchFrame([{
    method: 'WebcastChatMessage',
    payload: chatMessage({msgId: '9201', content: 'after reconnect'}),
    msgId: 9201n
  }]));
  await waitFor(() => events.length >= 2);
  assert.equal(events[1].content, 'after reconnect');
  await adapter.stop();
});

test('two independent offline observations end the recording', async () => {
  FakeWebSocket.reset();
  const client = fakeClient({live: false});
  const adapter = makeAdapter({client, options: {statusIntervalMs: 10, statusCheckDelayMs: 1}});
  const {ends} = await startAdapter(adapter);
  await waitFor(() => ends.length === 1, 3000);
  assert.equal(ends[0].reason, 'platform_ended');
  assert.equal(adapter.state, 'stopped');
  assert.equal(adapter.capture().category, 'ended');
});

test('one offline observation is not enough to end a recording', async () => {
  FakeWebSocket.reset();
  let lookups = 0;
  const client = fakeClient({resolve: () => {
    lookups += 1;
    return lookups === 1
      ? {uniqueId: 'creator', roomId: ROOM, isLive: false, status: 4}
      : {uniqueId: 'creator', roomId: ROOM, isLive: true, status: 2};
  }});
  const adapter = makeAdapter({client, options: {statusIntervalMs: 10, statusCheckDelayMs: 1}});
  const {ends} = await startAdapter(adapter);
  await waitFor(() => client.lookups >= 2);
  assert.equal(ends.length, 0, 'a single observation is not proof');
  assert.equal(adapter.state, 'connected');
  await adapter.stop();
});

test('a changed room id is reported as ended, not silently followed', async () => {
  FakeWebSocket.reset();
  const client = fakeClient({resolve: () => ({uniqueId: 'creator', roomId: '7707000000000000001', isLive: true, status: 2})});
  const adapter = makeAdapter({client, options: {statusIntervalMs: 5, statusCheckDelayMs: 1}});
  const {ends} = await startAdapter(adapter);
  await waitFor(() => ends.length === 1, 3000);
  assert.equal(adapter.state, 'stopped');
  const status = adapter.capture();
  assert.equal(status.platformStatus.reason, 'room_changed');
});

test('a throttled anonymous cookie keeps the recording and retries', async () => {
  FakeWebSocket.reset();
  let attempt = 0;
  const provider = {
    get: async () => {
      attempt += 1;
      if (attempt === 1) {
        const error = new Error('throttled');
        error.code = 'TIKTOK_RATE_LIMITED';
        error.messageKey = 'errors.tiktokRateLimit';
        error.retryAfterMs = 10;
        error.details = {reason: 'ttwid_throttled'};
        throw error;
      }
      return 'anon-cookie';
    },
    snapshot: () => ({cached: attempt > 1, fetchCount: attempt})
  };
  const adapter = new TikTokLocalAdapter({
    uniqueId: 'creator',
    roomId: ROOM,
    client: fakeClient(),
    ttwidProvider: provider,
    WebSocketImpl: FakeWebSocket,
    random: () => 0,
    minRateLimitWaitMs: 5,
    statusIntervalMs: 60000
  });
  const starting = adapter.start({onEvent: () => {}});
  await waitFor(() => adapter.state === 'rate_limited');
  const ws = await waitFor(() => FakeWebSocket.instances.length >= 1 && FakeWebSocket.last);
  ws.open();
  await starting;
  // start() resolved even though the first attempt was throttled: the session
  // exists and the real state is visible.
  await waitFor(() => adapter.state === 'connected', 3000);
  await waitFor(() => adapter.capture().counters.ttwidFetches >= 2);
  await adapter.stop();
});

test('stopping flushes a pending streak and reports stopped', async () => {
  FakeWebSocket.reset();
  const adapter = makeAdapter({options: {streakFlushMs: 60000}});
  const {events, ws} = await startAdapter(adapter);
  ws.deliver(batchFrame([{
    method: 'WebcastGiftMessage',
    payload: giftMessage({msgId: '2201', repeatCount: 4, repeatEnd: 0, groupId: '99'}),
    msgId: 2201n
  }]));
  await waitFor(() => adapter.capture().counters.giftUpdates >= 1);
  assert.equal(events.length, 0);
  await adapter.stop();
  assert.equal(events.length, 1, 'a pending gift is not silently dropped');
  assert.equal(events[0].gift_quantity, 4);
  assert.equal(adapter.state, 'stopped');
  assert.equal(adapter.capture().category, 'stopped');
});

test('a control message is one observation, not an instant end', async () => {
  FakeWebSocket.reset();
  // The public room status still says live, so the control message must not be
  // able to end the recording on its own.
  const client = fakeClient({live: true});
  const adapter = makeAdapter({client, options: {statusIntervalMs: 10, statusCheckDelayMs: 1}});
  const {ws, ends} = await startAdapter(adapter);
  ws.deliver(batchFrame([{method: 'WebcastControlMessage', payload: controlMessage({msgId: '7001', action: 3}), msgId: 7001n}]));
  await waitFor(() => adapter.capture().platformStatus?.status === 'offline');
  await sleep(60);
  assert.equal(ends.length, 0, 'one control message is not proof');
  assert.equal(adapter.state, 'connected');
  assert.equal(adapter.capture().platformStatus.status, 'live', 'the live room status wins');
  await adapter.stop();
});
