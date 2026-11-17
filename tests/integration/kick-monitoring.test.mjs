import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../../src/storage/database/connection.mjs';
import {migrate} from '../../src/storage/database/migrations/index.mjs';
import {SessionManager} from '../../src/platforms/shared/session-manager.mjs';
import {KickService} from '../../src/platforms/kick/service.mjs';
import {MonitoringManager} from '../../src/monitoring/manager.mjs';
import {liveCycleKey} from '../../src/monitoring/model.mjs';
import {getSession} from '../../src/storage/repositories/sessions.mjs';
import {listMonitorTargets} from '../../src/storage/repositories/monitor-targets.mjs';
import {KickFakeWebSocket, fakeKickHttp, jsonResult} from '../helpers/kick-ws-fake.mjs';
import {guestToken, kickChat, publicationFrame} from '../helpers/kick-frames.mjs';

/**
 * Kick monitoring through the shared scheduler: offline channel -> waiting,
 * live detected -> session, stream ends -> session closed and target returns to
 * waiting, manual stop suppresses the same broadcast, next broadcast records
 * again, restart keeps the target. Fake HTTP/WebSocket, real DB and manager.
 */

const T0 = 1700000000000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, {timeout = 5000, interval = 10, label = 'condition'} = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`waitFor timeout: ${label}`);
    await sleep(interval);
  }
}

function channel({id = 2401072, slug = 'alpha', chatroom = 2393554, live = false, liveId = 900001} = {}) {
  return {
    id,
    user_id: id + 1,
    slug,
    is_banned: false,
    followers_count: 1000,
    chatroom: {id: chatroom},
    livestream: live
      ? {id: liveId, session_title: `${slug} live`, start_time: '2026-11-16T12:00:00Z', viewer_count: 42}
      : null
  };
}

function harness(initial) {
  KickFakeWebSocket.reset({autoHandshake: true});
  const db = openDatabase({memory: true});
  migrate(db, {now: T0});
  const state = {channels: new Map(Object.entries(initial)), failNetwork: false};
  const http = fakeKickHttp((url) => {
    if (state.failNetwork) {
      const error = new Error('network down');
      error.code = 'KICK_NETWORK';
      return error;
    }
    const lookup = /\/api\/v2\/channels\/([^/?]+)/.exec(url);
    if (lookup) {
      const found = state.channels.get(decodeURIComponent(lookup[1]));
      return found ? jsonResult(found) : jsonResult(null, 404);
    }
    if (url.includes('/chat/connection')) {
      return jsonResult({data: {connections: [{provider: 'centrifugo', credentials: {url: 'wss://fake'}}]}});
    }
    if (url.includes('/realtime/auth/connection')) return jsonResult({data: {token: guestToken()}});
    return jsonResult({}, 404);
  });
  const sessionManager = new SessionManager({db, settings: {get: () => ({storageMode: 'compact'})}, now: () => T0});
  const kick = new KickService({
    sessionManager,
    db,
    http,
    WebSocketImpl: KickFakeWebSocket,
    now: () => T0,
    adapterOptions: {statusIntervalMs: 20, statusOfflineConfirmations: 2, baseBackoffMs: 5, maxBackoffMs: 10, connectTimeoutMs: 200}
  });
  const manager = new MonitoringManager({
    db,
    sessionManager,
    kick,
    logger: null,
    now: () => T0,
    random: () => 0.5
  });
  return {db, sessionManager, kick, manager, state};
}

async function dueTick(manager, db, targetId) {
  db.prepare('UPDATE monitor_targets SET next_check_at = 0 WHERE id = ?').run(targetId);
  await manager.tick();
}

test('an offline Kick channel can be monitored and never creates an empty session', async () => {
  const {db, sessionManager, manager} = harness({alpha: channel({live: false})});
  try {
    const target = await manager.createTarget({platform: 'kick', input: 'https://kick.com/alpha'});
    assert.equal(target.platform, 'kick');
    assert.equal(target.targetKey, '2401072');
    assert.equal(target.state, 'waiting');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c, 0);

    await dueTick(manager, db, target.id);
    const after = manager.getTarget(target.id);
    assert.equal(after.state, 'waiting');
    assert.equal(after.activeSessionId, null);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c, 0);
  } finally {
    await sessionManager.shutdown().catch(() => {});
  }
});

test('a live Kick channel is detected, recorded once and receives real-shaped chat', async () => {
  const {db, sessionManager, manager, state} = harness({alpha: channel({live: true})});
  try {
    const target = await manager.createTarget({platform: 'kick', input: 'https://kick.com/alpha'});
    await dueTick(manager, db, target.id);

    const recording = manager.getTarget(target.id);
    assert.equal(recording.state, 'recording');
    assert.ok(recording.activeSessionId);
    const session = getSession(db, recording.activeSessionId);
    assert.equal(session.platform, 'kick');
    assert.equal(session.platform_room_id, '2401072');
    assert.equal(session.broadcaster_id, 'kick:2401073');
    assert.equal(session.status, 'live');

    const ws = KickFakeWebSocket.last;
    ws.deliver(publicationFrame('App\\Events\\ChatMessageEvent', kickChat({id: 'm1', content: 'hello monitoring'})));
    await waitFor(() => db.prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?').get(session.id).c === 1);
    const row = db.prepare('SELECT viewer_id, external_id, content FROM events WHERE session_id = ?').get(session.id);
    assert.equal(row.viewer_id, 'kick:3119475');
    assert.equal(row.external_id, 'm1');
    assert.equal(row.content, 'hello monitoring');

    // A second tick while recording must not create another session.
    await dueTick(manager, db, target.id);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c, 1);
    assert.equal(manager.getTarget(target.id).state, 'recording');

    // The stream ends: two public status checks end the session by themselves.
    state.channels.set('alpha', channel({live: false}));
    await waitFor(() => getSession(db, session.id).status === 'ended', {label: 'adapter ended session'});
    await dueTick(manager, db, target.id);
    assert.equal(manager.getTarget(target.id).state, 'waiting');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c, 1, 'no empty session is created');
  } finally {
    await sessionManager.shutdown().catch(() => {});
  }
});

test('a manual stop suppresses the same broadcast; the next broadcast records again', async () => {
  const {db, sessionManager, manager, state} = harness({alpha: channel({live: true, liveId: 900001})});
  try {
    const target = await manager.createTarget({platform: 'kick', input: 'https://kick.com/alpha'});
    await dueTick(manager, db, target.id);
    const sessionId = manager.getTarget(target.id).activeSessionId;
    assert.ok(sessionId);

    manager.noteManualStop(sessionId);
    await sessionManager.stopSession(sessionId, {reason: 'user'});
    await dueTick(manager, db, target.id);
    assert.equal(manager.getTarget(target.id).state, 'live_stopped', 'same live cycle stays stopped');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c, 1);

    // A later check confirms the stream ended; the target waits for a new one.
    state.channels.set('alpha', channel({live: false, liveId: 900001}));
    await dueTick(manager, db, target.id);
    assert.equal(manager.getTarget(target.id).state, 'waiting');

    state.channels.set('alpha', channel({live: true, liveId: 900002}));
    await dueTick(manager, db, target.id);
    const again = manager.getTarget(target.id);
    assert.equal(again.state, 'recording');
    assert.notEqual(again.activeSessionId, sessionId);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c, 2);
  } finally {
    await sessionManager.shutdown().catch(() => {});
  }
});

test('two Kick channels are monitored independently', async () => {
  const {db, sessionManager, manager, state} = harness({
    alpha: channel({live: true, id: 2401072, slug: 'alpha', chatroom: 2393554}),
    beta: channel({live: false, id: 1770127, slug: 'beta', chatroom: 1762730})
  });
  try {
    const a = await manager.createTarget({platform: 'kick', input: 'https://kick.com/alpha'});
    const b = await manager.createTarget({platform: 'kick', input: 'https://kick.com/beta'});
    await dueTick(manager, db, a.id);
    await dueTick(manager, db, b.id);
    assert.equal(manager.getTarget(a.id).state, 'recording');
    assert.equal(manager.getTarget(b.id).state, 'waiting');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c, 1);

    state.channels.set('beta', channel({live: true, id: 1770127, slug: 'beta', chatroom: 1762730}));
    await dueTick(manager, db, b.id);
    assert.equal(manager.getTarget(b.id).state, 'recording');
    assert.notEqual(manager.getTarget(a.id).activeSessionId, manager.getTarget(b.id).activeSessionId);
    const rooms = db.prepare('SELECT platform_room_id FROM sessions ORDER BY started_at').all().map((row) => row.platform_room_id).sort();
    assert.deepEqual(rooms, ['1770127', '2401072']);
  } finally {
    await sessionManager.shutdown().catch(() => {});
  }
});

test('restart recovery keeps enabled targets and does not duplicate the active session', async () => {
  const first = harness({alpha: channel({live: true})});
  try {
    const target = await first.manager.createTarget({platform: 'kick', input: 'https://kick.com/alpha'});
    await dueTick(first.manager, first.db, target.id);
    const sessionId = first.manager.getTarget(target.id).activeSessionId;
    assert.ok(sessionId);

    // A second manager over the same database is what a restart builds.
    const second = new MonitoringManager({
      db: first.db,
      sessionManager: first.sessionManager,
      kick: first.kick,
      now: () => T0,
      random: () => 0.5
    });
    second.recover();
    const restored = second.getTarget(target.id);
    assert.equal(restored.enabled, true);
    assert.equal(restored.state, 'recording');
    assert.equal(restored.activeSessionId, sessionId);
    assert.equal(listMonitorTargets(first.db).length, 1);
    assert.equal(first.db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c, 1);
  } finally {
    await first.sessionManager.shutdown().catch(() => {});
  }
});

test('an unknown Kick channel is rejected; a network failure keeps the target retrying', async () => {
  const {db, sessionManager, manager, state} = harness({alpha: channel({live: false})});
  try {
    await assert.rejects(
      () => manager.createTarget({platform: 'kick', input: 'https://kick.com/nobody'}),
      (error) => error.code === 'MONITOR_NOT_FOUND'
    );
    assert.equal(listMonitorTargets(db).length, 0);

    const target = await manager.createTarget({platform: 'kick', input: 'https://kick.com/alpha'});
    state.failNetwork = true;
    await dueTick(manager, db, target.id);
    const failed = manager.getTarget(target.id);
    assert.equal(failed.state, 'waiting');
    assert.equal(failed.consecutiveFailures, 1);
    assert.equal(failed.error?.code, 'MONITOR_NETWORK');
    assert.ok(failed.nextCheckAt > T0);
    assert.equal(listMonitorTargets(db).length, 1, 'a network failure never deletes the target');
  } finally {
    await sessionManager.shutdown().catch(() => {});
  }
});

test('the monitor policy and live-cycle key cover Kick', () => {
  const {sessionManager, manager} = harness({alpha: channel({live: true})});
  try {
    assert.equal(manager.status().policy.kick.checkIntervalMs, 90000);
    assert.equal(liveCycleKey('kick', {target_key: '2401072'}, {status: 'live', channelId: '2401072', liveId: '900001'}), 'kick:2401072:900001');
    assert.equal(liveCycleKey('kick', {target_key: '2401072'}, {status: 'offline', channelId: '2401072'}), null);
  } finally {
    sessionManager.shutdown().catch(() => {});
  }
});
