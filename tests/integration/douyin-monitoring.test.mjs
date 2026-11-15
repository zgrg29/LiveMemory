import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../../src/storage/database/connection.mjs';
import {migrate} from '../../src/storage/database/migrations/index.mjs';
import {SessionManager} from '../../src/platforms/shared/session-manager.mjs';
import {DouyinService} from '../../src/platforms/douyin/service.mjs';
import {MonitoringManager} from '../../src/monitoring/manager.mjs';
import {getSession} from '../../src/storage/repositories/sessions.mjs';
import {listMonitorTargets} from '../../src/storage/repositories/monitor-targets.mjs';

/**
 * Automatic Douyin detection: public room page -> target state machine ->
 * SessionManager -> adapter. Uses a fake page client and fake WebSocket.
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
    this.emit('close', {code: 1000});
  }
}
FakeSocket.instances = [];

function room(webRid, roomId, anchorName, status = 2) {
  return {
    webRid,
    roomId,
    status,
    isLive: status === 2,
    ended: status === 4,
    title: `${anchorName} live`,
    anchorName,
    anchorId: `anchor-${roomId}`,
    anchorSecUid: 'sec',
    userCount: '500+',
    checkedAt: T0
  };
}

function harness(rooms) {
  const db = openDatabase({memory: true});
  migrate(db, {now: T0});
  let clock = T0;
  const now = () => clock;
  const sessionManager = new SessionManager({db, settings: {get: () => ({storageMode: 'compact'})}, now});
  const client = {
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
      return {url: `wss://fake/${roomId}`, headers: {}, signature: 'sig'};
    },
    cookieHeader() {
      return '';
    }
  };
  const douyin = new DouyinService({
    sessionManager,
    db,
    client,
    WebSocketImpl: FakeSocket,
    now,
    adapterOptions: {heartbeatMs: 100000, watchdogMs: 100000, statusIntervalMs: 100000}
  });
  const manager = new MonitoringManager({
    db,
    sessionManager,
    douyin,
    logger: null,
    now,
    random: () => 0.5
  });
  return {db, sessionManager, douyin, manager, now, setClock: (value) => { clock = value; }};
}

test('a detected live Douyin room starts a normal recording session', async () => {
  FakeSocket.instances = [];
  const rooms = {'708764876300': room('708764876300', '7708163643157859082', '东方甄选官方旗舰店')};
  const {db, sessionManager, manager} = harness(rooms);
  try {
    const target = await manager.createTarget({platform: 'douyin', input: 'https://live.douyin.com/708764876300'});
    assert.equal(target.platform, 'douyin');
    assert.equal(target.targetKey, '708764876300');
    assert.equal(target.platformUid, 'anchor-7708163643157859082');

    // Force the scheduler to consider the target due now; this exercises the
    // automatic path (detector -> beginRecording), not a manual connect.
    db.prepare('UPDATE monitor_targets SET next_check_at = 0 WHERE id = ?').run(target.id);
    const ticking = manager.tick();
    await waitFor(() => FakeSocket.instances.length === 1);
    FakeSocket.instances[0].emit('open', {});
    await ticking;

    const updated = manager.getTarget(target.id);
    assert.equal(updated.state, 'recording');
    assert.ok(updated.activeSessionId);
    const session = getSession(db, updated.activeSessionId);
    assert.equal(session.platform, 'douyin');
    assert.equal(session.platform_room_id, '7708163643157859082');
    assert.equal(session.status, 'live');
    assert.equal(session.broadcaster_id, 'douyin:anchor-7708163643157859082');

    db.prepare('UPDATE monitor_targets SET next_check_at = 0 WHERE id = ?').run(target.id);
    await manager.tick();
    assert.equal(manager.getTarget(target.id).state, 'recording', 'a recording target is not re-checked');

    await sessionManager.shutdown();
    assert.equal(getSession(db, session.id).status, 'interrupted');
  } finally {
    await sessionManager.shutdown().catch(() => {});
  }
});

test('an offline room stays waiting and never creates a session', async () => {
  FakeSocket.instances = [];
  const rooms = {'369324308707': room('369324308707', '7708163643157000000', 'ended room', 4)};
  const {db, sessionManager, manager} = harness(rooms);
  try {
    const target = await manager.createTarget({platform: 'douyin', input: '369324308707'});
    db.prepare('UPDATE monitor_targets SET next_check_at = 0 WHERE id = ?').run(target.id);
    await manager.tick();
    const updated = manager.getTarget(target.id);
    assert.equal(updated.state, 'waiting');
    assert.equal(updated.activeSessionId, null);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c, 0);
  } finally {
    await sessionManager.shutdown().catch(() => {});
  }
});

test('a room that cannot be found is reported as a monitor not-found error, not as offline', async () => {
  FakeSocket.instances = [];
  const {db, sessionManager, manager} = harness({});
  try {
    await assert.rejects(
      manager.createTarget({platform: 'douyin', input: '708764876300'}),
      (error) => error.code === 'MONITOR_NOT_FOUND'
    );
    assert.equal(listMonitorTargets(db).length, 0);
  } finally {
    await sessionManager.shutdown().catch(() => {});
  }
});

test('two Douyin targets get independent sessions and the second stop does not touch the first', async () => {
  FakeSocket.instances = [];
  const rooms = {
    '708764876300': room('708764876300', '7708163643157859082', 'A'),
    '369324308707': room('369324308707', '7708163643157999999', 'B')
  };
  const {db, sessionManager, manager} = harness(rooms);
  try {
    const first = await manager.createTarget({platform: 'douyin', input: '708764876300'});
    db.prepare('UPDATE monitor_targets SET next_check_at = 0').run();
    const ticking = manager.tick();
    await waitFor(() => FakeSocket.instances.length === 1);
    FakeSocket.instances[0].emit('open', {});
    await ticking;
    const firstSession = manager.getTarget(first.id).activeSessionId;

    const second = await manager.createTarget({platform: 'douyin', input: '369324308707'});
    db.prepare('UPDATE monitor_targets SET next_check_at = 0 WHERE id = ?').run(second.id);
    const ticking2 = manager.tick();
    await waitFor(() => FakeSocket.instances.length === 2);
    FakeSocket.instances[1].emit('open', {});
    await ticking2;
    const secondSession = manager.getTarget(second.id).activeSessionId;
    assert.notEqual(firstSession, secondSession);

    await manager.sessionManager.stopSession(secondSession);
    assert.equal(getSession(db, secondSession).status, 'ended');
    assert.equal(getSession(db, firstSession).status, 'live');
  } finally {
    await sessionManager.shutdown().catch(() => {});
  }
});
