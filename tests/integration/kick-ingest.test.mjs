import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../../src/storage/database/connection.mjs';
import {migrate} from '../../src/storage/database/migrations/index.mjs';
import {SessionManager} from '../../src/platforms/shared/session-manager.mjs';
import {KickAdapter} from '../../src/platforms/kick/adapter.mjs';
import {getSession} from '../../src/storage/repositories/sessions.mjs';
import {listSessionViewers} from '../../src/storage/repositories/viewers.mjs';
import {KickFakeWebSocket, fakeKickHttp, jsonResult, waitFor} from '../helpers/kick-ws-fake.mjs';
import {guestToken, kickChat, publicationFrame} from '../helpers/kick-frames.mjs';

/**
 * Kick adapter -> EventIngest -> SQLite, with the real SessionManager.
 *
 * The socket and HTTP transport are fakes: no Kick request is made. Payload
 * shapes come from real publications, so this covers identity, dedupe, session
 * counters and multi-room isolation without pretending to be a live capture.
 */

const T0 = 1700000000000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function channelJson({id = 2401072, slug = 'odablock', chatroom = 2393554} = {}) {
  return {
    id,
    user_id: 676,
    slug,
    is_banned: false,
    chatroom: {id: chatroom},
    livestream: {id: 138000001, session_title: 'Live now', start_time: '2026-11-16T12:00:00Z', viewer_count: 8771}
  };
}

function harness() {
  KickFakeWebSocket.reset({autoHandshake: true});
  const db = openDatabase({memory: true});
  migrate(db, {now: T0});
  const sessionManager = new SessionManager({db, settings: {get: () => ({storageMode: 'compact'})}, now: () => T0});
  return {db, sessionManager};
}

function makeAdapter(channel) {
  const http = fakeKickHttp((url) => {
    if (url.includes('/api/v2/channels/')) return jsonResult(channel);
    if (url.includes('/chat/connection')) return jsonResult({data: {connections: [{provider: 'centrifugo', credentials: {url: 'wss://fake'}}]}});
    return jsonResult({data: {token: guestToken()}});
  });
  return new KickAdapter({
    slug: channel.slug,
    http,
    WebSocketImpl: KickFakeWebSocket,
    options: {baseBackoffMs: 5, maxBackoffMs: 10, connectTimeoutMs: 200}
  });
}

async function startRoom(sessionManager, channel) {
  const adapter = makeAdapter(channel);
  const result = await sessionManager.startPlatform({
    platform: 'kick',
    platformRoomId: String(channel.id),
    roomTitle: 'Live now',
    broadcasterName: channel.slug,
    broadcasterUid: String(channel.id),
    createAdapter: () => adapter
  });
  assert.equal(result.started, true);
  return {adapter, session: result.session, ws: KickFakeWebSocket.last};
}

function deliver(ws, {id, userId = 3119475, username = 'Alice', content = 'hello', chatroom = 2393554, createdAt = '2026-11-16T17:23:46+00:00'}) {
  ws.deliver(publicationFrame('App\\Events\\ChatMessageEvent', kickChat({
    id,
    chatroom_id: chatroom,
    content,
    created_at: createdAt,
    sender: {id: userId, username, slug: username.toLowerCase(), identity: {badges: [{type: 'subscriber', text: 'Subscriber'}]}}
  }), {channel: `chatrooms.${chatroom}.v2`}));
}

test('a Kick room records chat, stable identity, emotes and dedupes redelivery', async () => {
  const {db, sessionManager} = harness();
  try {
    const {session, ws} = await startRoom(sessionManager, channelJson());
    const sessionId = session.id;
    assert.equal(session.platform, 'kick');
    assert.equal(session.platform_room_id, '2401072');
    assert.equal(session.broadcaster_id, 'kick:2401072');

    deliver(ws, {id: 'm-1', content: '你好 [emote:5216699:gregYikes]'});
    deliver(ws, {id: 'm-2', userId: 3119475, content: 'second from Alice'});
    deliver(ws, {id: 'm-3', userId: 7777, username: 'Bob', content: 'hello from Bob'});
    await waitFor(() => db.prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?').get(sessionId).c === 3);

    // Redelivery of an already stored message id must not add a row or a count.
    deliver(ws, {id: 'm-1', content: '你好 [emote:5216699:gregYikes]'});
    await sleep(50);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?').get(sessionId).c, 3);

    const rows = db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY rowid').all(sessionId);
    assert.equal(rows[0].platform, 'kick');
    assert.equal(rows[0].event_type, 'chat');
    assert.equal(rows[0].viewer_uid, '3119475');
    assert.equal(rows[0].display_name, 'Alice');
    assert.equal(rows[0].external_id, 'm-1');
    assert.equal(rows[0].content, '你好 [emote:5216699:gregYikes]');
    assert.equal(rows[0].source_quality, 'verified');
    assert.deepEqual(JSON.parse(rows[0].emotes), [{id: '5216699', name: 'gregYikes', source: 'kick'}]);
    assert.equal(rows[0].occurred_at, Date.parse('2026-11-16T17:23:46+00:00'));

    const viewers = listSessionViewers(db, sessionId);
    assert.equal(viewers.length, 2, 'two stable ids, not two nicknames');
    assert.deepEqual(viewers.map((viewer) => viewer.platform_uid).sort(), ['3119475', '7777']);

    const stored = getSession(db, sessionId);
    assert.equal(stored.message_count, 3);
    assert.equal(stored.unique_viewer_count, 2);
    await sessionManager.shutdown();
  } finally {
    await sessionManager.shutdown().catch(() => {});
  }
});

test('the same nickname with different stable ids is never merged', async () => {
  const {db, sessionManager} = harness();
  try {
    const {session, ws} = await startRoom(sessionManager, channelJson());
    deliver(ws, {id: 'n-1', userId: 1001, username: 'Twin', content: 'from one'});
    deliver(ws, {id: 'n-2', userId: 1002, username: 'Twin', content: 'from two'});
    await waitFor(() => db.prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?').get(session.id).c === 2);
    const viewers = listSessionViewers(db, session.id);
    assert.equal(viewers.length, 2);
    assert.deepEqual(viewers.map((viewer) => viewer.platform_uid).sort(), ['1001', '1002']);
    await sessionManager.shutdown();
  } finally {
    await sessionManager.shutdown().catch(() => {});
  }
});

test('a message without a sender id is stored without creating a viewer profile', async () => {
  const {db, sessionManager} = harness();
  try {
    const {session, ws} = await startRoom(sessionManager, channelJson());
    deliver(ws, {id: 'anon-1', userId: null, username: 'Anonymous', content: 'no id here'});
    await waitFor(() => db.prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?').get(session.id).c === 1);
    const row = db.prepare('SELECT * FROM events WHERE session_id = ?').get(session.id);
    assert.equal(row.viewer_uid, null);
    assert.equal(row.viewer_id, null);
    assert.equal(row.source_quality, 'unknown');
    assert.equal(row.display_name, 'Anonymous');
    assert.equal(listSessionViewers(db, session.id).length, 0, 'no profile for an unidentified viewer');
    await sessionManager.shutdown();
  } finally {
    await sessionManager.shutdown().catch(() => {});
  }
});

test('two Kick rooms record independently and never share events or viewers', async () => {
  const {db, sessionManager} = harness();
  try {
    const first = await startRoom(sessionManager, channelJson());
    const second = await startRoom(sessionManager, channelJson({id: 1770127, slug: 'gmhikaru', chatroom: 1762730}));
    assert.notEqual(first.session.id, second.session.id);
    assert.equal(first.ws.url, second.ws.url);
    assert.notEqual(first.ws, second.ws);

    deliver(first.ws, {id: 'a-1', userId: 4242, content: 'room A', chatroom: 2393554});
    deliver(second.ws, {id: 'b-1', userId: 4242, content: 'room B', chatroom: 1762730});
    deliver(second.ws, {id: 'b-2', userId: 5555, username: 'Carol', content: 'room B again', chatroom: 1762730});
    await waitFor(() => db.prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?').get(first.session.id).c === 1);
    await waitFor(() => db.prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?').get(second.session.id).c === 2);

    const firstContents = db.prepare('SELECT content FROM events WHERE session_id = ?').all(first.session.id).map((row) => row.content);
    const secondContents = db.prepare('SELECT content FROM events WHERE session_id = ?').all(second.session.id).map((row) => row.content);
    assert.deepEqual(firstContents, ['room A']);
    assert.deepEqual(secondContents, ['room B', 'room B again']);

    // Same person in both rooms keeps one platform identity but two sessions.
    assert.equal(getSession(db, first.session.id).platform_room_id, '2401072');
    assert.equal(getSession(db, second.session.id).platform_room_id, '1770127');
    assert.equal(listSessionViewers(db, first.session.id)[0].platform_uid, '4242');
    assert.equal(listSessionViewers(db, second.session.id).length, 2);

    await sessionManager.shutdown();
  } finally {
    await sessionManager.shutdown().catch(() => {});
  }
});

test('stopping one room leaves the other running and rejects late messages', async () => {
  const {db, sessionManager} = harness();
  try {
    const first = await startRoom(sessionManager, channelJson());
    const second = await startRoom(sessionManager, channelJson({id: 1770127, slug: 'gmhikaru', chatroom: 1762730}));
    deliver(first.ws, {id: 's-1', content: 'before stop'});
    await waitFor(() => db.prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?').get(first.session.id).c === 1);

    const stopped = await sessionManager.stopSession(first.session.id);
    assert.equal(stopped.stopped, true);
    assert.equal(first.adapter.state, 'stopped');
    assert.equal(first.ws.readyState, 3);

    // A queued callback after stop must not reopen or append to the session.
    deliver(first.ws, {id: 's-2', content: 'after stop'});
    deliver(second.ws, {id: 's-3', content: 'still running', chatroom: 1762730});
    await waitFor(() => db.prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?').get(second.session.id).c === 1);
    await sleep(50);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?').get(first.session.id).c, 1);
    assert.deepEqual(db.prepare('SELECT content FROM events WHERE session_id = ?').all(first.session.id).map((row) => row.content), ['before stop']);

    const live = sessionManager.listRecordings();
    assert.equal(live.length, 1);
    assert.equal(live[0].sessionId, second.session.id);
    await sessionManager.shutdown();
  } finally {
    await sessionManager.shutdown().catch(() => {});
  }
});
