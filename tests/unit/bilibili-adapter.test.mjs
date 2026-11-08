import test from 'node:test';
import assert from 'node:assert/strict';
import {BilibiliLiveAdapter} from '../../src/platforms/bilibili/adapter.mjs';
import {decodePackets, encodePacket, OP} from '../../src/platforms/bilibili/protocol.mjs';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.binaryType = 'blob';
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
    this.emit('close');
  }
}
FakeSocket.instances = [];

function fakeApi() {
  return {
    loggedIn: false,
    buvid: 'buvid-test',
    roomInit: async (roomId) => ({roomId, shortId: null, liveStatus: 1}),
    danmuInfo: async () => ({token: 'token-123', hosts: [{host: 'live.example', port: 443}]}),
    navUser: async () => null
  };
}

function authReply() {
  return encodePacket(OP.AUTH_REPLY, JSON.stringify({code: 0}));
}

function danmuPacket(text = 'hi') {
  return encodePacket(OP.MESSAGE, JSON.stringify({
    cmd: 'DANMU_MSG',
    data: {info: [[], text, [12345, 'Viewer', 0, 0], [1, 'm', 'a', 1], [1], [0], 5050, 0, '', {ts: 1_700_000_000_000}]}
  }));
}

test('the adapter authenticates, sends heartbeats and maps messages', async () => {
  FakeSocket.instances = [];
  const events = [];
  const adapter = new BilibiliLiveAdapter({
    roomId: 5050,
    api: fakeApi(),
    WebSocketImpl: FakeSocket,
    heartbeatMs: 60000,
    now: () => 1_700_000_000_000
  });
  const starting = adapter.start({onEvent: (event) => events.push(event)});
  await sleep(20);
  const socket = FakeSocket.instances.at(-1);
  assert.ok(socket, 'a socket should have been created');
  assert.equal(socket.url, 'wss://live.example:443/sub');

  socket.emit('open', {});
  assert.equal(socket.sent.length, 1);
  const auth = decodePackets(socket.sent[0])[0];
  assert.equal(auth.op, OP.AUTH);
  assert.equal(auth.json.roomid, 5050);
  assert.equal(auth.json.key, 'token-123');
  assert.equal(auth.json.uid, 0);

  socket.emit('message', {data: authReply()});
  await starting;
  assert.equal(adapter.state, 'connected');
  assert.equal(adapter.connected, true);
  assert.equal(socket.sent.length, 2, 'an immediate heartbeat is sent after auth');
  assert.equal(decodePackets(socket.sent[1])[0].op, OP.HEARTBEAT);

  socket.emit('message', {data: danmuPacket('hello')});
  await sleep(20);
  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, 'chat');
  assert.equal(events[0].viewer_uid, '12345');
  assert.equal(events[0].content, 'hello');
  assert.equal(events[0].platform, 'bilibili');

  await adapter.stop();
  assert.equal(socket.closed, true);
  assert.equal(adapter.state, 'stopped');
});

test('a rejected auth fails the start instead of pretending to record', async () => {
  FakeSocket.instances = [];
  const adapter = new BilibiliLiveAdapter({
    roomId: 5050,
    api: fakeApi(),
    WebSocketImpl: FakeSocket,
    heartbeatMs: 60000
  });
  const starting = adapter.start({onEvent: () => {}});
  await sleep(20);
  const socket = FakeSocket.instances.at(-1);
  socket.emit('open', {});
  socket.emit('message', {data: encodePacket(OP.AUTH_REPLY, JSON.stringify({code: -101}))});
  await assert.rejects(starting, /auth rejected/);
  assert.equal(adapter.state, 'stopped');
});

test('a closed socket schedules a reconnect with backoff', async () => {
  FakeSocket.instances = [];
  const adapter = new BilibiliLiveAdapter({
    roomId: 5050,
    api: fakeApi(),
    WebSocketImpl: FakeSocket,
    heartbeatMs: 60000
  });
  const starting = adapter.start({onEvent: () => {}});
  await sleep(20);
  const socket = FakeSocket.instances.at(-1);
  socket.emit('open', {});
  socket.emit('message', {data: authReply()});
  await starting;
  socket.close();
  assert.equal(adapter.started, true);
  assert.equal(['connecting', 'reconnecting'].includes(adapter.state), true);
  assert.ok(adapter.retry, 'a retry timer is scheduled');
  await adapter.stop();
});
