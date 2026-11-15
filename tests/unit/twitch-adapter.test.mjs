import test from 'node:test';
import assert from 'node:assert/strict';
import {TwitchIrcAdapter} from '../../src/platforms/twitch/adapter.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeout = 3000) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error('waitFor timeout');
    await sleep(10);
  }
}

class FakeSocket {
  constructor(url) {
    this.url = url;
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
    this.sent.push(String(data));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}
FakeSocket.instances = [];

function roomState(roomId = '42', channel = 'xqc') {
  return {data: `@room-id=${roomId};slow=0 :tmi.twitch.tv ROOMSTATE #${channel}`};
}

function privmsg({id = 'm1', text = 'hello', channel = 'xqc', userId = '1001', name = 'Alice'} = {}) {
  return {
    data: `@display-name=${name};user-id=${userId};login=alice;id=${id};room-id=42;`
      + `tmi-sent-ts=1700000000000 :alice!alice@alice.tmi.twitch.tv PRIVMSG #${channel} :${text}`
  };
}

async function connect(adapter, context = {}) {
  const starting = adapter.start(context);
  await sleep(0);
  const socket = FakeSocket.instances.at(-1);
  assert.ok(socket, 'a WebSocket should have been created');
  socket.emit('open', {});
  socket.emit('message', roomState());
  await starting;
  return socket;
}

test('the adapter joins anonymously, handles PING/PONG and maps chat', async () => {
  FakeSocket.instances = [];
  const events = [];
  const adapter = new TwitchIrcAdapter({
    login: 'xqc',
    channelId: '42',
    WebSocketImpl: FakeSocket,
    heartbeatMs: 100000,
    watchdogMs: 100000,
    statusIntervalMs: 100000,
    now: () => 1700000000000
  });
  const socket = await connect(adapter, {onEvent: (event) => events.push(event)});
  assert.equal(socket.url, 'wss://irc-ws.chat.twitch.tv:443');
  assert.ok(socket.sent.includes('CAP REQ :twitch.tv/tags twitch.tv/commands'));
  assert.ok(socket.sent.some((line) => /^NICK justinfan\d+$/.test(line)));
  assert.ok(socket.sent.some((line) => line === 'JOIN #xqc'));
  assert.equal(adapter.state, 'connected');
  assert.equal(adapter.roomId, '42');

  socket.emit('message', {data: 'PING :tmi.twitch.tv'});
  assert.ok(socket.sent.includes('PONG :tmi.twitch.tv'));

  socket.emit('message', privmsg({id: 'm1', text: 'Hello 世界 😂'}));
  await waitFor(() => events.length === 1);
  assert.equal(events[0].event_type, 'chat');
  assert.equal(events[0].viewer_uid, '1001');
  assert.equal(events[0].content, 'Hello 世界 😂');

  // The same message id delivered twice must not reach the ingest pipeline twice.
  socket.emit('message', privmsg({id: 'm1', text: 'Hello 世界 😂'}));
  await sleep(20);
  assert.equal(events.length, 1);
  assert.equal(adapter.snapshot().detail.counters.duplicateDropped, 1);

  socket.emit('message', privmsg({id: 'm2', text: 'second'}));
  await waitFor(() => events.length === 2);
  await adapter.stop();
  assert.equal(socket.closed, true);
  assert.equal(adapter.state, 'stopped');
});

test('subscription notices reach the pipeline as membership events', async () => {
  FakeSocket.instances = [];
  const events = [];
  const adapter = new TwitchIrcAdapter({
    login: 'xqc',
    channelId: '42',
    WebSocketImpl: FakeSocket,
    heartbeatMs: 100000,
    watchdogMs: 100000,
    statusIntervalMs: 100000
  });
  const socket = await connect(adapter, {onEvent: (event) => events.push(event)});
  socket.emit('message', {
    data: '@display-name=Alice;user-id=1001;login=alice;id=n1;room-id=42;tmi-sent-ts=1700000000000;'
      + 'msg-id=resub;msg-param-sub-plan=1000;msg-param-cumulative-months=12 :tmi.twitch.tv USERNOTICE #xqc :thanks'
  });
  await waitFor(() => events.length === 1);
  assert.equal(events[0].event_type, 'membership');
  assert.equal(events[0].gift_name, 'Subscription · Tier 1');
  assert.equal(events[0].content, 'thanks');
  await adapter.stop();
});

test('a closed socket reconnects without ending the session', async () => {
  FakeSocket.instances = [];
  const events = [];
  const adapter = new TwitchIrcAdapter({
    login: 'xqc',
    channelId: '42',
    WebSocketImpl: FakeSocket,
    heartbeatMs: 100000,
    watchdogMs: 100000,
    statusIntervalMs: 100000,
    maxBackoffMs: 5,
    maxReconnectAttempts: 3
  });
  const socket = await connect(adapter, {onEvent: (event) => events.push(event)});
  socket.close();
  await waitFor(() => FakeSocket.instances.length === 2, 2000);
  assert.equal(adapter.state, 'reconnecting');
  const next = FakeSocket.instances.at(-1);
  next.emit('open', {});
  next.emit('message', roomState());
  await waitFor(() => adapter.state === 'connected', 2000);
  next.emit('message', privmsg({id: 'after-reconnect'}));
  await waitFor(() => events.length === 1);
  await adapter.stop();
});

test('two consecutive offline status reads confirm a platform end', async () => {
  FakeSocket.instances = [];
  const ended = [];
  const statuses = [];
  const adapter = new TwitchIrcAdapter({
    login: 'xqc',
    channelId: '42',
    WebSocketImpl: FakeSocket,
    client: {
      async getChannel() {
        return {login: 'xqc', channelId: '42', isLive: false, streamId: null, viewers: null, startedAt: null};
      }
    },
    heartbeatMs: 100000,
    watchdogMs: 100000,
    statusIntervalMs: 10,
    offlineConfirmDelayMs: 10
  });
  await connect(adapter, {
    onEnd: (info) => ended.push(info),
    onPlatformStatus: (info) => statuses.push(info)
  });
  await waitFor(() => ended.length === 1, 2000);
  assert.equal(ended[0].reason, 'platform_ended');
  assert.equal(adapter.state, 'stopped');
  assert.ok(statuses.some((info) => info.status === 'ending'));
  assert.ok(statuses.some((info) => info.status === 'ended'));
});

test('a failed status read is not an end', async () => {
  FakeSocket.instances = [];
  const ended = [];
  const adapter = new TwitchIrcAdapter({
    login: 'xqc',
    channelId: '42',
    WebSocketImpl: FakeSocket,
    client: {
      async getChannel() {
        const error = new Error('network down');
        error.code = 'TWITCH_NETWORK';
        throw error;
      }
    },
    heartbeatMs: 100000,
    watchdogMs: 100000,
    statusIntervalMs: 10
  });
  await connect(adapter, {onEnd: (info) => ended.push(info)});
  await sleep(80);
  assert.equal(ended.length, 0);
  assert.equal(adapter.state, 'connected');
  assert.ok(adapter.snapshot().detail.attempt >= 0);
  await adapter.stop();
});

test('a suspended channel notice rejects the start with a precise error', async () => {
  FakeSocket.instances = [];
  const adapter = new TwitchIrcAdapter({
    login: 'xqc',
    channelId: '42',
    WebSocketImpl: FakeSocket,
    heartbeatMs: 100000,
    watchdogMs: 100000,
    statusIntervalMs: 100000
  });
  const starting = adapter.start({});
  await sleep(0);
  const socket = FakeSocket.instances.at(-1);
  socket.emit('open', {});
  socket.emit('message', {
    data: '@msg-id=msg_channel_suspended :tmi.twitch.tv NOTICE #xqc :This channel is suspended.'
  });
  await assert.rejects(starting, {code: 'TWITCH_CHANNEL_UNAVAILABLE'});
  assert.equal(socket.closed, true);
});
