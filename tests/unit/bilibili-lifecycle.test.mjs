import test from 'node:test';
import assert from 'node:assert/strict';
import {BilibiliLiveAdapter} from '../../src/platforms/bilibili/adapter.mjs';
import {BilibiliError} from '../../src/platforms/bilibili/api.mjs';
import {decodePackets, encodePacket, OP} from '../../src/platforms/bilibili/protocol.mjs';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitFor(check, {timeout = 3000, interval = 10} = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error('waitFor timeout');
    await sleep(interval);
  }
}

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.binaryType = 'blob';
    this.listeners = new Map();
    this.sent = [];
    this.closed = false;
    this.closeCalls = 0;
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
    this.closeCalls += 1;
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}
FakeSocket.instances = [];

function authReply() {
  return encodePacket(OP.AUTH_REPLY, JSON.stringify({code: 0}));
}

function statePacket(cmd, extra = {}) {
  return encodePacket(OP.MESSAGE, JSON.stringify({cmd, roomid: 5050, ...extra}));
}

function fakeApi({statuses = [1], roomId = 5050, roomStatus = null} = {}) {
  let index = 0;
  const api = {
    loggedIn: false,
    buvid: 'buvid-test',
    calls: 0,
    roomInit: async (id) => ({roomId: id, shortId: null, liveStatus: 1, liveTime: null}),
    danmuInfo: async () => ({token: 'token-123', hosts: [{host: 'live.example', port: 443}]}),
    navUser: async () => null,
    roomStatus: async (id) => {
      api.calls += 1;
      const value = roomStatus ? await roomStatus(api.calls) : statuses[Math.min(index++, statuses.length - 1)];
      if (value instanceof Error) throw value;
      return {roomId, liveStatus: value, liveTime: null, title: null, online: null};
    }
  };
  return api;
}

async function startAdapter(api, options = {}) {
  FakeSocket.instances = [];
  const events = [];
  const statuses = [];
  const ends = [];
  const adapter = new BilibiliLiveAdapter({
    roomId: 5050,
    api,
    WebSocketImpl: FakeSocket,
    heartbeatMs: 60000,
    watchdogMs: 60000,
    liveStatusIntervalMs: 20,
    offlineConfirmDelayMs: 20,
    statusTimeoutMs: 50,
    maxStatusBackoffMs: 100,
    maxStatusEventRetryMs: 100,
    ...options
  });
  const starting = adapter.start({
    onEvent: (event) => events.push(event),
    onPlatformStatus: (info) => statuses.push(info),
    onEnd: (info) => ends.push(info)
  });
  await sleep(10);
  const socket = FakeSocket.instances.at(-1);
  assert.ok(socket, 'a socket should have been created');
  socket.emit('open', {});
  socket.emit('message', {data: authReply()});
  await starting;
  return {adapter, socket, events, statuses, ends};
}

test('a PREPARING event plus a valid offline status confirms the end exactly once', async () => {
  const api = fakeApi({statuses: [0]});
  const {adapter, socket, statuses, ends} = await startAdapter(api);

  socket.emit('message', {data: statePacket('PREPARING', {round: 1})});
  await waitFor(() => ends.length > 0, {timeout: 2000});

  assert.equal(ends.length, 1);
  assert.equal(ends[0].reason, 'platform_ended');
  assert.equal(ends[0].platformStatus, 'ended');
  assert.equal(ends[0].endQuality, 'event');
  assert.ok(ends[0].platformEndedAt);
  assert.equal(adapter.started, false);
  assert.equal(adapter.platformStatus, 'ended');
  assert.equal(socket.closed, true);
  assert.ok(statuses.some((entry) => entry.status === 'ending'));
  assert.ok(statuses.some((entry) => entry.status === 'ended'));

  // A duplicate end signal after the commit must not emit a second end or
  // schedule a reconnect.
  socket.emit('message', {data: statePacket('PREPARING')});
  await sleep(120);
  assert.equal(ends.length, 1);
  assert.equal(FakeSocket.instances.length, 1);
});

test('two consecutive offline status queries end a capture even without a WebSocket end event', async () => {
  const api = fakeApi({statuses: [1, 0, 0, 0]});
  const {adapter, ends, statuses} = await startAdapter(api, {liveStatusIntervalMs: 15, offlineConfirmDelayMs: 15});

  await waitFor(() => ends.length > 0, {timeout: 2000});
  assert.equal(ends.length, 1);
  assert.equal(ends[0].endQuality, 'poll');
  assert.equal(adapter.platformStatus, 'ended');
  assert.ok(statuses.filter((entry) => entry.status === 'ending').length >= 1);
  assert.ok(api.calls >= 3);
});

test('a long quiet broadcast stays live when the status query still says live', async () => {
  const api = fakeApi({statuses: [1]});
  const {adapter, ends, statuses} = await startAdapter(api, {liveStatusIntervalMs: 15});

  await waitFor(() => api.calls >= 4, {timeout: 2000});
  await sleep(80);
  assert.equal(ends.length, 0);
  assert.equal(adapter.started, true);
  assert.equal(adapter.platformStatus, 'live');
  assert.ok(statuses.length >= 4);
});

test('timeouts, 429 and malformed responses never count as an end', async () => {
  const api = fakeApi({
    roomStatus: async (call) => {
      if (call % 3 === 1) throw new BilibiliError('HTTP', 'HTTP 429', {status: 429});
      if (call % 3 === 2) throw new BilibiliError('NETWORK', 'timeout');
      return 9; // invalid live_status: must be rejected by the adapter
    }
  });
  const {adapter, ends} = await startAdapter(api, {
    liveStatusIntervalMs: 10,
    offlineConfirmDelayMs: 10,
    maxStatusBackoffMs: 40
  });

  await waitFor(() => api.calls >= 4, {timeout: 3000});
  await sleep(100);
  assert.equal(ends.length, 0);
  assert.equal(adapter.started, true);
  assert.equal(adapter.platformStatus, 'live');
});

test('a LIVE event cancels an unconfirmed PREPARING and keeps the capture alive', async () => {
  const api = fakeApi({statuses: [1]});
  const {adapter, socket, ends, statuses} = await startAdapter(api, {liveStatusIntervalMs: 20});

  socket.emit('message', {data: statePacket('PREPARING')});
  socket.emit('message', {data: statePacket('LIVE', {live_key: 'new-key', live_time: 1})});
  await sleep(120);

  assert.equal(ends.length, 0);
  assert.equal(adapter.started, true);
  assert.equal(adapter.platformStatus, 'live');
  assert.equal(adapter.liveKey, 'new-key');
  assert.equal(statuses.at(-1).status, 'live');
});

test('an end event for another room is ignored', async () => {
  const api = fakeApi({statuses: [0]});
  const {adapter, socket, ends, statuses} = await startAdapter(api, {liveStatusIntervalMs: 1000});

  socket.emit('message', {data: encodePacket(OP.MESSAGE, JSON.stringify({cmd: 'PREPARING', roomid: 9999}))});
  await sleep(120);
  assert.equal(ends.length, 0);
  assert.equal(adapter.started, true);
  assert.equal(statuses.some((entry) => entry.status === 'ending'), false);
  assert.equal(api.calls, 0, 'an event for another room must not trigger a status query');
});

test('stopping an adapter prevents stale socket callbacks from ending or reviving it', async () => {
  const api = fakeApi({statuses: [0]});
  const {adapter, socket, ends} = await startAdapter(api);
  await adapter.stop();
  const endsBefore = ends.length;

  socket.emit('message', {data: statePacket('PREPARING')});
  socket.emit('message', {data: statePacket('LIVE')});
  await sleep(120);
  assert.equal(ends.length, endsBefore);
  assert.equal(adapter.started, false);
});

test('PREPARING followed by a LIVE for a new broadcast ends the old session instead of merging', async () => {
  const api = fakeApi({statuses: [1]});
  const {adapter, socket, ends} = await startAdapter(api, {liveStatusIntervalMs: 1000});

  socket.emit('message', {data: statePacket('LIVE', {live_key: 'old-key', live_time: 1000})});
  await sleep(20);
  assert.equal(adapter.liveKey, 'old-key');
  assert.equal(adapter.liveStartedAt, 1000);

  socket.emit('message', {data: statePacket('PREPARING')});
  socket.emit('message', {data: statePacket('LIVE', {live_key: 'new-key', live_time: 2000})});

  await waitFor(() => ends.length > 0, {timeout: 2000});
  assert.equal(ends.length, 1);
  assert.equal(ends[0].reason, 'platform_ended');
  assert.equal(ends[0].platformStatus, 'ended');
  assert.equal(adapter.started, false);
});

test('a flapping reconnect does not reset the offline confirmation count', async () => {
  const api = fakeApi({statuses: [1, 0]});
  let reconnects = 0;
  const originalRoomInit = api.roomInit;
  api.roomInit = async (id) => {
    reconnects += 1;
    const base = await originalRoomInit(id);
    return {...base, liveStatus: reconnects > 1 ? 0 : 1};
  };
  const {adapter, socket, ends} = await startAdapter(api, {
    liveStatusIntervalMs: 20,
    offlineConfirmDelayMs: 500
  });
  await waitFor(() => adapter.offlineObservations === 1, {timeout: 2000});
  socket.close();
  await waitFor(() => ends.length > 0, {timeout: 2000});
  assert.equal(ends.length, 1);
  assert.equal(adapter.platformStatus, 'ended');
});

test('a reconnect that reports a different live_time ends the old broadcast, not the new one', async () => {
  const api = fakeApi({statuses: [1]});
  let liveTime = 1000;
  api.roomInit = async (id) => ({roomId: id, shortId: null, liveStatus: 1, liveTime});
  const {adapter, socket, ends} = await startAdapter(api, {liveStatusIntervalMs: 1000});
  assert.equal(adapter.liveStartedAt, 1000);

  liveTime = 2000;
  socket.close();
  await waitFor(() => ends.length > 0, {timeout: 5000});
  assert.equal(ends.length, 1);
  assert.equal(ends[0].platformStatus, 'ended');
  assert.equal(ends[0].reason, 'platform_ended');
  assert.equal(adapter.started, false);
});

test('a room in carousel is treated as not live and ends with the carousel state', async () => {
  const api = fakeApi({statuses: [1, 2, 2]});
  const {adapter, ends} = await startAdapter(api, {liveStatusIntervalMs: 15, offlineConfirmDelayMs: 15});

  await waitFor(() => ends.length > 0, {timeout: 2000});
  assert.equal(ends.length, 1);
  assert.equal(ends[0].platformStatus, 'carousel');
  assert.equal(adapter.platformStatus, 'carousel');
});
