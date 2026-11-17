import test from 'node:test';
import assert from 'node:assert/strict';
import {startServer} from '../../src/server/index.mjs';
import {createTempDir} from '../helpers/temp-dir.mjs';
import {KickFakeWebSocket, fakeKickHttp, jsonResult, waitFor} from '../helpers/kick-ws-fake.mjs';
import {guestToken, kickChat, publicationFrame} from '../helpers/kick-frames.mjs';

/**
 * Kick HTTP API -> KickService -> KickAdapter (fake transport) -> SQLite.
 *
 * The HTTP and WebSocket layers are fakes: no Kick request is made. Real field
 * shapes come from the G1 capture, so this covers registration, room parsing,
 * identity, dedupe, gift/gifted-subscription mapping, multi-room isolation and
 * stop semantics without pretending to be a live acceptance.
 */

const T0 = 1700000000000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function jsonRequest(url, {method = 'GET', body} = {}) {
  return fetch(url, {
    method,
    headers: body === undefined ? {} : {'content-type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

function channelJson({id, slug, chatroom, live = true}) {
  return {
    id,
    user_id: id + 1,
    slug,
    is_banned: false,
    followers_count: 12345,
    chatroom: {id: chatroom},
    livestream: live ? {id: 900001, session_title: `${slug} live`, start_time: '2026-11-16T12:00:00Z', viewer_count: 4321} : null
  };
}

const CHANNELS = {
  alpha: channelJson({id: 2401072, slug: 'alpha', chatroom: 2393554}),
  beta: channelJson({id: 1770127, slug: 'beta', chatroom: 1762730}),
  offline: channelJson({id: 3333, slug: 'offline', chatroom: 3334, live: false})
};

function fakeHttp() {
  return fakeKickHttp((url) => {
    const lookup = /\/api\/v2\/channels\/([^/?]+)/.exec(url);
    if (lookup) {
      const channel = CHANNELS[decodeURIComponent(lookup[1])];
      return channel ? jsonResult(channel) : jsonResult(null, 404);
    }
    if (url.includes('/chat/connection')) {
      return jsonResult({data: {connections: [{provider: 'centrifugo', credentials: {url: 'wss://fake'}}]}});
    }
    if (url.includes('/realtime/auth/connection')) {
      return jsonResult({data: {token: guestToken()}});
    }
    return jsonResult({}, 404);
  });
}

async function startHarness(t) {
  KickFakeWebSocket.reset({autoHandshake: true});
  const temp = createTempDir('kick-service-');
  const server = await startServer({
    auth: false,
    dataDir: temp.dir,
    port: 0,
    systemLocale: 'en',
    kickHttp: fakeHttp(),
    kickWebSocketImpl: KickFakeWebSocket,
    kickAdapterOptions: {baseBackoffMs: 5, maxBackoffMs: 10, connectTimeoutMs: 200}
  });
  t.after(async () => {
    await server.close();
    temp.cleanup();
  });
  return {server, base: server.url};
}

async function connect(base, slug) {
  const before = KickFakeWebSocket.instances.length;
  const running = jsonRequest(`${base}api/kick/connect`, {method: 'POST', body: {url: `https://kick.com/${slug}`}});
  await waitFor(() => KickFakeWebSocket.instances.length > before, {label: 'kick socket opened'});
  const response = await running;
  return {status: response.status, payload: await response.json(), ws: KickFakeWebSocket.last};
}

function kickGift({transaction = '8805437e-e571-4ce1-a30b-ca177ebd4936', senderId = 21608659, username = 'Gifter'} = {}) {
  return {
    gift_transaction_id: transaction,
    message: '',
    sender: {id: senderId, username, username_color: '#E4D88F', profile_picture: 'https://example.invalid/p.webp'},
    gift: {gift_id: 'full_send', name: 'Full Send', amount: 100, type: 'BASIC', tier: 'BASIC', character_limit: 0, pinned_time: 0},
    created_at: '2026-11-16T17:58:56.976408449Z'
  };
}

function giftedSubs({correlation = 'dHJhbnNhY3Rpb25fYnAyYW1oem0', gifter = 'Generous', recipients = ['one', 'two']} = {}) {
  return {
    chatroom_id: 2393554,
    correlation_id: correlation,
    gifted_usernames: recipients,
    gifter_username: gifter,
    gifted_total: recipients.length,
    gifter_total: 36,
    chunk_details: null
  };
}

async function events(server, sessionId) {
  return server.db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY rowid').all(sessionId);
}

test('Kick is registered and its room lookup reports live, offline, unknown and malformed inputs', async (t) => {
  const {base} = await startHarness(t);
  const bootstrap = await (await jsonRequest(`${base}api/bootstrap`)).json();
  const platforms = bootstrap.capabilities.platforms;
  assert.ok(platforms.some((entry) => entry.id === 'kick'), 'kick is advertised');
  assert.ok(platforms.filter((entry) => entry.id !== 'kick').length >= 5, 'the five existing platforms remain');
  const kick = platforms.find((entry) => entry.id === 'kick');
  assert.equal(kick.unofficial, true);
  assert.equal(kick.requiresLogin, false);
  assert.equal(kick.requiresApiKey, false);

  const status = await (await jsonRequest(`${base}api/kick/status`)).json();
  assert.equal(status.available, true);
  assert.equal(status.transport.requiresLogin, false);

  const live = await jsonRequest(`${base}api/kick/room`, {method: 'POST', body: {url: 'https://www.kick.com/alpha'}});
  assert.equal(live.status, 200);
  const liveRoom = (await live.json()).room;
  assert.equal(liveRoom.channelId, '2401072');
  assert.equal(liveRoom.chatroomId, '2393554');
  assert.equal(liveRoom.isLive, true);
  assert.equal(liveRoom.recordable, true);

  const offline = await jsonRequest(`${base}api/kick/room`, {method: 'POST', body: {url: 'kick.com/offline'}});
  assert.equal(offline.status, 200);
  assert.equal((await offline.json()).room.recordable, false);

  const unknown = await jsonRequest(`${base}api/kick/room`, {method: 'POST', body: {url: 'https://kick.com/nobody'}});
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.messageKey, 'errors.kickRoomNotFound');

  const invalid = await jsonRequest(`${base}api/kick/room`, {method: 'POST', body: {url: 'https://kick.com/video/abc'}});
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.messageKey, 'errors.kickLinkInvalid');

  const otherPlatform = await jsonRequest(`${base}api/kick/room`, {method: 'POST', body: {url: 'https://www.tiktok.com/@someone/live'}});
  assert.equal(otherPlatform.status, 400, 'a TikTok URL is never parsed as a Kick room');
});

test('starting an offline Kick room is refused before any socket is opened', async (t) => {
  const {base} = await startHarness(t);
  const before = KickFakeWebSocket.instances.length;
  const response = await jsonRequest(`${base}api/kick/connect`, {method: 'POST', body: {url: 'kick.com/offline'}});
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.messageKey, 'errors.kickRoomOffline');
  assert.equal(KickFakeWebSocket.instances.length, before);
});

test('chat, KICKs and gifted subscriptions are stored with stable identity and no invented money', async (t) => {
  const {base, server} = await startHarness(t);
  const started = await connect(base, 'alpha');
  assert.equal(started.status, 201, JSON.stringify(started.payload));
  const sessionId = started.payload.session.id;
  assert.equal(started.payload.session.platform, 'kick');
  assert.equal(started.payload.session.platformRoomId, '2401072');
  assert.equal(started.payload.connection.category, 'waiting_events');

  const ws = started.ws;
  ws.deliver(publicationFrame('App\\Events\\ChatMessageEvent', kickChat({
    id: 'chat-1',
    content: '你好 [emote:5216699:gregYikes]',
    sender: {id: 3119475, username: 'Alice', identity: {badges: [{type: 'subscriber', text: 'Subscriber'}]}}
  })));
  ws.deliver(publicationFrame('KicksGifted', kickGift(), {channel: 'channel_2401072'}));
  ws.deliver(publicationFrame('GiftedSubscriptionsEvent', giftedSubs(), {channel: 'chatroom_2393554'}));

  await waitFor(async () => (await events(server, sessionId)).length >= 5, {label: 'kick events stored'});
  const rows = await events(server, sessionId);
  const chat = rows.find((row) => row.event_type === 'chat');
  assert.equal(chat.viewer_uid, '3119475');
  assert.equal(chat.viewer_id, 'kick:3119475');
  assert.equal(chat.external_id, 'chat-1');
  assert.equal(chat.content, '你好 [emote:5216699:gregYikes]');
  assert.equal(chat.source_quality, 'verified');

  const gift = rows.find((row) => row.event_type === 'gift');
  assert.equal(gift.external_id, '8805437e-e571-4ce1-a30b-ca177ebd4936');
  assert.equal(gift.gift_id, 'full_send');
  assert.equal(gift.gift_name, 'Full Send');
  assert.equal(gift.viewer_uid, '21608659');
  assert.equal(gift.amount_minor, null);
  assert.equal(gift.currency, null);
  assert.equal(gift.value_kind, 'unknown');
  assert.match(gift.amount_display, /100 KICKs/);

  const memberships = rows.filter((row) => row.event_type === 'membership');
  assert.equal(memberships.length, 3, 'one gifter event plus two recipients');
  const gifter = memberships.find((row) => row.display_name === 'Generous');
  assert.equal(gifter.gift_quantity, 2);
  assert.equal(gifter.is_paid, 1);
  assert.equal(gifter.viewer_uid, null, 'no username-derived identity');
  const recipients = memberships.filter((row) => row.display_name !== 'Generous');
  assert.deepEqual(recipients.map((row) => row.display_name).sort(), ['one', 'two']);
  assert.ok(recipients.every((row) => row.is_paid === 0 && row.viewer_uid === null));

  // Re-delivery of the same platform ids must not add rows.
  ws.deliver(publicationFrame('App\\Events\\ChatMessageEvent', kickChat({id: 'chat-1', content: '你好 [emote:5216699:gregYikes]'})));
  ws.deliver(publicationFrame('KicksGifted', kickGift(), {channel: 'channel_2401072'}));
  ws.deliver(publicationFrame('GiftedSubscriptionsEvent', giftedSubs(), {channel: 'chatroom_2393554'}));
  await sleep(120);
  assert.equal((await events(server, sessionId)).length, rows.length);

  const summary = await (await jsonRequest(`${base}api/sessions/${sessionId}`)).json();
  assert.equal(summary.stats.messages, 1);
  assert.equal(summary.stats.giftEvents, 1);
});

test('two Kick rooms record independently and stopping one leaves the other alive', async (t) => {
  const {base, server} = await startHarness(t);
  const alpha = await connect(base, 'alpha');
  const beta = await connect(base, 'beta');
  assert.equal(alpha.status, 201);
  assert.equal(beta.status, 201);
  const alphaId = alpha.payload.session.id;
  const betaId = beta.payload.session.id;
  assert.notEqual(alphaId, betaId);

  // The status payload must serialise two live recordings (it once leaked the
  // adapter and failed with a circular JSON error).
  const activeStatus = await (await jsonRequest(`${base}api/kick/status`)).json();
  assert.equal(activeStatus.recordings.length, 2);
  assert.ok(activeStatus.recordings.every((row) => row.connection.state === 'connected'));
  assert.ok(activeStatus.recordings.every((row) => !('adapter' in row)));

  alpha.ws.deliver(publicationFrame('App\\Events\\ChatMessageEvent', kickChat({id: 'a-1', content: 'from alpha'})));
  beta.ws.deliver(publicationFrame('App\\Events\\ChatMessageEvent', kickChat({id: 'b-1', content: 'from beta'}), {channel: 'chatrooms.1762730.v2'}));
  await waitFor(async () => (await events(server, alphaId)).length === 1 && (await events(server, betaId)).length === 1);
  assert.deepEqual((await events(server, alphaId)).map((row) => row.content), ['from alpha']);
  assert.deepEqual((await events(server, betaId)).map((row) => row.content), ['from beta']);

  const stopped = await (await jsonRequest(`${base}api/kick/disconnect`, {method: 'POST', body: {sessionId: alphaId}})).json();
  assert.equal(stopped.stopped, true);
  alpha.ws.deliver(publicationFrame('App\\Events\\ChatMessageEvent', kickChat({id: 'a-2', content: 'after stop'})));
  beta.ws.deliver(publicationFrame('App\\Events\\ChatMessageEvent', kickChat({id: 'b-2', content: 'still live'}), {channel: 'chatrooms.1762730.v2'}));
  await waitFor(async () => (await events(server, betaId)).length === 2);
  await sleep(100);
  assert.equal((await events(server, alphaId)).length, 1, 'a stopped room never accepts a late event');

  const recordings = await (await jsonRequest(`${base}api/live/recordings`)).json();
  assert.equal(recordings.recordings.filter((row) => row.platform === 'kick').length, 1);
  const second = await (await jsonRequest(`${base}api/kick/disconnect`, {method: 'POST', body: {sessionId: betaId}})).json();
  assert.equal(second.stopped, true);

  const status = await (await jsonRequest(`${base}api/kick/status`)).json();
  assert.equal(status.recordings.length, 0);
  assert.equal(status.capture?.category, 'stopped');
});

test('retention is scoped to Kick and reports its policy', async (t) => {
  const {base} = await startHarness(t);
  const applied = await (await jsonRequest(`${base}api/kick/retention/apply`, {method: 'POST'})).json();
  assert.ok(applied.status);
  assert.equal(applied.status.policy, 'kick-raw-content');
  assert.equal(applied.status.days, 30);
});
