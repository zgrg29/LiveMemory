import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../../src/storage/database/connection.mjs';
import {migrate} from '../../src/storage/database/migrations/index.mjs';
import {SessionManager} from '../../src/platforms/shared/session-manager.mjs';
import {TikTokService} from '../../src/platforms/tiktok/service.mjs';
import {MonitoringManager} from '../../src/monitoring/manager.mjs';
import {getSession} from '../../src/storage/repositories/sessions.mjs';
import {listMonitorTargets} from '../../src/storage/repositories/monitor-targets.mjs';
import {FakeWebSocket} from '../helpers/tiktok-ws-fake.mjs';

/**
 * Automatic TikTok discovery: public room resolution -> target state machine ->
 * SessionManager -> anonymous local WebSocket adapter. Fake client/socket, real
 * database and manager.
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

function room(uniqueId, roomId, nickname, isLive = true) {
  return {
    uniqueId,
    roomId,
    anchorUid: `anchor-${roomId}`,
    anchorName: nickname,
    isLive,
    status: isLive ? 2 : 4,
    title: `${nickname} live`,
    startedAt: T0,
    checkedAt: T0,
    liveUrl: `https://www.tiktok.com/@${uniqueId}/live`
  };
}

function fakeTtwid() {
  return {
    get: async () => 'anon-device-cookie-value',
    snapshot: () => ({cached: true, fetchCount: 1, retryCount: 0})
  };
}

/** Run one monitor tick, completing the fake socket handshake it opens. */
async function tickWithSocket(manager) {
  FakeWebSocket.reset();
  let settled = false;
  const running = manager.tick().finally(() => {
    settled = true;
  });
  while (!settled) {
    for (const ws of FakeWebSocket.instances) {
      if (ws.readyState === 0) ws.open();
    }
    await sleep(5);
  }
  await running;
}

function harness(rooms) {
  const db = openDatabase({memory: true});
  migrate(db, {now: T0});
  let clock = T0;
  const now = () => clock;
  const sessionManager = new SessionManager({db, settings: {get: () => ({storageMode: 'compact'})}, now});
  const client = {
    async resolveRoom(input) {
      const uniqueId = typeof input === 'string' ? input : input?.uniqueId;
      const found = rooms[String(uniqueId)];
      if (!found) {
        const error = new Error('not found');
        error.code = 'TIKTOK_ROOM_NOT_FOUND';
        throw error;
      }
      return found;
    },
    async fetchRoomInfo(roomId) {
      const found = Object.values(rooms).find((item) => item.roomId === roomId);
      if (!found) throw Object.assign(new Error('not found'), {code: 'TIKTOK_ROOM_NOT_FOUND'});
      return {
        roomId: found.roomId,
        isLive: found.isLive,
        title: found.title,
        anchorUid: found.anchorUid,
        anchorName: found.anchorName,
        startedAt: found.startedAt
      };
    },
    async checkRoom(input) {
      const uniqueId = typeof input === 'string' ? input : input?.uniqueId;
      return rooms[String(uniqueId)];
    },
    async fetchGiftCatalog() {
      return new Map();
    }
  };
  const tiktok = new TikTokService({
    sessionManager,
    db,
    client,
    ttwidProvider: fakeTtwid(),
    WebSocketImpl: FakeWebSocket,
    now,
    adapterOptions: {statusIntervalMs: 100000, statusCheckDelayMs: 100000, streakFlushMs: 100000, maxBackoffMs: 30}
  });
  const manager = new MonitoringManager({
    db,
    sessionManager,
    tiktok,
    logger: null,
    now,
    random: () => 0.5
  });
  return {db, sessionManager, tiktok, manager, now, setClock: (value) => { clock = value; }};
}

test('a detected live TikTok creator starts a normal recording session', async () => {
  const {db, sessionManager, manager} = harness({creator: room('creator', '7700000000000000777', 'Creator One')});
  try {
    const target = await manager.createTarget({platform: 'tiktok', input: 'https://www.tiktok.com/@creator/live'});
    assert.equal(target.platform, 'tiktok');
    assert.equal(target.targetKey, 'creator');
    assert.equal(target.platformUid, 'anchor-7700000000000000777');

    db.prepare('UPDATE monitor_targets SET next_check_at = 0 WHERE id = ?').run(target.id);
    await tickWithSocket(manager);

    const updated = manager.getTarget(target.id);
    assert.equal(updated.state, 'recording');
    assert.ok(updated.activeSessionId);
    const session = getSession(db, updated.activeSessionId);
    assert.equal(session.platform, 'tiktok');
    assert.equal(session.platform_room_id, '7700000000000000777');
    assert.equal(session.broadcaster_id, 'tiktok:anchor-7700000000000000777');
    assert.equal(session.status, 'live');

    db.prepare('UPDATE monitor_targets SET next_check_at = 0 WHERE id = ?').run(target.id);
    await tickWithSocket(manager);
    assert.equal(manager.getTarget(target.id).state, 'recording', 'a recording target is not re-checked');

    await sessionManager.shutdown();
    assert.equal(getSession(db, session.id).status, 'interrupted');
  } finally {
    await sessionManager.shutdown().catch(() => {});
  }
});

test('an offline TikTok creator stays waiting and never creates a session', async () => {
  const {db, sessionManager, manager} = harness({creator: room('creator', '7700000000000000888', 'Offline', false)});
  try {
    const target = await manager.createTarget({platform: 'tiktok', input: '@creator'});
    db.prepare('UPDATE monitor_targets SET next_check_at = 0 WHERE id = ?').run(target.id);
    await tickWithSocket(manager);
    const updated = manager.getTarget(target.id);
    assert.equal(updated.state, 'waiting');
    assert.equal(updated.activeSessionId, null);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c, 0);
  } finally {
    await sessionManager.shutdown().catch(() => {});
  }
});

test('an unknown TikTok creator is a monitor not-found error, not offline', async () => {
  const {db, sessionManager, manager} = harness({});
  try {
    await assert.rejects(
      () => manager.createTarget({platform: 'tiktok', input: 'nobody'}),
      (error) => error.code === 'MONITOR_NOT_FOUND'
    );
    assert.equal(listMonitorTargets(db).length, 0);
  } finally {
    await sessionManager.shutdown().catch(() => {});
  }
});

test('monitoring status includes the TikTok policy', async () => {
  const {sessionManager, manager} = harness({});
  try {
    const status = manager.status();
    assert.ok(status.policy.tiktok);
    assert.equal(status.policy.tiktok.checkIntervalMs, 90000);
  } finally {
    await sessionManager.shutdown().catch(() => {});
  }
});
