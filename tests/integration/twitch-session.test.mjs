import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {openDatabase} from '../../src/storage/database/connection.mjs';
import {migrate} from '../../src/storage/database/migrations/index.mjs';
import {SessionManager} from '../../src/platforms/shared/session-manager.mjs';
import {TwitchService} from '../../src/platforms/twitch/service.mjs';
import {getSession} from '../../src/storage/repositories/sessions.mjs';
import {listSessionViewers, viewerCurrencyTotals} from '../../src/storage/repositories/viewers.mjs';
import {buildAnalysisPackage, inspectAnalysisPackage} from '../../src/ai/export/package.mjs';
import {createTempDir} from '../helpers/temp-dir.mjs';

/**
 * Twitch transport → mapper → EventIngest → SQLite → AI package.
 *
 * Uses the real SessionManager, EventIngest, repositories and analysis package
 * with a deterministic fake IRC socket. No real Twitch network is involved.
 */

const T0 = 1700000000000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeout = 5000) {
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

function channel(login, channelId, overrides = {}) {
  return {
    login,
    channelId,
    displayName: login === 'xqc' ? 'xQc' : 'Shroud',
    title: `${login} live`,
    game: 'Just Chatting',
    isLive: true,
    streamId: `stream-${login}`,
    startedAt: T0,
    viewers: 100,
    checkedAt: T0,
    ...overrides
  };
}

function roomState(roomId, login) {
  return {data: `@room-id=${roomId};slow=0 :tmi.twitch.tv ROOMSTATE #${login}`};
}

function privmsg({id, login = 'xqc', userId, name = 'Alice', text = 'hello'}) {
  return {
    data: `@display-name=${name};user-id=${userId};login=${name.toLowerCase()};id=${id};room-id=42;`
      + `tmi-sent-ts=1700000000000 :${name.toLowerCase()}!${name.toLowerCase()}@${name.toLowerCase()}.tmi.twitch.tv PRIVMSG #${login} :${text}`
  };
}

async function finishConnect(socket, roomId, login) {
  socket.emit('open', {});
  socket.emit('message', roomState(roomId, login));
}

function harness() {
  const db = openDatabase({memory: true});
  migrate(db, {now: T0});
  let clock = T0;
  const now = () => clock;
  const sessionManager = new SessionManager({db, settings: {get: () => ({storageMode: 'compact'})}, now});
  const client = {
    async getChannel(login) {
      if (login === 'xqc') return channel('xqc', '42');
      if (login === 'shroud') return channel('shroud', '99');
      const error = new Error('not found');
      error.code = 'TWITCH_CHANNEL_NOT_FOUND';
      throw error;
    }
  };
  const service = new TwitchService({
    sessionManager,
    db,
    client,
    WebSocketImpl: FakeSocket,
    now,
    adapterOptions: {
      heartbeatMs: 100000,
      watchdogMs: 100000,
      statusIntervalMs: 100000
    }
  });
  return {db, sessionManager, service, client, now, setClock: (value) => { clock = value; }};
}

test('one Twitch channel records chat, stable identity, subscription and Bits without double counting', async () => {
  FakeSocket.instances = [];
  const {db, sessionManager, service, now} = harness();
  const dir = createTempDir('twitch-session-');
  try {
    const connecting = service.connect('xqc');
    await waitFor(() => FakeSocket.instances.length === 1);
    const socket = FakeSocket.instances[0];
    await finishConnect(socket, '42', 'xqc');
    const result = await connecting;
    const sessionId = result.session.id;

    socket.emit('message', privmsg({id: 'chat-1', userId: '1001', text: 'Hello 世界 😂'}));
    socket.emit('message', privmsg({id: 'chat-1', userId: '1001', text: 'Hello 世界 😂'}));
    socket.emit('message', privmsg({id: 'cheer-1', userId: '1001', text: 'cheer500'}));
    socket.emit('message', {
      data: '@display-name=Alice;user-id=1001;login=alice;id=notice-1;room-id=42;tmi-sent-ts=1700000000000;'
        + 'msg-id=resub;msg-param-sub-plan=1000;msg-param-cumulative-months=12 :tmi.twitch.tv USERNOTICE #xqc :thanks'
    });
    // Turn the Cheer into a paid event by adding the bits tag in a dedicated line.
    socket.emit('message', {
      data: '@display-name=Alice;user-id=1001;login=alice;id=cheer-2;room-id=42;tmi-sent-ts=1700000000000;bits=500'
        + ' :alice!alice@alice.tmi.twitch.tv PRIVMSG #xqc :cheer500 great stream'
    });

    await waitFor(() => Number(getSession(db, sessionId).message_count) >= 2);
    await waitFor(() => db.prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?').get(sessionId).c >= 4);

    const rows = db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY id').all(sessionId);
    assert.equal(rows.length, 4, 'the duplicate message id was not inserted twice');
    const chat = rows.find((row) => row.external_id === 'chat-1');
    assert.equal(chat.event_type, 'chat');
    assert.equal(chat.viewer_uid, '1001');
    assert.equal(chat.viewer_id, 'twitch:1001');
    assert.equal(chat.content, 'Hello 世界 😂');

    const cheer = rows.find((row) => row.external_id === 'cheer-2');
    assert.equal(cheer.event_type, 'super_chat');
    assert.equal(cheer.amount_minor, null);
    assert.equal(cheer.currency, null);
    assert.equal(cheer.value_kind, 'unknown');
    assert.equal(cheer.gift_quantity, 500);
    assert.equal(cheer.amount_display, '500 Bits');
    assert.equal(cheer.is_paid, 1);

    const membership = rows.find((row) => row.external_id === 'notice-1');
    assert.equal(membership.event_type, 'membership');
    assert.equal(membership.gift_name, 'Subscription · Tier 1');
    assert.equal(membership.amount_minor, null);
    assert.equal(membership.is_paid, 1);

    const session = getSession(db, sessionId);
    assert.equal(session.platform, 'twitch');
    assert.equal(session.broadcaster_id, 'twitch:42');
    assert.equal(session.message_count, 3);
    assert.equal(session.payment_event_count, 2);

    const viewers = listSessionViewers(db, sessionId, {limit: 100});
    assert.equal(viewers.length, 1);
    assert.equal(viewers[0].viewer_id, 'twitch:1001');
    assert.deepEqual(viewerCurrencyTotals(db, 'twitch:1001'), [], 'no fiat amount is invented');

    const pkg = await buildAnalysisPackage({
      db,
      sessionId,
      locale: 'en',
      exportsDir: join(dir.dir, 'exports'),
      now: now()
    });
    assert.ok(pkg.absolutePath);
    const inspected = await inspectAnalysisPackage(pkg.absolutePath);
    const lines = inspected.messages.map((line) => JSON.parse(line));
    const chatLine = lines.find((line) => line.message_id === 'chat-1');
    assert.equal(chatLine.viewer_id, 'twitch:1001');
    assert.equal(chatLine.content, 'Hello 世界 😂');
    const cheerLine = lines.find((line) => line.message_id === 'cheer-2');
    assert.equal(cheerLine.type, 'super_chat');
    assert.equal(cheerLine.amount_display, '500 Bits');
    assert.equal(cheerLine.amount_minor, null);

    const stopped = await service.disconnect({sessionId});
    assert.equal(stopped.stopped, true);
    assert.equal(getSession(db, sessionId).status, 'ended');
    assert.equal(getSession(db, sessionId).end_reason, 'user');
  } finally {
    await sessionManager.shutdown().catch(() => {});
    dir.cleanup();
  }
});

test('two Twitch channels keep independent adapters, sessions and event streams', async () => {
  FakeSocket.instances = [];
  const {db, sessionManager, service} = harness();
  try {
    const firstConnecting = service.connect('xqc');
    await waitFor(() => FakeSocket.instances.length === 1);
    const firstSocket = FakeSocket.instances[0];
    await finishConnect(firstSocket, '42', 'xqc');
    const first = await firstConnecting;

    const secondConnecting = service.connect('shroud');
    await waitFor(() => FakeSocket.instances.length === 2);
    const secondSocket = FakeSocket.instances[1];
    await finishConnect(secondSocket, '99', 'shroud');
    const second = await secondConnecting;

    firstSocket.emit('message', privmsg({id: 'a-1', userId: '1001', text: 'first'}));
    secondSocket.emit('message', privmsg({
      id: 'b-1',
      login: 'shroud',
      userId: '2002',
      name: 'Bob',
      text: 'second'
    }));
    await waitFor(() => getSession(db, first.session.id).message_count === 1
      && getSession(db, second.session.id).message_count === 1);

    const firstRow = db.prepare('SELECT viewer_id FROM events WHERE session_id = ?').get(first.session.id);
    const secondRow = db.prepare('SELECT viewer_id FROM events WHERE session_id = ?').get(second.session.id);
    assert.equal(firstRow.viewer_id, 'twitch:1001');
    assert.equal(secondRow.viewer_id, 'twitch:2002');

    assert.equal((await service.disconnect({sessionId: first.session.id})).stopped, true);
    assert.equal(getSession(db, first.session.id).status, 'ended');
    assert.equal(getSession(db, second.session.id).status, 'live', 'stopping one channel keeps the other live');
    assert.equal(secondSocket.closed, false);
    await service.disconnect({sessionId: second.session.id});
  } finally {
    await sessionManager.shutdown().catch(() => {});
  }
});
