import test from 'node:test';
import assert from 'node:assert/strict';
import {KickAdapter} from '../../src/platforms/kick/adapter.mjs';
import {KICK_ERRORS, KickError} from '../../src/platforms/kick/errors.mjs';
import {KickFakeWebSocket, fakeKickHttp, jsonResult, waitFor} from '../helpers/kick-ws-fake.mjs';
import {connectAck, guestToken, kickChat, publicationFrame, subscribeAck, tokenExpiredFrame} from '../helpers/kick-frames.mjs';

const CHANNEL = {
  id: 2401072,
  user_id: 676,
  slug: 'odablock',
  is_banned: false,
  followers_count: 500000,
  chatroom: {id: 2393554},
  livestream: {id: 138000001, session_title: 'Live now', start_time: '2026-11-16T12:00:00Z', viewer_count: 8771}
};

function harness({channel = CHANNEL, failConnection = null, tokenTtl = 2700} = {}) {
  KickFakeWebSocket.reset({autoHandshake: true});
  let authCalls = 0;
  let connectionFails = Boolean(failConnection);
  const http = fakeKickHttp((url) => {
    if (url.includes('/api/v2/channels/')) {
      if (channel === 404) return jsonResult(null, 404);
      return jsonResult(channel);
    }
    if (url.includes('/chat/connection')) {
      if (connectionFails) return new KickError(KICK_ERRORS.NETWORK, {details: {reason: 'forced'}});
      return jsonResult({data: {connections: [{provider: 'centrifugo', credentials: {url: 'wss://fake'}}]}});
    }
    if (url.includes('/realtime/auth/connection')) {
      authCalls += 1;
      return jsonResult({data: {token: guestToken({ttlSec: tokenTtl, iat: 1794849680 + authCalls})}});
    }
    return jsonResult({}, 404);
  });
  const adapter = new KickAdapter({
    slug: 'odablock',
    sessionId: 'session-kick-1',
    http,
    WebSocketImpl: KickFakeWebSocket,
    options: {baseBackoffMs: 5, maxBackoffMs: 10, connectTimeoutMs: 200, maxConsecutiveFailures: 2}
  });
  return {
    adapter,
    http,
    authCalls: () => authCalls,
    setFailConnection(value) {
      connectionFails = value;
    }
  };
}

async function started(options = {}) {
  const context = harness(options);
  const events = [];
  const ends = [];
  await context.adapter.start({
    onEvent: (draft) => events.push(draft),
    onEnd: (info) => ends.push(info)
  });
  return {...context, events, ends, ws: KickFakeWebSocket.last};
}

test('start resolves only after the chatroom subscription was acknowledged', async () => {
  const {adapter, ws} = await started();
  assert.equal(adapter.state, 'connected');
  assert.equal(adapter.channel.chatroomId, '2393554');
  assert.equal(adapter.snapshot().chatroomId, '2393554');
  assert.ok(ws.subscriptions.includes('chatrooms.2393554.v2'));
  assert.equal(adapter.snapshot().counters.connections, 1);
  await adapter.stop();
});

test('an offline channel is refused before any socket is opened', async () => {
  const offline = {...CHANNEL, livestream: null};
  const {adapter} = harness({channel: offline});
  await assert.rejects(
    () => adapter.start({}),
    (error) => error.code === KICK_ERRORS.ROOM_OFFLINE
  );
  assert.equal(adapter.state, 'failed');
  assert.equal(KickFakeWebSocket.instances.length, 0, 'no socket for a non-live channel');
});

test('an unknown channel reports ROOM_NOT_FOUND and never fabricates a room', async () => {
  const {adapter} = harness({channel: 404});
  await assert.rejects(() => adapter.start({}), (error) => error.code === KICK_ERRORS.ROOM_NOT_FOUND);
  assert.equal(adapter.state, 'failed');
  assert.equal(KickFakeWebSocket.instances.length, 0);
});

test('real chat publications become canonical drafts with measured fields', async () => {
  const {adapter, ws, events} = await started();
  ws.deliver(publicationFrame('App\\Events\\ChatMessageEvent', kickChat({
    id: 'm-1',
    content: '你好 [emote:5216699:gregYikes]',
    sender: {id: 3119475, username: 'Alice', identity: {badges: [{type: 'subscriber', text: 'Subscriber'}]}}
  })));
  ws.deliver(publicationFrame('App\\Events\\ChatMessageEvent', kickChat({
    id: 'm-2',
    content: 'no id',
    sender: {id: null, username: 'Ghost', identity: {badges: []}}
  })));

  assert.equal(events.length, 2);
  assert.equal(events[0].viewer_uid, '3119475');
  assert.equal(events[0].content, '你好 [emote:5216699:gregYikes]');
  assert.equal(events[0]._kick.chatroomId, '2393554');
  assert.equal(events[1].viewer_uid, null);
  const counters = adapter.snapshot().counters;
  assert.equal(counters.chats, 2);
  assert.equal(counters.withStableId, 1);
  assert.equal(counters.withMessageId, 2);
  assert.equal(counters.emoteMessages, 1);
  await adapter.stop();
});

test('a publication from another chatroom is ignored, not mixed in', async () => {
  const {adapter, ws, events} = await started();
  ws.deliver(publicationFrame('App\\Events\\ChatMessageEvent', kickChat({id: 'x'}), {channel: 'chatrooms.999.v2'}));
  assert.equal(events.length, 0);
  assert.equal(adapter.snapshot().counters.crossRoomIgnored, 1);
  await adapter.stop();
});

test('stop closes the socket and never reconnects afterwards', async () => {
  const {adapter, ws} = await started();
  await adapter.stop();
  assert.equal(adapter.state, 'stopped');
  assert.equal(adapter.snapshot().socket, null);
  assert.equal(ws.readyState, 3);
  const before = KickFakeWebSocket.instances.length;
  ws.drop({code: 1006});
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(KickFakeWebSocket.instances.length, before, 'no reconnect after stop');
  assert.equal(adapter.snapshot().counters.reconnectAttempts, 0);
});

test('a dropped socket reconnects with a fresh token and records the gap', async () => {
  const context = await started();
  const {adapter, ws} = context;
  const firstToken = ws.sent.find((frame) => frame?.connect)?.connect.token;
  ws.drop({code: 1006, reason: 'network'});
  await waitFor(() => adapter.state === 'connected' && KickFakeWebSocket.instances.length === 2, {label: 'reconnected'});
  const second = KickFakeWebSocket.last;
  const secondToken = second.sent.find((frame) => frame?.connect)?.connect.token;
  assert.notEqual(secondToken, firstToken);
  assert.equal(context.authCalls(), 2, 'a new guest token is requested for each connection');
  assert.equal(adapter.snapshot().counters.reconnects, 1);
  assert.ok(adapter.snapshot().lastGap >= 0);
  assert.equal(adapter.state, 'connected');
  await adapter.stop();
});

test('an expired guest token triggers an immediate reconnect, not a long backoff', async () => {
  const context = await started();
  const {adapter, ws} = context;
  ws.deliver(tokenExpiredFrame(109));
  ws.drop({code: 3000, reason: 'token expired'});
  await waitFor(() => adapter.state === 'connected' && KickFakeWebSocket.instances.length === 2, {label: 'token refresh'});
  assert.equal(context.authCalls(), 2);
  assert.equal(adapter.snapshot().counters.reconnects, 1);
  await adapter.stop();
});

test('the adapter refreshes the guest token before its TTL instead of waiting for a refusal', async () => {
  KickFakeWebSocket.reset({autoHandshake: true, ttl: 1});
  const transitions = [];
  const http = fakeKickHttp((url) => {
    if (url.includes('/api/v2/channels/')) return jsonResult(CHANNEL);
    if (url.includes('/chat/connection')) return jsonResult({data: {connections: [{provider: 'centrifugo', credentials: {url: 'wss://fake'}}]}});
    return jsonResult({data: {token: guestToken()}});
  });
  const adapter = new KickAdapter({
    slug: 'odablock',
    http,
    WebSocketImpl: KickFakeWebSocket,
    options: {baseBackoffMs: 5, connectTimeoutMs: 200, tokenRefreshLeadMs: 5000, minTokenRefreshMs: 5}
  });
  await adapter.start({onStateChange: (change) => transitions.push(change)});
  await waitFor(() => KickFakeWebSocket.instances.length === 2 && adapter.state === 'connected', {label: 'proactive refresh'});
  assert.equal(adapter.snapshot().counters.reconnects, 1);
  assert.ok(transitions.some((change) => change.detail?.reason === 'token_refresh'), 'reconnect reason is token_refresh');
  assert.equal(adapter.snapshot().counters.connections, 2);
  await adapter.stop();
});

test('repeated connection failures end in a failed state instead of retrying forever', async () => {
  const context = await started();
  const {adapter, ws, ends} = context;
  context.setFailConnection(true);
  ws.drop({code: 1006});
  await waitFor(() => adapter.state === 'failed', {label: 'failed state', timeout: 3000});
  assert.equal(ends.at(-1)?.reason, 'failed');
  const attempts = adapter.snapshot().counters.reconnectAttempts;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(adapter.snapshot().counters.reconnectAttempts, attempts, 'no further retries after failure');
  await adapter.stop();
});

test('two adapters keep their own sockets, channels and events', async () => {
  KickFakeWebSocket.reset({autoHandshake: true});
  const makeHttp = (channel) => fakeKickHttp((url) => {
    if (url.includes('/api/v2/channels/')) return jsonResult(channel);
    if (url.includes('/chat/connection')) return jsonResult({data: {connections: [{provider: 'centrifugo', credentials: {url: 'wss://fake'}}]}});
    return jsonResult({data: {token: guestToken()}});
  });
  const a = new KickAdapter({
    slug: 'odablock',
    http: makeHttp(CHANNEL),
    WebSocketImpl: KickFakeWebSocket,
    options: {baseBackoffMs: 5, connectTimeoutMs: 200}
  });
  const b = new KickAdapter({
    slug: 'gmhikaru',
    http: makeHttp({...CHANNEL, id: 1770127, slug: 'gmhikaru', chatroom: {id: 1762730}}),
    WebSocketImpl: KickFakeWebSocket,
    options: {baseBackoffMs: 5, connectTimeoutMs: 200}
  });
  const eventsA = [];
  const eventsB = [];
  await a.start({onEvent: (draft) => eventsA.push(draft)});
  await b.start({onEvent: (draft) => eventsB.push(draft)});
  const wsA = KickFakeWebSocket.instances[0];
  const wsB = KickFakeWebSocket.instances[1];
  assert.deepEqual(wsA.subscriptions.sort(), ['channel.2401072', 'channel_2401072', 'chatroom_2393554', 'chatrooms.2393554', 'chatrooms.2393554.v2']);
  assert.deepEqual(wsB.subscriptions.sort(), ['channel.1770127', 'channel_1770127', 'chatroom_1762730', 'chatrooms.1762730', 'chatrooms.1762730.v2']);
  wsA.deliver(publicationFrame('App\\Events\\ChatMessageEvent', kickChat({id: 'a-1', content: 'from A'})));
  wsB.deliver(publicationFrame('App\\Events\\ChatMessageEvent', kickChat({id: 'b-1', content: 'from B'}), {channel: 'chatrooms.1762730.v2'}));
  assert.deepEqual(eventsA.map((draft) => draft.content), ['from A']);
  assert.deepEqual(eventsB.map((draft) => draft.content), ['from B']);
  assert.equal(a.channel.chatroomId, '2393554');
  assert.equal(b.channel.chatroomId, '1762730');
  await a.stop();
  await b.stop();
});
