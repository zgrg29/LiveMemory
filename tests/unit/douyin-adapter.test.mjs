import test from 'node:test';
import assert from 'node:assert/strict';
import {DouyinLiveAdapter} from '../../src/platforms/douyin/adapter.mjs';
import {chatMessage, giftMessage, pushFrame} from '../helpers/douyin-frames.mjs';

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

class FakeSocket {
  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.listeners = new Map();
    this.sent = [];
    this.closed = false;
    FakeSocket.instances.push(this);
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  emit(type, event = {}) {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  send(data) {
    this.sent.push(Buffer.from(data));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', {code: 1000});
  }
}
FakeSocket.instances = [];

function room(overrides = {}) {
  return {
    webRid: '708764876300',
    roomId: '7708163643157859082',
    status: 2,
    isLive: true,
    ended: false,
    title: 'live',
    anchorName: 'Anchor',
    anchorId: '952641521715660',
    anchorSecUid: 'sec',
    userCount: '500+',
    ...overrides
  };
}

function fakeClient({live = true, checkImpl = null} = {}) {
  return {
    currentRoom: room(),
    async fetchRoom() {
      return this.currentRoom;
    },
    async checkRoom() {
      if (checkImpl) return checkImpl();
      return live ? room() : room({status: 4, isLive: false, ended: true});
    },
    buildWebSocketUrl() {
      return {url: 'wss://fake/webcast', headers: {'user-agent': 'test', cookie: 'ttwid=x'}, signature: 'sig'};
    },
    cookieHeader() {
      return 'ttwid=x';
    }
  };
}

function adapterFor(client, options = {}) {
  return new DouyinLiveAdapter({
    webRid: '708764876300',
    roomId: '7708163643157859082',
    room: room(),
    client,
    WebSocketImpl: FakeSocket,
    now: () => 1700000000000,
    ...options
  });
}

test('a chat frame reaches onEvent once, duplicates are dropped and a heartbeat is sent', async () => {
  FakeSocket.instances = [];
  const adapter = adapterFor(fakeClient(), {
    heartbeatMs: 100000,
    watchdogMs: 100000,
    statusIntervalMs: 100000
  });
  const events = [];
  const starting = adapter.start({onEvent: (draft) => events.push(draft)});
  await waitFor(() => FakeSocket.instances.length === 1);
  const socket = FakeSocket.instances[0];
  socket.emit('open', {});
  await starting;

  const frame = pushFrame([
    chatMessage('100', {userId: '1001', name: '观众😀', content: '你好 世界 😂'}),
    chatMessage('100', {userId: '1001', name: '观众😀', content: '你好 世界 😂'})
  ]);
  socket.emit('message', {data: frame});
  await waitFor(() => events.length === 1);
  assert.equal(events[0].content, '你好 世界 😂');
  assert.equal(events[0].viewer_uid, '1001');
  assert.equal(events[0].external_id, '100');
  assert.equal(events[0].display_name, '观众😀');

  await waitFor(() => socket.sent.length >= 1);
  assert.deepEqual([...socket.sent[0]], [0x3a, 0x02, 0x68, 0x62], 'PushFrame{payloadType:"hb"}');
  assert.equal(adapter.snapshot().detail.counters.duplicateDropped, 1);
  await adapter.stop();
});

test('a combo is written only at its final event and never twice', async () => {
  FakeSocket.instances = [];
  const adapter = adapterFor(fakeClient(), {heartbeatMs: 100000, watchdogMs: 100000, statusIntervalMs: 100000});
  const events = [];
  const starting = adapter.start({onEvent: (draft) => events.push(draft)});
  await waitFor(() => FakeSocket.instances.length === 1);
  const socket = FakeSocket.instances[0];
  socket.emit('open', {});
  await starting;

  socket.emit('message', {data: pushFrame([giftMessage('201', {repeatEnd: 0, repeatCount: 1, groupId: '9'})])});
  socket.emit('message', {data: pushFrame([giftMessage('202', {repeatEnd: 0, repeatCount: 2, groupId: '9'})])});
  await sleep(20);
  assert.equal(events.length, 0, 'intermediate combo steps are not written');
  socket.emit('message', {data: pushFrame([giftMessage('203', {repeatEnd: 1, repeatCount: 3, groupId: '9'})])});
  await waitFor(() => events.length === 1);
  assert.equal(events[0].event_type, 'gift');
  assert.equal(events[0].gift_quantity, 3);
  assert.equal(events[0].external_id, '203');
  assert.equal(events[0].amount_minor, null);
  assert.equal(adapter.snapshot().detail.counters.giftFinal, 1);
  assert.equal(adapter.snapshot().detail.counters.giftPending, 2);
  await adapter.stop();
});

test('a dropped socket reconnects with the same adapter and keeps delivering messages', async () => {
  FakeSocket.instances = [];
  const adapter = adapterFor(fakeClient(), {
    heartbeatMs: 100000,
    watchdogMs: 100000,
    statusIntervalMs: 100000,
    maxBackoffMs: 10,
    maxReconnectAttempts: 3
  });
  const events = [];
  const starting = adapter.start({onEvent: (draft) => events.push(draft)});
  await waitFor(() => FakeSocket.instances.length === 1);
  FakeSocket.instances[0].emit('open', {});
  await starting;

  FakeSocket.instances[0].emit('close', {code: 1006});
  assert.equal(adapter.state, 'reconnecting');
  await waitFor(() => FakeSocket.instances.length === 2);
  const second = FakeSocket.instances[1];
  second.emit('open', {});
  await waitFor(() => adapter.state === 'connected');
  second.emit('message', {data: pushFrame([chatMessage('300', {content: 'after reconnect'})])});
  await waitFor(() => events.length === 1);
  assert.equal(events[0].content, 'after reconnect');
  await adapter.stop();
});

test('two confirmed offline page reads end the capture; one failed read does not', async () => {
  FakeSocket.instances = [];
  let offline = false;
  let fail = false;
  const client = fakeClient({
    checkImpl: async () => {
      if (fail) {
        const error = new Error('network');
        error.code = 'DOUYIN_NETWORK';
        throw error;
      }
      return offline ? room({status: 4, isLive: false, ended: true}) : room();
    }
  });
  const adapter = adapterFor(client, {
    heartbeatMs: 100000,
    watchdogMs: 100000,
    statusIntervalMs: 10,
    offlineConfirmDelayMs: 10
  });
  const ends = [];
  const starting = adapter.start({onEnd: (info) => ends.push(info)});
  await waitFor(() => FakeSocket.instances.length === 1);
  FakeSocket.instances[0].emit('open', {});
  await starting;

  fail = true;
  await sleep(40);
  assert.equal(ends.length, 0, 'a failed status read is not an end');

  fail = false;
  offline = true;
  await waitFor(() => ends.length === 1, 2000);
  assert.equal(ends[0].reason, 'platform_ended');
  assert.equal(ends[0].endQuality, 'poll');
  await adapter.stop();
});

test('stop rejects a pending start and leaves no reconnect timer behind', async () => {
  FakeSocket.instances = [];
  const adapter = adapterFor(fakeClient(), {connectTimeoutMs: 5000});
  const starting = adapter.start({});
  await waitFor(() => FakeSocket.instances.length === 1);
  await adapter.stop();
  await assert.rejects(starting, (error) => error.code === 'DOUYIN_STOPPED');
  await sleep(20);
  assert.equal(FakeSocket.instances.length, 1);
});
