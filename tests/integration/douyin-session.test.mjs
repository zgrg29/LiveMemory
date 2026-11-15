import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {openDatabase} from '../../src/storage/database/connection.mjs';
import {migrate} from '../../src/storage/database/migrations/index.mjs';
import {SessionManager} from '../../src/platforms/shared/session-manager.mjs';
import {DouyinService} from '../../src/platforms/douyin/service.mjs';
import {getSession} from '../../src/storage/repositories/sessions.mjs';
import {listSessionViewers, viewerCurrencyTotals} from '../../src/storage/repositories/viewers.mjs';
import {buildAnalysisPackage, inspectAnalysisPackage} from '../../src/ai/export/package.mjs';
import {chatMessage, giftMessage, memberBody, pushFrame} from '../helpers/douyin-frames.mjs';
import {createTempDir} from '../helpers/temp-dir.mjs';

/**
 * Douyin transport → protobuf → mapper/combo → EventIngest → SQLite → AI package.
 * The real SessionManager, EventIngest, repositories and package builder are
 * used with a deterministic fake WebSocket; no live Douyin network is involved.
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

function room(webRid, roomId, anchorName) {
  return {
    webRid,
    roomId,
    status: 2,
    isLive: true,
    ended: false,
    title: `${anchorName} live`,
    anchorName,
    anchorId: roomId === '7708163643157859082' ? '952641521715660' : '111222333444',
    anchorSecUid: 'sec',
    userCount: '500+',
    checkedAt: T0
  };
}

function fakeClient(rooms) {
  return {
    async fetchRoom(webRid) {
      const found = rooms[String(webRid)];
      if (!found) {
        const error = new Error('not found');
        error.code = 'DOUYIN_ROOM_NOT_FOUND';
        throw error;
      }
      return found;
    },
    async checkRoom(webRid) {
      return rooms[String(webRid)];
    },
    buildWebSocketUrl({roomId}) {
      return {url: `wss://fake/${roomId}`, headers: {'user-agent': 'test'}, signature: 'sig'};
    },
    cookieHeader() {
      return '';
    }
  };
}

function harness() {
  const db = openDatabase({memory: true});
  migrate(db, {now: T0});
  let clock = T0;
  const now = () => clock;
  const sessionManager = new SessionManager({db, settings: {get: () => ({storageMode: 'compact'})}, now});
  const rooms = {
    '708764876300': room('708764876300', '7708163643157859082', '东方甄选官方旗舰店'),
    '369324308707': room('369324308707', '7708163643157999999', '另一个主播')
  };
  const service = new DouyinService({
    sessionManager,
    db,
    client: fakeClient(rooms),
    WebSocketImpl: FakeSocket,
    now,
    adapterOptions: {heartbeatMs: 100000, watchdogMs: 100000, statusIntervalMs: 100000}
  });
  return {db, sessionManager, service, now, setClock: (value) => { clock = value; }};
}

async function connect(service, url) {
  const before = FakeSocket.instances.length;
  const connecting = service.connect(url);
  await waitFor(() => FakeSocket.instances.length > before);
  const socket = FakeSocket.instances[before];
  socket.emit('open', {});
  const result = await connecting;
  return {result, socket};
}

test('one Douyin room records chat, stable UID, Unicode and one final gift without double counting', async () => {
  FakeSocket.instances = [];
  const {db, sessionManager, service, now} = harness();
  const dir = createTempDir('douyin-session-');
  try {
    const {result, socket} = await connect(service, 'https://live.douyin.com/708764876300');
    const sessionId = result.session.id;

    socket.emit('message', {data: pushFrame([
      chatMessage('700000000000000001', {userId: '1001', name: '观众😀', content: '你好 世界 😂 [比心]'})
    ])});
    socket.emit('message', {data: pushFrame([
      chatMessage('700000000000000001', {userId: '1001', name: '观众😀', content: '你好 世界 😂 [比心]'})
    ])});
    socket.emit('message', {data: pushFrame([giftMessage('700000000000000011', {repeatEnd: 0, repeatCount: 1, groupId: '9'})])});
    socket.emit('message', {data: pushFrame([giftMessage('700000000000000012', {repeatEnd: 0, repeatCount: 2, groupId: '9'})])});
    socket.emit('message', {data: pushFrame([giftMessage('700000000000000013', {repeatEnd: 1, repeatCount: 3, groupId: '9'})])});

    await waitFor(() => db.prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?').get(sessionId).c === 2);
    const rows = db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY id').all(sessionId);
    assert.equal(rows.length, 2);
    const chat = rows.find((row) => row.event_type === 'chat');
    assert.equal(chat.external_id, '700000000000000001');
    assert.equal(chat.viewer_uid, '1001');
    assert.equal(chat.viewer_id, 'douyin:1001');
    assert.equal(chat.content, '你好 世界 😂 [比心]');

    const gift = rows.find((row) => row.event_type === 'gift');
    assert.equal(gift.external_id, '700000000000000013');
    assert.equal(gift.viewer_id, 'douyin:1001');
    assert.equal(gift.gift_name, 'Rose');
    assert.equal(gift.gift_quantity, 3);
    assert.equal(gift.amount_minor, null);
    assert.equal(gift.currency, null);
    assert.equal(gift.value_kind, 'unknown');
    assert.equal(gift.amount_display, '3 抖音币');
    assert.equal(gift.is_paid, 1);

    const session = getSession(db, sessionId);
    assert.equal(session.platform, 'douyin');
    assert.equal(session.broadcaster_id, 'douyin:952641521715660');
    assert.equal(session.message_count, 1);
    assert.equal(session.gift_event_count, 1);
    assert.equal(session.payment_event_count, 1);

    const viewers = listSessionViewers(db, sessionId, {limit: 100});
    assert.equal(viewers.length, 1);
    assert.equal(viewers[0].viewer_id, 'douyin:1001');
    assert.deepEqual(viewerCurrencyTotals(db, 'douyin:1001'), [], 'a display value never becomes fiat');

    const pkg = await buildAnalysisPackage({
      db,
      sessionId,
      locale: 'en',
      exportsDir: join(dir.dir, 'exports'),
      now: now()
    });
    const inspected = await inspectAnalysisPackage(pkg.absolutePath);
    const lines = inspected.messages.map((line) => JSON.parse(line));
    // messages.jsonl carries chat/super-chat only; a gift stays in the local
    // payment tables and is not smuggled in as a chat message.
    assert.equal(lines.length, 1);
    const chatLine = lines.find((line) => line.message_id === '700000000000000001');
    assert.equal(chatLine.viewer_id, 'douyin:1001');
    assert.equal(chatLine.content, '你好 世界 😂 [比心]');
    assert.equal(inspected.manifest.counts.viewers, 1);

    const stopped = await service.disconnect({sessionId});
    assert.equal(stopped.stopped, true);
    assert.equal(getSession(db, sessionId).status, 'ended');
    assert.equal(getSession(db, sessionId).end_reason, 'user');
  } finally {
    await sessionManager.shutdown().catch(() => {});
    dir.cleanup();
  }
});

test('two Douyin rooms keep independent adapters, sessions and viewer identities', async () => {
  FakeSocket.instances = [];
  const {db, sessionManager, service} = harness();
  try {
    const first = await connect(service, 'https://live.douyin.com/708764876300');
    const second = await connect(service, '369324308707');
    assert.notEqual(first.result.session.id, second.result.session.id);

    first.socket.emit('message', {data: pushFrame([chatMessage('700000000000000021', {userId: '1001', content: 'first'})])});
    second.socket.emit('message', {data: pushFrame([chatMessage('700000000000000022', {userId: '2002', content: 'second'})])});
    await waitFor(() => getSession(db, first.result.session.id).message_count === 1
      && getSession(db, second.result.session.id).message_count === 1);

    const firstRow = db.prepare('SELECT viewer_id FROM events WHERE session_id = ?').get(first.result.session.id);
    const secondRow = db.prepare('SELECT viewer_id FROM events WHERE session_id = ?').get(second.result.session.id);
    assert.equal(firstRow.viewer_id, 'douyin:1001');
    assert.equal(secondRow.viewer_id, 'douyin:2002');

    assert.equal((await service.disconnect({sessionId: first.result.session.id})).stopped, true);
    assert.equal(getSession(db, first.result.session.id).status, 'ended');
    assert.equal(getSession(db, second.result.session.id).status, 'live');
    assert.equal(second.socket.closed, false);
    await service.disconnect({sessionId: second.result.session.id});
  } finally {
    await sessionManager.shutdown().catch(() => {});
  }
});

test('member and like frames never create events or payment rows', async () => {
  FakeSocket.instances = [];
  const {db, sessionManager, service} = harness();
  try {
    const {result, socket} = await connect(service, 'https://live.douyin.com/708764876300');
    socket.emit('message', {data: pushFrame([{method: 'WebcastMemberMessage', msgId: '700000000000000031', payload: memberBody({})}])});
    await sleep(30);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?').get(result.session.id).c, 0);
    assert.equal(getSession(db, result.session.id).payment_event_count, 0);
    await service.disconnect({sessionId: result.session.id});
  } finally {
    await sessionManager.shutdown().catch(() => {});
  }
});
