import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KickChatSocket,
  fetchChatConnection,
  fetchGuestToken,
  resolveChannel
} from '../../src/platforms/kick/transport.mjs';
import {KICK_ERRORS} from '../../src/platforms/kick/errors.mjs';
import {KickFakeWebSocket, fakeKickHttp, jsonResult, waitFor} from '../helpers/kick-ws-fake.mjs';
import {connectAck, guestToken, publicationFrame, subscribeAck, tokenExpiredFrame} from '../helpers/kick-frames.mjs';

const URL = 'wss://realtime.test.kick.com/connection/websocket';

async function openSocket({chatroomId = '2393554', channelId = '2401072', token = guestToken(), onPublication = () => {}, onClose = () => {}} = {}) {
  const socket = new KickChatSocket({
    url: URL,
    token,
    chatroomId,
    channelId,
    WebSocketImpl: KickFakeWebSocket,
    onPublication,
    onClose
  });
  const connecting = socket.connect();
  const ws = await waitFor(() => KickFakeWebSocket.last, {label: 'socket created'});
  await waitFor(() => ws.sent.some((frame) => frame && frame.connect), {label: 'connect frame'});
  ws.deliver(connectAck(1));
  await waitFor(() => ws.sent.some((frame) => frame && frame.subscribe), {label: 'subscribe frames'});
  ws.deliver(subscribeAck(3));
  ws.deliver(subscribeAck(2));
  await connecting;
  return {socket, ws};
}

test('connects with the anonymous token and subscribes to the chatroom topic', async () => {
  KickFakeWebSocket.reset();
  const token = guestToken();
  const {socket, ws} = await openSocket({token});
  assert.equal(ws.url, URL);
  assert.deepEqual(ws.sent[0], {id: 1, connect: {token, name: 'js', version: '5.0.0'}});
  assert.deepEqual(ws.subscriptions.sort(), [
    'channel.2401072',
    'channel_2401072',
    'chatroom_2393554',
    'chatrooms.2393554',
    'chatrooms.2393554.v2'
  ]);
  const snapshot = socket.snapshot();
  assert.equal(snapshot.frames >= 2, true);
  assert.equal(snapshot.connectedInfo.ttl, 2700);
});

test('answers the server ping with an empty object and forwards publications', async () => {
  KickFakeWebSocket.reset();
  const received = [];
  const {ws} = await openSocket({onPublication: (publication) => received.push(publication)});
  ws.ping();
  await waitFor(() => ws.sent.some((frame) => frame && Object.keys(frame).length === 0), {label: 'pong'});
  ws.deliver(publicationFrame('App\\Events\\ChatMessageEvent', {id: 'm1', content: 'hi', sender: {id: 1, username: 'A'}}));
  assert.equal(received.length, 1);
  assert.equal(received[0].event, 'App\\Events\\ChatMessageEvent');
  assert.equal(received[0].data.content, 'hi');
});

test('handles two frames batched into one WebSocket message', async () => {
  KickFakeWebSocket.reset();
  const received = [];
  const {ws} = await openSocket({onPublication: (publication) => received.push(publication)});
  ws.deliverBatch([
    publicationFrame('App\\Events\\ChatMessageEvent', {id: 'm1', content: 'one', sender: {id: 1, username: 'A'}}),
    publicationFrame('App\\Events\\ChatMessageEvent', {id: 'm2', content: 'two', sender: {id: 2, username: 'B'}})
  ]);
  assert.deepEqual(received.map((entry) => entry.data.id), ['m1', 'm2']);
});

test('a dropped socket reports one close, not several', async () => {
  KickFakeWebSocket.reset();
  const closes = [];
  const {ws} = await openSocket({onClose: (info) => closes.push(info)});
  ws.drop({code: 1006, reason: ''});
  ws.drop({code: 1006, reason: ''});
  assert.equal(closes.length, 1);
  assert.equal(closes[0].code, 1006);
  assert.equal(closes[0].wasOpen, true);
});

test('a Centrifugo 109 disconnect is recognised as an expired guest token', async () => {
  KickFakeWebSocket.reset();
  const {socket, ws} = await openSocket();
  ws.deliver(tokenExpiredFrame(109));
  ws.drop({code: 3000, reason: 'token expired'});
  assert.equal(socket.tokenExpired, true);
  assert.equal(socket.snapshot().disconnect.code, 109);
});

test('a command error carrying code 109 closes the socket so a fresh token is used', async () => {
  KickFakeWebSocket.reset();
  const closes = [];
  const {ws} = await openSocket({onClose: (info) => closes.push(info)});
  ws.deliver({id: 99, error: {code: 109, message: 'token expired'}});
  await waitFor(() => closes.length === 1, {label: 'close after token error'});
  assert.equal(closes[0].disconnect.code, 109);
  assert.equal(ws.readyState, 3);
});

test('closing is idempotent and leaves the socket closed', async () => {
  KickFakeWebSocket.reset();
  const {socket, ws} = await openSocket();
  socket.close();
  socket.close();
  assert.equal(ws.readyState, 3);
  assert.equal(socket.isOpen, false);
});

test('channel lookup normalises the public JSON and keeps only needed fields', async () => {
  const http = fakeKickHttp(() => jsonResult({
    id: 2401072,
    user_id: 676,
    slug: 'odablock',
    is_banned: false,
    followers_count: 500000,
    chatroom: {id: 2393554},
    livestream: {id: 138000001, session_title: 'Live now', start_time: '2026-11-16T12:00:00Z', viewer_count: 8771}
  }));
  const channel = await resolveChannel(http, 'odablock');
  assert.equal(channel.channelId, '2401072');
  assert.equal(channel.chatroomId, '2393554');
  assert.equal(channel.isLive, true);
  assert.equal(channel.viewerCount, 8771);
  assert.equal(channel.title, 'Live now');
});

test('an unknown channel and a banned channel are different failures', async () => {
  const notFound = fakeKickHttp(() => jsonResult(null, 404));
  await assert.rejects(() => resolveChannel(notFound, 'nobody'), (error) => error.code === KICK_ERRORS.ROOM_NOT_FOUND);

  const banned = fakeKickHttp(() => jsonResult({id: 1, is_banned: true, chatroom: {id: 2}}));
  await assert.rejects(() => resolveChannel(banned, 'banned'), (error) => error.code === KICK_ERRORS.ROOM_UNAVAILABLE);
});

test('a mixed-case pasted slug is retried once in lower case', async () => {
  const http = fakeKickHttp((url) => {
    if (url.endsWith('/OdaBlock')) return jsonResult(null, 404);
    return jsonResult({id: 2401072, slug: 'odablock', chatroom: {id: 2393554}, livestream: null});
  });
  const channel = await resolveChannel(http, 'OdaBlock');
  assert.equal(channel.slug, 'odablock');
  assert.equal(http.calls.length, 2);
  assert.equal(channel.isLive, false);
});

test('realtime config requires Centrifugo and never silently falls back to Pusher', async () => {
  const centrifugo = fakeKickHttp(() => jsonResult({
    data: {connections: [{provider: 'centrifugo', credentials: {url: URL}}], mode: 'websocket'}
  }));
  const config = await fetchChatConnection(centrifugo, '2401072');
  assert.deepEqual(config, {provider: 'centrifugo', url: URL});

  const pusherOnly = fakeKickHttp(() => jsonResult({data: {connections: [{provider: 'pusher', credentials: {key: 'x'}}]}}));
  await assert.rejects(() => fetchChatConnection(pusherOnly, '2401072'), (error) => error.code === KICK_ERRORS.PROTOCOL);
});

test('the guest token is never persisted and its TTL is read from the JWT', async () => {
  const token = guestToken({ttlSec: 2700});
  const http = fakeKickHttp(() => jsonResult({data: {token}}));
  const guest = await fetchGuestToken(http);
  assert.equal(guest.token, token);
  assert.equal(guest.ttlMs, 2700000);
  assert.match(guest.subject, /^guest:/);
  const body = JSON.parse(http.calls[0].options.body);
  assert.equal(typeof body.client_id, 'string');
  assert.equal(http.calls[0].url, 'https://web.kick.com/api/v1/realtime/auth/connection');
});
